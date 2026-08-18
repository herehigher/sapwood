// retro-digest.test.ts (#111 PR-A): the engine-built, round-scoped read digest that replaces
// retro's live `gh pr view/list/diff` + `gh issue view/list` browsing. Covers the module's own
// contract in isolation — event-kind filtering (gatherTouchedPRs/gatherDigestIssues), the hard
// deterministic cap (capDigest), and full assembly (buildRetroDigest) including per-item
// fetch-failure containment. retro.ts's OWN wiring of this module into the peripheral (prompt
// substitution, deps.forge plumbing, config's digestMaxChars) is covered in retro.test.ts
// instead — same file-per-module split as harvest.ts/harvest.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CommitInfo, IForge, Issue, PRComment, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { engineAgentFindingKey } from "../review/finding-key.js";
import { State } from "../state/state.js";
import {
  buildRetroDigest,
  capDigest,
  gatherDigestIssues,
  gatherFindingTendency,
  gatherOutstandingRetroPRs,
  gatherRetroPRLifecycle,
  gatherTouchedPRs,
  PR_TOUCHED_EVENT_KINDS,
  RETRO_PR_LIFECYCLE_READ_BOUND,
} from "./retro-digest.js";

// ── A programmable fake IForge — call-recording, per-item response tables ──────────────────

class FakeForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return { unplaced: [], elsewhere: 0 };
  }
  override async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  diffCalls: number[] = [];
  reviewCalls: number[] = [];
  labelCalls: number[] = [];
  commentCalls: number[] = [];
  diffs = new Map<number, string>();
  reviews = new Map<number, PRReviewData>();
  labels = new Map<number, string[]>();
  issueComments = new Map<number, PRComment[]>();
  diffErrors = new Set<number>();
  commits: CommitInfo[] = [];
  prBodies = new Map<number, string>();
  bodyCalls: number[] = [];

  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  override async claimIssue(): Promise<void> {}
  override async setBoardStatus(): Promise<void> {}
  override async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  override async addLabel(): Promise<void> {}
  override async removeLabel(): Promise<void> {}
  override async addPRLabel(): Promise<void> {}
  override async openPR(): Promise<number> {
    return 1;
  }
  // #964: programmable per-PR status (default OPEN/MERGEABLE/green, same as before this field
  // existed) — the outstanding-PRs section's classification tests set entries here.
  statuses = new Map<number, PRStatus>();
  statusCalls: number[] = [];
  statusErrors = new Set<number>();
  override async getPRStatus(n: number): Promise<PRStatus> {
    this.statusCalls.push(n);
    if (this.statusErrors.has(n)) throw new Error(`simulated status fetch failure for PR #${n}`);
    return this.statuses.get(n) ?? { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  failedCheckSummaries = new Map<number, string>();
  failedCheckSummaryErrors = new Set<number>();
  failedCheckSummaryCalls: number[] = [];
  override async getFailedCheckSummary(pr: number): Promise<string> {
    this.failedCheckSummaryCalls.push(pr);
    if (this.failedCheckSummaryErrors.has(pr)) throw new Error(`simulated checks-API failure for PR #${pr}`);
    return this.failedCheckSummaries.get(pr) ?? "(no failing check runs found via the checks API)";
  }
  override async mergePR(): Promise<void> {}
  override async addPRComment(): Promise<void> {}
  override async addIssueComment(): Promise<void> {}
  override async getIssueBody(n: number): Promise<string> {
    this.bodyCalls.push(n);
    return this.prBodies.get(n) ?? "";
  }
  override async updateIssueBody(): Promise<void> {}
  override async getPRReviewData(pr: number): Promise<PRReviewData> {
    this.reviewCalls.push(pr);
    return (
      this.reviews.get(pr) ?? {
        headOid: "x",
        author: "producer",
        updatedAt: "2026-01-01T00:00:00Z",
        isDraft: false,
        labels: [],
        state: "OPEN",
        reactions: [],
        reviews: [],
        unresolvedThreads: 0,
      }
    );
  }
  override async getPRDiff(pr: number): Promise<string> {
    this.diffCalls.push(pr);
    if (this.diffErrors.has(pr)) throw new Error(`simulated fetch failure for PR #${pr}`);
    return this.diffs.get(pr) ?? "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(): Promise<CommitInfo[]> {
    return this.commits;
  }
  override async branchExists(): Promise<boolean> {
    return false;
  }
  override async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  override async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  override async getIssueLabels(issue: number): Promise<string[]> {
    this.labelCalls.push(issue);
    return this.labels.get(issue) ?? [];
  }
  override async getIssueComments(issue: number): Promise<PRComment[]> {
    this.commentCalls.push(issue);
    return this.issueComments.get(issue) ?? [];
  }
  override async createIssue(): Promise<number> {
    return 1;
  }
  override async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  override async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

// ── gatherTouchedPRs ─────────────────────────────────────────────────────────────────────────

test("gatherTouchedPRs / gatherDigestIssues (#403, F25): the round window is id-cursor-bounded — a round clock AHEAD of the machine clock still sees the round's own events", () => {
  const state = new State(":memory:");
  // Same seeded-vs-wall-clock mismatch gatherRetroFacts covers in retro.test.ts: `started_at`
  // comes from the round's INJECTED clock, `appendEvent` stamps the machine clock, so a
  // `ts >= started_at` read reports an empty round. DELIBERATE real-clock read — the OFFSET
  // between the two clocks is the point, not either absolute value.
  const round = state.startRound(new Date(Date.now() + 3_600_000).toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 30, headOid: "x" });
  state.appendEvent("drive-needs-human", { worker: "b", issue: 2, pr: 10, reason: "r" });
  assert.deepEqual(gatherTouchedPRs(state, round), [10, 30]);
  assert.deepEqual(gatherDigestIssues(state, round, ["drive-needs-human"]), [2]);
  state.close();
});

test("gatherTouchedPRs: collects pr numbers from merged/drive-needs-human/drive-queued/drive-stopped, deduped and sorted", () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 30, headOid: "x" });
  state.appendEvent("drive-needs-human", { worker: "b", issue: 2, pr: 10, reason: "r" });
  state.appendEvent("drive-queued", { worker: "c", issue: 3, pr: 10, reason: "r" }); // dup of 10
  state.appendEvent("drive-stopped", { worker: "d", issue: 4, pr: 20, reason: "r" });
  assert.deepEqual(gatherTouchedPRs(state, round), [10, 20, 30]);
  state.close();
});

