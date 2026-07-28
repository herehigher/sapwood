// watchdog.test.ts (#395 gate② rounds 2-4): startProgressWatchdog is the core new logic behind
// the redesigned liveness watchdog — an INDEPENDENT background timer that fires only when BOTH
// state.maxEventId() AND state.lastTickAt() have gone unchanged for a full window, never raced
// against or keyed on the duration of any single tick() call. Uses a lightweight fake State (no
// real SQLite) so every assertion here is about the watchdog's own timing/firing logic, not
// database overhead — real setTimeout with generous margins (P2-4: CI-safe, since these tests
// assert both "fired" and "did not fire yet" at checkpoints comfortably clear of the window
// boundary either way).
//
// Round 3 (gate② P2): the round-2 shape sampled once per FULL window, which could take almost
// TWO windows to actually fire (if the last real event landed right after a check armed, that
// SAME check still saw the changed id and re-armed for another full window). The "fires within
// roughly one window, not two" test below is the regression test for that specific bug — it
// MEASURES silence duration end to end, not just "eventually fires."
//
// Round 4 (gate② P1): sampling maxEventId() ALONE is unsound the moment #383 (transition-dedupe
// drive-queued) lands — some conductor.ts appendEvent sites are per-tick today (drive-queued,
// review-silence-escalated), others transition-anchored; which kind any site is can change, and
// the watchdog must not depend on it either way. Fixed by ALSO sampling
// engine_session.last_tick_at (written on every tick regardless of what it did) and requiring
// BOTH signals to be unchanged before firing. The two new tuple-specific tests below pin that
// directly: maxEventId frozen but last_tick_at advancing must never fire; both frozen must.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startProgressWatchdog } from "./watchdog.js";

function fakeState(startId = 0): {
  maxEventId: () => number;
  lastTickAt: () => string | null;
  appendEvent: (kind: string, payload: unknown) => void;
  bump: () => void;
  tick: () => void;
  appended: Array<[string, unknown]>;
} {
  let id = startId;
  let tickAt: string | null = "T0";
  let tickSeq = 0;
  const appended: Array<[string, unknown]> = [];
  return {
    maxEventId: () => id,
    lastTickAt: () => tickAt,
    appendEvent: (kind, payload) => {
      appended.push([kind, payload]);
      id++; // appendEvent is itself progress, matching the real State/events-table behavior
    },
    bump: () => {
      id++;
    },
    // Simulates engine_session.last_tick_at advancing on a real tick — independent of
    // maxEventId, exactly like the real engine (a tick can run and touch last_tick_at without
    // appending any event at all).
    tick: () => {
      tickSeq++;
      tickAt = `T${tickSeq}`;
    },
    appended,
  };
}

test("startProgressWatchdog: no progress at all (both signals frozen) -> fires after windowMs, appends a durable engine-stalled event with the given payload, calls exit(1)", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({
    windowMs: 20,
    state,
    exit: (code) => exitCalls.push(code),
    eventPayload: { tickIntervalSec: 1, watchdogTickMultiplier: 1 },
  });
  await sleep(80); // comfortably past one 20ms window
  assert.deepEqual(exitCalls, [1]);
  assert.equal(state.appended.length, 1);
  // #395 item 2: the base payload (no `enrich` supplied here — that's covered separately below)
  // always carries lastTickAt/windowMs on top of the caller's own eventPayload — the two cheap
  // facts every stall record gets regardless of whether the richer `enrich` reads are wired up.
  assert.deepEqual(state.appended[0], [
    "engine-stalled",
    { tickIntervalSec: 1, watchdogTickMultiplier: 1, lastTickAt: "T0", windowMs: 20 },
  ]);
  handle.stop();
});

// ── #395 item 2: the `enrich` stall-record enrichment — open round id/phase, active/gated lane
// counts, last event id+kind — all read fresh AT FIRE TIME, never at construction time. ─────────

test("startProgressWatchdog (#395 item 2): with `enrich` supplied, the fired engine-stalled event carries openRoundId/openRoundPhase/activeLaneCount/gatedLaneCount/lastEventId/lastEventKind, read fresh at fire time", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  // A minimal fake satisfying the `enrich` pick — deliberately DIFFERENT values than anything the
  // base `state` fake reports, so a passing assertion can only be explained by the watchdog
  // actually calling these specific methods, not by coincidentally matching some other field.
  let openRoundCalls = 0;
  const enrich = {
    openRound: () => {
      openRoundCalls++;
      return { round_id: 42, phase: "executing" } as unknown as ReturnType<
        NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["openRound"]
      >;
    },
    activeWorkers: () =>
      [{}, {}] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["activeWorkers"]>,
    drivingWorkers: () =>
      [{}] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["drivingWorkers"]>,
    lastEventKind: () =>
      ({ id: 7, kind: "drive-queued" }) as unknown as ReturnType<
        NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["lastEventKind"]
      >,
  };
  const handle = startProgressWatchdog({
    windowMs: 20,
    state,
    exit: (code) => exitCalls.push(code),
    eventPayload: {},
    enrich,
  });
  await sleep(80);
  assert.deepEqual(exitCalls, [1]);
  assert.equal(openRoundCalls, 1, "enrich is read exactly once, at fire time, never during ordinary (non-firing) sampling");
  assert.equal(state.appended.length, 1);
  const [, payload] = state.appended[0]!;
  assert.deepEqual(payload, {
    lastTickAt: "T0",
    windowMs: 20,
    openRoundId: 42,
    openRoundPhase: "executing",
    activeLaneCount: 2,
    gatedLaneCount: 1,
    lastEventId: 7,
    lastEventKind: "drive-queued",
  });
  handle.stop();
});

