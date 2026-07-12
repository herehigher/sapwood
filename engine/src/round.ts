// round.ts — the round-loop skeleton (#86, implementing #77 decisions 1/2/4): layers ABOVE
// the tick engine (conductor.ts's tick()), never rewrites it. A round = dispatch one batch ->
// tick until that batch drains -> peripheral-phase stubs -> close -> (maybe) next round.
//
// This is a STANDALONE loop, not a modification of driver.ts's runDriver: that function has
// 20+ tests validating its flat forever/once/until-idle behavior, and interleaving round-phase
// branching into it would be the highest-risk way to satisfy "existing tests stay green."
// round.ts calls tick() directly (same as runDriver does) and reuses driver.ts's two pure
// stop-condition counters (issuesMergedThisTick/prsOpenedThisTick) and its StopConfig/
// StopConditionHit shapes for the FINAL (whole-run) stop conditions, driven at round
// boundaries instead of every tick.
//
// Peripheral role sessions (aligning/architecting/plan_review/harvesting/retro) are STUBBED
// here — the real role runner + prompts are a follow-up issue (#86's own scope note). Rerun-
// not-resume (#77 decision 4): a crash mid-phase leaves the `rounds` row `in_progress` at that
// exact phase; on restart round.ts resumes AT that phase (never re-running an earlier,
// already-completed one) and re-invokes its stub FRESH — never resuming a prior attempt's
// mid-session state. The stub is handed the row's persisted marker and is contractually
// responsible for treating a non-null marker as "already externalized, don't duplicate."
import { tick, type TickDeps, type TickResult, type Supervisor, type MergeGate } from "./conductor.js";
import type { IForge, Issue } from "./forge.js";
import { State, type RoundPhase, type RoundRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import {
  issuesMergedThisTick,
  prsOpenedThisTick,
  type StopConfig,
  type StopConditionHit,
} from "./driver.js";

export type { RoundPhase, RoundRow } from "./state.js";

/** Every RoundPhase except the two the round loop itself owns (`executing` is tick()'s
 *  dispatch-batch-then-drain step, no stub; `closed` is terminal). */
export type PeripheralPhase = Exclude<RoundPhase, "executing" | "closed">;

const SEQUENCE: readonly RoundPhase[] = [
  "aligning", "architecting", "plan_review", "executing", "harvesting", "retro", "closed",
];

/** One externalized-artifact-producing peripheral role session — STUBBED in #86 (the real
 *  role runner/prompts are a follow-up issue). Rerun-not-resume (#77 decision 4): run() is
 *  ALWAYS invoked fresh, never resuming a prior attempt's mid-session state — idempotency is
 *  the stub's OWN job, keyed by `marker`: null on the first attempt for this (round, phase);
 *  non-null when a prior attempt crashed after externalizing something (a comment, a document,
 *  ...) but before the round advanced past this phase. A correct stub must treat a non-null
 *  marker as "already done — do not duplicate that side effect" (it may simply return the same
 *  marker unchanged). */
export interface PeripheralStub {
  run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }): Promise<{ marker: string }>;
}

/** The only implementation shipped in #86 — every peripheral phase is a true no-op. Real role
 *  sessions are a follow-up issue (#86's own "out of scope" note). */
export const noopPeripheralStub: PeripheralStub = {
  async run({ marker }) {
    return { marker: marker ?? "noop" };
  },
};

/** Which round-level condition ended this round's DISPATCH (never its drain — in-flight lanes
 *  always finish; see runExecuting). OR semantics, first hit wins, mirroring driver.ts's
 *  StopConditionHit for the final conditions. */
export interface RoundStopHit {
  name: "roundBudgetUsd" | "roundDispatchCap" | "milestone";
  detail: string;
}

