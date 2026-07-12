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
import { dirname, isAbsolute, resolve } from "node:path";
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
  // #147: sapwood-native (no 0day LOOP_* counterpart) — bounds the GATED RECLAIM phase
  // (conductor.ts tick()): how many times a gate②-escalated PR may be reclaimed back to
  // `driving` and re-driven after a human removes needs-human from its issue, before a further
  // removal is rejected (re-escalated + permanently capped, never retried forever). Same
  // nonnegative-int shape as prFixCap above — 0 disables automatic reentry outright (every
  // removal is immediately capped).
  gatedReentryCap: z.number().int().nonnegative().default(2),
}).strict();

const Worker = z.object({
  model: z.string().default("opus"),
  effort: z.enum(["low", "medium", "high"]).default("high"),
  timeoutSec: z.number().int().positive().default(3600),
  // SOFT per-worker budget -> graceful handoff (never a mid-work kill). Auto-enforced (#33) via
  // LIVE TOKEN ESTIMATION: stream-json carries no in-progress total_cost_usd (only the terminal
  // result message has that), so worker.ts's checkSoftBudget() accumulates a running USD
  // ESTIMATE from every streamed assistant message's token usage (priced by the small rate
  // table in pricing.ts) and calls requestHandoff() once the estimate crosses this value. The
  // estimate is reconciled against the real terminal total_cost_usd when it lands (logged, not
  // enforced) — see worker.ts's writeTerminalSentinel. Backstopped by worker.timeoutSec
  // (enforced) + the engine HARD ceiling (M3, the actual runaway safety boundary).
  budgetUsdSoft: z.number().finite().positive().default(10),
  heartbeatStaleSecs: z.number().int().positive().default(180),
  // #74: file-based worker prompt. A relative path is resolved against the CONFIG FILE's
  // directory (see loadConfig), so the same config works no matter what cwd the CLI runs
  // from. Unset (default) -> the shipped preset at the engine package's `prompts/worker.md`
  // (resolved relative to the engine's own install location, not this repo — see
  // worker.ts's defaultPromptPath). Set-but-missing/unreadable/empty is a fail-fast startup
  // error (buildRenderPrompt loads it once, eagerly, before any dispatch) — never a silent
  // fallback to the shipped default.
  promptFile: z.string().optional(),
  // #33 follow-up (PR #85 human review): user-editable model rate table for the soft-budget
  // token estimator. Same shape as promptFile (#74): a relative path resolves against the
  // CONFIG FILE's directory (see loadConfig); unset (default) -> the shipped preset at the
  // engine package's `pricing.yaml` (see pricing.ts's defaultPricingPath). Set-but-missing/
  // unreadable/malformed is a fail-fast startup error (loadPricingTable, loaded once at
  // supervisor construction) — never a silent fallback to the shipped default.
  pricingFile: z.string().optional(),
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
  // #54: EXPLICIT, ordered opt-in list of reviewer modes to fail over to when the primary
  // (reviewer.mode) is unavailable for longer than failoverAfterSec. Each entry keeps its OWN
  // mode semantics (identity allowlist for bot modes; any-non-author-approval for human) —
  // reused unchanged from the mode implementations above, never forked. DEFAULT EMPTY: no
  // fallback configured means exactly today's behavior — an unavailable primary queues the PR
  // forever. This is a deliberate no-silent-degradation default (PLAN.md security model):
  // falling from a different-model review to same-model/human changes gate②'s trust
  // properties, so it never happens unless an operator explicitly opts in.
  fallback: z.array(z.enum(["different-model-codex", "same-model-trusted", "human"])).default([]),
  // How long (seconds, wall-clock since the last review trigger for the current head) the
  // primary reviewer may stay non-decisive (WAIT_REVIEW / REVIEW_UNAVAILABLE) before
  // merge-driver.ts's resolveReviewVerdict hands gate② to the first fallback entry that itself
  // reaches a decisive verdict. Irrelevant when `fallback` is empty. Conservative default: 20
  // minutes — same order of magnitude as the (separate, still-unwired) pollTimeoutSec above.
  failoverAfterSec: z.number().int().positive().default(1200),
}).strict().superRefine((r, ctx) => {
  // #54 R2 (fable-review P3): same-model-trusted with an empty trustedReviewers list can NEVER
  // produce a verdict (fail-closed by design, see SameModelTrustedReviewer) — as a fallback
  // entry that makes the explicitly opted-into failover silently inert: the operator believes
  // gate② has a fallback, but every PR still queues forever with no signal. Reject at parse
  // (loud, at `sapwood validate` / engine start) rather than let a dead config ship.
  if (r.fallback.includes("same-model-trusted") && r.trustedReviewers.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fallback"],
      message:
        "reviewer.fallback contains same-model-trusted but reviewer.trustedReviewers is empty — " +
        "that fallback can never produce a verdict (fail-closed), so the failover would be " +
        "silently inert; add trustedReviewers logins or remove the entry",
    });
  }
});

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
  // #88 gate⓪ (amends Decision #8 per #77's 2026-07-09 comment): a verification plan must
  // also pass the plan-reviewer peripheral's quality review before getReadyIssues dispatches
  // it — plan presence alone is no longer enough. Applied by that peripheral only (never by
  // the loop on a verify:n/a issue — the two dispatch paths are mutually exclusive).
  planApproved: z.string().default("plan:approved"),
  // #89: provenance stamp for agent-created issues (docs/security.md's convention, now
  // load-bearing): align.ts's PO orchestrator applies it to every issue the alignment
  // session creates. Config-driven like every sibling label here — never a hardcoded
  // string at the call site (fable PR #101 P3).
  originAgent: z.string().default("origin:agent"),
}).strict();

