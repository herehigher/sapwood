// tools.test.ts (#234): the fixed tool algebra's pure parts — arg schema/scope/cap validation,
// the default-view completeness contract (capComments), outgoing-mention extraction, error
// sanitization, and canonicalization. No HTTP/state involved (see mcp-server.test.ts/
// journal.test.ts for those).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueMeta, IssueRelations, PRCheckItem, PRComment, PRDetails, PRReviewItem, ReviewThreadItem } from "../forge/forge.js";
import {
  canonicalJson,
  capComments,
  capThreads,
  fetchIssueDetailsView,
  fetchIssueRelationsResponse,
  fetchPRChecksResponse,
  fetchPRDetailsResponse,
  fetchPRReviewsResponse,
  fetchPRReviewThreadsResponse,
  ISSUE_TOOLS,
  mcpToolFullName,
  outgoingMentions,
  PR_TOOLS,
  type ProxyCaps,
  sanitizeUpstreamError,
  TOOL_DEFINITIONS,
  TOOL_ISSUE_COMMENTS,
  TOOL_ISSUE_DETAILS,
  TOOL_ISSUE_RELATIONS,
  TOOL_NAMES,
  TOOL_PR_CHECKS,
  TOOL_PR_DETAILS,
  TOOL_PR_REVIEW_THREADS,
  TOOL_PR_REVIEWS,
  TOOL_SEARCH_ISSUES,
  validateToolArgs,
} from "./tools.js";

const CAPS: ProxyCaps = {
  maxIssuesPerCall: 3,
  defaultCommentsPerIssue: 2,
  maxCommentsPerCall: 5,
  maxRelationsPerIssue: 10,
  maxSearchResults: 10,
  fullCommentStreamOptIn: false,
  maxReviewThreadsPerCall: 2,
  maxCommentsPerThread: 10,
};

// ── tool names / tools/list ─────────────────────────────────────────────────────────────────

test("mcpToolFullName: namespaces under mcp__forge__", () => {
  assert.equal(mcpToolFullName(TOOL_ISSUE_DETAILS), "mcp__forge__issue_details");
});

test("TOOL_DEFINITIONS: one entry per fixed tool, in TOOL_NAMES order, each a strict object schema", () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name),
    TOOL_NAMES,
  );
  assert.equal(TOOL_DEFINITIONS.length, 8, "4 issue tools (#234) + 4 PR tools (#244)");
  for (const def of TOOL_DEFINITIONS) {
    assert.equal(def.inputSchema.type, "object");
    assert.equal(def.inputSchema.additionalProperties, false);
  }
});

test("ISSUE_TOOLS / PR_TOOLS: partition TOOL_NAMES exactly, no overlap", () => {
  assert.deepEqual([...ISSUE_TOOLS].sort(), [TOOL_ISSUE_COMMENTS, TOOL_ISSUE_DETAILS, TOOL_ISSUE_RELATIONS, TOOL_SEARCH_ISSUES].sort());
  assert.deepEqual([...PR_TOOLS].sort(), [TOOL_PR_CHECKS, TOOL_PR_DETAILS, TOOL_PR_REVIEWS, TOOL_PR_REVIEW_THREADS].sort());
  assert.deepEqual([...ISSUE_TOOLS, ...PR_TOOLS].sort(), [...TOOL_NAMES].sort());
});

// ── arg validation: schema / scope / cap / unknown-tool matrix (issue #234 AC) ──────────────

test("validateToolArgs: unknown tool name -> typed unknown_tool error", () => {
  const r = validateToolArgs("delete_everything", {}, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "unknown_tool");
});

test("validateToolArgs: malformed args (wrong shape) -> typed invalid_args error", () => {
  const r = validateToolArgs(TOOL_ISSUE_DETAILS, { numbers: "not-an-array" }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "invalid_args");
});

test("validateToolArgs: an out-of-repo-scope attempt (a caller-supplied repo/owner field) is REJECTED by the strict schema — there is no argument shape that could ever ask for a different repo", () => {
  const r = validateToolArgs(TOOL_ISSUE_DETAILS, { numbers: [1], repo: "someone-else/other-repo" }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "invalid_args");
});

