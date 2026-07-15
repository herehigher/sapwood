import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_GOAL_FILE, loadConfig, parseConfig } from "./config.js";

test("applies defaults when only required board fields given", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.repo, "widgets");
  assert.equal(cfg.board.status.ready, "Ready"); // default
  assert.equal(cfg.lanes.roundDispatchCap, 6); // #124: per-round quota, 2x lanes.max default
  assert.equal(cfg.worker.budgetUsdSoft, 10);
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.labels.verifyNa, "verify:n/a");
  assert.equal(cfg.labels.planApproved, "plan:approved"); // #88 gate⓪
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
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 0 }"), /tickIntervalSec/i);
});

test('engine.driver (#106): defaults to "rounds", overridable to "tick", rejects anything else', () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.driver, "rounds");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: tick }");
  assert.equal(over.engine.driver, "tick");
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: bogus }"), /driver/i);
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
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: yolo }"), /reviewer/);
});

test("rejects an unknown key (typo in a safety-critical field is not silently dropped)", () => {
  // roundBudgetUSd typo must error, not fall back to the default hard ceiling.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { roundBudgetUSd: 5 }"),
    /roundBudgetUSd|[Uu]nrecognized/,
  );
});

test("rejects an unknown top-level key", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanez: { max: 2 }"), /lanez|[Uu]nrecognized/);
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

// ── #156: reviewer.triggerCommand — user-defined review trigger entry point ─────────────────

test("#156: reviewer.triggerCommand defaults to `@codex review` (byte-for-byte today's hardcoded trigger)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.triggerCommand, "@codex review");
});

test("#156: reviewer.triggerCommand accepts a custom value", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { triggerCommand: '/review-please' }");
  assert.equal(cfg.reviewer.triggerCommand, "/review-please");
});

test("#156: reviewer.triggerCommand rejects an empty string", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { triggerCommand: '' }"), /reviewer/);
});

test("#13: produce-pr-and-stop is a merge.mode value, not a reviewer.mode value", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: produce-pr-and-stop }"), /reviewer/);
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: produce-pr-and-stop }");
  assert.equal(cfg.merge.mode, "produce-pr-and-stop");
});

test("#13: reviewer.mode accepts same-model-trusted and human", () => {
  assert.equal(
    parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: same-model-trusted }").reviewer.mode,
    "same-model-trusted",
  );
  assert.equal(parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human }").reviewer.mode, "human");
});

test("#13: rejects an unknown merge mode", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: yolo }"), /merge/);
});

test("#54: reviewer.fallback defaults empty, failoverAfterSec defaults sane (no silent degradation)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.deepEqual(cfg.reviewer.fallback, []);
  assert.equal(cfg.reviewer.failoverAfterSec, 1200);
});

test("#54: reviewer.fallback accepts an ordered list of the same three reviewer kinds", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted, human] }",
  );
  assert.deepEqual(cfg.reviewer.fallback, ["same-model-trusted", "human"]);
});

test("#54: reviewer.fallback rejects an unknown kind", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [yolo] }"), /reviewer/);
});

test("#54: reviewer.failoverAfterSec accepts a custom positive integer", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { failoverAfterSec: 300 }");
  assert.equal(cfg.reviewer.failoverAfterSec, 300);
});

test("#54 R2 (fable-review P3): fallback containing same-model-trusted with EMPTY trustedReviewers is rejected at parse — a failover that can never fire must not ship silently", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [same-model-trusted] }"),
    /silently inert|trustedReviewers/,
  );
  // Explicit empty list is just as inert as the default.
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [], fallback: [human, same-model-trusted] }",
      ),
    /silently inert|trustedReviewers/,
  );
});

test("#54 R2: the same fallback parses fine once trustedReviewers is non-empty, and human-only fallback needs no allowlist", () => {
  const ok = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted] }",
  );
  assert.deepEqual(ok.reviewer.fallback, ["same-model-trusted"]);
  const humanOnly = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [human] }");
  assert.deepEqual(humanOnly.reviewer.fallback, ["human"]);
});

