// #247: structured review-thread responses — fix-leg output validation + engine-executed
// idempotent replies/resolves. Mirrors harvest.test.ts's split: pure validator tests (schema +
// journal cross-check matrix) first, then attemptThreadWrite's durable-queue execution tests
// (fake forge, real in-memory State) asserting the exact call sequence + idempotency.
//
// Review round 1 (Codex sol-high PR #265): D1(b)/D2/D3/D6/D7 coverage added below, each section
// marked with its finding id.
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

test("D1(b): a resultText in EXACTLY fix.md's documented shape flows through validateFixResponseOutput -> State.enqueueThreadWrite -> attemptThreadWrite", async () => {
  // The literal shape fix.md instructs a fix leg to emit: a single addressed entry.
  const resultText = `${RESULT_BLOCK_START}\n{"threadResponses": [{"threadId": "PRRT_kwAAA1", "reply": "fixed as suggested", "resolution": "addressed"}]}\n${RESULT_BLOCK_END}`;
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, at: "2026-07-19T00:00:00Z" });
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
    "check:30",
    "reply:PRRT_kwAAA1:fixed as suggested\n\n<!-- sapwood:fix-reply:lane-fix#1:PRRT_kwAAA1 -->",
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

// ── fixLegJournalCursor + computeFixResponseHarvest: leg-bound scoping (D2) ────────────────

test("fixLegJournalCursor: returns the matching (worker, fixRounds) fix-leg-started event's own `at`", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, at: "2026-07-19T00:00:00Z" });
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, at: "2026-07-19T01:00:00Z" });
  st.appendEvent("fix-leg-started", { worker: "lane-other", issue: 5, pr: 50, fixRounds: 1, at: "2026-07-19T02:00:00Z" });
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), "2026-07-19T00:00:00Z");
  assert.equal(fixLegJournalCursor(st, "lane-fix", 2), "2026-07-19T01:00:00Z");
  assert.equal(fixLegJournalCursor(st, "lane-other", 1), "2026-07-19T02:00:00Z");
  st.close();
});

test("fixLegJournalCursor: no matching event -> null (fail-closed — the caller trusts nothing)", () => {
  const st = new State(":memory:");
  assert.equal(fixLegJournalCursor(st, "lane-fix", 1), null);
  st.close();
});

test("fixResponseBatchKey: deterministic, worker+fixRounds scoped", () => {
  assert.equal(fixResponseBatchKey("lane-fix", 1), "lane-fix#1");
  assert.equal(fixResponseBatchKey("lane-fix", 2), "lane-fix#2");
  assert.notEqual(fixResponseBatchKey("lane-fix", 1), fixResponseBatchKey("lane-other", 1));
});

test("computeFixResponseHarvest (D2 adversarial, cross-leg): round 2 must NOT trust a threadId only round 1's journal ever saw", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, at: "2026-07-19T00:00:00Z" });
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
    requestedAt: "2026-07-19T00:00:01Z", // round 1's own request
  });
  st.recordForgeProxyJournalResponse(id1, {
    responseCanonical: JSON.stringify({ pr: 30, threads: [{ id: "ROUND1_ONLY" }] }),
    contentHash: "h1",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:01Z",
  });
  // Round 2 starts LATER — its own journal cursor excludes everything round 1 journaled.
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, at: "2026-07-19T02:00:00Z" });

  const resultText = sapwoodResult({ threadResponses: [{ threadId: "ROUND1_ONLY", reply: "handled", resolution: "addressed" }] });
  const outcome = computeFixResponseHarvest(st, { worker: "lane-fix", issue: 9, fixRounds: 2, prNumber: 30, resultText });
  assert.equal(outcome.kind, "invalid", "round 2 must never validate a threadId only round 1's journal ever saw");
  st.close();
});

