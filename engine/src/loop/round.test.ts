// round.ts tests (#86): the round-loop skeleton — phase-transition sequence, round-level stop
// conditions, final stop.* preemption mid-round, KILL_SWITCH vs graceful peripheral behavior,
// and crash-rerun idempotence. Mirrors driver.test.ts's fake-forge/fake-supervisor/`:memory:`-
// state style (no claude, no gh).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { roundsExitCode } from "../cli.js";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type {
  CommitInfo,
  IForge,
  Issue,
  IssueMeta,
  IssueRelations,
  IssueSearchResult,
  PRCheckItem,
  PRComment,
  PRDetails,
  PRReviewData,
  PRReviewItem,
  PRStatus,
  ReviewThreadItem,
} from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { ProxyForge } from "../proxy/mcp-server.js";
import type { DriveOutcome } from "../roles/merge-driver.js";
import type { WorkerProxyOpts } from "../roles/worker.js";
import { KILL_SIGNAL_GRACE_MS } from "../roles/worker.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { State } from "../state/state.js";
import type { LaneProbe, MergeGate, Supervisor } from "./conductor.js";
import { ESCALATION_SOURCE_KINDS, ESCALATION_SOURCES } from "./escalation-reconcile.js";
import { attachAttemptGuard, withHangGuard } from "./hang-guard.test-support.js";
import {
  buildFixLegResume,
  escalatePoolRemovalFailures,
  isRoundFullyDegraded,
  noopPeripheralStub,
  type PeripheralPhase,
  type PeripheralStub,
  PoolScopedForge,
  poolRemovalEscalated,
  poolRemovalFailureCount,
  type RoundDeps,
  RoundScopedForge,
  type RoundStopHit,
  removeRoundPoolLabel,
  runRounds,
} from "./round.js";
import { type RoundArtifact, RoundArtifactSchema } from "./round-artifact.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

class FakeForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return { unplaced: [], elsewhere: 0 };
  }
  override async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  ready: Issue[] = [];
  milestoneOpenCounts: number[] = [0];
  milestoneQueries: string[] = [];
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  // #660 fix leg (busy-spin livelock): a stable login, mirroring round-defaults.test.ts's/
  // conductor.test.ts's/plan-review.test.ts's own FakeForge fixtures — no test in this file
  // exercises the comment-adjudication cursor's engine-comment exemption itself (issueComments
  // below defaults every issue to []), so a fixed value (never unresolvable) is all the
  // dispatch/drive checkpoints' incidental calls here need.
  override async getAuthenticatedActor(): Promise<string | null> {
    return "sapwood-bot";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return this.ready;
  }
  // #124: mirrors real GitHub behavior — a claimed issue leaves the Ready column, so it must
  // not still be `ready` for a LATER tick's dispatch phase to see (once its lane is reclaimed,
  // tick()'s in-flight dedup no longer protects it). Multi-wave rounds now call the dispatch
  // phase more than once per round, so this needs to actually mutate state — a no-op claim was
  // harmless under the old one-batch-per-round model but would let a second wave re-dispatch
  // the exact same issue number here.
  override async claimIssue(issue: number): Promise<void> {
    this.ready = this.ready.filter((i) => i.number !== issue);
  }
  override async setBoardStatus(): Promise<void> {}
  subIssues = new Map<number, Array<{ number: number; title: string; state: "OPEN" | "CLOSED" }>>();
  subIssueParents = new Map<number, number>();
  override async addSubIssue(parent: number, child: number): Promise<void> {
    const existingParent = this.subIssueParents.get(child);
    if (existingParent !== undefined && existingParent !== parent) {
      throw new Error(
        `Failed to add sub-issue #${child} to parent #${parent}. ` +
          "Issue may not contain duplicate sub-issues and Sub issue may only have one parent",
      );
    }
    const children = this.subIssues.get(parent) ?? [];
    if (!children.some((candidate) => candidate.number === child)) {
      children.push({ number: child, title: `Issue #${child}`, state: "OPEN" });
      this.subIssues.set(parent, children);
      this.subIssueParents.set(child, parent);
    }
  }
  override async getSubIssues(parent: number) {
    return this.subIssues.get(parent) ?? [];
  }
  addLabelCalls: Array<[number, string]> = [];
  override async addLabel(n: number, l: string): Promise<void> {
    this.addLabelCalls.push([n, l]);
    for (const issue of [...this.ready, ...this.openIssues]) {
      if (issue.number === n && !issue.labels.includes(l)) issue.labels = [...issue.labels, l];
    }
  }
  removeLabelCalls: Array<[number, string]> = [];
  override async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
    for (const issue of [...this.ready, ...this.openIssues]) {
      if (issue.number === n) issue.labels = issue.labels.filter((x) => x !== l);
    }
  }
  override async addPRLabel(): Promise<void> {}
  override async openPR(): Promise<number> {
    return 1;
  }
  override async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  /** #502: DRIVE's once-per-tick base-branch CI read. A GREEN default branch, so nothing in this
   *  file's scenarios changes behaviour. */
  override async getDefaultBranchChecks() {
    return { branch: "main", headOid: "base-head", checks: [], total: 0 };
  }
  override async mergePR(): Promise<void> {}
  override async addPRComment(): Promise<void> {}
  throwOnAddIssueComment = false;
  override async addIssueComment(issue: number, body: string): Promise<void> {
    if (this.throwOnAddIssueComment) throw new Error("gh comment write failed");
    if (this.issueComments[issue] === undefined) this.issueComments[issue] = [];
    this.issueComments[issue]!.push({ login: "sapwood", createdAt: "2026-01-01T00:00:00Z", body });
  }
  override async getIssueBody(_issue: number): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  override async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  override async getPRReviewData(): Promise<PRReviewData> {
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
  override async getPRDiff(): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  override async branchExists(): Promise<boolean> {
    return false;
  }
  override async countOpenIssuesInMilestone(milestone: string): Promise<number> {
    this.milestoneQueries.push(milestone);
    return this.milestoneOpenCounts.length > 1 ? this.milestoneOpenCounts.shift()! : this.milestoneOpenCounts[0]!;
  }
  milestoneTitles: string[] = [];
  override async listMilestoneTitles(): Promise<string[]> {
    return this.milestoneTitles;
  }
  planReviewCandidates: Issue[] = [];
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return this.planReviewCandidates;
  }
  issueLabels: Record<number, string[]> = {};
  override async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  /** #484: GATED RECLAIM reads the issue's live state before the reentry cap (a CLOSED issue is
   *  terminal). Mutable per-issue; unlisted issues read OPEN, as every fixture here assumes. */
  issueState: Record<number, "OPEN" | "CLOSED"> = {};
  /** #630: the probe's gated-reentry-candidates signal milestone-scopes via getIssueMeta, the
   *  same read GATED RECLAIM already does. Mutable per-issue; unlisted issues read no milestone. */
  issueMilestone: Record<number, string> = {};
  override async getIssueMeta(issue: number) {
    return {
      number: issue,
      title: `issue ${issue}`,
      state: this.issueState[issue] ?? ("OPEN" as const),
      labels: this.issueLabels[issue] ?? [],
      updatedAt: "2026-01-01T00:00:00Z",
      ...(this.issueMilestone[issue] !== undefined ? { milestone: this.issueMilestone[issue] } : {}),
    };
  }
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  override async getIssueComments(issue: number) {
    return this.issueComments[issue] ?? [];
  }
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  openIssueNumbers: number[] = [];
  override async createIssue(title: string, body: string): Promise<number> {
    this.createdIssues.push({ title, body });
    const n = this.nextIssueNumber++;
    this.openIssueNumbers.push(n);
    return n;
  }
  override async listOpenIssueNumbers(): Promise<number[]> {
    return this.openIssueNumbers;
  }
  openIssues: Issue[] = [];
  override async listOpenIssues(): Promise<Issue[]> {
    return this.openIssues;
  }
  planTriageCandidates: Issue[] = [];
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return this.planTriageCandidates;
  }
  // #432 round 4: the round-pool's own candidate set (forge.ts's selectPoolEligibleIssues) — the
  // probe's new status-aware plan-review signal reads this directly, same fixture pattern as
  // planReviewCandidates/planTriageCandidates above.
  poolEligible: Issue[] = [];
  override async getPoolEligibleIssues(): Promise<Issue[]> {
    return this.poolEligible;
  }
}

test("#311 FakeForge reconciles same-parent duplicate adds but rejects a second parent with GitHub's fingerprint", async () => {
  const forge = new FakeForge();
  await forge.addSubIssue(11, 12);
  await assert.doesNotReject(forge.addSubIssue(11, 12));
  await forge.addSubIssue(11, 13);
  assert.deepEqual(await forge.getSubIssues(11), [
    { number: 12, title: "Issue #12", state: "OPEN" },
    { number: 13, title: "Issue #13", state: "OPEN" },
  ]);
  await assert.rejects(
    forge.addSubIssue(99, 12),
    /Failed to add sub-issue.*Issue may not contain duplicate sub-issues.*Sub issue may only have one parent/,
  );
  assert.deepEqual(await forge.getSubIssues(99), []);
});

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
  async resume(_issue: Issue, worker: string): Promise<{ name: string; sessionId: string }> {
    return { name: worker, sessionId: `sess-${worker}` };
  }
  resumeIntentState(): "none" {
    return "none";
  }
  /** Every worker name reclaim() was called for — general bookkeeping for tests about the
   *  ORDINARY (tick()-driven) reclaim path. #724 gate② round 3: the E-STOP durable-pid sweep no
   *  longer calls reclaim() at all (P1-1) — see durablePids/signalsSent below for its own tests. */
  reclaimedNames: string[] = [];
  async reclaim(worker: string): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> {
    this.reclaimedNames.push(worker);
    return { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } {
    return { worktreePath: null, worktreeRetained: false };
  }
  /** #380: every graceful-handoff request the drain made — the stop-signal tests' proof that a
   *  signal drained live lanes rather than abandoning them. */
  handoffRequested: string[] = [];
  requestHandoff(w: string): boolean {
    this.handoffRequested.push(w);
    return true;
  }
  clearStaleFixEntrySentinel(): void {}
  /** #724 gate② round 3, P1-1: a pid-liveness fake — set per-worker (default false) to simulate
   *  a confirmed-alive durable pid, once `enableDurablePidCapability()` below has attached the
   *  reader. Deliberately does NOT auto-flip to false when SIGKILL is recorded — a test that
   *  wants a CONFIRMED-dead outcome sets it explicitly after asserting the signal sequence, so
   *  the fixture never hides which of the two post-signal outcomes (confirmed dead vs. orphaned)
   *  a given test exercises. */
  durablePids: Record<string, boolean> = {};
  /** #724 gate② round 4, P2-3: every (worker, signal) pair signalDurablePid was called for, in
   *  order. The durable-pid sweep tests' proof that a confirmed-alive row actually got the
   *  TERM-then-KILL sequence, replacing the retired reclaimedNames-based assertion for this path. */
  signalsSent: Array<{ worker: string; signal: "SIGTERM" | "SIGKILL" }> = [];
  /** #724 gate② round 4, P2-3: BOTH left genuinely unset (never assigned, not even to
   *  `undefined` — `exactOptionalPropertyTypes` forbids that explicitly) by default — "no
   *  opinion," the SAME stance `dispatch`/`resume`'s own optional `pid`/`worktreePath` already
   *  take, matching the vast majority of this fixture's existing callers that never touch
   *  durable-pid behavior at all. `enableDurablePidCapability()` attaches BOTH together, since
   *  the pair IS one capability (conductor.ts's own P2-3 doc); a test exercising the FAIL-CLOSED
   *  half-capable path instead assigns exactly ONE directly (`sup.durablePidAlive = (w) =>
   *  true;`), leaving the other genuinely absent. */
  durablePidAlive?: (w: string) => boolean;
  signalDurablePid?: (w: string, signal: "SIGTERM" | "SIGKILL") => void;
  enableDurablePidCapability(): void {
    this.durablePidAlive = (w) => this.durablePids[w] ?? false;
    this.signalDurablePid = (w, signal) => {
      this.signalsSent.push({ worker: w, signal });
    };
  }
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
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
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
  now: realClock,
  forge: new FakeForge(),
  state: new State(":memory:"),
  supervisor: new FakeSupervisor(),
  cfg: mkCfg(),
  tickIntervalSec: 5,
  registerSignals: () => () => {},
  ...over,
});

/** #691 FIX 2: `runRounds` drives `round.ts:1161/1692/1726`'s production `for (;;)` loops with no
 *  bound of its own -- every test-side stop condition here (`stop()`, `stop.afterIssuesMerged`,
 *  `boundedStopOnPhase`'s own onRoundPhase count, a FakeForge/FakeSupervisor stub) is exactly the
 *  kind of thing a missing or wrong stub can leave unmet, and an unmet stop condition means the
 *  loop spins forever. That is precisely the class that caused the 2026-08-05 incident: a missing
 *  `getAuthenticatedActor` stub turned a thrown-and-retried dispatch into a full-speed busy-spin
 *  livelock (7.75GB RSS, zero tests completing) that never even reached another `onRoundPhase`
 *  call for `boundedStopOnPhase` above to count -- commit 06b7aa8 patched that ONE fixture, never
 *  this class. See `hang-guard.test-support.ts` (shared with
 *  driver.test.ts/round-defaults.test.ts/harvest.test.ts/retro.test.ts -- ONE copy, not five) for
 *  why this needs BOTH `withHangGuard` and `attachAttemptGuard`, and why the earlier revision's
 *  `requestStop()` call was deleted. */
async function runRoundsGuarded(deps: RoundDeps): ReturnType<typeof runRounds> {
  const attemptGuardFired = attachAttemptGuard(deps);
  const result = await withHangGuard(
    runRounds(deps),
    45_000,
    "runRounds(deps) did not settle within 45000ms — a wedged production for(;;) loop (round.ts:1161/1692/1726), the class that caused the 2026-08-05 livelock (#691)",
  );
  const fired = attemptGuardFired();
  if (fired !== null) throw new Error(fired);
  return result;
}

/** #380: `requestStop` is TWO-STAGE now — the second call is a genuine second signal, i.e. the
 *  immediate hard exit (`process.exit`, or an injected RoundDeps.hardExit). Every bail-out net
 *  in this suite fires from a per-phase/per-sleep hook that runs many times, and several also
 *  fire their net again after runRounds returns, so they all latch: request the stop once,
 *  ignore the rest. A test that WANTS the second-signal behavior uses `requestStop` raw. */
function once(fn: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    fn();
  };
}

/** Bounded safety net: stop the loop after `maxRounds` peripheral-phase invocations so a
 *  round.ts bug (never closing, never stopping) fails the test instead of hanging the suite.
 *
 *  #669: `onRoundPhase` fires ONLY for the 5 peripheral phases (aligning/architecting/
 *  plan_review/harvesting/retro — runPeripheral's own call site); it is never called from the
 *  "executing" phase's own dispatch-drain loop, nor from the standby/park-recovery wait loops
 *  elsewhere in this file. A stall confined to one of THOSE loops (e.g. a tick() that fails on
 *  every attempt while a lane never goes terminal) would call neither onRoundPhase nor onTick
 *  on any of its failing iterations, so the `calls` counter above would never move — the exact
 *  defect class driver.test.ts's `boundedStop` had (#669: it counted only successful `onTick`
 *  callbacks, so an all-throwing tick bypassed it entirely). None of this file's current
 *  scenarios exercise that gap (verified: every stuck-loop test here bounds itself some other
 *  way — a CountdownSupervisor lane that naturally goes terminal, or an explicit onTick-driven
 *  stop), but the gap is real, so this adds an independent, generously-thresholded backstop on
 *  `sleep` (every one of those OTHER loops' own waits, called every iteration regardless of
 *  success) — deliberately a SEPARATE counter/threshold from `calls` above, not merged into it,
 *  so it never perturbs any of this file's ~76 exactly-calibrated `maxPhaseCalls` call sites. */
function boundedStopOnPhase(deps: RoundDeps, maxPhaseCalls: number): () => void {
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  let calls = 0;
  const prev = deps.onRoundPhase;
  deps.onRoundPhase = (roundId, phase) => {
    prev?.(roundId, phase);
    calls++;
    if (calls >= maxPhaseCalls) stop();
  };
  if (deps.sleep) {
    const prevSleep = deps.sleep;
    const SLEEP_BACKSTOP = 500; // generous: no correctly-behaving test here comes remotely close
    let sleepCalls = 0;
    deps.sleep = async (ms) => {
      await prevSleep(ms);
      sleepCalls++;
      if (sleepCalls >= SLEEP_BACKSTOP) stop();
    };
  }
  return () => stop();
}

// ── #669 follow-up (gate② finding): the sleep backstop above had no test of its own — this one
// drives it for real, through a stall confined entirely to the standby wait loop (the doc
// comment on boundedStopOnPhase names this exact loop as one of the ones `calls` can never see:
// onRoundPhase does not fire again once round 1 closes and standby engages). An empty FakeForge
// board never gives the probe anything to find, so — with standby enabled and no other stop
// condition configured — NOTHING besides this backstop would ever end this run: it is the sole
// source of the stop request, isolating exactly the mechanism this test exists to prove.
test("boundedStopOnPhase (#669 follow-up): a standby stall OUTSIDE onRoundPhase still trips the sleep backstop at EXACTLY its ceiling — asserts the count, not just that the run stopped", async () => {
  const forge = new FakeForge(); // ready/planReview/triage all [] — round 1 opens (the PO's shot), closes idle, then standby's probe finds nothing, forever
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
  };
  const phaseLog: Array<{ roundId: number; phase: PeripheralPhase }> = [];
  const deps = baseDeps({
    forge,
    sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    onRoundPhase: (roundId, phase) => phaseLog.push({ roundId, phase }),
  });
  // maxPhaseCalls set far past anything round 1's five peripheral phases could ever reach — the
  // ONLY path in this test that can request a stop is the sleep backstop's own SLEEP_BACKSTOP
  // (500), isolating it from boundedStopOnPhase's OTHER counter.
  const stopSafety = boundedStopOnPhase(deps, 1_000_000);
  const result = await runRounds(deps);
  stopSafety();
  assert.equal(
    result.stoppedBy,
    "signal",
    "the sleep backstop's own requestStop is what ended this run — nothing else in this scenario ever would have",
  );
  assert.equal(
    sleepCalls.length,
    500,
    "the backstop fires at EXACTLY its 500-call ceiling — one more call would mean the requested stop didn't actually end the loop, one fewer would mean something else (not the backstop) did",
  );
  assert.deepEqual(
    phaseLog.map((p) => p.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
    "onRoundPhase never fired again after round 1 closed — the entire stall this test exercises happened OUTSIDE it, inside standby's sleep-only wait loop",
  );
  deps.state.close();
});

// ── Phase-transition sequence ────────────────────────────────────────────────────────────────

test("runRounds: a round with nothing to dispatch visits every phase in order exactly once", async () => {
  const { sleep } = mkSleepSpy();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({ sleep, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 5); // aligning, architecting, plan_review, harvesting, retro
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds: a fresh phase always gets a null marker (first attempt)", async () => {
  const { sleep } = mkSleepSpy();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({ sleep, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(log.every((l) => l.marker === null));
  deps.state.close();
});

test("runRounds #206: a full round leaves a round-phase event trail — every phase it entered, in order, aligning -> closed", async () => {
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ sleep });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1);
  // The replay spine (frontend-design.md §11): rounds.phase is an in-place UPDATE, so this
  // trail is the ONLY history of the round state machine the dashboard can fold. #470: the
  // terminal `closed` entry additionally carries the idle-churn breaker's per-round sample
  // (`idle`, plus `fp` for an idle round) — asserted separately below so the SPINE assertion
  // stays about the spine.
  const trail = deps.state.eventsSince("1970-01-01T00:00:00.000Z", ["round-phase"]);
  assert.deepEqual(
    trail.map((e) => ({
      kind: e.kind,
      round_id: (e.payload as { round_id: number }).round_id,
      phase: (e.payload as { phase: string }).phase,
    })),
    [
      { kind: "round-phase", round_id: 1, phase: "aligning" },
      { kind: "round-phase", round_id: 1, phase: "architecting" },
      { kind: "round-phase", round_id: 1, phase: "plan_review" },
      { kind: "round-phase", round_id: 1, phase: "executing" },
      { kind: "round-phase", round_id: 1, phase: "harvesting" },
      { kind: "round-phase", round_id: 1, phase: "retro" },
      { kind: "round-phase", round_id: 1, phase: "closed" },
    ],
  );
  const closedPayload = trail.at(-1)!.payload as { idle: boolean; fp?: string };
  assert.equal(closedPayload.idle, true, "#470: this round dispatched nothing and left no lane in flight");
  assert.equal(typeof closedPayload.fp, "string", "#470: an idle round carries its own state fingerprint");
  for (const e of trail.slice(0, -1)) {
    assert.deepEqual(Object.keys(e.payload as object).sort(), ["phase", "round_id"], "#470: only the CLOSED entry is stamped");
  }
  deps.state.close();
});

test("runRounds (#703 v2, ruling item 5 — minimal surfacing): an idle round that also flagged comment-cursor-stale issues names them in the round log ('awaiting human on #N, #M'), deduped, read-only — no new event kind, label, or hold state", async () => {
  const { sleep } = mkSleepSpy();
  const logLines: string[] = [];
  const deps = baseDeps({ sleep, log: (msg) => logLines.push(msg) });
  // Simulate plan_review's #652 checkpoints flagging two issues this round (#42 twice, at two
  // different checkpoints — the exact "same issue, multiple flags" shape a real round can
  // produce — and #43 once) by appending the SAME `comment-cursor-stale` events plan-review.ts
  // already appends, via the plan_review phase's own observability hook — no new machinery, this
  // is exactly what the real checkpoint's escalateCommentCursorStale path already does.
  const priorOnRoundPhase = deps.onRoundPhase;
  deps.onRoundPhase = (roundId, phase) => {
    priorOnRoundPhase?.(roundId, phase);
    if (phase === "plan_review") {
      deps.state.appendEvent("comment-cursor-stale", {
        round_id: roundId,
        issue: 42,
        checkpoint: "gate0-pre-spend",
        cause: "comment-cursor",
        labeled: true,
        posted: true,
      });
      deps.state.appendEvent("comment-cursor-stale", {
        round_id: roundId,
        issue: 43,
        checkpoint: "gate0-pre-apply",
        cause: "comment-cursor",
        labeled: true,
        posted: true,
      });
      deps.state.appendEvent("comment-cursor-stale", {
        round_id: roundId,
        issue: 42,
        checkpoint: "gate0-pre-drafter-write",
        cause: "comment-cursor",
        labeled: true,
        posted: true,
      });
    }
  };
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1);
  const line = logLines.find((l) => l.includes("awaiting human"));
  assert.ok(line, "the round's own log names the held-back issue(s)");
  assert.match(line!, /#42/);
  assert.match(line!, /#43/);
  assert.equal((line!.match(/#42/g) ?? []).length, 1, "deduped — #42 flagged at two checkpoints still names it exactly once");
  // Read-only: the ONLY comment-cursor-stale events are the three this test itself injected —
  // the surfacing logic appends nothing of its own, no label write, no new hold state.
  assert.equal(deps.state.eventsAfterId(0, ["comment-cursor-stale"]).length, 3);
  deps.state.close();
});

test("runRounds (#703 v2, ruling item 5): an idle round with NO comment-cursor-stale events this round logs nothing extra — the reverse test", async () => {
  const { sleep } = mkSleepSpy();
  const logLines: string[] = [];
  const deps = baseDeps({ sleep, log: (msg) => logLines.push(msg) });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1);
  assert.ok(!logLines.some((l) => l.includes("awaiting human")), "nothing to surface — no line emitted");
  deps.state.close();
});

test("runRounds (#703 v2 gate② P2-3): a READ failure in the empty-pool surfacing path is READ-ONLY even on ITS OWN failure — logged only, ZERO new events appended (docs/security/adjudication.md's 'no write of any kind' claim must hold on the failure path too, not just the success path)", async () => {
  const { sleep } = mkSleepSpy();
  const logLines: string[] = [];
  const deps = baseDeps({ sleep, log: (msg) => logLines.push(msg) });
  // Induce a read failure ONLY for the surfacing path's own `eventsAfterId(..., ["comment-
  // cursor-stale"])` call — every OTHER kinds query (idle-churn's own fingerprint/streak reads,
  // etc.) is untouched, so this isolates exactly the one read this fix concerns.
  const realEventsAfterId = deps.state.eventsAfterId.bind(deps.state);
  deps.state.eventsAfterId = (afterId: number, kinds: string[]) => {
    if (kinds.includes("comment-cursor-stale")) throw new Error("simulated read failure");
    return realEventsAfterId(afterId, kinds);
  };
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1, "the round still closes — a read-only diagnostic failure never wedges round close");
  assert.ok(
    logLines.some((l) => l.includes("comment-cursor-stale surfacing read failed")),
    "the failure is logged",
  );
  assert.equal(
    deps.state.eventsSince("1970-01-01T00:00:00.000Z", ["tick-error"]).length,
    0,
    "ZERO ledger writes from this diagnostic path, even on its own failure — no tick-error event",
  );
  deps.state.close();
});

test("runRounds #123: a closed round leaves a persisted, schema-valid round artifact with endedAt set", async () => {
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ sleep });
  const stopSafety = boundedStopOnPhase(deps, 5); // exactly round 1's five peripheral phases
  const result = await runRoundsGuarded(deps);
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 2 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // two rounds' worth of peripheral phases
  const result = await runRoundsGuarded(deps);
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 3 }, round: { milestone: "M4" } }),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1]); // #2 (no milestone) never dispatched
  deps.state.close();
});

// ── #109 gate② P1: idle throttle between rounds ─────────────────────────────────────────────

test("runRounds idle throttle: an idle round (nothing dispatched) waits tickIntervalSec before the next round opens — peripherals never spin back-to-back on an empty backlog", async () => {
  const events: string[] = [];
  const sleep = async (ms: number): Promise<void> => {
    events.push(`sleep:${ms}`);
  };
  const deps = baseDeps({ sleep, tickIntervalSec: 7 });
  deps.onRoundPhase = (roundId, phase) => events.push(`r${roundId}:${phase}`);
  const stopSafety = boundedStopOnPhase(deps, 10); // two idle rounds' worth of phases
  const result = await runRoundsGuarded(deps);
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
  deps.registerSignals = (requestStop) => {
    // #380: ONE latch shared by both nets (this test's and the safety net's) — two independent
    // `once` wrappers over the same requestStop would each get a turn, and the second turn is a
    // second signal, i.e. an immediate hard exit of the test process.
    const single = once(requestStop);
    stop = single;
    return inner(single);
  };
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.deepEqual(sleepCalls, [5000]); // baseDeps tickIntervalSec=5 — the one idle wait, aborted
  assert.equal(deps.state.getRound(2), undefined, "no second round ever opened");
  deps.state.close();
});

test("runRounds idle throttle: a round that dispatched work is NOT additionally throttled — its drain loop already paced it on the tick cadence", async () => {
  const events: string[] = [];
  const sleep = async (ms: number): Promise<void> => {
    events.push(`sleep:${ms}`);
  };
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "a", labels: ["prio:3-feature"] }];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep });
  deps.onRoundPhase = (roundId, phase) => events.push(`r${roundId}:${phase}`);
  const stopSafety = boundedStopOnPhase(deps, 6); // through round 2's first phase
  await runRoundsGuarded(deps);
  stopSafety();
  const r1retro = events.indexOf("r1:retro");
  const r2aligning = events.indexOf("r2:aligning");
  assert.ok(r1retro >= 0 && r2aligning > r1retro, `expected both rounds' phases in ${JSON.stringify(events)}`);
  // The dispatched lane's cadence waits happened INSIDE executing (before r1:harvesting)…
  assert.ok(
    events.slice(0, r1retro).some((e) => e.startsWith("sleep:")),
    "drain loop did pace the dispatched lane",
  );
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ round: { milestone: "M4" } }),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, []); // never dispatched despite a matching Ready issue
  assert.ok(hits.some((h) => h.name === "milestone" && h.detail === "0 open issues left"));
  assert.equal(result.rounds, 1); // the round still ran its full phase sequence and closed
  deps.state.close();
});

