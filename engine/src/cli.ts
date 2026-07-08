#!/usr/bin/env node
// `sapwood` CLI. M0.5 shipped `init`; `run` (the M4 loop driver, #46) and `validate` (#49)
// landed next; `status` + `run --dry-run` (#15) land here. The plugin's slash commands
// (/sapwood-run, /sapwood-status, /sapwood-stop) are thin wrappers that shell out to this CLI
// — see ../../commands/.
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadConfig, DEFAULT_CONFIG_PATHS, type SapwoodConfig } from "./config.js";
import { init, InitError } from "./init.js";
import { State, SCHEMA_VERSION, type WorkerRow } from "./state.js";
import { GithubForge, type Issue } from "./forge.js";
import { WorkerSupervisor, buildRenderPrompt } from "./worker.js";
import { makeReviewer, makeFallbackReviewers } from "./reviewer.js";
import { MergeDriver } from "./merge-driver.js";
import { runDriver, type StopMode, type DriverResult } from "./driver.js";
import { orderForDispatch } from "./conductor.js";

const require = createRequire(import.meta.url);
// ponytail: runtime require avoids JSON-import assertion syntax differences across Node versions
const { version } = require("../package.json") as { version: string };

const USAGE = `\
usage: sapwood <command> [options]

Commands:
  init          Scaffold .sapwood config and verify GitHub auth
  run           Run the engine loop (tick on a fixed cadence)
    --once         Run exactly one tick, then exit (exit 1 if the tick failed)
    --until-idle   Keep ticking until no lanes are in flight, then exit
    --dry-run      Preview what would be dispatched + a cost estimate, then exit
                   (no worker spawned, no state written)
  status [db-path]  Read engine state straight from SQLite (no live session needed)
  validate [path]  Load + validate a sapwood config file, report OK or the issues

Flags:
  --version, -v  Print version and exit
  --help, -h     Print this help and exit
`;

const VALIDATE_USAGE = `\
usage: sapwood validate [path]

Load a sapwood config (defaults to the same probe order as init/run:
${DEFAULT_CONFIG_PATHS.join(", ")}), validate it, and report:
  - valid   -> a one-line OK summary (path + key effective values), exit 0
  - invalid -> the validation issues, one per line, exit 1
  - missing -> a clear error naming the path tried, exit 1

Flags:
  --help, -h     Print this help and exit
`;

const RUN_USAGE = `\
usage: sapwood run [--once | --until-idle | --dry-run]

Run the engine loop: tick (reclaim -> drive -> dispatch) on cfg.engine.tickIntervalSec's cadence.

Flags:
  --once         Run exactly one tick, then exit (exit 1 if the tick attempt failed)
  --until-idle   Keep ticking until no lanes are in flight and nothing dispatches, then exit
  --dry-run      Resolve config, list the ready issues that WOULD be dispatched this round
                 and a cost preview (per-worker soft budget x candidate count, daily
                 ceiling), then exit. Never spawns a worker or writes state — the
                 first-run trust ramp's "see before you run" step.
  --help, -h     Print this help and exit
`;

/** Run-subcommand flags the engine path accepts. Anything else must be rejected BEFORE the
 *  engine starts — `sapwood run --bogus` silently starting a daemon that claims issues and
 *  dispatches workers is the exact failure Codex PR #50 flagged (thread on cli.ts:46). */
const RUN_FLAGS = ["--once", "--until-idle", "--dry-run"] as const;

const STATUS_USAGE = `\
usage: sapwood status [db-path]

Read the engine's SQLite state DB directly (no live engine session required) and print
a human-readable summary: active lanes/workers, PRs awaiting the review gate, spend vs
the daily ceiling, and kill-switch state.

Defaults to data/sapwood.sqlite (the same path \`sapwood run\` writes to). Also loads the
sapwood config (same default probe order as \`validate\`) for lanes.max and the daily cost
ceiling; a missing config still prints every DB-derived field, with the config-derived
ones shown as "unknown".

Flags:
  --config <path>  Load config from this path instead of probing the defaults
  --help, -h       Print this help and exit
`;

/** `sapwood validate [path]`: reuses config.ts's own loader (no parsing duplicated here) —
 *  ZodError -> issues one per line, exit 1; anything else (missing/unreadable file, already
 *  naming the path per Node's own ENOENT message, or loadConfig's own "no config found"
 *  message) -> exit 1; success -> one-line OK summary. Fully synchronous (loadConfig is sync
 *  fs + Zod), so unlike init/run it never needs the async engine-wiring fallthrough. */
