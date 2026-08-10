import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  announceFixLoopUnattached,
  applyMilestoneOverride,
  assertStopMilestoneExists,
  buildTickFixLegResume,
  checkWebAccessSettingsDenial,
  computeDryRunPreview,
  formatDryRunPreview,
  formatStatus,
  formatStopConditionLine,
  formatTickSummary,
  normalizeUnplacedBoardItems,
  parseMilestoneFlag,
  parseRunConfigFlag,
  parseRunStopMode,
  parseStatusArgs,
  parseStopFlags,
  reconcileWorkflowLabels,
  resolveStopConfig,
  roundsExitCode,
  runCli,
  runExitCode,
  runStatus,
  type StatusSnapshot,
} from "../cli.js";
import { ConfigSchema, parseConfig } from "../config/config.js";
import type { IForge, Issue } from "../forge/forge.js";
import type { LabelSpec } from "../forge/labels.js";
import type { ProxyForge } from "../proxy/mcp-server.js";
import type { LaneAnchorsDTO } from "../state/read-model.js";
import { SCHEMA_VERSION, State } from "../state/state.js";
import { requiredLabels } from "./init.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

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

// ── #638: `init` gets the same synchronous fail-closed argument boundary as run/status/park ──

test("init --help / -h prints init usage and exits 0 — NEVER falls through toward init()'s credentialed writes (#638)", () => {
  for (const flag of ["--help", "-h"]) {
    const r = runCli(["node", "sapwood", "init", flag]);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /usage: sapwood init/);
    assert.equal(r.stderr, "");
    // code !== -1 means main() returns immediately after this — init() is never reached.
    assert.notEqual(r.code, -1);
  }
});