test("runRounds #211: opening peripheral spend can exhaust the round budget before executing; zero lanes dispatch and harvest/retro still run", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 211, title: "must stay ready", labels: ["prio:3-feature"] }];
  const state = new State(":memory:");
  const sup = new FakeSupervisor();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const peripherals = {
    ...allPeripherals(log),
    aligning: {
      async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
        log.push({ phase: ctx.phase, marker: ctx.marker });
        state.recordSpend("po-align-211", 0, 6, new Date().toISOString(), []);
        return { marker: `aligning-r${ctx.roundId}` };
      },
    },
  };
  const hits: RoundStopHit[] = [];
  const overBudgetSkips: number[] = [];
  const deps = baseDeps({
    forge,
    supervisor: sup,
    state,
    sleep,
    cfg: mkCfg({ cost: { roundBudgetUsd: 5 } }),
    peripherals,
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (result) => {
      for (const outcome of result.dispatched)
        if (outcome.kind === "skipped" && outcome.reason === "over-budget") overBudgetSkips.push(outcome.issue);
    },
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();

  assert.deepEqual(sup.dispatchedIssues, []);
  assert.deepEqual(overBudgetSkips, [211], "the first executing tick saw the opening session's ledgered spend");
  assert.ok(hits.some((hit) => hit.name === "roundBudgetUsd" && hit.detail === "spent $6.00"));
  // #961: idle round — the real stub's quiet skip is asserted in retro.test.ts "runRounds integration (#961)"; this fake peripheral logs "retro" either way.
  assert.deepEqual(
    log.map((entry) => entry.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
  assert.equal(result.rounds, 1);
  assert.equal(state.getRound(1)?.status, "done");
  state.close();
});

test("runRounds #211: mixed peripheral and worker entries use one round ledger window and count each row once", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [
    { number: 1, title: "first", labels: ["prio:3-feature"] },
    { number: 2, title: "blocked refill", labels: ["prio:3-feature"] },
  ];
  const state = new State(":memory:");
  state.recordSpend("prior-round", 999, 40, "2020-01-01T00:00:00.000Z", []);
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false, costUsd: 3 };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const peripherals = {
    ...allPeripherals(log),
    aligning: {
      async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
        log.push({ phase: ctx.phase, marker: ctx.marker });
        state.recordSpend("po-align-mixed", 0, 2, new Date().toISOString(), []);
        return { marker: `aligning-r${ctx.roundId}` };
      },
    },
  };
  const observedWindowSpend: number[] = [];
  const realSpentAfterId = state.spentUsdAfterId.bind(state);
  state.spentUsdAfterId = (afterId: number) => {
    const total = realSpentAfterId(afterId);
    observedWindowSpend.push(total);
    return total;
  };
  const deps = baseDeps({
    forge,
    supervisor: sup,
    state,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 }, cost: { roundBudgetUsd: 4 } }),
    peripherals,
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();

  assert.deepEqual(sup.dispatchedIssues, [1], "the $2 peripheral entry permits wave 1; the exact $5 window blocks wave 2");
  assert.ok(observedWindowSpend.includes(2), "opening peripheral spend was visible before dispatch");
  assert.ok(observedWindowSpend.includes(5), "peripheral $2 + worker $3 was observed exactly once");
  const artifact = RoundArtifactSchema.parse(JSON.parse(state.getRoundArtifact(1)!.json));
  assert.equal(artifact.spendUsd, 5, "the prior-round $40 is excluded and no round entry is double-counted");
  assert.equal(result.rounds, 1);
  state.close();
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
    forge,
    supervisor: sup,
    sleep,
    // roundDispatchCap set well above 1 dispatch so it never fires first and masks the budget
    // hit this test is actually isolating.
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 }, cost: { roundBudgetUsd: 5 } }),
    peripherals: allPeripherals(log),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $999.00"));
  // Harvest + retro still ran (never skipped by a round-level cost condition — only KILL_SWITCH
  // skips peripherals). #961: dispatching round (not quiet) — the real stub's non-quiet path is asserted in retro.test.ts "runRounds integration (#961)"; this fake peripheral logs "retro" either way.
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 }, cost: { roundBudgetUsd: 5 } }),
  });
  const logged: Array<[string, unknown]> = [];
  const realAppend = deps.state.appendEvent.bind(deps.state);
  deps.state.appendEvent = (kind: EventKind, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  const hit = logged.find(([kind]) => kind === "round-stop");
  assert.ok(hit, "a round-stop event was durably appended");
  assert.deepEqual(hit![1], { round_id: 1, name: "roundBudgetUsd", detail: "spent $999.00" });
  deps.state.close();
});

test("runRounds #211: a crash-resumed executing phase reuses its persisted spend-ledger anchor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const path = join(dir, "sapwood.sqlite");
    const beforeCrash = new State(path);
    beforeCrash.recordSpend("prior-round-worker", 1, 100, "2026-07-08T00:00:00.000Z");
    const round = beforeCrash.startRound("2026-07-09T00:00:00.000Z");
    beforeCrash.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    beforeCrash.upsertWorker({
      name: "lane-99",
      issue: 99,
      session_id: "s99",
      state: "running",
      started_at: "2026-07-09T00:00:30.000Z",
      ended_at: null,
    });
    beforeCrash.recordSpend("lane-99", 99, 50, "2026-07-09T00:00:45.000Z");
    const persistedAnchor = round.start_spend_id;
    beforeCrash.close();

    // A new State instance is the actual crash/restart boundary. The open round must retain
    // the old cursor: prior-round $100 excluded, this round's already-settled $50 included.
    const state = new State(path);
    assert.equal(state.openRound()?.start_spend_id, persistedAnchor);
    assert.equal(state.spentUsdAfterId(state.openRound()!.start_spend_id!), 50);

    const forge = new FakeForge();
    forge.ready = [];
    const sup = new FakeSupervisor();
    // The resumed drain's first probe finds the lane already finished (no PR) -> tick()
    // reclaims it out of `running`, so the drain loop reaches idle after one iteration.
    sup.probes["lane-99"] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
    const hits: RoundStopHit[] = [];
    const deps = baseDeps({
      forge,
      supervisor: sup,
      state,
      sleep,
      cfg: mkCfg({ cost: { roundBudgetUsd: 5 } }), // already-banked $50 >> $5 budget
      onRoundStop: (_id, hit) => hits.push(hit),
    });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.ok(
      hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $50.00"),
      "the resumed drain detected all spend banked after the persisted round cursor",
    );
    assert.equal(result.rounds, 1);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #211: a crash-resumed executing phase with no spend anchor retains the active-lane budget proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const path = join(dir, "sapwood.sqlite");
    const beforeCrash = new State(path);
    const round = beforeCrash.startRound("2026-07-09T00:00:00.000Z");
    beforeCrash.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    beforeCrash.upsertWorker({
      name: "lane-legacy",
      issue: 95,
      session_id: "s95",
      state: "running",
      started_at: "2026-07-09T00:00:30.000Z",
      ended_at: null,
    });
    beforeCrash.recordSpend("lane-legacy", 95, 7, "2026-07-09T00:00:45.000Z");
    const realOpenRound = beforeCrash.openRound.bind(beforeCrash);
    beforeCrash.openRound = () => {
      const row = realOpenRound();
      if (!row) return undefined;
      // #403 (F25): DELETE the key rather than setting it to `undefined` — under
      // exactOptionalPropertyTypes an explicit `undefined` is not the same type as an absent
      // optional property, and "absent" is what a pre-#123 row actually looks like.
      const { start_spend_id: _omitted, ...legacy } = row;
      return legacy;
    };
    assert.equal(beforeCrash.openRound()?.start_spend_id, undefined);
    const sup = new FakeSupervisor();
    sup.probes["lane-legacy"] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
    const hits: RoundStopHit[] = [];
    const deps = baseDeps({
      forge: new FakeForge(),
      supervisor: sup,
      state: beforeCrash,
      sleep,
      cfg: mkCfg({ cost: { roundBudgetUsd: 5 } }),
      onRoundStop: (_id, hit) => hits.push(hit),
    });
    const stopSafety = boundedStopOnPhase(deps, 2);
    const result = await runRoundsGuarded(deps);
    stopSafety();

    assert.equal(result.rounds, 1);
    assert.ok(
      hits.some((hit) => hit.name === "roundBudgetUsd" && hit.detail === "spent $7.00"),
      "the missing-anchor fallback retained the pre-#211 active-lane spend proxy",
    );
    beforeCrash.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #211: a crash-resumed executing phase with no lanes records an existing budget hit exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.recordSpend("settled-lane", 211, 5, "2026-07-09T00:00:30.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    const hits: RoundStopHit[] = [];
    const deps = baseDeps({
      forge: new FakeForge(),
      supervisor: new FakeSupervisor(),
      state,
      sleep,
      cfg: mkCfg({ cost: { roundBudgetUsd: 5 } }),
      onRoundStop: (_id, hit) => hits.push(hit),
    });
    const stopSafety = boundedStopOnPhase(deps, 2);
    const result = await runRoundsGuarded(deps);
    stopSafety();

    assert.equal(result.rounds, 1);
    assert.deepEqual(hits, [{ name: "roundBudgetUsd", detail: "spent $5.00" }]);
    const durableHits = state
      .eventsAfterId(round.start_event_id ?? 0, ["round-stop"])
      .filter((event) => (event.payload as { name: string }).name === "roundBudgetUsd");
    assert.equal(durableHits.length, 1);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #172: a resumed handoff is charged to roundSpendUsd and trips the round budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    state.upsertWorker({
      name: "lane-handoff",
      issue: 172,
      session_id: "s172",
      state: "handoff",
      started_at: "2026-07-09T00:00:30.000Z",
      ended_at: "2026-07-09T00:01:00.000Z",
    });
    const sup = new FakeSupervisor();
    sup.probes["lane-handoff"] = {
      done: true,
      failed: false,
      handoff: false,
      hbAge: 1,
      wrapperAlive: 1,
      hasPr: false,
      costUsd: 7,
    };
    const hits: RoundStopHit[] = [];
    const deps = baseDeps({
      forge: new FakeForge(),
      supervisor: sup,
      state,
      sleep,
      cfg: mkCfg({ worker: { maxResumes: 1 }, cost: { roundBudgetUsd: 5 } }),
      onRoundStop: (_id, hit) => hits.push(hit),
    });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRoundsGuarded(deps);
    stopSafety();

    assert.equal(result.rounds, 1);
    assert.equal(state.spentUsdForWorker("lane-handoff"), 7);
    assert.ok(hits.some((hit) => hit.name === "roundBudgetUsd" && hit.detail === "spent $7.00"));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #245 round-2 fix (verifying the A2 adjudication's round.ts:898 claim): a `fixing` lane's own soft-budget handoff (fixingReclaimed, not reclaimed) keeps the executing-phase drain loop alive for a next tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep, calls } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-18T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-18T00:01:00.000Z");
    state.upsertWorker({
      name: "lane-fix",
      issue: 245,
      session_id: "s245",
      state: "fixing",
      started_at: "2026-07-18T00:00:30.000Z",
      ended_at: null,
      pr: 77,
    });
    const sup = new FakeSupervisor();
    // Probed as a fresh handoff on every call — this lands in tick()'s FIXING RECLAIM phase
    // (state is `fixing`), producing a `fixingReclaimed` entry, never a `reclaimed` one. Pre-fix,
    // `recoveryBeatPending` only checked `reclaimed` and the executing-phase loop would `break`
    // immediately after wave 1 (activeWorkers() drops to 0 the instant the lane hands off).
    sup.probes["lane-fix"] = { done: false, failed: false, handoff: true, hbAge: 1, wrapperAlive: 1, hasPr: true, prNumber: 77 };
    const deps = baseDeps({ forge: new FakeForge(), supervisor: sup, state, sleep, cfg: mkCfg() });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    await runRoundsGuarded(deps);
    stopSafety();

    // Without the fix, the executing loop breaks straight after wave 1 (recoveryBeatPending
    // false) and interTickWait/tick 2 never runs — sleep.calls would be empty. With the fix, the
    // fixingReclaimed handoff keeps the loop alive for (at least) one more tick.
    assert.ok(calls.length >= 1, "the fixing-origin handoff must earn a next tick before the executing phase drains to idle");
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
    forge,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterIssuesMerged: 1 },
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterSpendUsd: 20 },
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
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
  const result = await runRoundsGuarded(deps);
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
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 20, detail: "spent $25.00" });
  assert.equal(result.rounds, 1, "the crossed budget must stop the run at the boundary — never a second round");
  assert.equal(log.filter((l) => l.phase === "aligning").length, 1, "round 2 never opened its first phase");
  deps.state.close();
});

test("runRounds stop.afterSpendUsd: fired MID-round (worker spend crosses during drain) — no further wave dispatches in the SAME round (Codex P1, PR #160; #124/#154 interaction)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [1, 2, 3].map((n) => ({ number: n, title: `i${n}`, labels: ["prio:3-feature"] }));
  const sup = new AutoCompleteSupervisor();
  // lanes.max 1, quota 3: wave 1 = issue 1 alone; its reclaim banks $25 ≥ the $20 threshold, so
  // the run-level condition fires mid-round with quota AND lanes still free for waves 2-3.
  for (const n of [1, 2, 3])
    sup.probes[`lane-${n}-${n}`] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false, costUsd: 25 };
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 3 } }),
    stop: { afterSpendUsd: 20 },
  });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1], "waves 2-3 must never dispatch after the run-level spend stop fired");
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 20, detail: "spent $25.00" });
  assert.equal(result.rounds, 1);
  deps.state.close();
});

test("runRounds stop.onMilestoneComplete: checked at round boundaries (never mid-round), preempts opening a NEW round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // isolates the milestone check from dispatch activity
  forge.milestoneOpenCounts = [1, 0]; // round 1: not complete yet; round 2's preemptive check: complete
  const deps = baseDeps({ forge, sleep, stop: { onMilestoneComplete: "M4" } });
  const stopSafety = boundedStopOnPhase(deps, 15);
  const result = await runRoundsGuarded(deps);
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
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.deepEqual(log, []); // no peripheral ever ran
    assert.equal(result.rounds, 0); // the round never closed
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #724 gate② finding [1]: EMERGENCY_STOP must halt round-level progression the same way
// KILL_SWITCH already does — a paid peripheral session, an open standby probe loop, or the
// ceiling/park wait must never keep running (or keep waiting indefinitely) once E-STOP fires. ──

test("runRounds EMERGENCY_STOP: blocks the very next peripheral phase — harvest/retro are NEVER invoked, stoppedBy names emergency-stop, and the emergency-stop event is appended exactly once (#724 gate② finding [0])", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const forge = new FakeForge();
    forge.ready = [];
    const state = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state);
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    // Flip E-STOP BEFORE the round loop even starts aligning — proves the FIRST peripheral
    // phase it would otherwise run is blocked, not just later ones (mirrors the KILL_SWITCH
    // test just above). This is exactly the round-level detection path (runPeripheral's own
    // haltActive() gate, never reaching tick()) that #724 gate② finding [0] found silent.
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const deps = baseDeps({ forge, state, sleep, peripherals: allPeripherals(log) });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "emergency-stop");
    assert.deepEqual(log, []); // no peripheral ever ran — no paid session starts under E-STOP
    assert.equal(result.rounds, 0); // the round never closed
    assert.deepEqual(
      events.filter(([kind]) => kind === "emergency-stop"),
      [["emergency-stop", {}]],
      "the activation must be recorded even though no tick() ever ran this call — the pre-tick round-level detection path itself must announce it, exactly once",
    );
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds EMERGENCY_STOP + KILL_SWITCH both present: stoppedBy names emergency-stop, not kill-switch (same precedence tick() already uses)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const forge = new FakeForge();
    forge.ready = [];
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const deps = baseDeps({ forge, state, sleep, peripherals: allPeripherals(log) });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "emergency-stop"); // E-STOP is the stricter tier — its name wins
    assert.deepEqual(log, []);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds executing-phase drain loop: a pre-existing driving lane + EMERGENCY_STOP mid-round — the loop exits immediately instead of freezing behind the deliberately-untouched driving lane (#724 gate② finding [1])", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-drive-"));
  try {
    const { sleep, calls: sleepCalls } = mkSleepSpy();
    const forge = new FakeForge();
    forge.ready = []; // no new dispatch — isolates the driving lane as the drain loop's only occupant
    const state = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state);
    // A driving lane already occupying the board BEFORE this round even opens — activeWorkers()
    // is a live, round-agnostic query (state.ts's own doc on that method), so the executing
    // phase's drain loop inherits it as in-flight from its very first check. This is exactly the
    // shape a mid-run E-STOP wedges on: tick()'s own E-STOP branch (conductor.ts) hard-kills
    // running/fixing lanes but, by design, never touches `driving` rows.
    state.upsertWorker({ name: "lane-drv", issue: 900, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 900 });
    // #724 gate② P1: an ORDINARY driving lane (the shape this test is about) has no live process
    // at all — #293's own "left untouched, no process to kill" contract. FakeSupervisor's
    // durablePids default (false, "no opinion") already represents that; no fixture needed here
    // — this test is isolated from the P1 durable-pid sweep (see the dedicated sweep test below)
    // by construction, not by an explicit not-alive override.
    const sup = new FakeSupervisor();
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const deps = baseDeps({ forge, state, supervisor: sup, sleep, peripherals: allPeripherals(log) });
    // E-STOP is flipped only once plan_review (the phase immediately before executing) has
    // already run to completion — round.ts's own peripheral gate (runPeripheral) checks
    // haltActive() on ENTRY, so flipping any earlier would block the round before it ever
    // reaches executing at all (that pre-tick path is finding [0]'s own test, above). Here the
    // round must be genuinely INSIDE the executing phase for the drain loop itself to be
    // exercised.
    deps.onRoundPhase = (_roundId, phase) => {
      if (phase === "plan_review") writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    };
    const stopSafety = boundedStopOnPhase(deps, 10); // generous: aligning/architecting/plan_review is 3
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.stoppedBy, "emergency-stop");
    // The fix: drainedEnoughToExit() is true on its very FIRST check inside runExecuting — no
    // running/fixing lane ever existed, so liveLanesDrained() is immediately true — meaning ZERO
    // drainWait calls. Pre-fix, activeWorkers() stayed nonzero forever (the driving lane, never
    // touched by an E-STOP tick) and this loop would spin until boundedStopOnPhase's own sleep
    // backstop forced a stop — an unmistakably different, wrong outcome this assertion rules out.
    assert.deepEqual(sleepCalls, [], "the executing drain loop must exit without ever waiting on the driving lane");
    // The driving lane itself: still `driving`, untouched — E-STOP's contract (conductor.ts)
    // never kills it (no live process to kill); this fix only stops the loop from waiting on it.
    assert.equal(state.getWorker("lane-drv")?.state, "driving");
    // tick()'s own E-STOP branch (conductor.ts) announces the event during executing's wave 1 —
    // the round-level gate this round later hits at harvesting (finding [0]'s own fix) must see
    // it already recorded and stay silent, so exactly one still lands overall.
    assert.deepEqual(
      events.filter(([kind]) => kind === "emergency-stop"),
      [["emergency-stop", {}]],
    );
    // #724 gate② P1 reverse test: an ORDINARY driving lane (no live process — durablePids has no
    // entry for it) must never be signalled by the durable-pid sweep — it has nothing to kill,
    // and signaling it would be pure noise (or worse, a false "swept"+failed-row outcome) on the
    // overwhelmingly common driving-lane shape. Never settled to `failed` either.
    assert.deepEqual(sup.signalsSent, []);
    assert.deepEqual(
      events.filter(([kind]) => kind === "estop-lane-swept"),
      [],
    );
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #724 gate② P1 (round 3: P1-1/P1-2 redesign): on a CRASH-RESUMED batch (freshBatch false — the
// round is picked up directly at `executing`, never re-entering aligining/architecting/
// plan_review, #86's own rerun-not-resume contract), tick()'s wave-1 dispatch is skipped
// entirely (#172's own recovery-beat design) — so if the ONLY non-terminal rows are driving/
// handoff (zero running/fixing), the pre-fix exit predicate could call this loop drained WITHOUT
// tick() ever running once, leaving a CONFIRMED-alive detached child (spawned by the now-dead
// prior engine process, invisible to this fresh process's supervisor) completely unsignaled.
// This is the durable-pid sweep's own test — process-only (P1-1: no probe()/reclaim()) and
// terminalizing (P1-2: the row settles to `failed`, never left revivable).
test("runRounds executing-phase durable-pid sweep: a crash-resumed batch's handoff-row lane with a confirmed-alive durable pid is signalled directly (TERM then KILL), settled to failed, escalated, and made unreachable to reconciliation under EMERGENCY_STOP (#724 gate② P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-sweep-"));
  try {
    const { sleep, calls: sleepCalls } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    // A handoff-row lane left behind by the CRASHED prior process: a later confirmed resume
    // minted a fresh live child, but the crash landed before the DB row was ever flipped out of
    // `handoff` — the exact crash window reconcileDrivingFixIntents/adoptAndReclaimTerminal
    // (conductor.ts) exist to repair, provided tick() actually runs.
    state.upsertWorker({ name: "lane-ho", issue: 42, session_id: "s", state: "handoff", started_at: "t", ended_at: "t2" });
    state.close();

    // A FRESH State instance over the SAME file — the crash-restart itself (mirrors the existing
    // "resuming directly at 'executing'" crash-rerun test above).
    const state2 = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state2);
    const forge = new FakeForge();
    forge.ready = []; // no new dispatch — isolates the handoff row as the drain loop's only occupant
    const sup = new FakeSupervisor();
    sup.enableDurablePidCapability();
    // The fake-ALIVE durable pid: this crash-resumed process's supervisor has NO in-memory
    // handle for this lane (a brand-new `this.lanes` map — it was spawned by the now-dead PRIOR
    // process), but its DURABLE persisted process identity (running.json wrapper_pid) reads
    // genuinely alive. Never flips to false on its own (see FakeSupervisor's own doc) — this
    // test exercises the ORPHANED (unconfirmed-dead) outcome deliberately, proving the honest
    // trail even when the fake can't simulate a real kill.
    sup.durablePids["lane-ho"] = true;
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    // EMERGENCY_STOP already present before this resumed pass even starts — runPeripheral is
    // never going to run again for aligining/architecting/plan_review (this round resumes
    // straight into `executing`, past them all), so the sweep is the only mechanism that can
    // ever reach this row on this run.
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const deps = baseDeps({ forge, supervisor: sup, state: state2, sleep, peripherals: allPeripherals(log) });
    const stopSafety = boundedStopOnPhase(deps, 5);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.stoppedBy, "emergency-stop");
    // P1-1: signalled directly, by durable pid — TERM then KILL, in order — never through
    // reclaim()/probe() (never through tick()'s ordinary RESUME path either: freshBatch is
    // false, and E-STOP means no dispatch-enabled tick ever fires).
    assert.deepEqual(sup.signalsSent, [
      { worker: "lane-ho", signal: "SIGTERM" },
      { worker: "lane-ho", signal: "SIGKILL" },
    ]);
    // The short grace between TERM and KILL — the SAME named constant killByPid/killTree
    // (worker.ts) use — is the ONLY wait this whole run performs.
    assert.deepEqual(sleepCalls, [KILL_SIGNAL_GRACE_MS], "the grace wait is real and singular — no other waiting happens on this run");
    // P1-2: settled TERMINALLY in the same atomic step — never left `handoff` with a durable
    // resume intent a later reconciliation pass could adopt.
    assert.equal(state2.getWorker("lane-ho")?.state, "failed");
    // P1-1 crash-rerun safety: the durable PRE-KILL intent marker lands BEFORE the completion
    // event — both present, in order, proving the sweep actually wrote the marker before ever
    // signaling (not just at settlement time).
    assert.deepEqual(
      events.filter(([kind]) => kind === "estop-lane-sweep-started" || kind === "estop-lane-swept"),
      [
        ["estop-lane-sweep-started", { worker: "lane-ho", issue: 42 }],
        ["estop-lane-swept", { worker: "lane-ho", issue: 42, confirmedDead: false }],
      ],
    );
    // Outcome evented, never silent: FakeSupervisor's signalDurablePid doesn't actually kill
    // anything (durablePids stays true), so the post-signal check still reads alive — an honest
    // "could not confirm death" trail, not swallowed into a false "confirmed dead".
    // needs-human, but NEVER label-proven (#724 gate② round 4, P1-2 — round 3's own
    // `escalation-source:always` tagging was a false label-ownership claim; this sweep never
    // calls addLabel). Still a registered escalation source (surfaces on the dashboard), just
    // under the "never" proof mode env-failure-preserved/ceiling-escalated also use.
    assert.ok(ESCALATION_SOURCE_KINDS.includes("estop-lane-swept"), "estop-lane-swept must be a registered escalation source");
    assert.equal(ESCALATION_SOURCES["estop-lane-swept"], "never", "must never claim label ownership — this path writes no forge label");
    // The activation event itself still lands exactly once, from runPeripheral's own gate
    // (finding [0]) — the sweep is a SEPARATE concern from announcing the sentinel's activation.
    assert.deepEqual(
      events.filter(([kind]) => kind === "emergency-stop"),
      [["emergency-stop", {}]],
    );
    // P1-2's actual no-revival proof: `reconcileDrivingFixIntents`/`adoptAndReclaimTerminal`
    // (conductor.ts) — the ONLY code that ever reads a lane's resume intent and adopts it — act
    // exclusively over `drivingWorkers()`/`handoffWorkers()`. A `failed` row is structurally
    // absent from BOTH, on this run and any later restart's reconciliation pass alike.
    assert.deepEqual(
      state2.handoffWorkers().map((w) => w.name),
      [],
      "the swept lane must never again appear in handoffWorkers() — the exact query reconciliation adopts from",
    );
    assert.deepEqual(
      state2.drivingWorkers().map((w) => w.name),
      [],
    );
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #724 gate② round 4, P2-3: durablePidAlive/signalDurablePid are ONE capability, not two
// independently-optional ones. A Supervisor implementing only `durablePidAlive` (reporting a
// lane ALIVE) but not `signalDurablePid` used to let the sweep silently no-op the missing
// signal (optional chaining) and then settle the row `failed` anyway — a fabricated "swept"
// outcome over a child nobody ever touched, still alive when the run exits. This test proves
// the fail-closed fix: no settlement, no fake event, an honest "incapable" trail instead.
test("runRounds durable-pid sweep, half-capable Supervisor: durablePidAlive alone (no signalDurablePid) never settles or signals — fails closed and events the incapacity honestly (#724 gate② round 4, P2-3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-halfcap-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    state.upsertWorker({ name: "lane-half", issue: 55, session_id: "s", state: "handoff", started_at: "t", ended_at: "t2" });
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state2);
    const forge = new FakeForge();
    forge.ready = [];
    const sup = new FakeSupervisor();
    // ONLY the liveness half — signalDurablePid is left genuinely unset (the FakeSupervisor
    // default), reproducing the exact half-capable shape the finding describes.
    sup.durablePidAlive = (w) => sup.durablePids[w] ?? false;
    sup.durablePids["lane-half"] = true;
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const deps = baseDeps({ forge, supervisor: sup, state: state2, sleep });
    const stopSafety = boundedStopOnPhase(deps, 5);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.stoppedBy, "emergency-stop");
    // The fix: no signal was ever sent (the capability half that would send it is absent).
    assert.deepEqual(sup.signalsSent, []);
    // Never settled — the row is exactly as it was found, never a fabricated `failed`.
    assert.equal(state2.getWorker("lane-half")?.state, "handoff");
    // Never a fake completion event, never a pre-kill intent either (nothing was ever actually
    // decided-and-acted-on for this lane).
    assert.deepEqual(
      events.filter(([kind]) => kind === "estop-lane-swept" || kind === "estop-lane-sweep-started"),
      [],
    );
    // The honest trail instead: evented because THIS run's own durablePidAlive positively
    // reported the lane alive, even though it could not act on that finding.
    assert.deepEqual(
      events.filter(([kind]) => kind === "estop-lane-sweep-incapable"),
      [["estop-lane-sweep-incapable", { worker: "lane-half", issue: 55 }]],
    );
    // Still forced non-zero regardless — no separate forcing mechanism was needed for this path.
    assert.equal(roundsExitCode(result), 1);
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #724 gate② P2-3: `runPeripheral` (finding [0]'s own fix point) is NOT the only round-level exit
// path — `waitForDispatchClear`'s own haltActive() gate can return into the round-boundary's
// final-stop recheck WITHOUT ever reaching a peripheral phase, and a stop.* condition completing
// in that exact window can win the naming instead. The race test below reproduces exactly that.
test("runRounds EMERGENCY_STOP race with stop.onMilestoneComplete: the sentinel wins — stoppedBy names emergency-stop (never stop-condition), the event lands exactly once, and the exit code is forced non-zero (#724 gate② P2-3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-race-"));
  try {
    const { sleep } = mkSleepSpy();
    const forge = new FakeForge();
    forge.ready = []; // isolates the milestone check from dispatch activity — same isolation as the plain onMilestoneComplete test above
    // Round 1's preemptive checkFinalMilestone() (round.ts, right before the roundsClosed>0 gate)
    // reads the FIRST count (1, not complete) and falls through into waitForDispatchClear(); the
    // race-window RE-check right after it (round.ts's own "closes that gap for free" comment)
    // reads the SECOND count (0, complete) — mirrors the plain onMilestoneComplete test's own
    // [1, 0] fixture exactly, the only difference here being E-STOP landing in between.
    forge.milestoneOpenCounts = [1, 0];
    const state = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state);
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const deps = baseDeps({
      forge,
      state,
      sleep,
      stop: { onMilestoneComplete: "M4" },
      peripherals: allPeripherals(log),
      // E-STOP lands the INSTANT round 1's LAST peripheral phase (retro) completes — active
      // before the round-boundary gate's own waitForDispatchClear() call, exactly the race
      // window the finding describes: that call's own haltActive() check returns immediately
      // (no announce of its own — waitForDispatchClear has no opinion on WHICH sentinel is
      // active), and the very next statements are the milestone re-check that, pre-fix, would
      // win the naming silently (runPeripheral never runs again — round 2 never opens far
      // enough to reach a peripheral phase).
      onRoundPhase: (_roundId, phase) => {
        if (phase === "retro") writeFileSync(join(dir, "EMERGENCY_STOP"), "");
      },
    });
    const stopSafety = boundedStopOnPhase(deps, 15);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.stoppedBy, "emergency-stop");
    assert.equal(result.stopCondition, undefined, "the override must not also carry a stale stop-condition reason alongside it");
    assert.equal(result.rounds, 1); // round 1 fully closed; round 2 never opened
    assert.deepEqual(
      events.filter(([kind]) => kind === "emergency-stop"),
      [["emergency-stop", {}]],
      "the finalization wrapper announces it — nothing else in this run's path ever ran tick() or hit runPeripheral's own gate a second time",
    );
    assert.equal(roundsExitCode(result), 1, "non-zero exit — #293's own 'same shape as the kill-switch exit' contract");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #724 gate② round 3, P2-4: `runRoundsCore` REJECTING while E-STOP is active used to bypass the
