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
| Before a worker ever spawns, the DISPATCH loop snapshots `{body hash, body text, AC manifest}` from the exact re-read body the claim used, inside the same fail-closed unit as the dispatch attempt — a write failure rolls the claim back like a spawn failure would. | `conductor.ts` DISPATCH loop + `State.recordAcSnapshot`; `ac-snapshot.ts::buildAcSnapshot` | `conductor.test.ts`: "tick dispatch: an AC snapshot is persisted BEFORE the worker ever spawns, from the SAME body getReadyIssues fetched" |
| A non-`verify:n/a` issue whose checkbox AC set is missing or malformed — a heading with no real `- [ ]` lines — is not dispatchable. | `forge.ts::isDispatchable` | `forge.test.ts`: "isDispatchable: #283 — a malformed/empty checkbox AC set on a non-verify:na issue is not dispatchable; verify:n/a is exempt" |
| Before a driving lane ever reaches `gate.driveOne`, its live body is re-fetched and full-hash-compared against the recorded snapshot; ANY drift — not only inside the AC section — fails closed to `needs-human` with a drift-explaining comment, and `driveOne` is never invoked that tick, for any reviewer kind. A drifted lane has no re-extraction path; only a renewed gate⓪ pass re-adjudicates it. | `conductor.ts::checkAcDriftBeforeDrive`; `ac-snapshot.ts::checkAcSnapshotDrift` | `conductor.test.ts`: "tick DRIVE: AC-snapshot drift routes to needs-human with a drift-explaining comment, and driveOne is NEVER called (no silent re-extraction)"; `ac-snapshot.test.ts`: "checkAcSnapshotDrift: ANY body change (not just inside the AC section) is drift — R3's full-body widening" |
| A lane with no recorded snapshot (dispatched before this feature shipped) is not treated as drift and drives normally — this only tightens NEW dispatches. | `conductor.ts::checkAcDriftBeforeDrive` (missing-snapshot arm) | `conductor.test.ts`: "tick DRIVE: a driving lane with NO recorded AC snapshot (predates #283, ac_body_hash null) is never treated as drift — drives normally" |
| The AC-authority hash excuses only a well-formed cursor-marker line, and the blank-line residue removing it leaves behind, from drift; every other byte still participates, so a marker-shaped line carrying extra payload, or a marker advance paired with a real edit elsewhere, still drifts like any other edit. | `ac-snapshot.ts::hashBodyForAcAuthority` (`normalizeForAcAuthority`) | `ac-snapshot.test.ts`: "hashBodyForAcAuthority: a marker-line-only diff (the cursor advancing) hashes IDENTICALLY"; "...a marker advance PLUS a real edit still hashes differently from the original (real edit isn't masked)"; "...a marker-shaped line carrying extra payload ... stays in the hash" |
| `hashBody` and `comment-cursor-gate.ts`'s `checkBodyDrift` stay raw and unmodified — the cursor-discipline invariant they enforce needs to see a marker edit as a change. | `ac-snapshot.ts::hashBody`; `comment-cursor-gate.ts::checkBodyDrift` | `comment-cursor-gate.test.ts`: "checkBodyDrift: a marker-only advance (no other byte changed) STILL counts as drift — #703's write-time guard must not be defeated by #752's AC-authority normalization" |
| The pre-drive comment-cursor recheck computes the cursor from the live body the sibling drift check already fetched, never the frozen dispatch-time snapshot body. | `conductor.ts::checkCommentCursorBeforeDrive` | `conductor.test.ts`: "#752 (inverted #676 drift test): a live body edit that ONLY advances the cursor marker (no other byte changed), backed by a REAL comment at that marker id, is NOT AC-snapshot drift AND not a stale comment-cursor — driveOne IS invoked" |
| Each `WorkerRow` stamps its own dispatch-time hash; the drift check verifies it still matches the issue's CURRENT stored snapshot before trusting it as that lane's authority — a mismatch, or the snapshot missing despite a lane's own record, escalates as a fail-closed anomaly, never silently absorbed. | `conductor.ts::checkAcDriftBeforeDrive` (ownership check against `workers.ac_body_hash`) | `conductor.test.ts`: "tick DRIVE (#301 P1#3): a reclaimed lane's stale ac_body_hash no longer matching the issue's CURRENT ac_snapshots row (a different, later lane's dispatch replaced it) escalates as an ownership anomaly — driveOne is never called against the wrong AC authority"; "tick DRIVE (#301 P1#1): a lane whose ac_body_hash is set but whose ac_snapshots row is MISSING (the crash-window shape) escalates as an anomaly — never silently drives as if it were a pre-#283 legacy lane" |
| The engine-agent review session resolves the frozen dispatch-time body/manifest and never re-fetches the issue body or re-extracts AC for its own input; a missing snapshot is `unavailable`, fail-closed. | `engine-agent.ts::EngineAgentReviewer.evaluate` (AC-snapshot resolution step) | `engine-agent.test.ts`: "evaluate(): no AC snapshot recorded for the issue -> unavailable, fail closed, no session spawned" |
| AC manifest ids are ordinal+hash — stable for one extraction, never assumed stable across a body edit; drift detection is what stops a changed body from being silently re-extracted into an equivalent-looking new id set. | `forge.ts::extractAcceptanceCriteria` (id scheme) | `forge.test.ts`: "extractAcceptanceCriteria corpus: editing one criterion's text changes only ITS id — sibling ids at other ordinals are untouched" |

**Boundaries**

- The AC-authority hash also folds CRLF to LF and collapses runs of 2+ blank lines (trailing
  whitespace trimmed) — GitHub's own web editor round-trips CRLF inconsistently, and stripping a
  marker line (or a body gaining its first-ever marker) leaves blank-line residue a markerless
  body never had. This collapse is whole-body, not fence-aware like the marker strip itself: a
  whitespace-only blank-line change inside a fenced code block is also excused from drift — code
  samples are not byte-protected against that one narrow class of edit.
- The hosted-bot (Codex) trigger still performs its own live issue-body read to build its
  `@codex review` comment (`reviewer.ts::CodexReviewer.triggerReview`); the conductor's drift gate
  runs before either reviewer kind reaches its gate path, so a drifted lane never reaches that read
  either.
- The comment-cursor recheck's live-body argument is `null` only on the pre-#283 legacy-lane arm
  (no snapshot to drift-check against); on that arm it falls back to the snapshot body and does not
  re-verify ownership — a pre-existing, unwidened gap, not introduced here.
- `ac_snapshots` is upsert-by-issue: a `failed`-with-PR lane awaiting GATED RECLAIM does not block
  a fresh dispatch of the same issue, so a later dispatch can legitimately overwrite the snapshot an
  older, un-reclaimed lane still depends on — the per-lane ownership check above
  (`workers.ac_body_hash`) is what catches that case.

## CI execution evidence for engine-agent review

A code-verifiable AC reaches `confirmed` only through two checks: the review session statically
maps the AC to a named, substantive, non-skipped test and checks its assertions are meaningful;
separately, `review/ci-evidence.ts::requiredChecksSatisfied` requires every configured
`ci.requiredChecks` `{name, app}` pair to match a current-head CheckRun with conclusion `SUCCESS`
from that exact GitHub App slug — a same-named check from another app is not evidence, and legacy
status contexts, `SKIPPED`, `NEUTRAL`, queued, and in-progress CheckRuns never satisfy this chain.

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
passing (`ciInert` — SKIPPED/NEUTRAL/CANCELLED/STALE/ACTION_REQUIRED), but can never authorize one
on its own; only a fully green rollup does that.

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