test("validateToolArgs: issue_details over the maxIssuesPerCall cap -> REJECTED (typed over_cap error), never silently truncated", () => {
  const r = validateToolArgs(TOOL_ISSUE_DETAILS, { numbers: [1, 2, 3, 4] }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "over_cap");
});

test("validateToolArgs: issue_details at exactly the cap -> ok", () => {
  const r = validateToolArgs(TOOL_ISSUE_DETAILS, { numbers: [1, 2, 3] }, CAPS);
  assert.equal(r.ok, true);
});

test("validateToolArgs: issue_comments lastN over the cap -> REJECTED (typed over_cap error)", () => {
  const r = validateToolArgs(TOOL_ISSUE_COMMENTS, { number: 1, lastN: 6 }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "over_cap");
});

test("validateToolArgs: issue_comments with no lastN -> ok (server default cap applies later, not a validation concern)", () => {
  const r = validateToolArgs(TOOL_ISSUE_COMMENTS, { number: 1 }, CAPS);
  assert.equal(r.ok, true);
});

test("validateToolArgs: issue_relations / search_issues valid shapes -> ok", () => {
  assert.equal(validateToolArgs(TOOL_ISSUE_RELATIONS, { number: 1 }, CAPS).ok, true);
  assert.equal(validateToolArgs(TOOL_SEARCH_ISSUES, { query: "flaky test" }, CAPS).ok, true);
});

test("validateToolArgs: search_issues empty query -> invalid_args", () => {
  const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query: "" }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "invalid_args");
});

// ── #234 F1b (PR #252 review round 2, P1, defense-in-depth): a repo:/org:/user: qualifier
//    inside the search QUERY TEXT is a second scope-redirection surface, independent of the
//    argv-flag-injection vector F1 already closed — must be provable at THIS boundary, never
//    dependent on gh/GitHub's implicit qualifier-combination behavior. ─────────────────────────

test("validateToolArgs: search_issues rejects a query containing a repo: qualifier -> invalid_args, case-insensitive, embedded anywhere in the text", () => {
  for (const query of ["repo:other/repo", "is:open OR repo:x/y", "REPO:x/y", "foo repo:x/y bar"]) {
    const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query }, CAPS);
    assert.equal(r.ok, false, `expected rejection for query: ${query}`);
    assert.equal(!r.ok && r.error.code, "invalid_args", `expected invalid_args for query: ${query}`);
  }
});

test("validateToolArgs: search_issues rejects a query containing an org: or user: qualifier, case-insensitive", () => {
  for (const query of ["org:evil", "foo org:evil", "user:someone", "USER:someone"]) {
    const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query }, CAPS);
    assert.equal(r.ok, false, `expected rejection for query: ${query}`);
    assert.equal(!r.ok && r.error.code, "invalid_args", `expected invalid_args for query: ${query}`);
  }
});

// #234 F1b tightening (PR #252 review round 3): the original `(^|\s)` anchor only caught a
// qualifier preceded by start-of-string or whitespace — a qualifier preceded by ANY other
// non-word character (parens, commas, ...) slipped through unrejected. Verified live: all three
// of these PASSED validation under the old regex. The `\b` word-boundary anchor closes this —
// regression-pins the previously-passing bypass strings so they can never slip through again.
test("validateToolArgs: search_issues rejects a repo:/org:/user: qualifier preceded by a non-whitespace, non-word character (parens, commas) — the previously-passing bypass", () => {
  for (const query of ["(repo:cli/cli OR foo)", "foo,repo:x/y", "bar(org:evil)"]) {
    const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query }, CAPS);
    assert.equal(r.ok, false, `expected rejection for query: ${query}`);
    assert.equal(!r.ok && r.error.code, "invalid_args", `expected invalid_args for query: ${query}`);
  }
});

test("validateToolArgs: search_issues does NOT false-reject a word that merely ENDS in repo/org/user (myrepo:, superuser:) — \\b does not match mid-word", () => {
  for (const query of ["myrepo:foo", "superuser:bar"]) {
    const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query }, CAPS);
    assert.equal(r.ok, true, `expected ${query} to pass — no word boundary precedes the repo/user substring`);
  }
});