// wrapper entirely — the promise just rejected, no announce, no `stoppedBy`. The durable record
// must still land even when this particular call never gets to report a clean result.
test("runRounds thrown-under-EMERGENCY_STOP: a rejecting sweep step still announces the activation before propagating the original error (#724 gate② round 3, P2-4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-throw-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    // Crash-resumed at `executing` (same shape as the durable-pid sweep test above) with a
    // confirmed-alive handoff row — the sweep will reach signalDurablePid() for it.
    state.upsertWorker({ name: "lane-boom", issue: 7, session_id: "s", state: "handoff", started_at: "t", ended_at: "t2" });
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const events = spyOnEvents(state2);
    const forge = new FakeForge();
    forge.ready = [];
    // An unexpected failure sending the signal — e.g. a transient OS error — must not be
    // swallowed OR leave the activation unrecorded; it propagates, but through the wrapper.
    // Both halves of the durablePid capability are assigned directly (not via
    // enableDurablePidCapability(), which would install a non-throwing signalDurablePid) — a
    // fully capable pair is required for the sweep to reach the signal at all (P2-3's own
    // fail-closed gate would otherwise skip this lane silently, never reaching the throw).
    const sup = new FakeSupervisor();
    sup.durablePidAlive = (w) => sup.durablePids[w] ?? false;
    sup.signalDurablePid = (): void => {
      throw new Error("boom: signal failed unexpectedly");
    };
    sup.durablePids["lane-boom"] = true;
    // EMERGENCY_STOP already present before this resumed pass even starts (same shape as the
    // sweep test above) — the sweep is reached immediately, on the very first drainedEnoughToExit
    // check, with no other phase in between.
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const deps = baseDeps({ forge, supervisor: sup, state: state2, sleep });
    await assert.rejects(runRoundsGuarded(deps), /boom: signal failed unexpectedly/);
    // The wrapper's own catch: E-STOP was active at the moment of rejection, so the durable
    // record still lands — a status/dashboard read (or a restart's own detection) is never left
    // believing E-STOP was silently missed just because THIS run threw.
    assert.deepEqual(
      events.filter(([kind]) => kind === "emergency-stop"),
      [["emergency-stop", {}]],
    );
    assert.ok(state2.ceilingBreach()?.reasons.includes("emergency-stop"));
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #724 gate② round 5, P2: the announce-under-catch (and, inside it, the best-effort log call)
// must NEVER be able to replace the ORIGINAL rejection — even when BOTH of them throw too. The
// test above proves the happy path (announce succeeds); this one proves the degraded one.
test("runRounds thrown-under-EMERGENCY_STOP: the ORIGINAL error still propagates even when the announce itself throws AND the logger it falls back to also throws (#724 gate② round 5, P2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-estop-throw-throw-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-09T00:01:00.000Z");
    state.upsertWorker({ name: "lane-boom2", issue: 8, session_id: "s", state: "handoff", started_at: "t", ended_at: "t2" });
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    forge.ready = [];
    const sup = new FakeSupervisor();
    sup.durablePidAlive = (w) => sup.durablePids[w] ?? false;
    sup.signalDurablePid = (): void => {
      throw new Error("original: signal failed unexpectedly");
    };
    sup.durablePids["lane-boom2"] = true;
    // The wrapper's own announce write (announceEstopActivation's recordEstopActivation call)
    // ALSO throws — a broken DB write hitting exactly the moment this run is already unwinding
    // from the sweep's own rejection. Not isEstopActive: that method is called from MANY places
    // throughout runRoundsCore's own normal flow, so overriding it would make the ORIGINAL error
    // come from there instead of from the sweep this test is actually about. recordEstopActivation
    // is reached ONLY via the announce path in this scenario (the round resumes straight into
    // `executing`, so runPeripheral's own announce call is never reached, and tick() never runs).
    state2.recordEstopActivation = (): void => {
      throw new Error("announce-failure: recordEstopActivation broke");
    };
    // The best-effort log fallback ALSO throws — e.g. a logger backed by a broken stream.
    const throwingLog = (): void => {
      throw new Error("logger-failure: log broke too");
    };
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const deps = baseDeps({ forge, supervisor: sup, state: state2, sleep, log: throwingLog });
    // The ORIGINAL error — never the announce failure, never the logger failure — is what a
    // caller must see. Either of the other two escaping unguarded would replace this message.
    await assert.rejects(runRoundsGuarded(deps), /original: signal failed unexpectedly/);
    state2.close();
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
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  // Signal arrives mid-round (right after 'aligning' runs) — the round must still finish
  // architecting/plan_review/harvesting/retro before the loop actually stops.
  deps.onRoundPhase = (_id, phase) => {
    if (phase === "aligning") stop();
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
  assert.equal(result.rounds, 1); // the round closed cleanly; only the NEXT round was withheld
  deps.state.close();
});

// ── #380 (F5): SIGTERM/SIGINT = the KILL_SWITCH drain path ──────────────────────────────────
// The graceful contract above is unchanged (the round already open still closes properly); what
// #380 adds is what happens to the WORK in flight while it does: dispatch freezes and live lanes
// are drained, instead of new waves launching and running workers being abandoned. Signals come
// through the registerSignals seam; the real process wiring lives in stop-signal.test.ts.

test("#380 runRounds: a stop signal freezes dispatch and DRAINS the executing round's live lane", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [
    { number: 1, title: "a", labels: ["prio:0-critical"] },
    { number: 2, title: "b", labels: ["prio:0-critical"] },
  ];
  const sup = new FakeSupervisor();
  // Lane 1 dispatches on the round's first wave and stays alive; the signal lands right after,
  // so the SECOND wave (issue 2, well within the default roundDispatchCap) must never launch.
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 2 } }) });
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  let ticks = 0;
  deps.onTick = () => {
    ticks++;
    if (ticks === 1) stop(); // SIGTERM right after the first (dispatching) tick
    // The worker complies with the drain request it got on tick 2 — .handoff, reclaimed on tick 3.
    if (ticks === 2) sup.probes["lane-1-1"] = { done: false, failed: false, handoff: true, hbAge: 1, wrapperAlive: 0, hasPr: false };
  };

  const result = await runRoundsGuarded(deps);

  assert.equal(result.stoppedBy, "signal");
  assert.deepEqual(sup.dispatchedIssues, [1], "the second wave never launched — dispatch froze on the signal");
  assert.deepEqual(sup.handoffRequested, ["lane-1-1"], "the live lane was drained gracefully, not abandoned");
  assert.equal(deps.state.getWorker("lane-1-1")?.state, "handoff");
  assert.equal(deps.state.activeWorkers().length, 0);
  deps.state.close();
});

test("#380 runRounds: a SECOND stop signal during the drain hard-exits immediately", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "a", labels: ["prio:0-critical"] }];
  const sup = new FakeSupervisor();
  const exits: number[] = [];
  const deps = baseDeps({ forge, supervisor: sup, sleep, hardExit: (code) => exits.push(code) });
  let stop: (signal?: NodeJS.Signals) => void = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop; // raw: this test IS the double-signal case
    return () => {};
  };
  let ticks = 0;
  deps.onTick = () => {
    ticks++;
    if (ticks === 1) stop("SIGINT"); // first signal: drain
    if (ticks === 2) {
      stop("SIGINT"); // second signal, mid-drain, lane still alive
      // The real hardExit is process.exit and never returns; the spy does, so settle the lane to
      // keep this test bounded rather than re-proving the (already covered) drain.
      sup.probes["lane-1-1"] = { done: false, failed: false, handoff: true, hbAge: 1, wrapperAlive: 0, hasPr: false };
    }
  };

  const result = await runRoundsGuarded(deps);

  assert.deepEqual(exits, [130], "the second SIGINT hard-exits with 128+SIGINT, without waiting for the drain");
  assert.equal(result.stoppedBy, "signal");
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
    const result = await runRoundsGuarded(deps);
    stopSafety();
    // aligning/architecting are NOT re-run — resumed straight at plan_review.
    assert.deepEqual(
      log.map((l) => l.phase),
      ["plan_review", "harvesting", "retro"],
    );
    // plan_review's stub saw the marker from the crashed attempt, not null — proof it wasn't
    // treated as a fresh first attempt.
    assert.equal(log[0]?.marker, "m1");
    assert.equal(result.rounds, 1);
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #206 crash-rerun: a re-entered phase appends a DUPLICATE round-phase event, not a throw (no dedup machinery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    // A crash MID-PHASE (#77 dec. 4's rerun-not-resume): plan_review was entered — its event is
    // already in the trail — and the engine died inside it. The restart reruns the whole phase,
    // so it is entered a second time and says so a second time.
    const round = state.startRound("2026-07-09T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "plan_review", "2026-07-09T00:01:00.000Z");
    state.appendEvent("round-phase", { round_id: round.round_id, phase: "plan_review" });
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const deps = baseDeps({ forge: new FakeForge(), state: state2, sleep });
    const stopSafety = boundedStopOnPhase(deps, 3); // plan_review, harvesting, retro
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.rounds, 1, "the duplicate is tolerated — the round still closed");
    const trail = state2.eventsSince("1970-01-01T00:00:00.000Z", ["round-phase"]).map((e) => (e.payload as { phase: string }).phase);
    // Two "plan_review" entries, no dedup: the replay fold is idempotent (same phase again =
    // no-op), so tolerating the duplicate is cheaper than machinery to prevent it.
    assert.deepEqual(trail, ["plan_review", "plan_review", "executing", "harvesting", "retro", "closed"]);
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #206 crash-rerun (gate② P1): a round that crashed between startRound and its FIRST event still gets its initial 'aligning' — the trail is never missing a phase the round entered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep } = mkSleepSpy();
    const state = new State(join(dir, "sapwood.sqlite"));
    // The round-open crash window: startRound() committed, the process died before anything
    // else. The row is in_progress at 'aligning' with ZERO events — and openRound() resumes it
    // through the branch that never opens a new round, so entry-time emission is the only thing
    // that can still record 'aligning'.
    state.startRound("2026-07-09T00:00:00.000Z");
    assert.deepEqual(state.eventsSince("1970-01-01T00:00:00.000Z", ["round-phase"]), [], "the crash left no trail at all");
    state.close();

    const state2 = new State(join(dir, "sapwood.sqlite"));
    const deps = baseDeps({ forge: new FakeForge(), state: state2, sleep });
    const stopSafety = boundedStopOnPhase(deps, 5);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.rounds, 1);
    const trail = state2.eventsSince("1970-01-01T00:00:00.000Z", ["round-phase"]).map((e) => (e.payload as { phase: string }).phase);
    assert.deepEqual(trail, ["aligning", "architecting", "plan_review", "executing", "harvesting", "retro", "closed"]);
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
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.deepEqual(sup.dispatchedIssues, []); // never dispatched by the resumed pass
    assert.deepEqual(
      log.map((l) => l.phase),
      ["harvesting", "retro"],
    );
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 6 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => dispatchedPerTick.push(r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue)),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1, 2, 3, 4, 5, 6]); // all six, in priority/number order
  const waves = dispatchedPerTick.filter((d) => d.length > 0);
  assert.deepEqual(
    waves,
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
    `expected exactly two 3-issue waves, got ${JSON.stringify(dispatchedPerTick)}`,
  );
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
  for (const n of [1, 2, 3, 4, 5, 6])
    sup.probes[`lane-${n}-${n}`] = { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false, costUsd: 1 };
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const hits: RoundStopHit[] = [];
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 8 }, cost: { roundBudgetUsd: 3.5 } }),
    peripherals: allPeripherals(log),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1, 2, 3, 4, 5, 6]); // wave 2 fully dispatched before the budget stopped anything NEW
  assert.ok(hits.some((h) => h.name === "roundBudgetUsd" && h.detail === "spent $6.00"));
  assert.ok(!hits.some((h) => h.name === "roundDispatchCap"), "the quota (8) never bound — budget is the sole stop reason");
  // Harvest + retro still ran (never skipped by a round-level cost condition — only KILL_SWITCH
  // skips peripherals), exactly like the pre-#124 mid-drain budget test above.
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
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
    forge,
    supervisor: sup,
    sleep,
    // Quota (4) does NOT divide evenly by lanes.max (3): wave 2 has only 1 quota left but 3
    // free lanes — without dispatchCapOverride actually reaching tick(), its per-tick cap
    // falls back to cfg.lanes.roundDispatchCap (4) and wave 2 overshoots to 3 lanes (6 > 4
    // total). The even 6/6/3 case can never catch this; this uneven split is the regression.
    cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 4 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => dispatchedPerTick.push(r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue)),
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
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
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 6 }, cost: { roundBudgetUsd: 5 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
    onTick: (r) => {
      dispatchedPerTick.push(r.dispatched.filter((d) => d.kind === "dispatched").map((d) => (d as { issue: number }).issue));
      for (const d of r.dispatched) if (d.kind === "skipped" && d.reason === "over-budget") overBudgetSkips.push(d.issue);
    },
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  // Issue 2 was never dispatched — not in the reclaim tick (whose own banked spend must gate
  // it) nor by any later wave (the round-level stop hit freezes further dispatch).
  assert.deepEqual(sup.dispatchedIssues, [1], "the budget-blowing reclaim's tick must not refill the freed lane");
  assert.deepEqual(
    dispatchedPerTick.filter((d) => d.length > 0),
    [[1]],
  );
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
      name: "lane-99",
      issue: 99,
      session_id: "s99",
      state: "running",
      started_at: "2026-07-09T00:00:30.000Z",
      ended_at: null,
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
      forge,
      supervisor: sup,
      state: state2,
      sleep,
      cfg: mkCfg({ lanes: { max: 3, roundDispatchCap: 6 } }),
    });
    const stopSafety = boundedStopOnPhase(deps, 2); // harvesting, retro
    const result = await runRoundsGuarded(deps);
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
  assert.deepEqual(
    (await scoped.getReadyIssues()).map((i) => i.number),
    [1],
  );
  const unscoped = new RoundScopedForge(forge, undefined);
  assert.deepEqual(
    (await unscoped.getReadyIssues()).map((i) => i.number),
    [1, 2],
  );
});

test("RoundScopedForge #215/#216: listOpenIssues exposes the full open backlog for proposal reconciliation", async () => {
  const forge = new FakeForge();
  forge.openIssues = [
    { number: 1, title: "in scope", labels: [], milestone: "M4" },
    { number: 2, title: "other milestone", labels: [], milestone: "M5" },
    { number: 3, title: "unassigned", labels: [] },
  ];
  assert.deepEqual(
    (await new RoundScopedForge(forge, "M4").listOpenIssues()).map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    (await new RoundScopedForge(forge, undefined).listOpenIssues()).map((issue) => issue.number),
    [1, 2, 3],
  );
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
  state.appendEvent = (kind: EventKind, payload: unknown) => {
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
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  // Round 1 ran ALL five peripherals (the PO got its shot) — and nothing after it: standby.
  assert.equal(result.rounds, 1);
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
  );
  // First sleep = round 1's #109 idle-throttle wait; the rest = standby. Backoff waits are
  // sliced into tickIntervalSec chunks (kill-switch acknowledgment, Codex round 3), so every
  // sleep call is exactly one 5s slice — the DOUBLING shows up in the standby-wait events'
  // waitSec, not in individual sleep lengths. 5 calls = throttle + attempt0 (1 slice of 5) +
  // attempt1 (2 slices of 10) + the first slice of attempt2, where the safety net stops.
  assert.deepEqual(sleepCalls, [5000, 5000, 5000, 5000, 5000]);
  const waits = events.filter(([kind]) => kind === "standby-wait").map(([, payload]) => payload);
  assert.deepEqual(waits, [
    { attempt: 0, waitSec: 5 },
    { attempt: 1, waitSec: 10 },
    { attempt: 2, waitSec: 20 },
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
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
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
    forge,
    state,
    sleep,
    tickIntervalSec: 10,
    cfg: mkCfg({ round: { standby: { enabled: true, backoffCapSec: 25 } } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  // The cap shows in the standby-wait events' waitSec (uncapped, attempt 2 would be 40): the
  // sleeps themselves are tickIntervalSec slices (kill-switch acknowledgment), never longer.
  const waits = events.filter(([kind]) => kind === "standby-wait").map(([, payload]) => payload);
  assert.deepEqual(waits, [
    { attempt: 0, waitSec: 10 },
    { attempt: 1, waitSec: 20 },
    { attempt: 2, waitSec: 25 },
  ]);
  assert.ok(
    sleepCalls.every((ms) => ms <= 10000),
    "no single sleep ever exceeds one tick slice",
  );
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
      forge,
      state,
      sleep,
      tickIntervalSec: 5,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    // Acknowledged after ONE 5s slice of the 10s backoff wait — pre-slicing this third call
    // would have been a single 10000ms sleep with the sentinel unread until it elapsed.
    assert.deepEqual(sleepCalls, [5000, 5000, 5000]);
    assert.deepEqual(
      log.map((l) => l.phase),
      ["aligning", "architecting", "plan_review", "harvesting", "retro"],
      "round 1 ran normally; round 2 froze BEFORE its aligning stub",
    );
    assert.equal(result.rounds, 1); // round 2 opened to acknowledge the freeze but never closed
    assert.ok(state.getRound(2), "round 2 was opened (the freeze-acknowledgment round)");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds standby (#127 gate② F2): plan-review candidates do NOT count as work when verificationPlanReviewer is disabled — standby still engages instead of the disabled-role signal pinning the probe true forever", async () => {
  const forge = new FakeForge();
  // The one probe signal present is a candidate ONLY the (disabled) verification-plan-reviewer could
  // consume — pre-fix, this pinned probeHasWork true and standby never engaged.
  forge.planReviewCandidates = [{ number: 9, title: "unconsumable gate⓪ candidate", labels: [] }];
  // #127 gate② R2: prove the SHORT-CIRCUIT, not just the outcome — with the consuming role
  // disabled the probe must never even issue the API call (an && guard, not a discarded read).
  let planReviewProbeCalls = 0;
  const realGetNeedingReview = forge.getIssuesNeedingPlanReview.bind(forge);
  forge.getIssuesNeedingPlanReview = async () => {
    planReviewProbeCalls++;
    return realGetNeedingReview();
  };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop(); // bounded safety net, same as the standby tests above
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ roles: { verificationPlanReviewer: { enabled: false } }, round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged",
  );
  assert.equal(state.getRound(2), undefined, "no further round burned peripherals on the unconsumable candidate");
  assert.equal(
    planReviewProbeCalls,
    0,
    "getIssuesNeedingPlanReview was never called — the disabled role short-circuits the probe's API read itself",
  );
  state.close();
});

test("runRounds standby (#127 gate② F2): plan-TRIAGE candidates do NOT count as work when the PO is disabled — same disabled-consumer rule as the plan-review signal", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 11, title: "plan-less, but no PO to triage it", labels: [] }];
  // #127 gate② R2: same short-circuit proof as the plan-review test above.
  let triageProbeCalls = 0;
  const realGetNeedingTriage = forge.getIssuesNeedingPlanTriage.bind(forge);
  forge.getIssuesNeedingPlanTriage = async () => {
    triageProbeCalls++;
    return realGetNeedingTriage();
  };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ roles: { po: { enabled: false } }, round: { standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged",
  );
  assert.equal(state.getRound(2), undefined);
  assert.equal(
    triageProbeCalls,
    0,
    "getIssuesNeedingPlanTriage was never called — the disabled role short-circuits the probe's API read itself",
  );
  state.close();
});

test("runRounds standby (#127 gate② R1): with BOTH gate⓪ roles disabled, open milestone issues do NOT count as work — the only consumable signal left is Ready+dispatchable, so standby still engages", async () => {
  const forge = new FakeForge();
  // A milestone-scoped run whose milestone still holds open issues — but nothing enabled can
  // consume them: no PO to decompose/triage, no verification-plan-reviewer to approve, and none are Ready.
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
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({
      roles: { po: { enabled: false }, verificationPlanReviewer: { enabled: false } },
      round: { milestone: "M-X", standby: { enabled: true } },
    }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged",
  );
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
    forge,
    supervisor: sup,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the post-standby round 2
  const result = await runRoundsGuarded(deps);
  stopSafety();
  const waits = events.filter(([kind]) => kind === "standby-wait");
  assert.equal(waits.length, 1, "exactly one backoff step before the new issue was noticed");
  const exit = events.find(([kind]) => kind === "standby-exit");
  assert.ok(exit, "a standby-exit event was recorded");
  assert.deepEqual(exit![1], { attempts: 1 });
  assert.deepEqual(sup.dispatchedIssues, [1], "the newly-Ready issue got dispatched once standby exited");
  // #961: idle round — the real stub's quiet skip is asserted in retro.test.ts "runRounds integration (#961)"; this fake peripheral logs "retro" either way.
  assert.deepEqual(
    log.map((l) => l.phase),
    [
      "aligning",
      "architecting",
      "plan_review",
      "harvesting",
      "retro", // idle round 1
      "aligning",
      "architecting",
      "plan_review",
      "harvesting",
      "retro", // round 2, out of standby
    ],
  );
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
      forge,
      state,
      sleep,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    const result = await runRoundsGuarded(deps);
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
  // #212 probe residual fix: the milestone catch-all now ALSO requires at least one non-held
  // (no cfg.escalation.humanLabels label) open issue actually IN the milestone — populate the
  // full-open-backlog fixture the fix reads (listOpenIssues), or this would now (correctly)
  // read as "nothing consumable" and the test's own premise (undecomposed, non-held issues)
  // would go untested.
  forge.openIssues = [
    { number: 50, title: "undecomposed", labels: [], milestone: "M4" },
    { number: 51, title: "also undecomposed", labels: [], milestone: "M4" },
    { number: 52, title: "not this milestone", labels: [] },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({
    forge,
    state,
    sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  // Two rounds: round 1 always opens (idle-round precondition); the probe between rounds 1 and
  // 2 is where the milestone signal must carry — round 2 opening with zero standby-wait events
  // proves it did.
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after the idle round 1 — never entered standby");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  assert.ok(forge.milestoneQueries.includes("M4"), "the milestone was actually queried");
  state.close();
});

test("runRounds standby (#391 F21): a milestone backlog whose every open issue is CLAIMED by a dead lane's in-progress label does NOT count as work — standby engages instead of churning empty rounds", async () => {
  const forge = new FakeForge();
  forge.ready = []; // nothing dispatchable…
  forge.planReviewCandidates = []; // …nothing awaiting gate⓪…
  forge.planTriageCandidates = []; // …nothing to triage…
  forge.milestoneOpenCounts = [3]; // …but the milestone still LOOKS busy
  // The 2026-07-24 quota-storm residue: every open milestone issue is either claimed (a stale
  // in-progress label left by a lane that died) or latched needs-human. Neither is pool-eligible
  // and no enabled role consumes either, so pre-fix this pinned the probe true and 16 rounds
  // burned paid role sessions on a provably empty pool.
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 144, title: "claimed by a dead lane", labels: [cfg.labels.inProgress], milestone: "M4" },
    { number: 145, title: "also claimed", labels: [cfg.labels.inProgress], milestone: "M4" },
    { number: 207, title: "latched", labels: [cfg.labels.needsHuman], milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop(); // bounded safety net, same as the standby tests above
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg,
    peripherals: allPeripherals(log),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged",
  );
  assert.equal(state.getRound(2), undefined, "no paid role session was burned on the un-dispatchable backlog");
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
    forge,
    state,
    sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }), // milestone UNSET — the triage signal must carry alone
    peripherals: allPeripherals(log),
  });
  // Two rounds: round 1 always opens (idle-round precondition); the probe between rounds 1 and
  // 2 is where the triage signal must carry — round 2 opening with zero standby-wait events
  // proves it did.
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
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
    if (sleepCalls.length === 1) state.addPendingRollback(7, "ready", "dispatch-rollback", new Date(0).toISOString());
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the rollback-retry round 2
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after the idle round 1 — the rollback row is work");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "standby never engaged");
  assert.equal(state.pendingRollbacks().length, 0, "round 2's tick retried and cleared the row — the starvation Codex flagged");
  state.close();
});

