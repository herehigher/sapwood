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
import { loadConfig } from "../config/config.js";
import { buildSpendSection } from "../state/read-model.js";
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
      "estopActive",
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
    assert.equal(body.estopActive, false);
    assert.equal(body.pauseActive, false);
    assert.equal(body.ceilingBreach, null);
    assert.equal(body.drivingCount, 1);
    assert.equal(body.unadjudicatedConcerns, 0);

    assert.equal(body.lanes.length, 2);
    const [w1, w2] = body.lanes;
    // #705: neither seeded lane went through a Supervisor.dispatch()/resume() call (they're
    // hand-seeded WorkerRows), so there is no `lane-spawned`/`worker-heartbeat` event for
    // either — every runtime anchor reports its own honest "nothing known yet" value, never a
    // fabricated dead/alive verdict or a guessed worktree path.
    assert.deepEqual(w1, {
      lane: "lane-12-abcd",
      issue: 12,
      pr: null,
      state: "running",
      startedAt: "2026-07-06T10:00:00.000Z",
      endedAt: null,
      settledUsd: null, // in flight — never a fabricated $0
      pid: null,
      pidAlive: "unknown",
      worktreePath: null,
      lastHeartbeat: null,
    });
    assert.deepEqual(w2, {
      lane: "lane-9-efgh",
      issue: 9,
      pr: 101,
      state: "driving",
      startedAt: "2026-07-05T09:00:00.000Z",
      endedAt: null,
      settledUsd: 12.5,
      pid: null,
      pidAlive: "unknown",
      worktreePath: null,
      lastHeartbeat: null,
    });

    assert.equal(body.config.available, true);
    assert.equal(body.config.provenance, configPath);
    assert.equal(body.config.lanesMax, 3);
    assert.equal(body.config.dailyBudgetUsd, 50);
  });
});

// #705 AC5: the per-lane runtime-anchor fields (pid/pidAlive/worktreePath/lastHeartbeat) are an
// ADDITIVE change under the formatVersion contract (read-model.ts's StatusDTO doc: "a future
// field is added here, never removed/renamed/retyped, without bumping the version") — pinned
// here rather than merely asserted in prose, so a future PR that DID bump formatVersion for an
// additive change, or that silently dropped/renamed one of the pre-#705 lane fields, fails this
// test.
test("#705 AC5: status --json stays formatVersion 1 with the new anchor fields present, and every pre-#705 lane field is untouched — proves the addition is additive, not a breaking change", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const seed = new State(dbPath);
    seed.upsertWorker({
      name: "lane-additive",
      issue: 5,
      session_id: "s1",
      state: "running",
      started_at: "2026-08-06T00:00:00.000Z",
      ended_at: null,
    });
    seed.close();

    const r = runCli(["node", "sapwood", "status", dbPath, "--config", configPath, "--json"]);
    assert.equal(r.code, 0);
    const body = parseStdout(r);

    // formatVersion did NOT move — an additive field is not a contract bump.
    assert.equal(body.formatVersion, 1);

    // A "legacy" consumer that only ever destructured the pre-#705 fields still gets exactly
    // the same values it always did — the new keys are additions, not replacements.
    const { lane, issue, pr, state, startedAt, endedAt, settledUsd } = body.lanes[0];
    assert.deepEqual(
      { lane, issue, pr, state, startedAt, endedAt, settledUsd },
      {
        lane: "lane-additive",
        issue: 5,
        pr: null,
        state: "running",
        startedAt: "2026-08-06T00:00:00.000Z",
        endedAt: null,
        settledUsd: null,
      },
    );

    // The new fields are genuinely present (not merely "didn't break anything").
    assert.ok("pid" in body.lanes[0]);
    assert.ok("pidAlive" in body.lanes[0]);
    assert.ok("worktreePath" in body.lanes[0]);
    assert.ok("lastHeartbeat" in body.lanes[0]);
  });
});

// #645 P2-4 (gate② finding): these four spend-section tests used to seed rows against the REAL
// wall clock (`new Date()`) and then read "today" through `runCli`'s `sapwood status --json`,
// which itself reads the real wall clock a second time at CLI-invocation moment (cli.ts's
// `runStatus`, #403's own "deliberate wall-clock read" — a composition root, so it takes no
// injectable clock). A UTC-midnight crossing between the seed and the read could put the two on
// different calendar days and flip the day-windowed assertions below — a real instance of the
// repo's timing-dependent-tests ban. Fixed by removing the dependency rather than padding it:
// these tests build the `State` and call `buildSpendSection` (the read-model function under
// test) DIRECTLY with one FIXED, explicitly injected `now`, shared by both the seed timestamps
// and the read — the exact "inject a fixed clock/explicit now into the read path" fix. The CLI
// wiring itself (JSON shape, config resolution) stays covered by the AC2/AC4 tests above/below,
// which are not day-window-sensitive.

