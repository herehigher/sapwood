/**
 * The hero's event fold — frontend-design.md §6.
 *
 * This is the "one state reducer" of §9: pure, id-idempotent, and free of React and
 * anime.js, so live polling and replay drive the identical scene through one code path
 * (and so the §6 transition table is testable without a DOM).
 *
 * Two outputs per fold: the new **state** (what the stage draws) and the **transitions**
 * that got it there (what anime.js animates). Keeping them apart is the honesty rule —
 * a redraw from state alone is always correct, animation is only commentary on the diff.
 */

import type { EngineState } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";

/** Where a droplet sits on the stage. The four zones of §6 plus the escalation exit. */
export type DropletAt = "backlog" | "lane" | "checkpoint" | "needs-human" | "trunk";

/** A real entity — an issue, PR-tagged once its PR exists. Only real events move it. */
export type Droplet = {
  issue: number;
  pr: number | null;
  /** The worker whose channel it rides; kept after it parks so the fix loop can return it. */
  lane: string | null;
  at: DropletAt;
  /** §5: failure carries a static ✕, never colour alone. */
  failed: boolean;
  handedOff: boolean;
  /**
   * The send-back reason word, held by the entity rather than the channel: a mid-fix
   * handoff frees the lane, and `fix-leg-resumed` must re-light the *same* state (§6).
   */
  sendBack: string | null;
  /** The event id that last actually moved this droplet (`moveDroplet`'s own id argument) —
   *  bookkeeping only; the droplet-level counterpart to `LaneView.touchedAt`. #745 gate② round 4
   *  PO ruling: no event-age/threshold inference is ever derived from this field again (the
   *  confident/uncertain pending split reads `HeroState.foldTruncated` and the engine's live
   *  lane list instead — see `isPendingConfident`). */
  touchedAt: number;
  /**
   * The compacted rank this droplet held among simultaneously-checkpointed droplets the last
   * time it arrived at `at: "checkpoint"` (`toCheckpoint`) — frozen there, never re-derived
   * once the droplet has moved on. `null` until its first checkpoint arrival.
   *
   * #745 gate② round 4 finding [0] (secondary regression): a LATER transition whose origin is
   * "checkpoint" (`ring`/`escalate`, via `transitionOrigin`) looks up where the droplet was
   * actually DRAWN by calling `dropletPoint(state, d, "checkpoint")` — but by then `d.at` is no
   * longer `"checkpoint"`, so re-deriving the rank from CURRENT checkpoint membership
   * (`state.droplets.filter(...).findIndex(...)`) can no longer find it and silently fell back
   * to rank 0, animating from the wrong point whenever the droplet's real rank was > 0. This
   * frozen value is what that origin lookup reads instead — the point the droplet was actually
   * drawn at, not wherever rank 0 happens to be now.
   */
  checkpointRank: number | null;
};

export type LanePhase = "idle" | "writing" | "driving" | "fixing" | "failed";

export type LaneView = {
  /** Stable channel identity — a slot on the stage, reused across workers. Never renumbered. */
  channel: number;
  /** Engine worker name, or null for a channel no worker has claimed yet. */
  worker: string | null;
  issue: number | null;
  phase: LanePhase;
  /** `workers.fix_rounds`; the cap comes from config, so the stage renders "n of cap". */
  fixRound: number;
  /** Send-back reason word for the fix-loop return arrow. */
  reason: string | null;
  /**
   * The event id that last changed this lane's phase/worker/issue (#716 gate② round 2
   * P1-1 + PO probe: `visibleLanes`'s tie-break for lanes sharing the same priority tier —
   * e.g. several long-`driving` (PR-out-for-review) lanes — must favor the most RECENTLY
   * touched one, not whichever happens to sit earliest in the array. A lane stuck in
   * `driving` for a long time is real, current information; array position never was.
   */
  touchedAt: number;
};

