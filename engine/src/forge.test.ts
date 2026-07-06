import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePRStatus,
  parseProject,
  selectReadyIssues,
  findOptionId,
  findItemId,
  hasVerificationPlan,
  parsePageInfo,
  projectQuery,
  parsePRReviewView,
  parsePRReactions,
  parseReviewThreadsPage,
  countUnresolvedThreads,
  assemblePRReviewData,
} from "./forge.js";

// A representative ProjectV2 query response. `data.user` or `data.organization` —
// the parser is owner-kind agnostic (reads whichever root is present).
const PROJECT_JSON = JSON.stringify({
  data: {
    user: {
      projectV2: {
        id: "PVT_proj",
        field: {
          id: "PVTF_status",
          options: [
            { id: "opt_ready", name: "Ready" },
            { id: "opt_wip", name: "In Progress" },
            { id: "opt_done", name: "Done" },
          ],
        },
        items: {
          nodes: [
            {
              id: "ITEM_10",
              content: {
                number: 10,
                title: "ready with plan",
                state: "OPEN",
                body: "Do the thing.\n## Verification\n- run npm test",
                repository: { nameWithOwner: "herehigher/sapwood" },
                labels: { nodes: [{ name: "type:feature" }, { name: "prio:1-high" }] },
              },
              fieldValues: {
                nodes: [{ name: "Ready", field: { name: "Status" } }],
              },
            },
            {
              id: "ITEM_11",
              content: {
                number: 11,
                title: "ready but NO verification plan",
                state: "OPEN",
                body: "just vibes",
                repository: { nameWithOwner: "herehigher/sapwood" },
                labels: { nodes: [{ name: "type:feature" }] },
              },
              fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
            },
            {
              id: "ITEM_12",
              content: {
                number: 12,
                title: "ready, verify:n/a (doc-gate path)",
                state: "OPEN",
                body: "no plan needed",
                repository: { nameWithOwner: "herehigher/sapwood" },
                labels: { nodes: [{ name: "type:docs" }, { name: "verify:n/a" }] },
              },
              fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
            },
            {
              id: "ITEM_13",
              content: {
                number: 13,
                title: "in progress (not Ready lane)",
                state: "OPEN",
                body: "## Verification\nx",
                repository: { nameWithOwner: "herehigher/sapwood" },
                labels: { nodes: [] },
              },
              fieldValues: { nodes: [{ name: "In Progress", field: { name: "Status" } }] },
            },
            {
              id: "ITEM_14",
              content: {
                number: 14,
                title: "ready but a different repo",
                state: "OPEN",
                body: "## Verification\nx",
                repository: { nameWithOwner: "herehigher/0day" },
                labels: { nodes: [] },
              },
              fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
            },
            {
              id: "ITEM_15",
              content: {
                number: 15,
                title: "ready but CLOSED",
                state: "CLOSED",
                body: "## Verification\nx",
                repository: { nameWithOwner: "herehigher/sapwood" },
                labels: { nodes: [{ name: "verify:n/a" }] },
              },
              fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
            },
          ],
        },
      },
    },
  },
});

const cfg = {
  board: { owner: "herehigher", repo: "sapwood", statusField: "Status", status: { ready: "Ready", inProgress: "In Progress", done: "Done" } },
  labels: { verifyNa: "verify:n/a" },
} as Parameters<typeof selectReadyIssues>[1];

test("hasVerificationPlan: verify:n/a label OR a verification/acceptance section", () => {
  assert.equal(hasVerificationPlan("## Verification\nrun tests", [], "verify:n/a"), true);
  assert.equal(hasVerificationPlan("### Acceptance criteria", [], "verify:n/a"), true);
  assert.equal(hasVerificationPlan("no plan here", ["verify:n/a"], "verify:n/a"), true); // doc-gate path
  assert.equal(hasVerificationPlan("no plan here", ["type:feature"], "verify:n/a"), false); // fail-closed
  assert.equal(hasVerificationPlan("", [], "verify:n/a"), false);
});

