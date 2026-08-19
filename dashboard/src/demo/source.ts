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
      eventCount: 13,
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
    // event below shifts +1 for the same reason (ids 2-12, was 1-11).
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
      // #906 gate② (§927 witness gap, PO 2026-08-18): `costUsd`/`costEstimated` now match this
      // lane's own spend row (id 1, ts 09:18, $2.10, `estimated: false`) — without them the
      // replayed card fell back to "—, settles when the lane ends", contradicting the COST panel
      // on the same page. gate② finding [2] (ac5-demo-event-shape): no `pr` field — the real
      // engine never emits one on `reclaim-done` (AC5's own stated real shape); the droplet
      // learns 9201 from `merged` (below) instead, same as production would.
      payload: {
        worker: "lane-a",
        issue: 9101,
        next: "DRIVING",
        prTitle: "feat(dashboard): scrub bar chapter marks",
        costUsd: 2.1,
        costEstimated: false,
      },
    },
    {
      id: 7,
      ts: "2026-08-09T09:20:00Z",
      kind: "reclaim-done",
      // Same #906 gate② fixes as lane-a above (costUsd/costEstimated matching THIS lane's own
      // spend row, id 2, ts 09:20; no `pr` field) — lane-b's droplet learns 9202 from `pr-held`
      // below instead, witnessing the (worker, pr) pair coming from `pr-held` itself, matching
      // `lastHoldEvent`'s own server-side scoping (AC5).
      payload: {
        worker: "lane-b",
        issue: 9102,
        next: "DRIVING",
        prTitle: "fix(dashboard): header spend meter rounding",
        costUsd: 2.1,
        costEstimated: false,
      },
    },
    // #906 (§294 follow-up #7): a person puts lane-b's PR on hold shortly after it opens — the
    // ?demo fixture's own witness for the ON HOLD chip (crop-pair evidence, 1440-{dark,light}-
    // idle-lanes.png). No matching `pr-released` — the hold is still open at the fixture's own
    // idle end-state (id 13, 15:00).
    { id: 8, ts: "2026-08-09T09:25:00Z", kind: "pr-held", payload: { worker: "lane-b", issue: 9102, pr: 9202, label: "sapwood:hold" } },
    // #925 AC4: the needs-attention strip's own crop-pair oracle needs >= 3 open rows across
    // >= 2 categories with distinct ages to demonstrate the fixed chip/entity/age tracks, the
    // oldest-age emphasis box, and the rust/--sap-text tone split side by side — a single
    // drive-needs-human row (the fixture's prior state) can show none of that. Two more issues
    // this round also ran into trouble, told the same lean way #886's 9103 already is (an
    // escalation-only event, no full dispatched/reclaim-done pair spelled out for it).
    //
    // B3 (#925 AC4): these three attention events (9/11/12) sit hours apart, not minutes —
    // `?demo`'s idle end-state clock is THIS round's own last event ts (id 13, `App.tsx`'s
    // `replay.asOf`, #895 item 1's own mechanism), so the strip's ages are "3h"/"1h"/"10m": three
    // rows a viewer can tell apart at a glance, spanning hours vs minutes like the mockup's own
    // "greatest age" emphasis calls for — not three renders of the same rounded day figure.
    {
      id: 9,
      ts: "2026-08-09T12:00:00Z",
      kind: "fix-rounds-capped",
      payload: { issue: 9104, pr: 9204, fixRounds: 3, cap: 3 },
    },
    { id: 10, ts: "2026-08-09T12:05:00Z", kind: "merged", payload: { issue: 9101, pr: 9201, worker: "lane-a" } },
    { id: 11, ts: "2026-08-09T14:00:00Z", kind: "drive-needs-human", payload: { issue: 9102, pr: 9202 } },
    {
      id: 12,
      ts: "2026-08-09T14:50:00Z",
      kind: "review-silence-escalated",
      payload: { worker: "lane-a", issue: 9105, pr: 9205, silenceSec: 900 },
    },
    { id: 13, ts: "2026-08-09T15:00:00Z", kind: "round-stop", payload: { detail: "issue cap reached" } },
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
