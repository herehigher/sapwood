// Review event kinds (#425): gate② itself — the engine-agent review runner's honest-recording
// events, the #54 reviewer failover announcements, and the two dispute/convergence escalations.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const REVIEW_EVENT_KINDS = defineKinds({
  // #54 reviewer failover. Written from a template literal (`reviewer-fallback-${t.kind}`) in
  // conductor.ts — `t.kind` is a literal union, so the template-literal type narrows to exactly
  // these two and a third transition kind would fail to compile until it is declared here.
  "reviewer-fallback-switch": {
    tags: ["round-artifact"],
    meaning: "the configured reviewer (e.g. hosted Codex) was unavailable, so gate② fell back to the alternate reviewer for this PR (#54).",
    actionability: "investigate",
    see: "#54",
  },
  "reviewer-fallback-revert": {
    tags: ["round-artifact"],
    meaning: "the configured reviewer became available again; gate② reverted off the fallback reviewer (#54).",
    actionability: "routine",
    see: "#54",
  },

  // The engine-agent review runner's own records (review/codex-exec.ts, review/production.ts).
  "engine-review-verdict": {
    tags: [],
    meaning: "the engine-agent review runner recorded its structured verdict (approved/rejected + evidence/findings) for a PR.",
    actionability: "routine",
  },
  "engine-review-budget-advisory": {
    tags: [],
    meaning:
      "announced before an engine-agent review session starts: `reviewer.agent.costCapUsd` is advisory only, since the codex-exec runner has no hard-cap mechanism to enforce it (#443).",
    actionability: "routine",
    see: "#443",
  },
  "engine-review-cost-unknown": {
    tags: [],
    meaning:
      "an engine-agent review session ended with no usable token/cost telemetry; its spend is UNKNOWN and is never read as $0 (#443).",
    actionability: "investigate",
    see: "#443",
  },
  "engine-review-containment-gap": {
    tags: [],
    meaning:
      "recorded at every codex-exec spawn: the named containment blind spots (model-invoked shell execution, host-wide read scope) the sandbox does not close (#443).",
    actionability: "routine",
    see: "#443",
  },
  "engine-review-orphaned-group": {
    tags: [],
    meaning:
      "a timed-out engine-agent review session's process group was still observable after the SIGKILL escalation; the review settles as `timeout` regardless, but something may still be running on the host (#443).",
    actionability: "investigate",
    see: "#443",
  },
  "engine-review-session-inspection": {
    tags: [],
    meaning:
      "how many tool/command items an engine-agent review session's own stream reported it ran; evidence only, never a gate — nothing derives a verdict from it (#512).",
    actionability: "routine",
    see: "#512",
  },

  // Reviewer silence.
  "review-silence-escalated": {
    tags: [],
    meaning:
      "a PR's gate② review request produced no verdict past the configured silence bound; labeled needs-human for visibility (#170).",
    actionability: "intervene",
    see: "#170",
  },

  // #451 dispute pricing / #450 convergence stop. Both terminals are `always` — each is appended
  // strictly AFTER its own addLabel AND addIssueComment returned, and each failure path appends
  // only its own companion `-label-failed`/`-comment-failed` (never an escalation source, same
  // label-first-or-no-event doctrine as `gated-reentry-capped-label-failed`).
  "review-disputed": {
    tags: ["escalation-source:always"],
    meaning: "successive gate② reviews disagreed past the dispute-pricing bound (#451); always proven by presence.",
    actionability: "intervene",
    see: "#451",
  },
  "review-disputed-label-failed": {
    tags: [],
    meaning: "the needs-human label write for a review-disputed PR failed; the durable event is the only record.",
    actionability: "investigate",
  },
  "review-disputed-comment-failed": {
    tags: [],
    meaning: "the explanatory PR comment for a review-disputed PR failed to post; the label/event are unaffected.",
    actionability: "routine",
  },
  "review-non-convergent": {
    tags: ["escalation-source:always"],
    meaning: "successive fix-leg review rounds failed to converge past the configured bound (#450); always proven by presence.",
    actionability: "intervene",
    see: "#450",
  },
  "review-non-convergent-label-failed": {
    tags: [],
    meaning: "the needs-human label write for a review-non-convergent PR failed; the durable event is the only record.",
    actionability: "investigate",
  },
  "review-non-convergent-comment-failed": {
    tags: [],
    meaning: "the explanatory PR comment for a review-non-convergent PR failed to post; the label/event are unaffected.",
    actionability: "routine",
  },

  // #652: the comment-adjudication cursor's shared degrade — recorded at whichever checkpoint
  // (gate⓪ pre-spend/pre-apply, dispatch, drive) observed the stale/invalid cursor. `tags: []`,
  // like `ac-snapshot-drift` (drive.ts): needs-human is applied outside the event-kind
  // escalation-source table — its own bespoke label site is classified in
  // escalation-buckets.test.ts's SITE_INVENTORY instead.
  "comment-cursor-stale": {
    tags: [],
    meaning:
      "a checkpoint (gate⓪, dispatch, or drive) found the issue's comment-adjudication cursor stale or invalid relative to its own comment thread and refused to spend/dispatch/drive; needs-human applied with a deduplicated pointer comment.",
    actionability: "intervene",
    see: "#652",
  },
});
