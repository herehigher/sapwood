// event-kinds/types.ts (#425): the vocabulary the per-domain declaration files speak.
//
// A tag names a CONSUMER SURFACE — some read path that folds a subset of the ledger. Tagging is
// the whole point of the registry: a flat union of kind strings would catch a misspelling, but
// the failure class that actually bit this repo is CROSS-LIST OMISSION — `fix-rounds-capped`, the
// most common escalation of all, was a perfectly valid kind, written correctly, and simply absent
// from `ESCALATION_SOURCES`, so nothing could ever resolve it (#295 review round 4). Kind-spelling
// enforcement cannot see that; a kind that declares its own surfaces, with the consumer lists
// DERIVED from those declarations, can't have it.
//
// Deliberately NOT a `tier` column on the events table (adjudicated in #425 with a second-opinion
// architect review): the DB stays dumb storage — persistence and ordering — because "is this kind
// load-bearing" is a property of what CODE depends on it, and duplicating that in a row would
// create a second source of truth that drifts the first time someone deletes a consumer.

/** A consumer surface a kind can belong to. Adding a tag here is how a NEW read path joins the
 *  registry's enforcement: declare it, tag the kinds, derive the list, and the completeness test
 *  (`event-kinds.test.ts`) starts guarding both directions for free.
 *
 *  - `retro`            — retro.ts's `RETRO_EVENT_KINDS` (round-retro facts).
 *  - `pr-touched`       — retro-digest.ts's `PR_TOUCHED_EVENT_KINDS`.
 *  - `round-artifact`   — round-artifact.ts's `ROUND_ARTIFACT_EVENT_KINDS`.
 *  - `escalation-source:*` — escalation-reconcile.ts's `ESCALATION_SOURCES`, carrying that
 *    table's own `EscalationProof` mode (`always` / `payload` / `never`; see its doc for what
 *    each one claims and why a wrong one costs a false clear).
 *  - `escalation-clear` — escalation-reconcile.ts's `CLEAR_KINDS`.
 *  - `dissent-decision` / `dissent-receipt` — dissent.ts's `DECISION_KINDS` / `RECEIPT_KIND`.
 *  - `fix-leg`          — fix-response.ts's journal-cursor kinds; ALSO the payload-typed set
 *    (see `payloads.ts` — the map keys off this tag, so tagging a kind `fix-leg` obliges it to
 *    carry the cursor payload shape and vice versa). */
export type EventTag =
  | "retro"
  | "pr-touched"
  | "round-artifact"
  | "escalation-source:always"
  | "escalation-source:payload"
  | "escalation-source:never"
  | "escalation-clear"
  | "dissent-decision"
  | "dissent-receipt"
  | "fix-leg";

/** The three `escalation-source:*` tags, as the ONE list `attentionProof`'s derivation walks —
 *  so a new proof mode is a compile error here rather than a silently-unread tag. */
export const ESCALATION_SOURCE_TAGS = ["escalation-source:always", "escalation-source:payload", "escalation-source:never"] as const;

export type EscalationSourceTag = (typeof ESCALATION_SOURCE_TAGS)[number];

export type EventKindTable = Readonly<Record<string, readonly EventTag[]>>;

/** Identity function that PINS the literal key and tag types (`const` type parameter, so a domain
 *  file needs no `as const` noise). Everything downstream — the `EventKind` union, the type-level
 *  tag query, the payload map — is read off the type this preserves. */
export const defineKinds = <const T extends EventKindTable>(table: T): T => table;
