/**
 * frontend-design.md §7 "Time display" — the only call site for
 * `Intl.DateTimeFormat`/`toLocaleString` on a stored ISO timestamp. Every absolute time
 * on the dashboard renders through `formatAbsoluteTime`; every relative timestamp's
 * hover title comes from `formatRelativeWithAbsoluteTitle`, which delegates to the same
 * function — an inline `toLocaleString` elsewhere is a review finding.
 */

export type TimeMode = "local" | "utc";

function offsetMinutes(date: Date, mode: TimeMode): number {
  return mode === "utc" ? 0 : -date.getTimezoneOffset();
}

function formatOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Rules 1 + 3: viewer-local (or UTC) clock time, always with a UTC-offset label. */
export function formatAbsoluteTime(iso: string, mode: TimeMode = "local"): string {
  const date = new Date(iso);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: mode === "utc" ? "UTC" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${clock} ${formatOffsetLabel(offsetMinutes(date, mode))}`;
}

const RELATIVE_UNITS: [string, number][] = [
  ["y", 365 * 24 * 3600],
  ["mo", 30 * 24 * 3600],
  ["d", 24 * 3600],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

function relativeDeltaSec(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
}

/** Compact relative form used by the feed and needs-attention age chips (e.g. "14s ago"). */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const deltaSec = relativeDeltaSec(iso, now);
  for (const [suffix, secs] of RELATIVE_UNITS) {
    if (deltaSec >= secs) return `${Math.floor(deltaSec / secs)}${suffix} ago`;
  }
  return "just now";
}

/** #925 AC4: the needs-attention strip's OLDEST-age emphasis box needs the bare numeral — no
 *  " ago" — so its bold, oversized text fits the fixed 96px age track; every other (small) age
 *  box keeps the full `formatRelativeTime` form. Same magnitude/suffix table as that function,
 *  just without the suffix word — not a second, independently-maintained unit ladder. */
export function formatCompactAge(iso: string, now: Date = new Date()): string {
  const deltaSec = relativeDeltaSec(iso, now);
  for (const [suffix, secs] of RELATIVE_UNITS) {
    if (deltaSec >= secs) return `${Math.floor(deltaSec / secs)}${suffix}`;
  }
  return "0s";
}

/** Rule 2: pairs a relative string with its hover-absolute title via `formatAbsoluteTime`. */
export function formatRelativeWithAbsoluteTitle(
  iso: string,
  mode: TimeMode = "local",
  now: Date = new Date(),
): { text: string; title: string } {
  return { text: formatRelativeTime(iso, now), title: formatAbsoluteTime(iso, mode) };
}
