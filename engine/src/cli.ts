#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
// `sapwood` CLI. M0.5 shipped `init`; `run` (the M4 loop driver, #46) and `validate` (#49)
// landed next; `status` + `run --dry-run` (#15) land here. The plugin's slash commands
// (/sapwood-run, /sapwood-status, /sapwood-stop) are thin wrappers that shell out to this CLI
// — see ../../commands/.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import {
  configHash,
  DEFAULT_CONFIG_PATHS,
  dashboardConfigSubset,
  engineAgentEmptyCiRequiredChecksError,
  loadConfig,
  type SapwoodConfig,
} from "./config/config.js";
import { findRate, loadPricingTable, type PricingTable } from "./config/pricing.js";
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
import { createBranchProtectionDetector } from "./loop/branch-protection-warning.js";
import { type FixLegResumeDeps, orderForDispatch, type TickResult } from "./loop/conductor.js";
import {
  type BrowserOpenResult,
  type DashboardServerHandle,
  dashboardServerEntryPath,
  openBrowserReal,
  type StartDashboardServerOpts,
  startDashboardServer,
  waitForStopSignal,
} from "./loop/dashboard-launcher.js";
import { detectDeployKeyStartupTier } from "./loop/deploy-key-startup-check.js";
import { unadjudicatedConcerns } from "./loop/dissent.js";
import { type DriverResult, runDriver, type StopConditionHit, type StopConfig, type StopMode } from "./loop/driver.js";
import { InitError, init, requiredLabels } from "./loop/init.js";
import { acquireInstanceLock } from "./loop/instance-lock.js";
import { type EngineLogger, FileEngineLogger } from "./loop/logger.js";
import { detectManagedPermissionMode } from "./loop/managed-permission-warning.js";
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
import { type PeripheralPhase, RoundScopedForge, type RoundStopHit, type RoundsResult, runRounds } from "./loop/round.js";
import { createDefaultPeripherals } from "./loop/round-defaults.js";
import { detectConsecutiveStalls } from "./loop/stall-breaker.js";
import { createUserSettingsWatch } from "./loop/user-settings-watch.js";
import { createProxyMint } from "./proxy/mint.js";
import { makeProductionEngineAgent } from "./review/production.js";
import { MergeDriver } from "./roles/merge-driver.js";
import { RoleRunner, type RoleRunnerDeps } from "./roles/peripheral.js";
import { makeFallbackReviewers, makeReviewer } from "./roles/reviewer.js";
import { resolveSkillsPluginDir } from "./roles/skills-plugin.js";
import { buildRenderFixPrompt, buildRenderPrompt, discoverClaudeBin, probeLlmPing, WorkerSupervisor } from "./roles/worker.js";
// #642: event-kinds registry validation for `events --kind`/`--exclude-kind` arguments (the
// #425 registry's own doc: "add [a narrowing guard] with its first real caller" — this is it).
import { EVENT_KIND_NAMES, isKnownEventKind } from "./state/event-kinds/index.js";
// #642: the shared read-model — `status --json`/`events` build their DTOs off this module,
// the SAME one dashboard/server.ts's routes now import from (read-model.ts's own header
// comment has the full extraction rationale).
import {
  buildLaneAnchors,
  buildStatusDTO,
  DEFAULT_DASHBOARD_PORT,
  type LaneAnchorsDTO,
  MAX_PAGE_LIMIT,
  probePidAlive,
  READ_MODEL_FORMAT_VERSION,
  resolveConfigProvenance,
} from "./state/read-model.js";
import {
  DEFAULT_DB_PATH,
  INSTANCE_LOCK_FILENAME,
  PARK_SOURCES,
  type ParkRow,
  type ParkSource,
  SCHEMA_VERSION,
  SqliteBusyError,
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
    --config PATH  Load config from this path instead of probing the defaults (#710:
                   authoritative when given — a bad path is a hard error, never a silent
                   fallback to the probe)
    --json         Machine-readable status (formatVersion 1) instead of the text summary
  events [db-path]  Read the event ledger straight from SQLite (the codified monitor recipe)
    --config PATH      Load config from this path instead of probing the defaults (#710:
                       same authoritative posture as status's --config, above)
    --since-id N       Only events with id > N (default 0)
    --kind K           Only this kind (repeatable; not combinable with --exclude-kind)
    --exclude-kind K   Every kind EXCEPT this one (repeatable; not combinable with --kind)
    --limit N          Page size, hard-capped (see --help)
    --json             Machine-readable events instead of the text listing
  park clear     Clear a park episode receipt-first (refuses under a live engine)
    --source SOURCE  Clear only this park source (default: every open episode)
  pause [clear]  Create/remove the data/PAUSE sentinel — freeze new dispatch only, in-flight
                 lanes proceed normally (see --help for the full tier semantics)
  stop [clear]   Create/remove the data/KILL_SWITCH sentinel — freeze dispatch/merges, drain
                 in-flight workers, then hard-kill (see --help)
  estop [clear]  Create/remove the data/EMERGENCY_STOP sentinel — immediate hard kill, no
                 drain, in-flight WIP is lost. Activating REQUIRES --confirm (see --help)
  dashboard      Start the read-only dashboard server and open it in a browser (see --help)
    --port PORT    Bind this port instead of the default (see --help)
    --config PATH  Load config from this path instead of probing the defaults (#710)
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
                 (data/sapwood.sqlite), EMERGENCY_STOP/KILL_SWITCH/PAUSE, sessions, and
                 worktree roots remain relative to the current working directory.
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
usage: sapwood status [db-path] [--config PATH] [--json]

Read the engine's SQLite state DB directly (no live engine session required) and print
a human-readable summary: active lanes/workers, PRs awaiting the review gate, spend vs
the daily ceiling, and kill-switch state.

Defaults to data/sapwood.sqlite (the same path \`sapwood run\` writes to). Also loads the
sapwood config for lanes.max and the daily cost ceiling: WITHOUT --config, the same
best-effort default probe order \`validate\` uses (sapwood.config.yaml/.yml/.json) — a
missing/invalid config there still prints every DB-derived field, with the config-derived
ones shown as "unknown", and the TEXT summary now stamps which path (if any) it resolved
on its own "config:" line, so an operator can see at a glance whether the numbers below it
came from the config they meant (#710 — the live trap this closes: \`status\` silently
reading the repo's committed config instead of a differently-named run config, rendering
the WRONG daily budget cap with no visible sign anything was off).

Flags:
  --config <path>  Load config from THIS path instead of probing the defaults — same
                    resolution semantics as \`run --config\`. Authoritative once given: a
                    missing/unreadable/invalid file here is a HARD error (exit 1, before any
                    DB read), never a silent fallback to the default probe or to "unknown"
                    fields — the opposite of the no-flag case above, which stays best-effort
                    on purpose (a config-less cwd is a legitimate, common case for a bare DB
                    inspection).
  --json           Print a machine-readable DTO (formatVersion 1) instead of the text
                    summary above — a DOCUMENTED PROJECTION (never a raw DB row), additive-
                    only: a future sapwood may add fields to this shape, never remove/rename/
                    retype one at this format version, and a client MUST ignore fields it
                    does not recognize rather than fail on them (#642). Spend is reported as
                    settled-per-worker + unclassified + an explicit incompleteness flag —
                    never a fabricated $0.00 for spend this DTO could not attribute (e.g.
                    #612's engine-review sessions, until #645's follow-up gives them their
                    own line). The config section is available (with provenance = the
                    resolved path) only when loadConfig actually succeeded — same "unknown
                    on a config error" stance the text summary above already has, now
                    structural (\`{available: false}\`) instead of the string "unknown".
  --help, -h       Print this help and exit

On a DB whose schema version this build does not understand (older OR newer than what it
migrates to), both status and events REFUSE to interpret rows (never migrate, never guess)
but still report a schema-independent read: the two schema versions plus the raw event
ledger's row count and max id (#710) — a SELECT COUNT(*)/MAX(id) FROM events and nothing
else, so the rebuild -> first-run window is degraded, not blind.
`;

/** #582: one line (or "") warning that the configured gate② reviewer is priced BELOW the worker
 *  it gates. D5 (config.ts's top-level superRefine) enforces that the two models DIFFER but says
 *  nothing about ORDERING, so a config can legitimately parse with the weaker model reviewing the
 *  stronger one's output — which inverts gate②'s authority, since the conductor merges on its
 *  verdict. The shipped defaults now state the rule (worker opus / reviewer fable); this catches
 *  an override that re-inverts it.
 *
 *  A WARNING, never a rejection, and deliberately so: model strings are free-form and the rate
 *  table is a hand-maintained COST proxy for capability, not a capability signal — a hard fail
 *  would reject legitimate setups (a cross-vendor `runner: codex-exec` reviewer whose rates
 *  aren't comparable to a Claude worker's at all). Silent whenever there is no comparison to
 *  make: no engine-agent reviewer, or EITHER model absent from the loaded table — hence findRate
 *  (no fallback) rather than resolveRate, whose most-expensive-tier fallback for an unknown model
 *  would invent a comparison the operator never configured. Ordering matches
 *  pricing.ts's own most-expensive rule: input rate, tie-broken by output rate. */
function reviewerTierWarning(cfg: SapwoodConfig, pricing: PricingTable): string {
  const reviewerModel = cfg.reviewer.agent?.model;
  if (reviewerModel === undefined) return "";
  const worker = findRate(cfg.worker.model, pricing);
  const reviewer = findRate(reviewerModel, pricing);
  if (worker === undefined || reviewer === undefined) return "";
  const cheaper = reviewer.input < worker.input || (reviewer.input === worker.input && reviewer.output < worker.output);
  if (!cheaper) return "";
  return (
    `sapwood validate: WARNING — reviewer is cheaper/weaker than worker: reviewer.agent.model ` +
    `"${reviewerModel}" ($${reviewer.input}/$${reviewer.output} per MTok in/out) is priced below worker.model ` +
    `"${cfg.worker.model}" ($${worker.input}/$${worker.output}) — gate quality expectation is inverted. ` +
    `The reviewer's tier should sit AT OR ABOVE the producer's (docs/configuration.md, #582); rates are only a ` +
    `proxy, so this is advice, not a rejection.\n`
  );
}

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
    const pricing = loadPricingTable(cfg);
    const resolvedPath = path ?? DEFAULT_CONFIG_PATHS.find(existsSync);
    return {
      // Warnings share stdout with the OK line: this function's stderr means "validation failed"
      // (its only other writer is the catch below, always with code 1), and a warning must not
      // blur that. Exit stays 0 — see reviewerTierWarning for why this can only ever advise.
      stdout:
        reviewerTierWarning(cfg, pricing) +
        `sapwood validate: OK — ${resolvedPath} (lanes.max=${cfg.lanes.max}, guard.mode=${cfg.guard.mode}, merge.mode=${cfg.merge.mode})\n`,
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
 *  so it stays a rough upper bound, not a replay of the exact next tick. The other half of real
 *  eligibility — cfg.round.milestone scoping — is applied by the CALLER's forge (runDryRun wraps
 *  in RoundScopedForge, #561), so `ready` here is already the in-scope pool. */
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
  const inner = overrides.forge ?? new GithubForge(cfg);
  // #561: milestone scoping is part of REAL dispatch eligibility — the rounds driver reads Ready
  // through this same wrapper (round.ts), so an unscoped preview both prices issues the run would
  // never dispatch and hides the actual in-scope pool. Reusing the wrapper (not the driver) keeps
  // runDryRun driver-agnostic: undefined milestone stays plain passthrough.
  const forge = cfg.round.milestone ? new RoundScopedForge(inner, cfg.round.milestone) : inner;
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
  /** #642: `--json` — print the machine-readable StatusDTO instead of formatStatus's text. */
  json: boolean;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, dbPath: "data/sapwood.sqlite", json: false };
  }
  const positionals: string[] = [];
  let configPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--config") {
      // Value-taking flag: the operand must exist and not be another flag — `--config` at the
      // end of the line (silently loading the DEFAULT config) or `--config --bogus` (silently
      // consuming the flag as a "path") would both report status from the wrong config with
      // exit 0 (Codex PR #70 P2). Fail closed instead.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { help: false, error: "--config requires a path", dbPath: "data/sapwood.sqlite", json: false };
      }
      configPath = next;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { help: false, error: `unknown flag: ${a}`, dbPath: "data/sapwood.sqlite", json: false };
    }
    positionals.push(a);
  }
  return { help: false, dbPath: positionals[0] ?? "data/sapwood.sqlite", configPath, json };
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
  /** #293: the immediate-hard-stop sentinel (data/EMERGENCY_STOP) — mirrors killSwitchActive's
   *  reporting. Distinct from it: e-stop skips the drain window entirely (kill-switch drains
   *  first), and takes precedence when both are set. */
  estopActive: boolean;
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
  /** #710: the resolved config path `lanesMax`/`dailyBudgetUsd` above were read from (an explicit
   *  `--config` or the default probe's find), or undefined when neither found anything — stamped
   *  on its own "config:" line so a human glancing at the numbers above always knows which file
   *  produced them. OPTIONAL for the same hand-built-fixture reason `laneAnchors` below is:
   *  `formatStatus`'s own pre-#710 unit tests construct a `StatusSnapshot` directly and don't
   *  care about this line; omitting it renders the "none found" line, never a thrown lookup. */
  configProvenance?: string | undefined;
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
  /** #705: per-lane runtime anchors (pid/aliveness/worktree/heartbeat age), keyed by lane name —
   *  one entry per `active` row, built by `buildLaneAnchors` (read-model.ts, the SAME function
   *  `status --json`'s StatusLaneDTO uses, so the two surfaces can never disagree). OPTIONAL: a
   *  hand-built snapshot fixture (formatStatus's own unit tests) that doesn't care about this
   *  feature can omit it entirely — `formatStatus` renders every anchor as unknown for a lane
   *  with no entry, never a thrown lookup. The real `runStatus` path below always populates it. */
  laneAnchors?: Record<string, LaneAnchorsDTO>;
}

