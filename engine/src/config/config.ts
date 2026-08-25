// sapwood config: load sapwood.config.yaml (YAML default; JSON parses for free via
// the YAML parser, YAML ⊃ JSON), validate with Zod, apply defaults. Decision #7/#3.
//
// Every configurable behavior is a named, documented, defaulted field here — no hidden
// hard-coding.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  holdLabelDefault,
  labelsInclude,
  normalizeLabel,
  SAPWOOD_LABEL_PREFIX,
  TAXONOMY_SPECS,
  workflowLabelDefaults,
} from "../forge/labels.js";
import { DEFAULT_FORGE_FAILURE_PATTERNS, DEFAULT_LLM_FAILURE_PATTERNS } from "../loop/env-failure.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { defaultRuntimeRoot, runtimePaths } from "./paths.js";

export const DEFAULT_EGRESS_SUSPECT_COMMANDS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
] as const;

const Board = z
  .object({
    // No hard-coded PROJECT_NUMBER / user-vs-org / literal status names — board identity and
    // status labels are configured per repo, not baked into the engine.
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
    // #577: conservative by design — cap new dispatches between retro-feedback opportunities at
    // two unless an operator explicitly chooses a larger multi-wave quota for their deployment.
    roundDispatchCap: z.number().int().positive().default(2),
    reserveCap: z.number().int().nonnegative().default(1),
    // #246: the FIXABLE gate's fix_rounds cap — deriveGate
    // (merge-driver.ts) folds HANDLE_THREADS/CI_RED straight to its pre-#246 behavior
    // (HUMAN/WAIT) whenever this is 0, so an operator who wants zero automatic fix legs gets
    // BYTE-FOR-BYTE today's behavior, not a differently-shaped escalation. Above 0, driveDecision
    // (conductor.ts) dispatches a fix leg (startFixLeg) while a lane's fix_rounds stays under the
    // cap; reaching it escalates needs-human for adjudication (#147's gated reentry is the
    // post-adjudication channel back in). Accepted at parse time since #147 (this was the
    // "reserved, not yet wired" `prFixCap` key); #246 is the first real consumer.
    //
    // #450 (design #402 R3, §8, D6): default raised 2 -> 4. Semantics UNCHANGED — still a hard
    // per-PR ceiling on paid fix legs, not repurposed or renamed; `prFixCap: 0` still folds
    // straight to needs-human exactly as today (config.test.ts's own pin). What changed is that
    // this is no longer the ONLY stop: `review/convergence.ts`'s classifier now escalates a
    // STALLED lane before it ever reaches this cap (`loop/conductor.ts`'s `driveDecision`), so the
    // cap is reached only by lanes still measurably converging by the engine's own progress
    // signal. Evidence for 4 specifically (not left at 2, not raised to match the single worst
    // observed case): PR#388 needed 4 review rounds and PR#389 needed 5, every round finding a
    // real bug — at the old default of 2 both would have escalated with real defects still in
    // them. 4, not 5: with convergence live, a lane STILL converging at round 4 is an outlier
    // worth a human look; the #147 gated-reentry path already lets a human wave such a lane back
    // in for more rounds without a config change. A config that sets this explicitly is completely
    // unaffected — same number, same semantics; only the default-relying case changes.
    prFixCap: z.number().int().nonnegative().default(4),
    frictionMin: z.number().nonnegative().default(0),
    // #147: bounds the GATED RECLAIM phase
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
    // #582 (owner ruling 2026-08-03, option (a)): worker default STAYS opus. The gate-above-
    // producer ordering is satisfied by DEFAULT_REVIEWER_AGENT_MODEL moving to a THIRD tier
    // ("fable", above opus) instead of swapping the pair — a swap made the repo's own explicit
    // `worker.model: opus` collide with a defaulted opus reviewer under D5 (PR #590 round 1),
    // and any validation that rejects the shipped default combination is self-contradictory.
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
    // #172: each graceful handoff may re-enter as a fresh worker leg, but never forever.
    // 0 disables automatic resume; the initial leg is not counted here.
    maxResumes: z.number().int().min(0).default(2),
    heartbeatStaleSecs: z.number().int().positive().default(180),
    // #304: lexical, post-hoc tripwire over each completed worker leg's stream-json Bash
    // tool calls. This table is operator-tunable because repo-governed egress-capable commands
    // differ; worker.ts records matching executables as events but never blocks the lane.
    egressSuspectCommands: z.array(z.string()).default([...DEFAULT_EGRESS_SUSPECT_COMMANDS]),
    // #74: file-based worker prompt. A relative path is resolved against the CONFIG FILE's
    // directory (see loadConfig), so the same config works no matter what cwd the CLI runs
    // from. Unset (default) -> the shipped preset at the engine package's `prompts/worker.md`
    // (resolved relative to the engine's own install location, not this repo — see
    // worker.ts's defaultPromptPath). Set-but-missing/unreadable/empty is a fail-fast startup
    // error (buildRenderPrompt loads it once, eagerly, before any dispatch) — never a silent
    // fallback to the shipped default.
    promptFile: z.string().optional(),
    // #245: file-based FIX-LEG prompt — the instruction a fix leg (a `fixing`-state resume,
    // #172's machinery reused, never a fresh dispatch) receives instead of the ordinary
    // issue-rendered prompt above. Same #74 promptFile shape: a relative path resolves against
    // the CONFIG FILE's directory; unset (default) -> the shipped preset at the engine package's
    // `prompts/fix.md` (see worker.ts's defaultFixPromptPath). Set-but-missing/unreadable/empty
    // is a fail-fast startup error (buildRenderFixPrompt loads it once, eagerly) — never a
    // silent fallback to the shipped default.
    fixPromptFile: z.string().optional(),
    // #33 follow-up (PR #85 human review): user-editable model rate table for the soft-budget
    // token estimator. Same shape as promptFile (#74): a relative path resolves against the
    // CONFIG FILE's directory (see loadConfig); unset (default) -> the shipped preset at the
    // engine package's `pricing.yaml` (see pricing.ts's defaultPricingPath). Set-but-missing/
    // unreadable/malformed is a fail-fast startup error (loadPricingTable, loaded once at
    // supervisor construction) — never a silent fallback to the shipped default.
    pricingFile: z.string().optional(),
    // #606 (#351 final ruling): the L1 scoped-worker-identity per-repo SSH deploy key —
    // `sapwood init` provisions it (ssh-keygen + `gh repo deploy-key add --allow-write`) and
    // writes this key back into the config file. #1078: UNLIKE promptFile/pricingFile above, a
    // relative path here resolves against CWD (see loadConfig) — the key file lives beside the
    // engine's own runtime root, not beside a role's shipped prompt, so it follows that same
    // cwd-relative convention instead of promptFile's config-file-relative one. Unset (default)
    // -> L0, today's behavior unchanged (a worker leg inherits the operator's full credentialed
    // env).
    // Set -> worker.ts probes SSH auth once per engine life; success activates L1 (git-transport-
    // only env, `Bash(gh *)` dropped from the leg's tool grant) on every dispatch/resume/fix leg;
    // failure WARNs with a re-provision instruction and dispatch stays at L0 (never wedges). A
    // set-but-missing file is a probe failure, not a startup error — unlike promptFile/pricingFile,
    // an operator without repo-admin legitimately has no key to point at yet (see init.ts's
    // guidance-carrying WARN for that path).
    deployKeyPath: z.string().optional(),
    // #606 gate② round 1 (owner ruling, supersedes the title-only design): the deploy key's
    // GitHub-assigned numeric id, paired with deployKeyPath as the LOCAL anchor init.ts's
    // ensureDeployKey reconciles against. The remote key TITLE is never authoritative for "is
    // this mine" — a `sapwood-worker` title on the repo may validly belong to a different
    // machine/operator, so idempotence and reconciliation key on this (path, id) pair instead.
    // Written by init.ts alongside deployKeyPath; unset means no local key has ever been
    // recorded (fresh provisioning runs). Both fields are set/cleared together — never one
    // without the other — see init.ts's writeDeployKeyConfigIntoYaml/clearDeployKeyConfigFromYaml.
    deployKeyId: z.number().int().positive().optional(),
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
    // stop.afterSpendUsd for the actual per-run cap, and docs/guide/configuration.md's knob table).
    // Breaching it is an engine-wide dispatch freeze + drain, not just a per-tick skip (see
    // conductor.ts evaluateCeiling / tick's CEILING step). Enforced POST-HOC at tick
    // boundaries — cost is only known at worker completion, so bounded overshoot ≈
    // lanes.roundDispatchCap × per-worker spend is possible before the freeze.
    dailyBudgetUsd: z.number().finite().positive().default(100),
    // #431 (F29): a PER-PROCESS attention alarm — one clock per process life, anchored at
    // process start (in memory, never persisted), breached when THIS process has been alive
    // longer than this many seconds. A restart — manual, script, or supervisor — is a
    // sanctioned renewal and starts a fresh clock at any gap length (owner adjudication
    // 2026-07-30: the old session-gap machinery measured process liveness, not autonomous
    // action — a parked wait loop burned the whole budget doing nothing). This is NOT a
    // security boundary: the durable cross-restart bounds are cost.dailyBudgetUsd +
    // guard/gates/kill-switch; crash-loop abuse is the rapid-restart detector's job
    // (engine.rapidRestart below) plus the operator's own supervisor circuit-breaker
    // (docs/security.md — a PREREQUISITE for unattended supervised runs). Note: a 24h life
    // can straddle UTC midnight and therefore two dailyBudgetUsd periods (~2x worst-case
    // single-life spend; this existed at the old 4h default with smaller magnitude).
    // Independent of worker.timeoutSec (which bounds a single worker); there is still no
    // run-duration cap (see docs/guide/configuration.md's knob table). Default: 24h.
    maxWallClockSec: z.number().int().positive().default(86400),
    // Bounded grace window (#14) after a ceiling breach (daily budget / wall-clock / kill
    // switch) is first detected, during which running workers are asked to hand off
    // gracefully (SIGTERM -> checkpoint -> .handoff) before the conductor escalates to the
    // hard process-tree kill (supervisor.reclaim). "Drain before kill" (PLAN.md Security
    // model) — this is the bound on how long that drain gets. Conservative default: 5min.
    drainWindowSec: z.number().int().nonnegative().default(300),
  })
  .strict();

// #501: the default Claude model assigned to an INJECTED reviewer.agent block (Reviewer's own
// `.transform()` below) — deliberately different from worker.model's own default ("opus") so the
// ordinary zero-config parse never trips D5 (ConfigSchema's top-level superRefine). Exported for
// tests, same convention as DEFAULT_GOAL_FILE/DEFAULT_CONFIG_PATHS below.
// #582 (owner ruling 2026-08-03, option (a)): moved sonnet -> "fable", a THIRD tier that sits
// ABOVE opus (D5's gate-at-or-above-producer ordering) while differing from BOTH worker
// defaults — so the zero-config parse AND a config that only sets `worker.model: opus` (this
// repo's own sapwood.config.yaml) stay valid by construction. A pair-swap (worker sonnet /
// reviewer opus) was rejected in PR #590 round 1: it made the shipped explicit worker: opus
// collide with its own defaulted reviewer. An operator whose worker IS fable sets
// reviewer.agent.model explicitly — the D5 error message names the one-line fix.
// D5 is unchanged and still only enforces DIFFERENCE; the ordering is a defaults + docs
// statement plus a `sapwood validate` warning (cli.ts), never a parse-time rejection — model
// strings are free-form and the rate table is only a proxy for capability, so a hard fail would
// reject legitimate setups (a cross-vendor reviewer whose rates aren't comparable at all).
export const DEFAULT_REVIEWER_AGENT_MODEL = "fable";

// #501: identity marker for a reviewer.agent block this module itself injected (Reviewer's
// `.transform()` below) rather than one a user supplied — read only by ConfigSchema's top-level
// D5 check, so its rejection message can name the simpler one-line fix for the defaulted case
// ("set reviewer.agent.model", not "choose a different value than what you wrote"). A WeakSet
// keyed on the agent object itself (never the whole config, never a config field) is invisible to
// every other reader: it changes no schema, no inferred type, no serialized/logged shape — purely
// an internal signal between these two steps in the same parse.
const injectedReviewerAgents = new WeakSet<object>();

// #286 (E4a, design #279 §7): reviewer.agent — the engine-agent reviewer kind's OWN config
// block, present only when reviewer.mode: engine-agent (dead-config rejected otherwise, see
// Reviewer's superRefine below). `model` is REQUIRED (no default) WHEN A USER SUPPLIES THIS
// BLOCK THEMSELVES and parse-rejected when it equals worker.model (D5, model separation) —
// checked at the TOP-LEVEL ConfigSchema.superRefine below, since worker.model lives in a sibling
// section this scoped block can't see. `.strict()`: NO `fallbackModel` field (design #279 §7's
// "all v2 strictness retained ... no fallbackModel") — an engine-agent session's own resilience
// is the retry-once-within-budget path (engine-agent.ts), never a model swap the way worker/role
// sessions get one.
// #501: `model` has no schema-level `.default()` — a bare zod default here could not see
// worker.model (a sibling section) and so could not avoid colliding with it. When a config omits
// this whole block under `mode: engine-agent`, Reviewer's own `.transform()` below injects one
// (DEFAULT_REVIEWER_AGENT_MODEL) instead — see that transform's doc comment for why the
// injection lives there rather than as a bare schema default.
const ReviewerAgent = z
  .object({
    model: z.string().min(1),
    // #443 (design adjudication 2026-08-01): WHICH local CLI executes the review session — the
    // reviewer-local executor seam (review/review-session.ts). `claude` (the default) is
    // byte-for-byte today's behavior: RoleRunner.run()'s `reviewCwd` facility, unchanged.
    // `codex-exec` runs the same session through a locally invoked `codex exec` process instead
    // (review/codex-exec.ts), giving gate② a CROSS-VENDOR review with none of the hosted
    // `@codex review` connector's failure modes. NOT to be confused with `reviewer.mode:
    // different-model-codex`, which asks a HOSTED GitHub App to review and spawns nothing locally.
    // Living inside this block means the existing dead-config rule already covers it: `runner` set
    // while `mode` isn't engine-agent is rejected with the rest of `reviewer.agent`.
    runner: z.enum(["claude", "codex-exec"]).default("claude"),
    // #443 (R1): the pinned per-million-token prices the codex-exec runner's ESTIMATED spend is
    // computed from — it has no hard budget mechanism, so `costCapUsd` degrades to advisory and
    // spend is recorded as a flagged estimate (see review/codex-exec.ts). User-tunable rather than
    // hardcoded because list prices differ per model and plan. Dead config for the `claude` runner
    // (which reports real dollars) — rejected below rather than silently ignored.
    codexPricing: z
      .object({
        inputUsdPerMTok: z.number().finite().nonnegative(),
        outputUsdPerMTok: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
    effort: z.enum(["low", "medium", "high"]).default("high"),
    // Same #74 promptFile pattern as worker.promptFile: unset -> the engine's shipped
    // `engine/prompts/engine-reviewer.md`; a relative path resolves against the CONFIG FILE's
    // directory (see loadConfig below). Never hardcode the prompt TEXT in source (CLAUDE.md's
    // user-tunables-in-config rule) — this key is how an operator overrides it.
    promptFile: z.string().optional(),
    // Whole-LOGICAL-REVIEW cost cap (design #279 §6): attempt 1 gets this in full; a retry (on
    // an invalid/unparseable first attempt) gets the REMAINDER, never a second full cap.
    costCapUsd: z.number().finite().positive().default(3),
    // Backoff between paid primary attempts on the SAME head after an `unavailable` verdict
    // (design #279 §2's "UNAVAILABLE pin"). Positive int, conservative default: 15min.
    retryAfterSec: z.number().int().positive().default(900),
    // Maximum materialized review trees retained across non-live heads. Trees for in-flight or
    // escalated WAL heads are excluded from collection, so evidence needed for human resolution
    // can exceed this bound until that lane records a decisive outcome.
    treeRetentionCap: z.number().int().positive().default(10),
  })
  .strict()
  .superRefine((a, ctx) => {
    // #443 (R1): the SAME dead-config stance the `reviewer.agent` block itself gets. A pricing
    // table is meaningless for the `claude` runner (whose CLI reports real `total_cost_usd`), so
    // shipping one there would read as "my estimates are configured" while nothing consults it.
    if (a.runner !== "codex-exec" && a.codexPricing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codexPricing"],
        message:
          `reviewer.agent.codexPricing is set but reviewer.agent.runner is "${a.runner}", not codex-exec — ` +
          "the pricing table only feeds the codex-exec runner's estimated-spend recording; remove it or set " +
          "runner: codex-exec (dead config is rejected, never silently ignored)",
      });
    }
  });

