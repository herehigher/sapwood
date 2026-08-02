// Review event kinds (#425): gate② itself — the engine-agent review runner's honest-recording
// events, the #54 reviewer failover announcements, and the two dispute/convergence escalations.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const REVIEW_EVENT_KINDS = defineKinds({
  // #54 reviewer failover. Written from a template literal (`reviewer-fallback-${t.kind}`) in
  // conductor.ts — `t.kind` is a literal union, so the template-literal type narrows to exactly
  // these two and a third transition kind would fail to compile until it is declared here.
  "reviewer-fallback-switch": ["round-artifact"],
  "reviewer-fallback-revert": ["round-artifact"],

  // The engine-agent review runner's own records (review/codex-exec.ts, review/production.ts).
  "engine-review-verdict": [],
  "engine-review-budget-advisory": [],
  "engine-review-cost-unknown": [],
  "engine-review-containment-gap": [],
  "engine-review-orphaned-group": [],
  "engine-review-session-inspection": [],

  // Reviewer silence.
  "review-silence-escalated": [],

  // #451 dispute pricing / #450 convergence stop. Both terminals are `always` — each is appended
  // strictly AFTER its own addLabel AND addIssueComment returned, and each failure path appends
  // only its own companion `-label-failed`/`-comment-failed` (never an escalation source, same
  // label-first-or-no-event doctrine as `gated-reentry-capped-label-failed`).
  "review-disputed": ["escalation-source:always"],
  "review-disputed-label-failed": [],
  "review-disputed-comment-failed": [],
  "review-non-convergent": ["escalation-source:always"],
  "review-non-convergent-label-failed": [],
  "review-non-convergent-comment-failed": [],
});
