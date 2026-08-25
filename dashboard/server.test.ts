// server.test.ts (#142, extended in #360): the dashboard data server. Covers the whole surface
// docs/reference/frontend-design.md §8 locks — the engine-state derivation (all seven words plus the
// "staleness beats PAUSE" precedence rule), the four read routes' paging and field shapes, the
// config allowlist (the no-secrets guarantee is structural, not a promise), the single gated
// write route (verb allowlist, same-origin defences, sentinel-only side effects, post-signal
// state), the statics, and the posture invariants: the SQLite handle stays read-only even with
// a write route registered, and the listener binds loopback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventKind } from "../engine/src/state/event-kinds/index.js";
import { State } from "../engine/src/state/state.js";
import {
  allowlistedConfig,
  CONFIG_ALLOWLIST,
  createDashboardServer,
  deriveEngineState,
  type EngineFacts,
  latestRunTerminal,
} from "./server.js";

// ── engine-state derivation (§8) ───────────────────────────────────────────────────────────

const FRESH: EngineFacts = {
  now: new Date("2026-07-24T12:00:00.000Z"),
  killSwitch: false,
  activeLanes: 0,
  ceilingBreach: null,
  pause: false,
  lastTickAt: "2026-07-24T11:59:30.000Z", // 30s ago — well inside the gap
  staleGapSec: 900,
  roundOpen: true,
  standbySignal: null,
  terminal: null,
};

// #407: the three terminal shapes for the dead-engine truth table below. `eventId: 1` is an
// arbitrary low ledger id — most of these tests pair a terminal with `standbySignal: null`, where
// eventId ordering plays no role at all; the #746 tests below give both their own explicit ids.
const STALE_TICK = "2026-07-24T11:00:00.000Z"; // an hour ago — past the 900s gap
const CLEAN_STOP = { kind: "run-ended", payload: { stoppedBy: "signal" }, eventId: 1 } as const;
const SELF_STALL = {
  kind: "engine-stalled",
  payload: { openRoundPhase: "executing", lastEventKind: "park-wait-heartbeat" },
  eventId: 1,
} as const;

test("engine state: a ticking engine with an open round is running", () => {
  assert.equal(deriveEngineState(FRESH), "running");
});

test("engine state: no open round + a fresh standby signal (within its own declared window) is standby, not stalled", () => {
  assert.equal(deriveEngineState({ ...FRESH, roundOpen: false, standbySignal: { ageSec: 10, windowSec: 30, eventId: 1 } }), "standby");
  // a closed round with no standby signal at all is still just running — standby is the PARKED signal
  assert.equal(deriveEngineState({ ...FRESH, roundOpen: false, standbySignal: null }), "running");
});

// #723: AC12 operator probe — standby deliberately stops ticking, so `lastTickAt` alone
// misclassifies a healthy long backoff dwell as `stalled`. A standby-wait/standby-heartbeat
// signal newer than its OWN declared window (waitSec / remainingSec) is liveness independent of
// the tick heartbeat, and must render `standby`, never `stalled`, however stale the tick itself
// has gone in the meantime.
test("#723 engine state: a standby signal fresh within its own window overrides a stale tick — the standby dwell itself deliberately stops ticking", () => {
  assert.equal(
    deriveEngineState({ ...FRESH, roundOpen: false, lastTickAt: STALE_TICK, standbySignal: { ageSec: 60, windowSec: 1800, eventId: 1 } }),
    "standby",
  );
});

// #723 AC boundary: the standby signal ITSELF goes stale beyond its own declared next-wait —
// nothing has evidenced liveness for longer than the engine's own promise, and the tick is also
// stale, so this is genuinely `stalled`, not an indefinitely-extended `standby`.
test("#723 engine state boundary: a standby signal older than its own declared window, with the tick also stale, is stalled", () => {
  assert.equal(
    deriveEngineState({
      ...FRESH,
      roundOpen: false,
      lastTickAt: STALE_TICK,
      standbySignal: { ageSec: 1900, windowSec: 1800, eventId: 1 },
    }),
    "stalled",
  );
});

test("#723 engine state: a round OPEN cancels standby freshness — an in-flight round is running, never standby, whatever a lingering old standby signal says", () => {
  assert.equal(deriveEngineState({ ...FRESH, roundOpen: true, standbySignal: { ageSec: 10, windowSec: 30, eventId: 1 } }), "running");
});

// ── #746 gate② finding [0]: a terminal newer than the standby signal invalidates it — a process
// that exits (cleanly or self-diagnosed) mid-standby-dwell never appends `standby-exit` (round.ts's
// exit-append site is reached only on a normal resume, never on process death), so kind/ts alone
// would keep reading `standby` off a signal the process has since proven it can no longer honor. ──

test("#746 engine state: a run-ended terminal NEWER than the standby signal invalidates it — a clean exit mid-dwell renders stopped, not an indefinitely-extended standby", () => {
  assert.equal(
    deriveEngineState({
      ...FRESH,
      roundOpen: false,
      lastTickAt: STALE_TICK,
      // The signal itself is still well within its own 1800s window...
      standbySignal: { ageSec: 60, windowSec: 1800, eventId: 5 },
      // ...but a run-ended landed AFTER it (higher eventId) — the process died mid-dwell.
      terminal: { kind: "run-ended", payload: { stoppedBy: "signal" }, eventId: 6 },
    }),
    "stopped",
  );
});

test("#746 engine state: an engine-stalled terminal NEWER than the standby signal invalidates it — renders stalled, not standby", () => {
  assert.equal(
    deriveEngineState({
      ...FRESH,
      roundOpen: false,
      lastTickAt: STALE_TICK,
      standbySignal: { ageSec: 60, windowSec: 1800, eventId: 5 },
      terminal: { kind: "engine-stalled", payload: {}, eventId: 6 },
    }),
    "stalled",
  );
});

test("#746 engine state: a terminal OLDER than the standby signal leaves it fresh — that terminal belongs to a run this dwell has already outlived", () => {
  assert.equal(
    deriveEngineState({
      ...FRESH,
      roundOpen: false,
      lastTickAt: STALE_TICK,
      // The standby signal is NEWER than the terminal (a restart's own fresh dwell, or a terminal
      // from a prior run this run's standby loop has already superseded).
      standbySignal: { ageSec: 60, windowSec: 1800, eventId: 6 },
      terminal: { kind: "run-ended", payload: { stoppedBy: "signal" }, eventId: 5 },
    }),
    "standby",
  );
});

test("engine state: a tick older than the stale gap is stalled (a dead engine must never read green)", () => {
  assert.equal(deriveEngineState({ ...FRESH, lastTickAt: "2026-07-24T11:40:00.000Z" }), "stalled");
});

test("engine state: an engine that has never ticked is stalled, never running", () => {
  assert.equal(deriveEngineState({ ...FRESH, lastTickAt: null }), "stalled");
});

test("engine state: the PAUSE sentinel on a live engine is paused", () => {
  assert.equal(deriveEngineState({ ...FRESH, pause: true }), "paused");
});

test("engine state: staleness beats PAUSE — a dead engine with a PAUSE file renders stalled (§8 precedence)", () => {
  assert.equal(deriveEngineState({ ...FRESH, pause: true, lastTickAt: "2026-07-24T11:00:00.000Z" }), "stalled");
});

test("engine state: a ceiling breach is winding-down, and outranks PAUSE and standby", () => {
  const breach = { reasons: ["daily-budget"], at: new Date("2026-07-24T11:58:00.000Z") };
  assert.equal(deriveEngineState({ ...FRESH, ceilingBreach: breach }), "winding-down");
  assert.equal(deriveEngineState({ ...FRESH, ceilingBreach: breach, pause: true }), "winding-down");
});

