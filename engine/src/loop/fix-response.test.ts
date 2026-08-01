// #247: structured review-thread responses — fix-leg output validation + engine-executed
// idempotent replies/resolves. Mirrors harvest.test.ts's split: pure validator tests (schema +
// journal cross-check matrix) first, then attemptThreadWrite's durable-queue execution tests
// (fake forge, real in-memory State) asserting the exact call sequence + idempotency.
//
// Review round 1 (Codex sol-high PR #265): D1(b)/D2/D3/D6/D7 coverage added, each section
// marked with its finding id. Review round 2: F1 (monotonic row-id cursor, replacing round 1's
// wall-clock one) / F2 (fail-closed reconcile read + newest-comments read) / F3 (atomic
// receipt-event commits) / F4 (label-before-clear escalation ordering) / F5 (pr in the batch
// key) — same marking convention.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { deriveReviewAction } from "../roles/reviewer.js";
import { defaultFixPromptPath } from "../roles/worker.js";
import type { PendingThreadWrite } from "../state/state.js";
import { State } from "../state/state.js";
import { RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import {
  attemptThreadWrite,
  computeDisputeEscalation,
  computeFindingDisputeEscalation,
  computeFixResponseHarvest,
  fixLegJournalCursor,
  fixResponseBatchKey,
  journaledAuditRunIds,
  journaledReviewThreadIds,
  latestThreadResolutions,
  validateFixResponseOutput,
} from "./fix-response.js";

const sapwoodResult = (metadata: Record<string, unknown>): string =>
  `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;

// ── validateFixResponseOutput: schema + journal cross-check matrix ─────────────────────────

test("validateFixResponseOutput: a valid single addressed entry validates", () => {
  const text = sapwoodResult({ threadResponses: [{ threadId: "T1", reply: "fixed", resolution: "addressed" }] });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.responses, [{ threadId: "T1", reply: "fixed", resolution: "addressed" }]);
});

test("validateFixResponseOutput: an empty threadResponses array is valid (nothing to report)", () => {
  const text = sapwoodResult({ threadResponses: [] });
  const v = validateFixResponseOutput(text, new Set());
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.responses, []);
});

test("validateFixResponseOutput: no structured output block -> fail closed", () => {
  const v = validateFixResponseOutput("just prose, no block", new Set(["T1"]));
  assert.equal(v.ok, false);
});

test("validateFixResponseOutput: unknown threadId (never journaled to this leg) rejects the WHOLE output, never a partial execution", () => {
  const text = sapwoodResult({
    threadResponses: [
      { threadId: "T1", reply: "fixed", resolution: "addressed" },
      { threadId: "GHOST", reply: "fabricated", resolution: "addressed" },
    ],
  });
  const v = validateFixResponseOutput(text, new Set(["T1"])); // GHOST never journaled
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /GHOST/);
});

test("validateFixResponseOutput: duplicate threadId rejects the whole output (the #110-review duplicate-entry fail-open class)", () => {
  const text = sapwoodResult({
    threadResponses: [
      { threadId: "T1", reply: "fixed", resolution: "addressed" },
      { threadId: "T1", reply: "actually disputed", resolution: "disputed" },
    ],
  });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /duplicate/i);
});

test("validateFixResponseOutput: empty reply rejects the whole output", () => {
  const text = sapwoodResult({ threadResponses: [{ threadId: "T1", reply: "", resolution: "addressed" }] });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, false);
});

test("validateFixResponseOutput (D7): a whitespace-only reply rejects the whole output — not just a bare empty string", () => {
  const text = sapwoodResult({ threadResponses: [{ threadId: "T1", reply: "   \n\t  ", resolution: "addressed" }] });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, false);
});

test("validateFixResponseOutput: unrecognized resolution value rejects the whole output", () => {
  const text = sapwoodResult({ threadResponses: [{ threadId: "T1", reply: "fixed", resolution: "ignored" }] });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, false);
});

test("validateFixResponseOutput: an unknown extra field on an entry rejects (strict schema)", () => {
  const text = sapwoodResult({
    threadResponses: [{ threadId: "T1", reply: "fixed", resolution: "addressed", sneaky: true }],
  });
  const v = validateFixResponseOutput(text, new Set(["T1"]));
  assert.equal(v.ok, false);
});

test("validateFixResponseOutput: a mix of addressed + disputed entries, all journaled, validates as a batch", () => {
  const text = sapwoodResult({
    threadResponses: [
      { threadId: "T1", reply: "fixed as suggested", resolution: "addressed" },
      { threadId: "T2", reply: "disagree — see PR description", resolution: "disputed" },
    ],
  });
  const v = validateFixResponseOutput(text, new Set(["T1", "T2"]));
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.responses.length, 2);
});

// ── D1(b): a resultText following fix.md's DOCUMENTED format flows through the REAL
//    validateFixResponseOutput -> enqueue -> attemptThreadWrite path end to end ──────────────

test("D1(b): the shipped fix.md documents the sentinel + exact threadResponses/threadId/resolution field names", () => {
  const content = readFileSync(defaultFixPromptPath(), "utf8");
  assert.match(content, /<<<SAPWOOD_RESULT>>>/);
  assert.match(content, /<<<END_SAPWOOD_RESULT>>>/);
  assert.match(content, /threadResponses/);
  assert.match(content, /threadId/);
  assert.match(content, /"addressed"/);
  assert.match(content, /"disputed"/);
  assert.match(content, /no forge credentials|NO forge credentials/);
});

test("D1(b): a resultText in EXACTLY fix.md's documented shape flows through validateFixResponseOutput -> State.settleTerminalWorker -> attemptThreadWrite", async () => {
  // The literal shape fix.md instructs a fix leg to emit: a single addressed entry.
  const resultText = `${RESULT_BLOCK_START}\n{"threadResponses": [{"threadId": "PRRT_kwAAA1", "reply": "fixed as suggested", "resolution": "addressed"}]}\n${RESULT_BLOCK_END}`;
  const st = new State(":memory:");
  const journalCursor = st.maxForgeProxyJournalId("lane-fix");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor, at: "2026-07-19T00:00:00Z" });
  const journalId = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:01Z",
  });
  st.recordForgeProxyJournalResponse(journalId, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "PRRT_kwAAA1" }] }),
    contentHash: "h",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:01Z",
  });

  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 1,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(outcome.kind, "batch");
  if (outcome.kind !== "batch") return;
  assert.equal(outcome.batch.writes.length, 1);
  assert.equal(outcome.batch.writes[0]!.threadId, "PRRT_kwAAA1");

  st.settleTerminalWorker(
    { name: "lane-fix", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 30 },
    { worker: "lane-fix", issue: 9, usd: 0, at: "2026-07-19T00:00:02Z" },
    outcome,
  );
  const rows = st.pendingThreadWrites();
  assert.equal(rows.length, 1);

  const forge = new FakeThreadForge();
  const drained = await attemptThreadWrite(forge, st, mkCfg(), rows[0]!, () => "2026-07-19T00:00:03Z");
  assert.equal(drained.kind, "resolved");
  assert.deepEqual(forge.calls, [
    "check:PRRT_kwAAA1",
    "reply:PRRT_kwAAA1:fixed as suggested\n\n<!-- sapwood:fix-reply:lane-fix#30#1:PRRT_kwAAA1 -->",
    "resolve:PRRT_kwAAA1",
  ]);
  assert.deepEqual(st.pendingThreadWrites(), []);
  st.close();
});

// ── journaledReviewThreadIds: the no-TOCTOU, PR-bound set (D2) ─────────────────────────────

function journalRow(overrides: Record<string, unknown> = {}, pr = 1, threads: { id: string }[] = [{ id: "T1" }, { id: "T2" }]) {
  return {
    id: 1,
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    status: "fetched",
    upstreamIds: null,
    upstreamUpdatedAt: null,
    countsCanonical: null,
    truncated: false,
    responseCanonical: JSON.stringify({ pr, threads, total: threads.length, returned: threads.length, complete: true }),
    responseBytes: 10,
    contentHash: "h",
    error: null,
    timedOut: false,
    requestedAt: "t",
    fetchedAt: "t",
    deliveredAt: "t",
    ...overrides,
  };
}

test("journaledReviewThreadIds: collects thread ids from a fetched pr_review_threads row for the expected pr", () => {
  const ids = journaledReviewThreadIds([journalRow()] as never, 1);
  assert.deepEqual([...ids].sort(), ["T1", "T2"]);
});

test("journaledReviewThreadIds: ignores a different tool's rows entirely", () => {
  const ids = journaledReviewThreadIds(
    [journalRow({ tool: "pr_details", responseCanonical: JSON.stringify({ pr: 1, threads: [{ id: "SNEAKY" }] }) })] as never,
    1,
  );
  assert.deepEqual([...ids], []);
});

test("journaledReviewThreadIds: ignores an 'intent'/'error' status row (no response persisted yet)", () => {
  const ids = journaledReviewThreadIds([journalRow({ status: "intent", responseCanonical: null })] as never, 1);
  assert.deepEqual([...ids], []);
});

test("journaledReviewThreadIds: unions ids across MULTIPLE journal rows (a leg that called the tool more than once)", () => {
  const rows = [
    journalRow({ id: 1, seq: 1, responseCanonical: JSON.stringify({ pr: 1, threads: [{ id: "A" }] }) }),
    journalRow({ id: 2, seq: 2, responseCanonical: JSON.stringify({ pr: 1, threads: [{ id: "B" }] }) }),
  ];
  const ids = journaledReviewThreadIds(rows as never, 1);
  assert.deepEqual([...ids].sort(), ["A", "B"]);
});

test("journaledReviewThreadIds: a malformed response row is skipped, never thrown", () => {
  const ids = journaledReviewThreadIds([journalRow({ responseCanonical: "not json" })] as never, 1);
  assert.deepEqual([...ids], []);
});

test("journaledReviewThreadIds (D2 adversarial): a row journaled for a DIFFERENT pr is excluded entirely — cross-PR confused-deputy write closed", () => {
  const rows = [journalRow({}, 999, [{ id: "OTHER" }])]; // journaled for PR 999
  const ids = journaledReviewThreadIds(rows as never, 30); // the lane's OWN pr is 30
  assert.deepEqual([...ids], [], "PR 999's threads must never validate a structured output for PR 30's lane");
});

test("journaledReviewThreadIds (D2 adversarial): the journaled REQUEST args and RESPONSE must BOTH name the expected pr — a mismatched pair is excluded even if one side matches", () => {
  const rowArgsMatchOnly = journalRow({
    argsCanonical: JSON.stringify({ pr: 30 }),
    responseCanonical: JSON.stringify({ pr: 999, threads: [{ id: "T1" }] }),
  });
  const rowResponseMatchOnly = journalRow({
    argsCanonical: JSON.stringify({ pr: 999 }),
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "T2" }] }),
  });
  assert.deepEqual([...journaledReviewThreadIds([rowArgsMatchOnly] as never, 30)], []);
  assert.deepEqual([...journaledReviewThreadIds([rowResponseMatchOnly] as never, 30)], []);
});

test("journaledReviewThreadIds (D2 adversarial): a mix of own-PR and other-PR rows contributes ONLY the own-PR thread ids", () => {
  const rows = [journalRow({ id: 1 }, 30, [{ id: "MINE" }]), journalRow({ id: 2 }, 999, [{ id: "OTHER" }])];
  const ids = journaledReviewThreadIds(rows as never, 30);
  assert.deepEqual([...ids], ["MINE"]);
});

// ── fixLegJournalCursor + computeFixResponseHarvest: leg-bound scoping (D2/F1) ─────────────

test("fixLegJournalCursor (F1): returns the matching (worker, fixRounds) event's journalCursor — a monotonic row id, not a timestamp", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 5 });
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, journalCursor: 12 });
  st.appendEvent("fix-leg-started", { worker: "lane-other", issue: 5, pr: 50, fixRounds: 1, journalCursor: 40 });
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), 5);
  assert.equal(fixLegJournalCursor(st, "lane-fix", 2), 12);
  assert.equal(fixLegJournalCursor(st, "lane-other", 1), 40);
  st.close();
});

test("fixLegJournalCursor (F1): a cursor of 0 is a VALID cursor (a session with no prior journal rows), never confused with 'no cursor found'", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 0 });
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), 0);
  st.close();
});

test("fixLegJournalCursor: no matching event -> null (fail-closed — the caller trusts nothing)", () => {
  const st = new State(":memory:");
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), null);
  st.close();
});

test("fixLegJournalCursor (F1): picks up fix-leg-resumed and fix-leg-adopted events too, whichever is NEWEST for (worker, fixRounds)", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 3 });
  st.appendEvent("fix-leg-adopted", { worker: "lane-fix", issue: 9, fixRounds: 1, journalCursor: 8 });
  st.appendEvent("fix-leg-resumed", { worker: "lane-fix", issue: 9, pr: 30, attempt: 1, fixRounds: 1, journalCursor: 15 });
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), 15, "the LATEST (highest-id) cursor-bearing event wins");
  st.close();
});

test("fixLegJournalCursor: an event missing a journalCursor field (e.g. a hypothetical pre-F1 event) is skipped, never treated as a match", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1 }); // no journalCursor
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), null);
  st.close();
});

test("fixResponseBatchKey (F5): deterministic, worker+pr+fixRounds scoped — a lane-NAME collision across different PRs never collides", () => {
  assert.equal(fixResponseBatchKey("lane-fix", 30, 1), "lane-fix#30#1");
  assert.equal(fixResponseBatchKey("lane-fix", 30, 2), "lane-fix#30#2");
  assert.notEqual(
    fixResponseBatchKey("lane-fix", 30, 1),
    fixResponseBatchKey("lane-fix", 31, 1),
    "same worker+round, different PR -> different key",
  );
  assert.notEqual(fixResponseBatchKey("lane-fix", 30, 1), fixResponseBatchKey("lane-other", 30, 1));
});

test("computeFixResponseHarvest (D2 adversarial, cross-leg): round 2 must NOT trust a threadId only round 1's journal ever saw", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 0 });
  const id1 = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:01Z", // round 1's own request — journal row id 1
  });
  st.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "ROUND1_ONLY" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:01Z",
  });
  // Round 2's cursor is captured AFTER round 1's own journal row already exists (id 1) —
  // excludes it (id > 1 required).
  const round2Cursor = st.maxForgeProxyJournalId("lane-fix");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, journalCursor: round2Cursor });

  const resultText = sapwoodResult({ threadResponses: [{ threadId: "ROUND1_ONLY", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 2,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(outcome.kind, "invalid", "round 2 must never validate a threadId only round 1's journal ever saw");
  st.close();
});

test("computeFixResponseHarvest (F1): an EQUAL journal row id to the cursor is EXCLUDED — a strict '>' comparison, not '>='", () => {
  const st = new State(":memory:");
  const id1 = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z",
  });
  st.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "PRIOR" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:00Z",
  });
  // Cursor captured EXACTLY at this existing row's own id (simulates the round-1 wall-clock
  // defect's equal-timestamp case, but with ids: the row that already existed at cursor-capture
  // time must never validate the NEW round's output).
  const cursor = id1;
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: cursor });
  const resultText = sapwoodResult({ threadResponses: [{ threadId: "PRIOR", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 1,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(outcome.kind, "invalid", "a row AT the cursor (not strictly after it) must be excluded");
  st.close();
});

test("computeFixResponseHarvest (F1): a row created in the SAME instant resume() is called (id == cursor + 1, i.e. genuinely the leg's own first row) IS trusted", () => {
  const st = new State(":memory:");
  const cursor = st.maxForgeProxyJournalId("lane-fix"); // 0 — no rows yet
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: cursor });
  const id1 = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z", // the child's genuinely-first tool call, right after spawn
  });
  st.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "FIRST_CALL" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:00Z",
  });
  const resultText = sapwoodResult({ threadResponses: [{ threadId: "FIRST_CALL", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 1,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(
    outcome.kind,
    "batch",
    "a row strictly after the cursor validates, even if requestedAt collides with the cursor event's own timestamp",
  );
  st.close();
});

test("computeFixResponseHarvest (D2 adversarial, F1 adoption): a crash-adopted leg (fix-leg-adopted, never fix-leg-started) is still harvestable", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-adopted", { worker: "lane-fix", issue: 9, fixRounds: 1, journalCursor: 0 });
  const id1 = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z",
  });
  st.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "ADOPTED" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:00Z",
  });
  const resultText = sapwoodResult({ threadResponses: [{ threadId: "ADOPTED", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 1,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(
    outcome.kind,
    "batch",
    "an adopted leg with no fix-leg-started event must still be harvestable via fix-leg-adopted's own cursor",
  );
  st.close();
});

test("computeFixResponseHarvest: round 2 DOES trust a threadId ITS OWN journal saw, even though round 1 also ran on the same session", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 0 });
  const round2Cursor = st.maxForgeProxyJournalId("lane-fix");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, journalCursor: round2Cursor });
  const id2 = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr: 30 }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T02:00:01Z", // AFTER round 2's own cursor
  });
  st.recordForgeProxyJournalResponse(id2, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "ROUND2" }] }),
    contentHash: "h2",
    truncated: false,
    fetchedAt: "2026-07-19T02:00:01Z",
  });
  const resultText = sapwoodResult({ threadResponses: [{ threadId: "ROUND2", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 2,
    prNumber: 30,
    resultText,
    headOid: "head-x",
  });
  assert.equal(outcome.kind, "batch");
  st.close();
});

test("computeFixResponseHarvest: no PR -> invalid descriptor, never throws", () => {
  const st = new State(":memory:");
  const outcome = computeFixResponseHarvest(st, {
    worker: "lane-fix",
    issue: 9,
    fixRounds: 1,
    prNumber: null,
    resultText: "",
    headOid: null,
  });
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") assert.equal(outcome.invalid.pr, null);
  st.close();
});

// ── issue #247 AC: resolution alone never flips the merge verdict ──────────────────────────

test("issue #247 AC: all threads resolved (unresolvedThreads=0) + no fresh review on the head -> still WAIT_REVIEW, never MERGE_OK", () => {
  const action = deriveReviewAction({
    hasEyesReaction: false,
    freshApprovingReviews: 0,
    freshTrustedThumbs: 0,
    unresolvedThreads: 0,
    changesRequestedOnHead: false,
  });
  assert.notEqual(action, "MERGE_OK");
  assert.equal(action, "WAIT_REVIEW", "resolving every thread is bookkeeping — the fresh review is the gate, unchanged by this module");
});

// ── attemptThreadWrite: durable-queue execution, exact call sequence + idempotency ─────────

function mkCfg(): Pick<SapwoodConfig, "recovery" | "labels" | "proxy"> {
  return {
    recovery: { rollbackRetryCap: 3 },
    labels: { needsHuman: "needs-human" } as SapwoodConfig["labels"],
    proxy: { caps: { maxCommentsPerThread: 20 } } as SapwoodConfig["proxy"],
  };
}

class FakeThreadForge
  implements Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "getReviewThreadCommentsTail" | "addPRLabel">
{
  calls: string[] = [];
  throwOnReply = false;
  throwOnResolve = false;
  throwOnCheckOnce = false;
  /** #398: the escalation's ONE carrier is the PR now, so this is the write that can fail. */
  throwOnAddPRLabel = false;
  prLabelsAdded: Array<[number, string]> = [];
  /** Simulates GitHub's own live state: threadId -> posted comment bodies (F2(b): the read is
   *  scoped to ONE thread's own node id now, no PR bucketing needed at all). Seeded by
   *  replyToReviewThread itself. */
  threads: Record<string, string[]> = {};
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    this.calls.push(`reply:${threadId}:${body}`);
    if (this.throwOnReply) throw new Error("reply failed");
    this.threads[threadId] ??= [];
    this.threads[threadId].push(body);
  }
  async resolveReviewThread(threadId: string): Promise<void> {
    this.calls.push(`resolve:${threadId}`);
    if (this.throwOnResolve) throw new Error("resolve failed");
  }
  async getReviewThreadCommentsTail(threadId: string, cap: number): Promise<string[]> {
    this.calls.push(`check:${threadId}`);
    if (this.throwOnCheckOnce) {
      this.throwOnCheckOnce = false;
      throw new Error("transient read failure");
    }
    // Mirrors the real `last: cap` GraphQL semantics — the NEWEST `cap` comments, never the
    // oldest (F2(b)'s whole point).
    return (this.threads[threadId] ?? []).slice(-cap);
  }
  async addPRLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddPRLabel) throw new Error("label write failed");
    this.prLabelsAdded.push([n, l]);
  }
}

function seedRow(st: State, over: Partial<Parameters<State["enqueueThreadWrite"]>[0]> = {}): PendingThreadWrite {
  const id = st.enqueueThreadWrite(
    {
      worker: "lane-fix",
      issue: 9,
      pr: 90,
      threadId: "T1",
      reply: "fixed",
      resolution: "addressed",
      batchKey: "lane-fix#90#1",
      fixRounds: 1,
      ...over,
    },
    "2026-07-19T00:00:00Z",
  );
  return st.pendingThreadWrites().find((r) => r.id === id)!;
}

test("attemptThreadWrite: an 'addressed' row checks for an existing reply, posts, THEN resolves, in order, and clears the row on success", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st);
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.deepEqual(forge.calls, ["check:T1", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#90#1:T1 -->", "resolve:T1"]);
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(st.pendingThreadWrites(), [], "fully executed -> row cleared");
  st.close();
});

test("attemptThreadWrite: a 'disputed' row checks + replies ONLY (never resolve) and clears the row — speak-not-act", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { resolution: "disputed", reply: "disagree" });
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => new Date().toISOString());
  assert.deepEqual(forge.calls, ["check:T1", "reply:T1:disagree\n\n<!-- sapwood:fix-reply:lane-fix#90#1:T1 -->"]);
  assert.equal(outcome.kind, "recorded");
  assert.deepEqual(st.pendingThreadWrites(), []);
  // #451 (design #402 §4/D4 amendment, verification plan item 6): this mechanics-level guard
  // stays exactly as it was — attemptThreadWrite itself is untouched by #451. What #451 adds
  // sits one layer up, at the settleTerminalWorker receipt (state.test.ts) and the
  // latestThreadResolutions/computeDisputeEscalation reader below: resolveReviewThread must
  // NEVER appear in the call log for a disputed row, restated explicitly here (not merely via
  // deepEqual's exclusion above) so a future call added to FakeThreadForge.calls can't silently
  // widen this assertion's tolerance.
  assert.ok(
    forge.calls.every((c) => !c.startsWith("resolve:")),
    "no resolveReviewThread call, ever, for a disputed row",
  );
  st.close();
});

test("attemptThreadWrite idempotency: a failed resolve retries next tick WITHOUT re-checking or re-posting the reply", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnResolve = true;
  const row = seedRow(st);

  const first = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(first.kind, "retrying");
  assert.deepEqual(
    forge.calls,
    ["check:T1", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#90#1:T1 -->", "resolve:T1"],
    "attempt 1: checked, reply posted, resolve attempted and failed",
  );
  const rowAfterFirst = st.pendingThreadWrites()[0]!;
  assert.equal(rowAfterFirst.replyPosted, true, "reply is durably marked posted");
  assert.equal(rowAfterFirst.resolved, false);
  assert.equal(rowAfterFirst.attempts, 1);

  forge.throwOnResolve = false; // the transient forge failure clears
  forge.calls = [];
  const second = await attemptThreadWrite(forge, st, mkCfg(), rowAfterFirst, () => "2026-07-19T00:01:00Z");
  assert.equal(second.kind, "resolved");
  assert.deepEqual(forge.calls, ["resolve:T1"], "replyPosted already true -> no check, no repost, resolve only");
  assert.deepEqual(st.pendingThreadWrites(), [], "cleared once both halves succeed");
  st.close();
});

test("attemptThreadWrite: a reply that keeps failing bumps attempts and stays pending (never resolved, never cleared) under the cap", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnReply = true;
  const row = seedRow(st);
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => new Date().toISOString());
  assert.equal(outcome.kind, "retrying");
  const rows = st.pendingThreadWrites();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.replyPosted, false);
  assert.equal(rows[0]!.attempts, 1);
  st.close();
});

test("attemptThreadWrite (F4): escalates (needs-human label, clears the row) once attempts hit cfg.recovery.rollbackRetryCap — bounded retry, never forever", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnReply = true;
  const cfg = mkCfg(); // cap 3
  let row = seedRow(st);
  for (let i = 0; i < 2; i++) {
    const outcome = await attemptThreadWrite(forge, st, cfg, row, () => new Date().toISOString());
    assert.equal(outcome.kind, "retrying");
    row = st.pendingThreadWrites()[0]!;
  }
  const finalOutcome = await attemptThreadWrite(forge, st, cfg, row, () => new Date().toISOString());
  assert.equal(finalOutcome.kind, "escalated");
  assert.deepEqual(st.pendingThreadWrites(), [], "escalated rows are cleared — never retried forever");
  // #398: ONE carrier, the PR — this escalation is PR-born (the write that failed is a reply to /
  // resolution of a REVIEW THREAD on this PR). The issue-side twin is gone: two carriers meant a
  // human had to strip the label twice before the lane was released (dogfood lanes 144, 295).
  assert.deepEqual(forge.prLabelsAdded, [[90, "needs-human"]]);
  st.close();
});

test("attemptThreadWrite (F4): a FAILED label write at the cap KEEPS the row pending (never clears it) and retries the escalation next tick", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnReply = true;
  forge.throwOnAddPRLabel = true; // the label write itself fails
  const cfg = mkCfg();
  let row = seedRow(st);
  for (let i = 0; i < 3; i++) {
    const outcome = await attemptThreadWrite(forge, st, cfg, row, () => new Date().toISOString());
    // Every attempt at/past the cap with a failing label write reports "retrying" — never
    // "escalated" while the label hasn't actually landed.
    assert.equal(outcome.kind, "retrying");
    const rows = st.pendingThreadWrites();
    assert.equal(rows.length, 1, "the row is NEVER cleared while the escalation label write keeps failing");
    row = rows[0]!;
  }
  assert.deepEqual(forge.prLabelsAdded, [], "no label ever actually landed");

  // The forge recovers; the very next attempt both lands the label AND finalizes the escalation.
  forge.throwOnAddPRLabel = false;
  const recovered = await attemptThreadWrite(forge, st, cfg, row, () => new Date().toISOString());
  assert.equal(recovered.kind, "escalated");
  assert.deepEqual(st.pendingThreadWrites(), [], "cleared only NOW, after the label successfully landed");
  assert.deepEqual(forge.prLabelsAdded, [[90, "needs-human"]]);
  st.close();
});

// ── D3/F2: crash-safety — a reply POST that succeeded upstream but crashed before its durable
//    reply_posted flag committed must NEVER be re-posted; a FAILED reconcile read must fail
//    CLOSED (never default to "not posted yet") ─────────────────────────────────────────────

test("D3: simulated crash (forge reply succeeds, the durable reply_posted write throws) -> rerun finds the marker and does NOT double-post", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st);
  let throwOnComplete = true;
  const crashingState: Pick<
    State,
    "completeThreadReply" | "completeThreadResolve" | "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent"
  > = {
    completeThreadReply: (id, at, receipt) => {
      if (throwOnComplete) {
        throwOnComplete = false;
        throw new Error("simulated crash before the durable flag commits");
      }
      st.completeThreadReply(id, at, receipt);
    },
    completeThreadResolve: (id, at, receipt) => st.completeThreadResolve(id, at, receipt),
    bumpThreadWriteAttempt: (id, at) => st.bumpThreadWriteAttempt(id, at),
    clearThreadWrite: (id) => st.clearThreadWrite(id),
    appendEvent: (kind, payload) => st.appendEvent(kind, payload),
  };

  const first = await attemptThreadWrite(forge, crashingState, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(first.kind, "retrying", "the durable flag write failed -> treated as a retry");
  assert.deepEqual(
    forge.calls,
    ["check:T1", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#90#1:T1 -->"],
    "the forge reply call happened exactly ONCE",
  );
  assert.equal(st.pendingThreadWrites()[0]!.replyPosted, false, "the durable flag never committed — the simulated crash");

  forge.calls = [];
  const rowAfterFirst = st.pendingThreadWrites()[0]!;
  const second = await attemptThreadWrite(forge, crashingState, mkCfg(), rowAfterFirst, () => "2026-07-19T00:01:00Z");
  assert.equal(second.kind, "resolved");
  assert.deepEqual(
    forge.calls,
    ["check:T1", "resolve:T1"],
    "the marker is found on the live thread -> replyToReviewThread is NEVER called a second time",
  );
  assert.deepEqual(st.pendingThreadWrites(), []);
  st.close();
});

test("F2(a): a FAILED reconcile read fails CLOSED — never defaults to 'not posted yet' and never posts through the unverifiable window", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnCheckOnce = true;
  const row = seedRow(st);
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(outcome.kind, "retrying", "a failed check must retry, never silently proceed to post");
  assert.deepEqual(forge.calls, ["check:T1"], "the check failed -> replyToReviewThread was NEVER called this attempt");
  assert.equal(st.pendingThreadWrites()[0]!.replyPosted, false);

  // Next tick: the read succeeds, finds nothing posted yet, and proceeds normally.
  const row2 = st.pendingThreadWrites()[0]!;
  const outcome2 = await attemptThreadWrite(forge, st, mkCfg(), row2, () => "2026-07-19T00:01:00Z");
  assert.equal(outcome2.kind, "resolved");
  assert.deepEqual(forge.calls, ["check:T1", "check:T1", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#90#1:T1 -->", "resolve:T1"]);
  st.close();
});

test("F2(b): the marker check reads the NEWEST comments (last:, not first:) — a thread with more OLD comments than the cap still surfaces the just-posted marker", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  // Pre-seed OLDER comments beyond the cap — a naive `first: cap` read would see ONLY these,
  // never the marker this test's reply appends afterward.
  forge.threads.T1 = ["old comment 1", "old comment 2", "old comment 3"];
  const cfg: Pick<SapwoodConfig, "recovery" | "labels" | "proxy"> = {
    recovery: { rollbackRetryCap: 3 },
    labels: { needsHuman: "needs-human" } as SapwoodConfig["labels"],
    proxy: { caps: { maxCommentsPerThread: 2 } } as SapwoodConfig["proxy"], // cap smaller than the existing comment count
  };
  const row = seedRow(st);
  const first = await attemptThreadWrite(forge, st, cfg, row, () => "2026-07-19T00:00:01Z");
  assert.equal(first.kind, "resolved", "the reply posted fine — 3 pre-existing comments never blocked the FIRST attempt");
  assert.equal(forge.threads.T1.length, 4, "old comment 1/2/3 + the new marked reply");

  // Simulate a retry of the SAME logical write (replyPosted durably lost, e.g. D3's crash
  // window) against the now-4-comment thread — the tail-capped (cap=2) check must still find
  // the marker among the newest 2 comments and refuse to double-post.
  forge.calls = [];
  const staleRow = { ...row, replyPosted: false };
  const second = await attemptThreadWrite(forge, st, cfg, staleRow, () => "2026-07-19T00:00:03Z");
  assert.equal(second.kind, "resolved");
  assert.deepEqual(forge.calls, ["check:T1", "resolve:T1"], "the marker was found via the tail-capped read — no second reply: call");
  assert.equal(forge.threads.T1.length, 4, "no new comment was added — still just old 1/2/3 + the one marked reply");
  st.close();
});

// ── D6/F3: provenance — every executed write journals leg/round provenance via SEPARATE,
//    ATOMIC reply-posted / resolved receipt events ─────────────────────────────────────────

test("D6/F3: attemptThreadWrite emits SEPARATE fix-thread-reply-posted / fix-thread-resolved receipt events, each carrying batchKey + fixRounds provenance, atomically with their state changes", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { batchKey: "lane-fix#90#3", fixRounds: 3 });
  await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-thread-reply-posted", "fix-thread-resolved"]);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "fix-thread-reply-posted");
  assert.equal(events[1]!.kind, "fix-thread-resolved");
  for (const e of events) {
    const p = e.payload as { worker: string; issue: number; pr: number; threadId: string; batchKey: string; fixRounds: number };
    assert.equal(p.worker, "lane-fix");
    assert.equal(p.issue, 9);
    assert.equal(p.pr, 90);
    assert.equal(p.threadId, "T1");
    assert.equal(p.batchKey, "lane-fix#90#3");
    assert.equal(p.fixRounds, 3);
  }
  st.close();
});

test("D6: a disputed row emits ONLY fix-thread-reply-posted (no resolved receipt — nothing was resolved)", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { resolution: "disputed", reply: "disagree" });
  await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-thread-reply-posted", "fix-thread-resolved"]);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["fix-thread-reply-posted"],
  );
  st.close();
});

test("F3: completeThreadReply is atomic — a thrown appendEvent rolls back the reply_posted flag too (never a marked-posted row with no receipt)", () => {
  const st = new State(":memory:");
  const row = seedRow(st);
  const originalAppendEvent = st.appendEvent.bind(st);
  st.appendEvent = ((kind: string, payload: unknown) => {
    if (kind === "fix-thread-reply-posted") throw new Error("simulated event-append failure");
    return originalAppendEvent(kind, payload);
  }) as typeof st.appendEvent;
  assert.throws(() => st.completeThreadReply(row.id, "2026-07-19T00:00:01Z", { worker: row.worker }));
  st.appendEvent = originalAppendEvent;
  const rows = st.pendingThreadWrites();
  assert.equal(rows[0]!.replyPosted, false, "the whole transaction rolled back — reply_posted was never committed without its receipt");
  st.close();
});

// ── #451 (design #402 §4/§4a/D4): latestThreadResolutions + computeDisputeEscalation ───────

test("latestThreadResolutions: folds fix-response-queued events, scoped to (worker, pr), newest wins per threadId", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "addressed", reply: "fixed" }],
  });
  // A LATER fix round for the SAME thread re-disputes it against a NEW head — the newest fact
  // must win.
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#2",
    fixRounds: 2,
    count: 1,
    headOid: "head-2",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree now" }],
  });
  // A different worker/pr must never leak in.
  st.appendEvent("fix-response-queued", {
    worker: "lane-b",
    issue: 3,
    pr: 66,
    batchKey: "lane-b#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-9",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "unrelated" }],
  });
  const records = latestThreadResolutions(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]), "lane-a", 55);
  assert.equal(records.size, 1);
  assert.deepEqual(records.get("T1"), { resolution: "disputed", reply: "disagree now", headOid: "head-2", fixRounds: 2 });
  st.close();
});

test("latestThreadResolutions: a malformed event (missing worker/pr, non-string threadId, unrecognized resolution) contributes nothing for that entry — never throws", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-response-queued", { pr: 55, writes: [{ threadId: "T1", resolution: "disputed", reply: "x" }] }); // no worker
  st.appendEvent("fix-response-queued", { worker: "lane-a", writes: [{ threadId: "T1", resolution: "disputed", reply: "x" }] }); // no pr
  st.appendEvent("fix-response-queued", { worker: "lane-a", pr: 55, writes: [{ resolution: "disputed", reply: "x" }] }); // no threadId
  st.appendEvent("fix-response-queued", { worker: "lane-a", pr: 55, writes: [{ threadId: "T1", resolution: "maybe", reply: "x" }] }); // bad resolution
  const records = latestThreadResolutions(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]), "lane-a", 55);
  assert.equal(records.size, 0);
  st.close();
});

test("latestThreadResolutions: a pre-#451 event with no headOid/writes fields is read fail-closed (headOid null, empty map — nothing to match a live head against)", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-response-queued", { worker: "lane-a", issue: 2, pr: 55, batchKey: "lane-a#1", fixRounds: 1, count: 1 });
  const records = latestThreadResolutions(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]), "lane-a", 55);
  assert.equal(records.size, 0, "no `writes` array -> nothing recorded, never a crash");
  st.close();
});

class FakeDisputeForge implements Pick<IForge, "getPRStatus" | "getPRReviewThreads"> {
  headOid = "head-1";
  threads: { id: string; isResolved: boolean; comments: { author: string; body: string; createdAt: string }[] }[] = [];
  throwOnStatus = false;
  throwOnThreads = false;
  /** #451 gate② P3(a): when true, the live thread page reports itself PARTIAL — see
   *  computeDisputeEscalation's own fail-closed guard. */
  pageCapped = false;
  /** #451 gate② round 3 (Codex P1, TOCTOU): every `getPRStatus` call AFTER the first returns THIS
   *  headOid instead of `headOid` — simulates a push landing between the initial parallel read and
   *  the re-validation immediately before any side effect. `undefined` (default) -> every call
   *  returns the same `headOid`, byte-for-byte the pre-round-3 fake. */
  headOidAfterFirstCall: string | undefined = undefined;
  /** Same shape, for the PR-closed-between-reads variant. */
  stateAfterFirstCall: "OPEN" | "CLOSED" | "MERGED" | undefined = undefined;
  getPRStatusCalls = 0;
  async getPRStatus(pr: number) {
    if (this.throwOnStatus) throw new Error("simulated forge outage");
    this.getPRStatusCalls++;
    const stale = this.getPRStatusCalls > 1;
    return {
      number: pr,
      headOid: stale && this.headOidAfterFirstCall !== undefined ? this.headOidAfterFirstCall : this.headOid,
      state: (stale && this.stateAfterFirstCall !== undefined ? this.stateAfterFirstCall : "OPEN") as "OPEN" | "CLOSED" | "MERGED",
      mergeable: "MERGEABLE" as const,
      ciGreen: true,
    };
  }
  async getPRReviewThreads(_pr: number, _commentsCap: number) {
    if (this.throwOnThreads) throw new Error("simulated forge outage");
    return { threads: this.threads.map((t) => ({ ...t, commentsComplete: true })), pageCapped: this.pageCapped };
  }
}

function disputeCfg(): Pick<SapwoodConfig, "proxy"> {
  return { proxy: { caps: { maxCommentsPerThread: 20 } } as SapwoodConfig["proxy"] };
}

test("computeDisputeEscalation: every unresolved current-head thread durably disputed -> evidence for all of them", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "the finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  // #461: `items`/`ref`/`source` — the shape generalized to carry the audit-comment channel's
  // finding disputes alongside the thread ones; the thread path's own data is unchanged.
  assert.deepEqual(result, { headOid: "head-1", source: "thread", items: [{ ref: "T1", findingBody: "the finding", reply: "disagree" }] });
  st.close();
});

test("computeDisputeEscalation (#451 gate② P3a): pageCapped (a partial thread view) -> null, fail-closed, even when every VISIBLE unresolved thread is disputed", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.pageCapped = true;
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "the finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null, "a partial view can never prove EVERY unresolved thread is disputed");
  st.close();
});

test("computeDisputeEscalation (#451 gate② round 3, Codex P1 — TOCTOU): a push landing between the initial read and the pre-side-effect recheck (head moves) -> null, fail-closed", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.headOidAfterFirstCall = "head-2"; // the push that lands mid-flight
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "the finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null, "the head moved between the initial read and the recheck — never escalate against a superseded head");
  assert.equal(forge.getPRStatusCalls, 2, "the recheck is a REAL second read, not a reuse of the first");
  st.close();
});

test("computeDisputeEscalation (#451 gate② round 3, Codex P1 — TOCTOU): the PR closes/merges between the initial read and the recheck -> null, fail-closed", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.stateAfterFirstCall = "MERGED";
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "the finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null, "a PR that merged/closed between reads must never be escalated against");
  st.close();
});

test("computeDisputeEscalation (#451 gate② round 3, Codex P1 — TOCTOU): the recheck read itself failing -> null, fail-closed (never assume the head still matches)", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "the finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const originalGetPRStatus = forge.getPRStatus.bind(forge);
  forge.getPRStatus = (async (pr: number) => {
    if (forge.getPRStatusCalls >= 1) throw new Error("simulated recheck outage");
    return originalGetPRStatus(pr);
  }) as typeof forge.getPRStatus;
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null);
  st.close();
});

test("computeDisputeEscalation: a resolved thread is excluded from consideration entirely (isResolved:true never counts as unresolved-and-disputed)", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.threads = [{ id: "T1", isResolved: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] }];
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null, "no unresolved threads at all -> nothing to adjudicate");
  st.close();
});

test("computeDisputeEscalation: a mix (one disputed, one never answered) -> null, not partial evidence", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.threads = [
    { id: "T1", isResolved: false, comments: [{ author: "codex", body: "finding A", createdAt: "t0" }] },
    { id: "T2", isResolved: false, comments: [{ author: "codex", body: "finding B", createdAt: "t0" }] },
  ];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null);
  st.close();
});

test("computeDisputeEscalation: a disputed record against a STALE head -> null, fail-closed", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-NEW";
  forge.threads = [{ id: "T1", isResolved: false, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] }];
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-OLD",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null);
  st.close();
});

test("computeDisputeEscalation: zero live unresolved threads (the §4a engine-agent case) -> null unconditionally, even with disputed records on file", async () => {
  const st = new State(":memory:");
  const forge = new FakeDisputeForge();
  forge.headOid = "head-1";
  forge.threads = []; // engine-agent: no thread-creating forge write exists at all
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: "lane-a#1",
    fixRounds: 1,
    count: 1,
    headOid: "head-1",
    writes: [{ threadId: "T1", resolution: "disputed", reply: "disagree" }],
  });
  const result = await computeDisputeEscalation(forge, st, disputeCfg(), "lane-a", 55);
  assert.equal(result, null);
  st.close();
});

test("computeDisputeEscalation: an unreadable live read (getPRStatus or getPRReviewThreads throws) fails CLOSED -> null, never escalates on an unproven read", async () => {
  const st = new State(":memory:");
  const forgeA = new FakeDisputeForge();
  forgeA.throwOnStatus = true;
  assert.equal(await computeDisputeEscalation(forgeA, st, disputeCfg(), "lane-a", 55), null);
  const forgeB = new FakeDisputeForge();
  forgeB.throwOnThreads = true;
  assert.equal(await computeDisputeEscalation(forgeB, st, disputeCfg(), "lane-a", 55), null);
  st.close();
});

// ── #461: findingResponses — the audit-comment-shaped dissent channel ────────────────────────
//
// Engine-agent findings arrive as ONE audit comment, never review threads, so a fix leg had no
// machine-readable way to dispute one (every threadResponses entry validates against a journaled
// `pr_review_threads` id an audit finding structurally does not have). These tests cover the new
// block's validation matrix, its two-source known-set (journaled audit RUN ids x the WAL
// artifact's own finding COUNT), and the dispute -> needs-human routing predicate.

const auditJournalRow = (overrides: Record<string, unknown> = {}, pr = 30, runIds: string[] = ["run-1"]) => ({
  ...journalRow(overrides, pr),
  tool: "getPRAuditComments",
  responseCanonical: JSON.stringify({
    pr,
    comments: runIds.map((runId) => ({ id: `IC_${runId}`, kind: "engine-agent", head: "head-x", diff: "d", runId, body: "…" })),
    returned: runIds.length,
    complete: true,
  }),
  ...overrides,
});

/** A `fixing` lane's world at settle time: the leg's journal cursor, ONE journaled
 *  getPRAuditComments row it was served, and the WAL row carrying the reviewed artifact whose
 *  finding COUNT bounds every findingIndex. */
function seedAuditServedLeg(st: State, opts: { runId?: string; findings?: number; pr?: number; walRunId?: string } = {}): void {
  const runId = opts.runId ?? "run-1";
  const pr = opts.pr ?? 30;
  const cursor = st.maxForgeProxyJournalId("lane-fix");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr, fixRounds: 1, journalCursor: cursor });
  const id = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "getPRAuditComments",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-08-01T00:00:01Z",
  });
  st.recordForgeProxyJournalResponse(id, {
    responseCanonical: JSON.stringify({
      pr,
      comments: [{ id: "IC_1", kind: "engine-agent", head: "head-x", diff: "d", runId, body: "…" }],
      returned: 1,
      complete: true,
    }),
    contentHash: "h",
    truncated: false,
    fetchedAt: "2026-08-01T00:00:01Z",
  });
  st.recordEngineReviewWal("lane-fix", {
    runId: opts.walRunId ?? runId,
    head: "head-x",
    base: "base-x",
    diffHash: "d",
    attemptStart: "2026-08-01T00:00:00Z",
  });
  st.recordEngineReviewWalArtifact(
    "lane-fix",
    opts.walRunId ?? runId,
    "rejected",
    JSON.stringify({
      perAC: [],
      findings: Array.from({ length: opts.findings ?? 2 }, (_, i) => ({ id: `F-${i}`, body: `finding body ${i}` })),
      sessionActualModels: ["m"],
      promptHash: "p",
    }),
  );
}

const harvest = (st: State, resultText: string, pr = 30) =>
  computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: pr, resultText, headOid: "head-x" });

test("#461 AC1: a findingResponses entry naming a served runId + an in-range index validates and rides the batch", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st);
  const outcome = harvest(
    st,
    sapwoodResult({
      threadResponses: [],
      findingResponses: [{ runId: "run-1", findingIndex: 1, reply: "the diff never touches that path", resolution: "disputed" }],
    }),
  );
  assert.equal(outcome.kind, "batch");
  if (outcome.kind !== "batch") return;
  assert.deepEqual(outcome.batch.findingWrites, [
    { runId: "run-1", findingIndex: 1, reply: "the diff never touches that path", resolution: "disputed" },
  ]);
  assert.deepEqual(outcome.batch.writes, [], "no thread writes — findings carry no thread to reply to");
  st.close();
});

test("#461 AC1: an UNKNOWN runId (never served to this leg) rejects the WHOLE output, fail-closed — parity with threadResponses", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st);
  const outcome = harvest(
    st,
    sapwoodResult({
      threadResponses: [],
      findingResponses: [{ runId: "run-GHOST", findingIndex: 0, reply: "no", resolution: "disputed" }],
    }),
  );
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") assert.match(outcome.invalid.reason, /run-GHOST/);
  st.close();
});

test("#461 AC1: a findingIndex past the reviewed artifact's own finding count rejects the whole output", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st, { findings: 2 });
  const outcome = harvest(
    st,
    sapwoodResult({ threadResponses: [], findingResponses: [{ runId: "run-1", findingIndex: 2, reply: "no", resolution: "disputed" }] }),
  );
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") assert.match(outcome.invalid.reason, /findingIndex 2/);
  st.close();
});

test("#461 AC1: a duplicate (runId, findingIndex) rejects the whole output — one response per finding, never two", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st);
  const outcome = harvest(
    st,
    sapwoodResult({
      threadResponses: [],
      findingResponses: [
        { runId: "run-1", findingIndex: 0, reply: "fixed", resolution: "addressed" },
        { runId: "run-1", findingIndex: 0, reply: "actually disputed", resolution: "disputed" },
      ],
    }),
  );
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") assert.match(outcome.invalid.reason, /duplicate/i);
  st.close();
});

test("#461 AC1: malformed entries (empty/whitespace reply, non-integer or negative index, unknown resolution, extra field) all reject", () => {
  const known = new Map([["run-1", 2]]);
  const bad: Record<string, unknown>[] = [
    { runId: "run-1", findingIndex: 0, reply: "   \n ", resolution: "disputed" },
    { runId: "run-1", findingIndex: 0.5, reply: "x", resolution: "disputed" },
    { runId: "run-1", findingIndex: -1, reply: "x", resolution: "disputed" },
    { runId: "run-1", findingIndex: 0, reply: "x", resolution: "ignored" },
    { runId: "run-1", findingIndex: 0, reply: "x", resolution: "disputed", sneaky: true },
    { runId: "", findingIndex: 0, reply: "x", resolution: "disputed" },
  ];
  for (const entry of bad) {
    const v = validateFixResponseOutput(sapwoodResult({ threadResponses: [], findingResponses: [entry] }), new Set(), known);
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(entry)}`);
  }
});

