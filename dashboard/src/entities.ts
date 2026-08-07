import { hasAttention } from "./copy.ts";
import type { DomainEvent } from "./domain-event.ts";

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
export function foldEntityTitles(events: readonly DomainEvent[], seed: EntityTitles = {}): EntityTitles {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const titles: EntityTitles = Object.fromEntries(Object.entries(seed).map(([issue, entry]) => [issue, { ...entry }]));
  for (const event of ordered) {
    // #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null` (state.ts's
    // eventsPage), never an object — normalize once here rather than dereferencing `event.payload`
    // directly, same honest-unknown stance as the rest of this fold.
    const payload = event.payload ?? {};
    const issue = payload.issue;
    if (typeof issue !== "number") continue;
    titles[issue] ??= {};
    const entry = titles[issue]!;
    const issueTitle = payload.issueTitle;
    if (entry.issueTitle === undefined && typeof issueTitle === "string") {
      entry.issueTitle = issueTitle;
    }
    const prTitle = payload.prTitle;
    if (entry.prTitle === undefined && typeof prTitle === "string") {
      entry.prTitle = prTitle;
    }
  }
  return titles;
}

/** An open (unresolved) attention-class event, keyed for supersede/eviction tracking. */
export type OpenAttention = Record<string, DomainEvent>;

/** §3's own "clears when a later event moves that issue" list — `dispatched`, `merged`,
 *  `gated-reentry`, `lane-revived` — mirrored here (matching the engine's `escalation-clear` tag
 *  on those four kinds exactly; dashboard's own workspace doesn't import engine/src at runtime,
 *  same established pattern as `EventKind`'s own doc-table mirror). */
const ISSUE_CLEAR_KINDS = new Set(["dispatched", "merged", "gated-reentry", "lane-revived"]);

/** escalation-reconcile.ts's own `CLEAR_PRODUCES` exemption, mirrored, not re-derived: a `merged`
 *  event must never clear the `rollback-escalated` it itself produced — conductor.ts's merge path
 *  appends `rollback-escalated` (reason `"merged-board-done"`, `MERGED_BOARD_DONE_REASON`) BEFORE
 *  its own `merged` event when the post-merge Done-board write fails, so `merged`'s own arrival is
 *  not evidence the board got fixed (§3: "an operation's own effects are not evidence it was
 *  resolved"). No other kind/reason pair carries this exemption in the engine today. */
function clearedBySameOperation(clearKind: string, openEvent: DomainEvent): boolean {
  return clearKind === "merged" && openEvent.kind === "rollback-escalated" && openEvent.payload?.reason === "merged-board-done";
}

/** Entity-scoped attention items key by `${kind}:${issue}` when the payload carries a numeric
 *  `issue` (matching the engine's own `escalation-resolved` receipt shape — `payload.source`/
 *  `payload.issue`, escalation-reconcile.ts). `worktree-retained` is the one exception: §3 is
 *  explicit that its clear ("Matching for the §3 Needs-attention clear is by worktreePath — lane
 *  names are reused slots; the path is the identity") keys by `worktreePath`, not issue, even
 *  though its payload also carries one — an issue slot can be redispatched onto a DIFFERENT
 *  worktree while the original retained folder still needs a human, so keying by issue would let
 *  an unrelated later dispatch on the same issue number silently drop that human task. Every other
 *  entity-less item (no `issue` in the payload — `park-escalated`, keyed by `triggerIssue`/`source`
 *  rather than `issue`) keys by kind alone — there is only ever "one" of that global condition open
 *  at a time. */
function openAttentionKey(kind: string, payload: Record<string, unknown>): string {
  if (kind === "worktree-retained") {
    return typeof payload.worktreePath === "string" ? `worktree-retained:${payload.worktreePath}` : kind;
  }
  return typeof payload.issue === "number" ? `${kind}:${payload.issue}` : kind;
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
 * genuinely new episode, same doctrine the engine's own escalation-reconcile.ts uses).
 *
 * §3's full clearing-semantics prose, mirrored (#715 gate② round 3 [1] — round 2 covered only
 * `escalation-resolved`): a later `escalation-resolved` naming the same `(source, issue)` pair
 * closes it; `park-resumed` closes the (single, global) `park-escalated` entry; `worktree-released`
 * closes the `worktree-retained` entry sharing its `worktreePath`; and any of `dispatched`,
 * `merged`, `gated-reentry`, `lane-revived` closes EVERY open entry sharing that event's `issue`,
 * except one an operation's own effects produced (`clearedBySameOperation`). Never mutates `seed`.
 */
export function foldOpenAttention(events: readonly DomainEvent[], seed: OpenAttention = {}): OpenAttention {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const open: OpenAttention = { ...seed };
  for (const event of ordered) {
    const { kind } = event;
    // #715 gate② round 4 [4]: normalize a corrupt row's `null` payload once here, same stance as
    // `foldEntityTitles` above — every field read below assumes an object.
    const payload = event.payload ?? {};
    if (kind === "escalation-resolved") {
      const source = typeof payload.source === "string" ? payload.source : "";
      delete open[openAttentionKey(source, payload)];
      continue;
    }
    if (kind === "park-resumed") {
      delete open["park-escalated"];
      continue;
    }
    if (kind === "worktree-released") {
      if (typeof payload.worktreePath === "string") delete open[`worktree-retained:${payload.worktreePath}`];
      continue;
    }
    if (ISSUE_CLEAR_KINDS.has(kind) && typeof payload.issue === "number") {
      for (const [key, openEvent] of Object.entries(open)) {
        // worktree-retained's payload also carries `issue`, but §3 is explicit that only
        // `worktree-released` (matched by `worktreePath`, handled above) clears it — a lane slot
        // can be redispatched onto a DIFFERENT worktree while the original retained folder still
        // needs a human, so this generic issue-sweep must never touch it.
        if (openEvent.kind === "worktree-retained") continue;
        if (openEvent.payload?.issue !== payload.issue) continue;
        if (clearedBySameOperation(kind, openEvent)) continue;
        delete open[key];
      }
    }
    if (!hasAttention(kind, payload)) continue;
    open[openAttentionKey(kind, payload)] = event;
  }
  return open;
}