/** #705: `formatStatus`'s own "no anchors known" fallback — used both when `laneAnchors` itself
 *  is absent (a pre-#705 test fixture) and when a specific lane has no entry in it. Never
 *  fabricates a dead/alive verdict; `pidAlive: "unknown"` is the same honest value `buildLaneAnchors`
 *  itself reports for a pid-less lane. */
const UNKNOWN_LANE_ANCHORS: LaneAnchorsDTO = { pid: null, pidAlive: "unknown", worktreePath: null, lastHeartbeat: null };

export function formatStatus(s: StatusSnapshot): string {
  const running = s.active.filter((w) => w.state === "running");
  const lines: string[] = [
    `sapwood status — ${s.dbPath} (schema v${s.schemaVersion})`,
    // #710: loud config provenance — which file (if any) lanesMax/dailyBudgetUsd below came from.
    configProvenanceLine(s.configProvenance),
    "",
    `lanes: ${s.active.length}/${s.lanesMax ?? "unknown"} active ` + `(${running.length} running, ${s.driving.length} driving)`,
  ];
  for (const w of s.active) {
    const pr = w.pr ? `  PR #${w.pr}` : "";
    // #705: per-lane runtime anchors — pid/aliveness, worktree path, newest heartbeat age.
    const a = s.laneAnchors?.[w.name] ?? UNKNOWN_LANE_ANCHORS;
    const pidStr =
      a.pid == null ? "pid unknown" : `pid ${a.pid} (${a.pidAlive === true ? "alive" : a.pidAlive === false ? "DEAD" : "alive: unknown"})`;
    const worktreeStr = a.worktreePath == null ? "worktree unknown" : `worktree ${a.worktreePath}`;
    // #705 gate② P1-2: id + ts + ageSec — an operator correlating a stale heartbeat with the
    // ledger needs the event id/timestamp, not just how old it is.
    const hbStr =
      a.lastHeartbeat == null
        ? "no heartbeat yet"
        : `heartbeat #${a.lastHeartbeat.id} ${a.lastHeartbeat.ts} (${a.lastHeartbeat.ageSec}s ago)`;
    // #705 AC3: a lane the LEDGER believes is running/fixing but whose pid is confirmed dead is
    // the feature — render it visibly distinct, never blended into an ordinary status line.
    const mismatch = (w.state === "running" || w.state === "fixing") && a.pidAlive === false;
    const mismatchTag = mismatch ? "  !!! BELIEF-VS-REALITY MISMATCH: ledger says in-flight, pid is DEAD !!!" : "";
    lines.push(
      `  ${w.state.padEnd(8)} ${w.name}   issue #${w.issue}${pr}   started ${w.started_at}   ${pidStr}   ${worktreeStr}   ${hbStr}${mismatchTag}`,
    );
  }
  lines.push("", `gated PRs (awaiting review gate): ${s.driving.length}`);
  for (const w of s.driving) {
    lines.push(`  PR #${w.pr ?? "?"}  issue #${w.issue}  lane ${w.name}`);
  }
  const dailyBudget = s.dailyBudgetUsd != null ? `$${s.dailyBudgetUsd.toFixed(2)}` : "unknown (no config found)";
  lines.push(
    "",
    `spend: $${s.dailySpendUsd.toFixed(2)} / ${dailyBudget} daily ceiling`,
    `e-stop: ${s.estopActive ? "ACTIVE" : "inactive"}`,
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
/** #642: `SqliteBusyError` -> the CLI's own structured/text rendering, shared by `status --json`
 *  and `events` — a locked writer must produce this within the finite busy timeout (state.ts's
 *  own doc), never a hang, and never the raw node:sqlite message. `--json` gets a structured
 *  `{formatVersion, error: {kind: "busy", timeoutMs, message}}` body on stderr; the text path
 *  gets one clean line. Exit 1 either way — a busy DB is a real failure to retry, not a "nothing
 *  to show" success. */
function busyResult(command: string, e: SqliteBusyError, json: boolean): { stdout: string; stderr: string; code: number } {
  if (json) {
    const body = { formatVersion: READ_MODEL_FORMAT_VERSION, error: { kind: "busy" as const, timeoutMs: e.timeoutMs, message: e.message } };
    return { stdout: "", stderr: `${JSON.stringify(body)}\n`, code: 1 };
  }
  return { stdout: "", stderr: `sapwood ${command}: ${e.message}\n`, code: 1 };
}

/** #710: `runValidate`'s own load-error rendering, lifted out so `status`/`events` can format an
 *  explicit-`--config` failure identically — ZodError -> one line per field issue, anything else
 *  (missing file, unreadable, ...) -> the bare error message (already names the path, same as
 *  Node's own ENOENT text). */
export function formatConfigLoadError(command: string, e: unknown): string {
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    return `sapwood ${command}: invalid config:\n${issues}\n`;
  }
  return `sapwood ${command}: ${(e as Error).message}\n`;
}

/** #710: `status`/`events`' shared `--config` resolution — mirrors `run --config`'s posture
 *  (parseRunConfigFlag's own doc: "a missing or flag-shaped operand is always an error, never a
 *  fallback to cwd probing"), extended to the LOAD itself: an EXPLICIT `--config PATH` is
 *  authoritative, so its failure (missing/unreadable/invalid) is a HARD error the caller must
 *  fail closed on — never the silent degrade-to-"unknown" that an OMITTED `--config`'s
 *  best-effort default probe has always used (and keeps using here: `ok: true` with `cfg`
 *  undefined is the normal, non-fatal "no config anywhere" case for that path, exactly the
 *  pre-#710 behavior). `cfg`/`provenance` are always BOTH set or BOTH undefined together — never
 *  one without the other — so a caller never has to reconcile them separately. */
export function resolveCliConfig(
  configPath: string | undefined,
): { ok: true; cfg: SapwoodConfig | undefined; provenance: string | undefined } | { ok: false; error: unknown } {
  if (configPath !== undefined) {
    try {
      return { ok: true, cfg: loadConfig(configPath), provenance: configPath };
    } catch (e) {
      return { ok: false, error: e };
    }
  }
  try {
    return { ok: true, cfg: loadConfig(undefined), provenance: resolveConfigProvenance(undefined, existsSync) };
  } catch {
    // Best-effort probe found nothing usable — reported as "unknown" fields downstream, never
    // fatal (the DB read is the point of `status`/`events` even with no config in sight).
    return { ok: true, cfg: undefined, provenance: undefined };
  }
}

/** #710: the TEXT-output "which config, if any" line both `status` and `events` stamp right
 *  under their header — the loud provenance the issue asks for (JSON already carries this via
 *  the `config` DTO field). Deliberately the SAME line shape regardless of whether the path came
 *  from an explicit `--config` or the default probe: an operator glancing at the numbers below
 *  it needs to know WHICH file produced them, not how it was found. */
function configProvenanceLine(provenance: string | undefined): string {
  return provenance === undefined
    ? `config: none found (probed ${DEFAULT_CONFIG_PATHS.join(", ")}) — config-derived fields below are unknown`
    : `config: ${provenance}`;
}

/** #710: the schema-window-honesty refusal both `status` and `events` render when userVersion()
 *  disagrees with SCHEMA_VERSION — same refusal text as before (fail-closed stands, neither
 *  command ever migrates), now WITH the schema-independent read (State.rawEventLedgerSummary's
 *  own doc) appended: the DB is degraded, not blind. `--json` gets a structured
 *  `{formatVersion, error: {kind: "schema-mismatch", ...}}` body on stderr, matching busyResult's
 *  own precedent above; the text path gets one line with the raw count/max-id folded in. */
function schemaMismatchResult(
  command: string,
  dbPath: string,
  dbVersion: number,
  raw: { count: number; maxId: number } | null,
  json: boolean,
): { stdout: string; stderr: string; code: number } {
  const hint =
    dbVersion > SCHEMA_VERSION
      ? "newer than this sapwood understands — upgrade sapwood"
      : `older than this sapwood — run the engine (sapwood run) to migrate it; ${command} never migrates`;
  const message = `DB schema v${dbVersion} at ${dbPath} is ${hint} (engine schema v${SCHEMA_VERSION})`;
  if (json) {
    const body = {
      formatVersion: READ_MODEL_FORMAT_VERSION,
      error: {
        kind: "schema-mismatch" as const,
        dbVersion,
        expectedVersion: SCHEMA_VERSION,
        message,
        // #710: the schema-independent read — null (not 0) when even the events table itself is
        // missing, so a client can tell "zero events" apart from "nothing to report at all".
        rawEventCount: raw?.count ?? null,
        maxEventId: raw?.maxId ?? null,
      },
    };
    return { stdout: "", stderr: `${JSON.stringify(body)}\n`, code: 1 };
  }
  const rawLine =
    raw === null
      ? "schema-independent read: unavailable (the events table itself is missing)"
      : `schema-independent read: ${raw.count} event(s) in the ledger, max id ${raw.maxId}`;
  return { stdout: "", stderr: `sapwood ${command}: ${message} — ${rawLine}\n`, code: 1 };
}

export function runStatus(argv: string[]): { stdout: string; stderr: string; code: number } {
  const parsed = parseStatusArgs(argv);
  if (parsed.help) return { stdout: STATUS_USAGE, stderr: "", code: 0 };
  if (parsed.error) {
    return { stdout: "", stderr: `sapwood status: ${parsed.error}\n\n${STATUS_USAGE}`, code: 1 };
  }
  const { dbPath, configPath, json } = parsed;
  // #710: config resolution happens BEFORE any DB access — an explicit --config's failure is a
  // hard error that must never depend on (or be masked by) whether the DB itself is readable.
  const configResult = resolveCliConfig(configPath);
  if (!configResult.ok) {
    return { stdout: "", stderr: formatConfigLoadError("status", configResult.error), code: 1 };
  }
  const { cfg, provenance: configProvenance } = configResult;
  if (!existsSync(dbPath)) {
    return { stdout: `sapwood status: no state DB at ${dbPath} — engine has never run\n`, stderr: "", code: 0 };
  }
  let state: State;
  try {
    state = new State(dbPath, { readOnly: true });
  } catch (e) {
    // #642: a locked writer at OPEN time (the constructor's own probe read) — see busyResult's
    // doc. Every other open failure (corruption, an unreadable file) is unchanged: it still
    // propagates uncaught, exactly as before this existed.
    if (e instanceof SqliteBusyError) return busyResult("status", e, json);
    throw e;
  }
  try {
    // #642 (Codex gate② round-1 P1 finding 2): the ENTIRE read sequence below — schema check
    // through DTO/snapshot construction — runs inside withBusyNormalization, so a lock acquired
    // by another connection AFTER the open above (which the constructor's own probe already
    // handles) surfaces on ANY of these reads as the same structured SqliteBusyError, not a raw
    // node:sqlite error from whichever individual State method happened to hit it.
    return state.withBusyNormalization(() => {
      const dbVersion = state.userVersion();
      if (dbVersion !== SCHEMA_VERSION) {
        // #710: fail-closed stands (never migrate/interpret rows), but degrade rather than go
        // blind — the raw event ledger read is schema-independent (State.rawEventLedgerSummary's
        // own doc).
        return schemaMismatchResult("status", dbPath, dbVersion, state.rawEventLedgerSummary(), json);
      }
      const reconcile = parseReconcileCompleted(state.latestEvent("reconcile-completed")?.payload);
      const concernEvents = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
      const unadjudicated = unadjudicatedConcerns(concernEvents).size;
      // #403: deliberate wall-clock read. `sapwood status` reports TODAY's spend/DTO generation
      // time as of the moment the operator runs it — a composition root, hence systemClock.
      const now = systemClock();
      if (json) {
        const dto = buildStatusDTO({
          state,
          dbPath,
          schemaVersion: dbVersion,
          cfg: cfg ?? null,
          configProvenance,
          now,
          unadjudicatedConcerns: unadjudicated,
          pidProbe: probePidAlive,
        });
        return { stdout: `${JSON.stringify(dto)}\n`, stderr: "", code: 0 };
      }
      const active = state.activeWorkers();
      // #705: one buildLaneAnchors call per active lane — same per-worker read shape
      // state.spentUsdForWorker already uses inside buildStatusDTO's own lanes.map, not a new
      // aggregation pattern.
      const laneAnchors: Record<string, LaneAnchorsDTO> = Object.fromEntries(
        active.map((w) => [w.name, buildLaneAnchors(state, w.name, w.issue, probePidAlive, now)]),
      );
      const snapshot: StatusSnapshot = {
        dbPath,
        schemaVersion: dbVersion,
        active,
        driving: state.drivingWorkers(),
        killSwitchActive: state.isKillSwitchActive(),
        estopActive: state.isEstopActive(),
        pauseActive: state.isPauseActive(),
        ceilingBreach: state.ceilingBreach(),
        dailySpendUsd: state.dailySpendUsd(now),
        lanesMax: cfg?.lanes.max ?? null,
        dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
        configProvenance,
        parked: state.parkedSources(),
        orphanReport: reconcile ? { orphans: reconcile.orphans, overflow: reconcile.overflow } : null,
        unadjudicatedConcerns: unadjudicated,
        baseCiRed: baseRedPin(state),
        laneAnchors,
      };
      return { stdout: formatStatus(snapshot), stderr: "", code: 0 };
    });
  } catch (e) {
    if (e instanceof SqliteBusyError) return busyResult("status", e, json);
    throw e;
  } finally {
    state.close();
  }
}

// ── #642: `sapwood events` — the codified dogfood monitor recipe, DB-only ──────────────────

/** #642: the terminal-friendly default page size for `events`' TEXT output — deliberately
 *  smaller than the dashboard's own DEFAULT_PAGE_LIMIT (500, read-model.ts): an operator
 *  glancing at a terminal wants a screenful, a polling dashboard client wants a bigger batch.
 *  The CAP (MAX_PAGE_LIMIT, shared with the dashboard) is the one number that must agree
 *  between the two surfaces; the default does not need to. */
const DEFAULT_EVENTS_LIMIT = 100;

/** #642: the busy_timeout `events` applies to its readOnly open/query — a smallish, finite wait
 *  (state.ts's DEFAULT_READONLY_BUSY_TIMEOUT_MS doc explains the "finite and non-zero" choice;
 *  this reuses that same default rather than inventing a second number with no reason to
 *  differ). */
const EVENTS_BUSY_TIMEOUT_MS = 2000;

const EVENTS_USAGE = `\
usage: sapwood events [db-path] [--config PATH] [options]

Read the engine's event ledger straight from SQLite (no live engine session required) — the
codified dogfood "monitor recipe" (#642): the same kind-filtered, id-cursor read a hand-rolled
polling loop used to reimplement per session, now one contract shared with the dashboard's own
\`/api/events\`.

Defaults to data/sapwood.sqlite (the same path \`sapwood run\` writes to).

Flags:
  --config PATH      Load config from THIS path instead of probing the defaults — same
                     resolution semantics as \`status --config\`/\`run --config\` (#710).
                     \`events\` itself reads no config-derived value today; this exists so an
                     operator running \`events --config X\` alongside \`status --config X\` gets
                     the SAME resolved-config story on both, stamped in the "config:" TEXT
                     line and the \`--json\` \`config\` field. Authoritative once given: a
                     missing/unreadable/invalid file here is a HARD error (exit 1, before any
                     DB read), never a silent fallback to the default probe.
  --since-id N       Only events with id > N (default 0; must be a non-negative integer)
  --kind K           Only events of this kind (repeatable — ORs together). Not combinable
                     with --exclude-kind (ambiguous precedence — pick one). An unknown kind
                     name is a REJECTED argument, naming the valid kinds from the #425
                     registry — an unrecognized kind ON A DB ROW (e.g. one a newer engine
                     wrote) is a different case and is always passed through opaque, never
                     rejected.
  --exclude-kind K   Every kind EXCEPT this one (repeatable). Not combinable with --kind.
  --issue N          Only events whose payload \`issue\` field equals N (a non-negative
                     integer). Composes with --kind/--exclude-kind (an AND, not an OR) — the
                     one-command answer to "why does issue N carry needs-human" (#655).
  --limit N          Page size (default ${DEFAULT_EVENTS_LIMIT}). Must be a positive integer,
                     hard-capped at ${MAX_PAGE_LIMIT} — a request above the cap is REJECTED
                     (not silently clamped): a script that asked for N and silently got fewer
                     is a worse failure mode than a clear error naming the cap.
  --tail N           The newest N events (same --kind/--exclude-kind/--issue filters as
                     above), instead of paging forward from --since-id — a non-negative
                     integer, hard-capped at ${MAX_PAGE_LIMIT} same as --limit. \`--tail 0
                     --json\` returns an empty \`events\` array plus \`nextSinceId\` set to the
                     ledger's CURRENT head: the canonical monitor cursor BOOTSTRAP (#709) —
                     \`sapwood events --tail 0 --json\` once to learn where "now" is, with no
                     history read at all, then poll \`sapwood events --since-id <nextSinceId>\`
                     from there, instead of a raw \`select max(id)\` against the sqlite file.
                     REJECTED together with --since-id (exit 1) — one cursor semantics, not an
                     invented interaction between "the N newest" and "everything after id X".
  --json             Print a machine-readable DTO (formatVersion 1) instead of the text
                     listing below — same additive-only/clients-ignore-unknown contract as
                     \`status --json\` (#642). Includes \`nextSinceId\`: the cursor for the NEXT
                     call — defined even on an empty filtered page (advances to the ledger's
                     current tail rather than leaving a poller stuck rescanning the same
                     range forever), and \`snapshot.mode\` ("live" or "immutable-fallback" —
                     see below).
  --help, -h         Print this help and exit

The kind filter is applied to the SQL WHERE clause BEFORE \`--limit\`/\`--tail\` — \`--kind merged
--limit 50\` returns up to 50 MERGED events, never up to 50 raw events filtered down to fewer;
\`--tail 5\` after the same filter returns the 5 newest MERGED events, not the 5 newest raw
events filtered down to fewer.

Under --tail, \`nextSinceId\` is always the ledger's CURRENT head, never the last shown row's
id — a --kind-filtered --tail page's last row is not necessarily the newest event in the whole
ledger, so a follow-up --since-id must never risk re-showing (or skipping) whatever happened in
between.

A writer holding the DB locked past a short, finite timeout is reported as a clear "busy, try
again" failure (exit 1) — never a hang. Reading through a read-only FILESYSTEM falls back to an
immutable snapshot that cannot see a currently-running engine's uncommitted-to-main rows; this
is reported (stderr, and \`snapshot.mode\` under --json), never silently under-reported as if it
were a live read.

On a DB whose schema version this build does not understand (older OR newer than what it
migrates to), \`events\` REFUSES to interpret rows (never migrates, never guesses) but still
reports a schema-independent read: the two schema versions plus the raw event ledger's row
count and max id (#710) — a SELECT COUNT(*)/MAX(id) FROM events and nothing else, so the
rebuild -> first-run window is degraded, not blind.
`;

export interface EventsArgs {
  help: boolean;
  error?: string | undefined;
  dbPath: string;
  configPath?: string | undefined;
  sinceId: number;
  kinds: string[];
  excludeKinds: string[];
  issue?: number | undefined;
  limit: number;
  json: boolean;
  /** #709: the newest-N read mode. `undefined` means the pre-#709 --since-id paging shape is
   *  unchanged; a number (0 included) means runEvents takes the eventsTailFiltered path instead
   *  of eventsPageFiltered — see EVENTS_USAGE's --tail doc for the --tail-0 bootstrap contract. */
  tail?: number | undefined;
}

const EVENTS_DEFAULTS = {
  dbPath: DEFAULT_DB_PATH,
  configPath: undefined as string | undefined,
  sinceId: 0,
  kinds: [] as string[],
  excludeKinds: [] as string[],
  issue: undefined as number | undefined,
  limit: DEFAULT_EVENTS_LIMIT,
  json: false,
  tail: undefined as number | undefined,
};

export function parseEventsArgs(argv: string[]): EventsArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, ...EVENTS_DEFAULTS };
  }
  const fail = (error: string): EventsArgs => ({ help: false, error, ...EVENTS_DEFAULTS });

  const positionals: string[] = [];
  let configPath: string | undefined;
  let sinceId = 0;
  let sinceIdGiven = false;
  const kinds: string[] = [];
  const excludeKinds: string[] = [];
  let issue: number | undefined;
  let limit = DEFAULT_EVENTS_LIMIT;
  let json = false;
  let tail: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--config") {
      // Same fail-closed value-taking parse as status's --config (Codex PR #70 P2): a missing
      // or flag-shaped operand is always an error, never a silent fallback to the default probe.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail("--config requires a path");
      configPath = next;
      i++;
      continue;
    }
    if (a === "--since-id") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail("--since-id requires a value");
      // #642 (Codex gate② round-1 P2 finding 4): CANONICAL decimal only. Number("0x10") is 16,
      // Number("1e3") is 1000 — plain-old-JS-numeric-literal forms nobody types as a cursor, and
      // silently accepting them means "--since-id 1e3" and "--since-id 1000" pick different-
      // looking rows for no operator-visible reason. /^\d+$/ rejects both (and any leading `+`/
      // decimal point) BEFORE Number() ever sees the string. Number.isSafeInteger below then
      // rejects a canonical-looking value too large to represent exactly (e.g. a 20-digit
      // string) — silently truncating/rounding a cursor id is worse than refusing it.
      if (!/^\d+$/.test(next)) return fail(`--since-id requires a non-negative integer, got: ${next}`);
      const n = Number(next);
      if (!Number.isSafeInteger(n)) return fail(`--since-id requires a non-negative integer, got: ${next}`);
      sinceId = n;
      // #709: tracked SEPARATELY from `sinceId` itself — the default (0) is indistinguishable
      // from an explicit `--since-id 0`, but the --tail/--since-id conflict below must reject the
      // latter and never the former (a caller who never touched --since-id must not be blocked
      // from --tail by the flag's own zero-value default).
      sinceIdGiven = true;
      i++;
      continue;
    }
    if (a === "--tail") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail("--tail requires a value");
      // Same canonical-decimal-only stance as --since-id/--limit/--issue above (Codex P2 finding
      // 4). Unlike --limit (positive-integer-only), 0 is a valid --tail value BY DESIGN — EVENTS_
      // USAGE's --tail doc: `--tail 0 --json` is the #709 cursor-bootstrap idiom, not an error.
      if (!/^\d+$/.test(next)) return fail(`--tail requires a non-negative integer, got: ${next}`);
      const n = Number(next);
      if (!Number.isSafeInteger(n)) return fail(`--tail requires a non-negative integer, got: ${next}`);
      if (n > MAX_PAGE_LIMIT) return fail(`--tail ${n} exceeds the hard cap of ${MAX_PAGE_LIMIT}`);
      tail = n;
      i++;
      continue;
    }
    if (a === "--limit") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail("--limit requires a value");
      // Same canonical-decimal-only stance as --since-id above (Codex P2 finding 4) — a page
      // size is likewise an operator/script-typed integer, never a JS numeric-literal form.
      if (!/^\d+$/.test(next)) return fail(`--limit requires a positive integer, got: ${next}`);
      const n = Number(next);
      if (n < 1) return fail(`--limit requires a positive integer, got: ${next}`);
      if (n > MAX_PAGE_LIMIT) return fail(`--limit ${n} exceeds the hard cap of ${MAX_PAGE_LIMIT}`);
      limit = n;
      i++;
      continue;
    }
    if (a === "--kind" || a === "--exclude-kind") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail(`${a} requires a value`);
      if (!isKnownEventKind(next)) {
        return fail(`unknown ${a}: ${next} (valid kinds: ${EVENT_KIND_NAMES.join(", ")})`);
      }
      (a === "--kind" ? kinds : excludeKinds).push(next);
      i++;
      continue;
    }
    if (a === "--issue") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return fail("--issue requires a value");
      // Same canonical-decimal-only stance as --since-id/--limit above (Codex P2 finding 4).
      if (!/^\d+$/.test(next)) return fail(`--issue requires a non-negative integer, got: ${next}`);
      const n = Number(next);
      if (!Number.isSafeInteger(n)) return fail(`--issue requires a non-negative integer, got: ${next}`);
      issue = n;
      i++;
      continue;
    }
    if (a.startsWith("-")) return fail(`unknown flag: ${a}`);
    positionals.push(a);
  }
  // #642 AC5: --kind + --exclude-kind together is REJECTED, never an invented precedence (which
  // one would win — an intersection? a union? neither is what either flag alone means).
  if (kinds.length > 0 && excludeKinds.length > 0) {
    return fail("--kind and --exclude-kind cannot combine (ambiguous precedence — pick one)");
  }
  // #709: --tail + --since-id together is REJECTED the same way — one cursor semantics, not an
  // invented interaction between "the N newest" and "everything after id X" (which would win,
  // and does the answer even mean anything for both at once?).
  if (tail !== undefined && sinceIdGiven) {
    return fail("--tail cannot combine with --since-id (one cursor semantics — pick one)");
  }
  return { help: false, dbPath: positionals[0] ?? DEFAULT_DB_PATH, configPath, sinceId, kinds, excludeKinds, issue, limit, json, tail };
}

