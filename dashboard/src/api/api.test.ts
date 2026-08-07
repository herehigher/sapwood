import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { EventKind } from "../copy.ts";
import { toDomainEvent } from "../domain-event.ts";
import { fetchEvents, fetchLoopState, fetchSpend } from "./client.ts";
import {
  accumulateEventsPage,
  accumulateSpendPage,
  EMPTY_EVENT_HISTORY,
  EMPTY_SPEND_HISTORY,
  type EventHistory,
  eventsQuery,
  loopStateQuery,
  POLL_MS,
  spendByWorkerForDay,
  spendQuery,
} from "./queries.ts";
import type { EventsPage, LoopEvent, SpendPage, SpendRow } from "./types.ts";

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

test("§8 GET /api/spend pages with after + limit, same contract as /api/events", async () => {
  const calls = stubFetch({
    spend: [{ id: 91, ts: "2026-08-06T00:00:00Z", worker: "w1", issue: 5, usd: 1.2, model: "opus" }],
    lastId: 91,
  });
  const spendPage = await fetchSpend({ after: 80, limit: 50 });
  assert.equal(calls[0]?.url, "/api/spend?after=80&limit=50");
  assert.equal(spendPage.lastId, 91);
  assert.equal(spendPage.spend[0]?.worker, "w1");
});

test("§2 Transport: query options poll every 3 s, no WebSocket", () => {
  assert.equal(POLL_MS, 3000);
  assert.equal(loopStateQuery().refetchInterval, POLL_MS);
  assert.equal(eventsQuery(0).refetchInterval, POLL_MS);
  assert.equal(spendQuery(0).refetchInterval, POLL_MS);
  assert.deepEqual(loopStateQuery().queryKey, ["loop", "state"]);
  assert.deepEqual(eventsQuery(480).queryKey, ["events", 480]);
  assert.deepEqual(spendQuery(80).queryKey, ["spend", 80]);
});

test("queryFn forwards the AbortSignal so a superseded poll is cancelled", async () => {
  const calls = stubFetch({ events: [], lastId: 0 });
  const controller = new AbortController();
  await eventsQuery(0).queryFn({ signal: controller.signal });
  assert.equal(calls[0]?.init?.signal, controller.signal);
});

// ── #715 gate② [4]: accumulateEventsPage — the fixed-feed-cursor fix ────────────────────────────

// `kind: EventKind`, not a bare `string` — #715 gate② round 4 [0], same rationale as
// ActivityFeed.test.tsx's `ev` / entities.test.ts's `event`.
const evt = (id: number, kind: EventKind = "dispatched"): LoopEvent => ({ id, ts: "2026-08-06T00:00:00Z", kind, payload: {} });
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
  const history: EventHistory = {
    after: 10,
    // `EventHistory.events` is `DomainEvent[]`, not the raw wire `LoopEvent[]` this fixture
    // hand-assembles a page/history from elsewhere — run each through the same parse boundary
    // `accumulateEventsPage` itself uses (#715 gate② round 5 [0]).
    events: Array.from({ length: 10 }, (_, i) => toDomainEvent(evt(i + 1))),
    titles: {},
    openAttention: {},
  };
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

// ── #715 gate② round 5 [0]: accumulateEventsPage IS the parse boundary ──────────────────────────
//
// This is the real fold-path proof the finding asked for: not a local test helper narrowed to
// EventKind, but the actual function that turns a wire page into accumulated history, exercised
// with a wire kind this client's copy map has never heard of — same as a genuinely newer engine
// would send. It must classify (never crash, never drop the row), and a real mapped kind must
// classify the other way.

test("accumulateEventsPage classifies an unmapped wire kind as an UnknownDomainEvent — rendered later, never dropped or thrown on", () => {
  const fromANewerEngine: LoopEvent = {
    id: 1,
    ts: "2026-08-06T00:00:00Z",
    kind: "a-kind-nobody-registered-in-copy-ts",
    payload: { anything: "at all" },
  };
  const history = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([fromANewerEngine], 1));
  assert.equal(history.events.length, 1);
  const [classified] = history.events;
  assert.equal(classified?.known, false);
  assert.equal(classified?.kind, "a-kind-nobody-registered-in-copy-ts");
  // Never opened as an attention item — an unmapped kind has no COPY entry to carry that marker.
  assert.deepEqual(history.openAttention, {});
});

test("accumulateEventsPage classifies a real, mapped wire kind as a KnownDomainEvent", () => {
  const history = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([evt(1, "dispatched")], 1));
  const [classified] = history.events;
  assert.equal(classified?.known, true);
  assert.equal(classified?.kind, "dispatched");
});

// ── #715 gate② [0]: titles/openAttention are durable, never bounded by maxHistory ───────────────

test("accumulateEventsPage keeps a title after its title-bearing event ages out of the bounded events window", () => {
  const dispatched: LoopEvent = {
    id: 1,
    ts: "2026-08-06T00:00:00Z",
    kind: "dispatched",
    payload: { issue: 86, issueTitle: "Fix the thing" },
  };
  let history = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([dispatched], 1), 3);
  assert.equal(history.titles[86]?.issueTitle, "Fix the thing");

  // Push enough later events through a small maxHistory that event 1 is evicted from `events`.
  history = accumulateEventsPage(history, page([evt(2), evt(3), evt(4)], 4), 3);
  assert.deepEqual(
    history.events.map((e) => e.id),
    [2, 3, 4],
  );
  assert.equal(
    history.events.some((e) => e.id === 1),
    false,
    "event 1 must actually be gone from the bounded window",
  );
  // But the title it carried must have survived the eviction.
  assert.equal(history.titles[86]?.issueTitle, "Fix the thing");
});

