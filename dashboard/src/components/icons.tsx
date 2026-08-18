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
 *
 * #922: hero UTILITY glyphs (planning trio, gate, reflection, escalation icons) source from
 * `lucide-react` under this same spec — `hero/stage.tsx`'s own icon calls, not this file. CI is
 * the one exception: no lucide icon names GitHub Actions, so its glyph is a pasted static asset,
 * `GithubActionsGlyph` below (§2 dependency table carries the source/licence row) — "standard
 * resource first" extends to a vetted static SVG when no icon-set entry exists, not just to
 * lucide itself. The hero's own IDENTITY set (sap droplet, growth rings, `IssueGlyph`/`PrGlyph`
 * here) stays hand-drawn regardless.
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

/**
 * #922 owner ruling (2026-08-17): the CI gate's icon — standard resources first, hand-drawing a
 * gear was the thing to replace. Verbatim path data from the devicon/techicons GitHub Actions SVG
 * (`viewBox 0 0 128 128`, MIT — https://techicons.dev/icons/githubactions, source
 * https://github.com/devicons/devicon/blob/master/icons/githubactions/githubactions-original.svg),
 * recoloured: both original literal fills (`#2088ff`/`#79b8ff`) become `currentColor`, the lighter
 * second path kept at its own reduced opacity so the two-tone shape still reads once both resolve
 * to one theme colour.
 */
export function GithubActionsGlyph({
  className,
  x,
  y,
  width = 16,
  height = 16,
}: {
  className?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  return (
    <svg viewBox="0 0 128 128" x={x} y={y} width={width} height={height} aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M26.666 0C11.97 0 0 11.97 0 26.666c0 12.87 9.181 23.651 21.334 26.13v37.87c0 11.77 9.68 21.334 21.332 21.334h.195c1.302 9.023 9.1 16 18.473 16C71.612 128 80 119.612 80 109.334s-8.388-18.668-18.666-18.668c-9.372 0-17.17 6.977-18.473 16h-.195c-8.737 0-16-7.152-16-16V63.779a18.514 18.514 0 0 0 13.24 5.555h2.955c1.303 9.023 9.1 16 18.473 16 9.372 0 17.169-6.977 18.47-16h11.057c1.303 9.023 9.1 16 18.473 16 10.278 0 18.666-8.39 18.666-18.668C128 56.388 119.612 48 109.334 48c-9.373 0-17.171 6.977-18.473 16H79.805c-1.301-9.023-9.098-16-18.471-16s-17.171 6.977-18.473 16h-2.955c-6.433 0-11.793-4.589-12.988-10.672 14.58-.136 26.416-12.05 26.416-26.662C53.334 11.97 41.362 0 26.666 0zm0 5.334A21.292 21.292 0 0 1 48 26.666 21.294 21.294 0 0 1 26.666 48 21.292 21.292 0 0 1 5.334 26.666 21.29 21.29 0 0 1 26.666 5.334zm-5.215 7.541C18.67 12.889 16 15.123 16 18.166v17.043c0 4.043 4.709 6.663 8.145 4.533l13.634-8.455c3.257-2.02 3.274-7.002.032-9.045l-13.635-8.59a5.024 5.024 0 0 0-2.725-.777zm-.117 5.291 13.635 8.588-13.635 8.455V18.166zm40 35.168a13.29 13.29 0 0 1 13.332 13.332A13.293 13.293 0 0 1 61.334 80 13.294 13.294 0 0 1 48 66.666a13.293 13.293 0 0 1 13.334-13.332zm48 0a13.29 13.29 0 0 1 13.332 13.332A13.293 13.293 0 0 1 109.334 80 13.294 13.294 0 0 1 96 66.666a13.293 13.293 0 0 1 13.334-13.332zm-42.568 6.951a2.667 2.667 0 0 0-1.887.78l-6.3 6.294-2.093-2.084a2.667 2.667 0 0 0-3.771.006 2.667 2.667 0 0 0 .008 3.772l3.974 3.96a2.667 2.667 0 0 0 3.766-.001l8.185-8.174a2.667 2.667 0 0 0 .002-3.772 2.667 2.667 0 0 0-1.884-.78zm48 0a2.667 2.667 0 0 0-1.887.78l-6.3 6.294-2.093-2.084a2.667 2.667 0 0 0-3.771.006 2.667 2.667 0 0 0 .008 3.772l3.974 3.96a2.667 2.667 0 0 0 3.766-.001l8.185-8.174a2.667 2.667 0 0 0 .002-3.772 2.667 2.667 0 0 0-1.884-.78zM61.334 96a13.293 13.293 0 0 1 13.332 13.334 13.29 13.29 0 0 1-13.332 13.332A13.293 13.293 0 0 1 48 109.334 13.294 13.294 0 0 1 61.334 96zM56 105.334c-2.193 0-4 1.807-4 4 0 2.195 1.808 4 4 4s4-1.805 4-4c0-2.193-1.807-4-4-4zm10.666 0c-2.193 0-4 1.807-4 4 0 2.195 1.808 4 4 4s4-1.805 4-4c0-2.193-1.807-4-4-4zM56 108c.75 0 1.334.585 1.334 1.334 0 .753-.583 1.332-1.334 1.332-.75 0-1.334-.58-1.334-1.332 0-.75.585-1.334 1.334-1.334zm10.666 0c.75 0 1.334.585 1.334 1.334 0 .753-.583 1.332-1.334 1.332-.75 0-1.332-.58-1.332-1.332 0-.75.583-1.334 1.332-1.334z"
      />
      <path
        fill="currentColor"
        opacity="0.55"
        d="M109.334 90.666c-9.383 0-17.188 6.993-18.477 16.031a2.667 2.667 0 0 0-.265-.011l-2.7.09a2.667 2.667 0 0 0-2.578 2.751 2.667 2.667 0 0 0 2.752 2.578l2.7-.087a2.667 2.667 0 0 0 .097-.006C92.17 121.029 99.965 128 109.334 128c10.278 0 18.666-8.388 18.666-18.666s-8.388-18.668-18.666-18.668zm0 5.334a13.293 13.293 0 0 1 13.332 13.334 13.29 13.29 0 0 1-13.332 13.332A13.293 13.293 0 0 1 96 109.334 13.294 13.294 0 0 1 109.334 96z"
      />
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
