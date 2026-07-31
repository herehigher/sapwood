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
    review_covered_head: "OLD_HEAD",
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
  assert.equal(row?.review_covered_head, null);
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

// ── #245: fixing lane state ─────────────────────────────────────────────────────────────

test("activeWorkers extends to running + driving + fixing (#245 lane occupancy)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "driving", started_at: "t", ended_at: "t2", pr: 21 });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "fixing", started_at: "t", ended_at: null, pr: 22 });
  s.upsertWorker({ name: "d", issue: 4, session_id: "s4", state: "done", started_at: "t", ended_at: "t2" });
  s.upsertWorker({ name: "e", issue: 5, session_id: "s5", state: "handoff", started_at: "t", ended_at: "t2" });
  assert.deepEqual(
    s.activeWorkers().map((w) => w.name),
    ["a", "b", "c"],
  );
  s.close();
});

test("fixingWorkers returns only state=fixing rows, disjoint from drivingWorkers (#245: DRIVE loop must never scan a fixing lane)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 1 });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "fixing", started_at: "t", ended_at: null, pr: 2 });
  s.upsertWorker({ name: "c", issue: 3, session_id: "s3", state: "fixing", started_at: "t", ended_at: null, pr: 3 });
  assert.deepEqual(
    s.fixingWorkers().map((w) => w.name),
    ["b", "c"],
  );
  assert.deepEqual(
    s.drivingWorkers().map((w) => w.name),
    ["a"],
  );
  s.close();
});

test("reconcileWorkers includes fixing rows for startup reconciliation (#245: a live fix leg still owns its issue across a restart)", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "fixing", started_at: "t", ended_at: null, pr: 1 });
  s.upsertWorker({ name: "b", issue: 2, session_id: "s2", state: "done", started_at: "t", ended_at: "t2" });
  assert.deepEqual(
    s.reconcileWorkers().map((w) => w.name),
    ["a"],
  );
  s.close();
});

test("fix_rounds: independent of resume_attempts — bumping one never touches the other, and both persist across upserts", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: "t2", pr: 1 });
  const row = s.getWorker("a")!;
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.equal(row.resume_attempts ?? 0, 0);

  // Bump fix_rounds only.
  s.upsertWorker({ ...row, state: "fixing", fix_rounds: 1 });
  let updated = s.getWorker("a")!;
  assert.equal(updated.fix_rounds, 1);
  assert.equal(updated.resume_attempts ?? 0, 0);

  // Separately bump resume_attempts only — fix_rounds must not move.
  s.upsertWorker({ ...updated, resume_attempts: 3 });
  updated = s.getWorker("a")!;
  assert.equal(updated.fix_rounds, 1, "fix_rounds must not be disturbed by a resume_attempts-only write");
  assert.equal(updated.resume_attempts, 3);
  s.close();
});

test("fix_rounds: restart-safe — persists on disk across a State reopen (crash-rerun, #223 terminal-state atomicity pattern)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const s = new State(dbPath);
    s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "fixing", started_at: "t", ended_at: null, pr: 1, fix_rounds: 2 });
    s.close();

    const reopened = new State(dbPath);
    const row = reopened.getWorker("a");
    assert.equal(row?.fix_rounds, 2, "fix_rounds survives a crash/restart — never silently reset to 0");
    assert.equal(row?.state, "fixing");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(after?.review_trigger_generation, 1);
  assert.equal(after?.review_trigger_in_flight, 1);
  assert.equal(after?.review_covered_head, null);
  assert.equal(after?.pr, 42); // untouched by recordReviewTrigger
  assert.equal(after?.state, "driving");

  // A later push re-records a NEW head/time — recordReviewTrigger overwrites, not appends.
  s.recordReviewTrigger("a", "HEAD2", "2026-07-07T09:00:00.000Z");
  const after2 = s.getWorker("a");
  assert.equal(after2?.review_triggered_head, "HEAD2");
  assert.equal(after2?.review_triggered_at, "2026-07-07T09:00:00.000Z");
  assert.equal(after2?.review_trigger_generation, 2);
  s.close();
});

test("#273 review pin metadata persists ambiguity/delta state and a decisive verdict closes only the matching generation", () => {
  const s = mem();
  s.upsertWorker({ name: "a", issue: 1, session_id: "s1", state: "driving", started_at: "t", ended_at: null });
  s.recordReviewTrigger("a", "H2", "2026-07-07T09:00:00Z", {
    generation: 2,
    ambiguous: true,
    deltaChain: 1,
    inFlight: true,
  });
  let row = s.getWorker("a")!;
  assert.equal(row.review_trigger_generation, 2);
  assert.equal(row.review_trigger_ambiguous, 1);
  assert.equal(row.review_delta_chain, 1);
  assert.equal(row.review_trigger_in_flight, 1);

  s.recordReviewVerdict("a", "H1", 1, true);
  assert.equal(s.getWorker("a")?.review_trigger_in_flight, 1, "stale generation cannot close H2");
  assert.equal(s.getWorker("a")?.review_covered_head, null, "stale generation cannot establish coverage");
  s.recordReviewVerdict("a", "H2", 2, false);
  row = s.getWorker("a")!;
  assert.equal(row.review_trigger_in_flight, 0);
  assert.equal(row.review_covered_head, null, "an attributable but untrusted blocker does not establish coverage");
  s.recordReviewVerdict("a", "H2", 2, true);
  assert.equal(s.getWorker("a")?.review_covered_head, "H2", "a later trusted response upgrades coverage after in-flight closed");
  s.recordReviewTrigger("a", "H3", "2026-07-07T10:00:00Z", {
    generation: 3,
    ambiguous: false,
    deltaChain: 0,
    inFlight: true,
  });
  row = s.getWorker("a")!;
  s.recordReviewVerdict("a", "H3", 3, true);
  assert.equal(s.getWorker("a")?.review_covered_head, "H3");
  s.upsertWorker({ ...row, state: "fixing" });
  assert.equal(s.getWorker("a")?.review_covered_head, "H3", "a stale same-session upsert cannot erase newly recorded coverage");
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

test("lastHoldEvent (#294): none -> null; returns the LATEST hold transition for the right worker only", () => {
  const s = mem();
  assert.equal(s.lastHoldEvent("lane-a", 55), null);

  s.appendEvent("drive-queued", { worker: "lane-a", pr: 55 }); // unrelated kinds never match
  assert.equal(s.lastHoldEvent("lane-a", 55), null);

  s.appendEvent("pr-held", { worker: "lane-a", issue: 2, pr: 55, label: "sapwood:hold" });
  s.appendEvent("pr-held", { worker: "lane-b", issue: 3, pr: 56, label: "sapwood:hold" });
  assert.equal(s.lastHoldEvent("lane-a", 55), "pr-held");

  // A later release for the same lane supersedes the hold; lane-b's episode is untouched — this
  // per-worker scoping is what lets two lanes be held/released independently.
  s.appendEvent("pr-released", { worker: "lane-a", issue: 2, pr: 55 });
  assert.equal(s.lastHoldEvent("lane-a", 55), "pr-released");
  assert.equal(s.lastHoldEvent("lane-b", 56), "pr-held");
  s.close();
});

test("lastHoldEvent (#294, Codex P2): scoped to (worker, pr) — a lane repointed to a NEW PR never inherits the prior PR's hold episode", () => {
  const s = mem();
  s.appendEvent("pr-held", { worker: "lane-a", issue: 2, pr: 55, label: "sapwood:hold" });
  // Same lane name, different PR (the F15 repointing shape): the old PR's episode must not
  // suppress the new PR's first pr-held, nor manufacture a spurious pr-released for it.
  assert.equal(s.lastHoldEvent("lane-a", 72), null);
  assert.equal(s.lastHoldEvent("lane-a", 55), "pr-held"); // the old episode is still on record
  s.close();
});

test("lastDriveQueuedEvent (#383): none -> null; returns the LATEST id+reason for the right (worker, pr) only", () => {
  const s = mem();
  assert.equal(s.lastDriveQueuedEvent("lane-a", 55), null);

  s.appendEvent("pr-held", { worker: "lane-a", issue: 2, pr: 55 }); // unrelated kinds never match
  assert.equal(s.lastDriveQueuedEvent("lane-a", 55), null);

  s.appendEvent("drive-queued", { worker: "lane-a", issue: 2, pr: 55, reason: "gate-pending:WAIT_REVIEW" });
  const firstId = s.lastDriveQueuedEvent("lane-a", 55)!.id;
  s.appendEvent("drive-queued", { worker: "lane-b", issue: 3, pr: 56, reason: "gate-pending:WAIT_REVIEW" });
  assert.deepEqual(s.lastDriveQueuedEvent("lane-a", 55), { id: firstId, reason: "gate-pending:WAIT_REVIEW" });

  // A later reason for the same (worker, pr) supersedes (a strictly HIGHER id); lane-b's row is
  // untouched.
  s.appendEvent("drive-queued", { worker: "lane-a", issue: 2, pr: 55, reason: "review-triggered" });
  const second = s.lastDriveQueuedEvent("lane-a", 55)!;
  assert.equal(second.reason, "review-triggered");
  assert.ok(second.id > firstId);
  assert.equal(s.lastDriveQueuedEvent("lane-b", 56)?.reason, "gate-pending:WAIT_REVIEW");
  s.close();
});

test("lastDriveQueuedEvent (#383): scoped to (worker, pr) — a lane repointed to a NEW PR never inherits the prior PR's last reason", () => {
  const s = mem();
  s.appendEvent("drive-queued", { worker: "lane-a", issue: 2, pr: 55, reason: "gate-pending:WAIT_REVIEW" });
  assert.equal(s.lastDriveQueuedEvent("lane-a", 72), null);
  assert.equal(s.lastDriveQueuedEvent("lane-a", 55)?.reason, "gate-pending:WAIT_REVIEW"); // the old episode is still on record
  s.close();
});

test("lastFixLegDispatchBlockedEvent (#383): none -> null; returns the LATEST id+blockReason for the right (worker, pr) only", () => {
  const s = mem();
  assert.equal(s.lastFixLegDispatchBlockedEvent("lane-a", 55), null);

  s.appendEvent("drive-queued", { worker: "lane-a", issue: 2, pr: 55, reason: "x" }); // unrelated kinds never match
  assert.equal(s.lastFixLegDispatchBlockedEvent("lane-a", 55), null);

  s.appendEvent("fix-leg-dispatch-blocked", { worker: "lane-a", issue: 2, pr: 55, blockReason: "paused" });
  const firstId = s.lastFixLegDispatchBlockedEvent("lane-a", 55)!.id;
  s.appendEvent("fix-leg-dispatch-blocked", { worker: "lane-b", issue: 3, pr: 56, blockReason: "paused" });
  assert.deepEqual(s.lastFixLegDispatchBlockedEvent("lane-a", 55), { id: firstId, blockReason: "paused" });

  s.appendEvent("fix-leg-dispatch-blocked", { worker: "lane-a", issue: 2, pr: 55, blockReason: "ceiling" });
  const second = s.lastFixLegDispatchBlockedEvent("lane-a", 55)!;
  assert.equal(second.blockReason, "ceiling");
  assert.ok(second.id > firstId);
  assert.equal(s.lastFixLegDispatchBlockedEvent("lane-b", 56)?.blockReason, "paused");
  s.close();
});

test("lastFixLegDispatchBlockedEvent (#383): scoped to (worker, pr) — a lane repointed to a NEW PR never inherits the prior PR's last blockReason", () => {
  const s = mem();
  s.appendEvent("fix-leg-dispatch-blocked", { worker: "lane-a", issue: 2, pr: 55, blockReason: "paused" });
  assert.equal(s.lastFixLegDispatchBlockedEvent("lane-a", 72), null);
  assert.equal(s.lastFixLegDispatchBlockedEvent("lane-a", 55)?.blockReason, "paused"); // the old episode is still on record
  s.close();
});

test("maxEventIdForKinds (#383 round 2, PM P2): 0 when none of `kinds` has fired for this (worker, pr); otherwise the HIGHEST matching id, scoped correctly", () => {
  const s = mem();
  assert.equal(s.maxEventIdForKinds(["drive-fixup"], "lane-a", 55), 0);

  s.appendEvent("drive-queued", { worker: "lane-a", issue: 2, pr: 55, reason: "x" }); // not in `kinds` — ignored
  assert.equal(s.maxEventIdForKinds(["drive-fixup"], "lane-a", 55), 0);

  s.appendEvent("drive-fixup", { worker: "lane-b", issue: 3, pr: 56, fixRounds: 1, reason: "y" }); // different (worker, pr)
  assert.equal(s.maxEventIdForKinds(["drive-fixup"], "lane-a", 55), 0);

  s.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 1, reason: "y" });
  const firstFixupId = s.maxEventIdForKinds(["drive-fixup"], "lane-a", 55);
  assert.ok(firstFixupId > 0);

  // A later event of a DIFFERENT kind in the set is picked up too — MAX across the whole set.
  s.appendEvent("lane-revived", { worker: "lane-a", issue: 2, pr: 55 });
  const bothId = s.maxEventIdForKinds(["drive-fixup", "lane-revived"], "lane-a", 55);
  assert.ok(bothId > firstFixupId);
  // Querying `drive-fixup` alone still returns the OLDER id — the set passed in is what scopes it.
  assert.equal(s.maxEventIdForKinds(["drive-fixup"], "lane-a", 55), firstFixupId);
  s.close();
});

