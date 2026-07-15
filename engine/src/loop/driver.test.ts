// driver.ts tests: the loop-driver mechanics (cadence, cadence -> tick() wiring, shutdown,
// --once / --until-idle) against a real State (:memory:) + fake forge/supervisor (no claude, no
// gh) — mirrors conductor.test.ts's tick test-double style.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import type { DriveOutcome } from "../roles/merge-driver.js";
import { State } from "../state/state.js";
import type { LaneProbe, MergeGate, Supervisor } from "./conductor.js";
import { type DriverDeps, runDriver } from "./driver.js";

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  ready: Issue[] = [];
  /** #76: countOpenIssuesInMilestone's canned answer — a mutable array so a test can simulate
   *  the count changing across calls (shift() per call; last value repeats once exhausted). */
  milestoneOpenCounts: number[] = [0];
  milestoneQueries: string[] = [];
  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return this.ready;
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(): Promise<void> {}
  async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  async getPRReviewData(): Promise<PRReviewData> {
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
  async getPRDiff(): Promise<string> {
    return "";
  }
  async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  async branchExists(): Promise<boolean> {
    return false;
  }
  /** Set to make countOpenIssuesInMilestone throw ONCE (then clear) — the P1 containment test. */
  milestoneErrOnce: Error | null = null;
  async countOpenIssuesInMilestone(milestone: string): Promise<number> {
    this.milestoneQueries.push(milestone);
    if (this.milestoneErrOnce) {
      const e = this.milestoneErrOnce;
      this.milestoneErrOnce = null;
      throw e;
    }
    return this.milestoneOpenCounts.length > 1 ? this.milestoneOpenCounts.shift()! : this.milestoneOpenCounts[0]!;
  }
  milestoneTitles: string[] = [];
  async listMilestoneTitles(): Promise<string[]> {
    return this.milestoneTitles;
  }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  async getIssueLabels(): Promise<string[]> {
    return [];
  }
  async getIssueComments() {
    return [];
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  /** #76: every issue number ever passed to dispatch() — the wind-down tests' proof that a
   *  stop-condition freeze actually prevented a NEW dispatch, not just that there was nothing
   *  eligible to dispatch. */
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
  requestHandoff(): boolean {
    return true;
  }
}

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" }, ...over });

/** A no-op sleep the test can observe (records requested ms, resolves immediately — no real
 *  wall-clock wait in the test suite). */
function mkSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

const baseDeps = (over: Partial<DriverDeps> = {}): DriverDeps => ({
  forge: new FakeForge(),
  state: new State(":memory:"),
  supervisor: new FakeSupervisor(),
  cfg: mkCfg(),
  tickIntervalSec: 5,
  registerSignals: () => () => {}, // no-op by default: tests that want a signal inject their own
  ...over,
});

test("runDriver: ticks at least once, sleeping the configured tickIntervalSec between ticks (forever mode)", async () => {
  const { sleep, calls } = mkSleepSpy();
  const forge = new FakeForge();
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 5 });
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  // Stop after the 3rd tick by signalling once we've seen enough sleeps.
  let ticks = 0;
  deps.onTick = () => {
    ticks++;
    if (ticks >= 3) stop();
  };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 3);
  // Slept between ticks 1->2 and 2->3 at the configured cadence (in ms); the loop must not
  // sleep again after the 3rd tick once a stop was requested.
  assert.deepEqual(calls, [5000, 5000]);
  deps.state.close();
});

test("runDriver: TickDeps.tickIntervalSec is threaded into tick() (wall-clock ceiling wiring, #46 scope 1)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 42, stopMode: "once" });
  let seenIntervalSec: number | undefined;
  deps.onTick = () => {
    // tick() itself doesn't echo its deps back, so we assert on the deps object the driver
    // actually passed to tick() — the SAME object runDriver was given.
    seenIntervalSec = deps.tickIntervalSec;
  };
  await runDriver(deps);
  assert.equal(seenIntervalSec, 42);
  deps.state.close();
});

