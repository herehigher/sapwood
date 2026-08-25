// ac-snapshot.ts (#283, design #279 §5, owner ruling D4) — the AC-authority dispatch snapshot.
//
// Design #279 §5's problem statement: per-AC verdicts need an authoritative, immutable AC set,
// but producers hold `gh issue edit` capability (worker.ts's grant) — the live issue body is
// therefore NOT authoritative once a worker has been dispatched against it. This module is the
// PERSISTENCE + TICK-TIME DRIFT-GATE half of the fix: BEFORE a worker ever spawns, conductor.ts's
// DISPATCH loop calls `buildAcSnapshot` on an issue body and persists the result via
// `State.recordAcSnapshot` — same fail-closed unit as the claim/dispatch attempt itself (a
// snapshot-write failure throws and rolls the board back to Ready exactly like a dispatch()
// failure would, so a lane can never run against an unrecorded AC set). #652 (comment-adjudication
// cursor): that body is now a RE-READ taken after the claim (`forge.getIssueBody`, inside the same
// rollback-on-failure unit), never the earlier `getReadyIssues` read — closing the race window
// between candidate selection and the claim. Later,
// before conductor.ts's DRIVE loop ever hands a driving lane to `gate.driveOne`, it re-fetches the
// LIVE issue body and calls `checkAcSnapshotDrift`: ANY full-body hash drift (not just the AC
// section — every reviewer input in the body, per design #279 §5's R3 widening) fails closed —
// the lane is escalated to `needsHuman` with a drift-explaining comment, and `driveOne` is never
// called that tick.
//
// SCOPE NOTE (#301 review, P1#2): this PR (#283, E2) does NOT yet feed the snapshotted body into
// any review SESSION's actual input — `driveOne`'s existing hosted-bot trigger (reviewer.ts's
// `CodexReviewer.triggerReview`) still does its own live `forge.getIssueBody` read, unchanged
// (reviewer.ts is human-merge-only and out of this PR's scope). What this module and the
// tick-time gate above DO guarantee: a lane whose body has drifted since dispatch NEVER reaches
// `driveOne` at all that tick, for ANY reviewer kind. Wiring `state.getAcSnapshot(issue).body` as
// the actual input to a review session (never re-extracting from a live fetch at THAT point) is
// issue #286 (E4a, the engine-agent adapter)'s job — this module provides the primitive
// (`recordAcSnapshot`/`getAcSnapshot`, proven immutable across a live edit in conductor.test.ts)
// that consumer is built to read.
//
// Pure module — no forge/state I/O of its own (state.ts owns persistence, conductor.ts owns the
// forge calls); everything here is a plain function over strings, easily corpus-tested.
import { createHash } from "node:crypto";
import { type AcceptanceCriterion, extractAcceptanceCriteria } from "../forge/forge.js";
import { scanStandaloneMarkerLines } from "./comment-cursor.js";

export type { AcceptanceCriterion };

/** sha256 hex of the FULL issue body — deliberately the whole body, not just the AC section
 *  (design #279 §5, R3: "widened from AC-section-only" — a verification-plan edit or any other
 *  reviewer-relevant prose change must also count as drift, not just an AC-line edit).
 *
 *  Left RAW and UNMODIFIED by #752: `comment-cursor-gate.ts`'s `checkBodyDrift` calls this
 *  directly, and it is the hash gate⓪'s session-input drift check (`plan-review.ts:525`) and
 *  both write-time drift guards (`plan-review.ts:792`, `plan-review.ts:993`) run through — those
 *  call sites are exactly where #703's invariant (a role body-write must not land silently over
 *  an operator's freshly-advanced cursor marker) is enforced, so they must keep seeing a
 *  marker-line edit as drift. Only the AC-AUTHORITY consumers below use the marker-normalized
 *  `hashBodyForAcAuthority` instead — see that function's own doc for why the two must diverge. */
export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** #752 finding 3 (PO adjudication on PR #812, P2 — payload smuggling): the AC-authority strip is
 *  STRICTER than comment-cursor.ts's own `stripStandaloneMarkerLines` — it only excuses a
 *  standalone marker line whose captured value is WELL-FORMED (`"0"` or a bare digit run,
 *  `/^\d+$/`, the exact validity rule `checkMarkerWritePrecondition`/`computeCommentCursor`
 *  already apply to a marker VALUE elsewhere). `stripStandaloneMarkerLines` itself stays
 *  permissive on purpose — it strips ANY standalone marker-SHAPED line regardless of payload,
 *  which is exactly right for its own caller (`applyRoleBodyRewrite` must strip a role's
 *  malformed attempt too, not merely a well-formed one; a role has no standing to write ANY
 *  marker, valid-shaped or not, so what its payload says is irrelevant to whether it gets
 *  stripped). The AC-authority hash, though, is a SECURITY boundary: unconditionally excusing
 *  every marker-shaped line from the hash would let a line like `<!--
 *  sapwood:comments-adjudicated-through: 0 IGNORE PRIOR ACs -->` carry an arbitrary payload
 *  completely invisibly past AC-drift detection, simply by dressing it up as a marker advance.
 *  Only a well-formed marker line is excused; anything else — including a marker-shaped line with
 *  extra payload — stays in the hash and drifts fail-closed, exactly like any other body edit. */
