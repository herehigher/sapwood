import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig } from "./config.js";

test("applies defaults when only required board fields given", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.repo, "widgets");
  assert.equal(cfg.board.status.ready, "Ready"); // default
  assert.equal(cfg.lanes.roundDispatchCap, 2); // conservative default
  assert.equal(cfg.worker.budgetUsdSoft, 10);
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.labels.verifyNa, "verify:n/a");
});

test("parses JSON too (YAML superset)", () => {
  const cfg = parseConfig('{"board":{"owner":"acme","repo":"widgets","projectNumber":7}}');
  assert.equal(cfg.board.owner, "acme");
});

test("rejects missing required repo", () => {
  assert.throws(() => parseConfig("board:\n  owner: acme\n  projectNumber: 7\n"), /repo/);
});

test("rejects missing required board identity with a field path", () => {
  assert.throws(() => parseConfig("lanes:\n  max: 5\n"), /board/);
});

test("loadConfig probes sapwood.config.json when no YAML file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, "sapwood.config.json"), '{"board":{"owner":"a","repo":"r","projectNumber":1}}');
    process.chdir(dir);
    assert.equal(loadConfig().board.owner, "a"); // default probe finds the .json
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws a clear error when no config file is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => loadConfig(), /no config found/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an unknown reviewer mode", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: yolo }"),
    /reviewer/,
  );
});

test("rejects an unknown key (typo in a safety-critical field is not silently dropped)", () => {
  // roundBudgetUSd typo must error, not fall back to the default hard ceiling.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { roundBudgetUSd: 5 }"),
    /roundBudgetUSd|[Uu]nrecognized/,
  );
});

test("rejects an unknown top-level key", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanez: { max: 2 }"),
    /lanez|[Uu]nrecognized/,
  );
});

test("rejects a non-finite budget ceiling (overflow must not disable the cap)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { roundBudgetUsd: 1e999 }"),
    /roundBudgetUsd|finite/i,
  );
});

test("overrides survive validation", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }",
  );
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});
