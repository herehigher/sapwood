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

import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine, NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge, PRReview, PRReviewData } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";

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
 * Build the review-trigger comment body (#46, Decision #8): `triggerCommand` (default
 * `@codex review`, #156 reviewer.triggerCommand) plus the issue's verification plan, so gate②
 * re-checks the finished PR against the SAME plan the `Ready` gate required at dispatch
 * (getReadyIssues / hasVerificationPlan) — until now gate② only checked "fresh non-author
 * review + CI", not plan conformance (PLAN.md M3 deferred list). `planText` null (no extractable
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
  const identityBlock = context ? `\n\nState the exact head OID you reviewed in your response as: Reviewed head OID: ${context.head}` : "";
  return `${triggerCommand}\n\n${instruction}${doctrineBlock}${scopeBlock}${identityBlock}`;
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
function freshTrustedThumbCount(data: PRReviewData, trustedLogin?: (login: string) => boolean, pin?: ReviewTriggerPin): number {
  if (!trustedLogin || !pin?.at || pin.head !== data.headOid || (pin.generation ?? 1) > 1) return 0;
  const author = normalizeLogin(data.author);
  const trusted = data.reactions.filter((r) => normalizeLogin(r.login) !== author && trustedLogin(normalizeLogin(r.login)));
  return freshThumbCount(trusted, pin.at);
}

/**
 * Codex's clean verdict is sometimes a plain conversation COMMENT ("Codex Review: Didn't find
 * any major issues") with NO review object and NO +1 reaction (post-#55 P2) — count it under
 * the exact same rules as trusted thumbs: trusted non-author login only, and created after the
 * ENGINE-recorded trigger pin for the CURRENT head. The phrase match is deliberately narrow
 * (Codex's canonical clean phrasing); an unmatched comment simply keeps waiting — fail-closed.
 * Identity-gating makes the text non-spoofable: only the trusted bot's own comments are read.
 */
const CLEAN_VERDICT_RE = /didn't find any major issues/i;
const REVIEWED_HEAD_OID_RE = /^Reviewed head OID: (\S+)\s*$/;

function assertedHeadOids(body: string): Set<string> {
  const values = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(">")) continue;
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
    const statedOids = assertedHeadOids(c.body);
    const oidMatches = statedOids.size === 1 && statedOids.has(data.headOid);
    return (
      normalizeLogin(c.login) !== author &&
      trustedLogin(normalizeLogin(c.login)) &&
      Number.isFinite(createdAt) &&
      createdAt > cutoff &&
      CLEAN_VERDICT_RE.test(c.body) &&
      (statedOids.size > 0 ? oidMatches : (pin.generation ?? 1) <= 1)
    );
  }).length;
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
  const freshTrustedSignals =
    freshTrustedThumbCount(data, trustedReactionLogin, pin) + freshTrustedCleanComments(data, trustedReactionLogin, pin);
  const currentHeadChangesRequested = changesRequestedOnHead(data.reviews, data.headOid, data.author);
  const action = deriveReviewAction({
    hasEyesReaction: data.reactions.some((r) => r.content === "eyes"),
    freshApprovingReviews: fresh,
    // Thumbs and comment-shaped clean verdicts share one signal: both are "the trusted
    // reviewer said done-no-findings" under identical identity/pin rules.
    freshTrustedThumbs: freshTrustedSignals,
    unresolvedThreads: data.unresolvedThreads,
    changesRequestedOnHead: currentHeadChangesRequested,
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
    generationResponded: currentGenerationFormalResponse || currentHeadChangesRequested || freshTrustedSignals > 0,
    coverageEstablished: currentGenerationFormalResponse || freshTrustedSignals > 0,
  };
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

  verdictFromData(data: PRReviewData, pin?: ReviewTriggerPin): ReviewVerdict {
    // No trustedReactionLogin passed -> freshTrustedThumbCount always 0; the pin is irrelevant
    // to human thumbs, but still attributes formal-review coverage to the current generation.
    return verdictFrom(data, HumanReviewer.ACCEPT, undefined, undefined, pin);
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
      data,
      SameModelTrustedReviewer.ACCEPT,
      (r) => trusted.includes(normalizeLogin(r.author)),
      (l) => trusted.includes(l),
      pin,
    );
  }
}

/** A Reviewer implementation's discriminant (#54: shared by primary + fallback construction). */
export type ReviewerKind = Reviewer["kind"];

/** Build a Reviewer instance for a given KIND (#54) — the shared factory `makeReviewer` (below)
 *  and the reviewer-fallback chain (cfg.reviewer.fallback) both call, so a fallback entry gets
 *  the EXACT SAME mode implementation/semantics as picking that kind as the primary
 *  (reviewer.mode) would — reused, never forked. `doctrine` (#167) is threaded through
 *  identically to `triggerCommand`; only the `different-model-codex` case does anything with it
 *  (same-model-trusted / human post no trigger comment, so they have nothing to inject it
 *  into). */
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
    // biome-ignore lint/complexity/noUselessSwitchCase: explicit case documents the fail-closed reviewer fallback.
    case "different-model-codex":
    default:
      // trustedReviewers EXTENDS the Codex-bot allowlist in this mode (public-repo hardening:
      // gate② acceptance is identity-checked, not merely non-author — Codex PR #42 P1).
      return new CodexReviewer(trustedReviewers, triggerCommand, doctrine);
  }
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

/** Construct the configured PRIMARY reviewer (reviewer.mode). Default = CodexReviewer, matching
 *  the locked decision (0day-style fresh different-model review). */
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
 *  protected, so a persisted `review_fallback_kind` must be validated on read, never cast). */
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
 */
export function resolveReviewVerdict(input: {
  primary: Reviewer;
  fallbacks: readonly Reviewer[];
  data: PRReviewData;
  triggerPin: ReviewTriggerPin;
  now: Date;
  failoverAfterSec: number;
  lock: ReviewFallbackLock;
}): ReviewFailoverResult {
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
