import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { spendByWorkerForDay, useDemoFixture, useEventHistory, useLoopState, useRounds, useSpendHistory } from "./api/queries.ts";
import type { Round } from "./api/types.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { ConfigDrawer } from "./components/ConfigDrawer.tsx";
import { Controls } from "./components/Controls.tsx";
import type { CostBarGroup } from "./components/CostStrip.tsx";
import { CostStrip } from "./components/CostStrip.tsx";
import { Header, type RoundSpend, type SpendFacts } from "./components/Header.tsx";
import { IconRail } from "./components/IconRail.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import { LiveOnly } from "./components/LiveOnly.tsx";
import { NeedsAttention } from "./components/NeedsAttention.tsx";
import { Transport } from "./components/Transport.tsx";
import { readConfigPath } from "./config-captions.ts";
import { useDemoReplay } from "./demo/useDemoReplay.ts";
import type { DomainEvent } from "./domain-event.ts";
import type { EntityTitles } from "./entities.ts";
import { Hero } from "./hero/Hero.tsx";
import { Legend } from "./hero/Legend.tsx";
import { type FoldStep, type HeroState, initialHeroState } from "./hero/state.ts";
import type { ReplayPosition } from "./replay/player.ts";
import { initialReplayState } from "./replay/reducer.ts";
import { bucketSpendByPhase, phaseSpendBars } from "./replay/spend-replay.ts";
import { type ReplayView, useReplay } from "./replay/useReplay.ts";

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
  byModel: CostBarGroup;
  byLane: CostBarGroup;
  byPhase: CostBarGroup;
  configOpen: boolean;
  setConfigOpen: Dispatch<SetStateAction<boolean>>;
  // #741: the round navigator's list + the replay transport/mode it drives — §3 A's "the round
  // navigator IS the mode", so every replayable panel below reads whichever fold is active.
  mode: "live" | "replay";
  rounds: Round[];
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
    byModel,
    byLane,
    byPhase,
    configOpen,
    setConfigOpen,
    mode,
    rounds,
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts,
    roundSpend,
  } = vm;
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
            parked={parked}
          />
          {/* §3 Operations: the engine control verbs hide entirely while viewing a closed round —
              they act on the PRESENT engine while every other pixel shows an as-of-cursor past. */}
          <Controls enabled={(loop.data?.controlsEnabled ?? false) && mode === "live"} />
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

        <NeedsAttention items={activeOpenAttention} titles={activeTitles} repoUrl={repoUrl} now={clock} />

        {loop.data && (
          <Hero
            heroState={activeHero}
            steps={activeSteps}
            lanesMax={loop.data.lanes.max}
            engine={loop.data.engine.state}
            lanes={mode === "live" ? loop.data.lanes.items : []}
            fixCap={fixCap}
            roundPhase={mode === "live" ? (loop.data.round?.phase ?? null) : null}
            config={loop.data.config}
          />
        )}

        {/* §11 boundary rule: `workers` is a mutable snapshot, not an append-only source — a lane
            card's state/PR/elapsed/settled-cost has no replay-reconstructed equivalent today, so
            the whole board is live-only rather than risk rendering a stale live snapshot under a
            replay cursor. */}
        <LiveOnly mode={mode}>
          <LaneBoard
            lanesMax={loop.data?.lanes.max ?? null}
            lanes={loop.data?.lanes.items ?? []}
            titles={activeTitles}
            repoUrl={repoUrl}
            disconnected={disconnected}
          />
        </LiveOnly>

        <ActivityFeed
          events={activeEvents}
          pinnedAttention={activeOpenAttention}
          titles={activeTitles}
          repoUrl={repoUrl}
          disconnected={disconnected}
        />

        <CostStrip
          groups={mode === "replay" ? [byPhase] : [byModel, byLane]}
          heading={mode === "replay" ? "cost · this round" : "cost · today"}
        />

        {configOpen && (
          <LiveOnly mode={mode}>
            <ConfigDrawer config={loop.data?.config ?? null} open onClose={() => setConfigOpen(false)} />
          </LiveOnly>
        )}
      </main>
    </div>
  );
}

type AppProps = { now?: Date | undefined; initialConfigOpen?: boolean | undefined };

