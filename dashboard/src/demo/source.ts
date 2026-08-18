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
      endedAt: "2026-08-09T09:42:00Z",
      // #793 gate② finding [1]: EXCLUSIVE cursors (`engine/src/state/state.ts`'s `listRounds()`:
      // `e.id > r.start_event_id`) — 0, the id of the (nonexistent) row before this fixture's
      // first real row (id 1), not the first included row's own id.
      startEventId: 0,
      startSpendId: 0,
      eventCount: 10,
      schemaVersion: 1,
      // #880: `roundBudgetUsd` here (not just `loopState.config` above) — the ROUND N panel's own
      // target tick reads the round's OWN persisted artifact (`readSummary`), never today's live
      // config (`buildClosedRoundCostPanel`'s doc: a closed round's ceiling is historically fixed).
      artifact: { prsMerged: 1, spendUsd: 4.2, roundBudgetUsd: 15 },
    },
  ],
  events: [
    // #922 AC5 gate② finding [5] (ac5-active-capture): the round's own real opening phase — every
    // recorded round starts `aligning` before its dispatch loop begins (`round-phase`'s own real
    // wire shape, `PLANNING_PHASE`, state.ts), but this fixture previously jumped straight to
    // "executing" (below), so `?demo`'s replay cursor could never land on a moment with a RUNNING
    // planning/reflection node — no capture could ever show the hero's own breathing-disc halo.
    // `ts` matches `rounds[0].startedAt` exactly (the round's own first instant). `id: 1` (not
    // `0`) deliberately — `state.ts`'s hero fold treats `id: 0` as its own "nothing folded yet"
    // sentinel (the SAME guard `foldReplay`'s own id-idempotency doc references), so an event
    // literally carrying `id: 0` silently never folds into `state.events` at all. Every OTHER
    // event below shifts +1 for the same reason (ids 2-10, was 1-9).
    { id: 1, ts: "2026-08-09T09:00:00Z", kind: "round-phase", payload: { round_id: 5001, phase: "aligning" } },
    // #886 gate② run 2e566ac9 finding [0]: 9103+ are deliberately never dispatched — with
    // `lanes.max: 2` above, a round selecting more issues into its pool while only 2 lanes work
    // concurrently is completely ordinary (the backlog buffer existing at all), not padding.
    // Without it, `state.pool` is empty at every state `npm run shots` captures (both dispatched
    // issues leave the pool by event 4), so `.hero-pool-chip` never renders in the contact sheet
    // — the shots evidence AC 1 requires can't demonstrate the backlog cards otherwise.
    // #922 AC3: 6 undispatched issues (9103-9108) so the captured backlog carries the AC's own
    // floor — >= 3 filled `.hero-pool-chip` + >= 3 outlined `.hero-pool-candidate` — once 9101/
    // 9102 leave the pool below.
    {
      id: 2,
      ts: "2026-08-09T09:00:05Z",
      kind: "pool-selected",
      payload: { round_id: 5001, issues: [9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108] },
    },
    { id: 3, ts: "2026-08-09T09:00:10Z", kind: "round-phase", payload: { round_id: 5001, phase: "executing" } },
    {
      id: 4,
      ts: "2026-08-09T09:01:00Z",
      kind: "dispatched",
      payload: { worker: "lane-a", issue: 9101, issueTitle: "Add scrub bar chapter marks" },
    },
    {
      id: 5,
      ts: "2026-08-09T09:01:30Z",
      kind: "dispatched",
      payload: { worker: "lane-b", issue: 9102, issueTitle: "Fix header spend meter rounding" },
    },
    {
      id: 6,
      ts: "2026-08-09T09:18:00Z",
      kind: "reclaim-done",
      payload: { worker: "lane-a", issue: 9101, next: "DRIVING", pr: 9201, prTitle: "feat(dashboard): scrub bar chapter marks" },
    },
    {
      id: 7,
      ts: "2026-08-09T09:20:00Z",
      kind: "reclaim-done",
      payload: { worker: "lane-b", issue: 9102, next: "DRIVING", pr: 9202, prTitle: "fix(dashboard): header spend meter rounding" },
    },
    { id: 8, ts: "2026-08-09T09:25:00Z", kind: "merged", payload: { issue: 9101, pr: 9201, worker: "lane-a" } },
    { id: 9, ts: "2026-08-09T09:30:00Z", kind: "drive-needs-human", payload: { issue: 9102, pr: 9202 } },
    { id: 10, ts: "2026-08-09T09:42:00Z", kind: "round-stop", payload: { detail: "issue cap reached" } },
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
