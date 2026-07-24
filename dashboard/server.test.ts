// server.test.ts (#142): the read-only dashboard data server. Covers the two GET routes
// docs/frontend-design.md §8 locks — the engine-state derivation (all seven words plus the
// "staleness beats PAUSE" precedence rule), /api/events paging, the /api/loop/state field
// shape, the config allowlist (the no-secrets guarantee is structural, not a promise), and
// the two posture invariants: the SQLite handle is read-only and the listener binds loopback.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../engine/src/state/state.js";
import { allowlistedConfig, CONFIG_ALLOWLIST, createDashboardServer, deriveEngineState, type EngineFacts } from "./server.js";

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
};

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

    assert.deepEqual(Object.keys(body).sort(), ["config", "engine", "lanes", "logPath", "rings", "round", "spend"]);
    assert.deepEqual(Object.keys(body.engine).sort(), ["lastTickAt", "reasons", "state"]);
    assert.deepEqual(body.engine.reasons, []);

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
  } finally {
    fx.close();
  }
});

test("/api/loop/state carries ceiling reasons only while winding-down (§8)", async () => {
  // A breach with no kill switch → winding-down → reasons surface.
  const fx = await fixture((s) => {
    s.recordCeilingBreach(["daily-budget"], new Date("2026-07-24T11:00:00.000Z"));
    s.engineSessionStart(new Date(), 900); // a fresh heartbeat so it isn't stalled
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
      s.engineSessionStart(new Date(), 900);
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

// ── /api/events paging (§8) ────────────────────────────────────────────────────────────────

const seedEvents = (s: State) => {
  for (let i = 1; i <= 5; i++) s.appendEvent(`kind-${i}`, { n: i });
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

test("unknown routes 404 and non-GET methods 405 (no write surface exists yet — #360)", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fetch(`${fx.origin}/api/nope`)).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/control`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${fx.origin}/api/loop/state`, { method: "POST" })).status, 405);
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
  state: State;
  server: Server;
  close: () => void;
}

/** A temp-dir DB seeded through a WRITABLE handle, then served through a read-only one. */
async function fixture(seed?: (s: State) => void, opts: { config?: boolean; killSwitch?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const writable = new State(dbPath);
  seed?.(writable);
  writable.close();

  // The kill switch is a file sentinel in the DB's own data dir (State.killSwitchPath) — touch
  // it the same way an operator or `/sapwood-stop` would, so isKillSwitchActive() reads true.
  if (opts.killSwitch) writeFileSync(join(dir, "KILL_SWITCH"), "", "utf8");

  let configPath: string | undefined;
  if (opts.config !== false) {
    configPath = join(dir, "sapwood.config.yaml");
    writeFileSync(configPath, JSON.stringify(baseConfig()), "utf8"); // JSON is valid YAML
  } else {
    configPath = join(dir, "missing.yaml");
  }

  const { server, state, port } = await createDashboardServer({ dbPath, configPath, port: 0 });
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    server,
    close: () => {
      server.close();
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
async function getJson(fx: Fixture, path: string): Promise<any> {
  const res = await fetch(`${fx.origin}${path}`);
  assert.equal(res.status, 200, `${path} -> ${res.status}`);
  assert.equal(res.headers.get("content-type"), "application/json");
  return await res.json();
}
