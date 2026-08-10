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

export function applyTheme(theme: ThemeOverride): void {
  if (typeof document !== "undefined") {
    if (theme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }
  if (typeof localStorage === "undefined") return;
  try {
    if (theme === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode, quota) — the attribute still applies for the session */
  }
}
