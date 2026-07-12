// round.ts tests (#86): the round-loop skeleton — phase-transition sequence, round-level stop
// conditions, final stop.* preemption mid-round, KILL_SWITCH vs graceful peripheral behavior,
// and crash-rerun idempotence. Mirrors driver.test.ts's fake-forge/fake-supervisor/`:memory:`-
// state style (no claude, no gh).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runRounds, noopPeripheralStub, RoundScopedForge,
  type RoundDeps, type PeripheralStub, type PeripheralPhase, type RoundStopHit,
} from "./round.js";
import type { Supervisor, LaneProbe, MergeGate } from "./conductor.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus, PRReviewData, CommitInfo } from "./forge.js";
import type { DriveOutcome } from "./merge-driver.js";

class FakeForge implements IForge {
  ready: Issue[] = [];
  milestoneOpenCounts: number[] = [0];
  milestoneQueries: string[] = [];
  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return this.ready; }
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
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async getPRDiff(): Promise<string> { return ""; }
  async getCommitsSince(): Promise<CommitInfo[]> { return []; }
  async branchExists(): Promise<boolean> { return false; }
  async countOpenIssuesInMilestone(milestone: string): Promise<number> {
    this.milestoneQueries.push(milestone);
    return this.milestoneOpenCounts.length > 1 ? this.milestoneOpenCounts.shift()! : this.milestoneOpenCounts[0]!;
  }
  milestoneTitles: string[] = [];
  async listMilestoneTitles(): Promise<string[]> { return this.milestoneTitles; }
  planReviewCandidates: Issue[] = [];
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  issueLabels: Record<number, string[]> = {};
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  async getIssueComments(issue: number) { return this.issueComments[issue] ?? []; }
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  openIssueNumbers: number[] = [];
  async createIssue(title: string, body: string): Promise<number> {
    this.createdIssues.push({ title, body });
    const n = this.nextIssueNumber++;
    this.openIssueNumbers.push(n);
    return n;
  }
  async listOpenIssueNumbers(): Promise<number[]> { return this.openIssueNumbers; }
  planTriageCandidates: Issue[] = [];
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return this.planTriageCandidates; }
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  dispatchedIssues: number[] = [];
  private n = 0;
  async probe(w: string): Promise<LaneProbe> {
    return this.probes[w] ?? { done: false, failed: false, handoff: false, hbAge: 10, wrapperAlive: 1, hasPr: false };
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    this.dispatchedIssues.push(issue.number);
    const name = `lane-${issue.number}-${++this.n}`;
    return { name, sessionId: `sess-${name}` };
  }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> {
    return { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } {
    return { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(): boolean { return true; }
}

/** A supervisor whose lanes complete IMMEDIATELY (done, no PR) unless a test explicitly
 *  overrides a probe — for tests about dispatch counts/order/filtering, not drain timing,
 *  where FakeSupervisor's normal "runs forever until told otherwise" default would hang the
 *  round loop's drain-until-idle step forever. */
class AutoCompleteSupervisor extends FakeSupervisor {
  override async probe(w: string): Promise<LaneProbe> {
    return this.probes[w] ?? { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
  }
}

class ScriptedMergeGate implements MergeGate {
  calls = 0;
  constructor(private readonly outcomes: DriveOutcome[]) {}
  async driveOne(pr: number): Promise<DriveOutcome> {
    const i = this.calls;
    this.calls++;
    return this.outcomes[Math.min(i, this.outcomes.length - 1)] ?? { kind: "queued", pr, reason: "default" };
  }
}

// #125: every pre-existing test in this file predates standby and exercises an otherwise-empty
// FakeForge (deliberately, to isolate whatever mechanic it's actually testing) — defaulting
// round.standby OFF here keeps every one of them opening its round immediately, exactly as
// before. The standby-specific tests below opt back in explicitly via `round: { standby: {...} }`
// (merged over this default, not replaced by it — same shallow-merge-of-`round` shape as the
// rest of this helper).
const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" },
    ...over,
    round: { standby: { enabled: false }, ...(over.round as Record<string, unknown> | undefined) },
  });

function mkSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

/** A PeripheralStub that logs every invocation (roundId, phase, marker seen) and returns a
 *  deterministic marker per phase — the phase-sequence + crash-rerun tests' observation point. */
function loggingStub(log: Array<{ phase: PeripheralPhase; marker: string | null }>, tag: string): PeripheralStub {
  return {
    async run(ctx) {
      log.push({ phase: ctx.phase, marker: ctx.marker });
      return { marker: `${tag}-done` };
    },
  };
}

const allPeripherals = (log: Array<{ phase: PeripheralPhase; marker: string | null }>) => ({
  aligning: loggingStub(log, "aligning"),
  architecting: loggingStub(log, "architecting"),
  plan_review: loggingStub(log, "plan_review"),
  harvesting: loggingStub(log, "harvesting"),
  retro: loggingStub(log, "retro"),
});

const baseDeps = (over: Partial<RoundDeps> = {}): RoundDeps => ({
  forge: new FakeForge(),
  state: new State(":memory:"),
  supervisor: new FakeSupervisor(),
  cfg: mkCfg(),
  tickIntervalSec: 5,
  registerSignals: () => () => {},
  ...over,
});

/** Bounded safety net: stop the loop after `maxRounds` peripheral-phase invocations so a
 *  round.ts bug (never closing, never stopping) fails the test instead of hanging the suite. */
function boundedStopOnPhase(deps: RoundDeps, maxPhaseCalls: number): () => void {
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  let calls = 0;
  const prev = deps.onRoundPhase;
  deps.onRoundPhase = (roundId, phase) => {
    prev?.(roundId, phase);
    calls++;
    if (calls >= maxPhaseCalls) stop();
  };
  return () => stop();
}

// ── Phase-transition sequence ────────────────────────────────────────────────────────────────

test("runRounds: a round with nothing to dispatch visits every phase in order exactly once", async () => {
  const { sleep } = mkSleepSpy();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({ sleep, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 5); // aligning, architecting, plan_review, harvesting, retro
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds: a fresh phase always gets a null marker (first attempt)", async () => {
  const { sleep } = mkSleepSpy();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({ sleep, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRounds(deps);
  stopSafety();
  assert.ok(log.every((l) => l.marker === null));
  deps.state.close();
});

// ── round-level stop conditions ─────────────────────────────────────────────────────────────

test("runRounds roundDispatchCap: only the cap's worth dispatch this round; the remainder is picked up by a LATER round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [
    { number: 1, title: "a", labels: ["prio:3-feature"] },
    { number: 2, title: "b", labels: ["prio:3-feature"] },
    { number: 3, title: "c", labels: ["prio:3-feature"] },
  ];
  // Every dispatched lane completes immediately (no PR) — the drain loop reaches idle right
  // away; the test is about the CAP, not about drain timing.
  const sup = new AutoCompleteSupervisor();
  const hits: RoundStopHit[] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 2 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // two rounds' worth of peripheral phases
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(sup.dispatchedIssues.length >= 2, true, "at least the capped batch dispatched");
  assert.deepEqual(sup.dispatchedIssues.slice(0, 2), [1, 2]); // exactly 2 in round 1, priority/number order
  assert.ok(hits.some((h) => h.name === "roundDispatchCap" && h.detail === "dispatched 2"));
  assert.ok(result.rounds >= 1);
  // Issue #3 was never touched by round 1 — proves the cap actually bounded the batch, not
  // just that lanes.max/Ready ran out on its own (lanes.max=3 has room for a 3rd dispatch).
  deps.state.close();
});

test("runRounds round.milestone: filters dispatch candidates to the configured milestone", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [
    { number: 1, title: "in milestone", labels: ["prio:3-feature"], milestone: "M4" },
    { number: 2, title: "not in milestone", labels: ["prio:3-feature"] },
  ];
  forge.milestoneOpenCounts = [1]; // the milestone still has open issues — dispatch proceeds
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 3 }, round: { milestone: "M4" } }),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRounds(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1]); // #2 (no milestone) never dispatched
  deps.state.close();
});

