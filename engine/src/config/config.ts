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
import { DEFAULT_FORGE_FAILURE_PATTERNS, DEFAULT_LLM_FAILURE_PATTERNS } from "../loop/env-failure.js";

const Board = z
  .object({
    // Removes 0day's hard-coded PROJECT_NUMBER / user-vs-org / literal status names.
    owner: z.string().min(1),
    repo: z.string().min(1), // every gh call targets owner/repo — required, no silent default
    ownerKind: z.enum(["user", "org"]).optional(), // auto-detected at init if omitted
    projectNumber: z.number().int().positive(),
    statusField: z.string().default("Status"),
    status: z
      .object({
        backlog: z.string().default("Todo"),
        ready: z.string().default("Ready"),
        inProgress: z.string().default("In Progress"),
        done: z.string().default("Done"),
      })
      .strict()
      .default({}),
  })
  .strict();

const Lanes = z
  .object({
    max: z.number().int().positive().default(3),
    // #124: re-justified for MULTI-WAVE quota semantics (round.ts's runExecuting) — this is no
    // longer "one batch = round size" (2 was sized for that single-batch model), it is the
    // round's total work quota, refilled in waves as lanes free. Default = 2x lanes.max's own
    // default: two full concurrency-wide waves is enough work to amortize a round's peripheral
    // (aligning/architect/harvest/retro) cost without a round running away before the retro loop
    // reviews it — quota is retro FEEDBACK GRANULARITY, the trade-off this knob actually tunes.
    roundDispatchCap: z.number().int().positive().default(6),
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
  })
  .strict();

const Worker = z
  .object({
    model: z.string().default("opus"),
    effort: z.enum(["low", "medium", "high"]).default("high"),
    fallbackModel: z.string().default("sonnet"),
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
  })
  .strict();

const Cost = z
  .object({
    // Engine-enforced HARD ceiling (independent of the drift-prone CLI --max-budget-usd).
    // .finite() rejects YAML/JSON overflow (1e999 -> Infinity), which would silently
    // disable the cap (Infinity > any spend). (Codex P2, PR #22.)
    roundBudgetUsd: z.number().finite().positive().default(30),
    // A BURN-RATE cap (#14, $/calendar-day), not a total: summed from completed workers'
    // stream-json total_cost_usd (each a priced snapshot that settles on that worker's final
    // bill, not an estimate) by UTC calendar day (State.dailySpendUsd's ts-prefix match) and
    // persisted in State (engine.spend_ledger), so it survives an engine restart mid-day AND
    // renews at the next UTC midnight regardless of restarts — a common misreading (2026-07-13
    // dashboard/cost discussion, #154) is treating this as a run total; it is not (see
    // stop.afterSpendUsd for the actual per-run cap, and docs/configuration.md's knob table).
    // Breaching it is an engine-wide dispatch freeze + drain, not just a per-tick skip (see
    // conductor.ts evaluateCeiling / tick's CEILING step). Enforced POST-HOC at tick
    // boundaries — cost is only known at worker completion, so bounded overshoot ≈
    // lanes.roundDispatchCap × per-worker spend is possible before the freeze.
    dailyBudgetUsd: z.number().finite().positive().default(100),
    // A CONTINUOUS-ACTIVITY window (#14), not total run duration — a common misreading (2026-07-13
    // dashboard/cost discussion, #154). It accumulates only while ticks are actually flowing
    // (State.engineSessionStart: continuous ticking) and RESETS on any quiet gap longer than
    // engineSessionGapSec (max(900s, 2x tickIntervalSec)) — a deep standby wait or a long
    // peripheral stretch resets it, so an idle-heavy multi-day run never trips this. What it
    // actually detects: the dispatch/drain machinery has churned this many seconds without a
    // single quiet quarter-hour — a runaway/batch-scoping smell, not a long-run limiter (a
    // rapid crash-loop still can't evade it, since each tick refreshes the session rather than
    // resetting it). Independent of worker.timeoutSec (which bounds a single worker) and of
    // stop.afterSpendUsd/run duration (there is no run-duration cap at all — see docs/
    // configuration.md's knob table). Conservative default: 4h.
    maxWallClockSec: z.number().int().positive().default(14400),
    // Bounded grace window (#14) after a ceiling breach (daily budget / wall-clock / kill
    // switch) is first detected, during which running workers are asked to hand off
    // gracefully (SIGTERM -> checkpoint -> .handoff) before the conductor escalates to the
    // hard process-tree kill (supervisor.reclaim). "Drain before kill" (PLAN.md Security
    // model) — this is the bound on how long that drain gets. Conservative default: 5min.
    drainWindowSec: z.number().int().nonnegative().default(300),
  })
  .strict();

