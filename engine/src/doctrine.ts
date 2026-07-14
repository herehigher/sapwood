// doctrine.ts (#167): the repo-level review-doctrine file — technical invariants (disabled-
// consumer rule, same-tick window rule, crash-rerun set) and adjudication doctrine (how the
// loop treats review findings), authored as prose for LLM readers, deliberately never a lint/
// DSL — the review loop's own judgment rules, not a rules engine. Data, not code — the same
// shipping/scaffold shape as #128's north-star goal file (engine/prompts/doctrine-template.md,
// config.ts's `doctrine.file`, init.ts's ensureDoctrineFile), but the LOAD side is its own tiny
// module (not folded into architect.ts's loadArchitectureChapter) because it's injected into
// THREE prompt surfaces — the worker brief (worker.ts), the architect pass (architect.ts), and
// referenced by name in the gated-reentry-cap escalation comment (conductor.ts) — not one, and
// none of those three modules should own the load logic the other two also need.
//
// UNLIKE `worker.promptFile` (config.ts): a missing doctrine file is NOT an error. It's a legal,
// common state — a repo that hasn't adopted the doctrine convention yet, or has deliberately
// opted out — so absent degrades to an explicit 'none' placeholder, never a silent empty
// substitution and never a fail-fast throw (worker.promptFile's contract, deliberately NOT
// reused here per the #167 issue's acceptance criteria: "absent file -> explicit 'none'
// placeholder, behavior unchanged"). Present -> the file's content, bounded/truncated
// deterministically via retro-digest.ts's capDigest — same marked-cut-never-silent-drop
// contract as round.directive / the architect's lastMerged text.
import { existsSync, readFileSync } from "node:fs";
import { capDigest } from "./retro-digest.js";

/** Injected verbatim wherever the doctrine text is substituted when no doctrine file exists at
 *  the configured path (or a real caller hasn't threaded a loaded value at all — architect.ts's
 *  `deps.doctrine` reuses this SAME placeholder for that case, same "one placeholder covers both
 *  degrade paths" shape as architect.ts's own NO_PRIOR_ROUND_YET) — an explicit statement, never
 *  a silent empty string, so a rendered prompt is never ambiguous about whether doctrine was
 *  withheld or simply lost. */
export const NO_DOCTRINE =
  "(No review doctrine file is configured for this repo — proceeding with no repo-level " +
  "technical invariants or adjudication doctrine available.)";

/** Load the repo-level review-doctrine file for prompt injection. Missing file -> NO_DOCTRINE
 *  (never an error — see module doc: absent is a legal state, unlike worker.promptFile). An
 *  unreadable file (exists but a read error) also degrades to an explicit placeholder rather
 *  than throwing — doctrine is advisory context for an LLM reader, the same fail-toward-
 *  more-work stance architect.ts's loadArchitectureChapter takes for the goal file. Present ->
 *  raw content, bounded to `maxChars` with a deterministic, marked truncation (capDigest) —
 *  never a silent drop. */
export function loadDoctrine(path: string, maxChars: number): string {
  if (!existsSync(path)) return NO_DOCTRINE;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return `(Review doctrine file at ${path} could not be read: ${String(e)} — proceeding with no doctrine available.)`;
  }
  return capDigest(text, maxChars);
}
