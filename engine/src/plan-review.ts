// plan-review.ts — implements PeripheralStub for the `plan_review` phase (#87, #77
// Amendment 2's self-heal): gate⓪'s draft -> re-review orchestration for every Ready-lane
// issue that hasn't yet passed plan review this round.
//
// #110 PR1 rework: the plan-reviewer/plan-drafter sessions are PURE COMPUTATION now — no `gh`
// tool grant is ever exercised by their prompts (the (now-unused) allow/deny-list constants in
// peripheral.ts are untouched; stripping them is PR5's sweep, not this one's). Each session's
// final message ends in a structured block (structured-output.ts's sentinel format); THIS module
// parses it, validates it against a per-role zod schema, re-verifies the one content invariant
// worth cheaply re-checking (an "approve"/drafted body must actually carry a verification-plan
// section — schema-valid is not truthful), and performs EVERY GitHub write itself via IForge.
// Malformed/schema-invalid/content-invalid output is treated as an INVALID attempt for
// `runSessionWithRetry`'s `isValid` hook — retry once, then gate⓪'s existing degrade path
// (needs-human label + comment + the `plan-review-escalated` event), exactly the same fate a
// crashed/timed-out session already had. See validateReviewerOutput/validateDrafterOutput below.
//
// Idempotence (#77 decision 4, round.ts's PeripheralStub contract): a non-null incoming marker
// means a PRIOR attempt this round already ran (and externalized) this phase's work — the
// whole phase is treated as one unit of idempotent work, so a non-null marker is returned
// UNCHANGED, with no candidate re-processed. This is coarser than per-issue idempotence, but it
// is the only granularity round.ts's ledger tracks (one artifact_ref per round+phase), and it
// is fail-safe in the direction that matters: skipping a partially-worked round's remaining
// issues (they're picked up again once dispatchable, or by the next round) is far cheaper than
// risking duplicate reviewer/drafter sessions and duplicate label/comment side effects.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PeripheralStub } from "./round.js";
import type { IForge, Issue } from "./forge.js";
import { extractVerificationPlan } from "./forge.js";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import {
  RoleRunner, PLAN_DRAFTER_DISALLOWED_TOOLS, runSessionWithRetry, type RoleSessionResult,
} from "./peripheral.js";
import { parseStructuredBlock } from "./structured-output.js";

export interface PlanReviewDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (RoleRunner itself is tested against a
   *  real `claude` stub binary in peripheral.test.ts — this orchestrator's own tests fake the
   *  runner directly, the same "fake the collaborator, not the CLI" split conductor.test.ts
   *  uses for Supervisor). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

/** The round-scoped idempotency marker this phase persists via round.ts's ledger (#77
 *  decision 4's `<!-- sapwood:round:N:<phase> -->` externalized-artifact convention). Also
 *  appended to every issue comment this phase posts, so a round's plan-review activity is
 *  traceable directly on GitHub — not only in sapwood's own sqlite ledger (Amendment 1's
 *  externalization precondition). */
