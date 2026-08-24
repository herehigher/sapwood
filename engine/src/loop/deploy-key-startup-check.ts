// deploy-key-startup-check.ts (#671): startup VISIBILITY for the effective worker-credential
// tier (L0 full-credentialed vs L1 scoped deploy-key) — not a gate. Batch-9 (2026-08-05) ran an
// entire dogfood batch at L0 because the deploy key was absent in the run environment, and the
// operator only found out by debugging a single leg's degrade deep inside worker.ts's own lazy,
// per-dispatch preflight (resolveDeployKeyPath, worker.ts:1994) — nothing at startup said "this
// whole batch is L0, and here's why." This module says it once, up front, in both channels the
// supervision playbook's `events` polling actually watches (log + event stream).
//
// Same placement/never-blocks stance as detectManagedPermissionMode/detectRapidRestart/
// detectConsecutiveStalls (cli.ts: run once per engine start, strictly after run-started, never
// gates startup or dispatch — L0 is a legal mode, this is disclosure only). Unlike those three,
// this one needs the live WorkerSupervisor instance (to share its memoized SSH preflight), so
// cli.ts calls it immediately AFTER constructing that instance rather than alongside the others.
//
// Reuse, don't re-probe (init.ts:30-32's binding comment): "does the key work" is answered by
// EXACTLY worker.ts's probeDeployKeySsh, via WorkerSupervisor's own memoized preflight
// (checkDeployKeyPreflight) — never a second implementation. Calling it here SEEDS that same
// supervisor instance's `deployKeyProbe` memo, so the first real dispatch()/resume() later on
// this run re-awaits the SAME settled promise instead of re-shelling to `ssh` — startup + first
// dispatch cost at most one SSH probe total.
//
// Guidance wording is reused, never reinvented: the two degrade arms below log the EXACT strings
// init.ts's own deployKeyProvisioningFailedAction/deployKeyPreflightFailedAction produce for
// `sapwood init`'s own degrade arms — one guidance variant per failure shape, not a third.
import { readFileSync } from "node:fs";
import type { SapwoodConfig } from "../config/config.js";
import type { LlmPingResult } from "../roles/worker.js";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { DEPLOY_KEY_TITLE, deployKeyPreflightFailedAction, deployKeyProvisioningFailedAction } from "./init.js";

/** Which of the four shapes the issue names produced the reported tier. */
export type DeployKeyStartupArm = "unset" | "missing" | "preflight-failed" | "active";

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
 *  this module's own doc for why). Never throws — same non-throwing startup-detector stance as
 *  detectManagedPermissionMode/detectRapidRestart/detectConsecutiveStalls: a broken check here
 *  must not become a new startup-failure mode. Always returns the detected {tier, arm}, mostly
 *  for tests — no dispatch gate reads it (L0 is a legal mode; this is visibility, not a gate). */
export async function detectDeployKeyStartupTier(
  supervisor: DeployKeyPreflightSupervisor,
  cfg: {
    worker: Pick<SapwoodConfig["worker"], "deployKeyPath">;
    board: Pick<SapwoodConfig["board"], "owner" | "repo">;
  },
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = (line) => console.error(line),
  opts: { readFile?: (path: string) => string } = {},
): Promise<DeployKeyStartupResult> {
  const path = cfg.worker.deployKeyPath;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const record = (result: DeployKeyStartupResult): DeployKeyStartupResult => {
    state.appendEvent("deploy-key-tier-detected", { tier: result.tier, arm: result.arm, ...(path ? { keyPath: path } : {}) });
    return result;
  };

  if (!path) {
    log(
      "[sapwood:startup] worker credential tier: L0 (worker.deployKeyPath unset) — every worker leg dispatches " +
        'with the full credentialed env. Run "sapwood init" to provision a scoped L1 deploy key; see ' +
        `${DOC_LINKS.security}'s worker credential tiers.`,
    );
    return record({ tier: "L0", arm: "unset" });
  }

  try {
    readFile(path);
  } catch (e) {
    log(`[sapwood:startup] ${deployKeyProvisioningFailedAction(`${cfg.board.owner}/${cfg.board.repo}`, path, DEPLOY_KEY_TITLE, e)}`);
    return record({ tier: "L0", arm: "missing" });
  }

  const probe = await supervisor.checkDeployKeyPreflight();
  if (probe?.ok) {
    log(
      `[sapwood:startup] worker credential tier: L1 active (${path}) — worker legs dispatch with a scoped deploy ` +
        "key, not the full credentialed env.",
    );
    return record({ tier: "L1", arm: "active" });
  }
  log(`[sapwood:startup] ${deployKeyPreflightFailedAction(path, probe?.detail)}`);
  return record({ tier: "L0", arm: "preflight-failed" });
}