test("init with an unknown flag or a stray operand errors + usage, exit 1 — fail closed, never silently swallowed (#638)", () => {
  const bogus = runCli(["node", "sapwood", "init", "--bogus"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /--bogus/);
  assert.match(bogus.stderr, /usage: sapwood init/);
  assert.equal(bogus.stdout, "");

  const operand = runCli(["node", "sapwood", "init", "stray-operand"]);
  assert.equal(operand.code, 1);
  assert.match(operand.stderr, /stray-operand/);
  assert.match(operand.stderr, /usage: sapwood init/);
  assert.equal(operand.stdout, "");
});

test("init: bare invocation still falls through to the async path unchanged (code -1) — hardening must not break the feature (#638)", () => {
  const r = runCli(["node", "sapwood", "init"]);
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

test("parseRunConfigFlag: absent leaves argv untouched; present consumes exactly its path operand", () => {
  const absent = ["node", "sapwood", "run", "--once"];
  assert.deepEqual(parseRunConfigFlag(absent), { rest: absent });
  assert.deepEqual(parseRunConfigFlag(["node", "sapwood", "run", "--config", "x.yaml", "--once"]), {
    rest: ["node", "sapwood", "run", "--once"],
    configPath: "x.yaml",
  });
});

test("run --config interleaves with --once and stop flags without its operand becoming an argument", () => {
  for (const argv of [
    ["node", "sapwood", "run", "--config", "x.yaml", "--once"],
    ["node", "sapwood", "run", "--once", "--config", "x.yaml"],
    ["node", "sapwood", "run", "--stop-after-issues", "1", "--config", "x.yaml", "--until-idle"],
    ["node", "sapwood", "run", "--config", "x.yaml", "--milestone", "M4"],
  ]) {
    assert.equal(runCli(argv).code, -1, argv.join(" "));
  }
});

test("run --config fails closed on a missing or flag-shaped operand", () => {
  for (const argv of [
    ["node", "sapwood", "run", "--config"],
    ["node", "sapwood", "run", "--config", "--once"],
  ]) {
    const parsed = parseRunConfigFlag(argv);
    assert.equal(parsed.error, "--config requires a path", argv.join(" "));
    const result = runCli(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /--config requires a path/);
    assert.match(result.stderr, /usage: sapwood run/);
  }
});

test("run --help documents config-relative file keys and cwd-relative runtime paths", () => {
  const result = runCli(["node", "sapwood", "run", "--help"]);
  assert.match(result.stdout, /--config PATH/);
  assert.match(result.stdout, /config-file-relative logging\.path, promptFile, goal\.file, and doctrine\.file/);
  assert.match(result.stdout, /default log sits beside that config/);
  assert.match(result.stdout, /DB\s+\(data\/sapwood\.sqlite\), KILL_SWITCH\/PAUSE, sessions, and worktree roots/);
  assert.match(result.stdout, /remain relative to the current working directory/);
});

test("runExitCode: --once with a failed-only attempt exits 1; success exits 0 (Codex PR #50 cli.ts:82)", () => {
  assert.equal(runExitCode({ ticks: 1, tickErrors: 0 }, "once"), 0); // one-shot succeeded
  assert.equal(runExitCode({ ticks: 0, tickErrors: 1 }, "once"), 1); // failed one-shot must fail the cron job
});

test("runExitCode: daemon/until-idle runs exit 0 even with contained tick errors (retry design, not terminal failure)", () => {
  assert.equal(runExitCode({ ticks: 0, tickErrors: 5 }, "forever"), 0);
  assert.equal(runExitCode({ ticks: 3, tickErrors: 2 }, "until-idle"), 0);
});

test("roundsExitCode (#724 gate② finding [1]): kill-switch AND emergency-stop are both operator-notice failures — 1; every graceful stop is 0", () => {
  assert.equal(roundsExitCode({ stoppedBy: "kill-switch" }), 1);
  assert.equal(roundsExitCode({ stoppedBy: "emergency-stop" }), 1);
  assert.equal(roundsExitCode({ stoppedBy: "signal" }), 0);
  assert.equal(roundsExitCode({ stoppedBy: "stop-condition" }), 0);
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
    "run",
    "--once",
    "--stop-after-issues",
    "3",
    "--stop-after-prs",
    "5",
    "--stop-on-milestone",
    "M4",
    "--stop-after-spend",
    "25",
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
    assert.match(parseStopFlags(["--stop-after-spend", bad]).error ?? "", /--stop-after-spend requires a positive number/, bad);
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
    assert.match(parseStopFlags(["--stop-after-issues", bad]).error ?? "", /--stop-after-issues requires a positive integer/, bad);
    assert.match(parseStopFlags(["--stop-after-prs", bad]).error ?? "", /--stop-after-prs requires a positive integer/, bad);
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
  await assertStopMilestoneExists(
    {
      listMilestoneTitles: async () => {
        throw new Error("must not be called");
      },
    },
    {},
  );
});

// ── #379 F1: startup workflow-label reconcile — the engine provisions any label the resolved
// config names but the repo lacks, from the SAME list `sapwood init` uses. Live baseline: this
// repo predated round:pool/split/decomposed/hold and every pool-label write failed on first
// start, because nothing ever created the labels as the feature set grew. ──

test("#379 reconcileWorkflowLabels: provisions the resolved config's FULL label list (the same one `sapwood init` uses) and records what it created", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const seen: LabelSpec[][] = [];
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  await reconcileWorkflowLabels(
    {
      ensureRepoLabels: async (specs) => {
        seen.push([...specs]);
        return ["sapwood:round:pool", "sapwood:hold"];
      },
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    cfg,
    (line) => logs.push(line),
  );
  assert.deepEqual(seen, [requiredLabels(cfg)], "one pass over the shared provisioning list — no second, drifting copy");
  const names = new Set(seen[0]!.map((spec) => spec.name));
  for (const name of ["sapwood:round:pool", "sapwood:split", "sapwood:decomposed", "sapwood:hold"]) {
    assert.ok(names.has(name), `${name} is provisioned`);
  }
  assert.deepEqual(events, [["labels-reconciled", { created: ["sapwood:round:pool", "sapwood:hold"] }]]);
  assert.ok(logs.some((line) => /sapwood:round:pool/.test(line)));
});

test("#379 reconcileWorkflowLabels: nothing missing -> no event, no noise", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const events: unknown[] = [];
  const logs: string[] = [];
  await reconcileWorkflowLabels({ ensureRepoLabels: async () => [] }, { appendEvent: (_k, p) => events.push(p) }, cfg, (l) => logs.push(l));
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("#379 reconcileWorkflowLabels: a denied/failing label write logs and lets startup continue — never blocks the engine", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const events: unknown[] = [];
  const logs: string[] = [];
  await reconcileWorkflowLabels(
    {
      ensureRepoLabels: async () => {
        throw new Error("HTTP 403: Resource not accessible");
      },
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    cfg,
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [], "no event on a failed provisioning pass");
  assert.ok(logs.some((line) => /403/.test(line) && /continuing/.test(line)));
});

test("normalizeUnplacedBoardItems: moves every issue to backlog and records one event per move", async () => {
  const moves: Array<[number, string]> = [];
  const events: Array<[string, unknown]> = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [17, 18], skipped: 0 }),
      setBoardStatus: async (issue, status) => {
        moves.push([issue, status]);
      },
      listIssuesAbsentFromBoard: async () => ({ unplaced: [], elsewhere: 0 }),
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    () => {},
  );
  assert.deepEqual(moves, [
    [17, "backlog"],
    [18, "backlog"],
  ]);
  assert.deepEqual(events, [
    ["board-normalized", { issue: 17, status: "backlog" }],
    ["board-normalized", { issue: 18, status: "backlog" }],
  ]);
});

test("normalizeUnplacedBoardItems: a failed move is logged and does not block later moves", async () => {
  const moves: number[] = [];
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [21, 22], skipped: 1 }),
      setBoardStatus: async (issue) => {
        moves.push(issue);
        if (issue === 21) throw new Error("boom");
      },
      listIssuesAbsentFromBoard: async () => ({ unplaced: [], elsewhere: 0 }),
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(moves, [21, 22]);
  assert.deepEqual(events, [{ issue: 22, status: "backlog" }]);
  assert.equal(logs.filter((line) => /draft\/foreign-repo/.test(line)).length, 1);
  assert.ok(logs.some((line) => /#21/.test(line) && /continuing/.test(line)));
});

// ── #412: normalizeUnplacedBoardItems' detect-and-report sibling — open issues absent from the
// configured board altogether (never placed there at all, unlike the No-Status case above). ──

test("normalizeUnplacedBoardItems: reports open issues absent from the board — one log line + one state event naming the exact count (regression: absent on main)", async () => {
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => ({ unplaced: [101, 102], elsewhere: 0 }),
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [["board-gap-detected", { total: 2, issues: [101, 102], elsewhere: 0 }]]);
  assert.ok(logs.some((line) => /\b2\b/.test(line) && /#101/.test(line) && /#102/.test(line)));
});

test("normalizeUnplacedBoardItems: no absent issues -> no report event, no noise", async () => {
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => ({ unplaced: [], elsewhere: 0 }),
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("normalizeUnplacedBoardItems: the enumeration is capped, but the reported total is always the true count", async () => {
  const absentIssues = Array.from({ length: 40 }, (_, i) => 1000 + i); // 40 absent issues
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => ({ unplaced: absentIssues, elsewhere: 0 }),
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "board-gap-detected");
  const { total, issues } = payload as { total: number; issues: number[] };
  assert.equal(total, 40, "the reported total is the TRUE count, never the truncated enumeration length");
  assert.ok(issues.length < 40, "the enumerated list is capped");
  assert.deepEqual(issues, absentIssues.slice(0, issues.length));
  assert.ok(
    logs.some((line) => /\b40\b/.test(line)),
    "the log line states the true total, not the capped length",
  );
});

// #491: issues that ARE placed, just on another board, are a one-line count — never rows in
// the actionable list, which is what trained the operator to skip the whole report.
test("normalizeUnplacedBoardItems: issues placed on another board are one summary count, never listed rows (#491)", async () => {
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => ({ unplaced: [101], elsewhere: 29 }),
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [["board-gap-detected", { total: 1, issues: [101], elsewhere: 29 }]]);
  assert.equal(logs.length, 1, "one line total, not one per placed-elsewhere issue");
  assert.ok(/#101/.test(logs[0]!) && /\b29\b/.test(logs[0]!), "the actionable issue is named; the rest are a bare count");
});

test("normalizeUnplacedBoardItems: every open issue placed somewhere -> silence, even with a large elsewhere count (#491)", async () => {
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => ({ unplaced: [], elsewhere: 30 }),
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [], "nothing is actionable — nothing is reported");
  assert.deepEqual(logs, []);
});

test("normalizeUnplacedBoardItems: a computation failure logs and lets startup complete — never blocks", async () => {
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => {
        throw new Error("gh boom");
      },
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [], "no event on a failed computation");
  assert.ok(logs.some((line) => /could not compute/.test(line) && /gh boom/.test(line)));
});

// #415 review findings 1+2: a wrong report is worse than no report. GithubForge.
// listIssuesAbsentFromBoard throws (rather than compute) whenever either read feeding it might
// be truncated — fetchProject's page ceiling, or listOpenIssueNumbers hitting its --limit
// ceiling. These extend the generic failure-isolation test above to prove BOTH specific
// truncation signals degrade the same way through the real integration: logged skip, zero
// event — never a falsely-confident "absent" report.

test("normalizeUnplacedBoardItems: fetchProject's page-ceiling truncation degrades to a logged skip, no event (#415 finding 1)", async () => {
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => {
        throw new Error("listIssuesAbsentFromBoard: board read hit fetchProject's page ceiling — refusing a possibly-wrong absent report");
      },
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [], "no board-gap-detected event when the board read may be truncated");
  assert.ok(logs.some((line) => /could not compute/.test(line) && /page ceiling/.test(line)));
});