// ── #109 gate② P1: idle throttle between rounds ─────────────────────────────────────────────

test("runRounds idle throttle: an idle round (nothing dispatched) waits tickIntervalSec before the next round opens — peripherals never spin back-to-back on an empty backlog", async () => {
  const events: string[] = [];
  const sleep = async (ms: number): Promise<void> => { events.push(`sleep:${ms}`); };
  const deps = baseDeps({ sleep, tickIntervalSec: 7 });
  deps.onRoundPhase = (roundId, phase) => events.push(`r${roundId}:${phase}`);
  const stopSafety = boundedStopOnPhase(deps, 10); // two idle rounds' worth of phases
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2);
  const r1retro = events.indexOf("r1:retro");
  const r2aligning = events.indexOf("r2:aligning");
  assert.ok(r1retro >= 0 && r2aligning > r1retro, `expected both rounds' phases in ${JSON.stringify(events)}`);
  // Exactly ONE throttle wait — at the tick cadence — sits between round 1 closing and round 2
  // opening (an idle round's drain loop breaks before its first wait, so this is the only sleep).
  assert.deepEqual(events.slice(r1retro + 1, r2aligning), ["sleep:7000"]);
  deps.state.close();
});

test("runRounds idle throttle: a signal during the idle wait exits promptly — the wait never delays shutdown, and no new round opens", async () => {
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  // A sleep that NEVER resolves on its own — the signal (fired the moment the wait starts) must
  // be what ends it, proving the throttle wait is signal-abortable rather than a shutdown delay.
  const sleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    stop();
    return new Promise<void>(() => {});
  };
  const deps = baseDeps({ sleep });
  // Safety net so a regression (throttle never firing -> idle rounds spinning forever) fails
  // the rounds===1 assertion below instead of hanging the suite.
  const stopSafety = boundedStopOnPhase(deps, 12);
  const inner = deps.registerSignals!;
  deps.registerSignals = (requestStop) => { stop = requestStop; return inner(requestStop); };
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.deepEqual(sleepCalls, [5000]); // baseDeps tickIntervalSec=5 — the one idle wait, aborted
  assert.equal(deps.state.getRound(2), undefined, "no second round ever opened");
  deps.state.close();
});

