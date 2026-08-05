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
