// reviewer.ts — gate②: pluggable review verdict. Default = a fresh, different-model Codex
// review: trigger `@codex review`, poll reaction/review state, parse the verdict
// against a SPECIFIC head oid. Alternatives selectable via config (reviewer.mode):
// same-model-trusted (a named trusted-reviewer login must approve) and human (any non-author
// human approval). produce-pr-and-stop is NOT a reviewer kind — it's merge.mode
// (merge-driver.ts): whether the Conductor merges once gates pass, independent of who reviews.
//
// This implements the REVIEW HALF of gate②'s ACTION protocol — CI
// (gate①) is a separate, already-existing signal (forge.getPRStatus().ciGreen) folded in by
// merge-driver.ts, not duplicated here.
//
// SECURITY (producer != reviewer != merger): this module only ever *reads* review state and
// posts a plain PR comment (the trigger). It has no merge method and never will — merging is
// merge-driver.ts's alone, invoked only from the Conductor (conductor.ts), never a worker.

import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine, NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge, PRReview, PRReviewData, ReviewThreadSpan } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { CODEX_REVIEWER_LOGINS, normalizeLogin } from "../forge/trust.js";

export type ReviewAction =
  | "MERGE_OK" // fresh, non-author, accepted-state review on the CURRENT head
  | "WAIT_REVIEW" // nothing decisive yet (no review, or only a 👀-in-progress signal) — keep polling
  | "HANDLE_THREADS" // unresolved review threads on the PR — findings to address
  | "REVIEW_UNAVAILABLE"; // the review query itself failed (rate-limit/timeout/malformed) — MUST queue, never skip/soften gate②

export interface ReviewVerdict {
  action: ReviewAction;
  /** The head this verdict was computed against; null when REVIEW_UNAVAILABLE (no live data). */
  headOid: string | null;
  /** True only when an artifact can be attributed to the current trigger generation. */
  generationResponded?: boolean;
  /** True only when a trusted response establishes review coverage through this head. */
  coverageEstablished?: boolean;
}

/**
 * Legacy timestamp classifier for PR-level `+1` reactions. #273 deliberately removed
 * reactions from gate② because they cannot
 * carry a commit OID; this exported helper is retained on the public API surface
 * (engine/src/index.ts) and for unit coverage, not as a live gate② signal.
 * A reaction created at/before `cutoffIso` is stale: it predates the engine's review trigger,
 * so it cannot have been a response to it (#92, #55 P1-B). Compared NUMERICALLY (epoch ms),
 * not lexicographically (round-2 P2): the engine pin carries millisecond precision
 * (`...00.999Z`) while GitHub reaction timestamps are second-granularity (`...00Z`), and as
 * raw strings `"...00Z" > "...00.999Z"` — a same-second reaction that actually PREDATES the
 * trigger would have counted as fresh. Numeric compare truncates that same-second reaction to
 * `.000` and classifies it as stale.
 * An unparseable cutoff or createdAt never counts (fail-closed).
 */
export function freshThumbCount(reactions: { content: string; createdAt: string }[], cutoffIso: string): number {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return 0;
  return reactions.filter((r) => {
    if (r.content !== "+1") return false;
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) && t > cutoff;
  }).length;
}

/**
 * Non-author reviews whose `commitOid` equals the CURRENT `headOid`, restricted to
 * `acceptStates` (#101). A review left on
 * an older head does NOT count (a stale review must never look like a review of the current
 * head — the exact bypass gate② exists to close). Author self-review never counts
 * (producer != reviewer, even if the author is also a configured "trusted" login).
 */
export function freshHeadReviewCount(reviews: PRReview[], headOid: string, prAuthor: string, acceptStates: readonly string[]): number {
  return reviews.filter((r) => r.commitOid === headOid && r.author !== prAuthor && acceptStates.includes(r.state)).length;
}

/**
 * True if any non-author reviewer's STANDING state on the CURRENT head is CHANGES_REQUESTED —
 * a blocking signal (Codex PR #42 P1): an accepted review followed by a later
 * CHANGES_REQUESTED on the same head must NOT yield MERGE_OK. GitHub semantics: a change
 * request stands until the SAME reviewer later APPROVES (a mere COMMENTED does not clear it),
 * or the review is dismissed (its state then reads DISMISSED, so it never matches here).
 * Computed over ALL reviews, not just allowlisted reviewers' — anyone requesting changes
 * blocks the autonomous path (fail-safe; a human triages the disagreement). Relies on the
 * reviews array being in submission order (gh returns them chronologically).
 */
export function changesRequestedOnHead(reviews: PRReview[], headOid: string, prAuthor: string): boolean {
  const standing = new Map<string, boolean>(); // author -> has an un-cleared change request
  for (const r of reviews) {
    if (r.commitOid !== headOid || r.author === prAuthor) continue;
    if (r.state === "CHANGES_REQUESTED") standing.set(r.author, true);
    else if (r.state === "APPROVED") standing.set(r.author, false); // same reviewer re-approved
  }
  return [...standing.values()].some(Boolean);
}

export interface ReviewSignals {
  hasEyesReaction: boolean;
  freshApprovingReviews: number;
  /** Legacy field name: OID-bound clean comments from trusted reviewers. Reactions never
   *  satisfy gate② because they cannot state which commit was reviewed (#273). */
  freshTrustedThumbs: number;
  unresolvedThreads: number;
  /** A standing CHANGES_REQUESTED on the current head (see changesRequestedOnHead). */
  changesRequestedOnHead: boolean;
}

/**
 * Pure ACTION derivation from review signals — the review-only half of gate②'s ACTION
 * protocol (CI-flavored actions live in merge-driver.deriveGate, which folds in gate①
 * separately). Fail-safe ordering: unresolved findings / a standing change request outrank an
 * approval signal (Codex PR #42 P1 — approve-then-changes-requested must block); "nothing yet"
 * (no review, no 👀) is WAIT_REVIEW, never a silent MERGE_OK.
 */
export function deriveReviewAction(s: ReviewSignals): ReviewAction {
  if (s.unresolvedThreads > 0 || s.changesRequestedOnHead) return "HANDLE_THREADS";
  if (s.freshApprovingReviews > 0 || s.freshTrustedThumbs > 0) return "MERGE_OK";
  return "WAIT_REVIEW"; // covers both "👀 in progress" and "nothing yet" — both mean keep polling
}

/** The ENGINE-recorded review-trigger pin (PR #55 P1-B) — the artifact freshness cutoff.
 *  Sourced from state.ts's workers.review_triggered_head/at, threaded in by merge-driver.ts's
 *  driveOne (which is the only place that knows BOTH the pin and the live current head). `head`
 *  is the head oid the LAST trigger was posted for; `at` is the engine wall-clock ISO timestamp
 *  it was posted at. Either null means "no trigger recorded for this lane yet" — comments
 *  cannot count in that case (fail-closed), matching a lane whose first trigger hasn't fired. */
export interface ReviewTriggerPin {
  head: string | null;
  at: string | null;
  generation?: number;
  ambiguous?: boolean;
  deltaChain?: number;
  inFlight?: boolean;
  /** Latest head with generation-attributable trusted review coverage. */
  coveredHead?: string | null;
}

export interface ReviewTriggerContext {
  head: string;
  /** The prior trigger's OID for a delta-scoped review; null requests the full PR diff. */
  baseHead: string | null;
}

/** The pluggable review-gate seam. Read-only + comment-only; no merge method (structural
 *  producer != reviewer != merger — see module header). merge-driver.ts owns the one impure
 *  read (forge.getPRReviewData) and its failure handling (-> REVIEW_UNAVAILABLE), so
 *  verdictFromData is PURE and unit-testable with no async/mocks. */
export interface Reviewer {
  readonly kind: "different-model-codex" | "same-model-trusted" | "human";
  /** Post the review trigger (e.g. `@codex review`). A no-op for modes with no bot to ping
   *  (same-model-trusted, human) — those wait for an out-of-band review to land. `issue` is the
   *  driving lane's issue number (#46, Decision #8): a reviewer that pings a bot uses it to pull
   *  the issue's verification plan into the trigger, so gate② re-checks the PR against it. */
  triggerReview(forge: IForge, pr: number, issue: number, context?: ReviewTriggerContext): Promise<void>;
  /** This tick's verdict from ALREADY-FETCHED review data (merge-driver.ts fetches it fresh
   *  every call against the LIVE current head — never a cached one; a review of a stale head
   *  counts as no review, #101, since freshHeadReviewCount filters on data.headOid). `pin` (#55
   *  P1-B) is the engine-recorded trigger pin for this lane; omitted/undefined behaves like
   *  {head: null, at: null} — no comment can count (fail-closed), same as a lane never triggered. */
  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict;
}

