import assert from "node:assert/strict";
import test from "node:test";
import type { LoopEvent } from "./api/types.ts";
import { isKnownKind } from "./copy.ts";
import { toDomainEvent } from "./domain-event.ts";

/**
 * #715 gate② round 5 [0]: runtime proof of the real parse boundary — `toDomainEvent`, called from
 * `queries.ts`'s `accumulateEventsPage` on every fresh wire page. Not a type-only fixture: these
 * feed a genuine wire-shaped `LoopEvent` (`kind: string`, exactly what `fetchEvents` returns)
 * through the actual classification function and assert on its output.
 */

test("isKnownKind: true for every real §7-table kind, false for an unmapped one", () => {
  assert.equal(isKnownKind("dispatched"), true);
  assert.equal(isKnownKind("merged"), true);
  assert.equal(isKnownKind("a-kind-nobody-registered-in-copy-ts"), false);
});

test("toDomainEvent: a real, mapped wire kind classifies as known:true, kind unchanged", () => {
  const wire: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: { issue: 5 } };
  const domain = toDomainEvent(wire);
  assert.equal(domain.known, true);
  assert.equal(domain.kind, "dispatched");
  assert.equal(domain.id, 1);
  assert.deepEqual(domain.payload, { issue: 5 });
});

test("toDomainEvent: an unmapped wire kind (a newer engine's) classifies as known:false, never dropped — kind preserved verbatim", () => {
  const wire: LoopEvent = {
    id: 2,
    ts: "2026-08-06T00:00:01Z",
    kind: "a-kind-from-a-newer-engine",
    payload: { some: "future-shape" },
  };
  const domain = toDomainEvent(wire);
  assert.equal(domain.known, false);
  assert.equal(domain.kind, "a-kind-from-a-newer-engine");
  assert.equal(domain.id, 2);
  assert.deepEqual(domain.payload, { some: "future-shape" });
});

test("toDomainEvent: a null payload (corrupt legacy row) passes through untouched, for either branch", () => {
  const knownWire: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.equal(toDomainEvent(knownWire).payload, null);

  const unknownWire: LoopEvent = { id: 2, ts: "2026-08-06T00:00:00Z", kind: "a-kind-from-a-newer-engine", payload: null };
  assert.equal(toDomainEvent(unknownWire).payload, null);
});
