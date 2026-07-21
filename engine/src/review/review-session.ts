// review-session.ts (#285, design #279 §3/§6, D7) — "review session mode": the seam between
// review/materializer.ts's private-clone checkout (#284/E3a) and the EXISTING role-session spawn
// machinery (peripheral.ts's RoleRunner, #87/#235/#236) that runs a static review AGAINST that
// materialized tree. This module owns exactly one decision: mapping an upstream materialization
// failure, or a spawn-time setup failure (e.g. a directory that vanished between materialize()
// and this call), onto design #279 §6's contract verbatim — "All setup failures ... map to
// `unavailable`" — so a future caller (#279's E4a ReviewerAdapter) never has to distinguish "the
// review produced no findings" from "the review never actually ran" by inspecting exceptions.
//
// Everything else is intentionally NOT reimplemented here — it's RoleRunner.run()'s `reviewCwd`
// facility (peripheral.ts), reused unchanged:
//   - guard containment: SAPWOOD_WORKTREE_ROOT wired to the materialized tree, guard hooks ON;
//   - tool profile: Read/Grep/Glob only, no Bash (pinned explicitly below, not just inherited);
//   - no forge proxy, no gh/git credentials in the session env;
//   - context-manifest recording: the same CLAUDE.md-family probe every role session gets,
//     simply reading from the materialized tree instead of a fresh worktree.
// This module is a thin, single-purpose composition over that facility — no new spawn logic,
// no new guard logic, no new manifest logic.
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import { ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS } from "../roles/peripheral.js";
import type { MaterializeResult } from "./materializer.js";

export interface ReviewSessionOpts {
  /** review/materializer.ts's `materialize()` result for the commit under review. A
   *  `"failure"` here — including an OID mismatch, #284/E3a's own AC — is a setup failure:
   *  `runReviewSession` NEVER attempts to spawn a session over it. */
  materialize: MaterializeResult;
  /** A short, log-friendly role identity (e.g. "engine-reviewer") — becomes part of the
   *  session's lane/sentinel name, never interpreted. */
  roleId: string;
  prompt: string;
  model: string;
  effort: string;
  fallbackModel: string;
}

/** `"ran"` carries the session's own outcome (done/failed/timeout) verbatim via the spread
 *  `RoleSessionResult` — that is a DIFFERENT axis from `"unavailable"` below: a session that ran
 *  and failed (a crash, a timeout) is still "ran" (the caller's own retry/degrade logic, if any,
 *  operates on THAT outcome); `"unavailable"` means the review never got the chance to run at
 *  all — a materialization failure, or a setup failure this module caught before/around the
 *  spawn attempt. */
export type ReviewSessionOutcome = ({ kind: "ran" } & RoleSessionResult) | { kind: "unavailable"; reason: string };

/** Run one static review session against an already-materialized tree. Never throws: every
 *  setup failure (an upstream materialization failure, a materialized directory that vanished
 *  before spawn, a guard-hook-missing refusal, a spawn error) is caught here and mapped to
 *  `{ kind: "unavailable" }` — design #279 §6's contract that a setup failure is never a
 *  silently degraded run. */
export async function runReviewSession(runner: Pick<RoleRunner, "run">, opts: ReviewSessionOpts): Promise<ReviewSessionOutcome> {
  if (opts.materialize.kind !== "materialized") {
    return { kind: "unavailable", reason: opts.materialize.reason };
  }
  try {
    const result = await runner.run({
      roleId: opts.roleId,
      prompt: opts.prompt,
      model: opts.model,
      effort: opts.effort,
      fallbackModel: opts.fallbackModel,
      reviewCwd: opts.materialize.treeDir,
      // Pinned explicitly (not just inherited defaults) — design #279 §6/D1: a review session's
      // tool profile is Read/Grep/Glob, no Bash, full stop, regardless of what the base
      // ROLE_ALLOWED_TOOLS/ROLE_DISALLOWED_TOOLS constants happen to be at any future point.
      // No `proxy` field: a review session never gets a forge proxy (RoleRunner.run() also
      // enforces this structurally when reviewCwd is set — see its own doc).
      allowedTools: ROLE_ALLOWED_TOOLS,
      disallowedTools: ROLE_DISALLOWED_TOOLS,
    });
    return { kind: "ran", ...result };
  } catch (e) {
    return { kind: "unavailable", reason: `review session setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
