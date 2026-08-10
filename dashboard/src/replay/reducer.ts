/**
 * The shared state-folding reducer — frontend-design.md §9 "one state reducer" /
 * §11's replay-boundary rule ("events → Yes, the replay stream itself"). Split from #146
 * (issue #740): the foundation piece so every replayable panel (hero, lane narrative, activity
 * feed, ring counts, header/needs-attention) folds through ONE function, live and replay alike.
 *
 * This is deliberately a COMPOSITION of the three fold primitives that already existed and were
 * already independently pure/id-idempotent — `hero/state.ts`'s `foldEvents` (lanes, droplets,
 * rings, ceiling state) and `entities.ts`'s `foldEntityTitles`/`foldOpenAttention` (titles, open
 * attention). Before this module, live mode ran them from two separate call sites (`Hero.tsx`'s
 * own effect, and `queries.ts`'s `accumulateEventsPage`) — two parallel folds over the same event
 * stream. `foldReplay` is the one function both a live accumulator and a future replay/scrub path
 * call, so "shared" is a code-reference fact (`queries.ts` and this module's own checkpoint
 * helpers are the only callers), not just matching behavior.
 */

import type { DomainEvent } from "../domain-event.ts";
import { type EntityTitles, foldEntityTitles, foldOpenAttention, type OpenAttention } from "../entities.ts";
import { type FoldStep, foldEvents, type HeroState, initialHeroState, type Transition } from "../hero/state.ts";

export type { FoldStep, Transition };

/** The combined fold output every replayable panel reads from. */
export interface ReplayState {
  hero: HeroState;
  titles: EntityTitles;
  openAttention: OpenAttention;
}

export interface ReplayFold {
  state: ReplayState;
  /** This call's own transitions/steps (hero's animation input) — never accumulated across
   *  calls, same contract `hero/state.ts`'s `foldEvents` already documents. */
  transitions: Transition[];
  steps: FoldStep[];
}

export function initialReplayState(lanesMax: number | null): ReplayState {
  return { hero: initialHeroState(lanesMax), titles: {}, openAttention: {} };
}

/**
 * Fold a batch of events onto `state`. `events` must be events this state has not folded yet
 * (the caller's dedup boundary — `queries.ts`'s `accumulateEventsPage` for live mode,
 * `checkpoint.ts`'s id-range slice for replay) — same "fresh only" contract `foldEvents` and the
 * entity folds already carried separately; this is not a new requirement, just a shared one now.
 */
export function foldReplay(state: ReplayState, events: readonly DomainEvent[]): ReplayFold {
  const { state: hero, transitions, steps } = foldEvents(state.hero, events as DomainEvent[]);
  const titles = foldEntityTitles(events, state.titles);
  const openAttention = foldOpenAttention(events, state.openAttention);
  return { state: { hero, titles, openAttention }, transitions, steps };
}
