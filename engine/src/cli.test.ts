import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  runCli,
  parseRunStopMode,
  parseStopFlags,
  parseMilestoneFlag,
  resolveStopConfig,
  applyMilestoneOverride,
  formatStopConditionLine,
  assertStopMilestoneExists,
  runExitCode,
  computeDryRunPreview,
  formatDryRunPreview,
  parseStatusArgs,
  formatStatus,
  runStatus,
  type StatusSnapshot,
} from "./cli.js";
import { parseConfig, ConfigSchema } from "./config.js";
import { State, SCHEMA_VERSION } from "./state.js";
import type { Issue } from "./forge.js";

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

// ── #76: goal-based stop conditions ─────────────────────────────────────────────────────────

test("run: --stop-* flags appear in --help usage", () => {
  const r = runCli(["node", "sapwood", "run", "--help"]);
  assert.match(r.stdout, /--stop-after-issues/);
  assert.match(r.stdout, /--stop-after-prs/);
  assert.match(r.stdout, /--stop-on-milestone/);
  assert.match(r.stdout, /--stop-after-spend/);
});

test("parseStopFlags: parses all four flags, leaving non-stop tokens in `rest`", () => {
  const { rest, stop, error } = parseStopFlags([
    "run", "--once", "--stop-after-issues", "3", "--stop-after-prs", "5", "--stop-on-milestone", "M4",
    "--stop-after-spend", "25",
  ]);
  assert.equal(error, undefined);
  assert.deepEqual(stop, { afterIssuesMerged: 3, afterPRsOpened: 5, onMilestoneComplete: "M4", afterSpendUsd: 25 });
  assert.deepEqual(rest, ["run", "--once"]);
});

// ── #154: --stop-after-spend ────────────────────────────────────────────────────────────────

test("parseStopFlags: --stop-after-spend accepts a decimal dollar amount (unlike the two integer count flags)", () => {
  assert.deepEqual(parseStopFlags(["--stop-after-spend", "25.5"]).stop, { afterSpendUsd: 25.5 });
  assert.deepEqual(parseStopFlags(["--stop-after-spend", "25"]).stop, { afterSpendUsd: 25 });
});

test("parseStopFlags: zero, negative-looking, and non-numeric values for --stop-after-spend are rejected", () => {
  for (const bad of ["0", "nope"]) {
    assert.match(
      parseStopFlags(["--stop-after-spend", bad]).error ?? "",
      /--stop-after-spend requires a positive number/,
      bad,
    );
  }
  // A literal "-1" is caught by the same "looks like another flag" missing-value guard as the
  // other three flags (same convention as --config elsewhere).
  assert.match(parseStopFlags(["--stop-after-spend", "-1"]).error ?? "", /--stop-after-spend requires a value/);
});

test("resolveStopConfig: --stop-after-spend overrides config's stop.afterSpendUsd for this run only", () => {
  const cfg = { stop: { afterSpendUsd: 100 } };
  assert.deepEqual(resolveStopConfig(["run", "--stop-after-spend", "25"], cfg), { afterSpendUsd: 25 });
  assert.deepEqual(resolveStopConfig(["run"], cfg), { afterSpendUsd: 100 });
});

