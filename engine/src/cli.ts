#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
// `sapwood` CLI. M0.5 shipped `init`; `run` (the M4 loop driver, #46) and `validate` (#49)
// landed next; `status` + `run --dry-run` (#15) land here. The plugin's slash commands
// (/sapwood-run, /sapwood-status, /sapwood-stop) are thin wrappers that shell out to this CLI
// — see ../../commands/.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { configHash, DEFAULT_CONFIG_PATHS, dashboardConfigSubset, loadConfig, type SapwoodConfig } from "./config/config.js";
import { loadPricingTable } from "./config/pricing.js";
import {
  associateLanePr,
  GithubForge,
  type IForge,
  type Issue,
  type LanePrForge,
  type LanePrOutcome,
  type LanePrRequest,
} from "./forge/forge.js";
import { type BaseRedPin, baseRedPin } from "./loop/base-ci.js";
import { type FixLegResumeDeps, orderForDispatch, type TickResult } from "./loop/conductor.js";
import { unadjudicatedConcerns } from "./loop/dissent.js";
import { type DriverResult, runDriver, type StopConditionHit, type StopConfig, type StopMode } from "./loop/driver.js";
import { InitError, init, requiredLabels } from "./loop/init.js";
import { acquireInstanceLock } from "./loop/instance-lock.js";
import { type EngineLogger, FileEngineLogger } from "./loop/logger.js";
import { clearParksReceiptFirst } from "./loop/park-clear.js";
import { detectRapidRestart } from "./loop/rapid-restart.js";
import {
  auditGatedEscalationFlags,
  parseReconcileCompleted,
  reconcileStartup,
  reviveEnvFailedPrLanes,
  type StartupOrphan,
  sweepStaleRoleSessions,
} from "./loop/reconcile.js";
import { type PeripheralPhase, type RoundStopHit, type RoundsResult, runRounds } from "./loop/round.js";
import { createDefaultPeripherals } from "./loop/round-defaults.js";
import { detectConsecutiveStalls } from "./loop/stall-breaker.js";
import { createProxyMint } from "./proxy/mint.js";
import { makeProductionEngineAgent } from "./review/production.js";
import { MergeDriver } from "./roles/merge-driver.js";
import { RoleRunner, type RoleRunnerDeps } from "./roles/peripheral.js";
import { makeFallbackReviewers, makeReviewer } from "./roles/reviewer.js";
import { buildRenderFixPrompt, buildRenderPrompt, discoverClaudeBin, probeLlmPing, WorkerSupervisor } from "./roles/worker.js";
import {
  DEFAULT_DB_PATH,
  INSTANCE_LOCK_FILENAME,
  PARK_SOURCES,
  type ParkRow,
  type ParkSource,
  SCHEMA_VERSION,
  State,
  type WorkerRow,
} from "./state/state.js";

const require = createRequire(import.meta.url);
// ponytail: runtime require avoids JSON-import assertion syntax differences across Node versions
const { version } = require("../package.json") as { version: string };

/** #403 (F25): the ONE place the real wall clock enters the engine's production wiring. Every
 *  module's `now` dependency is REQUIRED, not optional — so a fixture that seeds a date cannot
 *  silently fall back to the real clock (the compiler refuses), and every real-clock read is
 *  traceable to this constant instead of being scattered across defaults. */
const systemClock = (): Date => new Date();

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
  park clear     Clear a park episode receipt-first (refuses under a live engine)
    --source SOURCE  Clear only this park source (default: every open episode)
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
usage: sapwood run [--once | --until-idle | --dry-run] [--config PATH] [--milestone NAME] [--stop-* ...]

Run the engine. Default driver (cfg.engine.driver, "rounds"): the round orchestrator —
peripheral roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the
same dispatch-and-drain tick engine, one round at a time, until a signal or a \`stop.*\`
final condition winds the run down (the in-flight round always finishes, including
harvest, before the process exits). Set \`engine.driver: tick\` in config to run the bare
M4 loop driver instead: tick (reclaim -> drive -> resume -> dispatch) on
cfg.engine.tickIntervalSec's cadence, no peripherals — the pre-#106 behavior, kept
reachable as an explicit escape hatch.

Flags:
  --config PATH  Load config from this path instead of probing the defaults. Selects
                 config-file-relative logging.path, promptFile, goal.file, and doctrine.file
                 keys (so its default log sits beside that config). The DB
                 (data/sapwood.sqlite), KILL_SWITCH/PAUSE, sessions, and worktree roots
                 remain relative to the current working directory.
  --once         Tick driver only (engine.driver: tick): run exactly one tick, then exit
                 (exit 1 if the tick attempt failed). No equivalent under the round
                 orchestrator, which has no notion of a single tick — passing it under
                 engine.driver: rounds is an ERROR (exit 1, before any dispatch), never
                 silently ignored.
  --until-idle   Tick driver only: keep ticking until no lanes are in flight and nothing
                 dispatches, then exit. Same as --once: an ERROR under the round
                 orchestrator, never silently ignored.
  --dry-run      Resolve config, list the ready issues that WOULD be dispatched this round
                 and a cost preview (per-worker soft budget x candidate count, daily
                 ceiling), then exit. Never spawns a worker or writes state — the
                 first-run trust ramp's "see before you run" step. Driver-agnostic.
  --milestone NAME  Shortcut (#129): scope AND stop on one milestone in a single flag —
                 exactly \`round.milestone=NAME\` (this run's dispatch scope: only issues in
                 that milestone are candidates) PLUS \`--stop-on-milestone NAME\` (this run's
                 final stop condition: wind down once it has zero open issues left),
                 THIS RUN ONLY — never written back to the config file. Same startup
                 validation as --stop-on-milestone below (NAME must match a real milestone
                 title EXACTLY, checked before any dispatch). The scope half is a
                 round-orchestrator concept: under \`engine.driver: tick\` only the
                 stop-condition half applies (the tick driver has no round to scope).
                 Precedence: an explicit --milestone always wins over config's
                 round.milestone/stop.onMilestoneComplete for this run; it cannot combine
                 with an explicit --stop-on-milestone (ambiguous — which name wins? —
                 rejected, exit 1, before any dispatch, even when the two names match) or
                 with --dry-run (same as every --stop-* flag, below).

Goal-based stop conditions (#76) — each optional; hitting ANY of them (OR semantics, first hit
wins) winds the run down: stop dispatching new lanes, let in-flight lanes finish, exit cleanly,
naming the condition that fired. Override the config's \`stop.*\` section when given. Apply to
both drivers. Combine with --once/--until-idle/--forever (the default) freely; NOT with
--dry-run (which never runs the loop at all).
  --stop-after-issues N     Stop once N issues have been merged this run
  --stop-after-prs N        Stop once N PRs have been opened this run
  --stop-on-milestone NAME  Stop once milestone NAME has zero open issues left
                            (NAME must match the milestone title EXACTLY — validated
                            against the repo at startup, before any dispatch). See
                            --milestone above for the scope+stop shortcut.
  --stop-after-spend N      Stop once $N has been spent this run (ledgered run-spend —
                            summed from THIS run's own spend_ledger rows only; a restart
                            never inherits a prior run's total, unlike cost.dailyBudgetUsd's
                            cross-restart calendar-day cap). N is a dollar amount, not a
                            count — decimals are fine (25 or 25.50).

N is a floor, not an exact bound: the tick that crosses N has already dispatched its own
wave (up to lanes.roundDispatchCap lanes), and those finish during the wind-down. With
--once (tick driver), a condition hit on the single tick is named in the exit line but
never waits for wind-down (stoppedBy stays "once").

  --help, -h     Print this help and exit
`;

/** Run-subcommand flags the engine path accepts. Anything else must be rejected BEFORE the
 *  engine starts — `sapwood run --bogus` silently starting a daemon that claims issues and
 *  dispatches workers is the exact failure Codex PR #50 flagged (thread on cli.ts:46). */
const RUN_FLAGS = ["--once", "--until-idle", "--dry-run"] as const;

/** Pull `--config PATH` out of a run-subcommand argv, consuming its operand so later scans
 *  cannot mistake the path for a positional or flag. Mirrors status's fail-closed value-taking
 *  parse: a missing or flag-shaped operand is always an error, never a fallback to cwd probing.
 *  Tolerates full process.argv for the same reason parseStopFlags/parseMilestoneFlag do. */
export function parseRunConfigFlag(argv: string[]): { rest: string[]; configPath?: string; error?: string } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token !== "--config") {
      rest.push(token);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return { rest, error: "--config requires a path" };
    }
    configPath = value;
    i++;
  }
  return configPath !== undefined ? { rest, configPath } : { rest };
}

/** #76/#154: the four value-taking `--stop-*` flags, each paired with the StopConfig key it
 *  feeds. */
const STOP_FLAG_SPECS = [
  { flag: "--stop-after-issues", key: "afterIssuesMerged" as const },
  { flag: "--stop-after-prs", key: "afterPRsOpened" as const },
  { flag: "--stop-on-milestone", key: "onMilestoneComplete" as const },
  { flag: "--stop-after-spend", key: "afterSpendUsd" as const },
];

/** Pulls the `--stop-*` flags (and their values) out of a run-subcommand argv, leaving `rest`
 *  for the existing bare-flag validation (RUN_FLAGS) to check. Pure + exported for testing.
 *  Tolerant of being run over the FULL process.argv (cli.ts calls it twice: once in runCli's
 *  synchronous validation, once in runEngine to build the resolved StopConfig) — non-matching
 *  tokens (including "sapwood", "run") just pass through to `rest` unexamined, same tolerance
 *  parseRunStopMode already relies on. Fails closed: a `--stop-*` flag with a missing value, a
 *  value that looks like another flag, (for the two count flags) a non-positive-integer value,
 *  or (for --stop-after-spend) a non-positive/non-finite number is an `error`, never a
 *  silently-ignored/mis-parsed condition. */
export function parseStopFlags(argv: string[]): { rest: string[]; stop: StopConfig; error?: string } {
  const rest: string[] = [];
  const stop: StopConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const spec = STOP_FLAG_SPECS.find((s) => s.flag === token);
    if (!spec) {
      rest.push(token);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return { rest, stop, error: `${spec.flag} requires a value` };
    }
    if (spec.key === "onMilestoneComplete") {
      stop.onMilestoneComplete = value;
    } else if (spec.key === "afterSpendUsd") {
      // #154: a dollar amount, not a count — finite/positive but NOT integer-only (unlike the
      // two count flags below), same shape as cost.roundBudgetUsd/dailyBudgetUsd in config.ts.
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return { rest, stop, error: `${spec.flag} requires a positive number, got: ${value}` };
      }
      stop.afterSpendUsd = n;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { rest, stop, error: `${spec.flag} requires a positive integer, got: ${value}` };
      }
      stop[spec.key] = n;
    }
    i++; // consume the value token too
  }
  return { rest, stop };
}

