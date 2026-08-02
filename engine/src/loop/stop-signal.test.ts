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

test("installStopSignal: a SECOND signal received while draining hard-exits immediately", () => {
  let stop: (signal?: NodeJS.Signals) => void = () => {};
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

// The exit code carries WHICH signal ended the run (128+signum, the POSIX convention external
// tooling reads): a systemd unit or CI wrapper distinguishing "terminated by TERM" from
// "interrupted" gets the same answer from sapwood as from any other daemon.
for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  test(`installStopSignal: a second ${signal} hard-exits with ${code} (128+signum)`, () => {
    let stop: (signal?: NodeJS.Signals) => void = () => {};
    const exits: number[] = [];
    const s = installStopSignal({
      registerSignals: (requestStop) => {
        stop = requestStop;
        return () => {};
      },
      hardExit: (c) => exits.push(c),
    });
    stop(signal);
    stop(signal);
    assert.deepEqual(exits, [code]);
    s.dispose();
  });
}

test("installStopSignal: a second signal with no identity falls back to 130 — the seam stays usable without one", () => {
  let stop: (signal?: NodeJS.Signals) => void = () => {};
  const exits: number[] = [];
  const s = installStopSignal({
    registerSignals: (requestStop) => {
      stop = requestStop;
      return () => {};
    },
    hardExit: (c) => exits.push(c),
  });
  stop("SIGTERM"); // the FIRST signal's identity is irrelevant — only the exiting one names the code
  stop();
  assert.deepEqual(exits, [HARD_EXIT_CODE]);
  assert.equal(HARD_EXIT_CODE, 130);
  s.dispose();
});

test("installStopSignal: dispose() tears the listeners down", () => {
  let disposed = 0;
  const s = installStopSignal({ registerSignals: () => () => disposed++ });
  s.dispose();
  assert.equal(disposed, 1);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  test(`defaultRegisterSignals: a real ${sig} delivered to this process reaches the handler, naming itself`, async () => {
    const before = process.listenerCount(sig);
    const named = await new Promise<NodeJS.Signals | undefined>((resolve) => {
      const dispose = defaultRegisterSignals((signal) => {
        dispose();
        resolve(signal);
      });
      process.kill(process.pid, sig);
    });
    assert.equal(named, sig, "the handler carries WHICH signal fired — the hard-exit code depends on it");
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
