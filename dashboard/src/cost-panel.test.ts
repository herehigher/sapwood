import assert from "node:assert/strict";
import test from "node:test";
import type { Lane, Round, SpendRow } from "./api/types.ts";
import {
  avgRoundCostUsd,
  buildClosedRoundCostPanel,
  buildTodayCostPanel,
  modelCostBars,
  reviewSpendUsd,
  roundCostFooter,
  roundsForDay,
  rowsForDay,
  stageCostBars,
  sumEstCostUsd,
  tickPositionPct,
} from "./cost-panel.ts";
import { bucketSpendByPhase, buildPhaseWindows } from "./replay/spend-replay.ts";

function spendRow(id: number, ts: string, usd: number, overrides: Partial<SpendRow> = {}): SpendRow {
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
    ...overrides,
  };
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    lane: "w1",
    issue: 1,
    state: "running",
    pr: null,
    startedAt: "2026-08-14T00:00:00Z",
    endedAt: null,
    costUsd: null,
    estCostUsd: null,
    contextTokens: null,
    tokenComposition: null,
    ...overrides,
  };
}

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "done",
    startedAt: "2026-08-10T00:00:00Z",
    endedAt: "2026-08-10T01:00:00Z",
    startEventId: 0,
    startSpendId: 0,
    eventCount: 0,
    schemaVersion: 1,
    artifact: null,
    ...overrides,
  };
}

// ── stageCostBars: the fixed six-stage order, zero-filled, reusing phaseSpendBars ──────────────

test("stageCostBars renders the six round phases in fixed §7 order with plain-language labels, zero-filled when absent", () => {
  const windows = buildPhaseWindows([
    { known: true, id: 1, ts: "t0", kind: "round-phase", payload: { round_id: 1, phase: "aligning" } },
    { known: true, id: 2, ts: "t1", kind: "round-phase", payload: { round_id: 1, phase: "executing" } },
  ]);
  const rows = [spendRow(1, "t0", 0.22), spendRow(2, "t1", 8.9)];
  const buckets = bucketSpendByPhase(rows, windows);
  assert.deepEqual(stageCostBars(buckets), [
    { label: "Goal & align", usd: 0.22 },
    { label: "Arch review", usd: 0 },
    { label: "Verify", usd: 0 },
    { label: "Lanes", usd: 8.9 },
    { label: "Summary", usd: 0 },
    { label: "Retro", usd: 0 },
  ]);
});

test("stageCostBars appends an Unattributed row last, only when the bucket is non-empty", () => {
  const buckets = bucketSpendByPhase([spendRow(1, "t0", 3)], []); // no windows -> unattributed
  const bars = stageCostBars(buckets);
  assert.equal(bars.length, 7);
  assert.deepEqual(bars[6], { label: "Unattributed", usd: 3 });

  const noneUnattributed = stageCostBars([]);
  assert.equal(noneUnattributed.length, 6);
  assert.ok(!noneUnattributed.some((b) => b.label === "Unattributed"));
});

// ── #890 (§3 E): the est share folds onto the "Lanes" bar only ─────────────────────────────────

test("stageCostBars folds a non-zero executingEstUsd onto the Lanes bar only, every other bar untouched", () => {
  const buckets = bucketSpendByPhase([spendRow(1, "t0", 8.9)], buildPhaseWindows([]));
  const bars = stageCostBars(buckets, 2.2);
  assert.deepEqual(
    bars.find((b) => b.label === "Lanes"),
    { label: "Lanes", usd: 0, estUsd: 2.2 },
  );
  for (const b of bars) {
    if (b.label !== "Lanes") assert.equal(b.estUsd, undefined, `${b.label} must carry no est share`);
  }
});

test("stageCostBars omits estUsd entirely (never a fabricated zero) when executingEstUsd is 0 or unset", () => {
  const bars = stageCostBars([]);
  assert.equal(bars.find((b) => b.label === "Lanes")?.estUsd, undefined);
});

// ── sumEstCostUsd: the header meter's and today panel's shared est source ──────────────────────

test("sumEstCostUsd sums every running lane's live estimate, treating a null estimate as 0", () => {
  const lanes = [lane({ estCostUsd: 6.21 }), lane({ lane: "w2", estCostUsd: null }), lane({ lane: "w3", estCostUsd: 1.5 })];
  assert.equal(sumEstCostUsd(lanes), 6.21 + 1.5);
});