/** One event row for `events`' text listing — same fields the `--json` DTO's `events` array
 *  carries, printed one per line. */
function formatEventsText(
  dbPath: string,
  configProvenance: string | undefined,
  snapshotMode: "live" | "immutable-fallback",
  rows: { id: number; ts: string; kind: string; payload: unknown }[],
  nextSinceId: number,
): string {
  const lines = [
    `sapwood events — ${dbPath}` + (snapshotMode === "immutable-fallback" ? " (immutable snapshot — live WAL frames not visible)" : ""),
    // #710: same loud provenance line status stamps — see configProvenanceLine's own doc.
    configProvenanceLine(configProvenance),
  ];
  if (rows.length === 0) {
    lines.push("(no matching events)");
  } else {
    for (const r of rows) lines.push(`#${r.id}  ${r.ts}  ${r.kind}  ${JSON.stringify(r.payload)}`);
  }
  lines.push(`nextSinceId: ${nextSinceId}`);
  return lines.join("\n") + "\n";
}

/** `sapwood events`: DB-only (no forge/GitHub read — the gated/needs-human queues live on
 *  GitHub and stay gh-side, per this issue's own non-goals), fully synchronous like
 *  status/validate/park. Opens read-only with a finite busy timeout (state.ts's own doc) and a
 *  short-lived read transaction per call (eventsPageFiltered's own doc) — never a long-held
 *  handle across multiple statements. */
