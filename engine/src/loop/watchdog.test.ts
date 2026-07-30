// watchdog.test.ts (#395 gate② rounds 2-4): startProgressWatchdog is the core new logic behind
// the redesigned liveness watchdog — an INDEPENDENT background timer that fires only when BOTH
// state.maxEventId() AND state.lastTickAt() have gone unchanged for a full window, never raced
// against or keyed on the duration of any single tick() call. Uses a lightweight fake State (no
// real SQLite) so every assertion here is about the watchdog's own timing/firing logic, not
// database overhead.
//
// #403 (F25): the original "generous real-time margins" stance was wrong, and this file was one
// of the class's live instances (a false fire at watchdog.test.ts:218 reddened `main` after PR
// #405). No assertion here is decided by wall-clock margins any more. Two shapes replaced them:
//   - "it must have fired": `waitFor` polls until it does, with a NAMED hang-guard message. The
//     guard bounds catastrophe; it never decides the verdict.
//   - "it must fire at the right TIME / must not fire": expressed against the watchdog's own
//     SAMPLE COUNT (fakeState.samples()), which is the only clock either side reads. Those
//     properties are then true on any machine at any speed — there is no second timer to race.
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

/** #403 (F25): wait until `predicate` holds, polling on a short cadence, and reject with a NAMED
 *  message if it never does. This replaces every `await sleep(N); assert(fired)` in this file.
 *
 *  The difference is not cosmetic. `sleep(80)` then asserting "it fired" makes 80ms a LOAD-BEARING
 *  margin — the verdict is decided by whether the watchdog's real timer beat the test's real
 *  timer, which under concurrent load (the condition this suite actually failed under, #403
 *  instance 2) is a coin flip nobody tuned for. Polling inverts that: the test fails only if the
 *  event never happens at all, and `timeoutMs` is a pure hang guard — an order of magnitude above
 *  any window under test, chosen to bound catastrophe rather than to decide anything. A run that
 *  is 10x slower than expected still passes. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`hang guard (${timeoutMs}ms): ${message}`);
    await sleep(2);
  }
}

function fakeState(startId = 0): {
  maxEventId: () => number;
  lastTickAt: () => string | null;
  appendEvent: (kind: string, payload: unknown) => void;
  bump: () => void;
  tick: () => void;
  /** How many times the watchdog has SAMPLED the tuple — the deterministic "clock" the
   *  timing-sensitive tests below assert against instead of elapsed wall-clock time. */
  samples: () => number;
  appended: Array<[string, unknown]>;
} {
  let id = startId;
  let tickAt: string | null = "T0";
  let tickSeq = 0;
  let sampleCount = 0;
  const appended: Array<[string, unknown]> = [];
  return {
    maxEventId: () => {
      sampleCount++; // the watchdog reads this exactly once per sample — see startProgressWatchdog's `check`
      return id;
    },
    lastTickAt: () => tickAt,
    samples: () => sampleCount,
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
  await waitFor(() => exitCalls.length > 0, "both signals frozen — the watchdog never fired at all");
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
  await waitFor(() => exitCalls.length > 0, "both signals frozen — the watchdog never fired at all");
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
  await waitFor(() => exitCalls.length > 0, "both signals frozen — the watchdog never fired at all");
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
  await waitFor(
    () => exitCalls.length > 0,
    "an enrichment read threw and the watchdog never fired at all — the nonzero exit must survive it",
  );
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
  // #403 (F25), PR #430 gate② round 3 (P1, same class the reviewer flagged one instance of): this
  // was `await sleep(400)` followed by a `sampleCalls >= 6` sanity check, so the CHECK's own
  // precondition rode on elapsed real time — under load the process can be descheduled for the
  // whole sleep and resume with fewer samples landed, failing on scheduler order rather than on
  // the property. Wait on the count instead: it is the only clock either side of this test reads,
  // and the named hang guard inside waitFor bounds a sampler that never runs at all.
  await waitFor(() => sampleCalls >= 6, "the watchdog never completed 6 samples — the reset-every-2-samples pattern was never exercised");
  assert.deepEqual(exitCalls, [], "progress reset the window on every sample pair — no stall was ever declared");
  handle.stop();
});

test("startProgressWatchdog: stop() prevents any firing, even well past the window", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 15, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  const samplesAtStop = state.samples();
  handle.stop();
  await sleep(80); // several windows' worth, if it were (wrongly) still armed
  // #403 (F25): the STRUCTURAL half of this assertion is the sample count — a stopped watchdog
  // takes no further samples at all, which is true regardless of how much real time elapsed or
  // how the scheduler chose to interleave. The elapsed sleep above only makes the check
  // meaningful; it is not what decides pass/fail.
  assert.equal(state.samples(), samplesAtStop, "a stopped watchdog kept sampling — the timer was never cleared");
  assert.deepEqual(exitCalls, []);
});

test("startProgressWatchdog: fires exactly once and does not reschedule after firing", async () => {
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({ windowMs: 15, state, exit: (code) => exitCalls.push(code), eventPayload: {} });
  await waitFor(() => exitCalls.length > 0, "both signals frozen — the watchdog never fired at all");
  const samplesAtFire = state.samples();
  await sleep(120); // several more windows' worth of continued quiet, if it were re-arming
  assert.equal(exitCalls.length, 1, "fired exactly once, never re-armed after firing");
  assert.equal(state.samples(), samplesAtFire, "kept sampling after firing — it must disarm itself, not just skip re-firing");
  handle.stop();
});

