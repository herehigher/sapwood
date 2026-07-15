import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backfillLegacyRoundCursors, MIGRATIONS, type ModelUsageEntry, SCHEMA_VERSION, State } from "./state.js";

// In-memory DB keeps tests hermetic (no disk, no cleanup). WAL pragma is a no-op on
// :memory: but the migration/version logic is identical.
const mem = () => new State(":memory:");

test("fresh DB migrates to current schema version", () => {
  const s = mem();
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 1);
  s.close();
});

test("worker upsert round-trips and updates state on conflict", () => {
  const s = mem();
  s.upsertWorker({
    name: "w1",
    issue: 2,
    session_id: "uuid-1",
    state: "running",
    started_at: "2026-06-27T00:00:00Z",
    ended_at: null,
  });
  assert.equal(s.getWorker("w1")?.state, "running");

  // same name => update, not duplicate (single-writer-serial assumption)
  s.upsertWorker({
    name: "w1",
    issue: 2,
    session_id: "uuid-1",
    state: "handoff",
    started_at: "2026-06-27T00:00:00Z",
    ended_at: "2026-06-27T01:00:00Z",
  });
  const row = s.getWorker("w1");
  assert.equal(row?.state, "handoff");
  assert.equal(row?.ended_at, "2026-06-27T01:00:00Z");
  s.close();
});

test("upsert refreshes ALL fields on name reuse (resume / reassigned lane)", () => {
  const s = mem();
  s.upsertWorker({
    name: "lane-1",
    issue: 2,
    session_id: "uuid-A",
    state: "done",
    started_at: "2026-06-27T00:00:00Z",
    ended_at: "2026-06-27T00:30:00Z",
  });
  // lane name reused for a different issue + fresh session
  s.upsertWorker({
    name: "lane-1",
    issue: 9,
    session_id: "uuid-B",
    state: "running",
    started_at: "2026-06-27T02:00:00Z",
    ended_at: null,
  });
  const row = s.getWorker("lane-1");
  assert.equal(row?.issue, 9);
  assert.equal(row?.session_id, "uuid-B");
  assert.equal(row?.started_at, "2026-06-27T02:00:00Z");
  assert.equal(row?.ended_at, null);
  s.close();
});

test("runningWorkers returns only state=running rows (in-flight lanes)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "done", started_at: "t", ended_at: "t2" });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "handoff", started_at: "t", ended_at: "t2" });
  const running = s.runningWorkers();
  assert.deepEqual(running.map((w) => w.name).sort(), ["a", "c"]);
  assert.ok(running.every((w) => w.state === "running"));
  s.close();
});

test("activeWorkers returns running + driving (occupied lanes), not terminal states", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "driving", started_at: "t", ended_at: "t2" });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "done", started_at: "t", ended_at: "t2" });
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "handoff", started_at: "t", ended_at: "t2" });
  assert.deepEqual(
    s.activeWorkers().map((w) => w.name),
    ["a", "b"],
  );
  assert.deepEqual(
    s.runningWorkers().map((w) => w.name),
    ["a"],
  ); // running only (probe set)
  s.close();
});

test("drivingWorkers returns only state=driving rows (#13 merge-driver targets)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "driving", started_at: "t", ended_at: "t2", pr: 21 });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "driving", started_at: "t", ended_at: "t2", pr: 22 });
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "done", started_at: "t", ended_at: "t2" });
  assert.deepEqual(
    s.drivingWorkers().map((w) => w.name),
    ["b", "c"],
  );
  s.close();
});

// ── #147: gated-PR reentry (gated_reentry_attempts/capped/labeled + gatedFailedWorkers) ────
test("worker.gated_reentry_attempts/capped/labeled round-trip: default 0/0/0, persisted across upserts", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "failed", started_at: "t", ended_at: "t2", pr: 42 });
  const fresh = s.getWorker("a");
  assert.equal(fresh?.gated_reentry_attempts, 0);
  assert.equal(fresh?.gated_reentry_capped, 0);
  assert.equal(fresh?.gated_escalation_labeled, 0);

  s.upsertWorker({ ...fresh!, state: "driving", gated_reentry_attempts: 1, gated_escalation_labeled: 1 });
  assert.equal(s.getWorker("a")?.gated_reentry_attempts, 1);
  assert.equal(s.getWorker("a")?.gated_reentry_capped, 0); // untouched
  assert.equal(s.getWorker("a")?.gated_escalation_labeled, 1);

  s.upsertWorker({ ...s.getWorker("a")!, state: "failed", gated_reentry_capped: 1 });
  const after = s.getWorker("a");
  assert.equal(after?.gated_reentry_attempts, 1); // preserved via spread, not clobbered
  assert.equal(after?.gated_reentry_capped, 1);
  assert.equal(after?.gated_escalation_labeled, 1); // preserved via spread
  s.close();
});

test("gatedFailedWorkers: only failed rows WITH a pr number AND a proven label write, excluding capped ones — running/driving/done, no-pr failed, and label-write-failed rows never qualify", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null }); // running, no pr
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "failed", started_at: "t", ended_at: "t2" }); // failed, no pr (e.g. dead lane / ESCALATE_NOPR)
  s.upsertWorker({
    name: "c",
    issue: 3,
    session_id: "s3",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 30,
    gated_escalation_labeled: 1,
  }); // eligible
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "driving", started_at: "t", ended_at: "t2", pr: 40 }); // driving, not failed
  s.upsertWorker({
    name: "e",
    issue: 5,
    session_id: "s5",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 50,
    gated_reentry_capped: 1,
    gated_escalation_labeled: 1,
  }); // capped, excluded
  s.upsertWorker({ name: "f", issue: 6, session_id: "s6", state: "done", started_at: "t", ended_at: "t2" }); // terminal, not failed
  // #147 P2: failed+PR but the escalation's label write FAILED (labeled=0, the default) — the
  // label's absence proves nothing about a human act, so the row is invisible to reclaim.
  // Same shape as every pre-migration row (back-compat is deliberately fail-closed).
  s.upsertWorker({ name: "g", issue: 7, session_id: "s7", state: "failed", started_at: "t", ended_at: "t2", pr: 70 });
  assert.deepEqual(
    s.gatedFailedWorkers().map((w) => w.name),
    ["c"],
  );
  s.close();
});

