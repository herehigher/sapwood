import { useEffect, useReducer, useState } from "react";
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
} from "../replay/player.ts";
import { spendThroughTs } from "../replay/spend-replay.ts";
import type { ReplayView } from "../replay/useReplay.ts";
import { buildRoundLog, type DemoRoundLog } from "./build-round-log.ts";
import type { DemoBundle } from "./types.ts";

/** Same tick cadence `useReplay` uses (player.ts's own doc: speed decides ground per tick, this
 *  decides how often a tick fires) — kept as its own constant here since demo mode never imports
 *  `useReplay` itself (that hook's round loading is a `useState`+`useEffect` async fetch, which
 *  never resolves under this repo's effect-free `renderToStaticMarkup` test harness — the whole
 *  reason `?demo` needs its own synchronous data layer instead of reusing that hook unchanged). */
const TICK_MS = 200;

/** A round's fully-folded end state — `?demo`'s default position, rather than `useReplay`'s usual
 *  "nothing folded yet, press play" start. Two reasons: (1) a showcase visitor should see the
 *  finished picture the instant the page loads, never a blank stage waiting for input; (2) it is
 *  what makes the fixture's own data observable on the very FIRST synchronous render — this repo's
 *  test harness never runs effects (`renderToStaticMarkup`, no jsdom), so anything that only
 *  appeared after a playback tick would be untestable at the `App` level. Reuses `scrubTo` (the
 *  SAME checkpointed O(distance) fold `player.ts` already exposes), not a new fold path. */
export function endPosition(log: DemoRoundLog | null, lanesMax: number | null): ReplayPosition | null {
  if (!log) return null;
  if (log.events.length === 0) return initialReplayPosition(lanesMax);
  const lastId = log.events[log.events.length - 1]!.id;
  return scrubTo(log.events, log.checkpoints, lastId, lanesMax);
}

/**
 * `?demo`'s replay data layer (#742) — same `ReplayView` shape `App.tsx` already wires `Transport`
 * / the shared reducer against, but sourced from an in-memory `DemoBundle` instead of `/api/*`
 * paging: every round's log is a synchronous `buildRoundLog` filter (no network, so no loading
 * window ever exists), and `useState`'s lazy initializer computes the FIRST round's log and
 * position during the initial render itself — never inside a `useEffect` — so a settled
 * `demoFixtureQuery()` cache (the same synchronous-read trick `App.test.tsx`'s `renderSettledApp`
 * already uses for the four live queries) renders real fixture content on the very first pass,
 * with no effect needing to fire first.
 */
export function useDemoReplay(bundle: DemoBundle | undefined, lanesMax: number | null): ReplayView {
  const [selectedRoundId, setSelectedRoundId] = useState<number | null>(() => bundle?.rounds[0]?.roundId ?? null);
  const [transport, dispatch] = useReducer(transportReducer, INITIAL_TRANSPORT_STATE);

  const round = bundle?.rounds.find((r) => r.roundId === selectedRoundId) ?? null;
  const log: DemoRoundLog | null = round && bundle ? buildRoundLog(bundle, round, lanesMax) : null;

  const [position, setPosition] = useState<ReplayPosition | null>(() => endPosition(log, lanesMax));

  // Bundle arriving after mount (a real browser's `/demo-fixture.json` fetch, not yet settled on
  // the very first render) — select its first round once it does. A no-op once a round is already
  // selected, or in the test harness where the bundle is already present at mount (this effect
  // never needs to fire there — see the module doc).
  useEffect(() => {
    if (bundle && selectedRoundId === null) setSelectedRoundId(bundle.rounds[0]?.roundId ?? null);
  }, [bundle, selectedRoundId]);

  // A different round selected (or the first one arriving post-mount, via the effect above) resets
  // the fold position to THAT round's end state — same default as the lazy initializer above, so a
  // real browser never flashes from "fully played" to "nothing folded" right after mount. Unlike
  // live `useReplay`, there is no LOADING window to represent in between: the whole bundle is
  // already in memory, so this is a synchronous recompute, never an async fetch.
  // `round?.roundId` (a primitive) is the intentional trigger, not the `round`/`log` objects
  // themselves — `log` is recomputed from `round` every render, so listing it would refire this
  // effect on every render, not just an actual round change (same reasoning `useReplay.ts`'s own
  // `loadAttempt` biome-ignore documents).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above.
  useEffect(() => {
    setPosition(endPosition(log, lanesMax));
    dispatch({ type: "pause" });
  }, [round?.roundId, lanesMax]);

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

  const scrub = (eventId: number) => {
    if (!log) return;
    dispatch({ type: "scrub" });
    setPosition(scrubTo(log.events, log.checkpoints, eventId, lanesMax));
  };

  // Pressing play from the end restarts from the beginning (the common media-player convention) —
  // any other position simply resumes forward from where it stands.
  const play = () => {
    if (log && position && isAtEnd(position, log.events)) setPosition(initialReplayPosition(lanesMax));
    dispatch({ type: "play" });
  };

  const spendThroughCursor = log && position ? spendThroughTs(log.spend, cursorTs(position, log.events, log.round.startedAt)) : [];

  return {
    mode: selectedRoundId === null ? "live" : "replay",
    selectedRoundId,
    selectRound: setSelectedRoundId,
    loading: false,
    loadError: null,
    retryLoad: () => {},
    position,
    playing: transport.playing,
    speed: transport.speed,
    play,
    pause: () => dispatch({ type: "pause" }),
    setSpeed: (speed: PlaySpeed) => dispatch({ type: "setSpeed", speed }),
    scrub,
    spendThroughCursor,
    phaseWindows: log?.phaseWindows ?? [],
    // #868 gate② finding [1]: `buildRoundLog`'s own `events` slice is already round-scoped and
    // uncapped (`demo/build-round-log.ts`'s own doc) — the phase inspector's event-derived counts
    // read this directly, same as live `useReplay`'s `roundEvents`.
    roundEvents: log?.events ?? [],
    // #880: same "never cursor-truncated" posture as live `useReplay`'s own `roundSpend` — see
    // that field's doc for why the ROUND N cost panel needs the round's FULL spend, not
    // `spendThroughCursor`.
    roundSpend: log?.spend ?? [],
  };
}
