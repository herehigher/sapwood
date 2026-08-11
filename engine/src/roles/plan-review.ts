// plan-review.ts — implements PeripheralStub for the `plan_review` phase (#87, #77
// Amendment 2's self-heal): gate⓪'s draft -> re-review orchestration for every Ready-lane
// issue that hasn't yet passed plan review this round.
//
// #110 PR1 rework: the verification-plan-reviewer/verification-plan-drafter sessions are PURE COMPUTATION now — no `gh`
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
import type { IForge, Issue, PRComment } from "../forge/forge.js";
import { extractAcceptanceCriteria, extractVerificationPlan, extractVerificationSection } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { PeripheralStub } from "../loop/round.js";
import { applyRoleBodyRewrite } from "../review/comment-cursor.js";
import {
  type CommentCursorResult,
  checkBodyDrift,
  checkCommentCursorFreshnessWithComments,
  commentCursorIsStale,
  escalateCommentCursorStale,
} from "../review/comment-cursor-gate.js";
import type { State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import {
  CONFIRM_ALLOWED_TOOLS,
  CONFIRM_DISALLOWED_TOOLS,
  envFailureHook,
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
  now: () => Date;
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

export function defaultVerificationPlanReviewerPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath.
  return join(here, "..", "..", "prompts", "verification-plan-reviewer.md");
}

export function defaultVerificationPlanDrafterPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "verification-plan-drafter.md");
}

/** #214: the freshness re-confirm prompt's shipped default path — same two-level resolution as
 *  defaultVerificationPlanReviewerPromptPath/defaultVerificationPlanDrafterPromptPath above. */
export function defaultVerificationPlanConfirmPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "verification-plan-reviewer-confirm.md");
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
    "roles.verificationPlanReviewer.maxDraftCycles": String(cfg.roles.verificationPlanReviewer.maxDraftCycles),
    // #701: the configured default working language for issue/PR-facing prose these roles
    // originate (po.md, po-decompose.md, verification-plan-drafter.md,
    // verification-plan-reviewer.md, verification-plan-reviewer-confirm.md all route through
    // this one renderRolePrompt, so wiring it here covers every one of them at once). Opaque
    // BCP-47-ish tag, `en` by default — see config.ts's `language` section doc comment.
    "lang.issuesAndPrs": cfg.language.issuesAndPrs,
  };
}

/** `{{var}}` substitution for role prompts (#74's pattern, reused: simple regex substitution,
 *  FAILS CLOSED on any unknown `{{...}}` placeholder — never a silent literal pass-through).
 *  Wider var set than worker.ts's renderPromptTemplate (issue + config + role-specific `extra`
 *  vars, e.g. the verification-plan-drafter's `{{reviewer.brief}}`), so implemented locally rather than
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

// #665: comment-digest caps for the rendered reviewer/confirm prompt — bounds prompt size
// against a runaway comment thread, same rationale as comment-cursor.ts's own
// POINTER_COMMENT_ID_CAP. ponytail: flat literal caps, widen (or make configurable) if a real
// repo's thread ever needs more than this to be actionable.
const COMMENT_DIGEST_COUNT_CAP = 30;
const COMMENT_DIGEST_BODY_CHAR_CAP = 4000;

/** #672 (Codex gate② P2 on #665): a comment body is untrusted text — anyone who can comment on
 *  the issue authored it, world-writable once the repo is public — and it is about to be
 *  interpolated straight into the `<issue-comments>...</issue-comments>` data block
 *  (renderCommentDigest below) inside the reviewer/confirm prompt. A literal `</issue-comments>`
 *  (or any other tag, e.g. a forged `<issue-body>`) inside a comment would otherwise close/reopen
 *  a block early and hand the reviewer attacker-authored text framed as prompt structure rather
 *  than as quoted comment content — a prompt-injection escape hatch. Escaping every `<` is the
 *  minimal neutralization: it denies the text the one character every one of this codebase's
 *  data-block delimiters opens on, without touching anything else about the comment's readability
 *  as plain text. No matching unescape exists anywhere downstream — this render has exactly one
 *  consumer (a read-only judgment prompt) and nothing here ever reconstitutes or re-emits the
 *  original bytes. */
function escapeAngleBrackets(text: string): string {
  return text.replaceAll("<", "&lt;");
}

/** #665: render the comment stream `checkGate0CommentCursor`'s pre-spend fetch already paid for
 *  into prompt text — author, id, body, oldest-first (the same stream order GitHub returns and
 *  comment-cursor.ts reasons about) — so the #653 comment-contradiction veto duty judges evidence
 *  it actually received, mechanically, instead of prose conditioned on a tool call nothing
 *  dispatches (the #665 root cause). Zero new forge reads: this is a pure render of comments the
 *  pre-spend checkpoint already fetched. Each body is capped, and the list itself is capped, so a
 *  runaway thread cannot blow out prompt size — an overflow past the count cap is named, never
 *  silently dropped. An empty stream renders a plain sentence, never an empty tag pair a reviewer
 *  might mistake for a rendering defect.
 *
 *  #672: each body is angle-bracket-escaped (escapeAngleBrackets above) BEFORE the truncation cap
 *  is applied — the truncated text a reviewer actually sees is the exact text the cap describes,
 *  and a comment cannot use its own truncation boundary to smuggle a half-escaped tag past the
 *  cap either. */
export function renderCommentDigest(comments: readonly PRComment[]): string {
  if (comments.length === 0) return "(no comments on this issue)";
  const shown = comments.slice(0, COMMENT_DIGEST_COUNT_CAP);
  const overflow = comments.length - shown.length;
  const entries = shown.map((c) => {
    const escapedBody = escapeAngleBrackets(c.body);
    const body =
      escapedBody.length > COMMENT_DIGEST_BODY_CHAR_CAP
        ? `${escapedBody.slice(0, COMMENT_DIGEST_BODY_CHAR_CAP)}\n… [truncated]`
        : escapedBody;
    return `### Comment ${c.id ?? "(no id)"} — @${c.login} (${c.createdAt})\n\n${body}`;
  });
  const overflowNote = overflow > 0 ? `\n\n… (${overflow} more comment(s) not shown, oldest ${shown.length} shown)` : "";
  return `${entries.join("\n\n")}${overflowNote}`;
}

// ── #110 PR1: structured-output schemas + validators ────────────────────────────────────────
//
// Schema-valid is not the same as truthful (issue #110's Design section): a session could emit
// well-formed JSON claiming "approve" for a body with no verification plan at all. The engine
// re-verifies the one content invariant it can cheaply check — extractVerificationPlan on
// whatever body an approve/draft claim carries — BEFORE honoring it. A claim that fails this
// check is treated exactly like a schema-invalid one: an invalid attempt for runSessionWithRetry
// purposes (retry once, then degrade), never silently honored and never silently dropped.

