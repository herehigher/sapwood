// comment-cursor.test.ts (#652) — pure unit coverage for the comment-adjudication cursor:
// marker parse + stream-position pending-comment computation. Integration coverage (gate⓪
// pre-spend/pre-apply, dispatch claim/re-read, drive-entry recheck, dedup pointer comment) lives
// in the respective consumer test files, against the real loops — same split as
// ac-snapshot.test.ts vs. conductor.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRoleBodyRewrite,
  buildCommentCursorPointerComment,
  type CommentStreamEntry,
  checkMarkerWritePrecondition,
  commentCursorDedupeKey,
  commentCursorIsStale,
  commentCursorPointerMarker,
  computeCommentCursor,
  extractOperatorOwnedFences,
  findStandaloneMarkerLines,
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

// ── #703 v2 gate② (P2-1): malformed/blank marker ATTEMPTS are recognized as attempts (fence-
// aware), not silently read as "no marker at all". ──────────────────────────────────────────────

test("#703 v2 gate② P2-1: a BLANK-value marker attempt (nothing between the colon and -->) fails closed as malformed — never read as 'no marker'", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: -->";
  const result = computeCommentCursor(body, [entry("1")]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(
      result.reason,
      "malformed-marker",
      "must be malformed-marker, NOT missing-marker — the attempt is recognized, just invalid",
    );
    assert.deepEqual(result.pending, ["1"]);
  }
});