test("computeFixResponseHarvest: round 2 DOES trust a threadId ITS OWN journal saw, even though round 1 also ran on the same session", () => {
  const st = new State(":memory:");
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 1, at: "2026-07-19T00:00:00Z" });
  st.appendEvent("fix-leg-started", { worker: "lane-fix", issue: 9, pr: 30, fixRounds: 2, at: "2026-07-19T02:00:00Z" });
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
  implements Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "getPRReviewThreads" | "addLabel" | "addPRLabel">
{
  calls: string[] = [];
  throwOnReply = false;
  throwOnResolve = false;
  throwOnCheckOnce = false;
  labelsAdded: Array<[number, string]> = [];
  prLabelsAdded: Array<[number, string]> = [];
  /** Simulates GitHub's own live state: pr -> threadId -> posted comment bodies. Seeded by
   *  replyToReviewThread itself (defaults every reply to PR 90's thread bucket, matching
   *  seedRow's default `pr: 90`) so existing tests never need to pre-seed this. */
  threads: Record<number, Record<string, string[]>> = { 90: {} };
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    this.calls.push(`reply:${threadId}:${body}`);
    if (this.throwOnReply) throw new Error("reply failed");
    this.threads[90] ??= {};
    const bucket = this.threads[90];
    bucket[threadId] ??= [];
    bucket[threadId].push(body);
  }
  async resolveReviewThread(threadId: string): Promise<void> {
    this.calls.push(`resolve:${threadId}`);
    if (this.throwOnResolve) throw new Error("resolve failed");
  }
  async getPRReviewThreads(pr: number, _commentsCap: number) {
    this.calls.push(`check:${pr}`);
    if (this.throwOnCheckOnce) {
      this.throwOnCheckOnce = false;
      throw new Error("transient read failure");
    }
    const bucket = this.threads[pr] ?? {};
    const threads = Object.entries(bucket).map(([id, bodies]) => ({
      id,
      isResolved: false,
      commentsComplete: true,
      comments: bodies.map((body) => ({ author: "worker", body, createdAt: "t" })),
    }));
    return { threads, pageCapped: false };
  }
  async addLabel(n: number, l: string): Promise<void> {
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
      batchKey: "lane-fix#1",
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
  assert.deepEqual(forge.calls, ["check:90", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#1:T1 -->", "resolve:T1"]);
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(st.pendingThreadWrites(), [], "fully executed -> row cleared");
  st.close();
});

test("attemptThreadWrite: a 'disputed' row checks + replies ONLY (never resolve) and clears the row — speak-not-act", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { resolution: "disputed", reply: "disagree" });
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => new Date().toISOString());
  assert.deepEqual(forge.calls, ["check:90", "reply:T1:disagree\n\n<!-- sapwood:fix-reply:lane-fix#1:T1 -->"]);
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
    ["check:90", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#1:T1 -->", "resolve:T1"],
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

test("attemptThreadWrite: escalates (needs-human label, clears the row) once attempts hit cfg.recovery.rollbackRetryCap — bounded retry, never forever", async () => {
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

// ── D3: crash-safety — a reply POST that succeeded upstream but crashed before its durable
//    reply_posted flag committed must NEVER be re-posted ───────────────────────────────────

test("D3: simulated crash (forge reply succeeds, the durable reply_posted write throws) -> rerun finds the marker and does NOT double-post", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st);
  let throwOnMark = true;
  const crashingState: Pick<
    State,
    "markThreadReplyPosted" | "markThreadResolved" | "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent"
  > = {
    markThreadReplyPosted: (id, at) => {
      if (throwOnMark) {
        throwOnMark = false;
        throw new Error("simulated crash before the durable flag commits");
      }
      st.markThreadReplyPosted(id, at);
    },
    markThreadResolved: (id, at) => st.markThreadResolved(id, at),
    bumpThreadWriteAttempt: (id, at) => st.bumpThreadWriteAttempt(id, at),
    clearThreadWrite: (id) => st.clearThreadWrite(id),
    appendEvent: (kind, payload) => st.appendEvent(kind, payload),
  };

  const first = await attemptThreadWrite(forge, crashingState, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(first.kind, "retrying", "the durable flag write failed -> treated as a retry");
  assert.deepEqual(
    forge.calls,
    ["check:90", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#1:T1 -->"],
    "the forge reply call happened exactly ONCE",
  );
  assert.equal(st.pendingThreadWrites()[0]!.replyPosted, false, "the durable flag never committed — the simulated crash");

  forge.calls = [];
  const rowAfterFirst = st.pendingThreadWrites()[0]!;
  const second = await attemptThreadWrite(forge, crashingState, mkCfg(), rowAfterFirst, () => "2026-07-19T00:01:00Z");
  assert.equal(second.kind, "resolved");
  assert.deepEqual(
    forge.calls,
    ["check:90", "resolve:T1"],
    "the marker is found on the live thread -> replyToReviewThread is NEVER called a second time",
  );
  assert.deepEqual(st.pendingThreadWrites(), []);
  st.close();
});

test("D3: replyAlreadyPosted's read failure fails toward 'not yet posted' — a transient getPRReviewThreads error never blocks the reply attempt", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnCheckOnce = true;
  const row = seedRow(st);
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(outcome.kind, "resolved", "the check's own failure never blocks the reply — it fails toward 'not posted yet'");
  assert.deepEqual(forge.calls, ["check:90", "reply:T1:fixed\n\n<!-- sapwood:fix-reply:lane-fix#1:T1 -->", "resolve:T1"]);
  st.close();
});

// ── D6: provenance — every executed write journals leg/round provenance via SEPARATE
//    reply-posted / resolved receipt events ────────────────────────────────────────────────

test("D6: attemptThreadWrite emits SEPARATE fix-thread-reply-posted / fix-thread-resolved receipt events, each carrying batchKey + fixRounds provenance", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { batchKey: "lane-fix#3", fixRounds: 3 });
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
    assert.equal(p.batchKey, "lane-fix#3");
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
