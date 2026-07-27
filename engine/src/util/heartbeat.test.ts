// heartbeat.test.ts (#395 gate② round 3): createHeartbeatGate's two guards — liveness and
// spam-suppression — tested in isolation with a fake state (no real DB, no real process).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHeartbeatGate } from "./heartbeat.js";

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
