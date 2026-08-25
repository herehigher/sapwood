// deploy-key-startup-check.ts (#671, redesigned by #1105): startup enforcement for the effective
// worker-credential tier — L0 disclosure only (a legal, zero-effect mode), L1 a hard FAIL-CLOSED
// gate. Batch-9 (2026-08-05) ran an entire dogfood batch at L0 because the deploy key was absent
// in the run environment, and the operator only found out by debugging a single leg's degrade
// deep inside worker.ts's own lazy, per-dispatch resolution — nothing at startup said "this whole
// batch is L0, and here's why." #1105 goes further: an operator who explicitly configured L1
// never gets a silent downgrade at all — no reconciled local anchor is a startup refusal, before
// any dispatch, naming `sapwood init` as the fix.
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
import type { LlmPingResult } from "../roles/worker.js";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";

/** Which of the four shapes the issue names produced the reported tier. */
export type DeployKeyStartupArm = "l0" | "missing" | "preflight-failed" | "active";

export interface DeployKeyStartupResult {
  tier: "L0" | "L1";
  arm: DeployKeyStartupArm;
}

/** The one method this module needs off WorkerSupervisor — narrowed so tests can inject a fake
 *  without constructing a real supervisor. */
export interface DeployKeyPreflightSupervisor {
  checkDeployKeyPreflight(): Promise<LlmPingResult | undefined>;
}

/** Run once per engine start (cli.ts, immediately after `WorkerSupervisor` construction — see
 *  this module's own doc for why), strictly BEFORE the driver loop (runDriver/runRounds) can
 *  dispatch anything. `L0` (default) is disclosure only — logs the tier and returns, never
 *  throws. `L1` fails CLOSED: no local anchor, an unreadable key file, or a failed SSH preflight
 *  each log a guidance-carrying message AND throw — the caller (runTickEngine/runRoundsEngine's
 *  own try/catch) already turns an uncaught startup error into a non-zero exit, so this is the
 *  ONE place `worker.credentialTier: L1` becomes an actual startup gate rather than a WARN. */
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

  const probe = await supervisor.checkDeployKeyPreflight();
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
