// plan-review.test.ts (#87, #77 Amendment 2, reworked by #110 PR1): the plan_review peripheral's
// draft -> re-review orchestration. Fakes the underlying role session (RoleRunner) directly —
// peripheral.test.ts already covers the real claude-stub spawn path; this file is about the
// ORCHESTRATION logic (candidate selection, structured-output parsing/validation, self-heal
// briefing, cycle bounding, idempotent marker skip, degrade-on-invalid-output), not the CLI
// spawn mechanics.
//
// #110 PR1 rework note: role sessions no longer touch `gh` at all — every RoleSessionResult a
// test script hands the fake runner carries a `resultText` (the session's structured final
// output, see structured-output.ts) instead of an `effect` callback that used to simulate a
// direct `gh issue comment/edit` side effect. The engine reads `resultText`, validates it, and
// performs every forge write itself — exactly what reviewOneIssue is being tested for here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { ContextManifest } from "./context-manifest.js";
import {
  CONFIRM_ALLOWED_TOOLS,
  CONFIRM_DISALLOWED_TOOLS,
  PLAN_DRAFTER_DISALLOWED_TOOLS,
  type RoleSessionOpts,
  type RoleSessionResult,
} from "./peripheral.js";
import {
  createPlanReviewStub,
  defaultPlanConfirmPromptPath,
  defaultPlanDrafterPromptPath,
  defaultPlanReviewerPromptPath,
  loadRolePromptTemplate,
  type PlanReviewDeps,
  planReviewMarker,
  renderRolePrompt,
  validateConfirmOutput,
  validateDrafterOutput,
  validateReviewerOutput,
} from "./plan-review.js";

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  /** #214: createPlanReviewStub's candidate set is now the round pool (forge.getPoolEligibleIssues
   *  filtered by cfg.labels.roundPool) — every fixture issue in this file that should be seen by
   *  the phase must carry cfg.labels.roundPool in its `labels` array. */
  poolEligibleIssues: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  /** Mutable per-issue body — updateIssueBody writes here, and getIssueBody (the P1 refetch)
   *  reads it back, so tests can prove the next reviewer render sees an applied edit. */
  issueBodies: Record<number, string> = {};
  labelsAdded: Array<[number, string]> = [];
  issueCommentsPosted: Array<[number, string]> = [];
  getIssueCommentsCallCount = 0;
  /** #214 gate② review (delta P2): a SINGLE ordered log spanning EVERY write type (label add,
   *  label remove, comment) — labelsAdded/issueCommentsPosted above are per-write-type, so they
   *  can't prove INTERLEAVING (e.g. "the comment landed between the two label writes, not before
   *  or after both"). Tests pinning the verify_na branch's needsHuman -> comment -> verifyNa
   *  ordering invariant read this log instead. */
  writeLog: Array<{ kind: "add-label" | "remove-label" | "comment"; issue: number; detail: string }> = [];

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> {
    this.labelsAdded.push([n, l]);
    this.writeLog.push({ kind: "add-label", issue: n, detail: l });
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  removeLabelCalls: Array<[number, string]> = [];
  async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
    this.writeLog.push({ kind: "remove-label", issue: n, detail: l });
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
    this.writeLog.push({ kind: "comment", issue: n, detail: body });
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
  async getPoolEligibleIssues(): Promise<Issue[]> {
    return this.poolEligibleIssues;
  }
  async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  async getIssueComments(issue: number) {
    this.getIssueCommentsCallCount++;
    return this.issueComments[issue] ?? [];
  }
  async createIssue(): Promise<number> {
    return 0;
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
}

/** A scripted fake of RoleRunner.run — each call consumes the next scripted result (or the
 *  last one, repeated) and, when given, applies a side effect purely for TEST OBSERVATION (e.g.
 *  asserting on the prompt a later cycle was rendered with) — never a forge write anymore; the
 *  engine is what performs every forge write now, driven by resultText. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(private readonly script: Array<{ result: RoleSessionResult; effect?: (opts: RoleSessionOpts) => void }>) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const step = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    step.effect?.(opts);
    return step.result;
  }
}

/** Builds a session's structured final-message text (structured-output.ts's sentinel format) —
 *  the same shape a real role session's last message must end in post-#110. */
const sapwoodResult = (metadata: Record<string, unknown>, body?: string): string => {
  let out = `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;
  if (body !== undefined) out += `\n${BODY_BLOCK_START}\n${body}\n${BODY_BLOCK_END}`;
  return out;
};

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

// #214: createPlanReviewStub's candidate set is the round pool now — every fixture issue below
// that should be seen by the phase carries this label. No test in this file overrides
// labels.roundPool or labels.prefix, so this one resolved value is valid for every mkCfg() call.
const ROUND_POOL_LABEL = mkCfg().labels.roundPool;

/** A structurally-valid ContextManifest for #236 persistence tests — `model` doubles as a tag so
 *  the persisted json is trivially distinguishable from another fixture's. */
const mkFakeManifest = (tag: string): ContextManifest => ({
  sources: [],
  probedPaths: [],
  knownUnprobed: "imports, ancestor dirs, managed policy",
  capturedPreSpawn: "2026-07-17T00:00:00Z",
  capturedPostExit: "2026-07-17T00:00:01Z",
  captureBasis: "init-observed",
  model: tag,
  modelSource: "requested-fallback",
  cliBin: "claude",
  cliVersion: null,
  toolInventoryHash: null,
  promptTemplateVersion: null,
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsHash: "hash",
  hookHash: null,
  recordedAt: "2026-07-17T00:00:01Z",
});

/** The MOST RECENT comment posted on an issue — a cycle that bounces (posts a brief) before
 *  eventually escalating (posts a SECOND, distinct comment) has more than one, and the
 *  escalation-specific assertions below care about the last one, not whichever happens first. */
const lastComment = (forge: FakeForge, issue: number): string => {
  const posted = forge.issueCommentsPosted.filter(([n]) => n === issue);
  return posted[posted.length - 1]?.[1] ?? "";
};

// A body that satisfies extractVerificationPlan AND extractAcceptanceCriteria (#283: BOTH are
// the content invariants every "approve"/drafted claim is re-checked against).
const PLAN_BODY =
  "Some description.\n\n## Acceptance criteria\n\n- [ ] the criteria are met\n\n## Verification\n\nRun `npm test` and confirm green.";
const NO_PLAN_BODY = "Some description with no verification section at all.";

test("createPlanReviewStub: marker present -> returns it unchanged, no forge call, no session run (idempotence)", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 1, title: "t", labels: [ROUND_POOL_LABEL] }];
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createPlanReviewStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "plan_review", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createPlanReviewStub: no candidates -> returns the round's marker, no session run", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createPlanReviewStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "plan_review", marker: null });
  assert.equal(marker, planReviewMarker(5));
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createPlanReviewStub: outcome 1 (approve, no body revision) — engine applies plan:approved from the validated decision, no drafter is ever run", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 10, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[10] = PLAN_BODY; // the CURRENT body already carries a plan
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 10 })) }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "plan-reviewer");
  assert.ok(forge.issueLabels[10]!.includes("plan:approved"));
  assert.equal(forge.updateIssueBodyCalls.length, 0, "no body revision in the decision -> no write");
  // Spend recorded against the reviewer session's own name.
  assert.equal(state.spentUsdForWorker("reviewer-1"), 0.01);
  state.close();
});

test("createPlanReviewStub: outcome 1 (approve WITH a body revision) — the revised body is applied via updateIssueBody BEFORE the label", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 50, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[50] = NO_PLAN_BODY; // current body has no plan — the REVISION supplies one
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 50 }, PLAN_BODY)) }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.deepEqual(forge.updateIssueBodyCalls, [[50, PLAN_BODY]]);
  assert.equal(forge.issueBodies[50], PLAN_BODY);
  assert.ok(forge.issueLabels[50]!.includes("plan:approved"));
  state.close();
});

test("createPlanReviewStub: outcome 3 (propose verify:n/a) — engine applies verify:n/a + needs-human together and posts the explanation as a comment", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 11, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult(
        "reviewer-1",
        sapwoodResult({ decision: "verify_na", issue: 11 }, "Pure docs work, no verification plan applies."),
      ),
    },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 1); // no drafter, no further reviewer pass
  assert.ok(forge.issueLabels[11]!.includes(cfg.labels.verifyNa));
  assert.ok(forge.issueLabels[11]!.includes(cfg.labels.needsHuman));
  // ORDERING INVARIANT (dual-review round 1, P1): needsHuman lands BEFORE verifyNa — if the
  // second addLabel fails after the first succeeded, the surviving label must be the BLOCKING
  // one (verify:n/a alone is dispatchable via the doc-gate path, i.e. fail-open).
  const order = forge.labelsAdded.filter(([n]) => n === 11).map(([, l]) => l);
  assert.deepEqual(order, [cfg.labels.needsHuman, cfg.labels.verifyNa], "needs-human applied first, fail-closed");
  const comment = lastComment(forge, 11);
  assert.ok(comment.includes("Pure docs work"));
  assert.ok(comment.includes(planReviewMarker(1)));
  state.close();
});

test("createPlanReviewStub: outcome 2 (request draft) end-to-end self-heal — reviewer draft_request -> engine posts the brief + briefs a plan-drafter -> engine applies the drafted body via updateIssueBody -> re-review approves", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 12, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[12] = NO_PLAN_BODY;
  // A pre-existing, unrelated comment already sits on the issue — proves the brief no longer
  // comes from (or is influenced by) issue comments at all (that snapshot/refetch machinery is
  // deleted; the brief is the validated decision's BODY block, directly).
  forge.issueComments[12] = [{ login: "human", createdAt: "t", body: "an unrelated human discussion" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 12 }, "missing acceptance criteria")) },
    { result: doneResult("drafter-0", sapwoodResult({ issue: 12 }, PLAN_BODY)) },
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 12 })) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer", "plan-drafter", "plan-reviewer"],
  );
  // The drafter's prompt was briefed with the reviewer's BODY block verbatim.
  assert.ok(runner.calls[1]!.prompt.includes("missing acceptance criteria"));
  assert.equal(runner.calls[1]!.disallowedTools, PLAN_DRAFTER_DISALLOWED_TOOLS);
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
  // The engine — not the session — applied the drafted body.
  assert.deepEqual(forge.updateIssueBodyCalls, [[12, PLAN_BODY]]);
  assert.ok(forge.issueLabels[12]!.includes("plan:approved"));
  // The engine still posts the brief as a GitHub-visible comment (traceability)...
  const posted = lastComment(forge, 12);
  assert.ok(posted.includes("missing acceptance criteria"));
  // ...but never reads comments back — the freshness-snapshot machinery this replaced is gone.
  assert.equal(forge.getIssueCommentsCallCount, 0);
  state.close();
});

test("createPlanReviewStub (#236): both the reviewer AND the drafter session's context manifests are persisted, keyed by (round, 'plan_review', role, session, attempt 1)", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 12, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[12] = NO_PLAN_BODY;
  const reviewerManifest0 = mkFakeManifest("reviewer-attempt-0");
  const drafterManifest = mkFakeManifest("drafter-attempt");
  const reviewerManifest1 = mkFakeManifest("reviewer-attempt-1");
  const runner = new ScriptedRunner([
    {
      result: {
        ...doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 12 }, "missing acceptance criteria")),
        contextManifest: reviewerManifest0,
      },
    },
    { result: { ...doneResult("drafter-0", sapwoodResult({ issue: 12 }, PLAN_BODY)), contextManifest: drafterManifest } },
    { result: { ...doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 12 })), contextManifest: reviewerManifest1 } },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 7, phase: "plan_review", marker: null });
  const rows = state.listContextManifestsForRound(7);
  assert.equal(rows.length, 3, "reviewer-0, drafter-0, and reviewer-1 each record one manifest");
  assert.deepEqual(
    rows.map((r) => [r.role, r.session, r.attempt, r.phase]),
    [
      ["plan-reviewer", "reviewer-0", 1, "plan_review"],
      ["plan-drafter", "drafter-0", 1, "plan_review"],
      ["plan-reviewer", "reviewer-1", 1, "plan_review"],
    ],
  );
  assert.deepEqual(JSON.parse(rows[0]?.json ?? "{}"), reviewerManifest0);
  assert.deepEqual(JSON.parse(rows[1]?.json ?? "{}"), drafterManifest);
  assert.deepEqual(JSON.parse(rows[2]?.json ?? "{}"), reviewerManifest1);
  state.close();
});

test("createPlanReviewStub P1: after the drafter's body is applied, the NEXT reviewer render sees the NEW body (refetched per cycle, never the phase-start snapshot)", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 30, title: "t", labels: [ROUND_POOL_LABEL], body: "OLD PLAN — inadequate" }];
  forge.issueBodies[30] = "OLD PLAN — inadequate";
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const NEW_BODY = "NEW PLAN — concrete criteria\n\n## Acceptance criteria\n\n- [ ] it works\n\n## Verification\n\nRun the new test suite.";
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 30 }, "criteria too vague")) },
    { result: doneResult("drafter-0", sapwoodResult({ issue: 30 }, NEW_BODY)) },
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 30 })) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.ok(runner.calls[2]!.prompt.includes("NEW PLAN — concrete criteria"), "cycle-1 reviewer's prompt embedded the drafter's NEW body");
  assert.ok((forge.issueLabels[30] ?? []).includes("plan:approved"), "cycle-1 reviewer saw the drafter's new body and approved");
  assert.ok(!(forge.issueLabels[30] ?? []).includes(cfg.labels.needsHuman), "self-heal converged — never escalated");
  state.close();
});

test("createPlanReviewStub P2: a reviewer SESSION failure is retried once; a second failure escalates needs-human — NEVER briefs a drafter", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 31, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: failedResult("reviewer-0") }, { result: failedResult("reviewer-0-retry") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 2, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer", "plan-reviewer"],
    "one retry, no drafter",
  );
  assert.ok((forge.issueLabels[31] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 31);
  assert.ok(/failed/.test(comment), "the escalation comment names the session failure");
  assert.ok(comment.includes(planReviewMarker(2)));
  state.close();
});

test("createPlanReviewStub P2: a reviewer failure followed by a successful+valid retry continues normally (approve on the retry)", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 32, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[32] = PLAN_BODY;
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: failedResult("reviewer-0") },
    { result: doneResult("reviewer-0-retry", sapwoodResult({ decision: "approve", issue: 32 })) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 2, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 2);
  assert.ok((forge.issueLabels[32] ?? []).includes("plan:approved"));
  assert.ok(!(forge.issueLabels[32] ?? []).includes(cfg.labels.needsHuman));
  state.close();
});

// ── #110 PR1: malformed/schema-invalid/content-invalid structured output — the isValid hook ──

test("createPlanReviewStub #110: reviewer output with no structured block at all, TWICE -> degrades exactly like a session failure — needs-human, drafter never briefed", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 33, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", "I looked at the issue and it seems fine to me.") },
    { result: doneResult("reviewer-0-retry", "still just prose, no structured output") },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer", "plan-reviewer"],
    "no drafter ever ran",
  );
  assert.ok((forge.issueLabels[33] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 33);
  assert.ok(/structured output/.test(comment), "the escalation comment names the malformed-output reason");
  const events = state.eventsSince("2020-01-01T00:00:00.000Z", ["plan-review-escalated"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { round_id: number; issue: number; reason: string };
  assert.equal(payload.round_id, 3);
  assert.equal(payload.issue, 33);
  assert.ok(/structured output/.test(payload.reason));
  state.close();
});

test("createPlanReviewStub #110: reviewer 'draft_request' with NO BODY block, TWICE -> invalid output degrades — never briefs a drafter off nothing", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 34, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 34 })) }, // no body
    { result: doneResult("reviewer-0-retry", sapwoodResult({ decision: "draft_request", issue: 34 }, "   \n  ")) }, // whitespace-only
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer", "plan-reviewer"],
  );
  assert.ok((forge.issueLabels[34] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 34);
  assert.ok(/BODY block/.test(comment));
  state.close();
});

test("createPlanReviewStub #110: an 'approve' whose body has no verification plan, TWICE -> treated as invalid output, never honored", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 35, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[35] = NO_PLAN_BODY; // no revision in the decision -> checked against THIS
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "approve", issue: 35 })) },
    { result: doneResult("reviewer-0-retry", sapwoodResult({ decision: "approve", issue: 35 })) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.ok(!(forge.issueLabels[35] ?? []).includes("plan:approved"), "the approve claim was never honored");
  assert.ok((forge.issueLabels[35] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 35);
  assert.ok(/verification/.test(comment));
  state.close();
});

test("createPlanReviewStub #110: a plan-drafter session that produces invalid output TWICE degrades — the (bad) draft is never applied", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 36, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[36] = NO_PLAN_BODY;
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 36 }, "plan is missing")) },
    { result: doneResult("drafter-0", sapwoodResult({ issue: 36 }, NO_PLAN_BODY)) }, // no verification section
    { result: doneResult("drafter-0-retry", "garbage, no structured block") },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 4, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer", "plan-drafter", "plan-drafter"],
  );
  assert.equal(forge.updateIssueBodyCalls.length, 0, "an invalid draft is never applied");
  assert.ok((forge.issueLabels[36] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 36);
  assert.ok(comment.includes(planReviewMarker(4)));
  state.close();
});

// ── #110: the drafter's write discipline is now STRUCTURAL, not a post-hoc label diff ────────
//
// The pre-#110 label post-check (snapshot labels before/after a drafter session, escalate on any
// diff) is deleted outright, not ported — see plan-review.ts's module doc. It is now
// STRUCTURALLY impossible for a drafter's output to self-approve or touch any label: the
// drafter's metadata schema (`{issue}` only, `.strict()`) has no field a compromised/confused
// drafter could even smuggle a "decision"/label claim through, and the engine's write path for
// drafter output is `updateIssueBody` ONLY — there is no code path from drafter output to
// `addLabel` at all, `.strict()` schema or not.
test("validateDrafterOutput: a smuggled 'decision' field in the metadata is rejected outright (.strict() schema) — proves self-approval is structurally impossible, not just caught after the fact", () => {
  const text = sapwoodResult({ issue: 1, decision: "approve" }, PLAN_BODY);
  const result = validateDrafterOutput(text, 1);
  assert.equal(result.ok, false);
});

test("createPlanReviewStub: exhausted after maxDraftCycles — applies needs-human with the attempt trail, never loops forever", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 13, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[13] = NO_PLAN_BODY;
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  // Reviewer NEVER approves, NEVER escalates itself — always bounces. Drafter always drafts
  // (validly), but the reviewer keeps bouncing anyway.
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 13 }, "still bad")) },
    { result: doneResult("drafter-0", sapwoodResult({ issue: 13 }, PLAN_BODY)) },
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "draft_request", issue: 13 }, "still bad again")) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 7, phase: "plan_review", marker: null });
  // maxDraftCycles=1 -> at most 1 draft cycle: reviewer(cycle0) -> drafter(cycle0) -> reviewer(cycle1) -> exhausted.
  assert.equal(runner.calls.length, 3);
  assert.ok(forge.issueLabels[13]!.includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 13);
  assert.ok(comment.includes("exhausted"));
  assert.ok(comment.includes(planReviewMarker(7)), "the round marker is embedded in the escalation comment");
  state.close();
});

// ── #104: gate⓪ escalate() also appends a durable state event ──────────────────────────────

test("createPlanReviewStub #104: escalate() (maxDraftCycles exhausted) appends a plan-review-escalated state event naming the round and issue", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 13, title: "t", labels: [ROUND_POOL_LABEL] }];
  forge.issueBodies[13] = NO_PLAN_BODY;
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 13 }, "still bad")) },
    { result: doneResult("drafter-0", sapwoodResult({ issue: 13 }, PLAN_BODY)) },
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "draft_request", issue: 13 }, "still bad again")) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 7, phase: "plan_review", marker: null });
  const events = state.eventsSince("2020-01-01T00:00:00.000Z", ["plan-review-escalated"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { round_id: number; issue: number; reason: string };
  assert.equal(payload.round_id, 7);
  assert.equal(payload.issue, 13);
  assert.ok(/exhausted/.test(payload.reason));
  state.close();
});

test("createPlanReviewStub #104: escalate() from a reviewer-session-failed-twice path also appends the event", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 31, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: failedResult("reviewer-0") }, { result: failedResult("reviewer-0-retry") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 2, phase: "plan_review", marker: null });
  const events = state.eventsSince("2020-01-01T00:00:00.000Z", ["plan-review-escalated"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { round_id: number; issue: number };
  assert.equal(payload.round_id, 2);
  assert.equal(payload.issue, 31);
  state.close();
});

test("createPlanReviewStub #104: a state-write failure on escalate() is contained — the forge label/comment still land, run() does not throw", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [{ number: 33, title: "t", labels: [ROUND_POOL_LABEL] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: failedResult("reviewer-0") }, { result: failedResult("reviewer-0-retry") }]);
  const state = new State(":memory:");
  state.appendEvent = () => {
    throw new Error("simulated disk failure");
  };
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await assert.doesNotReject(() => stub.run({ roundId: 3, phase: "plan_review", marker: null }));
  assert.ok((forge.issueLabels[33] ?? []).includes(cfg.labels.needsHuman), "the forge escalation still landed");
  state.close();
});

test("createPlanReviewStub: processes every candidate issue, independently", async () => {
  const forge = new FakeForge();
  forge.poolEligibleIssues = [
    { number: 20, title: "a", labels: [ROUND_POOL_LABEL] },
    { number: 21, title: "b", labels: [ROUND_POOL_LABEL] },
  ];
  forge.issueBodies[20] = PLAN_BODY;
  forge.issueBodies[21] = PLAN_BODY;
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("r-20", sapwoodResult({ decision: "approve", issue: 20 })) },
    { result: doneResult("r-21", sapwoodResult({ decision: "approve", issue: 21 })) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  const { marker } = await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 2);
  assert.ok(forge.issueLabels[20]!.includes("plan:approved"));
  assert.ok(forge.issueLabels[21]!.includes("plan:approved"));
  assert.equal(marker, planReviewMarker(3));
  state.close();
});

// ── template rendering + loading (unit) ─────────────────────────────────────────────────────

test("renderRolePrompt: substitutes issue + config + extra vars; fails closed on an unknown var", () => {
  const cfg = mkCfg();
  const issue: Issue = { number: 9, title: "T", labels: ["a", "b"], body: "B" };
  const out = renderRolePrompt(
    "#{{issue.number}} {{issue.title}} [{{issue.labels}}] {{labels.planApproved}} {{roles.planReviewer.maxDraftCycles}} {{reviewer.brief}}",
    issue,
    cfg,
    { "reviewer.brief": "brief text" },
  );
  assert.equal(out, "#9 T [a, b] plan:approved 2 brief text");
  assert.throws(() => renderRolePrompt("{{nope}}", issue, cfg), /unknown variable/);
});

test("defaultPlanReviewerPromptPath / defaultPlanDrafterPromptPath: resolve to real shipped files that describe the structured-output contract, not a `gh` command", () => {
  const reviewerTemplate = loadRolePromptTemplate(undefined, defaultPlanReviewerPromptPath());
  const drafterTemplate = loadRolePromptTemplate(undefined, defaultPlanDrafterPromptPath());
  assert.ok(reviewerTemplate.includes("{{issue.number}}"));
  assert.ok(drafterTemplate.includes("{{reviewer.brief}}"));
  assert.ok(reviewerTemplate.includes(RESULT_BLOCK_START) && reviewerTemplate.includes(BODY_BLOCK_START));
  assert.ok(drafterTemplate.includes(RESULT_BLOCK_START) && drafterTemplate.includes(BODY_BLOCK_START));
  for (const template of [reviewerTemplate, drafterTemplate]) {
    assert.ok(!/`gh issue (comment|edit)/.test(template), "the prompt no longer instructs any gh command");
  }
});

