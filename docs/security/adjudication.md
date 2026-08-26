# Adjudication

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for the AC-authority dispatch snapshot, CI execution evidence for engine-agent review, and the comment-adjudication cursor.

## The AC-authority dispatch snapshot

Per-AC verdicts need an immutable acceptance-criteria set to judge a PR against, but the
producer — or anyone else with issue write access — can edit the issue body after dispatch, so
the live body is not authoritative once a worker has been dispatched against it. The fix is
engine-side: a dispatch-time snapshot, a review-time drift gate, and a per-lane ownership check,
independent of any permission boundary.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| Before a worker spawns, DISPATCH persists `{hash, body, manifest}`; a write failure rolls the claim back like a spawn failure. | `conductor.ts` DISPATCH + `State.recordAcSnapshot` | `conductor.test.ts`: "tick dispatch: an AC snapshot is persisted BEFORE the worker ever spawns …" |
| A non-`verify:n/a` issue with a missing or malformed checkbox AC set is not dispatchable. | `forge.ts::isDispatchable` | `forge.test.ts`: "isDispatchable: #283 — a malformed/empty checkbox AC set … verify:n/a is exempt" |
| At drive and at fix-leg spawn, ANY live-body drift from the recorded snapshot fails closed to `needs-human` with a drift-explaining comment; the lane never proceeds that tick. | `conductor.ts::checkAcDriftBeforeDrive` (drive, fix-leg-spawn); `ac-snapshot.ts::checkAcSnapshotDrift` | `conductor.test.ts`: "tick DRIVE: AC-snapshot drift routes to needs-human with a drift-explaining comment, and driveOne is NEVER called …"; `ac-snapshot.test.ts`: "checkAcSnapshotDrift: ANY body change (not just inside the AC section) is drift …" |
| A lane that never recorded a snapshot (dispatched before AC snapshots existed) is not treated as drift — it drives normally; only new dispatches are tightened. | `conductor.ts::checkAcDriftBeforeDrive` (legacy-lane arm, null `ac_body_hash`) | `conductor.test.ts`: "tick DRIVE: a driving lane with NO recorded AC snapshot … is never treated as drift — drives normally" |
| The AC-authority hash excuses a well-formed marker line and the whitespace folds below (see Boundaries); every other byte change — including a marker-shaped line with extra payload — still drifts. | `ac-snapshot.ts::hashBodyForAcAuthority` | `ac-snapshot.test.ts`: "hashBodyForAcAuthority: a marker-line-only diff … hashes IDENTICALLY" |
| `hashBody`/`checkBodyDrift` stay raw — a marker edit must still register as a change there. | `ac-snapshot.ts::hashBody`; `comment-cursor-gate.ts::checkBodyDrift` | `comment-cursor-gate.test.ts`: "checkBodyDrift: a marker-only advance … STILL counts as drift" |
| The pre-drive comment-cursor recheck reads the live body the sibling drift check fetched, never the frozen snapshot body. | `conductor.ts::checkCommentCursorBeforeDrive` | `conductor.test.ts`: "#752 (inverted #676 drift test): a live body edit that ONLY advances the cursor marker … driveOne IS invoked" |
| Each `WorkerRow` stamps its own dispatch-time hash; a mismatch against the issue's current snapshot, or that snapshot going missing despite this lane having recorded one, escalates as a fail-closed anomaly. | `conductor.ts::checkAcDriftBeforeDrive` (ownership check) | `conductor.test.ts`: "tick DRIVE (#301 P1#3): a reclaimed lane's stale ac_body_hash … escalates as an ownership anomaly" |
| The engine-agent session reads the frozen snapshot body/manifest, never re-fetching or re-extracting; a missing snapshot is `unavailable`, fail-closed. | `engine-agent.ts::EngineAgentReviewer.evaluate` | `engine-agent.test.ts`: "evaluate(): no AC snapshot recorded for the issue -> unavailable, fail closed …" |
| AC manifest ids (ordinal+hash) are stable per extraction only; drift detection stops a changed body being re-extracted as an equivalent id set. | `forge.ts::extractAcceptanceCriteria` (id scheme) | `forge.test.ts`: "extractAcceptanceCriteria corpus: editing one criterion's text changes only ITS id …" |

