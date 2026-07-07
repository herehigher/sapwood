// reviewer.ts — gate②: pluggable review verdict. Default = a fresh, different-model Codex
// review (0day-style: trigger `@codex review`, poll reaction/review state, parse the verdict
// against a SPECIFIC head oid). Alternatives selectable via config (reviewer.mode):
// same-model-trusted (a named trusted-reviewer login must approve) and human (any non-author
// human approval). produce-pr-and-stop is NOT a reviewer kind — it's merge.mode
// (merge-driver.ts): whether the Conductor merges once gates pass, independent of who reviews.
//
// This is a TS port of the REVIEW HALF of 0day's scripts/pr_gate.sh ACTION protocol — CI
// (gate①) is a separate, already-existing signal (forge.getPRStatus().ciGreen) folded in by
// merge-driver.ts, not duplicated here.
//
// SECURITY (producer != reviewer != merger): this module only ever *reads* review state and
// posts a plain PR comment (the trigger). It has no merge method and never will — merging is
// merge-driver.ts's alone, invoked only from the Conductor (conductor.ts), never a worker.
import type { IForge, PRReview, PRReviewData } from "./forge.js";
import { extractVerificationPlan } from "./forge.js";
import type { SapwoodConfig } from "./config.js";

export type ReviewAction =
  | "MERGE_OK" // fresh, non-author, accepted-state review on the CURRENT head
  | "WAIT_REVIEW" // nothing decisive yet (no review, or only a 👀-in-progress signal) — keep polling
  | "HANDLE_THREADS" // unresolved review threads on the PR — findings to address
  | "REVIEW_UNAVAILABLE"; // the review query itself failed (rate-limit/timeout/malformed) — MUST queue, never skip/soften gate②

export interface ReviewVerdict {
  action: ReviewAction;
  /** The head this verdict was computed against; null when REVIEW_UNAVAILABLE (no live data). */
  headOid: string | null;
}

/**
 * Fresh (post-cutoff) PR-level `+1` reactions — 0day pr_gate.sh's `fresh_thumb_count`.
 * A reaction created at/before `cutoffIso` is stale: it predates the engine's review trigger,
 * so it cannot have been a response to it (#92, #55 P1-B). Compared NUMERICALLY (epoch ms),
 * not lexicographically (round-2 P2): the engine pin carries millisecond precision
 * (`...00.999Z`) while GitHub reaction timestamps are second-granularity (`...00Z`), and as
 * raw strings `"...00Z" > "...00.999Z"` — a same-second reaction that actually PREDATES the
 * trigger would have counted as fresh. Numeric compare truncates that same-second reaction to
 * `.000` and rejects it (fail-closed; the genuine thumb arrives minutes after the trigger).
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
 * `acceptStates` — port of 0day pr_gate.sh's `fresh_head_review_count` (#101). A review left on
 * an older head does NOT count (a stale review must never look like a review of the current
 * head — the exact bypass gate② exists to close). Author self-review never counts
 * (producer != reviewer, even if the author is also a configured "trusted" login).
 */
export function freshHeadReviewCount(
  reviews: PRReview[],
  headOid: string,
  prAuthor: string,
  acceptStates: readonly string[],
): number {
  return reviews.filter(
    (r) => r.commitOid === headOid && r.author !== prAuthor && acceptStates.includes(r.state),
  ).length;
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
  /** Fresh `+1` reactions from TRUSTED reviewer logins only (see verdictFrom): Codex's
   *  "done, no findings" verdict often arrives as comment+👍 with NO formal review object —
   *  the live #46 run wedged at WAIT_REVIEW because this signal wasn't wired (the ported
   *  freshThumbCount helper existed but nothing consumed it). */
  freshTrustedThumbs: number;
  unresolvedThreads: number;
  /** A standing CHANGES_REQUESTED on the current head (see changesRequestedOnHead). */
  changesRequestedOnHead: boolean;
}

/**
 * Pure ACTION derivation from review signals — the review-only half of pr_gate.sh's ACTION
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

/** The ENGINE-recorded review-trigger pin (PR #55 P1-B) — the thumb-verdict freshness cutoff.
 *  Sourced from state.ts's workers.review_triggered_head/at, threaded in by merge-driver.ts's
 *  driveOne (which is the only place that knows BOTH the pin and the live current head). `head`
 *  is the head oid the LAST trigger was posted for; `at` is the engine wall-clock ISO timestamp
 *  it was posted at. Either null means "no trigger recorded for this lane yet" — thumbs must
 *  never count in that case (fail-closed), matching a lane whose first trigger hasn't fired. */
