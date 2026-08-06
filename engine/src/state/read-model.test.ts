// read-model.test.ts (#705): the per-lane runtime-anchor building blocks — `probePidAlive` (the
// read-time liveness probe) and `buildLaneAnchors` (the shared function status --json's
// StatusLaneDTO and cli.ts's text-status path both build off). buildStatusDTO's own golden-shape
// coverage lives in loop/status-json.test.ts; this file is the unit-level alive/dead/unknown/
// no-heartbeat-yet matrix the issue's AC calls for, with an INJECTED pidProbe throughout — never
// a bare `process.kill` call in a test (no timing/subprocess-speed dependence, repo doctrine).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLaneAnchors, probePidAlive } from "./read-model.js";

// ── probePidAlive ───────────────────────────────────────────────────────────────────────────
//
// #705 gate② P2-4: every case below drives `probePidAlive` through an INJECTED `killFn` — a
// synthetic errno fake, never a real spawned subprocess. A real subprocess made the "dead" case
// a race (pid reuse between exit and probe is not excludable in principle) and violated the
// repo's no-timing-dependent-tests doctrine (subprocess/OS scheduling behavior deciding a test's
// outcome). Every branch of the real `process.kill` errno matrix is pinned deterministically.

function errno(code: string): () => never {
  return () => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    throw e;
  };
}

test("probePidAlive: killFn succeeds -> true (the process exists and is signalable)", () => {
  assert.equal(
    probePidAlive(4242, () => {
      /* signal 0 delivered successfully */
    }),
    true,
  );
});

test("probePidAlive: killFn throws ESRCH -> false — the ONLY case that means confirmed dead", () => {
  assert.equal(probePidAlive(4242, errno("ESRCH")), false);
});

test("probePidAlive: killFn throws EPERM -> true — the process exists, just isn't signalable by us (POSIX kill(2) semantics)", () => {
  assert.equal(probePidAlive(4242, errno("EPERM")), true);
});

test('probePidAlive: killFn throws an unrecognized errno (e.g. EACCES) -> "unknown", never coerced to false', () => {
  assert.equal(probePidAlive(4242, errno("EACCES")), "unknown");
});

test('probePidAlive: killFn throws something with no `code` at all -> "unknown"', () => {
  assert.equal(
    probePidAlive(4242, () => {
      throw new Error("platform surprise, no errno code");
    }),
    "unknown",
  );
});

test('probePidAlive: a non-positive or non-integer pid -> "unknown", never coerced to false, and the probe is never called', () => {
  let calls = 0;
  const killFn = () => {
    calls++;
  };
  assert.equal(probePidAlive(0, killFn), "unknown");
  assert.equal(probePidAlive(-1, killFn), "unknown");
  assert.equal(probePidAlive(1.5, killFn), "unknown");
  assert.equal(calls, 0);
});

test("probePidAlive: with no killFn argument, defaults to the real process.kill (production behavior) — self pid is alive", () => {
  assert.equal(probePidAlive(process.pid), true);
});

// ── buildLaneAnchors ────────────────────────────────────────────────────────────────────────

/** #705 gate② P1-1: the fake honors the SAME (worker, issue) scoping the real State methods do
 *  — `facts`/`heartbeats` are keyed by `${worker}#${issue}`, so a test can seed a fact for one
 *  issue and prove it is invisible under a different issue number for the SAME worker name
 *  (the lane-reuse regression the reviewer asked for). */
function fakeState(
  facts: Record<string, { pid: number | null; worktreePath: string }>,
  heartbeats: Record<string, { id: number; ts: string }>,
) {
  return {
    latestLaneSpawnFact: (worker: string, issue: number) => facts[`${worker}#${issue}`] ?? null,
    latestHeartbeatForWorker: (worker: string, issue: number) => heartbeats[`${worker}#${issue}`] ?? null,
  };
}

test("buildLaneAnchors: no spawn fact, no heartbeat -> every anchor reports its own honest 'nothing known', never a guess", () => {
  const anchors = buildLaneAnchors(fakeState({}, {}), "lane-x", 1, () => true, new Date("2026-08-06T00:00:00.000Z"));
  assert.deepEqual(anchors, { pid: null, pidAlive: "unknown", worktreePath: null, lastHeartbeat: null });
});

