// escalation-reconcile.test.ts (#295): the escalation-resolution reconciler's own module —
// the open-escalation fold, the read-only external observation, and the transition-only
// `escalation-resolved` append. Same "fake the collaborator, not the CLI" split every other
// peripheral's test file in this codebase uses (dissent.test.ts is the closest sibling: this
// module is the same concern-adjudication paradigm applied to needs-human escalations).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, IssueMeta, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { State } from "../state/state.js";
import { openEscalations, reconcileEscalations } from "./escalation-reconcile.js";

/** A minimal fake IForge — every method the module under test doesn't touch is a harmless no-op
 *  (same shape as dissent.test.ts's FakeForge). `issueStates`/`issueLabels`/`prStates` are the
 *  three stores this module's getIssueMeta/getPRStatus reads come from; tests seed them directly
 *  to script a scenario. Every WRITE method records into `writes` so the read-only assertion
 *  (#295 AC3) can be made structurally rather than by inspection. */
class FakeForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  issueStates: Record<number, "OPEN" | "CLOSED"> = {};
  issueLabels: Record<number, string[]> = {};
  prStates: Record<number, "OPEN" | "CLOSED" | "MERGED"> = {};
  /** Every forge WRITE this module might wrongly make lands here — asserted empty (#295 AC3). */
  writes: string[] = [];
  /** Read-call trace, so "steady state costs zero forge calls" is assertable. */
  reads: string[] = [];
  /** Issue numbers whose reads should throw (degradation test). */
  failReadsFor = new Set<number>();
  /** Board column per issue, for the `board-fixed` arm. */
  placements: Record<number, string | null> = {};
  /** Make the board-wide placement read throw (degradation test). */
  failBoardRead = false;
  /** Placements from OTHER repos on the same multi-repo Project board (round 8 P1). */
  foreignPlacements: Array<{ number: number | null; repo: string | null; status: string | null }> = [];

  override async getIssueMeta(issue: number): Promise<IssueMeta> {
    this.reads.push(`getIssueMeta:${issue}`);
    if (this.failReadsFor.has(issue)) throw new Error("forge exploded");
    return {
      number: issue,
      title: "",
      state: this.issueStates[issue] ?? "OPEN",
      labels: this.issueLabels[issue] ?? [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  override async getPRStatus(pr: number): Promise<PRStatus> {
    this.reads.push(`getPRStatus:${pr}`);
    return { number: pr, headOid: "x", state: this.prStates[pr] ?? "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }

  // ── writes: every one records, so AC3 ("zero writes to GitHub") is structurally checkable ──
  override async claimIssue(): Promise<void> {
    this.writes.push("claimIssue");
  }
  override async setBoardStatus(): Promise<void> {
    this.writes.push("setBoardStatus");
  }
  override async addLabel(): Promise<void> {
    this.writes.push("addLabel");
  }
  override async removeLabel(): Promise<void> {
    this.writes.push("removeLabel");
  }
  override async addPRLabel(): Promise<void> {
    this.writes.push("addPRLabel");
  }
  override async openPR(): Promise<number> {
    this.writes.push("openPR");
    return 1;
  }
  override async mergePR(): Promise<void> {
    this.writes.push("mergePR");
  }
  override async addPRComment(): Promise<void> {
    this.writes.push("addPRComment");
  }
  override async addIssueComment(): Promise<void> {
    this.writes.push("addIssueComment");
  }
  override async updateIssueBody(): Promise<void> {
    this.writes.push("updateIssueBody");
  }
  override async createIssue(): Promise<number> {
    this.writes.push("createIssue");
    return 1;
  }
  override async addSubIssue(): Promise<void> {
    this.writes.push("addSubIssue");
  }
  override async replyToReviewThread(): Promise<void> {
    this.writes.push("replyToReviewThread");
  }
  override async resolveReviewThread(): Promise<void> {
    this.writes.push("resolveReviewThread");
  }

  // ── unused reads ────────────────────────────────────────────────────────────────────────
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return [];
  }
  override async readStartupReconcileData() {
    this.reads.push("readStartupReconcileData");
    if (this.failBoardRead) throw new Error("board read exploded");
    return {
      placements: [
        ...Object.entries(this.placements).map(([number, status]) => ({ number: Number(number), repo: "owner/r", status })),
        ...this.foreignPlacements,
      ],
      openPrs: [],
    };
  }
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  override async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  override async getSubIssues() {
    return [];
  }
  override async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x",
      author: "producer",
      updatedAt: "2026-01-01T00:00:00Z",
      isDraft: false,
      labels: [],
      state: "OPEN",
      reactions: [],
      reviews: [],
      unresolvedThreads: 0,
    };
  }
  override async getPRDiff(): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
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
    return this.issueLabels[issue] ?? [];
  }
  override async getIssueComments() {
    return [];
  }
  override async getIssueBody(): Promise<string> {
    return "";
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
  override async getIssueRelations() {
    return { linkedPRs: [], crossReferences: [], truncated: false };
  }
  override async searchIssues() {
    return [];
  }
  override async getPRDetails() {
    return {
      number: 1,
      headOid: "x",
      baseRefName: "main",
      state: "OPEN" as const,
      draft: false,
      labels: [],
      mergeable: "MERGEABLE" as const,
    };
  }
  override async getPRReviews() {
    return { reviews: [], total: 0 };
  }
  override async getPRReviewThreads() {
    return { threads: [], pageCapped: false };
  }
  override async getPRChecks() {
    return { checks: [], total: 0 };
  }
  override async getReviewThreadCommentsTail(): Promise<string[]> {
    return [];
  }
}

const mkCfg = (): SapwoodConfig => ConfigSchema.parse({ board: { owner: "owner", repo: "r", projectNumber: 1 } });

const NEEDS_HUMAN = "sapwood:needs-human";

const tapEvents = (state: State): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  return logged;
};