**Boundaries**

- A well-formed marker is the ENTIRE trimmed line `<!-- sapwood:comments-adjudicated-through: N -->`
  where `N` is `0` or a bare digit run (the standalone-line convention `comment-cursor.ts` also
  follows). The hash also folds CRLF→LF and collapses blank-line-run/trailing whitespace, whole-body
  (not fence-aware, unlike the marker strip) — `ac-snapshot.ts::normalizeForAcAuthority`;
  `ac-snapshot.test.ts`: "a marker newly appended MID-BODY … hashes identically".
- A drifted lane has no re-extraction path — only a renewed gate⓪ pass lets it drive again
  (`conductor.ts::checkAcDriftBeforeDrive`).
- The hosted-bot (Codex) trigger still performs its own live issue-body read to build its
  `@codex review` comment (`reviewer.ts::CodexReviewer.triggerReview`); the conductor's drift gate
  runs before either reviewer kind reaches its gate path, so a drifted lane never reaches that read
  either.
- The comment-cursor recheck (at drive and fix-leg spawn) has a `null` live-body argument only on
  the legacy arm (a lane dispatched before AC snapshots existed, no snapshot to drift-check
  against); it then falls back to the snapshot body and does not re-verify ownership — a
  pre-existing, unwidened gap, not introduced here.
- `ac_snapshots` is upsert-by-issue: a `failed`-with-PR lane awaiting GATED RECLAIM does not block
  a fresh dispatch of the same issue, so a later dispatch can legitimately overwrite the snapshot an
  older, un-reclaimed lane still depends on — the per-lane ownership check above
  (`workers.ac_body_hash`) is what catches that case.

## CI execution evidence for engine-agent review

A code-verifiable AC reaches `confirmed` only through two checks: the review session statically
maps the AC to a named, substantive, non-skipped test on the discovery path and checks its
assertions are meaningful; separately, `review/ci-evidence.ts::requiredChecksSatisfied` requires
every configured `ci.requiredChecks` `{name, app}` pair to match a current-head CheckRun with
conclusion `SUCCESS` from that exact GitHub App slug — a same-named check from another app is not
evidence, and legacy status contexts, `SKIPPED`, `NEUTRAL`, queued, and in-progress CheckRuns never
satisfy this chain.

`ci.requiredChecks: []` parses but warns under `reviewer.mode: engine-agent` (`config.ts`); every
PR then queues forever at the CI-evidence preflight without ever spending on a review session.
`sapwood run` refuses to start under this exact combination (`engineAgentEmptyCiRequiredChecksError`,
`cli.ts`), and `sapwood validate` mirrors that same refusal — an operator never sees `validate: OK`
on a config `run` would hard-refuse.

Workflow-command binding stays a residual: the agent reviews workflow-file diffs, but the engine
never statically proves a named CheckRun executed a particular command.

**Gate① is rollup-wide and strictly broader than `requiredChecks`.** `requiredChecks` narrows
which checks count as trusted EVIDENCE for a code-verifiable AC; it never narrows which checks gate
the merge itself. `PRStatus.ciGreen` (`forge.ts`) requires the entire status-check rollup to pass —
a non-required check can still block a merge by being red, pending, or concluding without ever
passing (`ciInert` — e.g. SKIPPED/NEUTRAL/CANCELLED/STALE/ACTION_REQUIRED), but can never authorize one
on its own; only a fully green rollup does that.

## The finding owner axis