// #286 (E4a, design #279 §4): CI execution-evidence config — which CheckRun name+App pairs
// count as trusted execution evidence for a code-verifiable AC's `confirmed` status (a
// same-named check from an UNTRUSTED app is not evidence, §4's R3 GraphQL-app-slug binding).
// E4a ships the SCHEMA only (this PR's own scope note: "adding the schema here is fine and keeps
// the [reviewer.mode: engine-agent + empty list] warning implementable"); E4b (#287) is the
// actual CONSUMER — the getPRChecks query + deriveGate's CI-evidence chain.
// #426 (F26): this block is now also the home of the gate①-PENDING aging bound — the same
// section, because both keys answer "how does sapwood treat this repo's CI signal".
const Ci = z
  .object({
    // #426 (F26): how long (seconds, wall-clock) a lane may sit continuously WAIT-on-CI — gate②
    // decisive (MERGE_OK) with a check rollup that is neither green nor red — before the engine
    // calls a human, exactly like reviewer.escalateAfterSec does for review silence. A check that
    // hangs `IN_PROGRESS` forever otherwise wedges the lane permanently: deriveGate returns WAIT
    // every tick and neither drain arm can see it. Default 6h — GitHub Actions' own hard job
    // ceiling, so nothing legitimately running can cross it.
    // Review round 2 (P1-1): "neither green nor red" INCLUDES a check that concluded without
    // passing (cancelled/skipped/neutral/stale/action_required) — gate① is SUCCESS-only (#401), so
    // that lane cannot progress on its own either and is aged, and escalated, exactly the same.
    pendingEscalateAfterSec: z.number().int().positive().default(21600),
    // gate② opus round 1 P2 (#797): the companion bound for a CONCLUDED-but-not-green rollup
    // (`PRStatus.ciInert`) — every check finished, none failed, but at least one concluded without
    // passing (SKIPPED/NEUTRAL/CANCELLED/STALE/ACTION_REQUIRED). Unlike `pendingEscalateAfterSec`'s
    // target (a check that may still finish), this state can NEVER resolve on its own head, so it
    // gets its own (shorter) default — 900s, not 21600s. CORRECTS the #783-era comment this
    // replaces, which claimed this bound would run "rather than sharing the pending clock": once
    // wired, it does NOT get an independent clock. `ciPendingDuration`'s durable pin
    // (`CiPendingPin`) is stamped ONCE, at whichever moment gate① first goes not-green — pending or
    // inert, whichever comes first — never re-stamped when a pending rollup later flips inert. So
    // `inertEscalateAfterSec` only SELECTS THE SHORTER of the two bounds against that SAME shared
    // pin once the rollup reads inert; a pending<->inert flip never resets it (only a head move or
    // gate① actually resolving green/red does). Once an episode has escalated at this shorter
    // bound, the `needsHuman` label latch — the same suppression `pendingEscalateAfterSec` already
    // relies on — is what prevents a SECOND escalation later at the longer `pendingEscalateAfterSec`
    // bound on that same episode, not a separate pin reset.
    // #783 wiring (gate② opus round 1, PM-direct human-owned remainder, 2026-08-11): WIRED —
    // merge-driver.ts's `ciEscalationBound` implements exactly this "shorter bound, same pin"
    // semantics (never a fresh per-inertness timer), and conductor.ts's escalation branch emits
    // `ci-inert-escalated` with the actionable comment when it fires. See `ciEscalationBound`'s
    // own doc for the precedence rule composing this with #792's engine-agent `evidenceWait`.
    inertEscalateAfterSec: z.number().int().positive().default(900),
    requiredChecks: z
      .array(
        z
          .object({
            name: z.string().min(1),
            app: z.string().min(1).default("github-actions"),
          })
          .strict(),
      )
      .default([]),
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
    // #286 (E4a): "engine-agent" added — the engine-side LLM review agent (design #279).
    // Deliberately NOT added to `fallback`'s own enum below (engine-agent is PRIMARY-ONLY; a
    // same-model verdict gating its own producer via the failover path is exactly D5 exists to
    // prevent) — the enum difference IS the parse-time rejection design #279 §7 calls for.
    // #501 (owner ruling 2026-08-01): default flipped different-model-codex -> engine-agent — a
    // fresh sapwood user already has the Claude CLI sapwood itself needs, but not necessarily the
    // hosted `@codex review` GitHub App the old default depended on. `engine-agent` runs locally
    // on that same CLI. Hosted Codex stays fully selectable (`mode: different-model-codex`); see
    // docs/PLAN.md's locked-decisions table (Decision #5) states the current default and rationale.
    mode: z.enum(["different-model-codex", "same-model-trusted", "human", "engine-agent"]).default("engine-agent"),
    // #156: the PR-comment text that requests a review (buildReviewTriggerComment in reviewer.ts).
    // Default matches today's hardcoded `@codex review` byte-for-byte. Lets an operator point the
    // trigger at any bot/reviewer entry point — the verdict PARSER stays Codex-shaped regardless
    // (COMMENTED/APPROVED states, Codex-bot identity); a custom trigger with a different verdict
    // format is out of scope here (v1.x reviewer adapters).
    triggerCommand: z.string().min(1).default("@codex review"),
    // Bound consecutive X..Y delta re-reviews. Once this many deltas have been requested,
    // the next head move requests the full PR diff and resets the chain.
    deltaChainMax: z.number().int().positive().default(3),
    trustedReviewers: z.array(z.string()).default([]),
    // #54: EXPLICIT, ordered opt-in list of reviewer modes to fail over to when the primary
    // (reviewer.mode) is unavailable for longer than failoverAfterSec. Each entry keeps its OWN
    // mode semantics (identity allowlist for bot modes; any-non-author-approval for human) —
    // reused unchanged from the mode implementations above, never forked. DEFAULT EMPTY: no
    // fallback configured means exactly today's behavior — an unavailable primary queues the PR
    // forever. This is a deliberate no-silent-degradation default (docs/guide/configuration.md's
    // `reviewer.fallback` entry): falling from a different-model review to same-model/human
    // changes gate②'s trust properties, so it never happens unless an operator explicitly opts in.
    fallback: z.array(z.enum(["different-model-codex", "same-model-trusted", "human"])).default([]),
    // How long (seconds, wall-clock since the last review trigger for the current head) the
    // primary reviewer may stay non-decisive (WAIT_REVIEW / REVIEW_UNAVAILABLE) before
    // merge-driver.ts's resolveReviewVerdict hands gate② to the first fallback entry that itself
    // reaches a decisive verdict. Irrelevant when `fallback` is empty. Conservative default: 20
    // minutes.
    failoverAfterSec: z.number().int().positive().default(1200),
    // #170: wall-clock age of a current-head, non-decisive review trigger before the engine
    // calls a human. Visibility only: the PR receives needs-human while gate② stays unchanged.
    escalateAfterSec: z.number().int().positive().default(86400),
    // #286 (E4a): the engine-agent kind's own sub-config — see ReviewerAgent's doc above.
    // Optional at the schema level: `mode !== engine-agent` and `agent` set is dead-config
    // rejected below, and `mode === engine-agent` with `agent` unset is DEFAULT-INJECTED by this
    // schema's own `.transform()` below (#501) rather than rejected — a bare zod `.default()`
    // can't express it (the injected value depends on `mode`, not a fixed literal).
    agent: ReviewerAgent.optional(),
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
    // #286 (E4a): the SAME fail-closed rule, now ALSO applied to the PRIMARY mode (the original
    // check above only ever looked at `fallback`) — a same-model-trusted PRIMARY with nobody
    // trusted can never produce MERGE_OK either (SameModelTrustedReviewer.verdictFromData's own
    // empty-list short-circuit), so shipping it silently would leave gate② queuing every PR
    // forever with no signal, the exact failure mode the fallback check above already guards
    // against for the failover position.
    if (r.mode === "same-model-trusted" && r.trustedReviewers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message:
          "reviewer.mode is same-model-trusted but reviewer.trustedReviewers is empty — that mode " +
          "can never produce a verdict (fail-closed), so gate② would be silently inert; add " +
          "trustedReviewers logins or choose a different mode",
      });
    }
    // #286: DUPLICATE kinds in `fallback` ⇒ reject, for every kind — a repeated entry is always
    // either a copy-paste mistake or dead config (the SAME mode implementation would just be
    // re-evaluated twice at the same failover position), never a legitimate ordering.
    const seenFallbackKinds = new Set<string>();
    for (const kind of r.fallback) {
      if (seenFallbackKinds.has(kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fallback"],
          message: `reviewer.fallback contains a duplicate entry ("${kind}") — each fallback kind may appear at most once`,
        });
        break; // one issue names the problem; the whole array is rejected either way
      }
      seenFallbackKinds.add(kind);
    }
    // #286: reviewer.agent dead-config rule (design #279 §7's "all v2 strictness retained ...
    // dead-config rejection"). #501: the OTHER half of this pair — `mode: engine-agent` with
    // `agent` unset — used to be rejected here too ("engine-agent requires reviewer.agent"); it
    // is now DEFAULT-INJECTED instead by this schema's `.transform()` below, since engine-agent
    // is the new zero-config default and a zero-config parse must succeed. This dead-config check
    // is unaffected: it only ever fires for a USER-SUPPLIED `agent` block, and the transform below
    // never adds one when `mode !== engine-agent`, so an injected block can never trip it.
    if (r.mode !== "engine-agent" && r.agent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agent"],
        message:
          `reviewer.agent is set but reviewer.mode is "${r.mode}", not engine-agent — reviewer.agent is ` +
          "only meaningful for the engine-agent mode; remove it or set mode: engine-agent (dead config is " +
          "rejected, never silently ignored)",
      });
    }
  })
  .transform((r) => {
    // #501: default-inject reviewer.agent when `mode` resolves to "engine-agent" — whether by
    // the schema default just above or an explicit `mode: engine-agent` — and no `agent` block
    // was supplied. Placed here (a transform chained AFTER this schema's own superRefine, i.e.
    // the Reviewer-level resolution step) rather than as a bare schema default, so that:
    //   (a) the dead-config check above still runs against the RAW, pre-injection value — it can
    //       only ever see a USER-SUPPLIED agent block, never one this transform adds, so it can
    //       never fire on an injected default; and
    //   (b) ConfigSchema's own top-level superRefine (D5: reviewer.agent.model !== worker.model),
    //       which runs strictly after this whole `reviewer` field has finished parsing, always
    //       sees the FULLY RESOLVED agent block — a defaulted one is checked for the worker.model
    //       collision exactly like a user-supplied one, never silently exempted.
    // DEFAULT_REVIEWER_AGENT_MODEL ("fable") differs from worker.model's own default ("opus"),
    // so the ordinary zero-config case never collides; an operator who sets ONLY worker.model to
    // "fable" still hits the D5 rejection (see that check's own doc for the extended,
    // defaulted-case error message). injectedReviewerAgents (below) marks the block so that
    // message can name it as defaulted rather than user-set.
    if (r.mode === "engine-agent" && r.agent === undefined) {
      const agent = ReviewerAgent.parse({ model: DEFAULT_REVIEWER_AGENT_MODEL });
      injectedReviewerAgents.add(agent);
      r.agent = agent; // mutate-and-return, same pattern as resolveLabelDefaults
      // below — keeps the inferred type identical to the pre-transform shape (agent stays
      // OPTIONAL in the TYPE; only the runtime value gains the default).
    }
    return r;
  });

const Merge = z
  .object({
    // conductor-merge (the default): gate① (CI green) + gate② (fresh non-author review on
    // the current head) both pass -> the Conductor squash-merges with --match-head-commit pinned
    // to the head that passed the gates (TOCTOU guard). produce-pr-and-stop: the driver still
    // computes + reports both gates every tick but NEVER calls forge.mergePR — a human merges.
    mode: z.enum(["conductor-merge", "produce-pr-and-stop"]).default("conductor-merge"),
  })
  .strict();

const Labels = z
  .object({
    prefix: z
      .string()
      .refine((value) => !/\s/.test(value), "labels.prefix must not contain whitespace")
      .default(SAPWOOD_LABEL_PREFIX),
    inProgress: z.string().optional(),
    needsHuman: z.string().optional(),
    blocked: z.string().optional(),
    reserve: z.string().optional(),
    verifyNa: z.string().optional(), // Decision #8: skips the verification-plan gate
    // #88 gate⓪ (amends Decision #8 per #77's 2026-07-09 comment): a verification plan must
    // also pass the verification-plan-reviewer peripheral's quality review before getReadyIssues dispatches
    // it — plan presence alone is no longer enough. Applied by that peripheral only (never by
    // the loop on a verify:n/a issue — the two dispatch paths are mutually exclusive).
    planApproved: z.string().optional(),
    // #89: provenance stamp for agent-created issues (docs/security.md's convention, now
    // load-bearing): align.ts's PO orchestrator applies it to every issue the alignment
    // session creates. Config-driven like every sibling label here — never a hardcoded
    // string at the call site (fable PR #101 P3).
    originAgent: z.string().optional(),
    // #310: split is the human firing signal; decomposed is the engine's permanent parent
    // fence. Both follow labels.prefix like every other workflow label.
    split: z.string().optional(),
    decomposed: z.string().optional(),
    // #212: round-pool membership label — applied by the aligning phase's pool-selection pass
    // (align.ts's selectRoundPool), consumed by the executing phase's dispatch-scoping wrapper
    // (round.ts's PoolScopedForge). Same omitted-default pattern as every sibling label above.
    roundPool: z.string().optional(),
    // #397: the two labels that split `needs-human`'s six overloaded meanings apart.
    // `humanMergeOnly` is bucket 2 (a human must merge this PR) — written on the PR only, never
    // listed in escalation.humanLabels (P1 decision: a lane on this verdict is excluded from
    // gated reclaim structurally, via gated_escalation_labeled, not by a label fence).
    // `planless` is the class-6 routing fence that was never an escalation at all. Both follow
    // labels.prefix and use the same omitted-default pattern as every sibling label above.
    humanMergeOnly: z.string().optional(),
    planless: z.string().optional(),
    // #399: the PR-side lane-state mirror — applied to a lane's PR while the lane is
    // `driving`/`fixing`, removed the moment it reaches any terminal state (loop/lane-state-
    // label.ts). Same omitted-default pattern as every sibling label above; unlike them it is
    // ENGINE-REMOVED as well as engine-written, which is why the collision guard below treats it
    // exactly like `roundPool` (an alias would let the engine strip the aliased label too).
    laneState: z.string().optional(),
  })
  .strict();

