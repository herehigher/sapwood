// deploy-key-startup-check.ts (#671, #1105; see docs/security/credential-tiers.md): startup
// enforcement for the effective worker-credential tier — L0 disclosure only (a legal,
// zero-effect mode), L1 a hard FAIL-CLOSED gate. Startup, not a per-dispatch preflight buried
// inside worker.ts, is where the effective tier must be disclosed/refused: an operator who
// explicitly configures L1 must never get a silent downgrade at all — no reconciled local anchor
// is a startup refusal, before any dispatch, naming `sapwood init` as the fix.
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
// SAME settled promise rather than re-shelling to `ssh` — startup + first dispatch cost at most
// one SSH probe total.
import { readFileSync } from "node:fs";
import type { SapwoodConfig } from "../config/config.js";
import { defaultRuntimeRoot, findDeployKeyAnchor, runtimePaths } from "../config/paths.js";
import { type GhRunner, gh } from "../forge/gh.js";
import type { LlmPingResult } from "../roles/worker.js";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { parseDeployKeys } from "./init.js";

export type DeployKeyStartupArm = "l0" | "missing" | "running-tier-mismatch" | "stale" | "preflight-failed" | "active";

export interface DeployKeyStartupResult {
  tier: "L0" | "L1";
  arm: DeployKeyStartupArm;
}

/** The methods this module needs off WorkerSupervisor — narrowed so tests can inject a fake
 *  without constructing a real supervisor. */
export interface DeployKeyPreflightSupervisor {
  checkDeployKeyPreflight(anchor: { keyPath: string; keyId: number }): Promise<LlmPingResult | undefined>;
  /** Every still-running lane's own `credential_tier` provenance, plus its `session_id`/`pid`
   *  for the refusal message below — see WorkerSupervisor.listRunningCredentialTiers' own doc
   *  for what it scans and its fail-closed contract (throws on a directory-listing failure;
   *  reports, rather than excludes, an unparseable marker). */
  listRunningCredentialTiers(): Array<{ name: string; tier: unknown; session_id: unknown; pid: unknown }>;
}

/** Run once per engine start (cli.ts, immediately after `WorkerSupervisor` construction — see
 *  this module's own doc for why), strictly BEFORE the driver loop can dispatch anything: only
 *  here can an operator who explicitly set `L1` be refused before this run ever commits to a
 *  silently downgraded credential. `L0` never throws (disclosure only); every `L1` failure below
 *  logs a guidance-carrying message and throws, since the caller's own try/catch is what turns an
 *  uncaught startup error into the actual non-zero exit. */
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

  // A detached lane can be adopted by ordinary probe()/reconcile classification without ever
  // passing through resume()'s own crash-matrix guard, so it's checked once here too, at the one
  // place every restart passes through before any dispatch. A marker with no recorded tier, or a
  // scan that cannot list the running-lane state directory, counts as a mismatch: neither is
  // "confirmed L1," and "couldn't see what's running" must never read as "nothing is running."
  let runningMarkers: Array<{ name: string; tier: unknown; session_id: unknown; pid: unknown }>;
  try {
    runningMarkers = supervisor.listRunningCredentialTiers();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const message =
      `worker.credentialTier is "L1" but the running-lane state directory could not be scanned (${detail}) — ` +
      "adopting any lane still on disk from before this restart without checking its credential tier is unsafe. " +
      `Refusing to start before any dispatch — see <${DOC_LINKS.security}>'s worker credential tiers.`;
    log(`[sapwood:startup] ${message}`);
    record({ tier: "L1", arm: "running-tier-mismatch" });
    throw new Error(message);
  }
  const mismatched = runningMarkers.filter((m) => m.tier !== "L1");
  if (mismatched.length > 0) {
    // No process sweep and no liveness probe here — a recovery mechanism must not become a new
    // problem source (the operator can wait or kill directly). Ceiling: a dead process's stale
    // marker refuses until the operator deletes it. Upgrade trigger: if stale-marker refusals
    // become a recurring operator chore, add a liveness check on the recorded pid — that and
    // nothing more. The message gives the operator everything on disk per lane (session id, pid,
    // recorded tier) and exactly two remedies that don't require THIS engine to touch the other
    // process. `sapwood estop` is deliberately NOT one of the remedies: it only writes a
    // sentinel for a RUNNING engine to notice, and the engine that owned these lanes is by
    // definition not around to notice it — this refusal fires on THIS restart, after that prior
    // engine is already gone.
    const rows = mismatched
      .map((m) => {
        const session = typeof m.session_id === "string" && m.session_id ? m.session_id : "unknown";
        const pid = typeof m.pid === "number" ? String(m.pid) : "unknown";
        const tier = typeof m.tier === "string" && m.tier ? m.tier : "unknown";
        return `${m.name} (session ${session}, pid ${pid}, tier ${tier})`;
      })
      .join("; ");
    const message =
      `worker.credentialTier is "L1" but ${mismatched.length} lane(s) already running from before this restart ` +
      `do not carry a matching credential tier: ${rows}. Adopting them would keep a process this run's L1 ` +
      "startup gate never validated alive. Wait for those processes to exit, then delete the stale " +
      '.running.json if the process is already gone; or run "kill <pid>" first if you cannot wait. Refusing ' +
      `to start before any dispatch — see <${DOC_LINKS.security}>'s worker credential tiers.`;
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
  // Require an EXPLICIT `readOnly: false` — a missing/non-boolean field (an older `gh` that
  // doesn't emit it, or an unexpected response shape) must never be READ as "confirmed write
  // access". `parseDeployKeys` only ever sets `readOnly` from a genuine JSON boolean, so "not
  // === false" here catches both the confirmed-true case and every "we don't actually know" case
  // in one branch.
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
