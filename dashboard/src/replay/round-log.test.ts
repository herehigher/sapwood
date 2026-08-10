import assert from "node:assert/strict";
import test from "node:test";
import type { EventsPage, LoopEvent, Round, SpendPage, SpendRow } from "../api/types.ts";
import { loadRoundEvents, loadRoundSpend, roundEventCeiling } from "./round-log.ts";

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "done",
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T10:30:00Z",
    startEventId: 100,
    startSpendId: 50,
    eventCount: 10,
    schemaVersion: 1,
    artifact: { merged: 1 },
    ...overrides,
  };
}

function loopEvent(id: number): LoopEvent {
  return { id, ts: new Date(Date.UTC(2026, 7, 10, 10, 0, id)).toISOString(), kind: "merged", payload: { issue: id, pr: id } };
}

function spendRow(id: number, ts: string): SpendRow {
  return {
    id,
    ts,
    worker: "w1",
    issue: id,
    usd: 1,
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    actorKind: "worker",
    role: null,
    estimated: false,
  };
}

// ── roundEventCeiling ────────────────────────────────────────────────────────────────────────

test("roundEventCeiling is the NEXT round's startEventId, when one exists", () => {
  const r1 = round({ roundId: 1, startEventId: 100 });
  const r2 = round({ roundId: 2, startEventId: 250 });
  assert.equal(roundEventCeiling(r1, [r1, r2]), 250);
});

test("roundEventCeiling is null for the newest round (open-ended window)", () => {
  const r1 = round({ roundId: 1, startEventId: 100 });
  assert.equal(roundEventCeiling(r1, [r1]), null);
});

test("roundEventCeiling picks the NEAREST following round, not just any later one", () => {
  const r1 = round({ roundId: 1, startEventId: 100 });
  const r2 = round({ roundId: 2, startEventId: 250 });
  const r3 = round({ roundId: 3, startEventId: 400 });
  assert.equal(roundEventCeiling(r1, [r1, r2, r3]), 250);
});

// ── loadRoundEvents: pages until eventCount is covered, sorted ascending, ceiling-clamped ──────

test("loadRoundEvents pages from startEventId across multiple pages until eventCount rows are collected", async () => {
  const r = round({ startEventId: 100, eventCount: 5 });
  const allEvents = [101, 102, 103, 104, 105].map(loopEvent);
  let calls = 0;
  const fetchPage = async (after: number, limit: number): Promise<EventsPage> => {
    calls++;
    const page = allEvents.filter((e) => e.id > after).slice(0, limit);
    return { events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const result = await loadRoundEvents(r, null, fetchPage, 2);
  assert.equal(calls, 3, "3 pages of size 2 cover 5 events");
  assert.deepEqual(
    result.map((e) => e.id),
    [101, 102, 103, 104, 105],
  );
});

test("loadRoundEvents stops at the ceiling id, never pulling in the NEXT round's events", async () => {
  const r = round({ startEventId: 100, eventCount: 10 });
  const allEvents = [101, 102, 103, 104, 105].map(loopEvent); // only 5 real events exist
  const fetchPage = async (after: number, limit: number): Promise<EventsPage> => {
    const page = allEvents.filter((e) => e.id > after).slice(0, limit);
    return { events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const result = await loadRoundEvents(r, 103, fetchPage, 10);
  assert.deepEqual(
    result.map((e) => e.id),
    [101, 102, 103],
    "events past the ceiling id are dropped even though eventCount claims more exist",
  );
});

test("loadRoundEvents stops once the server stops returning fresh rows (no infinite loop on a stale/short log)", async () => {
  const r = round({ startEventId: 100, eventCount: 999 });
  const only = [101, 102].map(loopEvent);
  const fetchPage = async (after: number, limit: number): Promise<EventsPage> => {
    const page = only.filter((e) => e.id > after).slice(0, limit);
    return { events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const result = await loadRoundEvents(r, null, fetchPage, 10);
  assert.deepEqual(
    result.map((e) => e.id),
    [101, 102],
  );
});

test("loadRoundEvents returns events sorted ascending by id even if pages arrive out of order", async () => {
  const r = round({ startEventId: 100, eventCount: 3 });
  const events = [103, 101, 102].map(loopEvent); // deliberately unsorted server response
  let served = false;
  const fetchPage = async (): Promise<EventsPage> => {
    if (served) return { events: [], lastId: 100 };
    served = true;
    return { events, lastId: 103 };
  };
  const result = await loadRoundEvents(r, null, fetchPage, 10);
  assert.deepEqual(
    result.map((e) => e.id),
    [101, 102, 103],
  );
});

// ── loadRoundSpend: same paging contract, sorted by ts, clamped to spendCeilingId ──────────────

test("loadRoundSpend pages from startSpendId, sorted by ts, clamped to the ceiling", async () => {
  const r = round({ startSpendId: 50, eventCount: 0 });
  const rows = [
    spendRow(51, "2026-08-10T10:01:00Z"),
    spendRow(52, "2026-08-10T10:02:00Z"),
    spendRow(53, "2026-08-10T10:03:00Z"), // belongs to the NEXT round
  ];
  const fetchPage = async (after: number, limit: number): Promise<SpendPage> => {
    const page = rows.filter((r2) => r2.id > after).slice(0, limit);
    return { spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const result = await loadRoundSpend(r, 52, fetchPage, 10);
  assert.deepEqual(
    result.map((row) => row.id),
    [51, 52],
  );
});

test("loadRoundSpend with no ceiling (newest round) collects everything the ledger has past startSpendId", async () => {
  const r = round({ startSpendId: 50 });
  const rows = [spendRow(51, "2026-08-10T10:01:00Z"), spendRow(52, "2026-08-10T10:02:00Z")];
  const fetchPage = async (after: number, limit: number): Promise<SpendPage> => {
    const page = rows.filter((r2) => r2.id > after).slice(0, limit);
    return { spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const result = await loadRoundSpend(r, null, fetchPage, 10);
  assert.deepEqual(
    result.map((row) => row.id),
    [51, 52],
  );
});
