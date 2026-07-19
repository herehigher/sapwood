// The conductor: the scheduler. One tick = reclaim -> drive -> resume -> dispatch.
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

import { existsSync } from "node:fs";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, Issue } from "../forge/forge.js";
import { labelsInclude, matchBlockedByLabel, matchPriorityLabel } from "../forge/labels.js";
import type { DriveOutcome } from "../roles/merge-driver.js";
import type { ReviewFallbackLock } from "../roles/reviewer.js";
import { isReviewerKind } from "../roles/reviewer.js";
import { UnresumableLaneError, type WorkerProxyOpts } from "../roles/worker.js";
import type { BoardStatus, CategorizedTokenUsage, ModelUsageEntry, ParkRow, PendingRollback, State, WorkerRow } from "../state/state.js";
import {
  classifyEnvFailure,
  type EnvFailureSource,
  escalationChannel,
  parkDurationExceededSec,
  probeBackoffSec,
  probeDue,
} from "./env-failure.js";
import { attemptThreadWrite, computeFixResponseHarvest, type FixResponseWriteOutcome } from "./fix-response.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure scheduling core (parity targets — keep semantics identical to guard's bash twin)
// ─────────────────────────────────────────────────────────────────────────────

/** Next round id. Dirty/missing/<1 -> 1, else prev+1. Never negative, never throws. */
export function nextRoundId(prev?: string | number): number {
  const s = prev === undefined ? "" : String(prev);
  return /^[1-9][0-9]*$/.test(s) ? Number(s) + 1 : 1;
}

export type LaneClass = "KEEP" | "DONE" | "FAILED" | "ADOPT" | "DEAD";

/**
 * Classify an in-flight lane from the completion signals (§7), priority high->low:
 * failed sentinel > done sentinel > wrapper-confirmed-dead(no sentinel) > restart adoption |
 * heartbeat-timeout > KEEP.
 * wrapperAlive: 1 alive | 0 dead (kill -0 failed) | -1 unknown (no readable pid).
 * hbAge < 0 means "no heartbeat file yet" (just spawned) — not a timeout.
 * #169: only a stale-heartbeat, confirmed-alive detached lane with a parseable, bounded
 * first-dispatch age is adoptable. Unknown age fails safe to the pre-#169 DEAD behavior.
 */