test("gatherTouchedPRs: only PR_TOUCHED_EVENT_KINDS count — an unrelated event kind with a pr field is ignored", () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("dispatched", { worker: "a", issue: 1 }); // not in PR_TOUCHED_EVENT_KINDS, and has no pr
  state.appendEvent("reviewer-fallback-switch", { worker: "a", issue: 1, pr: 99, mode: "codex", head: "x" });
  assert.deepEqual(gatherTouchedPRs(state, round), []);
  assert.ok(!(PR_TOUCHED_EVENT_KINDS as readonly string[]).includes("reviewer-fallback-switch"));
  state.close();
});

test("gatherTouchedPRs: events strictly before round start are excluded", async () => {
  const state = new State(":memory:");
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 5, headOid: "x" }); // before round start
  await new Promise((r) => setTimeout(r, 5));
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "b", issue: 2, pr: 6, headOid: "x" });
  assert.deepEqual(gatherTouchedPRs(state, round), [6]);
  state.close();
});

// ── gatherDigestIssues ───────────────────────────────────────────────────────────────────────

test("gatherDigestIssues: collects issue numbers from the caller-supplied kinds only, deduped and sorted", () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("handoff", { worker: "a", issue: 9 });
  state.appendEvent("drive-needs-human", { worker: "b", issue: 3, pr: 1, reason: "r" });
  state.appendEvent("plan-review-escalated", { round_id: round.round_id, issue: 3, reason: "r" }); // dup of 3
  state.appendEvent("ceiling-escalated", { worker: "c", issue: 1, reasons: ["x"] });
  const kinds = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];
  assert.deepEqual(gatherDigestIssues(state, round, kinds), [1, 3, 9]);
  state.close();
});

test("gatherDigestIssues: a kind not in the caller's list is excluded even if it has an issue field", () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("handoff", { worker: "a", issue: 9 });
  state.appendEvent("merged", { worker: "b", issue: 4, pr: 1, headOid: "x" }); // not in the kinds list below
  assert.deepEqual(gatherDigestIssues(state, round, ["handoff"]), [9]);
  state.close();
});

// ── capDigest: the hard, deterministic truncation cap ──────────────────────────────────────

test("capDigest: text at or under the cap is returned unchanged", () => {
  assert.equal(capDigest("short", 1000), "short");
  assert.equal(capDigest("x".repeat(100), 100), "x".repeat(100));
});

test("capDigest: oversize text is truncated and the truncation is marked in the output", () => {
  const text = "y".repeat(500);
  const out = capDigest(text, 300);
  assert.ok(out.length <= 300, `expected output length <= 300, got ${out.length}`);
  assert.ok(out.includes("digest truncated"), "must name the truncation explicitly");
  assert.ok(out.includes("300-char cap"), "must name the cap that was hit");
  assert.ok(out.startsWith("y"), "the kept prefix must be real content, not just the marker");
});

test("capDigest: deterministic — identical input+cap always yields byte-identical output", () => {
  const text = "z".repeat(500) + "TAIL-CONTENT-THAT-SHOULD-BE-CUT";
  const a = capDigest(text, 137);
  const b = capDigest(text, 137);
  assert.equal(a, b);
});

