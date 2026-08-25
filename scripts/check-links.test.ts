// check-links.test.ts: covers the GitHub heading-slug port (see check-links.ts's module
// comment for the algorithm and its two traps) — the piece a naive `\w`/`\p{N}`-based port
// gets wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingSlugs, slugify } from "./check-links.ts";

test("slugify: drops a circled digit (category No), unlike \\w or \\p{N}", () => {
  // '⓪' and '②' are Unicode category No (other number) — GitHub's own slugger drops them,
  // so a correct port must too. `\w` and `\p{N}` both over-keep this category.
  assert.equal(slugify("gate⓪ (#88)"), "gate-88");
  assert.equal(slugify("step② done"), "step-done");
});

test("slugify: an em dash between two spaces yields a double hyphen (no run-collapsing)", () => {
  // The em dash itself is dropped (not a letter/mark/digit), but both surrounding spaces
  // survive and each becomes its own hyphen — GitHub does not collapse hyphen runs.
  assert.equal(slugify("table — reading"), "table--reading");
});

test("slugify: strips inline code and emphasis markers before slugging", () => {
  assert.equal(slugify("`foo` and *bar*"), slugify("foo and bar"));
  assert.equal(slugify("`foo` and *bar*"), "foo-and-bar");
  assert.equal(slugify("_underscored_ heading"), "underscored-heading");
});

test("slugify: keeps letters, combining marks, and decimal digits from other scripts", () => {
  assert.equal(slugify("café"), "café");
  assert.equal(slugify("日本語 heading"), "日本語-heading");
});

test("headingSlugs: duplicate headings get GitHub's -1, -2, ... suffixes", () => {
  const content = "# Foo\n\nsome text\n\n## Foo\n\nmore text\n\n### Foo\n";
  assert.deepEqual(headingSlugs(content), new Set(["foo", "foo-1", "foo-2"]));
});

test("headingSlugs: only lines that begin with 1-6 '#'s followed by whitespace count as headings", () => {
  const content = "#NotAHeading\n\n# Real Heading\n\nsome #hashtag mid-line\n";
  assert.deepEqual(headingSlugs(content), new Set(["real-heading"]));
});

test("headingSlugs: ignores content past six '#' levels' worth of leading hashes as literal text", () => {
  // A 7th '#' is not part of the heading marker under GitHub's rule (max h1-h6); the whole
  // line is left un-recognized as a heading, matching the ATX heading grammar.
  const content = "####### Too Deep\n";
  assert.deepEqual(headingSlugs(content), new Set());
});

test("headingSlugs: normalizes CRLF line endings before scanning", () => {
  const content = "# One\r\n\r\n## Two\r\n";
  assert.deepEqual(headingSlugs(content), new Set(["one", "two"]));
});