test("runRounds idle throttle: a round that dispatched work is NOT additionally throttled — its drain loop already paced it on the tick cadence", async () => {
  const events: string[] = [];
  const sleep = async (ms: number): Promise<void> => { events.push(`sleep:${ms}`); };
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "a", labels: ["prio:3-feature"] }];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep });
  deps.onRoundPhase = (roundId, phase) => events.push(`r${roundId}:${phase}`);
  const stopSafety = boundedStopOnPhase(deps, 6); // through round 2's first phase
  await runRounds(deps);
  stopSafety();
  const r1retro = events.indexOf("r1:retro");
  const r2aligning = events.indexOf("r2:aligning");
  assert.ok(r1retro >= 0 && r2aligning > r1retro, `expected both rounds' phases in ${JSON.stringify(events)}`);
  // The dispatched lane's cadence waits happened INSIDE executing (before r1:harvesting)…
  assert.ok(events.slice(0, r1retro).some((e) => e.startsWith("sleep:")), "drain loop did pace the dispatched lane");
  // …and NO extra wait separates round 1's close from round 2 opening.
  assert.deepEqual(events.slice(r1retro + 1, r2aligning), []);
  deps.state.close();
});

test("runRounds round.milestone: 0 open issues left skips the batch dispatch entirely and still closes the round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"], milestone: "M4" }];
  forge.milestoneOpenCounts = [0];
  const sup = new FakeSupervisor();
  const hits: RoundStopHit[] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ round: { milestone: "M4" } }),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, []); // never dispatched despite a matching Ready issue
  assert.ok(hits.some((h) => h.name === "milestone" && h.detail === "0 open issues left"));
  assert.equal(result.rounds, 1); // the round still ran its full phase sequence and closed
  deps.state.close();
});