export function classifyLane(
  done: boolean,
  failed: boolean,
  hbAge: number,
  threshold: number,
  wrapperAlive: -1 | 0 | 1,
  dispatchedAgeSec = Number.NaN,
  timeoutSec = 0,
): LaneClass {
  if (failed) return "FAILED";
  if (done) return "DONE";
  if (wrapperAlive === 0) return "DEAD"; // confirmed dead, no sentinel -> crashed without trace
  if (hbAge >= 0 && hbAge > threshold) {
    if (wrapperAlive === 1 && Number.isFinite(dispatchedAgeSec) && dispatchedAgeSec >= 0 && dispatchedAgeSec <= timeoutSec) {
      return "ADOPT";
    }
    return "DEAD"; // stale + dead/unknown/too-old/unbounded keeps today's hard-reclaim path
  }
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
 * Lowest configured-prefix prio:N rank across labels (0..4, low = higher priority).
 * No matching prio label -> 3. Supports bare names only when labels.prefix is explicitly "".
 */
export function issuePriority(labels: string[], prefix: string): number {
  let min = 5; // sentinel: no prio label found
  for (const tok of labels) {
    const d = matchPriorityLabel(tok, prefix);
    if (d != null) {
      if (d < min) min = d;
    }
  }
  return min === 5 ? 3 : min;
}

/** Configured-prefix blocked-by:[#]N blocker issue numbers, ascending. */
export function labelsBlockers(labels: string[], prefix: string): number[] {
  const out: number[] = [];
  for (const tok of labels) {
    const issue = matchBlockedByLabel(tok, prefix);
    if (issue != null) out.push(issue);
  }
  return out.sort((a, b) => a - b);
}

/** True if any reserve-ish label (reserve / needs-human — config-driven) is present. */
export function hasReserveLabel(labels: string[], reserveLabels: string[]): boolean {
  return reserveLabels.some((reserveLabel) => labelsInclude(labels, reserveLabel));
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
 *  - `humanHoldPresent`: ANY of the issue's cfg.escalation.humanLabels still present (round-4
 *    P2, Codex PR #151: the human-hold set is the WHOLE escalation.humanLabels list — default
 *    [needs-human, blocked] — exactly the set dispatch holds on via orderForDispatch's
 *    hasReserveLabel check, not needs-human alone; an issue still carrying `blocked` must not
 *    reclaim just because needs-human was removed) -> SKIP (no complete explicit human act
 *    yet, PLAN.md autonomy principle — automation never re-admits itself).
 *  - every hold cleared, `attempts < cap` -> RECLAIM (back to `driving`, bump the attempt count).
 *  - every hold cleared, `attempts >= cap` -> CAPPED (the cap was already spent on a prior
 *    reclaim that re-escalated; fail closed rather than retry forever — re-escalate + latch
 *    permanently).
 *
 * #248 review round 1 (G1, Codex sol-high PR #266, PM-narrowed): `issueHoldPresent` — ANY of
 * the issue's `escalation.holdLabels` present — is a SEPARATE, ADDITIONAL SKIP input alongside
 * `humanHoldPresent`, not folded into it. The original #248 doc comment here reasoned that a
 * `hold` label is orthogonal to GATED RECLAIM because it only ever gates a `driving` lane's
 * `deriveGate` (PR-level) — true, but incomplete: it missed the confirmed scenario where a
 * fix-round-capped lane is ALREADY `failed` + issue-`needs-human` (via #147's cap-escalation
 * path, not #248's PR-level WAIT), and a human applies an ISSUE-level `hold` while
 * investigating — intending to "take control" of the reentry decision itself — then removes
 * `needs-human` before finishing that investigation. Without this check, `humanHoldPresent`
 * alone would go false the instant `needs-human` clears, RECLAIM would fire, burn a
 * `gated_reentry_attempts` slot, and DRIVE would immediately re-escalate or re-latch at the cap
 * — exactly the "apply hold = take control" handshake failing, and a non-zero-consumption
 * round-trip. The PM-narrowed fix keeps this cheap and local: this phase ALREADY fetches the
 * issue's labels once per lane (`forge.getIssueLabels`) for the `humanHoldPresent` check above —
 * `issueHoldPresent` reads the SAME already-fetched array, no new forge call. Deliberately NOT
 * plumbed into the DRIVE loop's per-tick PR-label hold check (merge-driver.ts's `deriveGate`) —
 * that would mean a NEW per-lane issue-label fetch on every DRIVE tick for a rare, short-lived
 * manual state, which is the per-tick forge-read inflation the PM ruling rejected. The
 * consequence (documented, accepted, bounded — see docs/PLAN.md's escalation-model section): an
 * issue-level `hold` applied to a lane that is STILL `driving` (never escalated) has no effect
 * here at all — it isn't consulted until/unless the lane reaches `gatedFailedWorkers()`, and a
 * `driving` lane's own hold-handling is the PR-level `holdLabels` check in `deriveGate`, a
 * DIFFERENT carrier on a DIFFERENT surface. Each of the two hold carriers (issue label, PR
 * label) gates only the automation surface it sits on: issue-level hold = gated-reentry
 * eligibility; PR-level hold = the drive/merge gate. Applying either takes control of that one
 * surface only, by design (one fact, one bit, per surface).
 */
export function gatedReentryDecision(
  humanHoldPresent: boolean,
  issueHoldPresent: boolean,
  attempts: number,
  cap: number,
): GatedReentryDecision {
  if (humanHoldPresent || issueHoldPresent) return "SKIP";
  return attempts < cap ? "RECLAIM" : "CAPPED";
}

export type ResumeIntentState = "none" | "confirmed" | "unconfirmed";
export type ResumeDecision = "ADOPT" | "RESUME" | "CAPPED" | "UNDECIDABLE" | "SKIP";
/** #172 graceful-handoff reentry decision. A confirmed intent is reality reconciliation, not
 *  fresh work: its child already exists, so ADOPT comes first — human holds must not prevent
 *  supervision, capacity may transiently exceed lanes.max, and the resume cap cannot undo a
 *  spawn that happened. Although ADOPT also outranks `killSwitchActive` in this pure table, the
 *  conductor's kill-switch path returns before RESUME; that explicit human-control path never
 *  calls this function. Visibility work (undecidable/cap escalation) may latch while paused or
 *  full. Otherwise kill switch/human holds suppress automation, and ambiguity outranks cap. */
export function resumeDecision(
  paused: boolean,
  killSwitchActive: boolean,
  humanHoldPresent: boolean,
  confirmed: boolean,
  undecidable: boolean,
  attempts: number,
  cap: number,
  lanesUsed: number,
  lanesMax: number,
): ResumeDecision {
  if (confirmed) return "ADOPT";
  if (killSwitchActive || humanHoldPresent) return "SKIP";
  if (undecidable) return "UNDECIDABLE";
  if (attempts >= cap) return "CAPPED";
  return !paused && lanesUsed < lanesMax ? "RESUME" : "SKIP";
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
export function driveDecision(gate: string, fixRounds: number, cap: number, overBudget: boolean): DriveAction {
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

/** #246 review round 1 (C2, Codex sol-high PR #264): the new-LEG admission gate a FIXUP
 *  dispatch (startFixLeg -> supervisor.resume, a fresh PAID Claude worker leg) must pass —
 *  the SAME set of conditions that already block RESUME/DISPATCH from spawning one (this
 *  module's own `resumeSpendPaused` / the DISPATCH gate's skip reasons): pause, an engine-wide
 *  ceiling breach (draining, not admitting new work), an active environment park, the per-round
 *  spend budget, and the run-level spend stop condition. Without this, a wind-down could start a
 *  BRAND NEW fix leg instead of draining, defeating the very safety boundaries those phases
 *  enforce for ordinary dispatch. Pure/testable; the specific reason returned is for the event/
 *  driven-outcome payload only — every true input blocks equally (first-match-wins is just a
 *  deterministic pick among possibly-simultaneous reasons, same style as DispatchOutcome's own
 *  "skipped" reasons). `null` = admission granted. Distinct from `driveDecision` above, which
 *  gates the FIXUP-vs-ESCALATE *scheduling* decision (fix_rounds vs cap) — this gates the spawn
 *  itself, called only once `driveDecision` has already said "FIXUP". */
export function fixLegAdmissionBlockReason(input: {
  paused: boolean;
  ceilingBreached: boolean;
  parkActive: boolean;
  overBudget: boolean;
  runSpendStop: boolean;
}): string | null {
  if (input.paused) return "paused";
  if (input.ceilingBreached) return "ceiling";
  if (input.parkActive) return "park";
  if (input.overBudget) return "over-budget";
  if (input.runSpendStop) return "run-spend-stop";
  return null;
}

/** #245: the fix-loop's dependency seam — deliberately narrower than the full TickDeps a caller
 *  (this module's own tick(), or #246's future FIXUP-dispatch branch inside it) already holds,
 *  so a caller can pass a `Pick`-shaped subset without constructing a whole fake tick(). */
export interface FixLegDeps {
  state: State;
  supervisor: Supervisor;
  /** Renders the fix-leg's own prompt from the driving lane's issue NUMBER + PR number
   *  (worker.ts's buildRenderFixPrompt(cfg), built once at startup — same injection shape as
   *  WorkerDeps.renderPrompt). #245 round-2 (A7): takes the bare issue NUMBER, not a full
   *  `Issue` — the fix-leg prompt's own template vars are `issue.number`/`pr.number`/
   *  `labels.verifyNa` only (never issue title/body/labels: a fix leg's evidence channel is the
   *  PR-facing proxy tools, not issue prose), so there is no need to fabricate an empty-shell
   *  `Issue` object just to satisfy this signature. Never receives review-finding TEXT: the fix
   *  leg pulls that itself, over the PR-facing proxy tools (#244), once its own session starts
   *  (#245 AC — no prompt-injection transport). */
  renderFixPrompt: (issueNumber: number, pr: number) => string;
}

/** #245: start a fix leg for a `driving` lane whose PR needs rework — the SOLE producer of a
 *  `fixing` row, and the seam #246 (the FIXABLE gate) calls once its own driveDecision reaches
 *  "FIXUP". Reuses #172's resume machinery outright: SAME worker row, SAME worktree/branch/
 *  session lineage — never a fresh dispatch (the squash-branch-reuse hazard a new dispatch
 *  against this lane's (possibly stale, possibly ahead) head would create). Calls
 *  `supervisor.resume` in FIX-LEG ENTRY MODE (`opts.sessionId: w.session_id` — a `driving` row
 *  has no `.handoff` sentinel to read a session id off, #245 round-2 fix A1).
 *
 *  `fix_rounds` is an INDEPENDENT counter from `resume_attempts` (schema v18->v19 migration
 *  comment) — bumped here, together with the `driving` -> `fixing` state transition, in the SAME
 *  upsertWorker call, and only AFTER resume() has confirmed a spawn: a thrown resume() leaves
 *  the row untouched (still `driving`, `fix_rounds` un-incremented) so a transient spawn failure
 *  costs zero fix-round budget and the next tick's gate can simply retry. A crash between
 *  resume()'s own confirmed-spawn write and THIS function's upsertWorker call is repaired by
 *  `reconcileDrivingFixIntents` (tick()'s own pre-kill-switch-gate pass, #245 round-2 fix A3) —
 *  never left as a live, DB-invisible child.
 *
 *  `w.pr` MUST be set (every `driving` row's invariant, #13) — a null PR is a caller bug, not a
 *  normal runtime state, so this throws rather than silently no-op-ing (fail-safe, matching the
 *  DRIVE loop's own "driving-lane-missing-pr" fail-safe in tick()).
 *
 *  `proxy` is MANDATORY, and `proxy.credentialFree` MUST be true (#245 round-2 fix A6): a fix
 *  leg is never granted ambient forge credentials — the proxy is its ONLY evidence channel, so
 *  this function refuses to start one without it rather than silently degrading. #246 (the sole
 *  production caller) always supplies a `credentialFree` proxy. */
export async function startFixLeg(
  deps: FixLegDeps,
  w: WorkerRow,
  proxy: WorkerProxyOpts,
  now: () => Date = () => new Date(),
): Promise<{ name: string; sessionId: string }> {
  if (w.pr == null) {
    throw new Error(`startFixLeg: lane ${w.name} (issue #${w.issue}) has no PR — a driving lane must always carry one`);
  }
  if (!proxy.credentialFree) {
    throw new Error(
      `startFixLeg: lane ${w.name} — proxy.credentialFree must be true; a fix leg must never run with ambient forge credentials`,
    );
  }
  const pr = w.pr;
  const prompt = deps.renderFixPrompt(w.issue, pr);
  const issue: Issue = { number: w.issue, title: "", labels: [] };
  // #247 F1 (Codex sol-high PR #265 review round 2, P1): captured BEFORE resume() — the child
  // cannot make its first tool call before this line runs, so this row id can never postdate
  // it (unlike a wall-clock timestamp recorded AFTER resume() confirms the spawn, round 1's own
  // defect). See fix-response.ts's fixLegJournalCursor for the full rationale.
  const journalCursor = deps.state.maxForgeProxyJournalId(w.name);
  const result = await deps.supervisor.resume(issue, w.name, { prompt, sessionId: w.session_id, proxy });
  const fixRounds = (w.fix_rounds ?? 0) + 1;
  deps.state.upsertWorker({ ...w, state: "fixing", ended_at: null, fix_rounds: fixRounds });
  deps.state.appendEvent("fix-leg-started", { worker: w.name, issue: w.issue, pr, fixRounds, journalCursor, at: now().toISOString() });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick orchestration: reclaim -> drive -> resume -> dispatch. Side-effecting collaborators are
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
  /** #169: seconds since running.json's persisted first `dispatched_at`; NaN when absent or
   *  unparseable. This is existing persisted data surfaced for bounded restart adoption, not
   *  new lane state. Optional only for pre-#169 probe fixtures; stale lanes without it fail
   *  safe to DEAD. */
  dispatchedAgeSec?: number;
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
  /** #155: LIVE per-probe telemetry (priced-cost snapshot + context/composition) — present
   *  only while worker.ts's WorkerSupervisor still holds the lane in-memory (i.e. actually
   *  running; undefined once terminal, for a detached post-restart lane, or for probe fixtures
   *  predating #155). Display-only, refreshed fresh on every probe() call — see
   *  conductor.tick()'s KEEP branch (State.setLiveTelemetry) and reclaim's
   *  State.clearLiveTelemetry. Never itself consulted by any dispatch/budget gate. */
  liveTelemetry?: {
    estCostUsd: number;
    contextTokens: number;
    tokenComposition: CategorizedTokenUsage;
  };
  /** #168: a FAILED lane's own captured output — worker.ts's stream-json jsonl (stdout+stderr
   *  merged onto one fd at spawn), tail-capped. The env-failure classification input
   *  (env-failure.ts's classifyEnvFailure): the engine already writes/reads this file for
   *  cost/model-usage parsing (terminalCostUsd/terminalModelUsage), so this is not a new
   *  capture mechanism, only a new read of an existing one. undefined for a non-FAILED lane, or
   *  for probe fixtures that predate #168 — classifyEnvFailure treats undefined/"" as no match
   *  (an ordinary task failure), never a park. */
  failureText?: string;
  /** #247: a DONE lane's own final-message text (worker.ts's parseResultText, the SAME
   *  stream-json `result` field read every peripheral role's structured-output validator
   *  already consumes via RoleSessionResult.resultText) — a fix leg's structured
   *  threadResponses block lives here. undefined for a non-DONE lane, or for probe fixtures
   *  that predate #247 — reclaimTerminalLane treats undefined/"" as "no structured output",
   *  the harvest fails closed (validateFixResponseOutput's own "no block found" case), never a
   *  guess. Populated unconditionally for every DONE lane (not just `fixing` ones) — same
   *  "cheap, existing capture, just a new read" stance failureText already takes; an ordinary
   *  worker's DONE result text is simply never consumed by anything. */
  resultText?: string;
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
  /** Re-enter a terminal handoff as a fresh leg in the same session/worktree (#172). `opts`
   *  (#245) is additive: `prompt` overrides the ordinary issue-rendered prompt (the fix-leg's
   *  own fix instruction — see startFixLeg below); `proxy` attaches a forge MCP proxy handle to
   *  the resumed leg, mirroring dispatch()'s own #244 attachment; `sessionId` (round-2 fix A1) is
   *  FIX-LEG ENTRY MODE — starting a fix leg from a `driving` lane (no `.handoff` sentinel to
   *  read a session id off) rather than resuming a genuine `.handoff`. Omitted -> today's entire
   *  #172 handoff-resume behavior, unchanged. */
  resume(
    issue: Issue,
    worker: string,
    opts?: { proxy?: WorkerProxyOpts; prompt?: string; sessionId?: string },
  ): Promise<{ name: string; sessionId: string }>;
  /** Cheap, read-only classification of resume()'s durable spawn-intent marker (#172). */
  resumeIntentState(worker: string, issue: number): ResumeIntentState;
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
  /** #245 round-2 fix (B1): best-effort removal of a STALE prior-leg `.done`/`.failed` terminal
   *  sentinel for `worker` — see worker.ts's own doc for the crash window this closes
   *  (reconcileDrivingFixIntents' "confirmed" branch calls this to cover the case where
   *  resume()'s own post-confirmation removal never ran before a crash). Never throws. */
  clearStaleFixEntrySentinel(worker: string): void;
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
  | { kind: "stopped"; worker: string; issue: number; pr: number; reason: string }
  // #247 D5: gate①/gate② deliberately SKIPPED this tick — the lane has a pending thread write
  // still queued/retrying (fix-response.ts). Distinct from "queued" (that's driveOne's own
  // WAIT_REVIEW/HANDLE_THREADS verdict) — this lane was never even driven. Checked BEFORE the
  // FIXABLE gate below can even be evaluated (#246) — a lane with pending writes must not reach
  // FIXUP either, for the same fix-round-burn reason it must not reach an ordinary driveOne call.
  | { kind: "thread-writes-pending"; worker: string; issue: number; pr: number }
  // #246: a FIXABLE gate that dispatched a fix leg this tick (driveDecision -> "FIXUP") — the
  // lane leaves `driving` for `fixing` (startFixLeg's own transition); distinct from "queued" so
  // dispatch activity is observable in TickResult without a separate query.
  | { kind: "fixup"; worker: string; issue: number; pr: number; reason: string };

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
  | ({ kind: "dead"; worker: string; issue: number; rescued: boolean } & TerminalSpend)
  // #168: a FAILED, no-PR lane whose captured output matched an environment-failure signature.
  // Distinct from "failed" — never applies needs-human, never touches gated-reentry state
  // (this lane's `pr` column stays null); the issue is returned to Ready via the existing #31
  // rollback/requeue machinery, and the engine enters/extends the parked state.
  | ({ kind: "env-failure"; worker: string; issue: number; source: EnvFailureSource } & TerminalSpend);

export type DispatchOutcome =
  | { kind: "dispatched"; issue: number; worker: string }
  | {
      kind: "skipped";
      issue: number;
      reason: "cap" | "no-lane" | "in-flight" | "over-budget" | "meta-floor" | "ceiling" | "run-spend-stop";
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

/** #172: one handoff-lane decision that changed durable state this tick. */
export type ResumeOutcome =
  | { kind: "resumed"; worker: string; issue: number; attempt: number }
  | { kind: "capped"; worker: string; issue: number; attempts: number };

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
  /** #172 handoff lanes re-admitted to `running`, or escalated+latch-capped. */
  resumed: ResumeOutcome[];
  /** #245: fixing-lane reclaim decisions this tick — a `fixing` lane is a LIVE fix-leg worker
   *  process (same shape as an ordinary `running`-lane reclaim outcome; see the FIXING RECLAIM
   *  phase in tick()). Empty when there were no `fixing` lanes this tick. */
  fixingReclaimed: ReclaimOutcome[];
  /** #247: every pending fix-thread write (persisted this tick or a prior one) attempted this
   *  tick — recorded / resolved / still-retrying / escalated-to-needs-human. Empty when nothing
   *  was pending and no fixing lane's terminal reclaim enqueued anything new this tick. */
  fixResponses: FixResponseWriteOutcome[];
}

export interface TickDeps {
  forge: IForge;
  state: State;
  supervisor: Supervisor;
  cfg: SapwoodConfig;
  log?: (message: string) => void;
  /** Cumulative round spend (USD) for the hard round-budget gate — a THUNK, not a snapshot
   *  (#124 gate② P1-2 on PR #157). tick() evaluates it exactly where `overBudget` is computed:
   *  AFTER the reclaim phase, BEFORE the dispatch loop. This matters because reclaim runs
   *  before dispatch inside one tick, and #124's multi-wave refill lets a lane freed by THIS
   *  tick's reclaim be refilled by THIS tick's dispatch — so spend banked by that reclaim
   *  (which can cross cfg.cost.roundBudgetUsd) must be visible to the same tick's budget gate,
   *  or a fresh wave launches after the budget is already blown. A caller-supplied scalar,
   *  captured before the tick ran, could never see it. round.ts passes a live read over the
   *  round's durable spend-ledger id window, which includes opening peripherals and every
   *  settled worker leg exactly once across restart; the tick driver (driver.ts) never sets
   *  this — default 0 (no spend known). */
  roundSpendUsd?: () => number;
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
  /** #124: per-CALL override for the DISPATCH loop's cap check below, replacing
   *  cfg.lanes.roundDispatchCap for this one tick only. Omitted (the tick-driver's path,
   *  driver.ts) -> cfg.lanes.roundDispatchCap applies unchanged, its original meaning: a flat
   *  PER-TICK rate limit, re-armed fresh every call, no cross-tick memory. round.ts (the rounds
   *  driver) is the one caller that sets this — it passes the QUOTA REMAINING this round
   *  (cfg.lanes.roundDispatchCap minus a durable per-round dispatch count it tracks itself),
   *  so repeated dispatch-enabled ticks across a round's multiple waves cumulatively respect one
   *  round-wide quota instead of each tick getting its own fresh cfg.lanes.roundDispatchCap
   *  allowance. This is the ONLY mechanism difference between the two drivers — tick() itself
   *  has no notion of "round," just "this call's allowance." */
  dispatchCapOverride?: number;
  /** #154 (Codex P1, PR #160): has the RUN-level spend stop (stop.afterSpendUsd) crossed? A
   *  thunk for the same reason roundSpendUsd is one — evaluated post-reclaim, pre-dispatch, so
   *  spend banked by THIS tick's reclaim freezes THIS tick's refill. Without it the drivers'
   *  own post-tick check lags one tick and a crossed spend budget still buys one more wave
   *  (the exact same-tick window #124 gate② P1-2 closed for cost.roundBudgetUsd). Unset (no
   *  spend stop configured) → no check, no cost. */
  runSpendStopCrossed?: () => boolean;
  /** #168: the LLM reachability probe — a deterministic check (no LLM JUDGMENT: success is
   *  "did the process exit 0 and print pong", never a model's opinion). The real
   *  implementation (worker.ts's probeLlmPing, wired by cli.ts) is a minimal inference ping on
   *  the cheapest model (cfg.envFailure.probeModel, ~$0.016 measured per ping, bounded by
   *  probeMaxBudgetUsd): it proves network + auth + some account capacity, and merely GATES
   *  the canary — it is never itself a recovery signal (see the PARK section).
   *
   *  Return shape: a bare boolean, or `{ ok, detail? }` — `detail` (failure only) is the
   *  probe's first stderr/error line, recorded in the park-probe event so an operator can
   *  distinguish "provider still down" (a 429) from a local misconfiguration ("Exceeded USD
   *  budget" = probeMaxBudgetUsd too low; "unknown option" = an older CLI missing the ping's
   *  flags). Bare booleans keep every existing fake/test valid.
   *
   *  Consulted only while parked for `source: "llm"`. Disabled-consumer rule (doctrine):
   *  omitted -> tick() never probes the LLM source at all (there is no consumer for the
   *  result) — the park stays in place until either a human intervenes or the duration-based
   *  escalation notifies one; the forge probe is UNCONDITIONAL (see conductor.ts's PARK
   *  section) since `forge` above is a required field, never optional, so it always has a
   *  consumer. */
  probeLlmReachable?: () => Promise<boolean | { ok: boolean; detail?: string }>;
  /** #245 round-2 fix A2, #246: the fix-loop's shared renderFixPrompt+mint source, consumed at
   *  TWO points: (1) the DRIVE loop's own FIXUP dispatch (#246 — driveDecision reaching "FIXUP"
   *  calls startFixLeg with this dep, entering a `driving` lane into `fixing` for the FIRST
   *  time), and (2) the RESUME phase below, when a `fixing` lane hands off (soft budget) and
   *  later needs to resume — it must come back as a FIX leg (fix prompt + mandatory
   *  `credentialFree` proxy + target state `fixing`), never an ordinary running leg; the RESUME
   *  phase checks `WorkerRow.fixing_handoff` and, ONLY when set, uses this SAME dep instead of
   *  the ordinary #172 resume path. Omitted, the two consumers differ (#246 review round 1, C1):
   *  the DRIVE loop's FIXUP branch DEGRADE-ESCALATES — same needs-human escalation the pre-#246
   *  gate produced (`fix-leg-dispatch-unconfigured` event, then `escalateNeedsHuman`), visible
   *  and terminal, never a silent retry; the RESUME phase's fixing-origin-handoff branch instead
   *  leaves the row untouched (`fix-leg-resume-unconfigured` event, still `handoff`), retried
   *  next tick — that one has no equivalent "fold to the pre-#245 behavior" to degrade to (fixing
   *  lanes didn't exist before #245), so skip-don't-corrupt is the only sound default there. */
  fixLegResume?: FixLegResumeDeps;
}

/** #245 round-2 fix A2: mirrors FixLegDeps' own `renderFixPrompt` shape (issue NUMBER + PR
 *  number, #245 round-2 fix A7 — never a fabricated Issue) plus the mint function a resumed fix
 *  continuation needs to re-attach a FRESH proxy (never trusting a proxy handle from a prior,
 *  possibly-crashed engine process — see reconcileDrivingFixIntents' own doc for the related
 *  dead-proxy hazard on the ENTRY side). */
export interface FixLegResumeDeps {
  renderFixPrompt: (issueNumber: number, pr: number) => string;
  mintProxy: WorkerProxyOpts["mint"];
}

/** #167 review (Codex P2+P3 adjudication): the gated-reentry-cap-hit escalation note appended
 *  to the re-escalation comment once the last automatic reentry attempt is spent. The original
 *  version unconditionally cited "this repo's review doctrine, adjudication point 4" and the
 *  RESOLVED ABSOLUTE `cfg.doctrine.file` path — two defects: (a) a repo can legally have no
 *  doctrine file adopted (doctrine.ts's NO_DOCTRINE is a common, expected state) or have
 *  rewritten one that no longer uses this exact numbering, so citing it unconditionally can be
 *  false; (b) an absolute local filesystem path posted to a public GitHub issue comment leaks
 *  this machine's directory layout. Fixed by splitting the message: the PRINCIPLE (repeated fix
 *  rounds -> re-examine design/direction, not more patches) is stated inline and
 *  self-contained, true regardless of doctrine adoption; the doctrine pointer is ADDITIVE,
 *  appended ONLY when a doctrine file was actually loaded — `existsSync` on the RESOLVED path,
 *  the same presence check doctrine.ts's own `loadDoctrine` makes — and cites the RAW,
 *  pre-resolution path exactly as the user wrote it in config (`cfg.doctrine.fileRaw`, set by
 *  config.ts's `loadConfig` before it absolutizes `cfg.doctrine.file`; falls back to
 *  `cfg.doctrine.file` itself for a caller that built `cfg` via `ConfigSchema.parse` directly —
 *  every test in this file, and any consumer that skipped `loadConfig` — where that field is
 *  already the raw, un-resolved value since no resolution step ran). Never the resolved
 *  absolute path either way. */
export function capHitEscalationNote(cfg: SapwoodConfig): string {
  const principle =
    "That was the last automatic attempt; a further reentry will be rejected. Repeated fix " +
    "rounds that keep missing the same finding are usually a signal to re-examine the " +
    "feature's design or technical direction at the top of the loop, not to grind through " +
    "more automatic patch attempts.";
  if (!existsSync(cfg.doctrine.file)) return principle;
  const rawPath = cfg.doctrine.fileRaw ?? cfg.doctrine.file;
  return `${principle} See this repo's review doctrine (\`${rawPath}\`) for more on how repeated findings should be adjudicated.`;
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
    .filter((i) => labelsBlockers(i.labels, cfg.labels.prefix).length === 0)
    .map((i) => ({ i, rank: issuePriority(i.labels, cfg.labels.prefix) }))
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
 *
 * #168 EXEMPTION (PR #180 review P1-2): an env-failure requeue NEVER takes the cap branch — the
 * issue did nothing wrong, so degrading it to needs-human (and deleting its durable requeue,
 * silently un-queuing it) breaks the env-failure contract on both counts. Its row stays durable
 * and is bumped-and-retried indefinitely; the park escalation channel (escalatePark's suspended-
 * requeue count) is how a human learns it is being held.
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
    if (attempts >= cfg.recovery.rollbackRetryCap && row.reason !== ENV_FAILURE_REQUEUE_REASON) {
      state.clearPendingRollback(row.id);
      // Best-effort last-mile notification — its own failure is not re-persisted (this is
      // already the bounded-retry escalation path, not another recovery loop to harden) but
      // the structured event + returned outcome below always fire regardless, so the
      // escalation itself is never silently swallowed even if the label call is.
      await forge.addLabel(row.issue, cfg.labels.needsHuman).catch(() => {});
      state.appendEvent("rollback-escalated", {
        issue: row.issue,
        target: row.target,
        reason: row.reason,
        attempts,
        error: String(e),
      });
      return { kind: "escalated", issue: row.issue, attempts, reason: row.reason };
    }
    state.bumpPendingRollback(row.id, iso());
    state.appendEvent("rollback-retry-failed", {
      issue: row.issue,
      target: row.target,
      reason: row.reason,
      attempts,
      error: String(e),
    });
    return { kind: "retrying", issue: row.issue, attempts, reason: row.reason };
  }
}

/** #69 dirty-worktree retention: tell a human where the preserved worktree lives. Best-effort
 *  and never throws (this runs on recovery paths that must not gain new failure modes) — the
 *  structured event always lands even if both forge calls fail. The human-attention label is the
 *  caller's job (every retention call site already applies it on its own escalation branch). */
async function reportRetainedWorktree(
  forge: IForge,
  state: State,
  worker: string,
  issue: number,
  worktreePath: string | null,
  needsHumanLabel: string,
): Promise<void> {
  state.appendEvent("worktree-retained", { worker, issue, worktreePath });
  await forge
    .addIssueComment(
      issue,
      `sapwood: lane \`${worker}\` was torn down with possibly-uncommitted changes in its ` +
        `worktree. Automation never deletes work it can't prove is clean (#69) — the worktree ` +
        `was left on disk at:\n\n\`${worktreePath}\`\n\nSalvage or discard it by hand, then ` +
        `remove the \`${needsHumanLabel}\` label.`,
    )
    .catch(() => {});
}

/** Label-first/latch-second handling for a resume spawn whose outcome is unknowable after a
 *  crash. Shared by proactive marker inspection and resume()'s typed-error backstop. */
async function escalateUndecidableResume(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  worker: WorkerRow,
  attempts: number,
  iso: () => string,
): Promise<ResumeOutcome | null> {
  try {
    await forge.addLabel(worker.issue, cfg.labels.needsHuman);
  } catch (labelError) {
    state.appendEvent("resume-undecidable-label-failed", {
      worker: worker.name,
      issue: worker.issue,
      error: String(labelError),
    });
    return null;
  }
  await forge
    .addIssueComment(
      worker.issue,
      `sapwood: resume for lane/worktree \`${worker.name}\` entered an ambiguous crash state: ` +
        `the durable spawn intent was never confirmed. Automatic resume is latched to avoid ` +
        `a duplicate process in the preserved worktree. Inspect session \`${worker.session_id}\` ` +
        `and the lane's preserved worktree before removing \`${cfg.labels.needsHuman}\`.`,
    )
    .catch(() => {});
  state.upsertWorker({ ...worker, ended_at: iso(), resume_capped: 1 });
  state.appendEvent("resume-undecidable", {
    worker: worker.name,
    issue: worker.issue,
    sessionId: worker.session_id,
  });
  return { kind: "capped", worker: worker.name, issue: worker.issue, attempts };
}

/** The bounded drain (PLAN.md Security model: drain before kill, always). Shared by the #69
 *  global kill-switch gate and the #14 cost-ceiling breach path in tick(): record the breach
 *  (first detection only — see State.recordCeilingBreach's INSERT OR IGNORE), ask every
 *  running worker to hand off gracefully (idempotent per tick), and only once
 *  cfg.cost.drainWindowSec has elapsed since first detection escalate to the hard
 *  process-tree kill + needs-human. No PR-aware rescue on escalation — this is a safety
 *  boundary, not a liveness classification, so fail-safe to human triage. */
async function drainThenEscalate(
  forge: IForge,
  state: State,
  supervisor: Supervisor,
  cfg: SapwoodConfig,
  reasons: CeilingReason[],
  nowDate: Date,
  iso: () => string,
): Promise<{ drainRequested: string[]; escalated: string[] }> {
  state.recordCeilingBreach(reasons, nowDate);
  const drainRequested: string[] = [];
  const escalated: string[] = [];
  // #245: `fixing` lanes are live fix-leg worker processes — drained/escalated exactly like
  // `running` ones (worker-paradigm supervision applies uniformly; see reclaimTerminalLane's
  // `fixingPinClear` and the FIXING RECLAIM phase's own doc for the rest of that contract).
  const stillRunning = [...state.runningWorkers(), ...state.fixingWorkers()];
  for (const w of stillRunning) {
    // #168 P1-B: a drained lane that happens to be the llm episode's CANARY is settled
    // INCONCLUSIVE right here, at drain-request time — see releaseCanaryInconclusive's doc
    // comment for the two corruption modes this closes (false-clear via the later .handoff
    // reclaim; permanent wedge via the hard kill below). Idempotent no-op for every other lane
    // and for repeat drain ticks.
    releaseCanaryInconclusive(state, w.name);
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
      if (r.worktreeRetained) await reportRetainedWorktree(forge, state, w.name, w.issue, r.worktreePath, cfg.labels.needsHuman);
      state.appendEvent("ceiling-escalated", { worker: w.name, issue: w.issue, reasons });
      // #155: leaving `running` via the ceiling drain — clear the LIVE telemetry trio.
      state.clearLiveTelemetry(w.name);
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      escalated.push(w.name);
    }
  }
  return { drainRequested, escalated };
}

/** #168: a short, human-readable excerpt of a FAILED lane's captured output — stored as the
 *  park episode's `reason` (state.ts's park_state.reason) and surfaced in `sapwood status` /
 *  the escalation channel. Deliberately SHORT (this is a display string, not the classification
 *  input — classifyEnvFailure already ran against the full failureText before this is called). */
const PARK_REASON_MAX_CHARS = 200;
function summarizeFailureText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > PARK_REASON_MAX_CHARS ? `${trimmed.slice(0, PARK_REASON_MAX_CHARS)}…` : trimmed;
}

/** #168: the pending_rollbacks `reason` tag for an env-failure requeue — typed as a constant
 *  because THREE sites must agree on it byte-for-byte (PR #180 review P1-2): the requeue
 *  creation in reclaimTerminalLane, the suspension filter in tick()'s ROLLBACK RETRY phase, and
 *  attemptRollback's never-needs-human cap exemption. */
const ENV_FAILURE_REQUEUE_REASON = "env-failure-requeue";

/** #168: the forge probe — a lightweight, ALREADY-EXISTING IForge read (no new forge method),
 *  wrapped so any throw (network/auth/5xx — exactly the conditions env-failure.ts's forge
 *  signatures describe) reads as "still unreachable" rather than propagating. Deterministic:
 *  the classification is "did the call succeed", never an LLM judgment. */
async function probeForgeReachable(forge: IForge): Promise<boolean> {
  try {
    await forge.listOpenIssueNumbers();
    return true;
  } catch {
    return false;
  }
}

/** #168 (PR #180 review P1-1b): settle an llm-park CANARY lane at its terminal transition.
 *  The ping probe succeeding is NOT a recovery signal for the WORKER's model/tier (the ping
 *  runs on the cheapest model — model-specific caps and primary-model-only overload can leave
 *  it green while real dispatch still fails), so an llm episode is cleared ONLY by this
 *  function — when the lane recorded as the episode's canary reaches a terminal state that is
 *  NOT env-classified (done, ordinary task failure, handoff, DEAD): the one signal that a real
 *  worker-class run actually got through to the provider. An env-classified canary
 *  failure is the SAME episode continuing: entered_at and escalated_at are preserved untouched
 *  (the duration-escalation clock keeps running from FIRST entry), probe_attempts is bumped so
 *  the backoff keeps growing, and the canary slot is freed for the next backoff step. No-op
 *  for any lane that is not the current canary. */
function settleCanary(state: State, workerName: string, envClassified: boolean, iso: () => string): void {
  const llm = state.parkRow("llm");
  if (!llm || llm.canaryWorker !== workerName) return;
  if (envClassified) {
    state.bumpParkProbe("llm", iso());
    state.setParkCanary("llm", null);
    state.appendEvent("park-canary-failed", { worker: workerName, attempts: llm.probeAttempts + 1 });
  } else {
    state.clearPark("llm"); // also clears the local escalation marker when this was the last row
    state.appendEvent("park-resumed", { source: "llm", enteredAt: llm.enteredAt, via: "canary" });
  }
}

/** #168 (PR #180 round-3 P1-B): the THIRD canary disposition — INCONCLUSIVE. A drain (kill
 *  switch or cost/wall-clock ceiling) stopping a live canary says NOTHING about the provider:
 *  the lane was stopped for a safety reason, not because it answered or env-failed. Without
 *  this, the two drain modes each corrupted the episode differently: a graceful drain's
 *  .handoff sentinel landed in reclaimTerminalLane's settleCanary(..., false) and FALSELY
 *  CLEARED the llm episode with zero recovery evidence, and a hard drain (drainThenEscalate's
 *  kill + direct `failed` upsert) never touched the canary slot at all — leaving canary_worker
 *  pointing at a dead lane forever, which the PARK section reads as "canary still in flight"
 *  and never probes again: a PERMANENTLY WEDGED episode. Inconclusive = release the slot
 *  (clear canary_worker) while preserving the episode row UNCHANGED: no probe_attempts bump
 *  (a drain is not a probe result), entered_at/escalated_at untouched — the next backoff step
 *  simply pings again. Called from drainThenEscalate for every lane it drains (idempotent
 *  no-op for non-canaries), which covers BOTH modes: the slot is released at drain-REQUEST
 *  time, so the later .handoff reclaim's settleCanary no-ops (no false clear), and a hard
 *  kill leaves no dangling slot (no wedge). */
function releaseCanaryInconclusive(state: State, workerName: string): void {
  const llm = state.parkRow("llm");
  if (!llm || llm.canaryWorker !== workerName) return;
  state.setParkCanary("llm", null);
  state.appendEvent("park-canary-inconclusive", { worker: workerName });
}

/** #168: park-duration escalation — the channel ladder (env-failure.ts's escalationChannel):
 *  forge believed reachable (an llm-sourced escalation with no forge episode open) -> comment on
 *  the triggering issue with the EXISTING addIssueComment primitive (never a NEW label/issue-
 *  creation surface); forge believed/known unreachable (a forge-sourced escalation, OR an
 *  llm-sourced one during a mixed storm whose forge episode is also open) -> the LOCAL fallback
 *  ONLY — zero forge writes attempted on that branch, by construction (the channel is computed
 *  BEFORE any forge call, never a try-then-fallback pattern that would still attempt one).
 *  Additive: never touches park_state's active-ness, only stamps escalated_at
 *  (state.recordParkEscalation) — probing/auto-resume continue unaffected either side.
 *
 *  P1-2 surfacing (PR #180 review): env-failure requeues suspended by a forge outage never
 *  degrade to needs-human — they stay durable in pending_rollbacks and are surfaced HERE, in
 *  the escalation message, as the human-visible record of what will drain on resume. */
async function escalatePark(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  park: ParkRow,
  forgeParked: boolean,
  iso: () => string,
  log?: (message: string) => void,
): Promise<void> {
  const suspendedRequeues = state.pendingRollbacks().filter((r) => r.reason === ENV_FAILURE_REQUEUE_REASON).length;
  const message =
    `sapwood: engine parked since ${park.enteredAt} due to a ${park.source} environment failure ` +
    `(${park.reason}) — this has exceeded the configured ${cfg.envFailure.parkEscalateAfterSec}s ` +
    `escalation threshold. The engine is still probing on a bounded exponential backoff and will ` +
    `auto-resume dispatch on the first successful probe; this notification does not stop that. ` +
    (suspendedRequeues > 0 ? `${suspendedRequeues} issue requeue(s) are held durably and will drain on resume. ` : "") +
    `Informational only — no action is required unless the underlying outage is expected to ` +
    `persist.`;
  const intended = escalationChannel(park.source, forgeParked);
  // P2-3 (PR #180 review): the event below records the channel ACTUALLY used — when the forge
  // comment fails and this degrades to the local fallback, the audit trail must say "local",
  // not the intended-but-failed "forge".
  let actualChannel = intended;
  if (intended === "forge" && park.triggerIssue != null) {
    try {
      await forge.addIssueComment(park.triggerIssue, message);
    } catch {
      // The channel-ladder's "forge reachable" premise proved wrong (a race, or an llm-sourced
      // park whose forge turns out to ALSO be down) — never lose the escalation silently.
      actualChannel = "local";
      writeLocalEscalation(state, park, message, log);
    }
  } else {
    actualChannel = "local";
    writeLocalEscalation(state, park, message, log);
  }
  // ACCEPTED RESIDUAL (PR #180 review P2, documented not machined-away): a crash in the window
  // between the successful comment above and the recordParkEscalation latch below re-escalates
  // on the next tick after restart — one duplicate informational comment, bounded at one per
  // crash, self-identifying as informational. Closing it would need a persist-before-post
  // two-phase marker for a message that is explicitly advisory — machinery the #69 policy
  // (rare edges degrade to less machinery, not more) says not to build.
  state.recordParkEscalation(park.source, iso());
  state.appendEvent("park-escalated", {
    source: park.source,
    channel: actualChannel,
    triggerIssue: park.triggerIssue,
  });
}

/** #168: the local-fallback escalation write (CTO directive: sapwood status surface + a marker
 *  file in the engine data dir, written by the ENGINE, read-only informational, never a control
 *  input — see State.escalationMarkerPath's doc comment — + a log line). Zero forge writes. */
function writeLocalEscalation(state: State, park: ParkRow, message: string, log?: (message: string) => void): void {
  state.writeEscalationMarker({
    source: park.source,
    reason: park.reason,
    triggerIssue: park.triggerIssue,
    enteredAt: park.enteredAt,
    message,
    at: new Date().toISOString(),
  });
  (log ?? ((line) => process.stderr.write(`${line}\n`)))(`[sapwood:park] ${message}`);
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
  forge: IForge,
  state: State,
  supervisor: Supervisor,
  cfg: SapwoodConfig,
  w: WorkerRow,
  p: LaneProbe,
  threshold: number,
  iso: () => string,
): Promise<ReclaimOutcome | null> {
  const costUsd = p.costUsd ?? 0;
  const modelUsage = p.modelUsage ?? [];
  // #245 round-2 fix A5: computed ONCE, from `w.state` as it stood BEFORE this call (never
  // re-derived after a transition already happened) — spread into every branch below that lands
  // the row in `driving`, in the SAME settleTerminalWorker transaction that writes it, so a crash
  // can never observe `driving` with a STALE pre-fix pin (the old two-write shape: settle to
  // `driving` here, THEN a separate clearFixingReviewPinIfDriving call from the caller — a crash
  // between the two left the pin standing, silently suppressing the promised fresh review).
  const fixingPinClear = w.state === "fixing" ? { review_triggered_head: null, review_triggered_at: null } : {};
  if (p.handoff) {
    // Soft-budget graceful handoff: terminal-but-resumable. Never killed; the conductor may
    // --resume later. Checked before classifyLane (a handoff is not a failure).
    // #155: leaving `running` — clear the LIVE telemetry trio (settled real cost stays in
    // spend_ledger, recordSpend below, unchanged).
    state.clearLiveTelemetry(w.name);
    // #172 verified live 2026-07-14: resumed Claude Code legs report PER-LEG total_cost_usd,
    // not a cumulative session total. Each terminal transition records that leg directly;
    // spend across the initial handoff + resumed legs therefore sums exactly once.
    // #223: state + spend in ONE transaction (settleTerminalWorker) — no forge call in this
    // branch, so the only crash window was the two separate writes themselves.
    // #245 round-2 fix A2: `fixing_handoff` durably marks a handoff that interrupted a FIX leg
    // (not an ordinary running leg) — read back by the RESUME phase to restore a fix
    // continuation (fix prompt + mandatory credentialFree proxy + state `fixing`) instead of
    // silently resuming it as an ordinary leg.
    const fixLegHandoff = w.state === "fixing" ? 1 : 0;
    const handoffAt = iso();
    state.settleTerminalWorker(
      { ...w, state: "handoff", ended_at: handoffAt, fixing_handoff: fixLegHandoff },
      { worker: w.name, issue: w.issue, usd: costUsd, at: handoffAt, models: modelUsage },
    );
    state.appendEvent("handoff", { worker: w.name, issue: w.issue, fixLegHandoff: fixLegHandoff === 1 });
    // #168 P1-1b: a handed-off canary RAN (crossed its soft budget doing real work) — the
    // strongest possible non-env terminal signal. Resume.
    settleCanary(state, w.name, false, iso);
    return { kind: "handoff", worker: w.name, issue: w.issue, costUsd, modelUsage };
  }
  const cls = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive, p.dispatchedAgeSec, cfg.worker.timeoutSec);
  if (cls === "DONE") {
    // #155: leaving `running` either way (driving or done/escalated) — clear LIVE telemetry.
    state.clearLiveTelemetry(w.name);
    // #168 P1-1b: a DONE canary proves the provider is back — resume the llm episode.
    settleCanary(state, w.name, false, iso);
    const next = laneOnReclaimDone(p.hasPr);
    // #223: state + spend atomic (settleTerminalWorker) BEFORE any forge write — a lost label
    // is cosmetic, a lost ledger row is money. This was the bug named in #223: the ESCALATE_NOPR
    // branch used to await forge.addLabel BETWEEN the terminal upsertWorker and recordSpend, so
    // a thrown label write skipped recordSpend with the worker already terminal.
    const doneAt = iso();
    if (next === "DRIVING") {
      // #247 D4 (Codex sol-high PR #265 review round 1, P1): a `fixing` lane's structured
      // threadResponses output is computed PURELY/READ-ONLY here — BEFORE the terminal state
      // write — so its outcome (a validated batch, or an invalid-output descriptor) can be
      // committed in the SAME atomic transaction as the terminal `driving` row + spend below.
      // A crash between "settled to driving" and "batch enqueued" is thereby impossible: either
      // everything lands together, or the row stays `fixing` and is retried next tick (re-
      // deriving the identical batch from the same resultText/journal — never a lost or partial
      // batch). `w.state` is read BEFORE settleTerminalWorker's own write below overwrites it
      // (same "read w.state as it stood on entry" stance fixingPinClear already takes).
      const fixResponse =
        w.state === "fixing"
          ? computeFixResponseHarvest(state, {
              worker: w.name,
              issue: w.issue,
              fixRounds: w.fix_rounds ?? 0,
              prNumber: p.prNumber ?? w.pr ?? null,
              resultText: p.resultText ?? "",
            })
          : undefined;
      // PR produced: hold the lane in `driving` (it still occupies a lane until the #13 review
      // gate resolves it). No requeue, no human escalation.
      state.settleTerminalWorker(
        { ...w, state: "driving", ended_at: doneAt, pr: p.prNumber ?? w.pr ?? null, ...fixingPinClear },
        { worker: w.name, issue: w.issue, usd: costUsd, at: doneAt, models: modelUsage },
        fixResponse,
      );
    } else {
      // ESCALATE_NOPR: done but no PR -> nothing to drive; free the lane, escalate to human.
      state.settleTerminalWorker(
        { ...w, state: "done", ended_at: doneAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: doneAt, models: modelUsage },
      );
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
    }
    state.appendEvent("reclaim-done", { worker: w.name, issue: w.issue, next });
    return { kind: "done", worker: w.name, issue: w.issue, next, costUsd, modelUsage };
  }
  if (cls === "FAILED") {
    // #155: leaving `running` either way (rescued to driving, or escalated failed).
    state.clearLiveTelemetry(w.name);
    // #168: environment-failure classification, BEFORE the ordinary has-PR rescue/escalate
    // logic below — deterministic, no LLM (env-failure.ts's classifyEnvFailure is a pure regex
    // match over the lane's own structured error output — worker.ts's extractFailureText, never
    // assistant message content, PR #180 review P1-3). Unconditional on hasPr: decision 1 is
    // "park the engine" regardless of what the failed lane produced.
    const envSource = classifyEnvFailure(p.failureText ?? "", {
      llm: cfg.envFailure.llmPatterns,
      forge: cfg.envFailure.forgePatterns,
    });
    // P1-1b: if THIS lane was the llm episode's canary, settle it first — env-classified means
    // the same episode continues (attempts bumped, entered_at untouched); anything else means
    // the provider is provably back (a real run reached a non-env terminal) and the llm row
    // clears here, before the lane's own disposition below runs as normal.
    settleCanary(state, w.name, envSource != null, iso);
    if (envSource) {
      const reason = summarizeFailureText(p.failureText ?? "");
      state.enterPark(envSource, reason, w.issue, iso());
      state.appendEvent("env-failure", { worker: w.name, issue: w.issue, source: envSource, reason, hasPr: p.hasPr });
    }
    if (envSource && !p.hasPr) {
      // The common/expected shape (issue #168's framing: worker `claude` invocations and
      // worker-side `git push`/`gh pr create` calls fail generically BEFORE any PR exists).
      // Return the issue to Ready UNTOUCHED — no needs-human, no gated-reentry spend (this
      // row's `pr` column stays null, so it can never satisfy gatedFailedWorkers' `pr IS NOT
      // NULL` filter). Reuses the EXISTING durable rollback/requeue machinery (#31) rather
      // than a bespoke write.
      //
      // ORDERING (PR #180 review P2-1): the durable requeue intent is persisted BEFORE the
      // terminal upsertWorker — a crash between the two used to leave the row `failed` (out of
      // runningWorkers(), never re-probed) with NO rollback row: the issue stranded In Progress
      // forever. Persist-first means the worst crash outcome is a duplicate requeue attempt
      // (setBoardStatus to `ready` twice — idempotent on the board), never a stranded issue.
      const rollbackId = state.addPendingRollback(w.issue, "ready", ENV_FAILURE_REQUEUE_REASON, iso());
      // #223: state + spend atomic (settleTerminalWorker), BEFORE attemptRollback's forge/board
      // write. The old code called attemptRollback (awaited) between the terminal upsertWorker
      // and recordSpend — attemptRollback itself never throws (it catches internally), but a
      // hard process crash during that awaited call still used to leave the row terminal with
      // no ledger row. Moving the atomic pair first removes that window entirely.
      const failedAt = iso();
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: failedAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: failedAt, models: modelUsage },
      );
      // SUSPENSION (PR #180 review P1-2): while a FORGE park episode is open, the requeue is
      // NOT attempted — persisting the durable row above is the whole action (zero forge
      // writes while the forge is known-down; the frozen row drains via the ROLLBACK RETRY
      // phase once the forge episode clears). An llm-only park leaves the forge healthy, so
      // the attempt proceeds — the canary needs the issue back in Ready to have anything to
      // dispatch.
      if (state.parkRow("forge") == null) {
        await attemptRollback(
          forge,
          state,
          cfg,
          { id: rollbackId, issue: w.issue, target: "ready", reason: ENV_FAILURE_REQUEUE_REASON, attempts: 0 },
          iso,
        );
      }
      return { kind: "env-failure", worker: w.name, issue: w.issue, source: envSource, costUsd, modelUsage };
    }
    if (envSource && p.hasPr) {
      // A PR already exists — durable work. Clean worktree -> the ordinary rescue-to-driving
      // disposition (below) applies unchanged (it never labels or spends reentry attempts).
      // Dirty worktree (PR #180 review P1-4): env classification takes PRECEDENCE over the #69
      // dirty ⇒ needs-human policy — the dirt is circumstantial to an ENVIRONMENT fault, not
      // evidence of worker error, and the contract says an env-failure never applies
      // needs-human. Preserve everything durably instead: worktree retained on disk (no
      // teardown happens on this path), lane parked `failed` with its PR number and
      // gated_escalation_labeled=0 — the EXISTING #147 fail-closed preservation shape
      // (invisible to gatedFailedWorkers, so zero reentry-cap consumption; manual drive, same
      // as any pre-#147 escalation whose label write failed). ZERO forge writes — no label, no
      // comment (the forge may be the very thing that's down). The park escalation channel is
      // where a human eventually learns about it.
      const retained = supervisor.inspectWorktree(w.name);
      if (retained.worktreeRetained) {
        // #223: state + spend atomic — no forge write in this branch (deliberately ZERO forge
        // calls, see comment above), so only the two-write crash window needed closing.
        const preservedAt = iso();
        state.settleTerminalWorker(
          { ...w, state: "failed", ended_at: preservedAt, pr: p.prNumber ?? w.pr ?? null, gated_escalation_labeled: 0 },
          { worker: w.name, issue: w.issue, usd: costUsd, at: preservedAt, models: modelUsage },
        );
        state.appendEvent("env-failure-preserved", {
          worker: w.name,
          issue: w.issue,
          source: envSource,
          pr: p.prNumber ?? w.pr ?? null,
          worktreePath: retained.worktreePath,
        });
        return { kind: "env-failure", worker: w.name, issue: w.issue, source: envSource, costUsd, modelUsage };
      }
      // Clean + PR: rescue to driving, exactly the ordinary disposition (no label either way).
      // #223: state + spend atomic — no forge write on this path either.
      const rescuedAt = iso();
      state.settleTerminalWorker(
        { ...w, state: "driving", ended_at: rescuedAt, pr: p.prNumber ?? w.pr ?? null, ...fixingPinClear },
        { worker: w.name, issue: w.issue, usd: costUsd, at: rescuedAt, models: modelUsage },
      );
      state.appendEvent("reclaim-failed", { worker: w.name, issue: w.issue, next: "DRIVING" });
      return { kind: "failed", worker: w.name, issue: w.issue, next: "DRIVING", costUsd, modelUsage };
    }
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
    // #223: state + spend atomic (settleTerminalWorker) either way below. The ESCALATE branch's
    // forge writes already ran BEFORE the terminal upsert here (parity with the DEAD path,
    // unchanged) — a thrown label write there aborts before any terminal write lands, so the
    // worker just stays reclaimable next tick. No reordering needed on that side; only the
    // upsertWorker+recordSpend pair itself needed to become one transaction.
    const failedAt = iso();
    if (next === "DRIVING") {
      // Failed but a clean PR exists (e.g. budget-exhausted after opening it): rescue — hold
      // the lane driving for the review gate rather than escalating.
      state.settleTerminalWorker(
        { ...w, state: "driving", ended_at: failedAt, pr: p.prNumber ?? w.pr ?? null, ...fixingPinClear },
        { worker: w.name, issue: w.issue, usd: costUsd, at: failedAt, models: modelUsage },
      );
    } else {
      // Forge work BEFORE the terminal upsert (parity with the DEAD path's ordering). needs-human
      // lands on the PR too, where the merge gate reads labels, when the escalation is dirty-WIP.
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      if (retained?.worktreeRetained) {
        if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);
        await reportRetainedWorktree(forge, state, w.name, w.issue, retained.worktreePath, cfg.labels.needsHuman);
      }
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: failedAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: failedAt, models: modelUsage },
      );
    }
    state.appendEvent("reclaim-failed", { worker: w.name, issue: w.issue, next });
    return { kind: "failed", worker: w.name, issue: w.issue, next, costUsd, modelUsage };
  }
  return null; // KEEP or DEAD — not a terminal sentinel; caller handles it
}

