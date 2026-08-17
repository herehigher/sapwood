import type { CostBar as CostBarData, CostPanelData, RoundCostFooter } from "../cost-panel.ts";
import { tickPositionPct } from "../cost-panel.ts";
import { CostBar } from "./CostBar.tsx";

export type { CostBar, CostPanelData } from "../cost-panel.ts";

/** #890 (§3 E): the shared `<CostBar>` primitive — no per-module divergence — settled fill plus a
 *  hatched est tail (`bar.estUsd`, #890, present only on the "today" panel's "Lanes" bar). */
function Bar({ bar, max, targetPct }: { bar: CostBarData; max: number; targetPct: number | null }) {
  return (
    <li className="cost-bar-row">
      <span className="data muted cost-bar-label">{bar.label}</span>
      <CostBar settledUsd={bar.usd} estUsd={bar.estUsd} max={max} targetPct={targetPct} label={bar.label} />
      <span className="data cost-bar-value">${bar.usd.toFixed(2)}</span>
    </li>
  );
}

function BarGroup({ title, bars, max, targetPct = null }: { title: string; bars: CostBarData[]; max: number; targetPct?: number | null }) {
  return (
    <div className="cost-panel-group">
      <h4 className="muted">{title}</h4>
      {bars.length === 0 ? (
        <p className="muted">no spend yet</p>
      ) : (
        <ul className="cost-bar-list">
          {bars.map((bar) => (
            <Bar key={bar.label} bar={bar} max={max} targetPct={targetPct} />
          ))}
        </ul>
      )}
    </div>
  );
}

function footerLine(footer: RoundCostFooter): string {
  const prWord = footer.prsMerged === 1 ? "PR" : "PRs";
  const perPr = footer.usdPerPr != null ? ` · $${footer.usdPerPr.toFixed(2)}/PR` : "";
  return `total $${footer.totalUsd.toFixed(2)} · ${footer.prsMerged} ${prWord} merged${perPr} · review $${footer.reviewUsd.toFixed(2)}`;
}

/** One "COST · ..." panel — `cost-dark.png`'s two stacked instances (TODAY, ROUND N) are the SAME
 *  shape, distinguished only by which optional fields are populated (`avgRoundUsd` for today,
 *  `closed`/`footer` for a round). */
function CostPanel({ heading, closed, avgRoundUsd, stageBars, targetUsd, modelBars, footer }: CostPanelData) {
  const stageMax = Math.max(0, ...stageBars.map((b) => b.usd + (b.estUsd ?? 0)), targetUsd ?? 0);
  const targetPct = targetUsd != null ? tickPositionPct(targetUsd, stageMax) : null;
  const modelMax = Math.max(0, ...modelBars.map((b) => b.usd));
  return (
    // `cost-dark.png` frames TODAY and ROUND N as two INDEPENDENT bordered cards, not one shared
    // card with an internal divider — `panel` here (gate② finding cost-panels-not-separate) is
    // what actually draws that border/background per card; the outer `<section>` below stays
    // unframed on purpose, since a THIRD border around both cards is not in the baseline.
    <div className="cost-panel panel">
      <div className="cost-panel-head">
        <h3>{heading}</h3>
        {closed && <span className="cost-panel-badge">closed</span>}
        {avgRoundUsd != null && <span className="data muted cost-panel-avg">avg round ${avgRoundUsd.toFixed(2)}</span>}
      </div>
      <div className="cost-panel-groups">
        <BarGroup title="by stage" bars={stageBars} max={stageMax} targetPct={targetPct} />
        <BarGroup title="by model" bars={modelBars} max={modelMax} />
      </div>
      {footer && <p className="data muted cost-panel-footer">{footerLine(footer)}</p>}
    </div>
  );
}

/**
 * §3 E's rebuilt cost composition (#880, superseding the single-strip by-model/by-lane first
 * pass) — two stacked, INDEPENDENTLY FRAMED panels (gate② finding cost-panels-not-separate: the
 * baseline shows two distinct cards separated by page background, never one card with an internal
 * divider): "today" (always present) and "round" (a closed round's own detail, `null` when none is
 * available yet — e.g. no round has closed today). This outer `<section>` carries no `panel`
 * framing of its own — it exists only for the `#cost` anchor (§3 rail target, #727) and the
 * `.stack` grid-column placement (app.css) — this is the ONE cost-strip instance the app renders,
 * so a hardcoded id beats a prop no caller would ever vary.
 */
export function CostStrip({ today, round }: { today: CostPanelData; round: CostPanelData | null }) {
  return (
    <section id="cost" className="cost-strip" aria-label="cost">
      <CostPanel {...today} />
      {round && <CostPanel {...round} />}
    </section>
  );
}
