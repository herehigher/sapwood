// stall-breaker.ts (#407, items 2+3): the DECISION half of the stall story — startup
// stall-awareness plus the consecutive-stall breaker. The watchdog (watchdog.ts, #395) is the
// diagnosis half: it appends a durable `engine-stalled` and exits nonzero so a supervisor can
// restart. What was missing is everything on the other side of that exit: the next start never
// read the record, so a DETERMINISTIC wedge — a bug that re-wedges at the same phase every
// time — restarted into the same wedge forever under external supervision. This module is the
// backstop that makes external supervision safe (docs/getting-started.md "Running under a
// supervisor"): restart is the right answer for a transient wedge, a human is the right answer
// for a deterministic one, and the event log alone can tell them apart.
//
// ANCHORED to the rapid-restart detector (loop/rapid-restart.ts, #431) — deliberately the same
// mechanism in every structural respect rather than a parallel subsystem: run once per engine
// start strictly AFTER appendRunStarted (cli.ts — everything emitted lands inside this run's
// replay group, the #382-pinned run-started-first ordering undisturbed); trip into the EXISTING
// park/needs-human paradigm (a durable `consecutive-stalls` park episode — state.ts's ParkSource
// fourth member — every dispatch gate already consults isParked(), and nonLlmParkOpen blocks
// any non-llm source by construction) with an immediate LOCAL escalation (park-escalated event +
// ESCALATION marker + escalated_at latch — the same triggerIssue-less branch of the park ladder);
// LOG AUTHORITY throughout (#431 round 4's write rule, applied verbatim: every fact's FIRST
// durable write is its log event, every row/marker/latch is a reconstructible MIRROR, every
// dedup reads the LOG); never throws (a detector must not become a new startup-failure mode).
//
// What the fold reads — all EXISTING event kinds plus this module's own pair, no schema change:
//   - `run-started`: the run-group boundary (one per true process birth — rapid-restart.ts's
//     own re-verified premise).
//   - `engine-stalled`: the watchdog's terminal — "this run ended in a self-diagnosed stall".
//   - `run-ended` (#407 item 1, cli.ts's appendRunEnded): the CLEAN terminal — "this run exited
//     on purpose". A group with NEITHER terminal is a crash/kill.
//   - `round-phase` with phase "closed" (round.ts): real forward progress.
// STREAK = how many stalled runs since the last piece of PROGRESS EVIDENCE. It resets on
// exactly TWO things and nothing else (#407's own AC wording — "N consecutive stalled runs with
// no round CLOSED between them" — is a progress condition, not an exit-cleanliness condition;
// PR #473 gate② P1 pinned this):
//   (a) a CLOSED ROUND (`round-phase` with phase "closed") anywhere between stalls, and
//   (b) this episode's own sanctioned clear receipt (`park-resumed`, below).
// EVERY exit terminal is streak-NEUTRAL: a crashed run (no terminal) is evidence of nothing,
// and a CLEANLY-ENDED run (`run-ended` — signal, stop-condition, idle, --once) is TOO. The
// clean-run case is the P1 lesson: a supervisor that SIGTERMs before each restart (systemd's
// KillSignal, launchd) would otherwise lace every wedge cycle with a clean terminal and reset
// the streak forever — a deterministic wedge that never trips the breaker. The engine cannot
// observe the intent behind a signal (human vs supervisor) and must not infer it; only a closed
// round is evidence the loop actually moved. Crash neutrality has its own second reason: a kill
// window between this module's detection event and its park mirror must not forgive real stalls
// (the #431 round-4 class). The transient-wedge guarantee falls out directly: a host-sleep
// wedge closes rounds between its stalls, so its streak never exceeds 1.
//
// CLEARING STORY — OPERATOR-EXPLICIT, and nothing else (PR #473 round 3, P3 ruling:
// degrade-to-human, no new probe machinery). The episode has NO probe and NO auto-clear: once
// open, it stands — across any number of restarts, with its single deduped escalation and its
// evidence preserved — until the operator deletes the `consecutive-stalls` park_state row (the
// SAME manual channel the sibling rapid-restart park documents); the next engine start observes
// the deletion, appends the `park-resumed` receipt (`via: "operator-clear"`), and resumes.
//
// Why this deliberately DIFFERS from rapid-restart's auto-clear, per the same ruling: rapid-
// restart can honestly re-evaluate its trip condition at every start (births inside a window
// that decays with wall time), so "the condition no longer holds" is an observable fact. The
// stall streak has no such decay, and the one in-engine progress signal that could stand in —
// a round closing — is produced by a round loop the park deliberately leaves RUNNING while it
// gates exactly the dispatch surface a dispatch-adjacent wedge lives on: a dispatch-empty round
// closing while parked proves loop health, not wedge recovery, and accepting it as the clear
// receipt yields an unbounded park -> empty-round clear -> re-wedge -> re-park oscillation
// under a restarting supervisor (the round-3 P3). A bounded dispatch-adjacent recovery probe
// was considered and REJECTED for v1 (marginal-complexity: no new recovery machinery on the
// recovery path); a deterministic wedge is a human's call to close.
//
// Operator-clear detection is log-authoritative, not a guess: the engine's own clear is
// receipt-first, so an OPEN episode whose escalation IS in the log but whose park row is GONE
// with no receipt has exactly one possible writer — the operator. The one remaining row-null
// state, detection logged but enterPark never reached (a kill in that two-statement window),
// is distinguished by the ABSENT escalation (it only lands after the park) and heals by
// rebuilding the row, so a crash can never be mistaken for a human act.
import type { SapwoodConfig } from "../config/config.js";
import type { State } from "../state/state.js";

