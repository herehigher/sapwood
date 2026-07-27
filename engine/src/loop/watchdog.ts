// watchdog.ts (#395): the liveness watchdog shared by BOTH loop drivers (driver.ts's "tick"
// driver and round.ts's "rounds" driver, cfg.engine.driver's two values) — one implementation,
// not two forks. A generous multiple of the caller's own tick cadence past which a single
// tick() attempt hasn't completed is treated as wedged (a stuck external await — a dead `gh`
// socket, a lost role-session spawn notification — the live incident's shape: the host slept
// ~49h mid-round with such an await in flight, and nothing noticed ticks had stopped).
//
// On a stall: append a durable `engine-stalled` event (the same `state.appendEvent` mechanism
// every other engine event uses — `appendEvent` is synchronous, so this is guaranteed to land
// before the exit call below), invoke the caller's exit hook (`process.exit(1)` in production,
// which never returns), and THEN throw `EngineStalledError` so a caller whose exit hook does
// NOT actually terminate the process (tests, via an injected fake) still unwinds the call stack
// cleanly instead of continuing as though the attempt succeeded. Deliberately not an in-process
// self-heal/abort (PM ruling, issue #395): a stuck await's own resources are reclaimed by the
// process exit itself, never by cancelling it in place.
import type { State } from "../state/state.js";

/** Thrown by raceTickWithWatchdog on a stall, after the durable event + exit hook have already
 *  run — a signal to unwind, not an ordinary tick failure. Callers that distinguish "genuine
 *  tick() throw" (contained, a tick-error) from "watchdog stall" (already recorded/handled,
 *  propagate) check `instanceof EngineStalledError`. */
export class EngineStalledError extends Error {
  constructor(public readonly context: Record<string, unknown>) {
    super("engine liveness watchdog fired — no tick completed within the configured window");
    this.name = "EngineStalledError";
  }
}

/** A cancelable "fires once after `ms`" real timer. Always a real `setTimeout` — never wired to
 *  a driver's own injected inter-tick `sleep` (that seam fakes PACING BETWEEN already-settled
 *  ticks, near-instant in most tests; racing it against a tick attempt itself would spuriously
 *  "stall" on every fast fake tick). Cancelled well within microseconds on any tick that
 *  actually settles — the healthy-path cost is one create+clear per tick, never a churning
 *  interval. Never reads the real clock (no `Date.now()`/`new Date()`) — a test that wants the
 *  stalled branch drives it with a real-but-tiny `ms` against an attempt that genuinely never
 *  resolves, which is deterministic since the other side of the race never settles at all. */
function armWatchdog(ms: number): { promise: Promise<"stalled">; cancel: () => void } {
  let t: ReturnType<typeof setTimeout>;
  const promise = new Promise<"stalled">((resolve) => {
    t = setTimeout(() => resolve("stalled"), ms);
  });
  return { promise, cancel: () => clearTimeout(t) };
}

export interface RaceTickWithWatchdogOpts {
  /** tickIntervalSec * 1000 * cfg.liveness.watchdogTickMultiplier — computed by the caller (both
   *  drivers already have their own cadence + cfg in scope). */
  watchdogMs: number;
  state: Pick<State, "appendEvent">;
  /** `process.exit` in production; tests inject a fake that records the call and returns instead
   *  of terminating (this function then throws EngineStalledError so the caller still unwinds). */
  exit: (code: number) => void;
  /** The `engine-stalled` event's payload — both drivers pass the same shape
   *  (`{ tickIntervalSec, watchdogTickMultiplier }`). */
  eventPayload: Record<string, unknown>;
}

/** Race `attempt()` against the watchdog. Resolves with `attempt()`'s own result on a normal
 *  completion (whether success or throw — a genuine `attempt()` rejection propagates UNCHANGED,
 *  never swallowed or reclassified). On a stall, throws `EngineStalledError` (see its own doc)
 *  after the durable event + exit hook have run. */
export async function raceTickWithWatchdog<T>(attempt: () => Promise<T>, opts: RaceTickWithWatchdogOpts): Promise<T> {
  const watchdog = armWatchdog(opts.watchdogMs);
  try {
    const raced = await Promise.race<{ kind: "tick"; result: T } | { kind: "stalled" }>([
      attempt().then((result): { kind: "tick"; result: T } => ({ kind: "tick", result })),
      watchdog.promise.then((): { kind: "stalled" } => ({ kind: "stalled" })),
    ]);
    if (raced.kind === "stalled") {
      try {
        opts.state.appendEvent("engine-stalled", opts.eventPayload);
      } catch {
        /* best-effort — the nonzero exit is still the operative signal a supervisor sees */
      }
      opts.exit(1);
      // Unreachable in production (process.exit never returns) — reached only when a test
      // injects a non-exiting exit hook, so the caller still unwinds instead of spinning on an
      // attempt that will never resolve.
      throw new EngineStalledError(opts.eventPayload);
    }
    return raced.result;
  } finally {
    watchdog.cancel();
  }
}
