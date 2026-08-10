import { useEffect, useReducer, useRef, useState } from "react";
import { fetchEvents, fetchSpend } from "../api/client.ts";
import type { Round, SpendRow } from "../api/types.ts";
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
  const [transport, dispatch] = useReducer(transportReducer, INITIAL_TRANSPORT_STATE);

  // `rounds` keeps polling every 3 s (`useRounds`) while a round is selected — a ref, read only at
  // load time, keeps the load effect below keyed on `selectedRoundId` alone, rather than reloading
  // the whole round's log on every unrelated poll tick.
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;

  // Load the round's full log once, whenever the selected round changes.
  useEffect(() => {
    if (selectedRoundId === null) {
      setLog(null);
      setPosition(null);
      return;
    }
    const round = roundsRef.current.find((r) => r.roundId === selectedRoundId);
    if (!round) return;
    let cancelled = false;
    setLoading(true);
    const ceilingId = roundEventCeiling(round, roundsRef.current);
    const nextRound = roundsRef.current.filter((r) => r.roundId > round.roundId).sort((a, b) => a.roundId - b.roundId)[0];
    const spendCeilingId = nextRound ? nextRound.startSpendId : null;
    Promise.all([
      loadRoundEvents(round, ceilingId, (after, limit) => fetchEvents({ after, limit })),
      loadRoundSpend(round, spendCeilingId, (after, limit) => fetchSpend({ after, limit })),
    ]).then(([events, spend]) => {
      if (cancelled) return;
      setLog({ round, events, checkpoints: buildCheckpoints(events, lanesMax), spend, phaseWindows: buildPhaseWindows(events) });
      setPosition(initialReplayPosition(lanesMax));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRoundId, lanesMax]);

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
    position: activePosition,
    playing: transport.playing,
    speed: transport.speed,
    play: () => dispatch({ type: "play" }),
    pause: () => dispatch({ type: "pause" }),
    setSpeed: (speed: PlaySpeed) => dispatch({ type: "setSpeed", speed }),
    scrub,
    spendThroughCursor,
    phaseWindows: activeLog?.phaseWindows ?? [],
  };
}
