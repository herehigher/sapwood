import { useId } from "react";

/**
 * The est/settled budget-bar grammar (frontend-design.md §3 E, #890 — fidelity-ledger row 7
 * reopened): ONE shared primitive + ONE SVG `<pattern>` hatch def (§2 no-chart-library
 * adjudication — hand-rolled SVG, same posture as the pre-existing `CostStrip.tsx` bar this
 * component replaces), reused by the header spend meter, lane cards, and the cost panels alike so
 * the est segment's texture can never diverge per module. The est share is always drawn with the
 * hatch pattern, never color alone (§3 E / §5 quality floor).
 */

/** Suffix shared by every instance's own pattern id — never the whole id. SVG element ids are
 *  document-global, so a fixed id shared across every `<CostBar>` would let `fill="url(#id)"`
 *  resolve to whichever instance's `<pattern>` happens to be first in the DOM (its ancestry's own
 *  `--hatch-stroke`), not the bar's own. Each instance prefixes this suffix with `useId()` so its
 *  `url(#…)` reference always resolves to ITS OWN def — which inherits ITS OWN `--hatch-stroke`
 *  override (e.g. a lane card's `--hatch-stroke-lane`), independent of every other bar on the
 *  page. Exported only because tests need to recognize "some bar's hatch def" without hardcoding
 *  a single global id. */
export const HATCH_PATTERN_ID_SUFFIX = "cost-bar-est-hatch";

/** The hatch pattern def, styled entirely from `tokens.css`'s `--hatch-*` custom properties (§2
 *  adjudication log, 2026-08-14) — mounted into each `<CostBar>` instance's own `<defs>` under its
 *  own per-instance id, so a bar renders correctly in isolation (a component test, a single-panel
 *  embed) without depending on some other tree having mounted the def first, AND so its
 *  `--hatch-stroke` override can never leak into or be shadowed by another instance.
 *
 *  `stroke`/`strokeWidth` are set via `style`, not plain SVG presentation attributes — CSS
 *  `var()` substitution for a presentation-attribute value is a real ancestor-chain lookup a
 *  browser performs at computed-value time, identical to a `style` declaration's, so this changes
 *  no rendering. It DOES change testability: it's the difference between a rendered oracle that
 *  can actually observe which `--hatch-stroke` scope won (this file's own real-DOM test) and one
 *  that can't. */
function HatchDef({ patternId }: { patternId: string }) {
  return (
    <defs>
      {/* `patternTransform` is an SVG-attribute-only transform-list, never a CSS property — it
       *  never goes through CSS value processing, so `var()` inside it doesn't substitute at all
       *  (confirmed directly: the attribute is left as literal text, and a browser treats an
       *  unparseable transform-list as absent, applying no rotation whatsoever — silently
       *  un-rotated, not a 45° fallback). tokens.css's `--hatch-angle: 45deg` is this repo's only
       *  declared angle and this is the only consumer, so the literal below is that same 45,
       *  spelled the way `rotate()`'s SVG transform-list grammar requires (a bare number of
       *  degrees, no unit, no `var()`) — keep the two in sync by hand if `--hatch-angle` ever
       *  changes. */}
      <pattern id={patternId} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="3" style={{ stroke: "var(--hatch-stroke)", strokeWidth: "var(--hatch-stroke-width)" }} />
      </pattern>
    </defs>
  );
}

export interface CostBarProps {
  /** The real, settled figure — drawn as a solid fill. */
  settledUsd: number;
  /** The engine's live/priced estimate for spend not yet settled — drawn as a hatched tail
   *  immediately after the settled fill. `null`/`undefined`/`0` renders no est segment at all
   *  (never a phantom zero-width hatch). */
  estUsd?: number | null | undefined;
  /** The bar's own 100%-width reference — a ceiling (header), or `settledUsd + estUsd` itself
   *  when no external ceiling exists (lane cards) — the caller's choice, this primitive only
   *  draws proportions against whatever `max` it's given. */
  max: number;
  /** The shared by-stage/by-model target-tick coordinate (`cost-panel.ts`'s `tickPositionPct`) —
   *  absent everywhere else. */
  targetPct?: number | null;
  label: string;
  className?: string;
  /** #923 (D16): the box height in real px — every shared instance (cost panels, lane cards)
   *  stays the default 12px grammar; only the header spend meter passes a taller value (the
   *  mockup's outlined ~20px capsule, vs the internal bars' thin 12px track). Track/fill/tick
   *  geometry below scales proportionally off this so a taller box is a genuinely bigger capsule,
   *  not the same 12px drawing floating in extra blank space. */
  height?: number;
}

/**
 * #924 (D29/D30) — the hairline-bar grammar: a 1px track, an amber pill fill (6px tall, `rx=3` —
 * a true semicircle at both ends), and a target tick taller than the pill. No `viewBox` — every
 * coordinate below is either a plain CSS px (matching the SVG's own real `width="100%"
 * height="12"`) or an SVG percentage length, which the browser resolves against that same real
 * rendered box natively, no runtime measurement or scale-compensation needed. A `rect`'s own `rx`
 * rounding is carved INWARD from its own x/width box — unlike a stroked line's round linecap,
 * which bulges OUTWARD past its endpoint — so the pill is fully contained inside the bar at every
 * settled percentage, 0 through 100, with nothing extra required to keep it that way.
 */
