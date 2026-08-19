import { FastForward } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { fetchEvents } from "./api/client.ts";
import { POLL_MS, useDemoFixture, useEventHistory, useLoopState, useRounds, useSpendHistory } from "./api/queries.ts";
import type { EventsPage, Lane, Round, SpendRow } from "./api/types.ts";
import { BUILD_SHA, BUILD_TIME } from "./build-info.ts";
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
import {
  buildPhaseWindows,
  mergeRoundPhaseBuckets,
  type PhaseSpendBucket,
  type PhaseWindow,
  phaseAtCursor,
} from "./replay/spend-replay.ts";
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

/** #890: `worker.budgetUsdSoft` (allowlisted config, `config-captions.ts`) — the lane card
 *  bar's own ceiling, `LaneBoard.tsx`'s `laneCostBarMax`.
 *  `null` (never a guessed number) when the config is unreadable, same honest-unknown posture
 *  `resolveFixCap` above takes for `lanes.prFixCap`. */
export function resolveWorkerBudgetUsdSoft(config: Record<string, unknown> | null | undefined): number | null {
  const raw = config ? readConfigPath(config, "worker.budgetUsdSoft") : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** #927 (§729 remainder, D35; Q4 owner ruling): a `LaneView` phase word to the live `Lane.state`
 *  word the SAME `laneStateChipText`/`KNOWN_ACTIVE_LANE_STATES` (`LaneBoard.tsx`) already key
 *  off — `"writing"` is the replay fold's own word for what the live DB spells `"running"`; the
 *  rest already agree. `"idle"`/`"failed"` map to nothing: an idle channel isn't occupied at
 *  all, and live's own `Lane[]` never carries a `failed` row either (`activeWorkers()` excludes
 *  it — `KNOWN_ACTIVE_LANE_STATES`'s own doc) — a replayed failed lane collapses to the same
 *  quiet empty slot a live one would render as, until something re-occupies the channel. */
const REPLAY_LANE_STATE: Partial<Record<HeroState["lanes"][number]["phase"], string>> = {
  writing: "running",
  driving: "driving",
  fixing: "fixing",
};

/**
 * #927 (§729 remainder, D35; Q4 owner ruling): replay/`?demo` has no live `/api/loop/state`
 * lane snapshot — this derives the SAME `Lane[]` shape `LaneBoard` already renders straight from
 * the shared fold's own state (`hero/state.ts`'s `LaneView`/`Droplet`), one code path for live
 * and replay (§11 renderer contract, this issue's amendment to the boundary table).
 *
 * The PR ref comes from the droplet riding THIS card's own issue (`hero.droplets` is keyed by
 * issue — `hero/state.ts`'s `Draft.droplets: Map<number, Droplet>` — so matching by `d.issue ===
 * l.issue` is exact, never ambiguous). gate② finding [2] (replayed-pr-worker-alias): matching by
 * `d.lane === l.worker` instead is a real bug — `Droplet.lane` is never cleared once set (merged/
 * handoff/trunk all leave it standing), so once a worker NAME is reused for a later, unrelated
 * issue, `.find` would return whichever droplet happened to touch that name FIRST — a stale
 * droplet's PR from a long-merged issue, shown on the new issue's card.
 *
 * `estCostUsd`/`costEstimated` carry the settled `reclaim-done`'s OWN recorded estimate/
 * provenance through to `laneCostText`'s est→real calibration reading (gate② finding [1]:
 * dropping them left the card at the bare settled figure, short of what the issue's own "cost
 * line = settled figure with the est→real reading when recorded" names) — WITHOUT ever feeding
 * a live-est BAR segment: `LaneCard`'s own `CostBar` call (`LaneBoard.tsx`) already forces
 * `estUsd: null` the instant `costUsd` is non-null, and `costUsd` is exactly what a settled
 * replayed lane always has once `reclaim-done` has folded — so the historical estimate only ever
 * reaches the TEXT, never the bar. While the lane is still running (no `reclaim-done` yet),
 * `LaneView.estCostUsd` is itself still `null` (§11: no live-telemetry overlay exists in replay
 * to have set it early) — no fabricated est renders there either.
 */
export function deriveReplayedLanes(hero: HeroState): Lane[] {
  const lanes: Lane[] = [];
  for (const l of hero.lanes) {
    if (l.worker === null || l.issue === null) continue;
    const state = REPLAY_LANE_STATE[l.phase];
    if (!state) continue;
    const droplet = hero.droplets.find((d) => d.issue === l.issue);
    lanes.push({
      lane: l.worker,
      issue: l.issue,
      state,
      pr: droplet?.pr ?? null,
      held: l.held,
      // `l.startedAt` is always set once a lane is occupied — every claim path (`dispatched`,
      // a released lane's `fix-leg-started`/`-resumed`) stamps it before this filter admits the
      // lane at all (`hero/state.ts`'s own doc).
      startedAt: l.startedAt ?? "",
      endedAt: null,
      costUsd: l.costUsd,
      estCostUsd: l.estCostUsd,
      costEstimated: l.costEstimated,
      fixRound: l.fixRound,
      contextTokens: null,
      tokenComposition: null,
    });
  }
  return lanes;
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
 * replay's one-time full-round load already uses. `ceilingId` defaults `null` — the drawer's own
 * caller always passes the genuinely CURRENT open round (a closed round's own events already flow
 * through `useReplay`'s round-scoped `roundEvents` instead), which has no NEXT round yet to bound
 * it, so "no ceiling" is the honest boundary there. #934 gate② finding [1]
 * (feed-loader-overcollects-round): the activity feed's own caller can land on a CLOSED round
 * (`resolveLiveFeedRound`'s idle/skew fallback) that DOES have a real next round — it passes
 * `roundEventCeiling`'s own id explicitly rather than relying on this default. Either way,
 * `loadRoundEvents` itself now also hard-clamps to `round.eventCount` regardless of `ceilingId`
 * (that function's own doc) — belt-and-braces once an id-based ceiling isn't available yet either
 * (a round newer than `ceilingId` can bound hasn't appeared in `/api/rounds` at all).
 *
 * Unlike `useEventHistory`'s `events` (window-capped at `MAX_EVENT_HISTORY`, `api/queries.ts`),
 * `loadRoundEvents` takes no window parameter at all — it keeps paging `/api/events` until
 * `round.eventCount` rows are collected (`replay/round-log.test.ts` already pins that property),
 * so a round longer than the live display window is never undercounted by reading this instead.
 */
export function loadInspectorRoundEvents(
  round: Round,
  fetchEventsPage: (after: number, limit: number) => Promise<EventsPage> = (after, limit) => fetchEvents({ after, limit }),
  ceilingId: number | null = null,
): Promise<DomainEvent[]> {
  return loadRoundEvents(round, ceilingId, fetchEventsPage);
}

/**
 * #868 gate② finding [1]: the drawer's own live-round-scoped event source, also reused by #934's
 * activity feed for its own live per-round fetch. `round: null` (drawer closed, or the round
 * hasn't appeared in `/api/rounds` yet) returns `[]` without fetching — the same "nothing to load"
 * posture `useReplay`'s own load effect takes for `selectedRoundId === null`. Re-fetches whenever
 * the round's identity, its own `eventCount`, OR `ceilingId` changes — `/api/rounds`' 3 s poll
 * recomputes `eventCount` live for the currently open round (`engine/src/state/state.ts`'s
 * `listRounds` doc), so a still-in-progress round's counts keep pace with it. Mirrors
 * `useReplay.ts`'s `resolveActiveLog`: a result whose OWN round no longer matches the round
 * CURRENTLY requested reads as absent (empty), never a stale prior round's counts shown under a
 * freshly-opened round's drawer/feed. `ceilingId` defaults `null` — see `loadInspectorRoundEvents`'s
 * own doc for when a caller supplies one instead.
 *
 * #934 (feed-fetch-rejection): the fetch above had no rejection
 * handling — a page that failed after an earlier one had already succeeded left `state` (and so
 * the returned `events`) exactly where that last success left it, forever: the effect's own deps
 * (`round.roundId`/`round.eventCount`/`ceilingId`) never change just because a fetch failed, so
 * nothing else was left to re-trigger it. `error` is now exposed so a caller can render the same
 * degraded treatment a transport failure already gets elsewhere in this app (`disconnected`),
 * rather than a feed that looks merely quiet under a nonzero round divider. `retryNonce` — bumped
 * from a `setTimeout` armed only on rejection — is the one thing this effect adds to its own deps
 * purely to force that retry, at the SAME `POLL_MS` cadence every other live query here already
 * polls at, not a new unbounded retry loop of its own: a rejection never leaves the feed
 * permanently empty, only until the next tick recovers `events` or reschedules another retry.
 */
export function useInspectorRoundEvents(round: Round | null, ceilingId: number | null = null): { events: DomainEvent[]; error: boolean } {
  const [state, setState] = useState<{ roundId: number | null; events: DomainEvent[]; error: boolean }>({
    roundId: null,
    events: [],
    error: false,
  });
  const [retryNonce, setRetryNonce] = useState(0);
  // `round` itself is a fresh object reference every `/api/rounds` poll — its own `roundId`/
  // `eventCount` (plus the caller-supplied `ceilingId`/the rejection-driven `retryNonce`) are the
  // only fields that decide whether a re-fetch is warranted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above.
  useEffect(() => {
    if (!round) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    loadInspectorRoundEvents(round, undefined, ceilingId).then(
      (events) => {
        if (!cancelled) setState({ roundId: round.roundId, events, error: false });
      },
      () => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, error: true }));
        retryTimer = setTimeout(() => {
          if (!cancelled) setRetryNonce((n) => n + 1);
        }, POLL_MS);
      },
    );
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [round?.roundId, round?.eventCount, ceilingId, retryNonce]);
  return {
    events: round && state.roundId === round.roundId ? state.events : [],
    error: state.error,
  };
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
 * #934: the activity feed's LIVE round-in-view. Precedence: the live snapshot's own round id
 * (`liveRoundId`) match in `rounds` first; then the newest `in_progress` row; then (idle/standby,
 * nothing open) the last CLOSED round; `null` only once no round exists at all (fresh DB).
 *
 * `/api/loop/state` and `/api/rounds` poll independently, so either can lead the other:
 *
 * #934 gate② finding [0] (live-round-snapshot-skew): a freshly-opened round can appear in the
 * FIRST (`liveRoundId`) before its own row has landed in the SECOND (`rounds`). Falling straight
 * through to `null` there used to misrender the feed's idle "Waiting for the first dispatch"
 * caption while the header navigator, reading the very same live snapshot, already said "round N
 * · live" — a live contradiction between the two panels.
 *
 * #934 (reverse-round-snapshot-skew): the REVERSE also happens — `rounds` can
 * already list the new round `in_progress` while the still-cached `loop.state` snapshot has not
 * caught up and reports `round: null`. Falling straight through to `findLastClosedRound` there
 * showed the LAST CLOSED round while an open round was already available, violating AC2's LIVE =
 * open-round rule. The newest `in_progress` row is the honest middle step between "the live id
 * match" and "nothing open at all": in this skew window it IS the open round, just not yet
 * confirmed by `liveRoundId`.
 *
 * Falling back to the last CLOSED round (only once no `in_progress` row exists either) is the
 * honest "keep showing whatever was already in view": the round that just closed to make room for
 * the new one is, by construction, already the newest closed row by the time the new one opens, so
 * this is never a stale guess — only a genuinely fresh database (no round has EVER closed, none
 * open) still falls through to `null` here.
 */
export function resolveLiveFeedRound(rounds: readonly Round[], liveRoundId: number | null): Round | null {
  if (liveRoundId !== null) {
    const open = rounds.find((r) => r.roundId === liveRoundId);
    if (open) return open;
  }
  const newestInProgress = [...rounds].filter((r) => r.status === "in_progress").sort((a, b) => b.roundId - a.roundId)[0];
  if (newestInProgress) return newestInProgress;
  return findLastClosedRound(rounds);
}

/**
 * #934: REPLAY/`?demo`'s as-of-cursor filter over a round's own FULL log (`replay.roundEvents`/
 * `useDemoReplay`'s `roundEvents` — never the bounded `state.events` fold that `reducer.ts`'s
 * `foldReplay` caps at `DEFAULT_EVENT_WINDOW`, exactly the "bounded live tail" the issue's own
 * "What" bans reading the feed from, since it could silently truncate a round longer than that
 * window). `cursorId` is `player.ts`'s own "last folded event's id, 0 before anything has folded"
 * — 0 means nothing is visible yet, not "no ceiling".
 */
export function eventsUpToCursor(events: readonly DomainEvent[], cursorId: number): DomainEvent[] {
  return cursorId <= 0 ? [] : events.filter((e) => e.id <= cursorId);
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
   *  event-derived counts — NEVER `resolveActiveFold`'s own `events` (the shared display tail:
   *  process-wide, window-bounded, and in live mode not filtered to the open round at all). Live mode reads
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
  activeTitles: EntityTitles;
  activeOpenAttention: DomainEvent[];
  /** #934: the activity feed's round-in-view — LIVE the open round (or the last closed one while
   *  idle/standby, `resolveLiveFeedRound`), REPLAY/`?demo` the selected round. `null` only before
   *  any round exists at all. */
  feedRound: Round | null;
  /** #934: that round's own events — LIVE the per-round fetch (`useInspectorRoundEvents`), REPLAY/
   *  `?demo` that round's full log filtered to the replay cursor (`eventsUpToCursor`). NEVER
   *  `resolveActiveFold`'s own `events` (the shared, process-wide, window-bounded display tail —
   *  no other panel this function renders needs raw events at all, so that field never reaches
   *  `appContent`). */
  feedEvents: DomainEvent[];
  /** #934 (feed-fetch-rejection): the live per-round fetch behind `feedEvents` rejected and hasn't
   *  yet recovered — ORed into the panel's own `disconnected` prop so a stuck failure renders the
   *  feed's existing degraded treatment instead of a silent, permanently-empty list under a
   *  nonzero round divider. Always `false` in replay/`?demo` (`feedEvents` there reads an
   *  already-loaded log, never this live fetch). */
  feedError: boolean;
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
    activeTitles,
    activeOpenAttention,
    feedRound,
    feedEvents,
    feedError,
    spendFacts,
    roundSpend,
    estUsd,
  } = vm;
  const onInspect = (node: StageNode) => setInspectorNode(node);
  return (
    <div className="app-shell">
      <IconRail onOpenConfig={() => setConfigOpen(toggleConfigOpen)} />
      <main className="stack">
        {/* #923 AC1 (D14): the header card's own two rows — engine-status/verbs, then (under a
            hairline) the replay transport — rather than the transport's previous life as a
            separate `.panel` floating below the header. */}
        <header id="overview" className="panel app-header">
          <div className="app-header-row">
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
              // #923: mockup band-2 order is status · stepper · BACK TO LIVE · meter · "?" —
              // Header.tsx renders this between its own round navigator and spend meter, rather
              // than here as a later sibling in `.app-header-row` (which put it after the meter,
              // ahead of only the "?"). Still a descendant of `.app-header`, never of the
              // transport row below (AC2's own wiring check), in every one of Header's own
              // returns — including disconnected/connecting, so a replay viewer never loses the
              // way back just because the connection did.
              replayAction={
                mode === "replay" ? (
                  // #972 (720 reflow): the label collapses to icon-only at 720 (panels.css) — the
                  // button carries its own explicit `aria-label` so the accessible name survives
                  // that, rather than being derived from text content that may be visually hidden.
                  <button type="button" className="header-back-to-live" aria-label="back to live" onClick={() => replay.selectRound(null)}>
                    <FastForward size={18} strokeWidth={1.5} aria-hidden="true" />
                    <span className="header-back-to-live-label">back to live</span>
                  </button>
                ) : undefined
              }
            />
            {/* §3 Operations: the engine control verbs hide entirely while viewing a closed round
                — they act on the PRESENT engine while every other pixel shows an as-of-cursor
                past. BACK TO LIVE (Header.tsx's `replayAction`) takes their place while replaying. */}
            {mode !== "replay" && (
              <Controls
                enabled={(loop.data?.controlsEnabled ?? false) && mode === "live"}
                running={loop.data?.engine.state === "running"}
                estopActive={loop.data?.engine.estopActive ?? false}
              />
            )}
            <Legend />
          </div>

          <Transport
            rounds={rounds}
            selectedRoundId={replay.selectedRoundId}
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
        </header>

        <NeedsAttention
          items={activeOpenAttention}
          titles={activeTitles}
          repoUrl={repoUrl}
          // #925 AC4: the SAME replay-cursor clock #895 item 1 already established for the Hero
          // staleness caption below — never the live wall clock, which reads a `?demo` fixture
          // recorded days/weeks ago as the SAME "Nd ago" on every row, regardless of how far apart
          // the fixture's own events actually are, instead of the ages their spacing encodes.
          now={mode === "replay" && replay.asOf ? new Date(replay.asOf) : clock}
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
            // #922 "What"/AC5 gate② finding [5]: replay highlights the CURSOR's own phase
            // (`phaseAtCursor`, `replay.phaseWindows`/`replay.asOf` — the same replay data
            // `now`'s own prop below already reads), never a hardcoded null — `live` (not
            // `roundPhase`) is what keeps dimming live-only now (`Hero.tsx`'s own doc).
            roundPhase={mode === "live" ? (loop.data.round?.phase ?? null) : phaseAtCursor(replay.phaseWindows, replay.asOf)}
            live={mode === "live"}
            config={loop.data.config}
            onInspect={onInspect}
            openAttention={activeOpenAttention}
            // #895 item 1: the staleness caption's honest clock — the replay cursor's own
            // timestamp while replaying (never the live wall clock, which used to make a
            // multi-day-old replayed round read as still-current), the real clock otherwise.
            now={mode === "replay" && replay.asOf ? new Date(replay.asOf) : clock}
          />
        )}

        {/*
         * #926 (§729 remainder, D25/D28; Q3 owner ruling 2026-08-17): lanes and activity now each
         * take their own full-width `.stack` row, lanes first — superseding #897's side-by-side
         * `.lane-activity-row` pairing, which could never fit the mockup's head/body card anatomy
         * in half the canvas (this issue's own "Why"). `.stack > .lane-board`/`.activity-feed`
         * (app.css) carry `grid-column: 1/-1` directly, same list every other full-width module is
         * already on — no nested row wrapper needed now that each module claims a whole row itself.
         *
         * #927 (§729 remainder, D35; Q4 owner ruling): the lane NARRATIVE (state/PR/settled
         * cost/elapsed) replays from the shared fold, same as the hero and feed — only the est
         * telemetry overlay and the live `/api/loop/state` PR-open-early hint are genuinely
         * live-only (§11's amended boundary table), so the board itself is no longer wrapped in
         * `<LiveOnly>` — `deriveReplayedLanes` feeds it cards straight from `activeHero` while
         * replaying/`?demo`, and `source` drives the panel-head's REPLAYED chip.
         */}
        <LaneBoard
          lanesMax={loop.data?.lanes.max ?? null}
          lanes={mode === "live" ? (loop.data?.lanes.items ?? []) : deriveReplayedLanes(activeHero)}
          titles={activeTitles}
          repoUrl={repoUrl}
          disconnected={disconnected}
          workerBudgetUsdSoft={resolveWorkerBudgetUsdSoft(loop.data?.config)}
          config={loop.data?.config ?? null}
          fixCap={fixCap}
          source={mode === "live" ? "live" : "replayed"}
          now={mode === "replay" && replay.asOf ? new Date(replay.asOf) : clock}
        />

        <ActivityFeed
          events={feedEvents}
          round={feedRound}
          titles={activeTitles}
          repoUrl={repoUrl}
          // #934 (feed-fetch-rejection): `feedError` (the live per-round fetch's own rejection,
          // never the whole-transport `disconnected`) ORs in here — a stuck feed fetch degrades
          // this panel alone, without misreporting the rest of the app as disconnected too.
          disconnected={disconnected || feedError}
          // #934 AC3: the SAME replay-cursor clock the needs-attention strip/Hero staleness
          // caption already use (#925 AC4/#895 item 1) — never the live wall clock, which used to
          // read a `?demo`/replay fixture recorded days ago as "8d ago" while the strip (bound to
          // `replay.asOf`) read a sane "1h ago" for the same moment (PO witness 2026-08-18).
          now={mode === "replay" && replay.asOf ? new Date(replay.asOf) : clock}
        />

        <CostStrip today={costToday} round={costRound} />

        {configOpen && (
          <LiveOnly mode={mode}>
            <ConfigDrawer
              config={loop.data?.config ?? null}
              open
              onClose={() => setConfigOpen(false)}
              buildSha={BUILD_SHA}
              buildTime={BUILD_TIME}
              distSha={loop.data?.build?.distSha ?? null}
              repoHeadSha={loop.data?.build?.repoHeadSha ?? null}
            />
          </LiveOnly>
        )}

        {/* §6 phase inspector (#861) — unlike ConfigDrawer, this is NOT live-only: §6's own mode
         *  purity rule binds it to whichever round (live open, or replay cursor) is active.
         *  #868 gate② finding [1]: `events` is `inspectorEvents` (the round-scoped source), NEVER
         *  the shared display tail — process-wide and window-bounded. */}
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
  const { events: inspectorLiveEvents } = useInspectorRoundEvents(mode === "live" && inspectorNode !== null ? inspectorRound : null);
  const inspectorEvents = mode === "live" ? inspectorLiveEvents : replay.roundEvents;

  // #934: the activity feed's round-in-view + its own events — LIVE the open round (or the last
  // closed one while idle/standby, `resolveLiveFeedRound`) fetched fresh via the SAME per-round
  // mechanism the inspector drawer uses (`useInspectorRoundEvents`, generic over which round —
  // this is a second, independent call, not gated on `inspectorNode`, so the feed's divider count
  // stays live even with the drawer closed); REPLAY/`?demo` that round's already-loaded full log
  // filtered to the replay cursor (`eventsUpToCursor`) — never `resolveActiveFold`'s own `events`,
  // the shared process-wide, window-bounded display tail (`ActivityFeed.tsx`'s own doc).
  const feedRound = mode === "live" ? resolveLiveFeedRound(allRounds, loop.data?.round?.id ?? null) : selectedRound;
  // #934 gate② finding [1] (feed-loader-overcollects-round): UNLIKE the drawer's own caller above
  // (always the genuinely-open round, honestly ceiling-less), `feedRound` can resolve to a CLOSED
  // fallback round (`resolveLiveFeedRound`'s idle/skew branch) — one that DOES have a real next
  // round. `roundEventCeiling` bounds the fetch at that next round's own `startEventId` whenever
  // `allRounds` already knows about it; `loadRoundEvents`'s own `eventCount` clamp (that
  // function's doc) is the remaining backstop for the narrower window where the next round hasn't
  // appeared in `/api/rounds` yet either.
  const feedCeilingId = mode === "live" && feedRound ? roundEventCeiling(feedRound, allRounds) : null;
  const { events: feedLiveEvents, error: feedLiveError } = useInspectorRoundEvents(mode === "live" ? feedRound : null, feedCeilingId);
  const feedEvents = mode === "live" ? feedLiveEvents : eventsUpToCursor(replay.roundEvents, replay.position?.cursorId ?? 0);
  const feedError = mode === "live" && feedLiveError;

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
    activeTitles,
    activeOpenAttention,
    feedRound,
    feedEvents,
    feedError,
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
 * fixture loads — there is no live engine to fall back to. `LaneBoard` is NOT one of the panels
 * this leaves greyed out (#927): it replays its own lane narrative from `deriveReplayedLanes`,
 * the same as `LiveApp`'s own replay branch. The genuinely live-only panels (`ConfigDrawer`, the
 * engine control verbs) already grey out for free — the SAME wiring `appContent` already uses
 * whenever a closed round is selected under live mode.
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
  // #934: same as `LiveApp` — the round-in-view is the selected round, its events the round's own
  // log filtered to the replay cursor (`eventsUpToCursor`), never the shared display tail.
  const feedRound = selectedRound;
  const feedEvents = eventsUpToCursor(replay.roundEvents, replay.position?.cursorId ?? 0);

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
    activeTitles,
    activeOpenAttention,
    feedRound,
    feedEvents,
    // #934 (feed-fetch-rejection): demo mode has no live per-round fetch to reject at all — see
    // `feedError`'s own doc on `AppViewModel`.
    feedError: false,
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
