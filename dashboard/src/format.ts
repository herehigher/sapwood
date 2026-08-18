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

/** The by-model cost row's alias (#953, #929 D31): a vendor-prefixed, version-suffixed model id
 *  ("claude-sonnet-5") reduced to its family word ("sonnet") for display — one generic rule, no
 *  per-vendor table. Drop trailing purely-numeric `-` segments (the version), then drop a leading
 *  vendor segment when at least two segments remain; whatever's left is the family word. An id the
 *  rule can't reduce (no `-` separator, or a fully-numeric id that reduces to nothing) renders
 *  verbatim — deliberately no per-vendor map, an unrecognized shape falls through on purpose. */
export function modelDisplayName(id: string): string {
  const segments = id.split("-");
  if (segments.length < 2) return id;
  let end = segments.length;
  while (end > 0 && /^\d+$/.test(segments[end - 1]!)) end--;
  let kept = segments.slice(0, end);
  if (kept.length >= 2) kept = kept.slice(1);
  const result = kept.join("-");
  return result.length > 0 ? result : id;
}