test("capDigest: a pathologically tiny cap still never exceeds maxChars — even the marker itself gets sliced", () => {
  const out = capDigest("a".repeat(1000), 10);
  assert.equal(out.length, 10);
});

test("capDigest: cap of 0 never throws and returns an empty result within bounds", () => {
  const out = capDigest("a".repeat(50), 0);
  assert.equal(out.length, 0);
});

// ── #964: gatherRetroPRLifecycle / gatherOutstandingRetroPRs — "your outstanding PRs" ───────

test("gatherRetroPRLifecycle: folds retro-pr-opened/-updated to ONE row per PR, latest wins, NOT round-scoped", () => {
  const state = new State(":memory:");
  state.startRound(new Date().toISOString());
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x", head: "aaa" });
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 9, branch: "retro/y" }); // legacy: no head
  state.appendEvent("retro-pr-updated", { round_id: 1, pr: 5, branch: "retro/x", head: "bbb" });
  assert.deepEqual(gatherRetroPRLifecycle(state), [
    { pr: 5, branch: "retro/x", head: "bbb" },
    { pr: 9, branch: "retro/y" },
  ]);
  state.close();
});

test("gatherRetroPRLifecycle: a malformed payload (missing pr/branch) contributes nothing rather than throwing", () => {
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, branch: "retro/x" }); // no pr
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5 }); // no branch
  assert.deepEqual(gatherRetroPRLifecycle(state), []);
  state.close();
});

test("gatherRetroPRLifecycle: events from an EARLIER round still count — a retro PR outlives the round that opened it", () => {
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x", head: "aaa" });
  state.startRound(new Date().toISOString()); // round 2 starts AFTER the event above
  assert.deepEqual(gatherRetroPRLifecycle(state), [{ pr: 5, branch: "retro/x", head: "aaa" }]);
  state.close();
});

// #964: bound the read set by a constant rather than a durable terminal event.
test("gatherRetroPRLifecycle: 8 distinct own PRs -> only the newest RETRO_PR_LIFECYCLE_READ_BOUND (5) survive, newest first", () => {
  const state = new State(":memory:");
  for (let pr = 1; pr <= 8; pr++) {
    state.appendEvent("retro-pr-opened", { round_id: 1, pr, branch: `retro/pr-${pr}` });
  }
  assert.equal(RETRO_PR_LIFECYCLE_READ_BOUND, 5, "this test's own math assumes the bound is 5");
  assert.deepEqual(
    gatherRetroPRLifecycle(state).map((r) => r.pr),
    [8, 7, 6, 5, 4],
  );
  state.close();
});

test("gatherRetroPRLifecycle: an UPDATE re-touch moves a PR back into the newest-5 window even if it was originally opened long ago", () => {
  const state = new State(":memory:");
  for (let pr = 1; pr <= 8; pr++) {
    state.appendEvent("retro-pr-opened", { round_id: 1, pr, branch: `retro/pr-${pr}` });
  }
  // PR 1 (the OLDEST) gets a fresh push — it must re-enter the window, displacing whichever PR
  // was previously 5th (PR 4).
  state.appendEvent("retro-pr-updated", { round_id: 2, pr: 1, branch: "retro/pr-1", head: "fresh" });
  assert.deepEqual(
    gatherRetroPRLifecycle(state).map((r) => r.pr),
    [1, 8, 7, 6, 5],
  );
  state.close();
});

test("gatherOutstandingRetroPRs (#964 fix leg): 8 historical retro-pr-opened events -> only the newest 5 PRs are ever read from the forge (scripted call counting)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  for (let pr = 1; pr <= 8; pr++) {
    state.appendEvent("retro-pr-opened", { round_id: 1, pr, branch: `retro/pr-${pr}` });
  }
  const rows = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(rows.length, 5);
  assert.deepEqual(forge.statusCalls, [8, 7, 6, 5, 4], "only the newest 5 PRs are ever read — PRs 1-3 are never touched at all");
  state.close();
});

test("gatherOutstandingRetroPRs (#964 fix leg): a legacy history of N (>5) already-merged PRs settles to a FLAT 5 reads, not N — the bound holds regardless of how large N grows", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  // 20 historical PRs, all long since merged — a real legacy history the bound must not choke on.
  for (let pr = 1; pr <= 20; pr++) {
    state.appendEvent("retro-pr-opened", { round_id: 1, pr, branch: `retro/pr-${pr}` });
    forge.statuses.set(pr, { number: pr, headOid: "x", state: "MERGED", mergeable: "MERGEABLE", ciGreen: true });
  }
  const rows = await gatherOutstandingRetroPRs(forge, state);
  assert.deepEqual(rows, [], "every read PR was merged — nothing outstanding");
  assert.deepEqual(forge.statusCalls, [20, 19, 18, 17, 16], "bounded to the newest 5 — the other 15 are simply never read");
  state.close();
});

