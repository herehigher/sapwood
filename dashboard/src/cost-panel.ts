/**
 * Cost panel composition (issue #880, #729 fidelity ledger row 3; `cost-dark.png`) — the pure
 * arithmetic behind "COST · TODAY" (by-stage + avg-round header) and "COST · ROUND N" (by-stage +
 * by-model + footer stats). Builds on `replay/spend-replay.ts`'s existing phase bucketing rather
 * than re-bucketing (that module owns the window/cursor logic; this one owns display shaping).
 */

import type { Round, SpendRow } from "./api/types.ts";
import { readSummary } from "./inspector.ts";
import { bucketSpendByPhase, type PhaseSpendBucket, type PhaseWindow, phaseSpendBars, UNATTRIBUTED_PHASE } from "./replay/spend-replay.ts";

export interface CostBar {
  label: string;
  usd: number;
}

/** The round's own ceiling, spread evenly across the six stages — the ONE target/ceiling value a
 *  by-stage group's bars share (every bar scales against the same `max`, so a single target lands
 *  at the same coordinate on every one of them — `cost-dark.png`'s ticks all sit at the same x). No
 *  per-phase budget exists in config (only `cost.roundBudgetUsd`, the whole-round soft ceiling), so
 *  this is the most honest per-stage reference derivable from real config, not a fabricated one.
 *  `null` — no tick drawn — when the round/config carries no readable budget at all. */
function stageTargetUsd(roundBudgetUsd: number | null): number | null {
  return roundBudgetUsd !== null ? roundBudgetUsd / 6 : null;
}

/** `round.ts`'s own `SEQUENCE` (engine/src/loop/round.ts), minus `closed` — the six phases a round
 *  actually spends money in, fixed display order per the issue body / §7 stage vocabulary (never
 *  the internal phase keys). */
const STAGE_ORDER: readonly { phase: string; label: string }[] = [
  { phase: "aligning", label: "Goal & align" },
  { phase: "architecting", label: "Arch review" },
  { phase: "plan_review", label: "Verify" },
  { phase: "executing", label: "Lanes" },
  { phase: "harvesting", label: "Summary" },
  { phase: "retro", label: "Retro" },
];

/** The mockup's "by stage" rows: all six phases always present (zero-filled when a phase spent
 *  nothing), in a fixed order — never the bucket's own first-seen insertion order. `Unattributed`
 *  (pre-#206 history, or spend with no covering `round-phase` window) is appended last, and only
 *  when it's genuinely non-empty — an honest leftover, never a fabricated row. */
export function stageCostBars(buckets: readonly PhaseSpendBucket[]): CostBar[] {
  const byPhase = new Map(phaseSpendBars(buckets).map((b) => [b.label, b.usd]));
  const bars = STAGE_ORDER.map(({ phase, label }) => ({ label, usd: byPhase.get(phase) ?? 0 }));
  const unattributedUsd = byPhase.get(UNATTRIBUTED_PHASE);
  if (unattributedUsd !== undefined) bars.push({ label: "Unattributed", usd: unattributedUsd });
  return bars;
}

/** The mockup's "by model" rows — summed per model, largest spend first (the bar-chart reading
 *  order; §7 never bothered ranking phases since they're already narrative-ordered, but models
 *  have no such order of their own). */
export function modelCostBars(rows: readonly SpendRow[]): CostBar[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.model, (totals.get(row.model) ?? 0) + row.usd);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([label, usd]) => ({ label, usd }));
}

/** Where a target/ceiling value falls along a bar drawn against `max` — the exact formula
 *  `CostStrip.tsx`'s `Bar` already uses for its own fill width, so the tick lands exactly where
 *  the fill would reach if the bar were AT the target. Clamped like the fill is (a target past the
 *  group's own max still draws a tick, pinned to the track's right edge, never off-canvas). */
export function tickPositionPct(target: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (target / max) * 100));
}

export interface RoundCostFooter {
  totalUsd: number;
  prsMerged: number;
  /** `null` — never a division-by-zero figure — when nothing merged this round. */
  usdPerPr: number | null;
  reviewUsd: number;
}

/** The "ROUND · N" footer line: total / PRs merged / $-per-PR / review cost. Pure arithmetic over
 *  numbers the caller already has (round artifact's `spendUsd`/`prsMerged`, `reviewSpendUsd` below)
 *  — no fresh data reads here, so a caller can pin each input independently. */
export function roundCostFooter(totalUsd: number, prsMerged: number, reviewUsd: number): RoundCostFooter {
  return { totalUsd, prsMerged, usdPerPr: prsMerged > 0 ? totalUsd / prsMerged : null, reviewUsd };
}

/** The round's own review spend — `actorKind: "engine-review"` rows only (#645's durable
 *  attribution column). Genuinely `0` for a round reviewed externally (hosted Codex) or by a
 *  human — never a fabricated non-zero figure, and this function doesn't attempt to distinguish
 *  "reviewed for free" from "not yet reviewed"; both read as $0 here. */
export function reviewSpendUsd(rows: readonly SpendRow[]): number {
  return rows.filter((r) => r.actorKind === "engine-review").reduce((sum, r) => sum + r.usd, 0);
}

/** The "TODAY" header's "avg round $X" figure — mean `spendUsd` across every CLOSED round with a
 *  readable artifact (`inspector.ts`'s own `readSummary`, reused rather than re-parsing
 *  `Round.artifact` a second way). A round still open, or a closed round whose artifact is
 *  missing/malformed, is excluded rather than counted as $0 — an honest partial average, never a
 *  deflated one. `null` (never `0`) when no round qualifies at all. */
