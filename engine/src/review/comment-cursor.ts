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
// pass-through case (AC8's reverse test: byte-identical to today).
import { createHash } from "node:crypto";

const MARKER_RE = /<!--\s*sapwood:comments-adjudicated-through:\s*(\S+?)\s*-->/g;

/** One comment in the fetched, oldest-first issue-comment stream. `isEngine` is resolved by the
 *  CALLER (comment-cursor-gate.ts): both the central `ENGINE_COMMENT_MARKER` (forge.ts) present
 *  in the body AND an authoritative match to the authenticated forge actor — never either alone
 *  (design adjudicated 2026-08-05's engine-comment exemption rule). This module never inspects
 *  comment bodies/authors itself; it only consumes the already-resolved flag. */
export interface CommentStreamEntry {
  id: string;
  isEngine: boolean;
}

export type CursorFailureReason =
  | "missing-marker"
  | "malformed-marker"
  | "duplicate-marker"
  | "cursor-targets-engine-comment"
  | "cursor-target-not-found";

export type CommentCursorResult =
  | { ok: true; cursor: string; pending: string[] }
  | { ok: false; reason: CursorFailureReason; detail: string; pending: string[] };

/** Parse the adjudication-cursor marker out of `body` and compute the PENDING non-engine
 *  comment ids — those occurring, by stream position, after the cursor's target in `comments`
 *  (oldest-first, exactly as the forge returned them; this function never reorders). `pending`
 *  is populated on every branch (including every `ok: false` arm) so a caller building the
 *  needs-human pointer comment (comment-cursor-gate.ts) always has a best-effort candidate list
 *  — for a failure arm this is "every non-engine comment", since an invalid/unknown cursor
 *  cannot vouch for anything being adjudicated. */
export function computeCommentCursor(body: string, comments: readonly CommentStreamEntry[]): CommentCursorResult {
  const allNonEngineIds = comments.filter((c) => !c.isEngine).map((c) => c.id);
  const matches = [...body.matchAll(MARKER_RE)];

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
    };
  }

  const raw = matches[0]![1]!;
  if (raw === "0") return { ok: true, cursor: "0", pending: allNonEngineIds };
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      reason: "malformed-marker",
      detail: `the adjudication-cursor marker's value "${raw}" is neither "0" nor a comment id`,
      pending: allNonEngineIds,
    };
  }

  const idx = comments.findIndex((c) => c.id === raw);
  if (idx === -1) {
    return {
      ok: false,
      reason: "cursor-target-not-found",
      detail: `the adjudication cursor points at comment ${raw}, which no longer exists in the issue's comment stream`,
      pending: allNonEngineIds,
    };
  }
  if (comments[idx]!.isEngine) {
    return {
      ok: false,
      reason: "cursor-targets-engine-comment",
      detail: `the adjudication cursor points at comment ${raw}, which is an engine comment — the marker must identify a concrete NON-engine comment`,
      pending: allNonEngineIds,
    };
  }

  return {
    ok: true,
    cursor: raw,
    pending: comments
      .slice(idx + 1)
      .filter((c) => !c.isEngine)
      .map((c) => c.id),
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
 *  reposting, while a NEW comment arriving (changing the pending set) gets its own fresh post. */
export function commentCursorDedupeKey(result: CommentCursorResult): string {
  const reason = result.ok ? "pending" : result.reason;
  const cursor = result.ok ? result.cursor : "invalid";
  const idsHash = createHash("sha256").update(result.pending.join(",")).digest("hex").slice(0, 12);
  return `${reason}:${cursor}:${idsHash}`;
}

export function commentCursorPointerMarker(dedupeKey: string): string {
  return `<!-- sapwood:comment-cursor-stale:${dedupeKey} -->`;
}

/** The needs-human pointer comment body (marker-suffixed by addIssueComment's own
 *  stampEngineComment — this function never appends ENGINE_COMMENT_MARKER itself). */
export function buildCommentCursorPointerComment(result: CommentCursorResult): string {
  const dedupeKey = commentCursorDedupeKey(result);
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
