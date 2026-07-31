// rapid-restart.ts (#431, owner amendment 1): the crash-loop detector — the ONE real protection
// the deleted session-gap heuristic provided, rebuilt without reviving F29.
//
// Why: #431 anchors the wall-clock ceiling to in-memory process start, so every restart gets a
// fresh clock. That is the adjudicated semantics for SANCTIONED restarts (manual, script, or a
// user-configured supervisor — the human's standing intent), but a CRASH-LOOPING engine under an
// auto-restarter is definitionally NOT the operator's standing intent, and with the gap
// heuristic gone nothing else would notice it. This detector does, from the event log alone.
//
// How: `run-started` is appended exactly once per process boot by both drivers (cli.ts's
// appendRunStarted — re-verified in PR #467 round 2, where it was pinned as the authoritative
// replay grouping boundary). Counting `run-started` events inside the window therefore counts
// TRUE PROCESS BIRTHS and nothing else: wait-loop iterations, heartbeats, and every other
// steady-state append are different kinds and can never inflate it, by construction (the exact
// F29 failure — a wait loop keeping its own budget alive — is structurally impossible here).
// No new table, no new column: event-log-as-memory, same discipline as #447/PR #463.
//
// Trip -> the EXISTING park/needs-human paradigm, never a new refusal mode: enter a durable
// `rapid-restart` park episode (state.ts's ParkSource — every dispatch gate already consults
// isParked(), and the round loop holds at waitForDispatchClear), emit `rapid-restart-detected`,
// and escalate immediately through the park ladder's local channel (there is no trigger issue
// to comment on — the ESCALATION marker + `park-escalated` event + `sapwood status` surface are
// the existing local branch of exactly that ladder). The episode has NO probe on purpose:
// clearing is a later engine start observing the birth window drained (below), which is what
// "a human cleared it" looks like from the event log — the operator stops the crash loop, fixes
// the cause, and the next start outside the window resumes automatically. Deleting the
// park_state row by hand works too; both paths flow through the same clearPark.
//
// Clock discipline (#403/F25): both window bounds derive from the caller's injected clock —
// the count is over the CLOSED window [now - windowSec, now]. Event `ts` stamps are the machine
// clock at write time (appendEvent's own doc — deliberate), so the bounds only meet the stamps
// when the caller's clock IS the machine clock — true in production (cli.ts's systemClock);
// tests steer the window by injecting a shifted `now`, never by sleeping. The UPPER bound
// (#431 round 2, codex P3): a DB restored from a fast-clock machine, or a backward host-clock
// correction, can hold `run-started` rows dated in this machine's future — those must neither
// false-trip the detector nor keep re-parking after a manual park clear for the whole skew.
//
// LOG AUTHORITY (#431 round 4 — this module's whole durability contract, the round-3 write rule
// applied uniformly after codex found the mirror-before-log class recurring here three times):
//   EVERY fact's FIRST durable write is its log event; every row/marker/latch is a MIRROR
//   reconstructible from the log; every dedup reads the LOG.
// Concretely: the episode's identity is its `enteredAt`, minted into the
// `rapid-restart-detected` payload BEFORE any mirror exists; the episode is OPEN in the log iff
// its latest detected/park-resumed transition is `detected` (openEpisodeInLog); the park row,
// the ESCALATION marker, and the escalated_at latch are all mirrors a later boot rebuilds from
// the log when a kill separated them from their events; and the auto-clear appends its
// `park-resumed` receipt BEFORE deleting the row. A kill between any two writes therefore
// always leaves the log ahead of a mirror (repairable next boot), never a fact behind a mirror
// (unrepairable — the exact class codex reproduced in rounds 2-4).
import type { SapwoodConfig } from "../config/config.js";
import type { State } from "../state/state.js";

/** The park episode's source discriminator — state.ts's ParkSource third member. */
export const RAPID_RESTART_PARK_SOURCE = "rapid-restart" as const;

export interface RapidRestartOutcome {
  /** True when this start observed a crash-loop (births >= maxBirths within windowSec). */
  tripped: boolean;
  /** Births counted in the window, INCLUDING this process's own `run-started`. */
  births: number;
}

/** Run once per engine start, strictly AFTER this process's own `run-started` append (cli.ts —
 *  so the count includes this birth, and so the #382-pinned run-started-first event ordering is
 *  undisturbed: everything this function emits lands after the run boundary, inside this run's
 *  replay group). Never throws — a detector must not become a new startup-failure mode; the
 *  park/escalation writes are the same State calls the park paradigm already relies on, and any
 *  unexpected failure is logged and swallowed. */
