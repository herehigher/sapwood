import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type EntityTitles, foldEntityTitles, foldOpenAttention, type OpenAttention } from "../entities.ts";
import { fetchEvents, fetchLoopState, fetchSpend } from "./client.ts";
import type { EventsPage, LoopEvent, LoopState, SpendPage, SpendRow } from "./types.ts";

/** §2 Transport: HTTP polling at 3 s. No WebSocket — that row is the acceptance bar. */
export const POLL_MS = 3000;

/** Feed page size. The server caps `limit`; this is just the tail we ask for per poll. */
export const EVENTS_PAGE = 200;

/** Bounds a long-running dashboard tab's memory — the feed only ever renders a bounded recent
 *  window anyway, so the oldest entries are dropped once history exceeds this. */
export const MAX_EVENT_HISTORY = 2000;

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
  // Fold the latest page into the render's OWN output immediately — `accumulateEventsPage` is
  // pure and idempotent (dedupes by id), so recomputing it here ahead of the effect below is
  // free. Without this, the very first page's data would be invisible until the effect commits
  // (a one-frame lag in the browser; permanently invisible under `renderToStaticMarkup`, which
  // never runs effects at all — a real gap `App.test.tsx`'s cost-strip regression test found).
  const merged = query.data ? accumulateEventsPage(history, query.data) : history;

  useEffect(() => {
    if (query.data) setHistory((prev) => accumulateEventsPage(prev, query.data));
  }, [query.data]);

  return {
    events: merged.events,
    titles: merged.titles,
    openAttention: Object.values(merged.openAttention),
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