export function runEvents(argv: string[]): { stdout: string; stderr: string; code: number } {
  const parsed = parseEventsArgs(argv);
  if (parsed.help) return { stdout: EVENTS_USAGE, stderr: "", code: 0 };
  if (parsed.error) {
    return { stdout: "", stderr: `sapwood events: ${parsed.error}\n\n${EVENTS_USAGE}`, code: 1 };
  }
  const { dbPath, configPath, sinceId, kinds, excludeKinds, issue, limit, json, tail } = parsed;
  // #710: same posture as runStatus — config resolution (and an explicit --config's hard
  // failure) happens BEFORE any DB access.
  const configResult = resolveCliConfig(configPath);
  if (!configResult.ok) {
    return { stdout: "", stderr: formatConfigLoadError("events", configResult.error), code: 1 };
  }
  const { cfg, provenance: configProvenance } = configResult;
  if (!existsSync(dbPath)) {
    return { stdout: `sapwood events: no state DB at ${dbPath} — engine has never run\n`, stderr: "", code: 0 };
  }
  let state: State;
  try {
    state = new State(dbPath, { readOnly: true, busyTimeoutMs: EVENTS_BUSY_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof SqliteBusyError) return busyResult("events", e, json);
    throw e;
  }
  try {
    // #642 (Codex gate② round-1 P1 finding 2): same whole-read-sequence busy normalization as
    // runStatus above — schema check through DTO/text construction, not just eventsPageFiltered
    // (which already normalizes internally) or the constructor's own open-time probe.
    return state.withBusyNormalization(() => {
      const dbVersion = state.userVersion();
      if (dbVersion !== SCHEMA_VERSION) {
        // #710: same degrade-not-blind refusal as runStatus above.
        return schemaMismatchResult("events", dbPath, dbVersion, state.rawEventLedgerSummary(), json);
      }
      const kindFilter = kinds.length > 0 ? { kinds } : excludeKinds.length > 0 ? { excludeKinds } : {};
      const filter = issue !== undefined ? { ...kindFilter, issue } : kindFilter;
      let rows: { id: number; ts: string; kind: string; payload: unknown }[];
      let nextSinceId: number;
      if (tail !== undefined) {
        // #709: the newest-N read. `nextSinceId` is ALWAYS the returned `tailId` (the ledger's
        // true head, read in the same transaction as the page) — never `rows[last].id` the way
        // the --since-id branch below computes it on a non-empty page. eventsTailFiltered's own
        // doc has the full reason: a --kind-filtered --tail page's last row is not necessarily
        // the newest event in the whole ledger, so anchoring the cursor to that row instead of
        // the true tail could let a follow-up --since-id re-show (or skip) whatever unfiltered
        // event landed newer than the last MATCHING row this page returned. `--tail 0` (LIMIT 0,
        // zero rows) is exactly the cursor-bootstrap case this makes correct: `nextSinceId` comes
        // back as the current head with no history read at all.
        const tailResult = state.eventsTailFiltered(filter, tail);
        rows = tailResult.rows;
        nextSinceId = tailResult.tailId;
      } else {
        // #642 (Codex gate② round-1 P1 finding 1): `tailId` comes back from the SAME call, the
        // SAME transaction/snapshot as `rows` — never a separate later `state.maxEventId()` call,
        // which is what let a matching event committed between the two reads get silently skipped
        // (eventsPageFiltered's own doc has the full race). `nextSinceId` on an empty page is that
        // shared tail, not a fresh independent read.
        const pageResult = state.eventsPageFiltered(sinceId, filter, limit);
        rows = pageResult.rows;
        // #642 AC5: an EMPTY filtered page still advances the cursor — a filtered `WHERE...LIMIT`
        // query with zero rows means (SQL evaluates the whole predicate, LIMIT only bounds OUTPUT)
        // that literally no matching event exists anywhere after sinceId, AS OF THE SAME SNAPSHOT
        // `tailId` was read from — so jumping the cursor to `tailId` never skips a real event: any
        // event that could match was either already in that snapshot (and would have matched) or
        // committed AFTER it (and is therefore still ahead of `tailId`, so a later call with
        // sinceId=tailId will see it).
        nextSinceId = rows.length > 0 ? rows[rows.length - 1]!.id : Math.max(sinceId, pageResult.tailId);
      }
      const snapshotMode: "live" | "immutable-fallback" = state.isImmutableSnapshot() ? "immutable-fallback" : "live";
      // #710: same availability/provenance shape as status --json's `config` field — see
      // StatusConfigSection's own doc for the "available iff loadConfig actually succeeded" stance.
      const config =
        cfg !== undefined && configProvenance !== undefined
          ? { available: true as const, provenance: configProvenance }
          : { available: false as const };
      if (json) {
        const dto = {
          formatVersion: READ_MODEL_FORMAT_VERSION,
          dbPath,
          snapshot: { mode: snapshotMode },
          config,
          events: rows,
          nextSinceId,
        };
        return { stdout: `${JSON.stringify(dto)}\n`, stderr: "", code: 0 };
      }
      return { stdout: formatEventsText(dbPath, configProvenance, snapshotMode, rows, nextSinceId), stderr: "", code: 0 };
    });
  } catch (e) {
    if (e instanceof SqliteBusyError) return busyResult("events", e, json);
    throw e;
  } finally {
    state.close();
  }
}

// ── #475: `sapwood park clear` — the engine-owned, receipt-first operator clear ─────────────

const PARK_USAGE = `\
usage: sapwood park clear [db-path] [--source SOURCE] [--reason "<text>"]

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
  --reason "<text>"  Recorded verbatim in the park-resumed receipt (as clearReason) and
                     echoed in stdout — the OPERATOR's reason for clearing, distinct from
                     the episode's own reason for entering park. Optional for a human running
                     this by hand; docs/supervision.md's governance section makes it REQUIRED
                     practice for an agent supervisor (#644). Rejected if empty or
                     whitespace-only text. Omitted entirely: behavior is unchanged from before
                     this flag existed.
  --help, -h       Print this help and exit
`;

/** Parsed \`sapwood park clear\` args — same flat shape and fail-closed flag handling as
 *  parseStatusArgs (help/error checked in order by the caller). Pure: no I/O. */
export interface ParkArgs {
  help: boolean;
  error?: string | undefined;
  dbPath: string;
  source?: ParkSource | undefined;
  /** #644: the operator's free-text clear reason — see PARK_USAGE. Undefined means the flag was
   *  never passed (the pre-#644 shape); never an empty string (parseParkArgs fails closed on
   *  empty/whitespace-only text before this field is ever set). */
  reason?: string | undefined;
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
  let reason: string | undefined;
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
    if (a === "--reason") {
      // #644: same value-taking fail-closed shape as --source above — a missing or flag-shaped
      // operand is rejected rather than silently consuming the NEXT flag as free text. A present
      // but empty/whitespace-only value is a SEPARATE failure (caught below): the operand parsed
      // fine syntactically, but recording "" as an audit reason is worse than refusing it — an
      // empty clearReason would look identical to no --reason at all to a later reader, silently
      // defeating the auditability this flag exists for.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { help: false, error: "--reason requires a value", dbPath: DEFAULT_DB_PATH };
      }
      if (next.trim() === "") {
        return { help: false, error: "--reason requires non-empty text", dbPath: DEFAULT_DB_PATH };
      }
      reason = next;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { help: false, error: `unknown flag: ${a}`, dbPath: DEFAULT_DB_PATH };
    }
    positionals.push(a);
  }
  return { help: false, dbPath: positionals[0] ?? DEFAULT_DB_PATH, source, reason };
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
  const { dbPath, source, reason } = parsed;
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
      const cleared = clearParksReceiptFirst(state, source ?? null, reason);
      if (cleared.length === 0) {
        const scope = source ? ` for source ${source}` : "";
        return { stdout: `sapwood park clear: no open park episode${scope} — nothing to clear\n`, stderr: "", code: 0 };
      }
      // #644: the clear-reason suffix is appended ONLY when --reason was given, so the no-flag
      // output stays byte-identical to before this flag existed (the reverse test park-clear.test.ts
      // pins). `p.reason` here is the EPISODE's own reason for entering park — unrelated to the
      // operator's `reason` for clearing it, hence the distinct "clear reason" label.
      const clearNote = reason !== undefined ? ` — clear reason: ${reason}` : "";
      const lines = cleared.map((p) => `  cleared ${p.source} (parked since ${p.enteredAt}) — reason: ${p.reason}${clearNote}`);
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