test("sumEstCostUsd is 0 (never NaN) for no lanes", () => {
  assert.equal(sumEstCostUsd([]), 0);
});

test("buildTodayCostPanel threads lanesEstUsd through to the Lanes stage bar", () => {
  const panel = buildTodayCostPanel([], [], [], null, null, 3.3);
  assert.equal(panel.stageBars.find((b) => b.label === "Lanes")?.estUsd, 3.3);
});

// ── modelCostBars: group by model, largest spend first ──────────────────────────────────────────

test("modelCostBars sums usd per model, sorted by spend descending", () => {
  const rows = [
    spendRow(1, "t0", 2.4, { model: "sonnet" }),
    spendRow(2, "t1", 5.0, { model: "opus" }),
    spendRow(3, "t2", 2.8, { model: "opus" }),
  ];
  assert.deepEqual(modelCostBars(rows), [
    { label: "opus", usd: 7.8 },
    { label: "sonnet", usd: 2.4 },
  ]);
});

test("modelCostBars is empty for no rows, never a fabricated zero row", () => {
  assert.deepEqual(modelCostBars([]), []);
});

// ── tickPositionPct: the target-tick marker's bar-coordinate ────────────────────────────────────

test("tickPositionPct places the tick proportionally, matching the bar's own width formula", () => {
  assert.equal(tickPositionPct(5, 10), 50);
  assert.equal(tickPositionPct(10, 10), 100);
  assert.equal(tickPositionPct(0, 10), 0);
});

test("tickPositionPct clamps to [0, 100] — a target past the group max never draws off-track", () => {
  assert.equal(tickPositionPct(15, 10), 100);
});

test("tickPositionPct is 0 when the group has no max at all (max <= 0), never NaN/Infinity", () => {
  assert.equal(tickPositionPct(5, 0), 0);
});

// ── roundCostFooter: total / PRs merged / $-per-PR / review cost ────────────────────────────────

test("roundCostFooter divides total by PRs merged for the $-per-PR figure", () => {
  assert.deepEqual(roundCostFooter(6.2, 3, 0), { totalUsd: 6.2, prsMerged: 3, usdPerPr: 6.2 / 3, reviewUsd: 0 });
});

test("roundCostFooter's $-per-PR is null (never a division-by-zero figure) when nothing merged", () => {
  assert.deepEqual(roundCostFooter(4.2, 0, 1.1), { totalUsd: 4.2, prsMerged: 0, usdPerPr: null, reviewUsd: 1.1 });
});

// ── reviewSpendUsd: sum of engine-review-attributed rows only ───────────────────────────────────

test("reviewSpendUsd sums only actorKind engine-review rows, ignoring worker/fix-leg/peripheral spend", () => {
  const rows = [
    spendRow(1, "t0", 1.5, { actorKind: "engine-review" }),
    spendRow(2, "t1", 4.0, { actorKind: "worker" }),
    spendRow(3, "t2", 0.5, { actorKind: "engine-review" }),
    spendRow(4, "t3", 2.0, { actorKind: "peripheral-role" }),
  ];
  assert.equal(reviewSpendUsd(rows), 2);
});

test("reviewSpendUsd is 0 (never fabricated) when the round used external/human review", () => {
  assert.equal(reviewSpendUsd([spendRow(1, "t0", 4, { actorKind: "worker" })]), 0);
});

// ── avgRoundCostUsd: mean spend across CLOSED rounds only ───────────────────────────────────────

test("avgRoundCostUsd averages spendUsd across closed rounds with a readable artifact", () => {
  const rounds = [
    round({ roundId: 1, status: "done", artifact: { spendUsd: 4.2, roundBudgetUsd: 30, prsMerged: 1 } }),
    round({ roundId: 2, status: "done", artifact: { spendUsd: 5.4, roundBudgetUsd: 30, prsMerged: 2 } }),
  ];
  assert.equal(avgRoundCostUsd(rounds), (4.2 + 5.4) / 2);
});

test("avgRoundCostUsd excludes the open round (no artifact yet) and any artifact-less closed round", () => {
  const rounds = [
    round({ roundId: 1, status: "done", artifact: { spendUsd: 4.0, roundBudgetUsd: 30, prsMerged: 1 } }),
    round({ roundId: 2, status: "in_progress", artifact: null }),
    round({ roundId: 3, status: "done", artifact: null }),
  ];
  assert.equal(avgRoundCostUsd(rounds), 4.0);
});

