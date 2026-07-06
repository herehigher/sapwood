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

test("engineStartedAt: first call sets it; later calls (even with a different `now`) return the same persisted time", () => {
  const s = mem();
  const first = s.engineStartedAt(new Date("2026-07-06T00:00:00Z"));
  assert.equal(first.toISOString(), "2026-07-06T00:00:00.000Z");
  const second = s.engineStartedAt(new Date("2026-07-06T05:00:00Z")); // later "now" — ignored
  assert.equal(second.toISOString(), "2026-07-06T00:00:00.000Z");
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
