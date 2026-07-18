// #247: structured review-thread responses — fix-leg output validation + engine-executed
// idempotent replies/resolves. Mirrors harvest.test.ts's split: pure validator tests (schema +
// journal cross-check matrix) first, then attemptThreadWrite's durable-queue execution tests
// (fake forge, real in-memory State) asserting the exact call sequence + idempotency.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { deriveReviewAction } from "../roles/reviewer.js";
import type { PendingThreadWrite } from "../state/state.js";
import { State } from "../state/state.js";
import { RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import { attemptThreadWrite, journaledReviewThreadIds, validateFixResponseOutput } from "./fix-response.js";

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

// ── journaledReviewThreadIds: the no-TOCTOU set ─────────────────────────────────────────────

function journalRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    identity: { roundId: 1, phase: "fixing", role: "worker", session: "lane-fix", attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: "{}",
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: null,
    budgetRemainingBytes: null,
    status: "fetched",
    upstreamIds: null,
    upstreamUpdatedAt: null,
    countsCanonical: null,
    truncated: false,
    responseCanonical: JSON.stringify({ pr: 1, threads: [{ id: "T1" }, { id: "T2" }], total: 2, returned: 2, complete: true }),
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

test("journaledReviewThreadIds: collects thread ids from a fetched pr_review_threads row", () => {
  const ids = journaledReviewThreadIds([journalRow({})] as never);
  assert.deepEqual([...ids].sort(), ["T1", "T2"]);
});

test("journaledReviewThreadIds: ignores a different tool's rows entirely", () => {
  const ids = journaledReviewThreadIds([
    journalRow({ tool: "pr_details", responseCanonical: JSON.stringify({ threads: [{ id: "SNEAKY" }] }) }),
  ] as never);
  assert.deepEqual([...ids], []);
});

test("journaledReviewThreadIds: ignores an 'intent'/'error' status row (no response persisted yet)", () => {
  const ids = journaledReviewThreadIds([journalRow({ status: "intent", responseCanonical: null })] as never);
  assert.deepEqual([...ids], []);
});

test("journaledReviewThreadIds: unions ids across MULTIPLE journal rows (a leg that called the tool more than once)", () => {
  const rows = [
    journalRow({ id: 1, seq: 1, responseCanonical: JSON.stringify({ threads: [{ id: "A" }] }) }),
    journalRow({ id: 2, seq: 2, responseCanonical: JSON.stringify({ threads: [{ id: "B" }] }) }),
  ];
  const ids = journaledReviewThreadIds(rows as never);
  assert.deepEqual([...ids].sort(), ["A", "B"]);
});

test("journaledReviewThreadIds: a malformed response row is skipped, never thrown", () => {
  const ids = journaledReviewThreadIds([journalRow({ responseCanonical: "not json" })] as never);
  assert.deepEqual([...ids], []);
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

function mkCfg(): Pick<SapwoodConfig, "recovery" | "labels"> {
  return {
    recovery: { rollbackRetryCap: 3 },
    labels: { needsHuman: "needs-human" } as SapwoodConfig["labels"],
  };
}

class FakeThreadForge implements Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "addLabel" | "addPRLabel"> {
  calls: string[] = [];
  throwOnReply = false;
  throwOnResolve = false;
  labelsAdded: Array<[number, string]> = [];
  prLabelsAdded: Array<[number, string]> = [];
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    this.calls.push(`reply:${threadId}:${body}`);
    if (this.throwOnReply) throw new Error("reply failed");
  }
  async resolveReviewThread(threadId: string): Promise<void> {
    this.calls.push(`resolve:${threadId}`);
    if (this.throwOnResolve) throw new Error("resolve failed");
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
    { worker: "lane-fix", issue: 9, pr: 90, threadId: "T1", reply: "fixed", resolution: "addressed", ...over },
    "2026-07-19T00:00:00Z",
  );
  return st.pendingThreadWrites().find((r) => r.id === id)!;
}

test("attemptThreadWrite: an 'addressed' row calls reply THEN resolve, in order, and clears the row on success", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st);
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.deepEqual(forge.calls, ["reply:T1:fixed", "resolve:T1"]);
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(st.pendingThreadWrites(), [], "fully executed -> row cleared");
  st.close();
});

test("attemptThreadWrite: a 'disputed' row calls reply ONLY (never resolve) and clears the row — speak-not-act", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  const row = seedRow(st, { resolution: "disputed", reply: "disagree" });
  const outcome = await attemptThreadWrite(forge, st, mkCfg(), row, () => new Date().toISOString());
  assert.deepEqual(forge.calls, ["reply:T1:disagree"]);
  assert.equal(outcome.kind, "recorded");
  assert.deepEqual(st.pendingThreadWrites(), []);
  st.close();
});

test("attemptThreadWrite idempotency: a failed resolve retries next tick WITHOUT re-posting the reply", async () => {
  const st = new State(":memory:");
  const forge = new FakeThreadForge();
  forge.throwOnResolve = true;
  const row = seedRow(st);

  const first = await attemptThreadWrite(forge, st, mkCfg(), row, () => "2026-07-19T00:00:01Z");
  assert.equal(first.kind, "retrying");
  assert.deepEqual(forge.calls, ["reply:T1:fixed", "resolve:T1"], "attempt 1: reply posted, resolve attempted and failed");
  const rowAfterFirst = st.pendingThreadWrites()[0]!;
  assert.equal(rowAfterFirst.replyPosted, true, "reply is durably marked posted");
  assert.equal(rowAfterFirst.resolved, false);
  assert.equal(rowAfterFirst.attempts, 1);

  forge.throwOnResolve = false; // the transient forge failure clears
  forge.calls = [];
  const second = await attemptThreadWrite(forge, st, mkCfg(), rowAfterFirst, () => "2026-07-19T00:01:00Z");
  assert.equal(second.kind, "resolved");
  assert.deepEqual(forge.calls, ["resolve:T1"], "retry only calls resolve — the reply is NEVER double-posted");
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
