// stop-control.test.ts (#731): first-class CLI verbs (`pause`/`stop`/`estop`, each with a
// `clear` form) over the three existing file sentinels (data/PAUSE, data/KILL_SWITCH,
// data/EMERGENCY_STOP) that state.ts's own pausePath/killSwitchPath/estopPath already define and
// conductor.ts's tick() already reads. THIN WRAPPERS ONLY — every assertion here proves the CLI
// verb's effect is what a real `State` (the engine's own read path) observes via
// isPauseActive()/isKillSwitchActive()/isEstopActive(), never a hand-rolled existsSync check
// against a hardcoded path — so a filename drift between cli.ts and state.ts would fail these
// tests, not just go unnoticed. Real tmpdir State, no timers/clocks (repo rule).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../cli.js";
import { State } from "../state/state.js";

function withDataDir<T>(fn: (dir: string, dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-stop-control-"));
  try {
    return fn(dir, join(dir, "sapwood.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, costLine = "cost: { dailyBudgetUsd: 50 }\n"): string {
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, `board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\n${costLine}`);
  return path;
}

// ── pause ────────────────────────────────────────────────────────────────────────────────────

test("#731: sapwood pause creates data/PAUSE — state.ts's own isPauseActive() sees it (effect-identical to `touch`)", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "pause", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /PAUSE/);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), true);
    s.close();
  });
});

test("#731: sapwood pause clear removes data/PAUSE — state.ts's own isPauseActive() flips false (effect-identical to `rm -f`)", () => {
  withDataDir((dir, dbPath) => {
    const s0 = new State(dbPath);
    s0.close();
    writeFileSync(join(dir, "PAUSE"), "");
    const res = runCli(["node", "sapwood", "pause", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(existsSync(join(dir, "PAUSE")), false);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), false);
    s.close();
  });
});

test("#731: sapwood pause is idempotent — re-activating an already-active PAUSE is a documented no-op, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    const first = runCli(["node", "sapwood", "pause", dbPath]);
    assert.equal(first.code, 0, first.stderr);
    const second = runCli(["node", "sapwood", "pause", dbPath]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already/i);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), true);
    s.close();
  });
});

test("#731: sapwood pause clear on an inactive PAUSE is a documented no-op, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const res = runCli(["node", "sapwood", "pause", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /not present|nothing to clear/i);
  });
});

// ── stop (KILL_SWITCH) ──────────────────────────────────────────────────────────────────────

test("#731: sapwood stop creates data/KILL_SWITCH — state.ts's own isKillSwitchActive() sees it", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "stop", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /KILL_SWITCH/);
    const s = new State(dbPath);
    assert.equal(s.isKillSwitchActive(), true);
    s.close();
  });
});

test("#731: sapwood stop clear removes data/KILL_SWITCH", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const res = runCli(["node", "sapwood", "stop", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    const s = new State(dbPath);
    assert.equal(s.isKillSwitchActive(), false);
    s.close();
  });
});

test("#731: sapwood stop --config reports the configured drain window in its activation message", () => {
  withDataDir((dir, dbPath) => {
    const cfgPath = writeConfig(dir, "cost: { dailyBudgetUsd: 50, drainWindowSec: 42 }\n");
    const res = runCli(["node", "sapwood", "stop", dbPath, "--config", cfgPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /42/);
  });
});

// ── estop (EMERGENCY_STOP) — the confirmation-gated tier ───────────────────────────────────

test("#731 owner ruling: sapwood estop WITHOUT --confirm refuses to act — no sentinel written, error names the flag", () => {
  withDataDir((dir, dbPath) => {
    const res = runCli(["node", "sapwood", "estop", dbPath]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--confirm/);
    assert.equal(existsSync(join(dir, "EMERGENCY_STOP")), false, "no sentinel written on refusal");
  });
});

test("#731: sapwood estop --confirm creates data/EMERGENCY_STOP — state.ts's own isEstopActive() sees it", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "estop", dbPath, "--confirm"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /EMERGENCY_STOP/);
    const s = new State(dbPath);
    assert.equal(s.isEstopActive(), true);
    s.close();
  });
});