test("avgRoundCostUsd is null (never 0, never NaN) when no closed round has a readable artifact", () => {
  assert.equal(avgRoundCostUsd([round({ roundId: 1, status: "in_progress", artifact: null })]), null);
  assert.equal(avgRoundCostUsd([]), null);
});

// ── rowsForDay: the shared UTC calendar-day boundary ─────────────────────────────────────────────

test("rowsForDay keeps only rows whose ts falls on the same UTC calendar day as now", () => {
  const rows = [spendRow(1, "2026-08-14T00:00:00Z", 1), spendRow(2, "2026-08-13T23:59:59Z", 2), spendRow(3, "2026-08-14T23:59:59Z", 3)];
  assert.deepEqual(
    rowsForDay(rows, new Date("2026-08-14T12:00:00Z")).map((r) => r.id),
    [1, 3],
  );
});

test("roundsForDay keeps only rounds whose startedAt falls on the same UTC calendar day as now", () => {
  const rounds = [
    round({ roundId: 1, startedAt: "2026-08-14T00:00:00Z" }),
    round({ roundId: 2, startedAt: "2026-08-13T23:59:59Z" }),
    round({ roundId: 3, startedAt: "2026-08-14T23:59:59Z" }),
  ];
  assert.deepEqual(
    roundsForDay(rounds, new Date("2026-08-14T12:00:00Z")).map((r) => r.roundId),
    [1, 3],
  );
});

// ── buildTodayCostPanel / buildClosedRoundCostPanel: the full panel shape ───────────────────────

test("buildTodayCostPanel wires bucketed spend into stage bars, passes model bars through, and halves-of-sixths the round budget into the target tick", () => {
  const windows = buildPhaseWindows([{ known: true, id: 1, ts: "t0", kind: "round-phase", payload: { round_id: 1, phase: "aligning" } }]);
  const rows = [spendRow(1, "t0", 1.2)];
  const panel = buildTodayCostPanel(rows, windows, [{ label: "opus", usd: 1.2 }], 4.8, 30);
  assert.equal(panel.heading, "cost · today");
  assert.equal(panel.avgRoundUsd, 4.8);
  assert.equal(panel.targetUsd, 5); // 30 / 6
  assert.equal(panel.footer, null);
  assert.deepEqual(panel.modelBars, [{ label: "opus", usd: 1.2 }]);
  assert.equal(panel.stageBars.find((b) => b.label === "Goal & align")?.usd, 1.2);
});

test("buildTodayCostPanel's target tick is null when no round budget is configured, never a fabricated ceiling", () => {
  const panel = buildTodayCostPanel([], [], [], null, null);
  assert.equal(panel.targetUsd, null);
});

test("buildClosedRoundCostPanel reads total/PRs/target straight from the round's persisted artifact, review cost from its own spend rows", () => {
  const r = round({ roundId: 9, artifact: { spendUsd: 6.2, roundBudgetUsd: 30, prsMerged: 3 } });
  const rows = [spendRow(1, "t0", 1.5, { actorKind: "engine-review" }), spendRow(2, "t1", 4.7, { actorKind: "worker" })];
  const panel = buildClosedRoundCostPanel(r, rows, []);
  assert.equal(panel.heading, "cost · round 9");
  assert.equal(panel.closed, true);
  assert.equal(panel.targetUsd, 5); // 30 / 6
  assert.deepEqual(panel.footer, { totalUsd: 6.2, prsMerged: 3, usdPerPr: 6.2 / 3, reviewUsd: 1.5 });
  assert.deepEqual(panel.modelBars, [{ label: "opus", usd: 6.2 }]);
});

test("buildClosedRoundCostPanel omits the footer entirely (never a fabricated total) when the artifact is missing or malformed — but stage/model bars still render from the real ledger rows", () => {
  const r = round({ roundId: 9, artifact: null });
  const rows = [spendRow(1, "t0", 2.0)];
  const panel = buildClosedRoundCostPanel(r, rows, []);
  assert.equal(panel.footer, null);
  assert.equal(panel.targetUsd, null);
  assert.deepEqual(panel.modelBars, [{ label: "opus", usd: 2.0 }]);
});
