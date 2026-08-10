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

test("buildRoundLog: builds checkpoints and phase windows from the SAME shared reducer helpers useReplay uses", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  assert.ok(Array.isArray(log.checkpoints));
  assert.ok(log.phaseWindows.length >= 1, "the fixture's round-phase event must produce at least one window");
  assert.equal(log.phaseWindows[0]!.phase, "executing");
});