// #87: peripheral role sessions (verification-plan-reviewer, verification-plan-drafter, ...) are cheap, issues-only,
// text-judgment tasks — no code, no forge credentials, no `gh`/git write capability (#110's
// empty ROLE_ALLOWED_TOOLS + #218's credential-stripped spawn env). #236 (locked ruling,
// 2026-07-17): they DO receive ambient repo context by design — `claude -p` in a repo worktree
// legitimately absorbs that worktree's CLAUDE.md, the user's global CLAUDE.md/memory, and the
// CLI's other dynamic system-prompt sections, same as any interactive session would. The trust
// boundary here is action-side (#219: what a session can DO), never content-side (what it can
// READ) — sealing this channel would contradict that locked boundary. The obligation is
// honesty/diagnosability, not isolation: a session attempt's effective context is recorded
// (peripheral.ts's context-manifest assembly, state.ts's context_manifests table) for ALL 9/9
// runSessionWithRetry peripheral call sites (harvest, architect, plan-review's reviewer, drafter,
// and #214's confirm session, retro, and — as of #251 — align.ts's three PO sessions: po-align,
// po-triage, po-pool), never silently varying between retries. See
// docs/security.md ("Ambient repo context") and
// docs/guide/configuration.md for the channel and its rationale; docs/security.md also documents the
// clean-directory `--bare`-style isolation recipe for BENCHMARK runs only (never production —
// `--bare` disables hooks, so the guard can't ship with it).
// Default to a lighter model/effort than worker.model/effort (which does real implementation
// work); still fully YAML-tunable per role, same as every other user-facing knob here.
const RoleSession = z
  .object({
    model: z.string().default("sonnet"),
    effort: z.enum(["low", "medium", "high"]).default("medium"),
    fallbackModel: z.string().default("sonnet"),
  })
  .strict();