// #87: peripheral role sessions (plan-reviewer, plan-drafter, ...) are cheap, issues-only,
// text-judgment tasks — no code, no repo context beyond what's substituted into the prompt.
// Default to a lighter model/effort than worker.model/effort (which does real implementation
// work); still fully YAML-tunable per role, same as every other user-facing knob here.
const RoleSession = z.object({
  model: z.string().default("sonnet"),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
}).strict();

// #88/#87: gate⓪ plan-reviewer + plan-drafter peripheral config surface. #88 shipped the
// validated config key + path resolution + the shipped default prompt file ("accepted, not
// yet wired"); #87 (the role runner) is what actually loads/renders/dispatches these.
const Roles = z.object({
  planReviewer: RoleSession.extend({
    // Same #74 promptFile pattern as worker.promptFile: unset -> the engine's shipped
    // `prompts/plan-reviewer.md`; a relative path resolves against the CONFIG FILE's own
    // directory (see loadConfig below), not the CLI's cwd.
    promptFile: z.string().optional(),
    // #77 Amendment 2 (gate⓪ self-heal): max draft→re-review cycles per issue before the
    // loop gives up and applies needs-human with the attempt trail (Decision #9's
    // degrade-to-human) — the bound that keeps the self-heal path from livelocking.
    // Positive int only: 0 would turn every request-a-draft outcome into an instant
    // needs-human, silently disabling the self-heal path. Enforced by the #87 role
    // runner's plan_review phase.
    maxDraftCycles: z.number().int().positive().default(2),
  }).strict().default({}),
  // #87 (#77 Amendment 2's self-heal): the plan-drafter peripheral — issues-only writes, a
  // session distinct from the plan-reviewer, briefed by the reviewer's bounce comment to
  // draft/repair an issue's acceptance criteria + verification plan. Never implements the
  // issue, never approves its own draft (plan-author != plan-approver).
  planDrafter: RoleSession.extend({
    // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/plan-drafter.md`;
    // relative resolves against the CONFIG FILE's directory.
    promptFile: z.string().optional(),
  }).strict().default({}),
  // #90: the architect peripheral — round design/review between goal alignment and dispatch
  // (#77's model). Issues-only write scope (the same peripheral-runner scope as the two roles
  // above, #87/#99): never reviews PR code, never merges. Same #74 promptFile shape too.
  architect: RoleSession.extend({
    promptFile: z.string().optional(),
    // #104 (#100 gate② P3): the architecture-doc path — was hardcoded to
    // `<cwd>/docs/PLAN.md` (architect.ts's old defaultPlanMdPath), which breaks for any target
    // repo sapwood runs against that doesn't keep its architecture doc at that exact path.
    // Defaults to "docs/PLAN.md" (this repo's own convention) but is now a real config key, ALWAYS
    // resolved relative to the CONFIG FILE's directory (see loadConfig below) — same #74
    // promptFile pattern, except this key always has a value (never "unset -> engine-shipped
    // default": the target repo's own doc, not a file sapwood ships). align.ts's PLAN.md read
    // honors this same key (the two peripherals must read the SAME architecture doc).
    planMdPath: z.string().min(1).default("docs/PLAN.md"),
  }).strict().default({}),
  // #89: the PO (product-owner) peripheral — goal alignment/decomposition at round start
  // (reads the round milestone/theme + docs/PLAN.md, creates issues) plus the round-start
  // triage pass that drafts a plan into any existing plan-less issue. Every PO-created issue
  // carries `origin:agent` + a verification plan; the PO never sets board Status=Ready (locked
  // decision 5 — only a human confirms Ready). Same #74 promptFile shape as every other role
  // above: unset -> the engine's shipped `prompts/po.md`; a relative path resolves against the
  // CONFIG FILE's directory (see loadConfig below), not the CLI's cwd.
  po: RoleSession.extend({
    promptFile: z.string().optional(),
  }).strict().default({}),
  // #91: round-close peripheral roles (#77 decision 2's harvest / decision 6's retro). Config
  // key + path resolution + shipped default prompt only — same "accepted, not yet wired" shape
  // #88 shipped for planReviewer before #87 wired it: harvest.ts/retro.ts implement the
  // PeripheralStub, but wiring either into runRounds's default `harvesting`/`retro` peripherals
  // (or the CLI) is a deliberate follow-up, not this issue's scope.
  harvest: RoleSession.extend({
    // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/harvest.md`;
    // relative resolves against the CONFIG FILE's directory.
    promptFile: z.string().optional(),
  }).strict().default({}),
  // #91 (#77 decision 6): the retrospective/self-evolution peripheral. Its role write scope is
  // intentionally WIDER than the issues-only roles above (git + `gh pr create` — proposals land
  // exclusively as PRs through the normal gate② path, never a direct write) — see retro.ts's
  // RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS for the enforcement this config key feeds.
  retro: RoleSession.extend({
    // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/retro.md`; relative
    // resolves against the CONFIG FILE's directory.
    promptFile: z.string().optional(),
    // #104: retro cadence — the wiring-time decision retro.ts's own module doc named as a
    // follow-up ("whether every round should pay for a retro pass"). Default 1 = every round
    // (unchanged behavior from #91). N>1 thins it: retro.ts skips every round whose id isn't a
    // multiple of N, still setting the phase marker (never wedges the round). Positive int
    // only, same rationale as roles.planReviewer.maxDraftCycles above (0 has no sane meaning).
    everyNRounds: z.number().int().positive().default(1),
    // #111 PR-A: the hard cap on the engine-built round-scoped read digest (retro-digest.ts's
    // buildRetroDigest) substituted into the prompt as `{{round.digest}}` — the user-tunable
    // knob this repo's convention requires for any size/cost bound (see #110's adjudication:
    // "user-adjustable values go in shipped config, never hardcoded"). 60,000 chars (~15k
    // tokens) comfortably covers a handful of PR diffs + review threads + issue comments for a
    // normal-sized round while keeping the digest a bounded, predictable addition to the
    // retro prompt's own context cost; a much larger/longer-running round is deterministically
    // TRUNCATED (never silently dropped — retro-digest.ts's capDigest marks the cut in the
    // digest text itself) rather than growing the prompt unboundedly. Positive int only — 0
    // would produce an empty, useless digest.
    digestMaxChars: z.number().int().positive().default(60_000),
  }).strict().default({}),
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
  // #106: which engine `sapwood run` drives. "rounds" (default, v0.2 north star) — the round
  // orchestrator (round.ts's runRounds + round-defaults.ts's createDefaultPeripherals): peripheral
  // roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the same tick
  // engine, batch-dispatch-then-drain per round. "tick" — the bare M4 loop driver (driver.ts's
  // runDriver), unchanged: no peripherals, --once/--until-idle apply. Kept reachable as an
  // explicit escape hatch until a live dogfood run has validated the round path (PLAN.md's
  // follow-up note); not deprecated, just no longer the default.
  driver: z.enum(["rounds", "tick"]).default("rounds"),
}).strict();