/** #245 round-2 fix A3: crash-window reconciliation for `startFixLeg`'s own two-step protocol
 *  (`supervisor.resume()` FIRST — confirming a spawn via #172's own battle-tested
 *  intent-precedes-spawn running.json dance — THEN `startFixLeg`'s own upsertWorker bumping
 *  `driving` -> `fixing` + `fix_rounds`). A crash between those two steps leaves a `driving` row
 *  with a LIVE, spawn-confirmed fix-leg child the DB doesn't know about — invisible to both
 *  ordinary RECLAIM (scans `running`) and FIXING RECLAIM (scans `fixing`), and critically
 *  invisible to the kill-switch drain (the SAME two sets). Called at the very top of tick(),
 *  BEFORE the kill-switch gate, so a row this reconciles into `fixing` is visible to THAT SAME
 *  tick's drain if the switch happens to be active.
 *
 *  Scans every `driving` row (cheap — normally a handful) and reads
 *  `supervisor.resumeIntentState(name, issue)` — state-agnostic (a plain running.json read), so
 *  it works for a `driving` row exactly as it already does for `handoff` rows elsewhere in this
 *  file:
 *   - "confirmed": a live child exists that the DB doesn't know about. Promote the row to
 *     `fixing` and bump `fix_rounds` — the FIRST and ONLY bump for this round (the crash means
 *     `startFixLeg`'s own bump never landed; a row that reaches this branch was, by
 *     construction, never able to reach it — never double-counts). Dead-proxy adoption: the
 *     adopted child's `--mcp-config` was minted by the CRASHED engine process — its in-process
 *     HTTP listener died with it, and the child's baked-in proxy config can never be fixed
 *     post-spawn. Rather than trust a dead evidence channel (or attempt a live remint/respawn —
 *     out-of-scope machinery), immediately request a graceful handoff: the SAME adopt-then-drain
 *     pattern this file already uses for a stale-but-alive `running` lane after a restart (see
 *     the RECLAIM loop's own `ADOPT` class). The next resume of that handoff (A2's own
 *     fix-continuation RESUME path) mints a FRESH proxy from the CURRENT engine process before
 *     respawning.
 *
 *     #245 round-2 fix (B3): `requestHandoff` is called FIRST, before the upsert/event —
 *     durable (persists `handoff_requested` in running.json) and idempotent, so a crash between
 *     this call and the upsert below is safe: the NEXT tick's reconciliation still finds the row
 *     `driving` with the SAME confirmed intent (the crashed attempt's upsert never landed, so
 *     `fix_rounds` was never bumped) and retries the whole branch — `requestHandoff` is then a
 *     harmless no-op re-signal, and the upsert's bump is still the first and only successful one
 *     for this round. Zero new machinery: this reuses the exact convergent-retry shape the rest
 *     of this reconciliation already relies on.
 *
 *     #245 round-2 fix (B1): also clears a STALE prior-leg `.done`/`.failed` terminal sentinel a
 *     fix-entry `resume()` call may have crashed before removing itself (see that method's own
 *     doc) — otherwise FIXING RECLAIM's very next `probe()` call would misread the PRIOR leg's
 *     sentinel as this live leg's own terminal signal.
 *   - "unconfirmed": intent written, never confirmed (crashed truly mid-spawn — ambiguous
 *     whether a process exists at all; retrying could double-spawn into the same worktree).
 *     Escalate to `needs-human` — the same fail-safe #172's own unconfirmed-handoff ambiguity
 *     takes (escalateUndecidableResume), adapted to a `driving` row's own shape (no
 *     `resume_capped`/handoff semantics apply here). #245 round-2 fix (B4): the label write goes
 *     FIRST — same #69/#147 "forge work before the terminal upsert" rule the rest of this file
 *     follows — and a FAILED label write does NOT terminalize the row at all (never `failed`
 *     with `gated_escalation_labeled: 0`, which would be permanently invisible to BOTH gated
 *     reentry and human triage). The row stays `driving`; the next tick retries the whole
 *     escalation from scratch.
 *   - "none": no resume intent recorded at all — an ordinary `driving` lane #246 may still call
 *     `startFixLeg` on later. Nothing to reconcile. */
