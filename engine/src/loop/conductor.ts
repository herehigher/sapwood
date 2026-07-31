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
import { buildAcSnapshot, checkAcSnapshotDrift } from "../review/ac-snapshot.js";
import type { EngineAgentDriveDeps } from "../review/drive.js";
import type { DriveOutcome } from "../roles/merge-driver.js";
import type { ReviewFallbackLock, ReviewTriggerPin } from "../roles/reviewer.js";
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
  probeDueWithHint,
} from "./env-failure.js";
import { isHumanMergeOnlyVerdict } from "./escalation-buckets.js";
import { attemptThreadWrite, computeFixResponseHarvest, type FixResponseWriteOutcome } from "./fix-response.js";
import { reviveEnvFailedPrLanes } from "./reconcile.js";

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
 * #400: hold has ONE carrier, the PR. #248 review round 1 (G1) had added a second, issue-level
 * `issueHoldPresent` SKIP input here, for the case where a human puts a `hold` on the ISSUE of an
 * already-escalated lane "while investigating" and then removes `needs-human` before finishing.
 * That input is gone: removing `needs-human` IS the go-ahead signal, so the scenario is a human
 * contradicting themselves, and the carrier was a silent no-op in the state a human is most
 * likely to be in (an issue-level hold on a still-`driving` lane never reached this function at
 * all). Accepted, bounded, and TRANSITIONAL cost: a human who removes `needs-human` before they
 * are actually ready burns ONE `gated_reentry_attempts` slot — the cap bounds it and a
 * re-escalation re-latches the lane; once #398 makes this phase read the PR's labels for a
 * PR-bearing lane, a PR-level hold restores that SKIP on the correct carrier at zero marginal
 * cost. `hold` is read on the PR only (`deriveGate`, `review/drive.ts`'s preflight, and #170's
 * silence suppression).
 */
