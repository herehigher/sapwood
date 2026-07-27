// watchdog.ts (#395 round 2 — gate② P1): a PROGRESS-based liveness watchdog, not a
// tick-completion race.
//
// The original design armed a timer against each tick() call and treated "this one tick took
// too long" as a stall. That is structurally unsound: `reviewer.mode: engine-agent` (the
// dogfooded production reviewer) awaits a full LLM review session INLINE inside tick()
// (conductor.ts -> merge-driver.ts -> review/drive.ts -> review/engine-agent.ts ->
// peripheral.ts's RoleRunner.run() -> `await exitPromise`), bounded only by worker.timeoutSec
// (default 3600s) with up to two attempts serial per gated lane. A perfectly healthy 10-20
// minute review well inside its cost budget would trip a tickIntervalSec x
// watchdogTickMultiplier (600s default) window and self-kill the engine MID-REVIEW — a
// deterministic self-kill loop on exactly the PRs that most need reviewing, strictly worse than
// the wedge this issue set out to fix. Enlarging the window doesn't fix this: the true ceiling
// is lanes x attempts x worker.timeoutSec, so any window safe against a busy tick is far too
// coarse to detect a real stall, and any window tight enough to be useful self-kills.
//
// So the watchdog no longer measures tick DURATION at all. Instead: the engine is stalled when
// no DURABLE EVENT has been appended for a full window, regardless of which phase is running or
// how long that phase legitimately takes — the live incident's own signature (an operator
// diagnosed it as "zero events for 30+ minutes", not "a tick that ran long"). Armed ONCE per
// engine run (at the top of driver.ts's runDriver / round.ts's runRounds, stopped in their own
// `finally`) as an INDEPENDENT recurring real timer — never raced against any specific await —
// so it covers every phase (aligning/architecting/plan_review/executing/harvesting/retro), not
// just tick()'s own dispatch/reclaim/drive. peripheral.ts's own unbounded `await exitPromise`
// (RoleRunner.run) needs no SEPARATE bound as a result — this watchdog already covers it.
//
// This only works if something appends an event at least once per window during every
// legitimately long, otherwise-quiet stretch. Verified (see each site's own comment for the
// evidence) that four such stretches previously emitted NOTHING and needed a heartbeat added
// for this round: peripheral.ts's RoleRunner.run() heartbeat interval (the review-session path
// above, and every other role session), worker.ts's WorkerSupervisor heartbeatTick (the same
// class of gap for an ordinary, non-review worker leg), and round.ts's standby backoff wait AND
// park-recovery wait (both can legitimately run quiet for far longer than any reasonable
// window — up to round.standby.backoffCapSec / envFailure.probeBackoffMaxSec / parkEscalateAfterSec).
import type { State } from "../state/state.js";

export interface ProgressWatchdogOpts {
  /** engine.tickIntervalSec * 1000 * liveness.watchdogTickMultiplier — the caller's own cadence
   *  and multiplier, computed once. */
  windowMs: number;
  state: Pick<State, "appendEvent" | "maxEventId">;
  /** `process.exit` in production; tests inject a fake so a deliberately-quiet State doesn't
   *  kill the test runner. */
  exit: (code: number) => void;
  eventPayload: Record<string, unknown>;
}

export interface ProgressWatchdogHandle {
  /** Stop the recurring timer. Called from the loop's own `finally` — the SAME shutdown path
   *  `unregister()` already uses — so a clean stop (signal, --once, a stop condition) never
   *  leaves a stray timer running past the process's own natural lifetime. */
  stop: () => void;
}

/** Start the progress watchdog: re-checks `state.maxEventId()` every `windowMs` against its own
 *  previous reading. Unchanged across one full window -> stalled: append the durable
 *  `engine-stalled` event (best-effort — a failed write still lets the nonzero exit be the
 *  operative signal), then call `exit(1)`. Deliberately does NOT reschedule after firing — the
 *  watchdog fires once and stops itself, whether or not the exit hook actually terminated the
 *  process (production: it always does; tests inject a non-terminating fake). Never reads the
 *  real clock (no `Date.now()`/`new Date()` anywhere here) — purely timer-driven, so a test
 *  drives the stalled branch with a real-but-tiny `windowMs` against a State nothing else ever
 *  touches, which is deterministic since the "progress" side never happens at all. */
export function startProgressWatchdog(opts: ProgressWatchdogOpts): ProgressWatchdogHandle {
  let lastSeenId = opts.state.maxEventId();
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    const currentId = opts.state.maxEventId();
    if (currentId === lastSeenId) {
      try {
        opts.state.appendEvent("engine-stalled", opts.eventPayload);
      } catch {
        /* best-effort — the nonzero exit is still the operative signal */
      }
      opts.exit(1);
      return;
    }
    lastSeenId = currentId;
    timer = setTimeout(check, opts.windowMs);
  };
  timer = setTimeout(check, opts.windowMs);
  return { stop: () => clearTimeout(timer) };
}