/**
 * Build the review-trigger comment body (#46, Decision #8): `triggerCommand` (default
 * `@codex review`, #156 reviewer.triggerCommand) plus the issue's verification plan, so gate②
 * re-checks the finished PR against the SAME plan the `Ready` gate required at dispatch
 * (getReadyIssues / hasVerificationPlan) — until now gate② only checked "fresh non-author
 * review + CI", not plan conformance. `planText` null (no extractable
 * Verification/Acceptance section — e.g. a verify:n/a issue, or a malformed body) still gets an
 * EXPLICIT fallback sentence, never a silently plan-less trigger.
 *
 * `doctrine` (#167) is this repo's review-doctrine text — technical invariants + adjudication
 * doctrine, same content injected into the worker brief and architect pass (doctrine.ts) —
 * appended AFTER the verification plan so the reviewing bot's attention is aimed at historical
 * failure zones on top of this PR's own acceptance criteria. Omitted/null/empty -> nothing is
 * appended, byte-for-byte the pre-#167 comment. The NO_DOCTRINE-never-leaks invariant (a public
 * PR comment must not carry doctrine.ts's internal placeholder sentence) is enforced at BOTH
 * ends — defense in depth (#177 review, Codex P2): the construction boundary
 * (makeReviewer/makeFallbackReviewers' loadReviewDoctrine maps the placeholder to `undefined`
 * before constructing a CodexReviewer) AND structurally here — a `doctrine` value equal to
 * NO_DOCTRINE itself is treated exactly like undefined/null, so a future caller that forgets
 * the boundary mapping still cannot leak the placeholder into a posted comment. Still pure:
 * NO_DOCTRINE is a module constant, not I/O.
 * Pure + exported so the shape is unit-testable without a fake IForge.
 */
export function buildReviewTriggerComment(
  issue: number,
  planText: string | null,
  triggerCommand: string = "@codex review",
  doctrine?: string | null,
  context?: ReviewTriggerContext,
): string {
  const instruction = planText
    ? `Verify this PR against issue #${issue}'s verification plan below:\n\n${planText}`
    : `No extractable verification plan was found on issue #${issue} — review this PR on its own merits.`;
  const doctrineBlock =
    doctrine && doctrine !== NO_DOCTRINE
      ? `\n\nThis repo's review doctrine — historical failure classes and adjudication guidance to keep in mind while reviewing:\n\n${doctrine}`
      : "";
  const scopeBlock = context
    ? context.baseHead
      ? `\n\nReview only the commit delta ${context.baseHead}..${context.head}. The verdict must bind to the new head ${context.head}.`
      : `\n\nReview the full PR diff at head ${context.head}.`
    : "";
  // #273 live verification (#278): request the assertion in the bot's own NATIVE dialect —
  // "Reviewed commit:" is the line Codex already emits unprompted; asking for a custom
  // "Reviewed head OID:" label was ignored by the live bot. The parser accepts both labels.
  const identityBlock = context ? `\n\nState the commit you reviewed in your response as: Reviewed commit: ${context.head}` : "";
  return `${triggerCommand}\n\n${instruction}${doctrineBlock}${scopeBlock}${identityBlock}`;
}

// ── #282 (M10, E1): ReviewerAdapter seam — first-class approval/blocking split ──────────────────
//
// Design #279 §1: today's `verdictFrom` (below) conflates two independent halves into one
// ReviewAction — "does this PR have anything BLOCKING it" (unresolved threads / a standing
// change request) and "has an approving signal arrived" (a fresh accepted-state review / an
// OID-bound clean comment, #273). The upcoming engine-agent reviewer kind (a static LLM review
// session) can only ever speak to the SECOND half — it has no visibility into live
// thread-resolution state, and must never be trusted to derive blocking itself (that stays
// engine-side, over live PRReviewData, for every kind alike, so a compromised/hallucinating
// review session cannot manufacture "nothing is blocking this"). This section introduces that
// split as a NEW, additive seam: `ApprovalResult`/`ReviewerAdapter`/`deriveBlockingSignal`.
//
// The existing `Reviewer`/`ReviewVerdict`/`verdictFromData` surface (above/below) is UNCHANGED
// in TYPE and in the outcomes it produces — merge-driver.ts's whole drive-loop state machine
// (trigger pins, fallback failover, generation tracking, #273's OID-bound coverage) keeps
// consuming it exactly as before; only `verdictFrom`'s OWN internals are refactored to route
// through the shared blocking function and a shared approval-only helper (mechanical extract,
// zero behavior change — see reviewer.test.ts's regression-pin suite comparing both paths over
// the existing fixture corpus). Wiring the drive loop itself onto `ReviewerAdapter` end-to-end —
// including reconciling #273's generation-tracking fields, which `ApprovalResult` deliberately
// does not model — is left to the follow-up engine-agent integration issue; forcing that here
// would trade this issue's "mechanical, zero behavior change" mandate for a much larger,
// harder-to-verify diff across a security-relevant state machine.

/** A validated review finding — the shape an engine-agent review session's structured output is
 *  validated INTO before it can ever reach a `rejected` ApprovalResult (design #279 §1: "the
 *  session never chooses outcomes" — `rejected` is engine-derived from a validated array, never
 *  trusted prose). Minimal from day one (#282); the engine-agent issue extends it with per-AC
 *  snapshot IDs (design #279 §5) without another migration, since callers already narrow through
 *  `isFinding`/`validateFindings` rather than casting a session's raw output. */
export interface Finding {
  /** Stable identifier for this finding within one review (e.g. an ordinal, or the session's own
   *  numbering) — never a free-text label, so downstream dedup/audit keys off it, not prose. */
  id: string;
  /** Human-readable finding body (the actual review comment text). Non-empty (see isFinding). */
  body: string;
}

/** Runtime shape guard for a single `Finding` — `rejected`'s findings array is validated
 *  ELEMENT-WISE at construction (never cast), so a malformed/partial object from an untrusted
 *  producer (a future engine-agent session's structured output) can never silently become a
 *  blocking verdict with a missing id/body. */
export function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.id === "string" && f.id.length > 0 && typeof f.body === "string" && f.body.length > 0;
}

/** Validates an ENTIRE findings array (design #279 §1: "validated findings -> FIXABLE path").
 *  An empty array is valid (see ApprovalResult's own doc — zero findings is `approved`, never
 *  "rejected with nothing to say"); any non-Finding element fails the WHOLE array (fail-closed: a
 *  single malformed entry must not silently drop just itself and understate what was found). */
export function validateFindings(v: unknown): v is Finding[] {
  return Array.isArray(v) && v.every(isFinding);
}

/** Evidence attached to an `approved` ApprovalResult (design #279 §1) — WHICH counted signals
 *  satisfied gate②'s approval half, for the audit trail. Deliberately just the two counts
 *  `verdictFrom` already derives (`freshHeadReviewCount` / #273's OID-bound clean comments): the
 *  decisive fact is already the discriminant (`kind: "approved"`); this is provenance, not
 *  another verdict input. At least one field is > 0 for every `approved` result.
 *  Intentionally NOT redesigned for a future engine-agent kind's richer, per-source evidence
 *  (e.g. session transcript ref, model identity) — that shape is deferred to #286 (E4a); this
 *  interface may grow additional optional fields there without breaking the two existing counts. */
export interface ApprovalEvidence {
  /** Fresh, accept-state, non-author reviews on the current head (see freshHeadReviewCount). */
  freshApprovingReviews: number;
  /** Fresh, OID-bound, trusted clean comments (#273, see freshTrustedCleanComments below). */
  freshTrustedSignals: number;
  /** #286 (E4a, design #279 §2): the first optional field this interface grows past its original
   *  two GitHub-review-shaped counts — engine-agent's own approval evidence. Every AC-manifest id
   *  whose perAC status was `claim-accepted` (review/agent-output.ts's AgentReviewOutput) — the
   *  agent found no code-verifiable evidence (no named, substantive, non-skipped test on the
   *  discovery path, design #279 §4.1) but accepted the claim anyway (e.g. a doc/config change
   *  with no natural test). Recorded here so an approval carries an explicit, auditable trail of
   *  WHICH criteria were taken on trust rather than confirmed — never silently indistinguishable
   *  from a fully-confirmed approval. Absent/undefined for every GitHub-review-based kind
   *  (Codex/human/same-model-trusted never populate this) and for an engine-agent approval with
   *  zero claim-accepted entries — an empty/absent list is NOT itself a signal (see
   *  deriveApprovalResult, review/agent-output.ts). NOTE: this is the one documented exception to
   *  this interface's own "approved" doc note ("at least one field is > 0") — an engine-agent
   *  approval where every AC was `confirmed` (never `claim-accepted`) legitimately has BOTH
   *  numeric fields at 0 and this array absent; the decisive fact for that kind is "zero findings
   *  AND every AC accounted for," which the two GitHub-review-shaped counts above were never
   *  designed to express. */
  unreproducedClaims?: string[];
}

