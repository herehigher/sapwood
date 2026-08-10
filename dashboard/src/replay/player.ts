/**
 * The replay transport's fold layer (issue #741, split 2/4 of #146) — sits directly on #740's
 * `foldReplay`/`foldToPosition` and draws the ONE line the acceptance criteria care about:
 * a **scrub** (or a chapter jump) is a checkpointed `foldToPosition` bisection; a **playback
 * frame** is a direct `foldReplay(current, sliceSinceLastFrame)` onto the state already held.
 * Mixing them — calling `foldToPosition` once per frame — is the sawtooth/quadratic cost the
 * issue explicitly bans, so this file keeps the two paths as two different functions rather than
 * one "advance to id" call that could accidentally route through the checkpoint bisector every
 * tick.
 */

import type { DomainEvent } from "../domain-event.ts";
import { bisectAfter, type Checkpoint, foldToPosition } from "./checkpoint.ts";
import { foldReplay, initialReplayState, type ReplayState } from "./reducer.ts";

export type PlaySpeed = 1 | 4 | 16;
export const PLAY_SPEEDS: readonly PlaySpeed[] = [1, 4, 16];

/** Events folded per playback tick at ×1 — ×4/×16 scale this directly (§6: playback speed is
 *  ground covered per tick, not simulated wall-clock replay of real event gaps, which could be
 *  hours between two consecutive events). */
export const BASE_EVENTS_PER_TICK = 2;

export interface ReplayPosition {
  state: ReplayState;
  /** The last folded event's id, 0 before anything has folded — what the scrub bar and
   *  "event n/N" label read. */
  cursorId: number;
  /** Count of events folded so far — an index into the round's `sortedEvents`, kept alongside
   *  `cursorId` so `advanceFrame` can slice by index (O(1) amortized) instead of re-searching
   *  for `cursorId`'s position on every tick. */
  cursorIndex: number;
}

export function initialReplayPosition(lanesMax: number | null): ReplayPosition {
  return { state: initialReplayState(lanesMax), cursorId: 0, cursorIndex: 0 };
}

/**
 * Scrub (or jump to a chapter mark) directly to `targetId` — #740's checkpointed O(distance)
 * `foldToPosition`, never a per-event walk from the start. `fold` is the same test seam
 * `foldToPosition` already exposes, threaded through so a caller can spy at THIS layer (the
 * integration point the transport actually calls) rather than only at `checkpoint.ts` itself —
 * AC1's "reuse #740's spy-based proof at the integration layer".
 */
export function scrubTo(
  sortedEvents: readonly DomainEvent[],
  checkpoints: readonly Checkpoint[],
  targetId: number,
  lanesMax: number | null,
  fold: typeof foldReplay = foldReplay,
): ReplayPosition {
  const state = foldToPosition(sortedEvents, checkpoints, targetId, lanesMax, fold);
  return { state, cursorId: targetId, cursorIndex: bisectAfter(sortedEvents, targetId) };
}

/**
 * Advance ONE playback frame from `current`. Folds only the slice of events since the last
 * frame — `BASE_EVENTS_PER_TICK * speed` of them, starting at `current.cursorIndex` — directly
 * onto the state already held, via ONE `foldReplay` call. Never touches `foldToPosition`/checkpoint
 * bisection: AC2 bans re-deriving the fold position from scratch (or from the nearest checkpoint)
 * every tick, which is exactly the sawtooth a per-frame `foldToPosition` call would produce,
 * worst at ×16. Returns `current` unchanged once the round's log is exhausted — the caller reads
 * `isAtEnd` to know when to stop ticking (auto-pause at the round boundary).
 */
export function advanceFrame(
  current: ReplayPosition,
  sortedEvents: readonly DomainEvent[],
  speed: PlaySpeed,
  fold: typeof foldReplay = foldReplay,
): ReplayPosition {
  if (current.cursorIndex >= sortedEvents.length) return current;
  const count = BASE_EVENTS_PER_TICK * speed;
  const slice = sortedEvents.slice(current.cursorIndex, current.cursorIndex + count);
  if (slice.length === 0) return current;
  const { state } = fold(current.state, slice);
  return { state, cursorId: slice[slice.length - 1]!.id, cursorIndex: current.cursorIndex + slice.length };
}

/** True once every event in the round's log has been folded — the transport auto-pauses here
 *  rather than ticking forever past the end. */
export function isAtEnd(current: ReplayPosition, sortedEvents: readonly DomainEvent[]): boolean {
  return current.cursorIndex >= sortedEvents.length;
}

/** The replay cursor's own timestamp — the last folded event's `ts`, or `fallbackTs` (the round's
 *  `startedAt`) before anything has folded yet. `spend-replay.ts`'s `spendThroughTs` keys by this,
 *  not by `cursorId` — spend rows have no `events.id` of their own to compare against. */
export function cursorTs(current: ReplayPosition, sortedEvents: readonly DomainEvent[], fallbackTs: string): string {
  if (current.cursorIndex <= 0) return fallbackTs;
  return sortedEvents[current.cursorIndex - 1]?.ts ?? fallbackTs;
}

export interface TransportState {
  playing: boolean;
  speed: PlaySpeed;
}

export type TransportAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "setSpeed"; speed: PlaySpeed }
  | { type: "scrub" }
  | { type: "ended" };

export const INITIAL_TRANSPORT_STATE: TransportState = { playing: false, speed: 1 };

/**
 * The transport UI's own play/pause/speed state — deliberately separate from `ReplayPosition`
 * (the fold state), same split `Controls.tsx`'s `controlsReducer` draws between "what the UI
 * intends" and "what actually happened on the wire". `scrub` pauses playback (grabbing the bar
 * mid-play stops the frame loop, matching every other media transport); `ended` (the log ran
 * out) also pauses rather than looping.
 */
export function transportReducer(state: TransportState, action: TransportAction): TransportState {
  switch (action.type) {
    case "play":
      return { ...state, playing: true };
    case "pause":
    case "scrub":
    case "ended":
      return { ...state, playing: false };
    case "setSpeed":
      return { ...state, speed: action.speed };
    default:
      return state;
  }
}