test("engine state: the kill switch is stopping while lanes drain, stopped once they are gone", () => {
  assert.equal(deriveEngineState({ ...FRESH, killSwitch: true, activeLanes: 2 }), "stopping");
  assert.equal(deriveEngineState({ ...FRESH, killSwitch: true, activeLanes: 0 }), "stopped");
});

test("engine state: kill switch + stale stays stopped (truthful either way, §8)", () => {
  assert.equal(deriveEngineState({ ...FRESH, killSwitch: true, activeLanes: 0, lastTickAt: null }), "stopped");
});

// ── #407 (item 5): the dead-engine truth table — the stale branch partitions on the newest
// run's terminal event instead of one undifferentiated "stalled" ──────────────────────────

test("#407 engine state truth table: stale + run-ended is a CLEAN stop; stale + engine-stalled is a self-diagnosed stall; stale + no terminal is the bare crashed-or-killed stalled", () => {
  assert.equal(deriveEngineState({ ...FRESH, lastTickAt: STALE_TICK, terminal: CLEAN_STOP }), "stopped");
  assert.equal(deriveEngineState({ ...FRESH, lastTickAt: STALE_TICK, terminal: SELF_STALL }), "stalled");
  assert.equal(deriveEngineState({ ...FRESH, lastTickAt: STALE_TICK, terminal: null }), "stalled");
});

test("#407 engine state: within the tick-age gap the terminal changes nothing — the derivation stays scoped to the stale branch (the issue's own scoping)", () => {
  assert.equal(deriveEngineState({ ...FRESH, terminal: CLEAN_STOP }), "running");
  assert.equal(deriveEngineState({ ...FRESH, terminal: SELF_STALL }), "running");
});

test("#407 engine state: a stopped engine with a PAUSE file renders stopped, not paused — same dead-beats-sentinel precedence as staleness-beats-PAUSE", () => {
  assert.equal(deriveEngineState({ ...FRESH, pause: true, lastTickAt: STALE_TICK, terminal: CLEAN_STOP }), "stopped");
});

test("#407 engine state: KILL_SWITCH still outranks the terminal (a kill-switch stop is already truthfully stopped/stopping)", () => {
  assert.equal(deriveEngineState({ ...FRESH, killSwitch: true, activeLanes: 2, lastTickAt: STALE_TICK, terminal: SELF_STALL }), "stopping");
});

