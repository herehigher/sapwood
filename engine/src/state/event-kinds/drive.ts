// PR-drive event kinds (#425): everything a lane's PR does after it exists — the drive gate,
// merge and rollback, CI pins, the #147 gated-reentry handshake, and the whole fix loop (legs,
// caps, responses, thread writes). Review VERDICT machinery lives in review.ts.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const DRIVE_EVENT_KINDS = defineKinds({
  // Drive-gate dispositions.
  "drive-queued": {
    tags: ["pr-touched", "round-artifact"],
    meaning: "a PR was checked against gate② and left queued (not yet mergeable, no action taken).",
    actionability: "routine",
  },
  "drive-stopped": {
    tags: ["pr-touched", "round-artifact"],
    meaning: "driving a PR stopped this tick (breaker/budget/cap reached), to be retried a later tick.",
    actionability: "routine",
  },
  "drive-needs-human": {
    tags: ["retro", "pr-touched", "round-artifact", "escalation-source:payload"],
    meaning:
      'a DRIVING lane was moved to needs-human ("the machine is stuck" / "a human owes the next decision"); the payload\'s `reason` identifies the cause — a gate② verdict OR a drain-* budget/kill-switch drain (conductor.ts\'s ceiling/kill-switch driving-lane drain path also writes this kind, not gate② alone) — and `labeled` records whether the label write itself landed.',
    actionability: "intervene",
  },
  "drive-no-pr": {
    tags: ["round-artifact", "escalation-source:always"],
    meaning: "a driving lane has no PR to drive (ESCALATE_NOPR) — done but no PR was ever opened; always proven by presence.",
    actionability: "intervene",
  },
  "drive-fixup": {
    tags: [],
    meaning: "gate② returned FIXUP — a fix leg was dispatched against the PR's outstanding findings.",
    actionability: "routine",
  },
  "drive-human-merge-only": {
    tags: [],
    meaning:
      "gate② classified the PR as human-merge-only (bucket 2, #397/#292 instruction-path trust chain) — the PR is fine, but its merge decision is a human's, one-way and never re-decided.",
    actionability: "intervene",
    see: "#292",
  },
  "drive-thread-writes-pending": {
    tags: [],
    meaning: "a fix leg's review-thread reply/resolve writes are still queued for this PR; driving deferred until they drain.",
    actionability: "routine",
  },

  // Merge + rollback.
  merged: {
    tags: ["pr-touched", "round-artifact", "escalation-clear"],
    meaning: "a PR was merged by the conductor (CI green + a fresh review, per the configured merge gate).",
    actionability: "routine",
  },
  "rollback-recovered": {
    tags: ["round-artifact"],
    meaning: "a pending board-status rollback (#31) succeeded on retry; the durable rollback record is cleared.",
    actionability: "routine",
  },
  "rollback-escalated": {
    tags: ["round-artifact", "escalation-source:never"],
    meaning:
      "a pending board-status rollback exhausted its retry cap; `never` a proof of the needs-human label (the write attempted here is itself best-effort).",
    actionability: "intervene",
  },
  "rollback-retry-failed": {
    tags: [],
    meaning: "one attempt at a pending board-status rollback failed, under the retry cap; retried next tick.",
    actionability: "expected-noise",
  },

  // PR custody + CI pins.
  "pr-held": {
    tags: [],
    meaning: "a PR is being held from driving because a human hold label was observed on it (#441).",
    actionability: "routine",
    see: "#441",
  },
  "pr-released": {
    tags: [],
    meaning: "a previously-held PR's hold label was no longer observed; driving resumed.",
    actionability: "routine",
  },
  // #399: the engine's own BELIEF about the PR-side lane-state label — the dedup memory the
  // per-tick mirror folds (lane-state-label.ts). Untagged like pr-held/pr-released above: pure
  // visibility bookkeeping, no consumer surface beyond its own fold.
  "lane-state-labeled": {
    tags: [],
    meaning:
      "the engine's per-tick lane-state mirror (#399) applied/updated the PR-side lane-state label to match this lane's current state.",
    actionability: "routine",
    see: "#399",
  },
  "lane-state-cleared": {
    tags: [],
    meaning: "the engine's per-tick lane-state mirror (#399) removed the PR-side lane-state label (the lane no longer needs one).",
    actionability: "routine",
    see: "#399",
  },
  "ci-pending-observed": {
    tags: [],
    meaning: "gate① (CI) is decisive-pending on a PR's head — opens the CI-pending pin the escalation timer reads.",
    actionability: "routine",
  },
  "ci-pending-escalated": {
    tags: [],
    meaning:
      "a PR's CI stayed PENDING past the escalation bound while gate② was already decisive, so it can never progress on its own; labeled needs-human.",
    actionability: "intervene",
  },
  // #783: the companion to ci-pending-escalated for the CONCLUDED-but-not-green rollup — every
  // check finished, none failed, but at least one concluded without passing (SKIPPED/NEUTRAL/
  // CANCELLED/STALE/ACTION_REQUIRED). Unlike a pending rollup this can never resolve on its own
  // head no matter how long it waits, so it escalates on its own (shorter) bound, `ci.inertEscalateAfterSec`,
  // rather than sharing `ci.pendingEscalateAfterSec`'s clock. Registration/schema only here — the
  // live escalation that actually emits this kind is the human-owned remainder (merge-driver.ts/
  // conductor.ts are guard-protected paths this issue does not touch); see drive.ts's
  // buildCiInertEscalationPayload/buildCiInertEscalationComment for the producer-reachable
  // building blocks this kind's eventual payload/comment are built from.
  "ci-inert-escalated": {
    tags: [],
    meaning:
      "a PR's CI concluded without ever going green (no check still running, none failed, at least one concluded without passing) — it can never progress on its own; labeled needs-human.",
    actionability: "intervene",
    see: "#783",
  },
  "ci-pending-cleared": {
    tags: [],
    meaning: "a PR's CI-pending pin closed (resolved green/red, or the head moved) — cancels the escalation timer.",
    actionability: "routine",
  },

  // #147 gated reentry.
  "gated-reentry": {
    tags: ["round-artifact", "escalation-clear"],
    meaning: "a human removed a lane's escalation label, and the #147 handshake re-admitted the lane for one bounded reentry attempt.",
    actionability: "routine",
    see: "#147",
  },
  "gated-reentry-capped": {
    tags: ["round-artifact", "escalation-source:always"],
    meaning: "a lane exhausted its bounded #147 gated-reentry attempts; always proven by presence.",
    actionability: "intervene",
    see: "#147",
  },
  // `never`: the label write is precisely what failed here, so its absence is the engine's own
  // footprint, not a human's.
  "gated-reentry-capped-label-failed": {
    tags: ["escalation-source:never"],
    meaning:
      "the needs-human re-apply write for a gated-reentry-capped lane failed; `never` a proof (the write's own failure is the point).",
    actionability: "investigate",
  },
  // The two GATED RECLAIM collection terminals (no reentry is attempted, so neither burns an
  // attempt and neither is an attention item).
  "gated-reentry-merged": {
    tags: [],
    meaning: "a gated-reentry lane's PR was found already merged; the lane was collected as done rather than reentered.",
    actionability: "routine",
  },
  "gated-reentry-issue-closed": {
    tags: [],
    meaning: "a gated-reentry lane's issue was found already closed; the lane was collected as done rather than reentered.",
    actionability: "routine",
  },
  // #685 gate② finding [1] round 3 ("null-pin-anything"): the null-candidate (comment-cursor-
  // stale) reclaim path's staging tick — no reentry happened yet, so untagged/routine like the
  // two collection terminals just above.
  "gated-reentry-candidate-staged": {
    tags: [],
    meaning:
      "a gated-reentry lane whose escalation never pinned a body-hash candidate (comment-cursor-stale) had one staged from the live body on this tick's first observation of the cleared hold; reentry itself waits for a later tick to reconfirm it.",
    actionability: "routine",
    see: "#685",
  },

  // Fix legs. The three `fix-leg` tagged kinds carry the journal cursor fix-response.ts reads
  // back — that tag is ALSO what obliges them to a payload type (payloads.ts).
  "fix-leg-started": {
    tags: ["fix-leg"],
    meaning: "a fresh fix leg was dispatched against a PR's outstanding findings/verdict.",
    actionability: "routine",
  },
  "fix-leg-resumed": {
    tags: ["fix-leg"],
    meaning: "an in-flight fix leg was resumed by a fresh worker session after a handoff/restart.",
    actionability: "routine",
  },
  "fix-leg-adopted": {
    tags: ["fix-leg"],
    meaning: "the engine adopted a fix-leg process it found already running at startup rather than treating it as orphaned.",
    actionability: "routine",
  },
  "fix-leg-adopted-drained": {
    tags: [],
    meaning: "an adopted fix-leg process was found already drained (finished) by the time the engine looked.",
    actionability: "routine",
  },
  "fix-leg-dispatch-blocked": {
    tags: [],
    meaning:
      "dispatching a fix leg was blocked by an admission check this tick (e.g. an open llm park episode); retried once the block clears.",
    actionability: "expected-noise",
  },
  "fix-leg-dispatch-failed": {
    tags: [],
    meaning: "starting a fix leg's process/session failed; the PR stays queued for a later retry.",
    actionability: "investigate",
  },
  "fix-leg-dispatch-unconfigured": {
    tags: [],
    meaning:
      "a fix leg was called for but the fix loop is not configured/attached this run (e.g. `prFixCap: 0` or no proxy) — escalates to needs-human.",
    actionability: "intervene",
  },
  "fix-leg-resume-failed": {
    tags: [],
    meaning: "resuming an in-flight fix leg threw; the error is rethrown/surfaced, not silently absorbed.",
    actionability: "investigate",
  },
  "fix-leg-resume-no-pr": {
    tags: [],
    meaning: "resuming a fix leg found no PR for the lane; the row is left untouched for a later retry.",
    actionability: "investigate",
  },
  "fix-leg-resume-unconfigured": {
    tags: [],
    meaning: "resuming a fix leg found the fix loop unconfigured for this run; the row is left untouched (`handoff`), retried later.",
    actionability: "expected-noise",
  },
  "fix-leg-undecidable": {
    tags: ["escalation-source:always"],
    meaning: "a fix leg's outcome could not be determined from the ledger; always proven by presence.",
    actionability: "intervene",
  },
  "fix-leg-undecidable-label-failed": {
    tags: [],
    meaning: "the needs-human label write for an undecidable fix leg failed; the lane may be escalated with no visible label.",
    actionability: "investigate",
  },
  "fix-leg-verdict-rerun": {
    tags: ["escalation-source:always"],
    meaning:
      "the same review verdict would have dispatched a second fix leg (the breaker that prevents a rerun loop); always proven by presence.",
    actionability: "intervene",
  },

  // Fix-round cap.
  "fix-rounds-capped": {
    tags: ["escalation-source:always"],
    meaning: "a PR exhausted its configured fix-round budget (#295's most common escalation); always proven by presence.",
    actionability: "intervene",
    see: "#295",
  },
  "fix-rounds-cap-label-failed": {
    tags: [],
    meaning: "the needs-human label write for a fix-rounds-capped PR failed; the lane stays queued and is retried.",
    actionability: "investigate",
  },
  "fix-rounds-cap-comment-failed": {
    tags: [],
    meaning: "the explanatory PR comment for a fix-rounds-capped PR failed to post; the durable event/label are unaffected.",
    actionability: "routine",
  },

  // Fix responses + thread writes.
  "fix-response-invalid": {
    tags: [],
    meaning: "a fix leg's settled output failed validation (malformed/incomplete response) and was rejected rather than queued.",
    actionability: "investigate",
  },
  "fix-response-queued": {
    tags: [],
    meaning: "a fix leg's settled output was validated and its review-thread reply/resolve writes were queued for posting.",
    actionability: "routine",
  },
  "fix-thread-reply-posted": {
    tags: [],
    meaning: "a queued fix-leg reply was successfully posted to its review thread.",
    actionability: "routine",
  },
  "fix-thread-resolved": {
    tags: [],
    meaning: "a queued fix-leg resolution successfully marked its review thread resolved.",
    actionability: "routine",
  },
  "fix-thread-write-escalated": {
    tags: [],
    meaning:
      "a queued thread-write (reply/resolve) exhausted its retry budget; escalated to needs-human on the PR (#398 — PR-born, its issue-side twin was deleted).",
    actionability: "intervene",
    see: "#398",
  },
  "fix-thread-write-escalation-label-failed": {
    tags: [],
    meaning: "the needs-human label write for an escalated thread-write failure itself failed; the durable event is the only record.",
    actionability: "investigate",
  },
  "fix-thread-write-retry-failed": {
    tags: [],
    meaning: "one attempt at a queued thread-write failed, under the retry cap; retried next tick.",
    actionability: "expected-noise",
  },

  // Misc drive-path records.
  "ac-snapshot-drift": {
    tags: [],
    meaning:
      "a PR's issue body changed after its acceptance-criteria snapshot was taken (#279 §5); the lane fails closed and needs-human is applied outside the event-kind escalation-source table (its own bespoke label site, escalation-buckets.test.ts's SITE_INVENTORY).",
    actionability: "intervene",
    see: "#279",
  },
  "blocked-by-cleared": {
    tags: [],
    meaning: "a `blocked-by:<issue>` fence label was removed because the referenced blocker issue had already closed (#485).",
    actionability: "routine",
    see: "#485",
  },
  "drain-driving-escalation-label-failed": {
    tags: [],
    meaning:
      "the needs-human label write for a driving lane drained by a ceiling/kill-switch failed; the lane may be escalated with no visible label.",
    actionability: "investigate",
  },
  "drain-driving-escalation-comment-failed": {
    tags: [],
    meaning: "the explanatory PR comment for a drained driving lane's escalation failed to post; the label/event are unaffected.",
    actionability: "routine",
  },
});
