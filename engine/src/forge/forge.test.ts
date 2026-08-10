import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import { defaultIssueTemplatePath } from "../loop/init.js";
import {
  ADD_SUB_ISSUE_MUTATION,
  assemblePRReviewData,
  associateLanePr,
  collectReviewThreads,
  countUnresolvedThreads,
  ENGINE_COMMENT_MARKER,
  extractAcceptanceCriteria,
  extractOrigin,
  extractVerificationPlan,
  extractVerificationSection,
  fetchAllReviewThreads,
  findItemId,
  findingDigest,
  findLaneOwnedPr,
  findOptionId,
  GithubForge,
  hasPrOwnerMarker,
  hasVerificationPlan,
  OPEN_ISSUES_LIMIT,
  parseCompareChangedFiles,
  parseDefaultBranchChecksPage,
  parseIssueLabels,
  parseIssueMeta,
  parseIssueRelations,
  parsePageInfo,
  parsePRChangedFiles,
  parsePRChecksPage,
  parsePRComments,
  parsePRCommentsPage,
  parsePRDetails,
  parsePRReactions,
  parsePRReviewsPage,
  parsePRReviewThreadsPage,
  parsePRReviewView,
  parsePRStatus,
  parseProject,
  parseReviewThreadCommentsTail,
  parseReviewThreadsPage,
  parseSearchIssues,
  parseSubIssues,
  prOwnerMarker,
  projectQuery,
  RECENTLY_CLOSED_ISSUES_LIMIT,
  readPrOwner,
  SUB_ISSUE_IDS_QUERY,
  SUB_ISSUES_QUERY,
  selectIssuesAbsentFromBoard,
  selectPlanReviewCandidates,
  selectPlanTriageCandidates,
  selectPoolEligibleIssues,
  selectReadyIssues,
  selectUnplacedIssues,
  stampPrOwner,
} from "./forge.js";

const SUB_ISSUE_IDS_JSON = JSON.stringify({
  data: { repository: { parent: { id: "I_parent" }, child: { id: "I_child" } } },
});
const SUB_ISSUES_PAGE_1_JSON = JSON.stringify({
  data: {
    repository: {
      issue: {
        subIssues: {
          pageInfo: { hasNextPage: true, endCursor: "opaque-cursor" },
          nodes: [{ number: 12, title: "Child", state: "OPEN" }],
        },
      },
    },
  },
});
const SUB_ISSUES_PAGE_2_JSON = JSON.stringify({
  data: {
    repository: {
      issue: {
        subIssues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 13, title: "Second child", state: "CLOSED" }],
        },
      },
    },
  },
});
const SINGLE_SUB_ISSUE_JSON = JSON.stringify({
  data: {
    repository: {
      issue: {
        subIssues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 12, title: "Child", state: "OPEN" }],
        },
      },
    },
  },
});
const DUPLICATE_SUB_ISSUE_ERROR =
  "GraphQL: Failed to add sub-issue #12 to parent #11. Issue may not contain duplicate sub-issues and Sub issue may only have one parent";

const EXPECTED_SUB_ISSUE_IDS_QUERY = `
query($owner: String!, $repo: String!, $parent: Int!, $child: Int!) {
  repository(owner: $owner, name: $repo) {
    parent: issue(number: $parent) { id }
    child: issue(number: $child) { id }
  }
}`;
const EXPECTED_ADD_SUB_ISSUE_MUTATION = `
mutation($parentId: ID!, $childId: ID!) {
  addSubIssue(input: {issueId: $parentId, subIssueId: $childId}) {
    issue { id }
    subIssue { id }
  }
}`;
const EXPECTED_SUB_ISSUES_QUERY = `
query($owner: String!, $repo: String!, $parent: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $parent) {
      subIssues(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number title state }
      }
    }
  }
}`;

test("#311 sub-issue GraphQL documents are pinned independently and completely", () => {
  assert.equal(SUB_ISSUE_IDS_QUERY, EXPECTED_SUB_ISSUE_IDS_QUERY);
  assert.equal(ADD_SUB_ISSUE_MUTATION, EXPECTED_ADD_SUB_ISSUE_MUTATION);
  assert.equal(SUB_ISSUES_QUERY, EXPECTED_SUB_ISSUES_QUERY);
});

test("#311 GithubForge.addSubIssue resolves same-repo node ids then emits the exact node-id mutation argv", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return seen.length === 1
      ? SUB_ISSUE_IDS_JSON
      : JSON.stringify({ data: { addSubIssue: { issue: { id: "I_parent" }, subIssue: { id: "I_child" } } } });
  };

  await forge.addSubIssue(11, 12);

  assert.deepEqual(seen, [
    ["api", "graphql", "-f", `query=${EXPECTED_SUB_ISSUE_IDS_QUERY}`, "-f", "owner=o", "-f", "repo=r", "-F", "parent=11", "-F", "child=12"],
    ["api", "graphql", "-f", `query=${EXPECTED_ADD_SUB_ISSUE_MUTATION}`, "-f", "parentId=I_parent", "-f", "childId=I_child"],
  ]);
});

test("#311 GithubForge.addSubIssue fails closed when a zero-exit mutation response does not confirm the relation", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  let call = 0;
  (forge as unknown as { gh: () => Promise<string> }).gh = async () => {
    call++;
    return call === 1 ? SUB_ISSUE_IDS_JSON : JSON.stringify({ data: { addSubIssue: {} } });
  };

  await assert.rejects(forge.addSubIssue(11, 12), /mutation response did not confirm the requested relation/);
  assert.equal(call, 2);
});

test("#311 GithubForge.getSubIssues exhausts pagination with a raw opaque cursor and returns every child", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return seen.length === 1 ? SUB_ISSUES_PAGE_1_JSON : SUB_ISSUES_PAGE_2_JSON;
  };

  assert.deepEqual(await forge.getSubIssues(11), [
    { number: 12, title: "Child", state: "OPEN" },
    { number: 13, title: "Second child", state: "CLOSED" },
  ]);
  const baseArgs = ["api", "graphql", "-f", `query=${EXPECTED_SUB_ISSUES_QUERY}`, "-f", "owner=o", "-f", "repo=r", "-F", "parent=11"];
  assert.deepEqual(seen, [
    [...baseArgs, "-F", "after=null"],
    [...baseArgs, "-f", "after=opaque-cursor"],
  ]);
});

test("#311 GithubForge.addSubIssue reconciles GitHub's duplicate VALIDATION error when the intended child is attached", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  let call = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    call++;
    if (call === 1) return SUB_ISSUE_IDS_JSON;
    if (call === 2) throw new Error(DUPLICATE_SUB_ISSUE_ERROR);
    return SINGLE_SUB_ISSUE_JSON;
  };

  await assert.doesNotReject(forge.addSubIssue(11, 12));
  assert.equal(call, 3);
});

test("#311 GithubForge.addSubIssue preserves the duplicate VALIDATION error when the child is attached elsewhere", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  let call = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    call++;
    if (call === 1) return SUB_ISSUE_IDS_JSON;
    if (call === 2) throw new Error(DUPLICATE_SUB_ISSUE_ERROR);
    return JSON.stringify({
      data: {
        repository: { issue: { subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      },
    });
  };

  await assert.rejects(forge.addSubIssue(11, 12), new RegExp(DUPLICATE_SUB_ISSUE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(call, 3);
});

test("#311 parseSubIssues fails closed on a malformed child", () => {
  assert.throws(
    () => parseSubIssues(JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: [{ number: 12 }] } } } } }), 11),
    /malformed child/,
  );
});

test("#292 parsePRChangedFiles: flattens paginated results and preserves rename old/new paths", () => {
  assert.deepEqual(
    parsePRChangedFiles(
      JSON.stringify([[{ filename: "docs/CLAUDE.md", previous_filename: "CLAUDE.md" }], [{ filename: ".claude/rules/a.md" }]]),
    ),
    [{ filename: "docs/CLAUDE.md", previousFilename: "CLAUDE.md" }, { filename: ".claude/rules/a.md" }],
  );
  assert.throws(() => parsePRChangedFiles(JSON.stringify([[{ previous_filename: "CLAUDE.md" }]])), /no filename/);
});

test("#292 GithubForge.getPRChangedFiles: uses the rename-aware paginated REST files endpoint", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([[{ filename: "AGENTS.md" }]]);
  };
  assert.deepEqual(await forge.getPRChangedFiles(29), { files: [{ filename: "AGENTS.md" }], complete: true });
  assert.deepEqual(seen[0], ["api", "repos/o/r/pulls/29/files?per_page=100", "--paginate", "--slurp"]);
});

test("#292 GithubForge.getPRChangedFiles: marks the 3,000-file API ceiling incomplete", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () =>
    JSON.stringify([Array.from({ length: 3000 }, (_, index) => ({ filename: `generated/${index}.txt` }))]);
  const result = await forge.getPRChangedFiles(29);
  assert.equal(result.files.length, 3000);
  assert.equal(result.complete, false);
});

// #449 gate② P1 fix: `compareChangedFiles` / `parseCompareChangedFiles` — the range-diff
// primitive `loop/conductor.ts`'s `gatherFixDiffPaths` uses to compute the PRECEDING fix leg's
// own changed-path set, replacing the rejected `getPRChangedFiles`-as-a-stand-in first cut.

test("#449 parseCompareChangedFiles: reads the compare endpoint's `.files` array, preserving rename provenance", () => {
  assert.deepEqual(
    parseCompareChangedFiles(
      JSON.stringify({
        status: "ahead",
        files: [{ filename: "docs/CLAUDE.md", previous_filename: "CLAUDE.md" }, { filename: "src/x.ts" }],
      }),
    ),
    [{ filename: "docs/CLAUDE.md", previousFilename: "CLAUDE.md" }, { filename: "src/x.ts" }],
  );
});

test("#449 parseCompareChangedFiles: an absent `files` field is a legitimate zero-changes answer, not a parse error", () => {
  assert.deepEqual(parseCompareChangedFiles(JSON.stringify({ status: "identical" })), []);
});

test("#449 parseCompareChangedFiles: malformed entries reject fail-closed, same shape as parsePRChangedFiles", () => {
  assert.throws(() => parseCompareChangedFiles(JSON.stringify({ files: [{ previous_filename: "CLAUDE.md" }] })), /no filename/);
  assert.throws(() => parseCompareChangedFiles(JSON.stringify([])), /expected an object/);
  assert.throws(() => parseCompareChangedFiles(JSON.stringify({ files: "not-an-array" })), /files is not an array/);
});

test("#449 GithubForge.compareChangedFiles: hits the three-dot compare endpoint with NO --paginate (single-object response, not a page array)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ status: "ahead", files: [{ filename: "AGENTS.md" }] });
  };
  assert.deepEqual(await forge.compareChangedFiles("H1", "H2"), { files: [{ filename: "AGENTS.md" }], complete: true });
  assert.deepEqual(seen[0], ["api", "repos/o/r/compare/H1...H2"]);
});

test("#449 GithubForge.compareChangedFiles: marks the 300-file compare ceiling incomplete (no Link-header pagination on this endpoint)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () =>
    JSON.stringify({ status: "ahead", files: Array.from({ length: 300 }, (_, index) => ({ filename: `generated/${index}.txt` })) });
  const result = await forge.compareChangedFiles("H1", "H2");
  assert.equal(result.files.length, 300);
  assert.equal(result.complete, false);
});

// #449 gate② delta review (force-push/rebase P2): a force-pushed/rebased `head` does NOT 404 on
// three-dot compare — it returns 200 with `status: "diverged"` and `files` computed from the
// MERGE-BASE, a possible SUPERSET of the true base..head range. Silently trusting that response
// would re-open the P1 this primitive exists to fix, for exactly the rounds where a producer
// rewrote its branch's history.
test("#449 GithubForge.compareChangedFiles (gate② delta P2): status 'diverged' -> complete: false, NEVER the merge-base superset trusted as exact", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () =>
    // Well under COMPARE_FILES_CAP — proves this is the `status` check firing, not the file-count
    // ceiling; a diverged response can be arbitrarily small and still be a superset.
    JSON.stringify({ status: "diverged", files: [{ filename: "src/x.ts" }, { filename: "src/y.ts" }] });
  const result = await forge.compareChangedFiles("H1", "H2");
  assert.equal(result.files.length, 2, "the raw file list is still parsed — the caller decides what to do with an incomplete answer");
  assert.equal(result.complete, false);
});

test("#449 GithubForge.compareChangedFiles (gate② delta P2): status 'behind' or absent also fails narrow — only 'ahead'/'identical' are trusted", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () => JSON.stringify({ status: "behind", files: [] });
  assert.equal((await forge.compareChangedFiles("H1", "H2")).complete, false);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () => JSON.stringify({ files: [] }); // no status field at all
  assert.equal((await forge.compareChangedFiles("H1", "H2")).complete, false);
});

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
                milestone: { title: "M4" }, // #86: round.milestone dispatch-candidate filter
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
  board: {
    owner: "herehigher",
    repo: "sapwood",
    statusField: "Status",
    status: { ready: "Ready", inProgress: "In Progress", done: "Done" },
  },
  // #88 gate⓪: selectReadyIssues now also reads planApproved/needsHuman/blocked.
  labels: { verifyNa: "verify:n/a", planApproved: "plan:approved", needsHuman: "needs-human", blocked: "blocked" },
} as Parameters<typeof selectReadyIssues>[1];

test("hasVerificationPlan: verify:n/a label OR a verification/acceptance section", () => {
  assert.equal(hasVerificationPlan("## Verification\nrun tests", [], "verify:n/a"), true);
  assert.equal(hasVerificationPlan("### Acceptance criteria", [], "verify:n/a"), true);
  assert.equal(hasVerificationPlan("no plan here", ["verify:n/a"], "verify:n/a"), true); // doc-gate path
  assert.equal(hasVerificationPlan("no plan here", ["Verify:N/A"], "verify:n/a"), true); // GitHub case variant
  assert.equal(hasVerificationPlan("no plan here", ["type:feature"], "verify:n/a"), false); // fail-closed
  assert.equal(hasVerificationPlan("", [], "verify:n/a"), false);
});

// ── extractOrigin (#442: the agent-filed evidence line — PRESENCE only, never a machine anchor) ──

test("extractOrigin (#442): the shipped emphasis-wrapped trailer form, the bare form, and mid-body placement all read back", () => {
  assert.equal(extractOrigin("## Why\n\nstuff\n\n_Origin: run evidence — lane-442, event #91._"), "run evidence — lane-442, event #91.");
  assert.equal(extractOrigin("Origin: static scan"), "static scan");
  assert.equal(extractOrigin("**Origin:** parent issue #435"), "parent issue #435");
  assert.equal(extractOrigin("## Why\n\nOrigin: static scan\n\n## What\n\nmore"), "static scan");
});

test("extractOrigin (#442): absent, empty, or label-only -> null (fail-closed, so the align validator rejects rather than inventing provenance)", () => {
  assert.equal(extractOrigin("## Why\n\nno provenance at all"), null);
  assert.equal(extractOrigin(""), null);
  assert.equal(extractOrigin("Origin:"), null);
  assert.equal(extractOrigin("Origin:    "), null);
  assert.equal(extractOrigin("_Origin: __"), null);
  // Not the line form: a heading is a section, not the one-line evidence statement.
  assert.equal(extractOrigin("## Origin\n\nstatic scan"), null);
  // A word ENDING in "origin" must not satisfy the requirement.
  assert.equal(extractOrigin("CrossOrigin: allowed"), null);
});

// ── extractVerificationPlan (#194: every matching section, without overlap duplication) ──

test("extractVerificationPlan: sibling Acceptance criteria and Verification plan sections are concatenated", () => {
  const body = `## Acceptance criteria

- [ ] the command succeeds

## Verification plan

Run \`npm test\` and inspect the output.

## Notes

Not part of the plan.`;
  assert.equal(
    extractVerificationPlan(body),
    `## Acceptance criteria

- [ ] the command succeeds

## Verification plan

Run \`npm test\` and inspect the output.`,
  );
});

test("#310 extractVerificationSection: an Acceptance-criteria section alone is not concrete verification", () => {
  assert.equal(extractVerificationSection("## Acceptance criteria\n\n- [ ] works"), null);
  assert.equal(extractVerificationSection("## Verification plan\n\n- Run npm test"), "## Verification plan\n\n- Run npm test");
});