export function planReviewMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:plan_review -->`;
}

export function defaultPlanReviewerPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath.
  return join(here, "..", "prompts", "plan-reviewer.md");
}

export function defaultPlanDrafterPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "plan-drafter.md");
}

/** Load a role prompt TEMPLATE, raw and un-substituted (#74 pattern, generalized beyond
 *  worker.ts's own worker-only loader): the operator's configured file, or the shipped
 *  default. FAIL-FAST: a configured-but-missing/unreadable file throws, naming the path —
 *  never a silent fallback. */
export function loadRolePromptTemplate(configured: string | undefined, defaultPath: string): string {
  if (configured === undefined) return readFileSync(defaultPath, "utf8");
  if (!existsSync(configured)) {
    throw new Error(`role promptFile not found: ${configured} — refusing to run`);
  }
  try {
    return readFileSync(configured, "utf8");
  } catch (e) {
    throw new Error(`role promptFile unreadable: ${configured} (${String(e)}) — refusing to run`);
  }
}

const ISSUE_VARS: Record<string, (issue: Issue) => string> = {
  "issue.number": (issue) => String(issue.number),
  "issue.title": (issue) => issue.title,
  "issue.body": (issue) => issue.body ?? "",
  "issue.labels": (issue) => issue.labels.join(", "),
};

function configVars(cfg: SapwoodConfig): Record<string, string> {
  return {
    "labels.planApproved": cfg.labels.planApproved,
    "labels.needsHuman": cfg.labels.needsHuman,
    "labels.blocked": cfg.labels.blocked,
    "labels.verifyNa": cfg.labels.verifyNa,
    "roles.planReviewer.maxDraftCycles": String(cfg.roles.planReviewer.maxDraftCycles),
  };
}

/** `{{var}}` substitution for role prompts (#74's pattern, reused: simple regex substitution,
 *  FAILS CLOSED on any unknown `{{...}}` placeholder — never a silent literal pass-through).
 *  Wider var set than worker.ts's renderPromptTemplate (issue + config + role-specific `extra`
 *  vars, e.g. the plan-drafter's `{{reviewer.brief}}`), so implemented locally rather than
 *  reusing that function's fixed issue-only var map. */
export function renderRolePrompt(
  template: string,
  issue: Issue,
  cfg: SapwoodConfig,
  extra: Record<string, string> = {},
): string {
  const cvars = configVars(cfg);
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (Object.hasOwn(ISSUE_VARS, name)) return ISSUE_VARS[name]!(issue);
    if (Object.hasOwn(cvars, name)) return cvars[name]!;
    if (Object.hasOwn(extra, name)) return extra[name]!;
    throw new Error(
      `role prompt template: unknown variable {{${name}}} — supported: ` +
        `${[...Object.keys(ISSUE_VARS), ...Object.keys(cvars), ...Object.keys(extra)].join(", ")}`,
    );
  });
}

// ── #110 PR1: structured-output schemas + validators ────────────────────────────────────────
//
// Schema-valid is not the same as truthful (issue #110's Design section): a session could emit
// well-formed JSON claiming "approve" for a body with no verification plan at all. The engine
// re-verifies the one content invariant it can cheaply check — extractVerificationPlan on
// whatever body an approve/draft claim carries — BEFORE honoring it. A claim that fails this
// check is treated exactly like a schema-invalid one: an invalid attempt for runSessionWithRetry
// purposes (retry once, then degrade), never silently honored and never silently dropped.

const PlanReviewerMetadataSchema = z.object({
  decision: z.enum(["approve", "draft_request", "verify_na"]),
  issue: z.number().int().positive(),
}).strict();

const PlanDrafterMetadataSchema = z.object({
  issue: z.number().int().positive(),
}).strict();

export interface ReviewerDecision {
  decision: "approve" | "draft_request" | "verify_na";
  issue: number;
  /** The BODY block's raw text, when present. Meaning depends on `decision`: a revised issue
   *  body for "approve" (optional — omitted means the reviewer made no corrections), the
   *  drafter's brief for "draft_request" (required), or the human-facing explanation for
   *  "verify_na" (required). */
  body?: string;
}

export type ReviewerValidation = { ok: true; decision: ReviewerDecision } | { ok: false; reason: string };

/** Parse + schema-validate + content-verify a plan-reviewer session's structured output.
 *  `currentBody` is the issue body AS OF THIS CYCLE (already fetched to render the reviewer's
 *  own prompt) — the content-invariant check for an "approve" with no body revision runs
 *  against it, since in that case the reviewer's approval is a claim about the body AS IT
 *  ALREADY STANDS. */
export function validateReviewerOutput(
  text: string,
  expectedIssue: number,
  currentBody: string,
): ReviewerValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = PlanReviewerMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (parsed.data.issue !== expectedIssue) {
    return { ok: false, reason: `structured output issue number mismatch (expected #${expectedIssue}, got #${parsed.data.issue})` };
  }
  const { decision } = parsed.data;
  if (decision !== "approve" && (block.body === undefined || block.body.trim() === "")) {
    return { ok: false, reason: `decision "${decision}" requires a non-empty BODY block` };
  }
  if (decision === "approve") {
    const bodyToCheck = block.body ?? currentBody;
    if (extractVerificationPlan(bodyToCheck) == null) {
      return { ok: false, reason: "approve claim's issue body has no verification/acceptance plan section" };
    }
  }
  return {
    ok: true,
    decision: { decision, issue: parsed.data.issue, ...(block.body !== undefined ? { body: block.body } : {}) },
  };
}

