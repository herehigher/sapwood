// heartbeat.ts (#395 gate② round 3, P1 + P2-2): a heartbeat that PROVES liveness, not just that
// its own timer fired.
//
// Round 2's heartbeats (peripheral.ts's RoleRunner, worker.ts's WorkerSupervisor) emitted
// UNCONDITIONALLY from their setInterval — nothing tied the append to whether the thing being
// awaited was still making progress. A post-spawn wedge at `await exitPromise` (this issue's own
// premise: a lost exit notification, the child already dead) kept the heartbeat firing every
// cadence regardless, advancing state.maxEventId() forever — masking the liveness watchdog until
// worker.timeoutSec (60x longer than the watchdog's own window by default) instead of letting it
// fire at the window.
//
// Two guards, shared here so both call sites apply them identically:
//  1. LIVENESS: only emit while the process this heartbeat represents is still alive
//     (`isAlive()` — process.kill(pid, 0) in a try/catch at the call site; `child.pid` is
//     populated synchronously by spawn(), independent of whether the async 'spawn'/'exit' event
//     ever arrived). A child that died with its exit notification lost — precisely this issue's
//     premise — stops producing heartbeats, so the watchdog fires at the window instead of the
//     hour. A legitimately slow session (no JSONL growth, no child output) keeps the child alive
//     and keeps heart-beating — this is NOT a progress-content check (deliberately: gating on
//     JSONL growth or child output would kill a quiet-but-working session, which is normal).
//  2. SPAM (#383, #395 P2-2): only emit when it would otherwise be the SOLE record of anything —
//     skip the append when state.maxEventId() has already advanced since the last heartbeat
//     check (something else already proved progress this cadence). A busy engine then emits
//     ~zero heartbeats; a genuinely quiet one emits at most one per cadence.
//
// round.ts's standby/park-recovery waits have no child to probe — they reuse this same gate with
// `isAlive: () => true` (guard 1 is a no-op there; only guard 2 applies). See each call site's
// own comment for what that specific heartbeat does and does not prove.
import type { State } from "../state/state.js";

export interface HeartbeatGate {
  /** Call once per interval/loop tick. Appends `kind`/`payload` only when BOTH guards pass. */
  tick: (kind: string, payload: Record<string, unknown>) => void;
}

export function createHeartbeatGate(state: Pick<State, "appendEvent" | "maxEventId">, isAlive: () => boolean): HeartbeatGate {
  let lastSeenId = state.maxEventId();
  return {
    tick(kind, payload) {
      const currentId = state.maxEventId();
      if (currentId !== lastSeenId) {
        // Something else already proved progress this cadence — this heartbeat has nothing to
        // add. Re-baseline so the NEXT check measures silence from here, not from the old id.
        lastSeenId = currentId;
        return;
      }
      if (!isAlive()) return; // the process this heartbeat represents is gone — no liveness to report
      try {
        state.appendEvent(kind, payload);
      } catch {
        /* best-effort */
      }
      // The append above just advanced maxEventId itself — re-read so the NEXT tick's baseline
      // reflects it (otherwise every subsequent tick would see "changed" against a stale id and
      // silently skip forever).
      lastSeenId = state.maxEventId();
    },
  };
}
