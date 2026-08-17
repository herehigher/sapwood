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
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      className={className ? `cost-bar ${className}` : "cost-bar"}
      role="img"
      aria-label={ariaLabel}
    >
      <HatchDef />
      <rect x="0" y="0" width="100" height="10" fill="var(--bark)" opacity="0.25" />
      <rect x="0" y="0" width={settledPct} height="10" fill="var(--sap)" />
      {estPct > 0 && <rect x={settledPct} y="0" width={estPct} height="10" fill={`url(#${HATCH_PATTERN_ID})`} />}
      {targetPct != null && <line x1={targetPct} y1="0" x2={targetPct} y2="10" className="cost-bar-target" />}
    </svg>
  );
}
