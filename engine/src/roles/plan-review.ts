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
//
// #214: gate⓪'s candidate set is now scoped to the ROUND POOL (align.ts's cfg.labels.roundPool
// members), read LIVE by label at phase start via the widened forge.getPoolEligibleIssues() —
// never the unbounded Ready-lane sweep this phase used to run. Every pool member splits into
// exactly one of four classes (see createPlanReviewStub below): unadjudicated (the existing full
// reviewOneIssue path, unchanged), approved in a PRIOR round (a lightweight confirm pass,
// confirmOneIssue), approved THIS round (skip — see approvedThisRound's doc), or verify:n/a
// (unchanged doc-gate path, no confirm — nothing to go stale in the same sense). A confirm
// pass's "invalidate" outcome feeds directly into the SAME draft-cycle machinery reviewOneIssue
// already has (reviewer brief -> drafter -> re-review, same maxDraftCycles cap, same escalation),
// via reviewOneIssue's new optional `seed` parameter — no separate cycle machinery is built.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, Issue } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { PeripheralStub } from "../loop/round.js";
import type { State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import {
  CONFIRM_ALLOWED_TOOLS,
  CONFIRM_DISALLOWED_TOOLS,
  PLAN_DRAFTER_DISALLOWED_TOOLS,
  type RoleRunner,
  type RoleSessionResult,
  runSessionWithRetry,
} from "./peripheral.js";

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
  log?: (message: string) => void;
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
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath.
  return join(here, "..", "..", "prompts", "plan-reviewer.md");
}

export function defaultPlanDrafterPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "plan-drafter.md");
}

/** #214: the freshness re-confirm prompt's shipped default path — same two-level resolution as
 *  defaultPlanReviewerPromptPath/defaultPlanDrafterPromptPath above. */