test("gatherOutstandingRetroPRs (#964 AC1, red-first): a red PR lists state, failing check name, and a bounded excerpt; a merged PR is dropped; a forge-read failure renders status: unknown and is NEVER dropped", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, {
    number: 5,
    headOid: "aaa",
    state: "OPEN",
    mergeable: "MERGEABLE",
    ciGreen: false,
    ciRed: true,
    ciChecks: [{ name: "test", conclusion: "FAILURE" }],
  });
  forge.failedCheckSummaries.set(5, "### test\nAssertionError: expected 1 to equal 2");
  forge.statuses.set(6, { number: 6, headOid: "bbb", state: "MERGED", mergeable: "MERGEABLE", ciGreen: true });
  forge.statusErrors.add(7);
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x", head: "before" });
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 6, branch: "retro/merged" });
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 7, branch: "retro/unreadable" });
  const rows = await gatherOutstandingRetroPRs(forge, state);
  // #964: gatherRetroPRLifecycle returns NEWEST-TOUCHED-FIRST (pr 7 was opened after pr 5) —
  // [7, 5], not ascending-by-number.
  assert.deepEqual(
    rows.map((r) => r.pr),
    [7, 5],
    "the merged PR (#6) is dropped entirely — never listed as outstanding",
  );
  const red = rows.find((r) => r.pr === 5)!;
  assert.equal(red.state, "OPEN");
  assert.equal(red.actionable, true);
  assert.ok(
    red.reasons.some((r) => r.includes("red CI") && r.includes("test")),
    "names the failing check",
  );
  assert.ok(red.excerpt?.includes("AssertionError: expected 1 to equal 2"), "carries the bounded failure excerpt");
  const unreadable = rows.find((r) => r.pr === 7)!;
  assert.equal(unreadable.state, "unknown");
  assert.equal(unreadable.actionable, true, "an unreadable status is ACTIONABLE, never silently quiet");
  assert.ok(
    unreadable.reasons.some((r) => r.includes("status: unknown")),
    "#964 AC1's exact fail-closed wording",
  );
  state.close();
});

test("gatherOutstandingRetroPRs: a green, non-conflicting, no-changes-requested PR is listed as non-actionable with no excerpt", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const rows = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actionable, false);
  assert.deepEqual(rows[0]!.reasons, []);
  assert.equal(rows[0]!.excerpt, undefined);
  assert.equal(forge.failedCheckSummaryCalls.length, 0, "no excerpt fetch for a non-red PR");
  state.close();
});

test("gatherOutstandingRetroPRs: ciInert names the inert check(s), CONFLICTING is its own reason, both without an excerpt fetch", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, {
    number: 5,
    headOid: "aaa",
    state: "OPEN",
    mergeable: "CONFLICTING",
    ciGreen: false,
    ciRed: false,
    ciInert: true,
    ciChecks: [{ name: "flaky-check", conclusion: "CANCELLED" }],
  });
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const [row] = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(row!.actionable, true);
  assert.ok(row!.reasons.some((r) => r.includes("inert CI") && r.includes("flaky-check")));
  assert.ok(row!.reasons.some((r) => r.includes("conflicting")));
  assert.equal(forge.failedCheckSummaryCalls.length, 0);
  state.close();
});

test("gatherOutstandingRetroPRs: a CHANGES_REQUESTED review standing on the CURRENT head is its own actionable reason", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  forge.reviews.set(5, {
    headOid: "aaa",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    unresolvedThreads: 1,
    reviews: [{ author: "codex", commitOid: "aaa", state: "CHANGES_REQUESTED" }],
  });
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const [row] = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(row!.actionable, true);
  assert.ok(row!.reasons.some((r) => r.includes("changes requested")));
  state.close();
});

// #964: changesRequestedOnHead, not "the last review event" — two mis-cases the old logic got
// wrong.
test("gatherOutstandingRetroPRs: a LATER approve from a DIFFERENT reviewer must not hide an earlier reviewer's standing CHANGES_REQUESTED", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  forge.reviews.set(5, {
    headOid: "aaa",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    unresolvedThreads: 1,
    reviews: [
      { author: "reviewer-a", commitOid: "aaa", state: "CHANGES_REQUESTED" },
      { author: "reviewer-b", commitOid: "aaa", state: "APPROVED" }, // a DIFFERENT reviewer approving
    ],
  });
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const [row] = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(row!.actionable, true, "reviewer-a's standing request is not cleared by reviewer-b's approval");
  assert.ok(row!.reasons.some((r) => r.includes("changes requested")));
  state.close();
});

