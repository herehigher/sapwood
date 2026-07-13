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
import { RoundArtifactSchema } from "./round-artifact.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus, PRReviewData, CommitInfo } from "./forge.js";
import type { DriveOutcome } from "./merge-driver.js";

class FakeForge implements IForge {
  ready: Issue[] = [];
  milestoneOpenCounts: number[] = [0];
  milestoneQueries: string[] = [];
  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return this.ready; }
  // #124: mirrors real GitHub behavior — a claimed issue leaves the Ready column, so it must
  // not still be `ready` for a LATER tick's dispatch phase to see (once its lane is reclaimed,
  // tick()'s in-flight dedup no longer protects it). Multi-wave rounds now call the dispatch
  // phase more than once per round, so this needs to actually mutate state — a no-op claim was
  // harmless under the old one-batch-per-round model but would let a second wave re-dispatch
  // the exact same issue number here.
  async claimIssue(issue: number): Promise<void> { this.ready = this.ready.filter((i) => i.number !== issue); }
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

test("runRounds #123: a closed round leaves a persisted, schema-valid round artifact with endedAt set", async () => {
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ sleep });
  const stopSafety = boundedStopOnPhase(deps, 5); // exactly round 1's five peripheral phases
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 1);
  const row = deps.state.getRoundArtifact(1);
  assert.ok(row, "the close path persisted a round_artifacts row");
  const artifact = RoundArtifactSchema.parse(JSON.parse(row!.json));
  assert.equal(artifact.roundId, 1);
  assert.ok(artifact.endedAt != null, "the FINAL artifact records the close timestamp");
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

test("runRounds stop.afterSpendUsd: a round already open finishes harvest+retro before the loop refuses to open a NEW round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  // done, no PR — recordSpend fires regardless of merge-gate activity, so no ScriptedMergeGate.
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 25 };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterSpendUsd: 20 },
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 20, detail: "spent $25.00" });
  assert.deepEqual(log.map((l) => l.phase).slice(-2), ["harvesting", "retro"]);
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds stop.afterSpendUsd: anchored to THIS run's start — spend already ledgered by a PRIOR run is never inherited", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // isolates the anchor from any dispatch activity
  const state = new State(":memory:");
  state.recordSpend("prior-run-worker", 999, 50, new Date().toISOString(), []); // a prior run's spend
  const deps = baseDeps({ forge, state, sleep, stop: { afterSpendUsd: 10 } });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  // Never fires — this run's own ledgered spend (from its own startup anchor forward) is $0;
  // the pre-existing $50 belongs to an earlier run/process. boundedStopOnPhase's signal is what
  // actually ends the loop here.
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.stopCondition, undefined);
  deps.state.close();
});

test("runRounds stop.afterSpendUsd: spend ledgered by CLOSING peripherals (after the last tick) still stops at the round boundary — no second round opens (Codex P2, PR #160)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // zero worker spend — the ONLY spend is the retro session's, ledgered post-tick
  const state = new State(":memory:");
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const peripherals = {
    ...allPeripherals(log),
    // Mirrors runSessionWithRetry's role-session ledgering (peripheral.ts): the retro session's
    // cost lands in spend_ledger AFTER the executing phase's final tick — the exact window a
    // tick-only check never sees.
    retro: {
      async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
        log.push({ phase: "retro" as PeripheralPhase, marker: ctx.marker });
        state.recordSpend("retro-session-r1", 0, 25, new Date().toISOString(), []);
        return { marker: `retro-r${ctx.roundId}` };
      },
    },
  };
  const deps = baseDeps({ forge, state, sleep, stop: { afterSpendUsd: 20 }, peripherals });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 20, detail: "spent $25.00" });
  assert.equal(result.rounds, 1, "the crossed budget must stop the run at the boundary — never a second round");
  assert.equal(log.filter((l) => l.phase === "aligning").length, 1, "round 2 never opened its first phase");
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

// ── #124: round dispatch quota (multi-wave refill; lanes.max = concurrency only) ───────────

