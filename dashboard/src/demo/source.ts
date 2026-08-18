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
      lastTickAt: "2026-08-09T15:00:00Z",
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
    // #880: `cost.roundBudgetUsd` is what drives the cost panel's by-stage target-tick marker
    // (`cost-panel.ts`'s `stageTargetUsd`) — without it here, the shots capture (this fixture's
    // whole reason to exist) would show every tick omitted, the one thing `cost-dark.png` names
    // that a config-less demo can't otherwise demonstrate. 15 (below the engine schema's default
    // of 30) rather than the default itself: at 30 the per-stage target ($5) sits ABOVE this
    // fixture's total round spend ($4.20), pinning every tick to the track's far right edge; 15
    // puts the target ($2.50) below the Lanes stage's own $4.20, matching `cost-dark.png`'s own
    // pairing (the tick sits inside the group's real max, visible mid-track on the empty stages).
    config: { board: { owner: "herehigher", repo: "sapwood" }, lanes: { prFixCap: 2 }, cost: { roundBudgetUsd: 15 } },
    controlsEnabled: false,
    // #894: a recorded demo has no live server behind it to compare against — honestly unknown,
    // same posture `logPath`'s real recording-machine path doesn't extend to (this fixture is
    // replay-only, and ConfigDrawer never renders in replay mode — LiveOnly).
    build: { distSha: null, distTime: null, repoHeadSha: null },
  },
  rounds: [
    {
      roundId: 5001,
      status: "done",
      startedAt: "2026-08-09T09:00:00Z",
      endedAt: "2026-08-09T15:00:00Z",
      // #793 gate② finding [1]: EXCLUSIVE cursors (`engine/src/state/state.ts`'s `listRounds()`:
      // `e.id > r.start_event_id`) — 0, the id of the (nonexistent) row before this fixture's
      // first real row (id 1), not the first included row's own id.
      startEventId: 0,
      startSpendId: 0,
      eventCount: 11,
      schemaVersion: 1,
      // #880: `roundBudgetUsd` here (not just `loopState.config` above) — the ROUND N panel's own
      // target tick reads the round's OWN persisted artifact (`readSummary`), never today's live
      // config (`buildClosedRoundCostPanel`'s doc: a closed round's ceiling is historically fixed).
      artifact: { prsMerged: 1, spendUsd: 4.2, roundBudgetUsd: 15 },
    },
  ],
  events: [
    // #886 gate② run 2e566ac9 finding [0]: 9103 is deliberately never dispatched — with
    // `lanes.max: 2` above, a round selecting 3 issues into its pool while only 2 lanes work
    // concurrently is completely ordinary (the backlog buffer existing at all), not padding.
    // Without it, `state.pool` is empty at every state `npm run shots` captures (both dispatched
    // issues leave the pool by event 4), so `.hero-pool-chip` never renders in the contact sheet
    // — the shots evidence AC 1 requires can't demonstrate the backlog cards otherwise.
    { id: 1, ts: "2026-08-09T09:00:05Z", kind: "pool-selected", payload: { round_id: 5001, issues: [9101, 9102, 9103] } },
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
    // #925 AC4: the needs-attention strip's own crop-pair oracle needs >= 3 open rows across
    // >= 2 categories with distinct ages to demonstrate the fixed chip/entity/age tracks, the
    // oldest-age emphasis box, and the rust/--sap-text tone split side by side — a single
    // drive-needs-human row (the fixture's prior state) can show none of that. Two more issues
    // this round also ran into trouble, told the same lean way #886's 9103 already is (an
    // escalation-only event, no full dispatched/reclaim-done pair spelled out for it).
    //
    // B3 (#925 AC4): these three attention events (7/9/10) sit hours apart, not minutes —
    // `?demo`'s idle end-state clock is THIS round's own last event ts (id 11, `App.tsx`'s
    // `replay.asOf`, #895 item 1's own mechanism), so the strip's ages are "3h"/"1h"/"10m": three
    // rows a viewer can tell apart at a glance, spanning hours vs minutes like the mockup's own
    // "greatest age" emphasis calls for — not three renders of the same rounded day figure.
    {
      id: 7,
      ts: "2026-08-09T12:00:00Z",
      kind: "fix-rounds-capped",
      payload: { issue: 9104, pr: 9204, fixRounds: 3, cap: 3 },
    },
    { id: 8, ts: "2026-08-09T12:05:00Z", kind: "merged", payload: { issue: 9101, pr: 9201, worker: "lane-a" } },
    { id: 9, ts: "2026-08-09T14:00:00Z", kind: "drive-needs-human", payload: { issue: 9102, pr: 9202 } },
    {
      id: 10,
      ts: "2026-08-09T14:50:00Z",
      kind: "review-silence-escalated",
      payload: { worker: "lane-a", issue: 9105, pr: 9205, silenceSec: 900 },
    },
    { id: 11, ts: "2026-08-09T15:00:00Z", kind: "round-stop", payload: { detail: "issue cap reached" } },
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
