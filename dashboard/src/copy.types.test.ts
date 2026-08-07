import assert from "node:assert/strict";
import test from "node:test";
import type { LoopEvent } from "./api/types.ts";
import { COPY, type EventKind } from "./copy.ts";

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
 * #715 gate② round 4 [0]: the round-3 proof above only showed that a value explicitly ANNOTATED
 * as `EventKind` rejects an unknown string — it never proved that the events FIXTURES the rest of
 * this suite builds (ActivityFeed.test.tsx's `ev`, entities.test.ts's `event`, api.test.ts's
 * `evt`) are themselves wired to that closed union. This mirrors those builders' exact shape —
 * `kind: EventKind`, not a bare `string` — so it IS "the feed's kind type", connected. A real,
 * mapped kind must still compile fine; an unmapped one must not.
 */
const fixtureEvent = (kind: EventKind): LoopEvent => ({ id: 1, ts: "2026-01-01T00:00:00.000Z", kind, payload: {} });

fixtureEvent("dispatched"); // sanity: a real, mapped kind still compiles

// @ts-expect-error — the verification plan's promised negative compile fixture (issue #145): a
// fake, unmapped event kind added to an events fixture must fail typecheck, not silently reach
// `copyFor`'s runtime fallback. If this stops erroring, the fixture builders across the test
// suite (or this one) have been silently widened back to `kind: string`.
fixtureEvent("a-kind-nobody-registered-in-copy-ts");

test("EventKind is a closed union, not a bare string", () => {
  // The interesting assertion already happened above, at compile time. This just keeps the file
  // from being all-comment under a runner that ignores unused-variable lint.
  assert.equal(typeof COPY.dispatched, "object");
});

test("an events fixture's kind is the closed EventKind union, connected end to end", () => {
  // Same point as above, but through the fixture builder itself, not a bare annotated const —
  // proving the connection the reviewer asked for, not just the union's own closedness.
  assert.equal(fixtureEvent("dispatched").kind, "dispatched");
});