test("runRounds #124: 6 Ready issues, cap 6, lanes.max 3 -> one round, TWO dispatch waves of 3, all six terminal before close", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `i${n}`, labels: ["prio:3-feature"] }));
  // Every dispatched lane completes immediately — this test is about the WAVE SHAPE (how many
  // dispatch-enabled ticks it takes, and how many lanes each fills), not drain timing.
  const sup = new AutoCompleteSupervisor();
  const hits: RoundStopHit[] = [];
  // One entry per tick(): the issue numbers that tick actually dispatched (empty for a
  // reclaim-only/drain tick) — the observable proof of "two waves", not just "six total".
  const dispatchedPerTick: number[][] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 6 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => dispatchedPerTick.push(
      r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue),
    ),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1, 2, 3, 4, 5, 6]); // all six, in priority/number order
  const waves = dispatchedPerTick.filter((d) => d.length > 0);
  assert.deepEqual(waves, [[1, 2, 3], [4, 5, 6]], `expected exactly two 3-issue waves, got ${JSON.stringify(dispatchedPerTick)}`);
  // #124 quota-exhaustion mid-drain: once the 6th dispatch lands (inside wave 2's own tick —
  // "mid-drain" from the outer loop's perspective, since wave 2's lanes are still in flight),
  // the round-quota stop hit fires and every later tick is dispatch-frozen.
  assert.ok(hits.some((h) => h.name === "roundDispatchCap" && h.detail === "dispatched 6"));
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds #124: cost.roundBudgetUsd hit mid-wave-2 behaves exactly like a budget hit mid-drain — both waves still dispatched, harvest/retro still run", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `i${n}`, labels: ["prio:3-feature"] }));
  // roundDispatchCap set well above the 6 issues available so it can never fire first and mask
  // the budget hit this test is actually isolating (same isolation stance as the existing
  // cost.roundBudgetUsd test above).
  const sup = new AutoCompleteSupervisor();
  // $1/lane; wave 1's three lanes bank $3 (< the $3.5 budget below) — the budget can only cross
  // once wave 2's three lanes are ALSO reclaimed, i.e. mid-wave-2.
  for (const n of [1, 2, 3, 4, 5, 6]) sup.probes[`lane-${n}-${n}`] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false, costUsd: 1 };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const hits: RoundStopHit[] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 8 }, cost: { roundBudgetUsd: 3.5 } }),
    peripherals: allPeripherals(log),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1, 2, 3, 4, 5, 6]); // wave 2 fully dispatched before the budget stopped anything NEW
  assert.ok(hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $6.00"));
  assert.ok(!hits.some((h) => h.name === "roundDispatchCap"), "the quota (8) never bound — budget is the sole stop reason");
  // Harvest + retro still ran (never skipped by a round-level cost condition — only KILL_SWITCH
  // skips peripherals), exactly like the pre-#124 mid-drain budget test above.
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds #124 gate② P1-1: an UNEVEN final wave dispatches exactly the remaining quota, never a full lanes.max batch — 8 Ready, cap 4, max 3 -> waves [1,2,3] then [4]", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: n, title: `i${n}`, labels: ["prio:3-feature"] }));
  const sup = new AutoCompleteSupervisor();
  const hits: RoundStopHit[] = [];
  const dispatchedPerTick: number[][] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    // Quota (4) does NOT divide evenly by lanes.max (3): wave 2 has only 1 quota left but 3
    // free lanes — without dispatchCapOverride actually reaching tick(), its per-tick cap
    // falls back to cfg.lanes.roundDispatchCap (4) and wave 2 overshoots to 3 lanes (6 > 4
    // total). The even 6/6/3 case can never catch this; this uneven split is the regression.
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 4 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => dispatchedPerTick.push(
      r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue),
    ),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  const waves = dispatchedPerTick.filter((d) => d.length > 0);
  assert.deepEqual(waves, [[1, 2, 3], [4]], `wave 2 must dispatch EXACTLY the 1 remaining quota, got ${JSON.stringify(dispatchedPerTick)}`);
  assert.deepEqual(sup.dispatchedIssues, [1, 2, 3, 4]); // issues 5-8 never dispatched this round
  assert.ok(hits.some((h) => h.name === "roundDispatchCap" && h.detail === "dispatched 4"));
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds #124 gate② P1-2: spend banked by a tick's OWN reclaim blocks that same tick's refill — the budget gate reads live post-reclaim state, not a pre-tick snapshot", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  // Two Ready issues, quota headroom (cap 6) and — once lane 1 is reclaimed — lane headroom
  // (max 1, the reclaim frees the only lane). The ONLY thing standing between issue 2 and a
  // dispatch is the round budget, and the spend that crosses it lands inside the very tick
  // that would dispatch it: reclaim (banks $999) runs before dispatch in the same tick() call.
  forge.ready = [
    { number: 1, title: "i1", labels: ["prio:3-feature"] },
    { number: 2, title: "i2", labels: ["prio:3-feature"] },
  ];
  const sup = new FakeSupervisor();
  // No PR (hasPr: false) -> ESCALATE_NOPR reclaim path, which still records spend (same probe
  // shape as the pre-#124 cost.roundBudgetUsd test above). $50: crosses roundBudgetUsd ($5)
  // WITHOUT crossing the default cost.dailyBudgetUsd ($100) — a bigger figure would trip the
  // engine-wide ceiling too, and its "ceiling" skip outranks "over-budget" in the dispatch
  // loop, masking the exact gate this test isolates.
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 50 };
  // Safety net for the REGRESSION case only: if the budget gate ever goes stale again and
  // issue 2 IS dispatched, its lane must still complete — otherwise FakeSupervisor's
  // runs-forever default would hang the drain loop (injected sleep = busy spin) instead of
  // letting the assertions below report the failure. Never consulted when the gate works.
  sup.probes["lane-2-2"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 0 };
  const hits: RoundStopHit[] = [];
  const overBudgetSkips: number[] = [];
  const dispatchedPerTick: number[][] = [];
  const deps = baseDeps({
    forge, supervisor: sup, sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 6 }, cost: { roundBudgetUsd: 5 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => {
      dispatchedPerTick.push(r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue));
      for (const d of r.dispatched) if (d.kind === "skipped" && d.reason === "over-budget") overBudgetSkips.push(d.issue);
    },
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRounds(deps);
  stopSafety();
  // Issue 2 was never dispatched — not in the reclaim tick (whose own banked spend must gate
  // it) nor by any later wave (the round-level stop hit freezes further dispatch).
  assert.deepEqual(sup.dispatchedIssues, [1], "the budget-blowing reclaim's tick must not refill the freed lane");
  assert.deepEqual(dispatchedPerTick.filter((d) => d.length > 0), [[1]]);
  assert.ok(overBudgetSkips.includes(2), "issue 2 was skipped over-budget IN the reclaim tick itself, not merely never reached");
  assert.ok(hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $50.00"));
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds #124 crash-rerun: a resumed drain (freshBatch=false) never dispatches a new wave, even with quota AND lanes still free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    // One lane already in flight from before the (simulated) crash — activeWorkers()=1, well
    // under lanes.max=3, and ZERO "dispatched" events exist yet, so dispatchedThisRound()=0,
    // well under roundDispatchCap=6. Both the quota AND lane-concurrency checks would allow a
    // fresh wave if freshBatch were (wrongly) true here.
    state.upsertWorker({
      name: "lane-99", issue: 99, session_id: "s99", state: "running",
      started_at: "2026-07-09T00:00:30.000Z", ended_at: null,
    });
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    // Plenty of Ready work sitting there, well within quota + lanes — a bug that let a resumed
    // drain attempt a fresh wave would dispatch some of this.
    forge.ready = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `i${n}`, labels: ["prio:3-feature"] }));
    const sup = new FakeSupervisor();
    sup.probes["lane-99"] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
    const deps = baseDeps({
      forge, supervisor: sup, state: state2, sleep,
      cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 6 } }),
    });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRounds(deps);
    stopSafety();
    assert.deepEqual(sup.dispatchedIssues, []); // nothing new dispatched despite quota + lane room
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
//
// Idle-round precondition (Codex P1, round 2): the FIRST round of a run always opens — the PO
// can decompose the plan doc alone, which no pure-API probe can see — so standby only engages
// after a fully idle round (nothing dispatched) closed AND the probe is still empty. Every
// "standby engages" test below therefore has a two-step shape: an idle round 1 (whose #109
// idle-throttle wait is the first sleep), THEN the standby backoff.

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