test("worker.pr and review_triggered round-trip (#13): default null/0, persisted across upserts", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  const fresh = s.getWorker("a");
  assert.equal(fresh?.pr, null);
  assert.equal(fresh?.review_triggered, 0);

  s.upsertWorker({ ...fresh!, state: "driving", ended_at: "t2", pr: 42 });
  assert.equal(s.getWorker("a")?.pr, 42);
  assert.equal(s.getWorker("a")?.review_triggered, 0); // untouched -> still 0

  // Spreading a previously-read row (conductor.ts's pattern) preserves pr/review_triggered
  // across an update that only touches unrelated fields.
  const driving = s.getWorker("a")!;
  s.upsertWorker({ ...driving, review_triggered: 1 });
  const after = s.getWorker("a");
  assert.equal(after?.pr, 42); // preserved via spread, not clobbered
  assert.equal(after?.review_triggered, 1);
  s.close();
});

// ── #55 P1-B: the engine-recorded review-trigger pin (review_triggered_head/at) ────────────

test("worker.review_triggered_head/at round-trip: default null, persisted via recordReviewTrigger", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
  const fresh = s.getWorker("a");
  assert.equal(fresh?.review_triggered_head, null);
  assert.equal(fresh?.review_triggered_at, null);

  s.recordReviewTrigger("a", "HEAD1", "2026-07-07T08:00:00.000Z");
  const after = s.getWorker("a");
  assert.equal(after?.review_triggered_head, "HEAD1");
  assert.equal(after?.review_triggered_at, "2026-07-07T08:00:00.000Z");
  assert.equal(after?.pr, 42); // untouched by recordReviewTrigger
  assert.equal(after?.state, "driving");

  // A later push re-records a NEW head/time — recordReviewTrigger overwrites, not appends.
  s.recordReviewTrigger("a", "HEAD2", "2026-07-07T09:00:00.000Z");
  const after2 = s.getWorker("a");
  assert.equal(after2?.review_triggered_head, "HEAD2");
  assert.equal(after2?.review_triggered_at, "2026-07-07T09:00:00.000Z");
  s.close();
});

test("worker.review_triggered_head/at survives an upsert that spreads a previously-read row (conductor.ts's pattern)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
  s.recordReviewTrigger("a", "HEAD1", "2026-07-07T08:00:00.000Z");
  const driving = s.getWorker("a")!;
  s.upsertWorker({ ...driving, ended_at: "t3" }); // an unrelated field update via spread
  const after = s.getWorker("a");
  assert.equal(after?.review_triggered_head, "HEAD1"); // preserved, not clobbered to NULL
  assert.equal(after?.review_triggered_at, "2026-07-07T08:00:00.000Z");
  s.close();
});

// ── #54: reviewer-failover lock (review_fallback_head/kind) ───────────────────────────────

test("worker.review_fallback_head/kind round-trip: default null, persisted via recordReviewFallback", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
  const fresh = s.getWorker("a");
  assert.equal(fresh?.review_fallback_head, null);
  assert.equal(fresh?.review_fallback_kind, null);

  s.recordReviewFallback("a", "HEAD1", "same-model-trusted");
  const after = s.getWorker("a");
  assert.equal(after?.review_fallback_head, "HEAD1");
  assert.equal(after?.review_fallback_kind, "same-model-trusted");
  assert.equal(after?.pr, 42); // untouched by recordReviewFallback

  // Clearing (primary recovered) sets both back to null.
  s.recordReviewFallback("a", null, null);
  const cleared = s.getWorker("a");
  assert.equal(cleared?.review_fallback_head, null);
  assert.equal(cleared?.review_fallback_kind, null);
  s.close();
});

test("worker.review_fallback_head/kind survives an upsert that spreads a previously-read row (conductor.ts's pattern)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
  s.recordReviewFallback("a", "HEAD1", "human");
  const driving = s.getWorker("a")!;
  s.upsertWorker({ ...driving, ended_at: "t3" });
  const after = s.getWorker("a");
  assert.equal(after?.review_fallback_head, "HEAD1"); // preserved, not clobbered to NULL
  assert.equal(after?.review_fallback_kind, "human");
  s.close();
});

test("lastReviewerFallbackEvent (#54 R2): none -> null; returns the LATEST switch/revert for the right worker only", () => {
  const s = mem();
  assert.equal(s.lastReviewerFallbackEvent("lane-a"), null);

  s.appendEvent("drive-queued", { worker: "lane-a", pr: 55 }); // unrelated kinds never match
  assert.equal(s.lastReviewerFallbackEvent("lane-a"), null);

  s.appendEvent("reviewer-fallback-switch", { worker: "lane-a", issue: 2, pr: 55, mode: "human", head: "H1" });
  s.appendEvent("reviewer-fallback-switch", { worker: "lane-b", issue: 3, pr: 56, mode: "same-model-trusted", head: "HX" });
  assert.deepEqual(s.lastReviewerFallbackEvent("lane-a"), { kind: "reviewer-fallback-switch", mode: "human", pr: 55, head: "H1" });

  // A later revert for the same lane supersedes the switch; lane-b's row is untouched.
  s.appendEvent("reviewer-fallback-revert", { worker: "lane-a", issue: 2, pr: 55, mode: "different-model-codex", head: "H1" });
  assert.deepEqual(s.lastReviewerFallbackEvent("lane-a"), {
    kind: "reviewer-fallback-revert",
    mode: "different-model-codex",
    pr: 55,
    head: "H1",
  });
  assert.deepEqual(s.lastReviewerFallbackEvent("lane-b"), {
    kind: "reviewer-fallback-switch",
    mode: "same-model-trusted",
    pr: 56,
    head: "HX",
  });
  s.close();
});

test("migration close/reopen: review_fallback_head/kind persist across an engine restart (DB-backed, not memory)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    s1.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
    s1.recordReviewFallback("a", "HEAD1", "same-model-trusted");
    s1.close();

    const s2 = new State(path);
    const row = s2.getWorker("a");
    assert.equal(row?.review_fallback_head, "HEAD1");
    assert.equal(row?.review_fallback_kind, "same-model-trusted");
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration close/reopen: review_triggered_head/at persist across an engine restart (DB-backed, not memory)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    s1.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 42 });
    s1.recordReviewTrigger("a", "HEAD1", "2026-07-07T08:00:00.000Z");
    s1.close();

    const s2 = new State(path); // "restart": a brand-new State instance, same on-disk DB
    const row = s2.getWorker("a");
    assert.equal(row?.review_triggered_head, "HEAD1");
    assert.equal(row?.review_triggered_at, "2026-07-07T08:00:00.000Z");
    assert.equal(row?.pr, 42);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events append in order", () => {
  const s = mem();
  s.appendEvent("dispatched", { issue: 2 });
  s.appendEvent("merged", { pr: 21 });
  assert.equal(s.getWorker("nope"), undefined);
  s.close();
});

