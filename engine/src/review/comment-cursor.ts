// comment-cursor.ts (#652) — pure computation for the comment-adjudication cursor.
//
// Batch-8 incident (2026-08-04, PR #651 round 1): a binding owner ruling recorded as an ISSUE
// COMMENT was invisible to the worker, which reads only the issue BODY ({{issue.body}},
// worker.ts) — that boundary is correct (the body is maintainer-writable; comments become
// world-writable once the repo is public), but nothing checked the body was CURRENT relative to
// its comment thread before the engine spent on gate⓪ review or dispatch. This module is that
// check, expressed as a pure function of (body, comment stream) — no forge/state I/O of its own,
// same pure/impure split as ac-snapshot.ts (the sibling "existing body drift" mechanism this
// extends: see docs/security.md's "AC-authority dispatch snapshot" section).
//
// MARKER: `<!-- sapwood:comments-adjudicated-through: <comment-id> -->` in the issue body.
// Semantics: "a maintainer has adjudicated every comment at or before this one" (adjudicated =
// folded into the body OR reviewed-and-nothing-to-fold). Cursor `0` denotes the position BEFORE
// the first comment (nothing adjudicated yet).
//
// ORDERING: stream-position (array index in GitHub's oldest-first issue-comment stream), never
// numeric comment-id comparison — the marker identifies a CONCRETE comment; everything after it
// in the fetched stream is pending, regardless of id spacing/gaps.
//
// FAIL-CLOSED ARMS (design adjudicated 2026-08-05): a malformed marker, a duplicate marker, a
// cursor pointing at an engine comment, or a cursor whose target no longer exists in the stream
// all fail closed — `ok: false`. A missing marker with pending non-engine comments ALSO fails
// closed (the exact batch-8 shape: an issue that predates this feature, or that a maintainer
// forgot to stamp, must not silently pass). A missing marker with ZERO comments is the one
// pass-through case (AC8's reverse test: behavior-identical to today — no new writes, labels, or
// outcome changes; the checkpoints that consume this module's result DO add comment/actor reads,
// see docs/security.md).
//
// #652 round 1 (finding 4): marker recognition is STANDALONE-LINE anchored — a marker counts
// only when it is the ENTIRE trimmed line, and never inside a fenced (``` / ~~~) code block. A
// quoted/inline-code example (e.g. an issue body that shows the marker syntax to a maintainer,
// or a review comment quoting a PAST marker) must never parse as authoritative — see
// `findStandaloneMarkerValues` below and docs/security.md's "standalone-line" convention.
import { createHash } from "node:crypto";

/** A marker candidate is recognized only when, after trimming, it is the ENTIRE line — prose or
 *  inline-code backticks anywhere on the same line (`` `<!-- sapwood:... -->` `` or "see `<!--
 *  ... -->` above") fail this anchor by construction, no separate inline-code detection needed. */
const MARKER_LINE_RE = /^<!--\s*sapwood:comments-adjudicated-through:\s*(\S+?)\s*-->$/;
/** Matches a fence-opening/closing run — 3+ backticks OR 3+ tildes, GFM's two fence characters —
 *  at the start of a (already-trimmed) line. Group 1 is the exact run, so the caller can read off
 *  BOTH which character it is and how long it is (#652 round 2, finding 3 — see
 *  `findStandaloneMarkerValues` below for why both matter). */
