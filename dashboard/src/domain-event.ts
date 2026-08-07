import type { LoopEvent } from "./api/types.ts";
import { type EventKind, isKnownKind, type Payload } from "./copy.ts";

/**
 * #715 gate② round 5 [0]: the parse boundary where a wire `LoopEvent` (`api/types.ts` —
 * `kind: string`, honestly unclosed, because the server may run a newer engine emitting a kind
 * this build hasn't shipped a `copy.ts` entry for yet) becomes a `DomainEvent` — the type
 * everything past that boundary actually consumes. `toDomainEvent` (below) is the ONLY place in
 * the app that classifies a raw wire kind; `queries.ts`'s `accumulateEventsPage` is the ONLY
 * caller (events enter the app there). Once classified:
 *
 * - `entities.ts`'s title/attention folds,
 * - `copy.ts`'s sentence/attention lookups, and
 * - `ActivityFeed.tsx`'s feed rendering
 *
 * all read `DomainEvent`, never the raw `LoopEvent` — so a `KnownDomainEvent`'s `kind` is
 * genuinely `EventKind` at the type level, not just annotated as one in an isolated test fixture.
 * §8's own contract still requires the feed to keep RENDERING a kind it doesn't recognize (never
 * crash, never silently hide it) — `UnknownDomainEvent` is that case, kept as an explicit, typed
 * branch instead of a `string`-typed `kind` quietly falling through `copyFor`'s runtime fallback.
 */
export interface KnownDomainEvent {
  readonly known: true;
  readonly id: number;
  readonly ts: string;
  readonly kind: EventKind;
  readonly payload: Payload | null;
}

export interface UnknownDomainEvent {
  readonly known: false;
  readonly id: number;
  readonly ts: string;
  /** The raw wire kind, preserved verbatim for the fallback sentence / details view — never
   *  coerced into `EventKind`, and never dropped. */
  readonly kind: string;
  readonly payload: Payload | null;
}

export type DomainEvent = KnownDomainEvent | UnknownDomainEvent;

/** The parse-boundary function itself. `isKnownKind` (`copy.ts`) — derived from `COPY`'s own key
 *  set — is the single source of truth for the classification; this function does nothing else. */
export function toDomainEvent(event: LoopEvent): DomainEvent {
  return isKnownKind(event.kind)
    ? { known: true, id: event.id, ts: event.ts, kind: event.kind, payload: event.payload }
    : { known: false, id: event.id, ts: event.ts, kind: event.kind, payload: event.payload };
}