test("loadRolePromptTemplate: configured-but-missing file throws, naming the path (fail-fast, never a silent fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-plan-review-"));
  try {
    const missing = join(dir, "nonexistent.md");
    assert.throws(
      () => loadRolePromptTemplate(missing, defaultPlanReviewerPromptPath()),
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #110 PR1: structured-output parsing/validation — unit tests, no session dispatch ─────────

test("validateReviewerOutput: truncated sentinel (no matching end) -> fail-closed, never a partial parse", () => {
  const text = `${RESULT_BLOCK_START}\n{"decision":"approve"`;
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, false);
});

test("validateReviewerOutput: JSON-invalid metadata -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\nnot valid json at all\n${RESULT_BLOCK_END}`;
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /not valid JSON/.test(result.reason));
});

test("validateReviewerOutput: schema-invalid enum value -> fail-closed", () => {
  const text = sapwoodResult({ decision: "maybe", issue: 1 });
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /schema validation/.test(result.reason));
});

test("validateReviewerOutput: 'draft_request' with body missing -> fail-closed (required body absent)", () => {
  const text = sapwoodResult({ decision: "draft_request", issue: 1 });
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /BODY block/.test(result.reason));
});

test("validateReviewerOutput: 'approve' whose (unchanged) body has no verification plan -> fail-closed content invariant", () => {
  const text = sapwoodResult({ decision: "approve", issue: 1 });
  const result = validateReviewerOutput(text, 1, NO_PLAN_BODY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /verification/.test(result.reason));
});

