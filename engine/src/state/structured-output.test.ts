// structured-output.test.ts (#110 PR1): the shared sentinel-delimited block parser — pure
// slicing only, no JSON/schema validation (that's the per-role caller's job, see
// plan-review.test.ts for gate⓪'s). Every fail-closed shape (truncated sentinel, missing block,
// no body) is covered here so callers can trust "block found" actually means well-formed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BODY_BLOCK_END,
  BODY_BLOCK_START,
  DecomposeOutputMetadataSchema,
  isUnresolvedContext,
  parseStructuredBlock,
  RESULT_BLOCK_END,
  RESULT_BLOCK_START,
  UnresolvedContextSchema,
} from "./structured-output.js";

// ── #234: unresolvedContext — abstention as a first-class, COMPLETE deliverable ─────────────

test("UnresolvedContextSchema: a reason-bearing unresolvedContext validates as a complete deliverable", () => {
  const parsed = UnresolvedContextSchema.safeParse({ unresolvedContext: { reason: "budget exhausted before reaching a decisive fact" } });
  assert.equal(parsed.success, true);
});

test("UnresolvedContextSchema: an empty reason fails (an abstention with no reason is as unaccountable as an ungrounded decision)", () => {
  assert.equal(UnresolvedContextSchema.safeParse({ unresolvedContext: { reason: "" } }).success, false);
  assert.equal(UnresolvedContextSchema.safeParse({ unresolvedContext: { reason: "   " } }).success, false);
});

test("DecomposeOutputMetadataSchema trims accepted title/coverage/evidence strings and rejects forge-invalid title length", () => {
  const parsed = DecomposeOutputMetadataSchema.parse({
    outcome: "decomposed",
    children: [
      {
        title: "  child  ",
        kind: "remainder",
        blockedBy: [],
        unresolvedContext: { reason: "  missing fact  " },
        informationNeeded: "  owner name  ",
      },
    ],
    coverage: { mappings: [{ parentIntent: "  intent  ", children: [0] }], remainders: [0] },
  });
  // Narrow the parse union — `assert.equal` on `outcome` reads at runtime but doesn't narrow.
  if (parsed.outcome !== "decomposed") throw new Error(`expected a decomposed parse, got ${parsed.outcome}`);
  assert.equal(parsed.children[0]!.title, "child");
  assert.equal(parsed.children[0]!.unresolvedContext!.reason, "missing fact");
  assert.equal(parsed.children[0]!.informationNeeded, "owner name");
  assert.equal(parsed.coverage.mappings[0]!.parentIntent, "intent");
  assert.equal(
    DecomposeOutputMetadataSchema.safeParse({
      outcome: "decomposed",
      children: [{ title: "x".repeat(257), kind: "ready", blockedBy: [] }],
      coverage: { mappings: [{ parentIntent: "intent", children: [0] }], remainders: [] },
    }).success,
    false,
  );
});

test("UnresolvedContextSchema: strict — an extra field (e.g. a smuggled decision) fails", () => {
  assert.equal(UnresolvedContextSchema.safeParse({ unresolvedContext: { reason: "x" }, decision: "approve" }).success, false);
});

test("isUnresolvedContext: true for a valid shape, false (never throws) for anything else", () => {
  assert.equal(isUnresolvedContext({ unresolvedContext: { reason: "x" } }), true);
  assert.equal(isUnresolvedContext({ decision: "approve" }), false);
  assert.equal(isUnresolvedContext(null), false);
  assert.equal(isUnresolvedContext(undefined), false);
  assert.equal(isUnresolvedContext("not even an object"), false);
});

test("isUnresolvedContext: round-trips through the real parseStructuredBlock + JSON.parse path a role session would produce", () => {
  const text = `${RESULT_BLOCK_START}\n${JSON.stringify({ unresolvedContext: { reason: "the needed fact was never retrievable within budget" } })}\n${RESULT_BLOCK_END}\n`;
  const block = parseStructuredBlock(text);
  assert.ok(block);
  const metadata = JSON.parse(block!.metadataRaw);
  assert.equal(isUnresolvedContext(metadata), true);
});

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

// ── sentinel containment (dual-review round 1, P1): silent truncation is impossible ─────────

test("containment P1: a body whose CONTENT embeds <<<END_BODY>>> -> null, never a silently truncated slice", () => {
  // Realistic: issue #110's own body documents these sentinels. Without the trailing rule the
  // parse would stop at the embedded sentinel and return "docs say the format uses " — a
  // truncated body that could still schema-validate and be applied via updateIssueBody.
  const text =
    `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\ndocs say the format uses ${BODY_BLOCK_END} as its end marker\n${BODY_BLOCK_END}\n`;
  assert.equal(parseStructuredBlock(text), null);
});

test("containment P1: a body embedding <<<BODY>>> -> null (no-embedded-sentinels rule)", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nthe start marker is ${BODY_BLOCK_START} on its own line\n${BODY_BLOCK_END}\n`;
  assert.equal(parseStructuredBlock(text), null);
});

test("containment P1: a body embedding the RESULT sentinels -> null either way (END via the containment rule, START via last-wins relocation failing the parse)", () => {
  const endEmbedded =
    `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nmetadata ends at ${RESULT_BLOCK_END}, like so\n${BODY_BLOCK_END}\n`;
  assert.equal(parseStructuredBlock(endEmbedded), null);
  const startEmbedded =
    `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nmetadata starts at ${RESULT_BLOCK_START}, like so\n${BODY_BLOCK_END}\n`;
  assert.equal(parseStructuredBlock(startEmbedded), null);
});

test("containment P1: trailing prose after a metadata+BODY block -> null ('Nothing may follow the last sentinel')", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nthe body\n${BODY_BLOCK_END}\nLet me know if you need anything else!`;
  assert.equal(parseStructuredBlock(text), null);
});

test("containment P1: trailing prose after a metadata-ONLY block -> null (END_SAPWOOD_RESULT is the final sentinel then)", () => {
  const text = `${RESULT_BLOCK_START}\n{"decision":"approve","issue":1}\n${RESULT_BLOCK_END}\nHope that helps.`;
  assert.equal(parseStructuredBlock(text), null);
});

test("containment P1: trailing whitespace/newlines after the final sentinel still parse fine", () => {
  const metadataOnly = `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n\n  \n`;
  assert.ok(parseStructuredBlock(metadataOnly));
  const withBody = `${RESULT_BLOCK_START}\n{"issue":1}\n${RESULT_BLOCK_END}\n` + `${BODY_BLOCK_START}\nthe body\n${BODY_BLOCK_END}\n\n\t\n`;
  const block = parseStructuredBlock(withBody);
  assert.ok(block);
  assert.equal(block!.body, "the body");
});

test("containment P1: prose BETWEEN the metadata block and a later BODY block -> null (a quoted body example after a metadata-only decision is never silently adopted)", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"decision":"approve","issue":1}\n${RESULT_BLOCK_END}\n` +
    `For example, a bounce would have looked like:\n${BODY_BLOCK_START}\nquoted example brief\n${BODY_BLOCK_END}\n`;
  assert.equal(parseStructuredBlock(text), null);
});

test("parseStructuredBlock: metadataRaw is trimmed of surrounding whitespace/newlines", () => {
  const text = `${RESULT_BLOCK_START}\n\n  {"issue":1}  \n\n${RESULT_BLOCK_END}`;
  const block = parseStructuredBlock(text);
  assert.equal(block!.metadataRaw, `{"issue":1}`);
});