test("re-opening an already-migrated DB is a no-op (idempotent)", () => {
  // A second migrate() pass over the same in-memory handle would re-run; instead prove
  // the guard: opening when user_version == SCHEMA_VERSION applies nothing.
  const s = mem();
  const v = s.userVersion();
  assert.equal(v, SCHEMA_VERSION);
  s.close();
});

// ── #14: engine cost ceiling + kill switch persistence ──────────────────────────────────

test("schema v2 adds the #14 ceiling tables (spend_ledger, engine_session, ceiling_breach)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 2);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("recordSpend + dailySpendUsd: sums only rows on the query's UTC calendar day", () => {
  const s = mem();
  s.recordSpend("lane-a", 1, 5, "2026-07-06T01:00:00.000Z");
  s.recordSpend("lane-b", 2, 7, "2026-07-06T23:59:00.000Z");
  s.recordSpend("lane-c", 3, 100, "2026-07-05T23:00:00.000Z"); // a different day — excluded
  assert.equal(s.dailySpendUsd(new Date("2026-07-06T12:00:00Z")), 12);
  assert.equal(s.dailySpendUsd(new Date("2026-07-05T12:00:00Z")), 100);
  assert.equal(s.dailySpendUsd(new Date("2026-07-07T00:00:00Z")), 0); // no spend that day
  s.close();
});

test("recordSpend clamps negative/non-finite cost: the safety accumulator can only grow (gate② PR #41 P3)", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  s.recordSpend("lane-a", 1, 3, day);
  s.recordSpend("lane-b", 2, -5, day); // negative must NOT subtract from the daily sum
  s.recordSpend("lane-c", 3, NaN, day);
  s.recordSpend("lane-d", 4, Infinity, day);
  s.recordSpend("lane-e", 5, -Infinity, day);
  assert.equal(s.dailySpendUsd(new Date(day)), 3); // only the legitimate positive spend counts
  s.close();
});

// ── #172: resumed total_cost_usd is empirically PER-LEG; same-name terminal rows sum directly ──

test("spentUsdForWorker: 0 for a name with no ledger rows yet", () => {
  const s = mem();
  assert.equal(s.spentUsdForWorker("lane-fresh"), 0);
  s.close();
});

test("recordSpend: a SECOND per-leg call for the SAME worker name is recorded directly", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  s.recordSpend("lane-a", 1, 3, day); // pre-handoff: $3
  assert.equal(s.spentUsdForWorker("lane-a"), 3);
  s.recordSpend("lane-a", 1, 2, day); // resumed leg reports its own $2 directly
  assert.equal(s.spentUsdForWorker("lane-a"), 5);
  assert.equal(s.dailySpendUsd(new Date(day)), 5);
  s.close();
});

test("recordSpend: multiple resumed legs on the same name sum their per-leg reports", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  s.recordSpend("lane-a", 1, 3, day);
  s.recordSpend("lane-a", 1, 2, day);
  s.recordSpend("lane-a", 1, 4, day);
  assert.equal(s.spentUsdForWorker("lane-a"), 9);
  assert.equal(s.dailySpendUsd(new Date(day)), 9);
  s.close();
});

test("recordSpend: equal/lower positive per-leg reports are legitimate spend and never subtracted", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  s.recordSpend("lane-a", 1, 5, day);
  s.recordSpend("lane-a", 1, 5, day);
  s.recordSpend("lane-a", 1, 2, day);
  assert.equal(s.spentUsdForWorker("lane-a"), 12);
  assert.equal(s.dailySpendUsd(new Date(day)), 12);
  s.close();
});

test("recordSpend: different worker names remain independent", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  s.recordSpend("lane-a", 1, 10, day);
  s.recordSpend("lane-b", 2, 4, day); // a fresh name -> full amount, unaffected by lane-a's ledger
  assert.equal(s.spentUsdForWorker("lane-b"), 4);
  assert.equal(s.dailySpendUsd(new Date(day)), 14);
  s.close();
});

test("#154 maxSpendLedgerId: 0 on an empty ledger; a captured cursor excludes everything ledgered before it and includes everything after", () => {
  const s = mem();
  const day = "2026-07-06T12:00:00.000Z";
  assert.equal(s.maxSpendLedgerId(), 0); // fresh ledger, nothing recorded yet
  s.recordSpend("lane-a", 1, 10, day); // "prior run" spend
  s.recordSpend("lane-b", 2, 4, day);
  const anchor = s.maxSpendLedgerId(); // captured "at engine startup" for a NEW run
  assert.equal(s.spentUsdAfterId(anchor), 0); // nothing new yet — the prior spend is excluded
  s.recordSpend("lane-c", 3, 6, day); // "this run's" own spend
  assert.equal(s.spentUsdAfterId(anchor), 6); // only the post-anchor row counts
  s.close();
});

test("per-leg resume accounting survives an engine restart between handoff and resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const day = "2026-07-06T12:00:00.000Z";
    const s1 = new State(path);
    s1.recordSpend("lane-a", 1, 3, day); // pre-handoff, then the engine restarts
    s1.close();

    const s2 = new State(path); // "restart": a brand-new State instance, same on-disk ledger
    assert.equal(s2.spentUsdForWorker("lane-a"), 3);
    s2.recordSpend("lane-a", 1, 2, day); // resumed leg's own report
    assert.equal(s2.spentUsdForWorker("lane-a"), 5);
    assert.equal(s2.dailySpendUsd(new Date(day)), 5);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engineSessionStart: continuous ticking keeps the original session start", () => {
  const s = mem();
  const gap = 900;
  const t0 = s.engineSessionStart(new Date("2026-07-06T00:00:00Z"), gap);
  assert.equal(t0.toISOString(), "2026-07-06T00:00:00.000Z");
  // Ticks every 5 minutes (under the 15-min gap): the session start never moves, so
  // wall-clock elapsed keeps accumulating — a live engine cannot self-reset the cap.
  assert.equal(s.engineSessionStart(new Date("2026-07-06T00:05:00Z"), gap).toISOString(), "2026-07-06T00:00:00.000Z");
  assert.equal(s.engineSessionStart(new Date("2026-07-06T00:10:00Z"), gap).toISOString(), "2026-07-06T00:00:00.000Z");
  assert.equal(s.engineSessionStart(new Date("2026-07-06T00:14:00Z"), gap).toISOString(), "2026-07-06T00:00:00.000Z");
  s.close();
});

