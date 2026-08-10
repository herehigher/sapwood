import type { ControlVerb, EventsPage, LoopState, SpendPage } from "./types.ts";

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

/** `GET /api/spend?after&limit` — the append-only spend ledger, same paging contract as
 *  `/api/events` (§8). #715 gate② [2]: the cost strip's "by lane" group reads from here, not from
 *  `/api/loop/state`'s active-worker `lanes.items` — a lane's settled cost must not disappear
 *  from today's total the instant it stops being active. */
export const fetchSpend = ({ after, limit }: { after: number; limit: number }, signal?: AbortSignal): Promise<SpendPage> =>
  getJson<SpendPage>(`/api/spend?after=${after}&limit=${limit}`, signal);

/** `POST /api/control` (§3 Operations / §8) — the dashboard's one write path. The server defends
 *  itself independently of this client (same-origin `Origin` check, the `X-Sapwood-Control`
 *  header forcing a CORS preflight it never grants) — this just sends what it expects. */
export async function postControl(verb: ControlVerb, signal?: AbortSignal): Promise<{ state: string }> {
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json", "x-sapwood-control": "1" },
    body: JSON.stringify({ verb }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`POST /api/control ${verb} → ${res.status} ${res.statusText}`);
  return (await res.json()) as { state: string };
}