test("#703 v2 gate② P2-1: a MULTI-TOKEN marker attempt (two ids separated by whitespace) fails closed as malformed", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 5 6 -->";
  const result = computeCommentCursor(body, [entry("1")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("#703 v2 gate② P2-1: a whitespace-only value (tabs/spaces, no visible token) fails closed as malformed", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through:   \t  -->";
  const result = computeCommentCursor(body, [entry("1")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("#703 v2 gate② P2-1: a blank-value marker attempt survives CRLF line splitting exactly like an LF body — still malformed, never invisible", () => {
  const body = "body\r\n\r\n<!-- sapwood:comments-adjudicated-through: -->\r\n";
  const result = computeCommentCursor(body, [entry("1")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("#703 v2 gate② P2-1: a VALID marker on a CRLF body is still recognized normally (regression — the attempt-widening must not disturb ordinary CRLF handling)", () => {
  const body = "body\r\n\r\n<!-- sapwood:comments-adjudicated-through: 5 -->\r\n";
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.deepEqual(result, { ok: true, cursor: "5", pending: ["7"] });
});

test("#703 v2 gate② P2-1: a blank/malformed marker attempt INSIDE a fenced code block is still NOT recognized — fence-awareness applies to attempt-detection too, not just valid-value parsing", () => {
  const body = ["an example for a maintainer:", "", "```", "<!-- sapwood:comments-adjudicated-through: -->", "```"].join("\n");
  const result = computeCommentCursor(body, [entry("1")]);
  // No standalone attempt found (fenced) -> missing-marker (there IS a pending comment), never
  // malformed-marker (which would mean the fenced copy was wrongly treated as authoritative).
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("#703 v2 gate② P2-1: checkMarkerWritePrecondition refuses on a blank-value attempt — 'align repairs them' closed", () => {
  const result = checkMarkerWritePrecondition("body\n\n<!-- sapwood:comments-adjudicated-through: -->");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("#703 v2 gate② P2-1: checkMarkerWritePrecondition refuses on a multi-token attempt", () => {
  const result = checkMarkerWritePrecondition("body\n\n<!-- sapwood:comments-adjudicated-through: 5 6 -->");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("#703 v2 gate② P2-1: applyRoleBodyRewrite STRIPS a role-authored malformed/blank attempt regardless of validity — 'issue-creation leaves them' closed", () => {
  const roleBody = "A brand-new proposal.\n\n<!-- sapwood:comments-adjudicated-through: -->";
  const applied = applyRoleBodyRewrite("", roleBody);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.ok(
    !applied.body.includes("comments-adjudicated-through"),
    "the role's malformed attempt must never survive into the applied body",
  );
  assert.deepEqual(findStandaloneMarkerLines(applied.body), []);
});

test("#703 v2 gate② P2-1: applyRoleBodyRewrite STRIPS a role's malformed attempt even when the CURRENT body has a real marker to preserve instead", () => {
  const currentBody = "Old plan.\n\n<!-- sapwood:comments-adjudicated-through: 10 -->";
  const roleBody = "A revised plan.\n\n<!-- sapwood:comments-adjudicated-through: 5 6 -->";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(findStandaloneMarkerLines(applied.body), ["<!-- sapwood:comments-adjudicated-through: 10 -->"]);
  assert.ok(!applied.body.includes("5 6"));
});

test("duplicate marker: fails closed even when both instances agree", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 1 -->\n\nmore text\n\n<!-- sapwood:comments-adjudicated-through: 1 -->";
  const result = computeCommentCursor(body, [entry("1"), entry("2")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-marker");
});

// #703 v2 (ruling item 3 — "true position semantics"): a cursor pointing at an engine comment is
// now a VALID position, exactly like a non-engine one — these two tests replace the pre-v2
// "cursor targeting an engine comment: fails closed" test above.

test("#703 v2: cursor targeting an engine comment AFTER the last human comment — valid, zero pending (fully adjudicated)", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 6 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("6", true)]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cursor, "6");
    assert.deepEqual(result.pending, []);
  }
});

test("#703 v2: cursor targeting an engine comment BEFORE a later human comment — valid, that later comment is pending", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 6 -->";
  const result = computeCommentCursor(body, [entry("5"), entry("6", true), entry("7")]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cursor, "6");
    assert.deepEqual(result.pending, ["7"]);
  }
  assert.equal(
    commentCursorIsStale(result),
    true,
    "still stale — the pending human comment (7) is what makes it so, not the engine target",
  );
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

test("buildCommentCursorPointerComment: embeds the dedupe marker and lists pending ids as backticked raw ids, never '#N' (#703 v2 gate② P2-2)", () => {
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("42")]);
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /`42`/);
  assert.ok(!comment.includes("#42"), "never '#42' anywhere — that reads as a GitHub cross-reference, not a comment id");
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

// ── #652 round 2 (finding 3): delimiter-aware fence tracking ───────────────────────────────────

test("a ~~~ line inside a ``` fence does NOT close it — a marker right after stays non-authoritative (round-1 reproduction: the naive same-boolean toggle let this pair close the fence, making the marker authoritative)", () => {
  const body = ["```", "~~~", "<!-- sapwood:comments-adjudicated-through: 5 -->", "```"].join("\n");
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  // The marker never left the (still-open) ``` fence, so nothing standalone was found — with
  // non-engine comments present, that's missing-marker, never `cursor: "5"`.
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("a same-character but too-SHORT run (3 backticks inside a 4-backtick-opened fence) does not close it either — length, not just character, must match", () => {
  const body = ["````", "```", "<!-- sapwood:comments-adjudicated-through: 5 -->", "````"].join("\n");
  const result = computeCommentCursor(body, [entry("5"), entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("a ~~~ fence still closes normally on its own matching ~~~ closer — delimiter-awareness doesn't break the ordinary same-character case", () => {
  const body = ["~~~", "<!-- sapwood:comments-adjudicated-through: 5 -->", "~~~", "<!-- sapwood:comments-adjudicated-through: 7 -->"].join(
    "\n",
  );
  const result = computeCommentCursor(body, [entry("7"), entry("9")]);
  assert.deepEqual(
    result,
    { ok: true, cursor: "7", pending: ["9"] },
    "the fenced copy is ignored; the real standalone marker after it is honored",
  );
});

// ── #652 round 3 (finding 1): a closer must be BARE — info strings only open, never close ──────

test("a same-character, long-enough run WITH an info string (```not-a-closer inside a ```md fence) does not close it — CommonMark closers allow only whitespace after the run, so the marker after it stays fenced", () => {
  const body = ["```md", "```not-a-closer", "<!-- sapwood:comments-adjudicated-through: 7 -->", "```"].join("\n");
  const result = computeCommentCursor(body, [entry("7")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-marker");
});

test("an info-string OPENER still opens (```md) and a bare closer still closes — the closer restriction doesn't break the ordinary open-with-language case", () => {
  const body = [
    "```md",
    "<!-- sapwood:comments-adjudicated-through: 5 -->",
    "```",
    "<!-- sapwood:comments-adjudicated-through: 7 -->",
  ].join("\n");
  const result = computeCommentCursor(body, [entry("7")]);
  assert.deepEqual(
    result,
    { ok: true, cursor: "7", pending: [] },
    "the fenced copy is ignored; the real standalone marker after the bare closer is honored",
  );
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

// ── #703: engine preserves the adjudication marker across role body-writes (ruling, PO batch-11
// 2026-08-06, candidate 3) — the marker is PO/human-owned state; a role has no standing to move
// it, no matter what value its own output carries. ────────────────────────────────────────────

test("applyRoleBodyRewrite (#703a): current body has an existing marker — the applied body carries the ORIGINAL marker byte-for-byte even when the role's own output carries a DIFFERENT (engine-id) marker", () => {
  const currentBody = "Some plan.\n\n<!-- sapwood:comments-adjudicated-through: 123 -->\n";
  // The exact live batch-11 shape: plan_review's housekeeping advice told the drafter to advance
  // the marker to an ENGINE comment id (5204025029, #145's round-340 incident) — the role text
  // below reproduces that, plus rewritten body prose.
  const roleBody = "A revised plan, rewritten by the drafter.\n\n<!-- sapwood:comments-adjudicated-through: 5204025029 -->\n";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(findStandaloneMarkerLines(applied.body), ["<!-- sapwood:comments-adjudicated-through: 123 -->"]);
  assert.ok(!applied.body.includes("5204025029"), "the role's own (engine-id) marker attempt must not survive");
  assert.ok(applied.body.includes("A revised plan, rewritten by the drafter."), "the role's real content is preserved");
  // computeCommentCursor now sees the ORIGINAL marker, not the role's discarded one.
  const result = computeCommentCursor(applied.body, [
    { id: "123", isEngine: false },
    { id: "5204025029", isEngine: true },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cursor, "123");
});

test("applyRoleBodyRewrite (#703b): role output carries a marker, but the CURRENT body has none — the applied body has no marker either", () => {
  const currentBody = "Some plan with no marker at all.";
  const roleBody = "A revised plan.\n\n<!-- sapwood:comments-adjudicated-through: 999 -->\n";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(findStandaloneMarkerLines(applied.body), []);
  assert.ok(!applied.body.includes("999"));
  assert.ok(applied.body.includes("A revised plan."));
});

test("applyRoleBodyRewrite (#703c): no marker anywhere (current or role output) — behavior is unchanged, the role body passes through verbatim", () => {
  const currentBody = "Some plan with no marker.";
  const roleBody = "A revised plan, still with no marker.";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.deepEqual(applied, { ok: true, body: roleBody });
});

test("applyRoleBodyRewrite: current body's marker is preserved even when the role's redraft is ENTIRELY unrelated prose with no marker of its own", () => {
  const currentBody = "Old plan.\n\n<!-- sapwood:comments-adjudicated-through: 42 -->";
  const roleBody = "A completely rewritten plan section.";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(findStandaloneMarkerLines(applied.body), ["<!-- sapwood:comments-adjudicated-through: 42 -->"]);
  assert.ok(applied.body.includes("A completely rewritten plan section."));
});

// ── #827: operator-owned section fence — a role rewrite must preserve the fenced block
// byte-for-byte or the whole write is rejected (chosen arm: reject, see applyRoleBodyRewrite's
// own doc). ──────────────────────────────────────────────────────────────────────────────────

test("#827: a role-proposed body that alters a byte inside an operator-owned fence is rejected, naming the violation", () => {
  const currentBody = [
    "Some plan.",
    "",
    "<!-- sapwood:operator-owned -->",
    "Ruling: X is required.",
    "<!-- /sapwood:operator-owned -->",
    "",
  ].join("\n");
  const roleBody = [
    "Some plan, refined.",
    "",
    "<!-- sapwood:operator-owned -->",
    "Ruling: X is required (refined wording).",
    "<!-- /sapwood:operator-owned -->",
    "",
  ].join("\n");
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, false);
  if (applied.ok) return;
  assert.equal(applied.reason, "operator-fence-violation");
  assert.match(applied.detail, /operator-owned/);
});

test("#827: a role-proposed body that REMOVES an operator-owned fence entirely is rejected", () => {
  const currentBody = ["Plan.", "", "<!-- sapwood:operator-owned -->", "Ruling.", "<!-- /sapwood:operator-owned -->"].join("\n");
  const roleBody = "Plan, with the ruling silently dropped.";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.equal(applied.ok, false);
  if (applied.ok) return;
  assert.equal(applied.reason, "operator-fence-violation");
});

test("#827 (reverse test): a role-proposed body that only appends content AFTER the fence passes through unmodified — the fence must not over-trigger", () => {
  const fence = ["<!-- sapwood:operator-owned -->", "Ruling: X is required.", "<!-- /sapwood:operator-owned -->"].join("\n");
  const currentBody = `Some plan.\n\n${fence}\n`;
  const roleBody = `Some plan, drafter's additions before the fence.\n\n${fence}\n\nAppended after the fence, non-conflicting.`;
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.deepEqual(applied, { ok: true, body: roleBody });
});

test("#827: a currentBody with no operator-owned fence at all is unaffected — the fence check never over-triggers on absence", () => {
  const currentBody = "Plain plan, no fence.";
  const roleBody = "A revised plan, no fence either.";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.deepEqual(applied, { ok: true, body: roleBody });
});

test("#827: a fence quoted inside a GFM code block is not treated as authoritative, same fence-aware rule as the #703 marker", () => {
  const currentBody = [
    "Docs example:",
    "```",
    "<!-- sapwood:operator-owned -->",
    "example ruling",
    "<!-- /sapwood:operator-owned -->",
    "```",
  ].join("\n");
  const roleBody = "Docs example rewritten entirely, the code-quoted fence is gone.";
  const applied = applyRoleBodyRewrite(currentBody, roleBody);
  assert.deepEqual(applied, { ok: true, body: roleBody });
});

test("extractOperatorOwnedFences: byte-for-byte, includes both tag lines, in document order", () => {
  const body = ["pre", "<!-- sapwood:operator-owned -->", "line one", "line two", "<!-- /sapwood:operator-owned -->", "post"].join("\n");
  assert.deepEqual(extractOperatorOwnedFences(body), [
    ["<!-- sapwood:operator-owned -->", "line one", "line two", "<!-- /sapwood:operator-owned -->"].join("\n"),
  ]);
});

test("findStandaloneMarkerLines: returns the RAW (untrimmed) line text, not just the parsed value", () => {
  const body = "body\n  <!-- sapwood:comments-adjudicated-through: 7 -->  \nmore";
  assert.deepEqual(findStandaloneMarkerLines(body), ["  <!-- sapwood:comments-adjudicated-through: 7 -->  "]);
});

test("findStandaloneMarkerLines: fenced-code-quoted markers are NOT returned — same fence-aware rule as the value-only scan", () => {
  const body = ["```", "<!-- sapwood:comments-adjudicated-through: 5 -->", "```"].join("\n");
  assert.deepEqual(findStandaloneMarkerLines(body), []);
});

// ── #703 v2: recovery pointer comment is a COPY-PASTE instruction (ruling item 4) ───────────────

test("buildCommentCursorPointerComment (#703d v2, strengthened per gate② P2-2): the recovery text is the EXACT copy-paste marker line, worded 'comment id N' — and '#N' is absent from the ENTIRE rendered comment, for EVERY pending id, not just the accepted-target sentence", () => {
  const result = computeCommentCursor("no marker here", [
    { id: "10", isEngine: false },
    { id: "5204025029", isEngine: true },
    { id: "20", isEngine: false },
  ]);
  assert.deepEqual(result.pending, ["10", "20"], "fixture sanity: both non-engine ids are pending");
  const comment = buildCommentCursorPointerComment(result);
  // "20" is the newest non-engine comment by stream position.
  assert.match(comment, /<!-- sapwood:comments-adjudicated-through: 20 -->/, "the exact standalone marker line is present, verbatim");
  assert.match(comment, /comment id `20`/, "worded 'comment id', not a GitHub cross-reference");
  // #703 v2 gate② P2-2: the pre-fix code rendered the PENDING-id list as `#10, #20` — a substring
  // check on just "#20 --" (the accepted-marker line) missed that entirely. Assert `#<id>` is
  // absent for EVERY pending id, across the WHOLE comment (the pending-list sentence included).
  for (const id of result.pending) {
    assert.ok(!comment.includes(`#${id}`), `"#${id}" must not appear anywhere in the rendered comment`);
    assert.match(comment, new RegExp("`" + id + "`"), `comment id ${id} must appear backticked (raw), e.g. in the pending-id list`);
  }
});

test("buildCommentCursorPointerComment (#703d v2): names comment id `0` (not a GitHub reference) when no non-engine comments exist at all", () => {
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: bogus -->", [{ id: "1", isEngine: true }]);
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /<!-- sapwood:comments-adjudicated-through: 0 -->/);
  assert.match(comment, /comment id `0`/);
});

test("buildCommentCursorPointerComment (#703d v2): a cursor already targeting an engine comment (now VALID, but still stale because a later human comment is pending) recommends the real pending non-engine id, not the engine one", () => {
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 5203999519 -->", [
    { id: "5203999519", isEngine: true },
    { id: "88", isEngine: false },
  ]);
  assert.equal(result.ok, true, "v2: an engine-comment target is a valid position now");
  if (result.ok) assert.deepEqual(result.pending, ["88"]);
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /<!-- sapwood:comments-adjudicated-through: 88 -->/);
  assert.ok(!comment.includes("comments-adjudicated-through: 5203999519 -->"), "never recommends the already-adjudicated engine id");
});

test("buildCommentCursorPointerComment (#703 v2): duplicate-marker case tells the human to remove every OTHER marker line and keep exactly the one shown", () => {
  const body = "body\n\n<!-- sapwood:comments-adjudicated-through: 1 -->\n\nmore\n\n<!-- sapwood:comments-adjudicated-through: 2 -->";
  const result = computeCommentCursor(body, [entry("5")]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-marker");
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /remove every OTHER `sapwood:comments-adjudicated-through` line/);
  assert.match(comment, /<!-- sapwood:comments-adjudicated-through: 5 -->/, "still names a concrete copy-paste line to keep");
});

test("buildCommentCursorPointerComment (#703 v2): comment-id-missing gets its own honest text — a forge-read failure, no suggested marker target", () => {
  const result = computeCommentCursor("<!-- sapwood:comments-adjudicated-through: 0 -->", [entry("1"), { id: null, isEngine: false }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "comment-id-missing");
  const comment = buildCommentCursorPointerComment(result);
  assert.match(comment, /forge-READ problem/);
  assert.match(comment, /[Rr]etry the comment fetch/);
  assert.ok(
    !comment.includes("sapwood:comments-adjudicated-through: "),
    "no marker target is offered — one cannot be honestly vouched for",
  );
});

// ── #703 v2: checkMarkerWritePrecondition — the refusal arm (ruling item 2) ─────────────────────

test("checkMarkerWritePrecondition: no marker at all -> ok (nothing to refuse over)", () => {
  assert.deepEqual(checkMarkerWritePrecondition("plain body, no marker"), { ok: true });
});

test("checkMarkerWritePrecondition: a single well-formed marker (a digit id, or '0') -> ok", () => {
  assert.deepEqual(checkMarkerWritePrecondition("body\n\n<!-- sapwood:comments-adjudicated-through: 42 -->"), { ok: true });
  assert.deepEqual(checkMarkerWritePrecondition("<!-- sapwood:comments-adjudicated-through: 0 -->"), { ok: true });
});

test("checkMarkerWritePrecondition: a malformed marker value refuses (never repaired) — reason 'malformed-marker'", () => {
  const result = checkMarkerWritePrecondition("<!-- sapwood:comments-adjudicated-through: not-a-number -->");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-marker");
});

test("checkMarkerWritePrecondition: more than one marker line refuses — reason 'duplicate-marker'", () => {
  const body = "<!-- sapwood:comments-adjudicated-through: 1 -->\n\n<!-- sapwood:comments-adjudicated-through: 2 -->";
  const result = checkMarkerWritePrecondition(body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-marker");
});
