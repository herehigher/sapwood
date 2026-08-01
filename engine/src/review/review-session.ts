// review-session.ts (#285, design #279 §3/§6, D7; seam formalized in #443) — "review session
// mode": the seam between review/materializer.ts's private-clone checkout (#284/E3a) and whatever
// SESSION RUNNER executes a static review AGAINST that materialized tree. This module owns exactly
// two things:
//   1. the `ReviewSessionExecutor` boundary itself (#443, design adjudication 2026-08-01) — the
//      formalization of what used to be an inline `Pick<RoleRunner, "run">` parameter here;
//   2. mapping an upstream materialization failure, or a spawn-time setup failure (e.g. a directory
//      that vanished between materialize() and this call), onto design #279 §6's contract verbatim
//      — "All setup failures ... map to `unavailable`" — so the caller (review/engine-agent.ts)
//      never has to distinguish "the review produced no findings" from "the review never actually
//      ran" by inspecting exceptions.
//
// WHAT AN EXECUTOR MAY RETURN (#443, the load-bearing half of the seam): UNTRUSTED SESSION
// EVIDENCE ONLY — an outcome, the raw final response text, the (provider, model) identity the
// session's OWN telemetry reports, spend evidence, and transcript identifiers. NEVER `Finding[]`,
// never a verdict, never a gate disposition. Validation (`agent-output.ts`'s
// parseAgentReviewOutputText -> validateAgentReviewOutput -> validateFindings) and blocking
// derivation over live `PRReviewData` stay entirely on the engine side of this boundary, so there
// is ONE parsing path for every runner: a second executor can change WHO runs the session, never
// what the session's output is allowed to mean.
//
// `ClaudeReviewSessionExecutor` below is the default and delegates to the EXISTING RoleRunner.run()
// `reviewCwd` facility (peripheral.ts, #87/#235/#236) unchanged — everything below is ALL that
// facility's, reused verbatim and HARDCODED there (Codex sol-high PR #300 review, P2/P3: the
// profile used to be pinned only by this wrapper passing allowedTools/disallowedTools explicitly —
// a future direct `RoleRunner.run({reviewCwd, ...})` caller could have overridden them. `run()` now
// REFUSES any caller-supplied allowedTools/disallowedTools/proxy together with reviewCwd, so this
// module doesn't pass them at all):
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
// no new guard logic, no new manifest logic. The OTHER shipped executor (codex-exec.ts's
// `CodexExecReviewSessionExecutor`, #443) owns its own argv/containment profile and its own
// honest-recording events; peripheral.ts is deliberately NOT touched by it (its guard/settings/
// tool-grant machinery is Claude-shaped and stays single-vendor).
import type { ContextManifest } from "../roles/context-manifest.js";
import type { RoleRunner } from "../roles/peripheral.js";
import type { MaterializeResult } from "./materializer.js";

/** #443 (D5 generalization): a session's model identity is a (provider, model) PAIR, never a bare
 *  model string — a runner is not a vendor (`codex exec` can target non-OpenAI providers), so
 *  "different model" is only meaningful against the provider that served it. Both fields are
 *  verbatim telemetry from the session itself; neither is ever inferred from config. */
export interface ReviewSessionIdentity {
  provider: string;
  model: string;
}

/** #443 (R1, honest recording): what an executor can honestly say about what the session cost.
 *   - `known`     — a real, provider-reported dollar figure (the Claude CLI's `total_cost_usd`).
 *   - `estimated` — no dollar telemetry exists, but token counts do: a pinned-price token estimate,
 *                   FLAGGED, never presented as a measurement. Bounded error is accepted (owner
 *                   ruling R1: budget is a side-product of #443 — keep the mechanism simple).
 *   - `unknown`   — no usable spend telemetry at all. NEVER read as `$0` anywhere: the caller's
 *                   retry-budget arithmetic fails closed on it (engine-agent.ts), and the executor
 *                   emits a cost-unknown alert event. */
export type ReviewSessionSpend = { kind: "known"; usd: number } | { kind: "estimated"; usd: number } | { kind: "unknown" };

/** One executed review session's UNTRUSTED evidence — see this module's own doc for what is
 *  deliberately absent (findings, verdicts, gate dispositions). */
