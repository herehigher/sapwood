// align.test.ts (#89, reworked by #110 PR2): the `aligning` phase's PO peripheral — goal
// decomposition (creates issues), the round-start triage pass (drafts plans into existing
// plan-less issues), and round-marker idempotence. Fakes the underlying role session
// (RoleRunner) directly, same "fake the collaborator, not the CLI" split as plan-review.test.ts.
//
// #110 PR2 rework note: the PO session no longer touches `gh` at all — every RoleSessionResult
// a test script hands the fake runner carries a `resultText` (the session's structured final
// output, see structured-output.ts) instead of an `effect` callback that used to simulate a
// direct `gh issue create/edit` side effect. The engine reads `resultText`, validates it, and
// performs every forge write itself — exactly what createAligningStub is being tested for here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS } from "../roles/peripheral.js";
import { loadRolePromptTemplate } from "../roles/plan-review.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import {
  type AlignDeps,
  alignMarker,
  buildBacklogDigest,
  createAligningStub,
  defaultPoolPromptPath,
  defaultPoPromptPath,
  loadPlanMd,
  normalizeProposalTitle,
  proposalId,
  proposalMarker,
  runPoolSelection,
  selectRoundPool,
  validateAlignOutput,
  validatePoolSelectionOutput,
  validateTriageOutput,
} from "./align.js";
import { RoundScopedForge } from "./round.js";

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  issueLabels: Record<number, string[]> = {};
  issueBodies: Record<number, string> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];
  backlogIssues: Issue[] = [];
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  boardStatusCalls: Array<[number, string]> = [];
  planTriageCandidates: Issue[] = [];

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  ready: Issue[] = [];
  async getReadyIssues(): Promise<Issue[]> {
    return this.ready;
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(n: number, s: "backlog" | "ready" | "inProgress" | "done"): Promise<void> {
    this.boardStatusCalls.push([n, s]);
  }
  addLabelCalls: Array<[number, string]> = [];
  async addLabel(n: number, l: string): Promise<void> {
    this.addLabelCalls.push([n, l]);
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  removeLabelCalls: Array<[number, string]> = [];
  async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
    this.issueLabels[n] = (this.issueLabels[n] ?? []).filter((x) => x !== l);
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> {
    this.issueCommentsPosted.push([n, body]);
  }
  async getIssueBody(issue: number): Promise<string> {
    return this.issueBodies[issue] ?? "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
    this.issueBodies[issue] = body;
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
  async createIssue(title: string, body: string): Promise<number> {
    const n = this.nextIssueNumber++;
    this.createdIssues.push({ title, body });
    this.issueBodies[n] = body;
    this.openIssueNumbers.push(n);
    this.backlogIssues.push({ number: n, title, labels: [], body });
    return n;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return this.openIssueNumbers;
  }
  async listOpenIssues(): Promise<Issue[]> {
    return this.backlogIssues;
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return this.planTriageCandidates;
  }
}

/** Scripted fake of RoleRunner.run — same shape as plan-review.test.ts's ScriptedRunner: each
 *  call consumes the next scripted result (or the last one, repeated). No `effect` callback
 *  anymore (#110 PR2) — a script step's `resultText` IS the session's entire deliverable; the
 *  engine performs every forge write from it. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(private readonly script: RoleSessionResult[]) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const step = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    return step;
  }
}

/** Builds a session's structured final-message text (structured-output.ts's sentinel format) —
 *  the same shape a real role session's last message must end in post-#110. */
const sapwoodResult = (metadata: Record<string, unknown>, body?: string): string => {
  let out = `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;
  if (body !== undefined) out += `\n${BODY_BLOCK_START}\n${body}\n${BODY_BLOCK_END}`;
  return out;
};

/** Align mode's own nested per-issue body wrapper (align.ts's ISSUE_BODY_START/END) — one
 *  wrapped segment per created issue, concatenated in metadata-array order, then handed to
 *  sapwoodResult as the single outer BODY block. */
const issueSegment = (body: string): string => `<<<ISSUE>>>\n${body}\n<<<END_ISSUE>>>`;

/** A po-align session's structured output for N created issues (title + body pairs). */
const alignResultText = (issues: Array<{ title: string; body: string }>): string => {
  if (issues.length === 0) return sapwoodResult({ issues: [] });
  return sapwoodResult({ issues: issues.map((i) => ({ title: i.title })) }, issues.map((i) => issueSegment(i.body)).join("\n"));
};

/** A po-triage session's structured output: the entire revised body for one issue. */
const triageResultText = (issue: number, body: string): string => sapwoodResult({ issue }, body);

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0.01,
  modelUsage: [],
  exitCode: 0,
  name,
  resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed",
  costUsd: 0.01,
  modelUsage: [],
  exitCode: 1,
  name,
});

/** Taps state.appendEvent so a test can assert on durable degradation events (same pattern as
 *  architect.test.ts's fable-P2 tests on PR #100). */
const tapEvents = (state: State): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  return logged;
};

const LEGACY_LABEL_CONFIG = {
  labels: {
    inProgress: "in-progress",
    needsHuman: "needs-human",
    blocked: "blocked",
    reserve: "reserve",
    verifyNa: "verify:n/a",
    planApproved: "plan:approved",
    originAgent: "origin:agent",
  },
  escalation: { humanLabels: ["needs-human", "blocked"] },
};

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...LEGACY_LABEL_CONFIG, ...over });

// A body that satisfies extractVerificationPlan (the content check createAligningStub applies
// per created/drafted issue — a business-logic outcome, never a session-validity gate).
const PLAN_BODY = "Body.\n## Verification\n- run npm test";
const NO_PLAN_BODY = "Just a title, no plan.";

test("createAligningStub: marker present -> returns it unchanged, no forge/session calls at all (idempotence)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("s1")]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  state.close();
});

test("createAligningStub: dispatches the align session with the PO tool pair (PO_ALLOWED_TOOLS + PO_DISALLOWED_TOOLS), no issues declared -> returns the round's marker", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(5));
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "po-align");
  assert.equal(runner.calls[0]!.allowedTools, PO_ALLOWED_TOOLS);
  // Security: the create-flag deny list (file exfil via --body-file, gate⓪ bypass via
  // --label, board writes via --project) must reach the session, not just exist as a const.
  assert.equal(runner.calls[0]!.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.equal(state.spentUsdForWorker("po-align-1"), 0.01);
  state.close();
});

test("createAligningStub: a declared issue with a plan section gets stamped origin:agent, never needs-human, never board status", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1);
  const expectedProposalId = proposalId(1, 0, "Do the thing");
  assert.deepEqual(forge.createdIssues[0], {
    title: "Do the thing",
    body: `${PLAN_BODY}\n\n${proposalMarker(expectedProposalId)}`,
  });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0, "the PO never sets board Status=Ready");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes("PO alignment"));
  assert.ok(comment.includes(alignMarker(1)));
  state.close();
});

test("createAligningStub #123: the phase externalizes ONE align-summary event recording created issues (with hasPlan) and triage outcomes", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }])),
    doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  const summaries = state.eventsSince("2020-01-01T00:00:00.000Z", ["align-summary"]);
  assert.equal(summaries.length, 1);
  const p = summaries[0]!.payload as {
    round_id: number;
    created: Array<{ issue: number; title: string; hasPlan: boolean }>;
    triaged: Array<{ issue: number; drafted: boolean }>;
  };
  assert.equal(p.round_id, 1);
  assert.deepEqual(p.created, [{ issue: forge.openIssueNumbers[0]!, title: "Do the thing", hasPlan: true }]);
  assert.deepEqual(p.triaged, [{ issue: 9, drafted: true }]);
  state.close();
});

test("createAligningStub #123: a DEGRADED align pass emits NO align-summary — downstream reads a missing summary, never a successful 'decomposed nothing' (Codex P2, PR #152)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  // Both attempts fail — runSessionWithRetry degrades (po-degraded event fires there).
  const runner = new ScriptedRunner([
    { outcome: "failed", costUsd: 0, modelUsage: [], exitCode: 1, name: "po-align-1" },
    { outcome: "failed", costUsd: 0, modelUsage: [], exitCode: 1, name: "po-align-2" },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(state.eventsSince("2020-01-01T00:00:00.000Z", ["align-summary"]).length, 0);
  state.close();
});

test("createAligningStub: a declared issue WITHOUT a plan section is escalated needs-human, never left silently planless", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "Vague issue", body: NO_PLAN_BODY }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 2, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"), "still stamped, even when planless");
  assert.ok(forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0);
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(/no verification plan/.test(comment));
  state.close();
});

test("createAligningStub: multiple declared issues are each processed independently, in metadata-array order", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult(
      "po-align-1",
      alignResultText([
        { title: "a", body: "## Acceptance criteria\n- x" },
        { title: "b", body: "no plan here" },
      ]),
    ),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.openIssueNumbers.length, 2);
  assert.deepEqual(
    forge.createdIssues.map((i) => i.title),
    ["a", "b"],
  );
  const [a, b] = forge.openIssueNumbers as [number, number];
  assert.ok(forge.issueLabels[a]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[a]!.includes(cfg.labels.needsHuman));
  assert.ok(forge.issueLabels[b]!.includes("origin:agent"));
  assert.ok(forge.issueLabels[b]!.includes(cfg.labels.needsHuman));
  state.close();
});

// ── #216: persist-first proposal creation + per-proposal crash recovery ───────────────────

const THREE_PROPOSALS = [
  { title: "first", body: PLAN_BODY },
  { title: "second", body: PLAN_BODY },
  { title: "third", body: PLAN_BODY },
];

test("createAligningStub #216: crash before the first creation leaves a durable proposal set; rerun creates the full persisted batch once", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let failFirst = true;
  forge.createIssue = async (title, body) => {
    assert.equal(state.eventsAfterId(0, ["proposal-set-persisted"]).length, 1, "proposal set lands before create");
    if (failFirst) {
      failFirst = false;
      throw new Error("crash before create");
    }
    return realCreate(title, body);
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () => createAligningStub({ forge, state, cfg, runner: firstRunner }).run({ roundId: 216, phase: "aligning", marker: null }),
    /crash before create/,
  );
  assert.equal(forge.createdIssues.length, 0);

  // The scripted result deliberately differs, but must never be consumed: externalization
  // replays the already-persisted validated set without starting another align session.
  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText([]))]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 216, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0, "a persisted proposal set bypasses the align session entirely");
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 3);
  state.close();
});

test("createAligningStub #216: crash after k of n creations reruns exactly the remaining n-k", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let attempts = 0;
  forge.createIssue = async (title, body) => {
    attempts++;
    if (attempts === 3) throw new Error("crash after two");
    return realCreate(title, body);
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () => createAligningStub({ forge, state, cfg, runner: firstRunner }).run({ roundId: 217, phase: "aligning", marker: null }),
    /crash after two/,
  );
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second"],
  );

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 217, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 3);
  const summaries = state.eventsAfterId(0, ["align-summary"]);
  assert.equal(summaries.length, 1);
  assert.deepEqual((summaries[0]!.payload as { created: Array<{ issue: number; title: string; hasPlan: boolean }> }).created, [
    { issue: 100, title: "first", hasPlan: true },
    { issue: 101, title: "second", hasPlan: true },
    { issue: 102, title: "third", hasPlan: true },
  ]);
  state.close();
});

test("createAligningStub #216: lost creation receipt reconciles by body marker and never recreates the accepted in-flight issue", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let attempts = 0;
  forge.createIssue = async (title, body) => {
    attempts++;
    const issue = await realCreate(title, body); // GitHub accepted it
    if (attempts === 2) throw new Error("receipt lost");
    return issue;
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () => createAligningStub({ forge, state, cfg, runner: firstRunner }).run({ roundId: 218, phase: "aligning", marker: null }),
    /receipt lost/,
  );
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second"],
  );

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 218, phase: "aligning", marker: null });
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  const receipts = state.eventsAfterId(0, ["proposal-created"]).map((event) => event.payload as { reconciled?: boolean });
  assert.ok(receipts.some((receipt) => receipt.reconciled === true));
  state.close();
});

test("createAligningStub #216: milestone-scoped lost receipt sees an unassigned marker and does not recreate", async () => {
  const innerForge = new FakeForge();
  const forge = new RoundScopedForge(innerForge, "M4");
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { milestone: "M4" } });
  const realCreate = innerForge.createIssue.bind(innerForge);
  let loseReceipt = true;
  innerForge.createIssue = async (title, body) => {
    const issue = await realCreate(title, body);
    if (loseReceipt) {
      loseReceipt = false;
      throw new Error("accepted without receipt");
    }
    return issue;
  };
  await assert.rejects(
    () =>
      createAligningStub({
        forge,
        state,
        cfg,
        runner: new ScriptedRunner([doneResult("po-align-1", alignResultText([THREE_PROPOSALS[0]!]))]),
      }).run({ roundId: 221, phase: "aligning", marker: null }),
    /accepted without receipt/,
  );
  assert.equal(innerForge.createdIssues.length, 1);
  assert.equal(innerForge.backlogIssues[0]!.milestone, undefined, "createIssue assigns no milestone");

  const rerun = new ScriptedRunner([failedResult("must-not-run")]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 221, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.equal(innerForge.createdIssues.length, 1, "the full-backlog marker scan reconciles instead of recreating");
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 1);
  state.close();
});

test("createAligningStub #216: proposal receipt lands only after reconciled governance labels, fence, and comment complete", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realAddIssueComment = forge.addIssueComment.bind(forge);
  let failComment = true;
  forge.addIssueComment = async (issue, body) => {
    if (failComment) {
      failComment = false;
      throw new Error("crash before audit comment");
    }
    return realAddIssueComment(issue, body);
  };
  await assert.rejects(
    () =>
      createAligningStub({
        forge,
        state,
        cfg,
        runner: new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "planless", body: NO_PLAN_BODY }]))]),
      }).run({ roundId: 222, phase: "aligning", marker: null }),
    /crash before audit comment/,
  );
  assert.equal(forge.createdIssues.length, 1);
  const issue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.originAgent));
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 0, "partial governance is not terminal");

  const rerun = new ScriptedRunner([failedResult("must-not-run")]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 222, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.originAgent));
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.issueCommentsPosted.filter(([number]) => number === issue).length, 1);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 1);
  state.close();
});

test("createAligningStub #216: divergent proposal journal records honesty and advances with zero forge writes", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const roundId = 224;
  const title = "persisted proposal";
  state.appendEvent("proposal-set-persisted", {
    round_id: roundId,
    proposals: [{ proposalId: proposalId(roundId, 0, title), index: 0, title, body: PLAN_BODY }],
  });
  state.appendEvent("proposal-created", { round_id: roundId, proposalId: "unknown-proposal", issue: 77 });
  const logs: string[] = [];
  const runner = new ScriptedRunner([doneResult("must-not-run", alignResultText([]))]);

  const result = await createAligningStub({ forge, state, cfg: mkCfg(), runner, log: (line) => logs.push(line) }).run({
    roundId,
    phase: "aligning",
    marker: null,
  });

  assert.equal(result.marker, alignMarker(roundId));
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(Object.values(forge.issueLabels).flat().length, 0);
  const honesty = state.eventsAfterId(0, ["proposal-journal-corrupt"]);
  assert.deepEqual(honesty[0]!.payload, {
    round_id: roundId,
    reason: `unknown terminal proposal unknown-proposal for round ${roundId}`,
  });
  assert.match(logs[0]!, /proposal journal corrupt — creating nothing/);
  state.close();
});

test("createAligningStub #216: corrupt proposal journal records honesty and advances with zero forge writes", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 7, title: "would otherwise triage", labels: [], body: NO_PLAN_BODY }];
  const state = new State(":memory:");
  state.appendEvent("proposal-set-persisted", { round_id: 223, proposals: "not-an-array" });
  const logs: string[] = [];
  const runner = new ScriptedRunner([doneResult("must-not-run", alignResultText([]))]);
  const result = await createAligningStub({ forge, state, cfg: mkCfg(), runner, log: (line) => logs.push(line) }).run({
    roundId: 223,
    phase: "aligning",
    marker: null,
  });
  assert.equal(result.marker, alignMarker(223));
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(
    {
      creates: forge.createdIssues.length,
      labels: Object.values(forge.issueLabels).flat().length,
      comments: forge.issueCommentsPosted.length,
      bodyUpdates: forge.updateIssueBodyCalls.length,
    },
    { creates: 0, labels: 0, comments: 0, bodyUpdates: 0 },
  );
  const honesty = state.eventsAfterId(0, ["proposal-journal-corrupt"]);
  assert.equal(honesty.length, 1);
  assert.deepEqual(honesty[0]!.payload, { round_id: 223, reason: "malformed persisted proposal set for round 223" });
  assert.match(logs[0]!, /proposal journal corrupt — creating nothing/);
  state.close();
});

test("createAligningStub #216: normalized-title collision is skipped with a durable honesty event", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 44, title: "Fix:  Payment   Retry!", labels: [], body: "existing" }];
  assert.equal(normalizeProposalTitle("FIX payment retry"), normalizeProposalTitle(forge.backlogIssues[0]!.title));
  const state = new State(":memory:");
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "FIX payment retry", body: PLAN_BODY }]))]);
  await createAligningStub({ forge, state, cfg: mkCfg(), runner }).run({ roundId: 219, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 0);
  const skipped = state.eventsAfterId(0, ["proposal-skipped"]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0]!.payload, {
    round_id: 219,
    proposalId: proposalId(219, 0, "FIX payment retry"),
    title: "FIX payment retry",
    reason: "normalized-title-collision",
    existingIssue: 44,
  });
  state.close();
});

test("createAligningStub #216: marker-null full-success rerun performs zero forge writes", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const first = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ forge, state, cfg, runner: first }).run({ roundId: 220, phase: "aligning", marker: null });
  const writes = {
    creates: forge.createdIssues.length,
    labels: Object.values(forge.issueLabels).flat().length,
    comments: forge.issueCommentsPosted.length,
  };

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ forge, state, cfg, runner: rerun }).run({ roundId: 220, phase: "aligning", marker: null });
  assert.deepEqual(
    {
      creates: forge.createdIssues.length,
      labels: Object.values(forge.issueLabels).flat().length,
      comments: forge.issueCommentsPosted.length,
    },
    writes,
  );
  state.close();
});

test("createAligningStub: triage pass briefs a po-triage session per plan-less candidate, posts a traceable comment", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 50, title: "human-filed, no plan", labels: [], body: "just a description" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])), // align pass: declares nothing
    doneResult("po-triage-50", triageResultText(50, "just a description\n## Verification\n- run npm test")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 6, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage"],
  );
  assert.equal(runner.calls[1]!.allowedTools, PO_ALLOWED_TOOLS);
  assert.equal(runner.calls[1]!.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.ok(runner.calls[1]!.prompt.includes("#50"));
  assert.equal(state.spentUsdForWorker("po-triage-50"), 0.01);
  assert.deepEqual(forge.updateIssueBodyCalls, [[50, "just a description\n## Verification\n- run npm test"]]);
  const comment = forge.issueCommentsPosted.find(([n]) => n === 50)?.[1] ?? "";
  assert.ok(comment.includes("PO triage"));
  assert.ok(comment.includes(alignMarker(6)));
  assert.equal(marker, alignMarker(6));
  state.close();
});

test("createAligningStub: triage processes every candidate independently", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 60, title: "a", labels: [], body: "" },
    { number: 61, title: "b", labels: [], body: "" },
  ];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-60", triageResultText(60, "## Verification\n- a")),
    doneResult("po-triage-61", triageResultText(61, "## Verification\n- b")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 7, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage", "po-triage"],
  );
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 60));
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 61));
  state.close();
});

// ── marker-idempotence across a re-run (rerun-not-resume, #77 decision 4) ───────────────────

test("createAligningStub: re-running the SAME round after a marker was already set drafts nothing twice", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 70, title: "t", labels: [], body: "" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-70", triageResultText(70, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const first = await stub.run({ roundId: 8, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2);
  const commentsAfterFirst = forge.issueCommentsPosted.length;

  // Simulate round.ts re-invoking the stub for the SAME phase after a crash/rerun — the
  // persisted marker from the first attempt is handed back in.
  const second = await stub.run({ roundId: 8, phase: "aligning", marker: first.marker });
  assert.equal(second.marker, first.marker);
  assert.equal(runner.calls.length, 2, "no new session dispatched on the idempotent re-run");
  assert.equal(forge.issueCommentsPosted.length, commentsAfterFirst, "no duplicate comments posted");
  state.close();
});

// ── session-failure handling (fable PR #101 P2 — RoleRunner.run never throws on the
//    session's own outcome, so failed/timeout must be handled here) ──────────────────────────

test("createAligningStub P2: a failed align session is retried once; a successful retry proceeds normally (declared issues processed, both spends ledgered, no degradation event)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    failedResult("po-align-0"),
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 10, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "exactly one retry");
  assert.equal(marker, alignMarker(10));
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.equal(state.spentUsdForWorker("po-align-0"), 0.01);
  assert.equal(state.spentUsdForWorker("po-align-0-retry"), 0.01);
  assert.ok(!logged.some(([kind]) => kind === "po-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createAligningStub P2: two failed align sessions -> marker STILL set (next round retries naturally), po-degraded durably appended, triage still runs, nothing created", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 80, title: "t", labels: [], body: "" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    failedResult("po-align-0"),
    failedResult("po-align-0-retry"),
    doneResult("po-triage-80", triageResultText(80, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 11, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(11), "the round still advances — pre-Ready, low stakes");
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-align", "po-triage"],
    "one retry, then triage proceeds",
  );
  assert.equal(forge.createdIssues.length, 0, "a twice-failed session creates nothing — the engine is the only creator");
  const ev = logged.find(([kind]) => kind === "po-degraded");
  assert.ok(ev, "degradation is durably visible, never a silent skip");
  assert.equal((ev![1] as { round_id: number }).round_id, 11);
  state.close();
});

test("createAligningStub P2: a failed triage session is retried once; the success comment posts only after the retry's draft actually landed", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 81, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    failedResult("po-triage-81"),
    doneResult("po-triage-81-retry", triageResultText(81, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 12, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage", "po-triage"],
  );
  assert.ok(
    forge.issueCommentsPosted.some(([n]) => n === 81),
    "success comment after the converged retry",
  );
  assert.ok(!logged.some(([kind]) => kind === "triage-degraded"));
  state.close();
});

test("createAligningStub P2: two failed triage sessions -> NO success comment (never a false audit-trail claim), triage-degraded durably appended, candidate left to re-match next round", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 82, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    failedResult("po-triage-82"),
    failedResult("po-triage-82-retry"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 13, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(13), "the round still advances — pre-Ready, low stakes");
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 82), "no comment claiming a draft that never landed");
  assert.equal(forge.updateIssueBodyCalls.length, 0, "a twice-failed session's output is never written");
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 82);
  state.close();
});

test("createAligningStub P2: a 'done' triage session whose VALID output left the body STILL planless posts no success comment either — content-checked, not trusted, and NOT retried (schema validity ≠ content truth)", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 83, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  // Session reports success with a WELL-FORMED structured block, but the drafted body itself
  // still has no verification-plan section (a content-invariant failure, not a shape one).
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-83", triageResultText(83, "still no plan here")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 14, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "not retried — schema-valid output is a DONE attempt, even if content-checked afterward");
  assert.deepEqual(
    forge.updateIssueBodyCalls,
    [[83, "still no plan here"]],
    "the (planless) draft is still written — the write is earned by validity, not by content",
  );
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 83), "the success comment is earned by the content check, not by exit code");
  assert.ok(logged.some(([kind]) => kind === "triage-degraded"));
  state.close();
});

// ── malformed structured output -> fail-closed, same isValid-driven retry+degrade path as a
//    crashed session (#110's "malformed twice -> the role's existing degrade path") ──────────

test("createAligningStub #110: a malformed align block (no sentinel at all) is retried once, then degrades — nothing created, marker still set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-0", "I created some issues, trust me."), // no structured block at all
    doneResult("po-align-0-retry", "still nothing structured"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 15, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "one retry, per #110's isValid-driven retry contract");
  assert.equal(marker, alignMarker(15), "the round is never wedged");
  assert.equal(forge.createdIssues.length, 0);
  const ev = logged.find(([kind]) => kind === "po-degraded");
  assert.ok(ev);
  state.close();
});

test("createAligningStub #110: a malformed align block on the FIRST attempt is retried once and a well-formed second attempt succeeds normally", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-0", "not structured at all"),
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 16, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1, "the converged retry's declared issue IS created");
  assert.ok(!logged.some(([kind]) => kind === "po-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createAligningStub #110: a malformed triage block is retried once, then degrades via triage-degraded — no write, candidate re-matches next round", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 90, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-90", "no sentinel here"),
    doneResult("po-triage-90-retry", "still no sentinel"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 17, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 0);
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 90));
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 90);
  state.close();
});

test("createAligningStub #110 (Codex round 1): a duplicate-title align batch twice -> align's degrade path, NOTHING created (never a double-create)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const dupText = alignResultText([
    { title: "Add X", body: PLAN_BODY },
    { title: "Add X", body: PLAN_BODY },
  ]);
  const runner = new ScriptedRunner([doneResult("po-align-0", dupText), doneResult("po-align-0-retry", dupText)]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 19, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "invalid output is retried once, then degrades");
  assert.equal(marker, alignMarker(19), "the round still advances");
  assert.equal(forge.createdIssues.length, 0, "zero createIssue calls — the duplicate batch is rejected whole, never partially applied");
  assert.ok(logged.some(([kind]) => kind === "po-degraded"));
  state.close();
});

test("createAligningStub #110: an align block with a wrong number of <<<ISSUE>>> body segments is malformed, not silently truncated/misassigned", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    // Metadata declares 2 issues, but the BODY block only carries one segment.
    doneResult("po-align-0", sapwoodResult({ issues: [{ title: "a" }, { title: "b" }] }, issueSegment("only one body"))),
    doneResult("po-align-0-retry", alignResultText([{ title: "a", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 18, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "the mismatched first attempt was retried");
  assert.equal(forge.createdIssues.length, 1, "only the converged retry's single issue was created");
  state.close();
});

// ── labels.originAgent is config-driven (fable PR #101 P3) ──────────────────────────────────

test("createAligningStub P3: a customized labels.originAgent value is what gets stamped — never a hardcoded 'origin:agent'", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ labels: { ...LEGACY_LABEL_CONFIG.labels, originAgent: "bot:made" } });
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "t", body: "## Verification\n- x" }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 23, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("bot:made"));
  assert.ok(!forge.issueLabels[newIssue]!.includes("origin:agent"));
  state.close();
});

// ── template rendering + loading (unit) ─────────────────────────────────────────────────────

test("defaultPoPromptPath: resolves to a real shipped file with both align and triage sections", () => {
  const template = loadRolePromptTemplate(undefined, defaultPoPromptPath());
  assert.ok(template.includes("{{po.mode}}"));
  assert.ok(template.includes("{{round.milestone}}"));
  assert.ok(template.includes("{{plan.md}}"));
  assert.ok(template.includes("{{issue.number}}"));
  assert.ok(template.includes("{{issue.body}}"));
  assert.ok(template.includes("{{round.directive}}"), "#126: the shipped po.md must reference the round directive var");
  assert.ok(template.includes("{{backlog.digest}}"));
});

test("buildBacklogDigest: number-sorted titles + configured hold annotations are deterministic and capDigest-bounded", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { backlogDigestMaxChars: 200 } } });
  forge.backlogIssues = [
    { number: 20, title: "z".repeat(220), labels: ["blocked"] },
    { number: 3, title: "Earlier gap", labels: ["NEEDS-HUMAN", "unrelated"] },
  ];
  const first = await buildBacklogDigest(forge, cfg);
  forge.backlogIssues.reverse();
  const rerun = await buildBacklogDigest(forge, cfg);
  assert.equal(first, rerun, "the same backlog is byte-identical regardless of forge ordering");
  assert.equal(first.length, 200);
  assert.match(first, /^- #3 — Earlier gap \[hold: needs-human\]/);
  assert.match(first, /digest truncated/);
});

test("buildBacklogDigest: zero issues and a contained read failure are distinct explicit lines", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  assert.equal(await buildBacklogDigest(forge, cfg), "(no open issues yet)");
  forge.listOpenIssues = async () => {
    throw new Error("forge unavailable");
  };
  assert.equal(await buildBacklogDigest(forge, cfg), "(backlog digest unavailable: open-issue read failed)");
});

test("buildBacklogDigest #215/#216: milestone filtering is local to the digest consumer", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [
    { number: 1, title: "M4 work", labels: [], milestone: "M4" },
    { number: 2, title: "M5 work", labels: [], milestone: "M5" },
    { number: 3, title: "unassigned proposal", labels: [] },
  ];
  assert.equal(await buildBacklogDigest(forge, mkCfg({ round: { milestone: "M4" } })), "- #1 — M4 work");
  assert.match(await buildBacklogDigest(forge, mkCfg()), /#3 — unassigned proposal/);
});

test("createAligningStub #215: the align prompt receives only the milestone-scoped current backlog digest", async () => {
  const innerForge = new FakeForge();
  innerForge.backlogIssues = [
    { number: 42, title: "Existing bounded work", labels: ["blocked"], milestone: "M4" },
    { number: 43, title: "Other milestone work", labels: [], milestone: "M5" },
  ];
  const forge = new RoundScopedForge(innerForge, "M4");
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  await createAligningStub({ forge, state, cfg: mkCfg({ round: { milestone: "M4" } }), runner }).run({
    roundId: 1,
    phase: "aligning",
    marker: null,
  });
  assert.ok(runner.calls[0]!.prompt.includes("- #42 — Existing bounded work [hold: blocked]"));
  assert.ok(!runner.calls[0]!.prompt.includes("Other milestone work"));
  assert.ok(!runner.calls[0]!.prompt.includes("{{backlog.digest}}"));
  state.close();
});

test("createAligningStub #215: a pre-existing custom PO prompt without {{backlog.digest}} still renders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-po-custom-"));
  try {
    const promptPath = join(dir, "po.md");
    writeFileSync(promptPath, "custom mode={{po.mode}}\ndirective={{round.directive}}\n");
    const forge = new FakeForge();
    forge.backlogIssues = [{ number: 8, title: "Unused by this override", labels: [] }];
    const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const state = new State(":memory:");
    await createAligningStub({ forge, state, cfg: mkCfg({ roles: { po: { promptFile: promptPath } } }), runner }).run({
      roundId: 1,
      phase: "aligning",
      marker: null,
    });
    assert.match(runner.calls[0]!.prompt, /^custom mode=align/m);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#128: a real caller (deps.planMdPath omitted) renders {{plan.md}} from cfg.goal.file, the single resolved north-star path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-goalfile-"));
  try {
    const goalPath = join(dir, "GOAL.md");
    writeFileSync(goalPath, "# North star\nOnly ship what advances the north star.\n");
    const forge = new FakeForge();
    // cfg.goal.file is config-file-relative resolved by loadConfig in a real run; here we set
    // it directly to an absolute path, mirroring what loadConfig would have produced.
    const cfg = mkCfg({ goal: { file: goalPath } });
    const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const state = new State(":memory:");
    const deps: AlignDeps = { forge, state, cfg, runner }; // no deps.planMdPath override
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 1, phase: "aligning", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("Only ship what advances the north star."));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #126: round directive file — human steering injected at round open ─────────────────────

test("createAligningStub #126: no directive file -> both the align session AND every triage session render the explicit 'none' placeholder, no directive-applied event", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const cfg = mkCfg({ round: { directiveFile: join(dir, "DIRECTIVE.md") } });
    const runner = new ScriptedRunner([
      doneResult("po-align-1", alignResultText([])),
      doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
    ]);
    const state = new State(":memory:");
    const deps: AlignDeps = { forge, state, cfg, runner };
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 1, phase: "aligning", marker: null });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.ok(call.prompt.includes("No round directive was provided for this round."));
    }
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub #126: a directive file is substituted into BOTH the align and triage prompts, one directive-applied event recorded, and the file is archived out of the live path", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Prioritize the payments module this round.", "utf8");
    const cfg = mkCfg({ round: { directiveFile } });
    const runner = new ScriptedRunner([
      doneResult("po-align-1", alignResultText([])),
      doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
    ]);
    const state = new State(":memory:");
    const deps: AlignDeps = { forge, state, cfg, runner };
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 4, phase: "aligning", marker: null });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.ok(call.prompt.includes("Prioritize the payments module this round."));
    }
    const events = state.eventsAfterId(0, ["directive-applied"]);
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { round_id: number; path: string; content: string; sha256: string };
    assert.equal(payload.round_id, 4);
    assert.equal(payload.path, directiveFile);
    assert.equal(payload.content, "Prioritize the payments module this round.");
    assert.match(payload.sha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(directiveFile), false, "consumed: archived out of the live path");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub #126: crash-rerun — a resumed call for the SAME round (marker still null) reuses the recorded directive content, never a duplicate event, even if the live file is re-dropped in between", async () => {
  const forge = new FakeForge();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "original steering", "utf8");
    const cfg = mkCfg({ round: { directiveFile } });
    const state = new State(":memory:");

    const runner1 = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const deps1: AlignDeps = { forge, state, cfg, runner: runner1 };
    await createAligningStub(deps1).run({ roundId: 2, phase: "aligning", marker: null });
    assert.ok(runner1.calls[0]!.prompt.includes("original steering"));

    // Simulate a crash-then-resume: the SAME round is re-entered at aligning (marker still
    // null — the earlier attempt never got far enough to persist one) after an operator (or a
    // race) leaves a DIFFERENT file at the live path.
    writeFileSync(directiveFile, "a later, different directive", "utf8");
    forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
    const runner2 = new ScriptedRunner([doneResult("po-triage-2", triageResultText(9, PLAN_BODY))]);
    const deps2: AlignDeps = { forge, state, cfg, runner: runner2 };
    await createAligningStub(deps2).run({ roundId: 2, phase: "aligning", marker: null });
    assert.equal(runner2.calls.length, 1, "the persisted proposal set skips po-align; triage still runs");
    assert.equal(runner2.calls[0]!.roleId, "po-triage");
    assert.ok(runner2.calls[0]!.prompt.includes("original steering"));
    assert.ok(!runner2.calls[0]!.prompt.includes("a later, different directive"));

    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event across the resumed call");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanMd: reads a real file; a missing path degrades to empty string (contained, never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-align-"));
  try {
    const p = join(dir, "PLAN.md");
    writeFileSync(p, "# The Plan\ngoals here");
    assert.equal(loadPlanMd(p), "# The Plan\ngoals here");
    assert.equal(loadPlanMd(join(dir, "nonexistent.md")), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PO_ALLOWED_TOOLS: #110 PR5 — no Bash grant at all (issue creation is now an engine write from validated structured output above), and still no board-status/project capability (structural no-Ready guarantee)", () => {
  assert.ok(!PO_ALLOWED_TOOLS.includes("Bash("), "no Bash(...) entry of any kind");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh api"), "no channel to board-status/project mutation");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh project"));
  assert.ok(!PO_ALLOWED_TOOLS.includes("git"), "no code/repo capability");
});

// ── #110 PR2: structured-output parsing/validation — unit tests, no session dispatch ─────────

test("validateAlignOutput: no structured block at all -> fail-closed", () => {
  const result = validateAlignOutput("just some prose, no sentinel");
  assert.equal(result.ok, false);
});

test("validateAlignOutput: truncated sentinel (no matching end) -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\n{"issues":[]`;
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
});

test("validateAlignOutput: JSON-invalid metadata -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\nnot json\n${RESULT_BLOCK_END}`;
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /not valid JSON/.test(result.reason));
});

