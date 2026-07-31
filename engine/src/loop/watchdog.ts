// watchdog.ts (#395 round 2/4 — gate② P1): a PROGRESS-based liveness watchdog, not a
// tick-completion race.
//
// The original design armed a timer against each tick() call and treated "this one tick took
// too long" as a stall. That is structurally unsound: `reviewer.mode: engine-agent` (the
// dogfooded production reviewer) awaits a full LLM review session INLINE inside tick()
// (conductor.ts -> merge-driver.ts -> review/drive.ts -> review/engine-agent.ts ->
// peripheral.ts's RoleRunner.run() -> `await exitPromise`), bounded only by worker.timeoutSec
// (default 3600s) with up to two attempts serial per gated lane. A perfectly healthy 10-20
// minute review well inside its cost budget would trip a tickIntervalSec x
// watchdogTickMultiplier (600s default) window and self-kill the engine MID-REVIEW — a
// deterministic self-kill loop on exactly the PRs that most need reviewing, strictly worse than
// the wedge this issue set out to fix. Enlarging the window doesn't fix this: the true ceiling
// is lanes x attempts x worker.timeoutSec, so any window safe against a busy tick is far too
// coarse to detect a real stall, and any window tight enough to be useful self-kills.
//
// So the watchdog no longer measures tick DURATION at all. Instead it samples a TUPLE of two
// independent liveness signals:
//   - state.maxEventId(): the event log's high-water mark. Some conductor.ts appendEvent sites
//     are transition-anchored (fire once per state change); others are per-tick (e.g.
//     drive-queued, conductor.ts:2711, fires on EVERY DRIVE pass that sees a WAIT-gated lane —
//     confirmed by tracing the source, not assumed). Which kind any given site is, is an
//     implementation detail of conductor.ts that can change (see #383, which explicitly plans to
//     dedupe drive-queued) — the watchdog must not depend on it either way.
//   - state.lastTickAt(): engine_session.last_tick_at, written on EVERY tick regardless of what
//     that tick did (conductor.ts's touchLastTick call — the #431 survivor) — the SAME column the dashboard's
//     deriveEngineState already reads (State.lastTickAt's own doc). A pure read, never touched
//     here via a second path.
// Stalled only when BOTH have gone unchanged across a full window — a tick that's actually
// running (even one that appends nothing) keeps last_tick_at moving, so it alone is enough to
// prove the loop isn't wedged; maxEventId alone would (correctly) prove the same for a busy
// tick. Requiring both dead is not a weaker bar for genuine stalls: a truly wedged tick (stuck
// inside a single await — a hung `gh` call, a lost spawn/exit notification) never reaches the
// point where either signal advances, so it still fires. What this buys, concretely: it decouples
// the watchdog from event-log VOLUME, so a legitimate spam-reduction change (#383's drive-queued
// dedupe) can never silently turn into a liveness regression — and it makes the engine's own
// definition of "stalled" the same fact `sapwood status`/the dashboard already read, from the
// same columns.
//
// Armed ONCE per engine run (at the top of driver.ts's runDriver / round.ts's runRounds, stopped
// in their own `finally`) as an INDEPENDENT recurring real timer — never raced against any
// specific await — so it covers every phase (aligning/architecting/plan_review/executing/
// harvesting/retro), not just tick()'s own dispatch/reclaim/drive. peripheral.ts's own unbounded
// `await exitPromise` (RoleRunner.run) needs no separate BLANKET bound as a result — this
// watchdog already covers the case where it wedges the whole engine; peripheral.ts additionally
// resolves it directly once a dead child is positively detected (see that module's own comment).
//
// This only works if something advances the tuple at least once per window during every
// legitimately long, otherwise-quiet stretch. Verified (see each site's own comment for the
// evidence) that four such stretches previously emitted NOTHING and needed a heartbeat added:
// peripheral.ts's RoleRunner.run() heartbeat interval (the review-session path above, and every
// other role session), worker.ts's WorkerSupervisor heartbeatTick (the same class of gap for an
// ordinary, non-review worker leg), and round.ts's standby backoff wait AND park-recovery wait
// (both can legitimately run quiet for far longer than any reasonable window — up to
// round.standby.backoffCapSec / envFailure.probeBackoffMaxSec / parkEscalateAfterSec). Those
// heartbeats still matter with the tuple sampling: last_tick_at only advances while a TICK is
// running, and standby/park-recovery wait BETWEEN ticks, so their own heartbeats are still the
// only thing keeping the tuple moving during those specific stretches.
import type { State } from "../state/state.js";