/** #129: `--milestone NAME` — CLI sugar composing the two existing milestone mechanisms into
 *  one flag: `round.milestone` (this run's dispatch scope, config-only until now) + `stop.
 *  onMilestoneComplete` (this run's final stop condition, already a CLI flag via
 *  --stop-on-milestone above). Parsed separately from STOP_FLAG_SPECS/parseStopFlags because it
 *  also carries a round-scope override that StopConfig's shape can't express — resolveStopConfig
 *  folds its stop-condition half in below, and applyMilestoneOverride folds its scope half into
 *  cfg.round. Same tolerant-of-full-argv, fail-closed-on-missing-value contract as
 *  parseStopFlags. Pure + exported for testing. */
export function parseMilestoneFlag(argv: string[]): { rest: string[]; milestone?: string; error?: string } {
  const rest: string[] = [];
  let milestone: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token !== "--milestone") {
      rest.push(token);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return { rest, error: "--milestone requires a value" };
    }
    milestone = value;
    i++; // consume the value token too
  }
  return milestone !== undefined ? { rest, milestone } : { rest };
}

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
    // Validate the prompt template too (#74) — `sapwood validate` must reject everything the
    // real run would reject at startup, including a missing promptFile or unknown {{var}}.
    buildRenderPrompt(cfg);
    // #245 round-2 fix A7: same fail-fast stance for the FIX-LEG prompt template — a missing/
    // unreadable/empty worker.fixPromptFile or an unknown {{var}} must surface here too, not
    // only when a fix leg is actually started (#246). Renderer discarded; only validation matters.
    buildRenderFixPrompt(cfg);
    // Same for the soft-budget rate table (#33 follow-up): a missing/malformed
    // worker.pricingFile aborts the real run at supervisor construction, so validate it here.
    loadPricingTable(cfg);
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

/** #106 (gate② P2): exported with an injection seam (same EngineOverrides fields runEngine
 *  takes) so a test can prove --dry-run keeps working under the new rounds DEFAULT — main()
 *  routes --dry-run here BEFORE runEngine ever runs, so the preview is driver-agnostic by
 *  construction, and this stays the one place that must never gain a driver dependency. */
export async function runDryRun(overrides: Pick<EngineOverrides, "cfg" | "forge"> = {}, configPath?: string): Promise<number> {
  const cfg = overrides.cfg ?? loadConfig(configPath);
  // Same fail-fast the real run does (#74): a broken worker.promptFile must surface in the
  // preview too — dry-run exists to predict the real run, not to green-light a config the
  // real run would reject at startup. Renderer is discarded; only validation matters here.
  buildRenderPrompt(cfg);
  // #245 round-2 fix A7: same fail-fast stance for worker.fixPromptFile — see runValidate's
  // own comment.
  buildRenderFixPrompt(cfg);
  loadPricingTable(cfg); // #33 follow-up: a broken worker.pricingFile surfaces here too
  const forge = overrides.forge ?? new GithubForge(cfg);
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
  /** #75: the gentle-tier PAUSE sentinel (data/PAUSE) — true means new dispatch is skipped
   *  this tick, but reclaim/drive (in-flight lanes, PR review/merge) proceed normally. Distinct
   *  from killSwitchActive above (which also drains + freezes); both can be true at once, in
   *  which case the kill switch's reporting/behavior is the one that actually governs the tick. */
  pauseActive: boolean;
  ceilingBreach: { reasons: string[]; at: Date } | null;
  dailySpendUsd: number;
  /** null when no config could be loaded — reported as "unknown", never a fabricated default. */
  lanesMax: number | null;
  dailyBudgetUsd: number | null;
  /** #168: every open environment-failure park episode (at most one per source — llm/forge),
   *  empty when not parked. Read straight off state.ts's park_state rows
   *  (State.parkedSources()) — same "always live, no caching" property every other
   *  sentinel/flag on this snapshot has. */
  parked: ParkRow[];
  /** Latest successful startup reconcile only. Absent/healthy runs render no section. */
  orphanReport?: { orphans: StartupOrphan[]; overflow: number } | null;
  /** #237: PO-dissent concerns with a marker on GitHub but no `concern-adjudicated` event yet
   *  (dissent.ts's unadjudicatedConcerns — the SAME fold the engine's own per-round adjudication
   *  scan uses, so this count and that scan can never disagree on what "unadjudicated" means).
   *  DB-only, same as every other field on this snapshot — no live GitHub call from `status`
   *  itself; the live check that produces `concern-adjudicated` runs in the engine each round. */
  unadjudicatedConcerns: number;
  /** #502: the standing base-branch-CI-red episode, or null when the default branch is not known
   *  to be red. The operator-facing half of base-CI awareness: a red base gates EVERY open lane's
   *  merge-ref CI at once, and before this the only way to learn it was GitHub. DB-only like every
   *  other field here — the live detection runs in the engine's tick, never in `status`. */
  baseCiRed: BaseRedPin | null;
}

export function formatStatus(s: StatusSnapshot): string {
  const running = s.active.filter((w) => w.state === "running");
  const lines: string[] = [
    `sapwood status — ${s.dbPath} (schema v${s.schemaVersion})`,
    "",
    `lanes: ${s.active.length}/${s.lanesMax ?? "unknown"} active ` + `(${running.length} running, ${s.driving.length} driving)`,
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
    `pause: ${s.pauseActive ? "PAUSED (no new dispatch; in-flight lanes proceed normally)" : "inactive"}`,
    s.ceilingBreach
      ? `ceiling breach: ${s.ceilingBreach.reasons.join(", ")} (since ${s.ceilingBreach.at.toISOString()})`
      : "ceiling breach: none",
  );
  if (s.parked.length > 0) {
    for (const p of s.parked) {
      // #403 (F25) per-site decision: DELIBERATE wall-clock read, kept. `sapwood status` is a
      // human-facing print of how long the park has ACTUALLY been standing, right now, on this
      // machine — the operator's wall clock is the correct source, and no assertion in the suites
      // reads this string's duration (they assert the park's own fields, not the rendered "Ns").
      const durationSec = Math.max(0, Math.floor((Date.now() - Date.parse(p.enteredAt)) / 1000));
      // #431: a rapid-restart episode has NO probe — its clearing story is different, and the
      // status line must not promise probing that will never happen. #407: consecutive-stalls
      // is the same probe-less shape with its own clearing story (stall-breaker.ts's doc).
      // #470: idle-churn is a third probe-less shape (idle-churn.ts's doc) — same
      // operator-clears-it story as consecutive-stalls.
      const recovery =
        p.source === "rapid-restart"
          ? "clears on a later start outside the restart window (docs/troubleshooting.md)"
          : p.source === "consecutive-stalls" || p.source === "idle-churn"
            ? "stands until the operator clears it — no auto-clear (docs/troubleshooting.md)"
            : "probing on backoff, auto-resumes on recovery";
      lines.push(
        `park: PARKED (${p.source}) since ${p.enteredAt} (${durationSec}s) — ` +
          `reason: ${p.reason} — no new dispatch; in-flight lanes proceed normally; ` +
          recovery +
          (p.canaryWorker ? ` — canary lane ${p.canaryWorker} in flight` : "") +
          (p.escalatedAt ? ` — escalated to a human at ${p.escalatedAt}` : ""),
      );
    }
  } else {
    lines.push("park: inactive");
  }
  lines.push(
    s.baseCiRed
      ? `base CI: RED at ${s.baseCiRed.sha} since ${s.baseCiRed.at} — failing: ${s.baseCiRed.failing.join(", ")}; ` +
          "every open lane's CI evidence inherits this until the default branch is fixed"
      : "base CI: not known red",
  );
  lines.push(`PO-dissent concerns awaiting adjudication: ${s.unadjudicatedConcerns}`);
  if (s.orphanReport && (s.orphanReport.orphans.length > 0 || s.orphanReport.overflow > 0)) {
    lines.push("", `orphans: ${s.orphanReport.orphans.length + s.orphanReport.overflow}`);
    for (const orphan of s.orphanReport.orphans) {
      lines.push(
        orphan.kind === "pr" ? `  open engine PR #${orphan.pr} (issue #${orphan.issue})` : `  ${orphan.reason} issue #${orphan.issue}`,
      );
    }
    if (s.orphanReport.overflow > 0) lines.push(`  … and ${s.orphanReport.overflow} more`);
  }
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
    const reconcile = parseReconcileCompleted(state.latestEvent("reconcile-completed")?.payload);
    const concernEvents = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
    const snapshot: StatusSnapshot = {
      dbPath,
      schemaVersion: dbVersion,
      active: state.activeWorkers(),
      driving: state.drivingWorkers(),
      killSwitchActive: state.isKillSwitchActive(),
      pauseActive: state.isPauseActive(),
      ceilingBreach: state.ceilingBreach(),
      // #403: deliberate wall-clock read. `sapwood status` reports TODAY's spend as of the
      // moment the operator runs it; there is no seeded date anywhere on this path and no
      // caller that would want a different day. This is a composition root, hence systemClock.
      dailySpendUsd: state.dailySpendUsd(systemClock()),
      lanesMax: cfg?.lanes.max ?? null,
      dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
      parked: state.parkedSources(),
      orphanReport: reconcile ? { orphans: reconcile.orphans, overflow: reconcile.overflow } : null,
      unadjudicatedConcerns: unadjudicatedConcerns(concernEvents).size,
      baseCiRed: baseRedPin(state),
    };
    return { stdout: formatStatus(snapshot), stderr: "", code: 0 };
  } finally {
    state.close();
  }
}

// ── #475: `sapwood park clear` — the engine-owned, receipt-first operator clear ─────────────

const PARK_USAGE = `\
usage: sapwood park clear [db-path] [--source SOURCE]

Clear a park episode the way the engine itself would: append the \`park-resumed\`
receipt (\`via: operator-clear\`) FIRST, then delete the park_state row, then take down
the data/ESCALATION marker — the same order the engine's startup path uses, so a kill
mid-clear can never leave dispatch un-gated with no receipt in the ledger.

Refuses when a live engine holds the data dir (the single-instance lock, #382): clearing
under a running engine is exactly the race this verb exists to remove. Stop the engine,
clear, start it again.

Without --source, every open episode is cleared. Sources: ${PARK_SOURCES.join(", ")}.
Defaults to ${DEFAULT_DB_PATH} (the same path \`sapwood run\` writes to).

Flags:
  --source SOURCE  Clear only this park source
  --help, -h       Print this help and exit
`;

/** Parsed \`sapwood park clear\` args — same flat shape and fail-closed flag handling as
 *  parseStatusArgs (help/error checked in order by the caller). Pure: no I/O. */
export interface ParkArgs {
  help: boolean;
  error?: string | undefined;
  dbPath: string;
  source?: ParkSource | undefined;
}