test("validateReviewerOutput: issue number mismatch -> fail-closed (never trust a decision for the wrong issue)", () => {
  const text = sapwoodResult({ decision: "approve", issue: 999 });
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /mismatch/.test(result.reason));
});

test("validateReviewerOutput: well-formed 'approve' with a valid current body -> ok", () => {
  const text = sapwoodResult({ decision: "approve", issue: 1 });
  const result = validateReviewerOutput(text, 1, PLAN_BODY);
  assert.equal(result.ok, true);
});

test("validateDrafterOutput: missing body -> fail-closed", () => {
  const text = sapwoodResult({ issue: 1 });
  const result = validateDrafterOutput(text, 1);
  assert.equal(result.ok, false);
});

test("validateDrafterOutput: body with no verification plan section -> fail-closed content invariant", () => {
  const text = sapwoodResult({ issue: 1 }, NO_PLAN_BODY);
  const result = validateDrafterOutput(text, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /verification/.test(result.reason));
});

test("validateDrafterOutput: well-formed drafted body -> ok, returns the body verbatim", () => {
  const text = sapwoodResult({ issue: 1 }, PLAN_BODY);
  const result = validateDrafterOutput(text, 1);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.body === PLAN_BODY);
});

// #194: a body shaped like .github/ISSUE_TEMPLATE/feature.md. The sibling plan section is the
// standard shape now that extractVerificationPlan concatenates every matching section.
const TEMPLATE_SHAPED_BODY = `## Why

A flaky check can wedge a lane forever.

## What

Add a retry budget to the merge-driver's CI poll so a flaky check doesn't wedge a lane
forever.

Out of scope: changing the merge gate's verdict semantics.

## Acceptance criteria

- [ ] Merge driver stops polling after N consecutive transient failures and escalates.
- [ ] N is config-driven, not hardcoded.

## Verification plan

Add a unit test that feeds the poller N+1 transient failures and asserts it escalates
(not spin forever); run \`npm test\` and confirm it's green.`;

