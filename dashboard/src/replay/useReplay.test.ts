import assert from "node:assert/strict";
import test from "node:test";
import type { EventsPage, Round, SpendPage } from "../api/types.ts";
import { loadRoundLog, resolveActiveLog } from "./useReplay.ts";

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

// #766 gate② finding [3] (round-log-load-rejection-sticks): a rejected `/api/events`/`/api/spend`
// page used to leave `loading` true forever (no `.catch` anywhere in the effect) with `log`/
// `position` never set — a permanently blank, unexplained replay screen with no way to retry.
// `loadRoundLog` is the extracted, directly-testable seam (same pattern as `Controls.tsx`'s
// `runControlEffect`): the effect that calls it only ever sees a settled `{ok, ...}` result, never
// a rejection to miss handling.

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "done",
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T10:30:00Z",
    startEventId: 100,
    startSpendId: 50,
    eventCount: 1,
    schemaVersion: 1,
    artifact: null,
    ...overrides,
  };
}

test("loadRoundLog: a successful load resolves ok:true with the assembled log", async () => {
  const r = round({ eventCount: 1 });
  const fetchEventsPage = async (): Promise<EventsPage> => ({
    events: [{ id: 101, ts: "2026-08-10T10:01:00Z", kind: "merged", payload: { issue: 1, pr: 1 } }],
    lastId: 101,
  });
  const fetchSpendPage = async (): Promise<SpendPage> => ({ spend: [], lastId: 50 });
  const result = await loadRoundLog(r, null, null, null, fetchEventsPage, fetchSpendPage);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.log.round, r);
    assert.deepEqual(
      result.log.events.map((e) => e.id),
      [101],
    );
  }
});

test("loadRoundLog: a rejected events page resolves ok:false with the error — never throws, never hangs", async () => {
  const r = round();
  const boom = new Error("network down");
  const fetchEventsPage = async (): Promise<EventsPage> => {
    throw boom;
  };
  const fetchSpendPage = async (): Promise<SpendPage> => ({ spend: [], lastId: 50 });
  const result = await loadRoundLog(r, null, null, null, fetchEventsPage, fetchSpendPage);
  assert.deepEqual(result, { ok: false, error: boom });
});

test("loadRoundLog: a rejected spend page ALSO resolves ok:false — either page failing is a load failure", async () => {
  const r = round();
  const boom = new Error("spend endpoint 500");
  const fetchEventsPage = async (): Promise<EventsPage> => ({ events: [], lastId: 100 });
  const fetchSpendPage = async (): Promise<SpendPage> => {
    throw boom;
  };
  const result = await loadRoundLog(r, null, null, null, fetchEventsPage, fetchSpendPage);
  assert.deepEqual(result, { ok: false, error: boom });
});
