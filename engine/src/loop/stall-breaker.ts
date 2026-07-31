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
// CLEARING STORY — the rapid-restart shape, with the drained-window condition replaced by a
// broken streak, because the stall streak does not decay with time the way a birth window does:
// the episode has NO probe; a later engine start observing streak < threshold appends the
// `park-resumed` receipt (receipt FIRST, then clearPark — #431 round 4) and resumes. With every
// exit neutral, the ONLY thing that breaks a standing streak is a closed round — and the parked
// engine itself supplies exactly that canary: a park gates DISPATCH, not the round loop, and
// round 1 of a run opens unconditionally (round.ts), so a parked run whose peripheral phases
// complete closes one (dispatch-empty) round. The wedge decides what happens next, honestly:
//   - wedge in the dispatch/worker path -> the parked round closes; the NEXT start reads that
//     closed round as recovery evidence, appends the receipt, and resumes dispatch. Resumed
//     WITHOUT the wedge fixed, dispatch re-wedges and the streak re-accumulates to a NEW
//     episode — bounded, one escalation per episode, never silent.
//   - wedge in the round loop itself -> the parked run stalls again before any round closes;
//     the streak only grows, the park and its (deduped) escalation stand until the wedge is
//     actually fixed. No restart pattern — graceful or hard — can launder it.
// Deleting the park_state row by hand does NOT stick while the log still shows an unbroken
// streak: the next start rebuilds every mirror from the log (LOG AUTHORITY — and the row-null
// state is indistinguishable from the kill window between detection and enterPark, so treating
// it as an operator act would fail open). The manual override is fixing the wedge, not state
// surgery — docs/troubleshooting.md says so in operator terms.
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
   *  shape to rapid-restart.ts's openEpisodeInLog, over this module's own kind pair. */
  const openEpisodeInLog = (): { enteredAt: string | null; streak: number; maxConsecutiveStalls: number } | null => {
    let open: { enteredAt: string | null; streak: number; maxConsecutiveStalls: number } | null = null;
    for (const e of state.eventsAfterId(0, ["consecutive-stalls-detected", "park-resumed"])) {
      if (e.kind === "consecutive-stalls-detected") {
        const p = e.payload as { enteredAt?: unknown; streak?: unknown; maxConsecutiveStalls?: unknown };
        open = {
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
  /** Is this episode's escalation already in the LOG? Episode identity = the minted enteredAt —
   *  same log-keyed dedup as rapid-restart.ts's escalatedInLog. */
  const escalatedInLog = (enteredAtIso: string): boolean =>
    state
      .eventsAfterId(0, ["park-escalated"])
      .some(
        (e) =>
          (e.payload as { source?: unknown }).source === CONSECUTIVE_STALLS_PARK_SOURCE &&
          (e.payload as { enteredAt?: unknown }).enteredAt === enteredAtIso,
      );
  const escalationMessage = (reason: string): string =>
    `sapwood: consecutive-stall breaker tripped — ${reason}. Autonomous dispatch is parked. ` +
    `The same wedge appears to recur on every restart; restarting again will not fix it. ` +
    `Diagnose the stall (the engine-stalled events name the round/phase and last event) and fix the cause. ` +
    `The park clears on the first start after a round has CLOSED again (the parked engine's own ` +
    `dispatch-empty round counts once its phases complete) — no exit, clean or otherwise, clears it. ` +
    `See docs/troubleshooting.md and docs/getting-started.md ("Running under a supervisor").`;
  /** The immediate local escalation — same channel, ordering, and mirror-heal contract as
   *  rapid-restart.ts's escalateLocally (see its own doc): the log-deduped park-escalated event
   *  FIRST, then the ESCALATION marker and the escalated_at latch as idempotent mirrors. */
  const escalateLocally = (reason: string, enteredAtIso: string): void => {
    const message = escalationMessage(reason);
    if (!escalatedInLog(enteredAtIso)) {
      state.appendEvent("park-escalated", {
        source: CONSECUTIVE_STALLS_PARK_SOURCE,
        channel: "local",
        triggerIssue: null,
        enteredAt: enteredAtIso,
      });
    }
    state.writeEscalationMarker({
      source: CONSECUTIVE_STALLS_PARK_SOURCE,
      reason,
      triggerIssue: null,
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
    // ── the breaker (item 3) — rapid-restart.ts's exact branch structure with the birth count
    // replaced by the streak ──────────────────────────────────────────────────────────────
    const openEpisode = openEpisodeInLog();
    const row = state.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE);
    if (streak >= max) {
      if (openEpisode === null) {
        // Fresh trip. LOG FIRST: the detection event mints the episode identity every mirror
        // uses; then the mirrors (park row, marker, latch), each reconstructible below.
        const enteredAtIso = nowDate.toISOString();
        const reason = reasonFor(streak, max);
        state.appendEvent("consecutive-stalls-detected", { streak, maxConsecutiveStalls: max, enteredAt: enteredAtIso });
        state.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, reason, null, enteredAtIso);
        escalateLocally(reason, enteredAtIso);
      } else {
        // Episode already open in the log — the durable dedup carrier (one detection + one
        // escalation per episode, never per restart). Reconstruct every missing mirror.
        const enteredAtIso = openEpisode.enteredAt ?? row?.enteredAt ?? nowDate.toISOString();
        const reason = row?.reason ?? reasonFor(openEpisode.streak, openEpisode.maxConsecutiveStalls);
        if (row === null) {
          state.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, reason, null, enteredAtIso);
        }
        if (!escalatedInLog(enteredAtIso) || row?.escalatedAt == null || !state.escalationMarkerExists()) {
          escalateLocally(reason, enteredAtIso);
        }
        log(
          `[sapwood:startup] consecutive-stalls park still open (entered ${enteredAtIso}): ` +
            `${streak} consecutive stalled run(s) — autonomous dispatch stays parked`,
        );
      }
      outcome.tripped = true;
      return outcome;
    }
    if (openEpisode !== null || row !== null) {
      // The streak is broken — this start is the sanctioned-recovery signal (module doc's
      // clearing story). RECEIPT FIRST, then the row cleanup (#431 round 4's order, verbatim).
      const enteredAtIso = openEpisode?.enteredAt ?? row?.enteredAt ?? null;
      if (openEpisode !== null) {
        state.appendEvent("park-resumed", {
          source: CONSECUTIVE_STALLS_PARK_SOURCE,
          enteredAt: enteredAtIso,
          via: "stall-streak-clear",
        });
      }
      state.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE);
      log(`[sapwood:startup] consecutive-stalls park cleared — the stall streak is broken (${streak} < ${max})`);
    }
  } catch (error) {
    // Best-effort, same stance as detectRapidRestart: never abort engine startup.
    log(`[sapwood:startup] consecutive-stall detection failed (non-fatal, startup continues): ${String(error)}`);
  }
  return outcome;
}