/**
 * The approval-side verdict a `ReviewerAdapter` returns — deliberately BLOCKING-BLIND (design
 * #279 §1): "Blocking derivation stays engine-side over live PRReviewData; adapters return
 * approval-side results only." A `ReviewerAdapter` never sees unresolved-thread counts or
 * standing-CHANGES_REQUESTED state; the caller combines this with `deriveBlockingSignal`'s own
 * output (blocking always wins — the same fail-safe ordering `deriveReviewAction` already
 * enforces above) before deriving a final ReviewAction/Gate.
 *
 *  - `approved` REQUIRES zero findings — encoded in the TYPE, not just a runtime check a caller
 *    might skip: the optional `findings?: never` field means only OMITTING it type-checks, so
 *    "approved with findings" is not representable (#282 review round 2, adopted P2 — verified
 *    with a temporary probe under `tsc --noEmit`'s checked set; reviewer.test.ts itself is
 *    EXCLUDED from that command by engine/tsconfig.json and runs under tsx, transpile-only, so a
 *    `@ts-expect-error` inside it would never actually be re-checked by CI and is deliberately
 *    NOT used there — see that test's own comment).
 *  - `rejected` carries a VALIDATED (see validateFindings), NON-EMPTY findings array — the tuple
 *    type `[Finding, ...Finding[]]` means "rejected with zero findings" is likewise not
 *    representable (#282 review round 2, adopted P2: a rejection with nothing to say is a
 *    contradiction in terms). The ONLY variant merge-driver maps onto the existing
 *    HANDLE_THREADS -> FIXABLE lane (design #279 §1); the session that produced them never chose
 *    the outcome, only supplied the findings. The symmetric `evidence?: never` mirrors
 *    `approved`'s own field-exclusion pattern (a rejection carries no approval evidence).
 *  - `pending` — nothing decisive yet (no approving artifact arrived); the caller keeps polling.
 *  - `unavailable` — the adapter itself could not produce a verdict this tick (e.g. an
 *    engine-agent session/materialize failure, design #279 §6); `headOid` may be null when not
 *    even that much is known (mirrors ReviewVerdict.headOid's own null-on-failure contract).
 */
export type ApprovalResult =
  | { kind: "approved"; headOid: string; evidence: ApprovalEvidence; findings?: never }
  | { kind: "rejected"; headOid: string; findings: [Finding, ...Finding[]]; evidence?: never }
  | { kind: "pending"; headOid: string }
  | { kind: "unavailable"; headOid: string | null; reason: string };

/** Everything a `ReviewerAdapter`'s two methods need, bundled ONE way (design #279 §1's sketch
 *  shows both `trigger`/`evaluate` taking a single `ReviewContext`) — `trigger` reads only
 *  `forge`/`pr`/`issue`/`triggerContext` (the SAME parameters `Reviewer.triggerReview` already
 *  takes positionally); `evaluate` reads only `data`/`pin` (same as `Reviewer.verdictFromData`).
 *  Each method simply ignores the half of the context it has no use for — the caller (a future
 *  driveOne-equivalent) always populates both halves together, same call site shape as today. */
export interface ReviewContext {
  forge: IForge;
  pr: number;
  issue: number;
  /** Delta-scoping for the trigger comment (see ReviewTriggerContext) — used by `trigger` only. */
  triggerContext?: ReviewTriggerContext;
  /** Live review data for THIS tick — used by `evaluate` only. */
  data?: PRReviewData;
  /** The engine-recorded trigger pin (see ReviewTriggerPin) — used by `evaluate` only. */
  pin?: ReviewTriggerPin;
  /** #287 (E4b, #303 review round 2 P1): the ENGINE-SUPPLIED diff text (design #279 §1: "the
   *  review object is the engine-supplied diff") — for the engine-agent kind, this is the EXACT
   *  text `review/drive.ts`'s `resolveIdentity` hashed into the WAL-pinned diff hash D. An
   *  adapter that live-fetches its own diff (e.g. via `ctx.forge.getPRDiff`) could review bytes
   *  that differ from D if a push lands between WAL persist and the adapter's own fetch — this
   *  field closes that gap by making the diff a CALLER-SUPPLIED input, never a second read the
   *  adapter performs itself. `EngineAgentReviewer.evaluate` requires this (undefined ⇒
   *  `unavailable`, fail closed) and never calls `getPRDiff`. Optional/unused by every other
   *  `ReviewerAdapter` kind (Codex/human/same-model-trusted have no session to feed a diff into). */
  diffText?: string;
}

/** The approval-only half of the pluggable review-gate seam (design #279 §1) — a `Reviewer`
 *  (below) additionally implements this so a future engine-agent kind can slot in alongside the
 *  three existing kinds through the SAME shape, without merge-driver.ts's drive loop needing a
 *  kind-specific branch. Read-only + comment-only, same producer != reviewer != merger posture as
 *  `Reviewer` (module header) — `evaluate` never mutates anything and never derives blocking;
 *  that stays with `deriveBlockingSignal` (below), consumed by every kind alike. */
export interface ReviewerAdapter {
  readonly kind: ReviewerKind;
  /** Post the review trigger, or no-op for a kind with no bot to ping. Identical contract to
   *  `Reviewer.triggerReview`, just bundled into one context object. */
  trigger(ctx: ReviewContext): Promise<void>;
  /** This tick's APPROVAL-ONLY verdict — never blocking-aware (see ApprovalResult's own doc).
   *  Async because a future engine-agent kind's evaluate() spawns a real review session; the
   *  three existing kinds resolve synchronously under the hood and simply wrap that result in an
   *  already-settled Promise (see e.g. CodexReviewer.evaluate below). */
  evaluate(ctx: ReviewContext): Promise<ApprovalResult>;
}

/** The blocking half of gate②'s ACTION derivation (design #279 §1), lifted out of `verdictFrom`
 *  into ONE shared, pure, engine-side function every kind's verdict computation routes through —
 *  the SAME "unresolved threads OR a standing CHANGES_REQUESTED" signals `deriveReviewAction`
 *  already treats as fail-safe-first (a blocking signal outranks any approval, Codex PR #42 P1),
 *  now computed directly from live `PRReviewData` in ONE place rather than re-derived ad hoc.
 *  No `ReviewerAdapter` ever computes this itself (see ReviewerAdapter's own doc) — a future
 *  engine-agent kind's `evaluate()` is blocking-blind by construction; this function is the ONLY
 *  blocking authority, called once per tick regardless of which reviewer kind is active. */
export interface BlockingSignal {
  blocked: boolean;
  unresolvedThreads: number;
  changesRequestedOnHead: boolean;
  /** #378 (F14): how many of the PR's unresolved threads were EXCLUDED from `unresolvedThreads`
   *  as already-adjudicated re-raises (see adjudicatedDuplicateThreads). 0 whenever the data to
   *  decide that is absent. Carried so the exclusion is auditable — a filter that silently
   *  shrinks gate② input would be exactly the kind of invisible weakening this repo's doctrine
   *  refuses; merge-driver.ts puts this number in the FIXABLE outcome's reason. */
  adjudicatedDuplicates: number;
}

/** #378 (F14): the key an adjudication decision is made on — WHICH finding (`findingDigest`) at
 *  WHICH span (`path` plus the line the thread targets). `line` is null once GitHub marks a
 *  thread outdated, so `originalLine` is the fallback.
 *
 *  The digest is part of the key, not decoration, and leaving it out was a real defect (found by
 *  the engine-agent review of PR #445): a span alone is NOT a finding identity. Two entirely
 *  unrelated findings can land on the same file:line — "missing required key `foo`" adjudicated
 *  in round 1, "wrong indentation" raised fresh in round 2 on the same still-current line — and
 *  a span-only key would treat the second as a duplicate of the first and silently subtract a
 *  REAL, never-adjudicated finding from the blocking count. That is a gate weakening, not a
 *  saved fix round.
 *
 *  Any missing component -> null, i.e. NOT keyable: a file-level or PR-level thread, or one whose
 *  originating comment could not be read, can never be matched against a prior adjudication and
 *  therefore can never be filtered. */