test("runRounds standby: stop.onMilestoneComplete completing EXTERNALLY before standby ever engages ends the run immediately — never an eternal probe loop (Codex P2 on PR #150)", async () => {
  const forge = new FakeForge();
  forge.ready = []; // empty board — standby would otherwise engage after the idle first round
  // Loop-top check before round 1: 1 open (no hit). Loop-top check before round 2's gate: 1
  // open (no hit). #374 review (Codex sol-high verify-pass finding 2, P2): waitForDispatchClear's
  // OWN success/fast-path return (nothing ever parked here) never re-checks internally — the
  // call site's UNCONDITIONAL post-return re-check is what catches the completed milestone here,
  // BEFORE standby ever gets a chance to engage (a strict improvement over the pre-finding-2
  // behavior, which only noticed this after standby's own first backoff wait).
  forge.milestoneOpenCounts = [1, 1, 0];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Safety net: if the fix regresses (final stop never re-checked after the recovery-clear
    // path), the loop would probe forever — bail via signal so the stoppedBy assertion below
    // fails instead of hanging.
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({
    forge,
    sleep,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    stop: { onMilestoneComplete: "M4" },
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  assert.equal(result.rounds, 1, "only the idle first round — round 2's gate found the hit before standby ever ran");
  // Sleep 1 = the idle round's own per-tick throttle wait (unrelated to standby) — round 2's gate
  // resolves the milestone hit the INSTANT waitForDispatchClear returns, with no further wait at
  // all: standby never engages, so there is no second (backoff) sleep call this time.
  assert.deepEqual(sleepCalls, [5000]);
  assert.equal(
    deps.state.eventsAfterId(0, ["standby-wait"]).length,
    0,
    "standby never engaged — the recovery-clear re-check resolved it first",
  );
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
      forge,
      state: state2,
      sleep,
      cfg: mkCfg({ round: { standby: { enabled: true } } }),
      peripherals: allPeripherals(log),
    });
    // Resumed round (harvesting, retro) + the fresh round 2 it must NOT standby away (5 phases).
    const stopSafety = boundedStopOnPhase(deps, 7);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.deepEqual(
      log.map((l) => l.phase),
      [
        "harvesting",
        "retro", // the resumed round — no executing in THIS process
        "aligning",
        "architecting",
        "plan_review",
        "harvesting",
        "retro", // round 2: the PO's restart shot
      ],
    );
    assert.equal(result.rounds, 2);
    assert.equal(
      events.filter(([kind]) => kind === "standby-wait").length,
      0,
      "the resumed round is not idle-evidence — standby never engaged before the PO's fresh round",
    );
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
  state.appendEvent = (kind: EventKind, payload: unknown) => {
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
    forge,
    supervisor: sup,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the post-standby round 2
  const result = await runRoundsGuarded(deps);
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
  forge.getReadyIssues = async () => {
    throw new Error("rate limited");
  };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const deps = baseDeps({
    forge,
    state,
    sleep: async () => {},
    cfg: mkCfg({ round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 10); // idle round 1 + the fail-open round 2
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened despite the probe failure — fail-open");
  assert.deepEqual(log.map((l) => l.phase).slice(5), ["aligning", "architecting", "plan_review", "harvesting", "retro"]);
  const err = events.find(
    ([kind, payload]) => kind === "tick-error" && String((payload as { error: string }).error).includes("standby probe failed"),
  );
  assert.ok(err, "a tick-error event naming the standby probe was durably appended");
  assert.equal(
    events.filter(([kind]) => kind === "standby-wait").length,
    0,
    "the failed probe never read as 'nothing to do' — zero backoff waits",
  );
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
    forge,
    state,
    sleep,
    cfg: mkCfg({ round: { milestone: "M4", standby: { enabled: true } } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the idle first round — standby withheld round 2, the milestone had nothing left");
  // Sleep 1 = the idle round's throttle wait; sleep 2 = the first standby backoff step.
  assert.deepEqual(sleepCalls, [5000, 5000]);
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 1, "the second wait WAS a standby wait");
  state.close();
});

// ── #168: RoundDeps.probeLlmReachable passthrough — reaches every tick's TickDeps unchanged ──

test("#168: RoundDeps.probeLlmReachable is threaded into every tick — a pre-parked (llm) episode's ping probe runs during the round's executing phase (park itself persists: a green ping is not a recovery signal)", async () => {
  const { sleep } = mkSleepSpy();
  const state = new State(":memory:");
  // Entered far in the past so the base backoff has long elapsed by the time the round ticks.
  state.enterPark("llm", "rate_limit_error", 1, "2026-07-01T00:00:00.000Z");
  let probeCalls = 0;
  const deps = baseDeps({
    state,
    sleep,
    probeLlmReachable: async () => {
      probeCalls++;
      return true;
    },
  });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(probeCalls >= 1, "the round loop's own tick() calls reached RoundDeps.probeLlmReachable");
  // P1-1: a green ping alone never clears the episode — with no Ready issues there is no
  // canary to launch, so the park (correctly) persists until a real lane proves recovery.
  assert.equal(state.isParked(), true);
  state.close();
});

test("#168: RoundDeps.probeLlmReachable omitted -> a pre-parked (llm) episode is never probed (disabled-consumer rule holds through the round loop too)", async () => {
  const { sleep } = mkSleepSpy();
  const state = new State(":memory:");
  state.enterPark("llm", "rate_limit_error", 1, "2026-07-01T00:00:00.000Z");
  const deps = baseDeps({ state, sleep }); // no probeLlmReachable
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(state.isParked(), true, "never probed -> never auto-resumed");
  assert.equal(state.parkRow("llm")?.probeAttempts, 0);
  state.close();
});

// ── #374 review (Codex sol-high finding 5): isRoundFullyDegraded — pure unit tests ───────────

const mkArtifact = (over: Partial<RoundArtifact> = {}): RoundArtifact => ({
  schemaVersion: 1,
  roundId: 1,
  startedAt: "2026-07-24T00:00:00Z",
  endedAt: "2026-07-24T00:05:00Z",
  dispatches: [],
  merges: [],
  prsOpened: 0,
  prsMerged: 0,
  issuesClosed: 0,
  spendUsd: 0,
  roundBudgetUsd: 30,
  retries: { gatedReentries: 0, gatedReentryCapped: 0, rollbacksRecovered: 0, rollbacksEscalated: 0 },
  reviewRounds: { reviewerFallbackSwitches: 0, reviewerFallbackReverts: 0 },
  escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
  egressSuspects: [],
  handoffs: 0,
  degradedPhases: [],
  roundStops: [],
  retro: { opened: null, degraded: null },
  align: null,
  concerns: [],
  concernsReconciled: [],
  ...over,
});

const degradedPhase = (phase: string): { phase: string; outcome: string; session: string } => ({
  phase,
  outcome: "failed",
  session: "s",
});

// #394 (F23): isRoundFullyDegraded now takes a `ranPhases` set — the phases that ACTUALLY ran a
// session this round (round.ts's own PeripheralStub.ranSession bookkeeping), intersected against
// the cfg-derived "required" set before the final every() check. Every test below that predates
// #394 is testing the cfg-derived requirement logic itself (disabled role / retro cadence /
// harvest needsHuman-gating) — unaffected by the ran-based intersection as long as `ranPhases`
// includes every phase the test's OWN premise assumes ran (all five, by default: these tests are
// about "was it REQUIRED", not "did it RUN"). The dedicated ran-based exclusion tests further
// below are what actually exercise a phase being EXCLUDED for having skipped.
const ALL_PERIPHERAL_PHASES = new Set<PeripheralPhase>(["aligning", "architecting", "plan_review", "harvesting", "retro"]);

test("isRoundFullyDegraded: a TOTAL quota storm (every default-enabled phase degrades) -> true", () => {
  const cfg = mkCfg();
  const totalStorm = mkArtifact({
    degradedPhases: [
      degradedPhase("po-align"),
      degradedPhase("architect"),
      degradedPhase("plan_review"),
      degradedPhase("harvest"),
      degradedPhase("retro"),
    ],
    escalations: { needsHuman: [1], ceiling: 0, driveNoPr: 0 }, // makes harvesting REQUIRED too
  });
  assert.equal(isRoundFullyDegraded(cfg, totalStorm, 1, ALL_PERIPHERAL_PHASES, false), true);

  // A PARTIAL storm (harvesting/retro still fine) is NOT fully degraded.
  const partial = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("plan_review")],
    escalations: { needsHuman: [1], ceiling: 0, driveNoPr: 0 },
  });
  assert.equal(isRoundFullyDegraded(cfg, partial, 1, ALL_PERIPHERAL_PHASES, false), false);
});

test("isRoundFullyDegraded (the retro-only false positive this finding fixes): only retro degrades, everything else fine -> false", () => {
  const cfg = mkCfg();
  const artifact = mkArtifact({ retro: { opened: null, degraded: { branch: "b", title: "t", reason: "push failed" } } });
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false), false);
});

test("isRoundFullyDegraded #374 review (Codex sol-high verify-pass finding 3, P2): artifact.retro.degraded (a POST-session branch-verify/openPR failure) never counts as retro-phase degradation, even when every OTHER required phase genuinely degraded", () => {
  // retro.ts's openProposalPR (the only site that ever sets artifact.retro.degraded) runs ONLY
  // after the retro SESSION already returned outcome:"done" with a validated proposal — this
  // artifact shape is exactly what a real "session succeeded, git push/openPR then failed"
  // round looks like: every OTHER required phase truly failed (a real quota storm elsewhere),
  // but retro's own session was fine. Without this fix, line-122's old `artifact.retro.degraded
  // != null` check would have added "retro" to degradedRoundPhases too, making every required
  // phase appear degraded — a false "fully degraded" verdict manufactured from a signal that
  // PROVES the provider was reachable.
  const cfg = mkCfg();
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("plan_review")],
    retro: { opened: null, degraded: { branch: "b", title: "t", reason: "openPR failed for verified-pushed branch" } },
  });
  assert.equal(
    isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false),
    false,
    "retro's own session succeeded — the round is NOT fully degraded even though three other phases genuinely are",
  );
});

test("isRoundFullyDegraded: a disabled role is EXCLUDED from the required set — degrading everything else still counts as fully degraded", () => {
  const cfg = mkCfg({ roles: { architect: { enabled: false } } });
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("plan_review"), degradedPhase("retro")],
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 }, // harvesting stays unrequired (nothing to brief)
  });
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false), true);
});

test("isRoundFullyDegraded: aligning is EXCLUDED from the required set when BOTH po.enabled and po.poolSelection are off (no session can ever run there)", () => {
  const cfg = mkCfg({ roles: { po: { enabled: false, poolSelection: false } } });
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("architect"), degradedPhase("plan_review"), degradedPhase("retro")],
  });
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false), true);
});

test("isRoundFullyDegraded: harvesting is required ONLY when this round's own artifact shows something to brief (escalations.needsHuman non-empty)", () => {
  const cfg = mkCfg();
  const noNeedsHuman = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("plan_review"), degradedPhase("retro")],
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
  });
  assert.equal(
    isRoundFullyDegraded(cfg, noNeedsHuman, 1, ALL_PERIPHERAL_PHASES, false),
    true,
    "harvesting not required — nothing to brief",
  );

  const withNeedsHumanButHarvestFine = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("plan_review"), degradedPhase("retro")],
    escalations: { needsHuman: [7], ceiling: 0, driveNoPr: 0 },
  });
  assert.equal(
    isRoundFullyDegraded(cfg, withNeedsHumanButHarvestFine, 1, ALL_PERIPHERAL_PHASES, false),
    false,
    "harvesting IS required now (something to brief) but didn't degrade",
  );
});

test("isRoundFullyDegraded: retro is required ONLY on its own cadence turn (roundId % everyNRounds === 0)", () => {
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 5 } } });
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("plan_review")],
  });
  assert.equal(
    isRoundFullyDegraded(cfg, artifact, 7, ALL_PERIPHERAL_PHASES, false),
    true,
    "round 7 isn't retro's turn (7 % 5 !== 0) — retro not required",
  );
  assert.equal(
    isRoundFullyDegraded(cfg, artifact, 10, ALL_PERIPHERAL_PHASES, false),
    false,
    "round 10 IS retro's turn (10 % 5 === 0) — retro required, didn't degrade",
  );
});

test("isRoundFullyDegraded: every role disabled (nothing was even configured to run a session) -> false, never a degenerate true", () => {
  const cfg = mkCfg({
    roles: {
      po: { enabled: false, poolSelection: false },
      architect: { enabled: false },
      verificationPlanReviewer: { enabled: false },
      harvest: { enabled: false },
      retro: { enabled: false },
    },
  });
  const artifact = mkArtifact();
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false), false);
});

// ── #394 (F23): a phase configured to run but that SKIPPED this round (no session dispatched —
//    e.g. architect/plan_review hitting an EMPTY round pool) is evidence of nothing, and must be
//    EXCLUDED from the required set, never silently treated as an unfulfilled requirement. ──────

test("isRoundFullyDegraded (F23 bug this fixes): an EMPTY-POOL round where architect/plan_review/harvest structurally SKIPPED (never ran a session) but aligning/retro genuinely degraded -> fully degraded, true", () => {
  const cfg = mkCfg();
  // The exact dogfood scenario (#394's own Why section): a weekly-limit storm with an empty
  // pool. Only aligning and retro attempted sessions (both degraded); architect/plan_review
  // skipped outright (no candidates/pool members — no session, no degrade event either); harvest
  // skipped too (nothing to brief, escalations.needsHuman is empty).
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("retro")],
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
  });
  const ranPhases = new Set<PeripheralPhase>(["aligning", "retro"]); // architecting/plan_review/harvesting never ran
  assert.equal(
    isRoundFullyDegraded(cfg, artifact, 1, ranPhases, false),
    true,
    "every phase that ACTUALLY ran (aligning, retro) degraded — the skipped phases are not held against it",
  );
});

test("isRoundFullyDegraded: the OLD (pre-#394) bug reproduced — with the full cfg-required set treated as ran regardless of evidence, the same empty-pool storm would NEVER be fully degraded", () => {
  const cfg = mkCfg();
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("retro")],
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
  });
  // Architecting/plan_review are cfg-required (enabled) but never actually ran this round — if a
  // caller (bug) claimed they ran anyway, only aligning/retro would ever land in degradedPhases,
  // so requiredPhases.every() would be permanently false — exactly the bug #394 fixes.
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ALL_PERIPHERAL_PHASES, false), false);
});

test("isRoundFullyDegraded: architect DID run and degrade this round (real evidence, not skipped) -> counts toward fully-degraded normally", () => {
  const cfg = mkCfg();
  const artifact = mkArtifact({
    degradedPhases: [degradedPhase("po-align"), degradedPhase("architect"), degradedPhase("retro")],
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
  });
  const ranPhases = new Set<PeripheralPhase>(["aligning", "architecting", "retro"]);
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ranPhases, false), true);
});

test("isRoundFullyDegraded: no phase ran ANYTHING this round -> false, never a degenerate true from an empty intersection", () => {
  const cfg = mkCfg();
  const artifact = mkArtifact();
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, new Set(), false), false);
});

// ── #394 gate② round 2 (Codex sol-high BLOCK finding, P2): wasResumed short-circuits to false,
//    unconditionally, before any required/ran/degraded computation runs — a round picked up
//    already in-progress has structurally incomplete evidence, so it is simply never judged. ──

test("isRoundFullyDegraded (#394 gate② round 2 fix): wasResumed=true -> ALWAYS false, even for a total quota storm that would otherwise be fully degraded", () => {
  const cfg = mkCfg();
  const totalStorm = mkArtifact({
    degradedPhases: [
      degradedPhase("po-align"),
      degradedPhase("architect"),
      degradedPhase("plan_review"),
      degradedPhase("harvest"),
      degradedPhase("retro"),
    ],
    escalations: { needsHuman: [1], ceiling: 0, driveNoPr: 0 },
  });
  // Sanity: this exact artifact/ranPhases pair IS fully degraded when wasResumed is false —
  // proves the true branch below isn't vacuously passing on some OTHER disqualifying reason.
  assert.equal(isRoundFullyDegraded(cfg, totalStorm, 1, ALL_PERIPHERAL_PHASES, false), true);
  assert.equal(
    isRoundFullyDegraded(cfg, totalStorm, 1, ALL_PERIPHERAL_PHASES, true),
    false,
    "wasResumed=true short-circuits to false regardless of how thoroughly everything else degraded",
  );
});

test("isRoundFullyDegraded (#394 gate② round 2 fix): wasResumed=true reproduces the Codex-traced at-threshold-1 scenario — earlier phases succeeded, only retro (post-resume) is visible and degraded, still NOT fully degraded", () => {
  const cfg = mkCfg();
  // aligning/architecting/plan_review are NOT in degradedPhases (they succeeded, pre-restart, in
  // a process this one never observed) — only retro shows up, because only retro ran IN THIS
  // PROCESS. Without the wasResumed guard, ranPhases={retro} intersected against requiredPhases
  // would make this read as fully degraded (the exact false-park Codex traced).
  const artifact = mkArtifact({ degradedPhases: [degradedPhase("retro")] });
  const ranPhases = new Set<PeripheralPhase>(["retro"]); // only what THIS process actually ran
  assert.equal(isRoundFullyDegraded(cfg, artifact, 1, ranPhases, true), false);
});

// ── #374: the empty-spin breaker + the round-opening gate (F16: 145 empty rounds, no bound) ──

/** #374 review (Codex sol-high finding 5): isRoundFullyDegraded requires EVERY peripheral phase
 *  the round was actually configured to run a session for to degrade, not any single one — so a
 *  test simulating F16's total-outage scenario must degrade ALL FIVE phases. Note the plan_review
 *  fake's "plan-review-escalated" event ALSO populates artifact.escalations.needsHuman (finding
 *  4: it's dual-role — needs-human AND degraded-phase), which is what makes harvesting REQUIRED
 *  too (isRoundFullyDegraded only requires it when there's something to brief) — so harvesting
 *  degrades here as well, matching a genuine total-storm scenario where nothing succeeds. Each
 *  stub appends the SAME durable event round-artifact.ts's degradedPhases already scans for.
 *  Shared by both #374 tests below. */
function mkFullyDegradingPeripherals(log: Array<{ phase: PeripheralPhase; marker: string | null }>, state: State) {
  const degrade = (phase: PeripheralPhase, kind: EventKind, payload: (roundId: number) => Record<string, unknown>) => ({
    async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
      log.push({ phase, marker: ctx.marker });
      state.appendEvent(kind, payload(ctx.roundId));
      // #394 (F23): every phase here genuinely "ran" (it dispatched the fake session whose
      // degrade event is appended above) — isRoundFullyDegraded now requires this evidence.
      return { marker: `${phase}-r${ctx.roundId}`, ranSession: true };
    },
  });
  return {
    aligning: degrade("aligning", "po-degraded", (round_id) => ({ round_id, outcome: "failed", session: `po-${round_id}` })),
    architecting: degrade("architecting", "architect-degraded", (round_id) => ({
      round_id,
      outcome: "failed",
      session: `arch-${round_id}`,
    })),
    // #374 review (Codex sol-high verify-pass finding 3, P1): `origin: "session-failure"` is
    // REQUIRED now — round-artifact.ts's assembler only counts a plan-review-escalated event
    // toward degradedPhases when the emitter tagged it as a genuine session failure (never a
    // legitimate cycle-exhausted escalation, and never a payload with no origin at all — see
    // round-artifact.ts's own doc). Omitting it here would silently stop this fixture from ever
    // registering as a degraded phase, breaking every test built on mkFullyDegradingPeripherals's
    // "all five phases genuinely failed" premise.
    plan_review: degrade("plan_review", "plan-review-escalated", (round_id) => ({
      round_id,
      issue: 1,
      reason: "session failed twice",
      origin: "session-failure",
    })),
    harvesting: degrade("harvesting", "harvest-degraded", (round_id) => ({ round_id, outcome: "failed", session: `harvest-${round_id}` })),
    retro: degrade("retro", "retro-degraded", (round_id) => ({ round_id, outcome: "failed", session: `retro-${round_id}` })),
  };
}

test("runRounds #374: N consecutive degraded, dispatch-empty rounds force a park; round 3 is WITHHELD (no unbounded round churn) until a human intervenes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge(); // empty board — never any dispatch, this test is about degrade-only churn
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    // Simulates F16's own root cause: an UNCLASSIFIED systemic role-session failure (a text
    // classifyEnvFailure simply doesn't recognize) — EVERY peripheral phase "degrades" every
    // round (isRoundFullyDegraded requires all of them, see mkFullyDegradingPeripherals's doc).
    const degradingPeripherals = mkFullyDegradingPeripherals(log, state);
    // Polls the durable park state itself (never a magic sleep-call COUNT, which is timing-
    // fragile — the exact number of sleep calls per round can shift with unrelated engine
    // changes): the very FIRST sleep call observed AFTER the breaker has parked the engine
    // flips KILL_SWITCH — same "operator intervenes mid-wait" idiom the standby KILL_SWITCH
    // test above uses, just triggered on a robust condition instead of a call-count.
    const sleep = async (): Promise<void> => {
      if (state.isParked()) writeFileSync(join(dir, "KILL_SWITCH"), "");
    };
    const deps = baseDeps({
      forge,
      state,
      sleep,
      cfg: mkCfg({ round: { emptySpin: { consecutiveDegradedRoundsThreshold: 2 } } }),
      peripherals: degradingPeripherals,
    });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(result.rounds, 2, "rounds 1-2 degraded and closed; round 3 was withheld, never opened/closed");
    // allPeripherals(log) logs EVERY phase, not just aligning — 2 full rounds x 5 phases each.
    // Round 3 never opened its phases at all (no 11th entry, no round-3-tagged marker below).
    assert.equal(log.length, 10, "exactly 2 full rounds ran their 5 phases each — round 3 never opened");
    assert.equal(
      log.filter((l) => l.phase === "aligning").length,
      2,
      "exactly 2 aligning attempts happened — round 3's aligning stub never ran",
    );
    const emptySpinEvents = state.eventsAfterId(0, ["empty-spin-park"]);
    assert.equal(emptySpinEvents.length, 1, "the breaker fires EXACTLY once, at N=2 — never re-fires every round after");
    assert.deepEqual(emptySpinEvents[0]!.payload, { consecutiveDegradedRounds: 2, threshold: 2, roundId: 2 });
    assert.equal(state.isParked(), true);
    assert.equal(state.parkRow("llm")?.source, "llm");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** #394 (F23, AC3): simulates the ACTUAL dogfood scenario — a weekly-limit storm with an EMPTY
 *  round pool. aligning/retro attempt sessions every round and degrade (the provider itself is
 *  down); architect/plan_review/harvest structurally SKIP (no candidates/pool members/needs-
 *  human — round.ts's own runPeripheral never sees a `ranSession: true` from them, exactly like
 *  the real stubs' early-return skip paths). Under the PRE-#394 cfg-only "required" computation
 *  this round would NEVER register as fully degraded (architect/plan_review are cfg-enabled but
 *  never appear in degradedPhases either, since they never ran) — the empty-spin breaker would
 *  spin forever. This fixture reproduces exactly that shape. */
function mkEmptyPoolWeeklyLimitStormPeripherals(
  log: Array<{ phase: PeripheralPhase; marker: string | null }>,
  state: State,
): Partial<Record<PeripheralPhase, PeripheralStub>> {
  const degrades = (phase: PeripheralPhase, kind: EventKind, payload: (roundId: number) => Record<string, unknown>) => ({
    async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
      log.push({ phase, marker: ctx.marker });
      state.appendEvent(kind, payload(ctx.roundId));
      return { marker: `${phase}-r${ctx.roundId}`, ranSession: true };
    },
  });
  const skips = (phase: PeripheralPhase) => ({
    async run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }) {
      log.push({ phase, marker: ctx.marker });
      // No session dispatched, no degrade event — the real architect.ts/plan-review.ts/
      // harvest.ts early-return shape for "nothing to do this round" (empty pool / nothing to
      // brief). ranSession omitted -> false, per PeripheralStub's own documented default.
      return { marker: `${phase}-r${ctx.roundId}` };
    },
  });
  return {
    aligning: degrades("aligning", "po-degraded", (round_id) => ({ round_id, outcome: "failed", session: `po-${round_id}` })),
    architecting: skips("architecting"),
    plan_review: skips("plan_review"),
    harvesting: skips("harvesting"),
    retro: degrades("retro", "retro-degraded", (round_id) => ({ round_id, outcome: "failed", session: `retro-${round_id}` })),
  };
}