test("extractVerificationPlan: nested ### Verification is included fully and overlap is not duplicated", () => {
  const body = `## Acceptance criteria

- [ ] it works

### Verification

Run the focused test.

#### Expected result

The test passes.

## Notes

Unrelated.`;
  const plan = extractVerificationPlan(body)!;
  assert.match(plan, /^## Acceptance criteria/);
  assert.match(plan, /#### Expected result\n\nThe test passes\./);
  assert.equal(plan.match(/### Verification/g)?.length, 1, "nested matching text is emitted once");
  assert.ok(!plan.includes("Unrelated"));
});

test("extractVerificationPlan: Acceptance-only and Verification-only bodies both match", () => {
  assert.equal(extractVerificationPlan("### Acceptance criteria\n- it works"), "### Acceptance criteria\n- it works");
  assert.equal(extractVerificationPlan("## Verification\nrun tests"), "## Verification\nrun tests");
});

test("extractVerificationPlan: neither heading -> null (fail-closed, matches hasVerificationPlan)", () => {
  assert.equal(extractVerificationPlan("no plan here"), null);
  assert.equal(extractVerificationPlan(""), null);
});

test("extractVerificationPlan: multiple non-overlapping matches retain body order", () => {
  const body = `## Verification first
step one
## Notes
middle
## Acceptance second
criterion two
## Appendix
ignored
### Verification third
step three`;
  const plan = extractVerificationPlan(body)!;
  assert.ok(plan.indexOf("Verification first") < plan.indexOf("Acceptance second"));
  assert.ok(plan.indexOf("Acceptance second") < plan.indexOf("Verification third"));
  assert.ok(!plan.includes("middle"));
  assert.ok(!plan.includes("ignored"));
});

test("extractVerificationPlan: #182-shaped issue body carries sibling verification steps verbatim", () => {
  const issue182ShapedBody = `## Why

The current behavior silently drops required review context.

## What

Generalize the extractor without changing its callers.

Out of scope: reviewer trigger-comment changes.

## Acceptance criteria

- [ ] Every matching section is extracted in body order.
- [ ] Missing sections still fail closed.

## Verification plan

- Add node:test coverage for sibling headings.
- Run \`npm run typecheck && npm run lint && npm test\` from the repo root.`;
  const plan = extractVerificationPlan(issue182ShapedBody)!;
  assert.match(plan, /^## Acceptance criteria/);
  assert.match(plan, /Every matching section is extracted/);
  assert.match(plan, /^## Verification plan/m);
  assert.match(plan, /Add node:test coverage for sibling headings/);
  assert.match(plan, /npm run typecheck && npm run lint && npm test/);
});

test("extractVerificationPlan: a fenced pseudo-heading alone is not a verification plan", () => {
  assert.equal(extractVerificationPlan("```markdown\n## Verification\nrun nothing\n```"), null);
});

test("extractVerificationPlan: fenced pseudo-headings neither terminate a real section nor create phantom sections", () => {
  const body = `## Acceptance criteria
- [ ] real criterion

\`\`\`markdown
## Notes
fenced text stays in the plan
## Verification
fenced pseudo-plan
\`\`\`

## Real notes
outside the plan`;
  const plan = extractVerificationPlan(body)!;
  assert.match(plan, /fenced text stays in the plan/);
  assert.match(plan, /fenced pseudo-plan/);
  assert.equal(plan.match(/## Verification/g)?.length, 1, "fenced pseudo-heading is not emitted as a second section");
  assert.ok(!plan.includes("outside the plan"));
});

test("extractVerificationPlan: an unclosed fence at EOF keeps its pseudo-headings inside the open real section", () => {
  const body = "## Verification plan\nrun the real test\n~~~text\n## Acceptance pseudo-heading\nfenced through EOF";
  const plan = extractVerificationPlan(body)!;
  assert.equal(plan, body);
  assert.equal(plan.match(/## Acceptance/g)?.length, 1, "unclosed fence does not create a phantom section");
});

test("extractVerificationPlan: a shorter backtick run does not close a longer backtick fence", () => {
  const body = "````md\n```\n## Verification\npseudo-plan\n````";
  assert.equal(extractVerificationPlan(body), null);
});

test("extractVerificationPlan: a tilde fence is closed only by a sufficient tilde run", () => {
  const body = "~~~md\n```\n## Verification\npseudo-plan\n~~~\n## Verification plan\nreal-plan";
  assert.equal(extractVerificationPlan(body), "## Verification plan\nreal-plan");
});

test("extractVerificationPlan: fence openers and closers may be indented by up to three spaces", () => {
  const body = "   ```md\n## Verification\npseudo-plan\n   ```\n## Verification plan\nreal-plan";
  assert.equal(extractVerificationPlan(body), "## Verification plan\nreal-plan");
});

test("extractVerificationPlan: a three-space-indented pseudo-heading inside a fence is ignored", () => {
  assert.equal(extractVerificationPlan("```md\n   ## Verification\npseudo-plan\n```"), null);
});

test("hasVerificationPlan and extractVerificationPlan agree on every case (shared parser, not duplicated)", () => {
  const cases = ["## Verification\nrun tests", "### Acceptance criteria", "no plan here", ""];
  for (const body of cases) {
    assert.equal(hasVerificationPlan(body, [], "verify:n/a"), extractVerificationPlan(body) != null);
  }
});

// ── extractAcceptanceCriteria (#283, design #279 §5, D4): checkbox AC lines -> (id, text) ────

test("extractAcceptanceCriteria: parses `- [ ]` lines under Acceptance criteria into ordered (id, text) pairs", () => {
  const body = "## Acceptance criteria\n\n- [ ] first thing\n- [ ] second thing\n\n## Verification plan\nrun tests";
  const items = extractAcceptanceCriteria(body)!;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.text, "first thing");
  assert.equal(items[1]!.text, "second thing");
  assert.match(items[0]!.id, /^1-[0-9a-f]{8}$/);
  assert.match(items[1]!.id, /^2-[0-9a-f]{8}$/);
});

test("extractAcceptanceCriteria: both `- [ ]` and `- [x]`/`- [X]` are counted", () => {
  const body = "## Acceptance criteria\n\n- [x] done already\n- [X] also done\n- [ ] still open";
  const items = extractAcceptanceCriteria(body)!;
  assert.deepEqual(
    items.map((i) => i.text),
    ["done already", "also done", "still open"],
  );
});

test("extractAcceptanceCriteria: no Acceptance-criteria heading at all -> null (never [])", () => {
  assert.equal(extractAcceptanceCriteria("## Verification plan\nrun tests"), null);
  assert.equal(extractAcceptanceCriteria(""), null);
});

test("extractAcceptanceCriteria: heading present but zero checkbox lines under it (prose only) -> null, malformed/empty", () => {
  assert.equal(extractAcceptanceCriteria("## Acceptance criteria\n\nJust some prose, no checkboxes.\n\n## Verification\nrun tests"), null);
  assert.equal(extractAcceptanceCriteria("## Acceptance criteria\n\n- a plain bullet, no checkbox"), null);
});

test("extractAcceptanceCriteria: only counts lines under Acceptance criteria, never Verification-plan-only lines (distinct from extractVerificationPlan's combined heading match)", () => {
  const body = "## Acceptance criteria\n\n- [ ] real AC\n\n## Verification plan\n\n- [ ] not an AC line, just a checklist step here";
  const items = extractAcceptanceCriteria(body)!;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.text, "real AC");
});

test("extractAcceptanceCriteria: fence-safety is inherited from extractMarkdownSections — a fenced pseudo-heading's checkboxes are never counted as a phantom section", () => {
  const body = "```markdown\n## Acceptance criteria\n- [ ] fenced, not real\n```\n\nno real AC section here";
  assert.equal(extractAcceptanceCriteria(body), null);
});

// ── #301 review (P2 F5): wrapped continuation lines are folded, never silently dropped ───────

test("extractAcceptanceCriteria: a criterion wrapping onto a second, indented line is folded into ONE criterion's text, not dropped", () => {
  const body =
    '## Acceptance criteria\n\n- [ ] Concrete, checkable statement of what "done" looks like (e.g. which section of\n      which doc is added/updated, and what it says).\n\n## Verification plan\nlink resolves';
  const items = extractAcceptanceCriteria(body)!;
  assert.equal(items.length, 1);
  assert.equal(
    items[0]!.text,
    'Concrete, checkable statement of what "done" looks like (e.g. which section of which doc is added/updated, and what it says).',
  );
});

test("extractAcceptanceCriteria: #301 review regression pin — the SHIPPED docs.md template's own wrapped example round-trips to exactly one, complete criterion", () => {
  const docsTemplate = readFileSync(defaultIssueTemplatePath("docs.md"), "utf8");
  const items = extractAcceptanceCriteria(docsTemplate)!;
  assert.equal(items.length, 1);
  assert.match(items[0]!.text, /^Concrete, checkable statement of what "done" looks like/);
  assert.match(items[0]!.text, /which doc is added\/updated, and what it says\)\.$/, "the wrapped second line is folded in, not dropped");
});

test("extractAcceptanceCriteria: multiple wrapped criteria each fold independently, and a blank line ends a continuation run", () => {
  const body =
    "## Acceptance criteria\n\n- [ ] first criterion\n  wraps here\n\n- [ ] second criterion\n  also wraps\n\nunrelated trailing prose after a blank line";
  const items = extractAcceptanceCriteria(body)!;
  assert.deepEqual(
    items.map((i) => i.text),
    ["first criterion wraps here", "second criterion also wraps"],
  );
});

test("extractAcceptanceCriteria: a NEW list item or heading immediately after a checkbox line is never folded into the PRECEDING criterion", () => {
  const body = "## Acceptance criteria\n\n- [ ] one\n- [ ] two\n\n### Notes\nsome nested notes";
  const items = extractAcceptanceCriteria(body)!;
  assert.deepEqual(
    items.map((i) => i.text),
    ["one", "two"],
  );
});

test("extractAcceptanceCriteria: id hashing is computed over the FINAL folded text (a wrapped criterion's id reflects its whole text, not just the first line)", () => {
  const wrapped = "## Acceptance criteria\n\n- [ ] first line\n  second line";
  const oneLine = "## Acceptance criteria\n\n- [ ] first line second line";
  assert.deepEqual(extractAcceptanceCriteria(wrapped), extractAcceptanceCriteria(oneLine));
});

// ── #301 review (P2 F5): heading matching tightened to "Acceptance criteria", not a bare
//    "acceptance" substring — an unrelated heading merely starting with that word no longer
//    false-matches. ──

test("extractAcceptanceCriteria: an unrelated heading merely starting with 'Acceptance' (no 'criteria') is NOT treated as the AC section", () => {
  const body = "## Acceptance of risk\n\n- [ ] this is not really an AC line\n\n## Verification plan\nrun tests";
  assert.equal(extractAcceptanceCriteria(body), null);
});

test("extractAcceptanceCriteria: 'Acceptance Criteria' heading variants (case, trailing words) still match", () => {
  assert.equal(extractAcceptanceCriteria("## ACCEPTANCE CRITERIA\n\n- [ ] shout-cased heading")!.length, 1);
  assert.equal(extractAcceptanceCriteria("## Acceptance criteria (AC)\n\n- [ ] trailing parenthetical")!.length, 1);
});

// ── #283 corpus test: id stability under reorder/edit WITHIN a snapshot ──────────────────────
//
// "Stable WITHIN a snapshot" means: extracting the SAME body twice always yields the SAME ids
// (pure, deterministic — no external counter), and the id scheme's two components behave
// predictably under a reorder/edit of the SOURCE body used to build a NEW extraction — the
// ordinal component tracks POSITION (so a moved item's id changes), while the hash component
// tracks CONTENT (so an untouched item's hash half survives a reorder around it, and an edited
// item's hash half changes even at the same ordinal). Neither drift is ever silently absorbed
// into a stale snapshot — see checkAcSnapshotDrift (ac-snapshot.ts) for the full-body-hash gate
// that fires long before per-AC ids would ever need reconciling against a live re-extraction.
test("extractAcceptanceCriteria corpus: re-extracting the identical body is fully deterministic (same ids, every time)", () => {
  const body = "## Acceptance criteria\n\n- [ ] alpha\n- [ ] beta\n- [ ] gamma";
  assert.deepEqual(extractAcceptanceCriteria(body), extractAcceptanceCriteria(body));
});

test("extractAcceptanceCriteria corpus: reordering criteria changes the ordinal half of the id but preserves the hash half for untouched text", () => {
  const before = "## Acceptance criteria\n\n- [ ] alpha\n- [ ] beta\n- [ ] gamma";
  const after = "## Acceptance criteria\n\n- [ ] gamma\n- [ ] alpha\n- [ ] beta"; // rotated
  const beforeItems = extractAcceptanceCriteria(before)!;
  const afterItems = extractAcceptanceCriteria(after)!;
  const hashOf = (id: string) => id.split("-")[1];
  const alphaBefore = beforeItems.find((i) => i.text === "alpha")!;
  const alphaAfter = afterItems.find((i) => i.text === "alpha")!;
  assert.equal(hashOf(alphaBefore.id), hashOf(alphaAfter.id), "the same text hashes identically regardless of position");
  assert.notEqual(alphaBefore.id, alphaAfter.id, "the ordinal prefix differs -> the full id differs across the reorder");
  assert.equal(alphaBefore.id, "1-" + hashOf(alphaBefore.id));
  assert.equal(alphaAfter.id, "2-" + hashOf(alphaAfter.id));
});

test("extractAcceptanceCriteria corpus: editing one criterion's text changes only ITS id — sibling ids at other ordinals are untouched", () => {
  const before = "## Acceptance criteria\n\n- [ ] alpha\n- [ ] beta\n- [ ] gamma";
  const after = "## Acceptance criteria\n\n- [ ] alpha\n- [ ] beta EDITED\n- [ ] gamma";
  const beforeItems = extractAcceptanceCriteria(before)!;
  const afterItems = extractAcceptanceCriteria(after)!;
  assert.equal(beforeItems[0]!.id, afterItems[0]!.id, "alpha (untouched, same ordinal) keeps its id");
  assert.notEqual(beforeItems[1]!.id, afterItems[1]!.id, "beta's edited text changes its id");
  assert.equal(beforeItems[2]!.id, afterItems[2]!.id, "gamma (untouched, same ordinal) keeps its id");
});

test("extractAcceptanceCriteria corpus: duplicate identical criterion text at different ordinals still gets distinct ids (the ordinal half disambiguates)", () => {
  const items = extractAcceptanceCriteria("## Acceptance criteria\n\n- [ ] run the tests\n- [ ] run the tests")!;
  assert.equal(items.length, 2);
  assert.notEqual(items[0]!.id, items[1]!.id);
  assert.equal(items[0]!.text, items[1]!.text);
});

// ── #591: language-free issue bodies use exact, fence-safe sapwood section anchors ─────────

const JAPANESE_ANCHORED_BODY = `## 受け入れ条件
<!-- sapwood:ac -->

- [ ] 日本語の完了条件を満たす

## 検証計画
<!-- sapwood:verification -->

- npm test を実行する`;

const RTL_ANCHORED_BODY = `## معايير القبول
<!-- sapwood:ac -->

- [ ] يتحقق السلوك المتوقع

## خطة التحقق
<!-- sapwood:verification -->

- شغّل npm test`;

test("#591 fixture matrix: Japanese and RTL headings with both anchors extract a complete dispatch plan and checkbox ACs", () => {
  for (const body of [JAPANESE_ANCHORED_BODY, RTL_ANCHORED_BODY]) {
    assert.ok(extractVerificationPlan(body)?.includes("<!-- sapwood:ac -->"));
    assert.ok(extractVerificationSection(body)?.includes("<!-- sapwood:verification -->"));
    assert.equal(extractAcceptanceCriteria(body)?.length, 1);
  }
});

test("#591: Japanese and RTL anchored issues dispatch once plan:approved is labelled", () => {
  const project = parseProject(
    JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT_591",
            field: { id: "PVTF_status", options: [{ id: "ready", name: "Ready" }] },
            items: {
              nodes: [JAPANESE_ANCHORED_BODY, RTL_ANCHORED_BODY].map((body, index) => ({
                id: `ITEM_591_${index}`,
                content: {
                  number: 5910 + index,
                  title: "anchored issue",
                  state: "OPEN",
                  body,
                  repository: { nameWithOwner: "herehigher/sapwood" },
                  labels: { nodes: [{ name: "plan:approved" }] },
                },
                fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
              })),
            },
          },
        },
      },
    }),
    "Status",
  );
  assert.deepEqual(
    selectReadyIssues(project, cfg).map((issue) => issue.number),
    [5910, 5911],
  );
});

test("#591 fixture matrix: legacy English extraction remains byte-for-byte unchanged when no anchors are present", () => {
  const body = "before\n\n## Acceptance criteria\n\n- [ ] legacy AC\n\n## Verification plan\n\n- run legacy test\n\nafter";
  assert.equal(
    extractVerificationPlan(body),
    "## Acceptance criteria\n\n- [ ] legacy AC\n\n## Verification plan\n\n- run legacy test\n\nafter",
  );
  assert.equal(extractVerificationSection(body), "## Verification plan\n\n- run legacy test\n\nafter");
  assert.deepEqual(
    extractAcceptanceCriteria(body)?.map((item) => item.text),
    ["legacy AC"],
  );
});

test("#591 fixture matrix: fenced anchors are ignored, so fenced-only non-English markers remain planless", () => {
  const body = "```markdown\n## 受け入れ条件\n<!-- sapwood:ac -->\n\n## 検証\n<!-- sapwood:verification -->\n```";
  assert.equal(extractVerificationPlan(body), null);
  assert.equal(extractVerificationSection(body), null);
  assert.equal(extractAcceptanceCriteria(body), null);
});

test("#591 fixture matrix: CRLF anchored bodies parse identically", () => {
  const body = JAPANESE_ANCHORED_BODY.replace(/\n/g, "\r\n");
  assert.ok(extractVerificationPlan(body)?.includes("## 受け入れ条件"));
  assert.equal(extractAcceptanceCriteria(body)?.[0]?.text, "日本語の完了条件を満たす");
});

test("#591 fixture matrix: partial, duplicate, unknown, and misplaced anchors fail closed as planless", () => {
  const malformedBodies = [
    "## 受け入れ条件\n<!-- sapwood:ac -->\n\n- [ ] one\n\n## 検証\n- run test",
    `${JAPANESE_ANCHORED_BODY}\n\n## 重複\n<!-- sapwood:ac -->`,
    "## 受け入れ条件\n<!-- sapwood:ac -->\n\n- [ ] one\n\n## 検証\n<!-- sapwood:verification -->\n\n- test\n\n<!-- sapwood:future -->",
    "<!-- sapwood:ac -->\n\n## 受け入れ条件\n\n- [ ] one\n\n## 検証\n<!-- sapwood:verification -->\n\n- test",
  ];
  for (const body of malformedBodies) {
    assert.equal(extractVerificationPlan(body), null);
    assert.equal(extractVerificationSection(body), null);
    assert.equal(extractAcceptanceCriteria(body), null);
  }
});

test("#591: digit and hyphenated reserved-namespace anchors fail closed instead of dispatching through legacy headings", () => {
  const legacyDispatchable = `## Acceptance criteria

- [ ] legacy AC

## Verification plan

- run legacy test`;
  const project = parseProject(
    JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT_591_RESERVED",
            field: { id: "PVTF_status", options: [{ id: "ready", name: "Ready" }] },
            items: {
              nodes: ["v2", "future-role"].map((token, index) => ({
                id: `ITEM_591_RESERVED_${index}`,
                content: {
                  number: 5913 + index,
                  title: "reserved namespace attempt",
                  state: "OPEN",
                  body: `${legacyDispatchable}\n\n<!-- sapwood:${token} -->`,
                  repository: { nameWithOwner: "herehigher/sapwood" },
                  labels: { nodes: [{ name: "plan:approved" }] },
                },
                fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
              })),
            },
          },
        },
      },
    }),
    "Status",
  );
  for (const issue of project.items) {
    assert.equal(extractVerificationPlan(issue.body), null);
    assert.equal(extractVerificationSection(issue.body), null);
    assert.equal(extractAcceptanceCriteria(issue.body), null);
  }
  assert.deepEqual(selectReadyIssues(project, cfg), []);
});

test("#591: mixed-level anchored role sections preserve legacy non-duplication in both nesting directions", () => {
  const acContainingVerification = `## 受け入れ条件
<!-- sapwood:ac -->

- [ ] 完了する

### 検証
<!-- sapwood:verification -->

- テストを実行する

## 注記

対象外`;
  const verificationContainingAc = `## 検証
<!-- sapwood:verification -->

- テストを実行する

### 受け入れ条件
<!-- sapwood:ac -->

- [ ] 完了する

## 注記

対象外`;
  for (const body of [acContainingVerification, verificationContainingAc]) {
    const plan = extractVerificationPlan(body);
    assert.ok(plan != null);
    assert.equal(plan.match(/<!-- sapwood:ac -->/g)?.length, 1, "acceptance range is emitted once");
    assert.equal(plan.match(/<!-- sapwood:verification -->/g)?.length, 1, "verification range is emitted once");
    assert.ok(!plan.includes("対象外"));
  }
});

test("#591: a partial anchor set enters PO triage instead of using an English-heading fallback", () => {
  const body = "## Acceptance criteria\n\n- [ ] ignored legacy AC\n\n## 受け入れ条件\n<!-- sapwood:ac -->\n\n- [ ] incomplete marker set";
  const project = parseProject(
    JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT_591_TRIAGE",
            field: { id: "PVTF_status", options: [{ id: "todo", name: "Todo" }] },
            items: {
              nodes: [
                {
                  id: "ITEM_591_TRIAGE",
                  content: {
                    number: 5912,
                    title: "partial anchors",
                    state: "OPEN",
                    body,
                    repository: { nameWithOwner: "herehigher/sapwood" },
                    labels: { nodes: [] },
                  },
                  fieldValues: { nodes: [{ name: "Todo", field: { name: "Status" } }] },
                },
              ],
            },
          },
        },
      },
    }),
    "Status",
  );
  assert.deepEqual(
    selectPlanTriageCandidates(project, cfg).map((issue) => issue.number),
    [5912],
  );
});

