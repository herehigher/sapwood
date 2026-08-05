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
  "run-started": { tags: [], meaning: "the engine process booted and began ticking.", actionability: "routine" },
  "run-ended": { tags: [], meaning: "the engine process shut down (normal exit or drain).", actionability: "routine" },
  "tick-error": {
    tags: [],
    meaning: "an uncaught error surfaced during one tick-loop iteration; the loop itself kept running.",
    actionability: "investigate",
  },
  "instance-lock-taken-over": {
    tags: [],
    meaning: "a stale instance lock from a dead PID was taken over so this run could proceed (#382).",
    actionability: "investigate",
  },
  "deploy-key-tier-detected": {
    tags: [],
    meaning:
      "startup recorded the effective worker-credential tier (L0/L1) and which deploy-key arm produced it — visibility, not a gate (#671).",
    actionability: "routine",
    see: "#671",
  },

  // Liveness watchdog + the run-level breakers (rapid-restart, consecutive-stalls, idle-churn).
  // None of these are `escalation-source:*` — see ESCALATION_SOURCES' own "DELIBERATELY ABSENT"
  // block for the ruling: each carries its waiting-on-a-human state in a durable park episode,
  // not in an issue-keyed needs-human label.
  "engine-stalled": { tags: [], meaning: "the liveness watchdog observed the engine make no progress.", actionability: "investigate" },
  "engine-restart-after-stall": {
    tags: [],
    meaning: "the engine restarted itself after a detected stall.",
    actionability: "expected-noise",
  },
  "rapid-restart-detected": {
    tags: [],
    meaning:
      'the crash-loop breaker tripped on restart cadence; enters a probe-less "rapid-restart" park episode that clears only when a later start observes the birth window drained, or a human clears it.',
    actionability: "intervene",
    see: "#431",
  },
  "consecutive-stalls-detected": {
    tags: [],
    meaning:
      'the stall breaker (#407) tripped on a run of consecutive stalls; enters a probe-less "consecutive-stalls" park episode that clears only when a later start observes the streak broken, or a human clears it.',
    actionability: "intervene",
    see: "#407",
  },
  "idle-churn-detected": {
    tags: [],
    meaning:
      'the idle-churn breaker (#470) tripped: rounds are opening and closing cleanly but nothing consumable exists upstream, K times over; enters a probe-less "idle-churn" park episode that clears only when a human clears it.',
    actionability: "intervene",
    see: "#470",
  },
  "empty-spin-park": {
    tags: [],
    meaning:
      'the empty-spin breaker (#374) tripped after N consecutive rounds dispatched nothing with a fully degraded peripheral session; enters an "llm" park episode.',
    actionability: "intervene",
    see: "#374",
  },

  // Park episode lifecycle (shared by every breaker + the canary probe).
  "park-probe": {
    tags: [],
    meaning: "a scheduled probe attempt fired against an open llm/forge park episode to test whether the environment recovered.",
    actionability: "routine",
  },
  "park-escalated": {
    tags: [],
    meaning:
      "an open park episode's probe/attempt budget was exhausted (or a probe-less breaker's condition held); the episode now needs human attention.",
    actionability: "intervene",
  },
  "park-resumed": {
    tags: [],
    meaning: "a park episode cleared — the environment probed healthy, a canary succeeded, or a human ran `sapwood park clear`.",
    actionability: "routine",
  },
  "park-canary": {
    tags: [],
    meaning: 'an in-flight canary lane was dispatched to test whether an "llm" park episode\'s environment has recovered.',
    actionability: "routine",
  },
  "park-canary-failed": {
    tags: [],
    meaning: 'the in-flight canary lane failed, so the "llm" park episode stays open for another probe cycle.',
    actionability: "expected-noise",
  },
  "park-canary-inconclusive": {
    tags: [],
    meaning: 'the in-flight canary lane produced no decisive verdict; the "llm" park episode stays open.',
    actionability: "expected-noise",
  },
  "park-wait-heartbeat": {
    tags: [],
    meaning:
      "a per-cadence heartbeat proving the loop is still alive while parked or otherwise waiting (F29's replacement for a silent gap).",
    actionability: "routine",
  },

  // Standby.
  "standby-wait": {
    tags: [],
    meaning: "the loop entered a backoff wait because the prior round dispatched nothing (the idle-round precondition, #125).",
    actionability: "routine",
  },
  "standby-exit": { tags: [], meaning: "standby ended and the loop resumed normal round ticking.", actionability: "routine" },
  "standby-heartbeat": {
    tags: [],
    meaning: "a per-slice heartbeat emitted during a long standby wait, separate from standby-wait's own per-backoff-step event (#395).",
    actionability: "routine",
  },

  // Round loop mechanics.
  "round-phase": {
    tags: [],
    meaning: "a round transitioned into a named phase (aligning, architecting, executing, ...).",
    actionability: "routine",
  },
  "round-stop": {
    tags: ["round-artifact"],
    meaning: "a round loop stopped early, with the sentinel/breaker name and detail that caused the stop.",
    actionability: "investigate",
  },
  "reconcile-completed": {
    tags: [],
    meaning: "a reconcile pass over lane/PR state finished, carrying its own ok/count/orphans/overflow summary.",
    actionability: "routine",
  },
  "role-debris-swept": {
    tags: [],
    meaning: "leftover session/worktree debris from a peripheral role session was cleaned up.",
    actionability: "routine",
  },

  // Cost ceiling (the breach state itself; the per-lane `ceiling-escalated` lives in lane.ts).
  "ceiling-breach-entered": {
    tags: [],
    meaning: "a cost-ceiling reason (per-run/per-day/...) newly joined the set of currently-breached reasons.",
    actionability: "investigate",
  },
  "ceiling-breach-cleared": {
    tags: [],
    meaning: "a cost-ceiling reason left the set of currently-breached reasons (including the total-clear case).",
    actionability: "routine",
  },

  // Base-branch CI observation (#502). `base-ci-red-escalated` is deliberately NOT an
  // `escalation-source:*` — a red default branch is a RUN-level fact with no issue to key on;
  // its resolution is escalation-reconcile.ts's own base-green observer.
  "base-ci-red-observed": {
    tags: [],
    meaning: "the default branch's CI was observed red (#502); opens the standing base-red episode.",
    actionability: "investigate",
    see: "#502",
  },
  "base-ci-red-escalated": {
    tags: [],
    meaning:
      "the standing base-red episode persisted long enough to escalate; not issue-keyed, so it is not an escalation-source (no needs-human label to remove).",
    actionability: "intervene",
    see: "#502",
  },
  "base-ci-red-cleared": {
    tags: [],
    meaning: "a NEWER base-ci-red-observed/cleared pair showed the default branch's CI green again; closes the standing episode.",
    actionability: "routine",
    see: "#502",
  },

  // Config / forge / proxy plumbing that reports at run scope.
  "directive-applied": {
    tags: [],
    meaning: "an operator directive file was read, substituted into this round's align/architect/triage prompts, and archived.",
    actionability: "routine",
  },
  "forge-page-ceiling": {
    tags: [],
    meaning: "a paginated GitHub read hit its configured page ceiling and returned a truncated result.",
    actionability: "investigate",
  },
  "web-access-denied-by-operator-settings": {
    tags: [],
    meaning: "a role's WebFetch/WebSearch grant was denied at startup because it conflicts with the operator's own Claude Code settings.",
    actionability: "investigate",
  },
  "user-settings-drift-detected": {
    tags: [],
    meaning:
      "the operator's Claude Code user settings changed since the engine last observed them (permission/hook drift the loop did not cause).",
    actionability: "investigate",
  },
  "fix-loop-unattached": {
    tags: [],
    meaning: "startup recorded that `prFixCap > 0` but the forge proxy is unavailable, so the fix loop cannot attach this run (#385).",
    actionability: "investigate",
    see: "#385",
  },
  "labels-reconciled": {
    tags: [],
    meaning: "startup provisioned any missing required GitHub labels for this board.",
    actionability: "routine",
  },
  "board-normalized": {
    tags: [],
    meaning: "an issue with no board Status was moved onto the board (defaulted to backlog).",
    actionability: "routine",
  },
  "board-gap-detected": {
    tags: [],
    meaning: "open issues exist that are unplaced on the ProjectV2 board; carries the total/shown/elsewhere counts.",
    actionability: "investigate",
  },
  "proxy-mint-failed": {
    tags: [],
    meaning:
      "the forge MCP proxy failed to mint a scoped token for a lane/role; the caller degrades per its own fail-open/fail-closed branch (#244).",
    actionability: "investigate",
    see: "#244",
  },
  "egress-suspect": {
    tags: ["round-artifact"],
    meaning:
      "a worker or peripheral session's transcript showed a network-egress-shaped tool call (curl, WebFetch/WebSearch, ...) — informational, never an escalation (#341, #410).",
    actionability: "investigate",
    see: "#410",
  },
});
