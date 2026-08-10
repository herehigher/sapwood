import type { ReactNode } from "react";

/** frontend-design.md §6/§9: "only genuinely non-replayable surfaces (est overlays, config
 *  drawer, backlog counts) render from `/api/loop/state` alone and dim in replay" — greyed out
 *  with an on-panel `"live only"` caption, never a mere footnote (§11: "the badge belongs on the
 *  panel that would otherwise lie"). Whenever `mode === "replay"`, `children` are not rendered at
 *  all — a snapshot-backed panel showing this in replay must never leak its last-known LIVE value
 *  through as if it were current, regardless of what `children` happens to hold. */
export function LiveOnly({ mode, children }: { mode: "live" | "replay"; children: ReactNode }) {
  if (mode === "replay") {
    return (
      <div className="live-only" role="status" aria-label="live only">
        <p className="muted live-only-caption">live only</p>
      </div>
    );
  }
  return <>{children}</>;
}