async function reconcileDrivingFixIntents(
  forge: IForge,
  state: State,
  supervisor: Supervisor,
  cfg: SapwoodConfig,
  iso: () => string,
): Promise<void> {
  for (const w of state.drivingWorkers()) {
    const intent = supervisor.resumeIntentState(w.name, w.issue);
    if (intent === "confirmed") {
      // #247 F1 (Codex sol-high PR #265 review round 2, P1): captured BEFORE this reconciliation
      // acts on the row at all (before even requestHandoff) — an adopted child's own resume()
      // call already happened in a NOW-CRASHED process, so there is no "before resume()" moment
      // left to observe directly; this is the earliest point THIS process can still capture one.
      // Superseded harmlessly once the eventual drain+fresh-resume produces its own, later
      // (and by construction >=) cursor on the "fix-leg-resumed" event — fixLegJournalCursor
      // picks whichever of the three cursor-bearing events is NEWEST for (worker, fixRounds).
      const journalCursor = state.maxForgeProxyJournalId(w.name);
      // Never trust the adopted child's proxy channel across a crash (see doc above) — drain it
      // gracefully now rather than let it keep running against a dead evidence channel. Ordered
      // FIRST (B3): durable + idempotent, so a crash before the upsert below just re-enters this
      // same branch next tick.
      supervisor.requestHandoff(w.name);
      // B1: consume any stale PRIOR-leg sentinel resume() itself may not have gotten to.
      supervisor.clearStaleFixEntrySentinel(w.name);
      const fixRounds = (w.fix_rounds ?? 0) + 1;
      state.upsertWorker({ ...w, state: "fixing", ended_at: null, fix_rounds: fixRounds });
      state.appendEvent("fix-leg-adopted", { worker: w.name, issue: w.issue, fixRounds, journalCursor });
    } else if (intent === "unconfirmed") {
      // B4: label FIRST; a failed write must NOT terminalize the row — leave it `driving` and
      // retry the whole escalation next tick (never a permanently-stranded failed+unlabeled row).
      try {
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
      } catch (e) {
        state.appendEvent("fix-leg-undecidable-label-failed", { worker: w.name, issue: w.issue, error: String(e) });
        continue;
      }
      state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: 1 });
      state.appendEvent("fix-leg-undecidable", { worker: w.name, issue: w.issue });
    }
    // "none": nothing to reconcile.
  }
}

