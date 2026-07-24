import type { EventsPage, LoopState } from "./types.ts";

/**
 * Fetch wrappers for the §8 read-only endpoints. Same-origin relative paths only: the
 * server binds 127.0.0.1 and grants no CORS, and `vite dev` proxies /api to it.
 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  // Fail loudly. A non-2xx body parsed as T would render as a half-empty dashboard,
  // which on a monitoring surface is worse than an error state.
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** `GET /api/loop/state` — everything current, one poll. */
export const fetchLoopState = (signal?: AbortSignal): Promise<LoopState> => getJson<LoopState>("/api/loop/state", signal);

/** `GET /api/events?after&limit` — the append-only feed, ascending by id. */
export const fetchEvents = ({ after, limit }: { after: number; limit: number }, signal?: AbortSignal): Promise<EventsPage> =>
  getJson<EventsPage>(`/api/events?after=${after}&limit=${limit}`, signal);