test("overrides survive validation", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }");
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});

// ── #147: lanes.gatedReentryCap (bounds the GATED RECLAIM phase's reentry attempts) ──
test("lanes.gatedReentryCap: defaults to 2 (prFixCap's shape), overridable, nonnegative-int-guarded", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.lanes.gatedReentryCap, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: 0 }");
  assert.equal(over.lanes.gatedReentryCap, 0); // 0 is legal — disables automatic reentry outright
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: -1 }"), /gatedReentryCap/);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: 1.5 }"), /gatedReentryCap/);
});

// ── #74: worker.promptFile ──
test("worker.promptFile: unset by default, overridable, strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.promptFile, undefined);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { promptFile: prompts/custom-worker.md }");
  assert.equal(over.worker.promptFile, "prompts/custom-worker.md");
});

test("worker.promptFile: a typo'd key under worker.* is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { promptFiel: x.md }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

// ── #33 follow-up (PR #85 human review): worker.pricingFile ──
test("worker.pricingFile: unset by default, overridable, follows the #74 promptFile shape", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.pricingFile, undefined);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: pricing/my-rates.yaml }");
  assert.equal(over.worker.pricingFile, "pricing/my-rates.yaml");
});

test("worker.pricingFile: a RELATIVE path resolves against the CONFIG FILE's directory, exactly like promptFile (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: rates/my-rates.yaml }");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.worker.pricingFile, join(dir, "rates", "my-rates.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #88 gate⓪: labels.planApproved + roles.planReviewer.promptFile ──────────────────────────
// Session wiring (actually loading/rendering this prompt) lands with the peripheral-role-
// runner issue; here the config surface is validated + path-resolved, same "accepted, not
// yet wired" shape as lanes.reserveCap/prFixCap/frictionMin.

test("labels.planApproved: defaults to plan:approved, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.labels.planApproved, "plan:approved");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { planApproved: custom:approved }");
  assert.equal(over.labels.planApproved, "custom:approved");
});

test("labels.originAgent: defaults to origin:agent, overridable (#89 — the PO provenance stamp, config-driven like every sibling label)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.labels.originAgent, "origin:agent");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { originAgent: bot:made }");
  assert.equal(over.labels.originAgent, "bot:made");
});

test("roles.planReviewer.promptFile: unset by default, overridable, strict schema (same #74 pattern as worker.promptFile)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.promptFile, undefined);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFile: prompts/custom-plan-reviewer.md } }",
  );
  assert.equal(over.roles.planReviewer.promptFile, "prompts/custom-plan-reviewer.md");
});

test("roles.planReviewer.promptFile: a typo'd key under roles.planReviewer.* is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.maxDraftCycles: defaults to 2, overridable (#77 Amendment 2 — gate⓪ self-heal bound)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.maxDraftCycles, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: 5 } }");
  assert.equal(over.roles.planReviewer.maxDraftCycles, 5);
});

test("roles.planReviewer.maxDraftCycles: zero, negative, and non-integer are rejected (positive int only — 0 would make every bounce an instant needs-human)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: ${bad} } }`),
      /maxDraftCycles/,
    );
  }
});

test("roles.planReviewer.maxDraftCycles: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycle: 3 } }"),
    /maxDraftCycle|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.promptFile: a relative path resolves against the config file's directory, not cwd (same #74 pattern as worker.promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFile: my-plan-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.planReviewer.promptFile, join(dir, "my-plan-reviewer.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #87: role runner — model/effort defaults + the plan-drafter role ────────────────────────

test("roles.planReviewer.model/effort: default to a lighter model/effort than worker.model/effort, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.model, "sonnet");
  assert.equal(cfg.roles.planReviewer.effort, "medium");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { model: opus, effort: high } }");
  assert.equal(over.roles.planReviewer.model, "opus");
  assert.equal(over.roles.planReviewer.effort, "high");
});

