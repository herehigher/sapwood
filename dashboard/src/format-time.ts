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

/** Compact relative form used by the feed and needs-attention age chips (e.g. "14s ago"). */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const deltaSec = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  const units: [string, number][] = [
    ["y", 365 * 24 * 3600],
    ["mo", 30 * 24 * 3600],
    ["d", 24 * 3600],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  for (const [suffix, secs] of units) {
    if (deltaSec >= secs) return `${Math.floor(deltaSec / secs)}${suffix} ago`;
  }
  return "just now";
}

/** Rule 2: pairs a relative string with its hover-absolute title via `formatAbsoluteTime`. */
export function formatRelativeWithAbsoluteTitle(
  iso: string,
  mode: TimeMode = "local",
  now: Date = new Date(),
): { text: string; title: string } {
  return { text: formatRelativeTime(iso, now), title: formatAbsoluteTime(iso, mode) };
}
