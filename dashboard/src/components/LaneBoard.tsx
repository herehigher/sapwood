import type { Lane } from "../api/types.ts";
import { laneStateCaption } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { formatElapsed, formatUsd } from "../format.ts";
import { modelEffortCaption } from "../hero/stage.tsx";
import { CostBar } from "./CostBar.tsx";
import { EntityRef } from "./EntityRef.tsx";
import { DropletGlyph, StateGlyph } from "./icons.tsx";

/** #924: the lanes panel-head's own stat cluster ("model · effort · soft budget $N") —
 *  `modelEffortCaption` is the SAME `worker.*` config reader the hero's own lane captions use
 *  (`stage.tsx`), never a second guess at the same config path. `null` when neither half of the
 *  fact is readable (unconfigured/unreadable config) — an honest gap, not a fabricated caption. */
export function laneHeadStat(config: Record<string, unknown> | null | undefined, workerBudgetUsdSoft: number | null): string | null {
  const modelEffort = modelEffortCaption(config, "worker");
  const budget = workerBudgetUsdSoft !== null ? `soft budget ${formatUsd(workerBudgetUsdSoft)}` : null;
  return [modelEffort, budget].filter((s): s is string => s !== null).join(" · ") || null;
}

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

/** #926 AC4: the state chip's own text — a `fixing` lane reads "FIXING · ROUND n/cap" (`n` =
 *  `lane.fixRound`, the cap = `lanes.prFixCap` config, same denominator the hero stage's own
 *  fixing droplet label uses, `stage.tsx`'s `FIXING · round ${lane.fixRound} of ${fixCap}`) —
 *  every other known state keeps its plain `laneStateCaption` word, never a fabricated round
 *  count on a lane that was never fixing. */
export function laneStateChipText(lane: Lane, fixCap: number): string {
  if (lane.state === "fixing") return `FIXING · ROUND ${lane.fixRound}/${fixCap}`;
  return laneStateCaption(lane.state);
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
  /** #924: allowlisted config, threaded straight to `laneHeadStat` for the panel-head's own
   *  "model · effort · soft budget $N" stat cluster. */
  config?: Record<string, unknown> | null;
  /** #926 AC4: `lanes.prFixCap` — the "FIXING · ROUND n/cap" chip's own denominator. Defaults to
   *  `resolveFixCap`'s (App.tsx) own unreadable-config fallback, so a caller that never wires this
   *  through still renders a sane cap rather than an undefined one. */
  fixCap?: number;
  /** #927 (§729 remainder, D35; Q4 owner ruling): drives the panel-head's REPLAYED chip —
   *  `"live"` (the default, so every pre-#927 caller keeps its existing markup unchanged) renders
   *  nothing extra; `"replayed"` (App.tsx, while replaying/`?demo`) labels the board so a reader
   *  never mistakes a reconstructed narrative for a live snapshot. */
  source?: "live" | "replayed";
  now?: Date;
}

function LaneCard({
  lane,
  titles,
  repoUrl,
  now,
  workerBudgetUsdSoft,
  fixCap,
}: {
  lane: Lane;
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now: Date;
  workerBudgetUsdSoft: number | null;
  fixCap: number;
}) {
  return (
    // #892 AC5: `.recipe-list-entry` (panels.css) is the freshly-appended-row recipe — a real
    // lane card is exactly that (mounts when a slot fills). `EmptyLaneCard` stays untouched: an
    // outline slot isn't a row appearing, it's the quiet default already there.
    <div className="lane-card panel recipe-list-entry">
      {/* #926: the head now carries ONLY the lane id + state chip (`docs/design/mockup/
       *  lanes-{dark,light}.png`) — the issue number moved to the body below, at the mockup's own
       *  display scale, rather than sharing this small header row with it. */}
      <div className="lane-card-head">
        {/* #882 (729 ledger row 13, "w1 lane row unnamed"): `lane.lane` (w1/w2/w3…) drove sorting
         *  and the React key only — never rendered anywhere on the board, so a reader had no way
         *  to cross-reference a card against the same lane's own mentions elsewhere (activity feed
         *  sentences, `docs/design/mockup/lanes-{dark,light}.png`'s own per-card header). */}
        <span className="data lane-card-name">{lane.lane}</span>
        <span className="data muted lane-card-state">
          {KNOWN_ACTIVE_LANE_STATES.has(lane.state) ? (
            <span className="lane-card-state-dot" aria-hidden="true" />
          ) : (
            <StateGlyph ok={false} className="glyph-fail" />
          )}
          {laneStateChipText(lane, fixCap)}
        </span>
      </div>
      <div className="lane-card-issue">
        <DropletGlyph className="lane-card-issue-glyph" />
        <EntityRef token={{ kind: "issue", number: lane.issue }} titles={titles} repoUrl={repoUrl} />
      </div>
      {lane.pr !== null && (
        <div className="lane-card-pr">
          <EntityRef token={{ kind: "pr", number: lane.pr, issue: lane.issue }} titles={titles} repoUrl={repoUrl} />
        </div>
      )}
      <div className="data muted lane-card-cost">{laneCostText(lane)}</div>
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
      <div className="lane-card-foot muted data">
        <span>{formatElapsed(lane.startedAt, now)}</span>
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

export function LaneBoard({
  lanesMax,
  lanes,
  titles,
  repoUrl,
  disconnected,
  workerBudgetUsdSoft = null,
  config = null,
  fixCap = 2,
  source = "live",
  now,
}: LaneBoardProps) {
  const clock = now ?? new Date();
  if (disconnected) {
    return (
      <section className="panel lane-board" aria-label="lanes">
        <div className="panel-head">
          <h2>lanes</h2>
        </div>
        <p className="muted" style={{ color: "var(--rust)" }}>
          disconnected — restart sapwood to reconnect
        </p>
      </section>
    );
  }
  if (lanesMax === null) {
    return (
      <section className="panel lane-board" aria-label="lanes">
        <div className="panel-head">
          <h2>lanes</h2>
        </div>
        <div className="lane-board-grid">
          <EmptyLaneCard caption="lane count unknown — config unreadable" />
        </div>
      </section>
    );
  }
  const sorted = [...lanes].sort((a, b) => a.lane.localeCompare(b.lane));
  const slots = Array.from({ length: lanesMax }, (_, i) => sorted[i] ?? null);
  const headStat = laneHeadStat(config, workerBudgetUsdSoft);
  return (
    <section className="panel lane-board" aria-label="lanes">
      <div className="panel-head">
        <h2>lanes</h2>
        {headStat && <span className="data muted panel-head-stat">{headStat}</span>}
        {source === "replayed" && <span className={`lane-board-replayed-chip${headStat ? "" : " panel-head-stat"}`}>REPLAYED</span>}
      </div>
      <div className="lane-board-grid">
        {slots.map((lane, i) =>
          lane ? (
            <LaneCard
              key={lane.lane}
              lane={lane}
              titles={titles}
              repoUrl={repoUrl}
              now={clock}
              workerBudgetUsdSoft={workerBudgetUsdSoft}
              fixCap={fixCap}
            />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: empty slots have no identity to key on
            <EmptyLaneCard key={`empty-${i}`} />
          ),
        )}
      </div>
    </section>
  );
}
