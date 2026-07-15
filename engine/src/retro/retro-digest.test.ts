// retro-digest.test.ts (#111 PR-A): the engine-built, round-scoped read digest that replaces
// retro's live `gh pr view/list/diff` + `gh issue view/list` browsing. Covers the module's own
// contract in isolation — event-kind filtering (gatherTouchedPRs/gatherDigestIssues), the hard
// deterministic cap (capDigest), and full assembly (buildRetroDigest) including per-item
// fetch-failure containment. retro.ts's OWN wiring of this module into the peripheral (prompt
// substitution, deps.forge plumbing, config's digestMaxChars) is covered in retro.test.ts
// instead — same file-per-module split as harvest.ts/harvest.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitInfo, IForge, Issue, PRComment, PRReviewData, PRStatus } from "../forge/forge.js";
import { State } from "../state/state.js";
import { buildRetroDigest, capDigest, gatherDigestIssues, gatherTouchedPRs, PR_TOUCHED_EVENT_KINDS } from "./retro-digest.js";

// ── A programmable fake IForge — call-recording, per-item response tables ──────────────────

class FakeForge implements IForge {
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

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(): Promise<void> {}
  async getIssueBody(n: number): Promise<string> {
    this.bodyCalls.push(n);
    return this.prBodies.get(n) ?? "";
  }
  async updateIssueBody(): Promise<void> {}
  async getPRReviewData(pr: number): Promise<PRReviewData> {
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
  async getPRDiff(pr: number): Promise<string> {
    this.diffCalls.push(pr);
    if (this.diffErrors.has(pr)) throw new Error(`simulated fetch failure for PR #${pr}`);
    return this.diffs.get(pr) ?? "";
  }
  async getCommitsSince(): Promise<CommitInfo[]> {
    return this.commits;
  }
  async branchExists(): Promise<boolean> {
    return false;
  }
  async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  async getIssueLabels(issue: number): Promise<string[]> {
    this.labelCalls.push(issue);
    return this.labels.get(issue) ?? [];
  }
  async getIssueComments(issue: number): Promise<PRComment[]> {
    this.commentCalls.push(issue);
    return this.issueComments.get(issue) ?? [];
  }
  async createIssue(): Promise<number> {
    return 1;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

// ── gatherTouchedPRs ─────────────────────────────────────────────────────────────────────────

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
  assert.ok(!PR_TOUCHED_EVENT_KINDS.includes("reviewer-fallback-switch"));
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

// ── buildRetroDigest: full assembly ─────────────────────────────────────────────────────────

const ISSUE_KINDS = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];

test("buildRetroDigest: empty round (no touched PRs, no escalated issues) — no forge calls at all beyond the commit-history read, digest says so explicitly", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
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
  const digest = await buildRetroDigest({ forge, state }, round, 60_000, ISSUE_KINDS);
  assert.ok(digest.includes("commit history unavailable"));
  state.close();
});

test("buildRetroDigest: the assembled digest respects maxChars end-to-end — a small cap truncates deterministically", async () => {
  const forge = new FakeForge();
  forge.diffs.set(1, "d".repeat(2000));
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("merged", { worker: "a", issue: 1, pr: 1, headOid: "x" });
  const digest = await buildRetroDigest({ forge, state }, round, 300, ISSUE_KINDS);
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

  const digest = await buildRetroDigest({ forge, state }, round, 2500, ISSUE_KINDS);

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

  const digest = await buildRetroDigest({ forge, state }, round, 200, ISSUE_KINDS);

  // 200 chars cannot hold even the section skeleton, so the final backstop MUST fire — but it
  // fires MARKED (the truncation is named in the text), and the result never exceeds the cap.
  // Determinism: byte-identical on a second assembly over the same inputs.
  assert.ok(digest.length <= 200, `total must respect the cap (got ${digest.length})`);
  assert.ok(digest.includes("digest truncated"), "the backstop truncation is marked, never silent");
  const again = await buildRetroDigest({ forge, state }, round, 200, ISSUE_KINDS);
  assert.equal(digest, again);
  state.close();
});
