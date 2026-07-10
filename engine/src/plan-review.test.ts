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
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
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
  async getIssueBody(): Promise<string> { return ""; }
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
  assert.ok(forge.issueLabels[12]!.includes("plan:approved"));
  cycle++;
  assert.equal(cycle, 1);
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
