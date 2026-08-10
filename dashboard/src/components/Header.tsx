import type { EngineState } from "../api/types.ts";
import { formatUsd } from "../format.ts";

/** frontend-design.md §3 A: "Display vocabulary collapses for the glance" — `standby` + env-park
 *  render as `waiting` (park adds its own sub-caption below), `winding-down` + `stopping` both
 *  render as `stopping`; the full internal word still rides the element's `title` (hover), so
 *  nothing is lost, only deferred behind a glance-vs-detail split. */
const DISPLAY_WORD: Record<EngineState, string> = {
  running: "running",
  standby: "waiting",
  stalled: "stalled",
  paused: "paused",
  "winding-down": "stopping",
  stopping: "stopping",
  stopped: "stopped",
};

export function displayEngineWord(state: EngineState): string {
  return DISPLAY_WORD[state];
}

/** §8 precedence: staleness, a ceiling breach, and the kill switch all outrank PAUSE in the
 *  DERIVED word — a dead engine with a PAUSE file renders `stalled`, never `paused`. The sentinel
 *  is real either way, so it demotes to this secondary chip whenever it's set but the primary
 *  word isn't already saying so (no redundant chip once the word itself is `paused`). */
export function showsPauseChip(state: EngineState, pauseActive: boolean): boolean {
  return pauseActive && state !== "paused";
}

export interface SpendFacts {
  runUsd: number | null;
  runBudgetUsd: number | null;
  todayUsd: number;
  dailyBudgetUsd: number | null;
}

export interface SpendMeterView {
  tier: "run" | "daily";
  usedUsd: number | null;
  budgetUsd: number | null;
}

/** §3 A / §11: run-cumulative vs the per-run stop budget when one is configured; falls back
 *  WHOLE to the daily tier otherwise — numerator and denominator always come from the SAME
 *  tier, never a run numerator over a daily denominator or vice versa. */
export function resolveSpendMeter(spend: SpendFacts): SpendMeterView {
  if (spend.runBudgetUsd !== null) return { tier: "run", usedUsd: spend.runUsd, budgetUsd: spend.runBudgetUsd };
  return { tier: "daily", usedUsd: spend.todayUsd, budgetUsd: spend.dailyBudgetUsd };
}

function SpendMeter({ spend }: { spend: SpendFacts }) {
  const view = resolveSpendMeter(spend);
  const usedLabel = view.usedUsd === null ? "—" : formatUsd(view.usedUsd);
  const budgetLabel = view.budgetUsd === null ? null : formatUsd(view.budgetUsd);
  const pct = view.usedUsd !== null && view.budgetUsd ? Math.min(100, (view.usedUsd / view.budgetUsd) * 100) : 0;
  const warm = view.budgetUsd !== null && pct >= 75;
  return (
    <div className={warm ? "spend-meter spend-meter-warm" : "spend-meter"} title={`${view.tier} spend`}>
      <span className="data spend-meter-value">
        {usedLabel}
        {budgetLabel !== null && ` / ${budgetLabel}`}
      </span>
    </div>
  );
}

export interface EngineFacts {
  state: EngineState;
  pauseActive: boolean;
}

export interface HeaderProps {
  disconnected: boolean;
  isPending: boolean;
  engine?: EngineFacts | undefined;
  spend?: SpendFacts | undefined;
  /** §3 A: env-park folds into the standby/"waiting" tier rather than an eighth word — this is
   *  the caller's own read of whether `park-escalated` is currently open (the needs-attention
   *  fold already tracks that; this component adds no second signal). */
  parked: boolean;
}

/**
 * frontend-design.md §3 A: engine state word + spend meter. Deliberately does NOT import or
 * render the "?" legend (#144's `Legend`) — this band composes with it at the call site instead
 * of duplicating it (#361 AC).
 */
export function Header({ disconnected, isPending, engine, spend, parked }: HeaderProps) {
  if (disconnected) {
    return (
      <p className="muted" style={{ color: "var(--rust)" }}>
        disconnected — restart sapwood to reconnect
      </p>
    );
  }
  if (isPending || !engine || !spend) {
    return <p className="muted">connecting…</p>;
  }
  const word = displayEngineWord(engine.state);
  return (
    <div className="engine-status">
      <span className="feed-dot" style={{ background: "var(--sap)" }} aria-hidden="true" />
      <span className="data engine-word" title={engine.state}>
        {word}
      </span>
      {word === "waiting" && parked && <span className="muted engine-park-caption">park</span>}
      {showsPauseChip(engine.state, engine.pauseActive) && <span className="muted data engine-pause-chip">PAUSE set</span>}
      <SpendMeter spend={spend} />
    </div>
  );
}
