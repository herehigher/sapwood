// generate-glossary.test.ts (#643): the cross-check and drift tests for the generated
// sapwood-event-glossary skill.
//
//   CROSS-CHECK — every EventKind, ParkSource, and EscalationBucket appears in the rendered
//   markdown exactly once. Parsed the same way `generate-glossary.ts`'s own doc comment describes
//   `renderRow` producing it: the first backtick-delimited span on a `- \`...\`` list item is the
//   name, so a substring match (`resume-capped` inside `resume-capped-label-failed`) can never
//   produce a false positive — the parse below extracts exact tokens, never regex `.includes`.
//
//   DRIFT — the COMMITTED `.claude-plugin/skills/sapwood-event-glossary/SKILL.md` byte-equals a
//   fresh call to `renderGlossarySkill()`. The generated file is committed (the plugin needs it
//   on disk with no build step), so nothing else would catch a registry/glossary edit that never
//   got regenerated — this test is that catch, and it runs on every PR (`npm test`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCALATION_BUCKET_GLOSSARY } from "../../loop/escalation-buckets.js";
import { PARK_SOURCE_GLOSSARY } from "../state.js";
import { renderGlossarySkill } from "./generate-glossary.js";
import { EVENT_KINDS } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, "..", "..", "..", "..", ".claude-plugin", "skills", "sapwood-event-glossary", "SKILL.md");

// The "## Actionability" legend renders its four values as `- \`word\` — ...` list items too —
// the SAME shape every glossary row uses. Allowlisted here rather than special-cased in the
// generator; the last assertion below proves the allowlist can never silently swallow a real row
// (no EventKind/ParkSource/EscalationBucket is ever spelled exactly like an actionability value).
const ACTIONABILITY_LEGEND_WORDS = ["routine", "expected-noise", "investigate", "intervene"];

/** Every backtick-delimited name at the start of a `- \`name\` ...` list item in `markdown`. */
function listItemNames(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^- `([^`]+)`/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

test("#643 AC: every EventKind, ParkSource, and EscalationBucket appears in the generated glossary exactly once", () => {
  const rendered = renderGlossarySkill();
  const names = listItemNames(rendered).filter((n) => !ACTIONABILITY_LEGEND_WORDS.includes(n));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);

  const expected = [...Object.keys(EVENT_KINDS), ...Object.keys(PARK_SOURCE_GLOSSARY), ...Object.keys(ESCALATION_BUCKET_GLOSSARY)];
  for (const name of expected) {
    assert.equal(counts.get(name), 1, `"${name}" must appear in the generated glossary exactly once (found ${counts.get(name) ?? 0})`);
  }
  // Reverse direction: nothing else in the rendered output claims to be a glossary row — a
  // stray/renamed row would otherwise pass the forward check silently.
  assert.deepEqual([...counts.keys()].sort(), [...new Set(expected)].sort());
  for (const word of ACTIONABILITY_LEGEND_WORDS) {
    assert.ok(!expected.includes(word), `"${word}" collides with the actionability legend — the allowlist above would hide it`);
  }
});

test("#643 AC: the committed SKILL.md byte-equals a fresh regeneration — a registry/glossary edit with no regeneration fails CI", () => {
  const committed = readFileSync(SKILL_PATH, "utf8");
  assert.equal(
    committed,
    renderGlossarySkill(),
    "committed SKILL.md is stale — regenerate with `npx tsx engine/src/state/event-kinds/generate-glossary.ts`",
  );
});
