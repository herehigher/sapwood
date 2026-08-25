// markdown.test.ts (#1089): extractMarkdownSections' `level` argument. Fence-safety, nesting-
// dedup, and heading-boundary behavior are already covered indirectly via forge.test.ts's
// verification/acceptance-criteria extraction and architect.test.ts's extractArchitectureChapter
// tests (both any-level callers) — this file is scoped to the level-restriction behavior #1089
// added, including the default-unchanged guarantee and the H1-wraps-H2 case a post-filter over
// the any-level result cannot solve (see this function's own doc comment).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMarkdownSections } from "./markdown.js";

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