test("gatherOutstandingRetroPRs: a CHANGES_REQUESTED left on an OLD head does not stay actionable after a push superseded it", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, { number: 5, headOid: "new-head", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  forge.reviews.set(5, {
    headOid: "old-head",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    unresolvedThreads: 0,
    reviews: [{ author: "codex", commitOid: "old-head", state: "CHANGES_REQUESTED" }],
  });
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const [row] = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(row!.actionable, false, "a request on a superseded head is not a standing request on the CURRENT head");
  state.close();
});

test("gatherOutstandingRetroPRs: a getFailedCheckSummary failure is contained — the row stays actionable with a named fetch-failure excerpt, never a thrown error", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, {
    number: 5,
    headOid: "aaa",
    state: "OPEN",
    mergeable: "MERGEABLE",
    ciGreen: false,
    ciRed: true,
    ciChecks: [{ name: "test", conclusion: "FAILURE" }],
  });
  forge.failedCheckSummaryErrors.add(5);
  const state = new State(":memory:");
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const [row] = await gatherOutstandingRetroPRs(forge, state);
  assert.equal(row!.actionable, true);
  assert.ok(row!.excerpt?.includes("failure excerpt fetch failed"));
  state.close();
});

test("gatherOutstandingRetroPRs: zero retro-pr-lifecycle events -> empty array, no forge calls at all", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const rows = await gatherOutstandingRetroPRs(forge, state);
  assert.deepEqual(rows, []);
  assert.equal(forge.statusCalls.length, 0);
  state.close();
});

// ── buildRetroDigest: full assembly ─────────────────────────────────────────────────────────

const ISSUE_KINDS = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];

test("buildRetroDigest: empty round (no touched PRs, no escalated issues) — no forge calls at all beyond the commit-history read, digest says so explicitly", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.equal(forge.diffCalls.length, 0);
  assert.equal(forge.reviewCalls.length, 0);
  assert.equal(forge.labelCalls.length, 0);
  assert.equal(forge.commentCalls.length, 0);
  assert.ok(digest.includes("PRs touched this round (0)"));
  assert.ok(digest.includes("Escalated issues this round (0)"));
  assert.ok(digest.includes("(none)"));
  assert.ok(digest.includes("(no commits)"));
  state.close();
});

test("buildRetroDigest: a touched PR pulls its description + diff + review data via forge, all appear in the digest text", async () => {
  const forge = new FakeForge();
  forge.prBodies.set(11, "## What / why\nFixes the widget rendering bug.");
  forge.diffs.set(11, "diff --git a/foo b/foo\n+added a line");
  forge.reviews.set(11, {
    headOid: "abc123",
    author: "producer",
    updatedAt: "2026-07-11T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    unresolvedThreads: 2,
    reviews: [{ author: "codex", commitOid: "abc123def", state: "CHANGES_REQUESTED" }],
    comments: [{ login: "codex", createdAt: "2026-07-11T00:01:00Z", body: "please fix the widget" }],
  });
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 11, headOid: "abc" });
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.deepEqual(forge.bodyCalls, [11]);
  assert.deepEqual(forge.diffCalls, [11]);
  assert.deepEqual(forge.reviewCalls, [11]);
  assert.ok(digest.includes("PR #11"));
  assert.ok(
    digest.includes("Fixes the widget rendering bug."),
    "the PR's own description (gh pr view's what/why) must appear — #111 dry-run finding",
  );
  assert.ok(digest.includes("added a line"));
  assert.ok(digest.includes("CHANGES_REQUESTED"));
  assert.ok(digest.includes("please fix the widget"));
  assert.ok(digest.includes("unresolved review threads: 2"));
  state.close();
});

test("buildRetroDigest: an escalated issue pulls its labels + comments via forge, both appear in the digest text", async () => {
  const forge = new FakeForge();
  forge.labels.set(4, ["needs-human", "prio:1-high"]);
  forge.issueComments.set(4, [{ login: "harvest-bot", createdAt: "2026-07-11T00:00:00Z", body: "this needs a human look" }]);
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("drive-needs-human", { worker: "a", issue: 4, pr: 99, reason: "flaky" });
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.deepEqual(forge.labelCalls, [4]);
  assert.deepEqual(forge.commentCalls, [4]);
  assert.ok(digest.includes("Issue #4"));
  assert.ok(digest.includes("needs-human, prio:1-high"));
  assert.ok(digest.includes("this needs a human look"));
  state.close();
});

test("buildRetroDigest: multiple touched PRs are sorted ascending and each gets its own section", async () => {
  const forge = new FakeForge();
  forge.diffs.set(5, "diff-for-5");
  forge.diffs.set(2, "diff-for-2");
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 5, headOid: "x" });
  state.appendEvent("merged", { worker: "b", issue: 2, pr: 2, headOid: "y" });
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  const idx2 = digest.indexOf("PR #2");
  const idx5 = digest.indexOf("PR #5");
  assert.ok(idx2 !== -1 && idx5 !== -1 && idx2 < idx5, "PR #2's section must come before PR #5's");
  state.close();
});