const VerificationPlanReviewerMetadataSchema = z
  .object({
    decision: z.enum(["approve", "draft_request", "verify_na", "needs_human"]),
    issue: z.number().int().positive(),
  })
  .strict();

const VerificationPlanDrafterMetadataSchema = z
  .object({
    issue: z.number().int().positive(),
  })
  .strict();

export interface ReviewerDecision {
  decision: "approve" | "draft_request" | "verify_na" | "needs_human";
  issue: number;
  /** The BODY block's raw text, when present. Meaning depends on `decision`: a revised issue
   *  body for "approve" (optional — omitted means the reviewer made no corrections), the
   *  drafter's brief for "draft_request" (required), the human-facing explanation for
   *  "verify_na" (required), or the human-facing explanation for "needs_human" (required —
   *  a plan-fixable-by-redraft case never reaches this decision, see reviewOneIssue's
   *  needs_human branch). */
  body?: string;
}

export type ReviewerValidation = { ok: true; decision: ReviewerDecision } | { ok: false; reason: string };

/** Parse + schema-validate + content-verify a verification-plan-reviewer session's structured output.
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
  const parsed = VerificationPlanReviewerMetadataSchema.safeParse(metadata);
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
    if (extractVerificationPlan(bodyToCheck) == null || extractVerificationSection(bodyToCheck) == null) {
      return { ok: false, reason: "approve claim's issue body has no verification/acceptance plan section" };
    }
    // #283 (M10, E2, design #279 §5, D4): mandatory checkbox AC. `plan:approved` is the ONLY
    // gate a non-verify:na issue passes through before dispatch (forge.ts's isDispatchable
    // re-checks the SAME extractor), so an approve claim over a body with no honest `- [ ]`
    // acceptance-criteria set must be rejected here too — same "approve claim must be true"
    // doctrine as the verification-plan check above, just extended to the checkbox AC set the
    // dispatch-time snapshot (ac-snapshot.ts) is built from.
    if (extractAcceptanceCriteria(bodyToCheck) == null) {
      return { ok: false, reason: "approve claim's issue body has no checkbox acceptance-criteria items (`- [ ] ...`)" };
    }
  }
  return {
    ok: true,
    decision: { decision, issue: parsed.data.issue, ...(block.body !== undefined ? { body: block.body } : {}) },
  };
}

export type DrafterValidation = { ok: true; body: string } | { ok: false; reason: string };

/** Parse + schema-validate + content-verify a verification-plan-drafter session's structured output. The
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
  const parsed = VerificationPlanDrafterMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (parsed.data.issue !== expectedIssue) {
    return { ok: false, reason: `structured output issue number mismatch (expected #${expectedIssue}, got #${parsed.data.issue})` };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "drafted output requires a non-empty BODY block" };
  }
  if (extractVerificationPlan(block.body) == null || extractVerificationSection(block.body) == null) {
    return { ok: false, reason: "drafted body has no verification/acceptance plan section" };
  }
  // #283 (M10, E2, design #279 §5, D4): the drafter's deliverable is re-reviewed by a fresh
  // plan-review pass (never self-approved — plan-author != plan-approver), but a drafted body
  // with no checkbox AC set would otherwise sail through THIS content check only to be rejected
  // by validateReviewerOutput's own approve-time check (or, worse, by forge.ts's isDispatchable
  // at actual dispatch time, much later) — failing here, at the drafter's own output, gives the
  // fastest possible feedback loop.
  if (extractAcceptanceCriteria(block.body) == null) {
    return { ok: false, reason: "drafted body has no checkbox acceptance-criteria items (`- [ ] ...`)" };
  }
  return { ok: true, body: block.body };
}

const VerificationPlanConfirmMetadataSchema = z
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
  const parsed = VerificationPlanConfirmMetadataSchema.safeParse(metadata);
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
  if (result.outcome !== "done") return `verification-plan-drafter session failed twice (${result.outcome})`;
  const v = validateDrafterOutput(result.resultText ?? "", expectedIssue);
  return v.ok
    ? "verification-plan-drafter output valid"
    : `verification-plan-drafter produced invalid structured output twice: ${v.reason}`;
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
 *  `seed.trailEntry` is pushed in place of the normal `cycle 0: verification-plan-reviewer session ... ->`
 *  trail line. This is confirmOneIssue's ONLY hook into this function: an "invalidate" confirm
 *  verdict reuses this exact draft→re-review cycle (reviewer brief -> drafter -> re-review, same
 *  maxDraftCycles cap, same escalation path) rather than a bespoke copy of it. Cycle 1 onward runs
 *  a completely normal reviewer session, seed or not. */
/** #652: gate⓪'s comment-adjudication cursor checkpoint — shared by reviewOneIssue's pre-spend,
 *  pre-apply, and (round 1, finding 2) pre-drafter-write call sites, plus confirmOneIssue's own
 *  pre-spend and (round 2, finding 1) post-confirm.
 *
 *  `liveBody` is supplied by the CALLER, never fetched here (round 1, finding 1's "align
 *  pre-spend" fix): at pre-spend there is nothing to re-fetch — the caller's own single
 *  `getIssueBody` read IS the body about to be rendered into the session prompt, so THAT exact
 *  read is what gets validated (fetch once, validate, then render — no second, potentially
 *  divergent, unvalidated read). At pre-apply / pre-drafter-write the caller performs a genuinely
 *  FRESH read (a session just ran — a cached read would defeat the entire point of rechecking)
 *  and passes it here as `liveBody`, alongside `sessionRenderedBody` (round 1, finding 1/2): the
 *  body the just-finished session was ACTUALLY given, i.e. `currentBody` from the top of this
 *  cycle. When supplied, a hash mismatch between the two is a `body-drift` discard — the same
 *  fail-closed path a stale/invalid comment cursor already takes, distinguished only by the
 *  event's `cause` field, so a maintainer's direct body edit mid-session is caught exactly like a
 *  late-arriving comment (the batch-8 class this checkpoint exists to close), never silently
 *  overwritten by a decision computed against the pre-edit text.
 *
 *  On either failure, applies the shared needs-human degrade (label + deduplicated pointer
 *  comment, #652 round 1 finding 3: now CONTAINED — see escalateCommentCursorStale's own doc) and
 *  records the durable event UNCONDITIONALLY, with the label/post outcome in its payload; returns
 *  `blocked: true`, meaning the caller must stop (refuse to spend / discard the decision without
 *  applying it). Returns `blocked: false` when it's safe to proceed.
 *
 *  #665: also returns `comments` — the raw comment stream this call's OWN
 *  `checkCommentCursorFreshnessWithComments` fetch already paid for (empty when the drift check
 *  short-circuited that fetch entirely, or when the freshness check reported stale — neither
 *  reviewOneIssue's nor confirmOneIssue's pre-spend call site reads `comments` on a blocked
 *  return, since the caller stops before ever rendering a prompt). The pre-spend checkpoint is
 *  the ONLY call site that threads `comments` onward, into `renderCommentDigest` for the
 *  reviewer/confirm prompt render — the other three checkpoints (pre-apply, pre-drafter-write,
 *  post-confirm) run after a prompt was already rendered and never need it. */
