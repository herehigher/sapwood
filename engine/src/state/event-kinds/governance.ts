// Governance event kinds (#425): the peripheral roles that decide WHAT gets worked on and
// whether it may proceed — align/triage/proposals, the PO's structured dissent, plan review,
// the architect, the round pool, harvest and retro.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const GOVERNANCE_EVENT_KINDS = defineKinds({
  // Align.
  "align-summary": ["round-artifact"],
  "align-skipped": [],
  "backlog-read-failed": [],
  "goal-file-unreadable": [],

  // Round pool.
  "pool-selected": [],
  "pool-labels-failed": [],
  "pool-reconcile-incomplete": [],
  "pool-selection-decision-lost": [],
  // #374 review (Codex sol-high finding 4, P2): align.ts's po-pool selection session's own
  // degrade event. It was entirely ABSENT from ROUND_ARTIFACT_EVENT_KINDS for a milestone, so a
  // pool-selection-only quota storm (roles.po.poolSelection: true) never showed up in
  // degradedPhases at all and round.ts's empty-spin breaker could never see it — the exact
  // cross-list-omission class the registry's completeness test now guards.
  "pool-degraded": ["round-artifact"],
  "round-pool-removal-capped": ["escalation-source:payload"],

  // Triage.
  "triage-body-committed": [],
  "triage-comment-posted": [],
  "triage-decision-accepted": ["dissent-decision"],
  "triage-decision-lost": [],
  "triage-effects-committed": [],
  "triage-stale-hash-skipped": [],
  "triage-degraded": ["round-artifact"],

  // Proposals / decomposition.
  "proposal-created": [],
  "proposal-comment-posted": [],
  "proposal-set-persisted": ["dissent-decision"],
  "proposal-skipped": [],
  "proposal-journal-corrupt": [],

  // Structured dissent (#237/#432). `concern-posted` is the receipt half of the pending-concern
  // fold; `concern-post-escalated` is `payload` because the shared writer appends it
  // unconditionally and records the label outcome in `labeled`.
  // `round-artifact` (#237): concerns actually DELIVERED this round (dissent.ts's postConcerns).
  "concern-posted": ["round-artifact", "dissent-receipt"],
  "concern-adjudicated": [],
  "concern-post-failed": [],
  "concern-post-escalated": ["escalation-source:payload"],

  // Plan review. `plan-review-escalated` is `never`, classified by its WEAKEST emission site —
  // see ESCALATION_SOURCES' own note for the false-clear risk `always` would have created.
  "plan-approved": [],
  "plan-review-escalated": ["retro", "round-artifact", "escalation-source:never"],
  "verify-na-proposed": ["escalation-source:always"],

  // Architect.
  "architect-review-degraded": [],
  "architect-degraded": ["round-artifact"],
  "architect-verdict-applied": [],
  "architect-verdict-lost": [],

  // Harvest + retro.
  "po-degraded": ["round-artifact"],
  "harvest-degraded": ["round-artifact"],
  "retro-degraded": ["round-artifact"],
  "retro-pr-opened": ["round-artifact"],
  "retro-pr-degraded": ["round-artifact"],
});
