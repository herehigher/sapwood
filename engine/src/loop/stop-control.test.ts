// stop-control.test.ts (#731): first-class CLI verbs (`pause`/`stop`/`estop`, each with a
// `clear` form) over the three existing file sentinels (.sapwood/PAUSE, .sapwood/KILL_SWITCH,
// .sapwood/EMERGENCY_STOP) that state.ts's own pausePath/killSwitchPath/estopPath already define and
// conductor.ts's tick() already reads. THIN WRAPPERS ONLY — every assertion here proves the CLI
// verb's effect is what a real `State` (the engine's own read path) observes via
// isPauseActive()/isKillSwitchActive()/isEstopActive(), never a hand-rolled existsSync check
// against a hardcoded path — so a filename drift between cli.ts and state.ts would fail these
// tests, not just go unnoticed. Real tmpdir State, no timers/clocks (repo rule).
//
// #1078: pause/stop/estop are MUTATING commands — no db-path positional any more (AC4). Every
// test chdirs into a fresh tmp dir instead of passing an explicit db-path, exactly the DEFAULT,
// cwd-relative `.sapwood/` root a real operator's bare `sapwood pause` would use.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../cli.js";
import { State } from "../state/state.js";

function withDataDir<T>(fn: (dir: string, dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-stop-control-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return fn(dir, join(dir, ".sapwood", "sapwood.sqlite"));
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, costLine = "cost: { dailyBudgetUsd: 50 }\n"): string {
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, `board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\n${costLine}`);
  return path;
}

// `sapwood pause`/`stop`/`estop` are the one mutator that can create a fresh runtime root with
// NO State ever constructed (a bare control invocation against a repo that has never run
// `sapwood run`) — ensureRuntimeRoot must run there too, not just in State's own constructor.
// Drives the DEFAULT, cwd-relative `.sapwood/` root the same way an operator's bare
// `sapwood pause` would — same pattern every test below now uses (#1078: this is no longer the
// special case, since the positional db-path escape hatch is gone).
test("a bare `sapwood pause` against a repo with no prior .sapwood/ self-declares the root", () => {
  withDataDir((dir) => {
    const res = runCli(["node", "sapwood", "pause"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(existsSync(join(dir, ".sapwood", ".gitignore")), true);
  });
});

// ── pause ────────────────────────────────────────────────────────────────────────────────────

test("#731: sapwood pause creates .sapwood/PAUSE — state.ts's own isPauseActive() sees it (effect-identical to `touch`)", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "pause"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /PAUSE/);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), true);
    s.close();
  });
});

test("#731: sapwood pause clear removes .sapwood/PAUSE — state.ts's own isPauseActive() flips false (effect-identical to `rm -f`)", () => {
  withDataDir((dir, dbPath) => {
    const s0 = new State(dbPath);
    s0.close();
    writeFileSync(join(dir, ".sapwood", "PAUSE"), "");
    const res = runCli(["node", "sapwood", "pause", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(existsSync(join(dir, ".sapwood", "PAUSE")), false);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), false);
    s.close();
  });
});

test("#731: sapwood pause is idempotent — re-activating an already-active PAUSE is a documented no-op, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    const first = runCli(["node", "sapwood", "pause"]);
    assert.equal(first.code, 0, first.stderr);
    const second = runCli(["node", "sapwood", "pause"]);
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
    const res = runCli(["node", "sapwood", "pause", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /not present|nothing to clear/i);
  });
});

// ── stop (KILL_SWITCH) ──────────────────────────────────────────────────────────────────────

test("#731: sapwood stop creates .sapwood/KILL_SWITCH — state.ts's own isKillSwitchActive() sees it", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "stop"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /KILL_SWITCH/);
    const s = new State(dbPath);
    assert.equal(s.isKillSwitchActive(), true);
    s.close();
  });
});

test("#731: sapwood stop clear removes .sapwood/KILL_SWITCH", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, ".sapwood", "KILL_SWITCH"), "");
    const res = runCli(["node", "sapwood", "stop", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    const s = new State(dbPath);
    assert.equal(s.isKillSwitchActive(), false);
    s.close();
  });
});

test("#731 gate② P2 (sol): sapwood stop clear's message does NOT conflate pause with emergency stop — a remaining PAUSE freezes only new dispatch, merges resume regardless of it", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, ".sapwood", "KILL_SWITCH"), "");
    const res = runCli(["node", "sapwood", "stop", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    // Merges resume unconditionally w.r.t. pause — the message must never say pause blocks
    // merges (the bug: "dispatch and merges resume ... UNLESS ... pause").
    assert.match(res.stdout, /merges resume.*unless an emergency stop/i);
    // New dispatch is the ONLY thing a remaining pause keeps frozen.
    assert.match(res.stdout, /new dispatch resumes only if pause/i);
    assert.match(res.stdout, /pause.*never froze them|merges are unaffected by pause/i);
  });
});

test("#731: sapwood stop --config reports the configured drain window in its activation message", () => {
  withDataDir((dir) => {
    const cfgPath = writeConfig(dir, "cost: { dailyBudgetUsd: 50, drainWindowSec: 42 }\n");
    const res = runCli(["node", "sapwood", "stop", "--config", cfgPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /42/);
  });
});

// ── estop (EMERGENCY_STOP) — the confirmation-gated tier ───────────────────────────────────

test("#731 owner ruling: sapwood estop WITHOUT --confirm refuses to act — no sentinel written, error names the flag", () => {
  withDataDir((dir) => {
    const res = runCli(["node", "sapwood", "estop"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--confirm/);
    assert.equal(existsSync(join(dir, ".sapwood", "EMERGENCY_STOP")), false, "no sentinel written on refusal");
  });
});

test("#731: sapwood estop --confirm creates .sapwood/EMERGENCY_STOP — state.ts's own isEstopActive() sees it", () => {
  withDataDir((_dir, dbPath) => {
    const res = runCli(["node", "sapwood", "estop", "--confirm"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /EMERGENCY_STOP/);
    const s = new State(dbPath);
    assert.equal(s.isEstopActive(), true);
    s.close();
  });
});

test("#731: sapwood estop clear removes .sapwood/EMERGENCY_STOP and does NOT require --confirm", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, ".sapwood", "EMERGENCY_STOP"), "");
    const res = runCli(["node", "sapwood", "estop", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    const s = new State(dbPath);
    assert.equal(s.isEstopActive(), false);
    s.close();
  });
});