test("engineSessionStart: a tick gap past staleGapSec (engine stopped/paused) RESETS the session (Codex PR #41 R2 P1)", () => {
  const s = mem();
  const gap = 900;
  s.engineSessionStart(new Date("2026-07-06T00:00:00Z"), gap);
  s.engineSessionStart(new Date("2026-07-06T00:05:00Z"), gap); // still the same session
  // 16 minutes of silence (> 900s): the engine was down/paused — new session, fresh start.
  const restarted = s.engineSessionStart(new Date("2026-07-06T00:21:01Z"), gap);
  assert.equal(restarted.toISOString(), "2026-07-06T00:21:01.000Z");
  // Exactly-at-gap is NOT stale (same ">" convention as budgetExceeded).
  const next = s.engineSessionStart(new Date("2026-07-06T00:36:01Z"), gap); // +900s exactly
  assert.equal(next.toISOString(), "2026-07-06T00:21:01.000Z"); // still the same session
  s.close();
});

test("recordCeilingBreach: first detection sticks (INSERT OR IGNORE) — a re-detect does not reset `at`", () => {
  const s = mem();
  s.recordCeilingBreach(["daily-budget"], new Date("2026-07-06T00:00:00Z"));
  s.recordCeilingBreach(["daily-budget", "wall-clock"], new Date("2026-07-06T01:00:00Z")); // later tick, still breached
  const b = s.ceilingBreach();
  assert.deepEqual(b?.reasons, ["daily-budget"]); // original reasons, not overwritten
  assert.equal(b?.at.toISOString(), "2026-07-06T00:00:00.000Z"); // original "at", not reset
  s.close();
});

test("clearCeilingBreach: resolves the breach so a later re-breach starts a fresh drain window", () => {
  const s = mem();
  s.recordCeilingBreach(["kill-switch"], new Date("2026-07-06T00:00:00Z"));
  assert.ok(s.ceilingBreach() !== null);
  s.clearCeilingBreach();
  assert.equal(s.ceilingBreach(), null);
  s.close();
});

test("kill switch: in-memory State has no data dir -> always inactive", () => {
  const s = mem();
  assert.equal(s.killSwitchPath(), null);
  assert.equal(s.isKillSwitchActive(), false);
  s.close();
});

test("kill switch: a file sentinel in the engine's own data dir flips it, human-flippable, no config touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    assert.equal(s.isKillSwitchActive(), false);
    const p = s.killSwitchPath();
    // biome-ignore lint/complexity/useOptionalChain: the assertion deliberately requires a non-null sentinel path.
    assert.ok(p && p.startsWith(dir)); // lives in the engine's OWN data dir
    writeFileSync(p!, "");
    assert.equal(s.isKillSwitchActive(), true);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause (#75): in-memory State has no data dir -> always inactive", () => {
  const s = mem();
  assert.equal(s.pausePath(), null);
  assert.equal(s.isPauseActive(), false);
  s.close();
});

test("pause (#75): a file sentinel in the engine's own data dir flips it, human-flippable, no config touched; independent of the kill switch", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    assert.equal(s.isPauseActive(), false);
    const p = s.pausePath();
    // biome-ignore lint/complexity/useOptionalChain: the assertion deliberately requires a non-null sentinel path.
    assert.ok(p && p.startsWith(dir)); // lives in the engine's OWN data dir
    assert.notEqual(p, s.killSwitchPath()); // distinct sentinel from KILL_SWITCH
    writeFileSync(p!, "");
    assert.equal(s.isPauseActive(), true);
    assert.equal(s.isKillSwitchActive(), false); // pause never implies kill
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #31: double-failure rollback/requeue hardening — pending_rollbacks ─────────────────────

test("schema v4 adds pending_rollbacks (#31)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 4);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("pendingRollbacks: add/bump/clear round-trip", () => {
  const s = mem();
  const id = s.addPendingRollback(7, "ready", "dispatch-rollback", "2026-07-06T00:00:00.000Z");
  let rows = s.pendingRollbacks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.issue, 7);
  assert.equal(rows[0]?.target, "ready");
  assert.equal(rows[0]?.reason, "dispatch-rollback");
  assert.equal(rows[0]?.attempts, 0);
  assert.equal(rows[0]?.created_at, "2026-07-06T00:00:00.000Z");
  assert.equal(rows[0]?.last_attempt_at, null);

  s.bumpPendingRollback(id, "2026-07-06T00:05:00.000Z");
  rows = s.pendingRollbacks();
  assert.equal(rows[0]?.attempts, 1);
  assert.equal(rows[0]?.last_attempt_at, "2026-07-06T00:05:00.000Z");

  s.clearPendingRollback(id);
  assert.equal(s.pendingRollbacks().length, 0);
  s.close();
});

test("pendingRollbacks: returns rows oldest-first (retry order) across multiple issues", () => {
  const s = mem();
  s.addPendingRollback(9, "ready", "dead-lane-requeue", "t1");
  s.addPendingRollback(2, "ready", "dispatch-rollback", "t2");
  assert.deepEqual(
    s.pendingRollbacks().map((r) => r.issue),
    [9, 2],
  );
  s.close();
});

test("pending_rollbacks persists across close/reopen (an engine restart mid-recovery does not lose the retry marker)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    s1.addPendingRollback(9, "ready", "dead-lane-requeue", "2026-07-06T00:00:00.000Z");
    s1.close();

    const s2 = new State(path);
    const rows = s2.pendingRollbacks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.issue, 9);
    assert.equal(rows[0]?.reason, "dead-lane-requeue");
    assert.equal(rows[0]?.attempts, 0);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #47: cost telemetry — model + categorized token usage in spend_ledger ─────────────────

/** Raw spend_ledger rows for a worker, read via a second connection (WAL allows concurrent
 *  reads) — asserts the on-disk columns directly rather than adding a State query method
 *  purely for test introspection. */
function rawSpendRows(
  path: string,
  worker: string,
): Array<{
  usd: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}> {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("SELECT * FROM spend_ledger WHERE worker = ? ORDER BY id").all(worker) as unknown as Array<{
      usd: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }>;
  } finally {
    raw.close();
  }
}

