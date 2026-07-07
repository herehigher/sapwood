import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, parseRunStopMode } from "./cli.js";

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