test("latestLaneEventKind (#441): none -> null; returns the LATEST of the requested kinds for that (worker, issue) only", () => {
  const s = mem();
  const kinds = ["resume-held", "resumed", "resume-capped"];
  assert.equal(s.latestLaneEventKind(kinds, "lane-a", 441), null);

  s.appendEvent("fix-leg-resume-no-pr", { worker: "lane-a", issue: 441 }); // a kind outside the set never matches
  assert.equal(s.latestLaneEventKind(kinds, "lane-a", 441), null);

  s.appendEvent("resume-held", { worker: "lane-a", issue: 441, label: "sapwood:needs-human" });
  s.appendEvent("resume-held", { worker: "lane-b", issue: 442, label: "sapwood:needs-human" });
  assert.equal(s.latestLaneEventKind(kinds, "lane-a", 441), "resume-held");

  // A later episode-ending event supersedes it for that lane only — this is what makes the next
  // hold on lane-a a new episode while lane-b's stays deduped.
  s.appendEvent("resumed", { worker: "lane-a", issue: 441, attempt: 1 });
  assert.equal(s.latestLaneEventKind(kinds, "lane-a", 441), "resumed");
  assert.equal(s.latestLaneEventKind(kinds, "lane-b", 442), "resume-held");
  s.close();
});

test("latestLaneEventKind (#441): scoped to (worker, issue) — a lane repointed to a NEW issue never inherits the prior issue's episode; empty kinds throws", () => {
  const s = mem();
  s.appendEvent("resume-held", { worker: "lane-a", issue: 441, label: "sapwood:needs-human" });
  assert.equal(s.latestLaneEventKind(["resume-held"], "lane-a", 999), null);
  assert.equal(s.latestLaneEventKind(["resume-held"], "lane-a", 441), "resume-held");
  assert.throws(() => s.latestLaneEventKind([], "lane-a", 441), /kinds must be non-empty/);
  s.close();
});

test("laneEventRecorded (#447): matches only the SAME kind for the SAME (worker, pr) — and once true, stays true", () => {
  const s = mem();
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-a", 55), false);

  s.appendEvent("drive-needs-human", { worker: "lane-a", issue: 2, pr: 55, labeled: 1 }); // bucket 1 never matches
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-a", 55), false);

  s.appendEvent("drive-human-merge-only", { worker: "lane-a", issue: 2, pr: 55, reason: "gate:HUMAN:instruction-path-change:x" });
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-a", 55), true);
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-b", 55), false, "another lane's PR number is not this lane's verdict");
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-a", 72), false, "a repointed lane never inherits the prior PR's");
  assert.equal(s.laneEventRecorded("lane-revival-terminal", "lane-a", 55), false, "kinds do not bleed into each other");

  // One-way: no later event of any kind can un-record it (the loop never re-decides bucket 2).
  s.appendEvent("lane-revived", { worker: "lane-a", issue: 2, pr: 55 });
  assert.equal(s.laneEventRecorded("drive-human-merge-only", "lane-a", 55), true);
  s.close();
});