test("projectQuery: no line is a // comment (GraphQL uses #, not //) — Codex R5 P1 guard", () => {
  for (const root of ["user", "organization"] as const) {
    const q = projectQuery(root, "Status");
    const offending = q.split("\n").filter((l) => l.trimStart().startsWith("//"));
    assert.deepEqual(offending, [], `'//' comment lines are invalid GraphQL: ${offending.join(" | ")}`);
  }
});

test("parseProject: extracts project id, status field id, options, items (owner-kind agnostic)", () => {
  const p = parseProject(PROJECT_JSON, "Status");
  assert.equal(p.projectId, "PVT_proj");
  assert.equal(p.statusFieldId, "PVTF_status");
  assert.equal(findOptionId(p, "In Progress"), "opt_wip");
  assert.equal(findItemId(p, 12), "ITEM_12");
  assert.equal(p.items.length, 6);
});

test("selectReadyIssues: Ready lane + OPEN + this repo + has verification plan (Decision #8)", () => {
  const p = parseProject(PROJECT_JSON, "Status");
  const ready = selectReadyIssues(p, cfg);
  // #10 (has plan) and #12 (verify:n/a) pass. #11 no plan, #13 not Ready, #14 other repo, #15 closed -> all out.
  assert.deepEqual(ready.map((i) => i.number).sort((a, b) => a - b), [10, 12]);
  assert.deepEqual(ready.find((i) => i.number === 10)?.labels, ["type:feature", "prio:1-high"]);
});

test("findOptionId/findItemId: missing -> undefined (caller fails closed)", () => {
  const p = parseProject(PROJECT_JSON, "Status");
  assert.equal(findOptionId(p, "Nonexistent"), undefined);
  assert.equal(findItemId(p, 999), undefined);
});

test("findItemId: repo-scoped so a multi-repo board can't hit the wrong #N (Codex P2)", () => {
  // Two items both numbered 50, different repos.
  const p = parseProject(
    JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "P",
            field: { id: "F", options: [] },
            items: {
              nodes: [
                { id: "ITEM_A", content: { number: 50, title: "ours", state: "OPEN", body: "", repository: { nameWithOwner: "herehigher/sapwood" }, labels: { nodes: [] } }, fieldValues: { nodes: [] } },
                { id: "ITEM_B", content: { number: 50, title: "theirs", state: "OPEN", body: "", repository: { nameWithOwner: "herehigher/0day" }, labels: { nodes: [] } }, fieldValues: { nodes: [] } },
              ],
            },
          },
        },
      },
    }),
    "Status",
  );
  assert.equal(findItemId(p, 50, "herehigher/sapwood"), "ITEM_A"); // full owner/repo picks ours
  assert.equal(findItemId(p, 50, "herehigher/0day"), "ITEM_B");
  assert.equal(findItemId(p, 50), "ITEM_A"); // no scope -> first match (back-compat)
});

test("findItemId/selectReadyIssues: full owner/repo, not a /repo suffix (Codex R2 P1)", () => {
  // A foreign `other/sapwood` item must NOT match a board configured for herehigher/sapwood.
  const p = parseProject(
    JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "P",
            field: { id: "F", options: [{ id: "opt_ready", name: "Ready" }] },
            items: {
              nodes: [
                { id: "FOREIGN", content: { number: 60, title: "foreign", state: "OPEN", body: "## Verification", repository: { nameWithOwner: "other/sapwood" }, labels: { nodes: [] } }, fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] } },
              ],
            },
          },
        },
      },
    }),
    "Status",
  );
  assert.equal(findItemId(p, 60, "herehigher/sapwood"), undefined); // suffix `other/sapwood` rejected
  assert.deepEqual(selectReadyIssues(p, cfg), []); // foreign item never enters the queue
});

