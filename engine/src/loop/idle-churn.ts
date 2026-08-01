// idle-churn.ts (#470): the idle-churn breaker — the RUNTIME backstop for an F32-shaped
// generator nobody has found yet.
//
// F32 (dogfood 2026-07-29, rounds 244-249) burned six empty rounds in 12 minutes because
// `probeHasWork` (round.ts) counted work nothing enabled could ever consume, so standby's own
// precondition never engaged. PR #466 then found the SAME generator shape in three more places.
// The per-signal answer is round.ts's DESIGN RULE ("every signal admitted to this probe must NAME
// ITS TERMINAL"), and it bounds every generator we KNOW about. This module bounds the ones we
// don't: any future probe signal, selector drift, or forge anomaly whose terminal argument is
// wrong reproduces F32, and until now the only detector was a human reading the round ledger
// during a dogfood run — at ~3 rounds of burn per discovery.
//
// STANDBY IS STILL THE FIRST LINE. This breaker only ever sees churn standby's own precondition
// failed to stop, which is exactly the F32 pathology; it changes nothing about when standby
// engages, and a run where standby works normally never reaches the threshold (a standing round
// loop that opens no rounds closes no rounds, and the streak below counts CLOSED rounds only).
//
// PARADIGMS REUSED, NOTHING NEW INVENTED (the issue's own constraint — no new refusal mode):
//  - DETECTION is watchdog-shaped (watchdog.ts, #395): sample a cheap fact once per boundary and
//    fire only after K CONSECUTIVE unchanged readings. The watchdog's fact is the
//    (maxEventId, lastTickAt) tuple sampled per timer window; ours is a per-round FINGERPRINT
//    sampled per round close.
//  - The TRIP is the existing park/needs-human degrade (stall-breaker.ts, #407 — itself
//    rapid-restart.ts's shape): a durable detection event FIRST, then the park row, then the
//    local escalation (park-escalated + ESCALATION marker + escalated_at latch) as reconstructible
//    mirrors. `waitForDispatchClear` (round.ts) already withholds every subsequent round-open
//    while ANY park stands, so the park itself is the whole containment — this module adds no
//    gate of its own.
//
// WHAT "IDLE AND STATE-IDENTICAL" MEANS, and why it takes two facts rather than one:
//  (a) IDLE is the caller's fact (round.ts stamps it at close): the round dispatched nothing AND
//      no lane is occupied — running, driving or fixing (state.ts's activeWorkers).
//      HONEST NOTE ON THE LANE READ: today it is a belt, not the braces. The executing phase's
//      drain loop already refuses to leave while ANY lane is in flight, so a round that reaches
//      close has an empty lane set by construction — which is also the real reason a LEGITIMATE
//      long wait can never accrue a streak: a driving lane on a pending CI run emits an
//      identical `drive-queued` every drive pass (watchdog.ts's own note on that site), and a
//      fingerprint alone would happily call those rounds identical — but they are not separate
//      ROUNDS at all. They are passes inside ONE round that stays open until the lane resolves,
//      and the round that finally closes carries the resolution (`merged`, an escalation, a
//      fix leg) in its own fingerprint. The lane read is kept anyway, explicitly, because that
//      guarantee lives in a different function: any future round-close path that does not drain
//      first would silently hand this breaker a lane-occupied round to count.
//  (b) STATE-IDENTICAL is this module's fingerprint: the round's own ledger window (id-bounded by
//      `round.start_event_id`, the #123 cursor) reduced to the multiset of {kind, payload} pairs
//      of every event that is NOT round bookkeeping. Two rounds match iff they appended the same
//      durable facts — so a round that merged a PR, posted a concern, escalated, or created an
//      issue differs from its predecessor by the payload alone and RESETS the streak, even though
//      the KIND repeats.
// Payload-sensitivity is the deliberate direction: it makes this breaker NARROWER (a false
// negative — churn we fail to catch — rather than a false positive that halts a healthy engine),
// which is the trade this repo's own doctrine names for detection choices. The one normalization
// applied is dropping `round_id`/`roundId`, which by construction differs every round and would
// otherwise make EVERY round unique and this breaker dead code.
//
// RESTART-SAFE BY CONSTRUCTION, NO NEW COLUMNS: the streak is not a counter in memory. It is
// folded from the ledger every time it is consulted, over the `round-phase` closed stamps
// (each carrying its own round's `idle` + `fp`) and this module's own detection event. A kill -9
// mid-count loses nothing: the next run folds the same stamps and reaches the same number. A
// legacy stamp (pre-#470, no `idle` field) reads as not-idle and resets — an upgraded ledger can
// never trip on history it has no fingerprints for.
//
// TRIPS EXACTLY ONCE per episode: the fold RESETS at the newest `idle-churn-detected`. So the
// event that parked the engine also consumes the streak that produced it — no second event for
// the same churn, and no re-trip the instant an operator clears the park (a fresh episode has to
// earn its own K rounds). That is the same "the log is the latch" dedup rapid-restart.ts and
// stall-breaker.ts use, folded over this module's own kind.
import { createHash } from "node:crypto";
import type { State } from "../state/state.js";

