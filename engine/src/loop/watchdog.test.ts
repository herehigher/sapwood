// watchdog.test.ts (#395 gate② round 2/3): startProgressWatchdog is the core new logic behind
// the redesigned liveness watchdog — an INDEPENDENT background timer that fires when
// state.maxEventId() has gone unchanged for a full window, never raced against or keyed on the
// duration of any single tick() call. Uses a lightweight fake State (no real SQLite) so every
// assertion here is about the watchdog's own timing/firing logic, not database overhead — real
// setTimeout with generous margins (P2-4: CI-safe, since these tests assert both "fired" and
// "did not fire yet" at checkpoints comfortably clear of the window boundary either way).
//
// Round 3 (gate② P2): the round-2 shape sampled once per FULL window, which could take almost
// TWO windows to actually fire (if the last real event landed right after a check armed, that
// SAME check still saw the changed id and re-armed for another full window). The "fires within
// roughly one window, not two" test below is the regression test for that specific bug — it
// MEASURES silence duration end to end, not just "eventually fires."
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startProgressWatchdog } from "./watchdog.js";

function fakeState(startId = 0): {
  maxEventId: () => number;
  appendEvent: (kind: string, payload: unknown) => void;
  bump: () => void;
  appended: Array<[string, unknown]>;
} {
  let id = startId;
  const appended: Array<[string, unknown]> = [];
  return {
    maxEventId: () => id,
    appendEvent: (kind, payload) => {
      appended.push([kind, payload]);
      id++; // appendEvent is itself progress, matching the real State/events-table behavior
    },
    bump: () => {
      id++;
    },
    appended,
  };
}

test("startProgressWatchdog: no progress at all -> fires after windowMs, appends a durable engine-stalled event with the given payload, calls exit(1)", async () => {
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
  assert.deepEqual(state.appended[0], ["engine-stalled", { tickIntervalSec: 1, watchdogTickMultiplier: 1 }]);
  handle.stop();
});

test("startProgressWatchdog: progress before the window elapses resets it — no false fire", async () => {
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