test("parsePageInfo: reads the items connection cursor (pagination)", () => {
  const withMore = JSON.stringify({
    data: { user: { projectV2: { items: { pageInfo: { hasNextPage: true, endCursor: "CUR2" } } } } },
  });
  assert.deepEqual(parsePageInfo(withMore), { hasNextPage: true, endCursor: "CUR2" });
  // Missing pageInfo (or org root) -> terminal, no cursor.
  assert.deepEqual(parsePageInfo(PROJECT_JSON), { hasNextPage: false, endCursor: null });
});

test("parsePRStatus: clean mergeable PR with passing checks", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.deepEqual(s, { number: 21, headOid: "d0ce0a5", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true });
});

test("parsePRStatus: an empty rollup fails closed (checks may not be created yet)", () => {
  const s = parsePRStatus(
    JSON.stringify({ number: 1, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }),
  );
  assert.equal(s.ciGreen, false); // genuinely CI-less repos opt in via ci.requireChecks (M3)
});

test("parsePRStatus: a queued/in-progress check (null conclusion) is not green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 3,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: null }],
    }),
  );
  assert.equal(s.ciGreen, false);
});

test("parsePRStatus: SKIPPED/NEUTRAL count as passing", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 4,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }, { conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(s.ciGreen, true);
});

test("parsePRStatus: legacy StatusContext with passing state is green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 5,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ state: "SUCCESS" }, { conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(s.ciGreen, true);
});

test("parsePRStatus: legacy StatusContext with pending/failing state is not green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 6,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ state: "PENDING" }],
    }),
  );
  assert.equal(s.ciGreen, false);
});

test("parsePRStatus: a failing check is not green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 2,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "CONFLICTING",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
    }),
  );
  assert.equal(s.ciGreen, false);
  assert.equal(s.mergeable, "CONFLICTING");
});

test("parsePRStatus: unrecognized mergeable value normalizes to UNKNOWN (queue, not escalate)", () => {
  const s = parsePRStatus(
    JSON.stringify({ number: 3, headRefOid: "abc", state: "OPEN", mergeable: "UNKNOWN", statusCheckRollup: [] }),
  );
  assert.equal(s.mergeable, "UNKNOWN");
});

// ── #13 review-gate data: parsePRReviewView / parsePRReactions / parseUnresolvedThreads ──

test("parsePRReviewView: parses headRefOid/author/updatedAt/isDraft/labels/state/reviews", () => {
  const v = parsePRReviewView(
    JSON.stringify({
      headRefOid: "HEAD123",
      author: { login: "producer" },
      updatedAt: "2026-06-17T12:00:00Z",
      isDraft: false,
      labels: [{ name: "type:feature" }, { name: "needs-human" }],
      state: "OPEN",
      reviews: [
        { author: { login: "codex" }, commit: { oid: "HEAD123" }, state: "COMMENTED" },
        { author: {}, commit: {}, state: "PENDING" }, // missing login/oid -> "" not a crash
      ],
    }),
  );
  assert.equal(v.headOid, "HEAD123");
  assert.equal(v.author, "producer");
  assert.deepEqual(v.labels, ["type:feature", "needs-human"]);
  assert.deepEqual(v.reviews, [
    { author: "codex", commitOid: "HEAD123", state: "COMMENTED" },
    { author: "", commitOid: "", state: "PENDING" },
  ]);
});

test("parsePRReviewView: absent labels/reviews arrays default to empty (no crash)", () => {
  const v = parsePRReviewView(
    JSON.stringify({ headRefOid: "H", updatedAt: "t", isDraft: true, state: "OPEN" }),
  );
  assert.deepEqual(v.labels, []);
  assert.deepEqual(v.reviews, []);
  assert.equal(v.author, "");
});