/** The park episode's source discriminator — state.ts's ParkSource fifth member. Probe-less, like
 *  `rapid-restart`/`consecutive-stalls`: an idle-churn park has nothing to probe (the engine is
 *  demonstrably healthy — it is opening and closing rounds perfectly well; what is broken is that
 *  they achieve nothing), so it clears only when a human clears it. */
export const IDLE_CHURN_PARK_SOURCE = "idle-churn" as const;

/** The detection event kind — the ledger's own diagnosis record. */
export const IDLE_CHURN_DETECTED_KIND = "idle-churn-detected";

/** Kinds a round emits REGARDLESS of whether it achieved anything — excluded from the fingerprint
 *  so "state-identical" means "appended no durable FACT", not "appended no row at all".
 *
 *  - `round-phase`: the round's own phase trail (and the carrier of the close stamp itself).
 *  - the four heartbeats (util/heartbeat.ts's two call sites plus round.ts's own loop pair): pure
 *    liveness telemetry whose payloads carry elapsed seconds/attempt counters. They are excluded
 *    for the semantic reason (a heartbeat is not a fact about the WORK) and, incidentally, would
 *    otherwise make every round unique on their timing fields alone — the fail-DEAD direction for
 *    this breaker.
 *  - `standby-wait`/`standby-exit`/`park-wait-heartbeat` are emitted BETWEEN rounds (outside any
 *    round's id window) and so are already invisible here; listed anyway so a future move of
 *    either call site cannot silently change what "identical" means. */
export const ROUND_BOOKKEEPING_KINDS: ReadonlySet<string> = new Set([
  "round-phase",
  "role-session-heartbeat",
  "worker-heartbeat",
  "park-wait-heartbeat",
  "standby-heartbeat",
  "standby-wait",
  "standby-exit",
]);

/** Payload keys dropped before fingerprinting: they differ every round BY CONSTRUCTION, so
 *  keeping them would make no two rounds ever compare equal and this breaker would be dead code.
 *  Deliberately just these two (the round id under both spellings used in this codebase) — every
 *  other payload field is a genuine fact about what the round did, and dropping more would widen
 *  the breaker toward false positives. */
const VOLATILE_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["round_id", "roundId"]);

/** A round window big enough to hit this cap is, by any reading, not an idle round — but the cap
 *  is what makes the window read BOUNDED (state.ts's `eventsPage` takes a limit, and an unbounded
 *  read at every round close is a cost this breaker must not add). The caller treats an
 *  overflowing window as unfingerprintable (streak reset), never as a truncated match: a truncated
 *  fingerprint could only ever manufacture an equality that the full window doesn't have. */
export const FINGERPRINT_WINDOW_LIMIT = 1000;

