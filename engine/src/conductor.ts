// The conductor: the scheduler. One tick = reclaim -> drive -> dispatch.
//
// This file is a TS port of 0day's ops/loop/loop_conductor.sh — but ONLY the generic
// scheduling core, never the trading domain (no reserve/SLA/eval-report/HTML machinery).
// The pure functions below mirror test_loop_conductor.sh row-for-row (see conductor.test.ts).
//
// Design (PLAN.md):
//  - Structured, typed tick result (discriminated unions) replaces 0day's stringly-typed
//    DISPATCHED.../RECLAIMED... text protocol greped by skills.
//  - The tick takes its side-effecting collaborators by injection (IForge, a dispatch fn,
//    a clock, State) so it is fully unit-testable without spawning a real `claude`.
//  - producer != merger: the tick may *decide* MERGE, but the actual merge is forge.mergePR
//    (conductor identity), never a worker. The worker is only ever the injected dispatch fn.

import type { IForge, Issue } from "./forge.js";
import type { State, BoardStatus, PendingRollback, ModelUsageEntry, WorkerRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { DriveOutcome } from "./merge-driver.js";
import type { ReviewFallbackLock } from "./reviewer.js";
import { isReviewerKind } from "./reviewer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure scheduling core (parity targets — keep semantics identical to guard's bash twin)
// ─────────────────────────────────────────────────────────────────────────────

/** Next round id. Dirty/missing/<1 -> 1, else prev+1. Never negative, never throws. */
export function nextRoundId(prev?: string | number): number {
  const s = prev === undefined ? "" : String(prev);
  return /^[1-9][0-9]*$/.test(s) ? Number(s) + 1 : 1;
}

export type LaneClass = "KEEP" | "DONE" | "FAILED" | "DEAD";

/**
 * Classify an in-flight lane from the 4 completion signals (§7), priority high->low:
 * failed sentinel > done sentinel > wrapper-confirmed-dead(no sentinel) | heartbeat-timeout > KEEP.
 * wrapperAlive: 1 alive | 0 dead (kill -0 failed) | -1 unknown (no readable pid).
 * hbAge < 0 means "no heartbeat file yet" (just spawned) — not a timeout.
 */
export function classifyLane(
  done: boolean,
  failed: boolean,
  hbAge: number,
  threshold: number,
  wrapperAlive: -1 | 0 | 1,
): LaneClass {
  if (failed) return "FAILED";
  if (done) return "DONE";
  if (wrapperAlive === 0) return "DEAD"; // confirmed dead, no sentinel -> crashed without trace
  if (hbAge >= 0 && hbAge > threshold) return "DEAD"; // heartbeat stale
  return "KEEP";
}

/** total > cap. Float-safe; equal is NOT over (matches awk t>c). */
export function budgetExceeded(total: number, cap: number): boolean {
  return total > cap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine cost ceiling (#14, M3 Security model "hard engine ceiling"). Two-tier cost
// control: worker.budgetUsdSoft is a per-worker graceful handoff (never a mid-work kill,
// see worker.ts requestHandoff). This is the OTHER tier — an engine-wide,
// aggregate-across-workers safety boundary: a cumulative daily USD cap + a wall-clock cap.
// Either freezes ALL new dispatch and starts a bounded drain (graceful handoff of running
// workers) before escalating to a hard kill.
//
// #69: the out-of-band KILL SWITCH (a file sentinel only a human/engine can write — see
// State.isKillSwitchActive) used to be a THIRD ceiling reason here, plus two separate
// per-phase re-checks inside the DRIVE and DISPATCH loops below (#59/#61) added to catch an
// operator flipping it mid-tick. All three are replaced by ONE global gate at the very top
// of tick() (see there): active -> drain-only, tick returns before anything else runs — no
// ceiling evaluation, no rollback retry, no reclaim, no drive, no dispatch. The trade-off
// (accepted per the #69 CTO policy — rare edges degrade to less machinery, not more): a
// switch flipped mid-tick, after tick() already passed the top-of-tick check, is no longer
// caught until the NEXT tick, not the same one. Given tick cadence is normally minutes at
// most, this is a small, documented gap in exchange for deleting 3 separate check sites.
// ─────────────────────────────────────────────────────────────────────────────

export type CeilingReason = "kill-switch" | "daily-budget" | "wall-clock";

/** Engine-session BASE stale gap (State.engineSessionStart): a tick gap longer than this
 *  means the engine was stopped/crashed/paused, and the wall-clock session resets. Longer
 *  than any sane tick interval (0day ticks are minutes apart) so a live engine never
 *  self-resets, yet short enough that an operator pause is a practical recovery from a
 *  wall-clock breach. NEVER compare a tick cadence against this constant directly — use
 *  engineSessionGapSec(tickIntervalSec), which scales the gap with the cadence. */
export const ENGINE_SESSION_GAP_SEC = 900;

/** The stale gap actually used: max(base, 2 × the caller's tick cadence). A fixed 900s gap
 *  with a legal tick cadence ≥ 15min would make EVERY tick look stale — the session resets
 *  each tick, wallClockElapsedSec ≈ 0 forever, and the wall-clock tier silently never fires
 *  (gate② PR #41 P2, exactly the fail-open class this repo guards against). Scaling by 2×
 *  keeps one missed tick from resetting the session while any cadence stays well under the
 *  gap. Non-finite/negative cadence (unknown / self-paced caller) -> the base gap. */
export function engineSessionGapSec(tickIntervalSec: number): number {
  if (!Number.isFinite(tickIntervalSec) || tickIntervalSec <= 0) return ENGINE_SESSION_GAP_SEC;
  return Math.max(ENGINE_SESSION_GAP_SEC, 2 * tickIntervalSec);
}

/** Pure ceiling check — daily USD cap + wall-clock cap ONLY. #69: the kill switch is no
 *  longer one of these reasons; it's checked once, at the very top of tick(), before this
 *  (or anything else) ever runs — see the section comment above. Order is fixed
 *  (daily-budget, wall-clock) so multiple simultaneous breaches report deterministically;
 *  empty array = no breach. */
export function evaluateCeiling(input: {
  dailySpendUsd: number;
  dailyBudgetUsd: number;
  wallClockElapsedSec: number;
  maxWallClockSec: number;
}): CeilingReason[] {
  const reasons: CeilingReason[] = [];
  if (budgetExceeded(input.dailySpendUsd, input.dailyBudgetUsd)) reasons.push("daily-budget");
  if (input.wallClockElapsedSec > input.maxWallClockSec) reasons.push("wall-clock");
  return reasons;
}

/** Has the bounded drain window (cfg.cost.drainWindowSec) elapsed since a ceiling breach was
 *  FIRST detected (breachAtIso)? Float-safe; exactly-at-window is NOT yet due (matches
 *  budgetExceeded's ">" convention — equal is not over). */
export function drainEscalationDue(breachAtIso: string, nowMs: number, drainWindowSec: number): boolean {
  return (nowMs - Date.parse(breachAtIso)) / 1000 > drainWindowSec;
}

/**
 * Lowest prio:N rank across labels (0..4, low = higher priority). No prio label -> 3.
 * Matches both the bare `prio:N` form that `sapwood init` creates AND the suffixed
 * `prio:N-foo` form used in practice (e.g. prio:1-high). This intentionally diverges from
 * 0day's bash twin, which only matched the hyphenated form — sapwood's own taxonomy
 * (init.ts) is bare, so a bare-only-or-suffixed match is required for the taxonomy to work.
 */
export function issuePriority(labels: string[]): number {
  let min = 5; // sentinel: no prio label found
  for (const tok of labels) {
    const m = /^prio:([0-4])(?:-|$)/.exec(tok);
    if (m) {
      const d = Number(m[1]);
      if (d < min) min = d;
    }
  }
  return min === 5 ? 3 : min;
}

/** blocked-by:[#]N blocker issue numbers, ascending. */
export function labelsBlockers(labels: string[]): number[] {
  const out: number[] = [];
  for (const tok of labels) {
    const m = /^blocked-by:#?([0-9]+)$/.exec(tok);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** True if any reserve-ish label (reserve / needs-human — config-driven) is present. */
export function hasReserveLabel(labels: string[], reserveLabels: string[]): boolean {
  return labels.some((l) => reserveLabels.includes(l));
}

/** Reserved coding-lane floor = ceil(L/2) (anti-starvation). */
export function codingFloor(L: number): number {
  return Math.floor((L + 1) / 2);
}

/** rank >= 3 (feature / fe-polish) counts toward the coding floor; 0..2 are meta work. */
export function isCodingRank(rank: number): boolean {
  return rank >= 3;
}

/**
 * May a meta-work (rank<=2) candidate take a lane?
 * cap = L - codingFloor(L). Allow if under cap OR no coding candidate is waiting
 * (anti-idle: don't leave a reserved lane empty when there's nothing to reserve it for).
 */
export function metaLaneAllowed(L: number, curNoncoding: number, codingWaiting: number): boolean {
  const cap = L - codingFloor(L);
  return curNoncoding < cap || codingWaiting === 0;
}

export type ReclaimDone = "DRIVING" | "ESCALATE_NOPR";
/** Coding worker finished: has PR -> DRIVING (lane held, enter drive); else ESCALATE_NOPR (fail-safe). */
export function laneOnReclaimDone(hasPr: boolean): ReclaimDone {
  return hasPr ? "DRIVING" : "ESCALATE_NOPR";
}

export type ReclaimFailed = "DRIVING" | "ESCALATE";
/** Worker failed: has PR -> DRIVING (rescue, e.g. budget-exhausted after a clean PR); else ESCALATE. */
export function laneOnReclaimFailed(hasPr: boolean): ReclaimFailed {
  return hasPr ? "DRIVING" : "ESCALATE";
}

export type GatedReentryDecision = "RECLAIM" | "CAPPED" | "SKIP";
/**
 * #147 gated-PR reentry: the GATED RECLAIM phase's per-lane decision, pure so it's parity-
 * testable like driveDecision above (which it deliberately mirrors — cfg.lanes.gatedReentryCap
 * plays the same role prFixCap plays there).
 *  - `needsHumanLabelPresent`: still true -> SKIP (no explicit human act yet, PLAN.md autonomy
 *    principle — automation never re-admits itself).
 *  - label gone, `attempts < cap` -> RECLAIM (reclaim back to `driving`, bump the attempt count).
 *  - label gone, `attempts >= cap` -> CAPPED (the cap was already spent on a prior reclaim that
 *    re-escalated; fail closed rather than retry forever — re-escalate + latch permanently).
 */
export function gatedReentryDecision(
  needsHumanLabelPresent: boolean,
  attempts: number,
  cap: number,
): GatedReentryDecision {
  if (needsHumanLabelPresent) return "SKIP";
  return attempts < cap ? "RECLAIM" : "CAPPED";
}

export type DriveAction = "MERGE" | "WAIT" | "FIXUP" | "ESCALATE";
/**
 * Derive a scheduling action from the PR gate + fixup-round count.
 *  MERGE -> MERGE; WAIT -> WAIT;
 *  FIXABLE: non-integer/negative rounds OR over-budget -> ESCALATE (no new fixup worker);
 *           rounds < cap -> FIXUP, else ESCALATE.
 *  HUMAN / empty / unknown -> ESCALATE (fail-safe: never auto-merge/auto-fix on a bad signal).
 *
 * NOTE: this is the conductor's drive_decision only. The PR-gate ACTION->action map
 * (0day merge_decision / pr_gate) belongs to M3's reviewer.ts + merge-driver.ts.
 */
export function driveDecision(
  gate: string,
  fixRounds: number,
  cap: number,
  overBudget: boolean,
): DriveAction {
  switch (gate) {
    case "MERGE":
      return "MERGE";
    case "WAIT":
      return "WAIT";
    case "FIXABLE":
      if (!Number.isInteger(fixRounds) || fixRounds < 0) return "ESCALATE";
      if (overBudget) return "ESCALATE";
      return fixRounds < cap ? "FIXUP" : "ESCALATE";
    default:
      return "ESCALATE";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick orchestration: reclaim -> drive -> dispatch. Side-effecting collaborators are
// injected (IForge, Supervisor, State, MergeGate) so the whole tick is unit-testable without
// ever spawning a real `claude` or calling `gh`. producer != merger: the tick itself never
// calls forge.mergePR — that lives one level down, in MergeGate.driveOne (merge-driver.ts),
// invoked ONLY from here (never from a worker).
// ─────────────────────────────────────────────────────────────────────────────

/** The 4-signal snapshot of one in-flight lane (sentinels + heartbeat + pid). Worker domain. */
export interface LaneProbe {
  done: boolean;
  failed: boolean;
  handoff: boolean; // soft-budget graceful handoff sentinel: resumable, do NOT kill
  hbAge: number; // seconds since heartbeat mtime; -1 if no heartbeat file yet (just spawned)
  wrapperAlive: -1 | 0 | 1; // 1 alive | 0 confirmed dead (kill -0 failed) | -1 unknown
  hasPr: boolean; // an open PR exists for this lane's issue
  /** The open PR's number, when hasPr — the merge driver's gate/merge target (#13). Optional:
   *  probe fixtures that predate #13 (hasPr only, no number) still type-check; a driving lane
   *  with hasPr=true but no prNumber known keeps hasPr's rescue behavior but can't be driven
   *  through gates until a number is available (tick's fail-safe below escalates it). */
  prNumber?: number;
  /** Terminal total_cost_usd (stream-json), once done/failed/handoff; 0 while still running
   *  or if unknown (e.g. a DEAD lane with no sentinel). Optional for probe fixtures that
   *  predate #14 — treated as 0. */
  costUsd?: number;
  /** Terminal per-model token usage (stream-json `usage`/`modelUsage`, #47), once
   *  done/failed/handoff; empty while still running or if unknown. Optional for probe
   *  fixtures that predate #47 — treated as []. */
  modelUsage?: ModelUsageEntry[];
}

/** #69: what reclaim() did with the lane's worktree. Dirty-worktree retention policy:
 *  automation never deletes a worktree that may hold uncommitted work — it reports
 *  `worktreeRetained: true` and the CONDUCTOR (which owns the forge) escalates to a human
 *  (issue comment with the absolute path + needs-human label). Clean worktree -> deleted as
 *  before, `worktreeRetained: false`. `worktreePath` is null when no worktree ever existed. */
export interface ReclaimResult {
  worktreePath: string | null;
  worktreeRetained: boolean;
}

/** The conductor's only handle on workers. worker.ts (M2 #11) implements this. */
export interface Supervisor {
  probe(worker: string): Promise<LaneProbe>;
  dispatch(issue: Issue): Promise<{ name: string; sessionId: string }>;
  /** Tear down a dead/stale lane (process-tree kill + worktree retention/cleanup, #69). */
  reclaim(worker: string): Promise<ReclaimResult>;
  /** #69 (fable P3-b): report a lane's worktree dirtiness WITHOUT any teardown — no kill, no
   *  delete. For a terminal-sentinel lane (`.done`/`.failed`) rescued to `driving`, which is
   *  never reclaim()'d, so its worktree is never dirtiness-checked. `worktreeRetained: true`
   *  == possibly-dirty ⇒ the conductor escalates to needs-human instead of auto-driving. */
  inspectWorktree(worker: string): ReclaimResult;
  /** Graceful drain (SIGTERM, not SIGKILL): the #14 engine-ceiling drain path reuses this —
   *  same mechanism as a worker's own soft-budget handoff. Returns false if not applicable
   *  (already reclaiming/requested, or unknown lane) — never throws. */
  requestHandoff(worker: string): boolean;
}

/** The conductor's only handle on the review + merge gate (#13). merge-driver.ts's
 *  MergeDriver implements this shape structurally — the ONLY caller is tick() below, never a
 *  worker (producer != reviewer != merger, structural: a worker has no reference to this and
 *  no path to acquire one). Optional in TickDeps: omitted -> driving lanes stay driving with no
 *  gate/merge activity (pre-#13 behavior, preserved for callers not yet configuring a reviewer). */
export interface MergeGate {
  /** One gate + merge attempt for `pr` (#13; trigger folded in per #55 P1-B). `issue` (#46) is
   *  threaded to the reviewer so a fresh trigger can carry the issue's verification plan.
   *  `triggerPin` is the lane's State-recorded {head, at} from its last posted trigger (null
   *  fields when none has ever been recorded — tick() below reads this straight off the
   *  WorkerRow); `recordTrigger` is tick()'s callback into State.recordReviewTrigger, invoked by
   *  driveOne the instant it posts a fresh trigger for a new/never-triggered head. Never throws
   *  (see merge-driver.ts). */
  driveOne(
    pr: number,
    issue: number,
    triggerPin: { head: string | null; at: string | null },
    recordTrigger: (head: string, at: string) => void,
    /** #54: the lane's State-recorded reviewer-failover lock + a callback to persist a new one.
     *  Optional — a MergeGate fake that predates #54 (this whole test file) still satisfies
     *  this type without implementing it. */
    fallback?: {
      lock: ReviewFallbackLock;
      recordFallback: (lock: ReviewFallbackLock) => void;
    },
    /** #147 P1: true when this lane re-entered via GATED RECLAIM (gated_reentry_attempts > 0)
     *  — the merge driver then counts only reviews submitted AFTER the re-entry's own trigger
     *  (see MergeDriver.driveOne), so the stale pre-escalation review can't satisfy the
     *  re-driven gate②. Optional — pre-#147 fakes still satisfy this type. */
    reentered?: boolean,
  ): Promise<DriveOutcome>;
}

export type DrivenOutcome =
  | { kind: "merged"; worker: string; issue: number; pr: number }
  | { kind: "needs-human"; worker: string; issue: number; pr: number; reason: string }
  | { kind: "queued"; worker: string; issue: number; pr: number; reason: string }
  | { kind: "stopped"; worker: string; issue: number; pr: number; reason: string };

// #47: every TERMINAL reclaim outcome carries the same {costUsd, modelUsage} the tick just
// recorded into spend_ledger for that lane — groundwork for the #15 `status --cost` table and
// the v0.2 dashboard, without a separate query. "kept" (still running) has neither: stream-json
// carries no in-progress cost/usage (only the terminal result line does).
interface TerminalSpend {
  costUsd: number;
  modelUsage: ModelUsageEntry[];
}

export type ReclaimOutcome =
  | { kind: "kept"; worker: string; issue: number }
  | ({ kind: "done"; worker: string; issue: number; next: ReclaimDone } & TerminalSpend)
  | ({ kind: "failed"; worker: string; issue: number; next: ReclaimFailed } & TerminalSpend)
  | ({ kind: "handoff"; worker: string; issue: number } & TerminalSpend)
  | ({ kind: "dead"; worker: string; issue: number; rescued: boolean } & TerminalSpend);

export type DispatchOutcome =
  | { kind: "dispatched"; issue: number; worker: string }
  | {
      kind: "skipped";
      issue: number;
      reason: "cap" | "no-lane" | "in-flight" | "over-budget" | "meta-floor" | "ceiling";
    };

/** #31: outcome of one durably-persisted recovery-path board mutation this tick (retried from
 *  a prior tick's pending_rollbacks row, or created inline by a fresh dispatch/dead-lane
 *  failure this tick). Never a silent swallow — every attempt, success or not, lands here AND
 *  in the event log. */
export type RollbackOutcome =
  | { kind: "recovered"; issue: number; target: BoardStatus; reason: string }
  | { kind: "retrying"; issue: number; attempts: number; reason: string }
  | { kind: "escalated"; issue: number; attempts: number; reason: string };

/** #147: outcome of one gated-PR reentry decision this tick — a failed, PR-carrying lane whose
 *  issue's needs-human label is gone (gatedReentryDecision above). "reclaimed" means the lane is
 *  back in `driving` this same tick (the DRIVE loop below re-drives it, no new worker); "capped"
 *  means the cap was already spent and this removal was rejected — re-escalated + permanently
 *  latched (State.gatedFailedWorkers never returns it again). */
export type GatedReclaimOutcome =
  | { kind: "reclaimed"; worker: string; issue: number; pr: number; attempt: number }
  | { kind: "capped"; worker: string; issue: number; pr: number; attempts: number };

export interface TickResult {
  reclaimed: ReclaimOutcome[];
  dispatched: DispatchOutcome[];
  overBudget: boolean;
  /** #14 engine ceiling (daily USD cap / wall-clock cap): a breach freezes ALL new dispatch
   *  this tick (every ready issue skipped with reason "ceiling") regardless of
   *  lanes/caps/budget below. #69: also true (reasons = ["kill-switch"]) when the global
   *  kill-switch gate short-circuited the whole tick to drain-only. */
  ceilingBreached: boolean;
  ceilingReasons: CeilingReason[];
  /** Running-worker names asked to gracefully hand off (SIGTERM) this tick because of the
   *  ceiling breach. Idempotent to call every tick while still breached (empty once no
   *  workers are running, or the ceiling clears). */
  drainRequested: string[];
  /** Running-worker names hard-killed (supervisor.reclaim) this tick because the bounded
   *  drain window elapsed since the breach was first detected. Always a subset of / disjoint
   *  from drainRequested's *previous* ticks — the drain always precedes the kill. */
  escalated: string[];
  /** #13: driving lanes run through gate①/gate② this tick (only when deps.mergeGate is
   *  provided). Empty when mergeGate is omitted, or when there were no driving lanes. */
  driven: DrivenOutcome[];
  /** #31: every pending rollback (persisted this tick or a prior one) attempted this tick —
   *  recovered / still-retrying / escalated-to-needs-human. Empty when nothing was pending
   *  and no new recovery-path failure occurred this tick. */
  rollbacks: RollbackOutcome[];
  /** #147: gated-PR reentry decisions this tick (only when deps.mergeGate is provided — reentry
   *  without a gate to drive through would just strand the lane). Empty when there were no
   *  eligible failed+PR lanes, or every one's needs-human label was still present. */
  gatedReclaimed: GatedReclaimOutcome[];
}

export interface TickDeps {
  forge: IForge;
  state: State;
  supervisor: Supervisor;
  cfg: SapwoodConfig;
  /** Cumulative round spend (USD) for the hard round-budget gate. Worker cost sum; caller
   *  computes it from stream-json (worker.ts). Default 0 (no spend known yet). */
  roundSpendUsd?: number;
  /** The caller's tick cadence in seconds, when ticks run on a fixed schedule. Scales the
   *  wall-clock session stale gap (engineSessionGapSec: max(900, 2× cadence)) so a legal
   *  slow cadence cannot make every tick look stale and silently void the wall-clock tier
   *  (gate② PR #41 P2). The M4 loop driver MUST pass its cadence here. Omitted -> the base
   *  gap (only safe for callers ticking faster than ENGINE_SESSION_GAP_SEC). */
  tickIntervalSec?: number;
  now?: () => Date;
  /** #13: the review + merge gate for driving lanes. Omitted -> driving lanes stay driving with
   *  no gate/merge activity this tick (pre-#13 behavior — M2 dogfood / callers that haven't
   *  wired a reviewer yet keep working unchanged). */
  mergeGate?: MergeGate;
  /** #76 goal-based stop conditions: OR'd into the #75 PAUSE check below — same DISPATCH-only
   *  skip, just driven by the driver's stop-condition wind-down instead of the data/PAUSE file
   *  sentinel. Reclaim/drive (in-flight lanes, PR review/merge progression) are untouched either
   *  way; only new-lane dispatch is suppressed. Default false (today's behavior unchanged). */
  forceDispatchPause?: boolean;
}

/**
 * Dispatchable Ready issues, ordered (priority asc, number asc). Filters out reserve /
 * needs-human (held for human triage) and any issue carrying a blocked-by label.
 * ponytail: blocked-by issues are skipped while the label is present; re-checking the
 * blocker's OPEN/CLOSED state (to auto-unblock once it closes) is an M3 refinement — for
 * now triage removes the label. Avoids an extra gh round-trip per blocker per tick.
 */
export function orderForDispatch(ready: Issue[], cfg: SapwoodConfig): Issue[] {
  // Held out of the main lane: reserve + every escalation label (needs-human, blocked, …).
  // Sourced from config so the plain `blocked` label (escalation.humanLabels) is honored,
  // not just reserve/needs-human (Codex P2, PR #30).
  const reserveish = [cfg.labels.reserve, ...cfg.escalation.humanLabels];
  return ready
    .filter((i) => !hasReserveLabel(i.labels, reserveish))
    .filter((i) => labelsBlockers(i.labels).length === 0)
    .map((i) => ({ i, rank: issuePriority(i.labels) }))
    .sort((a, b) => a.rank - b.rank || a.i.number - b.i.number)
    .map((x) => x.i);
}

/**
 * One attempt at a durably-persisted recovery-path board mutation (#31). `row` may be a
 * freshly-inserted pending_rollbacks row (attempts: 0, its own attempt not yet made) or one
 * read back via state.pendingRollbacks() on a later tick — either way this makes exactly one
 * forge.setBoardStatus attempt and resolves the row: cleared on success, bumped (retried next
 * tick) on failure under the cap, or cleared + escalated (needs-human label attempt, never a
 * silent swallow) once attempts hit cfg.recovery.rollbackRetryCap. Never throws — the whole
 * point is that a repeated forge failure here must not propagate and must not go unrecorded.
 */
async function attemptRollback(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  row: Pick<PendingRollback, "id" | "issue" | "target" | "reason" | "attempts">,
  iso: () => string,
): Promise<RollbackOutcome> {
  try {
    await forge.setBoardStatus(row.issue, row.target);
    state.clearPendingRollback(row.id);
    state.appendEvent("rollback-recovered", { issue: row.issue, target: row.target, reason: row.reason });
    return { kind: "recovered", issue: row.issue, target: row.target, reason: row.reason };
  } catch (e) {
    const attempts = row.attempts + 1;
    if (attempts >= cfg.recovery.rollbackRetryCap) {
      state.clearPendingRollback(row.id);
      // Best-effort last-mile notification — its own failure is not re-persisted (this is
      // already the bounded-retry escalation path, not another recovery loop to harden) but
      // the structured event + returned outcome below always fire regardless, so the
      // escalation itself is never silently swallowed even if the label call is.
      await forge.addLabel(row.issue, cfg.labels.needsHuman).catch(() => {});
      state.appendEvent("rollback-escalated", {
        issue: row.issue, target: row.target, reason: row.reason, attempts, error: String(e),
      });
      return { kind: "escalated", issue: row.issue, attempts, reason: row.reason };
    }
    state.bumpPendingRollback(row.id, iso());
    state.appendEvent("rollback-retry-failed", {
      issue: row.issue, target: row.target, reason: row.reason, attempts, error: String(e),
    });
    return { kind: "retrying", issue: row.issue, attempts, reason: row.reason };
  }
}

/** #69 dirty-worktree retention: tell a human where the preserved worktree lives. Best-effort
 *  and never throws (this runs on recovery paths that must not gain new failure modes) — the
 *  structured event always lands even if both forge calls fail. The needs-human LABEL is the
 *  caller's job (every retention call site already applies it on its own escalation branch). */
async function reportRetainedWorktree(
  forge: IForge, state: State, worker: string, issue: number, worktreePath: string | null,
): Promise<void> {
  state.appendEvent("worktree-retained", { worker, issue, worktreePath });
  await forge
    .addIssueComment(
      issue,
      `sapwood: lane \`${worker}\` was torn down with possibly-uncommitted changes in its ` +
        `worktree. Automation never deletes work it can't prove is clean (#69) — the worktree ` +
        `was left on disk at:\n\n\`${worktreePath}\`\n\nSalvage or discard it by hand, then ` +
        `remove the \`needs-human\` label.`,
    )
    .catch(() => {});
}

/** The bounded drain (PLAN.md Security model: drain before kill, always). Shared by the #69
 *  global kill-switch gate and the #14 cost-ceiling breach path in tick(): record the breach
 *  (first detection only — see State.recordCeilingBreach's INSERT OR IGNORE), ask every
 *  running worker to hand off gracefully (idempotent per tick), and only once
 *  cfg.cost.drainWindowSec has elapsed since first detection escalate to the hard
 *  process-tree kill + needs-human. No PR-aware rescue on escalation — this is a safety
 *  boundary, not a liveness classification, so fail-safe to human triage. */
async function drainThenEscalate(
  forge: IForge, state: State, supervisor: Supervisor, cfg: SapwoodConfig,
  reasons: CeilingReason[], nowDate: Date, iso: () => string,
): Promise<{ drainRequested: string[]; escalated: string[] }> {
  state.recordCeilingBreach(reasons, nowDate);
  const drainRequested: string[] = [];
  const escalated: string[] = [];
  const stillRunning = state.runningWorkers();
  for (const w of stillRunning) {
    if (supervisor.requestHandoff(w.name)) drainRequested.push(w.name);
  }
  const breach = state.ceilingBreach();
  if (breach && drainEscalationDue(breach.at.toISOString(), nowDate.getTime(), cfg.cost.drainWindowSec)) {
    for (const w of stillRunning) {
      // Probe BEFORE reclaim (which kills the process) so an open PR is still discoverable for
      // the belt-and-suspenders PR-label below.
      const p = await supervisor.probe(w.name);
      const r = await supervisor.reclaim(w.name);
      // #69 (fable P2a): do ALL forge work BEFORE the terminal `upsertWorker(failed)`, and make
      // the label calls best-effort. Ordering matters — once the row goes `failed` it leaves
      // runningWorkers() and no later tick re-escalates it; if a forge call had thrown between
      // the terminal upsert and the retained-worktree report, a possibly-WIP-bearing worktree
      // would sit on disk with zero trace (no label, no comment, no event) and the drain tick
      // would abort mid-loop. Best-effort labels + report guarantee the structured event and
      // the terminal transition always land, exactly as attemptRollback does elsewhere.
      await forge.addLabel(w.issue, cfg.labels.needsHuman).catch(() => {});
      // Parity with the DEAD path's P1 fix: land needs-human on the PR too (where the merge
      // gate reads labels), for a dirty-WIP lane that happens to have an open PR.
      if (r.worktreeRetained && p.hasPr && p.prNumber != null) {
        await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman).catch(() => {});
      }
      if (r.worktreeRetained) await reportRetainedWorktree(forge, state, w.name, w.issue, r.worktreePath);
      state.appendEvent("ceiling-escalated", { worker: w.name, issue: w.issue, reasons });
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      escalated.push(w.name);
    }
  }
  return { drainRequested, escalated };
}

/** Reclaim a lane that has reached a TERMINAL sentinel (handoff / done / failed) — record its
 *  real outcome and transition the worker row out of `running`. Returns the outcome, or `null`
 *  when the lane is NOT terminal (KEEP still-running, or DEAD with no sentinel) so the caller
 *  handles those (KEEP/DEAD live in the main reclaim loop; the kill-switch gate leaves them for
 *  the drain). Extracted so the #69 kill-switch gate can reclaim terminal lanes without
 *  duplicating this logic (Codex PR #72 P2) — a graceful drain that already wrote .handoff/.done
 *  must be recorded as such, never rotted as `running` until drainThenEscalate mislabels it
 *  failed. Touches no process/worktree (terminal lanes have sentinels — nothing to kill). */
async function reclaimTerminalLane(
  forge: IForge, state: State, supervisor: Supervisor, cfg: SapwoodConfig,
  w: WorkerRow, p: LaneProbe, threshold: number, iso: () => string,
): Promise<ReclaimOutcome | null> {
  const costUsd = p.costUsd ?? 0;
  const modelUsage = p.modelUsage ?? [];
  if (p.handoff) {
    // Soft-budget graceful handoff: terminal-but-resumable. Never killed; the conductor may
    // --resume later. Checked before classifyLane (a handoff is not a failure).
    state.upsertWorker({ ...w, state: "handoff", ended_at: iso() });
    // M4 --resume TRAP (gate② PR #41 P3): this records the handed-off run's total_cost_usd. If
    // this lane is later resumed and claude reports CUMULATIVE total_cost_usd for the resumed
    // session, recording the resumed run's total again at its terminal transition double-counts
    // the pre-handoff portion — fail-SAFE for the cap (over-counts) but corrupts accounting.
    // Whoever wires --resume (M4) must record the delta, or verify claude's resume cost first.
    state.recordSpend(w.name, w.issue, costUsd, iso(), modelUsage);
    state.appendEvent("handoff", { worker: w.name, issue: w.issue });
    return { kind: "handoff", worker: w.name, issue: w.issue, costUsd, modelUsage };
  }
  const cls = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive);
  if (cls === "DONE") {
    const next = laneOnReclaimDone(p.hasPr);
    if (next === "DRIVING") {
      // PR produced: hold the lane in `driving` (it still occupies a lane until the #13 review
      // gate resolves it). No requeue, no human escalation.
      state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
    } else {
      // ESCALATE_NOPR: done but no PR -> nothing to drive; free the lane, escalate to human.
      state.upsertWorker({ ...w, state: "done", ended_at: iso() });
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
    }
    state.recordSpend(w.name, w.issue, costUsd, iso(), modelUsage);
    state.appendEvent("reclaim-done", { worker: w.name, issue: w.issue, next });
    return { kind: "done", worker: w.name, issue: w.issue, next, costUsd, modelUsage };
  }
  if (cls === "FAILED") {
    let next = laneOnReclaimFailed(p.hasPr);
    // #69 (fable P3-b): a `.failed`-sentinel lane with a PR is rescued to `driving` — but the
    // worker exited NON-ZERO, so it may have left uncommitted WIP alongside its PR. Apply the
    // DEAD-path dirty ⇒ needs-human policy here too: inspect the worktree (no teardown — the
    // process already exited) and, if possibly-dirty, escalate to a human instead of
    // auto-driving an incomplete PR toward merge.
    let retained: ReclaimResult | null = null;
    if (next === "DRIVING") {
      retained = supervisor.inspectWorktree(w.name);
      if (retained.worktreeRetained) next = "ESCALATE";
    }
    if (next === "DRIVING") {
      // Failed but a clean PR exists (e.g. budget-exhausted after opening it): rescue — hold
      // the lane driving for the review gate rather than escalating.
      state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
    } else {
      // Forge work BEFORE the terminal upsert (parity with the DEAD path's ordering). needs-human
      // lands on the PR too, where the merge gate reads labels, when the escalation is dirty-WIP.
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      if (retained?.worktreeRetained) {
        if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);
        await reportRetainedWorktree(forge, state, w.name, w.issue, retained.worktreePath);
      }
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
    }
    state.recordSpend(w.name, w.issue, costUsd, iso(), modelUsage);
    state.appendEvent("reclaim-failed", { worker: w.name, issue: w.issue, next });
    return { kind: "failed", worker: w.name, issue: w.issue, next, costUsd, modelUsage };
  }
  return null; // KEEP or DEAD — not a terminal sentinel; caller handles it
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge, state, supervisor, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const threshold = cfg.worker.heartbeatStaleSecs;

  // ── KILL SWITCH (#69): ONE global gate, checked before anything else runs. Active ->
  //   this tick is DRAIN + TERMINAL-RECLAIM ONLY. Replaces the per-phase gates from #59/#61/#64
  //   (a DRIVE-loop check, a DISPATCH-loop check, and the kill-switch tier of evaluateCeiling).
  //   Two things run; everything else is blocked:
  //     1. TERMINAL-state reclaim (Codex PR #72 P2): a lane that already wrote .handoff/.done/
  //        .failed has FINISHED draining — record its real outcome (via reclaimTerminalLane) so
  //        it isn't rotted as `running` and then mislabeled `failed`/`needs-human` by the drain
  //        escalation below. This is part of draining, not new work.
  //     2. DRAIN of the still-running (KEEP) / crashed (DEAD, no sentinel) lanes: request
  //        handoffs and, past the bounded window, hard-kill + escalate (drainThenEscalate).
  //   Blocked: rollback retry, DRIVE/merge, DISPATCH, and the kill+requeue of DEAD lanes (all
  //   "new work"). Accepted trade-off (#69 policy: rare edges degrade to less machinery): a
  //   switch flipped MID-tick, after this check passed, takes effect at the next tick's gate.
  if (state.isKillSwitchActive()) {
    const reclaimed: ReclaimOutcome[] = [];
    for (const w of state.runningWorkers()) {
      const p = await supervisor.probe(w.name);
      const terminal = await reclaimTerminalLane(forge, state, supervisor, cfg, w, p, threshold, iso);
      if (terminal) reclaimed.push(terminal); // KEEP/DEAD lanes stay running -> drained below
    }
    // drainThenEscalate re-reads runningWorkers() AFTER the terminal reclaim above transitioned
    // those lanes out of `running`, so a just-recorded handoff/done lane is never re-touched.
    const { drainRequested, escalated } = await drainThenEscalate(
      forge, state, supervisor, cfg, ["kill-switch"], now(), iso,
    );
    return {
      reclaimed, dispatched: [], overBudget: false,
      ceilingBreached: true, ceilingReasons: ["kill-switch"],
      drainRequested, escalated, driven: [], rollbacks: [], gatedReclaimed: [],
    };
  }

  // ── PAUSE (#75) / stop-condition wind-down (#76): the gentle tier. Read ONCE here, at the
  //   tick boundary (never mid-phase) — the exact same "check next to the kill-switch gate,
  //   before anything else runs" rule the comment above documents, just without KILL's
  //   drain+freeze consequence. Unlike the kill switch, a paused tick does NOT return early:
  //   rollback retry, reclaim, and DRIVE (PR review/merge progression of lanes already in
  //   flight) all proceed exactly as normal below — only the DISPATCH phase (bottom of tick(),
  //   new-lane creation) is skipped when `paused` is true. Removing data/PAUSE restores
  //   dispatch on the very next tick with no restart, since this is a fresh existsSync check
  //   every call, never cached. `deps.forceDispatchPause` ORs into the same flag — the #76 loop
  //   driver sets it once a configured stop condition (afterIssuesMerged/afterPRsOpened/
  //   onMilestoneComplete) fires, converting the rest of the run into exactly this same
  //   dispatch-frozen wind-down until state.activeWorkers() drains to empty. Both sentinels
  //   present -> KILL_SWITCH already returned above, so this line is never reached — the
  //   stricter gate wins, unconditionally.
  const paused = state.isPauseActive() || (deps.forceDispatchPause ?? false);

  // ── ROLLBACK RETRY (#31): retry every board mutation still pending from a prior tick's
  //   recovery-path failure, BEFORE this tick does anything else. Never throws (see
  //   attemptRollback) — a still-failing forge only bumps the retry count or escalates.
  const rollbacks: RollbackOutcome[] = [];
  for (const pending of state.pendingRollbacks()) {
    rollbacks.push(await attemptRollback(forge, state, cfg, pending, iso));
  }
  const reclaimed: ReclaimOutcome[] = [];

  // ── RECLAIM: classify each in-flight lane from its 4 completion signals ──
  for (const w of state.runningWorkers()) {
    const p = await supervisor.probe(w.name);
    // Terminal sentinel (handoff/done/failed) -> record + transition out of `running`. Shared
    // with the kill-switch gate above; returns null for KEEP/DEAD, handled below.
    const terminal = await reclaimTerminalLane(forge, state, supervisor, cfg, w, p, threshold, iso);
    if (terminal) {
      reclaimed.push(terminal);
      continue;
    }
    // #47: the same {costUsd, modelUsage} pair feeds BOTH state.recordSpend (the #14 ledger)
    // and the reclaimed[] outcome — computed once so the two never drift apart.
    const costUsd = p.costUsd ?? 0;
    const modelUsage = p.modelUsage ?? [];
    if (classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive) === "KEEP") {
      reclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
      continue;
    }
    // DEAD: stale heartbeat or confirmed-dead wrapper with no sentinel. Always tear the lane
    // down (process-tree kill). If a PR was already opened, rescue it to `driving` rather than
    // requeuing — requeuing would let a second worker race the open PR (Codex R2 P1). Only a
    // dead lane with NO PR is handed back to Ready.
    // #69 dirty-worktree retention: reclaim() deletes the worktree ONLY when it's provably
    // clean; a possibly-dirty one survives on disk and is escalated to a human here.
    const r = await supervisor.reclaim(w.name);
    // #69 P1 (Codex PR #72): a retained (possibly-dirty) worktree means INCOMPLETE work that
    // needs human salvage — the lane must leave the auto-drive path ENTIRELY, even with an
    // open PR. The merge gate reads the PR's OWN labels (getPRReviewData), not the source
    // issue's, so a `driving` rescue would let that incomplete PR auto-merge while the WIP
    // waits for a human. So a retained worktree OVERRIDES the has-PR rescue: mark the lane
    // failed (never driving -> DRIVE never sees it) and land `needs-human` where the gate
    // looks — on the PR too, when its number is known.
    const rescued = p.hasPr && !r.worktreeRetained;
    if (r.worktreeRetained) {
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);
      await reportRetainedWorktree(forge, state, w.name, w.issue, r.worktreePath);
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      // No requeue to Ready: an open PR must not be raced by a fresh worker, and a no-PR dirty
      // lane is a human-salvage case (needs-human already blocks re-dispatch), not a clean
      // re-dispatch. The retained worktree + needs-human hold it for human triage.
    } else if (rescued) {
      state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
    } else {
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      // #31 (finding 2): persist the requeue BEFORE attempting it. The old code awaited this
      // unguarded AFTER the row above already went terminal — a transient forge failure here
      // used to propagate straight out of tick() with the worker row already `failed` and the
      // board still "In Progress": unreclaimable (runningWorkers() no longer sees it) and
      // un-requeueable (nothing ever retried the board mutation). Persisting first + attempting
      // via attemptRollback (never throws) means a failure here is retried by a later tick's
      // ROLLBACK RETRY phase instead of stranding it.
      const rollbackId = state.addPendingRollback(w.issue, "ready", "dead-lane-requeue", iso());
      rollbacks.push(
        await attemptRollback(
          forge, state, cfg,
          { id: rollbackId, issue: w.issue, target: "ready", reason: "dead-lane-requeue", attempts: 0 },
          iso,
        ),
      );
    }
    // Usually 0 (a DEAD lane has no terminal sentinel to parse a cost from) but record whatever
    // the probe knows — harmless, and future probes may recover a partial cost.
    state.recordSpend(w.name, w.issue, costUsd, iso(), modelUsage);
    state.appendEvent("reclaim-dead", { worker: w.name, issue: w.issue, rescued });
    reclaimed.push({ kind: "dead", worker: w.name, issue: w.issue, rescued, costUsd, modelUsage });
  }

  // ── GATED RECLAIM (#147): a failed lane that DRIVE escalated (gate②/mergeDecision
  //   needs-human — the ONLY "failed + a PR number" shape, see gatedFailedWorkers' doc) whose
  //   ISSUE no longer carries needs-human is a human's EXPLICIT act (PLAN.md autonomy
  //   principle: only an explicit human act re-admits automation) that the finding was
  //   addressed. Reclaim it straight back to `driving` — same worker row, same PR/branch, no
  //   new dispatch (Ref #122 live-run report: re-dispatch would spawn a fresh worker/branch
  //   against a stale head, the squash-branch-reuse hazard this exists to avoid) — and let the
  //   ORDINARY DRIVE loop just below re-drive it exactly like any other driving lane. Clearing
  //   the recorded trigger pin makes driveOne treat the (unchanged) head as never-triggered, so
  //   it posts a FRESH review trigger even with no new push — reusing driveOne's own re-trigger
  //   machinery rather than building a parallel one. Bounded by cfg.lanes.gatedReentryCap (the
  //   prFixCap pattern): spent attempts + another label removal -> re-escalate, latch
  //   permanently (gatedReentryDecision's CAPPED branch), never retried forever. Runs BEFORE
  //   DRIVE (same tick sees the reclaim) and regardless of `paused` (#75: pause only freezes
  //   NEW dispatch — this never spawns a worker, so it's reclaim/drive continuation, not new
  //   work). Skipped entirely without a mergeGate (mirrors DRIVE: reentry with nothing to drive
  //   through would just strand the lane in `driving`).
  const gate = deps.mergeGate;
  const gatedReclaimed: GatedReclaimOutcome[] = [];
  if (gate) {
    for (const w of state.gatedFailedWorkers()) {
      if (w.pr == null) continue; // fail-safe; gatedFailedWorkers() already filters this
      const pr = w.pr;
      const labels = await forge.getIssueLabels(w.issue);
      const attempts = w.gated_reentry_attempts ?? 0;
      const decision = gatedReentryDecision(
        labels.includes(cfg.labels.needsHuman), attempts, cfg.lanes.gatedReentryCap,
      );
      if (decision === "SKIP") continue; // still escalated — no human action yet
      if (decision === "CAPPED") {
        // The cap was already spent on a prior reclaim that re-escalated, and a human removed
        // needs-human again anyway — refuse to retry forever: re-add the label, leave an
        // explicit trail, and latch so this row is never reconsidered again.
        //
        // ORDERING (#147 round-3 P2, Codex PR #151 — the #69 fable-P2a rule: ALL forge work
        // BEFORE the terminal upsert): the label goes FIRST, and the permanent latch is
        // persisted ONLY once the label provably landed. Latching first would make a transient
        // label failure permanent — the row leaves gatedFailedWorkers() forever while
        // needs-human was never restored, so the exhausted PR becomes invisible to BOTH
        // automation and human triage. On a label failure: record the error durably, do NOT
        // latch, do NOT emit a capped outcome — the row stays eligible (label still absent,
        // attempts >= cap), so the next tick's GATED RECLAIM re-enters this branch and retries
        // the label until it succeeds (the same retry-until-success shape as the rollback
        // machinery; gatedReentryDecision stays CAPPED throughout, so no extra reclaim can
        // slip through while retrying).
        try {
          await forge.addLabel(w.issue, cfg.labels.needsHuman);
        } catch (e) {
          state.appendEvent("gated-reentry-capped-label-failed", {
            worker: w.name, issue: w.issue, pr, attempts, error: String(e),
          });
          continue;
        }
        // Best-effort courtesy notice — the label above is the load-bearing block; a comment
        // hiccup must not strand the latch.
        await forge
          .addIssueComment(
            w.issue,
            `sapwood: gated-PR reentry cap (${cfg.lanes.gatedReentryCap}) reached for PR #${pr} — ` +
              `re-applying \`${cfg.labels.needsHuman}\`. Automatic reentry is exhausted for this ` +
              `PR; merge it by hand once it's ready.`,
          )
          .catch(() => {});
        state.upsertWorker({ ...w, ended_at: iso(), gated_reentry_capped: 1 });
        state.appendEvent("gated-reentry-capped", { worker: w.name, issue: w.issue, pr, attempts });
        gatedReclaimed.push({ kind: "capped", worker: w.name, issue: w.issue, pr, attempts });
        continue;
      }
      // RECLAIM: back to `driving`, same worker/PR — the DRIVE loop below picks it up this tick.
      const attempt = attempts + 1;
      state.upsertWorker({
        ...w, state: "driving", ended_at: iso(),
        review_triggered_head: null, review_triggered_at: null,
        gated_reentry_attempts: attempt,
      });
      state.appendEvent("gated-reentry", { worker: w.name, issue: w.issue, pr, attempt });
      gatedReclaimed.push({ kind: "reclaimed", worker: w.name, issue: w.issue, pr, attempt });
    }
  }

  // ── DRIVE (#13): a DONE+PR lane is "driving" (awaiting gate①/gate②). producer != merger is
  //   preserved structurally: tick() never calls forge.mergePR itself — that lives one level
  //   down, in deps.mergeGate.driveOne (merge-driver.ts), invoked ONLY from here. Omitted
  //   mergeGate -> driving lanes stay driving with no gate/merge activity (pre-#13 behavior).
  const driven: DrivenOutcome[] = [];
  if (gate) {
    // #69: no per-lane kill-switch re-check here — an active switch never reaches this loop
    // at all (the global gate at the top of tick() returns first). See the gate's comment for
    // the accepted mid-tick trade-off.
    for (const w of state.drivingWorkers()) {
      if (w.pr == null) {
        // Fail-safe: a driving lane MUST carry a PR number (set at the reclaim transition
        // above) to be driven through gates. Its absence here (only checked once a mergeGate
        // is actually configured) is a bug, not a normal state — escalate rather than stall.
        state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
        state.appendEvent("drive-no-pr", { worker: w.name, issue: w.issue });
        driven.push({ kind: "needs-human", worker: w.name, issue: w.issue, pr: -1, reason: "driving-lane-missing-pr" });
        continue;
      }
      const pr = w.pr;
      // #55 P1-B: the trigger decision now lives in gate.driveOne itself (it's the only place
      // that knows the LIVE current head) — tick() just threads the lane's State-recorded pin
      // in and wires driveOne's recordTrigger callback straight back into State. #54: same
      // pattern for the reviewer-failover lock (state.ts workers.review_fallback_head/kind).
      // The persisted kind is VALIDATED here, at the read boundary (#54 R2, fable-review P2):
      // the state DB is outside the guard write boundary, so a forged/corrupt kind string must
      // fail closed to no-lock — it is never cast through. (Defense-in-depth: even a valid
      // kind is only advisory — resolveReviewVerdict re-verifies the approval artifact against
      // live PR data before it can gate anything.)
      const storedKind = w.review_fallback_kind ?? null;
      const lockKind = isReviewerKind(storedKind) ? storedKind : null;
      const outcome = await gate.driveOne(
        pr,
        w.issue,
        { head: w.review_triggered_head ?? null, at: w.review_triggered_at ?? null },
        (head, at) => state.recordReviewTrigger(w.name, head, at),
        {
          lock: { head: lockKind ? (w.review_fallback_head ?? null) : null, kind: lockKind },
          recordFallback: (lock) => state.recordReviewFallback(w.name, lock.head, lock.kind),
        },
        // #147 P1: a GATED-RECLAIM-re-entered lane's gate② must not be satisfied by the stale
        // pre-escalation review still sitting on the (unchanged) head — driveOne filters to
        // post-re-entry review signals when this is set.
        (w.gated_reentry_attempts ?? 0) > 0,
      );
      // #54: announce a reviewer-failover switch/revert — structured event + PR comment.
      // driveOne reports the signal STATELESSLY every tick it holds (resolveReviewVerdict is
      // pure), so dedup happens here against the durable event log: announce only when
      // (kind, mode, pr, head) differs from the lane's last announcement. One announcement per
      // episode transition, restart-safe, no per-tick comment spam (e.g. produce-pr-and-stop
      // holds a lane driving for many ticks after a revert).
      if (outcome.reviewerTransition) {
        const t = outcome.reviewerTransition;
        const evKind = `reviewer-fallback-${t.kind}`;
        const last = state.lastReviewerFallbackEvent(w.name);
        const alreadyAnnounced =
          last != null && last.kind === evKind && last.mode === t.mode && last.pr === pr && last.head === t.head;
        if (!alreadyAnnounced) {
          state.appendEvent(evKind, { worker: w.name, issue: w.issue, pr, mode: t.mode, head: t.head });
          const note =
            t.kind === "switch"
              ? `⚠️ Reviewer failover (#54): the primary reviewer has been unavailable past the ` +
                `configured threshold — gate② is now gated by **${t.mode}** until it recovers.`
              : `✅ Reviewer failover (#54): the primary reviewer is available again — gate② is ` +
                `gated by **${t.mode}** for new verdicts.`;
          // Best-effort courtesy copy of the audit trail: the structured event above is the
          // durable record and has already landed; a comment-post hiccup must not crash the
          // DRIVE loop or mark the lane failed over an announcement.
          await forge.addPRComment(pr, note).catch(() => {});
        }
      }
      switch (outcome.kind) {
        case "merged":
          state.upsertWorker({ ...w, state: "done", ended_at: iso() });
          await forge.setBoardStatus(w.issue, "done");
          state.appendEvent("merged", { worker: w.name, issue: w.issue, pr, headOid: outcome.headOid });
          driven.push({ kind: "merged", worker: w.name, issue: w.issue, pr });
          break;
        case "needs-human": {
          // #147 P2 (Codex PR #151): the label write goes FIRST, and its success is recorded
          // durably on the terminal row (gated_escalation_labeled) — because GATED RECLAIM's
          // re-entry signal is "the needs-human label is ABSENT", absence is only evidence of a
          // human act if the engine provably APPLIED the label. The old order (upsert failed,
          // then an unguarded addLabel) let a transient label failure leave a failed+PR row
          // with no label, which the next tick would read as an explicit human removal —
          // automation re-admitting itself with no human in the loop. A failed label write is
          // contained (the escalation itself — terminal transition + structured event — always
          // lands, same #69 P2a stance as the drain path) and marks the row labeled=0:
          // permanently invisible to GATED RECLAIM (fail-closed — the pre-#147 manual-drive
          // situation, no regression), with the error in the event payload, never a silent
          // swallow.
          let labeled = 1;
          let labelError: string | null = null;
          try {
            await forge.addLabel(w.issue, cfg.labels.needsHuman);
          } catch (e) {
            labeled = 0;
            labelError = String(e);
          }
          state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: labeled });
          state.appendEvent("drive-needs-human", {
            worker: w.name, issue: w.issue, pr, reason: outcome.reason, labeled,
            ...(labelError != null ? { labelError } : {}),
          });
          // #147: gated_reentry_attempts > 0 means this lane was reclaimed by GATED RECLAIM at
          // least once (a human removed needs-human believing the finding was fixed) and STILL
          // escalated — leave the attempt trail on the issue so a repeat escalation isn't
          // indistinguishable from the very first one. Never fires for a first-time escalation
          // (attempts is 0 for every lane that's never been through GATED RECLAIM).
          const gatedAttempts = w.gated_reentry_attempts ?? 0;
          if (gatedAttempts > 0) {
            const cap = cfg.lanes.gatedReentryCap;
            await forge
              .addIssueComment(
                w.issue,
                `sapwood: gated-PR reentry attempt ${gatedAttempts}/${cap} for PR #${pr} ` +
                  `re-escalated \`${cfg.labels.needsHuman}\` — ${outcome.reason}. ` +
                  (gatedAttempts >= cap
                    ? `That was the last automatic attempt; a further reentry will be rejected.`
                    : `Remove \`${cfg.labels.needsHuman}\` again once it's addressed to retry.`),
              )
              .catch(() => {});
          }
          driven.push({ kind: "needs-human", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          break;
        }
        case "queued":
          // Stays driving — retried next tick. Covers gate-pending (WAIT), a review-unavailable
          // (rate-limit/timeout) signal (#13 requires the latter to queue, never skip/soften
          // gate②), and a freshly-posted review trigger (#55 P1-B "review-triggered" — the pin
          // was just recorded into State above; next tick re-reads it and proceeds to gating).
          state.appendEvent("drive-queued", { worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          break;
        case "stopped":
          // produce-pr-and-stop: gates passed but the driver never merges. Stays driving so a
          // human sees it (sapwood status / the PR itself) and merges by hand.
          state.appendEvent("drive-stopped", { worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          driven.push({ kind: "stopped", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          break;
      }
    }
  }

  // ── CEILING (#14): engine-wide hard safety boundary, orthogonal to the per-round
  //   overBudget check below. Any breach (daily USD cap / wall-clock cap) freezes ALL new
  //   dispatch this tick and starts (or continues) the bounded drain -> escalate sequence
  //   (see drainThenEscalate). The kill switch is NOT evaluated here anymore — it's the
  //   global gate at the top of tick() (#69).
  //   NOTE the daily cap is POST-HOC, not a real-time cutoff: spend is only known at worker
  //   completion (stream-json carries no in-flight cost), so still-running lanes contribute
  //   nothing until they finish and the cap trips on the completion that crosses it. Max
  //   overshoot ≈ concurrent lanes × per-worker spend — bounded in practice by
  //   lanes.roundDispatchCap (default 2) × worker.budgetUsdSoft, plus the wall-clock tier. ──
  const nowDate = now();
  const ceilingReasons = evaluateCeiling({
    dailySpendUsd: state.dailySpendUsd(nowDate),
    dailyBudgetUsd: cfg.cost.dailyBudgetUsd,
    wallClockElapsedSec:
      (nowDate.getTime() -
        state.engineSessionStart(nowDate, engineSessionGapSec(deps.tickIntervalSec ?? 0)).getTime()) / 1000,
    maxWallClockSec: cfg.cost.maxWallClockSec,
  });
  const ceilingBreached = ceilingReasons.length > 0;
  let drainRequested: string[] = [];
  let escalated: string[] = [];
  if (ceilingBreached) {
    ({ drainRequested, escalated } = await drainThenEscalate(
      forge, state, supervisor, cfg, ceilingReasons, nowDate, iso,
    ));
  } else {
    // Resolved (daily cap rolled to a fresh day / wall-clock cfg raised / kill switch
    // lifted before this tick) -> clear so a future re-breach starts a fresh drain window.
    state.clearCeilingBreach();
  }

  // ── DISPATCH: fill free lanes from the Ready queue, by priority, within caps + budget ──
  //   #75: skipped entirely while `paused` — no new lane dispatch, not even "skipped" rows
  //   (mirrors the kill-switch tick's dispatched: [] — see its test comment). overBudget is
  //   still reported (cheap, dispatch-independent — just deps.roundSpendUsd vs. the cap), but
  //   nothing below it runs: no Ready-queue read, no claim, no worker spawn.
  const dispatched: DispatchOutcome[] = [];
  const overBudget = budgetExceeded(deps.roundSpendUsd ?? 0, cfg.cost.roundBudgetUsd);
  if (!paused) {
    // Capacity counts running + driving lanes: a driving lane holds a PR awaiting the review
    // gate and must keep occupying a lane, else reclaiming a PR-producing worker would free a
    // slot and over-fill past cfg.lanes.max (Codex R2 P2). Re-read post-reclaim.
    const active = state.activeWorkers();
    const inFlightIssues = new Set(active.map((w) => w.issue));
    let lanesUsed = active.length;
    let dispatchedThisTick = 0;
    let metaUsed = 0; // meta-rank (<=2) lanes taken this tick — anti-starvation accounting

    const order = orderForDispatch(await forge.getReadyIssues(), cfg);
    for (const issue of order) {
      // The #14 engine ceiling outranks every other dispatch reason: a breach freezes ALL new
      // dispatch, not just the ones that happen to also be over the (separate) round budget.
      if (ceilingBreached) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "ceiling" });
        continue;
      }
      if (inFlightIssues.has(issue.number)) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "in-flight" });
        continue;
      }
      if (overBudget) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "over-budget" });
        continue;
      }
      if (dispatchedThisTick >= cfg.lanes.roundDispatchCap) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "cap" });
        continue;
      }
      if (lanesUsed >= cfg.lanes.max) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "no-lane" });
        continue;
      }
      // Anti-starvation: a meta-rank issue must yield a reserved coding lane while coding
      // work is still waiting (codingFloor of cfg.lanes.max lanes are reserved for coding).
      const rank = issuePriority(issue.labels);
      if (!isCodingRank(rank)) {
        const codingWaiting = order.filter(
          (o) => isCodingRank(issuePriority(o.labels)) && !inFlightIssues.has(o.number),
        ).length;
        if (!metaLaneAllowed(cfg.lanes.max, metaUsed, codingWaiting)) {
          dispatched.push({ kind: "skipped", issue: issue.number, reason: "meta-floor" });
          continue;
        }
      }
      // #69: no per-issue kill-switch re-check here (the #61/#64 mid-loop guard) — an active
      // switch never reaches this loop; see the global gate at the top of tick(). #75: same
      // reasoning applies to pause — `paused` is captured once at the top of tick(), not
      // re-read per issue.
      // Claim BEFORE launching (matches 0day claim_issue.sh order). The board transition
      // takes the issue out of the Ready lane first, so a launch failure can't leave an
      // untracked worker running while the issue stays dispatchable (Codex P1, PR #30). If
      // the launch fails after the claim, roll the board back to Ready so it's reclaimable.
      await forge.claimIssue(issue.number);
      let dispatchRes: { name: string; sessionId: string };
      try {
        dispatchRes = await supervisor.dispatch(issue);
      } catch (e) {
        state.appendEvent("dispatch-failed", { issue: issue.number, error: String(e) });
        // #31 (finding 1): persist the rollback BEFORE attempting it. The dispatch error `e` is
        // the one that propagates (unchanged contract — this tick rejects), but the rollback
        // itself must never be a bare `.catch(() => {})` swallow: if it also fails, the durable
        // pending_rollbacks row (not the discarded catch) is what lets a later tick's ROLLBACK
        // RETRY phase notice and keep retrying, instead of the issue being stranded In Progress
        // with no worker row and no trace of the failed recovery attempt.
        const rollbackId = state.addPendingRollback(issue.number, "ready", "dispatch-rollback", iso());
        await attemptRollback(
          forge, state, cfg,
          { id: rollbackId, issue: issue.number, target: "ready", reason: "dispatch-rollback", attempts: 0 },
          iso,
        );
        throw e;
      }
      const { name, sessionId } = dispatchRes;
      state.upsertWorker({
        name, issue: issue.number, session_id: sessionId, state: "running",
        started_at: iso(), ended_at: null,
      });
      state.appendEvent("dispatched", { worker: name, issue: issue.number });
      inFlightIssues.add(issue.number);
      lanesUsed++;
      dispatchedThisTick++;
      if (!isCodingRank(rank)) metaUsed++;
      dispatched.push({ kind: "dispatched", issue: issue.number, worker: name });
    }
  } // !paused (#75)

  return {
    reclaimed, dispatched, overBudget, ceilingBreached, ceilingReasons, drainRequested, escalated,
    driven, rollbacks, gatedReclaimed,
  };
}
