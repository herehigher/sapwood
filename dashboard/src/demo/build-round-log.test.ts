import assert from "node:assert/strict";
import test from "node:test";
import { buildRoundLog } from "./build-round-log.ts";
import { DEMO_SOURCE } from "./source.ts";

const round = DEMO_SOURCE.rounds[0]!;

test("buildRoundLog: the fixture's single round covers every bundled event, sorted ascending", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  assert.equal(log.events.length, DEMO_SOURCE.events.length);
  assert.deepEqual(
    log.events.map((e) => e.id),
    DEMO_SOURCE.events.map((e) => e.id).sort((a, b) => a - b),
  );
});

test("buildRoundLog: spend rows are windowed by the round's startSpendId, sorted ascending by ts", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  assert.equal(log.spend.length, DEMO_SOURCE.spend.length);
  assert.ok(log.spend.every((row, i) => i === 0 || log.spend[i - 1]!.ts <= row.ts));
});

test("buildRoundLog: a round with a later sibling excludes that sibling's events (ceiling applied)", () => {
  const laterRound = { ...round, roundId: round.roundId + 1, startEventId: 100, startSpendId: 100 };
  const bundle = { ...DEMO_SOURCE, rounds: [round, laterRound] };
  const log = buildRoundLog(bundle, round, 2);
  assert.ok(
    log.events.every((e) => e.id < 100),
    "the first round's log must stop before the next round's startEventId",
  );
});

// #793 gate② finding [1] (demo-round-cursor-inclusive): `startEventId`/`startSpendId` are
// EXCLUSIVE lower bounds on the real wire (`engine/src/state/state.ts`'s `listRounds()`: `e.id >
// r.start_event_id`) — the row AT the cursor id belongs to whatever round precedes this one, never
// this one. A synthetic round whose own cursor points AT a real row (rather than one before it)
// pins that the cursor row itself is excluded, not folded in.

test("buildRoundLog: the event AT startEventId is excluded (exclusive lower bound), not folded into this round", () => {
  const cursorRound = { ...round, startEventId: 3, eventCount: DEMO_SOURCE.events.filter((e) => e.id > 3).length };
  const log = buildRoundLog(DEMO_SOURCE, cursorRound, 2);
  assert.ok(
    log.events.every((e) => e.id !== 3),
    "the id-3 event sits AT the cursor — it belongs to the round before this one, not this one",
  );
  assert.ok(
    log.events.every((e) => e.id > 3),
    "every included event must have an id strictly greater than startEventId",
  );
});

test("buildRoundLog: the spend row AT startSpendId is excluded (exclusive lower bound), not folded into this round", () => {
  const cursorRound = { ...round, startSpendId: 1 };
  const log = buildRoundLog(DEMO_SOURCE, cursorRound, 2);
  assert.ok(
    log.spend.every((r) => r.id !== 1),
    "the id-1 spend row sits AT the cursor — it belongs to the round before this one, not this one",
  );
});

// #922 AC5 gate② finding [5]: the fixture now opens with a real `aligning` round-phase event
// (source.ts's own doc) before its "executing" transition — two windows, not one.
test("buildRoundLog: builds checkpoints and phase windows from the SAME shared reducer helpers useReplay uses", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  assert.ok(Array.isArray(log.checkpoints));
  assert.equal(log.phaseWindows.length, 2, "the fixture's two round-phase events must produce two windows");
  assert.equal(log.phaseWindows[0]!.phase, "aligning");
  assert.equal(log.phaseWindows[1]!.phase, "executing");
});