test("runRounds #394 (F23, AC3): a weekly-limit storm with an EMPTY pool — architect/plan_review/harvest structurally skip every round, but aligning/retro genuinely degrade — the breaker still fires within N rounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge(); // empty board — nothing dispatches, nothing for architect/plan_review/harvest to see
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const emptyPoolPeripherals = mkEmptyPoolWeeklyLimitStormPeripherals(log, state);
    const sleep = async (): Promise<void> => {
      if (state.isParked()) writeFileSync(join(dir, "KILL_SWITCH"), "");
    };
    const deps = baseDeps({
      forge,
      state,
      sleep,
      cfg: mkCfg({ round: { emptySpin: { consecutiveDegradedRoundsThreshold: 2 } } }),
      peripherals: emptyPoolPeripherals,
    });
    // gate② round 3 (Codex sol-high BLOCK finding, P2): a HARD bound, independent of the
    // KILL_SWITCH-on-park sleep above. If the F23 ranPhases intersection this test exercises
    // regresses, the breaker never parks, `state.isParked()` never goes true, the sleep above
    // never writes KILL_SWITCH, and `runRounds` — an empty board with no other stop condition
    // configured — spins forever (verified by hand: reverting the fix and re-running this exact
    // test previously required killing the process manually; see the PR's own revert-experiment
    // notes). `boundedStopOnPhase` (used throughout this file as exactly this kind of test-safety
    // net) trips a graceful `signalled` stop after a generous 30 phase-visits — 6 full rounds'
    // worth, three times the 2 rounds a HEALTHY run needs to park — so a real regression fails
    // this test's own assertions in well under a second instead of hanging the suite/CI.
    const stopSafety = boundedStopOnPhase(deps, 30);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(
      result.stoppedBy,
      "kill-switch",
      "expected the empty-spin breaker to park (KILL_SWITCH). Got 'signal' instead, meaning the " +
        "30-phase-visit SAFETY BOUND tripped first — the breaker never fired at all. This is the " +
        "F23 regression itself: re-check isRoundFullyDegraded's ranPhases intersection.",
    );
    assert.equal(result.rounds, 2, "rounds 1-2 both count as fully degraded — round 3 withheld, never opened");
    const emptySpinEvents = state.eventsAfterId(0, ["empty-spin-park"]);
    assert.equal(
      emptySpinEvents.length,
      1,
      "the breaker fires — under the pre-#394 cfg-only required-set computation this would NEVER fire " +
        "(architect/plan_review are cfg-enabled but skip every round, so they'd never join degradedPhases either)",
    );
    assert.deepEqual(emptySpinEvents[0]!.payload, { consecutiveDegradedRounds: 2, threshold: 2, roundId: 2 });
    assert.equal(state.isParked(), true);
    assert.equal(state.parkRow("llm")?.source, "llm");
    // architecting/plan_review/harvesting genuinely ran their (skip) stub each round — the phase
    // sequence still visits them — but never contributed a degrade event or ranSession:true.
    assert.equal(log.filter((l) => l.phase === "architecting").length, 2);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds (#394 gate② round 2, Codex sol-high BLOCK finding, P2): at threshold 1, a round RESUMED exactly at 'executing' (earlier phases succeeded in a process this one never observed; nothing was in flight to drain) — only harvesting/retro run here, retro alone degrades — does NOT park a healthy engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    // Seed a round that already advanced PAST aligining/architecting/plan_review and INTO
    // "executing" before this runRounds() call ever looks at it — the exact "picked up already
    // in-progress" shape `deps.state.openRound()` reports as `wasResumed`. Resuming exactly AT
    // "executing" (not past it) is the precise shape that makes `ranExecuting` true in THIS
    // process too (a drain-only pass — freshBatch=false, zero active workers to drain since none
    // were ever dispatched before the simulated restart — `workersThisRound` stays 0), which is
    // what lets roundDegraded's OTHER guards (`ranExecuting && workersThisRound === 0`) pass at
    // all; resuming further along (e.g. directly at "harvesting"/"retro") would skip `executing`
    // in this process entirely and `ranExecuting` would stay false, masking the bug behind an
    // unrelated guard instead of actually exercising the fix. This process's phase loop starts at
    // idx=SEQUENCE.indexOf("executing"), so aligining/architecting/plan_review are NEVER visited
    // here — only harvesting and retro are, matching the Codex-traced scenario exactly: earlier
    // phases are invisible to THIS process's ranPhases, whether they succeeded or not.
    const state = new State(join(dir, "sapwood.sqlite"));
    const round = state.startRound("2026-07-27T00:00:00.000Z");
    state.advanceRoundPhase(round.round_id, "executing", "2026-07-27T00:01:00.000Z");

    const forge = new FakeForge(); // empty board — zero dispatch either way, zero needs-human -> harvest skips
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const degradingPeripherals = mkFullyDegradingPeripherals(log, state); // only .harvesting/.retro are invoked this run
    const deps = baseDeps({
      forge,
      state,
      // threshold 1: the EXACT configuration the gate② review traced as the one that exposes
      // this bug — with the old (retracted) "bounded to one strike" reasoning, threshold 1 IS
      // the whole breaker, so a single resumed-round false strike parks immediately.
      cfg: mkCfg({ round: { emptySpin: { consecutiveDegradedRoundsThreshold: 1 } } }),
      peripherals: degradingPeripherals,
    });
    // Stop the run right after round 1's two visited peripheral phases (harvesting, retro) —
    // round 1 still runs to completion (close + the roundDegraded/park computation) in THIS
    // iteration before `signalled` is checked at the top of the next one, so this observes
    // exactly "did round 1's close-time computation park the engine", without ever letting
    // round 2 open. ("executing" itself never calls onRoundPhase — see runPeripheral's own call
    // site — so it doesn't count toward this cap.)
    const stopSafety = boundedStopOnPhase(deps, 2);
    const result = await runRoundsGuarded(deps);
    stopSafety();

    assert.equal(result.stoppedBy, "signal", "the bounded stop fired after round 1's own two visited peripheral phases, as designed");
    assert.deepEqual(
      log.map((l) => l.phase),
      ["harvesting", "retro"],
      "only harvesting/retro ran in this process — aligining/architecting/plan_review were never re-entered",
    );
    assert.equal(
      state.eventsAfterId(0, ["empty-spin-park"]).length,
      0,
      "#394 gate② round 2 fix: a resumed round is never judged fully-degraded, so it contributes " +
        "no strike at all — WITHOUT this fix, threshold 1 would park here on retro's lone degrade, " +
        "even though aligining/architecting/plan_review genuinely succeeded before this process ever started",
    );
    assert.equal(state.isParked(), false, "the engine is healthy — nothing should be parked");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #374: the round-opening gate resumes via the EXISTING probe path — a green probeLlmReachable ping arms round 3 to open again (no unbounded round churn, no need for a human)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge();
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const degradingPeripherals = mkFullyDegradingPeripherals(log, state);
    let probeCalls = 0;
    // A CONTROLLED, advancing fake clock — required here (unlike test 1 above, which exits via
    // KILL_SWITCH before any wall-clock-based check matters): the gate's probeDueWithHint check
    // is genuinely wall-clock-based, and a REAL Date.now() paired with an instantly-resolving
    // fake `sleep` would busy-loop for real backoff seconds (30s+) waiting for elapsed time that
    // never actually passes — worse, that busy microtask loop starves Node's OWN timer phase,
    // hanging the test process outright (observed while developing this test). Advancing the
    // fake clock BY the exact sleep duration requested makes each wait "elapse" instantly in
    // real time while still satisfying the real backoff arithmetic after a small, bounded number
    // of iterations.
    let simulatedMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = (): Date => new Date(simulatedMs);
    const sleep = async (ms: number): Promise<void> => {
      simulatedMs += ms;
    };
    const deps = baseDeps({
      forge,
      state,
      now,
      sleep,
      tickIntervalSec: 1,
      cfg: mkCfg({
        round: { emptySpin: { consecutiveDegradedRoundsThreshold: 2 } },
        envFailure: { probeBackoffBaseSec: 1, probeBackoffMaxSec: 5 },
      }),
      peripherals: degradingPeripherals,
      // Fails the first 2 pings (still "quota exhausted"), then succeeds — the SAME probe path
      // conductor.ts's worker-lane canary uses, reused here for the round-opening gate.
      probeLlmReachable: async () => {
        probeCalls++;
        return probeCalls > 2;
      },
    });
    const stopSafety = boundedStopOnPhase(deps, 15); // rounds 1-2 degrade (park), round 3 opens once the probe clears
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.ok(result.rounds >= 3, `round 3 opened once the probe succeeded (got ${result.rounds})`);
    assert.ok(probeCalls >= 3, "the gate actually re-probed until it got a green light");
    const parkProbeEvents = state.eventsAfterId(0, ["park-probe"]).filter((e) => (e.payload as { source?: string }).source === "llm");
    assert.ok(
      parkProbeEvents.some((e) => (e.payload as { success?: boolean }).success === true),
      "a successful park-probe event was recorded before round 3 opened",
    );
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #374 review (Codex sol-high verify-pass finding 2, P2): stop.onMilestoneComplete completing EXTERNALLY while llm-parked ends the run cleanly — waitForDispatchClear never waits forever for a recovery that may never come, and never opens a pointless post-recovery round", async () => {
  const forge = new FakeForge();
  forge.ready = []; // round 1 has no dispatch work — opens unconditionally, closes idle
  // Loop-top check before round 2 (the `!round` branch's OWN checkFinalMilestone, run BEFORE
  // waitForDispatchClear): 1 (no hit). Then waitForDispatchClear's own re-check, once per wait
  // iteration: 1 (still no hit) on the first iteration, then 0 (hit) on the second — the
  // milestone completes DURING the wait, not before it.
  forge.milestoneOpenCounts = [1, 1, 0];
  const state = new State(":memory:");
  // Pre-seed an OPEN llm park with NO probeLlmReachable wired (disabled-consumer rule, #168) —
  // the episode can never auto-clear via ping, simulating a provider that stays down. Without
  // this fix, waitForDispatchClear's own loop has no notion of the run's final stop condition
  // and would spin on ceiling/park state alone forever, even though the run is already,
  // independently, done.
  state.enterPark("llm", "quota exhausted", null, "2026-07-24T00:00:00.000Z");
  const sleepCalls: number[] = [];
  let stop = (): void => {};
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Safety net: if the fix regresses (final stop never re-checked inside the wait loop), this
    // loop spins forever waiting for a park that never clears — bail via signal so the
    // stoppedBy/rounds assertions below fail instead of hanging the suite.
    if (sleepCalls.length >= 5) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 1, stop: { onMilestoneComplete: "M4" } });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  assert.equal(result.rounds, 1, "only round 1 closed — round 2 never opened once the milestone was noticed mid-wait");
  assert.equal(state.isParked(), true, "the run stopped WITHOUT the park ever clearing — never waited for recovery");
  state.close();
});

test("runRounds #374 review (Codex sol-high verify-pass finding 2, P2): a milestone that completes EXACTLY on the recovery-CLEAR iteration (the green probeLlmReachable ping that arms round 3 back open) still stops the run — never opens the pointless post-recovery round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const forge = new FakeForge();
    const state = new State(join(dir, "sapwood.sqlite"));
    const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
    const degradingPeripherals = mkFullyDegradingPeripherals(log, state);
    let probeCalls = 0;
    // Same fixture as "the round-opening gate resumes via the EXISTING probe path" above: rounds
    // 1-2 fully degrade -> the empty-spin breaker parks (llm); the round-opening gate's own probe
    // fails twice, then succeeds on the 3rd attempt, which is exactly waitForDispatchClear's
    // SUCCESS/fast-path return (ceiling clear + park clear/green-light, line ~884 in round.ts) —
    // the ONE iteration that does NOT run the function's own internal final-stop re-check (that
    // check deliberately only fires on an iteration about to actually WAIT, never on this
    // already-clear path — see its doc). #374 review (Codex sol-high verify-pass finding 2, P2):
    // tying countOpenIssuesInMilestone's answer to the SAME `probeCalls > 2` condition the probe
    // itself uses means the milestone completes AT THE EXACT SAME MOMENT recovery clears —
    // precisely the race this finding closes, rather than merely "sometime before or after".
    let simulatedMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = (): Date => new Date(simulatedMs);
    const sleep = async (ms: number): Promise<void> => {
      simulatedMs += ms;
    };
    forge.countOpenIssuesInMilestone = async (): Promise<number> => (probeCalls > 2 ? 0 : 1);
    const deps = baseDeps({
      forge,
      state,
      now,
      sleep,
      tickIntervalSec: 1,
      cfg: mkCfg({
        round: { emptySpin: { consecutiveDegradedRoundsThreshold: 2 } },
        envFailure: { probeBackoffBaseSec: 1, probeBackoffMaxSec: 5 },
      }),
      peripherals: degradingPeripherals,
      stop: { onMilestoneComplete: "M4" },
      probeLlmReachable: async () => {
        probeCalls++;
        return probeCalls > 2;
      },
    });
    const stopSafety = boundedStopOnPhase(deps, 15);
    const result = await runRoundsGuarded(deps);
    stopSafety();
    assert.equal(result.stoppedBy, "stop-condition");
    assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
    assert.equal(result.rounds, 2, "round 3 NEVER opened — the milestone hit was caught the instant recovery cleared");
    // The probe genuinely succeeded (recovery WAS real) — this proves the run stopped because of
    // the milestone catch, not because the probe itself somehow never got a green light.
    assert.ok(probeCalls >= 3, "the gate actually re-probed until it got a green light");
    const parkProbeEvents = state.eventsAfterId(0, ["park-probe"]).filter((e) => (e.payload as { source?: string }).source === "llm");
    assert.ok(
      parkProbeEvents.some((e) => (e.payload as { success?: boolean }).success === true),
      "a successful park-probe event was still recorded — recovery cleared, but the run stopped anyway",
    );
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #212: round-pool dispatch scoping, round-close label cleanup, removeLabel containment ────

test("runRounds #212: dispatch is restricted to pool-labelled Ready issues — an approved Ready issue outside the pool is never dispatched", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 3 } });
  forge.ready = [
    { number: 1, title: "pooled", labels: [cfg.labels.roundPool] },
    { number: 2, title: "not pooled", labels: [] },
  ];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg, poolLabel: cfg.labels.roundPool });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1], "only the pool-labelled issue dispatched — #2 was left untouched in Ready");
  deps.state.close();
});

test("runRounds #379 (gate② P1): a round whose pool-label reconcile TOTALLY failed dispatches NOTHING — a stale pool label left over from an earlier round must not pass the executing filter as if this round had selected it", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 3 } });
  // The exact residual the reviewer named: a Ready issue still carrying LAST round's pool label
  // (its removal is what reconcilePoolLabels never reaches once every add write fails), which
  // PoolScopedForge — a LIVE label read, not the selection result — would otherwise dispatch.
  forge.ready = [{ number: 1, title: "stale pool member", labels: [cfg.labels.roundPool] }];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg, poolLabel: cfg.labels.roundPool });
  // Stand in for align.ts's runPoolSelection on the total-failure path: it records exactly this
  // durable event for this round and returns an empty pool.
  deps.peripherals = {
    aligning: {
      async run(ctx) {
        deps.state.appendEvent("pool-labels-failed", { round_id: ctx.roundId, attempted: 2, error: "simulated forge failure" });
        return { marker: `align-r${ctx.roundId}` }; // #403 (F25): PeripheralStub.run returns a marker STRING, never null
      },
    },
  };
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [], "the round parked — no dispatch off a pool this round never actually selected");
  deps.state.close();
});

test("runRounds #379 (gate② P1): the dispatch block is scoped to the round that failed — a LATER round with a healthy pool dispatches normally", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 3 } });
  forge.ready = [{ number: 1, title: "pooled", labels: [cfg.labels.roundPool] }];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg, poolLabel: cfg.labels.roundPool });
  // Round 1 fails its pool-label reconcile; round 2 succeeds (no event).
  deps.peripherals = {
    aligning: {
      async run(ctx) {
        if (ctx.roundId === 1) {
          deps.state.appendEvent("pool-labels-failed", { round_id: ctx.roundId, attempted: 1, error: "simulated forge failure" });
        }
        return { marker: `align-r${ctx.roundId}` }; // #403 (F25): PeripheralStub.run returns a marker STRING, never null
      },
    },
  };
  const stopSafety = boundedStopOnPhase(deps, 11); // ~2 rounds of phases
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1], "round 2's dispatch is unaffected by round 1's failure event");
  deps.state.close();
});

test("runRounds #212: poolLabel unset -> no pool scoping at all, every approved Ready issue dispatches (today's behavior, unchanged — the opt-in default)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 3 } });
  forge.ready = [
    { number: 1, title: "a", labels: [] },
    { number: 2, title: "b", labels: [] },
  ];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg }); // poolLabel NOT set
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues.sort(), [1, 2], "no pool scoping configured — both dispatch");
  deps.state.close();
});

test("PoolScopedForge #212: filters LIVE label state on every call — a dead-lane requeue that keeps its pool label reappears as dispatchable, with no new label write (persists through dispatch, #212 lifecycle item 2)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  forge.ready = [{ number: 1, title: "t", labels: [cfg.labels.roundPool] }];
  const scoped = new PoolScopedForge(forge, cfg.labels.roundPool);
  assert.deepEqual(
    (await scoped.getReadyIssues()).map((i) => i.number),
    [1],
  );
  await forge.claimIssue(1); // dispatched — leaves the Ready column, same as real GitHub
  assert.deepEqual(await scoped.getReadyIssues(), [], "claimed -> no longer Ready");
  // A dead-lane requeue puts it back in Ready — its pool label was never touched by claim, so
  // it's still there with zero new label writes.
  forge.ready = [{ number: 1, title: "t", labels: [cfg.labels.roundPool] }];
  assert.deepEqual(
    (await scoped.getReadyIssues()).map((i) => i.number),
    [1],
    "reappears as pool-scoped-dispatchable — no re-label needed",
  );
  assert.deepEqual(forge.addLabelCalls, [], "PoolScopedForge itself never writes a label — read-only filtering");
});

test("runRounds #212 (gate② P1-3, superseding gate① F2): round close clears the pool label from EVERY still-open member — including one actually DISPATCHED this round (no exemption) and one that moved OFF Ready mid-round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 1 } }); // cap 1 -> only #1 dispatches
  // #212 gate② P1-3: gate① F2's "dispatched this round" exemption is dropped entirely — a
  // dispatched-but-still-open issue (in review, not yet merged by round close) is NOT exempt.
  // "Persists through dispatch" covers only a SAME-ROUND dead-lane requeue (PoolScopedForge
  // re-filters live label state on every dispatch tick, so a requeue mid-round never needs
  // re-labelling); a LATER round must re-select it, never inherit a stale label.
  const dispatchedStillOpen = { number: 1, title: "dispatched this round, PR still open", labels: [cfg.labels.roundPool] };
  const stayReadyPooled = { number: 2, title: "stay pooled but undispatched", labels: [cfg.labels.roundPool] };
  // A pool member that left Ready mid-round for a reason OTHER than this round's own dispatch
  // (human board action, milestone edit, gate⓪ revoking plan:approved, ...) — open but no
  // longer in forge.ready. The sweep is over the FULL open backlog (listOpenIssues()), not just
  // getReadyIssues(), so this gets cleared too.
  const offReadyPooled = { number: 3, title: "moved off Ready mid-round, still open", labels: [cfg.labels.roundPool] };
  forge.ready = [dispatchedStillOpen, stayReadyPooled];
  forge.openIssues = [dispatchedStillOpen, stayReadyPooled, offReadyPooled];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg, poolLabel: cfg.labels.roundPool });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(sup.dispatchedIssues, [1]);
  assert.ok(
    !dispatchedStillOpen.labels.includes(cfg.labels.roundPool),
    "the dispatched-but-still-open member's label is ALSO cleared — no exemption",
  );
  assert.ok(!stayReadyPooled.labels.includes(cfg.labels.roundPool), "the still-Ready undispatched member's label was cleared");
  assert.ok(!offReadyPooled.labels.includes(cfg.labels.roundPool), "the off-Ready undispatched member's label was cleared too");
  assert.deepEqual(
    forge.removeLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2, 3],
    "removeLabel fired for every still-open pool member, with zero exemptions",
  );
  assert.ok(
    forge.removeLabelCalls.every(([, l]) => l === cfg.labels.roundPool),
    "only the pool label is ever removed",
  );
  deps.state.close();
});

test("runRounds #212 (gate② P2-5): a removeLabel failure on ONE issue doesn't abort the round-close sweep — the remaining pool members still get cleared", async () => {
  const { sleep } = mkSleepSpy();
  const cfg = mkCfg();
  class FlakyRemoveForge extends FakeForge {
    override async removeLabel(n: number, l: string): Promise<void> {
      // Record the ATTEMPT (base FakeForge.removeLabel only records on its own body, which a
      // pre-throw override never reaches) before deciding whether to fail it — the test asserts
      // on removeLabelCalls to prove #2 was still attempted after #1 failed.
      this.removeLabelCalls.push([n, l]);
      if (n === 1) throw new Error("simulated forge failure removing #1");
      for (const issue of [...this.ready, ...this.openIssues]) {
        if (issue.number === n) issue.labels = issue.labels.filter((x) => x !== l);
      }
    }
  }
  const forge = new FlakyRemoveForge();
  forge.ready = [];
  forge.openIssues = [
    { number: 1, title: "removal fails", labels: [cfg.labels.roundPool] },
    { number: 2, title: "removal succeeds", labels: [cfg.labels.roundPool] },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const deps = baseDeps({ forge, state, sleep, cfg, poolLabel: cfg.labels.roundPool });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(
    forge.removeLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2],
    "both issues were attempted — the first one's failure did not skip the second",
  );
  const issue2 = forge.openIssues.find((i) => i.number === 2);
  assert.ok(!issue2!.labels.includes(cfg.labels.roundPool), "the SECOND issue's label was actually cleared despite the first failing");
  assert.ok(
    events.some(([kind, payload]) => kind === "tick-error" && String((payload as { error: string }).error).includes("#1")),
    "the #1 failure was recorded as a tick-error, never silently swallowed and never aborting the sweep",
  );
  state.close();
});

test("runRounds #212: poolLabel unset -> round close never calls removeLabel at all (no pool feature configured, nothing to clear)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const cfg = mkCfg();
  forge.ready = [{ number: 1, title: "t", labels: [cfg.labels.roundPool] }];
  const sup = new AutoCompleteSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, cfg }); // poolLabel NOT set
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.deepEqual(forge.removeLabelCalls, []);
  deps.state.close();
});

test("removeRoundPoolLabel #212: refuses to remove any label other than cfg.labels.roundPool — the engine may never forge a human-release signature (needs-human/blocked/plan:approved/verify:n/a are removable by a human only, #147 invariant)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  await assert.rejects(() => removeRoundPoolLabel(forge, cfg, 1, cfg.labels.needsHuman), /refusing to remove/);
  await assert.rejects(() => removeRoundPoolLabel(forge, cfg, 1, cfg.labels.blocked), /refusing to remove/);
  await assert.rejects(() => removeRoundPoolLabel(forge, cfg, 1, cfg.labels.planApproved), /refusing to remove/);
  await assert.rejects(() => removeRoundPoolLabel(forge, cfg, 1, cfg.labels.verifyNa), /refusing to remove/);
  await assert.rejects(() => removeRoundPoolLabel(forge, cfg, 1, "some-arbitrary-label"), /refusing to remove/);
  assert.deepEqual(forge.removeLabelCalls, [], "not one rejected call ever reached the forge");
  await removeRoundPoolLabel(forge, cfg, 1, cfg.labels.roundPool); // the ONE allowed label
  assert.deepEqual(forge.removeLabelCalls, [[1, cfg.labels.roundPool]]);
});

// ── #212: standby probe residual (round.ts:426-427 pre-fix) ────────────────────────────────

test("runRounds standby (#212 probe residual fix): a milestone whose open issues ALL carry a human-hold label no longer counts as work — standby engages instead of opening empty rounds forever", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneOpenCounts = [2];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 1, title: "held a", labels: [cfg.labels.needsHuman], milestone: "M4" },
    { number: 2, title: "held b", labels: [cfg.labels.blocked], milestone: "M4" },
    // #397: the class-6 fence is unconsumable for exactly the same reason (every triage/review/
    // pool predicate excludes it), so it must not pin the probe true either. It used to be
    // covered incidentally by borrowing needs-human; under its own name the probe says so.
    { number: 3, title: "fenced", labels: [cfg.labels.planless], milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  // Standby, correctly engaged here, never opens a second round on its own (an all-held
  // milestone stays all-held) — boundedStopOnPhase's phase-count net never fires (no further
  // peripheral phase ever runs), so this test needs its OWN bounded exit from inside the
  // backoff loop, same idiom as the #127 gate② F2 tests above.
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — an all-held milestone no longer pins the probe true",
  );
  assert.ok(forge.milestoneQueries.includes("M4"), "the cheap count was still checked first");
  state.close();
});

test("runRounds standby (#212 probe residual fix): a mixed milestone (one held, one not) still counts as work — no standby", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneOpenCounts = [2];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 1, title: "held", labels: [cfg.labels.needsHuman], milestone: "M4" },
    { number: 2, title: "not held", labels: [], milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — never entered standby");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "the one non-held issue was enough to count as work");
  state.close();
});

// ── #432 (F32, PM gate⓪ adjudication 2026-07-31): three prior rounds. Round 1 (a shape filter)
//    and round 2 (a full deletion) both turned out wrong — gate② review (Codex, gpt-5.6-sol
//    high) refuted round 2's subset proof with file:line evidence: `selectPlanTriageCandidates`
//    iterates ProjectV2 board membership (`project.items`), while the catch-all's own
//    `listOpenIssues()` read is the FULL repo backlog — an off-board milestone issue is real work
//    the board-scoped triage/review reads can never see. Round 2 also missed that the aligning
//    phase consumes MORE than plan-triage (split-labeled decompose candidates, decomposed-parent
//    journal recovery — both via decompose.ts/align.ts) and that verification-plan-reviewer self-heals
//    `plan:approved` Ready issues with a broken body through the deliberately body-independent
//    pool (plan-review.ts's class-2 `confirmOneIssue`), which runs even with `po.enabled: false`.
//    Round 3 restored the catch-all EXACTLY as it stood on origin/main and added a label-driven
//    exclusion — but a SECOND gate② confirm round found that exclusion wrong in BOTH directions:
//    `cfg.labels.planApproved` over-counted (a valid approved issue demoted off Ready, or the #94
//    forbidden verifyNa+planApproved mixed state, both pinned the probe true with nothing able to
//    consume them) and under-delivered (the broken-body case it was cited for never needed it — a
//    broken body already fails `planCompleteOrExempt` and counts on its own). Round 4 removes
//    `planApproved` from the label set entirely and replaces its real coverage (Ready + approved +
//    a plan section present but otherwise unparseable) with a STATUS-AWARE probe line —
//    `getPoolEligibleIssues()`, the EXACT selector the class-2 repair consumes (#214) — so probe
//    and consumer are literally one selector, not a label proxy that can drift. `roundPool` joins
//    the label set (a stale pool-label cleanup retry is engine-owned, not role-gated). See
//    round.ts's own comment at each site for the full citation of every exemption's consumer.
//    Every test below is RED-TO-GREEN BY CONSTRUCTION: the F32 negative case was verified to FAIL
//    against an unmodified checkout of origin/main's round.ts, each "still counts as work" wake
//    case was verified to FAIL against this issue's OWN round-2 commit (the full-block deletion),
//    and round 4's NEW cases (verifyNa, verifyNa+planApproved, demoted-approved, the pool-line
//    wake, roundPool) were verified against round 3's own commit (2cb8656) — see the PR body for
//    the exact repro commands. ─────────────────────────────────────────────────────────────────

const SPECIFIED_BODY = "## Acceptance criteria\n- [ ] x\n\n## Verification plan\n- npm test";