test("worker/roles fallbackModel: default to sonnet, allow an override, and accept explicit none", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.fallbackModel, "sonnet");
  assert.equal(cfg.roles.planReviewer.fallbackModel, "sonnet");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { fallbackModel: haiku }\nroles: { planReviewer: { fallbackModel: none } }",
  );
  assert.equal(over.worker.fallbackModel, "haiku");
  assert.equal(over.roles.planReviewer.fallbackModel, "none");
});

test("roles.planDrafter: promptFile unset by default, model/effort defaulted, strict schema (#74/#77 Amendment 2 pattern)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planDrafter.promptFile, undefined);
  assert.equal(cfg.roles.planDrafter.model, "sonnet");
  assert.equal(cfg.roles.planDrafter.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: prompts/custom-drafter.md, model: opus } }",
  );
  assert.equal(over.roles.planDrafter.promptFile, "prompts/custom-drafter.md");
  assert.equal(over.roles.planDrafter.model, "opus");
});

test("roles.planDrafter: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planDrafter.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: my-plan-drafter.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.planDrafter.promptFile, join(dir, "my-plan-drafter.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #90: roles.architect (round design/review peripheral) ──────────────────────────────────

test("roles.architect: promptFile unset by default, model/effort defaulted, strict schema (same #74 pattern)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.architect.promptFile, undefined);
  assert.equal(cfg.roles.architect.model, "sonnet");
  assert.equal(cfg.roles.architect.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFile: prompts/custom-architect.md, model: opus } }",
  );
  assert.equal(over.roles.architect.promptFile, "prompts/custom-architect.md");
  assert.equal(over.roles.architect.model, "opus");
});

test("roles.architect: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.architect.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFile: my-architect.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.architect.promptFile, join(dir, "my-architect.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #89: roles.po (the PO/product-owner peripheral) ─────────────────────────────────────────

test("roles.po: promptFile unset by default, model/effort defaulted, strict schema (same #74 pattern as roles.planReviewer/planDrafter)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.promptFile, undefined);
  assert.equal(cfg.roles.po.model, "sonnet");
  assert.equal(cfg.roles.po.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: prompts/custom-po.md, model: opus, effort: high } }",
  );
  assert.equal(over.roles.po.promptFile, "prompts/custom-po.md");
  assert.equal(over.roles.po.model, "opus");
  assert.equal(over.roles.po.effort, "high");
});

test("roles.po: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.po.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: my-po.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.po.promptFile, join(dir, "my-po.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #91: roles.harvest / roles.retro (round-close peripheral roles) ────────────────────────

test("roles.harvest: promptFile unset by default, model/effort defaulted (same #74/#88 pattern), strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.harvest.promptFile, undefined);
  assert.equal(cfg.roles.harvest.model, "sonnet");
  assert.equal(cfg.roles.harvest.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFile: prompts/custom-harvest.md, model: opus, effort: high } }",
  );
  assert.equal(over.roles.harvest.promptFile, "prompts/custom-harvest.md");
  assert.equal(over.roles.harvest.model, "opus");
  assert.equal(over.roles.harvest.effort, "high");
});

test("roles.harvest: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.harvest.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFile: my-harvest.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.harvest.promptFile, join(dir, "my-harvest.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roles.retro: promptFile unset by default, model/effort defaulted, strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.retro.promptFile, undefined);
  assert.equal(cfg.roles.retro.model, "sonnet");
  assert.equal(cfg.roles.retro.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFile: prompts/custom-retro.md, model: opus } }",
  );
  assert.equal(over.roles.retro.promptFile, "prompts/custom-retro.md");
  assert.equal(over.roles.retro.model, "opus");
});

