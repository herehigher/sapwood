import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type EntityTitles, foldEntityTitles, foldOpenAttention, type OpenAttention } from "../entities.ts";
import { fetchEvents, fetchLoopState } from "./client.ts";
import type { EventsPage, LoopEvent, LoopState } from "./types.ts";

/** §2 Transport: HTTP polling at 3 s. No WebSocket — that row is the acceptance bar. */
export const POLL_MS = 3000;

/** Feed page size. The server caps `limit`; this is just the tail we ask for per poll. */
export const EVENTS_PAGE = 200;

/** Bounds a long-running dashboard tab's memory — the feed only ever renders a bounded recent
 *  window anyway, so the oldest entries are dropped once history exceeds this. */
export const MAX_EVENT_HISTORY = 2000;

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

export const useLoopState = () => useQuery(loopStateQuery());

export interface EventHistory {
  after: number;
  /** Bounded recent window — the routine/display tail (`maxHistory` entries, oldest dropped). */
  events: LoopEvent[];
  /** Durable, NEVER bounded by `maxHistory` — folded incrementally per page (`foldEntityTitles`'s
   *  own doc explains why: a title from an event that ages out of `events` must not be forgotten). */
  titles: EntityTitles;
  /** Durable, NEVER bounded by `maxHistory` — same reasoning as `titles`, for open attention items
   *  (`foldOpenAttention`'s own doc). #715 gate② [0]. */
  openAttention: OpenAttention;
}

export const EMPTY_EVENT_HISTORY: EventHistory = { after: 0, events: [], titles: {}, openAttention: {} };

/**
 * Folds one `/api/events` page into an accumulated history, advancing the cursor — pure so it's
 * unit-testable without mounting a component. #715 gate② [4]: `useEvents(0)` used to hold the
 * cursor at 0 forever, so once the ledger passed one page (200 rows) every poll re-fetched the
 * SAME oldest 200 events and the feed could never see anything newer. This is NOT the full §9
 * "one state reducer" (the shared event-folding hook live mode and replay both feed from) — that
 * is bigger, shared infrastructure this issue doesn't need; this is the minimal live-only tail
 * accumulator the feed needs until it lands. Deduplicates `events` by id (a page can legitimately
 * overlap the previous one at its edge) and drops its oldest entries past `maxHistory` — but
 * `titles`/`openAttention` fold onto the PREVIOUS call's result and are never truncated (#715
 * gate② [0] round 2: the display window's cap must not double as the window those durable folds
 * depend on, or an escalation/title aging out of `events` would silently vanish with nothing
 * downstream the wiser).
 */
export function accumulateEventsPage(history: EventHistory, page: EventsPage, maxHistory = MAX_EVENT_HISTORY): EventHistory {
  const seen = new Set(history.events.map((e) => e.id));
  const fresh = page.events.filter((e) => !seen.has(e.id));
  const after = Math.max(history.after, page.lastId);
  if (fresh.length === 0) return after === history.after ? history : { ...history, after };
  return {
    after,
    events: [...history.events, ...fresh].slice(-maxHistory),
    titles: foldEntityTitles(fresh, history.titles),
    openAttention: foldOpenAttention(fresh, history.openAttention),
  };
}

/**
 * Polls the append-only feed and accumulates it into a growing, cursor-advancing history (§8's
 * feed contract: ascending pages, live mode polling the tail) instead of re-requesting the first
 * page forever. See `accumulateEventsPage`'s own doc for what this is (and is not) a replacement
 * for, and for why `titles`/`openAttention` are exposed separately from the bounded `events` tail.
 */
export function useEventHistory(): {
  events: LoopEvent[];
  titles: EntityTitles;
  openAttention: LoopEvent[];
  error: unknown;
  isPending: boolean;
} {
  const [history, setHistory] = useState<EventHistory>(EMPTY_EVENT_HISTORY);
  const query = useQuery(eventsQuery(history.after));

  useEffect(() => {
    if (query.data) setHistory((prev) => accumulateEventsPage(prev, query.data));
  }, [query.data]);

  return {
    events: history.events,
    titles: history.titles,
    openAttention: Object.values(history.openAttention),
    error: query.error,
    isPending: query.isPending && history.events.length === 0,
  };
}