export function gatedReentryDecision(humanHoldPresent: boolean, attempts: number, cap: number): GatedReentryDecision {
  if (humanHoldPresent) return "SKIP";
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

/** #457 (F36): the verdict-rerun circuit breaker's lookup — has a fix leg ALREADY been dispatched
 *  (a `drive-fixup` event recorded) AND run to completion for this lane against this EXACT
 *  decisive engine-review verdict? An engine-agent decisive verdict is pinned PERMANENT per head
 *  (review/drive.ts) and re-consumed every tick until the head moves, so a SECOND fix leg for the
 *  same `verdictRunId` means the first leg pushed nothing — its rerun would receive
 *  byte-identical inputs and is deterministically useless (the F36 wedge: PR #456 burned prFixCap
 *  8/8 in no-op legs). Keys on the engine-authored runId, NEVER on bare head-unchanged (a
 *  zero-push CLASSIC fix leg can be real progress via engine-executed thread replies/resolves)
 *  and never on session prose. Event-log reuse, no new schema — same trick as fix-response.ts's
 *  fixLegJournalCursor.
 *
 *  #457 review round 1 (P2, interrupted-leg amnesty): a dispatch record is NOT proof the leg ran
 *  to completion. A leg killed by an environment failure (env-failure-preserved) and later
 *  revived (#447's lane-revived) never got to act on the findings — denying its retry leg would
 *  escalate a lane whose fix never ran. So a LATER env-failure-preserved/lane-revived event for
 *  the SAME worker forgives every earlier dispatch: the next leg for that verdict runs fresh, and
 *  only a completed no-op leg AFTER the revival trips the breaker. Ordering is eventsSince's own
 *  chronological (by id) contract — no wall-clock comparison.
 *
 *  Bounded blind spots (accepted, honesty over machinery): (1) the `drive-fixup` event lands
 *  AFTER startFixLeg confirms the spawn, so a crash in that window forgets one dispatch and the
 *  breaker trips one leg later — still capped by prFixCap; (2) a leg that committed locally but
 *  FAILED TO PUSH looks identical to a no-op leg, so the breaker escalates one leg early — no
 *  push-detection machinery for it (ruled #457 review round 1); the escalation comment instead
 *  tells the human to check the preserved worktree for unpushed commits. */
export function priorFixLegForVerdict(state: Pick<State, "eventsSince">, worker: string, verdictRunId: string): boolean {
  const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup", "env-failure-preserved", "lane-revived"]);
  let tripped = false;
  for (const e of events) {
    const p = e.payload as { worker?: unknown; verdictRunId?: unknown };
    if (p.worker !== worker) continue;
    if (e.kind === "drive-fixup") {
      if (p.verdictRunId === verdictRunId) tripped = true;
    } else {
      // env-failure-preserved / lane-revived AFTER the dispatch: that leg was interrupted, its
      // dispatch record is amnestied (see doc above).
      tripped = false;
    }
  }
  return tripped;
}

/** #375 AC2: is a `driving` lane TERMINAL-for-drain — i.e. can it NEVER make forward progress
 *  while DRIVE stays frozen (an active kill switch skips the whole DRIVE loop entirely, #69)?
 *  A `driving` lane has no live process — nothing for supervisor.requestHandoff/reclaim to act
 *  on — so unlike `running`/`fixing` lanes it can only ever be "drained" by forcing it to a
 *  terminal state outright. Waiting on one instead would wedge the bounded drain forever
 *  (PLAN.md "drain before kill, never a permanent wedge"), exactly the dogfood-observed spin
 *  (#375: KILL_SWITCH set while a FIXABLE driving lane sat blocked -> wind-down's
 *  `activeWorkers() === 0` loop never terminated).
 *
 *  #375 review round 1 (P1): this heuristic is for the KILL-SWITCH caller ONLY
 *  (`DrivingDrainMode`'s `"heuristic"` arm) — it is the only evidence available when DRIVE never
 *  ran at all this tick. It must NOT be reused for the ceiling/daily-budget/wall-clock drain
 *  path, where DRIVE already ran THIS SAME tick before the ceiling section: there, a `driving`
 *  lane with `fixRounds > 0` sitting in WAIT (its fix leg already done, awaiting re-review) can
 *  still merge for free the instant review lands, and this heuristic cannot see that — it would
 *  force-escalate a perfectly healthy lane merely for having needed a fix leg in the past. The
 *  ceiling path instead consults `driveFixBlockedLanes`, the OBSERVED set THIS tick's DRIVE loop
 *  itself populated (`DrivingDrainMode`'s `"observed"` arm) — ground truth, not an inference.
 *
 *  Two structural, LOCALLY-derivable facts, either sufficient — deliberately NOT a live
 *  gate.driveOne() re-evaluation: a drain path must stay cheap and safe, never a second source
 *  of "new work" (the same #69 doctrine the kill-switch gate itself documents):
 *   - fix-capped: `fixRounds` already spent `prFixCap` — permanent regardless of any ceiling,
 *     the exact same cap DRIVE's own FIXABLE branch would escalate on (#246) one tick later.
 *   - budget-blocked: `fixRounds > 0` (this lane has already needed at least one fix leg — the
 *     only other legitimate `driving` reasons, MERGE/WAIT, never touch fix_rounds at all) AND
 *     `dailyBudgetBreached` (round budget no longer applies to fix legs at all, #375 item 1, so
 *     the daily-budget hard ceiling is the only remaining admission blocker that can wedge a
 *     fresh fix leg — and it will not clear before this drain window elapses).
 *
 *  A `driving` lane with `fixRounds === 0` is never treated as terminal here: it may be MERGE-
 *  or WAIT-gated and need nothing from the fix loop at all, so forcing it to needs-human on a
 *  bare ceiling breach would escalate a healthy in-review PR for no reason — it simply resumes
 *  normal DRIVE progression the instant the breach/switch clears.
 *
 *  #375 review round 2 (P2, accepted trade-off, PR #388 review): the fix-capped arm CAN still
 *  false-positive on the kill-switch path specifically — a lane at `prFixCap` that has ALSO
 *  reached a healthy post-fix WAIT (its rework already done, merely awaiting re-review) gets
 *  force-escalated too, since this heuristic cannot see that (DRIVE never ran this tick to prove
 *  it). This is deliberate, not an oversight: under an active KILL_SWITCH, DRIVE is frozen no
 *  matter how healthy the lane is, so it cannot merge THIS tick regardless, and the engine MUST
 *  still exit the bounded drain window (PLAN.md "drain before kill, always" — the #375 PM
 *  adjudication names fix-capped lanes terminal-for-drain unconditionally). The recovery path is
 *  #147's GATED RECLAIM: a human clears the `needs-human` label once they see the false positive
 *  (or once review lands and the PR is simply mergeable), and the SAME lane/PR/branch reclaims
 *  back into `driving` — no data loss, no fresh dispatch, just one extra manual step. */
export function drivingLaneTerminalForDrain(fixRounds: number, prFixCap: number, dailyBudgetBreached: boolean): boolean {
  if (fixRounds >= prFixCap) return true;
  return fixRounds > 0 && dailyBudgetBreached;
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

export type FixPrescription = "conflict" | "findings";

const CONFLICT_FIX_PRESCRIPTION = `## Conflict-only prescription

This PR is currently CONFLICTING. Do only the mechanical conflict-resolution work in this leg:
read baseRefName from mcp__forge__pr_details (if empty, determine the base from repository
metadata), merge that base branch from origin into the existing PR branch, resolve every
conflict, run the relevant tests, then commit and push the resolved branch. Do not address
standing review findings in this leg; they will be re-evaluated by a fresh review of the
conflict-free head.`;

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
  // #403 (F25): REQUIRED, not `= () => new Date()`. A default-valued clock is the same trap as an
  // optional one — the unsafe path is what a fixture gets for free.
  now: () => Date,
  prescription: FixPrescription = "findings",
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
  const basePrompt = deps.renderFixPrompt(w.issue, pr);
  const prompt = prescription === "conflict" ? `${basePrompt}\n\n${CONFLICT_FIX_PRESCRIPTION}` : basePrompt;
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
  // #377: an open PR belonging to THIS LANE exists — resolved from the lane's own branch plus
  // the engine-authored PR-owner marker (worker.ts's probe -> forge.ts's associateLanePr), not
  // from any PR that merely mentions the lane's issue number.
  hasPr: boolean;
  /** The open PR's number, when hasPr — the merge driver's gate/merge target (#13). Optional:
   *  probe fixtures that predate #13 (hasPr only, no number) still type-check; a driving lane
   *  with hasPr=true but no prNumber known keeps hasPr's rescue behavior but can't be driven
   *  through gates until a number is available (tick's fail-safe below escalates it). */
  prNumber?: number;
  /** #377 (gate② round 3): the lane's PR association is UNKNOWN — a forge WRITE it depended on
   *  failed (a 502 on `gh pr create`, a 403 on the marker stamp) — as opposed to a definitive
   *  "this lane has no PR". The reclaim loops DEFER a lane flagged this way instead of settling
   *  it, because settling consumes the only probe that would ever have opened or found the PR:
   *  a DONE lane would be escalated to a human and a DEAD one requeued onto a FRESH worker,
   *  both while its pushed branch sat there. Bounded by the supervisor
   *  (MAX_INCONCLUSIVE_PR_PROBES) so a PERMANENT write failure can't hold a lane slot forever;
   *  once the budget is spent the flag stops appearing and the ordinary no-PR rules settle the
   *  lane. Absent/false ⇒ the answer is conclusive, today's behavior exactly. */
  prAssociationInconclusive?: boolean;
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
  /** #287 (E4b, AC#1): the EARLIEST observable actual model for a still-`running` lane — the
   *  session-init line's own self-report (worker.ts's parseSessionInit), read from the SAME
   *  in-memory jsonl liveTelemetry already re-scans on every probe. `null`/undefined when no
   *  init line has landed yet (session still starting) or the lane isn't held in-memory
   *  (detached/terminal — see worker.ts's probe() for why this mirrors liveTelemetry's own
   *  "in-memory lane only" scoping). tick()'s KEEP branch feeds a non-null value into
   *  State.recordWorkerActualModel alongside its existing State.setLiveTelemetry call. */
  actualModel?: string | null;
  /** #374: a FAILED lane's own structured rate-limit telemetry (worker.ts's
   *  extractRateLimitResetAt — the Claude CLI's `rate_limit_event.resetsAt`), epoch ms, when a
   *  429 payload named the exact instant quota resets. undefined for a non-FAILED lane, when no
   *  such record was ever emitted, or for probe fixtures that predate #374. Threaded into
   *  state.enterPark's optional reset-hint column purely as SCHEDULING input (env-failure.ts's
   *  probeDueWithHint) — never a classification input (classifyEnvFailure never sees it). */
  rateLimitResetAtMs?: number;
  /** #394 (F22) / gate② round 3: same "only for a FAILED lane" gating as
   *  failureText/rateLimitResetAtMs above — worker.ts's
   *  `hasRejectedRateLimitEvent(jsonl) || hasQuotaErrorStatus(jsonl)`, the PRIMARY, text-free
   *  classification signal(s) for classifyEnvFailure below (checked BEFORE failureText's pattern
   *  match). Unlike rateLimitResetAtMs (scheduling only), this one directly drives
   *  classification. Two structured signals OR'd together, not one — see worker.ts's
   *  terminalEnvSignalStructured / env-failure.ts's own module doc for why a single rejected
   *  `rate_limit_event` line is not sufficient on its own. */
  envSignalStructured?: boolean;
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
    triggerPin: ReviewTriggerPin,
    recordTrigger: (
      head: string,
      at: string,
      meta?: { generation: number; ambiguous: boolean; deltaChain: number; inFlight: boolean },
    ) => void,
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
    recordVerdict?: (head: string, generation: number, coverageEstablished: boolean) => void,
    engineAgent?: Omit<EngineAgentDriveDeps, "forge" | "cfg" | "reviewerAdapter">,
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
  now: () => Date;
  /** #13: the review + merge gate for driving lanes. Omitted -> driving lanes stay driving with
   *  no gate/merge activity this tick (pre-#13 behavior — M2 dogfood / callers that haven't
   *  wired a reviewer yet keep working unchanged). */
  mergeGate?: MergeGate;
  /** #288: production engine-agent lane binding. Kept outside MergeGate because worker-row
   *  identity/state access belongs to conductor; classic reviewer modes never call it. */
  engineAgentDriveDeps?: (worker: WorkerRow, pr: number) => Omit<EngineAgentDriveDeps, "forge" | "cfg" | "reviewerAdapter">;
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
    .filter((i) => !labelsInclude(i.labels, cfg.labels.decomposed))
    .filter((i) => !hasReserveLabel(i.labels, reserveish))
    .filter((i) => labelsBlockers(i.labels, cfg.labels.prefix).length === 0)
    .map((i) => ({ i, rank: issuePriority(i.labels, cfg.labels.prefix) }))
    .sort((a, b) => a.rank - b.rank || a.i.number - b.i.number)
    .map((x) => x.i);
}

const ENV_FAILURE_REQUEUE_REASON = "env-failure-requeue";
/** Exported for escalation-reconcile's clear-exemption discriminator (#295 review round 6): only
 *  the merge that PRODUCED a rollback escalation may not clear it. */
export const MERGED_BOARD_DONE_REASON = "merged-board-done";

function suspendRollbackDuringForgePark(reason: string): boolean {
  return reason === ENV_FAILURE_REQUEUE_REASON || reason === MERGED_BOARD_DONE_REASON;
}

async function handleRollbackFailure(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  row: Pick<PendingRollback, "id" | "issue" | "target" | "reason" | "attempts">,
  error: unknown,
  iso: () => string,
): Promise<RollbackOutcome> {
  const attempts = row.attempts + 1;
  if (attempts >= cfg.recovery.rollbackRetryCap && row.reason !== ENV_FAILURE_REQUEUE_REASON) {
    state.clearPendingRollback(row.id);
    // The structured event below remains the evidence if this best-effort label also fails.
    await forge.addLabel(row.issue, cfg.labels.needsHuman).catch(() => {});
    state.appendEvent("rollback-escalated", {
      issue: row.issue,
      target: row.target,
      reason: row.reason,
      attempts,
      error: String(error),
    });
    return { kind: "escalated", issue: row.issue, attempts, reason: row.reason };
  }
  state.bumpPendingRollback(row.id, iso());
  state.appendEvent("rollback-retry-failed", {
    issue: row.issue,
    target: row.target,
    reason: row.reason,
    attempts,
    error: String(error),
  });
  return { kind: "retrying", issue: row.issue, attempts, reason: row.reason };
}

/**
 * One attempt at a durably-persisted board mutation (#31). `row` may be a
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
    return handleRollbackFailure(forge, state, cfg, row, e, iso);
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

/** #210 (docs/frontend-design.md §11 follow-up 4): the resolution signal for a retained
 *  worktree. Nothing else marks a retained folder as dealt with — the dashboard's
 *  Needs-attention strip would carry the row forever — and the engine already owns the path, so
 *  the filesystem it manages IS the signal: once the folder is gone (the human salvaged or
 *  discarded it), append `worktree-released` once, mirroring `worktree-retained`'s payload. No
 *  acknowledge UI is invented, and no forge call is made — this is a pure state+disk scan.
 *
 *  Runs on every tick (the first tick of a run covers startup). Dedupe is the event log itself
 *  (see State.unreleasedRetainedWorktrees): a released path drops out of the scan until the same
 *  path is retained again, so repeat ticks AND restarts emit nothing further. `exists` is
 *  injectable for tests only. Never throws — an unreadable path just stays retained. */
export function releaseVanishedWorktrees(state: State, exists: (path: string) => boolean = existsSync): void {
  for (const { worker, issue, worktreePath } of state.unreleasedRetainedWorktrees()) {
    if (exists(worktreePath)) continue;
    state.appendEvent("worktree-released", { worker, issue, worktreePath });
  }
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
    // #295 review round 4 (Codex P1): a fixing-origin handoff still owns its PR — preserve it so
    // escalation-reconcile can observe an external merge/close of that PR (its observeResolution
    // checks the PR only when the payload carried one).
    ...(worker.pr != null ? { pr: worker.pr } : {}),
  });
  return { kind: "capped", worker: worker.name, issue: worker.issue, attempts };
}