test("buildRetroDigest: a per-PR fetch failure is contained to that PR's section — other sections still populate, the call never throws", async () => {
  const forge = new FakeForge();
  forge.diffErrors.add(7);
  forge.diffs.set(8, "healthy diff for 8");
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 7, headOid: "x" });
  state.appendEvent("merged", { worker: "b", issue: 2, pr: 8, headOid: "y" });
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("PR #7"));
  assert.ok(digest.includes("digest fetch failed"));
  assert.ok(digest.includes("healthy diff for 8"), "PR #8's section is unaffected by PR #7's failure");
  state.close();
});

test("buildRetroDigest: commit history is sourced from forge.getCommitsSince, formatted with short sha/date/author/subject", async () => {
  const forge = new FakeForge();
  forge.commits = [{ sha: "abc1234def5678", message: "fix: something\n\nlonger body text", author: "alice", date: "2026-07-11T00:00:00Z" }];
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("abc1234")); // short sha
  assert.ok(digest.includes("alice"));
  assert.ok(digest.includes("fix: something")); // subject line only, not the longer body
  assert.ok(!digest.includes("longer body text"));
  state.close();
});

test("buildRetroDigest: a commit-history fetch failure degrades to a note, never a thrown error", async () => {
  const forge = new FakeForge();
  forge.getCommitsSince = async () => {
    throw new Error("simulated API failure");
  };
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("commit history unavailable"));
  state.close();
});

test("buildRetroDigest: the assembled digest respects maxChars end-to-end — a small cap truncates deterministically", async () => {
  const forge = new FakeForge();
  forge.diffs.set(1, "d".repeat(2000));
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 1, headOid: "x" });
  const digest = await buildRetroDigest({ forge, state }, round, 300, ISSUE_KINDS, 3);
  assert.ok(digest.length <= 300);
  assert.ok(digest.includes("digest truncated"));
  state.close();
});

// ── Codex review round 1 (PR #118): small caps must not defeat per-item budgeting ───────────
//
// The pre-review fairShare applied hard per-item MINIMUM floors even when digestMaxChars was
// smaller than the floors' sum (cap=200 with two PRs -> 1,500 chars EACH), so the assembled
// digest blew the cap and the final whole-digest capDigest FRONT-truncated it — silently
// dropping later PRs, the issues section, and the commit history: the exact starvation failure
// per-item budgets exist to prevent. Floors now scale to the proportional share.

test("small cap (Codex round 1): a cap the old floors couldn't afford — every section and item still present, each truncation marked, total <= cap", async () => {
  const forge = new FakeForge();
  // Two PRs with diffs far beyond any per-item share, one escalated issue, real commits —
  // under the old 1,500/PR floor a 2,500 cap could not hold all of this without the final
  // backstop silently dropping the tail.
  forge.diffs.set(1, "a".repeat(5000));
  forge.diffs.set(2, "b".repeat(5000));
  forge.labels.set(4, ["needs-human"]);
  forge.issueComments.set(4, [{ login: "bot", createdAt: "2026-07-11T00:00:00Z", body: "escalated note" }]);
  forge.commits = [{ sha: "abc1234def", message: "fix: thing", author: "alice", date: "2026-07-11T00:00:00Z" }];
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 1, headOid: "x" });
  state.appendEvent("merged", { worker: "b", issue: 2, pr: 2, headOid: "y" });
  state.appendEvent("drive-needs-human", { worker: "c", issue: 4, pr: 2, reason: "r" });

  const digest = await buildRetroDigest({ forge, state }, round, 2500, ISSUE_KINDS, 3);

  assert.ok(digest.length <= 2500, `total must respect the cap (got ${digest.length})`);
  // Every item/section present — nothing silently dropped:
  assert.ok(digest.includes("### PR #1"), "PR #1's section present");
  assert.ok(digest.includes("### PR #2"), "PR #2's section present — the old floors starved it out");
  assert.ok(digest.includes("### Issue #4"), "the escalated issue's section present");
  assert.ok(digest.includes("escalated note"), "the issue's comment present");
  assert.ok(digest.includes("abc1234"), "the commit history present");
  // Both oversize diffs were cut PER ITEM, each cut marked — never a silent drop:
  const markers = digest.split("digest truncated").length - 1;
  assert.ok(markers >= 2, `each oversize PR section carries its own truncation marker (got ${markers})`);
  state.close();
});

// ── #964: buildRetroDigest carries "Your outstanding PRs" ───────────────────────────────────