test("#461 AC3: an output with NO findingResponses block validates exactly as before and carries no findingWrites (byte-identical undisputed flow)", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st);
  const outcome = harvest(st, sapwoodResult({ threadResponses: [] }));
  assert.equal(outcome.kind, "batch");
  if (outcome.kind !== "batch") return;
  assert.deepEqual(outcome.batch.findingWrites, []);
  st.settleTerminalWorker(
    { name: "lane-fix", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 30 },
    { worker: "lane-fix", issue: 9, usd: 0, at: "2026-08-01T00:00:02Z" },
    outcome,
  );
  const [receipt] = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]);
  assert.equal("findingWrites" in (receipt!.payload as object), false, "no new payload field without the new block");
  st.close();
});

test("#461: findingResponses are rejected when the leg never called getPRAuditComments at all (no journaled audit row -> nothing known)", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, journalCursor: 0 });
  st.recordEngineReviewWal("lane-fix", { runId: "run-1", head: "head-x", base: "b", diffHash: "d", attemptStart: "t" });
  st.recordEngineReviewWalArtifact(
    "lane-fix",
    "run-1",
    "rejected",
    JSON.stringify({ perAC: [], findings: [{ id: "F-0", body: "b" }], sessionActualModels: ["m"], promptHash: "p" }),
  );
  const outcome = harvest(
    st,
    sapwoodResult({ threadResponses: [], findingResponses: [{ runId: "run-1", findingIndex: 0, reply: "x", resolution: "disputed" }] }),
  );
  assert.equal(outcome.kind, "invalid", "the WAL alone can never authorize a response — the leg must have been SERVED the run");
  st.close();
});

