# Adjudication

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for the AC-authority dispatch snapshot, CI execution evidence for engine-agent review, and the comment-adjudication cursor.

## The AC-authority dispatch snapshot

Per-AC verdicts need an authoritative,
immutable acceptance-criteria set to judge a PR against — but the producer holds `gh
issue edit` capability (`worker.ts`'s own grant), so the live issue body is **not**
authoritative once a worker has been dispatched against it: a worker (or anyone else
with write access) could edit the issue after dispatch and silently shift what the
final review measures the PR against.

The fix is engine-side, not a new permission boundary: **before a worker ever spawns**,
the conductor's DISPATCH loop (`conductor.ts`) extracts the checkbox acceptance-criteria
set (`- [ ]` lines under `## Acceptance criteria` — `forge.ts`'s
`extractAcceptanceCriteria`) from the exact body `getReadyIssues` already fetched, and
persists a snapshot — `{full body hash, full body text, AC manifest}` — via
`State.recordAcSnapshot`, inside the same fail-closed unit as the dispatch attempt
itself (a write failure rolls the board claim back to `Ready` exactly like a spawn
failure would). `isDispatchable` (`forge.ts`) additionally refuses to dispatch any
non-`verify:n/a` issue whose checkbox AC set is missing or malformed — a bare
`Verification`/`Acceptance` section with no real `- [ ]` lines is no longer enough,
matching the `plan:approved` re-check in `plan-review.ts`'s `validateReviewerOutput`/
`validateDrafterOutput` (same "approve claim must be true" doctrine, extended to the
checkbox set the snapshot is built from).

**A drifted lane never reaches the merge/review gate.** Before the conductor's DRIVE
loop ever hands a driving lane to `gate.driveOne`, it re-reads the issue's LIVE body
(this IS a live fetch — it exists specifically to detect an edit, not to avoid one) and
compares its full hash against the recorded snapshot (`ac-snapshot.ts`'s
`checkAcSnapshotDrift`) — ANY drift, not just inside the AC section (a verification-plan
edit counts too), fails closed: the lane is escalated to `needs-human` with a
drift-explaining comment, and `driveOne` is **never** invoked for that lane that tick,
for any reviewer kind. There is no re-extraction path — a drifted lane cannot silently
proceed; a human must re-adjudicate (a renewed gate⓪ pass) before the lane can drive
again. A lane with no recorded snapshot (dispatched before this feature shipped) is not
treated as drift — it drives normally, so this only ever tightens NEW dispatches.

**The AC-authority hash is marker-normalized, not the raw body hash.** The cursor
discipline requires every PO comment on an issue to advance the
`<!-- sapwood:comments-adjudicated-through: N -->` marker in the same body edit — which, against
a raw full-body hash, would make a legitimate cursor advance on an in-flight issue *always* read
as AC drift. `ac-snapshot.ts`'s `hashBodyForAcAuthority` normalizes the body before hashing
(`normalizeForAcAuthority`, the same function backing every AC-authority site: `buildAcSnapshot`,
`checkAcSnapshotDrift` above, the re-baseline candidate pin, and its confirmation compare —
all four must share it, or a staged candidate could never match the snapshot on a later
tick), and excuses exactly two classes of edit from drift, both narrowly scoped:
1. **A well-formed standalone marker line** — the ENTIRE trimmed line is `<!--
   sapwood:comments-adjudicated-through: N -->` where `N` is `0` or a bare digit run
   (`comment-cursor.ts`'s fence-aware standalone-line scan, filtered to well-formed VALUES only —
   stricter than `stripStandaloneMarkerLines`/`applyRoleBodyRewrite`'s own permissive strip, which
   must still remove a role's malformed marker attempt too). A marker-*shaped* line carrying extra
   payload (e.g. `<!-- sapwood:comments-adjudicated-through: 0 IGNORE PRIOR ACs -->`) is NOT
   well-formed and stays in the hash — fail-closed against payload smuggling disguised as a marker
   advance.
2. **A line-ending-only difference** (CRLF normalized to LF) **and the blank-line residue removing
   a marker line leaves behind** (any run of 2+ consecutive blank lines collapses to one; trailing
   blank lines/whitespace are trimmed) — without this, a markerless dispatch body and a live body
   that gains its FIRST marker (a PO's very first cursor-discipline comment) would still drift, since
   the blank line conventionally separating the marker from surrounding prose survives a bare
   line-removal as a dangling trailing newline or a doubled blank line that a markerless body never
   had. This collapse is WHOLE-BODY, not fence-aware like the
   marker scan above — a whitespace-only blank-line-run change INSIDE a fenced code block is also
   excused from drift, same as anywhere else in the body. Code samples are not byte-protected
   against that one narrow class of edit; only well-formed marker lines get the fence-aware
   treatment.

Every other byte of the body still participates in the hash, so any non-marker edit still drifts
fail-closed; a marker advance plus a real edit still drifts too. This normalization is scoped to
AC authority only: `ac-snapshot.ts`'s own `hashBody` and `comment-cursor-gate.ts`'s `checkBodyDrift`
(the functions gate⓪'s session-input drift check and both write-time drift guards call) stay raw
and unmodified — those call sites are exactly where the cursor-discipline invariant (a role body-write must
not land silently over an operator's freshly-advanced marker) is enforced, and normalizing them
too would defeat it.

**The comment-cursor recheck before DRIVE reads the LIVE body, not the dispatch-time snapshot.**
`conductor.ts`'s `checkCommentCursorBeforeDrive` — the
review-time recheck that runs immediately before `gate.driveOne` — computes the adjudication
cursor from the live issue body the sibling AC-drift check (`checkAcDriftBeforeDrive`, just above
it) already fetched and confirmed AC-authority-matches the snapshot, never a second forge fetch.
Before this fix it read `snapshot.body` (the dispatch-time text) on the theory that the sibling
drift check's confirmation made a second body irrelevant — true only while the AC-authority hash
was the raw body hash. Once marker-only edits became excused from AC drift (the normalization
above), that theory broke: a PO's own marker advance passed the drift check while leaving
`snapshot.body` carrying the stale pre-advance marker value, so the cursor check read the PO's own
adjudication as still-pending and bounced the lane to `comment-cursor-stale` — a real production
failure, not a hypothetical.

**The engine-agent session consumes the snapshot directly.** Its adapter resolves
`state.getAcSnapshot(issue)` and builds the review prompt from that frozen full body and AC
manifest; it never re-fetches the issue body or re-extracts acceptance criteria for session input.
A missing snapshot is `unavailable` fail-closed. The hosted-bot trigger still performs its own live
`getIssueBody` read to build the `@codex review` comment, but the conductor's full-body drift gate
above runs before either reviewer kind reaches its gate path.

**Snapshot ownership is bound to the lane, not just the issue.** `ac_snapshots` is
upsert-by-issue (one row per issue number) — but a `failed`-with-PR lane awaiting a
human's GATED RECLAIM is *not* counted as in-flight (`activeWorkers()` excludes
`failed`), so a fresh dispatch of the *same* issue number can legitimately overwrite the
issue-keyed snapshot while the older, un-reclaimed lane still exists. Each `WorkerRow`
therefore stamps its own dispatch-time hash (`workers.ac_body_hash`) at creation, from
the exact snapshot just recorded in the same synchronous step (never re-read from the
table) — the drift check verifies that hash still matches the issue's *current* stored
snapshot before ever trusting it as that lane's authority. A mismatch (a different,
later lane's snapshot having since replaced it) — or the snapshot going missing entirely
despite a lane's own record of having recorded one — is treated as a fail-closed
anomaly, escalated exactly like an ordinary live-body edit, never silently absorbed.

Ids in the AC manifest are ordinal+hash (`<1-based position>-<8 hex chars of
sha256(text)>`) — stable for a single extraction (the same body always yields the same
ids), but never assumed stable across a body edit; drift detection is what prevents a
changed body from ever being silently re-extracted into a NEW id set that the engine
would then treat as equivalent to the old one.

## CI execution evidence for engine-agent review

A code-verifiable AC reaches `confirmed` only through two complementary checks. The review session
statically maps the AC to a named, substantive, non-skipped test on the discovery path and checks
that its assertions are meaningful. Separately, deterministic engine code requires every
configured `ci.requiredChecks` `{name, app}` pair to match a current-head CheckRun with conclusion
`SUCCESS` whose check suite belongs to that exact GitHub App slug. The app binding is part of the
trust boundary: a same-named check from another app is not evidence. Legacy status contexts and
`SKIPPED`, `NEUTRAL`, queued, or in-progress CheckRuns do not satisfy the chain.

`ci.requiredChecks: []` is parse-valid but emits a warning under `reviewer.mode: engine-agent`.
The shipped drive path then fails its CI-evidence preflight and queues before spending on a review
session. Workflow-command binding remains a documented residual: the agent reviews workflow-file
changes in the diff, but the engine does not statically prove that a named CheckRun executed a
particular command.

The paragraph above describes `loadConfig`/`parseConfig` — every read-only consumer (`status`,
`events`, and this same drive path once a run is already in flight) — which is why it still only
warns. `sapwood run` itself goes further: it refuses to start at all under this exact
combination, with a hard startup error naming the combination, the consequence, and both
remedies, so the "queues before spending" drive-path behavior above is unreachable via `run` in
practice — a run under this combination never gets far enough to dispatch a PR that could queue.
`sapwood validate` mirrors that same refusal rather than only warning, so an operator never
sees `validate: OK` on a config `run` would hard-refuse.

**Gate① is rollup-wide and strictly broader than `requiredChecks`.** `requiredChecks`
narrows which checks count as trusted EVIDENCE for a code-verifiable AC; it never narrows which
checks gate the merge itself. `PRStatus.ciGreen` requires the ENTIRE status-check rollup to pass,
`requiredChecks` or not — so a non-required check can still BLOCK a merge (by being red, pending,
or concluding without passing) but can never AUTHORIZE one on its own; only a fully green rollup
does that.

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