const resolvedEvents = (logged: Array<[string, unknown]>) =>
  logged.filter(([kind]) => kind === "escalation-resolved").map(([, payload]) => payload as Record<string, unknown>);

// ── the fold ────────────────────────────────────────────────────────────────────────────────

test("openEscalations: an escalation with no matching resolution is open", () => {
  const open = openEscalations([{ kind: "gated-reentry-capped", payload: { worker: "w1", issue: 7, pr: 12, attempts: 2 } }]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("gated-reentry-capped:7"), { source: "gated-reentry-capped", issue: 7, pr: 12, labelProven: true });
});

test("openEscalations: a matching escalation-resolved closes it (steady state is empty)", () => {
  const open = openEscalations([
    { kind: "gated-reentry-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "gated-reentry-capped", via: "merged" } },
  ]);
  assert.equal(open.size, 0);
});

test("openEscalations: a RE-escalation after a resolution re-opens the same (source, issue) — counts, not a one-way set", () => {
  const open = openEscalations([
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 12, labeled: 1 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "drive-needs-human", via: "label-removed" } },
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 13, labeled: 1 } },
  ]);
  assert.equal(open.size, 1);
  // the LATEST escalation's own facts win (pr 13, not the stale 12)
  assert.equal(open.get("drive-needs-human:7")?.pr, 13);
});

test("openEscalations: drive-needs-human with labeled:0 is open but NOT label-proven", () => {
  const open = openEscalations([{ kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 12, labeled: 0 } }]);
  assert.equal(open.get("drive-needs-human:7")?.labelProven, false);
});

test("openEscalations: a best-effort-label kind (ceiling-escalated) is never label-proven", () => {
  const open = openEscalations([{ kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["x"] } }]);
  assert.equal(open.get("ceiling-escalated:7")?.labelProven, false);
});

test("openEscalations: a REPEAT-emitting kind collapses to ONE open item, not one per emission (gate② round 2)", () => {
  // gated-reentry-capped-label-failed is a retry-until-success stream (conductor.ts's GATED
  // RECLAIM re-enters the branch every tick until the label lands), so N emissions are ONE
  // thing waiting on a human — a counting fold would demand N resolutions to clear one row.
  const open = openEscalations([
    { kind: "gated-reentry-capped-label-failed", payload: { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" } },
    { kind: "gated-reentry-capped-label-failed", payload: { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" } },
    { kind: "gated-reentry-capped-label-failed", payload: { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" } },
  ]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("gated-reentry-capped-label-failed:7"), {
    source: "gated-reentry-capped-label-failed",
    issue: 7,
    pr: 12,
    labelProven: false, // the label write is exactly what failed — absence proves nothing
  });
});

test("openEscalations: a malformed payload (no issue) is skipped, never thrown", () => {
  const open = openEscalations([
    { kind: "resume-capped", payload: { worker: "w1" } },
    { kind: "resume-capped", payload: null },
  ]);
  assert.equal(open.size, 0);
});

// ── the sweep: one resolution per class, exactly once ────────────────────────────────────────

test("reconcileEscalations: a latched gated-reentry-capped row whose PR was hand-merged resolves via 'merged' (#295 AC1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped", { worker: "w1", issue: 7, pr: 12, attempts: 2 });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "gated-reentry-capped", via: "merged" }]);
  assert.deepEqual(forge.writes, []); // AC3: read-only
  state.close();
});

test("reconcileEscalations: a removed needs-human label resolves a label-proven escalation via 'label-removed'", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("resume-capped", { worker: "w1", issue: 7, attempts: 3 });
  forge.issueLabels[7] = []; // the human took the label off
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "resume-capped", via: "label-removed" }]);
  state.close();
});