test("#461: a WAL that has moved on to a DIFFERENT run than the one journaled to the leg authorizes nothing (fail-closed)", () => {
  const st = new State(":memory:");
  seedAuditServedLeg(st, { runId: "run-1", walRunId: "run-2" });
  const outcome = harvest(
    st,
    sapwoodResult({ threadResponses: [], findingResponses: [{ runId: "run-1", findingIndex: 0, reply: "x", resolution: "disputed" }] }),
  );
  assert.equal(outcome.kind, "invalid");
  st.close();
});

test("#461: journaledAuditRunIds — collects run ids from a served getPRAuditComments row, PR-bound on BOTH request args and response", () => {
  assert.deepEqual([...journaledAuditRunIds([auditJournalRow({}, 30, ["run-a", "run-b"])] as never, 30)].sort(), ["run-a", "run-b"]);
  // cross-PR confused-deputy closure, same shape journaledReviewThreadIds already takes
  assert.deepEqual([...journaledAuditRunIds([auditJournalRow({}, 999, ["run-a"])] as never, 30)], []);
  assert.deepEqual(
    [...journaledAuditRunIds([auditJournalRow({ argsCanonical: JSON.stringify({ pr: 30 }) }, 999, ["run-a"])] as never, 30)],
    [],
  );
  // a different tool's row, an unresponded row, and a malformed row all contribute nothing
  assert.deepEqual([...journaledAuditRunIds([auditJournalRow({ tool: "pr_review_threads" }, 30, ["run-a"])] as never, 30)], []);
  assert.deepEqual([...journaledAuditRunIds([auditJournalRow({ status: "intent", responseCanonical: null })] as never, 30)], []);
  assert.deepEqual([...journaledAuditRunIds([auditJournalRow({ responseCanonical: "not json" })] as never, 30)], []);
});

