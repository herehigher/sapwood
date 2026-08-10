/**
 * The shared state-folding reducer — frontend-design.md §9 "one state reducer" /
 * §11's replay-boundary rule ("events → Yes, the replay stream itself"). Split from #146
 * (issue #740): the foundation piece so every replayable panel (hero, lane narrative, activity
 * feed, ring counts, header/needs-attention) folds through ONE function, live and replay alike.
 *
 * This is deliberately a COMPOSITION of the fold primitives that already existed and were already
 * independently pure/id-idempotent — `hero/state.ts`'s `foldEvents` (lanes, droplets, rings,
 * ceiling state) and `entities.ts`'s `foldEntityTitles`/`foldOpenAttention` (titles, open
 * attention) — PLUS the activity feed's own bounded recent-event window, which #740 gate①
 * finding [1] flagged as still living outside this state: a window computed only in
 * `queries.ts`'s own accumulator could never be reconstructed by `checkpoint.ts`'s
 * `foldToPosition`, so replay could not have driven the feed even once the transport lands.
 * Before this module, live mode ran hero/titles/openAttention from two separate call sites
 * (`Hero.tsx`'s own effect, and `queries.ts`'s `accumulateEventsPage`) — two parallel folds over
 * the same event stream. `foldReplay` is the one function both a live accumulator and a future
 * replay/scrub path call, so "shared" is a code-reference fact (`queries.ts` and this module's
 * own checkpoint helpers are the only callers), not just matching behavior.
 */

import type { DomainEvent } from "../domain-event.ts";
import { type EntityTitles, foldEntityTitles, foldOpenAttention, type OpenAttention } from "../entities.ts";
import { type FoldStep, foldEvents, type HeroState, initialHeroState, type Transition } from "../hero/state.ts";

export type { FoldStep, Transition };

/** The bounded recent-event window's default cap, shared by live accumulation and replay/scrub —
 *  ONE number, so a checkpoint's `events` slice and the live feed's display tail agree on what
 *  "recent" means. `queries.ts`'s public `MAX_EVENT_HISTORY` re-exports this exact value. */
export const DEFAULT_EVENT_WINDOW = 2000;

/** The combined fold output every replayable panel reads from. */
export interface ReplayState {
  hero: HeroState;
  titles: EntityTitles;
  openAttention: OpenAttention;
  /** Bounded recent window — ActivityFeed's own display tail (further capped for rendering by
   *  `FEED_RENDER_CAP`, unrelated to this bound). Unlike `titles`/`openAttention`, this one IS
   *  meant to be bounded (§9: "routine display", not a durable fold) — capped at `maxHistory`
   *  (`foldReplay`'s own param), oldest dropped first, so both live polling and a replay
   *  checkpoint at any cursor produce the SAME "last N events up to here" the feed renders. */
  events: DomainEvent[];
}

export interface ReplayFold {
  state: ReplayState;
  /** This call's own transitions/steps (hero's animation input) — never accumulated across
   *  calls, same contract `hero/state.ts`'s `foldEvents` already documents. */
  transitions: Transition[];
  steps: FoldStep[];
}

export function initialReplayState(lanesMax: number | null): ReplayState {
  return { hero: initialHeroState(lanesMax), titles: {}, openAttention: {}, events: [] };
}

/**
 * Fold a batch of events onto `state`. `events` must be events this state has not folded yet
 * (the caller's dedup boundary — `queries.ts`'s `accumulateEventsPage` for live mode,
 * `checkpoint.ts`'s id-range slice for replay) — same "fresh only" contract `foldEvents` and the
 * entity folds already carried separately; this is not a new requirement, just a shared one now.
 * `maxHistory` bounds `state.events` (oldest dropped first) — same semantics `queries.ts`'s
 * pre-#740-gate① `accumulateEventsPage` applied itself, moved here so `checkpoint.ts` produces
 * the identical bounded window at any fold-to-position cursor.
 */
export function foldReplay(state: ReplayState, events: readonly DomainEvent[], maxHistory = DEFAULT_EVENT_WINDOW): ReplayFold {
  const { state: hero, transitions, steps } = foldEvents(state.hero, events as DomainEvent[]);
  const titles = foldEntityTitles(events, state.titles);
  const openAttention = foldOpenAttention(events, state.openAttention);
  const combinedEvents = events.length === 0 ? state.events : [...state.events, ...events].slice(-maxHistory);
  return { state: { hero, titles, openAttention, events: combinedEvents }, transitions, steps };
}
