/**
 * Periodic checkpoints over `foldReplay` (issue #740) — what makes scrubbing to an arbitrary
 * position O(distance-from-nearest-checkpoint) instead of a full refold from event 0. A snapshot
 * is taken every `CHECKPOINT_INTERVAL` events actually folded (not every `interval` id values —
 * ids can skip), so checkpoint COUNT is exact against a dense synthetic log, which is what the
 * cadence acceptance criterion checks.
 */

import type { DomainEvent } from "../domain-event.ts";
import { foldReplay, initialReplayState, type ReplayState } from "./reducer.ts";

export const CHECKPOINT_INTERVAL = 500;

export interface Checkpoint {
  /** The id of the last event folded into `state` — the position this checkpoint stands at. */
  atId: number;
  state: ReplayState;
}

/** First index whose id is > `id` — the standard "insertion point after all id<=id entries"
 *  bisect, used both to locate the checkpoint boundary and to slice `sortedEvents` in O(log n). */
function bisectAfter(sortedEvents: readonly DomainEvent[], id: number): number {
  let lo = 0;
  let hi = sortedEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedEvents[mid]!.id <= id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fold the full log into checkpoints, one every `interval` events. A trailing partial batch
 * (fewer than `interval` events left) gets no checkpoint of its own — `foldToPosition` folds the
 * remainder live from the last real checkpoint, same as scrubbing to any other uncheckpointed id.
 * `events` need not be pre-sorted; this sorts once, up front.
 */
export function buildCheckpoints(events: readonly DomainEvent[], lanesMax: number | null, interval = CHECKPOINT_INTERVAL): Checkpoint[] {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const checkpoints: Checkpoint[] = [];
  let state = initialReplayState(lanesMax);
  for (let start = 0; start + interval <= ordered.length; start += interval) {
    const batch = ordered.slice(start, start + interval);
    state = foldReplay(state, batch).state;
    checkpoints.push({ atId: batch[batch.length - 1]!.id, state });
  }
  return checkpoints;
}

/**
 * Fold to `targetId`, starting from the nearest checkpoint at or before it rather than from
 * event 0 — the O(distance) scrub the acceptance criteria ask for. `sortedEvents` must be sorted
 * ascending by id (the caller's full replay log — `buildCheckpoints`' own input, kept sorted once
 * rather than re-sorted on every scrub call). `checkpoints` must be sorted ascending by `atId`
 * (`buildCheckpoints`' own output order).
 *
 * `fold` defaults to `foldReplay` and exists ONLY as a test seam — production callers never pass
 * it — so a test can wrap it with a call-count/event-count spy and prove this genuinely folds
 * from the checkpoint, not from event 0, without fragile module-mocking.
 */
export function foldToPosition(
  sortedEvents: readonly DomainEvent[],
  checkpoints: readonly Checkpoint[],
  targetId: number,
  lanesMax: number | null,
  fold: typeof foldReplay = foldReplay,
): ReplayState {
  let base = initialReplayState(lanesMax);
  let fromId = 0;
  let lo = 0;
  let hi = checkpoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (checkpoints[mid]!.atId <= targetId) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    base = checkpoints[lo - 1]!.state;
    fromId = checkpoints[lo - 1]!.atId;
  }

  const startIdx = bisectAfter(sortedEvents, fromId);
  const endIdx = bisectAfter(sortedEvents, targetId);
  const slice = sortedEvents.slice(startIdx, endIdx);
  return fold(base, slice).state;
}
