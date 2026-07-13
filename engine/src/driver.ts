// driver.ts — the M4 loop driver (#46): calls tick() on a fixed cadence
// (cfg.engine.tickIntervalSec), threading that cadence into TickDeps.tickIntervalSec so the
// wall-clock ceiling's session-gap scaling (conductor.ts engineSessionGapSec) sees the REAL
// cadence instead of silently falling back to the 900s floor — the "loop driver MUST pass
// tickIntervalSec into tick()" obligation PR #41/#42 left behind (PLAN.md M3 deferred list).
//
// Everything KILL_SWITCH/ceiling-drain does is already inside tick() (conductor.ts): a breach
// freezes dispatch, drains running workers, and — past the bounded drain window — escalates to
// a hard kill. This driver's only job is to keep calling tick() so that drain/escalation
// progresses tick over tick, and to know when to STOP calling it.
//
// Shutdown is clean by construction, not by interrupting anything: a signal only sets a flag
// that's checked between ticks (right after `tick()` resolves, and again after the inter-tick
// sleep) — an in-flight tick is a single already-started async call this driver never touches
// mid-flight, so "stop after the in-flight tick completes" falls out of the loop shape rather
// than needing its own cancellation machinery.
import { tick, type TickDeps, type TickResult } from "./conductor.js";

/** How the loop decides to stop ticking. Default ("forever") is the normal daemon mode — only a
 *  signal stops it. "once": run exactly one tick then stop (scripting / cron / a manual poke).
 *  "until-idle": keep ticking until a tick leaves nothing in flight (see isIdle) — a natural
 *  "drain the queue to empty" mode for a bounded batch run — or a signal arrives, whichever
 *  first. */
export type StopMode = "forever" | "once" | "until-idle";

/** #76 goal-based stop conditions — resolved values (config defaults already overridden by any
 *  CLI --stop-* flag, cli.ts's job), all optional. Absent field = that condition never fires;
 *  an entirely-absent/undefined `stop` on DriverDeps = today's behavior exactly (this is the
 *  SAME shape as config.ts's Stop section — driver.ts intentionally doesn't import SapwoodConfig
 *  here so it stays testable with a bare object, same style as the rest of DriverDeps). */
export interface StopConfig {
  afterIssuesMerged?: number;
  afterPRsOpened?: number;
  onMilestoneComplete?: string;
  /** #154: the per-run spend budget — see config.ts's Stop.afterSpendUsd for the full
   *  rationale (distinct from roundBudgetUsd/dailyBudgetUsd). Compared against a RUN-scoped
   *  ledger sum (State.spentUsdAfterId from an anchor captured once at engine startup,
   *  State.maxSpendLedgerId) — never engineSessionStart's wall-clock accounting window, which
   *  deliberately resets on a quiet gap; a run's spend total must never reset mid-run. */
  afterSpendUsd?: number;
}

export type StopConditionName =
  | "afterIssuesMerged"
  | "afterPRsOpened"
  | "onMilestoneComplete"
  | "afterSpendUsd";

/** Which configured stop condition fired first (OR semantics: first hit wins, never
 *  overwritten once wind-down starts). `threshold` echoes the configured value (the N, or the
 *  milestone name) and `detail` is a short human-readable count/state for the exit log line —
 *  see cli.ts's formatStopConditionLine. */
export interface StopConditionHit {
  name: StopConditionName;
  threshold: number | string;
  detail: string;
}

export interface DriverDeps extends TickDeps {
  /** The driver's tick cadence in seconds. Unlike TickDeps.tickIntervalSec (optional there,
   *  for callers with no fixed schedule), the driver itself IS the cadence source — required. */
  tickIntervalSec: number;
  stopMode?: StopMode; // default "forever"
  /** #76: optional goal-based stop conditions, OR'd with each other (first hit wins) and layered
   *  on top of whatever stopMode is running — see runDriver's wind-down logic below. Omitted
   *  (or every field omitted) -> no behavior change from pre-#76 sapwood. */
  stop?: StopConfig;
  /** Injected sleep so tests can drive the loop without real wall-clock waits. Default: a
   *  cancelable setTimeout wait. Either way the inter-tick wait is SIGNAL-ABORTABLE — a stop
   *  signal resolves it immediately rather than waiting out the cadence (see interTickWait in
   *  runDriver); an injected sleep is raced, not awaited to completion, on shutdown. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per completed tick with its result (logging/telemetry hook). Never throws back
   *  into the loop — a throwing onTick would be a caller bug, not handled here. */
  onTick?: (result: TickResult) => void;
  /** Registers the stop signal source; returns a teardown function. Default: real
   *  SIGINT/SIGTERM listeners on `process`. Injectable so tests can trigger a "signal" without
   *  touching the actual process signal handlers (and so multiple driver instances in one test
   *  process don't fight over them). */
  registerSignals?: (requestStop: () => void) => () => void;
}