export type HeroState = {
  /** One entry per channel, in draw order. `null` lanesMax draws a single placeholder. */
  lanes: LaneView[];
  droplets: Droplet[];
  /** This round's selection pool from `pool-selected` (§6 zone 1). */
  pool: number[];
  rings: number;
  /**
   * #716 gate② round 2 P1-2: the set of currently-breached ceiling reasons (e.g.
   * `dailyBudgetUsd`, `wallClockSec`) — engine semantics are per-reason entered/cleared
   * PAIRS (`ceiling-breach-entered`/`ceiling-breach-cleared`, each carrying its own
   * `reason`), never one shared boolean. Daily-budget clearing at midnight while
   * wall-clock stays breached must keep the stage dimmed — a single boolean can't
   * represent that. Dimmed = this set is non-empty (`isStageDimmed`).
   */
  openCeilingReasons: ReadonlySet<string>;
  /** `lanes.max` was unreadable — the stage says so rather than guessing a lane count. */
  laneCountUnknown: boolean;
  lastId: number;
  /** ISO timestamp of the last folded event, whatever its kind — the OUTCOME zone's staleness
   *  caption (#716 gate② P2-8) reads "how long since anything happened", not phase-scoped. */
  lastEventTs: string | null;
  /** `pool-selected`/`round-phase`'s `round_id` — the boundary `roundMerged` resets on
   *  (#716 gate② P2-8's round outcome tally: "never repeating the all-time ring count"). */
  roundId: number | null;
  /** `merged` events folded since `roundId` last changed — the tally's "N merged", distinct
   *  from `rings` (the all-time trunk count). */
  roundMerged: number;
  /**
   * Whether the events this fold has actually been given are known to be an incomplete slice
   * of the full history — set by the caller (`queries.ts`'s `withFoldTruncated`, live catch-up:
   * a poll page landing at the full `EVENTS_PAGE` size means more history remains unfetched),
   * never inferred by this module from event age or distance. `foldEvents` only ever carries
   * this flag through unchanged — no event kind sets or clears it.
   *
   * #745 gate② round 4 PO ruling: the honest-label arm. A droplet this fold cannot otherwise
   * vouch for (see `isPendingConfident`) is rendered under an explicit windowed/uncertain
   * qualifier ONLY while this is true; once the caller reports the fold caught up, the plain
   * unqualified tally resumes — never a silent deletion, never an age-derived guess either way.
   */
  foldTruncated: boolean;
};

/** One row of the §6 transition table. `id` is the event id, so keys are stable. */
export type Transition =
  | { kind: "dispatch"; id: number; issue: number; lane: string }
  | { kind: "to-checkpoint"; id: number; issue: number; lane: string; pr: number | null }
  | { kind: "fix-return"; id: number; issue: number; lane: string; pr: number | null; reason: string; round: number }
  /**
   * #716 gate② P2-6: production writes `fix-leg-started` BEFORE `drive-fixup` — the real
   * send-back reason routinely names its lane only after the droplet has already returned
   * there wearing the generic "review findings" fallback. No travel (`transitionOrigin` is
   * `null`): the droplet is already in its lane, only the label was wrong.
   */
  | { kind: "fix-reason"; id: number; issue: number; lane: string; reason: string }
  | { kind: "escalate"; id: number; issue: number; pr: number | null }
  | { kind: "ring"; id: number; issue: number; pr: number | null; ring: number }
  | { kind: "handoff"; id: number; issue: number; lane: string | null }
  | { kind: "fail"; id: number; issue: number; lane: string | null }
  | { kind: "dim"; id: number };

export type PlannedTransition = Transition & { animate: boolean };

/** §6: the stage dims for the safety tiers as well as for a ceiling breach. */
const DIMMING_ENGINE_STATES: ReadonlySet<EngineState> = new Set<EngineState>(["paused", "winding-down", "stopping", "stopped"]);

export const isStageDimmed = (state: HeroState, engine: EngineState): boolean =>
  state.openCeilingReasons.size > 0 || DIMMING_ENGINE_STATES.has(engine);

export function initialHeroState(lanesMax: number | null): HeroState {
  const channels = lanesMax ?? 1;
  return {
    lanes: Array.from({ length: Math.max(1, channels) }, (_, channel) => ({
      channel,
      worker: null,
      issue: null,
      phase: "idle" as const,
      fixRound: 0,
      reason: null,
      touchedAt: 0,
    })),
    droplets: [],
    pool: [],
    rings: 0,
    openCeilingReasons: new Set(),
    laneCountUnknown: lanesMax === null,
    lastId: 0,
    lastEventTs: null,
    roundId: null,
    roundMerged: 0,
    foldTruncated: false,
  };
}

/**
 * Mark whether this fold's input is currently known to be an incomplete slice of the full
 * event history — the caller's own knowledge (e.g. a live catch-up page landing at the full
 * page size), never derived here. Same no-op-if-unchanged shape as `withLaneCount`/
 * `withLanePrs`, so a poll that reports the SAME truncation state as last time doesn't churn
 * `hero`'s object identity (`accumulateEventsPage`'s referential-stability contract).
 */
export function withFoldTruncated(state: HeroState, truncated: boolean): HeroState {
  if (state.foldTruncated === truncated) return state;
  return { ...state, foldTruncated: truncated };
}

/**
 * Re-fit the stage to `lanes.max`.
 *
 * The config lands one poll after the first paint (and can change under a running engine),
 * so the channel count has to grow without throwing away the rings and droplets already
 * folded. Channels are only ever added: a lane that carried work stays drawn.
 */