test("upsertWorkerWithEvent (#447): row write and its event land together — a failing event write rolls the row back", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-a", issue: 2, session_id: "s", state: "failed", started_at: "t", ended_at: "t", pr: 55 });
  s.upsertWorkerWithEvent({ ...s.getWorker("lane-a")!, state: "driving" }, "lane-revived", { worker: "lane-a", issue: 2, pr: 55 });
  assert.equal(s.getWorker("lane-a")?.state, "driving");
  assert.equal(s.eventsSince("1970-01-01T00:00:00.000Z", ["lane-revived"]).length, 1);

  // A payload sqlite cannot store aborts the whole pair: the row must not move without its record.
  assert.throws(() =>
    s.upsertWorkerWithEvent({ ...s.getWorker("lane-a")!, state: "failed" }, "lane-revived", { bad: 1n as unknown as number }),
  );
  assert.equal(s.getWorker("lane-a")?.state, "driving", "rolled back — never the move without the event");
  assert.equal(s.eventsSince("1970-01-01T00:00:00.000Z", ["lane-revived"]).length, 1);
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

test("touchLastTick (#431 AC1/AC2): the heartbeat advances per call and NOTHING else survives — no session inheritance, no gap heuristic, no readable started_at anywhere on the State surface", () => {
  const s = mem();
  s.touchLastTick(new Date("2026-07-06T00:00:00Z"));
  assert.equal(s.lastTickAt(), "2026-07-06T00:00:00.000Z");
  // Any later touch — 5 minutes or 5 days apart — just moves the heartbeat. There is no gap
  // threshold to compare against and no session identity to keep or reset: the deleted
  // engineSessionStart's whole decision table (continuous-ticking keep / stale-gap reset /
  // exactly-at-gap edge) is unrepresentable against this API, which is the #431 acceptance
  // criterion "assert via the deleted table".
  s.touchLastTick(new Date("2026-07-06T00:05:00Z"));
  assert.equal(s.lastTickAt(), "2026-07-06T00:05:00.000Z");
  s.touchLastTick(new Date("2026-07-11T09:00:00Z"));
  assert.equal(s.lastTickAt(), "2026-07-11T09:00:00.000Z");
  // The wall-clock anchor is in-memory (TickDeps.processStartedAt) — State exposes no
  // session-start read at all, so no restart can resurrect one from here by construction.
  assert.equal("engineSessionStart" in s, false, "the session-inheritance API is deleted, not deprecated");
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
  assert.equal(p?.resetHintAt, null, "omitted resetHintAtIso -> null, unchanged from every pre-#374 caller");
  s.close();
});

test("park: enterPark's optional resetHintAtIso (#374) is persisted and read back", () => {
  const s = mem();
  s.enterPark("llm", "hit your session limit", 42, "2026-07-14T00:00:00Z", "2026-07-14T06:30:00Z");
  const p = s.parkRow("llm");
  assert.equal(p?.resetHintAt, "2026-07-14T06:30:00Z");
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

test("park: a resetHintAtIso is set ONCE at entry — a later classified failure for the SAME open episode never overwrites it (first detection wins, same stance as reason/enteredAt)", () => {
  const s = mem();
  s.enterPark("llm", "first reason", 1, "2026-07-14T00:00:00Z", "2026-07-14T06:30:00Z");
  s.enterPark("llm", "a later llm failure", 2, "2026-07-14T01:00:00Z", "2026-07-14T09:00:00Z");
  const p = s.parkRow("llm");
  assert.equal(p?.resetHintAt, "2026-07-14T06:30:00Z");
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

test("#223: settleTerminalWorker is ATOMIC — the terminal worker row + its settled spend row land together; a failure inside the transaction rolls back BOTH (never terminal-without-spend)", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 10, session_id: "s1", state: "running", started_at: "t0", ended_at: null });

  // Happy path: one call, both land.
  s.settleTerminalWorker(
    { name: "lane-1", issue: 10, session_id: "s1", state: "done", started_at: "t0", ended_at: "t1" },
    { worker: "lane-1", issue: 10, usd: 2.5, at: "t1" },
  );
  assert.equal(s.getWorker("lane-1")?.state, "done");
  assert.equal(s.spentUsdForWorker("lane-1"), 2.5);

  // Unrepresentable partial state: a recordSpend failure rolls back the terminal upsertWorker
  // too — the exact crash-window shape #223 reports (worker row terminal, spend_ledger row
  // missing) cannot be produced through this method.
  s.upsertWorker({ name: "lane-2", issue: 11, session_id: "s2", state: "running", started_at: "t0", ended_at: null });
  const realRecordSpend = s.recordSpend.bind(s);
  s.recordSpend = () => {
    throw new Error("simulated recordSpend failure");
  };
  assert.throws(
    () =>
      s.settleTerminalWorker(
        { name: "lane-2", issue: 11, session_id: "s2", state: "done", started_at: "t0", ended_at: "t1" },
        { worker: "lane-2", issue: 11, usd: 3, at: "t1" },
      ),
    /simulated recordSpend failure/,
  );
  assert.equal(s.getWorker("lane-2")?.state, "running", "the terminal transition rolled back with the failed spend write");
  assert.equal(s.spentUsdForWorker("lane-2"), 0, "no partial ledger row either");

  // A clean retry (spend now succeeds) commits both, exactly once.
  s.recordSpend = realRecordSpend;
  s.settleTerminalWorker(
    { name: "lane-2", issue: 11, session_id: "s2", state: "done", started_at: "t0", ended_at: "t2" },
    { worker: "lane-2", issue: 11, usd: 3, at: "t2" },
  );
  assert.equal(s.getWorker("lane-2")?.state, "done");
  assert.equal(s.spentUsdForWorker("lane-2"), 3);
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

test("migration v12->v13: a populated v12 DB opens with data intact, resume defaults, user_version SCHEMA_VERSION, and idempotent reopen", () => {
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

    // Open with the CURRENT engine -> migrates 12 -> SCHEMA_VERSION (13 was current when this
    // test was written; later migrations, e.g. #231's v13->v14 input_manifest and #236's
    // v14->v15 context_manifests, ride along automatically and never touch the v12 rows this
    // test populated — asserting against SCHEMA_VERSION here keeps this test meaningful without
    // hardcoding a version number that a later migration would immediately stale-date).
    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 13);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
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
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("lane-v12")?.issue, 9);
    assert.equal(s2.getWorker("lane-v12")?.resume_attempts, 0);
    assert.equal(s2.isParked(), false);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #231: input manifest (migration v13->v14) ───────────────────────────────────────────────

test("migration v13->v14: a populated v13 DB opens with data intact, an empty input_manifest table, user_version SCHEMA_VERSION, and idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    // Build a REAL v13 DB: run the shipped migrations 0..12 exactly as that engine would have.
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 13; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 13");
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, resume_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lane-v13", 4, "sess-4", "done", "2026-07-16T00:00:00Z", "2026-07-16T01:00:00Z", 2);
    assert.throws(() => raw.prepare("SELECT * FROM input_manifest").get(), "the table doesn't exist yet at v13");
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 14);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    assert.equal(s.getWorker("lane-v13")?.resume_attempts, 2, "pre-existing data survived intact");
    assert.deepEqual(s.inputManifestRows(1), [], "the new table exists and starts empty");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("lane-v13")?.resume_attempts, 2);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("input manifest: nextInputManifestAttempt starts at 1 and increments per (round, phase, role, session) tuple only — a different tuple starts fresh at 1", () => {
  const s = new State(":memory:");
  assert.equal(s.nextInputManifestAttempt(1, "aligning", "po", "po-align"), 1);
  s.appendInputManifest({ round_id: 1, phase: "aligning", role: "po", session: "po-align", attempt: 1, channel: "goal-file", ok: true });
  assert.equal(
    s.nextInputManifestAttempt(1, "aligning", "po", "po-align"),
    2,
    "a second row for the SAME tuple is a distinguishable second attempt",
  );
  // A different channel under the SAME (round, phase, role, session, attempt) does not bump
  // the attempt counter on its own — the CALLER decides one attempt covers several channels.
  s.appendInputManifest({
    round_id: 1,
    phase: "aligning",
    role: "po",
    session: "po-align",
    attempt: 1,
    channel: "backlog-digest",
    ok: true,
  });
  assert.equal(
    s.nextInputManifestAttempt(1, "aligning", "po", "po-align"),
    2,
    "still 2 — the max attempt used so far, regardless of channel count",
  );
  // A different session (e.g. a distinct triage target) starts its own fresh counter.
  assert.equal(s.nextInputManifestAttempt(1, "aligning", "po", "po-triage:9"), 1);
  // A different round is also independent.
  assert.equal(s.nextInputManifestAttempt(2, "aligning", "po", "po-align"), 1);
  s.close();
});

test("input manifest: appendInputManifest + inputManifestRows round-trip every field, including null/optional defaults", () => {
  const s = new State(":memory:");
  s.appendInputManifest({
    round_id: 10,
    phase: "aligning",
    role: "po",
    session: "po-align",
    attempt: 1,
    channel: "backlog-digest",
    ok: false,
    total: 50,
    rendered: 12,
    omitted: 38,
    truncated: true,
    detail: "open-issue read failed",
  });
  s.appendInputManifest({ round_id: 10, phase: "aligning", role: "po", session: "po-align", attempt: 1, channel: "goal-file", ok: true });
  const rows = s.inputManifestRows(10);
  assert.equal(rows.length, 2);
  const backlogRow = rows.find((r) => r.channel === "backlog-digest")!;
  assert.equal(backlogRow.ok, false);
  assert.equal(backlogRow.total, 50);
  assert.equal(backlogRow.rendered, 12);
  assert.equal(backlogRow.omitted, 38);
  assert.equal(backlogRow.truncated, true);
  assert.equal(backlogRow.detail, "open-issue read failed");
  assert.equal(backlogRow.version, null);
  const goalRow = rows.find((r) => r.channel === "goal-file")!;
  assert.equal(goalRow.ok, true);
  assert.equal(goalRow.total, null);
  // #251 gate② review round 3: an OMITTED truncated round-trips as null, never a fabricated
  // false (schema v16->v17's three-state fix — see the dedicated #251 test further below).
  assert.equal(goalRow.truncated, null);
  assert.equal(goalRow.detail, null);
  assert.equal(s.inputManifestRows(999).length, 0, "a round with no rows reads back empty, not an error");
  s.close();
});

test("input manifest: a crash-rerun's manifest is distinguishable from the original attempt's (#231 acceptance criterion)", () => {
  const s = new State(":memory:");
  const attempt1 = s.nextInputManifestAttempt(7, "aligning", "po", "po-align");
  s.appendInputManifest({
    round_id: 7,
    phase: "aligning",
    role: "po",
    session: "po-align",
    attempt: attempt1,
    channel: "goal-file",
    ok: false,
  });
  // The engine crashes and restarts; the SAME phase/session is dispatched again this round.
  const attempt2 = s.nextInputManifestAttempt(7, "aligning", "po", "po-align");
  assert.equal(attempt2, attempt1 + 1);
  s.appendInputManifest({
    round_id: 7,
    phase: "aligning",
    role: "po",
    session: "po-align",
    attempt: attempt2,
    channel: "goal-file",
    ok: true,
  });
  const rows = s.inputManifestRows(7);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.attempt, r.ok]),
    [
      [1, false],
      [2, true],
    ],
    "the two attempts are independently distinguishable rows, not an overwrite",
  );
  s.close();
});

// ── #251 gate② review round 3 (Codex delta-verify F1): input_manifest.truncated is THREE-STATE
// (migration v16->v17) ──────────────────────────────────────────────────────────────────────