export type StopReason = "signal" | "once" | "idle" | "stop-condition";

export interface DriverResult {
  /** Completed (successful) ticks. */
  ticks: number;
  /** Contained failures: tick() attempts that threw, plus failed #76 milestone stop-condition
   *  reads (see runDriver's two catches — mutually exclusive per tick). Always 0 on a healthy
   *  run; a persistently non-zero, growing count is the operator's signal that the forge is
   *  unreachable while the daemon keeps (correctly) retrying. */
  tickErrors: number;
  stoppedBy: StopReason;
  /** Present when a configured condition fired: always with stoppedBy === "stop-condition", and
   *  also with "once" when the single tick happened to satisfy a goal (once-mode never waits for
   *  wind-down, but the exit line still names the hit). Never present without `stop` config —
   *  that keeps the DriverResult shape byte-for-byte identical to pre-#76 sapwood (regression
   *  tests rely on this via assert.deepEqual against a plain {ticks,tickErrors,stoppedBy}). */
  stopCondition?: StopConditionHit;
}

/** #76: how many of this tick's DrivenOutcome entries are a completed merge — the
 *  `afterIssuesMerged` counting source (DrivenOutcome "merged", conductor.ts's DRIVE phase).
 *  Exported (#86): round.ts reuses this same counting logic for its own FINAL (whole-run)
 *  stop-condition bookkeeping, so the two loops never drift on what "merged" means. */
export function issuesMergedThisTick(result: TickResult): number {
  return result.driven.filter((d) => d.kind === "merged").length;
}

/** #76: how many of this tick's ReclaimOutcome entries are a lane's FIRST transition into
 *  `driving` — the `afterPRsOpened` counting source. A PR is opened by the worker asynchronously
 *  (tick() never calls forge.openPR itself), so the tick can't see the open happen; what it CAN
 *  see, exactly once per lane, is the reclaim that first discovers the PR and moves the lane to
 *  `driving` (conductor.ts's laneOnReclaimDone/laneOnReclaimFailed -> "DRIVING", or a DEAD lane
 *  rescued because it already has a PR). That transition happens once and only once per lane
 *  (a lane already `driving` never re-enters this loop), so summing it across this run's ticks
 *  is an exact, no-new-table count of "PRs this run has caused the engine to start tracking" —
 *  the simplest accurate proxy for "PRs opened this run" available from TickResult alone.
 *  Exported (#86): round.ts reuses this for its own FINAL stop-condition bookkeeping — see
 *  issuesMergedThisTick's export comment above. */