export function runValidate(argv: string[]): { stdout: string; stderr: string; code: number } {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { stdout: VALIDATE_USAGE, stderr: "", code: 0 };
  }
  const path = args[0];
  try {
    const cfg = loadConfig(path);
    const resolvedPath = path ?? DEFAULT_CONFIG_PATHS.find(existsSync);
    return {
      stdout: `sapwood validate: OK — ${resolvedPath} (lanes.max=${cfg.lanes.max}, guard.mode=${cfg.guard.mode}, merge.mode=${cfg.merge.mode})\n`,
      stderr: "",
      code: 0,
    };
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      return { stdout: "", stderr: `sapwood validate: invalid config:\n${issues}\n`, code: 1 };
    }
    return { stdout: "", stderr: `sapwood validate: ${(e as Error).message}\n`, code: 1 };
  }
}

// ── #15: `sapwood run --dry-run` — cost preview, no dispatch ────────────────────────────────

/** Preview data for `sapwood run --dry-run`. Candidates go through the REAL dispatch
 *  eligibility filter + ordering (conductor.ts orderForDispatch: drops reserve /
 *  needs-human/blocked / blocked-by issues, sorts by priority) — an issue the engine would
 *  never dispatch must never appear in the trust-ramp preview as spend (Codex PR #70 P2).
 *  Candidates are then bounded by the SAME effective per-round lane limit the real dispatch
 *  loop enforces: min(cfg.lanes.roundDispatchCap, cfg.lanes.max) — the real loop stops
 *  dispatching both at roundDispatchCap AND at lanesUsed >= lanes.max, so with e.g. max:1 /
 *  cap:2 only ONE worker can start and the preview must say so, not two (Codex PR #70
 *  round-5 P2). The preview assumes an empty lane set (a fresh round — the first-run
 *  trust-ramp context); it doesn't read live occupancy, in-flight dedup, or the meta-floor
 *  anti-starvation accounting, which need engine state a dry run deliberately doesn't touch,
 *  so it stays a rough upper bound, not a replay of the exact next tick. */
export interface DryRunPreview {
  readyCount: number;
  /** After orderForDispatch's eligibility filter — the pool candidates are drawn from. */
  dispatchableCount: number;
  /** min(roundDispatchCap, lanes.max) — the effective per-round dispatch limit applied. */
  effectiveLaneLimit: number;
  candidates: Issue[];
  perWorkerUsd: number;
  previewUsd: number;
  dailyBudgetUsd: number;
}

/** Pure: no forge/network access, so this is fully unit-testable without mocking `gh`. */
export function computeDryRunPreview(ready: Issue[], cfg: SapwoodConfig): DryRunPreview {
  const dispatchable = orderForDispatch(ready, cfg);
  const effectiveLaneLimit = Math.min(cfg.lanes.roundDispatchCap, cfg.lanes.max);
  const candidates = dispatchable.slice(0, effectiveLaneLimit);
  const perWorkerUsd = cfg.worker.budgetUsdSoft;
  return {
    readyCount: ready.length,
    dispatchableCount: dispatchable.length,
    effectiveLaneLimit,
    candidates,
    perWorkerUsd,
    previewUsd: perWorkerUsd * candidates.length,
    dailyBudgetUsd: cfg.cost.dailyBudgetUsd,
  };
}

export function formatDryRunPreview(preview: DryRunPreview): string {
  const lines = [
    `sapwood run --dry-run: ${preview.readyCount} ready issue(s), ` +
      `${preview.dispatchableCount} dispatchable, ${preview.candidates.length} candidate(s) this round`,
    ...preview.candidates.map((i) => `  would dispatch: #${i.number} ${i.title}`),
    `sapwood run --dry-run: cost preview ~$${preview.previewUsd.toFixed(2)} ` +
      `(${preview.candidates.length} x $${preview.perWorkerUsd.toFixed(2)} soft budget/worker), ` +
      `daily ceiling $${preview.dailyBudgetUsd.toFixed(2)}`,
    "sapwood run --dry-run: no worker dispatched, no state written.",
  ];
  return lines.join("\n") + "\n";
}

async function runDryRun(): Promise<number> {
  const cfg = loadConfig();
  // Same fail-fast the real run does (#74): a broken worker.promptFile must surface in the
  // preview too — dry-run exists to predict the real run, not to green-light a config the
  // real run would reject at startup. Renderer is discarded; only validation matters here.
  buildRenderPrompt(cfg);
  const forge = new GithubForge(cfg);
  const preview = computeDryRunPreview(await forge.getReadyIssues(), cfg);
  process.stdout.write(formatDryRunPreview(preview));
  return 0;
}

