// idle-churn.ts tests (#470): the fingerprint, the ledger-derived streak fold, and the trip's
// own park/escalation mirrors. Pure functions plus one `:memory:` State — no clock, no timers, no
// forge (the module reads none of the three).
import assert from "node:assert/strict";
import { test } from "node:test";
import { State } from "../state/state.js";
import {
  FINGERPRINT_WINDOW_LIMIT,
  IDLE_CHURN_DETECTED_KIND,
  IDLE_CHURN_PARK_SOURCE,
  idleChurnBreached,
  idleChurnReason,
  idleChurnStreak,
  roundFingerprint,
  tripIdleChurnBreaker,
} from "./idle-churn.js";

const ev = (kind: string, payload: unknown) => ({ kind, payload });
/** A closed-round stamp as round.ts writes it (`appendRoundPhase`'s `extra`). */
const closed = (round_id: number, idle: boolean, fp?: string) =>
  ev("round-phase", { round_id, phase: "closed", idle, ...(fp ? { fp } : {}) });

// ── roundFingerprint ────────────────────────────────────────────────────────────────────────

test("roundFingerprint: two rounds that appended the same durable facts fingerprint identically — bookkeeping and the round id are excluded", () => {
  const roundA = [
    ev("round-phase", { round_id: 7, phase: "aligning" }),
    ev("align-summary", { round_id: 7, created: 0, drafted: 0 }),
    ev("role-session-heartbeat", { name: "po", elapsedSec: 30 }),
  ];
  const roundB = [
    ev("round-phase", { round_id: 8, phase: "aligning" }),
    ev("align-summary", { round_id: 8, created: 0, drafted: 0 }),
    ev("role-session-heartbeat", { name: "po", elapsedSec: 91 }), // a different elapsed — still bookkeeping
  ];
  assert.equal(roundFingerprint(roundA), roundFingerprint(roundB));
});

test("roundFingerprint: a PAYLOAD difference is a state difference — the same kind with new facts does NOT match (the narrow direction: a false negative, never a false park)", () => {
  const before = [ev("pool-selected", { round_id: 1, n: 0 })];
  const after = [ev("pool-selected", { round_id: 2, n: 3 })];
  assert.notEqual(roundFingerprint(before), roundFingerprint(after));
});

test("roundFingerprint: ORDER jitter between two otherwise-identical rounds is not a state change", () => {
  const a = [ev("drive-queued", { pr: 5 }), ev("concern-posted", { issue: 9 })];
  const b = [ev("concern-posted", { issue: 9 }), ev("drive-queued", { pr: 5 })];
  assert.equal(roundFingerprint(a), roundFingerprint(b));
});

test("roundFingerprint: a window over the bound is unfingerprintable (null) — never a truncated match", () => {
  const huge = Array.from({ length: FINGERPRINT_WINDOW_LIMIT + 1 }, (_, i) => ev("dispatched", { issue: i }));
  assert.equal(roundFingerprint(huge), null);
  assert.notEqual(roundFingerprint(huge.slice(0, FINGERPRINT_WINDOW_LIMIT)), null);
});

// ── idleChurnStreak: the ledger-derived, restart-safe count ─────────────────────────────────

test("idleChurnStreak: consecutive idle rounds carrying the same fingerprint accumulate", () => {
  const events = [closed(1, true, "aaa"), closed(2, true, "aaa"), closed(3, true, "aaa")];
  assert.equal(idleChurnStreak(events, "aaa"), 3);
  assert.equal(idleChurnBreached(3, 3), true);
  assert.equal(idleChurnBreached(2, 3), false);
});

test("idleChurnStreak: a round that DISPATCHED (idle: false) resets the count — the two-fact rule, even when the fingerprint matches", () => {
  const events = [closed(1, true, "aaa"), closed(2, false, "aaa"), closed(3, true, "aaa")];
  assert.equal(idleChurnStreak(events, "aaa"), 1);
});

test("idleChurnStreak: a round that appended something REAL (a different fingerprint) resets the count", () => {
  const events = [closed(1, true, "aaa"), closed(2, true, "bbb"), closed(3, true, "aaa")];
  assert.equal(idleChurnStreak(events, "aaa"), 1);
});

test("idleChurnStreak: a legacy stamp (pre-#470 — no idle/fp fields at all) resets, so an upgraded ledger can never trip on history it has no fingerprints for", () => {
  const events = [ev("round-phase", { round_id: 1, phase: "closed" }), closed(2, true, "aaa")];
  assert.equal(idleChurnStreak(events, "aaa"), 1);
});

test("idleChurnStreak: non-close phase entries are ignored — a round is counted once, at its close", () => {
  const events = [
    ev("round-phase", { round_id: 1, phase: "aligning" }),
    closed(1, true, "aaa"),
    ev("round-phase", { round_id: 2, phase: "retro" }),
    closed(2, true, "aaa"),
  ];
  assert.equal(idleChurnStreak(events, "aaa"), 2);
});

test("idleChurnStreak: the detection event CONSUMES its own streak — the breaker trips exactly once per episode and an operator clear does not re-trip instantly", () => {
  const events = [closed(1, true, "aaa"), closed(2, true, "aaa"), ev(IDLE_CHURN_DETECTED_KIND, { rounds: 2 }), closed(3, true, "aaa")];
  assert.equal(idleChurnStreak(events, "aaa"), 1, "the post-trip round starts a FRESH episode from zero");
});

// ── the trip: park + local escalation mirrors ───────────────────────────────────────────────

test("tripIdleChurnBreaker: appends the detection event, parks under its own source, and escalates locally (event + latch)", () => {
  const state = new State(":memory:");
  tripIdleChurnBreaker(state, {
    streak: 5,
    threshold: 5,
    roundId: 42,
    fingerprint: "deadbeef",
    probeSignals: ["ready-issues"],
    at: "2026-08-01T00:00:00.000Z",
  });
  const detected = state.eventsAfterId(0, [IDLE_CHURN_DETECTED_KIND]);
  assert.equal(detected.length, 1);
  assert.deepEqual(detected[0]!.payload, {
    rounds: 5,
    threshold: 5,
    roundId: 42,
    fingerprint: "deadbeef",
    probeSignals: ["ready-issues"],
  });
  const row = state.parkRow(IDLE_CHURN_PARK_SOURCE);
  assert.ok(row, "the park row is what actually withholds every later round-open");
  assert.equal(row?.triggerIssue, null);
  assert.equal(row?.escalatedAt, "2026-08-01T00:00:00.000Z", "escalated at trip time — the duration ladder never re-escalates it");
  assert.ok(row?.reason.includes("ready-issues"), "the park reason names the probe signal that held the loop open");
  const escalated = state.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 1);
  assert.equal((escalated[0]!.payload as { source: string }).source, IDLE_CHURN_PARK_SOURCE);
  assert.equal((escalated[0]!.payload as { channel: string }).channel, "local");
  state.close();
});

test("idleChurnReason: an EMPTY probe-signal list is itself a diagnosis (the probe never ran), never a silent blank", () => {
  const reason = idleChurnReason({ streak: 5, threshold: 5, roundId: 9, probeSignals: [] });
  assert.match(reason, /the standby probe did not run/);
});