test("buildRetroDigest (#964): the outstanding-PRs section is NOT round-scoped — a PR opened in an EARLIER round still appears", async () => {
  const forge = new FakeForge();
  forge.statuses.set(5, {
    number: 5,
    headOid: "aaa",
    state: "OPEN",
    mergeable: "MERGEABLE",
    ciGreen: false,
    ciRed: true,
    ciChecks: [{ name: "build", conclusion: "FAILURE" }],
  });
  forge.failedCheckSummaries.set(5, "### build\ncompile error: unexpected token");
  const state = new State(":memory:");
  // The retro-pr-opened event predates THIS round's start_event_id — round-scoped sections
  // (PRs touched, escalated issues) would never see it; the outstanding section must anyway.
  state.appendEvent("retro-pr-opened", { round_id: 1, pr: 5, branch: "retro/x" });
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("Your outstanding PRs (1)"));
  assert.ok(digest.includes("PR #5"));
  assert.ok(digest.includes("build"));
  assert.ok(digest.includes("compile error: unexpected token"));
  state.close();
});

test("buildRetroDigest (#964): zero outstanding PRs renders the section's own explicit empty state, never a missing section", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("Your outstanding PRs (0)"));
  assert.ok(digest.includes("no PR you opened is still open on the forge"));
  state.close();
});

test("small cap (Codex round 1): a pathologically tiny cap (200) with 2 PRs + 1 issue + commits — bounded and marked, never over the cap", async () => {
  const forge = new FakeForge();
  forge.diffs.set(1, "a".repeat(5000));
  forge.diffs.set(2, "b".repeat(5000));
  forge.labels.set(4, ["needs-human"]);
  forge.commits = [{ sha: "abc1234def", message: "fix: thing", author: "alice", date: "2026-07-11T00:00:00Z" }];
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 1, headOid: "x" });
  state.appendEvent("merged", { worker: "b", issue: 2, pr: 2, headOid: "y" });
  state.appendEvent("drive-needs-human", { worker: "c", issue: 4, pr: 2, reason: "r" });

  const digest = await buildRetroDigest({ forge, state }, round, 200, ISSUE_KINDS, 3);

  // 200 chars cannot hold even the section skeleton, so the final backstop MUST fire — but it
  // fires MARKED (the truncation is named in the text), and the result never exceeds the cap.
  // Determinism: byte-identical on a second assembly over the same inputs.
  assert.ok(digest.length <= 200, `total must respect the cap (got ${digest.length})`);
  assert.ok(digest.includes("digest truncated"), "the backstop truncation is marked, never silent");
  const again = await buildRetroDigest({ forge, state }, round, 200, ISSUE_KINDS, 3);
  assert.equal(digest, again);
  state.close();
});

// ── #453 (design #402 R5, §5): the finding-class tendency table ─────────────────────────────
//
// A finding CLASS that recurs across PRs and rounds is evidence about the DESIGN, not about
// those PRs — and until now nothing in the engine noticed a pattern it raised a dozen times.
// The engine only TABULATES here (D5): every assertion below is about the table's content and
// bounds, never about the engine acting on it.

/** Seed one `drive-fixup` finding record — the R2 payload shape (`loop/conductor.ts`), keyed
 *  through the real `engineAgentFindingKey` rather than a hand-written string, so these tests
 *  break if the key encoding ever changes shape underneath the tendency reader. */
function seedFixup(state: State, pr: number, findings: { id: string; kind?: string; path?: string }[]): void {
  state.appendEvent("drive-fixup", {
    worker: `w-${pr}`,
    issue: pr,
    pr,
    fixRounds: 1,
    reason: "review-rejected",
    findings: findings.map((f) => ({
      key: engineAgentFindingKey(f as { id: string; kind?: never; path?: string }).key,
      severity: "blocking",
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
    })),
    fixDiffPaths: [],
  });
}

test("#453 tendency: a (kind, path-prefix) class shared by two PRs counts 2 and names both PRs; a unique class counts 1", async () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  seedFixup(state, 12, [{ id: "f1", kind: "correctness", path: "engine/src/loop/conductor.ts" }]);
  seedFixup(state, 14, [{ id: "f2", kind: "correctness", path: "engine/src/loop/reconcile.ts" }]); // same prefix
  seedFixup(state, 16, [{ id: "f3", kind: "security", path: "engine/src/forge/gh.ts" }]);

  const t = gatherFindingTendency(state, round, 3);
  const shared = t.rows.find((r) => r.kind === "correctness" && r.pathPrefix === "engine/src/loop/");
  assert.ok(shared, `expected a correctness/engine/src/loop/ row, got ${JSON.stringify(t.rows)}`);
  assert.equal(shared.count, 2);
  assert.deepEqual(shared.prs, [12, 14]);
  assert.equal(shared.rounds, 1);
  const unique = t.rows.find((r) => r.kind === "security");
  assert.ok(unique);
  assert.equal(unique.count, 1);
  assert.deepEqual(unique.prs, [16]);

  const digest = await buildRetroDigest({ forge: new FakeForge(), state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("Finding-class tendency"), "the section heading is rendered");
  assert.ok(digest.includes("engine/src/loop/"), "the shared class's path prefix is rendered");
  assert.ok(digest.includes("#12, #14"), "both PRs are named in the shared class's row");
  state.close();
});

