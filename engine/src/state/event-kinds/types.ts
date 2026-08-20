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
 *    carry the cursor payload shape and vice versa).
 *  - `merged-witness`   — state.ts's `MERGED_WITNESS_KINDS`: every kind that durably records the
 *    engine having observed a PR's terminal MERGED state (#803). The dashboard's hero tally binds
 *    to this projection instead of inferring from lane-row presence — a kind tagged here MUST
 *    carry the PR number in a `pr` field, same convention `laneEventRecorded` already reads.
 *  - `lane-session-start` — retro.ts's `LANE_SESSION_START_EVENT_KINDS` (#961): every kind backed
 *    by a FRESH `supervisor.dispatch`/`resume()` call this process made (conductor.ts's own
 *    `spawnFactFrom` call sites) — a worker lane genuinely starting or continuing work this
 *    round, as opposed to a crash-adoption kind (`lane-adopted`, `fix-leg-adopted`) that only
 *    reconciles a session resumed by an earlier, now-dead process.
 *  - `retro-pr-lifecycle` — retro-digest.ts's `RETRO_PR_LIFECYCLE_EVENT_KINDS` (#964): every kind
 *    that names a PR retro itself opened or later pushed to — `retro-pr-opened`/`retro-pr-updated`.
 *    NOT `retro-pr-degraded` (that kind never names a PR that exists on the forge — see its own
 *    doc). This is the ONLY tag whose consumers read the WHOLE ledger, never one round's window: a
 *    retro PR outlives the round that opened it, so "every PR retro currently has outstanding"
 *    needs full history, not a start_event_id cursor. */
export type EventTag =
  | "retro"
  | "pr-touched"
  | "round-artifact"
  | "retro-pr-lifecycle"
  | "escalation-source:always"
  | "escalation-source:payload"
  | "escalation-source:never"
  | "escalation-clear"
  | "dissent-decision"
  | "dissent-receipt"
  | "fix-leg"
  | "merged-witness"
  | "lane-session-start";

/** The three `escalation-source:*` tags, as the ONE list `attentionProof`'s derivation walks —
 *  so a new proof mode is a compile error here rather than a silently-unread tag. */
export const ESCALATION_SOURCE_TAGS = ["escalation-source:always", "escalation-source:payload", "escalation-source:never"] as const;

export type EscalationSourceTag = (typeof ESCALATION_SOURCE_TAGS)[number];

// ── #643: per-kind glossary metadata ─────────────────────────────────────────────────────────
//
// Event-kind MEANINGS were tribal knowledge — code comments a loop supervisor never sees, and the
// documented failure mode is a supervisor guessing an event's significance from its name alone
// (logged supervisor error, dogfood batch 6). A literal-presence cross-check (event-kinds.test.ts)
// proves a consumer list names the right KINDS; it says nothing about what any of them MEAN. The
// fields below are that: required, per-kind, so the registry — not a role's private
// interpretation of it — is the one place "what does this event tell a supervisor" is answered,
// and `generate-glossary.ts` renders it into the sapwood-event-glossary skill every session reads.

/** The four buckets a loop supervisor sorts an event into, in ascending order of "do something
 *  about this now":
 *   - `routine`        — expected steady-state traffic; no read is required.
 *   - `expected-noise`  — looks alarming in isolation but is a known, self-healing retry/degrade
 *     path; worth recognizing by name so it is not mistaken for a fresh incident.
 *   - `investigate`     — not itself a call for action, but a signal a supervisor should read the
 *     surrounding events for (a partial degrade, an anomaly, a companion write that may have
 *     silently failed).
 *   - `intervene`       — a human owes the next decision or action; this is what the engine's own
 *     escalation-source/park/label machinery is telling a person to go look at. */
export type Actionability = "routine" | "expected-noise" | "investigate" | "intervene";

/** The required per-kind (and, by the same shape, per-`ParkSource`/per-`EscalationBucket`)
 *  glossary entry. `meaning` is ONE factual line transcribed from the kind's own doc comment or
 *  emit site — never invented. `actionability` is a SEPARATE judgment from `tags`: the
 *  `escalation-source:*` tags say a kind FEEDS escalation reconciliation (event-kinds.test.ts's
 *  own cross-check enforces that half); they do not by themselves say the kind demands immediate
 *  human action. Usually the two agree (a fresh, unconditional escalation is `intervene`), but not
 *  always — a payload-PREDICATED source (`reclaim-done`/`reclaim-failed`, #404: attention only for
 *  the payloads escalation-reconcile.ts's own predicate admits), a self-retrying companion write
 *  (`gated-reentry-capped-label-failed`: the failure retries next tick, `never` a label proof), or
 *  a source that routes attention through the park path instead of a label
 *  (`env-failure-preserved`) are all legitimately `investigate`. Judge `actionability` from the
 *  emit site's own behavior, never from the tag alone; a pure lifecycle event with no
 *  `escalation-source:*` tag is `routine`. */
export interface KindGlossary {
  readonly meaning: string;
  readonly actionability: Actionability;
}

/** A declared kind's full entry: the existing consumer-surface `tags` PLUS the glossary fields
 *  above, in one required shape — so a kind declared without `meaning`/`actionability` fails to
 *  compile (event-kinds.test.ts's `defineKinds` fixture pins exactly this), the same enforcement
 *  `defineKinds`'s `const` type parameter already gives `tags`. */
export interface KindEntry extends KindGlossary {
  readonly tags: readonly EventTag[];
}

export type EventKindTable = Readonly<Record<string, KindEntry>>;

/** Identity function that PINS the literal key and entry types (`const` type parameter, so a
 *  domain file needs no `as const` noise). Everything downstream — the `EventKind` union, the
 *  type-level tag query, the payload map, the generated glossary — is read off the type this
 *  preserves. */
export const defineKinds = <const T extends EventKindTable>(table: T): T => table;
