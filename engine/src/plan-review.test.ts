// plan-review.test.ts (#87, #77 Amendment 2): the plan_review peripheral's draft -> re-review
// orchestration. Fakes the underlying role session (RoleRunner) directly — peripheral.test.ts
// already covers the real claude-stub spawn path; this file is about the ORCHESTRATION logic
// (candidate selection, outcome detection via labels, drafter briefing, cycle bounding,
// idempotent marker skip), not the CLI spawn mechanics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlanReviewStub, planReviewMarker, renderRolePrompt, loadRolePromptTemplate,
  defaultPlanReviewerPromptPath, defaultPlanDrafterPromptPath, type PlanReviewDeps,
} from "./plan-review.js";
import { PLAN_DRAFTER_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "./peripheral.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  /** Mutable per-issue body — a fake drafter's "edit" writes here, and getIssueBody (the P1
   *  refetch) reads it back, so the test can prove the next reviewer render sees the edit. */
  issueBodies: Record<number, string> = {};
  labelsAdded: Array<[number, string]> = [];
  issueCommentsPosted: Array<[number, string]> = [];

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
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments(issue: number) { return this.issueComments[issue] ?? []; }
  async createIssue(): Promise<number> { return 0; }
  async listOpenIssueNumbers(): Promise<number[]> { return []; }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return []; }
}

