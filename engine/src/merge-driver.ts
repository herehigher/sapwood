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
import type { Reviewer, ReviewAction } from "./reviewer.js";

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

export type DriveOutcome =
  | { kind: "merged"; pr: number; headOid: string }
  | { kind: "needs-human"; pr: number; reason: string }
  | { kind: "queued"; pr: number; reason: string }
  | { kind: "stopped"; pr: number; reason: string }; // produce-pr-and-stop: gates report, never merges

export interface MergeDriverDeps {
  forge: IForge;
  reviewer: Reviewer;
  cfg: SapwoodConfig;
}

/**
 * The only class that calls forge.mergePR. Constructed and driven exclusively by the Conductor
 * (conductor.ts tick()) — a worker never holds a reference to this (structural
 * producer != merger, see module header).
 */
export class MergeDriver {
  constructor(private readonly deps: MergeDriverDeps) {}

  /** Post the review trigger (e.g. `@codex review`) once per PR. Idempotent to call more than
   *  once (a plain comment); the caller (conductor.ts) tracks "already triggered" per lane so it
   *  calls this at most once per driving lane, not every tick. */
  async ensureTriggered(pr: number): Promise<void> {
    await this.deps.reviewer.triggerReview(this.deps.forge, pr);
  }

  /** One gate + merge attempt for `pr`. Never throws — every forge failure resolves to
   *  "queued" (retried next tick) rather than propagating, so a transient gh hiccup can never
   *  crash the Conductor's tick loop or silently drop the PR from the driving lane. */
  async driveOne(pr: number): Promise<DriveOutcome> {
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

    const verdict = reviewer.verdictFromData(data);
    const gate = deriveGate({
      ciGreen: status.ciGreen,
      reviewAction: verdict.action,
      isDraft: data.isDraft,
      prState: data.state,
      labels: data.labels,
      humanLabels: cfg.escalation.humanLabels,
    });

    if (gate === "WAIT") return { kind: "queued", pr, reason: `gate-pending:${verdict.action}` };
    if (gate === "HUMAN") return { kind: "needs-human", pr, reason: `gate:${gate}:${verdict.action}` };

    // gate === "MERGE" from here on.
    if (cfg.merge.mode === "produce-pr-and-stop") {
      return { kind: "stopped", pr, reason: `gates-passed:${verdict.action}` };
    }

    // Final safety net (0day's actual pre-merge re-check), evaluated on the SAME
    // freshly-fetched action/labels/state as the gate above — defense in depth, not a
    // duplicate: this is the function unit-tested for row-for-row bash parity.
    const decision = mergeDecision(verdict.action, data.labels.join(","), data.state, false, cfg.escalation.humanLabels);
    if (decision === "WAIT") return { kind: "queued", pr, reason: `merge-decision:${decision}` };
    if (decision === "ESCALATE") return { kind: "needs-human", pr, reason: `merge-decision:${decision}` };

    if (verdict.headOid == null) {
      // Should not happen when gate === MERGE (a verdict only reaches MERGE_OK with a headOid
      // attached) — fail-safe: refuse an unpinned merge rather than guess.
      return { kind: "needs-human", pr, reason: "refuse-unpinned-merge-no-head-oid" };
    }
    try {
      // --match-head-commit (GithubForge.mergePR) pins the TOCTOU guard to the exact head this
      // gate check just passed against — a push between the gate check and this call fails the
      // merge command itself rather than silently merging an unreviewed new head.
      await forge.mergePR(pr, verdict.headOid);
    } catch (e) {
      return { kind: "queued", pr, reason: `merge-failed-retry: ${String(e)}` };
    }
    return { kind: "merged", pr, headOid: verdict.headOid };
  }
}
