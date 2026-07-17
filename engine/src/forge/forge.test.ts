import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import {
  assemblePRReviewData,
  countUnresolvedThreads,
  extractVerificationPlan,
  findItemId,
  findOpenPrNumber,
  findOptionId,
  GithubForge,
  hasVerificationPlan,
  parseIssueLabels,
  parseIssueMeta,
  parseIssueRelations,
  parsePageInfo,
  parsePRComments,
  parsePRReactions,
  parsePRReviewView,
  parsePRStatus,
  parseProject,
  parseReviewThreadsPage,
  parseSearchIssues,
  projectQuery,
  selectPlanReviewCandidates,
  selectPlanTriageCandidates,
  selectReadyIssues,
  selectUnplacedIssues,
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

// ── findOpenPrNumber (#46: the live findOpenPr wiring's pure match; PR #50 P2 #2 hardening —
//   this selects gate②'s MERGE target, so ambiguity is fail-closed, never guessed) ──────────

test("findOpenPrNumber: a single bare #<issue> mention is still found (the unambiguous fallback)", () => {
  const prs = [
    { number: 10, body: "unrelated" },
    { number: 11, body: "Part of #46" },
  ];
  assert.equal(findOpenPrNumber(prs, 46), 11);
});

test("findOpenPrNumber: no match -> null", () => {
  assert.equal(findOpenPrNumber([{ number: 10, body: "Part of #45" }], 46), null);
});

test("findOpenPrNumber: does not match a longer number containing the issue as a prefix (#460 != #46)", () => {
  assert.equal(findOpenPrNumber([{ number: 10, body: "Part of #460" }], 46), null);
  assert.equal(findOpenPrNumber([{ number: 10, body: "Fixes #460" }], 46), null);
});

test("findOpenPrNumber: a closing keyword outranks a newer PR's bare mention (never merge the wrong PR)", () => {
  // Newest-first order: the newer PR (20) merely mentions #46 in passing; the older PR (21)
  // declares it closes #46. First-match-wins would pick 20 — the exact wrong-merge-target
  // hazard PR #50 P2 #2 flagged. Closing semantics must win regardless of recency.
  const prs = [
    { number: 20, body: "related to #46, but this PR is for issue #12" },
    { number: 21, body: "Fixes #46" },
  ];
  assert.equal(findOpenPrNumber(prs, 46), 21);
});

test("findOpenPrNumber: all GitHub closing-keyword inflections count, case-insensitive, optional colon", () => {
  for (const kw of ["Fixes", "fixed", "fix", "Closes", "closed", "close", "Resolves", "resolved", "resolve", "Fixes:"]) {
    assert.equal(findOpenPrNumber([{ number: 9, body: `${kw} #46` }], 46), 9, kw);
  }
  // Word-bounded: "unfixes"/"prefixes" are not closing keywords.
  assert.equal(
    findOpenPrNumber(
      [
        { number: 9, body: "unfixes #46" },
        { number: 8, body: "also #46" },
      ],
      46,
    ),
    null,
  );
});

test("findOpenPrNumber: several closing-keyword matches -> the OLDEST wins (the lane's original PR, not a newer duplicate)", () => {
  // Newest-first order: 30 is a newer duplicate/rescue PR also claiming to close #46;
  // 31 is the original. The original must keep the merge target.
  const prs = [
    { number: 30, body: "Closes #46 (superseding attempt)" },
    { number: 31, body: "Fixes #46" },
  ];
  assert.equal(findOpenPrNumber(prs, 46), 31);
});

test("findOpenPrNumber: multiple bare-mention-only candidates are ambiguous -> null (queued, never a guessed merge target)", () => {
  const prs = [
    { number: 20, body: "Part of #46" },
    { number: 21, body: "Part of #46" },
  ];
  assert.equal(findOpenPrNumber(prs, 46), null);
});

test("findOpenPrForIssue: passes an explicit high --limit (gh's default 30 would drop later PRs) and finds a PR past the 30th (Codex PR #50)", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });
  const forge = new GithubForge(cfg);
  const seen: string[][] = [];
  // 40 open PRs, newest-first; the ONLY match ("Fixes #46") is the 35th — a page gh's default
  // --limit 30 would drop, making probe() report hasPr=false and wrongly escalate the lane.
  const prs = Array.from({ length: 40 }, (_, i) => ({
    number: 100 - i,
    body: i === 34 ? "Fixes #46" : `unrelated PR body ${i}`,
  }));
  // Stub the one gh choke point (instance property shadows the private prototype method) —
  // no real gh call; we assert on the exact argv findOpenPrForIssue builds.
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    seen.push(args);
    return JSON.stringify(prs);
  };
  assert.equal(await forge.findOpenPrForIssue(46), 100 - 34); // the 35th PR is found, not dropped
  assert.equal(seen.length, 1);
  const limitIdx = seen[0]!.indexOf("--limit");
  assert.ok(limitIdx >= 0, "an explicit --limit is passed (never gh's default 30)");
  assert.ok(Number(seen[0]![limitIdx + 1]) >= 200, "limit is high enough to cover deep PR lists");
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
            // only milestoned item, #10, is no longer returned under gate⓪).
            {
              number: 40,
              title: "plan approved",
              labels: ["plan:approved"],
              body: "## Verification\n- run npm test",
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
            // #47: BOTH verify:n/a and plan:approved — a state the plan-reviewer prompt forbids
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
  assert.deepEqual(s, { number: 21, headOid: "d0ce0a5", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true });
});