/** A scripted fake of RoleRunner.run — each call consumes the next scripted result (or the
 *  last one, repeated) and, when given, applies a side effect to the forge (simulating what
 *  the REAL headless session would have done: applied a label, posted a comment). */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(
    private readonly forge: FakeForge,
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

const doneResult = (name: string): RoleSessionResult => ({
  outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed", costUsd: 0.01, modelUsage: [], exitCode: 1, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

test("createPlanReviewStub: marker present -> returns it unchanged, no forge call, no session run (idempotence)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 1, title: "t", labels: [] }];
  const runner = new ScriptedRunner(forge, [{ result: doneResult("s1") }]);
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
  const runner = new ScriptedRunner(forge, [{ result: doneResult("s1") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createPlanReviewStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "plan_review", marker: null });
  assert.equal(marker, planReviewMarker(5));
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createPlanReviewStub: outcome 1 (approve) — reviewer session applies plan:approved, no drafter is ever run", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 10, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("reviewer-1"), effect: () => forge.addLabel(10, cfg.labels.planApproved) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "plan-reviewer");
  assert.ok(forge.issueLabels[10]!.includes("plan:approved"));
  // Spend recorded against the reviewer session's own name.
  assert.equal(state.spentUsdForWorker("reviewer-1"), 0.01);
  state.close();
});

test("createPlanReviewStub: outcome 3 (propose verify:n/a) — reviewer applies needs-human, orchestrator stops (a human resolves it)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 11, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    {
      result: doneResult("reviewer-1"),
      effect: () => {
        forge.addLabel(11, cfg.labels.verifyNa);
        forge.addLabel(11, cfg.labels.needsHuman);
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 1); // no drafter, no further reviewer pass
  state.close();
});

test("createPlanReviewStub: outcome 2 (request draft) — briefs a distinct plan-drafter session with the reviewer's comment, then re-reviews", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 12, title: "t", labels: [] }];
  const cfg = mkCfg();
  let cycle = 0;
  const runner = new ScriptedRunner(forge, [
    // cycle 0: reviewer bounces — posts its brief as an issue comment, applies no label.
    {
      result: doneResult("reviewer-0"),
      effect: () => {
        forge.issueComments[12] = [{ login: "plan-reviewer", createdAt: "t", body: "missing acceptance criteria" }];
      },
    },
    // cycle 0: drafter runs (briefed), edits nothing observable here — just runs.
    { result: doneResult("drafter-0") },
    // cycle 1: reviewer re-runs and NOW approves.
    { result: doneResult("reviewer-1"), effect: () => forge.addLabel(12, cfg.labels.planApproved) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter", "plan-reviewer"]);
  // The drafter's prompt was briefed with the reviewer's comment verbatim.
  assert.ok(runner.calls[1]!.prompt.includes("missing acceptance criteria"));
  // Codex #99 P1(b): the drafter runs under its stricter deny-list (no label mutation); the
  // reviewer keeps the base scope (labeling is its legitimate job).
  assert.equal(runner.calls[1]!.disallowedTools, PLAN_DRAFTER_DISALLOWED_TOOLS);
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
  assert.ok(forge.issueLabels[12]!.includes("plan:approved"));
  cycle++;
  assert.equal(cycle, 1);
  state.close();
});

test("createPlanReviewStub P1: after the drafter edits the body, the NEXT reviewer render sees the NEW body (refetched per cycle, never the phase-start snapshot)", async () => {
  const forge = new FakeForge();
  // Phase-start snapshot carries the OLD body.
  forge.planReviewCandidates = [{ number: 30, title: "t", labels: [], body: "OLD PLAN — inadequate" }];
  forge.issueBodies[30] = "OLD PLAN — inadequate";
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const runner = new ScriptedRunner(forge, [
    // cycle 0 reviewer: bounces with a brief.
    {
      result: doneResult("reviewer-0"),
      effect: () => { forge.issueComments[30] = [{ login: "r", createdAt: "t", body: "criteria too vague" }]; },
    },
    // cycle 0 drafter: EDITS the issue body — the whole point of the self-heal path.
    { result: doneResult("drafter-0"), effect: () => { forge.issueBodies[30] = "NEW PLAN — concrete criteria"; } },
    // cycle 1 reviewer: approves ONLY if its prompt embeds the drafter's NEW body. Against the
    // stale-snapshot bug this effect never fires the approval (the prompt still carries the old
    // body), the loop exhausts, and the needs-human assertion below fails the test.
    {
      result: doneResult("reviewer-1"),
      effect: (opts) => {
        if (opts.prompt.includes("NEW PLAN — concrete criteria")) forge.addLabel(30, cfg.labels.planApproved);
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 1, phase: "plan_review", marker: null });
  assert.ok((forge.issueLabels[30] ?? []).includes("plan:approved"), "cycle-1 reviewer saw the drafter's new body and approved");
  assert.ok(!(forge.issueLabels[30] ?? []).includes(cfg.labels.needsHuman), "self-heal converged — never escalated");
  state.close();
});

test("createPlanReviewStub P2: a reviewer session failure is retried once; a second failure escalates needs-human — NEVER briefs a drafter", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 31, title: "t", labels: [] }];
  // A stale, unrelated comment sits on the issue — the pre-fix bug would brief a drafter off it.
  forge.issueComments[31] = [{ login: "human", createdAt: "t", body: "unrelated old comment" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: failedResult("reviewer-0") },
    { result: failedResult("reviewer-0-retry") },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 2, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-reviewer"], "one retry, no drafter");
  assert.ok((forge.issueLabels[31] ?? []).includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === 31)?.[1] ?? "";
  assert.ok(/failed/.test(comment), "the escalation comment names the session failure");
  assert.ok(comment.includes(planReviewMarker(2)));
  state.close();
});

test("createPlanReviewStub P2: a reviewer failure followed by a successful retry continues normally (approve on the retry)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 32, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: failedResult("reviewer-0") },
    { result: doneResult("reviewer-0-retry"), effect: () => forge.addLabel(32, cfg.labels.planApproved) },
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

test("createPlanReviewStub P2: a bounce with NO usable brief (no comment / empty body) escalates needs-human — never briefs a drafter off nothing", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 33, title: "t", labels: [] }];
  const cfg = mkCfg();
  // Reviewer "succeeds" but violates its own contract: applies no label AND posts no comment.
  const runner = new ScriptedRunner(forge, [{ result: doneResult("reviewer-0") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer"], "no drafter ever ran");
  assert.ok((forge.issueLabels[33] ?? []).includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === 33)?.[1] ?? "";
  assert.ok(/brief/.test(comment), "the escalation comment names the missing brief");
  state.close();
});

test("createPlanReviewStub P2: a whitespace-only last comment is not a usable brief either", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 34, title: "t", labels: [] }];
  forge.issueComments[34] = [{ login: "r", createdAt: "t", body: "   \n  " }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [{ result: doneResult("reviewer-0") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 3, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer"]);
  assert.ok((forge.issueLabels[34] ?? []).includes(cfg.labels.needsHuman));
  state.close();
});

test("createPlanReviewStub sep-P1: a drafter that self-applies plan:approved is caught by the label post-check — contained with needs-human, cycle stopped, no further reviewer", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 40, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    // cycle 0 reviewer: bounces with a brief.
    {
      result: doneResult("reviewer-0"),
      effect: () => { forge.issueComments[40] = [{ login: "r", createdAt: "t", body: "plan is missing" }]; },
    },
    // cycle 0 drafter: VIOLATES its write discipline — self-approves its own draft.
    { result: doneResult("drafter-0"), effect: () => forge.addLabel(40, cfg.labels.planApproved) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 4, phase: "plan_review", marker: null });
  // The cycle stopped at the violation — no cycle-1 reviewer ever ran.
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter"]);
  // Contained: needs-human applied (an unconditional dispatch blocker — the poisoned
  // plan:approved cannot dispatch through it), violation named in the escalation comment.
  assert.ok((forge.issueLabels[40] ?? []).includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === 40)?.[1] ?? "";
  assert.ok(comment.includes(cfg.labels.planApproved), "the violation names the label the drafter added");
  assert.ok(comment.includes(planReviewMarker(4)));
  state.close();
});

test("createPlanReviewStub sep-P1: a drafter that self-applies verify:n/a is likewise caught", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 41, title: "t", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("reviewer-0"), effect: () => { forge.issueComments[41] = [{ login: "r", createdAt: "t", body: "plan is missing" }]; } },
    { result: doneResult("drafter-0"), effect: () => forge.addLabel(41, cfg.labels.verifyNa) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 4, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter"]);
  assert.ok((forge.issueLabels[41] ?? []).includes(cfg.labels.needsHuman));
  state.close();
});