test("#407 latestRunTerminal: newest of the run-lifecycle triple decides — run-started newest is null (alive or crashed), a terminal newest belongs to the newest run, restart resets to null", () => {
  const fold = (kinds: [string, Record<string, unknown>][]) =>
    latestRunTerminal({
      // #477: eventsAfterId rows carry their ledger id; the synthetic ledger numbers them 1..n.
      eventsAfterId: (_after: number, _kinds: string[]) => kinds.map(([kind, payload], i) => ({ id: i + 1, kind, payload })),
    });
  assert.equal(fold([]), null, "an engine that has never run has no terminal");
  assert.equal(fold([["run-started", {}]]), null, "no terminal yet — alive, or crashed");
  assert.deepEqual(
    fold([
      ["run-started", {}],
      ["run-ended", { stoppedBy: "signal" }],
    ]),
    {
      kind: "run-ended",
      payload: { stoppedBy: "signal" },
      eventId: 2,
    },
  );
  assert.deepEqual(
    fold([
      ["run-started", {}],
      ["engine-stalled", { windowMs: 600000 }],
    ]),
    {
      kind: "engine-stalled",
      payload: { windowMs: 600000 },
      eventId: 2,
    },
  );
  assert.equal(
    fold([
      ["run-started", {}],
      ["engine-stalled", { windowMs: 600000 }],
      ["run-started", {}],
    ]),
    null,
    "a restart opens a fresh run — the old terminal no longer describes the newest run",
  );
  assert.deepEqual(
    fold([
      ["run-started", {}],
      ["run-ended", { stoppedBy: "once" }],
      ["run-started", {}],
      ["run-ended", { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" }],
    ]),
    { kind: "run-ended", payload: { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" }, eventId: 4 },
    "the newest run's own terminal wins, never an older run's",
  );
});

// ── config allowlist (§3 E) ────────────────────────────────────────────────────────────────

/** Every dotted leaf path present in an arbitrary nested object. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

test("config allowlist: only named keys are served, whatever else the resolved config carries", async () => {
  const fx = await fixture();
  try {
    const body = await getJson(fx, "/api/loop/state");
    const served = leafPaths(body.config);
    assert.ok(served.length > 0, "the drawer would be empty");
    for (const path of served) {
      assert.ok(CONFIG_ALLOWLIST.includes(path), `served a key that is not on the allowlist: ${path}`);
    }
    // Concrete non-allowlisted keys the resolved config definitely holds — a spot check that
    // the walk above is testing something real.
    const raw = JSON.stringify(body.config);
    for (const absent of ["egressSuspectCommands", "trustedReviewers", "instructionPaths", "promptFile", "proxy", "doctrine"]) {
      assert.ok(!raw.includes(absent), `${absent} leaked into the config drawer`);
    }
  } finally {
    fx.close();
  }
});

test("config allowlist: a future config key that nobody allowlisted never reaches the wire", () => {
  const cfg = { ...baseConfig(), secretToken: "hunter2", worker: { model: "opus", effort: "high", secretToken: "hunter2" } };
  const served = JSON.stringify(allowlistedConfig(cfg as never));
  assert.ok(!served.includes("hunter2"));
  assert.ok(!served.includes("secretToken"));
  assert.ok(served.includes("opus"), "the allowlisted keys still come through");
});

// ── /api/loop/state shape (§8) ─────────────────────────────────────────────────────────────

test("/api/loop/state matches the §8 shape against a seeded DB", async () => {
  const fx = await fixture((s) => {
    s.upsertWorker({ name: "w1", issue: 86, session_id: "s1", state: "running", started_at: "2026-07-24T11:00:00.000Z", ended_at: null });
    s.setLiveTelemetry("w1", {
      estCostUsd: 0.73,
      contextTokens: 41000,
      tokenComposition: { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 90000, cacheCreationTokens: 4000 },
    });
    s.upsertWorker({
      name: "w2",
      issue: 88,
      session_id: "s2",
      state: "driving",
      started_at: "2026-07-24T10:00:00.000Z",
      ended_at: null,
      pr: 97,
      // #926 gate② finding [1] (ac4-real-data-flow-uncovered): a nonzero, non-default fix_rounds
      // row — pins laneItem's `fixRound: w.fix_rounds ?? 0` mapping against a REAL DB row, not
      // just the schema-default 0 every other worker in this fixture already carries.
      fix_rounds: 2,
    });
    s.recordSpend("w2", 88, 1.25, "2026-07-24T11:30:00.000Z", [
      { model: "opus", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.recordSpend("w3", 90, 0.75, "2026-07-24T11:31:00.000Z", [
      { model: "sonnet", inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.appendEvent("merged", { pr: 94 });
    s.appendEvent("merged", { pr: 95 });
    s.appendEvent("dispatched", { issue: 86 });
    s.appendEvent("gated-reentry-merged", { pr: 96 });
    s.startRound("2026-07-24T10:00:00.000Z");
  });
  try {
    const body = await getJson(fx, "/api/loop/state");

    assert.deepEqual(Object.keys(body).sort(), [
      "build",
      "config",
      "controlsEnabled",
      "engine",
      "lanes",
      "logPath",
      "mergedPrs",
      "rings",
      "round",
      "spend",
    ]);
    assert.deepEqual(Object.keys(body.engine).sort(), [
      "estopActive",
      "lastTickAt",
      "pauseActive",
      "reasons",
      "standbyNextCheckSec",
      "state",
      "terminal",
    ]);
    assert.equal(body.engine.standbyNextCheckSec, null, "not in standby in this fixture");
    assert.deepEqual(body.engine.reasons, []);
    assert.equal(body.engine.terminal, null, "#407: no terminal has been written for the newest run");
    assert.equal(body.engine.pauseActive, false);
    assert.equal(body.controlsEnabled, true, "schema default — no dashboard.controls key was written");

    assert.equal(body.lanes.max, 3);
    const [w1, w2] = body.lanes.items;
    assert.deepEqual(Object.keys(w1).sort(), [
      "contextTokens",
      "costUsd",
      "endedAt",
      "estCostUsd",
      "fixRound",
      "held",
      "issue",
      "lane",
      "pr",
      "startedAt",
      "state",
      "tokenComposition",
    ]);
    // in flight: the real bill does not exist yet — null, never a $0.00 that reads as settled
    assert.equal(w1.costUsd, null);
    assert.equal(w1.estCostUsd, 0.73);
    assert.equal(w1.fixRound, 0, "a worker never fixed carries the schema default");
    assert.equal(w1.contextTokens, 41000);
    assert.deepEqual(w1.tokenComposition, { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 90000, cacheCreationTokens: 4000 });
    assert.equal(w1.pr, null);
    // settled at reclaim: the spend_ledger sum for that lane
    assert.equal(w2.costUsd, 1.25);
    assert.equal(w2.estCostUsd, null);
    assert.equal(w2.contextTokens, null);
    assert.equal(w2.tokenComposition, null);
    assert.equal(w2.pr, 97);
    assert.equal(w2.fixRound, 2, "the real fix_rounds row must reach the served lane, not a fabricated/default value");

    assert.deepEqual(body.round, { id: 1, phase: "aligning" });
    assert.equal(body.spend.todayUsd, 2);
    assert.equal(body.spend.dailyBudgetUsd, 100);
    assert.equal(body.spend.runBudgetUsd, null);
    assert.equal(body.spend.runUsd, null); // #206 run-started anchor not landed — daily tier only
    assert.deepEqual(body.spend.byModel, [
      { model: "opus", usd: 1.25, inputTokens: 100, outputTokens: 20 },
      { model: "sonnet", usd: 0.75, inputTokens: 50, outputTokens: 10 },
    ]);
    assert.equal(body.rings, 2); // merged events only
    assert.deepEqual(
      [...body.mergedPrs].sort((a, b) => a - b),
      [94, 95, 96],
      "#803: every merged-witness kind, deduped",
    );
    assert.ok(String(body.logPath).endsWith("sapwood.log"));
  } finally {
    fx.close();
  }
});

test("/api/loop/state reports lanes.max and budgets as null when the config is unreadable", async () => {
  const fx = await fixture(undefined, { config: false });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.lanes.max, null);
    assert.equal(body.spend.dailyBudgetUsd, null);
    assert.equal(body.spend.runBudgetUsd, null);
    assert.equal(body.logPath, null);
    assert.equal(body.config, null);
    assert.equal(body.controlsEnabled, false, "an unreadable config never licenses the schema's true default");
  } finally {
    fx.close();
  }
});

// ── #361: pauseActive / controlsEnabled ────────────────────────────────────────────────────

test("#361 /api/loop/state serves the raw PAUSE sentinel independently of the derived state word", async () => {
  const fx = await fixture(
    (s) => {
      s.touchLastTick(new Date("2026-07-24T11:59:30.000Z")); // fresh — reads paused, not stalled
    },
    { pause: true },
  );
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.state, "paused");
    assert.equal(body.engine.pauseActive, true);
  } finally {
    fx.close();
  }
});

test("#361 /api/loop/state: staleness beats PAUSE in `state`, but `pauseActive` still reports the sentinel is set (the header's secondary chip)", async () => {
  // No heartbeat seeded at all -> stale -> `state` reads `stalled`, never `paused` — but the
  // PAUSE file is genuinely there, and the client needs that fact to render its own chip.
  const fx = await fixture(undefined, { pause: true });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.state, "stalled");
    assert.equal(body.engine.pauseActive, true);
  } finally {
    fx.close();
  }
});

test("#733 /api/loop/state serves the raw EMERGENCY_STOP sentinel independently, same posture as pauseActive", async () => {
  const fx = await fixture(
    (s) => {
      s.touchLastTick(new Date("2026-07-24T11:59:30.000Z"));
    },
    { estop: true },
  );
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.estopActive, true);
  } finally {
    fx.close();
  }
});

test("#361 /api/loop/state: controlsEnabled mirrors dashboard.controls, true by default, false when set, false when config unreadable", async () => {
  const on = await fixture(undefined, { controls: true });
  const off = await fixture(undefined, { controls: false });
  const unreadable = await fixture(undefined, { config: false });
  try {
    assert.equal((await getJson(on, "/api/loop/state")).controlsEnabled, true);
    assert.equal((await getJson(off, "/api/loop/state")).controlsEnabled, false);
    assert.equal((await getJson(unreadable, "/api/loop/state")).controlsEnabled, false);
  } finally {
    on.close();
    off.close();
    unreadable.close();
  }
});

// ── #642 AC1: the shared read-model extraction changed nothing observable ─────────────────
//
// engine-state derivation, the config allowlist, and MAX_PAGE_LIMIT moved to
// engine/src/state/read-model.ts (this file now imports and re-exports them) so `sapwood status
// --json`/`sapwood events` can share the exact same semantic contract instead of growing a
// second one (the issue's own Why). This test pins the three read routes' bodies against a fixed
// fixture, field by field, so a future edit to read-model.ts that quietly changes a dashboard
// response fails HERE, not in production. `ts`/`logPath`/`config` leaves that are wall-clock- or
// tmp-dir-dependent are asserted against their OWN observed value (the same self-referential
// technique state.test.ts's eventsPage test uses) rather than a literal, since those are not
// what this refactor could have changed — everything ELSE is a literal, exhaustive match.
test("#642 AC1: /api/loop/state, /api/events, /api/spend are byte-identical to their pre-extraction shape (regression pin)", async () => {
  const fx = await fixture((s) => {
    s.upsertWorker({ name: "w1", issue: 10, session_id: "s1", state: "running", started_at: "2026-07-24T11:00:00.000Z", ended_at: null });
    s.recordSpend("w1", 10, 2.5, "2026-07-24T11:15:00.000Z", [
      { model: "opus", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.appendEvent("dispatched", { issue: 10 });
    s.appendEvent("merged", { pr: 20 });
  });
  try {
    const loop = await getJson(fx, "/api/loop/state");
    assert.deepEqual(loop, {
      // No heartbeat was ever seeded (lastTickAt null -> infinite tick age -> stale, and no
      // terminal event -> the bare "crashed or killed" reading, deriveEngineState's own doc).
      engine: {
        state: "stalled",
        reasons: [],
        lastTickAt: null,
        standbyNextCheckSec: null,
        terminal: null,
        pauseActive: false,
        estopActive: false,
      },
      lanes: {
        max: 3,
        items: [
          {
            lane: "w1",
            issue: 10,
            state: "running",
            pr: null,
            held: false, // #906: no PR yet, so no hold episode can exist
            startedAt: "2026-07-24T11:00:00.000Z",
            endedAt: null,
            costUsd: null, // in flight — the settled bill isn't written until reclaim
            estCostUsd: null,
            fixRound: 0, // no fix round entered yet
            contextTokens: null,
            tokenComposition: null,
          },
        ],
      },
      round: null,
      spend: {
        todayUsd: 2.5,
        dailyBudgetUsd: 100,
        runUsd: null,
        runBudgetUsd: null,
        byModel: [{ model: "opus", usd: 2.5, inputTokens: 10, outputTokens: 5 }],
      },
      rings: 1,
      mergedPrs: [20],
      logPath: loop.logPath, // tmp-dir-dependent path — format checked separately below
      config: loop.config, // static leaf values checked separately below (allowlist coverage
      // already has its own dedicated test) — this route's own SHAPE is what's pinned here
      controlsEnabled: true, // baseConfig() never sets dashboard.controls — schema default
      // #894: environment-dependent (the real worktree's git HEAD, and whatever dist/build-meta.json
      // happens to exist on disk) — shape pinned below instead of a hardcoded value; see the
      // #894-specific tests further down for the actual match/mismatch behavior.
      build: loop.build,
    });
    assert.ok(String(loop.logPath).endsWith("sapwood.log"));
    assert.equal(loop.config.lanes.max, 3);
    assert.deepEqual(Object.keys(loop.build).sort(), ["distSha", "distTime", "repoHeadSha"]);

    const events = await getJson(fx, "/api/events");
    assert.deepEqual(events, {
      events: [
        { id: 1, ts: events.events[0].ts, kind: "dispatched", payload: { issue: 10 } },
        { id: 2, ts: events.events[1].ts, kind: "merged", payload: { pr: 20 } },
      ],
      lastId: 2,
    });

    const spend = await getJson(fx, "/api/spend");
    assert.deepEqual(spend, {
      spend: [
        {
          id: 1,
          ts: "2026-07-24T11:15:00.000Z",
          worker: "w1",
          issue: 10,
          usd: 2.5,
          model: "opus",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          // #645 (gate② R2 APPROVED): actor_kind/role/estimated ride the raw /api/spend
          // transport verbatim now, same as state.ts's own spendPage — null here because this
          // fixture's recordSpend call never claims a kind (an unattributed row, never guessed).
          actorKind: null,
          role: null,
          estimated: null,
        },
      ],
      lastId: 1,
    });
  } finally {
    fx.close();
  }
});

// ── #906 (§294 follow-up #7): `held` on served lane rows ────────────────────────────────────

test("#906: a lane row's held field is State.lastHoldEvent(lane, pr) === 'pr-held' — true/false/false for a held, a released, and a PR-less lane", async () => {
  const fx = await fixture((s) => {
    s.upsertWorker({
      name: "w-held",
      issue: 1,
      session_id: "s1",
      state: "driving",
      started_at: "2026-07-24T11:00:00.000Z",
      ended_at: null,
      pr: 101,
    });
    s.appendEvent("pr-held", { worker: "w-held", issue: 1, pr: 101, label: "sapwood:hold" });

    s.upsertWorker({
      name: "w-released",
      issue: 2,
      session_id: "s2",
      state: "driving",
      started_at: "2026-07-24T11:00:00.000Z",
      ended_at: null,
      pr: 102,
    });
    s.appendEvent("pr-held", { worker: "w-released", issue: 2, pr: 102, label: "sapwood:hold" });
    s.appendEvent("pr-released", { worker: "w-released", issue: 2, pr: 102 });

    s.upsertWorker({
      name: "w-nopr",
      issue: 3,
      session_id: "s3",
      state: "running",
      started_at: "2026-07-24T11:00:00.000Z",
      ended_at: null,
    });
  });
  try {
    const loop = await getJson(fx, "/api/loop/state");
    const held = Object.fromEntries(loop.lanes.items.map((l: { lane: string; held: boolean }) => [l.lane, l.held]));
    assert.deepEqual(held, { "w-held": true, "w-released": false, "w-nopr": false });

    // The route's own read-only-handle posture extends to this new read: `lastHoldEvent` (a
    // SELECT) succeeds through the same handle a write against is rejected on.
    assert.equal(fx.state.lastHoldEvent("w-held", 101), "pr-held");
    assert.throws(() => fx.state.appendEvent("merged", { pr: 1 }), /readonly|read-only|attempt to write/i);
  } finally {
    fx.close();
  }
});

test("/api/loop/state carries ceiling reasons only while winding-down (§8)", async () => {
  // A breach with no kill switch → winding-down → reasons surface.
  const fx = await fixture((s) => {
    s.recordCeilingBreach(["daily-budget"], new Date("2026-07-24T11:00:00.000Z"));
    s.touchLastTick(new Date()); // a fresh heartbeat so it isn't stalled (#431: the surviving writer)
  });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.state, "winding-down");
    assert.deepEqual(body.engine.reasons, ["daily-budget"]);
  } finally {
    fx.close();
  }
});

test("/api/loop/state clears ceiling reasons once the kill switch stops the engine (§8)", async () => {
  // KILL_SWITCH outranks the breach → stopped/stopping — reasons must NOT leak a stale
  // budget/kill reason onto a manually stopped dashboard (the P2 from Codex review).
  const fx = await fixture(
    (s) => {
      s.recordCeilingBreach(["daily-budget"], new Date("2026-07-24T11:00:00.000Z"));
      s.touchLastTick(new Date());
    },
    { killSwitch: true },
  );
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.state, "stopped"); // no active lanes in this fixture
    assert.deepEqual(body.engine.reasons, [], "a stopped engine exposes no ceiling reasons");
  } finally {
    fx.close();
  }
});

// ── #894: build identity / dist-vs-repo-HEAD freshness facts ──────────────────────────────

/** Real git plumbing (`git init` + one empty commit), never a fake — `resolveBuildFacts`'s own
 *  `repoHeadSha` shells out to real `git`, so faking the shape here would prove nothing about the
 *  actual subprocess wiring. */
function initGitRepo(dir: string): string {
  mkdirSync(join(dir, "dashboard"), { recursive: true });
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "dashboard", "package.json"), "{}\n");
  writeFileSync(join(dir, "engine", "package.json"), "{}\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // A fresh temp repo inherits the machine's global git config, including `commit.gpgsign` —
  // this fixture needs a real commit to exist, not a real signature, so signing is disabled for
  // this one throwaway repo only (never a real project commit).
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "x"],
    { cwd: dir },
  );
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
}

test("#894 /api/loop/state build: a dist build-meta matching repo HEAD serves the real matching SHAs", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-build-"));
  const dist = join(outer, "dist");
  const repo = join(outer, "repo");
  mkdirSync(dist, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const headSha = initGitRepo(repo);
  writeFileSync(join(dist, "build-meta.json"), JSON.stringify({ sha: headSha, time: "2026-07-24T10:00:00.000Z" }), "utf8");

  const fx = await fixture(undefined, { staticDir: dist, repoDir: join(repo, "dashboard") });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.deepEqual(body.build, { distSha: headSha, distTime: "2026-07-24T10:00:00.000Z", repoHeadSha: headSha });
  } finally {
    fx.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("#894 /api/loop/state build: a dist build-meta naming a SHA the repo has since moved past reports the real divergence", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-build-"));
  const dist = join(outer, "dist");
  const repo = join(outer, "repo");
  mkdirSync(dist, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const headSha = initGitRepo(repo);
  const staleSha = "0000000000000000000000000000000000dead";
  writeFileSync(join(dist, "build-meta.json"), JSON.stringify({ sha: staleSha, time: "2026-07-24T08:00:00.000Z" }), "utf8");

  const fx = await fixture(undefined, { staticDir: dist, repoDir: join(repo, "dashboard") });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.build.distSha, staleSha);
    assert.equal(body.build.distTime, "2026-07-24T08:00:00.000Z");
    assert.equal(body.build.repoHeadSha, headSha);
    assert.notEqual(body.build.distSha, body.build.repoHeadSha, "the two real fixtures are distinguishable, not coincidentally equal");
  } finally {
    fx.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("#894 /api/loop/state build: no build-meta.json and a non-git repoDir both degrade to null, never a guess or a 500", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-build-"));
  const noDist = join(outer, "no-such-dist");
  const notGit = join(outer, "not-a-git-checkout");
  mkdirSync(notGit, { recursive: true });

  const fx = await fixture(undefined, { staticDir: noDist, repoDir: notGit });
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.deepEqual(body.build, { distSha: null, distTime: null, repoHeadSha: null });
  } finally {
    fx.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("/api/loop/state: a missing database starts as an empty read-only dashboard", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-build-"));
  const dbPath = join(outer, "data", "sapwood.sqlite");
  const { server, state, port } = await createDashboardServer({ dbPath, port: 0, now: () => new Date("2026-07-24T12:00:00.000Z") });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: [], lastId: 0 });
  } finally {
    server.close();
    state.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

// #1077 fix round 1 (P2): a first-ever dashboard visit against a repo that has never run
// `sapwood run` is a write-capable root-acquisition chokepoint too — createDashboardServer's
// own bootstrap branch (`if (!existsSync(opts.dbPath)) { new State(opts.dbPath); ... }`)
// constructs a write-mode State, which already stamps the root via ensureRuntimeRoot; this
// pins that the dashboard's own entry point actually reaches it, on a genuinely fresh root
// (a custom-root sibling directory, same convention every other State-derived path uses).
test("createDashboardServer: the missing-database bootstrap self-declares the runtime root (.gitignore + cache/CACHEDIR.TAG)", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-dashboard-root-declare-"));
  const root = join(outer, ".sapwood");
  const dbPath = join(root, "sapwood.sqlite");
  const { server, state } = await createDashboardServer({ dbPath, port: 0, now: () => new Date("2026-07-24T12:00:00.000Z") });
  try {
    assert.equal(existsSync(join(root, ".gitignore")), true);
    assert.equal(existsSync(join(root, "cache", "CACHEDIR.TAG")), true);
  } finally {
    server.close();
    state.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("/api/loop/state round is null when no round is open", async () => {
  const fx = await fixture((s) => {
    s.startRound("2026-07-24T10:00:00.000Z");
    s.closeRound(1, "2026-07-24T11:00:00.000Z");
  });
  try {
    assert.equal((await getJson(fx, "/api/loop/state")).round, null);
  } finally {
    fx.close();
  }
});

test("#407 /api/loop/state serves the newest run's terminal event verbatim — the UI's reason for a dead engine", async () => {
  const fx = await fixture((s) => {
    s.appendEvent("run-started", { configHash: "h" });
    s.appendEvent("run-ended", { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" });
  });
  try {
    const body = await getJson(fx, "/api/loop/state");
    // #746 gate② finding [0]: `eventId` rides along on the wire too — deriveEngineState needs it
    // to order a terminal against a standby signal (read-model.ts's own doc).
    assert.deepEqual(body.engine.terminal, {
      kind: "run-ended",
      payload: { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" },
      eventId: 2,
    });
  } finally {
    fx.close();
  }
});

// #723: end-to-end through the real route + a real (unseeded, deliberately real-wall-clock)
// standby-wait event — the AC12 operator scenario itself, not just the pure derivation. `before`
// brackets the event's real write time (state.ts's appendEvent doc: deliberately unseeded), so
// `now` can be set far enough past it that the countdown assertion is a generous bounded
// passthrough, never a race against how long the write actually took (no-timing-dependent-tests
// doctrine's FINE shape).
test("#723 /api/loop/state: a healthy standby-wait renders standby, not stalled, with a next-check countdown in the payload — even though no tick has EVER landed", async () => {
  const before = new Date();
  const fx = await fixture(
    (s) => {
      s.appendEvent("standby-wait", { attempt: 3, waitSec: 1800 });
    },
    { now: new Date(before.getTime() + 30_000) }, // 30s buffer — the write itself is a sub-ms local insert
  );
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.lastTickAt, null, "no tick was ever written — without the #723 fix this would be `stalled`");
    assert.equal(body.engine.state, "standby");
    assert.equal(typeof body.engine.standbyNextCheckSec, "number");
    // ageSec is at most ~30s (the `before`-anchored buffer); windowSec is 1800 — generously
    // bounded, not a race between two uncontrolled operations.
    assert.ok(body.engine.standbyNextCheckSec > 1700, `countdown was ${body.engine.standbyNextCheckSec}, expected close to 1800`);
  } finally {
    fx.close();
  }
});

test("#723 /api/loop/state: a standby-wait signal older than its own declared waitSec renders stalled, not standby forever", async () => {
  const before = new Date();
  const fx = await fixture(
    (s) => {
      s.appendEvent("standby-wait", { attempt: 3, waitSec: 5 });
    },
    { now: new Date(before.getTime() + 30_000) }, // 30s later — well past the signal's own 5s window
  );
  try {
    const body = await getJson(fx, "/api/loop/state");
    assert.equal(body.engine.state, "stalled");
    assert.equal(body.engine.standbyNextCheckSec, null);
  } finally {
    fx.close();
  }
});

// ── /api/events paging (§8) ────────────────────────────────────────────────────────────────

const seedEvents = (s: State) => {
  // #425: event kinds are a closed union now (engine/src/state/event-kinds/), so five declared
  // kinds stand in for the generated names this fixture used before — /api/events is kind-blind,
  // it only needs five distinct rows.
  const kinds: EventKind[] = ["run-started", "dispatched", "merged", "handoff", "run-ended"];
  kinds.forEach((kind, i) => {
    s.appendEvent(kind, { n: i + 1 });
  });
};

test("/api/events pages ascending by id and reports lastId", async () => {
  const fx = await fixture(seedEvents);
  try {
    const first = await getJson(fx, "/api/events?after=0&limit=2");
    assert.deepEqual(
      first.events.map((e: { id: number }) => e.id),
      [1, 2],
    );
    assert.equal(first.lastId, 2);
    assert.deepEqual(Object.keys(first.events[0]).sort(), ["id", "kind", "payload", "ts"]);
    assert.deepEqual(first.events[0].payload, { n: 1 }); // stored JSON, verbatim

    const next = await getJson(fx, `/api/events?after=${first.lastId}&limit=2`);
    assert.deepEqual(
      next.events.map((e: { id: number }) => e.id),
      [3, 4],
    );
    assert.equal(next.lastId, 4);
  } finally {
    fx.close();
  }
});

test("#489 /api/events surfaces an engine-review-verdict verbatim — a new kind costs no schema change", async () => {
  const payload = {
    worker: "lane-12",
    issue: 12,
    pr: 7,
    head: "a".repeat(40),
    runId: "run-1",
    outcome: "rejected",
    findingCount: 2,
    perAC: { confirmed: 1, "cannot-confirm": 1, "claim-accepted": 0 },
  };
  const fx = await fixture((s) => s.appendEvent("engine-review-verdict", payload));
  try {
    const body = await getJson(fx, "/api/events");
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].kind, "engine-review-verdict");
    assert.deepEqual(body.events[0].payload, payload);
  } finally {
    fx.close();
  }
});

test("/api/events: an empty tail keeps the caller's cursor rather than rewinding it to 0", async () => {
  const fx = await fixture(seedEvents);
  try {
    const tail = await getJson(fx, "/api/events?after=5");
    assert.deepEqual(tail.events, []);
    assert.equal(tail.lastId, 5);
  } finally {
    fx.close();
  }
});

test("/api/events defaults after to 0 and caps limit", async () => {
  const fx = await fixture(seedEvents);
  try {
    const all = await getJson(fx, "/api/events");
    assert.equal(all.events.length, 5);
    assert.equal(all.lastId, 5);
  } finally {
    fx.close();
  }
});

test("/api/events rejects malformed paging params instead of guessing", async () => {
  const fx = await fixture(seedEvents);
  try {
    for (const q of ["?after=-1", "?after=abc", "?limit=0", "?limit=-3", "?limit=nope"]) {
      const res = await fetch(`${fx.origin}/api/events${q}`);
      assert.equal(res.status, 400, `expected 400 for ${q}`);
    }
  } finally {
    fx.close();
  }
});

// ── posture: read-only handle, loopback bind, routing surface ──────────────────────────────

test("the SQLite handle is opened read-only — a write against it is rejected", async () => {
  const fx = await fixture();
  try {
    assert.throws(() => fx.state.appendEvent("merged", { pr: 1 }), /readonly|read-only|attempt to write/i);
  } finally {
    fx.close();
  }
});

test("the server binds 127.0.0.1 only, never 0.0.0.0", async () => {
  const fx = await fixture();
  try {
    assert.equal((fx.server.address() as AddressInfo).address, "127.0.0.1");
  } finally {
    fx.close();
  }
});

test("unknown api routes 404 and wrong methods 405", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fetch(`${fx.origin}/api/nope`)).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/loop/state`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${fx.origin}/api/control`)).status, 405); // the write route is POST-only
  } finally {
    fx.close();
  }
});