test("runRounds standby (#432 F32): a milestone whose open non-Ready issues are ALL fully-specified (plan+AC present) and carry NONE of split/decomposed/roundPool does not count as work — standby engages after one idle round", async () => {
  const forge = new FakeForge();
  forge.ready = []; // none are Ready yet — awaiting only human promotion
  forge.planReviewCandidates = []; // Ready-lane-only signal, moot here
  forge.planTriageCandidates = []; // #89: neither has a plan gap — nothing for the PO to triage
  forge.milestoneOpenCounts = [2];
  const cfg = mkCfg({ round: { milestone: "v0.2.1", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 460, title: "fully specified a", labels: [], body: SPECIFIED_BODY, milestone: "v0.2.1" },
    { number: 461, title: "fully specified b", labels: [], body: SPECIFIED_BODY, milestone: "v0.2.1" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop(); // bounded safety net, same idiom as the #212/#391 tests above
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — a milestone of fully-specified, human-Ready-gated issues with no consumable-signal label no longer pins the probe true; this is the F32 acceptance evidence " +
      "(RED against unmodified origin/main round.ts: its catch-all has no shape check at all and counts these unconditionally — see the PR body for the verified repro)",
  );
  assert.ok(forge.milestoneQueries.includes("v0.2.1"), "the cheap count was still checked first");
  state.close();
});

test("runRounds standby (#432 F32, AC2): a genuinely raw issue (no plan/AC structure) in the milestone still counts as work — cold-start decomposition is unaffected", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = []; // this probe's milestone rung must carry the signal on its own
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 500, title: "brand new, no plan yet", labels: [], body: "just an idea, nothing structured", milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — the raw issue is still work, no standby");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 F32, MIXED): one fully-specified issue plus one raw issue still counts as work — the raw issue alone is enough", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  // Realistic coupling: the raw issue #500 is genuinely on-board and plan-less, so a live forge's
  // getIssuesNeedingPlanTriage() would return it too (needsPlanTriage true) — populated here to
  // match, not to isolate any one line; either the triage line or the catch-all alone is enough,
  // and this test only asserts the mixed backlog resolves to "work exists" either way.
  forge.planTriageCandidates = [{ number: 500, title: "raw", labels: [], milestone: "M4" }];
  forge.milestoneOpenCounts = [2];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 460, title: "fully specified", labels: [], body: SPECIFIED_BODY, milestone: "M4" },
    { number: 500, title: "raw", labels: [], body: "just an idea", milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — never entered standby");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "the one raw issue was enough to count as work");
  state.close();
});

test("runRounds standby (#432 F32, Codex P1-1 off-board): a fully-specified milestone issue ABSENT from every board-scoped selector (planTriageCandidates/planReviewCandidates both empty, as a real off-board issue would leave them) still counts as work when it is genuinely raw — the repo-wide listOpenIssues() read sees it even when ProjectV2 board membership wouldn't", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  // An off-board issue is, by definition, invisible to every ProjectV2-board-scoped selector —
  // both stay empty even though the milestone genuinely has raw work in it. Only the repo-wide
  // listOpenIssues() read (which the restored catch-all uses, unlike a board-scoped-only design)
  // can see it. This is the exact universe-mismatch gap Codex's P1-1 finding identified in
  // round 2's deletion (which relied solely on the board-scoped triage read).
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = [];
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [{ number: 600, title: "off-board raw issue", labels: [], body: "not on the project board at all", milestone: "M4" }];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — the off-board issue was still seen and counted");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 F32, Codex P1-1 split): a fully-specified milestone issue carrying `split` still counts as work — a human's decompose request must wake the loop even though the body already has a full plan+AC", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = []; // fully specified -> needsPlanTriage is false, same as a real forge
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  // isDecomposeCandidate (decompose.ts) = split ∧ ¬decomposed ∧ ¬needsHuman ∧ ¬blocked — consumed
  // by runDecompositionPass (align.ts ~1486-1490, inside alignStub.run, gated on roles.po.enabled).
  forge.openIssues = [{ number: 700, title: "split, fully specified", labels: [cfg.labels.split], body: SPECIFIED_BODY, milestone: "M4" }];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(
    result.rounds,
    2,
    "round 2 opened straight after idle round 1 — the split-labeled issue was still counted despite a complete body",
  );
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 F32, Codex P1-1 decomposed): a decomposed parent still counts as work — its local decomposition journal may still need recovery, which needsPlanTriage's own decomposed exclusion makes invisible to the triage line", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = []; // needsPlanTriage explicitly excludes `decomposed` — a real forge agrees
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  // decompose.ts's `recoveries` set (inside runDecompositionPass) is exactly decomposed-labelled
  // issues with an unreconciled LOCAL journal — this probe has no local-journal read of its own,
  // so (documented residual, same stance as the claimed-issue comment above it in round.ts) it
  // counts EVERY decomposed-labelled issue, a same-round-idle over-count, never a missed recovery.
  forge.openIssues = [{ number: 800, title: "fenced parent", labels: [cfg.labels.decomposed], body: SPECIFIED_BODY, milestone: "M4" }];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — the decomposed parent was still counted");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 F32): a Ready-lane issue carrying plan:approved with NO verification-plan section AT ALL still counts as work, through the catch-all's planCompleteOrExempt check alone — round 4 removed planApproved from the label set, and this shape never needed it", async () => {
  // po.enabled: false isolates the catch-all as the ONLY signal that can see this issue: with po
  // ON, getIssuesNeedingPlanTriage would ALSO return it true (needsPlanTriage never checks
  // planApproved, only extractVerificationPlan(body)). verificationPlanReviewer stays enabled so the NEW
  // getPoolEligibleIssues probe line is live too — but forge.poolEligible is deliberately left at
  // its default [] below, so THAT line can't be what makes this pass either. The only path left is
  // the catch-all: a body with NO plan section at all fails planCompleteOrExempt on its own,
  // regardless of any label — proving round 3's planApproved exemption was never load-bearing for
  // this exact shape (Codex P1-1's own observation).
  const forge = new FakeForge();
  forge.ready = []; // isDispatchable fails closed: no verification-plan section in the body
  forge.planReviewCandidates = []; // needsPlanReview fails closed too: plan:approved is already present
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({
    roles: { po: { enabled: false }, verificationPlanReviewer: { enabled: true } },
    round: { milestone: "M4", standby: { enabled: true } },
  });
  forge.openIssues = [
    {
      number: 900,
      title: "approved, no plan section at all",
      labels: [cfg.labels.planApproved],
      body: "the plan section got deleted",
      milestone: "M4",
    },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(
    result.rounds,
    2,
    "round 2 opened straight after idle round 1 — the no-plan-section plan:approved issue was still counted, via the catch-all's body check alone",
  );
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

// ── #432 round 4 (PM adjudication of Codex confirm round): the corners round 3's `planApproved`
//    label got wrong in both directions, plus the new status-aware pool line and `roundPool`
//    exemption. Each fixture below leaves EVERY OTHER candidate set at its realistic value for
//    the shape described (never an impossible state a live forge couldn't produce). ────────────

const BROKEN_AC_BODY = "## Verification plan\n- npm test\n\n## Acceptance criteria\nno checkboxes here, just prose";

test("runRounds standby (#432 round 4): a milestone issue carrying ONLY verify:n/a (no plan expected, no consumable-signal label) does not count as work", async () => {
  const forge = new FakeForge();
  forge.ready = []; // not Ready
  forge.planReviewCandidates = []; // verifyNa -> needsPlanReview false
  forge.planTriageCandidates = []; // verifyNa -> needsPlanTriage false
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [{ number: 1000, title: "doc-gate, no plan expected", labels: [cfg.labels.verifyNa], milestone: "M4" }];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — verifyNa alone is plan-exempt, not consumable",
  );
  state.close();
});

test("runRounds standby (#432 round 4, P1-1 regression pin): the #94 forbidden verifyNa+plan:approved mixed state does NOT count as work — every real selector treats it as human-cleanup-only, and round 3's planApproved label would have wrongly pinned this true", async () => {
  const forge = new FakeForge();
  forge.ready = []; // isDispatchable fail-closes the forbidden mixed state
  forge.planReviewCandidates = []; // needsPlanReview fail-closes it too
  forge.planTriageCandidates = []; // verifyNa alone already excludes it from triage
  forge.poolEligible = []; // isPoolEligible fail-closes the SAME forbidden mixed state (forge.ts)
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 1001, title: "forbidden mixed state", labels: [cfg.labels.verifyNa, cfg.labels.planApproved], milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — the forbidden mixed state has no enabled consumer anywhere",
  );
  state.close();
});

test("runRounds standby (#432 round 4, P1-1 regression pin): a VALID approved issue demoted off Ready (plan:approved, full plan+AC, no split/decomposed/roundPool) does NOT count as work — round 3's planApproved exemption would have pinned this true forever", async () => {
  const forge = new FakeForge();
  forge.ready = []; // demoted off Ready — not dispatchable regardless of body quality
  forge.planReviewCandidates = []; // already approved, and not Ready-lane either way — not a review candidate
  forge.planTriageCandidates = []; // has a full valid plan — needsPlanTriage false
  forge.poolEligible = []; // demoted off Ready — selectPoolEligibleIssues is Ready-lane-scoped, so NOT pool-eligible either
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    {
      number: 1002,
      title: "demoted, still approved, valid plan",
      labels: [cfg.labels.planApproved],
      body: SPECIFIED_BODY,
      milestone: "M4",
    },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — a demoted-but-valid approved issue has no enabled consumer left; nothing can act on it until a human re-promotes it",
  );
  state.close();
});

test("runRounds standby (#432 round 5): a Ready, POOLED issue carrying plan:approved with a verification-plan SECTION present but a malformed (non-checkbox) acceptance-criteria list counts as work via the status-aware getPoolEligibleIssues() ∩ roundPool probe line — no milestone scoping needed, this signal is general", async () => {
  const forge = new FakeForge();
  forge.ready = []; // isDispatchable fails: extractAcceptanceCriteria returns null for a malformed list
  forge.planReviewCandidates = []; // already plan:approved — not a review candidate
  forge.planTriageCandidates = []; // extractVerificationPlan(body) IS non-null (a real section exists) — not a triage candidate
  const cfg = mkCfg({ round: { standby: { enabled: true } } }); // milestone UNSET — this signal must carry alone
  // The one signal a live forge WOULD carry for this shape: selectPoolEligibleIssues is
  // deliberately body-independent (forge.ts), so a Ready + plan:approved issue is pool-eligible
  // regardless of whether its AC list actually parses. #432 round 5: eligibility ALONE is no
  // longer enough — the probe now also requires the roundPool label, matching EXACTLY what
  // plan-review.ts's createPlanReviewStub filters its own pool membership by (~914) — this issue
  // carries it (a real PO pool-selection pass applied it), representing the class-2 repair's
  // actual live candidate, not merely someone eligible-but-unselected.
  forge.poolEligible = [
    { number: 1003, title: "approved, broken AC list", labels: [cfg.labels.planApproved, cfg.labels.roundPool], body: BROKEN_AC_BODY },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(
    result.rounds,
    2,
    "round 2 opened straight after idle round 1 — the pooled broken-AC issue was work, via the new probe line alone",
  );
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 round 5, Codex P1-1, RED vs round 4): a Ready, ELIGIBLE-BUT-UNPOOLED issue (plan:approved, malformed AC, no roundPool label) does NOT count as work — a valid PO selection of `selected: []` leaves it with no consumer, and round 4's unfiltered getPoolEligibleIssues() read wrongly pinned the probe on exactly this remainder", async () => {
  const forge = new FakeForge();
  forge.ready = []; // isDispatchable fails: extractAcceptanceCriteria returns null for a malformed list
  forge.planReviewCandidates = []; // already plan:approved — not a review candidate
  forge.planTriageCandidates = []; // extractVerificationPlan(body) IS non-null — not a triage candidate either
  const cfg = mkCfg({ round: { standby: { enabled: true } } }); // milestone UNSET — same as the pooled counterpart above
  // Eligible (Ready, not held, not the #94 mixed state) but genuinely NOT selected into this
  // round's pool — plan-review.ts's createPlanReviewStub only ever reads
  // `eligible.filter(roundPool)`, so this issue has no session that will ever touch it until a
  // LATER pool selection actually picks it. That is a rendered PO judgment, not pending work.
  forge.poolEligible = [
    { number: 1003, title: "approved, broken AC list, unpooled", labels: [cfg.labels.planApproved], body: BROKEN_AC_BODY },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — an eligible-but-unpooled issue has no consumer this round, and must not pin the probe true",
  );
  state.close();
});

test("runRounds standby (#432 round 4, P2-3): a fully-specified milestone issue carrying a stale `roundPool` label still counts as work — the engine-owned label-cleanup retry (align.ts's reconcilePoolLabels, round.ts's round-close removal) must not be withheld by an otherwise-consumable-shape exclusion", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = []; // fully specified -> needsPlanTriage false, same as a real forge
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", standby: { enabled: true } } });
  forge.openIssues = [
    { number: 1004, title: "stale pool label, fully specified", labels: [cfg.labels.roundPool], body: SPECIFIED_BODY, milestone: "M4" },
  ];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — the stale roundPool-labeled issue was still counted");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

// ── #432 round 5 (PM adjudication of Codex second confirm round): a repeated defect CLASS —
//    a retry signal added to the probe without a TERMINAL lets a deterministic failure pin
//    rounds open forever. Both tests below pin the SELF-RESOLUTION: N deterministic failures
//    (never succeeding) must escalate exactly once and then let standby engage. ────────────────

// Note: round.test.ts's `allPeripherals` fixture stubs every phase with a bare logging stub —
// it never runs the REAL round-defaults.ts wiring (align.ts's dissent sweep, plan-review.ts's
// pool consumer). The actual "N failures reach the cap, escalate exactly once"
// reconcileDurableConcerns mechanism is exercised directly in dissent.test.ts, where nothing
// stands between the test and the real function. What belongs here is narrower and just as
// load-bearing: does round.ts's PROBE correctly read the TERMINAL once it lands? These two tests
// pin exactly that — the "before" (still pending, probe pinned) and "after" (escalated, probe
// unpinned) states dissent.test.ts's own escalation test proves the ledger transitions between.

test("runRounds standby (#432 round 5, P1-2): a durable dissent concern that is STILL PENDING (not yet escalated) counts as work — standby does not engage", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = [];
  forge.poolEligible = [];
  const cfg = mkCfg({ round: { standby: { enabled: true } } });
  const state = new State(":memory:");
  // A decision event with no matching concern-posted/concern-post-escalated receipt — exactly
  // what a failed-but-not-yet-capped post attempt leaves behind.
  state.appendEvent("triage-decision-accepted", { round_id: 1, concerns: [{ issue: 777, reason: "this issue's premise seems wrong" }] });
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const { sleep } = mkSleepSpy();
  const deps = baseDeps({ forge, state, sleep, cfg, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 10);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 2, "round 2 opened straight after idle round 1 — the still-pending concern was still counted as work");
  assert.equal(events.filter(([kind]) => kind === "standby-wait").length, 0, "no backoff wait ever happened");
  state.close();
});

test("runRounds standby (#432 round 5, P1-2, the TERMINAL): a durable dissent concern that has ALREADY escalated (concern-post-escalated on record) does NOT count as work — the probe unpins", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = [];
  forge.poolEligible = [];
  const cfg = mkCfg({ round: { standby: { enabled: true } } });
  const state = new State(":memory:");
  // Same decision event as the pending-state test above, PLUS the terminal escalation event
  // escalateUnpostableConcern (dissent.ts) appends after its own addLabel succeeds — this is
  // exactly the ledger state reconcileDurableConcerns leaves once maxConcernPostAttempts is
  // reached (dissent.test.ts proves that transition; this test proves the probe honors it).
  state.appendEvent("triage-decision-accepted", { round_id: 1, concerns: [{ issue: 777, reason: "this issue's premise seems wrong" }] });
  state.appendEvent("concern-post-escalated", { round_id: 1, issue: 777, reason: "this issue's premise seems wrong" });
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, tickIntervalSec: 5, cfg, peripherals: allPeripherals(log) });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged — an escalated concern has no local-SQLite signal left pinning the probe",
  );
  state.close();
});

test("runRounds standby (#432 round 5, P2-3): a stale roundPool label that fails to remove EVERY pass escalates needs-human exactly once it reaches maxPoolRemovalAttempts, and the probe unpins — the self-resolution pins itself", async () => {
  const forge = new FakeForge();
  forge.ready = [];
  forge.planReviewCandidates = [];
  forge.planTriageCandidates = []; // fully specified -> needsPlanTriage false, same as a real forge
  forge.milestoneOpenCounts = [1];
  const cfg = mkCfg({ round: { milestone: "M4", maxPoolRemovalAttempts: 2, standby: { enabled: true } } });
  forge.openIssues = [
    {
      number: 1005,
      title: "stale pool label, removal always fails",
      labels: [cfg.labels.roundPool],
      body: SPECIFIED_BODY,
      milestone: "M4",
    },
  ];
  // A deterministic, never-clearing removeLabel failure (e.g. a repo permission problem) — round
  // close's own sweep is what calls this, since deps.poolLabel below wires it in.
  forge.removeLabel = async (n: number, l: string) => {
    if (n === 1005 && l === cfg.labels.roundPool) throw new Error("removeLabel permanently failing");
    forge.removeLabelCalls.push([n, l]);
  };
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 6) stop();
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    tickIntervalSec: 5,
    cfg,
    peripherals: allPeripherals(log),
    poolLabel: cfg.labels.roundPool, // round-close only sweeps stale pool labels when a pool is actually configured
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  // Round 1: round-close's own sweep attempts removal, fails (1st recorded failure, 1 < cap 2) —
  // the label is still on the issue, still fully-specified, still no other consumable signal, so
  // the catch-all's roundPool exemption keeps counting it as work between rounds 1 and 2. Round
  // 2's round-close sweep fails again (2nd failure, reaches the cap) and escalates in the SAME
  // pass — needsHuman now structurally excludes the issue from the catch-all, and standby engages.
  assert.equal(result.rounds, 2, "exactly two rounds opened before the cap was reached and escalation fired");
  assert.ok(
    forge.addLabelCalls.some(([n, l]) => n === 1005 && l === cfg.labels.needsHuman),
    "the issue whose stale pool label wouldn't remove was escalated needs-human",
  );
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby engaged once the issue escalated and stopped pinning the probe",
  );
  const escalations = events.filter(
    ([kind, payload]) => kind === "round-pool-removal-capped" && (payload as { issue?: number }).issue === 1005,
  );
  assert.equal(escalations.length, 1, "the issue escalated EXACTLY once, not once per subsequent pass");
  state.close();
});

// ── #432 round 6 (PM adjudication of Codex third confirm round): the round-5 terminals were
//    hand-rolled with raw addLabel instead of the shared escalation-writer.ts discipline —
//    direct, function-level reproductions of each finding, mirroring how Codex itself verified
//    them (unit-level, not through the full runRounds harness, since align.ts's real reconcile
//    never runs there — round.test.ts's `allPeripherals` stubs every phase). ─────────────────────

test("escalatePoolRemovalFailures (#432 round 6, P1-1): addLabel failing EVERY time still appends the terminal event, with labeled:0 — the probe unpins regardless", async () => {
  const forge = new FakeForge();
  forge.addLabel = async () => {
    throw new Error("permission denied");
  };
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { maxPoolRemovalAttempts: 1 } });
  state.appendEvent("pool-reconcile-incomplete", { round_id: 1, failed_issues: [9] });

  await escalatePoolRemovalFailures(forge, cfg, state, [9]);

  const terminals = state.eventsAfterId(0, ["round-pool-removal-capped"]);
  assert.equal(terminals.length, 1, "the terminal event landed despite the label write failing every time");
  assert.deepEqual(terminals[0]!.payload, { issue: 9, labeled: 0, labelError: "Error: permission denied" });
  state.close();
});

test("escalatePoolRemovalFailures (#655 AC3): the pool-removal-cap escalation carries a reason comment on the issue", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { maxPoolRemovalAttempts: 1 } });
  state.appendEvent("pool-reconcile-incomplete", { round_id: 1, failed_issues: [9] });

  await escalatePoolRemovalFailures(forge, cfg, state, [9]);

  assert.equal(forge.issueComments[9]?.length, 1);
  const body = forge.issueComments[9]![0]!.body;
  assert.match(body, /<!-- sapwood:needs-human-reason:round-pool-removal-capped:9 -->/);
  assert.match(body, new RegExp(`\`${cfg.labels.roundPool}\` label failed to remove 1 time`));
  assert.match(body, new RegExp(`Remove \`${cfg.labels.needsHuman}\` from this issue once resolved to retry \\(#147 gated reentry\\)`));
  state.close();
});

test("escalatePoolRemovalFailures (#655 AC2/AC3): a reason-comment write failure leaves the label outcome and terminal event unaffected", async () => {
  const forge = new FakeForge();
  forge.throwOnAddIssueComment = true;
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { maxPoolRemovalAttempts: 1 } });
  state.appendEvent("pool-reconcile-incomplete", { round_id: 1, failed_issues: [9] });

  await escalatePoolRemovalFailures(forge, cfg, state, [9]);

  assert.equal(forge.addLabelCalls.length, 1);
  const terminals = state.eventsAfterId(0, ["round-pool-removal-capped"]);
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0]!.payload, { issue: 9, labeled: 1 });
  assert.equal(forge.issueComments[9], undefined, "the failed comment attempt left no partial trace");
  state.close();
});

test("escalatePoolRemovalFailures (#432 round 6, P2-3): idempotence — calling it again for an ALREADY-escalated issue performs zero label attempts and appends zero new terminal events", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { maxPoolRemovalAttempts: 1 } });
  state.appendEvent("pool-reconcile-incomplete", { round_id: 1, failed_issues: [9] });

  await escalatePoolRemovalFailures(forge, cfg, state, [9]); // first call: escalates
  assert.equal(forge.addLabelCalls.length, 1, "the first call escalated once");
  assert.equal(state.eventsAfterId(0, ["round-pool-removal-capped"]).length, 1);

  // An UNRELATED wake (e.g. a later round's own sweep re-observing the same still-labelled,
  // still-open issue) calls this again with the SAME issue in failedIssues.
  await escalatePoolRemovalFailures(forge, cfg, state, [9]);
  assert.equal(forge.addLabelCalls.length, 1, "zero NEW label attempts — poolRemovalEscalated skipped it");
  assert.equal(state.eventsAfterId(0, ["round-pool-removal-capped"]).length, 1, "zero NEW terminal events");
  assert.ok(poolRemovalEscalated(state, 9));
  state.close();
});

test("poolRemovalFailureCount (#432 round 6, P2-4): an episode boundary resets the count — 4 failures BEFORE a re-pool event, plus 1 failure AFTER it, count as 1, not 5", async () => {
  const state = new State(":memory:");
  // Four "ancient" failures, rounds 1-4.
  for (let r = 1; r <= 4; r++) state.appendEvent("pool-reconcile-incomplete", { round_id: r, failed_issues: [9] });
  assert.equal(poolRemovalFailureCount(state, 9), 4, "sanity: all four count before any reset");

  // Round 5: the issue is re-selected into the pool (a fresh episode — whatever removal history
  // preceded it is closed, successfully or not; the label is now legitimately supposed to be
  // there again).
  state.appendEvent("pool-selected", { round_id: 5, issues: [9] });

  // Round 9: a genuinely NEW, unrelated transient failure.
  state.appendEvent("pool-reconcile-incomplete", { round_id: 9, failed_issues: [9] });

  assert.equal(poolRemovalFailureCount(state, 9), 1, "only the post-reset failure counts — the four ancient ones are a closed episode");
  state.close();
});

test("poolRemovalFailureCount (#432 round 6, P2-4): a pool-selected event for a DIFFERENT issue does not reset this issue's count", async () => {
  const state = new State(":memory:");
  state.appendEvent("pool-reconcile-incomplete", { round_id: 1, failed_issues: [9] });
  state.appendEvent("pool-selected", { round_id: 2, issues: [42] }); // a different issue entirely
  state.appendEvent("pool-reconcile-incomplete", { round_id: 3, failed_issues: [9] });
  assert.equal(poolRemovalFailureCount(state, 9), 2, "both failures still count — issue #9 was never re-pooled");
  state.close();
});

test("poolRemovalFailureCount (#432 round 7, P2-4, Codex fourth confirm — exact repro): a SAME-ROUND selection then failure still counts — round 6's round_id `>` comparison silently dropped exactly this, the single most common failure shape (selected at round-open, removal fails at that SAME round's close)", async () => {
  const state = new State(":memory:");
  // Round 5: the issue is selected into the pool...
  state.appendEvent("pool-selected", { round_id: 5, issues: [9] });
  // ...and in that SAME round, round-close's own sweep fails to remove it (e.g. the round's
  // target changed again before close, or the very next reconcile pass already wants it gone).
  state.appendEvent("pool-reconcile-incomplete", { round_id: 5, failed_issues: [9] });
  assert.equal(
    poolRemovalFailureCount(state, 9),
    1,
    "the same-round failure counts — round_id comparison (5 > 5 is false) used to silently drop it",
  );
  state.close();
});

test("poolRemovalFailureCount (#432 round 7, P2-4, documented residual — NOT part of this round's prescription): a same-round select-then-fail pattern repeated identically across MULTIPLE rounds never exceeds 1 — each round's OWN pool-selected event resets the count before that SAME round's own failure re-increments it. Pins the ACTUAL behavior; see poolRemovalFailureCount's own doc for why this is a benign residual, not the F32 shape this cap exists to close", async () => {
  const state = new State(":memory:");
  for (let r = 1; r <= 3; r++) {
    state.appendEvent("pool-selected", { round_id: r, issues: [9] });
    state.appendEvent("pool-reconcile-incomplete", { round_id: r, failed_issues: [9] });
  }
  assert.equal(
    poolRemovalFailureCount(state, 9),
    1,
    "stays at 1 every round in this exact pattern — benign: an issue selected EVERY round is a live, currently-consumed pool member every one of those rounds regardless of its stale label ever clearing, so the probe was never actually stuck on unconsumable work here",
  );
  state.close();
});

// ── #253: engine-side proxy manager — buildFixLegResume + fix-loop mint wiring ──────────────

/** Mirrors proxy/mint.test.ts's own fakeForge() — a minimal ProxyForge satisfying every method
 *  the forge MCP proxy's tool algebra needs, independent of this file's own FakeForge (which
 *  fakes IForge's DISPATCH-side surface only, never the proxy's issue/PR-detail reads). */
function fakeProxyForge(): ProxyForge {
  const meta: IssueMeta = { number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "2026-07-17T00:00:00Z" };
  const comments: PRComment[] = [];
  const relations: IssueRelations = { linkedPRs: [], crossReferences: [], truncated: false };
  const results: IssueSearchResult[] = [];
  const prDetails: PRDetails = {
    number: 1,
    headOid: "abc",
    baseRefName: "develop",
    state: "OPEN",
    draft: false,
    labels: [],
    mergeable: "MERGEABLE",
  };
  const reviews: PRReviewItem[] = [];
  const threads: ReviewThreadItem[] = [
    {
      id: "T1",
      isResolved: false,
      comments: [{ author: "codex", body: "fix this", createdAt: "2026-07-18T00:00:00Z" }],
      commentsComplete: true,
    },
  ];
  const checks: PRCheckItem[] = [];
  return {
    getIssueMeta: async () => meta,
    getIssueBody: async () => "",
    getIssueComments: async () => comments,
    getIssueRelations: async () => relations,
    searchIssues: async () => results,
    getPRDetails: async () => prDetails,
    getPRReviews: async () => ({ reviews, total: reviews.length }),
    getPRReviewThreads: async () => ({ threads, pageCapped: false }),
    getPRChecks: async () => ({ checks, total: checks.length }),
    // #403 (F25): ProxyForge's tenth member — stubbed empty because no test in this file drives
    // it, but PRESENT, so the fixture actually satisfies the type it is passed as.
    getPRComments: async () => ({ comments: [], total: 0 }),
    // #975: ProxyForge's eleventh member (pr_failed_checks) — same "stubbed, present, undriven"
    // stance as getPRComments above.
    getFailedCheckSummary: async () => "(no failing check runs found via the checks API)",
  };
}

async function callProxyTool(url: string, token: string, name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const json = (await res.json()) as { result: { isError: boolean; content: { type: string; text: string }[] } };
  return { isError: json.result.isError, text: json.result.content[0]!.text };
}

test("buildFixLegResume (#253, #551): cfg.proxy.enabled: false (explicit opt-out) -> undefined regardless of renderFixPrompt being supplied", () => {
  const state = new State(":memory:");
  try {
    const cfg = mkCfg({ proxy: { enabled: false } });
    assert.equal(cfg.proxy.enabled, false);
    const result = buildFixLegResume(
      { now: realClock, cfg, state, renderFixPrompt: (i, p) => `fix #${i} for PR #${p}` },
      fakeProxyForge(),
      1,
    );
    assert.equal(result, undefined);
  } finally {
    state.close();
  }
});

test("buildFixLegResume (#551): cfg.proxy left entirely UNSET (the real default) -> a real fixLegResume, since renderFixPrompt is supplied", async () => {
  const state = new State(":memory:");
  try {
    const cfg = mkCfg(); // no `proxy` key at all
    assert.equal(cfg.proxy.enabled, true, "#551: proxy.enabled defaults to true with nothing set");
    const result = buildFixLegResume(
      { now: realClock, cfg, state, renderFixPrompt: (i, p) => `fix #${i} for PR #${p}` },
      fakeProxyForge(),
      1,
    );
    assert.ok(result, "expected a real fixLegResume under the default config");
  } finally {
    state.close();
  }
});