function stripAcAuthorityMarkerLines(body: string): string {
  const excusedIndices = new Set(
    scanStandaloneMarkerLines(body)
      .filter((m) => /^\d+$/.test(m.value))
      .map((m) => m.lineIndex),
  );
  if (excusedIndices.size === 0) return body;
  return body
    .split(/\r?\n/)
    .filter((_, i) => !excusedIndices.has(i))
    .join("\n");
}

/** #752 finding 2 (PO adjudication on PR #812, P1 — the symmetric marker-ADD case): normalizes
 *  `body` for the AC-authority hash beyond just excusing well-formed marker lines
 *  (`stripAcAuthorityMarkerLines` above) — it also normalizes CRLF line endings to LF and
 *  collapses the blank-line residue a stripped (or entirely absent) marker line leaves behind, so
 *  a MARKERLESS dispatch body and a live body that has since gained its FIRST marker (a PO's
 *  first #703-discipline comment, adding the marker where none existed) reduce to byte-identical
 *  text — the symmetric counterpart to the already-working ADVANCE case (an existing marker's
 *  VALUE changing already hashed identically before this fix; only ADDING one from nothing did
 *  not). The blank line conventionally separating the marker from surrounding prose survives a
 *  bare line-removal strip as either a dangling trailing newline (marker placed at EOF) or a
 *  doubled blank line (marker placed mid-body, between two blank lines that used to flank it) —
 *  neither of which a markerless body ever had, so an unnormalized compare drifted on a PO's very
 *  first cursor comment. CRLF is normalized unconditionally, BEFORE the strip runs, rather than as
 *  a side effect of the strip's own split/join (which only touches line endings when a marker
 *  line actually gets removed) — otherwise a markerless CRLF body and a marker-bearing CRLF body
 *  would normalize inconsistently depending on whether stripping happened to run at all.
 *
 *  Deliberately excuses TWO classes of whitespace-only difference a plain byte compare would call
 *  "changed": a CRLF/LF line-ending flip (GitHub's own web editor round-trips these
 *  inconsistently — see docs/security/adjudication.md) and a blank-line-run collapse (any run of 2+ consecutive
 *  blank lines reduces to exactly one, and trailing blank lines/whitespace are trimmed). Both are
 *  scoped to the AC-authority hash ONLY, same as the marker strip itself — `hashBody`/
 *  `checkBodyDrift` never call this and stay byte-exact. */
function normalizeForAcAuthority(body: string): string {
  const lf = body.replace(/\r\n/g, "\n");
  const stripped = stripAcAuthorityMarkerLines(lf);
  return stripped.replace(/\n{2,}/g, "\n\n").replace(/\s+$/, "");
}

/** #752 (issue Ruling, candidate 1; normalization widened by finding 2/3, PO adjudication on PR
 *  #812): sha256 hex of `body` after `normalizeForAcAuthority` above — a well-formed standalone
 *  `sapwood:comments-adjudicated-through` marker line stripped, CRLF normalized to LF, and the
 *  resulting blank-line residue collapsed. The cursor marker is role-immutable OPERATOR metadata
 *  (#703 item 1) whose position semantics `comment-cursor.ts` owns — it is not AC-authority text,
 *  so a marker-only body edit (a PO advancing OR first adding the cursor per #703 discipline, with
 *  no other byte meaningfully changed) must not read as AC drift. Every other byte of the body
 *  still participates in the hash, so any non-marker edit — including a marker-SHAPED line
 *  carrying extra payload — still drifts fail-closed.
 *
 *  This is the ONE function backing every AC-authority site (issue Ruling's own requirement — all
 *  four MUST share it or a staged #676 rebaseline candidate can never match the snapshot on a
 *  later tick): `buildAcSnapshot`/`checkAcSnapshotDrift` below, the #676 re-baseline candidate pin
 *  (`conductor.ts`'s `checkAcDriftBeforeDrive`), and its confirmation compare (`conductor.ts`'s
 *  GATED-RECLAIM candidate-hash check). Never used by `hashBody`/`checkBodyDrift` — see
 *  `hashBody`'s own doc for why those stay raw. */
export function hashBodyForAcAuthority(body: string): string {
  return hashBody(normalizeForAcAuthority(body));
}

