// read-model.test.ts (#705): the per-lane runtime-anchor building blocks — `probePidAlive` (the
// read-time liveness probe) and `buildLaneAnchors` (the shared function status --json's
// StatusLaneDTO and cli.ts's text-status path both build off). buildStatusDTO's own golden-shape
// coverage lives in loop/status-json.test.ts; this file is the unit-level alive/dead/unknown/
// no-heartbeat-yet matrix the issue's AC calls for, with an INJECTED pidProbe throughout — never
// a bare `process.kill` call in a test (no timing/subprocess-speed dependence, repo doctrine).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildLaneAnchors, probePidAlive } from "./read-model.js";

// ── probePidAlive ───────────────────────────────────────────────────────────────────────────

test("probePidAlive: the CURRENT process's own pid -> true (a real, live, signalable process)", () => {
  assert.equal(probePidAlive(process.pid), true);
});

test("probePidAlive: a pid that just exited -> false (confirmed dead, ESRCH) — a real subprocess, no timer/sleep involved", () => {
  // Deterministic, not timing-dependent: spawnSync BLOCKS until the child has fully exited, so
  // there is no race window to wait out — by the time spawnSync returns, `pid` is guaranteed
  // reaped. Re-use of that exact pid by an unrelated process in the instant between exit and
  // this assertion is not excludable in principle, but is the same accepted-negligible risk
  // worker.test.ts's own `wrapper_pid: 999_999_999` "obviously dead" convention exists to avoid
  // — unlike that hard-coded literal, this test wants a pid PROVEN dead by a real exit, so it
  // accepts the same real-world assumption every "spawn, wait, probe" liveness check makes.
  const { pid } = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(typeof pid === "number" && pid > 0);
  assert.equal(probePidAlive(pid), false);
});

test('probePidAlive: a non-positive or non-integer pid -> "unknown", never coerced to false', () => {
  assert.equal(probePidAlive(0), "unknown");
  assert.equal(probePidAlive(-1), "unknown");
  assert.equal(probePidAlive(1.5), "unknown");
});

// ── buildLaneAnchors ────────────────────────────────────────────────────────────────────────

function fakeState(spawnFact: { pid: number | null; worktreePath: string } | null, heartbeat: { id: number; ts: string } | null) {
  return {
    latestLaneSpawnFact: (_worker: string) => spawnFact,
    latestHeartbeatForWorker: (_worker: string) => heartbeat,
  };
}

test("buildLaneAnchors: no spawn fact, no heartbeat -> every anchor reports its own honest 'nothing known', never a guess", () => {
  const anchors = buildLaneAnchors(fakeState(null, null), "lane-x", () => true, new Date("2026-08-06T00:00:00.000Z"));
  assert.deepEqual(anchors, { pid: null, pidAlive: "unknown", worktreePath: null, lastHeartbeat: null });
});

test("buildLaneAnchors: a known pid probed ALIVE -> pidAlive true, worktreePath carried through", () => {
  const anchors = buildLaneAnchors(
    fakeState({ pid: 4242, worktreePath: "/tmp/lane-x" }, null),
    "lane-x",
    () => true,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.deepEqual(anchors, { pid: 4242, pidAlive: true, worktreePath: "/tmp/lane-x", lastHeartbeat: null });
});

test("buildLaneAnchors: a known pid probed DEAD -> pidAlive false — the belief-vs-reality case #705 exists for", () => {
  const anchors = buildLaneAnchors(
    fakeState({ pid: 4242, worktreePath: "/tmp/lane-x" }, null),
    "lane-x",
    () => false,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.pidAlive, false);
});

test('buildLaneAnchors: a known pid whose probe is INCONCLUSIVE -> pidAlive "unknown", never coerced to false', () => {
  const anchors = buildLaneAnchors(
    fakeState({ pid: 4242, worktreePath: "/tmp/lane-x" }, null),
    "lane-x",
    () => "unknown",
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.pidAlive, "unknown");
});

test('buildLaneAnchors: no pid on record -> pidAlive "unknown" WITHOUT ever calling the probe (nothing to probe)', () => {
  let probeCalls = 0;
  const anchors = buildLaneAnchors(
    fakeState({ pid: null, worktreePath: "/tmp/lane-x" }, null),
    "lane-x",
    () => {
      probeCalls++;
      return true;
    },
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.pid, null);
  assert.equal(anchors.pidAlive, "unknown");
  assert.equal(probeCalls, 0);
});

test("buildLaneAnchors: no heartbeat yet -> lastHeartbeat null (freshly dispatched, first cadence tick not due)", () => {
  const anchors = buildLaneAnchors(
    fakeState({ pid: 4242, worktreePath: "/tmp/lane-x" }, null),
    "lane-x",
    () => true,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.lastHeartbeat, null);
});

test("buildLaneAnchors: a heartbeat's ageSec is computed against the INJECTED `now`, never a real wall-clock read", () => {
  const anchors = buildLaneAnchors(
    fakeState(null, { id: 7, ts: "2026-08-06T00:00:00.000Z" }),
    "lane-x",
    () => true,
    new Date("2026-08-06T00:00:42.000Z"),
  );
  assert.deepEqual(anchors.lastHeartbeat, { id: 7, ts: "2026-08-06T00:00:00.000Z", ageSec: 42 });
});