/** #403 (F25), PR #430 gate② round 3 (P2): the watchdog's SCHEDULING seam. Two methods, no clock
 *  reads — the watchdog is purely timer-driven, so this is the whole of its relationship with
 *  time. The handle is opaque (`unknown`): nothing here inspects it, it only travels from
 *  `setTimeout` back to `clearTimeout`.
 *
 *  REQUIRED on ProgressWatchdogOpts, not defaulted to the globals, for the same reason every `now`
 *  in this codebase is required (#403): a defaulted seam means the default path is the untestable
 *  one, and a test that needs to observe the CADENCE silently gets the real timer instead. It also
 *  makes the cadence contract checkable in the units the module documents it in — the delay the
 *  watchdog REQUESTS — rather than only in sample counts, which cannot distinguish
 *  `windowMs/SAMPLES_PER_WINDOW` sampling from a regression to once per full window (both fire
 *  after SAMPLES_PER_WINDOW samples; only the requested delay differs). */
export interface WatchdogTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The production timer: Node's own globals. Every real caller passes this. */
export const systemWatchdogTimer: WatchdogTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ProgressWatchdogOpts {
  /** The scheduling seam — `systemWatchdogTimer` in production. REQUIRED: see WatchdogTimer. */
  timer: WatchdogTimer;
  /** engine.tickIntervalSec * 1000 * liveness.watchdogTickMultiplier — the caller's own cadence
   *  and multiplier, computed once. */
  windowMs: number;
  state: Pick<State, "appendEvent" | "maxEventId" | "lastTickAt">;
  /** `process.exit` in production; tests inject a fake so a deliberately-quiet State doesn't
   *  kill the test runner. */
  exit: (code: number) => void;
  eventPayload: Record<string, unknown>;
  /** #395 item 2: additional CHEAP reads taken at FIRE TIME (never at construction time — the
   *  values below can only be stale by then, and staleness is exactly what a stall record must
   *  not have) to enrich the `engine-stalled` event: the open round's id/phase, active/gated lane
   *  counts, and the last event's id+kind. No new table, no schema change — every field here is
   *  an EXISTING State read (openRound/activeWorkers/drivingWorkers/lastEventKind), the same
   *  ledger `sapwood status`/the dashboard already read. Deliberately a SEPARATE, OPTIONAL pick
   *  from `state` above (which the round-2/3/4 tuple-sampling unit tests already construct as a
   *  minimal fake) — omitting `enrich` costs nothing beyond a slightly thinner stalled event; the
   *  tuple sampling itself never depends on it. Real callers (round.ts/driver.ts) always pass the
   *  full `State`, so production behavior always includes it. */
  enrich?: Pick<State, "openRound" | "activeWorkers" | "drivingWorkers" | "lastEventKind">;
}

export interface ProgressWatchdogHandle {
  /** Stop the recurring timer. Called from the loop's own `finally` — the SAME shutdown path
   *  `unregister()` already uses — so a clean stop (signal, --once, a stop condition) never
   *  leaves a stray timer running past the process's own natural lifetime. */
  stop: () => void;
}

// #395 (gate② round 3, P2): sampling once per FULL window (the round-2 shape) can take almost
// TWO windows to fire — if the last real event lands right after a check arms, that SAME check
// (moments later) still sees the changed id and re-arms for another full window, so up to
// (windowMs - epsilon) + windowMs of genuine silence can elapse before the NEXT check ever
// notices. That contradicts both the stated contract ("fires at the window") and AC1. Fix:
// sample SEVERAL times per window and require several CONSECUTIVE unchanged readings before
// declaring a stall — SAMPLES_PER_WINDOW=4, so sampleMs = windowMs/4 and firing requires 4
// consecutive unchanged samples. Worst case: the last real progress lands just after a sample —
// the NEXT sample (up to 1 sampleMs later) is the first to see "unchanged," and firing needs
// SAMPLES_PER_WINDOW MORE consecutive unchanged samples after that — total detection latency is
// therefore between (SAMPLES_PER_WINDOW-1)*sampleMs and (SAMPLES_PER_WINDOW+1)*sampleMs, i.e.
// roughly windowMs to windowMs*1.25 — between one window and a small fraction over, never
// approaching two.
export const SAMPLES_PER_WINDOW = 4;