export function avgRoundCostUsd(rounds: readonly Round[]): number | null {
  const spends = rounds
    .filter((r) => r.status === "done")
    .map((r) => readSummary(r.artifact).spendUsd)
    .filter((v): v is number => v !== null);
  if (spends.length === 0) return null;
  return spends.reduce((a, b) => a + b, 0) / spends.length;
}

/** The same UTC calendar-day boundary `api/queries.ts`'s `spendByWorkerForDay` already uses for
 *  the (superseded) by-lane strip — reused here so the TODAY panel's total agrees with every other
 *  "today" reading in this app instead of drawing its own day line. */
export function rowsForDay(rows: readonly SpendRow[], now: Date): SpendRow[] {
  const dayPrefix = now.toISOString().slice(0, 10);
  return rows.filter((r) => r.ts.startsWith(dayPrefix));
}

/** gate② finding cost-doc-source-mismatch: the SAME day boundary as `rowsForDay`, applied to a
 *  round's own `startedAt` — the "TODAY" scope for `avgRoundCostUsd` and (App.tsx's
 *  `useTodayCostLog`) the by-stage union, so both agree with the doc's "today's closed rounds"
 *  claim instead of silently averaging/unioning a round's entire history. */
export function roundsForDay(rounds: readonly Round[], now: Date): Round[] {
  const dayPrefix = now.toISOString().slice(0, 10);
  return rounds.filter((r) => r.startedAt.startsWith(dayPrefix));
}

export interface CostPanelData {
  heading: string;
  /** Renders the "CLOSED" badge — a round-scoped panel only (`cost-dark.png`'s "ROUND N" group). */
  closed?: boolean;
  /** The "TODAY" header's own stat — absent (never rendered) on the round panel. */
  avgRoundUsd?: number | null;
  stageBars: CostBar[];
  /** The by-stage group's shared target/ceiling tick — see `stageTargetUsd`'s own doc. */
  targetUsd?: number | null;
  modelBars: CostBar[];
  /** The round panel's footer line (total / PRs merged / $-per-PR / review cost) — absent on the
   *  today panel, which has no single round to summarize. */
  footer?: RoundCostFooter | null;
}

/** The "COST · TODAY" panel, built straight from already-bucketed stage buckets — the shape
 *  `App.tsx`'s LIVE mode needs (`mergeRoundPhaseBuckets`, #888 gate② final finding: each round's
 *  own spend is bucketed against ITS OWN windows BEFORE merging, so an ID-partitioned round's row
 *  can never cross into another round's phase, not even at a same-timestamp round boundary — a
 *  single flat `bucketSpendByPhase` call over concatenated rounds could not guarantee that).
 *  `modelBars` is taken as an input rather than derived here — live mode already has a
 *  server-aggregated `spend.byModel` for today that's cheaper to reuse than re-deriving the same
 *  total from raw rows a second way. */
export function buildTodayCostPanelFromBuckets(
  buckets: readonly PhaseSpendBucket[],
  modelBars: readonly CostBar[],
  avgRoundUsd: number | null,
  roundBudgetUsd: number | null,
): CostPanelData {
  return {
    heading: "cost · today",
    avgRoundUsd,
    stageBars: stageCostBars(buckets),
    targetUsd: stageTargetUsd(roundBudgetUsd),
    modelBars: [...modelBars],
    footer: null,
  };
}

/** The "COST · TODAY" panel over a single flat spend/phase-window slice — demo mode's own shape
 *  (the whole fixture bundle's continuous event stream, `buildPhaseWindows` over ALL of it in one
 *  call, never per-round-truncated logs), where there is no round partition to lose in the first
 *  place. LIVE mode instead goes through `buildTodayCostPanelFromBuckets` above — see that
 *  function's own doc for why a flat bucketing call is unsafe once spend/windows come from
 *  multiple independently-fetched rounds. */
export function buildTodayCostPanel(
  spend: readonly SpendRow[],
  phaseWindows: readonly PhaseWindow[],
  modelBars: readonly CostBar[],
  avgRoundUsd: number | null,
  roundBudgetUsd: number | null,
): CostPanelData {
  return buildTodayCostPanelFromBuckets(bucketSpendByPhase(spend, phaseWindows), modelBars, avgRoundUsd, roundBudgetUsd);
}

/** The "COST · ROUND N" panel — a CLOSED round's frozen by-stage + by-model breakdown plus footer
 *  stats, built from that round's OWN full spend log (never cursor-truncated — see
 *  `replay/useReplay.ts`'s `roundSpend` doc) and its persisted artifact (`inspector.ts`'s
 *  `readSummary`, the SAME reader the phase inspector drawer already uses). The footer is omitted
 *  entirely — never fabricated from a partial/zero fallback — when the artifact itself is missing
 *  or malformed; the by-stage/by-model bars still render regardless, since those come straight from
 *  `spend_ledger` rows, which don't depend on the artifact at all. */
export function buildClosedRoundCostPanel(round: Round, spend: readonly SpendRow[], phaseWindows: readonly PhaseWindow[]): CostPanelData {
  const summary = readSummary(round.artifact);
  const footer =
    summary.spendUsd !== null && summary.prsMerged !== null
      ? roundCostFooter(summary.spendUsd, summary.prsMerged, reviewSpendUsd(spend))
      : null;
  return {
    heading: `cost · round ${round.roundId}`,
    closed: true,
    stageBars: stageCostBars(bucketSpendByPhase(spend, phaseWindows)),
    targetUsd: stageTargetUsd(summary.roundBudgetUsd),
    modelBars: modelCostBars(spend),
    footer,
  };
}