export function withLaneCount(state: HeroState, lanesMax: number | null): HeroState {
  const want = Math.max(1, lanesMax ?? 1);
  const unknown = lanesMax === null;
  if (state.lanes.length >= want && state.laneCountUnknown === unknown) return state;

  const lanes = [...state.lanes];
  while (lanes.length < want)
    lanes.push({ channel: lanes.length, worker: null, issue: null, phase: "idle", fixRound: 0, reason: null, touchedAt: 0 });
  return { ...state, lanes, laneCountUnknown: unknown };
}

/**
 * Priority tier for a `visibleLanes` cut — LOWER survives first. Genuinely active work
 * (writing/driving/fixing) always wins a slot; a permanently `failed` channel (never
 * revisited — see `moveDroplet`'s doc) is real information but stale, so it ranks below
 * live work and above a plain idle placeholder, which carries nothing at all.
 */
const LANE_PRIORITY: Record<LanePhase, number> = { writing: 0, driving: 0, fixing: 0, failed: 1, idle: 2 };

/**
 * The lanes actually worth drawing as tracks — capped at the CONFIGURED slot count
 * (`lanes.max`, the same source `LaneBoard` renders against) rather than `state.lanes.length`,
 * which only ever grows.
 *
 * #716 gate② P1-9 (PO live probe): a lane whose worker never returns (a permanently failed,
 * never-revisited channel) or whose engine-minted worker name the fold has simply never seen
 * before both leave a stale/extra entry behind forever; against a live DB with real history
 * behind it, that folded into 39 "Work lane N" tracks squeezed into the fixed-width stage.
 * This is a READ VIEW only — `state.lanes` itself (and lane assignment in `apply`) is
 * untouched, so the fold stays the honest source of truth; only what gets DRAWN is capped.
 *
 * #716 gate② round 2 P1-1 + PO probe: a plain stable sort by `LANE_PRIORITY` alone still
 * picks WRONG under real load — several lanes can share the same tier (e.g. multiple PRs
 * sitting `driving`/out-for-review at once), and stable-sort ties resolve to array/creation
 * order, i.e. OLDEST first — the live probe measured exactly this: three long-stale
 * `driving` lanes drawn while the one genuinely active (`writing`) lane was cut. `touchedAt`
 * (the event id that last changed a lane) breaks ties by RECENCY instead, so live work wins
 * over old, forgotten channels of the same nominal phase. Survivors are renumbered 0..n-1 for
 * display (the `channel` used to pick a stage row and the `w{n+1}` label, §6/baseline).
 */
export function visibleLanes(lanes: readonly LaneView[], lanesMax: number | null): LaneView[] {
  const want = Math.max(1, lanesMax ?? lanes.length);
  const ordered =
    lanes.length <= want ? lanes : [...lanes].sort((a, b) => LANE_PRIORITY[a.phase] - LANE_PRIORITY[b.phase] || b.touchedAt - a.touchedAt);
  return ordered.slice(0, want).map((l, i) => ({ ...l, channel: i }));
}

/**
 * `state` with `.lanes` replaced by its capped, renumbered `visibleLanes` view AND
 * `.droplets` filtered to match — the form every position/render computation
 * (`dropletPoint`, `HeroStage`'s lane loop, `playback.ts`) must use.
 *
 * #716 gate② round 2 P1-1 + PO probe: capping `.lanes` alone was not enough — `dropletPoint`'s
 * `laneIndex` falls back to channel 0 for a droplet whose lane got cut (`.find` returns
 * `undefined`, `?? 0`), and `HeroStage`'s droplet loop draws EVERY `state.droplets` entry
 * regardless — together, every droplet riding an omitted lane piled onto channel 0's track,
 * overlapping tags/✕ marks with whatever real lane draws there. A droplet whose lane was cut
 * must be DROPPED from the scene, never remapped: only `at === "lane"` droplets depend on a
 * channel at all (backlog/checkpoint/needs-human/trunk position independently of any lane).
 */
export function withVisibleLanes(state: HeroState, lanesMax: number | null): HeroState {
  const lanes = visibleLanes(state.lanes, lanesMax);
  const visibleWorkers = new Set(lanes.map((l) => l.worker).filter((w): w is string => w !== null));
  const droplets = state.droplets.filter((d) => d.at !== "lane" || (d.lane !== null && visibleWorkers.has(d.lane)));
  return { ...state, lanes, droplets };
}

/**
 * The zone a transition travels **from** — its semantic source.
 *
 * A droplet seen for the first time has no previously-rendered position, so the animation
 * layer has nothing to travel from: it would animate a point to itself and the very first
 * `dispatched` would simply appear in the lane, no journey. Each transition therefore names
 * its own origin, which is what the timeline starts at when there is no rendered history.
 * `null` means the transition moves nothing (failures are still; `dim` is not a droplet).
 */
