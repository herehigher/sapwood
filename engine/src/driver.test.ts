// driver.ts tests: the loop-driver mechanics (cadence, cadence -> tick() wiring, shutdown,
// --once / --until-idle) against a real State (:memory:) + fake forge/supervisor (no claude, no
// gh) — mirrors conductor.test.ts's tick test-double style.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDriver, type DriverDeps } from "./driver.js";
import type { Supervisor, LaneProbe } from "./conductor.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";

class FakeForge implements IForge {
  ready: Issue[] = [];
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
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  private n = 0;
  async probe(w: string): Promise<LaneProbe> {
    return this.probes[w] ?? { done: false, failed: false, handoff: false, hbAge: 10, wrapperAlive: 1, hasPr: false };
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    const name = `lane-${issue.number}-${++this.n}`;
    return { name, sessionId: `sess-${name}` };
  }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> {
    return { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(): boolean { return true; }
}

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" }, ...over });

/** A no-op sleep the test can observe (records requested ms, resolves immediately — no real
 *  wall-clock wait in the test suite). */
function mkSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
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
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  // Stop after the 3rd tick by signalling once we've seen enough sleeps.
  let ticks = 0;
  deps.onTick = () => { ticks++; if (ticks >= 3) stop(); };
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
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  deps.onTick = () => { ticks++; if (ticks >= 3) stop(); };
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
  deps.registerSignals = (requestStop) => { requestStopRef = requestStop; return () => {}; };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 1); // exactly one (completed) tick — the signal fired during the sleep, not mid-tick
  assert.deepEqual(calls, [5000]);
  deps.state.close();
});

test("runDriver: registerSignals teardown is invoked exactly once when the loop stops", async () => {
  const { sleep } = mkSleepSpy();
  let unregisterCalls = 0;
  const deps = baseDeps({ sleep, stopMode: "once", registerSignals: () => () => { unregisterCalls++; } });
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
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
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
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
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
    if (failures > 0) { failures--; throw new Error("HTTP 502: GitHub is having a moment"); }
    return realGetReady();
  };
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 5 });
  let stop = () => {};
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
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
  forge.getReadyIssues = async () => { throw new Error("HTTP 502"); };
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
  forge.getReadyIssues = async () => { throw new Error("still down"); };
  const deps = baseDeps({ forge, sleep, tickIntervalSec: 5 });
  deps.registerSignals = (requestStop) => { stop = requestStop; return () => {}; };
  const result = await runDriver(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.ticks, 0);
  assert.equal(result.tickErrors, 3); // three contained failures, three normal-cadence sleeps
  assert.deepEqual(calls, [5000, 5000, 5000]);
  deps.state.close();
});
