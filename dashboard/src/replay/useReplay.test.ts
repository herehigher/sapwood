import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveLog } from "./useReplay.ts";

// #766 gate② finding [0] (round-switch-retains-old-replay): switching directly from a loaded
// round A to round B leaves `log` (React state) holding round A's data until the async fetch for
// B resolves. `resolveActiveLog` is what every reader in `useReplay` now goes through instead of
// `log` directly — these tests prove it rejects a stale round's log the INSTANT the selection
// changes, without needing to wait for (or even mock) the async load.

function log(roundId: number) {
  return { round: { roundId }, marker: `round-${roundId}-data` };
}

test("resolveActiveLog: a log matching the current selection passes through unchanged", () => {
  const l = log(5);
  assert.equal(resolveActiveLog(l, 5), l);
});

test("resolveActiveLog: switching selection from round A to round B discards A's log immediately — before B's own load ever resolves", () => {
  const roundALog = log(1);
  // Selection has already moved to round 2, but `log` state still holds round 1's fully-loaded
  // data (the exact window finding [0] flagged — B's fetch hasn't resolved yet).
  const result = resolveActiveLog(roundALog, 2);
  assert.equal(result, null, "round A's log must never be read as valid once round B is selected");
});

test("resolveActiveLog: null log (nothing loaded yet) is null regardless of selection", () => {
  assert.equal(resolveActiveLog(null, 1), null);
  assert.equal(resolveActiveLog(null, null), null);
});

test("resolveActiveLog: a loaded log with selection returned to live (null) is discarded, same as any other mismatch", () => {
  const l = log(3);
  assert.equal(resolveActiveLog(l, null), null);
});