test("runRounds cost.roundBudgetUsd: recorded once this round's cumulative worker spend crosses the cap; harvest/retro still run", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  // No PR (hasPr: false) -> reclaimTerminalLane's ESCALATE_NOPR path, which still records spend
  // regardless of drive/merge activity (#14 cost tracking is independent of driving state).
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 999 };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const hits: RoundStopHit[] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    // roundDispatchCap set well above 1 dispatch so it never fires first and masks the budget
    // hit this test is actually isolating.
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 }, cost: { roundBudgetUsd: 5 } }),
    peripherals: allPeripherals(log),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  assert.ok(hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $999.00"));
  // Harvest + retro still ran (never skipped by a round-level cost condition — only KILL_SWITCH
  // skips peripherals).
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1);
  deps.state.close();
});

// ── #95 follow-ups ───────────────────────────────────────────────────────────────────────────

test("runRounds #95: every round-stop hit is persisted via appendEvent, not just handed to the observability hook", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 999 };
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 }, cost: { roundBudgetUsd: 5 } }),
  });
  const logged: Array<[string, unknown]> = [];
  const realAppend = deps.state.appendEvent.bind(deps.state);
  deps.state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRounds(deps);
  stopSafety();
  const hit = logged.find(([kind]) => kind === "round-stop");
  assert.ok(hit, "a round-stop event was durably appended");
  assert.deepEqual(hit![1], { round_id: 1, name: "roundBudgetUsd", detail: "spent $999.00" });
  deps.state.close();
});

test("runRounds #95: a resumed-into-executing drain evaluates cost.roundBudgetUsd against currently-active workers (never silently disabled)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    // Simulate a crash mid-`executing`: the round is already there, and a lane from the
    // pre-crash dispatch is still on record as `running` with spend already ledgered above the
    // round budget — exactly the case #95's review flagged as invisible (dispatchedNames was
    // always [] on a resumed drain, so this could never fire).
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    state.upsertWorker({
      name: "lane-99", issue: 99, session_id: "s99", state: "running",
      started_at: "2026-07-09T00:00:30.000Z", ended_at: null,
    });
    state.recordSpend("lane-99", 99, 50, "2026-07-09T00:00:45.000Z");

    const forge = new FakeForge();
    forge.ready = [];
    const sup = new FakeSupervisor();
    // The resumed drain's first probe finds the lane already finished (no PR) -> tick()
    // reclaims it out of `running`, so the drain loop reaches idle after one iteration.
    sup.probes["lane-99"] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
    const hits: RoundStopHit[] = [];
    const deps = baseDeps({
      forge, supervisor: sup, state, sleep,
      cfg: mkCfg({ cost: { roundBudgetUsd: 5 } }), // already-banked $50 >> $5 budget
      onRoundStop: (_id, hit) => hits.push(hit),
    });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRounds(deps);
    stopSafety();
    assert.ok(
      hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $50.00"),
      "the resumed drain detected the already-banked spend against the currently-active lane",
    );
    assert.equal(result.rounds, 1);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── final stop.* preemption mid-round ───────────────────────────────────────────────────────

test("runRounds stop.afterIssuesMerged: a round already open finishes harvest+retro before the loop refuses to open a NEW round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  const gate = new ScriptedMergeGate([{ kind: "merged", pr: 1, headOid: "H" }]);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep, mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterIssuesMerged: 1 },
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterIssuesMerged", threshold: 1, detail: "merged 1" });
  // The round in flight when the condition fired still ran harvest + retro (graceful, not a kill).
  assert.deepEqual(log.map((l) => l.phase).slice(-2), ["harvesting", "retro"]);
  assert.equal(result.rounds, 1); // exactly the one round — no NEW round opened after
  deps.state.close();
});

