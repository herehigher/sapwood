// retro.test.ts (#91): the `retro` peripheral's self-evolution role. Fakes the underlying role
// session (RoleRunner) directly — same "fake the collaborator, not the CLI" split as
// plan-review.test.ts/harvest.test.ts. Central acceptance criterion: retro proposals appear as
// branches/PRs only — no direct main/docs writes — asserted against the role's OWN write-scope
// constants (RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS) and against how createRetroStub wires
// them into every session it dispatches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetroStub, gatherRetroFacts, retroMarker, defaultRetroPromptPath,
  RETRO_ALLOWED_TOOLS, RETRO_DISALLOWED_TOOLS, type RetroDeps,
} from "./retro.js";
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { runRounds, type RoundDeps, type PeripheralPhase, type PeripheralStub } from "./round.js";
import type { Supervisor, LaneProbe } from "./conductor.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";

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
  outcome: "done", costUsd: 0.03, modelUsage: [], exitCode: 0, name,
});
const timeoutResult = (name: string): RoleSessionResult => ({
  outcome: "timeout", costUsd: 0.03, modelUsage: [], exitCode: null, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

// ── Write-scope: "proposals appear as branches/PRs only" ────────────────────────────────────

test("RETRO_ALLOWED_TOOLS: grants git + gh pr create (proposal path) — never a merge/review/issue-mutation capability", () => {
  assert.ok(RETRO_ALLOWED_TOOLS.includes("Bash(gh pr create*)"), "can open a PR");
  assert.ok(RETRO_ALLOWED_TOOLS.includes("Bash(git commit*)") && RETRO_ALLOWED_TOOLS.includes("Bash(git push*)"), "can commit + push a branch");
  for (const forbidden of ["gh pr merge", "gh pr review", "gh pr ready", "gh issue edit", "gh issue comment", "gh api"]) {
    assert.ok(!RETRO_ALLOWED_TOOLS.includes(forbidden), `allowed tools must not grant ${forbidden}`);
  }
});

test("RETRO_DISALLOWED_TOOLS: explicitly denies merge/review/ready, issue mutation, raw gh api, and a direct push to main/master", () => {
  for (const denied of ["gh pr merge", "gh pr review", "gh pr ready", "gh issue edit", "gh issue comment", "gh api"]) {
    assert.ok(RETRO_DISALLOWED_TOOLS.includes(denied), `disallowed tools must deny ${denied}`);
  }
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("git push*main*"));
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("git push*master*"));
  // #101 security-review rule: every widened gh WRITE allow carries the matching --body-file
  // deny (gh pr create is retro's only gh write verb).
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("Bash(gh pr create *--body-file*)"));
});

test("createRetroStub: every dispatched session carries RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS — never the base issues-only scope", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("role-retro-1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0]!;
  assert.equal(call.allowedTools, RETRO_ALLOWED_TOOLS);
  assert.equal(call.disallowedTools, RETRO_DISALLOWED_TOOLS);
  state.close();
});

// ── Idempotence + fact-gathering ─────────────────────────────────────────────────────────────

test("createRetroStub: marker present -> returns it unchanged, no session run (idempotence)", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: 3, phase: "retro", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("gatherRetroFacts: counts handoffs, drive-needs-human escalations, and ceiling escalations since round start only", async () => {
  const state = new State(":memory:");
  // appendEvent stamps the REAL clock, so the excluded "before round start" event must land
  // strictly before a real-clock started_at (the small sleep guarantees a later millisecond).
  state.appendEvent("handoff", { worker: "lane-x", issue: 99 }); // before round start
  await new Promise((r) => setTimeout(r, 5));
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  state.appendEvent("handoff", { worker: "lane-b", issue: 2 });
  state.appendEvent("drive-needs-human", { worker: "lane-c", issue: 3, pr: 5, reason: "flaky" });
  state.appendEvent("ceiling-escalated", { worker: "lane-d", issue: 4, reasons: ["dailyBudgetUsd"] });
  const facts = gatherRetroFacts(state, round);
  assert.equal(facts.roundId, round.round_id);
  assert.equal(facts.handoffs, 2); // the pre-round-start handoff is excluded
  assert.equal(facts.needsHumanEscalations, 1);
  assert.equal(facts.ceilingEscalations, 1);
  state.close();
});

test("createRetroStub: renders the round facts into the prompt and dispatches exactly one session per round, records round-level spend", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  state.appendEvent("drive-needs-human", { worker: "lane-b", issue: 2, pr: 5, reason: "flaky" });
  const runner = new ScriptedRunner(doneResult("role-retro-2"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, now: () => new Date("2026-07-10T02:00:00.000Z") };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "retro");
  assert.equal(call.model, "sonnet"); // roles.retro default
  assert.ok(call.prompt.includes(`Round: #${round.round_id}`));
  assert.ok(call.prompt.includes("mid-task): 1")); // handoffs var substituted into its template line
  assert.ok(call.prompt.includes("Gate② rejections this round"));
  assert.equal(state.spentUsdSince("2026-07-10T00:00:00.000Z") >= 0.03, true);
  state.close();
});

test("createRetroStub: a failed session is retried once — non-done then done means exactly two sessions, no degradation event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(timeoutResult("s1"), doneResult("s2"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 2); // exactly one retry
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded"]), []);
  state.close();
});

test("createRetroStub: two failed sessions degrade VISIBLY but never wedge the round — marker still set, retro-degraded event appended", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(timeoutResult("s1"), timeoutResult("s2"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id)); // the phase still closes — never wedges the run
  assert.equal(runner.calls.length, 2); // exactly two attempts, never more
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "timeout", session: "s2", attempts: 2 });
  state.close();
});