// ── #731: `sapwood pause` / `stop` / `estop` — first-class CLI verbs over the three file
// sentinels (data/PAUSE, data/KILL_SWITCH, data/EMERGENCY_STOP) state.ts's own pausePath/
// killSwitchPath/estopPath already define and conductor.ts's tick() already reads. THIN WRAPPERS
// ONLY (#731's own "架构优先/大道至简" instruction): every function below does nothing but
// create/remove one of those three files — the engine's tick-top detection is untouched, zero
// bytes of loop/state-machine code changed by this feature. Mirrors `sapwood park clear`'s own
// [db-path] positional + --config resolution shape: --config is validated the SAME way status/
// events do (#710 — authoritative once given, hard error on a bad path, never a silent
// fallback), but per run's own --config doc ("The DB ... EMERGENCY_STOP/KILL_SWITCH/PAUSE ...
// remain relative to the current working directory"), --config never changes WHICH sentinel file
// gets touched — only the optional [db-path] positional does that (same escape hatch status/park
// clear already give an operator or a test; the DB path's dirname is the sentinel's directory,
// exactly state.ts's own `dataDir = dirname(path)`).
//
// Verb shape: `sapwood <tier> [db-path] [--config PATH]` activates; `sapwood <tier> clear
// [db-path] [--config PATH]` clears — `clear` is recognized ONLY as the very first token (same
// precedent as `park clear`'s own `args[0] !== "clear"` check), so it can never be confused with
// a db-path positional. `estop` additionally requires `--confirm` to activate (owner ruling
// 2026-08-07, #731: "the confirmation is REQUIRED and not up for removal at review") — `clear`
// does not need it, since lifting an already-fired estop is not itself a destructive act.
//
// Idempotent both ways (AC: "re-activation idempotency, documented and tested") — activating an
// already-active tier, or clearing an already-inactive one, is a normal exit-0 no-op, same as a
// second `touch`/`rm -f` on the same path.

const SENTINEL_FILENAME = { pause: "PAUSE", stop: "KILL_SWITCH", estop: "EMERGENCY_STOP" } as const;
type SentinelTier = keyof typeof SENTINEL_FILENAME;

/** Parsed `sapwood pause|stop|estop [clear] [db-path] [--config PATH] [--confirm]` args. Pure
 *  (no I/O), same flat help/error shape every other subcommand parser here uses. `confirm` is
 *  only ever set to true when `allowConfirm` (estop only) — on pause/stop, `--confirm` falls
 *  through to the unknown-flag check below, never silently accepted. */
interface SentinelArgs {
  help: boolean;
  error?: string | undefined;
  mode: "activate" | "clear";
  dbPath: string;
  configPath?: string | undefined;
  confirm: boolean;
}

function parseSentinelArgs(argv: string[], allowConfirm: boolean): SentinelArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, mode: "activate", dbPath: DEFAULT_DB_PATH, confirm: false };
  }
  let mode: "activate" | "clear" = "activate";
  let rest = args;
  if (args[0] === "clear") {
    mode = "clear";
    rest = args.slice(1);
  }
  const positionals: string[] = [];
  let configPath: string | undefined;
  let confirm = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--config") {
      // Same fail-closed value-taking parse as status/events/park clear's own --config/--source:
      // a missing or flag-shaped operand is always an error, never a silent fallback to the
      // default probe.
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { help: false, error: "--config requires a path", mode, dbPath: DEFAULT_DB_PATH, confirm };
      }
      configPath = next;
      i++;
      continue;
    }
    if (allowConfirm && a === "--confirm") {
      confirm = true;
      continue;
    }
    if (a.startsWith("-")) {
      return { help: false, error: `unknown flag: ${a}`, mode, dbPath: DEFAULT_DB_PATH, confirm };
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    return { help: false, error: `unexpected argument(s): ${positionals.slice(1).join(" ")}`, mode, dbPath: DEFAULT_DB_PATH, confirm };
  }
  return { help: false, mode, dbPath: positionals[0] ?? DEFAULT_DB_PATH, configPath, confirm };
}

/** One tier's fixed copy: help text, the activation confirmation requirement, and the honest
 *  semantics sentence restated at both activation and in --help (owner ruling: "restate the
 *  destructive consequence" for estop; the other two get their own real, distinct semantics —
 *  never a templated placeholder). */
interface SentinelSpec {
  tier: SentinelTier;
  usage: string;
  requireConfirm: boolean;
  /** Printed on successful activation. `cfg` is the best-effort/explicit config load result
   *  (undefined when none was found/given) — used ONLY to enrich the message with a real
   *  configured number (e.g. stop's drain window) when available; never required for the
   *  command to function, matching status's own "config-derived fields are best-effort" stance. */
  activationLine: (cfg: SapwoodConfig | undefined) => string;
  clearLine: string;
}

const SENTINEL_SPECS: Record<SentinelTier, SentinelSpec> = {
  pause: {
    tier: "pause",
    requireConfirm: false,
    usage: `\
usage: sapwood pause [clear] [db-path] [--config PATH]

The gentle stop tier (#75): creates/removes the data/PAUSE file sentinel — a thin wrapper,
identical in effect to \`touch data/PAUSE\` / \`rm -f data/PAUSE\`. Freezes NEW lane dispatch
only, as of the engine's next tick-top gate: no in-flight lane is affected — running workers
keep working, and PRs already open keep moving through the review/merge gate. No drain, no
freeze, nothing killed.

  sapwood pause          Create data/PAUSE (idempotent: already-active is a no-op, exit 0)
  sapwood pause clear    Remove data/PAUSE (idempotent: already-inactive is a no-op, exit 0)

Flags:
  --config PATH  Load config from this path instead of probing the defaults — same #710
                 resolution semantics as \`status --config\`: authoritative once given, a
                 missing/invalid path is a hard error, never a silent fallback. Never changes
                 WHICH file gets touched (that is always [db-path]'s directory) — config is
                 read only to enrich this command's own messages.
  --help, -h     Print this help and exit
`,
    activationLine: () =>
      "no new lane dispatch as of the engine's next tick-top gate — in-flight lanes (running workers, open PRs at the review/merge gate) proceed exactly as normal.",
    clearLine: "dispatch resumes at the next tick-top gate, UNLESS a kill switch or emergency stop is also present (those win).",
  },
  stop: {
    tier: "stop",
    requireConfirm: false,
    usage: `\
usage: sapwood stop [clear] [db-path] [--config PATH]

The drain-first stop tier: creates/removes the data/KILL_SWITCH file sentinel — a thin
wrapper, identical in effect to \`touch data/KILL_SWITCH\` / \`rm -f data/KILL_SWITCH\`. Freezes
ALL new dispatch and merges as of the engine's next tick-top gate; running workers are asked
to hand off gracefully within the configured drain window, then the conductor escalates to a
hard kill. Use \`sapwood estop\` instead when the drain window itself is too slow (credential
exposure, a destructive call, or a cost blowout).

  sapwood stop          Create data/KILL_SWITCH (idempotent: already-active is a no-op, exit 0)
  sapwood stop clear    Remove data/KILL_SWITCH (idempotent: already-inactive is a no-op, exit 0)

Flags:
  --config PATH  Load config from this path instead of probing the defaults — same #710
                 resolution semantics as \`status --config\`: authoritative once given, a
                 missing/invalid path is a hard error, never a silent fallback. Never changes
                 WHICH file gets touched (that is always [db-path]'s directory); when it
                 resolves, cfg.cost.drainWindowSec is echoed in the activation message.
  --help, -h     Print this help and exit
`,
    activationLine: (cfg) => {
      const drain = cfg ? `${cfg.cost.drainWindowSec}s` : "the configured drain window (cfg.cost.drainWindowSec)";
      return (
        `new dispatch and merges freeze as of the engine's next tick-top gate; running workers get up to ${drain} to ` +
        "hand off before a hard kill."
      );
    },
    clearLine: "dispatch and merges resume at the next tick-top gate, UNLESS an emergency stop or pause is also present.",
  },
  estop: {
    tier: "estop",
    requireConfirm: true,
    usage: `\
usage: sapwood estop --confirm [clear] [db-path] [--config PATH]

The strictest stop tier (#293): creates/removes the data/EMERGENCY_STOP file sentinel — a
thin wrapper, identical in effect to \`touch data/EMERGENCY_STOP\` / \`rm -f data/EMERGENCY_STOP\`.
Checked BEFORE the kill switch every tick and wins when both are present. In the normal path
it hard-kills every running/fixing lane's process group on that SAME tick: there is NO drain
window, and any IN-FLIGHT WORK-IN-PROGRESS IS LOST. Use it only for credential exposure, a
destructive call, or a cost blowout faster than \`sapwood stop\`'s drain window can contain.

  sapwood estop --confirm   Create data/EMERGENCY_STOP (idempotent: already-active is a no-op)
  sapwood estop clear       Remove data/EMERGENCY_STOP — does NOT require --confirm; lifting an
                            already-fired estop is not itself a destructive act, only review of
                            the emergency and any resulting escalations is.

Flags:
  --confirm      REQUIRED to activate (owner ruling, 2026-08-07: not up for removal at
                 review) — non-interactive, no TTY prompt, agent-friendly. Restates the
                 destructive consequence above; omitting it is a hard refusal, exit 1, no
                 sentinel written.
  --config PATH  Load config from this path instead of probing the defaults — same #710
                 resolution semantics as \`status --config\`. Never changes WHICH file gets
                 touched (that is always [db-path]'s directory).
  --help, -h     Print this help and exit
`,
    activationLine: () =>
      "every running/fixing lane is hard-killed immediately, this same tick — NO drain window, and any in-flight WIP is LOST. Clear only after human review, with `sapwood estop clear`.",
    clearLine: "a kill switch or pause, if still present, continues to apply.",
  },
};

