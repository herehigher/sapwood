/**
 * The "?" legend toggle — frontend-design.md §7: "That is the whole onboarding surface —
 * no tour, no modal sequence." Role vocabulary (producer ≠ reviewer ≠ merger) lives here and
 * nowhere else on the stage (issue #144's AC).
 *
 * A native `<details>` disclosure: no React state, no click handler to wire or test — the
 * browser owns open/closed, and the three lines are always present in server-rendered markup
 * for a component test to assert on directly. Styled by `app.css` (`.hero-legend`) — the
 * header owns it now, not the hero SVG, so it stays out of `hero.css`.
 */

export const LEGEND_ITEMS = [
  { symbol: "⊙", text: "droplet = an issue moving through the loop" },
  { symbol: "▤", text: "lane = one autonomous worker" },
  { symbol: "◎", text: "ring = one merged PR" },
] as const;

export function Legend() {
  return (
    <details className="hero-legend">
      <summary aria-label="Legend">?</summary>
      <ul>
        {LEGEND_ITEMS.map((item) => (
          <li key={item.text}>
            <span aria-hidden="true">{item.symbol}</span> {item.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
