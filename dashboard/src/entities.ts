import type { LoopEvent } from "./api/types.ts";
import { hasAttention } from "./copy.ts";

/** An entity's remembered title, keyed by ISSUE number (frontend-design.md §3 C). Every event
 *  that carries a PR number also carries that PR's issue number in the same payload (`merged`,
 *  `drive-*`, `pr-held`/`pr-released`, `fix-rounds-capped`, …) — so one issue-keyed map covers
 *  both the issue's own title (`dispatched`) and its PR's title (the PR-open transition,
 *  `merged`) without a second, PR-keyed map. */
export type EntityTitles = Record<number, { issueTitle?: string; prTitle?: string }>;

/**
 * Folds `dispatched`'s `issueTitle` and `reclaim-done`/`merged`'s `prTitle` into a per-issue
 * title map — "the reducer remembers each entity's title from the FIRST title-bearing event it
 * folds" (§3 C), so later events never overwrite an already-known title. Processes events
 * oldest-first regardless of the array's own order, since the feed renders newest-first but
 * "first" here means chronological. Never makes a network call — an entity with no folded
 * title-bearing event simply has no title, by design (§3 C's accepted, bounded blind spot).
 *
 * `seed` folds an earlier call's result in (#715 gate② [0]: `useEventHistory`'s display window is
 * bounded for memory, but a title folded from an event that has since aged out of that window
 * must not be forgotten — this is why the caller accumulates titles incrementally, one page at a
 * time, onto `seed`, rather than re-deriving them from the bounded window on every render). An
 * existing seed entry is never overwritten — same "first wins" rule, just carried across calls
 * instead of within one array. Never mutates `seed` — a fresh object is always returned, safe to
 * use as React state.
 */
export function foldEntityTitles(events: readonly LoopEvent[], seed: EntityTitles = {}): EntityTitles {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const titles: EntityTitles = Object.fromEntries(Object.entries(seed).map(([issue, entry]) => [issue, { ...entry }]));
  for (const event of ordered) {
    const issue = event.payload.issue;
    if (typeof issue !== "number") continue;
    titles[issue] ??= {};
    const entry = titles[issue]!;
    const issueTitle = event.payload.issueTitle;
    if (entry.issueTitle === undefined && typeof issueTitle === "string") {
      entry.issueTitle = issueTitle;
    }
    const prTitle = event.payload.prTitle;
    if (entry.prTitle === undefined && typeof prTitle === "string") {
      entry.prTitle = prTitle;
    }
  }
  return titles;
}

/** An open (unresolved) attention-class event, keyed for supersede/eviction tracking. */
export type OpenAttention = Record<string, LoopEvent>;

/** Entity-scoped attention items key by `${kind}:${issue}` (matching the engine's own
 *  `escalation-resolved` receipt shape — `payload.source`/`payload.issue`, escalation-
 *  reconcile.ts). Entity-LESS items (no `issue` in the payload — `ceiling-escalated`,
 *  `park-escalated`) key by kind alone: there is only ever "one" of that global condition open at
 *  a time, and no resolution witness clears them through this fold (§361's fuller reconciliation,
 *  not this issue's scope, owns that — they simply stay open, same as today). */
function openAttentionKey(kind: string, issue: unknown): string {
  return typeof issue === "number" ? `${kind}:${issue}` : kind;
}

/**
 * Durable, unbounded-by-display-window fold of currently-OPEN attention-class events (§715 gate②
 * [0]: `accumulateEventsPage`'s display cap must not be the same window an open-attention pin
 * depends on — an escalation that ages out of the bounded recent history must not silently vanish
 * from the pinned set with no resolution ever having been observed). Seeded incrementally the same
 * way `foldEntityTitles` is — call once per newly-arrived page, folding onto the previous result.
 *
 * Processes oldest-first regardless of input order. An attention-class event (`copy.ts`'s
 * `hasAttention`) OPENS its key, overwriting any earlier open event under the same key (the latest
 * instance is what's currently open — a re-escalation after an earlier one on the same issue is a
 * genuinely new episode, same doctrine the engine's own escalation-reconcile.ts uses). A later
 * `escalation-resolved` naming that same `(source, issue)` pair CLOSES it. Never mutates `seed`.
 */
export function foldOpenAttention(events: readonly LoopEvent[], seed: OpenAttention = {}): OpenAttention {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const open: OpenAttention = { ...seed };
  for (const event of ordered) {
    if (event.kind === "escalation-resolved") {
      const key = openAttentionKey(typeof event.payload.source === "string" ? event.payload.source : "", event.payload.issue);
      delete open[key];
      continue;
    }
    if (!hasAttention(event.kind, event.payload)) continue;
    open[openAttentionKey(event.kind, event.payload.issue)] = event;
  }
  return open;
}