test("validateToolArgs: search_issues still ACCEPTS a benign query using in-scope qualifiers (is:/label:/free text), including free text that legitimately says 'author:' with no boundary issue", () => {
  const r = validateToolArgs(TOOL_SEARCH_ISSUES, { query: "is:open label:bug flaky" }, CAPS);
  assert.equal(r.ok, true);
  assert.equal(r.ok && (r.value as { query: string }).query, "is:open label:bug flaky");
  assert.equal(validateToolArgs(TOOL_SEARCH_ISSUES, { query: "author:someone flaky" }, CAPS).ok, true);
});

// ── sanitizeUpstreamError: nothing token-bearing in any error surface ───────────────────────

test("sanitizeUpstreamError: scrubs GitHub PAT-shaped tokens, Bearer headers, and bare 40-hex strings", () => {
  const raw =
    "gh auth failed: token ghp_ABCDEFGHIJ0123456789abcdefghij for user; " +
    "Authorization: Bearer sk-live-abcdef1234567890; " +
    "sha da39a3ee5e6b4b0d3255bfef95601890afd80709 not found";
  const clean = sanitizeUpstreamError(raw);
  assert.doesNotMatch(clean, /ghp_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(clean, /Bearer\s+\S+/i);
  assert.doesNotMatch(clean, /\b[0-9a-f]{40}\b/i);
  assert.match(clean, /\[redacted\]/);
});

test("sanitizeUpstreamError: non-string input degrades to a placeholder, never throws", () => {
  assert.doesNotThrow(() => sanitizeUpstreamError(undefined));
  assert.doesNotThrow(() => sanitizeUpstreamError({ some: "object" }));
});

// ── canonicalization: deterministic key order regardless of input order ────────────────────

test("canonicalJson: identical logical value canonicalizes identically regardless of key order", () => {
  const a = canonicalJson({ b: 2, a: 1, nested: { z: 9, y: 8 } });
  const b = canonicalJson({ a: 1, nested: { y: 8, z: 9 }, b: 2 });
  assert.equal(a, b);
});

test("canonicalJson: arrays keep their own order (not sorted) — only OBJECT keys are sorted", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

// ── default-view completeness contract (issue #234): fail toward inclusion ─────────────────

function comment(body: string, createdAt: string): PRComment {
  return { login: "someone", createdAt, body };
}

test("capComments: total at or under the cap -> complete, nothing omitted", () => {
  const all = [comment("c1", "2026-01-01"), comment("c2", "2026-01-02")];
  const v = capComments(all, 5);
  assert.equal(v.complete, true);
  assert.equal(v.returned, 2);
  assert.equal(v.total, 2);
  assert.equal(v.omittedRange, undefined);
  assert.deepEqual(v.comments, all);
});

test("capComments: over the cap -> keeps the MOST RECENT N (not the oldest), comments_complete false, omitted range names the cut", () => {
  const all = [
    comment("oldest", "2026-01-01T00:00:00Z"),
    comment("middle", "2026-01-02T00:00:00Z"),
    comment("AMENDMENT: corrects the body above", "2026-01-03T00:00:00Z"),
  ];
  const v = capComments(all, 1);
  assert.equal(v.complete, false);
  assert.equal(v.total, 3);
  assert.equal(v.returned, 1);
  assert.deepEqual(v.comments, [all[2]]);
  assert.deepEqual(v.omittedRange, { from: 1, to: 2 });
});

test("fixture: an amendment comment NEWER than the body is identifiable from the injected default view alone (issue #234 AC)", async () => {
  const meta: IssueMeta = { number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "2026-01-01T00:00:00Z" };
  const body = "Original plan: do X.";
  const allComments = [
    comment("early discussion", "2026-01-01T01:00:00Z"),
    comment("more early discussion", "2026-01-01T02:00:00Z"),
    comment("AMENDMENT: actually do Y, not X — the body above is stale", "2026-01-05T00:00:00Z"),
  ];
  const relations: IssueRelations = { linkedPRs: [], crossReferences: [], truncated: false };
  const forge = {
    getIssueMeta: async () => meta,
    getIssueBody: async () => body,
    getIssueComments: async () => allComments,
    getIssueRelations: async () => relations,
  };
  const view = await fetchIssueDetailsView(forge, 1, { ...CAPS, defaultCommentsPerIssue: 2 });
  // The default view (cap=2, 3 total) omits the OLDEST comment, never the newest — the amendment
  // (newest) is present, identifiable, without any further tool call.
  assert.equal(view.comments.complete, false);
  assert.ok(view.comments.comments.some((c) => c.body.startsWith("AMENDMENT")));
  assert.equal(view.comments.comments[view.comments.comments.length - 1]!.body.startsWith("AMENDMENT"), true);
});

test("outgoingMentions: extracts and dedupes bare #N references, does not split a longer number's tail out of a distinct larger reference", () => {
  const text = "See #12 and also #12 again, plus #123 (its own distinct issue, not a #12 tail), plus #7.";
  assert.deepEqual(outgoingMentions(text), [7, 12, 123]);
});

test("outgoingMentions: a version-like string (v1.2.3) is never mistaken for a #N mention", () => {
  assert.deepEqual(outgoingMentions("upgraded to v1.2.3"), []);
});

test("outgoingMentions: no mentions -> empty array", () => {
  assert.deepEqual(outgoingMentions("nothing to see here"), []);
});

test("fetchIssueRelationsResponse: combines IForge relations with outgoing mentions derived from the body", async () => {
  const relations: IssueRelations = {
    linkedPRs: [{ number: 10, title: "fix", state: "MERGED", labels: [], kind: "pr" }],
    crossReferences: [],
    truncated: false,
  };
  const forge = { getIssueRelations: async () => relations, getIssueBody: async () => "duplicate of #5" };
  const r = await fetchIssueRelationsResponse(forge, 1, CAPS);
  assert.equal(r.number, 1);
  assert.deepEqual(r.linkedPRs, relations.linkedPRs);
  assert.deepEqual(r.outgoingMentions, [5]);
});

// ─────────────────────────────────────────────────────────────────────────────
// #244: PR-facing tools' arg schema/scope/cap/error matrix — mirrors the #234 issue-tool matrix
// above exactly (same strict-schema out-of-repo-scope enforcement, same over-cap contract).
// ─────────────────────────────────────────────────────────────────────────────

test("validateToolArgs: pr_details/pr_reviews/pr_checks valid shapes -> ok", () => {
  assert.equal(validateToolArgs(TOOL_PR_DETAILS, { pr: 1 }, CAPS).ok, true);
  assert.equal(validateToolArgs(TOOL_PR_REVIEWS, { pr: 1 }, CAPS).ok, true);
  assert.equal(validateToolArgs(TOOL_PR_CHECKS, { pr: 1 }, CAPS).ok, true);
});

test("validateToolArgs: pr_review_threads valid with/without lastN -> ok", () => {
  assert.equal(validateToolArgs(TOOL_PR_REVIEW_THREADS, { pr: 1 }, CAPS).ok, true);
  assert.equal(validateToolArgs(TOOL_PR_REVIEW_THREADS, { pr: 1, lastN: 2 }, CAPS).ok, true);
});

test("validateToolArgs: PR tools reject malformed args (wrong shape) -> typed invalid_args error", () => {
  for (const [tool, args] of [
    [TOOL_PR_DETAILS, { pr: "not-a-number" }],
    [TOOL_PR_REVIEWS, {}],
    [TOOL_PR_REVIEW_THREADS, { pr: 1, lastN: "nope" }],
    [TOOL_PR_CHECKS, { pr: 0 }], // positive-int required, 0 fails
  ] as const) {
    const r = validateToolArgs(tool, args, CAPS);
    assert.equal(r.ok, false, `expected invalid_args for ${tool}`);
    assert.equal(!r.ok && r.error.code, "invalid_args", `expected invalid_args for ${tool}`);
  }
});

test("validateToolArgs: PR tools reject an out-of-repo-scope attempt (a caller-supplied repo field) — strict schema rejects the unrecognized key", () => {
  const r = validateToolArgs(TOOL_PR_DETAILS, { pr: 1, repo: "someone-else/other-repo" }, CAPS);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "invalid_args");
});

test("validateToolArgs: pr_review_threads lastN over maxReviewThreadsPerCall -> REJECTED (typed over_cap error), never silently truncated", () => {
  const r = validateToolArgs(TOOL_PR_REVIEW_THREADS, { pr: 1, lastN: 3 }, CAPS); // CAPS.maxReviewThreadsPerCall = 2
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, "over_cap");
});