// #88/#87: gate⓪ verification-plan-reviewer + verification-plan-drafter peripheral config surface. #88 shipped the
// validated config key + path resolution + the shipped default prompt file ("accepted, not
// yet wired"); #87 (the role runner) is what actually loads/renders/dispatches these.
const Roles = z
  .object({
    verificationPlanReviewer: RoleSession.extend({
      // Same #74 promptFile pattern as worker.promptFile: unset -> the engine's shipped
      // `prompts/verification-plan-reviewer.md`; a relative path resolves against the CONFIG FILE's own
      // directory (see loadConfig below), not the CLI's cwd.
      promptFile: z.string().optional(),
      // #214: the LIGHTWEIGHT freshness re-confirm prompt — a pool member carrying plan:approved
      // from a PRIOR round gets this one-question pass ("does this plan still hold against
      // current main?") instead of a full verification-plan-reviewer pass, every time it re-enters the round
      // pool (gate⓪ scoped to the pool, #214). Same #74 promptFile pattern as promptFile above:
      // unset -> the engine's shipped `prompts/verification-plan-reviewer-confirm.md`; a relative path
      // resolves against the CONFIG FILE's directory (see loadConfig below). Deliberately its own
      // key rather than reusing promptFile — the two prompts ask structurally different
      // questions (full quality review vs. a single confirm/invalidate judgment) and a deployment
      // may want to tune them independently.
      confirmPromptFile: z.string().optional(),
      // #77 Amendment 2 (gate⓪ self-heal): max draft→re-review cycles per issue before the
      // loop gives up and applies needs-human with the attempt trail (Decision #9's
      // degrade-to-human) — the bound that keeps the self-heal path from livelocking.
      // Positive int only: 0 would turn every request-a-draft outcome into an instant
      // needs-human, silently disabling the self-heal path. Enforced by the #87 role
      // runner's plan_review phase.
      maxDraftCycles: z.number().int().positive().default(2),
      // #127: switches the WHOLE gate⓪ unit off (verification-plan-reviewer + its verification-plan-drafter, which rides
      // along — the drafter has no toggle of its own, it only ever runs from inside the
      // plan_review phase). false -> round-defaults.ts's createDefaultPeripherals OMITS the
      // plan_review stub; round.ts's own existing default (an unset phase falls back to
      // noopPeripheralStub) takes over, so the phase no-ops with its marker set — never a
      // round.ts change, never a wedged round.
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #87 (#77 Amendment 2's self-heal): the verification-plan-drafter peripheral — issues-only writes, a
    // session distinct from the verification-plan-reviewer, briefed by the reviewer's bounce comment to
    // draft/repair an issue's acceptance criteria + verification plan. Never implements the
    // issue, never approves its own draft (plan-author != plan-approver).
    verificationPlanDrafter: RoleSession.extend({
      // Same #74 promptFile pattern: unset -> the engine's shipped `prompts/verification-plan-drafter.md`;
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
      // #132: cap on the {{round.lastMerged}} text substituted into the architect prompt — the
      // engine-assembled post-review context (the PREVIOUS round's merged-PR outcomes, read from
      // its persisted round_artifacts row, #123). Same user-tunable-in-config, marked-cut contract
      // as roles.harvest.artifactMaxChars / roles.retro.digestMaxChars (round-defaults.ts's
      // renderLastMergedFromArtifact reuses retro-digest.ts's capDigest, never a bespoke
      // truncation). Deliberately smaller than either sibling default: this context is just
      // issue/PR/worker triples (no titles or diffs — see renderLastMergedFromArtifact's doc
      // comment for why), so even a large round's merge list stays well under a modest cap.
      lastMergedMaxChars: z.number().int().positive().default(10_000),
      // #213: cap on the {{round.pool}} text substituted into the architect prompt — this
      // round's batch-review target (number/title/body of every cfg.labels.roundPool member,
      // #212), engine-assembled at architect-invocation time (round-defaults.ts). Same
      // user-tunable-in-config, capDigest-bounded contract as lastMergedMaxChars above; kept as
      // its OWN key (not reused) since the pool digest carries full issue BODIES (like
      // candidates.summary), a very different size profile than lastMergedMaxChars's
      // numbers-only render.
      poolDigestMaxChars: z.number().int().positive().default(20_000),
      // #666: consecutive same-issue `drop` verdicts with an UNCHANGED issue body (this many, in
      // a row, no body edit in between) before the architect escalates to needs-human instead of
      // applying another `drop` — same-reason re-drop churn. A `drop` is deliberately
      // this-round-only (removeRoundPoolLabel), which is right for an issue that gets fixed
      // between rounds, but an issue that stays Ready UNCHANGED just re-enters the pool and gets
      // dropped again for the identical premise defect, forever — unbounded spend plus a
      // duplicate drop comment every round, with no escalation. Same bound-then-degrade paradigm
      // as maxPoolRemovalAttempts above; positive int only, same "0 defeats the retry it's meant
      // to bound" rationale.
      maxConsecutiveDrops: z.number().int().positive().default(2),
      // #127: false -> round-defaults.ts omits the architecting stub; the phase no-ops via
      // round.ts's existing noopPeripheralStub default (see roles.verificationPlanReviewer.enabled above
      // for the shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #89: the PO (product-owner) peripheral — goal alignment/decomposition at round start
    // (reads the round milestone/theme + the goal file, creates issues) plus the round-start
    // triage pass that drafts a plan into any existing plan-less issue. Every PO-created issue
    // carries `origin:agent` + a verification plan; the PO never sets board Status=Ready (locked
    // decision 5 — only a human confirms Ready). Same #74 promptFile shape as every other role
    // above: unset -> the engine's shipped `prompts/po.md`; a relative path resolves against the
    // CONFIG FILE's directory (see loadConfig below), not the CLI's cwd.
    po: RoleSession.extend({
      promptFile: z.string().optional(),
      // #310: the decompose sub-mode has a distinct prompt but shares the PO role posture and
      // model settings. Same #74 path semantics as every other roles.* prompt file.
      decomposePromptFile: z.string().optional(),
      // One firing can create only this many children, including coarse remainders.
      maxChildren: z.number().int().positive().default(8),
      // Prompt-only granularity heuristic. Gate⓪'s hard checks remain plan + non-empty checkbox
      // AC extraction; this hint never becomes a scheduling estimate or hard dispatch gate.
      acceptanceCriteriaHint: z.number().int().positive().default(5),
      // #432 round 5 (P1-2, degrade-to-human): dissent.ts's durable-concern retry sweep
      // (reconcileDurableConcerns) gives up posting a concern's comment after this many recorded
      // failures (a permanently unreadable/inaccessible issue — deleted, transferred, locked —
      // is the deterministic case; a transient blip retries and clears well under the cap) and
      // escalates needs-human instead, the same bound-a-retry-loop-then-degrade-to-human paradigm
      // roles.verificationPlanReviewer.maxDraftCycles/lanes.prFixCap already use. Positive int only: 0 would
      // escalate on the very first transient failure, defeating the retry it's meant to bound.
      maxConcernPostAttempts: z.number().int().positive().default(5),
      // #212 (gate① F1): the round-pool SELECTION session's own prompt — a distinct file from
      // promptFile above (align/triage), same #74 pattern: unset -> the engine's shipped
      // `prompts/po-pool.md`; a relative path resolves against the CONFIG FILE's directory (see
      // loadConfig below). Runs after align/triage, reuses this same role's model/effort/
      // fallbackModel — a separate template because its job (choose up to cap issues from an
      // engine-supplied candidate digest) is unrelated to align/triage's issue-authoring job.
      poolPromptFile: z.string().optional(),
      // #215: hard bound on the engine-assembled {{backlog.digest}} injected into align mode.
      // capDigest marks every cut; the floor leaves room for its marker and for the explicit
      // zero/read-failure notes, which must never collapse into an indistinguishable blank.
      // #212: also reused (unmodified) as the pool-selection candidate digest's cap. With a
      // title-only line that digest was naturally far smaller (bounded by the pool cap — a
      // handful of issues), so this shared knob was a safety valve there too, not a dedicated
      // budget most deployments tune. Since each pool candidate now carries its FULL body, this
      // digest has the same size profile as `roles.architect.poolDigestMaxChars` below — a REAL
      // budget on that path now, not a knob most deployments can ignore (see
      // `docs/guide/configuration.md`'s row for the consequence when it bites).
      backlogDigestMaxChars: z.number().int().min(200).default(20_000),
      // #127: false -> round-defaults.ts omits the aligning stub; the phase no-ops via
      // round.ts's existing noopPeripheralStub default (see roles.verificationPlanReviewer.enabled above
      // for the shared rationale). #212/#233: pool SELECTION is the one exception — it still
      // runs every round regardless of this flag; see align.ts's runPoolSelection and
      // `poolSelection` below, which is what actually gates the SESSION now.
      enabled: z.boolean().default(true),
      // #233: default `false` — the pool-selection SESSION is an opt-in experiment, decoupled
      // from `enabled` above (which still only gates align/triage). Controlled tiered testing
      // — run against the THEN title-only session, before it was given full candidate bodies —
      // found the session selects EVERY candidate at every model tier: it had no evidentiary
      // basis (a bare title/number digest) to narrow the reservoir, so paying for a session
      // every round just reproduced the deterministic fallback it would otherwise degrade to.
      // Worse, `round.poolFactor` exists specifically to over-select and absorb gate⓪/architect
      // attrition; a session that DOES narrow the reservoir pre-gates risks underfilling the
      // round for no observed benefit. The one non-trivial selection ever observed was traced
      // to contaminated test context, not a real judgment the session made from candidate
      // titles alone. `true` restores the #212 session path unchanged (validation, retry-once,
      // degrade-open to the full candidate set, the durable `pool-selected` event, label
      // reconcile) for deployments that want to keep experimenting with it. Each candidate's
      // FULL body was later substituted into that opt-in session's digest — the finding above
      // was never re-run against that body-bearing input, so it remains the reason the default
      // stays `false`, not a claim about what today's opt-in session is actually shown.
      // Benchmark note: when evaluating the experimental selector, isolate worktree/code reads
      // for that run — production sessions may read the repo, but that is an uncontrolled
      // signal for this specific experiment (this session's intended input is each candidate's
      // title/number/labels/body, not a repo read).
      poolSelection: z.boolean().default(false),
    })
      .strict()
      .default({}),
    // #91: round-close peripheral roles (#77 decision 2's harvest / decision 6's retro). Config
    // key + path resolution + shipped default prompt only — same "accepted, not yet wired" shape
    // #88 shipped for verificationPlanReviewer before #87 wired it: harvest.ts/retro.ts implement the
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
      // round.ts's existing noopPeripheralStub default (see roles.verificationPlanReviewer.enabled above
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
      // only, same rationale as roles.verificationPlanReviewer.maxDraftCycles above (0 has no sane meaning).
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
      // #453 (design #402 R5, §5): how many rounds the digest's finding-class TENDENCY table
      // spans, the current round inclusive (K=1 = this round only). Everything else in the
      // digest is bounded by one round's start_event_id, but the recurrence this table exists
      // to surface (the #191/#170/#172 -> M9-wave shape) happens ACROSS rounds. Bounded and
      // operator-tunable rather than a hardcoded window: a fast-cycling run wants a wider one,
      // a long-round run a narrower one. Positive int only — 0 would tabulate nothing while
      // still rendering the section, which is a silently useless table rather than a bound.
      // Fewer rounds in the ledger than K degrades to what exists, never an error.
      tendencyRounds: z.number().int().positive().default(3),
      // #127: false -> round-defaults.ts omits the retro stub; the phase no-ops via round.ts's
      // existing noopPeripheralStub default (see roles.verificationPlanReviewer.enabled above for the
      // shared rationale).
      enabled: z.boolean().default(true),
    })
      .strict()
      .default({}),
    // #639: engine-rendered role-session skill injection (docs/security.md's marker-delimited
    // human-merge-only-paths/ac-evidence-tiers sections, pulled verbatim into an immutable
    // content-hash-named plugin dir and attached via `--plugin-dir` — see skills-plugin.ts).
    // Default false: v1 ships the mechanism unattached everywhere; #639's own PR series flips
    // this to true only after a follow-up measures the effect (docs/security.md's "Config"
    // note). `false` -> every claudeArgs()-producing caller stays byte-identical to pre-#639
    // argv — resolveSkillsPluginDir short-circuits before ever reading docs/security.md.
    skills: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

// #234: engine-hosted read-only forge MCP proxy for role sessions (supersedes #217's two-pass
// needsDetails protocol). #244 EXTENSION: the tool algebra also carries 6 PR-facing tools
// (pr_details/pr_reviews/pr_review_threads/pr_checks/pr_audit_comments/pr_failed_checks —
// proxy/tools.ts), and the proxy MECHANISM extends to worker legs (worker.ts's
// WorkerSupervisor, mirroring RoleRunner's `proxy` opt)
// alongside RoleRunner peripheral sessions. `caps.maxReviewThreadsPerCall`/
// `caps.maxCommentsPerThread` are the PR-tool caps' user-tunable knobs, same convention as every
// other cap in this section. #975: `pr_failed_checks` deliberately adds NO cap here — its
// excerpt is already hard-capped forge-side (`FAILED_CHECK_SUMMARY_CAP`, `forge.ts`), so there
// is no user-tunable knob to expose without duplicating that cap under a second name.
//
// #253: engine startup (cli.ts's runTickEngine/runRoundsEngine, round.ts's buildFixLegResume)
// reads `enabled` to decide production attachment. #551 deleted the three-state model's middle
// state (`shadow`): it never had distinct runtime semantics — `proxy/mint.ts::createProxyMint`
// reads only `caps`/`budget`/`timeoutMs`, never `enabled`, so a scoped harness could always mint
// in any state, and the three production attachment guards only ever consulted
// `enabled && !shadow`, which collapses to `enabled` once the middle state is gone. Two states
// now:
//
//   1. `enabled: false`: fully inert, exactly as #234 originally shipped. No engine startup path
//      constructs anything; flipping every other proxy.* key changes nothing. `prFixCap > 0`
//      with `enabled: false` still degrades every FIXABLE gate to a needs-human escalation —
//      `conductor.ts` appends one `fix-leg-dispatch-unconfigured` event PER GATE (reason
//      `fix-loop-unwired:<reason>`). That is distinct from `cli.ts::announceFixLoopUnattached`,
//      which emits a separate `fix-loop-unattached` event ONCE PER RUN at startup — a startup
//      announcement, not itself a gate escalation.
//   2. `enabled: true` (#551 default): full production attachment. Both live drivers attach a
//      real `fixLegResume` to the fix-loop worker leg, and `runRoundsEngine` attaches a real
//      `defaultProxy` to every peripheral role session (aligning/architecting/plan_review/
//      harvesting/retro).
//
// STILL UNWIRED regardless of `enabled`: ordinary (non-fix-loop) `WorkerSupervisor.dispatch()`
// for the main coding-worker leg has no production caller attaching a proxy — that would require
// touching conductor.ts's DISPATCH call site, out of #253's/#551's own scope. Review sessions
// also never get a handle regardless of `enabled`: `peripheral.ts` throws on `proxy` +
// `reviewCwd`, forces `proxyOpt = undefined` in review mode, and both drivers construct their
// engine-review `RoleRunner`s without `defaultProxy` — #551 asserted this explicitly as the
// regression the flip could plausibly have caused.
const ProxyConfig = z
  .object({
    enabled: z.boolean().default(true),
    caps: z
      .object({
        maxIssuesPerCall: z.number().int().positive().default(10),
        defaultCommentsPerIssue: z.number().int().positive().default(20),
        maxCommentsPerCall: z.number().int().positive().default(100),
        // .max(100): this cap is passed straight into a GraphQL `first:`/`last:` argument
        // (getIssueRelations' ISSUE_RELATIONS_QUERY) — GitHub's GraphQL API itself rejects a
        // connection argument above 100, so a configured value beyond that would fail at the
        // FIRST call, not at config-parse time (Codex sol-high PR #260 review, P2 audit).
        maxRelationsPerIssue: z.number().int().positive().max(100).default(20),
        maxSearchResults: z.number().int().positive().default(20),
        // issue #234's default-view contract: "Full comment stream is opt-in config." false
        // (default) -> issue_details' default view caps at defaultCommentsPerIssue; true -> it
        // caps at the wider maxCommentsPerCall instead (still bounded, never truly unbounded).
        fullCommentStreamOptIn: z.boolean().default(false),
        // #244: pr_review_threads' analogue of maxCommentsPerCall/defaultCommentsPerIssue —
        // caps the NUMBER of threads returned (an explicit lastN over this is REJECTED, same
        // over-cap contract as issue_comments). NOT itself fed into a GraphQL first:/last:
        // argument (PR_REVIEW_THREADS_QUERY always pages the outer connection at a fixed 100
        // per page, exhaustively — this cap only bounds the CLIENT-SIDE array afterward), so no
        // GraphQL-imposed .max(100) applies here.
        maxReviewThreadsPerCall: z.number().int().positive().default(20),
        // #244: caps EACH thread's own comment count (GraphQL comments(first: ...)) —
        // independent of maxReviewThreadsPerCall's bound on the number of threads. .max(100):
        // same GraphQL-argument-ceiling rationale as maxRelationsPerIssue above (Codex sol-high
        // PR #260 review, P1).
        maxCommentsPerThread: z.number().int().positive().max(100).default(20),
        // #244 (Codex sol-high PR #260 review, P1): pr_reviews' fetch bound — GraphQL
        // `reviews(last: cap)`. No client-supplied lastN exists for this tool (unlike
        // pr_review_threads), so this cap IS the fetch bound; over-cap rejection doesn't apply
        // (there is no caller-suppliable value to reject) — completeness is reported instead
        // (`complete: reviews.length >= total`). .max(100): fed straight into GraphQL's `last:`.
        maxReviewsPerCall: z.number().int().positive().max(100).default(50),
        // #244 (Codex sol-high PR #260 review, P1): pr_checks' fetch bound — GraphQL
        // `contexts(first: cap)`. Same no-lastN/completeness-not-rejection stance as
        // maxReviewsPerCall above. .max(100): fed straight into GraphQL's `first:`.
        maxChecksPerCall: z.number().int().positive().max(100).default(50),
        // #288: pr_audit_comments' caller-visible return cap, applied AFTER marker filtering.
        maxAuditCommentsPerCall: z.number().int().positive().max(100).default(20),
        // #288: independent top-level-comment scan window, fed to GraphQL `last:` before marker
        // filtering. Keeping this wider than the return cap prevents ordinary-comment spam from
        // prematurely displacing audit evidence. GitHub caps connection arguments at 100.
        maxAuditCommentScanWindow: z.number().int().positive().max(100).default(100),
      })
      .strict()
      .default({}),
    budget: z
      .object({
        maxCallsPerSession: z.number().int().positive().default(30),
        maxBytesPerSession: z.number().int().positive().default(2_000_000),
      })
      .strict()
      .default({}),
    // Hard per-call ceiling (a hung upstream `gh` call must never wedge a session waiting on the
    // proxy forever) — independent of worker.timeoutSec, which bounds the WHOLE session.
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .strict();

// #410 (decision record: architect/product-owner/PM three-party review + measurement): the ONE
// config surface for the built-in WebSearch/WebFetch grant to the three direction-setting role
// sessions (architect, po-align, po-triage — peripheral.ts's ARCHITECT_ALLOWED_TOOLS/
// PO_ALIGN_ALLOWED_TOOLS/PO_TRIAGE_ALLOWED_TOOLS named exports). Default true: the capability is
// read-only, carries no credential into any project system, is strictly weaker than the egress
// the worker already has unrestricted (docs/security.md's "Worker network egress: accepted blind
// spot"), and every call is journalled through the SAME scanEgressSuspects path the worker's own
// tripwire uses (worker.ts). `false` falls every one of those three sessions back to the base
// ROLE_ALLOWED_TOOLS/PO_ALLOWED_TOOLS pair — no WebSearch/WebFetch reaches them at all. The
// review family (verification-plan-reviewer/verification-plan-drafter/verification-plan-reviewer-confirm, and every gate② reviewer
// form) never reads this key — their sessions never widen past ROLE_ALLOWED_TOOLS regardless of
// this flag, by construction (no call site threads it in), not by convention.
// Not a grandfathered exception to capability DR #616's "no capabilities.* config surface will
// ever be built" — that ban is scoped to producer (worker) legs only (docs/security.md's
// host-delegated capability management section); this key gates a peripheral-role grant, outside
// the ruling's scope entirely. Predates #616 and stays as-is; not precedent for a new
// producer-leg capability toggle.
const WebAccess = z
  .object({
    enabled: z.boolean().default(true),
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

// #1011 (DR #1009, Decision #11 amendment): host EXECUTION-PROFILE key — it configures HOW a
// session's already-granted tools reach the host (execution reach), never WHICH tools a producer
// leg is offered (host-delegated capability management, Decision #11, unchanged and unrelated —
// no `capabilities.*` surface is reopened here). Semantics copied verbatim from docs/security.md's
// "Execution profiles" section — that section, not this file, is the place to read the full
// seven-layer table and deployment-tier ladder.
const Host = z
  .object({
    // The ONE mode requested via `--permission-mode` for EVERY claude session the engine spawns
    // (worker legs and every peripheral role session alike). The engine's deny side
    // (--disallowedTools, the guard hook, gate②'s seal) stays engine-owned across all three
    // values — only the allow side moves. `auto` (default): unchanged from every sapwood release
    // before this key existed — a classifier reviews actions in place of a human prompt.
    // `dontAsk`: only an explicit `permissions.allow` rule / read-only Bash command / guard-
    // approved call runs; the allow side is the OPERATOR's own Claude settings, never a new
    // engine `allowedTools` config key. `bypassPermissions`: everything runs unchecked, including
    // writes to Claude Code's own protected paths — an operator call the engine does not gate;
    // configuring it triggers one guidance-carrying startup WARN (log + event) naming the
    // outer-boundary recipe docs/security.md documents, never a refusal.
    permissionMode: z.enum(["dontAsk", "auto", "bypassPermissions"]).default("auto"),
  })
  .strict();

const Engine = z
  .object({
    // The loop's tick cadence (#46): how often the drivers call tick() — the inter-tick sleep
    // and the #395 watchdog window. (#431 deleted the wall-clock session-gap scaling this used
    // to feed; the wall clock now anchors to in-memory process start and never reads the
    // cadence.) Conservative default: 1 minute (docs/guide/configuration.md's `tickIntervalSec` entry).
    tickIntervalSec: z.number().int().positive().default(60),
    // #431 (owner amendment 1): the rapid-restart detector — the crash-loop protection that
    // REPLACES the deleted session-gap heuristic without reviving F29. At startup the engine
    // counts its own recent process births (`run-started` events, appended exactly once per
    // boot — wait-loop iterations can never inflate the count, by construction) inside
    // `windowSec`; reaching `maxBirths` parks the engine (no autonomous dispatch) with a local
    // escalation until a later start observes the window drained. Rationale: a crash-loop is
    // definitionally not the operator's standing intent; normal restarts renew freely. The
    // numbers are heuristics, hence config keys (user-tunables rule), not constants.
    rapidRestart: z
      .object({
        // Births (process starts) within the window that trip the detector — the CURRENT start
        // counts as one, so 5 means "this is the 5th start in windowSec".
        maxBirths: z.number().int().positive().default(5),
        // The birth-counting window, in seconds.
        windowSec: z.number().int().positive().default(600),
      })
      .strict()
      .default({}),
    // #106: which engine `sapwood run` drives. "rounds" (default, v0.2 north star) — the round
    // orchestrator (round.ts's runRounds + round-defaults.ts's createDefaultPeripherals): peripheral
    // roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the same tick
    // engine, batch-dispatch-then-drain per round. "tick" — the bare M4 loop driver (driver.ts's
    // runDriver), unchanged: no peripherals, --once/--until-idle apply. Kept reachable as an
    // explicit escape hatch (docs/guide/configuration.md's `driver` row); not deprecated, just no
    // longer the default.
    driver: z.enum(["rounds", "tick"]).default("rounds"),
  })
  .strict();

// #395 (gate② round 3, P2): cross-field validation reference constants for the watchdog window
// (ConfigSchema's own top-level superRefine below, where engine.tickIntervalSec and
// liveness.watchdogTickMultiplier are both in scope) — NOT independently user-configurable
// themselves; they anchor the "the window must comfortably outlive a heartbeat cadence" rule a
// bare per-field .positive() can't express.
//   - DEFAULT_HEARTBEAT_CADENCE_MS: the role-session/worker-leg heartbeat interval both
//     peripheral.ts's RoleRunner and worker.ts's WorkerSupervisor default `heartbeatMs`/`hbMs`
//     to when a caller doesn't override it (neither is cfg-driven today). A watchdog window
//     shorter than this would kill a healthy session before its very first heartbeat could ever
//     prove it's still alive.
//   - WATCHDOG_HEARTBEAT_MARGIN: how many heartbeat cadences the window must clear — 20x, chosen
//     so it reproduces the shipped defaults exactly (engine.tickIntervalSec=60 x
//     liveness.watchdogTickMultiplier=10 = 600_000ms = 30_000ms x 20) rather than introducing a
//     second, independently-tunable number nobody asked for; this validation only ever bites an
//     OVERRIDE that shrinks the window well below what the defaults already establish as safe.
//   - NODE_MAX_TIMEOUT_MS: Node's own `setTimeout`/`execFile({timeout})` ceiling (a 32-bit signed
//     int of milliseconds) — a configured window past this is SILENTLY CLAMPED by Node to an
//     effectively-immediate fire, the opposite of what a large, "conservative" value is meant to
//     do. Rejected at config-parse time rather than silently misbehaving at runtime.
const DEFAULT_HEARTBEAT_CADENCE_MS = 30_000;
const WATCHDOG_HEARTBEAT_MARGIN = 20;
const NODE_MAX_TIMEOUT_MS = 2_147_483_647;

// #395 (F24 dogfood incident, gate② round 2): engine liveness — bounded external awaits (every
// `gh`/`git` call, role-session/worker-leg spawn confirmation) plus a PROGRESS-BASED liveness
// watchdog (watchdog.ts's startProgressWatchdog). User-tunable per the config rule (never
// hardcoded) — the live incident was a host sleeping ~49h mid-round with a role-session spawn/
// network call in flight: the process woke alive but emitted zero events for 30+ minutes because
// nothing bounded that await and nothing noticed. Every duration here exists to close exactly
// that class of wedge.
const Liveness = z
  .object({
    // Hard per-call ceiling on a single `gh`/`git` CLI invocation (gh.ts's
    // `gh`/`ghText`/`ghWithTimeout` — the ONE place the engine shells out to `gh`, forge.ts's
    // GithubForge.gh routes every forge call through it; review/materializer.ts's private-clone
    // fetch/clone/checkout reuse this same knob rather than a second one just for git). Same
    // rationale/shape as proxy.timeoutMs's own doc ("a hung upstream `gh` call must never wedge
    // a session waiting ... forever"). Most callers fail toward retry — GithubForge is called
    // either from inside tick() (an unguarded throw there is CONTAINED by driver.ts's/round.ts's
    // own tick-error handling, retried next tick/round) or from a caller with its own local
    // try/catch (probeForgeReachable, checkFinalMilestone, escalatePark's forge-comment
    // fallback, ...) — classifyEnvFailure/park itself is driven exclusively by WORKER-LEG
    // output TEXT, never by GithubForge's own exceptions, so a `gh` timeout cannot directly
    // trigger a park episode. It CAN still reach a fatal exit indirectly, by design: peripheral
    // stubs (e.g. align.ts's own crash-rerun-safe forge calls) call the forge directly and are
    // deliberately NOT contained the way tick()'s own forge calls are, so a burst of timeouts
    // there can propagate to cli.ts's top-level `process.exit(1)` — the same pre-existing
    // fail-fast stance any other burst of forge failures on that path already has, not a new gap
    // this default introduces. 60s (not 30s, proxy.timeoutMs's own value): several forge.ts
    // reads are `gh api --paginate` over potentially large pages (getCommitsSince,
    // getPRReviewData's reactions/comments, getIssueComments) — a legitimately slow-but-would-
    // succeed call on that shape needs more headroom than a single small read. Empirically ample
    // for this repo's own heaviest paginated read (~0.5s).
    forgeCallTimeoutMs: z.number().int().positive().default(60_000),
    // Hard ceiling on the wait for a freshly spawned child (a role session, peripheral.ts's
    // RoleRunner.run, or a worker leg, worker.ts's WorkerSupervisor.dispatch/resume) to report
    // Node's own `spawn`/`error` event. Node gives that confirmation no timeout of its own — a
    // callback lost across a host sleep (the #395 live incident) hangs the await forever without
    // one. On timeout the (possibly still-alive) child is best-effort killed and the attempt
    // fails toward retry, the same way a genuine spawn error already does.
    spawnConfirmTimeoutMs: z.number().int().positive().default(30_000),
    // The liveness watchdog (watchdog.ts's startProgressWatchdog, armed once per engine run by
    // BOTH the "tick" driver — driver.ts's runDriver — and the "rounds" driver — round.ts's
    // runRounds, the production default): a generous MULTIPLE of engine.tickIntervalSec — never
    // a fixed absolute duration, so a legitimately slow cadence is never itself a false alarm —
    // past which NO DURABLE EVENT has been appended (state.maxEventId unchanged), regardless of
    // which phase is running or how long it legitimately takes. Deliberately NOT keyed on tick()
    // completion or duration: `reviewer.mode: engine-agent` awaits a full LLM review session
    // INLINE inside tick(), bounded only by worker.timeoutSec (default 3600s, up to two
    // attempts) — a healthy 10-20 minute review would trip any duration-based window tight
    // enough to be useful, self-killing the engine mid-review. Progress-based sidesteps that
    // trade entirely (see watchdog.ts's own doc for the full reasoning) — but only works because
    // several otherwise-quiet stretches (an inline review/role session, an ordinary worker leg,
    // round.ts's standby backoff and park-recovery waits) now emit a periodic heartbeat event
    // specifically so they don't starve this counter; see each site's own comment. Fires a
    // durable `engine-stalled` event (state.appendEvent) and exits the process nonzero so a
    // supervisor can restart it — deliberately NOT an in-process self-heal/abort (PM ruling: the
    // smallest thing that works; a stuck await's resources are reclaimed by the process exit
    // itself, never by cancelling it in place). Conservative default (10x): with the shipped
    // tickIntervalSec default (60s) that's a 10-minute window with no progress at all —
    // comfortably longer than any healthy heartbeat cadence (hbMs defaults to 30s).
    watchdogTickMultiplier: z.number().positive().default(10),
    // #407: the consecutive-stall breaker (loop/stall-breaker.ts) — the watchdog's OTHER half.
    // The watchdog above diagnoses ONE stall (durable `engine-stalled` + nonzero exit, so a
    // supervisor can restart); this threshold decides when restarting stops being the answer:
    // once this many CONSECUTIVE runs have each ended in a self-diagnosed stall with no round
    // closed anywhere between them (a deterministic wedge — the same bug re-wedging every
    // restart), the next start parks autonomous dispatch and escalates to a human instead of
    // blind-retrying forever. A transient wedge (host sleep, a passing outage) closes rounds
    // between its stalls, which resets the streak — it never accumulates strikes. User-tunable
    // per the config rule (never hardcoded); 3 gives a supervisor two honest retries before the
    // breaker decides the wedge is deterministic.
    maxConsecutiveStalls: z.number().int().positive().default(3),
  })
  .strict();

const Logging = z
  .object({
    // #1078: no schema default — unset means "use the runtime root's own log location"
    // (runtimePaths(defaultRuntimeRoot()).logFile, cwd-relative), which loadConfig below fills
    // in AFTER parse, not here. A SET value is an operator-authored file reference (same class
    // as promptFile/goal.file/doctrine.file) and stays config-file-relative, exactly like those
    // — see loadConfig's own resolution step for the two rules side by side.
    path: z.string().min(1).optional(),
    teeToStderr: z.boolean().default(true),
    maxBytes: z
      .number()
      .finite()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  })
  .strict();

// #210 (docs/reference/frontend-design.md §11 follow-up 5): the dashboard's own knobs. Schema only for
// now — the v0.2 dashboard reads them; nothing in the engine does yet.
const Dashboard = z
  .object({
    // Gates the Operations verbs (start/pause/resume/stop) and the `POST /api/control` route
    // that serves them. Default `true`: the dashboard the round-2 amendment designed drives the
    // loop, not just watches it. `false` = a pure-SPECTATOR dashboard — buttons absent and the
    // route refuses, so a read-only deployment (a shared screen, a demo) cannot be clicked into
    // touching the loop. A gate, not a permission model: it says what this deployment offers,
    // never who may use it.
    controls: z.boolean().default(true),
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

// #374 (dogfood F16): the empty-spin breaker — a structural backstop, independent of
// env-failure.ts's classifyEnvFailure, for a systemic failure whose text the classifier simply
// doesn't recognize (an unfamiliar provider error shape, a future outage class). round.ts counts
// CONSECUTIVE closed rounds that dispatched nothing AND had at least one peripheral role session
// degrade; reaching this threshold forces the same "llm" park episode a classified quota/429
// failure would, bounding round churn either way. Small default (3): the F16 incident spun 145
// empty rounds in ~3.5h with zero bound — even a small threshold is a massive improvement, and a
// SMALL number keeps the backstop from masking a genuinely transient blip (a round or two of
// real, unrelated flakiness) as a full park episode. User-tunable per the config rule.
const EmptySpin = z
  .object({
    consecutiveDegradedRoundsThreshold: z.number().int().positive().default(3),
  })
  .strict();

// #470 (dogfood F32): the idle-churn breaker — the empty-spin breaker's sibling, for the OTHER
// way a round can achieve nothing. Empty-spin catches rounds that FAILED (every peripheral
// session degraded); this catches rounds that succeeded at doing nothing: K consecutive closed
// rounds that were idle (no dispatch, no occupied lane) AND state-identical (each appended
// exactly the same durable facts as the one before — loop/idle-churn.ts). That is the F32 shape,
// where a standby probe signal counting unconsumable work defeats standby and the loop churns
// healthily forever. GENEROUS default (5, vs. empty-spin's 3): this backstop is aimed at a
// pathology that runs indefinitely, so it costs nothing to be sure — and unlike the degraded
// rounds empty-spin counts, an idle state-identical round is CHEAP to have gotten wrong. Reaching
// it parks dispatch for a human (no probe, no auto-clear — the loop is healthy; what is broken is
// upstream of it). User-tunable per the config rule.
const IdleChurn = z
  .object({
    consecutiveIdenticalRoundsThreshold: z.number().int().positive().default(5),
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
    // #374: the empty-spin breaker's own threshold — see EmptySpin's doc above.
    emptySpin: EmptySpin.default({}),
    // #470: the idle-churn breaker's own threshold — see IdleChurn's doc above.
    idleChurn: IdleChurn.default({}),
    // #1078: round.directiveFile retired — the directive file has no config key at all now,
    // same as the runtime root itself: directive.ts's resolveRoundDirective reads it from
    // runtimePaths(defaultRuntimeRoot()).directiveMd (cwd-relative, DIRECTIVE.md), never a
    // config-resolved path. An old config setting this key now fails the standard unknown-key
    // error, same as any other retired/misspelled key (pre-v1: no deprecation shim).
    // Deterministic-truncation cap (never a silent drop — the cut is marked in the text itself,
    // directive.ts reuses retro-digest.ts's capDigest) on the directive text substituted into the
    // prompts. Same user-tunable-in-config, marked-cut contract as roles.harvest.artifactMaxChars
    // / roles.retro.digestMaxChars.
    directiveMaxChars: z.number().int().positive().default(20_000),
    // #212: the round-pool selection multiplier — the aligning phase picks up to
    // ceil(lanes.roundDispatchCap * poolFactor) issues from Ready (milestone-scoped when
    // `milestone` above is set), ordered by prio label then issue number, and labels them the
    // round's dispatch-eligible pool (round.ts's PoolScopedForge restricts the executing phase's
    // dispatch to pool members only). >1 so the pool absorbs gate⓪/review attrition (a pool
    // member that later escalates to needs-human, or never got plan:approved, must not starve
    // the executing phase down to fewer candidates than lanes.roundDispatchCap could otherwise
    // fill). User-tunable, shipped commented in sapwood.config.yaml.
    poolFactor: z.number().finite().positive().default(1.5),
    // #432 round 5 (P2-3, degrade-to-human): both round-pool label-removal call sites (align.ts's
    // reconcilePoolLabels round-open sweep, this file's own round-close sweep) route through
    // removeRoundPoolLabel and record every failure as a `pool-reconcile-incomplete` event; this
    // many recorded failures for the SAME issue (a deterministically un-removable label, e.g. a
    // repo permission problem) escalates needs-human instead of retrying forever — same bound-
    // then-degrade paradigm as roles.po.maxConcernPostAttempts/roles.verificationPlanReviewer.maxDraftCycles.
    // Positive int only, same "0 defeats the retry it's meant to bound" rationale.
    maxPoolRemovalAttempts: z.number().int().positive().default(5),
  })
  .strict();

export const DEFAULT_GOAL_FILE = "docs/GOAL.md";

// #128: the loop's north-star goal file — a top-level key since it is read by more than just
// the architect (aligning too). Carries a real `.default()` (DEFAULT_GOAL_FILE, "docs/GOAL.md" —
// deliberately NOT "docs/PLAN.md": that name collides with sapwood's own docs/PLAN.md, a
// different file, and the two were being confused), same shape as `doctrine.file` below — every
// reader always sees a concrete, config-file-relative-resolved path (see loadConfig).
const Goal = z
  .object({
    file: z.string().min(1).default(DEFAULT_GOAL_FILE),
  })
  .strict();

// #167: repo-level review doctrine — technical invariants (disabled-consumer rule, same-tick
// window rule, crash-rerun set) and adjudication doctrine (how the loop treats review findings),
// authored as prose for LLM readers, deliberately never a lint/DSL. Top-level (not scoped under
// `roles.*`) since it's injected into more than one role's prompt (worker brief + architect
// pass) and cited by name in the prFixCap-style escalation comment — same rationale #128 moved
// `goal.file` out of `roles.architect`. Same real-`.default()` shape as `goal.file` above: every
// reader always sees a concrete path.
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

// #701: the development-language policy — WHICH working language every role composes free
// text in, per surface, an explicit config-shaped fact rather than prose scattered across
// carriers (#699 charter principle 3, the standing user-tunables-in-config rule). Values are
// passed through OPAQUELY — no engine-side language whitelist/validation beyond non-empty, so
// this key never blocks a language the underlying model can write (fail-open by design, #701's
// What item 1). Each surface defaults to `"en"`: an unset section leaves the working-language
// BEHAVIOR unchanged from pre-#701 — every prompt's new working-language directive resolves to
// `en` (English), the same language every shipped prompt already used before this key existed.
// This is NOT byte-identical rendered output: the default render now additionally CONTAINS that
// directive line (resolved to `en`), so the pinned snapshot hashes in prompts.test.ts moved for
// every prompt that gained one. Those regenerated pins guard against FUTURE unintended drift of
// this new default render — they assert stability going forward, not identity with the pre-#701
// prompt bytes.
//
// The three surfaces are deliberately the small, named set #701 asked for (commit messages etc.
// are NOT modeled — "keep the set small and add on demand, not speculatively," #701's What item
// 3) and correspond 1:1 to where a shipped prompt composes free text an operator might want in a
// non-English language:
//   - codeComments  — worker.md / fix.md: comments and identifier-adjacent prose in produced code.
//   - issuesAndPrs  — po.md / po-decompose.md / verification-plan-drafter.md /
//                     verification-plan-reviewer.md / verification-plan-reviewer-confirm.md /
//                     harvest.md / retro.md / architect.md / engine-reviewer.md: issue bodies,
//                     proposal/triage text, and review-comment prose the engine composes.
//   - docs          — worker.md / architect.md: documentation files/chapters a role edits. NOT
//                     fix.md — a fix leg only receives `{{lang.codeComments}}` (its narrower var
//                     set, #245 round-2 fix A7); it never touches docs prose.
//
// Precedence (docs/guide/configuration.md "Language customization"): this config key takes precedence
// over the target repo's own CLAUDE.md prose — #167's CLAUDE.md language entry point remains the
// FALLBACK carrier for a repo that never sets this section. This key governs the DEFAULT language
// for content a role ORIGINATES; it does not override a role's separate, pre-existing duty (every
// prompt below still states it) to preserve/match an existing issue's own already-established
// language when continuing human-authored content — those are orthogonal concerns, not a
// precedence conflict.
const Language = z
  .object({
    codeComments: z.string().min(1).default("en"),
    issuesAndPrs: z.string().min(1).default("en"),
    docs: z.string().min(1).default("en"),
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
    // surfaced in the park-probe event; see docs/guide/configuration.md). 0.05 is verified passing
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

// Raw (untransformed) schema — kept internal. The workflow-label values and
// escalation.humanLabels are still optional here; `ConfigSchema` below resolves them in one
// transform so EVERY caller of `ConfigSchema.parse`/`.safeParse` — not just this module's own
// `parseConfig` — gets the single resolved values, including the many test files across this
// codebase that build a `SapwoodConfig` via `ConfigSchema.parse({...})` directly rather than
// through `parseConfig`/`loadConfig`. Doing the resolution as a schema-level transform (rather
// than only inside `parseConfig`) means there is no second, easy-to-forget call site for a
// future test or caller to miss.
const InstructionPath = z.string().superRefine((path, ctx) => {
  if (path.trim().length === 0) {
    ctx.addIssue({ code: "custom", message: "escalation.instructionPaths entries must be non-empty after trim" });
  }
  if (path !== path.trim()) {
    ctx.addIssue({ code: "custom", message: "escalation.instructionPaths entries must not have leading or trailing whitespace" });
  }
  if (path.startsWith("./") || path.startsWith("/")) {
    ctx.addIssue({
      code: "custom",
      message: "escalation.instructionPaths entries must be canonical repo-relative paths without ./ or / prefixes",
    });
  }
  if (path.split("/").includes("..")) {
    ctx.addIssue({ code: "custom", message: "escalation.instructionPaths entries must not contain .. path segments" });
  }
  if (path.split("/").includes(".")) {
    ctx.addIssue({ code: "custom", message: "entries must not contain . path segments — GitHub reports normalized paths" });
  }
  if (path.includes("//")) {
    ctx.addIssue({ code: "custom", message: "escalation.instructionPaths entries must not contain empty // path segments" });
  }
  if (path.endsWith("/")) {
    ctx.addIssue({ code: "custom", message: "escalation.instructionPaths entries must not end with /" });
  }
});

const ConfigSchemaRaw = z
  .object({
    board: Board,
    engine: Engine.default({}),
    liveness: Liveness.default({}),
    logging: Logging.default({}),
    dashboard: Dashboard.default({}),
    lanes: Lanes.default({}),
    worker: Worker.default({}),
    guard: Guard.default({}),
    host: Host.default({}),
    cost: Cost.default({}),
    stop: Stop.default({}),
    round: Round.default({}),
    goal: Goal.default({}),
    doctrine: Doctrine.default({}),
    recovery: Recovery.default({}),
    language: Language.default({}),
    reviewer: Reviewer.default({}),
    merge: Merge.default({}),
    labels: Labels.default({}),
    roles: Roles.default({}),
    proxy: ProxyConfig.default({}),
    webAccess: WebAccess.default({}),
    envFailure: EnvFailure.default({}),
    // #286 (E4a, design #279 §4): see Ci's own doc above — schema only this PR, E4b (#287)
    // consumes it.
    ci: Ci.default({}),
    escalation: z
      .object({
        humanLabels: z.array(z.string()).optional(),
        // #292: repo-root-relative reviewer-instruction paths whose PR edits require human
        // adjudication. The explicit empty list is a deliberate off-switch (and avoids even
        // fetching changed files); matching supports literal paths plus `*` and `**`.
        // #527: `engine/prompts/**` covers the reviewer's OWN prompt carrier — inert for any
        // target repo that is not the engine's source tree, load-bearing for a self-hosting
        // deployment. The reviewer's other carrier, the doctrine file, is NOT a literal here: it
        // is derived from `doctrine.file` at match time so a reconfigured path stays covered
        // (instruction-path-escalation.ts's effectiveInstructionPaths).
        instructionPaths: z.array(InstructionPath).default([
          "CLAUDE.md",
          "CLAUDE.local.md",
          ".claude/CLAUDE.md",
          ".claude/rules/**",
          "AGENTS.md",
          "engine/prompts/**",
          // Forge provenance filtering and the proxy surfaces that expose its filtered streams
          // are standing instruction carriers: changing either changes which public comments a
          // worker can receive.
          "engine/src/forge/forge.ts",
          "engine/src/proxy/**",
          // #539: the mechanism's own carriers — the matcher/escalation implementation itself and
          // the config file carrying this very schema block + defaults — join the escalation
          // surface too (escalation, not the guard deny-list: the worker may still produce a
          // change here, a human adjudicates the merge). See docs/security.md's "Instruction-path
          // changes escalate to human review" section for the self-reference this creates and its
          // one-bootstrap-PR exposure window.
          "engine/src/review/instruction-path-escalation.ts",
          "engine/src/config/config.ts",
          // #577: sapwood init's starter template is an instruction carrier too, so it belongs on
          // this escalation surface exactly like the two paths above — but unlike them, it is
          // ALSO independently guard-protected: guard.ts's protectedPathLabel hard-blocks direct
          // writes to it (#781, sibling rule to the root config's PROTECTED_SUFFIXES/config-file
          // match). The two paths immediately above (instruction-path-escalation.ts, config.ts)
          // have no such hard-guard counterpart — they rely on escalation alone, a producer CAN
          // still write them and a human adjudicates the merge — so this entry is stronger than
          // those two, not "the same relationship": the guard denies the write outright, escalation
          // never even gets a session-produced diff to review.
          "sapwood.config.example.yaml",
          // #539: docs/security.md carries the canonical human-merge-only list and documents this
          // mechanism's own trust chain — the same self-reference class as the two paths above.
          "docs/security.md",
          // #639: the role-session skill-injection renderer — it reads docs/security.md's own
          // marker-delimited sections VERBATIM and is the sole thing deciding what text a
          // `--plugin-dir`-attached session can pull on demand. A change here could shift WHICH
          // security.md text gets extracted (or how) without touching security.md's own bytes at
          // all, so it is an instruction carrier in its own right, not merely covered by
          // security.md's entry above.
          "engine/src/roles/skills-plugin.ts",
          // #640: labels.ts's LABEL_SEMANTICS registry is now an instruction source too — it is
          // rendered VERBATIM into the sapwood-labels skill every role session can pull on demand
          // (skills-plugin.ts's buildLabelsSkillFile), the same "changes what a session reads
          // without a prompt-text diff" exposure the entry above names for skills-plugin.ts itself.
          "engine/src/forge/labels.ts",
        ]),
        // #248: the WAIT-tier hold label list (three-tier escalation model) — a HUMAN-applied
        // "I'm actively reviewing this" signal, distinct from `humanLabels`' engine-written
        // ESCALATE tier. Optional here for the same "tell unset apart from explicitly set"
        // reason humanLabels is optional above; resolveLabelDefaults below defaults it to
        // `[defaults.hold]` (labels.prefix-derived) when omitted. An explicit array passes
        // through verbatim. #248 review round 1 (G3): each entry is trimmed and must be
        // non-empty — unlike `humanLabels` (matched by substring, historical/unchanged), a
        // hold label is matched by EXACT identity (`labelsIncludeAny`), where an empty or
        // whitespace-only entry would be a config footgun (`labelsInclude([...], "")` never
        // matches, so it wouldn't silently hold everything — but it also could never be a
        // meaningful label name, so it's rejected at load rather than silently inert).
        holdLabels: z.array(z.string().trim().min(1, "escalation.holdLabels entries must be non-empty label names")).optional(),
      })
      .strict()
      .default({}),
    // #237: who a posted PO-dissent concern comment @-mentions (dissent.ts's postConcernIfNew).
    // Optional here (same "tell unset apart from explicitly set" shape as escalation.humanLabels
    // above) — resolveLabelDefaults below defaults it to `[board.owner]` when omitted. An
    // explicit array is used verbatim, in order, each entry `@`-prefixed at render time if not
    // already. User-tunable-in-config, never hardcoded (CLAUDE.md's tunables-in-config rule).
    notify: z
      .object({ mentions: z.array(z.string()).optional() })
      .strict()
      .default({}),
    // Milestones `sapwood init` should ensure exist. Empty = create none (the loop needs
    // labels + board lanes, not milestones — those are the user's organizational choice).
    milestones: z.array(z.string()).default([]),
  })
  .strict();

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
// #549: `reviewer.agent.promptFileRaw` is the same loadConfig-only annotation as `doctrine.fileRaw`
// above, for the reviewer's OTHER instruction carrier — its prompt file. Captured for the same
// reason and under the same contract: instruction-path-escalation.ts derives a repo-relative
// escalation pattern from it, which the resolved ABSOLUTE path could never serve (a forge's
// changed-file paths are repo-relative, and `InstructionPath` rejects a leading `/`). Unset unless
// the operator set `promptFile` AND loadConfig ran; readers fall back to `promptFile`, which is
// still the raw value when cfg came from `ConfigSchema.parse` directly.
type RawReviewer = z.infer<typeof ConfigSchemaRaw>["reviewer"];

export type SapwoodConfig = Omit<z.infer<typeof ConfigSchemaRaw>, "doctrine" | "labels" | "escalation" | "notify" | "reviewer"> & {
  doctrine: { file: string; maxChars: number; fileRaw?: string };
  reviewer: Omit<RawReviewer, "agent"> & { agent?: NonNullable<RawReviewer["agent"]> & { promptFileRaw?: string } };
  labels: ReturnType<typeof workflowLabelDefaults> & { prefix: string };
  escalation: { humanLabels: string[]; holdLabels: string[]; instructionPaths: string[] };
  notify: { mentions: string[] };
};

/** #1078: a `SapwoodConfig` whose `logging.path` is GUARANTEED populated — the shape the engine
 *  boundary (cli.ts's runEngine) hands to the log driver, so createRunLogger needs no fallback
 *  of its own (a SECOND unset-defaulting authority, independent of normalizeLoggingPath below,
 *  is exactly the "silently disagree" risk this type closes off). */
export type NormalizedSapwoodConfig = SapwoodConfig & { logging: SapwoodConfig["logging"] & { path: string } };

/** #1078: the ONE place logging.path's "unset -> the runtime root's own log location" default is
 *  applied — one normalization authority, so a file-loaded config and an injected one can never
 *  silently disagree. `loadConfig` below calls this for the file-loaded path; cli.ts's
 *  `runEngine` calls it again on `EngineOverrides.cfg` (the tests-only injection seam that
 *  bypasses `loadConfig` entirely) — same function, applied both times. Mutates
 *  `cfg.logging.path` in place when unset (matches `loadConfig`'s own convention for every
 *  other path field) and returns the same object, now typed as guaranteed-populated; a value
 *  that's already set (by either a real config file or a test) passes through untouched. */
export function normalizeLoggingPath(cfg: SapwoodConfig): NormalizedSapwoodConfig {
  if (cfg.logging.path === undefined) {
    cfg.logging.path = runtimePaths(defaultRuntimeRoot()).logFile;
  }
  return cfg as NormalizedSapwoodConfig;
}

/** Resolve the configured namespace before deriving omitted workflow and escalation labels.
 * Explicit per-label values and an explicit humanLabels array pass through verbatim. */
export function resolveLabelDefaults(cfg: z.infer<typeof ConfigSchemaRaw>): SapwoodConfig {
  const prefix = normalizeLabel(cfg.labels.prefix);
  const defaults = workflowLabelDefaults(prefix);
  const resolvedLabels: SapwoodConfig["labels"] = {
    prefix,
    inProgress: cfg.labels.inProgress ?? defaults.inProgress,
    needsHuman: cfg.labels.needsHuman ?? defaults.needsHuman,
    blocked: cfg.labels.blocked ?? defaults.blocked,
    reserve: cfg.labels.reserve ?? defaults.reserve,
    verifyNa: cfg.labels.verifyNa ?? defaults.verifyNa,
    planApproved: cfg.labels.planApproved ?? defaults.planApproved,
    originAgent: cfg.labels.originAgent ?? defaults.originAgent,
    split: cfg.labels.split ?? defaults.split,
    decomposed: cfg.labels.decomposed ?? defaults.decomposed,
    roundPool: cfg.labels.roundPool ?? defaults.roundPool,
    humanMergeOnly: cfg.labels.humanMergeOnly ?? defaults.humanMergeOnly,
    planless: cfg.labels.planless ?? defaults.planless,
    laneState: cfg.labels.laneState ?? defaults.laneState,
  };
  cfg.labels = resolvedLabels;
  cfg.escalation.humanLabels ??= [resolvedLabels.needsHuman, resolvedLabels.blocked];
  // #248: default the hold-label list the same way — derived from the SAME resolved prefix,
  // never from `resolvedLabels` itself (there is no `labels.hold` field to override; see
  // holdLabelDefault's own doc comment for why). An explicit array (set by the user) passes
  // through verbatim, untouched here.
  cfg.escalation.holdLabels ??= [holdLabelDefault(prefix)];
  // #237: default the dissent-comment mention list to the repo owner when unset — same
  // "explicit array passes through verbatim, omitted derives from another already-resolved
  // field" shape as escalation.humanLabels just above.
  cfg.notify.mentions ??= [cfg.board.owner];
  return cfg as SapwoodConfig;
}

/** The schema every real caller uses: raw validation (goal.file's default already applied at
 * this layer) followed by label-prefix/default resolution, then cross-field validation on the
 * fully resolved values. */
export const ConfigSchema = ConfigSchemaRaw.transform(resolveLabelDefaults).superRefine((cfg, ctx) => {
  // #170 review-silence escalation writes labels.needsHuman, while the existing PR gate
  // and the issue-side gated-reentry hold both recognize escalation.humanLabels. Reject drift
  // between them so the label latch cannot suppress visibility without holding both paths.
  if (!labelsInclude(cfg.escalation.humanLabels, cfg.labels.needsHuman)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["labels", "needsHuman"],
      message:
        `labels.needsHuman ("${cfg.labels.needsHuman}") must be listed case-insensitively in ` +
        `escalation.humanLabels so the escalation label is recognized by both PR and issue holds`,
    });
  }
  // #212 gate② P1-1: round close auto-REMOVES labels.roundPool (round.ts's removeRoundPoolLabel)
  // — the ONE engine-owned label that's ever stripped without a human act. If an operator
  // configures labels.roundPool equal to any OTHER protected/workflow label (needsHuman,
  // blocked, planApproved, verifyNa, ..., or any escalation.humanLabels entry), that same
  // auto-removal would silently strip the aliased label too, forging exactly the human-release
  // signature #147's gated reentry (and gate⓪'s plan:approved/verify:n/a adjudication) depends
  // on being human-only. Reject the collision at config load, same case-insensitive comparison
  // labelsInclude uses everywhere else.
  const otherLabels: Array<[string, string]> = [
    ["labels.inProgress", cfg.labels.inProgress],
    ["labels.needsHuman", cfg.labels.needsHuman],
    ["labels.blocked", cfg.labels.blocked],
    ["labels.reserve", cfg.labels.reserve],
    ["labels.verifyNa", cfg.labels.verifyNa],
    ["labels.planApproved", cfg.labels.planApproved],
    ["labels.originAgent", cfg.labels.originAgent],
    ["labels.split", cfg.labels.split],
    ["labels.decomposed", cfg.labels.decomposed],
    // #397: both new labels join the PROTECTED set (so nothing may alias them), but neither
    // joins `escalation.humanLabels` — see each field's own doc in the Labels schema above.
    ["labels.humanMergeOnly", cfg.labels.humanMergeOnly],
    ["labels.planless", cfg.labels.planless],
    // #399: the PR-side lane-state label joins the protected set from both directions — nothing
    // may alias it (it is auto-removed, see its own guard below), and it may not alias anything.
    ["labels.laneState", cfg.labels.laneState],
    ...cfg.escalation.humanLabels.map((label, i): [string, string] => [`escalation.humanLabels[${i}]`, label]),
  ];
  // #397: the protected pair must also be distinct from EACH OTHER and from every label above —
  // aliasing `planless` (a fence nothing owes a human for) onto `humanMergeOnly` (a one-way merge
  // verdict) or onto `needsHuman` would silently re-merge the exact meanings this issue split.
  for (const [name, value] of [
    ["humanMergeOnly", cfg.labels.humanMergeOnly],
    ["planless", cfg.labels.planless],
  ] as Array<["humanMergeOnly" | "planless", string]>) {
    for (const [key, other] of otherLabels) {
      if (key === `labels.${name}`) continue;
      if (!labelsInclude([other], value)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels", name],
        message:
          `labels.${name} ("${value}") collides with ${key} ("${other}") — the escalation ` +
          `action-buckets are split apart precisely so one label carries one required human action; aliasing them ` +
          `re-merges those meanings. Use a distinct value for labels.${name}.`,
      });
    }
  }
  for (const [key, value] of otherLabels) {
    if (labelsInclude([value], cfg.labels.roundPool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels", "roundPool"],
        message:
          `labels.roundPool ("${cfg.labels.roundPool}") collides with ${key} ("${value}") — round ` +
          `close auto-removes labels.roundPool (round.ts's removeRoundPoolLabel), so aliasing it to ` +
          `a protected label would let the engine silently strip that label too; use a distinct ` +
          `value for labels.roundPool.`,
      });
    }
  }
  // #399: identical guard for the OTHER engine-removed label. `labels.laneState` is stripped from
  // a PR the instant its lane goes terminal (lane-state-label.ts's removeLaneStateLabel), so an
  // alias onto ANY protected label — including a hold label, which lives on the PR too and is the
  // one tier the engine must never write or clear — would let that auto-removal forge a human
  // release. Same case-insensitive comparison, and the hold list is included here (unlike the
  // roundPool guard's targets) precisely because this label's carrier is the PR.
  const laneStateCollisionTargets: Array<[string, string]> = [
    ...otherLabels.filter(([key]) => key !== "labels.laneState"),
    ["labels.roundPool", cfg.labels.roundPool],
    ...cfg.escalation.holdLabels.map((label, i): [string, string] => [`escalation.holdLabels[${i}]`, label]),
  ];
  for (const [key, value] of laneStateCollisionTargets) {
    if (labelsInclude([value], cfg.labels.laneState)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels", "laneState"],
        message:
          `labels.laneState ("${cfg.labels.laneState}") collides with ${key} ("${value}") — a lane's PR label ` +
          `is auto-removed when the lane goes terminal (lane-state-label.ts's removeLaneStateLabel), so aliasing ` +
          `it to a protected label would let the engine silently strip that label too; use a distinct value for ` +
          `labels.laneState.`,
      });
    }
  }
  // #310 gate②: the human-written split firing signal and the engine-written decomposed fence
  // must not alias one another or any protected workflow/provenance/escalation label. An alias
  // with originAgent makes an agent child recursively fire itself; an alias between decomposed
  // and originAgent makes every agent child look permanently fenced.
  const decomposeCollisionTargets: Array<[string, string]> = [
    ["labels.inProgress", cfg.labels.inProgress],
    ["labels.needsHuman", cfg.labels.needsHuman],
    ["labels.blocked", cfg.labels.blocked],
    ["labels.reserve", cfg.labels.reserve],
    ["labels.verifyNa", cfg.labels.verifyNa],
    ["labels.planApproved", cfg.labels.planApproved],
    ["labels.originAgent", cfg.labels.originAgent],
    ["labels.roundPool", cfg.labels.roundPool],
    ["labels.humanMergeOnly", cfg.labels.humanMergeOnly],
    ["labels.planless", cfg.labels.planless],
    ...cfg.escalation.humanLabels.map((label, i): [string, string] => [`escalation.humanLabels[${i}]`, label]),
    ...cfg.escalation.holdLabels.map((label, i): [string, string] => [`escalation.holdLabels[${i}]`, label]),
  ];
  const decomposeLabels: Array<["split" | "decomposed", string, string, string]> = [
    ["split", cfg.labels.split, "labels.decomposed", cfg.labels.decomposed],
    ["decomposed", cfg.labels.decomposed, "labels.split", cfg.labels.split],
  ];
  for (const [name, label, siblingKey, siblingValue] of decomposeLabels) {
    for (const [key, value] of [[siblingKey, siblingValue] as [string, string], ...decomposeCollisionTargets]) {
      if (labelsInclude([value], label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["labels", name],
          message:
            `labels.${name} ("${label}") collides with ${key} ("${value}") — the decomposition ` +
            `firing signal, one-way fence, engine-written, escalation/hold, and provenance labels ` +
            `must be case-insensitively distinct; use a distinct value for labels.${name}.`,
        });
      }
    }
  }
  // #248: escalation.holdLabels (human-applied WAIT tier) must be DISTINCT from every
  // engine-written/human-escalation label — collapsing them would let applying/removing one
  // label silently double as the other tier's signal, losing the "one fact, one bit" property
  // the three-tier model (hold/needs-human/blocked) depends on (see docs/PLAN.md's escalation-
  // model section). Same collision-guard shape as labels.roundPool above, extended with
  // labels.roundPool itself as one more protected value to check against.
  const holdCollisionTargets: Array<[string, string]> = [...otherLabels, ["labels.roundPool", cfg.labels.roundPool]];
  cfg.escalation.holdLabels.forEach((holdLabel, i) => {
    for (const [key, value] of holdCollisionTargets) {
      if (labelsInclude([value], holdLabel)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["escalation", "holdLabels", i],
          message:
            `escalation.holdLabels entry ("${holdLabel}") collides with ${key} ("${value}") — the ` +
            `hold (WAIT) tier and the human-escalation tiers must be distinct labels, or removing/` +
            `applying one would silently double as the other's signal; use a distinct value.`,
        });
      }
    }
  });
  // #658 review round 2 (B): every guard above checks a SPECIFIC pair of protected labels — but
  // none of them is exhaustive, and two gaps survive as a result. (1) The 13 resolved workflow
  // labels are never cross-checked against EACH OTHER as a full set: only the ones with an
  // auto-removal or firing-signal hazard (roundPool, laneState, split/decomposed,
  // humanMergeOnly/planless) are checked against the rest, so e.g. `labels.inProgress` aliasing
  // `labels.blocked` slips through every guard above. (2) The 8 fixed taxonomy label names
  // (`TAXONOMY_SPECS`, resolved under `labels.prefix`) are never checked against ANYTHING, so
  // `labels.needsHuman: "sapwood:type:feature"` would silently alias a pure-classification label
  // nothing above ever inspects. This closes both gaps with one exhaustive, fail-closed pass —
  // pre-v1, no compat concerns — using the same case-insensitive `labelsInclude` comparison every
  // guard above uses.
  const workflowLabelEntries: Array<[string, string]> = [
    ["labels.inProgress", cfg.labels.inProgress],
    ["labels.needsHuman", cfg.labels.needsHuman],
    ["labels.blocked", cfg.labels.blocked],
    ["labels.reserve", cfg.labels.reserve],
    ["labels.verifyNa", cfg.labels.verifyNa],
    ["labels.planApproved", cfg.labels.planApproved],
    ["labels.originAgent", cfg.labels.originAgent],
    ["labels.split", cfg.labels.split],
    ["labels.decomposed", cfg.labels.decomposed],
    ["labels.roundPool", cfg.labels.roundPool],
    ["labels.humanMergeOnly", cfg.labels.humanMergeOnly],
    ["labels.laneState", cfg.labels.laneState],
    ["labels.planless", cfg.labels.planless],
  ];
  const taxonomyLabelEntries: Array<[string, string]> = TAXONOMY_SPECS.map((spec) => [
    // Backtick-quoted, not double-quote-quoted like the value parens below: `ctx.addIssue`'s
    // message ends up JSON.stringify'd inside ZodError.message, which backslash-escapes a literal
    // `"` — a regex asserting on the RAW text (every test in this file does) would have to match
    // that escape too. Backticks need no such escaping.
    `taxonomy label \`${spec.name}\``,
    `${normalizeLabel(cfg.labels.prefix)}${spec.name}`,
  ]);
  // Workflow x workflow: every unordered pair, attributed to the first (lower-index) field —
  // same one-issue-per-pair convention every guard above uses.
  for (let i = 0; i < workflowLabelEntries.length; i++) {
    for (let j = i + 1; j < workflowLabelEntries.length; j++) {
      const [keyA, valueA] = workflowLabelEntries[i]!;
      const [keyB, valueB] = workflowLabelEntries[j]!;
      if (!labelsInclude([valueB], valueA)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: keyA.split("."),
        message:
          `${keyA} ("${valueA}") collides with ${keyB} ("${valueB}") — every resolved workflow ` +
          `label name must be case-insensitively distinct; use a distinct value for ${keyA}.`,
      });
    }
  }
  // Workflow x taxonomy: a workflow label may not alias a fixed taxonomy name either.
  for (const [workflowKey, workflowValue] of workflowLabelEntries) {
    for (const [taxonomyKey, taxonomyValue] of taxonomyLabelEntries) {
      if (!labelsInclude([taxonomyValue], workflowValue)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: workflowKey.split("."),
        message:
          `${workflowKey} ("${workflowValue}") collides with the ${taxonomyKey} ("${taxonomyValue}") — ` +
          `a workflow label must not alias a fixed taxonomy label; use a distinct value for ${workflowKey}.`,
      });
    }
  }
  // holdLabels x taxonomy (holdLabels x workflow is already covered by holdCollisionTargets
  // above, which folds labels.roundPool + every entry of otherLabels — the same 13 resolved
  // workflow names checked pairwise above — into holdCollisionTargets).
  cfg.escalation.holdLabels.forEach((holdLabel, i) => {
    for (const [taxonomyKey, taxonomyValue] of taxonomyLabelEntries) {
      if (!labelsInclude([taxonomyValue], holdLabel)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalation", "holdLabels", i],
        message:
          `escalation.holdLabels entry ("${holdLabel}") collides with the ${taxonomyKey} ("${taxonomyValue}") — ` +
          `the hold (WAIT) tier must not alias a fixed taxonomy label; use a distinct value.`,
      });
    }
  });
  // #286 (E4a, D5): the engine-agent reviewer's model must be DISTINGUISHABLE from the
  // producing worker's CONFIGURED model at parse time — reviewer.agent lives in a sibling
  // section from worker.model, so this cross-field check can only run here, after both are
  // resolved (Reviewer's own superRefine/transform, above — including #501's default injection —
  // has no visibility into `worker`, and runs strictly before this superRefine). This is the
  // PARSE-TIME half of D5 (worker.model is the closest static proxy for "the model a lane will
  // actually run" available before any session ever executes); the RUNTIME half — comparing
  // against the producing lane's ACTUAL recorded model, which can differ from worker.model on a
  // fallback-model switch — is engine-agent.ts's own job (evaluate()'s pre-/post-session
  // checks), not expressible at config-parse time.
  // #501: this check runs identically whether cfg.reviewer.agent was user-supplied or
  // default-injected — no silent model swap on collision either way (a silent opus fallback would
  // silently change cost, CLAUDE.md's user-tunables rule). The message differs only in WORDING:
  // an injected block (the zero-config case, or "only worker.model set") names the one-line fix
  // an operator who never wrote a reviewer.agent block themselves actually needs.
  // #443 (D5 generalization to a (provider, model) identity): this static check compares two BARE
  // MODEL NAMES, which is only meaningful when both sides run against the SAME provider — true
  // exactly when the review session runs on the Claude CLI (`runner: claude`, the default), since
  // the worker leg always does. With `runner: codex-exec` the review session runs against a
  // DIFFERENT provider by construction, so the identities cannot collide no matter what the two
  // model strings happen to say, and this check would be a false rejection. Deliberately NOT solved
  // with a `provider` config key (the adjudication rejected inventing one): the runtime half —
  // engine-agent.ts's pre-/post-session checks over the session's OWN recorded (provider, model)
  // telemetry — is where a codex-exec review's separation is actually established.
  if (
    cfg.reviewer.mode === "engine-agent" &&
    cfg.reviewer.agent &&
    cfg.reviewer.agent.runner === "claude" &&
    cfg.reviewer.agent.model === cfg.worker.model
  ) {
    const wasDefaulted = injectedReviewerAgents.has(cfg.reviewer.agent);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewer", "agent", "model"],
      message: wasDefaulted
        ? `reviewer.agent.model was DEFAULTED to "${cfg.reviewer.agent.model}" (the zero-config engine-agent ` +
          `default — no reviewer.agent block was configured) and collides with worker.model ` +
          `("${cfg.worker.model}") — a same-model review can never gate its own producer (D5); ` +
          "the one-line fix: set reviewer.agent.model to a different Claude model than worker.model."
        : `reviewer.agent.model ("${cfg.reviewer.agent.model}") must differ from worker.model ` +
          `("${cfg.worker.model}") — a same-model review can never gate its own producer (D5); ` +
          "choose a different Claude model for reviewer.agent.model.",
    });
  }
  // #606 gate② round 2 (R3-6): worker.deployKeyPath and worker.deployKeyId are the owner
  // ruling's local (path, id) anchor PAIR — init.ts's reconcile logic reads them as a unit and
  // treats "only one set" as meaningless (neither "fresh provisioning" nor "reconcile" has a
  // sane interpretation of a lone half). Reject a lone half at parse time, naming which is
  // missing and pointing at the fix ("re-run sapwood init", which always writes/clears both
  // together) rather than letting it silently fall through to fresh-provisioning behavior with
  // an orphaned half still sitting in the file.
  if ((cfg.worker.deployKeyPath === undefined) !== (cfg.worker.deployKeyId === undefined)) {
    const missing = cfg.worker.deployKeyPath === undefined ? "deployKeyPath" : "deployKeyId";
    const present = cfg.worker.deployKeyPath === undefined ? "deployKeyId" : "deployKeyPath";
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worker", missing],
      message:
        `worker.${missing} is unset but worker.${present} is set — these two form ONE local anchor ` +
        `pair (an owner ruling) and must be BOTH set or BOTH unset. Re-run "sapwood init", which ` +
        `always writes or clears them together, or remove worker.${present} by hand.`,
    });
  }
  // #286 (E4a, design #279 §4.3): mode: engine-agent with an empty/absent ci.requiredChecks is
  // legal (parse still succeeds — an operator may be mid-adoption) but WEAK: code-verifiable AC
  // can then at best be claim-based (no trusted CI execution evidence exists to confirm against),
  // never `confirmed`. A WARNING, not a rejection — console.warn is the parse-boundary channel
  // for a non-fatal note here; there is no dedicated warning surface elsewhere in this file to
  // reuse instead.
  if (cfg.reviewer.mode === "engine-agent" && cfg.ci.requiredChecks.length === 0) {
    console.warn(
      "[sapwood:config] reviewer.mode is engine-agent but ci.requiredChecks is empty — code-verifiable " +
        "acceptance criteria can at best be claim-based (no trusted CI execution evidence exists to confirm " +
        "against); configure ci.requiredChecks to enable confirmed verdicts.",
    );
  }
  // #395 (gate② round 3, P2): the liveness watchdog's window (engine.tickIntervalSec x
  // liveness.watchdogTickMultiplier, in ms) has no lower bound tying it to the heartbeat cadence
  // that keeps a healthy long session/leg from false-tripping it — `tickIntervalSec: 1` with the
  // default multiplier gives a 10s window, which kills a healthy role session or worker leg
  // before its very first ~30s heartbeat has a chance to prove it's still alive. See
  // DEFAULT_HEARTBEAT_CADENCE_MS/WATCHDOG_HEARTBEAT_MARGIN's own doc for why the floor is
  // exactly the shipped defaults' own value, not a new number. The shipped defaults themselves
  // always pass this (600_000ms == the floor exactly) — this only ever rejects an override that
  // shrinks the window below what the defaults already establish as safe.
  const watchdogWindowMs = cfg.engine.tickIntervalSec * cfg.liveness.watchdogTickMultiplier * 1000;
  const watchdogFloorMs = DEFAULT_HEARTBEAT_CADENCE_MS * WATCHDOG_HEARTBEAT_MARGIN;
  if (watchdogWindowMs < watchdogFloorMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["liveness", "watchdogTickMultiplier"],
      message:
        `engine.tickIntervalSec (${cfg.engine.tickIntervalSec}s) x liveness.watchdogTickMultiplier ` +
        `(${cfg.liveness.watchdogTickMultiplier}) = a ${watchdogWindowMs}ms liveness-watchdog window, below the ` +
        `${watchdogFloorMs}ms floor (${WATCHDOG_HEARTBEAT_MARGIN}x the ${DEFAULT_HEARTBEAT_CADENCE_MS}ms role-session/` +
        "worker-leg heartbeat cadence) — a window this short would self-kill a healthy long-running role " +
        "session or worker leg before its very first heartbeat could ever prove it's still alive. Raise " +
        "engine.tickIntervalSec and/or liveness.watchdogTickMultiplier so their product clears the floor.",
    });
  }
  // #395 (gate② round 3, P2): the OTHER end of the same knob — Node's setTimeout/execFile
  // silently CLAMP a delay beyond ~24.8 days (a 32-bit signed int of ms) to an effectively-
  // immediate fire, so an operator deliberately configuring something conservative and large
  // would get an immediate self-kill instead — the opposite of "conservative." Reject at parse
  // time rather than silently misbehaving at the first tick.
  if (watchdogWindowMs > NODE_MAX_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["liveness", "watchdogTickMultiplier"],
      message:
        `engine.tickIntervalSec (${cfg.engine.tickIntervalSec}s) x liveness.watchdogTickMultiplier ` +
        `(${cfg.liveness.watchdogTickMultiplier}) = a ${watchdogWindowMs}ms liveness-watchdog window, past ` +
        `Node's own ${NODE_MAX_TIMEOUT_MS}ms setTimeout ceiling (~24.8 days) — Node silently CLAMPS a delay ` +
        "beyond this to fire almost immediately, so a value meant to be conservative would instead self-kill " +
        "the engine right away. Lower engine.tickIntervalSec and/or liveness.watchdogTickMultiplier so their " +
        "product stays under the ceiling.",
    });
  }
});