test("validateDrafterOutput: a template-shaped body with sibling Verification plan passes and the extracted plan carries both sections", () => {
  const text = sapwoodResult({ issue: 131 }, TEMPLATE_SHAPED_BODY);
  const result = validateDrafterOutput(text, 131);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.body === TEMPLATE_SHAPED_BODY);
  const plan = extractVerificationPlan(TEMPLATE_SHAPED_BODY);
  assert.ok(plan != null);
  // The extracted text — what gate②'s review trigger carries VERBATIM — must contain BOTH halves.
  assert.ok(/acceptance criteria/i.test(plan!));
  assert.ok(plan!.includes("N is config-driven"), "extracted plan must carry the AC lines");
  assert.ok(plan!.includes("## Verification plan"), "extracted plan must carry the Verification heading");
  assert.ok(plan!.includes("feeds the poller N+1 transient failures"), "extracted plan must carry the verification steps");
});

// ── #214: gate⓪ scoped to the round pool + freshness re-confirm ────────────────────────────

test("createPlanReviewStub (#214): a pool with all four member classes gets exactly the class-appropriate treatment; a non-pool Ready issue in the same read gets zero attention", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  // Class 3 setup: a plan-approved event for #102 already recorded THIS round (id > the round's
  // start_event_id) — simulating an approval granted earlier in this same round's pool pass.
  state.appendEvent("plan-approved", { round_id: round.round_id, issue: 102 });

  forge.issueBodies[100] = PLAN_BODY;
  // #214 gate② review (delta P2): #101's body must carry a real verification-plan section, or
  // confirmOneIssue's own extractVerificationPlan pre-check skips the confirm session outright
  // (the approved-but-planless orphan path — a DIFFERENT test covers that directly). This test's
  // point is the confirm session ITSELF, so #101 needs a genuine plan to reach it.
  forge.issueBodies[101] = PLAN_BODY;
  forge.poolEligibleIssues = [
    { number: 100, title: "unadjudicated", labels: [ROUND_POOL_LABEL] }, // class 1
    { number: 101, title: "approved prior round", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }, // class 2
    { number: 102, title: "approved this round", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }, // class 3
    { number: 103, title: "doc-gate", labels: [ROUND_POOL_LABEL, cfg.labels.verifyNa] }, // class 4
    { number: 104, title: "non-pool ready", labels: [] }, // dispatchable but NOT a pool member
  ];

  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-100", sapwoodResult({ decision: "approve", issue: 100 })) },
    { result: doneResult("confirm-101", sapwoodResult({ decision: "confirm", issue: 101 })) },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });

  assert.equal(runner.calls.length, 2, "exactly one session for class 1, one for class 2 — classes 3/4 and the non-pool issue get zero");
  assert.deepEqual(
    runner.calls.map((c) => [c.roleId, /Number: #(\d+)/.exec(c.prompt)?.[1]]),
    [
      ["plan-reviewer", "100"],
      ["plan-reviewer-confirm", "101"],
    ],
  );
  // #214 gate② review (P1): the confirm session — and ONLY the confirm session — runs under the
  // widened, read-only CONFIRM_ALLOWED_TOOLS/CONFIRM_DISALLOWED_TOOLS pair; the ordinary reviewer
  // session stays on the base issues-only (no tool grant) scope, unchanged.
  assert.equal(runner.calls[0]!.allowedTools, undefined, "the reviewer session's tool scope is unchanged (base ROLE_ALLOWED_TOOLS)");
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
  assert.equal(runner.calls[1]!.allowedTools, CONFIRM_ALLOWED_TOOLS);
  assert.equal(runner.calls[1]!.disallowedTools, CONFIRM_DISALLOWED_TOOLS);
  assert.ok(forge.issueLabels[100]!.includes(cfg.labels.planApproved), "class 1 converged to approved");
  assert.equal(
    forge.issueLabels[101],
    undefined,
    "class 2 confirm made ZERO forge label writes — addLabel/removeLabel never called for #101",
  );
  assert.equal(forge.updateIssueBodyCalls.length, 0, "no body writes at all for the confirm-only class");
  assert.equal(forge.issueCommentsPosted.length, 0, "confirm makes no comments either — truly zero forge writes");
  assert.equal(forge.issueLabels[103], undefined, "class 4 (verify:n/a) untouched — no confirm, no session");
  assert.equal(forge.issueLabels[104], undefined, "non-pool Ready issue gets zero gate⓪ attention of any kind");
  state.close();
});

