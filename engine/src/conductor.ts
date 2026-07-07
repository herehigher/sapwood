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
import type { State, BoardStatus, PendingRollback } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { DriveOutcome } from "./merge-driver.js";

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
// Engine cost ceiling + kill switch (#14, M3 Security model "hard engine ceiling").
// Two-tier cost control: worker.budgetUsdSoft is a per-worker graceful handoff (never a
// mid-work kill, see worker.ts requestHandoff). This is the OTHER tier — an engine-wide,
// aggregate-across-workers safety boundary: a cumulative daily USD cap + a wall-clock cap,
// plus an out-of-band kill switch (a file sentinel only the engine can write — see
// State.isKillSwitchActive). Any one of the three freezes ALL new dispatch and starts a
// bounded drain (graceful handoff of running workers) before escalating to a hard kill.
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

/** Pure ceiling check. Order is fixed (kill-switch, daily-budget, wall-clock) so multiple
 *  simultaneous breaches report deterministically; empty array = no breach. */
export function evaluateCeiling(input: {
  dailySpendUsd: number;
  dailyBudgetUsd: number;
  wallClockElapsedSec: number;
  maxWallClockSec: number;
  killSwitchActive: boolean;
}): CeilingReason[] {
  const reasons: CeilingReason[] = [];
  if (input.killSwitchActive) reasons.push("kill-switch");
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
}

/** The conductor's only handle on workers. worker.ts (M2 #11) implements this. */
export interface Supervisor {
  probe(worker: string): Promise<LaneProbe>;
  dispatch(issue: Issue): Promise<{ name: string; sessionId: string }>;
  reclaim(worker: string): Promise<void>; // tear down a dead/stale lane (process-tree kill + cleanup)
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
  /** Post the review trigger at most once per PR; idempotent to call again (a plain comment). */
  ensureTriggered(pr: number): Promise<void>;
  /** One gate + merge attempt for `pr`. Never throws (see merge-driver.ts). */
  driveOne(pr: number): Promise<DriveOutcome>;
}

export type DrivenOutcome =
  | { kind: "merged"; worker: string; issue: number; pr: number }
  | { kind: "needs-human"; worker: string; issue: number; pr: number; reason: string }
  | { kind: "queued"; worker: string; issue: number; pr: number; reason: string }
  | { kind: "stopped"; worker: string; issue: number; pr: number; reason: string };

export type ReclaimOutcome =
  | { kind: "kept"; worker: string; issue: number }
  | { kind: "done"; worker: string; issue: number; next: ReclaimDone }
  | { kind: "failed"; worker: string; issue: number; next: ReclaimFailed }
  | { kind: "handoff"; worker: string; issue: number }
  | { kind: "dead"; worker: string; issue: number; rescued: boolean };

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