// #413: keys this rename retired, mapped to their replacement. NOT a compatibility shim — the
// old key is dead, and a config carrying it still FAILS (the pre-v1 ruling on PR #555 is that a
// dual-key migration path isn't owed). This table only improves the DIAGNOSTIC: `roles`'s
// `.strict()` already rejects the dead key, but its stock message names only what's wrong, never
// what to write instead, and "planReviewer" -> "verificationPlanReviewer" is not a guessable
// edit. Deliberately a lookup of exact dead keys, not a fuzzy did-you-mean over the schema: a
// rename we performed is a fact we know, so this binds to that fact rather than inferring one
// from string distance.
const RENAMED_ROLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  planReviewer: "verificationPlanReviewer",
  planDrafter: "verificationPlanDrafter",
});

/** Parse + validate raw YAML/JSON text. Exported for testing without disk I/O. */
export function parseConfig(text: string): SapwoodConfig {
  const raw = parseYaml(text); // also accepts JSON (YAML ⊃ JSON)
  // Runs BEFORE the schema parse purely so this specific message wins over `.strict()`'s generic
  // unrecognized-key one; both reject, so the outcome is identical either way.
  const roles: unknown = (raw as { roles?: unknown } | null | undefined)?.roles;
  if (roles !== null && typeof roles === "object") {
    for (const [dead, live] of Object.entries(RENAMED_ROLE_KEYS)) {
      if (dead in (roles as Record<string, unknown>)) {
        throw new Error(
          `roles.${dead} was renamed to roles.${live}: the gate⓪ role reviews an issue's ` +
            `VERIFICATION PLAN — its acceptance criteria and proof method — not the plan of work. ` +
            `Rename the key in your config; its sub-keys are unchanged.`,
        );
      }
    }
  }
  return ConfigSchema.parse(raw);
}

