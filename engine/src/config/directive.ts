// directive.ts (#126): round directive file — human steering injected at round open. A plain
// data file (.sapwood/DIRECTIVE.md, runtimePaths(defaultRuntimeRoot()).directiveMd — #1078: no
// config key at all, cwd-relative like every other runtime path, never config-file-relative) an
// operator drops beside the engine's own runtime root to hand a round WHY/WHAT direction (locked
// decision 5's boundary: humans decide why/what, agents own execution) — read once per round,
// injected into both the aligning (po.md) and architecting (architect.md) prompts as
// `{{round.directive}}`, then archived so it can never silently re-apply to a LATER round. Zero
// new permissions: a local file read + rename, entirely inside the runtime root this engine
// already owns; no forge write, no new role capability. Not tied to pause/resume — a directive
// dropped mid-run is picked up the next time a round opens, exactly like any other round-open
// read.
//
// CONSUME-ONCE IS EVENT-SOURCED (crash-rerun designed up front, per this repo's recurring review
// theme — #123's id-cursor pattern, reused here): the `directive-applied` event this module
// appends is the SOURCE OF TRUTH for "this round already saw a directive and what it said," not
// the file's presence/absence on disk. resolveRoundDirective FIRST checks the event log
// (state.eventsAfterId(round.start_event_id ?? 0, ["directive-applied"]), filtered to THIS round
// — the same round-window read align.ts's align-summary / round-artifact.ts's window reads use)
// for a prior application THIS round. Found -> return its recorded content verbatim, never
// re-reading the file (idempotent resume: a crash between the event append and the archive
// rename must not re-apply a second, possibly-edited copy of the file, and must not throw on a
// missing/already-archived source). Not found -> ONLY the round's designated consumer (see
// `consume` below) reads the file, appends the event (event append BEFORE the archive rename, so
// a crash between the two leaves the event durable and the rename is simply retried — see
// below), then best-effort archives the source by renaming it out of the live path. Neither an
// event nor (for the consumer) a file -> an explicit 'none' placeholder, never a silent empty
// substitution.
//
// EXACTLY ONE CONSUMER PER ROUND (gate② I2 on PR #159): consumption happens at ROUND OPEN only —
// `consume: true` marks the caller as this round's designated first consumer; `consume: false`
// callers only ever read BACK a prior event (plus the leftover cleanup below), never the file.
// align.ts passes consume: true (aligning IS round open); architect.ts passes
// consume: !cfg.roles.po.enabled (it is the de facto first consumer only when the PO role is
// disabled, #127, and aligning never runs at all). Without this split, a directive dropped
// BETWEEN aligning and architecting would be half-applied — aligning saw 'none', architect saw
// the directive — contradicting the "picked up the next time a round opens" contract; with it,
// a mid-round drop simply waits, untouched, for the next round's opener.
//
// THE LEFTOVER CLEANUP IS SHA-GATED (gate② I1 on PR #159): a call that finds a prior event still
// re-attempts the archive rename, but ONLY when the live file's raw-content sha256 equals the
// event's recorded sha256 — that equality is precisely the crash-leftover signature (the process
// died between the event append and the rename, leaving the exact already-consumed bytes at the
// live path). Re-attempting it here (on every prior-event call, under BOTH consume values — not
// just the branch that just wrote the event) closes the crash gap: otherwise the leftover would
// sit at the live path forever and the next round would re-apply already-consumed content as a
// brand-new directive. A DIFFERING sha means the operator dropped a FRESH directive after this
// round's consumption — renaming that would both swallow steering no round ever saw AND
// overwrite this round's archive with content that doesn't match its event — so it is left in
// place, untouched, for the next round's opener to consume. Skipped silently when the file is
// simply gone (the normal case: already archived).
//
// Deliberately NOT threaded through round-defaults.ts (unlike #123's alignedGoals handoff) —
// each phase already reads its own `deps.state`/`deps.cfg` directly, and the prior-event
// read-back makes architect's second, independent call harmless in the common PO-enabled path.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { capDigest } from "../retro/retro-digest.js";
import type { State } from "../state/state.js";
import type { SapwoodConfig } from "./config.js";
import { defaultRuntimeRoot, runtimePaths } from "./paths.js";

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
    typeof p === "object" &&
    p !== null &&
    typeof (p as Record<string, unknown>).round_id === "number" &&
    typeof (p as Record<string, unknown>).content === "string" &&
    typeof (p as Record<string, unknown>).path === "string" &&
    typeof (p as Record<string, unknown>).sha256 === "string"
  );
}