export function transitionOrigin(t: Transition): DropletAt | null {
  switch (t.kind) {
    case "dispatch":
      return "backlog";
    case "to-checkpoint":
    case "handoff":
      return "lane";
    case "fix-return":
    case "escalate":
    case "ring":
      return "checkpoint";
    case "fail":
    case "dim":
    case "fix-reason":
      return null;
  }
}

/**
 * Apply the live lane rows' PR numbers to the droplets riding those lanes.
 *
 * §6 wants the droplet to emerge from its lane "carrying a PR tag", but no *event* holds the
 * number at that moment — `reclaim-done` is `{worker, issue, next}` and the engine keeps the
 * PR on the worker row. `/api/loop/state`'s lane rows do carry it, and §6 already names
 * `/state` as the live overlay for exactly this transition, so the tag is applied at render
 * time. The fold stays pure and replay-honest: in replay there is no overlay and the tag
 * arrives with the first later event that carries a `pr` (every drive event does).
 *
 * Never overwrites a number the events already established — an event is better evidence
 * than a lane row that may already have moved on.
 */
export function withLanePrs(state: HeroState, lanes: readonly { lane: string; pr: number | null }[]): HeroState {
  const prs = new Map(lanes.filter((l) => l.pr !== null).map((l) => [l.lane, l.pr as number]));
  if (prs.size === 0) return state;

  let changed = false;
  const droplets = state.droplets.map((d) => {
    const pr = d.lane === null ? undefined : prs.get(d.lane);
    if (pr === undefined || d.pr !== null) return d;
    changed = true;
    return { ...d, pr };
  });

  return changed ? { ...state, droplets } : state;
}

/**
 * §6/§7: the arrow's label is one of three words. The engine's `drive-fixup.reason` is a
 * gate string (`gate:FIXABLE:merge-conflict`, `gate:FIXABLE:<verdict>:…:ciRed=true`), never
 * prose — so map it, and when it says nothing specific, say the mildest true thing rather
 * than guessing a cause.
 *
 * ponytail: lives here until copy.ts (§7) lands, then it moves there with the rest of the map.
 */
export function sendBackReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw : "";
  if (reason.includes("merge-conflict")) return "merge conflict";
  if (reason.includes("ciRed=true")) return "checks failed";
  return "review findings";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Failure kinds that stop a droplet where it stands (§6 last-but-one row). */
const FAILURE_KINDS = new Set(["reclaim-failed", "reclaim-dead", "rollback-escalated"]);

/** The three kinds that cross onto the rust escalation branch (§6). */
const ESCALATION_KINDS = new Set(["fix-rounds-capped", "fix-leg-verdict-rerun", "drive-needs-human"]);

/**
 * …but two of the failure kinds are also the engine's *recovery* paths.
 *
 * A clean-but-failed lane holding a PR is rescued to `driving` and emits `reclaim-failed`
 * with `next: "DRIVING"`; a dead lane holding a PR emits `reclaim-dead` with
 * `rescued: true` (that payload has no `next` field at all, so the two need different
 * tests). Both mean the PR is alive and heading for review — rendering them as failures
 * would leave a ✕ on work that is still moving.
 */
const isRescue = (kind: string, p: Record<string, unknown>): boolean =>
  (kind === "reclaim-failed" && String(p.next ?? "").toUpperCase() === "DRIVING") || (kind === "reclaim-dead" && p.rescued === true);

type Draft = {
  lanes: LaneView[];
  droplets: Map<number, Droplet>;
  pool: number[];
  rings: number;
  openCeilingReasons: Set<string>;
  lastEventTs: string | null;
  roundId: number | null;
  roundMerged: number;
};

/** Either round-boundary event's `round_id` field (engine payload, snake_case verbatim —
 *  `pool-selected`/`round-phase` in `engine/src/loop/align.ts`/`round.ts`). */
const roundIdOf = (p: Record<string, unknown>): number | null => num(p.round_id);

/**
 * Find (or open) the channel a worker owns. A worker beyond `lanes.max` gets an extra
 * channel rather than being dropped: the config can change under a running engine, and a
 * lane the hero can't draw is a lane the operator can't see.
 */
function claimLane(draft: Draft, worker: string): LaneView {
  const own = draft.lanes.find((l) => l.worker === worker);
  if (own) return own;
  const free = draft.lanes.find((l) => l.worker === null || l.phase === "idle");
  if (free) {
    free.worker = worker;
    return free;
  }
  const extra: LaneView = { channel: draft.lanes.length, worker, issue: null, phase: "idle", fixRound: 0, reason: null, touchedAt: 0 };
  draft.lanes.push(extra);
  return extra;
}

const laneOf = (draft: Draft, worker: string | null): LaneView | undefined =>
  worker === null ? undefined : draft.lanes.find((l) => l.worker === worker);

