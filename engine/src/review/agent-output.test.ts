// agent-output.test.ts (#286, E4a, design #279 §2/§6) — the engine-agent structured-output
// strict schema (validateAgentReviewOutput/parseAgentReviewOutputText) and the pure engine-side
// derivation (deriveApprovalResult). Corpus-style: valid/invalid shapes, AC-id set matching,
// findings reuse, and the derivation's rejected/approved/claim-accepted paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "./ac-snapshot.js";
import {
  deriveApprovalResult,
  isStrictFenceDelimiter,
  isWiderFenceDelimiter,
  parseAgentReviewOutputText,
  validateAgentReviewOutput,
} from "./agent-output.js";

const MANIFEST: AcceptanceCriterion[] = [
  { id: "1-aaaaaaaa", text: "first criterion" },
  { id: "2-bbbbbbbb", text: "second criterion" },
];

function wrap(metadata: unknown): string {
  return `preamble text the model wrote first\n\n<<<SAPWOOD_RESULT>>>\n${JSON.stringify(metadata)}\n<<<END_SAPWOOD_RESULT>>>`;
}

// ── validateAgentReviewOutput: valid shapes ─────────────────────────────────────────────────

test("validateAgentReviewOutput: all confirmed, zero findings — valid", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [],
    },
    MANIFEST,
  );
  assert.ok(out);
  assert.equal(out.perAC.length, 2);
  assert.deepEqual(out.findings, []);
});

test("validateAgentReviewOutput: a mix of confirmed/cannot-confirm/claim-accepted with findings — valid", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "cannot-confirm" },
        { id: "2-bbbbbbbb", status: "claim-accepted" },
      ],
      findings: [{ id: "f1", body: "the first criterion is not actually satisfied" }],
    },
    MANIFEST,
  );
  assert.ok(out);
  assert.equal(out.findings.length, 1);
});

test("validateAgentReviewOutput: empty manifest + empty perAC — valid (a verify:n/a-shaped snapshot)", () => {
  const out = validateAgentReviewOutput({ perAC: [], findings: [] }, []);
  assert.ok(out);
  assert.deepEqual(out.perAC, []);
});

// ── validateAgentReviewOutput: invalid shapes — every one returns null ──────────────────────

test("validateAgentReviewOutput: unknown AC id -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
        { id: "9-zzzzzzzz", status: "confirmed" },
      ],
      findings: [],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: missing AC id -> null", () => {
  const out = validateAgentReviewOutput({ perAC: [{ id: "1-aaaaaaaa", status: "confirmed" }], findings: [] }, MANIFEST);
  assert.equal(out, null);
});

test("validateAgentReviewOutput: duplicate AC id -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "1-aaaaaaaa", status: "confirmed" },
      ],
      findings: [],
    },
    [MANIFEST[0]!],
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: extra top-level key (e.g. overall) -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [],
      overall: "approved",
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: extra top-level key (headOid) -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [],
      headOid: "deadbeef",
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: missing top-level key (no findings array) -> null", () => {
  const out = validateAgentReviewOutput({ perAC: [] }, []);
  assert.equal(out, null);
});

test("validateAgentReviewOutput: a perAC entry with an extra key -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed", note: "extra" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: an unrecognized status value -> null", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "approved" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput: a malformed finding (missing body) invalidates the WHOLE output", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [{ id: "f1" }],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput (#302 review Codex P2): an EXTRA key on one finding invalidates the WHOLE output (exact {id, body} keys)", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [{ id: "f1", body: "a real finding", severity: "P1" }],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput (#302 review Codex P2): DUPLICATE finding ids invalidate the WHOLE output (finding id is E4c's audit/dedup key)", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [
        { id: "f1", body: "first finding" },
        { id: "f1", body: "second finding reusing the id" },
      ],
    },
    MANIFEST,
  );
  assert.equal(out, null);
});