test("validateAlignOutput: a smuggled 'labels' field in an issue entry is rejected outright (.strict() schema) — proves a poisoned dispatch-path label at creation is structurally impossible, not just caught after the fact", () => {
  const text = sapwoodResult({ issues: [{ title: "t", labels: ["plan:approved"] }] }, issueSegment(PLAN_BODY));
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /schema validation/.test(result.reason));
});

test("validateAlignOutput (Codex round 1): duplicate titles in one batch -> fail-closed, rejected whole (would double-create the same issue)", () => {
  const result = validateAlignOutput(
    alignResultText([
      { title: "Add X", body: "Body one." },
      { title: "Add X", body: "Body two." },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /duplicate issue title/.test(result.reason));
});

test("validateAlignOutput: empty issues array with a stray BODY block present -> fail-closed", () => {
  const text = sapwoodResult({ issues: [] }, "unexpected body text");
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
});

test("validateAlignOutput: issues declared but no BODY block at all -> fail-closed", () => {
  const text = sapwoodResult({ issues: [{ title: "t" }] });
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /BODY block/.test(result.reason));
});

test("validateAlignOutput: well-formed empty declaration -> ok, empty array", () => {
  const result = validateAlignOutput(alignResultText([]));
  assert.ok(result.ok && result.issues.length === 0);
});

test("validateAlignOutput: well-formed multi-issue declaration -> ok, titles and bodies paired in order", () => {
  const result = validateAlignOutput(
    alignResultText([
      { title: "first", body: "Body one." },
      { title: "second", body: "Body two." },
    ]),
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.issues, [
      { title: "first", body: "Body one." },
      { title: "second", body: "Body two." },
    ]);
  }
});

