// review/engine-agent.ts (#286, E4a, design #279) — the engine-agent `ReviewerAdapter`: gate②'s
// LLM review agent (a static, different-Claude-model review session run entirely by the engine,
// no external bot). This module composes the E1-E3b foundations already merged on main:
//   - reviewer.ts (E1)     — the ApprovalResult/ReviewContext/ReviewerAdapter seam this class
//                            implements, and the Finding/validateFindings shapes review output
//                            validates into.
//   - ac-snapshot.ts (E2)  — the dispatch-time AC-authority manifest this reviews against; NEVER
//                            a live issue-body re-fetch (design #279 §5).
//   - materializer.ts (E3a)/review-session.ts (E3b) — the private-clone checkout + the review
//                            session spawn facility (RoleRunner.run's reviewCwd mode).
//
// DEPS INJECTION (not a hardcoded I/O boundary): the clone lifecycle (WHERE the private clone
// lives, WHEN it's refreshed) and the drive-loop's attempt-pin/backoff timing are E4b's (#287)
// concern, not this adapter's — `EngineAgentReviewerDeps.materialize` is a caller-bound function
// ("materialize this oid"), not a clone object this class manages itself. Likewise `getAcSnapshot`
// /`getWorkerActualModels` are plain functions a caller binds to a real `State` instance — this
// module never imports state.ts directly, keeping it trivially fake-testable.
//
// SCOPE (explicitly OUT of this PR, #287/E4b): wiring EngineAgentReviewer into the drive loop
// (merge-driver.ts/conductor.ts), the attempt-pin/backoff persistence, preflight/identity
// resolution, and the audit-comment transport. This module only implements `evaluate()`'s pure
// decision logic end-to-end against injected deps — a caller that already has a live
// `ReviewContext` (forge/pr/issue/data) can use it today; nothing yet CALLS it in production.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "../config/config.js";
import type { RoleRunner } from "../roles/peripheral.js";
import type { ApprovalResult, ReviewContext, ReviewerAdapter } from "../roles/reviewer.js";
import type { AcSnapshot } from "./ac-snapshot.js";
import { deriveApprovalResult, parseAgentReviewOutputText } from "./agent-output.js";
import type { EngineReviewArtifact } from "./audit.js";
import { applySeverityOverride, changedPathsFromDiff } from "./finding-axes.js";
import type { MaterializeResult } from "./materializer.js";
import {
  CLAUDE_PROVIDER,
  ClaudeReviewSessionExecutor,
  type ReviewSessionExecutor,
  type ReviewSessionIdentity,
  type ReviewSessionSpend,
  runReviewSession,
} from "./review-session.js";

/** Everything `EngineAgentReviewer` needs, bundled as an explicit deps object (never a bare
 *  constructor arg list) — mirrors the pattern this codebase already uses for injected I/O
 *  (RoleRunnerDeps, etc.). Every field is either a plain function (fake-friendly, no live State/
 *  materializer required in unit tests) or already-resolved config/text. */