// ── #15: `sapwood status` — read the state DB with no live engine session ──────────────────

/** Parsed `sapwood status` args. Pure (no I/O) so the flag/positional handling is unit-testable
 *  on its own, same split as parseRunStopMode/runCli above. Flat shape (not a discriminated
 *  union) — `help`/`error` are just checked in order by the caller, same as runValidate does. */
export interface StatusArgs {
  help: boolean;
  error?: string | undefined;
  dbPath: string;
  configPath?: string | undefined;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, dbPath: "data/sapwood.sqlite" };
  }
  const positionals: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") {
      // Value-taking flag: the operand must exist and not be another flag — `--config` at the
      // end of the line (silently loading the DEFAULT config) or `--config --bogus` (silently
      // consuming the flag as a "path") would both report status from the wrong config with
      // exit 0 (Codex PR #70 P2). Fail closed instead.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { help: false, error: "--config requires a path", dbPath: "data/sapwood.sqlite" };
      }
      configPath = next;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { help: false, error: `unknown flag: ${a}`, dbPath: "data/sapwood.sqlite" };
    }
    positionals.push(a);
  }
  return { help: false, dbPath: positionals[0] ?? "data/sapwood.sqlite", configPath };
}

/** Everything `sapwood status` reports, gathered from the DB (+ config, best-effort) — kept
 *  separate from the DB/config I/O so the actual rendering (formatStatus) is unit-testable
 *  against hand-built snapshots without a real SQLite file. */
export interface StatusSnapshot {
  dbPath: string;
  schemaVersion: number;
  active: WorkerRow[]; // running + driving (occupied lanes)
  driving: WorkerRow[]; // driving lanes: PRs awaiting the review gate
  killSwitchActive: boolean;
  ceilingBreach: { reasons: string[]; at: Date } | null;
  dailySpendUsd: number;
  /** null when no config could be loaded — reported as "unknown", never a fabricated default. */
  lanesMax: number | null;
  dailyBudgetUsd: number | null;
}

export function formatStatus(s: StatusSnapshot): string {
  const running = s.active.filter((w) => w.state === "running");
  const lines: string[] = [
    `sapwood status — ${s.dbPath} (schema v${s.schemaVersion})`,
    "",
    `lanes: ${s.active.length}/${s.lanesMax ?? "unknown"} active ` +
      `(${running.length} running, ${s.driving.length} driving)`,
  ];
  for (const w of s.active) {
    const pr = w.pr ? `  PR #${w.pr}` : "";
    lines.push(`  ${w.state.padEnd(8)} ${w.name}   issue #${w.issue}${pr}   started ${w.started_at}`);
  }
  lines.push("", `gated PRs (awaiting review gate): ${s.driving.length}`);
  for (const w of s.driving) {
    lines.push(`  PR #${w.pr ?? "?"}  issue #${w.issue}  lane ${w.name}`);
  }
  const dailyBudget = s.dailyBudgetUsd != null ? `$${s.dailyBudgetUsd.toFixed(2)}` : "unknown (no config found)";
  lines.push(
    "",
    `spend: $${s.dailySpendUsd.toFixed(2)} / ${dailyBudget} daily ceiling`,
    `kill switch: ${s.killSwitchActive ? "ACTIVE" : "inactive"}`,
    s.ceilingBreach
      ? `ceiling breach: ${s.ceilingBreach.reasons.join(", ")} (since ${s.ceilingBreach.at.toISOString()})`
      : "ceiling breach: none",
  );
  return lines.join("\n") + "\n";
}

/** Fully synchronous (node:sqlite's DatabaseSync + loadConfig are both sync) — like `validate`,
 *  no async engine-wiring fallthrough needed. Never creates a DB: a missing file means "the
 *  engine has never run here", reported as such, NOT silently initialized by opening a fresh
 *  State() (which would create data/ + an empty schema as a side effect of just checking status).
 *
 *  The DB is opened TRULY read-only (Codex PR #70 P2): SQLITE_OPEN_READONLY, no migrations,
 *  no journal-mode switch — status must never mutate/upgrade a DB an engine process (possibly
 *  an older engine) is still using. A schema version this engine's queries don't understand —
 *  newer OR older — is reported as a clear message instead of migrated over. */