test("#591 fixture matrix: anchored mode overrides conflicting English headings and protocol tokens are exact lowercase ASCII", () => {
  const body = `## Acceptance criteria

- [ ] ignored English AC

## Verification plan

- ignored English verification

${JAPANESE_ANCHORED_BODY}`;
  assert.ok(extractVerificationPlan(body)?.includes("日本語の完了条件"));
  assert.ok(!extractVerificationPlan(body)?.includes("ignored English AC"));
  assert.deepEqual(
    extractAcceptanceCriteria(body)?.map((item) => item.text),
    ["日本語の完了条件を満たす"],
  );

  const wrongCase = JAPANESE_ANCHORED_BODY.replace("sapwood:ac", "sapwood:AC").replace("sapwood:verification", "sapwood:VERIFICATION");
  assert.equal(extractVerificationPlan(wrongCase), null);
  assert.equal(extractAcceptanceCriteria(wrongCase), null);
});

test("readStartupReconcileData returns board placements plus open PR bodies using read-only gh calls", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return args[0] === "api" ? PROJECT_JSON : JSON.stringify([{ number: 200, body: "Fixes #171" }]);
  };
  const result = await forge.readStartupReconcileData();
  assert.ok(result.placements.some((placement) => placement.number === 10 && placement.status === "Ready"));
  assert.deepEqual(result.openPrs, [{ number: 200, body: "Fixes #171" }]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]!.slice(0, 2), ["pr", "list"]);
  assert.ok(seen[1]!.includes("open"));
  assert.ok(!seen.flat().some((arg) => ["edit", "create", "merge", "comment"].includes(arg)));
});

test("listIssuesAbsentFromBoard: cross-references the board's placements with this repo's open issues, read-only", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "herehigher", repo: "sapwood", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    // PROJECT_JSON's ITEM_10 (repo herehigher/sapwood) is on the board; #999 is not, and is on
    // no other project either.
    return args[0] === "api"
      ? PROJECT_JSON
      : JSON.stringify([
          { number: 10, projectItems: [{ title: "board" }] },
          { number: 999, projectItems: [] },
        ]);
  };
  assert.deepEqual(await forge.listIssuesAbsentFromBoard(), { unplaced: [999], elsewhere: 0 });
  assert.ok(!seen.flat().some((arg) => ["edit", "create", "merge", "comment"].includes(arg)), "read-only — no write verb in any gh call");
});

// #491: the membership signal is GitHub's own `projectItems` on the SAME open-issue read the
// gap report already made — one field, no per-issue lookup, no new state or config key.
test("listIssuesAbsentFromBoard: an issue on a DIFFERENT project board is a summary count, not a listed gap (#491)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "herehigher", repo: "sapwood", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return args[0] === "api"
      ? PROJECT_JSON
      : JSON.stringify([
          { number: 10, projectItems: [{ title: "dogfood queue" }] }, // the configured board
          { number: 998, projectItems: [{ title: "human-only board" }] }, // deliberately elsewhere
          { number: 999, projectItems: [] }, // genuinely unplaced
        ]);
  };
  assert.deepEqual(await forge.listIssuesAbsentFromBoard(), { unplaced: [999], elsewhere: 1 });
  const issueList = seen.find((args) => args[0] === "issue")!;
  assert.ok(issueList.includes("number,projectItems"), "membership comes from the open-issue read itself, not a per-issue call");
});

test("listIssuesAbsentFromBoard: fetchProject hitting its page ceiling degrades to a thrown error, never a wrong absent report (#415 review finding 1)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  let projectPages = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    if (args[0] === "api") {
      projectPages++;
      // hasNextPage stays true forever — a runaway cursor, same shape fetchAllReviewThreads'
      // own page-ceiling test uses. The real 50-page loop in fetchProject must run to
      // completion (not a shortcut) and mark the merged result truncated.
      return JSON.stringify({
        data: {
          user: {
            projectV2: {
              id: "PVT_x",
              field: { id: "F1", options: [] },
              items: { pageInfo: { hasNextPage: true, endCursor: `CUR${projectPages}` }, nodes: [] },
            },
          },
        },
      });
    }
    return JSON.stringify([]); // listOpenIssueNumbers: no open issues, irrelevant to this case
  };
  await assert.rejects(() => forge.listIssuesAbsentFromBoard(), /page ceiling/);
  assert.equal(projectPages, 50, "the real 50-page ceiling ran to completion, not a shortcut");
});

test("listIssuesAbsentFromBoard: an open-issue read at the exact --limit ceiling degrades to a thrown error, never a wrong absent report (#415 review finding 2)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    if (args[0] === "api") {
      return JSON.stringify({
        data: {
          user: {
            projectV2: {
              id: "PVT_x",
              field: { id: "F1", options: [] },
              items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
    }
    // Exactly OPEN_ISSUES_LIMIT rows — indistinguishable, from this response alone, between
    // "the repo genuinely has exactly this many open issues" and "gh truncated at --limit".
    return JSON.stringify(Array.from({ length: OPEN_ISSUES_LIMIT }, (_, i) => ({ number: i + 1 })));
  };
  await assert.rejects(() => forge.listIssuesAbsentFromBoard(), new RegExp(`${OPEN_ISSUES_LIMIT}-issue limit`));
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

test("parseProject: #86 milestone title threads onto ProjectItem, null when the issue has none", () => {
  const p = parseProject(PROJECT_JSON, "Status");
  assert.equal(p.items.find((it) => it.number === 10)?.milestone, "M4");
  assert.equal(p.items.find((it) => it.number === 11)?.milestone, null);
});

test("selectUnplacedIssues: selects only null Status, leaves every named Status untouched, and skips drafts", () => {
  assert.deepEqual(
    selectUnplacedIssues(
      [
        { number: 10, repo: "herehigher/sapwood", status: null },
        { number: 11, repo: "herehigher/sapwood", status: "Todo" },
        { number: 12, repo: "herehigher/sapwood", status: "Ready" },
        { number: null, repo: null, status: null },
        { number: null, repo: null, status: "Todo" },
      ],
      "herehigher/sapwood",
    ),
    { issues: [10], skipped: 1 },
  );
});

test("selectUnplacedIssues: same-number foreign No-Status item cannot demote the configured repo's Ready item", () => {
  assert.deepEqual(
    selectUnplacedIssues(
      [
        { number: 50, repo: "herehigher/sapwood", status: "Ready" },
        { number: 50, repo: "other/widgets", status: null },
      ],
      "herehigher/sapwood",
    ),
    { issues: [], skipped: 1 },
  );
});

test("selectUnplacedIssues: a foreign-repo No-Status item is skipped, never selected", () => {
  assert.deepEqual(selectUnplacedIssues([{ number: 77, repo: "other/widgets", status: null }], "herehigher/sapwood"), {
    issues: [],
    skipped: 1,
  });
});

// ── #412: selectIssuesAbsentFromBoard — the No-Status normalizer's detect-only sibling ─────────

test("selectIssuesAbsentFromBoard: an open issue on no project at all is unplaced", () => {
  assert.deepEqual(
    selectIssuesAbsentFromBoard(
      [
        { number: 10, onAnyProject: true },
        { number: 11, onAnyProject: false },
        { number: 12, onAnyProject: false },
      ],
      [{ number: 10, repo: "herehigher/sapwood", status: "Ready" }],
      "herehigher/sapwood",
    ),
    { unplaced: [11, 12], elsewhere: 0 },
  );
});

test("selectIssuesAbsentFromBoard: an issue present in ANY lane, including Done and No-Status, is not a gap", () => {
  const placements = [
    { number: 10, repo: "herehigher/sapwood", status: "Todo" },
    { number: 11, repo: "herehigher/sapwood", status: "Ready" },
    { number: 12, repo: "herehigher/sapwood", status: "In Progress" },
    { number: 13, repo: "herehigher/sapwood", status: "Done" },
    { number: 14, repo: "herehigher/sapwood", status: null },
  ];
  assert.deepEqual(
    selectIssuesAbsentFromBoard(
      [10, 11, 12, 13, 14].map((number) => ({ number, onAnyProject: true })),
      placements,
      "herehigher/sapwood",
    ),
    { unplaced: [], elsewhere: 0 },
  );
});

// #491: this repo deliberately runs a two-board partition (a dogfood queue + a human-only
// board), so "not on the configured board" is NOT the same question as "nobody has placed
// this issue anywhere". Only the latter is actionable.
test("selectIssuesAbsentFromBoard: three classes — configured-board member, other-board member, project-less (#491)", () => {
  assert.deepEqual(
    selectIssuesAbsentFromBoard(
      [
        { number: 10, onAnyProject: true }, // on the configured board
        { number: 11, onAnyProject: true }, // deliberately on a DIFFERENT board
        { number: 12, onAnyProject: false }, // on no board at all — the only gap
      ],
      [{ number: 10, repo: "herehigher/sapwood", status: "Ready" }],
      "herehigher/sapwood",
    ),
    { unplaced: [12], elsewhere: 1 },
  );
});

test("selectIssuesAbsentFromBoard: a foreign-repo item with the same number cannot mask a genuinely unplaced issue", () => {
  assert.deepEqual(
    selectIssuesAbsentFromBoard(
      [{ number: 50, onAnyProject: false }],
      [{ number: 50, repo: "other/widgets", status: "Ready" }],
      "herehigher/sapwood",
    ),
    { unplaced: [50], elsewhere: 0 },
  );
});

test("selectIssuesAbsentFromBoard: a draft item (no issue number) is jurisdiction-excluded, never masks an absence", () => {
  assert.deepEqual(
    selectIssuesAbsentFromBoard(
      [{ number: 60, onAnyProject: false }],
      [{ number: null, repo: null, status: "Ready" }],
      "herehigher/sapwood",
    ),
    { unplaced: [60], elsewhere: 0 },
  );
});

test("selectReadyIssues: Ready lane + OPEN + this repo + has verification plan (Decision #8, tightened by #88 gate⓪)", () => {
  const p = parseProject(PROJECT_JSON, "Status");
  const ready = selectReadyIssues(p, cfg);
  // #10 has a plan (and a milestone) but (post-#88 gate⓪) lacks plan:approved -> now excluded,
  // a legitimate tightening (presence alone used to be enough; it no longer is). #12
  // (verify:n/a, no needs-human) still passes via the doc-gate path. #11 no plan, #13 not
  // Ready, #14 other repo, #15 closed -> all out, unchanged.
  assert.deepEqual(
    ready.map((i) => i.number).sort((a, b) => a - b),
    [12],
  );
  assert.deepEqual(ready.find((i) => i.number === 12)?.labels, ["type:docs", "verify:n/a"]);
  // #74: body carries through to the public Issue (worker.ts's {{issue.body}} substitution).
  assert.equal(ready.find((i) => i.number === 12)?.body, "no plan needed");
  // #86: milestone is undefined (not null, not "") for a ready issue with no milestone
  // assigned. (The threads-through-when-present half lives on the gate⓪ matrix below —
  // #10, PROJECT_JSON's only milestoned item, is no longer returned under gate⓪.)
  assert.equal(ready.find((i) => i.number === 12)?.milestone, undefined);
});

// ── #88: gate⓪ — plan:approved dispatch requirement (amends Decision #8 per #77's
//   2026-07-09 comment). Full matrix in one dedicated fixture, separate from PROJECT_JSON
//   above so this test's item count/shape doesn't perturb the other parseProject-based tests. */
const GATE0_PROJECT_JSON = JSON.stringify({
  data: {
    user: {
      projectV2: {
        id: "PVT_gate0",
        field: { id: "PVTF_status", options: [{ id: "opt_ready", name: "Ready" }] },
        items: {
          nodes: [
            // #40: plan present + plan:approved -> dispatchable. Also carries a milestone —
            // the #86 threads-through-when-present coverage rides this item (PROJECT_JSON's
            // only milestoned item, #10, is no longer returned under gate⓪). #283: also carries
            // a checkbox acceptance-criteria section — required for dispatch alongside
            // plan:approved since isDispatchable now also gates on extractAcceptanceCriteria.
            {
              number: 40,
              title: "plan approved",
              labels: ["plan:approved"],
              body: "## Acceptance criteria\n- [ ] the command succeeds\n\n## Verification\n- run npm test",
              milestone: "M4",
            },
            // #41: plan present, no plan:approved -> excluded (presence alone is not enough).
            {
              number: 41,
              title: "plan not yet approved",
              labels: [],
              body: "## Verification\n- run npm test",
            },
            // #42: no plan, no verify:n/a -> excluded (Decision #8's original floor, unchanged).
            {
              number: 42,
              title: "no plan at all",
              labels: [],
              body: "just vibes",
            },
            // #43: verify:n/a + needs-human -> excluded (human hasn't adjudicated yet).
            {
              number: 43,
              title: "proposed verify:n/a, pending human",
              labels: ["verify:n/a", "needs-human"],
              body: "no plan needed",
            },
            // #44: verify:n/a alone (needs-human removed by a human) -> dispatchable, doc-gate path.
            {
              number: 44,
              title: "verify:n/a accepted",
              labels: ["verify:n/a"],
              body: "no plan needed",
            },
            // #45: plan + plan:approved + needs-human -> excluded (needs-human always blocks).
            {
              number: 45,
              title: "approved plan but escalated",
              labels: ["plan:approved", "needs-human"],
              body: "## Verification\n- run npm test",
            },
            // #46: plan + plan:approved + blocked -> excluded (blocked always blocks).
            {
              number: 46,
              title: "approved plan but blocked",
              labels: ["plan:approved", "blocked"],
              body: "## Verification\n- run npm test",
            },
            // #47: BOTH verify:n/a and plan:approved — a state the verification-plan-reviewer prompt forbids
            // ("never both dispatch paths on one issue"). Fail closed: excluded from dispatch
            // AND from plan-review (it needs a human cleanup, not another session) — #94
            // Codex retro-review P2.
            {
              number: 47,
              title: "mixed dispatch labels (forbidden state)",
              labels: ["verify:n/a", "plan:approved"],
              body: "## Verification\n- run npm test",
            },
          ].map((it: { number: number; title: string; labels: string[]; body: string; milestone?: string }) => ({
            id: `ITEM_${it.number}`,
            content: {
              number: it.number,
              title: it.title,
              state: "OPEN",
              body: it.body,
              repository: { nameWithOwner: "herehigher/sapwood" },
              labels: { nodes: it.labels.map((name) => ({ name })) },
              ...(it.milestone !== undefined ? { milestone: { title: it.milestone } } : {}),
            },
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          })),
        },
      },
    },
  },
});

test("selectReadyIssues: #88 gate⓪ full matrix — needs-human/blocked always block; verify:n/a alone is the doc-gate path; a real plan additionally requires plan:approved", () => {
  const p = parseProject(GATE0_PROJECT_JSON, "Status");
  const ready = selectReadyIssues(p, cfg);
  // #47 (verify:n/a + plan:approved together) is the forbidden mixed state — fail-closed
  // excluded (#94 Codex retro-review P2), never dispatched via the verify:n/a early path.
  assert.deepEqual(
    ready.map((i) => i.number).sort((a, b) => a - b),
    [40, 44],
  );
  // #86: milestone threads through selectReadyIssues when present.
  assert.equal(ready.find((i) => i.number === 40)?.milestone, "M4");
});

test("isDispatchable: BOTH verify:n/a and plan:approved (forbidden mixed state) fails closed — excluded from dispatch until a human cleans up (#94 Codex retro-review P2)", () => {
  const p = parseProject(GATE0_PROJECT_JSON, "Status");
  const ready = selectReadyIssues(p, cfg);
  assert.ok(!ready.some((i) => i.number === 47), "mixed-label issue never dispatches");
});

// ── #283 (M10, E2, design #279 §5, D4): a malformed/empty checkbox AC set is not dispatchable ──

const GATE0_AC_PROJECT_JSON = JSON.stringify({
  data: {
    user: {
      projectV2: {
        id: "PVT_gate0_ac",
        field: { id: "PVTF_status", options: [{ id: "opt_ready", name: "Ready" }] },
        items: {
          nodes: [
            // #60: plan:approved + a real verification section + a real checkbox AC section
            // -> dispatchable, the happy path.
            {
              number: 60,
              title: "AC present",
              labels: ["plan:approved"],
              body: "## Acceptance criteria\n\n- [ ] one\n- [ ] two\n\n## Verification\n- run npm test",
            },
            // #61: plan:approved + verification, but the Acceptance criteria heading has zero
            // checkbox lines (prose only) -> excluded: malformed/empty AC.
            {
              number: 61,
              title: "AC section present but no checkboxes",
              labels: ["plan:approved"],
              body: "## Acceptance criteria\n\nSome prose, no checkboxes.\n\n## Verification\n- run npm test",
            },
            // #62: plan:approved + verification, but NO Acceptance criteria heading at all ->
            // excluded: empty AC (the pre-#283 dispatchable shape).
            {
              number: 62,
              title: "no AC heading at all",
              labels: ["plan:approved"],
              body: "## Verification\n- run npm test",
            },
            // #63: verify:n/a, no AC heading at all -> STILL dispatchable (the doc-gate path is
            // never held to the checkbox-AC requirement).
            {
              number: 63,
              title: "verify:n/a, no AC needed",
              labels: ["verify:n/a"],
              body: "no plan needed",
            },
            // #64: plan:approved + checkbox AC, but no explicit Verification section. Historical
            // extractVerificationPlan compatibility sees Acceptance as a plan; #310's gate⓪
            // extension still rejects it because no concrete verification steps exist.
            {
              number: 64,
              title: "AC but no verification steps",
              labels: ["plan:approved"],
              body: "## Acceptance criteria\n\n- [ ] one",
            },
          ].map((it: { number: number; title: string; labels: string[]; body: string }) => ({
            id: `ITEM_${it.number}`,
            content: {
              number: it.number,
              title: it.title,
              state: "OPEN",
              body: it.body,
              repository: { nameWithOwner: "herehigher/sapwood" },
              labels: { nodes: it.labels.map((name) => ({ name })) },
            },
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          })),
        },
      },
    },
  },
});

test("isDispatchable: #283 — a malformed/empty checkbox AC set on a non-verify:na issue is not dispatchable; verify:n/a is exempt", () => {
  const p = parseProject(GATE0_AC_PROJECT_JSON, "Status");
  const ready = selectReadyIssues(p, cfg);
  assert.deepEqual(
    ready.map((i) => i.number).sort((a, b) => a - b),
    [60, 63],
    "#61/#62 malformed AC and #64 missing verification are excluded; #63 (verify:n/a) is exempt",
  );
});

test("getReadyIssues: any gh/API error during the project fetch -> rejects, never a silent partial/empty ready list (fail-closed)", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    throw new Error("gh: rate limited");
  };
  await assert.rejects(() => forge.getReadyIssues(), /rate limited/);
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
                {
                  id: "ITEM_A",
                  content: {
                    number: 50,
                    title: "ours",
                    state: "OPEN",
                    body: "",
                    repository: { nameWithOwner: "herehigher/sapwood" },
                    labels: { nodes: [] },
                  },
                  fieldValues: { nodes: [] },
                },
                {
                  id: "ITEM_B",
                  content: {
                    number: 50,
                    title: "theirs",
                    state: "OPEN",
                    body: "",
                    repository: { nameWithOwner: "herehigher/0day" },
                    labels: { nodes: [] },
                  },
                  fieldValues: { nodes: [] },
                },
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
                {
                  id: "FOREIGN",
                  content: {
                    number: 60,
                    title: "foreign",
                    state: "OPEN",
                    body: "## Verification",
                    repository: { nameWithOwner: "other/sapwood" },
                    labels: { nodes: [] },
                  },
                  fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
                },
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
  assert.deepEqual(s, { number: 21, headOid: "d0ce0a5", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
});

test("parsePRStatus (#287, E4b): baseRefOid becomes PRStatus.baseOid — additive, older fixtures without it keep parsing with no baseOid key at all", () => {
  const withBase = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      baseRefOid: "main-sha",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(withBase.baseOid, "main-sha");

  // Older fixture: no baseRefOid field at all — must parse unaffected, baseOid absent (not null).
  const withoutBase = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(withoutBase.baseOid, undefined);
  assert.ok(!Object.hasOwn(withoutBase, "baseOid"));
});

test("parsePRStatus (#595): title becomes PRStatus.title — additive, older fixtures without it keep parsing with no title key at all", () => {
  const withTitle = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      title: "feat(engine): persist issue/PR titles in event payloads",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(withTitle.title, "feat(engine): persist issue/PR titles in event payloads");

  // Older fixture: no title field at all — must parse unaffected, title absent (not null).
  const withoutTitle = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(withoutTitle.title, undefined);
  assert.ok(!Object.hasOwn(withoutTitle, "title"));
});

test("getPRStatus (#595): the gh pr view --json field list includes title", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({
      number: 21,
      headRefOid: "abc",
      title: "some title",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
    });
  };
  const status = await forge.getPRStatus(21);
  const jsonFlagIdx = seen[0]!.indexOf("--json");
  assert.ok(seen[0]![jsonFlagIdx + 1]!.includes("title"));
  assert.equal(status.title, "some title");
});

test("getPRStatus (#287): the gh pr view --json field list includes baseRefOid", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({
      number: 1,
      headRefOid: "abc",
      baseRefOid: "def",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
    });
  };
  const status = await forge.getPRStatus(7);
  const jsonFlagIdx = seen[0]!.indexOf("--json");
  assert.ok(seen[0]![jsonFlagIdx + 1]!.includes("baseRefOid"));
  assert.equal(status.baseOid, "def");
});

