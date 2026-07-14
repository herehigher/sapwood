// round-artifact.test.ts (#123): the engine-built round summary artifact. assembleRoundArtifact
// is pure (ledger rows in -> artifact out) — every test below constructs its `events` fixture
// literally, no state/forge mocks needed. buildRoundArtifact/persistRoundArtifact's thin
// state-reading/writing wrappers get their own smaller, focused tests; the round.ts integration
// ("artifact exists after closeRound") lives in round.test.ts, next to the loop that calls it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleRoundArtifact, buildRoundArtifact, persistRoundArtifact, renderRoundArtifactMarkdown,
  capRoundArtifactMarkdown, RoundArtifactSchema, ROUND_ARTIFACT_SCHEMA_VERSION,
  ROUND_ARTIFACT_EVENT_KINDS, type RoundArtifact,
} from "./round-artifact.js";
import { State } from "../state/state.js";

const meta = { roundId: 1, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T01:00:00.000Z" };

test("assembleRoundArtifact: an empty ledger produces an empty-but-valid artifact", () => {
  const artifact = assembleRoundArtifact([], meta, 0, 30);
  const parsed = RoundArtifactSchema.parse(artifact); // throws on any schema mismatch
  assert.equal(parsed.schemaVersion, ROUND_ARTIFACT_SCHEMA_VERSION);
  assert.equal(parsed.roundId, 1);
  assert.deepEqual(parsed.dispatches, []);
  assert.deepEqual(parsed.merges, []);
  assert.equal(parsed.prsOpened, 0);
  assert.equal(parsed.prsMerged, 0);
  assert.equal(parsed.issuesClosed, 0);
  assert.equal(parsed.spendUsd, 0);
  assert.equal(parsed.roundBudgetUsd, 30);
  assert.deepEqual(parsed.escalations, { needsHuman: [], ceiling: 0, driveNoPr: 0 });
  assert.equal(parsed.align, null);
  assert.deepEqual(parsed.retro, { opened: null, degraded: null });
});

test("assembleRoundArtifact: dispatches + merges are collected verbatim, in ledger order", () => {
  const events = [
    { kind: "dispatched", payload: { worker: "lane-1", issue: 1 } },
    { kind: "dispatched", payload: { worker: "lane-2", issue: 2 } },
    { kind: "merged", payload: { worker: "lane-1", issue: 1, pr: 10, headOid: "h1" } },
  ];
  const artifact = assembleRoundArtifact(events, meta, 4, 30);
  assert.deepEqual(artifact.dispatches, [{ issue: 1, worker: "lane-1" }, { issue: 2, worker: "lane-2" }]);
  assert.deepEqual(artifact.merges, [{ issue: 1, worker: "lane-1", pr: 10 }]);
  assert.equal(artifact.prsMerged, 1);
  assert.equal(artifact.issuesClosed, 1);
});

test("assembleRoundArtifact: prsOpened counts reclaim-done/failed->DRIVING and rescued reclaim-dead, never a non-driving/non-rescued reclaim", () => {
  const events = [
    { kind: "reclaim-done", payload: { worker: "lane-a", issue: 1, next: "DRIVING" } },
    { kind: "reclaim-failed", payload: { worker: "lane-b", issue: 2, next: "DRIVING" } },
    { kind: "reclaim-failed", payload: { worker: "lane-c", issue: 3, next: "ESCALATE" } },
    { kind: "reclaim-dead", payload: { worker: "lane-d", issue: 4, rescued: true } },
    { kind: "reclaim-dead", payload: { worker: "lane-e", issue: 5, rescued: false } },
  ];
  const artifact = assembleRoundArtifact(events, meta, 0, 30);
  assert.equal(artifact.prsOpened, 3);
});

test("assembleRoundArtifact: needs-human dedupes across drive-needs-human and plan-review-escalated, preserving first-seen order", () => {
  const events = [
    { kind: "drive-needs-human", payload: { worker: "lane-a", issue: 6, pr: 1, reason: "x" } },
    { kind: "plan-review-escalated", payload: { round_id: 1, issue: 5, reason: "y" } },
    { kind: "drive-needs-human", payload: { worker: "lane-a", issue: 6, pr: 1, reason: "again" } },
  ];
  const artifact = assembleRoundArtifact(events, meta, 0, 30);
  assert.deepEqual(artifact.escalations.needsHuman, [6, 5]);
});

test("assembleRoundArtifact: retries, review-fallback episodes, ceiling/drive-no-pr/handoff counts", () => {
  const events = [
    { kind: "gated-reentry", payload: { worker: "lane-a", issue: 1, pr: 5, attempt: 1 } },
    { kind: "gated-reentry", payload: { worker: "lane-a", issue: 1, pr: 5, attempt: 2 } },
    { kind: "gated-reentry-capped", payload: { worker: "lane-a", issue: 1, pr: 5, attempts: 3 } },
    { kind: "rollback-recovered", payload: { issue: 2, target: "ready", reason: "dispatch-rollback" } },
    { kind: "rollback-escalated", payload: { issue: 3, target: "ready", reason: "dead-lane-requeue", attempts: 5, error: "x" } },
    { kind: "reviewer-fallback-switch", payload: { worker: "lane-a", issue: 1, pr: 5, mode: "same-model-trusted", head: "h1" } },
    { kind: "reviewer-fallback-revert", payload: { worker: "lane-a", issue: 1, pr: 5, mode: "different-model-codex", head: "h2" } },
    { kind: "ceiling-escalated", payload: { worker: "lane-b", issue: 9, reasons: ["dailyBudgetUsd"] } },
    { kind: "drive-no-pr", payload: { worker: "lane-c", issue: 10 } },
    { kind: "handoff", payload: { worker: "lane-d", issue: 11 } },
    { kind: "handoff", payload: { worker: "lane-e", issue: 12 } },
  ];
  const artifact = assembleRoundArtifact(events, meta, 0, 30);
  assert.deepEqual(artifact.retries, {
    gatedReentries: 2, gatedReentryCapped: 1, rollbacksRecovered: 1, rollbacksEscalated: 1,
  });
  assert.deepEqual(artifact.reviewRounds, { reviewerFallbackSwitches: 1, reviewerFallbackReverts: 1 });
  assert.equal(artifact.escalations.ceiling, 1);
  assert.equal(artifact.escalations.driveNoPr, 1);
  assert.equal(artifact.handoffs, 2);
});

test("assembleRoundArtifact: round-stop hits and *-degraded events map to named phases", () => {
  const events = [
    { kind: "round-stop", payload: { round_id: 1, name: "roundDispatchCap", detail: "dispatched 2" } },
    { kind: "po-degraded", payload: { round_id: 1, outcome: "failed", session: "s1", reason: "x" } },
    { kind: "triage-degraded", payload: { round_id: 1, issue: 9, outcome: "no-plan-after-draft" } },
    { kind: "architect-degraded", payload: { round_id: 1, outcome: "done", session: "s2" } },
    { kind: "harvest-degraded", payload: { round_id: 1, outcome: "done", session: "s3", attempts: 2 } },
    { kind: "retro-degraded", payload: { round_id: 1, outcome: "failed", session: "s4" } },
  ];
  const artifact = assembleRoundArtifact(events, meta, 0, 30);
  assert.deepEqual(artifact.roundStops, [{ name: "roundDispatchCap", detail: "dispatched 2" }]);
  assert.deepEqual(artifact.degradedPhases, [
    { phase: "po-align", outcome: "failed", session: "s1" },
    // outcome is recorded VERBATIM when the payload carries one; "unknown" is only the
    // missing-field fallback (session here — triage-degraded's payload has no session field).
    { phase: "po-triage", outcome: "no-plan-after-draft", session: "unknown" },
    { phase: "architect", outcome: "done", session: "s2" },
    { phase: "harvest", outcome: "done", session: "s3" },
    { phase: "retro", outcome: "failed", session: "s4" },
  ]);
});

test("assembleRoundArtifact: retro-pr-opened/-degraded populate the retro section, last event wins", () => {
  const opened = assembleRoundArtifact(
    [{ kind: "retro-pr-opened", payload: { round_id: 1, pr: 5, branch: "retro/x" } }], meta, 0, 30,
  );
  assert.deepEqual(opened.retro, { opened: { pr: 5, branch: "retro/x" }, degraded: null });

  const degraded = assembleRoundArtifact(
    [{ kind: "retro-pr-degraded", payload: { round_id: 1, branch: "retro/y", title: "t", reason: "push not verified" } }],
    meta, 0, 30,
  );
  assert.deepEqual(degraded.retro, { opened: null, degraded: { branch: "retro/y", title: "t", reason: "push not verified" } });

  // Codex P2 (PR #152): the outcomes are mutually exclusive across KINDS too — a crash-rerun
  // logging opened THEN degraded (rerun fails on the already-existing branch) records the later
  // outcome alone, never both; and vice versa.
  const openedThenDegraded = assembleRoundArtifact(
    [
      { kind: "retro-pr-opened", payload: { round_id: 1, pr: 5, branch: "retro/x" } },
      { kind: "retro-pr-degraded", payload: { round_id: 1, branch: "retro/x", title: "t", reason: "branch exists" } },
    ], meta, 0, 30,
  );
  assert.deepEqual(openedThenDegraded.retro, { opened: null, degraded: { branch: "retro/x", title: "t", reason: "branch exists" } });
  const degradedThenOpened = assembleRoundArtifact(
    [
      { kind: "retro-pr-degraded", payload: { round_id: 1, branch: "retro/x", title: "t", reason: "transient" } },
      { kind: "retro-pr-opened", payload: { round_id: 1, pr: 6, branch: "retro/x" } },
    ], meta, 0, 30,
  );
  assert.deepEqual(degradedThenOpened.retro, { opened: { pr: 6, branch: "retro/x" }, degraded: null });
});

test("assembleRoundArtifact: align-summary populates the align section verbatim; absent -> null", () => {
  const withAlign = assembleRoundArtifact(
    [{
      kind: "align-summary",
      payload: {
        round_id: 1,
        created: [{ issue: 20, title: "new idea", hasPlan: true }],
        triaged: [{ issue: 21, drafted: false }],
      },
    }],
    meta, 0, 30,
  );
  assert.deepEqual(withAlign.align, {
    created: [{ issue: 20, title: "new idea", hasPlan: true }],
    triaged: [{ issue: 21, drafted: false }],
  });
  const withoutAlign = assembleRoundArtifact([], meta, 0, 30);
  assert.equal(withoutAlign.align, null);
});

test("assembleRoundArtifact: two align-summary events (crash-rerun) MERGE — created unions by issue, triage outcome last-wins (Codex round-6 P2, PR #152)", () => {
  const artifact = assembleRoundArtifact(
    [
      { kind: "align-summary", payload: { round_id: 1, created: [{ issue: 10, title: "a", hasPlan: true }], triaged: [{ issue: 9, drafted: false }] } },
      { kind: "align-summary", payload: { round_id: 1, created: [{ issue: 11, title: "b", hasPlan: false }], triaged: [{ issue: 9, drafted: true }] } },
    ],
    meta, 0, 30,
  );
  assert.deepEqual(artifact.align, {
    created: [{ issue: 10, title: "a", hasPlan: true }, { issue: 11, title: "b", hasPlan: false }],
    triaged: [{ issue: 9, drafted: true }],
  });
});

test("assembleRoundArtifact: an unrecognized event kind is ignored, never throws (forward-compat)", () => {
  const artifact = assembleRoundArtifact([{ kind: "some-future-event", payload: { whatever: true } }], meta, 0, 30);
  const parsed = RoundArtifactSchema.parse(artifact);
  assert.equal(parsed.roundId, 1);
});

test("ROUND_ARTIFACT_EVENT_KINDS: never includes the run-scoped standby events (design guidance #6)", () => {
  assert.ok(!ROUND_ARTIFACT_EVENT_KINDS.includes("standby-wait"));
  assert.ok(!ROUND_ARTIFACT_EVENT_KINDS.includes("standby-exit"));
});

// ── renderRoundArtifactMarkdown: deterministic view, never independently authored ───────────

test("renderRoundArtifactMarkdown: same artifact -> byte-identical markdown every time (deterministic)", () => {
  const artifact = assembleRoundArtifact(
    [
      { kind: "dispatched", payload: { worker: "lane-1", issue: 1 } },
      { kind: "merged", payload: { worker: "lane-1", issue: 1, pr: 10 } },
      { kind: "drive-needs-human", payload: { worker: "lane-2", issue: 2, pr: 11, reason: "x" } },
    ],
    meta, 4.2, 30,
  );
  const a = renderRoundArtifactMarkdown(artifact);
  const b = renderRoundArtifactMarkdown(artifact);
  assert.equal(a, b);
  assert.ok(a.includes("Round #1 summary"));
  assert.ok(a.includes("PRs merged: 1"));
  assert.ok(a.includes("#2"));
  assert.ok(a.includes("$4.20 of the $30.00 round budget"));
});

test("renderRoundArtifactMarkdown: an empty artifact renders '(none)' placeholders, not empty sections", () => {
  const artifact = assembleRoundArtifact([], meta, 0, 30);
  const md = renderRoundArtifactMarkdown(artifact);
  assert.ok(md.includes("(none)"));
  assert.ok(md.includes("(no aligning-phase summary recorded)"));
  assert.ok(md.includes("(no proposal this round)"));
});

test("capRoundArtifactMarkdown: deterministically truncates at the char cap (delegates to retro-digest.ts's capDigest)", () => {
  const long = "x".repeat(1000);
  const capped = capRoundArtifactMarkdown(long, 50);
  assert.ok(capped.length <= 50);
  assert.ok(capped.includes("truncated"));
});

// ── buildRoundArtifact: the state-reading wrapper ───────────────────────────────────────────

test("buildRoundArtifact: reads events since round.started_at + cumulative spend, threading the given endedAt through untouched", () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("dispatched", { worker: "lane-1", issue: 1 });
  state.recordSpend("lane-1", 1, 3.5, new Date().toISOString());
  const artifact = buildRoundArtifact(state, round, 30, null);
  assert.equal(artifact.endedAt, null);
  assert.equal(artifact.spendUsd, 3.5);
  assert.deepEqual(artifact.dispatches, [{ issue: 1, worker: "lane-1" }]);

  const closed = buildRoundArtifact(state, round, 30, "2026-07-10T01:00:00.000Z");
  assert.equal(closed.endedAt, "2026-07-10T01:00:00.000Z");
  state.close();
});