test("createPlanReviewStub (#214 gate② review delta P2): an approved-but-planless orphan (plan:approved survives, but the verification-plan section was deleted from the body) skips the confirm session ENTIRELY — a deterministic, engine-authored brief feeds the drafter cycle directly, no session spent on an unwinnable confirm, no infinite re-pool loop", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 220, title: "orphaned", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  forge.issueBodies[220] = "This body used to have a plan but someone deleted the section.";
  const NEW_BODY = "Repaired.\n\n## Acceptance criteria\n\n- [ ] it works\n\n## Verification\n\nRun the suite.";
  const runner = new ScriptedRunner([
    { result: doneResult("drafter-220", sapwoodResult({ issue: 220 }, NEW_BODY)) },
    { result: doneResult("reviewer-220", sapwoodResult({ decision: "approve", issue: 220 })) },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });

  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-drafter", "plan-reviewer"],
    "NO plan-reviewer-confirm session at all — the engine skipped straight to the draft cycle, deterministically",
  );
  assert.ok(
    runner.calls[0]!.prompt.includes("verification-plan section"),
    "the drafter's brief is the engine-authored, deterministic explanation, not anything a session produced",
  );
  assert.deepEqual(forge.updateIssueBodyCalls, [[220, NEW_BODY]]);
  assert.ok(forge.issueLabels[220]!.includes(cfg.labels.planApproved), "converged back to approved via the ordinary cycle");
  state.close();
});