test("accumulateEventsPage keeps an open escalation pinned after it ages out of the bounded events window, and clears it on resolution arriving in a LATER page", () => {
  const escalation: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "drive-needs-human", payload: { issue: 5, pr: 50 } };
  let history = accumulateEventsPage(EMPTY_EVENT_HISTORY, page([escalation], 1), 3);
  assert.equal(Object.keys(history.openAttention).length, 1);

  // Evict event 1 from the bounded window with a run of later, unrelated events.
  history = accumulateEventsPage(history, page([evt(2), evt(3), evt(4)], 4), 3);
  assert.equal(
    history.events.some((e) => e.id === 1),
    false,
    "event 1 must actually be gone from the bounded window",
  );
  // The open escalation survives — this is the core of the finding: a bounded display window
  // must not silently drop an unresolved escalation with no resolution ever having been observed.
  assert.equal(Object.keys(history.openAttention).length, 1);
  assert.equal(Object.values(history.openAttention)[0]?.kind, "drive-needs-human");

  // A resolution arrives in a later page — the original escalation event is never in this page's
  // `events`, only its resolution is, and it still correctly clears the durable open-attention entry.
  const resolved: LoopEvent = {
    id: 5,
    ts: "2026-08-06T00:00:01Z",
    kind: "escalation-resolved",
    payload: { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 },
  };
  history = accumulateEventsPage(history, page([resolved], 5), 3);
  assert.deepEqual(history.openAttention, {});
});

// ── #715 gate② round 3 [2]: accumulateSpendPage / spendByWorkerForDay ───────────────────────────

const spendRow = (
  id: number,
  worker: string,
  usd: number,
  ts = "2026-08-06T12:00:00Z",
  actorKind: SpendRow["actorKind"] = "worker",
): SpendRow => ({
  id,
  ts,
  worker,
  issue: 5,
  usd,
  model: "opus",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  actorKind,
  role: null,
  estimated: false,
});
const spendPage = (spend: SpendRow[], lastId: number): SpendPage => ({ spend, lastId });

test("accumulateSpendPage advances the cursor and accumulates, same shape as accumulateEventsPage", () => {
  const first = accumulateSpendPage(EMPTY_SPEND_HISTORY, spendPage([spendRow(1, "w1", 1.2)], 1));
  assert.equal(first.after, 1);
  const second = accumulateSpendPage(first, spendPage([spendRow(2, "w2", 0.8)], 2));
  assert.equal(second.after, 2);
  assert.deepEqual(
    second.rows.map((r) => r.id),
    [1, 2],
  );
});

test("accumulateSpendPage deduplicates by id when a page overlaps the accumulated history", () => {
  const first = accumulateSpendPage(EMPTY_SPEND_HISTORY, spendPage([spendRow(1, "w1", 1.2)], 1));
  const merged = accumulateSpendPage(first, spendPage([spendRow(1, "w1", 1.2), spendRow(2, "w2", 0.5)], 2));
  assert.deepEqual(
    merged.rows.map((r) => r.id),
    [1, 2],
  );
});

test("spendByWorkerForDay sums settled spend per lane for the given day, ignoring other days", () => {
  const rows = [
    spendRow(1, "w1", 1.2, "2026-08-06T01:00:00Z"),
    spendRow(2, "w1", 0.5, "2026-08-06T02:00:00Z"),
    spendRow(3, "w2", 2.0, "2026-08-06T03:00:00Z"),
    spendRow(4, "w1", 9.0, "2026-08-05T23:00:00Z"), // yesterday — excluded
  ];
  const bars = spendByWorkerForDay(rows, new Date("2026-08-06T12:00:00Z"));
  const byLabel = Object.fromEntries(bars.map((b) => [b.label, b.usd]));
  assert.equal(byLabel.w1, 1.7);
  assert.equal(byLabel.w2, 2.0);
});

test("#715 gate② round 3 [2]'s core regression: a lane's settled spend survives after it stops being active", () => {
  // Simulates exactly the finding's scenario: a lane that has already left `/api/loop/state`'s
  // active-worker set (merged/reclaimed) but whose spend_ledger row is still there, forever, since
  // the ledger is append-only and keyed by worker name/id, not by "is this lane currently active".
  const rows = [spendRow(1, "w1", 3.4, "2026-08-06T01:00:00Z")];
  const bars = spendByWorkerForDay(rows, new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(bars, [{ label: "w1", usd: 3.4 }]);
});

test("spendByWorkerForDay never fabricates a $0 bar for a lane with no settled spend", () => {
  const bars = spendByWorkerForDay([], new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(bars, []);
});

test("#715 gate② round 4 [3]: spendByWorkerForDay excludes non-lane actorKind rows — mixed-attribution regression", () => {
  const rows = [
    spendRow(1, "w1", 1.0, "2026-08-06T01:00:00Z", "worker"),
    spendRow(2, "w1", 0.5, "2026-08-06T02:00:00Z", "fix-leg"),
    // Real spend, but none of these is a lane slot — must never appear as a bar.
    spendRow(3, "role-po-align-1", 2.0, "2026-08-06T03:00:00Z", "peripheral-role"),
    spendRow(4, "lane-a:engine-review", 5.0, "2026-08-06T04:00:00Z", "engine-review"),
    spendRow(5, "w2", 3.0, "2026-08-06T05:00:00Z", null),
  ];
  const bars = spendByWorkerForDay(rows, new Date("2026-08-06T12:00:00Z"));
  // Asserting the exact bar array (not per-key lookups) proves inclusion AND exclusion in one
  // shot: only "w1" (worker + fix-leg summed) survives; the peripheral-role, engine-review, and
  // null-attribution rows never produce a bar at all, real spend or not.
  assert.deepEqual(bars, [{ label: "w1", usd: 1.5 }]);
});
