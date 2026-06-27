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
import { readFileSync } from "node:fs";
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
  budgetUsdSoft: z.number().positive().default(10), // SOFT: reaching it -> graceful handoff
  heartbeatStaleSecs: z.number().int().positive().default(180),
}).strict();

const Cost = z.object({
  // Engine-enforced HARD ceiling (independent of the drift-prone CLI --max-budget-usd).
  roundBudgetUsd: z.number().positive().default(30),
  dailyBudgetUsd: z.number().positive().default(100),
}).strict();

const Reviewer = z.object({
  mode: z
    .enum(["different-model-codex", "same-model-trusted", "human", "produce-pr-and-stop"])
    .default("different-model-codex"),
  trustedReviewers: z.array(z.string()).default([]),
}).strict();

const Labels = z.object({
  inProgress: z.string().default("in-progress"),
  needsHuman: z.string().default("needs-human"),
  blocked: z.string().default("blocked"),
  reserve: z.string().default("reserve"),
  verifyNa: z.string().default("verify:n/a"), // Decision #8: skips the verification-plan gate
}).strict();

export const ConfigSchema = z.object({
  board: Board,
  lanes: Lanes.default({}),
  worker: Worker.default({}),
  cost: Cost.default({}),
  reviewer: Reviewer.default({}),
  labels: Labels.default({}),
  escalation: z
    .object({ humanLabels: z.array(z.string()).default(["needs-human", "blocked"]) })
    .strict()
    .default({}),
  coverage: z.object({ minPercent: z.number().min(0).max(100).default(0) }).strict().default({}),
  optimize: z.object({ recur: z.boolean().default(false) }).strict().default({}),
}).strict();

export type SapwoodConfig = z.infer<typeof ConfigSchema>;

/** Parse + validate raw YAML/JSON text. Exported for testing without disk I/O. */
export function parseConfig(text: string): SapwoodConfig {
  const raw = parseYaml(text); // also accepts JSON (YAML ⊃ JSON)
  return ConfigSchema.parse(raw);
}

/** Load and validate a config file. Throws ZodError with field paths on invalid input. */
export function loadConfig(path = "sapwood.config.yaml"): SapwoodConfig {
  return parseConfig(readFileSync(path, "utf8"));
}
