// spawn-confirm.test.ts (#395): awaitSpawnConfirmation is the core new logic behind the engine
// liveness fix — bound the wait for a freshly spawned child's "spawn"/"error" confirmation, the
// exact await the live incident found wedged forever (a host sleep lost the notification). Fully
// deterministic: `register` is a plain test double that either never calls back (simulating a
// lost notification) or calls back on cue — no real child process, no real timer, so this suite
// carries zero flake risk from real OS process-spawn timing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitSpawnConfirmation } from "./spawn-confirm.js";

/** A `sleep` fake that resolves the instant it's invoked (next microtask) — used to make the
 *  watchdog side of the race win deterministically without a real timer. */
const instantSleep = async (_ms: number): Promise<void> => {
  /* resolves immediately */
};

/** A `sleep` fake that NEVER resolves — used to prove the "spawn/error arrives first" path never
 *  even consults the timeout when the confirmation is prompt. */
const neverSleep = (_ms: number): Promise<void> => new Promise(() => {});

test("awaitSpawnConfirmation: a lost notification (register never calls back) times out — timedOut is true and err is unset", async () => {
  const result = await awaitSpawnConfirmation(() => {}, 10, instantSleep);
  assert.equal(result.timedOut, true);
  assert.equal(result.err, undefined);
});

test("awaitSpawnConfirmation: onSpawn firing first resolves with timedOut false, err unset — the watchdog never fires", async () => {
  const result = await awaitSpawnConfirmation((onSpawn) => onSpawn(), 10, neverSleep);
  assert.equal(result.timedOut, false);
  assert.equal(result.err, undefined);
});

test("awaitSpawnConfirmation: onError firing first resolves with the error, never timedOut", async () => {
  const boom = new Error("boom");
  const result = await awaitSpawnConfirmation((_onSpawn, onError) => onError(boom), 10, neverSleep);
  assert.equal(result.timedOut, false);
  assert.equal(result.err, boom);
});

test("awaitSpawnConfirmation: a LATE onSpawn after the timeout already fired is a harmless no-op — the outcome stays timedOut", async () => {
  let lateSpawn: (() => void) | undefined;
  const result = await awaitSpawnConfirmation(
    (onSpawn) => {
      lateSpawn = onSpawn;
      // never call it during the race — simulates the notification arriving well after this
      // helper has already settled on "timed out"
    },
    10,
    instantSleep,
  );
  assert.equal(result.timedOut, true);
  // Firing the late callback after settlement must not throw (the promise already resolved).
  assert.doesNotThrow(() => lateSpawn?.());
});

test("awaitSpawnConfirmation: with no injected sleep, a real (short) timeout still fires when register never calls back", async () => {
  const result = await awaitSpawnConfirmation(() => {}, 5);
  assert.equal(result.timedOut, true);
  assert.equal(result.err, undefined);
});