test("buildRoundArtifact: events strictly before round.started_at are excluded", () => {
  const state = new State(":memory:");
  state.appendEvent("dispatched", { worker: "lane-old", issue: 99 });
  const round = state.startRound(new Date(Date.now() + 1000).toISOString());
  const artifact = buildRoundArtifact(state, round, 30, null);
  assert.deepEqual(artifact.dispatches, []);
  state.close();
});

// ── persistRoundArtifact: DB row (source of truth) + on-disk md view ───────────────────────

test("buildRoundArtifact (Codex P2, PR #152): a previous round's write in the SAME millisecond as started_at is excluded — the window is the id cursor, not the timestamp", () => {
  const state = new State(":memory:");
  // The tail write of a previous round…
  state.appendEvent("merged", { worker: "lane-prev", issue: 1, pr: 9, headOid: "h" });
  state.recordSpend("lane-prev", 1, 5, new Date().toISOString());
  // …and the next round opening in (at worst) the very same millisecond: a ts >= started_at
  // read could not tell these apart; the id cursor can.
  const round = state.startRound(new Date().toISOString());
  const artifact = buildRoundArtifact(state, round, 30, null);
  assert.deepEqual(artifact.merges, []);
  assert.equal(artifact.spendUsd, 0);
  state.close();
});