test("roles.retro: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.retro.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFile: my-retro.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.retro.promptFile, join(dir, "my-retro.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #76: goal-based stop conditions ─────────────────────────────────────────────────────────

test("stop: absent by default — every field undefined, no behavior change (#76 regression contract)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.stop.afterIssuesMerged, undefined);
  assert.equal(cfg.stop.afterPRsOpened, undefined);
  assert.equal(cfg.stop.onMilestoneComplete, undefined);
});

test("stop: all three fields overridable", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" + "stop: { afterIssuesMerged: 3, afterPRsOpened: 5, onMilestoneComplete: M4 }",
  );
  assert.equal(cfg.stop.afterIssuesMerged, 3);
  assert.equal(cfg.stop.afterPRsOpened, 5);
  assert.equal(cfg.stop.onMilestoneComplete, "M4");
});

test("stop.afterIssuesMerged / afterPRsOpened: zero and negative are rejected (positive int only)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterIssuesMerged: ${bad} }`),
      /afterIssuesMerged/,
    );
    assert.throws(() => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterPRsOpened: ${bad} }`), /afterPRsOpened/);
  }
});

test("stop.onMilestoneComplete: an empty string is rejected (a name is required once the key is set)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nstop: { onMilestoneComplete: '' }"),
    /onMilestoneComplete/,
  );
});

test("stop: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterIssuesMerge: 3 }"),
    /afterIssuesMerge|[Uu]nrecognized/,
  );
});

// ── #86: round.milestone — round-level dispatch-candidate filter + stop condition ───────────

test("round.milestone: absent by default — no scoping, no behavior change", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.milestone, undefined);
});

test("round.milestone: overridable to a milestone title", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestone: M4 }");
  assert.equal(cfg.round.milestone, "M4");
});

test("round.milestone: an empty string is rejected (a name is required once the key is set)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestone: '' }"), /milestone/);
});

test("round: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestne: M4 }"), /milestne|[Uu]nrecognized/);
});

// ── #126: round.directiveFile / round.directiveMaxChars — round directive file ──────────────

test("round.directiveFile: defaults to data/DIRECTIVE.md", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.directiveFile, "data/DIRECTIVE.md");
});

test("round.directiveFile: overridable, and NOT resolved relative to the config file (unlike roles.*.promptFile/planMdPath) — same cwd-relative convention as the engine's own data/sapwood.sqlite default", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveFile: custom/STEER.md }");
  assert.equal(cfg.round.directiveFile, "custom/STEER.md");
});

test("round.directiveFile: an empty string is rejected (always has a value, same shape as roles.architect.planMdPath)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveFile: '' }"), /directiveFile/);
});

test("round.directiveMaxChars: defaults to 20000, a positive int", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.directiveMaxChars, 20_000);
});

test("round.directiveMaxChars: zero/negative rejected (same positive-int contract as roles.harvest.artifactMaxChars)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveMaxChars: 0 }"), /directiveMaxChars/);
});

// ── #128: goal.file (top-level north-star goal file, promoted out of the #104-era
// roles.architect.planMdPath) — precedence, deprecation, config-file-relative resolution ───────

test("goal.file: defaults to docs/PLAN.md when neither key is set", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.goal.file, DEFAULT_GOAL_FILE);
  assert.equal(cfg.goal.file, "docs/PLAN.md");
});

test("goal.file: only the new key set — it wins, no error, no deprecation noise", () => {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: notes/GOAL.md }");
    assert.equal(cfg.goal.file, "notes/GOAL.md");
    assert.equal(calls.length, 0, "no deprecation line when only the new key is set");
  } finally {
    console.error = orig;
  }
});

test("goal.file: only the OLD key (roles.architect.planMdPath) set — it wins, and exactly ONE deprecation line is logged", () => {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: notes/ARCH.md } }");
    assert.equal(cfg.goal.file, "notes/ARCH.md");
    assert.equal(calls.length, 1, "exactly one deprecation line");
    assert.match(String(calls[0]![0]), /goal\.file/);
    assert.match(String(calls[0]![0]), /roles\.architect\.planMdPath|deprecat/i);
  } finally {
    console.error = orig;
  }
});

test("goal.file: both keys set and they AGREE — resolves cleanly, no error", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "goal: { file: notes/SAME.md }\nroles: { architect: { planMdPath: notes/SAME.md } }",
  );
  assert.equal(cfg.goal.file, "notes/SAME.md");
});

test("goal.file: both keys set and they DISAGREE — hard config error naming both keys", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\n" +
          "goal: { file: notes/NEW.md }\nroles: { architect: { planMdPath: notes/OLD.md } }",
      ),
    (e: Error) => /goal\.file/.test(e.message) && /roles\.architect\.planMdPath/.test(e.message),
  );
});

test("goal.file: a relative path resolves against the config file's directory, not cwd (same #74 pattern as promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: my-plan.md }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "my-plan.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: the DEFAULT value is also resolved relative to the config file's directory (not left cwd-relative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "docs", "PLAN.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: resolved from the deprecated old key is ALSO config-file-relative resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const orig = console.error;
  console.error = () => {}; // silence the expected deprecation line for this test
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: notes/ARCH.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "notes", "ARCH.md"));
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: an absolute path is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const absPath = join(dir, "elsewhere", "GOAL.md");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: ${absPath} }\n`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, absPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #167: doctrine.file (repo-level review doctrine) — same top-level, always-resolved shape
// as goal.file, but with a real .default() (no deprecated back-compat key to reconcile) ────────