test("runDriver --once: runs exactly one tick and stops, without sleeping", async () => {
  const { sleep, calls } = mkSleepSpy();
  const deps = baseDeps({ sleep, stopMode: "once" });
  const result = await runDriver(deps);
  assert.deepEqual(result, { ticks: 1, tickErrors: 0, stoppedBy: "once" });
  assert.deepEqual(calls, []); // no inter-tick sleep — the driver stops immediately after tick 1
  deps.state.close();
});

test("runDriver --until-idle: stops once a tick leaves nothing in flight and dispatches nothing", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // empty Ready queue -> nothing to dispatch, nothing running -> idle immediately
  const deps = baseDeps({ forge, sleep, stopMode: "until-idle" });
  const result = await runDriver(deps);
  assert.deepEqual(result, { ticks: 1, tickErrors: 0, stoppedBy: "idle" });
  deps.state.close();
});

test("runDriver --until-idle: keeps ticking while a dispatched lane is still active", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const deps = baseDeps({ forge, supervisor: sup, sleep, stopMode: "until-idle", cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }) });
  // After tick 1, the issue is dispatched and running (still in flight) -> not idle -> tick 2
  // sees the same lane still "running" (FakeSupervisor's default probe never completes it) ->
  // still not idle. Bound the test with a manual stop via a signal after a few ticks so a bug
  // that never detects idle doesn't hang the suite forever.
  let ticks = 0;
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onTick = () => {
    ticks++;
    if (ticks >= 3) stop();
  };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal"); // never reached "idle" — the lane stayed active
  assert.equal(ticks, 3);
  deps.state.close();
});

test("runDriver: a signal mid-sleep stops the loop before the next tick starts (clean shutdown, never mid-tick)", async () => {
  const calls: number[] = [];
  let requestStopRef: (() => void) | undefined;
  const sleep = async (ms: number): Promise<void> => {
    calls.push(ms);
    requestStopRef?.(); // simulate SIGINT arriving while "sleeping" between ticks
  };
  const deps = baseDeps({ sleep });
  deps.registerSignals = (requestStop) => {
    requestStopRef = requestStop;
    return () => {};
  };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 1); // exactly one (completed) tick — the signal fired during the sleep, not mid-tick
  assert.deepEqual(calls, [5000]);
  deps.state.close();
});

test("runDriver: registerSignals teardown is invoked exactly once when the loop stops", async () => {
  const { sleep } = mkSleepSpy();
  let unregisterCalls = 0;
  const deps = baseDeps({
    sleep,
    stopMode: "once",
    registerSignals: () => () => {
      unregisterCalls++;
    },
  });
  await runDriver(deps);
  assert.equal(unregisterCalls, 1);
  deps.state.close();
});

test("runDriver: onTick is called once per completed tick with that tick's TickResult", async () => {
  const { sleep } = mkSleepSpy();
  const results: unknown[] = [];
  const deps = baseDeps({ sleep, stopMode: "once", onTick: (r) => results.push(r) });
  await runDriver(deps);
  assert.equal(results.length, 1);
  assert.ok(Array.isArray((results[0] as { dispatched: unknown[] }).dispatched));
  deps.state.close();
});

// ── Codex PR #50 driver.ts:126: a signal must ABORT the inter-tick sleep, not wait it out ──

test("runDriver: a signal during the inter-tick sleep wakes it immediately — shutdown never waits out the cadence", async () => {
  // The injected sleep NEVER resolves: if shutdown depended on the sleep completing (the old
  // behavior — signal only flipped a flag the loop checked after the full await), this test
  // would hang until the suite timeout. The signal-abort race is the only way out.
  let stop = () => {};
  const deps = baseDeps({ sleep: () => new Promise<void>(() => {}) });
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onTick = () => {
    // Deliver the signal asynchronously, AFTER the loop has entered the inter-tick wait —
    // modeling a real SIGTERM landing mid-sleep.
    setTimeout(() => stop(), 10);
  };
  const result = await runDriver(deps); // resolves promptly only if the signal aborts the wait
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 1); // the completed tick, then an aborted sleep — never a second tick
  deps.state.close();
});

