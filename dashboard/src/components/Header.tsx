import type { EngineState, Round } from "../api/types.ts";
import { engineStateCaption } from "../copy.ts";
import { formatUsd } from "../format.ts";
import { CostBar } from "./CostBar.tsx";
import { HintTooltip } from "./HintTooltip.tsx";
import { RoundNavigator } from "./RoundNavigator.tsx";

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
  tier: "run" | "daily" | "round";
  usedUsd: number | null;
  budgetUsd: number | null;
}

/** #766 gate② finding [1] (header-replay-total-is-round-scoped): the ONLY spend anchor this
 *  codebase actually persists is per-round (`spend_ledger`'s id cursors + the round artifact's own
 *  `roundBudgetUsd`) — the #206 run-started anchor this file's earlier `runUsd`/`runBudgetUsd`
 *  fields were meant to serve was never wired server-side (`dashboard/server.ts`'s own comment:
 *  "there is no honest way to compute a run-scoped sum from the DB alone", `spend.runUsd` is
 *  unconditionally `null` today, live included). Labeling a round-scoped, cursor-truncated total
 *  as "run" spend (the previous fix's mistake) claims a scope this app cannot actually measure.
 *  `round` is the honest alternative: a THIRD, explicitly-named tier carrying the replay cursor's
 *  own round-scoped total against that SAME round's own persisted `roundBudgetUsd` (immutable,
 *  historically correct — never today's possibly-since-changed live config) — real numbers, never
 *  a mislabeled scope. When provided, it wins outright; `resolveSpendMeter`'s run/daily logic
 *  (§3 A, live-only) never even runs. */
export interface RoundSpend {
  usedUsd: number;
  budgetUsd: number | null;
}

/** §3 A / §11: run-cumulative vs the per-run stop budget when one is configured; falls back
 *  WHOLE to the daily tier otherwise — numerator and denominator always come from the SAME
 *  tier, never a run numerator over a daily denominator or vice versa. */
export function resolveSpendMeter(spend: SpendFacts): SpendMeterView {
  if (spend.runBudgetUsd !== null) return { tier: "run", usedUsd: spend.runUsd, budgetUsd: spend.runBudgetUsd };
  return { tier: "daily", usedUsd: spend.todayUsd, budgetUsd: spend.dailyBudgetUsd };
}

/** #890 (§3 E): the capsule bar's own settled/est split, against the SAME `pct`/`warm` logic
 *  `SpendMeter` already computed — the bar's `max` is the meter's own budget (the ceiling context
 *  `header-dark.png` draws), never a second reference. `estUsd` is folded on top of the settled
 *  figure, same as the "+ $x.xx est" text — a running lane's live estimate that hasn't settled
 *  into the tier's own `usedUsd` yet. `null`/no-budget tiers render a zero-width bar (nothing to
 *  measure a ceiling against), same honest-empty posture `pct` already had. */
export function spendBarMax(view: SpendMeterView): number {
  return view.budgetUsd ?? 0;
}