// #784: reviewer.mode: engine-agent + empty ci.requiredChecks is legal to PARSE (the #286
// warning above — an operator may be mid-adoption, and read-only loader consumers like `status`/
// `events` must keep working against it) but is a queue-forever foot-gun for an actual RUN: with
// no configured `ci.requiredChecks`, drive.ts's CI-evidence preflight can never produce trusted
// execution evidence, so every PR queues fail-closed forever and gate② never fires — the parse-
// time console.warn is easy to miss. `sapwood run` is the only entrypoint that would actually
// spawn that loop, so it (and only it — never `loadConfig`/`parseConfig` themselves) must refuse
// loudly at startup. Pure + exported for testing, same split as `tickOnlyFlagError` in cli.ts.
export function engineAgentEmptyCiRequiredChecksError(cfg: SapwoodConfig): string | null {
  if (cfg.reviewer.mode !== "engine-agent" || cfg.ci.requiredChecks.length > 0) return null;
  return (
    'sapwood run: reviewer.mode is "engine-agent" but ci.requiredChecks is empty — every PR will queue ' +
    `fail-closed at the CI-evidence preflight forever, and nothing will ever be reviewed (see <${DOC_LINKS.configuration}>'s ` +
    "`ci` section). Fix one of: (1) add at least one entry to ci.requiredChecks naming this repo's required CI " +
    'check(s), or (2) set reviewer.mode to one of "different-model-codex", "same-model-trusted", or "human" instead ' +
    'of "engine-agent".'
  );
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
  // #1078: two different rules for two different kinds of path. Unset logging.path has no
  // operator-authored value to resolve — it falls back to the runtime root's own log location
  // (runtimePaths(defaultRuntimeRoot()).logFile), cwd-relative like every other runtime path in
  // this repo (state.ts's DEFAULT_DB_PATH, the sentinel files, directive.ts's DIRECTIVE.md), NOT
  // relative to wherever this config file happens to live. A SET value, by contrast, IS an
  // operator-authored file reference — same class as promptFile/goal.file/doctrine.file below —
  // and stays config-file-relative so `sapwood validate repo/sapwood.config.yaml` judges the
  // same file the engine would resolve inside `repo/`.
  if (cfg.logging.path === undefined) {
    normalizeLoggingPath(cfg); // #1078: one normalization authority, shared with cli.ts's EngineOverrides.cfg path
  } else if (!isAbsolute(cfg.logging.path)) {
    cfg.logging.path = resolve(dirname(file), cfg.logging.path);
  }
  // A relative worker.promptFile means "relative to the config file" (#74), not to whatever
  // cwd the CLI happens to run from — `sapwood validate repo/sapwood.config.yaml` must judge
  // the same config the engine would run inside `repo/`.
  if (cfg.worker.promptFile !== undefined && !isAbsolute(cfg.worker.promptFile)) {
    cfg.worker.promptFile = resolve(dirname(file), cfg.worker.promptFile);
  }
  // Same rule for worker.fixPromptFile (#245).
  if (cfg.worker.fixPromptFile !== undefined && !isAbsolute(cfg.worker.fixPromptFile)) {
    cfg.worker.fixPromptFile = resolve(dirname(file), cfg.worker.fixPromptFile);
  }
  // Same rule for worker.pricingFile (#33 follow-up, PR #85 review).
  if (cfg.worker.pricingFile !== undefined && !isAbsolute(cfg.worker.pricingFile)) {
    cfg.worker.pricingFile = resolve(dirname(file), cfg.worker.pricingFile);
  }
  // #1078 (was #606's config-file-relative rule): worker.deployKeyPath is CWD-relative, not
  // config-file-relative — unlike promptFile/pricingFile/logging.path above, the key file lives
  // beside the engine's own runtime root (init.ts's writers emit the matching relative(cwd,
  // keyPath) string), so a config file that isn't at the repo root must still resolve to the
  // SAME absolute key path the engine itself would use. `resolve()` with a single argument
  // already resolves against process.cwd() — the same convention every other runtime-root path
  // in this repo uses.
  if (cfg.worker.deployKeyPath !== undefined && !isAbsolute(cfg.worker.deployKeyPath)) {
    cfg.worker.deployKeyPath = resolve(cfg.worker.deployKeyPath);
  }
  // #88/#87: same relative-to-config-file resolution for the verification-plan-reviewer prompt.
  if (cfg.roles.verificationPlanReviewer.promptFile !== undefined && !isAbsolute(cfg.roles.verificationPlanReviewer.promptFile)) {
    cfg.roles.verificationPlanReviewer.promptFile = resolve(dirname(file), cfg.roles.verificationPlanReviewer.promptFile);
  }
  // #214: same rule for the verification-plan-reviewer's freshness re-confirm prompt.
  if (
    cfg.roles.verificationPlanReviewer.confirmPromptFile !== undefined &&
    !isAbsolute(cfg.roles.verificationPlanReviewer.confirmPromptFile)
  ) {
    cfg.roles.verificationPlanReviewer.confirmPromptFile = resolve(dirname(file), cfg.roles.verificationPlanReviewer.confirmPromptFile);
  }
  // #87: same rule for the verification-plan-drafter prompt.
  if (cfg.roles.verificationPlanDrafter.promptFile !== undefined && !isAbsolute(cfg.roles.verificationPlanDrafter.promptFile)) {
    cfg.roles.verificationPlanDrafter.promptFile = resolve(dirname(file), cfg.roles.verificationPlanDrafter.promptFile);
  }
  // #90: same rule for the architect prompt.
  if (cfg.roles.architect.promptFile !== undefined && !isAbsolute(cfg.roles.architect.promptFile)) {
    cfg.roles.architect.promptFile = resolve(dirname(file), cfg.roles.architect.promptFile);
  }
  // #128: same rule for the resolved north-star goal file — UNLIKE promptFile this key always
  // has a value (schema `.default()`, same shape as doctrine.file below), so there's no
  // `!== undefined` guard: every non-absolute value, default or explicit, resolves against the
  // config file's directory, not the CLI's cwd. align.ts/architect.ts both read cfg.goal.file.
  if (!isAbsolute(cfg.goal.file)) {
    cfg.goal.file = resolve(dirname(file), cfg.goal.file);
  }
  // #167: same rule for the resolved review-doctrine file — always has a value (same real
  // `.default()` shape as goal.file above), so every non-absolute value, default or explicit,
  // resolves against the config file's directory, not the CLI's cwd.
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
  if (cfg.roles.po.decomposePromptFile !== undefined && !isAbsolute(cfg.roles.po.decomposePromptFile)) {
    cfg.roles.po.decomposePromptFile = resolve(dirname(file), cfg.roles.po.decomposePromptFile);
  }
  // #212: same rule for the PO's round-pool SELECTION prompt (a distinct file from promptFile).
  if (cfg.roles.po.poolPromptFile !== undefined && !isAbsolute(cfg.roles.po.poolPromptFile)) {
    cfg.roles.po.poolPromptFile = resolve(dirname(file), cfg.roles.po.poolPromptFile);
  }
  // #91: same rule for the harvest prompt.
  if (cfg.roles.harvest.promptFile !== undefined && !isAbsolute(cfg.roles.harvest.promptFile)) {
    cfg.roles.harvest.promptFile = resolve(dirname(file), cfg.roles.harvest.promptFile);
  }
  // #91: same rule for the retro prompt.
  if (cfg.roles.retro.promptFile !== undefined && !isAbsolute(cfg.roles.retro.promptFile)) {
    cfg.roles.retro.promptFile = resolve(dirname(file), cfg.roles.retro.promptFile);
  }
  // #286 (E4a): same rule for the engine-agent reviewer's own prompt file.
  // #549: capture the RAW pre-resolution value FIRST, exactly as `doctrine.fileRaw` above —
  // instruction-path-escalation.ts matches a repointed reviewer prompt against a PR's
  // repo-relative changed files, which the resolved absolute path below could never do. See
  // `SapwoodConfig`'s `reviewer.agent.promptFileRaw` doc comment for the full contract.
  if (cfg.reviewer.agent?.promptFile !== undefined) {
    cfg.reviewer.agent.promptFileRaw = cfg.reviewer.agent.promptFile;
    if (!isAbsolute(cfg.reviewer.agent.promptFile)) {
      cfg.reviewer.agent.promptFile = resolve(dirname(file), cfg.reviewer.agent.promptFile);
    }
  }
  return cfg;
}