export function defaultPlanConfirmPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "plan-reviewer-confirm.md");
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
export function renderRolePrompt(template: string, issue: Issue, cfg: SapwoodConfig, extra: Record<string, string> = {}): string {
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

const PlanReviewerMetadataSchema = z
  .object({
    decision: z.enum(["approve", "draft_request", "verify_na"]),
    issue: z.number().int().positive(),
  })
  .strict();

const PlanDrafterMetadataSchema = z
  .object({
    issue: z.number().int().positive(),
  })
  .strict();

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
export function validateReviewerOutput(text: string, expectedIssue: number, currentBody: string): ReviewerValidation {
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

const PlanConfirmMetadataSchema = z
  .object({
    decision: z.enum(["confirm", "invalidate"]),
    issue: z.number().int().positive(),
  })
  .strict();

export type ConfirmValidation = { ok: true; decision: "confirm" | "invalidate"; body?: string } | { ok: false; reason: string };

/** Parse + schema-validate a plan-confirm session's structured output (#214): the lightweight
 *  "does this already-approved plan still hold against current main?" pass a pool member with a
 *  PRIOR-round `plan:approved` gets at every pool entry (see confirmOneIssue/approvedThisRound).
 *  Two outcomes only — "confirm" (no body needed; the whole point is zero forge writes) or
 *  "invalidate" (a REQUIRED BODY block — the SAME shape a reviewer's "draft_request" brief takes,
 *  since an invalidated confirm feeds straight into the ordinary draft-cycle machinery, see
 *  confirmOneIssue). Deliberately NO content-invariant re-check here (unlike validateReviewerOutput's
 *  "approve" branch): "confirm" is not a fresh claim that a verification-plan section exists — it
 *  is re-affirming an ALREADY gate⓪-approved plan, whose content was already verified once by the
 *  reviewOneIssue "approve" branch that first applied planApproved. */
export function validateConfirmOutput(text: string, expectedIssue: number): ConfirmValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = PlanConfirmMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (parsed.data.issue !== expectedIssue) {
    return { ok: false, reason: `structured output issue number mismatch (expected #${expectedIssue}, got #${parsed.data.issue})` };
  }
  if (parsed.data.decision === "invalidate" && (block.body === undefined || block.body.trim() === "")) {
    return { ok: false, reason: `decision "invalidate" requires a non-empty BODY block (the drafter's brief)` };
  }
  return { ok: true, decision: parsed.data.decision, ...(block.body !== undefined ? { body: block.body } : {}) };
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

function confirmDegradeReason(result: RoleSessionResult, expectedIssue: number): string {
  if (result.outcome !== "done") return `plan-confirm session failed twice (${result.outcome})`;
  const v = validateConfirmOutput(result.resultText ?? "", expectedIssue);
  return v.ok ? "plan-confirm output valid" : `plan-confirm produced invalid structured output twice: ${v.reason}`;
}

/** Shared escalation write (needs-human label + attempt-trail comment) — used by reviewOneIssue's
 *  own closures AND confirmOneIssue below, so the wording/ordering stays byte-identical between
 *  a full review's escalation and a confirm pass's. `trail` is read at CALL time (a caller may
 *  pass a growing array reference, e.g. reviewOneIssue's own `trail`, or a fresh one-entry array
 *  for a confirm pass that never accumulates across cycles). */
async function escalateNeedsHuman(
  deps: PlanReviewDeps,
  issue: Issue,
  roundId: number,
  reason: string,
  trail: readonly string[],
): Promise<void> {
  const l = deps.cfg.labels;
  const marker = planReviewMarker(roundId);
  await deps.forge.addLabel(issue.number, l.needsHuman);
  await deps.forge.addIssueComment(
    issue.number,
    `gate⓪ plan-review ${reason} — applying \`${l.needsHuman}\`. A human plan (or accepting ` +
      `\`${l.verifyNa}\` by removing \`${l.needsHuman}\`) is needed to make this issue ` +
      `dispatchable again.\n\nAttempt trail:\n- ${trail.join("\n- ")}\n\n${marker}`,
  );
}

/** #214 decision C: "approved in THIS round" for a pool member carrying `plan:approved` — a
 *  `plan-approved` event for this exact issue with event id > this round's RoundRow.start_event_id
 *  (the #123 round-window cursor). Never wall-clock time (crash-rerun-safe, same rationale as
 *  round-defaults.ts's renderAlignedGoalsFromSummary reading its own round-scoped events off the
 *  same cursor). Pre-#214 approvals (or a state hiccup, or an event-append failure at approval
 *  time — see reviewOneIssue's approve branch for why that ordering is benign either way) carry
 *  NO plan-approved event at all, so they always read as PRIOR-round here — exactly one confirm
 *  session on the issue's first post-upgrade pool entry (an accepted, one-time backfill cost, not
 *  a bug). A state-read failure fails CLOSED toward MORE review, never less: it reads as "not
 *  approved this round", which routes the issue into the confirm path (class 2) rather than
 *  silently skipping it (class 3) on unverifiable grounds. */
function approvedThisRound(state: State, roundId: number, issueNumber: number): boolean {
  try {
    const round = state.getRound(roundId);
    const cursor = round?.start_event_id ?? 0;
    return state.eventsAfterId(cursor, ["plan-approved"]).some((e) => {
      const p = e.payload as { round_id?: unknown; issue?: unknown };
      return p.round_id === roundId && p.issue === issueNumber;
    });
  } catch {
    return false;
  }
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
 *  label post-check this replaced is deleted outright, not ported (see the module doc).
 *
 *  #214 `seed`: when supplied, cycle 0's reviewer SESSION is skipped entirely — `seed.decision`
 *  (always a synthetic `"draft_request"` today) is used as that cycle's decision directly, and
 *  `seed.trailEntry` is pushed in place of the normal `cycle 0: plan-reviewer session ... ->`
 *  trail line. This is confirmOneIssue's ONLY hook into this function: an "invalidate" confirm
 *  verdict reuses this exact draft→re-review cycle (reviewer brief -> drafter -> re-review, same
 *  maxDraftCycles cap, same escalation path) rather than a bespoke copy of it. Cycle 1 onward runs
 *  a completely normal reviewer session, seed or not. */
async function reviewOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
  seed?: { decision: ReviewerDecision; trailEntry: string },
): Promise<void> {
  const l = deps.cfg.labels;
  const maxCycles = deps.cfg.roles.planReviewer.maxDraftCycles;
  const now = deps.now ?? ((): Date => new Date());
  const marker = planReviewMarker(roundId);
  const trail: string[] = [];

  /** The GitHub-visible half of an escalation — needs-human + the attempt trail. */
  const escalateForge = (reason: string): Promise<void> => escalateNeedsHuman(deps, issue, roundId, reason, trail);
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
    } catch {
      /* state write failed — the forge label/comment above already externalized it */
    }
  };

  for (let cycle = 0; cycle <= maxCycles; cycle++) {
    // P1 (fable): refetch the CURRENT body every cycle — after cycle 0 it's the drafter's edit
    // the reviewer must judge, not the phase-start snapshot.
    const currentBody = await deps.forge.getIssueBody(issue.number);
    const currentIssue: Issue = { ...issue, body: currentBody };

    let decision: ReviewerDecision;
    if (cycle === 0 && seed) {
      // #214: an invalidated confirm pass hands its brief straight in — no reviewer session
      // this cycle, same as if a normal reviewer had just bounced with "draft_request".
      decision = seed.decision;
      trail.push(seed.trailEntry);
    } else {
      const reviewerPrompt = renderRolePrompt(reviewerTemplate, currentIssue, deps.cfg);
      const reviewerRole = deps.cfg.roles.planReviewer;

      const reviewResult = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "plan-reviewer",
          prompt: reviewerPrompt,
          model: reviewerRole.model,
          effort: reviewerRole.effort,
          fallbackModel: reviewerRole.fallbackModel,
        },
        issue: issue.number,
        now,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        // #236: record this phase's ambient-context manifest for EVERY attempt. See
        // peripheral.ts's RetriedSession.contextManifest doc for the (round, phase, role,
        // session, attempt) key this writes under.
        contextManifest: { roundId, phase: "plan_review", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
        degradeEvent: "plan-review-escalated",
        degradePayload: (result) => ({
          round_id: roundId,
          issue: issue.number,
          reason: reviewerDegradeReason(result, issue.number, currentBody),
        }),
        degradeMessage: (result) =>
          `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` +
          `${reviewerDegradeReason(result, issue.number, currentBody)}`,
        isValid: (result) => validateReviewerOutput(result.resultText ?? "", issue.number, currentBody).ok,
      });

      const validated: ReviewerValidation =
        reviewResult.outcome === "done"
          ? validateReviewerOutput(reviewResult.resultText ?? "", issue.number, currentBody)
          : { ok: false, reason: `reviewer session failed twice (${reviewResult.outcome})` };

      if (!validated.ok) {
        trail.push(`cycle ${cycle}: plan-reviewer session ${reviewResult.name} -> ${validated.reason}`);
        // runSessionWithRetry already appended the plan-review-escalated STATE event above (on
        // its own second invalid/failed attempt) — only the forge-visible half is still needed.
        await escalateForge(validated.reason);
        return;
      }
      decision = validated.decision;
      trail.push(`cycle ${cycle}: plan-reviewer session ${reviewResult.name} -> ${decision.decision}`);
    }

    if (decision.decision === "approve") {
      if (decision.body !== undefined) await deps.forge.updateIssueBody(issue.number, decision.body);
      // #214 decision C: WRITE-AHEAD the load-bearing `plan-approved` event BEFORE the label
      // (#232 stance — a durable fact must exist before its externally-visible side effect).
      // Both crash orderings are benign: event-without-label (this append lands, the label
      // write below then fails/crashes) leaves the issue unlabeled, so it is still read as an
      // unadjudicated pool member (class 1) next time — a harmless repeat of this exact review.
      // label-without-event (this append fails, the label write below still succeeds) leaves an
      // approved issue with no plan-approved event for THIS round, so approvedThisRound reads it
      // as a PRIOR-round approval on its next pool entry — one redundant confirm pass, also
      // harmless. Neither ordering silently skips a check or double-applies a write.
      try {
        deps.state.appendEvent("plan-approved", { round_id: roundId, issue: issue.number });
      } catch {
        /* contained — benign either ordering, see the comment above; the label write proceeds */
      }
      await deps.forge.addLabel(issue.number, l.planApproved);
      return; // outcome 1 — approved, done
    }

    if (decision.decision === "verify_na") {
      // ORDERING INVARIANT (dual-review round 1, P1): needsHuman MUST land BEFORE verifyNa.
      // verify:n/a without needs-human is a DISPATCHABLE state (the doc-gate path) — so if the
      // second addLabel call fails after the first succeeded, the label the issue is left
      // holding alone must be the blocking one. needsHuman-first fails closed (issue stuck
      // non-dispatchable, a human notices); verifyNa-first fails OPEN (the issue dispatches via
      // the doc-gate path without the human adjudication this whole outcome exists to require).
      await deps.forge.addLabel(issue.number, l.needsHuman);
      await deps.forge.addLabel(issue.number, l.verifyNa);
      // #214 gate② review (P2): confirm-invalidate makes this branch reachable for an issue that
      // ALREADY carries plan:approved — a case reviewOneIssue never saw pre-#214 (a cold-start
      // candidate is always unapproved, see createPlanReviewStub's class 1). The engine may not
      // strip plan:approved itself (#147: engine label REMOVAL is reserved for
      // cfg.labels.roundPool alone, round.ts's removeRoundPoolLabel), and the session's own
      // free-text explanation (decision.body) habitually only names removing needs-human — the
      // plan-reviewer prompt's outcome-3 framing was written for the unapproved case, where that
      // alone is correct. On THIS reachable path, following that comment literally would leave
      // the forbidden verifyNa+planApproved mixed state (#94) — excluded from both dispatch
      // (forge.ts's isDispatchable) and pool re-entry (forge.ts's isPoolEligible, #214) alike, a
      // silent stranding a human would have no reason to suspect. Name BOTH cleanup options
      // explicitly whenever the issue's already-approved, no label machinery beyond the same two
      // addLabel calls above.
      const cleanupNote = labelsInclude(issue.labels, l.planApproved)
        ? `\n\n---\n\nThis issue already carries \`${l.planApproved}\` from a prior approval. To ` +
          `accept this verify:n/a proposal, remove BOTH \`${l.needsHuman}\` AND ` +
          `\`${l.planApproved}\` — removing only \`${l.needsHuman}\` leaves the forbidden ` +
          `\`${l.verifyNa}\`+\`${l.planApproved}\` combination, which dispatches nothing and ` +
          `re-enters no pool. To keep the plan path instead, remove \`${l.needsHuman}\` and ` +
          `\`${l.verifyNa}\` — the plan goes through review again.`
        : "";
      await deps.forge.addIssueComment(issue.number, `${decision.body}${cleanupNote}\n\n${marker}`);
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
        roleId: "plan-drafter",
        prompt: drafterPrompt,
        model: drafterRole.model,
        effort: drafterRole.effort,
        fallbackModel: drafterRole.fallbackModel,
        // Best-effort pattern layer only (peripheral.ts doc) — the authoritative enforcement of
        // "the drafter never applies a label" is now structural (see the function doc above),
        // not this deny-list. Left in place: PR1 changes the write mechanism, not the grants.
        disallowedTools: PLAN_DRAFTER_DISALLOWED_TOOLS,
      },
      issue: issue.number,
      now,
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      // #236: same record-every-attempt wiring as the reviewer session above.
      contextManifest: { roundId, phase: "plan_review", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
      degradeEvent: "plan-review-escalated",
      degradePayload: (result) => ({
        round_id: roundId,
        issue: issue.number,
        reason: drafterDegradeReason(result, issue.number),
      }),
      degradeMessage: (result) =>
        `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` + `${drafterDegradeReason(result, issue.number)}`,
      isValid: (result) => validateDrafterOutput(result.resultText ?? "", issue.number).ok,
    });

    const draftValidated: DrafterValidation =
      drafterResult.outcome === "done"
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

