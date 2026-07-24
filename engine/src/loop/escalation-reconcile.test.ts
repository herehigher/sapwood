// escalation-reconcile.test.ts (#295): the escalation-resolution reconciler's own module —
// the open-escalation fold, the read-only external observation, and the transition-only
// `escalation-resolved` append. Same "fake the collaborator, not the CLI" split every other
// peripheral's test file in this codebase uses (dissent.test.ts is the closest sibling: this
// module is the same concern-adjudication paradigm applied to needs-human escalations).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, IssueMeta, PRReviewData, PRStatus } from "../forge/forge.js";
import { State } from "../state/state.js";
import { openEscalations, reconcileEscalations } from "./escalation-reconcile.js";

/** A minimal fake IForge — every method the module under test doesn't touch is a harmless no-op
 *  (same shape as dissent.test.ts's FakeForge). `issueStates`/`issueLabels`/`prStates` are the
 *  three stores this module's getIssueMeta/getPRStatus reads come from; tests seed them directly
 *  to script a scenario. Every WRITE method records into `writes` so the read-only assertion
 *  (#295 AC3) can be made structurally rather than by inspection. */
class FakeForge implements IForge {
  issueStates: Record<number, "OPEN" | "CLOSED"> = {};
  issueLabels: Record<number, string[]> = {};
  prStates: Record<number, "OPEN" | "CLOSED" | "MERGED"> = {};
  /** Every forge WRITE this module might wrongly make lands here — asserted empty (#295 AC3). */
  writes: string[] = [];
  /** Read-call trace, so "steady state costs zero forge calls" is assertable. */
  reads: string[] = [];
  /** Issue numbers whose reads should throw (degradation test). */
  failReadsFor = new Set<number>();

  async getIssueMeta(issue: number): Promise<IssueMeta> {
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
  async getPRStatus(pr: number): Promise<PRStatus> {
    this.reads.push(`getPRStatus:${pr}`);
    return { number: pr, headOid: "x", state: this.prStates[pr] ?? "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }

  // ── writes: every one records, so AC3 ("zero writes to GitHub") is structurally checkable ──
  async claimIssue(): Promise<void> {
    this.writes.push("claimIssue");
  }
  async setBoardStatus(): Promise<void> {
    this.writes.push("setBoardStatus");
  }
  async addLabel(): Promise<void> {
    this.writes.push("addLabel");
  }
  async removeLabel(): Promise<void> {
    this.writes.push("removeLabel");
  }
  async addPRLabel(): Promise<void> {
    this.writes.push("addPRLabel");
  }
  async openPR(): Promise<number> {
    this.writes.push("openPR");
    return 1;
  }
  async mergePR(): Promise<void> {
    this.writes.push("mergePR");
  }
  async addPRComment(): Promise<void> {
    this.writes.push("addPRComment");
  }
  async addIssueComment(): Promise<void> {
    this.writes.push("addIssueComment");
  }
  async updateIssueBody(): Promise<void> {
    this.writes.push("updateIssueBody");
  }
  async createIssue(): Promise<number> {
    this.writes.push("createIssue");
    return 1;
  }
  async addSubIssue(): Promise<void> {
    this.writes.push("addSubIssue");
  }
  async replyToReviewThread(): Promise<void> {
    this.writes.push("replyToReviewThread");
  }
  async resolveReviewThread(): Promise<void> {
    this.writes.push("resolveReviewThread");
  }

  // ── unused reads ────────────────────────────────────────────────────────────────────────
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  async getSubIssues() {
    return [];
  }
  async getPRReviewData(): Promise<PRReviewData> {
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
  async getPRDiff(): Promise<string> {
    return "";
  }
  async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
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
    return this.issueLabels[issue] ?? [];
  }
  async getIssueComments() {
    return [];
  }
  async getIssueBody(): Promise<string> {
    return "";
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
  async getIssueRelations() {
    return { linkedPRs: [], crossReferences: [], truncated: false };
  }
  async searchIssues() {
    return [];
  }
  async getPRDetails() {
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
  async getPRReviews() {
    return { reviews: [], total: 0 };
  }
  async getPRReviewThreads() {
    return { threads: [], pageCapped: false };
  }
  async getPRChecks() {
    return { checks: [], total: 0 };
  }
  async getReviewThreadCommentsTail(): Promise<string[]> {
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

test("reconcileEscalations: a closed issue resolves via 'closed'", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("drive-no-pr", { worker: "w1", issue: 7 });
  forge.issueStates[7] = "CLOSED";
  forge.issueLabels[7] = [NEEDS_HUMAN]; // still labelled — closure alone resolves it
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "drive-no-pr", via: "closed" }]);
  state.close();
});

test("reconcileEscalations: a PR closed without merging resolves via 'closed'", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("env-failure-preserved", { worker: "w1", issue: 7, source: "auth", pr: 12, worktreePath: "/tmp/x" });
  forge.prStates[12] = "CLOSED";
  forge.issueLabels[7] = [NEEDS_HUMAN];
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, pr: 12, source: "env-failure-preserved", via: "closed" }]);
  state.close();
});

test("reconcileEscalations: merged-path rollback-escalated resolves once its issue closes (#295 — the permanent-latch class)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("rollback-escalated", { issue: 7, target: "done", reason: "merged-board-done", attempts: 3, error: "boom" });
  forge.issueStates[7] = "CLOSED";
  const logged = tapEvents(state);

  await reconcileEscalations(forge, state, mkCfg());

  assert.deepEqual(resolvedEvents(logged), [{ issue: 7, source: "rollback-escalated", via: "closed" }]);
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
    { issue: 7, source: "ceiling-escalated", via: "closed" },
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