test("parsePRStatus: an empty rollup fails closed (checks may not be created yet), and is NOT red (#246 — no checks reported is pending, not failed)", () => {
  const s = parsePRStatus(JSON.stringify({ number: 1, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }));
  assert.equal(s.ciGreen, false); // genuinely CI-less repos opt in via ci.requireChecks (M3)
  assert.equal(s.ciRed, false);
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
  assert.equal(s.ciRed, false); // #246: pending (null conclusion), not failed — must not read as CI_RED
});

// ── #401 (F26): gate① ciGreen conclusion truth table ────────────────────────────────────────
// PRE-#401 behavior (for the record): PASSING was {SUCCESS, SKIPPED, NEUTRAL}, so a rollup of
// [SKIPPED, NEUTRAL, SUCCESS] read ciGreen: true — a workflow whose test job was skipped merged
// as "green". POST-#401: only a completed SUCCESS is execution evidence.
test("parsePRStatus (#401): ciGreen conclusion truth table — only SUCCESS is green; SKIPPED/NEUTRAL no longer pass", () => {
  const status = (conclusion: string | null) =>
    parsePRStatus(
      JSON.stringify({ number: 4, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion }] }),
    );
  const green = (conclusion: string | null) => status(conclusion).ciGreen;

  assert.equal(green("SUCCESS"), true);
  // The #401 change: completed-but-not-executed conclusions are not passing evidence.
  assert.equal(green("SKIPPED"), false);
  assert.equal(green("NEUTRAL"), false);
  // Unchanged by #401 — never were green.
  assert.equal(green("CANCELLED"), false);
  assert.equal(green("STALE"), false);
  assert.equal(green("ACTION_REQUIRED"), false);
  assert.equal(green("FAILURE"), false);
  assert.equal(green(null), false); // queued/in-progress
  // #246 tri-state is untouched: SKIPPED/NEUTRAL are not-green but still NOT red — the engine
  // must not dispatch a mechanical CI-fix leg at a job that was deliberately skipped.
  assert.equal(status("SKIPPED").ciRed, false);
  assert.equal(status("NEUTRAL").ciRed, false);

  // Legacy commit StatusContext: state SUCCESS is STILL green — deliberate, not an oversight, and
  // READJUDICATED: PR #422's review read it as a third direction outside #401's two-way AC; the
  // repo owner ruled 2026-07-29 that "SUCCESS-only" is scoped to CheckRun CONCLUSIONS and this
  // path stays (design #279 §4 records the ruling).
  // requiredChecksSatisfied rejects status contexts because their owning App can't
  // be verified, a `ci.requiredChecks`-specific binding (docs/security.md); gate① is the general
  // CI signal for every reviewer mode, the Status API has no SKIPPED/NEUTRAL concept to exploit,
  // and rejecting it would permanently wedge every Status-API CI repo (Jenkins, Buildkite).
  const legacy = (state: string) =>
    parsePRStatus(JSON.stringify({ number: 4, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ state }] }))
      .ciGreen;
  assert.equal(legacy("SUCCESS"), true);
  assert.equal(legacy("PENDING"), false);
  assert.equal(legacy("FAILURE"), false);

  // Empty rollup: unchanged, fail-closed (no checks reported yet != "this repo has no CI").
  assert.equal(
    parsePRStatus(JSON.stringify({ number: 4, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] })).ciGreen,
    false,
  );
  // Mixed rollup: one SKIPPED among otherwise-SUCCESS checks is enough to withhold green.
  assert.equal(
    parsePRStatus(
      JSON.stringify({
        number: 4,
        headRefOid: "abc",
        state: "OPEN",
        mergeable: "MERGEABLE",
        statusCheckRollup: [{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }, { conclusion: "SUCCESS" }],
      }),
    ).ciGreen,
    false,
  );
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
  assert.equal(s.ciRed, true); // #246: a completed FAILURE conclusion is genuinely red
});

test("parsePRStatus: unrecognized mergeable value normalizes to UNKNOWN (queue, not escalate)", () => {
  const s = parsePRStatus(JSON.stringify({ number: 3, headRefOid: "abc", state: "OPEN", mergeable: "UNKNOWN", statusCheckRollup: [] }));
  assert.equal(s.mergeable, "UNKNOWN");
});

test("parsePRStatus (#246): TIMED_OUT/STARTUP_FAILURE/ERROR conclusions are red; CANCELLED/ACTION_REQUIRED/STALE are NOT (ambiguous, never auto-dispatch a fix leg on them)", () => {
  const red = (conclusion: string) =>
    parsePRStatus(
      JSON.stringify({ number: 9, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion }] }),
    ).ciRed;
  assert.equal(red("TIMED_OUT"), true);
  assert.equal(red("STARTUP_FAILURE"), true);
  assert.equal(red("ERROR"), true);
  assert.equal(red("CANCELLED"), false);
  assert.equal(red("ACTION_REQUIRED"), false);
  assert.equal(red("STALE"), false);
});

test("parsePRStatus (#246): legacy StatusContext FAILURE/ERROR state is red; PENDING/EXPECTED are not", () => {
  const red = (state: string) =>
    parsePRStatus(JSON.stringify({ number: 10, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ state }] }))
      .ciRed;
  assert.equal(red("FAILURE"), true);
  assert.equal(red("ERROR"), true);
  assert.equal(red("PENDING"), false);
  assert.equal(red("EXPECTED"), false);
});

test("parsePRStatus (#246): one red check among otherwise-passing ones is still red (mixed rollup)", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 11,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { conclusion: "SKIPPED" }],
    }),
  );
  assert.equal(s.ciRed, true);
  assert.equal(s.ciGreen, false);
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
  const v = parsePRReviewView(JSON.stringify({ headRefOid: "H", updatedAt: "t", isDraft: true, state: "OPEN" }));
  assert.deepEqual(v.labels, []);
  assert.deepEqual(v.reviews, []);
  assert.equal(v.author, "");
});

// PR #55 P1-B removed the headCommittedAt/commits plumbing entirely: the thumb-verdict
// freshness pin now lives in engine State (workers.review_triggered_head/at), not anything
// read off a commit's own (forgeable, non-push-bound) committedDate. See reviewer.test.ts's
// ReviewTriggerPin-based tests for the freshness-cutoff coverage that replaces these two.
test("parsePRReviewView: no commit-date fields are parsed at all (#55 P1-B — deleted, not just unused)", () => {
  const v = parsePRReviewView(
    JSON.stringify({
      headRefOid: "H2",
      updatedAt: "t",
      isDraft: false,
      state: "OPEN",
      commits: [
        { oid: "H1", committedDate: "2026-07-07T07:00:00Z" },
        { oid: "H2", committedDate: "2026-07-07T07:40:00Z" },
      ],
    }),
  );
  assert.ok(!("headCommittedAt" in v));
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

test("parsePRComments: multi-page slurp flattens; missing fields degrade to empty strings", () => {
  const r = parsePRComments(
    JSON.stringify([
      [{ body: "Codex Review: Didn't find any major issues.", created_at: "t1", user: { login: "chatgpt-codex-connector[bot]" } }],
      [{ user: {} }],
    ]),
  );
  assert.deepEqual(r, [
    { login: "chatgpt-codex-connector[bot]", createdAt: "t1", body: "Codex Review: Didn't find any major issues." },
    { login: "", createdAt: "", body: "" },
  ]);
});

test("parsePRReactions: --slurp multi-page output (array of page arrays) flattens in order (Codex PR #42 P2)", () => {
  // gh api --paginate --slurp wraps each page's array in one outer array; a reaction list
  // spanning pages previously threw on JSON.parse and wedged the merge gate at "queued".
  const r = parsePRReactions(
    JSON.stringify([
      [{ content: "+1", created_at: "t1", user: { login: "a" } }],
      [
        { content: "eyes", created_at: "t2", user: { login: "b" } },
        { content: "+1", created_at: "t3", user: {} },
      ],
    ]),
  );
  assert.deepEqual(
    r.map((x) => [x.content, x.login]),
    [
      ["+1", "a"],
      ["eyes", "b"],
      ["+1", ""],
    ],
  );
});

test("parsePRReactions: empty slurp output parses to []", () => {
  assert.deepEqual(parsePRReactions("[]"), []);
  assert.deepEqual(parsePRReactions("[[]]"), []);
});

const threadsPage = (resolved: boolean[], pageInfo?: { hasNextPage: boolean; endCursor: string | null }): string =>
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
  assert.equal(p.unresolved, 2);
  assert.equal(p.hasNextPage, true);
  assert.equal(p.endCursor, "CUR");
});

test("parseReviewThreadsPage: absent/malformed shape -> 0 + terminal, never throws or loops", () => {
  assert.deepEqual(parseReviewThreadsPage(JSON.stringify({})), {
    unresolved: 0,
    threads: [],
    hasNextPage: false,
    endCursor: null,
  });
});

// ── #378 (F14): resolved-thread + head-freshness data plumbing ────────────────────────────────
// The motivating case is PR #366: the SAME config-YAML finding was re-raised five times after it
// had been human-adjudicated and thread-resolved. Gate② could not tell an already-adjudicated
// re-raise from a fresh finding because the only per-thread data it ever saw was an aggregate
// unresolved COUNT. These fields (span + GitHub's own isOutdated + the resolution-time commit
// reference) are what reviewer.ts needs to make that distinction — see docs/patches/378-*.patch.

/** A reviewThreads page carrying the full #378 node shape (the helper above deliberately keeps
 *  the OLD, field-less node shape so the degradation tests below stay honest). */
const richThreadsPage = (
  nodes: {
    id: string;
    isResolved: boolean;
    isOutdated?: boolean;
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
    oid?: string;
    body?: string;
  }[],
  pageInfo?: { hasNextPage: boolean; endCursor: string | null },
): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            ...(pageInfo ? { pageInfo } : {}),
            nodes: nodes.map((n) => ({
              id: n.id,
              isResolved: n.isResolved,
              isOutdated: n.isOutdated ?? false,
              path: n.path ?? null,
              line: n.line ?? null,
              originalLine: n.originalLine ?? null,
              comments: { nodes: n.oid || n.body ? [{ body: n.body ?? null, commit: { oid: n.oid } }] : [] },
            })),
          },
        },
      },
    },
  });

test("#378 parseReviewThreadsPage: parses each thread's span, isOutdated, anchor commit and finding digest", () => {
  const p = parseReviewThreadsPage(
    richThreadsPage([
      { id: "T1", isResolved: true, path: "sapwood.config.yaml", line: 12, originalLine: 12, oid: "ANCHOR", body: "missing key `foo`" },
      { id: "T2", isResolved: false, isOutdated: true, path: "engine/src/a.ts", line: null, originalLine: 40, oid: "OLD" },
    ]),
  );
  assert.equal(p.unresolved, 1);
  assert.deepEqual(p.threads, [
    {
      id: "T1",
      isResolved: true,
      isOutdated: false,
      path: "sapwood.config.yaml",
      line: 12,
      originalLine: 12,
      anchorCommitOid: "ANCHOR",
      findingDigest: findingDigest("missing key `foo`"),
    },
    {
      id: "T2",
      isResolved: false,
      isOutdated: true,
      path: "engine/src/a.ts",
      line: null,
      originalLine: 40,
      anchorCommitOid: "OLD",
      findingDigest: null, // no body -> no digest, so nothing can ever match it
    },
  ]);
});

test("#378 findingDigest: identical finding text digests identically; DIFFERENT text on the same span never collides", () => {
  // The defect this closes (engine-agent review of PR #445): keying adjudication on file:line
  // alone let a DIFFERENT, never-adjudicated finding landing on an already-adjudicated line be
  // silently subtracted from the blocking count. Span is not finding identity.
  assert.equal(findingDigest("missing required key `foo`"), findingDigest("missing required key `foo`"));
  assert.notEqual(findingDigest("missing required key `foo`"), findingDigest("wrong indentation"));
});

test("#378 findingDigest: normalizes only whitespace runs — a markdown re-wrap of the SAME finding still matches", () => {
  assert.equal(findingDigest("missing required\n  key `foo`"), findingDigest("  missing required key `foo`  "));
  // Deliberately NOT case-folded or punctuation-stripped: every widening of this comparison
  // trades toward the dangerous failure direction (suppressing a distinct finding), so the
  // normalization stays at the narrowest thing that survives a re-wrap.
  assert.notEqual(findingDigest("Missing required key `foo`"), findingDigest("missing required key `foo`"));
});

test("#378 parseReviewThreadsPage: an empty/whitespace-only body yields NO digest — an unkeyable thread is never filterable", () => {
  const p = parseReviewThreadsPage(richThreadsPage([{ id: "T1", isResolved: true, path: "a.ts", line: 1, body: "   \n  " }]));
  assert.equal(p.threads[0]!.findingDigest, null);
});

test("#378 parseReviewThreadsPage: an older/field-less response degrades safely — span null, isOutdated fails CLOSED (true)", () => {
  // Absent isOutdated must read as "the span may have moved", never "the span is unchanged":
  // the false-NEGATIVE direction (a genuinely-adjudicated duplicate keeps blocking) is a wasted
  // fix round; the false-POSITIVE direction would suppress a REAL finding from gate② input.
  const p = parseReviewThreadsPage(threadsPage([false, true]));
  assert.equal(p.unresolved, 1);
  assert.deepEqual(
    p.threads.map((t) => [t.id, t.isOutdated, t.path, t.line, t.originalLine, t.anchorCommitOid, t.findingDigest]),
    [
      ["", true, null, null, null, null, null],
      ["", true, null, null, null, null, null],
    ],
  );
});

test("#378 collectReviewThreads: pages to exhaustion and returns BOTH the unresolved total and every thread", async () => {
  const pages: Record<string, string> = {
    "": richThreadsPage([{ id: "T1", isResolved: true, path: "a.ts", line: 1 }], { hasNextPage: true, endCursor: "P2" }),
    P2: richThreadsPage([{ id: "T2", isResolved: false, path: "a.ts", line: 1 }], { hasNextPage: false, endCursor: null }),
  };
  const { unresolved, threads } = await collectReviewThreads(async (after) => pages[after ?? ""]!);
  assert.equal(unresolved, 1);
  assert.deepEqual(
    threads.map((t) => t.id),
    ["T1", "T2"],
  );
});

test("#378 collectReviewThreads: the 50-page ceiling bounds a runaway cursor (same as countUnresolvedThreads)", async () => {
  let calls = 0;
  const { threads } = await collectReviewThreads(async () => {
    calls++;
    return richThreadsPage([{ id: `T${calls}`, isResolved: false }], { hasNextPage: true, endCursor: "SAME" });
  });
  assert.equal(calls, 50);
  assert.equal(threads.length, 50);
});

// ── #438: a hit page ceiling is an ANNOUNCED truncation, never a silent partial answer ────────

test("#438 collectReviewThreads: the page ceiling fires onPageCeiling exactly once with the partial counts; the return value is unchanged", async () => {
  const seen: { unresolved: number; threads: number }[] = [];
  let calls = 0;
  const { unresolved, threads } = await collectReviewThreads(
    async () => {
      calls++;
      return richThreadsPage([{ id: `T${calls}`, isResolved: false }], { hasNextPage: true, endCursor: "SAME" });
    },
    (partial) => seen.push(partial),
  );
  assert.deepEqual(seen, [{ unresolved: 50, threads: 50 }], "announced once, naming what it actually managed to count");
  assert.equal(unresolved, 50, "return value is byte-identical to pre-#438 behaviour");
  assert.equal(threads.length, 50);
});

test("#438 collectReviewThreads: a connection that pages to exhaustion never fires onPageCeiling", async () => {
  const pages: Record<string, string> = {
    "": richThreadsPage([{ id: "T1", isResolved: false }], { hasNextPage: true, endCursor: "P2" }),
    P2: richThreadsPage([{ id: "T2", isResolved: false }], { hasNextPage: false, endCursor: null }),
  };
  let fired = 0;
  const { unresolved } = await collectReviewThreads(
    async (after) => pages[after ?? ""]!,
    () => fired++,
  );
  assert.equal(fired, 0);
  assert.equal(unresolved, 2);
});