export function parseParkArgs(argv: string[]): ParkArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, dbPath: DEFAULT_DB_PATH };
  }
  // `clear` is the only subcommand; anything else fails closed rather than being read as a
  // db-path positional (a typo'd verb must never silently clear the default data dir).
  if (args[0] !== "clear") {
    const what = args[0] === undefined ? "missing subcommand" : `unknown subcommand: ${args[0]}`;
    return { help: false, error: `${what} (the only park subcommand is \`clear\`)`, dbPath: DEFAULT_DB_PATH };
  }
  const positionals: string[] = [];
  let source: ParkSource | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--source") {
      // Value-taking flag, same fail-closed operand check as status's --config: a missing or
      // flag-shaped operand would otherwise silently widen the clear to EVERY episode.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { help: false, error: "--source requires a park source", dbPath: DEFAULT_DB_PATH };
      }
      if (!(PARK_SOURCES as readonly string[]).includes(next)) {
        return { help: false, error: `unknown --source: ${next} (one of: ${PARK_SOURCES.join(", ")})`, dbPath: DEFAULT_DB_PATH };
      }
      source = next as ParkSource;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { help: false, error: `unknown flag: ${a}`, dbPath: DEFAULT_DB_PATH };
    }
    positionals.push(a);
  }
  return { help: false, dbPath: positionals[0] ?? DEFAULT_DB_PATH, source };
}

/** `sapwood park clear`: the operator clear, performed inside the engine's own protocol instead
 *  of by raw SQL against a live DB (#475; the residual Codex flagged on PR #473).
 *
 *  Two properties the raw DELETE could not have:
 *   - RECEIPT-FIRST (loop/park-clear.ts) — the ledger records the resume before the dispatch
 *     gate can observe the absent row.
 *   - NO LIVE ENGINE — coordinated through the single-instance lock (#382), the same lock
 *     `sapwood run` takes on the data dir. A live holder is a refusal, never a racy clear; a
 *     STALE lock (dead holder) is taken over exactly as a starting engine would, and the lock is
 *     released before this returns, so the operator's next `sapwood run` is undisturbed.
 *
 *  Synchronous throughout (node:sqlite + the lock are both sync), like status/validate. */
export function runPark(argv: string[]): { stdout: string; stderr: string; code: number } {
  const parsed = parseParkArgs(argv);
  if (parsed.help) return { stdout: PARK_USAGE, stderr: "", code: 0 };
  if (parsed.error) {
    return { stdout: "", stderr: `sapwood park: ${parsed.error}\n\n${PARK_USAGE}`, code: 1 };
  }
  const { dbPath, source } = parsed;
  // Never CREATE a DB (or its data dir) as a side effect of a clear — a missing DB means the
  // engine has never run here, which is an operator error worth reporting, not a silent success.
  if (!existsSync(dbPath)) {
    return { stdout: "", stderr: `sapwood park clear: no state DB at ${dbPath} — the engine has never run here\n`, code: 1 };
  }
  const lockPath = join(dirname(dbPath), INSTANCE_LOCK_FILENAME);
  const lock = acquireInstanceLock(lockPath, { now: systemClock });
  if (!lock.acquired) {
    const holder =
      lock.holder.pid !== null
        ? `a live sapwood engine (pid ${lock.holder.pid}${lock.holder.acquiredAt ? `, lock acquired ${lock.holder.acquiredAt}` : ""})`
        : `another process (or a crashed stale-lock takeover — see ${lockPath}.takeover)`;
    return {
      stdout: "",
      stderr:
        `sapwood park clear: ${holder} holds the data-dir lock at ${lockPath} — refusing to clear. ` +
        `An engine-owned clear must not race a live engine's dispatch gate: stop the engine, clear, ` +
        `then start it again.\n`,
      code: 1,
    };
  }
  try {
    const state = new State(dbPath);
    try {
      const cleared = clearParksReceiptFirst(state, source ?? null);
      if (cleared.length === 0) {
        const scope = source ? ` for source ${source}` : "";
        return { stdout: `sapwood park clear: no open park episode${scope} — nothing to clear\n`, stderr: "", code: 0 };
      }
      const lines = cleared.map((p) => `  cleared ${p.source} (parked since ${p.enteredAt}) — reason: ${p.reason}`);
      return {
        stdout: `sapwood park clear: ${cleared.length} park episode(s) cleared, receipt-first\n${lines.join("\n")}\n`,
        stderr: "",
        code: 0,
      };
    } finally {
      state.close();
    }
  } catch (e) {
    // A schema newer than this engine (State.migrate's own message) or any unexpected DB error:
    // report it, never half-clear.
    return { stdout: "", stderr: `sapwood park clear: ${e instanceof Error ? e.message : String(e)}\n`, code: 1 };
  } finally {
    lock.release();
  }
}

/** Parsed run inputs produced by the synchronous validation boundary. Passing this token into
 *  runEngine/runDryRun prevents the async entry path from interpreting raw argv a second time. */
export interface ValidatedRunArgs {
  configPath?: string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
  validatedRun?: ValidatedRunArgs;
}

