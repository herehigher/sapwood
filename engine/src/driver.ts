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

export interface DriverDeps extends TickDeps {
  /** The driver's tick cadence in seconds. Unlike TickDeps.tickIntervalSec (optional there,
   *  for callers with no fixed schedule), the driver itself IS the cadence source — required. */
  tickIntervalSec: number;
  stopMode?: StopMode; // default "forever"
  /** Injected sleep so tests can drive the loop without real wall-clock waits. Default: a real
   *  setTimeout-based sleep. */
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

export type StopReason = "signal" | "once" | "idle";

export interface DriverResult {
  /** Completed (successful) ticks. */
  ticks: number;
  /** tick() attempts that threw and were contained (see runDriver's catch). Always 0 on a
   *  healthy run; a persistently non-zero, growing count is the operator's signal that the
   *  forge is unreachable while the daemon keeps (correctly) retrying. */
  tickErrors: number;
  stoppedBy: StopReason;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *  condition failing means there's more work the next tick could still make progress on. */
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
  const sleep = deps.sleep ?? defaultSleep;
  const stopMode = deps.stopMode ?? "forever";
  let signalled = false;
  const unregister = (deps.registerSignals ?? defaultRegisterSignals)(() => {
    signalled = true;
  });
  try {
    let ticks = 0;
    let tickErrors = 0;
    for (;;) {
      let result: TickResult | null = null;
      try {
        result = await tick(deps);
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
      if (signalled) return { ticks, tickErrors, stoppedBy: "signal" };
      if (stopMode === "once") return { ticks, tickErrors, stoppedBy: "once" };
      // A failed tick produced no result — idleness is unknowable this round; keep looping
      // (fail toward "more ticks", the direction drain/escalation progress needs).
      if (stopMode === "until-idle" && result && isIdle(deps, result)) {
        return { ticks, tickErrors, stoppedBy: "idle" };
      }
      await sleep(deps.tickIntervalSec * 1000);
      if (signalled) return { ticks, tickErrors, stoppedBy: "signal" };
    }
  } finally {
    unregister();
  }
}