test("parsePRStatus: an empty rollup fails closed (checks may not be created yet)", () => {
  const s = parsePRStatus(JSON.stringify({ number: 1, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }));
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
  const s = parsePRStatus(JSON.stringify({ number: 3, headRefOid: "abc", state: "OPEN", mergeable: "UNKNOWN", statusCheckRollup: [] }));
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
    return JSON.stringify([{ body: "please fix the plan", created_at: "2026-01-01T00:00:00Z", user: { login: "plan-reviewer" } }]);
  };
  const comments = await forge.getIssueComments(9);
  assert.deepEqual(comments, [{ login: "plan-reviewer", createdAt: "2026-01-01T00:00:00Z", body: "please fix the plan" }]);
  assert.ok(seen[0]!.some((a) => a.includes("issues/9/comments")));
  assert.ok(seen[0]!.includes("--paginate") && seen[0]!.includes("--slurp"));
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

// Real response shape (verified live, 2026-07-17, herehigher/sapwood#217 via gh api graphql),
// with labels added per the query this module actually sends.
const RELATIONS_JSON = JSON.stringify({
  data: {
    repository: {
      issue: {
        closedByPullRequestsReferences: { nodes: [{ number: 220, title: "fix", state: "MERGED", labels: { nodes: [] } }] },
        timelineItems: {
          nodes: [
            {
              __typename: "CrossReferencedEvent",
              source: {
                __typename: "Issue",
                number: 219,
                title: "security model",
                state: "CLOSED",
                labels: { nodes: [{ name: "type:docs" }] },
              },
            },
            {
              __typename: "CrossReferencedEvent",
              source: { __typename: "PullRequest", number: 220, title: "fix", state: "MERGED", labels: { nodes: [] } },
            },
            {
              __typename: "ConnectedEvent",
              subject: { __typename: "Issue", number: 238, title: "doctrine", state: "OPEN", labels: { nodes: [{ name: "type:docs" }] } },
            },
          ],
        },
      },
    },
  },
});

test("parseIssueRelations: parses linked PRs + cross-references/connections (both source and subject shapes), with labels", () => {
  const r = parseIssueRelations(RELATIONS_JSON, 10);
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
              { number: 1, title: "a", state: "OPEN", labels: { nodes: [] } },
              { number: 2, title: "b", state: "OPEN", labels: { nodes: [] } },
            ],
          },
          timelineItems: { nodes: [] },
        },
      },
    },
  });
  assert.equal(parseIssueRelations(cap2, 2).truncated, true);
});

test("parseIssueRelations: malformed/missing fields degrade to empty connections, never throw", () => {
  assert.deepEqual(parseIssueRelations(JSON.stringify({ data: {} }), 10), { linkedPRs: [], crossReferences: [], truncated: false });
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

test("parseSearchIssues: parses gh search issues --json output", () => {
  const json = JSON.stringify([
    { number: 244, title: "extends #234", state: "open", labels: [{ name: "type:feature" }], updatedAt: "2026-07-17T06:43:00Z" },
  ]);
  assert.deepEqual(parseSearchIssues(json), [
    { number: 244, title: "extends #234", state: "open", labels: ["type:feature"], updatedAt: "2026-07-17T06:43:00Z" },
  ]);
});

test("searchIssues: scopes the query to --repo owner/repo (never caller-controlled) and applies --limit cap", async () => {
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
  assert.ok(args.includes("is:open flaky"));
  assert.ok(args.includes("--repo") && args.includes("o/r"));
  assert.ok(args.includes("--limit") && args.includes("5"));
});