export interface ReviewTriggerPin {
  head: string | null;
  at: string | null;
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
  triggerReview(forge: IForge, pr: number, issue: number): Promise<void>;
  /** This tick's verdict from ALREADY-FETCHED review data (merge-driver.ts fetches it fresh
   *  every call against the LIVE current head — never a cached one; a review of a stale head
   *  counts as no review, #101, since freshHeadReviewCount filters on data.headOid). `pin` (#55
   *  P1-B) is the engine-recorded trigger pin for this lane; omitted/undefined behaves like
   *  {head: null, at: null} — no thumb can count (fail-closed), same as a lane never triggered. */
  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict;
}

/** GitHub bot logins vary by API surface: REST reactions report `foo[bot]`, GraphQL/pr-view
 *  reviews report `foo`. Normalize by stripping the suffix so an allowlist entry written
 *  either way matches (0day's LOOP_TRUSTED_REVIEWERS default was the `[bot]`-suffixed form). */
export function normalizeLogin(login: string): string {
  return login.replace(/\[bot\]$/, "");
}

/** The Codex review bot's login (normalized form — see normalizeLogin). */
export const CODEX_REVIEWER_LOGINS = ["chatgpt-codex-connector"] as const;

/**
 * Build the review-trigger comment body (#46, Decision #8): `@codex review` plus the issue's
 * verification plan, so gate② re-checks the finished PR against the SAME plan the `Ready` gate
 * required at dispatch (getReadyIssues / hasVerificationPlan) — until now gate② only checked
 * "fresh non-author review + CI", not plan conformance (PLAN.md M3 deferred list). `planText`
 * null (no extractable Verification/Acceptance section — e.g. a verify:n/a issue, or a
 * malformed body) still gets an EXPLICIT fallback sentence, never a silently plan-less trigger.
 * Pure + exported so the shape is unit-testable without a fake IForge.
 */
export function buildReviewTriggerComment(issue: number, planText: string | null): string {
  const instruction = planText
    ? `Verify this PR against issue #${issue}'s verification plan below:\n\n${planText}`
    : `No extractable verification plan was found on issue #${issue} — review this PR on its own merits.`;
  return `@codex review\n\n${instruction}`;
}

/**
 * Verdict core. `countableReview` restricts WHOSE reviews may satisfy gate② (Codex PR #42 P1:
 * in codex mode, a review from any random non-author account must NOT count — only the Codex
 * bot / configured allowlist). The BLOCKING signals are deliberately un-filtered: a standing
 * change request from ANYONE blocks (changesRequestedOnHead reads all reviews), and unresolved
 * threads always block — the filter can only shrink what approves, never what blocks.
 */
/**
 * Trusted-thumb verdict signal: `+1` reactions count ONLY when (a) the reacting login is NOT
 * the PR author, even when the author's login is itself in the trusted set (Codex PR #55 P1-A:
 * producer != reviewer — an author's own 👍 must never be gate②-satisfying, formal reviews
 * already exclude data.author via freshHeadReviewCount and this path must match); (b) the login
 * passes the same identity filter as countable reviews (a random account's 👍 must never satisfy
 * gate② — same P1 class as PR #42's reviewer-identity finding); and (c) the reaction is newer
 * than the ENGINE-recorded trigger time (`pin.at`) for the SAME head the trigger was posted
 * against (`pin.head === data.headOid`) — PR #55 P1-B: a commit's own committedDate is not
 * push-bound (forgeable via GIT_COMMITTER_DATE / cherry-picks, and doesn't move on a later
 * push), so the freshness cutoff is the engine's own trigger clock, not anything read off git.
 * No pin, or a pin for a different head, ⇒ 0, fail-closed (no trigger recorded for this head
 * yet ⇒ no thumb can have been a response to it).
 */
function freshTrustedThumbCount(
  data: PRReviewData,
  trustedLogin?: (login: string) => boolean,
  pin?: ReviewTriggerPin,
): number {
  if (!trustedLogin || !pin?.at || pin.head !== data.headOid) return 0;
  const author = normalizeLogin(data.author);
  const trusted = data.reactions.filter(
    (r) => normalizeLogin(r.login) !== author && trustedLogin(normalizeLogin(r.login)),
  );
  return freshThumbCount(trusted, pin.at);
}

