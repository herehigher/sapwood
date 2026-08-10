import type { ReactNode } from "react";

/** frontend-design.md §6/§9: "only genuinely non-replayable surfaces (est overlays, config
 *  drawer, backlog counts) render from `/api/loop/state` alone and dim in replay" — greyed out
 *  with an on-panel `"live only"` caption, never a mere footnote (§11: "the badge belongs on the
 *  panel that would otherwise lie"). Whenever `mode === "replay"`, `children` are not rendered at
 *  all — a snapshot-backed panel showing this in replay must never leak its last-known LIVE value
 *  through as if it were current, regardless of what `children` happens to hold. */
export function LiveOnly({ mode, children }: { mode: "live" | "replay"; children: ReactNode }) {
  if (mode === "replay") {
    // #766 gate② finding [1] (live-only-is-not-a-greyed-panel): the `panel` class is what makes
    // this read as the SAME panel, dimmed, rather than a bare unstyled div dropped in its place —
    // `.live-only` (app.css) applies the actual grey-out (reduced opacity + dashed border), so the
    // caption is a badge ON a recognizably panel-shaped surface, never floating text alone.
    return (
      <div className="panel live-only" role="status" aria-label="live only">
        <p className="muted live-only-caption">live only</p>
      </div>
    );
  }
  return <>{children}</>;
}
