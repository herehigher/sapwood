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
 * #924 (D29/D30) — the hairline-bar grammar: a 1px track, an amber pill fill >= 6px tall (pill
 * radius = half its own height), and a target tick taller than the pill. The viewBox's 12-unit
 * height is a fixed LOCAL coordinate space every instance shares — `preserveAspectRatio="none"`
 * lets each caller's own CSS height (cost panel / lane card / header capsule, panels.css) stretch
 * it non-uniformly, but the three shapes' own local heights (and the track-vs-fill-vs-tick
 * relationship AC2 checks) never change per instance.
 */
const TRACK_Y = 5.5;
const FILL_HEIGHT = 6;
const FILL_CENTER_Y = 6; // the viewBox's own vertical center (0 0 100 12) — symmetric either way
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
  return (
    <svg
      viewBox="0 0 100 12"
      preserveAspectRatio="none"
      className={className ? `cost-bar ${className}` : "cost-bar"}
      role="img"
      aria-label={ariaLabel}
    >
      <HatchDef />
      {/* #924 gate② round 3 finding (witness-blocking 3): a STROKED line, not a filled rect — a
       * fill-rect's crispness depends on its Y edges landing on integer pixel rows, which drifted
       * under real-browser rasterization (rendered ~2px tall); `vector-effect: non-scaling-stroke`
       * (panels.css) keeps a stroke's WIDTH pinned to exactly 1 device px regardless of any
       * scaling, and TRACK_Y's own half-integer value centers that 1px stroke exactly on pixel
       * row 5 (5.0–6.0). */}
      <line className="cost-bar-track" x1="0" y1={TRACK_Y} x2="100" y2={TRACK_Y} />
      {/* #924 AC2/AC3: a filled `rect rx=...` sits inside the SAME non-uniformly scaled viewBox
       * the tick/track lines address — `rx` is fill geometry, not a stroke, so `vector-effect`
       * never protects it, and the bar's non-uniform X scale stretches the "circular" pill ends
       * into ellipses. Same fix family as the tick/track: a STROKED line with
       * `stroke-linecap: round` (panels.css) — the round cap's own radius (half the stroke-width)
       * is part of the STROKE render, so `vector-effect: non-scaling-stroke` keeps it a true
       * circle regardless of the X distortion. Two stacked lines (both suppressed when
       * `settledPct` is 0 — no phantom dot at the bar's start, same "never a phantom segment"
       * posture the est hatch tail below already follows): a WIDER outline line drawn first (its
       * 1px-larger stroke peeks out on light theme only — `--sap-fill-outline`, transparent in
       * dark — around the whole pill, caps included), then the actual amber pill on top. */}
      {settledPct > 0 && (
        <>
          <line className="cost-bar-fill-outline" x1="0" y1={FILL_CENTER_Y} x2={settledPct} y2={FILL_CENTER_Y} />
          <line className="cost-bar-fill" x1="0" y1={FILL_CENTER_Y} x2={settledPct} y2={FILL_CENTER_Y} />
        </>
      )}
      {estPct > 0 && (
        <rect x={settledPct} y={FILL_CENTER_Y - FILL_HEIGHT / 2} width={estPct} height={FILL_HEIGHT} fill={`url(#${HATCH_PATTERN_ID})`} />
      )}
      {targetPct != null && <line className="cost-bar-target" x1={targetPct} y1={TICK_Y1} x2={targetPct} y2={TICK_Y2} />}
    </svg>
  );
}
