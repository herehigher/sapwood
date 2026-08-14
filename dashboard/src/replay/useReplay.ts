import { useEffect, useReducer, useRef, useState } from "react";
import { fetchEvents, fetchSpend } from "../api/client.ts";
import type { EventsPage, Round, SpendPage, SpendRow } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";
import { buildCheckpoints, type Checkpoint } from "./checkpoint.ts";
import {
  advanceFrame,
  cursorTs,
  INITIAL_TRANSPORT_STATE,
  initialReplayPosition,
  isAtEnd,
  type PlaySpeed,
  type ReplayPosition,
  scrubTo,
  transportReducer,
} from "./player.ts";
import { loadRoundEvents, loadRoundSpend, roundEventCeiling } from "./round-log.ts";
import { buildPhaseWindows, type PhaseWindow, spendThroughTs } from "./spend-replay.ts";

/** Wall-clock ms per playback frame — `player.ts`'s `advanceFrame` decides how much GROUND each
 *  frame covers (`BASE_EVENTS_PER_TICK * speed`); this decides how OFTEN a frame fires. */
const TICK_MS = 200;

interface RoundLog {
  round: Round;
  events: DomainEvent[];
  checkpoints: Checkpoint[];
  spend: SpendRow[];
  phaseWindows: PhaseWindow[];
}

export type RoundLogResult = { ok: true; log: RoundLog } | { ok: false; error: unknown };

/**
 * #766 gate② finding [3] (round-log-load-rejection-sticks): the actual `Promise.all([...]).then`
 * composition, factored out of the effect below the same way `Controls.tsx`'s `runControlEffect`
 * factors its own network call out of a `useEffect` — this repo's test harness has no jsdom, so a
 * promise this repo actually awaits inside an effect is only directly testable once it's a plain
 * function the effect calls, not inline `.then`/`.catch` logic a test can't reach. NEVER rejects
 * itself: a rejected `fetchEvents`/`fetchSpend` page resolves to `{ ok: false, error }` rather than
 * propagating, so the caller's effect never needs its own top-level `.catch` to avoid an unhandled
 * rejection (same "never rejects itself" contract `runControlEffect` documents for the same reason).
 */
