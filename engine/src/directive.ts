// directive.ts (#126): round directive file — human steering injected at round open. A plain
// data file (default data/DIRECTIVE.md) an operator drops beside the engine's own data dir to
// hand a round WHY/WHAT direction (locked decision 5's boundary: humans decide why/what, agents
// own execution) — read once per round, injected into both the aligning (po.md) and architecting
// (architect.md) prompts as `{{round.directive}}`, then archived so it can never silently
// re-apply to a LATER round. Zero new permissions: a local file read + rename, entirely inside
// the data dir this engine already owns (dirname(cfg.round.directiveFile)); no forge write, no
// new role capability. Not tied to pause/resume — a directive dropped mid-run is picked up the
// next time a round opens, exactly like any other round-open read.
//
// CONSUME-ONCE IS EVENT-SOURCED (crash-rerun designed up front, per this repo's recurring review
// theme — #123's id-cursor pattern, reused here): the `directive-applied` event this module
// appends is the SOURCE OF TRUTH for "this round already saw a directive and what it said," not
// the file's presence/absence on disk. At round open, resolveRoundDirective FIRST checks the
// event log (state.eventsAfterId(round.start_event_id ?? 0, ["directive-applied"]), filtered to
// THIS round — the same round-window read align.ts's align-summary / round-artifact.ts's window
// reads use) for a prior application THIS round. Found -> return its recorded content verbatim,
// never re-reading or re-archiving the file (idempotent resume: a crash between the event append
// and the archive rename must not re-apply a second, possibly-edited copy of the file, and must
// not throw on a missing/already-archived source). Not found -> if the file exists, read it,
// append the event (event append BEFORE the archive rename, so a crash between the two leaves
// the event durable and the rename is simply retried — see below), then best-effort archive the
// source by renaming it out of the live path. Neither present -> an explicit 'none' placeholder,
// never a silent empty substitution.
//
// THE RENAME IS IDEMPOTENT, NOT THE READ: every call that finds (or just wrote) the event still
// attempts the archive rename — skipped silently if the source file is already gone (the normal
// case: a prior call in this same round already moved it). This is deliberate, not redundant: a
// crash landing exactly between the event append and the rename leaves the source file BEHIND on
// disk with a durable event already recorded for this round; if the rename were only attempted on
// the branch that just wrote the event, that crash would leave the file sitting at its live path
// forever, and the FIRST NEXT round to check "does the file exist" (this round's own resumed
// aligning call, or — if the PO role is disabled and this round never reaches aligning's own
// consumption — a later round's architect call) would read it as a brand-new, unconsumed
// directive and silently re-apply stale content. Re-attempting the (harmless, skip-if-missing)
// rename on every call that already has an event closes that gap.
//
// Both align.ts and architect.ts call this same function (round.ts SEQUENCE runs aligning before
// architecting, so the common case is: aligning does the real read+event+archive, architect's
// own call is a cheap event-log read of what aligning already recorded). Deliberately NOT
// threaded through round-defaults.ts (unlike #123's alignedGoals handoff) — each phase already
// reads its own `deps.state`/`deps.cfg` directly, and the function's own idempotence makes a
// second, independent call from architect.ts harmless, including in the roles.po.enabled: false
// case (#127) where aligning never runs at all and architect becomes the round's de facto first
// consumer.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import { capDigest } from "./retro-digest.js";

/** Injected verbatim as `{{round.directive}}` when no directive file exists and this round has
 *  no prior `directive-applied` event either — an explicit statement, never a silent empty
 *  string, so a rendered prompt is never ambiguous about whether steering was withheld or lost. */
export const NO_ROUND_DIRECTIVE = "No round directive was provided for this round.";

export interface DirectiveAppliedPayload {
  round_id: number;
  path: string;
  content: string;
  sha256: string;
}

function isDirectiveAppliedPayload(p: unknown): p is DirectiveAppliedPayload {
  return (
    typeof p === "object" && p !== null &&
    typeof (p as Record<string, unknown>).round_id === "number" &&
    typeof (p as Record<string, unknown>).content === "string" &&
    typeof (p as Record<string, unknown>).path === "string" &&
    typeof (p as Record<string, unknown>).sha256 === "string"
  );
}

/** Where a consumed directive is archived to, once and for all, for `roundId` — a sibling
 *  `directives/` dir next to the configured directive file itself (the same
 *  `<data-dir>/<kind>/<name>` convention state.ts's roundArtifactMdPath uses for
 *  `data/rounds/round-N.md`), so the default `data/DIRECTIVE.md` archives to
 *  `data/directives/round-N.md`. Exported for tests. */
export function directiveArchivePath(directiveFile: string, roundId: number): string {
  return join(dirname(directiveFile), "directives", `round-${roundId}.md`);
}

/** Resolve THIS round's directive text for prompt injection — see module doc for the full
 *  event-sourced consume-once contract. Never throws on a missing/absent file (the ordinary,
 *  most-common case, degrades to NO_ROUND_DIRECTIVE) and never throws on an archive-rename
 *  failure (logged, not fatal — the event already recorded is what makes consume-once safe, the
 *  rename is best-effort housekeeping). A state write failure while recording a REAL directive's
 *  FIRST application does throw: the event is the source of truth for it, so silently proceeding
 *  without recording one would let the same file re-apply, unrecorded, on a later round. */
export function resolveRoundDirective(state: State, cfg: SapwoodConfig, roundId: number): string {
  const round = state.getRound(roundId);
  const startEventId = round?.start_event_id ?? 0;
  const priorApplications = state
    .eventsAfterId(startEventId, ["directive-applied"])
    .map((e) => e.payload)
    .filter(isDirectiveAppliedPayload)
    .filter((p) => p.round_id === roundId);

  const directivePath = cfg.round.directiveFile;
  let payload: DirectiveAppliedPayload;
  if (priorApplications.length > 0) {
    payload = priorApplications[0]!;
  } else {
    if (!existsSync(directivePath)) return NO_ROUND_DIRECTIVE;
    const raw = readFileSync(directivePath, "utf8");
    const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    const content = capDigest(raw, cfg.round.directiveMaxChars);
    payload = { round_id: roundId, path: directivePath, content, sha256 };
    // The event is the SOURCE OF TRUTH (module doc) — appended BEFORE the archive rename below,
    // so a crash between the two still leaves this round's application durably recorded; a
    // resumed call finds it above and never re-reads the (possibly since-edited) file again.
    state.appendEvent("directive-applied", payload);
  }

  // Best-effort, idempotent archive — see module doc's "THE RENAME IS IDEMPOTENT" section for
  // why this runs on EVERY call that reaches here (not just the branch that just wrote the
  // event above). Never throws: a filesystem hiccup here must not lose the already-durable
  // event, or crash a round over a housekeeping rename.
  try {
    if (existsSync(directivePath)) {
      const archivePath = directiveArchivePath(directivePath, roundId);
      mkdirSync(dirname(archivePath), { recursive: true });
      renameSync(directivePath, archivePath);
    }
  } catch (e) {
    console.error(
      `[sapwood:directive] round ${roundId}: failed to archive ${directivePath} — ${String(e)} ` +
        `— the directive-applied event is still the durable source of truth, but the source ` +
        `file was left in place and MUST be moved/removed by a human before the next round, or ` +
        `it will be misread as a new, unconsumed directive`,
    );
  }

  return payload.content;
}
