// mint.test.ts (#244): createProxyMint — folds config + the role x tool matrix into a concrete
// `mint` function of the exact shape peripheral.ts's RoleSessionOpts.proxy / worker.ts's
// WorkerProxyOpts both expect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type {
  IssueMeta,
  IssueRelations,
  IssueSearchResult,
  PRCheckItem,
  PRComment,
  PRDetails,
  PRReviewItem,
  ReviewThreadItem,
} from "../forge/forge.js";
import { State } from "../state/state.js";
import type { ProxyForge } from "./mcp-server.js";
import { createProxyMint } from "./mint.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

function fakeForge(over: Partial<ProxyForge> = {}): ProxyForge {
  const meta: IssueMeta = { number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "2026-07-17T00:00:00Z" };
  const comments: PRComment[] = [];
  const relations: IssueRelations = { linkedPRs: [], crossReferences: [], truncated: false };
  const results: IssueSearchResult[] = [];
  const prDetails: PRDetails = {
    number: 1,
    headOid: "abc",
    baseRefName: "develop",
    state: "OPEN",
    draft: false,
    labels: [],
    mergeable: "MERGEABLE",
  };
  const reviews: PRReviewItem[] = [];
  const threads: ReviewThreadItem[] = [
    {
      id: "T1",
      isResolved: false,
      comments: [{ author: "codex", body: "fix this", createdAt: "2026-07-18T00:00:00Z" }],
      commentsComplete: true,
    },
  ];
  const checks: PRCheckItem[] = [];
  return {
    getIssueMeta: async () => meta,
    getIssueBody: async () => "",
    getIssueComments: async () => comments,
    getIssueRelations: async () => relations,
    searchIssues: async () => results,
    getPRDetails: async () => prDetails,
    getPRReviews: async () => ({ reviews, total: reviews.length }),
    getPRReviewThreads: async () => ({ threads, pageCapped: false }),
    getPRChecks: async () => ({ checks, total: checks.length }),
    getPRComments: async () => ({ comments: [], total: 0 }),
    getFailedCheckSummary: async () => "(no failing check runs found via the checks API)",
    ...over,
  };
}

test("createProxyMint: mints a handle scoped to the caller's role — an issue-oriented role gets ISSUE_TOOLS, 'worker' gets PR_TOOLS", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const state = new State(":memory:");
  try {
    const mint = createProxyMint({ now: realClock, cfg, forge: fakeForge(), state, roundId: 1, phase: "architecting" });
    const architectHandle = await mint({ role: "architect", session: "role-architect-abc" });
    try {
      assert.deepEqual(
        architectHandle.toolNames.sort(),
        ["issue_details", "issue_comments", "issue_relations", "search_issues"].map((t) => `mcp__forge__${t}`).sort(),
      );
    } finally {
      await architectHandle.stop();
    }
    const workerHandle = await mint({ role: "worker", session: "lane-1-abc" });
    try {
      assert.deepEqual(
        workerHandle.toolNames.sort(),
        ["pr_details", "pr_reviews", "pr_review_threads", "pr_checks", "pr_audit_comments", "pr_failed_checks"]
          .map((t) => `mcp__forge__${t}`)
          .sort(),
      );
    } finally {
      await workerHandle.stop();
    }
  } finally {
    state.close();
  }
});

test("createProxyMint: an unrecognized role mints a handle with ZERO tools (deny-by-default)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const state = new State(":memory:");
  try {
    const mint = createProxyMint({ now: realClock, cfg, forge: fakeForge(), state, roundId: 1, phase: "p" });
    const handle = await mint({ role: "some-typo-d-role", session: "s" });
    try {
      assert.deepEqual(handle.toolNames, []);
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
});

test("createProxyMint: each mint() call is a FRESH server (distinct port + token), never reused across sessions", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const state = new State(":memory:");
  try {
    const mint = createProxyMint({ now: realClock, cfg, forge: fakeForge(), state, roundId: 1, phase: "p" });
    const a = await mint({ role: "worker", session: "s1" });
    const b = await mint({ role: "worker", session: "s2" });
    try {
      assert.notEqual(a.token, b.token);
      assert.notEqual(a.port, b.port);
    } finally {
      await a.stop();
      await b.stop();
    }
  } finally {
    state.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #244 (Codex sol-high PR #260 review, P2): the issue's own verification-plan integration test —
// start a REAL proxy via the mint path for role "worker", drive it exactly as a worker leg would
// (real HTTP against the minted handle), and assert role-matrix enforcement + the journal/budget
// contract all in one flow.
// ─────────────────────────────────────────────────────────────────────────────

async function rpc(url: string, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function callTool(url: string, token: string, name: string, args: unknown) {
  const { json } = await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return json as { result: { isError: boolean; content: { type: string; text: string }[] } };
}

test("integration: a real proxy minted for role 'worker' enforces the role matrix (an issue tool -> role_denied) and journals + meters a successful pr_review_threads call, keyed by the session identity", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const state = new State(":memory:");
  try {
    const mint = createProxyMint({ now: realClock, cfg, forge: fakeForge(), state, roundId: 7, phase: "executing" });
    const handle = await mint({ role: "worker", session: "lane-42-abcdef" });
    try {
      // 1. Role-matrix enforcement: 'worker' gets PR_TOOLS only — an ISSUE tool is role_denied,
      //    exactly as a worker leg's session would experience it if it (incorrectly) tried one.
      const denied = await callTool(handle.url, handle.token, "issue_details", { numbers: [1] });
      assert.equal(denied.result.isError, true);
      assert.equal(JSON.parse(denied.result.content[0]!.text).code, "role_denied");

      // 2. A real pr_review_threads call — the fix-loop worker's own evidence channel — succeeds.
      const ok = await callTool(handle.url, handle.token, "pr_review_threads", { pr: 99 });
      assert.equal(ok.result.isError, false);
      const parsed = JSON.parse(ok.result.content[0]!.text) as { threads: { id: string }[]; complete: boolean };
      assert.equal(parsed.threads.length, 1);
      assert.equal(parsed.threads[0]!.id, "T1");
      assert.equal(parsed.complete, true);

      // 3. Journal rows carry the EXACT session identity mint() was called with — both the
      //    denied AND the successful call are journaled (a denied call is checked AFTER
      //    schema validation but its own row IS still the proof role-scoping ran at all... no:
      //    role_denied is checked before budget/journal work, per mcp-server.ts's own contract —
      //    so only the successful call produces a journal row here).
      const rows = state.listForgeProxyJournal({ roundId: 7, phase: "executing", role: "worker", session: "lane-42-abcdef", attempt: 1 });
      assert.equal(rows.length, 1, "the role-denied call never reserves budget or writes a journal row");
      assert.equal(rows[0]!.tool, "pr_review_threads");
      assert.equal(rows[0]!.status, "delivered");
      assert.ok(rows[0]!.responseCanonical);
      assert.ok(rows[0]!.contentHash);

      // 4. Ledgered spend — the proxy's own budget usage (call count + response bytes) reflects
      //    exactly the one successful call, metered from the journal itself.
      const usage = state.forgeProxyUsage({ roundId: 7, phase: "executing", role: "worker", session: "lane-42-abcdef", attempt: 1 });
      assert.equal(usage.calls, 1);
      assert.ok(usage.bytes > 0);
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
});