test("createPlanReviewStub (#214): confirm 'invalidate' feeds the SAME draft-cycle machinery an unadjudicated draft_request would — reviewer brief -> drafter -> re-review, existing caps, converges to approved", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 200, title: "stale plan", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real verification-plan SECTION must be present (confirmOneIssue's
  // own extractVerificationPlan pre-check would otherwise skip the confirm session outright) — the
  // STALENESS this test's narrative is about lives in the CONTENT (a renamed file), not in the
  // section's mere presence.
  forge.issueBodies[200] =
    "OLD PLAN referencing a file since renamed.\n\n## Verification\n\nRun `npm test` from the old (now-renamed) location.";
  const NEW_BODY = "NEW PLAN\n\n## Acceptance criteria\n\n- [ ] it works\n\n## Verification\n\nRun the new suite.";
  const runner = new ScriptedRunner([
    { result: doneResult("confirm-200", sapwoodResult({ decision: "invalidate", issue: 200 }, "references a file since renamed on main")) },
    { result: doneResult("drafter-200", sapwoodResult({ issue: 200 }, NEW_BODY)) },
    { result: doneResult("reviewer-200", sapwoodResult({ decision: "approve", issue: 200 })) },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });

  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer-confirm", "plan-drafter", "plan-reviewer"],
  );
  assert.ok(
    runner.calls[1]!.prompt.includes("references a file since renamed on main"),
    "the confirm's invalidate brief reached the drafter verbatim",
  );
  assert.equal(runner.calls[1]!.disallowedTools, PLAN_DRAFTER_DISALLOWED_TOOLS, "the drafter's own grants are unchanged");
  assert.deepEqual(forge.updateIssueBodyCalls, [[200, NEW_BODY]]);
  assert.ok(forge.issueLabels[200]!.includes(cfg.labels.planApproved), "converged back to approved via the existing cycle");
  state.close();
});

// ── #214 gate② review (P2): confirm-invalidate can route into a verify_na verdict on an issue
//    that ALREADY carries plan:approved — a state reviewOneIssue never saw pre-#214. Following
//    the ordinary "remove needs-human to accept" comment literally would leave the forbidden
//    verifyNa+planApproved mixed state (#94) — excluded from dispatch AND (post gate② review P2)
//    pool re-entry — permanently, invisibly. The engine names BOTH cleanup options explicitly
//    whenever this is reachable. ──