function runSentinelCommand(argv: string[], spec: SentinelSpec): { stdout: string; stderr: string; code: number } {
  const parsed = parseSentinelArgs(argv, spec.requireConfirm);
  if (parsed.help) return { stdout: spec.usage, stderr: "", code: 0 };
  if (parsed.error) {
    return { stdout: "", stderr: `sapwood ${spec.tier}: ${parsed.error}\n\n${spec.usage}`, code: 1 };
  }
  const { mode, dbPath, configPath, confirm } = parsed;
  // #710: config resolution BEFORE any filesystem write — an explicit --config's failure must
  // never be masked by (or race) the sentinel write itself. Best-effort when omitted, exactly
  // resolveCliConfig's own contract (never fatal on its own).
  const configResult = resolveCliConfig(configPath);
  if (!configResult.ok) {
    return { stdout: "", stderr: formatConfigLoadError(spec.tier, configResult.error), code: 1 };
  }
  const filename = SENTINEL_FILENAME[spec.tier];
  // Same dataDir convention state.ts's own pausePath/killSwitchPath/estopPath use:
  // dirname(dbPath) — cwd-relative by default (DEFAULT_DB_PATH's own dirname is "data"), never
  // config-file-relative (see this section's header comment).
  const sentinelPath = join(dirname(dbPath), filename);

  if (mode === "clear") {
    if (!existsSync(sentinelPath)) {
      return { stdout: `sapwood ${spec.tier}: ${sentinelPath} was not present — nothing to clear.\n`, stderr: "", code: 0 };
    }
    rmSync(sentinelPath, { force: true });
    return { stdout: `sapwood ${spec.tier}: ${sentinelPath} removed — ${spec.clearLine}\n`, stderr: "", code: 0 };
  }

  // Activation. estop's owner-ruled confirmation gate runs BEFORE any write — a mis-fired estop
  // with no --confirm must leave the filesystem untouched, not merely print a warning after the
  // fact (#731: "the confirmation is REQUIRED and not up for removal at review").
  if (spec.requireConfirm && !confirm) {
    return {
      stdout: "",
      stderr:
        `sapwood ${spec.tier}: refusing to activate without --confirm — this is an IMMEDIATE hard kill with NO drain ` +
        `window; any in-flight work-in-progress is lost. Re-run with --confirm to proceed.\n\n${spec.usage}`,
      code: 1,
    };
  }
  if (existsSync(sentinelPath)) {
    return { stdout: `sapwood ${spec.tier}: ${sentinelPath} already ACTIVE — no change.\n`, stderr: "", code: 0 };
  }
  mkdirSync(dirname(sentinelPath), { recursive: true });
  writeFileSync(sentinelPath, "");
  return {
    stdout: `sapwood ${spec.tier}: ${sentinelPath} created — ${spec.activationLine(configResult.cfg)}\n`,
    stderr: "",
    code: 0,
  };
}

export function runPause(argv: string[]): { stdout: string; stderr: string; code: number } {
  return runSentinelCommand(argv, SENTINEL_SPECS.pause);
}

export function runStop(argv: string[]): { stdout: string; stderr: string; code: number } {
  return runSentinelCommand(argv, SENTINEL_SPECS.stop);
}

export function runEstop(argv: string[]): { stdout: string; stderr: string; code: number } {
  return runSentinelCommand(argv, SENTINEL_SPECS.estop);
}

// ── #743: `sapwood dashboard` — start the read-only data server + open a browser ───────────

const DASHBOARD_BUILD_HINT = "npm run build -w dashboard";

const DASHBOARD_USAGE = `\
usage: sapwood dashboard [--port PORT] [--config PATH]

Starts the dashboard's read-only data server (dashboard/server.ts) against the same state DB
\`sapwood run\`/\`status\` use (${DEFAULT_DB_PATH}), then opens it in your default browser. In a
headless/no-display environment where no browser can be opened, the server still runs — the URL
is printed instead, and the process keeps serving until you press Ctrl+C.

Flags:
  --port PORT    Bind this port instead of the default (${DEFAULT_DASHBOARD_PORT}). Overrides
                 SAPWOOD_DASHBOARD_PORT below when both are given.
  --config PATH  Load config from this path instead of probing the defaults — same #710
                 resolution semantics as \`status --config\`/\`events --config\`: authoritative
                 once given, a missing/invalid path is a hard error, never a silent fallback.
  --help, -h     Print this help and exit

Env:
  SAPWOOD_DASHBOARD_PORT  Same effect as --port, lower precedence. Must be a valid port number.

There is no --host/bind flag: the server binds 127.0.0.1 only, always (docs/security.md's
loopback-only posture) — this launcher has no way to change that.

Requires a built dashboard/dist bundle (${DASHBOARD_BUILD_HINT}); refuses to start, before any
browser-open attempt, if it is missing. A port already in use is reported by name, with this
flag/env var named as the fix — never a raw stack trace.
`;

/** Pure value-taking parse for \`--port\`, same fail-closed convention as parseRunConfigFlag/
 *  parseStopFlags: a missing/flag-shaped operand, or a value outside 1-65535, is an error, never
 *  silently ignored or clamped. */
export function parseDashboardPortFlag(argv: string[]): { rest: string[]; port?: number; error?: string } {
  const rest: string[] = [];
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token !== "--port") {
      rest.push(token);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return { rest, error: "--port requires a value" };
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { rest, error: `--port requires an integer between 1 and 65535, got: ${value}` };
    }
    port = n;
    i++; // consume the value token too
  }
  return port !== undefined ? { rest, port } : { rest };
}

export interface DashboardArgs {
  help: boolean;
  error?: string | undefined;
  configPath?: string | undefined;
  port?: number | undefined;
}

export function parseDashboardArgs(argv: string[]): DashboardArgs {
  const args = argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  const { rest: afterConfig, configPath, error: configError } = parseRunConfigFlag(args);
  if (configError) return { help: false, error: configError };
  const { rest, port, error: portError } = parseDashboardPortFlag(afterConfig);
  if (portError) return { help: false, error: portError };
  if (rest.length > 0) {
    return { help: false, error: `unknown argument(s): ${rest.join(" ")}` };
  }
  return { help: false, configPath, port };
}

/** \`--port\` wins over \`SAPWOOD_DASHBOARD_PORT\` wins over the shared default (read-model.ts's
 *  DEFAULT_DASHBOARD_PORT — the same value dashboard/server.ts binds to when given no explicit
 *  port). Always resolves to a CONCRETE port, never \`undefined\` — so a port-in-use error can
 *  always name the exact number that collided (AC4), regardless of how it was chosen. The env var
 *  gets the same integer-in-range validation as the flag: a malformed value is a hard error, never
 *  a silent fallback to the default. */
export function resolveDashboardPort(flagPort: number | undefined, env: NodeJS.ProcessEnv): { port: number } | { error: string } {
  if (flagPort !== undefined) return { port: flagPort };
  const raw = env.SAPWOOD_DASHBOARD_PORT;
  if (raw === undefined || raw === "") return { port: DEFAULT_DASHBOARD_PORT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { error: `SAPWOOD_DASHBOARD_PORT must be an integer between 1 and 65535, got: ${raw}` };
  }
  return { port: n };
}

/** Injection seam for \`runDashboard\` — every field defaults to the real implementation in
 *  loop/dashboard-launcher.ts (the ONLY module allowed to touch child_process for this feature —
 *  see that file's own header comment); tests override individual fields (never real
 *  \`execFile\`/child-process spawns, per #743's own verification plan) to exercise the
 *  orchestration logic in isolation. \`log\` follows this
 *  file's existing convention (e.g. normalizeUnplacedBoardItems' own \`log\` parameter, above) of
 *  an injectable message sink defaulting to \`console.error\`, rather than writing to
 *  \`process.stdout\`/\`process.stderr\` directly — a long-running command like this one prints as
 *  it goes (the "serving at" line has to appear before the indefinite wait, not be buffered until
 *  the process exits), so it needs a seam, not a returned string. */
