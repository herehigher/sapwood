// Lane-lifecycle event kinds (#425): a worker lane from dispatch to reclaim — dispatch, reclaim,
// resume, handoff, env-failure, worktree custody, orphan sweeps, and the peripheral-role session
// equivalents. Everything about a lane's PR lives in drive.ts instead.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const LANE_EVENT_KINDS = defineKinds({
  // Dispatch.
  dispatched: ["round-artifact", "escalation-clear"],
  "dispatch-failed": [],

  // Reclaim. Both reclaim terminals are PREDICATED escalation sources (#404): attention items
  // only for the payloads escalation-reconcile.ts's `reclaimNeedsAttention` admits — the tag
  // carries the proof mode, the predicate stays with the reader that owns the semantics.
  "reclaim-done": ["round-artifact", "escalation-source:always"],
  "reclaim-failed": ["round-artifact", "escalation-source:always"],
  "reclaim-dead": ["round-artifact"],

  // Handoff / resume.
  handoff: ["retro", "round-artifact"],
  resumed: [],
  "resume-failed": [],
  "resume-capped": ["escalation-source:always"],
  "resume-capped-label-failed": [],
  "resume-undecidable": ["escalation-source:always"],
  "resume-undecidable-label-failed": [],
  // `resume-held` is DELIBERATELY not an escalation source (#441) — it observes somebody else's
  // hold label rather than creating an attention item, and a row here would block the sweep of
  // the very stale label that produced it.
  "resume-held": [],

  // Environment failure / lane revival.
  "env-failure": [],
  "env-failure-preserved": ["escalation-source:never"],
  "lane-adopted": [],
  "lane-pr-unknown": [],
  "lane-revived": ["escalation-clear"],
  "lane-revival-terminal": [],

  // Cost ceiling, per lane (the run-level breach state lives in run.ts).
  "ceiling-escalated": ["retro", "round-artifact", "escalation-source:never"],

  // Worktree custody.
  "worktree-retained": [],
  "worktree-released": [],

  // Orphan detection + the mid-run orphan sweep (#384).
  "orphan-detected": [],
  "orphan-healed": [],
  "orphan-heal-failed": [],
  "orphan-sweep-checked": [],
  "orphan-pr-escalated": ["escalation-source:payload"],
  "gated-flag-unprovable": [],
  "gated-flag-healed": [],

  // Worker + peripheral-role session telemetry.
  "worker-heartbeat": [],
  "role-session-heartbeat": [],
  "role-env-failure": [],
  "role-session-exit-lost": [],
  "role-session-spawn-timeout": [],
  "role-worktree-retained": [],
});
