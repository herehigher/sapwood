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
  computeFixResponseHarvest,
  fixLegJournalCursor,
  fixResponseBatchKey,
  journaledReviewThreadIds,
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

  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: 30, resultText });
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
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 2, prNumber: 30, resultText });
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
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: 30, resultText });
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
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: 30, resultText });
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
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: 30, resultText });
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
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 2, prNumber: 30, resultText });
  assert.equal(outcome.kind, "batch");
  st.close();
});

test("computeFixResponseHarvest: no PR -> invalid descriptor, never throws", () => {
  const st = new State(":memory:");
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 1, prNumber: null, resultText: "" });
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
  implements Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "getReviewThreadCommentsTail" | "addLabel" | "addPRLabel">
{
  calls: string[] = [];
  throwOnReply = false;
  throwOnResolve = false;
  throwOnCheckOnce = false;
  throwOnAddLabel = false;
  labelsAdded: Array<[number, string]> = [];
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
  async addLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddLabel) throw new Error("label write failed");
    this.labelsAdded.push([n, l]);
  }
  async addPRLabel(n: number, l: string): Promise<void> {
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
  assert.deepEqual(forge.labelsAdded, [[9, "needs-human"]]);
  assert.deepEqual(forge.prLabelsAdded, [[90, "needs-human"]]);
  st.close();
});

test("attemptThreadWrite (F4): a FAILED label write at the cap KEEPS the row pending (never clears it) and retries the escalation next tick", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnReply = true;
  forge.throwOnAddLabel = true; // the label write itself fails
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
  assert.deepEqual(forge.labelsAdded, [], "no label ever actually landed");

  // The forge recovers; the very next attempt both lands the label AND finalizes the escalation.
  forge.throwOnAddLabel = false;
  const recovered = await attemptThreadWrite(forge, st, cfg, row, () => new Date().toISOString());
  assert.equal(recovered.kind, "escalated");
  assert.deepEqual(st.pendingThreadWrites(), [], "cleared only NOW, after the label successfully landed");
  assert.deepEqual(forge.labelsAdded, [[9, "needs-human"]]);
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