test("createPlanReviewStub sep-P1: an honest drafter (edits the body, touches no label) sails through the post-check unaffected", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 42, title: "t", labels: [], body: "OLD" }];
  forge.issueBodies[42] = "OLD";
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("reviewer-0"), effect: () => { forge.issueComments[42] = [{ login: "r", createdAt: "t", body: "criteria vague" }]; } },
    { result: doneResult("drafter-0"), effect: () => { forge.issueBodies[42] = "NEW CONCRETE PLAN"; } },
    { result: doneResult("reviewer-1"), effect: () => forge.addLabel(42, cfg.labels.planApproved) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 4, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer", "plan-drafter", "plan-reviewer"]);
  assert.ok((forge.issueLabels[42] ?? []).includes("plan:approved"));
  assert.ok(!(forge.issueLabels[42] ?? []).includes(cfg.labels.needsHuman), "no false-positive violation");
  state.close();
});

test("createPlanReviewStub stale-brief-P2: a PRE-EXISTING comment is never accepted as the brief — reviewer done + no label + no NEW comment escalates, drafter never briefed off the stale comment", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 43, title: "t", labels: [] }];
  // A human discussion comment already sits on the issue BEFORE the reviewer ever runs.
  forge.issueComments[43] = [{ login: "human", createdAt: "2026-01-01T00:00:00Z", body: "let's discuss scope sometime" }];
  const cfg = mkCfg();
  // Reviewer "succeeds" but posts nothing and applies no label (contract violation).
  const runner = new ScriptedRunner(forge, [{ result: doneResult("reviewer-0") }]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 5, phase: "plan_review", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["plan-reviewer"], "no drafter briefed off the stale human comment");
  assert.ok((forge.issueLabels[43] ?? []).includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === 43)?.[1] ?? "";
  assert.ok(/brief/.test(comment));
  state.close();
});