test("runDriver: a signal arriving between the post-tick check and the sleep arming still aborts (no missed wake)", async () => {
  // The injected sleep never resolves; the "signal" fires SYNCHRONOUSLY inside the sleep call
  // itself — i.e. after the loop's post-tick `if (signalled)` check already passed, in the
  // narrow window where a wake could be missed. interTickWait's post-arm re-check covers it.
  let stop = () => {};
  const deps = baseDeps({
    sleep: () => {
      stop(); // signal lands exactly while the wait is being armed
      return new Promise<void>(() => {});
    },
  });
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 1);
  deps.state.close();
});

// ── PR #50 P2 #1: tick() throws are contained — a transient forge blip must not kill the daemon ──

test("runDriver: a tick() throw is contained — logged as a tick-error event, normal-cadence sleep, next tick runs", async () => {
  const { sleep, calls } = mkSleepSpy();
  const forge = new FakeForge();
  // First getReadyIssues call throws (a transient GitHub 5xx during the DISPATCH phase — one
  // of the unguarded awaits inside tick()); every later call succeeds.
  let failures = 1;
  const realGetReady = forge.getReadyIssues.bind(forge);
  forge.getReadyIssues = async () => {
    if (failures > 0) {
      failures--;
      throw new Error("HTTP 502: GitHub is having a moment");
    }
    return realGetReady();
  };
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 5 });
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  // Stop after the first SUCCESSFUL tick — which must be the attempt AFTER the contained throw.
  deps.onTick = () => stop();
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.tickErrors, 1); // the blip was counted...
  assert.equal(result.ticks, 1); // ...and the daemon survived to complete the next tick
  // The failed attempt slept the NORMAL cadence before retrying — contained, never a hot loop.
  // (The durable tick-error event trace is asserted in the next test via an appendEvent spy.)
  assert.deepEqual(calls, [5000]);
  deps.state.close();
});

test("runDriver: the contained tick() throw is recorded as a structured tick-error event", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.getReadyIssues = async () => {
    throw new Error("HTTP 502");
  };
  const deps = baseDeps({ forge, sleep, stopMode: "once" });
  const logged: Array<[string, unknown]> = [];
  const realAppend = deps.state.appendEvent.bind(deps.state);
  deps.state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const result = await runDriver(deps);
  assert.deepEqual(result, { ticks: 0, tickErrors: 1, stoppedBy: "once" }); // --once: one ATTEMPT, then stop
  assert.ok(
    logged.some(([kind, payload]) => kind === "tick-error" && /HTTP 502/.test(String((payload as { error: string }).error))),
    "tick-error event with the original error text",
  );
  deps.state.close();
});

test("runDriver: a persistently-throwing tick keeps the daemon looping at normal cadence (never exits, never hot-loops)", async () => {
  const calls: number[] = [];
  let stop = () => {};
  const sleep = async (ms: number): Promise<void> => {
    calls.push(ms);
    if (calls.length >= 3) stop(); // bound the test: signal after 3 failed rounds
  };
  const forge = new FakeForge();
  forge.getReadyIssues = async () => {
    throw new Error("still down");
  };
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 5 });
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 0);
  assert.equal(result.tickErrors, 3); // three contained failures, three normal-cadence sleeps
  assert.deepEqual(calls, [5000, 5000, 5000]);
  deps.state.close();
});

// ── #76: goal-based stop conditions ─────────────────────────────────────────────────────────

/** A merge gate whose driveOne outcome is scripted call-by-call (unlike conductor.test.ts's
 *  FakeMergeGate, keyed per-pr) — lets a test simulate a driving lane sitting QUEUED for a few
 *  ticks before it finally resolves, so the wind-down's "in-flight lanes finish, never killed"
 *  claim is actually exercised across multiple ticks rather than resolving on the very first. */