/** #214: one pool member's lightweight freshness re-confirm — a PRIOR-round `plan:approved`
 *  re-entering the pool (class 2, see createPlanReviewStub). ONE session, judging only "does
 *  this plan still hold against current main" — NOT a full re-review. "confirm" makes ZERO forge
 *  writes (the entire efficiency point of this pass — a fresh approval was already paid for
 *  once); "invalidate" hands its BODY block (the same brief shape a reviewer's `draft_request`
 *  carries) straight into the EXISTING draft-cycle machinery via reviewOneIssue's `seed`
 *  parameter — reviewer brief -> drafter -> re-review, the SAME maxDraftCycles cap, the SAME
 *  escalation path, no bespoke machinery of its own. A session that fails or produces invalid
 *  output TWICE (runSessionWithRetry's own one retry) is — per the issue's design, the ONE
 *  fail-CLOSED gate in this whole feature, unlike the architect's degrade-OPEN batch review —
 *  escalated needs-human with a one-entry attempt trail, the exact same forge-visible shape
 *  reviewOneIssue's own session-invalid branch uses. `plan:approved` is NEVER touched here
 *  (neither branch ever calls addLabel/removeLabel for it) — a crash mid-confirm leaves the
 *  label exactly as it was, so a rerun simply re-confirms: idempotent by construction, no marker
 *  of its own needed beyond the phase's existing one. */
