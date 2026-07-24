import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchEvents, fetchLoopState } from "./client.ts";
import type { EventsPage, LoopEvent, LoopState } from "./types.ts";

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

/** Polls the feed from `after`. The caller owns the cursor — see `useEventStream`. */
export const useEvents = (after: number) => useQuery(eventsQuery(after));

/**
 * Where the cursor should sit after folding `page`.
 *
 * §8: "live mode polls with the last seen id". A cursor frozen at 0 against an ascending,
 * page-capped feed re-serves the same first rows forever — once the log passes one page,
 * no dispatch, failure or merge ever reaches the reducer again and the ring count silently
 * freezes. It only ever moves forward: an empty page (nothing new) and a stale response for
 * an older cursor both leave it where it was.
 */
export const advanceCursor = (current: number, page: EventsPage | undefined): number => {
  if (!page || page.events.length === 0) return current;
  // The events are the evidence, `lastId` the server's own marker — take the max of both so
  // neither a lagging nor a leading marker can stall the stream.
  return page.events.reduce((max, e) => (e.id > max ? e.id : max), Math.max(current, page.lastId));
};

/**
 * The live event stream: polls from the last seen id and hands back everything seen so far.
 *
 * Returns the accumulated tail rather than the newest page because every consumer wants
 * history — the hero folds it (id-idempotent, so re-handing it old rows is free) and the
 * feed lists it.
 *
 * ponytail: the tail is capped at RETAINED_EVENTS and each cursor is its own query-cache
 * entry (inactive ones age out on TanStack's default gcTime). If the feed ever needs deeper
 * history than the cap, page backwards from the server rather than growing this array.
 */
export const RETAINED_EVENTS = 1000;

export function useEventStream(): { events: LoopEvent[]; isPending: boolean; error: Error | null } {
  const [after, setAfter] = useState(0);
  const [seen, setSeen] = useState<LoopEvent[]>([]);
  const page = useEvents(after);

  useEffect(() => {
    const next = advanceCursor(after, page.data);
    if (next === after) return;
    setSeen((prev) => [...prev, ...page.data!.events.filter((e) => e.id > after)].slice(-RETAINED_EVENTS));
    setAfter(next);
  }, [after, page.data]);

  return { events: seen, isPending: page.isPending && seen.length === 0, error: page.error };
}