test("createPlanReviewStub (#214 gate② review P2): confirm 'invalidate' -> seeded reviewer proposes verify_na on an issue that ALREADY carries plan:approved -> the escalation comment names BOTH cleanup options (remove needs-human+plan:approved to accept the doc-gate path, or needs-human+verify:n/a to keep the plan path) — never just 'remove needs-human'", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [
    { number: 201, title: "stale plan, actually unverifiable", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] },
  ];
  // #214 gate② review (delta P2): a real plan section, or confirmOneIssue's own pre-check skips
  // the confirm session entirely (a different test covers that path).
  forge.issueBodies[201] = PLAN_BODY;
  const runner = new ScriptedRunner([
    { result: doneResult("confirm-201", sapwoodResult({ decision: "invalidate", issue: 201 }, "the whole approach is now moot")) },
    // The seed's synthetic "draft_request" always briefs a drafter FIRST (reviewOneIssue's
    // ordinary cycle shape — a seed only replaces cycle 0's REVIEWER session, never the
    // drafter that decision type triggers); the drafted body then feeds a REAL cycle-1
    // reviewer session, which is where this test's verify_na verdict actually lands.
    {
      result: doneResult(
        "drafter-201",
        sapwoodResult(
          { issue: 201 },
          "Revised, but genuinely unverifiable.\n\n## Acceptance criteria\n\n- [ ] n/a\n\n## Verification\n\nn/a",
        ),
      ),
    },
    {
      result: doneResult(
        "reviewer-201",
        sapwoodResult({ decision: "verify_na", issue: 201 }, "Turns out this work is inherently unverifiable."),
      ),
    },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });

  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer-confirm", "plan-drafter", "plan-reviewer"],
    "invalidate seeded the cycle into the ordinary brief -> drafter -> re-review shape; the re-review is where this test's verify_na verdict lands",
  );
  assert.ok(forge.issueLabels[201]!.includes(cfg.labels.needsHuman));
  assert.ok(forge.issueLabels[201]!.includes(cfg.labels.verifyNa));
  // plan:approved is never touched by the engine (#147) — it's still there, unmentioned by any
  // addLabel/removeLabel call, exactly the reachable-but-unhandled state gate② review P2 flagged.
  assert.ok(!forge.removeLabelCalls.some(([n, l]) => n === 201 && l === cfg.labels.planApproved));
  const comment = lastComment(forge, 201);
  assert.ok(comment.includes("Turns out this work is inherently unverifiable"), "the session's own explanation still leads");
  assert.ok(
    comment.includes(`remove BOTH`) && comment.includes(cfg.labels.planApproved),
    "names plan:approved as part of the accept-doc-gate cleanup",
  );
  assert.ok(comment.includes("keep the plan path"), "also names the keep-the-plan-path alternative");
  state.close();
});

test("createPlanReviewStub (#214 gate② review P2): an ORDINARY (never-approved) verify_na proposal's comment is UNCHANGED — no dual-label instruction, since plan:approved was never granted in the first place", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 202, title: "plain docs work", labels: [ROUND_POOL_LABEL] }]; // class 1, no plan:approved
  const runner = new ScriptedRunner([
    {
      result: doneResult(
        "reviewer-202",
        sapwoodResult({ decision: "verify_na", issue: 202 }, "Pure docs work, no verification plan applies."),
      ),
    },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  const comment = lastComment(forge, 202);
  assert.ok(comment.includes("Pure docs work"));
  assert.ok(!comment.includes("remove BOTH"), "no dual-label instruction — this issue never carried plan:approved to begin with");
  assert.ok(!comment.includes(cfg.labels.planApproved), "plan:approved isn't even mentioned");
  state.close();
});

// ── #214 gate② review (delta P2): the verify_na branch's write ORDER — needsHuman label ->
//    comment -> verifyNa label, pinned via FakeForge's unified writeLog (labelsAdded/
//    issueCommentsPosted alone can't prove INTERLEAVING). Every crash window must be safe: a
//    crash between the two label writes must never leave verifyNa landed without the (possibly
//    dual-label) comment already durably posted — see the branch's own ordering-invariant
//    comment for the full crash-window analysis. ──

test("createPlanReviewStub (#214 gate② review delta P2): verify_na write order, UNAPPROVED variant — needsHuman label, THEN the comment, THEN verifyNa label; verifyNa never lands before the comment", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 210, title: "plain docs work", labels: [ROUND_POOL_LABEL] }];
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-210", sapwoodResult({ decision: "verify_na", issue: 210 }, "Pure docs work.")) },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  const log = forge.writeLog.filter((e) => e.issue === 210);
  assert.deepEqual(
    log.map((e) => [e.kind, e.detail.includes(cfg.labels.needsHuman) || e.detail.includes(cfg.labels.verifyNa) ? e.detail : "(comment)"]),
    [
      ["add-label", cfg.labels.needsHuman],
      ["comment", "(comment)"],
      ["add-label", cfg.labels.verifyNa],
    ],
  );
});

test("createPlanReviewStub (#214 gate② review delta P2): verify_na write order, ALREADY-APPROVED variant (confirm-invalidate reachable path) — same needsHuman -> comment -> verifyNa order, with the dual-cleanup comment landing BEFORE verifyNa either way", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 211, title: "stale, actually unverifiable", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real plan section, or the confirm session is skipped outright.
  forge.issueBodies[211] = PLAN_BODY;
  const runner = new ScriptedRunner([
    { result: doneResult("confirm-211", sapwoodResult({ decision: "invalidate", issue: 211 }, "moot now")) },
    {
      result: doneResult(
        "drafter-211",
        sapwoodResult({ issue: 211 }, "Revised.\n\n## Acceptance criteria\n\n- [ ] n/a\n\n## Verification\n\nn/a"),
      ),
    },
    { result: doneResult("reviewer-211", sapwoodResult({ decision: "verify_na", issue: 211 }, "Turns out unverifiable.")) },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  // #211's full write log: the seed's own draft_request brief is posted as a comment FIRST
  // (reviewOneIssue's ordinary "request-a-draft" step, unrelated to the verify_na ordering under
  // test here), THEN cycle 1's REAL reviewer session lands its verify_na verdict — that's the
  // needsHuman -> comment -> verifyNa triple this test actually pins.
  const log = forge.writeLog.filter((e) => e.issue === 211);
  assert.deepEqual(
    log.map((e) => e.kind),
    ["comment", "add-label", "comment", "add-label"],
    "the seed's own brief comment, THEN needsHuman add-label, THEN the verify_na comment, THEN verifyNa add-label — never verifyNa before its own comment",
  );
  assert.equal(log[1]!.detail, cfg.labels.needsHuman);
  assert.equal(log[3]!.detail, cfg.labels.verifyNa);
  assert.ok(log[2]!.detail.includes("remove BOTH"), "the comment that landed BEFORE verifyNa already carries the dual-cleanup instruction");
});

test("createPlanReviewStub (#214): a confirm session that fails TWICE escalates needs-human with a one-entry attempt trail — never briefs a drafter off nothing", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 300, title: "t", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real plan section, or the confirm session is skipped outright.
  forge.issueBodies[300] = PLAN_BODY;
  const runner = new ScriptedRunner([{ result: failedResult("confirm-0") }, { result: failedResult("confirm-0-retry") }]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });

  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer-confirm", "plan-reviewer-confirm"],
    "one retry, never a drafter",
  );
  assert.ok(forge.issueLabels[300]!.includes(cfg.labels.needsHuman));
  assert.ok(
    !forge.removeLabelCalls.some(([n, l]) => n === 300 && l === cfg.labels.planApproved),
    "plan:approved is NEVER removed by the confirm path, even on escalation",
  );
  const comment = lastComment(forge, 300);
  assert.ok(/failed/.test(comment));
  assert.ok(comment.includes(planReviewMarker(round.round_id)));
  const events = state.eventsSince("2020-01-01T00:00:00.000Z", ["plan-review-escalated"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { round_id: number; issue: number };
  assert.equal(payload.round_id, round.round_id);
  assert.equal(payload.issue, 300);
  state.close();
});

