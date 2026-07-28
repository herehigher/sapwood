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

test("startProgressWatchdog (#395 gate② follow-up, P3): a THROWING enrich read degrades ONLY its own field(s) — sibling reads that succeed still populate normally, per-read independence, not all-or-nothing", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const enrich = {
    // Throws — exactly the corrupted-state case this record exists to diagnose.
    openRound: () => {
      throw new Error("simulated DB read failure");
    },
    // These three all SUCCEED with distinct, non-empty values — if the old all-or-nothing guard
    // regressed, EVERY one of these would be silently discarded by openRound()'s throw; the
    // assertion below pins that each is present and correct despite the sibling failure.
    activeWorkers: () =>
      [{}, {}, {}] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["activeWorkers"]>,
    drivingWorkers: () =>
      [{}, {}] as unknown as ReturnType<NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["drivingWorkers"]>,
    lastEventKind: () =>
      ({ id: 9, kind: "tick-error" }) as unknown as ReturnType<
        NonNullable<Parameters<typeof startProgressWatchdog>[0]["enrich"]>["lastEventKind"]
      >,
  };
  const handle = startProgressWatchdog({
    windowMs: 20,
    state,
    exit: (code) => exitCalls.push(code),
    eventPayload: { tickIntervalSec: 1 },
    enrich,
  });
  await sleep(80);
  assert.deepEqual(exitCalls, [1], "the nonzero exit still fires even though one enrichment read blew up");
  assert.equal(state.appended.length, 1);
  const [, payload] = state.appended[0]!;
  assert.deepEqual(payload, {
    tickIntervalSec: 1,
    lastTickAt: "T0",
    windowMs: 20,
    // Degraded — the ONLY field(s) touched by the throwing read.
    openRoundId: null,
    openRoundPhase: null,
    // NOT degraded — these three succeeded and must carry their real values, proving the throw
    // in openRound() did not discard them too.
    activeLaneCount: 3,
    gatedLaneCount: 2,
    lastEventId: 9,
    lastEventKind: "tick-error",
  });
  handle.stop();
});

test("startProgressWatchdog: event-log progress before the window elapses resets it — no false fire", async () => {
  // #403-class fix (this test was originally #395's, and flaked on CI as another instance of
  // #403 "date-bomb fixtures / timing-dependent tests"): the original version drove "progress"
  // via a real `sleep()` racing the watchdog's OWN internal setTimeout sampling loop — two
  // independent real timers whose relative ordering under a loaded scheduler is not guaranteed
  // (CI saw the watchdog complete its 4 consecutive unchanged samples before the test's `bump()`
  // landed). Rebuilt so "progress" is a pure function of the watchdog's own SAMPLE COUNT (how
  // many times maxEventId() has been called), never of elapsed wall-clock time: this fake bumps
  // its id on every 2nd sample -- strictly fewer than SAMPLES_PER_WINDOW (4 in watchdog.ts) -- so
  // unchangedSamples can structurally never accumulate to 4 consecutive unchanged reads, no
  // matter how the real setTimeout cadence actually gets scheduled. That makes "progress arrives
  // before the window elapses" a property of the call SEQUENCE, true on any machine at any
  // speed -- there is no longer a second clock to race against at all.
  let sampleCalls = 0;
  let id = 0;
  const state = {
    maxEventId: (): number => {
      sampleCalls++;
      if (sampleCalls % 2 === 0) id++;
      return id;
    },
    lastTickAt: (): string | null => "T0",
    appendEvent: (): void => {
      /* not exercised by this test -- it only asserts on exitCalls */
    },
  };
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 20, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  // Generous real-time margin -- safe to be generous here (unlike the original) because nothing
  // hinges on hitting an exact wall-clock boundary anymore: the reset-every-2-samples pattern
  // guarantees no fire no matter how many, or how few, samples actually land during this sleep.
  await sleep(400);
  assert.deepEqual(exitCalls, [], "progress reset the window on every sample pair — no stall was ever declared");
  assert.ok(
    sampleCalls >= 6,
    `sanity: the watchdog must have actually sampled several times to exercise the reset repeatedly, got ${sampleCalls}`,
  );
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