test("normalizeUnplacedBoardItems: listOpenIssueNumbers' --limit truncation degrades to a logged skip, no event (#415 finding 2)", async () => {
  const events: unknown[] = [];
  const logs: string[] = [];
  await normalizeUnplacedBoardItems(
    {
      listUnplacedIssues: async () => ({ issues: [], skipped: 0 }),
      setBoardStatus: async () => assert.fail("must not write to the board while reporting"),
      listIssuesAbsentFromBoard: async () => {
        throw new Error(
          "listIssuesAbsentFromBoard: open-issue read may be incomplete (hit the 1000-issue limit) — refusing a possibly-wrong absent report",
        );
      },
    },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.deepEqual(events, [], "no board-gap-detected event when the open-issue read may be truncated");
  assert.ok(logs.some((line) => /could not compute/.test(line) && /1000-issue limit/.test(line)));
});

test("normalizeUnplacedBoardItems: the No-Status normalization loop and the absent-issue report never write to the board on the report path itself", async () => {
  const writes: unknown[] = [];
  const events: Array<[string, unknown]> = [];
  await normalizeUnplacedBoardItems(
    {
      // A real No-Status item DOES get moved (existing behavior, unchanged) — proves the two
      // passes coexist — while the absent-issue report itself performs zero additional writes.
      listUnplacedIssues: async () => ({ issues: [7], skipped: 0 }),
      setBoardStatus: async (issue, status) => {
        writes.push([issue, status]);
      },
      listIssuesAbsentFromBoard: async () => ({ unplaced: [201, 202], elsewhere: 0 }),
    },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    () => {},
  );
  assert.deepEqual(writes, [[7, "backlog"]], "only the pre-existing No-Status move writes — nothing else");
  assert.deepEqual(events, [
    ["board-normalized", { issue: 7, status: "backlog" }],
    ["board-gap-detected", { total: 2, issues: [201, 202], elsewhere: 0 }],
  ]);
});

// ── #410 amendment (owner ruling 2026-07-28): checkWebAccessSettingsDenial — lightweight
// startup DETECTION, the fallback adopted after the settings-pinning approach was rejected
// (colliding with the locked #236 "ambient repo context: record, don't seal" ruling). Same
// best-effort startup-pass shape as normalizeUnplacedBoardItems above: never blocks, never
// throws, at most one log line + one durable event. ──────────────────────────────────────────

test("checkWebAccessSettingsDenial: a bare WebSearch/WebFetch deny entry -> one warning log line + one durable event naming both", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: true } },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
    {
      homedir: () => "/home/op",
      readFile: (path) => {
        assert.equal(path, "/home/op/.claude/settings.json");
        return JSON.stringify({ permissions: { deny: ["WebSearch", "WebFetch", "Bash(rm *)"] } });
      },
    },
  );
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "web-access-denied-by-operator-settings");
  assert.deepEqual(payload, { settingsPath: "/home/op/.claude/settings.json", denied: ["WebSearch", "WebFetch"] });
  assert.ok(logs.some((line) => line.includes("WebSearch") && line.includes("WebFetch")));
});

test("checkWebAccessSettingsDenial: a Tool(...)-qualified deny entry (e.g. WebFetch(domain:x)) is detected by prefix match, not just an exact bare name", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: true } },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
    { homedir: () => "/home/op", readFile: () => JSON.stringify({ permissions: { deny: ["WebFetch(domain:example.com)"] } }) },
  );
  assert.equal(events.length, 1);
  assert.deepEqual((events[0]![1] as { denied: string[] }).denied, ["WebFetch(domain:example.com)"]);
});

test("checkWebAccessSettingsDenial: no permissions.deny naming WebSearch/WebFetch -> completely silent (no log, no event)", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: true } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
    { homedir: () => "/home/op", readFile: () => JSON.stringify({ permissions: { deny: ["Bash(curl *)", "Bash(rm *)"] } }) },
  );
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("checkWebAccessSettingsDenial: no permissions key at all, or deny absent/not-an-array -> silent, never throws", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const state = { appendEvent: (_kind: string, payload: unknown) => events.push(payload) };
  for (const body of ["{}", JSON.stringify({ permissions: {} }), JSON.stringify({ permissions: { deny: "WebSearch" } })]) {
    checkWebAccessSettingsDenial({ webAccess: { enabled: true } }, state, log, { homedir: () => "/home/op", readFile: () => body });
  }
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("checkWebAccessSettingsDenial: cfg.webAccess.enabled: false -> the injected reader is NEVER called, no log, no event", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  let readCalled = false;
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: false } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
    {
      homedir: () => {
        readCalled = true; // homedir() would also be a tell — the whole check should short-circuit first
        return "/home/op";
      },
      readFile: () => {
        readCalled = true;
        return "{}";
      },
    },
  );
  assert.equal(readCalled, false, "webAccess disabled -> no settings read of any kind, not even a homedir() lookup");
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("checkWebAccessSettingsDenial: a missing settings file (readFile throws) logs a low-severity note and completes — no event, never blocks startup", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: true } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
    {
      homedir: () => "/home/op",
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    },
  );
  assert.deepEqual(events, []);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.includes("web-access denial check skipped"));
});

test("checkWebAccessSettingsDenial: malformed JSON logs a low-severity note and completes — no event, never throws out of the function", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  checkWebAccessSettingsDenial(
    { webAccess: { enabled: true } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
    { homedir: () => "/home/op", readFile: () => "not { valid json" },
  );
  assert.deepEqual(events, []);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.includes("could not be parsed as JSON"));
});

test("checkWebAccessSettingsDenial: CLAUDE_CONFIG_DIR, when set, overrides the ~/.claude fallback — same resolution peripheral.ts's ambient CLAUDE.md probe uses", () => {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/custom/claude-config";
  try {
    let seenPath = "";
    checkWebAccessSettingsDenial({ webAccess: { enabled: true } }, { appendEvent: () => {} }, () => {}, {
      homedir: () => {
        throw new Error("homedir() must not be called when CLAUDE_CONFIG_DIR is set");
      },
      readFile: (path) => {
        seenPath = path;
        return "{}";
      },
    });
    assert.equal(seenPath, "/custom/claude-config/settings.json");
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  }
});

test("checkWebAccessSettingsDenial (Codex sol-high PR #417 review, P1): state.appendEvent THROWING (e.g. a SQLite write failure) never escapes the function — the deny warning is still logged before the throw, a second failure note is logged, and the call returns normally, never blocking either driver's startup", () => {
  const logs: string[] = [];
  assert.doesNotThrow(() => {
    checkWebAccessSettingsDenial(
      { webAccess: { enabled: true } },
      {
        appendEvent: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      },
      (line) => logs.push(line),
      { homedir: () => "/home/op", readFile: () => JSON.stringify({ permissions: { deny: ["WebSearch"] } }) },
    );
  });
  assert.ok(
    logs.some((line) => line.includes("WebSearch")),
    "the deny warning is logged BEFORE the throwing appendEvent call",
  );
  assert.ok(
    logs.some((line) => line.includes("web-access denial check failed") && line.includes("non-fatal")),
    "the containment catch's own note is also logged",
  );
});