export interface ReviewSessionEvidence {
  /** The session's own outcome axis, verbatim: it ran and exited cleanly / it ran and failed /
   *  it exceeded the wall-clock ceiling. A non-`done` outcome is still a RUN (it consumed
   *  budget) — distinct from `runReviewSession`'s `unavailable`, which means it never ran. */
  outcome: "done" | "failed" | "timeout";
  /** The session's final response text, raw and unvalidated (`""` when there was none). The ONLY
   *  channel by which a session can influence a verdict, and it does so exclusively through
   *  agent-output.ts's strict validation — a prose-only or malformed text validates to `null`
   *  there, which is an invalid attempt, never an approval and never a block. */
  resultText: string;
  /** The (provider, model) identities this session's OWN telemetry reported. EMPTY means
   *  unidentifiable — D5's fail-closed input: an unidentifiable reviewer can never be shown
   *  distinguishable from the producing worker, so the attempt maps to `unavailable`. */
  identity: ReviewSessionIdentity[];
  spend: ReviewSessionSpend;
  /** The session/lane name or thread id this run used — log/audit correlation only, never parsed. */
  sessionId: string;
  /** Where this session's transcript landed, when the runner has one on disk. Recorded so an
   *  operator can find the raw evidence behind a verdict; never read by the engine. */
  transcriptPath?: string;
  /** #236's ambient-context manifest, when the runner records one (the Claude executor does; the
   *  codex executor does not — it has no equivalent probe of its own). Evidence about what the
   *  session absorbed, not an input to any decision. */
  contextManifest?: ContextManifest;
}

/** #443: the request half of the seam — everything an executor needs to run ONE review session
 *  against an already-materialized tree, and nothing else (no forge handle, no state, no config
 *  object: an executor is a session runner, not a participant in the gate). */
export interface ReviewSessionRequest {
  /** The materialized tree the session runs INSIDE — its cwd and, for runners that can enforce
   *  one, its containment root. */
  treeDir: string;
  /** A short, log-friendly role identity (e.g. "engine-reviewer") — becomes part of the session's
   *  lane/sentinel name, never interpreted. */
  roleId: string;
  prompt: string;
  model: string;
  effort: string;
  /** The remaining logical-review budget for THIS attempt. A runner whose CLI can enforce a hard
   *  cap does so (Claude's `--max-budget-usd`); one that cannot degrades to advisory WITH an
   *  honest-recording event (design #443 R1) — it is never silently ignored. */
  budgetUsd?: number;
}

/** #443: the executor boundary. One method, one contract: run this session, return evidence, or
 *  THROW on a setup failure (`runReviewSession` below is the single place that maps a throw to
 *  `unavailable`, so no executor has to reimplement that mapping). */
export interface ReviewSessionExecutor {
  /** Which runner this is — recorded in honest-recording events and asserted by the dispatch
   *  test; never used to branch on behavior anywhere in the gate. */
  readonly runner: "claude" | "codex-exec";
  execute(req: ReviewSessionRequest): Promise<ReviewSessionEvidence>;
}

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
  /** #286 (E4a, design #279 §6): the remaining logical-review budget for this attempt, threaded
   *  to the executor's `budgetUsd`. Omitted -> no cap flag at all, unchanged behavior. */
  maxBudgetUsd?: number;
}

/** `"ran"` carries the session's own evidence verbatim — that is a DIFFERENT axis from
 *  `"unavailable"` below: a session that ran and failed (a crash, a timeout) is still "ran" (the
 *  caller's own retry/degrade logic operates on THAT outcome); `"unavailable"` means the review
 *  never got the chance to run at all — a materialization failure, or a setup failure this module
 *  caught before/around the spawn attempt. */
export type ReviewSessionOutcome = ({ kind: "ran" } & ReviewSessionEvidence) | { kind: "unavailable"; reason: string };

/** The provider every Claude-CLI-executed session runs against. Pinned as a constant rather than
 *  read from anywhere: the Claude executor delegates to `RoleRunner.run()`, whose CLI is the
 *  `claude` binary by construction (peripheral.ts / worker.ts's `discoverClaudeBin`) — there is no
 *  configuration that can point it at a different vendor, so hard-coding the provider here states a
 *  fact rather than assuming one. */
export const CLAUDE_PROVIDER = "anthropic";