test("validateAgentReviewOutput (#302 review Codex P2): DISTINCT finding ids with exact keys stay valid (the strictness additions reject only the new violations)", () => {
  const out = validateAgentReviewOutput(
    {
      perAC: [
        { id: "1-aaaaaaaa", status: "confirmed" },
        { id: "2-bbbbbbbb", status: "confirmed" },
      ],
      findings: [
        { id: "f1", body: "first finding" },
        { id: "f2", body: "second finding" },
      ],
    },
    MANIFEST,
  );
  assert.notEqual(out, null);
  assert.equal(out!.findings.length, 2);
});

test("validateAgentReviewOutput: non-object / array / null raw -> null", () => {
  assert.equal(validateAgentReviewOutput(null, MANIFEST), null);
  assert.equal(validateAgentReviewOutput("a string", MANIFEST), null);
  assert.equal(validateAgentReviewOutput([], MANIFEST), null);
  assert.equal(validateAgentReviewOutput(42, MANIFEST), null);
});

// ── parseAgentReviewOutputText: sentinel-block extraction + JSON parse ───────────────────────

test("parseAgentReviewOutputText: a valid sentinel-wrapped block parses", () => {
  const text = wrap({
    perAC: [
      { id: "1-aaaaaaaa", status: "confirmed" },
      { id: "2-bbbbbbbb", status: "confirmed" },
    ],
    findings: [],
  });
  const out = parseAgentReviewOutputText(text, MANIFEST);
  assert.ok(out);
  assert.equal(out.perAC.length, 2);
});

test("parseAgentReviewOutputText (#319): observed haiku prose + symmetrically fenced sentinel block parses through the engine-agent schema", () => {
  const text = `I reviewed the acceptance criteria against the supplied diff and found no blocking issues.

\`\`\`
<<<SAPWOOD_RESULT>>>
{
  "perAC": [
    { "id": "1-aaaaaaaa", "status": "confirmed" },
    { "id": "2-bbbbbbbb", "status": "confirmed" }
  ],
  "findings": []
}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.deepEqual(parseAgentReviewOutputText(text, MANIFEST), {
    perAC: [
      { id: "1-aaaaaaaa", status: "confirmed" },
      { id: "2-bbbbbbbb", status: "confirmed" },
    ],
    findings: [],
  });
});

test("parseAgentReviewOutputText (#319): a json-tagged opening fence and bare closing fence parse", () => {
  const text = `prose before the block
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.ok(parseAgentReviewOutputText(text, MANIFEST));
});

test("parseAgentReviewOutputText (#319 round 2 containment): a prior fence opener makes the candidate fence a closer, so the ambiguous text stays rejected", () => {
  const text = `\`\`\`text
preamble code
\`\`\`
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 round 3): an unclosed four-backtick preamble fence makes the wrapped block ambiguous", () => {
  const text = `\`\`\`\`text
unclosed preamble code
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 round 3): a tilde-fenced preamble makes the wrapped block ambiguous", () => {
  const text = `~~~text
preamble code
~~~
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 round 4): a CRLF four-backtick preamble cannot bypass the wider fence scan", () => {
  const text = `\`\`\`\`text
unclosed preamble code
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``.replaceAll("\n", "\r\n");
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 round 4): CRLF tilde fences cannot bypass the wider fence scan", () => {
  const text = `~~~text
preamble code
~~~
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``.replaceAll("\n", "\r\n");
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 round 4): the observed benign wrapper parses with all-CRLF endings", () => {
  const text = `I reviewed the acceptance criteria against the supplied diff and found no blocking issues.

\`\`\`
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``.replaceAll("\n", "\r\n");
  assert.deepEqual(parseAgentReviewOutputText(text, MANIFEST), {
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  });
});

test("parseAgentReviewOutputText (#319 round 5): CRCRLF four-backtick and tilde preambles cannot bypass the wider fence scan", () => {
  const preambles = ["````text\nunclosed preamble code", "~~~text\nunclosed preamble code\n~~~"];
  for (const preamble of preambles) {
    const text = `${preamble}
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``.replaceAll("\n", "\r\r\n");
    assert.equal(parseAgentReviewOutputText(text, MANIFEST), null, `expected ${JSON.stringify(preamble)} to remain ambiguous`);
  }
});