test("reconcileEscalations: a closed issue resolves via 'issue-closed'", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("drive-no-pr", { worker: "w1", issue: 7 });
  forge.issueStates[7] = "CLOSED";
  forge.issueLabels[7] = [NEEDS_HUMAN]; // still labelled — closure alone resolves it
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "drive-no-pr", via: "issue-closed" }]);
  state.close();
});

test("reconcileEscalations: a PR closed without merging resolves via 'pr-closed' — distinct from issue closure (#441 r2)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("env-failure-preserved", { worker: "w1", issue: 7, source: "auth", pr: 12, worktreePath: "/tmp/x" });
  forge.prStates[12] = "CLOSED";
  forge.issueLabels[7] = [NEEDS_HUMAN];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "env-failure-preserved", via: "pr-closed" }]);
  state.close();
});

test("reconcileEscalations: a merged-path rollback-escalated is NOT resolved by its own merge's issue closure (round 7)", async () => {
  // A worker PR carries `Closes #N`, so the merge closes the issue — and this escalation says that
  // same merge's Done-board write never landed. The board is still wrong; closure is not evidence.
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.issueStates[7] = "CLOSED";
  forge.placements[7] = "In Progress";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  assert.deepEqual(forge.reads, ["readStartupReconcileData"]); // the issue read is skipped entirely
  state.close();
});

test("reconcileEscalations: it resolves via 'board-fixed' once the board actually reaches Done (round 7)", async () => {
  // Observes the FACT (the board is repaired), not a human ritual on a closed issue — so it heals
  // legacy ledger events too, which a label-based path could not.
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.issueStates[7] = "CLOSED";
  forge.placements[7] = "Done";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "rollback-escalated", via: "board-fixed" }]);
  state.close();
});

test("reconcileEscalations: the board read is ONE call per sweep however many merge-produced escalations are open", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  for (const issue of [7, 8, 9]) {
    state.appendEvent("rollback-escalated", { issue, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
    forge.placements[issue] = "Done";
  }
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.equal(resolvedEvents(logged).length, 3);
  assert.deepEqual(forge.reads, ["readStartupReconcileData"]);
  state.close();
});

test("reconcileEscalations: no merge-produced escalation open ⇒ the board is never read at all", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "ready", reason: "dead-lane-requeue", attempts: 3, error: "boom" });
  forge.issueStates[7] = "CLOSED";

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(forge.reads, ["getIssueMeta:7"]);
  state.close();
});

test("reconcileEscalations: a board read failure leaves merge-produced escalations open, never falsely resolved", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.failBoardRead = true;
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a foreign repo's same-numbered board item can never supply a board-fixed resolution (round 8 P1)", async () => {
  // A ProjectV2 board may span repositories; issue numbers are not globally unique.
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.placements[7] = "In Progress"; // ours: still wrong
  forge.foreignPlacements = [{ number: 7, repo: "someone-else/other", status: "Done" }];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a placement with no repo attribution never resolves — fails closed (round 8)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.foreignPlacements = [{ number: 7, repo: null, status: "Done" }];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a NON-merge-produced rollback-escalated still resolves on issue closure (round 7 scoping)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "ready", reason: "dead-lane-requeue", attempts: 3, error: "boom" });
  forge.issueStates[7] = "CLOSED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "rollback-escalated", via: "issue-closed" }]);
  state.close();
});

test("reconcileEscalations: ceiling-escalated and resume-undecidable both resolve — every named class has a path (#295 AC1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("ceiling-escalated", { worker: "w1", issue: 7, reasons: ["daily budget"] });
  state.appendEvent("resume-undecidable", { worker: "w2", issue: 8, sessionId: "s" });
  forge.issueStates[7] = "CLOSED";
  forge.issueLabels[8] = []; // resume-undecidable is label-first, so absence IS a human act
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [
    { issue: 7, source: "ceiling-escalated", via: "issue-closed" },
    { issue: 8, source: "resume-undecidable", via: "label-removed" },
  ]);
  state.close();
});

