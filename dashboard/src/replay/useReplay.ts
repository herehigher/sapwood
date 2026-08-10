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

  // The playback frame loop — ticks only while playing; each tick folds one incremental slice
  // via `advanceFrame` (never `foldToPosition`, AC2), auto-pausing at the round's end.
  useEffect(() => {
    if (!transport.playing || !log) return;
    const id = setInterval(() => {
      setPosition((prev) => {
        if (!prev) return prev;
        if (isAtEnd(prev, log.events)) {
          dispatch({ type: "ended" });
          return prev;
        }
        return advanceFrame(prev, log.events, transport.speed);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [transport.playing, transport.speed, log]);

  const selectRound = (roundId: number | null) => {
    dispatch({ type: "pause" });
    setSelectedRoundId(roundId);
  };

  const scrub = (eventId: number) => {
    if (!log) return;
    dispatch({ type: "scrub" });
    setPosition(scrubTo(log.events, log.checkpoints, eventId, lanesMax));
  };

  const spendThroughCursor = log && position ? spendThroughTs(log.spend, cursorTs(position, log.events, log.round.startedAt)) : [];

  return {
    mode: selectedRoundId === null ? "live" : "replay",
    selectedRoundId,
    selectRound,
    loading,
    position,
    playing: transport.playing,
    speed: transport.speed,
    play: () => dispatch({ type: "play" }),
    pause: () => dispatch({ type: "pause" }),
    setSpeed: (speed: PlaySpeed) => dispatch({ type: "setSpeed", speed }),
    scrub,
    spendThroughCursor,
    phaseWindows: log?.phaseWindows ?? [],
  };
}