test("parseAgentReviewOutputText (#319 round 6): mixed trailing-whitespace preambles cannot bypass the wider fence scan", () => {
  const preambles = ["````text\r ", "~~~text\r ", "````text\r\t"];
  for (const preamble of preambles) {
    const text = `${preamble}
unclosed preamble code
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
    assert.equal(parseAgentReviewOutputText(text, MANIFEST), null, `expected ${JSON.stringify(preamble)} to remain ambiguous`);
  }
});

test("fence classifiers (#319 round 6): strict acceptance implies wider acceptance after trailing-whitespace canonicalization", () => {
  const fenceStems = ["```", "```lang", "````", "````lang", "~~~", "~~~lang"];
  const suffixes = ["", "\r", "\r\r", " ", "\t", "  ", "\t\t", "\r ", "\r\t", " \r", "\r\r ", "\t\r", " \t\r\r"];

  for (const stem of fenceStems) {
    for (const suffix of suffixes) {
      const candidate = `${stem}${suffix}`;
      const canon = candidate.replace(/\s+$/u, "");
      if (isStrictFenceDelimiter(canon)) {
        assert.equal(isWiderFenceDelimiter(canon), true, `strict delimiter escaped wider scan: ${JSON.stringify(candidate)}`);
      }
    }
  }
});

test("parseAgentReviewOutputText (#319 round 5): the observed benign wrapper parses with all-CRCRLF endings", () => {
  const text = `I reviewed the acceptance criteria against the supplied diff and found no blocking issues.

\`\`\`
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``.replaceAll("\n", "\r\r\n");
  assert.deepEqual(parseAgentReviewOutputText(text, MANIFEST), {
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  });
});

test("parseAgentReviewOutputText (#319 round 6): the observed benign wrapper parses with trailing-space fence endings", () => {
  const trailingSpace = " ";
  const text = `I reviewed the acceptance criteria against the supplied diff and found no blocking issues.

\`\`\`json${trailingSpace}
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\`${trailingSpace}`;
  assert.deepEqual(parseAgentReviewOutputText(text, MANIFEST), {
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  });
});

test("parseAgentReviewOutputText (#319 round 2): a complete fenced preamble before a correctly fenced sentinel block still parses", () => {
  const text = `\`\`\`text
preamble code
\`\`\`
prose between the complete preamble and result
\`\`\`json
<<<SAPWOOD_RESULT>>>
${JSON.stringify({
  perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
  findings: [],
})}
<<<END_SAPWOOD_RESULT>>>
\`\`\``;
  assert.ok(parseAgentReviewOutputText(text, MANIFEST));
});

test("parseAgentReviewOutputText (#319 containment): a lone trailing fence without an opening fence still fails", () => {
  const text = `${wrap({
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  })}
\`\`\``;
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319 containment): trailing prose after the end sentinel still fails", () => {
  const text = `${wrap({
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  })}
trailing prose`;
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText (#319): unfenced correct output retains existing behavior", () => {
  const text = wrap({
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
  });
  assert.ok(parseAgentReviewOutputText(text, MANIFEST));
});

test("parseAgentReviewOutputText: no sentinel block at all -> null", () => {
  assert.equal(parseAgentReviewOutputText("just some prose, no block", MANIFEST), null);
});

test("parseAgentReviewOutputText: truncated block (no end sentinel) -> null", () => {
  assert.equal(parseAgentReviewOutputText('<<<SAPWOOD_RESULT>>>\n{"perAC":[],"findings":[]}', []), null);
});

test("parseAgentReviewOutputText: malformed JSON inside the block -> null", () => {
  const text = "<<<SAPWOOD_RESULT>>>\n{not valid json\n<<<END_SAPWOOD_RESULT>>>";
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

test("parseAgentReviewOutputText: valid JSON block that fails the AC-id contract -> null", () => {
  const text = wrap({ perAC: [{ id: "1-aaaaaaaa", status: "confirmed" }], findings: [] }); // missing 2-bbbbbbbb
  assert.equal(parseAgentReviewOutputText(text, MANIFEST), null);
});

// ── deriveApprovalResult: engine-side derivation ─────────────────────────────────────────────

test("deriveApprovalResult: all confirmed, zero findings -> approved with zero-count evidence", () => {
  const result = deriveApprovalResult(
    {
      perAC: [
        { id: "1", status: "confirmed" },
        { id: "2", status: "confirmed" },
      ],
      findings: [],
    },
    "HEAD1",
  );
  assert.deepEqual(result, {
    kind: "approved",
    headOid: "HEAD1",
    evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 },
  });
});

test("deriveApprovalResult: any finding present -> rejected, findings passed through verbatim", () => {
  const finding = { id: "f1", body: "something is wrong" };
  const result = deriveApprovalResult({ perAC: [{ id: "1", status: "confirmed" }], findings: [finding] }, "HEAD2");
  assert.deepEqual(result, { kind: "rejected", headOid: "HEAD2", findings: [finding] });
});

test("deriveApprovalResult: cannot-confirm with EMPTY findings synthesizes a finding per cannot-confirm entry -> rejected", () => {
  const result = deriveApprovalResult(
    {
      perAC: [
        { id: "1", status: "cannot-confirm" },
        { id: "2", status: "confirmed" },
      ],
      findings: [],
    },
    "HEAD3",
  );
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") throw new Error("unreachable");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.id, "ac-1");
  assert.match(result.findings[0]!.body, /1/);
});

test("deriveApprovalResult: cannot-confirm PLUS real findings -> rejected using the session's own findings, no extra synthesis", () => {
  const finding = { id: "f1", body: "explicit finding" };
  const result = deriveApprovalResult({ perAC: [{ id: "1", status: "cannot-confirm" }], findings: [finding] }, "HEAD4");
  assert.deepEqual(result, { kind: "rejected", headOid: "HEAD4", findings: [finding] });
});

test("deriveApprovalResult: claim-accepted entries -> approved, ids recorded as unreproducedClaims", () => {
  const result = deriveApprovalResult(
    {
      perAC: [
        { id: "1", status: "confirmed" },
        { id: "2", status: "claim-accepted" },
      ],
      findings: [],
    },
    "HEAD5",
  );
  assert.deepEqual(result, {
    kind: "approved",
    headOid: "HEAD5",
    evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0, unreproducedClaims: ["2"] },
  });
});

test("deriveApprovalResult: multiple claim-accepted entries are all recorded, in perAC order", () => {
  const result = deriveApprovalResult(
    {
      perAC: [
        { id: "a", status: "claim-accepted" },
        { id: "b", status: "confirmed" },
        { id: "c", status: "claim-accepted" },
      ],
      findings: [],
    },
    "HEAD6",
  );
  assert.equal(result.kind, "approved");
  if (result.kind !== "approved") throw new Error("unreachable");
  assert.deepEqual(result.evidence.unreproducedClaims, ["a", "c"]);
});

test("deriveApprovalResult: zero perAC entries + zero findings -> approved (empty-manifest edge case)", () => {
  const result = deriveApprovalResult({ perAC: [], findings: [] }, "HEAD7");
  assert.deepEqual(result, { kind: "approved", headOid: "HEAD7", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } });
});

test("deriveApprovalResult: an output smuggling an 'overall'-like intent via a rejected-shaped payload still derives rejected from the validated findings, never from a trusted overall field (strict schema already stripped any such field upstream)", () => {
  // Layer 1 (schema): validateAgentReviewOutput has ALREADY rejected any raw payload carrying an
  // "overall" key before this function ever runs (see the validateAgentReviewOutput tests above)
  // — deriveApprovalResult's own INPUT TYPE (AgentReviewOutput) has no such field to read even if
  // it wanted to. Layer 2 (derivation): confirm here that findings presence, not any label, is
  // what decides the outcome — a validated output with findings present derives rejected
  // regardless of how "confident" the perAC statuses otherwise look.
  const result = deriveApprovalResult(
    {
      perAC: [
        { id: "1", status: "confirmed" },
        { id: "2", status: "confirmed" },
      ],
      findings: [{ id: "f1", body: "found something anyway" }],
    },
    "HEAD8",
  );
  assert.equal(result.kind, "rejected");
});
