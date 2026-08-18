// Lane-lifecycle event kinds (#425): a worker lane from dispatch to reclaim — dispatch, reclaim,
// resume, handoff, env-failure, worktree custody, orphan sweeps, and the peripheral-role session
// equivalents. Everything about a lane's PR lives in drive.ts instead.
//
// APPEND AT THE END of the relevant block (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const LANE_EVENT_KINDS = defineKinds({
  // Dispatch.
  dispatched: {
    tags: ["round-artifact", "escalation-clear", "lane-session-start"],
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
  "reclaim-dead-comment-failed": {
    tags: [],
    meaning: "the explanatory PR comment for an engine-opened dead-lane rescue failed; the needs-human labels remain applied.",
    actionability: "routine",
    see: "#719",
  },
  // #724 gate② P1: EMERGENCY_STOP's own durable-pid sweep (round.ts) — a `driving`/`handoff`
  // row whose DURABLE persisted process identity (never the in-memory supervisor, which a
  // crash-resumed process cannot have) read confirmed-alive gets signalled directly, bypassing
  // the ordinary tick()-only kill path entirely. `confirmedDead` (payload) is the post-signal
  // probe's own verdict — `false` means the kill could not be verified (an orphan process
  // group), never silently dropped; cli.ts's roundsExitCode already forces this run's exit code
  // non-zero once `stoppedBy` names "emergency-stop" regardless of this outcome.
  // #724 gate② round 4, P1-2 (correcting round 3's own mistake): escalation-source:NEVER, not
  // `always` — `always` means "this event cannot exist unless the engine's OWN label write
  // landed" (escalation-reconcile.ts's `labelProven` gate, consumed by `observeResolution`'s
  // `label-removed` arm), and this sweep never calls `addLabel` at all (P1-1's "zero forge
  // calls" — a hard-stop path that must stay network-free end to end). Tagging it `always` would
  // let escalation-sweep.ts treat a LATER-missing needs-human label as proof a human resolved
  // THIS escalation and safely remove it — but no label was ever ours to begin with, so that
  // "removal" could delete a completely unrelated, human-applied needs-human label. `never` is
  // the SAME proof mode `env-failure-preserved`/`ceiling-escalated` use for exactly this reason
  // (their own doc, escalation-reconcile.ts): the item still surfaces on the dashboard's
  // needs-attention strip (presence alone is still enough to open it — `attentionProof` reads
  // the registry regardless of proof mode), it just NEVER auto-clears via "the label went away"
  // — only via the issue itself reaching a terminal GitHub state (closed).
  "estop-lane-swept": {
    tags: ["round-artifact", "escalation-source:never"],
    meaning:
      "under EMERGENCY_STOP, a driving/handoff lane's durable process identity was found alive and signalled directly (TERM then KILL), then the row was settled to `failed` in the same step so no later reconciliation can revive it; confirmedDead records whether a post-signal check verified the kill. Needs-human, but never label-proven — no forge write ever backs it.",
    actionability: "intervene",
    see: "#293",
  },
  // #724 gate② round 4, P1-1: the crash-rerun safety marker — appended BEFORE the sweep's first
  // signal, never after. A crash between this event and the eventual `estop-lane-swept`
  // completion leaves the row still `driving`/`handoff`; `State.estopSweepIntentOpen` folds this
  // pair to tell a restart's OWN sweep (never conductor.ts's ordinary reconciliation — see that
  // method's own doc for why it is guaranteed to run first) "this lane was already decided
  // must-settle," not a fresh candidate. Not an escalation source on its own — the terminal
  // `estop-lane-swept` (or, on a capability-less restart, `estop-lane-sweep-incapable` below)
  // is what an operator needs to see; this is the durable intermediate fact those two read back.
  "estop-lane-sweep-started": {
    tags: ["round-artifact"],
    meaning:
      "the E-STOP durable-pid sweep (round.ts) decided a driving/handoff lane is confirmed alive and is about to signal it — written before the first signal, for crash-rerun safety.",
    actionability: "routine",
    see: "#293",
  },
  // #724 gate② round 4, P2-3: durablePidAlive/signalDurablePid are ONE capability on a
  // Supervisor — a lane whose OPEN pre-kill intent (above) this run's supervisor cannot verify
  // or complete (missing either half) is left EXACTLY as it was found (never a fabricated
  // settlement, never a swallowed signal) and evented honestly instead. `stoppedBy: "emergency-
  // stop"` already forces this run's exit code non-zero regardless (cli.ts's roundsExitCode) —
  // this event's job is only to make the gap visible, not to add a second forcing mechanism.
  "estop-lane-sweep-incapable": {
    tags: ["round-artifact"],
    meaning:
      "a lane carries an open E-STOP sweep intent, but this run's Supervisor cannot verify or signal its durable pid (missing durablePidAlive/signalDurablePid) — left unsettled, never a fabricated outcome.",
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
  resumed: {
    tags: ["lane-session-start"],
    meaning: "a handed-off lane was resumed by a fresh worker session.",
    actionability: "routine",
  },
  "resume-failed": {
    tags: [],
    meaning: "resuming a handed-off lane failed this attempt; eligible for a further retry.",
    actionability: "expected-noise",
  },
  // #965: NOT tagged `retro` (deliberately) — a split-vs-needs-human round-digest treatment for
  // this kind is #874's own AC, not this one's. Leave the tag off here; #874 adds it in the same
  // PR that wires the round-digest consumer, so a tag with no reader never lands ahead of it.
  "resume-capped": {
    tags: ["escalation-source:always"],
    meaning:
      "a handed-off lane exhausted its resume-attempt budget (#172). `split: false` (or absent, every pre-#965 " +
      "event): needs-human, always proven by presence. `split: true` (#965): the engine applied `labels.split` " +
      "instead — the WIP branch is evidence for po-decompose, not an attention item; escalation-reconcile.ts's " +
      "resumeCappedNeedsAttention predicate narrows ESCALATION_SOURCES to the non-split occurrences only.",
    actionability: "intervene",
    see: "#172, #965",
  },
  "resume-capped-label-failed": {
    tags: [],
    meaning: "the needs-human OR split label write for a resume-capped lane failed; the lane may be escalated with no visible label.",
    actionability: "investigate",
  },
  "resume-cap-split-label-failed": {
    tags: [],
    meaning: "the `labels.split` write for an engine-applied resume-cap split (#965) failed; retried next tick.",
    actionability: "investigate",
  },
  "resume-cap-split-comment-failed": {
    tags: [],
    meaning:
      "the WIP-pointer evidence comment for an engine-applied resume-cap split (#965) failed (or the PR/diff read behind it did) — the split itself, its `resume-capped{split:true}` event, and the row's latch already landed and are unaffected; this row is never revisited (same 'the terminal is the row, this is bookkeeping-only retry noise' treatment as its `-label-failed` sibling, except this one never retries — the lane has already left handoffWorkers()).",
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
    tags: ["merged-witness"],
    meaning:
      "the revival pass found the lane's PR already MERGED (recorded for the merged case only) and closed it out instead of reviving it (#447).",
    actionability: "routine",
    see: "#447",
  },
  "human-merge-only-closed": {
    tags: ["merged-witness", "escalation-clear"],
    meaning:
      "a parked human-merge-only lane's PR (#397 bucket 2) was found MERGED and closed out — in-progress cleared, board set done, worktree run through the same mtime/ctime reclaim policy the DEAD path uses, worker row terminalized. Never re-drives the lane (#824). `escalation-clear` (#933): this IS the engine's own terminal witness for the `drive-human-merge-only` attention item — the dashboard strip fold must retire it here, not leave it waiting on a resolution nothing ever observes.",
    actionability: "routine",
    see: "#824",
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
  "merged-lane-worktree-settled": {
    tags: [],
    meaning:
      "a MERGED lane's worktree was clean at close-out — deleted, and its git-worktree registration pruned (#834 Phase 1, the merged-lane close-out settlement).",
    actionability: "routine",
    see: "#834",
  },
  "merged-lane-worktree-retained": {
    tags: [],
    meaning:
      "a MERGED lane's worktree held possibly-uncommitted state at close-out and was left in place — event-only, no needs-human label: the PR is already merged and nothing is blocked (#834 Phase 1).",
    actionability: "investigate",
    see: "#834",
  },
  "merged-lane-worktree-settle-failed": {
    tags: [],
    meaning:
      "a MERGED lane's worktree was purity-clean but its deletion did not complete cleanly (TOCTOU re-verify or the removal itself failed) — surviving residue, if any, is at the recorded `tombstonePath` rather than the original `worktreePath` (present whenever the rename already succeeded before the failure; deletion may be only partially complete, never assume full recovery), its git-worktree registration left dangling for the #825 missing-directory pass to eventually reap; carries a `reason` (#834 Phase 1, gate② round 1 F1/F4, round 2 G2, round 3 W1).",
    actionability: "investigate",
    see: "#834",
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
    tags: ["escalation-clear"],
    meaning:
      "a gated-reentry lane was retired (not reentered) because the audit proved it terminal by merge or issue-close (#593) — nothing left to reenter. `escalation-clear` (#933): this IS the engine's own terminal witness for the `gated-flag-unprovable` attention item — the dashboard strip fold must retire it here.",
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