/** #147 P2 + #246 review round 1 (C1): the SHARED needs-human escalation for a `driving` lane —
 *  label write FIRST (recorded durably via `gated_escalation_labeled` so GATED RECLAIM's
 *  absence-is-a-human-act invariant holds even on a failed write), THEN the terminal upsert,
 *  THEN (only for a lane that's already been through GATED RECLAIM once) the attempt-trail
 *  comment. Extracted so BOTH the plain gate===HUMAN case and #246's own "FIXABLE but the fix
 *  loop isn't wired" degrade (C1 below) go through byte-for-byte the SAME escalation — an
 *  unconfigured fix loop must never silently retry forever where the pre-#246 gate would have
 *  visibly escalated to a human; it degrades to the EXACT same visible escalation instead,
 *  never a parallel path. */
async function escalateNeedsHuman(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  w: WorkerRow,
  pr: number,
  reason: string,
  iso: () => string,
): Promise<DrivenOutcome> {
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
    worker: w.name,
    issue: w.issue,
    pr,
    reason,
    labeled,
    ...(labelError != null ? { labelError } : {}),
  });
  // #147: gated_reentry_attempts > 0 means this lane was reclaimed by GATED RECLAIM at least
  // once (a human removed needs-human believing the finding was fixed) and STILL escalated —
  // leave the attempt trail on the issue so a repeat escalation isn't indistinguishable from
  // the very first one. Never fires for a first-time escalation (attempts is 0 for every lane
  // that's never been through GATED RECLAIM, including #246's own fixLegResume-unwired degrade).
  const gatedAttempts = w.gated_reentry_attempts ?? 0;
  if (gatedAttempts > 0) {
    const cap = cfg.lanes.gatedReentryCap;
    await forge
      .addIssueComment(
        w.issue,
        `sapwood: gated-PR reentry attempt ${gatedAttempts}/${cap} for PR #${pr} ` +
          `re-escalated \`${cfg.labels.needsHuman}\` — ${reason}. ` +
          (gatedAttempts >= cap
            ? // #167 review (Codex P2+P3): cap reached — see capHitEscalationNote's own doc
              // comment for why this is a helper, not inline text.
              capHitEscalationNote(cfg)
            : `Remove \`${cfg.labels.needsHuman}\` again once it's addressed to retry.`),
      )
      .catch(() => {});
  }
  return { kind: "needs-human", worker: w.name, issue: w.issue, pr, reason };
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge, state, supervisor, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const threshold = cfg.worker.heartbeatStaleSecs;

  // #245 round-2 fix A3: reconcile any driving-row fix-leg spawn intent BEFORE the kill-switch
  // gate — see reconcileDrivingFixIntents' own doc for the crash window this repairs.
  await reconcileDrivingFixIntents(forge, state, supervisor, cfg, iso);

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
  const killSwitchActive = state.isKillSwitchActive();
  if (killSwitchActive) {
    // A confirmed resume intent means its child already exists despite the DB still saying
    // `handoff`. Reconcile these rows BEFORE the drain snapshot so the hard safety boundary
    // supervises and drains reality in this same tick; this is adoption, never a spawn.
    const resumed: ResumeOutcome[] = [];
    for (const w of state.handoffWorkers()) {
      if (supervisor.resumeIntentState(w.name, w.issue) !== "confirmed") continue;
      const issue: Issue = { number: w.issue, title: "", labels: [] };
      let result: { name: string; sessionId: string };
      try {
        result = await supervisor.resume(issue, w.name);
      } catch (e) {
        state.appendEvent("resume-failed", { worker: w.name, issue: w.issue, error: String(e) });
        throw e;
      }
      if (result.name !== w.name) {
        throw new Error(`resume returned worker ${result.name}; expected existing lane ${w.name}`);
      }
      const attempt = (w.resume_attempts ?? 0) + 1;
      // #245 round-2 fix (B2b): a fixing-origin handoff adopted here must land back in
      // `fixing`, never `running` — writing `running` unconditionally silently discarded its
      // fix identity (`fixing_handoff` stays 1 on `w`, spread through unchanged below, but a
      // `running`-state row is invisible to the ordinary RESUME phase's fixing_handoff check
      // entirely). Landing it in `fixing` makes it visible to THIS SAME tick's drain loop just
      // below (which now scans running+fixing) — no separate requestHandoff needed here, same
      // as the ordinary (non-fix) adoption case.
      state.upsertWorker({
        ...w,
        session_id: result.sessionId,
        state: w.fixing_handoff === 1 ? "fixing" : "running",
        started_at: iso(),
        ended_at: null,
        resume_attempts: attempt,
      });
      state.appendEvent("resumed", { worker: w.name, issue: w.issue, attempt });
      resumed.push({ kind: "resumed", worker: w.name, issue: w.issue, attempt });
    }
    const reclaimed: ReclaimOutcome[] = [];
    // #245: a `fixing` lane is a LIVE fix-leg worker process — the kill switch's drain/hard-kill
    // contract must supervise it exactly like a `running` lane (worker paradigm); it must never
    // be left spinning just because the engine considers itself "killed".
    for (const w of [...state.runningWorkers(), ...state.fixingWorkers()]) {
      const p = await supervisor.probe(w.name);
      // #245 round-2 fix A5: reclaimTerminalLane itself clears the fixing-origin review-trigger
      // pin atomically (same settleTerminalWorker transaction as the `driving` write) — no
      // separate follow-up call needed here.
      const terminal = await reclaimTerminalLane(forge, state, supervisor, cfg, w, p, threshold, iso);
      if (terminal) {
        reclaimed.push(terminal); // KEEP/DEAD lanes stay running/fixing -> drained below
      }
      // #155: no setLiveTelemetry here for a still-running (KEEP) lane — this branch is drain-
      // only (kill switch engaged); telemetry is left as its last known value until the lane
      // actually leaves `running` (reclaimTerminalLane above, or drainThenEscalate below —
      // both clear it). Refreshing display telemetry mid-drain isn't worth a special case.
    }
    // drainThenEscalate re-reads runningWorkers()+fixingWorkers() AFTER the terminal reclaim
    // above transitioned those lanes out of `running`/`fixing`, so a just-recorded
    // handoff/done/driving lane is never re-touched.
    const { drainRequested, escalated } = await drainThenEscalate(forge, state, supervisor, cfg, ["kill-switch"], now(), iso);
    return {
      reclaimed,
      dispatched: [],
      overBudget: false,
      ceilingBreached: true,
      ceilingReasons: ["kill-switch"],
      drainRequested,
      escalated,
      driven: [],
      rollbacks: [],
      gatedReclaimed: [],
      resumed,
      fixingReclaimed: [],
      fixResponses: [],
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
  // Snapshot before RECLAIM: a lane that writes .handoff during this tick gets one settled
  // terminal beat and becomes resumable on the NEXT tick, never immediately in the same tick.
  const handoffsAtTickStart = state.handoffWorkers();

  // ── ROLLBACK RETRY (#31): retry every board mutation still pending from a prior tick's
  //   recovery-path failure, BEFORE this tick does anything else. Never throws (see
  //   attemptRollback) — a still-failing forge only bumps the retry count or escalates.
  //   #168 SUSPENSION (PR #180 review P1-2): while a FORGE park episode is open, env-failure
  //   requeues are not attempted at all — no forge write, no attempt-counter bump; the durable
  //   rows simply wait (frozen) and drain here on the first tick after the forge episode
  //   clears. Scoped to env-failure requeues only: every OTHER pending rollback keeps its
  //   pre-#168 retry behavior unchanged (its issue's failure was real, and its bounded
  //   retry-then-escalate contract predates parking). Gated on the FORGE row specifically —
  //   an llm-only park leaves the forge healthy, and holding requeues then would starve the
  //   canary of anything to dispatch.
  const rollbacks: RollbackOutcome[] = [];
  const forgeParkedThisTick = state.parkRow("forge") != null;
  for (const pending of state.pendingRollbacks()) {
    if (forgeParkedThisTick && pending.reason === ENV_FAILURE_REQUEUE_REASON) continue; // suspended
    rollbacks.push(await attemptRollback(forge, state, cfg, pending, iso));
  }

  // ── FIX RESPONSE RETRY (#247): same "drain every durably-persisted recovery-path write
  //   before this tick does anything else" convention as ROLLBACK RETRY above, for the
  //   fix-loop's own thread-write queue (fix-response.ts's attemptThreadWrite — reply/resolve
  //   GraphQL calls, never a board mutation). Never throws; a still-failing forge only bumps
  //   the retry count or escalates. Not suspended by a forge park episode the way env-failure
  //   requeues are (#168's SUSPENSION doesn't apply: a resolve/reply failure here has no
  //   "the issue did nothing wrong, hold it open forever" contract — it is bounded-retry-then-
  //   escalate like every OTHER pending rollback).
  const fixResponses: FixResponseWriteOutcome[] = [];
  for (const pending of state.pendingThreadWrites()) {
    fixResponses.push(await attemptThreadWrite(forge, state, cfg, pending, iso));
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
    // #47: the same {costUsd, modelUsage} pair feeds BOTH the eventual settleTerminalWorker
    // spend (the #14 ledger, #223: atomic with the terminal state write) and the reclaimed[]
    // outcome — computed once so the two never drift apart.
    const costUsd = p.costUsd ?? 0;
    const modelUsage = p.modelUsage ?? [];
    const laneClass = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive, p.dispatchedAgeSec, cfg.worker.timeoutSec);
    if (laneClass === "KEEP") {
      // #155: refresh the lane's LIVE per-probe telemetry (priced-cost snapshot, context
      // tokens, token composition) — update-in-place, no history, no per-probe event. Absent
      // (a DETACHED post-restart lane: the new supervisor has no in-memory Lane, so worker.ts
      // returns no snapshot — see probe()) -> CLEAR rather than skip (gate② P2 on PR #161):
      // skipping would leave the PRE-restart trio in place for the lane's whole remaining leg,
      // a frozen number masquerading as live. NULL means "no live data", which is the truth
      // for a detached lane — a number we can no longer refresh must not look live.
      if (p.liveTelemetry) state.setLiveTelemetry(w.name, p.liveTelemetry);
      else state.clearLiveTelemetry(w.name);
      reclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
      continue;
    }
    if (laneClass === "ADOPT") {
      // #169: a restart stopped the engine-owned heartbeat timer, but kill -0 proves the
      // detached wrapper still lives. Ask it to checkpoint through the existing graceful
      // handoff protocol and HOLD the lane while it drains. requestHandoff's persisted flag
      // makes repeated ticks/restarts no-ops; only the first request gets the honesty event.
      if (supervisor.requestHandoff(w.name)) {
        state.appendEvent("lane-adopted", {
          worker: w.name,
          issue: w.issue,
          note: "Spend during engine downtime was unobserved.",
        });
      }
      // A detached lane has no refreshable live telemetry. Keep the ordinary `kept` outcome
      // so adoption adds no new scheduler/result machinery while the lane drains.
      state.clearLiveTelemetry(w.name);
      reclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
      continue;
    }
    // DEAD: stale heartbeat or confirmed-dead wrapper with no sentinel. Always tear the lane
    // down (process-tree kill). If a PR was already opened, rescue it to `driving` rather than
    // requeuing — requeuing would let a second worker race the open PR (Codex R2 P1). Only a
    // dead lane with NO PR is handed back to Ready.
    // #155: leaving `running` regardless of which of the 3 outcomes below lands — clear the
    // LIVE telemetry trio (a crashed lane always passes through here, so this single call
    // covers the "stale telemetry from a dead lane must not survive as live" crash semantics).
    state.clearLiveTelemetry(w.name);
    // #168 P1-1b: a DEAD canary is a terminal state that is NOT env-classified (there is no
    // sentinel/output to classify — a provider outage produces a FAILED sentinel with error
    // text, not a silent crash), so per the canary contract the llm episode resumes. If the
    // provider is in fact still down, the next real dispatch re-classifies and re-parks
    // through the normal FAILED path — bounded, never a silent wedge.
    settleCanary(state, w.name, false, iso);
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
    // #223: state + spend atomic (settleTerminalWorker) in every branch below. The retained-
    // worktree branch's forge writes already ran BEFORE the terminal upsert (unchanged — a
    // thrown label write there aborts before any terminal write lands). The else branch used to
    // call attemptRollback (awaited forge/board write) BETWEEN the terminal upsertWorker and the
    // trailing recordSpend at the end of the loop body — same crash-window bug named in #223,
    // just reached via the DEAD path rather than a terminal sentinel. Fixed the same way: settle
    // state+spend first, attempt the rollback after.
    // Usually 0 (a DEAD lane has no terminal sentinel to parse a cost from) but record whatever
    // the probe knows — harmless, and future probes may recover a partial cost.
    const deadAt = iso();
    if (r.worktreeRetained) {
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);
      await reportRetainedWorktree(forge, state, w.name, w.issue, r.worktreePath, cfg.labels.needsHuman);
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: deadAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
      // No requeue to Ready: an open PR must not be raced by a fresh worker, and a no-PR dirty
      // lane is a human-salvage case (needs-human already blocks re-dispatch), not a clean
      // re-dispatch. The retained worktree + needs-human hold it for human triage.
    } else if (rescued) {
      state.settleTerminalWorker(
        { ...w, state: "driving", ended_at: deadAt, pr: p.prNumber ?? w.pr ?? null },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
    } else {
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: deadAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
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
          forge,
          state,
          cfg,
          { id: rollbackId, issue: w.issue, target: "ready", reason: "dead-lane-requeue", attempts: 0 },
          iso,
        ),
      );
    }
    state.appendEvent("reclaim-dead", { worker: w.name, issue: w.issue, rescued });
    reclaimed.push({ kind: "dead", worker: w.name, issue: w.issue, rescued, costUsd, modelUsage });
  }

  // ── FIXING RECLAIM (#245): a `fixing` lane is a LIVE fix-leg worker process (worker
  //   paradigm) — same heartbeat/timeout/soft-budget supervision as an ordinary `running` lane,
  //   deliberately NOT #170's review-silence escalation: that clock only ever fires from inside
  //   the DRIVE loop below, which iterates state.drivingWorkers() — a `fixing` lane is never a
  //   member of that set (fixingWorkers()' own doc), so silence escalation structurally cannot
  //   arm here. DONE/FAILED terminal handling reuses reclaimTerminalLane verbatim — identical
  //   env-failure classification, dirty-worktree retention, and has-PR rescue-to-`driving`
  //   disposition to the ordinary RECLAIM loop above. The ONE thing unique to a fixing-origin
  //   lane — clearing the review-trigger pin the instant it lands back in `driving`, ATOMICALLY
  //   with that same state write (#245 round-2 fix A5) — is now handled INSIDE
  //   reclaimTerminalLane itself (via its own `fixingPinClear`, derived from `w.state ===
  //   "fixing"`), reusing driveOne's own re-trigger machinery exactly the way #147's GATED
  //   RECLAIM does.
  const fixingReclaimed: ReclaimOutcome[] = [];
  for (const w of state.fixingWorkers()) {
    const p = await supervisor.probe(w.name);
    const terminal = await reclaimTerminalLane(forge, state, supervisor, cfg, w, p, threshold, iso);
    if (terminal) {
      fixingReclaimed.push(terminal);
      continue;
    }
    const costUsd = p.costUsd ?? 0;
    const modelUsage = p.modelUsage ?? [];
    const laneClass = classifyLane(p.done, p.failed, p.hbAge, threshold, p.wrapperAlive, p.dispatchedAgeSec, cfg.worker.timeoutSec);
    if (laneClass === "KEEP") {
      if (p.liveTelemetry) state.setLiveTelemetry(w.name, p.liveTelemetry);
      else state.clearLiveTelemetry(w.name);
      fixingReclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
      continue;
    }
    if (laneClass === "ADOPT") {
      if (supervisor.requestHandoff(w.name)) {
        state.appendEvent("lane-adopted", { worker: w.name, issue: w.issue, note: "Spend during engine downtime was unobserved." });
      }
      state.clearLiveTelemetry(w.name);
      fixingReclaimed.push({ kind: "kept", worker: w.name, issue: w.issue });
      continue;
    }
    // DEAD: crashed with no terminal sentinel. Kill the tree; a fixing lane always already
    // carries a PR (inherited from `driving`) — a dirty worktree overrides the rescue (same #69
    // policy as the ordinary DEAD path), otherwise rescue straight back to `driving` with the
    // pin cleared exactly like the terminal path above.
    state.clearLiveTelemetry(w.name);
    const r = await supervisor.reclaim(w.name);
    const deadAt = iso();
    if (r.worktreeRetained) {
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);
      await reportRetainedWorktree(forge, state, w.name, w.issue, r.worktreePath, cfg.labels.needsHuman);
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: deadAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
    } else if (p.hasPr) {
      state.settleTerminalWorker(
        {
          ...w,
          state: "driving",
          ended_at: deadAt,
          pr: p.prNumber ?? w.pr ?? null,
          review_triggered_head: null,
          review_triggered_at: null,
        },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
    } else {
      // Fail-safe only — a fixing lane should never lack a PR; treat like any other no-PR dead
      // lane: escalate rather than silently drop the fix attempt.
      await forge.addLabel(w.issue, cfg.labels.needsHuman);
      state.settleTerminalWorker(
        { ...w, state: "failed", ended_at: deadAt },
        { worker: w.name, issue: w.issue, usd: costUsd, at: deadAt, models: modelUsage },
      );
    }
    const rescued = p.hasPr && !r.worktreeRetained;
    state.appendEvent("reclaim-dead", { worker: w.name, issue: w.issue, rescued });
    fixingReclaimed.push({ kind: "dead", worker: w.name, issue: w.issue, rescued, costUsd, modelUsage });
  }

  // ── GATED RECLAIM (#147): a failed lane that DRIVE escalated (gate②/mergeDecision
  //   needs-human — the ONLY "failed + a PR number" shape, see gatedFailedWorkers' doc) whose
  //   ISSUE carries NONE of cfg.escalation.humanLabels (round-4 P2: the FULL human-hold set,
  //   default [needs-human, blocked] — dispatch's exact standard, not needs-human alone) is a
  //   human's EXPLICIT act (PLAN.md autonomy principle: only an explicit human act re-admits
  //   automation) that the finding was addressed. Reclaim it straight back to `driving` —
  //   same worker row, same PR/branch, no
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
      // Round-4 P2 (Codex PR #151): eligibility requires ZERO of cfg.escalation.humanLabels on
      // the issue — the SAME standard (and the same hasReserveLabel helper) dispatch applies in
      // orderForDispatch. needsHuman alone would let an issue still carrying `blocked` reclaim
      // and drive to merge (the merge driver's human-label veto reads the PR's labels, not the
      // issue's) the moment needs-human was removed.
      // #248 review round 1 (G1): ALSO require ZERO of cfg.escalation.holdLabels on the issue —
      // reusing the SAME already-fetched `labels` array (no new forge read) and the SAME exact-
      // match hasReserveLabel helper. See gatedReentryDecision's own doc for the full rationale
      // (a fix-round-capped, needs-human-escalated lane that a human puts an issue-level hold on
      // while investigating must not reclaim just because needs-human clears first).
      const decision = gatedReentryDecision(
        hasReserveLabel(labels, cfg.escalation.humanLabels),
        hasReserveLabel(labels, cfg.escalation.holdLabels),
        attempts,
        cfg.lanes.gatedReentryCap,
      );
      if (decision === "SKIP") continue; // a human hold still stands — no complete human act yet
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
            worker: w.name,
            issue: w.issue,
            pr,
            attempts,
            error: String(e),
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
        ...w,
        state: "driving",
        ended_at: iso(),
        review_triggered_head: null,
        review_triggered_at: null,
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
  // #246: the SAME round-budget read the DISPATCH phase re-derives later this tick (line below
  // marked "Shared fresh-spend gates for RESUME + DISPATCH") — a fix leg is itself a fresh
  // Claude worker leg (startFixLeg -> supervisor.resume), so a FIXUP dispatch must observe the
  // identical post-reclaim round-spend gate a brand-new coding-worker dispatch does (zero new
  // accounting machinery, per #246's own AC). Pure/cheap (just deps.roundSpendUsd() vs the cap,
  // same as the later read) — evaluating it again here, right where DRIVE needs it, is safe;
  // nothing in between mutates the round ledger.
  const driveOverBudget = budgetExceeded(deps.roundSpendUsd?.() ?? 0, cfg.cost.roundBudgetUsd);
  // #246 review round 2 (E1, Codex sol-high PR #264 delta): a FIXUP dispatch must observe the
  // SAME admission gates RESUME/DISPATCH do (pause / ceiling / park / run-spend-stop), not just
  // the round budget above — but DRIVE makes a remote gate.driveOne call per driving lane and can
  // run long, so round 1's approach (snapshot everything ONCE before the loop) can go stale
  // mid-loop: wall-clock keeps elapsing even when no spend banks, so a LATER lane could see a
  // stale "not breached" right as the real ceiling crosses — and the CEILING/DISPATCH sections
  // below, which round 1 had reuse that same stale snapshot, would drain/gate on an OLDER value
  // than their pre-#246 positions ever gave them. Fix: memoize ONLY the side-effecting piece —
  // `state.engineSessionStart` WRITES on every call (advances last_tick_at, resets started_at
  // past the stale gap), so it must run exactly once per tick — and re-derive the (pure, cheap)
  // ceiling reasons FRESH, with a fresh `now()`, at EVERY consumption point via
  // `ceilingReasonsAsOf` below: the fixable case's own admission check (per lane, inside the
  // loop), the CEILING section at its original position, and the DISPATCH gate. Same stance for
  // `runSpendStopCrossed` — a cheap callback, called fresh at each admission point rather than
  // snapshotted once. `parkedBeforeProbes` stays a single up-front snapshot: `state.isParked()`
  // has no side effects, and nothing between here and PARK's own later re-check mutates park
  // state within the same tick (unlike wall-clock time, which elapses regardless) — no
  // staleness risk, so hoisting it is genuinely safe, unlike the ceiling snapshot was.
  const engineSessionStartDate = state.engineSessionStart(now(), engineSessionGapSec(deps.tickIntervalSec ?? 0));
  const ceilingReasonsAsOf = (asOf: Date): CeilingReason[] =>
    evaluateCeiling({
      dailySpendUsd: state.dailySpendUsd(asOf),
      dailyBudgetUsd: cfg.cost.dailyBudgetUsd,
      wallClockElapsedSec: (asOf.getTime() - engineSessionStartDate.getTime()) / 1000,
      maxWallClockSec: cfg.cost.maxWallClockSec,
    });
  const parkedBeforeProbes = state.isParked();
  if (gate) {
    // #69: no per-lane kill-switch re-check here — an active switch never reaches this loop
    // at all (the global gate at the top of tick() returns first). See the gate's comment for
    // the accepted mid-tick trade-off.
    // #247 D5 (Codex sol-high PR #265 review round 1, P2): every lane with a pending thread
    // write, fetched ONCE before the loop (not per-lane — state.pendingThreadWrites() is a
    // single small table scan, cheaper than re-querying inside the loop). A `fixing` lane that
    // just landed back in `driving` this SAME tick may still have replies/resolves queued but
    // not yet executed (the FIX RESPONSE RETRY phase ran BEFORE this tick's RECLAIM, so a batch
    // enqueued during RECLAIM waits for the NEXT tick's retry phase) — driving it through
    // gate② NOW would evaluate against a STALE live view (GitHub still shows the thread
    // unresolved) and, once #246's FIXABLE gate is wired, could burn a fix round or hit its cap
    // for work the engine simply hasn't gotten to yet.
    const pendingThreadWriteWorkers = new Set(state.pendingThreadWrites().map((r) => r.worker));
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
      if (pendingThreadWriteWorkers.has(w.name)) {
        // Skip gate①/gate② entirely THIS tick — never touches the review-trigger pin, never
        // calls gate.driveOne. The lane stays `driving`; the NEXT tick's FIX RESPONSE RETRY
        // phase (or a later one, if it's still retrying) drains the queue, and DRIVE picks the
        // lane back up automatically once nothing is pending for it.
        state.appendEvent("drive-thread-writes-pending", { worker: w.name, issue: w.issue, pr });
        driven.push({ kind: "thread-writes-pending", worker: w.name, issue: w.issue, pr });
        continue;
      }
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
        const alreadyAnnounced = last != null && last.kind === evKind && last.mode === t.mode && last.pr === pr && last.head === t.head;
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
      // #170: visibility-only escalation. MergeDriver has already proved this is the current
      // head, non-decisive, past both the silence threshold and any active failover window.
      // The PR label is the latch: once it lands, the next live gate read sees it and follows
      // the existing HUMAN -> gated-reentry path. This tick remains queued/driving.
      if (outcome.reviewSilenceEscalation) {
        const s = outcome.reviewSilenceEscalation;
        let labeled = false;
        try {
          await forge.addPRLabel(pr, cfg.labels.needsHuman);
          labeled = true;
        } catch {
          // No label means no latch: retry next tick. Never let a visibility-write outage stop
          // review polling or turn a queued gate into a terminal lane transition.
        }
        if (labeled) {
          state.appendEvent("review-silence-escalated", {
            worker: w.name,
            issue: w.issue,
            pr,
            head: s.head,
            silenceSec: s.silenceSec,
          });
        }
      }
      switch (outcome.kind) {
        case "merged":
          state.upsertWorker({ ...w, state: "done", ended_at: iso() });
          await forge.setBoardStatus(w.issue, "done");
          state.appendEvent("merged", { worker: w.name, issue: w.issue, pr, headOid: outcome.headOid });
          driven.push({ kind: "merged", worker: w.name, issue: w.issue, pr });
          break;
        case "needs-human":
          // #147 P2 (Codex PR #151): the label write goes FIRST, and its success is recorded
          // durably on the terminal row (gated_escalation_labeled) — because GATED RECLAIM's
          // re-entry signal is "the needs-human label is ABSENT", absence is only evidence of a
          // human act if the engine provably APPLIED the label. See escalateNeedsHuman's own doc
          // (shared with #246's fixLegResume-unwired degrade, C1) for the full rationale.
          driven.push(await escalateNeedsHuman(forge, state, cfg, w, pr, outcome.reason, iso));
          break;
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
        case "fixable": {
          // #246: gate === FIXABLE (findings or CI-red, alongside a decisive verdict) in
          // conductor-merge mode (produce-pr-and-stop already short-circuited to "stopped" inside
          // MergeDriver.driveOne itself — this branch only ever sees the mode that actually acts).
          // driveDecision owns the fix_rounds/cap/budget refinement this pure PR-level outcome
          // never carries — fed from THIS lane's own WorkerRow.fix_rounds, cfg.lanes.prFixCap,
          // and the round-budget read captured once above the DRIVE loop (driveOverBudget).
          const fixRounds = w.fix_rounds ?? 0;
          const cap = cfg.lanes.prFixCap;
          const action = driveDecision("FIXABLE", fixRounds, cap, driveOverBudget);
          if (action === "FIXUP") {
            if (!deps.fixLegResume) {
              // #246 review round 1 (C1, PM-narrowed): an unwired fix loop must DEGRADE to the
              // exact pre-#246 escalation (visible needs-human), never a silent retry-forever —
              // with the default prFixCap > 0 and no production caller wiring fixLegResume yet
              // (a documented, separate #253 startup-wiring gap), the OLD behavior here was
              // "stays driving, queued" every tick: a findings PR would silently loop forever
              // instead of the pre-#246 HANDLE_THREADS -> HUMAN escalation an operator could
              // actually see and act on. Wiring a real mintProxy into cli.ts/round.ts is
              // explicitly OUT of scope for this PR (#253's own deliverable) — this only makes
              // today's unwired default fail-SAFE and VISIBLE instead of fail-silent.
              const reason = `fix-loop-unwired:${outcome.reason}`;
              state.appendEvent("fix-leg-dispatch-unconfigured", { worker: w.name, issue: w.issue, pr, reason });
              driven.push(await escalateNeedsHuman(forge, state, cfg, w, pr, reason, iso));
              break;
            }
            // #246 review round 1 (C2) + round 2 (E1): a FIXUP dispatch spawns a FRESH paid
            // Claude worker leg (startFixLeg -> supervisor.resume) — it must pass the SAME
            // new-leg admission gate RESUME/DISPATCH do (pause / ceiling breach / environment
            // park / run-spend-stop), not just the round budget driveDecision already folded in
            // above. A wind-down must drain, never start a brand-new fix leg instead. Blocked ->
            // stays driving, retried next tick (transient); the gate derivation itself already
            // ran (this only gates the spawn). Ceiling/run-spend-stop are read FRESH here (E1),
            // not from a pre-DRIVE-loop snapshot — DRIVE can run long across many lanes, and
            // wall-clock keeps elapsing regardless of spend, so a snapshot taken before the loop
            // started could be stale by the time a LATER lane reaches this check.
            const admissionBlock = fixLegAdmissionBlockReason({
              paused,
              ceilingBreached: ceilingReasonsAsOf(now()).length > 0,
              parkActive: parkedBeforeProbes,
              overBudget: driveOverBudget,
              runSpendStop: deps.runSpendStopCrossed?.() ?? false,
            });
            if (admissionBlock != null) {
              const reason = `fix-leg-admission-blocked:${admissionBlock}`;
              state.appendEvent("fix-leg-dispatch-blocked", { worker: w.name, issue: w.issue, pr, blockReason: admissionBlock });
              driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason });
              break;
            }
            try {
              await startFixLeg(
                { state, supervisor, renderFixPrompt: deps.fixLegResume.renderFixPrompt },
                w,
                { mint: deps.fixLegResume.mintProxy, credentialFree: true },
                now,
              );
              state.appendEvent("drive-fixup", { worker: w.name, issue: w.issue, pr, fixRounds: fixRounds + 1, reason: outcome.reason });
              driven.push({ kind: "fixup", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
            } catch (e) {
              // startFixLeg's own contract (#245): a thrown resume() leaves the row untouched
              // (still `driving`, fix_rounds un-incremented) — a transient spawn failure costs
              // zero fix-round budget, and the next tick's gate simply retries. Never crash the
              // DRIVE loop over it (same never-throws stance every other DRIVE branch keeps).
              state.appendEvent("fix-leg-dispatch-failed", { worker: w.name, issue: w.issue, pr, error: String(e) });
              driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: `fix-leg-dispatch-failed: ${String(e)}` });
            }
            break;
          }
          // action === "ESCALATE": either a transient this-tick budget block (retry next tick,
          // no state change), or the fix_rounds cap is genuinely exhausted (permanent escalation
          // — #147's GATED RECLAIM is the post-adjudication reentry channel back in).
          if (driveOverBudget) {
            state.appendEvent("drive-queued", { worker: w.name, issue: w.issue, pr, reason: `fix-leg-over-budget:${outcome.reason}` });
            driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: `fix-leg-over-budget:${outcome.reason}` });
            break;
          }
          // Cap exhausted. Hard rule (#69/#147 forge-before-terminal-upsert): the needs-human
          // label AND the escalation comment (naming rounds spent + the standing signal) land
          // BEFORE the terminal upsert. A label-write failure leaves the row untouched (still
          // `driving`, no latch) so next tick's fresh FIXABLE-at-cap re-derivation retries the
          // label write from scratch — never a permanently-invisible row from a transient write
          // hiccup (unlike the ordinary needs-human case above, which already owns a PR and so
          // has no "stay driving" fallback; a cap-exhausted lane still does).
          try {
            await forge.addLabel(w.issue, cfg.labels.needsHuman);
          } catch (e) {
            state.appendEvent("fix-rounds-cap-label-failed", { worker: w.name, issue: w.issue, pr, error: String(e) });
            driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: "fix-rounds-cap-label-failed" });
            break;
          }
          // #246 review round 1 (C3): the escalation COMMENT gets the same treatment as the
          // label — the issue's own AC ("label AND comment land before the terminal upsert")
          // means a transient comment-post failure must not be silently swallowed by a bare
          // `.catch(() => {})` right before a terminal upsert that would otherwise permanently
          // lose the adjudication context (which findings remain, rounds spent). On failure,
          // leave the row `driving` (no upsert, no latch) and retry the WHOLE branch next tick.
          // No durable idempotency marker (PM ruling): a re-attempt re-posts the label (harmless
          // — GitHub's addLabel is idempotent) and, if the FIRST comment actually landed but a
          // crash struck before this function returned, also re-posts the comment — a harmless
          // duplicate re-poke, not a correctness issue, so no new dedup machinery for it.
          try {
            await forge.addIssueComment(
              w.issue,
              `sapwood: fix-round cap (${cap}) reached for PR #${pr} — ${fixRounds} round(s) spent, ` +
                `standing disagreement unresolved (${outcome.reason}). Escalating to \`${cfg.labels.needsHuman}\` for ` +
                `adjudication: review the disagreement, then remove the label once resolved to reclaim the PR (#147 gated reentry).`,
            );
          } catch (e) {
            state.appendEvent("fix-rounds-cap-comment-failed", { worker: w.name, issue: w.issue, pr, error: String(e) });
            driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: "fix-rounds-cap-comment-failed" });
            break;
          }
          state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: 1 });
          state.appendEvent("fix-rounds-capped", { worker: w.name, issue: w.issue, pr, fixRounds, cap });
          driven.push({ kind: "needs-human", worker: w.name, issue: w.issue, pr, reason: `fix-rounds-cap:${fixRounds}/${cap}` });
          break;
        }
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
  //   lanes.roundDispatchCap (default 2) × worker.budgetUsdSoft, plus the wall-clock tier.
  //   #246 review round 2 (E1): re-derived FRESH here via `ceilingReasonsAsOf` (a fresh `now()`,
  //   same as pre-#246) rather than reusing a pre-DRIVE-loop snapshot — see that helper's own
  //   comment (above the DRIVE loop) for why a snapshot taken before a potentially-long DRIVE
  //   loop would be stale here. Only `state.engineSessionStart`'s own WRITE is memoized
  //   (must run exactly once per tick); this evaluation itself is exactly as fresh as before
  //   #246 ever touched this section. ──
  const nowDate = now();
  const ceilingReasons = ceilingReasonsAsOf(nowDate);
  const ceilingBreached = ceilingReasons.length > 0;
  let drainRequested: string[] = [];
  let escalated: string[] = [];
  if (ceilingBreached) {
    ({ drainRequested, escalated } = await drainThenEscalate(forge, state, supervisor, cfg, ceilingReasons, nowDate, iso));
  } else {
    // Resolved (daily cap rolled to a fresh day / wall-clock cfg raised / kill switch
    // lifted before this tick) -> clear so a future re-breach starts a fresh drain window.
    state.clearCeilingBreach();
  }

  // ── PARK (#168): environment-failure self-healing, per source (PR #180 review P1-1). Read
  //   fresh HERE — after RECLAIM/GATED RECLAIM/DRIVE above (any of which may have just entered
  //   or settled an episode via reclaimTerminalLane) and exactly at the point the DISPATCH gate
  //   below consults it — same-tick window rule (doctrine): never a pre-tick scalar snapshot.
  //   Dispatch resumes only when ZERO episodes remain.
  //
  //   forge source: the cheap IForge read is a GENUINE recovery signal — success clears the
  //   forge episode outright, failure bumps the backoff.
  //   llm source (P1-1 design change, amended to a real ping): the probe is a minimal
  //   inference ping on the cheapest model (worker.ts's probeLlmPing) — it proves network +
  //   auth + some account capacity, but NOT that the WORKER's model/tier has quota
  //   (model-specific caps, primary-model-only overload), so it is NEVER a recovery signal —
  //   it only GATES a canary. When the backoff interval elapses AND the ping succeeds AND no
  //   forge episode is open (a canary needs the forge to claim its issue) AND no canary is
  //   already in flight, the dispatch phase below is allowed exactly ONE lane. The llm episode clears only when that canary
  //   reaches a non-env-classified terminal state (settleCanary, reclaim phase); a canary that
  //   env-fails CONTINUES the same episode — entered_at/escalated_at preserved, backoff grown —
  //   so the duration escalation accrues on wall-clock since FIRST entry, and the per-cycle
  //   cost is one canary per backoff step, never a full-width redispatch oscillation.
  //
  //   Escalation is per episode, duration-based (not probe count), additive — probing and
  //   auto-resume continue unaffected either side of it.
  let canaryBudget = 0;
  // #168 P2-B: parked-ness is ALSO captured before the probes run — see the dispatch gate
  // below: a recovery observed by THIS tick's probes takes effect NEXT tick, never this one.
  // #246 review round 1 (C2): `parkedBeforeProbes` is now hoisted above the DRIVE loop (a cheap,
  // side-effect-free read — same value either way) so a FIXUP dispatch can observe it too.
  {
    const forgeEpisode = state.parkRow("forge");
    if (forgeEpisode) {
      const backoffSec = probeBackoffSec(forgeEpisode.probeAttempts, cfg.envFailure.probeBackoffBaseSec, cfg.envFailure.probeBackoffMaxSec);
      if (probeDue(forgeEpisode.lastProbeAt, nowDate.getTime(), backoffSec)) {
        const success = await probeForgeReachable(forge);
        if (success) {
          state.clearPark("forge"); // also clears the local escalation marker when last row (P2-2)
          state.appendEvent("park-resumed", { source: "forge", enteredAt: forgeEpisode.enteredAt });
        } else {
          state.bumpParkProbe("forge", iso());
        }
        state.appendEvent("park-probe", {
          source: "forge",
          success,
          attempts: success ? forgeEpisode.probeAttempts : forgeEpisode.probeAttempts + 1,
        });
      }
    }
    const llmEpisode = state.parkRow("llm");
    // Disabled-consumer rule (doctrine): the ping probe only runs when a caller actually
    // wired one (deps.probeLlmReachable) — with none wired, tick() does not touch the llm
    // episode at all (no bump, no event, no canary) rather than recording a synthetic
    // always-failing attempt; the duration escalation still fires regardless. Also skipped
    // while a canary is already in flight — its terminal settlement (settleCanary) is the only
    // thing that can advance the episode then.
    //
    // #168 P1-A: the llm ping is PAID (~$0.016/ping, a real API call) — it is suppressed while
    // a hard cost/wall-clock ceiling breach is active (the engine is draining for SPEND
    // reasons; a safety boundary must not itself keep spending) and while dispatch is PAUSED
    // (pause blocks the canary the ping exists to unlock, so a green ping would be pure spend
    // with no consumer — the disabled-consumer rule again). The FREE forge read-probe above
    // keeps running in both states, and the kill switch needs no gate here: an active switch
    // returns from the top of tick() before this section ever runs. Duration escalation is
    // unaffected either way.
    if (llmEpisode && llmEpisode.canaryWorker == null && deps.probeLlmReachable && !ceilingBreached && !paused) {
      const backoffSec = probeBackoffSec(llmEpisode.probeAttempts, cfg.envFailure.probeBackoffBaseSec, cfg.envFailure.probeBackoffMaxSec);
      if (probeDue(llmEpisode.lastProbeAt, nowDate.getTime(), backoffSec)) {
        const raw = await deps.probeLlmReachable();
        const pingOk = typeof raw === "boolean" ? raw : raw.ok;
        // Amendment 2: on failure, the probe's own first error line rides along in the event —
        // an operator reading the ledger can tell "provider still down" (429/overloaded) from
        // a local misconfiguration ("Exceeded USD budget" -> probeMaxBudgetUsd too low;
        // "unknown option" -> CLI too old for the ping's flags).
        const pingDetail = typeof raw === "boolean" ? undefined : raw.detail;
        state.appendEvent("park-probe", {
          source: "llm",
          success: pingOk,
          attempts: pingOk ? llmEpisode.probeAttempts : llmEpisode.probeAttempts + 1,
          ...(!pingOk && pingDetail != null ? { reason: pingDetail } : {}),
        });
        if (!pingOk) {
          // Ping failed (network/auth/CLI/no capacity at all) — no canary spent, backoff grows.
          state.bumpParkProbe("llm", iso());
        } else {
          // Ping green: pace the next check (touch, NOT bump — the exponent only grows on a
          // FAILED outcome) and, forge permitting, arm exactly one canary for DISPATCH below.
          state.touchParkProbe("llm", iso());
          if (state.parkRow("forge") == null) canaryBudget = 1;
        }
      }
    }
    // Escalation per episode (re-read post-probe: a just-resumed episode must not escalate).
    for (const episode of state.parkedSources()) {
      if (
        episode.escalatedAt == null &&
        parkDurationExceededSec(episode.enteredAt, nowDate.getTime(), cfg.envFailure.parkEscalateAfterSec)
      ) {
        await escalatePark(forge, state, cfg, episode, state.parkRow("forge") != null, iso, deps.log);
      }
    }
  }
  // #168 P2-B (PR #180 round 3): a recovery observed by THIS tick's probes takes effect NEXT
  // tick, not this one — `parkActive` ORs the pre-probe capture with the post-probe read, so a
  // forge probe that just succeeded leaves this tick's dispatch gated. Rationale: env-failure
  // requeues suspended by the forge outage drain in the ROLLBACK RETRY phase, which runs at
  // the TOP of a tick — before this tick's probes could have cleared the episode — so a
  // same-tick resume would fill the lanes with whatever else was Ready while the outage
  // VICTIM's requeue only lands next tick. Deferring one tick makes the next tick's ordering
  // (rollback retry, THEN dispatch) do the fairness work with zero new machinery. The one
  // same-tick resume that remains legal: an llm episode cleared by its CANARY during this
  // tick's own RECLAIM phase (before the pre-probe capture) — safe, because an llm-only park
  // never suspends requeues (they were attempted inline, forge healthy). The canary path
  // itself still needs `parkActive` true + `canaryBudget` to open the loop for exactly one
  // lane.
  const parkActive = parkedBeforeProbes || state.isParked();

  // Shared fresh-spend gates for RESUME + DISPATCH. Both launch a Claude worker leg, so both
  // observe pause/park/ceiling and post-reclaim round/run spend at this exact point.
  const dispatched: DispatchOutcome[] = [];
  const overBudget = budgetExceeded(deps.roundSpendUsd?.() ?? 0, cfg.cost.roundBudgetUsd);
  const runSpendStop = deps.runSpendStopCrossed?.() ?? false;

  // ── RESUME (#172): recover terminal handoff lanes before admitting fresh Ready work ──
  // Same issue/worker/session/worktree, board remains In Progress. A successful resume becomes
  // an ordinary `running` lane, so the next tick's RECLAIM supervision reattaches automatically.
  // Attempts are successful reentries (not spawn failures), bounded by worker.maxResumes.
  const resumed: ResumeOutcome[] = [];
  let resumeLanesUsed = state.activeWorkers().length;
  const resumeSpendPaused = paused || ceilingBreached || parkActive || overBudget || runSpendStop;
  for (const w of handoffsAtTickStart) {
    const attempts = w.resume_attempts ?? 0;
    const intentState = supervisor.resumeIntentState(w.name, w.issue);
    // Confirmed adoption ignores human holds and needs no forge context: the child already
    // exists, and DB supervision must catch up even while forge access/spend is gated.
    const labels = intentState === "confirmed" ? [] : await forge.getIssueLabels(w.issue);
    const decision = resumeDecision(
      resumeSpendPaused,
      killSwitchActive,
      hasReserveLabel(labels, cfg.escalation.humanLabels),
      intentState === "confirmed",
      intentState === "unconfirmed",
      attempts,
      cfg.worker.maxResumes,
      resumeLanesUsed,
      cfg.lanes.max,
    );
    if (decision === "SKIP") continue;
    if (decision === "UNDECIDABLE") {
      const outcome = await escalateUndecidableResume(forge, state, cfg, w, attempts, iso);
      if (outcome) resumed.push(outcome);
      continue;
    }
    if (decision === "CAPPED") {
      // Gated-reentry's label-first/latch-second pattern: a transient label failure leaves the
      // row eligible so the next tick retries; never permanently hide an unlabeled handoff.
      try {
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
      } catch (e) {
        state.appendEvent("resume-capped-label-failed", {
          worker: w.name,
          issue: w.issue,
          attempts,
          error: String(e),
        });
        continue;
      }
      await forge
        .addIssueComment(
          w.issue,
          `sapwood: worker resume cap (${cfg.worker.maxResumes}) reached after ${attempts} ` +
            `resumed leg(s) — re-applying \`${cfg.labels.needsHuman}\`. The preserved worktree ` +
            `and session require a human decision before continuing.`,
        )
        .catch(() => {});
      state.upsertWorker({ ...w, ended_at: iso(), resume_capped: 1 });
      state.appendEvent("resume-capped", { worker: w.name, issue: w.issue, attempts });
      resumed.push({ kind: "capped", worker: w.name, issue: w.issue, attempts });
      continue;
    }
    const issue: Issue = {
      number: w.issue,
      // The resumed Claude session already owns the original issue context. Refresh the fields
      // available through IForge so configurable prompts still receive live body/labels.
      title: "",
      labels,
      // Adoption returns before worker.ts renders a prompt, so avoid a forge read that can
      // strand an already-running child during forge park. Fresh RESUME still refreshes it.
      ...(decision === "ADOPT" ? {} : { body: await forge.getIssueBody(w.issue) }),
    };
    // #245 round-2 fix A2: a handoff row whose PRIOR state was `fixing` (reclaimTerminalLane's
    // `fixing_handoff` marker) must resume as a FIX continuation — fix prompt + mandatory
    // credentialFree proxy + target state `fixing` — never silently as an ordinary leg (wrong
    // prompt, no proxy, ambient credentials, wrong state). Bumps ONLY resume_attempts, never
    // fix_rounds: this is a continuation of the SAME fix leg, not a new rework round.
    if (w.fixing_handoff === 1) {
      if (!deps.fixLegResume) {
        // Fail-closed: never silently resume a fix-leg-origin handoff as an ordinary leg just
        // because the caller hasn't wired this dependency yet. Left in `handoff`, retried every
        // tick until configured — same "skip, don't corrupt" stance an unconfigured mergeGate
        // takes for driving lanes.
        state.appendEvent("fix-leg-resume-unconfigured", { worker: w.name, issue: w.issue });
        continue;
      }
      if (w.pr == null) {
        // Fail-safe only — a fixing-origin handoff should always carry a PR (inherited from
        // `driving`). Escalate rather than silently drop the fix attempt or guess a PR number.
        await forge.addLabel(w.issue, cfg.labels.needsHuman).catch(() => {});
        state.upsertWorker({ ...w, ended_at: iso() });
        state.appendEvent("fix-leg-resume-no-pr", { worker: w.name, issue: w.issue });
        continue;
      }
      const pr = w.pr;
      // #245 round-2 fix (B2a): `decision === "ADOPT"` means a live child ALREADY exists from a
      // PRIOR resume() call that confirmed a spawn before this engine crashed — its proxy (if
      // any) was minted by that now-dead process and can never be trusted, the same "never trust
      // a cross-crash proxy" stance reconcileDrivingFixIntents takes for the driving-row entry
      // case. Adopt it via resume()'s own confirmed-intent early return (it never even looks at
      // proxy/prompt opts on that path — no fresh mint is attempted), then immediately drain it
      // gracefully rather than bless it as a healthy continuation. `fixing_handoff` STAYS 1 so
      // the NEXT handoff/resume cycle re-mints a genuinely fresh proxy.
      if (decision === "ADOPT") {
        let adoptResult: { name: string; sessionId: string };
        try {
          adoptResult = await supervisor.resume(issue, w.name);
        } catch (e) {
          if (e instanceof UnresumableLaneError) {
            const outcome = await escalateUndecidableResume(forge, state, cfg, w, attempts, iso);
            if (outcome) resumed.push(outcome);
            continue;
          }
          state.appendEvent("fix-leg-resume-failed", { worker: w.name, issue: w.issue, error: String(e) });
          throw e;
        }
        // #245 round-3 fix (B5): requestHandoff FIRST — durable (persists handoff_requested in
        // running.json) and idempotent, so a crash between this call and the upsert below is
        // safe: the row stays `handoff` with fixing_handoff=1 and the SAME confirmed intent, so
        // the next tick re-enters this exact ADOPT branch — resume() re-adopts, requestHandoff
        // is then a harmless no-op re-signal, and the upsert's resume_attempts bump is still the
        // first and only successful one. Same convergence argument as B3's reordering.
        supervisor.requestHandoff(w.name);
        const adoptAttempt = attempts + 1;
        state.upsertWorker({
          ...w,
          session_id: adoptResult.sessionId,
          state: "fixing",
          started_at: iso(),
          ended_at: null,
          resume_attempts: adoptAttempt,
          fixing_handoff: 1,
        });
        state.appendEvent("fix-leg-adopted-drained", { worker: w.name, issue: w.issue, pr, attempt: adoptAttempt });
        resumed.push({ kind: "resumed", worker: w.name, issue: w.issue, attempt: adoptAttempt });
        resumeLanesUsed++;
        continue;
      }
      const fixPrompt = deps.fixLegResume.renderFixPrompt(w.issue, pr);
      // #247 F1 (Codex sol-high PR #265 review round 2, P1): captured BEFORE resume() — this is
      // a genuinely FRESH mint/spawn (unlike the ADOPT branch above), so the same "child cannot
      // call before this line runs" guarantee startFixLeg's own capture relies on holds here too.
      const journalCursor = state.maxForgeProxyJournalId(w.name);
      let fixResult: { name: string; sessionId: string };
      try {
        fixResult = await supervisor.resume(issue, w.name, {
          prompt: fixPrompt,
          proxy: { mint: deps.fixLegResume.mintProxy, credentialFree: true },
        });
      } catch (e) {
        if (e instanceof UnresumableLaneError) {
          const outcome = await escalateUndecidableResume(forge, state, cfg, w, attempts, iso);
          if (outcome) resumed.push(outcome);
          continue;
        }
        state.appendEvent("fix-leg-resume-failed", { worker: w.name, issue: w.issue, error: String(e) });
        throw e;
      }
      if (fixResult.name !== w.name) {
        throw new Error(`resume returned worker ${fixResult.name}; expected existing lane ${w.name}`);
      }
      const fixAttempt = attempts + 1;
      state.upsertWorker({
        ...w,
        session_id: fixResult.sessionId,
        state: "fixing",
        started_at: iso(),
        ended_at: null,
        resume_attempts: fixAttempt,
        fixing_handoff: 0,
      });
      // fixRounds: this is a CONTINUATION of the same fix round (only resume_attempts bumps
      // above, never fix_rounds) — carried so fixLegJournalCursor can match this event against
      // the SAME (worker, fixRounds) key the round's original fix-leg-started event used.
      state.appendEvent("fix-leg-resumed", {
        worker: w.name,
        issue: w.issue,
        pr,
        attempt: fixAttempt,
        fixRounds: w.fix_rounds ?? 0,
        journalCursor,
      });
      resumed.push({ kind: "resumed", worker: w.name, issue: w.issue, attempt: fixAttempt });
      resumeLanesUsed++;
      continue;
    }
    let result: { name: string; sessionId: string };
    try {
      result = await supervisor.resume(issue, w.name);
    } catch (e) {
      if (e instanceof UnresumableLaneError) {
        const outcome = await escalateUndecidableResume(forge, state, cfg, w, attempts, iso);
        if (outcome) resumed.push(outcome);
        continue;
      }
      state.appendEvent("resume-failed", { worker: w.name, issue: w.issue, error: String(e) });
      throw e;
    }
    if (result.name !== w.name) {
      throw new Error(`resume returned worker ${result.name}; expected existing lane ${w.name}`);
    }
    const attempt = attempts + 1;
    state.upsertWorker({
      ...w,
      session_id: result.sessionId,
      state: "running",
      started_at: iso(),
      ended_at: null,
      resume_attempts: attempt,
    });
    state.appendEvent("resumed", { worker: w.name, issue: w.issue, attempt });
    resumed.push({ kind: "resumed", worker: w.name, issue: w.issue, attempt });
    resumeLanesUsed++;
  }

  // ── DISPATCH: fill free lanes from the Ready queue, by priority, within caps + budget ──
  //   #75/#168: skipped entirely while `paused` OR `parkActive` — no new lane dispatch, not even
  //   "skipped" rows (mirrors the kill-switch tick's dispatched: [] — see its test comment) —
  //   EXCEPT the llm-park canary (P1-1): `canaryBudget` opens the loop for exactly ONE lane,
  //   which is recorded on the llm episode (setParkCanary) the moment it launches.
  //   overBudget is still reported (cheap, dispatch-independent — just deps.roundSpendUsd vs.
  //   the cap), but nothing below it runs: no Ready-queue read, no claim, no worker spawn.
  //   The roundSpendUsd THUNK is evaluated exactly HERE — after the reclaim phase above has
  //   banked any terminal lanes' spend, before the dispatch loop below reads overBudget — so
  //   a same-tick reclaim that crosses the round budget blocks this same tick's refill
  //   (#124 gate② P1-2; see the TickDeps.roundSpendUsd doc comment).
  // #154: runSpendStop is kept separate from overBudget so TickResult.overBudget retains its
  // original cost.roundBudgetUsd meaning.
  // #172: an explicit zero override is a recovery-only beat. Keep it as quiet as PAUSE: no
  // Ready fetch (and therefore no transient forge failure), no synthetic cap-skipped rows.
  const effectiveDispatchCap = parkActive
    ? Math.min(canaryBudget, deps.dispatchCapOverride ?? cfg.lanes.roundDispatchCap)
    : (deps.dispatchCapOverride ?? cfg.lanes.roundDispatchCap);
  if (!paused && (!parkActive || canaryBudget > 0) && effectiveDispatchCap > 0) {
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
      if (runSpendStop) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "run-spend-stop" });
        continue;
      }
      // #124: dispatchCapOverride (round.ts's remaining round-quota) replaces the plain
      // cfg.lanes.roundDispatchCap for a caller that tracks quota ACROSS ticks; unset (the
      // tick-driver, driver.ts) leaves this a flat per-tick rate limit, exactly as before.
      // #168 P1-1: while still parked, the loop is only open at all because a canary was armed
      // — the effective cap is exactly that canary budget (1), never the normal quota.
      if (dispatchedThisTick >= effectiveDispatchCap) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "cap" });
        continue;
      }
      if (lanesUsed >= cfg.lanes.max) {
        dispatched.push({ kind: "skipped", issue: issue.number, reason: "no-lane" });
        continue;
      }
      // Anti-starvation: a meta-rank issue must yield a reserved coding lane while coding
      // work is still waiting (codingFloor of cfg.lanes.max lanes are reserved for coding).
      const rank = issuePriority(issue.labels, cfg.labels.prefix);
      if (!isCodingRank(rank)) {
        const codingWaiting = order.filter(
          (o) => isCodingRank(issuePriority(o.labels, cfg.labels.prefix)) && !inFlightIssues.has(o.number),
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
          forge,
          state,
          cfg,
          { id: rollbackId, issue: issue.number, target: "ready", reason: "dispatch-rollback", attempts: 0 },
          iso,
        );
        throw e;
      }
      const { name, sessionId } = dispatchRes;
      const workerRow: WorkerRow = {
        name,
        issue: issue.number,
        session_id: sessionId,
        state: "running",
        started_at: iso(),
        ended_at: null,
      };
      // #168 P1-1: a lane dispatched while still parked IS the llm episode's canary — recorded
      // durably on the episode row the moment it launches, so its terminal reclaim
      // (settleCanary) can recognize it and no second canary can launch while it's in flight
      // (the PARK section skips probing while canary_worker is set), across restarts too.
      // P2-A (round 3): worker row + canary assignment + events land in ONE transaction
      // (state.registerCanaryDispatch) — a crash can no longer leave a live canary the
      // restarted engine doesn't know about (which would break "exactly one canary").
      if (parkActive) {
        state.registerCanaryDispatch(workerRow, "llm");
      } else {
        state.upsertWorker(workerRow);
        state.appendEvent("dispatched", { worker: name, issue: issue.number });
      }
      inFlightIssues.add(issue.number);
      lanesUsed++;
      dispatchedThisTick++;
      if (!isCodingRank(rank)) metaUsed++;
      dispatched.push({ kind: "dispatched", issue: issue.number, worker: name });
    }
  } // !paused (#75) / park canary (#168)

  return {
    reclaimed,
    dispatched,
    overBudget,
    ceilingBreached,
    ceilingReasons,
    drainRequested,
    escalated,
    driven,
    rollbacks,
    gatedReclaimed,
    resumed,
    fixingReclaimed,
    fixResponses,
  };
}
