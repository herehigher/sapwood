import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchEvents, fetchLoopState } from "./client.ts";
import { eventsQuery, loopStateQuery, POLL_MS } from "./queries.ts";

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
