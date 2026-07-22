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
import type { MaterializeResult } from "./materializer.js";
import { runReviewSession } from "./review-session.js";

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
  /** The RoleRunner-shaped session spawn facility — review-session.ts's `runReviewSession` takes
   *  exactly this shape (`Pick<RoleRunner, "run">`). */
  runner: Pick<RoleRunner, "run">;
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
 *                   `resultText` failed schema validation. Carries the attempt's own recorded
 *                   cost so the caller can compute the retry's remaining budget, and `costKnown`
 *                   (#302 review, Codex P1): `false` means the transcript held NO cost record at
 *                   all (RoleSessionResult.costKnown's doc) — the 0 in `costUsd` is a
 *                   placeholder, so the caller must NOT compute a remainder from it (an unknown
 *                   attempt-1 spend read as "$0 spent" would grant the retry a second FULL cap,
 *                   violating the whole-logical-review cap, issue #286 AC#4).
 *   - `setup-unavailable` — the session never got a fair chance to run at all: `runReviewSession`
 *                   itself returned `unavailable` (a materialize/spawn-setup failure), OR the
 *                   POST-session model-separation re-check (D5) found the session's own actual
 *                   model indistinguishable from the worker's. Never retried — a setup failure
 *                   or a same-model verdict is not something a second attempt fixes. */
type AttemptOutcome =
  | { kind: "verdict"; result: ApprovalResult }
  | { kind: "failed"; costUsd: number; costKnown: boolean }
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
    const workerModels = this.deps.getWorkerActualModels(ctx.issue);
    const preCheckFailure = this.modelSeparationUnavailableReason(
      [this.agentCfg.model],
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
    const first = await this.attempt(materialized, prompt, capUsd, snapshot, headOid, workerModels);
    if (first.kind === "verdict") return first.result;
    if (first.kind === "setup-unavailable") return { kind: "unavailable", headOid, reason: first.reason };

    // #302 review (Codex P1, cost cap): an attempt whose spend is UNKNOWN (no cost record in the
    // transcript — e.g. a session killed before writing its result line) must NOT be treated as
    // "$0 spent, full cap remains": the remainder arithmetic below would grant attempt 2 a second
    // full cap, violating the whole-logical-review cap (issue #286 AC#4). Fail closed: no retry.
    if (!first.costKnown) {
      return {
        kind: "unavailable",
        headOid,
        reason:
          "engine-agent review attempt 1 failed with NO recorded cost (transcript carried no cost record) — " +
          "its spend against the logical-review cap is unknown, so a retry cannot be budgeted (fail-closed, no retry)",
      };
    }
    const remainder = capUsd - first.costUsd;
    if (remainder <= 0) {
      return {
        kind: "unavailable",
        headOid,
        reason: `engine-agent review attempt 1 produced no valid output and exhausted its cost cap ($${capUsd.toFixed(2)}) — no budget remains for a retry`,
      };
    }
    const second = await this.attempt(materialized, prompt, remainder, snapshot, headOid, workerModels);
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
    workerModels: readonly string[],
  ): Promise<AttemptOutcome> {
    const outcome = await runReviewSession(this.deps.runner, {
      materialize: materialized,
      roleId: "engine-reviewer",
      prompt,
      model: this.agentCfg.model,
      effort: this.agentCfg.effort,
      fallbackModel: "none",
      maxBudgetUsd: budgetUsd,
    });
    if (outcome.kind === "unavailable") {
      return { kind: "setup-unavailable", reason: outcome.reason };
    }
    // #302 review (Codex P1, cost cap): ONLY an explicit `costKnown: false` reads as unknown —
    // `undefined` (a legacy test fake that never sets the optional field) reads as known, per
    // RoleSessionResult.costKnown's own convention; a REAL RoleRunner.run() always sets it.
    const costKnown = outcome.costKnown !== false;
    if (outcome.outcome !== "done") {
      return { kind: "failed", costUsd: outcome.costUsd, costKnown };
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
    const postCheckFailure = this.modelSeparationUnavailableReason(
      outcome.modelUsage.map((m) => m.model).filter((m) => m !== "unknown"),
      workerModels,
      "this engine-agent session's own recorded actual model vs the producing lane's",
    );
    if (postCheckFailure) {
      return { kind: "setup-unavailable", reason: postCheckFailure };
    }
    const parsed = parseAgentReviewOutputText(outcome.resultText ?? "", snapshot.manifest);
    if (!parsed) {
      return { kind: "failed", costUsd: outcome.costUsd, costKnown };
    }
    const result = deriveApprovalResult(parsed, headOid);
    this.deps.onReviewArtifact?.(headOid, {
      perAC: parsed.perAC,
      findings: result.kind === "rejected" ? result.findings : [],
      sessionActualModels: [...new Set(outcome.modelUsage.map((m) => m.model).filter((m) => m !== "unknown"))],
      promptHash: this.promptHash,
    });
    return { kind: "verdict", result };
  }

  /** D5: `null` when `reviewerModels` is DISTINGUISHABLE from `workerModels` (safe to proceed);
   *  an explanatory reason string otherwise. Indistinguishable = either side's array being EMPTY
   *  ("unknown" — state.ts's `getWorkerActualModels` doc explains when the worker side
   *  legitimately happens to be empty) OR any entry appearing on BOTH sides — either way, fail
   *  closed (design #279's D5: "a verdict from the same model must never gate"). Shared by the
   *  PRE-session check (`reviewerModels = [reviewer.agent.model]`, the closest static proxy
   *  before any session has run) and the POST-session check (`reviewerModels` = the session's own
   *  recorded actual modelUsage) — same comparison, different inputs. */
  private modelSeparationUnavailableReason(
    reviewerModels: readonly string[],
    workerModels: readonly string[],
    subjectLabel: string,
  ): string | null {
    if (workerModels.length === 0) {
      return `${subjectLabel}: the producing worker's actual model is unknown (no recorded model usage yet) — assumed indistinguishable, fail-closed (D5)`;
    }
    if (reviewerModels.length === 0) {
      return `${subjectLabel}: the reviewer's own actual model is unknown (no recorded model usage) — assumed indistinguishable, fail-closed (D5)`;
    }
    const overlap = reviewerModels.filter((m) => workerModels.includes(m));
    if (overlap.length > 0) {
      return (
        `${subjectLabel}: reviewer model(s) [${reviewerModels.join(", ")}] overlap the producing worker's actual model(s) ` +
        `[${workerModels.join(", ")}] (shared: ${overlap.join(", ")}) — a same-model verdict must never gate (D5)`
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

/** Construct an `EngineAgentReviewer` from explicit dependencies. #288's production composition
 * root supplies the State accessors, RoleRunner, materializer, doctrine, and artifact side channel;
 * reviewer.ts's narrower classic-reviewer factory intentionally cannot supply those dependencies. */
export function makeEngineAgentReviewer(deps: EngineAgentReviewerDeps): EngineAgentReviewer {
  return new EngineAgentReviewer(deps);
}