test("validateTriageOutput: missing body -> fail-closed", () => {
  const text = sapwoodResult({ issue: 1 });
  const result = validateTriageOutput(text, 1);
  assert.equal(result.ok, false);
});

test("validateTriageOutput: issue number mismatch -> fail-closed", () => {
  const text = triageResultText(999, PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /mismatch/.test(result.reason));
});

test("validateTriageOutput: well-formed draft, EVEN with no verification plan, is schema-ok (content is checked separately by the caller)", () => {
  const text = triageResultText(1, NO_PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.ok(result.ok);
});

test("validateTriageOutput: well-formed draft -> ok, returns the body verbatim", () => {
  const text = triageResultText(1, PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.ok(result.ok && result.body === PLAN_BODY);
});

// ── #212: selectRoundPool ────────────────────────────────────────────────────────────────────

const mkReady = (number: number, prio: number, milestone?: string): Issue => ({
  number,
  title: `issue ${number}`,
  labels: [`sapwood:prio:${prio}`],
  ...(milestone !== undefined ? { milestone } : {}),
});

test("selectRoundPool: caps the pool at ceil(lanes.roundDispatchCap * round.poolFactor)", async () => {
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5].map((n) => mkReady(n, 3));
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1.5 } }); // cap = ceil(3) = 3
  const selected = await selectRoundPool({ forge, cfg });
  assert.equal(selected.length, 3, "exactly ceil(2 * 1.5) = 3 issues selected");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.ok(
    forge.addLabelCalls.every(([, l]) => l === cfg.labels.roundPool),
    "only the pool label is ever applied",
  );
  assert.equal(forge.issueLabels[4], undefined, "issue #4 (past the cap) was never labelled");
});