/** #375 review round 1 (P1): which of the two `drainThenEscalate` callers is asking, and what
 *  evidence each one actually HAS about a `driving` lane's fix-leg status — these are NOT
 *  interchangeable, because the two callers see fundamentally different worlds:
 *
 *   - `"heuristic"` (the #69 kill-switch gate): tick() returns before DRIVE ever runs under an
 *     active switch (the whole point of the gate — see its own comment), so there is no live
 *     information about what a `driving` lane's CURRENT gate is. `dailyBudgetBreached` (a pure,
 *     forge-free read — safe inside a kill-switch-frozen tick) plus the lane's own durable
 *     `fix_rounds` is the only evidence available, fed to `drivingLaneTerminalForDrain`'s
 *     heuristic (see that function's own doc for exactly what it infers and why).
 *   - `"observed"` (the CEILING/daily-budget/wall-clock path): DRIVE already ran THIS SAME tick,
 *     before the ceiling section (conductor.ts's DRIVE loop precedes CEILING) — a ceiling breach
 *     blocks new dispatch/resume/fix-leg-admission, but NOT drive/merge progression, so a
 *     `driving` lane with `fix_rounds > 0` sitting in WAIT (its fix leg already done, awaiting
 *     re-review) can still merge for free the instant review lands; DRIVE's own FIXABLE branch
 *     only re-fires on a NEW finding, never while merely waiting. The `drivingLaneTerminalForDrain`
 *     heuristic cannot distinguish that from a genuinely-still-blocked lane and would force-
 *     escalate it — a regression versus pre-#375 behavior, where a ceiling breach let `driving`
 *     lanes complete naturally via DRIVE. `blockedLanes` is the fix: the EXACT set of lane names
 *     whose own fixable branch, THIS tick, actually observed a ceiling-caused admission block or
 *     a genuine fix-rounds-cap exhaustion (populated inline in the DRIVE loop, see
 *     `driveFixBlockedLanes`) — ground truth, not an inference, so only lanes DRIVE itself just
 *     proved stuck are ever escalated here. */
export type DrivingDrainMode =
  | { mode: "heuristic"; dailyBudgetBreached: boolean }
  | { mode: "observed"; blockedLanes: ReadonlySet<string> };

/** The bounded drain (PLAN.md Security model: drain before kill, always). Shared by the #69
 *  global kill-switch gate and the #14 cost-ceiling breach path in tick(): record the breach
 *  (first detection only — see State.recordCeilingBreach's INSERT OR IGNORE), ask every
 *  running worker to hand off gracefully (idempotent per tick), and only once
 *  cfg.cost.drainWindowSec has elapsed since first detection escalate to the hard
 *  process-tree kill + needs-human. No PR-aware rescue on escalation — this is a safety
 *  boundary, not a liveness classification, so fail-safe to human triage.
 *
 *  #375 AC2: `driving` lanes join the SAME bounded escalation, past the SAME window — but never
 *  the drain-REQUEST step above (no live process, nothing for requestHandoff/reclaim to act on).
 *  A `driving` lane only ever reaches the escalation step, and only when `drivingDrain` (see its
 *  own doc — the two callers' evidence differs fundamentally) says it can never make forward
 *  progress on its own: otherwise a healthy MERGE-/WAIT-gated PR would get force-escalated
 *  merely for outliving one ceiling breach. */
async function drainThenEscalate(
  forge: IForge,
  state: State,
  supervisor: Supervisor,
  cfg: SapwoodConfig,
  reasons: CeilingReason[],
  nowDate: Date,
  iso: () => string,
  drivingDrain: DrivingDrainMode,
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
      // #295 review round 4 (Codex P1): carry the PR when one is known. escalation-reconcile's
      // observeResolution only checks merge/closure for escalations whose payload preserved a
      // pr, so discarding a number we already hold here left the advertised external-merge
      // clearing path permanently broken for this source.
      // Round 8 (Codex P2): `p.prNumber` comes from probe(), which searches OPEN PRs only — a
      // manually CLOSED PR leaves it null while the durable row still knows the number, and the
      // reconciler would then never observe that closure. Same `?? w.pr` fallback the reclaim
      // paths above use.
      const ceilingPr = p.prNumber ?? w.pr ?? null;
      state.appendEvent("ceiling-escalated", {
        worker: w.name,
        issue: w.issue,
        reasons,
        ...(ceilingPr != null ? { pr: ceilingPr } : {}),
      });
      // #155: leaving `running` via the ceiling drain — clear the LIVE telemetry trio.
      state.clearLiveTelemetry(w.name);
      state.upsertWorker({ ...w, state: "failed", ended_at: iso() });
      escalated.push(w.name);
    }
    // #375 AC2: a `driving` lane whose only next DRIVE action is a fresh fix leg that can never
    // be admitted right now (fix-capped, or budget-blocked) is drained here too, past this SAME
    // window, exactly like DRIVE's own fix-rounds-cap branch would escalate it (#246) — just one
    // drain window early on the kill-switch path (DRIVE never gets to run while the switch
    // stands), or confirmed by THIS SAME tick's own DRIVE pass on the ceiling path (see
    // `DrivingDrainMode`'s own doc for why the two callers cannot share one predicate).
    //
    // #375 review round 2 (P2, Codex PR #388 review): deliberately NOT escalateNeedsHuman — that
    // helper commits the terminal `upsertWorker(failed)` UNCONDITIONALLY, even when its own
    // `forge.addLabel` throws (it only records the failure via `gated_escalation_labeled: 0`, a
    // durable "manual drive as before #147" marker — the right contract for its many OTHER
    // callers, an ordinary DRIVE-tick escalation that gets re-attempted from a clean `driving` row
    // if anything ever needs to look at it again). A drain escalation is different: this IS the
    // row's one scheduled visit for the current breach, so a transient forge outage here should
    // not permanently downgrade it to manual-only. Mirror the FIXABLE cap-exhausted branch's own
    // contract instead (`Hard rule (#69/#147 forge-before-terminal-upsert)`, above): label FIRST;
    // on failure, leave the row `driving` and retry next tick — `state.ceilingBreach()`'s
    // timestamp is untouched by a retry (recordCeilingBreach only ever records FIRST detection),
    // so the NEXT tick's `drainEscalationDue` check is still past-window and retries immediately —
    // one extra tick, never a fresh drain window.
    for (const w of state.drivingWorkers()) {
      const fixRounds = w.fix_rounds ?? 0;
      const terminal =
        drivingDrain.mode === "heuristic"
          ? drivingLaneTerminalForDrain(fixRounds, cfg.lanes.prFixCap, drivingDrain.dailyBudgetBreached)
          : drivingDrain.blockedLanes.has(w.name);
      if (!terminal) continue;
      if (w.pr == null) continue; // a PR-less driving row is DRIVE's own fail-safe, not drain's
      const reason =
        fixRounds >= cfg.lanes.prFixCap
          ? `drain-fix-rounds-capped:${fixRounds}/${cfg.lanes.prFixCap}`
          : drivingDrain.mode === "heuristic"
            ? `drain-daily-budget-blocked:fix-rounds=${fixRounds}`
            : `drain-ceiling-admission-blocked:fix-rounds=${fixRounds}`;
      try {
        await forge.addLabel(w.issue, cfg.labels.needsHuman);
      } catch (e) {
        state.appendEvent("drain-driving-escalation-label-failed", { worker: w.name, issue: w.issue, pr: w.pr, reason, error: String(e) });
        continue; // stays `driving`, no latch — the next drain tick retries this whole branch
      }
      // #375 review round 3 (P2, Codex PR #388 verify pass): the evidence comment — WHY the
      // engine gave up (the drain reason: kill-switch vs ceiling; fix-rounds spent vs cap; the
      // specific budget/admission blocker) and HOW to undo it (#147 gated reentry, including the
      // repeat-reentry trail escalateNeedsHuman's own callers preserve) — gets the SAME
      // forge-before-terminal-upsert treatment as the label: label -> comment -> terminal upsert,
      // mirroring the FIXABLE cap-exhausted branch exactly. A comment-write failure must not
      // silently swallow this row into a needs-human issue with zero explanation (the preserved-
      // evidence stance every other escalation in this file honors) — leave it `driving` (no
      // upsert, no latch) and retry the WHOLE branch next tick; a re-attempt re-posts the label
      // harmlessly (GitHub's addLabel is idempotent), same accepted stance as the cap-exhausted
      // branch's own no-new-dedup-machinery ruling.
      const gatedAttempts = w.gated_reentry_attempts ?? 0;
      const reentryNote =
        gatedAttempts > 0
          ? `This is gated-reentry attempt ${gatedAttempts}/${cfg.lanes.gatedReentryCap} for this PR. ` +
            (gatedAttempts >= cfg.lanes.gatedReentryCap
              ? capHitEscalationNote(cfg)
              : `Remove \`${cfg.labels.needsHuman}\` again once resolved to retry (#147 gated reentry).`)
          : `Remove \`${cfg.labels.needsHuman}\` once resolved to reclaim the same PR (#147 gated reentry).`;
      try {
        await forge.addIssueComment(
          w.issue,
          `sapwood: ${reasons.join("+")} drain (#375) — PR #${w.pr} could not progress this tick ` +
            `(${reason}), ${fixRounds} fix round(s) spent of ${cfg.lanes.prFixCap}. Escalating to ` +
            `\`${cfg.labels.needsHuman}\` rather than wedge the bounded drain. ${reentryNote}`,
        );
      } catch (e) {
        state.appendEvent("drain-driving-escalation-comment-failed", {
          worker: w.name,
          issue: w.issue,
          pr: w.pr,
          reason,
          error: String(e),
        });
        continue; // stays `driving`, no latch — the next drain tick retries this whole branch
      }
      state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: 1 });
      state.appendEvent("drive-needs-human", { worker: w.name, issue: w.issue, pr: w.pr, reason, labeled: 1 });
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