// ── #385 (F10): announceFixLoopUnattached — the degraded `prFixCap > 0` + fix-loop-unattached
// combination announces itself ONCE at startup instead of only surfacing per-escalation, once a
// PR has already been pushed to needs-human. Same best-effort startup-pass shape as
// checkWebAccessSettingsDenial above: never blocks, never throws, at most one log + one event. ──

/** #385, simplified by #551: the config matrix this announcement is defined over —
 *  `lanes.prFixCap` x the two `proxy` states left after #551 deleted `shadow`. Only the DEGRADED
 *  row (cap > 0, `enabled: false`) announces; `cap: 0` is a deliberate operator opt-out of the
 *  fix loop entirely, and `enabled: true` (#551 default) is the working configuration. */
const fixLoopMatrix = (prFixCap: number, enabled: boolean) => ({
  lanes: { prFixCap },
  proxy: { enabled },
});

test("announceFixLoopUnattached (#385, #551): prFixCap > 0 with the proxy disabled -> one log line + one durable event saying FIXABLE degrades to needs-human", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  announceFixLoopUnattached(fixLoopMatrix(4, false), { appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) =>
    logs.push(line),
  );
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "fix-loop-unattached");
  assert.deepEqual(payload, { prFixCap: 4, proxyEnabled: false, reason: "proxy-disabled" });
  assert.equal(logs.length, 1);
  // The log must name BOTH what degrades and the exact flip that fixes it — the whole point of
  // the issue is that an operator with prFixCap > 0 reasonably expects a live fix loop.
  assert.ok(logs[0]!.includes("needs-human"), "names the degradation");
  assert.ok(logs[0]!.includes("proxy.enabled: true"), "names the go-live flip");
});

test("announceFixLoopUnattached (#385, #551): the two NON-degraded halves of the matrix are completely silent — proxy.enabled: true, and prFixCap: 0 regardless of proxy.enabled", () => {
  for (const cfg of [
    fixLoopMatrix(4, true), // production-attached (#551 default): the fix loop an operator configured exists
    fixLoopMatrix(0, false), // cap 0: a deliberate opt-out; #246's fold to needs-human IS the config
    fixLoopMatrix(0, true),
  ]) {
    const logs: string[] = [];
    const events: unknown[] = [];
    announceFixLoopUnattached(cfg, { appendEvent: (_kind, payload) => events.push(payload) }, (line) => logs.push(line));
    assert.deepEqual(events, [], `no event for ${JSON.stringify(cfg)}`);
    assert.deepEqual(logs, [], `no log for ${JSON.stringify(cfg)}`);
  }
});

