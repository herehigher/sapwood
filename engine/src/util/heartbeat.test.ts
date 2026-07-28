// heartbeat.test.ts (#395 gate② round 3): createHeartbeatGate's two guards — liveness and
// spam-suppression — tested in isolation with a fake state (no real DB, no real process).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createExitLossDetector, createHeartbeatGate } from "./heartbeat.js";

function fakeState(startId = 0): {
  maxEventId: () => number;
  appendEvent: (kind: string, payload: unknown) => void;
  bump: () => void;
  appended: Array<[string, unknown]>;
} {
  let id = startId;
  const appended: Array<[string, unknown]> = [];
  return {
    maxEventId: () => id,
    appendEvent: (kind, payload) => {
      appended.push([kind, payload]);
      id++;
    },
    bump: () => {
      id++;
    },
    appended,
  };
}

test("createHeartbeatGate: alive + otherwise-silent -> emits every tick (at most one per cadence)", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true);
  gate.tick("worker-heartbeat", { n: 1 });
  gate.tick("worker-heartbeat", { n: 2 });
  gate.tick("worker-heartbeat", { n: 3 });
  assert.deepEqual(state.appended, [
    ["worker-heartbeat", { n: 1 }],
    ["worker-heartbeat", { n: 2 }],
    ["worker-heartbeat", { n: 3 }],
  ]);
});

test("createHeartbeatGate: dead process (isAlive false) -> never emits, even when otherwise silent", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => false);
  gate.tick("worker-heartbeat", {});
  gate.tick("worker-heartbeat", {});
  assert.deepEqual(state.appended, [], "a dead child produces no liveness evidence to report");
});

test("createHeartbeatGate (#395 P2-2 — spam suppression): once something else advances maxEventId, the heartbeat skips its own append for that cadence", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true);
  gate.tick("worker-heartbeat", { n: 1 }); // silent -> emits
  state.bump(); // some OTHER event fires (e.g. a dispatched/reclaim-done event)
  gate.tick("worker-heartbeat", { n: 2 }); // sees the id already moved -> skips
  assert.deepEqual(state.appended, [["worker-heartbeat", { n: 1 }]], "the second tick found the engine already busy and added nothing");
});

test("createHeartbeatGate: after skipping a busy cadence, the NEXT genuinely-silent cadence emits again", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true);
  gate.tick("worker-heartbeat", { n: 1 }); // emits (id 0 -> 1)
  state.bump(); // busy (id 1 -> 2)
  gate.tick("worker-heartbeat", { n: 2 }); // skipped (sees id 2, was expecting 1)
  gate.tick("worker-heartbeat", { n: 3 }); // now silent again (id still 2) -> emits
  assert.deepEqual(state.appended, [
    ["worker-heartbeat", { n: 1 }],
    ["worker-heartbeat", { n: 3 }],
  ]);
});

test("createHeartbeatGate: a busy engine (progress every cadence) emits ZERO heartbeats — the #383 steady-state-spam contract", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true);
  for (let i = 0; i < 20; i++) {
    state.bump(); // something real happens every cadence
    gate.tick("worker-heartbeat", { i });
  }
  assert.deepEqual(state.appended, [], "every cadence already had real progress — the heartbeat never needed to speak");
});

// ── #395 item 1: createExitLossDetector — a pure counter, scripted `isAlive` sequences ──────────
// (a genuine lost-exit-notification is an OS/kernel timing edge case Node's own child-reaping
// makes effectively unreproducible on demand with a real process — see createExitLossDetector's
// own doc for why this is tested this way, matching createHeartbeatGate's own fake-isAlive style
// above rather than a real spawned child.)

test("createExitLossDetector: alive every tick -> never fires, no matter how many ticks", () => {
  const detector = createExitLossDetector(() => true);
  const fired = [detector.tick(), detector.tick(), detector.tick(), detector.tick()];
  assert.deepEqual(fired, [false, false, false, false], "a consistently alive child must never be declared exit-lost");
});

test("createExitLossDetector: exactly ONE dead reading -> does not fire yet (two consecutive are required)", () => {
  const detector = createExitLossDetector(() => false);
  assert.equal(detector.tick(), false, "a single dead reading alone must not fire — it could be a transient probe artifact");
});

test("createExitLossDetector: TWO CONSECUTIVE dead readings -> fires on the second, not before", () => {
  const alive = false;
  const detector = createExitLossDetector(() => alive);
  assert.equal(detector.tick(), false, "reading #1 dead: not yet");
  assert.equal(detector.tick(), true, "reading #2 dead, consecutively: fires now");
});

test("createExitLossDetector: an ALIVE reading between two dead ones resets the counter — never fires from non-consecutive dead readings", () => {
  const script = [false, true, false, false]; // dead, alive (reset), dead, dead(2nd consecutive) -> fires on the 4th
  let i = 0;
  const detector = createExitLossDetector(() => script[i++]!);
  assert.equal(detector.tick(), false, "reading #1 dead: not yet");
  assert.equal(detector.tick(), false, "reading #2 alive: resets the counter (pid-reuse direction is always safe)");
  assert.equal(detector.tick(), false, "reading #3 dead (1st again after reset): not yet");
  assert.equal(detector.tick(), true, "reading #4 dead (2nd consecutive since the reset): fires now");
});

test("createExitLossDetector: fires only ONCE per two-consecutive occurrence — tick() keeps returning true if the caller keeps calling on a still-dead process (caller contract: stop calling after the first true, this just documents it never un-fires)", () => {
  const detector = createExitLossDetector(() => false);
  detector.tick(); // dead #1
  assert.equal(detector.tick(), true, "dead #2: fires");
  assert.equal(detector.tick(), true, "still dead: stays true (caller is expected to have already stopped, per its own doc)");
});
