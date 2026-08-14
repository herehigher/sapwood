export interface CostBar {
  label: string;
  usd: number;
}

export interface CostBarGroup {
  title: string;
  bars: CostBar[];
}

/** Hand-rolled SVG bar groups (frontend-design.md §3 E) — zero chart-library dependency, on
 *  purpose (§2 dependency budget, `scaffold.test.ts`'s banned-package check). Each bar is one `<rect>`
 *  over a faint track `<rect>`; that is the entire "chart". */
function Bar({ bar, max }: { bar: CostBar; max: number }) {
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
      </svg>
      <span className="data cost-bar-value">${bar.usd.toFixed(2)}</span>
    </li>
  );
}

export function CostStrip({ groups, heading = "cost · today" }: { groups: CostBarGroup[]; heading?: string }) {
  const max = Math.max(0, ...groups.flatMap((g) => g.bars.map((b) => b.usd)));
  return (
    // `id="cost"` is the §3 rail's "cost" anchor target (#727) — this is the ONE cost-strip
    // instance the app renders, so a hardcoded id beats a prop no caller would ever vary.
    <section id="cost" className="panel cost-strip" aria-label="cost">
      <h2>{heading}</h2>
      <div className="cost-strip-groups">
        {groups.map((group) => (
          <div key={group.title} className="cost-strip-group">
            <h3 className="muted">{group.title}</h3>
            {group.bars.length === 0 ? (
              <p className="muted">no spend yet today</p>
            ) : (
              <ul className="cost-bar-list">
                {group.bars.map((bar) => (
                  <Bar key={bar.label} bar={bar} max={max} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
