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
// UNLIKE `worker.promptFile` (config.ts): a MISSING doctrine file is NOT an error. It's a legal,
// common state — a repo that hasn't adopted the doctrine convention yet, or has deliberately
// opted out — so absent degrades to an explicit 'none' placeholder, never a silent empty
// substitution and never a fail-fast throw (per the #167 issue's acceptance criteria: "absent
// file -> explicit 'none' placeholder, behavior unchanged"). A file that IS PRESENT but
// unreadable (EACCES, a directory at the path, any other read error) is a different case —
// review found (Codex P2) that the original implementation lumped it in with "absent" and
// degraded it to the same kind of placeholder, which silently masks a real misconfiguration as
// "no doctrine adopted." That branch now DOES reuse worker.promptFile's fail-fast contract
// (#74) — throws naming the path — split from the legal-absent branch above. Present-and-
// readable -> the file's content, bounded/truncated deterministically via retro-digest.ts's
// capDigest — same marked-cut-never-silent-drop contract as round.directive / the architect's
// lastMerged text.
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
 *  (never an error — see module doc: absent is a legal state, unlike worker.promptFile). A
 *  file that IS present but unreadable (EACCES, a directory at the path, any other read
 *  error) is a DIFFERENT case from absent — the operator configured/left a doctrine file at
 *  this path and it can't be honored, which is a misconfiguration, not "no doctrine
 *  adopted." #167 review (Codex P2): this now THROWS, naming the path, matching
 *  worker.ts's loadWorkerPromptTemplate fail-fast contract (#74) for the same
 *  present-but-broken shape — fail-closed on a real problem rather than silently degrading a
 *  misconfiguration into content that reads as "this repo has no doctrine." Present and
 *  readable -> raw content, bounded to `maxChars` with a deterministic, marked truncation
 *  (capDigest) — never a silent drop. */
export function loadDoctrine(path: string, maxChars: number): string {
  if (!existsSync(path)) return NO_DOCTRINE;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`doctrine.file present but unreadable: ${path} (${String(e)}) — refusing to proceed`);
  }
  return capDigest(text, maxChars);
}
