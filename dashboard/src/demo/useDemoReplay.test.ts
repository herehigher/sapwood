import assert from "node:assert/strict";
import test from "node:test";
import { buildRoundLog } from "./build-round-log.ts";
import { DEMO_SOURCE } from "./source.ts";
import { endPosition } from "./useDemoReplay.ts";

// `endPosition` is `useDemoReplay`'s one directly-testable pure seam (same pattern
// `useReplay.test.ts` uses for its own hook — see that file's own doc) — proving `?demo` defaults
// to the round's fully-folded end state, which is what makes the fixture's data observable on the
// FIRST synchronous render (no playback tick, no effect required — see the hook's own module doc).

const round = DEMO_SOURCE.rounds[0]!;

test("endPosition: null log (nothing selected) is null", () => {
  assert.equal(endPosition(null, 2), null);
});

test("endPosition: a real round's log folds every one of its events — not the empty start state", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  const position = endPosition(log, 2);
  assert.ok(position);
  assert.equal(position.cursorIndex, log.events.length);
  assert.equal(position.cursorId, log.events[log.events.length - 1]!.id);
  assert.deepEqual(
    position.state.events.map((e) => e.id).sort((a, b) => a - b),
    log.events.map((e) => e.id).sort((a, b) => a - b),
  );
});

test("endPosition: the fixture's dispatched issueTitle reaches the folded titles map", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  const position = endPosition(log, 2);
  assert.equal(position!.state.titles[9101]?.issueTitle, "Add scrub bar chapter marks");
});
