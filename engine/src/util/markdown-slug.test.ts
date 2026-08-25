import assert from "node:assert/strict";
import { test } from "node:test";
import { headingSlugs } from "./markdown-slug.js";

test("headingSlugs: a '#' line inside a fenced code block is not a heading, even though it matches the heading regex", () => {
  const content = [
    "# Real Heading",
    "",
    "```bash",
    "# not-a-heading (a shell comment in a code sample)",
    "```",
    "",
    "## Another Real Heading",
  ].join("\n");
  assert.deepEqual(headingSlugs(content), new Set(["real-heading", "another-real-heading"]));
});
