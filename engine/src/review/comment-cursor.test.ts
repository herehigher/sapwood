// comment-cursor.test.ts (#652) — pure unit coverage for the comment-adjudication cursor:
// marker parse + stream-position pending-comment computation. Integration coverage (gate⓪
// pre-spend/pre-apply, dispatch claim/re-read, drive-entry recheck, dedup pointer comment) lives
// in the respective consumer test files, against the real loops — same split as
// ac-snapshot.test.ts vs. conductor.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCommentCursorPointerComment,
  type CommentStreamEntry,
  commentCursorDedupeKey,
  commentCursorIsStale,
  commentCursorPointerMarker,
  computeCommentCursor,
} from "./comment-cursor.js";

function entry(id: string, isEngine = false): CommentStreamEntry {
  return { id, isEngine };
}

test("no marker, zero comments: ok, cursor 0, nothing pending (AC8 reverse-test shape)", () => {
  const result = computeCommentCursor("just a plain issue body", []);
  assert.deepEqual(result, { ok: true, cursor: "0", pending: [] });
  assert.equal(commentCursorIsStale(result), false);
});

test("no marker, WITH non-engine comments: fails closed (the batch-8 shape — nothing vouches for adjudication)", () => {
  const result = computeCommentCursor("plain body, no marker", [entry("1"), entry("2")]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing-marker");
    assert.deepEqual(result.pending, ["1", "2"]);
  }
  assert.equal(commentCursorIsStale(result), true);
});

test("no marker, only engine comments: pass-through — nothing NON-engine is pending", () => {
  const result = computeCommentCursor("plain body, no marker", [entry("1", true), entry("2", true)]);
  assert.deepEqual(result, { ok: true, cursor: "0", pending: [] });
});

test("cursor 0, explicit: valid marker, but every non-engine comment is pending (nothing adjudicated yet)", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("6", true), entry("7")]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cursor, "0");
    assert.deepEqual(result.pending, ["5", "7"]);
  }
  assert.equal(commentCursorIsStale(result), true);
});

test("cursor pointing at the last comment: fully adjudicated, nothing pending", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 7 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("6", true), entry("7")]);
  assert.deepEqual(result, { ok: true, cursor: "7", pending: [] });
  assert.equal(commentCursorIsStale(result), false);
});

test("cursor pointing mid-stream: only STREAM-POSITION-later non-engine comments are pending, not numerically-later ids", () => {
  // Deliberately non-monotonic ids to prove stream position (array index), not numeric comparison, governs.
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 100 -->";
  const result = computeCommentCursor(body, [entry("2"), entry("100"), entry("50"), entry("3", true), entry("9")]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.pending, ["50", "9"]);
});

test("malformed marker (non-numeric, not '0'): fails closed", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: not-a-number -->";
  const result = computeCommentCursor(body, [entry("1")]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "malformed-marker");
    assert.deepEqual(result.pending, ["1"]);
  }
});

test("duplicate marker: fails closed even when both instances agree", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 1 -->\n\nmore text\n\n<!-- sapwood:comments-adjudicated-through: 1 -->";
  const result = computeCommentCursor(body, [entry("1"), entry("2")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-marker");
});

test("cursor targeting an engine comment: fails closed — the marker must identify a concrete NON-engine comment", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 6 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("6", true), entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "cursor-targets-engine-comment");
});

test("cursor targeting a deleted (no-longer-present) comment: fails closed", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 999 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "cursor-target-not-found");
    // Fail-closed listing: every non-engine comment, since an unknown cursor vouches for nothing.
    assert.deepEqual(result.pending, ["5", "7"]);
  }
});

test("a deleted PENDING comment (not the cursor target) simply no longer supplies content — not a failure", () => {
  // The cursor's target (5) still exists; a later comment (6) that existed when posted has since
  // been deleted and is absent from the fetched stream — the remaining pending set just shrinks.
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 5 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.deepEqual(result, { ok: true, cursor: "5", pending: ["7"] });
});

test("commentCursorDedupeKey: identical cursor+pending sets produce the identical key", () => {
  const a = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1"), entry("2")]);
  const b = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1"), entry("2")]);
  assert.equal(commentCursorDedupeKey(a), commentCursorDedupeKey(b));
});

test("commentCursorDedupeKey: a NEW pending comment changes the key (so a fresh post is not suppressed)", () => {
  const a = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1")]);
  const b = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1"), entry("2")]);
  assert.notEqual(commentCursorDedupeKey(a), commentCursorDedupeKey(b));
});

