// merge-driver.ts — gate① (CI green) + gate② (fresh non-author review on the current head) ->
// merge. TS port of 0day's ops/loop/loop_merge_driver.sh: the ONLY place a merge happens.
//
// Two-layer safety (mirrors 0day exactly):
//  1. deriveGate() — the SCHEDULING gate (MERGE/WAIT/HUMAN), combining gate① (PRStatus.ciGreen)
//     with gate②'s review verdict (reviewer.ts) + PR state/draft/risk-labels. Feeds the
//     Conductor's existing driveDecision (conductor.ts) is NOT used here — see the NOTE below
//     driveOne for why FIXABLE/fixup-dispatch is out of scope for this port.
//  2. mergeDecision() — the FINAL safety net, re-derived from fresh action/labels/state
//     immediately before the actual `gh pr merge` call (0day's loop_merge_driver.sh
//     merge_decision). Pure, zero-dep, parity-tested row-for-row against 0day's
//     test_loop_merge_driver.sh — see merge-driver.test.ts.
//
// SECURITY (producer != reviewer != merger, structural): mergePR is called ONLY from
// MergeDriver.driveOne, which is invoked ONLY from the Conductor's tick() (conductor.ts) —
// never from worker.ts / a worker session. A worker cannot reach this code path at all: it has
// no reference to a MergeDriver, no `--add-dir` into the engine's data, and its `claude -p` is
// launched with `gh pr merge`/`gh pr ready` in --disallowedTools (worker.ts claudeArgs) as
// defense-in-depth on top of the guard hook's fail-closed Category-C block (guard.ts).
import type { IForge, PRStatus, PRReviewData } from "./forge.js";
import type { SapwoodConfig } from "./config.js";
import type { Reviewer, ReviewAction, ReviewTriggerPin, ReviewFallbackLock, ReviewFailoverTransition } from "./reviewer.js";
import { resolveReviewVerdict, changesRequestedOnHead, NO_FALLBACK_LOCK } from "./reviewer.js";

export type Gate = "MERGE" | "WAIT" | "HUMAN";

/**
 * Pure gate derivation: gate① (CI green) + gate② (review verdict) + PR state/draft/risk-labels
 * -> a scheduling gate. Fail-safe ordering — a non-OPEN PR, a draft, or any configured
 * human-triage label always wins (never auto-act on one), checked before the review verdict.
 *
 * NOTE (scope): 0day's pr_gate.sh ACTION protocol also has a FIXABLE gate (CI_RED / unresolved
 * review threads) that dispatches a fixup-worker in a bounded retry loop
 * (drive_decision/fix_rounds, ops/loop/loop_conductor.sh:941-1053). This port folds
 * HANDLE_THREADS straight to HUMAN — fixup-worker auto-dispatch is a distinct subsystem (a new
 * Supervisor dispatch shape + a fix-rounds counter) out of scope for #13's review-gate +
 * merge-driver delivery. Deferred as a follow-up, same pattern as M2's #31/#33/#37.
 */
export function deriveGate(input: {
  ciGreen: boolean;
  reviewAction: ReviewAction;
  isDraft: boolean;
  prState: PRStatus["state"];
  labels: string[];
  humanLabels: readonly string[];
}): Gate {
  if (input.prState !== "OPEN") return "HUMAN"; // already merged/closed -> never touch
  if (input.isDraft) return "HUMAN"; // draft is human territory
  if (input.labels.some((l) => input.humanLabels.some((want) => l.includes(want)))) return "HUMAN";
  switch (input.reviewAction) {
    case "REVIEW_UNAVAILABLE":
      // Rate-limit/timeout/malformed review query: QUEUE (WAIT), never skip gate② by treating
      // this as a pass, and never soften it by escalating to human triage as if it were a real
      // finding — it's an infrastructure hiccup, retried next tick (#13).
      return "WAIT";
    case "HANDLE_THREADS":
      return "HUMAN"; // findings — see NOTE above
    case "WAIT_REVIEW":
      return "WAIT";
    case "MERGE_OK":
      return input.ciGreen ? "MERGE" : "WAIT"; // gate① not yet green -> keep waiting
    default:
      return "HUMAN"; // fail-safe: an unrecognized action never auto-merges
  }
}

