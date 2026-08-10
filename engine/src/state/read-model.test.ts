// read-model.test.ts (#705): the per-lane runtime-anchor building blocks — `probePidAlive` (the
// read-time liveness probe) and `buildLaneAnchors` (the shared function status --json's
// StatusLaneDTO and cli.ts's text-status path both build off). buildStatusDTO's own golden-shape
// coverage lives in loop/status-json.test.ts; this file is the unit-level alive/dead/unknown/
// no-heartbeat-yet matrix the issue's AC calls for, with an INJECTED pidProbe throughout — never
// a bare `process.kill` call in a test (no timing/subprocess-speed dependence, repo doctrine).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLaneAnchors, currentEngineState, probePidAlive } from "./read-model.js";

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

// ── #723: currentEngineState's standby-liveness read, end to end through a fake State ─────────
//
// dashboard/server.test.ts's deriveEngineState suite covers the pure precedence logic against
// synthetic EngineFacts; this exercises the PRODUCTION `currentEngineState` entry point (the one
// `/api/loop/state` and `status --json` actually call) against a fake `latestStandbySignal`, an
// INJECTED `now`, and no real DB/wall clock anywhere — same no-timing-dependence discipline as
// buildLaneAnchors above.

function fakeEngineState(opts: {
  standby?: { id: number; kind: "standby-wait" | "standby-heartbeat" | "standby-exit"; ts: string; payload: unknown } | undefined;
  lastTickAt: string | null;
  roundOpen: boolean;
  /** run-lifecycle trail for `latestRunTerminal`'s own fold, id-ordered 1..n — same shape
   *  dashboard/server.test.ts's `fold` helper uses. Defaults to empty (no terminal, never run). */
  runTrail?: [string, Record<string, unknown>][];
}) {
  const trail = opts.runTrail ?? [];
  return {
    openRound: () => (opts.roundOpen ? { round_id: 1, phase: "executing" } : undefined),
    isKillSwitchActive: () => false,
    activeWorkers: () => [],
    ceilingBreach: () => null,
    isPauseActive: () => false,
    lastTickAt: () => opts.lastTickAt,
    eventsAfterId: (_after: number, _kinds: string[]) => trail.map(([kind, payload], i) => ({ id: i + 1, kind, payload })),
    latestStandbySignal: () => opts.standby,
  };
}

test("#723 currentEngineState: a standby-wait event fresh within its own waitSec renders standby even though the tick has gone stale", () => {
  const state = fakeEngineState({
    standby: { id: 1, kind: "standby-wait", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 2, waitSec: 900 } },
    lastTickAt: "2026-08-10T11:00:00.000Z", // an hour stale
    roundOpen: false,
  });
  // 300s after the standby-wait fired — well inside its own 900s window.
  const now = new Date("2026-08-10T12:05:00.000Z");
  assert.equal(currentEngineState(state as never, null, now), "standby");
});

test("#723 currentEngineState: a standby-heartbeat's remainingSec is the freshness window too, not just standby-wait's waitSec", () => {
  const state = fakeEngineState({
    standby: { id: 1, kind: "standby-heartbeat", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 2, remainingSec: 120 } },
    lastTickAt: "2026-08-10T11:00:00.000Z",
    roundOpen: false,
  });
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:01:00.000Z")), "standby");
});

test("#723 currentEngineState boundary: a standby-wait older than its own waitSec, with a stale tick, is stalled — not standby forever", () => {
  const state = fakeEngineState({
    standby: { id: 1, kind: "standby-wait", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 2, waitSec: 900 } },
    lastTickAt: "2026-08-10T11:00:00.000Z",
    roundOpen: false,
  });
  // 901s later — one second past its own declared window.
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:15:01.000Z")), "stalled");
});

test("#723 currentEngineState: a standby-exit newer than the last standby-wait is running, never standby, whatever its age", () => {
  const state = fakeEngineState({
    standby: { id: 1, kind: "standby-exit", ts: "2026-08-10T12:00:00.000Z", payload: { attempts: 3 } },
    lastTickAt: "2026-08-10T12:00:10.000Z", // fresh tick, round reopened after exiting standby
    roundOpen: true,
  });
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:00:20.000Z")), "running");
});

// #746 gate② finding [0]: a process that exits mid-standby-dwell never appends `standby-exit`
// (round.ts's exit-append site is reached only on a normal resume, never on process death), so
// the FULL production path — currentEngineState reading a real `latestRunTerminal` fold alongside
// `latestStandbySignal` — must still stop rendering `standby` once a terminal proves the dwell was
// cut short, even though the lingering standby-heartbeat's own window hasn't elapsed yet.

test("#746 currentEngineState: a run-ended terminal appended AFTER the last standby-heartbeat (no standby-exit ever written) renders stopped, not an indefinitely-extended standby", () => {
  const state = fakeEngineState({
    // The standby-heartbeat is still fresh by its own 900s remainingSec window...
    standby: { id: 2, kind: "standby-heartbeat", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 1, remainingSec: 900 } },
    lastTickAt: "2026-08-10T11:00:00.000Z", // stale — ticking stopped when standby began
    roundOpen: false,
    // ...but the process died mid-dwell: run-ended landed AFTER the heartbeat (id 3 > id 2),
    // with no standby-exit ever appended (round.ts's exit-append site is unreachable from here).
    runTrail: [
      ["run-started", {}],
      ["run-ended", { stoppedBy: "signal" }],
    ],
  });
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:05:00.000Z")), "stopped");
});

test("#746 currentEngineState: an engine-stalled terminal AFTER the last standby signal renders stalled, not standby", () => {
  const state = fakeEngineState({
    standby: { id: 2, kind: "standby-wait", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 1, waitSec: 900 } },
    lastTickAt: "2026-08-10T11:00:00.000Z",
    roundOpen: false,
    runTrail: [
      ["run-started", {}],
      ["engine-stalled", { openRoundPhase: "executing" }],
    ],
  });
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:05:00.000Z")), "stalled");
});

test("#746 currentEngineState: a terminal OLDER than the current standby signal does not invalidate it — still standby", () => {
  const state = fakeEngineState({
    // This run's own standby-wait (id 4) is newer than the trail's terminal (id 2) below —
    // pins deriveEngineState's eventId-ordering branch directly: terminal.eventId (2) <
    // standbySignal.eventId (4) leaves standbySignalCurrent true.
    standby: { id: 4, kind: "standby-wait", ts: "2026-08-10T12:00:00.000Z", payload: { attempt: 1, waitSec: 900 } },
    lastTickAt: "2026-08-10T11:00:00.000Z",
    roundOpen: false,
    runTrail: [
      ["run-started", {}],
      ["run-ended", { stoppedBy: "signal" }],
    ],
  });
  assert.equal(currentEngineState(state as never, null, new Date("2026-08-10T12:05:00.000Z")), "standby");
});
