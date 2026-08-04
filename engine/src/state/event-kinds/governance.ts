// Governance event kinds (#425): the peripheral roles that decide WHAT gets worked on and
// whether it may proceed — align/triage/proposals, the PO's structured dissent, plan review,
// the architect, the round pool, harvest and retro.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const GOVERNANCE_EVENT_KINDS = defineKinds({
  // Align.
  "align-summary": {
    tags: ["round-artifact"],
    meaning: "the align phase finished and recorded its round summary (what it read, what it decided).",
    actionability: "routine",
  },
  "align-skipped": {
    tags: [],
    meaning: "the align phase was skipped this round (role disabled, or no candidate work).",
    actionability: "routine",
  },
  "backlog-read-failed": {
    tags: [],
    meaning: "align's read of the Ready backlog/board failed this round; an honesty event, not a silent empty result.",
    actionability: "investigate",
  },
  "goal-file-unreadable": {
    tags: [],
    meaning: "the operator's goal file could not be read for this round's align/architect prompts.",
    actionability: "investigate",
  },

  // Round pool.
  "pool-selected": {
    tags: [],
    meaning: "the PO's round-pool selection session chose which issues enter this round's pool.",
    actionability: "routine",
  },
  "pool-labels-failed": {
    tags: [],
    meaning: "applying the round-pool label to a selected issue failed; the issue may be selected without a visible label.",
    actionability: "investigate",
  },
  "pool-reconcile-incomplete": {
    tags: [],
    meaning:
      "removing the round-pool label from one or more issues at pool-close failed (#432 R5); carries the failed issue list for the next reconcile pass.",
    actionability: "investigate",
    see: "#432",
  },
  "pool-selection-decision-lost": {
    tags: [],
    meaning: "the round-pool selection session's decision failed to persist; an honesty event, not a silent no-op.",
    actionability: "investigate",
  },
  // #374 review (Codex sol-high finding 4, P2): align.ts's po-pool selection session's own
  // degrade event. It was entirely ABSENT from ROUND_ARTIFACT_EVENT_KINDS for a milestone, so a
  // pool-selection-only quota storm (roles.po.poolSelection: true) never showed up in
  // degradedPhases at all and round.ts's empty-spin breaker could never see it — the exact
  // cross-list-omission class the registry's completeness test now guards.
  "pool-degraded": {
    tags: ["round-artifact"],
    meaning: "the PO's round-pool selection session degraded/failed this round (#374).",
    actionability: "investigate",
    see: "#374",
  },
  "round-pool-removal-capped": {
    tags: ["escalation-source:payload"],
    meaning:
      "removing a stale round-pool label exhausted its retry budget and escalated to needs-human via the shared writer; proof of the label write rides in the payload.",
    actionability: "intervene",
  },

  // Triage.
  "triage-body-committed": {
    tags: [],
    meaning: "a triage decision's guarded issue-body write landed (the durable half of the decision).",
    actionability: "routine",
  },
  "triage-comment-posted": {
    tags: [],
    meaning: "a triage decision's explanatory issue comment was posted.",
    actionability: "routine",
  },
  "triage-decision-accepted": {
    tags: ["dissent-decision"],
    meaning: "a triage decision was accepted and recorded as a durable dissent-decision receipt.",
    actionability: "routine",
  },
  "triage-decision-lost": {
    tags: [],
    meaning: "a triage decision failed to persist; an honesty event, not a silent no-op.",
    actionability: "investigate",
  },
  "triage-effects-committed": {
    tags: [],
    meaning:
      "a triage decision's final step (comment posted, or the no-plan-after fence applied) landed — the decision is now fully, durably effected.",
    actionability: "routine",
  },
  "triage-stale-hash-skipped": {
    tags: [],
    meaning:
      "a triage candidate's content hash no longer matched what the decision was made against (the issue changed underneath); skipped rather than acting on stale information.",
    actionability: "routine",
  },
  "triage-degraded": {
    tags: ["round-artifact"],
    meaning: "the triage phase degraded/failed this round.",
    actionability: "investigate",
  },

  // Proposals / decomposition.
  "proposal-created": {
    tags: [],
    meaning: "the PO's decomposition session created a child-issue proposal for a parent issue.",
    actionability: "routine",
  },
  "proposal-comment-posted": {
    tags: [],
    meaning: "a decomposition proposal's explanatory comment was posted on its parent issue.",
    actionability: "routine",
  },
  "proposal-set-persisted": {
    tags: ["dissent-decision"],
    meaning: "a decomposition's full set of proposals was durably persisted as a dissent-decision receipt.",
    actionability: "routine",
  },
  "proposal-skipped": {
    tags: [],
    meaning:
      "a decomposition proposal was skipped this round (title collision, receipt/live mismatch, or another named reason carried in the payload).",
    actionability: "investigate",
  },
  "proposal-journal-corrupt": {
    tags: [],
    meaning: "the decomposition journal read back malformed/unparseable; decomposition halts rather than acting on it.",
    actionability: "investigate",
  },

  // Structured dissent (#237/#432). `concern-posted` is the receipt half of the pending-concern
  // fold; `concern-post-escalated` is `payload` because the shared writer appends it
  // unconditionally and records the label outcome in `labeled`.
  // `round-artifact` (#237): concerns actually DELIVERED this round (dissent.ts's postConcerns).
  "concern-posted": {
    tags: ["round-artifact", "dissent-receipt"],
    meaning: "a PO structured-dissent concern (#237) was delivered — posted to the issue this round.",
    actionability: "investigate",
    see: "#237",
  },
  "concern-adjudicated": {
    tags: [],
    meaning: "a previously posted dissent concern was resolved (external reply, label change, or another recognized adjudication signal).",
    actionability: "routine",
    see: "#237",
  },
  "concern-post-failed": {
    tags: [],
    meaning: "one attempt to post a dissent concern failed, under the retry cap; retried next round.",
    actionability: "expected-noise",
  },
  "concern-post-escalated": {
    tags: ["escalation-source:payload"],
    meaning:
      "posting a dissent concern exhausted its retry budget and escalated to needs-human via the shared writer; proof of the label write rides in the payload.",
    actionability: "intervene",
  },

  // Plan review. `plan-review-escalated` is `never`, classified by its WEAKEST emission site —
  // see ESCALATION_SOURCES' own note for the false-clear risk `always` would have created.
  "plan-approved": {
    tags: [],
    meaning: "the plan-review session approved an issue's verification plan for this round (#214).",
    actionability: "routine",
    see: "#214",
  },
  "plan-review-escalated": {
    tags: ["retro", "round-artifact", "escalation-source:never"],
    meaning:
      "the plan-review session's self-heal (draft→re-review cycles) was exhausted for an issue, or the session itself crashed/timed out; escalated to needs-human.",
    actionability: "intervene",
  },
  "verify-na-proposed": {
    tags: ["escalation-source:always"],
    meaning:
      "the plan-review session proposed `verify:n/a` for an issue (unverifiable work, doc-gate path) and applied the label; a human must adjudicate the proposal — always proven by presence.",
    actionability: "intervene",
    see: "#296",
  },

  // Architect.
  "architect-review-degraded": {
    tags: [],
    meaning: "the architect's own review session degraded/failed this round.",
    actionability: "investigate",
  },
  "architect-degraded": {
    tags: ["round-artifact"],
    meaning: "the architect's batch-review pool-verdict phase degraded/failed this round.",
    actionability: "investigate",
  },
  "architect-verdict-applied": {
    tags: [],
    meaning: "the architect's pool verdict for an issue (label/board effect) was applied.",
    actionability: "routine",
  },
  "architect-verdict-lost": {
    tags: [],
    meaning: "the architect's pool verdict for an issue failed to persist; an honesty event, not a silent no-op.",
    actionability: "investigate",
  },

  // Harvest + retro.
  "po-degraded": {
    tags: ["round-artifact"],
    meaning: "the PO's phase degraded/failed this round.",
    actionability: "investigate",
  },
  "harvest-degraded": {
    tags: ["round-artifact"],
    meaning: "the harvest phase degraded/failed this round.",
    actionability: "investigate",
  },
  "retro-degraded": {
    tags: ["round-artifact"],
    meaning: "the retro phase degraded/failed this round.",
    actionability: "investigate",
  },
  "retro-pr-opened": {
    tags: ["round-artifact"],
    meaning: "retro opened a documentation/round-close PR summarizing this round's durable-knowledge changes.",
    actionability: "routine",
  },
  "retro-pr-degraded": {
    tags: ["round-artifact"],
    meaning: "retro's PR-opening step degraded/failed this round.",
    actionability: "investigate",
  },
});