test("validateToolArgs: pr_review_threads lastN at exactly the cap -> ok", () => {
  assert.equal(validateToolArgs(TOOL_PR_REVIEW_THREADS, { pr: 1, lastN: 2 }, CAPS).ok, true);
});

// ── capThreads: same fail-toward-inclusion completeness contract as capComments ────────────

function thread(id: string): ReviewThreadItem {
  return { id, isResolved: false, comments: [] };
}

test("capThreads: total at or under the cap -> complete, nothing omitted", () => {
  const all = [thread("T1"), thread("T2")];
  const v = capThreads(all, 5);
  assert.equal(v.complete, true);
  assert.equal(v.returned, 2);
  assert.equal(v.total, 2);
  assert.equal(v.omittedRange, undefined);
  assert.deepEqual(v.threads, all);
});

test("capThreads: over the cap -> keeps the MOST RECENT N (not the oldest), complete false, omitted range names the cut", () => {
  const all = [thread("oldest"), thread("middle"), thread("newest")];
  const v = capThreads(all, 1);
  assert.equal(v.complete, false);
  assert.equal(v.total, 3);
  assert.equal(v.returned, 1);
  assert.deepEqual(v.threads, [all[2]]);
  assert.deepEqual(v.omittedRange, { from: 1, to: 2 });
});

