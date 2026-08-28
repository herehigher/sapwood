// markdown.test.ts (#1089): extractMarkdownSections' `level` argument. Fence-safety, nesting-
// dedup, and heading-boundary behavior are already covered indirectly via forge.test.ts's
// verification/acceptance-criteria extraction and architect.test.ts's extractArchitectureChapter
// tests (both any-level callers) — this file is scoped to the level-restriction behavior #1089
// added, including the default-unchanged guarantee and the H1-wraps-H2 case a post-filter over
// the any-level result cannot solve (see this function's own doc comment).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMarkdownSections, stripHtmlComments } from "./markdown.js";

test("extractMarkdownSections: level=2 matches only a heading with exactly two hashes, ignoring an H1 with the same text — the H3 below is a deeper heading so it stays inside the H2's own section, not a phantom H3-level match", () => {
  const doc = "# Constraints\nirrelevant H1\n\n## Constraints\nthe real section\n\n### Constraints\nnested\n\n## Next\nN";
  assert.deepEqual(extractMarkdownSections(doc, /Constraints\b/, 2), ["## Constraints\nthe real section\n\n### Constraints\nnested"]);
});

test("extractMarkdownSections: level omitted matches any level 1-6 — byte-identical to pre-`level` behavior, including an H1 match", () => {
  const doc = "# Title\n\n## Architecture (v1)\nsome decisions\nmore text\n\n## Security\nirrelevant";
  assert.deepEqual(extractMarkdownSections(doc, /Architecture\b/), ["## Architecture (v1)\nsome decisions\nmore text"]);
  // An H1 match's section runs through the next equal-or-SHALLOWER heading only — a deeper H2
  // below it doesn't terminate the H1's own section (pre-existing any-level nesting semantics,
  // unaffected by the `level` argument).
  assert.deepEqual(extractMarkdownSections("# Constraints\nbody\n## Next\nN", /Constraints\b/), ["# Constraints\nbody\n## Next\nN"]);
});

test("extractMarkdownSections: level=2 finds the H2 even when an H1 of the same text wraps it — the case a post-filter over the any-level result cannot solve (the any-level match already collapsed the H2 into its enclosing H1)", () => {
  const doc = "# Constraints\n## Constraints\nthe real section\n## Next\nN";
  // Any-level: the outer H1 "# Constraints" matches first and its section (start to the next
  // equal-or-shallower heading, i.e. none until EOF at this nesting) swallows the inner H2 —
  // extractMarkdownSections' own nested-match dedup then never emits the H2 on its own.
  const anyLevel = extractMarkdownSections(doc, /Constraints\b/);
  assert.equal(anyLevel.length, 1);
  assert.ok(anyLevel[0]!.startsWith("# Constraints"));
  // level=2 excludes the H1 from matching at all (only the heading regex itself narrows — the H1
  // still terminates/bounds other sections as any heading does), so the H2 is the only match.
  assert.deepEqual(extractMarkdownSections(doc, /Constraints\b/, 2), ["## Constraints\nthe real section"]);
});

test("extractMarkdownSections: level=2 with only an H3 of the matching text (no H2 at all) finds nothing — never double-counts the H3 as a standalone match", () => {
  const doc = "## Architecture\nchapter body\n### Constraints\nnested, not a real Constraints section\nmore chapter body\n## Next\nN";
  assert.deepEqual(extractMarkdownSections(doc, /Constraints\b/, 2), []);
});

test("extractMarkdownSections: level=2 with an H3 of the matching text BEFORE the real H2 (nested under an earlier, unrelated H2) still returns exactly the H2 section — the H3 never leaks into it", () => {
  const doc = "## Goal\n### Constraints\nnested under Goal, not the real section\n## Constraints\nthe real section\n## Next\nN";
  assert.deepEqual(extractMarkdownSections(doc, /Constraints\b/, 2), ["## Constraints\nthe real section"]);
});