test("runRounds standby: fresh empty board — the FIRST round always opens (the PO's plan-doc decomposition shot); still empty after it closes -> standby, zero further role sessions, backoff doubling in events", async () => {
  const forge = new FakeForge(); // ready/planReview/triage all [] — probe never hits
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
    if (sleepCalls.length >= 5) stop();
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  // Round 1 ran ALL five peripherals (the PO got its shot) — and nothing after it: standby.
  assert.equal(result.rounds, 1);
  assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  // First sleep = round 1's #109 idle-throttle wait; the rest = standby. Backoff waits are
  // sliced into tickIntervalSec chunks (kill-switch acknowledgment, Codex round 3), so every
  // sleep call is exactly one 5s slice — the DOUBLING shows up in the standby-wait events'
  // waitSec, not in individual sleep lengths. 5 calls = throttle + attempt0 (1 slice of 5) +
  // attempt1 (2 slices of 10) + the first slice of attempt2, where the safety net stops.
  assert.deepEqual(sleepCalls, [5000, 5000, 5000, 5000, 5000]);
  const waits = events.filter(([kind]) => kind === "standby-wait").map(([, payload]) => payload);
  assert.deepEqual(waits, [
    { attempt: 0, waitSec: 5 }, { attempt: 1, waitSec: 10 }, { attempt: 2, waitSec: 20 },
  ]);
  assert.equal(state.getRound(2), undefined, "no second round ever opened while in standby");
  state.close();
});