function threadAdjudicationKey(t: ReviewThreadSpan): string | null {
  const line = t.line ?? t.originalLine;
  return t.path && line != null && t.findingDigest ? `${t.path}:${line}:${t.findingDigest}` : null;
}

/**
 * #378 (F14): the unresolved threads that are RE-RAISES of an already-adjudicated finding —
 * dogfood run 2026-07-24, PR #366: the same config-YAML finding was raised five times after it
 * had been human-adjudicated, thread-resolved, and its remedy merged elsewhere (PR #367). Each
 * re-flag re-entered the FIXABLE gate and burned a fix-round evaluation.
 *
 * The match is NOT by thread id, and that is the whole point: a re-raised finding comes back as a
 * BRAND-NEW review thread with a new id, so "is this thread id in the resolved set" answers no
 * every single time — which is precisely why the loop kept paying for it. What identifies a
 * re-raise is that the SAME finding lands on the SAME span as a thread that was already resolved
 * and whose code has not moved since. Both halves of that key are load-bearing: span alone is not
 * a finding identity (two unrelated findings can share a line), and finding text alone is not a
 * location (the same class of finding at a different site is a different finding).
 *
 * A thread is treated as an adjudicated duplicate only when ALL of these hold:
 *  - it is unresolved and not itself outdated (an outdated thread's span already moved);
 *  - it has a complete key — path + line + a readable finding digest (see
 *    threadAdjudicationKey); anything missing makes it unfilterable;
 *  - some RESOLVED thread carries the IDENTICAL key and is NOT outdated, i.e. GitHub itself still
 *    anchors that resolved thread to the current diff, so the code it was adjudicated against is
 *    unchanged. A resolved thread whose span DID change reads as outdated and is deliberately
 *    excluded from the adjudicated set — its re-raise is then genuinely fresh signal and keeps
 *    blocking, which is the always-blocking invariant this filter must not weaken.
 *
 * Everything degrades toward BLOCKING: no thread data at all (`data.threads` absent — every
 * pre-#378 fixture and forge fake), unknown staleness (parseReviewThreadsPage reads a missing
 * `isOutdated` as true), an unreadable finding body, or an unkeyable span all yield zero
 * duplicates and therefore the exact pre-#378 count.
 */
export function adjudicatedDuplicateThreads(data: PRReviewData): ReviewThreadSpan[] {
  const threads = data.threads;
  if (!threads?.length) return [];
  const adjudicated = new Set<string>();
  for (const t of threads) {
    if (!t.isResolved || t.isOutdated) continue;
    const key = threadAdjudicationKey(t);
    if (key) adjudicated.add(key);
  }
  if (adjudicated.size === 0) return [];
  return threads.filter((t) => {
    if (t.isResolved || t.isOutdated) return false;
    const key = threadAdjudicationKey(t);
    return key !== null && adjudicated.has(key);
  });
}

/**
 * #378 (F14): reviews EXCLUDED from gate②'s input because they were submitted against a head
 * that is no longer the PR's head — the "review submitted against a non-current head is
 * advisory, never gate input" half of the issue.
 *
 * This adds NO new filtering: both halves of the gate already bind to the current head —
 * `freshHeadReviewCount` counts only `commitOid === headOid` for the approval signal, and
 * `changesRequestedOnHead` skips `commitOid !== headOid` for the blocking signal — so a stale
 * review can neither block nor unblock today. What was missing is that the exclusion was
 * INVISIBLE: PR #366 took two of its five duplicate re-flags against a stale head with nothing
 * in the audit trail saying so. This function makes the count observable (merge-driver.ts puts
 * it in the FIXABLE reason) and gives the always-advisory property a regression pin instead of
 * leaving it as an emergent consequence of two independent filters.
 */
export function staleHeadReviewCount(reviews: PRReview[], headOid: string): number {
  return reviews.filter((r) => r.commitOid !== headOid).length;
}

export function deriveBlockingSignal(data: PRReviewData): BlockingSignal {
  const changesRequested = changesRequestedOnHead(data.reviews, data.headOid, data.author);
  // #378: adjudicated re-raises come OFF the count before it reaches deriveReviewAction, so they
  // never route the lane into another FIXABLE fix round. Never below zero: `unresolvedThreads` is
  // the authoritative paged total and `threads` can be a partial view of it (page ceiling).
  const duplicates = adjudicatedDuplicateThreads(data).length;
  const unresolvedThreads = Math.max(0, data.unresolvedThreads - duplicates);
  return {
    blocked: unresolvedThreads > 0 || changesRequested,
    unresolvedThreads,
    changesRequestedOnHead: changesRequested,
    adjudicatedDuplicates: duplicates,
  };
}

/**
 * Verdict core. `countableReview` restricts WHOSE reviews may satisfy gate② (Codex PR #42 P1:
 * in codex mode, a review from any random non-author account must NOT count — only the Codex
 * bot / configured allowlist). The BLOCKING signals are deliberately un-filtered: a standing
 * change request from ANYONE blocks (changesRequestedOnHead reads all reviews), and unresolved
 * threads always block — the filter can only shrink what approves, never what blocks.
 */
/**
 * #273 supersedes the #55 trusted-thumb path: a reaction has no body in which to assert the
 * reviewed commit OID, so it is never a gate② artifact. Keep this seam explicitly returning
 * zero so no reviewer mode can accidentally resurrect reaction-based approval.
 */
function freshTrustedThumbCount(): number {
  return 0;
}

/**
 * Codex's clean verdict is sometimes a plain conversation COMMENT ("Codex Review: Didn't find
 * any major issues") with NO review object (post-#55 P2). #273 requires every such comment to
 * carry at least one OID assertion, ALL of which must match the current head. A single-pass
 * classifier quarantines quoted lines without rewriting them; BOTH phrase and OID parsing see
 * only clean lines.
 *
 * Live-verified against the REAL bot output (#278, 2026-07-19/21): Codex appends flavor prose
 * to the canonical phrase on the SAME line ("… major issues. Can't wait for the next one!"),
 * so the phrase is anchored at line START (0-3 space indent, optional emphasis) with trailing
 * prose permitted — mid-prose embeddings ("The phrase … would be wrong") still fail the
 * anchor, and inline-code negations still fail the caller's no-backtick line guard.
 */
export const CLEAN_VERDICT_RE = /^ {0,3}[*_]*Codex Review: Didn't find any major issues\b/i;
/**
 * Reviewed-commit assertion line. Live-verified (#278): the bot's NATIVE format is
 * `**Reviewed commit:** `cdee61ce5c`` — its own label ("Reviewed commit:"), markdown bold,
 * a backticked ABBREVIATED (10-hex) OID — and the bot does NOT echo the trigger's requested
 * custom "Reviewed head OID:" wording. Accept both labels, tolerate emphasis/backtick
 * decoration, and capture the value; matching semantics live in oidAssertionMatchesHead
 * (exact equality, or a >=7-hex abbreviated prefix of the head).
 */
export const REVIEWED_HEAD_OID_RE = /^ {0,3}[*_]*Reviewed (?:commit|head OID):[*_]*\s*`?([^\s`]+)`?\s*[*_]*$/i;

/** True when one asserted OID identifies `head`: byte equality (legacy/full form), or — the
 *  bot's native abbreviated form — a case-insensitive hex prefix of at least 7 chars (git's
 *  own minimum abbreviation floor; #278's live bot emits 10). A non-hex or too-short
 *  assertion never prefix-matches (fail-closed); it can only count via exact equality. */
export function oidAssertionMatchesHead(asserted: string, head: string): boolean {
  if (asserted === head) return true;
  if (asserted.length < 7 || !/^[0-9a-f]+$/i.test(asserted)) return false;
  return head.toLowerCase().startsWith(asserted.toLowerCase());
}

function cleanReviewCommentLines(body: string): string[] {
  const clean: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  let inHtmlComment = false;
  let inLazyBlockquote = false;
  for (const line of body.split(/\r?\n/)) {
    // Precedence is fence -> HTML comment -> blockquote; quarantined lines are never rewritten.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      const marker = fenceMatch?.[1];
      if (marker?.startsWith(fence.char) && marker.length >= fence.length && fenceMatch?.[2]?.trim() === "") fence = null;
      continue;
    }
    const marker = fenceMatch?.[1];
    if (marker) {
      fence = { char: marker[0] as "`" | "~", length: marker.length };
      continue;
    }

    let htmlCursor = 0;
    let htmlQuarantined = inHtmlComment;
    while (htmlCursor <= line.length) {
      if (inHtmlComment) {
        const close = line.indexOf("-->", htmlCursor);
        if (close < 0) break;
        inHtmlComment = false;
        htmlCursor = close + 3;
      } else {
        const open = line.indexOf("<!--", htmlCursor);
        if (open < 0) break;
        htmlQuarantined = true;
        inHtmlComment = true;
        htmlCursor = open + 4;
      }
    }
    if (htmlQuarantined) continue;

    if (/^ {0,3}>/.test(line)) {
      inLazyBlockquote = true;
      continue;
    }
    if (inLazyBlockquote) {
      if (line.trim() !== "") continue;
      inLazyBlockquote = false;
    }
    clean.push(line);
  }
  return clean;
}