async function confirmOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  confirmTemplate: string,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
): Promise<void> {
  const now = deps.now ?? ((): Date => new Date());
  const currentBody = await deps.forge.getIssueBody(issue.number);
  const currentIssue: Issue = { ...issue, body: currentBody };
  const confirmPrompt = renderRolePrompt(confirmTemplate, currentIssue, deps.cfg);
  // The confirm pass shares the plan-reviewer's own role config (model/effort/fallback) — #214
  // only introduces a distinct PROMPT (roles.planReviewer.confirmPromptFile), not a distinct role.
  const reviewerRole = deps.cfg.roles.planReviewer;

  const result = await runSessionWithRetry({
    runner: deps.runner,
    state: deps.state,
    session: {
      roleId: "plan-reviewer-confirm",
      prompt: confirmPrompt,
      model: reviewerRole.model,
      effort: reviewerRole.effort,
      fallbackModel: reviewerRole.fallbackModel,
      // #214 gate② review (P1): the ONLY role session in this phase with a real (read-only)
      // tool grant — see peripheral.ts's CONFIRM_ALLOWED_TOOLS doc for why this session, unlike
      // every other one in this file, actually needs to inspect the repo to do its job.
      allowedTools: CONFIRM_ALLOWED_TOOLS,
      disallowedTools: CONFIRM_DISALLOWED_TOOLS,
    },
    issue: issue.number,
    now,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    // #236: same record-every-attempt wiring as reviewOneIssue's own sessions.
    contextManifest: { roundId, phase: "plan_review", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
    degradeEvent: "plan-review-escalated",
    degradePayload: (r) => ({ round_id: roundId, issue: issue.number, reason: confirmDegradeReason(r, issue.number) }),
    degradeMessage: (r) =>
      `[sapwood:plan-review] round ${roundId} issue #${issue.number} confirm: ${confirmDegradeReason(r, issue.number)}`,
    isValid: (r) => validateConfirmOutput(r.resultText ?? "", issue.number).ok,
  });

  const validated: ConfirmValidation =
    result.outcome === "done"
      ? validateConfirmOutput(result.resultText ?? "", issue.number)
      : { ok: false, reason: `plan-confirm session failed twice (${result.outcome})` };

  if (!validated.ok) {
    // runSessionWithRetry already appended plan-review-escalated on its own second invalid/failed
    // attempt (same session-validity degrade shape as reviewOneIssue's reviewer branch) — only
    // the forge-visible half is still needed here.
    await escalateNeedsHuman(deps, issue, roundId, validated.reason, [
      `confirm: plan-reviewer(confirm) session ${result.name} -> ${validated.reason}`,
    ]);
    return;
  }

  if (validated.decision === "confirm") {
    return; // zero forge writes — the plan still holds, nothing to do
  }

  // invalidate -> feed the SAME machinery an unadjudicated draft_request would (existing caps,
  // existing escalation) via reviewOneIssue's seed. The confirm session's BODY block IS the
  // brief (validateConfirmOutput already required it non-empty for "invalidate").
  await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId, {
    decision: { decision: "draft_request", issue: issue.number, body: validated.body! },
    trailEntry: `confirm: plan-reviewer(confirm) session ${result.name} -> invalidate`,
  });
}

