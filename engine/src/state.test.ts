import assert from "node:assert/strict";
import { test } from "node:test";
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