export type DrafterValidation = { ok: true; body: string } | { ok: false; reason: string };

/** Parse + schema-validate + content-verify a plan-drafter session's structured output. The
 *  drafter's ENTIRE deliverable is the revised body — content-verified the same way an
 *  "approve" claim is (issue #110: "re-verify... any returned/drafted issue body"). */
export function validateDrafterOutput(text: string, expectedIssue: number): DrafterValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = PlanDrafterMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (parsed.data.issue !== expectedIssue) {
    return { ok: false, reason: `structured output issue number mismatch (expected #${expectedIssue}, got #${parsed.data.issue})` };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "drafted output requires a non-empty BODY block" };
  }
  if (extractVerificationPlan(block.body) == null) {
    return { ok: false, reason: "drafted body has no verification/acceptance plan section" };
  }
  return { ok: true, body: block.body };
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The reason string attached to the `plan-review-escalated` event / escalation comment when a
 *  reviewer session degrades (runSessionWithRetry's SECOND attempt still isn't usable) — a
 *  session-level failure (crashed/timed out) is distinguished from a session that exited clean
 *  but produced output that never validated, since a human resolving the escalation needs to
 *  know which one happened. */
function reviewerDegradeReason(result: RoleSessionResult, expectedIssue: number, currentBody: string): string {
  if (result.outcome !== "done") return `reviewer session failed twice (${result.outcome})`;
  const v = validateReviewerOutput(result.resultText ?? "", expectedIssue, currentBody);
  return v.ok ? "reviewer output valid" : `reviewer produced invalid structured output twice: ${v.reason}`;
}

function drafterDegradeReason(result: RoleSessionResult, expectedIssue: number): string {
  if (result.outcome !== "done") return `plan-drafter session failed twice (${result.outcome})`;
  const v = validateDrafterOutput(result.resultText ?? "", expectedIssue);
  return v.ok ? "plan-drafter output valid" : `plan-drafter produced invalid structured output twice: ${v.reason}`;
}

/** One issue's draft→re-review cycle (#77 Amendment 2, reworked by #110 PR1). Every write this
 *  orchestrator makes originates from a SCHEMA-VALIDATED, CONTENT-VERIFIED session decision —
 *  the session itself never touches `gh` (no prompt instructs it to; the tool grants are
 *  unused, stripped in PR5).
 *
 *  Every cycle re-renders the reviewer/drafter prompts from the issue's CURRENT body
 *  (forge.getIssueBody), never the phase-start snapshot — the drafter's whole output IS a body
 *  edit, and the session cannot re-read the issue itself, so a stale render would make the
 *  reviewer re-judge the pre-draft plan forever and the self-heal path could never converge
 *  (fable review P1, preserved from the pre-#110 design).
 *
 *  A reviewer session that fails outright (crash/timeout) OR produces malformed/schema-invalid/
 *  content-invalid structured output is, either way, an INVALID attempt for
 *  `runSessionWithRetry`'s `isValid` hook — retried once, then degraded via the SAME
 *  `plan-review-escalated` event + needs-human label/comment machinery gate⓪ has always used
 *  (fable review P2's stance generalizes cleanly: neither case produced a usable verdict, so
 *  briefing a drafter off it would act on something that is not a real reviewer bounce).
 *
 *  The brief is no longer read back off a posted GitHub comment (the pre-#110 freshness-
 *  snapshot machinery this replaced): a "draft_request" decision's BODY block IS the brief,
 *  directly from the validated structured output — there is no longer any comment to snapshot,
 *  fetch, or race against a stale/pre-existing one. The engine still POSTS the brief as an issue
 *  comment (this phase's stated GitHub-traceability goal), it just never reads it back.
 *
 *  The drafter's write discipline (never self-approving/labeling) is now enforced STRUCTURALLY,
 *  not by a post-hoc label diff: the drafter session has no label-write path at all (no `gh`
 *  grant it acts on, no engine code that would apply a label on its behalf) — the pre-#110
 *  label post-check this replaced is deleted outright, not ported (see the module doc). */