export function prsOpenedThisTick(result: TickResult): number {
  let n = 0;
  for (const r of result.reclaimed) {
    if (r.kind === "done" && r.next === "DRIVING") n++;
    else if (r.kind === "failed" && r.next === "DRIVING") n++;
    else if (r.kind === "dead" && r.rescued) n++;
  }
  return n;
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

/** "Nothing left to do" for --until-idle: no running/driving lane occupies a slot AND this
 *  tick's dispatch phase launched nothing new (an empty or fully-blocked Ready queue). Either
 *  condition failing means there's more work the next tick could still make progress on.
 *  #76: also the exit gate for the stop-condition wind-down — once forceDispatchPause is set,
 *  `dispatchedAny` is trivially false (the DISPATCH phase never runs), so this reduces to "no
 *  in-flight lanes left", i.e. every lane has finished rather than been killed. */
function isIdle(deps: DriverDeps, result: TickResult): boolean {
  const activeLanes = deps.state.activeWorkers().length; // running + driving
  const dispatchedAny = result.dispatched.some((d) => d.kind === "dispatched");
  return activeLanes === 0 && !dispatchedAny;
}

/**
 * Run the tick loop until a stop condition fires. Always attempts at least one tick. Never
 * rejects on a signal — a signal is a normal, expected stop, not an error.
 *
 * tick() throws are CONTAINED, never fatal (gate② PR #50 P2 #1): tick() rejects on more than
 * one path — the DRIVE (ensureTriggered/addPRComment/setBoardStatus/addLabel), the
 * CEILING-escalation (addLabel), and the DISPATCH (getReadyIssues/claimIssue) phases all
 * contain unguarded forge awaits (only RECLAIM was hardened, by #31's pending_rollbacks) — so
 * a transient GitHub 5xx/network blip mid-tick would otherwise crash the daemon and, worst
 * case, halt an in-progress kill-switch/ceiling DRAIN until a human restarts. The state layer
 * is durable (SQLite; #31's rollback markers persist before their board mutations), so a
 * failed tick loses nothing a later tick can't resume: log a structured `tick-error` event,
 * sleep the NORMAL cadence (never a hot retry loop), and keep ticking. A persistent failure
 * shows up as a growing DriverResult.tickErrors count + event-log trail, not a dead daemon.
 */
export async function runDriver(deps: DriverDeps): Promise<DriverResult> {
  const stopMode = deps.stopMode ?? "forever";
  let signalled = false;
  // Wakes an in-progress inter-tick wait (see interTickWait below). Signal-abortable sleep
  // (Codex PR #50, driver.ts:126 thread): without this, a SIGINT/SIGTERM landing between
  // ticks would only flip `signalled` and then wait out the FULL cadence before the loop
  // notices — up to tickIntervalSec of shutdown delay, enough to blow past a service
  // manager's stop timeout and get SIGKILLed instead of stopping cleanly after the
  // completed tick. The signal handler resolves the wait immediately instead.
  let wakeFromSleep: (() => void) | null = null;
  const unregister = (deps.registerSignals ?? defaultRegisterSignals)(() => {
    signalled = true;
    wakeFromSleep?.();
  });
  /** The inter-tick wait: resolves after `ms` OR immediately on a stop signal, whichever is
   *  first. With the default timer the signal path also clears the timeout (no stray timer
   *  holding the event loop); with an injected test sleep the signal races it (the injected
   *  promise may still settle later — its resolution is then a no-op). */
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
      // A signal that arrived after the pre-sleep check but before this wait was armed must
      // not sleep at all — it already missed its wake call.
      if (signalled) wakeFromSleep?.();
    });
  // #76: cumulative run-lifetime counters (process lifetime — a restarted engine starts these
  // back at 0) feeding the count-based stop conditions. Updated only from a SUCCESSFUL tick's
  // result (a thrown tick produced no TickResult to count from).
  let issuesMerged = 0;
  let prsOpened = 0;
  // #154: this run's spend-ledger anchor — captured ONCE, here, at engine startup (an in-memory
  // constant for the process lifetime, deliberately: a restart calls runDriver fresh and gets a
  // fresh anchor, so afterSpendUsd starts back at $0 — the acceptance criterion, not a bug).
  // spentUsdAfterId sums spend_ledger rows with id > this cursor, i.e. exactly this run's own
  // ledgered spend — never engineSessionStart's wall-clock window, which resets on a quiet gap.
  const runSpendAnchorId = deps.state.maxSpendLedgerId();
  // Set once, the first time any configured stop condition is satisfied (OR semantics — first
  // hit wins, never overwritten by a later condition). From that tick onward every subsequent
  // tick() call is forced dispatch-paused (see the merged tickDeps below): no new lane is
  // dispatched, but reclaim/rollback/DRIVE keep running exactly as normal so in-flight lanes are
  // never killed, only allowed to finish — the same wind-down machinery --until-idle already
  // uses (isIdle below), just entered by a goal firing instead of the Ready queue draining.
  let stopConditionHit: StopConditionHit | undefined;
  try {
    let ticks = 0;
    let tickErrors = 0;
    for (;;) {
      let result: TickResult | null = null;
      // #124 tick-driver divergence: this driver never sets TickDeps.dispatchCapOverride, so
      // cfg.lanes.roundDispatchCap keeps its ORIGINAL meaning here — a flat PER-TICK rate limit,
      // re-armed fresh every call, no cross-tick quota memory. The rounds driver (round.ts)
      // reinterprets the same config key as a per-ROUND quota by passing dispatchCapOverride
      // itself; this driver is intentionally untouched by that reinterpretation.
      const tickDeps: TickDeps = stopConditionHit
        ? { ...deps, forceDispatchPause: true }
        : deps;
      try {
        result = await tick(tickDeps);
        ticks++;
        deps.onTick?.(result);
      } catch (e) {
        tickErrors++;
        // Structured + durable — never a silent swallow. Guarded itself: if even the event
        // write fails (e.g. the disk is gone) there is nothing left to record to, and the
        // in-memory tickErrors count / returned result still carry the signal.
        try {
          deps.state.appendEvent("tick-error", { error: String(e) });
        } catch { /* state write failed too — tickErrors still counts it */ }
      }
      if (result && !stopConditionHit) {
        issuesMerged += issuesMergedThisTick(result);
        prsOpened += prsOpenedThisTick(result);
        const stop = deps.stop;
        if (stop?.afterIssuesMerged !== undefined && issuesMerged >= stop.afterIssuesMerged) {
          stopConditionHit = {
            name: "afterIssuesMerged", threshold: stop.afterIssuesMerged, detail: `merged ${issuesMerged}`,
          };
        } else if (stop?.afterPRsOpened !== undefined && prsOpened >= stop.afterPRsOpened) {
          stopConditionHit = {
            name: "afterPRsOpened", threshold: stop.afterPRsOpened, detail: `opened ${prsOpened}`,
          };
        } else if (stop?.afterSpendUsd !== undefined) {
          // #154: a live query, not an accumulated counter — spend is only known at worker
          // completion (recordSpend), and State is the durable source of truth for it already
          // (same "read live durable state" style as round.ts's spentSoFar/dailySpendUsd).
          const runSpendUsd = deps.state.spentUsdAfterId(runSpendAnchorId);
          if (runSpendUsd >= stop.afterSpendUsd) {
            stopConditionHit = {
              name: "afterSpendUsd", threshold: stop.afterSpendUsd, detail: `spent $${runSpendUsd.toFixed(2)}`,
            };
          }
        } else if (stop?.onMilestoneComplete && !signalled) {
          // Evaluated at tick boundaries only (never mid-tick), per #76's scope — one extra
          // forge read per tick while configured, same cost class as the DISPATCH phase's own
          // getReadyIssues call. Skipped once `signalled` — a Ctrl-C shutdown must not wait on
          // one more network round-trip.
          //
          // CONTAINED like tick() itself (fable gate② P1): this await sits outside the tick
          // try/catch, so an uncaught gh failure here (transient 5xx, rate limit, expired auth)
          // would escape runDriver's loop and kill the daemon — including mid kill-switch drain,
          // exactly the operator's worst moment. A failed read is a tick-error + "milestone not
          // complete" (fail toward MORE ticks, the same stance the containment docblock above
          // commits to), never a crash and never a fired condition.
          try {
            const openLeft = await deps.forge.countOpenIssuesInMilestone(stop.onMilestoneComplete);
            if (openLeft === 0) {
              stopConditionHit = {
                name: "onMilestoneComplete", threshold: stop.onMilestoneComplete, detail: "0 open issues left",
              };
            }
          } catch (e) {
            tickErrors++;
            try {
              deps.state.appendEvent("tick-error", { error: `stop-condition milestone check failed: ${String(e)}` });
            } catch { /* state write failed too — tickErrors still counts it */ }
          }
        }
      }
      if (signalled) return { ticks, tickErrors, stoppedBy: "signal" };
      // #76: --once still reports a condition that fired on its single tick (the exit line names
      // it) — stoppedBy stays "once" because once-mode never waits for wind-down.
      if (stopMode === "once") {
        return stopConditionHit
          ? { ticks, tickErrors, stoppedBy: "once", stopCondition: stopConditionHit }
          : { ticks, tickErrors, stoppedBy: "once" };
      }
      // A stop condition fired (this tick or an earlier one) and in-flight lanes have now
      // drained -> clean exit, naming the condition. Checked BEFORE the --until-idle idle exit
      // below so a configured stop condition that happens to coincide with natural idleness is
      // still reported by name (more informative than a bare "idle"). A failed tick (result ===
      // null) can't be judged idle — keep looping, same fail-toward-more-ticks stance as
      // --until-idle already takes.
      if (stopConditionHit && result && isIdle(deps, result)) {
        return { ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: stopConditionHit };
      }
      // A failed tick produced no result — idleness is unknowable this round; keep looping
      // (fail toward "more ticks", the direction drain/escalation progress needs).
      if (stopMode === "until-idle" && result && isIdle(deps, result)) {
        return { ticks, tickErrors, stoppedBy: "idle" };
      }
      await interTickWait(deps.tickIntervalSec * 1000);
      if (signalled) return { ticks, tickErrors, stoppedBy: "signal" };
    }
  } finally {
    unregister();
  }
}