// ── transition-only (#295 AC2) ───────────────────────────────────────────────────────────────

test("reconcileEscalations: a steady-state re-sweep re-emits NOTHING and costs zero forge reads (#295 AC2)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped", { worker: "w1", issue: 7, pr: 12 });
  forge.prStates[12] = "MERGED";
  await reconcileEscalations(forge, state, mkCfg());

  forge.reads = [];
  const logged = tapEvents(state);
  await reconcileEscalations(forge, state, mkCfg());
  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  assert.deepEqual(forge.reads, []); // a resolved escalation costs nothing to re-sweep, forever
  state.close();
});

test("reconcileEscalations: a crash between observation and the latch write does not duplicate on rerun (#295 AC2)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped", { worker: "w1", issue: 7, pr: 12 });
  forge.prStates[12] = "MERGED";

  // kill -9 exactly after the observation, before the append: the append IS the latch, so
  // nothing durable landed. Simulated by making the append throw on the first attempt.
  const realAppend = state.appendEvent.bind(state);
  let crashed = false;
  state.appendEvent = (kind: string, payload: unknown) => {
    if (!crashed && kind === "escalation-resolved") {
      crashed = true;
      throw new Error("kill -9");
    }
    realAppend(kind, payload);
  };
  await reconcileEscalations(forge, state, mkCfg());
  state.appendEvent = realAppend;

  // rerun: the escalation is still open (nothing was latched), so it resolves exactly once now
  const logged = tapEvents(state);
  await reconcileEscalations(forge, state, mkCfg());
  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "gated-reentry-capped", via: "merged" }]);
  state.close();
});

test("reconcileEscalations: a still-escalated issue (label on, issue open, PR open) resolves nothing", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped", { worker: "w1", issue: 7, pr: 12 });
  forge.issueLabels[7] = [NEEDS_HUMAN];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a re-escalation after a resolution resolves a SECOND time (one event per resolution)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("drive-needs-human", { worker: "w1", issue: 7, pr: 12, reason: "r", labeled: 1 });
  forge.issueLabels[7] = [];
  await reconcileEscalations(forge, state, cfg);

  state.appendEvent("drive-needs-human", { worker: "w1", issue: 7, pr: 12, reason: "r", labeled: 1 });
  forge.issueLabels[7] = [NEEDS_HUMAN];
  const logged = tapEvents(state);
  await reconcileEscalations(forge, state, cfg); // still labelled -> nothing
  assert.deepEqual(resolvedEvents(logged), []);

  forge.issueLabels[7] = []; // human clears it again
  await reconcileEscalations(forge, state, cfg);
  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "drive-needs-human", via: "label-removed" }]);
  state.close();
});

// ── no false clears: label absence only counts when the engine PROVABLY applied the label ────

test("reconcileEscalations: drive-needs-human with labeled:0 is NOT resolved by label absence (no false clear, #295)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("drive-needs-human", { worker: "w1", issue: 7, pr: 12, reason: "r", labeled: 0, labelError: "boom" });
  forge.issueLabels[7] = []; // absent because the engine's write FAILED, not because a human acted
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a hand-merged PR resolves gated-reentry-capped-label-failed (gate② round 2 — the label-retry zombie)", async () => {
  // The capped branch's addLabel threw, so `gated-reentry-capped` never fired and the row keeps
  // failing GATED RECLAIM's `gated_escalation_labeled = 1` test forever: no engine event will
  // ever move this issue again. A hand-merge is the only thing that can end it.
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped-label-failed", { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "gated-reentry-capped-label-failed", via: "merged" }]);
  assert.deepEqual(forge.writes, []);
  state.close();
});

test("reconcileEscalations: gated-reentry-capped-label-failed is NOT resolved by label absence — the label write is what failed", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped-label-failed", { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" });
  forge.issueLabels[7] = []; // absent precisely BECAUSE the engine could not apply it
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a per-tick label-retry STREAM resolves exactly once, not once per emission (gate② round 2)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  for (let i = 0; i < 5; i++) {
    state.appendEvent("gated-reentry-capped-label-failed", { worker: "w1", issue: 7, pr: 12, attempts: 2, error: "boom" });
  }
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, cfg);
  await reconcileEscalations(forge, state, cfg); // and the sweep after it stays silent

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "gated-reentry-capped-label-failed", via: "merged" }]);
  state.close();
});

