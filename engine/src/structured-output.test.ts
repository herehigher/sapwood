// structured-output.test.ts (#110 PR1): the shared sentinel-delimited block parser — pure
// slicing only, no JSON/schema validation (that's the per-role caller's job, see
// plan-review.test.ts for gate⓪'s). Every fail-closed shape (truncated sentinel, missing block,
// no body) is covered here so callers can trust "block found" actually means well-formed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStructuredBlock, RESULT_BLOCK_START, RESULT_BLOCK_END, BODY_BLOCK_START, BODY_BLOCK_END,
} from "./structured-output.js";

test("parseStructuredBlock: metadata only, no BODY block — body is undefined", () => {
  const text = `Some reasoning preamble.\n\n${RESULT_BLOCK_START}\n{"decision":"approve","issue":1}\n${RESULT_BLOCK_END}\n`;
  const block = parseStructuredBlock(text);
  assert.ok(block);
  assert.equal(block!.metadataRaw, `{"decision":"approve","issue":1}`);
  assert.equal(block!.body, undefined);
});

test("parseStructuredBlock: metadata + BODY block — body is sliced with the sentinel-line newlines stripped, everything else verbatim", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"issue":9}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\n## Verification\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n${BODY_BLOCK_END}\n`;
  const block = parseStructuredBlock(text);
  assert.ok(block);
  assert.equal(block!.metadataRaw, `{"issue":9}`);
  assert.equal(block!.body, "## Verification\n\n```js\nconst x = 1;\n```");
});

test("parseStructuredBlock: no RESULT sentinel at all -> null", () => {
  assert.equal(parseStructuredBlock("just some prose, no structured output here"), null);
});

test("parseStructuredBlock: truncated RESULT block (start sentinel, no matching end) -> null, never a partial slice", () => {
  const text = `${RESULT_BLOCK_START}\n{"decision":"approve"`; // stream cut off mid-emit
  assert.equal(parseStructuredBlock(text), null);
});

test("parseStructuredBlock: truncated BODY block (start sentinel, no matching end) -> null for the WHOLE block, not a metadata-only fallback", () => {
  const text = `${RESULT_BLOCK_START}\n{"decision":"draft_request","issue":1}\n${RESULT_BLOCK_END}\n${BODY_BLOCK_START}\nhalf a brief, then the stream just stops`;
  assert.equal(parseStructuredBlock(text), null);
});

test("parseStructuredBlock: LAST occurrence wins when the session's own reasoning quotes an earlier example of the format", () => {
  const earlier = `${RESULT_BLOCK_START}\n{"decision":"draft_request","issue":999}\n${RESULT_BLOCK_END}\n`;
  const real = `${RESULT_BLOCK_START}\n{"decision":"approve","issue":1}\n${RESULT_BLOCK_END}\n`;
  const text = `Here's an example of the format:\n${earlier}\nNow my actual decision:\n${real}`;
  const block = parseStructuredBlock(text);
  assert.ok(block);
  assert.equal(block!.metadataRaw, `{"decision":"approve","issue":1}`);
});

test("parseStructuredBlock: a BODY block belonging to an earlier, superseded RESULT block never leaks into the final one's undefined body", () => {
  // The earlier example carries its OWN body; the real (last) block carries none. The body
  // search starts strictly after the LAST result block's end sentinel, so the earlier body must
  // never be picked up.
  const earlier =
    `${RESULT_BLOCK_START}\n{"decision":"draft_request","issue":999}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nstale example brief\n${BODY_BLOCK_END}\n`;
  const real = `${RESULT_BLOCK_START}\n{"decision":"approve","issue":1}\n${RESULT_BLOCK_END}\n`;
  const block = parseStructuredBlock(`${earlier}\n${real}`);
  assert.ok(block);
  assert.equal(block!.body, undefined);
});

test("parseStructuredBlock: empty input -> null", () => {
  assert.equal(parseStructuredBlock(""), null);
});

test("parseStructuredBlock: metadataRaw is trimmed of surrounding whitespace/newlines", () => {
  const text = `${RESULT_BLOCK_START}\n\n  {"issue":1}  \n\n${RESULT_BLOCK_END}`;
  const block = parseStructuredBlock(text);
  assert.equal(block!.metadataRaw, `{"issue":1}`);
});