test("#731: sapwood estop clear removes data/EMERGENCY_STOP and does NOT require --confirm", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, "EMERGENCY_STOP"), "");
    const res = runCli(["node", "sapwood", "estop", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    const s = new State(dbPath);
    assert.equal(s.isEstopActive(), false);
    s.close();
  });
});

test("#731: sapwood estop clear on an inactive EMERGENCY_STOP is a documented no-op, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const res = runCli(["node", "sapwood", "estop", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /not present|nothing to clear/i);
  });
});

// ── fail-closed on unknown verbs/args (no "did nothing silently") ─────────────────────────

test("#731: sapwood pause with an unknown flag fails closed, exit 1, never silently activates", () => {
  withDataDir((dir, dbPath) => {
    const res = runCli(["node", "sapwood", "pause", dbPath, "--bogus"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown/i);
    assert.equal(existsSync(join(dir, "PAUSE")), false, "the invalid invocation must not have side-effected the sentinel");
  });
});

test("#731: sapwood stop with an unknown flag fails closed, exit 1", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "stop", dbPath, "--bogus"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown/i);
  });
});

test("#731: sapwood estop --confirm with an unknown extra positional fails closed, exit 1", () => {
  withDataDir((dir, dbPath) => {
    const res = runCli(["node", "sapwood", "estop", dbPath, "extra-arg", "--confirm"]);
    assert.equal(res.code, 1);
    assert.equal(existsSync(join(dir, "EMERGENCY_STOP")), false);
  });
});

test("#731: --confirm is rejected as an unknown flag on pause/stop (estop-only, never silently accepted elsewhere)", () => {
  withDataDir((_dir, dbPath) => {
    const pauseRes = runCli(["node", "sapwood", "pause", dbPath, "--confirm"]);
    assert.equal(pauseRes.code, 1);
    const stopRes = runCli(["node", "sapwood", "stop", dbPath, "--confirm"]);
    assert.equal(stopRes.code, 1);
  });
});

// ── --config fail-closed on a bad path (#710 semantics, same posture as status/events) ─────

test("#731: sapwood pause --config with a missing/unreadable path is a HARD error, exit 1, never a silent fallback", () => {
  withDataDir((dir, dbPath) => {
    const res = runCli(["node", "sapwood", "pause", dbPath, "--config", join(dir, "does-not-exist.yaml")]);
    assert.equal(res.code, 1);
    assert.equal(existsSync(join(dir, "PAUSE")), false, "a bad --config must abort before any sentinel write");
  });
});

test("#731: sapwood stop --config requires a path — a missing operand fails closed", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "stop", dbPath, "--config"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--config requires a path/);
  });
});

// ── --help never side-effects ───────────────────────────────────────────────────────────────

test("#731: --help on all three tiers prints usage and exits 0 without touching any sentinel", () => {
  withDataDir((dir, dbPath) => {
    for (const cmd of ["pause", "stop", "estop"]) {
      const res = runCli(["node", "sapwood", cmd, dbPath, "--help"]);
      assert.equal(res.code, 0, `${cmd} --help`);
      assert.match(res.stdout, new RegExp(cmd, "i"));
    }
    assert.equal(existsSync(join(dir, "PAUSE")), false);
    assert.equal(existsSync(join(dir, "KILL_SWITCH")), false);
    assert.equal(existsSync(join(dir, "EMERGENCY_STOP")), false);
  });
});

// ── help text documents the three tiers' distinct semantics honestly ───────────────────────

test("#731: sapwood stop --help documents drain-then-hard-kill semantics", () => {
  const res = runCli(["node", "sapwood", "stop", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /drain/i);
});

test("#731: sapwood estop --help documents no-drain / WIP-loss semantics and the required flag", () => {
  const res = runCli(["node", "sapwood", "estop", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /no drain|immediate/i);
  assert.match(res.stdout, /WIP|work.in.progress/i);
  assert.match(res.stdout, /--confirm/);
});

test("#731: sapwood pause --help documents no-new-dispatch / in-flight-proceeds semantics", () => {
  const res = runCli(["node", "sapwood", "pause", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /in-flight/i);
});