function SpendMeter({ spend, round, estUsd = 0 }: { spend: SpendFacts; round?: RoundSpend | undefined; estUsd?: number }) {
  const view: SpendMeterView = round ? { tier: "round", usedUsd: round.usedUsd, budgetUsd: round.budgetUsd } : resolveSpendMeter(spend);
  const usedLabel = view.usedUsd === null ? "—" : formatUsd(view.usedUsd);
  const budgetLabel = view.budgetUsd === null ? null : formatUsd(view.budgetUsd);
  const pct = view.usedUsd !== null && view.budgetUsd ? Math.min(100, (view.usedUsd / view.budgetUsd) * 100) : 0;
  const warm = view.budgetUsd !== null && pct >= 75;
  return (
    // #890: `header-dark.png` places the capsule bar ABOVE the amount line — the bar is the
    // reference element, the text annotates it, never the other way round. DOM order fixes
    // visual order under the `.spend-meter` flex column (panels.css) without a second layout
    // mechanism.
    <HintTooltip content={`${view.tier} spend`}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this <div> is a Radix Tooltip trigger,
       *  not a bare non-interactive container — without tabIndex, Tab could never reach it at all
       *  (#892 AC1), and a <button>/<a> would misrepresent a read-only meter as actionable. */}
      <div className={warm ? "spend-meter spend-meter-warm" : "spend-meter"} tabIndex={0}>
        {view.usedUsd !== null && (
          <CostBar
            className="spend-meter-bar"
            settledUsd={view.usedUsd}
            estUsd={estUsd}
            max={spendBarMax(view)}
            label={`${view.tier} spend`}
          />
        )}
        <span className="data spend-meter-value">
          {usedLabel}
          {estUsd > 0 && ` + ${formatUsd(estUsd)} est`}
          {budgetLabel !== null && ` / ${budgetLabel}`}
        </span>
      </div>
    </HintTooltip>
  );
}

export interface EngineFacts {
  state: EngineState;
  pauseActive: boolean;
  /** #723: seconds until the next standby probe — only meaningful while `state === "standby"`;
   *  null otherwise. Folded into the caption via `engineStateCaption`. */
  standbyNextCheckSec: number | null;
}

export interface HeaderProps {
  disconnected: boolean;
  isPending: boolean;
  engine?: EngineFacts | undefined;
  spend?: SpendFacts | undefined;
  /** #766 gate② finding [1]: the replay transport's own round-scoped spend reading — present only
   *  while replaying a round, and always wins over `spend`'s run/daily tiers when given (see
   *  `RoundSpend`'s own doc for why). */
  round?: RoundSpend | undefined;
  /** §3 A: an env-park episode adds its own small sub-caption alongside the standby caption
   *  rather than a new state word — this is the caller's own read of whether `park-escalated`
   *  is currently open (the needs-attention fold already tracks that; this component adds no
   *  second signal). */
  parked: boolean;
  /** #889 (§3 A implementation): the round navigator's own data — optional so every pre-#889
   *  caller/test that doesn't care about the navigator keeps working unchanged, defaulting to
   *  the honest "no rounds yet" empty state rather than requiring a prop nobody's testing. */
  rounds?: Round[];
  selectedRoundId?: number | null;
  onSelectRound?: (roundId: number | null) => void;
  /** The currently OPEN round's id in live mode — see `RoundNavigator`'s own doc. */
  liveRoundId?: number | null;
  /** #890 (§3 E): the sum of every currently-running lane's live estimate
   *  (`cost-panel.ts`'s `sumEstCostUsd`) — live mode only; `undefined` under replay/demo, where
   *  no lane is actually running. Folded onto the meter's own tier as the hatched est tail. */
  estUsd?: number | undefined;
  now?: Date;
}

/**
 * frontend-design.md §3 A: engine state word + spend meter. Deliberately does NOT import or
 * render the "?" legend (#144's `Legend`) — this band composes with it at the call site instead
 * of duplicating it (#361 AC).
 */
export function Header({
  disconnected,
  isPending,
  engine,
  spend,
  round,
  parked,
  rounds = [],
  selectedRoundId = null,
  onSelectRound = () => {},
  liveRoundId = null,
  estUsd,
  now,
}: HeaderProps) {
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
  return (
    <div className="engine-status">
      {/* §5: --moss is "healthy engine dot" — every earlier return above (disconnected,
       *  connecting) has already exited by the time this renders, so reaching here always means
       *  a live, reachable engine (#895 item 3: this was hard-wired to --sap, the "in motion"
       *  token, which is the wrong semantic for a plain presence dot). */}
      <span className="feed-dot" style={{ background: "var(--moss)" }} aria-hidden="true" />
      <span className="data engine-word">{engine.state}</span>
      <span className="muted engine-caption"> — {engineStateCaption(engine.state, engine.standbyNextCheckSec)}</span>
      {engine.state === "standby" && parked && <span className="muted engine-park-caption">park</span>}
      {showsPauseChip(engine.state, engine.pauseActive) && <span className="muted data engine-pause-chip">PAUSE set</span>}
      <RoundNavigator
        rounds={rounds}
        selectedRoundId={selectedRoundId}
        onSelectRound={onSelectRound}
        liveRoundId={liveRoundId}
        engineState={engine.state}
        now={now}
      />
      <SpendMeter spend={spend} round={round} estUsd={estUsd ?? 0} />
    </div>
  );
}
