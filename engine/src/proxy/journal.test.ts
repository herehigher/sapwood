// journal.test.ts (#234): the write-ahead ordering contract — persist intent -> fetch+cap ->
// persist canonical response+hash -> deliver — proven in isolation (a fake State, no real
// sqlite/HTTP needed; state.test.ts separately proves the real State methods this fakes). Also
// covers budget metering and frozen evidence bundle content-addressing.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ForgeProxyBundleRow, ForgeProxyIdentity, ForgeProxyJournalResponse, ForgeProxyJournalRow } from "../state/state.js";
import { journalIsComplete, ProxyTimeoutError, persistEvidenceBundle, remainingBudget, runJournaledCall } from "./journal.js";
import type { ProxyCaps } from "./tools.js";

const IDENTITY: ForgeProxyIdentity = { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 };
const CAPS: ProxyCaps = {
  maxIssuesPerCall: 10,
  defaultCommentsPerIssue: 20,
  maxCommentsPerCall: 100,
  maxRelationsPerIssue: 20,
  maxSearchResults: 20,
  fullCommentStreamOptIn: false,
};
const SCOPE = { owner: "o", repo: "r" };
const now = () => new Date("2026-07-17T00:00:00Z");

/** A minimal, fully in-memory fake of the ProxyJournalState surface — deliberately independent
 *  of state.ts's real sqlite-backed implementation (that's exercised separately in
 *  state.test.ts), so this suite proves the ORDERING contract on its own. */
class FakeJournalState {
  rows: (ForgeProxyJournalRow & { id: number })[] = [];
  bundles: ForgeProxyBundleRow[] = [];
  nextId = 1;
  failResponsePersist = false;

  nextForgeProxySeq(identity: ForgeProxyIdentity): number {
    const matching = this.rows.filter(
      (r) =>
        r.identity.roundId === identity.roundId &&
        r.identity.phase === identity.phase &&
        r.identity.role === identity.role &&
        r.identity.session === identity.session &&
        r.identity.attempt === identity.attempt,
    );
    return matching.length === 0 ? 1 : Math.max(...matching.map((r) => r.seq)) + 1;
  }

  appendForgeProxyJournalIntent(row: {
    identity: ForgeProxyIdentity;
    seq: number;
    tool: string;
    proxyVersion: string;
    argsCanonical: string;
    scopeCanonical: string;
    capsCanonical: string;
    budgetRemainingCalls: number | null;
    budgetRemainingBytes: number | null;
    requestedAt: string;
  }): number {
    const id = this.nextId++;
    this.rows.push({
      id,
      identity: row.identity,
      seq: row.seq,
      tool: row.tool,
      proxyVersion: row.proxyVersion,
      argsCanonical: row.argsCanonical,
      scopeCanonical: row.scopeCanonical,
      capsCanonical: row.capsCanonical,
      budgetRemainingCalls: row.budgetRemainingCalls,
      budgetRemainingBytes: row.budgetRemainingBytes,
      status: "intent",
      upstreamIds: null,
      upstreamUpdatedAt: null,
      countsCanonical: null,
      truncated: false,
      responseCanonical: null,
      responseBytes: null,
      contentHash: null,
      error: null,
      timedOut: false,
      requestedAt: row.requestedAt,
      fetchedAt: null,
      deliveredAt: null,
    });
    return id;
  }

  recordForgeProxyJournalResponse(id: number, r: ForgeProxyJournalResponse): void {
    if (this.failResponsePersist) throw new Error("simulated disk-full: response persist failed");
    const row = this.rows.find((x) => x.id === id)!;
    row.status = "fetched";
    row.responseCanonical = r.responseCanonical;
    // #234 F4: same Buffer.byteLength (UTF-8) computation the real State.recordForgeProxyJournalResponse
    // uses — a fake that used .length (characters) would hide the exact multibyte undercount bug F4 fixed.
    row.responseBytes = Buffer.byteLength(r.responseCanonical, "utf8");
    row.contentHash = r.contentHash;
    row.upstreamIds = r.upstreamIds ?? null;
    row.upstreamUpdatedAt = r.upstreamUpdatedAt ?? null;
    row.countsCanonical = r.countsCanonical ?? null;
    row.truncated = r.truncated;
    row.fetchedAt = r.fetchedAt;
  }

  recordForgeProxyJournalError(id: number, error: string, timedOut: boolean, at: string): void {
    const row = this.rows.find((x) => x.id === id)!;
    row.status = "error";
    row.error = error;
    row.timedOut = timedOut;
    row.fetchedAt = at;
  }