const Reviewer = z
  .object({
    // The reviewer KIND (gate②'s "who reviews"). NOTE: produce-pr-and-stop was previously a
    // value of this same enum, conflating "who reviews" with "does the Conductor merge" — split
    // out to merge.mode (#13) so the two questions are independent (e.g. same-model-trusted +
    // produce-pr-and-stop is a legal combination). Narrowing this enum is additive/back-compat:
    // sapwood.config.yaml's checked-in `mode: different-model-codex` still parses; nothing ever
    // shipped `mode: produce-pr-and-stop` here.
    mode: z.enum(["different-model-codex", "same-model-trusted", "human"]).default("different-model-codex"),
    // #156: the PR-comment text that requests a review (buildReviewTriggerComment in reviewer.ts).
    // Default matches today's hardcoded `@codex review` byte-for-byte. Lets an operator point the
    // trigger at any bot/reviewer entry point — the verdict PARSER stays Codex-shaped regardless
    // (COMMENTED/APPROVED states, Codex-bot identity); a custom trigger with a different verdict
    // format is out of scope here (v1.x reviewer adapters).
    triggerCommand: z.string().min(1).default("@codex review"),
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
  })
  .strict()
  .superRefine((r, ctx) => {
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

const Merge = z
  .object({
    // conductor-merge (0day-style default): gate① (CI green) + gate② (fresh non-author review on
    // the current head) both pass -> the Conductor squash-merges with --match-head-commit pinned
    // to the head that passed the gates (TOCTOU guard). produce-pr-and-stop: the driver still
    // computes + reports both gates every tick but NEVER calls forge.mergePR — a human merges.
    mode: z.enum(["conductor-merge", "produce-pr-and-stop"]).default("conductor-merge"),
  })
  .strict();

const Labels = z
  .object({
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
  })
  .strict();

// #87: peripheral role sessions (plan-reviewer, plan-drafter, ...) are cheap, issues-only,
// text-judgment tasks — no code, no repo context beyond what's substituted into the prompt.
// Default to a lighter model/effort than worker.model/effort (which does real implementation
// work); still fully YAML-tunable per role, same as every other user-facing knob here.
const RoleSession = z
  .object({
    model: z.string().default("sonnet"),
    effort: z.enum(["low", "medium", "high"]).default("medium"),
    fallbackModel: z.string().default("sonnet"),
  })
  .strict();

// #88/#87: gate⓪ plan-reviewer + plan-drafter peripheral config surface. #88 shipped the
// validated config key + path resolution + the shipped default prompt file ("accepted, not
// yet wired"); #87 (the role runner) is what actually loads/renders/dispatches these.
const Roles = z
  .object({
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
      // #127: switches the WHOLE gate⓪ unit off (plan-reviewer + its plan-drafter, which rides
      // along — the drafter has no toggle of its own, it only ever runs from inside the
      // plan_review phase). false -> round-defaults.ts's createDefaultPeripherals OMITS the
      // plan_review stub; round.ts's own existing default (an unset phase falls back to
      // noopPeripheralStub) takes over, so the phase no-ops with its marker set — never a
      // round.ts change, never a wedged round.
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #87 (#77 Amendment 2's self-heal): the plan-drafter peripheral — issues-only writes, a
    // session distinct from the plan-reviewer, briefed by the reviewer's bounce comment to
    // draft/repair an issue's acceptance criteria + verification plan. Never implements the
    // issue, never approves its own draft (plan-author != plan-approver).
    planDrafter: RoleSession.extend({
      // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/plan-drafter.md`;
      // relative resolves against the CONFIG FILE's directory.
      promptFile: z.string().optional(),
    })
      .strict()
      .default({}),
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
      // #128 DEPRECATED: the top-level `goal.file` key (below) is the current interface — this
      // key is accepted ONLY for back-compat (see resolveGoalFile). Left `.optional()` (no
      // `.default()`) deliberately: a defaulted value would be indistinguishable from an
      // explicit one, and resolveGoalFile's precedence (both-set-and-disagree is a hard error;
      // only-old-set wins with one deprecation log line; neither-set falls through to
      // goal.file's own default) depends on being able to tell "unset" apart from "set to the
      // default string". align.ts/architect.ts no longer read this field directly — every
      // consumer reads the single resolved `cfg.goal.file` instead.
      planMdPath: z.string().min(1).optional(),
      // #132: cap on the {{round.lastMerged}} text substituted into the architect prompt — the
      // engine-assembled post-review context (the PREVIOUS round's merged-PR outcomes, read from
      // its persisted round_artifacts row, #123). Same user-tunable-in-config, marked-cut contract
      // as roles.harvest.artifactMaxChars / roles.retro.digestMaxChars (round-defaults.ts's
      // renderLastMergedFromArtifact reuses retro-digest.ts's capDigest, never a bespoke
      // truncation). Deliberately smaller than either sibling default: this context is just
      // issue/PR/worker triples (no titles or diffs — see renderLastMergedFromArtifact's doc
      // comment for why), so even a large round's merge list stays well under a modest cap.
      lastMergedMaxChars: z.number().int().positive().default(10_000),
      // #127: false -> round-defaults.ts omits the architecting stub; the phase no-ops via
      // round.ts's existing noopPeripheralStub default (see roles.planReviewer.enabled above
      // for the shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #89: the PO (product-owner) peripheral — goal alignment/decomposition at round start
    // (reads the round milestone/theme + docs/PLAN.md, creates issues) plus the round-start
    // triage pass that drafts a plan into any existing plan-less issue. Every PO-created issue
    // carries `origin:agent` + a verification plan; the PO never sets board Status=Ready (locked
    // decision 5 — only a human confirms Ready). Same #74 promptFile shape as every other role
    // above: unset -> the engine's shipped `prompts/po.md`; a relative path resolves against the
    // CONFIG FILE's directory (see loadConfig below), not the CLI's cwd.
    po: RoleSession.extend({
      promptFile: z.string().optional(),
      // #127: false -> round-defaults.ts omits the aligning stub; the phase no-ops via
      // round.ts's existing noopPeripheralStub default (see roles.planReviewer.enabled above
      // for the shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #91: round-close peripheral roles (#77 decision 2's harvest / decision 6's retro). Config
    // key + path resolution + shipped default prompt only — same "accepted, not yet wired" shape
    // #88 shipped for planReviewer before #87 wired it: harvest.ts/retro.ts implement the
    // PeripheralStub, but wiring either into runRounds's default `harvesting`/`retro` peripherals
    // (or the CLI) is a deliberate follow-up, not this issue's scope.
    harvest: RoleSession.extend({
      // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/harvest.md`;
      // relative resolves against the CONFIG FILE's directory.
      promptFile: z.string().optional(),
      // #123: cap on the {{round.artifact}} markdown block substituted into the harvest prompt —
      // same deterministic-truncation contract (and the same user-tunable-in-config rationale)
      // as roles.retro.digestMaxChars. The artifact md is naturally small (bounded by the round's
      // own dispatch cap), so this is a safety valve, not a knob most deployments touch.
      artifactMaxChars: z.number().int().positive().default(20_000),
      // #127: false -> round-defaults.ts omits the harvesting stub; the phase no-ops via
      // round.ts's existing noopPeripheralStub default (see roles.planReviewer.enabled above
      // for the shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
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
      // #127: false -> round-defaults.ts omits the retro stub; the phase no-ops via round.ts's
      // existing noopPeripheralStub default (see roles.planReviewer.enabled above for the
      // shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
  })
  .strict();

const Guard = z
  .object({
    // PreToolUse guard enforcement. HARD (default) = fail-closed deny — the producer≠merger /
    // boundary-write safety boundary. SOFT = observe-only: log what WOULD be blocked, allow it
    // (a first-run trust-ramp / dogfood affordance, never the shipped default). The mode reaches
    // the hook via the SAPWOOD_GUARD_MODE spawn env worker.ts sets — not a worker-writable file —
    // so a worker can't weaken its own guard.
    mode: z.enum(["hard", "soft"]).default("hard"),
  })
  .strict();

const Engine = z
  .object({
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
  })
  .strict();

const Logging = z
  .object({
    path: z.string().min(1).default("data/logs/sapwood.log"),
    teeToStderr: z.boolean().default(true),
    maxBytes: z
      .number()
      .finite()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  })
  .strict();

// #76: goal-based stop conditions — the loop driver's FINAL break conditions ("when is this run
// complete"). All optional; absent = today's behavior exactly (the driver only stops on a signal,
// --once, or --until-idle idleness). CLI --stop-after-issues/--stop-after-prs/--stop-on-milestone
// override these per invocation (cli.ts). OR semantics: the first condition to be satisfied wins
// and converts the rest of the run into an until-idle wind-down (driver.ts) — never a mid-work
// kill of an in-flight lane.
const Stop = z
  .object({
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
    // #154: the per-RUN spend budget — the missing money unit (2026-07-13 dashboard/cost
    // discussion, #17). Distinct from every other cost knob: roundBudgetUsd is per-round/soft,
    // dailyBudgetUsd is a cross-restart calendar-day RATE cap (deliberately never a per-run hard
    // cap — that would reset on every restart and let a crash-loop launder unbounded spend), and
    // the other stop.* conditions above bound WORK, not money. Summed from THIS run's own
    // spend_ledger rows only (State.maxSpendLedgerId's id-cursor, captured once at engine
    // startup — see driver.ts's runDriver / round.ts's runRounds) — a restarted engine starts
    // this sum back at $0, same process-lifetime scope as afterIssuesMerged/afterPRsOpened above,
    // never inheriting a prior run's total (unlike dailyBudgetUsd). Same FLOOR semantics as the
    // count-based conditions: evaluated at tick boundaries, so up to lanes.roundDispatchCap extra
    // lanes may complete (and add to the ledgered total) during the wind-down.
    afterSpendUsd: z.number().finite().positive().optional(),
  })
  .strict();

// #125: standby — the round loop's pre-round probe + exponential backoff. #109's idle throttle
// (round.ts's post-close single-tick wait) paces a round that already ran; standby goes one
// step further and withholds opening a round AT ALL once a pure-GitHub-API probe shows there is
// PROVABLY nothing for it to do (see round.ts's probeHasWork). Ships enabled by default — same
// fail-safe-by-default stance as every other cost knob in this file (Cost above); an operator
// who wants the pre-#125 "always open a round" behavior sets `enabled: false`.
const Standby = z
  .object({
    enabled: z.boolean().default(true),
    // Cap on the backoff wait (tickIntervalSec * 2^n, n = consecutive empty probes). Conservative
    // default: 30min — long enough to actually stop burning peripheral-session tokens on a
    // genuinely idle backlog, short enough that a human re-Ready-ing an issue is noticed same-day.
    backoffCapSec: z.number().int().positive().default(1800),
  })
  .strict();

// #86: round-loop scoping. `milestone` reuses the exact GitHub-milestone mechanism
// stop.onMilestoneComplete already validates against (forge.listMilestoneTitles/
// countOpenIssuesInMilestone) rather than inventing a parallel label-based "theme" — one key
// does both jobs the round loop needs: (1) dispatch-candidate filter (round.ts's
// RoundScopedForge only returns Ready issues whose Issue.milestone matches), and (2) a
// round-level stop condition (the round's dispatch batch is skipped once that milestone has
// zero open issues left). Unset = no scoping, every Ready issue is a candidate (today's
// behavior, unchanged).
const Round = z
  .object({
    milestone: z.string().min(1).optional(),
    standby: Standby.default({}),
    // #126: round directive file — human steering (why/what) injected into the aligning +
    // architecting prompts at round open (directive.ts's resolveRoundDirective). Resolved like
    // other DATA paths in this repo — relative to the process cwd, the same convention
    // state.ts's own dbPath default ("data/sapwood.sqlite") uses — NOT config-file-relative like
    // roles.*.promptFile/planMdPath, since this file lives beside the engine's own runtime data
    // (and gets archived to a sibling `directives/` dir there), not beside a role's shipped
    // prompt. Always has a value (never "unset"), same shape as roles.architect.planMdPath.
    directiveFile: z.string().min(1).default("data/DIRECTIVE.md"),
    // Deterministic-truncation cap (never a silent drop — the cut is marked in the text itself,
    // directive.ts reuses retro-digest.ts's capDigest) on the directive text substituted into the
    // prompts. Same user-tunable-in-config, marked-cut contract as roles.harvest.artifactMaxChars
    // / roles.retro.digestMaxChars.
    directiveMaxChars: z.number().int().positive().default(20_000),
  })
  .strict();

// #128: the loop's north-star goal file — promoted out of `roles.architect.planMdPath` (#104)
// to a top-level key, since it is read by more than just the architect (aligning too, and now
// documented as such rather than piggy-backing on an architect-scoped name). `file` is left
// `.optional()` (no `.default()`) for the same "must tell unset apart from default" reason as
// `roles.architect.planMdPath` above — resolveGoalFile is the ONE place that applies the actual
// default ("docs/PLAN.md") and reconciles the two keys; every other reader sees the resolved
// `cfg.goal.file`, which is ALWAYS a string after parseConfig returns (see the SapwoodConfig
// type override below the schema).
const Goal = z
  .object({
    file: z.string().min(1).optional(),
  })
  .strict();

// #167: repo-level review doctrine — technical invariants (disabled-consumer rule, same-tick
// window rule, crash-rerun set) and adjudication doctrine (how the loop treats review findings),
// authored as prose for LLM readers, deliberately never a lint/DSL. Top-level (not scoped under
// `roles.*`) since it's injected into more than one role's prompt (worker brief + architect
// pass) and cited by name in the prFixCap-style escalation comment — same rationale #128 moved
// `goal.file` out of `roles.architect`. UNLIKE `goal.file`, `file` here carries a real
// `.default()` rather than `.optional()` + a separate resolution step: there is no deprecated
// back-compat key to reconcile against, so there's nothing gained by telling "unset" apart from
// "defaulted" — every reader always sees a concrete path.
const Doctrine = z
  .object({
    file: z.string().min(1).default("docs/REVIEW-DOCTRINE.md"),
    // Deterministic-truncation cap (never a silent drop — the cut is marked in the text itself,
    // doctrine.ts's loadDoctrine reuses retro-digest.ts's capDigest) on the doctrine text
    // substituted into the worker/architect prompts. Same user-tunable-in-config, marked-cut
    // contract as round.directiveMaxChars / roles.architect.lastMergedMaxChars /
    // roles.retro.digestMaxChars. #167 review (Codex P3): `.positive()` alone let an operator
    // configure a cap so small the truncation MARKER itself (capDigest's "...[truncated N
    // chars]" suffix, comfortably under 100 chars) couldn't fit, silently defeating the
    // "marked cut, never a silent drop" contract this comment promises. 200 is a floor
    // comfortably above the marker length with real headroom to spare — not a tight fit users
    // could still trip.
    maxChars: z.number().int().min(200).default(20_000),
  })
  .strict();

const Recovery = z
  .object({
    // #31: bounded retry count for a durably-persisted rollback/requeue (a recovery-path board
    // mutation, e.g. rolling a dispatch-failed claim back to Ready, or requeuing a dead lane).
    // Retried once per tick (State.pendingRollbacks) until it succeeds; past this many failed
    // attempts the conductor stops retrying and escalates (needs-human label attempt + a
    // structured tick-result entry) instead of retrying forever.
    rollbackRetryCap: z.number().int().positive().default(5),
  })
  .strict();

// #168: environment-failure park — detect (signature pattern sets per source), park, probe,
// auto-resume, timed human escalation. User-tunable-in-config (same shipped-commented-YAML
// precedent as labels.*/pricing.yaml): patterns are matched deterministically (env-failure.ts's
// classifyEnvFailure — regex, case-insensitive) against a FAILED lane's own captured output
// (worker.ts's stream-json jsonl, which already merges stdout+stderr onto one fd) — never an LLM
// judgment call (issue #168 decision 2). Defaults are deliberately signature-shaped (API/CLI
// error identifiers, full HTTP-error phrases) rather than bare words like "rate limit" — a
// worker's own prose discussing "the rate limiter" or a test asserting "expected 429, got 500"
// must NOT match (issue #168's required negative test case).
const EnvFailure = z
  .object({
    // Defaults live in env-failure.ts (the classifier's own module) so the shipped pattern set and
    // the code that matches against it can never drift apart — this schema only wraps them in a
    // user-overridable array default. Non-empty (PR #180 review P3-1): an empty pattern set would
    // silently disable env-failure detection for that whole source — if that's genuinely wanted,
    // it should be a deliberate, visible decision, not an accident of clearing an array.
    llmPatterns: z
      .array(z.string().min(1))
      .min(1)
      .default([...DEFAULT_LLM_FAILURE_PATTERNS]),
    forgePatterns: z
      .array(z.string().min(1))
      .min(1)
      .default([...DEFAULT_FORGE_FAILURE_PATTERNS]),
    // Park DURATION (not probe count — bounded exponential backoff makes a probe COUNT an
    // ambiguous measure of elapsed time, issue #168 decision 3) past which the engine additionally
    // notifies a human via the channel ladder (conductor.ts's escalatePark). Additive, never a
    // state transition — probing continues unchanged, auto-resume still fires the instant a probe
    // succeeds, escalated or not. Conservative default: 1h.
    parkEscalateAfterSec: z.number().int().positive().default(3600),
    // Bounded exponential backoff for the probe cadence while parked (env-failure.ts's
    // probeBackoffSec): base * 2^attempts, capped at max.
    probeBackoffBaseSec: z.number().int().positive().default(30),
    probeBackoffMaxSec: z.number().int().positive().default(1800),
    // #168 P1-1 amendment: the llm-source probe is a REAL minimal inference ping (worker.ts's
    // probeLlmPing — see its doc comment for the exact verified argv), not a --version check: it
    // proves network + auth + some account capacity on the CHEAPEST model, while the worker's
    // own (possibly capped) model/tier is still verified by the canary lane the ping merely
    // unlocks. User-tunable per the config rule — an operator whose cheapest available alias
    // differs points this at it.
    probeModel: z.string().min(1).default("haiku"),
    // Hard timeout on one ping (kill + treat as a failed probe). A hung CLI must never wedge a
    // tick — the ping is called inline from tick()'s PARK section.
    probeTimeoutSec: z.number().int().positive().default(30),
    // --max-budget-usd for one ping. EMPIRICAL floor (see probeLlmPing's doc comment): a -p
    // invocation still carries ~7.4k scaffolding tokens even fully stripped, so one ping costs
    // ~$0.016 measured — a cap at or below that floor (e.g. 0.01) makes EVERY probe fail with
    // "Error: Exceeded USD budget (...)" and the engine stays parked until the duration
    // escalation notifies a human (fail-safe, but confusing — which is why the probe's stderr is
    // surfaced in the park-probe event; see docs/configuration.md). 0.05 is verified passing
    // with real headroom.
    probeMaxBudgetUsd: z.number().finite().positive().default(0.05),
  })
  .strict()
  .superRefine((v, ctx) => {
    // PR #180 review P3-1: every pattern must COMPILE at config load — a malformed regex is a
    // fail-fast startup error (`sapwood validate` catches it too), never a silent degradation to
    // the classifier's literal-substring fallback (that fallback stays, as pure defense-in-depth
    // for direct classifyEnvFailure callers, but no config-supplied pattern may rely on it).
    for (const [key, patterns] of [
      ["llmPatterns", v.llmPatterns],
      ["forgePatterns", v.forgePatterns],
    ] as const) {
      patterns.forEach((p, i) => {
        try {
          new RegExp(p, "i");
        } catch (e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, i],
            message: `not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    }
    if (v.probeBackoffMaxSec < v.probeBackoffBaseSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["probeBackoffMaxSec"],
        message:
          `probeBackoffMaxSec (${v.probeBackoffMaxSec}) must be >= probeBackoffBaseSec ` +
          `(${v.probeBackoffBaseSec}) — a cap below the base would make the very first backoff ` +
          `interval unrepresentable`,
      });
    }
  });

// Raw (untransformed) schema — kept internal. `goal.file` and `roles.architect.planMdPath` are
// both still `.optional()` here (see their own doc comments); `ConfigSchema` below wraps this in
// a `.transform(resolveGoalFile)` so EVERY caller of `ConfigSchema.parse`/`.safeParse` — not just
// this module's own `parseConfig` — gets the single resolved `cfg.goal.file`, including the many
// test files across this codebase that build a `SapwoodConfig` via `ConfigSchema.parse({...})`
// directly rather than through `parseConfig`/`loadConfig`. Doing the resolution as a schema-level
// transform (rather than only inside `parseConfig`) means there is no second, easy-to-forget
// call site for a future test or caller to miss.
const ConfigSchemaRaw = z
  .object({
    board: Board,
    engine: Engine.default({}),
    logging: Logging.default({}),
    lanes: Lanes.default({}),
    worker: Worker.default({}),
    guard: Guard.default({}),
    cost: Cost.default({}),
    stop: Stop.default({}),
    round: Round.default({}),
    goal: Goal.default({}),
    doctrine: Doctrine.default({}),
    recovery: Recovery.default({}),
    reviewer: Reviewer.default({}),
    merge: Merge.default({}),
    labels: Labels.default({}),
    roles: Roles.default({}),
    envFailure: EnvFailure.default({}),
    escalation: z
      .object({ humanLabels: z.array(z.string()).default(["needs-human", "blocked"]) })
      .strict()
      .default({}),
    coverage: z
      .object({ minPercent: z.number().min(0).max(100).default(0) })
      .strict()
      .default({}),
    optimize: z
      .object({ recur: z.boolean().default(false) })
      .strict()
      .default({}),
    // Milestones `sapwood init` should ensure exist. Empty = create none (the loop needs
    // labels + board lanes, not milestones — those are the user's organizational choice).
    milestones: z.array(z.string()).default([]),
  })
  .strict();

// #128: `goal.file` is ALWAYS a string once ConfigSchema.parse has run (resolveGoalFile below
// either takes the explicit value, falls back to the deprecated `roles.architect.planMdPath`, or
// applies the shipped default) — the raw schema itself leaves it `.optional()` (see the Goal
// comment above) so the two keys' presence can be told apart during resolution. This override
// is the "single resolved value" the CLAUDE.md/issue #128 design calls for: every consumer
// reads `cfg.goal.file: string`, never the schema-inferred `string | undefined`.
// #167 review (Codex P2+P3 adjudication): `doctrine.fileRaw` is NOT a schema field — it's a
// loadConfig-only annotation (see loadConfig below) preserving the pre-resolution path exactly
// as the user wrote it in config, for callers that need to cite the path back to the user
// (e.g. conductor.ts's gated-reentry-cap escalation comment) without leaking the resolved
// ABSOLUTE local filesystem path onto GitHub. Optional: a caller that builds `cfg` via
// `ConfigSchema.parse` directly (every test in this file, any consumer that skips loadConfig)
// never gets it set — but `cfg.doctrine.file` is already the raw, un-resolved value in that
// path (only loadConfig's relative-to-config-file resolution mutates it), so a reader falls
// back to `cfg.doctrine.file` itself and still never sees a resolved absolute path it didn't
// ask for.
export type SapwoodConfig = Omit<z.infer<typeof ConfigSchemaRaw>, "goal" | "doctrine"> & {
  goal: { file: string };
  doctrine: { file: string; maxChars: number; fileRaw?: string };
};

export const DEFAULT_GOAL_FILE = "docs/PLAN.md";

/** #128: reconcile the top-level `goal.file` key with the deprecated
 *  `roles.architect.planMdPath` back-compat key into the single resolved `cfg.goal.file`.
 *  Precedence (CTO design, issue #128):
 *    - both set and they DISAGREE -> hard config error naming both keys (never silently pick
 *      one over the other — an operator who set both almost certainly meant to change one and
 *      forgot the other was still there).
 *    - both set and they AGREE -> no error, no deprecation noise (nothing to warn about beyond
 *      "stop setting the old key eventually").
 *    - only the OLD key set -> it wins (today's behavior, unbroken), and exactly ONE
 *      deprecation line is logged pointing at `goal.file`.
 *    - only the NEW key set, or neither -> `goal.file` (defaulting to DEFAULT_GOAL_FILE when
 *      neither is set) — already what `cfg.goal.file` holds coming in, nothing to do.
 *  Either way, `roles.architect.planMdPath` is CLEARED (set to `undefined`) on the way out — it
 *  has been fully consumed into `cfg.goal.file`, no consumer reads it again (align.ts/
 *  architect.ts both moved to `cfg.goal.file`), and clearing it makes this function idempotent
 *  under a second pass (e.g. init.ts's `ConfigSchema.parse(cfg)` boundary re-validation of an
 *  already-loaded, already-resolved config): a second transform sees the old key already gone
 *  and leaves `cfg.goal.file` untouched, rather than re-comparing a since-resolved absolute
 *  `goal.file` against a still-relative `planMdPath` and spuriously erroring.
 *  Exported for testing; mutates and returns the same object (ConfigSchemaRaw.parse's output is
 *  a fresh plain object per call, never shared/frozen, so this is safe). */
export function resolveGoalFile(cfg: z.infer<typeof ConfigSchemaRaw>): SapwoodConfig {
  const newKey = cfg.goal.file;
  const oldKey = cfg.roles.architect.planMdPath;
  if (newKey !== undefined && oldKey !== undefined) {
    if (newKey !== oldKey) {
      throw new Error(
        `config error: both goal.file ("${newKey}") and the deprecated roles.architect.planMdPath ` +
          `("${oldKey}") are set and disagree — remove one (goal.file is the current key; ` +
          `roles.architect.planMdPath is back-compat only) or make them match.`,
      );
    }
    // Both set and they agree: nothing to warn about, cfg.goal.file already holds the value.
  } else if (oldKey !== undefined) {
    console.error(
      "[sapwood:config] deprecation: roles.architect.planMdPath is deprecated — set goal.file " +
        `instead (still honored for back-compat this run, resolved to "${oldKey}").`,
    );
    cfg.goal.file = oldKey;
  } else if (newKey === undefined) {
    cfg.goal.file = DEFAULT_GOAL_FILE;
  }
  cfg.roles.architect.planMdPath = undefined; // consumed — see doc comment above
  return cfg as SapwoodConfig;
}

/** The schema every real caller uses: `ConfigSchemaRaw` plus the `goal.file`/deprecated-key
 *  resolution transform (see resolveGoalFile's doc comment for why the transform lives here,
 *  not only inside `parseConfig`). */
export const ConfigSchema = ConfigSchemaRaw.transform(resolveGoalFile);

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
  // Run logs are repo/config scoped just like prompt files. Unlike promptFile, logging.path is
  // defaulted, so the default is resolved too whenever a config file is loaded.
  if (!isAbsolute(cfg.logging.path)) {
    cfg.logging.path = resolve(dirname(file), cfg.logging.path);
  }
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
  if (cfg.roles.planReviewer.promptFile !== undefined && !isAbsolute(cfg.roles.planReviewer.promptFile)) {
    cfg.roles.planReviewer.promptFile = resolve(dirname(file), cfg.roles.planReviewer.promptFile);
  }
  // #87: same rule for the plan-drafter prompt.
  if (cfg.roles.planDrafter.promptFile !== undefined && !isAbsolute(cfg.roles.planDrafter.promptFile)) {
    cfg.roles.planDrafter.promptFile = resolve(dirname(file), cfg.roles.planDrafter.promptFile);
  }
  // #90: same rule for the architect prompt.
  if (cfg.roles.architect.promptFile !== undefined && !isAbsolute(cfg.roles.architect.promptFile)) {
    cfg.roles.architect.promptFile = resolve(dirname(file), cfg.roles.architect.promptFile);
  }
  // #128: same rule for the resolved north-star goal file — UNLIKE promptFile this key always
  // has a value by the time loadConfig runs (parseConfig's resolveGoalFile step already applied
  // the old-key/new-key precedence and the default), so there's no `!== undefined` guard: every
  // non-absolute value, default or explicit, resolves against the config file's directory, not
  // the CLI's cwd. Supersedes the old roles.architect.planMdPath resolution (deleted here) —
  // align.ts/architect.ts now read cfg.goal.file only.
  if (!isAbsolute(cfg.goal.file)) {
    cfg.goal.file = resolve(dirname(file), cfg.goal.file);
  }
  // #167: same rule for the resolved review-doctrine file — always has a value (it carries a
  // real `.default()`, not `goal.file`'s optional-then-resolved shape), so every non-absolute
  // value, default or explicit, resolves against the config file's directory, not the CLI's cwd.
  // #167 review (Codex P2+P3): capture the RAW pre-resolution value FIRST — conductor.ts's
  // gated-reentry-cap escalation comment cites this (never the resolved absolute path below) so
  // a public GitHub comment never leaks this machine's local directory layout. See
  // `SapwoodConfig`'s `doctrine.fileRaw` doc comment above for the full contract.
  cfg.doctrine.fileRaw = cfg.doctrine.file;
  if (!isAbsolute(cfg.doctrine.file)) {
    cfg.doctrine.file = resolve(dirname(file), cfg.doctrine.file);
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
