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
//     skip the append when the caller-supplied `currentProgressId()` has already advanced since
//     the last heartbeat check (something else already proved progress this cadence). A busy
//     subject then emits ~zero heartbeats; a genuinely quiet one emits at most one per cadence.
//
//     #688: `currentProgressId` is caller-supplied, deliberately NOT this module reaching for
//     `state.maxEventId()` itself. The two per-lane/per-role-session call sites (worker.ts,
//     peripheral.ts) must scope it to the SUBJECT this heartbeat represents (state.
//     maxEventIdForWorker(name) / state.maxEventIdForRoleSession(name)) — liveness is PER-SUBJECT,
//     and one lane's progress says nothing about another's. Live batch-10 evidence (2026-08-06):
//     with two concurrent lanes sharing one global id, whichever lane ticks second in a race
//     always sees the OTHER lane's just-appended id and skips — forever, deterministically, not a
//     flaky race (see heartbeat.test.ts's "starvation" regression). round.ts's single process-wide
//     loop heartbeat is the one caller that correctly keeps `() => state.maxEventId()` unscoped —
//     there is only ONE subject (this run), so global and per-subject coincide.
//
// round.ts's standby/park-recovery waits have no child to probe — they reuse this same gate with
// `isAlive: () => true` (guard 1 is a no-op there; only guard 2 applies). See each call site's
// own comment for what that specific heartbeat does and does not prove.
//
// #395 item 1 (peripheral.ts's RoleRunner.run(), gate② round tail): `isAlive()`'s pid probe above
// already POSITIVELY detects a dead child — guard 1 just uses that to silence the heartbeat.
// createExitLossDetector below reuses the EXACT SAME probe for a second purpose: resolving a
// lost-exit-notification `await exitPromise` (this issue's own premise — the child died and
// Node's 'exit' event for it never arrived) instead of only silencing telemetry and leaving the
// engine to fall silent until the liveness watchdog kills the whole process over one lost signal.
import type { EventKind } from "../state/event-kinds/index.js";
import type { State } from "../state/state.js";

export interface HeartbeatGate {
  /** Call once per interval/loop tick. Appends `kind`/`payload` only when BOTH guards pass.
   *  #425: `kind` is the registry union, not `string` — this wrapper is the one generic append
   *  seam in the engine, so leaving it wide would have been a hole straight through
   *  `appendEvent`'s own narrowing. */
  tick: (kind: EventKind, payload: Record<string, unknown>) => void;
}

export function createHeartbeatGate(
  state: Pick<State, "appendEvent">,
  isAlive: () => boolean,
  // #688: the SUBJECT-scoped progress id (e.g. state.maxEventIdForWorker(name) /
  // state.maxEventIdForRoleSession(name)) — see this module's own header doc for why this must
  // never be a global id shared across concurrent subjects.
  currentProgressId: () => number,
): HeartbeatGate {
  let lastSeenId = currentProgressId();
  return {
    tick(kind, payload) {
      const currentId = currentProgressId();
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
      // The append above just advanced this subject's own progress id — re-read so the NEXT
      // tick's baseline reflects it (otherwise every subsequent tick would see "changed" against
      // a stale id and silently skip forever).
      lastSeenId = currentProgressId();
    },
  };
}

export interface ExitLossDetector {
  /** Call once per heartbeat tick while the real `exit` event hasn't arrived yet. Returns
   *  `true` the FIRST time `REQUIRED_CONSECUTIVE_DEAD_READINGS` consecutive dead readings have
   *  been seen — the caller should treat that as "the exit notification is lost," resolve its
   *  own await synthetically, and stop calling `tick()` (a detector that already declared loss
   *  has nothing further to track). Returns `false` otherwise, including every reading before
   *  the threshold and any reading that finds the process alive again (the counter resets — see
   *  the module doc above for why an alive reading, even after a dead one, is always trustworthy:
   *  `process.kill(pid, 0)` cannot false-negative a live process). */
  tick: () => boolean;
}

// #395 item 1: why TWO consecutive dead readings, not one. A single dead reading bounds nothing
// on its own — it could be a transient probe artifact (e.g. a signal delivered but the kernel
// hasn't finished the zombie-reap bookkeeping this exact tick). Requiring the SAME reading twice
// in a row, with no alive reading in between, is a cheap way to bound that without adding a
// second timer or a wall-clock grace period: at default heartbeatMs (30s) that is a worst-case
// ~30-60s detection latency for a genuinely lost notification — far below worker.timeoutSec (the
// ceiling this replaces) and utterly negligible next to the live incident's 30+ minutes of total
// silence. The pid-reuse direction is the SAFE one and needs no separate guard: `kill(pid, 0)`
// against a pid the kernel has since reassigned to an unrelated live process reads ALIVE (no
// ESRCH), which only resets the counter back to 0 — it can never manufacture a false "dead"
// reading, so two consecutive dead readings can only underclaim liveness, never overclaim it.
const REQUIRED_CONSECUTIVE_DEAD_READINGS = 2;

/** Create a detector for a lost child-exit notification: counts CONSECUTIVE `isAlive() === false`
 *  readings across calls to `tick()`, firing (returning `true`, once) after
 *  `REQUIRED_CONSECUTIVE_DEAD_READINGS` in a row with no alive reading between them. Pure and
 *  state-free beyond its own counter — no durable-event write, no exit-resolution side effect;
 *  the caller (peripheral.ts's RoleRunner.run()) owns both of those, keeping this detector
 *  trivially unit-testable against a scripted `isAlive` sequence instead of a real child
 *  process (a real "lost notification" is an OS/kernel-timing edge case — Node's own child
 *  reaping makes it effectively unreproducible on demand in-process; see this module's own
 *  heartbeat.test.ts for how the reuse-safety and consecutive-requirement claims above are
 *  pinned instead). */
export function createExitLossDetector(isAlive: () => boolean): ExitLossDetector {
  let consecutiveDead = 0;
  return {
    tick(): boolean {
      if (isAlive()) {
        consecutiveDead = 0;
        return false;
      }
      consecutiveDead++;
      return consecutiveDead >= REQUIRED_CONSECUTIVE_DEAD_READINGS;
    },
  };
}
