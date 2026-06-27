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
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";

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

/** Lowest prio:N-* rank across labels (0..4, low = higher priority). No prio label -> 3. */
export function issuePriority(labels: string[]): number {
  let min = 5; // sentinel: no prio label found
  for (const tok of labels) {
    const m = /^prio:([0-4])-/.exec(tok);
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
// injected (IForge, Supervisor, State) so the whole tick is unit-testable without ever
// spawning a real `claude` or calling `gh`. producer != merger: the tick never merges
// (no worker self-merge); the merge gate (reviewer + merge-driver) is M3.
// ─────────────────────────────────────────────────────────────────────────────

/** The 4-signal snapshot of one in-flight lane (sentinels + heartbeat + pid). Worker domain. */
export interface LaneProbe {
  done: boolean;
  failed: boolean;
  handoff: boolean; // soft-budget graceful handoff sentinel: resumable, do NOT kill
  hbAge: number; // seconds since heartbeat mtime; -1 if no heartbeat file yet (just spawned)
  wrapperAlive: -1 | 0 | 1; // 1 alive | 0 confirmed dead (kill -0 failed) | -1 unknown
  hasPr: boolean; // an open PR exists for this lane's issue
}

/** The conductor's only handle on workers. worker.ts (M2 #11) implements this. */
export interface Supervisor {
  probe(worker: string): Promise<LaneProbe>;
  dispatch(issue: Issue): Promise<{ name: string; sessionId: string }>;
  reclaim(worker: string): Promise<void>; // tear down a dead/stale lane (process-tree kill + cleanup)
}

export type ReclaimOutcome =
  | { kind: "kept"; worker: string; issue: number }
  | { kind: "done"; worker: string; issue: number; next: ReclaimDone }
  | { kind: "failed"; worker: string; issue: number; next: ReclaimFailed }
  | { kind: "handoff"; worker: string; issue: number }
  | { kind: "dead"; worker: string; issue: number };

export type DispatchOutcome =
  | { kind: "dispatched"; issue: number; worker: string }
  | { kind: "skipped"; issue: number; reason: "cap" | "no-lane" | "in-flight" | "over-budget" | "meta-floor" };

export interface TickResult {
  reclaimed: ReclaimOutcome[];
  dispatched: DispatchOutcome[];
  overBudget: boolean;
}

export interface TickDeps {
  forge: IForge;
  state: State;
  supervisor: Supervisor;
  cfg: SapwoodConfig;
  /** Cumulative round spend (USD) for the hard round-budget gate. Worker cost sum; caller
   *  computes it from stream-json (worker.ts). Default 0 (no spend known yet). */
  roundSpendUsd?: number;
  now?: () => Date;
}

/**
 * Dispatchable Ready issues, ordered (priority asc, number asc). Filters out reserve /
 * needs-human (held for human triage) and any issue carrying a blocked-by label.
 * ponytail: blocked-by issues are skipped while the label is present; re-checking the
 * blocker's OPEN/CLOSED state (to auto-unblock once it closes) is an M3 refinement — for
 * now triage removes the label. Avoids an extra gh round-trip per blocker per tick.
 */
export function orderForDispatch(ready: Issue[], cfg: SapwoodConfig): Issue[] {
  const reserveish = [cfg.labels.reserve, cfg.labels.needsHuman];
  return ready
    .filter((i) => !hasReserveLabel(i.labels, reserveish))
    .filter((i) => labelsBlockers(i.labels).length === 0)
    .map((i) => ({ i, rank: issuePriority(i.labels) }))
    .sort((a, b) => a.rank - b.rank || a.i.number - b.i.number)
    .map((x) => x.i);
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge, state, supervisor, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const threshold = cfg.worker.heartbeatStaleSecs;
  const reclaimed: ReclaimOutcome[] = [];

  // ── RECLAIM: classify each in-flight lane from its 4 completion signals ──
  for (const w of state.runningWorkers()) {
    const p = await supervisor.probe(w.name);
    if (p.handoff) {
      // Soft-budget graceful handoff: terminal-but-resumable. Never killed; the conductor
      // may --resume later. Checked before classifyLane (a handoff is not a failure).
      state.upsertWorker({ ...w, state: "handoff", ended_at: iso() });
      state.appendEvent("handoff", { worker: w.name, issue: w.issue });
      reclaimed.push({ kind: "handoff", worker: w.name, issue: w.issue });
      continue;
    }
    const cls = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive);
    if (cls === "KEEP") {
      reclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
    } else if (cls === "DONE") {
      const next = laneOnReclaimDone(p.hasPr);
      state.upsertWorker({ ...w, state: "done", ended_at: iso() });
      if (next === "ESCALATE_NOPR") await forge.addLabel(w.issue, cfg.labels.needsHuman);
      state.appendEvent("reclaim-done", { worker: w.name, issue: w.issue, next });
      reclaimed.push({ kind: "done", worker: w.name, issue: w.issue, next });
    } else if (cls === "FAILED") {
      const next = laneOnReclaimFailed(p.hasPr);
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      if (next === "ESCALATE") await forge.addLabel(w.issue, cfg.labels.needsHuman);
      state.appendEvent("reclaim-failed", { worker: w.name, issue: w.issue, next });
      reclaimed.push({ kind: "failed", worker: w.name, issue: w.issue, next });
    } else {
      // DEAD: stale heartbeat or confirmed-dead wrapper with no sentinel. Tear the lane
      // down (process-tree kill + cleanup) and hand the issue back to the Ready lane.
      await supervisor.reclaim(w.name);
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      await forge.setBoardStatus(w.issue, "ready");
      state.appendEvent("reclaim-dead", { worker: w.name, issue: w.issue });
      reclaimed.push({ kind: "dead", worker: w.name, issue: w.issue });
    }
  }

  // ── DRIVE: a DONE+PR lane is now "driving" (awaiting the review gate). The gate->merge
  //   step (reviewer.ts + merge-driver.ts) is M3; M2 stops at produce-PR. No merge here —
  //   producer != merger is preserved structurally (the tick never calls forge.mergePR).

  // ── DISPATCH: fill free lanes from the Ready queue, by priority, within caps + budget ──
  const dispatched: DispatchOutcome[] = [];
  const overBudget = budgetExceeded(deps.roundSpendUsd ?? 0, cfg.cost.roundBudgetUsd);
  const inFlightIssues = new Set(state.runningWorkers().map((w) => w.issue)); // re-read post-reclaim
  let lanesUsed = inFlightIssues.size;
  let dispatchedThisTick = 0;
  let metaUsed = 0; // meta-rank (<=2) lanes taken this tick — anti-starvation accounting

  const order = orderForDispatch(await forge.getReadyIssues(), cfg);
  for (const issue of order) {
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
    const { name, sessionId } = await supervisor.dispatch(issue);
    await forge.claimIssue(issue.number);
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

  return { reclaimed, dispatched, overBudget };
}