test("run: --stop-after-spend combines fine with --once/--until-idle, and is rejected alongside --dry-run", () => {
  assert.equal(runCli(["node", "sapwood", "run", "--once", "--stop-after-spend", "25"]).code, -1);
  const r = runCli(["node", "sapwood", "run", "--dry-run", "--stop-after-spend", "25"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--dry-run cannot combine with --stop-\*/);
});

test("parseStopFlags: tolerates the full process.argv (like parseRunStopMode) — leading tokens just pass through", () => {
  const { rest, stop } = parseStopFlags(["node", "sapwood", "run", "--stop-after-issues", "1"]);
  assert.deepEqual(stop, { afterIssuesMerged: 1 });
  assert.deepEqual(rest, ["node", "sapwood", "run"]);
});

test("parseStopFlags: no --stop-* flags -> empty stop, rest unchanged", () => {
  const { rest, stop, error } = parseStopFlags(["run", "--until-idle"]);
  assert.equal(error, undefined);
  assert.deepEqual(stop, {});
  assert.deepEqual(rest, ["run", "--until-idle"]);
});

test("parseStopFlags: a missing value, or a value that looks like another flag, is a clear error", () => {
  assert.match(parseStopFlags(["--stop-after-issues"]).error ?? "", /--stop-after-issues requires a value/);
  assert.match(parseStopFlags(["--stop-after-issues", "--once"]).error ?? "", /--stop-after-issues requires a value/);
  assert.match(parseStopFlags(["--stop-on-milestone"]).error ?? "", /--stop-on-milestone requires a value/);
});

test("parseStopFlags: zero and non-integer values for the two count flags are rejected", () => {
  for (const bad of ["0", "1.5", "nope"]) {
    assert.match(
      parseStopFlags(["--stop-after-issues", bad]).error ?? "",
      /--stop-after-issues requires a positive integer/,
      bad,
    );
    assert.match(
      parseStopFlags(["--stop-after-prs", bad]).error ?? "",
      /--stop-after-prs requires a positive integer/,
      bad,
    );
  }
});

test("parseStopFlags: a negative value (e.g. -1) is caught by the same 'looks like another flag' guard as a missing value (same convention as --config elsewhere)", () => {
  assert.match(parseStopFlags(["--stop-after-issues", "-1"]).error ?? "", /--stop-after-issues requires a value/);
});

test("parseStopFlags: --stop-on-milestone accepts any non-flag string, including one that looks numeric", () => {
  assert.deepEqual(parseStopFlags(["--stop-on-milestone", "42"]).stop, { onMilestoneComplete: "42" });
});

test("run: an invalid --stop-* value is rejected before the engine starts (fail closed, exit 1)", () => {
  const r = runCli(["node", "sapwood", "run", "--stop-after-issues", "0"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--stop-after-issues requires a positive integer/);
  assert.match(r.stderr, /usage: sapwood run/);
});

test("run: a --stop-* flag's value is never mistaken for an unknown bare flag", () => {
  const r = runCli(["node", "sapwood", "run", "--stop-after-issues", "3", "--stop-on-milestone", "M4"]);
  assert.equal(r.code, -1); // falls through to the engine path, same as any other valid invocation
});

test("run: --stop-* combined with --dry-run is rejected (dry-run never runs the loop)", () => {
  const r = runCli(["node", "sapwood", "run", "--dry-run", "--stop-after-issues", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--dry-run cannot combine with --stop-\*/);
});

test("run: --stop-* combines fine with --once/--until-idle (falls through to the engine path)", () => {
  assert.equal(runCli(["node", "sapwood", "run", "--once", "--stop-after-issues", "1"]).code, -1);
  assert.equal(runCli(["node", "sapwood", "run", "--until-idle", "--stop-after-prs", "2"]).code, -1);
});

test("resolveStopConfig: CLI flags override config values, field by field", () => {
  const cfg = { stop: { afterIssuesMerged: 10, afterPRsOpened: 20, onMilestoneComplete: "M1" } };
  // Only afterIssuesMerged is overridden on the CLI — the other two fall back to config.
  const resolved = resolveStopConfig(["run", "--stop-after-issues", "3"], cfg);
  assert.deepEqual(resolved, { afterIssuesMerged: 3, afterPRsOpened: 20, onMilestoneComplete: "M1" });
});

test("resolveStopConfig: no flags -> config values pass through unchanged; no config -> all undefined (no key present)", () => {
  const cfg = { stop: { afterIssuesMerged: 10, afterPRsOpened: 20, onMilestoneComplete: "M1" } };
  assert.deepEqual(resolveStopConfig(["run"], cfg), { afterIssuesMerged: 10, afterPRsOpened: 20, onMilestoneComplete: "M1" });
  const resolved = resolveStopConfig(["run"], { stop: {} });
  assert.deepEqual(resolved, {}); // no field present at all — same shape as "no stop config" (#76 regression contract)
});

test("assertStopMilestoneExists: unknown/partial title fails CLOSED at startup, naming the available exact titles (fable gate② P2)", async () => {
  const forge = { listMilestoneTitles: async () => ["M4 — UX surface + CLI", "v0.2 — Dashboard (dogfood)"] };
  // Exact match passes.
  await assertStopMilestoneExists(forge, { onMilestoneComplete: "M4 — UX surface + CLI" });
  // The exact footgun probed live: "M4" is a prefix, not a match — gh would silently return []
  // and fire the condition on tick 1. Must throw BEFORE any dispatch, listing what IS valid.
  await assert.rejects(
    () => assertStopMilestoneExists(forge, { onMilestoneComplete: "M4" }),
    /no milestone titled "M4".*M4 — UX surface \+ CLI/s,
  );
  // No milestone goal configured -> no forge call needed, resolves silently.
  await assertStopMilestoneExists({ listMilestoneTitles: async () => { throw new Error("must not be called"); } }, {});
});

// ── #129: `--milestone NAME` shortcut — scope + stop in one flag ───────────────────────────────

test("parseMilestoneFlag: parses --milestone NAME, tolerates the full argv, leaves everything else in `rest`", () => {
  const { rest, milestone, error } = parseMilestoneFlag(["node", "sapwood", "run", "--once", "--milestone", "M4"]);
  assert.equal(error, undefined);
  assert.equal(milestone, "M4");
  assert.deepEqual(rest, ["node", "sapwood", "run", "--once"]);
});

test("parseMilestoneFlag: no --milestone -> undefined, rest unchanged", () => {
  const { rest, milestone, error } = parseMilestoneFlag(["run", "--until-idle"]);
  assert.equal(error, undefined);
  assert.equal(milestone, undefined);
  assert.deepEqual(rest, ["run", "--until-idle"]);
});

test("parseMilestoneFlag: a missing value, or a value that looks like another flag, is a clear error", () => {
  assert.match(parseMilestoneFlag(["--milestone"]).error ?? "", /--milestone requires a value/);
  assert.match(parseMilestoneFlag(["--milestone", "--once"]).error ?? "", /--milestone requires a value/);
});

test("parseMilestoneFlag: accepts any non-flag string, including one that looks numeric", () => {
  assert.equal(parseMilestoneFlag(["--milestone", "42"]).milestone, "42");
});

test("run: --milestone appears in --help usage, documenting the scope+stop shortcut and its precedence", () => {
  const r = runCli(["node", "sapwood", "run", "--help"]);
  assert.match(r.stdout, /--milestone/);
  assert.match(r.stdout, /round\.milestone/);
  assert.match(r.stdout, /cannot combine[\s\S]*--stop-on-milestone/);
});

test("run: --milestone NAME's value is never mistaken for an unknown bare flag — falls through to the engine path", () => {
  const r = runCli(["node", "sapwood", "run", "--milestone", "M4"]);
  assert.equal(r.code, -1);
});

test("run: a missing --milestone value is rejected before the engine starts (fail closed, exit 1)", () => {
  const r = runCli(["node", "sapwood", "run", "--milestone"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--milestone requires a value/);
  assert.match(r.stderr, /usage: sapwood run/);
});

test("run: --milestone combined with an explicit --stop-on-milestone is rejected — ambiguous, even when the names match", () => {
  const differing = runCli(["node", "sapwood", "run", "--milestone", "M4", "--stop-on-milestone", "M5"]);
  assert.equal(differing.code, 1);
  assert.match(differing.stderr, /--milestone cannot combine with --stop-on-milestone/);

  const matching = runCli(["node", "sapwood", "run", "--milestone", "M4", "--stop-on-milestone", "M4"]);
  assert.equal(matching.code, 1);
  assert.match(matching.stderr, /--milestone cannot combine with --stop-on-milestone/);
});

test("run: --milestone combines fine with --stop-after-issues/--stop-after-prs (distinct stop keys, no conflict)", () => {
  assert.equal(runCli(["node", "sapwood", "run", "--milestone", "M4", "--stop-after-issues", "3"]).code, -1);
  assert.equal(runCli(["node", "sapwood", "run", "--milestone", "M4", "--stop-after-prs", "2"]).code, -1);
});

test("run: --milestone combined with --dry-run is rejected — --milestone implies a stop condition, same as any --stop-*", () => {
  const r = runCli(["node", "sapwood", "run", "--dry-run", "--milestone", "M4"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--dry-run cannot combine with --stop-\*/);
});

test("run: --milestone combines fine with --once/--until-idle (falls through to the engine path)", () => {
  assert.equal(runCli(["node", "sapwood", "run", "--once", "--milestone", "M4"]).code, -1);
  assert.equal(runCli(["node", "sapwood", "run", "--until-idle", "--milestone", "M4"]).code, -1);
});

test("resolveStopConfig: --milestone sets onMilestoneComplete exactly like --stop-on-milestone would", () => {
  const cfg = { stop: {} };
  assert.deepEqual(resolveStopConfig(["run", "--milestone", "M4"], cfg), { onMilestoneComplete: "M4" });
});

test("resolveStopConfig: --milestone (CLI) overrides config's stop.onMilestoneComplete for this run only", () => {
  const cfg = { stop: { onMilestoneComplete: "M1" } };
  assert.deepEqual(resolveStopConfig(["run", "--milestone", "M4"], cfg), { onMilestoneComplete: "M4" });
  // No CLI flag at all -> config value passes through unchanged (the override is CLI-only).
  assert.deepEqual(resolveStopConfig(["run"], cfg), { onMilestoneComplete: "M1" });
});

test("applyMilestoneOverride: no --milestone -> cfg returned unchanged (same reference)", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  assert.equal(applyMilestoneOverride(["run"], cfg), cfg);
});

test("applyMilestoneOverride: --milestone NAME overrides cfg.round.milestone for THIS RUN ONLY — a new object, original cfg untouched", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    round: { milestone: "M1" },
  });
  const effective = applyMilestoneOverride(["run", "--milestone", "M4"], cfg);
  assert.equal(effective.round.milestone, "M4");
  assert.equal(cfg.round.milestone, "M1", "the original loaded config is never mutated");
});

test("applyMilestoneOverride + resolveStopConfig: --milestone sets BOTH scope and stop to the same name in one flag, config's independent (differing) values notwithstanding", () => {
  // round.milestone and stop.onMilestoneComplete are orthogonal mechanisms and may legitimately
  // differ in config (scope one milestone, stop on a different one) — #129's shortcut overrides
  // BOTH to the same CLI-given name for this run, without erroring on that pre-existing config
  // divergence (only an explicit conflicting --stop-on-milestone flag is rejected, tested above).
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    round: { milestone: "M1" },
    stop: { onMilestoneComplete: "M2" },
  });
  const argv = ["node", "sapwood", "run", "--milestone", "M4"];
  const effective = applyMilestoneOverride(argv, cfg);
  assert.equal(effective.round.milestone, "M4");
  assert.deepEqual(resolveStopConfig(argv, effective), { onMilestoneComplete: "M4" });
});