test("runRounds standby: SIGINT during a standby wait exits promptly — the wait never delays shutdown, and no further round opens", async () => {
  let stop = (): void => {};
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const sleepCalls: number[] = [];
  // Sleep 1 is round 1's idle-throttle wait (resolves normally); sleep 2 is the FIRST standby
  // wait — it NEVER resolves on its own, so the signal (fired the moment it starts) must be
  // what ends it, same shape as the #109 idle-throttle sigint test above.
  const sleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length === 1) return Promise.resolve();
    stop();
    return new Promise<void>(() => {});
  };
  const forge = new FakeForge(); // empty board — standby engages after the idle first round
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1); // the idle first round — nothing after it
  assert.deepEqual(sleepCalls, [5000, 5000]); // idle throttle + the FIRST backoff step, aborted immediately
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 1, "the aborted wait WAS a standby wait");
  assert.equal(state.getRound(2), undefined, "no second round was ever opened");
  state.close();
});

test("runRounds standby: the backoff wait is capped at round.standby.backoffCapSec — it never grows past it", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 6) stop();
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 10,
    cfg: mkCfg({ round: { standby: { enabled: true, backoffCapSec: 25 } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  // The cap shows in the standby-wait events' waitSec (uncapped, attempt 2 would be 40): the
  // sleeps themselves are tickIntervalSec slices (kill-switch acknowledgment), never longer.
  const waits = events.filter(([kind]) => kind === "standby-wait").map(([, payload]) => payload);
  assert.deepEqual(waits, [
    { attempt: 0, waitSec: 10 }, { attempt: 1, waitSec: 20 }, { attempt: 2, waitSec: 25 },
  ]);
  assert.ok(sleepCalls.every((ms) => ms <= 10000), "no single sleep ever exceeds one tick slice");
  state.close();
});

test("runRounds standby: a KILL_SWITCH created MID-backoff-wait is acknowledged within one tick slice — the round opens and freezes at aligning, never sleeping out the full backoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge(); // empty board — standby engages after the idle first round
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      // Call 1 = round 1's idle-throttle wait; call 2 = attempt 0's single 5s slice; call 3 =
      // the FIRST slice of attempt 1's 10s wait — the operator flips the kill switch while that
      // slice is sleeping. The between-slices check must catch it: no 4th sleep, ever.
      if (sleepCalls.length === 3) writeFileSync(join(dir, "KILL_SWITCH"), "");
    };
    const deps = baseDeps({
      forge, state, sleep, tickIntervalSec: 5,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    // Acknowledged after ONE 5s slice of the 10s backoff wait — pre-slicing this third call
    // would have been a single 10000ms sleep with the sentinel unread until it elapsed.
    assert.deepEqual(sleepCalls, [5000, 5000, 5000]);
    assert.deepEqual(log.map((l) => l.phase), ["aligning", "architecting", "plan_review", "harvesting", "retro"],
      "round 1 ran normally; round 2 froze BEFORE its aligning stub");
    assert.equal(result.rounds, 1); // round 2 opened to acknowledge the freeze but never closed
    assert.ok(state.getRound(2), "round 2 was opened (the freeze-acknowledgment round)");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds standby (#127 gate② F2): plan-review candidates do NOT count as work when planReviewer is disabled — standby still engages instead of the disabled-role signal pinning the probe true forever", async () => {
  const forge = new FakeForge();
  // The one probe signal present is a candidate ONLY the (disabled) plan-reviewer could
  // consume — pre-fix, this pinned probeHasWork true and standby never engaged.
  forge.planReviewCandidates = [{ number: 9, title: "unconsumable gate⓪ candidate", labels: [] }];
  // #127 gate② R2: prove the SHORT-CIRCUIT, not just the outcome — with the consuming role
  // disabled the probe must never even issue the API call (an && guard, not a discarded read).
  let planReviewProbeCalls = 0;
  const realGetNeedingReview = forge.getIssuesNeedingPlanReview.bind(forge);
  forge.getIssuesNeedingPlanReview = async () => { planReviewProbeCalls++; return realGetNeedingReview(); };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop(); // bounded safety net, same as the standby tests above
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ roles: { planReviewer: { enabled: false } }, round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(events.some(([kind]) => kind === "standby-wait"), "standby actually engaged");
  assert.equal(state.getRound(2), undefined, "no further round burned peripherals on the unconsumable candidate");
  assert.equal(planReviewProbeCalls, 0, "getIssuesNeedingPlanReview was never called — the disabled role short-circuits the probe's API read itself");
  state.close();
});

test("runRounds standby (#127 gate② F2): plan-TRIAGE candidates do NOT count as work when the PO is disabled — same disabled-consumer rule as the plan-review signal", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 11, title: "plan-less, but no PO to triage it", labels: [] }];
  // #127 gate② R2: same short-circuit proof as the plan-review test above.
  let triageProbeCalls = 0;
  const realGetNeedingTriage = forge.getIssuesNeedingPlanTriage.bind(forge);
  forge.getIssuesNeedingPlanTriage = async () => { triageProbeCalls++; return realGetNeedingTriage(); };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ roles: { po: { enabled: false } }, round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(events.some(([kind]) => kind === "standby-wait"), "standby actually engaged");
  assert.equal(state.getRound(2), undefined);
  assert.equal(triageProbeCalls, 0, "getIssuesNeedingPlanTriage was never called — the disabled role short-circuits the probe's API read itself");
  state.close();
});