export interface RoundDeps {
  forge: IForge;
  state: State;
  supervisor: Supervisor;
  cfg: SapwoodConfig;
  /** The round loop's own tick cadence — same role as DriverDeps.tickIntervalSec. */
  tickIntervalSec: number;
  mergeGate?: MergeGate;
  now?: () => Date;
  /** Injected sleep so tests can drive the loop without real wall-clock waits (same contract
   *  as driver.ts's DriverDeps.sleep). */
  sleep?: (ms: number) => Promise<void>;
  registerSignals?: (requestStop: () => void) => () => void;
  onTick?: (result: TickResult) => void;
  /** Observability/test hook: fired once a peripheral phase's stub has run and its marker has
   *  been persisted (i.e. right before advancing past that phase). */
  onRoundPhase?: (roundId: number, phase: PeripheralPhase) => void;
  /** Observability/test hook: fired the moment a round-level stop condition is first detected. */
  onRoundStop?: (roundId: number, hit: RoundStopHit) => void;
  /** Peripheral stub per phase; unset phases default to noopPeripheralStub. */
  peripherals?: Partial<Record<PeripheralPhase, PeripheralStub>>;
  /** FINAL (whole-run) stop conditions — same shape/semantics as driver.ts's StopConfig,
   *  checked preemptively before opening a NEW round (never mid-round: a round already open
   *  always finishes its remaining phases, including harvest+retro, first). */
  stop?: StopConfig;
}

export interface RoundsResult {
  /** Rounds fully closed this run. */
  rounds: number;
  ticks: number;
  tickErrors: number;
  /** "kill-switch": a peripheral phase was blocked by an active KILL_SWITCH — the round loop
   *  stops immediately, without running that (or any later) peripheral for the round in
   *  flight. "signal"/"stop-condition": graceful — the round already open always finishes
   *  harvest+retro and closes before the loop stops; only a NEW round is withheld. */
  stoppedBy: "signal" | "stop-condition" | "kill-switch";
  stopCondition?: StopConditionHit;
}

function defaultRegisterSignals(requestStop: () => void): () => void {
  const handler = (): void => requestStop();
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

/** Wraps an IForge so getReadyIssues() only returns issues in the configured round milestone
 *  (#86's "also filters dispatch candidates" half of round.milestone). Every other method
 *  delegates unchanged — explicit passthrough, no Proxy magic. milestone undefined ->
 *  passthrough getReadyIssues() too (today's behavior, no scoping). */
export class RoundScopedForge implements IForge {
  constructor(private readonly inner: IForge, private readonly milestone: string | undefined) {}

  async getReadyIssues(): Promise<Issue[]> {
    const issues = await this.inner.getReadyIssues();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }

  detectOwnerKind(owner: string) { return this.inner.detectOwnerKind(owner); }
  claimIssue(issue: number) { return this.inner.claimIssue(issue); }
  setBoardStatus(issue: number, status: Parameters<IForge["setBoardStatus"]>[1]) {
    return this.inner.setBoardStatus(issue, status);
  }
  addLabel(issue: number, label: string) { return this.inner.addLabel(issue, label); }
  addPRLabel(pr: number, label: string) { return this.inner.addPRLabel(pr, label); }
  openPR(branch: string, title: string, body: string) { return this.inner.openPR(branch, title, body); }
  getPRStatus(pr: number) { return this.inner.getPRStatus(pr); }
  mergePR(pr: number, headOid: string) { return this.inner.mergePR(pr, headOid); }
  addPRComment(pr: number, body: string) { return this.inner.addPRComment(pr, body); }
  addIssueComment(issue: number, body: string) { return this.inner.addIssueComment(issue, body); }
  getPRReviewData(pr: number) { return this.inner.getPRReviewData(pr); }
  getPRDiff(pr: number) { return this.inner.getPRDiff(pr); }
  getCommitsSince(sinceIso: string) { return this.inner.getCommitsSince(sinceIso); }
  branchExists(branch: string) { return this.inner.branchExists(branch); }
  getIssueBody(issue: number) { return this.inner.getIssueBody(issue); }
  updateIssueBody(issue: number, body: string) { return this.inner.updateIssueBody(issue, body); }
  countOpenIssuesInMilestone(milestone: string) { return this.inner.countOpenIssuesInMilestone(milestone); }
  listMilestoneTitles() { return this.inner.listMilestoneTitles(); }
  getIssueLabels(issue: number) { return this.inner.getIssueLabels(issue); }
  getIssueComments(issue: number) { return this.inner.getIssueComments(issue); }

  /** Same milestone scoping as getReadyIssues() above — the plan_review peripheral's
   *  candidates are dispatch candidates too (just for review, not for a worker), so this round
   *  should only review issues actually in scope for it. */
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    const issues = await this.inner.getIssuesNeedingPlanReview();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }

  createIssue(title: string, body: string) { return this.inner.createIssue(title, body); }
  listOpenIssueNumbers() { return this.inner.listOpenIssueNumbers(); }

  /** #89: same milestone scoping as getIssuesNeedingPlanReview above — the PO/triage
   *  peripheral's candidates are dispatch candidates too (just pre-Ready), so a round scoped to
   *  one milestone should only triage issues actually in scope for it. */
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    const issues = await this.inner.getIssuesNeedingPlanTriage();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }
}