// ── #830: stripHtmlComments — the loader-side fix for scaffold HTML comments live-injected raw
// into worker/architect/po-align prompts. Fixture shapes below mirror the REAL comment shapes in
// goal-template.md/doctrine-template.md (multi-line, blank line before the next heading), not
// synthetic single-line comments — the regex must survive the shape that actually ships.

test("stripHtmlComments: removes a multi-line HTML comment shaped like doctrine-template.md's leading header, leaving the heading that follows intact", () => {
  const doc = [
    "<!--",
    "  sapwood review doctrine — this repository's own review knowledge.",
    "  Configured as `doctrine.file` in sapwood.config.yaml (default: docs/REVIEW-DOCTRINE.md).",
    "-->",
    "",
    "# Review doctrine",
    "",
    "This project's own technical invariants.",
  ].join("\n");
  const stripped = stripHtmlComments(doc);
  assert.ok(!stripped.includes("<!--"));
  assert.ok(!stripped.includes("-->"));
  assert.ok(!stripped.includes("Configured as `doctrine.file`"));
  // Plain-prose control content — never touched by the strip.
  assert.ok(stripped.includes("# Review doctrine"));
  assert.ok(stripped.includes("This project's own technical invariants."));
});

test("stripHtmlComments: two separate comments in the same document are each removed independently — non-greedy, never merges into one match that also eats the prose between them", () => {
  const doc = "<!-- first comment -->\nREAL PROSE IN BETWEEN\n<!-- second comment\n  spanning lines -->\nMORE REAL PROSE";
  const stripped = stripHtmlComments(doc);
  assert.ok(!stripped.includes("<!--"));
  assert.ok(!stripped.includes("first comment"));
  assert.ok(!stripped.includes("second comment"));
  assert.ok(stripped.includes("REAL PROSE IN BETWEEN"), "prose between two comments must survive, not be swallowed by a greedy match");
  assert.ok(stripped.includes("MORE REAL PROSE"));
});

test("stripHtmlComments: a document with no HTML comment at all is returned byte-for-byte unchanged", () => {
  const doc = "# Goal\n\nWhat is this project trying to achieve? One or two sentences.\n";
  assert.equal(stripHtmlComments(doc), doc);
});

test("stripHtmlComments: an empty string stays empty", () => {
  assert.equal(stripHtmlComments(""), "");
});

// ── #830 gate② P1: a blanket regex is not Markdown-aware — it corrupts a `<!-- ... -->` marker
// quoted inside a backtick span (docs/REVIEW-DOCTRINE.md:55's own floor-marker example) or shown
// as a literal inside a fenced code block. The scanner must preserve BOTH verbatim while still
// stripping a real, code-free comment. Red-before: on the pre-scanner blanket-regex code, this
// assertion fails — the backtick span collapses to `` `` `` (its comment content deleted) and the
// fenced block's own comment example is deleted too.

test("stripHtmlComments: preserves a comment-shaped marker inside a backtick span AND a comment-shaped example inside a fenced code block, stripping only the real comment outside both", () => {
  assert.equal(
    stripHtmlComments("Keep `<!-- sapwood:ac -->`.\n```md\n<!-- example -->\n```\n<!-- guidance -->\nREAL"),
    "Keep `<!-- sapwood:ac -->`.\n```md\n<!-- example -->\n```\n\nREAL",
  );
});

test("stripHtmlComments: an unterminated `<!--` (no matching `-->` anywhere after it) is left byte-for-byte unchanged, never stripped to end-of-string — keeping possibly-real trailing content is safer than silently deleting it on a parse ambiguity", () => {
  const doc = "REAL PROSE BEFORE\n<!-- this comment never closes\nmore text that looks like it could be real doctrine";
  assert.equal(stripHtmlComments(doc), doc);
});

test("stripHtmlComments: a backtick run with no matching equal-length closer anywhere in the text is literal text, not a span — a comment after it on the same line is still stripped", () => {
  assert.equal(stripHtmlComments("stray ` backtick <!-- drop me --> REAL"), "stray ` backtick  REAL");
});
