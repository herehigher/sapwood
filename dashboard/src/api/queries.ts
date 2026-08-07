import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  events: LoopEvent[];
}

export const EMPTY_EVENT_HISTORY: EventHistory = { after: 0, events: [] };

/**
 * Folds one `/api/events` page into an accumulated history, advancing the cursor — pure so it's
 * unit-testable without mounting a component. #715 gate② [4]: `useEvents(0)` used to hold the
 * cursor at 0 forever, so once the ledger passed one page (200 rows) every poll re-fetched the
 * SAME oldest 200 events and the feed could never see anything newer. This is NOT the full §9
 * "one state reducer" (the shared event-folding hook live mode and replay both feed from) — that
 * is bigger, shared infrastructure this issue doesn't need; this is the minimal live-only tail
 * accumulator the feed needs until it lands. Deduplicates by id (a page can legitimately overlap
 * the previous one at its edge) and drops the oldest entries past `maxHistory`.
 */
export function accumulateEventsPage(history: EventHistory, page: EventsPage, maxHistory = MAX_EVENT_HISTORY): EventHistory {
  const seen = new Set(history.events.map((e) => e.id));
  const fresh = page.events.filter((e) => !seen.has(e.id));
  const after = Math.max(history.after, page.lastId);
  if (fresh.length === 0) return after === history.after ? history : { after, events: history.events };
  return { after, events: [...history.events, ...fresh].slice(-maxHistory) };
}

/**
 * Polls the append-only feed and accumulates it into a growing, cursor-advancing history (§8's
 * feed contract: ascending pages, live mode polling the tail) instead of re-requesting the first
 * page forever. See `accumulateEventsPage`'s own doc for what this is (and is not) a replacement
 * for.
 */
export function useEventHistory(): { events: LoopEvent[]; error: unknown; isPending: boolean } {
  const [history, setHistory] = useState<EventHistory>(EMPTY_EVENT_HISTORY);
  const query = useQuery(eventsQuery(history.after));

  useEffect(() => {
    if (query.data) setHistory((prev) => accumulateEventsPage(prev, query.data));
  }, [query.data]);

  return { events: history.events, error: query.error, isPending: query.isPending && history.events.length === 0 };
}