function assertedHeadOids(cleanLines: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const line of cleanLines) {
    const match = REVIEWED_HEAD_OID_RE.exec(line);
    if (match?.[1]) values.add(match[1]);
  }
  return values;
}

function freshTrustedCleanComments(data: PRReviewData, trustedLogin?: (login: string) => boolean, pin?: ReviewTriggerPin): number {
  if (!trustedLogin || !pin?.at || pin.head !== data.headOid) return 0;
  const cutoff = Date.parse(pin.at);
  if (!Number.isFinite(cutoff)) return 0;
  const author = normalizeLogin(data.author);
  return (data.comments ?? []).filter((c) => {
    const createdAt = Date.parse(c.createdAt);
    const cleanLines = cleanReviewCommentLines(c.body);
    const statedOids = assertedHeadOids(cleanLines);
    // At least one assertion, and EVERY assertion must identify the current head (a comment
    // that also asserts any other commit is discarded unconditionally — #273 mismatch rule).
    // Multiple assertions that all match are fine: the live bot emits its native abbreviated
    // line, and a future compliant response could echo the full OID alongside it.
    const oidMatches = statedOids.size > 0 && [...statedOids].every((oid) => oidAssertionMatchesHead(oid, data.headOid));
    return (
      normalizeLogin(c.login) !== author &&
      trustedLogin(normalizeLogin(c.login)) &&
      Number.isFinite(createdAt) &&
      createdAt > cutoff &&
      cleanLines.some((line) => !line.includes("`") && CLEAN_VERDICT_RE.test(line)) &&
      oidMatches
    );
  }).length;
}

/** #282 (M10, E1): the approval-only half of `verdictFrom` (below), extracted so a
 *  `ReviewerAdapter.evaluate()` implementation (see e.g. CodexReviewer.evaluate) can produce the
 *  SAME `ApprovalEvidence` counts without duplicating `verdictFrom`'s own computation — the two
 *  are regression-pinned against each other in reviewer.test.ts over the existing fixture corpus.
 *  Returns `countable` too so `verdictFrom` doesn't re-filter `data.reviews` a second time for
 *  its own `currentGenerationFormalResponse` computation below. NEVER touches blocking signals
 *  (unresolved threads / changesRequestedOnHead) — see deriveBlockingSignal, computed separately
 *  and always by the caller. */
function computeApprovalSignal(
  data: PRReviewData,
  acceptStates: readonly string[],
  countableReview?: (r: PRReview) => boolean,
  trustedReactionLogin?: (login: string) => boolean,
  pin?: ReviewTriggerPin,
): { evidence: ApprovalEvidence; countable: PRReview[] } {
  const countable = countableReview ? data.reviews.filter(countableReview) : data.reviews;
  const fresh = freshHeadReviewCount(countable, data.headOid, data.author, acceptStates);
  const freshTrustedSignals = freshTrustedThumbCount() + freshTrustedCleanComments(data, trustedReactionLogin, pin);
  return { evidence: { freshApprovingReviews: fresh, freshTrustedSignals }, countable };
}

function verdictFrom(
  data: PRReviewData,
  acceptStates: readonly string[],
  countableReview?: (r: PRReview) => boolean,
  trustedReactionLogin?: (login: string) => boolean,
  pin?: ReviewTriggerPin,
): ReviewVerdict {
  const { evidence, countable } = computeApprovalSignal(data, acceptStates, countableReview, trustedReactionLogin, pin);
  // #282: the blocking half now routes through the ONE shared engine-side function every kind
  // consumes (deriveBlockingSignal, above) instead of an inline changesRequestedOnHead call —
  // same value, computed once, reused below for currentHeadChangesRequested too.
  const blocking = deriveBlockingSignal(data);
  const action = deriveReviewAction({
    hasEyesReaction: data.reactions.some((r) => r.content === "eyes"),
    freshApprovingReviews: evidence.freshApprovingReviews,
    // Legacy field name; only OID-bound clean comments reach this signal (#273).
    freshTrustedThumbs: evidence.freshTrustedSignals,
    unresolvedThreads: blocking.unresolvedThreads,
    changesRequestedOnHead: blocking.changesRequestedOnHead,
  });
  const cutoff = pin?.at == null ? NaN : Date.parse(pin.at);
  const currentGenerationFormalResponse =
    pin?.head === data.headOid &&
    Number.isFinite(cutoff) &&
    countable.some((r) => {
      const submittedAt = r.submittedAt == null ? NaN : Date.parse(r.submittedAt);
      return r.commitOid === pin.head && r.author !== data.author && Number.isFinite(submittedAt) && submittedAt > cutoff;
    });
  return {
    action,
    headOid: data.headOid,
    generationResponded: currentGenerationFormalResponse || blocking.changesRequestedOnHead || evidence.freshTrustedSignals > 0,
    coverageEstablished: currentGenerationFormalResponse || evidence.freshTrustedSignals > 0,
  };
}

/** Default reviewer: triggers `@codex review`; an accepted verdict is a
 *  COMMENTED-or-APPROVED review on the current head (Codex's normal review state is COMMENTED,
 *  not APPROVED) from the CODEX BOT or a
 *  configured trusted login — never from an arbitrary non-author account (Codex PR #42 P1:
 *  gate② is "a fresh different-model review", so the reviewer identity is part of the gate). */
export class CodexReviewer implements Reviewer, ReviewerAdapter {
  readonly kind = "different-model-codex" as const;
  private static readonly ACCEPT = ["COMMENTED", "APPROVED"] as const;
  private readonly allowedLogins: string[];

  /** `extraTrustedLogins` (cfg.reviewer.trustedReviewers) extends — never replaces — the
   *  Codex bot's own login. `triggerCommand` (cfg.reviewer.triggerCommand, #156) is the posted
   *  trigger-comment text; default matches today's hardcoded `@codex review` byte-for-byte.
   *  `doctrine` (cfg.doctrine, #167) is this repo's ALREADY-LOADED review-doctrine text (or
   *  `undefined` when none is adopted) — loaded once by the caller (makeReviewer /
   *  makeFallbackReviewers) the SAME way triggerCommand is resolved from cfg once at
   *  construction, never re-loaded per trigger. */
  constructor(
    extraTrustedLogins: readonly string[] = [],
    private readonly triggerCommand: string = "@codex review",
    private readonly doctrine?: string,
  ) {
    this.allowedLogins = [...CODEX_REVIEWER_LOGINS, ...extraTrustedLogins].map(normalizeLogin);
  }

  async triggerReview(forge: IForge, pr: number, issue: number, context?: ReviewTriggerContext): Promise<void> {
    // A body-fetch hiccup (rate-limit/timeout) must not block the trigger itself — gate②
    // still has to fire; it just falls back to the explicit "no plan" text below rather than
    // silently retrying forever or skipping the comment (#46 Decision #8: the trigger always
    // posts, never a swallowed no-op).
    const body = await forge.getIssueBody(issue).catch(() => "");
    await forge.addPRComment(
      pr,
      buildReviewTriggerComment(issue, extractVerificationPlan(body), this.triggerCommand, this.doctrine, context),
    );
  }

  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict {
    const trusted = (login: string) => this.allowedLogins.includes(login);
    return verdictFrom(data, CodexReviewer.ACCEPT, (r) => trusted(normalizeLogin(r.author)), trusted, pin);
  }

  /** #282 (M10, E1): `ReviewerAdapter.trigger` — identical contract to `triggerReview` above,
   *  just bundled into one `ReviewContext` (design #279 §1's sketch). */
  async trigger(ctx: ReviewContext): Promise<void> {
    return this.triggerReview(ctx.forge, ctx.pr, ctx.issue, ctx.triggerContext);
  }