function releaseLane(lane: LaneView | undefined): void {
  if (!lane) return;
  lane.worker = null;
  lane.issue = null;
  lane.phase = "idle";
  lane.fixRound = 0;
  lane.reason = null;
}

/**
 * The lane → checkpoint transition, shared by `reclaim-done`'s DRIVING branch and by the two
 * rescue paths that reach the same place from a failure kind.
 *
 * The PR number is deliberately not required: `reclaim-done`'s payload is `{worker, issue,
 * next}` — the engine stores the PR on the worker row, not in the event — so the tag comes
 * from the live lane overlay (`withLanePrs`) or from the first later event that carries one.
 */
function toCheckpoint(draft: Draft, id: number, issue: number, worker: string | null, pr: number | null): Transition {
  const lane = laneOf(draft, worker);
  if (lane) {
    lane.phase = "driving";
    lane.touchedAt = id;
  }
  const d = moveDroplet(draft, issue, id, { at: "checkpoint", ...(pr !== null ? { pr } : {}) });
  // Freeze THIS arrival's compacted rank onto the droplet — `dropletPoint`'s own checkpoint
  // rank derivation, replicated here right after the droplet is added, so a later transition
  // whose origin is "checkpoint" can read where this droplet was actually drawn even once it's
  // no longer AT checkpoint (`Droplet.checkpointRank`'s own doc; #745 gate② round 4 finding [0]
  // secondary regression).
  const checkpointDroplets = [...draft.droplets.values()].filter((o) => o.at === "checkpoint");
  const rank = Math.max(
    0,
    checkpointDroplets.findIndex((o) => o.issue === issue),
  );
  draft.droplets.set(issue, { ...d, checkpointRank: rank });
  return { kind: "to-checkpoint", id, issue, lane: worker ?? "", pr: d.pr };
}

/**
 * Patch a droplet.
 *
 * Any move clears `failed` unless the patch re-asserts it: the ✕ marks the state a droplet is
 * *in*, not a scar it carries. A lane that failed, was re-dispatched and merged must not keep
 * rendering ✕ beside a merged PR. `id` (the event doing the moving) always stamps `touchedAt` —
 * bookkeeping only (`Droplet.touchedAt`'s own doc).
 */
function moveDroplet(draft: Draft, issue: number, id: number, patch: Partial<Droplet>): Droplet {
  const current = draft.droplets.get(issue) ?? {
    issue,
    pr: null,
    lane: null,
    at: "backlog" as const,
    failed: false,
    handedOff: false,
    sendBack: null,
    touchedAt: id,
    checkpointRank: null,
  };
  const next = { ...current, failed: false, ...patch, touchedAt: id };
  draft.droplets.set(issue, next);

  // The lane's ✕ is the same mark on the other end of the wire: a channel still pinned to an
  // issue that has since moved on would keep showing a failure for work that recovered.
  if (!next.failed) {
    for (const lane of draft.lanes) if (lane.phase === "failed" && lane.issue === issue) releaseLane(lane);
  }
  return next;
}

