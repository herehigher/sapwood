// status-json.test.ts (#642): `sapwood status --json` — the machine-readable StatusDTO. Covers
// the AC2 golden shape pin, AC3's honest settled/unclassified spend split, AC4's config-
// provenance/availability contract, and the AC7 reverse test (the pre-existing TEXT `status`
// path in cli.test.ts is untouched by this feature — this file adds `--json` coverage, it does
// not modify a single assertion in cli.test.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runCli } from "../cli.js";
import { State } from "../state/state.js";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-json-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, extra = ""): string {
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, `board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n${extra}`);
  return path;
}

// biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
function parseStdout(r: { stdout: string }): any {
  return JSON.parse(r.stdout);
}

test("#642 AC2: status --json golden shape — formatVersion 1, per-lane detail, exact keys, over a seeded fixture", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const seed = new State(dbPath);
    seed.upsertWorker({
      name: "lane-12-abcd",
      issue: 12,
      session_id: "s1",
      state: "running",
      started_at: "2026-07-06T10:00:00.000Z",
      ended_at: null,
    });
    seed.upsertWorker({
      name: "lane-9-efgh",
      issue: 9,
      session_id: "s2",
      state: "driving",
      started_at: "2026-07-05T09:00:00.000Z",
      ended_at: null,
      pr: 101,
    });
    const todayIso = new Date().toISOString();
    seed.recordSpend("lane-9-efgh", 9, 12.5, todayIso);
    seed.close();

    const r = runCli(["node", "sapwood", "status", dbPath, "--config", configPath, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    const body = parseStdout(r);

    assert.equal(body.formatVersion, 1);
    assert.equal(body.dbPath, dbPath);
    assert.deepEqual(Object.keys(body).sort(), [
      "ceilingBreach",
      "config",
      "dbPath",
      "drivingCount",
      "formatVersion",
      "generatedAt",
      "killSwitchActive",
      "lanes",
      "pauseActive",
      "schemaVersion",
      "snapshot",
      "spend",
      "unadjudicatedConcerns",
    ]);
    assert.deepEqual(body.snapshot, { mode: "live" });
    assert.equal(body.killSwitchActive, false);
    assert.equal(body.pauseActive, false);
    assert.equal(body.ceilingBreach, null);
    assert.equal(body.drivingCount, 1);
    assert.equal(body.unadjudicatedConcerns, 0);

    assert.equal(body.lanes.length, 2);
    const [w1, w2] = body.lanes;
    assert.deepEqual(w1, {
      lane: "lane-12-abcd",
      issue: 12,
      pr: null,
      state: "running",
      startedAt: "2026-07-06T10:00:00.000Z",
      endedAt: null,
      settledUsd: null, // in flight — never a fabricated $0
    });
    assert.deepEqual(w2, {
      lane: "lane-9-efgh",
      issue: 9,
      pr: 101,
      state: "driving",
      startedAt: "2026-07-05T09:00:00.000Z",
      endedAt: null,
      settledUsd: 12.5,
    });

    assert.equal(body.config.available, true);
    assert.equal(body.config.provenance, configPath);
    assert.equal(body.config.lanesMax, 3);
    assert.equal(body.config.dailyBudgetUsd, 50);
  });
});

test("#642 AC3: spend section reports settled-by-worker + unclassified + incomplete — review-attempt spend (a key with no matching workers row) is NEVER folded into a fabricated zero", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const seed = new State(dbPath);
    seed.upsertWorker({ name: "lane-a", issue: 1, session_id: "s1", state: "done", started_at: "2026-08-04T00:00:00.000Z", ended_at: "t" });
    const now = new Date();
    seed.recordSpend("lane-a", 1, 3, now.toISOString());
    // #612's own review-spend key — deliberately never a `workers.name` row.
    seed.recordSpend("lane-a:engine-review", 1, 0.6, now.toISOString());
    seed.close();

    const r = runCli(["node", "sapwood", "status", dbPath, "--config", configPath, "--json"]);
    assert.equal(r.code, 0);
    const body = parseStdout(r);

    assert.equal(body.spend.todayUsd, 3.6);
    assert.equal(body.spend.dailyBudgetUsd, 50);
    assert.deepEqual(body.spend.settledByWorker, [{ worker: "lane-a", usd: 3 }]);
    assert.equal(body.spend.unclassifiedUsd, 0.6);
    assert.equal(body.spend.incomplete, true);
  });
});

test("#642 AC3: an all-attributed day reports incomplete: false and unclassifiedUsd: 0, not a fabricated non-zero", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const seed = new State(dbPath);
    seed.upsertWorker({ name: "lane-a", issue: 1, session_id: "s1", state: "done", started_at: "2026-08-04T00:00:00.000Z", ended_at: "t" });
    seed.recordSpend("lane-a", 1, 2, new Date().toISOString());
    seed.close();

    const body = parseStdout(runCli(["node", "sapwood", "status", dbPath, "--config", configPath, "--json"]));
    assert.equal(body.spend.unclassifiedUsd, 0);
    assert.equal(body.spend.incomplete, false);
  });
});

test("#642 AC4: without --config, the config section is structurally unavailable — never a guessed default rendered as real values", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    // A config DOES exist in cwd-adjacent form, but since it is never passed via --config here,
    // loadConfig(undefined) auto-probes from the CURRENT working directory (not `dir`) and will
    // not find it — so `available` is false. (Written anyway to prove it is genuinely UNUSED.)
    writeConfig(dir);
    new State(dbPath).close();

    const body = parseStdout(runCli(["node", "sapwood", "status", dbPath, "--json"]));
    assert.deepEqual(body.config, { available: false });
    // Spend/lane facts are still fully reported — only the config-DERIVED section degrades.
    assert.equal(body.spend.dailyBudgetUsd, null);
  });
});

test("#642 AC4: an unreadable/invalid --config path also renders the config section unavailable (never a thrown error, matching the text status's own 'unknown on config error' stance)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    const missing = join(dir, "does-not-exist.yaml");

    const r = runCli(["node", "sapwood", "status", dbPath, "--config", missing, "--json"]);
    assert.equal(r.code, 0);
    const body = parseStdout(r);
    assert.deepEqual(body.config, { available: false });
  });
});

test("#642: status --json against a locked writer fails with a structured busy error, exit 1, never a hang or a raw stack trace", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    // Force rollback-journal locking semantics — see state.test.ts's own comment on WAL letting
    // readers proceed alongside a writer (the same reason this file needs the same workaround).
    const modeSwitch = new DatabaseSync(dbPath);
    modeSwitch.exec("PRAGMA journal_mode = DELETE");
    modeSwitch.close();

    const writer = new DatabaseSync(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const r = runCli(["node", "sapwood", "status", dbPath, "--json"]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      const body = JSON.parse(r.stderr);
      assert.equal(body.formatVersion, 1);
      assert.equal(body.error.kind, "busy");
      assert.ok(body.error.timeoutMs > 0);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