test("doctrine.file: defaults to docs/REVIEW-DOCTRINE.md and doctrine.maxChars defaults to 20000", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.doctrine.file, "docs/REVIEW-DOCTRINE.md");
  assert.equal(cfg.doctrine.maxChars, 20_000);
});

test("doctrine.file/maxChars: both overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: notes/DOCTRINE.md, maxChars: 500 }");
  assert.equal(cfg.doctrine.file, "notes/DOCTRINE.md");
  assert.equal(cfg.doctrine.maxChars, 500);
});

test("doctrine.maxChars: rejects non-positive-int", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 0 }"));
});

// #167 review (Codex P3): a cap below the floor could crowd out capDigest's own truncation
// marker (retro-digest.ts), silently defeating the "marked cut, never a silent drop" contract
// doctrine.maxChars's doc comment promises. 200 is the floor.
test("doctrine.maxChars: rejects a value below the 200-char floor (would crowd out capDigest's truncation marker)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 199 }"));
});

test("doctrine.maxChars: accepts exactly the 200-char floor", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 200 }");
  assert.equal(cfg.doctrine.maxChars, 200);
});

test("doctrine.file: a relative path resolves against the config file's directory, not cwd (same #74 pattern as goal.file/promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: my-doctrine.md }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, join(dir, "my-doctrine.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctrine.file: the DEFAULT value is also resolved relative to the config file's directory (not left cwd-relative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, join(dir, "docs", "REVIEW-DOCTRINE.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctrine.file: an absolute path is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const absPath = join(dir, "elsewhere", "DOCTRINE.md");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: ${absPath} }\n`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, absPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #104: roles.retro.everyNRounds (retro cadence) ──────────────────────────────────────────

test("roles.retro.everyNRounds: defaults to 1 (every round)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.retro.everyNRounds, 1);
});

test("roles.retro.everyNRounds: overridable to thin the cadence", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 3 } }");
  assert.equal(cfg.roles.retro.everyNRounds, 3);
});

test("roles.retro.everyNRounds: zero/negative is rejected (positive int only)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 0 } }"), /everyNRounds/);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: -1 } }"),
    /everyNRounds/,
  );
});

test("roles.retro.everyNRounds: a non-integer is rejected", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 1.5 } }"),
    /everyNRounds/,
  );
});

// ── #127: roles.<role>.enabled toggles — switch peripheral roles off per deployment ────────

