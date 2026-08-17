import type { Lane } from "../api/types.ts";
import { laneStateCaption } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { formatElapsed, formatUsd } from "../format.ts";
import { CostBar } from "./CostBar.tsx";
import { EntityRef } from "./EntityRef.tsx";
import { StateGlyph } from "./icons.tsx";

/** #890 (§3 E): the lane card's own settled/est text — a running lane's engine-provided
 *  `estCostUsd` is never silently dropped (the pre-#890 behavior: any lane with `costUsd: null`
 *  read as "—, settles when the lane ends" even when the engine already had a live estimate).
 *  `costUsd` still wins once settled — an est figure is a placeholder for the not-yet-real
 *  number, never shown alongside its own settled replacement. */
export function laneCostText(lane: Lane): string {
  if (lane.costUsd !== null) return formatUsd(lane.costUsd);
  if (lane.estCostUsd !== null) return `${formatUsd(lane.estCostUsd)} est`;
  return "—, settles when the lane ends";
}

/** Whether the card has anything to draw a bar for at all — settled or (while still running) an
 *  est figure. Independent of `laneCostBarMax`'s own ceiling below, since a configured worker
 *  budget is always positive and must never force an empty lane to draw a zero-progress bar. */
function laneHasCostToShow(lane: Lane): boolean {
  return (lane.costUsd ?? 0) + (lane.costUsd === null ? (lane.estCostUsd ?? 0) : 0) > 0;
}

/** #890: the card's own bar ceiling is the common worker soft-budget (`worker.budgetUsdSoft`,
 *  allowlisted config — the SAME reference a reader compares every lane's spend against,
 *  `ConfigDrawer`'s own "Worker" group), never the amount
 *  being drawn itself — a self-scaled max made every positive figure render 100% full regardless
 *  of size, losing all budget context. `CostBar` already clamps a bar past 100% (a lane that
 *  overran its soft budget still draws full, never off-track), so an unreadable config's fallback
 *  (self-scaled total) only ever applies when the real ceiling is genuinely unknown. */
function laneCostBarMax(lane: Lane, workerBudgetUsdSoft: number | null): number {
  if (workerBudgetUsdSoft !== null) return workerBudgetUsdSoft;
  return (lane.costUsd ?? 0) + (lane.costUsd === null ? (lane.estCostUsd ?? 0) : 0);
}

/** The lane states `/api/loop/state` can actually serve (`state.activeWorkers()` reads
 *  `WHERE state IN ('running','driving','fixing')`; `handoff` is included since §7 captions it
 *  explicitly). #715 gate② [6]: §5's "failed lanes a static ✕" cannot literally apply to a lane
 *  CARD today — a `failed` worker row is excluded from `activeWorkers()` by design (state.ts's own
 *  doc: "a `failed`+PR lane awaiting GATED RECLAIM does NOT block a fresh dispatch"), so it can
 *  never reach this component through the real API; a failed lane's outcome surfaces in the
 *  activity feed instead (already covered — see ActivityFeed's attention-class glyph). This set
 *  is the defensive backstop should a future engine change ever widen what a lane card can carry:
 *  any state outside it renders the static ✕ glyph alongside its text, same non-color-only rule. */
const KNOWN_ACTIVE_LANE_STATES = new Set(["running", "driving", "fixing", "handoff"]);

export interface LaneBoardProps {
  /** `null` when the config is unreadable (§3's documented empty state) — never a fabricated
   *  count. */
  lanesMax: number | null;
  lanes: Lane[];
  titles: EntityTitles;
  repoUrl?: string | undefined;
  /** The loop-state fetch itself failed — the documented `disconnected` empty state. */
  disconnected?: boolean;
  /** #890: `worker.budgetUsdSoft` (allowlisted config) — the lane bar's own ceiling. `null`
   *  when the config is unreadable, same honest-unknown posture as `lanesMax`. */
  workerBudgetUsdSoft?: number | null;
  now?: Date;
}

function LaneCard({
  lane,
  titles,
  repoUrl,
  now,
  workerBudgetUsdSoft,
}: {
  lane: Lane;
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now: Date;
  workerBudgetUsdSoft: number | null;
}) {
  return (
    // #892 AC5: `.recipe-list-entry` (panels.css) is the freshly-appended-row recipe — a real
    // lane card is exactly that (mounts when a slot fills). `EmptyLaneCard` stays untouched: an
    // outline slot isn't a row appearing, it's the quiet default already there.
    <div className="lane-card panel recipe-list-entry">
      <div className="lane-card-head">
        {/* #882 (729 ledger row 13, "w1 lane row unnamed"): `lane.lane` (w1/w2/w3…) drove sorting
         *  and the React key only — never rendered anywhere on the board, so a reader had no way
         *  to cross-reference a card against the same lane's own mentions elsewhere (activity feed
         *  sentences, `docs/design/mockup/lanes-{dark,light}.png`'s own per-card header). */}
        <span className="lane-card-head-left">
          <span className="data lane-card-name">{lane.lane}</span>
          <EntityRef token={{ kind: "issue", number: lane.issue }} titles={titles} repoUrl={repoUrl} />
        </span>
        <span className="data muted lane-card-state">
          {!KNOWN_ACTIVE_LANE_STATES.has(lane.state) && <StateGlyph ok={false} className="glyph-fail" />}
          {laneStateCaption(lane.state)}
        </span>
      </div>
      {lane.pr !== null && (
        <div className="lane-card-pr">
          <EntityRef token={{ kind: "pr", number: lane.pr, issue: lane.issue }} titles={titles} repoUrl={repoUrl} />
        </div>
      )}
      <div className="lane-card-foot muted data">
        <span>{formatElapsed(lane.startedAt, now)}</span>
        <span>{laneCostText(lane)}</span>
      </div>
      {laneHasCostToShow(lane) && (
        <CostBar
          className="lane-card-bar"
          settledUsd={lane.costUsd ?? 0}
          // #890: same "settled wins" stance as `laneCostText` — a stale est lingering after
          // settlement is never drawn alongside its own real replacement.
          estUsd={lane.costUsd === null ? lane.estCostUsd : null}
          max={laneCostBarMax(lane, workerBudgetUsdSoft)}
          label="lane cost"
        />
      )}
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

export function LaneBoard({ lanesMax, lanes, titles, repoUrl, disconnected, workerBudgetUsdSoft = null, now }: LaneBoardProps) {
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
            <LaneCard key={lane.lane} lane={lane} titles={titles} repoUrl={repoUrl} now={clock} workerBudgetUsdSoft={workerBudgetUsdSoft} />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: empty slots have no identity to key on
            <EmptyLaneCard key={`empty-${i}`} />
          ),
        )}
      </div>
    </section>
  );
}
