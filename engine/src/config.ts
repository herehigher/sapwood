// sapwood config: load sapwood.config.yaml (YAML default; JSON parses for free via
// the YAML parser, YAML ⊃ JSON), validate with Zod, apply defaults. Decision #7/#3.
//
// Every 0day LOOP_* env var becomes a named, documented, defaulted field here — no
// hidden hard-coding. Source map (0day env -> field):
//   LOOP_MAX_LANES        -> lanes.max
//   LOOP_ROUND_DISPATCH_CAP -> lanes.roundDispatchCap
//   LOOP_RESERVE_CAP      -> lanes.reserveCap
//   LOOP_PR_FIX_CAP       -> lanes.prFixCap
//   LOOP_BUDGET_USD       -> worker.budgetUsdSoft   (SOFT — graceful handoff, never a mid-work kill)
//   LOOP_ROUND_BUDGET_USD -> cost.roundBudgetUsd
//   LOOP_TIMEOUT          -> worker.timeoutSec
//   LOOP_MODEL            -> worker.model
//   LOOP_EFFORT           -> worker.effort
//   LOOP_HB_STALE_SECS    -> worker.heartbeatStaleSecs
//   LOOP_HUMAN_LABELS     -> escalation.humanLabels
//   LOOP_TRUSTED_REVIEWERS-> reviewer.trustedReviewers
//   LOOP_FRICTION_MIN     -> lanes.frictionMin
//   LOOP_OPTIM_RECUR      -> optimize.recur
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const Board = z.object({
  // Removes 0day's hard-coded PROJECT_NUMBER / user-vs-org / literal status names.
  owner: z.string().min(1),
  repo: z.string().min(1), // every gh call targets owner/repo — required, no silent default
  ownerKind: z.enum(["user", "org"]).optional(), // auto-detected at init if omitted
  projectNumber: z.number().int().positive(),
  statusField: z.string().default("Status"),
  status: z
    .object({
      ready: z.string().default("Ready"),
      inProgress: z.string().default("In Progress"),
      done: z.string().default("Done"),
    })
    .strict()
    .default({}),
}).strict();

const Lanes = z.object({
  max: z.number().int().positive().default(3),
  roundDispatchCap: z.number().int().positive().default(2), // conservative default (PLAN security)
  reserveCap: z.number().int().nonnegative().default(1),
  prFixCap: z.number().int().nonnegative().default(2),
  frictionMin: z.number().nonnegative().default(0),
}).strict();

const Worker = z.object({
  model: z.string().default("opus"),
  effort: z.enum(["low", "medium", "high"]).default("high"),
  timeoutSec: z.number().int().positive().default(3600),
  // SOFT per-worker budget -> graceful handoff (never a mid-work kill). NOTE: automatic
  // enforcement at this limit is pending #33 — it needs a live cost signal, which stream-json
  // does not carry (total_cost_usd is only in the terminal result message). Interim spend
  // bound: worker.timeoutSec (enforced) + the engine HARD ceiling (M3, the actual runaway
  // safety boundary). requestHandoff() is the live drain path today.
  budgetUsdSoft: z.number().finite().positive().default(10),
  heartbeatStaleSecs: z.number().int().positive().default(180),
}).strict();

const Cost = z.object({
  // Engine-enforced HARD ceiling (independent of the drift-prone CLI --max-budget-usd).
  // .finite() rejects YAML/JSON overflow (1e999 -> Infinity), which would silently
  // disable the cap (Infinity > any spend). (Codex P2, PR #22.)
  roundBudgetUsd: z.number().finite().positive().default(30),
  // Cumulative daily USD cap (#14): summed from completed workers' stream-json
  // total_cost_usd, persisted in State (engine.spend_ledger) so it survives an engine
  // restart mid-day. Breaching it is an engine-wide dispatch freeze + drain, not just a
  // per-tick skip (see conductor.ts evaluateCeiling / tick's CEILING step). Enforced
  // POST-HOC at tick boundaries — cost is only known at worker completion, so bounded
  // overshoot ≈ lanes.roundDispatchCap × per-worker spend is possible before the freeze.
  dailyBudgetUsd: z.number().finite().positive().default(100),
  // Aggregate wall-clock ceiling (#14) over the ACTIVE engine session
  // (State.engineSessionStart: continuous ticking; a stop/crash/pause longer than the stale
  // gap resets it, so a rapid crash-loop can't evade the cap but a data dir is never
  // permanently breached). Independent of worker.timeoutSec (which bounds a single worker);
  // this bounds the engine's total continuous running time as a runaway-time safety net.
  // Conservative default: 4h.
  maxWallClockSec: z.number().int().positive().default(14400),
  // Bounded grace window (#14) after a ceiling breach (daily budget / wall-clock / kill
  // switch) is first detected, during which running workers are asked to hand off
  // gracefully (SIGTERM -> checkpoint -> .handoff) before the conductor escalates to the
  // hard process-tree kill (supervisor.reclaim). "Drain before kill" (PLAN.md Security
  // model) — this is the bound on how long that drain gets. Conservative default: 5min.
  drainWindowSec: z.number().int().nonnegative().default(300),
}).strict();

