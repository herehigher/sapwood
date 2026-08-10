import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { DemoBundle } from "../demo/types.ts";
import { type DomainEvent, toDomainEvent } from "../domain-event.ts";
import type { EntityTitles, OpenAttention } from "../entities.ts";
import { type FoldStep, type HeroState, withLaneCount } from "../hero/state.ts";
import { DEFAULT_EVENT_WINDOW, foldReplay, initialReplayState } from "../replay/reducer.ts";
import { fetchDemoFixture, fetchEvents, fetchLoopState, fetchRounds, fetchSpend } from "./client.ts";
import type { EventsPage, LoopState, RoundsPage, SpendPage, SpendRow } from "./types.ts";

/** §2 Transport: HTTP polling at 3 s. No WebSocket — that row is the acceptance bar. */
export const POLL_MS = 3000;

/** Feed page size. The server caps `limit`; this is just the tail we ask for per poll. */
export const EVENTS_PAGE = 200;

/** Bounds a long-running dashboard tab's memory — the feed only ever renders a bounded recent
 *  window anyway, so the oldest entries are dropped once history exceeds this. #740 gate①: this
 *  now re-exports `replay/reducer.ts`'s own `DEFAULT_EVENT_WINDOW` (ONE bound, not two numbers
 *  that happen to agree) — `foldReplay` is what actually enforces the cap on `EventHistory.events`
 *  now, so `checkpoint.ts`'s replay/scrub path caps its own `events` slice identically. */
export const MAX_EVENT_HISTORY = DEFAULT_EVENT_WINDOW;

/** Spend page size / history cap — same paging contract as events (§8), but the ledger writes far
 *  less often than the event feed, so a smaller cap easily covers a full day. */
export const SPEND_PAGE = 200;
export const MAX_SPEND_HISTORY = 5000;