test("#438 getPRReviewData: a truncated review-threads read is announced on BOTH channels, naming the PR and the partial count", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const logged: string[] = [];
  const events: { kind: string; payload: unknown }[] = [];
  const forge = new GithubForge(cfg, {
    log: (m) => logged.push(m),
    state: { appendEvent: (kind, payload) => events.push({ kind, payload }) },
  });
  let graphqlPages = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    if (args[0] === "pr") {
      return JSON.stringify({
        headRefOid: "H",
        author: { login: "producer" },
        updatedAt: "2026-01-01T00:00:00Z",
        isDraft: false,
        labels: [],
        state: "OPEN",
        reviews: [],
      });
    }
    if (args[0] === "api" && args[1] === "graphql") {
      graphqlPages++;
      // Runaway cursor: hasNextPage never goes false, so the real 50-page ceiling is what stops it.
      return richThreadsPage([{ id: `T${graphqlPages}`, isResolved: false }], { hasNextPage: true, endCursor: `CUR${graphqlPages}` });
    }
    return "[]"; // reactions + conversation comments
  };

  const data = await forge.getPRReviewData(77);
  assert.equal(graphqlPages, 50, "the real ceiling ran, not a shortcut");
  assert.equal(data.unresolvedThreads, 50, "the partial count is still returned — observability only, no behaviour change");
  assert.equal(data.threads?.length, 50);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "forge-page-ceiling");
  assert.deepEqual(events[0]!.payload, { source: "review-threads", pr: 77, pages: 50, unresolved: 50, threads: 50 });
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /page ceiling/);
  assert.match(logged[0]!, /#77/);
  assert.match(logged[0]!, /50/);
});

test("#438 fetchProject: a truncated board read is announced on BOTH channels, naming the board and the partial item count", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" } });
  const logged: string[] = [];
  const events: { kind: string; payload: unknown }[] = [];
  const forge = new GithubForge(cfg, {
    log: (m) => logged.push(m),
    state: { appendEvent: (kind, payload) => events.push({ kind, payload }) },
  });
  let projectPages = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    projectPages++;
    return JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT_x",
            field: { id: "F1", options: [] },
            items: {
              pageInfo: { hasNextPage: true, endCursor: `CUR${projectPages}` },
              nodes: [
                {
                  id: `I${projectPages}`,
                  content: { number: projectPages, title: "t", state: "OPEN", labels: { nodes: [] } },
                  fieldValueByName: null,
                },
              ],
            },
          },
        },
      },
    });
  };

  // listUnplacedIssues is the shortest fetchProject consumer that does NOT refuse on truncation.
  await forge.listUnplacedIssues();
  assert.equal(projectPages, 50);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "forge-page-ceiling");
  assert.deepEqual(events[0]!.payload, { source: "project-items", owner: "o", projectNumber: 4, pages: 50, items: 50 });
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /page ceiling/);
  assert.match(logged[0]!, /50/);
});

test("#438 the announcement is never load-bearing: no state (dry-run) and a throwing appendEvent both still return the partial read", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const logged: string[] = [];
  const noState = new GithubForge(cfg, { log: (m) => logged.push(m) });
  const brokenState = new GithubForge(cfg, {
    log: (m) => logged.push(m),
    state: {
      appendEvent: () => {
        throw new Error("state db is gone");
      },
    },
  });
  for (const f of [noState, brokenState]) {
    let page = 0;
    (f as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
      if (args[0] === "pr") {
        return JSON.stringify({
          headRefOid: "H",
          author: { login: "p" },
          updatedAt: "t",
          isDraft: false,
          labels: [],
          state: "OPEN",
          reviews: [],
        });
      }
      if (args[0] === "api" && args[1] === "graphql") {
        page++;
        return richThreadsPage([{ id: `T${page}`, isResolved: false }], { hasNextPage: true, endCursor: `C${page}` });
      }
      return "[]";
    };
    assert.equal((await f.getPRReviewData(9)).unresolvedThreads, 50);
  }
  // noState: the ceiling line. brokenState: the ceiling line + the non-fatal append failure.
  assert.equal(logged.length, 3);
  assert.match(logged[2]!, /state db is gone/);
});

test("#378 assemblePRReviewData: threads ride along on PRReviewData; omitted -> undefined (no filtering possible, fail-closed)", () => {
  const view = JSON.stringify({
    headRefOid: "H",
    author: { login: "producer" },
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reviews: [],
  });
  const spans = parseReviewThreadsPage(richThreadsPage([{ id: "T1", isResolved: true, path: "a.ts", line: 3 }])).threads;
  assert.deepEqual(assemblePRReviewData(view, "[]", 0, "[]", spans).threads, spans);
  assert.equal(assemblePRReviewData(view, "[]", 0).threads, undefined);
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
    headRefOid: "H",
    author: { login: "producer" },
    updatedAt: "t",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reviews: [],
  });
  const reactions = JSON.stringify([{ content: "eyes", created_at: "t", user: { login: "codex" } }]);
  const data = assemblePRReviewData(view, reactions, 1);
  assert.equal(data.headOid, "H");
  assert.equal(data.reactions.length, 1);
  assert.equal(data.unresolvedThreads, 1);
});

// ── #76: countOpenIssuesInMilestone — the onMilestoneComplete stop condition's forge read ──

test("countOpenIssuesInMilestone: counts the open issues gh reports for that milestone, scoped to this repo/state via the right flags", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([{ number: 10 }, { number: 11 }, { number: 12 }]);
  };
  assert.equal(await forge.countOpenIssuesInMilestone("M4"), 3);
  assert.equal(seen.length, 1);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
  assert.ok(args.includes("--repo") && args.includes("o/r"));
  assert.ok(args.includes("--milestone") && args.includes("M4"));
  assert.ok(args.includes("--state") && args.includes("open"));
});

test("countOpenIssuesInMilestone: zero open issues -> 0 (the condition's fire signal)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => JSON.stringify([]);
  assert.equal(await forge.countOpenIssuesInMilestone("M4"), 0);
});

// ── #89: createIssue / listOpenIssueNumbers — the PO/alignment peripheral's forge surface ──

test("createIssue: runs `gh issue create` scoped to this repo, parses the new issue number from the URL gh prints", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "https://github.com/o/r/issues/123\n";
  };
  const n = await forge.createIssue("A title", "A body");
  assert.equal(n, 123);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["issue", "create"]);
  assert.ok(args.includes("--repo") && args.includes("o/r"));
  assert.ok(args.includes("--title") && args.includes("A title"));
  assert.ok(args.includes("--body") && args.includes("A body"));
});

test("createIssue: an unparseable gh output throws rather than silently returning a bogus number", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => "not a URL";
  await assert.rejects(() => forge.createIssue("t", "b"), /could not parse issue number/);
});

test("listOpenIssueNumbers: every open issue number in this repo", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([{ number: 5 }, { number: 7 }]);
  };
  assert.deepEqual(await forge.listOpenIssueNumbers(), [5, 7]);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
  assert.ok(args.includes("--state") && args.includes("open"));
});

test("listOpenIssues #215/#216: returns digest fields plus bodies for marker reconciliation", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([
      { number: 5, title: "Parked gap", body: "one", labels: [{ name: "blocked" }], milestone: { title: "M4" } },
      { number: 7, title: "Unassigned gap", body: "two", labels: [], milestone: null },
    ]);
  };
  assert.deepEqual(await forge.listOpenIssues(), [
    { number: 5, title: "Parked gap", body: "one", labels: ["blocked"], milestone: "M4" },
    { number: 7, title: "Unassigned gap", body: "two", labels: [] },
  ]);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
  assert.ok(args.includes("--state") && args.includes("open"));
  assert.ok(args.includes("number,title,body,labels,milestone"));
});

test("listOpenIssues #215: rejects an exactly-limit-sized response but accepts limit minus one", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  let issueCount = 999;
  (forge as unknown as { gh: () => Promise<string> }).gh = async () =>
    JSON.stringify(
      Array.from({ length: issueCount }, (_, index) => ({
        number: index + 1,
        title: `Issue ${index + 1}`,
        labels: [],
        milestone: null,
      })),
    );

  assert.equal((await forge.listOpenIssues()).length, 999);
  issueCount = 1000;
  await assert.rejects(() => forge.listOpenIssues(), /backlog read is incomplete \(limit 1000\)/);
});

test("listRecentlyClosedIssues #528: one BOUNDED closed-issue read, same fields as listOpenIssues", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([
      { number: 461, title: "Shipped fact", body: "one", labels: [{ name: "type:bug" }], milestone: { title: "v0.2.1" } },
      { number: 5, title: "Older closed gap", body: "two", labels: [], milestone: null },
    ]);
  };
  assert.deepEqual(await forge.listRecentlyClosedIssues(), [
    { number: 461, title: "Shipped fact", body: "one", labels: ["type:bug"], milestone: "v0.2.1" },
    { number: 5, title: "Older closed gap", body: "two", labels: [] },
  ]);
  const args = seen[0]!;
  assert.equal(seen.length, 1, "one read — no pagination loop");
  assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
  assert.ok(args.includes("--state") && args.includes("closed"));
  assert.ok(args.includes("number,title,body,labels,milestone"));
  assert.ok(args.includes("--limit") && args.includes(String(RECENTLY_CLOSED_ISSUES_LIMIT)));
  assert.ok(args.includes("--search") && args.includes("sort:updated-desc"), "recency-ordered, so the bound keeps the RECENT tail");
});

test("listRecentlyClosedIssues #528: an exactly-limit-sized response is the BOUND, never an incompleteness error", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: () => Promise<string> }).gh = async () =>
    JSON.stringify(
      Array.from({ length: RECENTLY_CLOSED_ISSUES_LIMIT }, (_, index) => ({
        number: index + 1,
        title: `Closed ${index + 1}`,
        labels: [],
        milestone: null,
      })),
    );
  // Unlike listOpenIssues (whose completeness is load-bearing for the fail-closed create
  // boundary), this read is a BOUNDED backstop by design — hitting the bound is the normal case.
  assert.equal((await forge.listRecentlyClosedIssues()).length, RECENTLY_CLOSED_ISSUES_LIMIT);
});

// ── #110 PR0: updateIssueBody — the WRITE counterpart to getIssueBody, additive infra for the
//    structured-output rework (unused by any call site in this PR). ──

test("updateIssueBody: runs `gh issue edit <n> --body <text>` scoped to this repo", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "";
  };
  await forge.updateIssueBody(46, "revised body text");
  assert.equal(seen.length, 1);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 3), ["issue", "edit", "46"]);
  assert.ok(args.includes("--repo") && args.includes("o/r"));
  assert.ok(args.includes("--body") && args.includes("revised body text"));
});

// ── #111 PR-A: getCommitsSince — the retro digest's commit-history source (a `gh api` read,
//    never a local `git log` subprocess — see IForge.getCommitsSince's doc). ──

// ── #111 PR-B: branchExists — engine-side push verification for retro's PR proposal. ──

test("branchExists: runs `gh api repos/<owner>/<repo>/branches/<branch>`, per-segment encoded so slashes survive but other reserved chars can't reshape the path", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "{}";
  };
  assert.equal(await forge.branchExists("feat/111-pr-b#x"), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["api", "repos/o/r/branches/feat/111-pr-b%23x"]);
});

test("branchExists: a gh failure (404, network, auth — indistinguishable) reads as false, never a throw — fail direction: no PR against an unverified head", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    throw new Error("gh: Not Found (HTTP 404)");
  };
  assert.equal(await forge.branchExists("no-such-branch"), false);
});

test("getCommitsSince: runs `gh api repos/<owner>/<repo>/commits?since=...` with the ISO cutoff url-encoded, paginated to exhaustion", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "[]";
  };
  const commits = await forge.getCommitsSince("2026-07-11T06:00:00.000Z");
  assert.deepEqual(commits, []);
  assert.equal(seen.length, 1);
  const args = seen[0]!;
  assert.equal(args[0], "api");
  // The `since` ISO's colons must be url-encoded inside the query string.
  assert.equal(args[1], "repos/o/r/commits?since=2026-07-11T06%3A00%3A00.000Z&per_page=100");
  // Same pagination discipline as getIssueComments — never a silent first-page-only read.
  assert.ok(args.includes("--paginate") && args.includes("--slurp"));
});

// ── #87: selectPlanReviewCandidates — the plan_review peripheral's candidate query,
//    disjoint at completion from selectReadyIssues (that returns what's ALREADY past gate⓪) ──

test("selectPlanReviewCandidates: #88 gate⓪ matrix — only issues still AWAITING adjudication (no plan:approved, no needsHuman/blocked/verifyNa)", () => {
  const p = parseProject(GATE0_PROJECT_JSON, "Status");
  const candidates = selectPlanReviewCandidates(p, cfg);
  // #40 already plan:approved -> not a candidate (already reviewed).
  // #41 has a plan but no plan:approved yet -> still awaiting review.
  // #42 no plan at all -> still awaiting review.
  // #43 verify:n/a + needs-human (proposed, unresolved) -> not plan-review's concern.
  // #44 verify:n/a alone (doc-gate path) -> not plan-review's concern.
  // #45/#46 plan:approved + needs-human/blocked -> settled, not re-reviewed.
  // #47 verify:n/a + plan:approved (forbidden mixed state, #94 Codex retro P2) -> needs a
  //     human CLEANUP, not another review session — never a candidate.
  assert.deepEqual(
    candidates.map((i) => i.number).sort((a, b) => a - b),
    [41, 42],
  );
});

// ── #214: selectPoolEligibleIssues — the round pool's candidate source. LITERALLY "Ready lane
//    minus holds" (gate② review P2): a body-INDEPENDENT label check, not the isDispatchable ∪
//    needsPlanReview union an earlier draft used — that union has a gap an approved-but-planless
//    issue falls through (see forge.ts's own doc on isPoolEligible for the full story). ──

test("selectPoolEligibleIssues (#214): Ready lane minus holds — plain unadjudicated and plain approved are both eligible, an approved-but-planless orphan is STILL eligible (the gate② review P2 fix), the #94 mixed state and both hold labels are excluded, verify:n/a alone is eligible (doc-gate path, not a hold)", () => {
  const mkItem = (number: number, labels: string[], body: string) => ({
    itemId: `I${number}`,
    number,
    title: `issue ${number}`,
    state: "OPEN" as const,
    body,
    repo: "herehigher/sapwood",
    labels,
    status: "Ready",
    milestone: null,
  });
  const project = {
    projectId: "P",
    statusFieldId: "F",
    options: [],
    items: [
      mkItem(60, [], "just vibes, no plan yet"), // plain unadjudicated -> eligible (class 1)
      mkItem(61, [cfg.labels.planApproved], "## Verification\n- run npm test"), // plain approved, real plan -> eligible (class 2/3)
      // The gate② review P2 case: plan:approved survives, but the body's plan SECTION was later
      // deleted. The OLD isDispatchable ∪ needsPlanReview union stranded this — isDispatchable
      // fails (no plan text), needsPlanReview fails (planApproved present) — permanently
      // invisible to pool selection. The new label-only check makes it eligible again.
      mkItem(62, [cfg.labels.planApproved], "no verification section here anymore"),
      mkItem(63, [cfg.labels.needsHuman], "## Verification\n- x"), // hold -> excluded
      mkItem(64, [cfg.labels.blocked, cfg.labels.planApproved], "## Verification\n- x"), // hold -> excluded
      mkItem(65, [cfg.labels.verifyNa, cfg.labels.planApproved], "## Verification\n- x"), // #94 forbidden mixed state -> excluded
      mkItem(66, [cfg.labels.verifyNa], "no plan needed"), // doc-gate path, not a hold -> eligible
    ],
    placements: [],
  };
  const eligible = selectPoolEligibleIssues(project, cfg)
    .map((i) => i.number)
    .sort((a, b) => a - b);
  assert.deepEqual(eligible, [60, 61, 62, 66]);
});

test("selectPoolEligibleIssues (#214): full gate⓪ matrix fixture cross-check — same result shape as selectReadyIssues ∪ selectPlanReviewCandidates on GATE0_PROJECT_JSON (a fixture with no approved-but-planless orphan, where the old and new predicates happen to agree)", () => {
  const p = parseProject(GATE0_PROJECT_JSON, "Status");
  const eligible = selectPoolEligibleIssues(p, cfg)
    .map((i) => i.number)
    .sort((a, b) => a - b);
  // #40 approved (real plan), #41 unadjudicated (real plan, no approval), #42 unadjudicated (no
  // plan at all — still eligible, this predicate is body-independent), #44 verify:n/a alone.
  // #43/#45/#46 carry a hold label; #47 is the forbidden verifyNa+planApproved mixed state.
  assert.deepEqual(eligible, [40, 41, 42, 44]);
});

// ── #89: selectPlanTriageCandidates — the PO/triage peripheral's candidate query. Unlike
//    selectPlanReviewCandidates, this is NOT scoped to the Ready lane (triage runs proactively,
//    before a human ever moves an issue to Ready) — it's scoped by plan PRESENCE instead. ──

test("selectPlanTriageCandidates: only OPEN issues that are genuinely plan-less and not settled (needsHuman/blocked/verifyNa excluded)", () => {
  const p = parseProject(GATE0_PROJECT_JSON, "Status");
  const candidates = selectPlanTriageCandidates(p, cfg);
  // #40/#41/#45/#46/#47 all carry a real plan section -> not a triage target regardless of labels.
  // #42 has no plan at all and no settled label -> the one genuine candidate.
  // #43/#44 carry verify:n/a (doc-gate path, no plan expected) -> excluded.
  assert.deepEqual(
    candidates.map((i) => i.number),
    [42],
  );
});

test("#310 blindness: decomposed parents are excluded from Ready dispatch, pool eligibility, plan review, and plan triage", () => {
  const decomposedCfg = {
    ...cfg,
    labels: { ...cfg.labels, decomposed: "decomposed" },
  };
  const item = {
    itemId: "D310",
    number: 310,
    title: "tracking parent",
    state: "OPEN",
    body: "## Acceptance criteria\n- [ ] x\n\n## Verification plan\n- npm test",
    repo: "herehigher/sapwood",
    labels: ["decomposed", "plan:approved"],
    status: "Ready",
    milestone: null,
  };
  const project = { projectId: "P", statusFieldId: "F", options: [], items: [item], placements: [] };
  assert.deepEqual(selectReadyIssues(project, decomposedCfg), []);
  assert.deepEqual(selectPoolEligibleIssues(project, decomposedCfg), []);
  assert.deepEqual(selectPlanReviewCandidates(project, decomposedCfg), []);
  assert.deepEqual(selectPlanTriageCandidates({ ...project, items: [{ ...item, body: "planless" }] }, decomposedCfg), []);
});

test("selectPlanTriageCandidates: unlike selectPlanReviewCandidates, a NON-Ready-lane plan-less issue is still a candidate (triage runs before Ready, not after)", () => {
  const project = {
    projectId: "P",
    statusFieldId: "F",
    options: [],
    items: [
      {
        itemId: "I1",
        number: 99,
        title: "backlog, no plan yet",
        state: "OPEN",
        body: "just a raw idea",
        repo: "herehigher/sapwood",
        labels: [],
        status: "Todo",
        milestone: null,
      },
    ],
    placements: [],
  };
  const candidates = selectPlanTriageCandidates(project, cfg);
  assert.deepEqual(
    candidates.map((i) => i.number),
    [99],
  );
  // The same item is NOT a plan_review candidate — it isn't even in the Ready lane yet.
  assert.deepEqual(
    selectPlanReviewCandidates(project, cfg).map((i) => i.number),
    [],
  );
});