export function runCli(argv: string[]): CliResult {
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
  if (arg === "park") {
    return runPark(argv);
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
    // #320: pull the value-taking config flag out before every other scan. Its path operand is
    // config data, never a positional/flag for the run-mode or stop-condition parsers.
    const { rest: afterConfig, configPath, error: configError } = parseRunConfigFlag(flags);
    if (configError) {
      return { stdout: "", stderr: `sapwood run: ${configError}\n\n${RUN_USAGE}`, code: 1 };
    }
    // #129: pull --milestone out first — it's sugar for round.milestone + stop.onMilestoneComplete
    // together, and its VALUE token (a milestone name) must never be mistaken for an unknown bare
    // flag below, same reasoning as the --stop-* extraction that follows.
    const { rest: afterMilestone, milestone, error: milestoneError } = parseMilestoneFlag(afterConfig);
    if (milestoneError) {
      return { stdout: "", stderr: `sapwood run: ${milestoneError}\n\n${RUN_USAGE}`, code: 1 };
    }
    // #76: pull the value-taking --stop-* flags out next (both for their own validation and so
    // their VALUE tokens — an integer, a milestone name — never get mistaken for unknown bare
    // flags below).
    const { rest, stop, error: stopError } = parseStopFlags(afterMilestone);
    if (stopError) {
      return { stdout: "", stderr: `sapwood run: ${stopError}\n\n${RUN_USAGE}`, code: 1 };
    }
    // #129: --milestone already sets stop.onMilestoneComplete — an explicit --stop-on-milestone
    // alongside it is ambiguous (which name wins?), so reject rather than silently picking one,
    // even when the two names happen to match. Same fail-closed stance as every other combo
    // check here.
    if (milestone !== undefined && stop.onMilestoneComplete !== undefined) {
      return {
        stdout: "",
        stderr:
          `sapwood run: --milestone cannot combine with --stop-on-milestone ` + `(--milestone already sets it — pick one)\n\n${RUN_USAGE}`,
        code: 1,
      };
    }
    // Unknown flags fail closed: error + usage, exit 1 — never silently ignored by a daemon
    // that goes on to claim issues.
    const unknown = rest.filter((f) => !(RUN_FLAGS as readonly string[]).includes(f));
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
    // #76/#129: --dry-run never runs the loop at all, so neither a --stop-* goal nor --milestone
    // (which implies one) has anything to apply to — same standalone stance as the once/until-idle
    // check above.
    if (flags.includes("--dry-run") && (Object.keys(stop).length > 0 || milestone !== undefined)) {
      return {
        stdout: "",
        stderr: `sapwood run: --dry-run cannot combine with --stop-*\n\n${RUN_USAGE}`,
        code: 1,
      };
    }
    return {
      stdout: "",
      stderr: "",
      code: -1,
      validatedRun: configPath !== undefined ? { configPath } : {},
    };
  }
  // "init" falls through to the async path — signal caller to proceed.
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

/** #76/#154: the resolved StopConfig for a real `sapwood run` — cfg.stop.* as the base, each
 *  field individually overridden by its CLI --stop-* flag when present. Pure + exported for
 *  testing, same split as parseRunStopMode/runExitCode above. `argv` may be the full
 *  process.argv (like parseRunStopMode already tolerates) — parseStopFlags ignores everything
 *  that isn't one of its four flags. */
export function resolveStopConfig(argv: string[], cfg: Pick<SapwoodConfig, "stop">): StopConfig {
  const { stop: flags } = parseStopFlags(argv);
  // #129: --milestone is CLI sugar for --stop-on-milestone too. runCli already rejects the two
  // appearing together, so this ?? chain never has to arbitrate a real conflict — it just picks
  // whichever of the (at most one) explicit CLI sources is present, config as the final fallback.
  const { milestone } = parseMilestoneFlag(argv);
  // exactOptionalPropertyTypes: only set a key when a value actually exists — an explicit
  // `key: undefined` is a different (rejected) shape than simply omitting the key.
  const resolved: StopConfig = {};
  const afterIssuesMerged = flags.afterIssuesMerged ?? cfg.stop.afterIssuesMerged;
  const afterPRsOpened = flags.afterPRsOpened ?? cfg.stop.afterPRsOpened;
  const onMilestoneComplete = flags.onMilestoneComplete ?? milestone ?? cfg.stop.onMilestoneComplete;
  const afterSpendUsd = flags.afterSpendUsd ?? cfg.stop.afterSpendUsd;
  if (afterIssuesMerged !== undefined) resolved.afterIssuesMerged = afterIssuesMerged;
  if (afterPRsOpened !== undefined) resolved.afterPRsOpened = afterPRsOpened;
  if (onMilestoneComplete !== undefined) resolved.onMilestoneComplete = onMilestoneComplete;
  if (afterSpendUsd !== undefined) resolved.afterSpendUsd = afterSpendUsd;
  return resolved;
}

/** #129: applies `--milestone`'s round-scope half to cfg for THIS RUN ONLY — never persisted,
 *  never mutates the loaded config object (only spreads into a new object when the flag is
 *  actually present). No flag -> returns cfg unchanged (same reference), so a caller never pays
 *  for a copy it didn't ask for. Pure + exported for testing, same split as resolveStopConfig
 *  (the flag's stop-condition half) — called once in runEngine, before cfg is handed to either
 *  driver, so both round.milestone dispatch-scoping (round.ts) and stop.onMilestoneComplete
 *  (resolveStopConfig, independently re-derived from argv) see the same overridden name. */
export function applyMilestoneOverride(argv: string[], cfg: SapwoodConfig): SapwoodConfig {
  const { milestone } = parseMilestoneFlag(argv);
  if (milestone === undefined) return cfg;
  return { ...cfg, round: { ...cfg.round, milestone } };
}

/** #76 (fable gate② P2): fail-closed startup validation for --stop-on-milestone. `gh issue
 *  list --milestone` matches the EXACT title only and silently returns [] otherwise, so a typo
 *  ("M4" vs the real "M4 — UX surface + CLI") would fire the stop condition on the first tick —
 *  after dispatching a full wave of workers. Called by runEngine BEFORE runDriver: unknown
 *  title = a thrown error naming the available titles, no dispatch ever happens. Pure given the
 *  forge — exported for testing with a fake. */
export async function assertStopMilestoneExists(forge: Pick<IForge, "listMilestoneTitles">, stop: StopConfig): Promise<void> {
  if (stop.onMilestoneComplete === undefined) return;
  const titles = await forge.listMilestoneTitles();
  if (!titles.includes(stop.onMilestoneComplete)) {
    throw new Error(
      `stop.onMilestoneComplete: no milestone titled "${stop.onMilestoneComplete}" in this repo ` +
        `(exact match required). Available: ${titles.length > 0 ? titles.map((t) => `"${t}"`).join(", ") : "(none)"}`,
    );
  }
}

/** #412: the enumeration cap for normalizeUnplacedBoardItems' absent-issue report — a large
 *  open-issue backlog must never produce an unbounded log line or event payload. The reported
 *  TOTAL is always the true count regardless of this cap; only the enumerated list is capped. */
const ABSENT_ISSUES_LOG_CAP = 25;

/** Adopt GitHub's implicit No-Status board entries into the configured backlog once per
 *  engine start. This is deliberately separate from every dispatch read: Ready remains the
 *  only execution queue. Individual moves are best-effort so one malformed/stale item cannot
 *  prevent the engine from starting; the next startup naturally sees and retries any item
 *  whose move failed.
 *
 *  #412: also answers the strictly wider "is every issue reachable by the queue" question —
 *  after adopting No-Status items, report (never place) any OPEN issue of the configured repo
 *  that isn't on the board AT ALL. No-Status normalization above cannot see this case: its own
 *  input is board membership already (fetchProject().placements), so an issue that was never
 *  added to the board is outside its input set by construction. Detect-and-report only: this
 *  function adds no auto-placement write, matching listIssuesAbsentFromBoard's own read-only
 *  contract. Both passes are independently best-effort — a failure in one never blocks the
 *  other, or engine startup.
 *
 *  #491: the gap report enumerates ONLY issues on no project board anywhere. An issue placed on
 *  a different board is deliberate on a multi-board repo (this one partitions a dogfood queue
 *  from a human-only board), so it gets one trailing count and never a row: ~30 by-design rows
 *  per startup buried the handful of genuinely untriaged issues, which trains an operator to
 *  skip the report entirely — the way a real gap gets missed. No unplaced issues -> no line at
 *  all, however large that count is. */
export async function normalizeUnplacedBoardItems(
  forge: Pick<IForge, "listUnplacedIssues" | "setBoardStatus" | "listIssuesAbsentFromBoard">,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
): Promise<void> {
  try {
    const unplaced = await forge.listUnplacedIssues();
    if (unplaced.skipped > 0) {
      log(
        `[sapwood:startup] skipped ${unplaced.skipped} No-Status draft/foreign-repo board item(s) outside this repo's write jurisdiction`,
      );
    }
    for (const issue of unplaced.issues) {
      try {
        await forge.setBoardStatus(issue, "backlog");
        state.appendEvent("board-normalized", { issue, status: "backlog" });
      } catch (error) {
        log(`[sapwood:startup] issue #${issue}: failed to move No-Status item to backlog; continuing: ${String(error)}`);
      }
    }
  } catch (error) {
    log(`[sapwood:startup] could not list No-Status board items; normalization skipped: ${String(error)}`);
  }

  try {
    const { unplaced, elsewhere } = await forge.listIssuesAbsentFromBoard();
    if (unplaced.length > 0) {
      const shown = unplaced.slice(0, ABSENT_ISSUES_LOG_CAP);
      const truncated = unplaced.length > shown.length;
      log(
        `[sapwood:startup] ${unplaced.length} open issue(s) on no project board at all: ` +
          `#${shown.join(", #")}${truncated ? ", ..." : ""}` +
          (elsewhere > 0 ? ` (a further ${elsewhere} sit on another board — placed, not a gap)` : ""),
      );
      state.appendEvent("board-gap-detected", { total: unplaced.length, issues: shown, elsewhere });
    }
  } catch (error) {
    log(`[sapwood:startup] could not compute open issues absent from the board; check skipped: ${String(error)}`);
  }
}

/** #379 F1: provision every label the RESOLVED config names, once per engine start — the label
 *  counterpart to normalizeUnplacedBoardItems' board normalization above, and deliberately the
 *  same posture: idempotent, best-effort, never a startup blocker.
 *
 *  Live baseline (dogfood 2026-07-24): this repo was initialized before `round:pool`, `split`,
 *  `decomposed` and `hold` existed, and NOTHING reconciles labels as the feature set grows — so
 *  every one of the round's 8 pool-label writes failed against a label GitHub had never heard of.
 *  A missing label is an environment condition the engine can fix itself, not a defect to die on.
 *
 *  The provisioning list is `requiredLabels(cfg)` — literally the one `sapwood init` uses (see
 *  init.ts) — so a label added to the taxonomy later can never drift out of one path while
 *  staying in the other. A failure here (no `repo` write scope, say) is logged and the engine
 *  starts anyway: the pool-selection path downstream now parks on a total label-write failure
 *  rather than exiting (align.ts's runPoolSelection), so a permission problem degrades to "no
 *  pool this round", never a dead process. */
export async function reconcileWorkflowLabels(
  forge: Pick<IForge, "ensureRepoLabels">,
  state: Pick<State, "appendEvent">,
  cfg: SapwoodConfig,
  log: (message: string) => void = console.error,
): Promise<void> {
  try {
    const created = await forge.ensureRepoLabels(requiredLabels(cfg));
    if (created.length === 0) return;
    log(`[sapwood:startup] created ${created.length} missing workflow label(s): ${created.join(", ")}`);
    state.appendEvent("labels-reconciled", { created });
  } catch (error) {
    log(`[sapwood:startup] could not reconcile the configured workflow labels; continuing: ${String(error)}`);
  }
}

/** #410 amendment (owner ruling 2026-07-28): the tool names a `permissions.deny` entry can name
 *  to strip the #410 web-access grant — matched bare ("WebSearch") or `Tool(...)`-qualified (a
 *  "WebSearch(" prefix, e.g. "WebSearch(domain:x)"). */
const WEB_ACCESS_TOOLS = ["WebSearch", "WebFetch"] as const;

/** #410 amendment: injectable seam for checkWebAccessSettingsDenial's two OS reads — same
 *  "inject the collaborator, not the CLI" convention every other cli.ts test-support type here
 *  uses. Omitted -> the real `node:fs`/`node:os` calls. */
export interface WebAccessDenialCheckDeps {
  homedir?: () => string;
  /** Reads the file at `path` and returns its text, or THROWS (missing/unreadable) — same
   *  contract as `readFileSync(path, "utf8")`, which is the real default. */
  readFile?: (path: string) => string;
}

/** #410 amendment (owner ruling 2026-07-28): lightweight startup detection, NOT settings
 *  pinning — see docs/security.md's peripheral-egress section for the full rationale. An
 *  earlier version of this PR pinned `--setting-sources ""` for every peripheral session; a
 *  live measurement found that flag ALSO stops loading the repo's own CLAUDE.md, colliding
 *  with the locked #236 ruling ("Ambient repo context: record, don't seal" — a peripheral
 *  session absorbing the target repo's CLAUDE.md is a deliberately OPEN channel). The #410
 *  decision record's own reserved fallback — "if pinning turns out to have side effects, the
 *  fallback is startup detection and reporting" — is what this function is.
 *
 *  Reads ONLY the operator's user-level settings (`$CLAUDE_CONFIG_DIR/settings.json`, or
 *  `~/.claude/settings.json` when unset — the SAME resolution peripheral.ts's ambient
 *  CLAUDE.md probe already uses, `capturePreSpawnManifestData`'s `userConfigDir`). NEVER
 *  project/local settings: project settings are repo-governed (a target repo's own
 *  `.claude/settings.json`), and an engine-managed peripheral worktree carries no local
 *  settings of its own to read in the first place.
 *
 *  When `cfg.webAccess.enabled` is true and `permissions.deny` names `WebSearch`/`WebFetch`
 *  (see WEB_ACCESS_TOOLS), this is exactly the silent-capability-loss failure mode the #410
 *  decision record measured: the granted role session's own reported tool list simply omits
 *  the tool, with ZERO permission-denial signal — indistinguishable from "this CLI version
 *  doesn't have the tool" without this check. Emits ONE warning log line plus ONE durable
 *  `web-access-denied-by-operator-settings` state event naming the denied entries.
 *
 *  Detection only: never blocks startup, never spawns a probe session, never mutates the
 *  operator's settings. `cfg.webAccess.enabled: false` skips the read ENTIRELY (not just the
 *  report) — no reason to inspect settings for a grant that isn't even offered. A missing,
 *  unreadable, or malformed settings file is a normal case (most operators carry no deny list
 *  at all) — logged at low severity and treated as "nothing to report", never an error, never
 *  a durable event. */
export function checkWebAccessSettingsDenial(
  cfg: Pick<SapwoodConfig, "webAccess">,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
  deps: WebAccessDenialCheckDeps = {},
): void {
  if (!cfg.webAccess.enabled) return;
  // Codex sol-high PR #417 review, P1: the ENTIRE body below — including `homedir()`'s own
  // resolution and the final `state.appendEvent` — must be inside ONE best-effort containment,
  // not just the two file-read/parse steps. Reproduced: a SQLite write failure on the
  // (uncaught) `appendEvent` call after a real detected deny would THROW and abort BOTH
  // drivers' startup, violating this function's own "never blocks startup" contract — the
  // same contract normalizeUnplacedBoardItems (just above) already honors end to end. A
  // detection feature must never itself become a NEW startup-failure mode.
  try {
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join((deps.homedir ?? homedir)(), ".claude");
    const settingsPath = join(configDir, "settings.json");
    let raw: string;
    try {
      raw = readFile(settingsPath);
    } catch (error) {
      log(`[sapwood:startup] no operator settings readable at ${settingsPath}; web-access denial check skipped: ${String(error)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log(
        `[sapwood:startup] operator settings at ${settingsPath} could not be parsed as JSON; web-access denial check skipped: ${String(error)}`,
      );
      return;
    }
    const deny = (parsed as { permissions?: { deny?: unknown } } | null)?.permissions?.deny;
    if (!Array.isArray(deny)) return;
    const denied = deny.filter(
      (entry): entry is string =>
        typeof entry === "string" && WEB_ACCESS_TOOLS.some((tool) => entry === tool || entry.startsWith(`${tool}(`)),
    );
    if (denied.length === 0) return;
    log(
      `[sapwood:startup] operator settings (${settingsPath}) deny ${denied.join(", ")} — the #410 web-access grant to ` +
        "architect/po-align/po-triage will be silently stripped from these sessions (zero permission-denial signal); " +
        "a granted session should abstain, per its prompt's first-class-abstention wording, rather than guess when the tool turns out absent",
    );
    state.appendEvent("web-access-denied-by-operator-settings", { settingsPath, denied });
  } catch (error) {
    // Best-effort, same stance as every other startup-pass check in this function's
    // neighborhood: a failure HERE (e.g. state.appendEvent throwing on a SQLite write error)
    // is logged and swallowed, never allowed to propagate out and abort engine startup.
    log(`[sapwood:startup] web-access denial check failed (non-fatal, startup continues): ${String(error)}`);
  }
}

/** #385 (F10): the degraded-configuration announcement — `lanes.prFixCap > 0` (an operator has
 *  configured a fix loop) while the proxy is NOT in its production-attach state, so no live
 *  driver ever builds a real `TickDeps.fixLegResume` (buildTickFixLegResume / round.ts's
 *  buildFixLegResume both return `undefined`). Every FIXABLE gate then degrades to a
 *  `fix-loop-unwired:<reason>` needs-human escalation (conductor.ts, #246 C1) — correct per
 *  #253's three-state design, but until now only observable AFTER a PR had already been pushed
 *  to needs-human. This says it ONCE at startup, per run, instead: one log naming the exact
 *  go-live flip, one durable event for the dashboard/replay. No behavior change to the
 *  three-state design itself — this is pure detection.
 *
 *  Deliberately silent for the two NON-degraded halves of the matrix: `prFixCap: 0` is an
 *  operator's explicit opt-out (folding straight to needs-human IS the configured behavior, not
 *  a surprise), and `enabled: true, shadow: false` is the working configuration.
 *
 *  Same best-effort startup-pass stance as checkWebAccessSettingsDenial above: never blocks,
 *  never throws out, at most one log line + one event. Exported for direct testing. */
export function announceFixLoopUnattached(
  cfg: { lanes: Pick<SapwoodConfig["lanes"], "prFixCap">; proxy: Pick<SapwoodConfig["proxy"], "enabled" | "shadow"> },
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
): void {
  const { prFixCap } = cfg.lanes;
  const { enabled, shadow } = cfg.proxy;
  if (prFixCap <= 0 || (enabled && !shadow)) return;
  const reason = enabled ? "proxy-shadow" : "proxy-disabled";
  try {
    log(
      `[sapwood:startup] lanes.prFixCap=${prFixCap} but the fix loop is not production-attached ` +
        `(proxy.enabled=${enabled}, proxy.shadow=${shadow}) — every FIXABLE review gate will degrade to a ` +
        "needs-human escalation (fix-loop-unwired) instead of dispatching a fix leg; set `proxy.enabled: true` " +
        "and `proxy.shadow: false` to go live (docs/configuration.md, `proxy`), or `lanes.prFixCap: 0` to make " +
        "the fold explicit",
    );
    state.appendEvent("fix-loop-unattached", { prFixCap, proxyEnabled: enabled, proxyShadow: shadow, reason });
  } catch (error) {
    log(`[sapwood:startup] fix-loop attachment announcement failed (non-fatal, startup continues): ${String(error)}`);
  }
}

/** #76: the exit log line naming whichever stop condition fired — e.g. "sapwood run: stop
 *  condition hit — afterIssuesMerged=3 (merged 3)". Pure + exported for testing; only called
 *  when result.stopCondition is set (stoppedBy "stop-condition", or "once" when the single
 *  tick satisfied a goal). */
export function formatStopConditionLine(hit: StopConditionHit): string {
  return `[sapwood:run] stop condition hit — ${hit.name}=${hit.threshold} (${hit.detail})`;
}

/** #106: injectable collaborators for `sapwood run`'s engine wiring (both drivers) — production
 *  code (`main`) passes none, so every field falls back to the real thing (loadConfig/
 *  GithubForge/State/RoleRunner with its own defaults). Tests pass a fake `forge` (no live `gh`
 *  calls, same "fake the collaborator, not the CLI" split round-defaults.test.ts uses) and/or
 *  `roleRunnerDeps` overrides (a stub `claudeBin`, a temp `stateDir`/`guardHookPath` — same
 *  claude-stub style as peripheral.test.ts) to drive the REAL runEngine/runRoundsEngine
 *  production path in-process instead of only exercising runRounds directly. `cfg` lets a test
 *  skip disk-based config loading entirely. */
export interface EngineOverrides {
  cfg?: SapwoodConfig;
  forge?: IForge;
  state?: State;
  roleRunnerDeps?: Partial<RoleRunnerDeps>;
  logger?: EngineLogger;
  onTick?: (result: TickResult) => void;
  /** RoundDeps passthrough, rounds driver only — lets a test control the signal/sleep sources
   *  the same way round-defaults.test.ts's own integration tests do, without real wall-clock
   *  waits or real process signal handlers. */
  sleep?: (ms: number) => Promise<void>;
  registerSignals?: (requestStop: () => void) => () => void;
  /** RoundDeps.onRoundPhase passthrough, rounds driver only — an observability hook a test can
   *  use to trigger a graceful stop mid-round (round-defaults.test.ts's own pattern), proving a
   *  round already open finishes every remaining phase, harvest included, before the loop
   *  actually stops. */
  onRoundPhase?: (roundId: number, phase: PeripheralPhase) => void;
  onRoundStop?: (roundId: number, hit: RoundStopHit) => void;
  /** #382: pid-liveness seam for the single-instance lock — lets a test script "that pid is
   *  dead" deterministically (repo rule: no assertion may depend on real subprocess lifetimes).
   *  Production passes none, so the real `process.kill(pid, 0)` probe
   *  (instance-lock.ts's pidIsAlive) applies. */
  pidLiveness?: (pid: number) => boolean;
}

function createRunLogger(cfg: SapwoodConfig, override?: EngineLogger): { logger: EngineLogger; path: string } {
  const path = resolve(cfg.logging.path);
  return {
    path,
    logger:
      override ?? new FileEngineLogger({ path, teeToStderr: cfg.logging.teeToStderr, maxBytes: cfg.logging.maxBytes, now: systemClock }),
  };
}

/** #504: the tick line counts ACTIONS, matching what the (transition-deduped, #383) event log
 *  records — not per-tick evaluations. Raw array lengths counted steady-state no-ops: a "kept"
 *  reclaim (running lane still alive), a "skipped" dispatch (cap/in-flight), and a "queued"
 *  drive (gate still waiting) re-count every tick, so a fully wedged run logged
 *  `reclaimed=3 dispatched=2 driven=3` forever while the event stream recorded nothing.
 *
 *  Two deliberate blind spots (#505 review): a NEWLY ANNOUNCED queued transition still counts
 *  as driven=0 here — its signal is the richer `[sapwood:drive]` line the conductor logs at the
 *  announcement site, not this counter; and an ADOPT-path reclaim keeps its by-design "kept"
 *  outcome (#169: adoption adds no scheduler machinery) — its signal is the one-shot
 *  lane-adopted event. */
export function formatTickSummary(result: TickResult): string {
  const reclaimed = result.reclaimed.filter((r) => r.kind !== "kept").length;
  const fixingReclaimed = result.fixingReclaimed.filter((r) => r.kind !== "kept").length;
  const dispatched = result.dispatched.filter((d) => d.kind === "dispatched").length;
  const driven = result.driven.filter((d) => d.kind !== "queued").length;
  return (
    `[sapwood:tick] reclaimed=${reclaimed} fixingReclaimed=${fixingReclaimed} ` +
    `dispatched=${dispatched} driven=${driven} resumed=${result.resumed.length} ` +
    `rollbacks=${result.rollbacks.length} fixResponses=${result.fixResponses.length} gatedReclaimed=${result.gatedReclaimed.length} ` +
    `drainRequested=${result.drainRequested.length} escalated=${result.escalated.length} ceilingBreached=${result.ceilingBreached}`
  );
}

/** #106: exit code for a finished `sapwood run` under the round orchestrator. Rounds have no
 *  --once/--until-idle equivalent (no single-tick concept), so unlike runExitCode above this
 *  doesn't key off stopMode/ticks — a kill-switch stop is the one outcome that needs an operator
 *  to notice (cron/scripts should see it as a failure); a graceful signal or a final stop
 *  condition is the design working as intended, same as the tick driver's daemon-mode exit 0. */
export function roundsExitCode(result: Pick<RoundsResult, "stoppedBy">): number {
  return result.stoppedBy === "kill-switch" ? 1 : 0;
}

/** #377 (was #106): `WorkerSupervisor.lanePr` needs `GithubForge`'s branch-keyed reads and PR-body
 *  write, which are not part of the narrower `IForge` interface every fake forge in tests
 *  (round-defaults.test.ts's FakeForge, etc.) implements — the same duck-typing the deleted
 *  `findOpenPrForIssue` wiring used, for the same reason. Production `forge` is always a real
 *  GithubForge (EngineOverrides.forge is unset), so this always resolves to the real methods
 *  there; a test-injected bare-IForge fake falls back to "no association", which is fine because
 *  those tests never dispatch a worker (no ready issues). */
function buildLanePrAssociator(forge: IForge, log: (message: string) => void): (lane: LanePrRequest) => Promise<LanePrOutcome> {
  const candidate = forge as Partial<LanePrForge>;
  const complete =
    typeof candidate.listOpenPrsForBranch === "function" &&
    typeof candidate.listOpenPrBodies === "function" &&
    typeof candidate.updatePRBody === "function" &&
    typeof candidate.openPR === "function" &&
    typeof candidate.probePushedBranch === "function" &&
    typeof candidate.getIssueMeta === "function";
  // No branch-keyed forge surface -> a CONCLUSIVE "no association" (nothing failed, so
  // nothing to retry) rather than an inconclusive one that would defer every lane forever.
  if (!complete) return () => Promise.resolve({ pr: null, inconclusive: false });
  return (lane) => associateLanePr(candidate as LanePrForge, lane, log);
}

/** #253: builds the tick-driver's TickDeps.fixLegResume — round 0 / phase "tick" is this
 *  driver's fixed SENTINEL audit identity (never a real round: the tick driver, #106's explicit
 *  escape hatch, has no round concept at all) for the proxy's own journal rows. This identity is
 *  informational only — it does NOT double as the (round, phase, attempt) tuple #231's context-
 *  manifest schema uses for a REAL role/worker session (a fix-leg's own resume attempt isn't
 *  separately tracked here either, always `attempt: 1` — see proxy/mint.ts's createProxyMint doc
 *  for why that's harmless for journal uniqueness). Evaluating whether a fix leg needs its own
 *  tracked attempt ordinal is live-run territory (#253 item 3), not plumbed here.
 *
 *  #253 review round 2 (Codex sol-high, H1 — PM-narrowed three-state ruling): `shadow` gates
 *  PRODUCTION ATTACHMENT, not per-consumer effect-suppression.
 *    1. `enabled: false` (default): nothing constructed. Unchanged.
 *    2. `enabled: true, shadow: true` (the default once enabled): this function still returns
 *       `undefined` — NO production attachment. The proxy machinery stays constructible/mintable
 *       (this function, `createProxyMint`, round.ts's `buildFixLegResume` are all still callable
 *       directly by a scoped harness — that's how the owner's live shadow bring-up run (#253
 *       item 2/3) exercises it) but no LIVE `sapwood run` session ever holds a handle, so no
 *       session's output can be proxy-informed. The shadow guarantee is structural, not a
 *       per-call effect check.
 *    3. `enabled: true, shadow: false`: full production attachment — the deliberate go-live flip,
 *       taken only after the shadow bring-up validates the proxy.
 *  A FIXABLE gate degrades to the pre-#246 needs-human escalation (#246 C1) in states 1 AND 2,
 *  unchanged from before this issue — only state 3 makes FIXUP dispatch itself live.
 *
 *  Observable guarantee in states 1/2 (#253 review round 2, H4 — narrowed from an overreaching
 *  "byte-for-byte" claim): no proxy handle, no HTTP listener, no bearer token, no forge_proxy_
 *  journal write, no ProxyForge call, no argv change (`--mcp-config`/widened `--allowedTools`) on
 *  ANY production session. The module graph still loads and this function still runs (returning
 *  `undefined`) — that in-memory branch evaluation is not itself an observable effect.
 *
 *  Exported for direct testing. */
export function buildTickFixLegResume(
  cfg: SapwoodConfig,
  forge: IForge,
  state: State,
  renderFixPrompt: (issueNumber: number, pr: number) => string,
  now: () => Date,
  log?: (message: string) => void,
): FixLegResumeDeps | undefined {
  if (!cfg.proxy.enabled || cfg.proxy.shadow) return undefined;
  return {
    renderFixPrompt,
    mintProxy: createProxyMint({ cfg, forge, state, roundId: 0, phase: "tick", now, ...(log !== undefined ? { log } : {}) }),
  };
}

/** #206 (frontend-design.md §11): the run boundary in the event stream. Replay derives run
 *  GROUPING from this event (#431 deleted the old `engine_session` gap heuristic entirely; the
 *  wall clock now anchors to in-memory process start). Appended once per process start,
 *  before anything else this run writes (so it also anchors the #154 run-spend ledger position),
 *  carrying the ALLOWLISTED config subset (never the resolved object — see
 *  dashboardConfigSubset) plus a hash of the full config for change detection across runs.
 *
 *  #407 gate② P2: appends ONLY the boundary itself. The stale-lock takeover event that used to
 *  ride here moved to the drivers' own terminal bracket — every write after a SUCCESSFUL
 *  run-started must sit inside the try that guarantees a `run-ended` on a controlled exit, and
 *  this function runs strictly BEFORE that bracket opens (a failed run-started append must not
 *  produce an unpaired terminal). */
function appendRunStarted(state: Pick<State, "appendEvent">, cfg: SapwoodConfig): void {
  state.appendEvent("run-started", { config: dashboardConfigSubset(cfg), configHash: configHash(cfg) });
}

/** #382: what runEngine hands the drivers when startup took over a stale lock — carried as a
 *  pending startup event so the drivers can order it after the run boundary (above), inside
 *  their terminal bracket (#407 gate② P2). */
interface LockTakeoverRecord {
  lockPath: string;
  previousPid: number | null;
}

/** #407 (item 1): the run boundary's CLOSING bracket — `run-ended`, appended on every exit path
 *  the process itself controls, so together with the watchdog's `engine-stalled` the three
 *  dead-engine states partition cleanly for any later reader (the dashboard's
 *  latestRunTerminal, the stall breaker's streak fold):
 *    - `run-ended` newest since `run-started`  -> a CLEAN stop (payload names stoppedBy — the
 *      driver's own StopReason/RoundsResult value: signal / once / idle / stop-condition /
 *      kill-switch — plus the stop condition's name when one fired, and `error` + its message
 *      when a thrown startup/driver error is exiting the run through cli.ts's catch);
 *    - `engine-stalled` newest -> the watchdog self-diagnosed a stall and called process.exit
 *      DIRECTLY from its timer, which skips every pending finally/catch in the suspended driver
 *      frames — so no `run-ended` can follow it, by construction, not by convention;
 *    - NEITHER -> a crash or kill (SIGKILL, OOM): the process never got to write anything, and
 *      that ABSENCE is itself the meaningful record — "this engine died without knowing why",
 *      which is exactly what the dashboard renders as its bare `stalled`/crashed state.
 *  Best-effort by design: a failed append (the disk dying at exit) must never mask the run's own
 *  result or exit code — the absence then reads as a crash, which is the honest degradation. */
function appendRunEnded(state: Pick<State, "appendEvent">, payload: Record<string, unknown>, log: (message: string) => void): void {
  try {
    state.appendEvent("run-ended", payload);
  } catch (error) {
    log(`[sapwood:run] run-ended append failed (non-fatal — the exit proceeds): ${String(error)}`);
  }
}

/** The M4 tick-driver path (`driver.ts`'s `runDriver`) — unchanged behavior, kept reachable via
 *  `engine.driver: tick` (#106's explicit escape hatch) now that the round orchestrator
 *  (runRoundsEngine below) is the default. */
async function runTickEngine(
  argv: string[],
  cfg: SapwoodConfig,
  overrides: EngineOverrides,
  lockTakeover?: LockTakeoverRecord,
): Promise<number> {
  const { logger, path: logPath } = createRunLogger(cfg, overrides.logger);
  const log = logger.log.bind(logger);
  log(`[sapwood:run] startup logPath=${logPath}`);
  // #74: build the worker-prompt renderer NOW, before anything else — loadWorkerPromptTemplate
  // (inside buildRenderPrompt) reads the template file EAGERLY, so a configured
  // `worker.promptFile` that's missing/unreadable throws here and aborts startup. Never a lazy
  // load deferred to first dispatch: that would let the engine claim issues / churn ticks before
  // failing, instead of a clean fail-fast with no dispatch ever happening.
  const renderPrompt = buildRenderPrompt(cfg);
  // #245 round-2 fix A7: same fail-fast stance for worker.fixPromptFile — the config must still
  // be validated eagerly at startup, matching runValidate/runDryRun. #246 wires the FIXABLE
  // gate's dispatch logic (conductor.ts DRIVE loop's own `TickDeps.fixLegResume` consumer); #253
  // (below, after state/forge exist) closes the production gap #246 left open — see
  // buildTickFixLegResume's own doc for the tick driver's round 0 / phase "tick" audit identity.
  const renderFixPrompt = buildRenderFixPrompt(cfg);
  const state = overrides.state ?? new State();
  appendRunStarted(state, cfg);
  // #407 (item 1, gate② P2): the run boundary is OPEN — every controlled exit from here to
  // process exit must close it with exactly one `run-ended`, so the bracket opens IMMEDIATELY
  // after the successful run-started append (P2: the takeover append used to sit before it,
  // and a throw there exited through main()'s handler with no terminal — a recorded false
  // crash). The success path appends the driver's own stoppedBy; the catch appends
  // {stoppedBy: "error"}. The two paths that must NOT reach the catch stay out by
  // construction: the watchdog exits via process.exit from its own timer (no unwinding,
  // `engine-stalled` is its terminal), and a hard kill unwinds nothing at all (the ABSENCE is
  // the record — appendRunEnded's doc).
  try {
    // #382 round 2 (codex PR #467 finding 4): the stale-lock takeover happened at THIS run's
    // startup, so its event must land inside THIS run's replay group — i.e. AFTER `run-started`,
    // the authoritative grouping boundary. Appending it any earlier (round 1 did, at acquisition
    // time) attributes it to the PREVIOUS run's group.
    if (lockTakeover !== undefined) {
      state.appendEvent("instance-lock-taken-over", { lockPath: lockTakeover.lockPath, previousPid: lockTakeover.previousPid });
    }
    // #431 (owner amendment 1): the rapid-restart detector, strictly AFTER appendRunStarted —
    // the count then includes THIS boot's own birth, and everything the detector emits lands
    // after `run-started` inside this run's replay group (the #382-pinned run-started-first
    // ordering is undisturbed). A trip parks autonomous dispatch via the existing park paradigm;
    // startup itself continues (reconcile passes are engine hygiene, not dispatch).
    detectRapidRestart(state, cfg, systemClock, log);
    // #407: the stall breaker — the SAME placement pattern as the rapid-restart detector above
    // (strictly after the run boundary, same park paradigm on a trip, startup itself continues),
    // reading back whether the PREVIOUS run ended in a watchdog stall and whether the streak has
    // reached liveness.maxConsecutiveStalls. See stall-breaker.ts's own doc.
    detectConsecutiveStalls(state, cfg, systemClock, log);
    // #438: an engine session has both announcement channels, so a paging ceiling in the board or
    // review-thread reads lands in the durable event log, not only on stderr.
    const forge = overrides.forge ?? new GithubForge(cfg, { log, state });
    // #253: the tick driver's TickDeps.fixLegResume — undefined (no handle/listener/token/journal
    // write/argv change on any production session — see buildTickFixLegResume's own doc for the
    // exact observable guarantee) unless cfg.proxy is in its production-attach state (enabled:
    // true, shadow: false).
    const fixLegResume = buildTickFixLegResume(cfg, forge, state, renderFixPrompt, systemClock, log);
    const engineReviewRunner =
      cfg.reviewer.mode === "engine-agent" ? new RoleRunner({ cfg, ...overrides.roleRunnerDeps, log, state, now: systemClock }) : null;
    const engineAgent = engineReviewRunner
      ? makeProductionEngineAgent(cfg, forge, state, engineReviewRunner, {
          now: systemClock,
          ...(overrides.roleRunnerDeps?.worktreeRoot !== undefined ? { worktreeRoot: overrides.roleRunnerDeps.worktreeRoot } : {}),
        })
      : null;
    const reviewer = engineAgent?.reviewer ?? makeReviewer(cfg);
    // #54: the ordered reviewer-failover chain (cfg.reviewer.fallback) — empty by default, in
    // which case MergeDriver.driveOne behaves exactly as before this existed.
    const fallbackReviewers = makeFallbackReviewers(cfg);
    const mergeGate = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers });
    const supervisor = new WorkerSupervisor({
      cfg,
      log,
      now: systemClock,
      // #377: lane->PR association keyed on the lane's own branch + the engine-authored PR-owner
      // marker (forge.ts's associateLanePr) — never a PR body's prose mention of the issue number,
      // which is what handed lane-294 a stranger's PR in the 2026-07-24 F15 case.
      lanePr: buildLanePrAssociator(forge, log),
      renderPrompt,
      // #244 (Codex sol-high PR #260 review round 2, P2): wires the durable `proxy-mint-failed`
      // event into the REAL tick-driver run — without this, a mint failure on a live proxy-
      // attached leg (no shipped caller attaches one yet, but the observability must be live the
      // instant one does) would only ever reach a log line, never the queryable state event
      // WorkerDeps.state's own doc promises.
      state,
    });
    const stopMode = parseRunStopMode(argv);
    const stop = resolveStopConfig(argv, cfg);
    // #76: same fail-fast stance as buildRenderPrompt above — a typo'd milestone goal must abort
    // startup with zero dispatch, not silently stop the run after the first wave of workers.
    await assertStopMilestoneExists(forge, stop);
    await normalizeUnplacedBoardItems(forge, state, log);
    // #379 F1: same best-effort startup-pass stance as the board normalization above — provisions
    // any workflow label this repo is missing so the round's own label writes can land.
    await reconcileWorkflowLabels(forge, state, cfg, log);
    // #410 amendment: same best-effort startup-pass stance as the board normalization above —
    // detects, never blocks, never mutates.
    checkWebAccessSettingsDenial(cfg, state, log);
    // #385 F10: same stance again — announces the `prFixCap > 0` + unattached-fix-loop
    // combination ONCE here, rather than leaving it to surface per-escalation on an already
    // needs-human PR. See announceFixLoopUnattached's own doc.
    announceFixLoopUnattached(cfg, state, log);
    await reconcileStartup(forge, state, cfg, log);
    // #391 F19: same best-effort startup pass — correct the gated-reentry marker on lanes whose
    // hold label is observably live, so removing that label is the only manual step a human needs.
    await auditGatedEscalationFlags(forge, state, cfg, log);
    // #447 F28 residual: same best-effort startup pass, deliberately AFTER the F19 audit — a lane
    // whose hold label is live has just been handed back to gated reentry, so it is already out of
    // this pass's candidate set and only the never-escalated ones remain. A restart DURING a park
    // episode revives nothing: the episode is durable, and the pass suspends itself on it exactly
    // as the tick does (PR #463 round 2).
    await reviveEnvFailedPrLanes(forge, state, cfg, log);
    sweepStaleRoleSessions(state, {
      log,
      ...(overrides.roleRunnerDeps?.stateDir !== undefined ? { stateDir: overrides.roleRunnerDeps.stateDir } : {}),
      ...(overrides.roleRunnerDeps?.worktreeRoot !== undefined ? { worktreeRoot: overrides.roleRunnerDeps.worktreeRoot } : {}),
    });
    log(`[sapwood:run] driver=tick tickIntervalSec=${cfg.engine.tickIntervalSec} stopMode=${stopMode}`);
    // NOTE: roundSpendUsd (the per-round hard budget gate, cfg.cost.roundBudgetUsd) is left at
    // its TickDeps default (0, i.e. never over-budget) — computing a live "this round's spend"
    // figure needs a round-tracking concept (nextRoundId exists as a pure helper but nothing
    // wires it to a live round yet) that predates this PR and isn't part of #46's scope. The
    // engine-wide daily/wall-clock/kill-switch ceiling (cfg.cost.dailyBudgetUsd /
    // maxWallClockSec / KILL_SWITCH) is fully live regardless — that's the actual hard safety
    // boundary; roundBudgetUsd is a softer per-round throttle.
    // #168 (P1-1 amendment): the real LLM-source park probe — a minimal inference ping on the
    // cheapest model (worker.ts's probeLlmPing), resolved against the SAME claude binary
    // WorkerSupervisor's dispatch() would use. The rich {ok, detail} result flows into the
    // park-probe event so a failing probe names its own cause.
    const probeLlmReachable = () =>
      probeLlmPing(
        discoverClaudeBin(process.env),
        cfg.envFailure.probeModel,
        cfg.envFailure.probeMaxBudgetUsd,
        cfg.envFailure.probeTimeoutSec,
      );
    const result = await runDriver({
      forge,
      state,
      supervisor,
      cfg,
      mergeGate,
      now: systemClock,
      tickIntervalSec: cfg.engine.tickIntervalSec,
      stopMode,
      stop,
      probeLlmReachable,
      log,
      ...(fixLegResume !== undefined ? { fixLegResume } : {}),
      ...(engineAgent !== null ? { engineAgentDriveDeps: engineAgent.driveDepsForLane } : {}),
      onTick: (result) => {
        log(formatTickSummary(result));
        overrides.onTick?.(result);
      },
    });
    // #76: name the condition that fired BEFORE the generic stop-summary line, when one did.
    if (result.stopCondition) {
      log(formatStopConditionLine(result.stopCondition));
    }
    log(`[sapwood:run] stopped after ${result.ticks} tick(s), ${result.tickErrors} tick error(s) (${result.stoppedBy})`);
    // #407 (item 1): the clean-exit terminal — stoppedBy is driver.ts's own StopReason verbatim;
    // stopCondition names the goal that fired, when one did (with --once the hit is named but
    // stoppedBy stays "once" — runDriver's own contract, mirrored here unchanged).
    appendRunEnded(
      state,
      { stoppedBy: result.stoppedBy, ...(result.stopCondition !== undefined ? { stopCondition: result.stopCondition.name } : {}) },
      log,
    );
    return runExitCode(result, stopMode);
  } catch (error) {
    // #407 (item 1): a thrown startup pass / driver error still exits THROUGH the process's own
    // control (main()'s catch -> exit 1) — a controlled failure, not a crash, so it closes the
    // run boundary too, with the error preserved. Best-effort: appendRunEnded never masks the
    // real error below.
    appendRunEnded(state, { stoppedBy: "error", error: String(error) }, log);
    throw error;
  }
}

/** #106: the round-orchestrator path (`round.ts`'s `runRounds`), wired with the REAL default
 *  peripherals (`round-defaults.ts`'s `createDefaultPeripherals`) sharing one `RoleRunner` — the
 *  same wiring shape round-defaults.test.ts's integration tests already prove end-to-end, now
 *  reached from `sapwood run` itself instead of only from a test/library caller (#106's
 *  acceptance criterion). Every safety behavior (KILL_SWITCH, cost ceilings, drain-before-kill,
 *  graceful-stop-still-runs-harvest) lives in round.ts/state.ts unchanged — this function only
 *  wires the real collaborators runRounds needs, it adds no safety logic of its own. */
async function runRoundsEngine(
  argv: string[],
  cfg: SapwoodConfig,
  overrides: EngineOverrides,
  lockTakeover?: LockTakeoverRecord,
): Promise<number> {
  const { logger, path: logPath } = createRunLogger(cfg, overrides.logger);
  const log = logger.log.bind(logger);
  log(`[sapwood:run] startup logPath=${logPath}`);
  // Same fail-fast stance as the tick driver above: a broken worker.promptFile must abort
  // startup before any dispatch — the round loop's `executing` phase still dispatches workers
  // via WorkerSupervisor exactly like the tick driver does.
  const renderPrompt = buildRenderPrompt(cfg);
  // #245 round-2 fix A7: same fail-fast stance for worker.fixPromptFile — see runTickEngine's
  // own comment above. #253: captured (not discarded) — RoundDeps.renderFixPrompt below, paired
  // with round.ts's OWN per-round mintProxy construction (buildFixLegResume) so each round's
  // fix-loop proxy carries THAT round's id as its audit identity, unlike the tick driver's fixed
  // round-0 identity (buildTickFixLegResume) — see round.ts's own doc for why this can't be
  // built once here the way the tick driver's fixLegResume is.
  const renderFixPrompt = buildRenderFixPrompt(cfg);
  const state = overrides.state ?? new State();
  appendRunStarted(state, cfg);
  // #407 (item 1, gate② P2): the run boundary's closing bracket — same contract as
  // runTickEngine's own comment above: the bracket opens IMMEDIATELY after the successful
  // run-started append, so every write of this run (takeover event included) sits inside it and
  // every controlled exit appends exactly one `run-ended`; the watchdog's process.exit and a
  // hard kill stay out by construction.
  try {
    // #382 round 2 (codex PR #467 finding 4): the takeover event lands AFTER `run-started`,
    // inside this run's replay group — see runTickEngine's own comment above.
    if (lockTakeover !== undefined) {
      state.appendEvent("instance-lock-taken-over", { lockPath: lockTakeover.lockPath, previousPid: lockTakeover.previousPid });
    }
    // #431 (owner amendment 1): the rapid-restart detector, strictly AFTER appendRunStarted —
    // see runTickEngine's own comment above.
    detectRapidRestart(state, cfg, systemClock, log);
    // #407: the stall breaker — same placement pattern as the rapid-restart detector above; see
    // runTickEngine's own comment and stall-breaker.ts's doc.
    detectConsecutiveStalls(state, cfg, systemClock, log);
    // #438: same both-channel wiring as runTickEngine above.
    const forge = overrides.forge ?? new GithubForge(cfg, { log, state });
    const engineReviewRunner =
      cfg.reviewer.mode === "engine-agent" ? new RoleRunner({ cfg, ...overrides.roleRunnerDeps, log, state, now: systemClock }) : null;
    const engineAgent = engineReviewRunner
      ? makeProductionEngineAgent(cfg, forge, state, engineReviewRunner, {
          now: systemClock,
          ...(overrides.roleRunnerDeps?.worktreeRoot !== undefined ? { worktreeRoot: overrides.roleRunnerDeps.worktreeRoot } : {}),
        })
      : null;
    const reviewer = engineAgent?.reviewer ?? makeReviewer(cfg);
    const fallbackReviewers = makeFallbackReviewers(cfg);
    const mergeGate = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers });
    const supervisor = new WorkerSupervisor({
      cfg,
      log,
      now: systemClock,
      // #377: same branch+marker association as the tick driver above.
      lanePr: buildLanePrAssociator(forge, log),
      renderPrompt,
      // #244 (Codex sol-high PR #260 review round 2, P2): same durable mint-failure observability
      // as the tick-driver path above, wired into the round-orchestrator's own WorkerSupervisor.
      state,
    });
    // #253: a default forge MCP proxy mint, shared by every peripheral role session this
    // RoleRunner instance ever runs across the whole `sapwood run` (round 0 / phase "peripheral"
    // is its own fixed SENTINEL audit identity, informational only — see buildTickFixLegResume's
    // own doc for why this never claims a real (round, phase, attempt) tuple; peripheral role
    // sessions have no single round at RoleRunner-construction time, unlike the round-scoped
    // fix-loop mint below, which is built fresh per round). A per-session RoleSessionOpts.proxy
    // (none of round-defaults.ts's stubs supply one today) would still win — see peripheral.ts's
    // RoleRunnerDeps.defaultProxy doc.
    //
    // #253 review round 2 (H1, PM-narrowed three-state ruling — see buildTickFixLegResume's own
    // doc for the full rationale): `enabled && !shadow` gates PRODUCTION ATTACHMENT here too — with
    // `shadow: true` (the default once enabled), NO RoleRunner ever gets a defaultProxy, so no
    // peripheral session anywhere holds a handle; the shadow guarantee is structural rather than a
    // per-consumer effect check. Only `enabled: true, shadow: false` (the deliberate go-live flip)
    // constructs one. `enabled: false` (the default): unchanged, today's behavior.
    const defaultProxy =
      cfg.proxy.enabled && !cfg.proxy.shadow
        ? { mint: createProxyMint({ cfg, forge, state, roundId: 0, phase: "peripheral", now: systemClock, log }) }
        : undefined;
    const runner = new RoleRunner({
      cfg,
      ...overrides.roleRunnerDeps,
      log,
      state,
      now: systemClock,
      ...(defaultProxy !== undefined ? { defaultProxy } : {}),
    });
    const peripherals = createDefaultPeripherals({ forge, state, cfg, runner, now: systemClock, log });
    const stop = resolveStopConfig(argv, cfg);
    // #76: same fail-fast stance as the tick driver — a typo'd milestone goal must abort startup
    // with zero dispatch, checked here identically for the round path's own FINAL stop condition.
    await assertStopMilestoneExists(forge, stop);
    await normalizeUnplacedBoardItems(forge, state, log);
    // #379 F1: same best-effort startup-pass stance as the board normalization above — provisions
    // any workflow label this repo is missing so the round's own label writes can land.
    await reconcileWorkflowLabels(forge, state, cfg, log);
    // #410 amendment: same best-effort startup-pass stance as the board normalization above —
    // detects, never blocks, never mutates.
    checkWebAccessSettingsDenial(cfg, state, log);
    // #385 F10: same stance again — announces the `prFixCap > 0` + unattached-fix-loop
    // combination ONCE here, rather than leaving it to surface per-escalation on an already
    // needs-human PR. See announceFixLoopUnattached's own doc.
    announceFixLoopUnattached(cfg, state, log);
    await reconcileStartup(forge, state, cfg, log);
    // #391 F19: same best-effort startup pass — correct the gated-reentry marker on lanes whose
    // hold label is observably live, so removing that label is the only manual step a human needs.
    await auditGatedEscalationFlags(forge, state, cfg, log);
    // #447 F28 residual: same best-effort startup pass, deliberately AFTER the F19 audit — a lane
    // whose hold label is live has just been handed back to gated reentry, so it is already out of
    // this pass's candidate set and only the never-escalated ones remain. A restart DURING a park
    // episode revives nothing: the episode is durable, and the pass suspends itself on it exactly
    // as the tick does (PR #463 round 2).
    await reviveEnvFailedPrLanes(forge, state, cfg, log);
    sweepStaleRoleSessions(state, {
      log,
      ...(overrides.roleRunnerDeps?.stateDir !== undefined ? { stateDir: overrides.roleRunnerDeps.stateDir } : {}),
      ...(overrides.roleRunnerDeps?.worktreeRoot !== undefined ? { worktreeRoot: overrides.roleRunnerDeps.worktreeRoot } : {}),
    });
    log(`[sapwood:run] driver=rounds tickIntervalSec=${cfg.engine.tickIntervalSec}`);
    // #168 (P1-1 amendment): same real LLM-source ping probe as the tick driver above.
    const probeLlmReachable = () =>
      probeLlmPing(
        discoverClaudeBin(process.env),
        cfg.envFailure.probeModel,
        cfg.envFailure.probeMaxBudgetUsd,
        cfg.envFailure.probeTimeoutSec,
      );
    const result = await runRounds({
      forge,
      state,
      supervisor,
      cfg,
      mergeGate,
      now: systemClock,
      ...(engineAgent !== null ? { engineAgentDriveDeps: engineAgent.driveDepsForLane } : {}),
      tickIntervalSec: cfg.engine.tickIntervalSec,
      peripherals,
      // #212: restrict the executing phase's dispatch to this round's pool (round-defaults.ts's
      // aligning wrapper always populates it, PO on or off — see selectRoundPool/AC7).
      poolLabel: cfg.labels.roundPool,
      stop,
      probeLlmReachable,
      log,
      // #253: paired with cfg.proxy.enabled inside round.ts's own buildFixLegResume — see this
      // function's own comment above for why the mint itself is built per-round, there, rather
      // than passed in from here.
      renderFixPrompt,
      onTick: (tickResult) => {
        log(formatTickSummary(tickResult));
        overrides.onTick?.(tickResult);
      },
      ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}),
      ...(overrides.registerSignals !== undefined ? { registerSignals: overrides.registerSignals } : {}),
      onRoundPhase: (roundId, phase) => {
        log(`[sapwood:round] round ${roundId}: phase ${phase} completed`);
        overrides.onRoundPhase?.(roundId, phase);
      },
      onRoundStop: (roundId, hit) => {
        log(`[sapwood:round] round ${roundId}: stop ${hit.name} (${hit.detail})`);
        overrides.onRoundStop?.(roundId, hit);
      },
    });
    if (result.stopCondition) {
      log(formatStopConditionLine(result.stopCondition));
    }
    log(
      `[sapwood:run] stopped after ${result.rounds} round(s), ${result.ticks} tick(s), ` +
        `${result.tickErrors} tick error(s) (${result.stoppedBy})`,
    );
    // #407 (item 1): the clean-exit terminal — stoppedBy is RoundsResult's own value verbatim
    // (signal / stop-condition / kill-switch).
    appendRunEnded(
      state,
      { stoppedBy: result.stoppedBy, ...(result.stopCondition !== undefined ? { stopCondition: result.stopCondition.name } : {}) },
      log,
    );
    return roundsExitCode(result);
  } catch (error) {
    // #407 (item 1): same controlled-failure bracket as runTickEngine's own catch.
    appendRunEnded(state, { stoppedBy: "error", error: String(error) }, log);
    throw error;
  }
}