class ScriptedMergeGate implements MergeGate {
  calls = 0;
  constructor(private readonly outcomes: DriveOutcome[]) {}
  async driveOne(pr: number): Promise<DriveOutcome> {
    const i = this.calls;
    this.calls++;
    return this.outcomes[Math.min(i, this.outcomes.length - 1)] ?? { kind: "queued", pr, reason: "default" };
  }
}

/** A bounded safety net so a driver bug (stop condition never detected / never idle) fails the
 *  test instead of hanging the suite — real correct behavior always returns well before this. */
function boundedStop(deps: DriverDeps, maxTicks: number): () => void {
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  let ticks = 0;
  const prevOnTick = deps.onTick;
  deps.onTick = (r) => {
    prevOnTick?.(r);
    ticks++;
    if (ticks >= maxTicks) stop();
  };
  return () => stop();
}

test("runDriver stop.afterIssuesMerged: hitting it winds the run down (no kill) then exits, naming the condition — in default 'forever' mode, no --until-idle needed", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  const gate = new ScriptedMergeGate([{ kind: "merged", pr: 1, headOid: "H" }]);
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterIssuesMerged: 1 },
  });
  // Claiming removes an issue from Ready in the real forge; the fake must mimic that or the
  // (never-reached, thanks to the pause) DISPATCH phase would just re-dispatch #1 forever.
  deps.onTick = (r) => {
    for (const d of r.dispatched) if (d.kind === "dispatched") forge.ready = [];
  };
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterIssuesMerged", threshold: 1, detail: "merged 1" });
  assert.equal(gate.calls, 1); // driven to completion once — never re-driven, never killed mid-work
  assert.equal(deps.state.activeWorkers().length, 0); // wound down to a clean, idle stop
  deps.state.close();
});

test("runDriver stop.afterPRsOpened: fires the moment a lane's PR is first discovered (reclaim -> driving), independent of merge outcome", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  // The PR is escalated to needs-human, never merged — proves afterPRsOpened counts the PR
  // becoming known to the engine, not a successful merge (that's afterIssuesMerged's job).
  const gate = new ScriptedMergeGate([{ kind: "needs-human", pr: 1, reason: "test" }]);
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterPRsOpened: 1 },
  });
  deps.onTick = (r) => {
    for (const d of r.dispatched) if (d.kind === "dispatched") forge.ready = [];
  };
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterPRsOpened", threshold: 1, detail: "opened 1" });
  assert.equal(deps.state.activeWorkers().length, 0);
  deps.state.close();
});

test("runDriver stop.onMilestoneComplete: evaluated at tick boundaries, fires only once the forge reports zero open issues left", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // no dispatch activity at all — this test isolates the milestone check itself
  forge.milestoneOpenCounts = [2, 1, 0];
  const deps = baseDeps({ forge, sleep, stop: { onMilestoneComplete: "M4" } });
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  assert.equal(result.ticks, 3); // checked every tick boundary — 2 misses, then the hit
  assert.deepEqual(forge.milestoneQueries, ["M4", "M4", "M4"]);
  deps.state.close();
});

test("runDriver stop.onMilestoneComplete: a THROWING forge read is contained — tick-error + keep looping, never a daemon crash, never a fired condition (fable gate② P1)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneErrOnce = new Error("gh: HTTP 502 from GitHub"); // transient outage on tick 1
  forge.milestoneOpenCounts = [0]; // tick 2's read succeeds and reports complete
  const deps = baseDeps({ forge, sleep, stop: { onMilestoneComplete: "M4" } });
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps); // must NOT reject
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition"); // survived the failure, stopped on the retry
  assert.equal(result.ticks, 2);
  assert.equal(result.tickErrors, 1); // the failed read was recorded, not swallowed
  deps.state.close();
});