test("parseIssueLabels: extracts label names; missing/empty fields degrade to []; malformed JSON throws (fail-closed — a failed gh read must never look like 'no labels')", () => {
  assert.deepEqual(parseIssueLabels(JSON.stringify({ labels: [{ name: "a" }, { name: "b" }] })), ["a", "b"]);
  assert.deepEqual(parseIssueLabels(JSON.stringify({})), []);
  assert.deepEqual(parseIssueLabels(JSON.stringify({ labels: [] })), []);
  assert.deepEqual(parseIssueLabels(JSON.stringify({ labels: [{}, { name: "" }] })), []);
  assert.throws(() => parseIssueLabels("not json at all"), SyntaxError);
});

test("getIssueLabels: parses gh issue view --json labels, scoped to owner/repo", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ labels: [{ name: "plan:approved" }] });
  };
  assert.deepEqual(await forge.getIssueLabels(9), ["plan:approved"]);
  assert.deepEqual(seen[0]!.slice(0, 2), ["issue", "view"]);
  assert.ok(seen[0]!.includes("--json") && seen[0]!.includes("labels"));
});

test("getIssueComments: reuses parsePRComments' shape/pagination tolerance off the shared issues/<n>/comments endpoint", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([
      { body: "please fix the plan", created_at: "2026-01-01T00:00:00Z", user: { login: "verification-plan-reviewer" } },
    ]);
  };
  const comments = await forge.getIssueComments(9);
  assert.deepEqual(comments, [{ login: "verification-plan-reviewer", createdAt: "2026-01-01T00:00:00Z", body: "please fix the plan" }]);
  assert.ok(seen[0]!.some((a) => a.includes("issues/9/comments")));
  assert.ok(seen[0]!.includes("--paginate") && seen[0]!.includes("--slurp"));
});

// #652: parsePRComments/getIssueComments now surface the REST numeric comment id (stringified)
// — comment-cursor-gate.ts's cursor-target matching needs stable per-comment identity.
test("parsePRComments: carries the REST numeric id, stringified; absent id is simply omitted (never a throw)", () => {
  const r = parsePRComments(
    JSON.stringify([
      { id: 123, body: "a", created_at: "t1", user: { login: "x" } },
      { body: "b", created_at: "t2", user: { login: "y" } },
    ]),
  );
  assert.deepEqual(r, [
    { id: "123", login: "x", createdAt: "t1", body: "a" },
    { login: "y", createdAt: "t2", body: "b" },
  ]);
});

test("getAuthenticatedActor: parses `gh api user --jq .login` to the login", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "sapwood-bot\n";
  };
  assert.equal(await forge.getAuthenticatedActor(), "sapwood-bot");
  assert.deepEqual(seen[0], ["api", "user", "--jq", ".login"]);
});

test("getAuthenticatedActor: any failure (auth, network, empty output) fails closed to null, never throws", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    throw new Error("not authenticated");
  };
  assert.equal(await forge.getAuthenticatedActor(), null);

  const forge2 = new GithubForge(c);
  (forge2 as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => "";
  assert.equal(await forge2.getAuthenticatedActor(), null);
});

// ── #234: forge MCP proxy read surface — pure parsers ───────────────────────────────────────

test("parseIssueMeta: parses gh issue view --json number,title,state,labels,updatedAt,milestone", () => {
  const json = JSON.stringify({
    number: 42,
    title: "fix the thing",
    state: "OPEN",
    labels: [{ name: "bug" }, { name: "prio:1" }],
    updatedAt: "2026-07-17T00:00:00Z",
    milestone: { title: "M8" },
  });
  assert.deepEqual(parseIssueMeta(json), {
    number: 42,
    title: "fix the thing",
    state: "OPEN",
    labels: ["bug", "prio:1"],
    updatedAt: "2026-07-17T00:00:00Z",
    milestone: "M8",
  });
});

test("parseIssueMeta: no milestone -> the key is omitted, not null", () => {
  const json = JSON.stringify({ number: 1, title: "t", state: "CLOSED", labels: [], updatedAt: "x", milestone: null });
  const meta = parseIssueMeta(json);
  assert.equal(meta.state, "CLOSED");
  assert.ok(!("milestone" in meta));
});

test("#485 parseIssueMeta: MERGED reads as CLOSED; an unrecognized state still reads OPEN", () => {
  const mk = (state: string) => JSON.stringify({ number: 1, title: "t", state, labels: [], updatedAt: "x", milestone: null });
  assert.equal(parseIssueMeta(mk("MERGED")).state, "CLOSED", "a merged blocker no longer blocks");
  assert.equal(parseIssueMeta(mk("SOMETHING_NEW")).state, "OPEN", "fail-direction: noise must not read as resolved");
});

test("getIssueMeta: scoped to owner/repo, requests the right --json fields", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "x", milestone: null });
  };
  await forge.getIssueMeta(1);
  assert.deepEqual(seen[0]!.slice(0, 2), ["issue", "view"]);
  assert.ok(seen[0]!.includes("--repo") && seen[0]!.includes("o/r"));
  assert.ok(seen[0]!.some((a) => a === "number,title,state,labels,updatedAt,milestone"));
});

// Real response shape (verified live, 2026-07-17, herehigher/sapwood#217 via gh api graphql,
// re-verified with repository{nameWithOwner} added for #234 F2), with labels + repository added
// per the query this module actually sends.
const OWN_REPO = "herehigher/sapwood";
const RELATIONS_JSON = JSON.stringify({
  data: {
    repository: {
      issue: {
        closedByPullRequestsReferences: {
          nodes: [{ number: 220, title: "fix", state: "MERGED", repository: { nameWithOwner: OWN_REPO }, labels: { nodes: [] } }],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "CrossReferencedEvent",
              source: {
                __typename: "Issue",
                number: 219,
                title: "security model",
                state: "CLOSED",
                repository: { nameWithOwner: OWN_REPO },
                labels: { nodes: [{ name: "type:docs" }] },
              },
            },
            {
              __typename: "CrossReferencedEvent",
              source: {
                __typename: "PullRequest",
                number: 220,
                title: "fix",
                state: "MERGED",
                repository: { nameWithOwner: OWN_REPO },
                labels: { nodes: [] },
              },
            },
            {
              __typename: "ConnectedEvent",
              subject: {
                __typename: "Issue",
                number: 238,
                title: "doctrine",
                state: "OPEN",
                repository: { nameWithOwner: OWN_REPO },
                labels: { nodes: [{ name: "type:docs" }] },
              },
            },
          ],
        },
      },
    },
  },
});

test("parseIssueRelations: parses linked PRs + cross-references/connections (both source and subject shapes), with labels", () => {
  const r = parseIssueRelations(RELATIONS_JSON, 10, OWN_REPO);
  assert.deepEqual(r.linkedPRs, [{ number: 220, title: "fix", state: "MERGED", labels: [], kind: "pr" }]);
  assert.equal(r.crossReferences.length, 3);
  assert.deepEqual(r.crossReferences[0], { number: 219, title: "security model", state: "CLOSED", labels: ["type:docs"], kind: "issue" });
  assert.deepEqual(r.crossReferences[2], { number: 238, title: "doctrine", state: "OPEN", labels: ["type:docs"], kind: "issue" });
  assert.equal(r.truncated, false);
});

test("parseIssueRelations: hitting the cap exactly on either connection sets truncated (GraphQL first:cap gives no total count)", () => {
  const cap2 = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes: [
              { number: 1, title: "a", state: "OPEN", repository: { nameWithOwner: OWN_REPO }, labels: { nodes: [] } },
              { number: 2, title: "b", state: "OPEN", repository: { nameWithOwner: OWN_REPO }, labels: { nodes: [] } },
            ],
          },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  assert.equal(parseIssueRelations(cap2, 2, OWN_REPO).truncated, true);
});

test("parseIssueRelations: malformed/missing fields degrade to empty connections, never throw", () => {
  assert.deepEqual(parseIssueRelations(JSON.stringify({ data: {} }), 10, OWN_REPO), {
    linkedPRs: [],
    crossReferences: [],
    truncated: false,
  });
});

// ── #234 F2 (PR #252 review, P1, Codex #1): foreign-repo relations must never be disclosed ───

test("parseIssueRelations: a linked PR from a FOREIGN repo (repository.nameWithOwner mismatch) is dropped, never returned", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 99,
                title: "a foreign fix",
                state: "MERGED",
                repository: { nameWithOwner: "someone-else/private-repo" },
                labels: { nodes: [] },
              },
              { number: 220, title: "our fix", state: "MERGED", repository: { nameWithOwner: OWN_REPO }, labels: { nodes: [] } },
            ],
          },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  const r = parseIssueRelations(json, 10, OWN_REPO);
  assert.deepEqual(r.linkedPRs, [{ number: 220, title: "our fix", state: "MERGED", labels: [], kind: "pr" }]);
  assert.ok(!r.linkedPRs.some((p) => p.number === 99), "the foreign-repo PR's title/labels must never leak through this channel");
});

test("parseIssueRelations: a foreign-repo cross-reference (both an Issue source and a PullRequest source shape) is dropped, never returned", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: { nodes: [] },
          timelineItems: {
            nodes: [
              {
                __typename: "CrossReferencedEvent",
                source: {
                  __typename: "Issue",
                  number: 1,
                  title: "a private repo's secret issue title",
                  state: "OPEN",
                  repository: { nameWithOwner: "someone-else/private-repo" },
                  labels: { nodes: [{ name: "confidential" }] },
                },
              },
              {
                __typename: "CrossReferencedEvent",
                source: {
                  __typename: "PullRequest",
                  number: 2,
                  title: "a private repo's secret PR title",
                  state: "OPEN",
                  repository: { nameWithOwner: "someone-else/private-repo" },
                  labels: { nodes: [] },
                },
              },
              {
                __typename: "ConnectedEvent",
                subject: {
                  __typename: "Issue",
                  number: 219,
                  title: "our own issue",
                  state: "CLOSED",
                  repository: { nameWithOwner: OWN_REPO },
                  labels: { nodes: [] },
                },
              },
            ],
          },
        },
      },
    },
  });
  const r = parseIssueRelations(json, 10, OWN_REPO);
  assert.deepEqual(r.crossReferences, [{ number: 219, title: "our own issue", state: "CLOSED", labels: [], kind: "issue" }]);
  assert.ok(
    !r.crossReferences.some((c) => c.number === 1 || c.number === 2),
    "neither the foreign issue nor the foreign PR's title/labels may leak through this channel",
  );
});

test("parseIssueRelations: a node with NO repository field at all is treated as foreign (fail-closed, never assumed same-repo)", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: { nodes: [{ number: 1, title: "no repo field", state: "OPEN", labels: { nodes: [] } }] },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  assert.deepEqual(parseIssueRelations(json, 10, OWN_REPO).linkedPRs, []);
});

// #234 F2b (PR #252 review round 2, P2, Codex new finding): the repo comparison must be
// case-INSENSITIVE — GitHub's own `nameWithOwner` casing need not match whatever casing an
// operator typed into config, and an exact-match comparison would silently drop every same-repo
// relation on a casing mismatch (an availability regression, not a security property).
test("parseIssueRelations: a SAME-repo node whose nameWithOwner casing differs from the configured value is RETAINED (case-insensitive compare); a genuinely foreign-repo node is still dropped", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes: [
              // Differently-cased same repo — GitHub's actual casing vs. whatever the operator typed.
              {
                number: 220,
                title: "our fix, differently-cased repo",
                state: "MERGED",
                repository: { nameWithOwner: "HereHigher/Sapwood" },
                labels: { nodes: [] },
              },
              {
                number: 99,
                title: "a foreign fix",
                state: "MERGED",
                repository: { nameWithOwner: "someone-else/private-repo" },
                labels: { nodes: [] },
              },
            ],
          },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  // OWN_REPO ("herehigher/sapwood") is all-lowercase; GraphQL's node carries the
  // differently-cased "HereHigher/Sapwood" above — a real-world casing mismatch.
  const r = parseIssueRelations(json, 10, OWN_REPO);
  assert.deepEqual(r.linkedPRs, [{ number: 220, title: "our fix, differently-cased repo", state: "MERGED", labels: [], kind: "pr" }]);
  assert.ok(!r.linkedPRs.some((p) => p.number === 99), "the genuinely foreign-repo PR is still dropped");
});

test("parseIssueRelations: truncation is judged on the RAW (pre-filter) node count, never under-reported because a filter shrank the visible count", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes: [
              { number: 1, title: "foreign", state: "OPEN", repository: { nameWithOwner: "other/repo" }, labels: { nodes: [] } },
              { number: 2, title: "foreign too", state: "OPEN", repository: { nameWithOwner: "other/repo" }, labels: { nodes: [] } },
            ],
          },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  const r = parseIssueRelations(json, 2, OWN_REPO);
  assert.deepEqual(r.linkedPRs, [], "both raw nodes were foreign and filtered out");
  assert.equal(r.truncated, true, "2 raw nodes hit the cap of 2, so truncation must still be flagged even though 0 survived the filter");
});

test("getIssueRelations: passes owner/repo/number/cap through the query variables", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return RELATIONS_JSON;
  };
  await forge.getIssueRelations(217, 10);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o"));
  assert.ok(args.includes("repo=r"));
  assert.ok(args.includes("number=217"));
  assert.ok(args.includes("cap=10"));
});

test("getIssueRelations: threads THIS forge's own owner/repo (never the caller's) as the foreign-repo filter — a fixture scoped to a DIFFERENT repo returns nothing", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => RELATIONS_JSON; // scoped to herehigher/sapwood
  const relations = await forge.getIssueRelations(217, 10);
  assert.deepEqual(relations.linkedPRs, [], "RELATIONS_JSON's nodes belong to a different repo than o/r — none may surface");
  assert.deepEqual(relations.crossReferences, []);
});

test("parseSearchIssues: parses gh search issues --json output", () => {
  const json = JSON.stringify([
    { number: 244, title: "extends #234", state: "open", labels: [{ name: "type:feature" }], updatedAt: "2026-07-17T06:43:00Z" },
  ]);
  assert.deepEqual(parseSearchIssues(json), [
    { number: 244, title: "extends #234", state: "open", labels: ["type:feature"], updatedAt: "2026-07-17T06:43:00Z" },
  ]);
});

test("searchIssues: scopes the query to --repo owner/repo (never caller-controlled) and applies --limit cap; every flag precedes a `--` terminator, with the query strictly after it", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "[]";
  };
  await forge.searchIssues("is:open flaky", 5);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["search", "issues"]);
  assert.ok(args.includes("--repo") && args.includes("o/r"));
  assert.ok(args.includes("--limit") && args.includes("5"));
  const termIdx = args.indexOf("--");
  assert.ok(termIdx !== -1, "a `--` terminator must separate flags from the query");
  assert.deepEqual(args.slice(termIdx + 1), ["is:open flaky"], "the query is the ONLY token after `--`");
  assert.ok(!args.slice(0, termIdx).includes("is:open flaky"), "the query never appears before the terminator");
});

test("searchIssues: an ADVERSARIAL query shaped like a flag (--repo=x/y, --limit=999) lands as a positional token after `--`, never parsed as a flag by gh's pflag (#234 F1, PR #252 review — reproduced live: a caller-controlled --repo token previously escaped the forced repo scope)", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "[]";
  };
  const adversarial = "--repo=other-owner/other-repo --owner=someone-else --limit=999";
  await forge.searchIssues(adversarial, 5);
  const args = seen[0]!;
  const termIdx = args.indexOf("--");
  assert.ok(termIdx !== -1);
  // Exactly one --repo (ours) and one --limit (ours) appear BEFORE the terminator; the
  // adversarial query's own --repo/--owner/--limit-shaped text is inert positional data after it.
  const beforeTerm = args.slice(0, termIdx);
  assert.deepEqual(
    beforeTerm.filter((a) => a === "--repo"),
    ["--repo"],
  );
  assert.equal(beforeTerm[beforeTerm.indexOf("--repo") + 1], "o/r", "the forced scope, never the caller's");
  assert.deepEqual(
    beforeTerm.filter((a) => a === "--limit"),
    ["--limit"],
  );
  assert.equal(beforeTerm[beforeTerm.indexOf("--limit") + 1], "5", "the server's own cap, never the caller's 999");
  assert.deepEqual(args.slice(termIdx + 1), [adversarial], "the adversarial text is the query, verbatim, and nothing else");
});

// ─────────────────────────────────────────────────────────────────────────────
// #244: PR-facing forge MCP proxy read surface (extends #234) — parsePRDetails/
// parsePRReviewsPage/parsePRChecksPage/parsePRReviewThreadsPage/fetchAllReviewThreads + the 4
// new IForge methods. #260 review: getPRReviews/getPRReviewThreads/getPRChecks are now CAPPED
// GraphQL reads (never the previous unbounded `gh pr view --json ...`).
// ─────────────────────────────────────────────────────────────────────────────

test("parsePRDetails: parses gh pr view --json number,headRefOid,baseRefName,state,isDraft,labels,mergeable", () => {
  const json = JSON.stringify({
    number: 42,
    headRefOid: "abc123",
    baseRefName: "develop",
    state: "OPEN",
    isDraft: true,
    labels: [{ name: "type:feature" }],
    mergeable: "MERGEABLE",
  });
  assert.deepEqual(parsePRDetails(json), {
    number: 42,
    headOid: "abc123",
    baseRefName: "develop",
    state: "OPEN",
    draft: true,
    labels: ["type:feature"],
    mergeable: "MERGEABLE",
  });
});

test("parsePRDetails: CLOSED/MERGED pass through, an unrecognized state normalizes to OPEN", () => {
  const closed = JSON.parse('{"number":1,"headRefOid":"x","state":"CLOSED","isDraft":false,"mergeable":"UNKNOWN"}');
  assert.equal(parsePRDetails(JSON.stringify(closed)).state, "CLOSED");
  const merged = JSON.parse('{"number":1,"headRefOid":"x","state":"MERGED","isDraft":false,"mergeable":"UNKNOWN"}');
  assert.equal(parsePRDetails(JSON.stringify(merged)).state, "MERGED");
});

test("parsePRDetails: mergeable normalizes an unrecognized value to UNKNOWN; missing labels/baseRefName degrade to []/empty", () => {
  const d = parsePRDetails(JSON.stringify({ number: 1, headRefOid: "x", state: "OPEN", isDraft: false, mergeable: "WEIRD" }));
  assert.equal(d.mergeable, "UNKNOWN");
  assert.deepEqual(d.labels, []);
  assert.equal(d.baseRefName, "");
});

test("getPRDetails: scoped to owner/repo, requests the right --json fields", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({
      number: 1,
      headRefOid: "x",
      baseRefName: "develop",
      state: "OPEN",
      isDraft: false,
      labels: [],
      mergeable: "MERGEABLE",
    });
  };
  await forge.getPRDetails(1);
  assert.deepEqual(seen[0]!.slice(0, 2), ["pr", "view"]);
  assert.ok(seen[0]!.includes("--repo") && seen[0]!.includes("o/r"));
  assert.ok(seen[0]!.some((a) => a === "number,headRefOid,baseRefName,state,isDraft,labels,mergeable"));
});