export interface EngineAgentReviewerDeps {
  /** Materialize the reviewed commit into a plain source tree — a CALLER-BOUND wrapper around
   *  review/materializer.ts's `materialize()` (clone lifecycle + treeDir naming are the caller's
   *  concern, #287/E4b's drive-loop composition — this adapter only ever asks "materialize this
   *  oid" and gets back a `MaterializeResult`). Never expected to throw (materializer.ts's own
   *  contract), but `evaluate()` catches a throw anyway and maps it to a materialize failure
   *  (defense-in-depth against a caller-supplied wrapper that doesn't uphold that contract). */
  materialize: (headOid: string) => Promise<MaterializeResult>;
  /** The RoleRunner-shaped session spawn facility the DEFAULT (`runner: claude`) executor wraps —
   *  see `executor` below for the seam this feeds. */
  runner: Pick<RoleRunner, "run">;
  /** #443: the review session's EXECUTOR (review-session.ts's `ReviewSessionExecutor`). Omitted ⇒
   *  a `ClaudeReviewSessionExecutor` over `runner` above, i.e. byte-for-byte the pre-seam behavior
   *  — which is why every existing caller and test needed no change. A composition root that
   *  configures `reviewer.agent.runner: codex-exec` MUST supply the matching executor here
   *  (production.ts does): a configured non-claude runner with no executor supplied is a
   *  composition bug and THROWS at construction rather than silently reviewing on the default
   *  runner, which would quietly turn a cross-vendor gate back into a same-vendor one. */
  executor?: ReviewSessionExecutor;
  /** state.ts's AC-authority snapshot read (`State.getAcSnapshot`). */
  getAcSnapshot: (issue: number) => AcSnapshot | null;
  /** state.ts's D5 runtime-check accessor (`State.getWorkerActualModels`) — the PRODUCING lane's
   *  own recorded actual model(s) for `issue`. An empty array means "unknown" (state.ts's own
   *  doc: a still-`driving` lane hasn't settled its spend_ledger rows yet) — treated identically
   *  to a KNOWN-equal model by `evaluate()` (fail closed, design #279's D5: "if the recorded
   *  actual models make reviewer vs worker indistinguishable (equal, or worker actual unknown),
   *  return unavailable"). */
  getWorkerActualModels: (issue: number) => string[];
  cfg: SapwoodConfig;
  /** Already-loaded review-doctrine text (or undefined/empty) — same "load once at construction,
   *  never per-call" convention as CodexReviewer's own `doctrine` constructor param
   *  (reviewer.ts's `loadReviewDoctrine`). */
  doctrine?: string;
  now: () => Date;
  /** #288: construction-bound validated-artifact side channel. ApprovalResult intentionally
   *  stays small; audit provenance is reported only after strict output + model validation. */
  onReviewArtifact?: (headOid: string, artifact: EngineReviewArtifact) => void;
}

/** Resolves the shipped default prompt — `engine/prompts/engine-reviewer.md` inside the engine
 *  package, mirroring worker.ts's `defaultPromptPath` exactly (NOT relative to the target repo
 *  the engine is orchestrating). */
export function defaultEngineReviewerPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/review (tsx) and engine/dist/review (built) are both two levels below engine/ —
  // same convention worker.ts's defaultPromptPath documents.
  return join(here, "..", "..", "prompts", "engine-reviewer.md");
}

/** Load the engine-reviewer prompt TEMPLATE, raw and un-substituted, exactly once (at
 *  EngineAgentReviewer construction) — same #74 fail-fast contract as worker.ts's
 *  `loadWorkerPromptTemplate`: an explicitly configured `reviewer.agent.promptFile` that's
 *  missing/unreadable throws here, NAMING THE PATH, never a silent fallback to the shipped
 *  default. `configured` is `cfg.reviewer.agent.promptFile` — already resolved relative to the
 *  config file's directory by `loadConfig`, so by here it is effectively absolute. */
/** #302 review (Codex P1, custom promptFile input completeness): every placeholder a template
 *  MUST contain to be a usable engine-reviewer prompt — one per session input (issue #286's What:
 *  diff + snapshotted body + AC ids + doctrine). A custom `promptFile` missing any of these would
 *  silently review with an incomplete input set (e.g. no diff at all); validated fail-fast at
 *  load/construction (#74 pattern), never discovered mid-review. */
const REQUIRED_PROMPT_PLACEHOLDERS = ["diff", "issue-body", "acceptance-criteria", "doctrine"] as const;

/** One shared placeholder pattern for BOTH validation (below) and rendering — internal whitespace
 *  is tolerated (`{{ issue-body }}` ≡ `{{issue-body}}`, #302 review P1: the whitespace form used
 *  to survive rendering as literal text) so the two can never disagree about what "contains a
 *  placeholder" means. */
const PROMPT_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g;

export function loadEngineReviewerPromptTemplate(configured: string | undefined): string {
  let template: string;
  if (configured === undefined) {
    template = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  } else {
    if (!existsSync(configured)) {
      throw new Error(`reviewer.agent.promptFile not found: ${configured} — refusing to construct EngineAgentReviewer`);
    }
    try {
      template = readFileSync(configured, "utf8");
    } catch (e) {
      throw new Error(`reviewer.agent.promptFile unreadable: ${configured} (${String(e)}) — refusing to construct EngineAgentReviewer`);
    }
  }
  // #302 review (Codex P1): validate placeholder COMPLETENESS at load time — applies to the
  // shipped default too (a broken default is a bug this catches in every test run, not a special
  // case). Whitespace forms count as present (same regex the renderer uses).
  const present = new Set<string>();
  for (const m of template.matchAll(PROMPT_PLACEHOLDER_RE)) present.add(m[1]!);
  const missing = REQUIRED_PROMPT_PLACEHOLDERS.filter((p) => !present.has(p));
  if (missing.length > 0) {
    throw new Error(
      `engine-reviewer prompt template ${configured ?? defaultEngineReviewerPromptPath()} is missing required ` +
        `placeholder(s): ${missing.map((p) => `{{${p}}}`).join(", ")} — a template must consume every session ` +
        "input (diff, issue-body, acceptance-criteria, doctrine); refusing to construct EngineAgentReviewer",
    );
  }
  return template;
}

