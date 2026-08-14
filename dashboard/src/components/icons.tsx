/**
 * Inline SVG glyphs (frontend-design.md §3 C / §5): "never color as the sole carrier" applies to
 * every one of these — each is a distinct SHAPE, readable in grayscale, not just a colored dot.
 *
 * `IssueGlyph` (⊙) and `PrGlyph` (merge-arrow), here, plus the sap droplet and growth rings
 * (hero/stage.tsx), are the IDENTITY glyph set — hand-drawn permanently, never sourced from
 * `lucide-react` (§2 dependency budget, owner adjudication 2026-08-14). `StateGlyph` below is a
 * UTILITY glyph (a gate/state ✓/✕, not one of sapwood's own visual metaphors) that stays
 * hand-drawn until/unless a future adoption swaps it for a `lucide-react` icon — #729 is where
 * that call gets made, not this file. `lucide-react` itself supplies utility icons only (chrome
 * affordances: close, expand, external-link, and the like) — any component reaching for one
 * imports directly from the package; a new import gets a §2 adjudication-table mention at
 * adoption. Unified icon spec for those utility imports: 24×24 viewBox grid, 1.5 stroke width,
 * round caps and joins, `currentColor` stroke (never a hardcoded hex — themes swap under it for
 * free), rendered at 16px by default. The glyphs below keep their own dimensions/strokes as
 * specced per-glyph; the unified spec binds `lucide-react` icons only, not these.
 */

/** Issue = circle-dot (⊙). */
export function IssueGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

/** PR = merge-arrow: two branches joining one trunk. */
export function PrGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={className}>
      <circle cx="4" cy="3" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="13" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 4.6 V 11.4 M4 8 C 4 5.5 7 5.5 10.4 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Gate/state outcome — rendered ALONGSIDE color, never instead of it (§5 quality floor:
 *  moss/rust is deuteranopia-ambiguous). `ok` picks the shape; the caller picks the color. */
export function StateGlyph({ ok, className }: { ok: boolean; className?: string }) {
  return ok ? (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={className}>
      <path d="M3 8.5 L 6.5 12 L 13 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={className}>
      <path d="M4 4 L 12 12 M12 4 L 4 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