/** The persisted AC-authority manifest for one dispatch attempt. `body` is the FULL snapshotted
 *  text, frozen at dispatch time — the future engine-agent review session (#286, E4a) reads
 *  THIS as its input, never a live re-fetch at that point (design #279 §5's "review sessions
 *  receive the SNAPSHOTTED body" requirement — see this module's own header for what #283/E2
 *  delivers today vs. what #286 wires in). `bodyHash` is `hashBody(body)`, kept alongside
 *  rather than re-derived on every read so a caller never needs the (slightly) more expensive
 *  hash just to check `snapshottedAt`/`manifest`. `manifest` is `extractAcceptanceCriteria(body)
 *  ?? []` — an EMPTY array (never null) for a `verify:n/a` issue with no checkbox AC section;
 *  `isDispatchable` (forge.ts) is what refuses to dispatch a non-`verifyNa` issue with a
 *  malformed/empty AC set in the first place, so by the time a snapshot is taken for such an
 *  issue, an empty manifest here is either a legitimate doc-gate issue or a caller (e.g. a test)
 *  that bypassed that gate deliberately — this module never re-enforces dispatchability, only
 *  records what it's given. */
export interface AcSnapshot {
  issue: number;
  bodyHash: string;
  body: string;
  manifest: AcceptanceCriterion[];
  snapshottedAt: string;
}

/** Build the snapshot from the SAME body text the dispatch decision was made against (conductor.ts
 *  passes `issue.body` straight through — never a fresh live read at snapshot time; the whole
 *  point is one authoritative read, not two that could disagree). Never throws: an issue with no
 *  AC section (a `verify:n/a` issue, or a caller that bypassed `isDispatchable`) simply gets an
 *  empty `manifest`, same as `extractAcceptanceCriteria`'s own null-to-callers-decide contract. */
export function buildAcSnapshot(issue: number, body: string, at: string): AcSnapshot {
  return {
    issue,
    bodyHash: hashBodyForAcAuthority(body),
    body,
    manifest: extractAcceptanceCriteria(body) ?? [],
    snapshottedAt: at,
  };
}

/** Review-time drift check (design #279 §5): `ok: true` carries the SNAPSHOTTED body/manifest —
 *  by construction, never the `liveBody` argument — so a caller that DOES consume this result as
 *  a session's input (#286, E4a) literally cannot leak a live re-fetch even by accident; the only
 *  way to ever see live text is via a DIFFERENT, explicit call the caller makes itself. `ok:
 *  false` means the full body hash no longer matches what was recorded at dispatch time — ANY
 *  drift, not just inside the AC section (R3's widening) — and carries a human-readable reason
 *  string for the drift-explaining comment conductor.ts posts; the caller (conductor.ts's DRIVE
 *  loop) treats this as "route to needsHuman, never call driveOne this tick, never silently
 *  re-extract" — a gate this PR (#283) already enforces for every reviewer kind, independent of
 *  whether that reviewer kind is yet wired to consume the snapshotted body itself.
 *
 *  #752 NOTE (PO adjudication on PR #812, finding 5 — corrects this note's own false claim): the
 *  `ok: true` arm hands back `snapshot.body` — the body as it was AT DISPATCH TIME — which, now
 *  that the drift check below ignores marker-only edits, can carry a STALE marker line relative
 *  to the current live body (a PO advancing the cursor after dispatch no longer bumps the
 *  snapshot). This note previously claimed "every `computeCommentCursor` call site reads a LIVE
 *  body, never this snapshot body" — that was FALSE: conductor.ts's `checkCommentCursorBeforeDrive`
 *  fed exactly this stale `snapshot.body` into `computeCommentCursor` (via
 *  `checkCommentCursorFreshness`), which is what produced a real production bounce (a PO's own
 *  marker advance read back as unadjudicated) once this PR's marker-normalized hash started
 *  excusing marker-only edits from drift. That site is FIXED in this same PR — it now threads the
 *  live body `checkAcDriftBeforeDrive` already fetched instead of reading this returned body — see
 *  `checkCommentCursorBeforeDrive`'s own doc in conductor.ts. Contract GOING FORWARD: this
 *  function's returned `body` is dispatch-time-frozen review/session input ONLY (its documented
 *  purpose above); no caller — present or future — may derive cursor state from it. Any new
 *  consumer of `computeCommentCursor`/`checkCommentCursorFreshness` must be given a freshly-fetched
 *  live body, never this one. */
export type AcDriftResult = { ok: true; body: string; manifest: AcceptanceCriterion[] } | { ok: false; reason: string };

export function checkAcSnapshotDrift(liveBody: string, snapshot: AcSnapshot): AcDriftResult {
  const liveHash = hashBodyForAcAuthority(liveBody);
  if (liveHash === snapshot.bodyHash) {
    return { ok: true, body: snapshot.body, manifest: snapshot.manifest };
  }
  return {
    ok: false,
    reason: `issue body changed since its dispatch-time AC snapshot (snapshotted ${snapshot.bodyHash.slice(0, 12)}, live ${liveHash.slice(0, 12)})`,
  };
}