test("selectRoundPool: orders by prio label ascending (prio:0 first) then issue number ascending", async () => {
  const forge = new FakeForge();
  forge.ready = [mkReady(30, 2), mkReady(10, 0), mkReady(20, 0), mkReady(40, 1)];
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1 } }); // cap = 10, everyone fits
  const selected = await selectRoundPool({ forge, cfg });
  assert.deepEqual(
    selected.map((i) => i.number),
    [10, 20, 40, 30],
    "prio:0 (10 then 20 by number) -> prio:1 (40) -> prio:2 (30)",
  );
});

test("selectRoundPool: milestone-scoped when the caller passes an already-scoped forge (RoundScopedForge) — never re-derives scoping itself", async () => {
  const forge = new FakeForge();
  forge.ready = [mkReady(1, 0, "M4"), mkReady(2, 0), mkReady(3, 0, "M4"), mkReady(4, 0, "M5")];
  const scoped = new RoundScopedForge(forge, "M4");
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1, milestone: "M4" } });
  const selected = await selectRoundPool({ forge: scoped, cfg });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 3],
    "only the M4-milestone issues were selected",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 3],
  );
});

test("selectRoundPool: idempotent — an already-pool-labelled issue is not re-labelled (crash-rerun safety)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1 } });
  forge.ready = [{ number: 1, title: "a", labels: [cfg.labels.roundPool] }, mkReady(2, 3)];
  const selected = await selectRoundPool({ forge, cfg });
  assert.equal(selected.length, 2, "both issues are still part of the selection");
  assert.deepEqual(forge.addLabelCalls, [[2, cfg.labels.roundPool]], "issue #1 was already labelled — no redundant write");
});