test("commentCursorDedupeKey: an invalid-cursor reason is part of the key, distinct from a valid-cursor pending state", () => {
  const invalid = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: bogus -->", [entry("1")]);
  const valid = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1")]);
  assert.notEqual(commentCursorDedupeKey(invalid), commentCursorDedupeKey(valid));
});

test("buildCommentCursorPointerComment: embeds the dedupe marker and lists pending ids", () => {
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("42")]);
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /#42/);
  assert.match(comment, /needs-human/);
  assert.ok(comment.includes(commentCursorPointerMarker(commentCursorDedupeKey(result))));
});

test("buildCommentCursorPointerComment: bounds the listed ids on a large pending set", () => {
  const many = Array.from({ length: 50 }, (_, i) => entry(String(i)));
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", many);
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /\+\d+ more/);
});

// ── #652 round 1 (finding 4): marker recognition is STANDALONE-LINE anchored ────────────────────

test("marker inside inline-code backticks on its own line: NOT recognized — the whole trimmed line must be the marker alone, not backtick-wrapped", () => {
  const body = "body\n\n`<!-- sapwood:comments-adjudicated-through: 5 -->`\n\nmore text";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  // No standalone marker found -> missing-marker (there ARE non-engine comments).
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("marker inside a fenced code block: NOT recognized, even though it sits alone on its own line", () => {
  const body = [
    "an issue body showing the syntax to a maintainer:",
    "",
    "```",
    "<!-- sapwood:comments-adjudicated-through: 5 -->",
    "```",
  ].join("\n");
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("marker with surrounding prose on the same line: NOT recognized — prose disqualifies it from being the WHOLE trimmed line", () => {
  const body = "see the marker: <!-- sapwood:comments-adjudicated-through: 5 --> (an example)";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("marker as the real standalone form (possibly with leading/trailing whitespace on its own line): STILL recognized", () => {
  const body = "body\n\n  <!-- sapwood:comments-adjudicated-through: 5 -->  \n\nmore text";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.deepEqual(result, { ok: true, cursor: "5", pending: ["7"] });
});

test("a standalone marker OUTSIDE a fence still counts even when the body ALSO shows a fenced quoted example — real ambiguity, only the fenced copy is ignored", () => {
  const body = [
    "<!-- sapwood:comments-adjudicated-through: 5 -->",
    "",
    "example syntax:",
    "```",
    "<!-- sapwood:comments-adjudicated-through: 999 -->",
    "```",
  ].join("\n");
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.deepEqual(result, { ok: true, cursor: "5", pending: ["7"] }, "only the real, un-fenced marker is honored");
});

// ── #652 round 1 (finding 5): dedup-key target-keying + serialization hardening ─────────────────

test("commentCursorDedupeKey: a cursor re-pointed from one still-invalid target to ANOTHER (999 -> 998, both absent) dedupes DISTINCTLY — the correction still gets a fresh post", () => {
  const a = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 999 -->", [entry("1")]);
  const b = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 998 -->", [entry("1")]);
  assert.equal((a as { ok: false; reason: string }).reason, "cursor-target-not-found");
  assert.equal((b as { ok: false; reason: string }).reason, "cursor-target-not-found");
  assert.notEqual(commentCursorDedupeKey(a), commentCursorDedupeKey(b), "999 and 998 must not share a dedup key");
});

test("commentCursorDedupeKey: pending [] and pending [\"\"] never collide — JSON.stringify, not join(',')", () => {
  const empty = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", []);
  const singleEmptyId = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("")]);
  assert.notEqual(commentCursorDedupeKey(empty), commentCursorDedupeKey(singleEmptyId));
});

// ── #652 round 1 (finding 5): missing comment id fails closed ────────────────────────────────────

test("a comment with a null id anywhere in the stream fails closed: comment-id-missing, carrying its stream position", () => {
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = computeCommentCursor(body, [entry("1"), { id: null, isEngine: false }, entry("2")]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "comment-id-missing");
    assert.match(result.detail, /stream position 1/);
    // Best-effort listing: every non-engine comment that DOES carry an id.
    assert.deepEqual(result.pending, ["1", "2"]);
  }
});

test("a comment with a null id is fail-closed even when the marker would otherwise be perfectly valid and fully adjudicated", () => {
  const body = "<!-- sapwood:comments-adjudicated-through: 2 -->";
  const result = computeCommentCursor(body, [entry("1"), entry("2"), { id: null, isEngine: true }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "comment-id-missing");
  assert.equal(commentCursorIsStale(result), true);
});

test("an id-less comment that IS an engine comment still fails closed — engine status never exempts the missing-id check", () => {
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = computeCommentCursor(body, [{ id: null, isEngine: true }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "comment-id-missing");
});