// #76: goal-based stop conditions — the loop driver's FINAL break conditions ("when is this run
// complete"). All optional; absent = today's behavior exactly (the driver only stops on a signal,
// --once, or --until-idle idleness). CLI --stop-after-issues/--stop-after-prs/--stop-on-milestone
// override these per invocation (cli.ts). OR semantics: the first condition to be satisfied wins
// and converts the rest of the run into an until-idle wind-down (driver.ts) — never a mid-work
// kill of an in-flight lane.
const Stop = z.object({
  // Counted from THIS run's tick results (driver.ts): DrivenOutcome "merged" entries, summed
  // across ticks. Scope = process lifetime, not cumulative history — a restarted engine starts
  // this counter back at 0.
  //
  // N is a FLOOR, not an exact bound: conditions are evaluated at tick boundaries, and the tick
  // that crosses N has already run its own DISPATCH phase — so up to lanes.roundDispatchCap
  // extra lanes may launch in that tick and run to full completion (including merge) during the
  // wind-down. Counts from a tick that THREW are also lost (fail toward more work, bounded by
  // the cost ceilings). Both are inherent to tick-boundary counting; the exit line reports the
  // count at hit time.
  afterIssuesMerged: z.number().int().positive().optional(),
  // Counted from THIS run's tick results: reclaim transitions into the `driving` state (a lane's
  // PR becomes known to the engine for the first time) — see driver.ts's prsOpenedThisTick for
  // why that's the simplest accurate signal without a new SQLite table. Same FLOOR semantics as
  // afterIssuesMerged above.
  afterPRsOpened: z.number().int().positive().optional(),
  // Milestone TITLE — EXACT, as GitHub displays it ("M4" does NOT match "M4 — UX surface +
  // CLI"; cli.ts fails closed at startup against the repo's real titles). Condition = zero OPEN
  // issues remain in it (forge.countOpenIssuesInMilestone), checked at tick boundaries; a failed
  // check (gh outage) is a recorded tick-error, never a fired condition, never a crash.
  onMilestoneComplete: z.string().min(1).optional(),
}).strict();