// ── #104: roles.retro.everyNRounds cadence ──────────────────────────────────────────────────

test("createRetroStub: everyNRounds > 1 skips a round whose id isn't a multiple of N — marker still set, no session run", async () => {
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-10T00:00:00.000Z"); // round_id 1
  const round2 = state.startRound("2026-07-10T01:00:00.000Z"); // round_id 2
  const runner = new ScriptedRunner(doneResult("s1"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { state, cfg, runner };
  const stub = createRetroStub(deps);

  const r1 = await stub.run({ roundId: round1.round_id, phase: "retro", marker: null });
  assert.equal(r1.marker, retroMarker(round1.round_id));
  assert.equal(runner.calls.length, 0, "round 1 is not a multiple of 3 — skipped");

  const r2 = await stub.run({ roundId: round2.round_id, phase: "retro", marker: null });
  assert.equal(r2.marker, retroMarker(round2.round_id));
  assert.equal(runner.calls.length, 0, "round 2 is not a multiple of 3 — skipped");
  state.close();
});

test("createRetroStub: everyNRounds > 1 runs on a round whose id IS a multiple of N", async () => {
  const state = new State(":memory:");
  for (let i = 0; i < 2; i++) state.startRound(`2026-07-10T0${i}:00:00.000Z`); // round_id 1, 2
  const round3 = state.startRound("2026-07-10T03:00:00.000Z"); // round_id 3
  const runner = new ScriptedRunner(doneResult("role-retro-3"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { state, cfg, runner };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round3.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round3.round_id));
  assert.equal(runner.calls.length, 1, "round 3 is a multiple of 3 — retro runs");
  state.close();
});

test("createRetroStub: everyNRounds default (1) runs every round, unchanged from #91 behavior", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  state.close();
});

// ── #104: gate⓪ escalations feed retro's needsHumanEscalations count too ───────────────────

test("gatherRetroFacts: plan-review-escalated events (gate⓪) are counted alongside drive-needs-human (gate②) in needsHumanEscalations", async () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 1, pr: 5, reason: "flaky" });
  state.appendEvent("plan-review-escalated", { round_id: round.round_id, issue: 2, reason: "self-heal exhausted" });
  const facts = gatherRetroFacts(state, round);
  assert.equal(facts.needsHumanEscalations, 2);
  state.close();
});

test("createRetroStub: roles.retro.promptFile override is honored (the #74 promptFile pattern)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-"));
  try {
    const promptPath = join(dir, "custom-retro.md");
    writeFileSync(promptPath, "custom retro prompt: round {{round.id}} handoffs={{round.handoffs}}");
    const state = new State(":memory:");
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    const runner = new ScriptedRunner(doneResult("s1"));
    const cfg = mkCfg({ roles: { retro: { promptFile: promptPath } } });
    const deps: RetroDeps = { state, cfg, runner };
    const stub = createRetroStub(deps);
    await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
    assert.equal(runner.calls[0]!.prompt, `custom retro prompt: round ${round.round_id} handoffs=0`);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultRetroPromptPath: resolves to the shipped prompts/retro.md, which exists and carries the mandatory review-findings-philosophy amendment", () => {
  const p = defaultRetroPromptPath();
  assert.ok(existsSync(p), `expected shipped prompt at ${p}`);
  const body = readFileSync(p, "utf8");
  // #91 issue comment (CTO + user, 2026-07-10): both points must be in the shipped prompt.
  assert.ok(/recurring/i.test(body) && /design signal/i.test(body), "must name recurring findings as a design signal");
  assert.ok(/not a fix queue|point.fix/i.test(body), "must reject a point-fix-queue response to recurring findings");
  assert.ok(/inputs to judge|evidence to weigh/i.test(body), "must treat findings as evidence to judge");
  assert.ok(/accepted/i.test(body) && /rejected/i.test(body), "must require an accepted/rejected classification with reasons");
  for (const v of ["{{round.id}}", "{{round.handoffs}}", "{{round.needsHumanEscalations}}", "{{round.ceilingEscalations}}"]) {
    assert.ok(body.includes(v), `retro.md should reference ${v}`);
  }
});

test("prompts/retro.md never instructs a direct merge/approve — the PR-only path is stated as a non-negotiable", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  assert.ok(body.includes("You never:"));
  assert.ok(/merge (your own|.{0,20}any)/i.test(body), "must explicitly forbid self-merge");
  assert.ok(/approve or submit a PR review/i.test(body));
  assert.ok(/exclusively as a pull request/i.test(body));
});

// ── Integration: wired as round.ts's real `retro` peripheral ────────────────────────────────

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
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> { this.updateIssueBodyCalls.push([issue, body]); }
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

test("runRounds integration: the real retro stub runs during a normal round close and persists a marker", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("role-retro-int"));
  const retroStub = createRetroStub({ state, cfg: mkCfg(), runner });
  const deps = baseIntegrationDeps(state, { retro: retroStub });
  // Graceful stop mid-round (round.test.ts's pattern): the in-flight round still finishes
  // every phase — retro included — and only the NEXT round is withheld.
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  deps.onRoundPhase = (_roundId, phase) => { if (phase === "aligning") stop(); };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.equal(runner.calls.length, 1); // retro ran this round — on a GRACEFUL stop
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed");
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks retro entirely — the stub never runs, no marker, no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const runner = new ScriptedRunner(doneResult("role-retro-int"));
    const retroStub = createRetroStub({ state, cfg: mkCfg(), runner });
    const deps = baseIntegrationDeps(state, { retro: retroStub });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(runner.calls.length, 0);
    assert.equal(result.rounds, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
