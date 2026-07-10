// harvest.test.ts (#91): the `harvesting` peripheral's round-close summary role. Fakes the
// underlying role session (RoleRunner) directly — peripheral.test.ts already covers the real
// claude-stub spawn path; this file is about the ORCHESTRATION logic (fact-gathering from the
// durable ledger, marker idempotence, and — via one integration test against round.ts's real
// runRounds — the generic graceful-vs-KILL_SWITCH peripheral behavior applied to THIS stub).
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarvestStub, gatherRoundFacts, harvestMarker, renderFactsTemplate,
  defaultHarvestPromptPath, HARVEST_DISALLOWED_TOOLS, type HarvestDeps,
} from "./harvest.js";
import { ROLE_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "./peripheral.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { runRounds, type RoundDeps, type PeripheralPhase, type PeripheralStub } from "./round.js";
import type { Supervisor, LaneProbe } from "./conductor.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";

/** Scripted fake of RoleRunner.run — captures every call's opts for assertion, returns the
 *  next scripted result (or the last one, repeated) — same pattern as plan-review.test.ts's
 *  ScriptedRunner. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  private readonly script: RoleSessionResult[];
  constructor(...script: RoleSessionResult[]) { this.script = script; }
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const result = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    return result;
  }
}

const doneResult = (name: string): RoleSessionResult => ({
  outcome: "done", costUsd: 0.02, modelUsage: [], exitCode: 0, name,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed", costUsd: 0.02, modelUsage: [], exitCode: 1, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

test("defaultHarvestPromptPath: resolves to the shipped prompts/harvest.md, which exists and mentions the round-fact vars", () => {
  const p = defaultHarvestPromptPath();
  assert.ok(existsSync(p), `expected shipped prompt at ${p}`);
  const body = readFileSync(p, "utf8");
  for (const v of ["{{round.id}}", "{{round.prsOpened}}", "{{round.prsMerged}}", "{{round.spentUsd}}", "{{round.needsHumanList}}"]) {
    assert.ok(body.includes(v), `harvest.md should reference ${v}`);
  }
});

test("renderFactsTemplate: substitutes known vars, throws on an unknown placeholder (#74 fail-closed pattern)", () => {
  assert.equal(renderFactsTemplate("round {{round.id}} spent {{round.spentUsd}}", { "round.id": "5", "round.spentUsd": "1.00" }), "round 5 spent 1.00");
  assert.throws(() => renderFactsTemplate("{{bogus}}", {}), /unknown variable \{\{bogus\}\}/);
});

test("gatherRoundFacts: sums PRs opened/merged, spend, and distinct needs-human issues from the durable ledger since round start", async () => {
  const state = new State(":memory:");
  // Before round start — must be excluded. appendEvent stamps the REAL clock, so the round's
  // started_at must also be a real-clock timestamp strictly after this event (the small sleep
  // guarantees a later millisecond).
  state.appendEvent("merged", { worker: "lane-x", issue: 99, pr: 1, headOid: "h" });
  await new Promise((r) => setTimeout(r, 5));
  const round = state.startRound(new Date().toISOString());

  state.appendEvent("reclaim-done", { worker: "lane-a", issue: 1, next: "DRIVING" }); // PR opened
  state.appendEvent("reclaim-failed", { worker: "lane-b", issue: 2, next: "DRIVING" }); // PR opened (rescued)
  state.appendEvent("reclaim-failed", { worker: "lane-c", issue: 3, next: "ESCALATE" }); // NOT opened
  state.appendEvent("reclaim-dead", { worker: "lane-d", issue: 4, next: "DRIVING", rescued: true }); // PR opened
  state.appendEvent("reclaim-dead", { worker: "lane-e", issue: 5, next: "REQUEUE", rescued: false }); // NOT opened
  state.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  state.appendEvent("merged", { worker: "lane-b", issue: 2, pr: 11, headOid: "h2" });
  state.appendEvent("drive-needs-human", { worker: "lane-f", issue: 6, pr: 12, reason: "changes requested" });
  state.appendEvent("drive-needs-human", { worker: "lane-f", issue: 6, pr: 12, reason: "still open" }); // same issue twice
  state.recordSpend("lane-a", 1, 4, new Date().toISOString());
  state.recordSpend("lane-b", 2, 3, new Date().toISOString());
  state.recordSpend("lane-x", 99, 1000, "2026-07-09T00:00:00.000Z"); // before round start — excluded

  const facts = gatherRoundFacts(state, round, 30);
  assert.equal(facts.roundId, round.round_id);
  assert.equal(facts.prsOpened, 3);
  assert.equal(facts.prsMerged, 2);
  assert.equal(facts.issuesClosed, 2);
  assert.equal(facts.spentUsd, 7);
  assert.equal(facts.roundBudgetUsd, 30);
  assert.deepEqual(facts.needsHumanIssues, [6]); // deduped
  state.close();
});

test("createHarvestStub: marker present -> returns it unchanged, no facts gathered, no session run (idempotence)", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: HarvestDeps = { state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "harvesting", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createHarvestStub: no needs-human issues this round -> returns the round's marker, no session run", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: HarvestDeps = { state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createHarvestStub: a needs-human issue this round -> dispatches ONE harvest session with the rendered facts, records round-level spend", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "flaky test" });
  state.appendEvent("merged", { worker: "lane-b", issue: 2, pr: 8, headOid: "h" });
  const runner = new ScriptedRunner(doneResult("role-harvest-abc"));
  const deps: HarvestDeps = { state, cfg: mkCfg(), runner, now: () => new Date("2026-07-10T01:00:00.000Z") };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });

  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "harvest");
  assert.equal(call.model, "sonnet"); // roles.harvest default
  assert.equal(call.effort, "medium");
  assert.ok(call.prompt.includes(`Round: #${round.round_id}`));
  assert.ok(call.prompt.includes("PRs merged this round: 1"));
  assert.ok(call.prompt.includes("#42"));
  // #101 security-review pitfall: comments-only role — the WHOLE `gh issue edit` verb is
  // pattern-denied (labels included), on top of the base issues-only denies.
  assert.equal(call.disallowedTools, HARVEST_DISALLOWED_TOOLS);

  // Round-level spend recorded against the session name, issue=0 sentinel (no single issue).
  assert.equal(state.spentUsdSince("2026-07-10T00:00:00.000Z") >= 0.02, true);
  state.close();
});

test("HARVEST_DISALLOWED_TOOLS: keeps every base deny and adds the whole `gh issue edit` verb (no label/body mutation at all)", () => {
  assert.ok(HARVEST_DISALLOWED_TOOLS.startsWith(ROLE_DISALLOWED_TOOLS), "keeps every base deny");
  assert.ok(HARVEST_DISALLOWED_TOOLS.includes("Bash(gh issue edit*)"));
});

test("createHarvestStub: a failed session is retried once — non-done then done means exactly two sessions, no degradation event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const runner = new ScriptedRunner(failedResult("s1"), doneResult("s2"));
  const deps: HarvestDeps = { state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 2); // exactly one retry
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]), []);
  state.close();
});

test("createHarvestStub: two failed sessions degrade VISIBLY but never wedge the round — marker still set, harvest-degraded event appended", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const runner = new ScriptedRunner(failedResult("s1"), failedResult("s2"));
  const deps: HarvestDeps = { state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id)); // the phase still closes — run termination is never blocked
  assert.equal(runner.calls.length, 2); // exactly two attempts, never more
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "failed", session: "s2", attempts: 2 });
  state.close();
});

test("createHarvestStub: roles.harvest.promptFile override is honored (the #74 promptFile pattern)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-harvest-"));
  try {
    const promptPath = join(dir, "custom-harvest.md");
    writeFileSync(promptPath, "custom harvest prompt for round {{round.id}}, needs-human: {{round.needsHumanList}}");
    const state = new State(":memory:");
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 9, pr: 1, reason: "x" });
    const runner = new ScriptedRunner(doneResult("s1"));
    const cfg = mkCfg({ roles: { harvest: { promptFile: promptPath } } });
    const deps: HarvestDeps = { state, cfg, runner };
    const stub = createHarvestStub(deps);
    await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
    assert.equal(runner.calls[0]!.prompt, `custom harvest prompt for round ${round.round_id}, needs-human: #9`);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Integration: wired as round.ts's real `harvesting` peripheral ──────────────────────────

class MinimalForge implements IForge {
  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true }; }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(): Promise<void> {}
  async getIssueBody(): Promise<string> { return ""; }
  async getPRReviewData(): Promise<PRReviewData> {
    return { headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false, labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0 };
  }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return []; }
  async getIssueLabels(): Promise<string[]> { return []; }
  async getIssueComments() { return []; }
}

class MinimalSupervisor implements Supervisor {
  async probe(): Promise<LaneProbe> { return { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false }; }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> { return { name: `lane-${issue.number}`, sessionId: "s" }; }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> { return { worktreePath: null, worktreeRetained: false }; }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } { return { worktreePath: null, worktreeRetained: false }; }
  requestHandoff(): boolean { return true; }
}

const baseIntegrationDeps = (state: State, peripherals: Partial<Record<PeripheralPhase, PeripheralStub>>): RoundDeps => ({
  forge: new MinimalForge(),
  state,
  supervisor: new MinimalSupervisor(),
  cfg: mkCfg(),
  tickIntervalSec: 1,
  sleep: async () => {},
  peripherals,
});

test("runRounds integration: the real harvest stub runs during a normal round close and persists a marker", async () => {
  const state = new State(":memory:");
  // Pre-seed a needs-human escalation so the stub actually dispatches a session (proving it
  // ran, not merely skipped for lack of anything to report).
  const runner = new ScriptedRunner(doneResult("role-harvest-int"));
  const harvestStub = createHarvestStub({ state, cfg: mkCfg(), runner });
  const deps = baseIntegrationDeps(state, { harvesting: harvestStub });
  // Signal a graceful stop mid-round (round.test.ts's pattern): the in-flight round still
  // finishes every phase — harvesting included — and only the NEXT round is withheld.
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  deps.onRoundPhase = (_roundId, phase) => {
    // Appended AFTER startRound (the round already exists once 'aligning' completes), so its
    // ts is guaranteed >= round.started_at — exactly what gatherRoundFacts' window requires.
    if (phase === "aligning") {
      state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 7, pr: 1, reason: "x" });
      stop();
    }
  };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.equal(runner.calls.length, 1); // the harvest session actually ran — on a GRACEFUL stop
  const round = state.getRound(1)!; // closed rounds are still readable by id
  assert.equal(round.phase, "closed");
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks harvesting entirely — the stub never runs, no marker, no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-harvest-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const runner = new ScriptedRunner(doneResult("role-harvest-int"));
    const harvestStub = createHarvestStub({ state, cfg: mkCfg(), runner });
    const deps = baseIntegrationDeps(state, { harvesting: harvestStub });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(runner.calls.length, 0); // harvest never dispatched a session
    assert.equal(result.rounds, 0); // the round never closed
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
