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
  getIssueBody(issue: number) { return this.inner.getIssueBody(issue); }
  countOpenIssuesInMilestone(milestone: string) { return this.inner.countOpenIssuesInMilestone(milestone); }
  listMilestoneTitles() { return this.inner.listMilestoneTitles(); }
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

  /** The `executing` phase: one dispatch-enabled tick (the round's single "batch"), then
   *  drain-only ticks until nothing's in flight. `freshBatch` is false only when we RESUMED
   *  directly into `executing` after a crash mid-drain — re-running the batch dispatch in
   *  that case would double-dispatch on top of lanes already recovering via tick()'s own
   *  reclaim logic, so a resumed pass skips straight to draining what's already there. */
  const runExecuting = async (round: RoundRow, freshBatch: boolean): Promise<RoundStopHit | undefined> => {
    let stopHit: RoundStopHit | undefined;
    const dispatchedNames: string[] = [];
    const spentSoFar = (): number =>
      dispatchedNames.reduce((sum, n) => sum + deps.state.spentUsdForWorker(n), 0);

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
      if (stopHit) deps.onRoundStop?.(round.round_id, stopHit);
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
        deps.onRoundStop?.(round.round_id, stopHit);
      }
      if (deps.state.activeWorkers().length === 0) break;
    }
    return stopHit;
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
        round = deps.state.startRound(iso());
      }

      const startedPhase = round.phase; // captured once — the freshBatch test for `executing`
      let idx = SEQUENCE.indexOf(round.phase);
      let killSwitchStop = false;

      while (SEQUENCE[idx] !== "closed") {
        const phase = SEQUENCE[idx]!;
        if (phase === "executing") {
          await runExecuting(round, phase !== startedPhase);
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
      // Loop back to the top: re-check signal / final-stop before opening the NEXT round.
    }
  } finally {
    unregister();
  }
}
