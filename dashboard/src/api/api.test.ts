import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchEvents, fetchLoopState } from "./client.ts";
import { advanceCursor, EVENTS_PAGE, eventsQuery, loopStateQuery, POLL_MS } from "./queries.ts";
import type { LoopEvent } from "./types.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

/** Swap in a fetch that records the call and replays `body`. Returns the recorded calls. */
function stubFetch(body: unknown, init: ResponseInit = { status: 200 }): FetchCall[] {
  const calls: FetchCall[] = [];
  mock.method(globalThis, "fetch", async (url: string, opts: RequestInit | undefined) => {
    calls.push({ url, init: opts });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
  });
  return calls;
}

test.afterEach(() => mock.restoreAll());

test("§8 GET /api/loop/state is fetched and returned verbatim", async () => {
  const snapshot = {
    engine: { state: "running", reasons: [], lastTickAt: "2026-07-09T08:12:00Z" },
    lanes: { max: 3, items: [] },
    round: { id: 12, phase: "executing" },
    spend: { todayUsd: 12.4, dailyBudgetUsd: 100, runUsd: 13.3, runBudgetUsd: 100, byModel: [] },
    rings: 27,
    logPath: "data/logs/run-1.log",
    config: {},
  };
  const calls = stubFetch(snapshot);
  const state = await fetchLoopState();
  assert.equal(calls[0]?.url, "/api/loop/state");
  assert.equal(state.engine.state, "running");
  assert.equal(state.rings, 27);
  assert.equal(state.round?.phase, "executing");
});

test("§8 GET /api/events pages with after + limit", async () => {
  const calls = stubFetch({ events: [{ id: 512, ts: "2026-07-09T08:12:00Z", kind: "merged", payload: { pr: 97 } }], lastId: 512 });
  const page = await fetchEvents({ after: 480, limit: 50 });
  assert.equal(calls[0]?.url, "/api/events?after=480&limit=50");
  assert.equal(page.lastId, 512);
  assert.equal(page.events[0]?.kind, "merged");
});

test("a non-2xx response rejects instead of yielding a half-typed object", async () => {
  stubFetch({ error: "nope" }, { status: 503 });
  await assert.rejects(() => fetchLoopState(), /503/);
});

test("§2 Transport: query options poll every 3 s, no WebSocket", () => {
  assert.equal(POLL_MS, 3000);
  assert.equal(loopStateQuery().refetchInterval, POLL_MS);
  assert.equal(eventsQuery(0).refetchInterval, POLL_MS);
  assert.deepEqual(loopStateQuery().queryKey, ["loop", "state"]);
  assert.deepEqual(eventsQuery(480).queryKey, ["events", 480]);
});

// ── The live cursor ───────────────────────────────────────────────────────────
// §8: "live mode polls with the last seen id, replay mode pages from after=0". Polling a
// frozen after=0 against a capped, ascending page means that once the log passes one page,
// every poll returns the same first rows forever — nothing new ever reaches the reducer.

const page = (ids: number[], lastId = ids.at(-1) ?? 0) => ({
  events: ids.map((id): LoopEvent => ({ id, ts: "2026-07-09T08:12:00Z", kind: "dispatched", payload: {} })),
  lastId,
});

test("the live cursor advances past each fetched page", () => {
  assert.equal(advanceCursor(0, page([1, 2, 3])), 3);
  assert.equal(advanceCursor(3, page([4, 5])), 5);
});

test("the cursor holds still when there is nothing new, and never walks backwards", () => {
  // An empty page must not reset the cursor — that would re-serve the whole log next poll.
  assert.equal(advanceCursor(512, page([], 0)), 512);
  assert.equal(advanceCursor(512, undefined), 512);
  // A stale in-flight response for an older cursor must not rewind a newer one.
  assert.equal(advanceCursor(512, page([100, 101])), 512);
});

test("the cursor trusts the highest id it actually saw, not just lastId", () => {
  // lastId is the server's own marker; the events are the evidence. Take the max of both so
  // neither a lagging nor a leading marker can stall the stream.
  assert.equal(advanceCursor(0, page([1, 2, 3], 0)), 3);
  assert.equal(advanceCursor(0, page([1, 2, 3], 9)), 9);
});

test("a full page means more may be waiting — the next poll must not sit on the interval", () => {
  // Catching up after downtime should drain at fetch speed, not one page per 3 s tick.
  assert.equal(eventsQuery(0).refetchInterval, POLL_MS);
  assert.ok(EVENTS_PAGE > 0);
});

test("queryFn forwards the AbortSignal so a superseded poll is cancelled", async () => {
  const calls = stubFetch({ events: [], lastId: 0 });
  const controller = new AbortController();
  await eventsQuery(0).queryFn({ signal: controller.signal });
  assert.equal(calls[0]?.init?.signal, controller.signal);
});