test("reconcileEscalations: env-failure-preserved (never labels, by contract) is NOT resolved by label absence", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("env-failure-preserved", { worker: "w1", issue: 7, source: "auth", pr: 12, worktreePath: "/tmp/x" });
  forge.issueLabels[7] = [];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: a still-present hold label from the WHOLE humanLabels set keeps it escalated", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("resume-capped", { worker: "w1", issue: 7, attempts: 3 });
  forge.issueLabels[7] = ["sapwood:blocked"]; // needs-human gone, but blocked is still a human hold
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

// ── degradation ─────────────────────────────────────────────────────────────────────────────

test("reconcileEscalations: a per-issue read failure leaves it unresolved this pass — never throws", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("resume-capped", { worker: "w1", issue: 7, attempts: 3 });
  state.appendEvent("resume-capped", { worker: "w2", issue: 8, attempts: 3 });
  forge.failReadsFor.add(7);
  forge.issueLabels[8] = [];
  const warnings: string[] = [];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg(), (m) => warnings.push(m));

  // #8 still resolves even though #7's read blew up
  assert.deepEqual(resolvedEvents(logged), [{ issue: 8, source: "resume-capped", via: "label-removed" }]);
  assert.equal(warnings.length, 1);
  state.close();
});

test("reconcileEscalations: nothing latched -> zero forge calls (round-level unconditional hook)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(forge.reads, []);
  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});

test("reconcileEscalations: makes zero forge WRITES across every resolution path (#295 AC3)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped", { worker: "w1", issue: 1, pr: 11 });
  state.appendEvent("resume-capped", { worker: "w2", issue: 2 });
  state.appendEvent("ceiling-escalated", { worker: "w3", issue: 3, reasons: [] });
  state.appendEvent("rollback-escalated", { issue: 4, target: "done", reason: "merged-board-done" });
  forge.prStates[11] = "MERGED";
  forge.issueLabels[2] = [];
  forge.issueStates[3] = "CLOSED";
  forge.issueStates[4] = "CLOSED";

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(forge.writes, []);
  state.close();
});

// ── #295 review round 2 (Codex P1): retry streams never reopen a terminally-resolved item ────

test("openEscalations (#295 r2): a retry re-emission AFTER a merged/closed resolution stays closed — exactly-once for retrying sources", () => {
  const events = [
    { kind: "gated-reentry-capped-label-failed", payload: { issue: 5, pr: 50 } },
    { kind: "escalation-resolved", payload: { issue: 5, pr: 50, source: "gated-reentry-capped-label-failed", via: "merged" } },
    // The label write keeps failing tick over tick — the SAME unresolved-write retry stream.
    { kind: "gated-reentry-capped-label-failed", payload: { issue: 5, pr: 50 } },
    { kind: "gated-reentry-capped-label-failed", payload: { issue: 5, pr: 50 } },
  ];
  assert.equal(openEscalations(events).size, 0, "the terminal (merged) resolution suppresses every later same-pr retry");
});

test("openEscalations (#295 r2): label-removed is NOT terminal — a later re-escalation genuinely reopens", () => {
  const events = [
    { kind: "resume-capped", payload: { issue: 6 } },
    { kind: "escalation-resolved", payload: { issue: 6, source: "resume-capped", via: "label-removed" } },
    { kind: "resume-capped", payload: { issue: 6 } }, // the lane re-escalated after the human's clear
  ];
  const open = openEscalations(events);
  assert.equal(open.size, 1);
  assert.equal(open.get("resume-capped:6")?.issue, 6);
});

test("openEscalations (#295 r2): a DIFFERENT pr after a terminal resolution is a new episode (F15 repointing), not a retry", () => {
  const events = [
    { kind: "gated-reentry-capped-label-failed", payload: { issue: 5, pr: 50 } },
    { kind: "escalation-resolved", payload: { issue: 5, pr: 50, source: "gated-reentry-capped-label-failed", via: "merged" } },
    { kind: "gated-reentry-capped-label-failed", payload: { issue: 5, pr: 72 } },
  ];
  const open = openEscalations(events);
  assert.equal(open.size, 1);
  assert.equal(open.get("gated-reentry-capped-label-failed:5")?.pr, 72);
});

test("reconcileEscalations (#295 r2): duplicate escalation-resolved never appended for a merged retrying source across two sweeps", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("gated-reentry-capped-label-failed", { worker: "w1", issue: 5, pr: 50 });
  forge.prStates[50] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());
  // The retry stream keeps emitting between sweeps (the addLabel is still failing).
  state.appendEvent("gated-reentry-capped-label-failed", { worker: "w1", issue: 5, pr: 50 });
  await reconcileEscalations(forge, state, mkCfg());

  assert.equal(resolvedEvents(logged).length, 1, "exactly one resolution, ever, for the one terminal fact");
  state.close();
});

