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

function fakeForge(): ProxyForge {
  const meta: IssueMeta = { number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "2026-07-17T00:00:00Z" };
  const comments: PRComment[] = [];
  const relations: IssueRelations = { linkedPRs: [], crossReferences: [], truncated: false };
  const results: IssueSearchResult[] = [];
  const prDetails: PRDetails = { number: 1, headOid: "abc", state: "OPEN", draft: false, labels: [], mergeable: "MERGEABLE" };
  const reviews: PRReviewItem[] = [];
  const threads: ReviewThreadItem[] = [];
  const checks: PRCheckItem[] = [];
  return {
    getIssueMeta: async () => meta,
    getIssueBody: async () => "",
    getIssueComments: async () => comments,
    getIssueRelations: async () => relations,
    searchIssues: async () => results,
    getPRDetails: async () => prDetails,
    getPRReviews: async () => reviews,
    getPRReviewThreads: async () => threads,
    getPRChecks: async () => checks,
  };
}

test("createProxyMint: mints a handle scoped to the caller's role — an issue-oriented role gets ISSUE_TOOLS, 'worker' gets PR_TOOLS", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const state = new State(":memory:");
  try {
    const mint = createProxyMint({ cfg, forge: fakeForge(), state, roundId: 1, phase: "architecting" });
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
        ["pr_details", "pr_reviews", "pr_review_threads", "pr_checks"].map((t) => `mcp__forge__${t}`).sort(),
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
    const mint = createProxyMint({ cfg, forge: fakeForge(), state, roundId: 1, phase: "p" });
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
    const mint = createProxyMint({ cfg, forge: fakeForge(), state, roundId: 1, phase: "p" });
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