/** Builds the `plan_review` phase's PeripheralStub. Loads every role prompt template ONCE,
 *  eagerly (fail-fast on a bad promptFile before any session runs — the #74 buildRenderPrompt
 *  stance), the first time `run()` is actually invoked with fresh work to do (never on a
 *  skip-via-marker return, so a config that will never be reached because plan_review is
 *  disabled/no-op for this deployment never pays the load-and-validate cost).
 *
 *  #214: the candidate set is the ROUND POOL, not the unbounded Ready-lane sweep this phase used
 *  to run — read LIVE by label (forge.getPoolEligibleIssues() filtered by cfg.labels.roundPool)
 *  at phase-start, never a snapshot threaded from an earlier phase. ORDERING CONTRACT: this
 *  phase runs strictly AFTER architecting in round.ts's SEQUENCE (aligning -> architecting ->
 *  plan_review -> executing), in the same single-threaded await chain — so a "drop" verdict's
 *  roundPool-label removal (architect.ts's #213 batch review) has ALREADY landed by the time this
 *  reads the label; a dropped pool member is correctly invisible here, never reviewed. Every pool
 *  member splits into exactly one of four classes:
 *
 *   1. No `plan:approved` (and no `verify:n/a`) -> the existing full reviewOneIssue path,
 *      unchanged.
 *   2. `plan:approved` from a PRIOR round -> confirmOneIssue's lightweight confirm pass.
 *   3. `plan:approved` from THIS round (approvedThisRound) -> skip, no session at all (selection
 *      -> review -> dispatch all in one round; the drift window is hours, re-reviewing a
 *      just-granted approval is pure waste).
 *   4. `verify:n/a` -> unchanged doc-gate path, no confirm (the architect's own #213 batch review
 *      already saw it; nothing here goes stale in the plan-drift sense a confirm pass checks).
 *
 *  Non-pool Ready issues get ZERO gate⓪ attention of any kind — that is the entire point of
 *  scoping to the pool. */
