// align.test.ts (#89): the `aligning` phase's PO peripheral — goal decomposition (creates
// issues), the round-start triage pass (drafts plans into existing plan-less issues), and
// round-marker idempotence. Fakes the underlying role session (RoleRunner) directly, same
// "fake the collaborator, not the CLI" split as plan-review.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAligningStub, alignMarker, loadPlanMd, defaultPoPromptPath, type AlignDeps,
} from "./align.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { PO_ALLOWED_TOOLS } from "./peripheral.js";
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  issueLabels: Record<number, string[]> = {};
  issueBodies: Record<number, string> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  boardStatusCalls: Array<[number, string]> = [];
  planTriageCandidates: Issue[] = [];

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(n: number, s: "ready" | "inProgress" | "done"): Promise<void> {
    this.boardStatusCalls.push([n, s]);
  }
  async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> { this.issueCommentsPosted.push([n, body]); }
  async getIssueBody(issue: number): Promise<string> { return this.issueBodies[issue] ?? ""; }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return []; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments() { return []; }
  async createIssue(title: string, body: string): Promise<number> {
    const n = this.nextIssueNumber++;
    this.createdIssues.push({ title, body });
    this.issueBodies[n] = body;
    this.openIssueNumbers.push(n);
    return n;
  }
  async listOpenIssueNumbers(): Promise<number[]> { return this.openIssueNumbers; }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return this.planTriageCandidates; }
}

/** Scripted fake of RoleRunner.run — same shape as plan-review.test.ts's ScriptedRunner: each
 *  call consumes the next scripted result (or the last one, repeated) and, when given, applies
 *  a side effect simulating what the REAL headless session would have done. */
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

const doneResult = (name: string): RoleSessionResult => ({
  outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

test("createAligningStub: marker present -> returns it unchanged, no forge/session calls at all (idempotence)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  state.close();
});

test("createAligningStub: dispatches the align session with PO_ALLOWED_TOOLS, no created issues -> returns the round's marker", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("po-align-1") }]); // session runs, creates nothing
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(5));
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "po-align");
  assert.equal(runner.calls[0]!.allowedTools, PO_ALLOWED_TOOLS);
  assert.equal(state.spentUsdForWorker("po-align-1"), 0.01);
  state.close();
});

test("createAligningStub: a PO-created issue with a plan section gets stamped origin:agent, never needs-human, never board status", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      // Simulates the real session's `gh issue create` — carries a real plan section.
      effect: async () => { await forge.createIssue("Do the thing", "Body.\n## Verification\n- run npm test"); },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1);
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0, "the PO never sets board Status=Ready");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes("PO alignment"));
  assert.ok(comment.includes(alignMarker(1)));
  state.close();
});

test("createAligningStub: a PO-created issue WITHOUT a plan section is escalated needs-human, never left silently planless", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => { await forge.createIssue("Vague issue", "Just a title, no plan."); },
    },
  ]);
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

test("createAligningStub: multiple created issues are each processed independently", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => {
        await forge.createIssue("a", "## Acceptance criteria\n- x");
        await forge.createIssue("b", "no plan here");
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.openIssueNumbers.length, 2);
  const [a, b] = forge.openIssueNumbers as [number, number];
  assert.ok(forge.issueLabels[a]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[a]!.includes(cfg.labels.needsHuman));
  assert.ok(forge.issueLabels[b]!.includes("origin:agent"));
  assert.ok(forge.issueLabels[b]!.includes(cfg.labels.needsHuman));
  state.close();
});

test("createAligningStub: an issue open BEFORE the align session ran is never mistaken for one it created", async () => {
  const forge = new FakeForge();
  forge.openIssueNumbers = [1, 2, 3]; // pre-existing open issues, unrelated to this round
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: doneResult("po-align-1") }]); // creates nothing new
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 4, phase: "aligning", marker: null });
  assert.equal(forge.issueCommentsPosted.length, 0, "no post-check ran against any pre-existing issue");
});

test("createAligningStub: triage pass briefs a po-triage session per plan-less candidate, posts a traceable comment", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 50, title: "human-filed, no plan", labels: [], body: "just a description" },
  ];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("po-align-1") }, // align pass: creates nothing
    {
      result: doneResult("po-triage-50"),
      effect: async () => { forge.issueBodies[50] = "just a description\n## Verification\n- run npm test"; },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 6, phase: "aligning", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-triage"]);
  assert.equal(runner.calls[1]!.allowedTools, PO_ALLOWED_TOOLS);
  assert.ok(runner.calls[1]!.prompt.includes("#50"));
  assert.equal(state.spentUsdForWorker("po-triage-50"), 0.01);
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
    { result: doneResult("po-align-1") },
    { result: doneResult("po-triage-60") },
    { result: doneResult("po-triage-61") },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 7, phase: "aligning", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-triage", "po-triage"]);
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
    { result: doneResult("po-align-1") },
    { result: doneResult("po-triage-70") },
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

// ── template rendering + loading (unit) ─────────────────────────────────────────────────────

test("defaultPoPromptPath: resolves to a real shipped file with both align and triage sections", () => {
  const template = loadRolePromptTemplate(undefined, defaultPoPromptPath());
  assert.ok(template.includes("{{po.mode}}"));
  assert.ok(template.includes("{{round.milestone}}"));
  assert.ok(template.includes("{{plan.md}}"));
  assert.ok(template.includes("{{issue.number}}"));
  assert.ok(template.includes("{{issue.body}}"));
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

test("PO_ALLOWED_TOOLS: carries issue-creation on top of the base scope, but no board-status/project capability (structural no-Ready guarantee)", () => {
  assert.ok(PO_ALLOWED_TOOLS.includes("Bash(gh issue create*)"));
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh api"), "no channel to board-status/project mutation");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh project"));
  assert.ok(!PO_ALLOWED_TOOLS.includes("git"), "no code/repo capability");
});