// Default risk/human-triage label substrings (0day ops/loop/loop_merge_driver.sh
// LOOP_HUMAN_LABELS default). Real runtime callers pass cfg.escalation.humanLabels instead
// (sapwood dropped 0day's risk/fund trading-domain labels — CLAUDE.md: port the logic, not the
// domain); this default exists only so mergeDecision reproduces 0day's parity-suite rows
// unchanged when called with no 5th argument.
const BASH_DEFAULT_HUMAN_LABELS = ["risk", "fund", "needs-human", "blocked"] as const;

/**
 * Port of 0day's loop_merge_driver.sh `merge_decision` — the FINAL fail-safe check evaluated
 * immediately before the actual merge call, re-derived from FRESH action/labels/state (defense
 * in depth: independent of, and evaluated later than, deriveGate above). Pure, zero-dep.
 * Parity-tested row-for-row against 0day's test_loop_merge_driver.sh (merge-driver.test.ts).
 *
 *  - MERGE_OK: an automatic-merge candidate (gate② already guaranteed a fresh non-author review
 *    of the current head — this function does not re-derive that freshness).
 *  - APPROVED_PR_LEVEL: a bare PR-level 👍 candidate ONLY when `trustedApproval` is true (a
 *    fresh 👍 from a configured trusted/bot reviewer login, computed by the caller); anyone
 *    else's 👍 (indistinguishable human-vs-worker) -> ESCALATE.
 *  - WAIT_*: passive wait (poll again later).
 *  - anything else (CI_RED / HANDLE_THREADS / DRAFT_HUMAN / empty / unknown): ESCALATE
 *    (fail-safe — never auto-merge/auto-wait on an unrecognized signal).
 *  - state must be OPEN; any configured human-triage label -> ESCALATE, even with a trusted 👍.
 */
export function mergeDecision(
  action: string,
  labelsCsv: string,
  state: string = "OPEN",
  trustedApproval: boolean = false,
  humanLabels: readonly string[] = BASH_DEFAULT_HUMAN_LABELS,
): "MERGE" | "WAIT" | "ESCALATE" {
  if (action === "MERGE_OK") {
    // automatic-merge candidate — fall through to the state/label guards below
  } else if (action === "APPROVED_PR_LEVEL") {
    if (!trustedApproval) return "ESCALATE";
  } else if (action.startsWith("WAIT_") || action === "REVIEW_UNAVAILABLE") {
    // REVIEW_UNAVAILABLE (sapwood extension, #13): a rate-limited/timed-out review query is an
    // infrastructure hiccup, not a finding — queue (retry later), never escalate to human
    // triage and never soften gate② by treating it as a pass.
    return "WAIT";
  } else {
    return "ESCALATE"; // CI_RED / HANDLE_THREADS / DRAFT_HUMAN / ESCALATE_HUMAN / unknown / ""
  }
  if (state !== "OPEN") return "ESCALATE"; // already merged/closed -> never touch
  const labels = labelsCsv === "" ? [] : labelsCsv.split(",");
  for (const l of labels) {
    if (humanLabels.some((want) => l.includes(want))) return "ESCALATE";
  }
  return "MERGE";
}

export type DriveOutcome = (
  | { kind: "merged"; pr: number; headOid: string }
  | { kind: "needs-human"; pr: number; reason: string }
  | { kind: "queued"; pr: number; reason: string }
  | { kind: "stopped"; pr: number; reason: string } // produce-pr-and-stop: gates report, never merges
) & {
  /** The reviewer-failover audit signal for this tick (#54), when one applies. STATELESS —
   *  reported on every tick the condition holds (see ReviewFailoverTransition); the caller
   *  (conductor.ts tick()) dedups against the durable event log, then emits the structured
   *  event and posts the PR comment. Announcement lives with the caller because dedup needs
   *  the event log (State), which MergeDriver deliberately never touches. */
  reviewerTransition?: ReviewFailoverTransition;
};

