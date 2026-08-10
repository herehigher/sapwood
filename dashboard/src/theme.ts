/**
 * §3 rail theme switch. `null` = system default (no `[data-theme]` override — tokens.css's own
 * `prefers-color-scheme` rule decides); `"sapwood"`/`"heartwood"` are explicit overrides written
 * to `<html data-theme>` (tokens.css already reads that attribute — this module is the only
 * thing that ever sets it). Every DOM/storage touch is guarded by a `typeof` check so these stay
 * safely callable from `renderToStaticMarkup` (this repo's only test harness, which runs in
 * plain Node with no `document`/`localStorage`) as well as the real browser.
 */

export type ThemeOverride = "sapwood" | "heartwood" | null;

const STORAGE_KEY = "sapwood-theme";

/** Cycle: system default → light (sapwood) → dark (heartwood) → back to system default. */
export function nextTheme(current: ThemeOverride): ThemeOverride {
  if (current === null) return "sapwood";
  if (current === "sapwood") return "heartwood";
  return null;
}

export function readStoredTheme(): ThemeOverride {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "sapwood" || stored === "heartwood" ? stored : null;
  } catch {
    return null;
  }
}

/** The DOM-only half of `applyTheme` — no storage write, so it's safe to call on every mount
 *  (including with a freshly-read stored value) without re-persisting what's already there. */
function applyThemeToDom(theme: ThemeOverride): void {
  if (typeof document === "undefined") return;
  if (theme === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function applyTheme(theme: ThemeOverride): void {
  applyThemeToDom(theme);
  if (typeof localStorage === "undefined") return;
  try {
    if (theme === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode, quota) — the attribute still applies for the session */
  }
}

/**
 * Gate② finding theme-override-not-restored: reading the stored override into React state is
 * not the same as re-applying it to `<html data-theme>` — without this, a page loaded under a
 * `heartwood` override but a light system theme rendered light while the rail's own label said
 * "dark (heartwood)". Called on mount (IconRail) so a reload re-asserts the stored override on
 * the DOM, not just on the button's caption.
 */
export function restoreTheme(): ThemeOverride {
  const stored = readStoredTheme();
  applyThemeToDom(stored);
  return stored;
}

/**
 * The exact composition IconRail's theme switch runs on click: advance the cycle, apply it to
 * the DOM/storage, then hand the new value to the caller's own state setter. Exported (#727
 * gate② finding rail-ac1-coverage) so a test can drive the REAL `nextTheme`+`applyTheme`
 * composition directly — IconRail.tsx's own click handler is now a one-line delegation to this,
 * so a test calling `railContent`'s `onToggleTheme` prop with a substitute callback (as the
 * prior round did) could still pass with `nextTheme`/`applyTheme` silently removed from the
 * production path; testing `toggleTheme` itself closes that gap.
 */
export function toggleTheme(current: ThemeOverride, setTheme: (next: ThemeOverride) => void): void {
  const next = nextTheme(current);
  applyTheme(next);
  setTheme(next);
}
