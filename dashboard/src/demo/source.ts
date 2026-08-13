import type { DemoBundle } from "./types.ts";

/**
 * The recorded dogfood run this repo ships as its `?demo` fixture (#742) — one short round,
 * two lanes, one merge and one human escalation, small enough to read end-to-end in the
 * showcase (#704) without padding. This is the EXPORT INPUT, not what ships: `export-cli.ts`
 * runs it through `exportDemoBundle` (credential scan + host-absolute-path rewrite) at build
 * time before it reaches `dashboard/public/demo-fixture.json`. `logPath` below is deliberately
 * a real host-absolute path — the recording machine's own — so the export gate has genuine work
 * to do, not just a planted test sentinel.
 */
export const DEMO_SOURCE: DemoBundle = {
  loopState: {
    engine: {
      state: "stopped",
      reasons: [],
      lastTickAt: "2026-08-09T09:42:00Z",
      pauseActive: false,
      estopActive: false,
      standbyNextCheckSec: null,
    },
    lanes: { max: 2, items: [] },
    round: null,
    spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
    rings: 1,
    mergedPrs: [9201],
    logPath: "/Users/demo-operator/work/sapwood/dashboard/data/dogfood-run-5001.log",
    config: { board: { owner: "herehigher", repo: "sapwood" }, lanes: { prFixCap: 2 } },
    controlsEnabled: false,
  },
  rounds: [
    {
      roundId: 5001,
      status: "done",
      startedAt: "2026-08-09T09:00:00Z",
      endedAt: "2026-08-09T09:42:00Z",
      // #793 gate② finding [1]: EXCLUSIVE cursors (`engine/src/state/state.ts`'s `listRounds()`:
      // `e.id > r.start_event_id`) — 0, the id of the (nonexistent) row before this fixture's
      // first real row (id 1), not the first included row's own id.
      startEventId: 0,
      startSpendId: 0,
      eventCount: 9,
      schemaVersion: 1,
      artifact: { prsMerged: 1, spendUsd: 4.2 },
    },
  ],
  events: [
    { id: 1, ts: "2026-08-09T09:00:05Z", kind: "pool-selected", payload: { round_id: 5001, issues: [9101, 9102] } },
    { id: 2, ts: "2026-08-09T09:00:10Z", kind: "round-phase", payload: { round_id: 5001, phase: "executing" } },
    {
      id: 3,
      ts: "2026-08-09T09:01:00Z",
      kind: "dispatched",
      payload: { worker: "lane-a", issue: 9101, issueTitle: "Add scrub bar chapter marks" },
    },
    {
      id: 4,
      ts: "2026-08-09T09:01:30Z",
      kind: "dispatched",
      payload: { worker: "lane-b", issue: 9102, issueTitle: "Fix header spend meter rounding" },
    },
    {
      id: 5,
      ts: "2026-08-09T09:18:00Z",
      kind: "reclaim-done",
      payload: { worker: "lane-a", issue: 9101, next: "DRIVING", pr: 9201, prTitle: "feat(dashboard): scrub bar chapter marks" },
    },
    {
      id: 6,
      ts: "2026-08-09T09:20:00Z",
      kind: "reclaim-done",
      payload: { worker: "lane-b", issue: 9102, next: "DRIVING", pr: 9202, prTitle: "fix(dashboard): header spend meter rounding" },
    },
    { id: 7, ts: "2026-08-09T09:25:00Z", kind: "merged", payload: { issue: 9101, pr: 9201, worker: "lane-a" } },
    { id: 8, ts: "2026-08-09T09:30:00Z", kind: "drive-needs-human", payload: { issue: 9102, pr: 9202 } },
    { id: 9, ts: "2026-08-09T09:42:00Z", kind: "round-stop", payload: { detail: "issue cap reached" } },
  ],
  spend: [
    {
      id: 1,
      ts: "2026-08-09T09:18:00Z",
      worker: "lane-a",
      issue: 9101,
      usd: 2.1,
      model: "claude-sonnet-5",
      inputTokens: 42000,
      outputTokens: 6100,
      cacheReadTokens: 15000,
      cacheCreationTokens: 3000,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
    {
      id: 2,
      ts: "2026-08-09T09:20:00Z",
      worker: "lane-b",
      issue: 9102,
      usd: 2.1,
      model: "claude-sonnet-5",
      inputTokens: 39500,
      outputTokens: 5800,
      cacheReadTokens: 14000,
      cacheCreationTokens: 2800,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
  ],
};
