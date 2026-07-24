import { useQuery } from "@tanstack/react-query";
import { fetchEvents, fetchLoopState } from "./client.ts";
import type { EventsPage, LoopState } from "./types.ts";

/** §2 Transport: HTTP polling at 3 s. No WebSocket — that row is the acceptance bar. */
export const POLL_MS = 3000;

/** Feed page size. The server caps `limit`; this is just the tail we ask for per poll. */
export const EVENTS_PAGE = 200;

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

/**
 * Polls the feed from `after`. The caller owns the cursor.
 * ponytail: each `after` is its own cache entry, so a caller that advances the cursor
 * every poll would grow the cache. The event-folding reducer (§9 `src/replay/`) is what
 * owns cursor advancement; until it lands, callers hold `after` steady.
 */
export const useEvents = (after: number) => useQuery(eventsQuery(after));
