import { useState } from "react";
import { spendByWorkerForDay, useEventHistory, useLoopState, useSpendHistory } from "./api/queries.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { ConfigDrawer } from "./components/ConfigDrawer.tsx";
import type { CostBarGroup } from "./components/CostStrip.tsx";
import { CostStrip } from "./components/CostStrip.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import { readConfigPath } from "./config-captions.ts";

/**
 * The lane board (C), activity feed (D), and cost strip + config drawer (E) from
 * frontend-design.md §3. The hero/rings/header band land in their own issue; this shell just
 * hosts these four panels against the same §8 data hooks. `now` is test-only (defaults to the
 * real clock) — the cost strip's "by lane" day boundary needs a fixed instant to assert against.
 */
export function App({ now }: { now?: Date | undefined } = {}) {
  const clock = now ?? new Date();
  const loop = useLoopState();
  const events = useEventHistory();
  const spend = useSpendHistory();
  const [configOpen, setConfigOpen] = useState(false);

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
  const owner = loop.data?.config ? readConfigPath(loop.data.config, "board.owner") : undefined;
  const repo = loop.data?.config ? readConfigPath(loop.data.config, "board.repo") : undefined;
  const repoUrl = typeof owner === "string" && typeof repo === "string" ? `https://github.com/${owner}/${repo}` : undefined;

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
    <main className="stack">
      <section className="panel">
        <h1>sapwood</h1>
        {disconnected ? (
          <p className="muted" style={{ color: "var(--rust)" }}>
            disconnected — restart sapwood to reconnect
          </p>
        ) : loop.isPending ? (
          <p className="muted">connecting…</p>
        ) : (
          loop.data && (
            <dl>
              <dt className="muted">engine</dt>
              <dd className="data">{loop.data.engine.state}</dd>
              <dt className="muted">rings</dt>
              <dd className="data">{loop.data.rings}</dd>
            </dl>
          )
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

      <ActivityFeed events={events.events} pinnedAttention={openAttention} titles={titles} repoUrl={repoUrl} disconnected={disconnected} />

      <CostStrip groups={[byModel, byLane]} />

      <ConfigDrawer config={loop.data?.config ?? null} open={configOpen} onClose={() => setConfigOpen(false)} />
    </main>
  );
}