/** Supported `{{var}}` substitutions for the engine-reviewer prompt — deliberately tiny (no
 *  template engine, mirrors worker.ts's own `renderPromptTemplate` philosophy) and FAILS CLOSED
 *  on any `{{...}}` token the map doesn't recognize, so a typo in a custom `promptFile` throws
 *  loudly rather than shipping literal `{{...}}` text into a live review session. Internal
 *  whitespace is tolerated (`{{ issue-body }}`, #302 review P1) via the SAME pattern the load-time
 *  completeness check uses. */
function renderEngineReviewerPrompt(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PROMPT_PLACEHOLDER_RE, (_match, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      throw new Error(`engine-reviewer prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`);
    }
    return vars[name]!;
  });
}

/** One `attempt()` call's outcome — the three shapes `evaluate()`'s retry logic branches on:
 *   - `verdict`   — the session ran, its output validated, an ApprovalResult was derived. Done.
 *   - `failed`    — the session RAN (attempt-shaped: it consumed budget) but produced no usable
 *                   verdict — a non-`done` outcome (crash/timeout) OR a `done` outcome whose
 *                   `resultText` failed schema validation. Carries the attempt's own SPEND
 *                   EVIDENCE (#443's `ReviewSessionSpend`) so the caller can compute the retry's
 *                   remaining budget. `{ kind: "unknown" }` (#302 review, Codex P1; #443 R1)
 *                   means the session produced NO usable spend telemetry at all — there is no
 *                   number to subtract, so the caller must NOT compute a remainder (an unknown
 *                   attempt-1 spend read as "$0 spent" would grant the retry a second FULL cap,
 *                   violating the whole-logical-review cap, issue #286 AC#4). `estimated` spend
 *                   (the codex-exec runner, which has no hard-cap mechanism) IS subtractable —
 *                   the cap it feeds is advisory, and an advisory remainder is still strictly
 *                   better than doubling down blind.
 *   - `setup-unavailable` — the session never got a fair chance to run at all: `runReviewSession`
 *                   itself returned `unavailable` (a materialize/spawn-setup failure), OR the
 *                   POST-session model-separation re-check (D5) found the session's own actual
 *                   model indistinguishable from the worker's. Never retried — a setup failure
 *                   or a same-model verdict is not something a second attempt fixes. */
type AttemptOutcome =
  | { kind: "verdict"; result: ApprovalResult }
  | { kind: "failed"; spend: ReviewSessionSpend }
  | { kind: "setup-unavailable"; reason: string };

/**
 * The engine-agent `ReviewerAdapter` (design #279 §1/§6). Constructed via `makeEngineAgentReviewer`
 * below, given an explicit `EngineAgentReviewerDeps` — never touches `state.ts`/`materializer.ts`/
 * `RoleRunner` directly, only the deps' bound functions, so a unit test supplies plain fakes.
 *
 * `evaluate(ctx)` never throws — EVERY setup/failure path maps to `{ kind: "unavailable" }`
 * (design #279 §6: "All setup failures ... map to `unavailable`"), matching every other
 * `ReviewerAdapter.evaluate` in this codebase (CodexReviewer/HumanReviewer/
 * SameModelTrustedReviewer all return, never throw, on their own no-data case).
 */
export class EngineAgentReviewer implements ReviewerAdapter {
  readonly kind = "engine-agent" as const;
  private readonly promptTemplate: string;
  private readonly agentCfg: NonNullable<SapwoodConfig["reviewer"]["agent"]>;
  private readonly promptHash: string;
  /** #443: resolved ONCE at construction — see `EngineAgentReviewerDeps.executor`. */
  private readonly executor: ReviewSessionExecutor;

