import type { Lane } from "../api/types.ts";
import { laneStateCaption } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { formatElapsed, formatUsd } from "../format.ts";
import { EntityRef } from "./EntityRef.tsx";

export interface LaneBoardProps {
  /** `null` when the config is unreadable (§3's documented empty state) — never a fabricated
   *  count. */
  lanesMax: number | null;
  lanes: Lane[];
  titles: EntityTitles;
  repoUrl?: string | undefined;
  /** The loop-state fetch itself failed — the documented `disconnected` empty state. */
  disconnected?: boolean;
  now?: Date;
}

function LaneCard({ lane, titles, repoUrl, now }: { lane: Lane; titles: EntityTitles; repoUrl?: string | undefined; now: Date }) {
  return (
    <div className="lane-card panel">
      <div className="lane-card-head">
        <EntityRef token={{ kind: "issue", number: lane.issue }} titles={titles} repoUrl={repoUrl} />
        <span className="data muted">{laneStateCaption(lane.state)}</span>
      </div>
      {lane.pr !== null && (
        <div className="lane-card-pr">
          <EntityRef token={{ kind: "pr", number: lane.pr, issue: lane.issue }} titles={titles} repoUrl={repoUrl} />
        </div>
      )}
      <div className="lane-card-foot muted data">
        <span>{formatElapsed(lane.startedAt, now)}</span>
        <span>{lane.costUsd !== null ? formatUsd(lane.costUsd) : "—, settles when the lane ends"}</span>
      </div>
    </div>
  );
}

function EmptyLaneCard({ caption }: { caption?: string }) {
  return (
    <div className="lane-card lane-card-empty">
      <span className="muted">{caption ?? "(idle)"}</span>
    </div>
  );
}

export function LaneBoard({ lanesMax, lanes, titles, repoUrl, disconnected, now }: LaneBoardProps) {
  const clock = now ?? new Date();
  if (disconnected) {
    return (
      <section className="panel lane-board" aria-label="lanes">
        <h2>lanes</h2>
        <p className="muted" style={{ color: "var(--rust)" }}>
          disconnected — restart sapwood to reconnect
        </p>
      </section>
    );
  }
  if (lanesMax === null) {
    return (
      <section className="panel lane-board" aria-label="lanes">
        <h2>lanes</h2>
        <div className="lane-board-grid">
          <EmptyLaneCard caption="lane count unknown — config unreadable" />
        </div>
      </section>
    );
  }
  const sorted = [...lanes].sort((a, b) => a.lane.localeCompare(b.lane));
  const slots = Array.from({ length: lanesMax }, (_, i) => sorted[i] ?? null);
  return (
    <section className="panel lane-board" aria-label="lanes">
      <h2>lanes</h2>
      <div className="lane-board-grid">
        {slots.map((lane, i) =>
          lane ? (
            <LaneCard key={lane.lane} lane={lane} titles={titles} repoUrl={repoUrl} now={clock} />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: empty slots have no identity to key on
            <EmptyLaneCard key={`empty-${i}`} />
          ),
        )}
      </div>
    </section>
  );
}