const FENCE_RE = /^(`{3,}|~{3,})/;

/** Scan `body` for standalone adjudication-cursor marker lines, in document order, skipping any
 *  that fall inside a fenced code block. Returns the raw marker VALUE text for every standalone
 *  match (never the surrounding markup) — `computeCommentCursor` below decides what an empty,
 *  single, or multi-element result means.
 *
 *  #652 round 2 (finding 3): fence tracking is DELIMITER-AWARE, per CommonMark's own fenced-code
 *  rule — an open fence records its character (`` ` `` or `~`) and run length; a line only CLOSES
 *  it when it is the SAME character, with a run at least as long as the opener's. Before this, any
 *  fence-looking line (either character, any length >= 3) toggled a single boolean, so a `~~~`
 *  line appearing INSIDE a ``` ` ``` fence (e.g. a code sample that itself talks about tilde
 *  fences) incorrectly closed it — the marker line right after would then read as outside any
 *  fence and become authoritative. A same-fence-type line that's merely too SHORT to close (e.g. a
 *  stray `` `` `` inside a ```` ```` ````-opened fence) is, by the same rule, just fence content
 *  too — never a close, and never a new open either (a fence cannot nest). */
function findStandaloneMarkerValues(body: string): string[] {
  const values: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (fence === null) {
        fence = { char: run[0]!, len: run.length };
      } else if (run[0] === fence.char && run.length >= fence.len) {
        fence = null;
      }
      // else: a fence-looking line of the WRONG character, or the right character but too SHORT
      // to close the current opener, is just fence CONTENT — falls through to the `if (fence)
      // continue` below like any other line inside the block, never toggles.
      continue;
    }
    if (fence !== null) continue;
    const m = MARKER_LINE_RE.exec(line);
    if (m) values.push(m[1]!);
  }
  return values;
}

/** One comment in the fetched, oldest-first issue-comment stream. `isEngine` is resolved by the
 *  CALLER (comment-cursor-gate.ts): both the central `ENGINE_COMMENT_MARKER` (forge.ts) present
 *  in the body AND an authoritative match to the authenticated forge actor — never either alone
 *  (design adjudicated 2026-08-05's engine-comment exemption rule). This module never inspects
 *  comment bodies/authors itself; it only consumes the already-resolved flag. `id` is `null`
 *  (#652 round 1, finding 5) when the underlying forge read returned no id for this comment — an
 *  EXPLICIT signal from the caller, never a silently-coerced `""` that could collide with (or be
 *  mistaken for) a real cursor target; see `computeCommentCursor`'s `comment-id-missing` arm. */
export interface CommentStreamEntry {
  id: string | null;
  isEngine: boolean;
}

export type CursorFailureReason =
  | "missing-marker"
  | "malformed-marker"
  | "duplicate-marker"
  | "cursor-targets-engine-comment"
  | "cursor-target-not-found"
  | "comment-id-missing"
  // #652 round 1 (finding 1/2): NOT produced by this module's own computation — reserved for
  // comment-cursor-gate.ts's `checkBodyDrift`, which builds a synthetic `CommentCursorResult`
  // carrying this reason when a checkpoint's fresh live-body read no longer byte/hash-matches
  // the body a session was actually given. Declared here so the whole `CommentCursorResult`
  // vocabulary — dedup key, pointer-comment text, event `cause` — stays ONE shared type, never a
  // parallel one for the impure half's own fail-closed arm.
  | "body-drift";

export type CommentCursorResult =
  | { ok: true; cursor: string; pending: string[] }
  | { ok: false; reason: CursorFailureReason; detail: string; pending: string[]; target?: string };

/** Parse the adjudication-cursor marker out of `body` and compute the PENDING non-engine
 *  comment ids — those occurring, by stream position, after the cursor's target in `comments`
 *  (oldest-first, exactly as the forge returned them; this function never reorders). `pending`
 *  is populated on every branch (including every `ok: false` arm) so a caller building the
 *  needs-human pointer comment (comment-cursor-gate.ts) always has a best-effort candidate list
 *  — for a failure arm this is "every non-engine comment", since an invalid/unknown cursor
 *  cannot vouch for anything being adjudicated. */