async function checkGate0CommentCursor(
  deps: PlanReviewDeps,
  issue: Issue,
  roundId: number,
  checkpoint: "gate0-pre-spend" | "gate0-pre-apply" | "gate0-pre-drafter-write" | "gate0-post-confirm",
  liveBody: string,
  sessionRenderedBody?: string,
): Promise<{ blocked: boolean; comments: readonly PRComment[] }> {
  const drift = sessionRenderedBody !== undefined ? checkBodyDrift(liveBody, sessionRenderedBody) : null;
  // Drift is checked FIRST and short-circuits the comment-stream fetch entirely when it fires —
  // a pure string compare against a body already in hand, cheaper than (and unrelated to) the
  // comment-freshness read, and there is nothing further worth checking once the input a session
  // judged is already known to be stale.
  const fetched = drift == null ? await checkCommentCursorFreshnessWithComments(deps.forge, issue.number, liveBody) : null;
  const result = drift ?? fetched!.result;
  const comments = fetched?.comments ?? [];
  if (drift == null && !commentCursorIsStale(result)) return { blocked: false, comments };
  const { labeled, posted, labelError, postError } = await escalateCommentCursorStale(deps.forge, deps.cfg, issue.number, result);
  try {
    deps.state.appendEvent("comment-cursor-stale", {
      round_id: roundId,
      issue: issue.number,
      checkpoint,
      cause: drift != null ? "body-drift" : "comment-cursor",
      labeled,
      posted,
      ...(labelError !== undefined ? { labelError } : {}),
      ...(postError !== undefined ? { postError } : {}),
    });
  } catch {
    /* contained — the forge escalation (label + pointer comment) already landed */
  }
  return { blocked: true, comments };
}

/** #703 v2 gate② R2 (P1-2, round 2): the FINAL check immediately before `forge.updateIssueBody`
 *  in the reviewer approve-with-revision / drafter branches — SYNCHRONOUS drift only, no comment/
 *  actor fetch, so there is NO async I/O of any kind between the write-boundary body read and the
 *  actual write. Gate②'s own round-1 fix (`checkGate0CommentCursor` reused as a second checkpoint
 *  right here) still routed through `checkCommentCursorFreshnessWithComments`'s own
 *  `getIssueComments`/`getAuthenticatedActor` fetch whenever drift was absent — reopening the
 *  EXACT race one level later (a body edit landing during THAT fetch was, again, evaluated
 *  against the stale write-time snapshot and silently overwritten). `checkBodyDrift` is a pure
 *  string compare — call sites structure this as `getIssueBody` -> `checkBodyDrift` (this
 *  function) -> `updateIssueBody`, with literally nothing awaited in between on the no-drift
 *  path. On drift, this function itself performs the (necessarily async) escalation and the
 *  caller returns without ever reaching the write — the SAME contained needs-human/pointer-
 *  comment/event handling `checkGate0CommentCursor` uses, just invoked from here instead. */
async function escalateFinalWriteDrift(
  deps: PlanReviewDeps,
  issue: Issue,
  roundId: number,
  checkpoint: "gate0-write-apply" | "gate0-write-drafter",
  drift: CommentCursorResult,
): Promise<void> {
  const { labeled, posted, labelError, postError } = await escalateCommentCursorStale(deps.forge, deps.cfg, issue.number, drift);
  try {
    deps.state.appendEvent("comment-cursor-stale", {
      round_id: roundId,
      issue: issue.number,
      checkpoint,
      cause: "body-drift",
      labeled,
      posted,
      ...(labelError !== undefined ? { labelError } : {}),
      ...(postError !== undefined ? { postError } : {}),
    });
  } catch {
    /* contained — the forge escalation (label + pointer comment) already landed */
  }
}

/** #374 review (Codex sol-high verify-pass finding 1, P1 — fixes a recovery canary starvation):
 *  returns `true` when THIS call's own session(s) observed a classified env failure (park
 *  entered/extended) this pass, `false` otherwise (approved / verify_na / self-heal-exhausted /
 *  a genuine session failure — none of which say anything about provider reachability).
 *  createPlanReviewStub's loop uses this — NOT "does a park row currently exist" — to decide
 *  whether to skip the REMAINING pool members: the first item in any pass must always run for
 *  real (it IS the canary — a "done" outcome clears an open park, a classified one extends it),
 *  so gating on pre-existing park state would let an armed recovery round (a green
 *  probeLlmReachable ping that only ARMS the round, never clears the episode outright — see
 *  round.ts's own canary doctrine) skip every session before any of them ever had a chance to
 *  prove recovery, wedging the engine parked forever. */
