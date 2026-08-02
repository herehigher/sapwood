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
// SECOND signal = immediate hard exit: the drain is bounded by cfg.cost.drainWindowSec, and an
// operator who has already asked once and wants out NOW must not have to reach for SIGKILL.
// That is why the default registration uses `process.on`, not `process.once`: a `once` listener
// un-registers itself after the first signal and leaves the second one to Node's default
// disposition — which happens to terminate too, but only by accident of listener bookkeeping,
// untestable and silently broken by any future second listener on the same signal.
//
// The exit code follows the POSIX 128+signum convention external tooling reads (143 for
// SIGTERM, 130 for SIGINT), so a systemd unit or CI wrapper can tell WHICH signal ended the run
// — hence the seam carries the signal's identity rather than collapsing both into one code.

import { constants } from "node:os";

/** Registers the stop-signal source; returns a teardown function. The drivers' injectable seam
 *  (DriverDeps/RoundDeps.registerSignals) so tests can request a stop without touching real
 *  process signal handlers — and so several driver instances in one test process don't fight
 *  over them. `requestStop` takes WHICH signal fired: it decides the second-signal exit code
 *  (see hardExitCodeFor). Optional, because a caller that has no signal to name — an injected
 *  test seam, or any future non-signal stop source — is still a legitimate stop request. */
export type RegisterSignals = (requestStop: (signal?: NodeJS.Signals) => void) => () => void;

/** The signals a stop request can arrive on, in one place: the real registration below and the
 *  exit-code mapping are the same list, so neither can gain a signal the other doesn't know. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** The real thing: SIGINT + SIGTERM, each naming itself, `on` (not `once`) so the SECOND signal
 *  reaches installStopSignal's hard-exit branch rather than Node's default. */
export function defaultRegisterSignals(requestStop: (signal?: NodeJS.Signals) => void): () => void {
  const handlers = STOP_SIGNALS.map((signal) => {
    const handler = (): void => requestStop(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
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

/** 128 + SIGINT(2) — the fallback for a stop request that names no signal (an injected test
 *  seam, or any future non-signal stop source). "Died by signal, not a clean stop" is the least
 *  it can say; a request that DOES name its signal gets the exact code instead. */
export const HARD_EXIT_CODE = 130;

/** The POSIX 128+signum exit code for the signal that triggered a hard exit — 143 for SIGTERM,
 *  130 for SIGINT — read off `os.constants.signals` rather than hardcoded numbers, so the code
 *  is the platform's own signum. Unnamed signal -> HARD_EXIT_CODE. */
export function hardExitCodeFor(signal?: NodeJS.Signals): number {
  const signum = signal ? constants.signals[signal] : undefined;
  return signum === undefined ? HARD_EXIT_CODE : 128 + signum;
}

/** Install the two-stage stop: first signal requests the drain, second hard-exits. */
export function installStopSignal(opts: StopSignalOpts = {}): StopSignal {
  let requested = false;
  const dispose = (opts.registerSignals ?? defaultRegisterSignals)((signal?: NodeJS.Signals) => {
    if (requested) {
      opts.log?.(`[sapwood:stop] second stop signal${signal ? ` (${signal})` : ""} — hard exit now, in-flight lanes are NOT drained`);
      (opts.hardExit ?? ((code: number) => process.exit(code)))(hardExitCodeFor(signal));
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
