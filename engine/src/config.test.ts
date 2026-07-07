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
  // #14 engine cost ceiling + kill switch: conservative defaults.
  assert.equal(cfg.cost.dailyBudgetUsd, 100);
  assert.equal(cfg.cost.maxWallClockSec, 14400);
  assert.equal(cfg.cost.drainWindowSec, 300);
});

test("engine.tickIntervalSec (#46 loop driver): defaults to 60s, positive-int-guarded, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.tickIntervalSec, 60);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 30 }");
  assert.equal(over.engine.tickIntervalSec, 30);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 0 }"),
    /tickIntervalSec/i,
  );
});

test("cost: #14 ceiling fields are finite-guarded and overridable", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\ncost: { dailyBudgetUsd: 5, maxWallClockSec: 60, drainWindowSec: 10 }",
  );
  assert.equal(cfg.cost.dailyBudgetUsd, 5);
  assert.equal(cfg.cost.maxWallClockSec, 60);
  assert.equal(cfg.cost.drainWindowSec, 10);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { dailyBudgetUsd: 1e999 }"),
    /dailyBudgetUsd|finite/i,
  );
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

test("#13: reviewer/merge defaults — codex reviewer, conductor-merge, sane poll bounds", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.reviewer.pollIntervalSec, 120);
  assert.equal(cfg.reviewer.pollTimeoutSec, 1200);
  assert.equal(cfg.merge.mode, "conductor-merge");
});

test("#13: produce-pr-and-stop is a merge.mode value, not a reviewer.mode value", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: produce-pr-and-stop }"),
    /reviewer/,
  );
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: produce-pr-and-stop }");
  assert.equal(cfg.merge.mode, "produce-pr-and-stop");
});

test("#13: reviewer.mode accepts same-model-trusted and human", () => {
  assert.equal(
    parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: same-model-trusted }").reviewer.mode,
    "same-model-trusted",
  );
  assert.equal(
    parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human }").reviewer.mode,
    "human",
  );
});

test("#13: rejects an unknown merge mode", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: yolo }"),
    /merge/,
  );
});

test("#54: reviewer.fallback defaults empty, failoverAfterSec defaults sane (no silent degradation)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.deepEqual(cfg.reviewer.fallback, []);
  assert.equal(cfg.reviewer.failoverAfterSec, 1200);
});

test("#54: reviewer.fallback accepts an ordered list of the same three reviewer kinds", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [same-model-trusted, human] }",
  );
  assert.deepEqual(cfg.reviewer.fallback, ["same-model-trusted", "human"]);
});

test("#54: reviewer.fallback rejects an unknown kind", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [yolo] }"),
    /reviewer/,
  );
});

test("#54: reviewer.failoverAfterSec accepts a custom positive integer", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { failoverAfterSec: 300 }");
  assert.equal(cfg.reviewer.failoverAfterSec, 300);
});

test("overrides survive validation", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }",
  );
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});
