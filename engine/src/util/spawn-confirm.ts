// #395 (F24 liveness): bound the wait for a freshly spawned child's `spawn`/`error`
// confirmation. Node gives that confirmation no timeout of its own — a callback lost across a
// host sleep (the live incident: an aligning-phase role session's spawn notification never
// arrived, wedging the engine 30+ minutes with zero events) hangs the caller forever without
// one. Shared by the engine's two spawn call sites — worker.ts's WorkerSupervisor.dispatch and
// peripheral.ts's RoleRunner.run — so the bound behaves identically in both places.
export interface SpawnConfirmOutcome {
  /** True when the timeout fired before either terminal event arrived. */
  timedOut: boolean;
  /** Set when the terminal event was a genuine spawn `error` (never set on a timeout). */
  err: unknown;
}

/** `register` wires this helper's two terminal callbacks to whatever event source the caller
 *  has (a raw `ChildProcess`'s `once("spawn"/"error")`, or peripheral.ts's `SpawnedSession`
 *  `onSpawn`/`onError`) — this module knows nothing about either. `sleep`, when supplied
 *  (tests), replaces the real timer so a test can deterministically win the race without
 *  depending on real OS process-spawn timing — the same injectable-timer seam driver.ts's own
 *  liveness watchdog uses (an optional `(ms) => Promise<void>`, default a real, cancelable
 *  `setTimeout`). Never reads the real clock directly (no `Date.now()`/`new Date()`).
 *
 *  `register`'s third argument, `isSettled`, lets a caller whose own `onSpawn` performs a side
 *  effect (worker.ts's resume() writes a `spawn_confirmed:true` sentinel) guard that effect
 *  against a MERELY-DELAYED (not lost) real event racing the timeout (#395 gate② P2-2): the raw
 *  listener `register` attaches stays live even after this function's own returned promise has
 *  already settled on "timed out" — a late-arriving real `spawn` would otherwise still run the
 *  caller's side effect after the failure path already killed the child and cleaned up,
 *  resurrecting a stale marker. Callers with no side effect (dispatch(), the peripheral site)
 *  can ignore this third argument entirely — see their own call sites. */
export async function awaitSpawnConfirmation(
  register: (onSpawn: () => void, onError: (e: unknown) => void, isSettled: () => boolean) => void,
  timeoutMs: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<SpawnConfirmOutcome> {
  let err: unknown;
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let clearRealTimer: (() => void) | undefined;
    if (sleep) {
      void sleep(timeoutMs).then(() => {
        if (!settled) {
          timedOut = true;
          finish();
        }
      });
    } else {
      const t = setTimeout(() => {
        timedOut = true;
        finish();
      }, timeoutMs);
      clearRealTimer = () => clearTimeout(t);
    }
    register(
      () => {
        clearRealTimer?.();
        finish();
      },
      (e) => {
        clearRealTimer?.();
        err = e;
        finish();
      },
      () => settled,
    );
  });
  return { timedOut, err };
}
