import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { fetchEvents } from "./api/client.ts";
import { useDemoFixture, useEventHistory, useLoopState, useRounds, useSpendHistory } from "./api/queries.ts";
import type { EventsPage, Round, SpendRow } from "./api/types.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { ConfigDrawer } from "./components/ConfigDrawer.tsx";
import { Controls } from "./components/Controls.tsx";
import type { CostPanelData } from "./components/CostStrip.tsx";
import { CostStrip } from "./components/CostStrip.tsx";
import { Header, type RoundSpend, type SpendFacts } from "./components/Header.tsx";
import { IconRail } from "./components/IconRail.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import { LiveOnly } from "./components/LiveOnly.tsx";
import { NeedsAttention } from "./components/NeedsAttention.tsx";
import { PhaseInspectorDrawer } from "./components/PhaseInspectorDrawer.tsx";
import { Transport } from "./components/Transport.tsx";
import { readConfigPath } from "./config-captions.ts";
import {
  avgRoundCostUsd,
  buildClosedRoundCostPanel,
  buildTodayCostPanel,
  buildTodayCostPanelFromBuckets,
  modelCostBars,
  roundsForDay,
  sumEstCostUsd,
} from "./cost-panel.ts";
import { useDemoReplay } from "./demo/useDemoReplay.ts";
import { type DomainEvent, toDomainEvent } from "./domain-event.ts";
import type { EntityTitles } from "./entities.ts";
import { Hero } from "./hero/Hero.tsx";
import { Legend } from "./hero/Legend.tsx";
import { type FoldStep, type HeroState, initialHeroState } from "./hero/state.ts";
import type { StageNode } from "./inspector.ts";
import type { ReplayPosition } from "./replay/player.ts";
import { initialReplayState } from "./replay/reducer.ts";
import { loadRoundEvents, roundEventCeiling } from "./replay/round-log.ts";
import { buildPhaseWindows, mergeRoundPhaseBuckets, type PhaseSpendBucket, type PhaseWindow } from "./replay/spend-replay.ts";
import { loadRoundLog, type ReplayView, useReplay } from "./replay/useReplay.ts";

/**
 * #716 gate② P1-3: pulls `lanes.prFixCap` through the same nested-path reader `board.owner`/
 * `board.repo` already use — a flat `config["lanes.prFixCap"]` bracket lookup can never match
 * the server's nested allowlisted shape (`{ lanes: { prFixCap } }`), so that silently fell
 * back to the hardcoded default on every real config. Exported and pure so the regression is
 * pinned by a direct unit test: `fixCap` only ever becomes visible in rendered markup via
 * `Hero`'s animation effect, which runs in a `useEffect` — `renderToStaticMarkup`, this app's
 * only test harness, never executes those, so an App-level render test cannot observe it.
 */
export function resolveFixCap(config: Record<string, unknown> | null | undefined): number {
  const raw = config ? readConfigPath(config, "lanes.prFixCap") : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 2;
}

/** #890 gate② finding [1] (lane-bars-self-scale): `worker.budgetUsdSoft` (allowlisted config,
 *  `config-captions.ts`) — the lane card bar's own ceiling, `LaneBoard.tsx`'s `laneCostBarMax`.
 *  `null` (never a guessed number) when the config is unreadable, same honest-unknown posture
 *  `resolveFixCap` above takes for `lanes.prFixCap`. */