  markForgeProxyJournalDelivered(id: number, at: string): void {
    const row = this.rows.find((x) => x.id === id)!;
    row.status = "delivered";
    row.deliveredAt = at;
  }

  listForgeProxyJournal(identity: ForgeProxyIdentity): ForgeProxyJournalRow[] {
    return this.rows.filter(
      (r) =>
        r.identity.roundId === identity.roundId &&
        r.identity.phase === identity.phase &&
        r.identity.role === identity.role &&
        r.identity.session === identity.session &&
        r.identity.attempt === identity.attempt,
    );
  }

  forgeProxyUsage(identity: ForgeProxyIdentity): { calls: number; bytes: number } {
    // #234 F3: EVERY row counts toward `calls` (including 'intent' — reserve-on-intent closes
    // the concurrent-calls race), matching the real State.forgeProxyUsage's semantics exactly.
    const rows = this.listForgeProxyJournal(identity);
    const calls = rows.length;
    const bytes = rows.filter((r) => r.status === "fetched" || r.status === "delivered").reduce((s, r) => s + (r.responseBytes ?? 0), 0);
    return { calls, bytes };
  }

  bundleDir: string | null = null;
  forgeProxyBundleDir(): string | null {
    return this.bundleDir;
  }
  recordForgeProxyBundle(row: ForgeProxyBundleRow): void {
    if (!this.bundles.some((b) => b.hash === row.hash)) this.bundles.push(row);
  }
}

test("runJournaledCall: happy path follows intent -> fetched -> delivered ordering, response persisted BEFORE the caller ever sees it", async () => {
  const state = new FakeJournalState();
  const result = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "issue_details",
    args: { numbers: [1] },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { hello: "world" }, counts: { returned: 1 }, truncated: false }),
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.journalId);
  const row = state.rows[0]!;
  assert.equal(row.status, "fetched"); // persisted BEFORE this function returned ok:true
  assert.equal(row.seq, 1);
  assert.ok(row.responseCanonical);
  assert.ok(row.contentHash);
  assert.equal(row.requestedAt, now().toISOString());
});

test("runJournaledCall: a response-persist FAILURE yields a typed persist_failed error, and the fetched value is NEVER delivered to the caller", async () => {
  const state = new FakeJournalState();
  state.failResponsePersist = true;
  const result = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "issue_details",
    args: { numbers: [1] },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { secret: "should never be delivered" } }),
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(!result.ok && result.error.code, "persist_failed");
  // The intent row is still there (write-ahead: it was persisted before the fetch even ran) but
  // never reached 'fetched' — the completeness invariant correctly identifies this as OK (an
  // intent-only row is not a "delivered without a journal row" violation — nothing was delivered).
  assert.equal(state.rows[0]!.status, "intent");
  assert.equal(journalIsComplete(state.listForgeProxyJournal(IDENTITY)), true);
});

test("runJournaledCall: after a persist failure, a SUBSEQUENT call in the same session still works — the session can retry or abstain, never wedged", async () => {
  const state = new FakeJournalState();
  state.failResponsePersist = true;
  const failed = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "issue_details",
    args: { numbers: [1] },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { a: 1 } }),
  });
  assert.equal(failed.ok, false);
  state.failResponsePersist = false;
  const ok = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "issue_details",
    args: { numbers: [2] },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { b: 2 } }),
  });
  assert.equal(ok.ok, true);
  assert.equal(state.rows[1]!.seq, 2, "monotonic seq continued across the failed call");
});

test("runJournaledCall: an upstream fetch failure is journaled as a sanitized 'error' row, never a throw", async () => {
  const state = new FakeJournalState();
  const result = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "x" },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => {
      throw new Error("gh api failed: token ghp_ABCDEFGHIJ0123456789abcdefghij rejected");
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && !result.error.message.includes("ghp_"));
  assert.equal(state.rows[0]!.status, "error");
  assert.ok(!state.rows[0]!.error!.includes("ghp_"));
});

test("runJournaledCall: a ProxyTimeoutError is recorded with timed_out=1 on the journal row", async () => {
  const state = new FakeJournalState();
  await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "x" },
    caps: CAPS,
    budget: { maxCallsPerSession: 10, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => {
      throw new ProxyTimeoutError("tool call timed out after 30000ms");
    },
  });
  assert.equal(state.rows[0]!.timedOut, true);
});

// ── budget metering (issue #234: meter call count + response bytes against the journal itself) ─

test("remainingBudget: floors at 0, computed fresh from the journal (not an in-memory counter)", async () => {
  const state = new FakeJournalState();
  await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "x" },
    caps: CAPS,
    budget: { maxCallsPerSession: 1, maxBytesPerSession: 10_000 },
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { ok: true } }),
  });
  const remaining = remainingBudget(state, IDENTITY, { maxCallsPerSession: 1, maxBytesPerSession: 10_000 });
  assert.equal(remaining.calls, 0);
});