// ── #461 AC2: dispute routing — an auditable record + an evidenced needs-human escalation ────

/** The durable receipt a settled fix leg leaves behind for its finding responses. */
const seedFindingResponseQueued = (
  st: State,
  writes: { runId: string; findingIndex: number; resolution: "addressed" | "disputed"; reply: string }[],
  fixRounds = 1,
) =>
  st.appendEvent("fix-response-queued", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    batchKey: `lane-a#55#${fixRounds}`,
    fixRounds,
    count: 0,
    headOid: "head-1",
    threadless: true,
    newHead: null,
    writes: [],
    findingWrites: writes,
  });

function seedRejectedWal(st: State, runId = "run-1", findings = 2): void {
  st.recordEngineReviewWal("lane-a", { runId, head: "head-1", base: "b", diffHash: "d", attemptStart: "t" });
  st.recordEngineReviewWalArtifact(
    "lane-a",
    runId,
    "rejected",
    JSON.stringify({
      perAC: [],
      findings: Array.from({ length: findings }, (_, i) => ({ id: `F-${i}`, body: `FINDING BODY ${i}` })),
      sessionActualModels: ["m"],
      promptHash: "p",
    }),
  );
}

test("#461 AC2: a recorded disputed finding for the standing verdict yields dispute evidence — finding ref, reviewer body, producer reply, head", () => {
  const st = new State(":memory:");
  seedRejectedWal(st);
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 1, resolution: "disputed", reply: "THE PRODUCER REPLY" }]);
  const escalation = computeFindingDisputeEscalation(st, "lane-a", 55, "run-1");
  assert.deepEqual(escalation, {
    headOid: "head-1",
    source: "finding",
    items: [{ ref: "run-1#1", findingBody: "FINDING BODY 1", reply: "THE PRODUCER REPLY" }],
  });
  st.close();
});

