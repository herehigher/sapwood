import { useEffect, useState } from "react";
import { applyTheme, nextTheme, readStoredTheme, type ThemeOverride } from "../theme.ts";

/**
 * frontend-design.md §3: "wordmark at top, anchor / drawer entries (overview, cost, config) and
 * the theme switch, config gear at bottom." The prose lists `config` among the anchor entries
 * and then separately calls out "config gear at bottom" — read here as ONE item, not two: config
 * is the entry the prose is telling us sits at the bottom (as a gear glyph, unlike the plain
 * anchor glyphs for overview/cost), not a second config affordance. (Reading proposed for gate②
 * per #727's AC1/AC2 — flag if a different split was intended.)
 *
 * The wordmark also moves here from the header `<h1>` it used to live in (§361/#145): §3's own
 * ASCII diagram draws no rail column and keeps the wordmark in header band A, but that diagram
 * predates this rail ever being scoped to an issue (#727's own "Why") — the prose is the rail's
 * actual textual spec, so it wins and the header wordmark is removed rather than duplicated.
 */

function WordmarkGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 3 C 5 6 5 10 8 13 C 11 10 11 6 8 3 Z" fill="currentColor" />
    </svg>
  );
}

function OverviewGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M2 12 L2 7 L6 7 L6 12 M10 12 L10 3 L14 3 L14 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CostGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2 14 V2 M2 14 H14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 11.5 V8.5 M8 11.5 V5 M11.5 11.5 V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Half-filled disc — reads as a light/dark toggle in outline alone, never color-only (§5). */
function ThemeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2 A 6 6 0 0 1 8 14 Z" fill="currentColor" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.5 V3.3 M8 12.7 V14.5 M14.5 8 H12.7 M3.3 8 H1.5 M12.7 3.3 L11.4 4.6 M4.6 11.4 L3.3 12.7 M12.7 12.7 L11.4 11.4 M4.6 4.6 L3.3 3.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const THEME_LABEL: Record<"system" | "sapwood" | "heartwood", string> = {
  system: "theme: following system — click for light",
  sapwood: "theme: light (sapwood) — click for dark",
  heartwood: "theme: dark (heartwood) — click to follow system",
};

export interface IconRailProps {
  /** Opens the same read-only config drawer §3 E's `Config ▸` used to trigger (#145's component,
   *  relocated trigger — #727 AC2). */
  onOpenConfig: () => void;
}

export function IconRail({ onOpenConfig }: IconRailProps) {
  const [theme, setTheme] = useState<ThemeOverride>(null);
  // Reads any stored override once on mount — SSR/first paint renders "system", then settles,
  // same posture as every other client-only-state seam in this app (no flash-relevant test
  // depends on the pre-mount value since `renderToStaticMarkup` never runs effects at all).
  useEffect(() => setTheme(readStoredTheme()), []);

  const themeKey = theme ?? "system";

  return (
    <nav className="icon-rail" aria-label="sapwood">
      <span className="icon-rail-wordmark" title="sapwood">
        <WordmarkGlyph />
      </span>
      <a className="icon-rail-item" href="#overview" title="overview" aria-label="overview">
        <OverviewGlyph />
      </a>
      <a className="icon-rail-item" href="#cost" title="cost" aria-label="cost">
        <CostGlyph />
      </a>
      <button
        type="button"
        className="icon-rail-item icon-rail-theme"
        title={THEME_LABEL[themeKey]}
        aria-label={THEME_LABEL[themeKey]}
        onClick={() => {
          const next = nextTheme(theme);
          applyTheme(next);
          setTheme(next);
        }}
      >
        <ThemeGlyph />
      </button>
      <button type="button" className="icon-rail-item icon-rail-config" title="config" aria-label="open config" onClick={onOpenConfig}>
        <GearGlyph />
      </button>
    </nav>
  );
}