  /** #282: `ReviewerAdapter.evaluate` — the APPROVAL-ONLY half of `verdictFromData` above,
   *  reusing the EXACT SAME `computeApprovalSignal` helper `verdictFrom` calls (regression-pinned
   *  against it in reviewer.test.ts) so both surfaces can never silently diverge. Never derives
   *  blocking — see ApprovalResult's own doc. */
  async evaluate(ctx: ReviewContext): Promise<ApprovalResult> {
    if (!ctx.data) return { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" };
    const data = ctx.data;
    const trusted = (login: string) => this.allowedLogins.includes(login);
    const { evidence } = computeApprovalSignal(data, CodexReviewer.ACCEPT, (r) => trusted(normalizeLogin(r.author)), trusted, ctx.pin);
    return evidence.freshApprovingReviews > 0 || evidence.freshTrustedSignals > 0
      ? { kind: "approved", headOid: data.headOid, evidence }
      : { kind: "pending", headOid: data.headOid };
  }
}

/** A human review satisfies gate② — only an explicit APPROVED state counts (a human clicking
 *  "Comment" is not the same signal as "Approve"), from anyone but the PR author. No trigger:
 *  there's no bot to ping — a human reviews out of band. */
export class HumanReviewer implements Reviewer, ReviewerAdapter {
  readonly kind = "human" as const;
  private static readonly ACCEPT = ["APPROVED"] as const;

  async triggerReview(): Promise<void> {
    // No-op: nothing to ping. A human reviews on their own schedule.
  }

  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict {
    // No trustedReactionLogin passed -> freshTrustedThumbCount always 0; the pin is irrelevant
    // to human thumbs, but still attributes formal-review coverage to the current generation.
    return verdictFrom(data, HumanReviewer.ACCEPT, undefined, undefined, pin);
  }

  /** #282: no-op, same as triggerReview (bundled into one ReviewContext). */
  async trigger(_ctx: ReviewContext): Promise<void> {
    // No-op: nothing to ping. A human reviews on their own schedule.
  }

  /** #282: approval-only half — see CodexReviewer.evaluate's own doc for the shared-helper
   *  rationale. No trustedReactionLogin -> freshTrustedSignals always 0, same as verdictFromData. */
  async evaluate(ctx: ReviewContext): Promise<ApprovalResult> {
    if (!ctx.data) return { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" };
    const data = ctx.data;
    const { evidence } = computeApprovalSignal(data, HumanReviewer.ACCEPT, undefined, undefined, ctx.pin);
    return evidence.freshApprovingReviews > 0 || evidence.freshTrustedSignals > 0
      ? { kind: "approved", headOid: data.headOid, evidence }
      : { kind: "pending", headOid: data.headOid };
  }
}

/** Only a NAMED trusted-reviewer login's APPROVED review on the current head counts — public-
 *  repo hardening seam (docs/security.md's "Trust context" section — the allowlisted-reviewer
 *  requirement toward public-repo hardening): an unlisted account approving is not gate②. Fail-closed:
 *  an empty trustedReviewers list means nobody is trusted, so this mode can NEVER produce
 *  MERGE_OK (not a config footgun that silently allows any reviewer). */
export class SameModelTrustedReviewer implements Reviewer, ReviewerAdapter {
  readonly kind = "same-model-trusted" as const;
  private static readonly ACCEPT = ["APPROVED"] as const;

  constructor(private readonly trustedLogins: readonly string[]) {}

  async triggerReview(): Promise<void> {
    // No-op: the trusted reviewer is expected to act out of band (e.g. its own automation).
  }

  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict {
    if (this.trustedLogins.length === 0) return { action: "WAIT_REVIEW", headOid: data.headOid };
    const trusted = this.trustedLogins.map(normalizeLogin);
    // Filter what can APPROVE only — blocking signals (change requests, threads) intentionally
    // still see every review (verdictFrom's contract).
    // OID-bound clean comments count here too, from the same trusted list.
    return verdictFrom(
      data,
      SameModelTrustedReviewer.ACCEPT,
      (r) => trusted.includes(normalizeLogin(r.author)),
      (l) => trusted.includes(l),
      pin,
    );
  }

  /** #282: no-op, same as triggerReview (bundled into one ReviewContext). */
  async trigger(_ctx: ReviewContext): Promise<void> {
    // No-op: the trusted reviewer is expected to act out of band (e.g. its own automation).
  }

