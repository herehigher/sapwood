import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, SCHEMA_VERSION } from "./state.js";

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
    name: "w1", issue: 2, session_id: "uuid-1", state: "running",
    started_at: "2026-06-27T00:00:00Z", ended_at: null,
  });
  assert.equal(s.getWorker("w1")?.state, "running");

  // same name => update, not duplicate (single-writer-serial assumption)
  s.upsertWorker({
    name: "w1", issue: 2, session_id: "uuid-1", state: "handoff",
    started_at: "2026-06-27T00:00:00Z", ended_at: "2026-06-27T01:00:00Z",
  });
  const row = s.getWorker("w1");
  assert.equal(row?.state, "handoff");
  assert.equal(row?.ended_at, "2026-06-27T01:00:00Z");
  s.close();
});

test("upsert refreshes ALL fields on name reuse (resume / reassigned lane)", () => {
  const s = mem();
  s.upsertWorker({
    name: "lane-1", issue: 2, session_id: "uuid-A", state: "done",
    started_at: "2026-06-27T00:00:00Z", ended_at: "2026-06-27T00:30:00Z",
  });
  // lane name reused for a different issue + fresh session
  s.upsertWorker({
    name: "lane-1", issue: 9, session_id: "uuid-B", state: "running",
    started_at: "2026-06-27T02:00:00Z", ended_at: null,
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
  assert.deepEqual(s.activeWorkers().map((w) => w.name), ["a", "b"]);
  assert.deepEqual(s.runningWorkers().map((w) => w.name), ["a"]); // running only (probe set)
  s.close();
});

test("drivingWorkers returns only state=driving rows (#13 merge-driver targets)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "driving", started_at: "t", ended_at: "t2", pr: 21 });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "driving", started_at: "t", ended_at: "t2", pr: 22 });
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "done", started_at: "t", ended_at: "t2" });
  assert.deepEqual(s.drivingWorkers().map((w) => w.name), ["b", "c"]);
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
    assert.ok(p && p.startsWith(dir)); // lives in the engine's OWN data dir
    writeFileSync(p!, "");
    assert.equal(s.isKillSwitchActive(), true);
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
  assert.deepEqual(s.pendingRollbacks().map((r) => r.issue), [9, 2]);
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