/** #106 (gate② P2): the tick-only flags a rounds run must REJECT, not silently ignore. A user
 *  following the documented trust ramp who types `sapwood run --once` expects a single bounded
 *  tick; under the rounds default that flag has no meaning (a round has no single-tick concept),
 *  and silently starting a long-running round loop instead would invert the run-duration
 *  semantics the flag exists to bound. Returns the actionable error message, or null when no
 *  tick-only flag is present (--dry-run is NOT tick-only — main() routes it to runDryRun before
 *  any driver runs, so it stays driver-agnostic). Pure + exported for testing, same split as
 *  parseRunStopMode/runExitCode. */
export function tickOnlyFlagError(argv: string[]): string | null {
  const present = ["--once", "--until-idle"].filter((f) => argv.includes(f));
  if (present.length === 0) return null;
  return (
    `sapwood run: ${present.join("/")} only apply to the tick driver — set \`engine.driver: tick\` ` +
    `in config, or drop the flag (rounds runs have no single-tick concept; use ` +
    `--stop-after-issues/--stop-after-prs/--stop-on-milestone to bound a rounds run)`
  );
}

/** #106: `sapwood run`'s engine dispatcher — resolves config once, then routes to the round
 *  orchestrator (default, `cfg.engine.driver: "rounds"`) or the M4 tick-driver escape hatch
 *  (`cfg.engine.driver: "tick"`). `overrides` is production-empty (see EngineOverrides doc);
 *  tests pass fakes to drive this exact function — the real `main()` entry point — instead of
 *  reimplementing its wiring. */