test("startProgressWatchdog (#395 item 2): no open round (enrich.openRound() returns undefined) -> openRoundId/openRoundPhase are null, never a throw", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const enrich = {
    openRound: () => undefined as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["openRound"]>,
    activeWorkers: () => [] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["activeWorkers"]>,
    drivingWorkers: () => [] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["drivingWorkers"]>,
    lastEventKind: () =>
      undefined as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["lastEventKind"]>,
  };
  const handle = startProgressWatchdog({ windowMs: 20, state, exit: (code) => exitCalls.push(code), eventPayload: {}, enrich });
  await sleep(80);
  assert.deepEqual(exitCalls, [1]);
  const [, payload] = state.appended[0]!;
  assert.deepEqual(payload, {
    lastTickAt: "T0",
    windowMs: 20,
    openRoundId: null,
    openRoundPhase: null,
    activeLaneCount: 0,
    gatedLaneCount: 0,
    lastEventId: null,
    lastEventKind: null,
  });
  handle.stop();
});

test("startProgressWatchdog (#395 item 2): a THROWING enrich read still fires + still appends the base engine-stalled event (best-effort — enrichment is never load-bearing for the operative nonzero exit)", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const enrich = {
    openRound: () => {
      throw new Error("simulated DB read failure");
    },
    activeWorkers: () => [] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["activeWorkers"]>,
    drivingWorkers: () => [] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["drivingWorkers"]>,
    lastEventKind: () =>
      undefined as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["lastEventKind"]>,
  };
  const handle = startProgressWatchdog({
    windowMs: 20,
    state,
    exit: (code) => exitCalls.push(code),
    eventPayload: { tickIntervalSec: 1 },
    enrich,
  });
  await sleep(80);
  assert.deepEqual(exitCalls, [1], "the nonzero exit still fires even though enrichment blew up");
  assert.equal(state.appended.length, 1);
  assert.deepEqual(state.appended[0], ["engine-stalled", { tickIntervalSec: 1, lastTickAt: "T0", windowMs: 20 }]);
  handle.stop();
});

test("startProgressWatchdog: event-log progress before the window elapses resets it — no false fire", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 100, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  await sleep(30); // well inside the first 100ms window
  state.bump(); // progress happens
  await sleep(120); // total 150ms since start: past the FIRST window's original 100ms deadline,
  // but progress at t=30ms reset it — the NEXT check lands at roughly t=130ms, so t=150ms should
  // already have seen it reschedule again rather than fire; generous margin either side.
  assert.deepEqual(exitCalls, [], "progress reset the window — no stall was ever declared");
  handle.stop();
});

test("startProgressWatchdog: stop() prevents any firing, even well past the window", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 15, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  handle.stop();
  await sleep(80);
  assert.deepEqual(exitCalls, []);
});

test("startProgressWatchdog: fires exactly once and does not reschedule after firing", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 15, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  await sleep(120); // several windows' worth of continued quiet, if it were (wrongly) rescheduling
  assert.equal(exitCalls.length, 1, "fired exactly once, never re-armed after firing");
  handle.stop();
});

test("startProgressWatchdog (#395 gate② round 3, P2): fires within roughly ONE window of actual silence, not two — the worst case (the last real event lands right after arming) is bounded, not ~2x", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const windowMs = 120;
  const handle = startProgressWatchdog({ windowMs, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  // Progress lands almost immediately after arming — the exact worst case the round-2 (once-
  // per-window) design mishandled: a single-sample design would see this change on its FIRST
  // check (~t=windowMs), re-arm for a FULL second window, and not fire until close to 2x
  // windowMs despite there being no further progress at all after this point.
  await sleep(5);
  state.bump();
  // At well under one window of REAL silence since the bump, it must not have fired yet.
  await sleep(windowMs * 0.5);
  assert.deepEqual(exitCalls, [], "fired too early — before even one window of silence elapsed");
  // Comfortably past one window of silence, but still clearly under 2x windowMs (240ms here) —
  // if this were the round-2 bug, exitCalls would still be empty at this point.
  await sleep(windowMs * 1.1);
  assert.deepEqual(
    exitCalls,
    [1],
    "did not fire within roughly one window of actual silence — regression to the round-2 'up to ~2 windows' bug",
  );
  handle.stop();
});

// ── #395 gate② round 4, P1: the TUPLE itself — maxEventId() alone is not enough ────────────────

test("startProgressWatchdog (#395 gate② round 4, P1): maxEventId() frozen but last_tick_at ADVANCING every sample -> never fires — a real tick that appends nothing is still proof of life", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const windowMs = 40; // sampleMs = 10
  const handle = startProgressWatchdog({ windowMs, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  // Tick every 8ms (faster than the 10ms sample cadence) for well past what would have been
  // several stall windows under maxEventId()-only sampling — the event log never moves at all.
  for (let i = 0; i < 30; i++) {
    await sleep(8);
    state.tick();
  }
  assert.deepEqual(
    exitCalls,
    [],
    "last_tick_at kept advancing every real tick — this must never read as a stall, no matter how quiet the event log stays",
  );
  handle.stop();
});

test("startProgressWatchdog (#395 gate② round 4, P1): BOTH maxEventId() and last_tick_at frozen -> fires — neither signal alone is load-bearing, the tuple is", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const windowMs = 40;
  const handle = startProgressWatchdog({ windowMs, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  // Neither .bump() nor .tick() is ever called — both signals sit frozen at their starting value,
  // exactly the genuine-stall shape (a wedged tick reaches neither the appendEvent call nor the
  // engineSessionStart call that writes last_tick_at).
  await sleep(windowMs * 3);
  assert.deepEqual(exitCalls, [1], "both signals frozen must fire — this is the genuine stall the watchdog exists to catch");
  handle.stop();
});