test("migration v16->v17: a populated v16 DB opens with data intact (including pre-migration truncated 0/1 values), user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 16; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 16");
    raw
      .prepare(
        `INSERT INTO input_manifest (round_id, phase, role, session, attempt, channel, ok, truncated, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, "aligning", "po", "po-align", 1, "backlog-digest", 1, 1, "2026-07-17T00:00:00Z");
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 17);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    const rows = s.inputManifestRows(1);
    assert.equal(rows.length, 1, "the pre-migration row survived the table rebuild");
    assert.equal(rows[0]?.truncated, true, "an EXPLICIT pre-migration 0/1 value is preserved verbatim, not reinterpreted");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.inputManifestRows(1).length, 1);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #237 round-3 adjudication (2026-07-19): events(kind) index (migration v17->v18) ─────────

test("migration v17->v18: a populated v17 DB opens with data intact, an index on events(kind) exists, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 17; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 17");
    raw.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run("2026-07-19T00:00:00Z", "concern-posted", "{}");
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 18);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    assert.equal(s.eventsAfterId(0, ["concern-posted"]).length, 1, "the pre-migration row survived");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.eventsAfterId(0, ["concern-posted"]).length, 1);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v17->v18: the events(kind) index is actually created and usable by the query planner", () => {
  const s = new State(":memory:");
  s.appendEvent("concern-posted", { issue: 1 });
  const indexRow = (s as unknown as { db: DatabaseSync }).db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name = 'events_kind_idx'")
    .get();
  assert.ok(indexRow, "events_kind_idx exists on the events table");
  s.close();
});

test("migration v18->v19: a populated v18 DB opens with data intact, fix_rounds defaults to 0 on pre-existing rows, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 18; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 18");
    raw
      .prepare(
        `INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-driving", 7, "sess-1", "driving", "2026-07-01T00:00:00Z", null, 70);
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 19);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    const row = s.getWorker("legacy-driving");
    assert.equal(row?.fix_rounds, 0, "a pre-#245 row never had a fix leg — defaults to 0, not NULL");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("legacy-driving")?.fix_rounds, 0);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v19->v20: a populated v19 DB opens with data intact, fixing_handoff defaults to 0 on pre-existing rows, user_version SCHEMA_VERSION, idempotent reopen (#245 round-2 fix A2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 19; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 19");
    raw
      .prepare(
        `INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-handoff", 8, "sess-2", "handoff", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z", null);
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 20);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    const row = s.getWorker("legacy-handoff");
    assert.equal(row?.fixing_handoff, 0, "a pre-#245-round-2 handoff row was never a fixing handoff — defaults to 0, not NULL");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("legacy-handoff")?.fixing_handoff, 0);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixing_handoff round-trips independently of fix_rounds/resume_attempts and persists across a State reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const s = new State(dbPath);
    s.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "handoff",
      started_at: "t",
      ended_at: "t2",
      pr: 10,
      fix_rounds: 2,
      fixing_handoff: 1,
    });
    const row = s.getWorker("lane-a")!;
    assert.equal(row.fixing_handoff, 1);
    assert.equal(row.fix_rounds, 2);
    s.close();

    const reopened = new State(dbPath);
    const reopenedRow = reopened.getWorker("lane-a")!;
    assert.equal(reopenedRow.fixing_handoff, 1);
    assert.equal(reopenedRow.fix_rounds, 2, "fix_rounds unaffected by fixing_handoff's own value");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v20->v21: a populated v20 DB opens with data intact, an empty pending_thread_writes table, user_version SCHEMA_VERSION, idempotent reopen (#247)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 20; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 20");
    raw
      .prepare(
        `INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-fixing", 9, "sess-3", "fixing", "2026-07-01T00:00:00Z", null, 90);
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 21);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    assert.equal(s.getWorker("legacy-fixing")?.state, "fixing", "pre-existing data survives untouched");
    assert.deepEqual(s.pendingThreadWrites(), [], "a fresh table on a pre-#247 DB — empty, never a migration error");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.deepEqual(s2.pendingThreadWrites(), []);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v21->v22: an existing trigger pin becomes generation 1 and conservatively remains in flight", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-v21-"));
  const dbPath = join(dir, "state.sqlite");
  try {
    const raw = new DatabaseSync(dbPath);
    for (let v = 0; v < 21; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 21");
    raw
      .prepare(
        `INSERT INTO workers
         (name, issue, session_id, state, started_at, review_triggered_head, review_triggered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-pin", 273, "s", "driving", "2026-07-19T00:00:00Z", "H1", "2026-07-19T00:01:00Z");
    raw.close();

    const s = new State(dbPath);
    const row = s.getWorker("legacy-pin")!;
    assert.equal(row.review_trigger_generation, 1);
    assert.equal(row.review_trigger_ambiguous, 0);
    assert.equal(row.review_delta_chain, 0);
    assert.equal(row.review_trigger_in_flight, 1);
    assert.equal(row.review_covered_head, null);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending_thread_writes (#247): enqueue/markThreadReplyPosted/markThreadResolved/bumpThreadWriteAttempt/clearThreadWrite round-trip, oldest-first", () => {
  const s = mem();
  const id1 = s.enqueueThreadWrite(
    { worker: "lane-a", issue: 1, pr: 10, threadId: "T1", reply: "fixed", resolution: "addressed", batchKey: "lane-a#1", fixRounds: 1 },
    "2026-07-19T00:00:00Z",
  );
  const id2 = s.enqueueThreadWrite(
    { worker: "lane-a", issue: 1, pr: 10, threadId: "T2", reply: "disagree", resolution: "disputed", batchKey: "lane-a#1", fixRounds: 1 },
    "2026-07-19T00:00:01Z",
  );
  let rows = s.pendingThreadWrites();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.id),
    [id1, id2],
    "oldest-first (retry order)",
  );
  assert.equal(rows[0]!.replyPosted, false);
  assert.equal(rows[0]!.resolved, false);
  assert.equal(rows[0]!.attempts, 0);
  assert.equal(rows[0]!.lastAttemptAt, null);
  assert.equal(rows[0]!.resolution, "addressed");
  assert.equal(rows[0]!.batchKey, "lane-a#1");
  assert.equal(rows[0]!.fixRounds, 1);
  assert.equal(rows[1]!.resolution, "disputed");

  s.markThreadReplyPosted(id1, "2026-07-19T00:01:00Z");
  s.bumpThreadWriteAttempt(id1, "2026-07-19T00:02:00Z");
  rows = s.pendingThreadWrites();
  assert.equal(rows[0]!.replyPosted, true);
  assert.equal(rows[0]!.attempts, 1);
  assert.equal(rows[0]!.lastAttemptAt, "2026-07-19T00:02:00Z", "last write wins");

  s.markThreadResolved(id1, "2026-07-19T00:03:00Z");
  assert.equal(s.pendingThreadWrites()[0]!.resolved, true);

  s.clearThreadWrite(id1);
  rows = s.pendingThreadWrites();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id2, "only id1 removed");
  s.close();
});

test("pending_thread_writes persists across close/reopen (an engine restart mid-retry does not lose the queue)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const s = new State(dbPath);
    const id = s.enqueueThreadWrite(
      { worker: "lane-a", issue: 1, pr: 10, threadId: "T1", reply: "fixed", resolution: "addressed", batchKey: "lane-a#1", fixRounds: 1 },
      "2026-07-19T00:00:00Z",
    );
    s.markThreadReplyPosted(id, "2026-07-19T00:01:00Z");
    s.close();

    const reopened = new State(dbPath);
    const rows = reopened.pendingThreadWrites();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.replyPosted, true, "the durable reply-posted marker survives a restart — never double-posted after resume");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueThreadWrite (#247 D4): INSERT OR IGNORE on the (batch_key, thread_id) unique index — a duplicate insert for the SAME batch+thread is a silent no-op, never a second row", () => {
  const s = mem();
  s.enqueueThreadWrite(
    { worker: "lane-a", issue: 1, pr: 10, threadId: "T1", reply: "fixed", resolution: "addressed", batchKey: "lane-a#1", fixRounds: 1 },
    "2026-07-19T00:00:00Z",
  );
  // Same batch_key + thread_id, different reply text — simulates a crash-rerun re-deriving the
  // identical batch (or, defensively, a duplicate settle somehow re-attempted).
  s.enqueueThreadWrite(
    {
      worker: "lane-a",
      issue: 1,
      pr: 10,
      threadId: "T1",
      reply: "fixed (rerun)",
      resolution: "addressed",
      batchKey: "lane-a#1",
      fixRounds: 1,
    },
    "2026-07-19T00:00:01Z",
  );
  const rows = s.pendingThreadWrites();
  assert.equal(rows.length, 1, "the duplicate insert was ignored — never a second row for the same (batch_key, thread_id)");
  assert.equal(rows[0]!.reply, "fixed", "the FIRST insert's data wins — OR IGNORE never overwrites");
  s.close();
});

test("enqueueThreadWrite: the SAME thread_id under a DIFFERENT batch_key (a later fix round re-addressing the same thread) is a distinct row", () => {
  const s = mem();
  s.enqueueThreadWrite(
    {
      worker: "lane-a",
      issue: 1,
      pr: 10,
      threadId: "T1",
      reply: "round 1 fix",
      resolution: "addressed",
      batchKey: "lane-a#1",
      fixRounds: 1,
    },
    "2026-07-19T00:00:00Z",
  );
  s.enqueueThreadWrite(
    {
      worker: "lane-a",
      issue: 1,
      pr: 10,
      threadId: "T1",
      reply: "round 2 fix",
      resolution: "addressed",
      batchKey: "lane-a#2",
      fixRounds: 2,
    },
    "2026-07-19T00:00:01Z",
  );
  assert.equal(s.pendingThreadWrites().length, 2);
  s.close();
});

// ── settleTerminalWorker's fixResponse param (#247 D4): atomicity ──────────────────────────

test("settleTerminalWorker (D4): a validated batch's worker row + spend + EVERY pending_thread_writes row + the fix-response-queued event land in ONE transaction", () => {
  const s = mem();
  s.settleTerminalWorker(
    { name: "lane-fix", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 30 },
    { worker: "lane-fix", issue: 9, usd: 0.05, at: "2026-07-19T00:00:00Z" },
    {
      kind: "batch",
      batch: {
        worker: "lane-fix",
        issue: 9,
        pr: 30,
        fixRounds: 1,
        batchKey: "lane-fix#1",
        writes: [
          { threadId: "T1", reply: "fixed", resolution: "addressed" },
          { threadId: "T2", reply: "disagree", resolution: "disputed" },
        ],
      },
    },
  );
  assert.equal(s.getWorker("lane-fix")?.state, "driving");
  assert.equal(s.spentUsdForWorker("lane-fix"), 0.05);
  const rows = s.pendingThreadWrites();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.threadId).sort(), ["T1", "T2"]);
  for (const r of rows) {
    assert.equal(r.batchKey, "lane-fix#1");
    assert.equal(r.fixRounds, 1);
  }
  const events = s.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { worker: "lane-fix", issue: 9, pr: 30, batchKey: "lane-fix#1", fixRounds: 1, count: 2 });
  s.close();
});

test("settleTerminalWorker (D4): an invalid outcome commits the terminal state + spend + a fix-response-invalid event, and enqueues NOTHING", () => {
  const s = mem();
  s.settleTerminalWorker(
    { name: "lane-fix", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 30 },
    { worker: "lane-fix", issue: 9, usd: 0.02, at: "2026-07-19T00:00:00Z" },
    { kind: "invalid", invalid: { worker: "lane-fix", issue: 9, pr: 30, reason: "no structured output block found" } },
  );
  assert.equal(s.getWorker("lane-fix")?.state, "driving");
  assert.equal(s.spentUsdForWorker("lane-fix"), 0.02);
  assert.deepEqual(s.pendingThreadWrites(), []);
  const events = s.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-invalid"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { worker: "lane-fix", issue: 9, pr: 30, reason: "no structured output block found" });
  s.close();
});

test("settleTerminalWorker (D4): omitting fixResponse entirely behaves byte-identically to the pre-#247 two-arg call — no event, no queue row", () => {
  const s = mem();
  s.settleTerminalWorker(
    { name: "lane-a", issue: 1, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 10 },
    { worker: "lane-a", issue: 1, usd: 0.01, at: "2026-07-19T00:00:00Z" },
  );
  assert.equal(s.getWorker("lane-a")?.state, "driving");
  assert.deepEqual(s.pendingThreadWrites(), []);
  assert.deepEqual(s.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued", "fix-response-invalid"]), []);
  s.close();
});

test("settleTerminalWorker (D4 crash-ordering): a thrown mid-batch enqueue rolls back the ENTIRE transaction — the terminal state write, spend, and every OTHER write in the batch never land either (never a partial batch)", () => {
  const s = mem();
  const originalEnqueue = s.enqueueThreadWrite.bind(s);
  let calls = 0;
  s.enqueueThreadWrite = ((input: Parameters<typeof originalEnqueue>[0], at: string) => {
    calls++;
    if (calls === 2) throw new Error("simulated crash mid-batch");
    return originalEnqueue(input, at);
  }) as typeof s.enqueueThreadWrite;

  assert.throws(() =>
    s.settleTerminalWorker(
      { name: "lane-fix", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 30 },
      { worker: "lane-fix", issue: 9, usd: 0.05, at: "2026-07-19T00:00:00Z" },
      {
        kind: "batch",
        batch: {
          worker: "lane-fix",
          issue: 9,
          pr: 30,
          fixRounds: 1,
          batchKey: "lane-fix#1",
          writes: [
            { threadId: "T1", reply: "fixed", resolution: "addressed" },
            { threadId: "T2", reply: "disagree", resolution: "disputed" }, // this insert throws
          ],
        },
      },
    ),
  );
  // Nothing landed: not the terminal state transition, not the spend, not even T1's own row
  // (which was inserted BEFORE the throw, inside the same still-open transaction).
  assert.equal(s.getWorker("lane-fix"), undefined, "the worker row was never upserted — the whole transaction rolled back");
  assert.equal(s.spentUsdForWorker("lane-fix"), 0);
  assert.deepEqual(s.pendingThreadWrites(), [], "T1's row, inserted before the throw, is ALSO gone — never a partial batch");
  s.close();
});

test("listForgeProxyJournalForSession (#247): every row for a session name alone, regardless of round/phase/attempt — the fix-leg harvest's no-TOCTOU read", () => {
  const s = mem();
  const at = "2026-07-19T00:00:00Z";
  const id1 = s.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "driving", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: at,
  });
  s.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ threads: [{ id: "T1" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: at,
  });
  // A DIFFERENT session must never leak into this session's read.
  const idOther = s.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "driving", role: "worker", session: "lane-other", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: at,
  });
  s.recordForgeProxyJournalResponse(idOther, {
    responseCanonical: JSON.stringify({ threads: [{ id: "OTHER" }] }),
    contentHash: "h2",
    truncated: false,
    fetchedAt: at,
  });

  const rows = s.listForgeProxyJournalForSession("lane-fix");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.identity.session, "lane-fix");
  assert.equal(rows[0]!.responseCanonical, JSON.stringify({ threads: [{ id: "T1" }] }));
  s.close();
});

test("listForgeProxyJournalForSession (#247 F1): an afterId cursor excludes rows AT OR BEFORE it (strict '>') — the per-fix-round leg-bound scoping fixLegJournalCursor relies on", () => {
  const s = mem();
  const earlyId = s.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z", // round 1
  });
  s.recordForgeProxyJournalResponse(earlyId, {
    responseCanonical: JSON.stringify({ threads: [{ id: "EARLY" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:00Z",
  });
  const lateId = s.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 2,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T02:00:00Z", // round 2
  });
  s.recordForgeProxyJournalResponse(lateId, {
    responseCanonical: JSON.stringify({ threads: [{ id: "LATE" }] }),
    contentHash: "h2",
    truncated: false,
    fetchedAt: "2026-07-19T02:00:00Z",
  });

  const unscoped = s.listForgeProxyJournalForSession("lane-fix");
  assert.equal(unscoped.length, 2, "omitting afterId keeps the pre-D2 unscoped read unchanged");

  const scoped = s.listForgeProxyJournalForSession("lane-fix", earlyId);
  assert.equal(scoped.length, 1, "the row AT the cursor id itself is excluded — strict '>', not '>='");
  assert.equal(scoped[0]!.responseCanonical, JSON.stringify({ threads: [{ id: "LATE" }] }));

  const allExcluded = s.listForgeProxyJournalForSession("lane-fix", lateId);
  assert.deepEqual(allExcluded, [], "a cursor at the LATEST row's own id excludes everything");
  s.close();
});

test("maxForgeProxyJournalId (#247 F1): 0 for a session with no rows yet, then the row's own id once one exists, scoped to that session only", () => {
  const s = mem();
  assert.equal(s.maxForgeProxyJournalId("lane-fix"), 0, "no rows yet — a valid 0 cursor, not an error");
  const id = s.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z",
  });
  assert.equal(s.maxForgeProxyJournalId("lane-fix"), id);
  assert.equal(s.maxForgeProxyJournalId("lane-other"), 0, "a different session's rows never leak in");
  s.close();
});

test("completeThreadReply (#247 F3): atomically flips reply_posted and appends its receipt event — both land, or (on a thrown appendEvent) neither does", () => {
  const s = mem();
  const id = s.enqueueThreadWrite(
    { worker: "lane-a", issue: 1, pr: 10, threadId: "T1", reply: "fixed", resolution: "addressed", batchKey: "lane-a#10#1", fixRounds: 1 },
    "2026-07-19T00:00:00Z",
  );
  s.completeThreadReply(id, "2026-07-19T00:01:00Z", { worker: "lane-a", threadId: "T1" });
  assert.equal(s.pendingThreadWrites()[0]!.replyPosted, true);
  const events = s.eventsSince("1970-01-01T00:00:00.000Z", ["fix-thread-reply-posted"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { worker: "lane-a", threadId: "T1" });
  s.close();
});

test("completeThreadResolve (#247 F3): atomically flips resolved, clears the row, and appends its receipt event", () => {
  const s = mem();
  const id = s.enqueueThreadWrite(
    { worker: "lane-a", issue: 1, pr: 10, threadId: "T1", reply: "fixed", resolution: "addressed", batchKey: "lane-a#10#1", fixRounds: 1 },
    "2026-07-19T00:00:00Z",
  );
  s.completeThreadResolve(id, "2026-07-19T00:01:00Z", { worker: "lane-a", threadId: "T1" });
  assert.deepEqual(s.pendingThreadWrites(), [], "cleared as part of the same atomic commit");
  const events = s.eventsSince("1970-01-01T00:00:00.000Z", ["fix-thread-resolved"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { worker: "lane-a", threadId: "T1" });
  s.close();
});

test("input manifest #251: an OMITTED truncated round-trips as null, never a fabricated false — the exact dishonesty the three-state column fixes", () => {
  const s = new State(":memory:");
  s.appendInputManifest({
    round_id: 1,
    phase: "architecting",
    role: "architect",
    session: "architect",
    attempt: 1,
    channel: "last-merged",
    ok: true,
  });
  s.appendInputManifest({
    round_id: 1,
    phase: "architecting",
    role: "architect",
    session: "architect",
    attempt: 1,
    channel: "candidate-issues",
    ok: true,
    truncated: false,
  });
  s.appendInputManifest({
    round_id: 1,
    phase: "architecting",
    role: "architect",
    session: "architect",
    attempt: 1,
    channel: "pool-digest",
    ok: true,
    truncated: true,
  });
  const rows = s.inputManifestRows(1);
  assert.equal(rows.find((r) => r.channel === "last-merged")?.truncated, null, "omitted -> null, never coerced to false");
  assert.equal(rows.find((r) => r.channel === "candidate-issues")?.truncated, false, "an EXPLICIT false is preserved as false, not null");
  assert.equal(rows.find((r) => r.channel === "pool-digest")?.truncated, true);
  s.close();
});

// ── #236: ambient session context manifests (context_manifests, migration 14->15) ──────────

test("recordContextManifest/getContextManifest: round-trips one attempt's manifest exactly, undefined for a key never recorded", () => {
  const s = mem();
  const key = { roundId: 7, phase: "harvesting", role: "harvest", session: "role-harvest-abc123", attempt: 1 };
  assert.equal(s.getContextManifest(key), undefined);
  s.recordContextManifest(key, JSON.stringify({ sources: [], model: "sonnet" }), "2026-07-17T00:00:00Z");
  const row = s.getContextManifest(key);
  assert.equal(row?.recordedAt, "2026-07-17T00:00:00Z");
  assert.deepEqual(JSON.parse(row?.json ?? "{}"), { sources: [], model: "sonnet" });
  // A different key (even same round/phase/role, different session/attempt) is independent.
  assert.equal(s.getContextManifest({ ...key, attempt: 2 }), undefined);
  assert.equal(s.getContextManifest({ ...key, session: "role-harvest-def456" }), undefined);
  s.close();
});

test("recordContextManifest: re-recording the SAME (round, phase, role, session, attempt) key upserts — never a duplicate row (crash-rerun idempotence)", () => {
  const s = mem();
  const key = { roundId: 7, phase: "harvesting", role: "harvest", session: "role-harvest-abc123", attempt: 1 };
  s.recordContextManifest(key, JSON.stringify({ model: "sonnet" }), "2026-07-17T00:00:00Z");
  s.recordContextManifest(key, JSON.stringify({ model: "opus" }), "2026-07-17T00:05:00Z");
  const row = s.getContextManifest(key);
  assert.equal(row?.recordedAt, "2026-07-17T00:05:00Z");
  assert.deepEqual(JSON.parse(row?.json ?? "{}"), { model: "opus" });
  assert.equal(s.listContextManifestsForRound(7).length, 1, "upsert, not a second row");
  s.close();
});

test("listContextManifestsForRound: two attempts of the same phase are independently reconstructable, insertion order, scoped to the round", () => {
  const s = mem();
  s.recordContextManifest(
    { roundId: 7, phase: "harvesting", role: "harvest", session: "role-harvest-attempt1", attempt: 1 },
    JSON.stringify({ worktree: { dirty: false } }),
    "2026-07-17T00:00:00Z",
  );
  s.recordContextManifest(
    { roundId: 7, phase: "harvesting", role: "harvest", session: "role-harvest-attempt2", attempt: 2 },
    JSON.stringify({ worktree: { dirty: true } }),
    "2026-07-17T00:01:00Z",
  );
  // A different round's manifest must never bleed into round 7's read.
  s.recordContextManifest(
    { roundId: 8, phase: "harvesting", role: "harvest", session: "role-harvest-other-round", attempt: 1 },
    JSON.stringify({}),
    "2026-07-17T00:02:00Z",
  );
  const rows = s.listContextManifestsForRound(7);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.attempt, 1);
  assert.equal(rows[0]?.session, "role-harvest-attempt1");
  assert.deepEqual(JSON.parse(rows[0]?.json ?? "{}"), { worktree: { dirty: false } });
  assert.equal(rows[1]?.attempt, 2);
  assert.equal(rows[1]?.session, "role-harvest-attempt2");
  assert.deepEqual(JSON.parse(rows[1]?.json ?? "{}"), { worktree: { dirty: true } });
  assert.equal(s.listContextManifestsForRound(8).length, 1);
  assert.deepEqual(s.listContextManifestsForRound(9), []);
  s.close();
});

// ── #283: AC-authority dispatch snapshot (ac_snapshots, migration 22->23) ──────────────────

test("recordAcSnapshot/getAcSnapshot: round-trips one issue's snapshot exactly, null for an issue never snapshotted", () => {
  const s = mem();
  assert.equal(s.getAcSnapshot(7), null);
  s.recordAcSnapshot({
    issue: 7,
    bodyHash: "abc123",
    body: "## Acceptance criteria\n\n- [ ] one",
    manifest: [{ id: "1-deadbeef", text: "one" }],
    snapshottedAt: "2026-07-21T00:00:00Z",
  });
  const snap = s.getAcSnapshot(7);
  assert.equal(snap?.bodyHash, "abc123");
  assert.equal(snap?.body, "## Acceptance criteria\n\n- [ ] one");
  assert.deepEqual(snap?.manifest, [{ id: "1-deadbeef", text: "one" }]);
  assert.equal(snap?.snapshottedAt, "2026-07-21T00:00:00Z");
  // A different issue is independent.
  assert.equal(s.getAcSnapshot(8), null);
  s.close();
});

test("recordAcSnapshot: re-recording the SAME issue upserts — never a second row (a fresh dispatch of a terminated lane's issue replaces the stale snapshot)", () => {
  const s = mem();
  s.recordAcSnapshot({
    issue: 7,
    bodyHash: "hash-v1",
    body: "v1 body",
    manifest: [],
    snapshottedAt: "t0",
  });
  s.recordAcSnapshot({
    issue: 7,
    bodyHash: "hash-v2",
    body: "v2 body",
    manifest: [{ id: "1-cafebabe", text: "new criterion" }],
    snapshottedAt: "t1",
  });
  const snap = s.getAcSnapshot(7);
  assert.equal(snap?.bodyHash, "hash-v2");
  assert.equal(snap?.body, "v2 body");
  assert.equal(snap?.snapshottedAt, "t1");
  s.close();
});

// ── #301 review (P3 F7): REAL v22 -> current migration — a populated pre-#283 DB survives ──

test("migration v22->current: a populated v22 DB (predating ac_snapshots/ac_body_hash) opens with data intact, workers.ac_body_hash defaults to NULL, ac_snapshots empty-but-usable, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    // Build a REAL v22 DB: run the shipped migrations 0..21 exactly as that engine would have —
    // BEFORE #283's ac_snapshots (22->23) and #301's workers.ac_body_hash (23->24) ever existed.
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 22; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 22");
    // A pre-#283 driving lane with a PR — exactly the "legacy lane, no AC snapshot ever
    // recorded" shape checkAcDriftBeforeDrive (conductor.ts) must keep driving normally.
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lane-v22", 42, "sess-42", "driving", "2026-07-20T00:00:00Z", null, 99);
    assert.throws(() => raw.prepare("SELECT ac_body_hash FROM workers").get(), "the column genuinely does not exist pre-migration");
    assert.throws(() => raw.prepare("SELECT * FROM ac_snapshots").get(), "the table genuinely does not exist pre-migration");
    raw.close();

    // Open with the CURRENT engine -> migrates 22 -> SCHEMA_VERSION.
    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 24);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    // Pre-existing data survived intact, and the new column defaults to NULL (never treated as
    // drift — see checkAcDriftBeforeDrive's own doc: a null ac_body_hash means "legacy, nothing
    // to check", drive normally).
    const w = s.getWorker("lane-v22");
    assert.equal(w?.issue, 42);
    assert.equal(w?.pr, 99);
    assert.equal(w?.state, "driving");
    assert.equal(w?.ac_body_hash, null);
    // The new table is present and fully usable post-migration.
    assert.equal(s.getAcSnapshot(42), null);
    s.recordAcSnapshot({ issue: 42, bodyHash: "h1", body: "b1", manifest: [], snapshottedAt: "t0" });
    assert.equal(s.getAcSnapshot(42)?.bodyHash, "h1");
    s.close();

    // Idempotent reopen: no re-migration, same version, same data.
    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("lane-v22")?.ac_body_hash, null);
    assert.equal(s2.getAcSnapshot(42)?.bodyHash, "h1");
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #301 review round 3 (P1#1): REAL v23 -> v24 migration — ac_body_hash BACKFILLS from an
//    existing ac_snapshots row, rather than silently discarding drift protection for a worker
//    that already has one recorded. A dev DB opened between the 22->23 and 23->24 commits (or a
//    future engine build that lands them separately) can hold exactly this shape. ──

test("migration v23->v24: ac_body_hash backfills from an existing ac_snapshots row for a worker's issue — a v23 DB with an active worker + a matching snapshot must NOT silently lose drift/ownership protection on upgrade; a worker with no matching snapshot stays genuinely NULL", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    // Build a REAL v23 DB: run migrations 0..22 (through 22->23, which creates ac_snapshots) —
    // BEFORE 23->24 (workers.ac_body_hash) ever ran.
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 23; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 23");
    // A `driving` lane whose dispatch-time snapshot already exists (the shape the backfill must
    // repair) — a `failed`+PR lane awaiting GATED RECLAIM needs the SAME treatment (P1#3), so a
    // second row proves the backfill isn't scoped to `driving` alone.
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lane-v23-driving", 55, "sess-55", "driving", "2026-07-21T00:00:00Z", null, 900);
    raw
      .prepare(
        "INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr, gated_escalation_labeled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("lane-v23-failed", 57, "sess-57", "failed", "2026-07-21T00:00:00Z", "2026-07-21T01:00:00Z", 902, 1);
    raw
      .prepare("INSERT INTO ac_snapshots (issue, body_hash, body, manifest_json, snapshotted_at) VALUES (?, ?, ?, ?, ?)")
      .run(55, "prev-hash-driving", "body text 55", "[]", "2026-07-21T00:00:00Z");
    raw
      .prepare("INSERT INTO ac_snapshots (issue, body_hash, body, manifest_json, snapshotted_at) VALUES (?, ?, ?, ?, ?)")
      .run(57, "prev-hash-failed", "body text 57", "[]", "2026-07-21T00:00:00Z");
    // A worker whose issue has NO matching snapshot row — a genuinely pre-#283/no-snapshot lane
    // — must stay NULL: the backfill must never invent a hash for a lane that never had one.
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("lane-v23-legacy", 56, "sess-56", "running", "2026-07-21T00:00:00Z", null);
    raw.close();

    // Open with the CURRENT engine -> migrates 23 -> SCHEMA_VERSION.
    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 24);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    assert.equal(s.getWorker("lane-v23-driving")?.ac_body_hash, "prev-hash-driving", "backfilled from the existing ac_snapshots row");
    assert.equal(
      s.getWorker("lane-v23-failed")?.ac_body_hash,
      "prev-hash-failed",
      "a failed+PR row awaiting GATED RECLAIM is ALSO backfilled",
    );
    assert.equal(s.getWorker("lane-v23-legacy")?.ac_body_hash, null, "no snapshot existed for this issue -> stays NULL, genuinely legacy");
    // Pre-existing snapshot data itself survived untouched.
    assert.equal(s.getAcSnapshot(55)?.bodyHash, "prev-hash-driving");
    assert.equal(s.getAcSnapshot(57)?.bodyHash, "prev-hash-failed");
    s.close();

    // Idempotent reopen: no re-migration, same version, same data.
    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("lane-v23-driving")?.ac_body_hash, "prev-hash-driving");
    assert.equal(s2.getWorker("lane-v23-legacy")?.ac_body_hash, null);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #234: forge MCP proxy journal + frozen evidence bundles (migration 15->16) ─────────────

test("migration v15->v16: a populated v15 DB opens with data intact, empty forge_proxy_journal/forge_proxy_bundles tables, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 15; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 15");
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, resume_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lane-v15", 4, "sess-4", "done", "2026-07-16T00:00:00Z", "2026-07-16T01:00:00Z", 2);
    assert.throws(() => raw.prepare("SELECT * FROM forge_proxy_journal").get(), "the table doesn't exist yet at v15");
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 16);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    assert.equal(s.getWorker("lane-v15")?.resume_attempts, 2, "pre-existing data survived intact");
    const identity = { roundId: 1, phase: "architecting", role: "architect", session: "s", attempt: 1 };
    assert.deepEqual(s.listForgeProxyJournal(identity), [], "the new table exists and starts empty");
    assert.equal(s.getForgeProxyBundle("nonexistent"), undefined);
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    assert.equal(s2.getWorker("lane-v15")?.resume_attempts, 2);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forge proxy journal: nextForgeProxySeq starts at 1 and increments per (round, phase, role, session, attempt) tuple only", () => {
  const s = mem();
  const identity = { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 };
  assert.equal(s.nextForgeProxySeq(identity), 1);
  s.appendForgeProxyJournalIntent({
    identity,
    seq: 1,
    tool: "issue_details",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-17T00:00:00Z",
  });
  assert.equal(s.nextForgeProxySeq(identity), 2, "a second row for the SAME tuple continues the sequence");
  assert.equal(s.nextForgeProxySeq({ ...identity, attempt: 2 }), 1, "a different attempt starts fresh at 1");
  s.close();
});

test("forge proxy journal: write-ahead round trip — intent -> recordForgeProxyJournalResponse -> markForgeProxyJournalDelivered", () => {
  const s = mem();
  const identity = { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 };
  const id = s.appendForgeProxyJournalIntent({
    identity,
    seq: 1,
    tool: "issue_details",
    proxyVersion: "1",
    argsCanonical: '{"numbers":[1]}',
    scopeCanonical: '{"owner":"o","repo":"r"}',
    capsCanonical: "{}",
    budgetRemainingCalls: 9,
    budgetRemainingBytes: 999_000,
    requestedAt: "2026-07-17T00:00:00Z",
  });
  let row = s.getForgeProxyJournalRow(id)!;
  assert.equal(row.status, "intent");
  assert.equal(row.responseCanonical, null);

  s.recordForgeProxyJournalResponse(id, {
    responseCanonical: '{"number":1}',
    contentHash: "abc123",
    truncated: false,
    fetchedAt: "2026-07-17T00:00:01Z",
    countsCanonical: '{"returned":1}',
  });
  row = s.getForgeProxyJournalRow(id)!;
  assert.equal(row.status, "fetched");
  assert.equal(row.responseCanonical, '{"number":1}');
  assert.equal(row.contentHash, "abc123");

  s.markForgeProxyJournalDelivered(id, "2026-07-17T00:00:02Z");
  row = s.getForgeProxyJournalRow(id)!;
  assert.equal(row.status, "delivered");
  assert.equal(row.deliveredAt, "2026-07-17T00:00:02Z");
  s.close();
});

test("forge proxy journal: recordForgeProxyJournalError records a sanitized error + timed_out flag", () => {
  const s = mem();
  const identity = { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 };
  const id = s.appendForgeProxyJournalIntent({
    identity,
    seq: 1,
    tool: "search_issues",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    requestedAt: "2026-07-17T00:00:00Z",
  });
  s.recordForgeProxyJournalError(id, "upstream timed out", true, "2026-07-17T00:00:05Z");
  const row = s.getForgeProxyJournalRow(id)!;
  assert.equal(row.status, "error");
  assert.equal(row.error, "upstream timed out");
  assert.equal(row.timedOut, true);
  s.close();
});

test("forgeProxyUsage: sums call count + response bytes for 'fetched'/'delivered'/'error' rows, scoped to the exact identity tuple", () => {
  const s = mem();
  const identity = { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 };
  const id1 = s.appendForgeProxyJournalIntent({
    identity,
    seq: 1,
    tool: "t",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    requestedAt: "t",
  });
  s.recordForgeProxyJournalResponse(id1, { responseCanonical: "0123456789", contentHash: "h", truncated: false, fetchedAt: "t" });
  const id2 = s.appendForgeProxyJournalIntent({
    identity,
    seq: 2,
    tool: "t",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    requestedAt: "t",
  });
  s.recordForgeProxyJournalError(id2, "boom", false, "t");
  // A different attempt's rows must not bleed into this identity's usage.
  const otherId = s.appendForgeProxyJournalIntent({
    identity: { ...identity, attempt: 2 },
    seq: 1,
    tool: "t",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    requestedAt: "t",
  });
  s.recordForgeProxyJournalResponse(otherId, { responseCanonical: "should not count", contentHash: "h", truncated: false, fetchedAt: "t" });

  const usage = s.forgeProxyUsage(identity);
  assert.equal(usage.calls, 2, "fetched + error rows both count toward the call budget");
  assert.equal(usage.bytes, 10, "only fetched/delivered rows' response bytes count");
  s.close();
});

test("forge proxy bundles: forgeProxyBundleDir null for in-memory State, recordForgeProxyBundle/getForgeProxyBundle round-trip by content hash", () => {
  const s = mem();
  assert.equal(s.forgeProxyBundleDir(), null);
  const row = {
    hash: "deadbeef",
    identity: { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc" },
    decisionRef: "architect-contradiction-1",
    byteSize: 42,
    path: null,
    createdAt: "2026-07-17T00:00:00Z",
  };
  s.recordForgeProxyBundle(row);
  assert.deepEqual(s.getForgeProxyBundle("deadbeef"), row);
  assert.equal(s.getForgeProxyBundle("nonexistent"), undefined);
  s.close();
});

test("forge proxy bundles: recordForgeProxyBundle is idempotent on hash — a second write with a DIFFERENT decisionRef does not overwrite the first", () => {
  const s = mem();
  const base = { hash: "h1", identity: { roundId: 1, phase: "p", role: "r", session: "s" }, byteSize: 1, path: null, createdAt: "t1" };
  s.recordForgeProxyBundle({ ...base, decisionRef: "first" });
  s.recordForgeProxyBundle({ ...base, decisionRef: "second", createdAt: "t2" });
  assert.equal(s.getForgeProxyBundle("h1")?.decisionRef, "first");
  s.close();
});

// ── #287 (E4b): actual-model early signal + engine-agent attempt pin/WAL ───────────────────────

test("recordWorkerActualModel/getWorkerActualModels: an EARLY observed model is visible even with NO spend_ledger rows (the driving-lane gap #287 closes)", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  assert.deepEqual(s.getWorkerActualModels(100), [], "nothing observed yet");
  s.recordWorkerActualModel("lane-1", "claude-sonnet-4-5");
  assert.deepEqual(s.getWorkerActualModels(100), ["claude-sonnet-4-5"]);
  s.close();
});

test("recordWorkerActualModel: 'unknown' and empty strings are never recorded", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.recordWorkerActualModel("lane-1", "unknown");
  s.recordWorkerActualModel("lane-1", "");
  assert.deepEqual(s.getWorkerActualModels(100), []);
  s.close();
});

test("recordWorkerActualModel: union-append, idempotent — recording the SAME model twice never duplicates", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "running", started_at: "t", ended_at: null });
  s.recordWorkerActualModel("lane-1", "opus");
  s.recordWorkerActualModel("lane-1", "opus");
  s.recordWorkerActualModel("lane-1", "sonnet");
  assert.deepEqual(s.getWorkerActualModels(100), ["opus", "sonnet"]);
  s.close();
});

test("recordWorkerActualModel: a no-op for a name with no worker row (never throws)", () => {
  const s = mem();
  assert.doesNotThrow(() => s.recordWorkerActualModel("ghost", "opus"));
  s.close();
});

test("getWorkerActualModels: UNIONS the early per-lane record with spend_ledger's settled models — never a duplicate, never dropping either source", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordWorkerActualModel("lane-1", "opus"); // the early signal
  s.recordSpend("lane-1", 100, 1.5, "2026-01-01T00:00:00Z", [
    { model: "opus", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { model: "haiku", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ]);
  assert.deepEqual(s.getWorkerActualModels(100), ["haiku", "opus"]);
  s.close();
});

test("recordEngineReviewAttemptPin/getEngineReviewAttemptPin: round-trips a pin exactly, null for a lane never pinned", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  assert.equal(s.getEngineReviewAttemptPin("lane-1"), null);
  s.recordEngineReviewAttemptPin("lane-1", { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" });
  assert.deepEqual(s.getEngineReviewAttemptPin("lane-1"), {
    head: "H1",
    at: "2026-01-01T00:00:00.000Z",
    runId: "run-1",
    kind: "unavailable",
  });
  s.close();
});

test("recordEngineReviewAttemptPin(name, null): clears the pin — a head change's lifecycle", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewAttemptPin("lane-1", { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" });
  s.recordEngineReviewAttemptPin("lane-1", null);
  assert.equal(s.getEngineReviewAttemptPin("lane-1"), null);
  s.close();
});

test("recordEngineReviewAttemptPin: engine_review_first_attempt_at is set ONCE per head and left untouched on every subsequent same-head write (the #54 failover clock's own companion)", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewAttemptPin("lane-1", { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" });
  assert.equal(s.getWorker("lane-1")?.engine_review_first_attempt_at, "2026-01-01T00:00:00.000Z");
  // A LATER attempt on the SAME head — 'at' advances, first_attempt_at must NOT.
  s.recordEngineReviewAttemptPin("lane-1", { head: "H1", at: "2026-01-01T00:20:00.000Z", runId: "run-2", kind: "unavailable" });
  assert.equal(
    s.getWorker("lane-1")?.engine_review_first_attempt_at,
    "2026-01-01T00:00:00.000Z",
    "unchanged across retries on the same head",
  );
  assert.equal(s.getWorker("lane-1")?.engine_review_pin_at, "2026-01-01T00:20:00.000Z");
  // A NEW head resets it.
  s.recordEngineReviewAttemptPin("lane-1", { head: "H2", at: "2026-01-01T01:00:00.000Z", runId: "run-3", kind: "unavailable" });
  assert.equal(s.getWorker("lane-1")?.engine_review_first_attempt_at, "2026-01-01T01:00:00.000Z");
  s.close();
});

test("getEngineReviewAttemptPin: an unrecognized engine_review_pin_kind string fails closed to 'no pin' (read-boundary validation, mirrors review_fallback_kind's own stance)", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewAttemptPin("lane-1", { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" });
  // Simulate a corrupt/forged column value directly.
  (s as unknown as { db: DatabaseSync }).db.prepare("UPDATE workers SET engine_review_pin_kind = 'bogus' WHERE name = ?").run("lane-1");
  assert.equal(s.getEngineReviewAttemptPin("lane-1"), null);
  s.close();
});

test("recordEngineReviewWal/getEngineReviewWal: round-trips a WAL record, null for a lane never recorded", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  assert.equal(s.getEngineReviewWal("lane-1"), null);
  s.recordEngineReviewWal("lane-1", { runId: "run-1", head: "H1", base: "B1", diffHash: "d1", attemptStart: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(s.getEngineReviewWal("lane-1"), {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d1",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: null,
    reviewArtifactJson: null,
    auditCommentId: null,
    auditDeliveredAt: null,
  });
  s.close();
});

test("recordEngineReviewWal: upsert-by-worker_name — a FRESH attempt supersedes the prior one entirely (never append-only), clearing the old manifest hash/decisive outcome", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewWal("lane-1", { runId: "run-1", head: "H1", base: "B1", diffHash: "d1", attemptStart: "t1" });
  s.updateEngineReviewWalManifestHash("lane-1", "run-1", "manifest-hash-1");
  s.recordEngineReviewWalDecisiveOutcome("lane-1", "run-1", "approved");
  assert.equal(s.getEngineReviewWal("lane-1")?.treeManifestHash, "manifest-hash-1");
  // A NEW attempt (crash-restart / backoff-expiry retry) overwrites the row wholesale.
  s.recordEngineReviewWal("lane-1", { runId: "run-2", head: "H1", base: "B1", diffHash: "d2", attemptStart: "t2" });
  const wal = s.getEngineReviewWal("lane-1");
  assert.equal(wal?.runId, "run-2");
  assert.equal(wal?.treeManifestHash, null, "the prior attempt's manifest hash must not leak onto the new attempt");
  assert.equal(wal?.decisiveOutcome, null);
  s.close();
});

test("getLiveEngineReviewHeads: returns distinct non-decisive heads, fail-closed on an invalid outcome, and excludes decisive rows", () => {
  const s = mem();
  for (const name of ["lane-1", "lane-2", "lane-3"]) {
    s.upsertWorker({ name, issue: 100, session_id: name, state: "driving", started_at: "t", ended_at: null, pr: 900 });
  }
  s.recordEngineReviewWal("lane-1", { runId: "r1", head: "H-live", base: "B", diffHash: "D", attemptStart: "t" });
  s.recordEngineReviewWal("lane-2", { runId: "r2", head: "H-corrupt", base: "B", diffHash: "D", attemptStart: "t" });
  s.recordEngineReviewWal("lane-3", { runId: "r3", head: "H-done", base: "B", diffHash: "D", attemptStart: "t" });
  s.recordEngineReviewWalDecisiveOutcome("lane-3", "r3", "approved");
  (s as unknown as { db: DatabaseSync }).db
    .prepare("UPDATE engine_review_wal SET decisive_outcome = 'invalid' WHERE worker_name = 'lane-2'")
    .run();
  assert.deepEqual(s.getLiveEngineReviewHeads(), ["H-corrupt", "H-live"]);
  s.close();
});

test("updateEngineReviewWalManifestHash/recordEngineReviewWalDecisiveOutcome: guarded by runId — a write for a SUPERSEDED runId never lands on the current row", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewWal("lane-1", { runId: "run-1", head: "H1", base: "B1", diffHash: "d1", attemptStart: "t1" });
  s.recordEngineReviewWal("lane-1", { runId: "run-2", head: "H1", base: "B1", diffHash: "d2", attemptStart: "t2" }); // supersedes run-1
  // A late-arriving completion for the SUPERSEDED run-1 must not corrupt run-2's row.
  s.updateEngineReviewWalManifestHash("lane-1", "run-1", "stale-hash");
  s.recordEngineReviewWalDecisiveOutcome("lane-1", "run-1", "approved");
  const wal = s.getEngineReviewWal("lane-1");
  assert.equal(wal?.runId, "run-2");
  assert.equal(wal?.treeManifestHash, null);
  assert.equal(wal?.decisiveOutcome, null);
  s.close();
});

test("#288 WAL artifact + audit receipt writes are runId-guarded and round-trip field-for-field", () => {
  const s = mem();
  s.upsertWorker({ name: "lane-1", issue: 100, session_id: "s1", state: "driving", started_at: "t", ended_at: null, pr: 900 });
  s.recordEngineReviewWal("lane-1", { runId: "run-2", head: "H", base: "B", diffHash: "D", attemptStart: "t" });
  assert.equal(s.recordEngineReviewWalArtifact("lane-1", "stale", "approved", "{}"), false);
  assert.equal(s.recordEngineReviewWalArtifact("lane-1", "run-2", "rejected", '{"perAC":[]}'), true);
  assert.equal(s.recordEngineReviewAuditReceipt("lane-1", "stale", "IC0", "old"), false);
  assert.equal(s.recordEngineReviewAuditReceipt("lane-1", "run-2", "IC2", "2026-01-01T00:00:00Z"), true);
  const wal = s.getEngineReviewWal("lane-1");
  assert.equal(wal?.decisiveOutcome, "rejected");
  assert.equal(wal?.reviewArtifactJson, '{"perAC":[]}');
  assert.equal(wal?.auditCommentId, "IC2");
  assert.equal(wal?.auditDeliveredAt, "2026-01-01T00:00:00Z");
  s.close();
});

test("migration v24->current: a populated v24 DB (predating engine_review_wal/actual_models_json/engine_review_pin_*) opens with data intact, every new worker column NULL, engine_review_wal empty-but-usable, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 24; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 24");
    raw
      .prepare("INSERT INTO workers (name, issue, session_id, state, started_at, ended_at, pr) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lane-v24", 200, "sess-200", "driving", "2026-07-22T00:00:00Z", null, 950);
    raw.close();

    const s = new State(dbPath);
    assert.ok(SCHEMA_VERSION >= 25);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    const row = s.getWorker("lane-v24");
    assert.equal(row?.issue, 200, "pre-existing data intact");
    assert.equal(row?.actual_models_json, null);
    assert.equal(row?.engine_review_pin_head, null);
    assert.equal(s.getEngineReviewAttemptPin("lane-v24"), null);
    assert.equal(s.getEngineReviewWal("lane-v24"), null);
    // idempotent reopen
    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    s2.close();
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v25->v26 clears a decisive engine-review pin whose WAL has no verifiable audit receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 25; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 25");
    raw
      .prepare(
        `INSERT INTO workers (
          name, issue, session_id, state, started_at, ended_at, pr,
          engine_review_pin_head, engine_review_pin_at, engine_review_pin_run_id,
          engine_review_pin_kind, engine_review_first_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "lane-v25",
        201,
        "sess-201",
        "driving",
        "2026-07-22T00:00:00Z",
        null,
        951,
        "H1",
        "2026-07-22T00:01:00Z",
        "run-v25",
        "decisive",
        "2026-07-22T00:01:00Z",
      );
    raw
      .prepare(
        `INSERT INTO engine_review_wal (
          worker_name, run_id, head, base, diff_hash, tree_manifest_hash,
          attempt_start, decisive_outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("lane-v25", "run-v25", "H1", "B1", "D1", "manifest", "2026-07-22T00:01:00Z", "approved");
    raw.close();

    const s = new State(dbPath);
    assert.equal(SCHEMA_VERSION, 28);
    assert.equal(s.userVersion(), 28);
    assert.equal(s.getEngineReviewAttemptPin("lane-v25"), null, "the lane is re-reviewable on its unchanged head");
    const row = s.getWorker("lane-v25");
    assert.equal(row?.engine_review_pin_head, null);
    assert.equal(row?.engine_review_pin_at, null);
    assert.equal(row?.engine_review_pin_run_id, null);
    assert.equal(row?.engine_review_pin_kind, null);
    assert.equal(row?.engine_review_first_attempt_at, null);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v26->v27: a populated v26 DB (predating park_state.reset_hint_at) opens with data intact, the open episode's reset_hint_at NULL, user_version SCHEMA_VERSION, idempotent reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 26; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 26");
    raw
      .prepare(
        `INSERT INTO park_state (source, reason, trigger_issue, entered_at, last_probe_at, probe_attempts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("llm", "pre-existing v26 episode", 42, "2026-07-24T00:00:00Z", "2026-07-24T00:00:00Z", 0);
    raw.close();

    const s = new State(dbPath);
    assert.equal(SCHEMA_VERSION, 28);
    assert.equal(s.userVersion(), 28);
    const row = s.parkRow("llm");
    assert.equal(row?.reason, "pre-existing v26 episode");
    assert.equal(row?.triggerIssue, 42);
    assert.equal(row?.resetHintAt, null, "a pre-#374 episode has no hint — probeDueWithHint treats this as 'no hint'");
    s.close();

    const s2 = new State(dbPath);
    assert.equal(s2.userVersion(), SCHEMA_VERSION);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v27->v28 (#431): a populated v27 DB opens with its park episode intact, and the widened CHECK now admits a rapid-restart episode (the old CHECK swallowed it silently via INSERT OR IGNORE)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < 27; v++) MIGRATIONS[v]!(raw);
    raw.exec("PRAGMA user_version = 27");
    raw
      .prepare(
        `INSERT INTO park_state (source, reason, trigger_issue, entered_at, last_probe_at, probe_attempts, reset_hint_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("llm", "pre-existing v27 episode", 7, "2026-07-30T00:00:00Z", "2026-07-30T00:00:00Z", 3, "2026-07-30T01:00:00Z");
    raw.close();

    const s = new State(dbPath);
    assert.equal(s.userVersion(), SCHEMA_VERSION);
    const llm = s.parkRow("llm");
    assert.equal(llm?.reason, "pre-existing v27 episode");
    assert.equal(llm?.probeAttempts, 3, "every copied column survives the recreate-and-copy");
    assert.equal(llm?.resetHintAt, "2026-07-30T01:00:00Z");
    assert.equal(s.enterPark("rapid-restart", "crash loop", null, "2026-07-31T00:00:00Z"), true, "the widened CHECK admits the row");
    assert.equal(s.parkRow("rapid-restart")?.reason, "crash loop");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #142: dashboard reads (docs/frontend-design.md §8) ──────────────────────────────────────

test("lastTickAt reads the heartbeat WITHOUT moving it (the #395 watchdog and the dashboard are spectators, never writers)", () => {
  const s = mem();
  assert.equal(s.lastTickAt(), null, "no heartbeat row yet — the engine has never ticked here");

  s.touchLastTick(new Date("2026-07-24T10:00:00.000Z"));
  assert.equal(s.lastTickAt(), "2026-07-24T10:00:00.000Z");
  // Reading twice must not touch last_tick_at — touchLastTick is the ONLY writer (#431: the
  // heartbeat survives the session-machinery deletion for exactly these two readers).
  assert.equal(s.lastTickAt(), "2026-07-24T10:00:00.000Z");
  s.close();
});

test("countEventsSince (#431): counts one kind within the ts window — the rapid-restart detector's birth count", () => {
  const s = mem();
  assert.equal(s.countEventsSince("1970-01-01T00:00:00.000Z", "run-started"), 0);
  s.appendEvent("run-started", {});
  s.appendEvent("run-started", {});
  s.appendEvent("park-wait-heartbeat", { parked: false }); // a different kind can never inflate the birth count
  s.appendEvent("run-started", {});
  // appendEvent stamps the REAL machine clock (its own doc — deliberate), so the window edges
  // are asserted with cutoffs unreachably far on either side: epoch (everything counts) and
  // far-future (nothing does). No assertion depends on how fast the appends ran.
  assert.equal(s.countEventsSince("1970-01-01T00:00:00.000Z", "run-started"), 3);
  assert.equal(s.countEventsSince("2999-01-01T00:00:00.000Z", "run-started"), 0, "births before the cutoff never count");
  s.close();
});

test("countEvents counts one kind only (§8's ring count)", () => {
  const s = mem();
  assert.equal(s.countEvents("merged"), 0);
  s.appendEvent("merged", { pr: 1 });
  s.appendEvent("dispatched", { issue: 2 });
  s.appendEvent("merged", { pr: 3 });
  assert.equal(s.countEvents("merged"), 2);
  assert.equal(s.countEvents("dispatched"), 1);
  s.close();
});

test("eventsPage pages ascending by id across every kind, with id/ts/payload", () => {
  const s = mem();
  for (let i = 1; i <= 5; i++) s.appendEvent(`kind-${i}`, { n: i });

  const first = s.eventsPage(0, 2);
  assert.deepEqual(
    first.map((e) => e.id),
    [1, 2],
  );
  assert.deepEqual(first[0], { id: 1, ts: first[0]!.ts, kind: "kind-1", payload: { n: 1 } });
  assert.ok(first[0]!.ts.length > 0);

  assert.deepEqual(
    s.eventsPage(2, 2).map((e) => e.kind),
    ["kind-3", "kind-4"],
  );
  assert.deepEqual(s.eventsPage(5, 10), [], "past the tail is empty, not an error");
  s.close();
});

test("eventsPage serves a corrupt payload as null rather than failing the whole page", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-state-"));
  try {
    const dbPath = join(dir, "s.sqlite");
    const s = new State(dbPath);
    s.appendEvent("merged", { pr: 1 });
    s.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run("2026-07-24T00:00:00Z", "legacy", "not json");
    raw.close();

    const s2 = new State(dbPath);
    const page = s2.eventsPage(0, 10);
    assert.equal(page.length, 2);
    assert.deepEqual(page[0]!.payload, { pr: 1 });
    assert.equal(page[1]!.payload, null);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spendByModelForDay groups the day's ledger by model, biggest spender first", () => {
  const s = mem();
  const models = (model: string, i: number, o: number): ModelUsageEntry[] => [
    { model, inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ];
  s.recordSpend("w1", 1, 1.25, "2026-07-24T11:30:00.000Z", models("opus", 100, 20));
  s.recordSpend("w2", 2, 0.75, "2026-07-24T12:00:00.000Z", models("sonnet", 50, 10));
  s.recordSpend("w3", 3, 2.0, "2026-07-24T13:00:00.000Z", models("opus", 200, 40));
  s.recordSpend("w4", 4, 99.0, "2026-07-23T23:59:59.000Z", models("opus", 1, 1)); // yesterday

  assert.deepEqual(s.spendByModelForDay(new Date("2026-07-24T18:00:00.000Z")), [
    { model: "opus", usd: 3.25, inputTokens: 300, outputTokens: 60 },
    { model: "sonnet", usd: 0.75, inputTokens: 50, outputTokens: 10 },
  ]);
  // Same day window as dailySpendUsd — the group sums and the headline can never disagree.
  assert.equal(
    s.spendByModelForDay(new Date("2026-07-24T18:00:00.000Z")).reduce((a, r) => a + r.usd, 0),
    s.dailySpendUsd(new Date("2026-07-24T18:00:00.000Z")),
  );
  assert.deepEqual(s.spendByModelForDay(new Date("2026-07-25T00:00:00.000Z")), [], "a quiet day groups to nothing");
  s.close();
});

// ── #360: the dashboard's remaining read transports (spend paging, the rounds spine) ───────

test("spendPage pages the ledger ascending by id, rows verbatim", () => {
  const s = mem();
  const models = (model: string): ModelUsageEntry[] => [
    { model, inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 40 },
  ];
  s.recordSpend("w1", 86, 1.25, "2026-07-24T11:30:00.000Z", models("opus"));
  s.recordSpend("w2", 88, 0.75, "2026-07-24T11:31:00.000Z", models("sonnet"));
  s.recordSpend("w3", 90, 0.5, "2026-07-24T11:32:00.000Z");

  const first = s.spendPage(0, 2);
  assert.deepEqual(
    first.map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(first[0], {
    id: 1,
    ts: "2026-07-24T11:30:00.000Z",
    worker: "w1",
    issue: 86,
    usd: 1.25,
    model: "opus",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheCreationTokens: 40,
  });
  assert.equal(s.spendPage(2, 10)[0]?.model, "unknown", "a model-less leg keeps recordSpend's own 'unknown' row");
  assert.deepEqual(s.spendPage(3, 10), [], "past the tail is empty, not an error");
  s.close();
});

test("listRounds is the rounds spine: every row, artifact left-joined, cursors and event counts", () => {
  const s = mem();
  // Round 1: two events inside its window, closed WITH an artifact.
  s.appendEvent("before", {}); // id 1 — belongs to no round
  const r1 = s.startRound("2026-07-24T10:00:00.000Z");
  s.appendEvent("dispatched", { issue: 86 });
  s.appendEvent("merged", { pr: 94 });
  s.closeRound(r1.round_id, "2026-07-24T11:00:00.000Z");
  s.saveRoundArtifact(r1.round_id, 1, JSON.stringify({ roundId: 1, merged: [94] }), "2026-07-24T11:00:01.000Z");
  // Round 2: one event, closed WITHOUT an artifact (the crash-between-close-and-save case).
  const r2 = s.startRound("2026-07-24T12:00:00.000Z");
  s.appendEvent("dispatched", { issue: 88 });
  s.closeRound(r2.round_id, "2026-07-24T13:00:00.000Z");
  // Round 3: still open, no events yet.
  s.startRound("2026-07-24T14:00:00.000Z");

  const rounds = s.listRounds();
  assert.deepEqual(
    rounds.map((r) => r.roundId),
    [1, 2, 3],
    "ascending, and an artifact-less round is NOT dropped",
  );

  assert.deepEqual(rounds[0], {
    roundId: 1,
    status: "done",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T11:00:00.000Z",
    startEventId: 1,
    startSpendId: 0,
    eventCount: 2,
    schemaVersion: 1,
    artifact: { roundId: 1, merged: [94] },
  });

  assert.equal(rounds[1]!.schemaVersion, null, "no artifact — tally-less, honestly");
  assert.equal(rounds[1]!.artifact, null);
  assert.equal(rounds[1]!.eventCount, 1);
  assert.equal(rounds[1]!.startEventId, 3);

  assert.equal(rounds[2]!.status, "in_progress");
  assert.equal(rounds[2]!.endedAt, null);
  assert.equal(rounds[2]!.eventCount, 0, "an open round with no events of its own counts none");
  s.close();
});