/** #395 item 2 (gate② follow-up, P3): run `fn`, returning its value or `undefined` on a throw —
 *  the per-read independence primitive the stall-record enrichment below uses so ONE throwing
 *  read (e.g. openRound() against the very corrupted state this record exists to diagnose)
 *  degrades only its OWN field(s) to `null`, never discards sibling reads that would have
 *  succeeded. */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Start the progress watchdog: re-checks the TUPLE `(state.maxEventId(), state.lastTickAt())`
 *  every `windowMs/SAMPLES_PER_WINDOW` against its own previous reading, firing once
 *  `SAMPLES_PER_WINDOW` CONSECUTIVE samples have seen NEITHER change (see the module-level
 *  comment for why both, and the comment above SAMPLES_PER_WINDOW for the exact arithmetic this
 *  bounds). Firing: append the durable `engine-stalled` event, enriched (item 2) with
 *  `opts.enrich`'s cheap reads taken AT FIRE TIME (open round id/phase, active/gated lane
 *  counts, last event id+kind) alongside `opts.eventPayload`, `lastTickAt`, and `windowMs` —
 *  each enrichment read is independently best-effort (`safe()`, one throwing read degrades only
 *  its own field(s) to `null`, never its siblings), and the append+exit(1) themselves are ALSO
 *  best-effort/never skipped: a failed write, or every enrichment read throwing, still lets the
 *  nonzero exit be the operative signal — then call `exit(1)`. Deliberately does
 *  NOT reschedule after firing — the watchdog fires once and stops itself, whether or not the
 *  exit hook actually terminated the process (production: it always does; tests inject a
 *  non-terminating fake). Never reads the real clock (no `Date.now()`/`new Date()` anywhere
 *  here) — purely timer-driven, so a test drives the stalled branch with a real-but-tiny
 *  `windowMs` against a State nothing else ever touches, which is deterministic since neither
 *  side of the tuple ever moves. */
export function startProgressWatchdog(opts: ProgressWatchdogOpts): ProgressWatchdogHandle {
  const sampleMs = opts.windowMs / SAMPLES_PER_WINDOW;
  let lastSeenId = opts.state.maxEventId();
  let lastSeenTickAt = opts.state.lastTickAt();
  let unchangedSamples = 0;
  let timer: unknown;
  const check = (): void => {
    const currentId = opts.state.maxEventId();
    const currentTickAt = opts.state.lastTickAt();
    if (currentId === lastSeenId && currentTickAt === lastSeenTickAt) {
      unchangedSamples++;
      if (unchangedSamples >= SAMPLES_PER_WINDOW) {
        try {
          // #395 item 2 (gate② follow-up, P3): enrich the stall record with cheap reads taken
          // NOW, at fire time — see ProgressWatchdogOpts.enrich's own doc for why these are a
          // separate optional pick and why "at fire time" matters. PER-READ independence, not a
          // single guard around all four: `safe()` wraps EACH read separately, so one throwing
          // read (openRound() against exactly the corrupted state this record exists to
          // diagnose, say) degrades ONLY its own field(s) to `null` — it must never discard the
          // OTHER reads that would have succeeded. `enrich` being entirely omitted, or every read
          // throwing, degrades to the base payload below (lastTickAt/windowMs still present) —
          // either way, safety here is unaffected: append+exit(1) stay outside this try, so a
          // catastrophic enrichment failure still lets the nonzero exit be the operative signal.
          const round = opts.enrich ? safe(() => opts.enrich!.openRound()) : undefined;
          const active = opts.enrich ? safe(() => opts.enrich!.activeWorkers()) : undefined;
          const driving = opts.enrich ? safe(() => opts.enrich!.drivingWorkers()) : undefined;
          const lastEvent = opts.enrich ? safe(() => opts.enrich!.lastEventKind()) : undefined;
          const enrichment: Record<string, unknown> = opts.enrich
            ? {
                openRoundId: round?.round_id ?? null,
                openRoundPhase: round?.phase ?? null,
                activeLaneCount: active?.length ?? null,
                gatedLaneCount: driving?.length ?? null,
                lastEventId: lastEvent?.id ?? null,
                lastEventKind: lastEvent?.kind ?? null,
              }
            : {};
          opts.state.appendEvent("engine-stalled", {
            ...opts.eventPayload,
            ...enrichment,
            lastTickAt: currentTickAt,
            windowMs: opts.windowMs,
          });
        } catch {
          /* best-effort — the nonzero exit is still the operative signal */
        }
        opts.exit(1);
        return;
      }
    } else {
      lastSeenId = currentId;
      lastSeenTickAt = currentTickAt;
      unchangedSamples = 0;
    }
    timer = opts.timer.setTimeout(check, sampleMs);
  };
  timer = opts.timer.setTimeout(check, sampleMs);
  return { stop: () => opts.timer.clearTimeout(timer) };
}