test("#453 tendency: the window spans the last `tendencyRounds` rounds — 3 rounds with the same class shows rounds 3 at K=3, rounds 1 at K=1", () => {
  const state = new State(":memory:");
  const cls = { id: "f", kind: "correctness", path: "engine/src/loop/conductor.ts" };
  state.startRound(new Date().toISOString());
  seedFixup(state, 1, [cls]);
  state.startRound(new Date().toISOString());
  seedFixup(state, 2, [cls]);
  const round3 = state.startRound(new Date().toISOString());
  seedFixup(state, 3, [cls]);

  const wide = gatherFindingTendency(state, round3, 3);
  assert.equal(wide.rows.length, 1);
  assert.equal(wide.rows[0]?.rounds, 3, "a class appearing once per round across three rounds spans 3 rounds");
  assert.equal(wide.rows[0]?.count, 3);
  assert.deepEqual(wide.rows[0]?.prs, [1, 2, 3]);
  assert.equal(wide.roundsCovered, 3);

  const narrow = gatherFindingTendency(state, round3, 1);
  assert.equal(narrow.rows[0]?.rounds, 1, "K=1 sees only the current round");
  assert.equal(narrow.rows[0]?.count, 1);
  assert.deepEqual(narrow.rows[0]?.prs, [3]);
  assert.equal(narrow.roundsCovered, 1);
  state.close();
});

test("#453 tendency: fewer rounds in the ledger than `tendencyRounds` degrades to what exists, no error", () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  seedFixup(state, 7, [{ id: "f", kind: "design", path: "docs/design/x.md" }]);
  const t = gatherFindingTendency(state, round, 3);
  assert.equal(t.roundsCovered, 1, "only one round exists — the window degrades to it");
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0]?.rounds, 1);
  state.close();
});

test("#453 tendency: a round with zero finding records renders an EXPLICIT empty marker under the heading, never an absent section", async () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge: new FakeForge(), state }, round, 60_000, ISSUE_KINDS, 3);
  assert.ok(digest.includes("Finding-class tendency"), "the heading is present even with no data");
  assert.ok(digest.includes("no finding records"), "the empty state is stated explicitly, not implied by absence");
  state.close();
});

test("#453 tendency: the section is bounded by digestMaxChars and any cut is MARKED, deterministically", async () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  for (let i = 0; i < 40; i++) seedFixup(state, i + 1, [{ id: `f${i}`, kind: "correctness", path: `engine/src/pkg${i}/file.ts` }]);
  const a = await buildRetroDigest({ forge: new FakeForge(), state }, round, 900, ISSUE_KINDS, 3);
  const b = await buildRetroDigest({ forge: new FakeForge(), state }, round, 900, ISSUE_KINDS, 3);
  assert.ok(a.length <= 900, `total must respect the cap (got ${a.length})`);
  assert.equal(a, b, "same input + same cap => byte-identical output");
  assert.ok(a.includes("digest truncated"), "the cut is marked in the digest text, never a silent drop");
  state.close();
});

test("#453 tendency (#403 F25): the read is id-cursor-bounded — a round clock AHEAD of the machine clock still sees its own finding records", () => {
  const state = new State(":memory:");
  // Same seeded-vs-wall-clock mismatch as this file's first test: a `started_at`-based window
  // would silently report a round in which no finding was ever raised.
  const round = state.startRound(new Date(Date.now() + 3_600_000).toISOString());
  seedFixup(state, 21, [{ id: "f", kind: "correctness", path: "engine/src/loop/conductor.ts" }]);
  const t = gatherFindingTendency(state, round, 3);
  assert.equal(t.rows.length, 1, "the round's own finding record is inside the window");
  state.close();
});

test("#453 tendency: the tendency read uses the eventsAfterId id cursor — no timestamp-compared ledger read in this module", () => {
  const source = readFileSync(new URL("./retro-digest.ts", import.meta.url), "utf8");
  assert.match(source, /eventsAfterId\(/, "the ledger reads go through the id cursor");
  assert.doesNotMatch(source, /eventsSince\(/, "no timestamp-bounded ledger read (#403 F25's silently-empty-round class)");
});

test("#453 (D5): no engine code path on the retro side creates an issue from a finding or a finding class", () => {
  for (const file of ["./retro-digest.ts", "./retro.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const forbidden of ["createIssue", "addSubIssue"]) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\.${forbidden}\\(`),
        `${file} must never turn a finding into an issue — the engine tabulates, retro judges (design #402 D5)`,
      );
    }
  }
});
