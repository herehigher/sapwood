import * as Popover from "@radix-ui/react-popover";

/**
 * The "?" legend toggle — frontend-design.md §7: "That is the whole onboarding surface —
 * no tour, no modal sequence." Role vocabulary (producer ≠ reviewer ≠ merger) lives here and
 * nowhere else on the stage (issue #144's AC).
 *
 * #892: was a native `<details>` disclosure — simple, but its content grew the header's own
 * in-flow height on open, shoving the "?" (and everything after it) down and moving it out from
 * under the pointer mid-interaction. The adjudicated Radix popover fixes this the same way it
 * fixes every other floating surface here: `Popover.Content` renders in Radix's own layer, never
 * adding to `.app-header`'s box — the header's `boundingBox()` is identical open or closed
 * (Playwright, `shots.spec.ts`).
 */

export const LEGEND_ITEMS = [
  { symbol: "⊙", text: "droplet = an issue moving through the loop" },
  { symbol: "▤", text: "lane = one autonomous worker" },
  { symbol: "◎", text: "ring = one merged PR" },
] as const;

export function Legend() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="hero-legend-trigger recipe-press" aria-label="Legend">
          ?
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="hero-legend-content" sideOffset={6}>
          <ul>
            {LEGEND_ITEMS.map((item) => (
              <li key={item.text}>
                <span aria-hidden="true">{item.symbol}</span> {item.text}
              </li>
            ))}
          </ul>
          <Popover.Arrow className="hero-legend-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