// #86: round-loop scoping. `milestone` reuses the exact GitHub-milestone mechanism
// stop.onMilestoneComplete already validates against (forge.listMilestoneTitles/
// countOpenIssuesInMilestone) rather than inventing a parallel label-based "theme" — one key
// does both jobs the round loop needs: (1) dispatch-candidate filter (round.ts's
// RoundScopedForge only returns Ready issues whose Issue.milestone matches), and (2) a
// round-level stop condition (the round's dispatch batch is skipped once that milestone has
// zero open issues left). Unset = no scoping, every Ready issue is a candidate (today's
// behavior, unchanged).
const Round = z.object({
  milestone: z.string().min(1).optional(),
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
  stop: Stop.default({}),
  round: Round.default({}),
  recovery: Recovery.default({}),
  reviewer: Reviewer.default({}),
  merge: Merge.default({}),
  labels: Labels.default({}),
  roles: Roles.default({}),
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
  const cfg = parseConfig(readFileSync(file, "utf8"));
  // A relative worker.promptFile means "relative to the config file" (#74), not to whatever
  // cwd the CLI happens to run from — `sapwood validate repo/sapwood.config.yaml` must judge
  // the same config the engine would run inside `repo/`.
  if (cfg.worker.promptFile !== undefined && !isAbsolute(cfg.worker.promptFile)) {
    cfg.worker.promptFile = resolve(dirname(file), cfg.worker.promptFile);
  }
  // Same rule for worker.pricingFile (#33 follow-up, PR #85 review).
  if (cfg.worker.pricingFile !== undefined && !isAbsolute(cfg.worker.pricingFile)) {
    cfg.worker.pricingFile = resolve(dirname(file), cfg.worker.pricingFile);
  }
  // #88/#87: same relative-to-config-file resolution for the plan-reviewer prompt.
  if (
    cfg.roles.planReviewer.promptFile !== undefined &&
    !isAbsolute(cfg.roles.planReviewer.promptFile)
  ) {
    cfg.roles.planReviewer.promptFile = resolve(dirname(file), cfg.roles.planReviewer.promptFile);
  }
  // #87: same rule for the plan-drafter prompt.
  if (
    cfg.roles.planDrafter.promptFile !== undefined &&
    !isAbsolute(cfg.roles.planDrafter.promptFile)
  ) {
    cfg.roles.planDrafter.promptFile = resolve(dirname(file), cfg.roles.planDrafter.promptFile);
  }
  // #90: same rule for the architect prompt.
  if (
    cfg.roles.architect.promptFile !== undefined &&
    !isAbsolute(cfg.roles.architect.promptFile)
  ) {
    cfg.roles.architect.promptFile = resolve(dirname(file), cfg.roles.architect.promptFile);
  }
  // #104: same rule for the architecture-doc path — UNLIKE promptFile this key always has a
  // value (the schema default is "docs/PLAN.md", never unset), so there's no `!== undefined`
  // guard: every non-absolute value, default or explicit, resolves against the config file's
  // directory.
  if (!isAbsolute(cfg.roles.architect.planMdPath)) {
    cfg.roles.architect.planMdPath = resolve(dirname(file), cfg.roles.architect.planMdPath);
  }
  // #89: same rule for the PO prompt.
  if (cfg.roles.po.promptFile !== undefined && !isAbsolute(cfg.roles.po.promptFile)) {
    cfg.roles.po.promptFile = resolve(dirname(file), cfg.roles.po.promptFile);
  }
  // #91: same rule for the harvest prompt.
  if (cfg.roles.harvest.promptFile !== undefined && !isAbsolute(cfg.roles.harvest.promptFile)) {
    cfg.roles.harvest.promptFile = resolve(dirname(file), cfg.roles.harvest.promptFile);
  }
  // #91: same rule for the retro prompt.
  if (cfg.roles.retro.promptFile !== undefined && !isAbsolute(cfg.roles.retro.promptFile)) {
    cfg.roles.retro.promptFile = resolve(dirname(file), cfg.roles.retro.promptFile);
  }
  return cfg;
}