/**
 * Run rounds until a stop condition fires. Always attempts at least one round.
 *
 * Outer shape per round: check final `stop.*` preemptively (before opening a NEW round only —
 * never mid-round) -> peripheral phases (aligning/architecting/plan_review) -> `executing`
 * (one dispatch-enabled tick, then drain-only ticks until nothing's in flight) -> peripheral
 * phases (harvesting/retro) -> close. Rerun-not-resume: a round already `in_progress` on
 * startup (state.openRound()) is picked up AT its persisted phase, not restarted from
 * `aligning` — earlier, already-completed phases are never re-run.
 */
export async function runRounds(deps: RoundDeps): Promise<RoundsResult> {
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const cfg = deps.cfg;
  const forge: IForge = cfg.round.milestone ? new RoundScopedForge(deps.forge, cfg.round.milestone) : deps.forge;
  const peripherals = deps.peripherals ?? {};

  let signalled = false;
  let wakeFromSleep: (() => void) | null = null;
  const unregister = (deps.registerSignals ?? defaultRegisterSignals)(() => {
    signalled = true;
    wakeFromSleep?.();
  });
  // Same signal-abortable inter-tick wait as driver.ts's interTickWait — see its comment there
  // for the shutdown-latency rationale this shape closes.
  const interTickWait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        wakeFromSleep = null;
        resolve();
      };
      if (deps.sleep) {
        wakeFromSleep = finish;
        void deps.sleep(ms).then(finish);
      } else {
        const t = setTimeout(finish, ms);
        wakeFromSleep = () => {
          clearTimeout(t);
          finish();
        };
      }
      if (signalled) wakeFromSleep?.();
    });

  let ticks = 0;
  let tickErrors = 0;
  let roundsClosed = 0;
  let issuesMerged = 0;
  let prsOpened = 0;
  let finalStopHit: StopConditionHit | undefined;
  // #125 standby: consecutive empty probes since the last time a round actually opened — the
  // exponential-backoff exponent. In-memory only (never persisted): a process restart is a fresh
  // start at n=0, same as #109's idle throttle carries no state across restarts either.
  let standbyAttempts = 0;
  // #125 idle-round precondition (Codex P1, PR #150 round 2): did the LAST round this run
  // completed dispatch nothing (workersThisRound === 0 — the same signal the #109 throttle
  // keys on)? Standby may only engage after such a round: the probe's three API signals can
  // all be empty while the aligning phase's PO still has real work — decomposing the plan doc
  // (align.ts's align mode reads docs/PLAN.md ALONE) into a first backlog on a fresh/unscoped
  // repo — so the first round of a run ALWAYS opens, giving the PO its decomposition shot; if
  // it drafts issues, the probe sees them (triage/Ready) and rounds continue. Only once a full
  // round came up empty AND the board is still probe-empty does the run sleep. In-memory only,
  // like standbyAttempts: a restart is a fresh shot for the PO (deliberate — the cheapest
  // "wake the PO" lever an operator has).
  let lastRoundIdle = false;

  /** Contained tick() call (same containment stance as driver.ts's runDriver): a thrown tick
   *  is a structured tick-error event, never a crash, never a hot retry loop (callers still
   *  sleep the normal cadence around this). Also updates the FINAL stop-condition counters. */
  const runTick = async (tickDeps: TickDeps): Promise<TickResult | null> => {
    try {
      const result = await tick(tickDeps);
      ticks++;
      deps.onTick?.(result);
      issuesMerged += issuesMergedThisTick(result);
      prsOpened += prsOpenedThisTick(result);
      if (!finalStopHit) {
        const stop = deps.stop;
        if (stop?.afterIssuesMerged !== undefined && issuesMerged >= stop.afterIssuesMerged) {
          finalStopHit = { name: "afterIssuesMerged", threshold: stop.afterIssuesMerged, detail: `merged ${issuesMerged}` };
        } else if (stop?.afterPRsOpened !== undefined && prsOpened >= stop.afterPRsOpened) {
          finalStopHit = { name: "afterPRsOpened", threshold: stop.afterPRsOpened, detail: `opened ${prsOpened}` };
        }
      }
      return result;
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: String(e) });
      } catch { /* state write failed too — tickErrors still counts it */ }
      return null;
    }
  };

  /** #76-style onMilestoneComplete, checked at ROUND boundaries (not every tick) — this run's
   *  FINAL condition, distinct from cfg.round.milestone's per-round scoping. Contained: a
   *  throwing read is a tick-error, never a fired condition, never a crash. */
  const checkFinalMilestone = async (): Promise<void> => {
    const m = deps.stop?.onMilestoneComplete;
    if (!m || finalStopHit) return;
    try {
      const openLeft = await deps.forge.countOpenIssuesInMilestone(m);
      if (openLeft === 0) finalStopHit = { name: "onMilestoneComplete", threshold: m, detail: "0 open issues left" };
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: `stop-condition milestone check failed: ${String(e)}` });
      } catch { /* state write failed too — tickErrors still counts it */ }
    }
  };

  /** #125 standby: cheap pre-round probe (one local SQLite read + pure GitHub API, no LLM) —
   *  true the moment there is ANY signal that a new round would have real work to do. 'Ready empty' alone is NOT "nothing to do": a
   *  plan-review candidate needs gate⓪; a plan-TRIAGE candidate (any open plan-less issue,
   *  regardless of board status — Codex P1 on PR #150: exactly what the aligning phase's PO
   *  triage pass consumes, so skipping it would back off forever over a backlog the PO exists
   *  to draft plans into) needs the PO; and — when `round.milestone` scopes this run — an open
   *  issue still sitting in that milestone (not yet Ready, not yet reviewed) is exactly the PO/
   *  aligning peripheral's job to decompose, so it counts as work too. Unset milestone can't
   *  express a "goals exhausted" signal at all (no scoping to ask about, and the future
   *  goal-file target this parenthetical anticipates — M5 #135 — isn't shipped yet), so it
   *  contributes no vote either way, same "unset = no scoping" stance as RoundScopedForge. Reads
   *  the same (possibly milestone-scoped) `forge` runExecuting/checkFinalMilestone already use.
   *
   *  An all-empty probe is still not proof of "nothing to do" — the PO can decompose the plan
   *  doc alone — which is why standby additionally requires the idle-round precondition (see
   *  lastRoundIdle). Known ceiling: a plan-doc edit made DURING standby is invisible to this
   *  pure-API probe — the operator files an issue (any probe signal) or restarts the run to
   *  wake the PO.
   *
   *  Contained, fail-OPEN to round-opening (gate② on PR #150; same tick-error containment as
   *  checkFinalMilestone above): standby is exactly the long-idle mode where this probe runs
   *  for hours, so a transient GitHub failure (rate limit, network blip) is near-certain
   *  eventually — it must never crash the run OR read as "nothing to do" (an indefinite silent
   *  wait). A throwing probe is a recorded tick-error and counts as "has work": the round opens
   *  and pre-#125 behavior resumes — the peripherals can cope with an occasionally-unnecessary
   *  round, same fail-toward-more-work stance as every other contained read in this module. */
  const probeHasWork = async (): Promise<boolean> => {
    try {
      // Codex P2 (PR #150 round 4): pending rollback rows are retried ONLY inside a tick
      // (conductor.ts), and the failure that created one can be exactly what removed the
      // board's Ready signal (a claimed-but-dead issue is invisible to every API probe below) —
      // so an outstanding row counts as work, or standby would starve the retry indefinitely.
      // Local SQLite read: the cheapest signal, checked first.
      if (deps.state.pendingRollbacks().length > 0) return true;
      if ((await forge.getReadyIssues()).length > 0) return true;
      if ((await forge.getIssuesNeedingPlanReview()).length > 0) return true;
      if ((await forge.getIssuesNeedingPlanTriage()).length > 0) return true;
      if (cfg.round.milestone) {
        return (await forge.countOpenIssuesInMilestone(cfg.round.milestone)) > 0;
      }
      return false;
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: `standby probe failed: ${String(e)}` });
      } catch { /* state write failed too — tickErrors still counts it */ }
      return true;
    }
  };

  const toTickDeps = (over: { forge: IForge; forceDispatchPause?: boolean; roundSpendUsd?: number }): TickDeps => ({
    forge: over.forge,
    state: deps.state,
    supervisor: deps.supervisor,
    cfg: deps.cfg,
    tickIntervalSec: deps.tickIntervalSec,
    // exactOptionalPropertyTypes: only include optional keys when actually provided — an
    // explicit `undefined` is not the same as an omitted key under this tsconfig setting.
    ...(deps.mergeGate !== undefined ? { mergeGate: deps.mergeGate } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(over.forceDispatchPause !== undefined ? { forceDispatchPause: over.forceDispatchPause } : {}),
    ...(over.roundSpendUsd !== undefined ? { roundSpendUsd: over.roundSpendUsd } : {}),
  });

  /** Run one peripheral phase's stub, persist its marker, fire the observability hook. Returns
   *  false (never invoking the stub) when KILL_SWITCH is active — the caller must stop the
   *  whole loop without advancing past this phase. */
  const runPeripheral = async (round: RoundRow, phase: PeripheralPhase): Promise<boolean> => {
    if (deps.state.isKillSwitchActive()) return false;
    const stub = peripherals[phase] ?? noopPeripheralStub;
    // Rerun-not-resume marker: only the phase we are CURRENTLY sitting in (round.phase ===
    // phase — true both for a fresh phase just advanced into this run, and for a phase we
    // resumed directly into after a crash) carries a meaningful persisted marker. Any other
    // phase in the sequence is being entered fresh this run, so its marker is null regardless
    // of what artifact_ref happens to hold (it belongs to whatever phase set it last).
    const marker = round.phase === phase ? round.artifact_ref : null;
    const { marker: newMarker } = await stub.run({ roundId: round.round_id, phase, marker });
    deps.state.setRoundMarker(round.round_id, newMarker, iso());
    deps.onRoundPhase?.(round.round_id, phase);
    return true;
  };

  /** #95 follow-up: persist a round-stop hit to the durable event log (in addition to firing
   *  the observability hook) the instant it's first detected — so `round-stop` events survive
   *  an engine restart/crash even if nothing ever reads deps.onRoundStop live. Contained: same
   *  fail-toward-more-work stance as the tick-error appendEvent calls above — a write failure
   *  here must never abort the round loop or swallow the stop condition itself. */
  const emitRoundStop = (round: RoundRow, hit: RoundStopHit): void => {
    try {
      deps.state.appendEvent("round-stop", { round_id: round.round_id, name: hit.name, detail: hit.detail });
    } catch { /* state write failed — the hit still reaches onRoundStop below */ }
    deps.onRoundStop?.(round.round_id, hit);
  };

  /** The `executing` phase: one dispatch-enabled tick (the round's single "batch"), then
   *  drain-only ticks until nothing's in flight. `freshBatch` is false only when we RESUMED
   *  directly into `executing` after a crash mid-drain — re-running the batch dispatch in
   *  that case would double-dispatch on top of lanes already recovering via tick()'s own
   *  reclaim logic, so a resumed pass skips straight to draining what's already there.
   *  Returns how many workers this round put in flight (dispatched, or — resumed — inherited
   *  from activeWorkers): the caller's idle-throttle signal (#109 gate② P1, below). */
  const runExecuting = async (round: RoundRow, freshBatch: boolean): Promise<number> => {
    let stopHit: RoundStopHit | undefined;
    const dispatchedNames: string[] = [];
    const spentSoFar = (): number =>
      dispatchedNames.reduce((sum, n) => sum + deps.state.spentUsdForWorker(n), 0);

    // #95 follow-up: a resumed drain (crash mid-`executing`, restart resumes directly into this
    // phase — freshBatch false) never runs the dispatch tick below, so dispatchedNames would
    // stay permanently empty and cost.roundBudgetUsd could never fire for it (Codex PR #95
    // review) — a resumed round could overspend without limit. The exact set of lanes THIS
    // round originally dispatched isn't recoverable (that identity isn't persisted anywhere;
    // only the round's phase cursor + marker survive a crash), so the best available proxy is
    // every lane still ACTIVE right now (state.activeWorkers()) — exactly the lanes this
    // resumed drain loop is waiting on below. Known, accepted gap: a dispatched lane that
    // already finished (and had its spend recorded) in the crash-to-restart gap is invisible
    // here and under-counted — but that is strictly better than never evaluating the budget at
    // all, and it correctly tracks everything the drain loop's own exit condition depends on.
    if (!freshBatch) {
      for (const w of deps.state.activeWorkers()) dispatchedNames.push(w.name);
    }

    if (freshBatch) {
      let milestoneExhausted = false;
      if (cfg.round.milestone) {
        try {
          const openLeft = await deps.forge.countOpenIssuesInMilestone(cfg.round.milestone);
          if (openLeft === 0) {
            milestoneExhausted = true;
            stopHit = { name: "milestone", detail: "0 open issues left" };
          }
        } catch { /* contained: fail toward dispatching normally, same stance as driver.ts */ }
      }
      const batchResult = await runTick(toTickDeps({ forge, forceDispatchPause: milestoneExhausted, roundSpendUsd: 0 }));
      if (batchResult) {
        for (const d of batchResult.dispatched) if (d.kind === "dispatched") dispatchedNames.push(d.worker);
        if (!stopHit && dispatchedNames.length >= cfg.lanes.roundDispatchCap) {
          stopHit = { name: "roundDispatchCap", detail: `dispatched ${dispatchedNames.length}` };
        }
      }
      if (stopHit) emitRoundStop(round, stopHit);
    }

    // Drain until nothing's left in flight. tick() handles KILL_SWITCH drain-then-escalate
    // entirely internally — no special-casing needed here; this loop just keeps calling it on
    // cadence until state.activeWorkers() reaches 0. Never abandoned early by a signal: an
    // already-open round always finishes draining (never kills in-flight work) — only opening
    // a NEW round afterward is withheld.
    for (;;) {
      if (deps.state.activeWorkers().length === 0) break;
      await interTickWait(deps.tickIntervalSec * 1000);
      await runTick(toTickDeps({ forge, forceDispatchPause: true, roundSpendUsd: spentSoFar() }));
      if (!stopHit && dispatchedNames.length > 0 && spentSoFar() >= cfg.cost.roundBudgetUsd) {
        stopHit = { name: "roundBudgetUsd", detail: `spent $${spentSoFar().toFixed(2)}` };
        emitRoundStop(round, stopHit);
      }
      if (deps.state.activeWorkers().length === 0) break;
    }
    // stopHit has already been externalized (emitRoundStop) — the caller only needs the
    // in-flight count for the idle throttle.
    return dispatchedNames.length;
  };

  try {
    for (;;) {
      if (signalled) {
        return finalStopHit
          ? { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit }
          : { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "signal" };
      }

      let round = deps.state.openRound();
      if (!round) {
        await checkFinalMilestone();
        if (finalStopHit) {
          return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
        }

        // #125 standby: withhold opening a NEW round while the probe is provably empty, backing
        // off tickIntervalSec * 2^n (capped at round.standby.backoffCapSec) between probes — any
        // hit resets the exponent and opens the round immediately, no extra wait. Guarded by the
        // idle-round precondition (`roundsClosed > 0 && lastRoundIdle`, see lastRoundIdle's own
        // comment): standby only engages after a full round this run already came up empty, so
        // the PO always gets its plan-doc decomposition shot first. KILL_SWITCH
        // bypasses this entirely: a round is always OPENED first and blocked at its very first
        // peripheral phase (runPeripheral's own check) instead, the same contract every other
        // caller of this loop already relies on — standby must never turn that into "loops
        // forever probing instead" for an operator who just wants the freeze to take effect.
        if (cfg.round.standby.enabled && roundsClosed > 0 && lastRoundIdle && !deps.state.isKillSwitchActive()) {
          while (!(await probeHasWork())) {
            if (deps.state.isKillSwitchActive()) break; // let the round open & block normally
            const waitSec = Math.min(
              deps.tickIntervalSec * 2 ** standbyAttempts,
              cfg.round.standby.backoffCapSec,
            );
            // Observability-only write, best-effort (Codex P2 round 5, PR #150): this block sits
            // outside the contained tick(), so a transient state-write failure here must degrade
            // to a lost telemetry row, never take down an idle daemon — same stance as
            // checkFinalMilestone's nested catch above.
            try {
              deps.state.appendEvent("standby-wait", { attempt: standbyAttempts, waitSec });
            } catch { /* telemetry only — the wait itself proceeds */ }
            standbyAttempts++;
            // Codex P1 (PR #150 round 3): a backoff wait can be minutes long, and a KILL_SWITCH
            // created mid-sleep must not sit unnoticed until it elapses — kill-switch
            // acknowledgment is a documented safety property, and its check points must never be
            // farther apart than the tick cadence. So wait in tickIntervalSec-sized slices,
            // re-checking the sentinel between slices (one standby-wait event per backoff step
            // above, NOT per slice — the schedule and total wait are unchanged).
            let remainingSec = waitSec;
            while (remainingSec > 0 && !signalled && !deps.state.isKillSwitchActive()) {
              const sliceSec = Math.min(remainingSec, deps.tickIntervalSec);
              await interTickWait(sliceSec * 1000);
              remainingSec -= sliceSec;
            }
            if (deps.state.isKillSwitchActive()) break; // let the round open & block normally
            if (signalled) break;
            // Codex P2 (PR #150): re-check the FINAL stop condition on every standby wake —
            // checkFinalMilestone only ran once, before this block, so a stop.onMilestoneComplete
            // milestone completed EXTERNALLY while the board is otherwise idle (exactly the
            // --milestone scope+stop pairing, PR #149) would otherwise leave this loop probing
            // forever instead of ending the run.
            await checkFinalMilestone();
            if (finalStopHit) {
              return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
            }
          }
          // finalStopHit can't be set here (both checks above already returned if it were) —
          // a signal breaking the wait is always a plain "signal" stop, unlike the loop-top check.
          if (signalled) {
            return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "signal" };
          }
          if (standbyAttempts > 0) {
            try {
              deps.state.appendEvent("standby-exit", { attempts: standbyAttempts });
            } catch { /* telemetry only — see the standby-wait catch above */ }
            standbyAttempts = 0;
          }
        }

        round = deps.state.startRound(iso());
      }

      const startedPhase = round.phase; // captured once — the freshBatch test for `executing`
      let idx = SEQUENCE.indexOf(round.phase);
      let killSwitchStop = false;
      let workersThisRound = 0;

      while (SEQUENCE[idx] !== "closed") {
        const phase = SEQUENCE[idx]!;
        if (phase === "executing") {
          workersThisRound = await runExecuting(round, phase !== startedPhase);
        } else if (phase !== "closed") {
          // Narrowed to PeripheralPhase: every RoundPhase except "executing" (handled above)
          // and "closed" (excluded by the while guard — this branch is unreachable at
          // runtime, kept only so TypeScript can see the exhaustive narrowing).
          const ok = await runPeripheral(round, phase);
          if (!ok) {
            killSwitchStop = true;
            break;
          }
        }
        idx++;
        const nextPhase = SEQUENCE[idx]!;
        deps.state.advanceRoundPhase(round.round_id, nextPhase, iso());
        round = deps.state.getRound(round.round_id)!;
      }

      if (killSwitchStop) {
        return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "kill-switch" };
      }

      deps.state.closeRound(round.round_id, iso());
      roundsClosed++;
      // #125 idle-round precondition: record whether THIS round dispatched nothing — the gate
      // that lets standby engage at the top of the next iteration (see lastRoundIdle's comment).
      lastRoundIdle = workersThisRound === 0;
      // #109 gate② P1 (idle throttle): an IDLE round — zero workers in flight — closing and the
      // next opening back-to-back would run the real peripheral role sessions (PO/architect/
      // plan-review/harvest/retro Claude sessions, the production default since #106)
      // continuously on an empty backlog, burning tokens with no throttle. Wait one tick cadence
      // before opening the next round, via the SAME signal-abortable interTickWait the drain
      // loop uses: a SIGINT during this wait resolves it immediately (never delays shutdown —
      // the loop top's `signalled` check runs right after). A round that dispatched work is NOT
      // additionally throttled: its drain loop already paced it on the tick cadence.
      if (workersThisRound === 0 && !signalled) {
        await interTickWait(deps.tickIntervalSec * 1000);
      }
      // Loop back to the top: re-check signal / final-stop before opening the NEXT round.
    }
  } finally {
    unregister();
  }
}