test("runJournaledCall: call-budget exhaustion -> explicit budget_exhausted tool error, no journal row written (nothing was attempted)", async () => {
  const state = new FakeJournalState();
  const budget = { maxCallsPerSession: 1, maxBytesPerSession: 10_000 };
  await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "x" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { ok: true } }),
  });
  const second = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "y" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { ok: true } }),
  });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.code, "budget_exhausted");
  assert.equal(state.rows.length, 1, "the exhausted call never even got an intent row");
});

test("runJournaledCall: byte-budget exhaustion mid-session -> explicit budget_exhausted tool result (not a transport error), after journaling the attempt as an error", async () => {
  const state = new FakeJournalState();
  const budget = { maxCallsPerSession: 10, maxBytesPerSession: 5 }; // tiny byte budget
  const result = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "x" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { much: "more than five bytes of json" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "budget_exhausted");
});

// ── concurrency (#234 F3, PR #252 review, P1, Codex #2): reservation must survive two calls
//    racing across the `await fetch()` boundary — proven with a FakeJournalState whose method
//    calls are synchronous, same as the real node:sqlite-backed State, so calling an async
//    function twice back-to-back deterministically exercises the race (each call runs
//    synchronously up to its own first `await`, exactly like the real engine). ─────────────────

test("runJournaledCall: TWO overlapping calls at maxCallsPerSession=1 -- the second is rejected even though the first's fetch is still in-flight when the second reserves (reserve-on-intent closes the race)", async () => {
  const state = new FakeJournalState();
  const budget = { maxCallsPerSession: 1, maxBytesPerSession: 1_000_000 };
  let resolveFirst: ((v: { value: unknown }) => void) | undefined;
  // Calling this starts A running SYNCHRONOUSLY through remainingBudget -> nextSeq ->
  // appendForgeProxyJournalIntent (no `await` in that stretch) before suspending at `await
  // fetch()` below -- so by the time this line returns, A's 'intent' row is already committed.
  const first = runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "a" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  });
  assert.equal(state.rows.length, 1, "A's intent row already landed synchronously");
  // B's OWN reservation check now runs -- it must see A's intent-only row counted against the
  // call budget (pre-F3, only fetched/delivered/error counted, so B would wrongly be admitted).
  const second = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "b" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { b: 2 } }),
  });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.code, "budget_exhausted");
  assert.equal(state.rows.length, 1, "B never got its own intent row -- rejected before persisting one");
  resolveFirst!({ value: { a: 1 } });
  const firstResult = await first;
  assert.equal(firstResult.ok, true, "A itself still completes normally");
});

test("runJournaledCall: the byte-budget check is a FRESH re-read taken immediately before persist, not the stale pre-fetch snapshot -- a second call that would fit the budget alone but not on top of a concurrently-finalized first call is rejected", async () => {
  const state = new FakeJournalState();
  // Sized so exactly one of the two responses fits: `{"v":"b"}` = 9 bytes, `{"v":"aaaaa"}` = 13
  // bytes: 9 alone fits under 15; 9+13=22 does not. Under the PRE-F3 bug, the second call to
  // finalize would check its response against a snapshot taken at RESERVATION time (before
  // either response was persisted), which is `remaining.bytes = 15 - 0 = 15` -- 13 < 15 would
  // have wrongly ADMITTED it, landing 22 bytes against a 15-byte budget.
  const budget = { maxCallsPerSession: 10, maxBytesPerSession: 15 };
  let resolveA: ((v: { value: unknown }) => void) | undefined;
  const pA = runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "a" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  });
  // B's fetch resolves immediately and finalizes FIRST, consuming 9 of the 15-byte budget.
  const rB = await runJournaledCall({
    state,
    identity: IDENTITY,
    tool: "search_issues",
    args: { query: "b" },
    caps: CAPS,
    budget,
    scope: SCOPE,
    now,
    fetch: async () => ({ value: { v: "b" } }),
  });
  assert.equal(rB.ok, true);
  assert.equal(state.forgeProxyUsage(IDENTITY).bytes, 9);
  // A's fetch now resolves and it attempts to finalize SECOND -- its own response (13 bytes)
  // alone would fit under 15, but 9 (B's, already landed) + 13 = 22 must NOT be admitted.
  resolveA!({ value: { v: "aaaaa" } });
  const rA = await pA;
  assert.equal(rA.ok, false);
  assert.equal(!rA.ok && rA.error.code, "budget_exhausted");
  assert.equal(state.forgeProxyUsage(IDENTITY).bytes, 9, "A's oversized response was never persisted");
});