test("parsePRReviewsPage: parses author/commitOid/state/body/submittedAt verbatim + totalCount, missing fields degrade to defaults", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            totalCount: 2,
            nodes: [
              {
                author: { login: "codex" },
                commit: { oid: "HEAD1" },
                state: "APPROVED",
                body: "LGTM",
                submittedAt: "2026-07-18T00:00:00Z",
              },
              { state: "COMMENTED" }, // missing author/commit/body/submittedAt
            ],
          },
        },
      },
    },
  });
  const page = parsePRReviewsPage(json);
  assert.equal(page.total, 2);
  assert.deepEqual(page.reviews, [
    { author: "codex", commitOid: "HEAD1", state: "APPROVED", body: "LGTM", submittedAt: "2026-07-18T00:00:00Z" },
    { author: "", commitOid: "", state: "COMMENTED", body: "" },
  ]);
});

test("parsePRReviewsPage: no reviews connection -> empty reviews, total 0", () => {
  assert.deepEqual(parsePRReviewsPage(JSON.stringify({})), { reviews: [], total: 0 });
});

test("getPRReviews: scoped to owner/repo, GraphQL reviews(last: cap) with owner/repo/number/cap variables", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { repository: { pullRequest: { reviews: { totalCount: 0, nodes: [] } } } } });
  };
  await forge.getPRReviews(7, 25);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o"));
  assert.ok(args.includes("repo=r"));
  assert.ok(args.includes("number=7"));
  assert.ok(args.includes("cap=25"));
});

test("parsePRChecksPage: CheckRun entries carry conclusion, legacy StatusContext entries carry state, never merged, plus totalCount", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 3,
                      nodes: [
                        { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
                        { context: "legacy-ci", state: "PENDING" },
                        { conclusion: null }, // in-progress CheckRun, no name at all
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  const page = parsePRChecksPage(json);
  assert.equal(page.total, 3);
  // #287 (E4b): appSlug is null on every entry here — none of these fixture nodes carry a
  // checkSuite.app.slug (the first has none in the fixture, the legacy StatusContext and the
  // in-progress CheckRun structurally never do). See the dedicated appSlug tests below.
  assert.deepEqual(page.checks, [
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: null },
    { name: "legacy-ci", status: "", conclusion: null, state: "PENDING", appSlug: null },
    { name: "", status: "", conclusion: null, state: null, appSlug: null },
  ]);
});

test("parsePRChecksPage: no statusCheckRollup/commits -> empty checks, total 0", () => {
  assert.deepEqual(parsePRChecksPage(JSON.stringify({})), { checks: [], total: 0 });
  assert.deepEqual(
    parsePRChecksPage(
      JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } } }),
    ),
    { checks: [], total: 0 },
  );
});

test("parsePRChecksPage (#287, E4b): checkSuite.app.slug becomes PRCheckItem.appSlug on a CheckRun node; a StatusContext node never has one (null)", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 2,
                      nodes: [
                        { name: "test", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { app: { slug: "github-actions" } } },
                        { context: "legacy-ci", state: "SUCCESS" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  const page = parsePRChecksPage(json);
  assert.deepEqual(page.checks, [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" },
    { name: "legacy-ci", status: "", conclusion: null, state: "SUCCESS", appSlug: null },
  ]);
});

test("getPRChecks: scoped to owner/repo, GraphQL contexts(first: cap) with owner/repo/number/cap variables", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({});
  };
  await forge.getPRChecks(3, 40);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o"));
  assert.ok(args.includes("repo=r"));
  assert.ok(args.includes("number=3"));
  assert.ok(args.includes("cap=40"));
});

// ─────────────────────────────────────────────────────────────────────────────
// #502: the base-branch check-status read — getPRChecks' capped-contexts shape, keyed on the
// DEFAULT BRANCH's HEAD commit instead of a PR number.
// ─────────────────────────────────────────────────────────────────────────────

test("parseDefaultBranchChecksPage: parses the default branch name, its HEAD oid and the capped rollup contexts", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        defaultBranchRef: {
          name: "main",
          target: {
            oid: "a1c0ffee",
            statusCheckRollup: {
              contexts: {
                totalCount: 2,
                nodes: [
                  { name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { app: { slug: "github-actions" } } },
                  { context: "legacy-ci", state: "SUCCESS" },
                ],
              },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(parseDefaultBranchChecksPage(json), {
    branch: "main",
    headOid: "a1c0ffee",
    checks: [
      { name: "test", status: "COMPLETED", conclusion: "FAILURE", state: null, appSlug: "github-actions" },
      { name: "legacy-ci", status: "", conclusion: null, state: "SUCCESS", appSlug: null },
    ],
    total: 2,
  });
});

test("parseDefaultBranchChecksPage: a missing ref / non-Commit target / absent rollup degrades to an EMPTY page — never a throw, never a fabricated red", () => {
  assert.deepEqual(parseDefaultBranchChecksPage(JSON.stringify({ data: { repository: {} } })), {
    branch: "",
    headOid: "",
    checks: [],
    total: 0,
  });
  const noRollup = JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "a1" } } } } });
  assert.deepEqual(parseDefaultBranchChecksPage(noRollup), { branch: "main", headOid: "a1", checks: [], total: 0 });
});

test("getDefaultBranchChecks: scoped to owner/repo, GraphQL contexts(first: cap) — capped exactly like getPRChecks, and carries NO pr number", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({});
  };
  await forge.getDefaultBranchChecks(40);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o"));
  assert.ok(args.includes("repo=r"));
  assert.ok(args.includes("cap=40"));
  assert.ok(!args.some((a) => a.startsWith("number=")), "ref-scoped, not PR-scoped");
  assert.match(args.join(" "), /contexts\(first: \$cap\)/, "bounded contexts — no unbounded read");
});

test("parsePRReviewThreadsPage: parses threads + their own comments + per-thread commentsComplete, tolerates malformed/missing pageInfo", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            nodes: [
              {
                id: "T1",
                isResolved: false,
                comments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false },
                  nodes: [{ author: { login: "codex" }, body: "fix this", createdAt: "2026-07-18T00:00:00Z" }],
                },
              },
              {
                id: "T2",
                isResolved: true,
                comments: { totalCount: 5, pageInfo: { hasNextPage: true }, nodes: [] }, // more comments than fetched -> incomplete
              },
            ],
          },
        },
      },
    },
  });
  const page = parsePRReviewThreadsPage(json);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, "CUR1");
  assert.deepEqual(page.threads, [
    {
      id: "T1",
      isResolved: false,
      comments: [{ author: "codex", body: "fix this", createdAt: "2026-07-18T00:00:00Z" }],
      commentsComplete: true,
    },
    { id: "T2", isResolved: true, comments: [], commentsComplete: false },
  ]);
});

test("parsePRReviewThreadsPage: malformed/absent response -> empty threads, terminal (no infinite loop)", () => {
  const page = parsePRReviewThreadsPage(JSON.stringify({ data: {} }));
  assert.deepEqual(page.threads, []);
  assert.equal(page.hasNextPage, false);
  assert.equal(page.endCursor, null);
});

test("fetchAllReviewThreads: pages to exhaustion across a multi-page connection (Codex PR #42 P2 rationale — a first-page-only fetch could miss a later thread), pageCapped false", async () => {
  let calls = 0;
  const page1 = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            nodes: [{ id: "T1", isResolved: false, comments: { nodes: [] } }],
          },
        },
      },
    },
  });
  const page2 = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "T2", isResolved: true, comments: { nodes: [] } }],
          },
        },
      },
    },
  });
  const { threads, pageCapped } = await fetchAllReviewThreads(async (after) => {
    calls++;
    return after === null ? page1 : page2;
  });
  assert.equal(calls, 2);
  assert.equal(pageCapped, false);
  assert.deepEqual(
    threads.map((t) => t.id),
    ["T1", "T2"],
  );
});

test("fetchAllReviewThreads: a page ceiling (50 pages) bounds a runaway cursor, never spins forever, and reports pageCapped: true", async () => {
  let calls = 0;
  const { threads, pageCapped } = await fetchAllReviewThreads(async () => {
    calls++;
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: `CUR${calls}` },
              nodes: [{ id: `T${calls}`, isResolved: false, comments: { nodes: [] } }],
            },
          },
        },
      },
    });
  });
  assert.equal(calls, 50);
  assert.equal(threads.length, 50);
  assert.equal(pageCapped, true, "the hard 50-page ceiling was hit while hasNextPage was still true");
});

test("getPRReviewThreads: threads owner/repo/number/commentsCap through the GraphQL query variables", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: {}, nodes: [] } } } } });
  };
  await forge.getPRReviewThreads(9, 15);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("owner=o"));
  assert.ok(args.includes("repo=r"));
  assert.ok(args.includes("number=9"));
  assert.ok(args.includes("commentsCap=15"));
  assert.ok(args.includes("after=null"));
});

test("#288 getPRComments is a bounded newest-comments GraphQL read and preserves opaque receipt ids", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  let seen: string[] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen = args;
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: { comments: { totalCount: 1, nodes: [{ id: "IC1", author: { login: "bot" }, createdAt: "t", body: "audit" }] } },
        },
      },
    });
  };
  assert.deepEqual(await forge.getPRComments(9, 20), { comments: [{ id: "IC1", login: "bot", createdAt: "t", body: "audit" }], total: 1 });
  assert.ok(seen.includes("number=9"));
  assert.ok(seen.includes("cap=20"));
  assert.deepEqual(parsePRCommentsPage(JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [] } } } } })), {
    comments: [],
    total: 0,
  });
});

// ── #247: fix-loop write methods — reply to / resolve a review thread ──────────────────────

test("replyToReviewThread: posts the mutation with the exact threadId + body — no owner/repo/number variable at all (threadId is opaque, not addressable through repo scope)", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "C1" } } } });
  };
  await forge.replyToReviewThread("THREAD_1", "fixed as suggested");
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("threadId=THREAD_1"));
  assert.ok(args.includes("body=fixed as suggested"));
  assert.ok(!args.some((a) => a.startsWith("owner=") || a.startsWith("repo=") || a.startsWith("number=")));
});

test("resolveReviewThread: resolves the mutation with the exact threadId", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { resolveReviewThread: { thread: { id: "THREAD_1", isResolved: true } } } });
  };
  await forge.resolveReviewThread("THREAD_1");
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("threadId=THREAD_1"));
});

test("getReviewThreadCommentsTail (#247 F2(b)): reads via node(id:) with `last: cap` — no owner/repo/pr variable, scoped to the thread's own opaque id", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { node: { comments: { nodes: [{ body: "old" }, { body: "newest — has the marker" }] } } } });
  };
  const bodies = await forge.getReviewThreadCommentsTail("THREAD_1", 2);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.ok(args.includes("threadId=THREAD_1"));
  assert.ok(args.includes("cap=2"));
  assert.ok(!args.some((a) => a.startsWith("owner=") || a.startsWith("repo=") || a.startsWith("pr=")));
  assert.deepEqual(bodies, ["old", "newest — has the marker"]);
});

test("parseReviewThreadCommentsTail: a vanished/malformed node degrades to an empty array, never throws on a well-formed-but-absent shape", () => {
  const bodies = parseReviewThreadCommentsTail(JSON.stringify({ data: { node: null } }));
  assert.deepEqual(bodies, []);
});

// ── #237 finding 2 (2026-07-18 adjudication on PR #262): every issue comment this engine posts
// is centrally stamped, regardless of whether the call site embeds its own marker ───────────

test("addIssueComment: every posted body is stamped with ENGINE_COMMENT_MARKER at the write boundary, appended AFTER any call-site-specific marker", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "";
  };
  await forge.addIssueComment(42, "a plain body with no marker of its own");
  const bodyIdx = seen[0]!.indexOf("--body");
  assert.ok(bodyIdx >= 0);
  const posted = seen[0]![bodyIdx + 1]!;
  assert.ok(posted.startsWith("a plain body with no marker of its own"));
  assert.ok(posted.includes(ENGINE_COMMENT_MARKER), "the generic engine stamp is always appended");
});

test("addIssueComment: a body that ALREADY carries its own specific sapwood marker still gets the generic stamp too — both survive", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "";
  };
  const specificMarker = "<!-- sapwood:concern:42:abc123 -->";
  await forge.addIssueComment(42, `PO dissent\n\n${specificMarker}`);
  const bodyIdx = seen[0]!.indexOf("--body");
  const posted = seen[0]![bodyIdx + 1]!;
  assert.ok(posted.includes(specificMarker));
  assert.ok(posted.includes(ENGINE_COMMENT_MARKER));
});

// ── #377 (F15): the PR-OWNER MARKER contract — a NET-NEW structural block (no PR-body marker
// of any kind existed in this codebase before it), and the lane->PR association keyed on it.
// The live failure it replaces: lane-294's reclaim adopted retro PR #368 because that PR's
// PROSE said "#294", while the lane's own pushed branch sat PR-less. ────────────────────────

test("readPrOwner: adversarial prose-only bodies never satisfy the marker (bare mention, code fence, link, closing keyword)", () => {
  for (const body of [
    "Part of #294",
    "Fixes #294",
    "Closes: #294",
    "see [#294](https://github.com/o/r/issues/294)",
    "```\nsapwood:pr-owner issue 294\n```",
    "retro digest for round 7 — touched #294, #295",
    "",
  ]) {
    assert.equal(readPrOwner(body), null, body);
  }
});

test("readPrOwner: reads back exactly what prOwnerMarker writes", () => {
  const marker = prOwnerMarker("lane-294-a1b2c3d4", 294);
  assert.deepEqual(readPrOwner(`## Why\n\nFixes #294\n\n${marker}\n`), { lane: "lane-294-a1b2c3d4", issue: 294 });
});

test("readPrOwner: two DISAGREEING markers in one body -> null (ambiguous ownership is never guessed)", () => {
  const body = `${prOwnerMarker("lane-294-aaaaaaaa", 294)}\n${prOwnerMarker("lane-999-bbbbbbbb", 999)}`;
  assert.equal(readPrOwner(body), null);
  // ...but a duplicate of the SAME marker (a double stamp) is unambiguous.
  const dup = `${prOwnerMarker("lane-294-aaaaaaaa", 294)}\n${prOwnerMarker("lane-294-aaaaaaaa", 294)}`;
  assert.deepEqual(readPrOwner(dup), { lane: "lane-294-aaaaaaaa", issue: 294 });
});

test("prOwnerMarker: refuses a lane name that could not be read back verbatim (trust-boundary check)", () => {
  for (const lane of ['a" issue="1', "lane 294", "lane<294>", ""]) {
    assert.throws(() => prOwnerMarker(lane, 294), /lane name/, lane);
  }
});

test("stampPrOwner: appends once and is idempotent (re-stamping an already-marked body is a no-op)", () => {
  const once = stampPrOwner("## Why\n\nFixes #294", "lane-294-a1b2c3d4", 294);
  assert.ok(once.includes(prOwnerMarker("lane-294-a1b2c3d4", 294)));
  assert.equal(stampPrOwner(once, "lane-294-a1b2c3d4", 294), once);
  assert.ok(once.startsWith("## Why\n\nFixes #294"), "the human-facing body (including its closing keyword) is preserved verbatim");
});

test("findLaneOwnedPr: another lane's marker-bearing PR mentioning this issue in prose is NEVER adopted", () => {
  const prs = [
    { number: 368, body: `retro digest touching #294\n\n${prOwnerMarker("lane-368-ffffffff", 368)}` },
    { number: 372, body: `Closes #294\n\n${prOwnerMarker("lane-294-a1b2c3d4", 294)}` },
  ];
  assert.equal(findLaneOwnedPr(prs, "lane-294-a1b2c3d4", 294), 372);
  assert.equal(findLaneOwnedPr(prs, "lane-294-deadbeef", 294), null, "a DIFFERENT lane on the same issue gets nothing");
  assert.equal(findLaneOwnedPr([{ number: 368, body: "Fixes #294" }], "lane-294-a1b2c3d4", 294), null, "prose alone is never enough");
});

// ── #377: associateLanePr — the branch-keyed, marker-keyed association itself ────────────────

type FakeCall = { kind: string; args: unknown[] };

function fakeLanePrForge(
  prs: { number: number; body: string; branch?: string; title?: string }[],
  opts: { branches?: string[]; nextPr?: number } = {},
) {
  const calls: FakeCall[] = [];
  const forge = {
    calls,
    prs,
    async listOpenPrsForBranch(branch: string) {
      calls.push({ kind: "listOpenPrsForBranch", args: [branch] });
      return prs
        .filter((pr) => pr.branch === branch)
        .map((pr) => ({ number: pr.number, body: pr.body, ...(pr.title !== undefined ? { title: pr.title } : {}) }));
    },
    async listOpenPrBodies() {
      calls.push({ kind: "listOpenPrBodies", args: [] });
      return prs.map((pr) => ({ number: pr.number, body: pr.body, ...(pr.title !== undefined ? { title: pr.title } : {}) }));
    },
    async updatePRBody(pr: number, body: string) {
      calls.push({ kind: "updatePRBody", args: [pr, body] });
      const target = prs.find((p) => p.number === pr)!;
      target.body = body;
    },
    async openPR(branch: string, title: string, body: string) {
      calls.push({ kind: "openPR", args: [branch, title, body] });
      const number = opts.nextPr ?? 500;
      prs.push({ number, body, branch });
      return number;
    },
    async probePushedBranch(branch: string): Promise<"present" | "absent" | "unknown"> {
      calls.push({ kind: "probePushedBranch", args: [branch] });
      return (opts.branches ?? []).includes(branch) ? "present" : "absent";
    },
    async getIssueMeta(issue: number) {
      calls.push({ kind: "getIssueMeta", args: [issue] });
      return { number: issue, title: `issue ${issue} title`, state: "OPEN" as const, labels: [], updatedAt: "2026-07-24T00:00:00Z" };
    },
  };
  return forge;
}

test("associateLanePr (a): the branch's PR already carries THIS lane's marker -> associated, no write", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: prOwnerMarker("lane-294-a1b2c3d4", 294), branch: "feat/294-hold" }]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, 372);
  assert.deepEqual(
    forge.calls.map((c) => c.kind),
    ["listOpenPrsForBranch"],
  );
});

test("associateLanePr (b): the branch has an UNMARKED PR -> the engine patches the body, then associates", async () => {
  // sessionOver: gate② round 5 moved the STAMP behind it too (it was previously ungated, on the
  // reasoning that only `openPR` could race the worker) — an unconditional read-modify-write
  // against a live PR body can drop a concurrent description edit. AC#3's behavior is unchanged
  // in substance: the engine, never a worker prompt, authors the marker onto the branch's PR.
  const forge = fakeLanePrForge([{ number: 372, body: "## Why\n\nCloses #294", branch: "feat/294-hold" }]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, 372);
  const patch = forge.calls.find((c) => c.kind === "updatePRBody");
  assert.ok(patch, "the engine authored the marker itself (never a worker-prompt instruction)");
  assert.deepEqual(readPrOwner(patch.args[1] as string), { lane: "lane-294-a1b2c3d4", issue: 294 });
  assert.ok((patch.args[1] as string).includes("Closes #294"), "the worker's own description survives the patch");
});

test("associateLanePr (c): the branch is pushed with NO PR -> the engine opens one carrying the marker", async () => {
  const forge = fakeLanePrForge([], { branches: ["feat/294-hold"], nextPr: 372 });
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, 372);
  const opened = forge.calls.find((c) => c.kind === "openPR");
  assert.ok(opened);
  assert.equal(opened.args[0], "feat/294-hold");
  const body = opened.args[2] as string;
  assert.deepEqual(readPrOwner(body), { lane: "lane-294-a1b2c3d4", issue: 294 });
  assert.ok(body.includes("Closes #294"), "GitHub's own closing-keyword semantics are still written for humans");
});