test("runRounds stop.onMilestoneComplete: checked at round boundaries (never mid-round), preempts opening a NEW round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // isolates the milestone check from dispatch activity
  forge.milestoneOpenCounts = [1, 0]; // round 1: not complete yet; round 2's preemptive check: complete
  const deps = baseDeps({ forge, sleep, stop: { onMilestoneComplete: "M4" } });
  const stopSafety = boundedStopOnPhase(deps, 15);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  assert.equal(result.rounds, 1); // round 1 fully closed; round 2 never opened
  deps.state.close();
});

// ── KILL_SWITCH vs graceful peripheral behavior ─────────────────────────────────────────────

test("runRounds KILL_SWITCH: blocks the very next peripheral phase — harvest/retro are NEVER invoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const forge = new FakeForge();
    forge.ready = [];
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    // Flip the kill switch BEFORE the round loop even starts aligning — proves the FIRST
    // peripheral phase it would otherwise run is blocked, not just later ones.
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const deps = baseDeps({ forge, state, sleep, peripherals: allPeripherals(log) });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.deepEqual(log, []); // no peripheral ever ran
    assert.equal(result.rounds, 0); // the round never closed
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds: a graceful signal (not KILL_SWITCH) still lets the in-flight round run harvest + retro before stopping", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [];
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({ forge, sleep, peripherals: allPeripherals(log) });
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  // Signal arrives mid-round (right after 'aligning' runs) — the round must still finish
  // architecting/plan_review/harvesting/retro before the loop actually stops.
  deps.onRoundPhase = (_id, phase) => { if (phase === "aligning") stop(); };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1); // the round closed cleanly; only the NEXT round was withheld
  deps.state.close();
});

// ── crash-rerun idempotence ──────────────────────────────────────────────────────────────────

test("runRounds crash-rerun: an in_progress round resumes AT its persisted phase (never re-running an earlier one), handing the stub its prior marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    // Simulate a crash: aligning/architecting already completed (never re-run); plan_review's
    // stub externalized something (recorded marker "m1") but the engine died before the round
    // advanced past plan_review.
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "plan_review", "2026-07-09T00:01:00.000Z");
    state.setRoundMarker(round.round_id, "m1", "2026-07-09T00:01:30.000Z");
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    forge.ready = [];
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const deps = baseDeps({ forge, state: state2, sleep, peripherals: allPeripherals(log) });
    const stopSafety = boundedStopOnPhase(deps, 3); // plan_review, harvesting, retro
    const result = await runRounds(deps);
    stopSafety();
    // aligning/architecting are NOT re-run — resumed straight at plan_review.
    assert.deepEqual(log.map((l) => l.phase), ["plan_review", "harvesting", "retro"]);
    // plan_review's stub saw the marker from the crashed attempt, not null — proof it wasn't
    // treated as a fresh first attempt.
    assert.equal(log[0]?.marker, "m1");
    assert.equal(result.rounds, 1);
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds crash-rerun: resuming directly at 'executing' does NOT re-dispatch a fresh batch — it only drains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    // A Ready issue exists, but resuming into `executing` must NOT dispatch it fresh (that
    // would double-dispatch on top of whatever the crash left running) — it should just drain
    // (nothing running -> immediately idle) and proceed to harvest/retro.
    forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
    const sup = new FakeSupervisor();
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const deps = baseDeps({ forge, supervisor: sup, state: state2, sleep, peripherals: allPeripherals(log) });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRounds(deps);
    stopSafety();
    assert.deepEqual(sup.dispatchedIssues, []); // never dispatched by the resumed pass
    assert.deepEqual(log.map((l) => l.phase), ["harvesting", "retro"]);
    assert.equal(result.rounds, 1);
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── RoundScopedForge (unit-level, direct) ───────────────────────────────────────────────────