test("formatStopConditionLine: names the condition, its threshold, and the count/state detail", () => {
  assert.equal(
    formatStopConditionLine({ name: "afterIssuesMerged", threshold: 3, detail: "merged 3" }),
    "sapwood run: stop condition hit — afterIssuesMerged=3 (merged 3)",
  );
  assert.equal(
    formatStopConditionLine({ name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" }),
    "sapwood run: stop condition hit — onMilestoneComplete=M4 (0 open issues left)",
  );
});

// ── #49: `sapwood validate` ───────────────────────────────────────────────────────────────

test("validate: appears in top-level --help usage", () => {
  const r = runCli(["node", "sapwood", "--help"]);
  assert.match(r.stdout, /validate/);
});

test("validate: valid config prints OK summary with path + key effective values, exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  try {
    const r = runCli(["node", "sapwood", "validate", path]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(r.stdout, /lanes\.max=3/);
    assert.match(r.stdout, /guard\.mode=hard/);
    assert.match(r.stdout, /merge\.mode=conductor-merge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: worker.promptFile pointing nowhere fails validation, exits 1 (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  promptFile: /nonexistent/nope.md\n");
  try {
    const r = runCli(["node", "sapwood", "validate", path]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/nonexistent\/nope\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: worker.promptFile with an unknown {{var}} fails validation, exits 1 (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const cfgPath = join(dir, "sapwood.config.yaml");
  const promptPath = join(dir, "bad.md");
  writeFileSync(promptPath, "do {{issue.url}}");
  writeFileSync(cfgPath, `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  promptFile: ${promptPath}\n`);
  try {
    const r = runCli(["node", "sapwood", "validate", cfgPath]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown variable.*issue\.url/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: relative worker.promptFile resolves against the CONFIG's directory, not cwd (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const cfgPath = join(dir, "sapwood.config.yaml");
  writeFileSync(join(dir, "my-prompt.md"), "do #{{issue.number}}");
  writeFileSync(cfgPath, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  promptFile: my-prompt.md\n");
  try {
    // cwd is the repo, NOT `dir` — validation must still find dir/my-prompt.md.
    const r = runCli(["node", "sapwood", "validate", cfgPath]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: invalid config (wrong type) prints Zod issues one per line, exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(
    path,
    "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nlanes:\n  max: three\n",
  );
  try {
    const r = runCli(["node", "sapwood", "validate", path]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /lanes\.max/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: missing file names the path tried, exits 1", () => {
  const r = runCli(["node", "sapwood", "validate", "/tmp/does-not-exist-sapwood.config.yaml"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /does-not-exist-sapwood\.config\.yaml/);
});

test("validate --help / -h prints validate usage and exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const r = runCli(["node", "sapwood", "validate", flag]);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /usage: sapwood validate/);
  }
});

// ── #15: `sapwood run --dry-run` ──────────────────────────────────────────────────────────

const baseCfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");

test("computeDryRunPreview: candidates capped at lanes.roundDispatchCap, cost = perWorker x candidates", () => {
  const cfg = parseConfig(
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\n" +
      "lanes: { roundDispatchCap: 2 }\nworker: { budgetUsdSoft: 5 }\ncost: { dailyBudgetUsd: 40 }\n",
  );
  const ready: Issue[] = [
    { number: 1, title: "one", labels: [] },
    { number: 2, title: "two", labels: [] },
    { number: 3, title: "three", labels: [] },
  ];
  const preview = computeDryRunPreview(ready, cfg);
  assert.equal(preview.readyCount, 3);
  assert.equal(preview.dispatchableCount, 3);
  assert.equal(preview.candidates.length, 2); // capped at roundDispatchCap
  assert.deepEqual(preview.candidates.map((i) => i.number), [1, 2]);
  assert.equal(preview.perWorkerUsd, 5);
  assert.equal(preview.previewUsd, 10); // 2 x $5
  assert.equal(preview.dailyBudgetUsd, 40);
});

test("computeDryRunPreview: caps by min(roundDispatchCap, lanes.max) — max:1 + cap:2 + 2 ready => 1 candidate, cost for 1 (Codex PR #70 round-5 P2)", () => {
  const cfg = parseConfig(
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\n" +
      "lanes: { max: 1, roundDispatchCap: 2 }\nworker: { budgetUsdSoft: 8 }\n",
  );
  const ready: Issue[] = [
    { number: 1, title: "one", labels: [] },
    { number: 2, title: "two", labels: [] },
  ];
  const preview = computeDryRunPreview(ready, cfg);
  assert.equal(preview.dispatchableCount, 2);
  assert.equal(preview.effectiveLaneLimit, 1); // min(2, 1) — lanes.max is the binding limit
  assert.equal(preview.candidates.length, 1); // real loop stops at lanesUsed >= lanes.max
  assert.deepEqual(preview.candidates.map((i) => i.number), [1]);
  assert.equal(preview.previewUsd, 8); // 1 x $8, NOT 2 x $8
});

test("computeDryRunPreview: uses the REAL dispatch eligibility filter — reserve/needs-human/blocked/blocked-by issues never appear as candidates or spend (Codex PR #70 P2)", () => {
  const ready: Issue[] = [
    { number: 1, title: "held for human", labels: ["needs-human"] },
    { number: 2, title: "blocked", labels: ["blocked"] },
    { number: 3, title: "reserve", labels: ["reserve"] },
    { number: 4, title: "waiting on 9", labels: ["blocked-by:9"] },
    { number: 5, title: "actually dispatchable", labels: [] },
  ];
  const preview = computeDryRunPreview(ready, baseCfg);
  assert.equal(preview.readyCount, 5);
  assert.equal(preview.dispatchableCount, 1);
  assert.deepEqual(preview.candidates.map((i) => i.number), [5]);
  assert.equal(preview.previewUsd, baseCfg.worker.budgetUsdSoft); // 1 candidate, not 5
});

test("computeDryRunPreview: candidates follow orderForDispatch's priority ordering, not board order", () => {
  const ready: Issue[] = [
    { number: 10, title: "default prio", labels: [] }, // prio 3 (no label)
    { number: 11, title: "urgent", labels: ["prio:0"] },
  ];
  const preview = computeDryRunPreview(ready, baseCfg); // roundDispatchCap default = 6 (#124), both ready issues under it
  assert.deepEqual(preview.candidates.map((i) => i.number), [11, 10]); // prio:0 first
});

test("computeDryRunPreview: fewer ready issues than the cap -> candidates = all of them", () => {
  const ready: Issue[] = [{ number: 9, title: "solo", labels: [] }];
  const preview = computeDryRunPreview(ready, baseCfg);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.previewUsd, baseCfg.worker.budgetUsdSoft);
});

test("computeDryRunPreview: no ready issues -> zero candidates, zero cost", () => {
  const preview = computeDryRunPreview([], baseCfg);
  assert.equal(preview.readyCount, 0);
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.previewUsd, 0);
});

test("formatDryRunPreview: lists every candidate issue and the cost preview; says nothing was dispatched", () => {
  const preview = computeDryRunPreview(
    [
      { number: 11, title: "fix the thing", labels: [] },
      { number: 12, title: "add the other thing", labels: [] },
    ],
    baseCfg,
  );
  const out = formatDryRunPreview(preview);
  assert.match(out, /#11 fix the thing/);
  assert.match(out, /#12 add the other thing/);
  assert.match(out, /cost preview/);
  assert.match(out, /no worker dispatched, no state written/);
});

test("run --dry-run appears in --help usage", () => {
  const r = runCli(["node", "sapwood", "--help"]);
  assert.match(r.stdout, /--dry-run/);
});

test("run --dry-run falls through to the async path (code -1), same as init/run", () => {
  const r = runCli(["node", "sapwood", "run", "--dry-run"]);
  assert.equal(r.code, -1);
});

test("run --dry-run combined with --once/--until-idle is rejected, exit 1", () => {
  const withOnce = runCli(["node", "sapwood", "run", "--dry-run", "--once"]);
  assert.equal(withOnce.code, 1);
  assert.match(withOnce.stderr, /--dry-run cannot combine/);
  const withUntilIdle = runCli(["node", "sapwood", "run", "--dry-run", "--until-idle"]);
  assert.equal(withUntilIdle.code, 1);
});

test("run --dry-run --help prints run usage (help wins over any other flag)", () => {
  const r = runCli(["node", "sapwood", "run", "--dry-run", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: sapwood run/);
});

// ── #15: `sapwood status` ─────────────────────────────────────────────────────────────────

test("status: appears in top-level --help usage", () => {
  const r = runCli(["node", "sapwood", "--help"]);
  assert.match(r.stdout, /status/);
});

test("parseStatusArgs: defaults to data/sapwood.sqlite, no config override", () => {
  const parsed = parseStatusArgs(["node", "sapwood", "status"]);
  assert.equal(parsed.dbPath, "data/sapwood.sqlite");
  assert.equal(parsed.configPath, undefined);
  assert.equal(parsed.help, false);
});

test("parseStatusArgs: positional db path + --config override", () => {
  const parsed = parseStatusArgs(["node", "sapwood", "status", "/tmp/x.sqlite", "--config", "/tmp/cfg.yaml"]);
  assert.equal(parsed.dbPath, "/tmp/x.sqlite");
  assert.equal(parsed.configPath, "/tmp/cfg.yaml");
});

test("parseStatusArgs: unknown flag is an error", () => {
  const parsed = parseStatusArgs(["node", "sapwood", "status", "--bogus"]);
  assert.equal(parsed.error, "unknown flag: --bogus");
});

test("parseStatusArgs: --config with no operand is an error, never a silent default-config read (Codex PR #70 P2)", () => {
  const parsed = parseStatusArgs(["node", "sapwood", "status", "--config"]);
  assert.equal(parsed.error, "--config requires a path");
});

test("parseStatusArgs: --config followed by a flag is an error, never consumed as a path (Codex PR #70 P2)", () => {
  const parsed = parseStatusArgs(["node", "sapwood", "status", "--config", "--bogus", "data/db.sqlite"]);
  assert.equal(parsed.error, "--config requires a path");
});

test("status: --config with a missing/flag operand exits 1 with the clear error via runCli", () => {
  for (const argv of [
    ["node", "sapwood", "status", "--config"],
    ["node", "sapwood", "status", "--config", "--bogus", "data/db.sqlite"],
  ]) {
    const r = runCli(argv);
    assert.equal(r.code, 1, argv.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--config requires a path/);
    assert.match(r.stderr, /usage: sapwood status/);
  }
});

test("parseStatusArgs: --help / -h wins", () => {
  assert.equal(parseStatusArgs(["node", "sapwood", "status", "--help"]).help, true);
  assert.equal(parseStatusArgs(["node", "sapwood", "status", "-h"]).help, true);
});

test("status --help / -h prints status usage and exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const r = runCli(["node", "sapwood", "status", flag]);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /usage: sapwood status/);
  }
});

test("status: unknown flag errors + usage, exit 1", () => {
  const r = runCli(["node", "sapwood", "status", "--bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.match(r.stderr, /usage: sapwood status/);
});

test("status: no DB at the given path reports 'engine has never run', exit 0, no file created", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  try {
    const r = runCli(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no state DB/);
    assert.match(r.stdout, new RegExp(dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Read-only: checking status must never create the DB it didn't find.
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: seeded DB with a running worker, a driving/gated PR, spend, and kill switch — output contains every field", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const configPath = join(dir, "sapwood.config.yaml");
  writeFileSync(
    configPath,
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n",
  );
  const seed = new State(dbPath);
  seed.upsertWorker({
    name: "lane-12-abcd", issue: 12, session_id: "s1", state: "running",
    started_at: "2026-07-06T10:00:00.000Z", ended_at: null,
  });
  seed.upsertWorker({
    name: "lane-9-efgh", issue: 9, session_id: "s2", state: "driving",
    started_at: "2026-07-05T09:00:00.000Z", ended_at: null, pr: 101,
  });
  // Spend ts must be TODAY (runStatus queries dailySpendUsd(new Date())) — a hard-coded date
  // would silently rot this test the day after it was written (Codex PR #70 P2).
  seed.recordSpend("lane-9-efgh", 9, 12.5, new Date().toISOString());
  seed.close();
  try {
    const r = runCli(["node", "sapwood", "status", dbPath, "--config", configPath]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /lane-12-abcd/);
    assert.match(r.stdout, /issue #12/);
    assert.match(r.stdout, /lane-9-efgh/);
    assert.match(r.stdout, /issue #9/);
    assert.match(r.stdout, /PR #101/);
    assert.match(r.stdout, /2\/3 active/); // 1 running + 1 driving, lanes.max=3
    assert.match(r.stdout, /1 running, 1 driving/);
    assert.match(r.stdout, /gated PRs \(awaiting review gate\): 1/);
    assert.match(r.stdout, /\$12\.50 \/ \$50\.00 daily ceiling/);
    assert.match(r.stdout, /kill switch: inactive/);
    assert.match(r.stdout, /ceiling breach: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: missing config still prints DB-derived fields, config-derived fields shown as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const missingConfig = join(dir, "does-not-exist.yaml");
  const seed = new State(dbPath);
  seed.close();
  try {
    const r = runCli(["node", "sapwood", "status", dbPath, "--config", missingConfig]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0\/unknown active/);
    assert.match(r.stdout, /unknown \(no config found\) daily ceiling/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatStatus: kill-switch active and a recorded ceiling breach both render", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: 6,
    active: [],
    driving: [],
    killSwitchActive: true,
    pauseActive: false,
    ceilingBreach: { reasons: ["daily-budget", "kill-switch"], at: new Date("2026-07-07T00:00:00.000Z") },
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
  };
  const out = formatStatus(snapshot);
  assert.match(out, /kill switch: ACTIVE/);
  assert.match(out, /pause: inactive/);
  assert.match(out, /ceiling breach: daily-budget, kill-switch \(since 2026-07-07T00:00:00\.000Z\)/);
});

test("formatStatus: PAUSE active renders distinctly from kill switch, both can be reported independently", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: 7,
    active: [],
    driving: [],
    killSwitchActive: false,
    pauseActive: true,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
  };
  const out = formatStatus(snapshot);
  assert.match(out, /kill switch: inactive/);
  assert.match(out, /pause: PAUSED/);
});

test("runStatus: exported directly (not just via runCli) for the same result", () => {
  const r = runStatus(["node", "sapwood", "status", "/tmp/does-not-exist-sapwood-status.sqlite"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no state DB/);
});

test("status: truly read-only — DB file bytes, user_version, and journal_mode all unchanged (Codex PR #70 P2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath);
  seed.upsertWorker({
    name: "lane-1-ro", issue: 1, session_id: "s1", state: "running",
    started_at: "2026-07-07T09:00:00.000Z", ended_at: null,
  });
  seed.close();
  try {
    const before = readFileSync(dbPath);
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /lane-1-ro/);
    const after = readFileSync(dbPath);
    assert.ok(before.equals(after), "status must not modify a single byte of the DB file");
    // Belt-and-braces on the two specific mutations the normal State constructor performs:
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
    );
    assert.equal(
      (check.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      "wal", // what the engine set at seed time — status didn't switch it (or anything else)
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: against a stopped/checkpointed WAL DB works and mutates no sapwood STATE — main file + user_version stable, SQLite coordination sidecars allowed (Codex PR #70 round-5 P2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath); // WAL mode
  seed.upsertWorker({
    name: "lane-1-wal", issue: 1, session_id: "s1", state: "running",
    started_at: "2026-07-07T09:00:00.000Z", ended_at: null,
  });
  seed.close(); // checkpoints + drops sidecars: a cleanly stopped engine
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
  const mainBefore = readFileSync(dbPath);
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /lane-1-wal/); // read the data correctly
    // The contract is "mutate no sapwood STATE", NOT "create zero files": a normal read-only
    // open (needed to read live WAL frames — see the live-WAL test below) may create SQLite's
    // own -wal/-shm coordination sidecars, which are not sapwood state (Codex PR #70 round-5).
    assert.ok(readFileSync(dbPath).equals(mainBefore), "main DB file must be byte-stable");
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
      "status must not migrate/alter the schema version",
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: against a LIVE engine (rows committed only in the -wal) reads them correctly, NOT stale/v0 (Codex PR #70 round-5 P2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  // Keep the "engine" connection OPEN so its committed rows stay in the -wal, un-checkpointed
  // to the main file — exactly the live-engine state where an immutable open would see v0.
  const engine = new State(dbPath);
  engine.upsertWorker({
    name: "lane-42-live", issue: 42, session_id: "s-live", state: "running",
    started_at: "2026-07-08T09:00:00.000Z", ended_at: null,
  });
  assert.ok(existsSync(dbPath + "-wal"), "precondition: rows are in the live -wal, not the main file");
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0); // NOT the schema-mismatch exit 1 an immutable v0 read would give
    assert.doesNotMatch(r.stderr, /schema v0/);
    assert.match(r.stdout, /lane-42-live/); // saw the live WAL-only worker row
    assert.match(r.stdout, /issue #42/);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: DB schema NEWER than this engine -> clear upgrade message, exit 1, never migrated (Codex PR #70 P2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  new State(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`);
  raw.close();
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`DB schema v${SCHEMA_VERSION + 3}.*newer.*upgrade sapwood`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: DB schema OLDER than this engine -> clear 'run the engine to migrate' message, exit 1, still not migrated by status", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  new State(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /DB schema v1.*older.*status never migrates/);
    // status must have left the old version exactly as it found it.
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      1,
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