test("#461 AC2: an ADDRESSED-only finding response never escalates (only a dispute routes)", () => {
  const st = new State(":memory:");
  seedRejectedWal(st);
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 0, resolution: "addressed", reply: "fixed it" }]);
  assert.equal(computeFindingDisputeEscalation(st, "lane-a", 55, "run-1"), null);
  st.close();
});

test("#461: a dispute recorded against an OLDER run never escalates the CURRENT verdict (fail-closed on a superseded review)", () => {
  const st = new State(":memory:");
  seedRejectedWal(st, "run-2");
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 0, resolution: "disputed", reply: "stale dispute" }]);
  assert.equal(computeFindingDisputeEscalation(st, "lane-a", 55, "run-2"), null);
  st.close();
});

test("#461: a LATER round's addressed response supersedes an earlier dispute of the same finding (last receipt wins)", () => {
  const st = new State(":memory:");
  seedRejectedWal(st);
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 0, resolution: "disputed", reply: "disagree" }], 1);
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 0, resolution: "addressed", reply: "ok, fixed" }], 2);
  assert.equal(computeFindingDisputeEscalation(st, "lane-a", 55, "run-1"), null);
  st.close();
});

test("#461: no WAL artifact for the standing verdict -> null (never escalates on evidence it cannot show)", () => {
  const st = new State(":memory:");
  st.recordEngineReviewWal("lane-a", { runId: "run-1", head: "head-1", base: "b", diffHash: "d", attemptStart: "t" });
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 0, resolution: "disputed", reply: "disagree" }]);
  assert.equal(computeFindingDisputeEscalation(st, "lane-a", 55, "run-1"), null);
  st.close();
});

test("#461: a disputed index outside the artifact's finding range is dropped, never rendered as evidence", () => {
  const st = new State(":memory:");
  seedRejectedWal(st, "run-1", 1);
  seedFindingResponseQueued(st, [{ runId: "run-1", findingIndex: 5, resolution: "disputed", reply: "disagree" }]);
  assert.equal(computeFindingDisputeEscalation(st, "lane-a", 55, "run-1"), null);
  st.close();
});

test("#461 D1(b): the shipped fix.md documents findingResponses with runId + findingIndex copied from the audit comment", () => {
  const content = readFileSync(defaultFixPromptPath(), "utf8");
  assert.match(content, /findingResponses/);
  assert.match(content, /findingIndex/);
  assert.match(content, /runId/);
});