/** One event → at most one transition. Anything not in the §6 table animates nothing. */
function apply(draft: Draft, e: DomainEvent): Transition | null {
  const id = e.id;
  // `domain-event.ts`'s parse boundary: a stored row whose payload wasn't parseable JSON is
  // served as `null`, never assumed to be an object (#715 gate② round 4 [4]) — fold that into
  // the empty-payload case the field readers below already treat as "nothing named".
  const p = e.payload ?? {};
  const worker = str(p.worker);
  const issue = num(p.issue);
  const pr = num(p.pr);

  // #716 gate② P2-8: the OUTCOME zone's staleness caption reads "how long since anything
  // happened" — every fresh event, whatever its kind, updates the clock.
  draft.lastEventTs = e.ts;

  // #716 gate② P2-8: `pool-selected` and `round-phase` both carry the engine's `round_id`
  // (`engine/src/loop/align.ts`/`round.ts`) — whichever names a NEW one resets the round's
  // outcome tally so `roundMerged` never becomes the all-time `rings` count in disguise.
  const roundId = roundIdOf(p);
  if (roundId !== null && roundId !== draft.roundId) {
    draft.roundId = roundId;
    draft.roundMerged = 0;
  }

  // Any event naming both an issue and a PR teaches that droplet its number, whether or not
  // the kind moves anything. This is how the tag arrives in replay, where no live lane
  // overlay exists and `reclaim-done` itself carries no PR: the next drive event supplies it.
  // Deliberately not via moveDroplet — learning a number is not motion and must not clear ✕.
  const known = issue === null ? undefined : draft.droplets.get(issue);
  if (known && pr !== null && known.pr === null) draft.droplets.set(known.issue, { ...known, pr });

  switch (e.kind) {
    case "pool-selected": {
      const issues = Array.isArray(p.issues) ? p.issues.filter((i): i is number => typeof i === "number") : [];
      draft.pool = [...new Set(issues)];
      return null;
    }

    case "round-phase":
      // The round-boundary bookkeeping above already handled this; §6 gives this kind no
      // stage animation of its own (the live `round.phase` overlay drives the planning/
      // reflection nodes, not the event fold — see `activePlanningNode`/`activeReflectionNode`).
      return null;

    case "dispatched": {
      if (issue === null || worker === null) return null;
      const lane = claimLane(draft, worker);
      lane.issue = issue;
      lane.phase = "writing";
      lane.fixRound = 0;
      lane.reason = null;
      lane.touchedAt = id;
      moveDroplet(draft, issue, id, { lane: worker, at: "lane", failed: false, handedOff: false });
      draft.pool = draft.pool.filter((i) => i !== issue);
      return { kind: "dispatch", id, issue, lane: worker };
    }

    case "reclaim-done": {
      if (issue === null || worker === null) return null;
      // §6's canonical PR-open transition. `next` is uppercase in the engine's payload.
      if (String(p.next ?? "").toUpperCase() !== "DRIVING") {
        // No PR: the lane is simply finished. §6 has no row for it — the Needs-attention
        // strip (§3) narrates it — so the hero clears it silently instead of inventing motion.
        releaseLane(laneOf(draft, worker));
        draft.droplets.delete(issue);
        return null;
      }
      return toCheckpoint(draft, id, issue, worker, pr);
    }

    case "drive-fixup": {
      // Half of a pair, in the ASSUMED order: the send-back is recorded now, the return
      // animates when the fix leg actually starts. Animating here would show the droplet
      // moving before the engine moved it.
      //
      // #716 gate② P2-6: production writes the OPPOSITE order — `fix-leg-started` durably
      // lands BEFORE `drive-fixup`, so by the time this fires the droplet is routinely
      // already back in its lane wearing `fix-leg-started`'s generic "review findings"
      // fallback (neither event's own payload can see the other's field). When that's
      // already happened (the lane is mid-fix on THIS issue), correct the label in place
      // instead of leaving the wrong reason lit for the rest of the fix round.
      if (issue === null) return null;
      const reason = sendBackReason(p.reason);
      const lane = laneOf(draft, worker);
      const alreadyFixing = lane?.phase === "fixing" && lane.issue === issue;
      if (lane) lane.reason = reason;
      moveDroplet(draft, issue, id, { sendBack: reason, ...(pr !== null ? { pr } : {}) });
      if (alreadyFixing && worker) return { kind: "fix-reason", id, issue, lane: worker, reason };
      return null;
    }

    case "fix-leg-started":
    case "fix-leg-resumed": {
      if (issue === null || worker === null) return null;
      const lane = claimLane(draft, worker);
      const round = num(p.fixRounds) ?? lane.fixRound + 1;
      const reason = draft.droplets.get(issue)?.sendBack ?? sendBackReason(p.reason);
      lane.issue = issue;
      lane.phase = "fixing";
      lane.fixRound = round;
      lane.reason = reason;
      lane.touchedAt = id;
      const d = moveDroplet(draft, issue, id, {
        lane: worker,
        at: "lane",
        handedOff: false,
        sendBack: reason,
        ...(pr !== null ? { pr } : {}),
      });
      return { kind: "fix-return", id, issue, lane: worker, pr: d.pr, reason, round };
    }

    case "merged": {
      if (issue === null) return null;
      releaseLane(laneOf(draft, worker));
      draft.rings += 1;
      draft.roundMerged += 1;
      // Only the newest merge keeps its tag on the trunk — older ones *are* the rings now.
      for (const [key, d] of draft.droplets) if (d.at === "trunk") draft.droplets.delete(key);
      const d = moveDroplet(draft, issue, id, { at: "trunk", ...(pr !== null ? { pr } : {}) });
      return { kind: "ring", id, issue, pr: d.pr, ring: draft.rings };
    }

    case "handoff": {
      if (issue === null) return null;
      releaseLane(laneOf(draft, worker));
      moveDroplet(draft, issue, id, { at: "backlog", handedOff: true });
      return { kind: "handoff", id, issue, lane: worker };
    }

    // #716 gate② round 2 P1-2: engine semantics are per-reason entered/cleared PAIRS
    // (`engine/src/state/event-kinds/run.ts`) — a daily-budget breach clearing at midnight
    // while a wall-clock breach is still open must NOT undim the stage. `ceiling-escalated`
    // (a lane got drained) carries the reasons that caused it, so it ALSO adds them —
    // defensive against a `ceiling-breach-entered` that fell outside a bounded event window
    // — but the canonical add/remove pair is `ceiling-breach-entered`/`-cleared`, each
    // scoped to its own `reason`. §6 gives none of these three an animation of their own; the
    // stage's dim state is a per-render read of `openCeilingReasons`, not a narrated moment.
    case "ceiling-breach-entered": {
      const reason = str(p.reason);
      if (reason) draft.openCeilingReasons.add(reason);
      return null;
    }

    case "ceiling-breach-cleared": {
      const reason = str(p.reason);
      if (reason) draft.openCeilingReasons.delete(reason);
      return null;
    }

    case "ceiling-escalated": {
      const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r): r is string => typeof r === "string") : [];
      for (const r of reasons) draft.openCeilingReasons.add(r);
      return { kind: "dim", id };
    }

    // A fresh boot carries no breach state forward at all — the hard reset that makes
    // "stale history" impossible regardless of how far back the dashboard's `id 0` fold goes.
    case "run-started": {
      draft.openCeilingReasons.clear();
      return null;
    }

    default: {
      if (ESCALATION_KINDS.has(e.kind)) {
        if (issue === null) return null;
        releaseLane(laneOf(draft, worker));
        const d = moveDroplet(draft, issue, id, { at: "needs-human", ...(pr !== null ? { pr } : {}) });
        return { kind: "escalate", id, issue, pr: d.pr };
      }

      if (!FAILURE_KINDS.has(e.kind) || issue === null) return null;
      // The engine's own recovery paths ride two of these kinds — they end at `driving`, so
      // they are the PR-open transition, not a failure.
      if (isRescue(e.kind, p)) return toCheckpoint(draft, id, issue, worker, pr);
      const lane = laneOf(draft, worker);
      if (lane) {
        lane.phase = "failed";
        lane.touchedAt = id;
      }
      moveDroplet(draft, issue, id, { failed: true });
      return { kind: "fail", id, issue, lane: worker };
    }
  }
}