test("selectRoundPool: a Ready read failure degrades to an empty pool (logged, never thrown)", async () => {
  const cfg = mkCfg();
  const logged: string[] = [];
  const forge = new (class extends FakeForge {
    override async getReadyIssues(): Promise<Issue[]> {
      throw new Error("simulated forge outage");
    }
  })();
  const selected = await selectRoundPool({ forge, cfg, log: (m) => logged.push(m) });
  assert.deepEqual(selected, []);
  assert.equal(forge.addLabelCalls.length, 0);
  assert.ok(logged.some((l) => l.includes("simulated forge outage")));
});

// ── #212/#233 gate① F1: runPoolSelection — the PO's OWN, now OPT-IN, pool-selection session ────

/** A po-pool session's structured output: the selected issue numbers only, no BODY block. */
const poolResultText = (selected: number[]): string => sapwoodResult({ selected });

test("runPoolSelection (#233 AC1): the deterministic DEFAULT path (roles.po.poolSelection=false) still writes the durable pool-selected event, even though no session ran", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2, poolSelection defaults false
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 3 });
  assert.equal(runner.calls.length, 0, "no session ran on the deterministic default path");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
  );
  const events = state.eventsAfterId(0, ["pool-selected"]);
  assert.equal(events.length, 1, "the durable event is written even though selection was purely deterministic (#233 AC1)");
  assert.deepEqual(events[0]!.payload, { round_id: 3, issues: [1, 2] }, "the event records exactly what was acted on");
});