export async function loadRoundLog(
  round: Round,
  ceilingId: number | null,
  spendCeilingId: number | null,
  lanesMax: number | null,
  fetchEventsPage: (after: number, limit: number) => Promise<EventsPage> = (after, limit) => fetchEvents({ after, limit }),
  fetchSpendPage: (after: number, limit: number) => Promise<SpendPage> = (after, limit) => fetchSpend({ after, limit }),
): Promise<RoundLogResult> {
  try {
    const [events, spend] = await Promise.all([
      loadRoundEvents(round, ceilingId, fetchEventsPage),
      loadRoundSpend(round, spendCeilingId, fetchSpendPage),
    ]);
    return {
      ok: true,
      log: { round, events, checkpoints: buildCheckpoints(events, lanesMax), spend, phaseWindows: buildPhaseWindows(events) },
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * #766 gate② finding [0] (round-switch-retains-old-replay): switching directly from a loaded
 * round A to round B changes `selectedRoundId` synchronously, but the async `Promise.all` load
 * for B's log only RESOLVES later — during that window the effect's own `setLog`/`setPosition`
 * calls haven't fired yet, so `log` (React state) still holds round A's fully-loaded data. Every
 * caller reading `log` directly during that window would show round A's hero/feed/spend under a
 * navigator/transport already marking round B selected. Rather than relying on effect-timing to
 * clear the old state (racy — the effect can't synchronously invalidate state a PRIOR render already
 * committed), this derives validity structurally: a log whose OWN round doesn't match the CURRENT
 * selection is treated as absent by every reader, on every render, regardless of when the effect
 * gets around to clearing it. Exported and pure so the "still on round A" window is directly
 * testable without mounting the hook or racing a real fetch.
 */
export function resolveActiveLog<T extends { round: { roundId: number } }>(log: T | null, selectedRoundId: number | null): T | null {
  return log && log.round.roundId === selectedRoundId ? log : null;
}

export interface ReplayView {
  mode: "live" | "replay";
  selectedRoundId: number | null;
  selectRound: (roundId: number | null) => void;
  loading: boolean;
  /** #766 gate② finding [3] (round-log-load-rejection-sticks): set when the selected round's
   *  `/api/events`/`/api/spend` load rejected — `loading` is ALWAYS cleared on this terminal path
   *  too (never left permanently `true`), so a UI reading `loading` alone can't get stuck
   *  claiming "still loading" forever. `null` once nothing has failed for the CURRENT selection. */
  loadError: unknown;
  /** Re-runs the load for the currently selected round — the only way to recover from `loadError`,
   *  since re-selecting the SAME round id is a no-op for the effect's own dependency array. */
  retryLoad: () => void;
  position: ReplayPosition | null;
  playing: boolean;
  speed: PlaySpeed;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: PlaySpeed) => void;
  scrub: (eventId: number) => void;
  /** Spend rows through the current cursor, timestamp-mapped (§8) — empty outside replay. */
  spendThroughCursor: SpendRow[];
  phaseWindows: PhaseWindow[];
  /** #868 gate② finding [1]: the selected round's OWN full event log — loaded once by
   *  `loadRoundLog`/`loadRoundEvents` and never capped by any display window (unlike
   *  `position.state.events`, `foldReplay`'s bounded tail). The phase inspector's round-scoped
   *  Arch review/Verify counts read this rather than the folded tail, so a round longer than the
   *  live display window's cap is never undercounted in replay either. Empty outside replay, and
   *  during the selected round's own loading window (`activeLog` is `null` until it resolves). */
  roundEvents: DomainEvent[];
  /** #880: the selected round's OWN full spend log — same "never capped" posture as `roundEvents`,
   *  but UNLIKE `spendThroughCursor` also never truncated by the scrub cursor. The "COST · ROUND
   *  N" panel is a closed round's frozen summary (`cost-dark.png`), not a live-scrubbing view —
   *  its by-stage/by-model bars must read the round's FINAL total regardless of where the
   *  transport's cursor currently sits, or scrubbing backward would visibly shrink a panel
   *  labeled "CLOSED" while its footer stats (sourced from the round's persisted artifact) stayed
   *  fixed. Empty outside replay, same as `roundEvents`. */
  roundSpend: SpendRow[];
}

/**
 * Owns the whole replay side of the transport: round selection, the one-time full-log load for
 * that round (`round-log.ts`), and the play/pause/speed/scrub position (`player.ts`). `App.tsx`
 * reads `mode` to decide whether to render live (`useEventHistory`) or replay (`position.state`)
 * props into Hero/LaneBoard/ActivityFeed/CostStrip — §9's "one reducer, live and replay both feed
 * it", this hook is replay's half.
 */
export function useReplay(rounds: Round[], lanesMax: number | null): ReplayView {
  const [selectedRoundId, setSelectedRoundId] = useState<number | null>(null);
  const [log, setLog] = useState<RoundLog | null>(null);
  const [position, setPosition] = useState<ReplayPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  // #766 gate② finding [3]: bumped by `retryLoad` to force the load effect below to re-run for
  // the SAME `selectedRoundId` — re-selecting an already-selected round is a no-op for that
  // effect's dependency array otherwise, so a failed load would have no way to retry at all.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [transport, dispatch] = useReducer(transportReducer, INITIAL_TRANSPORT_STATE);

  // `rounds` keeps polling every 3 s (`useRounds`) while a round is selected — a ref, read only at
  // load time, keeps the load effect below keyed on `selectedRoundId` alone, rather than reloading
  // the whole round's log on every unrelated poll tick.
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;

  // Load the round's full log once, whenever the selected round changes (or a retry is requested).
  // `loadAttempt` (in the dependency array below) is never read inside this effect — its only job
  // is forcing a re-run for the SAME `selectedRoundId` after `retryLoad()` bumps it, since
  // re-selecting an already-selected round is otherwise a no-op for this dependency array (#766
  // gate② finding [3]).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loadAttempt` is trigger-only, never read in the effect body — see the comment above.
  useEffect(() => {
    if (selectedRoundId === null) {
      setLog(null);
      setPosition(null);
      setLoadError(null);
      return;
    }
    const round = roundsRef.current.find((r) => r.roundId === selectedRoundId);
    if (!round) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const ceilingId = roundEventCeiling(round, roundsRef.current);
    const nextRound = roundsRef.current.filter((r) => r.roundId > round.roundId).sort((a, b) => a.roundId - b.roundId)[0];
    const spendCeilingId = nextRound ? nextRound.startSpendId : null;
    // #766 gate② finding [3]: `loadRoundLog` never rejects itself (a failed fetch resolves to
    // `{ok: false, error}`), so there is no unhandled-rejection path here to miss — every
    // terminal outcome, success or failure, reaches exactly one of these two branches and always
    // clears `loading`.
    loadRoundLog(round, ceilingId, spendCeilingId, lanesMax).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLog(result.log);
        setPosition(initialReplayPosition(lanesMax));
        setLoading(false);
      } else {
        setLoading(false);
        setLoadError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRoundId, lanesMax, loadAttempt]);

  // #766 gate② finding [0]: every reader below goes through `activeLog` — a `log` whose OWN round
  // no longer matches `selectedRoundId` (the async load for a NEWLY selected round hasn't resolved
  // yet) reads as absent, synchronously, on this very render — never round A's data rendered under
  // round B's selection.
  const activeLog = resolveActiveLog(log, selectedRoundId);
  const activePosition = activeLog ? position : null;

  // The playback frame loop — ticks only while playing; each tick folds one incremental slice
  // via `advanceFrame` (never `foldToPosition`, AC2), auto-pausing at the round's end.
  useEffect(() => {
    if (!transport.playing || !activeLog) return;
    const id = setInterval(() => {
      setPosition((prev) => {
        if (!prev) return prev;
        if (isAtEnd(prev, activeLog.events)) {
          dispatch({ type: "ended" });
          return prev;
        }
        return advanceFrame(prev, activeLog.events, transport.speed);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [transport.playing, transport.speed, activeLog]);

  const selectRound = (roundId: number | null) => {
    dispatch({ type: "pause" });
    setSelectedRoundId(roundId);
  };

  const retryLoad = () => setLoadAttempt((n) => n + 1);

  const scrub = (eventId: number) => {
    if (!activeLog) return;
    dispatch({ type: "scrub" });
    setPosition(scrubTo(activeLog.events, activeLog.checkpoints, eventId, lanesMax));
  };

  const spendThroughCursor =
    activeLog && activePosition
      ? spendThroughTs(activeLog.spend, cursorTs(activePosition, activeLog.events, activeLog.round.startedAt))
      : [];

  return {
    mode: selectedRoundId === null ? "live" : "replay",
    selectedRoundId,
    selectRound,
    loading,
    loadError,
    retryLoad,
    position: activePosition,
    playing: transport.playing,
    speed: transport.speed,
    play: () => dispatch({ type: "play" }),
    pause: () => dispatch({ type: "pause" }),
    setSpeed: (speed: PlaySpeed) => dispatch({ type: "setSpeed", speed }),
    scrub,
    spendThroughCursor,
    phaseWindows: activeLog?.phaseWindows ?? [],
    roundEvents: activeLog?.events ?? [],
    roundSpend: activeLog?.spend ?? [],
  };
}