/**
 * #745 gate② round 2 finding [1] / round 3 finding [1] / round 4 PO ruling (design re-entry):
 * event-age is NOT an authoritative terminal-state signal — the LIVE hero fold
 * (`accumulateEventsPage`/`foldReplay`) accumulates every ascending page DURABLY, so a droplet
 * that's gone many event ids without its own next event is exactly as often a genuinely still-
 * open PR sitting quiet while OTHER lanes stay busy. Two successive age-threshold attempts at
 * this problem both failed for that reason: the first silently DELETED a droplet past its
 * threshold (traded a false "pending" for a worse false "vanished, uncounted"); the second kept
 * it drawn but was inert at the reported scale (borrowed constant compared against the wrong
 * quantity) and wrongly flagged fold-vouched `backlog`/handoff droplets stale too. Doctrine 4
 * (`docs/REVIEW-DOCTRINE.md`): after that many rounds tuning the SAME threshold, the fix is
 * design re-entry, not another number — the PO's ruling deletes threshold inference entirely.
 *
 * `isPendingConfident` decides the split from two authoritative FACTS only, never event
 * distance:
 *
 *   1. A `backlog` droplet is state the fold knows EXACTLY — it only ever reaches `backlog` via
 *      `handoff` ("saved for a successor"), and nothing else moves it. Always confident,
 *      regardless of `foldTruncated` (round 4 finding [1]: this is the specific regression the
 *      age heuristic introduced).
 *   2. A droplet the engine's own live lane list (`/api/loop/state`'s `lanes.items[]`, matched
 *      by issue — the same rows `withLanePrs` already consumes for the PR tag) still names is
 *      confident: the engine itself has not moved on from that issue's work RIGHT NOW,
 *      independent of whatever this fold's own event history has or hasn't caught up to.
 *
 * Everything else stays confident too, UNLESS the caller reports this fold's input as currently
 * truncated (`HeroState.foldTruncated`) — a droplet's mere silence in a COMPLETE fold's own
 * knowledge was never honestly in doubt; only a KNOWN-incomplete fold has reason to qualify it.
 * `stage.tsx` reads the result to keep every pending droplet drawn regardless, moving only the
 * unconfident ones out of the headline "N pending" figure and into an explicitly windowed/
 * uncertain qualifier — never a silent deletion, never a silently smaller or wrong number.
 */
export function isPendingConfident(d: Droplet, foldTruncated: boolean, liveIssues: ReadonlySet<number>): boolean {
  if (d.at === "backlog") return true;
  if (liveIssues.has(d.issue)) return true;
  return !foldTruncated;
}

/** Freeze a `Draft` in progress into a real, independent `HeroState` snapshot — used both for
 *  the final fold result and, per event, for `FoldStep.state` below (#716 gate② P1-1).
 *  `foldTruncated` is carried through verbatim from the INPUT state, same as `laneCountUnknown`
 *  — no event kind this fold applies ever sets or clears it (`HeroState.foldTruncated`'s doc). */
