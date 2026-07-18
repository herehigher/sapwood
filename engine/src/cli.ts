#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
// `sapwood` CLI. M0.5 shipped `init`; `run` (the M4 loop driver, #46) and `validate` (#49)
// landed next; `status` + `run --dry-run` (#15) land here. The plugin's slash commands
// (/sapwood-run, /sapwood-status, /sapwood-stop) are thin wrappers that shell out to this CLI
// — see ../../commands/.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { DEFAULT_CONFIG_PATHS, loadConfig, type SapwoodConfig } from "./config/config.js";
import { loadPricingTable } from "./config/pricing.js";
import { GithubForge, type IForge, type Issue } from "./forge/forge.js";
import { orderForDispatch, type TickResult } from "./loop/conductor.js";
import { unadjudicatedConcerns } from "./loop/dissent.js";
import { type DriverResult, runDriver, type StopConditionHit, type StopConfig, type StopMode } from "./loop/driver.js";
import { InitError, init } from "./loop/init.js";
import { type EngineLogger, FileEngineLogger } from "./loop/logger.js";
import { parseReconcileCompleted, reconcileStartup, type StartupOrphan, sweepStaleRoleSessions } from "./loop/reconcile.js";
import { type PeripheralPhase, type RoundStopHit, type RoundsResult, runRounds } from "./loop/round.js";
import { createDefaultPeripherals } from "./loop/round-defaults.js";
import { MergeDriver } from "./roles/merge-driver.js";
import { RoleRunner, type RoleRunnerDeps } from "./roles/peripheral.js";
import { makeFallbackReviewers, makeReviewer } from "./roles/reviewer.js";
import { buildRenderPrompt, discoverClaudeBin, probeLlmPing, WorkerSupervisor } from "./roles/worker.js";
import { type ParkRow, SCHEMA_VERSION, State, type WorkerRow } from "./state/state.js";

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
usage: sapwood run [--once | --until-idle | --dry-run] [--milestone NAME] [--stop-* ...]

Run the engine. Default driver (cfg.engine.driver, "rounds"): the round orchestrator —
peripheral roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the
same dispatch-and-drain tick engine, one round at a time, until a signal or a \`stop.*\`
final condition winds the run down (the in-flight round always finishes, including
harvest, before the process exits). Set \`engine.driver: tick\` in config to run the bare
M4 loop driver instead: tick (reclaim -> drive -> resume -> dispatch) on
cfg.engine.tickIntervalSec's cadence, no peripherals — the pre-#106 behavior, kept
reachable as an explicit escape hatch.

Flags:
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
export async function runDryRun(overrides: Pick<EngineOverrides, "cfg" | "forge"> = {}): Promise<number> {
  const cfg = overrides.cfg ?? loadConfig();
  // Same fail-fast the real run does (#74): a broken worker.promptFile must surface in the
  // preview too — dry-run exists to predict the real run, not to green-light a config the
  // real run would reject at startup. Renderer is discarded; only validation matters here.
  buildRenderPrompt(cfg);
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
      const durationSec = Math.max(0, Math.floor((Date.now() - Date.parse(p.enteredAt)) / 1000));
      lines.push(
        `park: PARKED (${p.source}) since ${p.enteredAt} (${durationSec}s) — ` +
          `reason: ${p.reason} — no new dispatch; in-flight lanes proceed normally; ` +
          `probing on backoff, auto-resumes on recovery` +
          (p.canaryWorker ? ` — canary lane ${p.canaryWorker} in flight` : "") +
          (p.escalatedAt ? ` — escalated to a human at ${p.escalatedAt}` : ""),
      );
    }
  } else {
    lines.push("park: inactive");
  }
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
      dailySpendUsd: state.dailySpendUsd(new Date()),
      lanesMax: cfg?.lanes.max ?? null,
      dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
      parked: state.parkedSources(),
      orphanReport: reconcile ? { orphans: reconcile.orphans, overflow: reconcile.overflow } : null,
      unadjudicatedConcerns: unadjudicatedConcerns(concernEvents).size,
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
    // #129: pull --milestone out first — it's sugar for round.milestone + stop.onMilestoneComplete
    // together, and its VALUE token (a milestone name) must never be mistaken for an unknown bare
    // flag below, same reasoning as the --stop-* extraction that follows.
    const { rest: afterMilestone, milestone, error: milestoneError } = parseMilestoneFlag(flags);
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

/** Adopt GitHub's implicit No-Status board entries into the configured backlog once per
 *  engine start. This is deliberately separate from every dispatch read: Ready remains the
 *  only execution queue. Individual moves are best-effort so one malformed/stale item cannot
 *  prevent the engine from starting; the next startup naturally sees and retries any item
 *  whose move failed. */
export async function normalizeUnplacedBoardItems(
  forge: Pick<IForge, "listUnplacedIssues" | "setBoardStatus">,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
): Promise<void> {
  let unplaced: Awaited<ReturnType<IForge["listUnplacedIssues"]>>;
  try {
    unplaced = await forge.listUnplacedIssues();
  } catch (error) {
    log(`[sapwood:startup] could not list No-Status board items; normalization skipped: ${String(error)}`);
    return;
  }
  if (unplaced.skipped > 0) {
    log(`[sapwood:startup] skipped ${unplaced.skipped} No-Status draft/foreign-repo board item(s) outside this repo's write jurisdiction`);
  }
  for (const issue of unplaced.issues) {
    try {
      await forge.setBoardStatus(issue, "backlog");
      state.appendEvent("board-normalized", { issue, status: "backlog" });
    } catch (error) {
      log(`[sapwood:startup] issue #${issue}: failed to move No-Status item to backlog; continuing: ${String(error)}`);
    }
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
}