const Reviewer = z.object({
  // The reviewer KIND (gate②'s "who reviews"). NOTE: produce-pr-and-stop was previously a
  // value of this same enum, conflating "who reviews" with "does the Conductor merge" — split
  // out to merge.mode (#13) so the two questions are independent (e.g. same-model-trusted +
  // produce-pr-and-stop is a legal combination). Narrowing this enum is additive/back-compat:
  // sapwood.config.yaml's checked-in `mode: different-model-codex` still parses; nothing ever
  // shipped `mode: produce-pr-and-stop` here.
  mode: z.enum(["different-model-codex", "same-model-trusted", "human"]).default("different-model-codex"),
  trustedReviewers: z.array(z.string()).default([]),
  // How often the Conductor's tick re-polls a triggered review (documents the operational
  // policy; the actual re-poll cadence is driven by the tick loop itself, not a timer here).
  pollIntervalSec: z.number().int().positive().default(120),
  // How long a triggered review may sit unresolved (no verdict past "reviewing") before the
  // merge driver treats it as REVIEW_UNAVAILABLE (rate-limit/timeout) and QUEUES the PR —
  // gate② must never be skipped or softened on an unavailable review (#13).
  pollTimeoutSec: z.number().int().positive().default(1200),
}).strict();

const Merge = z.object({
  // conductor-merge (0day-style default): gate① (CI green) + gate② (fresh non-author review on
  // the current head) both pass -> the Conductor squash-merges with --match-head-commit pinned
  // to the head that passed the gates (TOCTOU guard). produce-pr-and-stop: the driver still
  // computes + reports both gates every tick but NEVER calls forge.mergePR — a human merges.
  mode: z.enum(["conductor-merge", "produce-pr-and-stop"]).default("conductor-merge"),
}).strict();

const Labels = z.object({
  inProgress: z.string().default("in-progress"),
  needsHuman: z.string().default("needs-human"),
  blocked: z.string().default("blocked"),
  reserve: z.string().default("reserve"),
  verifyNa: z.string().default("verify:n/a"), // Decision #8: skips the verification-plan gate
}).strict();

const Guard = z.object({
  // PreToolUse guard enforcement. HARD (default) = fail-closed deny — the producer≠merger /
  // boundary-write safety boundary. SOFT = observe-only: log what WOULD be blocked, allow it
  // (a first-run trust-ramp / dogfood affordance, never the shipped default). The mode reaches
  // the hook via the SAPWOOD_GUARD_MODE spawn env worker.ts sets — not a worker-writable file —
  // so a worker can't weaken its own guard.
  mode: z.enum(["hard", "soft"]).default("hard"),
}).strict();

const Engine = z.object({
  // The M4 loop driver's tick cadence (#46): how often `driver.ts` calls tick(). Threaded
  // straight into TickDeps.tickIntervalSec so the wall-clock ceiling's session-gap scaling
  // (conductor.ts engineSessionGapSec: max(900, 2x cadence)) sees the REAL cadence instead of
  // silently falling back to the 900s floor (gate② PR #41 P2 — a legal slow cadence could
  // otherwise make every tick look "stale" and void the wall-clock tier). Conservative default:
  // 1 minute (0day's loop ticks minutes apart, PLAN.md).
  tickIntervalSec: z.number().int().positive().default(60),
}).strict();

const Recovery = z.object({
  // #31: bounded retry count for a durably-persisted rollback/requeue (a recovery-path board
  // mutation, e.g. rolling a dispatch-failed claim back to Ready, or requeuing a dead lane).
  // Retried once per tick (State.pendingRollbacks) until it succeeds; past this many failed
  // attempts the conductor stops retrying and escalates (needs-human label attempt + a
  // structured tick-result entry) instead of retrying forever.
  rollbackRetryCap: z.number().int().positive().default(5),
}).strict();

export const ConfigSchema = z.object({
  board: Board,
  engine: Engine.default({}),
  lanes: Lanes.default({}),
  worker: Worker.default({}),
  guard: Guard.default({}),
  cost: Cost.default({}),
  recovery: Recovery.default({}),
  reviewer: Reviewer.default({}),
  merge: Merge.default({}),
  labels: Labels.default({}),
  escalation: z
    .object({ humanLabels: z.array(z.string()).default(["needs-human", "blocked"]) })
    .strict()
    .default({}),
  coverage: z.object({ minPercent: z.number().min(0).max(100).default(0) }).strict().default({}),
  optimize: z.object({ recur: z.boolean().default(false) }).strict().default({}),
  // Milestones `sapwood init` should ensure exist. Empty = create none (the loop needs
  // labels + board lanes, not milestones — those are the user's organizational choice).
  milestones: z.array(z.string()).default([]),
}).strict();

export type SapwoodConfig = z.infer<typeof ConfigSchema>;

/** Parse + validate raw YAML/JSON text. Exported for testing without disk I/O. */
export function parseConfig(text: string): SapwoodConfig {
  const raw = parseYaml(text); // also accepts JSON (YAML ⊃ JSON)
  return ConfigSchema.parse(raw);
}

// Default lookup order when no explicit path is given. The YAML parser handles all
// three (YAML ⊃ JSON), so .json is real support, not just advertised. Exported so
// callers (e.g. `sapwood validate`) can report which path was actually probed/used
// without re-implementing the lookup.
export const DEFAULT_CONFIG_PATHS = ["sapwood.config.yaml", "sapwood.config.yml", "sapwood.config.json"];

/**
 * Load and validate a config file. With no argument, probes the default names in order
 * (.yaml, .yml, .json) and uses the first that exists. Throws ZodError with field paths
 * on invalid input.
 */
export function loadConfig(path?: string): SapwoodConfig {
  const file = path ?? DEFAULT_CONFIG_PATHS.find(existsSync);
  if (file === undefined) {
    throw new Error(`no config found; looked for ${DEFAULT_CONFIG_PATHS.join(", ")}`);
  }
  return parseConfig(readFileSync(file, "utf8"));
}
