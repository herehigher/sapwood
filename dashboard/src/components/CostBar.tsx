/**
 * The est/settled budget-bar grammar (frontend-design.md §3 E, #890 — fidelity-ledger row 7
 * reopened): ONE shared primitive + ONE SVG `<pattern>` hatch def (§2 no-chart-library
 * adjudication — hand-rolled SVG, same posture as the pre-existing `CostStrip.tsx` bar this
 * component replaces), reused by the header spend meter, lane cards, and the cost panels alike so
 * the est segment's texture can never diverge per module. The est share is always drawn with the
 * hatch pattern, never color alone (§3 E / §5 quality floor).
 */

export const HATCH_PATTERN_ID = "cost-bar-est-hatch";

/** The hatch pattern def, styled entirely from `tokens.css`'s `--hatch-*` custom properties (§2
 *  adjudication log, 2026-08-14) — duplicated into each `<CostBar>` instance's own `<defs>` rather
 *  than mounted once at the app root, so a bar renders correctly in isolation (a component test,
 *  a single-panel embed) without depending on some other tree having mounted the def first. SVG
 *  ids are document-global, but a repeated identical def is idempotent — later instances simply
 *  redeclare the same id, never a visual conflict. */
function HatchDef() {
  return (
    <defs>
      <pattern id={HATCH_PATTERN_ID} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(var(--hatch-angle))">
        <line x1="0" y1="0" x2="0" y2="3" stroke="var(--hatch-stroke)" strokeWidth="var(--hatch-stroke-width)" />
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
const TRACK_Y = 5.5;
const FILL_Y = 3;
const FILL_HEIGHT = 6;
const FILL_RADIUS = FILL_HEIGHT / 2;
const TICK_Y1 = 1;
const TICK_Y2 = 11;

/** Hand-rolled SVG bar (frontend-design.md §3 E) — zero chart-library dependency, on purpose (§2
 *  dependency budget). Settled fill first, hatched est tail immediately after it, both clamped to
 *  the track so neither segment ever draws past 100%. */
export function CostBar({ settledUsd, estUsd, max, targetPct = null, label, className }: CostBarProps) {
  const est = estUsd ?? 0;
  const settledPct = max > 0 ? Math.min(100, (settledUsd / max) * 100) : 0;
  const totalPct = max > 0 ? Math.min(100, ((settledUsd + est) / max) * 100) : 0;
  const estPct = Math.max(0, totalPct - settledPct);
  const ariaLabel = est > 0 ? `${label}: $${settledUsd.toFixed(2)} + $${est.toFixed(2)} est` : `${label}: $${settledUsd.toFixed(2)}`;
  // #924 AC2: the hatch tail's own leading edge, extended `FILL_RADIUS` px BACKWARD under the
  // pill (only when a pill actually exists there to cover it — at 0% settled there is no pill, so
  // no extension, or the hatch would overshoot the bar's own left edge with nothing hiding it).
  // The pill's `rx` corner recedes inward from the nominal seam by up to that same radius at its
  // top/bottom edges (a rounded corner is never a flat vertical line) — without the extension, the
  // hatch's own flat edge stayed at the nominal seam, leaving an unpainted cusp between the two
  // curves at the top/bottom rows. `width` grows by the SAME amount so the hatch's own TRAILING
  // edge (at `totalPct%`) is unaffected — only the leading edge moves. Percentage arithmetic mixed
  // with a fixed px offset needs `calc()`, which SVG geometry properties only resolve via `style`,
  // never as a plain attribute string.
  const hatchInset = settledPct > 0 ? FILL_RADIUS : 0;
  return (
    <svg width="100%" height="12" className={className ? `cost-bar ${className}` : "cost-bar"} role="img" aria-label={ariaLabel}>
      <HatchDef />
      {/* The bar's fixed full-width reference — a plain 1px stroke, no `rx`/round cap of its own,
       * so it never needs anything beyond its own coordinates to stay inside the box. */}
      <line className="cost-bar-track" x1="0" y1={TRACK_Y} x2="100%" y2={TRACK_Y} />
      {/* #924 AC2: rendered BEFORE the pill (below), extended back under it (see `hatchInset`
       * above) — the pill's own opaque fill, painted on top, covers the seam cleanly instead of a
       * flat hatch edge cutting a visible notch into the pill's curved cap. */}
      {estPct > 0 && (
        <rect
          style={{ x: `calc(${settledPct}% - ${hatchInset}px)`, width: `calc(${estPct}% + ${hatchInset}px)` }}
          y={FILL_Y}
          height={FILL_HEIGHT}
          fill={`url(#${HATCH_PATTERN_ID})`}
        />
      )}
      {/* #924 AC2: the settled fill — never a phantom zero-width pill at 0% (same "never a
       * phantom segment" posture the est hatch tail above already follows). The light-theme
       * outline (panels.css: `stroke: var(--sap-fill-outline)`) lives on this SAME rect, not a
       * second wider element underneath it — a `rect`'s own stroke traces its already-rounded
       * path directly, so one element is enough. */}
      {settledPct > 0 && <rect className="cost-bar-fill" x="0" y={FILL_Y} width={`${settledPct}%`} height={FILL_HEIGHT} rx={FILL_RADIUS} />}
      {targetPct != null && <line className="cost-bar-target" x1={`${targetPct}%`} y1={TICK_Y1} x2={`${targetPct}%`} y2={TICK_Y2} />}
    </svg>
  );
}