test("buildFixLegResume (#253, #551): cfg.proxy.enabled: true, but NO renderFixPrompt supplied -> undefined (round.ts's own skeleton tests/callers never touch #246's FIXABLE path)", () => {
  const state = new State(":memory:");
  try {
    const result = buildFixLegResume({ now: realClock, cfg: mkCfg({ proxy: { enabled: true } }), state }, fakeProxyForge(), 1);
    assert.equal(result, undefined);
  } finally {
    state.close();
  }
});

test("buildFixLegResume (#551): cfg.proxy.enabled: false (explicit opt-out) -> undefined even WITH renderFixPrompt supplied", () => {
  const state = new State(":memory:");
  try {
    const cfg = mkCfg({ proxy: { enabled: false } });
    assert.equal(cfg.proxy.enabled, false);
    const result = buildFixLegResume(
      { now: realClock, cfg, state, renderFixPrompt: (i, p) => `fix #${i} for PR #${p}` },
      fakeProxyForge(),
      1,
    );
    assert.equal(result, undefined, "proxy.enabled: false: no production attachment, even with renderFixPrompt supplied");
  } finally {
    state.close();
  }
});

test("buildFixLegResume (#253, #551): proxy.enabled: true (the DEFAULT — nothing set) + renderFixPrompt -> a real fixLegResume whose mintProxy threads the given roundId/phase='executing' into the minted session's own journal identity", async () => {
  const state = new State(":memory:");
  try {
    const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
    const cfg = mkCfg();
    assert.equal(cfg.proxy.enabled, true, "#551: proxy.enabled defaults to true with nothing set");
    const result = buildFixLegResume({ now: realClock, cfg, state, renderFixPrompt }, fakeProxyForge(), 42);
    assert.ok(result, "expected a real fixLegResume");
    assert.equal(result.renderFixPrompt(7, 9), "fix #7 for PR #9");
    const handle = await result.mintProxy({ role: "worker", session: "lane-99-abc" });
    try {
      assert.deepEqual(
        handle.toolNames.sort(),
        ["pr_details", "pr_reviews", "pr_review_threads", "pr_checks", "pr_audit_comments", "pr_failed_checks"]
          .map((t) => `mcp__forge__${t}`)
          .sort(),
        "the fix-loop worker role gets PR_TOOLS only",
      );
      const { isError, text } = await callProxyTool(handle.url, handle.token, "pr_review_threads", { pr: 5 });
      assert.equal(isError, false);
      assert.equal(JSON.parse(text).threads.length, 1);
      const rows = state.listForgeProxyJournal({ roundId: 42, phase: "executing", role: "worker", session: "lane-99-abc", attempt: 1 });
      assert.equal(
        rows.length,
        1,
        "the call was journaled under EXACTLY this round's id/phase — proof buildFixLegResume threaded them through",
      );
      assert.equal(rows[0]!.tool, "pr_review_threads");
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
});

/** A Supervisor that captures every resume() call's opts (the fix leg's `proxy`/`credentialFree`/
 *  `prompt`) — the observation point for proving round.ts's REAL wiring, not a fake, reaches
 *  startFixLeg's own supervisor.resume() call unmodified. */
class CapturingResumeSupervisor extends FakeSupervisor {
  resumeCalls: Array<{ issue: Issue; worker: string; opts: { proxy?: WorkerProxyOpts; prompt?: string; sessionId?: string } | undefined }> =
    [];
  override async resume(
    issue: Issue,
    worker: string,
    opts?: { proxy?: WorkerProxyOpts; prompt?: string; sessionId?: string },
  ): Promise<{ name: string; sessionId: string }> {
    this.resumeCalls.push({ issue, worker, opts });
    return { name: worker, sessionId: `sess-${worker}` };
  }
}

test("runRounds (#253, #551): cfg.proxy.enabled: true wires a REAL fixLegResume into the executing phase — a FIXABLE gate dispatches a fix leg whose supervisor.resume() carries a working proxy mint", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new CapturingResumeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  const gate = new ScriptedMergeGate([{ kind: "fixable", pr: 1, reason: "ci-red" }]);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    // roundDispatchCap deliberately > 1 (unlike most dispatch-count tests in this file): with the
    // quota exhausted after the initial dispatch, round.ts sets forceDispatchPause for the REST
    // of the round — and the fix-leg admission gate (conductor.ts's fixLegAdmissionBlockReason)
    // treats that "paused" signal as blocking a NEW fix leg exactly like it blocks ordinary
    // dispatch (#246 review round 1, C2's own admission-gate contract). A cap of 1 here would
    // wedge every FIXUP attempt on "fix-leg-admission-blocked:paused" forever — not a #253 bug,
    // just the wrong fixture for THIS test's own question (proving resume() gets a real proxy).
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 10 }, proxy: { enabled: true } }),
    renderFixPrompt,
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 20);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(sup.resumeCalls.length >= 1, "expected the FIXABLE gate to dispatch a fix leg via supervisor.resume()");
  const call = sup.resumeCalls[0]!;
  assert.ok(call.opts?.proxy, "expected a real proxy opt attached to the fix leg's resume() call");
  assert.equal(call.opts!.proxy!.credentialFree, true, "a fix leg is never granted ambient forge credentials (#245 round-2 fix A6)");
  const handle = await call.opts!.proxy!.mint({ role: "worker", session: call.worker });
  try {
    assert.ok(handle.port > 0);
    assert.ok(handle.token.length > 0);
    assert.deepEqual(
      handle.toolNames.sort(),
      ["pr_details", "pr_reviews", "pr_review_threads", "pr_checks", "pr_audit_comments", "pr_failed_checks"]
        .map((t) => `mcp__forge__${t}`)
        .sort(),
    );
  } finally {
    await handle.stop();
  }
  deps.state.close();
});

// ── #375 (PR #388 review round 2, P1): a ROUND-BUDGET-caused wind-down must not starve a
// driving lane's own fix leg. The #253 test above deliberately dodges this exact shape (see its
// own "roundDispatchCap deliberately > 1" comment) — this test uses the fixture that DOES trip
// it: cost.roundBudgetUsd crossed after wave 1, which sets round.ts's forceDispatchPause for the
// rest of the round. Pre-fix, that folded into tick()'s `paused`, and fixLegAdmissionBlockReason
// treated it exactly like a human PAUSE — blocking every FIXUP attempt with
// "fix-leg-admission-blocked:paused" forever, so activeWorkers() never reached zero and the
// round never closed (the real end-to-end shape of #375's own F7/F8 dogfood wedge, one level
// higher than conductor.test.ts's bare-tick() tests can see). ──────────────────────────────────

test("runRounds (#375 review round 2, P1): round budget crossed after wave 1 does NOT block a driving lane's fix leg — the FIXABLE gate still dispatches (bounded by prFixCap only) and the round reaches a terminal state, never wedging on 'fix-leg-admission-blocked:paused'", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new CapturingResumeSupervisor();
  // Same probe entry answers every reclaim of "lane-1-1" — the initial coding worker AND every
  // later fix leg (startFixLeg reuses the SAME worker row/name, #245) — so each fix round settles
  // back to `driving` on the very next tick, letting the ScriptedMergeGate's "fixable" outcome
  // (clamped, fires every call) redrive it until lanes.prFixCap is genuinely exhausted. $6 (not
  // $999, unlike the plain cost.roundBudgetUsd test elsewhere in this file): the SAME probe entry
  // is charged again on EVERY fix-round reclaim too, and this fixture needs to cross ONLY the $5
  // roundBudgetUsd, never the default $100 dailyBudgetUsd — that ceiling is a SEPARATE, legitimate
  // admission blocker (#375 item 1's own `ceilingBreached`) this test is not exercising.
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1, costUsd: 6 };
  const gate = new ScriptedMergeGate([{ kind: "fixable", pr: 1, reason: "ci-red" }]);
  const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const deps = baseDeps({
    forge,
    state,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    // roundDispatchCap deliberately HIGH so it never fires first — isolating roundBudgetUsd as
    // the ONLY round-level stop this fixture trips (mirrors the pre-existing cost.roundBudgetUsd
    // test's own isolation style elsewhere in this file). $6 (wave 1's lane cost) > $5.
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 10 }, cost: { roundBudgetUsd: 5 }, proxy: { enabled: true } }),
    renderFixPrompt,
  });
  const stopSafety = boundedStopOnPhase(deps, 20);
  await runRoundsGuarded(deps);
  stopSafety();

  // Round budget really was crossed (proves this reproduces #375's own F7/F8 scenario, not an
  // unrelated no-op fixture).
  assert.ok(
    events.some(([kind, payload]) => kind === "round-stop" && (payload as { name: string }).name === "roundBudgetUsd"),
    "expected the round-budget stop condition to have actually fired",
  );
  // The fix: a FIXUP dispatch happened despite forceDispatchPause being set for the rest of the
  // round — pre-fix this was 0 (permanently blocked on "paused").
  assert.ok(sup.resumeCalls.length >= 1, "the fix leg must dispatch despite round spend crossing roundBudgetUsd");
  assert.ok(
    !events.some(([kind, payload]) => kind === "fix-leg-dispatch-blocked" && (payload as { blockReason: string }).blockReason === "paused"),
    "a round-budget-caused pause must never appear as the fix leg's own admission-block reason",
  );
  // Bounded by lanes.prFixCap (default 2), not round budget: the fix loop reaches a REAL
  // terminal state (needs-human, once genuinely exhausted) rather than spinning forever.
  assert.equal(state.getWorker("lane-1-1")?.state, "failed");
  assert.equal(state.activeWorkers().length, 0, "the driving lane reached a terminal state — wind-down can actually exit");
  state.close();
});

test("runRounds (#551): cfg.proxy left entirely UNSET (the real default) -> fixLegResume IS attached — a FIXABLE gate dispatches a fix leg without any operator having touched `proxy` at all", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new CapturingResumeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  const gate = new ScriptedMergeGate([{ kind: "fixable", pr: 1, reason: "ci-red" }]);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
  const cfg = mkCfg({ lanes: { max: 1, roundDispatchCap: 10 } }); // no `proxy` key at all
  assert.equal(cfg.proxy.enabled, true, "#551: proxy.enabled defaults to true with nothing set");
  const deps = baseDeps({
    forge,
    state,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg,
    renderFixPrompt,
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 20);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(
    sup.resumeCalls.length >= 1,
    "expected the FIXABLE gate to dispatch a fix leg via supervisor.resume() under the default config",
  );
  assert.ok(sup.resumeCalls[0]!.opts?.proxy, "expected a real proxy opt attached to the fix leg's resume() call");
  assert.ok(
    !events.some(([kind]) => kind === "fix-leg-dispatch-unconfigured"),
    "the default config never degrades — announceFixLoopUnattached-equivalent silence at this layer too",
  );
  state.close();
});

test("runRounds (#253, #551): cfg.proxy.enabled: false (explicit opt-out) -> no fixLegResume is ever built — a FIXABLE gate still degrades to the pre-#246 needs-human escalation exactly as before, unchanged", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new CapturingResumeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  const gate = new ScriptedMergeGate([{ kind: "fixable", pr: 1, reason: "ci-red" }]);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const deps = baseDeps({
    forge,
    state,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 }, proxy: { enabled: false } }), // explicit opt-out, #551 default is true
    // renderFixPrompt deliberately omitted too — cli.ts always supplies it in production, but
    // this proves buildFixLegResume degrades safely even without it.
    peripherals: allPeripherals(log),
  });
  const stopSafety = boundedStopOnPhase(deps, 20);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(sup.resumeCalls.length, 0, "no fix leg was ever dispatched — the gate degraded instead");
  assert.ok(
    events.some(([kind]) => kind === "fix-leg-dispatch-unconfigured"),
    "the unwired-fixLegResume degrade path (#246 C1) fired, visible and actionable — never a silent retry-forever",
  );
  state.close();
});

// ── #395 round 2 (gate② P1): the liveness watchdog is PROGRESS-based, not tick-duration-based ──
// ── — an independent background timer for the WHOLE run, covering every round phase, never ─────
// ── raced against any single tick() call. See watchdog.ts's own doc for why. ───────────────────

test("runRounds (#395): a never-resolving forge await during the executing phase is bounded by the INDEPENDENT progress watchdog — durable engine-stalled event + the injected exit hook fire even though runRounds itself never returns", async () => {
  const forge = new FakeForge();
  // The exact live-incident shape: an in-flight forge/spawn await that never resolves (a host
  // sleep losing the completion notification). getReadyIssues is called from tick()'s DISPATCH
  // phase, reached the instant the round enters `executing` (wave 1 fires immediately, no
  // inter-tick wait) — this wedges tick() itself, and by construction runRounds's own returned
  // promise, which is why this test does NOT await it (see driver.test.ts's equivalent test for
  // the full rationale — a genuine stall means it legitimately never resolves).
  forge.getReadyIssues = () => new Promise<Issue[]>(() => {});
  const state = new State(":memory:");
  // Default liveness config (its watchdogTickMultiplier=10 already clears #395 gate② round 3's
  // cross-field floor against cfg.engine.tickIntervalSec's own default — see
  // config.test.ts's dedicated coverage) — deps.tickIntervalSec below is a SEPARATE field from
  // cfg.engine.tickIntervalSec (only cli.ts's real wiring ties them together), so shrinking it
  // here keeps this test's REAL watchdog timer in the low hundreds of milliseconds without
  // touching cfg at all. Deterministic (not flaky): the OTHER side, progress on `state`, never
  // happens at all.
  const cfg = mkCfg();
  const exitCalls: number[] = [];
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const deps = baseDeps({
    forge,
    state,
    cfg,
    tickIntervalSec: 0.02, // 20ms -> watchdog windowMs = 0.02s * 1000 * 10 (default multiplier) = 200ms
    watchdogExit: (code) => {
      exitCalls.push(code);
      resolveExited();
    },
  });
  void runRounds(deps); // deliberately not awaited
  await exited;
  assert.deepEqual(exitCalls, [1], "the injected exit hook fired exactly once, with a nonzero code");
  const stalled = state.eventsAfterId(0, ["engine-stalled"]);
  assert.equal(stalled.length, 1, "a durable engine-stalled event was appended before the exit hook fired");
  // #395 item 2: round.ts wires `enrich: deps.state` (the real State) — the fired event carries
  // the richer stall-record fields on top of the caller's own eventPayload. `lastTickAt` is a
  // real timestamp (dynamic, asserted only for shape/presence); everything else is asserted
  // exactly, pinning that the enrichment reads the SAME round/lane state this scenario set up
  // (round 1, phase "executing", no lanes ever dispatched — the wedge happened in DISPATCH before
  // any lane was created).
  const payload = stalled[0]!.payload as Record<string, unknown>;
  assert.equal(payload.tickIntervalSec, 0.02);
  assert.equal(payload.watchdogTickMultiplier, 10);
  assert.equal(payload.windowMs, 200);
  assert.equal(payload.openRoundId, 1);
  assert.equal(payload.openRoundPhase, "executing");
  assert.equal(payload.activeLaneCount, 0);
  assert.equal(payload.gatedLaneCount, 0);
  assert.equal(typeof payload.lastEventId, "number");
  assert.equal(typeof payload.lastEventKind, "string");
  assert.equal(typeof payload.lastTickAt, "string");
  state.close();
});

test("runRounds (#395): a healthy fast round never trips the watchdog — a LARGE window (P2-4: window size is irrelevant to this assertion, so make it CI-safe) never even gets the chance to elapse before runRounds's own clean return stops it", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  // tickIntervalSec=60 x multiplier=10 (the shipped defaults) -> a 600s real window, never
  // remotely close to elapsing before this fast fake round completes and runRounds's own
  // `finally` stops the watchdog — see driver.test.ts's equivalent test for the same rationale.
  const cfg = mkCfg({ liveness: { watchdogTickMultiplier: 10 } });
  const deps = baseDeps({ forge, sleep, cfg, tickIntervalSec: 60, peripherals: allPeripherals(log) });
  const stopSafety = boundedStopOnPhase(deps, 5);
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1, "the fast fake round completed normally");
  const stalled = deps.state.eventsAfterId(0, ["engine-stalled"]);
  assert.equal(stalled.length, 0, "no engine-stalled event on the healthy path");
  deps.state.close();
});

test("runRounds (#395): a contained tick() THROW during executing settles quickly (a plain tick-error, progress counter advances) — the watchdog is stopped cleanly, same large-window CI-safety as the healthy-path test above", async () => {
  const forge = new FakeForge();
  forge.getReadyIssues = async () => {
    throw new Error("HTTP 502");
  };
  const cfg = mkCfg({ liveness: { watchdogTickMultiplier: 10 } });
  const deps = baseDeps({ forge, cfg, tickIntervalSec: 60 });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  const stalled = deps.state.eventsAfterId(0, ["engine-stalled"]);
  assert.equal(stalled.length, 0, "a thrown (settled) tick is a tick-error, never a stall");
  const errored = deps.state.eventsAfterId(0, ["tick-error"]);
  assert.ok(
    errored.some((e) => String((e.payload as { error: string }).error).includes("HTTP 502")),
    "the throw was still recorded as an ordinary tick-error, exactly as before #395",
  );
  deps.state.close();
});

// ── #395 gate② round 4 P1 (SHIPPING BLOCKER): a WAIT-gated lane (PR on pending CI) ticks ───────
// ── healthily every tickIntervalSec (last_tick_at advances every tick) but the EVENT LOG goes ──
// ── quiet — drive-queued is deduped (appended once, never per tick) — so an event-log-only ─────
// ── watchdog self-kills a perfectly healthy, actively-draining engine. ──────────────────────────

test("runRounds (#395 gate② round 4): a WAIT-gated lane (PR on pending CI) never trips the liveness watchdog — TODAY that holds because drive-queued fires every tick (a fact issue #383 is about to remove); the tuple sampling is what keeps this assertion true once it does", async () => {
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  // The dispatched lane reports DONE with a PR on every probe — reclaim moves it straight to
  // `driving` on the first tick that observes it.
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  // Every DRIVE pass reports "queued" (driveDecision's WAIT case) — a PR sitting on pending CI —
  // until `stillWaiting` flips below, after the observation window: a plain ScriptedMergeGate
  // (a fixed outcome list) has no clean way to let the round close afterward, and a permanently
  // WAIT-ing lane leaves runRounds() with no cooperative way to stop (runExecuting's own drain
  // loop only exits on activeWorkers()===0, never checks `signalled`) — including its liveness
  // watchdog, an independent real-timer chain stopped only in runRounds's own `finally`. So this
  // gate switches to "merged" once the observation window closes, and `deps.stop.afterIssuesMerged`
  // below lets the OUTER round loop wind down and return cleanly once it does.
  //
  // WHY THIS TEST IS NOT VACUOUS, EVEN THOUGH IT PASSES TODAY FOR A REASON UNRELATED TO THE FIX
  // UNDER TEST: conductor.ts:2711's drive-queued append has NO dedup guard today — `case
  // "queued": state.appendEvent("drive-queued", ...)` runs unconditionally on EVERY DRIVE pass
  // that sees this outcome (confirmed by instrumenting state.appendEvent while running this exact
  // fixture: ~30 drive-queued rows landed in 600ms of ticking, one per tick; conductor.ts:2640's
  // review-silence-escalated has the same shape). So today, the event log alone already stays
  // warm every tick for a WAIT-gated lane, and the assertion below would hold even against the
  // OLD maxEventId()-only watchdog. issue #383 ("transition-dedupe drive-queued — 75% of the
  // dogfood event log was steady-state spam") is open in this same milestone and names this exact
  // event: once it lands, drive-queued stops firing per tick, the event log genuinely goes quiet
  // for this scenario, and the self-kill this test guards against becomes real UNLESS something
  // else keeps the tuple moving. That something is `state.lastTickAt()` — written every tick
  // regardless of what it did — which is what the tuple-sampling watchdog.ts fix (this round)
  // actually adds. This test is the regression guard for whoever implements #383: it stays green
  // after that change only because of the tuple fix, not because of anything #383 preserves.
  // (Some conductor.ts appendEvent sites are per-tick, like the two above; others are genuinely
  // transition-anchored, like the hold-visibility pair pr-held/pr-released via
  // state.lastHoldEvent. Which kind any given site is, is an implementation detail that can — and
  // per #383, will — change; the watchdog must not depend on which, which is exactly why it
  // samples last_tick_at too.)
  let stillWaiting = true;
  const gate: MergeGate = {
    driveOne: async (pr: number) =>
      stillWaiting ? { kind: "queued", pr, reason: "ci-pending" } : { kind: "merged", pr, headOid: "deadbeef" },
  };
  const state = new State(":memory:");
  const cfg = mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } });
  const exitCalls: number[] = [];
  const deps = baseDeps({
    forge,
    state,
    supervisor: sup,
    mergeGate: gate,
    cfg,
    // Fast real ticks so the drain loop cycles (and the watchdog's own sampling) quickly in
    // wall-clock time. windowMs = 0.02 * 1000 * 10 (default multiplier) = 200ms — several
    // multiples of a real tick's own (near-instant) duration, so many genuinely-healthy,
    // zero-new-event ticks happen inside one window, exactly the scenario under test.
    tickIntervalSec: 0.02,
    watchdogExit: (code) => exitCalls.push(code),
    stop: { afterIssuesMerged: 1 },
  });
  const runPromise = runRoundsGuarded(deps);
  // Comfortably past where the watchdog's own window (200ms) would have fired under the OLD
  // (event-log-only) design — proves the engine survived a full window (and then some) of a
  // healthy, event-quiet drain.
  await sleep(600);
  const stalled = state.eventsAfterId(0, ["engine-stalled"]);
  // Sanity: confirm the scenario actually reached the steady WAIT state this test is about,
  // not some other early exit.
  const queued = state.eventsAfterId(0, ["drive-queued"]);
  assert.deepEqual(
    exitCalls,
    [],
    "the liveness watchdog killed a HEALTHY, actively-ticking engine (event log quiet, but last_tick_at was advancing every tick) — the P1 shipping blocker",
  );
  assert.equal(stalled.length, 0, "no engine-stalled event should ever be appended for this healthy-drain scenario");
  assert.ok(queued.length >= 1, "sanity: the DRIVE loop actually reached the queued/WAIT outcome under test");
  // Let the PR "merge" so the round (and runRounds itself, via afterIssuesMerged) winds down and
  // returns cleanly — proper teardown (its watchdog stopped in runRounds's own `finally`) instead
  // of leaving background activity running past this test.
  stillWaiting = false;
  await runPromise;
  state.close();
});

// ── #433 (F33): a round is a DISPATCH window; lanes carry ACROSS rounds. A round whose own pool
// ── is empty must still run its tick loop for whatever lanes it inherited — reclaim/drive/resume
// ── everything but dispatch — or a carried lane is orphaned for the whole round (the 2026-07-29
// ── live shape: PR #423's verdict arrived mid-round and was consumed by nobody for six rounds).
// ── Empty pool + ZERO lanes still fast-closes (the very first test in this file). ───────────────

test("runRounds (#433): a DRIVING lane carried into a round with an EMPTY dispatch pool is driven EVERY tick — a verdict arriving mid-round reaches merge inside that same round, no human, no next round", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge(); // ready = [] — this round's pool is empty
  const sup = new FakeSupervisor();
  const state = new State(":memory:");
  // The carried lane: PR open, awaiting its Codex verdict (the #433 live shape, lane-377/PR #423).
  state.upsertWorker({ name: "lane-377", issue: 377, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 423 });
  // The verdict lands on the THIRD drive pass — i.e. mid-round, after the round's first tick.
  const gate = new ScriptedMergeGate([
    { kind: "queued", pr: 423, reason: "awaiting-review" },
    { kind: "queued", pr: 423, reason: "awaiting-review" },
    { kind: "merged", pr: 423, headOid: "H" },
  ]);
  const deps = baseDeps({ forge, state, supervisor: sup, sleep, mergeGate: gate, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }) });
  const stopSafety = boundedStopOnPhase(deps, 5); // round 1's five peripheral phases only
  const result = await runRoundsGuarded(deps);
  stopSafety();
  assert.equal(result.rounds, 1, "the merge happened inside the FIRST (empty-pool) round — no later round needed");
  assert.ok(gate.calls >= 3, `the carried lane must be driven every tick of the empty round, not once (drive passes: ${gate.calls})`);
  assert.equal(state.getWorker("lane-377")?.state, "done", "the verdict was consumed and the PR merged");
  state.close();
});

test("runRounds (#433): a carried lane whose fix rounds are EXHAUSTED gets its needs-human escalation evaluated in the empty-pool round, not silently skipped", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const state = new State(":memory:");
  const events = spyOnEvents(state);
  const cfg = mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } });
  // fix_rounds already AT the cap: the next FIXABLE gate can only escalate (driveDecision's
  // ESCALATE), which is exactly the path the six empty rounds never re-evaluated.
  state.upsertWorker({
    name: "lane-377",
    issue: 377,
    session_id: "s",
    state: "driving",
    started_at: "t",
    ended_at: "t2",
    pr: 423,
    fix_rounds: cfg.lanes.prFixCap,
  });
  const gate = new ScriptedMergeGate([{ kind: "fixable", pr: 423, reason: "ci-red" }]);
  const deps = baseDeps({ forge, state, supervisor: sup, sleep, mergeGate: gate, cfg });
  const stopSafety = boundedStopOnPhase(deps, 5);
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(
    events.some(([kind, payload]) => kind === "fix-rounds-capped" && (payload as { issue: number }).issue === 377),
    "the cap-exhausted escalation must be evaluated in the empty round",
  );
  assert.ok(
    forge.addLabelCalls.some(([n, l]) => n === 377 && l === cfg.labels.needsHuman),
    "the needs-human label reached GitHub — an operator can actually see it",
  );
  assert.equal(state.getWorker("lane-377")?.state, "failed");
  state.close();
});

test("runRounds (#433): standby must never withhold the next round while a CARRIED lane still needs the tick loop — a gated-reentry candidate a human unlabelled AFTER the round closed is picked up by the next round, not orphaned in backoff forever", async () => {
  const forge = new FakeForge(); // ready/planReview/triage all [] — an empty backlog, so standby engages
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { standby: { enabled: true } } });
  // The carried lane: the fix-round cap escalated it to needs-human with its PR still open (the
  // ONLY producer of a `failed`+pr row, #147/#246) — invisible to activeWorkers(), so its round
  // closed as "idle" with this lane still awaiting the engine's GATED RECLAIM.
  state.upsertWorker({
    name: "lane-377",
    issue: 377,
    session_id: "s",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 423,
    gated_escalation_labeled: 1,
  });
  forge.issueLabels[377] = [cfg.labels.needsHuman];
  const gate = new ScriptedMergeGate([{ kind: "merged", pr: 423, headOid: "H" }]);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    // Bounded, so the pre-fix behavior (standby backing off forever over a carried lane nobody
    // drives) FAILS these assertions instead of hanging the suite — same stance as the standby
    // tests above.
    if (sleepCalls.length >= 8) stop();
  };
  const deps = baseDeps({ forge, state, sleep, mergeGate: gate, tickIntervalSec: 5, cfg });
  // The human's explicit act — removing needs-human — lands only AFTER the first round has
  // closed, exactly like PR #423's verdict arriving between rounds. Nothing else changes: the
  // backlog stays empty, so this lane is the ONLY work left in the whole system.
  deps.onRoundPhase = (_roundId, phase) => {
    if (phase === "retro") forge.issueLabels[377] = [];
  };
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  await runRoundsGuarded(deps);
  assert.ok(state.getRound(2) != null, "a second round must open — a carried lane is work, so standby must not engage");
  assert.equal(state.getWorker("lane-377")?.state, "done", "the carried lane was reclaimed, re-driven and merged without a human merge");
  state.close();
});