test("runPoolSelection (#233 AC1 mirror): the opt-in SESSION path (roles.po.poolSelection=true) also writes the durable pool-selected event, recording the validated selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 4 });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  const events = state.eventsAfterId(0, ["pool-selected"]);
  assert.equal(events.length, 1, "the durable event is written on the session path too");
  assert.deepEqual(
    events[0]!.payload,
    { round_id: 4, issues: [1] },
    "the event records the session's validated (proper subset) selection, not the full candidate set",
  );
});

test("runPoolSelection: roles.po.poolSelection=true — a fake runner's selection is validated and the engine applies labels to EXACTLY that subset, never the full candidate set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({
    roles: { po: { poolSelection: true } },
    lanes: { max: 3, roundDispatchCap: 2 },
    round: { poolFactor: 1.5 },
  }); // cap = 3
  forge.ready = [1, 2, 3, 4, 5].map((n) => mkReady(n, 3));
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1, 3]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 3],
    "only the session's validated selection, a proper subset of the 3-issue candidate set",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 3],
    "labels applied to exactly the selected subset — never #2 (a candidate, but not selected) and never #4/#5 (outside the cap)",
  );
  assert.equal(runner.calls.length, 1, "exactly one po-pool session — a valid first attempt needs no retry");
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "po-pool");
  assert.equal(call.allowedTools, PO_ALLOWED_TOOLS, "zero gh grants — same containment as align/triage");
  assert.equal(call.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.match(call.prompt, /#1 —/);
  assert.match(call.prompt, /#3 —/);
  assert.doesNotMatch(call.prompt, /#4 —/, "the candidate digest itself is already cap-bounded — #4 was never even shown");
});

test("runPoolSelection: an out-of-bounds selection (an issue number outside the candidate list) is invalid, retried once, then degrades OPEN to the full deterministic candidate set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(999, 3)]; // #999 past the cap, never a candidate
  const badSelection = poolResultText([1, 999]); // #999 is not in the candidate list
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", badSelection), doneResult("role-po-pool-2", badSelection)]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 7 });
  assert.equal(runner.calls.length, 2, "retried exactly once before degrading");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "degraded to the FULL deterministic candidate set (the top-cap Ready issues), not an empty pool",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2],
  );
  const degraded = events.find(([kind]) => kind === "pool-degraded");
  assert.ok(degraded, "a durable honesty event was recorded");
  assert.equal((degraded![1] as { round_id: number }).round_id, 7);
});

