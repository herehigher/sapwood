import assert from "node:assert/strict";
import { test } from "node:test";
import { headingSlugs } from "./markdown-slug.js";

test("headingSlugs: a '#' line inside a backtick-fenced code block is not a heading, even though it matches the heading regex", () => {
  const content = ["# Real Heading", "", "```bash", "# not-a-heading", "```", "", "## Another Real Heading"].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["real-heading", "another-real-heading"]));
});

test("headingSlugs: a '#' line inside a tilde-fenced code block is not a heading", () => {
  const content = ["# Real Heading", "", "~~~bash", "# not-a-heading", "~~~", "", "## Another Real Heading"].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["real-heading", "another-real-heading"]));
});

test("headingSlugs: an unterminated fence swallows every line after it, including real headings", () => {
  const content = ["# Before The Fence", "", "```text", "# inside, not a heading", "", "## Never Collected"].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["before-the-fence"]));
});

test("headingSlugs: a fence-open-looking line with trailing content does not close an open fence", () => {
  // The "```text" line below has trailing content after its backtick run, so per the closing-fence
  // rule (nothing but optional trailing whitespace after the run) it does NOT close the fence
  // opened by "```bash" — the real closer is the bare "```" two lines later.
  const content = ["# Heading One", "", "```bash", "```text", "# still inside, not a heading", "```", "", "## Heading Two"].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["heading-one", "heading-two"]));
});

test("headingSlugs: a 4-space-indented '```' is indented code, not a fence — it never opens one", () => {
  const content = ["# Heading One", "", "    ```", "# Also Collected", "", "## Heading Two"].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["heading-one", "also-collected", "heading-two"]));
});