// ── /api/spend paging (§8, #360) ───────────────────────────────────────────────────────────

const seedSpend = (s: State) => {
  for (let i = 1; i <= 5; i++) {
    s.recordSpend(`w${i}`, 80 + i, i / 4, `2026-07-24T11:0${i}:00.000Z`, [
      { model: "opus", inputTokens: 100 * i, outputTokens: 10 * i, cacheReadTokens: 5, cacheCreationTokens: 7 },
    ]);
  }
};

test("/api/spend pages ascending by id and reports lastId, rows verbatim", async () => {
  const fx = await fixture(seedSpend);
  try {
    const first = await getJson(fx, "/api/spend?after=0&limit=2");
    assert.deepEqual(
      first.spend.map((r: { id: number }) => r.id),
      [1, 2],
    );
    assert.equal(first.lastId, 2);
    assert.deepEqual(first.spend[0], {
      id: 1,
      ts: "2026-07-24T11:01:00.000Z",
      worker: "w1",
      issue: 81,
      usd: 0.25,
      model: "opus",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
      // #645 (gate② R2 APPROVED): see the AC1 test's own comment above — seedSpend's
      // recordSpend calls never claim a kind either.
      actorKind: null,
      role: null,
      estimated: null,
    });

    const next = await getJson(fx, `/api/spend?after=${first.lastId}&limit=2`);
    assert.deepEqual(
      next.spend.map((r: { id: number }) => r.id),
      [3, 4],
    );
    assert.equal(next.lastId, 4);
  } finally {
    fx.close();
  }
});