// ── #206: the config surface the engine publishes (frontend-design.md §3 E / §11) ─────────────

/** The ONLY config keys that ever leave the engine: the read-only config drawer's **allowlisted
 *  subset** (frontend-design.md §3 E), snapshotted into the `run-started` event at startup (§11)
 *  and — later — served by the dashboard server from that same list. Built by explicit picks,
 *  never by spreading the resolved object: `/api/events` serves stored payloads verbatim, so the
 *  no-secrets guarantee has to hold at WRITE time. A config key added later (a token, a resolved
 *  local path like `worker.promptFile`) is therefore absent until someone deliberately lists it
 *  here. Grouped the way the drawer renders it — Board · Lanes · Worker · Safety · Review &
 *  merge · Labels — plus the per-role model/effort the §3 C/§6 captions read. */
export function dashboardConfigSubset(cfg: SapwoodConfig) {
  const session = (r: { model: string; effort: string; enabled?: boolean }) => ({
    model: r.model,
    effort: r.effort,
    ...(r.enabled === undefined ? {} : { enabled: r.enabled }),
  });
  return {
    engine: { driver: cfg.engine.driver, tickIntervalSec: cfg.engine.tickIntervalSec },
    board: {
      owner: cfg.board.owner,
      repo: cfg.board.repo,
      projectNumber: cfg.board.projectNumber,
      statusField: cfg.board.statusField,
      status: { ...cfg.board.status },
    },
    lanes: {
      max: cfg.lanes.max,
      roundDispatchCap: cfg.lanes.roundDispatchCap,
      reserveCap: cfg.lanes.reserveCap,
      prFixCap: cfg.lanes.prFixCap,
      gatedReentryCap: cfg.lanes.gatedReentryCap,
    },
    worker: {
      model: cfg.worker.model,
      effort: cfg.worker.effort,
      fallbackModel: cfg.worker.fallbackModel,
      timeoutSec: cfg.worker.timeoutSec,
      budgetUsdSoft: cfg.worker.budgetUsdSoft,
      maxResumes: cfg.worker.maxResumes,
    },
    // Safety group: the guard mode plus every ceiling/stop condition this run is bounded by.
    // Optional stop.* keys stay absent (JSON drops undefined) — "unset" reads as unset.
    guard: { mode: cfg.guard.mode },
    cost: {
      roundBudgetUsd: cfg.cost.roundBudgetUsd,
      dailyBudgetUsd: cfg.cost.dailyBudgetUsd,
      maxWallClockSec: cfg.cost.maxWallClockSec,
      drainWindowSec: cfg.cost.drainWindowSec,
    },
    stop: {
      afterIssuesMerged: cfg.stop.afterIssuesMerged,
      afterPRsOpened: cfg.stop.afterPRsOpened,
      onMilestoneComplete: cfg.stop.onMilestoneComplete,
      afterSpendUsd: cfg.stop.afterSpendUsd,
    },
    round: {
      milestone: cfg.round.milestone,
      poolFactor: cfg.round.poolFactor,
      standby: { enabled: cfg.round.standby.enabled, backoffCapSec: cfg.round.standby.backoffCapSec },
      emptySpin: { consecutiveDegradedRoundsThreshold: cfg.round.emptySpin.consecutiveDegradedRoundsThreshold },
      idleChurn: { consecutiveIdenticalRoundsThreshold: cfg.round.idleChurn.consecutiveIdenticalRoundsThreshold },
    },
    reviewer: { mode: cfg.reviewer.mode, deltaChainMax: cfg.reviewer.deltaChainMax },
    merge: { mode: cfg.merge.mode },
    roles: {
      verificationPlanReviewer: session(cfg.roles.verificationPlanReviewer),
      verificationPlanDrafter: session(cfg.roles.verificationPlanDrafter),
      architect: session(cfg.roles.architect),
      po: session(cfg.roles.po),
      harvest: session(cfg.roles.harvest),
      retro: session(cfg.roles.retro),
    },
    // The drawer's whole "Labels" group. Spread deliberately, unlike every group above: this
    // block is closed by construction (`workflowLabelDefaults(prefix)` + `prefix`, see the
    // SapwoodConfig type) and every value in it is a workflow label NAME — there is no key that
    // could be added here without being one.
    labels: { ...cfg.labels },
  };
}

/** Recursive key sort — the only thing standing between two byte-identical configs written in
 *  different key order and two different hashes. Arrays keep their order (it is meaningful). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((k) => [k, sortKeys(source[k])]),
  );
}

/** #206: stable hash of the FULL resolved config — the `run-started` payload's change-detection
 *  half (frontend-design.md §11). Deliberately hashes everything, not just the allowlisted
 *  subset above: a changed key the drawer never shows still makes this a differently-configured
 *  run. The hash leaks nothing (it is one-way), which is exactly why the readable half next to
 *  it has to be an allowlist. */
export function configHash(cfg: SapwoodConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(cfg)))
    .digest("hex");
}