test("persistRoundArtifact: writes a DB row State.getRoundArtifact can read back, schema-validated", () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const artifact = buildRoundArtifact(state, round, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
  const row = state.getRoundArtifact(round.round_id);
  assert.ok(row);
  assert.equal(row!.schemaVersion, ROUND_ARTIFACT_SCHEMA_VERSION);
  const parsedBack = RoundArtifactSchema.parse(JSON.parse(row!.json));
  assert.equal(parsedBack.roundId, round.round_id);
  assert.equal(parsedBack.endedAt, "2026-07-10T01:00:00.000Z");
  state.close();
});

test("persistRoundArtifact: re-persisting the same round_id overwrites (never duplicates) the row", () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const first = buildRoundArtifact(state, round, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, first, "2026-07-10T01:00:00.000Z");
  state.appendEvent("dispatched", { worker: "lane-late", issue: 5 });
  const second = buildRoundArtifact(state, round, 30, "2026-07-10T01:05:00.000Z");
  persistRoundArtifact(state, second, "2026-07-10T01:05:00.000Z");
  const row = state.getRoundArtifact(round.round_id)!;
  const parsed = RoundArtifactSchema.parse(JSON.parse(row.json));
  assert.deepEqual(parsed.dispatches, [{ issue: 5, worker: "lane-late" }]);
  state.close();
});

