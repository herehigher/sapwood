// #933: a VALUE import (not `import type`) — `kindsTagged` and the per-domain kind tables it
// walks are plain data with no node-specific side effects (see event-kinds/index.ts's own
// import list), so this is safe to bundle into the browser build; the alternative, hand-mirroring
// the tagged set here, is exactly the drift #933 exists to close (a terminal kind gains
// `escalation-clear` in the registry and this file silently doesn't hear about it).
import { kindsTagged } from "../../engine/src/state/event-kinds/index.ts";
import { hasAttention, isDissentSignal } from "./copy.ts";
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

/** §3's own "clears when a later event moves that issue" list — DERIVED from the engine's own
 *  `escalation-clear` tag (#933), not hand-mirrored: the pre-#933 version of this constant was a
 *  literal `["dispatched", "merged", "gated-reentry", "lane-revived"]` array that had to be
 *  updated BY HAND every time the engine tagged a new terminal kind `escalation-clear` — exactly
 *  the drift that let `human-merge-only-closed`/`gated-lane-retired` fall through for weeks (54
 *  zombie strip rows on the dogfood DB, #933's own measurement). Deriving it means the next
 *  terminal kind the engine tags can't fall through the same way — this set updates itself. */
export const ISSUE_CLEAR_KINDS: ReadonlySet<string> = new Set(kindsTagged("escalation-clear"));

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

/** PR #900 gate② finding [0]: a probe-less breaker (rapid-restart.ts's `escalateLocally` and its
 *  stall-breaker.ts/idle-churn.ts siblings) appends BOTH its own one-shot `*-detected` event AND a
 *  `park-escalated{source}` companion for the SAME episode, same tick — engine-side, that pair is
 *  "detection" + "the ESCALATION marker went up", not two independent problems. Without this map,
 *  both opened their own strip row, and `park-resumed{source}` only ever closed the generic
 *  `park-escalated` key, leaving the `*-detected` row stuck open forever (the finding's exact
 *  repro). Each breaker's own `ParkSource` constant is the join key (`rapid-restart.ts`'s
 *  `RAPID_RESTART_PARK_SOURCE` etc.) — `empty-spin-park` deliberately has no entry here: it has no
 *  `ParkSource` of its own (its meaning: 'enters the SAME "llm" park episode' ordinary env-failure
 *  uses), so it can't be joined by source the same way; see `openParkEscalated`'s own handling. */
const PARK_SOURCE_ATTENTION_KEY: Record<string, string> = {
  "rapid-restart": "rapid-restart-detected",
  "consecutive-stalls": "consecutive-stalls-detected",
  "idle-churn": "idle-churn-detected",
};

/** `park-escalated`'s own open-side half of the dedup above. Two cases collapse to "don't open a
 *  second row":
 *  1. `payload.source` names one of the three breakers above — their `*-detected` event (same
 *     tick, lower event id, so already folded by the time this runs) already represents the
 *     episode.
 *  2. `payload.source === "llm"` AND `empty-spin-park` is already open — empty-spin shares the
 *     single "llm" `ParkSource` row with ordinary LLM env-failure parks (no dedicated source of
 *     its own), so THIS specific episode's `park-escalated` is empty-spin's own probe-exhausted
 *     escalation, not a second, independent LLM problem. An ORDINARY llm/forge env-failure park
 *     (no empty-spin-park open) still opens its own row exactly as before — the suppression is
 *     narrow to the co-occurring case, never a blanket "llm source never opens a row" rule. */
function openParkEscalated(open: OpenAttention, event: DomainEvent, payload: Record<string, unknown>): void {
  const source = typeof payload.source === "string" ? payload.source : "";
  if (source in PARK_SOURCE_ATTENTION_KEY) return;
  if (source === "llm" && open["empty-spin-park"] !== undefined) return;
  open[openAttentionKey("park-escalated", payload)] = event;
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
 * closes it; `park-resumed` closes the (single, global) `park-escalated` entry — PLUS, PR #900
 * gate② finding [0], whichever breaker-specific row (`PARK_SOURCE_ATTENTION_KEY`) or
 * `empty-spin-park` opened for that same episode; `run-started` closes a still-open
 * `emergency-stop` (#293 has no probe/resume lifecycle of its own — a fresh boot is the signal
 * someone dealt with it); `worktree-released` closes the `worktree-retained` entry sharing its
 * `worktreePath`; and any of `dispatched`, `merged`, `gated-reentry`, `lane-revived` closes EVERY
 * open entry sharing that event's `issue`, except one an operation's own effects produced
 * (`clearedBySameOperation`). Never mutates `seed`.
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
      // PR #900 gate② finding [0]: the SAME resolution receipt that closes the generic
      // `park-escalated` row must also close whichever breaker-specific row (or empty-spin-park,
      // sharing the "llm" source) opened for this same episode — see `PARK_SOURCE_ATTENTION_KEY`
      // and `openParkEscalated`'s own doc for why both can be open for one episode pre-clear.
      const source = typeof payload.source === "string" ? payload.source : "";
      const breakerKey = PARK_SOURCE_ATTENTION_KEY[source];
      if (breakerKey !== undefined) delete open[breakerKey];
      if (source === "llm") delete open["empty-spin-park"];
      continue;
    }
    if (kind === "run-started") {
      // PR #900 gate② finding [0]: `emergency-stop` (#293) is an immediate hard stop with no
      // probe/resume lifecycle of its own — the engine successfully starting again is the natural
      // "someone dealt with it" signal, the same role `park-resumed` plays for a park episode.
      delete open["emergency-stop"];
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
    if (kind === "park-escalated") {
      openParkEscalated(open, event, payload);
      continue;
    }
    open[openAttentionKey(kind, payload)] = event;
  }
  return open;
}

/** #891: the needs-attention strip's own header summary line — "N waiting · oldest Xd · M
 *  dissent" (frontend-design.md mockup) — computed from the SAME `foldOpenAttention` result the
 *  strip already renders rows from, never a second derivation. ISO timestamps compare correctly
 *  as plain strings (same convention `foldOpenAttention`'s own ordering relies on), so the
 *  oldest item is just the lexical minimum `ts`. `oldestDays` floors — an item open for under a
 *  day reads "oldest 0d", honest rather than rounding up to a day that hasn't passed. */
export function attentionSummary(items: readonly DomainEvent[], now: Date): { waiting: number; oldestDays: number; dissent: number } {
  const oldestTs = items.reduce<string | null>((min, e) => (min === null || e.ts < min ? e.ts : min), null);
  const oldestDays = oldestTs === null ? 0 : Math.floor((now.getTime() - new Date(oldestTs).getTime()) / 86_400_000);
  return {
    waiting: items.length,
    oldestDays,
    dissent: items.filter((e) => isDissentSignal(e.kind)).length,
  };
}
