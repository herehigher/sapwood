// event-kinds/index.ts (#425): the central, tagged event-kind registry — the ONE place a kind the
// engine writes is declared, and the source every consumer kind-list is derived from.
//
// RENAME POLICY: pre-public, renaming a kind is free (reset the dogfood DB when you do — renaming
// WITHOUT a reset silently gaps every retro/round-artifact read over history written before it).
// After public release that flips: a rename orphans users' existing history, so the policy becomes
// ADDITIVE-ONLY. The same line is recorded in docs/security.md's "Trust context" section, beside
// the rest of the trusted-repos-first / public-hardening roadmap.
//
// Two failure classes this exists to close (see types.ts for the tag rationale):
//  1. CROSS-LIST OMISSION — a valid, correctly-written kind missing from a consumer list that
//     logically needs it. Not hypothetical: `fix-rounds-capped` was absent from ESCALATION_SOURCES
//     for four review rounds. The completeness test (`event-kinds.test.ts`) is what catches it;
//     kind-spelling enforcement alone never could.
//  2. SILENT CONTROL-FLOW BREAKAGE — renaming or dropping a kind that "looks like just logging"
//     while an `eventsSince`/dedup/replay consumer depends on it. A tagged kind says out loud
//     which read paths hold it up.
//
// OUT OF REACH, on purpose: `@sapwood/dashboard` is a separate workspace that does not import
// `engine/src`, so its §7 copy map stays outside the compiler. The gate② checklist rule ("new
// event kinds land in the §7 copy map in the same PR") remains the mechanism there.
import { DRIVE_EVENT_KINDS } from "./drive.js";
import { ESCALATION_EVENT_KINDS } from "./escalation.js";
import { GOVERNANCE_EVENT_KINDS } from "./governance.js";
import { LANE_EVENT_KINDS } from "./lane.js";
import { REVIEW_EVENT_KINDS } from "./review.js";
import { RUN_EVENT_KINDS } from "./run.js";
import type { EventTag, KindGlossary } from "./types.js";

export type { Actionability, EscalationSourceTag, EventTag, KindEntry, KindGlossary } from "./types.js";
export { ESCALATION_SOURCE_TAGS } from "./types.js";

/** Every event kind the engine writes, merged from the per-domain declaration files. The spread
 *  keeps each domain's literal key/tag types, so `EventKind` and the tag queries below are read
 *  straight off this object's TYPE — no second list to keep in sync. A kind declared in two
 *  domains would be silently merged here, so the completeness test asserts against that too. */
export const EVENT_KINDS = {
  ...RUN_EVENT_KINDS,
  ...LANE_EVENT_KINDS,
  ...DRIVE_EVENT_KINDS,
  ...REVIEW_EVENT_KINDS,
  ...GOVERNANCE_EVENT_KINDS,
  ...ESCALATION_EVENT_KINDS,
};

/** The closed union `State.appendEvent` accepts. An undeclared kind is a typecheck failure. */
export type EventKind = keyof typeof EVENT_KINDS & string;

/** The per-domain tables, keyed by domain name — for the completeness test's duplicate check
 *  (the merged object above cannot show a collision; the parts can). */
export const EVENT_KIND_DOMAINS = {
  run: RUN_EVENT_KINDS,
  lane: LANE_EVENT_KINDS,
  drive: DRIVE_EVENT_KINDS,
  review: REVIEW_EVENT_KINDS,
  governance: GOVERNANCE_EVENT_KINDS,
  escalation: ESCALATION_EVENT_KINDS,
} as const;

/** TYPE-LEVEL tag query — the literal union of kinds carrying `T`. Paired with `kindsTagged`'s
 *  runtime fold below so a derived consumer list is narrowed to exactly its members (which is
 *  what lets the payload-typed `eventsSince` overload match the fix-leg list without a cast). */
export type KindsWithTag<T extends EventTag> = {
  [K in EventKind]: T extends (typeof EVENT_KINDS)[K]["tags"][number] ? K : never;
}[EventKind];

/** RUNTIME tag query — the derived consumer list. The one cast in the registry: a runtime
 *  `.filter` cannot prove to the compiler that it produced exactly `KindsWithTag<T>`, and the
 *  completeness test is what checks the two halves agree. */
export function kindsTagged<T extends EventTag>(tag: T): KindsWithTag<T>[] {
  return (Object.keys(EVENT_KINDS) as EventKind[]).filter((kind) =>
    (EVENT_KINDS[kind].tags as readonly EventTag[]).includes(tag),
  ) as KindsWithTag<T>[];
}

/** `EVENT_KINDS[kind]`'s glossary half — `#643`'s per-kind `meaning`/`actionability`/`see`, with
 *  `tags` stripped off (the generator's only consumer; nothing runtime-facing needs it). */
export function kindGlossary(kind: EventKind): KindGlossary {
  const { tags: _tags, ...glossary } = EVENT_KINDS[kind];
  return glossary;
}

/** `kindsTagged` for a tag that must name EXACTLY one kind (dissent's `RECEIPT_KIND` is the only
 *  such consumer today). Throws rather than returning a silent first-match: a second kind
 *  acquiring the tag means the consumer's own shape is wrong, not that a fold should pick one. */
export function soleKindTagged<T extends EventTag>(tag: T): KindsWithTag<T> {
  const all = kindsTagged(tag);
  if (all.length !== 1) throw new Error(`event-kinds: tag "${tag}" must name exactly one kind, found ${all.length}`);
  return all[0]!;
}

// No `isEventKind(string): kind is EventKind` narrowing guard here, deliberately: nothing needs
// one. Kinds arriving from outside the compiler (a DB row read back) are compared, never
// re-written, and the write path's enforcement is `appendEvent`'s signature. A guard with no
// production caller is the unwired-function class docs/REVIEW-DOCTRINE.md names — add it with
// its first real caller, not before.
