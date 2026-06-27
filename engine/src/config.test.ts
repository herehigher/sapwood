import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.js";

test("applies defaults when only required board fields given", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  projectNumber: 7\n");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.status.ready, "Ready"); // default
  assert.equal(cfg.lanes.roundDispatchCap, 2); // conservative default
  assert.equal(cfg.worker.budgetUsdSoft, 10);
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.labels.verifyNa, "verify:n/a");
});

test("parses JSON too (YAML superset)", () => {
  const cfg = parseConfig('{"board":{"owner":"acme","projectNumber":7}}');
  assert.equal(cfg.board.owner, "acme");
});

test("rejects missing required board identity with a field path", () => {
  assert.throws(() => parseConfig("lanes:\n  max: 5\n"), /board/);
});

test("rejects an unknown reviewer mode", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, projectNumber: 1 }\nreviewer: { mode: yolo }"),
    /reviewer/,
  );
});

test("overrides survive validation", () => {
  const cfg = parseConfig(
    "board: { owner: a, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }",
  );
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});