/** The park episode's source discriminator — state.ts's ParkSource fourth member. */
export const CONSECUTIVE_STALLS_PARK_SOURCE = "consecutive-stalls" as const;

export interface StallBreakerOutcome {
  /** True when the PREVIOUS run ended in a self-diagnosed stall (an `engine-restart-after-stall`
   *  audit event was appended this start). */
  restartAfterStall: boolean;
  /** Consecutive stalled runs immediately preceding this start, per the module-doc fold. */
  streak: number;
  /** True when this start observed streak >= liveness.maxConsecutiveStalls (parked). */
  tripped: boolean;
}

/** One run group's folded facts. Only the stall matters to the fold: exit terminals — clean and
 *  crash alike — are streak-neutral by the module doc's P1 rule, so nothing else is tracked. */
interface RunGroup {
  stalled: boolean;
}

/** Run once per engine start, strictly AFTER this process's own `run-started` append and next to
 *  detectRapidRestart (cli.ts) — the two detectors are the same placement pattern on the same
 *  boundary. Never throws; any unexpected failure is logged and swallowed. */
export function detectConsecutiveStalls(
  state: State,
  cfg: SapwoodConfig,
  now: () => Date,
  log: (message: string) => void = (line) => console.error(line),
): StallBreakerOutcome {
  const max = cfg.liveness.maxConsecutiveStalls;
  const nowDate = now();
  const outcome: StallBreakerOutcome = { restartAfterStall: false, streak: 0, tripped: false };
  /** The AUTHORITATIVE episode state, folded from the log (module doc: LOG AUTHORITY) — open iff
   *  the latest consecutive-stalls detected/resumed transition is `detected`; identical fold
   *  shape to rapid-restart.ts's openEpisodeInLog, over this module's own kind pair.
   *
   *  #477: the episode's IDENTITY is its detection event's own ledger `id` — unique, monotonic,
   *  crash-safe. It was the minted `enteredAt` wall-clock timestamp, and two episodes minted in
   *  the same millisecond collided (the second episode's escalation was swallowed as already
   *  logged — the #403 F25 class, carried by the implementation while the test was honest).
   *  `enteredAt` survives in payloads as DISPLAY metadata only: no identity comparison anywhere
   *  in this module reads it. */
  const openEpisodeInLog = (): { id: number; enteredAt: string | null; streak: number; maxConsecutiveStalls: number } | null => {
    let open: { id: number; enteredAt: string | null; streak: number; maxConsecutiveStalls: number } | null = null;
    for (const e of state.eventsAfterId(0, ["consecutive-stalls-detected", "park-resumed"])) {
      if (e.kind === "consecutive-stalls-detected") {
        const p = e.payload as { enteredAt?: unknown; streak?: unknown; maxConsecutiveStalls?: unknown };
        open = {
          id: e.id,
          enteredAt: typeof p.enteredAt === "string" ? p.enteredAt : null,
          streak: typeof p.streak === "number" ? p.streak : 0,
          maxConsecutiveStalls: typeof p.maxConsecutiveStalls === "number" ? p.maxConsecutiveStalls : max,
        };
      } else if ((e.payload as { source?: unknown }).source === CONSECUTIVE_STALLS_PARK_SOURCE) {
        open = null; // the resumed receipt closes the episode
      }
    }
    return open;
  };
  /** Is this episode's escalation already in the LOG? Keyed on the episode's ledger-id identity
   *  (#477 — the payload's `episodeId`, stamped by escalateLocally below), never on a minted
   *  timestamp.
   *
   *  LEGACY RULE (#478 gate② P2): a #473-era `park-escalated` carries no `episodeId`, and
   *  treating it as never-matching would make the first post-upgrade restart append a duplicate
   *  escalation for an intact open episode — violating the per-episode never-spam invariant the
   *  #473 tests pin. So an event LACKING `episodeId` counts as THIS episode's escalation iff its
   *  own ledger id is newer than the episode's detection event id. That match is exact by
   *  construction: pre-#477 semantics admit only ONE open episode, and its escalation is
   *  appended strictly after its detection (LOG FIRST) — so a legacy escalation newer than the
   *  open detection necessarily belongs to it, and legacy escalations of earlier (closed)
   *  episodes are older than it. Still zero timestamp comparisons: both sides of the legacy
   *  test are ledger ids. */
  const escalatedInLog = (episodeId: number): boolean =>
    state.eventsAfterId(0, ["park-escalated"]).some((e) => {
      if ((e.payload as { source?: unknown }).source !== CONSECUTIVE_STALLS_PARK_SOURCE) return false;
      const stamped = (e.payload as { episodeId?: unknown }).episodeId;
      return stamped === undefined ? e.id > episodeId : stamped === episodeId;
    });
  const escalationMessage = (reason: string): string =>
    `sapwood: consecutive-stall breaker tripped — ${reason}. Autonomous dispatch is parked. ` +
    `The same wedge appears to recur on every restart; restarting again will not fix it, and the ` +
    `park does NOT auto-clear. Diagnose the stall (the engine-stalled events name the round/phase ` +
    `and last event), fix the cause, then clear the park by deleting its park_state row ` +
    `(docs/troubleshooting.md has the exact command) — the next start records the operator clear ` +
    `and resumes dispatch. See also docs/getting-started.md ("Running under a supervisor").`;
  /** The immediate local escalation — same channel, ordering, and mirror-heal contract as
   *  rapid-restart.ts's escalateLocally (see its own doc): the log-deduped park-escalated event
   *  FIRST, then the ESCALATION marker and the escalated_at latch as idempotent mirrors. The
   *  event and marker carry BOTH the identity (`episodeId`, the dedup key — #477) and the
   *  display metadata (`enteredAt`, for humans reading the ledger). */
  const escalateLocally = (reason: string, episodeId: number, enteredAtIso: string): void => {
    const message = escalationMessage(reason);
    if (!escalatedInLog(episodeId)) {
      state.appendEvent("park-escalated", {
        source: CONSECUTIVE_STALLS_PARK_SOURCE,
        channel: "local",
        triggerIssue: null,
        episodeId,
        enteredAt: enteredAtIso,
      });
    }
    state.writeEscalationMarker({
      source: CONSECUTIVE_STALLS_PARK_SOURCE,
      reason,
      triggerIssue: null,
      episodeId,
      enteredAt: enteredAtIso,
      message,
      at: nowDate.toISOString(),
    });
    state.recordParkEscalation(CONSECUTIVE_STALLS_PARK_SOURCE, nowDate.toISOString());
    log(`[sapwood:startup] ${message}`);
  };
  const reasonFor = (s: number, m: number): string =>
    `${s} consecutive stalled runs with no round closed between them (threshold ${m}) — deterministic wedge suspected`;
  try {
    // ── the streak fold (module doc) — resets on (a) round-closed and (b) this episode's own
    // clear receipt, and on NOTHING else. `run-ended` is deliberately NOT in the read set:
    // every exit terminal is streak-neutral by the P1 ruling (PR #473 gate②), so the fold does
    // not even look at it — neutrality by construction, not by an ignored branch. Run groups
    // are still walked, but only for the per-group stall dedup and item 2's previous-run
    // question (the previous run's stall fact, which needs boundaries, not terminals). ──────
    const events = state.eventsAfterId(0, ["run-started", "engine-stalled", "round-phase", "park-resumed"]);
    let streak = 0;
    let prevGroup: RunGroup | null = null; // the group immediately before `current`
    let current: RunGroup | null = null; // the group being walked (null before the first run-started)
    const finalizeCurrent = (): void => {
      if (current === null) return;
      if (current.stalled) streak++;
      // A group without a stall — crashed OR cleanly ended alike — changes nothing (module doc).
      prevGroup = current;
    };
    for (const e of events) {
      if (e.kind === "run-started") {
        finalizeCurrent();
        current = { stalled: false };
      } else if (current === null) {
        // Pre-history before any run boundary (a legacy DB) — nothing to attribute it to.
      } else if (e.kind === "engine-stalled") {
        current.stalled = true;
      } else if (e.kind === "round-phase") {
        if ((e.payload as { phase?: unknown }).phase === "closed") streak = 0; // reset (a)
      } else if ((e.payload as { source?: unknown }).source === CONSECUTIVE_STALLS_PARK_SOURCE) {
        streak = 0; // reset (b): a closed episode's stalls are consumed — they must never re-trip
      }
    }
    // `current` is THIS run's own group (the detector runs after appendRunStarted); `prevGroup`
    // is the run before it — the one whose terminal decides stall-awareness (item 2).
    outcome.streak = streak;
    if (prevGroup !== null && (prevGroup as RunGroup).stalled) {
      // Item 2: startup stall-awareness — the audit record, then business as usual (the phase
      // cursor and reconcileStartup already handle the actual recovery; nothing else changes).
      outcome.restartAfterStall = true;
      state.appendEvent("engine-restart-after-stall", { consecutiveStalls: streak });
      log(
        `[sapwood:startup] previous run ended in a self-diagnosed stall (engine-stalled) — ` +
          `restarting into normal recovery (${streak} consecutive stalled run(s) so far, breaker threshold ${max})`,
      );
    }
    // ── the breaker (item 3) — rapid-restart.ts's branch structure, with one adjudicated
    // difference (PR #473 round 3, P3): an OPEN episode never auto-clears. Rapid-restart's own
    // clear re-evaluates its trip condition (births in a decaying window) and clears when it no
    // longer holds; the stall streak has no such honest re-evaluation post-park — the only
    // in-engine progress signal, a closed round, is produced by a loop the park deliberately
    // leaves running while gating exactly the dispatch surface the wedge lives on. So an open
    // episode holds until the OPERATOR acts (module doc's clearing story); the fold streak is
    // consulted only to open a NEW episode. ────────────────────────────────────────────────
    const openEpisode = openEpisodeInLog();
    const row = state.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE);
    if (openEpisode !== null) {
      // Display metadata only (#477): enteredAt feeds the rebuilt row's entered_at, the receipt
      // payload, and log lines — never an identity comparison. The identity is openEpisode.id.
      const enteredAtIso = openEpisode.enteredAt ?? row?.enteredAt ?? nowDate.toISOString();
      if (row === null && escalatedInLog(openEpisode.id)) {
        // THE operator clear (module doc): the episode had fully materialized — park row AND
        // logged escalation — and the row is now gone with no engine receipt in the log. The
        // engine's own clear is receipt-first, so a receiptless missing row on an escalated
        // episode has exactly one remaining writer: the operator deleting the park_state row.
        // Honor it — RECEIPT FIRST (closing the episode in the log, which also resets the
        // fold's streak for every start after this), then clearPark as the mirror cleanup
        // (removes the ESCALATION marker: the operator has acted, the alarm is answered).
        state.appendEvent("park-resumed", {
          source: CONSECUTIVE_STALLS_PARK_SOURCE,
          episodeId: openEpisode.id,
          enteredAt: enteredAtIso,
          via: "operator-clear",
        });
        state.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE);
        log(
          `[sapwood:startup] consecutive-stalls park cleared by the operator (park_state row removed) — ` +
            `resuming dispatch; the streak restarts from zero`,
        );
      } else {
        // The episode stands — heal every missing mirror from the log (one detection + one
        // escalation per episode, never per restart). row === null WITHOUT a logged escalation
        // is the kill window between the detection event and enterPark (the escalation only
        // lands after the park), not an operator act — rebuild the row under the episode's
        // identity (its entered_at mirrors the detection payload's display metadata).
        const reason = row?.reason ?? reasonFor(openEpisode.streak, openEpisode.maxConsecutiveStalls);
        if (row === null) {
          state.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, reason, null, enteredAtIso);
        }
        if (!escalatedInLog(openEpisode.id) || row?.escalatedAt == null || !state.escalationMarkerExists()) {
          escalateLocally(reason, openEpisode.id, enteredAtIso);
        }
        log(
          `[sapwood:startup] consecutive-stalls park still open (episode ${openEpisode.id}, entered ${enteredAtIso}): ` +
            `autonomous dispatch stays parked until the operator clears it (docs/troubleshooting.md)`,
        );
        outcome.tripped = true;
      }
      return outcome;
    }
    if (streak >= max) {
      // Fresh trip. LOG FIRST: the detection event IS the episode — its ledger id, read back
      // via openEpisodeInLog (the append this branch just made is necessarily the newest
      // detection), is the identity every mirror and every dedup uses (#477); the minted
      // enteredAt in its payload is display metadata. Then the mirrors (park row, marker,
      // latch), each reconstructible above.
      const enteredAtIso = nowDate.toISOString();
      const reason = reasonFor(streak, max);
      state.appendEvent("consecutive-stalls-detected", { streak, maxConsecutiveStalls: max, enteredAt: enteredAtIso });
      const episodeId = openEpisodeInLog()?.id;
      if (episodeId === undefined) throw new Error("consecutive-stalls-detected append not readable back from the ledger");
      state.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, reason, null, enteredAtIso);
      escalateLocally(reason, episodeId, enteredAtIso);
      outcome.tripped = true;
      return outcome;
    }
    if (row !== null) {
      // A stray mirror row on a log-closed episode — the kill window between the operator-clear
      // receipt above and its clearPark. Finish the cleanup silently: the log already carries
      // the receipt, so no duplicate is appended (#431 round 4's receipt-first shape).
      state.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE);
      log(`[sapwood:startup] consecutive-stalls park row cleaned up — the episode is already closed in the log`);
    }
  } catch (error) {
    // Best-effort, same stance as detectRapidRestart: never abort engine startup.
    log(`[sapwood:startup] consecutive-stall detection failed (non-fatal, startup continues): ${String(error)}`);
  }
  return outcome;
}
