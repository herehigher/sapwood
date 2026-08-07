import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchEvents, fetchLoopState } from "./client.ts";
import { accumulateEventsPage, EMPTY_EVENT_HISTORY, type EventHistory, eventsQuery, loopStateQuery, POLL_MS } from "./queries.ts";
import type { EventsPage, LoopEvent } from "./types.ts";

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

test("queryFn forwards the AbortSignal so a superseded poll is cancelled", async () => {
  const calls = stubFetch({ events: [], lastId: 0 });
  const controller = new AbortController();
  await eventsQuery(0).queryFn({ signal: controller.signal });
  assert.equal(calls[0]?.init?.signal, controller.signal);
});

// ── #715 gate② [4]: accumulateEventsPage — the fixed-feed-cursor fix ────────────────────────────

const evt = (id: number, kind = "dispatched"): LoopEvent => ({ id, ts: "2026-08-06T00:00:00Z", kind, payload: {} });
const page = (events: LoopEvent[], lastId: number): EventsPage => ({ events, lastId });

test("accumulateEventsPage advances the cursor past the first page instead of holding at 0 forever", () => {
  const firstPage = page([evt(1), evt(2)], 2);
  const afterFirst = accumulateEventsPage(EMPTY_EVENT_HISTORY, firstPage);
  assert.equal(afterFirst.after, 2);
  assert.deepEqual(
    afterFirst.events.map((e) => e.id),
    [1, 2],
  );

  // A second poll, now genuinely asking for `after=2`, brings NEW events the old fixed-cursor-0
  // bug could never observe once the ledger passed one page.
  const secondPage = page([evt(3), evt(4)], 4);
  const afterSecond = accumulateEventsPage(afterFirst, secondPage);
  assert.equal(afterSecond.after, 4);
  assert.deepEqual(
    afterSecond.events.map((e) => e.id),
    [1, 2, 3, 4],
  );
});

test("accumulateEventsPage deduplicates by id when a page overlaps the accumulated history", () => {
  const first = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([evt(1), evt(2)], 2));
  // A re-fetch that happens to re-include id 2 (edge overlap) must not duplicate it.
  const merged = accumulateEventsPage(first, page([evt(2), evt(3)], 3));
  assert.deepEqual(
    merged.events.map((e) => e.id),
    [1, 2, 3],
  );
});

test("accumulateEventsPage caps history at maxHistory, dropping the oldest first", () => {
  const history: EventHistory = { after: 10, events: Array.from({ length: 10 }, (_, i) => evt(i + 1)) };
  const grown = accumulateEventsPage(history, page([evt(11)], 11), 5);
  assert.deepEqual(
    grown.events.map((e) => e.id),
    [7, 8, 9, 10, 11],
  );
});

test("accumulateEventsPage is a no-op when the page carries no events and no cursor advance", () => {
  const history = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([evt(1)], 1));
  const same = accumulateEventsPage(history, page([], 1));
  assert.equal(same, history);
});