export function runStatus(argv: string[]): { stdout: string; stderr: string; code: number } {
  const parsed = parseStatusArgs(argv);
  if (parsed.help) return { stdout: STATUS_USAGE, stderr: "", code: 0 };
  if (parsed.error) {
    return { stdout: "", stderr: `sapwood status: ${parsed.error}\n\n${STATUS_USAGE}`, code: 1 };
  }
  const { dbPath, configPath } = parsed;
  if (!existsSync(dbPath)) {
    return { stdout: `sapwood status: no state DB at ${dbPath} — engine has never run\n`, stderr: "", code: 0 };
  }
  let cfg: SapwoodConfig | undefined;
  try {
    cfg = loadConfig(configPath);
  } catch {
    cfg = undefined; // reported as "unknown" fields, never fatal — the DB read is the point
  }
  const state = new State(dbPath, { readOnly: true });
  try {
    const dbVersion = state.userVersion();
    if (dbVersion !== SCHEMA_VERSION) {
      const hint =
        dbVersion > SCHEMA_VERSION
          ? "newer than this sapwood understands — upgrade sapwood"
          : "older than this sapwood — run the engine (sapwood run) to migrate it; status never migrates";
      return {
        stdout: "",
        stderr: `sapwood status: DB schema v${dbVersion} at ${dbPath} is ${hint} (engine schema v${SCHEMA_VERSION})\n`,
        code: 1,
      };
    }
    const snapshot: StatusSnapshot = {
      dbPath,
      schemaVersion: dbVersion,
      active: state.activeWorkers(),
      driving: state.drivingWorkers(),
      killSwitchActive: state.isKillSwitchActive(),
      ceilingBreach: state.ceilingBreach(),
      dailySpendUsd: state.dailySpendUsd(new Date()),
      lanesMax: cfg?.lanes.max ?? null,
      dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
    };
    return { stdout: formatStatus(snapshot), stderr: "", code: 0 };
  } finally {
    state.close();
  }
}

export function runCli(argv: string[]): { stdout: string; stderr: string; code: number } {
  const arg = argv[2];
  if (arg === "--version" || arg === "-v") {
    return { stdout: version + "\n", stderr: "", code: 0 };
  }
  if (arg === "--help" || arg === "-h" || arg === undefined) {
    return { stdout: USAGE, stderr: "", code: 0 };
  }
  if (arg === "validate") {
    return runValidate(argv);
  }
  if (arg === "status") {
    return runStatus(argv);
  }
  if (arg !== "init" && arg !== "run") {
    return { stdout: "", stderr: USAGE, code: 2 };
  }
  if (arg === "run") {
    const flags = argv.slice(3);
    // Help is a help request, never an engine start (Codex PR #50, cli.ts:46 thread).
    if (flags.includes("--help") || flags.includes("-h")) {
      return { stdout: RUN_USAGE, stderr: "", code: 0 };
    }
    // Unknown flags fail closed: error + usage, exit 1 — never silently ignored by a daemon
    // that goes on to claim issues.
    const unknown = flags.filter((f) => !(RUN_FLAGS as readonly string[]).includes(f));
    if (unknown.length > 0) {
      return { stdout: "", stderr: `sapwood run: unknown flag(s): ${unknown.join(" ")}\n\n${RUN_USAGE}`, code: 1 };
    }
    // --dry-run is a standalone preview mode — combining it with a real stop mode is almost
    // certainly a mistake (which one did the caller mean?), so reject rather than silently
    // picking one (same fail-closed stance as the unknown-flag check above).
    if (flags.includes("--dry-run") && (flags.includes("--once") || flags.includes("--until-idle"))) {
      return {
        stdout: "",
        stderr: `sapwood run: --dry-run cannot combine with --once/--until-idle\n\n${RUN_USAGE}`,
        code: 1,
      };
    }
  }
  // "init"/"run [valid flags]" fall through to the async path — signal caller to proceed
  return { stdout: "", stderr: "", code: -1 };
}

/** --once / --until-idle are mutually exclusive; anything else -> the daemon default. Kept as
 *  a pure parse, separate from the engine wiring below, so the flag logic is unit-testable.
 *  Flag VALIDATION (help / unknown-flag rejection) happens earlier, in runCli — by the time
 *  this runs, only known flags remain. */
export function parseRunStopMode(argv: string[]): StopMode {
  if (argv.includes("--once")) return "once";
  if (argv.includes("--until-idle")) return "until-idle";
  return "forever";
}

