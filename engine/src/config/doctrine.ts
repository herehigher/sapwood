// doctrine.ts (#167, repartitioned #1123 PR-2): the review doctrine every engine-composed
// surface receives — a framework-owned, release-controlled CORE (engine/prompts/doctrine-core.md,
// shipped the same way every other role prompt is: defaultDoctrineCorePath mirrors worker.ts's
// own defaultPromptPath shape) prepended to whatever repo-level residue `doctrine.file` holds.
// Data, not code — the same shipping/scaffold shape as #128's north-star goal file
// (engine/prompts/doctrine-template.md, config.ts's `doctrine.file`, init.ts's
// ensureDoctrineFile), but the LOAD side is its own tiny module (not folded into architect.ts's
// loadGoalExcerpt) because it's injected into FOUR prompt surfaces — the worker brief, the fix
// leg, the architect pass, and the engine-agent reviewer — not one, and none of those modules
// should own the load logic the others also need.
//
// The core is ALWAYS present in the composed text — a release ships it, so there is no "absent
// doctrine" state left to represent; the old whole-composition absent-doctrine placeholder is
// retired. Only the REPO part can legally be missing (a repo that hasn't adopted a residue file
// yet, or has deliberately opted out): that degrades to `NO_REPO_DOCTRINE`, a public-safe
// sentence that is part of the composed text like any other content, never a sentinel a caller
// compares against. A repo file that IS PRESENT but unreadable (EACCES, a directory at the path,
// any other read error) is a different case — a misconfiguration, not "no doctrine adopted" —
// and still fails fast (worker.ts's loadWorkerPromptTemplate contract, #74). A MISSING core is a
// packaging bug and throws too, naming the path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capDigest } from "../retro/retro-digest.js";
import { stripHtmlComments } from "../util/markdown.js";

/** Resolve the shipped, framework-owned doctrine core — inside the engine package (NOT the
 *  orchestrated target repo), the same `join(here, "..", "..", "prompts", …)` shape as
 *  `roles/worker.ts`'s own `defaultPromptPath`, so packaged installs ship it (`engine/package.json`
 *  `files` already includes `prompts`). No override key: the core is release-controlled by
 *  design (D1's carrier partition) — a repo customizes doctrine only via `doctrine.file`. */
export function defaultDoctrineCorePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "doctrine-core.md");
}

/** Injected as the repo part whenever no repo-level doctrine file exists at the configured path —
 *  a public-safe sentence (never an internal sentinel) since it is composed into every surface,
 *  including ones a reviewer or human may eventually read verbatim. */
export const NO_REPO_DOCTRINE =
  "This repository has not adopted a repo-level review doctrine file; the framework doctrine " + "above applies.";

/** Load the composed review doctrine — `core + "\n\n" + repoPart` — for prompt injection into
 *  every one of the four engine-composed surfaces (worker brief, fix leg, architect pass,
 *  engine-agent reviewer). The core is read fresh from `defaultDoctrineCorePath()` every call
 *  (same "load once at the real call site, never cached across engine construction" convention
 *  `loadDoctrine` has always had) and its absence is a fail-fast packaging bug, naming the path —
 *  there is no legal "missing core" state, unlike the repo part below. `repoPart` is the repo
 *  file's cleaned content passed through `capDigest` when `path` exists (bounded/truncated
 *  deterministically, same marked-cut-never-silent-drop contract as round.directive / the
 *  architect's lastMerged text),
 *  else the explicit `NO_REPO_DOCTRINE` sentence — `maxChars` bounds the repo part ONLY; the core
 *  is release-controlled and fixed-size by construction (its own ceiling is a CI test, not
 *  config). A repo file that IS present but unreadable still throws, naming the path — a
 *  misconfiguration, not "no doctrine adopted." `corePath` defaults to the real shipped location
 *  and exists only as a test seam (a missing-core throw is otherwise unreachable without moving
 *  the real installed file, racing every other concurrently running suite that also calls
 *  `loadDoctrine`); every production caller omits it and gets the real path.
 *
 *  Closed HTML comments outside Markdown code are removed before capping so scaffold guidance
 *  neither consumes the doctrine budget nor reaches a raw prompt. */
export function loadDoctrine(path: string, maxChars: number, corePath: string = defaultDoctrineCorePath()): string {
  if (!existsSync(corePath)) {
    throw new Error(`doctrine core missing at ${corePath} — a packaging bug, refusing to proceed`);
  }
  const core = readFileSync(corePath, "utf8");
  let repoPart: string;
  if (!existsSync(path)) {
    repoPart = NO_REPO_DOCTRINE;
  } else {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`doctrine.file present but unreadable: ${path} (${String(e)}) — refusing to proceed`);
    }
    // #830 gate② P2: a comments-only file strips down to pure whitespace, not "" — capDigest
    // would then cap/pass through that whitespace instead of the true-empty repo part the
    // "empty repo file" test below (and #167's own empty-is-not-absent contract) expects.
    const cleaned = stripHtmlComments(text);
    repoPart = capDigest(cleaned.trim() === "" ? "" : cleaned, maxChars);
  }
  return `${core}\n\n${repoPart}`;
}
