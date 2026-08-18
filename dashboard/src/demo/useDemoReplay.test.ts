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

// #886 gate② run 2e566ac9 finding [0]: `npm run shots` captures the `?demo` fixture at exactly
// this end state (idle) and a scrubbed midpoint (active) — before this fix, `state.pool` was
// empty at BOTH, so `.hero-pool-chip` never appeared in the contact sheet the AC 1 evidence plan
// requires. This proves the fixture itself (not stage.tsx's rendering, already covered by
// hero.test.ts) carries a real, undispatched backlog issue all the way to the captured end state.
// #922 AC3: extended 9103 -> 9103-9108 — the AC's own floor (>= 3 filled + >= 3 outlined
// candidate cards) needs >= 6 undispatched issues in the pool, not just 1.
test("endPosition: the fixture's pool is non-empty at the captured end state — #886's shots-coverage fix", () => {
  const log = buildRoundLog(DEMO_SOURCE, round, 2);
  const position = endPosition(log, 2);
  assert.deepEqual(
    position!.state.hero.pool,
    [9103, 9104, 9105, 9106, 9107, 9108],
    "9103-9108 must reach the end state undispatched — the whole point of the fixture change",
  );
});
