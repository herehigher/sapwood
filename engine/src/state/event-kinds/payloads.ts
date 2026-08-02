// event-kinds/payloads.ts (#425, phase 1.5): payload types for the PROVEN load-bearing kinds —
// the ones whose consumers do structured field access on the payload today, not every kind.
//
// Exhaustive payload typing is explicitly out of scope: most kinds are observability, their
// payloads are read only by the dashboard's copy map (outside the compiler's reach anyway), and
// typing them all would buy churn rather than safety. What earns a type here is a consumer that
// would BREAK if the writer changed a field — today that is exactly the fix-leg journal cursor
// (fix-response.ts's `fixLegJournalCursor` reads `worker`/`fixRounds`/`journalCursor` back off
// three kinds written in three different places in conductor.ts).
//
// COMPILE-TIME ONLY. `appendEvent` still stores `JSON.stringify(payload)` with no validation and
// `eventsSince` still returns whatever `JSON.parse` produced — no runtime parsing was added to
// the append hot path. The typed read is a CLAIM about what the writer wrote, which is why
// `fixLegJournalCursor` keeps its own `typeof === "number"` guard for legacy/foreign rows.
import type { EventKind, KindsWithTag } from "./index.js";

/** The three fix-leg kinds' shared payload — F1's monotonic journal-row cursor plus the
 *  (worker, fixRounds) pair the lookup keys on. Writers carry more (`issue`, `pr`, `at`); those
 *  are not read structurally, so they are not pinned here — the `Record<string, unknown>`
 *  intersection in `EventPayloadFor` is what keeps the extra fields legal. */
export interface FixLegCursorPayload {
  worker: string;
  fixRounds: number;
  journalCursor: number;
}

/** The kind -> payload map, keyed OFF THE TAG rather than off a re-spelled kind list: tagging a
 *  new kind `fix-leg` obliges it to this payload shape at both ends automatically, and a kind
 *  that loses the tag drops out of the map instead of leaving a dangling entry. */
export type EventPayloads = {
  [K in KindsWithTag<"fix-leg">]: FixLegCursorPayload;
};

export type PayloadTypedKind = keyof EventPayloads & EventKind;

/** The WRITE side (`appendEvent`): the declared shape widened with an index signature, so a
 *  writer's extra identity fields (`issue`, `pr`, `at`, `attempt`) aren't excess-property
 *  errors — the declared fields are a floor, not a closed shape. `unknown` for the kinds with no
 *  declared payload, which is every kind but the fix-leg three.
 *
 *  The READ side (`eventsSince`'s typed overload) deliberately does NOT carry that index
 *  signature — it hands back the bare `EventPayloads[K]`. The asymmetry is the point: WITH the
 *  index signature on the read, a consumer reading `payload.journalCursor` after that field was
 *  renamed out of the type resolves it to `unknown` and keeps compiling (its own `typeof` guard
 *  narrows it), which is exactly the silent breakage phase 1.5 exists to prevent. Without it the
 *  rename breaks the read site, so writer and reader are genuinely held to one shape. A field a
 *  reader genuinely needs is a signal to declare it here, never to widen the read type. */
export type EventPayloadFor<K extends EventKind> = K extends PayloadTypedKind ? EventPayloads[K] & Record<string, unknown> : unknown;
