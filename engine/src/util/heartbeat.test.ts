// heartbeat.test.ts (#395 gate② round 3, #688): createHeartbeatGate's two guards — liveness and
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
  const gate = createHeartbeatGate(state, () => true, state.maxEventId);
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
  const gate = createHeartbeatGate(state, () => false, state.maxEventId);
  gate.tick("worker-heartbeat", {});
  gate.tick("worker-heartbeat", {});
  assert.deepEqual(state.appended, [], "a dead child produces no liveness evidence to report");
});

test("createHeartbeatGate (#395 P2-2 — spam suppression): once something else advances the caller's progress id, the heartbeat skips its own append for that cadence", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true, state.maxEventId);
  gate.tick("worker-heartbeat", { n: 1 }); // silent -> emits
  state.bump(); // some OTHER event fires (e.g. a dispatched/reclaim-done event)
  gate.tick("worker-heartbeat", { n: 2 }); // sees the id already moved -> skips
  assert.deepEqual(state.appended, [["worker-heartbeat", { n: 1 }]], "the second tick found the engine already busy and added nothing");
});

test("createHeartbeatGate: after skipping a busy cadence, the NEXT genuinely-silent cadence emits again", () => {
  const state = fakeState();
  const gate = createHeartbeatGate(state, () => true, state.maxEventId);
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
  const gate = createHeartbeatGate(state, () => true, state.maxEventId);
  for (let i = 0; i < 20; i++) {
    state.bump(); // something real happens every cadence
    gate.tick("worker-heartbeat", { i });
  }
  assert.deepEqual(state.appended, [], "every cadence already had real progress — the heartbeat never needed to speak");
});

// ── #688: per-subject scoping — the batch-10 lane-678/lane-670 starvation fix ─────────────────
//
// A per-subject ledger: each subject's own progress id only advances when THAT subject's gate
// successfully appends (or the test scripts an independent "real progress" event for it) — never
// when a DIFFERENT subject's gate appends. This is what `state.maxEventIdForWorker`/
// `maxEventIdForRoleSession` give the real production call sites (worker.ts, peripheral.ts); the
// prior bug was wiring `state.maxEventId()` (the GLOBAL id, shared by every subject) into this
// same slot instead — see heartbeat.ts's own header doc for the full mechanism.
function makeSubjectLedger(): {
  appendedFor: (subject: string) => Array<[string, unknown]>;
  maxIdFor: (subject: string) => number;
  sinkFor: (subject: string) => { appendEvent: (kind: string, payload: unknown) => void };
} {
  let nextId = 1;
  const appended = new Map<string, Array<[string, unknown]>>();
  const lastIdFor = new Map<string, number>();
  return {
    appendedFor: (subject) => appended.get(subject) ?? [],
    maxIdFor: (subject) => lastIdFor.get(subject) ?? 0,
    sinkFor: (subject) => ({
      appendEvent: (kind, payload) => {
        const id = nextId++;
        lastIdFor.set(subject, id);
        const list = appended.get(subject) ?? [];
        list.push([kind, payload]);
        appended.set(subject, list);
      },
    }),
  };
}

test("createHeartbeatGate (#688 regression, batch-10 lane-678/lane-670 evidence): two concurrent lanes on the same cadence BOTH emit heartbeats — a global-id gate starves one of them permanently, a per-subject gate does not", () => {
  const ledger = makeSubjectLedger();
  const gate678 = createHeartbeatGate(
    ledger.sinkFor("lane-678"),
    () => true,
    () => ledger.maxIdFor("lane-678"),
  );
  const gate670 = createHeartbeatGate(
    ledger.sinkFor("lane-670"),
    () => true,
    () => ledger.maxIdFor("lane-670"),
  );
  // lane-678 dispatched first, ticks first each cadence; lane-670 dispatched 7s later, ticks
  // second — the exact interleaving from the live batch-10 ledger (#8996-#9006).
  for (let cadence = 0; cadence < 5; cadence++) {
    gate678.tick("worker-heartbeat", { lane: "678", cadence });
    gate670.tick("worker-heartbeat", { lane: "670", cadence });
  }
  assert.equal(ledger.appendedFor("lane-678").length, 5, "lane-678 must heartbeat every cadence, not just the first");
  assert.equal(ledger.appendedFor("lane-670").length, 5, "lane-670 must heartbeat every cadence, not just the first");
});

