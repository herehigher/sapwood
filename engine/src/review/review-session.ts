// review-session.ts (#285, design #279 §3/§6, D7) — "review session mode": the seam between
// review/materializer.ts's private-clone checkout (#284/E3a) and the EXISTING role-session spawn
// machinery (peripheral.ts's RoleRunner, #87/#235/#236) that runs a static review AGAINST that
// materialized tree. This module owns exactly one decision: mapping an upstream materialization
// failure, or a spawn-time setup failure (e.g. a directory that vanished between materialize()
// and this call), onto design #279 §6's contract verbatim — "All setup failures ... map to
// `unavailable`" — so a future caller (#279's E4a ReviewerAdapter) never has to distinguish "the
// review produced no findings" from "the review never actually ran" by inspecting exceptions.
//
// Everything else is intentionally NOT reimplemented here — it's ALL RoleRunner.run()'s
// `reviewCwd` facility (peripheral.ts), reused unchanged, and HARDCODED there (Codex sol-high
// PR #300 review, P2/P3: the profile used to be pinned only by this wrapper passing
// allowedTools/disallowedTools explicitly — a future direct `RoleRunner.run({reviewCwd, ...})`
// caller could have overridden them. `run()` now REFUSES any caller-supplied
// allowedTools/disallowedTools/proxy together with reviewCwd, so this module doesn't pass them
// at all):
//   - tool profile: Read/Grep/Glob only, no Bash (D1) — hardcoded in RoleRunner.run();
//   - guard containment: SAPWOOD_WORKTREE_ROOT wired to the materialized tree, guard FORCED hard
//     regardless of the engine's configured guard.mode (a review session must never silently run
//     under a weaker, soft posture);
//   - MCP + settings-source closure: --strict-mcp-config + an empty --mcp-config, and an EMPTY
//     --setting-sources list ("", per peripheral.ts's review-mode spawn args, #300 P1) — no
//     project/local/user settings source loads at all, so a materialized (producer-controlled)
//     tree's own `.mcp.json` or `.claude/settings.json` never gets a chance to configure an MCP
//     server or run a settings-declared hook;
//   - no forge proxy, no gh/git credentials in the session env;
//   - context-manifest recording: the same CLAUDE.md-family probe every role session gets,
//     simply reading from the materialized tree instead of a fresh worktree.
// This module is a thin, single-purpose composition over that facility — no new spawn logic,
// no new guard logic, no new manifest logic.
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
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
  /** #286 (E4a, design #279 §6): threaded straight through to peripheral.ts's
   *  `RoleSessionOpts.maxBudgetUsd` (`--max-budget-usd`) — engine-agent.ts sets this to the
   *  remaining logical-review budget for the current attempt. Omitted -> no flag, unchanged
   *  behavior for review-session.ts's other caller shapes (there are none today besides
   *  engine-agent.ts). */
  maxBudgetUsd?: number;
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
      // #286 (E4a): see ReviewSessionOpts.maxBudgetUsd's own doc.
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      // No allowedTools/disallowedTools/proxy: RoleRunner.run() HARDCODES the whole review
      // profile (tool allow/deny, forced-hard guard, MCP/settings closure, no proxy) whenever
      // reviewCwd is set, and REFUSES any of those three fields being supplied alongside it —
      // see peripheral.ts's RoleSessionOpts.reviewCwd doc for the full, single-source-of-truth
      // list of what review mode hardcodes.
    });
    return { kind: "ran", ...result };
  } catch (e) {
    return { kind: "unavailable", reason: `review session setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