  constructor(private readonly deps: EngineAgentReviewerDeps) {
    const agent = deps.cfg.reviewer.agent;
    if (!agent) {
      // config.ts's own parse-time strictness (mode: engine-agent REQUIRES reviewer.agent)
      // already prevents this in a real `loadConfig` run — this is defense-in-depth for a
      // caller that constructs `EngineAgentReviewer` directly against a hand-built config (e.g.
      // a test), never expected to fire from a real config file.
      throw new Error("EngineAgentReviewer requires cfg.reviewer.agent to be set — construct only when reviewer.mode is engine-agent");
    }
    this.agentCfg = agent;
    this.promptTemplate = loadEngineReviewerPromptTemplate(agent.promptFile);
    this.promptHash = createHash("sha256").update(this.promptTemplate).digest("hex");
    this.executor = resolveReviewSessionExecutor(agent.runner, deps);
  }

  /** #286: no bot to ping — unlike CodexReviewer's `@codex review` PR comment (which asks an
   *  EXTERNAL bot to act asynchronously, out of band), engine-agent's review session is spawned
   *  DIRECTLY by the engine inside `evaluate()` itself (#287/E4b's drive loop calls `evaluate()`
   *  when it wants a review, full stop — there is no separate "ask something else to look at
   *  this" step for this kind). A no-op `trigger()` keeps this class's shape uniform with every
   *  other `ReviewerAdapter` (HumanReviewer/SameModelTrustedReviewer are no-op triggers too, for
   *  the same "nothing to ping" reason). */
  async trigger(_ctx: ReviewContext): Promise<void> {
    // Intentional no-op — see doc above.
  }

