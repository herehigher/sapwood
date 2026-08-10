// server.test.ts (#142, extended in #360): the dashboard data server. Covers the whole surface
// docs/frontend-design.md §8 locks — the engine-state derivation (all seven words plus the
// "staleness beats PAUSE" precedence rule), the four read routes' paging and field shapes, the
// config allowlist (the no-secrets guarantee is structural, not a promise), the single gated
// write route (verb allowlist, same-origin defences, sentinel-only side effects, post-signal
// state), the statics, and the posture invariants: the SQLite handle stays read-only even with
// a write route registered, and the listener binds loopback.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  standbyWaiting: false,
  terminal: null,
};

// #407: the three terminal shapes for the dead-engine truth table below.
const STALE_TICK = "2026-07-24T11:00:00.000Z"; // an hour ago — past the 900s gap
const CLEAN_STOP = { kind: "run-ended", payload: { stoppedBy: "signal" } } as const;
const SELF_STALL = { kind: "engine-stalled", payload: { openRoundPhase: "executing", lastEventKind: "park-wait-heartbeat" } } as const;

test("engine state: a ticking engine with an open round is running", () => {
  assert.equal(deriveEngineState(FRESH), "running");
});

test("engine state: no open round + a standby-wait newer than any standby-exit is standby, not stalled", () => {
  assert.equal(deriveEngineState({ ...FRESH, roundOpen: false, standbyWaiting: true }), "standby");
  // a closed round with no standby wait is still just running — standby is the PARKED signal
  assert.equal(deriveEngineState({ ...FRESH, roundOpen: false, standbyWaiting: false }), "running");
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
    { kind: "run-ended", payload: { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" } },
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
    s.startRound("2026-07-24T10:00:00.000Z");
  });
  try {
    const body = await getJson(fx, "/api/loop/state");

    assert.deepEqual(Object.keys(body).sort(), ["config", "controlsEnabled", "engine", "lanes", "logPath", "rings", "round", "spend"]);
    assert.deepEqual(Object.keys(body.engine).sort(), ["lastTickAt", "pauseActive", "reasons", "state", "terminal"]);
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
    assert.equal(w1.contextTokens, 41000);
    assert.deepEqual(w1.tokenComposition, { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 90000, cacheCreationTokens: 4000 });
    assert.equal(w1.pr, null);
    // settled at reclaim: the spend_ledger sum for that lane
    assert.equal(w2.costUsd, 1.25);
    assert.equal(w2.estCostUsd, null);
    assert.equal(w2.contextTokens, null);
    assert.equal(w2.tokenComposition, null);
    assert.equal(w2.pr, 97);

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
      engine: { state: "stalled", reasons: [], lastTickAt: null, terminal: null, pauseActive: false },
      lanes: {
        max: 3,
        items: [
          {
            lane: "w1",
            issue: 10,
            state: "running",
            pr: null,
            startedAt: "2026-07-24T11:00:00.000Z",
            endedAt: null,
            costUsd: null, // in flight — the settled bill isn't written until reclaim
            estCostUsd: null,
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
      logPath: loop.logPath, // tmp-dir-dependent path — format checked separately below
      config: loop.config, // static leaf values checked separately below (allowlist coverage
      // already has its own dedicated test) — this route's own SHAPE is what's pinned here
      controlsEnabled: true, // baseConfig() never sets dashboard.controls — schema default
    });
    assert.ok(String(loop.logPath).endsWith("sapwood.log"));
    assert.equal(loop.config.lanes.max, 3);

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
    assert.deepEqual(body.engine.terminal, {
      kind: "run-ended",
      payload: { stoppedBy: "stop-condition", stopCondition: "afterIssuesMerged" },
    });
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

test("POST /api/control accepts exactly the four verbs; estop and garbage are 400", async () => {
  const fx = await fixture(ticking);
  try {
    for (const verb of ["start", "pause", "resume", "stop"]) {
      assert.equal((await control(fx, verb)).status, 200, `${verb} should be allowlisted`);
    }
    // estop stays OFF the allowlist until the #293 EMERGENCY_STOP engine sentinel exists.
    assert.equal((await control(fx, "estop")).status, 400);
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
  /** Written as `dashboard.controls` — omitted leaves the schema default (true). */
  controls?: boolean;
  staticDir?: string;
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
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    ...(opts.staticDir === undefined ? {} : { staticDir: opts.staticDir }),
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

// biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
async function getJson(fx: Fixture, path: string): Promise<any> {
  const res = await fetch(`${fx.origin}${path}`);
  assert.equal(res.status, 200, `${path} -> ${res.status}`);
  assert.equal(res.headers.get("content-type"), "application/json");
  return await res.json();
}
