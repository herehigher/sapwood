import type { LoopEvent } from "./api/types.ts";

/** An entity's remembered title, keyed by ISSUE number (frontend-design.md §3 C). Every event
 *  that carries a PR number also carries that PR's issue number in the same payload (`merged`,
 *  `drive-*`, `pr-held`/`pr-released`, `fix-rounds-capped`, …) — so one issue-keyed map covers
 *  both the issue's own title (`dispatched`) and its PR's title (the PR-open transition,
 *  `merged`) without a second, PR-keyed map. */
export type EntityTitles = Record<number, { issueTitle?: string; prTitle?: string }>;

/** Folds `dispatched`'s `issueTitle` and `reclaim-done`/`merged`'s `prTitle` into a per-issue
 *  title map — "the reducer remembers each entity's title from the FIRST title-bearing event it
 *  folds" (§3 C), so later events never overwrite an already-known title. Processes events
 *  oldest-first regardless of the array's own order, since the feed renders newest-first but
 *  "first" here means chronological. Never makes a network call — an entity with no folded
 *  title-bearing event simply has no title, by design (§3 C's accepted, bounded blind spot). */
export function foldEntityTitles(events: readonly LoopEvent[]): EntityTitles {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const titles: EntityTitles = {};
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