const BASE_HEIGHT = 12;
const BASE_TRACK_Y = 5.5;
const BASE_FILL_Y = 3;
const BASE_FILL_HEIGHT = 6;
const BASE_TICK_Y1 = 1;
const BASE_TICK_Y2 = 11;

/** Hand-rolled SVG bar (frontend-design.md §3 E) — zero chart-library dependency, on purpose (§2
 *  dependency budget). Settled fill first, hatched est tail immediately after it, both clamped to
 *  the track so neither segment ever draws past 100%. */
export function CostBar({ settledUsd, estUsd, max, targetPct = null, label, className, height = BASE_HEIGHT }: CostBarProps) {
  // Per-instance id (see HATCH_PATTERN_ID_SUFFIX above) — this bar's own `fill="url(#…)"` below
  // resolves to the `<pattern>` this SAME render mounts, never another instance's.
  const patternId = `${useId()}${HATCH_PATTERN_ID_SUFFIX}`;
  const est = estUsd ?? 0;
  const settledPct = max > 0 ? Math.min(100, (settledUsd / max) * 100) : 0;
  const totalPct = max > 0 ? Math.min(100, ((settledUsd + est) / max) * 100) : 0;
  const estPct = Math.max(0, totalPct - settledPct);
  const ariaLabel = est > 0 ? `${label}: $${settledUsd.toFixed(2)} + $${est.toFixed(2)} est` : `${label}: $${settledUsd.toFixed(2)}`;
  // #923: every coordinate below scales off the SAME BASE_* constants a height=12 (default) call
  // already draws exactly — `scale` is 1 there, so every existing shared-instance call site
  // (cost panels, lane cards) renders byte-identical geometry to before this prop existed.
  const scale = height / BASE_HEIGHT;
  const trackY = BASE_TRACK_Y * scale;
  const fillY = BASE_FILL_Y * scale;
  const fillHeight = BASE_FILL_HEIGHT * scale;
  const fillRadius = fillHeight / 2;
  const tickY1 = BASE_TICK_Y1 * scale;
  const tickY2 = BASE_TICK_Y2 * scale;
  // #924 AC2: the hatch tail's own leading edge, extended `fillRadius` px BACKWARD under the
  // pill — the pill's `rx` corner recedes inward from the nominal seam by up to that same radius
  // at its top/bottom edges (a rounded corner is never a flat vertical line), so an unextended
  // hatch edge left an unpainted cusp between the two curves there. `width` grows by the SAME
  // amount so the hatch's own TRAILING edge (at `totalPct%`) is unaffected — only the leading edge
  // moves. Percentage arithmetic mixed with a fixed px offset needs `calc()`, which SVG geometry
  // properties only resolve via `style`, never as a plain attribute string.
  //
  // `max(0px, ...)` clamps the leading edge itself: a settled share narrower than `fillRadius`
  // (a pill only a fraction of a px wide, or none at all at 0%) would otherwise push `calc(N% -
  // fillRadius px)` negative — and `.cost-bar`'s own `overflow: visible` (the fix for the pill's
  // 1px outline stroke straddling the box edge) means a negative x now actually PAINTS outside the
  // bar's own box instead of quietly clipping. `min(fillRadius px, N%)` shrinks the matching
  // width extension by the SAME amount the leading edge got clamped, so the trailing edge still
  // lands exactly at `totalPct%` regardless — at 0% settled this reduces to zero extension either
  // way (no pill exists yet to cover one).
  const hatchX = `max(0px, calc(${settledPct}% - ${fillRadius}px))`;
  const hatchWidth = `calc(${estPct}% + min(${fillRadius}px, ${settledPct}%))`;
  return (
    <svg width="100%" height={height} className={className ? `cost-bar ${className}` : "cost-bar"} role="img" aria-label={ariaLabel}>
      <HatchDef patternId={patternId} />
      {/* The bar's fixed full-width reference — a plain 1px stroke, no `rx`/round cap of its own,
       * so it never needs anything beyond its own coordinates to stay inside the box. */}
      <line className="cost-bar-track" x1="0" y1={trackY} x2="100%" y2={trackY} />
      {/* #924 AC2: rendered BEFORE the pill (below), extended back under it (see `hatchX`/
       * `hatchWidth` above) — the pill's own opaque fill, painted on top, covers the seam cleanly
       * instead of a flat hatch edge cutting a visible notch into the pill's curved cap. */}
      {estPct > 0 && <rect style={{ x: hatchX, width: hatchWidth }} y={fillY} height={fillHeight} fill={`url(#${patternId})`} />}
      {/* #924 AC2: the settled fill — never a phantom zero-width pill at 0% (same "never a
       * phantom segment" posture the est hatch tail above already follows). The light-theme
       * outline (panels.css: `stroke: var(--sap-fill-outline)`) lives on this SAME rect, not a
       * second wider element underneath it — a `rect`'s own stroke traces its already-rounded
       * path directly, so one element is enough. */}
      {settledPct > 0 && <rect className="cost-bar-fill" x="0" y={fillY} width={`${settledPct}%`} height={fillHeight} rx={fillRadius} />}
      {targetPct != null && <line className="cost-bar-target" x1={`${targetPct}%`} y1={tickY1} x2={`${targetPct}%`} y2={tickY2} />}
    </svg>
  );
}