test("/api/spend: an empty tail keeps the caller's cursor, and defaults match /api/events", async () => {
  const fx = await fixture(seedSpend);
  try {
    const tail = await getJson(fx, "/api/spend?after=5");
    assert.deepEqual(tail.spend, []);
    assert.equal(tail.lastId, 5);

    const all = await getJson(fx, "/api/spend");
    assert.equal(all.spend.length, 5);
    assert.equal(all.lastId, 5);
  } finally {
    fx.close();
  }
});

test("/api/spend rejects malformed paging params, exactly as /api/events does", async () => {
  const fx = await fixture(seedSpend);
  try {
    for (const q of ["?after=-1", "?after=abc", "?limit=0", "?limit=-3", "?limit=nope"]) {
      assert.equal((await fetch(`${fx.origin}/api/spend${q}`)).status, 400, `expected 400 for ${q}`);
    }
  } finally {
    fx.close();
  }
});

// ── /api/rounds (§8, #360) ─────────────────────────────────────────────────────────────────

test("/api/rounds serves every rounds row — artifact-less ones included — ascending", async () => {
  const fx = await fixture((s) => {
    const r1 = s.startRound("2026-07-24T10:00:00.000Z");
    s.appendEvent("dispatched", { issue: 86 });
    s.appendEvent("merged", { pr: 94 });
    s.closeRound(r1.round_id, "2026-07-24T11:00:00.000Z");
    s.saveRoundArtifact(r1.round_id, 1, JSON.stringify({ roundId: 1, merged: [94] }), "2026-07-24T11:00:01.000Z");
    // The crash-between-closeRound-and-saveRoundArtifact shape (and all pre-#123 history).
    const r2 = s.startRound("2026-07-24T12:00:00.000Z");
    s.appendEvent("dispatched", { issue: 88 });
    s.closeRound(r2.round_id, "2026-07-24T13:00:00.000Z");
  });
  try {
    const body = await getJson(fx, "/api/rounds");
    assert.deepEqual(
      body.rounds.map((r: { roundId: number }) => r.roundId),
      [1, 2],
      "the rounds table is the spine — an artifact-less round is a row, not a gap",
    );
    assert.deepEqual(body.rounds[0], {
      roundId: 1,
      status: "done",
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T11:00:00.000Z",
      // #123 cursors — rounds-row fields the server joins in, NOT artifact fields
      startEventId: 0,
      startSpendId: 0,
      eventCount: 2,
      schemaVersion: 1,
      artifact: { roundId: 1, merged: [94] },
    });
    assert.equal(body.rounds[1].schemaVersion, null, "renders tally-less rather than fabricating one");
    assert.equal(body.rounds[1].artifact, null);
    assert.equal(body.rounds[1].startEventId, 2);
    assert.equal(body.rounds[1].eventCount, 1);
  } finally {
    fx.close();
  }
});