test("runPoolSelection: an over-cap selection (more issues than the candidate list itself) is invalid the same way", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  // Candidates are exactly [1, 2] (cap 2) — a session claiming BOTH plus a duplicate exceeds
  // what schema+bound validation allows (len > cap after a would-be dedupe is still invalid;
  // here it's a straightforward "more than exists" case via an out-of-range extra number).
  const overCap = poolResultText([1, 2, 3]);
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", overCap), doneResult("role-po-pool-2", overCap)]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "degraded to the deterministic candidate set",
  );
});

test("runPoolSelection: default config (roles.po.poolSelection unset -> false) -> the deterministic path directly, no session dispatched at all, even with roles.po.enabled left at its true default (#233)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  assert.equal(cfg.roles.po.poolSelection, false, "sanity: the #233 default");
  assert.equal(cfg.roles.po.enabled, true, "sanity: align/triage stay on by default — irrelevant to pool selection now");
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "poolSelection is off by default — no session, not even an attempt");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "the full deterministic top-cap candidate set — the #233 default MAIN path, not a fallback",
  );
});

test("runPoolSelection: roles.po.enabled=false -> pool selection is UNAFFECTED — still the deterministic path (poolSelection defaults false too)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { enabled: false } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "poolSelection defaults false regardless of roles.po.enabled — no session");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "the full deterministic top-cap candidate set",
  );
});

test("runPoolSelection: roles.po.enabled=false AND roles.po.poolSelection=true -> the session STILL runs (#233 decoupling — pool selection no longer depends on roles.po.enabled at all)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({
    roles: { po: { enabled: false, poolSelection: true } },
    lanes: { max: 3, roundDispatchCap: 2 },
    round: { poolFactor: 1 },
  });
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 1, "poolSelection=true dispatches a session even with align/triage (roles.po.enabled) off");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the session's validated (proper subset) selection, not the full candidate set",
  );
});

test("runPoolSelection: zero Ready candidates -> no session dispatched (nothing to choose from), empty selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  forge.ready = [];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(selected, []);
});

test("runPoolSelection: roles.po.poolSelection=true with zero Ready candidates -> still no session dispatched (nothing to choose from), empty selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } } });
  forge.ready = [];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "zero candidates short-circuits before a session would ever be dispatched");
  assert.deepEqual(selected, []);
});

test("runPoolSelection (gate② r2): replay path — a persisted pool-selected event is replayed verbatim, no session dispatched, no adopt-existing heuristic involved", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  // Ready still shows fresh candidates as the backlog stands NOW — but a durable pool-selected
  // event from a PRIOR (crashed) attempt this round already recorded a decision. Replay must
  // win over a fresh session: a fresh session's own selection could differ (LLM nondeterminism)
  // from what the crashed attempt already decided, and reconciling to a NEW decision would
  // fight the durable record instead of finishing what it started.
  forge.ready = [mkReady(5, 3), mkReady(6, 3)];
  forge.backlogIssues = [{ number: 9, title: "the persisted target", labels: [cfg.labels.roundPool] }];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([5]))]);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [9],
    "the event's target, never a fresh selection over current Ready",
  );
  assert.equal(runner.calls.length, 0, "no session dispatched — the persisted event was replayed");
  assert.deepEqual(forge.addLabelCalls, [], "already labelled — reconcile's idempotent add-skip, no redundant write");
  assert.deepEqual(forge.removeLabelCalls, [], "nothing else carries the pool label — nothing to heal here");
});

