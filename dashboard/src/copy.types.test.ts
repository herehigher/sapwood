import assert from "node:assert/strict";
import test from "node:test";
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

test("EventKind is a closed union, not a bare string", () => {
  // The interesting assertion already happened above, at compile time. This just keeps the file
  // from being all-comment under a runner that ignores unused-variable lint.
  assert.equal(typeof COPY.dispatched, "object");
});