test("createPlanReviewStub (#214): a confirm session producing invalid structured output TWICE also escalates (same isValid-hook treatment as the reviewer/drafter sessions)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 301, title: "t", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real plan section, or the confirm session is skipped outright.
  forge.issueBodies[301] = PLAN_BODY;
  const runner = new ScriptedRunner([
    { result: doneResult("confirm-0", "no structured output at all") },
    { result: doneResult("confirm-0-retry", "still just prose") },
  ]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  assert.ok(forge.issueLabels[301]!.includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 301);
  assert.ok(/structured output/.test(comment));
  state.close();
});

test("createPlanReviewStub (#214) same-round detection: an issue approved earlier THIS round is skipped (class 3, no session) on a later same-round pool pass — never re-confirmed", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.issueBodies[400] = PLAN_BODY;
  forge.poolEligibleIssues = [{ number: 400, title: "t", labels: [ROUND_POOL_LABEL] }]; // class 1, first pass
  const runner = new ScriptedRunner([{ result: doneResult("reviewer-400", sapwoodResult({ decision: "approve", issue: 400 })) }]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);

  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null }); // approves #400
  assert.equal(runner.calls.length, 1);
  assert.ok(forge.issueLabels[400]!.includes(cfg.labels.planApproved));

  // Simulate the SAME round re-entering the pool (a crash-rerun before the phase marker
  // persisted, replaying with marker: null again) — #400 now carries plan:approved backed by a
  // plan-approved event from THIS round, so it must read as class 3 (skip), never class 2.
  forge.poolEligibleIssues = [{ number: 400, title: "t", labels: forge.issueLabels[400]! }];
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 1, "no additional session — the approval happened THIS round");
  state.close();
});

test("createPlanReviewStub (#214) same-round detection: an issue approved in a PRIOR round gets a confirm pass on its NEXT round's pool entry (class 2, not class 3)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-18T00:00:00.000Z");
  state.appendEvent("plan-approved", { round_id: round1.round_id, issue: 500 });
  const round2 = state.startRound("2026-07-18T01:00:00.000Z"); // start_event_id is AFTER the event above
  forge.poolEligibleIssues = [{ number: 500, title: "t", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real plan section, or the confirm session is skipped outright.
  forge.issueBodies[500] = PLAN_BODY;
  const runner = new ScriptedRunner([{ result: doneResult("confirm-500", sapwoodResult({ decision: "confirm", issue: 500 })) }]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round2.round_id, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer-confirm"],
    "a confirm pass ran — the approval is from a PRIOR round",
  );
  state.close();
});

test("createPlanReviewStub (#214): a pre-#214 approval with NO plan-approved event at all reads as a PRIOR-round approval — one confirm pass (accepted one-time backfill), never silently skipped", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  const round = state.startRound("2026-07-18T00:00:00.000Z");
  forge.poolEligibleIssues = [{ number: 600, title: "t", labels: [ROUND_POOL_LABEL, cfg.labels.planApproved] }];
  // #214 gate② review (delta P2): a real plan section, or the confirm session is skipped outright.
  forge.issueBodies[600] = PLAN_BODY;
  const runner = new ScriptedRunner([{ result: doneResult("confirm-600", sapwoodResult({ decision: "confirm", issue: 600 })) }]);
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: round.round_id, phase: "plan_review", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["plan-reviewer-confirm"],
  );
  state.close();
});

test("validateConfirmOutput: truncated sentinel (no matching end) -> fail-closed, never a partial parse", () => {
  const text = `${RESULT_BLOCK_START}\n{"decision":"confirm"`;
  const result = validateConfirmOutput(text, 1);
  assert.equal(result.ok, false);
});

test("validateConfirmOutput: schema-invalid decision value -> fail-closed", () => {
  const result = validateConfirmOutput(sapwoodResult({ decision: "maybe", issue: 1 }), 1);
  assert.equal(result.ok, false);
});

test("validateConfirmOutput: issue number mismatch -> fail-closed (never trust a decision for the wrong issue)", () => {
  const result = validateConfirmOutput(sapwoodResult({ decision: "confirm", issue: 999 }), 1);
  assert.equal(result.ok, false);
});

test("validateConfirmOutput: 'invalidate' with no BODY block -> fail-closed (required brief absent)", () => {
  const result = validateConfirmOutput(sapwoodResult({ decision: "invalidate", issue: 1 }), 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /BODY block/.test(result.reason));
});

test("validateConfirmOutput: well-formed 'confirm' -> ok, no body required", () => {
  const result = validateConfirmOutput(sapwoodResult({ decision: "confirm", issue: 1 }), 1);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.decision === "confirm");
});

test("validateConfirmOutput: well-formed 'invalidate' -> ok, carries the body verbatim as the drafter's brief", () => {
  const result = validateConfirmOutput(sapwoodResult({ decision: "invalidate", issue: 1 }, "drifted: file renamed"), 1);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.decision === "invalidate" && result.body === "drifted: file renamed");
});

test("defaultPlanConfirmPromptPath: resolves to a real shipped file describing the confirm/invalidate contract, not a `gh` command", () => {
  const confirmTemplate = loadRolePromptTemplate(undefined, defaultPlanConfirmPromptPath());
  assert.ok(confirmTemplate.includes("{{issue.number}}"));
  assert.ok(confirmTemplate.includes(RESULT_BLOCK_START) && confirmTemplate.includes(BODY_BLOCK_START));
  assert.ok(!/`gh issue (comment|edit)/.test(confirmTemplate), "the confirm prompt never instructs a gh command");
  assert.ok(/confirm/.test(confirmTemplate) && /invalidate/.test(confirmTemplate));
});