/** Where a consumed directive is archived to, once and for all, for `roundId` — a sibling
 *  `directives/` dir next to the configured directive file itself (the same
 *  `<runtime-root>/<kind>/<name>` convention state.ts's roundArtifactMdPath uses for
 *  `.sapwood/rounds/round-N.md`), so the default `.sapwood/DIRECTIVE.md` archives to
 *  `.sapwood/directives/round-N.md`. Exported for tests. */
export function directiveArchivePath(directiveFile: string, roundId: number): string {
  return join(dirname(directiveFile), "directives", `round-${roundId}.md`);
}

/** Resolve THIS round's directive text for prompt injection — see module doc for the full
 *  event-sourced consume-once contract. `opts.consume` marks the caller as this round's
 *  designated first consumer (module doc, "EXACTLY ONE CONSUMER PER ROUND"): with no prior event
 *  and consume: false, the function returns NO_ROUND_DIRECTIVE without reading or archiving
 *  anything; the prior-event path (event read-back + the sha-gated leftover cleanup) runs under
 *  BOTH values. Never throws on a missing/absent file (the ordinary, most-common case, degrades
 *  to NO_ROUND_DIRECTIVE) and never throws on an archive-rename/sha-probe failure (logged, not
 *  fatal — the event already recorded is what makes consume-once safe, the rename is best-effort
 *  housekeeping). A state write failure while recording a REAL directive's FIRST application
 *  does throw: the event is the source of truth for it, so silently proceeding without recording
 *  one would let the same file re-apply, unrecorded, on a later round. */
export function resolveRoundDirective(
  state: State,
  cfg: SapwoodConfig,
  roundId: number,
  opts: {
    consume: boolean;
    log?: (message: string) => void;
    /** #1078: override for the directive file's path — tests inject a fixed tmp-dir string,
     *  same "planMdPath"-style seam ArchitectDeps/AlignDeps already use for goal.file. A real
     *  caller omits this and gets runtimePaths(defaultRuntimeRoot()).directiveMd: cwd-relative,
     *  never config-resolved (round.directiveFile is retired — no config key names this path
     *  at all any more). */
    directivePath?: string;
  },
): string {
  const round = state.getRound(roundId);
  const startEventId = round?.start_event_id ?? 0;
  const priorApplications = state
    .eventsAfterId(startEventId, ["directive-applied"])
    .map((e) => e.payload)
    .filter(isDirectiveAppliedPayload)
    .filter((p) => p.round_id === roundId);

  const directivePath = opts.directivePath ?? runtimePaths(defaultRuntimeRoot()).directiveMd;
  let payload: DirectiveAppliedPayload;
  if (priorApplications.length > 0) {
    payload = priorApplications[0]!;
  } else {
    // No prior application this round. Only the designated consumer may perform the first
    // consumption (module doc, gate② I2) — a non-consumer reaching here means the round opened
    // with no directive, and whatever file may exist now was dropped mid-round: leave it,
    // untouched and unread, for the next round's opener.
    if (!opts.consume) return NO_ROUND_DIRECTIVE;
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

  // Best-effort, sha-gated, idempotent archive — see module doc's "THE LEFTOVER CLEANUP IS
  // SHA-GATED" section: runs on EVERY call that reaches here (fresh consumption above, or a
  // prior-event call under either consume value), but renames ONLY the exact bytes this round's
  // event recorded — a differing sha is a FRESH directive awaiting the next round, never touched
  // (gate② I1: renaming it would swallow unseen steering and overwrite this round's archive).
  // Never throws: a filesystem hiccup here must not lose the already-durable event, or crash a
  // round over a housekeeping rename.
  try {
    if (existsSync(directivePath)) {
      const liveSha = createHash("sha256").update(readFileSync(directivePath, "utf8"), "utf8").digest("hex");
      if (liveSha === payload.sha256) {
        const archivePath = directiveArchivePath(directivePath, roundId);
        mkdirSync(dirname(archivePath), { recursive: true });
        renameSync(directivePath, archivePath);
      }
    }
  } catch (e) {
    (opts.log ?? console.error)(
      `[sapwood:directive] round ${roundId}: failed to archive ${directivePath} — ${String(e)} ` +
        `— the directive-applied event is still the durable source of truth, but the source ` +
        `file was left in place and MUST be moved/removed by a human before the next round, or ` +
        `it will be misread as a new, unconsumed directive`,
    );
  }

  return payload.content;
}