test("associateLanePr (c'): a branch that is not pushed to the forge -> nothing opened, no association", async () => {
  const forge = fakeLanePrForge([], { branches: [] });
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, null);
  assert.equal(forge.calls.filter((c) => c.kind === "openPR").length, 0);
});

test("associateLanePr: sessionOver=false (the lane's worker is still running) -> the engine never opens a PR that would race it", async () => {
  const forge = fakeLanePrForge([], { branches: ["feat/294-hold"], nextPr: 372 });
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: false });
  assert.equal(pr.pr, null);
  assert.equal(forge.calls.filter((c) => c.kind === "openPR").length, 0);
});

test("associateLanePr (d): the branch's PR carries a DIFFERENT lane's marker -> never adopted, never re-stamped", async () => {
  const forge = fakeLanePrForge([
    { number: 368, body: `#294 mentioned\n\n${prOwnerMarker("lane-368-ffffffff", 368)}`, branch: "feat/294-hold" },
  ]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, null);
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0);
});

test("associateLanePr: no branch known (the lane's worktree is gone) -> marker scan only, prose never matches", async () => {
  const forge = fakeLanePrForge([
    { number: 368, body: "retro digest mentioning #294" },
    { number: 372, body: `Closes #294\n\n${prOwnerMarker("lane-294-a1b2c3d4", 294)}` },
  ]);
  assert.equal((await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: null, sessionOver: true })).pr, 372);
  const proseOnly = fakeLanePrForge([{ number: 368, body: "Fixes #294" }]);
  assert.equal((await associateLanePr(proseOnly, { name: "lane-294-a1b2c3d4", issue: 294, branch: null, sessionOver: true })).pr, null);
});

test("#377 F15 regression: a prose-only PR citing the issue coexists with the lane's pushed, unPRed branch -> the engine lands on the BRANCH's PR, never the prose PR", async () => {
  // The live 2026-07-24 case: retro PR #368's body mentioned "#294"; lane-294's real branch
  // (feat/294-hold-visibility-events) was pushed with no PR of its own. The old prose match
  // adopted #368 and shepherded someone else's PR through review.
  const forge = fakeLanePrForge([{ number: 368, body: "Round 7 retro digest — covers #294 and #295" }], {
    branches: ["feat/294-hold-visibility-events"],
    nextPr: 372,
  });
  const pr = await associateLanePr(forge, {
    name: "lane-294-a1b2c3d4",
    issue: 294,
    branch: "feat/294-hold-visibility-events",
    sessionOver: true,
  });
  assert.equal(pr.pr, 372, "the engine opened the lane's OWN PR");
  assert.notEqual(pr.pr, 368);
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0, "the unrelated PR's body is never touched");
});

// ── #377 gate② round 3 (P1): a forge WRITE failure is INCONCLUSIVE, never "no PR" ───────────
// mayOpenPr is true only once the lane is terminal/confirmed-dead — the same probe the
// conductor SETTLES the lane from. Collapsing a transient openPR/updatePRBody failure into a
// definitive `null` therefore escalated finished work, or requeued a dead lane onto a fresh
// worker while its pushed branch sat there. The outcome now carries that distinction.

test("associateLanePr (gate② round 3, P1): openPR throwing is INCONCLUSIVE, not 'no PR' — the pushed branch stays retryable", async () => {
  const forge = fakeLanePrForge([], { branches: ["feat/294-hold"], nextPr: 372 });
  forge.openPR = async () => {
    throw new Error("gh pr create: 502 Bad Gateway");
  };
  const logs: string[] = [];
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true }, (line) =>
    logs.push(line),
  );
  assert.deepEqual(out, { pr: null, inconclusive: true });
  assert.ok(logs.some((l) => l.includes("502")));
});

test("associateLanePr (gate② round 3, P1): updatePRBody throwing is INCONCLUSIVE too — the branch's PR exists, we just could not claim it yet", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: "Closes #294", branch: "feat/294-hold" }]);
  forge.updatePRBody = async () => {
    throw new Error("gh pr edit: 403");
  };
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.deepEqual(out, { pr: null, inconclusive: true });
});

test("associateLanePr (gate② round 3, P1): a DEFINITIVE no-association is conclusive — never mistaken for a forge failure", async () => {
  // Each of these is a real answer about the world, not a failed write: nothing to retry.
  const unpushed = await associateLanePr(fakeLanePrForge([], { branches: [] }), {
    name: "lane-294-a1b2c3d4",
    issue: 294,
    branch: "feat/294-hold",
    sessionOver: true,
  });
  assert.deepEqual(unpushed, { pr: null, inconclusive: false }, "branch not on the forge");

  const contested = await associateLanePr(
    fakeLanePrForge([{ number: 368, body: prOwnerMarker("lane-368-ffffffff", 368), branch: "feat/294-hold" }]),
    { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true },
  );
  assert.deepEqual(contested, { pr: null, inconclusive: false }, "another lane's PR");

  const stillRunning = await associateLanePr(fakeLanePrForge([], { branches: ["feat/294-hold"] }), {
    name: "lane-294-a1b2c3d4",
    issue: 294,
    branch: "feat/294-hold",
    sessionOver: false,
  });
  assert.deepEqual(stillRunning, { pr: null, inconclusive: false }, "not yet allowed to open one");

  const found = await associateLanePr(
    fakeLanePrForge([{ number: 372, body: prOwnerMarker("lane-294-a1b2c3d4", 294), branch: "feat/294-hold" }]),
    { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true },
  );
  assert.deepEqual(found, { pr: 372, inconclusive: false });
});

// ── #595 (redo of #365 against the #425 registry): LanePrOutcome.title rides whichever open-PR
// list read already resolved the association — never a new forge call. ─────────────────────────

test("associateLanePr (#595, a): the branch's PR already carries this lane's marker -> title comes from that SAME listOpenPrsForBranch read", async () => {
  const forge = fakeLanePrForge([
    { number: 372, title: "feat: the lane's own PR", body: prOwnerMarker("lane-294-a1b2c3d4", 294), branch: "feat/294-hold" },
  ]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(out.pr, 372);
  assert.equal(out.title, "feat: the lane's own PR");
});

test("associateLanePr (#595, b): stamp-and-adopt carries the sole candidate's title too", async () => {
  const forge = fakeLanePrForge([{ number: 372, title: "fix: the lane's PR", body: "## Why\n\nCloses #294", branch: "feat/294-hold" }]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(out.pr, 372);
  assert.equal(out.title, "fix: the lane's PR");
});

test("associateLanePr (#595, c): the engine-opened PR's title is the issue title it opened with (getIssueMeta), not a forge re-read", async () => {
  const forge = fakeLanePrForge([], { branches: ["feat/294-hold"], nextPr: 372 });
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(out.pr, 372);
  assert.equal(out.title, "issue 294 title");
  assert.equal(forge.calls.filter((c) => c.kind === "listOpenPrsForBranch" || c.kind === "listOpenPrBodies").length, 1);
});

test("associateLanePr (#595): marker-scan fallback (no branch known) also carries the matched PR's title", async () => {
  const forge = fakeLanePrForge([
    { number: 368, body: "retro digest mentioning #294" },
    { number: 372, title: "feat: reclaimed lane's PR", body: `Closes #294\n\n${prOwnerMarker("lane-294-a1b2c3d4", 294)}` },
  ]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: null, sessionOver: true });
  assert.equal(out.pr, 372);
  assert.equal(out.title, "feat: reclaimed lane's PR");
});

test("associateLanePr (#595): a PR with no title in the forge's response omits `title` from the outcome, never null", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: prOwnerMarker("lane-294-a1b2c3d4", 294), branch: "feat/294-hold" }]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(out.pr, 372);
  assert.equal(out.title, undefined);
  assert.ok(!Object.hasOwn(out, "title"));
});

test("associateLanePr: a failed engine-side write degrades visibly (logged) instead of throwing out of probe()", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: "Closes #294", branch: "feat/294-hold" }]);
  forge.updatePRBody = async () => {
    throw new Error("gh pr edit: 403");
  };
  const logs: string[] = [];
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true }, (line) =>
    logs.push(line),
  );
  assert.equal(pr.pr, null);
  assert.ok(logs.some((l) => l.includes("lane-294-a1b2c3d4") && l.includes("403")));
});

test("listOpenPrsForBranch: branch-keyed gh read (--head), never an issue-number match", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([{ number: 372, body: "b" }]);
  };
  assert.deepEqual(await forge.listOpenPrsForBranch("feat/294-hold"), [{ number: 372, body: "b" }]);
  const argv = seen[0]!;
  assert.equal(argv[argv.indexOf("--head") + 1], "feat/294-hold");
  assert.equal(argv[argv.indexOf("--state") + 1], "open");
  assert.ok(argv.includes("number,title,body"));
});

test("listOpenPrsForBranch (#595): title rides the SAME list read — present when gh returns one, omitted (not null) otherwise", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () =>
    JSON.stringify([{ number: 372, title: "feat: lane's own PR", body: "b" }]);
  const prs = await forge.listOpenPrsForBranch("feat/294-hold");
  assert.equal(prs[0]!.title, "feat: lane's own PR");

  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => JSON.stringify([{ number: 372, body: "b" }]);
  const untitled = await forge.listOpenPrsForBranch("feat/294-hold");
  assert.equal(untitled[0]!.title, undefined);
  assert.ok(!Object.hasOwn(untitled[0]!, "title"));
});

test("listOpenPrBodies (#595): the gh pr list --json field list includes title, and it rides the same read", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify([{ number: 200, title: "fix: bug", body: "Fixes #171" }]);
  };
  const prs = await forge.listOpenPrBodies();
  assert.ok(seen[0]!.includes("number,title,body"));
  assert.equal(prs[0]!.title, "fix: bug");
});

test("updatePRBody: writes through `gh pr edit --body` (a PR-scoped write, never `gh issue edit`)", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "";
  };
  await forge.updatePRBody(372, "new body");
  assert.deepEqual(seen[0]!.slice(0, 3), ["pr", "edit", "372"]);
  assert.equal(seen[0]![seen[0]!.indexOf("--body") + 1], "new body");
});

test("associateLanePr (gate② P1): a branch PR whose body carries DISAGREEING markers is NOT 'unmarked' -> never stamped a third time, never adopted", async () => {
  // readPrOwner returns null for BOTH 'no marker' and 'ambiguous markers'. Treating the second
  // as the first would append a third marker, adopt the PR, and hand a `driving` lane a merge
  // target whose ownership still reads as null on every subsequent probe.
  const ambiguous = `#294\n\n${prOwnerMarker("lane-294-a1b2c3d4", 294)}\n${prOwnerMarker("lane-999-bbbbbbbb", 999)}`;
  const forge = fakeLanePrForge([{ number: 372, body: ambiguous, branch: "feat/294-hold" }]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, null, "ambiguous ownership fails closed");
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0);
  assert.equal(forge.calls.filter((c) => c.kind === "openPR").length, 0);
  assert.equal(forge.prs[0]!.body, ambiguous, "the PR body is left exactly as found");
});

test("hasPrOwnerMarker: true for a malformed/ambiguous marker body that readPrOwner rejects — the two questions are distinct", () => {
  const ambiguous = `${prOwnerMarker("lane-1-aaaaaaaa", 1)}\n${prOwnerMarker("lane-2-bbbbbbbb", 2)}`;
  assert.equal(readPrOwner(ambiguous), null);
  assert.equal(hasPrOwnerMarker(ambiguous), true);
  assert.equal(hasPrOwnerMarker("Fixes #294 — no marker anywhere"), false);
  assert.equal(hasPrOwnerMarker(prOwnerMarker("lane-1-aaaaaaaa", 1)), true);
});

test("associateLanePr (gate② round 2, P1): one unmarked PR ALONGSIDE another lane's marker-bearing PR on the same branch -> refused, not stamped", async () => {
  // A second lane already claims a PR off this head. `unmarked.length === 1` used to fire here
  // and stamp-and-adopt the unmarked one, making the multi-candidate refusal below unreachable —
  // a merge target assigned against direct evidence that the branch is contested. Stamping is
  // only ever eligible when the branch has exactly ONE open PR and it carries no marker at all.
  const rival = `${prOwnerMarker("lane-999-bbbbbbbb", 999)}`;
  const forge = fakeLanePrForge([
    { number: 380, body: `Closes #999\n\n${rival}`, branch: "feat/294-hold" },
    { number: 381, body: "## Why\n\nCloses #294", branch: "feat/294-hold" },
  ]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, null, "a contested branch fails closed");
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0, "the unmarked candidate is never stamped");
  assert.equal(forge.calls.filter((c) => c.kind === "openPR").length, 0);
  assert.equal(forge.prs[1]!.body, "## Why\n\nCloses #294", "left exactly as found");
});

test("associateLanePr (gate② round 2, P1): TWO unmarked PRs on one branch -> refused (neither is stamped)", async () => {
  const forge = fakeLanePrForge([
    { number: 380, body: "first", branch: "feat/294-hold" },
    { number: 381, body: "second", branch: "feat/294-hold" },
  ]);
  const pr = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.equal(pr.pr, null);
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0);
});

test("#379 GithubForge.ensureRepoLabels: lists the configured repo's labels once, creates only the missing ones, returns their names", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return args[1] === "list" ? JSON.stringify([{ name: "sapwood:split" }]) : "";
  };
  const created = await forge.ensureRepoLabels([
    { name: "sapwood:split", color: "fbca04", description: "already there" },
    { name: "sapwood:round:pool", color: "5319e7", description: "In this round's dispatch-eligible pool" },
  ]);
  assert.deepEqual(created, ["sapwood:round:pool"]);
  assert.deepEqual(seen, [
    ["label", "list", "--repo", "o/r", "--limit", "200", "--json", "name"],
    [
      "label",
      "create",
      "sapwood:round:pool",
      "--repo",
      "o/r",
      "--color",
      "5319e7",
      "--description",
      "In this round's dispatch-eligible pool",
    ],
  ]);
});

// ── #377 gate② round 4 (P1): a branch check that FAILED is not a branch that is ABSENT ───────
// branchExists collapses 404/network/auth into `false` by design (retro's fail-closed contract).
// On the lane-association path that collapse re-created the round-3 harm one call earlier: a
// transient blip read as "not pushed", fell through to the marker scan, and returned a
// CONCLUSIVE null — settling the lane with its pushed branch still unPRed.

test("probePushedBranch: a genuine 404 is ABSENT — GitHub's own status, surfaced by gh, is the signal", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    throw new Error("Command failed: gh api repos/o/r/branches/nope\ngh: Not Found (HTTP 404)\n");
  };
  assert.equal(await forge.probePushedBranch("nope"), "absent");
  assert.equal(await forge.branchExists("nope"), false, "branchExists' own fail-closed contract is unchanged");
});

test("probePushedBranch: anything WITHOUT a 404 status is UNKNOWN — network, auth, 5xx, timeout", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  for (const message of [
    "getaddrinfo ENOTFOUND api.github.com",
    "gh: Bad credentials (HTTP 401)",
    "gh: Must have admin rights (HTTP 403)",
    "gh: Server Error (HTTP 502)",
    "Command failed: gh api ... \nsocket hang up",
  ]) {
    (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
      throw new Error(message);
    };
    assert.equal(await forge.probePushedBranch("feat/x"), "unknown", message);
    // The legacy boolean still reads every one of these as "not verifiably pushed" — retro.ts
    // depends on that fail direction and #377 does not change it.
    assert.equal(await forge.branchExists("feat/x"), false, message);
  }
});

test("probePushedBranch: a 404 mentioned in an unrelated position still counts only via the HTTP status token", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async () => {
    throw new Error("gh: could not resolve branch 404-error-handling (HTTP 500)");
  };
  assert.equal(await forge.probePushedBranch("404-error-handling"), "unknown", "a branch NAMED 404 is not a 404 status");
});

test("probePushedBranch: present on success, and issues the same per-segment-encoded read branchExists does", async () => {
  const c = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(c);
  const seen: string[][] = [];
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return "{}";
  };
  assert.equal(await forge.probePushedBranch("feat/111-pr-b#x"), "present");
  assert.deepEqual(seen[0], ["api", "repos/o/r/branches/feat/111-pr-b%23x"]);
});

test("associateLanePr (gate② round 4, P1): an UNKNOWN branch check is inconclusive — never a conclusive 'no PR' that settles the lane", async () => {
  const forge = fakeLanePrForge([{ number: 368, body: "retro digest — covers #294" }], { branches: ["feat/294-hold"] });
  forge.probePushedBranch = async () => "unknown";
  const logs: string[] = [];
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true }, (line) =>
    logs.push(line),
  );
  assert.deepEqual(out, { pr: null, inconclusive: true });
  assert.equal(forge.calls.filter((c) => c.kind === "openPR").length, 0, "never opened against an unverified head");
  assert.ok(logs.some((l) => l.includes("feat/294-hold")));
});

test("associateLanePr (gate② round 4, P1): an ABSENT branch stays CONCLUSIVE — nothing was pushed, so there is nothing to retry", async () => {
  const forge = fakeLanePrForge([], { branches: [] });
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.deepEqual(out, { pr: null, inconclusive: false });
});

// ── #377 gate② round 5 (P1/P2): EVERY engine-authored write waits for the session to end ─────
// Stamping a still-running worker's PR is an unconditional read-modify-write against a body
// snapshot from the preceding list call: the worker (or a human) editing the description in
// between loses those edits. It also burned the inconclusive-retry budget during a phase where
// the conductor only ever classifies the lane KEEP, so the budget could be spent before the one
// probe that actually settles the lane.

test("associateLanePr (gate② round 5): a still-running lane's unmarked branch PR is NOT stamped — no read-modify-write against a live body", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: "## Why\n\nCloses #294", branch: "feat/294-hold" }]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: false });
  assert.deepEqual(out, { pr: null, inconclusive: false }, "conclusive: nothing failed, the write is simply not due yet");
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0);
  assert.equal(forge.prs[0]!.body, "## Why\n\nCloses #294", "the worker's live description is untouched");
});

test("associateLanePr (gate② round 5): a still-running lane whose PR ALREADY carries its marker is still associated — reads never needed the session to end", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: prOwnerMarker("lane-294-a1b2c3d4", 294), branch: "feat/294-hold" }]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: false });
  assert.deepEqual(out, { pr: 372, inconclusive: false });
  assert.equal(forge.calls.filter((c) => c.kind === "updatePRBody").length, 0);
});

test("associateLanePr (gate② round 5): once the session IS over the same unmarked PR is stamped and adopted", async () => {
  const forge = fakeLanePrForge([{ number: 372, body: "## Why\n\nCloses #294", branch: "feat/294-hold" }]);
  const out = await associateLanePr(forge, { name: "lane-294-a1b2c3d4", issue: 294, branch: "feat/294-hold", sessionOver: true });
  assert.deepEqual(out, { pr: 372, inconclusive: false });
  assert.deepEqual(readPrOwner(forge.prs[0]!.body), { lane: "lane-294-a1b2c3d4", issue: 294 });
});