function snapshotDraft(draft: Draft, laneCountUnknown: boolean, foldTruncated: boolean, lastId: number): HeroState {
  return {
    lanes: draft.lanes.map((l) => ({ ...l })),
    droplets: [...draft.droplets.values()],
    pool: [...draft.pool],
    rings: draft.rings,
    openCeilingReasons: new Set(draft.openCeilingReasons),
    laneCountUnknown,
    lastId,
    lastEventTs: draft.lastEventTs,
    roundId: draft.roundId,
    roundMerged: draft.roundMerged,
    foldTruncated,
  };
}

/**
 * One folded event that produced a transition, paired with the stage state exactly as it
 * stood right after that single event — i.e. this step's own intermediate scene, not the
 * batch's final one.
 *
 * #716 gate② P1-1: the animation layer used to animate every transition in a poll's batch
 * against the SAME (final) `dropletPoint` — a batch containing `dispatched` then
 * `reclaim-done` for the same issue animated the `dispatched` leg straight to the checkpoint
 * (reclaim-done's destination, since that's where the FINAL state has the droplet), skipping
 * the backlog→lane beat entirely, while two timelines wrote conflicting transforms onto the
 * same element. `steps` gives the animation layer (`hero/playback.ts`) each transition's own
 * before/after scene to compute correct, sequenced endpoints from.
 */
export type FoldStep = { transition: Transition; state: HeroState };

/**
 * Fold a page of events onto the stage state.
 *
 * Events at or below `lastId` are skipped: the feed poll deliberately re-fetches an
 * overlapping tail (`queries.ts` holds `after` steady), so without this every poll would
 * re-count every merge.
 */
export function foldEvents(state: HeroState, events: DomainEvent[]): { state: HeroState; transitions: Transition[]; steps: FoldStep[] } {
  const fresh = events.filter((e) => e.id > state.lastId).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) return { state, transitions: [], steps: [] };

  const draft: Draft = {
    lanes: state.lanes.map((l) => ({ ...l })),
    droplets: new Map(state.droplets.map((d) => [d.issue, { ...d }])),
    pool: [...state.pool],
    rings: state.rings,
    openCeilingReasons: new Set(state.openCeilingReasons),
    lastEventTs: state.lastEventTs,
    roundId: state.roundId,
    roundMerged: state.roundMerged,
  };

  const transitions: Transition[] = [];
  const steps: FoldStep[] = [];
  let lastId = state.lastId;
  for (const e of fresh) {
    const t = apply(draft, e);
    lastId = e.id;
    if (t) {
      transitions.push(t);
      steps.push({ transition: t, state: snapshotDraft(draft, state.laneCountUnknown, state.foldTruncated, lastId) });
    }
  }

  return {
    state: snapshotDraft(draft, state.laneCountUnknown, state.foldTruncated, lastId),
    transitions,
    steps,
  };
}

/** §6 coalescing policy: more than this many pending transitions and the batch collapses. */
export const COALESCE_AFTER = 2;
/** …as does any replay running at this speed or faster. */
export const COALESCE_SPEED = 4;

/**
 * Decide what actually animates (§6 "bursts must not queue").
 *
 * A collapsed batch swaps state instantly and animates **only the newest ring** — the one
 * celebratory moment survives; everything else is a jump cut. The hero must never lag the
 * state it claims to show, so this budget is a hard rule, not a hint.
 */
export function planTransitions(
  transitions: Transition[],
  { reducedMotion = false, speed = 1 }: { reducedMotion?: boolean; speed?: number } = {},
): PlannedTransition[] {
  if (reducedMotion) return transitions.map((t) => ({ ...t, animate: false }));
  if (transitions.length <= COALESCE_AFTER && speed < COALESCE_SPEED) return transitions.map((t) => ({ ...t, animate: true }));

  const newestRing = transitions.reduce((acc, t, i) => (t.kind === "ring" ? i : acc), -1);
  return transitions.map((t, i) => ({ ...t, animate: i === newestRing }));
}

/** §6 zone 2: which planning/reflection node lights for a given live round phase. */
export type PlanningNode = "goal-align" | "arch-review" | "verify";
export type ReflectionNode = "summary" | "retro";

const PLANNING_PHASE: Record<string, PlanningNode> = { aligning: "goal-align", architecting: "arch-review", plan_review: "verify" };
const REFLECTION_PHASE: Record<string, ReflectionNode> = { harvesting: "summary", retro: "retro" };

/** `round.phase` from `/api/loop/state` (live overlay — §6/§11: not persisted per-event yet beyond `round-phase`). */
export const activePlanningNode = (phase: string | null | undefined): PlanningNode | null =>
  phase ? (PLANNING_PHASE[phase] ?? null) : null;
export const activeReflectionNode = (phase: string | null | undefined): ReflectionNode | null =>
  phase ? (REFLECTION_PHASE[phase] ?? null) : null;