test("#642/#645 AC3: spend section reports settled-by-worker + settled-by-role + review + unclassified + incomplete — a row with no actor_kind at all is NEVER folded into a fabricated zero", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const cfg = loadConfig(configPath);
    const state = new State(dbPath);
    state.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    state.recordSpend("lane-a", 1, 3, now.toISOString(), [], "worker");
    // #612's own review-spend key — deliberately never a `workers.name` row; now its own bucket.
    state.recordSpend("lane-a:engine-review", 1, 0.6, now.toISOString(), [], "engine-review");
    state.recordSpend("role-po-align-1", 0, 0.5, now.toISOString(), [], "peripheral-role", "po-align");
    // No actor_kind claimed at all — the genuinely unattributed case.
    state.recordSpend("nobody-owns-this-key", 9, 0.1, now.toISOString());

    const spend = buildSpendSection(state, cfg, now);
    state.close();

    assert.equal(spend.todayUsd, 3 + 0.6 + 0.5 + 0.1);
    assert.equal(spend.dailyBudgetUsd, 50);
    assert.deepEqual(spend.settledByWorker, [{ worker: "lane-a", usd: 3 }]);
    assert.deepEqual(spend.settledByRole, [{ role: "po-align", usd: 0.5 }]);
    assert.equal(spend.reviewUsd, 0.6);
    assert.equal(spend.unclassifiedUsd, 0.1);
    assert.equal(spend.incomplete, true);
  });
});

test("#645 P1-2: under the DEFAULT engine-agent reviewer mode, a fully-attributed day (unclassifiedUsd: 0) still reports incomplete: true — the deliberate-absence review-omission class is structurally possible under that mode and can never be proven absent from the ledger alone (the OLD `unclassifiedUsd > 0` rule pinned the wrong behavior)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir); // reviewer.mode defaults to "engine-agent"
    const cfg = loadConfig(configPath);
    const state = new State(dbPath);
    state.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    state.recordSpend("lane-a", 1, 2, now.toISOString(), [], "worker");

    const spend = buildSpendSection(state, cfg, now);
    state.close();

    assert.equal(spend.unclassifiedUsd, 0, "not a fabricated non-zero — every row IS attributed");
    assert.equal(
      spend.incomplete,
      true,
      "engine-agent mode's deliberate-absence posture is always possible, ledger-attribution alone can't rule it out",
    );
  });
});

test("#645 P1-2: under a non-engine-agent reviewer mode, a fully-attributed day genuinely reports incomplete: false — the deliberate-absence class does not apply outside engine-agent review", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir, "reviewer: { mode: human }\n");
    const cfg = loadConfig(configPath);
    const state = new State(dbPath);
    state.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    state.recordSpend("lane-a", 1, 2, now.toISOString(), [], "worker");

    const spend = buildSpendSection(state, cfg, now);
    state.close();

    assert.equal(spend.unclassifiedUsd, 0);
    assert.equal(spend.incomplete, false);
  });
});

test("#645: engine-review spend (#612's `<lane>:engine-review` key) is no longer folded into unclassifiedUsd now that it is attributed — it lands in reviewUsd, though `incomplete` stays true under the default engine-agent mode (P1-2)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const cfg = loadConfig(configPath);
    const state = new State(dbPath);
    state.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    state.recordSpend("lane-a", 1, 3, now.toISOString(), [], "worker");
    state.recordSpend("lane-a:engine-review", 1, 0.6, now.toISOString(), [], "engine-review");

    const spend = buildSpendSection(state, cfg, now);
    state.close();

    assert.equal(spend.reviewUsd, 0.6);
    assert.equal(spend.unclassifiedUsd, 0);
    assert.equal(spend.incomplete, true);
  });
});

test("#642 (Codex gate② round-1 P1 finding 3, preserved through #645): the spend section's own identity — todayUsd === sum(settledByWorker) + sum(settledByRole) + reviewUsd + unclassifiedUsd — always holds, over a fixture mixing lane, role, review, and orphan-key spend", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = writeConfig(dir);
    const cfg = loadConfig(configPath);
    const state = new State(dbPath);
    state.upsertWorker({
      name: "lane-a",
      issue: 1,
      session_id: "s1",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    state.upsertWorker({
      name: "lane-b",
      issue: 2,
      session_id: "s2",
      state: "done",
      started_at: "2026-08-04T00:00:00.000Z",
      ended_at: "t",
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    state.recordSpend("lane-a", 1, 1.1, now.toISOString(), [], "worker");
    state.recordSpend("lane-b", 2, 2.2, now.toISOString(), [], "fix-leg");
    state.recordSpend("lane-a:engine-review", 1, 0.3, now.toISOString(), [], "engine-review"); // #612's review-spend key
    state.recordSpend("role-architect-1", 0, 0.5, now.toISOString(), [], "peripheral-role", "architect");
    state.recordSpend("nobody-owns-this-key", 9, 0.4, now.toISOString()); // a genuinely orphaned row

    const spend = buildSpendSection(state, cfg, now);
    state.close();

    const settledSum = spend.settledByWorker.reduce((sum, r) => sum + r.usd, 0) + spend.settledByRole.reduce((sum, r) => sum + r.usd, 0);
    assert.equal(spend.todayUsd, settledSum + spend.reviewUsd + spend.unclassifiedUsd);
    assert.equal(spend.unclassifiedUsd, 0.4); // only the genuinely orphaned row
    assert.equal(spend.incomplete, true);
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

test("#710: an EXPLICIT --config path that is unreadable/invalid now fails CLOSED (exit 1, no JSON body) — supersedes the pre-#710 'renders config section unavailable' stance, which was exactly the silent-degrade trap #710 closes", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    const missing = join(dir, "does-not-exist.yaml");

    const r = runCli(["node", "sapwood", "status", dbPath, "--config", missing, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /sapwood status:/);
  });
});

test("#642 AC4 (as narrowed by #710): with NO --config given and nothing at the default probe names, the config section is still structurally unavailable — the best-effort no-flag case is unchanged", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();

    const r = runCli(["node", "sapwood", "status", dbPath, "--json"]);
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