test("createHeartbeatGate (#688 reverse test — #395 anti-spam property preserved per-subject): a lane that appends its OWN progress event this cadence still skips its own heartbeat, even though a DIFFERENT lane is busy every cadence too", () => {
  const ledger = makeSubjectLedger();
  const gate678 = createHeartbeatGate(
    ledger.sinkFor("lane-678"),
    () => true,
    () => ledger.maxIdFor("lane-678"),
  );
  const gate670 = createHeartbeatGate(
    ledger.sinkFor("lane-670"),
    () => true,
    () => ledger.maxIdFor("lane-670"),
  );
  // lane-670 is a permanently busy neighbor — heartbeats every cadence, must never affect lane-678.
  for (let cadence = 0; cadence < 3; cadence++) {
    gate670.tick("worker-heartbeat", { lane: "670", cadence });
  }
  assert.equal(ledger.appendedFor("lane-670").length, 3, "sanity: the neighbor lane is genuinely busy every cadence");

  // lane-678: cadence 1 silent -> emits. Between cadence 1 and 2, lane-678 ITSELF appends a real
  // (non-heartbeat) progress event -> cadence 2's heartbeat must be skipped (the #395 property).
  // Cadence 3 is silent again -> emits.
  gate678.tick("worker-heartbeat", { lane: "678", cadence: 1 });
  ledger.sinkFor("lane-678").appendEvent("dispatched", { lane: "678" }); // lane-678's own OTHER progress
  gate678.tick("worker-heartbeat", { lane: "678", cadence: 2 });
  gate678.tick("worker-heartbeat", { lane: "678", cadence: 3 });
  assert.deepEqual(
    ledger.appendedFor("lane-678").map(([kind]) => kind),
    ["worker-heartbeat", "dispatched", "worker-heartbeat"],
    "cadence 2's heartbeat was skipped because lane-678's own dispatched event already proved progress that cadence",
  );
});

test("createHeartbeatGate (#688, role-session-heartbeat — same mechanism, the peripheral.ts caller): two concurrent role sessions on the same cadence BOTH emit heartbeats", () => {
  const ledger = makeSubjectLedger();
  const sessionA = "role-architect-aaaaaaaa";
  const sessionB = "role-architect-bbbbbbbb";
  const gateA = createHeartbeatGate(
    ledger.sinkFor(sessionA),
    () => true,
    () => ledger.maxIdFor(sessionA),
  );
  const gateB = createHeartbeatGate(
    ledger.sinkFor(sessionB),
    () => true,
    () => ledger.maxIdFor(sessionB),
  );
  for (let cadence = 0; cadence < 4; cadence++) {
    gateA.tick("role-session-heartbeat", { name: sessionA, cadence });
    gateB.tick("role-session-heartbeat", { name: sessionB, cadence });
  }
  assert.equal(ledger.appendedFor(sessionA).length, 4, "session A must heartbeat every cadence");
  assert.equal(ledger.appendedFor(sessionB).length, 4, "session B must heartbeat every cadence");
});

// ── #395 item 1: createExitLossDetector — a pure counter, scripted `isAlive` sequences ──────────
// (a genuine lost-exit-notification is an OS/kernel timing edge case Node's own child-reaping
// makes effectively unreproducible on demand in-process — see createExitLossDetector's own doc
// for why this is tested this way, matching createHeartbeatGate's own fake-isAlive style above
// rather than a real spawned child.)

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
