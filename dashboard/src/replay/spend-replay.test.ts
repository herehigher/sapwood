import assert from "node:assert/strict";
import test from "node:test";
import type { SpendRow } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";
import { bucketSpendByPhase, buildPhaseWindows, phaseSpendBars, spendThroughTs, UNATTRIBUTED_PHASE } from "./spend-replay.ts";

function spendRow(id: number, ts: string, usd: number): SpendRow {
  return {
    id,
    ts,
    worker: "w1",
    issue: 100 + id,
    usd,
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

function roundPhaseEvent(id: number, ts: string, phase: string): DomainEvent {
  return { known: true, id, ts, kind: "round-phase", payload: { round_id: 1, phase } };
}

// ── cursor alignment: spend_ledger.ts <= current event's ts ────────────────────────────────────

test("spendThroughTs returns every row at or before the cursor ts, none after", () => {
  const rows = [spendRow(1, "2026-08-10T00:00:00Z", 1), spendRow(2, "2026-08-10T00:05:00Z", 2), spendRow(3, "2026-08-10T00:10:00Z", 3)];
  assert.deepEqual(spendThroughTs(rows, "2026-08-10T00:05:00Z"), rows.slice(0, 2));
  assert.deepEqual(spendThroughTs(rows, "2026-08-10T00:00:00Z"), rows.slice(0, 1));
  assert.deepEqual(spendThroughTs(rows, "2026-08-09T00:00:00Z"), []);
  assert.deepEqual(spendThroughTs(rows, "2026-08-11T00:00:00Z"), rows);
});

test("spendThroughTs is exact at a tie (row.ts === cursorTs is INCLUDED, per the <= contract)", () => {
  const rows = [spendRow(1, "2026-08-10T00:00:00Z", 1)];
  assert.deepEqual(spendThroughTs(rows, "2026-08-10T00:00:00Z"), rows);
});

// ── phase windows from the round-phase event trail ──────────────────────────────────────────────

test("buildPhaseWindows turns a round-phase trail into consecutive [start, next-start) windows, last one open-ended", () => {
  const events = [
    roundPhaseEvent(1, "2026-08-10T00:00:00Z", "aligning"),
    roundPhaseEvent(2, "2026-08-10T00:10:00Z", "architecting"),
    roundPhaseEvent(3, "2026-08-10T00:20:00Z", "executing"),
  ];
  const windows = buildPhaseWindows(events);
  assert.deepEqual(windows, [
    { phase: "aligning", startTs: "2026-08-10T00:00:00Z", endTs: "2026-08-10T00:10:00Z" },
    { phase: "architecting", startTs: "2026-08-10T00:10:00Z", endTs: "2026-08-10T00:20:00Z" },
    { phase: "executing", startTs: "2026-08-10T00:20:00Z", endTs: null },
  ]);
});

test("buildPhaseWindows ignores non-round-phase events and sorts by id regardless of input order", () => {
  const events = [
    roundPhaseEvent(3, "2026-08-10T00:20:00Z", "executing"),
    { known: true, id: 2, ts: "2026-08-10T00:15:00Z", kind: "dispatched", payload: { issue: 1 } } as DomainEvent,
    roundPhaseEvent(1, "2026-08-10T00:00:00Z", "aligning"),
  ];
  const windows = buildPhaseWindows(events);
  assert.deepEqual(
    windows.map((w) => w.phase),
    ["aligning", "executing"],
  );
});

test("buildPhaseWindows returns no windows when the log carries no round-phase events at all (pre-#206 history)", () => {
  assert.deepEqual(buildPhaseWindows([]), []);
});

// ── phase bucketing: a row belongs to the window containing its ts; misses go to unattributed ───

test("bucketSpendByPhase assigns each row to the phase whose window contains its ts", () => {
  const windows = buildPhaseWindows([
    roundPhaseEvent(1, "2026-08-10T00:00:00Z", "aligning"),
    roundPhaseEvent(2, "2026-08-10T00:10:00Z", "executing"),
  ]);
  const rows = [
    spendRow(1, "2026-08-10T00:05:00Z", 1), // aligning
    spendRow(2, "2026-08-10T00:15:00Z", 2), // executing
    spendRow(3, "2026-08-10T00:20:00Z", 3), // executing (open-ended window)
  ];
  const buckets = bucketSpendByPhase(rows, windows);
  assert.deepEqual(
    buckets.map((b) => b.phase),
    ["aligning", "executing"],
  );
  assert.deepEqual(
    buckets.find((b) => b.phase === "aligning")?.rows.map((r) => r.id),
    [1],
  );
  assert.deepEqual(
    buckets.find((b) => b.phase === "executing")?.rows.map((r) => r.id),
    [2, 3],
  );
});

test("a row before the first window's start, or with no windows at all, buckets as unattributed — never a real phase", () => {
  const windows = buildPhaseWindows([roundPhaseEvent(1, "2026-08-10T00:10:00Z", "aligning")]);
  const preHistoryRow = spendRow(1, "2026-08-09T00:00:00Z", 5); // pre-#206-style: before any round-phase event
  const buckets = bucketSpendByPhase([preHistoryRow], windows);
  assert.deepEqual(buckets, [{ phase: UNATTRIBUTED_PHASE, rows: [preHistoryRow] }]);

  const noWindowsAtAll = bucketSpendByPhase([spendRow(2, "2026-08-10T00:00:00Z", 5)], []);
  assert.deepEqual(noWindowsAtAll, [{ phase: UNATTRIBUTED_PHASE, rows: [spendRow(2, "2026-08-10T00:00:00Z", 5)] }]);
});

test("unattributed is drawn LAST even when its rows sort before every attributed one", () => {
  const windows = buildPhaseWindows([roundPhaseEvent(2, "2026-08-10T00:10:00Z", "executing")]);
  const rows = [
    spendRow(1, "2026-08-10T00:00:00Z", 5), // before the only window -> unattributed
    spendRow(2, "2026-08-10T00:15:00Z", 7), // inside the window -> executing
  ];
  const buckets = bucketSpendByPhase(rows, windows);
  assert.deepEqual(
    buckets.map((b) => b.phase),
    ["executing", UNATTRIBUTED_PHASE],
    "attributed phases first, unattributed always trailing, regardless of row/window order",
  );
});

test("a mixed pre-#206 and post-#206 log never misfiles the pre-history rows into a real phase", () => {
  const windows = buildPhaseWindows([roundPhaseEvent(10, "2026-08-10T12:00:00Z", "executing")]);
  const preRows = [spendRow(1, "2026-08-01T00:00:00Z", 1), spendRow(2, "2026-08-05T00:00:00Z", 2)];
  const postRow = spendRow(3, "2026-08-10T13:00:00Z", 3);
  const buckets = bucketSpendByPhase([...preRows, postRow], windows);
  const unattributed = buckets.find((b) => b.phase === UNATTRIBUTED_PHASE);
  assert.deepEqual(
    unattributed?.rows.map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(
    buckets.find((b) => b.phase === "executing")?.rows.map((r) => r.id),
    [3],
  );
});

// ── bars: the CostStrip-shaped summary, summed per bucket ───────────────────────────────────────

test("phaseSpendBars sums usd per bucket and preserves bucket order (unattributed still last)", () => {
  const buckets = [
    { phase: "aligning", rows: [spendRow(1, "t", 1.5), spendRow(2, "t", 2.5)] },
    { phase: UNATTRIBUTED_PHASE, rows: [spendRow(3, "t", 0.75)] },
  ];
  assert.deepEqual(phaseSpendBars(buckets), [
    { label: "aligning", usd: 4 },
    { label: UNATTRIBUTED_PHASE, usd: 0.75 },
  ]);
});