function verdictFrom(
  data: PRReviewData,
  acceptStates: readonly string[],
  countableReview?: (r: PRReview) => boolean,
  trustedReactionLogin?: (login: string) => boolean,
  pin?: ReviewTriggerPin,
): ReviewVerdict {
  const countable = countableReview ? data.reviews.filter(countableReview) : data.reviews;
  const fresh = freshHeadReviewCount(countable, data.headOid, data.author, acceptStates);
  const action = deriveReviewAction({
    hasEyesReaction: data.reactions.some((r) => r.content === "eyes"),
    freshApprovingReviews: fresh,
    freshTrustedThumbs: freshTrustedThumbCount(data, trustedReactionLogin, pin),
    unresolvedThreads: data.unresolvedThreads,
    changesRequestedOnHead: changesRequestedOnHead(data.reviews, data.headOid, data.author),
  });
  return { action, headOid: data.headOid };
}

/** Default reviewer (0day-style): triggers `@codex review`; an accepted verdict is a
 *  COMMENTED-or-APPROVED review on the current head (Codex's normal review state is COMMENTED,
 *  not APPROVED — matching pr_gate.sh's fresh_head_review_count) from the CODEX BOT or a
 *  configured trusted login — never from an arbitrary non-author account (Codex PR #42 P1:
 *  gate② is "a fresh different-model review", so the reviewer identity is part of the gate). */
export class CodexReviewer implements Reviewer {
  readonly kind = "different-model-codex" as const;
  private static readonly ACCEPT = ["COMMENTED", "APPROVED"] as const;
  private readonly allowedLogins: string[];

  /** `extraTrustedLogins` (cfg.reviewer.trustedReviewers) extends — never replaces — the
   *  Codex bot's own login. */
  constructor(extraTrustedLogins: readonly string[] = []) {
    this.allowedLogins = [...CODEX_REVIEWER_LOGINS, ...extraTrustedLogins].map(normalizeLogin);
  }

  async triggerReview(forge: IForge, pr: number, issue: number): Promise<void> {
    // A body-fetch hiccup (rate-limit/timeout) must not block the trigger itself — gate②
    // still has to fire; it just falls back to the explicit "no plan" text below rather than
    // silently retrying forever or skipping the comment (#46 Decision #8: the trigger always
    // posts, never a swallowed no-op).
    const body = await forge.getIssueBody(issue).catch(() => "");
    await forge.addPRComment(pr, buildReviewTriggerComment(issue, extractVerificationPlan(body)));
  }

  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict {
    const trusted = (login: string) => this.allowedLogins.includes(login);
    return verdictFrom(data, CodexReviewer.ACCEPT, (r) => trusted(normalizeLogin(r.author)), trusted, pin);
  }
}

/** A human review satisfies gate② — only an explicit APPROVED state counts (a human clicking
 *  "Comment" is not the same signal as "Approve"), from anyone but the PR author. No trigger:
 *  there's no bot to ping — a human reviews out of band. */
export class HumanReviewer implements Reviewer {
  readonly kind = "human" as const;
  private static readonly ACCEPT = ["APPROVED"] as const;

  async triggerReview(): Promise<void> {
    // No-op: nothing to ping. A human reviews on their own schedule.
  }

  verdictFromData(data: PRReviewData): ReviewVerdict {
    // No trustedReactionLogin passed -> freshTrustedThumbCount always 0; the pin is irrelevant
    // to human mode (a human's approval is a real review, never a 👍) so it's not accepted here.
    return verdictFrom(data, HumanReviewer.ACCEPT);
  }
}

/** Only a NAMED trusted-reviewer login's APPROVED review on the current head counts — public-
 *  repo hardening seam (PLAN.md v1.1): an unlisted account approving is not gate②. Fail-closed:
 *  an empty trustedReviewers list means nobody is trusted, so this mode can NEVER produce
 *  MERGE_OK (not a config footgun that silently allows any reviewer). */
export class SameModelTrustedReviewer implements Reviewer {
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
    // Thumbs count here too, from the same trusted list — mode symmetry with CodexReviewer.
    return verdictFrom(
      data, SameModelTrustedReviewer.ACCEPT,
      (r) => trusted.includes(normalizeLogin(r.author)), (l) => trusted.includes(l), pin,
    );
  }
}

/** Construct the configured reviewer (reviewer.mode). Default = CodexReviewer, matching the
 *  locked decision (0day-style fresh different-model review). */
export function makeReviewer(cfg: SapwoodConfig): Reviewer {
  switch (cfg.reviewer.mode) {
    case "human":
      return new HumanReviewer();
    case "same-model-trusted":
      return new SameModelTrustedReviewer(cfg.reviewer.trustedReviewers);
    case "different-model-codex":
    default:
      // trustedReviewers EXTENDS the Codex-bot allowlist in this mode (public-repo hardening:
      // gate② acceptance is identity-checked, not merely non-author — Codex PR #42 P1).
      return new CodexReviewer(cfg.reviewer.trustedReviewers);
  }
}
