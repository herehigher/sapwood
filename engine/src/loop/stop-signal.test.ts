// stop-signal.ts tests (#380, F5): the two-stage stop — first signal requests the drain, second
// hard-exits — and the REAL process wiring (an actual SIGTERM/SIGINT delivered to this test
// process, no subprocess spawn and no timing race: the assertion waits for the handler and a
// broken wiring simply never resolves, which the test runner's own ceiling bounds).
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRegisterSignals, HARD_EXIT_CODE, installStopSignal } from "./stop-signal.js";

test("installStopSignal: first signal requests the stop and wakes the sleeper; it never hard-exits", () => {
  let stop = () => {};
  let wakes = 0;
  let exits: number[] = [];
  const s = installStopSignal({
    registerSignals: (requestStop) => {
      stop = requestStop;
      return () => {};
    },
    onStop: () => wakes++,
    hardExit: (code) => exits.push(code),
  });
  assert.equal(s.requested(), false);
  stop();
  assert.equal(s.requested(), true);
  assert.equal(wakes, 1);
  assert.deepEqual(exits, []);
  exits = [];
  s.dispose();
});

test("installStopSignal: a SECOND signal received while draining hard-exits immediately (128+SIGINT)", () => {
  let stop = () => {};
  let wakes = 0;
  const exits: number[] = [];
  const s = installStopSignal({
    registerSignals: (requestStop) => {
      stop = requestStop;
      return () => {};
    },
    onStop: () => wakes++,
    hardExit: (code) => exits.push(code),
  });
  stop();
  stop();
  assert.deepEqual(exits, [HARD_EXIT_CODE]);
  assert.equal(wakes, 1, "the second signal is a hard exit, not another drain request");
  assert.equal(s.requested(), true);
  s.dispose();
});

test("installStopSignal: dispose() tears the listeners down", () => {
  let disposed = 0;
  const s = installStopSignal({ registerSignals: () => () => disposed++ });
  s.dispose();
  assert.equal(disposed, 1);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  test(`defaultRegisterSignals: a real ${sig} delivered to this process reaches the handler`, async () => {
    const before = process.listenerCount(sig);
    const fired = new Promise<void>((resolve) => {
      const dispose = defaultRegisterSignals(() => {
        dispose();
        resolve();
      });
      process.kill(process.pid, sig);
    });
    await fired;
    assert.equal(process.listenerCount(sig), before, "the teardown removed exactly what it added");
  });
}

test("defaultRegisterSignals: registers with `on`, not `once` — a second signal still reaches the handler (the hard-exit stage)", async () => {
  const calls: number[] = [];
  const twice = new Promise<void>((resolve) => {
    const dispose = defaultRegisterSignals(() => {
      calls.push(calls.length);
      if (calls.length === 2) {
        dispose();
        resolve();
      }
    });
    process.kill(process.pid, "SIGTERM");
    process.kill(process.pid, "SIGTERM");
  });
  await twice;
  assert.equal(calls.length, 2);
});
