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
 * Fresh (post-PR-activity) PR-level `+1` reactions — 0day pr_gate.sh's `fresh_thumb_count`.
 * A reaction created at/before `cutoffIso` (the PR's last-activity timestamp) is stale: it
 * predates a push, so it cannot have been a response to the current head (#92). ISO-8601
 * `Z`-suffixed timestamps compare correctly as strings (lexicographic == chronological).
 */
export function freshThumbCount(reactions: { content: string; createdAt: string }[], cutoffIso: string): number {
  return reactions.filter((r) => r.content === "+1" && r.createdAt > cutoffIso).length;
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

export interface ReviewSignals {
  hasEyesReaction: boolean;
  freshApprovingReviews: number;
  unresolvedThreads: number;
}

/**
 * Pure ACTION derivation from review signals — the review-only half of pr_gate.sh's ACTION
 * protocol (CI-flavored actions live in merge-driver.deriveGate, which folds in gate①
 * separately). Fail-safe ordering: unresolved findings outrank a stale/partial approval signal;
 * "nothing yet" (no review, no 👀) is WAIT_REVIEW, never a silent MERGE_OK.
 */
export function deriveReviewAction(s: ReviewSignals): ReviewAction {
  if (s.unresolvedThreads > 0) return "HANDLE_THREADS";
  if (s.freshApprovingReviews > 0) return "MERGE_OK";
  return "WAIT_REVIEW"; // covers both "👀 in progress" and "nothing yet" — both mean keep polling
}

/** The pluggable review-gate seam. Read-only + comment-only; no merge method (structural
 *  producer != reviewer != merger — see module header). merge-driver.ts owns the one impure
 *  read (forge.getPRReviewData) and its failure handling (-> REVIEW_UNAVAILABLE), so
 *  verdictFromData is PURE and unit-testable with no async/mocks. */
export interface Reviewer {
  readonly kind: "different-model-codex" | "same-model-trusted" | "human";
  /** Post the review trigger (e.g. `@codex review`). A no-op for modes with no bot to ping
   *  (same-model-trusted, human) — those wait for an out-of-band review to land. */
  triggerReview(forge: IForge, pr: number): Promise<void>;
  /** This tick's verdict from ALREADY-FETCHED review data (merge-driver.ts fetches it fresh
   *  every call against the LIVE current head — never a cached one; a review of a stale head
   *  counts as no review, #101, since freshHeadReviewCount filters on data.headOid). */
  verdictFromData(data: PRReviewData): ReviewVerdict;
}

function verdictFrom(data: PRReviewData, acceptStates: readonly string[]): ReviewVerdict {
  const fresh = freshHeadReviewCount(data.reviews, data.headOid, data.author, acceptStates);
  const action = deriveReviewAction({
    hasEyesReaction: data.reactions.some((r) => r.content === "eyes"),
    freshApprovingReviews: fresh,
    unresolvedThreads: data.unresolvedThreads,
  });
  return { action, headOid: data.headOid };
}

/** Default reviewer (0day-style): triggers `@codex review`; an accepted verdict is any
 *  non-author COMMENTED-or-APPROVED review on the current head (Codex's normal review state is
 *  COMMENTED, not APPROVED — matching pr_gate.sh's fresh_head_review_count). */
export class CodexReviewer implements Reviewer {
  readonly kind = "different-model-codex" as const;
  private static readonly ACCEPT = ["COMMENTED", "APPROVED"] as const;

  async triggerReview(forge: IForge, pr: number): Promise<void> {
    await forge.addPRComment(pr, "@codex review");
  }

  verdictFromData(data: PRReviewData): ReviewVerdict {
    return verdictFrom(data, CodexReviewer.ACCEPT);
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

  verdictFromData(data: PRReviewData): ReviewVerdict {
    if (this.trustedLogins.length === 0) return { action: "WAIT_REVIEW", headOid: data.headOid };
    const trustedOnly = data.reviews.filter((r) => this.trustedLogins.includes(r.author));
    return verdictFrom({ ...data, reviews: trustedOnly }, SameModelTrustedReviewer.ACCEPT);
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
      return new CodexReviewer();
  }
}
