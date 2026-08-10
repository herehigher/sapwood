import { useState } from "react";
import { spendByWorkerForDay, useEventHistory, useLoopState, useSpendHistory } from "./api/queries.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { ConfigDrawer } from "./components/ConfigDrawer.tsx";
import { Controls } from "./components/Controls.tsx";
import type { CostBarGroup } from "./components/CostStrip.tsx";
import { CostStrip } from "./components/CostStrip.tsx";
import { Header } from "./components/Header.tsx";
import { IconRail } from "./components/IconRail.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import { NeedsAttention } from "./components/NeedsAttention.tsx";
import { readConfigPath } from "./config-captions.ts";
import { Hero } from "./hero/Hero.tsx";
import { Legend } from "./hero/Legend.tsx";

/**
 * #716 gate② P1-3: pulls `lanes.prFixCap` through the same nested-path reader `board.owner`/
 * `board.repo` already use — a flat `config["lanes.prFixCap"]` bracket lookup can never match
 * the server's nested allowlisted shape (`{ lanes: { prFixCap } }`), so that silently fell
 * back to the hardcoded default on every real config. Exported and pure so the regression is
 * pinned by a direct unit test: `fixCap` only ever becomes visible in rendered markup via
 * `Hero`'s event fold, which runs in a `useEffect` — `renderToStaticMarkup`, this app's only
 * test harness, never executes those, so an App-level render test cannot observe it.
 */
export function resolveFixCap(config: Record<string, unknown> | null | undefined): number {
  const raw = config ? readConfigPath(config, "lanes.prFixCap") : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 2;
}

/**
 * The header (A) + hero (B, #144) + lane board (C) + activity feed (D) + cost strip/config
 * drawer (E) from frontend-design.md §3, all against the same §8 data hooks. `now` is
 * test-only (defaults to the real clock) — the cost strip's "by lane" day boundary needs a
 * fixed instant to assert against. `initialConfigOpen` is test-only too, same posture as
 * `now` and as Controls.tsx's own `initialState` seam: `renderToStaticMarkup` (this app's only
 * test harness) never runs effects OR dispatches a real click, so a test proving the rail's
 * config gear and the header's old `Config ▸` button drive the SAME `ConfigDrawer` has to put
 * the component directly into the "open" state rather than simulate the click that would
 * normally produce it (#727 gate② finding config-trigger-test-is-static).
 */
export function App({ now, initialConfigOpen }: { now?: Date | undefined; initialConfigOpen?: boolean | undefined } = {}) {
  const clock = now ?? new Date();
  const loop = useLoopState();
  const events = useEventHistory();
  const spend = useSpendHistory();
  const [configOpen, setConfigOpen] = useState(initialConfigOpen ?? false);

  // §3's documented `disconnected` header state: ANY of the three queries failing means the
  // dashboard has lost part of its one data source, regardless of which one (#715 gate② [7] —
  // this used to render only `loop.error`'s raw message, and nothing at all when just the events
  // query failed; #715 gate② round 4 [2] — `spend` was still missing, so a lone `/api/spend`
  // failure left the header looking normal while the cost strip silently misreported "no spend
  // yet today").
  const disconnected = loop.isError || Boolean(events.error) || Boolean(spend.error);
  // `useEventHistory` folds titles/open-attention durably itself (#715 gate② [0]) — App no longer
  // re-derives `titles` from the bounded `events.events` window, which would forget anything past
  // the display cap.
  const { titles, openAttention } = events;
  // §3 A: env-park folds into the standby/"waiting" tier rather than an eighth state word — read
  // straight off the SAME open-attention fold the needs-attention strip already renders, never a
  // second park signal.
  const parked = openAttention.some((e) => e.kind === "park-escalated");
  const owner = loop.data?.config ? readConfigPath(loop.data.config, "board.owner") : undefined;
  const repo = loop.data?.config ? readConfigPath(loop.data.config, "board.repo") : undefined;
  const repoUrl = typeof owner === "string" && typeof repo === "string" ? `https://github.com/${owner}/${repo}` : undefined;
  const fixCap = resolveFixCap(loop.data?.config);

  // §3 E specifies a "by phase" bucket; `/api/loop/state` serves no phase-bucketed spend today
  // (only `spend.byModel`), so this ships "by lane" instead — ponytail: upgrade to "by phase"
  // once the engine serves a phase-bucketed spend aggregate. Sourced from the append-only
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

  return (
    <div className="app-shell">
      <IconRail onOpenConfig={() => setConfigOpen((v) => !v)} />
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
            spend={loop.data?.spend}
            parked={parked}
          />
          <Controls enabled={loop.data?.controlsEnabled ?? false} />
          <Legend />
        </header>

        <NeedsAttention items={openAttention} titles={titles} repoUrl={repoUrl} now={clock} />

        {loop.data && (
          <Hero
            events={events.events}
            lanesMax={loop.data.lanes.max}
            engine={loop.data.engine.state}
            lanes={loop.data.lanes.items}
            fixCap={fixCap}
            roundPhase={loop.data.round?.phase ?? null}
            config={loop.data.config}
          />
        )}

        <LaneBoard
          lanesMax={loop.data?.lanes.max ?? null}
          lanes={loop.data?.lanes.items ?? []}
          titles={titles}
          repoUrl={repoUrl}
          disconnected={disconnected}
        />

        <ActivityFeed
          events={events.events}
          pinnedAttention={openAttention}
          titles={titles}
          repoUrl={repoUrl}
          disconnected={disconnected}
        />

        <CostStrip groups={[byModel, byLane]} />

        <ConfigDrawer config={loop.data?.config ?? null} open={configOpen} onClose={() => setConfigOpen(false)} />
      </main>
    </div>
  );
}