test("runDriver stop conditions: --once still NAMES a condition that fired on its single tick (stoppedBy stays 'once')", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [];
  forge.milestoneOpenCounts = [0];
  const deps = baseDeps({ forge, sleep, stopMode: "once" as const, stop: { onMilestoneComplete: "M4" } });
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "once");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" });
  deps.state.close();
});

test("runDriver stop conditions: OR semantics — whichever fires FIRST wins and is never overwritten by a later condition also becoming true", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: true, prNumber: 1 };
  // Stays "queued" (driving, undecided) for 2 ticks, THEN merges — long enough that
  // afterPRsOpened (satisfied the instant the PR is discovered) fires several ticks before
  // afterIssuesMerged ever could.
  const gate = new ScriptedMergeGate([
    { kind: "queued", pr: 1, reason: "pending" },
    { kind: "queued", pr: 1, reason: "pending" },
    { kind: "merged", pr: 1, headOid: "H" },
  ]);
  // Room for a SECOND lane so a dispatch freeze failure would be observable (issue #2 could
  // otherwise slot into the free lane while #1 is still driving).
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    mergeGate: gate,
    cfg: mkCfg({ lanes: { max: 2, roundDispatchCap: 1 } }),
    stop: { afterPRsOpened: 1, afterIssuesMerged: 1 },
  });
  deps.onTick = (r) => {
    for (const d of r.dispatched)
      if (d.kind === "dispatched") {
        forge.ready = forge.ready.filter((i) => i.number !== d.issue);
      }
    // Once #1's PR is discovered (this run's actual afterPRsOpened trigger), a second issue
    // becomes Ready. If the wind-down freeze is broken, this is exactly what would get
    // wrongly dispatched into the still-free second lane on a later tick.
    const prJustOpened = r.reclaimed.some(
      (x) =>
        (x.kind === "done" && x.next === "DRIVING") || (x.kind === "failed" && x.next === "DRIVING") || (x.kind === "dead" && x.rescued),
    );
    if (prJustOpened) forge.ready.push({ number: 2, title: "t2", labels: ["prio:3-feature"] });
  };
  const stopSafety = boundedStop(deps, 15);
  const result = await runDriver(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  // afterPRsOpened won — even though a merge (which would satisfy afterIssuesMerged too)
  // eventually happened later in the same run.
  assert.deepEqual(result.stopCondition, { name: "afterPRsOpened", threshold: 1, detail: "opened 1" });
  assert.equal(gate.calls, 3); // driven through all 3 scripted polls to its natural conclusion
  assert.deepEqual(sup.dispatchedIssues, [1]); // #2 was NEVER dispatched despite a free lane
  assert.equal(deps.state.activeWorkers().length, 0);
  deps.state.close();
});

// ── #154: stop.afterSpendUsd — per-run spend budget ─────────────────────────────────────────

test("runDriver stop.afterSpendUsd: hitting the ledgered run-spend threshold winds the run down (no kill) then exits, naming the condition", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  // done, no PR — reclaimTerminalLane still records the terminal costUsd into spend_ledger
  // regardless of merge-gate activity, so this test needs no ScriptedMergeGate at all.
  sup.probes["lane-1-1"] = { done: true, failed: false, handoff: false, hbAge: 5, wrapperAlive: 1, hasPr: false, costUsd: 25 };
  const deps = baseDeps({
    forge,
    supervisor: sup,
    sleep,
    cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }),
    stop: { afterSpendUsd: 20 },
  });
  deps.onTick = (r) => {
    for (const d of r.dispatched) if (d.kind === "dispatched") forge.ready = [];
  };
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 20, detail: "spent $25.00" });
  assert.equal(deps.state.activeWorkers().length, 0); // wound down to a clean, idle stop, never killed
  deps.state.close();
});

