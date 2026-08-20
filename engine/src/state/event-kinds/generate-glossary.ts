// generate-glossary.ts (#643): deterministic generator for `.claude-plugin/skills/
// sapwood-event-glossary/SKILL.md` — rendered from the event-kind registry (`event-kinds/*.ts`,
// #425), `PARK_SOURCE_GLOSSARY` (state.ts), and `ESCALATION_BUCKET_GLOSSARY`
// (loop/escalation-buckets.ts): the three places #643 made a `meaning`/`actionability` pair a
// REQUIRED, compile-checked field, rather than code-comment tribal knowledge no role session ever
// reads.
//
// DETERMINISTIC BY CONSTRUCTION — no `Date.now()`, no wall-clock, no environment-dependent
// formatting. Every ordering below is either the domain declaration order (`EVENT_KIND_DOMAINS`'s
// own insertion order, which is the source files' literal key order — JS objects with string keys
// preserve insertion order by spec) or a fixed literal list (`PARK_SOURCES`, the three escalation
// buckets) — never a fresh `Object.keys()` over something whose order is an implementation
// accident rather than a guarantee. `generate-glossary.test.ts`'s drift test calls
// `renderGlossarySkill` again and asserts the result byte-equals the COMMITTED SKILL.md — a
// registry change with no regeneration fails that test, and CI runs it on every PR.
//
// The generated file is COMMITTED (not built at install time): the plugin needs it present on
// disk with no build step, exactly like every other file under `.claude-plugin/`.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESCALATION_BUCKET_GLOSSARY, type EscalationBucket } from "../../loop/escalation-buckets.js";
import { PARK_SOURCE_GLOSSARY } from "../state.js";
import { EVENT_KIND_DOMAINS, EVENT_KINDS, type EventKind } from "./index.js";
import type { KindGlossary } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fixed order matching this module's own doc comment (bucket 1, bucket 2, then the non-escalation
 *  fence) — a hand-written list, not `Object.keys(ESCALATION_BUCKET_GLOSSARY)`, because a Record's
 *  key order is an implementation detail this file does not want to depend on for something a
 *  human reads top-to-bottom as a narrative. */
const ESCALATION_BUCKET_ORDER: readonly EscalationBucket[] = ["needs-human", "human-merge-only", "planless"];

/** One glossary row, rendered as a single markdown list item so the cross-check test can parse it
 *  back out unambiguously: the FIRST backtick-delimited span on the line is the kind/source/bucket
 *  name, exactly once, never a substring match (`resume-capped` vs. `resume-capped-label-failed`
 *  cannot collide because the test compares parsed tokens, not regex `.includes`). */
function renderRow(name: string, glossary: KindGlossary, tags?: readonly string[]): string {
  const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return `- \`${name}\` — **${glossary.actionability}**${tagSuffix}: ${glossary.meaning}`;
}

const DOMAIN_HEADINGS: Record<keyof typeof EVENT_KIND_DOMAINS, string> = {
  run: "Run / process lifecycle",
  lane: "Lane lifecycle",
  drive: "PR drive",
  review: "Review (gate②)",
  governance: "Governance (align, triage, proposals, plan review, architect, harvest, retro)",
  escalation: "Escalation reconciliation",
};

/** The whole skill body, built ONCE from the three glossary sources above plus the gotchas prose
 *  file this module sits beside (`glossary-gotchas.md`, appended verbatim — never duplicated into
 *  this generator's own source). Exported so `generate-glossary.test.ts` can call it directly for
 *  the drift check without shelling out to a build step. */
export function renderGlossarySkill(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("name: sapwood-event-glossary");
  lines.push("description: |");
  lines.push(
    "  Generated reference for loop supervisors: what every sapwood engine event kind, park source, and escalation bucket MEANS and how actionable it is (routine / expected-noise / investigate / intervene). Regenerated from engine/src/state/event-kinds/*.ts, state.ts's PARK_SOURCE_GLOSSARY, and loop/escalation-buckets.ts's ESCALATION_BUCKET_GLOSSARY — never hand-edited. Also visible to engine-role sessions since plugin-root skills load ambiently for every session (PLAN.md's ambient posture); it carries interpretation only, nothing role-actionable.",
  );
  lines.push("---");
  lines.push("");
  lines.push("# sapwood event glossary");
  lines.push("");
  lines.push(
    "GENERATED FILE — do not hand-edit. Regenerate with `npx tsx engine/src/state/event-kinds/generate-glossary.ts` " +
      "after any registry/glossary change; `generate-glossary.test.ts`'s drift test fails CI if this file and a fresh " +
      "regeneration disagree.",
  );
  lines.push("");
  lines.push(
    "This is interpretation, not instruction: it tells a loop supervisor (or any session that reads it) what an " +
      "event/source/bucket MEANS and how urgently a human should look at it. It is not a source of GitHub label " +
      "names, protected-path lists, or other machine-enforced facts — those live in code and docs/configuration.md; " +
      "this glossary only points at them.",
  );
  lines.push("");
  lines.push("## Actionability");
  lines.push("");
  lines.push("- `routine` — expected steady-state traffic; no read is required.");
  lines.push("- `expected-noise` — looks alarming in isolation but is a known, self-healing retry/degrade path.");
  lines.push("- `investigate` — not itself a call for action, but worth reading the surrounding events for.");
  lines.push("- `intervene` — a human owes the next decision or action.");
  lines.push("");
  lines.push("## Event kinds");
  lines.push("");
  for (const domain of Object.keys(EVENT_KIND_DOMAINS) as (keyof typeof EVENT_KIND_DOMAINS)[]) {
    lines.push(`### ${DOMAIN_HEADINGS[domain]}`);
    lines.push("");
    for (const kind of Object.keys(EVENT_KIND_DOMAINS[domain]) as EventKind[]) {
      const entry = EVENT_KINDS[kind];
      lines.push(renderRow(kind, entry, entry.tags));
    }
    lines.push("");
  }
  lines.push("## Park sources");
  lines.push("");
  lines.push(
    "A park episode suspends dispatch for the named source (`sapwood park clear --source <name>` lifts a probe-less " +
      "one; a probed source — llm/forge — also auto-resumes).",
  );
  lines.push("");
  for (const source of Object.keys(PARK_SOURCE_GLOSSARY)) {
    lines.push(renderRow(source, PARK_SOURCE_GLOSSARY[source as keyof typeof PARK_SOURCE_GLOSSARY]));
  }
  lines.push("");
  lines.push("## Escalation buckets");
  lines.push("");
  lines.push("The three action-buckets every escalation label write is classified into.");
  lines.push("");
  for (const bucket of ESCALATION_BUCKET_ORDER) {
    lines.push(renderRow(bucket, ESCALATION_BUCKET_GLOSSARY[bucket]));
  }
  lines.push("");
  lines.push("## GitHub signal gotchas");
  lines.push("");
  lines.push(readFileSync(join(HERE, "glossary-gotchas.md"), "utf8").trimEnd());
  lines.push("");
  return lines.join("\n");
}

// Run only when invoked directly (not when imported by generate-glossary.test.ts or
// event-kinds.test.ts's drift check). Compare REALPATHS — same shape as guard-hook.ts/cli.ts's
// own `invokedDirectly`, so a symlinked/packaged entry point is still recognized.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const outPath = join(HERE, "..", "..", "..", "..", ".claude-plugin", "skills", "sapwood-event-glossary", "SKILL.md");
  writeFileSync(outPath, renderGlossarySkill());
  console.log(`[sapwood:generate-glossary] wrote ${pathToFileURL(outPath).pathname}`);
}