test("RoundScopedForge: filters getReadyIssues() by milestone; passthrough when unset", async () => {
  const forge = new FakeForge();
  forge.ready = [
    { number: 1, title: "a", labels: [], milestone: "M4" },
    { number: 2, title: "b", labels: [] },
  ];
  const scoped = new RoundScopedForge(forge, "M4");
  assert.deepEqual((await scoped.getReadyIssues()).map((i) => i.number), [1]);
  const unscoped = new RoundScopedForge(forge, undefined);
  assert.deepEqual((await unscoped.getReadyIssues()).map((i) => i.number), [1, 2]);
});

test("RoundScopedForge: updateIssueBody passes through unchanged (#110 PR0 — explicit passthrough, no milestone scoping)", async () => {
  const forge = new FakeForge();
  const scoped = new RoundScopedForge(forge, "M4");
  await scoped.updateIssueBody(7, "revised body");
  assert.deepEqual(forge.updateIssueBodyCalls, [[7, "revised body"]]);
});

test("noopPeripheralStub: echoes the incoming marker, or 'noop' on a first attempt", async () => {
  assert.deepEqual(await noopPeripheralStub.run({ roundId: 1, phase: "aligning", marker: null }), { marker: "noop" });
  assert.deepEqual(await noopPeripheralStub.run({ roundId: 1, phase: "aligning", marker: "prior" }), { marker: "prior" });
});

// ── #125: standby (pre-round probe + exponential backoff) ──────────────────────────────────
//
// mkCfg defaults standby OFF (see its own comment above) — every test below opts back in
// explicitly via `round: { standby: { enabled: true, ... } }`.

/** Spy on state.appendEvent, same pattern as the #95 "every round-stop hit is persisted" test
 *  above — returns the recorded (kind, payload) pairs in order. */
function spyOnEvents(state: State): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    events.push([kind, payload]);
    realAppend(kind, payload);
  };
  return events;
}

test("runRounds standby: an empty board withholds opening ANY round — zero peripheral sessions ever run, and standby-wait events show the backoff doubling", async () => {
  const forge = new FakeForge(); // ready=[] and planReviewCandidates=[] by default — probe never hits
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Safety net so a regression (standby never firing / never stopping) fails these assertions
    // instead of hanging the suite — same "bounded stop, not an infinite loop" stance as
    // boundedStopOnPhase uses for the phase-sequence tests above.
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 0);
  assert.deepEqual(log, [], "no peripheral phase ever ran — the round never opened");
  assert.deepEqual(sleepCalls, [5000, 10000, 20000, 40000]); // tickIntervalSec=5 * 2^n, doubling
  const waits = events.filter(([kind]) => kind === "standby-wait").map(([, payload]) => payload);
  assert.deepEqual(waits, [
    { attempt: 0, waitSec: 5 }, { attempt: 1, waitSec: 10 }, { attempt: 2, waitSec: 20 }, { attempt: 3, waitSec: 40 },
  ]);
  state.close();
});

test("runRounds standby: SIGINT during a standby wait exits promptly — the wait never delays shutdown, and no round ever opens", async () => {
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  // A sleep that NEVER resolves on its own — the signal (fired the moment the wait starts) must
  // be what ends it, same shape as the #109 idle-throttle sigint test above.
  const sleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    stop();
    return new Promise<void>(() => {});
  };
  const forge = new FakeForge(); // empty board — standby engages on the very first probe
  const deps = baseDeps({
    forge, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 0);
  assert.deepEqual(sleepCalls, [5000]); // exactly the FIRST backoff step, aborted immediately
  assert.equal(deps.state.getRound(1), undefined, "no round was ever opened");
  deps.state.close();
});