test("runDriver stop.afterSpendUsd: anchored to THIS run's start — spend already ledgered by a PRIOR run is never inherited (a restart starts back at $0)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // isolates the anchor from any dispatch activity
  const state = new State(":memory:");
  // A prior run's already-banked spend, well past the $10 threshold this run configures.
  state.recordSpend("prior-run-worker", 999, 50, new Date().toISOString(), []);
  const deps = baseDeps({ forge, state, sleep, stop: { afterSpendUsd: 10 } });
  const stopSafety = boundedStop(deps, 5);
  const result = await runDriver(deps);
  stopSafety();
  // Never fired: this run's OWN ledgered spend (summed from its own startup anchor forward) is
  // $0 — the pre-existing $50 belongs to an earlier run/process and must not carry over.
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.stopCondition, undefined);
  deps.state.close();
});

test("runDriver stop.afterSpendUsd: configured-but-uncrossed NEVER swallows the chain — a later condition (onMilestoneComplete) still fires (gate② B1 on PR #160)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = []; // no dispatch/spend at all — afterSpendUsd stays configured-but-uncrossed forever
  forge.milestoneOpenCounts = [1, 0]; // tick 1: not complete; tick 2: completes mid-run
  const deps = baseDeps({ forge, sleep, stop: { afterSpendUsd: 100, onMilestoneComplete: "M5" } });
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  // The broken else-if chain would terminate at the uncrossed spend branch every tick and
  // never evaluate the milestone at all (boundedStop's signal would end the run instead).
  assert.equal(result.stoppedBy, "stop-condition");
  assert.deepEqual(result.stopCondition, { name: "onMilestoneComplete", threshold: "M5", detail: "0 open issues left" });
  assert.deepEqual(forge.milestoneQueries, ["M5", "M5"]); // evaluated every tick, not starved
  deps.state.close();
});

test("runDriver stop.afterSpendUsd: a quiet gap that resets the wall-clock SESSION mid-run never resets the run-spend total (standby/quiet-gap semantics)", async () => {
  const { sleep } = mkSleepSpy();
  const forge = new FakeForge();
  forge.ready = [];
  let nowMs = new Date("2026-07-13T00:00:00Z").getTime();
  const now = () => new Date(nowMs);
  const deps = baseDeps({ forge, sleep, now, tickIntervalSec: 5, stop: { afterSpendUsd: 10 } });
  // Spy on the underlying session-start bookkeeping to PROVE a reset actually happened, rather
  // than just asserting the spend total's own behavior.
  const sessionStarts: string[] = [];
  const realSessionStart = deps.state.engineSessionStart.bind(deps.state);
  deps.state.engineSessionStart = (n: Date, gap: number) => {
    const r = realSessionStart(n, gap);
    sessionStarts.push(r.toISOString());
    return r;
  };
  let tickCount = 0;
  deps.onTick = () => {
    tickCount++;
    if (tickCount === 1) {
      deps.state.recordSpend("w1", 1, 6, now().toISOString(), []); // $6 — below the $10 threshold
      // Jump 20 minutes — past engineSessionGapSec (max(900s, 2*5s) = 900s) — so the NEXT tick's
      // engineSessionStart call resets the wall-clock session.
      nowMs += 20 * 60 * 1000;
    } else if (tickCount === 2) {
      deps.state.recordSpend("w2", 2, 5, now().toISOString(), []); // +$5 = $11 total, crosses $10
    }
  };
  const stopSafety = boundedStop(deps, 10);
  const result = await runDriver(deps);
  stopSafety();
  assert.notEqual(sessionStarts[0], sessionStarts[sessionStarts.length - 1], "the wall-clock session DID reset mid-run");
  assert.equal(result.stoppedBy, "stop-condition");
  // $6 (tick 1) + $5 (tick 2) = $11, summed straight through the session reset — the run-spend
  // anchor is a separate, session-independent id-cursor.
  assert.deepEqual(result.stopCondition, { name: "afterSpendUsd", threshold: 10, detail: "spent $11.00" });
  deps.state.close();
});