export interface DashboardDeps {
  startServer?: (opts: StartDashboardServerOpts) => Promise<DashboardServerHandle>;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  waitForStop?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Overrides the dashboard/dist bundle probe path — real default: \`dashboard/dist/index.html\`
   *  relative to cwd, matching how \`sapwood run\`/\`status\` read data/ relative to cwd too. */
  dashboardDistIndex?: string;
  /** Overrides the compiled dashboard server entry probe path — real default:
   *  dashboardServerEntryPath() (dashboard/dist-server/start.js), the SAME file startServer's real
   *  implementation spawns. Checked alongside dashboardDistIndex above, before either the server
   *  starts or any browser-open attempt (AC5) — a stale/half-built \`dashboard/dist\` with no
   *  compiled server would otherwise fail confusingly deep inside startServer instead of with the
   *  one actionable "run the build command" message. */
  dashboardServerEntry?: string;
}

export interface ValidatedDashboardArgs {
  configPath?: string;
  port?: number;
}

/** \`sapwood dashboard\`'s async body — mirrors \`run\`'s split: \`runCli\` does the synchronous
 *  flag/help/error handling below, \`main()\` calls this for the validated success path. Order of
 *  checks matches the issue's own acceptance criteria: config (#710 contract) -> port -> dist
 *  bundle present (AC5: never opens a browser onto a broken page) -> start server (AC4: a clear
 *  port-in-use error, not a stack trace) -> open browser (AC2: headless never crashes). */
export async function runDashboard(validated: ValidatedDashboardArgs, deps: DashboardDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.error;

  const configResult = resolveCliConfig(validated.configPath);
  if (!configResult.ok) {
    log(formatConfigLoadError("dashboard", configResult.error).trimEnd());
    return 1;
  }

  const portResult = resolveDashboardPort(validated.port, env);
  if ("error" in portResult) {
    log(`sapwood dashboard: ${portResult.error}`);
    return 1;
  }

  const distIndex = deps.dashboardDistIndex ?? join("dashboard", "dist", "index.html");
  if (!existsSync(distIndex)) {
    log(`sapwood dashboard: no dashboard build found at ${distIndex} — run \`${DASHBOARD_BUILD_HINT}\` first, then retry.`);
    return 1;
  }
  const serverEntry = deps.dashboardServerEntry ?? dashboardServerEntryPath();
  if (!existsSync(serverEntry)) {
    log(`sapwood dashboard: no dashboard server build found at ${serverEntry} — run \`${DASHBOARD_BUILD_HINT}\` first, then retry.`);
    return 1;
  }

  const startServer = deps.startServer ?? startDashboardServer;
  let handle: DashboardServerHandle;
  try {
    handle = await startServer({
      dbPath: DEFAULT_DB_PATH,
      ...(validated.configPath !== undefined ? { configPath: validated.configPath } : {}),
      port: portResult.port,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      log(
        `sapwood dashboard: port ${portResult.port} is already in use — pick another with --port PORT or the ` +
          `SAPWOOD_DASHBOARD_PORT env var.`,
      );
      return 1;
    }
    log(`sapwood dashboard: failed to start — ${err.message}`);
    return 1;
  }

  const url = `http://127.0.0.1:${handle.port}`;
  const openBrowser = deps.openBrowser ?? openBrowserReal;
  const opened = await openBrowser(url);
  if (opened.opened) {
    log(`sapwood dashboard: serving at ${url} — opened in your default browser. Press Ctrl+C to stop.`);
  } else {
    log(
      `sapwood dashboard: serving at ${url} — could not open a browser automatically (${opened.reason}). ` +
        `Open the URL above manually. Press Ctrl+C to stop.`,
    );
  }

  const waitForStop = deps.waitForStop ?? waitForStopSignal;
  await waitForStop();
  await handle.stop();
  return 0;
}

// ── #638: `sapwood init` — same synchronous fail-closed argument boundary as every other
// subcommand, before the async engine-wiring fallthrough ──────────────────────────────────