A rejected engine-agent verdict whose only outstanding findings are tier-C evidence (a
human-witnessed probe record absent from the snapshotted issue body) still gated as `FIXABLE`:
`driveDecision` dispatched a paid fix leg that could not produce the missing record by
construction, the leg disputed it, and the lane escalated `needs-human` anyway — the same outcome
reachable at zero cost. The `owner` axis lets the review session mark that outcome up front, so
the engine can skip the futile leg entirely.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| Every finding carries an optional `owner: "producer" \| "operator"`; an out-of-enum value voids the WHOLE review output, exactly like an invalid `severity`/`kind`. | `review/finding-axes.ts` (`FINDING_OWNERS`, `ALLOWED_FINDING_KEYS`); `review/agent-output.ts::validateAgentFindings` | `finding-axes.test.ts`; `agent-output.test.ts`: "owner outside its enum voids the WHOLE output" |
| An absent `owner` defaults to `"producer"` — fail-closed, today-equivalent: a classic-path finding, or an engine-agent finding from before this axis existed, is unaffected. | `review/finding-axes.ts::effectiveOwner` | `finding-axes.test.ts`: "effectiveOwner: owner absent -> producer" |
| A rejected verdict whose every EFFECTIVE-BLOCKING finding is operator-owned dispatches NO fix leg — the engine escalates straight to `needs-human`, `fix_rounds` unchanged. A mixed or all-producer verdict is unaffected; advisory findings never participate. | `loop/fix-response.ts::computeOperatorOwnedEscalation`; `loop/conductor.ts` `case "fixable"` (`escalateOperatorOwned`) | `fix-response.test.ts`: "all-operator -> the full blocking-finding evidence list", "mixed producer+operator -> null"; `conductor.test.ts` |
| The operator-owned check runs AFTER both dispute short-circuits (a recorded dispute for this exact verdict still wins) and BEFORE the verdict-rerun breaker (it is pure state, decided before any leg would have run). | `loop/conductor.ts` `case "fixable"` | `conductor.test.ts`: dispute-precedence fixture |
| The convergence classifier filters operator-owned findings out of the recorded set before bounding, using the SAME `effectiveOwner` definition — a constant operator-owned term (which no fix leg can ever change) cannot flat-stall a mixed lane's producer-owned share. | `loop/conductor.ts::gatherFixupFindingRecord` | `conductor.test.ts`: "a constant operator-owned term ... does not produce a flat/recurrence stall" |

**Boundaries**

- A false `"operator"` label sends the lane to a human without spending a fix leg; a false
  `"producer"` label (or simply omitting `owner`) costs one paid, futile fix round — the same
  asymmetry the owner ruling accepted for #865 (rather-alert-a-human over rather-spend-a-leg).
- The engine never derives `owner` from evidence-tier prose or from `kind` — it is a session-set,
  closed-enum field the same way `severity` is, never inferred from free text (the
  authoritative-signals rule).

## The comment-adjudication cursor