function createRunLogger(cfg: SapwoodConfig, override?: EngineLogger): { logger: EngineLogger; path: string } {
  const path = resolve(cfg.logging.path);
  return {
    path,
    logger: override ?? new FileEngineLogger({ path, teeToStderr: cfg.logging.teeToStderr, maxBytes: cfg.logging.maxBytes }),
  };
}

function formatTickSummary(result: TickResult): string {
  return (
    `[sapwood:tick] reclaimed=${result.reclaimed.length} dispatched=${result.dispatched.length} ` +
    `driven=${result.driven.length} resumed=${result.resumed.length} rollbacks=${result.rollbacks.length} ` +
    `gatedReclaimed=${result.gatedReclaimed.length} ` +
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

/** #106: `WorkerSupervisor`'s hasOpenPr/findOpenPr need `GithubForge`'s own
 *  `findOpenPrForIssue` — not part of the narrower `IForge` interface every fake forge in tests
 *  (round-defaults.test.ts's FakeForge, etc.) implements. Production `forge` is always a real
 *  GithubForge (EngineOverrides.forge is unset), so this always resolves to the real method
 *  there; a test-injected bare-IForge fake falls back to "no open PR found", which is fine
 *  because those tests never dispatch a worker (no ready issues) — this only exists so
 *  EngineOverrides can type `forge` as the general `IForge` interface. */
function findOpenPrForIssue(forge: IForge, issue: number): Promise<number | null> {
  const withPr = forge as Partial<Pick<GithubForge, "findOpenPrForIssue">>;
  return typeof withPr.findOpenPrForIssue === "function" ? withPr.findOpenPrForIssue(issue) : Promise.resolve(null);
}

/** The M4 tick-driver path (`driver.ts`'s `runDriver`) — unchanged behavior, kept reachable via
 *  `engine.driver: tick` (#106's explicit escape hatch) now that the round orchestrator
 *  (runRoundsEngine below) is the default. */
async function runTickEngine(argv: string[], cfg: SapwoodConfig, overrides: EngineOverrides): Promise<number> {
  const { logger, path: logPath } = createRunLogger(cfg, overrides.logger);
  const log = logger.log.bind(logger);
  log(`[sapwood:run] startup logPath=${logPath}`);
  // #74: build the worker-prompt renderer NOW, before anything else — loadWorkerPromptTemplate
  // (inside buildRenderPrompt) reads the template file EAGERLY, so a configured
  // `worker.promptFile` that's missing/unreadable throws here and aborts startup. Never a lazy
  // load deferred to first dispatch: that would let the engine claim issues / churn ticks before
  // failing, instead of a clean fail-fast with no dispatch ever happening.
  const renderPrompt = buildRenderPrompt(cfg);
  const state = overrides.state ?? new State();
  const forge = overrides.forge ?? new GithubForge(cfg);
  const reviewer = makeReviewer(cfg);
  // #54: the ordered reviewer-failover chain (cfg.reviewer.fallback) — empty by default, in
  // which case MergeDriver.driveOne behaves exactly as before this existed.
  const fallbackReviewers = makeFallbackReviewers(cfg);
  const mergeGate = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers });
  const supervisor = new WorkerSupervisor({
    cfg,
    log,
    // #46: a first-pass live findOpenPr wiring (GithubForge.findOpenPrForIssue) — see its
    // doc comment for the heuristic and its known limits; hardening it is part of the live
    // merge-gate run (#46 scope 3), not this PR.
    hasOpenPr: async (issue) => (await findOpenPrForIssue(forge, issue)) != null,
    findOpenPr: (issue) => findOpenPrForIssue(forge, issue),
    renderPrompt,
  });
  const stopMode = parseRunStopMode(argv);
  const stop = resolveStopConfig(argv, cfg);
  // #76: same fail-fast stance as buildRenderPrompt above — a typo'd milestone goal must abort
  // startup with zero dispatch, not silently stop the run after the first wave of workers.
  await assertStopMilestoneExists(forge, stop);
  await normalizeUnplacedBoardItems(forge, state, log);
  await reconcileStartup(forge, state, cfg, log);
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
    tickIntervalSec: cfg.engine.tickIntervalSec,
    stopMode,
    stop,
    probeLlmReachable,
    log,
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
  return runExitCode(result, stopMode);
}

