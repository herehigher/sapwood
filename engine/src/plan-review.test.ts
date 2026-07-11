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
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlanReviewStub, planReviewMarker, renderRolePrompt, loadRolePromptTemplate,
  defaultPlanReviewerPromptPath, defaultPlanDrafterPromptPath, validateReviewerOutput,
  validateDrafterOutput, type PlanReviewDeps,
} from "./plan-review.js";
import { PLAN_DRAFTER_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "./peripheral.js";
import {
  RESULT_BLOCK_START, RESULT_BLOCK_END, BODY_BLOCK_START, BODY_BLOCK_END,
} from "./structured-output.js";
import type { IForge, Issue, PRStatus, PRReviewData, CommitInfo } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  /** Mutable per-issue body — updateIssueBody writes here, and getIssueBody (the P1 refetch)
   *  reads it back, so tests can prove the next reviewer render sees an applied edit. */
  issueBodies: Record<number, string> = {};
  labelsAdded: Array<[number, string]> = [];
  issueCommentsPosted: Array<[number, string]> = [];
  getIssueCommentsCallCount = 0;

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> {
    this.labelsAdded.push([n, l]);
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true }; }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> { this.issueCommentsPosted.push([n, body]); }
  async getIssueBody(issue: number): Promise<string> { return this.issueBodies[issue] ?? ""; }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
    this.issueBodies[issue] = body;
  }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async getPRDiff(): Promise<string> { return ""; }
  async getCommitsSince(): Promise<CommitInfo[]> { return []; }
  async branchExists(): Promise<boolean> { return false; }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments(issue: number) { this.getIssueCommentsCallCount++; return this.issueComments[issue] ?? []; }
  async createIssue(): Promise<number> { return 0; }
  async listOpenIssueNumbers(): Promise<number[]> { return []; }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return []; }
}

/** A scripted fake of RoleRunner.run — each call consumes the next scripted result (or the
 *  last one, repeated) and, when given, applies a side effect purely for TEST OBSERVATION (e.g.
 *  asserting on the prompt a later cycle was rendered with) — never a forge write anymore; the
 *  engine is what performs every forge write now, driven by resultText. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(
    private readonly script: Array<{ result: RoleSessionResult; effect?: (opts: RoleSessionOpts) => void }>,
  ) {}
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
  outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name, resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed", costUsd: 0.01, modelUsage: [], exitCode: 1, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

/** The MOST RECENT comment posted on an issue — a cycle that bounces (posts a brief) before
 *  eventually escalating (posts a SECOND, distinct comment) has more than one, and the
 *  escalation-specific assertions below care about the last one, not whichever happens first. */
const lastComment = (forge: FakeForge, issue: number): string => {
  const posted = forge.issueCommentsPosted.filter(([n]) => n === issue);
  return posted[posted.length - 1]?.[1] ?? "";
};

// A body that satisfies extractVerificationPlan (the content invariant every "approve"/drafted
// claim is re-checked against).
const PLAN_BODY = "Some description.\n\n## Verification\n\nRun `npm test` and confirm green.";
const NO_PLAN_BODY = "Some description with no verification section at all.";

test("createPlanReviewStub: marker present -> returns it unchanged, no forge call, no session run (idempotence)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 1, title: "t", labels: [] }];
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
  forge.planReviewCandidates = [{ number: 10, title: "t", labels: [] }];
  forge.issueBodies[10] = PLAN_BODY; // the CURRENT body already carries a plan
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 10 })) },
  ]);
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
  forge.planReviewCandidates = [{ number: 50, title: "t", labels: [] }];
  forge.issueBodies[50] = NO_PLAN_BODY; // current body has no plan — the REVISION supplies one
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "approve", issue: 50 }, PLAN_BODY)) },
  ]);
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
  forge.planReviewCandidates = [{ number: 11, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-1", sapwoodResult({ decision: "verify_na", issue: 11 }, "Pure docs work, no verification plan applies.")) },
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
  forge.planReviewCandidates = [{ number: 12, title: "t", labels: [] }];
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
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter", "plan-reviewer"]);
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

test("createPlanReviewStub P1: after the drafter's body is applied, the NEXT reviewer render sees the NEW body (refetched per cycle, never the phase-start snapshot)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 30, title: "t", labels: [], body: "OLD PLAN — inadequate" }];
  forge.issueBodies[30] = "OLD PLAN — inadequate";
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const NEW_BODY = "NEW PLAN — concrete criteria\n\n## Verification\n\nRun the new test suite.";
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
  forge.planReviewCandidates = [{ number: 31, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: failedResult("reviewer-0") },
    { result: failedResult("reviewer-0-retry") },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 2, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-reviewer"], "one retry, no drafter");
  assert.ok((forge.issueLabels[31] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 31);
  assert.ok(/failed/.test(comment), "the escalation comment names the session failure");
  assert.ok(comment.includes(planReviewMarker(2)));
  state.close();
});

test("createPlanReviewStub P2: a reviewer failure followed by a successful+valid retry continues normally (approve on the retry)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 32, title: "t", labels: [] }];
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
  forge.planReviewCandidates = [{ number: 33, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", "I looked at the issue and it seems fine to me.") },
    { result: doneResult("reviewer-0-retry", "still just prose, no structured output") },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-reviewer"], "no drafter ever ran");
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
  forge.planReviewCandidates = [{ number: 34, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("reviewer-0", sapwoodResult({ decision: "draft_request", issue: 34 })) }, // no body
    { result: doneResult("reviewer-0-retry", sapwoodResult({ decision: "draft_request", issue: 34 }, "   \n  ")) }, // whitespace-only
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-reviewer"]);
  assert.ok((forge.issueLabels[34] ?? []).includes(cfg.labels.needsHuman));
  const comment = lastComment(forge, 34);
  assert.ok(/BODY block/.test(comment));
  state.close();
});

test("createPlanReviewStub #110: an 'approve' whose body has no verification plan, TWICE -> treated as invalid output, never honored", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 35, title: "t", labels: [] }];
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
  forge.planReviewCandidates = [{ number: 36, title: "t", labels: [] }];
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
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter", "plan-drafter"]);
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
  forge.planReviewCandidates = [{ number: 13, title: "t", labels: [] }];
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
  forge.planReviewCandidates = [{ number: 13, title: "t", labels: [] }];
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
  forge.planReviewCandidates = [{ number: 31, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: failedResult("reviewer-0") },
    { result: failedResult("reviewer-0-retry") },
  ]);
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
  forge.planReviewCandidates = [{ number: 33, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: failedResult("reviewer-0") }, { result: failedResult("reviewer-0-retry") }]);
  const state = new State(":memory:");
  state.appendEvent = () => { throw new Error("simulated disk failure"); };
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await assert.doesNotReject(() => stub.run({ roundId: 3, phase: "plan_review", marker: null }));
  assert.ok((forge.issueLabels[33] ?? []).includes(cfg.labels.needsHuman), "the forge escalation still landed");
  state.close();
});

test("createPlanReviewStub: processes every candidate issue, independently", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 20, title: "a", labels: [] },
    { number: 21, title: "b", labels: [] },
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
    assert.throws(() => loadRolePromptTemplate(missing, defaultPlanReviewerPromptPath()), new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