/** #168: the forge probe — a lightweight, ALREADY-EXISTING IForge read (no new forge method),
 *  wrapped so any throw (network/auth/5xx — exactly the conditions env-failure.ts's forge
 *  signatures describe) reads as "still unreachable" rather than propagating. Deterministic:
 *  the classification is "did the call succeed", never an LLM judgment. */
export async function probeForgeReachable(forge: IForge): Promise<boolean> {
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
export async function escalatePark(
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
      writeLocalEscalation(state, park, message, iso, log);
    }
  } else {
    actualChannel = "local";
    writeLocalEscalation(state, park, message, iso, log);
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
function writeLocalEscalation(state: State, park: ParkRow, message: string, iso: () => string, log?: (message: string) => void): void {
  state.writeEscalationMarker({
    source: park.source,
    reason: park.reason,
    triggerIssue: park.triggerIssue,
    enteredAt: park.enteredAt,
    message,
    // #403 (F25): the caller's injected clock, not `new Date()`. This stamp and the
    // `recordParkEscalation(iso())` latch a few lines below in escalatePark describe the SAME
    // escalation — reading two different clocks for one event was the bug waiting to happen.
    at: iso(),
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
/**
 * #377 (gate② round 3, P1): hold a lane whose PR association came back UNKNOWN, rather than
 * settling it as "no PR". The engine only ever opens a lane's missing PR on the SAME probe the
 * reclaim below settles from, so a transient forge write failure was a one-shot loss: a DONE
 * lane got escalated to a human, a DEAD one got requeued onto a FRESH worker racing its own
 * pushed branch, and neither was ever probed again to notice the PR. Skipping the lane leaves
 * its row exactly as it stands, so the next tick re-probes and retries the write.
 *
 * Deliberately NOT applied on the two DRAIN paths (kill switch, cost/wall-clock ceiling —
 * safety-layer cross-check): a drain's whole job is to get lanes settled and the engine stopped,
 * so a lane that refuses to settle would fight the safety layer it is supposed to obey. There
 * the ordinary no-PR disposition still applies, unchanged.
 *
 * Bounded by the supervisor's own retry budget (worker.ts's MAX_INCONCLUSIVE_PR_PROBES), which
 * stops setting the flag once spent — so a PERMANENTLY failing write (`No commits between main
 * and <branch>`) settles by the ordinary rules after a few ticks instead of pinning the slot.
 * Returns true when the caller must `continue` (lane deferred, nothing recorded this tick).
 */
function deferForUnknownPr(state: Pick<State, "appendEvent">, w: WorkerRow, p: LaneProbe): boolean {
  if (!p.prAssociationInconclusive) return false;
  state.appendEvent("lane-pr-unknown", {
    worker: w.name,
    issue: w.issue,
    note: "PR association unknown (forge write failed) — retrying next tick.",
  });
  return true;
}

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
    const envSource = classifyEnvFailure(
      p.failureText ?? "",
      { llm: cfg.envFailure.llmPatterns, forge: cfg.envFailure.forgePatterns },
      p.envSignalStructured ?? false,
    );
    // P1-1b: if THIS lane was the llm episode's canary, settle it first — env-classified means
    // the same episode continues (attempts bumped, entered_at untouched); anything else means
    // the provider is provably back (a real run reached a non-env terminal) and the llm row
    // clears here, before the lane's own disposition below runs as normal.
    settleCanary(state, w.name, envSource != null, iso);
    if (envSource) {
      const reason = summarizeFailureText(p.failureText ?? "");
      // #374 review (Codex sol-high finding 7): thread the CLI's own structured reset-time hint
      // ONLY when THIS episode is llm-sourced — see env-failure.ts's probeDueWithHint and the
      // schema v26->v27 migration's doc comment. A forge-classified failure whose transcript
      // ALSO happens to carry rate-limit telemetry (both signatures can appear in the same
      // captured output — e.g. a worker that hit quota earlier in its run and a forge outage
      // later) must NOT suppress the FREE forge probe until an unrelated llm timestamp elapses;
      // the hint is llm-specific scheduling input, never a forge one.
      const resetHintAtIso = envSource === "llm" && p.rateLimitResetAtMs != null ? new Date(p.rateLimitResetAtMs).toISOString() : null;
      state.enterPark(envSource, reason, w.issue, iso(), resetHintAtIso);
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
      // #295 (Codex P2, PR #371): `pr` rides along so the escalation-resolution sweep can
      // observe an external merge/close of this lane's PR — without it the sweep could only
      // ever see issue closure or label removal for this source.
      state.appendEvent("fix-leg-undecidable", { worker: w.name, issue: w.issue, ...(w.pr != null ? { pr: w.pr } : {}) });
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

/** #397 bucket 2: settle a lane whose gate verdict is "a human must MERGE this PR" (today: the
 *  #292 instruction-path trust chain). Three deliberate differences from escalateNeedsHuman above:
 *
 *  1. NO label write. The PR already carries `labels.humanMergeOnly` — the escalating path
 *     (`escalateInstructionPathChanges`) wrote it BEFORE returning, and that label is the latch.
 *     Nothing belongs on the ISSUE: the issue isn't stuck, its PR just needs a human's hand.
 *  2. `gated_escalation_labeled` is left at 0. That is the whole P1 decision (#397): a row that
 *     never sets it is permanently invisible to `State.gatedFailedWorkers()` — the SAME
 *     invisibility class state.ts already uses for no-PR-failed and label-write-failed rows — so
 *     this lane can never enter GATED RECLAIM, never be re-driven, and can never reach the CAPPED
 *     branch that re-applies `needs-human`. The reclaim loop is closed structurally, not by adding
 *     `humanMergeOnly` to `escalation.humanLabels` (which would be a no-op for every issue-side
 *     fence that array actually feeds, while quietly widening deriveGate's veto set).
 *  3. No attempt-trail comment. There is no reentry to trail — this verdict is one-way.
 *
 *  The returned outcome still reports `kind: "needs-human"` because that is DrivenOutcome's shape
 *  for "this lane is a human's now"; the distinguishing record is the `drive-human-merge-only`
 *  event, so the two buckets are told apart in the durable ledger, not just in a label.
 *
 *  ORDERING (PR #463 gate② P2): the event is appended BEFORE the terminal upsert, and that order
 *  is load-bearing now that #447's revival pass uses this event as its discriminator. The other
 *  order left a crash window in which the row was already `failed` + PR + marker 0 — the exact
 *  shape an env failure leaves — with no verdict on record, so revival would have re-driven the
 *  one lane #397 closed structurally. The remaining window is the harmless direction: a crash
 *  after the event leaves the lane `driving` (not terminal), which re-drives next tick and
 *  re-settles idempotently off the PR's own `humanMergeOnly` latch, while the standing event
 *  only ever makes revival MORE conservative about this PR. */
function settleHumanMergeOnly(state: State, w: WorkerRow, pr: number, reason: string, iso: () => string): DrivenOutcome {
  state.appendEvent("drive-human-merge-only", { worker: w.name, issue: w.issue, pr, reason });
  state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: 0 });
  return { kind: "needs-human", worker: w.name, issue: w.issue, pr, reason };
}

/** #283 (M10, E2, design #279 §5): review-time AC-snapshot drift check. Called for EVERY driving
 *  lane, BEFORE `gate.driveOne` is ever invoked for it this tick — the fail-closed guarantee is
 *  ordering: drift detection must happen before, not instead of or racing, the drive attempt, so
 *  an unverifiable lane can NEVER reach `driveOne` (no silent re-extraction against a body the
 *  drift check was never meant to bypass). Returns `null` when the lane should drive normally
 *  this tick: `w.ac_body_hash` is unset — a pre-#283 legacy lane that never recorded one, drive
 *  normally, unaffected by any of this — OR it's set AND the current `ac_snapshots` row for this
 *  issue both (a) still belongs to THIS lane (`bodyHash` matches `w.ac_body_hash` — #301 review
 *  P1#3: a `failed`+PR lane awaiting GATED RECLAIM is NOT in `activeWorkers()`, so a fresh
 *  dispatch of the SAME issue can legitimately overwrite the issue-keyed snapshot while this lane
 *  still exists; ownership must be checked, not just presence) and (b) the LIVE issue body still
 *  hashes to it (no edit since dispatch). A transient forge read failure queues (retried next
 *  tick) rather than escalating a human over an infra blip, the same fail-safe stance every other
 *  forge hiccup in this loop takes.
 *
 *  Any of the three failure classes above (missing snapshot despite an expected hash — #301 P1#1:
 *  every WorkerRow with a non-null `ac_body_hash` is a hard guarantee a snapshot WAS recorded for
 *  it; a later absence is an anomaly, never legacy; ownership mismatch — P1#3; or an ordinary live
 *  body edit) re-escalates `needsHuman` (renewed gate⓪ adjudication is design #279 §5's human path
 *  back), mirroring escalateNeedsHuman's own label/upsert/event/comment ORDERING exactly (#301
 *  review round 3, P2 — a regression fix: an earlier revision of this function moved the durable
 *  event to AFTER the (awaited) comment post so it could also record whether the comment
 *  succeeded; that reintroduced a crash window escalateNeedsHuman's own established ordering
 *  never had — a crash during the comment's own await left the row durably `failed`,
 *  POSSIBLY with no label AND no event, permanently unrecoverable. The durable event is now
 *  written immediately after the label attempt and the terminal upsert — BEFORE the comment is
 *  ever attempted — so it is the crash-safe source of truth that the escalation happened and
 *  what the label write did; the comment is a genuine best-effort side effect after that, exactly
 *  like escalateNeedsHuman's own courtesy comment. Label/comment honesty: the comment text is
 *  CONDITIONAL on whether the needsHuman label write actually succeeded — it never claims the
 *  label "has been applied" when the write failed, and (since manually adding the label
 *  afterward does NOT retroactively flip `gated_escalation_labeled` to 1) it never promises
 *  automatic reentry either — a label-write failure here is permanently manual, same as every
 *  other escalation's accepted stance in this file (gated_escalation_labeled=0 permanently
 *  excludes a row from GATED RECLAIM — "manual drive as before #147"). */
async function checkAcDriftBeforeDrive(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  w: WorkerRow,
  pr: number,
  iso: () => string,
): Promise<DrivenOutcome | null> {
  const expectedHash = w.ac_body_hash ?? null;
  if (expectedHash == null) return null; // pre-#283 legacy lane, no snapshot ever expected -> drive normally

  const snapshot = state.getAcSnapshot(w.issue);
  let reason: string;
  if (!snapshot) {
    // #301 P1#1: this lane's OWN dispatch recorded a snapshot (expectedHash is non-null) — its
    // absence now is an anomaly (a crash/corruption/future-refactor gap), never "nothing to
    // compare" (that reading is reserved for expectedHash === null above).
    reason =
      `this lane's AC snapshot (recorded at dispatch, hash ${expectedHash.slice(0, 12)}) is no ` +
      `longer present for issue #${w.issue} — its dispatch-time authority can no longer be verified`;
  } else if (snapshot.bodyHash !== expectedHash) {
    // #301 P1#3: the issue-keyed ac_snapshots row no longer belongs to THIS lane — a later,
    // independent dispatch for the same issue number (activeWorkers() excludes `failed`, so this
    // lane being un-reclaimed never blocked that later dispatch) has overwritten it.
    reason =
      `the recorded AC snapshot for issue #${w.issue} no longer matches this lane's OWN ` +
      `dispatch-time snapshot (this lane: ${expectedHash.slice(0, 12)}, currently stored: ` +
      `${snapshot.bodyHash.slice(0, 12)}) — a different, later dispatch appears to have replaced it`;
  } else {
    let liveBody: string;
    try {
      liveBody = await forge.getIssueBody(w.issue);
    } catch (e) {
      return { kind: "queued", worker: w.name, issue: w.issue, pr, reason: `ac-drift-check-unavailable: ${String(e)}` };
    }
    const result = checkAcSnapshotDrift(liveBody, snapshot);
    if (result.ok) return null; // ownership confirmed, no live-body drift -> drive normally
    reason = result.reason;
  }

  let labeled = 1;
  let labelError: string | null = null;
  try {
    await forge.addLabel(w.issue, cfg.labels.needsHuman);
  } catch (e) {
    labeled = 0;
    labelError = String(e);
  }
  state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: labeled });
  // #301 review round 3 (P2): the durable event lands HERE — immediately after the terminal
  // upsert, BEFORE the comment is ever attempted — so it is the crash-safe record of "this
  // escalation happened, and what the label write did" regardless of whatever the comment attempt
  // below does or doesn't manage to do. Never moved after an awaited I/O call again (see this
  // function's own header comment for the crash window that regression opened).
  state.appendEvent("ac-snapshot-drift", {
    worker: w.name,
    issue: w.issue,
    pr,
    reason,
    labeled,
    ...(labelError != null ? { labelError } : {}),
  });
  // #301 review round 3 (P2): never CLAIM the label landed when it didn't, and never promise
  // automatic reentry a label-write failure can't actually deliver — a human adding the label BY
  // HAND afterward does not retroactively set `gated_escalation_labeled`, so GATED RECLAIM stays
  // permanently closed to this row regardless of the label's live GitHub state either way.
  const labelNote = labeled
    ? `\`${cfg.labels.needsHuman}\` has been applied`
    : `applying \`${cfg.labels.needsHuman}\` FAILED (${labelError}) — this lane is now permanently ` +
      `outside automatic reentry regardless of the label's live state on GitHub (adding it by hand ` +
      `afterward does not change that); a human must review and merge this PR manually`;
  // Best-effort courtesy comment — the durable event above is already the load-bearing record;
  // a post failure here (network hiccup, permissions) loses only the friendly GitHub-visible
  // explanation, never the escalation itself. Same shape as escalateNeedsHuman's own comment.
  await forge
    .addIssueComment(
      w.issue,
      `sapwood: this issue's body changed after its acceptance-criteria snapshot was taken for ` +
        `PR #${pr} (${reason}). Per design #279 §5, drift fails the review gate closed — this PR ` +
        `will not be driven through gate②/merge while its AC authority cannot be verified. ` +
        `${labelNote} — a human must re-adjudicate (a renewed gate⓪ pass): either restore the ` +
        `original acceptance criteria/verification plan, or explicitly re-approve the new body.`,
    )
    .catch(() => {});
  return { kind: "needs-human", worker: w.name, issue: w.issue, pr, reason: `ac-snapshot-drift: ${reason}` };
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge, state, supervisor, cfg } = deps;
  const now = deps.now;
  const iso = () => now().toISOString();
  const threshold = cfg.worker.heartbeatStaleSecs;

  // #210: retained-worktree release scan — before the kill-switch gate on purpose. It is an
  // OBSERVATION of state the engine already owns (no forge call, no spawn, no board write), and
  // a human clearing a folder mid-drain must still clear the Needs-attention row.
  releaseVanishedWorktrees(state);

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
    // #375 AC2: the kill-switch gate short-circuits before evaluateCeiling ever runs (#69's own
    // documented trade-off — no ceiling evaluation under an active switch), so daily-budget
    // status for the `driving`-lane drain check below has to be read fresh, here, rather than
    // reused from a ceiling-section variable that doesn't exist on this path yet. Pure (a DB
    // read + a config compare, no forge call) — safe under a kill-switch-frozen tick.
    const killSwitchDailyBudgetBreached = budgetExceeded(state.dailySpendUsd(now()), cfg.cost.dailyBudgetUsd);
    const { drainRequested, escalated } = await drainThenEscalate(
      forge,
      state,
      supervisor,
      cfg,
      ["kill-switch"],
      now(),
      iso,
      // #375 review round 1 (P1): DRIVE never runs under an active kill switch (this branch
      // returns before it) — the heuristic is the ONLY evidence this caller can ever have. See
      // `DrivingDrainMode`'s own doc for why the ceiling-path caller below must NOT share it.
      { mode: "heuristic", dailyBudgetBreached: killSwitchDailyBudgetBreached },
    );
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
  // #375 review round 2 (P1): `paused` above also folds in round.ts's OWN `forceDispatchPause`
  // (round-budget / round-dispatch-cap / milestone / run-level stop conditions — see round.ts's
  // tryDispatchWave/recordBudgetStop) — none of those are "new dispatch" from a driving lane's
  // fix leg's point of view: an already-open PR finishing its own rework is continuing existing
  // work, never opening new work, the exact reasoning #375 item 1 already applied to
  // cost.roundBudgetUsd specifically. Folding `forceDispatchPause` into the fix-leg admission
  // gate (below) reproduced the SAME permanent wedge under a different trigger — a driving
  // lane's FIXUP forever blocked on "fix-leg-admission-blocked:paused" once ANY round/run-level
  // stop condition fired, never clearing until the round itself ended (Codex PR #388 review,
  // P1). DISPATCH is ALREADY fully frozen independently the moment `forceDispatchPause` fires —
  // round.ts sets `dispatchCapOverride: 0` in lockstep with it, and the DISPATCH gate below
  // checks `effectiveDispatchCap > 0` regardless of `paused` — so threading `forceDispatchPause`
  // into the fix-leg gate serves no purpose there except reintroducing the #375 wedge.
  // `humanPauseOnly` is the ONE genuine human control that should still hold a fix leg back —
  // the out-of-band `data/PAUSE` sentinel — matching this comment's own long-standing "PAUSE
  // only freezes DISPATCH, not existing-lane progression" intent below, which the fix-leg
  // admission gate had silently violated since #246 introduced it. RESUME's own admission gate
  // (`resumeSpendPaused`, below) and the llm-probe suppression deliberately keep using the wider
  // `paused`, unchanged — a `handoff` lane is NOT in `state.activeWorkers()` (running + driving +
  // fixing only), so a resume forever blocked by `forceDispatchPause` does not itself keep
  // `activeWorkers()` above zero — it is not the same wind-down-never-exits shape this issue
  // fixes. Scope kept deliberately narrow to the fix-leg gate; revisit RESUME separately if it
  // ever proves to share the shape.
  const humanPauseOnly = state.isPauseActive();
  // Snapshot before RECLAIM: a lane that writes .handoff during this tick gets one settled
  // terminal beat and becomes resumable on the NEXT tick, never immediately in the same tick.
  const handoffsAtTickStart = state.handoffWorkers();

  // ── ROLLBACK RETRY (#31): retry every board mutation still pending from a prior tick's
  //   recovery-path failure, BEFORE this tick does anything else. Never throws (see
  //   attemptRollback) — a still-failing forge only bumps the retry count or escalates.
  //   #168 SUSPENSION (PR #180 review P1-2): while a FORGE park episode is open, env-failure
  //   requeues and merged-path Done writes are not attempted at all — no forge write, no
  //   attempt-counter bump; the durable rows simply wait (frozen) and drain here on the first
  //   tick after the forge episode clears. Every OTHER pending rollback keeps its pre-#168
  //   retry behavior unchanged (its issue's failure was real, and its bounded
  //   retry-then-escalate contract predates parking). Gated on the FORGE row specifically —
  //   an llm-only park leaves the forge healthy, and holding requeues then would starve the
  //   canary of anything to dispatch.
  const rollbacks: RollbackOutcome[] = [];
  const forgeParkedThisTick = state.parkRow("forge") != null;
  for (const pending of state.pendingRollbacks()) {
    if (forgeParkedThisTick && suspendRollbackDuringForgePark(pending.reason)) continue;
    rollbacks.push(await attemptRollback(forge, state, cfg, pending, iso));
  }

  // ── LANE REVIVAL (#447): the OTHER thing an environment failure froze — a lane it killed
  //   while that lane held an OPEN PR, never escalated (`failed` + pr + gated_escalation_labeled
  //   = 0, see the env-failure-preserved branch of reclaimTerminalLane). Neither the PR-less
  //   orphan heal nor GATED RECLAIM below can reach it, so four live occurrences each took a
  //   manual `UPDATE workers SET state='driving'`. Drained here on the same "recover before this
  //   tick does anything else" convention as ROLLBACK RETRY above. The park suspension is the
  //   pass's OWN (PR #463 round 2: one owner, so the startup call sites cannot forget it) and
  //   covers BOTH sources, unlike the rollback suspension's forge-only gate — an llm park is
  //   precisely the quota storm this class comes from. Idempotent by construction: a revived row
  //   is `driving` and leaves the candidate set. Runs BEFORE DRIVE below, so a revived lane is
  //   re-driven from live PR state this same tick.
  await reviveEnvFailedPrLanes(forge, state, cfg, deps.log);

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
    if (deferForUnknownPr(state, w, p)) continue;
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
      // #287 (E4b, AC#1): as early as the session-init line is observed, record it durably —
      // well before this leg's own terminal reclaim would otherwise settle it into spend_ledger
      // (see State.getWorkerActualModels' own doc for why that's too late for a still-`driving`
      // lane's engine-agent review). Union-append, idempotent; a no-op once already recorded.
      if (p.actualModel) state.recordWorkerActualModel(w.name, p.actualModel);
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
    if (deferForUnknownPr(state, w, p)) continue;
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
      // #287 (E4b, AC#1): same early actual-model capture as the ordinary RECLAIM loop's KEEP
      // branch above — a fix leg is a live session too.
      if (p.actualModel) state.recordWorkerActualModel(w.name, p.actualModel);
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
      // #400: hold labels are NOT consulted here — hold's one carrier is the PR. See
      // gatedReentryDecision's own doc for the removal rationale and its bounded cost.
      const decision = gatedReentryDecision(hasReserveLabel(labels, cfg.escalation.humanLabels), attempts, cfg.lanes.gatedReentryCap);
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
  // #375 review round 1 (P1): lanes whose OWN fixable branch, THIS tick, actually hit a
  // ceiling-caused admission block or a genuine fix-rounds-cap exhaustion — the OBSERVED truth
  // DRIVE just produced, as opposed to the `drivingLaneTerminalForDrain` heuristic the
  // kill-switch path is stuck guessing with (DRIVE never runs there at all). Consulted only by
  // the CEILING section's own `drainThenEscalate` call, below, once this tick's DRIVE loop has
  // finished populating it — see that call site's own comment for why the two callers must NOT
  // share one predicate.
  const driveFixBlockedLanes = new Set<string>();
  // #375 (PM adjudication, option (a)-minimal): fix legs for an ALREADY-OPEN PR are EXEMPT
  // from cost.roundBudgetUsd — round budget paces NEW dispatch only (see the DISPATCH phase's
  // own `overBudget` below, a completely separate read against the SAME config key; that one
  // is untouched by this issue). A driving lane with an open PR has no other completion path
  // (merge or fix — there is no "abandon the PR" outcome), so round-budget-blocking its fix leg
  // was the dogfood-observed wedge (#375: F7/F8, round cap crossed -> FIXABLE forever queued,
  // round never closes). The fix-leg path below remains bounded by the three PRE-EXISTING
  // limits instead, unchanged: cfg.lanes.prFixCap (attempts — `cap` below), worker.budgetUsdSoft
  // (each fix leg's own per-worker graceful-handoff ceiling, enforced unchanged by
  // worker.ts/supervisor), and cfg.cost.dailyBudgetUsd (still enforced a few lines down, via
  // fixLegAdmissionBlockReason's `ceilingBreached` — evaluateCeiling folds in daily-budget +
  // wall-clock, NEVER round budget, so that admission check is untouched by this exemption).
  // Kept as a named constant (rather than inlining `false` at each call site) purely so the
  // two consumers below read as "the fix-leg path's own round-budget signal", documented once,
  // not two unexplained `false` literals.
  const driveOverBudget = false;
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
      // #283 (M10, E2, design #279 §5): AC-snapshot drift check — BEFORE gate.driveOne is ever
      // called for this lane. See checkAcDriftBeforeDrive's own doc for the fail-closed ordering
      // guarantee (drift routes to needsHuman and skips driveOne entirely this tick; a missing
      // snapshot is not drift and drives normally).
      const driftOutcome = await checkAcDriftBeforeDrive(forge, state, cfg, w, pr, iso);
      if (driftOutcome) {
        driven.push(driftOutcome);
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
        {
          head: w.review_triggered_head ?? null,
          at: w.review_triggered_at ?? null,
          generation: w.review_trigger_generation ?? 0,
          ambiguous: (w.review_trigger_ambiguous ?? 0) === 1,
          deltaChain: w.review_delta_chain ?? 0,
          inFlight: (w.review_trigger_in_flight ?? 0) === 1,
          coveredHead: w.review_covered_head ?? null,
        },
        (head, at, meta) => state.recordReviewTrigger(w.name, head, at, meta),
        {
          lock: { head: lockKind ? (w.review_fallback_head ?? null) : null, kind: lockKind },
          recordFallback: (lock) => state.recordReviewFallback(w.name, lock.head, lock.kind),
        },
        // #147 P1: a GATED-RECLAIM-re-entered lane's gate② must not be satisfied by the stale
        // pre-escalation review still sitting on the (unchanged) head — driveOne filters to
        // post-re-entry review signals when this is set.
        (w.gated_reentry_attempts ?? 0) > 0,
        (head, generation, coverageEstablished) => state.recordReviewVerdict(w.name, head, generation, coverageEstablished),
        deps.engineAgentDriveDeps?.(w, pr),
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
      //
      // #383 evaluated this site for the same per-tick steady-state spam as drive-queued/
      // fix-leg-dispatch-blocked and deliberately left it undeduped: unlike those two,
      // `reviewSilenceDuration` (merge-driver.ts) itself returns null once `needsHumanLabelPresent`
      // reads true on the NEXT freshly-fetched PR data — the label this branch just wrote closes
      // the loop on its own, so the event is already transition-shaped by construction (one
      // append per silence episode, contingent only on the addPRLabel write above succeeding),
      // with no separate durable-log dedup needed.
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
      // #294: hold-visibility. A hold is the one human-INITIATED carrier in the three-tier
      // escalation model, and until now it lived only inside gate derivation — deriveGate reads
      // the label live and appends nothing, so a held PR was indistinguishable from "waiting on
      // review" in persisted data (frontend-design.md §11 follow-up #7). driveOne reports its
      // live observation STATELESSLY every pass (it has no memory), so the transition is derived
      // HERE against the durable event log, the same dedup-the-event-not-the-signal paradigm as
      // the reviewer-failover announcement above: pr-held on the first pass that observes a
      // hold, pr-released on the first pass that observes it gone, nothing on steady-state
      // ticks. Crash-safe for free — the log IS the memory, so a kill -9 between the observation
      // and the next tick re-observes the same state and re-emits nothing. Purely additive: an
      // absent observation (the paths that never wrap one) is a no-op, never a release, and the
      // gate outcome below is untouched either way.
      if (outcome.holdObservation) {
        // #294 (Codex P2): scoped to (worker, pr) — see lastHoldEvent's own doc for the
        // lane-repointing rationale.
        const lastHold = state.lastHoldEvent(w.name, pr);
        if (outcome.holdObservation.held) {
          if (lastHold !== "pr-held") {
            state.appendEvent("pr-held", { worker: w.name, issue: w.issue, pr, label: outcome.holdObservation.label });
          }
        } else if (lastHold === "pr-held") {
          state.appendEvent("pr-released", { worker: w.name, issue: w.issue, pr });
        }
      }
      switch (outcome.kind) {
        case "merged":
          state.upsertWorker({ ...w, state: "done", ended_at: iso() });
          if (state.parkRow("forge") != null) {
            state.addPendingRollback(w.issue, "done", MERGED_BOARD_DONE_REASON, iso());
          } else {
            try {
              await forge.setBoardStatus(w.issue, "done");
            } catch (e) {
              const rollbackId = state.addPendingRollback(w.issue, "done", MERGED_BOARD_DONE_REASON, iso());
              rollbacks.push(
                await handleRollbackFailure(
                  forge,
                  state,
                  cfg,
                  { id: rollbackId, issue: w.issue, target: "done", reason: MERGED_BOARD_DONE_REASON, attempts: 0 },
                  e,
                  iso,
                ),
              );
            }
          }
          state.appendEvent("merged", { worker: w.name, issue: w.issue, pr, headOid: outcome.headOid });
          driven.push({ kind: "merged", worker: w.name, issue: w.issue, pr });
          break;
        case "needs-human":
          // #397 bucket 2: "a human must MERGE this PR" is a DIFFERENT required action from "the
          // machine stopped and a human owes the next decision", and it settles differently —
          // see settleHumanMergeOnly's own doc for why it never touches a label here.
          if (isHumanMergeOnlyVerdict(outcome.reason)) {
            driven.push(settleHumanMergeOnly(state, w, pr, outcome.reason, iso));
            break;
          }
          // #147 P2 (Codex PR #151): the label write goes FIRST, and its success is recorded
          // durably on the terminal row (gated_escalation_labeled) — because GATED RECLAIM's
          // re-entry signal is "the needs-human label is ABSENT", absence is only evidence of a
          // human act if the engine provably APPLIED the label. See escalateNeedsHuman's own doc
          // (shared with #246's fixLegResume-unwired degrade, C1) for the full rationale.
          driven.push(await escalateNeedsHuman(forge, state, cfg, w, pr, outcome.reason, iso));
          break;
        case "queued": {
          // Stays driving — retried next tick. Covers gate-pending (WAIT), a review-unavailable
          // (rate-limit/timeout) signal (#13 requires the latter to queue, never skip/soften
          // gate②), and a freshly-posted review trigger (#55 P1-B "review-triggered" — the pin
          // was just recorded into State above; next tick re-reads it and proceeds to gating).
          //
          // #383 (F4): driveOne reports "queued" STATELESSLY on EVERY DRIVE pass that lands here
          // (it has no memory), so an unconfirmed append-every-tick reappended the identical
          // reason all the way through a lane's whole WAIT dwell — measured ~30 appends in 600ms
          // against one WAIT-gated lane. Same paradigm as #294's pr-held/pr-released and #54's
          // reviewer-fallback-* above: dedupe the EVENT, not the signal, against the durable log.
          // Announce only when `reason` differs from the last drive-queued recorded for this
          // (worker, pr) — steady state re-emits nothing, a reason change (e.g. a fresh review
          // trigger swapping in) re-emits, and a kill -9 between the observation and the next
          // tick re-reads the same durable answer and re-emits nothing either (the log IS the
          // memory — no in-process flag to lose). #395/#405: this cannot regress the liveness
          // watchdog — it samples the TUPLE (maxEventId, last_tick_at), and last_tick_at
          // advances every tick regardless of what this branch appends (see watchdog.ts).
          const lastQueuedReason = state.lastDriveQueuedReason(w.name, pr);
          if (lastQueuedReason !== outcome.reason) {
            state.appendEvent("drive-queued", { worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          }
          driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: outcome.reason });
          break;
        }
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
          // and `driveOverBudget` (#375: hardcoded `false` — a fix leg is exempt from round
          // budget; see that constant's own doc for what still bounds it).
          const fixRounds = w.fix_rounds ?? 0;
          const cap = cfg.lanes.prFixCap;
          const action = driveDecision("FIXABLE", fixRounds, cap, driveOverBudget);
          // #457 (F36): verdict-rerun breaker — see priorFixLegForVerdict's own doc. A prior
          // `drive-fixup` for this exact engine-agent verdict means its one leg already ran and
          // pushed nothing; a rerun gets byte-identical inputs, so no further fix round is spent
          // and the SAME escalation branch a spent cap takes below runs instead. Fixables with
          // no verdictRunId (classic reviewer, conflict, fallback) never trip it.
          const verdictRerun = outcome.verdictRunId !== undefined && priorFixLegForVerdict(state, w.name, outcome.verdictRunId);
          if (action === "FIXUP" && !verdictRerun) {
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
            // park / run-spend-stop). #375: round budget is deliberately NOT one of them any
            // more — `overBudget: driveOverBudget` below is always `false` now (see that
            // constant's own doc), so this admission check's `ceilingBreached` (daily-budget +
            // wall-clock only, never round budget) is the sole budget-shaped gate a fix leg still
            // has to clear. #375 review round 2 (P1): `paused: humanPauseOnly` below (NOT the
            // wider `paused`) for the exact same reason — round.ts's own `forceDispatchPause`
            // (round-budget/round-dispatch-cap/milestone/run-level stop conditions) is not a
            // human pause and not "new dispatch" from a fix leg's point of view; see
            // `humanPauseOnly`'s own doc, above the kill-switch/PAUSE section, for the full
            // reasoning and why RESUME deliberately keeps the wider `paused`. A wind-down must
            // drain, never start a brand-new fix leg instead — that's still fully enforced here,
            // just via `ceilingBreached`/`parkActive`/`runSpendStop` and a GENUINE human pause,
            // not round.ts's internal dispatch-quota bookkeeping. Blocked -> stays driving,
            // retried next tick (transient); the gate derivation itself already ran (this only
            // gates the spawn). Ceiling/run-spend-stop are read FRESH here (E1), not from a
            // pre-DRIVE-loop snapshot — DRIVE can run long across many lanes, and wall-clock
            // keeps elapsing regardless of spend, so a snapshot taken before the loop started
            // could be stale by the time a LATER lane reaches this check.
            const admissionBlock = fixLegAdmissionBlockReason({
              paused: humanPauseOnly,
              ceilingBreached: ceilingReasonsAsOf(now()).length > 0,
              parkActive: parkedBeforeProbes,
              overBudget: driveOverBudget,
              runSpendStop: deps.runSpendStopCrossed?.() ?? false,
            });
            if (admissionBlock != null) {
              const reason = `fix-leg-admission-blocked:${admissionBlock}`;
              // #383 (F30): same steady-state shape and same fix as drive-queued above — this
              // branch re-evaluates every tick a lane stays blocked, and a real 90-minute llm
              // park measured 77 duplicate events (2757-2833) for one unchanged blockReason.
              // Announce only when blockReason differs from the last fix-leg-dispatch-blocked
              // recorded for this (worker, pr); see drive-queued's own comment for the full
              // event-log-as-memory/crash-rerun/watchdog rationale, identical here.
              const lastBlockReason = state.lastFixLegDispatchBlockedReason(w.name, pr);
              if (lastBlockReason !== admissionBlock) {
                state.appendEvent("fix-leg-dispatch-blocked", { worker: w.name, issue: w.issue, pr, blockReason: admissionBlock });
              }
              driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason });
              // #375 review round 1 (P1): ONLY a ceiling-caused block belongs in the observed
              // set the CEILING section's drain consults below — `paused`/`park`/`run-spend-stop`
              // are separate, typically human-controlled or self-healing conditions, unrelated to
              // the daily-budget/wall-clock breach that triggers that drain at all (first-match-
              // wins in fixLegAdmissionBlockReason means a paused+breached tick reports "paused"
              // here, correctly excluding it — that lane isn't stuck for a BUDGET reason).
              if (admissionBlock === "ceiling") driveFixBlockedLanes.add(w.name);
              break;
            }
            try {
              await startFixLeg(
                { state, supervisor, renderFixPrompt: deps.fixLegResume.renderFixPrompt },
                w,
                { mint: deps.fixLegResume.mintProxy, credentialFree: true },
                now,
                outcome.prescription,
              );
              // #457: the `verdictRunId` recorded here is what priorFixLegForVerdict matches on —
              // the breaker's one durable memory of "this verdict already got its leg".
              state.appendEvent("drive-fixup", {
                worker: w.name,
                issue: w.issue,
                pr,
                fixRounds: fixRounds + 1,
                reason: outcome.reason,
                ...(outcome.verdictRunId !== undefined ? { verdictRunId: outcome.verdictRunId } : {}),
              });
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
          // action === "ESCALATE" (or #457's verdict-rerun breaker fell through from FIXUP
          // above): with `driveOverBudget` now permanently `false` (#375 — a fix
          // leg is exempt from round budget, so driveDecision's own overBudget-escalate branch
          // can never fire here anymore), the ONLY way this branch is reached is fixRounds
          // already >= cap (or a non-integer/negative fix_rounds, driveDecision's own fail-safe)
          // — genuinely exhausted, permanent escalation. #147's GATED RECLAIM is the post-
          // adjudication reentry channel back in. (The pre-#375 transient "retry next tick,
          // no state change" branch this comment used to describe is gone: round-budget alone
          // can no longer wedge a fix leg, and the daily-budget/pause/park/run-spend-stop
          // reasons are handled entirely by the admission-block check above, which leaves the
          // lane `driving`+queued without ever reaching `action === "ESCALATE"` at all.)
          // #375 review round 1 (P1): this IS the observed, this-tick truth that the lane is
          // fix-rounds-capped — add it to the CEILING section's drain set unconditionally
          // (regardless of which sub-branch below it falls into: labeled+commented+terminal, or
          // stuck `driving`+queued on a transient forge-write failure). A write-failure retry
          // would normally converge on its own next tick, but if THIS SAME tick also happens to
          // be past the ceiling drain window, there is no reason to make it wait an extra tick
          // for what DRIVE already proved true right here.
          driveFixBlockedLanes.add(w.name);
          // #457: TWO entry reasons share this one escalation shape — fixRounds >= cap (the
          // pre-existing ESCALATE branch) or the verdict-rerun breaker above. Same
          // forge-before-terminal-upsert ordering, same #147 gated-reentry path out; only the
          // reason string and comment wording differ.
          const escalReason = verdictRerun ? "fix-leg-no-op:verdict-rerun" : `fix-rounds-cap:${fixRounds}/${cap}`;
          const escalComment = verdictRerun
            ? `sapwood: no further fix leg for PR #${pr} — one already ran against this exact review verdict ` +
              `and pushed no change (${fixRounds} fix round(s) spent of ${cap}), so the standing signal is not ` +
              `producer-fixable (${outcome.reason}). If that leg committed work whose push failed, it is still ` +
              `in the lane's preserved worktree — check there for unpushed commits before adjudicating. ` +
              `Escalating to \`${cfg.labels.needsHuman}\` for ` +
              `adjudication: resolve the signal, then remove the label to reclaim the PR (#147 gated reentry).`
            : `sapwood: fix-round cap (${cap}) reached for PR #${pr} — ${fixRounds} round(s) spent, ` +
              `standing fixable signal unresolved (${outcome.reason}). Escalating to \`${cfg.labels.needsHuman}\` for ` +
              `adjudication: resolve the signal, then remove the label to reclaim the PR (#147 gated reentry).`;
          // Cap exhausted (or verdict rerun). Hard rule (#69/#147 forge-before-terminal-upsert): the needs-human
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
            await forge.addIssueComment(w.issue, escalComment);
          } catch (e) {
            state.appendEvent("fix-rounds-cap-comment-failed", { worker: w.name, issue: w.issue, pr, error: String(e) });
            driven.push({ kind: "queued", worker: w.name, issue: w.issue, pr, reason: "fix-rounds-cap-comment-failed" });
            break;
          }
          state.upsertWorker({ ...w, state: "failed", ended_at: iso(), gated_escalation_labeled: 1 });
          // #457: a breaker trip gets its own terminal event kind — it is NOT a spent cap
          // (fixRounds < cap is the whole point) and carries the verdict identity for audit.
          if (verdictRerun) {
            state.appendEvent("fix-leg-verdict-rerun", {
              worker: w.name,
              issue: w.issue,
              pr,
              fixRounds,
              cap,
              ...(outcome.verdictRunId !== undefined ? { verdictRunId: outcome.verdictRunId } : {}),
            });
          } else {
            state.appendEvent("fix-rounds-capped", { worker: w.name, issue: w.issue, pr, fixRounds, cap });
          }
          driven.push({ kind: "needs-human", worker: w.name, issue: w.issue, pr, reason: escalReason });
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
    ({ drainRequested, escalated } = await drainThenEscalate(
      forge,
      state,
      supervisor,
      cfg,
      ceilingReasons,
      nowDate,
      iso,
      // #375 review round 1 (P1): DRIVE already ran THIS tick (it precedes this CEILING
      // section) — the heuristic `drivingLaneTerminalForDrain` uses on the kill-switch path
      // would false-positive here (a fix-capped-from-history lane sitting in WAIT_REVIEW can
      // still merge for free the moment review lands; DRIVE's ESCALATE only fires on a NEW
      // finding). Pass the OBSERVED set instead — lane names whose own fixable branch, THIS
      // tick, actually hit a ceiling-caused admission block or a genuine cap exhaustion (see
      // `driveFixBlockedLanes`'s own doc, and `DrivingDrainMode`'s).
      { mode: "observed", blockedLanes: driveFixBlockedLanes },
    ));
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
      // #374: a known reset-time hint floors the first useful probe (env-failure.ts's
      // probeDueWithHint) — reduces to plain probeDue when no hint was ever recorded for this
      // episode (llmEpisode.resetHintAt == null), byte-identical to pre-#374 behavior.
      if (probeDueWithHint(llmEpisode.lastProbeAt, nowDate.getTime(), backoffSec, llmEpisode.resetHintAt)) {
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
      // #295 review round 4 (Codex P1): same as resume-undecidable — preserve the known PR.
      state.appendEvent("resume-capped", { worker: w.name, issue: w.issue, attempts, ...(w.pr != null ? { pr: w.pr } : {}) });
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
      // A continuation re-renders the default prompt and re-derives conflict state from live pr_details; custom fix prompts retain the accepted bounded blind spot.
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
      // #301 review (P1#1/P1#3): hoisted OUTSIDE the try so it's available below to stamp onto
      // the fresh WorkerRow. Built and recorded INSIDE the try (next line) so a build/record
      // failure still rolls the claim back exactly like a dispatch() failure would; definite-
      // assignment is safe because every path past the try/catch below only runs on success.
      let acSnapshot!: ReturnType<typeof buildAcSnapshot>;
      try {
        // #283 (M10, E2, design #279 §5): the AC-authority snapshot lands BEFORE the worker
        // ever spawns — same fail-closed unit as the dispatch attempt itself (this try/catch):
        // if persisting it throws, the catch below rolls the board claim back to Ready exactly
        // like a supervisor.dispatch() failure would, so a snapshot-write hiccup can never leave
        // a worker running against an unrecorded AC set. Built from the SAME `issue.body`
        // getReadyIssues already fetched this tick for the dispatch decision — never a second,
        // possibly-disagreeing live read.
        acSnapshot = buildAcSnapshot(issue.number, issue.body ?? "", iso());
        state.recordAcSnapshot(acSnapshot);
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
        // #301 review (P1#1/P1#3): this lane's OWN dispatch-time snapshot identity, read straight
        // from the `acSnapshot` local var built moments earlier in this SAME synchronous try
        // block — never a re-read from `ac_snapshots` (which a LATER dispatch for the same issue
        // could since have overwritten). See checkAcDriftBeforeDrive for how this is used.
        ac_body_hash: acSnapshot.bodyHash,
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
