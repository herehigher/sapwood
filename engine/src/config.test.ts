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
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 0 }"),
    /tickIntervalSec/i,
  );
});

test("engine.driver (#106): defaults to \"rounds\", overridable to \"tick\", rejects anything else", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.driver, "rounds");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: tick }");
  assert.equal(over.engine.driver, "tick");
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: bogus }"),
    /driver/i,
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
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted, human] }",
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
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }",
  );
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});

// ── #74: worker.promptFile ──
test("worker.promptFile: unset by default, overridable, strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.promptFile, undefined);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { promptFile: prompts/custom-worker.md }",
  );
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
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: pricing/my-rates.yaml }",
  );
  assert.equal(over.worker.pricingFile, "pricing/my-rates.yaml");
});

test("worker.pricingFile: a RELATIVE path resolves against the CONFIG FILE's directory, exactly like promptFile (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: rates/my-rates.yaml }",
    );
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
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { planApproved: custom:approved }",
  );
  assert.equal(over.labels.planApproved, "custom:approved");
});

test("labels.originAgent: defaults to origin:agent, overridable (#89 — the PO provenance stamp, config-driven like every sibling label)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.labels.originAgent, "origin:agent");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { originAgent: bot:made }",
  );
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
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFiel: x.md } }",
      ),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.maxDraftCycles: defaults to 2, overridable (#77 Amendment 2 — gate⓪ self-heal bound)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.maxDraftCycles, 2);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: 5 } }",
  );
  assert.equal(over.roles.planReviewer.maxDraftCycles, 5);
});

test("roles.planReviewer.maxDraftCycles: zero, negative, and non-integer are rejected (positive int only — 0 would make every bounce an instant needs-human)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () =>
        parseConfig(
          `board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: ${bad} } }`,
        ),
      /maxDraftCycles/,
    );
  }
});

test("roles.planReviewer.maxDraftCycles: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycle: 3 } }",
      ),
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
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { model: opus, effort: high } }",
  );
  assert.equal(over.roles.planReviewer.model, "opus");
  assert.equal(over.roles.planReviewer.effort, "high");
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
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFiel: x.md } }",
      ),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planDrafter.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: my-plan-drafter.md } }\n",
    );
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
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFiel: x.md } }",
      ),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.architect.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFile: my-architect.md } }\n",
    );
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
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: my-po.md } }\n",
    );
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
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFiel: x.md } }",
      ),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.harvest.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFile: my-harvest.md } }\n",
    );
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
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFiel: x.md } }",
      ),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.retro.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFile: my-retro.md } }\n",
    );
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
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "stop: { afterIssuesMerged: 3, afterPRsOpened: 5, onMilestoneComplete: M4 }",
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
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterPRsOpened: ${bad} }`),
      /afterPRsOpened/,
    );
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
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestone: '' }"),
    /milestone/,
  );
});

test("round: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestne: M4 }"),
    /milestne|[Uu]nrecognized/,
  );
});

// ── #104: roles.architect.planMdPath (architecture-doc path, no longer hardcoded to cwd) ───

test("roles.architect.planMdPath: defaults to docs/PLAN.md", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.architect.planMdPath, "docs/PLAN.md");
});

test("roles.architect.planMdPath: overridable, same #74-style key as promptFile", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: notes/ARCH.md } }",
  );
  assert.equal(cfg.roles.architect.planMdPath, "notes/ARCH.md");
});

test("roles.architect.planMdPath: a relative path resolves against the config file's directory, not cwd (same rule as promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: my-plan.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.architect.planMdPath, join(dir, "my-plan.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roles.architect.planMdPath: the DEFAULT value is also resolved relative to the config file's directory (not left cwd-relative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.architect.planMdPath, join(dir, "docs", "PLAN.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roles.architect: an absolute planMdPath is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const absPath = join(dir, "elsewhere", "PLAN.md");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: ${absPath} } }\n`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.architect.planMdPath, absPath);
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
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 3 } }",
  );
  assert.equal(cfg.roles.retro.everyNRounds, 3);
});

test("roles.retro.everyNRounds: zero/negative is rejected (positive int only)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 0 } }"),
    /everyNRounds/,
  );
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