// ── #295 review round 2 (Codex P2): fix-leg-undecidable joins the source table ───────────────

test("reconcileEscalations (#295 r2): fix-leg-undecidable resolves via external PR merge, and via label removal (label-proven by contract)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("fix-leg-undecidable", { worker: "w1", issue: 8, pr: 80 });
  forge.prStates[80] = "MERGED";
  const logged = tapEvents(state);
  await reconcileEscalations(forge, state, mkCfg());
  assert.deepEqual(resolvedEvents(logged), [{ issue: 8, pr: 80, source: "fix-leg-undecidable", via: "merged" }]);

  const state2 = new State(":memory:");
  const forge2 = new FakeForge();
  state2.appendEvent("fix-leg-undecidable", { worker: "w2", issue: 9, pr: 90 });
  forge2.issueLabels[9] = []; // human removed needs-human; PR still open
  const logged2 = tapEvents(state2);
  await reconcileEscalations(forge2, state2, mkCfg());
  assert.deepEqual(resolvedEvents(logged2), [{ issue: 9, pr: 90, source: "fix-leg-undecidable", via: "label-removed" }]);
  state.close();
  state2.close();
});

// ── #295 review round 3 (Codex P2): only MERGED is terminal — closed entities can reopen ─────

test("openEscalations (#295 r3): a closed-then-reopened entity's genuine re-escalation is NOT suppressed — only merged is terminal", () => {
  const events = [
    { kind: "resume-capped", payload: { issue: 6 } }, // pr-less source: stored/new pr are both undefined
    { kind: "escalation-resolved", payload: { issue: 6, source: "resume-capped", via: "issue-closed" } },
    // The issue was reopened and the lane re-escalated — a genuinely new attention item.
    { kind: "resume-capped", payload: { issue: 6 } },
  ];
  const open = openEscalations(events);
  assert.equal(open.size, 1, "the re-escalation after a closure genuinely reopens");
  assert.equal(open.get("resume-capped:6")?.issue, 6);
});

// ── #295 review round 4 (Codex) ──────────────────────────────────────────────────────────────

test("openEscalations: fix-rounds-capped is a tracked source — the most common escalation was missing from the table (round 4 P1)", () => {
  const open = openEscalations([{ kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12, fixRounds: 2, cap: 2 } }]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("fix-rounds-capped:7"), { source: "fix-rounds-capped", issue: 7, pr: 12, labelProven: true });
});

test("reconcileEscalations: a fix-rounds-capped lane whose PR was hand-merged resolves via 'merged' (round 4 P1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("fix-rounds-capped", { worker: "w1", issue: 7, pr: 12, fixRounds: 2, cap: 2 });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "fix-rounds-capped", via: "merged" }]);
  state.close();
});

test("openEscalations: fix-leg-verdict-rerun is a tracked source — the breaker's escalation must surface on the strip, never the F34 invisible class (#457 review round 1 P1)", () => {
  const open = openEscalations([
    { kind: "fix-leg-verdict-rerun", payload: { worker: "w1", issue: 7, pr: 12, fixRounds: 1, cap: 8, verdictRunId: "run-9" } },
  ]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("fix-leg-verdict-rerun:7"), { source: "fix-leg-verdict-rerun", issue: 7, pr: 12, labelProven: true });
});

test("reconcileEscalations: a fix-leg-verdict-rerun lane whose PR was hand-merged resolves via 'merged' — same clear semantics as fix-rounds-capped (#457 review round 1 P1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("fix-leg-verdict-rerun", { worker: "w1", issue: 7, pr: 12, fixRounds: 1, cap: 8, verdictRunId: "run-9" });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "fix-leg-verdict-rerun", via: "merged" }]);
  state.close();
});

// #451 (design #402 §4/D4, architectural review amendment 2026-07-31): review-disputed must be
// a tracked source too — same F34 invisible-escalation class the two tests above guard against,
// for conductor.ts's `escalateReviewDisputed` (the dispute-pricing escalation).

test("openEscalations: review-disputed is a tracked source — the dispute-pricing escalation must surface on the strip, never the F34 invisible class (#451)", () => {
  const open = openEscalations([
    { kind: "review-disputed", payload: { worker: "w1", issue: 7, pr: 12, headOid: "head-1", fixRounds: 1, threads: ["T1"] } },
  ]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("review-disputed:7"), { source: "review-disputed", issue: 7, pr: 12, labelProven: true });
});

