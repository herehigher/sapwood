---
name: sapwood-event-glossary
description: |
  Generated reference for loop supervisors: what every sapwood engine event kind, park source, and escalation bucket MEANS and how actionable it is (routine / expected-noise / investigate / intervene). Regenerated from engine/src/state/event-kinds/*.ts, state.ts's PARK_SOURCE_GLOSSARY, and loop/escalation-buckets.ts's ESCALATION_BUCKET_GLOSSARY — never hand-edited. Also visible to engine-role sessions since plugin-root skills load ambiently for every session (PLAN.md's ambient posture); it carries interpretation only, nothing role-actionable.
---

# sapwood event glossary

GENERATED FILE — do not hand-edit. Regenerate with `npx tsx engine/src/state/event-kinds/generate-glossary.ts` after any registry/glossary change; `generate-glossary.test.ts`'s drift test fails CI if this file and a fresh regeneration disagree.

This is interpretation, not instruction: it tells a loop supervisor (or any session that reads it) what an event/source/bucket MEANS and how urgently a human should look at it. It is not a source of GitHub label names, protected-path lists, or other machine-enforced facts — those live in code and <https://github.com/herehigher/sapwood/blob/main/docs/guide/configuration.md>; this glossary only points at them.

## Actionability

- `routine` — expected steady-state traffic; no read is required.
- `expected-noise` — looks alarming in isolation but is a known, self-healing retry/degrade path.
- `investigate` — not itself a call for action, but worth reading the surrounding events for.
- `intervene` — a human owes the next decision or action.

## Event kinds

### Run / process lifecycle

- `run-started` — **routine**: the engine process booted and began ticking.
- `run-ended` — **routine**: the engine process shut down (normal exit or drain).
- `tick-error` — **investigate**: an uncaught error surfaced during one tick-loop iteration; the loop itself kept running.
- `instance-lock-taken-over` — **investigate**: a stale instance lock from a dead PID was taken over so this run could proceed.
- `deploy-key-tier-detected` — **routine**: startup recorded the effective worker-credential tier (L0/L1) and which deploy-key arm produced it — visibility, not a gate.
- `claude-cli-version-checked` — **routine**: startup recorded the installed Claude Code CLI version against the engine's declared floor (ok/below-floor/indeterminate) — visibility, not a gate.
- `engine-stalled` — **investigate**: the liveness watchdog observed the engine make no progress.
- `engine-restart-after-stall` — **expected-noise**: the engine restarted itself after a detected stall.
- `rapid-restart-detected` — **intervene**: the crash-loop breaker tripped on restart cadence; enters a probe-less "rapid-restart" park episode that clears only when a later start observes the birth window drained, or a human clears it.
- `consecutive-stalls-detected` — **intervene**: the stall breaker tripped on a run of consecutive stalls; enters a probe-less "consecutive-stalls" park episode that clears only when a later start observes the streak broken, or a human clears it.
- `idle-churn-detected` — **intervene**: the idle-churn breaker tripped: rounds are opening and closing cleanly but nothing consumable exists upstream, K times over; enters a probe-less "idle-churn" park episode that clears only when a human clears it.
- `empty-spin-park` — **intervene**: the empty-spin breaker tripped after N consecutive rounds dispatched nothing with a fully degraded peripheral session; enters an "llm" park episode.
- `park-probe` — **routine**: a scheduled probe attempt fired against an open llm/forge park episode to test whether the environment recovered.
- `park-escalated` — **intervene**: an open park episode's probe/attempt budget was exhausted (or a probe-less breaker's condition held); the episode now needs human attention.
- `park-resumed` — **routine**: a park episode cleared — the environment probed healthy, a canary succeeded, or a human ran `sapwood park clear`.
- `park-canary` — **routine**: an in-flight canary lane was dispatched to test whether an "llm" park episode's environment has recovered.
- `park-canary-failed` — **expected-noise**: the in-flight canary lane failed, so the "llm" park episode stays open for another probe cycle.
- `park-canary-inconclusive` — **expected-noise**: the in-flight canary lane produced no decisive verdict; the "llm" park episode stays open.
- `park-wait-heartbeat` — **routine**: a per-cadence heartbeat proving the loop is still alive while parked or otherwise waiting (F29's replacement for a silent gap).
- `standby-wait` — **routine**: the loop entered a backoff wait because the prior round dispatched nothing (the idle-round precondition).
- `standby-exit` — **routine**: standby ended and the loop resumed normal round ticking.
- `standby-heartbeat` — **routine**: a per-slice heartbeat emitted during a long standby wait, separate from standby-wait's own per-backoff-step event.
- `round-phase` — **routine**: a round transitioned into a named phase (aligning, architecting, executing, ...).
- `round-stop` — **investigate** [round-artifact]: a round loop stopped early, with the sentinel/breaker name and detail that caused the stop.
- `reconcile-completed` — **routine**: a reconcile pass over lane/PR state finished, carrying its own ok/count/orphans/overflow summary.
- `role-debris-swept` — **routine**: leftover session/worktree debris from a peripheral role session was cleaned up.
- `worktree-janitor-rollup` — **routine**: one dead-owner/unlocked present-directory worktree sweep cycle finished — carries reaped/retained/skipped/failed counts, never a per-directory event for the stock (Phase 2).
- `ceiling-breach-entered` — **investigate**: a cost-ceiling reason (per-run/per-day/...) newly joined the set of currently-breached reasons.
- `ceiling-breach-cleared` — **routine**: a cost-ceiling reason left the set of currently-breached reasons (including the total-clear case).
- `emergency-stop` — **intervene**: the EMERGENCY_STOP sentinel was detected — every running/fixing lane was hard-killed immediately, no drain window.
- `base-ci-red-observed` — **investigate**: the default branch's CI was observed red; opens the standing base-red episode.
- `base-ci-red-escalated` — **intervene**: the standing base-red episode persisted long enough to escalate; not issue-keyed, so it is not an escalation-source (no needs-human label to remove).
- `base-ci-red-cleared` — **routine**: a NEWER base-ci-red-observed/cleared pair showed the default branch's CI green again; closes the standing episode.
- `directive-applied` — **routine**: an operator directive file was read, substituted into this round's align/architect/triage prompts, and archived.
- `forge-page-ceiling` — **investigate**: a paginated GitHub read hit its configured page ceiling and returned a truncated result.
- `comments-withheld` — **investigate**: a forge comment, review, or review-thread read withheld an aggregate count of authors outside the trusted provenance set.
- `web-access-denied-by-operator-settings` — **investigate**: a role's WebFetch/WebSearch grant was denied at startup because it conflicts with the operator's own Claude Code settings.
- `user-settings-drift-detected` — **investigate**: the operator's Claude Code user settings changed since the engine last observed them (permission/hook drift the loop did not cause).
- `fix-loop-unattached` — **investigate**: startup recorded that `prFixCap > 0` but the forge proxy is unavailable, so the fix loop cannot attach this run.
- `labels-reconciled` — **routine**: startup provisioned any missing required GitHub labels for this board.
- `board-normalized` — **routine**: an issue with no board Status was moved onto the board (defaulted to backlog).
- `board-gap-detected` — **investigate**: open issues exist that are unplaced on the ProjectV2 board; carries the total/shown/elsewhere counts.
- `proxy-mint-failed` — **investigate**: the forge MCP proxy failed to mint a scoped token for a lane/role; the caller degrades per its own fail-open/fail-closed branch.
- `egress-suspect` — **investigate** [round-artifact]: a worker or peripheral session's transcript showed a network-egress-shaped tool call (curl, WebFetch/WebSearch, ...) — informational, never an escalation.
- `bypass-permissions-mode-configured` — **investigate**: startup detected host.permissionMode: bypassPermissions — every claude session runs unchecked on the operator's own say-so; disclosure only, never a gate.

### Lane lifecycle

- `dispatched` — **routine** [round-artifact, escalation-clear, lane-session-start]: a worker lane was dispatched for a Ready issue, in its own worktree.
- `dispatch-failed` — **investigate**: dispatching a lane for a Ready issue failed (worktree/spawn/write error).
- `reclaim-done` — **investigate** [round-artifact, escalation-source:always]: a finished worker lane was reclaimed cleanly; whether it needs attention is a predicate over the payload, not the kind alone.
- `reclaim-failed` — **investigate** [round-artifact, escalation-source:always]: reclaiming a finished worker lane failed; whether it needs attention is a predicate over the payload, not the kind alone.
- `reclaim-dead` — **investigate** [round-artifact]: a worker lane was reclaimed as DEAD (crashed/unresponsive process).
- `reclaim-dead-comment-failed` — **routine**: the explanatory PR comment for an engine-opened dead-lane rescue failed; the needs-human labels remain applied.
- `estop-lane-swept` — **intervene** [round-artifact, escalation-source:never]: under EMERGENCY_STOP, a driving/handoff lane's durable process identity was found alive and signalled directly (TERM then KILL), then the row was settled to `failed` in the same step so no later reconciliation can revive it; confirmedDead records whether a post-signal check verified the kill. Needs-human, but never label-proven — no forge write ever backs it.
- `estop-lane-sweep-started` — **routine** [round-artifact]: the E-STOP durable-pid sweep (round.ts) decided a driving/handoff lane is confirmed alive and is about to signal it — written before the first signal, for crash-rerun safety.
- `estop-lane-sweep-incapable` — **intervene** [round-artifact]: a lane carries an open E-STOP sweep intent, but this run's Supervisor cannot verify or signal its durable pid (missing durablePidAlive/signalDurablePid) — left unsettled, never a fabricated outcome.
- `handoff` — **routine** [retro, round-artifact]: a worker lane handed off gracefully (soft cost-limit reached): WIP committed+pushed, progress note left, `.handoff` sentinel written.
- `resumed` — **routine** [lane-session-start]: a handed-off lane was resumed by a fresh worker session.
- `resume-failed` — **expected-noise**: resuming a handed-off lane failed this attempt; eligible for a further retry.
- `resume-capped` — **intervene** [retro, escalation-source:always]: a handed-off lane exhausted its resume-attempt budget. `split: false` (or absent, on any event recorded before the split behavior existed): needs-human, always proven by presence. `split: true` (once the split behavior existed): the engine applied `labels.split` instead — the WIP branch is evidence for po-decompose, not an attention item; escalation-reconcile.ts's resumeCappedNeedsAttention predicate narrows ESCALATION_SOURCES to the non-split occurrences only.
- `resume-capped-label-failed` — **investigate**: the needs-human OR split label write for a resume-capped lane failed; the lane may be escalated with no visible label.
- `resume-cap-split-label-failed` — **investigate**: the `labels.split` write for an engine-applied resume-cap split failed; retried next tick.
- `resume-cap-split-comment-failed` — **investigate**: the WIP-pointer evidence comment for an engine-applied resume-cap split failed (or the PR/diff read behind it did) — the split itself, its `resume-capped{split:true}` event, and the row's latch already landed and are unaffected; this row is never revisited (same 'the terminal is the row, this is bookkeeping-only retry noise' treatment as its `-label-failed` sibling, except this one never retries — the lane has already left handoffWorkers()).
- `resume-undecidable` — **intervene** [escalation-source:always]: a handoff lane's resume outcome could not be determined; needs-human, always proven by presence.
- `resume-undecidable-label-failed` — **investigate**: the needs-human label write for a resume-undecidable lane failed; the lane may be escalated with no visible label.
- `resume-held` — **routine**: a handoff lane's resume was skipped because the issue already carries a human hold label — an observation, not a new escalation.
- `env-failure` — **investigate**: a lane hit an LLM/forge environment failure mid-work (the source that can enter an env-failure park episode).
- `env-failure-preserved` — **investigate** [escalation-source:never]: an env-failed lane's state was preserved with zero forge writes (the forge may itself be down); `never` a proof of the needs-human label.
- `lane-adopted` — **routine**: the engine adopted a lane it found already running/pushed at startup rather than treating it as orphaned.
- `lane-pr-unknown` — **expected-noise**: a lane's PR association came back UNKNOWN (transient forge write failure); the lane is deferred rather than settled.
- `lane-revived` — **routine** [escalation-clear]: an env-failed lane holding an OPEN PR was revived back to `driving` rather than left stranded between owners.
- `lane-revival-terminal` — **routine** [merged-witness]: the revival pass found the lane's PR already MERGED (recorded for the merged case only) and closed it out instead of reviving it.
- `human-merge-only-closed` — **routine** [merged-witness, escalation-clear]: a parked human-merge-only lane's PR (bucket 2) was found MERGED and closed out — in-progress cleared, board set done, worktree run through the same mtime/ctime reclaim policy the DEAD path uses, worker row terminalized. Never re-drives the lane. `escalation-clear`: this IS the engine's own terminal witness for the `drive-human-merge-only` attention item — the dashboard strip fold must retire it here, not leave it waiting on a resolution nothing ever observes.
- `ceiling-escalated` — **intervene** [retro, round-artifact, escalation-source:never]: a lane was drained for a cost/wall-clock ceiling breach; `never` a proof of the needs-human label (the drain's own label write is best-effort).
- `worktree-retained` — **investigate**: a lane's worktree was kept on disk (dirty/uncommitted state) instead of being deleted on reclaim, for a human to salvage.
- `worktree-released` — **routine**: a lane's worktree was deleted after reclaim (clean, nothing to salvage).
- `merged-lane-worktree-settled` — **routine**: a MERGED lane's worktree was clean at close-out — deleted, and its git-worktree registration pruned (the merged-lane close-out settlement).
- `merged-lane-worktree-retained` — **investigate**: a MERGED lane's worktree held possibly-uncommitted state at close-out and was left in place — event-only, no needs-human label: the PR is already merged and nothing is blocked.
- `merged-lane-worktree-settle-failed` — **investigate**: a MERGED lane's worktree was purity-clean but its deletion did not complete cleanly (TOCTOU re-verify or the removal itself failed) — surviving residue, if any, is at the recorded `tombstonePath` rather than the original `worktreePath` (present whenever the rename already succeeded before the failure; deletion may be only partially complete, never assume full recovery), its git-worktree registration left dangling for the missing-directory pass to eventually reap; carries a `reason`.
- `orphan-detected` — **investigate**: a worktree/branch with no matching worker row was found (mid-run sweep or startup reconcile).
- `orphan-healed` — **routine**: a detected orphan was reconciled back into a tracked lane.
- `orphan-heal-failed` — **investigate**: healing a detected orphan failed; it remains untracked for the next sweep.
- `orphan-sweep-checked` — **routine**: the mid-run orphan sweep ran and found nothing new to heal.
- `orphan-pr-escalated` — **intervene** [escalation-source:payload]: an orphaned lane's PR was escalated to needs-human; proof of the label write rides in the payload.
- `gated-flag-unprovable` — **intervene**: a gated-reentry lane's escalation label could not be found on either carrier — a standing alarm, one per engine start, for a lane only a human can move.
- `gated-flag-healed` — **routine**: a gated-reentry lane's escalation label was found on one carrier and the local flag was corrected to match.
- `gated-lane-retired` — **routine** [escalation-clear]: a gated-reentry lane was retired (not reentered) because the audit proved it terminal by merge or issue-close — nothing left to reenter. `escalation-clear`: this IS the engine's own terminal witness for the `gated-flag-unprovable` attention item — the dashboard strip fold must retire it here.
- `worker-heartbeat` — **routine**: a per-cadence heartbeat proving an in-flight worker lane is still alive.
- `role-session-heartbeat` — **routine**: a per-cadence heartbeat proving an in-flight peripheral role session is still alive.
- `role-env-failure` — **investigate**: a peripheral role session hit an LLM/forge environment failure; the durable record IS this event (no companion -degraded event).
- `role-session-exit-lost` — **investigate**: a peripheral role session's process exited without the engine observing its outcome (result lost).
- `role-session-spawn-timeout` — **investigate**: spawning a peripheral role session timed out before it could start doing work.
- `role-worktree-retained` — **investigate**: a peripheral role session's worktree was kept on disk (uncommitted edits behind) instead of being deleted.
- `lane-spawned` — **routine**: a worker lane got a NEW live child process (fresh dispatch, an ordinary/fix-leg resume, or a cross-restart adoption of an already-confirmed spawn) — carries the pid + worktree path `status` folds newest-per-lane.
- `permission-mode-mismatch` — **investigate**: a worker or peripheral session's init line reported an effective host permission mode different from the one the engine requested — informational only, fail-safe in the allow direction, and never affects the lane/session's own outcome.

### PR drive

- `drive-queued` — **routine** [pr-touched, round-artifact]: a PR was checked against gate② and left queued (not yet mergeable, no action taken).
- `drive-stopped` — **routine** [pr-touched, round-artifact]: driving a PR stopped this tick (breaker/budget/cap reached), to be retried a later tick.
- `drive-needs-human` — **intervene** [retro, pr-touched, round-artifact, escalation-source:payload]: a DRIVING lane was moved to needs-human ("the machine is stuck" / "a human owes the next decision"); the payload's `reason` identifies the cause — a gate② verdict OR a drain-* budget/kill-switch drain (conductor.ts's ceiling/kill-switch driving-lane drain path also writes this kind, not gate② alone) — and `labeled` records whether the label write itself landed.
- `drive-no-pr` — **intervene** [round-artifact, escalation-source:always]: a driving lane has no PR to drive (ESCALATE_NOPR) — done but no PR was ever opened; always proven by presence.
- `drive-fixup` — **routine**: gate② returned FIXUP — a fix leg was dispatched against the PR's outstanding findings.
- `drive-human-merge-only` — **intervene**: gate② classified the PR as human-merge-only (bucket 2, instruction-path trust chain) — the PR is fine, but its merge decision is a human's, one-way and never re-decided.
- `drive-thread-writes-pending` — **routine**: a fix leg's review-thread reply/resolve writes are still queued for this PR; driving deferred until they drain.
- `merged` — **routine** [pr-touched, round-artifact, escalation-clear, merged-witness]: a PR was merged by the conductor (CI green + a fresh review, per the configured merge gate).
- `rollback-recovered` — **routine** [round-artifact]: a pending board-status rollback succeeded on retry; the durable rollback record is cleared.
- `rollback-escalated` — **intervene** [round-artifact, escalation-source:never]: a pending board-status rollback exhausted its retry cap; `never` a proof of the needs-human label (the write attempted here is itself best-effort).
- `rollback-retry-failed` — **expected-noise**: one attempt at a pending board-status rollback failed, under the retry cap; retried next tick.
- `pr-held` — **routine**: a PR is being held from driving because a human hold label was observed on it.
- `pr-released` — **routine**: a previously-held PR's hold label was no longer observed; driving resumed.
- `lane-state-labeled` — **routine**: the engine's per-tick lane-state mirror applied/updated the PR-side lane-state label to match this lane's current state.
- `lane-state-cleared` — **routine**: the engine's per-tick lane-state mirror removed the PR-side lane-state label (the lane no longer needs one).
- `ci-pending-observed` — **routine**: gate① (CI) is decisive-pending on a PR's head — opens the CI-pending pin the escalation timer reads.
- `ci-pending-escalated` — **intervene**: a PR's CI stayed PENDING past the escalation bound while gate② was already decisive, so it can never progress on its own; labeled needs-human.
- `ci-inert-escalated` — **intervene**: a PR's CI concluded without ever going green (no check still running, none failed, at least one concluded without passing) — it can never progress on its own; labeled needs-human.
- `ci-pending-cleared` — **routine**: a PR's CI-pending pin closed (resolved green/red, or the head moved) — cancels the escalation timer.
- `gated-reentry` — **routine** [round-artifact, escalation-clear]: a human removed a lane's escalation label, and the gated-reentry handshake re-admitted the lane for one bounded reentry attempt.
- `gated-reentry-capped` — **intervene** [round-artifact, escalation-source:always]: a lane exhausted its bounded gated-reentry attempts; always proven by presence.
- `gated-reentry-capped-label-failed` — **investigate** [escalation-source:never]: the needs-human re-apply write for a gated-reentry-capped lane failed; `never` a proof (the write's own failure is the point).
- `gated-reentry-merged` — **routine** [merged-witness]: a gated-reentry lane's PR was found already merged; the lane was collected as done rather than reentered.
- `gated-reentry-issue-closed` — **routine**: a gated-reentry lane's issue was found already closed; the lane was collected as done rather than reentered.
- `gated-reentry-candidate-staged` — **routine**: a gated-reentry lane whose escalation never pinned a body-hash candidate (comment-cursor-stale) had one staged from the live body on this tick's first observation of the cleared hold; reentry itself waits for a later tick to reconfirm it.
- `fix-leg-started` — **routine** [fix-leg, lane-session-start]: a fresh fix leg was dispatched against a PR's outstanding findings/verdict.
- `fix-leg-resumed` — **routine** [fix-leg, lane-session-start]: an in-flight fix leg was resumed by a fresh worker session after a handoff/restart.
- `fix-leg-adopted` — **routine** [fix-leg]: the engine adopted a fix-leg process it found already running at startup rather than treating it as orphaned.
- `fix-leg-adopted-drained` — **routine** [lane-session-start]: an adopted fix-leg process was found already drained (finished) by the time the engine looked.
- `fix-leg-dispatch-blocked` — **expected-noise**: dispatching a fix leg was blocked by an admission check this tick (e.g. an open llm park episode); retried once the block clears.
- `fix-leg-dispatch-failed` — **investigate**: starting a fix leg's process/session failed; the PR stays queued for a later retry.
- `fix-leg-dispatch-unconfigured` — **intervene**: a fix leg was called for but the fix loop is not configured/attached this run (e.g. `prFixCap: 0` or no proxy) — escalates to needs-human.
- `fix-leg-resume-failed` — **investigate**: resuming an in-flight fix leg threw; the error is rethrown/surfaced, not silently absorbed.
- `fix-leg-resume-no-pr` — **investigate**: resuming a fix leg found no PR for the lane; the row is left untouched for a later retry.
- `fix-leg-resume-unconfigured` — **expected-noise**: resuming a fix leg found the fix loop unconfigured for this run; the row is left untouched (`handoff`), retried later.
- `fix-leg-undecidable` — **intervene** [escalation-source:always]: a fix leg's outcome could not be determined from the ledger; always proven by presence.
- `fix-leg-undecidable-label-failed` — **investigate**: the needs-human label write for an undecidable fix leg failed; the lane may be escalated with no visible label.
- `fix-leg-verdict-rerun` — **intervene** [escalation-source:always]: the same review verdict would have dispatched a second fix leg (the breaker that prevents a rerun loop); always proven by presence.
- `fix-rounds-capped` — **intervene** [escalation-source:always]: a PR exhausted its configured fix-round budget — the most common escalation source; always proven by presence.
- `fix-rounds-cap-label-failed` — **investigate**: the needs-human label write for a fix-rounds-capped PR failed; the lane stays queued and is retried.
- `fix-rounds-cap-comment-failed` — **routine**: the explanatory PR comment for a fix-rounds-capped PR failed to post; the durable event/label are unaffected.
- `fix-response-invalid` — **investigate**: a fix leg's settled output failed validation (malformed/incomplete response) and was rejected rather than queued.
- `fix-response-queued` — **routine**: a fix leg's settled output was validated and its review-thread reply/resolve writes were queued for posting.
- `fix-thread-reply-posted` — **routine**: a queued fix-leg reply was successfully posted to its review thread.
- `fix-thread-resolved` — **routine**: a queued fix-leg resolution successfully marked its review thread resolved.
- `fix-thread-write-escalated` — **intervene**: a queued thread-write (reply/resolve) exhausted its retry budget; escalated to needs-human on the PR (PR-born; its issue-side twin was deleted).
- `fix-thread-write-escalation-label-failed` — **investigate**: the needs-human label write for an escalated thread-write failure itself failed; the durable event is the only record.
- `fix-thread-write-retry-failed` — **expected-noise**: one attempt at a queued thread-write failed, under the retry cap; retried next tick.
- `ac-snapshot-drift` — **intervene** [escalation-source:never]: a PR's issue body changed after its acceptance-criteria snapshot was taken (see <https://github.com/herehigher/sapwood/blob/main/docs/security/adjudication.md#the-ac-authority-dispatch-snapshot>, "The AC-authority dispatch snapshot"); the lane fails closed and needs-human is applied via its own bespoke label site (escalation-buckets.test.ts's SITE_INVENTORY), not the shared addLabel call the other `always`/`payload` sources share — so `never` is the honest proof mode: the reconciler now OBSERVES this kind for external resolution (a merged/closed PR, a closed issue), but `never` keeps escalation-sweep.ts from ever removing the label off this event's own say-so. `checkpoint` records which recheck caught it: "drive" (immediately before `gate.driveOne`) or "fix-leg-spawn" (immediately before a FIXUP action's fix leg actually spawns — closes the verdict-tick PO-edit window a review's own duration used to leave open, waste-window reduction only, not race elimination).
- `blocked-by-cleared` — **routine**: a `blocked-by:<issue>` fence label was removed because the referenced blocker issue had already closed.
- `drain-driving-escalation-label-failed` — **investigate**: the needs-human label write for a driving lane drained by a ceiling/kill-switch failed; the lane may be escalated with no visible label.
- `drain-driving-escalation-comment-failed` — **routine**: the explanatory PR comment for a drained driving lane's escalation failed to post; the label/event are unaffected.

### Review (gate②)

- `reviewer-fallback-switch` — **investigate** [round-artifact]: the configured reviewer (e.g. hosted Codex) was unavailable, so gate② fell back to the alternate reviewer for this PR.
- `reviewer-fallback-revert` — **routine** [round-artifact]: the configured reviewer became available again; gate② reverted off the fallback reviewer.
- `engine-review-verdict` — **routine**: the engine-agent review runner recorded its structured verdict (approved/rejected + evidence/findings) for a PR.
- `engine-review-budget-advisory` — **routine**: announced before an engine-agent review session starts: `reviewer.agent.costCapUsd` is advisory only, since the codex-exec runner has no hard-cap mechanism to enforce it.
- `engine-review-cost-unknown` — **investigate**: an engine-agent review session ended with no usable token/cost telemetry; its spend is UNKNOWN and is never read as $0.
- `engine-review-containment-gap` — **routine**: recorded at every codex-exec spawn: the named containment blind spots (model-invoked shell execution, host-wide read scope) the sandbox does not close.
- `engine-review-orphaned-group` — **investigate**: a timed-out engine-agent review session's process group was still observable after the SIGKILL escalation; the review settles as `timeout` regardless, but something may still be running on the host.
- `engine-review-session-inspection` — **routine**: how many tool/command items an engine-agent review session's own stream reported it ran; evidence only, never a gate — nothing derives a verdict from it.
- `review-silence-escalated` — **intervene**: a PR's gate② review request produced no verdict past the configured silence bound; labeled needs-human for visibility.
- `review-disputed` — **intervene** [escalation-source:always]: successive gate② reviews disagreed past the dispute-pricing bound; always proven by presence.
- `review-disputed-label-failed` — **investigate**: the needs-human label write for a review-disputed PR failed; the durable event is the only record.
- `review-disputed-comment-failed` — **routine**: the explanatory PR comment for a review-disputed PR failed to post; the label/event are unaffected.
- `review-non-convergent` — **intervene** [escalation-source:always]: successive fix-leg review rounds failed to converge past the configured bound; always proven by presence.
- `review-non-convergent-label-failed` — **investigate**: the needs-human label write for a review-non-convergent PR failed; the durable event is the only record.
- `review-non-convergent-comment-failed` — **routine**: the explanatory PR comment for a review-non-convergent PR failed to post; the label/event are unaffected.
- `comment-cursor-stale` — **intervene** [escalation-source:never]: a checkpoint (gate⓪, dispatch, drive, or fix-leg-spawn — immediately before a FIXUP action's fix leg actually spawns, not just before gate.driveOne) found the issue's comment-adjudication cursor stale or invalid relative to its own comment thread and refused to spend/dispatch/drive/spawn; needs-human applied with a deduplicated pointer comment.

### Governance (align, triage, proposals, plan review, architect, harvest, retro)

- `align-summary` — **routine** [round-artifact]: the align phase finished and recorded its round summary (what it read, what it decided).
- `align-skipped` — **routine**: the align phase was skipped this round (role disabled, or no candidate work).
- `backlog-read-failed` — **investigate**: align's read of the Ready backlog/board failed this round; an honesty event, not a silent empty result.
- `goal-file-unreadable` — **investigate**: the operator's goal file could not be read for this round's align/architect prompts.
- `pool-selected` — **routine**: the PO's round-pool selection session chose which issues enter this round's pool.
- `pool-labels-failed` — **investigate**: applying the round-pool label to a selected issue failed; the issue may be selected without a visible label.
- `pool-reconcile-incomplete` — **investigate**: removing the round-pool label from one or more issues at pool-close failed; carries the failed issue list for the next reconcile pass.
- `pool-selection-decision-lost` — **investigate**: the round-pool selection session's decision failed to persist; an honesty event, not a silent no-op.
- `pool-degraded` — **investigate** [round-artifact]: the PO's round-pool selection session degraded/failed this round.
- `round-pool-removal-capped` — **intervene** [escalation-source:payload]: removing a stale round-pool label exhausted its retry budget and escalated to needs-human via the shared writer; proof of the label write rides in the payload.
- `triage-body-committed` — **routine**: a triage decision's guarded issue-body write landed (the durable half of the decision).
- `triage-comment-posted` — **routine**: a triage decision's explanatory issue comment was posted.
- `triage-decision-accepted` — **routine** [dissent-decision]: a triage decision was accepted and recorded as a durable dissent-decision receipt.
- `triage-decision-lost` — **investigate**: a triage decision failed to persist; an honesty event, not a silent no-op.
- `triage-effects-committed` — **routine**: a triage decision's final step (comment posted, or the no-plan-after fence applied) landed — the decision is now fully, durably effected.
- `triage-stale-hash-skipped` — **routine**: a triage candidate's content hash no longer matched what the decision was made against (the issue changed underneath); skipped rather than acting on stale information.
- `triage-degraded` — **investigate** [round-artifact]: the triage phase degraded/failed this round.
- `proposal-created` — **routine**: the PO's decomposition session created a child-issue proposal for a parent issue.
- `proposal-comment-posted` — **routine**: a decomposition proposal's explanatory comment was posted on its parent issue.
- `proposal-set-persisted` — **routine** [dissent-decision]: a decomposition's full set of proposals was durably persisted as a dissent-decision receipt.
- `proposal-skipped` — **investigate**: a decomposition proposal was skipped this round (title collision, receipt/live mismatch, or another named reason carried in the payload).
- `proposal-journal-corrupt` — **investigate**: the decomposition journal read back malformed/unparseable; decomposition halts rather than acting on it.
- `concern-posted` — **investigate** [round-artifact, dissent-receipt]: a PO structured-dissent concern was delivered — posted to the issue this round.
- `concern-adjudicated` — **routine**: a previously posted dissent concern was resolved (external reply, label change, or another recognized adjudication signal).
- `concern-post-failed` — **expected-noise**: one attempt to post a dissent concern failed, under the retry cap; retried next round.
- `concern-post-escalated` — **intervene** [escalation-source:payload]: posting a dissent concern exhausted its retry budget and escalated to needs-human via the shared writer; proof of the label write rides in the payload.
- `plan-approved` — **routine**: the plan-review session approved an issue's verification plan for this round.
- `plan-review-escalated` — **intervene** [retro, round-artifact, escalation-source:never]: the plan-review session's self-heal (draft→re-review cycles) was exhausted for an issue, or the session itself crashed/timed out; escalated to needs-human.
- `verify-na-proposed` — **intervene** [escalation-source:always]: the plan-review session proposed `verify:n/a` for an issue (unverifiable work, doc-gate path) and applied the label; a human must adjudicate the proposal — always proven by presence.
- `plan-review-too-large-split` — **routine** [retro, round-artifact]: gate⓪ judged an approved-shape issue structurally too large for one PR/lane and applied `labels.split` directly — the engine-initiated EARLY split trigger, as opposed to `resume-capped{split:true}`'s LATE one; po-decompose picks the issue up next round, no human action required.
- `operator-fence-violated` — **intervene**: a role-proposed issue-body rewrite altered or removed bytes inside an operator-owned `<!-- sapwood:operator-owned -->` fence, or the current body's own fence boundary was already malformed (an unclosed opener); the write was refused (plan-review's reviewer/drafter paths escalate needs-human via `plan-review-escalated`, po-triage logs and skips the write).
- `architect-review-degraded` — **investigate**: the architect's own review session degraded/failed this round.
- `architect-degraded` — **investigate** [round-artifact]: the architect's batch-review pool-verdict phase degraded/failed this round.
- `architect-verdict-applied` — **routine**: the architect's pool verdict for an issue (label/board effect) was applied.
- `architect-verdict-lost` — **investigate**: the architect's pool verdict for an issue failed to persist; an honesty event, not a silent no-op.
- `architect-repeat-drop-escalated` — **intervene** [escalation-source:payload]: an issue was dropped repeatedly for the same reason with no body edit in between (same-reason re-drop churn); escalated to needs-human via the shared writer instead of a duplicate drop comment, proof of the label write rides in the payload.
- `po-degraded` — **investigate** [round-artifact]: the PO's phase degraded/failed this round.
- `harvest-degraded` — **investigate** [round-artifact]: the harvest phase degraded/failed this round.
- `retro-degraded` — **investigate** [round-artifact]: the retro phase degraded/failed this round.
- `retro-pr-opened` — **routine** [round-artifact, retro-pr-lifecycle]: retro opened a documentation/round-close PR summarizing this round's durable-knowledge changes.
- `retro-pr-updated` — **routine** [round-artifact, retro-pr-lifecycle]: retro pushed a repair to a PR it had already opened (in this round or a prior one) instead of opening a duplicate.
- `retro-pr-degraded` — **investigate** [round-artifact]: retro's PR-opening or PR-updating step degraded/failed this round.
- `retro-quiet-skipped` — **routine**: the retro session was skipped because the round was quiet (zero retro/pr-touched-tagged events, zero lanes dispatched) — the phase still closed.

### Escalation reconciliation

- `escalation-resolved` — **routine**: the escalation reconciler observed an open escalation-source's resolution witness (a clear kind, a merge, a PR/issue close) — the durable record of HOW it resolved, before any label is touched.
- `needs-human-swept` — **routine**: the escalation sweeper removed the needs-human label for a (source, issue) key it proved both engine-applied and resolved by an authorized witness — the latch that stops this key from being swept twice.

## Park sources

A park episode suspends dispatch for the named source (`sapwood park clear --source <name>` lifts a probe-less one; a probed source — llm/forge — also auto-resumes).

- `llm` — **intervene**: the LLM session environment (Claude Code) is failing; carries probe/canary machinery and auto-resumes once the probe or canary succeeds.
- `forge` — **intervene**: the forge (GitHub) environment is failing; carries probe machinery and auto-resumes once the probe succeeds.
- `rapid-restart` — **intervene**: the crash-loop breaker tripped on restart cadence; no probe — clears only when a later engine start observes the birth window drained, or a human clears it.
- `consecutive-stalls` — **intervene**: the stall breaker tripped on a run of consecutive stalls; no probe — clears only when a human clears it.
- `idle-churn` — **intervene**: the idle-churn breaker tripped: rounds close cleanly but nothing consumable exists upstream; no probe (nothing downstream is broken to re-test) — clears only when a human clears it.

## Escalation buckets

The three action-buckets every escalation label write is classified into.

- `needs-human` — **intervene**: the machine stopped; a human owes the next decision. Removal happens by a human removing the label, the gated-reentry handshake that reclaims and re-drives the lane.
- `human-merge-only` — **intervene**: a human must MERGE this PR. One-way: written on the PR exactly once (the instruction-path trust chain), never removed or re-decided by the loop.
- `planless` — **routine**: not an escalation at all — a routing fence for a plan-less issue. Nobody owes a decision; the issue is simply off every queue until a plan exists.

## GitHub signal gotchas

A Codex CLEAN verdict never appears in the pull request Reviews API — it lands as a plain issue
comment on the PR. Polling the Reviews API for it looks exactly like a hung connector; check the
PR's comments, not its reviews, before assuming a review request is stuck.

A pull request in a merge-CONFLICTING state silently suppresses CI: GitHub reports "no checks
reported" for it, which reads like CI never ran rather than like a merge conflict blocking it from
running at all. Check the PR's `mergeable` state before treating an empty check list as a CI gap.

At any label-timeline anomaly (a label present/absent when the ledger says otherwise, an
escalation that looks unresolved, a hold that looks stale), re-read the issue's/PR's labels live
at the moment of the anomaly. Never reason from a label snapshot taken earlier in the round —
GitHub's live label state is the only authority a label-timeline question can be answered against.