test("runRounds standby (#127 gate② R1): with BOTH gate⓪ roles disabled, open milestone issues do NOT count as work — the only consumable signal left is Ready+dispatchable, so standby still engages", async () => {
  const forge = new FakeForge();
  // A milestone-scoped run whose milestone still holds open issues — but nothing enabled can
  // consume them: no PO to decompose/triage, no plan-reviewer to approve, and none are Ready.
  // Pre-fix, the probe's milestone catch-all counted them unconditionally and pinned standby off.
  forge.milestoneOpenCounts = [3];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({
      roles: { po: { enabled: false }, planReviewer: { enabled: false } },
      round: { milestone: "M-X", standby: { enabled: true } },
    }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(events.some(([kind]) => kind === "standby-wait"), "standby actually engaged");
  assert.equal(state.getRound(2), undefined, "no further round burned peripherals on issues nothing enabled can consume");
  state.close();
});

test("runRounds standby: a Ready issue appearing mid-backoff is caught by the NEXT probe — standby exits and the round opens, no extra wait beyond that one step", async () => {
  const forge = new FakeForge();
  const sup = new AutoCompleteSupervisor();
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Sleep 1 is the idle first round's throttle wait. The issue appears during sleep 2 — the
    // FIRST standby wait — so the very next probe (right after this resolves) must see it and
    // exit standby immediately, never waiting a second time.
    if (sleepCalls.length === 2) {
      forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
    }
  };
  const deps = baseDeps({
    forge, supervisor: sup, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the post-standby round 2
  const result = await runRounds(deps);
  stopSafety();
  const waits = events.filter(([kind]) => kind === "standby-wait");
  assert.equal(waits.length, 1, "exactly one backoff step before the new issue was noticed");
  const exit = events.find(([kind]) => kind === "standby-exit");
  assert.ok(exit, "a standby-exit event was recorded");
  assert.deepEqual(exit![1], { attempts: 1 });
  assert.deepEqual(sup.dispatchedIssues, [1], "the newly-Ready issue got dispatched once standby exited");
  assert.deepEqual(log.map((l) => l.phase), [
    "aligning", "architecting", "plan_review", "harvesting", "retro", // idle round 1
    "aligning", "architecting", "plan_review", "harvesting", "retro", // round 2, out of standby
  ]);
  assert.equal(result.rounds, 2);
  state.close();
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
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({
    forge, state, sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  // Two rounds: round 1 always opens (idle-round precondition); the probe between rounds 1 and
  // 2 is where the milestone signal must carry — round 2 opening with zero standby-wait events
  // proves it did.
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after the idle round 1 — never entered standby");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  assert.ok(forge.milestoneQueries.includes("M4"), "the milestone was actually queried");
  state.close();
});

test("runRounds standby: an open PLAN-TRIAGE candidate (plan-less, not Ready, no milestone scoping) counts as work — the PO exists to draft its plan, so no standby (Codex P1 on PR #150)", async () => {
  const forge = new FakeForge();
  forge.ready = []; // nothing dispatchable…
  forge.planReviewCandidates = []; // …nothing awaiting gate⓪…
  forge.planTriageCandidates = [{ number: 9, title: "new idea, no plan yet", labels: [] }]; // …but the PO has drafting to do
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({
    forge, state, sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }), // milestone UNSET — the triage signal must carry alone
    peripherals: allPeripherals(log),
  });
  // Two rounds: round 1 always opens (idle-round precondition); the probe between rounds 1 and
  // 2 is where the triage signal must carry — round 2 opening with zero standby-wait events
  // proves it did.
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after the idle round 1 — the triage candidate is work");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "standby never engaged");
  state.close();
});

test("runRounds standby: an outstanding pending-rollback row counts as work — only a tick retries it, and the failure that created it can be exactly what hid the Ready signal (Codex P2 round 4, PR #150)", async () => {
  const forge = new FakeForge(); // ready/planReview/triage all [] — every API signal is empty
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const sleepCalls: number[] = [];
  // The row must still be PENDING when the probe runs, i.e. appear after round 1's tick already
  // did its rollback-retry pass (a pre-seeded row would just be retried and cleared in round 1,
  // which is the system working, not the starvation case). Sleep call 1 is round 1's
  // idle-throttle wait — after closeRound, before the probe — exactly that window.
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length === 1) state.addPendingRollback(7, "Ready", "dispatch-rollback", new Date(0).toISOString());
  };
  const deps = baseDeps({
    forge, state, sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the rollback-retry round 2
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after the idle round 1 — the rollback row is work");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "standby never engaged");
  assert.equal(state.pendingRollbacks().length, 0, "round 2's tick retried and cleared the row — the starvation Codex flagged");
  state.close();
});

test("runRounds standby: stop.onMilestoneComplete completing EXTERNALLY mid-standby ends the run within one backoff step — never an eternal probe loop (Codex P2 on PR #150)", async () => {
  const forge = new FakeForge();
  forge.ready = []; // empty board — standby engages after the idle first round
  // Loop-top checks before rounds 1 and 2: 1 open (no hit); the post-wake re-check INSIDE
  // standby: 0 (hit). cfg.round.milestone is unset, so neither executing nor the probe consumes
  // any of these counts — they all belong to checkFinalMilestone.
  forge.milestoneOpenCounts = [1, 1, 0];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Safety net: if the fix regresses (final stop never re-checked mid-standby), the loop would
    // probe forever — bail via signal so the stoppedBy assertion below fails instead of hanging.
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge, sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    stop: { onMilestoneComplete: "M4" },
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  assert.equal(result.rounds, 1, "only the idle first round — the run ended from inside standby");
  // Sleep 1 = the idle round's throttle wait; sleep 2 = exactly ONE backoff step before the
  // completed milestone was noticed.
  assert.deepEqual(sleepCalls, [5000, 5000]);
  deps.state.close();
});

test("runRounds standby: a round resumed PAST executing (restart mid-harvest) never arms standby — the next round still opens fresh, giving the PO its restart shot (Codex P2 round 6, PR #150)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    // Simulate a crash mid-harvest: executing already ran (in the DEAD process — this one never
    // calls runExecuting for it), the engine died before retro.
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "harvesting", "2026-07-09T00:01:00.000Z");
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state2);
    const forge = new FakeForge(); // empty board — a probe would be empty, so standby WOULD engage if armed
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const { sleep } = mkSleepSpy();
    const deps = baseDeps({
      forge, state: state2, sleep,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    // Resumed round (harvesting, retro) + the fresh round 2 it must NOT standby away (5 phases).
    const stopSafety = boundedStopOnPhase(deps, 7);
    const result = await runRounds(deps);
    stopSafety();
    assert.deepEqual(log.map((l) => l.phase), [
      "harvesting", "retro", // the resumed round — no executing in THIS process
      "aligning", "architecting", "plan_review", "harvesting", "retro", // round 2: the PO's restart shot
    ]);
    assert.equal(result.rounds, 2);
    assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0,
      "the resumed round is not idle-evidence — standby never engaged before the PO's fresh round");
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds standby: a failing standby-wait/-exit event write is telemetry-only — the wait proceeds, work is still picked up, the run never crashes (Codex P2 round 5, PR #150)", async () => {
  const forge = new FakeForge(); // empty board — standby engages after the idle first round
  const sup = new AutoCompleteSupervisor();
  const state = new State(":memory:");
  // Every standby event write fails (transient disk/SQLite trouble) — everything else persists.
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    if (kind.startsWith("standby-")) throw new Error("disk full");
    realAppend(kind, payload);
  };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Sleep 1 = round 1's idle throttle; sleep 2 = the first standby slice, whose event write
    // just threw — work appearing here proves the loop survived it and still probes.
    if (sleepCalls.length === 2) forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  };
  const deps = baseDeps({
    forge, supervisor: sup, state, sleep, tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the post-standby round 2
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "standby survived the event-write failures and round 2 opened on the new issue");
  assert.deepEqual(sup.dispatchedIssues, [1]);
  state.close();
});