test("#731 gate② P2 (sol): sapwood estop clear's message distinguishes kill-switch (dispatch AND merges) from pause (dispatch only, never merges)", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    writeFileSync(join(dir, ".sapwood", "EMERGENCY_STOP"), "");
    const res = runCli(["node", "sapwood", "estop", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /kill switch keeps new dispatch and merges frozen/i);
    assert.match(res.stdout, /pause keeps only new dispatch frozen/i);
    assert.match(res.stdout, /merges are unaffected by pause/i);
  });
});

test("#731: sapwood estop clear on an inactive EMERGENCY_STOP is a documented no-op, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const res = runCli(["node", "sapwood", "estop", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /not present|nothing to clear/i);
  });
});

// ── fail-closed on unknown verbs/args (no "did nothing silently") ─────────────────────────

test("#731: sapwood pause with an unknown flag fails closed, exit 1, never silently activates", () => {
  withDataDir((dir) => {
    const res = runCli(["node", "sapwood", "pause", "--bogus"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown/i);
    assert.equal(existsSync(join(dir, ".sapwood", "PAUSE")), false, "the invalid invocation must not have side-effected the sentinel");
  });
});

test("#731: sapwood stop with an unknown flag fails closed, exit 1", () => {
  withDataDir(() => {
    const res = runCli(["node", "sapwood", "stop", "--bogus"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown/i);
  });
});

test("#731: sapwood estop --confirm with an unknown extra positional fails closed, exit 1", () => {
  withDataDir((dir) => {
    const res = runCli(["node", "sapwood", "estop", "extra-arg", "--confirm"]);
    assert.equal(res.code, 1);
    assert.equal(existsSync(join(dir, ".sapwood", "EMERGENCY_STOP")), false);
  });
});

test("#731: --confirm is rejected as an unknown flag on pause/stop (estop-only, never silently accepted elsewhere)", () => {
  withDataDir(() => {
    const pauseRes = runCli(["node", "sapwood", "pause", "--confirm"]);
    assert.equal(pauseRes.code, 1);
    const stopRes = runCli(["node", "sapwood", "stop", "--confirm"]);
    assert.equal(stopRes.code, 1);
  });
});

// #1078 AC4: pause/stop/estop are mutating commands — the pre-#1078 db-path positional escape
// hatch is gone; ANY positional argument is now a hard, fail-closed error, never silently
// reinterpreted as a DB to operate on. `status`/`events` deliberately keep accepting one — see
// cli.test.ts.
test("#1078 AC4: sapwood pause/stop/estop REJECT a positional argument — no more db-path override on a mutating command", () => {
  withDataDir((dir) => {
    for (const argv of [
      ["node", "sapwood", "pause", "/some/other/db.sqlite"],
      ["node", "sapwood", "stop", "/some/other/db.sqlite"],
      ["node", "sapwood", "estop", "/some/other/db.sqlite", "--confirm"],
    ]) {
      const res = runCli(argv);
      assert.equal(res.code, 1, `${argv.join(" ")} must fail closed`);
      assert.match(res.stderr, /unexpected argument/, `${argv.join(" ")} must name the rejected positional`);
    }
    assert.equal(existsSync(join(dir, ".sapwood", "PAUSE")), false);
    assert.equal(existsSync(join(dir, ".sapwood", "KILL_SWITCH")), false);
    assert.equal(existsSync(join(dir, ".sapwood", "EMERGENCY_STOP")), false);
  });
});

// ── --config fail-closed on a bad path (#710 semantics, same posture as status/events) ─────

test("#731: sapwood pause --config with a missing/unreadable path is a HARD error, exit 1, never a silent fallback", () => {
  withDataDir((dir) => {
    const res = runCli(["node", "sapwood", "pause", "--config", join(dir, "does-not-exist.yaml")]);
    assert.equal(res.code, 1);
    assert.equal(existsSync(join(dir, ".sapwood", "PAUSE")), false, "a bad --config must abort before any sentinel write");
  });
});

test("#731: sapwood stop --config requires a path — a missing operand fails closed", () => {
  withDataDir(() => {
    const res = runCli(["node", "sapwood", "stop", "--config"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--config requires a path/);
  });
});

// ── --help never side-effects ───────────────────────────────────────────────────────────────

test("#731: --help on all three tiers prints usage and exits 0 without touching any sentinel", () => {
  withDataDir((dir) => {
    for (const cmd of ["pause", "stop", "estop"]) {
      const res = runCli(["node", "sapwood", cmd, "--help"]);
      assert.equal(res.code, 0, `${cmd} --help`);
      assert.match(res.stdout, new RegExp(cmd, "i"));
    }
    assert.equal(existsSync(join(dir, ".sapwood", "PAUSE")), false);
    assert.equal(existsSync(join(dir, ".sapwood", "KILL_SWITCH")), false);
    assert.equal(existsSync(join(dir, ".sapwood", "EMERGENCY_STOP")), false);
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