test("/api/rounds is an empty list on a fresh DB, never an error", async () => {
  const fx = await fixture();
  try {
    assert.deepEqual((await getJson(fx, "/api/rounds")).rounds, []);
  } finally {
    fx.close();
  }
});

// ── POST /api/control (§8 / §3 Operations, #360) ───────────────────────────────────────────

const ticking = (s: State) => s.touchLastTick(new Date());

test("POST /api/control accepts exactly the five verbs; garbage is 400", async () => {
  const fx = await fixture(ticking);
  try {
    for (const verb of ["start", "pause", "resume", "stop", "estop"]) {
      assert.equal((await control(fx, verb)).status, 200, `${verb} should be allowlisted`);
    }
    for (const verb of ["", "STOP", "restart", 7, null, { verb: "stop" }]) {
      assert.equal((await control(fx, verb)).status, 400, `unexpected acceptance of ${JSON.stringify(verb)}`);
    }
    assert.equal((await control(fx, undefined)).status, 400, "a bodyless request names no verb");
    const notJson = await fetch(`${fx.origin}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sapwood-control": "1" },
      body: "{oops",
    });
    assert.equal(notJson.status, 400);
  } finally {
    fx.close();
  }
});

test("POST /api/control requires the X-Sapwood-Control header and a JSON content-type", async () => {
  const fx = await fixture(ticking);
  try {
    const noHeader = await fetch(`${fx.origin}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verb: "pause" }),
    });
    assert.equal(noHeader.status, 403);

    const wrongType = await fetch(`${fx.origin}/api/control`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-sapwood-control": "1" },
      body: JSON.stringify({ verb: "pause" }),
    });
    assert.equal(wrongType.status, 415);

    // A cross-origin page that somehow got past the preflight still fails the Origin check.
    const foreign = await control(fx, "pause", {
      headers: { "content-type": "application/json", "x-sapwood-control": "1", origin: "http://evil.example" },
    });
    assert.equal(foreign.status, 403);

    assert.equal(existsSync(join(fx.dir, "PAUSE")), false, "a rejected request must have no side effect");
  } finally {
    fx.close();
  }
});