/**
 * The header (A) + hero (B, #144) + lane board (C) + activity feed (D) + cost strip/config
 * drawer (E) from frontend-design.md §3, all against the same §8 data hooks. `now` is
 * test-only (defaults to the real clock) — the cost strip's "by lane" day boundary needs a
 * fixed instant to assert against. `initialConfigOpen` is test-only too, same posture as `now`.
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

  // #741: the round navigator's list (§8 `/api/rounds`) and the replay transport it drives
  // (play/pause/speed/scrub, §6). `mode` is carried by round selection, not a separate toggle —
  // §3 A's "the round navigator IS the mode".
  const rounds = useRounds();
  const replay = useReplay(rounds.data?.rounds ?? [], lanesMax);
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

  // §3 E specifies a "by phase" bucket; `/api/loop/state` serves no phase-bucketed spend today
  // (only `spend.byModel`), so LIVE ships "by lane" instead — ponytail: upgrade to "by phase" live
  // too once the engine serves a phase-bucketed spend aggregate. Sourced from the append-only
  // `/api/spend` ledger, NOT `loop.data.lanes.items` (#715 gate② round 3 [2]: the active-worker
  // read model drops a lane's settled spend the instant it stops being active, and renders an
  // in-flight lane with no settled/estimated cost as a fabricated `$0` — the ledger only ever
  // records SETTLED cost, so a still-running lane with nothing billed yet simply has no bar).
  const byLane: CostBarGroup = {
    title: "by lane",
    bars: spendByWorkerForDay(spend.rows, clock),
  };
  const byModel: CostBarGroup = {
    title: "by model",
    bars: (loop.data?.spend.byModel ?? []).map((m) => ({ label: m.model, usd: m.usd })),
  };
  // #741 §8/§11: replay's cost strip is "THIS ROUND BY PHASE" — `spendThroughCursor` is already
  // timestamp-cursor-truncated by `useReplay`; `phaseWindows` comes from the SAME round's own
  // `round-phase` trail, so "unattributed" only ever appears for genuinely pre-#206 history.
  const byPhase: CostBarGroup = {
    title: "by phase",
    bars: phaseSpendBars(bucketSpendByPhase(replay.spendThroughCursor, replay.phaseWindows)),
  };
  // #766 gate② finding [1]: the header meter's replay reading — the SAME `spendThroughCursor` rows
  // the phase strip above already reads (0 during the round's-log-still-loading window), against
  // the SELECTED round's own persisted `roundBudgetUsd` (never today's live config). `spendFacts`
  // (live) is passed through unconditionally too — Header.tsx's `round` prop always wins over it
  // when both are present, so live mode is unaffected.
  const selectedRoundArtifact = rounds.data?.rounds.find((r) => r.roundId === replay.selectedRoundId)?.artifact ?? null;
  const roundSpend =
    mode === "replay"
      ? resolveRoundSpend(
          replay.spendThroughCursor.reduce((sum, r) => sum + r.usd, 0),
          selectedRoundArtifact,
        )
      : undefined;

  return appContent({
    clock,
    loop,
    events,
    disconnected,
    parked,
    repoUrl,
    fixCap,
    byModel,
    byLane,
    byPhase,
    configOpen,
    setConfigOpen,
    mode,
    rounds: rounds.data?.rounds ?? [],
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts: loop.data?.spend,
    roundSpend,
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

  // §3 E's "by phase" bucket is the only cost strip group demo mode ever shows (`mode` is always
  // "replay" once loaded) — `byModel`/`byLane` are unreachable placeholders, same reasoning
  // `appContent`'s own `mode === "replay" ? [byPhase] : [byModel, byLane]` branch already encodes.
  const byPhase: CostBarGroup = {
    title: "by phase",
    bars: phaseSpendBars(bucketSpendByPhase(replay.spendThroughCursor, replay.phaseWindows)),
  };
  const selectedRoundArtifact = rounds.find((r) => r.roundId === replay.selectedRoundId)?.artifact ?? null;
  const roundSpend =
    mode === "replay"
      ? resolveRoundSpend(
          replay.spendThroughCursor.reduce((sum, r) => sum + r.usd, 0),
          selectedRoundArtifact,
        )
      : undefined;

  return appContent({
    clock,
    loop: { data: bundle?.loopState, isPending: fixture.isPending } as unknown as ReturnType<typeof useLoopState>,
    events: emptyLive,
    disconnected,
    parked,
    repoUrl,
    fixCap,
    byModel: { title: "by model", bars: [] },
    byLane: { title: "by lane", bars: [] },
    byPhase,
    configOpen,
    setConfigOpen,
    mode,
    rounds,
    replay,
    activeHero,
    activeSteps,
    activeEvents,
    activeTitles,
    activeOpenAttention,
    spendFacts: bundle?.loopState.spend,
    roundSpend,
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
