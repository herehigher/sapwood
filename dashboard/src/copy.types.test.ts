import assert from "node:assert/strict";
import test from "node:test";
import { COPY, type EventKind } from "./copy.ts";
import type { KnownDomainEvent } from "./domain-event.ts";

/**
 * Compile-time proof of the §7 contract ("adding an event kind without a copy entry is a type
 * error"), not just a documentation claim. `COPY` is declared as `Record<EventKind, CopyEntry>`
 * (copy.ts) — TypeScript itself refuses to compile that object literal if any `EventKind` member
 * is missing a property, and refuses to compile the assignment below if a string outside the
 * union is used where an `EventKind` is expected. `npm run typecheck` is what actually runs this
 * proof; `tsx` (which only transpiles) lets this file execute either way, so the assertions below
 * exist so the file still pulls its weight under `npm test`.
 */

// @ts-expect-error — a kind absent from the §7 table (and therefore from `EventKind`) must be
// rejected at the type level. If this stops erroring, `EventKind` has been silently widened
// (e.g. back to `string`) and the whole "missing copy entry is a type error" guarantee is gone.
const _rejectedKind: EventKind = "a-kind-nobody-registered-in-copy-ts";

/**
 * #715 gate② round 5 [0] (Codex REJECT on the round-4 attempt): a bare `EventKind`-annotated
 * const, or a LOCAL test helper whose parameter is typed `EventKind`, only proves that THAT
 * annotation/helper is closed — it proves nothing about the real data path, where the wire
 * `LoopEvent.kind` is honestly `string` (a newer engine may emit a kind this build doesn't know
 * yet — §8's contract). The real connection is `domain-event.ts`'s `toDomainEvent`, the ONE parse
 * boundary (called from `queries.ts`'s `accumulateEventsPage`) that classifies a wire kind against
 * `copy.ts`'s closed union, producing a `KnownDomainEvent` whose `kind: EventKind` for real. This
 * asserts against THAT type directly — not a local helper's parameter — and
 * `domain-event.test.ts` / `api.test.ts` exercise the boundary FUNCTION itself at runtime (a real
 * fold-path call, not a type-only proof).
 */

const _fakeKnownEvent: KnownDomainEvent = {
  known: true,
  id: 1,
  ts: "2026-01-01T00:00:00.000Z",
  // @ts-expect-error — the DOMAIN type itself rejects an unmapped kind: `KnownDomainEvent.kind` is
  // `EventKind`, so a fake kind here fails typecheck exactly where the app's real event objects
  // are typed, not just in an isolated fixture helper's signature.
  kind: "a-kind-nobody-registered-in-copy-ts",
  payload: {},
};

// Sanity: a real, mapped kind still compiles fine as a KnownDomainEvent.
const _realKnownEvent: KnownDomainEvent = { known: true, id: 1, ts: "2026-01-01T00:00:00.000Z", kind: "dispatched", payload: {} };

test("EventKind is a closed union, not a bare string", () => {
  // The interesting assertion already happened above, at compile time. This just keeps the file
  // from being all-comment under a runner that ignores unused-variable lint.
  assert.equal(typeof COPY.dispatched, "object");
});

test("a KnownDomainEvent's kind is a real, mapped EventKind", () => {
  assert.equal(_realKnownEvent.kind, "dispatched");
});