/** worker.ts's `parseModelUsage` emits a model literally named "unknown" for records carrying no
 *  model identity; state.ts's `getWorkerActualModels` filters the same sentinel on the WORKER side.
 *  Filtered here so an all-unknown session leaves an EMPTY identity list (= unidentifiable, D5
 *  fail-closed) rather than a non-empty list that overlaps nothing and reads as "distinguishable". */
const UNKNOWN_MODEL_SENTINEL = "unknown";

/** #443: the DEFAULT executor — a pure delegation to the existing `RoleRunner.run({reviewCwd})`
 *  facility, byte-for-byte the behavior every engine-agent review had before the seam existed.
 *  It constructs no argv, pins no profile and strips no env of its own: every one of those is
 *  hardcoded inside `RoleRunner.run()` once `reviewCwd` is set (see this module's own doc). */
export class ClaudeReviewSessionExecutor implements ReviewSessionExecutor {
  readonly runner = "claude" as const;

  constructor(private readonly roleRunner: Pick<RoleRunner, "run">) {}

  async execute(req: ReviewSessionRequest): Promise<ReviewSessionEvidence> {
    const result = await this.roleRunner.run({
      roleId: req.roleId,
      prompt: req.prompt,
      model: req.model,
      effort: req.effort,
      // `fallbackModel: "none"` is claudeArgs' own documented sentinel for "omit --fallback-model
      // entirely" — a silent fallback swap could land the review on the SAME model as the
      // producing worker, exactly what D5 exists to prevent (engine-agent.ts's own doc).
      fallbackModel: "none",
      reviewCwd: req.treeDir,
      // #286 (E4a): the Claude CLI CAN enforce a hard per-session dollar ceiling, so this runner
      // passes it through as one — no advisory degradation, no warning event (R1's advisory path
      // exists only for runners whose CLI has no such mechanism).
      ...(req.budgetUsd !== undefined ? { maxBudgetUsd: req.budgetUsd } : {}),
      // No allowedTools/disallowedTools/proxy: RoleRunner.run() HARDCODES the whole review
      // profile (tool allow/deny, forced-hard guard, MCP/settings closure, no proxy) whenever
      // reviewCwd is set, and REFUSES any of those three fields being supplied alongside it —
      // see peripheral.ts's RoleSessionOpts.reviewCwd doc for the full, single-source-of-truth
      // list of what review mode hardcodes.
    });
    return {
      outcome: result.outcome,
      resultText: result.resultText ?? "",
      // #302 review (Codex P1, cost cap): ONLY an explicit `costKnown: false` reads as unknown —
      // `undefined` (a legacy test fake that never sets the optional field) reads as known, per
      // RoleSessionResult.costKnown's own convention; a REAL RoleRunner.run() always sets it.
      spend: result.costKnown === false ? { kind: "unknown" } : { kind: "known", usd: result.costUsd },
      identity: result.modelUsage
        .map((m) => m.model)
        .filter((m) => m !== UNKNOWN_MODEL_SENTINEL)
        .map((model) => ({ provider: CLAUDE_PROVIDER, model })),
      sessionId: result.name,
      ...(result.contextManifest !== undefined ? { contextManifest: result.contextManifest } : {}),
    };
  }
}

/** Run one static review session against an already-materialized tree, through `executor`. Never
 *  throws: every setup failure (an upstream materialization failure, a materialized directory that
 *  vanished before spawn, a guard-hook-missing refusal, a spawn error) is caught here and mapped to
 *  `{ kind: "unavailable" }` — design #279 §6's contract that a setup failure is never a silently
 *  degraded run, now enforced once for EVERY runner rather than per-executor. */
export async function runReviewSession(executor: ReviewSessionExecutor, opts: ReviewSessionOpts): Promise<ReviewSessionOutcome> {
  if (opts.materialize.kind !== "materialized") {
    return { kind: "unavailable", reason: opts.materialize.reason };
  }
  try {
    const evidence = await executor.execute({
      treeDir: opts.materialize.treeDir,
      roleId: opts.roleId,
      prompt: opts.prompt,
      model: opts.model,
      effort: opts.effort,
      ...(opts.maxBudgetUsd !== undefined ? { budgetUsd: opts.maxBudgetUsd } : {}),
    });
    return { kind: "ran", ...evidence };
  } catch (e) {
    return { kind: "unavailable", reason: `review session setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
