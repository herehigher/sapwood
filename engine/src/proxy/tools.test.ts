// tools.test.ts (#234): the fixed tool algebra's pure parts — arg schema/scope/cap validation,
// the default-view completeness contract (capComments), outgoing-mention extraction, error
// sanitization, and canonicalization. No HTTP/state involved (see mcp-server.test.ts/
// journal.test.ts for those).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueMeta, IssueRelations, PRComment } from "../forge/forge.js";
import {
  canonicalJson,
  capComments,
  fetchIssueDetailsView,
  fetchIssueRelationsResponse,
  mcpToolFullName,
  outgoingMentions,
  type ProxyCaps,
  sanitizeUpstreamError,
  TOOL_DEFINITIONS,
  TOOL_ISSUE_COMMENTS,
  TOOL_ISSUE_DETAILS,
  TOOL_ISSUE_RELATIONS,
  TOOL_NAMES,
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
  for (const def of TOOL_DEFINITIONS) {
    assert.equal(def.inputSchema.type, "object");
    assert.equal(def.inputSchema.additionalProperties, false);
  }
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