  /** #282: approval-only half — mirrors verdictFromData's own fail-closed empty-list handling
   *  (an empty trustedLogins list can never produce `approved`, same as it can never produce
   *  MERGE_OK above). See CodexReviewer.evaluate's own doc for the shared-helper rationale. */
  async evaluate(ctx: ReviewContext): Promise<ApprovalResult> {
    if (!ctx.data) return { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" };
    const data = ctx.data;
    if (this.trustedLogins.length === 0) return { kind: "pending", headOid: data.headOid };
    const trusted = this.trustedLogins.map(normalizeLogin);
    const { evidence } = computeApprovalSignal(
      data,
      SameModelTrustedReviewer.ACCEPT,
      (r) => trusted.includes(normalizeLogin(r.author)),
      (l) => trusted.includes(l),
      ctx.pin,
    );
    return evidence.freshApprovingReviews > 0 || evidence.freshTrustedSignals > 0
      ? { kind: "approved", headOid: data.headOid, evidence }
      : { kind: "pending", headOid: data.headOid };
  }
}

/** A Reviewer implementation's discriminant (#54: shared by primary + fallback construction).
 *  #286 (E4a, design #279 §1): widened to ALSO include "engine-agent" — the LLM review-agent
 *  kind (engine-agent.ts's EngineAgentReviewer) implements ONLY ReviewerAdapter, never the full
 *  Reviewer interface (no triggerReview/verdictFromData half — engine-agent is PRIMARY-ONLY, see
 *  config.ts's Reviewer.mode enum, which accepts "engine-agent" while reviewer.fallback's OWN
 *  enum deliberately does not), so `Reviewer["kind"]` alone can no longer express every
 *  ReviewerAdapter.kind value. Widening HERE (not narrowing ReviewerAdapter.kind's own type to
 *  something smaller) keeps every existing `ReviewerKind`-typed surface — including
 *  buildReviewerByKind's exhaustive switch below — a single source of truth for "every kind this
 *  engine knows the NAME of." REVIEWER_KINDS/isReviewerKind (below) deliberately do NOT list
 *  "engine-agent": it must never validate as a PERSISTED fallback kind (a DB
 *  review_fallback_kind column can only ever have been written for one of the three ORIGINAL
 *  Reviewer-implementing kinds — engine-agent was never legal there, config-rejected at parse,
 *  #286's own config strictness batch), so a forged/corrupt "engine-agent" string at that read
 *  boundary still fails closed to NO_FALLBACK_LOCK exactly like any other unknown string (see
 *  reviewer.test.ts's coverage of isReviewerKind("engine-agent") === false). */
export type ReviewerKind = Reviewer["kind"] | "engine-agent";

/** Build a Reviewer instance for a given KIND (#54) — the shared factory `makeReviewer` (below)
 *  and the reviewer-fallback chain (cfg.reviewer.fallback) both call, so a fallback entry gets
 *  the EXACT SAME mode implementation/semantics as picking that kind as the primary
 *  (reviewer.mode) would — reused, never forked. `doctrine` (#167) is threaded through
 *  identically to `triggerCommand`; only the `different-model-codex` case does anything with it
 *  (same-model-trusted / human post no trigger comment, so they have nothing to inject it into).
 *
 *  #282 (M10, E1): this switch is EXHAUSTIVE — no `default:` (grep-invariant test,
 *  reviewer.test.ts) and no `different-model-codex`-shaped catch-all. The prior shape
 *  (`case "different-model-codex": default: return new CodexReviewer(...)`) meant an
 *  UNRECOGNIZED kind string silently mis-constructed a Codex reviewer instead of failing —
 *  exactly the "can silently mis-construct" gap design #279 §1 calls out. Every member of
 *  `ReviewerKind` now gets its OWN explicit case. Note the compile-time guarantee is NOT the
 *  switch's own fallthrough behavior alone (Codex review round 2, adopted P2): a switch with no
 *  `default:` whose every case returns is exhaustive-shaped, but the function stays TOTAL either
 *  way once a trailing `throw` follows it — TypeScript would happily accept a NEW `ReviewerKind`
 *  member with no matching case, since the throw still satisfies every code path (no TS2366).
 *  The `_exhaustive: never` assignment right after the switch is what actually forces the
 *  compile error: it only type-checks when `kind`'s residual type at that point is `never`
 *  (every member consumed by a case above); a new, unhandled member leaves a non-`never` residual
 *  and the assignment itself fails to compile. The `throw` below it remains startup-time defense
 *  in depth for a `kind` value that bypasses the type system entirely (e.g. an unvalidated
 *  cast) — it is unreachable for any value TypeScript itself can see reach this function. */
export function buildReviewerByKind(
  kind: ReviewerKind,
  trustedReviewers: readonly string[],
  triggerCommand: string = "@codex review",
  doctrine?: string,
): Reviewer {
  switch (kind) {
    case "human":
      return new HumanReviewer();
    case "same-model-trusted":
      return new SameModelTrustedReviewer(trustedReviewers);
    case "different-model-codex":
      // trustedReviewers EXTENDS the Codex-bot allowlist in this mode (public-repo hardening:
      // gate② acceptance is identity-checked, not merely non-author — Codex PR #42 P1).
      return new CodexReviewer(trustedReviewers, triggerCommand, doctrine);
    case "engine-agent":
      // #286/#288: engine-agent has NO legal construction path through this limited factory — it is not
      // a `Reviewer` (no triggerReview/verdictFromData half; see ReviewerKind's own doc above),
      // so this function (return type `Reviewer`) cannot produce one, only decline clearly. A
      // real `EngineAgentReviewer` is built by engine-agent.ts's own factory
      // (makeEngineAgentReviewer), given a deps object (materializer/runner/state accessors)
      // this seam has no way to supply. #288's executable composition root in cli.ts instead uses
      // review/production.ts to bind them and wire the adapter into the drive loop. Throwing here
      // (rather than silently building a
      // Codex/human placeholder, or a Reviewer-shaped stub whose verdictFromData is permanently
      // WAIT_REVIEW) keeps "this factory never silently mis-constructs" (#282's own AC) true for
      // the new kind too: a caller that reaches this branch gets a loud, specific error instead of a
      // reviewer that LOOKS like it covers gate② but never can.
      // Keeping this exhaustively matched throw is safe because production engine-agent mode never
      // calls this factory; cli.ts selects the dependency-rich construction path first.
      throw new Error(
        'buildReviewerByKind: "engine-agent" is constructed via engine-agent.ts\'s makeEngineAgentReviewer, ' +
          "not this limited factory; use review/production.ts, which binds materializer, runner, state, and audit delivery.",
      );
  }
  // #282 review round 2 (adopted P2): the ACTUAL compile-time exhaustiveness sentinel. `kind`'s
  // type here is `never` only if every ReviewerKind member was consumed by a case above — a
  // future member added to the union without a matching case leaves a non-`never` residual type,
  // and THIS assignment (not the switch, not the throw below) is what fails to compile (TS2322).
  const _exhaustive: never = kind;
  void _exhaustive; // referenced so it isn't flagged as an unused local
  // Unreachable for any `kind` TypeScript can prove is a ReviewerKind (see doc above and the
  // sentinel just above) — a startup-time fail-safe for a value that reached here only via a
  // type-system bypass (e.g. an unvalidated cast).
  throw new Error(`buildReviewerByKind: unhandled reviewer kind: ${String(kind)}`);
}

/** Resolve this repo's review-doctrine text for gate② trigger-comment injection (#167). Reuses
 *  doctrine.ts's `loadDoctrine` — the SAME load site worker.ts and round-defaults.ts already
 *  call, never duplicated — and maps its `NO_DOCTRINE` placeholder to `undefined` HERE, at the
 *  construction-site boundary, because a public PR comment must never carry the internal "(No
 *  review doctrine file is configured...)" sentence. `buildReviewTriggerComment` ALSO enforces
 *  that invariant structurally (it treats a NO_DOCTRINE-valued argument like undefined —
 *  defense in depth, #177 review Codex P2); this boundary mapping stays anyway so a constructed
 *  CodexReviewer never even carries the placeholder. No doctrine adopted -> `undefined` -> the trigger comment
 *  is byte-for-byte identical to the pre-#167 comment. A present-but-unreadable doctrine file
 *  still fails fast here (loadDoctrine's contract), same as it already does for the worker
 *  brief and architect pass. */
function loadReviewDoctrine(cfg: SapwoodConfig): string | undefined {
  const text = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  return text === NO_DOCTRINE ? undefined : text;
}

/** Construct the configured PRIMARY reviewer (reviewer.mode) — for every kind EXCEPT the default
 *  one. Since #501 flipped `reviewer.mode`'s own default to `engine-agent` (a local Claude review
 *  session, PLAN.md Decision #5), the zero-config path does NOT come through here at all:
 *  `engine-agent` has no legal construction in this limited factory (see buildReviewerByKind's
 *  `engine-agent` case — it throws), and cli.ts selects the dependency-rich review/production.ts
 *  path first, reaching this function only when the configured mode is one of the three
 *  GitHub-review-shaped kinds (`different-model-codex` — the pre-#501 default, still selectable —
 *  `same-model-trusted`, `human`). */
export function makeReviewer(cfg: SapwoodConfig): Reviewer {
  return buildReviewerByKind(cfg.reviewer.mode, cfg.reviewer.trustedReviewers, cfg.reviewer.triggerCommand, loadReviewDoctrine(cfg));
}

/** Construct the configured FALLBACK chain (cfg.reviewer.fallback, #54) — one Reviewer per
 *  entry, in the SAME order as configured (resolveReviewVerdict below preserves that order:
 *  priority, not a retry escalation — the first entry whose OWN mode semantics reaches a
 *  decisive verdict wins). Empty by default -> resolveReviewVerdict behaves identically to
 *  calling the primary reviewer directly (no #54 behavior change from before this existed).
 *  Threads the same resolved doctrine text as makeReviewer (#167) — only relevant to a
 *  `different-model-codex` fallback entry, and only if triggerReview is ever invoked on a
 *  fallback in the future; today merge-driver.ts only triggers the primary. */
export function makeFallbackReviewers(cfg: SapwoodConfig): Reviewer[] {
  const doctrine = loadReviewDoctrine(cfg);
  return cfg.reviewer.fallback.map((kind) =>
    buildReviewerByKind(kind, cfg.reviewer.trustedReviewers, cfg.reviewer.triggerCommand, doctrine),
  );
}

// ── Reviewer failover (#54) ──────────────────────────────────────────────────────────────────
//
// Motivated by the live #46 run: Codex (the default primary) failed three distinct ways in one
// day — a bogus refusal, hard rate-limiting, usage-limit exhaustion — and gate② correctly
// queued every PR indefinitely (fail-closed is right, but availability shouldn't depend on a
// single external reviewer). `resolveReviewVerdict` is the pure decision core: which reviewer's
// verdict gates THIS tick, given the primary's own verdict, an optional ordered fallback chain,
// and how long the primary has had a chance to respond (the engine-recorded trigger pin,
// reused — no separate timer). No fallback configured (the default) -> byte-for-byte the same
// outcome as calling `primary.verdictFromData` directly: no silent degradation, ever.

/** A verdict is decisive (something a human/bot actually said about this head) vs. WAIT_REVIEW
 *  ("nothing yet, keep polling") or REVIEW_UNAVAILABLE ("the query itself failed") — the two
 *  actions #54 treats as "the primary isn't currently giving gate② anything to act on". */
function isDecisive(action: ReviewAction): boolean {
  return action === "MERGE_OK" || action === "HANDLE_THREADS";
}

/** Every legal Reviewer kind — the single validation source for any kind string read back from
 *  OUTSIDE the guard write boundary (#54 R2, fable-review P2: the state DB is not guard-
 *  protected, so a persisted `review_fallback_kind` must be validated on read, never cast).
 *  #286 (E4a): "engine-agent" is DELIBERATELY absent from this list even though `ReviewerKind`
 *  (above) now includes it — engine-agent is PRIMARY-ONLY (config.ts's reviewer.fallback enum
 *  never accepts it, parse-rejected), so no legitimate code path ever persists it as a
 *  `review_fallback_kind` value. Leaving it out here means a forged/corrupt "engine-agent"
 *  string at this read boundary fails isReviewerKind exactly like any other unknown string
 *  (fail-closed to NO_FALLBACK_LOCK) — see reviewer.test.ts. */
export const REVIEWER_KINDS = ["different-model-codex", "same-model-trusted", "human"] as const;

export function isReviewerKind(v: unknown): v is ReviewerKind {
  return typeof v === "string" && (REVIEWER_KINDS as readonly string[]).includes(v);
}

/** The per-lane failover marker (#54): "fallback reviewer `kind` obtained MERGE_OK on `head`".
 *  It shields the PR from the PRIMARY's unavailability or non-decisive verdicts — nothing else.
 *
 *  ADVISORY, never verdict-bearing (#54 R2, fable-review P2): `data/sapwood.sqlite` lives
 *  OUTSIDE the guard write boundary, so this row is never trusted on its own. At every use,
 *  resolveReviewVerdict re-derives the verdict from LIVE PR data through the recorded kind's
 *  own mode implementation (identity allowlist / non-author-approval rules, and the always-
 *  blocking signals — unresolved threads / a standing CHANGES_REQUESTED — which outrank any
 *  lock, fable-review P1). A forged or corrupt row therefore synthesizes nothing: no matching
 *  approval artifact on the current head ⇒ no MERGE_OK, and an unknown `kind` string fails
 *  isReviewerKind validation at the State read boundary (conductor.ts) ⇒ NO_FALLBACK_LOCK.
 *
 *  Lifetime (Codex PR #71 P2 + fable-review P2 on premature clearing): cleared ONLY on a head
 *  change (driveOne's re-trigger branch — the lock is head-scoped, so a push ends the episode)
 *  or with the lane itself on a confirmed merge (terminal row). NEVER cleared at verdict-
 *  resolution time — a transient non-merge tick (CI pending, mergeability UNKNOWN, merge
 *  retry, produce-pr-and-stop, engine restart) must leave the episode intact for the next
 *  tick. A lock for a non-current head is simply ignored wherever read. Persisted by the
 *  caller (State.recordReviewFallback); this module never touches storage. */
export interface ReviewFallbackLock {
  head: string | null;
  kind: ReviewerKind | null;
}

export const NO_FALLBACK_LOCK: ReviewFallbackLock = { head: null, kind: null };

/** Audit-trail signal for THIS tick (#54: "emit a structured event AND post a PR comment
 *  stating which reviewer mode is now gating"). STATELESS: reported on every tick the
 *  condition holds ("switch": a fallback's verdict is gating; "revert": the primary is
 *  decisive again while a failover episode's lock is still held for this head) — the caller
 *  (conductor.ts tick()) deduplicates against the durable event log before announcing, since
 *  this pure function has no memory of what was already announced. */
export interface ReviewFailoverTransition {
  kind: "switch" | "revert";
  mode: ReviewerKind;
  /** The head the transition applies to — part of the announce-dedup key (a new head is a new
   *  episode, so the same transition on a different head announces again). */
  head: string;
}

export interface ReviewFailoverResult {
  verdict: ReviewVerdict;
  /** Which reviewer's verdict is gating this tick — the primary's kind, or a fallback's. */
  sourceKind: ReviewerKind;
  /** The lock to persist for the NEXT call. Changes ONLY when a fallback reaches MERGE_OK on
   *  this head (recording/refreshing the episode) — never cleared here (see ReviewFallbackLock
   *  lifetime: head change / lane end are the only clears, both outside this function). */
  lock: ReviewFallbackLock;
  transition: ReviewFailoverTransition | null;
}

/**
 * Reviewer failover (#54): decide which reviewer's verdict gates THIS tick. Every verdict is
 * derived from LIVE PR data — the persisted lock is advisory (see ReviewFallbackLock) and can
 * only ever point at which mode to re-verify, never inject an outcome.
 *
 *  - `fallbacks` empty (config default) -> always the primary's own verdict, `lock` untouched,
 *    no transition — IDENTICAL to calling `primary.verdictFromData(data, triggerPin)` directly.
 *  - Primary decisive -> its verdict gates, ALWAYS. MERGE_OK is simply gate② satisfied by the
 *    primary again. HANDLE_THREADS blocks REGARDLESS of any lock (fable-review P1): it can only
 *    arise from the always-blocking, identity-UNfiltered signals (unresolved threads / a
 *    standing CHANGES_REQUESTED from anyone — usually a human's explicit block), which are
 *    independent gate inputs, not "the primary's opinion" — and "failover must never weaken
 *    gate② silently" outranks "verdict stays valid". A held lock only adds the "revert"
 *    audit signal (primary is gating again); it is not cleared (see lifetime).
 *  - Primary NOT decisive (WAIT_REVIEW / REVIEW_UNAVAILABLE) -> once `triggerPin.at` is at
 *    least `failoverAfterSec` old, evaluate `fallbacks` IN ORDER and use the first one whose
 *    OWN mode semantics reaches a decisive verdict on the live data — reported as a "switch",
 *    with a MERGE_OK recorded as the episode lock for this head. Below the threshold, a held
 *    lock is still honored — but ONLY by re-verifying it: the recorded kind must be among the
 *    CURRENTLY configured fallbacks (an operator removing it from config revokes the episode,
 *    and a forged kind matches nothing) and that mode's own fresh verdict on the live data
 *    must be MERGE_OK (the approval artifact must actually exist on this head; blocking
 *    signals re-checked by construction, since every mode's verdictFrom puts them first).
 *    Nothing decisive anywhere -> the primary's non-decisive verdict, unchanged (queue).
 *
 * #282 (M10, E1): ASYNC-AWARE signature (design #279 §1). `Reviewer.verdictFromData` itself stays
 * synchronous — the three existing kinds resolve from already-fetched `PRReviewData` with no I/O
 * of their own — so this function's OWN body performs no `await`; the change is the boundary,
 * not the computation. It exists so a future engine-agent kind's genuinely-async evaluation
 * (design #279 §2's drive flow: materialize → spawn session → validate) can be threaded into the
 * SAME failover-timing/lock/transition orchestration below without a second, parallel resolver —
 * every call site (merge-driver.ts's driveOne) now `await`s this call; zero behavior change,
 * mechanical signature update (reviewer.test.ts's resolveReviewVerdict suite is the regression
 * pin: same assertions, `async`-wrapped).
 */
export async function resolveReviewVerdict(input: {
  primary: Reviewer;
  fallbacks: readonly Reviewer[];
  data: PRReviewData;
  triggerPin: ReviewTriggerPin;
  now: Date;
  failoverAfterSec: number;
  lock: ReviewFallbackLock;
}): Promise<ReviewFailoverResult> {
  const { primary, fallbacks, data, triggerPin, now, failoverAfterSec, lock } = input;
  const primaryVerdict = primary.verdictFromData(data, triggerPin);
  // A lock only ever REFERS to a re-verifiable episode: current head + a kind that is still an
  // explicitly configured fallback. Anything else (stale head, forged/unknown kind, kind
  // removed from config) is ignored — never an error, never a verdict.
  const lockReviewer = lock.head === data.headOid && lock.kind != null ? (fallbacks.find((f) => f.kind === lock.kind) ?? null) : null;

  if (isDecisive(primaryVerdict.action)) {
    // Primary gates — including a blocking HANDLE_THREADS, lock or no lock (fable-review P1).
    // The lock stays untouched (cleared only on head change / lane end); a held one is
    // reported as "revert" so the audit trail records that the primary is gating again.
    return {
      verdict: primaryVerdict,
      sourceKind: primary.kind,
      lock,
      transition: lockReviewer ? { kind: "revert", mode: primary.kind, head: data.headOid } : null,
    };
  }

  // Primary not decisive (WAIT_REVIEW, or an explicit REVIEW_UNAVAILABLE).
  const sinceTriggerSec = triggerPin.at != null ? (now.getTime() - Date.parse(triggerPin.at)) / 1000 : null;
  const pastThreshold = fallbacks.length > 0 && sinceTriggerSec !== null && sinceTriggerSec >= failoverAfterSec;
  if (pastThreshold) {
    for (const fb of fallbacks) {
      const v = fb.verdictFromData(data, triggerPin);
      if (isDecisive(v.action)) {
        // MERGE_OK records/refreshes the episode lock; HANDLE_THREADS gates (block) without
        // touching the lock. Note the chain subsumes a held lock's re-verification: the lock's
        // kind is one of these fallbacks, so its approval artifact is found right here.
        const newLock: ReviewFallbackLock = v.action === "MERGE_OK" ? { head: data.headOid, kind: fb.kind } : lock;
        return { verdict: v, sourceKind: fb.kind, lock: newLock, transition: { kind: "switch", mode: fb.kind, head: data.headOid } };
      }
    }
  } else if (lockReviewer) {
    // Below the threshold (e.g. the operator raised failoverAfterSec mid-episode) a held lock
    // is still honored — by RE-VERIFICATION only: the recorded mode's own fresh verdict on the
    // live data must be MERGE_OK. A forged lock with no matching approval artifact yields
    // nothing (#54 R2), and blocking signals block here too (verdictFrom evaluates them first).
    const v = lockReviewer.verdictFromData(data, triggerPin);
    if (v.action === "MERGE_OK") {
      return {
        verdict: v,
        sourceKind: lockReviewer.kind,
        lock,
        transition: { kind: "switch", mode: lockReviewer.kind, head: data.headOid },
      };
    }
  }
  return { verdict: primaryVerdict, sourceKind: primary.kind, lock, transition: null };
}