test("createPlanReviewStub stale-brief-P2: with pre-existing comments, only the comment the reviewer JUST posted becomes the brief", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 44, title: "t", labels: [] }];
  forge.issueComments[44] = [{ login: "human", createdAt: "2026-01-01T00:00:00Z", body: "old unrelated discussion" }];
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const runner = new ScriptedRunner(forge, [
    // cycle 0 reviewer: appends its bounce AFTER the pre-existing comment.
    {
      result: doneResult("reviewer-0"),
      effect: () => { forge.issueComments[44]!.push({ login: "r", createdAt: "2026-01-02T00:00:00Z", body: "fresh bounce brief" }); },
    },
    { result: doneResult("drafter-0") },
    { result: doneResult("reviewer-1"), effect: () => forge.addLabel(44, cfg.labels.planApproved) },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 5, phase: "plan_review", marker: null });
  const drafterCall = runner.calls.find((c) => c.roleId === "plan-drafter");
  assert.ok(drafterCall, "drafter ran (a fresh bounce comment existed)");
  assert.ok(drafterCall!.prompt.includes("fresh bounce brief"), "briefed with the NEW comment");
  assert.ok(!drafterCall!.prompt.includes("old unrelated discussion"), "the stale comment never reaches the brief");
  state.close();
});

test("createPlanReviewStub: exhausted after maxDraftCycles — applies needs-human with the attempt trail, never loops forever", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 13, title: "t", labels: [] }];
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  // Reviewer NEVER approves, NEVER escalates itself — always bounces. Drafter always "runs".
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("reviewer-0"), effect: () => { forge.issueComments[13] = [{ login: "r", createdAt: "t", body: "still bad" }]; } },
    { result: doneResult("drafter-0") },
    { result: doneResult("reviewer-1"), effect: () => { forge.issueComments[13] = [{ login: "r", createdAt: "t2", body: "still bad again" }]; } },
  ]);
  const state = new State(":memory:");
  const deps: PlanReviewDeps = { forge, state, cfg, runner };
  const stub = createPlanReviewStub(deps);
  await stub.run({ roundId: 7, phase: "plan_review", marker: null });
  // maxDraftCycles=1 -> at most 1 draft cycle: reviewer(cycle0) -> drafter(cycle0) -> reviewer(cycle1) -> exhausted.
  assert.equal(runner.calls.length, 3);
  assert.ok(forge.issueLabels[13]!.includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === 13)?.[1] ?? "";
  assert.ok(comment.includes("exhausted"));
  assert.ok(comment.includes(planReviewMarker(7)), "the round marker is embedded in the escalation comment");
  state.close();
});

// ── #104: gate⓪ escalate() also appends a durable state event ──────────────────────────────

test("createPlanReviewStub #104: escalate() (maxDraftCycles exhausted) appends a plan-review-escalated state event naming the round and issue", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 13, title: "t", labels: [] }];
  const cfg = mkCfg({ roles: { planReviewer: { maxDraftCycles: 1 } } });
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("reviewer-0"), effect: () => { forge.issueComments[13] = [{ login: "r", createdAt: "t", body: "still bad" }]; } },
    { result: doneResult("drafter-0") },
    { result: doneResult("reviewer-1"), effect: () => { forge.issueComments[13] = [{ login: "r", createdAt: "t2", body: "still bad again" }]; } },
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
  const runner = new ScriptedRunner(forge, [
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
  const runner = new ScriptedRunner(forge, [{ result: doneResult("reviewer-0") }]);
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
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, [
    { result: doneResult("r-20"), effect: (opts) => { void opts; forge.addLabel(20, cfg.labels.planApproved); } },
    { result: doneResult("r-21"), effect: () => forge.addLabel(21, cfg.labels.planApproved) },
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

test("defaultPlanReviewerPromptPath / defaultPlanDrafterPromptPath: resolve to real shipped files", () => {
  const reviewerTemplate = loadRolePromptTemplate(undefined, defaultPlanReviewerPromptPath());
  const drafterTemplate = loadRolePromptTemplate(undefined, defaultPlanDrafterPromptPath());
  assert.ok(reviewerTemplate.includes("{{issue.number}}"));
  assert.ok(drafterTemplate.includes("{{reviewer.brief}}"));
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