test("schema v5 adds model + token columns to spend_ledger (#47)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 5);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("recordSpend: omitted models -> single 'unknown' row with 0 tokens (pre-#47 callers unaffected)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s = new State(path);
    s.recordSpend("lane-a", 1, 5, "2026-07-06T00:00:00.000Z"); // no 5th arg — legacy call shape
    const rows = rawSpendRows(path, "lane-a");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.usd, 5);
    assert.equal(rows[0]?.model, "unknown");
    assert.equal(rows[0]?.input_tokens, 0);
    assert.equal(rows[0]?.output_tokens, 0);
    assert.equal(rows[0]?.cache_read_tokens, 0);
    assert.equal(rows[0]?.cache_creation_tokens, 0);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordSpend: one row per model, full usd on the first row, 0 on the rest — daily-cap SUM unaffected", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s = new State(path);
    const models: ModelUsageEntry[] = [
      { model: "claude-opus-4-6", inputTokens: 100, outputTokens: 200, cacheReadTokens: 30, cacheCreationTokens: 10 },
      { model: "claude-sonnet-4-6", inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ];
    s.recordSpend("lane-multi", 1, 12.5, "2026-07-06T00:00:00.000Z", models);
    const rows = rawSpendRows(path, "lane-multi");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.model, "claude-opus-4-6");
    assert.equal(rows[0]?.usd, 12.5);
    assert.equal(rows[0]?.input_tokens, 100);
    assert.equal(rows[0]?.cache_read_tokens, 30);
    assert.equal(rows[1]?.model, "claude-sonnet-4-6");
    assert.equal(rows[1]?.usd, 0); // no fabricated per-model split — the total lands on row 0
    assert.equal(rows[1]?.output_tokens, 7);
    // The existing daily-cap query is a straight SUM(usd) — untouched by the extra rows/columns.
    assert.equal(s.dailySpendUsd(new Date("2026-07-06T12:00:00Z")), 12.5);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordSpend: negative/non-finite token counts clamp to 0 (same defense-in-depth as usd)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s = new State(path);
    s.recordSpend("lane-bad", 1, 1, "2026-07-06T00:00:00.000Z", [
      { model: "m", inputTokens: -5, outputTokens: NaN, cacheReadTokens: Infinity, cacheCreationTokens: 3.9 },
    ]);
    const rows = rawSpendRows(path, "lane-bad");
    assert.equal(rows[0]?.input_tokens, 0);
    assert.equal(rows[0]?.output_tokens, 0);
    assert.equal(rows[0]?.cache_read_tokens, 0);
    assert.equal(rows[0]?.cache_creation_tokens, 3); // floored, not rounded
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spend_ledger model/token columns persist across close/reopen (schema-migration + data survive an engine restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    s1.recordSpend("lane-a", 1, 8, "2026-07-06T00:00:00.000Z", [
      { model: "claude-sonnet-4-6", inputTokens: 40, outputTokens: 60, cacheReadTokens: 15, cacheCreationTokens: 5 },
    ]);
    s1.close();

    const s2 = new State(path); // re-migrating an already-current DB must be a no-op (idempotent)
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    const rows = rawSpendRows(path, "lane-a");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, "claude-sonnet-4-6");
    assert.equal(rows[0]?.usd, 8);
    assert.equal(rows[0]?.input_tokens, 40);
    assert.equal(rows[0]?.output_tokens, 60);
    assert.equal(rows[0]?.cache_read_tokens, 15);
    assert.equal(rows[0]?.cache_creation_tokens, 5);
    assert.equal(s2.dailySpendUsd(new Date("2026-07-06T12:00:00Z")), 8);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #155: per-probe lane telemetry (priced-cost snapshot, context size, token composition) ──

test("fresh DB migrates to a schema version that includes per-probe lane telemetry columns (#155)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 11);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("a pre-existing worker row (upserted with no telemetry fields, e.g. a row predating #155) reads est_cost_usd/context_tokens/token_composition as null — nullable/defaulted, upsertWorker never touches them", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  const row = s.getWorker("a");
  assert.equal(row?.est_cost_usd, null);
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);
  // A later, unrelated upsertWorker call (e.g. a state transition) must not touch these columns
  // either — they are managed EXCLUSIVELY via setLiveTelemetry/clearLiveTelemetry, never
  // upsertWorker's generic column list (the crash-rerun / stale-spread hazard those two
  // dedicated methods exist to avoid).
  s.upsertWorker({ ...row!, state: "driving", pr: 5 });
  const after = s.getWorker("a");
  assert.equal(after?.est_cost_usd, null);
  assert.equal(after?.context_tokens, null);
  assert.equal(after?.token_composition, null);
  s.close();
});

test("setLiveTelemetry: persists the trio (JSON-encoded tokenComposition), update-in-place — re-probing the same lane just overwrites, no history", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.setLiveTelemetry("a", {
    estCostUsd: 0.12,
    contextTokens: 41000,
    tokenComposition: { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 90000, cacheCreationTokens: 4000 },
  });
  const row = s.getWorker("a");
  assert.equal(row?.est_cost_usd, 0.12);
  assert.equal(row?.context_tokens, 41000);
  assert.deepEqual(JSON.parse(row!.token_composition!), {
    inputTokens: 12000,
    outputTokens: 3000,
    cacheReadTokens: 90000,
    cacheCreationTokens: 4000,
  });

  // A second probe's numbers simply overwrite — contextTokens is deliberately allowed to DROP
  // (an auto-compact), never accumulated/maxed.
  s.setLiveTelemetry("a", {
    estCostUsd: 0.15,
    contextTokens: 500,
    tokenComposition: { inputTokens: 12500, outputTokens: 3100, cacheReadTokens: 90000, cacheCreationTokens: 4000 },
  });
  const after = s.getWorker("a");
  assert.equal(after?.est_cost_usd, 0.15);
  assert.equal(after?.context_tokens, 500);
  assert.deepEqual(JSON.parse(after!.token_composition!).inputTokens, 12500);
  // Other columns (state, pr, etc.) are untouched by setLiveTelemetry.
  assert.equal(after?.state, "running");
  s.close();
});

test("clearLiveTelemetry: nulls all three columns; idempotent on a row that never had telemetry", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.setLiveTelemetry("a", {
    estCostUsd: 0.5,
    contextTokens: 100,
    tokenComposition: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 },
  });
  s.clearLiveTelemetry("a");
  const row = s.getWorker("a");
  assert.equal(row?.est_cost_usd, null);
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);

  // Idempotent: clearing again (e.g. a lane that never had telemetry, or a double-reclaim) is a
  // no-op, never throws.
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "running", started_at: "t", ended_at: null });
  s.clearLiveTelemetry("b");
  const untouched = s.getWorker("b");
  assert.equal(untouched?.est_cost_usd, null);
  assert.equal(untouched?.context_tokens, null);
  assert.equal(untouched?.token_composition, null);
  s.close();
});