function stablePayload(payload: unknown): string {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return JSON.stringify(payload) ?? "null";
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([k]) => !VOLATILE_PAYLOAD_KEYS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** The round's state fingerprint: a short digest of the sorted {kind, normalized payload} multiset
 *  of every non-bookkeeping event in the window. SORTED, so a round that appends the same facts in
 *  a different order still matches — ordering jitter between two otherwise-identical rounds is not
 *  a state change. Returns `null` when the window overflows FINGERPRINT_WINDOW_LIMIT (see its
 *  doc) — the caller reads that as "not comparable", which resets the streak. */
export function roundFingerprint(events: readonly { kind: string; payload: unknown }[]): string | null {
  if (events.length > FINGERPRINT_WINDOW_LIMIT) return null;
  const parts = events
    .filter((e) => !ROUND_BOOKKEEPING_KINDS.has(e.kind))
    .map((e) => `${e.kind}|${stablePayload(e.payload)}`)
    .sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** How many consecutive closed rounds — counting back from the newest — were idle AND carry
 *  `fingerprint`. Folded over `round-phase` + `idle-churn-detected` events in ledger order (the
 *  caller passes exactly those two kinds). Resets on: a closed round that was not idle or whose
 *  stamp names a different fingerprint (including a legacy stamp with no `idle`/`fp` at all), and
 *  on an `idle-churn-detected` (the trip consumes its own streak — see the module doc). Non-close
 *  `round-phase` entries are ignored: a round is counted once, at its close. */
export function idleChurnStreak(events: readonly { kind: string; payload: unknown }[], fingerprint: string): number {
  let streak = 0;
  for (const e of events) {
    if (e.kind === IDLE_CHURN_DETECTED_KIND) {
      streak = 0;
      continue;
    }
    const p = (e.payload ?? {}) as { phase?: unknown; idle?: unknown; fp?: unknown };
    if (p.phase !== "closed") continue;
    streak = p.idle === true && p.fp === fingerprint ? streak + 1 : 0;
  }
  return streak;
}

/** Threshold comparison, mirroring env-failure.ts's `emptySpinBreached` — the sibling breaker's
 *  own shape, kept separate so each reads as one named decision at its call site. */
export function idleChurnBreached(streak: number, threshold: number): boolean {
  return streak >= threshold;
}

export interface IdleChurnTrip {
  streak: number;
  threshold: number;
  roundId: number;
  fingerprint: string;
  /** Which standby-probe signal(s) held the last round open — the diagnosis this event exists to
   *  put in the ledger (round.ts's `probeWorkSignal` records the winner of its own short-circuit
   *  evaluation, so there is at most one). EMPTY is itself a diagnosis, not a gap: it means the
   *  probe never ran this round at all — standby is disabled, or its `lastRoundIdle` precondition
   *  was not met — so whatever held the loop open was NOT a probe signal. */
  probeSignals: readonly string[];
  /** ISO timestamp for the park row / marker (the caller's own `iso()` seam — never a clock read
   *  in here). */
  at: string;
}

export function idleChurnReason(trip: Pick<IdleChurnTrip, "streak" | "threshold" | "roundId" | "probeSignals">): string {
  const held = trip.probeSignals.length > 0 ? trip.probeSignals.join(", ") : "none (the standby probe did not run)";
  return (
    `idle-churn breaker: ${trip.streak} consecutive rounds (threshold ${trip.threshold}, round ${trip.roundId} last) closed ` +
    `IDLE — no dispatch, no occupied lane — and STATE-IDENTICAL: each appended exactly the same durable facts as the one ` +
    `before it. Probe signal(s) holding the loop open: ${held}`
  );
}

export function idleChurnMessage(reason: string): string {
  return (
    `sapwood: ${reason}. Autonomous dispatch is parked. The loop is healthy — it is opening and closing rounds ` +
    `normally — but those rounds are achieving nothing, which is the F32 pathology (#432): a standby probe signal ` +
    `counting work that nothing enabled can ever consume, so standby never engages. Start from the probe signal(s) ` +
    `named above and ask what would CONSUME that work; if the answer is "nothing", that signal needs its terminal ` +
    `(round.ts's probeHasWork DESIGN RULE). This park does NOT auto-clear: fix the cause, then stop the engine and run ` +
    `\`sapwood park clear --source ${IDLE_CHURN_PARK_SOURCE}\` (docs/troubleshooting.md).`
  );
}

/** Fire the breaker: the durable detection event FIRST (it is the latch — the fold above resets on
 *  it, so a kill between this append and the park below simply means the next start's round loop
 *  is unparked with the streak already consumed, i.e. it fails toward RUNNING, never toward a
 *  silently un-diagnosable park), then the park row, then the local escalation mirrors — exactly
 *  stall-breaker.ts's `escalateLocally` ordering and channel (local: this episode carries no
 *  trigger issue, so env-failure.ts's `escalationChannel` ladder routes it local by construction).
 *
 *  Best-effort throughout, same stance as the sibling empty-spin breaker at the same call site: a
 *  telemetry/marker write that fails must never take down a round loop that is otherwise fine —
 *  the park row is the operative signal and is attempted first among the mirrors. */
export function tripIdleChurnBreaker(
  state: Pick<State, "appendEvent" | "enterPark" | "writeEscalationMarker" | "recordParkEscalation">,
  trip: IdleChurnTrip,
  log?: (message: string) => void,
): void {
  const reason = idleChurnReason(trip);
  const message = idleChurnMessage(reason);
  state.appendEvent(IDLE_CHURN_DETECTED_KIND, {
    rounds: trip.streak,
    threshold: trip.threshold,
    roundId: trip.roundId,
    fingerprint: trip.fingerprint,
    probeSignals: [...trip.probeSignals],
  });
  state.enterPark(IDLE_CHURN_PARK_SOURCE, reason, null, trip.at);
  try {
    state.appendEvent("park-escalated", {
      source: IDLE_CHURN_PARK_SOURCE,
      channel: "local",
      triggerIssue: null,
      roundId: trip.roundId,
      enteredAt: trip.at,
    });
    state.writeEscalationMarker({
      source: IDLE_CHURN_PARK_SOURCE,
      reason,
      triggerIssue: null,
      roundId: trip.roundId,
      enteredAt: trip.at,
      message,
      at: trip.at,
    });
    state.recordParkEscalation(IDLE_CHURN_PARK_SOURCE, trip.at);
  } catch {
    /* mirrors are reconstructible; the park row above is the operative signal */
  }
  log?.(`[sapwood:round] ${message}`);
}
