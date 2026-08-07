// Lane-lifecycle event kinds (#425): a worker lane from dispatch to reclaim — dispatch, reclaim,
// resume, handoff, env-failure, worktree custody, orphan sweeps, and the peripheral-role session
// equivalents. Everything about a lane's PR lives in drive.ts instead.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const LANE_EVENT_KINDS = defineKinds({
  // Dispatch.
  dispatched: {
    tags: ["round-artifact", "escalation-clear"],
    meaning: "a worker lane was dispatched for a Ready issue, in its own worktree.",
    actionability: "routine",
  },
  "dispatch-failed": {
    tags: [],
    meaning: "dispatching a lane for a Ready issue failed (worktree/spawn/write error).",
    actionability: "investigate",
  },

  // Reclaim. Both reclaim terminals are PREDICATED escalation sources (#404): attention items
  // only for the payloads escalation-reconcile.ts's `reclaimNeedsAttention` admits — the tag
  // carries the proof mode, the predicate stays with the reader that owns the semantics.
  "reclaim-done": {
    tags: ["round-artifact", "escalation-source:always"],
    meaning:
      "a finished worker lane was reclaimed cleanly; whether it needs attention is a predicate over the payload (#404), not the kind alone.",
    actionability: "investigate",
    see: "#404",
  },
  "reclaim-failed": {
    tags: ["round-artifact", "escalation-source:always"],
    meaning:
      "reclaiming a finished worker lane failed; whether it needs attention is a predicate over the payload (#404), not the kind alone.",
    actionability: "investigate",
    see: "#404",
  },
  "reclaim-dead": {
    tags: ["round-artifact"],
    meaning: "a worker lane was reclaimed as DEAD (crashed/unresponsive process).",
    actionability: "investigate",
  },
  // #724 gate② P1: EMERGENCY_STOP's own durable-pid sweep (round.ts) — a `driving`/`handoff`
  // row whose DURABLE persisted process identity (never the in-memory supervisor, which a
  // crash-resumed process cannot have) read confirmed-alive gets signalled directly, bypassing
  // the ordinary tick()-only kill path entirely. `confirmedDead` (payload) is the post-signal
  // probe's own verdict — `false` means the kill could not be verified (an orphan process
  // group), never silently dropped; cli.ts's roundsExitCode already forces this run's exit code
  // non-zero once `stoppedBy` names "emergency-stop" regardless of this outcome.
  // #724 gate② round 3, P1-2: escalation-source:always — needs-human, proven by PRESENCE alone
  // (the SAME "resume-capped"/"resume-undecidable" shape above), never by a forge label: the
  // E-STOP sweep that appends this (round.ts) is a hard-stop path that must stay network-free
  // end to end (P1-1), so it never calls addLabel. Clears the same way `env-failure-preserved`
  // does — via the issue reaching a terminal GitHub state, since no label was ever applied for
  // escalation-sweep.ts's "label absence is only a human act if the engine provably applied the
  // label" doctrine to observe.
  "estop-lane-swept": {
    tags: ["round-artifact", "escalation-source:always"],
    meaning:
      "under EMERGENCY_STOP, a driving/handoff lane's durable process identity was found alive and signalled directly (TERM then KILL), then the row was settled to `failed` in the same step so no later reconciliation can revive it; confirmedDead records whether a post-signal check verified the kill. needs-human, always proven by presence.",
    actionability: "intervene",
    see: "#293",
  },

  // Handoff / resume.
  handoff: {
    tags: ["retro", "round-artifact"],
    meaning:
      "a worker lane handed off gracefully (soft cost-limit reached): WIP committed+pushed, progress note left, `.handoff` sentinel written.",
    actionability: "routine",
  },
  resumed: { tags: [], meaning: "a handed-off lane was resumed by a fresh worker session.", actionability: "routine" },
  "resume-failed": {
    tags: [],
    meaning: "resuming a handed-off lane failed this attempt; eligible for a further retry.",
    actionability: "expected-noise",
  },
  "resume-capped": {
    tags: ["escalation-source:always"],
    meaning: "a handed-off lane exhausted its resume-attempt budget (#172); needs-human, always proven by presence.",
    actionability: "intervene",
    see: "#172",
  },
  "resume-capped-label-failed": {
    tags: [],
    meaning: "the needs-human label write for a resume-capped lane failed; the lane may be escalated with no visible label.",
    actionability: "investigate",
  },
  "resume-undecidable": {
    tags: ["escalation-source:always"],
    meaning: "a handoff lane's resume outcome could not be determined (#172); needs-human, always proven by presence.",
    actionability: "intervene",
    see: "#172",
  },
  "resume-undecidable-label-failed": {
    tags: [],
    meaning: "the needs-human label write for a resume-undecidable lane failed; the lane may be escalated with no visible label.",
    actionability: "investigate",
  },
  // `resume-held` is DELIBERATELY not an escalation source (#441) — it observes somebody else's
  // hold label rather than creating an attention item, and a row here would block the sweep of
  // the very stale label that produced it.
  "resume-held": {
    tags: [],
    meaning:
      "a handoff lane's resume was skipped because the issue already carries a human hold label (#441) — an observation, not a new escalation.",
    actionability: "routine",
    see: "#441",
  },

  // Environment failure / lane revival.
  "env-failure": {
    tags: [],
    meaning: "a lane hit an LLM/forge environment failure mid-work (the source that can enter an env-failure park episode).",
    actionability: "investigate",
  },
  "env-failure-preserved": {
    tags: ["escalation-source:never"],
    meaning:
      "an env-failed lane's state was preserved with zero forge writes (the forge may itself be down); `never` a proof of the needs-human label.",
    actionability: "investigate",
  },
  "lane-adopted": {
    tags: [],
    meaning: "the engine adopted a lane it found already running/pushed at startup rather than treating it as orphaned.",
    actionability: "routine",
  },
  "lane-pr-unknown": {
    tags: [],
    meaning: "a lane's PR association came back UNKNOWN (transient forge write failure); the lane is deferred rather than settled (#377).",
    actionability: "expected-noise",
    see: "#377",
  },
  "lane-revived": {
    tags: ["escalation-clear"],
    meaning: "an env-failed lane holding an OPEN PR was revived back to `driving` rather than left stranded between owners (#447).",
    actionability: "routine",
    see: "#447",
  },
  "lane-revival-terminal": {
    tags: [],
    meaning:
      "the revival pass found the lane's PR already MERGED (recorded for the merged case only) and closed it out instead of reviving it (#447).",
    actionability: "routine",
    see: "#447",
  },

  // Cost ceiling, per lane (the run-level breach state lives in run.ts).
  "ceiling-escalated": {
    tags: ["retro", "round-artifact", "escalation-source:never"],
    meaning:
      "a lane was drained for a cost/wall-clock ceiling breach; `never` a proof of the needs-human label (the drain's own label write is best-effort).",
    actionability: "intervene",
  },

  // Worktree custody.
  "worktree-retained": {
    tags: [],
    meaning: "a lane's worktree was kept on disk (dirty/uncommitted state) instead of being deleted on reclaim, for a human to salvage.",
    actionability: "investigate",
  },
  "worktree-released": {
    tags: [],
    meaning: "a lane's worktree was deleted after reclaim (clean, nothing to salvage).",
    actionability: "routine",
  },

  // Orphan detection + the mid-run orphan sweep (#384).
  "orphan-detected": {
    tags: [],
    meaning: "a worktree/branch with no matching worker row was found (#384 mid-run sweep or startup reconcile).",
    actionability: "investigate",
    see: "#384",
  },
  "orphan-healed": { tags: [], meaning: "a detected orphan was reconciled back into a tracked lane.", actionability: "routine" },
  "orphan-heal-failed": {
    tags: [],
    meaning: "healing a detected orphan failed; it remains untracked for the next sweep.",
    actionability: "investigate",
  },
  "orphan-sweep-checked": {
    tags: [],
    meaning: "the mid-run orphan sweep (#384) ran and found nothing new to heal.",
    actionability: "routine",
    see: "#384",
  },
  "orphan-pr-escalated": {
    tags: ["escalation-source:payload"],
    meaning: "an orphaned lane's PR was escalated to needs-human; proof of the label write rides in the payload.",
    actionability: "intervene",
  },
  "gated-flag-unprovable": {
    tags: [],
    meaning:
      "a gated-reentry lane's escalation label could not be found on either carrier (#391/#398) — a standing alarm, one per engine start, for a lane only a human can move.",
    actionability: "intervene",
    see: "#391",
  },
  "gated-flag-healed": {
    tags: [],
    meaning: "a gated-reentry lane's escalation label was found on one carrier and the local flag was corrected to match (#391/#398).",
    actionability: "routine",
    see: "#391",
  },
  "gated-lane-retired": {
    tags: [],
    meaning:
      "a gated-reentry lane was retired (not reentered) because the audit proved it terminal by merge or issue-close (#593) — nothing left to reenter.",
    actionability: "routine",
    see: "#593",
  },

  // Worker + peripheral-role session telemetry.
  "worker-heartbeat": {
    tags: [],
    meaning: "a per-cadence heartbeat proving an in-flight worker lane is still alive.",
    actionability: "routine",
  },
  "role-session-heartbeat": {
    tags: [],
    meaning: "a per-cadence heartbeat proving an in-flight peripheral role session is still alive.",
    actionability: "routine",
  },
  "role-env-failure": {
    tags: [],
    meaning:
      "a peripheral role session hit an LLM/forge environment failure; the durable record IS this event (no companion -degraded event).",
    actionability: "investigate",
  },
  "role-session-exit-lost": {
    tags: [],
    meaning: "a peripheral role session's process exited without the engine observing its outcome (result lost).",
    actionability: "investigate",
  },
  "role-session-spawn-timeout": {
    tags: [],
    meaning: "spawning a peripheral role session timed out before it could start doing work.",
    actionability: "investigate",
  },
  "role-worktree-retained": {
    tags: [],
    meaning: "a peripheral role session's worktree was kept on disk (uncommitted edits behind) instead of being deleted.",
    actionability: "investigate",
  },

  // #705: the live-process identity fact `sapwood status`'s per-lane runtime anchors read.
  "lane-spawned": {
    tags: [],
    meaning:
      "a worker lane got a NEW live child process (fresh dispatch, an ordinary/fix-leg resume, or a cross-restart " +
      "adoption of an already-confirmed spawn) — carries the pid + worktree path `status` folds newest-per-lane.",
    actionability: "routine",
    see: "#705",
  },
});