async function reviewOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
): Promise<void> {
  const l = deps.cfg.labels;
  const maxCycles = deps.cfg.roles.planReviewer.maxDraftCycles;
  const now = deps.now ?? ((): Date => new Date());
  const marker = planReviewMarker(roundId);
  const trail: string[] = [];

  /** The GitHub-visible half of an escalation — needs-human + the attempt trail. */
  const escalateForge = async (reason: string): Promise<void> => {
    await deps.forge.addLabel(issue.number, l.needsHuman);
    await deps.forge.addIssueComment(
      issue.number,
      `gate⓪ plan-review ${reason} — applying \`${l.needsHuman}\`. A human plan (or accepting ` +
        `\`${l.verifyNa}\` by removing \`${l.needsHuman}\`) is needed to make this issue ` +
        `dispatchable again.\n\nAttempt trail:\n- ${trail.join("\n- ")}\n\n${marker}`,
    );
  };
  /** Full escalation: the forge half above PLUS the durable state event (#104) — used for
   *  LOOP-level degradation (maxDraftCycles exhausted) where no session-retry helper already
   *  owns firing that event. Session-validity degradations (reviewer/drafter, below) instead
   *  get the event from runSessionWithRetry's own `degradeEvent` and call `escalateForge` alone,
   *  so the SAME event never fires twice for the same degradation. */
  const escalate = async (reason: string): Promise<void> => {
    await escalateForge(reason);
    // Contained: a state-write failure here must never undo the forge label/comment above,
    // which already externalized the escalation — same fail-toward-more-work stance as every
    // other appendEvent call site in this codebase.
    try {
      deps.state.appendEvent("plan-review-escalated", { round_id: roundId, issue: issue.number, reason });
    } catch { /* state write failed — the forge label/comment above already externalized it */ }
  };

  for (let cycle = 0; cycle <= maxCycles; cycle++) {
    // P1 (fable): refetch the CURRENT body every cycle — after cycle 0 it's the drafter's edit
    // the reviewer must judge, not the phase-start snapshot.
    const currentBody = await deps.forge.getIssueBody(issue.number);
    const currentIssue: Issue = { ...issue, body: currentBody };
    const reviewerPrompt = renderRolePrompt(reviewerTemplate, currentIssue, deps.cfg);
    const reviewerRole = deps.cfg.roles.planReviewer;

    const reviewResult = await runSessionWithRetry({
      runner: deps.runner,
      state: deps.state,
      session: { roleId: "plan-reviewer", prompt: reviewerPrompt, model: reviewerRole.model, effort: reviewerRole.effort },
      issue: issue.number,
      now,
      degradeEvent: "plan-review-escalated",
      degradePayload: (result) => ({
        round_id: roundId, issue: issue.number,
        reason: reviewerDegradeReason(result, issue.number, currentBody),
      }),
      degradeMessage: (result) =>
        `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` +
        `${reviewerDegradeReason(result, issue.number, currentBody)}`,
      isValid: (result) => validateReviewerOutput(result.resultText ?? "", issue.number, currentBody).ok,
    });

    const validated: ReviewerValidation = reviewResult.outcome === "done"
      ? validateReviewerOutput(reviewResult.resultText ?? "", issue.number, currentBody)
      : { ok: false, reason: `reviewer session failed twice (${reviewResult.outcome})` };

    if (!validated.ok) {
      trail.push(`cycle ${cycle}: plan-reviewer session ${reviewResult.name} -> ${validated.reason}`);
      // runSessionWithRetry already appended the plan-review-escalated STATE event above (on
      // its own second invalid/failed attempt) — only the forge-visible half is still needed.
      await escalateForge(validated.reason);
      return;
    }
    const decision = validated.decision;
    trail.push(`cycle ${cycle}: plan-reviewer session ${reviewResult.name} -> ${decision.decision}`);

    if (decision.decision === "approve") {
      if (decision.body !== undefined) await deps.forge.updateIssueBody(issue.number, decision.body);
      await deps.forge.addLabel(issue.number, l.planApproved);
      return; // outcome 1 — approved, done
    }

    if (decision.decision === "verify_na") {
      await deps.forge.addLabel(issue.number, l.verifyNa);
      await deps.forge.addLabel(issue.number, l.needsHuman);
      await deps.forge.addIssueComment(issue.number, `${decision.body}\n\n${marker}`);
      return; // outcome 3 (verify:n/a proposal) — a human resolves it
    }

    // Outcome 2: request-a-draft. At the cycle bound already -> self-heal exhausted, escalate.
    if (cycle >= maxCycles) {
      await escalate(`self-heal exhausted after ${maxCycles} draft→re-review cycle(s)`);
      return;
    }

    // The validated BODY block IS the brief — no comment-freshness snapshot/refetch needed
    // (that machinery is deleted, see the module doc). Still posted as an issue comment for
    // GitHub-visible traceability, just never read back.
    await deps.forge.addIssueComment(issue.number, `${decision.body}\n\n${marker}`);

    const drafterPrompt = renderRolePrompt(drafterTemplate, currentIssue, deps.cfg, { "reviewer.brief": decision.body! });
    const drafterRole = deps.cfg.roles.planDrafter;

    const drafterResult = await runSessionWithRetry({
      runner: deps.runner,
      state: deps.state,
      session: {
        roleId: "plan-drafter", prompt: drafterPrompt, model: drafterRole.model, effort: drafterRole.effort,
        // Best-effort pattern layer only (peripheral.ts doc) — the authoritative enforcement of
        // "the drafter never applies a label" is now structural (see the function doc above),
        // not this deny-list. Left in place: PR1 changes the write mechanism, not the grants.
        disallowedTools: PLAN_DRAFTER_DISALLOWED_TOOLS,
      },
      issue: issue.number,
      now,
      degradeEvent: "plan-review-escalated",
      degradePayload: (result) => ({
        round_id: roundId, issue: issue.number,
        reason: drafterDegradeReason(result, issue.number),
      }),
      degradeMessage: (result) =>
        `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` +
        `${drafterDegradeReason(result, issue.number)}`,
      isValid: (result) => validateDrafterOutput(result.resultText ?? "", issue.number).ok,
    });

    const draftValidated: DrafterValidation = drafterResult.outcome === "done"
      ? validateDrafterOutput(drafterResult.resultText ?? "", issue.number)
      : { ok: false, reason: `plan-drafter session failed twice (${drafterResult.outcome})` };

    if (!draftValidated.ok) {
      trail.push(`cycle ${cycle}: plan-drafter session ${drafterResult.name} -> ${draftValidated.reason}`);
      await escalateForge(draftValidated.reason);
      return;
    }
    trail.push(`cycle ${cycle}: plan-drafter session ${drafterResult.name} -> drafted a revised body`);
    await deps.forge.updateIssueBody(issue.number, draftValidated.body);
    // Loop back -> re-run the reviewer against the drafter's edit (body refetched above).
  }
}

/** Builds the `plan_review` phase's PeripheralStub. Loads both role prompt templates ONCE,
 *  eagerly (fail-fast on a bad promptFile before any session runs — the #74 buildRenderPrompt
 *  stance), the first time `run()` is actually invoked with fresh work to do (never on a
 *  skip-via-marker return, so a config that will never be reached because plan_review is
 *  disabled/no-op for this deployment never pays the load-and-validate cost). */
export function createPlanReviewStub(deps: PlanReviewDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker }; // already externalized this round — no duplicate work
      const candidates = await deps.forge.getIssuesNeedingPlanReview();
      if (candidates.length > 0) {
        const reviewerTemplate = loadRolePromptTemplate(
          deps.cfg.roles.planReviewer.promptFile,
          defaultPlanReviewerPromptPath(),
        );
        const drafterTemplate = loadRolePromptTemplate(
          deps.cfg.roles.planDrafter.promptFile,
          defaultPlanDrafterPromptPath(),
        );
        for (const issue of candidates) {
          await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId);
        }
      }
      return { marker: planReviewMarker(roundId) };
    },
  };
}