async function reviewOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
  // #652 round 2 (finding 1): `sessionInputBody`, when supplied, is the body the SEEDING
  // session (confirmOneIssue's own confirm session, NOT a reviewer session this function ever
  // ran) actually rendered its prompt from — threaded through so THIS cycle's pre-apply
  // checkpoint below can body-drift-compare against it, exactly as it already does for a real
  // reviewer/drafter session's own `sessionInputBody`/`currentBody`. Omitted (the self-heal skip
  // seeds below, confirmOneIssue's missing-plan/missing-AC branches) because no session rendered
  // anything there — the decision is a deterministic engine-authored brief, not a session verdict
  // that could have gone stale mid-session.
  seed?: { decision: ReviewerDecision; trailEntry: string; sessionInputBody?: string },
): Promise<boolean> {
  const l = deps.cfg.labels;
  const maxCycles = deps.cfg.roles.verificationPlanReviewer.maxDraftCycles;
  const now = deps.now;
  const marker = planReviewMarker(roundId);
  const trail: string[] = [];

  /** The GitHub-visible half of an escalation — needs-human + the attempt trail. */
  const escalateForge = (reason: string): Promise<void> => escalateNeedsHuman(deps, issue, roundId, reason, trail);
  /** Full escalation: the forge half above PLUS the durable state event (#104) — used for
   *  LOOP-level degradation (maxDraftCycles exhausted) where no session-retry helper already
   *  owns firing that event. Session-validity degradations (reviewer/drafter, below) instead
   *  get the event from runSessionWithRetry's own `degradeEvent` and call `escalateForge` alone,
   *  so the SAME event never fires twice for the same degradation.
   *
   *  #374 review (Codex sol-high verify-pass finding 3, P1 — narrows an over-broad false-park
   *  source): this function's ONLY caller (self-heal exhausted after maxDraftCycles, below) is a
   *  cycle-exhaustion — every reviewer/drafter session along the way ran cleanly and produced a
   *  validly-decided verdict; the loop simply hit its configured cap. That is a legitimate,
   *  provider-healthy outcome, structurally distinct from the SAME event's OTHER emission sites
   *  (runSessionWithRetry's own `degradeEvent` in the reviewer/drafter/confirm sessions below),
   *  which fire only on a genuine session failure (crashed/timed out, or invalid output twice).
   *  `origin: "cycle-exhausted"` on the payload lets round-artifact.ts's assembler tell the two
   *  apart — see its own doc for why only `"session-failure"` counts toward the empty-spin
   *  breaker's degraded-phase signal. Hardcoded (not a parameter) because this helper has
   *  exactly one call site today; a future second LOOP-level (non-session) escalation reason
   *  would still correctly report the same origin. */
  const escalate = async (reason: string): Promise<void> => {
    await escalateForge(reason);
    // Contained: a state-write failure here must never undo the forge label/comment above,
    // which already externalized the escalation — same fail-toward-more-work stance as every
    // other appendEvent call site in this codebase.
    try {
      deps.state.appendEvent("plan-review-escalated", {
        round_id: roundId,
        issue: issue.number,
        reason,
        origin: "cycle-exhausted",
      });
    } catch {
      /* state write failed — the forge label/comment above already externalized it */
    }
  };

  for (let cycle = 0; cycle <= maxCycles; cycle++) {
    // P1 (fable): refetch the CURRENT body every cycle — after cycle 0 it's the drafter's edit
    // the reviewer must judge, not the phase-start snapshot.
    const currentBody = await deps.forge.getIssueBody(issue.number);
    const currentIssue: Issue = { ...issue, body: currentBody };

    // #652 round 1 (finding 1) / round 2 (finding 1): the body-drift comparison target for THIS
    // cycle's pre-apply checkpoint below — set from a reviewer SESSION that actually rendered a
    // prompt from a known body this cycle (the `else` branch), OR threaded straight from
    // `seed.sessionInputBody` when the seed came from confirmOneIssue's OWN confirm session
    // (round 2: previously left undefined here, disabling the pre-apply body-drift compare for
    // every seed-born "invalidate" decision — confirmOneIssue now passes its own rendered body
    // through the seed, see this function's `seed` param doc). Stays undefined for the two
    // self-heal skip seeds (no session ever rendered anything there), same as before.
    let sessionInputBody: string | undefined = seed?.sessionInputBody;
    let decision: ReviewerDecision;
    if (cycle === 0 && seed) {
      // #214: an invalidated confirm pass hands its brief straight in — no reviewer session
      // this cycle, same as if a normal reviewer had just bounced with "draft_request".
      decision = seed.decision;
      trail.push(seed.trailEntry);
    } else {
      // #652: pre-spend checkpoint — refuse to spend on a reviewer session while the issue's
      // comment-adjudication cursor is stale/invalid. The seed branch above never reaches here
      // (it spends nothing), but the pre-apply checkpoint below still protects its decision.
      // #652 round 1 (finding 1): `currentBody` above IS this checkpoint's live read — passed
      // straight through, never re-fetched, so the exact text validated here is the exact text
      // `currentIssue`/the reviewer prompt render below.
      const cursorCheck = await checkGate0CommentCursor(deps, issue, roundId, "gate0-pre-spend", currentBody);
      if (cursorCheck.blocked) return false;
      sessionInputBody = currentBody;

      // #665: the already-fetched comment stream (author, id, body) rendered straight into the
      // prompt — see renderCommentDigest's own doc for why this is a zero-new-fetch substitution.
      const reviewerPrompt = renderRolePrompt(reviewerTemplate, currentIssue, deps.cfg, {
        "comments.digest": renderCommentDigest(cursorCheck.comments),
        "comments.digestCap": String(COMMENT_DIGEST_COUNT_CAP),
      });
      const reviewerRole = deps.cfg.roles.verificationPlanReviewer;

      const reviewResult = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "verification-plan-reviewer",
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
        // #374 review (Codex sol-high verify-pass finding 3, P1): this fires ONLY on a genuine
        // reviewer session failure (crashed/timed out, or invalid output twice) — see escalate()'s
        // own doc above for the origin-tagging contract this distinguishes from.
        degradePayload: (result) => ({
          round_id: roundId,
          issue: issue.number,
          reason: reviewerDegradeReason(result, issue.number, currentBody),
          origin: "session-failure",
        }),
        degradeMessage: (result) =>
          `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` +
          `${reviewerDegradeReason(result, issue.number, currentBody)}`,
        isValid: (result) => validateReviewerOutput(result.resultText ?? "", issue.number, currentBody).ok,
        // #374: quota/429 parks instead of escalating needs-human — see peripheral.ts's
        // envFailureHook doc. A classified attempt returns with `envParked: true` — see the
        // check right below, which stops this function's OWN escalation branch from ever
        // mislabeling an issue needs-human over a provider outage.
        envFailure: envFailureHook(deps.cfg, deps.state),
      });
      if (reviewResult.envParked) {
        // #374: the engine parked instead of escalating (peripheral.ts's runSessionWithRetry
        // already recorded the durable env-park episode + role-env-failure event) — this issue
        // simply gets no verdict THIS pass; it re-matches next round once dispatch resumes. NO
        // needs-human, NO plan-review-escalated (that event is for a genuine review failure, not
        // an environment outage).
        trail.push(`cycle ${cycle}: verification-plan-reviewer session ${reviewResult.name} -> environment park (provider outage)`);
        return true;
      }

      const validated: ReviewerValidation =
        reviewResult.outcome === "done"
          ? validateReviewerOutput(reviewResult.resultText ?? "", issue.number, currentBody)
          : { ok: false, reason: `reviewer session failed twice (${reviewResult.outcome})` };

      if (!validated.ok) {
        trail.push(`cycle ${cycle}: verification-plan-reviewer session ${reviewResult.name} -> ${validated.reason}`);
        // runSessionWithRetry already appended the plan-review-escalated STATE event above (on
        // its own second invalid/failed attempt) — only the forge-visible half is still needed.
        await escalateForge(validated.reason);
        return false;
      }
      decision = validated.decision;
      trail.push(`cycle ${cycle}: verification-plan-reviewer session ${reviewResult.name} -> ${decision.decision}`);
    }

    // #652: pre-apply checkpoint — recheck IMMEDIATELY before applying ANY reviewer-derived body
    // or label write, whether `decision` came from a real session (above) or a seed (#214's
    // invalidated-confirm handoff). A body edit or a pending comment landing WHILE the session
    // ran discards the decision without applying any of it — approve/verify_na/draft_request/needs_human
    // alike, never a partial apply.
    // #652 round 1 (finding 1): a FRESH live read — never `currentBody` above, which is the body
    // the session (when one ran this cycle) was GIVEN, not what may have changed since. Compared
    // against `sessionInputBody` (undefined for the seed branch, see its own doc above) to catch
    // a direct body edit landing DURING the session, the same drift class the AC-snapshot
    // mechanism catches for dispatch/drive.
    const liveBodyPreApply = await deps.forge.getIssueBody(issue.number);
    if ((await checkGate0CommentCursor(deps, issue, roundId, "gate0-pre-apply", liveBodyPreApply, sessionInputBody)).blocked) return false;

    if (decision.decision === "approve") {
      // #703: the reviewer's own body revision is a ROLE-produced rewrite — never trusted to
      // carry the adjudication marker itself. `applyRoleBodyRewrite` strips whatever marker (if
      // any) the session emitted and reattaches the CURRENT body's marker byte-for-byte (or
      // none, if the current body had none) — see that function's own doc for the full ruling.
      if (decision.body !== undefined) {
        // #703 v2 gate② R2 (P1-2, round 2): `liveBodyPreApply` was snapshotted BEFORE the
        // pre-apply `checkGate0CommentCursor` call's own async comment/actor fetch just above —
        // a human editing the marker (or anything else) DURING that fetch would otherwise have
        // the write below still silently use the now-STALE `liveBodyPreApply` snapshot,
        // overwriting/re-advancing their edit without ever having re-checked it. Re-read
        // IMMEDIATELY at the write boundary; `checkBodyDrift` (SYNCHRONOUS — see
        // `escalateFinalWriteDrift`'s own doc for why round 1's reuse of the full async
        // `checkGate0CommentCursor` here reopened the exact same race one level later) compares
        // `writeTimeBody` against `liveBodyPreApply` with NO intervening await of any kind: on
        // equality, the write below follows immediately; on drift, the write never happens.
        const writeTimeBody = await deps.forge.getIssueBody(issue.number);
        const writeDrift = checkBodyDrift(writeTimeBody, liveBodyPreApply);
        if (writeDrift != null) {
          await escalateFinalWriteDrift(deps, issue, roundId, "gate0-write-apply", writeDrift);
          return false;
        }
        await deps.forge.updateIssueBody(issue.number, applyRoleBodyRewrite(writeTimeBody, decision.body));
      }
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
      return false; // outcome 1 — approved, done
    }

    if (decision.decision === "verify_na") {
      // ORDERING INVARIANT (dual-review round 1, P1; extended #214 gate② review delta P2):
      // needsHuman label -> comment -> verifyNa label, in that exact order. Three crash windows,
      // every one safe:
      //   1. Crash before/during the needsHuman write -> no verifyNa either -> the issue is
      //      exactly as it was (or needs-human-only, still non-dispatchable) — safe.
      //   2. Crash after needsHuman lands but before/during the comment -> needs-human-only,
      //      still non-dispatchable, no instructions posted yet but also nothing to act on
      //      incorrectly — safe, and a rerun of this issue (it never left the pool: needsHuman
      //      excludes it from isPoolEligible, so nothing re-drives it, but nothing HARMFUL is
      //      possible either — a human still sees the bare needs-human hold and the reviewer's
      //      decision.body would need to be re-derived some other way; accepted, same class of
      //      residual as any other mid-write crash in this file).
      //   3. Crash after the comment lands but before/during the verifyNa write -> needs-human-
      //      only, STILL non-dispatchable, but now WITH the (possibly dual-label) cleanup
      //      instructions already visible — fails toward MORE information, never less.
      // The one ordering this rules out by construction: verifyNa landing without the comment
      // already having landed. Before #214 gate② review's delta, the comment (with its
      // conditional dual-cleanup note, see below) was posted AFTER both labels — a crash between
      // addLabel(verifyNa) and addIssueComment left needsHuman+verifyNa+planApproved (the exact
      // forbidden #94 mixed state) with ZERO instruction on the issue, and no rerun ever revisits
      // it (needsHuman-holding issues are excluded from pool eligibility, so nothing re-drives
      // this code path) — a human then removing only needsHuman would recreate the very stranding
      // this comment exists to prevent. verifyNa now lands LAST, only once the (possibly dual-
      // label) instructions are already durably posted.
      await deps.forge.addLabel(issue.number, l.needsHuman);
      // #214 gate② review (P2): confirm-invalidate makes this branch reachable for an issue that
      // ALREADY carries plan:approved — a case reviewOneIssue never saw pre-#214 (a cold-start
      // candidate is always unapproved, see createPlanReviewStub's class 1). The engine may not
      // strip plan:approved itself (#147: engine label REMOVAL is reserved for
      // cfg.labels.roundPool alone, round.ts's removeRoundPoolLabel), and the session's own
      // free-text explanation (decision.body) habitually only names removing needs-human — the
      // verification-plan-reviewer prompt's outcome-3 framing was written for the unapproved case, where that
      // alone is correct. On THIS reachable path, following that comment literally would leave
      // the forbidden verifyNa+planApproved mixed state (#94) — excluded from both dispatch
      // (forge.ts's isDispatchable) and pool re-entry (forge.ts's isPoolEligible, #214) alike, a
      // silent stranding a human would have no reason to suspect. Name BOTH cleanup options
      // explicitly whenever the issue's already-approved, no label machinery beyond the same two
      // addLabel calls in this branch.
      const cleanupNote = labelsInclude(issue.labels, l.planApproved)
        ? `\n\n---\n\nThis issue already carries \`${l.planApproved}\` from a prior approval. To ` +
          `accept this verify:n/a proposal, remove BOTH \`${l.needsHuman}\` AND ` +
          `\`${l.planApproved}\` — removing only \`${l.needsHuman}\` leaves the forbidden ` +
          `\`${l.verifyNa}\`+\`${l.planApproved}\` combination, which dispatches nothing and ` +
          `re-enters no pool. To keep the plan path instead, remove \`${l.needsHuman}\` and ` +
          `\`${l.verifyNa}\` — the plan goes through review again.`
        : "";
      await deps.forge.addIssueComment(issue.number, `${decision.body}${cleanupNote}\n\n${marker}`);
      await deps.forge.addLabel(issue.number, l.verifyNa);
      // #296: the durable, event-fed half of this hold — the ONLY genuine "a person must
      // adjudicate" outcome this file produced without an event, so no event-backed surface
      // (the dashboard needs-attention strip, frontend-design.md §3) could ever show it.
      // Emitted AFTER both label writes, unlike the approve branch's write-ahead: the
      // fix-rounds-capped doctrine — an escalation event may only claim what provably landed.
      // A failed label write therefore appends nothing and the whole proposal simply repeats
      // next round. Contained like the approve branch's append: the forge escalation is already
      // durably posted, so a state-write failure must not unwind it or the rest of the pool pass.
      try {
        deps.state.appendEvent("verify-na-proposed", { round_id: roundId, issue: issue.number });
      } catch {
        /* contained — the labels+comment already landed; the hold stands without its event */
      }
      return false; // outcome 3 (verify:n/a proposal) — a human resolves it
    }

    if (decision.decision === "needs_human") {
      // Outcome 4: the reviewer has determined NO redraft can make this issue dispatchable —
      // typically, a human-merge-only path is a PREREQUISITE every acceptance criterion edits or
      // depends on, so neither a patch-deliverable rewrite nor a `## Human-owned remainder`
      // split leaves anything left to dispatch. Apply needs-human immediately instead of routing
      // through a `draft_request` cycle that can only rediscover the same verdict: retro round
      // #365 traced exactly this waste on issue #782, where 2 draft→re-review cycles ran (one
      // reviewer session already having reached this same conclusion in cycle 0's own reasoning)
      // before self-heal exhaustion applied the identical needs-human outcome this branch now
      // reaches directly. `origin: "reviewer-verdict"` (distinct from `escalate()`'s
      // "cycle-exhausted") keeps round-artifact.ts's degraded-phase breaker — which counts only
      // `"session-failure"` — from ever seeing this healthy, working-as-designed verdict as a
      // provider/session failure.
      await deps.forge.addLabel(issue.number, l.needsHuman);
      await deps.forge.addIssueComment(issue.number, `${decision.body}\n\n${marker}`);
      try {
        deps.state.appendEvent("plan-review-escalated", {
          round_id: roundId,
          issue: issue.number,
          reason: "reviewer determined this issue is not dispatchable by any redraft",
          origin: "reviewer-verdict",
        });
      } catch {
        /* contained — the label/comment already landed; the hold stands without its event */
      }
      return false; // outcome 4 — needs-human, no draft cycle attempted
    }

    // Outcome 2: request-a-draft. At the cycle bound already -> self-heal exhausted, escalate.
    if (cycle >= maxCycles) {
      await escalate(`self-heal exhausted after ${maxCycles} draft→re-review cycle(s)`);
      return false;
    }

    // The validated BODY block IS the brief — no comment-freshness snapshot/refetch needed
    // (that machinery is deleted, see the module doc). Still posted as an issue comment for
    // GitHub-visible traceability, just never read back.
    await deps.forge.addIssueComment(issue.number, `${decision.body}\n\n${marker}`);

    const drafterPrompt = renderRolePrompt(drafterTemplate, currentIssue, deps.cfg, { "reviewer.brief": decision.body! });
    const drafterRole = deps.cfg.roles.verificationPlanDrafter;

    const drafterResult = await runSessionWithRetry({
      runner: deps.runner,
      state: deps.state,
      session: {
        roleId: "verification-plan-drafter",
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
      // #374 review (Codex sol-high verify-pass finding 3, P1): genuine drafter session failure
      // only — see escalate()'s own doc for the origin-tagging contract.
      degradePayload: (result) => ({
        round_id: roundId,
        issue: issue.number,
        reason: drafterDegradeReason(result, issue.number),
        origin: "session-failure",
      }),
      degradeMessage: (result) =>
        `[sapwood:plan-review] round ${roundId} issue #${issue.number} cycle ${cycle}: ` + `${drafterDegradeReason(result, issue.number)}`,
      isValid: (result) => validateDrafterOutput(result.resultText ?? "", issue.number).ok,
      // #374: quota/429 parks instead of escalating needs-human — see envParked's check below.
      envFailure: envFailureHook(deps.cfg, deps.state),
    });
    if (drafterResult.envParked) {
      // #374: same stance as the reviewer branch above — the engine parked instead of
      // escalating; this issue gets no drafted revision THIS pass, it re-matches next round.
      trail.push(`cycle ${cycle}: verification-plan-drafter session ${drafterResult.name} -> environment park (provider outage)`);
      return true;
    }

    const draftValidated: DrafterValidation =
      drafterResult.outcome === "done"
        ? validateDrafterOutput(drafterResult.resultText ?? "", issue.number)
        : { ok: false, reason: `verification-plan-drafter session failed twice (${drafterResult.outcome})` };

    if (!draftValidated.ok) {
      trail.push(`cycle ${cycle}: verification-plan-drafter session ${drafterResult.name} -> ${draftValidated.reason}`);
      await escalateForge(draftValidated.reason);
      return false;
    }
    trail.push(`cycle ${cycle}: verification-plan-drafter session ${drafterResult.name} -> drafted a revised body`);
    // #652 round 1 (finding 2): recheck IMMEDIATELY before applying the drafter's write — the
    // drafter SESSION just ran (a long-running gap), so a comment/body edit landing during it
    // must be caught HERE, not only at the next cycle's pre-spend (which would already have
    // overwritten a maintainer's edit with the drafter's now-stale output). Compared against
    // `currentBody` — the exact body `currentIssue` (and so the drafter's own
    // `{{issue.body}}`/`{{reviewer.brief}}` substitution) was rendered from this cycle,
    // regardless of whether this cycle's decision came from a real reviewer session or a seed.
    const liveBodyPreDrafterWrite = await deps.forge.getIssueBody(issue.number);
    if ((await checkGate0CommentCursor(deps, issue, roundId, "gate0-pre-drafter-write", liveBodyPreDrafterWrite, currentBody)).blocked) {
      return false;
    }
    // #703 v2 gate② R2 (P1-2, round 2): same race this checkpoint's own async comment/actor fetch
    // just above opens as the reviewer's approve-with-revision branch (see
    // `escalateFinalWriteDrift`'s own doc) — re-read IMMEDIATELY at the write boundary and
    // re-check drift SYNCHRONOUSLY (no comment/actor fetch) before ever using it to normalize the
    // marker; `getIssueBody` -> `checkBodyDrift` -> `updateIssueBody`, nothing awaited between.
    const writeTimeBody = await deps.forge.getIssueBody(issue.number);
    const writeDrift = checkBodyDrift(writeTimeBody, liveBodyPreDrafterWrite);
    if (writeDrift != null) {
      await escalateFinalWriteDrift(deps, issue, roundId, "gate0-write-drafter", writeDrift);
      return false;
    }
    // #703: same marker-preservation rule as the reviewer's approve-with-revision branch above —
    // the drafter's ENTIRE deliverable is a role-produced body, so its output can never carry an
    // authoritative marker; the CURRENT body's marker (or lack of one) wins byte-for-byte.
    await deps.forge.updateIssueBody(issue.number, applyRoleBodyRewrite(writeTimeBody, draftValidated.body));
    // Loop back -> re-run the reviewer against the drafter's edit (body refetched above).
  }
  // Unreachable in practice (the loop always returns via one of the branches above before this
  // point — the cycle>=maxCycles check guarantees it) — kept only so TypeScript can see every
  // path returns a value.
  return false;
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
 *  of its own needed beyond the phase's existing one.
 *
 *  A confirm SESSION is dispatched only when the current body still has SOMETHING to confirm —
 *  see the extractVerificationPlan AND extractAcceptanceCriteria checks at the top (#301 review,
 *  P2 F6 added the latter, symmetric with the former): an approved-but-planless orphan (#214
 *  gate② review's forge.ts fix widened pool eligibility to include it) OR an approved issue whose
 *  checkbox AC set has since gone missing/malformed both skip the session entirely and go
 *  straight to the draft cycle, deterministically. */
/** #374 review (Codex sol-high verify-pass finding 1): returns `true` when an env-classified
 *  park was observed this pass — either from this function's OWN confirm session, or
 *  (recursively) from a reviewOneIssue call it delegates to (the self-heal skip paths and the
 *  "invalidate" branch). Same contract as reviewOneIssue's own return — see its doc. */
async function confirmOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  confirmTemplate: string,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
): Promise<boolean> {
  const now = deps.now;
  const currentBody = await deps.forge.getIssueBody(issue.number);

  // #214 gate② review (delta P2): a schema-valid "confirm" over a planless body is a real,
  // reachable session outcome — validateConfirmOutput deliberately carries no content invariant
  // (a confirm is re-affirming an ALREADY-verified plan, not making a fresh claim one exists; see
  // its own doc). Trusting the session here would leave: zero forge writes -> the body still has
  // no plan section -> dispatch still fails (forge.ts's isDispatchable body check) -> round close
  // releases the pool label -> the issue re-pools next round -> ANOTHER confirm session, forever
  // — a silent, budget-burning loop with no forward progress. Fixed engine-side, deterministically,
  // never relying on session honesty: re-check the SAME content invariant reviewOneIssue's own
  // "approve" branch already re-checks (extractVerificationPlan) BEFORE ever dispatching a confirm
  // session. A miss skips the confirm session entirely — zero session cost — and seeds the
  // ORDINARY draft-cycle machinery directly with a deterministic, engine-authored brief, exactly
  // as if a full reviewer had just bounced with "draft_request".
  if (extractVerificationPlan(currentBody) == null || extractVerificationSection(currentBody) == null) {
    return await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId, {
      decision: {
        decision: "draft_request",
        issue: issue.number,
        body:
          "This issue carries plan:approved but its body no longer contains a verification-plan " +
          "section — restore or rewrite the plan so its acceptance criteria and verification " +
          "steps are explicit again.",
      },
      trailEntry: "confirm: skipped — approved body has no verification plan section",
    });
  }
  // #283/#301 review (P2 F6): the SAME self-healing check above, symmetrically extended to the
  // checkbox acceptance-criteria set. Without this, an already-approved issue whose AC section
  // later became empty/malformed (e.g. a human edit, or `plan:approved` surviving a body rewrite)
  // would burn a confirm session every pool re-entry: the session sees a body with a real
  // verification-plan section and confirms it, the engine makes zero writes, the body is
  // unchanged, `isDispatchable` (forge.ts) still refuses to dispatch it (no valid AC set), round
  // close releases the pool label, and the issue re-pools next round for ANOTHER confirm session
  // — the exact same budget-burning, no-forward-progress loop the verification-plan check above
  // exists to prevent, just for the AC set instead. Same fix shape: skip the confirm session
  // entirely and seed the ordinary draft-cycle machinery directly.
  if (extractAcceptanceCriteria(currentBody) == null) {
    return await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId, {
      decision: {
        decision: "draft_request",
        issue: issue.number,
        body:
          "This issue carries plan:approved but its body no longer contains a valid checkbox " +
          "acceptance-criteria set (`- [ ] ...` lines under `## Acceptance criteria`) — restore " +
          "or rewrite the acceptance criteria so they are real, checkable checkbox items again.",
      },
      trailEntry: "confirm: skipped — approved body has no checkbox acceptance-criteria set",
    });
  }

  // #652: pre-spend checkpoint — same rule as reviewOneIssue's own (a confirm session is still
  // "spending on a reviewer"). The confirm branch itself makes zero forge writes (see this
  // function's own doc), so there is no separate pre-apply checkpoint here; an "invalidate"
  // verdict hands off to reviewOneIssue's seed path, which carries its own pre-apply check.
  // #652 round 1 (finding 1): `currentBody` above (line ~797) IS this checkpoint's live read —
  // passed straight through, never re-fetched (the same "fetch once, validate, then render" fix
  // as reviewOneIssue's own pre-spend call).
  const cursorCheck = await checkGate0CommentCursor(deps, issue, roundId, "gate0-pre-spend", currentBody);
  if (cursorCheck.blocked) return false;

  const currentIssue: Issue = { ...issue, body: currentBody };
  // #665: same zero-new-fetch substitution as reviewOneIssue's own pre-spend checkpoint above.
  const confirmPrompt = renderRolePrompt(confirmTemplate, currentIssue, deps.cfg, {
    "comments.digest": renderCommentDigest(cursorCheck.comments),
    "comments.digestCap": String(COMMENT_DIGEST_COUNT_CAP),
  });
  // The confirm pass shares the verification-plan-reviewer's own role config (model/effort/fallback) — #214
  // only introduces a distinct PROMPT (roles.verificationPlanReviewer.confirmPromptFile), not a distinct role.
  const reviewerRole = deps.cfg.roles.verificationPlanReviewer;

  const result = await runSessionWithRetry({
    runner: deps.runner,
    state: deps.state,
    session: {
      roleId: "verification-plan-reviewer-confirm",
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
    // #374 review (Codex sol-high verify-pass finding 3, P1): genuine confirm session failure
    // only — see escalate()'s own doc (reviewOneIssue, above) for the origin-tagging contract.
    degradePayload: (r) => ({
      round_id: roundId,
      issue: issue.number,
      reason: confirmDegradeReason(r, issue.number),
      origin: "session-failure",
    }),
    degradeMessage: (r) =>
      `[sapwood:plan-review] round ${roundId} issue #${issue.number} confirm: ${confirmDegradeReason(r, issue.number)}`,
    isValid: (r) => validateConfirmOutput(r.resultText ?? "", issue.number).ok,
    // #374: quota/429 parks instead of escalating needs-human — see envParked's check below.
    envFailure: envFailureHook(deps.cfg, deps.state),
  });
  if (result.envParked) {
    // #374: same stance as reviewOneIssue's reviewer/drafter branches — the engine parked
    // instead of escalating; this issue gets no confirm verdict THIS pass, it re-matches next
    // round (plan:approved is untouched either way).
    return true;
  }

  const validated: ConfirmValidation =
    result.outcome === "done"
      ? validateConfirmOutput(result.resultText ?? "", issue.number)
      : { ok: false, reason: `plan-confirm session failed twice (${result.outcome})` };

  if (!validated.ok) {
    // runSessionWithRetry already appended plan-review-escalated on its own second invalid/failed
    // attempt (same session-validity degrade shape as reviewOneIssue's reviewer branch) — only
    // the forge-visible half is still needed here.
    await escalateNeedsHuman(deps, issue, roundId, validated.reason, [
      `confirm: verification-plan-reviewer(confirm) session ${result.name} -> ${validated.reason}`,
    ]);
    return false;
  }

  if (validated.decision === "confirm") {
    // #652 round 2 (finding 1): "confirm" makes zero forge writes of its own, but returning
    // straight away IMPLICITLY preserves `plan:approved` against whatever the live body now is —
    // a body edit landing WHILE the confirm session ran would let a stale "still holds" verdict
    // stand against a body the session never saw. `currentBody` (top of this function) is the
    // exact body the confirm session was rendered from; recheck it against a fresh live read here,
    // the same body-drift discard the pre-apply/pre-drafter-write checkpoints already give the
    // approve/draft_request outcomes. On drift this escalates needs-human and discards the verdict
    // (the label/comment machinery already contains its own failure handling) rather than silently
    // letting the approval stand.
    const liveBodyPostConfirm = await deps.forge.getIssueBody(issue.number);
    if ((await checkGate0CommentCursor(deps, issue, roundId, "gate0-post-confirm", liveBodyPostConfirm, currentBody)).blocked) {
      return false;
    }
    return false; // zero forge writes — the plan still holds, nothing to do
  }

  // invalidate -> feed the SAME machinery an unadjudicated draft_request would (existing caps,
  // existing escalation) via reviewOneIssue's seed. The confirm session's BODY block IS the
  // brief (validateConfirmOutput already required it non-empty for "invalidate"). `currentBody`
  // (top of this function) is the exact body the confirm session was rendered from — threaded
  // through as `sessionInputBody` (#652 round 2 finding 1) so reviewOneIssue's own pre-apply
  // checkpoint can body-drift-compare the invalidate verdict too, not just a real reviewer
  // session's decision.
  return await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId, {
    decision: { decision: "draft_request", issue: issue.number, body: validated.body! },
    trailEntry: `confirm: verification-plan-reviewer(confirm) session ${result.name} -> invalidate`,
    sessionInputBody: currentBody,
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
      // #394 (F23): did THIS call actually dispatch at least one reviewer/confirm session? An
      // empty pool (poolMembers.length === 0 — the exact dogfood scenario this issue fixes) or a
      // pool consisting entirely of verifyNa/class-3 members never sets this true — see
      // PeripheralStub.ranSession's own doc.
      let ranSession = false;
      if (poolMembers.length > 0) {
        const reviewerTemplate = loadRolePromptTemplate(
          deps.cfg.roles.verificationPlanReviewer.promptFile,
          defaultVerificationPlanReviewerPromptPath(),
        );
        const drafterTemplate = loadRolePromptTemplate(
          deps.cfg.roles.verificationPlanDrafter.promptFile,
          defaultVerificationPlanDrafterPromptPath(),
        );
        const confirmTemplate = loadRolePromptTemplate(
          deps.cfg.roles.verificationPlanReviewer.confirmPromptFile,
          defaultVerificationPlanConfirmPromptPath(),
        );
        for (let i = 0; i < poolMembers.length; i++) {
          const issue = poolMembers[i]!;
          if (labelsInclude(issue.labels, l.verifyNa)) continue; // class 4: doc-gate path, untouched
          let sawEnvPark: boolean;
          if (!labelsInclude(issue.labels, l.planApproved)) {
            sawEnvPark = await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId); // class 1
            ranSession = true;
          } else if (approvedThisRound(deps.state, roundId, issue.number)) {
            continue; // class 3: skip, no session at all — nothing to observe
          } else {
            sawEnvPark = await confirmOneIssue(deps, issue, confirmTemplate, reviewerTemplate, drafterTemplate, roundId); // class 2
            ranSession = true;
          }
          // #374 review (Codex sol-high verify-pass finding 1, P1 — fixes a recovery canary
          // starvation the original finding-6 fix introduced): checked AFTER dispatching, never
          // BEFORE — the first (and every) pool member always gets a real attempt; only once
          // THIS PASS's own attempt comes back env-classified do the REMAINING members get
          // skipped. Gating on "a park row merely exists" (the original fix) would have let an
          // ARMED recovery round (round.ts's green-ping canary, which only arms the round to
          // open — it never clears the episode outright) skip every session before any of them
          // had a chance to prove recovery, wedging the engine parked forever (ping -> open ->
          // skip everything -> close still-parked -> ping again, ad infinitum).
          if (sawEnvPark) {
            (deps.log ?? console.error)(
              `[sapwood:plan-review] round ${roundId}: llm park active — skipping ${poolMembers.length - i - 1} ` +
                `remaining pool member(s) this pass`,
            );
            break;
          }
        }
      }
      return { marker: planReviewMarker(roundId), ranSession };
    },
  };
}
