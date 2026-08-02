// stop-signal.ts (#380, F5): SIGTERM/SIGINT -> the KILL_SWITCH drain path.
//
// Before this, a signal only told a driver to stop calling tick() at the next tick boundary:
// dispatch kept happening right up to that boundary and running workers were simply abandoned
// mid-work (dogfood 2026-07-24: "SIGTERM had no observable effect — the engine kept ticking
// until force-killed"). Sentinels (data/KILL_SWITCH, data/PAUSE) were the only channel that
// actually froze dispatch and drained, but operators and service managers (systemd, launchd,
// CI runners) speak signals first.
//
// The fix deliberately adds NO second stop mechanism: a requested stop is threaded into tick()
// as TickDeps.stopRequested, which ORs into the very same top-of-tick gate `data/KILL_SWITCH`
// already drives (conductor.ts) — dispatch frozen, running/fixing lanes asked to hand off
// gracefully, the bounded drain window then escalating to a hard kill, all of it the same code
// so the two stop semantics cannot fork. The only fork is the RECORDED REASON ("stop-signal"
// vs "kill-switch"), so a human reading a `ceiling-escalated` event or `sapwood status` after a
// drain isn't sent hunting for a sentinel file that was never written.
//
// SECOND signal = immediate hard exit (128+SIGINT convention): the drain is bounded by
// cfg.cost.drainWindowSec, and an operator who has already asked once and wants out NOW must
// not have to reach for SIGKILL. That is why the default registration uses `process.on`, not
// `process.once`: a `once` listener un-registers itself after the first signal and leaves the
// second one to Node's default disposition — which happens to terminate too, but only by
// accident of listener bookkeeping, untestable and silently broken by any future second
// listener on the same signal.

/** Registers the stop-signal source; returns a teardown function. The drivers' injectable seam
 *  (DriverDeps/RoundDeps.registerSignals) so tests can request a stop without touching real
 *  process signal handlers — and so several driver instances in one test process don't fight
 *  over them. */
export type RegisterSignals = (requestStop: () => void) => () => void;

/** The real thing: SIGINT + SIGTERM, both wired to the same handler, `on` (not `once`) so the
 *  SECOND signal reaches installStopSignal's hard-exit branch rather than Node's default. */
export function defaultRegisterSignals(requestStop: () => void): () => void {
  const handler = (): void => requestStop();
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

export interface StopSignalOpts {
  registerSignals?: RegisterSignals;
  /** Fired on the FIRST signal only, after the flag is set — the drivers use it to wake an
   *  in-progress inter-tick sleep so the drain starts on the next beat instead of waiting out
   *  the cadence. */
  onStop?: () => void;
  /** The SECOND signal's exit. Default `process.exit`, which never returns; tests inject a spy
   *  (same seam style as DriverDeps.watchdogExit). */
  hardExit?: (code: number) => void;
  log?: (message: string) => void;
}

export interface StopSignal {
  /** THUNK, never a snapshot — tick() reads it at its own top-of-tick gate, so a signal landing
   *  mid-tick is seen by the very next gate rather than a stale captured boolean. */
  requested: () => boolean;
  dispose: () => void;
}

/** 128 + SIGINT(2). Both signals share it: the registerSignals seam carries no signal identity,
 *  and the code's only job here is to say "died by signal, not a clean stop". */
export const HARD_EXIT_CODE = 130;

/** Install the two-stage stop: first signal requests the drain, second hard-exits. */
export function installStopSignal(opts: StopSignalOpts = {}): StopSignal {
  let requested = false;
  const dispose = (opts.registerSignals ?? defaultRegisterSignals)(() => {
    if (requested) {
      opts.log?.("[sapwood:stop] second stop signal — hard exit now, in-flight lanes are NOT drained");
      (opts.hardExit ?? ((code: number) => process.exit(code)))(HARD_EXIT_CODE);
      return;
    }
    requested = true;
    opts.log?.(
      "[sapwood:stop] stop signal — freezing dispatch and draining in-flight lanes (the KILL_SWITCH drain path); " +
        "signal again to hard-exit without draining",
    );
    opts.onStop?.();
  });
  return { requested: () => requested, dispose };
}
