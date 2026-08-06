// #691 gate② hardening (a072bb1 review + follow-up audit): the shared hang-guard test-support
// module for every suite that drives `runDriver`/`runRounds`'s production `for (;;)` loops
// (driver.ts:287, round.ts:1161/1692/1726) against a fake, test-injected `sleep`. Used by
// driver.test.ts, round.test.ts, round-defaults.test.ts, harvest.test.ts, and retro.test.ts — ONE
// copy, not five, so the next fix (or the next incident) lands once.
//
// Why TWO guards, not one: they catch DIFFERENT failure shapes and neither alone is sufficient.
//
// 1. `withHangGuard` (materializer.test.ts's shape, reused not reinvented) -- a `setTimeout` race.
//    Correct for a GENUINE hang: an awaited promise that never settles at all, or a retry loop
//    paced by real wall-clock delays. INSUFFICIENT for a busy-spin, and proven so empirically:
//    a `for(;;)` loop whose only `await` is a zero-delay fake `sleep` (`mkSleepSpy`'s `async (ms)
//    => {}` with no real await inside) resolves purely via the MICROTASK queue. V8/Node only
//    drains macrotasks (where `setTimeout` lives) BETWEEN turns of the microtask queue -- a loop
//    that keeps re-enqueueing microtasks forever never yields a turn, so the timer backing
//    `withHangGuard` is starved and NEVER fires (measured: ~38.7M such iterations in 1500ms with a
//    50ms timer racing them, timer never fired). This is exactly the 2026-08-05 incident's shape
//    (a caught-and-retried tick error racing a zero-delay fake sleep) -- commit 06b7aa8 patched
//    the ONE missing FakeForge stub that triggered it, never the class.
// 2. `attachAttemptGuard` -- the ACTUAL fix for the busy-spin class: a plain in-process COUNTER,
//    immune to microtask starvation because incrementing an integer costs no macrotask at all.
//    Wraps `onTick` (and `onRoundPhase`, for the rounds driver) to count successful steps, and
//    `sleep` (called once per loop iteration REGARDLESS of whether that iteration's tick
//    succeeded or threw -- driver.ts:429, round.ts:1268/1824/2158 -- so it is a strict superset of
//    counting `onTick` alone) to count EVERY attempt. Past a generous ceiling (10,000 -- orders of
//    magnitude above any real test's tick count) the wrapped `sleep` throws SYNCHRONOUSLY.
//
//    Deliberately NOT `async`: a synchronous throw happens INSIDE `interTickWait`'s
//    `new Promise((resolve) => { ...; void deps.sleep(ms).then(finish); })` executor (both
//    driver.ts and round.ts share this shape) -- calling a throwing function is itself
//    synchronous, and a throw inside a Promise executor is caught by the Promise constructor and
//    turned into a rejection, standard JS semantics (verified empirically: a 3-line repro proves
//    the rejection propagates cleanly through the awaited `interTickWait(...)` call, which sits
//    OUTSIDE the tick try/catch in both drivers -- so it escapes `runDriver`/`runRounds` as a
//    rejected promise, by name, deterministically).
//
//    Earlier revision of this guard also called the loop's own `requestStop()` from inside the
//    counter, before the synchronous throw was added. Deleted after Codex gate② proved it both
//    harmful and unnecessary: (a) if the test had already requested a drain, this was a SECOND
//    signal, which `installStopSignal` treats as the immediate hard-exit path
//    (`process.exit(130)`) -- firing before the named error ever surfaced; (b) `onStop` resolves
//    `interTickWait`'s promise SYNCHRONOUSLY on the first request, which means the throw in the
//    SAME `sleep` call that crossed the ceiling would be ignored (the promise having already
//    settled) and only the NEXT sleep call would actually reject -- silently falsifying the
//    "fires deterministically at the threshold" claim. A pure synchronous throw has none of these
//    interactions: it doesn't touch stop-signal state machinery at all, so a fixture whose lanes
//    never drain (which would leave `signalled() && liveLanesDrained()` permanently false, and so
//    would never have honored `requestStop()` anyway) is bounded exactly the same as any other.
//
// Only wraps `sleep` when the test supplied one: with no fake sleep, `interTickWait` falls back
// to a REAL `setTimeout` -- genuine wall-clock pacing, not microtask-only, so guard 1 above
// already covers it and there is nothing to starve.
import type { DriverDeps } from "./driver.js";
import type { RoundDeps } from "./round.js";

export function withHangGuard<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const DEFAULT_ATTEMPT_CEILING = 10_000;

/** Mutates `deps` in place (wrapping `onTick`/`onRoundPhase`/`sleep`, composing with whatever was
 *  already there rather than replacing it) and returns a reader for whether the ceiling fired.
 *  Call this BEFORE invoking `runDriver`/`runRounds`, then check the reader once the call settles
 *  (by throw or by return) and throw its message if non-null. */
export function attachAttemptGuard(deps: DriverDeps | RoundDeps, ceiling: number = DEFAULT_ATTEMPT_CEILING): () => string | null {
  let attempts = 0;
  let firedMessage: string | null = null;
  const trip = (): void => {
    attempts++;
    if (attempts >= ceiling && firedMessage === null) {
      firedMessage = `bounded-attempt guard fired: ${attempts} tick/sleep attempts without settling — a likely busy-spin livelock racing a zero-delay fake sleep, immune to a timer-based hang guard (#691)`;
    }
  };
  const prevOnTick = deps.onTick;
  deps.onTick = (r) => {
    prevOnTick?.(r);
    trip();
  };
  if ("onRoundPhase" in deps) {
    const prevOnRoundPhase = deps.onRoundPhase;
    deps.onRoundPhase = (roundId, phase) => {
      prevOnRoundPhase?.(roundId, phase);
      trip();
    };
  }
  const prevSleep = deps.sleep;
  if (prevSleep) {
    deps.sleep = (ms) => {
      trip();
      if (firedMessage !== null) throw new Error(firedMessage);
      return prevSleep(ms);
    };
  }
  return () => firedMessage;
}