test("announceFixLoopUnattached (#385): state.appendEvent throwing never escapes — startup is never blocked by an announcement", () => {
  const logs: string[] = [];
  assert.doesNotThrow(() => {
    announceFixLoopUnattached(
      fixLoopMatrix(4, false),
      {
        appendEvent: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      },
      (line) => logs.push(line),
    );
  });
  assert.ok(
    logs.some((line) => line.includes("fix-loop attachment announcement failed") && line.includes("non-fatal")),
    "the containment catch's own note is logged",
  );
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
    "[sapwood:run] stop condition hit — afterIssuesMerged=3 (merged 3)",
  );
  assert.equal(
    formatStopConditionLine({ name: "onMilestoneComplete", threshold: "M4", detail: "0 open issues left" }),
    "[sapwood:run] stop condition hit — onMilestoneComplete=M4 (0 open issues left)",
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

// #245 round-2 fix A7: worker.fixPromptFile gets the SAME eager fail-fast validation as
// worker.promptFile — `sapwood validate` must reject a broken fix-leg prompt too.
test("validate: worker.fixPromptFile pointing nowhere fails validation, exits 1 (#245 round-2 fix A7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const path = join(dir, "sapwood.config.yaml");
  writeFileSync(path, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  fixPromptFile: /nonexistent/nope.md\n");
  try {
    const r = runCli(["node", "sapwood", "validate", path]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/nonexistent\/nope\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: worker.fixPromptFile with an unknown {{var}} fails validation, exits 1 — including a var worker.promptFile WOULD allow (issue.title is narrowed OUT of the fix-leg var set, #245 round-2 fix A7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  const cfgPath = join(dir, "sapwood.config.yaml");
  const promptPath = join(dir, "bad-fix.md");
  writeFileSync(promptPath, "fix {{issue.title}}");
  writeFileSync(cfgPath, `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  fixPromptFile: ${promptPath}\n`);
  try {
    const r = runCli(["node", "sapwood", "validate", cfgPath]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown variable.*issue\.title/i);
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
  writeFileSync(path, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nlanes:\n  max: three\n");
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

// ── #582: `sapwood validate` reviewer-tier inversion warning ──────────────────────────────
// D5 enforces that the two models DIFFER but says nothing about ORDERING, so a config can
// legitimately parse with the reviewer weaker than the producer it gates. WARNING, never a
// failure: model strings are free-form and the rate table is only a proxy for capability, so a
// hard fail would fight legitimate setups (cross-vendor reviewers whose rates aren't comparable).
const REVIEWER_INVERSION = /reviewer is cheaper\/weaker than worker/;

/** Writes a config pinning both models (plus an optional custom rate table) into a fresh tmpdir
 *  and validates it. Omitted models fall through to their schema defaults. */
function validateWith(o: { worker?: string; reviewer?: string; pricing?: string } = {}): { stdout: string; stderr: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-validate-"));
  try {
    const path = join(dir, "sapwood.config.yaml");
    let pricingLine = "";
    if (o.pricing !== undefined) {
      const pricingPath = join(dir, "rates.yaml");
      writeFileSync(pricingPath, o.pricing);
      pricingLine = `  pricingFile: ${pricingPath}\n`;
    }
    const worker = o.worker !== undefined || pricingLine !== "" ? `worker:\n${o.worker ? `  model: ${o.worker}\n` : ""}${pricingLine}` : "";
    const reviewer = o.reviewer !== undefined ? `reviewer:\n  mode: engine-agent\n  agent:\n    model: ${o.reviewer}\n` : "";
    writeFileSync(path, `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n${worker}${reviewer}`);
    return runCli(["node", "sapwood", "validate", path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RATE = (input: number, output: number) =>
  `    input: ${input}\n    output: ${output}\n    cacheWrite: ${input}\n    cacheRead: ${input / 10}\n    contextWindow: 200000\n`;

test("#582 validate: reviewer priced BELOW the worker ⇒ inversion warning, exit 0 (warning, never a failure)", () => {
  const r = validateWith({ worker: "opus", reviewer: "sonnet" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, REVIEWER_INVERSION);
  assert.match(r.stdout, /opus/); // names both sides so the operator can act on it
  assert.match(r.stdout, /sonnet/);
  assert.match(r.stdout, /sapwood validate: OK/); // still reports success
});

test("#582 validate: reviewer priced ABOVE the worker (the shipped default pair) ⇒ silent", () => {
  const r = validateWith();
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, REVIEWER_INVERSION);
  assert.equal(r.stderr, "");
});

test("#582 validate: EQUAL rates ⇒ silent (the ordering is 'at or above', not 'strictly above')", () => {
  const r = validateWith({
    worker: "alpha",
    reviewer: "beta",
    pricing: `models:\n  alpha:\n${RATE(5, 25)}  beta:\n${RATE(5, 25)}`,
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, REVIEWER_INVERSION);
});

test("#582 validate: either model ABSENT from the rate table ⇒ silent (no comparison to make — never the unknown-model most-expensive fallback)", () => {
  // Reviewer absent. resolveRate() would price it at the table's most expensive tier; the warning
  // deliberately uses a no-fallback lookup instead, so an unpriced model produces no verdict.
  const absentReviewer = validateWith({ worker: "opus", reviewer: "mythos-x" });
  assert.equal(absentReviewer.code, 0);
  assert.doesNotMatch(absentReviewer.stdout, REVIEWER_INVERSION);
  // Worker absent, reviewer priced — same silence, from the other side.
  const absentWorker = validateWith({ worker: "mythos-x", reviewer: "haiku" });
  assert.equal(absentWorker.code, 0);
  assert.doesNotMatch(absentWorker.stdout, REVIEWER_INVERSION);
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
  assert.deepEqual(
    preview.candidates.map((i) => i.number),
    [1, 2],
  );
  assert.equal(preview.perWorkerUsd, 5);
  assert.equal(preview.previewUsd, 10); // 2 x $5
  assert.equal(preview.dailyBudgetUsd, 40);
});

test("computeDryRunPreview: caps by min(roundDispatchCap, lanes.max) — max:1 + cap:2 + 2 ready => 1 candidate, cost for 1 (Codex PR #70 round-5 P2)", () => {
  const cfg = parseConfig(
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\n" + "lanes: { max: 1, roundDispatchCap: 2 }\nworker: { budgetUsdSoft: 8 }\n",
  );
  const ready: Issue[] = [
    { number: 1, title: "one", labels: [] },
    { number: 2, title: "two", labels: [] },
  ];
  const preview = computeDryRunPreview(ready, cfg);
  assert.equal(preview.dispatchableCount, 2);
  assert.equal(preview.effectiveLaneLimit, 1); // min(2, 1) — lanes.max is the binding limit
  assert.equal(preview.candidates.length, 1); // real loop stops at lanesUsed >= lanes.max
  assert.deepEqual(
    preview.candidates.map((i) => i.number),
    [1],
  );
  assert.equal(preview.previewUsd, 8); // 1 x $8, NOT 2 x $8
});

test("computeDryRunPreview: uses the REAL dispatch eligibility filter — reserve/needs-human/blocked/blocked-by issues never appear as candidates or spend (Codex PR #70 P2)", () => {
  const ready: Issue[] = [
    { number: 1, title: "held for human", labels: [baseCfg.labels.needsHuman] },
    { number: 2, title: "blocked", labels: [baseCfg.labels.blocked] },
    { number: 3, title: "reserve", labels: [baseCfg.labels.reserve] },
    { number: 4, title: "waiting on 9", labels: ["sapwood:blocked-by:9"] },
    { number: 5, title: "actually dispatchable", labels: [] },
  ];
  const preview = computeDryRunPreview(ready, baseCfg);
  assert.equal(preview.readyCount, 5);
  assert.equal(preview.dispatchableCount, 1);
  assert.deepEqual(
    preview.candidates.map((i) => i.number),
    [5],
  );
  assert.equal(preview.previewUsd, baseCfg.worker.budgetUsdSoft); // 1 candidate, not 5
});

test("computeDryRunPreview: candidates follow orderForDispatch's priority ordering, not board order", () => {
  const ready: Issue[] = [
    { number: 10, title: "default prio", labels: [] }, // prio 3 (no label)
    { number: 11, title: "urgent", labels: ["sapwood:prio:0"] },
  ];
  const preview = computeDryRunPreview(ready, baseCfg); // both ready issues are within the default cap
  assert.deepEqual(
    preview.candidates.map((i) => i.number),
    [11, 10],
  ); // configured-prefix prio:0 first
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
  writeFileSync(configPath, "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n");
  const seed = new State(dbPath);
  seed.upsertWorker({
    name: "lane-12-abcd",
    issue: 12,
    session_id: "s1",
    state: "running",
    started_at: "2026-07-06T10:00:00.000Z",
    ended_at: null,
  });
  seed.upsertWorker({
    name: "lane-9-efgh",
    issue: 9,
    session_id: "s2",
    state: "driving",
    started_at: "2026-07-05T09:00:00.000Z",
    ended_at: null,
    pr: 101,
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

test("status (#705): a real lane-spawned + worker-heartbeat ledger produces pid/worktree/heartbeat in BOTH the text and --json paths, and a dead pid on a running lane renders the text mismatch marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-anchors-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath);
  seed.upsertWorker({
    name: "lane-anchor-1",
    issue: 42,
    session_id: "s1",
    state: "running",
    started_at: "2026-08-06T00:00:00.000Z",
    ended_at: null,
  });
  // 999_999_999 — same "obviously dead" pid convention worker.test.ts's own adoption test uses.
  seed.appendEvent("lane-spawned", { worker: "lane-anchor-1", issue: 42, pid: 999_999_999, worktreePath: "/tmp/lane-anchor-1" });
  seed.appendEvent("worker-heartbeat", { worker: "lane-anchor-1", issue: 42, elapsedSec: 5 });
  seed.close();
  try {
    const textResult = runCli(["node", "sapwood", "status", dbPath]);
    assert.equal(textResult.code, 0);
    assert.match(textResult.stdout, /pid 999999999 \(DEAD\)/);
    assert.match(textResult.stdout, /worktree \/tmp\/lane-anchor-1/);
    // #705 gate② P1-2: id + ts + ageSec all render, not just the age.
    assert.match(textResult.stdout, /heartbeat #\d+ \S+ \(\d+s ago\)/);
    assert.match(textResult.stdout, /BELIEF-VS-REALITY MISMATCH/);

    const jsonResult = runCli(["node", "sapwood", "status", dbPath, "--json"]);
    assert.equal(jsonResult.code, 0);
    const body = JSON.parse(jsonResult.stdout);
    assert.equal(body.lanes.length, 1);
    assert.equal(body.lanes[0].pid, 999_999_999);
    assert.equal(body.lanes[0].pidAlive, false);
    assert.equal(body.lanes[0].worktreePath, "/tmp/lane-anchor-1");
    assert.equal(body.lanes[0].lastHeartbeat.id > 0, true);
    assert.equal(typeof body.lanes[0].lastHeartbeat.ageSec, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: no --config given and none found at the default probe names still prints DB-derived fields, config-derived fields shown as unknown, exit 0 (the best-effort no-flag case, unchanged by #710)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath);
  seed.close();
  try {
    const r = runCli(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0\/unknown active/);
    assert.match(r.stdout, /unknown \(no config found\) daily ceiling/);
    assert.match(r.stdout, /config: none found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status (#710): an EXPLICIT --config naming a missing file fails CLOSED — exit 1, clear error, never a silent degrade to 'unknown' fields the way an omitted --config does", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const missingConfig = join(dir, "does-not-exist.yaml");
  const seed = new State(dbPath);
  seed.close();
  try {
    const r = runCli(["node", "sapwood", "status", dbPath, "--config", missingConfig]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /sapwood status:/);
    assert.match(r.stderr, new RegExp(missingConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Never rendered the degraded/unknown text summary — a hard-fail config error must not also
    // print a (misleadingly complete-looking) DB snapshot.
    assert.doesNotMatch(r.stdout, /active/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status (#710): an EXPLICIT --config naming an INVALID config also fails closed, exit 1, with the ZodError issues (mirrors runValidate's own rendering)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const badConfig = join(dir, "bad.yaml");
  writeFileSync(badConfig, "board: { owner: acme, repo: widgets, projectNumber: -1 }\n"); // projectNumber must be positive
  const seed = new State(dbPath);
  seed.close();
  try {
    const r = runCli(["node", "sapwood", "status", dbPath, "--config", badConfig]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /sapwood status: invalid config:/);
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
    estopActive: false,
    pauseActive: false,
    ceilingBreach: { reasons: ["daily-budget", "kill-switch"], at: new Date("2026-07-07T00:00:00.000Z") },
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
  };
  const out = formatStatus(snapshot);
  assert.match(out, /kill switch: ACTIVE/);
  assert.match(out, /pause: inactive/);
  assert.match(out, /ceiling breach: daily-budget, kill-switch \(since 2026-07-07T00:00:00\.000Z\)/);
  assert.match(out, /park: inactive/);
});

// #723 AC3 audit: "status CLI text (if it renders an engine state word from the same read) stays
// consistent." It does not — formatStatus/StatusSnapshot report killSwitchActive/pauseActive/
// ceilingBreach/parked as separate booleans/rows, never an aggregated §8 EngineState word
// ("running"/"standby"/"stalled"/...), and never calls deriveEngineState/currentEngineState. So
// there is no second derivation here that could drift from the read-model.ts fix, and nothing to
// change — this test locks that finding: a future change that DOES teach formatStatus to render
// an aggregated engine word must update this test, which is the point (drift becomes visible).
test("#723 audit: formatStatus never renders an aggregated engine-state word — a healthy idle snapshot's text carries no 'stalled'/'standby'/'running' anywhere", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: 7,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
  };
  const out = formatStatus(snapshot);
  assert.doesNotMatch(out, /\bstalled\b/i);
  assert.doesNotMatch(out, /\bstandby\b/i);
});

test("formatStatus: PAUSE active renders distinctly from kill switch, both can be reported independently", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: 7,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: true,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
  };
  const out = formatStatus(snapshot);
  assert.match(out, /kill switch: inactive/);
  assert.match(out, /pause: PAUSED/);
});

// ── #705: per-lane runtime anchors — belief-vs-reality rendering ───────────────────────────

function laneAnchorsSnapshot(state: "running" | "fixing" | "driving", laneAnchors: Record<string, LaneAnchorsDTO>): StatusSnapshot {
  return {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [{ name: "lane-x", issue: 12, session_id: "s1", state, started_at: "2026-08-06T00:00:00.000Z", ended_at: null }],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
    laneAnchors,
  };
}

test("formatStatus (#705 AC3): a `running` lane whose pid is confirmed DEAD renders the belief-vs-reality mismatch marker", () => {
  const out = formatStatus(
    laneAnchorsSnapshot("running", { "lane-x": { pid: 999999, pidAlive: false, worktreePath: "/tmp/lane-x", lastHeartbeat: null } }),
  );
  assert.match(out, /pid 999999 \(DEAD\)/);
  assert.match(out, /BELIEF-VS-REALITY MISMATCH/);
});

test("formatStatus (#705): a `fixing` lane with a dead pid ALSO renders the mismatch — the predicate covers both in-flight states", () => {
  const out = formatStatus(
    laneAnchorsSnapshot("fixing", { "lane-x": { pid: 999999, pidAlive: false, worktreePath: "/tmp/lane-x", lastHeartbeat: null } }),
  );
  assert.match(out, /BELIEF-VS-REALITY MISMATCH/);
});

test("formatStatus (#705): a `driving` lane with a dead pid does NOT render the mismatch — the ledger never claimed it was in-flight", () => {
  const out = formatStatus(
    laneAnchorsSnapshot("driving", { "lane-x": { pid: 999999, pidAlive: false, worktreePath: "/tmp/lane-x", lastHeartbeat: null } }),
  );
  assert.doesNotMatch(out, /BELIEF-VS-REALITY MISMATCH/);
});

test("formatStatus (#705): a `running` lane with a LIVE pid renders normally, no mismatch marker", () => {
  const out = formatStatus(
    laneAnchorsSnapshot("running", { "lane-x": { pid: 4242, pidAlive: true, worktreePath: "/tmp/lane-x", lastHeartbeat: null } }),
  );
  assert.match(out, /pid 4242 \(alive\)/);
  assert.doesNotMatch(out, /BELIEF-VS-REALITY MISMATCH/);
});

test("formatStatus (#705): no laneAnchors entry for the lane at all (pre-#705 fixture / never-spawned-through-a-Supervisor lane) renders honest unknowns, never a thrown lookup or a fabricated dead", () => {
  const out = formatStatus(laneAnchorsSnapshot("running", {}));
  assert.match(out, /pid unknown/);
  assert.match(out, /worktree unknown/);
  assert.match(out, /no heartbeat yet/);
  assert.doesNotMatch(out, /BELIEF-VS-REALITY MISMATCH/);
});

test("formatStatus (#705): a heartbeat renders its age in seconds", () => {
  const out = formatStatus(
    laneAnchorsSnapshot("running", {
      "lane-x": {
        pid: 4242,
        pidAlive: true,
        worktreePath: "/tmp/lane-x",
        lastHeartbeat: { id: 7, ts: "2026-08-06T00:00:00.000Z", ageSec: 42 },
      },
    }),
  );
  // #705 gate② P1-2: id + ts + ageSec all render, not just the age.
  assert.match(out, /heartbeat #7 2026-08-06T00:00:00\.000Z \(42s ago\)/);
});

// ── #168: sapwood status surfaces the parked state ──────────────────────────────────────────

test("formatStatus: parked (llm) renders source/reason/duration/no-escalation", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [
      {
        source: "llm",
        reason: "rate_limit_error",
        triggerIssue: 42,
        enteredAt: "2026-07-14T00:00:00.000Z",
        lastProbeAt: "2026-07-14T00:00:00.000Z",
        probeAttempts: 0,
        escalatedAt: null,
        canaryWorker: null,
        resetHintAt: null,
      },
    ],
  };
  const out = formatStatus(snapshot);
  assert.match(out, /park: PARKED \(llm\) since 2026-07-14T00:00:00\.000Z/);
  assert.match(out, /reason: rate_limit_error/);
  assert.doesNotMatch(out, /escalated to a human/);
});

test("formatStatus: parked + escalated renders the escalation timestamp", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [
      {
        source: "forge",
        reason: "could not resolve host",
        triggerIssue: 7,
        enteredAt: "2026-07-14T00:00:00.000Z",
        lastProbeAt: "2026-07-14T00:05:00.000Z",
        probeAttempts: 4,
        escalatedAt: "2026-07-14T01:00:00.000Z",
        canaryWorker: null,
        resetHintAt: null,
      },
    ],
  };
  const out = formatStatus(snapshot);
  assert.match(out, /park: PARKED \(forge\)/);
  assert.match(out, /escalated to a human at 2026-07-14T01:00:00\.000Z/);
});

test("formatStatus: not parked -> 'park: inactive', clears once resumed", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
  };
  assert.match(formatStatus(snapshot), /park: inactive/);
});

test("formatStatus renders latest reconcile orphans and omits an absent/healthy report", () => {
  const base: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [],
  };
  assert.doesNotMatch(formatStatus(base), /orphans:/);
  assert.doesNotMatch(formatStatus({ ...base, orphanReport: { orphans: [], overflow: 0 } }), /orphans:/);
  const out = formatStatus({
    ...base,
    orphanReport: {
      orphans: [
        { kind: "issue", issue: 171, reason: "unplaced" },
        { kind: "pr", pr: 200, issue: 171, reason: "open-engine-pr" },
      ],
      overflow: 3,
    },
  });
  assert.match(out, /orphans: 5/);
  assert.match(out, /unplaced issue #171/);
  assert.match(out, /open engine PR #200 \(issue #171\)/);
  assert.match(out, /and 3 more/);
});

test("runStatus #237: reports the count of unadjudicated PO-dissent concerns — posted-without-adjudicated only, DB-only (no live GitHub call)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-concerns-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const state = new State(dbPath);
  state.appendEvent("concern-posted", { round_id: 1, issue: 42, reason: "premise seems wrong", hash: "abc" });
  state.appendEvent("concern-posted", { round_id: 1, issue: 7, reason: "contradicts a non-goal", hash: "def" });
  state.appendEvent("concern-adjudicated", { issue: 7, hash: "def", outcome: "closed" });
  state.close();
  try {
    // #710: no --config here (an explicit --config naming a missing file now fails closed,
    // exit 1 — see the dedicated fail-closed test above) — this test is about the concerns
    // count, not config resolution, so it relies on the ordinary no-config-found-anywhere probe.
    const result = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /PO-dissent concerns awaiting adjudication: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus sources orphans from the latest reconcile-completed event", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-orphans-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const state = new State(dbPath);
  state.appendEvent("reconcile-completed", {
    ok: true,
    count: 1,
    orphans: [{ kind: "issue", issue: 170, reason: "in-progress" }],
    overflow: 0,
  });
  state.appendEvent("reconcile-completed", {
    ok: true,
    count: 1,
    orphans: [{ kind: "pr", pr: 200, issue: 171, reason: "open-engine-pr" }],
    overflow: 0,
  });
  state.close();
  try {
    // #710: no --config here — see the comment on the #237 test above for why.
    const result = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /open engine PR #200/);
    assert.doesNotMatch(result.stdout, /issue #170/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatStatus: a mixed storm renders BOTH episodes (one line per source), canary lane shown when in flight (#168 P1-1a)", () => {
  const snapshot: StatusSnapshot = {
    dbPath: "data/sapwood.sqlite",
    schemaVersion: SCHEMA_VERSION,
    active: [],
    driving: [],
    killSwitchActive: false,
    estopActive: false,
    pauseActive: false,
    ceilingBreach: null,
    dailySpendUsd: 0,
    lanesMax: 3,
    dailyBudgetUsd: 100,
    unadjudicatedConcerns: 0,
    baseCiRed: null,
    parked: [
      {
        source: "llm",
        reason: "rate_limit_error",
        triggerIssue: 42,
        enteredAt: "2026-07-14T00:00:00.000Z",
        lastProbeAt: "2026-07-14T00:05:00.000Z",
        probeAttempts: 2,
        escalatedAt: null,
        canaryWorker: "lane-3",
        resetHintAt: null,
      },
      {
        source: "forge",
        reason: "could not resolve host",
        triggerIssue: 7,
        enteredAt: "2026-07-14T00:10:00.000Z",
        lastProbeAt: "2026-07-14T00:10:00.000Z",
        probeAttempts: 0,
        escalatedAt: null,
        canaryWorker: null,
        resetHintAt: null,
      },
    ],
  };
  const out = formatStatus(snapshot);
  assert.match(out, /park: PARKED \(llm\)/);
  assert.match(out, /park: PARKED \(forge\)/);
  assert.match(out, /canary lane lane-3 in flight/);
});

test("runStatus: reports a live parked state read straight off the DB, and clears once resumed (#168)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-park-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath);
  seed.enterPark("forge", "could not resolve host", 42, "2026-07-14T00:00:00.000Z");
  seed.close();
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /park: PARKED \(forge\)/);
    assert.match(r.stdout, /reason: could not resolve host/);

    // Resume (a probe would normally do this) — status must reflect it on the very next read.
    const s2 = new State(dbPath);
    s2.clearPark("forge");
    s2.close();
    const r2 = runStatus(["node", "sapwood", "status", dbPath]);
    assert.match(r2.stdout, /park: inactive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    name: "lane-1-ro",
    issue: 1,
    session_id: "s1",
    state: "running",
    started_at: "2026-07-07T09:00:00.000Z",
    ended_at: null,
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
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
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
    name: "lane-1-wal",
    issue: 1,
    session_id: "s1",
    state: "running",
    started_at: "2026-07-07T09:00:00.000Z",
    ended_at: null,
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
    name: "lane-42-live",
    issue: 42,
    session_id: "s-live",
    state: "running",
    started_at: "2026-07-08T09:00:00.000Z",
    ended_at: null,
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

test("status: DB schema OLDER than this engine -> clear 'run the engine to migrate' message, exit 1, still not migrated by status (#710 gate② P2-3: the TEXT refusal also pins the degraded schema-independent read — schema versions AND event count/max id, not just the refusal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-status-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const seed = new State(dbPath);
  // #710: seed a few events so count/maxId are non-trivial — proves the TEXT refusal line
  // actually reflects the ledger, not just a hardcoded 0/0.
  seed.appendEvent("dispatched", { issue: 1 });
  seed.appendEvent("dispatched", { issue: 2 });
  seed.appendEvent("merged", { pr: 10 });
  seed.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  try {
    const r = runStatus(["node", "sapwood", "status", dbPath]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /DB schema v1.*older.*status never migrates/);
    assert.match(r.stderr, new RegExp(`engine schema v${SCHEMA_VERSION}`));
    // #710 gate② P2-3: the degraded schema-independent read — both schema versions were already
    // asserted above; this pins the raw event count/max id ALSO present in the same text line.
    assert.match(r.stderr, /3 event\(s\) in the ledger, max id 3/);
    // status must have left the old version exactly as it found it.
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #253: buildTickFixLegResume — the tick driver's TickDeps.fixLegResume construction ─────

function fakeProxyForgeForCli(): ProxyForge {
  return {
    getIssueMeta: async () => ({ number: 1, title: "t", state: "OPEN", labels: [], updatedAt: "2026-07-17T00:00:00Z" }),
    getIssueBody: async () => "",
    getIssueComments: async () => [],
    getIssueRelations: async () => ({ linkedPRs: [], crossReferences: [], truncated: false }),
    searchIssues: async () => [],
    getPRDetails: async () => ({
      number: 1,
      headOid: "abc",
      baseRefName: "main",
      state: "OPEN" as const,
      draft: false,
      labels: [],
      mergeable: "MERGEABLE" as const,
    }),
    getPRReviews: async () => ({ reviews: [], total: 0 }),
    getPRReviewThreads: async () => ({
      threads: [{ id: "T1", isResolved: false, comments: [], commentsComplete: true }],
      pageCapped: false,
    }),
    getPRChecks: async () => ({ checks: [], total: 0 }),
    getPRComments: async () => ({ comments: [], total: 0 }),
  };
}

test("buildTickFixLegResume (#253, #551): cfg.proxy.enabled: false (explicit opt-out) -> undefined — fixLegResume stays entirely unset (no handle, no listener, no journal write, no argv change)", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" }, proxy: { enabled: false } });
  const state = new State(":memory:");
  try {
    const forge = fakeProxyForgeForCli() as unknown as IForge;
    const result = buildTickFixLegResume(cfg, forge, state, (i, p) => `fix #${i} for PR #${p}`, realClock);
    assert.equal(result, undefined);
  } finally {
    state.close();
  }
});

test("buildTickFixLegResume (#551): cfg.proxy.enabled: true (the DEFAULT — nothing set) -> a real fixLegResume whose mintProxy carries round 0 / phase 'tick' as its fixed audit identity", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" } });
  assert.equal(cfg.proxy.enabled, true, "#551: proxy.enabled defaults to true with nothing set");
  const state = new State(":memory:");
  try {
    const forge = fakeProxyForgeForCli() as unknown as IForge;
    const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
    const result = buildTickFixLegResume(cfg, forge, state, renderFixPrompt, realClock);
    assert.ok(result, "expected a real fixLegResume under the new default");
    const handle = await result.mintProxy({ role: "worker", session: "lane-default-abc" });
    try {
      assert.ok(handle.url, "a real handle carries a real URL");
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
});

test("buildTickFixLegResume (#253): cfg.proxy.enabled: true -> a real fixLegResume whose mintProxy carries round 0 / phase 'tick' as its fixed audit identity", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" },
    proxy: { enabled: true },
  });
  const state = new State(":memory:");
  try {
    const forge = fakeProxyForgeForCli() as unknown as IForge;
    const renderFixPrompt = (issueNumber: number, pr: number): string => `fix #${issueNumber} for PR #${pr}`;
    const result = buildTickFixLegResume(cfg, forge, state, renderFixPrompt, realClock);
    assert.ok(result, "expected a real fixLegResume");
    assert.equal(result.renderFixPrompt(3, 4), "fix #3 for PR #4");
    const handle = await result.mintProxy({ role: "worker", session: "lane-7-abc" });
    try {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "pr_review_threads", arguments: { pr: 1 } },
        }),
      });
      const json = (await res.json()) as { result: { isError: boolean } };
      assert.equal(json.result.isError, false);
      const rows = state.listForgeProxyJournal({ roundId: 0, phase: "tick", role: "worker", session: "lane-7-abc", attempt: 1 });
      assert.equal(rows.length, 1, "round 0 / phase 'tick' is this driver's fixed audit identity — proof it was actually threaded through");
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #504: the tick summary line counts ACTIONS on the events' transition-dedupe basis, not raw
// per-tick evaluations. The dogfood run that motivated this logged `reclaimed=3 dispatched=2
// driven=3` every tick for 1.5h while the event stream recorded zero actions — "kept" reclaims,
// "skipped" dispatches, and steady-state "queued" drives are no-ops and must read as zeros.
// ─────────────────────────────────────────────────────────────────────────────

test("formatTickSummary (#504): kept/skipped/queued steady-state no-ops count as zero", () => {
  const line = formatTickSummary({
    reclaimed: [
      { kind: "kept", worker: "lane-a", issue: 1 },
      { kind: "kept", worker: "lane-b", issue: 2 },
      { kind: "kept", worker: "lane-c", issue: 3 },
    ],
    fixingReclaimed: [{ kind: "kept", worker: "lane-d", issue: 4 }],
    dispatched: [
      { kind: "skipped", issue: 5, reason: "cap" },
      { kind: "skipped", issue: 6, reason: "in-flight" },
    ],
    driven: [
      { kind: "queued", worker: "lane-a", issue: 1, pr: 11, reason: "gate-pending:WAIT_REVIEW" },
      { kind: "queued", worker: "lane-b", issue: 2, pr: 12, reason: "gate-pending:WAIT_REVIEW" },
      { kind: "queued", worker: "lane-c", issue: 3, pr: 13, reason: "gate-pending:WAIT_REVIEW" },
    ],
    resumed: [],
    rollbacks: [],
    fixResponses: [],
    gatedReclaimed: [],
    drainRequested: [],
    escalated: [],
    overBudget: false,
    ceilingBreached: false,
    ceilingReasons: [],
  });
  assert.equal(
    line,
    "[sapwood:tick] reclaimed=0 fixingReclaimed=0 dispatched=0 driven=0 resumed=0 " +
      "rollbacks=0 fixResponses=0 gatedReclaimed=0 drainRequested=0 escalated=0 ceilingBreached=false",
  );
});

test("formatTickSummary (#504): real actions still count", () => {
  const line = formatTickSummary({
    reclaimed: [
      { kind: "kept", worker: "lane-a", issue: 1 },
      { kind: "done", worker: "lane-b", issue: 2, next: "DRIVING", costUsd: 0, modelUsage: [] },
    ],
    fixingReclaimed: [],
    dispatched: [
      { kind: "dispatched", issue: 5, worker: "lane-e" },
      { kind: "skipped", issue: 6, reason: "cap" },
    ],
    driven: [
      { kind: "queued", worker: "lane-a", issue: 1, pr: 11, reason: "gate-pending:WAIT_REVIEW" },
      { kind: "merged", worker: "lane-b", issue: 2, pr: 12 },
    ],
    resumed: [],
    rollbacks: [],
    fixResponses: [],
    gatedReclaimed: [],
    drainRequested: [],
    escalated: [],
    overBudget: false,
    ceilingBreached: false,
    ceilingReasons: [],
  });
  assert.match(line, /reclaimed=1 /);
  assert.match(line, /dispatched=1 /);
  assert.match(line, /driven=1 /);
});