export function createPlanReviewStub(deps: PlanReviewDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker }; // already externalized this round — no duplicate work
      const l = deps.cfg.labels;
      const eligible = await deps.forge.getPoolEligibleIssues();
      const poolMembers = eligible.filter((i) => labelsInclude(i.labels, l.roundPool));
      if (poolMembers.length > 0) {
        const reviewerTemplate = loadRolePromptTemplate(deps.cfg.roles.planReviewer.promptFile, defaultPlanReviewerPromptPath());
        const drafterTemplate = loadRolePromptTemplate(deps.cfg.roles.planDrafter.promptFile, defaultPlanDrafterPromptPath());
        const confirmTemplate = loadRolePromptTemplate(deps.cfg.roles.planReviewer.confirmPromptFile, defaultPlanConfirmPromptPath());
        for (const issue of poolMembers) {
          if (labelsInclude(issue.labels, l.verifyNa)) continue; // class 4: doc-gate path, untouched
          if (!labelsInclude(issue.labels, l.planApproved)) {
            await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId); // class 1
            continue;
          }
          if (approvedThisRound(deps.state, roundId, issue.number)) continue; // class 3: skip
          await confirmOneIssue(deps, issue, confirmTemplate, reviewerTemplate, drafterTemplate, roundId); // class 2
        }
      }
      return { marker: planReviewMarker(roundId) };
    },
  };
}
