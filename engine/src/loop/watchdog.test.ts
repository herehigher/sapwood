// watchdog.test.ts (#395 round 2 — gate② P1): startProgressWatchdog is the core new logic behind
// the redesigned liveness watchdog — an INDEPENDENT background timer that fires when
// state.maxEventId() has gone unchanged for a full window, never raced against or keyed on the
// duration of any single tick() call. Uses a lightweight fake State (no real SQLite) so every
// assertion here is about the watchdog's own timing/firing logic, not database overhead — real
// setTimeout with generous margins (P2-4: CI-safe, since these tests assert both "fired" and
// "did not fire yet" at checkpoints comfortably clear of the window boundary either way).
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