test("runRounds standby: a throwing probe fails OPEN — tick-error appended, the next round still opens, the run never crashes (gate② on PR #150)", async () => {
  const forge = new FakeForge();
  // Every getReadyIssues throws — the long-idle mode where standby runs for hours makes a
  // transient GitHub failure (rate limit, network blip) near-certain eventually; the probe must
  // read it as "has work" (round opens, pre-#125 behavior resumes), never as a crash or an
  // indefinite wait. (Round 1's own dispatch tick also hits this throw — contained separately
  // by runTick as an ordinary tick-error, leaving the round idle, which is exactly what arms
  // the standby probe for the round-2 boundary this test targets.)
  forge.getReadyIssues = async () => { throw new Error("rate limited"); };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({
    forge, state, sleep: async () => {},
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the fail-open round 2
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened despite the probe failure — fail-open");
  assert.deepEqual(log.map((l) => l.phase).slice(5), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  const err = events.find(([kind, payload]) =>
    kind === "tick-error" && String((payload as { error: string }).error).includes("standby probe failed"));
  assert.ok(err, "a tick-error event naming the standby probe was durably appended");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "the failed probe never read as 'nothing to do' — zero backoff waits");
  state.close();
});

test("runRounds standby: a truly exhausted round.milestone (0 open issues) contributes no work signal — standby engages same as the unscoped empty-board case", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneOpenCounts = [0]; // the milestone is fully drained — nothing left to decompose
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 2) stop();
  };
  const deps = baseDeps({
    forge, state, sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the idle first round — standby withheld round 2, the milestone had nothing left");
  // Sleep 1 = the idle round's throttle wait; sleep 2 = the first standby backoff step.
  assert.deepEqual(sleepCalls, [5000, 5000]);
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 1, "the second wait WAS a standby wait");
  state.close();
});