test("reconcileEscalations: a review-disputed lane whose PR was hand-merged resolves via 'merged' — same clear semantics as fix-rounds-capped/fix-leg-verdict-rerun (#451)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("review-disputed", { worker: "w1", issue: 7, pr: 12, headOid: "head-1", fixRounds: 1, threads: ["T1"] });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "review-disputed", via: "merged" }]);
  state.close();
});

test("reconcileEscalations: a review-disputed lane resolves via 'label-removed' once a human clears needs-human without merging — the #147 gated-reentry reclaim path (#451)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("review-disputed", { worker: "w1", issue: 7, pr: 12, headOid: "head-1", fixRounds: 1, threads: ["T1"] });
  forge.prStates[12] = "OPEN";
  forge.issueStates[7] = "OPEN";
  forge.issueLabels[7] = []; // the human removed needs-human — #147's reclaim signal
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "review-disputed", via: "label-removed" }]);
  state.close();
});

// #450 (design #402 R3, §3c; architectural review amendment 2026-07-31, item 1): review-non-convergent
// must be a tracked source too — same F34 invisible-escalation class the tests above guard against,
// for conductor.ts's `escalateNonConvergent` (the convergence-stop escalation).

test("openEscalations: review-non-convergent is a tracked source — the convergence-stop escalation must surface on the strip, never the F34 invisible class (#450)", () => {
  const open = openEscalations([
    {
      kind: "review-non-convergent",
      payload: { worker: "w1", issue: 7, pr: 12, signal: "recurrence", fixRounds: 2, prevFindingKeys: ["a"], currFindingKeys: ["a"] },
    },
  ]);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("review-non-convergent:7"), { source: "review-non-convergent", issue: 7, pr: 12, labelProven: true });
});

test("reconcileEscalations: a review-non-convergent lane whose PR was hand-merged resolves via 'merged' — same clear semantics as fix-rounds-capped/fix-leg-verdict-rerun/review-disputed (#450)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("review-non-convergent", {
    worker: "w1",
    issue: 7,
    pr: 12,
    signal: "flat",
    fixRounds: 3,
    prevFindingKeys: [],
    currFindingKeys: [],
  });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "review-non-convergent", via: "merged" }]);
  state.close();
});

test("reconcileEscalations: a review-non-convergent lane resolves via 'label-removed' once a human clears needs-human without merging — the #147 gated-reentry reclaim path (#450)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("review-non-convergent", {
    worker: "w1",
    issue: 7,
    pr: 12,
    signal: "marginal-complexity",
    fixRounds: 1,
    prevFindingKeys: [],
    currFindingKeys: ["a"],
  });
  forge.prStates[12] = "OPEN";
  forge.issueStates[7] = "OPEN";
  forge.issueLabels[7] = []; // the human removed needs-human — #147's reclaim signal
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "review-non-convergent", via: "label-removed" }]);
  state.close();
});

// #447: `lane-revived` is the OTHER return of a `failed` lane to `driving` — same clear rule.
// #457 review round 1 (P1): `fix-leg-verdict-rerun` rides the same parametrized sweep — it must
// clear on every issue-moving kind exactly like the sources it shares the fold with.
for (const clearKind of ["dispatched", "merged", "gated-reentry", "lane-revived"]) {
  test(`openEscalations: a later '${clearKind}' on the same issue clears the item — the strip's own fold rule (round 4 P2)`, () => {
    const open = openEscalations([
      { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["x"] } },
      { kind: "env-failure-preserved", payload: { worker: "w1", issue: 7 } },
      { kind: "fix-leg-verdict-rerun", payload: { worker: "w1", issue: 7, pr: 12, fixRounds: 1, cap: 8 } },
      { kind: clearKind, payload: { worker: "w1", issue: 7 } },
    ]);
    assert.equal(open.size, 0, "every source on that issue clears, not just one key");
  });
}

test("openEscalations: a clear event does NOT suppress a genuine LATER re-escalation (clears are not terminal)", () => {
  const open = openEscalations([
    { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["x"] } },
    { kind: "dispatched", payload: { worker: "w1", issue: 7 } },
    { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["y"] } },
  ]);
  assert.equal(open.size, 1);
  assert.equal(open.get("ceiling-escalated:7")?.issue, 7);
});

test("openEscalations: a clear event on a DIFFERENT issue leaves this one open", () => {
  const open = openEscalations([
    { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["x"] } },
    { kind: "dispatched", payload: { worker: "w2", issue: 8 } },
  ]);
  assert.equal(open.size, 1);
});