test("runRounds standby (#630 AC3): a run whose ONLY gated-reentry candidate sits OUTSIDE the run's round.milestone reaches standby instead of idle-churning to the F32 breaker", async () => {
  const forge = new FakeForge(); // ready/planReview/triage/milestone-backlog all empty
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { milestone: "M-X", standby: { enabled: true } } });
  // The live-park batch-7 shape: a needs-human carrier with an open PR (a genuine
  // gatedFailedWorkers() candidate) whose issue sits in a DIFFERENT milestone than this run — and
  // the human hold is NEVER cleared (off-milestone, owner-timescale, not releasable this run).
  state.upsertWorker({
    name: "lane-144",
    issue: 144,
    session_id: "s",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 373,
    gated_escalation_labeled: 1,
  });
  forge.issueLabels[144] = [cfg.labels.needsHuman];
  forge.issueMilestone[144] = "v0.2.3"; // off this run's "M-X" scope
  // GATED RECLAIM must never even ask the gate: the human hold on #144 never clears.
  const gate = new ScriptedMergeGate([]);
  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, mergeGate: gate, tickIntervalSec: 5, cfg });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round — standby engaged after it, no idle-churn");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby actually engaged",
  );
  assert.equal(state.getRound(2), undefined, "no idle-churn round burned peripherals over a candidate this run can never consume");
  assert.equal(
    events.filter(([kind]) => kind === "idle-churn-detected").length,
    0,
    "the breaker never even samples a second identical round — standby is the first line",
  );
  assert.equal(gate.calls, 0, "GATED RECLAIM never consulted the merge gate — the human hold on #144 was never touched");
  state.close();
});

test("runRounds standby (#730 AC1): only human-blocked gated candidates are excluded, so the 2026-08-07 shape reaches standby", async () => {
  const forge = new FakeForge(); // ready/planReview/triage/milestone-backlog all empty
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { milestone: "M-X", standby: { enabled: true } } });
  state.upsertWorker({
    name: "lane-730",
    issue: 730,
    session_id: "s",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 1730,
    gated_escalation_labeled: 1,
  });
  forge.issueMilestone[730] = "M-X";
  forge.issueLabels[730] = [cfg.labels.needsHuman];

  const events = spyOnEvents(state);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 4) stop();
  };
  const deps = baseDeps({ forge, state, sleep, mergeGate: new ScriptedMergeGate([]), tickIntervalSec: 5, cfg });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };

  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "only the always-open first round runs when every re-entry candidate awaits a human");
  assert.ok(
    events.some(([kind]) => kind === "standby-wait"),
    "standby's no-work precondition holds",
  );
  assert.equal(state.getRound(2), undefined, "no idle-churn round is opened over human-blocked re-entry candidates");
  state.close();
});

test("runRounds (#730 gate② P1): an issue-side hold left after needs-human clears wakes standby and GATED RECLAIM consumes the clean PR", async () => {
  const forge = new FakeForge(); // ready/planReview/triage/milestone-backlog all empty
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { milestone: "M-X", standby: { enabled: true } } });
  state.upsertWorker({
    name: "lane-730-p1",
    issue: 730,
    session_id: "s",
    state: "failed",
    started_at: "t",
    ended_at: "t2",
    pr: 1730,
    gated_escalation_labeled: 1,
  });
  forge.issueMilestone[730] = "M-X";
  forge.issueLabels[730] = [cfg.labels.needsHuman];
  const gate = new ScriptedMergeGate([{ kind: "merged", pr: 1730, headOid: "H" }]);
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    if (sleepCalls.length >= 8) stop();
  };
  const deps = baseDeps({ forge, state, sleep, mergeGate: gate, tickIntervalSec: 5, cfg });
  // Between rounds, the human clears needs-human but leaves issue-side hold. #400 puts that
  // hold on the wrong carrier for a PR reentry, so the probe must open round 2 and RECLAIM.
  deps.onRoundPhase = (_roundId, phase) => {
    if (phase === "retro") forge.issueLabels[730] = [cfg.escalation.holdLabels[0]!];
  };
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };

  await runRoundsGuarded(deps);
  assert.ok(state.getRound(2) != null, "the issue-side hold must not make standby withhold the consumable gated reentry");
  assert.equal(state.getWorker("lane-730-p1")?.state, "done", "GATED RECLAIM consumed the clean PR, matching conductor.ts:3982");
  state.close();
});

test("runRounds (#431 AC3): the ceiling-wait loop announces the breach ONCE — many wait iterations, one reason-bearing ceiling-breach-entered, and the wait itself can no longer extend the budget", async () => {
  const forge = new FakeForge();
  forge.ready = []; // round 1 has no dispatch work — opens unconditionally, closes idle
  const state = new State(":memory:");
  const base = Date.parse("2026-07-31T00:00:00.000Z");
  // The process is ALREADY past its wall-clock cap when the run begins (200s alive, 100s cap):
  // after round 1 closes, waitForDispatchClear holds the next round open indefinitely. The
  // clock never advances during the wait — under the deleted machinery each iteration's
  // engineSessionStart WRITE was what kept the breached session alive (F29); now the wait
  // iterations are pure reads and the announcement is the loop's only ledger trace.
  const now = () => new Date(base + 200_000);
  const sleepCalls: number[] = [];
  let stop = (): void => {};
  const sleep = async (_ms: number): Promise<void> => {
    sleepCalls.push(_ms);
    if (sleepCalls.length >= 4) stop(); // several full wait iterations, then wind down
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    now,
    processStartedAt: new Date(base),
    tickIntervalSec: 1,
    cfg: mkCfg({ cost: { maxWallClockSec: 100 } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.ok(sleepCalls.length >= 4, "the loop actually sat out multiple ceiling-wait iterations");
  const announced = state.eventsAfterId(0, ["ceiling-breach-entered"]);
  assert.equal(announced.length, 1, "one announcement per breach episode — never per wait iteration (F29's silence AND spam both closed)");
  const payload = announced[0]!.payload as { reason: string; maxWallClockSec: number; wallClockElapsedSec: number };
  assert.equal(payload.reason, "wall-clock", "the event names WHICH ceiling (per-reason, round 3)");
  assert.equal(payload.maxWallClockSec, 100);
  assert.equal(payload.wallClockElapsedSec, 200);
  assert.ok(state.ceilingBreach() !== null, "the breach row stands for the whole wait");
  state.close();
});

test("runRounds (#431 round 2, codex P1): a standby dwell that outlives maxWallClockSec wakes into the BREACH-WAIT — announced once, and NO new round/peripherals ever open on this process life", async () => {
  // Codex's reproduction, encoded: cap 100s; round 1 opens at t=0 and closes idle; standby
  // dwells 60s + 120s of backoff (t=240s > cap); work then appears. Round 1's semantics are
  // untouched (it always opens); the WAKE must re-enter the same admission gate the pre-standby
  // path uses — never open a round (and run paid peripherals) on a process already past its cap.
  const forge = new FakeForge();
  const state = new State(":memory:");
  const base = Date.parse("2026-07-31T00:00:00.000Z");
  let ms = base;
  const now = () => new Date(ms);
  // Work appears only once the process is past its cap: empty board before t=150s, one Ready
  // issue after — pure clock steering, no call-count coupling.
  forge.getReadyIssues = async () => (ms - base > 150_000 ? [{ number: 9, title: "late work", labels: [] }] : []);
  const log: Array<{ phase: PeripheralPhase; marker: string | null }> = [];
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (requestedMs: number): Promise<void> => {
    sleepCalls.push(requestedMs);
    ms += requestedMs; // the dwell consumes process life — the exact F29-adjacent shape
    if (sleepCalls.length >= 8) stop(); // bounded safety net past the wake + several wait iterations
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    now,
    processStartedAt: new Date(base),
    tickIntervalSec: 60,
    cfg: mkCfg({ cost: { maxWallClockSec: 100 }, round: { standby: { enabled: true } } }),
    peripherals: allPeripherals(log),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1, "the wake never opened a round on a breached process");
  assert.equal(state.getRound(2), undefined, "no second round exists");
  assert.deepEqual(
    log.map((l) => l.phase),
    ["aligning", "architecting", "plan_review", "harvesting", "retro"],
    "round 1's peripherals only — the wake ran NO paid peripheral on the breached process",
  );
  const announced = state.eventsAfterId(0, ["ceiling-breach-entered"]);
  assert.equal(announced.length, 1, "the wake's admission gate announced the breach exactly once");
  assert.equal((announced[0]!.payload as { reason: string }).reason, "wall-clock");
  assert.ok(state.ceilingBreach() !== null, "the breach row stands — status/dashboard see the winding-down state");
  state.close();
});

test("runRounds (#431 round 4, codex finding 5): the ROUND-WAIT clear site's write order is receipt-BEFORE-row-delete — the twin of the tick-path ordering proxy", async () => {
  // A daily-budget breach that clears by UTC-midnight rollover DURING waitForDispatchClear:
  // round 1 ticks breached (entered + row), the pre-round-2 gate waits one iteration, the
  // sleep crosses midnight, and the second iteration performs the clear transition — whose
  // write order this test observes directly through a recording proxy.
  const st = new State(":memory:");
  const writes: string[] = [];
  const spied = new Proxy(st, {
    get(target, prop, receiver) {
      if (prop === "appendEvent") {
        return (kind: EventKind, payload: unknown) => {
          if (kind === "ceiling-breach-cleared") writes.push("append:ceiling-breach-cleared");
          target.appendEvent(kind, payload);
        };
      }
      if (prop === "clearCeilingBreach") {
        return () => {
          writes.push("row:delete");
          target.clearCeilingBreach();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as State;
  const forge = new FakeForge();
  forge.ready = [];
  const base = Date.parse("2026-07-06T23:59:00.000Z");
  let ms = base;
  const now = () => new Date(ms);
  st.recordSpend("w1", 1, 60, "2026-07-06T23:00:00.000Z", []); // $60 on the 6th, $50 cap -> breached until midnight
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (requestedMs: number): Promise<void> => {
    sleepCalls.push(requestedMs);
    ms += requestedMs; // the first wait iteration's sleep crosses midnight
    if (sleepCalls.length >= 10) stop(); // bounded safety net
  };
  const deps = baseDeps({
    forge,
    state: spied,
    sleep,
    now,
    processStartedAt: new Date(base),
    tickIntervalSec: 60,
    cfg: mkCfg({ cost: { dailyBudgetUsd: 50 } }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const stopSafety = boundedStopOnPhase(deps, 8);
  await runRoundsGuarded(deps);
  stopSafety();
  const clearSeq = writes.filter((w) => w === "append:ceiling-breach-cleared" || w === "row:delete");
  assert.equal(clearSeq.filter((w) => w === "append:ceiling-breach-cleared").length, 1, "exactly one clear transition happened");
  assert.equal(
    clearSeq[0],
    "append:ceiling-breach-cleared",
    "the LOG receipt lands strictly before any row delete at the round-wait site — the round-3 write rule, pinned here too",
  );
  const pair = st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).map((e) => e.kind);
  assert.deepEqual(
    pair,
    ["ceiling-breach-entered", "ceiling-breach-cleared"],
    "one daily episode, opened by round 1's tick and closed mid-wait",
  );
  st.close();
});

test("runRounds (#431 rounds 5-6, codex P1): the round-wait green-light clear respects a NON-LLM park — a green llm probe INSIDE the wait iteration never opens round 2 while rapid-restart stands", async () => {
  // Round 6 (codex): the round-5 version of this test was not genuinely red-first — with a
  // real clock and a non-advancing fake sleep, round 1's own tick consumed the one due ping
  // and the wait loop never observed a green probe, so the pre-fix predicate was never
  // exercised. This rewrite injects an ADVANCING clock (each fake sleep moves it 120s, past
  // the 30s probe backoff), captures an event-id cursor when round 1's LAST phase completes,
  // and PROVES a successful llm park-probe lands AFTER that cursor — i.e. inside the wait —
  // before asserting the gate held. Red-verified on ccb8a85 (the pre-fix predicate): the
  // wait's first green ping cleared the gate and opened round 2.
  const forge = new FakeForge();
  forge.ready = [];
  const state = new State(":memory:");
  const t0 = "2026-07-24T00:00:00.000Z"; // old entered/probe stamps -> the llm probe starts due
  state.enterPark("llm", "quota exhausted", null, t0);
  state.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: t0 });
  state.enterPark("rapid-restart", "crash loop suspected", null, t0);
  let ms = Date.parse("2026-07-31T00:00:00.000Z");
  const now = () => new Date(ms);
  let pings = 0;
  let round1ClosedAtEventId: number | null = null;
  let stop = (): void => {};
  const sleepCalls: number[] = [];
  const sleep = async (requestedMs: number): Promise<void> => {
    sleepCalls.push(requestedMs);
    ms += 120_000; // every wait advances the clock past the 30s probe backoff -> the NEXT wait iteration's probe is due
    if (sleepCalls.length >= 6) stop(); // several wait iterations, then wind down
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    now,
    processStartedAt: new Date(ms),
    tickIntervalSec: 1,
    probeLlmReachable: async () => {
      pings++;
      return true; // ALWAYS green — under the pre-fix predicate this cleared the gate and opened round 2
    },
    onRoundPhase: (roundId, phase) => {
      if (roundId === 1 && phase === "retro") round1ClosedAtEventId = state.maxEventId();
    },
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.ok(round1ClosedAtEventId !== null, "round 1 ran to its last phase");
  const waitProbes = state
    .eventsAfterId(round1ClosedAtEventId as unknown as number, ["park-probe"])
    .map((e) => e.payload as { source: string; success: boolean })
    .filter((p) => p.source === "llm" && p.success === true);
  assert.ok(
    waitProbes.length >= 1,
    "a SUCCESSFUL llm probe provably ran INSIDE the wait (after round 1 closed) — the gate was genuinely exercised",
  );
  assert.equal(result.rounds, 1, "round 1 only (its unconditional open) — the green light never cleared the gate");
  assert.equal(state.getRound(2), undefined, "no paid round 2 while the rapid-restart park stands");
  assert.ok(pings >= 2, "the probe ran in round 1's tick AND in the wait");
  assert.ok(state.parkRow("rapid-restart") !== null, "the non-llm park stands throughout");
  state.close();
});

// ── #470 (F32 backstop): the idle-churn breaker — K idle, state-identical rounds park with
// ── evidence. Standby stays the first line; this only ever sees churn standby failed to stop. ──

/** The F32 shape, reproduced with the mechanism F32 itself had (PR #466's "superset pool read"):
 *  a probe signal that counts work the DISPATCH path can never consume. `probeHasWork` reads the
 *  unscoped forge and sees a Ready issue, so standby never engages and a round opens every time;
 *  the executing phase reads through PoolScopedForge and sees nothing, so nothing is ever
 *  dispatched. Every round therefore closes idle, having appended exactly the same nothing. */
function mkF32Deps(state: State, sleep: (ms: number) => Promise<void>, threshold: number): RoundDeps {
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "unconsumable", body: "", labels: [], milestone: null } as unknown as Issue];
  return baseDeps({
    forge,
    state,
    sleep,
    // The pool label the executing phase scopes dispatch to — which issue #1 does NOT carry.
    poolLabel: "pool",
    cfg: mkCfg({
      round: { standby: { enabled: true }, idleChurn: { consecutiveIdenticalRoundsThreshold: threshold } },
    }),
  });
}

test("runRounds #470: K idle, state-identical rounds trip the idle-churn breaker exactly once — it parks, names the probe signal that held the loop open, and no further round opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-idle-churn-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    // Same "operator intervenes the moment the park lands" idiom the #374 empty-spin test uses:
    // polls durable park state, never a magic sleep-call count.
    const sleep = async (): Promise<void> => {
      if (state.isParked()) writeFileSync(join(dir, "KILL_SWITCH"), "");
    };
    const deps = mkF32Deps(state, sleep, 3);
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    const detected = state.eventsAfterId(0, ["idle-churn-detected"]);
    assert.equal(detected.length, 1, "the breaker fires EXACTLY once — never again every round after");
    const payload = detected[0]!.payload as { rounds: number; threshold: number; probeSignals: string[]; fingerprint: string };
    assert.equal(payload.rounds, 3);
    assert.equal(payload.threshold, 3);
    assert.deepEqual(
      payload.probeSignals,
      ["ready-issues"],
      "the ledger names the signal that held the round open — no source-reading required",
    );
    assert.equal(state.parkRow("idle-churn")?.triggerIssue, null, "parked under its own source, no trigger issue");
    assert.ok(
      state.parkRow("idle-churn")?.escalatedAt != null,
      "escalated at trip time (the local channel — this episode has no issue to comment on)",
    );
    assert.equal(result.rounds, 3, "rounds 1-3 closed idle; round 4 was withheld by the park, never opened");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #470: the streak is LEDGER-derived — a kill -9 mid-count resumes at the same number in a fresh process (no new column, no in-memory counter)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-idle-churn-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    // Run 1: two idle rounds, then "kill -9" (stop the loop, close the DB) mid-count.
    const state1 = new State(dbPath);
    const { sleep: sleep1 } = mkSleepSpy();
    const deps1 = mkF32Deps(state1, sleep1, 3);
    const stopSafety = boundedStopOnPhase(deps1, 10); // 2 rounds x 5 peripheral phases
    const first = await runRoundsGuarded(deps1);
    stopSafety();
    assert.equal(first.rounds, 2);
    assert.equal(state1.eventsAfterId(0, ["idle-churn-detected"]).length, 0, "two rounds is below the threshold");
    state1.close();
    // Run 2: a fresh process over the same ledger — the third idle round trips it.
    const state2 = new State(dbPath);
    const sleep2 = async (): Promise<void> => {
      if (state2.isParked()) writeFileSync(join(dir, "KILL_SWITCH"), "");
    };
    const deps2 = mkF32Deps(state2, sleep2, 3);
    const second = await runRoundsGuarded(deps2);
    assert.equal(second.stoppedBy, "kill-switch");
    const detected = state2.eventsAfterId(0, ["idle-churn-detected"]);
    assert.equal(detected.length, 1);
    assert.equal((detected[0]!.payload as { rounds: number }).rounds, 3, "the count continued across the process boundary — 2 + 1");
    assert.equal(second.rounds, 1, "the new process closed ONE round before the ledger-derived streak tripped");
    state2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRounds #470: a round that DISPATCHES never trips the breaker, however many rounds run", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5].map(
    (number) => ({ number, title: `t${number}`, body: "", labels: [], milestone: null }) as unknown as Issue,
  );
  const state = new State(":memory:");
  const deps = baseDeps({
    forge,
    state,
    sleep,
    supervisor: new AutoCompleteSupervisor(),
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 }, round: { idleChurn: { consecutiveIdenticalRoundsThreshold: 2 } } }),
  });
  const stopSafety = boundedStopOnPhase(deps, 20); // 4 rounds
  await runRoundsGuarded(deps);
  stopSafety();
  assert.ok(state.eventsAfterId(0, ["dispatched"]).length >= 3, "the fixture really did dispatch every round");
  assert.equal(state.eventsAfterId(0, ["idle-churn-detected"]).length, 0, "a round that put a lane in flight is never idle");
  assert.equal(state.isParked(), false);
  state.close();
});

test("runRounds #470: a legitimate WAIT — a driving lane on pending CI — never trips the breaker, even though its drive-queued events repeat identically every pass", async () => {
  const forge = new FakeForge(); // empty backlog: with standby ON, a genuinely idle loop STOPS closing rounds
  const state = new State(":memory:");
  let stop = () => {};
  // The lane's own terminal state ends the run — never a sleep-call count (timing-free).
  const sleep = async (): Promise<void> => {
    if (state.getWorker("lane-9")?.state === "done") stop();
  };
  state.upsertWorker({ name: "lane-9", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 91 });
  // Eight identical "still waiting on CI" passes before the verdict lands — the exact shape whose
  // repeated, byte-identical drive-queued payloads would look state-identical to a fingerprint
  // taken WITHOUT the lane-occupancy fact beside it.
  const gate = new ScriptedMergeGate([
    ...Array.from({ length: 8 }, () => ({ kind: "queued", pr: 91, reason: "awaiting-ci" }) as DriveOutcome),
    { kind: "merged", pr: 91, headOid: "H" },
  ]);
  const deps = baseDeps({
    forge,
    state,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({
      lanes: { max: 1, roundDispatchCap: 1 },
      round: { standby: { enabled: true }, idleChurn: { consecutiveIdenticalRoundsThreshold: 2 } },
    }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.ok(gate.calls >= 8, `the lane really did sit through repeated WAIT passes (drive passes: ${gate.calls})`);
  assert.equal(state.eventsAfterId(0, ["idle-churn-detected"]).length, 0, "a waited-on lane is not idle churn");
  assert.equal(state.isParked(), false);
  // The structural reason, pinned: the executing phase drains until no lane is in flight, so a
  // lane awaiting CI holds its round OPEN for as long as it waits. It cannot close eight
  // identical rounds; it closes ONE round that also carries the merge. Both facts (a round that
  // never closes, and a closed round whose fingerprint carries `merged`) keep it out of the
  // streak — no wait, however long, can accrue one.
  assert.equal(result.rounds, 1, "the whole eight-pass wait happened INSIDE one round — a WAIT closes no rounds at all");
  assert.equal(
    state.eventsAfterId(0, ["merged"]).length,
    1,
    "…and the one round it did close is the round that merged: a state CHANGE, never an identical repeat",
  );
  state.close();
});

test("runRounds #470: standby stays the FIRST line — a genuinely empty backlog (every open issue on a human hold) stops closing rounds at all, so the breaker never even gets a second sample", async () => {
  const forge = new FakeForge(); // ready/planReview/triage all empty: the held issues are off every consumable lane
  const state = new State(":memory:");
  let stop = () => {};
  let standbyWaits = 0;
  const sleep = async (): Promise<void> => {
    if (state.eventsAfterId(0, ["standby-wait"]).length > standbyWaits) {
      standbyWaits = state.eventsAfterId(0, ["standby-wait"]).length;
      if (standbyWaits >= 3) stop(); // standby is provably holding the loop; wind the run down
    }
  };
  const deps = baseDeps({
    forge,
    state,
    sleep,
    cfg: mkCfg({
      // Threshold 2: if standby did NOT hold, round 2 would close idle and identical and trip it.
      round: { standby: { enabled: true }, idleChurn: { consecutiveIdenticalRoundsThreshold: 2 } },
    }),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop);
    return () => {};
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.rounds, 1, "round 1 (always unconditional) closed idle; standby then withheld every round after it");
  assert.ok(standbyWaits >= 3, "standby genuinely engaged and kept backing off");
  assert.equal(
    state.eventsAfterId(0, ["idle-churn-detected"]).length,
    0,
    "no second closed round exists to compare — the breaker is downstream of standby by construction",
  );
  assert.equal(state.isParked(), false);
  state.close();
});

// ── #381 (F6): the executing phase's DRAIN wait is paced, never signal-abortable ─────────────

/** The drain-pacing probe. `sleep` logs its start, yields to a MACROTASK, then logs its end;
 *  the tests' own onTick logs a tick. A loop that actually AWAITS its wait produces strict
 *  wait-start -> wait-end -> tick alternation. The F6 busy loop — a signal-abortable wait on a
 *  path that keeps ticking after the signal — resolves on a MICROTASK instead, so its next tick
 *  lands between a wait-start and its own wait-end. Microtasks always precede macrotasks, so the
 *  discriminator here is ORDERING, not elapsed time: no wall-clock margin decides this verdict
 *  (docs/REVIEW-DOCTRINE.md's no-timing-dependent-assertions invariant). */
function drainPacingProbe(): { sleep: (ms: number) => Promise<void>; events: string[] } {
  const events: string[] = [];
  const sleep = async (ms: number): Promise<void> => {
    events.push(`wait-start:${ms}`);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    events.push("wait-end");
  };
  return { sleep, events };
}

/** Every wait is awaited to completion (nothing ticks inside one), and every wait is the
 *  configured cadence. */
function assertPacedWaits(events: string[], expectedMs: number, minWaits: number): void {
  const waits = events.filter((e) => e.startsWith("wait-start:"));
  assert.ok(waits.length >= minWaits, `expected >=${minWaits} paced waits, got ${waits.length} in ${JSON.stringify(events)}`);
  for (const w of waits) {
    assert.equal(w, `wait-start:${expectedMs}`, `every wait honors the configured cadence: ${JSON.stringify(events)}`);
  }
  for (const [i, e] of events.entries()) {
    if (!e.startsWith("wait-start:")) continue;
    assert.equal(events[i + 1], "wait-end", `a tick ran before the wait it was supposed to sit behind: ${JSON.stringify(events)}`);
  }
}

/** A lane that stays in flight for `alive` probes and then reports done — bounds the drain loop
 *  so a pacing regression FAILS the assertions below instead of hanging the suite. */
class CountdownSupervisor extends FakeSupervisor {
  constructor(private alive: number) {
    super();
  }
  override async probe(w: string): Promise<LaneProbe> {
    if (this.alive > 0) {
      this.alive--;
      return { done: false, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
    }
    return this.probes[w] ?? { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
  }
}

test("runRounds #381 (F6): a ROUND-STOPPED drain keeps ticking at tickIntervalSec after a stop signal — the signal-abortable wait made it a ms-interval busy loop", async () => {
  const { sleep, events } = drainPacingProbe();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "i1", labels: ["prio:3-feature"] }];
  const hits: RoundStopHit[] = [];
  let stop = (): void => {};
  const deps = baseDeps({
    forge,
    supervisor: new CountdownSupervisor(3),
    sleep,
    tickIntervalSec: 5,
    // cap 1: wave 1 dispatches issue 1 and the very next drain iteration records the round stop,
    // so every wait asserted below happens in the round-stopped state.
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    onRoundStop: (_id, hit) => hits.push(hit),
  });
  deps.registerSignals = (requestStop) => {
    stop = once(requestStop); // #380: latched — a re-signal on every tick would be a HARD EXIT
    return () => {};
  };
  deps.onTick = () => {
    events.push("tick");
    stop(); // the signal lands on the very first tick — the whole drain below runs post-signal
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.ok(
    hits.some((h) => h.name === "roundDispatchCap"),
    "the drain asserted below really did run in the round-stopped state",
  );
  assertPacedWaits(events, 5000, 3);
  deps.state.close();
});

test("runRounds #381 (F6): a KILL_SWITCH wind-down drain keeps ticking at tickIntervalSec after a stop signal — no busy loop, no log flood", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-"));
  try {
    const { sleep, events } = drainPacingProbe();
    const forge = new FakeForge();
    forge.ready = [{ number: 1, title: "i1", labels: ["prio:3-feature"] }];
    const state = new State(join(dir, "sapwood.sqlite"));
    let stop = (): void => {};
    const deps = baseDeps({
      forge,
      state,
      supervisor: new CountdownSupervisor(3),
      sleep,
      tickIntervalSec: 5,
      cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 3 } }),
    });
    deps.registerSignals = (requestStop) => {
      stop = once(requestStop); // #380: latched — a re-signal on every tick would be a HARD EXIT
      return () => {};
    };
    const drainingTicks: number[] = [];
    deps.onTick = (r) => {
      events.push("tick");
      if (r.ceilingReasons.includes("kill-switch")) drainingTicks.push(r.drainRequested.length);
      // Wind-down starts once the round is already executing with a lane in flight: the switch
      // freezes dispatch and drains inside tick(), and the signal arrives with it (the operator
      // who flips the switch is the same one hitting Ctrl-C — the F6 shape).
      writeFileSync(join(dir, "KILL_SWITCH"), "");
      stop();
    };
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.ok(drainingTicks.length >= 2, `the drain asserted below is the kill-switch wind-down, got ${JSON.stringify(drainingTicks)}`);
    assertPacedWaits(events, 5000, 3);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
