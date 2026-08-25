// deploy-key-startup-check.ts (#671, #1105): startup enforcement for the effective
// worker-credential tier — L0 disclosure only (a legal, zero-effect mode), L1 a hard FAIL-CLOSED
// gate. Batch-9 (2026-08-05) ran an entire dogfood batch at L0 because the deploy key was absent
// in the run environment, and the operator only found out by debugging a single leg's degrade
// deep inside worker.ts's own lazy, per-dispatch resolution — nothing at startup said "this whole
// batch is L0, and here's why." An operator who explicitly configures L1 must never get a silent
// downgrade at all — no reconciled local anchor is a startup refusal, before any dispatch, naming
// `sapwood init` as the fix.
//
// Same placement/never-blocks-for-L0 stance as detectManagedPermissionMode/detectRapidRestart/
// detectConsecutiveStalls (cli.ts: run once per engine start, strictly after run-started).
// Unlike those three, this one needs the live WorkerSupervisor instance (to share its memoized
// SSH preflight), so cli.ts calls it immediately AFTER constructing that instance rather than
// alongside the others.
//
// Reuse, don't re-probe: "does the key work" is answered by EXACTLY worker.ts's
// probeDeployKeySsh, via WorkerSupervisor's own memoized preflight (checkDeployKeyPreflight),
// never a second implementation. Calling it here SEEDS that same supervisor instance's
// `deployKeyProbe` memo, so the first real dispatch()/resume() later on this run re-awaits the
// SAME settled promise instead of re-shelling to `ssh` — startup + first dispatch cost at most
// one SSH probe total.
import { readFileSync } from "node:fs";
import type { SapwoodConfig } from "../config/config.js";
import { defaultRuntimeRoot, findDeployKeyAnchor, runtimePaths } from "../config/paths.js";
import { type GhRunner, gh } from "../forge/gh.js";
import type { LlmPingResult } from "../roles/worker.js";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { parseDeployKeys } from "./init.js";

/** Which of the shapes the issue names produced the reported tier. */
export type DeployKeyStartupArm = "l0" | "missing" | "running-tier-mismatch" | "stale" | "preflight-failed" | "active";

export interface DeployKeyStartupResult {
  tier: "L0" | "L1";
  arm: DeployKeyStartupArm;
}

/** The methods this module needs off WorkerSupervisor — narrowed so tests can inject a fake
 *  without constructing a real supervisor. */
export interface DeployKeyPreflightSupervisor {
  checkDeployKeyPreflight(anchor: { keyPath: string; keyId: number }): Promise<LlmPingResult | undefined>;
  /** #1105: every still-running lane's own `credential_tier` provenance — see
   *  WorkerSupervisor.listRunningCredentialTiers' own doc for what it scans. */
  listRunningCredentialTiers(): Array<{ name: string; tier: unknown }>;
}

/** Run once per engine start (cli.ts, immediately after `WorkerSupervisor` construction — see
 *  this module's own doc for why), strictly BEFORE the driver loop (runDriver/runRounds) can
 *  dispatch anything. `L0` (default) is disclosure only — logs the tier and returns, never
 *  throws. `L1` fails CLOSED: no local anchor, an unreadable key file, a still-running lane whose
 *  own persisted tier doesn't match, a remote id that is no longer listed or has been demoted to
 *  read-only, or a failed SSH preflight each log a guidance-carrying message AND throw — the
 *  caller (runTickEngine/runRoundsEngine's own
 *  try/catch) already turns an uncaught startup error into a non-zero exit, so this is the ONE
 *  place `worker.credentialTier: L1` becomes an actual startup gate rather than a WARN. */
