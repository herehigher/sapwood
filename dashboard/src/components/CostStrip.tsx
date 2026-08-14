import type { CostBar, CostPanelData, RoundCostFooter } from "../cost-panel.ts";
import { tickPositionPct } from "../cost-panel.ts";

export type { CostBar, CostPanelData } from "../cost-panel.ts";

/** Hand-rolled SVG bar (frontend-design.md §3 E) — zero chart-library dependency, on purpose (§2
 *  dependency budget, `scaffold.test.ts`'s banned-package check). One `<rect>` fill over a faint
 *  track `<rect>`, plus an optional target-tick `<line>` shared across a group's bars. */
function Bar({ bar, max, targetPct }: { bar: CostBar; max: number; targetPct: number | null }) {
  const pct = max > 0 ? Math.min(100, (bar.usd / max) * 100) : 0;
  return (
    <li className="cost-bar-row">
      <span className="data muted cost-bar-label">{bar.label}</span>
      <svg
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        className="cost-bar"
        role="img"
        aria-label={`${bar.label}: $${bar.usd.toFixed(2)}`}
      >
        <rect x="0" y="0" width="100" height="10" fill="var(--bark)" opacity="0.25" />
        <rect x="0" y="0" width={pct} height="10" fill="var(--sap)" />
        {targetPct != null && <line x1={targetPct} y1="0" x2={targetPct} y2="10" className="cost-bar-target" />}
      </svg>
      <span className="data cost-bar-value">${bar.usd.toFixed(2)}</span>
    </li>
  );
}

function BarGroup({ title, bars, max, targetPct = null }: { title: string; bars: CostBar[]; max: number; targetPct?: number | null }) {
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
  const stageMax = Math.max(0, ...stageBars.map((b) => b.usd), targetUsd ?? 0);
  const targetPct = targetUsd != null ? tickPositionPct(targetUsd, stageMax) : null;
  const modelMax = Math.max(0, ...modelBars.map((b) => b.usd));
  return (
    <div className="cost-panel">
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
 * pass) — two stacked panels: "today" (always present) and "round" (a closed round's own detail,
 * `null` when none is available yet — e.g. no round has closed today). `id="cost"` is the §3
 * rail's "cost" anchor target (#727) — this is the ONE cost-strip instance the app renders, so a
 * hardcoded id beats a prop no caller would ever vary.
 */
export function CostStrip({ today, round }: { today: CostPanelData; round: CostPanelData | null }) {
  return (
    <section id="cost" className="panel cost-strip" aria-label="cost">
      <CostPanel {...today} />
      {round && <CostPanel {...round} />}
    </section>
  );
}