test("runRounds standby: the backoff wait is capped at round.standby.backoffCapSec — it never grows past it", async () => {
  const forge = new FakeForge();
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 5) stop();
  };
  const deps = baseDeps({
    forge, sleep, tickIntervalSec: 10,
    cfg: mkCfg({ round: { standby: { enabled: true, backoffCapSec: 25 } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  // 10, 20, then capped at 25 forever (uncapped would be 10, 20, 40, 80, 160).
  assert.deepEqual(sleepCalls, [10000, 20000, 25000, 25000, 25000]);
  deps.state.close();
});

test("runRounds standby: a Ready issue appearing mid-backoff is caught by the NEXT probe — standby exits and the round opens, no extra wait beyond that one step", async () => {
  const forge = new FakeForge();
  const sup = new AutoCompleteSupervisor();
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const sleep = async (): Promise<void> => {
    // The issue appears during the FIRST standby wait — the very next probe (right after this
    // resolves) must see it and exit standby immediately, never waiting a second time.
    forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  };
  const deps = baseDeps({
    forge, supervisor: sup, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 5); // one round's worth of phases
  const result = await runRounds(deps);
  stopSafety();
  const waits = events.filter(([kind]) => kind === "standby-wait");
  assert.equal(waits.length, 1, "exactly one backoff step before the new issue was noticed");
  const exit = events.find(([kind]) => kind === "standby-exit");
  assert.ok(exit, "a standby-exit event was recorded");
  assert.deepEqual(exit![1], { attempts: 1 });
  assert.deepEqual(sup.dispatchedIssues, [1], "the newly-Ready issue got dispatched once standby exited");
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds standby: KILL_SWITCH bypasses the probe entirely — a round still opens & blocks at aligning, exactly like non-standby behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge(); // empty board — standby would otherwise engage forever
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const { sleep } = mkSleepSpy();
    const deps = baseDeps({
      forge, state, sleep,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.deepEqual(log, []); // aligning itself never ran — blocked before the stub
    assert.equal(result.rounds, 0);
    assert.ok(state.getRound(1), "the round loop still opens a round before checking the kill switch");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds standby: round.milestone open issues count as work even with Ready/plan-review both empty — decomposing them is the PO's job, not a standby signal", async () => {
  const forge = new FakeForge();
  forge.ready = []; // isolates the milestone-goals signal from Ready/plan-review
  forge.milestoneOpenCounts = [3]; // the milestone still has undecomposed open issues
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({
    forge, sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1, "the round opened immediately — never entered standby");
  assert.ok(forge.milestoneQueries.includes("M4"), "the probe actually checked the milestone");
  deps.state.close();
});

test("runRounds standby: a throwing probe fails OPEN — tick-error appended, the round still opens, the run never crashes (gate② on PR #150)", async () => {
  const forge = new FakeForge();
  // Every probe read throws — the long-idle mode where standby runs for hours makes a transient
  // GitHub failure (rate limit, network blip) near-certain eventually; it must read as "has
  // work" (round opens, pre-#125 behavior resumes), never as a crash or an indefinite wait.
  forge.getReadyIssues = async () => { throw new Error("rate limited"); };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleepCalls.push(ms); };
  const deps = baseDeps({
    forge, state, sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 5); // one round's worth of phases
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1, "the round opened despite the probe failure — fail-open");
  assert.ok(result.tickErrors >= 1, "the probe failure was counted as a tick error");
  const err = events.find(([kind, payload]) =>
    kind === "tick-error" && String((payload as { error: string }).error).includes("standby probe failed"));
  assert.ok(err, "a tick-error event naming the standby probe was durably appended");
  // No wait of any kind happened before the round opened: the failed probe read as "has work"
  // immediately (and the graceful stop mid-round means no post-close idle throttle either).
  assert.deepEqual(sleepCalls, []);
  deps.state.close();
});

test("runRounds standby: a truly exhausted round.milestone (0 open issues) contributes no work signal — standby engages same as the unscoped empty-board case", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneOpenCounts = [0]; // the milestone is fully drained — nothing left to decompose
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    stop();
  };
  const deps = baseDeps({
    forge, sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 0, "standby withheld the round — the milestone had nothing left");
  assert.deepEqual(sleepCalls, [5000]); // baseDeps tickIntervalSec=5 — the first backoff step
  deps.state.close();
});
