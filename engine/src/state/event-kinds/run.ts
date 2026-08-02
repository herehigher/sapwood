// Run/process-lifecycle event kinds (#425): everything scoped to the RUN rather than to a lane or
// a PR — boot and shutdown, the tick loop itself, the four run-level breakers and their park
// episodes, standby, and the config/forge/proxy plumbing that reports at run scope.
//
// APPEND AT THE END of the relevant block. The per-domain split exists so parallel lanes editing
// different subsystems don't collide in one shared file; appending keeps two lanes editing the
// SAME subsystem to a one-line conflict instead of an interleave.
import { defineKinds } from "./types.js";

export const RUN_EVENT_KINDS = defineKinds({
  // Process lifecycle.
  "run-started": [],
  "run-ended": [],
  "tick-error": [],
  "instance-lock-taken-over": [],

  // Liveness watchdog + the run-level breakers (rapid-restart, consecutive-stalls, idle-churn).
  // None of these are `escalation-source:*` — see ESCALATION_SOURCES' own "DELIBERATELY ABSENT"
  // block for the ruling: each carries its waiting-on-a-human state in a durable park episode,
  // not in an issue-keyed needs-human label.
  "engine-stalled": [],
  "engine-restart-after-stall": [],
  "rapid-restart-detected": [],
  "consecutive-stalls-detected": [],
  "idle-churn-detected": [],
  "empty-spin-park": [],

  // Park episode lifecycle (shared by every breaker + the canary probe).
  "park-probe": [],
  "park-escalated": [],
  "park-resumed": [],
  "park-canary": [],
  "park-canary-failed": [],
  "park-canary-inconclusive": [],
  "park-wait-heartbeat": [],

  // Standby.
  "standby-wait": [],
  "standby-exit": [],
  "standby-heartbeat": [],

  // Round loop mechanics.
  "round-phase": [],
  "round-stop": ["round-artifact"],
  "reconcile-completed": [],
  "role-debris-swept": [],

  // Cost ceiling (the breach state itself; the per-lane `ceiling-escalated` lives in lane.ts).
  "ceiling-breach-entered": [],
  "ceiling-breach-cleared": [],

  // Base-branch CI observation (#502). `base-ci-red-escalated` is deliberately NOT an
  // `escalation-source:*` — a red default branch is a RUN-level fact with no issue to key on;
  // its resolution is escalation-reconcile.ts's own base-green observer.
  "base-ci-red-observed": [],
  "base-ci-red-escalated": [],
  "base-ci-red-cleared": [],

  // Config / forge / proxy plumbing that reports at run scope.
  "directive-applied": [],
  "forge-page-ceiling": [],
  "web-access-denied-by-operator-settings": [],
  "fix-loop-unattached": [],
  "labels-reconciled": [],
  "board-normalized": [],
  "board-gap-detected": [],
  "proxy-mint-failed": [],
  "egress-suspect": ["round-artifact"],
});