  async evaluate(ctx: ReviewContext): Promise<ApprovalResult> {
    if (!ctx.data) return { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" };
    const headOid = ctx.data.headOid;

    // 1. AC snapshot resolution (design #279 §5) — missing ⇒ unavailable, fail closed. The
    // session is built against the SNAPSHOTTED body/manifest below, never a live re-fetch.
    const snapshot = this.deps.getAcSnapshot(ctx.issue);
    if (!snapshot) {
      return {
        kind: "unavailable",
        headOid,
        reason: `no AC snapshot recorded for issue #${ctx.issue} — dispatch-time snapshot missing (design #279 §5, fail closed)`,
      };
    }

    // 2. Runtime model-separation check, PRE-session (D5): compare the configured agent model
    // against the producing worker's own RECORDED ACTUAL model. `workerModels` is captured ONCE
    // here and reused for the POST-session re-check in `attempt()` below — the producing lane's
    // recorded actual model cannot change mid-evaluate() (it's already terminal by the time a
    // review runs, or the pre-check itself already failed closed on "unknown").
    // #443: the worker leg always runs on the Claude CLI, so its recorded actual models carry the
    // Claude provider by construction — that is what makes them comparable to a session identity
    // as a (provider, model) PAIR rather than as a bare model string.
    const workerModels = this.deps.getWorkerActualModels(ctx.issue).map((model) => ({ provider: CLAUDE_PROVIDER, model }));
    const preCheckFailure = this.modelSeparationUnavailableReason(
      this.configuredReviewerIdentity(),
      workerModels,
      `reviewer.agent.model vs issue #${ctx.issue}'s producing lane`,
    );
    if (preCheckFailure) {
      return { kind: "unavailable", headOid, reason: preCheckFailure };
    }

    // Session input: the engine-supplied diff + the snapshotted body/AC ids + doctrine — NEVER a
    // live issue-body fetch (design #279 §5/§6). #303 review round 2 (P1): this adapter NEVER
    // fetches the diff itself (no `ctx.forge.getPRDiff` call anywhere in this class) — `ctx.diffText`
    // is the CALLER-SUPPLIED text (review/drive.ts's `resolveIdentity` return value, the exact
    // bytes it hashed into the WAL-pinned diff hash D). A self-fetched diff could review bytes
    // that differ from D if a push landed between the WAL persist and this call; requiring the
    // caller to supply it makes "session input diff === D" true by construction, not by timing
    // luck. Missing ⇒ unavailable, fail closed (a caller that doesn't thread it through is a
    // caller bug, never silently degraded to a live re-fetch).
    if (ctx.diffText === undefined) {
      return {
        kind: "unavailable",
        headOid,
        reason: "ReviewContext.diffText missing — the engine-agent adapter never fetches its own diff (design #279 §1, #303 review P1)",
      };
    }
    const prompt = this.buildPrompt(ctx.diffText, snapshot);

    // #472 fix round (gate② P1): the reviewed diff's changed-path set, derived from the SAME
    // `ctx.diffText` just validated above — a pure parse of caller-supplied text already in scope,
    // never a second live fetch (no TOCTOU risk vs. the WAL-pinned diff D; see `changedPathsFromDiff`'s
    // own doc, finding-axes.ts). Threaded into every `attempt()` below so `resolveFindingPath`'s
    // retention branch is LIVE in production: a session-supplied `path` genuinely in this diff is
    // KEPT, not unconditionally dropped (the P1 this fix round closes — `pathDropped` regains its
    // documented meaning instead of being true for every path unconditionally).
    const changedPaths = changedPathsFromDiff(ctx.diffText);

    // 3. Materialize the head. Failure ⇒ unavailable — `runReviewSession` (called from
    // `attempt()` below) already maps a `MaterializeResult` failure to its own `unavailable`
    // outcome, so this call's result is simply threaded through rather than branched on twice.
    let materialized: MaterializeResult;
    try {
      materialized = await this.deps.materialize(headOid);
    } catch (e) {
      materialized = { kind: "failure", reason: `materialize() threw: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 6/7. Spawn via runReviewSession with `--max-budget-usd` = the remaining logical budget:
    // attempt 1 gets the full cap; a `failed` (invalid/unparseable output, or a crashed/timed-out
    // session — both "ran but produced nothing usable") attempt retries ONCE with budget = cap -
    // attempt 1's own recorded cost. The retry reuses the SAME materialized tree (peripheral.ts's
    // RoleRunner never deletes a review session's materialized directory — see reviewCwd's own
    // doc — so re-materializing for the retry would be redundant work, not a correctness
    // requirement) but a FRESH session (a new `run()` call, its own session name/id).
    const capUsd = this.agentCfg.costCapUsd;
    const first = await this.attempt(materialized, prompt, capUsd, snapshot, headOid, workerModels, changedPaths, []);
    if (first.kind === "verdict") return first.result;
    if (first.kind === "setup-unavailable") return { kind: "unavailable", headOid, reason: first.reason };

    // #302 review (Codex P1, cost cap): an attempt whose spend is UNKNOWN (no cost record in the
    // transcript — e.g. a session killed before writing its result line) must NOT be treated as
    // "$0 spent, full cap remains": the remainder arithmetic below would grant attempt 2 a second
    // full cap, violating the whole-logical-review cap (issue #286 AC#4). Fail closed: no retry.
    if (first.spend.kind === "unknown") {
      return {
        kind: "unavailable",
        headOid,
        reason:
          "engine-agent review attempt 1 failed with NO recorded cost (transcript carried no cost record) — " +
          "its spend against the logical-review cap is unknown, so a retry cannot be budgeted (fail-closed, no retry)",
      };
    }
    const remainder = capUsd - first.spend.usd;
    if (remainder <= 0) {
      return {
        kind: "unavailable",
        headOid,
        reason: `engine-agent review attempt 1 produced no valid output and exhausted its cost cap ($${capUsd.toFixed(2)}) — no budget remains for a retry`,
      };
    }
    const second = await this.attempt(materialized, prompt, remainder, snapshot, headOid, workerModels, changedPaths, [first.spend]);
    if (second.kind === "verdict") return second.result;
    if (second.kind === "setup-unavailable") return { kind: "unavailable", headOid, reason: second.reason };
    return {
      kind: "unavailable",
      headOid,
      reason: "engine-agent review attempt 2 (retry) also produced no valid output — giving up for this head",
    };
  }

  /** One `runReviewSession` call, mapped into `AttemptOutcome`. `fallbackModel: "none"`
   *  (claudeArgs' own documented sentinel for "omit `--fallback-model` entirely", worker.ts) is a
   *  DELIBERATE choice, not an oversight: a worker/role session's fallback model exists to keep a
   *  session ALIVE through a primary-model outage, but a silent fallback swap here could — in the
   *  worst case — land the review session on the SAME model as the producing worker, exactly what
   *  D5 exists to prevent. Failing the session outright (mapped to a `failed` attempt, then the
   *  same retry-once/unavailable path as any other failure) is the fail-closed choice; a future
   *  issue could add a SEPARATE, ALSO-distinct fallback model if this proves too brittle in
   *  practice — out of this PR's scope. */
  private async attempt(
    materialized: MaterializeResult,
    prompt: string,
    budgetUsd: number,
    snapshot: AcSnapshot,
    headOid: string,
    workerModels: readonly ReviewSessionIdentity[],
    changedPaths: ReadonlySet<string>,
    /** #513: the spends of every attempt already EXECUTED before this one (empty for attempt 1) —
     *  accumulated into `sessionSpends` alongside this attempt's own spend on the verdict branch
     *  below, so a retry's persisted artifact records BOTH attempts' cost, not just the
     *  verdict-producing one (a summed value would discard "attempt 1 known, attempt 2 unknown"). */
    priorSpends: readonly ReviewSessionSpend[],
  ): Promise<AttemptOutcome> {
    const outcome = await runReviewSession(this.executor, {
      materialize: materialized,
      roleId: "engine-reviewer",
      prompt,
      model: this.agentCfg.model,
      effort: this.agentCfg.effort,
      maxBudgetUsd: budgetUsd,
    });
    if (outcome.kind === "unavailable") {
      return { kind: "setup-unavailable", reason: outcome.reason };
    }
    if (outcome.outcome !== "done") {
      return { kind: "failed", spend: outcome.spend };
    }
    // Runtime model-separation check, POST-session (D5): re-verify using the SESSION'S OWN
    // recorded actual modelUsage against the producing WORKER's own recorded actual model(s) —
    // NOT against the configured `reviewer.agent.model` (which the session's actual model
    // ordinarily just equals in the success case — comparing against config here would reject
    // every ordinary successful run). The residual this check exists to catch: an engine-agent
    // session that, despite `fallbackModel: "none"`, still ends up reporting the SAME actual
    // model the worker leg ran under (e.g. a CLI-level model substitution outside this module's
    // control) — a verdict from an indistinguishable model must never gate, even though the
    // pre-session check (config-derived) already passed.
    // #302 review (Codex P1, D5 unknown sentinel): worker.ts's parseModelUsage emits a model
    // literally named "unknown" for records carrying no model identity. The WORKER side already
    // filters it (state.getWorkerActualModels excludes 'unknown' rows) — filter the REVIEWER side
    // identically BEFORE the comparison, or `["unknown"]` would read as a non-empty, overlapping-
    // nothing list and pass as "distinguishable": an approval from an UNIDENTIFIABLE model. With
    // the sentinel filtered, an all-unknown session leaves an EMPTY reviewer list and the
    // existing empty ⇒ unavailable branch fires (fail-closed, same as an unknown worker actual).
    // #443: the sentinel filtering now lives in the EXECUTOR (review-session.ts's Claude executor
    // drops the "unknown" model rows before building its identity list), so what arrives here is
    // already "every identity this session could actually establish" — an empty list still means
    // UNIDENTIFIABLE, and the codex-exec runner reaches the same empty list when its own transcript
    // carries no (provider, model) pair. One rule, both runners.
    const postCheckFailure = this.modelSeparationUnavailableReason(
      outcome.identity,
      workerModels,
      "this engine-agent session's own recorded actual model vs the producing lane's",
    );
    if (postCheckFailure) {
      return { kind: "setup-unavailable", reason: postCheckFailure };
    }
    const parsed = parseAgentReviewOutputText(outcome.resultText, snapshot.manifest, changedPaths);
    if (!parsed) {
      return { kind: "failed", spend: outcome.spend };
    }
    const result = deriveApprovalResult(parsed, headOid);
    // #472 fix round (gate② P1): the persisted artifact carries EVERY classified finding — blocking
    // AND advisory — on BOTH verdict branches, via the SAME `applySeverityOverride` primitive
    // `deriveApprovalResult` itself applies internally (finding-axes.ts). Before this fix,
    // `result.kind === "rejected" ? result.findings : []` meant an approved verdict's advisories
    // (recorded in `result.evidence.advisories`, never in `result.findings` — `approved.findings` is
    // `never` by type) had nowhere to go, and a rejected verdict's `result.findings` is deliberately
    // BLOCKING-ONLY (design §1's gate contract, unchanged by this fix) so it never carried the
    // advisories that rode along in the same output either. Recomputing the full gated set here
    // (rather than threading a new field through `ApprovalResult`) keeps the GATE's own return shape
    // exactly as `deriveApprovalResult`'s doc states — this is audit-artifact plumbing, not a gate
    // change: `result.kind`/`result.findings`/`result.evidence` are unread below.
    const gatedFindings = parsed.findings.map(applySeverityOverride);
    this.deps.onReviewArtifact?.(headOid, {
      perAC: parsed.perAC,
      findings: gatedFindings,
      // #513: the DECISIVE attempt's own (provider, model) identities only — a failed prior
      // attempt never passed this same D5 check, so its telemetry is not provenance and is
      // deliberately NOT folded in here (unlike `sessionSpends` below, which does accumulate).
      sessionActualIdentities: dedupeIdentities(outcome.identity),
      // #513: every EXECUTED attempt's spend, in order — `onReviewArtifact` still fires exactly
      // once, here, on the attempt that produced the verdict, carrying the full accumulated list.
      sessionSpends: [...priorSpends, outcome.spend],
      promptHash: this.promptHash,
    });
    return { kind: "verdict", result };
  }

  /** #443 (D5): the reviewer identity the PRE-session check compares — the closest static proxy
   *  available before any session has run.
   *   - `runner: claude` — `[{ anthropic, reviewer.agent.model }]`, exactly today's check: both
   *     sides run on the Claude CLI, so two bare model names are directly comparable.
   *   - `runner: codex-exec` — `null`, meaning "not statically comparable, skip the OVERLAP test".
   *     The provider a `codex exec` session will actually report is not derivable from config (the
   *     runner is not the vendor: `codex exec` can target non-OpenAI providers) and the
   *     adjudication rejected inventing a `provider` key to declare it. What survives is the
   *     stronger, non-static check: the POST-session comparison against the session's OWN recorded
   *     (provider, model) telemetry, with an unidentifiable session mapping to `unavailable`. The
   *     worker-unknown branch below still runs for BOTH runners — a review whose producer cannot
   *     be identified at all fails closed regardless of who reviews. */
  private configuredReviewerIdentity(): readonly ReviewSessionIdentity[] | null {
    return this.agentCfg.runner === "claude" ? [{ provider: CLAUDE_PROVIDER, model: this.agentCfg.model }] : null;
  }

  /** D5: `null` when `reviewerIdentities` is DISTINGUISHABLE from `workerIdentities` (safe to
   *  proceed); an explanatory reason string otherwise. Indistinguishable = either side's array
   *  being EMPTY ("unknown" — state.ts's `getWorkerActualModels` doc explains when the worker side
   *  legitimately happens to be empty) OR any (provider, model) PAIR appearing on BOTH sides —
   *  either way, fail closed (design #279's D5: "a verdict from the same model must never gate").
   *  Shared by the PRE-session check (a config-derived identity, or `null` — see
   *  `configuredReviewerIdentity` — which skips only the overlap comparison) and the POST-session
   *  check (the session's own recorded telemetry) — same comparison, different inputs.
   *  #443: comparison is on the PAIR, not the bare model name, so a cross-PROVIDER reviewer is
   *  distinguishable even from an identically-named model, and a same-provider one is not. */
  private modelSeparationUnavailableReason(
    reviewerIdentities: readonly ReviewSessionIdentity[] | null,
    workerIdentities: readonly ReviewSessionIdentity[],
    subjectLabel: string,
  ): string | null {
    if (workerIdentities.length === 0) {
      return `${subjectLabel}: the producing worker's actual model is unknown (no recorded model usage yet) — assumed indistinguishable, fail-closed (D5)`;
    }
    if (reviewerIdentities === null) return null;
    if (reviewerIdentities.length === 0) {
      return `${subjectLabel}: the reviewer's own actual model is unknown (no recorded model usage) — assumed indistinguishable, fail-closed (D5)`;
    }
    const overlap = reviewerIdentities.filter((r) => workerIdentities.some((w) => w.provider === r.provider && w.model === r.model));
    if (overlap.length > 0) {
      return (
        `${subjectLabel}: reviewer model(s) [${reviewerIdentities.map(formatIdentity).join(", ")}] overlap the producing worker's actual model(s) ` +
        `[${workerIdentities.map(formatIdentity).join(", ")}] (shared: ${overlap.map(formatIdentity).join(", ")}) — a same-model verdict must never gate (D5)`
      );
    }
    return null;
  }

  private buildPrompt(diff: string, snapshot: AcSnapshot): string {
    const acText =
      snapshot.manifest.length > 0
        ? snapshot.manifest.map((a) => `${a.id}: ${a.text}`).join("\n")
        : "(no acceptance criteria in the snapshot — nothing to judge per-AC; findings may still be reported)";
    const doctrineText =
      this.deps.doctrine && this.deps.doctrine.trim().length > 0 ? this.deps.doctrine : "(none configured for this repo)";
    // #302 review P1: the FULL snapshotted body — not just the extracted AC lines — is a session
    // input in its own right (issue #286's What; design #279 §5: "The session reviews against the
    // SNAPSHOTTED body text"). The body carries the verification plan and every other
    // reviewer-relevant input the full-body hash pin exists to protect; the `<acceptance-criteria>`
    // block stays the ONLY authoritative per-AC id list (the template says so explicitly), the
    // body is context, never a second id source.
    return renderEngineReviewerPrompt(this.promptTemplate, {
      diff,
      "issue-body": snapshot.body,
      "acceptance-criteria": acText,
      doctrine: doctrineText,
    });
  }
}

/** `provider/model`, the one rendering used in every D5 message — a bare model name would make two
 *  cross-provider identities look identical in the very message that explains why they are not. */
function formatIdentity(id: ReviewSessionIdentity): string {
  return `${id.provider}/${id.model}`;
}

/** #513: dedupe a session's own reported (provider, model) identities before persisting them into
 *  `EngineReviewArtifact.sessionActualIdentities` — a session's `modelUsage` transcript can carry
 *  the same identity more than once (multiple turns on the same model); the persisted record
 *  should list each DISTINCT identity once, same spirit as the pre-#513 `sessionActualModels`
 *  field's own `[...new Set(...)]` dedup, now keyed on the full pair rather than the bare model. */
function dedupeIdentities(identities: readonly ReviewSessionIdentity[]): ReviewSessionIdentity[] {
  const seen = new Set<string>();
  const out: ReviewSessionIdentity[] = [];
  for (const id of identities) {
    const key = `${id.provider} ${id.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** #443: the executor-selection dispatch. One place decides which runner executes gate②'s review
 *  session, and it FAILS CLOSED: a configured runner the composition root did not supply an
 *  executor for is a construction-time throw, never a silent fall back to the Claude default (which
 *  would turn a deliberately cross-vendor gate back into a same-vendor one without a word). The
 *  `claude` runner needs no supplied executor — it IS the default seam over `deps.runner`. */
export function resolveReviewSessionExecutor(
  runner: NonNullable<SapwoodConfig["reviewer"]["agent"]>["runner"],
  deps: Pick<EngineAgentReviewerDeps, "runner" | "executor">,
): ReviewSessionExecutor {
  if (deps.executor) {
    if (deps.executor.runner !== runner) {
      throw new Error(
        `EngineAgentReviewer: reviewer.agent.runner is "${runner}" but the supplied executor is "${deps.executor.runner}" — ` +
          "the configured runner and the executing runner must be the same (refusing to construct)",
      );
    }
    return deps.executor;
  }
  if (runner !== "claude") {
    throw new Error(
      `EngineAgentReviewer: reviewer.agent.runner is "${runner}" but no matching ReviewSessionExecutor was supplied — ` +
        "refusing to construct rather than silently reviewing on the default Claude runner",
    );
  }
  return new ClaudeReviewSessionExecutor(deps.runner);
}

/** Construct an `EngineAgentReviewer` from explicit dependencies. #288's production composition
 * root supplies the State accessors, RoleRunner, materializer, doctrine, and artifact side channel;
 * reviewer.ts's narrower classic-reviewer factory intentionally cannot supply those dependencies. */
export function makeEngineAgentReviewer(deps: EngineAgentReviewerDeps): EngineAgentReviewer {
  return new EngineAgentReviewer(deps);
}