test("buildLaneAnchors: a known pid probed ALIVE -> pidAlive true, worktreePath carried through", () => {
  const anchors = buildLaneAnchors(
    fakeState({ "lane-x#1": { pid: 4242, worktreePath: "/tmp/lane-x" } }, {}),
    "lane-x",
    1,
    () => true,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.deepEqual(anchors, { pid: 4242, pidAlive: true, worktreePath: "/tmp/lane-x", lastHeartbeat: null });
});

test("buildLaneAnchors: a known pid probed DEAD -> pidAlive false — the belief-vs-reality case #705 exists for", () => {
  const anchors = buildLaneAnchors(
    fakeState({ "lane-x#1": { pid: 4242, worktreePath: "/tmp/lane-x" } }, {}),
    "lane-x",
    1,
    () => false,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.pidAlive, false);
});

test('buildLaneAnchors: a known pid whose probe is INCONCLUSIVE -> pidAlive "unknown", never coerced to false', () => {
  const anchors = buildLaneAnchors(
    fakeState({ "lane-x#1": { pid: 4242, worktreePath: "/tmp/lane-x" } }, {}),
    "lane-x",
    1,
    () => "unknown",
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.pidAlive, "unknown");
});

test('buildLaneAnchors: no pid on record -> pidAlive "unknown" WITHOUT ever calling the probe (nothing to probe)', () => {
  let probeCalls = 0;
  const anchors = buildLaneAnchors(
    fakeState({ "lane-x#1": { pid: null, worktreePath: "/tmp/lane-x" } }, {}),
    "lane-x",
    1,
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
    fakeState({ "lane-x#1": { pid: 4242, worktreePath: "/tmp/lane-x" } }, {}),
    "lane-x",
    1,
    () => true,
    new Date("2026-08-06T00:00:00.000Z"),
  );
  assert.equal(anchors.lastHeartbeat, null);
});

test("buildLaneAnchors: a heartbeat's ageSec is computed against the INJECTED `now`, never a real wall-clock read", () => {
  const anchors = buildLaneAnchors(
    fakeState({}, { "lane-x#1": { id: 7, ts: "2026-08-06T00:00:00.000Z" } }),
    "lane-x",
    1,
    () => true,
    new Date("2026-08-06T00:00:42.000Z"),
  );
  assert.deepEqual(anchors.lastHeartbeat, { id: 7, ts: "2026-08-06T00:00:00.000Z", ageSec: 42 });
});

// #705 gate② P1-1 regression: a lane NAME carrying an older spawn/heartbeat fact for a DIFFERENT
// issue must yield fresh (null) anchors under the new issue, never the stale facts — the
// lane-reuse hazard the (worker, issue) scoping exists to close.
test("buildLaneAnchors (#705 gate② P1-1 regression): a lane name reused for a NEW issue never inherits the OLD issue's spawn fact or heartbeat", () => {
  const state = fakeState(
    { "lane-x#1": { pid: 111, worktreePath: "/tmp/issue-1" } },
    { "lane-x#1": { id: 5, ts: "2026-08-06T00:00:00.000Z" } },
  );
  // Same worker NAME, a DIFFERENT issue number — must see nothing from issue #1's facts.
  const anchors = buildLaneAnchors(state, "lane-x", 2, () => true, new Date("2026-08-06T00:01:00.000Z"));
  assert.deepEqual(anchors, { pid: null, pidAlive: "unknown", worktreePath: null, lastHeartbeat: null });
});

test("buildLaneAnchors (#705 gate② P1-1 regression): the SAME (worker, issue) pair still resolves correctly — scoping doesn't break the ordinary case", () => {
  const state = fakeState(
    { "lane-x#1": { pid: 111, worktreePath: "/tmp/issue-1" }, "lane-x#2": { pid: 222, worktreePath: "/tmp/issue-2" } },
    {},
  );
  assert.equal(buildLaneAnchors(state, "lane-x", 1, () => true, new Date()).pid, 111);
  assert.equal(buildLaneAnchors(state, "lane-x", 2, () => true, new Date()).pid, 222);
});