test("reconcileEscalations: a ceiling-escalated event that preserved its PR resolves on an external merge (round 4 P1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("ceiling-escalated", { worker: "w1", issue: 7, reasons: ["wall-clock"], pr: 12 });
  forge.prStates[12] = "MERGED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "ceiling-escalated", via: "merged" }]);
  state.close();
});

test("openEscalations: a merge does NOT clear the rollback-escalated it just produced (round 5 P2)", () => {
  // conductor's merged branch calls handleRollbackFailure (which appends rollback-escalated with
  // reason `merged-board-done`) BEFORE appending `merged`, so the escalation has the lower id.
  // Merging the PR did not repair the failed board transition — that human task is still open.
  const open = openEscalations([
    { kind: "rollback-escalated", payload: { issue: 7, target: "done", reason: "merged-board-done" } },
    { kind: "merged", payload: { worker: "w1", issue: 7, pr: 12 } },
  ]);
  assert.equal(open.size, 1);
  assert.equal(open.get("rollback-escalated:7")?.producedBy, "merged");
});

test("openEscalations: the exemption is scoped to the PRODUCING pair — another clear kind still clears it (round 6 P2)", () => {
  // Same source, same issue: a `dispatched` does NOT produce a merged-board-done rollback, so it
  // supersedes it normally. Only the merge that produced it is exempt.
  const open = openEscalations([
    { kind: "rollback-escalated", payload: { issue: 7, target: "done", reason: "merged-board-done" } },
    { kind: "dispatched", payload: { worker: "w1", issue: 7 } },
  ]);
  assert.equal(open.size, 0);
});

test("openEscalations: a rollback-escalated from ANOTHER recovery path is cleared by a later dispatch (round 6 P2)", () => {
  // A failed Ready transition IS genuinely superseded by the issue moving. Exempting the whole
  // source would strand these forever — rollback-escalated is `never`-proof, so label removal can
  // never clear it either.
  const open = openEscalations([
    { kind: "rollback-escalated", payload: { issue: 7, target: "ready", reason: "dead-lane-requeue" } },
    { kind: "dispatched", payload: { worker: "w1", issue: 7 } },
  ]);
  assert.equal(open.size, 0);
});

test("openEscalations: a merge still clears every OTHER source on that issue", () => {
  const open = openEscalations([
    { kind: "rollback-escalated", payload: { issue: 7, target: "done", reason: "merged-board-done" } },
    { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7, reasons: ["x"] } },
    { kind: "merged", payload: { worker: "w1", issue: 7, pr: 12 } },
  ]);
  assert.deepEqual([...open.keys()], ["rollback-escalated:7"]);
});

test("openEscalations: the gate⓪ attention sources are tracked and label-proven (round 10 P1)", () => {
  const open = openEscalations([
    { kind: "plan-review-escalated", payload: { round_id: "r1", issue: 7, reason: "x", origin: "cycle-exhausted" } },
    { kind: "verify-na-proposed", payload: { round_id: "r1", issue: 8 } },
  ]);
  assert.equal(open.size, 2);
  // round 11 (Codex P1): NOT label-proven — runSessionWithRetry appends before its caller labels,
  // so a failed label write would otherwise read as a human removal on the very next sweep.
  assert.equal(open.get("plan-review-escalated:7")?.labelProven, false);
  assert.equal(open.get("verify-na-proposed:8")?.labelProven, true);
});

test("reconcileEscalations: a verify-na-proposed resolves when the human clears the flag (round 10 P1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("verify-na-proposed", { round_id: "r1", issue: 7 });
  forge.issueLabels[7] = [];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "verify-na-proposed", via: "label-removed" }]);
  state.close();
});

test("reconcileEscalations: a plan-review-escalated resolves when its issue is closed externally (round 10 P1)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("plan-review-escalated", { round_id: "r1", issue: 7, reason: "cycles", origin: "cycle-exhausted" });
  forge.issueStates[7] = "CLOSED";
  forge.issueLabels[7] = [NEEDS_HUMAN];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "plan-review-escalated", via: "issue-closed" }]);
  state.close();
});

test("reconcileEscalations: a plan-review-escalated whose label never landed is NOT falsely cleared (round 11 P1)", async () => {
  // The event can exist with no label at all (runSessionWithRetry appends before its caller
  // labels). Reading that absence as a human act would empty the strip although nobody acted.
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("plan-review-escalated", { round_id: "r1", issue: 7, reason: "cycles", origin: "cycle-exhausted" });
  forge.issueLabels[7] = [];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), []);
  state.close();
});
