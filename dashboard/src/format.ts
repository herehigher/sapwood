/** Elapsed time / relative-timestamp formatting shared by the lane board and the activity feed. */

export function formatElapsed(startedAt: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(startedAt).getTime());
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Relative timestamp for the activity feed ("2m ago", "just now"). */
export function formatRelative(ts: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(ts).getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