export interface MergeDriverDeps {
  forge: IForge;
  reviewer: Reviewer;
  cfg: SapwoodConfig;
  /** Ordered reviewer-failover chain (cfg.reviewer.fallback, #54) — Reviewer instances, one per
   *  configured kind, built by the caller (reviewer.ts's makeFallbackReviewers). Empty/omitted
   *  -> resolveReviewVerdict always uses `reviewer`'s own verdict (today's behavior, unchanged). */
  fallbackReviewers?: readonly Reviewer[];
  /** Clock seed (#55 P1-B), injectable for tests — the wall-clock the trigger pin's `at` is
   *  stamped with. Defaults to the real clock. */
  now?: () => Date;
}

/**
 * The only class that calls forge.mergePR. Constructed and driven exclusively by the Conductor
 * (conductor.ts tick()) — a worker never holds a reference to this (structural
 * producer != merger, see module header).
 */
export class MergeDriver {
  constructor(private readonly deps: MergeDriverDeps) {}

  /** One gate + merge attempt for `pr`. Never throws — every forge failure resolves to
   *  "queued" (retried next tick) rather than propagating, so a transient gh hiccup can never
   *  crash the Conductor's tick loop or silently drop the PR from the driving lane.
   *
   *  `issue` (#46) lets the reviewer pull the driving lane's verification plan into the trigger
   *  comment. `triggerPin` is the lane's ENGINE-recorded last trigger (state.ts
   *  workers.review_triggered_head/at), supplied by the conductor; `recordTrigger` persists a
   *  NEW pin the instant this call posts one (also supplied by the conductor, backed by
   *  State.recordReviewTrigger) — MergeDriver never touches storage directly.
   *
   *  #55 P1-B: the review trigger now fires HERE, once the head is KNOWN to be consistent
   *  (below), rather than once-per-lane in the conductor. Any head the pin doesn't match —
   *  including the very first drive of a lane (pin.head === null) AND a later push that moves
   *  the PR to a new head mid-drive — gets a fresh `@codex review` and a freshly-recorded pin
   *  BEFORE any gate verdict is derived for that head; this also fixes a latent bug where a
   *  push after the lane's first trigger never got re-triggered at all.
   *
   *  `fallback` (#54) is optional so every pre-#54 call site (this whole test file) keeps
   *  working unchanged: omitted -> no lock, no reviewer-failover chain consulted, byte-for-byte
   *  the old behavior. When supplied, `lock` is the lane's State-recorded reviewer-failover
   *  lock (state.ts workers.review_fallback_head/kind) and `recordFallback` persists a NEW
   *  lock the instant resolveReviewVerdict (reviewer.ts) returns one that differs from it —
   *  same recordTrigger-callback pattern as above, so MergeDriver still never touches storage
   *  directly. */
  async driveOne(
    pr: number,
    issue: number,
    triggerPin: ReviewTriggerPin,
    recordTrigger: (head: string, at: string) => void,
    fallback?: { lock: ReviewFallbackLock; recordFallback: (lock: ReviewFallbackLock) => void },
    /** #147 P1 (Codex PR #151): true when this lane re-entered DRIVE via the conductor's GATED
     *  RECLAIM phase (gated_reentry_attempts > 0). A re-entered lane's head usually has NOT
     *  moved (a human resolved threads in place), so the ORIGINAL review that raised those
     *  threads still sits on the current head — and freshHeadReviewCount has no time filter, so
     *  once unresolvedThreads drops to 0 that STALE review would satisfy gate② without the
     *  freshly-triggered re-review ever responding. When set, reviews submitted at/before the
     *  recorded trigger pin's `at` are filtered out before any verdict is derived: a re-driven
     *  gate② counts only post-re-entry review signals. Optional — every pre-#147 caller (and
     *  every non-reentered lane) omits it: byte-for-byte the old behavior. */
    reentered?: boolean,
  ): Promise<DriveOutcome> {
    const { forge, reviewer, cfg } = this.deps;

    let status: PRStatus;
    let data: PRReviewData;
    try {
      // Both calls read-only; a rate-limit/timeout/transient gh error on EITHER must QUEUE —
      // never silently skip gate② and never escalate an infra hiccup to human triage (#13).
      // This is the same outcome reviewer.ts's "REVIEW_UNAVAILABLE" ReviewAction models for a
      // reviewer that detects unavailability itself (e.g. a future reviewer polling a status
      // API independently of forge.getPRReviewData) — deriveGate/mergeDecision both honor that
      // action identically to this early-return, whichever path produced it.
      [status, data] = await Promise.all([forge.getPRStatus(pr), forge.getPRReviewData(pr)]);
    } catch (e) {
      return { kind: "queued", pr, reason: `gate-data-unavailable: ${String(e)}` };
    }

    // An ALREADY-MERGED PR is terminal success, not human work (Codex PR #42 P2): in
    // produce-pr-and-stop mode the lane deliberately stays driving until a human merges, so
    // the next gate read seeing MERGED is the designed happy path — collapsing it to HUMAN
    // (via deriveGate's non-OPEN rule) marked the worker failed and labelled the issue
    // needs-human on success. Same for a manual merge racing conductor-merge mode. CLOSED
    // without merge still falls through to deriveGate -> HUMAN, which is genuinely human
    // territory. Checked on EITHER read: one may predate the merge, and this must win over
    // the head-mismatch queue below (a merged PR never re-gates).
    if (status.state === "MERGED" || data.state === "MERGED") {
      return { kind: "merged", pr, headOid: status.headOid };
    }

    // Both gate inputs MUST observe the SAME head (Codex PR #42 P1): the two reads above can
    // race a push — the CI read seeing old-green commit A while the review read sees
    // newly-reviewed commit B whose CI hasn't run would otherwise merge B on A's CI result.
    // Split observation -> queue and re-read next tick; never derive a gate from mixed heads.
    if (status.headOid !== data.headOid) {
      return { kind: "queued", pr, reason: `gate-head-mismatch: ci-head=${status.headOid} review-head=${data.headOid}` };
    }

    // #55 P1-B: the head is now KNOWN (both reads agree) — this is the one place that can
    // correctly decide whether the recorded trigger pin still applies. A mismatch covers BOTH
    // "never triggered" (triggerPin.head === null) and "triggered, but the PR was pushed since"
    // (triggerPin.head !== the live head) — either way, a stale/absent pin means gate②'s thumb
    // path must not evaluate against this head yet: post a fresh trigger, record it, and queue
    // this tick rather than deriving a verdict a push may have invalidated mid-flight.
    if (triggerPin.head !== status.headOid) {
      try {
        // #54 R2: a head change ends any failover episode — the fallback lock is head-scoped,
        // so a lock recorded for a previous head is cleared HERE, the one place that detects
        // the head moving. This is the ONLY drive-path clear (Codex PR #71 P2: never cleared
        // at verdict-resolution time); a confirmed merge ends the lane, taking the row with it.
        if (fallback && fallback.lock.head != null && fallback.lock.head !== status.headOid) {
          fallback.recordFallback(NO_FALLBACK_LOCK);
        }
        await reviewer.triggerReview(forge, pr, issue);
        const now = this.deps.now ?? (() => new Date());
        recordTrigger(status.headOid, now().toISOString());
      } catch (e) {
        // never-throws contract (round-2 P2): a transient comment-post (or pin-write) failure
        // must QUEUE — the conductor's tick calls driveOne unguarded, so a throw here would
        // crash the whole tick loop. Retried next tick. If the trigger comment DID post but the
        // pin write failed, the retry re-posts a duplicate trigger comment (harmless) rather
        // than ever counting thumbs against an unrecorded pin — fail-closed either way.
        return { kind: "queued", pr, reason: `review-trigger-failed: ${String(e)}` };
      }
      return { kind: "queued", pr, reason: "review-triggered" };
    }

    // #147 P1 (Codex PR #151, rounds 1+2): re-entry review-freshness cutoff — TWO-PHASE.
    // Reached only once the pin matches the live head — i.e. the re-entry's OWN trigger has
    // already been posted and recorded (the reclaim cleared the pin, so the branch above
    // always fires first). On a re-entered lane the head is typically unchanged, so the
    // pre-escalation review (the very one whose threads caused the HANDLE_THREADS) still
    // matches freshHeadReviewCount's head check and would otherwise turn into MERGE_OK the
    // moment the threads read resolved. But a wholesale time filter is wrong too (round-2 P1):
    // changesRequestedOnHead is PER-AUTHOR standing state — a human's undismissed
    // CHANGES_REQUESTED on this head must keep blocking even though it predates the re-entry
    // (a fresh review from a DIFFERENT reviewer cannot speak for it), while an APPROVED plays
    // a dual role (accept signal AND same-author CR-clear signal), so dropping old APPROVEDs
    // while keeping old CRs would falsely re-block an already-cleared request. Hence:
    //
    //  Phase 1 — standing-block check on the UNFILTERED set: if any non-author reviewer's
    //  standing state on the current head is CHANGES_REQUESTED (changesRequestedOnHead,
    //  imported from reviewer.ts — same per-author clear semantics the verdict itself uses),
    //  SKIP the time filter entirely and derive the verdict from the full data. The standing
    //  CR then drives the normal blocking path (HANDLE_THREADS -> re-escalation): removing
    //  needs-human after only resolving threads, while a change request stands undismissed,
    //  re-escalates — it never merges and never waits forever.
    //
    //  Phase 2 — no standing block: apply the cutoff filter. With no CR in the picture,
    //  dropping pre-pin reviews only removes ACCEPT signals — safe and fail-closed: a missing/
    //  unparseable submittedAt or pin `at` excludes the review (zero reviews -> WAIT_REVIEW ->
    //  queued, waiting for the fresh re-review). Numeric epoch compare, not lexicographic —
    //  the engine pin carries ms precision while GitHub timestamps are second-granularity, so
    //  a same-second review truncates to the pin's second and fails the strict `>`
    //  (fail-closed; the genuine re-review arrives minutes later; freshThumbCount's
    //  convention, reviewer.ts). Live unresolvedThreads is NOT filtered in either phase —
    //  it's current thread state, not a historical signal, and blocks on its own.
    //
    // Non-reentered lanes never enter this branch: gate② semantics there are unchanged.
    if (reentered && !changesRequestedOnHead(data.reviews, data.headOid, data.author)) {
      const cutoff = triggerPin.at == null ? NaN : Date.parse(triggerPin.at);
      data = {
        ...data,
        reviews: Number.isFinite(cutoff)
          ? data.reviews.filter((r) => {
              const t = r.submittedAt == null ? NaN : Date.parse(r.submittedAt);
              return Number.isFinite(t) && t > cutoff;
            })
          : [], // no usable pin time -> no review can prove it post-dates the re-entry
      };
    }

    // #54: which reviewer's verdict gates THIS tick — the primary's, or (only once explicitly
    // opted into via cfg.reviewer.fallback, and only past cfg.reviewer.failoverAfterSec of
    // primary unavailability) a fallback's. `fallback` omitted -> identical to the pre-#54
    // `reviewer.verdictFromData(data, triggerPin)` call this replaces.
    const resolved = resolveReviewVerdict({
      primary: reviewer,
      fallbacks: this.deps.fallbackReviewers ?? [],
      data,
      triggerPin,
      now: (this.deps.now ?? (() => new Date()))(),
      failoverAfterSec: cfg.reviewer.failoverAfterSec,
      lock: fallback?.lock ?? NO_FALLBACK_LOCK,
    });
    const verdict = resolved.verdict;

    // Persist the lock only when it actually changed — which, post-R2, is only ever "a
    // fallback reached MERGE_OK on this head" (resolveReviewVerdict never clears; the head-
    // change clear lives in the trigger branch above).
    if (fallback && (resolved.lock.head !== fallback.lock.head || resolved.lock.kind !== fallback.lock.kind)) {
      fallback.recordFallback(resolved.lock);
    }

    // Audit trail (#54): the switch/revert signal rides the outcome; conductor.ts tick()
    // dedups it against the durable event log, emits the structured event, and posts the PR
    // comment (see DriveOutcome.reviewerTransition). Not announced here: the signal is
    // stateless-per-tick and MergeDriver has no event-log access to dedup with.
    const withTransition = (outcome: DriveOutcome): DriveOutcome =>
      resolved.transition ? { ...outcome, reviewerTransition: resolved.transition } : outcome;

    const gate = deriveGate({
      ciGreen: status.ciGreen,
      reviewAction: verdict.action,
      isDraft: data.isDraft,
      prState: data.state,
      labels: data.labels,
      humanLabels: cfg.escalation.humanLabels,
    });

    if (gate === "WAIT") return withTransition({ kind: "queued", pr, reason: `gate-pending:${verdict.action}` });
    if (gate === "HUMAN") return withTransition({ kind: "needs-human", pr, reason: `gate:${gate}:${verdict.action}` });

    // gate === "MERGE" from here on.
    if (cfg.merge.mode === "produce-pr-and-stop") {
      return withTransition({ kind: "stopped", pr, reason: `gates-passed:${verdict.action}` });
    }

    // Final safety net (0day's actual pre-merge re-check), evaluated on the SAME
    // freshly-fetched action/labels/state as the gate above — defense in depth, not a
    // duplicate: this is the function unit-tested for row-for-row bash parity.
    const decision = mergeDecision(verdict.action, data.labels.join(","), data.state, false, cfg.escalation.humanLabels);
    if (decision === "WAIT") return withTransition({ kind: "queued", pr, reason: `merge-decision:${decision}` });
    if (decision === "ESCALATE") return withTransition({ kind: "needs-human", pr, reason: `merge-decision:${decision}` });

    if (verdict.headOid == null) {
      // Should not happen when gate === MERGE (a verdict only reaches MERGE_OK with a headOid
      // attached) — fail-safe: refuse an unpinned merge rather than guess.
      return withTransition({ kind: "needs-human", pr, reason: "refuse-unpinned-merge-no-head-oid" });
    }

    // Deterministic un-mergeability is HUMAN work, not a retry (Codex PR #42 P2): a
    // CONFLICTING PR fails `gh pr merge` forever, so returning "queued" would pin the lane
    // in `driving` re-attempting every tick. UNKNOWN means GitHub is still computing
    // mergeability (transient, normal right after a push) — that one queues.
    if (status.mergeable === "CONFLICTING") {
      return withTransition({ kind: "needs-human", pr, reason: "merge-conflict" });
    }
    if (status.mergeable === "UNKNOWN") {
      return withTransition({ kind: "queued", pr, reason: "mergeability-unknown" });
    }

    try {
      // --match-head-commit (GithubForge.mergePR) pins the TOCTOU guard to the exact head this
      // gate check just passed against — a push between the gate check and this call fails the
      // merge command itself rather than silently merging an unreviewed new head.
      await forge.mergePR(pr, verdict.headOid);
    } catch (e) {
      // A merge failure with MERGEABLE status is either the TOCTOU pin firing (GitHub 409
      // "Head branch was modified" — a push raced us; re-gate next tick) or a transient gh/
      // network error. Both are safe to queue: the merge did not happen. Deterministic
      // "not mergeable" errors (conflict surfaced between our status read and the merge
      // call) must escalate instead of retrying forever.
      const msg = String(e);
      if (/not mergeable|merge conflict/i.test(msg)) {
        return withTransition({ kind: "needs-human", pr, reason: `merge-failed-deterministic: ${msg}` });
      }
      return withTransition({ kind: "queued", pr, reason: `merge-failed-retry: ${msg}` });
    }
    return withTransition({ kind: "merged", pr, headOid: verdict.headOid });
  }
}