export interface TickResult {
  reclaimed: ReclaimOutcome[];
  dispatched: DispatchOutcome[];
  overBudget: boolean;
  /** #14 engine ceiling: daily USD cap / wall-clock cap / kill switch. Any breach freezes
   *  ALL new dispatch this tick (every ready issue skipped with reason "ceiling") regardless
   *  of lanes/caps/budget below. */
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

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge, state, supervisor, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const threshold = cfg.worker.heartbeatStaleSecs;

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
    if (p.handoff) {
      // Soft-budget graceful handoff: terminal-but-resumable. Never killed; the conductor
      // may --resume later. Checked before classifyLane (a handoff is not a failure).
      state.upsertWorker({ ...w, state: "handoff", ended_at: iso() });
      // M4 --resume TRAP (gate② PR #41 P3): this records the handed-off run's
      // total_cost_usd. If this lane is later resumed and claude reports CUMULATIVE
      // total_cost_usd for the resumed session, recording the resumed run's total again at
      // its terminal transition double-counts the pre-handoff portion — fail-SAFE for the
      // cap (over-counts) but corrupts accounting. Whoever wires --resume (M4) must record
      // the delta, or verify claude's resume cost semantics first.
      state.recordSpend(w.name, w.issue, p.costUsd ?? 0, iso());
      state.appendEvent("handoff", { worker: w.name, issue: w.issue });
      reclaimed.push({ kind: "handoff", worker: w.name, issue: w.issue });
      continue;
    }
    const cls = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive);
    if (cls === "KEEP") {
      reclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
    } else if (cls === "DONE") {
      const next = laneOnReclaimDone(p.hasPr);
      if (next === "DRIVING") {
        // PR produced: hold the lane in `driving` (it still occupies a lane until the #13
        // review gate resolves it). No requeue, no human escalation.
        state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
      } else {
        // ESCALATE_NOPR: done but no PR -> nothing to drive; free the lane, escalate to human.
        state.upsertWorker({ ...w, state: "done", ended_at: iso() });
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
      }
      // Completed-run cost becomes known exactly once, here — record it into the #14
      // engine-ceiling ledger regardless of which branch (DRIVING or ESCALATE_NOPR) fired.
      state.recordSpend(w.name, w.issue, p.costUsd ?? 0, iso());
      state.appendEvent("reclaim-done", { worker: w.name, issue: w.issue, next });
      reclaimed.push({ kind: "done", worker: w.name, issue: w.issue, next });
    } else if (cls === "FAILED") {
      const next = laneOnReclaimFailed(p.hasPr);
      if (next === "DRIVING") {
        // Failed but a clean PR exists (e.g. budget-exhausted after opening it): rescue —
        // hold the lane driving for the review gate rather than escalating.
        state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
      } else {
        state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
      }
      state.recordSpend(w.name, w.issue, p.costUsd ?? 0, iso());
      state.appendEvent("reclaim-failed", { worker: w.name, issue: w.issue, next });
      reclaimed.push({ kind: "failed", worker: w.name, issue: w.issue, next });
    } else {
      // DEAD: stale heartbeat or confirmed-dead wrapper with no sentinel. Always tear the
      // lane down (process-tree kill + cleanup). If a PR was already opened, rescue it to
      // `driving` rather than requeuing — requeuing would let a second worker race the open
      // PR (Codex R2 P1). Only a dead lane with NO PR is handed back to Ready.
      await supervisor.reclaim(w.name);
      const rescued = p.hasPr;
      if (rescued) {
        state.upsertWorker({ ...w, state: "driving", ended_at: iso(), pr: p.prNumber ?? w.pr ?? null });
      } else {
        state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
        // #31 (finding 2): persist the requeue BEFORE attempting it. The old code awaited
        // this unguarded AFTER the row above already went terminal — a transient forge
        // failure here used to propagate straight out of tick() with the worker row already
        // `failed` and the board still "In Progress": unreclaimable (runningWorkers() no
        // longer sees it) and un-requeueable (nothing ever retried the board mutation).
        // Persisting first + attempting via attemptRollback (never throws) means a failure
        // here is retried by a later tick's ROLLBACK RETRY phase instead of stranding it.
        const rollbackId = state.addPendingRollback(w.issue, "ready", "dead-lane-requeue", iso());
        rollbacks.push(
          await attemptRollback(
            forge, state, cfg,
            { id: rollbackId, issue: w.issue, target: "ready", reason: "dead-lane-requeue", attempts: 0 },
            iso,
          ),
        );
      }
      // Usually 0 (a DEAD lane has no terminal sentinel to parse a cost from) but record
      // whatever the probe knows — harmless, and future probes may recover a partial cost.
      state.recordSpend(w.name, w.issue, p.costUsd ?? 0, iso());
      state.appendEvent("reclaim-dead", { worker: w.name, issue: w.issue, rescued });
      reclaimed.push({ kind: "dead", worker: w.name, issue: w.issue, rescued });
    }
  }

  // ── DRIVE (#13): a DONE+PR lane is "driving" (awaiting gate①/gate②). producer != merger is
  //   preserved structurally: tick() never calls forge.mergePR itself — that lives one level
  //   down, in deps.mergeGate.driveOne (merge-driver.ts), invoked ONLY from here. Omitted
  //   mergeGate -> driving lanes stay driving with no gate/merge activity (pre-#13 behavior).
  const driven: DrivenOutcome[] = [];
  const gate = deps.mergeGate;
  if (gate) {
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
      if (!w.review_triggered) {
        await gate.ensureTriggered(pr);
        state.upsertWorker({ ...w, review_triggered: 1 });
      }
      const outcome = await gate.driveOne(pr);
      switch (outcome.kind) {
        case "merged":
          state.upsertWorker({ ...w, state: "done", ended_at: iso() });
          await forge.setBoardStatus(w.issue, "done");
          state.appendEvent("merged", { worker: w.name, issue: w.issue, pr, headOid: outcome.headOid });
          driven.push({ kind: "merged", worker: w.name, issue: w.issue, pr });
          break;
        case "needs-human":
          state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
          await forge.addLabel(w.issue, cfg.labels.needsHuman);
          state.appendEvent("drive-needs-human", { worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          driven.push({ kind: "needs-human", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          break;
        case "queued":
          // Stays driving — retried next tick. Covers gate-pending (WAIT) AND a
          // review-unavailable (rate-limit/timeout) signal: #13 requires the latter to queue,
          // never skip/soften gate②.
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
  //   overBudget check below. Any breach (daily USD cap / wall-clock cap / kill switch)
  //   freezes ALL new dispatch this tick and starts (or continues) a bounded drain: running
  //   workers are asked to hand off gracefully; only after cfg.cost.drainWindowSec with no
  //   resolution does the conductor escalate to the hard process-tree kill. Drain before
  //   kill, always (PLAN.md Security model).
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
    killSwitchActive: state.isKillSwitchActive(),
  });
  const ceilingBreached = ceilingReasons.length > 0;
  const drainRequested: string[] = [];
  const escalated: string[] = [];
  if (ceilingBreached) {
    // INSERT OR IGNORE: only the FIRST detection sets "at" — a still-breached engine must
    // not keep resetting its own drain-window clock tick after tick.
    state.recordCeilingBreach(ceilingReasons, nowDate);
    const stillRunning = state.runningWorkers();
    for (const w of stillRunning) {
      // Idempotent (worker.ts guards re-requests) — safe to call every tick while breached.
      if (supervisor.requestHandoff(w.name)) drainRequested.push(w.name);
    }
    const breach = state.ceilingBreach();
    if (breach && drainEscalationDue(breach.at.toISOString(), nowDate.getTime(), cfg.cost.drainWindowSec)) {
      // Bounded drain window elapsed with no resolution -> escalate to the hard kill
      // (reuses the same process-tree kill the DEAD-lane reclaim path uses above). Treated
      // like a dead lane: no PR-aware rescue here — this is a safety-ceiling breach, not a
      // liveness classification, so fail-safe to escalate + human triage.
      for (const w of stillRunning) {
        await supervisor.reclaim(w.name);
        state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
        state.appendEvent("ceiling-escalated", { worker: w.name, issue: w.issue, reasons: ceilingReasons });
        escalated.push(w.name);
      }
    }
  } else {
    // Resolved (kill switch lifted / daily cap rolled to a fresh day / wall-clock cfg
    // raised) -> clear so a future re-breach starts its own fresh drain window.
    state.clearCeilingBreach();
  }

  // ── DISPATCH: fill free lanes from the Ready queue, by priority, within caps + budget ──
  const dispatched: DispatchOutcome[] = [];
  const overBudget = budgetExceeded(deps.roundSpendUsd ?? 0, cfg.cost.roundBudgetUsd);
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

  return {
    reclaimed, dispatched, overBudget, ceilingBreached, ceilingReasons, drainRequested, escalated,
    driven, rollbacks,
  };
}