Workers are dispatched with the issue BODY only (`{{issue.body}}`, `worker.ts`), which stays
maintainer-writable while the comment stream does not. The comment-adjudication cursor closes the
resulting gap — a body that has gone stale relative to its own comment thread — before gate⓪
review or dispatch spends against it. It is a deterministic, trust-independent staleness gate, no
LLM in the loop, keyed on one body marker: `<!-- sapwood:comments-adjudicated-through: <comment-id> -->`,
meaning "a maintainer has adjudicated every comment at or before this one." Pure marker parsing and
pending-comment computation live in `comment-cursor.ts`; the impure fetch/escalate half lives in
`comment-cursor-gate.ts`; both are wired into engine-side checkpoints at gate⓪ (four
sub-checkpoints, each before the effect it protects), dispatch (before the leg spawns), drive
(before a verdict-driven action), and fix-leg spawn (before a FIXUP leg spawns) — none touching
the worker's own prompt.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| A cursor targets a comment by stream position, never by numeric id; a missing marker fails closed only when non-engine comments exist, while a duplicate, non-numeric, or dangling-target marker always fails closed. | `comment-cursor.ts::computeCommentCursor` | `comment-cursor.test.ts`: "malformed marker (non-numeric, not '0'): fails closed" |
| No role may create, move, or delete the cursor marker: any role-emitted marker is stripped, and the current body's marker (if any) is reattached byte-for-byte. | `comment-cursor.ts::applyRoleBodyRewrite` | `comment-cursor.test.ts`: "applyRoleBodyRewrite (#703a): … carries the ORIGINAL marker byte-for-byte" |
| An operator-owned fence (`<!-- sapwood:operator-owned -->` … `<!-- /sapwood:operator-owned -->`) is recognized standalone-line/fence-aware and extracted byte-for-byte, CRLF included. | `comment-cursor.ts::extractOperatorOwnedFences` | `comment-cursor.test.ts`: "extractOperatorOwnedFences: preserves CRLF bytes internal to a fence" |
| A role write that alters, removes, or rewords a single byte inside a current-body operator-owned fence refuses the ENTIRE write, never a partial repair. | `comment-cursor.ts::applyRoleBodyRewrite` (`missingOperatorFences`) | `comment-cursor.test.ts`: "#827: a role-proposed body that alters a byte inside an operator-owned fence is rejected" |
| An unclosed current fence refuses the whole write outright; a fence-only CRLF/LF edit still counts as a byte change; a role-forged fence tag is stripped, its content kept. | `comment-cursor.ts::applyRoleBodyRewrite` (`operatorFenceScanResult`, `stripUnpreservedOperatorFenceTags`) | `comment-cursor.test.ts`: "applyRoleBodyRewrite (P1a, mutation-kill target): a malformed opener in the CURRENT body refuses the ENTIRE write outright" |
| The operator-owned fence's open tag is excluded by name from the generic marked-mode scan, so its presence never poisons AC/verification extraction into a false "planless" read. | `forge.ts::associateMarkedSections` | `forge.test.ts`: "#827: an operator-owned fence coexisting with a LEGACY (unanchored) verification plan does not poison extraction" |
| PO-triage body normalization happens exactly once, against a fresh live-body read taken immediately before the write — the write-ahead journal itself stores the raw, un-normalized body. | `align.ts::updateIssueBodyIfUnchanged` (normalizes at write time); `align.ts::persistTriageDecision` (journals the raw body) | `align.test.ts`: "#703 v2, gate② P1-1 … never writes the journaled marker" |
| When the current body's own marker state is already invalid (duplicate/malformed), the role write is refused entirely — never repaired. | `comment-cursor.ts::checkMarkerWritePrecondition` | `comment-cursor.test.ts`: "checkMarkerWritePrecondition: more than one marker line refuses — reason 'duplicate-marker'" |
| The final pre-write check is a synchronous string compare with no I/O between the read and the write, so nothing async can land in the gap. | `comment-cursor-gate.ts::checkBodyDrift`, called from `plan-review.ts`'s write sites | `plan-review.test.ts`: "the reviewer approve-with-revision's FINAL getIssueBody and updateIssueBody are ADJACENT in the forge call trace" |
| A marker counts only as the entire trimmed line outside a fence; any attempt-shaped payload between the colon and `-->` is validated, never silently read as absent. | `comment-cursor.ts::scanStandaloneMarkerLines` (recognizes the attempt); `computeCommentCursor` + `checkMarkerWritePrecondition` (validate it, fail closed) | `comment-cursor.test.ts`: "#703 v2 gate② P2-1: a BLANK-value marker attempt … fails closed as malformed" |
| A comment is exempt only when it carries `ENGINE_COMMENT_MARKER` AND its author matches the authenticated actor; an unresolvable actor exempts none. | `comment-cursor-gate.ts::fetchCommentStream` | `comment-cursor-gate.test.ts`: "unresolvable actor (getAuthenticatedActor -> null) exempts NO comment, ever" |
| Any id-less comment anywhere in the fetched stream fails the whole check closed, naming its stream position, never a substituted placeholder id. | `comment-cursor.ts::computeCommentCursor` | `comment-cursor.test.ts`: "a comment with a null id anywhere in the stream fails closed: comment-id-missing" |
| Cursor freshness is re-checked, always against the exact body a decision was computed from. At gate⓪: `pre-spend` before the verification-plan-reviewer/confirm session is spent on, `pre-apply` before any reviewer-derived body or label write, `pre-drafter-write` before the drafter's own body write, and `post-confirm` before an existing approval is implicitly preserved. At dispatch, before the leg spawns. At drive, before a verdict-driven action. At fix-leg spawn, before a FIXUP leg spawns. | `plan-review.ts::checkGate0CommentCursor` (gate⓪); `conductor.ts` dispatch loop (dispatch); `conductor.ts::checkAcAuthorityFreshness` (drive, fix-leg spawn) | `plan-review.test.ts`: "a DIRECT body edit landing DURING the confirm session discards a 'confirm' outcome too"; `conductor.test.ts`: "tick dispatch (#652): a non-engine comment already present … blocks dispatch"; "comment-cursor-stale(checkpoint: fix-leg-spawn), no fix leg spawned" |
| A confirmed stale/invalid cursor applies needs-human plus one deduplicated pointer comment naming the marker line to paste; dedup/post failures are reported, never thrown. | `comment-cursor-gate.ts::escalateCommentCursorStale` | `comment-cursor-gate.test.ts`: "escalateCommentCursorStale: the SAME cursor/pending set never produces a second comment" |