// ── fetch* response shaping ─────────────────────────────────────────────────────────────────

test("fetchPRDetailsResponse: passes IForge.getPRDetails through verbatim", async () => {
  const details: PRDetails = { number: 5, headOid: "abc", state: "OPEN", draft: false, labels: [], mergeable: "MERGEABLE" };
  const forge = { getPRDetails: async () => details };
  assert.deepEqual(await fetchPRDetailsResponse(forge, 5), details);
});

test("fetchPRReviewsResponse: wraps IForge.getPRReviews with the pr number", async () => {
  const reviews: PRReviewItem[] = [{ author: "codex", commitOid: "h1", state: "APPROVED", body: "LGTM" }];
  const forge = { getPRReviews: async () => reviews };
  const r = await fetchPRReviewsResponse(forge, 5);
  assert.equal(r.pr, 5);
  assert.deepEqual(r.reviews, reviews);
});

test("fetchPRChecksResponse: wraps IForge.getPRChecks with the pr number", async () => {
  const checks: PRCheckItem[] = [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", state: null }];
  const forge = { getPRChecks: async () => checks };
  const r = await fetchPRChecksResponse(forge, 9);
  assert.equal(r.pr, 9);
  assert.deepEqual(r.checks, checks);
});

test("fetchPRReviewThreadsResponse: no lastN -> server default cap (caps.maxReviewThreadsPerCall) applies, completeness flags set", async () => {
  const all: ReviewThreadItem[] = [thread("T1"), thread("T2"), thread("T3")];
  const forge = {
    getPRReviewThreads: async (_pr: number, commentsCap: number) => {
      assert.equal(commentsCap, CAPS.maxCommentsPerThread);
      return all;
    },
  };
  const r = await fetchPRReviewThreadsResponse(forge, 5, undefined, CAPS);
  assert.equal(r.pr, 5);
  assert.equal(r.total, 3);
  assert.equal(r.returned, 2); // CAPS.maxReviewThreadsPerCall = 2
  assert.equal(r.complete, false);
  assert.deepEqual(r.threads, [all[1], all[2]]);
});

test("fetchPRReviewThreadsResponse: explicit lastN overrides the server default cap", async () => {
  const all: ReviewThreadItem[] = [thread("T1"), thread("T2"), thread("T3")];
  const forge = { getPRReviewThreads: async () => all };
  const r = await fetchPRReviewThreadsResponse(forge, 5, 1, CAPS);
  assert.equal(r.returned, 1);
  assert.deepEqual(r.threads, [all[2]]);
});