export async function runEngine(argv: string[], overrides: EngineOverrides = {}, validatedRun?: ValidatedRunArgs): Promise<number> {
  // Production hands in runCli's validated token, so argv is parsed once at the entry boundary.
  // Exported direct callers do not get a bypass: validate once here before touching config,
  // collaborators, or state.
  if (validatedRun === undefined) {
    const validation = runCli(argv);
    if (validation.code !== -1 || validation.validatedRun === undefined) {
      if (validation.stdout) process.stdout.write(validation.stdout);
      if (validation.stderr) process.stderr.write(validation.stderr);
      return validation.code === -1 ? 1 : validation.code;
    }
    validatedRun = validation.validatedRun;
  }
  // #129: fold --milestone's round-scope half in here, once, before either driver sees cfg —
  // this run's `round.milestone` override applies regardless of which driver runs, though only
  // the round orchestrator (round.ts) actually reads it for dispatch scoping.
  // EngineOverrides.cfg is a tests-only injection seam and keeps its established precedence.
  // Production passes no override, so the CLI path is handed to loadConfig verbatim.
  const cfg = applyMilestoneOverride(argv, overrides.cfg ?? loadConfig(validatedRun.configPath));
  if (cfg.engine.driver !== "tick") {
    // Gate② P2: fail fast on tick-only flags BEFORE any collaborator is constructed or any
    // dispatch can happen — same abort-with-zero-dispatch stance as buildRenderPrompt /
    // assertStopMilestoneExists startup validation.
    const flagError = tickOnlyFlagError(argv);
    if (flagError) {
      process.stderr.write(`${flagError}\n`);
      return 1;
    }
  }
  // #382 round 2 (codex PR #467 finding 3): the cheap eager config validations come FIRST — a
  // broken worker.promptFile/fixPromptFile must reject before the lock is taken and before the
  // DB is even opened (round 1 had displaced this fail-fast behind State construction). The
  // drivers still build their own renderers; these calls are validation-only, the same
  // discard-the-renderer stance runValidate/runDryRun already take.
  buildRenderPrompt(cfg);
  buildRenderFixPrompt(cfg);
  // #382 (F9): single-instance lock on the data dir, acquired BEFORE State exists — a refused
  // second engine must perform ZERO writes against the holder's data dir, and constructing a
  // State opens + migrates the shared SQLite DB (a NEWER binary would upgrade the live
  // holder's schema on its way to exit 1 — codex finding 3). The lock path is therefore
  // derived without a State: from the injected test state's own data dir when present
  // (in-memory -> null -> no-op acquire, the killSwitchPath convention), else from the same
  // DEFAULT_DB_PATH the State default constructor uses, with only the plain data DIR created
  // up front (the lockfile needs a parent; an empty dir write-conflicts with nobody).
  let lockPath: string | null;
  if (overrides.state !== undefined) {
    lockPath = overrides.state.instanceLockPath();
  } else {
    const dataDir = dirname(DEFAULT_DB_PATH);
    mkdirSync(dataDir, { recursive: true });
    lockPath = join(dataDir, INSTANCE_LOCK_FILENAME);
  }
  const lock = acquireInstanceLock(lockPath, {
    now: systemClock,
    ...(overrides.pidLiveness !== undefined ? { isPidAlive: overrides.pidLiveness } : {}),
  });
  if (!lock.acquired) {
    process.stderr.write(`sapwood run: ${lock.message}\n`);
    return 1;
  }
  try {
    let lockTakeover: LockTakeoverRecord | undefined;
    if (lock.tookOver !== null && lock.lockPath !== null) {
      // Takeover is the crash+restart drill working as designed — observable, never silent.
      // The log line lands now; the DURABLE event is handed to the drivers so it can land
      // after `run-started`, inside this run's replay group (appendRunStarted, finding 4).
      console.error(
        `[sapwood:startup] took over stale instance lock at ${lock.lockPath} ` +
          `(previous holder pid ${lock.tookOver.pid ?? "unparseable"} is gone)`,
      );
      lockTakeover = { lockPath: lock.lockPath, previousPid: lock.tookOver.pid };
    }
    if (cfg.engine.driver === "tick") return await runTickEngine(argv, cfg, overrides, lockTakeover);
    return await runRoundsEngine(argv, cfg, overrides, lockTakeover);
  } finally {
    // The one shutdown seam every exit path already funnels through: runTickEngine/
    // runRoundsEngine RETURN on kill-switch, stop conditions, --once, and graceful signals
    // (round.ts's registerSignals requests a stop; the loop drains and returns), and a thrown
    // startup/driver error propagates through here too. Only a hard death (SIGKILL, crash)
    // skips this — exactly the stale-lock case the dead-pid takeover above recovers.
    lock.release();
  }
}

async function main(argv: string[]): Promise<number> {
  const { stdout, stderr, code, validatedRun } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== -1) return code;

  if (argv[2] === "run") {
    // Validated above (runCli's run-flag block) — a bare presence check is safe here.
    if (argv.slice(3).includes("--dry-run")) {
      return runDryRun({}, validatedRun?.configPath);
    }
    return runEngine(argv, {}, validatedRun);
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