export function detectRapidRestart(
  state: State,
  cfg: SapwoodConfig,
  now: () => Date,
  log: (message: string) => void = (line) => console.error(line),
): RapidRestartOutcome {
  const { maxBirths, windowSec } = cfg.engine.rapidRestart;
  const nowDate = now();
  const cutoffIso = new Date(nowDate.getTime() - windowSec * 1000).toISOString();
  let births = 0;
  /** The AUTHORITATIVE episode state, folded from the log (module doc: LOG AUTHORITY). The
   *  episode is OPEN iff the latest rapid-restart detected/resumed transition is `detected` —
   *  the same transition-pair fold every #431 pair uses. Returns the open episode's identity
   *  (its minted enteredAt, plus the payload the reason/park mirrors are rebuilt from), or
   *  null. Both event kinds are rare (a handful per DB, ever), so the fold is cheap. A legacy
   *  round-1..3 `rapid-restart-detected` payload carries no enteredAt — `enteredAt: null`
   *  then, and the healers below fall back to the row/now. */
  const openEpisodeInLog = (): { enteredAt: string | null; births: number; windowSec: number; maxBirths: number } | null => {
    let open: { enteredAt: string | null; births: number; windowSec: number; maxBirths: number } | null = null;
    for (const e of state.eventsAfterId(0, ["rapid-restart-detected", "park-resumed"])) {
      if (e.kind === "rapid-restart-detected") {
        const p = e.payload as { enteredAt?: unknown; births?: unknown; windowSec?: unknown; maxBirths?: unknown };
        open = {
          enteredAt: typeof p.enteredAt === "string" ? p.enteredAt : null,
          births: typeof p.births === "number" ? p.births : 0,
          windowSec: typeof p.windowSec === "number" ? p.windowSec : windowSec,
          maxBirths: typeof p.maxBirths === "number" ? p.maxBirths : maxBirths,
        };
      } else if ((e.payload as { source?: unknown }).source === RAPID_RESTART_PARK_SOURCE) {
        open = null; // the resumed receipt closes the episode
      }
    }
    return open;
  };
  /** Is this episode's escalation already in the LOG? Episode identity = the minted enteredAt,
   *  carried in the payload. Events from other sources / the generic duration ladder (which
   *  carries no enteredAt) never match. */
  const escalatedInLog = (enteredAtIso: string): boolean =>
    state
      .eventsAfterId(0, ["park-escalated"])
      .some(
        (e) =>
          (e.payload as { source?: unknown; enteredAt?: unknown }).source === RAPID_RESTART_PARK_SOURCE &&
          (e.payload as { enteredAt?: unknown }).enteredAt === enteredAtIso,
      );
  const escalationMessage = (reason: string): string =>
    `sapwood: rapid-restart detector tripped — ${reason}. Autonomous dispatch is parked. ` +
    `A crash loop is not a sanctioned restart pattern: stop the supervisor/restart source, fix the cause, ` +
    `and start the engine once the window has drained (a later clean start resumes automatically). ` +
    `See docs/troubleshooting.md and docs/security.md (supervisor circuit-breaker prerequisite).`;
  /** The immediate local escalation — NOW, not after envFailure.parkEscalateAfterSec: a crash
   *  loop already IS the escalation-worthy fact, and each of its restarts resets this
   *  process's life anyway. Local channel of the existing park ladder (escalatePark's own
   *  triggerIssue-less branch): park-escalated event + ESCALATION marker + status surface.
   *
   *  Ordered by LOG AUTHORITY (module doc): the park-escalated event (deduped per episode via
   *  escalatedInLog) goes FIRST; the ESCALATION marker and the escalated_at latch are MIRRORS
   *  rewritten after — BOTH of them, idempotently, on every call (#431 round 4, codex P2: the
   *  round-3 heal repaired the latch alone, so a kill between the event and the marker write
   *  lost the marker forever). Callers invoke this whenever any piece of the escalation is
   *  missing; the event dedup makes the log side idempotent and the mirrors overwrite. */
  const escalateLocally = (reason: string, enteredAtIso: string): void => {
    const message = escalationMessage(reason);
    if (!escalatedInLog(enteredAtIso)) {
      state.appendEvent("park-escalated", {
        source: RAPID_RESTART_PARK_SOURCE,
        channel: "local",
        triggerIssue: null,
        enteredAt: enteredAtIso,
      });
    }
    state.writeEscalationMarker({
      source: RAPID_RESTART_PARK_SOURCE,
      reason,
      triggerIssue: null,
      enteredAt: enteredAtIso,
      message,
      at: nowDate.toISOString(),
    });
    state.recordParkEscalation(RAPID_RESTART_PARK_SOURCE, nowDate.toISOString());
    log(`[sapwood:startup] ${message}`);
  };
  const reasonFor = (b: number, w: number, m: number): string => `${b} engine starts within ${w}s (threshold ${m}) — crash loop suspected`;
  try {
    births = state.countEventsBetween(cutoffIso, nowDate.toISOString(), "run-started");
    const openEpisode = openEpisodeInLog();
    const row = state.parkRow(RAPID_RESTART_PARK_SOURCE);
    if (births >= maxBirths) {
      if (openEpisode === null) {
        // Fresh trip. LOG FIRST: the detection event carries the episode's minted identity
        // (the enteredAt every mirror will use) — dedup for later births reads THIS event, not
        // the park row (#431 round 4, codex P3: row-keyed dedup re-announced the same storm
        // when a kill landed between the event and enterPark). Then the mirrors: park row,
        // marker, latch — each reconstructible below if a kill separates them from the log.
        const enteredAtIso = nowDate.toISOString();
        const reason = reasonFor(births, windowSec, maxBirths);
        state.appendEvent("rapid-restart-detected", { births, windowSec, maxBirths, enteredAt: enteredAtIso });
        state.enterPark(RAPID_RESTART_PARK_SOURCE, reason, null, enteredAtIso);
        escalateLocally(reason, enteredAtIso);
      } else {
        // The log says the episode is already open — the durable dedup carrier (one detection
        // + one escalation per episode, never per birth: a crash loop must not turn the ledger
        // into spam). Reconstruct EVERY missing mirror from the log (module doc):
        const enteredAtIso = openEpisode.enteredAt ?? row?.enteredAt ?? nowDate.toISOString();
        const reason = row?.reason ?? reasonFor(openEpisode.births, openEpisode.windowSec, openEpisode.maxBirths);
        if (row === null) {
          // Killed between the detection event and enterPark — the dispatch-gating row itself
          // is the missing mirror. Rebuild it under the episode's own identity.
          state.enterPark(RAPID_RESTART_PARK_SOURCE, reason, null, enteredAtIso);
        }
        if (!escalatedInLog(enteredAtIso) || row?.escalatedAt == null || !state.escalationMarkerExists()) {
          // Any piece of the escalation missing (event / latch / ESCALATION marker) -> rerun
          // the whole escalation: the event side is log-deduped, the mirrors overwrite
          // idempotently (#431 round 4, codex P2 — the marker is a mirror too).
          escalateLocally(reason, enteredAtIso);
        }
        log(
          `[sapwood:startup] rapid-restart park still open (entered ${enteredAtIso}): ` +
            `${births} births within ${windowSec}s — autonomous dispatch stays parked`,
        );
      }
      return { tripped: true, births };
    }
    if (openEpisode !== null || row !== null) {
      // The window has drained — this start is the sanctioned-recovery signal the episode was
      // waiting for (its only auto-clear path; see the module doc). RECEIPT FIRST (#431
      // round 4, codex P2: the round-3 order deleted the row first, so a kill between the two
      // lost row AND receipt — the next boot saw nothing to close and the episode never got
      // its park-resumed). With the receipt down, clearPark is the mirror cleanup — and a kill
      // between the two now leaves a closed-in-log episode with a stray row, which THIS branch
      // deletes on the next boot (openEpisodeInLog is null then, row non-null) with the
      // receipt dedup below preventing a duplicate.
      const enteredAtIso = openEpisode?.enteredAt ?? row?.enteredAt ?? null;
      if (openEpisode !== null) {
        state.appendEvent("park-resumed", {
          source: RAPID_RESTART_PARK_SOURCE,
          enteredAt: enteredAtIso,
          via: "restart-window-clear",
        });
      }
      state.clearPark(RAPID_RESTART_PARK_SOURCE);
      log(`[sapwood:startup] rapid-restart park cleared — ${births} birth(s) within ${windowSec}s is under the ${maxBirths} threshold`);
    }
  } catch (error) {
    // Best-effort, same stance as every other startup pass in cli.ts: the detector must never
    // abort engine startup.
    log(`[sapwood:startup] rapid-restart detection failed (non-fatal, startup continues): ${String(error)}`);
  }
  return { tripped: false, births };
}