test("startProgressWatchdog (#395 gate② round 3, P2): fires within roughly ONE window of actual silence, not two — the worst case (the last real event lands right after arming) is bounded, not ~2x", async () => {
  // #403 (F25) rebuild: the original measured this in WALL-CLOCK milliseconds — "not fired by
  // 0.5x windowMs, fired by 1.6x" — which makes the verdict a race between the test's own sleeps
  // and the watchdog's sampling timer. Under concurrent load either sleep can overshoot by more
  // than the margin separating the two checkpoints, and the test flips for reasons that have
  // nothing to do with the property under test.
  //
  // The property is not about milliseconds at all: it is "detection takes ~SAMPLES_PER_WINDOW
  // samples after the last progress, not ~2x that". Measured in SAMPLES it is exact and
  // scheduler-independent — the watchdog's own sampling is the only clock either side reads.
  const SAMPLES_PER_WINDOW = 4; // watchdog.ts's own constant — the bound below is stated in its terms
  let reads = 0;
  let samplesAtBump = 0;
  let samplesAtFire = 0;
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({
    windowMs: 40,
    state: {
      maxEventId: () => {
        reads++;
        // Read 1 is the watchdog's baseline, taken inside startProgressWatchdog itself. Progress
        // lands on read 2 — its FIRST check, i.e. right after arming — and never again. That is
        // exactly the worst case the round-2 (once-per-window) design mishandled: it would see
        // this change on its first check, re-arm for a FULL second window, and take ~2x as long.
        if (reads === 2) {
          state.bump();
          samplesAtBump = state.samples();
        }
        return state.maxEventId();
      },
      lastTickAt: state.lastTickAt,
      appendEvent: state.appendEvent,
    },
    exit: (code) => {
      samplesAtFire = state.samples();
      exitCalls.push(code);
    },
    eventPayload: {},
  });
  await waitFor(() => exitCalls.length > 0, "silence after a single early bump never produced a stall at all");
  const samplesOfSilence = samplesAtFire - samplesAtBump;
  assert.ok(
    samplesOfSilence <= SAMPLES_PER_WINDOW + 1,
    `fired after ${samplesOfSilence} samples of silence — the round-2 'up to ~2 windows' bug is back ` +
      `(bound: ${SAMPLES_PER_WINDOW + 1}, i.e. roughly one window, never two)`,
  );
  assert.ok(
    samplesOfSilence >= SAMPLES_PER_WINDOW,
    `fired after only ${samplesOfSilence} samples of silence — it must require a FULL window (${SAMPLES_PER_WINDOW} consecutive unchanged samples) first`,
  );
  handle.stop();
});

// ── #395 gate② round 4, P1: the TUPLE itself — maxEventId() alone is not enough ────────────────

test("startProgressWatchdog (#395 gate② round 4, P1): maxEventId() frozen but last_tick_at ADVANCING every sample -> never fires — a real tick that appends nothing is still proof of life", async () => {
  // #403 (F25) rebuild — this was the same shape as the #395 flake already fixed further up:
  // the original drove state.tick() from a `sleep(8)` loop against the watchdog's own 10ms
  // sampling timer, two uncoordinated real timers whose interleaving under load decides the
  // verdict. If the scheduler starves the test loop for 4 sample periods, last_tick_at looks
  // frozen and the watchdog (correctly, by its own contract) fires — a false failure.
  //
  // Rebuilt so the tick advances as a pure function of the watchdog's own SAMPLE COUNT: every
  // sample sees a NEW lastTickAt, by construction, so `unchangedSamples` can never accumulate at
  // all. True on any machine at any speed; there is no second clock to race.
  const state = fakeState();
  const exitCalls: number[] = [];
  const handle = startProgressWatchdog({
    windowMs: 40,
    state: {
      maxEventId: state.maxEventId, // frozen — the event log never moves in this scenario
      lastTickAt: () => {
        state.tick(); // one real tick per sample: proof of life without a single appended event
        return state.lastTickAt();
      },
      appendEvent: state.appendEvent,
    },
    exit: (code) => exitCalls.push(code),
    eventPayload: {},
  });
  // #403 (F25), PR #430 gate② round 3 (P1): the prerequisite is a SAMPLE COUNT, not elapsed real
  // time. This used to be `await sleep(200)` followed by a `samples() >= 2` sanity check, which
  // made the check's own precondition a race: under concurrent load the process can be
  // descheduled for the whole 200ms and resume before the watchdog has run two sampling
  // callbacks, so it failed for scheduler reasons that have nothing to do with the property under
  // test. Waiting on the count is exact instead — and stronger: 2x SAMPLES_PER_WINDOW guarantees
  // a maxEventId()-only watchdog (the regression this test exists to catch) would have seen a
  // FULL window of unchanged samples and fired at least once by the assertion below. The hang
  // guard inside waitFor bounds catastrophe (a sampler that never runs at all) with a named
  // message; it never decides this test's verdict.
  const SAMPLES_PER_WINDOW = 4; // watchdog.ts's own constant
  await waitFor(
    () => state.samples() >= SAMPLES_PER_WINDOW * 2,
    `the watchdog never completed ${SAMPLES_PER_WINDOW * 2} samples — a sampler that never ran, not a passing test`,
  );
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
  await waitFor(() => exitCalls.length > 0, "both signals frozen — the genuine stall the watchdog exists to catch never fired");
  assert.deepEqual(exitCalls, [1], "both signals frozen must fire — this is the genuine stall the watchdog exists to catch");
  handle.stop();
});