export function computeCommentCursor(body: string, comments: readonly CommentStreamEntry[]): CommentCursorResult {
  // #652 round 1 (finding 5): checked FIRST, before any marker parsing — an id-less comment
  // anywhere in the stream means NO cursor target lookup (`comments.findIndex((c) => c.id ===
  // raw)` below) can be trusted to be exhaustive, so the whole computation fails closed rather
  // than silently treating a missing id as "never the target" or (worse, pre-round-1) coercing
  // it to `""` and risking an accidental match. Carries the STREAM POSITION (0-indexed,
  // oldest-first) of the FIRST id-less comment — concrete enough for a human to find it.
  const missingIdIndex = comments.findIndex((c) => c.id === null);
  if (missingIdIndex !== -1) {
    return {
      ok: false,
      reason: "comment-id-missing",
      detail:
        `comment at stream position ${missingIdIndex} (0-indexed, oldest-first) carries no id — ` +
        "the adjudication cursor cannot be evaluated against an incomplete comment stream",
      // Best-effort listing: every non-engine comment that DOES carry an id (the id-less
      // comment(s) themselves can't be named as a pending id at all).
      pending: comments.filter((c) => !c.isEngine && c.id !== null).map((c) => c.id!),
    };
  }

  // INVARIANT past this point: no `comments` entry has `id === null` (the guard above returned
  // otherwise) — every `c.id!` below is safe.
  const allNonEngineIds = comments.filter((c) => !c.isEngine).map((c) => c.id!);
  const matches = findStandaloneMarkerValues(body);

  if (matches.length === 0) {
    if (allNonEngineIds.length === 0) return { ok: true, cursor: "0", pending: [] };
    return {
      ok: false,
      reason: "missing-marker",
      detail: "the issue body carries no `sapwood:comments-adjudicated-through` marker, but the issue has non-engine comments",
      pending: allNonEngineIds,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "duplicate-marker",
      detail: `the issue body carries ${matches.length} adjudication-cursor markers — exactly one is required`,
      pending: allNonEngineIds,
      // #652 round 1 (finding 5): distinct duplicate SETS dedupe distinctly — see
      // commentCursorDedupeKey's own doc for why `target` (not a hardcoded literal) feeds the key.
      // #652 round 2 (finding 4): JSON.stringify, not `join(",")` — matching `pending`'s own
      // serialization just below (commentCursorDedupeKey's doc) — `join(",")` collapses
      // `["a,b", "c"]` and `["a", "b,c"]` to the identical `"a,b,c"` string, so two genuinely
      // different duplicate-marker sets could dedupe-collide on this same key.
      target: JSON.stringify(matches),
    };
  }

  const raw = matches[0]!;
  if (raw === "0") return { ok: true, cursor: "0", pending: allNonEngineIds };
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      reason: "malformed-marker",
      detail: `the adjudication-cursor marker's value "${raw}" is neither "0" nor a comment id`,
      pending: allNonEngineIds,
      target: raw,
    };
  }

  const idx = comments.findIndex((c) => c.id === raw);
  if (idx === -1) {
    return {
      ok: false,
      reason: "cursor-target-not-found",
      detail: `the adjudication cursor points at comment ${raw}, which no longer exists in the issue's comment stream`,
      pending: allNonEngineIds,
      // #652 round 1 (finding 5): keyed by the RAW target, not a shared "invalid" literal — a
      // cursor re-pointed from a still-missing comment (e.g. 999 -> 998, both absent) must dedupe
      // DISTINCTLY, so the maintainer's correction still produces a fresh pointer comment rather
      // than being silently suppressed by the previous target's stale dedup key.
      target: raw,
    };
  }
  if (comments[idx]!.isEngine) {
    return {
      ok: false,
      reason: "cursor-targets-engine-comment",
      detail: `the adjudication cursor points at comment ${raw}, which is an engine comment — the marker must identify a concrete NON-engine comment`,
      pending: allNonEngineIds,
      target: raw,
    };
  }

  return {
    ok: true,
    cursor: raw,
    pending: comments
      .slice(idx + 1)
      .filter((c) => !c.isEngine)
      .map((c) => c.id!),
  };
}

/** Does this result require the caller to block gate⓪ spend / dispatch / drive? True for every
 *  `ok: false` arm, and for an `ok: true` cursor that still has pending (unadjudicated) comments
 *  — cursor `0` with any comments is exactly this second case. */
export function commentCursorIsStale(result: CommentCursorResult): boolean {
  return !result.ok || result.pending.length > 0;
}

// Bounded listing for the pointer comment — a runaway comment thread must not produce a runaway
// GitHub comment. ponytail: flat literal cap, raise it (or make it a config key) if a real repo's
// pending set ever needs more than this to be actionable.
const POINTER_COMMENT_ID_CAP = 30;