test("parsePRReactions: maps GitHub reaction rows to {content, createdAt, login}", () => {
  const r = parsePRReactions(
    JSON.stringify([
      { content: "+1", created_at: "2026-06-17T13:00:00Z", user: { login: "alice" } },
      { content: "eyes", created_at: "2026-06-17T13:30:00Z", user: null },
    ]),
  );
  assert.deepEqual(r, [
    { content: "+1", createdAt: "2026-06-17T13:00:00Z", login: "alice" },
    { content: "eyes", createdAt: "2026-06-17T13:30:00Z", login: "" },
  ]);
});

test("parsePRReactions: --slurp multi-page output (array of page arrays) flattens in order (Codex PR #42 P2)", () => {
  // gh api --paginate --slurp wraps each page's array in one outer array; a reaction list
  // spanning pages previously threw on JSON.parse and wedged the merge gate at "queued".
  const r = parsePRReactions(
    JSON.stringify([
      [{ content: "+1", created_at: "t1", user: { login: "a" } }],
      [{ content: "eyes", created_at: "t2", user: { login: "b" } }, { content: "+1", created_at: "t3", user: {} }],
    ]),
  );
  assert.deepEqual(r.map((x) => [x.content, x.login]), [["+1", "a"], ["eyes", "b"], ["+1", ""]]);
});

test("parsePRReactions: empty slurp output parses to []", () => {
  assert.deepEqual(parsePRReactions("[]"), []);
  assert.deepEqual(parsePRReactions("[[]]"), []);
});

const threadsPage = (
  resolved: boolean[],
  pageInfo?: { hasNextPage: boolean; endCursor: string | null },
): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            ...(pageInfo ? { pageInfo } : {}),
            nodes: resolved.map((r) => ({ isResolved: r })),
          },
        },
      },
    },
  });

test("parseReviewThreadsPage: counts only isResolved=false nodes + surfaces the page cursor", () => {
  const p = parseReviewThreadsPage(threadsPage([false, true, false], { hasNextPage: true, endCursor: "CUR" }));
  assert.deepEqual(p, { unresolved: 2, hasNextPage: true, endCursor: "CUR" });
});

test("parseReviewThreadsPage: absent/malformed shape -> 0 + terminal, never throws or loops", () => {
  assert.deepEqual(parseReviewThreadsPage(JSON.stringify({})), { unresolved: 0, hasNextPage: false, endCursor: null });
});

test("countUnresolvedThreads: pages to exhaustion — an unresolved thread PAST page 1 is still counted (Codex PR #42 P2)", async () => {
  // Page 1: all resolved, more pages remain. Page 2: one unresolved. A first-100-only fetch
  // would have declared zero findings here — the exact fail-open the pagination closes.
  const pages: Record<string, string> = {
    "": threadsPage(Array(100).fill(true) as boolean[], { hasNextPage: true, endCursor: "P2" }),
    P2: threadsPage([true, false], { hasNextPage: false, endCursor: null }),
  };
  const fetched: (string | null)[] = [];
  const n = await countUnresolvedThreads(async (after) => {
    fetched.push(after);
    return pages[after ?? ""]!;
  });
  assert.equal(n, 1);
  assert.deepEqual(fetched, [null, "P2"]); // followed the cursor exactly once
});

test("countUnresolvedThreads: single page (no pageInfo) -> one fetch, its count", async () => {
  const n = await countUnresolvedThreads(async () => threadsPage([false, false, true]));
  assert.equal(n, 2);
});

test("assemblePRReviewData: combines the raw gh responses + the paged thread total", () => {
  const view = JSON.stringify({
    headRefOid: "H", author: { login: "producer" }, updatedAt: "t", isDraft: false,
    labels: [], state: "OPEN", reviews: [],
  });
  const reactions = JSON.stringify([{ content: "eyes", created_at: "t", user: { login: "codex" } }]);
  const data = assemblePRReviewData(view, reactions, 1);
  assert.equal(data.headOid, "H");
  assert.equal(data.reactions.length, 1);
  assert.equal(data.unresolvedThreads, 1);
});