const INIT_USAGE = `\
usage: sapwood init

Scaffold .sapwood config and verify GitHub auth: creates labels/milestones, the
project board, the starter config + goal/doctrine/issue templates, and (per #351)
provisions the worker's write deploy key and related gh-side resources — credentialed
network writes, so a bare \`--help\` must never trigger them (#638).

init takes no options today; any flag or extra argument is rejected rather than
silently ignored.

Flags:
  --help, -h     Print this help and exit
`;

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
  validatedDashboard?: ValidatedDashboardArgs;
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
  if (arg === "events") {
    return runEvents(argv);
  }
  if (arg === "park") {
    return runPark(argv);
  }
  if (arg === "pause") {
    return runPause(argv);
  }
  if (arg === "stop") {
    return runStop(argv);
  }
  if (arg === "estop") {
    return runEstop(argv);
  }
  if (arg === "dashboard") {
    const parsed = parseDashboardArgs(argv);
    if (parsed.help) return { stdout: DASHBOARD_USAGE, stderr: "", code: 0 };
    if (parsed.error) {
      return { stdout: "", stderr: `sapwood dashboard: ${parsed.error}\n\n${DASHBOARD_USAGE}`, code: 1 };
    }
    return {
      stdout: "",
      stderr: "",
      code: -1,
      validatedDashboard: {
        ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
        ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      },
    };
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
  // #638: give "init" the same synchronous fail-closed argument boundary as run/status/park —
  // a help request must never fall through toward init()'s credentialed gh-side writes (#351).
  const initFlags = argv.slice(3);
  if (initFlags.includes("--help") || initFlags.includes("-h")) {
    return { stdout: INIT_USAGE, stderr: "", code: 0 };
  }
  if (initFlags.length > 0) {
    // init takes no options — the empty whitelist IS the spec (widening it later is a one-line
    // change); any flag or operand here is rejected rather than silently swallowed.
    return { stdout: "", stderr: `sapwood init: unexpected argument(s): ${initFlags.join(" ")}\n\n${INIT_USAGE}`, code: 1 };
  }
  // Bare "init" falls through to the async path — signal caller to proceed.
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

/** #668 gate② finding (2026-08-05): reapAll()'s own outcome must never be silently discarded —
 *  an unconfirmed death (a process group that survived even SIGKILL, `ReapOutcome.confirmedDead
 *  === false`) is exactly the orphan-process-group defect AC4 forbids, not something a normal
 *  successful exit should paper over just because the run itself otherwise completed cleanly.
 *  Named and called from ONE place per run (both cli.ts run paths' success tail, immediately
 *  before their own exit-code return) so the failure is visible in the run's own exit status —
 *  never a blocking retry loop (that would trade a stranded-child defect for a hung-engine one,
 *  against the very "no engine-side resource watchdog" ruling #668 itself was scoped under) and
 *  never silently logged-only (the gap the finding named). `supervisor` undefined (no run ever
 *  constructed one) is the common, unremarkable case — resolves to `false` with no log line. */
async function reapAndSurfaceOrphans(supervisor: WorkerSupervisor | undefined, log: (message: string) => void): Promise<boolean> {
  const outcomes = await supervisor?.reapAll();
  const orphaned = outcomes?.filter((o) => !o.confirmedDead) ?? [];
  if (orphaned.length > 0) {
    log(
      `[sapwood:run] reap: ${orphaned.length} lane(s) still alive after grace period + SIGKILL — ` +
        `${orphaned.map((o) => o.name).join(", ")} (forcing a failed exit code; see worker.ts's reapChildren doc)`,
    );
  }
  return orphaned.length > 0;
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

/** #385 (F10), simplified by #551: the degraded-configuration announcement —
 *  `lanes.prFixCap > 0` (an operator has configured a fix loop) while `proxy.enabled` is
 *  explicitly `false` (an opt-out), so no live driver ever builds a real
 *  `TickDeps.fixLegResume` (buildTickFixLegResume / round.ts's buildFixLegResume both return
 *  `undefined`). Every FIXABLE gate then degrades to a `fix-loop-unwired:<reason>` needs-human
 *  escalation (conductor.ts, #246 C1). This says it ONCE at startup, per run: one log naming the
 *  opt-out, one durable event for the dashboard/replay. Pure detection, no behavior change.
 *
 *  Deliberately silent for the two NON-degraded halves of the matrix: `prFixCap: 0` is an
 *  operator's explicit opt-out (folding straight to needs-human IS the configured behavior, not
 *  a surprise), and `enabled: true` (#551 default) is the working configuration.
 *
 *  Same best-effort startup-pass stance as checkWebAccessSettingsDenial above: never blocks,
 *  never throws out, at most one log line + one event. Exported for direct testing. */
export function announceFixLoopUnattached(
  cfg: { lanes: Pick<SapwoodConfig["lanes"], "prFixCap">; proxy: Pick<SapwoodConfig["proxy"], "enabled"> },
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
): void {
  const { prFixCap } = cfg.lanes;
  const { enabled } = cfg.proxy;
  if (prFixCap <= 0 || enabled) return;
  const reason = "proxy-disabled";
  try {
    log(
      `[sapwood:startup] lanes.prFixCap=${prFixCap} but the fix loop is not production-attached ` +
        `(proxy.enabled=${enabled}) — every FIXABLE review gate will degrade to a needs-human escalation ` +
        "(fix-loop-unwired) instead of dispatching a fix leg; set `proxy.enabled: true` (docs/configuration.md, " +
        "`proxy`) to go live, or `lanes.prFixCap: 0` to make the fold explicit",
    );
    state.appendEvent("fix-loop-unattached", { prFixCap, proxyEnabled: enabled, reason });
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
  /** #633: injection seam for the branch-protection startup detector — same "production passes
   *  none" convention as `pidLiveness` above, but for a DIFFERENT reason: this check is a real
   *  `gh` network read (unlike every other detector in this neighborhood), so the real one only
   *  ever builds when BOTH this and `forge` are unset. Every existing test sets `forge`, so none
   *  of them ever spawns a real `gh` call without needing to know this field exists; a wiring
   *  test that specifically wants to observe/replace the check sets this directly instead of
   *  faking a `forge`-side capability. See branch-protection-warning.ts's own doc. */
  checkBranchProtection?: () => Promise<boolean>;
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

/** #106 (#293/#724 gate② finding [1] extends this to emergency-stop): exit code for a finished
 *  `sapwood run` under the round orchestrator. Rounds have no --once/--until-idle equivalent (no
 *  single-tick concept), so unlike runExitCode above this doesn't key off stopMode/ticks — a
 *  kill-switch OR emergency-stop stop is the one outcome that needs an operator to notice
 *  (cron/scripts should see it as a failure); a graceful signal or a final stop condition is the
 *  design working as intended, same as the tick driver's daemon-mode exit 0. */
export function roundsExitCode(result: Pick<RoundsResult, "stoppedBy">): number {
  return result.stoppedBy === "kill-switch" || result.stoppedBy === "emergency-stop" ? 1 : 0;
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
 *  #551 deleted the three-state model's middle state (`shadow` had no distinct runtime
 *  semantics — see config.ts's `ProxyConfig` doc). Two states now:
 *    1. `enabled: false` (opt-out): nothing constructed. This function returns `undefined`; no
 *       production attachment.
 *    2. `enabled: true` (#551 default): full production attachment — this function returns a
 *       real `FixLegResumeDeps`.
 *  A FIXABLE gate degrades to the pre-#246 needs-human escalation (#246 C1) in state 1, unchanged
 *  from before this issue — state 2 makes FIXUP dispatch itself live.
 *
 *  Observable guarantee in state 1 (#253 review round 2, H4 — narrowed from an overreaching
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
  if (!cfg.proxy.enabled) return undefined;
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
  // #639: same fail-fast stance as renderPrompt/renderFixPrompt above — `roles.skills.enabled`
  // (default false, so this is a no-op call for every deployment until flipped) renders the v1
  // skills plugin dir NOW, so a missing/duplicated docs/security.md marker aborts startup with
  // zero dispatch rather than failing lazily on a worker's first `--plugin-dir` spawn.
  // #639 gate② round 2 (honesty correction to round 1's overclaim): the three spread lines below
  // that thread this value into WorkerSupervisor's skillsPluginDir and RoleRunner's
  // defaultSkillsPluginDir — `...(skillsPluginDir !== undefined ? {...} : {})` — are pinned by NO
  // test. Deleting any one of them today leaves the whole suite green: worker.test.ts and
  // peripheral.test.ts only prove that WorkerDeps.skillsPluginDir/RoleRunnerDeps.
  // defaultSkillsPluginDir reach `--plugin-dir` ONCE SUPPLIED directly by a test, never that THIS
  // cli.ts wiring is what supplies them; skills-plugin.test.ts's resolver test proves only that
  // resolveSkillsPluginDir(cfg) itself returns the right directory, not that cli.ts threads it
  // anywhere. A live-engine-boot harness to close that gap was adjudicated disproportionate for a
  // capability that defaults off (`roles.skills.enabled: false`) in this v1. The actual closing
  // evidence is #641's live token-economics probe: it must observe the rendered skills reaching
  // REAL role sessions to measure anything, so a broken spread here would surface as that probe
  // finding no skill attached — this composition stays genuinely untested by an automated test
  // until then, and must be live-verified by #641 BEFORE `roles.skills.enabled` is ever flipped
  // to default-on.
  const skillsPluginDir = resolveSkillsPluginDir(cfg);
  const state = overrides.state ?? new State();
  appendRunStarted(state, cfg);
  // #668: hoisted above the try so the `finally` below can reap it regardless of which of the
  // try block's own exits ran — undefined until the try body actually constructs one (a
  // fail-fast startup throw before that point has nothing to reap).
  let supervisor: WorkerSupervisor | undefined;
  // #668 gate② finding: the success tail below reaps explicitly (to surface an unconfirmed
  // death in the exit code, see reapAndSurfaceOrphans) — this flag stops the `finally` from
  // reaping a second time on that path; on the catch/throw path it's still false, so `finally`
  // performs the (best-effort, exit-code-already-nonzero-via-the-throw) reap exactly once.
  let reaped = false;
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
    // #554: managed-settings allowManagedPermissionRulesOnly detection — same placement (after
    // the run boundary, startup continues either way), but no park/escalation: disclose + WARN
    // only, per the owner ruling. See managed-permission-warning.ts's own doc.
    detectManagedPermissionMode(log);
    // #633: sibling to detectManagedPermissionMode above — same non-throwing, fail-open,
    // warn-only stance, extended to the branch-protection precondition DR #616 names (twice) as
    // the mandatory platform backstop for a producer leg's inherited host tool surface. Unlike
    // its filesystem-only siblings this is a real network read, so the REAL detector only builds
    // in true production (overrides.forge/overrides.checkBranchProtection both unset, the only
    // combination `main()` itself ever passes) — every existing test sets `forge`, so none of
    // them ever spawns a real `gh` call; overrides.checkBranchProtection is the dedicated seam a
    // wiring test uses instead, to observe invocation count without faking `forge` at all. See
    // branch-protection-warning.ts's own doc.
    const checkBranchProtection =
      overrides.checkBranchProtection ??
      (overrides.forge === undefined ? createBranchProtectionDetector(`${cfg.board.owner}/${cfg.board.repo}`, log) : async () => false);
    await checkBranchProtection();
    // #615: snapshot/hash the operator's user-level settings ONCE, here, at startup — this IS the
    // "engine startup" moment the acceptance criteria describe. The returned closure is called
    // every tick below (onTick) to flag a later divergence; see user-settings-watch.ts's own doc.
    const checkUserSettingsDrift = createUserSettingsWatch(state, log);
    // #438: an engine session has both announcement channels, so a paging ceiling in the board or
    // review-thread reads lands in the durable event log, not only on stderr.
    const forge = overrides.forge ?? new GithubForge(cfg, { log, state });
    // #253: the tick driver's TickDeps.fixLegResume — undefined (no handle/listener/token/journal
    // write/argv change on any production session — see buildTickFixLegResume's own doc for the
    // exact observable guarantee) unless cfg.proxy is in its production-attach state
    // (proxy.enabled: true, #551 default).
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
    supervisor = new WorkerSupervisor({
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
      // #639: every worker leg this supervisor dispatches/resumes gets `--plugin-dir` attached
      // (fresh dispatch + resume/fix-entry are all YES per the policy table) — undefined
      // (no-op) whenever `roles.skills.enabled` is false.
      ...(skillsPluginDir !== undefined ? { skillsPluginDir } : {}),
    });
    // #671: startup deploy-key tier check — immediately after WorkerSupervisor construction so
    // it shares (seeds, never re-probes) THIS instance's memoized SSH preflight; see
    // deploy-key-startup-check.ts's own doc for the full placement rationale.
    await detectDeployKeyStartupTier(supervisor, cfg, state, log);
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
        // #615: rides the existing per-tick hook — no new driver plumbing needed.
        checkUserSettingsDrift();
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
    // #668 gate② finding: reap BEFORE computing the exit code, not after — an unconfirmed
    // orphan must be able to flip an otherwise-clean run to a failed exit code (see
    // reapAndSurfaceOrphans's own doc for why this beats a blocking retry or a log-only report).
    const orphaned = await reapAndSurfaceOrphans(supervisor, log);
    reaped = true;
    return orphaned ? 1 : runExitCode(result, stopMode);
  } catch (error) {
    // #407 (item 1): a thrown startup pass / driver error still exits THROUGH the process's own
    // control (main()'s catch -> exit 1) — a controlled failure, not a crash, so it closes the
    // run boundary too, with the error preserved. Best-effort: appendRunEnded never masks the
    // real error below.
    appendRunEnded(state, { stoppedBy: "error", error: String(error) }, log);
    throw error;
  } finally {
    // #668: the controlled-exit reap — covers the rethrow above (the success path already
    // reaped explicitly, see the `reaped` guard) so a lane still alive when the driver stopped
    // (normal completion OR a thrown error) never strands its child process. No-op when
    // `supervisor` never got constructed (a fail-fast startup throw before that line).
    if (!reaped) await supervisor?.reapAll();
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
  // #639: same fail-fast stance as runTickEngine's own comment above. #639 gate② round 2: same
  // untested-composition gap as runTickEngine's own comment above — no test covers the spread
  // lines below; #641's live token-economics probe is the closing evidence, required before
  // `roles.skills.enabled` ever defaults on.
  const skillsPluginDir = resolveSkillsPluginDir(cfg);
  const state = overrides.state ?? new State();
  appendRunStarted(state, cfg);
  // #668: same hoist-above-the-try as runTickEngine's own comment above — the `finally` below
  // reaps it regardless of exit path; undefined if a fail-fast startup throw runs before the
  // try body constructs one.
  let supervisor: WorkerSupervisor | undefined;
  // #668 gate② finding: same reap-once guard as runTickEngine's own comment above.
  let reaped = false;
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
    // #554: same placement/rationale as runTickEngine above — see managed-permission-warning.ts.
    detectManagedPermissionMode(log);
    // #633: same placement/rationale as runTickEngine above — see branch-protection-warning.ts's
    // own doc.
    const checkBranchProtection =
      overrides.checkBranchProtection ??
      (overrides.forge === undefined ? createBranchProtectionDetector(`${cfg.board.owner}/${cfg.board.repo}`, log) : async () => false);
    await checkBranchProtection();
    // #615: same placement/rationale as runTickEngine above — see user-settings-watch.ts's own
    // doc. The rounds driver's onTick (below) fires every raw tick exactly like the tick driver's
    // does, so the same closure works unchanged here.
    const checkUserSettingsDrift = createUserSettingsWatch(state, log);
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
    supervisor = new WorkerSupervisor({
      cfg,
      log,
      now: systemClock,
      // #377: same branch+marker association as the tick driver above.
      lanePr: buildLanePrAssociator(forge, log),
      renderPrompt,
      // #244 (Codex sol-high PR #260 review round 2, P2): same durable mint-failure observability
      // as the tick-driver path above, wired into the round-orchestrator's own WorkerSupervisor.
      state,
      // #639: same wiring as runTickEngine's own WorkerSupervisor above.
      ...(skillsPluginDir !== undefined ? { skillsPluginDir } : {}),
    });
    // #671: same placement/rationale as runTickEngine's own WorkerSupervisor above — immediately
    // after construction, so it shares (seeds, never re-probes) THIS instance's memoized SSH
    // preflight. See deploy-key-startup-check.ts's own doc.
    await detectDeployKeyStartupTier(supervisor, cfg, state, log);
    // #253: a default forge MCP proxy mint, shared by every peripheral role session this
    // RoleRunner instance ever runs across the whole `sapwood run` (round 0 / phase "peripheral"
    // is its own fixed SENTINEL audit identity, informational only — see buildTickFixLegResume's
    // own doc for why this never claims a real (round, phase, attempt) tuple; peripheral role
    // sessions have no single round at RoleRunner-construction time, unlike the round-scoped
    // fix-loop mint below, which is built fresh per round). A per-session RoleSessionOpts.proxy
    // (none of round-defaults.ts's stubs supply one today) would still win — see peripheral.ts's
    // RoleRunnerDeps.defaultProxy doc.
    //
    // #551 deleted the three-state model's middle state (see buildTickFixLegResume's own doc for
    // the full rationale): `cfg.proxy.enabled` alone gates PRODUCTION ATTACHMENT here too. With
    // `enabled: false` (opt-out), NO RoleRunner ever gets a defaultProxy, so no peripheral session
    // anywhere holds a handle. `enabled: true` (#551 default) constructs one for every peripheral
    // role session this RoleRunner instance runs. Review sessions never get one regardless — see
    // peripheral.ts's own doc: it throws on `proxy` + `reviewCwd`, forcing `proxyOpt = undefined`
    // in review mode, and both drivers construct their engine-review `RoleRunner`s without
    // `defaultProxy` — this file's own two construction sites (`runTickEngine`'s at cli.ts:1439,
    // `runRoundsEngine`'s at cli.ts:1609; round.ts constructs no `RoleRunner` at all).
    const defaultProxy = cfg.proxy.enabled
      ? { mint: createProxyMint({ cfg, forge, state, roundId: 0, phase: "peripheral", now: systemClock, log }) }
      : undefined;
    const runner = new RoleRunner({
      cfg,
      ...overrides.roleRunnerDeps,
      log,
      state,
      now: systemClock,
      ...(defaultProxy !== undefined ? { defaultProxy } : {}),
      // #639: every peripheral role session this RoleRunner instance runs (aligning/architecting/
      // plan_review/harvesting/retro) gets `--plugin-dir` attached via the policy table's
      // "peripheral-role" bucket — structurally excluded for review-mode sessions regardless
      // (RoleRunner.run() itself, not this wiring). Undefined (no-op) whenever
      // `roles.skills.enabled` is false.
      ...(skillsPluginDir !== undefined ? { defaultSkillsPluginDir: skillsPluginDir } : {}),
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
        // #615: rides the existing per-tick hook — no new round-loop plumbing needed.
        checkUserSettingsDrift();
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
    // #668 gate② finding: same explicit reap-before-exit-code as runTickEngine's own success
    // tail above — see reapAndSurfaceOrphans's doc.
    const orphaned = await reapAndSurfaceOrphans(supervisor, log);
    reaped = true;
    return orphaned ? 1 : roundsExitCode(result);
  } catch (error) {
    // #407 (item 1): same controlled-failure bracket as runTickEngine's own catch.
    appendRunEnded(state, { stoppedBy: "error", error: String(error) }, log);
    throw error;
  } finally {
    // #668: same reap-once guard as runTickEngine's own finally above.
    if (!reaped) await supervisor?.reapAll();
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
  // #784: fail closed BEFORE any other startup work — a config only `loadConfig`/`parseConfig`
  // warn about (reviewer.mode: engine-agent + empty ci.requiredChecks) would otherwise queue
  // every PR forever with no trusted CI evidence ever confirming it. See
  // engineAgentEmptyCiRequiredChecksError's own doc for why this check lives at `run` only.
  const ciConfigError = engineAgentEmptyCiRequiredChecksError(cfg);
  if (ciConfigError) {
    process.stderr.write(`${ciConfigError}\n`);
    return 1;
  }
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
  const { stdout, stderr, code, validatedRun, validatedDashboard } = runCli(argv);
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

  if (argv[2] === "dashboard") {
    return runDashboard(validatedDashboard ?? {});
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