export async function detectDeployKeyStartupTier(
  supervisor: DeployKeyPreflightSupervisor,
  cfg: {
    worker: Pick<SapwoodConfig["worker"], "credentialTier">;
    board: Pick<SapwoodConfig["board"], "owner" | "repo">;
  },
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = (line) => console.error(line),
  opts: {
    root?: string;
    readFile?: (path: string) => string;
    findAnchor?: (root: string) => { keyPath: string; keyId: number } | undefined;
    run?: GhRunner;
  } = {},
): Promise<DeployKeyStartupResult> {
  const record = (result: DeployKeyStartupResult): DeployKeyStartupResult => {
    state.appendEvent("deploy-key-tier-detected", { tier: result.tier, arm: result.arm });
    return result;
  };

  if (cfg.worker.credentialTier !== "L1") {
    log(
      "[sapwood:startup] worker credential tier: L0 — every worker leg dispatches with the full credentialed " +
        `env; L0 never reads or probes a deploy key. Set worker.credentialTier: L1 (after "sapwood init" ` +
        `provisions a key) to switch. See <${DOC_LINKS.security}>'s worker credential tiers.`,
    );
    return record({ tier: "L0", arm: "l0" });
  }

  const root = opts.root ?? defaultRuntimeRoot();
  const findAnchor = opts.findAnchor ?? findDeployKeyAnchor;
  const anchor = findAnchor(root);
  if (anchor === undefined) {
    const message =
      `worker.credentialTier is "L1" but no local deploy-key anchor was found under ${runtimePaths(root).keysDir} ` +
      `— run "sapwood init" to provision one. Refusing to start before any dispatch — see <${DOC_LINKS.security}>'s ` +
      "worker credential tiers.";
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "missing" });
    throw new Error(message);
  }

  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    readFile(anchor.keyPath);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const message =
      `worker.credentialTier is "L1" but the deploy key recorded at ${anchor.keyPath} could not be read (${detail}) ` +
      `— run "sapwood init" to re-provision it. Refusing to start before any dispatch — see ` +
      `<${DOC_LINKS.security}>'s worker credential tiers.`;
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "missing" });
    throw new Error(message);
  }

  // #1105: a lane still on disk from BEFORE this restart may have been spawned under a
  // different tier (an operator flipped worker.credentialTier between the crash and now).
  // resume()'s own crash-matrix guard catches this for the ONE adoption path it owns, but a
  // detached lane can also be picked up by ordinary probe()/reconcile classification without
  // ever going through resume() at all — so this is checked HERE too, once, at the one place
  // every restart passes through before any dispatch, rather than threaded into every adoption
  // path individually. A marker with no `credential_tier` recorded at all (pre-#1105) counts as
  // a mismatch — it was never confirmed L1, so it must never be silently trusted as one.
  const runningMarkers = supervisor.listRunningCredentialTiers();
  const mismatched = runningMarkers.filter((m) => m.tier !== "L1");
  if (mismatched.length > 0) {
    const names = mismatched.map((m) => m.name).join(", ");
    const message =
      `worker.credentialTier is "L1" but ${mismatched.length} lane(s) already running from before this restart ` +
      `do not carry a matching credential tier (${names}) — adopting them would keep a process this run's L1 ` +
      `startup gate never validated alive. Let them finish, or run "sapwood estop" to stop them, then restart. ` +
      `Refusing to start before any dispatch — see <${DOC_LINKS.security}>'s worker credential tiers.`;
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "running-tier-mismatch" });
    throw new Error(message);
  }

  // A green SSH preflight alone doesn't prove the anchor still means what it says: the same
  // keypair authenticates whether or not GitHub still lists this id, and whether or not that id
  // has since been demoted to read-only — SSH auth succeeding says nothing about push access.
  // One authoritative remote read settles both: the sidecar id must still be listed AND not
  // read-only, or L1 refuses the same as a missing/unreadable anchor.
  const run = opts.run ?? gh;
  const repo = `${cfg.board.owner}/${cfg.board.repo}`;
  let remoteEntry: { id: number; readOnly?: boolean } | undefined;
  try {
    const listed = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title,readOnly"]));
    remoteEntry = listed.find((k) => k.id === anchor.keyId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const message =
      `worker.credentialTier is "L1" but the registered deploy keys for ${repo} could not be read (${detail}) ` +
      `— run "sapwood init" to re-check. Refusing to start before any dispatch — see ` +
      `<${DOC_LINKS.security}>'s worker credential tiers.`;
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "stale" });
    throw new Error(message);
  }
  // #1105: require an EXPLICIT `readOnly: false` — a missing/non-boolean field (an older `gh`
  // that doesn't emit it, or an unexpected response shape) must never be READ as "confirmed
  // write access". `parseDeployKeys` only ever sets `readOnly` from a genuine JSON boolean, so
  // "not === false" here catches both the confirmed-true case and every "we don't actually
  // know" case in one branch.
  if (remoteEntry === undefined || remoteEntry.readOnly !== false) {
    const reason =
      remoteEntry === undefined
        ? `id ${anchor.keyId} is no longer registered on ${repo}`
        : remoteEntry.readOnly === true
          ? `id ${anchor.keyId} on ${repo} is registered read-only (no push access)`
          : `id ${anchor.keyId} on ${repo}'s write access could not be confirmed (no readOnly field in the response)`;
    const message =
      `worker.credentialTier is "L1" but the local anchor is stale — ${reason} — run "sapwood init" to ` +
      `re-provision it. Refusing to start before any dispatch — see <${DOC_LINKS.security}>'s worker credential ` +
      "tiers.";
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "stale" });
    throw new Error(message);
  }

  const probe = await supervisor.checkDeployKeyPreflight(anchor);
  if (!probe?.ok) {
    const message =
      `worker.credentialTier is "L1" but the SSH auth preflight failed for ${anchor.keyPath}` +
      `${probe?.detail ? `: ${probe.detail}` : ""} — run "sapwood init" to re-provision it. Refusing to start ` +
      `before any dispatch — see <${DOC_LINKS.security}>'s worker credential tiers.`;
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "preflight-failed" });
    throw new Error(message);
  }

  log(
    `[sapwood:startup] worker credential tier: L1 active (${anchor.keyPath}) — worker legs dispatch with a ` +
      "scoped deploy key, not the full credentialed env.",
  );
  return record({ tier: "L1", arm: "active" });
}
