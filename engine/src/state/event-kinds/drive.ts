// PR-drive event kinds (#425): everything a lane's PR does after it exists — the drive gate,
// merge and rollback, CI pins, the #147 gated-reentry handshake, and the whole fix loop (legs,
// caps, responses, thread writes). Review VERDICT machinery lives in review.ts.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const DRIVE_EVENT_KINDS = defineKinds({
  // Drive-gate dispositions.
  "drive-queued": ["pr-touched", "round-artifact"],
  "drive-stopped": ["pr-touched", "round-artifact"],
  "drive-needs-human": ["retro", "pr-touched", "round-artifact", "escalation-source:payload"],
  "drive-no-pr": ["round-artifact", "escalation-source:always"],
  "drive-fixup": [],
  "drive-human-merge-only": [],
  "drive-thread-writes-pending": [],

  // Merge + rollback.
  merged: ["pr-touched", "round-artifact", "escalation-clear"],
  "rollback-recovered": ["round-artifact"],
  "rollback-escalated": ["round-artifact", "escalation-source:never"],
  "rollback-retry-failed": [],

  // PR custody + CI pins.
  "pr-held": [],
  "pr-released": [],
  "ci-pending-observed": [],
  "ci-pending-escalated": [],
  "ci-pending-cleared": [],

  // #147 gated reentry.
  "gated-reentry": ["round-artifact", "escalation-clear"],
  "gated-reentry-capped": ["round-artifact", "escalation-source:always"],
  // `never`: the label write is precisely what failed here, so its absence is the engine's own
  // footprint, not a human's.
  "gated-reentry-capped-label-failed": ["escalation-source:never"],
  // The two GATED RECLAIM collection terminals (no reentry is attempted, so neither burns an
  // attempt and neither is an attention item).
  "gated-reentry-merged": [],
  "gated-reentry-issue-closed": [],

  // Fix legs. The three `fix-leg` tagged kinds carry the journal cursor fix-response.ts reads
  // back — that tag is ALSO what obliges them to a payload type (payloads.ts).
  "fix-leg-started": ["fix-leg"],
  "fix-leg-resumed": ["fix-leg"],
  "fix-leg-adopted": ["fix-leg"],
  "fix-leg-adopted-drained": [],
  "fix-leg-dispatch-blocked": [],
  "fix-leg-dispatch-failed": [],
  "fix-leg-dispatch-unconfigured": [],
  "fix-leg-resume-failed": [],
  "fix-leg-resume-no-pr": [],
  "fix-leg-resume-unconfigured": [],
  "fix-leg-undecidable": ["escalation-source:always"],
  "fix-leg-undecidable-label-failed": [],
  "fix-leg-verdict-rerun": ["escalation-source:always"],

  // Fix-round cap.
  "fix-rounds-capped": ["escalation-source:always"],
  "fix-rounds-cap-label-failed": [],
  "fix-rounds-cap-comment-failed": [],

  // Fix responses + thread writes.
  "fix-response-invalid": [],
  "fix-response-queued": [],
  "fix-thread-reply-posted": [],
  "fix-thread-resolved": [],
  "fix-thread-write-escalated": [],
  "fix-thread-write-escalation-label-failed": [],
  "fix-thread-write-retry-failed": [],

  // Misc drive-path records.
  "ac-snapshot-drift": [],
  "blocked-by-cleared": [],
  "drain-driving-escalation-label-failed": [],
  "drain-driving-escalation-comment-failed": [],
});