/** Exit code for a finished `sapwood run` (Codex PR #50, cli.ts:82 thread): a `--once`
 *  invocation whose single attempt produced ONLY tick errors (ticks === 0 && tickErrors > 0)
 *  exits 1 — cron/scripts must see a failed one-shot as a failure, and unlike daemon mode
 *  there is no later tick to retry. Daemon/until-idle runs exit 0 regardless of tickErrors:
 *  contained errors there are the retry design working (surfaced via tick-error events +
 *  the tickErrors count in the stop line), not a terminal failure. Pure + exported for tests. */
export function runExitCode(result: Pick<DriverResult, "ticks" | "tickErrors">, stopMode: StopMode): number {
  return stopMode === "once" && result.ticks === 0 && result.tickErrors > 0 ? 1 : 0;
}

async function runEngine(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  // #74: build the worker-prompt renderer NOW, before anything else — loadWorkerPromptTemplate
  // (inside buildRenderPrompt) reads the template file EAGERLY, so a configured
  // `worker.promptFile` that's missing/unreadable throws here and aborts startup. Never a lazy
  // load deferred to first dispatch: that would let the engine claim issues / churn ticks before
  // failing, instead of a clean fail-fast with no dispatch ever happening.
  const renderPrompt = buildRenderPrompt(cfg);
  const state = new State();
  const forge = new GithubForge(cfg);
  const reviewer = makeReviewer(cfg);
  // #54: the ordered reviewer-failover chain (cfg.reviewer.fallback) — empty by default, in
  // which case MergeDriver.driveOne behaves exactly as before this existed.
  const fallbackReviewers = makeFallbackReviewers(cfg);
  const mergeGate = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers });
  const supervisor = new WorkerSupervisor({
    cfg,
    // #46: a first-pass live findOpenPr wiring (GithubForge.findOpenPrForIssue) — see its
    // doc comment for the heuristic and its known limits; hardening it is part of the live
    // merge-gate run (#46 scope 3), not this PR.
    hasOpenPr: async (issue) => (await forge.findOpenPrForIssue(issue)) != null,
    findOpenPr: (issue) => forge.findOpenPrForIssue(issue),
    renderPrompt,
  });
  const stopMode = parseRunStopMode(argv);
  console.log(`sapwood run: tickIntervalSec=${cfg.engine.tickIntervalSec} stopMode=${stopMode}`);
  // NOTE: roundSpendUsd (the per-round hard budget gate, cfg.cost.roundBudgetUsd) is left at
  // its TickDeps default (0, i.e. never over-budget) — computing a live "this round's spend"
  // figure needs a round-tracking concept (nextRoundId exists as a pure helper but nothing
  // wires it to a live round yet) that predates this PR and isn't part of #46's scope. The
  // engine-wide daily/wall-clock/kill-switch ceiling (cfg.cost.dailyBudgetUsd /
  // maxWallClockSec / KILL_SWITCH) is fully live regardless — that's the actual hard safety
  // boundary; roundBudgetUsd is a softer per-round throttle.
  const result = await runDriver({ forge, state, supervisor, cfg, mergeGate, tickIntervalSec: cfg.engine.tickIntervalSec, stopMode });
  console.log(
    `sapwood run: stopped after ${result.ticks} tick(s), ${result.tickErrors} tick error(s) (${result.stoppedBy})`,
  );
  return runExitCode(result, stopMode);
}

async function main(argv: string[]): Promise<number> {
  const { stdout, stderr, code } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== -1) return code;

  if (argv[2] === "run") {
    // Validated above (runCli's run-flag block) — a bare presence check is safe here.
    if (argv.slice(3).includes("--dry-run")) return runDryRun();
    return runEngine(argv);
  }

  try {
    const { actions } = await init(loadConfig());
    for (const a of actions) console.log("•", a);
    console.log("init complete.");
    return 0;
  } catch (e) {
    // Expected, actionable failures (auth/scope) print clean; bugs still throw.
    if (e instanceof InitError) {
      console.error("init failed:", e.message);
      return 1;
    }
    throw e;
  }
}

// Run only when invoked directly (not when imported by tests) — importing this module for
// `runCli` must not execute main()/process.exit and cut off a test subprocess (Codex PR #36).
// Compare REALPATHS: when installed, `sapwood` is invoked via a bin symlink
// (node_modules/.bin/sapwood), so argv[1] is the symlink while import.meta.url is the real
// dist/cli.js — a raw string compare would be false and the CLI would never run (Codex PR #36).
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
