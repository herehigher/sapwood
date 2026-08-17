import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";

export interface HintTooltipProps {
  /** The folded hint text (e.g. an entity's title, an absolute timestamp). `undefined`/empty
   *  renders `children` completely unwrapped — same "no tooltip, no network call" contract the
   *  bare `title=` attribute this replaces used to have (#892). */
  content?: string | undefined;
  /** The trigger element — cloned via Radix's `asChild`, never an extra wrapper node, so this
   *  drops into inline contexts (entity refs inside a sentence) exactly like the element did on
   *  its own. */
  children: ReactElement;
}

/**
 * §5 quality-floor adjudication (#876, 2026-08-14): the shared Radix tooltip for every hover/focus
 * hint surface — hover AND keyboard focus both open it (Radix's own trigger wiring), unlike a bare
 * `title=` attribute which only a pointer can reach. Deliberately no `Tooltip.Portal`: the content
 * still renders inline (Radix's portal context defaults to "no portal" when absent), so it
 * participates in normal layout/positioning rather than teleporting to `document.body` — this
 * surface never needed viewport-escaping placement, and staying in-tree keeps SSR/real-DOM
 * rendering uniform.
 */
export function HintTooltip({ content, children }: HintTooltipProps) {
  if (!content) return children;
  return (
    // #892 AC5: no `delayDuration` override here — that would be a bare millisecond literal this
    // component introduces, exactly what AC5 bans. Radix's own built-in default (defined inside
    // the library, not authored by this diff) applies instead; nothing here depends on a specific
    // delay value.
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Content className="hint-tooltip" sideOffset={4}>
          {content}
          <Tooltip.Arrow className="hint-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
