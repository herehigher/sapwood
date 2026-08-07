import { useState } from "react";
import { useEvents, useLoopState } from "./api/queries.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { ConfigDrawer } from "./components/ConfigDrawer.tsx";
import type { CostBarGroup } from "./components/CostStrip.tsx";
import { CostStrip } from "./components/CostStrip.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import { readConfigPath } from "./config-captions.ts";
import { foldEntityTitles } from "./entities.ts";

/**
 * The lane board (C), activity feed (D), and cost strip + config drawer (E) from
 * frontend-design.md §3. The hero/rings/header band land in their own issue; this shell just
 * hosts these four panels against the same §8 data hooks.
 */
export function App() {
  const loop = useLoopState();
  const events = useEvents(0);
  const [configOpen, setConfigOpen] = useState(false);

  const disconnected = loop.isError || events.isError;
  const titles = foldEntityTitles(events.data?.events ?? []);
  const owner = loop.data?.config ? readConfigPath(loop.data.config, "board.owner") : undefined;
  const repo = loop.data?.config ? readConfigPath(loop.data.config, "board.repo") : undefined;
  const repoUrl = typeof owner === "string" && typeof repo === "string" ? `https://github.com/${owner}/${repo}` : undefined;

  // §3 E specifies a "by phase" bucket; `/api/loop/state` serves no phase-bucketed spend today
  // (only `spend.byModel`), so this ships "by lane" from the currently-active lanes instead —
  // ponytail: the ceiling is that a settled/reused lane slot drops off this bucket the instant
  // it ends; upgrade to "by phase" once the engine serves a phase-bucketed spend aggregate.
  const byLane: CostBarGroup = {
    title: "by lane",
    bars: (loop.data?.lanes.items ?? []).map((lane) => ({
      label: lane.lane,
      usd: lane.costUsd ?? lane.estCostUsd ?? 0,
    })),
  };
  const byModel: CostBarGroup = {
    title: "by model",
    bars: (loop.data?.spend.byModel ?? []).map((m) => ({ label: m.model, usd: m.usd })),
  };

  return (
    <main className="stack">
      <section className="panel">
        <h1>sapwood</h1>
        {loop.isPending && <p className="muted">connecting…</p>}
        {loop.error && <p style={{ color: "var(--rust)" }}>✕ {loop.error.message}</p>}
        {loop.data && (
          <dl>
            <dt className="muted">engine</dt>
            <dd className="data">{loop.data.engine.state}</dd>
            <dt className="muted">rings</dt>
            <dd className="data">{loop.data.rings}</dd>
          </dl>
        )}
        <button type="button" onClick={() => setConfigOpen((v) => !v)}>
          Config ▸
        </button>
      </section>

      <LaneBoard
        lanesMax={loop.data?.lanes.max ?? null}
        lanes={loop.data?.lanes.items ?? []}
        titles={titles}
        repoUrl={repoUrl}
        disconnected={disconnected}
      />

      <ActivityFeed events={events.data?.events ?? []} titles={titles} repoUrl={repoUrl} disconnected={disconnected} />

      <CostStrip groups={[byModel, byLane]} />

      <ConfigDrawer config={loop.data?.config ?? null} open={configOpen} onClose={() => setConfigOpen(false)} />
    </main>
  );
}