test("runPoolSelection (gate② r2): crash window — the event is persisted but ZERO labels landed before the crash (right after the event write); rerun reconciles the FULL target, still no session", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 3 }, round: { poolFactor: 1 } });
  forge.ready = [];
  forge.backlogIssues = [
    { number: 9, title: "target, not yet labelled", labels: [] },
    { number: 10, title: "also target, not yet labelled", labels: [] },
  ];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9, 10] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [9, 10],
  );
  assert.equal(runner.calls.length, 0, "no session — the crash-window rerun replays the persisted target");
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [9, 10],
    "the crashed attempt never got to label either issue — reconcile finishes the job on rerun",
  );
});

test("runPoolSelection (gate② r2): residual healing (session path, roles.po.poolSelection=true) — an open issue carrying a STALE pool label that is NOT part of this round's target has it removed during selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } }); // cap = 1
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual — not a candidate this round", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 1, "poolSelection=true actually exercises the session path this test is named for");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  assert.deepEqual(forge.removeLabelCalls, [[99, cfg.labels.roundPool]], "the stray residual's label was removed, never left dangling");
});

test("runPoolSelection (gate② r2): residual healing on the DEFAULT deterministic path too — roles.po.poolSelection=false (independent of roles.po.enabled) still clears a stray pool label from a non-candidate open issue", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { enabled: false } }, lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  assert.equal(runner.calls.length, 0, "poolSelection defaults false — no session, ever, regardless of roles.po.enabled");
  assert.deepEqual(forge.removeLabelCalls, [[99, cfg.labels.roundPool]]);
});

// ── #212 gate② r3 ────────────────────────────────────────────────────────────────────────────

test("runPoolSelection (gate② r3 finding 1): a reconcile REMOVAL failure stays degrade-open — a durable pool-reconcile-incomplete event is appended, the phase still completes (never a retry loop over a prioritization mechanism)", async () => {
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } }); // cap = 1
  const forge = new (class extends FakeForge {
    override async removeLabel(n: number, l: string): Promise<void> {
      if (n === 99) throw new Error("simulated forge failure removing #99");
      await super.removeLabel(n, l);
    }
  })();
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual whose removal will fail", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 }); // must NOT throw
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the phase's own target still resolved correctly",
  );
  const incomplete = events.find(([kind]) => kind === "pool-reconcile-incomplete");
  assert.ok(incomplete, "a durable honesty event was recorded");
  assert.deepEqual(incomplete![1], { round_id: 1, failed_issues: [99] });
});

test("runPoolSelection (gate② r3 finding 1): a listOpenIssues read failure during reconcile also stays degrade-open, with a read_failed honesty event — never a throw", async () => {
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } });
  const forge = new (class extends FakeForge {
    override async listOpenIssues(): Promise<Issue[]> {
      throw new Error("simulated open-backlog read failure");
    }
  })();
  forge.ready = [mkReady(1, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the ADD side still succeeded — only the REMOVE side's read failed",
  );
  const incomplete = events.find(([kind]) => kind === "pool-reconcile-incomplete");
  assert.ok(incomplete);
  assert.deepEqual(incomplete![1], { round_id: 1, read_failed: true });
});

test("runPoolSelection (gate② r3 finding 3): two pool-selected events for the same round — the LAST one wins, replayed verbatim, no session", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [];
  forge.backlogIssues = [
    { number: 1, title: "first event's target (stale)", labels: [] },
    { number: 2, title: "second (LAST) event's target", labels: [] },
  ];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [1] });
  state.appendEvent("pool-selected", { round_id: 1, issues: [2] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [2],
    "the LAST event's target, not the first",
  );
  assert.equal(runner.calls.length, 0, "no session — replay wins over recompute");
});

test("runPoolSelection (gate② r3 finding 3): the LAST pool-selected event for this round is malformed — treated as absent (fresh compute), never a throw; growth stops at one extra append", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(5, 3)];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9] }); // an earlier, well-formed event
  state.appendEvent("pool-selected", { round_id: 1, malformed: true }); // the LAST one — fails the schema
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([5]))]);
  const selected = await runPoolSelection({ forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [5],
    "a fresh session ran over the current Ready backlog",
  );
  assert.equal(runner.calls.length, 1, "no replay — the malformed LAST event reads as absent, never a throw");
});

test("applyPoolLabels (gate② P2-4, via selectRoundPool): every label write failing for a non-empty selection THROWS — never silently returns as though the pool were correctly empty", async () => {
  const cfg = mkCfg();
  const forge = new (class extends FakeForge {
    override async addLabel(): Promise<void> {
      throw new Error("simulated forge failure");
    }
  })();
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  await assert.rejects(() => selectRoundPool({ forge, cfg }), /ALL 2 label write\(s\) failed/);
});

test("applyPoolLabels (gate② P2-4): a validly EMPTY selection (zero candidates) never throws — 'select/have nothing' is a legitimate outcome, not a failure", async () => {
  const cfg = mkCfg();
  const forge = new FakeForge();
  forge.ready = [];
  const selected = await selectRoundPool({ forge, cfg });
  assert.deepEqual(selected, []);
});

test("validatePoolSelectionOutput: a valid proper subset of the candidate list is ok", () => {
  const result = validatePoolSelectionOutput(poolResultText([2, 5]), [1, 2, 5, 9], 3);
  assert.ok(result.ok);
  if (result.ok)
    assert.deepEqual(
      result.selected.sort((a, b) => a - b),
      [2, 5],
    );
});

test("validatePoolSelectionOutput: an empty selection is a valid, complete outcome", () => {
  const result = validatePoolSelectionOutput(poolResultText([]), [1, 2, 3], 3);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.selected, []);
});

test("validatePoolSelectionOutput: a selected number outside the candidate list -> fail-closed", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 42]), [1, 2, 3], 3);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /not in the candidate list/.test(result.reason));
});

test("validatePoolSelectionOutput: a selection longer than the cap -> fail-closed even if every number is a real candidate", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 2, 3]), [1, 2, 3, 4, 5], 2);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /exceeding the cap/.test(result.reason));
});

test("validatePoolSelectionOutput: a duplicate issue number in the selection -> fail-closed", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 1]), [1, 2, 3], 3);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /duplicate/.test(result.reason));
});

test("validatePoolSelectionOutput: no structured output block -> fail-closed", () => {
  const result = validatePoolSelectionOutput("no sentinel here", [1, 2, 3], 3);
  assert.equal(result.ok, false);
});

test("defaultPoolPromptPath resolves to a real, readable shipped file with a selected-numbers structured-output example", () => {
  const path = defaultPoolPromptPath();
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  assert.match(text, /selected/);
});
