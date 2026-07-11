// round-defaults.test.ts (#104): createDefaultPeripherals — the factory that wires the REAL
// role-session stubs (aligning/architecting/plan_review/harvesting/retro) into runRounds's
// `peripherals` map. Two levels: (1) a structural check that the returned map carries all five
// phases and none of them is noopPeripheralStub; (2) an integration test — the SAME "fake the
// collaborator, not the CLI" split every other peripheral test file uses — proving a runRounds
// invocation wired with this factory's output actually dispatches all five real role sessions
// (no noop remains in the shipped default map, #104's acceptance criterion).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultPeripherals } from "./round-defaults.js";
import { runRounds, noopPeripheralStub, type RoundDeps } from "./round.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { Supervisor, LaneProbe } from "./conductor.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> { this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l]; }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true }; }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> { this.issueCommentsPosted.push([n, body]); }
  async getIssueBody(): Promise<string> { return ""; }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> { this.updateIssueBodyCalls.push([issue, body]); }
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
  async listOpenIssueNumbers(): Promise<number[]> { return this.openIssueNumbers; }
  planTriageCandidates: Issue[] = [];
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return this.planTriageCandidates; }
}

class MinimalSupervisor implements Supervisor {
  async probe(): Promise<LaneProbe> { return { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false }; }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> { return { name: `lane-${issue.number}`, sessionId: "s" }; }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> { return { worktreePath: null, worktreeRetained: false }; }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } { return { worktreePath: null, worktreeRetained: false }; }
  requestHandoff(): boolean { return true; }
}

/** One shared scripted fake for every role session dispatched across the whole round — real
 *  stubs each get their OWN RoleRunner-shaped dep, but this factory feeds them all the same
 *  `runner`, exactly like a real caller would (peripheral.ts's module doc: RoleRunner is the
 *  single spawn/sentinel/cost-parse implementation every role reuses). Applies the one side
 *  effect this round actually needs to converge without a drafter: the plan-reviewer approves
 *  its candidate immediately. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  constructor(private readonly forge: FakeForge, private readonly cfg: SapwoodConfig) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    if (opts.roleId === "plan-reviewer") {
      for (const issue of this.forge.planReviewCandidates) {
        await this.forge.addLabel(issue.number, this.cfg.labels.planApproved);
      }
    }
    return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1` };
  }
}

test("createDefaultPeripherals: every PeripheralPhase key is present and none of them is noopPeripheralStub", () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  for (const phase of ["aligning", "architecting", "plan_review", "harvesting", "retro"] as const) {
    assert.ok(peripherals[phase], `expected a real stub for ${phase}`);
    assert.notEqual(peripherals[phase], noopPeripheralStub, `${phase} must not be the noop stub`);
  }
  state.close();
});

test("createDefaultPeripherals (#109 gate② P2): with round.milestone set, the peripherals' forge is milestone-scoped — plan review and PO triage never touch issues outside the round's milestone", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 5, title: "in-scope review candidate", labels: [], milestone: "M-X" },
    { number: 6, title: "out-of-scope review candidate", labels: [] },
  ];
  forge.planTriageCandidates = [
    { number: 7, title: "in-scope triage candidate", labels: [], milestone: "M-X" },
    { number: 8, title: "out-of-scope triage candidate", labels: [] },
  ];
  const cfg = mkCfg({ round: { milestone: "M-X" } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  // Drive the two candidate-consuming stubs directly (round.ts's SEQUENCE order is round.test.ts
  // territory; the scoping property under test is per-stub).
  await peripherals.plan_review!.run({ roundId: 1, phase: "plan_review", marker: null });
  const reviewerCalls = runner.calls.filter((c) => c.roleId === "plan-reviewer");
  assert.equal(reviewerCalls.length, 1, "exactly one reviewer session — the in-milestone candidate only");
  assert.match(reviewerCalls[0]!.prompt, /in-scope review candidate/);
  assert.doesNotMatch(reviewerCalls[0]!.prompt, /out-of-scope/);

  await peripherals.aligning!.run({ roundId: 1, phase: "aligning", marker: null });
  const triageCalls = runner.calls.filter((c) => c.roleId === "po-triage");
  assert.equal(triageCalls.length, 1, "exactly one triage session — the in-milestone candidate only");
  assert.match(triageCalls[0]!.prompt, /in-scope triage candidate/);
  assert.doesNotMatch(triageCalls[0]!.prompt, /out-of-scope/);
  state.close();
});

test("runRounds integration: wired with createDefaultPeripherals's output, a default round dispatches all five real role sessions — no noop remains in the shipped default map", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 5, title: "candidate", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  const deps: RoundDeps = {
    forge, state, supervisor: new MinimalSupervisor(), cfg, tickIntervalSec: 1,
    sleep: async () => {}, peripherals,
  };
  // Graceful stop mid-round (round.test.ts's own pattern, reused by align/architect/harvest/
  // retro's integration tests): the in-flight round still finishes every phase before the loop
  // actually stops — only the NEXT round is withheld. Seed a needs-human escalation right after
  // 'aligning' completes so harvest has something to brief (otherwise it appends only its
  // summary event and dispatches no session — still a real stub, but this proves the session
  // dispatch path too).
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  deps.onRoundPhase = (_roundId, phase) => {
    if (phase === "aligning") {
      state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 7, pr: 1, reason: "x" });
      stop();
    }
  };

  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed");

  const roleIdsDispatched = new Set(runner.calls.map((c) => c.roleId));
  // Every phase actually reached the runner — proof positive that no phase silently fell back
  // to noopPeripheralStub (which never calls runner.run at all).
  assert.ok(roleIdsDispatched.has("po-align"), "aligning dispatched a real PO session");
  assert.ok(roleIdsDispatched.has("architect"), "architecting dispatched a real architect session");
  assert.ok(roleIdsDispatched.has("plan-reviewer"), "plan_review dispatched a real reviewer session");
  assert.ok(roleIdsDispatched.has("harvest"), "harvesting dispatched a real harvest session");
  assert.ok(roleIdsDispatched.has("retro"), "retro dispatched a real retro session");
  // The plan-review candidate actually converged (the scripted reviewer approved it) — proof
  // the wired plan_review stub is the real orchestration, not a stand-in.
  assert.ok(forge.issueLabels[5]!.includes(cfg.labels.planApproved));
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks every real peripheral — none of createDefaultPeripherals's stubs ever runs a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-defaults-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const forge = new FakeForge();
    const cfg = mkCfg();
    const runner = new ScriptedRunner(forge, cfg);
    const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
    const deps: RoundDeps = {
      forge, state, supervisor: new MinimalSupervisor(), cfg, tickIntervalSec: 1,
      sleep: async () => {}, peripherals,
    };
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(result.rounds, 0);
    assert.equal(runner.calls.length, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