test("roles.*.enabled: defaults to true for every toggleable role (po/architect/planReviewer/harvest/retro)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.enabled, true);
  assert.equal(cfg.roles.architect.enabled, true);
  assert.equal(cfg.roles.planReviewer.enabled, true);
  assert.equal(cfg.roles.harvest.enabled, true);
  assert.equal(cfg.roles.retro.enabled, true);
});

test("roles.*.enabled: explicit false is honored for each toggleable role", () => {
  for (const role of ["po", "architect", "planReviewer", "harvest", "retro"] as const) {
    const cfg = parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { ${role}: { enabled: false } }`);
    assert.equal(cfg.roles[role].enabled, false, `roles.${role}.enabled should be false`);
  }
});

test("roles.*.enabled: an unknown role key under roles is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { notARole: { enabled: false } }"),
    /notARole|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.enabled: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { enable: false } }"),
    /enable\b|[Uu]nrecognized/,
  );
});

test("roles.*.enabled: a non-boolean value is rejected", () => {
  assert.throws(() => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { enabled: "nope" } }'), /enabled/);
});

// ── #168 (PR #180 review P3-1): envFailure config validation — fail-fast at load ────────────

test("envFailure: defaults apply (patterns non-empty, escalate 1h, backoff 30s..30min, ping on haiku, 30s timeout, $0.05 ping budget)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.ok(cfg.envFailure.llmPatterns.length > 0);
  assert.ok(cfg.envFailure.forgePatterns.length > 0);
  assert.equal(cfg.envFailure.parkEscalateAfterSec, 3600);
  assert.equal(cfg.envFailure.probeBackoffBaseSec, 30);
  assert.equal(cfg.envFailure.probeBackoffMaxSec, 1800);
  assert.equal(cfg.envFailure.probeModel, "haiku");
  assert.equal(cfg.envFailure.probeTimeoutSec, 30);
  assert.equal(cfg.envFailure.probeMaxBudgetUsd, 0.05);
});

test("envFailure: probeModel/probeTimeoutSec/probeMaxBudgetUsd are overridable; empty model, non-positive timeout, and non-positive/non-finite budget are rejected at load", () => {
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeModel: my-cheap-alias, probeTimeoutSec: 10, probeMaxBudgetUsd: 0.1 }",
  );
  assert.equal(over.envFailure.probeModel, "my-cheap-alias");
  assert.equal(over.envFailure.probeTimeoutSec, 10);
  assert.equal(over.envFailure.probeMaxBudgetUsd, 0.1);
  assert.throws(() => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeModel: "" }'));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeTimeoutSec: 0 }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeMaxBudgetUsd: 0 }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeMaxBudgetUsd: 1e999 }"));
});

test("envFailure: a custom valid override parses; a MALFORMED regex pattern is a fail-fast load error naming the entry (never a silent literal-substring degradation)", () => {
  const ok = parseConfig(
    'board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: ["my_custom_error", "quota (exceeded|reached)"] }',
  );
  assert.deepEqual(ok.envFailure.llmPatterns, ["my_custom_error", "quota (exceeded|reached)"]);
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: ["([unterminated"] }'),
    /not a valid regular expression/,
  );
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { forgePatterns: ["ok", "*bad*"] }'),
    /not a valid regular expression/,
  );
});

test("envFailure: an EMPTY pattern array is rejected at load — silently disabling a source's detection must be impossible by accident", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: [] }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { forgePatterns: [] }"));
});

test("envFailure: probeBackoffMaxSec below probeBackoffBaseSec is rejected at load; equal is legal (a flat backoff)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeBackoffBaseSec: 60, probeBackoffMaxSec: 30 }"),
    /probeBackoffMaxSec/,
  );
  const flat = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeBackoffBaseSec: 60, probeBackoffMaxSec: 60 }",
  );
  assert.equal(flat.envFailure.probeBackoffMaxSec, 60);
});