export const loopStateQuery = () => ({
  queryKey: ["loop", "state"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<LoopState> => fetchLoopState(signal),
  refetchInterval: POLL_MS,
});

export const eventsQuery = (after: number) => ({
  queryKey: ["events", after] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<EventsPage> => fetchEvents({ after, limit: EVENTS_PAGE }, signal),
  refetchInterval: POLL_MS,
});

export const spendQuery = (after: number) => ({
  queryKey: ["spend", after] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<SpendPage> => fetchSpend({ after, limit: SPEND_PAGE }, signal),
  refetchInterval: POLL_MS,
});

export const useLoopState = () => useQuery(loopStateQuery());

/** `GET /api/rounds` — the round navigator's list + replay chapter marks (§8). Unpaged, so this
 *  polls the same 3 s cadence as everything else rather than accumulating a cursor like the
 *  events/spend feeds: a round transitioning `in_progress` -> `done`, or a fresh round opening,
 *  is a small, bounded row set, not an append-only stream to page through. */
export const roundsQuery = () => ({
  queryKey: ["rounds"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<RoundsPage> => fetchRounds(signal),
  refetchInterval: POLL_MS,
});

export const useRounds = () => useQuery(roundsQuery());

/** `?demo`'s one-shot fixture load (#742) — no `refetchInterval`: the bundle is a static file,
 *  never a live poll target. */
export const demoFixtureQuery = () => ({
  queryKey: ["demo-fixture"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<DemoBundle> => fetchDemoFixture(signal),
});

export const useDemoFixture = () => useQuery(demoFixtureQuery());

export interface EventHistory {
  after: number;
  /** Bounded recent window — the routine/display tail (`maxHistory` entries, oldest dropped).
   *  `DomainEvent[]`, not the raw wire `LoopEvent[]` (#715 gate② round 5 [0]): `accumulateEventsPage`
   *  below is the parse boundary that classifies each fresh wire event through `toDomainEvent`
   *  the instant it enters accumulated history, so nothing past this point ever sees the wire
   *  `kind: string` again. #740 gate①: sourced from the shared reducer's own `ReplayState.events`
   *  (`foldReplay`) rather than a second, separately-truncated copy — `checkpoint.ts`'s
   *  fold-to-position produces the identical bounded window at any cursor, so ActivityFeed
   *  replays through the SAME function live mode does, not a live-only side channel. */
  events: DomainEvent[];
  /** Durable, NEVER bounded by `maxHistory` — folded incrementally per page (`foldEntityTitles`'s
   *  own doc explains why: a title from an event that ages out of `events` must not be forgotten). */
  titles: EntityTitles;
  /** Durable, NEVER bounded by `maxHistory` — same reasoning as `titles`, for open attention items
   *  (`foldOpenAttention`'s own doc). #715 gate② [0]. */
  openAttention: OpenAttention;
  /** #740: live mode's own running fold of the shared reducer's hero slice (lanes, droplets,
   *  rings, ceiling state) — the same `foldReplay` a future replay/scrub path calls, not a
   *  parallel implementation. Re-fitted to `lanesMax` on every call (`withLaneCount`), same order
   *  `Hero.tsx` used to apply it in before folding, so a channel a fresh dispatch claims lands in
   *  a correctly-sized array rather than an "extra" overflow slot. */
  hero: HeroState;
  /** This call's own fresh transitions/steps — Hero's animation input. Never accumulated across
   *  calls (an unchanged poll reuses the SAME array reference, so Hero's animation effect, keyed
   *  on this by reference, correctly does not re-fire). */
  steps: FoldStep[];
}

export const EMPTY_EVENT_HISTORY: EventHistory = {
  after: 0,
  events: [],
  titles: {},
  openAttention: {},
  hero: initialReplayState(null).hero,
  steps: [],
};

/**
 * Folds one `/api/events` page into an accumulated history, advancing the cursor — pure so it's
 * unit-testable without mounting a component. #715 gate② [4]: `useEvents(0)` used to hold the
 * cursor at 0 forever, so once the ledger passed one page (200 rows) every poll re-fetched the
 * SAME oldest 200 events and the feed could never see anything newer.
 *
 * #740: the events/titles/openAttention/hero fold now runs through the shared `foldReplay`
 * reducer (`replay/reducer.ts`) instead of separately-maintained call sites — this IS live mode's
 * half of "one state reducer, live and replay both feed it" (§9); `checkpoint.ts`'s fold-to-
 * position produces the SAME bounded `events` window at any cursor (#740 gate① finding [1] —
 * `events` used to be sliced here alone, so a replay cursor could never reconstruct the feed).
 * `lanesMax` re-fits the hero slice's channel count (`withLaneCount`) BEFORE folding fresh events,
 * same order `Hero.tsx` used to apply it in internally, so a fresh dispatch still claims a
 * properly-sized slot rather than an overflow "extra" channel. Deduplicates `events` by id (a page
 * can legitimately overlap the previous one at its edge) — but `titles`/`openAttention` fold onto
 * the PREVIOUS call's result and are never truncated (#715 gate② [0] round 2: the display window's
 * cap must not double as the window those durable folds depend on, or an escalation/title aging
 * out of `events` would silently vanish with nothing downstream the wiser). `steps` is cleared to
 * `[]` whenever nothing fresh was folded (#740 gate① finding [0]) — a `lanesMax`-only refit must
 * never leave a PREVIOUS batch's transitions attached to a NEW hero snapshot, or Hero's animation
 * effect (keyed on `[steps, heroState]` by reference) replays a batch that already animated.
 */
export function accumulateEventsPage(
  history: EventHistory,
  page: EventsPage,
  maxHistory = MAX_EVENT_HISTORY,
  lanesMax: number | null = null,
): EventHistory {
  const seen = new Set(history.events.map((e) => e.id));
  const freshWire = page.events.filter((e) => !seen.has(e.id));
  const after = Math.max(history.after, page.lastId);
  const hero = withLaneCount(history.hero, lanesMax);
  if (freshWire.length === 0) {
    if (after === history.after && hero === history.hero) return history;
    return { ...history, after, hero, steps: [] };
  }
  // #715 gate② round 5 [0]: THE parse boundary — every fresh wire event is classified against
  // copy.ts's closed EventKind union right here, once, via toDomainEvent. Everything downstream
  // (the shared reducer) consumes the resulting DomainEvent, never the raw wire `kind: string`
  // again.
  const fresh = freshWire.map(toDomainEvent);
  const { state, steps } = foldReplay(
    { hero, titles: history.titles, openAttention: history.openAttention, events: history.events },
    fresh,
    maxHistory,
  );
  return {
    after,
    events: state.events,
    titles: state.titles,
    openAttention: state.openAttention,
    hero: state.hero,
    steps,
  };
}

/** A page shape that folds no fresh events but still lets `accumulateEventsPage` re-fit the hero
 *  slice's lane count when `lanesMax` alone changed (config arriving after first paint, or
 *  changing under a running engine) — `useEventHistory`'s stand-in when the events query hasn't
 *  resolved on this render yet, same "no data, still re-fit" behavior `Hero.tsx` used to get for
 *  free from its own `[events, lanesMax]` effect dependency. */
const noAdvance = (after: number): EventsPage => ({ events: [], lastId: after });

/**
 * Polls the append-only feed and accumulates it into a growing, cursor-advancing history (§8's
 * feed contract: ascending pages, live mode polling the tail) instead of re-requesting the first
 * page forever. See `accumulateEventsPage`'s own doc for what this is (and is not) a replacement
 * for, and for why `titles`/`openAttention`/`hero` are exposed separately from the bounded
 * `events` tail. `lanesMax` is `/api/loop/state`'s `lanes.max` — the same value `Hero.tsx` used to
 * receive as its own prop and fold with internally; it now flows in here instead, so hero, lane
 * narrative, activity feed, ring counts, and header/needs-attention all read from ONE fold (#740).
 */
export function useEventHistory(lanesMax: number | null): {
  events: DomainEvent[];
  titles: EntityTitles;
  openAttention: DomainEvent[];
  hero: HeroState;
  steps: FoldStep[];
  error: unknown;
  isPending: boolean;
} {
  const [history, setHistory] = useState<EventHistory>(EMPTY_EVENT_HISTORY);
  const query = useQuery(eventsQuery(history.after));
  // Fold the latest page into the render's OWN output immediately — `accumulateEventsPage` is
  // pure and idempotent (dedupes by id), so recomputing it here ahead of the effect below is
  // free. Without this, the very first page's data would be invisible until the effect commits
  // (a one-frame lag in the browser; permanently invisible under `renderToStaticMarkup`, which
  // never runs effects at all — a real gap `App.test.tsx`'s cost-strip regression test found).
  const merged = accumulateEventsPage(history, query.data ?? noAdvance(history.after), MAX_EVENT_HISTORY, lanesMax);

  // #740 gate① finding [0]: the effect used to re-derive its own `accumulateEventsPage` call
  // instead of persisting `merged` itself — a structurally-equal but REFERENCE-different `hero`/
  // `steps` than the render-ahead value above. `Hero.tsx`'s animation effect is keyed on
  // `[steps, heroState]` BY REFERENCE (React's `Object.is` dependency check), so that mismatch
  // made it fire twice for the same batch: once for the render-ahead fold, again once this effect
  // committed its own independently-recomputed equivalent. Persisting the EXACT `merged` object
  // computed above — never a second call — makes the committed history and the render-ahead value
  // the same reference, so a settled render sees `heroState`/`steps` stop changing at all.
  useEffect(() => {
    if (merged !== history) setHistory(merged);
  }, [merged, history]);

  return {
    events: merged.events,
    titles: merged.titles,
    openAttention: Object.values(merged.openAttention),
    hero: merged.hero,
    steps: merged.steps,
    error: query.error,
    isPending: query.isPending && merged.events.length === 0,
  };
}

export interface SpendHistory {
  after: number;
  rows: SpendRow[];
}

export const EMPTY_SPEND_HISTORY: SpendHistory = { after: 0, rows: [] };

/**
 * Folds one `/api/spend` page into an accumulated history, advancing the cursor — same shape as
 * `accumulateEventsPage`, pure so it's unit-testable without mounting a component. #715 gate②
 * round 3 [2]: the cost strip's "by lane" group was built from `/api/loop/state`'s active-worker
 * `lanes.items`, so a lane's settled spend vanished the instant it left the active set (merged/
 * reclaimed), and an in-flight lane with no settled or estimated cost rendered as a fabricated
 * `$0`. The spend ledger is the honest source for "today's spend by lane" — it only ever records
 * SETTLED cost, so a lane genuinely absent from it (still in flight, nothing billed yet) simply
 * has no bar, never a $0 one.
 */
export function accumulateSpendPage(history: SpendHistory, page: SpendPage, maxHistory = MAX_SPEND_HISTORY): SpendHistory {
  const seen = new Set(history.rows.map((r) => r.id));
  const fresh = page.spend.filter((r) => !seen.has(r.id));
  const after = Math.max(history.after, page.lastId);
  if (fresh.length === 0) return after === history.after ? history : { ...history, after };
  return { after, rows: [...history.rows, ...fresh].slice(-maxHistory) };
}

/** Polls the append-only spend ledger and accumulates it into a growing, cursor-advancing history,
 *  same rationale as `useEventHistory` — including folding the latest page into the render's own
 *  output immediately rather than only via the effect (see that hook's doc for why). */
export function useSpendHistory(): { rows: SpendRow[]; error: unknown; isPending: boolean } {
  const [history, setHistory] = useState<SpendHistory>(EMPTY_SPEND_HISTORY);
  const query = useQuery(spendQuery(history.after));
  const merged = query.data ? accumulateSpendPage(history, query.data) : history;

  useEffect(() => {
    if (query.data) setHistory((prev) => accumulateSpendPage(prev, query.data));
  }, [query.data]);

  return { rows: merged.rows, error: query.error, isPending: query.isPending && merged.rows.length === 0 };
}

/** Only these two `actorKind` values are actually LANES (§3 E's "by lane" strip) — `worker` and
 *  `fix-leg` are the two phases the same lane occupies across its life (#645's durable
 *  attribution column). `peripheral-role` (e.g. `role-po-align-1`) and `engine-review` rows are
 *  real spend but never a lane slot, and a `null` row (never claimed an attribution at all) is an
 *  honest unknown, not a lane either — including any of the three would inflate the strip with a
 *  bar that isn't one of the board's `lanes.max` slots (#715 gate② round 4 [3]). */
const LANE_ACTOR_KINDS: ReadonlySet<SpendRow["actorKind"]> = new Set(["worker", "fix-leg"]);

/** Groups accumulated spend rows by lane (`worker`), summed, for `now`'s UTC calendar day — the
 *  SAME day-boundary rule the engine's own `dailySpendUsd`/`spendByModelForDay` use (ts-prefix
 *  match against `now.toISOString().slice(0, 10)`), so the cost strip's "by lane" total agrees
 *  with the header's "today" total instead of drifting on its own boundary. Filtered to
 *  `actorKind: "worker" | "fix-leg"` rows only (#715 gate② round 4 [3]) — every other
 *  attribution is real spend but not a lane, so it belongs elsewhere, never inflating this strip. */
export function spendByWorkerForDay(rows: readonly SpendRow[], now: Date): { label: string; usd: number }[] {
  const dayPrefix = now.toISOString().slice(0, 10);
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.ts.startsWith(dayPrefix)) continue;
    if (!LANE_ACTOR_KINDS.has(row.actorKind)) continue;
    totals.set(row.worker, (totals.get(row.worker) ?? 0) + row.usd);
  }
  return [...totals.entries()].map(([label, usd]) => ({ label, usd }));
}