test("persistRoundArtifact: a schema-invalid artifact throws rather than silently persisting garbage", () => {
  const state = new State(":memory:");
  const bad = { not: "a valid artifact" } as unknown as RoundArtifact;
  assert.throws(() => persistRoundArtifact(state, bad, "2026-07-10T01:00:00.000Z"));
  state.close();
});

test("persistRoundArtifact: an in-memory State (no on-disk data dir) skips the markdown file write, but still persists the DB row", () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const artifact = buildRoundArtifact(state, round, 30, "2026-07-10T01:00:00.000Z");
  assert.equal(state.roundArtifactMdPath(round.round_id), null);
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z"); // must not throw
  assert.ok(state.getRoundArtifact(round.round_id));
  state.close();
});

test("persistRoundArtifact: a real on-disk State writes the markdown view to data/rounds/round-<id>.md, matching renderRoundArtifactMarkdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-artifact-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    const artifact = buildRoundArtifact(state, round, 30, "2026-07-10T01:00:00.000Z");
    persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
    const mdPath = state.roundArtifactMdPath(round.round_id)!;
    assert.ok(mdPath.endsWith(join("rounds", `round-${round.round_id}.md`)));
    const written = readFileSync(mdPath, "utf8");
    assert.equal(written, renderRoundArtifactMarkdown(RoundArtifactSchema.parse(artifact)));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
