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
  /** The immediate local escalation — NOW, not after envFailure.parkEscalateAfterSec: a crash
   *  loop already IS the escalation-worthy fact, and each of its restarts resets this
   *  process's life anyway. Local channel of the existing park ladder (escalatePark's own
   *  triggerIssue-less branch): ESCALATION marker + park-escalated event + status surface.
   *  The recordParkEscalation latch also keeps the per-tick duration ladder from re-firing.
   *  Idempotent by construction of its callers: only ever invoked while the episode's
   *  escalated_at is still null. */
  const escalateLocally = (reason: string, enteredAtIso: string): void => {
    const message =
      `sapwood: rapid-restart detector tripped — ${reason}. Autonomous dispatch is parked. ` +
      `A crash loop is not a sanctioned restart pattern: stop the supervisor/restart source, fix the cause, ` +
      `and start the engine once the window has drained (a later clean start resumes automatically). ` +
      `See docs/troubleshooting.md and docs/security.md (supervisor circuit-breaker prerequisite).`;
    state.writeEscalationMarker({
      source: RAPID_RESTART_PARK_SOURCE,
      reason,
      triggerIssue: null,
      enteredAt: enteredAtIso,
      message,
      at: nowDate.toISOString(),
    });
    state.recordParkEscalation(RAPID_RESTART_PARK_SOURCE, nowDate.toISOString());
    state.appendEvent("park-escalated", { source: RAPID_RESTART_PARK_SOURCE, channel: "local", triggerIssue: null });
    log(`[sapwood:startup] ${message}`);
  };
  try {
    births = state.countEventsBetween(cutoffIso, nowDate.toISOString(), "run-started");
    const existing = state.parkRow(RAPID_RESTART_PARK_SOURCE);
    if (births >= maxBirths) {
      if (existing === null) {
        const reason = `${births} engine starts within ${windowSec}s (threshold ${maxBirths}) — crash loop suspected`;
        // Event first (the detection fact), then the durable park (the consequence), then the
        // escalation — same event-before-upsert ordering the escalation paths use. A crash
        // ANYWHERE in this sequence heals on the next boot: before the park -> re-detects and
        // re-parks; after the park but before the escalation latch -> the still-open branch
        // below observes escalatedAt === null and completes the marker/latch/event (#431
        // round 2, codex P2 — round 1 left that crash window permanently unescalated).
        state.appendEvent("rapid-restart-detected", { births, windowSec, maxBirths });
        state.enterPark(RAPID_RESTART_PARK_SOURCE, reason, null, nowDate.toISOString());
        escalateLocally(reason, nowDate.toISOString());
      } else {
        // Already parked from a previous birth in this same storm — the durable episode is the
        // dedup carrier (one rapid-restart-detected + one escalation per episode, not per
        // birth: a crash loop must not turn the ledger into spam). Dispatch is already gated.
        // #431 round 2 (codex P2): heal-on-boot — a prior birth that died between enterPark and
        // the escalation latch left escalated_at null; complete the escalation now, once.
        if (existing.escalatedAt === null) {
          escalateLocally(existing.reason, existing.enteredAt);
        }
        log(
          `[sapwood:startup] rapid-restart park still open (entered ${existing.enteredAt}): ` +
            `${births} births within ${windowSec}s — autonomous dispatch stays parked`,
        );
      }
      return { tripped: true, births };
    }
    if (existing !== null) {
      // The window has drained — this start is the sanctioned-recovery signal the episode was
      // waiting for (its only auto-clear path; see the module doc). Same clearPark choke point
      // every park resume flows through, so the ESCALATION marker cleanup rides along free.
      state.clearPark(RAPID_RESTART_PARK_SOURCE);
      state.appendEvent("park-resumed", {
        source: RAPID_RESTART_PARK_SOURCE,
        enteredAt: existing.enteredAt,
        via: "restart-window-clear",
      });
      log(`[sapwood:startup] rapid-restart park cleared — ${births} birth(s) within ${windowSec}s is under the ${maxBirths} threshold`);
    }
  } catch (error) {
    // Best-effort, same stance as every other startup pass in cli.ts: the detector must never
    // abort engine startup.
    log(`[sapwood:startup] rapid-restart detection failed (non-fatal, startup continues): ${String(error)}`);
  }
  return { tripped: false, births };
}