**Boundaries**

- A body with no marker and zero comments is the pass-through case — behavior-identical to
  pre-mechanism, no new write/label/outcome (`comment-cursor.test.ts`: "no marker, zero comments:
  ok, cursor 0, nothing pending").
- A deleted comment that is merely PENDING, not the cursor's target, supplies no content and is
  not a failure — only a dangling TARGET fails closed (`comment-cursor.test.ts`: "a deleted
  PENDING comment (not the cursor target) simply no longer supplies content — not a failure").
- A byte-identical operator-owned fence that only changed position is not a violation — the
  comparison is a multiset, never positional.
- A comment/body fetch failure performs no issue write; it propagates through each checkpoint's
  own existing retry/environment-failure path, never becoming a human adjudication.
- When a round dispatches nothing and also produced `comment-cursor-stale` events, the round log
  names the held-back issue(s) — a read of already-appended events, no write of any kind, including
  on the read's own failure path (`round.test.ts:667`).

**Rollout is a one-time backfill, not a migration.** No new CLI, no migration state, no schema
change; existing commented issues just need a maintainer to record-ruling → rewrite-body →
advance-cursor once.

**v1 residual: edits are out of scope, ordering is by comment CREATION only.** Editing an
already-cursored comment does not reopen it; a binding amendment needs a NEW comment. Accepted,
not hidden: "the cursor is current" means every comment created at or before its target was
adjudicated, not that every comment's current text was seen.

### Residual notes for this doc package

- **The worker prompt surface is unchanged.** Workers are dispatched with the issue body only
  (`{{issue.body}}`, `worker.ts`); nothing in this doc package touches what a dispatched worker
  session is shown.
- **"No issue-comment tools" is a proxy-grant claim, not a Bash claim.** The cursor closes the
  engine's own forge-proxy comment-reading tools (`PROXY_ROLE_TOOL_MATRIX`). An **L0** worker still
  holds `Bash(gh *)` (see [Worker credential tiers](credential-tiers.md#worker-credential-tiers)) and could read
  comments via `gh` on its own initiative; **L1** is what actually closes this channel, stripping
  the forge credential and `Bash(gh *)` together (`WORKER_ALLOWED_TOOLS_NO_GH`).
- **The public/private threat-model split.** In a public repo, comment entries from an author
  outside GitHub `OWNER`/`MEMBER`/`COLLABORATOR`, the authenticated engine actor, or the reviewer-bot
  allowlist are dropped at five forge reads (issue/PR comments, reviews, review threads, tails);
  missing author provenance fails the whole read. Nothing else in the engine filters comment
  provenance. The filter records only an aggregate withheld count and does not write to GitHub.
  Editing an already-cursored comment remains the separate "v1 residual" case above.
- **`docs/security.md` itself, and the prompt files, both ride the instruction-path escalation.**
  `engine/prompts/**` and `docs/security.md` are both entries in `escalation.instructionPaths`
  (see [Instruction-path changes escalate to human review](instruction-path-escalation.md#instruction-path-changes-escalate-to-human-review)),
  routing `sapwood:human-merge-only` as designed. `docs/guide/supervision.md` is not on that list.