// ── journalIsComplete: the primitive a future final-output-acceptance gate calls ────────────

test("journalIsComplete: true when every fetched/delivered row carries a persisted response", () => {
  const rows: ForgeProxyJournalRow[] = [
    {
      id: 1,
      identity: IDENTITY,
      seq: 1,
      tool: "t",
      proxyVersion: "1",
      argsCanonical: "{}",
      scopeCanonical: "{}",
      capsCanonical: "{}",
      budgetRemainingCalls: null,
      budgetRemainingBytes: null,
      status: "delivered",
      upstreamIds: null,
      upstreamUpdatedAt: null,
      countsCanonical: null,
      truncated: false,
      responseCanonical: "{}",
      responseBytes: 2,
      contentHash: "h",
      error: null,
      timedOut: false,
      requestedAt: "t",
      fetchedAt: "t",
      deliveredAt: "t",
    },
    {
      id: 2,
      identity: IDENTITY,
      seq: 2,
      tool: "t",
      proxyVersion: "1",
      argsCanonical: "{}",
      scopeCanonical: "{}",
      capsCanonical: "{}",
      budgetRemainingCalls: null,
      budgetRemainingBytes: null,
      status: "error",
      upstreamIds: null,
      upstreamUpdatedAt: null,
      countsCanonical: null,
      truncated: false,
      responseCanonical: null,
      responseBytes: null,
      contentHash: null,
      error: "e",
      timedOut: false,
      requestedAt: "t",
      fetchedAt: "t",
      deliveredAt: null,
    },
  ];
  assert.equal(journalIsComplete(rows), true);
});

test("journalIsComplete: false for a delivered row with no persisted response (the shape the ordering contract should make impossible)", () => {
  const rows: ForgeProxyJournalRow[] = [
    {
      id: 1,
      identity: IDENTITY,
      seq: 1,
      tool: "t",
      proxyVersion: "1",
      argsCanonical: "{}",
      scopeCanonical: "{}",
      capsCanonical: "{}",
      budgetRemainingCalls: null,
      budgetRemainingBytes: null,
      status: "delivered",
      upstreamIds: null,
      upstreamUpdatedAt: null,
      countsCanonical: null,
      truncated: false,
      responseCanonical: null,
      responseBytes: null,
      contentHash: null,
      error: null,
      timedOut: false,
      requestedAt: "t",
      fetchedAt: null,
      deliveredAt: "t",
    },
  ];
  assert.equal(journalIsComplete(rows), false);
});

// ── frozen evidence bundles ──────────────────────────────────────────────────────────────────

test("persistEvidenceBundle: content-addressed by SHA-256 of the canonical bundle; idempotent re-persist of identical content", () => {
  const state = new FakeJournalState();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-proxy-bundle-"));
  try {
    state.bundleDir = dir;
    const input = {
      identity: { roundId: 1, phase: "architecting", role: "architect", session: "s1" },
      defaultView: { number: 1 },
      responses: [{ tool: "issue_details", args: { numbers: [1] }, response: { number: 1 } }],
    };
    const first = persistEvidenceBundle(state, input, now);
    const second = persistEvidenceBundle(state, input, now);
    assert.equal(first.hash, second.hash);
    assert.equal(state.bundles.length, 1, "re-persisting identical content is a no-op past the first write");
    assert.ok(first.path);
    assert.ok(existsSync(first.path!));
    const onDisk = JSON.parse(readFileSync(first.path!, "utf8"));
    assert.deepEqual(onDisk.defaultView, input.defaultView);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistEvidenceBundle: decisionRef is recorded when supplied, links the bundle to a decision", () => {
  const state = new FakeJournalState();
  const input = {
    identity: { roundId: 1, phase: "architecting", role: "architect", session: "s1" },
    defaultView: { number: 1 },
    responses: [],
    decisionRef: "architect-contradiction-1",
  };
  persistEvidenceBundle(state, input, now);
  assert.equal(state.bundles[0]!.decisionRef, "architect-contradiction-1");
});

test("persistEvidenceBundle: no data dir (in-memory State convention) -> path is null but the hash-addressed DB row is still recorded", () => {
  const state = new FakeJournalState();
  state.bundleDir = null;
  const input = { identity: { roundId: 1, phase: "architecting", role: "architect", session: "s1" }, defaultView: {}, responses: [] };
  const r = persistEvidenceBundle(state, input, now);
  assert.equal(r.path, null);
  assert.equal(state.bundles.length, 1);
});