/** Deterministic dedup key for "the same cursor/pending set" — embedded in the pointer comment
 *  body so comment-cursor-gate.ts's live marker-scan dedup (same idiom as conductor.ts's
 *  `commentOnEscalationCarrier`) recognizes a repeat of the SAME stale condition and skips
 *  reposting, while a NEW comment arriving (changing the pending set) gets its own fresh post.
 *
 *  #652 round 1 (finding 5), two hardenings:
 *   1. `cursor` is the result's own `target` (the RAW marker value an invalid cursor pointed at)
 *      when one is available, never a shared `"invalid"` literal — a cursor corrected from one
 *      still-invalid target to ANOTHER (e.g. 999 -> 998, both absent from the stream) must dedupe
 *      DISTINCTLY, or the maintainer's correction would be silently suppressed as "already
 *      posted." `target` is absent only for `missing-marker`/`comment-id-missing` (no single
 *      marker value exists to key on) and for the pure `pending`-cursor `ok: true` case (which
 *      already keys on its own real `cursor` instead) — both fall back to `"none"`.
 *   2. `pending` is serialized via `JSON.stringify`, not `Array.prototype.join(",")` — `join`
 *      collapses `[]` and `[""]` to the identical `""` string, so an id-less-comment edge case
 *      (pre-hardening, when a missing id silently became `""`) could dedupe-collide with a
 *      genuinely empty pending set. `JSON.stringify` distinguishes `"[]"` from `'[""]'`. */
export function commentCursorDedupeKey(result: CommentCursorResult): string {
  const reason = result.ok ? "pending" : result.reason;
  const cursor = result.ok ? result.cursor : (result.target ?? "none");
  const idsHash = createHash("sha256").update(JSON.stringify(result.pending)).digest("hex").slice(0, 12);
  return `${reason}:${cursor}:${idsHash}`;
}

export function commentCursorPointerMarker(dedupeKey: string): string {
  return `<!-- sapwood:comment-cursor-stale:${dedupeKey} -->`;
}

/** The needs-human pointer comment body (marker-suffixed by addIssueComment's own
 *  stampEngineComment — this function never appends ENGINE_COMMENT_MARKER itself).
 *
 *  #652 round 1 (finding 1/2): a `body-drift` result gets its OWN wording branch — "this issue's
 *  adjudication cursor is invalid" is simply false for a body-drift discard (the cursor itself
 *  may be perfectly valid; what changed is the body a session's decision was computed against),
 *  and the ordinary recovery steps below (advance the marker) do not apply — a body-drift discard
 *  needs no cursor/marker action, only the label removed. */
export function buildCommentCursorPointerComment(result: CommentCursorResult): string {
  const dedupeKey = commentCursorDedupeKey(result);
  if (!result.ok && result.reason === "body-drift") {
    return (
      `sapwood: ${result.detail} A pending decision was discarded rather than applied against ` +
      `stale text. No cursor/marker action is needed — remove \`needs-human\` to let the issue ` +
      `re-enter plan review normally on its next pass.\n\n${commentCursorPointerMarker(dedupeKey)}`
    );
  }
  const shown = result.pending.slice(0, POINTER_COMMENT_ID_CAP);
  const overflow = result.pending.length - shown.length;
  const list = shown.length > 0 ? shown.map((id) => `#${id}`).join(", ") + (overflow > 0 ? ` (+${overflow} more)` : "") : "(none listed)";
  const reason = result.ok
    ? "this issue's adjudication cursor is valid but does not yet cover every comment"
    : `this issue's adjudication cursor is invalid (${result.reason}: ${result.detail})`;
  return (
    `sapwood: ${reason}. Pending (non-engine) comment id(s): ${list}.\n\n` +
    `Recovery steps: record the ruling, rewrite the issue body to reflect it, advance the ` +
    `\`<!-- sapwood:comments-adjudicated-through: <comment-id> -->\` marker to the last comment ` +
    `you've adjudicated (or to \`0\` if none apply), then remove \`needs-human\`.\n\n${commentCursorPointerMarker(dedupeKey)}`
  );
}