test("POST /api/attention/dismiss shares /api/control's request guards and validates eventId/kind", async () => {
  const fx = await fixture();
  try {
    const noHeader = await fetch(`${fx.origin}/api/attention/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: 1 }),
    });
    assert.equal(noHeader.status, 403);
    const wrongType = await fetch(`${fx.origin}/api/attention/dismiss`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-sapwood-control": "1" },
      body: JSON.stringify({ eventId: 1 }),
    });
    assert.equal(wrongType.status, 415);
    const foreign = await dismissAttention(
      fx,
      1,
      {
        headers: { "content-type": "application/json", "x-sapwood-control": "1", origin: "http://evil.example" },
      },
      "park-escalated",
    );
    assert.equal(foreign.status, 403);
    for (const eventId of [undefined, 0, -1, 1.5, "1", null]) {
      assert.equal(
        (await dismissAttention(fx, eventId, {}, "park-escalated")).status,
        400,
        `expected ${JSON.stringify(eventId)} to be rejected`,
      );
    }
    for (const kind of [undefined, "", "x".repeat(101), 1, null]) {
      assert.equal((await dismissAttention(fx, 1, {}, kind)).status, 400, `expected kind ${JSON.stringify(kind)} to be rejected`);
    }
  } finally {
    fx.close();
  }
});

test("attention dismissals round-trip, persist across server instances, and skip malformed JSONL lines", async () => {
  const fx = await fixture();
  let second: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  try {
    assert.deepEqual(await getJson(fx, "/api/attention/dismissals"), { eventIds: [] });
    assert.deepEqual(await (await dismissAttention(fx, 17, {}, "park-escalated")).json(), { eventId: 17 });
    assert.deepEqual(await (await dismissAttention(fx, 17, {}, "park-escalated")).json(), { eventId: 17 }, "the write is idempotent");
    const dismissalPath = join(fx.dir, "attention-dismissals.jsonl");
    const persistedLines = readFileSync(dismissalPath, "utf8").trimEnd().split("\n").filter(Boolean);
    assert.equal(persistedLines.length, 1, "idempotent POSTs append exactly one JSONL record");
    assert.equal(JSON.parse(persistedLines[0]!).kind, "park-escalated");
    assert.deepEqual(await getJson(fx, "/api/attention/dismissals"), { eventIds: [17] });
    writeFileSync(dismissalPath, `${readFileSync(dismissalPath, "utf8")}not-json\n`, "utf8");

    await new Promise<void>((resolve) => fx.server.close(() => resolve()));
    fx.state.close();
    second = await createDashboardServer({
      dbPath: join(fx.dir, "sapwood.sqlite"),
      configPath: join(fx.dir, "sapwood.config.yaml"),
      port: 0,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    const res = await fetch(`http://127.0.0.1:${second.port}/api/attention/dismissals`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { eventIds: [17] });
  } finally {
    if (second) {
      await new Promise<void>((resolve) => second!.server.close(() => resolve()));
      second.state.close();
      rmSync(fx.dir, { recursive: true, force: true });
    } else {
      fx.close();
    }
  }
});

test("attention dismiss POST is absent when controls are disabled while its GET remains available", async () => {
  const fx = await fixture(undefined, { controls: false });
  try {
    assert.equal((await dismissAttention(fx, 1, {}, "park-escalated")).status, 404);
    assert.deepEqual(await getJson(fx, "/api/attention/dismissals"), { eventIds: [] });
  } finally {
    fx.close();
  }
});

test("POST /api/control's only effect is sentinel create/remove, and it answers with the post-signal state", async () => {
  const fx = await fixture(ticking);
  const pausePath = join(fx.dir, "PAUSE");
  const killPath = join(fx.dir, "KILL_SWITCH");
  try {
    assert.deepEqual(await (await control(fx, "pause")).json(), { state: "paused" });
    assert.equal(existsSync(pausePath), true);

    assert.deepEqual(await (await control(fx, "resume")).json(), { state: "running" });
    assert.equal(existsSync(pausePath), false);

    // Stop reports the REAL transition — no lanes here, so the drain is already over.
    assert.deepEqual(await (await control(fx, "stop")).json(), { state: "stopped" });
    assert.equal(existsSync(killPath), true);

    // Start clears BOTH sentinels so the next tick runs.
    writeFileSync(pausePath, "", "utf8");
    assert.deepEqual(await (await control(fx, "start")).json(), { state: "running" });
    assert.equal(existsSync(killPath), false);
    assert.equal(existsSync(pausePath), false);
  } finally {
    fx.close();
  }
});

test("#733 POST /api/control estop writes the EMERGENCY_STOP sentinel and its response names the real consequence, never an unqualified 'lost'", async () => {
  const fx = await fixture(ticking);
  const estopPath = join(fx.dir, "EMERGENCY_STOP");
  try {
    assert.equal(existsSync(estopPath), false);
    const res = await control(fx, "estop");
    assert.equal(res.status, 200);
    assert.equal(existsSync(estopPath), true);
    const body = (await res.json()) as { state: string; message: string };
    // #733 engine-agent finding [0]: the AC requires the response text to state the consequence
    // as an IMMEDIATE HARD KILL with NO DRAIN — assert those claims directly rather than only the
    // retained/stranded half, so the test actually reds if either claim is removed or contradicted.
    assert.match(body.message, /immediate/i, "must state the kill is immediate");
    assert.match(body.message, /hard kill/i, "must state the kill is a HARD kill, not the drain-first Stop tier");
    assert.match(body.message, /no drain/i, "must state there is no drain window at all");
    assert.doesNotMatch(body.message, /\blost\b/i, "WIP is stranded pending review, never unconditionally 'lost'");
    assert.match(body.message, /stranded|retained/i);
    assert.match(body.message, /human review|needs-human/i);
  } finally {
    fx.close();
  }
});

test("#733 dashboard.controls: false rejects estop exactly like the other four verbs", async () => {
  const fx = await fixture(ticking, { controls: false });
  try {
    assert.equal((await control(fx, "estop")).status, 404);
    assert.equal(existsSync(join(fx.dir, "EMERGENCY_STOP")), false);
  } finally {
    fx.close();
  }
});

test("POST /api/control stop reports `stopping` while lanes are still draining (never an optimistic flip)", async () => {
  const fx = await fixture((s) => {
    ticking(s);
    s.upsertWorker({ name: "w1", issue: 86, session_id: "s1", state: "running", started_at: "2026-07-24T11:00:00.000Z", ended_at: null });
  });
  try {
    assert.deepEqual(await (await control(fx, "stop")).json(), { state: "stopping" });
    // ...and the same word the shared derivation gives `sapwood status`.
    assert.equal((await getJson(fx, "/api/loop/state")).engine.state, "stopping");
  } finally {
    fx.close();
  }
});

test("dashboard.controls: false removes the route structurally — 404, not a hidden button", async () => {
  const fx = await fixture(ticking, { controls: false });
  try {
    assert.equal((await control(fx, "pause")).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/control`)).status, 404);
    assert.equal(existsSync(join(fx.dir, "PAUSE")), false);
    assert.equal((await fetch(`${fx.origin}/api/loop/state`)).status, 200, "the read surface is untouched");
  } finally {
    fx.close();
  }
});

test("an unreadable config leaves the write route unregistered (fail-closed)", async () => {
  const fx = await fixture(ticking, { config: false });
  try {
    assert.equal((await control(fx, "pause")).status, 404);
  } finally {
    fx.close();
  }
});

test("no control request can write through the SQLite handle — it stays read-only", async () => {
  const fx = await fixture(ticking);
  try {
    assert.equal((await control(fx, "pause")).status, 200);
    assert.throws(() => fx.state.appendEvent("merged", { pr: 1 }), /readonly|read-only|attempt to write/i);
  } finally {
    fx.close();
  }
});

// ── static serving (§8, #360) ──────────────────────────────────────────────────────────────

test("dashboard/dist statics are served from the same server, and /api keeps precedence", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-dist-"));
  const dist = join(outer, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(outer, "secret.txt"), "not yours", "utf8"); // a real file OUTSIDE the root
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>sapwood</title>", "utf8");
  writeFileSync(join(dist, "assets", "app.js"), "export const x = 1;\n", "utf8");
  const fx = await fixture(undefined, { staticDir: dist });
  try {
    const index = await fetch(`${fx.origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /sapwood/);

    const asset = await fetch(`${fx.origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);

    // A client-routed path falls back to the SPA shell; the API namespace never does.
    assert.equal((await fetch(`${fx.origin}/round/12`)).status, 200);
    assert.equal((await fetch(`${fx.origin}/api/nope`)).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/loop/state`)).status, 200);

    // No escaping the static root — an encoded traversal at a file that really exists next to
    // dist must not be readable, and must not be laundered into the SPA fallback either.
    assert.equal((await fetch(`${fx.origin}/%2e%2e%2fsecret.txt`)).status, 404);
  } finally {
    fx.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a symlink under dist pointing outside it is refused, not followed", async () => {
  const outer = mkdtempSync(join(tmpdir(), "sapwood-dist-"));
  const dist = join(outer, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(outer, "secret.txt"), "not yours", "utf8");
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>sapwood</title>", "utf8");
  // Both shapes: a link AT a file outside the root, and a link at the directory holding it —
  // the second one has a lexically-innocent request path all the way to the last segment.
  symlinkSync(join(outer, "secret.txt"), join(dist, "leak.txt"));
  symlinkSync(outer, join(dist, "up"));
  const fx = await fixture(undefined, { staticDir: dist });
  try {
    for (const path of ["/leak.txt", "/up/secret.txt"]) {
      const res = await fetch(`${fx.origin}${path}`);
      assert.equal(res.status, 404, `${path} escaped the static root`);
      assert.doesNotMatch(await res.text(), /not yours/, `${path} leaked the file's contents`);
    }
    assert.equal((await fetch(`${fx.origin}/`)).status, 200, "ordinary serving is unaffected");
  } finally {
    fx.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("statics 404 honestly when dashboard/dist has not been built", async () => {
  const fx = await fixture(undefined, { staticDir: join(tmpdir(), "sapwood-no-such-dist") });
  try {
    assert.equal((await fetch(`${fx.origin}/`)).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/loop/state`)).status, 200, "the API works with or without a build");
  } finally {
    fx.close();
  }
});

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

function baseConfig(): Record<string, unknown> {
  return { board: { owner: "acme", repo: "widgets", projectNumber: 4 } };
}

interface Fixture {
  origin: string;
  /** The DB's data dir — where the PAUSE/KILL_SWITCH sentinels live. */
  dir: string;
  state: State;
  server: Server;
  close: () => void;
}

interface FixtureOpts {
  config?: boolean;
  killSwitch?: boolean;
  pause?: boolean;
  estop?: boolean;
  /** Written as `dashboard.controls` — omitted leaves the schema default (true). */
  controls?: boolean;
  staticDir?: string;
  /** #894: overrides where `/api/loop/state`'s `build.repoHeadSha` reads its live git HEAD from
   *  — omitted keeps `createDashboardServer`'s own default (this package's repo root). */
  repoDir?: string;
  /** #723: overrides the fixed clock the route reads `now` through — needed only by tests that
   *  compare a real `appendEvent`-written `ts` (deliberately unseeded, state.ts's own doc)
   *  against the route's `now`, e.g. the standby-countdown test below. Omitted keeps the same
   *  fixed "2026-07-24T12:00:00.000Z" every other test in this file relies on. */
  now?: Date;
}

/** A temp-dir DB seeded through a WRITABLE handle, then served through a read-only one. */
async function fixture(seed?: (s: State) => void, opts: FixtureOpts = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const writable = new State(dbPath);
  seed?.(writable);
  writable.close();

  // The kill switch is a file sentinel in the DB's own data dir (State.killSwitchPath) — touch
  // it the same way an operator or `/sapwood-stop` would, so isKillSwitchActive() reads true.
  if (opts.killSwitch) writeFileSync(join(dir, "KILL_SWITCH"), "", "utf8");
  if (opts.pause) writeFileSync(join(dir, "PAUSE"), "", "utf8");
  if (opts.estop) writeFileSync(join(dir, "EMERGENCY_STOP"), "", "utf8");

  let configPath: string | undefined;
  if (opts.config !== false) {
    configPath = join(dir, "sapwood.config.yaml");
    const cfg = opts.controls === undefined ? baseConfig() : { ...baseConfig(), dashboard: { controls: opts.controls } };
    writeFileSync(configPath, JSON.stringify(cfg), "utf8"); // JSON is valid YAML
  } else {
    configPath = join(dir, "missing.yaml");
  }

  const { server, state, port } = await createDashboardServer({
    dbPath,
    configPath,
    port: 0,
    // Pinned to the same day every seeded spend/telemetry date in this file uses — todayUsd/
    // byModel are day-scoped reads against the REAL clock otherwise, which made the suite a
    // date-rollover time bomb (green on 2026-07-24, red from the 25th — caught live on main).
    now: () => opts.now ?? new Date("2026-07-24T12:00:00.000Z"),
    ...(opts.staticDir === undefined ? {} : { staticDir: opts.staticDir }),
    ...(opts.repoDir === undefined ? {} : { repoDir: opts.repoDir }),
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    dir,
    state,
    server,
    close: () => {
      server.close();
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A well-formed control request: the two same-origin headers §8 requires, and nothing else. */
function control(fx: Fixture, verb: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fx.origin}/api/control`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sapwood-control": "1" },
    body: JSON.stringify({ verb }),
    ...init,
  });
}

function dismissAttention(fx: Fixture, eventId: unknown, init: RequestInit = {}, kind?: unknown): Promise<Response> {
  const body = { eventId, ...(kind === undefined ? {} : { kind }) };
  return fetch(`${fx.origin}/api/attention/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sapwood-control": "1" },
    body: JSON.stringify(body),
    ...init,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
async function getJson(fx: Fixture, path: string): Promise<any> {
  const res = await fetch(`${fx.origin}${path}`);
  assert.equal(res.status, 200, `${path} -> ${res.status}`);
  assert.equal(res.headers.get("content-type"), "application/json");
  return await res.json();
}