/** #106: the round-orchestrator path (`round.ts`'s `runRounds`), wired with the REAL default
 *  peripherals (`round-defaults.ts`'s `createDefaultPeripherals`) sharing one `RoleRunner` — the
 *  same wiring shape round-defaults.test.ts's integration tests already prove end-to-end, now
 *  reached from `sapwood run` itself instead of only from a test/library caller (#106's
 *  acceptance criterion). Every safety behavior (KILL_SWITCH, cost ceilings, drain-before-kill,
 *  graceful-stop-still-runs-harvest) lives in round.ts/state.ts unchanged — this function only
 *  wires the real collaborators runRounds needs, it adds no safety logic of its own. */
async function runRoundsEngine(argv: string[], cfg: SapwoodConfig, overrides: EngineOverrides): Promise<number> {
  const { logger, path: logPath } = createRunLogger(cfg, overrides.logger);
  const log = logger.log.bind(logger);
  log(`[sapwood:run] startup logPath=${logPath}`);
  // Same fail-fast stance as the tick driver above: a broken worker.promptFile must abort
  // startup before any dispatch — the round loop's `executing` phase still dispatches workers
  // via WorkerSupervisor exactly like the tick driver does.
  const renderPrompt = buildRenderPrompt(cfg);
  const state = overrides.state ?? new State();
  const forge = overrides.forge ?? new GithubForge(cfg);
  const reviewer = makeReviewer(cfg);
  const fallbackReviewers = makeFallbackReviewers(cfg);
  const mergeGate = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers });
  const supervisor = new WorkerSupervisor({
    cfg,
    log,
    hasOpenPr: async (issue) => (await findOpenPrForIssue(forge, issue)) != null,
    findOpenPr: (issue) => findOpenPrForIssue(forge, issue),
    renderPrompt,
  });
  const runner = new RoleRunner({ cfg, ...overrides.roleRunnerDeps, log });
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner, log });
  const stop = resolveStopConfig(argv, cfg);
  // #76: same fail-fast stance as the tick driver — a typo'd milestone goal must abort startup
  // with zero dispatch, checked here identically for the round path's own FINAL stop condition.
  await assertStopMilestoneExists(forge, stop);
  await normalizeUnplacedBoardItems(forge, state, log);
  await reconcileStartup(forge, state, cfg, log);
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
    tickIntervalSec: cfg.engine.tickIntervalSec,
    peripherals,
    // #212: restrict the executing phase's dispatch to this round's pool (round-defaults.ts's
    // aligning wrapper always populates it, PO on or off — see selectRoundPool/AC7).
    poolLabel: cfg.labels.roundPool,
    stop,
    probeLlmReachable,
    log,
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
  return roundsExitCode(result);
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
export async function runEngine(argv: string[], overrides: EngineOverrides = {}): Promise<number> {
  // #129: fold --milestone's round-scope half in here, once, before either driver sees cfg —
  // this run's `round.milestone` override applies regardless of which driver runs, though only
  // the round orchestrator (round.ts) actually reads it for dispatch scoping.
  const cfg = applyMilestoneOverride(argv, overrides.cfg ?? loadConfig());
  if (cfg.engine.driver === "tick") return runTickEngine(argv, cfg, overrides);
  // Gate② P2: fail fast on tick-only flags BEFORE any collaborator is constructed or any
  // dispatch can happen — same abort-with-zero-dispatch stance as buildRenderPrompt /
  // assertStopMilestoneExists startup validation.
  const flagError = tickOnlyFlagError(argv);
  if (flagError) {
    process.stderr.write(`${flagError}\n`);
    return 1;
  }
  return runRoundsEngine(argv, cfg, overrides);
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
