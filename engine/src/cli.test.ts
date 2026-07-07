import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, parseRunStopMode, runExitCode } from "./cli.js";

test("--version prints package version and exits 0", () => {
  const r = runCli(["node", "sapwood", "--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("-v is alias for --version", () => {
  const r = runCli(["node", "sapwood", "-v"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("--help prints usage and exits 0", () => {
  const r = runCli(["node", "sapwood", "--help"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.length > 0);
  assert.match(r.stdout, /usage/i);
});

test("-h is alias for --help", () => {
  const r = runCli(["node", "sapwood", "-h"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage/i);
});

test("no args prints usage and exits 0", () => {
  const r = runCli(["node", "sapwood"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage/i);
});

test("unknown command exits non-zero", () => {
  const r = runCli(["node", "sapwood", "bogus"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage/i);
});

test("run: falls through to the async engine-wiring path (code -1), same as init", () => {
  const r = runCli(["node", "sapwood", "run"]);
  assert.equal(r.code, -1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("run: --once and --until-idle appear in --help usage", () => {
  const r = runCli(["node", "sapwood", "--help"]);
  assert.match(r.stdout, /--once/);
  assert.match(r.stdout, /--until-idle/);
});

test("parseRunStopMode: --once and --until-idle select their modes; neither -> forever", () => {
  assert.equal(parseRunStopMode(["node", "sapwood", "run", "--once"]), "once");
  assert.equal(parseRunStopMode(["node", "sapwood", "run", "--until-idle"]), "until-idle");
  assert.equal(parseRunStopMode(["node", "sapwood", "run"]), "forever");
});

test("parseRunStopMode: --once wins when both flags are given (defensive precedence, not expected usage)", () => {
  assert.equal(parseRunStopMode(["node", "sapwood", "run", "--once", "--until-idle"]), "once");
});

// ── Codex PR #50 review threads: run-flag validation + --once exit code ──────────────────────

test("run --help / -h prints run usage and exits 0 — NEVER starts the daemon (Codex PR #50 cli.ts:46)", () => {
  for (const flag of ["--help", "-h"]) {
    const r = runCli(["node", "sapwood", "run", flag]);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /usage: sapwood run/);
    assert.match(r.stdout, /--once/);
    assert.match(r.stdout, /--until-idle/);
    assert.equal(r.stderr, "");
  }
});

test("run with an unknown flag errors + usage, exit 1 — never a silently-started daemon (Codex PR #50 cli.ts:46)", () => {
  const r = runCli(["node", "sapwood", "run", "--bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag\(s\): --bogus/);
  assert.match(r.stderr, /usage: sapwood run/);
  assert.equal(r.stdout, "");
  // A valid flag mixed with an unknown one is still rejected (the unknown must never be
  // silently dropped on the way into a daemon that claims issues).
  const mixed = runCli(["node", "sapwood", "run", "--once", "--typo"]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /--typo/);
});

test("run with valid flags still falls through to the engine path (code -1)", () => {
  assert.equal(runCli(["node", "sapwood", "run", "--once"]).code, -1);
  assert.equal(runCli(["node", "sapwood", "run", "--until-idle"]).code, -1);
});

test("runExitCode: --once with a failed-only attempt exits 1; success exits 0 (Codex PR #50 cli.ts:82)", () => {
  assert.equal(runExitCode({ ticks: 1, tickErrors: 0 }, "once"), 0); // one-shot succeeded
  assert.equal(runExitCode({ ticks: 0, tickErrors: 1 }, "once"), 1); // failed one-shot must fail the cron job
});

test("runExitCode: daemon/until-idle runs exit 0 even with contained tick errors (retry design, not terminal failure)", () => {
  assert.equal(runExitCode({ ticks: 0, tickErrors: 5 }, "forever"), 0);
  assert.equal(runExitCode({ ticks: 3, tickErrors: 2 }, "until-idle"), 0);
});