test("live telemetry persists across close/reopen (DB-backed, not memory) — a restart doesn't lose a live lane's last-known trio", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    s1.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
    s1.setLiveTelemetry("a", {
      estCostUsd: 0.42,
      contextTokens: 8000,
      tokenComposition: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 10 },
    });
    s1.close();

    const s2 = new State(path);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    const row = s2.getWorker("a");
    assert.equal(row?.est_cost_usd, 0.42);
    assert.equal(row?.context_tokens, 8000);
    assert.deepEqual(JSON.parse(row!.token_composition!), {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheCreationTokens: 10,
    });
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #86: rounds ledger (round-loop skeleton) ──────────────────────────────────────────────

test("backfillLegacyRoundCursors (#123, Codex round-5 P2): a pre-migration in_progress round gets timestamp-approximate cursors, never whole-history 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  const path = join(dir, "s.sqlite");
  try {
    const s = new State(path);
    // Pre-round ledger rows (their ts is strictly before the round's future started_at)…
    s.appendEvent("merged", { worker: "lane-old", issue: 1, pr: 2, headOid: "h" });
    s.recordSpend("lane-old", 1, 9, new Date().toISOString());
    // …then a round that startRound stamps correctly.
    const round = s.startRound(new Date(Date.now() + 60_000).toISOString());
    s.close();

    // Simulate the legacy (pre-v10) shape: cursors zeroed, as if the columns were just added.
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE rounds SET start_event_id = 0, start_spend_id = 0");
    backfillLegacyRoundCursors(raw);
    const row = raw.prepare("SELECT start_event_id, start_spend_id FROM rounds WHERE round_id = ?").get(round.round_id) as {
      start_event_id: number;
      start_spend_id: number;
    };
    raw.close();
    // The pre-round event/spend row ids are the cursors again — the resumed round's artifact
    // window starts after them, never at the whole-history 0.
    assert.ok(row.start_event_id >= 1, "event cursor covers the pre-round event");
    assert.ok(row.start_spend_id >= 1, "spend cursor covers the pre-round spend row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh DB migrates to a schema version that includes the rounds table (#86)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 8);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("fresh DB migrates to a schema version that includes gated-PR reentry columns (#147)", () => {
  const s = mem();
  assert.ok(SCHEMA_VERSION >= 9);
  assert.equal(s.userVersion(), SCHEMA_VERSION);
  s.close();
});

test("startRound: creates a round in phase 'aligning', status 'in_progress', no marker", () => {
  const s = mem();
  const r = s.startRound("2026-07-09T00:00:00.000Z");
  assert.equal(r.phase, "aligning");
  assert.equal(r.status, "in_progress");
  assert.equal(r.artifact_ref, null);
  assert.equal(r.started_at, "2026-07-09T00:00:00.000Z");
  assert.equal(r.updated_at, "2026-07-09T00:00:00.000Z");
  assert.equal(r.ended_at, null);
  assert.ok(r.round_id >= 1);
  s.close();
});

test("openRound: returns the most recent in_progress round, undefined once none are open", () => {
  const s = mem();
  assert.equal(s.openRound(), undefined);
  const r1 = s.startRound("2026-07-09T00:00:00.000Z");
  assert.equal(s.openRound()?.round_id, r1.round_id);
  s.closeRound(r1.round_id, "2026-07-09T00:05:00.000Z");
  assert.equal(s.openRound(), undefined); // closed -> no longer "open"
  const r2 = s.startRound("2026-07-09T00:10:00.000Z");
  assert.equal(s.openRound()?.round_id, r2.round_id); // the newer one
  s.close();
});

test("advanceRoundPhase: updates phase + updated_at and CLEARS artifact_ref (a new phase starts markerless)", () => {
  const s = mem();
  const r = s.startRound("2026-07-09T00:00:00.000Z");
  s.setRoundMarker(r.round_id, "m1");
  assert.equal(s.getRound(r.round_id)?.artifact_ref, "m1");
  s.advanceRoundPhase(r.round_id, "architecting", "2026-07-09T00:01:00.000Z");
  const row = s.getRound(r.round_id);
  assert.equal(row?.phase, "architecting");
  assert.equal(row?.updated_at, "2026-07-09T00:01:00.000Z");
  assert.equal(row?.artifact_ref, null); // cleared, not carried over
  s.close();
});

test("setRoundMarker: persists a phase stub's idempotency token without changing phase", () => {
  const s = mem();
  const r = s.startRound("2026-07-09T00:00:00.000Z");
  s.setRoundMarker(r.round_id, "issue-42-comment-posted");
  const row = s.getRound(r.round_id);
  assert.equal(row?.artifact_ref, "issue-42-comment-posted");
  assert.equal(row?.phase, "aligning"); // unchanged
  s.close();
});

test("closeRound: sets phase 'closed', status 'done', ended_at", () => {
  const s = mem();
  const r = s.startRound("2026-07-09T00:00:00.000Z");
  s.closeRound(r.round_id, "2026-07-09T00:30:00.000Z");
  const row = s.getRound(r.round_id);
  assert.equal(row?.phase, "closed");
  assert.equal(row?.status, "done");
  assert.equal(row?.ended_at, "2026-07-09T00:30:00.000Z");
  s.close();
});

test("rounds row persists across close/reopen (DB-backed, not memory) — crash-rerun's data foundation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const s1 = new State(path);
    const r = s1.startRound("2026-07-09T00:00:00.000Z");
    s1.advanceRoundPhase(r.round_id, "plan_review", "2026-07-09T00:02:00.000Z");
    s1.setRoundMarker(r.round_id, "plan-review-comment-1");
    s1.close();

    const s2 = new State(path); // re-migrating an already-current DB must be a no-op (idempotent)
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    const row = s2.openRound();
    assert.equal(row?.round_id, r.round_id);
    assert.equal(row?.phase, "plan_review");
    assert.equal(row?.status, "in_progress");
    assert.equal(row?.artifact_ref, "plan-review-comment-1");
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #91: eventsSince / spentUsdSince (harvest/retro round-ledger reads) ────────────────────

test("eventsSince: filters by kind AND ts cutoff, chronological order, parsed payload", () => {
  const s = mem();
  s.appendEvent("dispatched", { worker: "lane-a", issue: 1 });
  s.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  s.appendEvent("drive-needs-human", { worker: "lane-b", issue: 2, pr: 11, reason: "changes requested" });
  const rows = s.eventsSince("2020-01-01T00:00:00.000Z", ["merged", "drive-needs-human"]);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["merged", "drive-needs-human"],
  ); // "dispatched" excluded
  assert.deepEqual(rows[0]!.payload, { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  s.close();
});

test("eventsSince: a sinceIso cutoff after an event's ts excludes it (round-window scoping)", () => {
  const s = mem();
  s.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10 });
  // Every appendEvent call stamps `new Date().toISOString()` — a cutoff far in the future
  // excludes everything already recorded, exactly like a later round's own window would.
  const rows = s.eventsSince("2999-01-01T00:00:00.000Z", ["merged"]);
  assert.deepEqual(rows, []);
  s.close();
});

test("eventsSince: empty kinds list throws (caller bug, not a runtime condition)", () => {
  const s = mem();
  assert.throws(() => s.eventsSince("2020-01-01T00:00:00.000Z", []), /kinds must be non-empty/);
  s.close();
});

test("spentUsdSince: sums spend_ledger rows at or after the cutoff, excludes earlier rows", () => {
  const s = mem();
  s.recordSpend("lane-a", 1, 5, "2026-07-06T00:00:00.000Z");
  s.recordSpend("lane-b", 2, 7, "2026-07-06T01:00:00.000Z");
  s.recordSpend("lane-c", 3, 100, "2026-07-05T23:00:00.000Z"); // before the cutoff — excluded
  assert.equal(s.spentUsdSince("2026-07-06T00:00:00.000Z"), 12);
  assert.equal(s.spentUsdSince("2999-01-01T00:00:00.000Z"), 0);
  s.close();
});

// ── #168: environment-failure park (per-source episodes — PR #180 review P1-1a) ─────────────

test("park: not parked initially; enterPark persists source/reason/triggerIssue/enteredAt and seeds lastProbeAt (P1-1c: first probe waits a full backoff)", () => {
  const s = mem();
  assert.equal(s.isParked(), false);
  assert.deepEqual(s.parkedSources(), []);
  assert.equal(s.parkRow("llm"), null);
  const inserted = s.enterPark("llm", "rate_limit_error seen", 42, "2026-07-14T00:00:00Z");
  assert.equal(inserted, true);
  assert.equal(s.isParked(), true);
  const p = s.parkRow("llm");
  assert.equal(p?.source, "llm");
  assert.equal(p?.reason, "rate_limit_error seen");
  assert.equal(p?.triggerIssue, 42);
  assert.equal(p?.enteredAt, "2026-07-14T00:00:00Z");
  assert.equal(p?.lastProbeAt, "2026-07-14T00:00:00Z"); // seeded, NOT null — first wait = base backoff
  assert.equal(p?.probeAttempts, 0);
  assert.equal(p?.escalatedAt, null);
  assert.equal(p?.canaryWorker, null);
  s.close();
});

test("park: re-entering the SAME source is a no-op (first detection wins, enteredAt never resets — storm-safe)", () => {
  const s = mem();
  s.enterPark("llm", "first reason", 1, "2026-07-14T00:00:00Z");
  const insertedAgain = s.enterPark("llm", "a later llm failure", 2, "2026-07-14T01:00:00Z");
  assert.equal(insertedAgain, false);
  const p = s.parkRow("llm");
  assert.equal(p?.reason, "first reason");
  assert.equal(p?.triggerIssue, 1);
  assert.equal(p?.enteredAt, "2026-07-14T00:00:00Z");
  s.close();
});

test("park: a DIFFERENT source while parked opens its OWN episode (mixed storm) — resume only at zero rows (P1-1a: the old singleton silently dropped this)", () => {
  const s = mem();
  s.enterPark("llm", "rate_limit_error", 1, "2026-07-14T00:00:00Z");
  const forgeInserted = s.enterPark("forge", "could not resolve host", 2, "2026-07-14T00:30:00Z");
  assert.equal(forgeInserted, true); // NOT dropped
  assert.equal(s.parkedSources().length, 2);
  assert.deepEqual(
    s.parkedSources().map((p) => p.source),
    ["llm", "forge"],
  ); // oldest first
  // Clearing one source alone does NOT resume the engine.
  s.clearPark("forge");
  assert.equal(s.isParked(), true);
  s.clearPark("llm");
  assert.equal(s.isParked(), false);
  s.close();
});

test("park: bumpParkProbe grows attempts + stamps lastProbeAt; touchParkProbe stamps WITHOUT growing (canary pacing, P1-1b)", () => {
  const s = mem();
  s.enterPark("forge", "reason", null, "2026-07-14T00:00:00Z");
  s.bumpParkProbe("forge", "2026-07-14T00:00:30Z");
  let p = s.parkRow("forge");
  assert.equal(p?.probeAttempts, 1);
  assert.equal(p?.lastProbeAt, "2026-07-14T00:00:30Z");
  s.touchParkProbe("forge", "2026-07-14T00:01:00Z");
  p = s.parkRow("forge");
  assert.equal(p?.probeAttempts, 1); // unchanged — touch never grows the exponent
  assert.equal(p?.lastProbeAt, "2026-07-14T00:01:00Z");
  assert.equal(s.isParked(), true);
  s.close();
});

test("park: setParkCanary round-trips the in-flight canary lane name; bump/touch never disturb it", () => {
  const s = mem();
  s.enterPark("llm", "reason", 7, "2026-07-14T00:00:00Z");
  s.setParkCanary("llm", "lane-3");
  assert.equal(s.parkRow("llm")?.canaryWorker, "lane-3");
  s.touchParkProbe("llm", "2026-07-14T00:01:00Z");
  s.bumpParkProbe("llm", "2026-07-14T00:02:00Z");
  assert.equal(s.parkRow("llm")?.canaryWorker, "lane-3");
  s.setParkCanary("llm", null);
  assert.equal(s.parkRow("llm")?.canaryWorker, null);
  s.close();
});

test("park (P2-A): registerCanaryDispatch is ATOMIC — worker row + canary assignment + events land together; a missing episode rolls the WHOLE registration back (partial state unrepresentable)", () => {
  const s = mem();
  // Happy path: one call, everything lands.
  s.enterPark("llm", "rate_limit_error", 42, "2026-07-14T00:00:00Z");
  s.registerCanaryDispatch(
    { name: "lane-1", issue: 42, session_id: "sess-1", state: "running", started_at: "2026-07-14T00:01:00Z", ended_at: null },
    "llm",
  );
  assert.equal(s.getWorker("lane-1")?.state, "running");
  assert.equal(s.parkRow("llm")?.canaryWorker, "lane-1");
  assert.equal(s.eventsSince("2020-01-01T00:00:00Z", ["dispatched"]).length, 1);
  assert.equal(s.eventsSince("2020-01-01T00:00:00Z", ["park-canary"]).length, 1);

  // Unrepresentable partial state: registering against a MISSING episode throws and leaves NO
  // worker row and NO events — the crash-window shape (worker row present, canary_worker null)
  // cannot be produced through this method.
  s.clearPark("llm");
  assert.throws(
    () =>
      s.registerCanaryDispatch(
        { name: "lane-2", issue: 43, session_id: "sess-2", state: "running", started_at: "2026-07-14T00:02:00Z", ended_at: null },
        "llm",
      ),
    /no open llm park episode/,
  );
  assert.equal(s.getWorker("lane-2"), undefined, "the worker row rolled back with the failed canary assignment");
  assert.equal(s.eventsSince("2020-01-01T00:00:00Z", ["dispatched"]).length, 1, "no orphan events either");
  s.close();
});

test("park: a fresh episode after clearPark starts with its own clean enteredAt/probeAttempts", () => {
  const s = mem();
  s.enterPark("llm", "first episode", 1, "2026-07-14T00:00:00Z");
  s.bumpParkProbe("llm", "2026-07-14T00:00:30Z");
  s.clearPark("llm");
  const inserted = s.enterPark("llm", "second episode", 2, "2026-07-14T02:00:00Z");
  assert.equal(inserted, true); // a genuinely fresh episode, not blocked by the old (cleared) row
  const p = s.parkRow("llm");
  assert.equal(p?.reason, "second episode");
  assert.equal(p?.enteredAt, "2026-07-14T02:00:00Z");
  assert.equal(p?.probeAttempts, 0);
  s.close();
});

test("park: recordParkEscalation is a per-source one-way latch, independent of continued probing", () => {
  const s = mem();
  s.enterPark("forge", "reason", null, "2026-07-14T00:00:00Z");
  s.enterPark("llm", "reason2", null, "2026-07-14T00:10:00Z");
  assert.equal(s.parkRow("forge")?.escalatedAt, null);
  s.recordParkEscalation("forge", "2026-07-14T01:00:00Z");
  assert.equal(s.parkRow("forge")?.escalatedAt, "2026-07-14T01:00:00Z");
  assert.equal(s.parkRow("llm")?.escalatedAt, null); // per-source: llm untouched
  // Probing continues unaffected — escalation is additive, never a state transition.
  s.bumpParkProbe("forge", "2026-07-14T01:00:30Z");
  assert.equal(s.parkRow("forge")?.escalatedAt, "2026-07-14T01:00:00Z"); // unchanged
  assert.equal(s.parkRow("forge")?.probeAttempts, 1);
  s.close();
});

test("park: in-memory State has no data dir -> escalationMarkerPath is null; writeEscalationMarker is a safe no-op", () => {
  const s = mem();
  assert.equal(s.escalationMarkerPath(), null);
  assert.doesNotThrow(() => s.writeEscalationMarker({ hello: "world" }));
  assert.doesNotThrow(() => s.clearEscalationMarker());
  s.close();
});

test("park: escalation marker is written to the engine's own data dir; clearing the LAST episode auto-removes it (P2-2 — the wired clear), an earlier clear leaves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    const p = s.escalationMarkerPath();
    // biome-ignore lint/complexity/useOptionalChain: the assertion deliberately requires a non-null marker path.
    assert.ok(p && p.startsWith(dir));
    assert.notEqual(p, s.killSwitchPath());
    assert.notEqual(p, s.pausePath());
    s.enterPark("forge", "gh outage", null, "2026-07-14T00:00:00Z");
    s.enterPark("llm", "rate limited", null, "2026-07-14T00:01:00Z");
    s.writeEscalationMarker({ source: "forge", reason: "gh outage" });
    const written = JSON.parse(readFileSync(p!, "utf8"));
    assert.equal(written.source, "forge");
    // Clearing ONE of TWO episodes keeps the marker (the outage it describes isn't over).
    s.clearPark("forge");
    assert.equal(existsSync(p!), true);
    // Clearing the LAST episode removes it — no stale ESCALATION file after full resume.
    s.clearPark("llm");
    assert.equal(existsSync(p!), false);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #172: REAL v12 -> v13 migration — data survives, resume columns land ──

test("migration v12->v13: a populated v12 DB opens with data intact, resume defaults, user_version 13, and idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    // Build a REAL v12 DB: run the shipped migrations 0..11 exactly as that engine would have.
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 12; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 12");
    // Populate representative rows across the v12 tables.
    raw
      .prepare(
        "INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr, gated_reentry_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("lane-v12", 9, "sess-9", "handoff", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z", 55, 1);
    raw
      .prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)")
      .run("2026-07-01T00:30:00Z", "dispatched", JSON.stringify({ worker: "lane-v12", issue: 9 }));
    raw
      .prepare(
        "INSERT INTO spend_ledger (ts, worker, issue, usd, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("2026-07-01T01:00:00Z", "lane-v12", 9, 1.25, "opus", 10, 20, 0, 0);
    raw
      .prepare("INSERT INTO pending_rollbacks (issue, target, reason, attempts, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(9, "ready", "dead-lane-requeue", "2026-07-01T01:00:00Z");
    assert.doesNotThrow(() => raw.prepare("SELECT * FROM park_state").get());
    assert.throws(() => raw.prepare("SELECT resume_attempts FROM workers").get());
    raw.close();

    // Open with the CURRENT engine -> migrates 12 -> 13.
    const s = new State(dbPath);
    assert.equal(s.userVersion(), 13);
    assert.equal(SCHEMA_VERSION, 13);
    // Pre-existing data survived intact.
    const w = s.getWorker("lane-v12");
    assert.equal(w?.issue, 9);
    assert.equal(w?.pr, 55);
    assert.equal(w?.gated_reentry_attempts, 1);
    assert.equal(w?.resume_attempts, 0);
    assert.equal(w?.resume_capped, 0);
    assert.equal(s.handoffWorkers().length, 1);
    assert.equal(s.spentUsdForWorker("lane-v12"), 1.25);
    assert.equal(s.pendingRollbacks().length, 1);
    assert.equal(s.eventsSince("2026-01-01T00:00:00Z", ["dispatched"]).length, 1);
    // The existing park state and API remain intact.
    assert.equal(s.isParked(), false);
    assert.deepEqual(s.parkedSources(), []);
    assert.equal(s.enterPark("forge", "post-migration episode", null, "2026-07-14T00:00:00Z"), true);
    assert.equal(s.parkRow("forge")?.reason, "post-migration episode");
    s.clearPark("forge");
    s.close();

    // Idempotent reopen: no re-migration, same version, same data.
    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), 13);
    assert.equal(s2.getWorker("lane-v12")?.issue, 9);
    assert.equal(s2.getWorker("lane-v12")?.resume_attempts, 0);
    assert.equal(s2.isParked(), false);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