export function resolveWorkerBudgetUsdSoft(config: Record<string, unknown> | null | undefined): number | null {
  const raw = config ? readConfigPath(config, "worker.budgetUsdSoft") : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * PR #766 gate② audit finding [1] (header-replay-total-is-round-scoped) — round 2 of the header
 * meter fix. Round 1 (finding [0], addressed on the previous head) labeled the SELECTED round's
 * own cursor-truncated spend as `runUsd`/`todayUsd`: still wrong, because a multi-round RUN's
 * true cumulative total needs every EARLIER round's spend too, which this app never loads (only
 * the selected round's own window). Building genuine run-tier reconstruction would need either a
 * new server endpoint exposing run boundaries per round, or an expensive full-history walk for
 * `run-started` events — neither of which this codebase has today (confirmed: `/api/loop/state`'s
 * own `spend.runUsd` is unconditionally `null` server-side EVEN LIVE — `dashboard/server.ts`'s own
 * comment: "there is no honest way to compute a run-scoped sum from the DB alone"). Inventing a
 * "run" number replay itself cannot honestly produce would repeat the same mistake finding [0]
 * already made. `Header.tsx`'s new `RoundSpend`/`"round"` tier is the honest alternative used
 * here: the round's OWN persisted `roundBudgetUsd` (immutable, historically correct — never
 * today's possibly-since-changed live config, the OTHER half of finding [1]) against the SAME
 * `spendThroughCursor` sum the phase strip already reads. `artifact` is the selected round's own
 * (possibly `null` for an artifact-less round — falls back to an honest `budgetUsd: null`, same
 * never-guess posture as everywhere else in this app).
 */
export function resolveRoundSpend(replayUsd: number, artifact: unknown): RoundSpend {
  const budgetUsd =
    artifact && typeof artifact === "object" && typeof (artifact as Record<string, unknown>).roundBudgetUsd === "number"
      ? ((artifact as Record<string, unknown>).roundBudgetUsd as number)
      : null;
  return { usedUsd: replayUsd, budgetUsd };
}

/**
 * §6 phase inspector (#861), mode-purity binding: "in live mode the drawer binds to the open
 * round; in replay it binds to the scrubbed round at the cursor". `rounds` only carries a
 * PERSISTED artifact (closed rounds) — an open live round's own row (if `/api/rounds` has
 * caught up to it at all) still reads `artifact: null`, which is exactly AC6's "open round"
 * honest-unknown case, not a bug this function needs to route around. The design doc's further
 * "falling back to the most recent CLOSED round" per-phase behavior is deliberately not built
 * here — no acceptance criterion exercises it, and every phase already has a correct, honest
 * empty state without it.
 */
export function resolveInspectorArtifact(
  mode: "live" | "replay",
  rounds: readonly Round[],
  liveRoundId: number | null,
  selectedRoundId: number | null,
): unknown {
  const id = mode === "live" ? liveRoundId : selectedRoundId;
  return rounds.find((r) => r.roundId === id)?.artifact ?? null;
}

/**
 * #868 gate② finding [1] (live-event-counts-cross-round): `resolveInspectorArtifact`'s own live
 * round lookup, reused to bind the drawer's event-derived counts (Arch review / Verify) to the
 * SAME round its other fields already read — `rounds` carries the exact `startEventId`/
 * `eventCount` cursors `replay/round-log.ts` already uses to load a closed round's full log; the
 * live open round's own row (once `/api/rounds` has caught up to it) is no different in shape.
 * `null` when the round hasn't appeared in `/api/rounds` yet — `useInspectorRoundEvents` degrades
 * to an empty round-scoped list for that case, the same honest "not yet known" posture
 * `resolveInspectorArtifact` already documents for its own null.
 */
export function resolveInspectorRound(rounds: readonly Round[], liveRoundId: number | null): Round | null {
  return rounds.find((r) => r.roundId === liveRoundId) ?? null;
}

/**
 * #868 gate② finding [1]: the actual round-scoped load `useInspectorRoundEvents` awaits inside its
 * effect — factored out (the same treatment `replay/useReplay.ts`'s `loadRoundLog` already gets)
 * so a test can call it directly instead of mounting a component to reach an effect's inline
 * promise. Delegates straight to `replay/round-log.ts`'s `loadRoundEvents` — the SAME mechanism
 * replay's one-time full-round load already uses — with `ceilingId: null`: this only ever loads
 * the CURRENT open round (a closed round's own events already flow through `useReplay`'s
 * round-scoped `roundEvents`, wired in below), and an open round has no NEXT round yet to bound
 * it, so "no ceiling" is the honest boundary, not a missing one.
 *
 * Unlike `useEventHistory`'s `events` (window-capped at `MAX_EVENT_HISTORY`, `api/queries.ts`),
 * `loadRoundEvents` takes no window parameter at all — it keeps paging `/api/events` until
 * `round.eventCount` rows are collected (`replay/round-log.test.ts` already pins that property),
 * so a round longer than the live display window is never undercounted by reading this instead.
 */
export function loadInspectorRoundEvents(
  round: Round,
  fetchEventsPage: (after: number, limit: number) => Promise<EventsPage> = (after, limit) => fetchEvents({ after, limit }),
): Promise<DomainEvent[]> {
  return loadRoundEvents(round, null, fetchEventsPage);
}

/**
 * #868 gate② finding [1]: the drawer's own live-round-scoped event source. `round: null` (drawer
 * closed, or the live round hasn't appeared in `/api/rounds` yet) returns `[]` without fetching —
 * the same "nothing to load" posture `useReplay`'s own load effect takes for
 * `selectedRoundId === null`. Re-fetches whenever the round's identity OR its own `eventCount`
 * changes — `/api/rounds`' 3 s poll recomputes `eventCount` live for the currently open round
 * (`engine/src/state/state.ts`'s `listRounds` doc), so the drawer's counts keep pace with a round
 * still in progress while it's open. Mirrors `useReplay.ts`'s `resolveActiveLog`: a result whose
 * OWN round no longer matches the round CURRENTLY requested reads as absent (empty), never a
 * stale prior round's counts shown under a freshly-opened round's drawer.
 */
export function useInspectorRoundEvents(round: Round | null): DomainEvent[] {
  const [state, setState] = useState<{ roundId: number | null; events: DomainEvent[] }>({ roundId: null, events: [] });
  // `round` itself is a fresh object reference every `/api/rounds` poll — its own `roundId`/
  // `eventCount` are the only two fields that decide whether a re-fetch is warranted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above.
  useEffect(() => {
    if (!round) return;
    let cancelled = false;
    loadInspectorRoundEvents(round).then((events) => {
      if (!cancelled) setState({ roundId: round.roundId, events });
    });
    return () => {
      cancelled = true;
    };
  }, [round?.roundId, round?.eventCount]);
  return round && state.roundId === round.roundId ? state.events : [];
}

/**
 * #880: the "COST · ROUND N" panel's LIVE-mode target — the highest-`roundId` CLOSED round, since
 * live mode's round navigator has nothing explicitly selected (the LIVE slot carries no round id
 * at all). `null` (panel simply omitted, never a fabricated one) until a round has actually
 * closed. Exported and pure so the selection rule is directly testable without mounting a hook.
 */
export function findLastClosedRound(rounds: readonly Round[]): Round | null {
  return [...rounds].filter((r) => r.status === "done").sort((a, b) => b.roundId - a.roundId)[0] ?? null;
}

/**
 * #880: the async body behind `useLastClosedRoundCost` below, factored out the same way
 * `loadInspectorRoundEvents` already is — a plain function a test can call directly, never inline
 * `.then` logic inside an effect. Reuses `loadRoundLog` (`replay/useReplay.ts`) — the SAME
 * `/api/events`+`/api/spend` paging an explicitly-selected replay round already goes through, not
 * a parallel fetch implementation. `null` on a rejected load (never throws) — same "never rejects
 * itself" contract `loadRoundLog` documents for its own callers.
 *
 * #888 gate② final finding (same-timestamp round boundary): `phaseWindows` is returned RAW — an
 * earlier round of this fix capped the trailing window at the next round's own `startedAt`, which
 * excludes a round-A row whose `ts` EQUALS that boundary from round A's own window (half-open
 * `ts < endTs`) and reintroduces the identical cross-round leak at that exact tie once a caller
 * unions several rounds together. `spend` is already correctly ID-partitioned (`spendCeilingId`
 * above, never a timestamp) — the caller (`useTodayCostLog`'s `mergeRoundPhaseBuckets`) preserves
 * that same ID partition all the way through bucketing instead, so a round's own trailing window
 * can safely stay open-ended; nothing outside this round's own spend is ever compared against it.
 */
export function loadClosedRoundCostLog(
  round: Round,
  rounds: readonly Round[],
  lanesMax: number | null,
): Promise<{ spend: SpendRow[]; phaseWindows: PhaseWindow[] } | null> {
  const ceilingId = roundEventCeiling(round, rounds);
  const nextRound = rounds.filter((r) => r.roundId > round.roundId).sort((a, b) => a.roundId - b.roundId)[0];
  const spendCeilingId = nextRound ? nextRound.startSpendId : null;
  return loadRoundLog(round, ceilingId, spendCeilingId, lanesMax).then((result) =>
    result.ok ? { spend: result.log.spend, phaseWindows: result.log.phaseWindows } : null,
  );
}

/** #880: LIVE mode's own source for the "COST · ROUND N" panel — see `findLastClosedRound`'s doc
 *  for why live mode needs its own round selection at all (replay's `selectedRoundId` covers the
 *  case where the navigator has moved off HEAD). Re-fetches only when the last-closed round's OWN
 *  identity changes (a fresh round closing) — `rounds` keeps polling every 3 s regardless, so a
 *  ref (same pattern `useReplay.ts`'s own `roundsRef` already uses) keeps that poll from re-firing
 *  this fetch on every unrelated tick. */
export function useLastClosedRoundCost(
  rounds: readonly Round[],
  lanesMax: number | null,
): { round: Round; spend: SpendRow[]; phaseWindows: PhaseWindow[] } | null {
  const lastClosed = findLastClosedRound(rounds);
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;
  const [state, setState] = useState<{ roundId: number; spend: SpendRow[]; phaseWindows: PhaseWindow[] } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `rounds` intentionally excluded — read via roundsRef, same rationale useReplay.ts's own effect documents.
  useEffect(() => {
    if (!lastClosed) return;
    let cancelled = false;
    loadClosedRoundCostLog(lastClosed, roundsRef.current, lanesMax).then((result) => {
      if (cancelled || !result) return;
      setState({ roundId: lastClosed.roundId, spend: result.spend, phaseWindows: result.phaseWindows });
    });
    return () => {
      cancelled = true;
    };
  }, [lastClosed?.roundId, lanesMax]);

  if (!lastClosed) return null;
  const active = state?.roundId === lastClosed.roundId;
  return { round: lastClosed, spend: active ? state.spend : [], phaseWindows: active ? state.phaseWindows : [] };
}

/**
 * #880 gate② finding today-stage-history-truncation: the "COST · TODAY" by-stage group used to
 * read `useEventHistory`'s bounded `events` tail and `useSpendHistory`'s bounded `rows` tail —
 * two INDEPENDENTLY sized eviction caps, so a spend row could outlive its own `round-phase` window
 * once the smaller events cap evicted it first (misclassifying it as `Unattributed`), or vanish
 * from the total entirely once the spend cap evicted it too — while the server-backed by-model
 * total (`loop.data.spend.byModel`) stayed complete the whole time, a visible mismatch. This unions
 * every round that started TODAY's own FULL, uncapped log instead — the SAME durable per-round
 * fetch (`loadClosedRoundCostLog`/`loadRoundLog`) the ROUND N panel already uses for one round, run
 * over every round `roundsForDay` names. Bounded by "how many rounds ran today" (a small, real
 * number), never a rolling eviction window — no row can age out from underneath it. `allRounds`
 * (not just `todayRounds`) is what each fetch's own ceiling computation needs — a today-round's
 * "next round" boundary can itself start tomorrow, and `loadClosedRoundCostLog` already handles
 * that correctly given the full list.
 *
 * #888 gate② run 949439c8 finding [1]: the round ID SET alone only changes when a round OPENS or
 * CLOSES — a round already in the set gaining a fresh phase transition or spend row left the set
 * untouched, so this effect never re-ran while that round was still in progress, and TODAY's
 * by-stage panel froze at its first snapshot for the rest of the round. `freshnessKey` below folds
 * in TWO more already-flowing signals rather than opening a new polling channel of its own: each
 * round's own `eventCount` (the identical live cursor `useInspectorRoundEvents` above already keys
 * on, for the same "still-open round" reason) covers a fresh phase transition, and `todaySpendUsd`
 * (the server-aggregated total `/api/loop/state`'s poll already carries) covers a fresh spend row
 * landing without necessarily moving any round's own event count in the same tick.
 *
 * #888 gate② final finding (same-timestamp round boundary): each round's `{spend, phaseWindows}`
 * result is bucketed through `mergeRoundPhaseBuckets` — per round, BEFORE merging — rather than
 * flattened into two combined `spend`/`phaseWindows` arrays for a single `bucketSpendByPhase`
 * call. The flattened shape discarded the ID partition `loadClosedRoundCostLog` already gives each
 * round, letting a round-A row's timestamp match a DIFFERENT round's window (up to and including a
 * same-millisecond boundary tie) purely because both ended up in the same combined array — see
 * `mergeRoundPhaseBuckets`'s own doc.
 */
export function useTodayCostLog(
  todayRounds: readonly Round[],
  allRounds: readonly Round[],
  lanesMax: number | null,
  todaySpendUsd: number | null,
): { buckets: PhaseSpendBucket[] } {
  const freshnessKey = `${todayRounds.map((r) => `${r.roundId}:${r.eventCount}`).join(",")}|${todaySpendUsd ?? ""}`;
  const allRoundsRef = useRef(allRounds);
  allRoundsRef.current = allRounds;
  const todayRoundsRef = useRef(todayRounds);
  todayRoundsRef.current = todayRounds;
  const [state, setState] = useState<{ key: string; buckets: PhaseSpendBucket[] }>({ key: "", buckets: [] });

  // `todayRounds`/`allRounds` are read via the refs above (same rationale useReplay.ts's own
  // effect documents) — only `freshnessKey` (round set + each round's own eventCount + today's
  // spend total) should retrigger this fetch, not every unrelated `/api/rounds`/`/api/loop/state`
  // poll tick that changes neither.
  useEffect(() => {
    const rounds = todayRoundsRef.current;
    if (rounds.length === 0) {
      setState({ key: freshnessKey, buckets: [] });
      return;
    }
    let cancelled = false;
    Promise.all(rounds.map((round) => loadClosedRoundCostLog(round, allRoundsRef.current, lanesMax))).then((results) => {
      if (cancelled) return;
      const roundLogs = results.filter((r): r is { spend: SpendRow[]; phaseWindows: PhaseWindow[] } => r !== null);
      setState({ key: freshnessKey, buckets: mergeRoundPhaseBuckets(roundLogs) });
    });
    return () => {
      cancelled = true;
    };
  }, [freshnessKey, lanesMax]);

  return { buckets: state.key === freshnessKey ? state.buckets : [] };
}

type ActiveFold = {
  hero: HeroState;
  steps: FoldStep[];
  events: DomainEvent[];
  titles: EntityTitles;
  openAttention: DomainEvent[];
};

/**
 * PR #766 gate② audit finding [2] (replay-loading-leaks-live-fold): `mode` flips to `"replay"`
 * the instant a round is selected, but `replay.position` stays `null` until the round's full
 * event/spend log finishes loading (`useReplay`'s async fetch) — the previous code's
 * `mode === "replay" && replay.position ? ... : events.*` fell through to the LIVE fold for that
 * whole window, so a screen labeled as a closed-round replay silently showed present live data
 * until the load resolved. `emptyReplay` (the caller's `initialReplayState(lanesMax)`) is what
 * every replayable panel renders instead during that window — a neutral, honestly-empty replay
 * state, never a borrowed live one. Pure and directly testable: no hooks, no async load required
 * to prove the loading window never leaks `live`'s values.
 */
export function resolveActiveFold(
  mode: "live" | "replay",
  replayPosition: ReplayPosition | null,
  live: ActiveFold,
  emptyReplay: ReturnType<typeof initialReplayState>,
): ActiveFold {
  if (mode === "live") return live;
  const state = replayPosition?.state ?? emptyReplay;
  return { hero: state.hero, steps: [], events: state.events, titles: state.titles, openAttention: Object.values(state.openAttention) };
}

/**
 * The exact toggle `onOpenConfig` runs — extracted (#727 gate② finding
 * config-trigger-wiring-unexercised) so a test can drive `IconRail`'s REAL rendered gear
 * (`components/IconRail.tsx#railContent`) through this SAME function and observe `configOpen`
 * flip, rather than only asserting the gear's markup exists or presetting `configOpen` directly.
 */
export function toggleConfigOpen(open: boolean): boolean {
  return !open;
}

type AppViewModel = {
  clock: Date;
  loop: ReturnType<typeof useLoopState>;
  events: ReturnType<typeof useEventHistory>;
  disconnected: boolean;
  parked: boolean;
  repoUrl: string | undefined;
  fixCap: number;
  // #880: the rebuilt two-panel cost composition (`cost-dark.png`) — `costRound` is `null` until a
  // round has actually closed (live: nothing closed yet today; replay/demo: unreachable, since a
  // navigable round is by definition closed).
  costToday: CostPanelData;
  costRound: CostPanelData | null;
  configOpen: boolean;
  setConfigOpen: Dispatch<SetStateAction<boolean>>;
  // #861: which stage node's drawer is open (null = closed) + the round data it reads.
  inspectorNode: StageNode | null;
  setInspectorNode: Dispatch<SetStateAction<StageNode | null>>;
  inspectorArtifact: unknown;
  /** #868 gate② finding [1]: the round-scoped source for the drawer's Arch review/Verify
   *  event-derived counts — NEVER `activeEvents` (the shared display tail: process-wide,
   *  window-bounded, and in live mode not filtered to the open round at all). Live mode reads
   *  `useInspectorRoundEvents`'s own round-scoped fetch; replay/demo read `replay.roundEvents`
   *  (the selected round's already-loaded, uncapped full log) — see those two hooks' own docs. */
  inspectorEvents: DomainEvent[];
  // #741: the round navigator's list + the replay transport/mode it drives — §3 A's "the round
  // navigator IS the mode", so every replayable panel below reads whichever fold is active.
  mode: "live" | "replay";
  rounds: Round[];
  /** #889: the header navigator's LIVE-slot round id — the currently OPEN round in live mode,
   *  `null` in demo (no live engine to have an open round at all) or before `/api/rounds` has
   *  caught up to it. */
  liveRoundId: number | null;
  replay: ReplayView;
  activeHero: HeroState;
  activeSteps: FoldStep[];
  activeEvents: DomainEvent[];
  activeTitles: EntityTitles;
  activeOpenAttention: DomainEvent[];
  /** The header meter's LIVE spend snapshot — used only in live mode; in replay `roundSpend`
   *  below always wins (Header.tsx's own `RoundSpend`-overrides-`SpendFacts` contract). */
  spendFacts: SpendFacts | undefined;
  /** #766 gate② finding [1]: the header meter's honest replay reading — `resolveRoundSpend`'s
   *  output, present only in replay mode. `undefined` in live mode, where `spendFacts` alone
   *  drives the meter. */
  roundSpend: RoundSpend | undefined;
  /** #890 (§3 E): the header meter's est tail — `sumEstCostUsd` over the live lanes, live mode
   *  only (`undefined` in replay/demo, where no lane is actually running). */
  estUsd: number | undefined;
};

/**
 * The ACTUAL markup `App` renders, factored out as a plain, hooks-free function (#727 gate②
 * finding config-app-wiring-still-unexercised) — the same treatment `IconRail.tsx#railContent`
 * already got, one level up. Calling `App(...)` directly outside a real render throws (hooks
 * need a dispatcher), and `renderToStaticMarkup` strips event-handler props from its HTML
 * output, so neither route let a test reach the REAL `<IconRail onOpenConfig={...}>` prop this
 * function creates — every previous round's "interaction" test could only exercise a
 * test-reconstructed equivalent (a hand-built `railContent(...)` call, a `configOpen` preset),
 * never App's own wiring. This function IS that wiring: a test can call it with a spy in place
 * of `setConfigOpen`, walk to the real `IconRail` element it returns, and call its real
 * `onOpenConfig` prop directly.
 */
export function appContent(vm: AppViewModel) {
  const {
    clock,
    loop,
    disconnected,
    parked,
    repoUrl,
    fixCap,
    costToday,
    costRound,
    configOpen,
    setConfigOpen,
    inspectorNode,
    setInspectorNode,
    inspectorArtifact,
    inspectorEvents,
    mode,
    rounds,
    liveRoundId,
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts,
    roundSpend,
    estUsd,
  } = vm;
  const onInspect = (node: StageNode) => setInspectorNode(node);
  return (
    <div className="app-shell">
      <IconRail onOpenConfig={() => setConfigOpen(toggleConfigOpen)} />
      <main className="stack">
        <header id="overview" className="panel app-header">
          <Header
            disconnected={disconnected}
            isPending={loop.isPending}
            engine={
              loop.data
                ? {
                    state: loop.data.engine.state,
                    pauseActive: loop.data.engine.pauseActive,
                    standbyNextCheckSec: loop.data.engine.standbyNextCheckSec,
                  }
                : undefined
            }
            spend={spendFacts}
            round={roundSpend}
            estUsd={estUsd}
            parked={parked}
            rounds={rounds}
            selectedRoundId={replay.selectedRoundId}
            onSelectRound={replay.selectRound}
            liveRoundId={liveRoundId}
            now={clock}
          />
          {/* §3 Operations: the engine control verbs hide entirely while viewing a closed round —
              they act on the PRESENT engine while every other pixel shows an as-of-cursor past. */}
          <Controls
            enabled={(loop.data?.controlsEnabled ?? false) && mode === "live"}
            running={loop.data?.engine.state === "running"}
            estopActive={loop.data?.engine.estopActive ?? false}
          />
          <Legend />
        </header>

        <Transport
          rounds={rounds}
          selectedRoundId={replay.selectedRoundId}
          onSelectRound={replay.selectRound}
          cursorId={replay.position?.cursorId ?? 0}
          playing={replay.playing}
          speed={replay.speed}
          onPlay={replay.play}
          onPause={replay.pause}
          onSpeed={replay.setSpeed}
          onScrub={replay.scrub}
          loading={replay.loading}
          loadError={replay.loadError}
          onRetry={replay.retryLoad}
          disconnected={disconnected}
          now={clock}
        />

        <NeedsAttention
          items={activeOpenAttention}
          titles={activeTitles}
          repoUrl={repoUrl}
          now={clock}
          onInspect={onInspect}
          roundEscalated={activeHero.roundEscalated}
        />

        {loop.data && (
          <Hero
            heroState={activeHero}
            steps={activeSteps}
            lanesMax={loop.data.lanes.max}
            engine={loop.data.engine.state}
            lanes={mode === "live" ? loop.data.lanes.items : []}
            mergedPrs={mode === "live" ? loop.data.mergedPrs : []}
            fixCap={fixCap}
            roundPhase={mode === "live" ? (loop.data.round?.phase ?? null) : null}
            config={loop.data.config}
            onInspect={onInspect}
            openAttention={activeOpenAttention}
          />
        )}

        {/*
         * #897 AC5: `.stack`'s own `grid-template-columns: repeat(auto-fit, …)` is ONE shared
         * column template across every row — a `grid-column: 1/-1` item elsewhere (header, hero,
         * cost strip, …) marks every one of those columns "occupied" for the auto-fit collapse
         * rule, even in a row where this pair are the only two items actually placed into them.
         * Result: the columns beyond what this pair needs never collapse, and the row leaves the
         * canvas's other half empty (the live bug this AC fixes). Wrapping the pair in their own
         * nested auto-fit grid, itself spanning the full row (`.lane-activity-row` in app.css),
         * gives auto-fit's collapse rule a column template used ONLY by these two items — it
         * correctly collapses to exactly what's present, filling the row.
         *
         * §11 boundary rule: `workers` is a mutable snapshot, not an append-only source — a lane
         * card's state/PR/elapsed/settled-cost has no replay-reconstructed equivalent today, so
         * the whole board is live-only rather than risk rendering a stale live snapshot under a
         * replay cursor.
         */}
        <div className="lane-activity-row">
          <LiveOnly mode={mode}>
            <LaneBoard
              lanesMax={loop.data?.lanes.max ?? null}
              lanes={loop.data?.lanes.items ?? []}
              titles={activeTitles}
              repoUrl={repoUrl}
              disconnected={disconnected}
              workerBudgetUsdSoft={resolveWorkerBudgetUsdSoft(loop.data?.config)}
            />
          </LiveOnly>

          <ActivityFeed
            events={activeEvents}
            pinnedAttention={activeOpenAttention}
            titles={activeTitles}
            repoUrl={repoUrl}
            disconnected={disconnected}
          />
        </div>

        <CostStrip today={costToday} round={costRound} />

        {configOpen && (
          <LiveOnly mode={mode}>
            <ConfigDrawer config={loop.data?.config ?? null} open onClose={() => setConfigOpen(false)} />
          </LiveOnly>
        )}

        {/* §6 phase inspector (#861) — unlike ConfigDrawer, this is NOT live-only: §6's own mode
         *  purity rule binds it to whichever round (live open, or replay cursor) is active.
         *  #868 gate② finding [1]: `events` is `inspectorEvents` (the round-scoped source), NEVER
         *  `activeEvents` — the shared display tail, process-wide and window-bounded. */}
        <PhaseInspectorDrawer
          node={inspectorNode}
          onClose={() => setInspectorNode(null)}
          artifact={inspectorArtifact}
          events={inspectorEvents}
          config={loop.data?.config ?? null}
          logPath={mode === "live" ? (loop.data?.logPath ?? null) : null}
          repoUrl={repoUrl}
          titles={activeTitles}
        />
      </main>
    </div>
  );
}

type AppProps = { now?: Date | undefined; initialConfigOpen?: boolean | undefined };

/**
 * The header (A) + hero (B, #144) + lane board (C) + activity feed (D) + cost strip/config
 * drawer (E) from frontend-design.md §3, all against the same §8 data hooks. `now` is
 * test-only (defaults to the real clock) — the "COST · TODAY" panel's day boundary (`roundsForDay`)
 * needs a fixed instant to assert against. `initialConfigOpen` is test-only too, same posture as `now`.
 * All rendering lives in `appContent` above; this function only resolves the live queries/state
 * hooks require and hands the result straight through.
 */
function LiveApp({ now, initialConfigOpen }: AppProps) {
  const clock = now ?? new Date();
  const loop = useLoopState();
  // #740: `lanesMax` flows into the shared reducer so its hero slice re-fits its channel count
  // the same way `Hero.tsx` used to do internally — see `useEventHistory`'s own doc.
  const lanesMax = loop.data?.lanes.max ?? null;
  const events = useEventHistory(lanesMax);
  const spend = useSpendHistory();
  const [configOpen, setConfigOpen] = useState(initialConfigOpen ?? false);
  const [inspectorNode, setInspectorNode] = useState<StageNode | null>(null);

  // #741: the round navigator's list (§8 `/api/rounds`) and the replay transport it drives
  // (play/pause/speed/scrub, §6). `mode` is carried by round selection, not a separate toggle —
  // §3 A's "the round navigator IS the mode".
  const rounds = useRounds();
  const allRounds = rounds.data?.rounds ?? [];
  const replay = useReplay(allRounds, lanesMax);
  const { mode } = replay;

  // §9/§11: one reducer, live and replay both feed it — every replayable panel below reads
  // whichever of these two folds is active, never a mix. `resolveActiveFold` (#766 gate② finding
  // [2]) is what keeps the LOADING window (mode already "replay", `replay.position` still null
  // while the round's log fetches) from falling through to live's values — it renders the
  // neutral empty replay state instead. ponytail: replay does not yet narrate per-frame Hero
  // animation (steps stay empty even once loaded) — add when a replay-specific playback plan is
  // worth the complexity; §6's coalescing policy already treats ≥×4 replay as instant swaps.
  const {
    hero: activeHero,
    steps: activeSteps,
    events: activeEvents,
    titles: activeTitles,
    openAttention: activeOpenAttention,
  } = resolveActiveFold(mode, replay.position, events, initialReplayState(lanesMax));

  // §3's documented `disconnected` header state: ANY of the FOUR queries failing means the
  // dashboard has lost part of its one data source, regardless of which one (#715 gate② [7] —
  // this used to render only `loop.error`'s raw message, and nothing at all when just the events
  // query failed; #715 gate② round 4 [2] — `spend` was still missing, so a lone `/api/spend`
  // failure left the header looking normal while the cost strip silently misreported "no spend
  // yet today"; #766 gate② finding [2] round 3 — `rounds` was still missing too: a failed
  // `/api/rounds` fetch left the header reading healthy while `rounds.data?.rounds ?? []`
  // silently rendered the truthful-empty "no rounds yet" caption, converting a real transport
  // failure into an honest-looking empty history).
  const disconnected = loop.isError || Boolean(events.error) || Boolean(spend.error) || rounds.isError;
  // §3 A: env-park folds into the standby/"waiting" tier rather than an eighth state word — read
  // straight off the SAME open-attention fold the needs-attention strip already renders, never a
  // second park signal. Read off whichever fold is active (live or replay) — mode purity (§11).
  const parked = activeOpenAttention.some((e) => e.kind === "park-escalated");
  const owner = loop.data?.config ? readConfigPath(loop.data.config, "board.owner") : undefined;
  const repo = loop.data?.config ? readConfigPath(loop.data.config, "board.repo") : undefined;
  const repoUrl = typeof owner === "string" && typeof repo === "string" ? `https://github.com/${owner}/${repo}` : undefined;
  const fixCap = resolveFixCap(loop.data?.config);

  // #880 gate② finding today-stage-history-truncation: "COST · TODAY" by-stage bars union every
  // round that started today's own FULL, uncapped log (`useTodayCostLog`) — never
  // `useEventHistory`/`useSpendHistory`'s bounded display tails, whose independent eviction caps
  // could silently misclassify or drop a still-real row. Model bars reuse the server-aggregated
  // `spend.byModel` (already today-scoped, already unbounded) rather than re-deriving the same
  // total a second way from raw rows. `avgRoundCostUsd` is scoped to the SAME today-started round
  // set (gate② finding cost-doc-source-mismatch: the doc names "today's closed rounds", not every
  // round ever).
  const todayRounds = roundsForDay(allRounds, clock);
  // #888 gate② run 949439c8 finding [1]: `todayUsd` is the already-flowing freshness signal that
  // lets `useTodayCostLog` notice a spend row landing on a round already in its set (see that
  // hook's own doc).
  const todayLog = useTodayCostLog(todayRounds, allRounds, lanesMax, loop.data?.spend.todayUsd ?? null);
  const todayModelBars = (loop.data?.spend.byModel ?? []).map((m) => ({ label: m.model, usd: m.usd }));
  const roundBudgetUsdConfig = ((): number | null => {
    const raw = loop.data?.config ? readConfigPath(loop.data.config, "cost.roundBudgetUsd") : undefined;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  })();
  // #890 (§3 E): the header meter's and the "Lanes" stage bar's shared est source — live lanes
  // only (`mode === "replay"` has no live lane data to sum, same gate `Hero`'s own `lanes` prop
  // above already applies).
  const lanesEstUsd = mode === "live" ? sumEstCostUsd(loop.data?.lanes.items ?? []) : 0;
  const costToday = buildTodayCostPanelFromBuckets(
    todayLog.buckets,
    todayModelBars,
    avgRoundCostUsd(todayRounds),
    roundBudgetUsdConfig,
    lanesEstUsd,
  );

  // #880: "COST · ROUND N" — a round explicitly selected in the navigator (replay mode) reads its
  // OWN full, never-cursor-truncated log (`replay.roundSpend`/`replay.phaseWindows` — see
  // `useReplay.ts`'s doc for why); at LIVE (nothing selected — the navigator's LIVE slot has no
  // round id), the last-closed round's own fetch (`useLastClosedRoundCost`) fills the same slot.
  const lastClosedRoundCost = useLastClosedRoundCost(allRounds, lanesMax);
  const selectedRound = mode === "replay" ? (allRounds.find((r) => r.roundId === replay.selectedRoundId) ?? null) : null;
  const costRound =
    mode === "replay" && selectedRound
      ? buildClosedRoundCostPanel(selectedRound, replay.roundSpend, replay.phaseWindows)
      : mode === "live" && lastClosedRoundCost
        ? buildClosedRoundCostPanel(lastClosedRoundCost.round, lastClosedRoundCost.spend, lastClosedRoundCost.phaseWindows)
        : null;

  // #766 gate② finding [1]: the header meter's replay reading — the SAME `spendThroughCursor` rows
  // (cursor-truncated, unlike `costRound` above) against the SELECTED round's own persisted
  // `roundBudgetUsd` (never today's live config). `spendFacts` (live) is passed through
  // unconditionally too — Header.tsx's `round` prop always wins over it when both are present, so
  // live mode is unaffected.
  const selectedRoundArtifact = selectedRound?.artifact ?? null;
  const roundSpend =
    mode === "replay"
      ? resolveRoundSpend(
          replay.spendThroughCursor.reduce((sum, r) => sum + r.usd, 0),
          selectedRoundArtifact,
        )
      : undefined;
  // #861: bound per §6's mode-purity rule — see `resolveInspectorArtifact`'s own doc.
  const inspectorArtifact = resolveInspectorArtifact(mode, allRounds, loop.data?.round?.id ?? null, replay.selectedRoundId);
  // #868 gate② finding [1]: the round-scoped event source for the drawer's Arch review/Verify
  // counts — live mode fetches it fresh (only while the drawer is actually open, `inspectorNode
  // !== null`, so a closed drawer never polls a round log nobody is looking at); replay reads
  // `replay.roundEvents`, the selected round's own already-loaded, uncapped full log (`useReplay`'s
  // own doc) rather than a second parallel fetch.
  const inspectorRound = resolveInspectorRound(allRounds, loop.data?.round?.id ?? null);
  const inspectorLiveEvents = useInspectorRoundEvents(mode === "live" && inspectorNode !== null ? inspectorRound : null);
  const inspectorEvents = mode === "live" ? inspectorLiveEvents : replay.roundEvents;

  return appContent({
    clock,
    loop,
    events,
    disconnected,
    parked,
    repoUrl,
    fixCap,
    costToday,
    costRound,
    configOpen,
    setConfigOpen,
    inspectorNode,
    setInspectorNode,
    inspectorArtifact,
    inspectorEvents,
    mode,
    rounds: allRounds,
    liveRoundId: loop.data?.round?.id ?? null,
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts: loop.data?.spend,
    roundSpend,
    estUsd: mode === "live" ? lanesEstUsd : undefined,
  });
}

/**
 * `?demo` (#742, split 3/4 of #146): the SAME `appContent` shell `LiveApp` renders, sourced from a
 * static, build-time-exported `DemoBundle` instead of the four live `/api/*` queries —
 * `useDemoFixture` is a ONE-SHOT fetch of `/demo-fixture.json` (never `/api/loop/state` or
 * `/api/events`), and `useDemoReplay` folds it through the identical replay/player machinery
 * `LiveApp`'s own `useReplay` uses (§9 "one state reducer"). `mode` is always `"replay"` once the
 * fixture loads — there is no live engine to fall back to — which is exactly why every "live only"
 * panel (`LaneBoard`, `ConfigDrawer`, the engine control verbs) already greys out for free: the
 * SAME wiring `appContent` already uses whenever a closed round is selected under live mode.
 */
function DemoApp({ now, initialConfigOpen }: AppProps) {
  const clock = now ?? new Date();
  const [configOpen, setConfigOpen] = useState(initialConfigOpen ?? false);
  const [inspectorNode, setInspectorNode] = useState<StageNode | null>(null);

  const fixture = useDemoFixture();
  const bundle = fixture.data;
  const lanesMax = bundle?.loopState.lanes.max ?? null;
  const replay = useDemoReplay(bundle, lanesMax);
  const { mode } = replay;

  // A neutral, honestly-empty stand-in for BOTH `appContent`'s (unused-by-it) `events` field and
  // `resolveActiveFold`'s `live` argument — demo mode has no live source at all, so this is what
  // renders during the brief window before the fixture fetch settles (mode reads "live" only
  // until `useDemoReplay` picks the bundle's first round), same neutral-empty posture #766 gate②
  // finding [2] established for the equivalent live-mode loading window.
  const emptyLive = {
    hero: initialHeroState(lanesMax),
    steps: [] as FoldStep[],
    events: [] as DomainEvent[],
    titles: {} as EntityTitles,
    openAttention: [] as DomainEvent[],
    error: undefined as unknown,
    isPending: fixture.isPending,
  };

  const {
    hero: activeHero,
    steps: activeSteps,
    events: activeEvents,
    titles: activeTitles,
    openAttention: activeOpenAttention,
  } = resolveActiveFold(mode, replay.position, emptyLive, initialReplayState(lanesMax));

  const rounds = bundle?.rounds ?? [];
  // The fixture itself is the only thing that can fail to load — never `/api/loop/state`/
  // `/api/events`/`/api/spend`/`/api/rounds`, none of which this route ever calls.
  const disconnected = fixture.isError;
  const parked = activeOpenAttention.some((e) => e.kind === "park-escalated");
  const owner = bundle?.loopState.config ? readConfigPath(bundle.loopState.config, "board.owner") : undefined;
  const repo = bundle?.loopState.config ? readConfigPath(bundle.loopState.config, "board.repo") : undefined;
  const repoUrl = typeof owner === "string" && typeof repo === "string" ? `https://github.com/${owner}/${repo}` : undefined;
  const fixCap = resolveFixCap(bundle?.loopState.config);

  // #880: "COST · TODAY" — demo mode has no separate live/replay data source for "today"; the
  // whole in-memory fixture (`bundle.events`/`bundle.spend`/`rounds`, never cursor-truncated, so
  // no eviction-cap truncation risk the way live mode's bounded tails have) stands in for it
  // WHOLESALE, the same way `bundle` already stands in for every other live source this route
  // replaces — so every round in the bundle counts toward `avgRoundCostUsd`, never day-filtered
  // (`LiveApp`'s own day filter has nothing to anchor to here: the fixture's `startedAt` is a
  // fixed historical recording date, not "today" in any wall-clock sense — filtering by `clock`
  // would silently empty the header the moment the shipped recording ages past its own day).
  const bundleEvents = (bundle?.events ?? []).map(toDomainEvent);
  const demoRoundBudgetUsd = ((): number | null => {
    const raw = bundle?.loopState.config ? readConfigPath(bundle.loopState.config, "cost.roundBudgetUsd") : undefined;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  })();
  const costToday = buildTodayCostPanel(
    bundle?.spend ?? [],
    buildPhaseWindows(bundleEvents),
    modelCostBars(bundle?.spend ?? []),
    avgRoundCostUsd(rounds),
    demoRoundBudgetUsd,
  );
  // #880: "COST · ROUND N" — the selected round's own full log, same never-cursor-truncated
  // reading `LiveApp`'s replay branch uses (`replay.roundSpend`/`phaseWindows`).
  const selectedRound = rounds.find((r) => r.roundId === replay.selectedRoundId) ?? null;
  const costRound = selectedRound ? buildClosedRoundCostPanel(selectedRound, replay.roundSpend, replay.phaseWindows) : null;
  const selectedRoundArtifact = selectedRound?.artifact ?? null;
  const roundSpend =
    mode === "replay"
      ? resolveRoundSpend(
          replay.spendThroughCursor.reduce((sum, r) => sum + r.usd, 0),
          selectedRoundArtifact,
        )
      : undefined;
  // #861: demo mode has no live open round at all — see this function's own doc.
  const inspectorArtifact = resolveInspectorArtifact(mode, rounds, null, replay.selectedRoundId);

  return appContent({
    clock,
    loop: { data: bundle?.loopState, isPending: fixture.isPending } as unknown as ReturnType<typeof useLoopState>,
    events: emptyLive,
    disconnected,
    parked,
    repoUrl,
    fixCap,
    costToday,
    costRound,
    configOpen,
    setConfigOpen,
    inspectorNode,
    setInspectorNode,
    inspectorArtifact,
    // #868 gate② finding [1]: demo mode is always "replay" once loaded — the fixture's
    // round-scoped `replay.roundEvents` (already uncapped, already the selected round's own
    // events, `useDemoReplay`'s own doc) is the only source this route ever needs.
    inspectorEvents: replay.roundEvents,
    mode,
    rounds,
    // #889: demo mode has no live open round at all — see `resolveInspectorArtifact`'s own doc.
    liveRoundId: null,
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts: bundle?.loopState.spend,
    roundSpend,
    // #890: demo mode is always "replay" (this function's own doc) — no live lane exists to sum
    // an est from, same honest-absent posture `liveRoundId`/`inspectorEvents` above already take.
    estUsd: undefined,
  });
}

/** `?demo` (#742): true when the URL's query string carries `demo`. `window` is absent under this
 *  repo's `renderToStaticMarkup`-only test harness (no jsdom) — a real browser is the only
 *  environment where this reads anything but the explicit `demo` prop `App` accepts below. */
function isDemoRoute(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
}

/**
 * The one production entry point (`main.tsx`) renders. Routes to `DemoApp` or `LiveApp` — never
 * both, never a shared hook call between them (`isDemo` is fixed for the lifetime of a mounted
 * `App` instance, since the URL this reads never changes without a full page reload) — so neither
 * branch ever calls a hook the other doesn't, which is what keeps this rules-of-hooks-safe despite
 * looking like a runtime branch. `demo` is a test-only override, same posture as `now`/
 * `initialConfigOpen`: a real `?demo` visit never sets it, relying on `isDemoRoute()` instead.
 */
export function App({ now, initialConfigOpen, demo }: AppProps & { demo?: boolean | undefined } = {}) {
  const isDemo = demo ?? isDemoRoute();
  return isDemo ? <DemoApp now={now} initialConfigOpen={initialConfigOpen} /> : <LiveApp now={now} initialConfigOpen={initialConfigOpen} />;
}
