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

import type { EngineState, LoopEvent } from "../api/types.ts";

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
};

export type HeroState = {
  /** One entry per channel, in draw order. `null` lanesMax draws a single placeholder. */
  lanes: LaneView[];
  droplets: Droplet[];
  /** This round's selection pool from `pool-selected` (§6 zone 1). */
  pool: number[];
  rings: number;
  /** Latched by `ceiling-escalated`; PAUSE / kill switch dim via the engine state instead. */
  ceilingReached: boolean;
  /** `lanes.max` was unreadable — the stage says so rather than guessing a lane count. */
  laneCountUnknown: boolean;
  lastId: number;
};

/** One row of the §6 transition table. `id` is the event id, so keys are stable. */
export type Transition =
  | { kind: "dispatch"; id: number; issue: number; lane: string }
  | { kind: "to-checkpoint"; id: number; issue: number; lane: string; pr: number | null }
  | { kind: "fix-return"; id: number; issue: number; lane: string; pr: number | null; reason: string; round: number }
  | { kind: "escalate"; id: number; issue: number; pr: number | null }
  | { kind: "ring"; id: number; issue: number; pr: number | null; ring: number }
  | { kind: "handoff"; id: number; issue: number; lane: string | null }
  | { kind: "fail"; id: number; issue: number; lane: string | null }
  | { kind: "dim"; id: number };

export type PlannedTransition = Transition & { animate: boolean };

/** §6: the stage dims for the safety tiers as well as for a ceiling breach. */
const DIMMING_ENGINE_STATES: ReadonlySet<EngineState> = new Set<EngineState>(["paused", "winding-down", "stopping", "stopped"]);

export const isStageDimmed = (state: HeroState, engine: EngineState): boolean => state.ceilingReached || DIMMING_ENGINE_STATES.has(engine);

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
    })),
    droplets: [],
    pool: [],
    rings: 0,
    ceilingReached: false,
    laneCountUnknown: lanesMax === null,
    lastId: 0,
  };
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
  while (lanes.length < want) lanes.push({ channel: lanes.length, worker: null, issue: null, phase: "idle", fixRound: 0, reason: null });
  return { ...state, lanes, laneCountUnknown: unknown };
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

type Draft = {
  lanes: LaneView[];
  droplets: Map<number, Droplet>;
  pool: number[];
  rings: number;
  ceilingReached: boolean;
};

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
  const extra: LaneView = { channel: draft.lanes.length, worker, issue: null, phase: "idle", fixRound: 0, reason: null };
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

function moveDroplet(draft: Draft, issue: number, patch: Partial<Droplet>): Droplet {
  const current = draft.droplets.get(issue) ?? {
    issue,
    pr: null,
    lane: null,
    at: "backlog" as const,
    failed: false,
    handedOff: false,
    sendBack: null,
  };
  const next = { ...current, ...patch };
  draft.droplets.set(issue, next);
  return next;
}

/** One event → at most one transition. Anything not in the §6 table animates nothing. */
function apply(draft: Draft, e: LoopEvent): Transition | null {
  const id = e.id;
  const p = e.payload;
  const worker = str(p.worker);
  const issue = num(p.issue);
  const pr = num(p.pr);

  switch (e.kind) {
    case "pool-selected": {
      const issues = Array.isArray(p.issues) ? p.issues.filter((i): i is number => typeof i === "number") : [];
      draft.pool = [...new Set(issues)];
      return null;
    }

    case "dispatched": {
      if (issue === null || worker === null) return null;
      const lane = claimLane(draft, worker);
      lane.issue = issue;
      lane.phase = "writing";
      lane.fixRound = 0;
      lane.reason = null;
      moveDroplet(draft, issue, { lane: worker, at: "lane", failed: false, handedOff: false });
      draft.pool = draft.pool.filter((i) => i !== issue);
      return { kind: "dispatch", id, issue, lane: worker };
    }

    case "reclaim-done": {
      if (issue === null || worker === null) return null;
      const lane = laneOf(draft, worker);
      // §6's canonical PR-open transition. `next` is uppercase in the engine's payload.
      if (String(p.next ?? "").toUpperCase() !== "DRIVING") {
        // No PR: the lane is simply finished. §6 has no row for it — the Needs-attention
        // strip (§3) narrates it — so the hero clears it silently instead of inventing motion.
        releaseLane(lane);
        draft.droplets.delete(issue);
        return null;
      }
      if (lane) lane.phase = "driving";
      const d = moveDroplet(draft, issue, { at: "checkpoint", ...(pr !== null ? { pr } : {}) });
      return { kind: "to-checkpoint", id, issue, lane: worker, pr: d.pr };
    }

    case "drive-fixup": {
      // Half of a pair: the send-back is recorded now, the return animates when the fix leg
      // actually starts. Animating here would show the droplet moving before the engine moved it.
      if (issue === null) return null;
      const reason = sendBackReason(p.reason);
      const lane = laneOf(draft, worker);
      if (lane) lane.reason = reason;
      moveDroplet(draft, issue, { sendBack: reason, ...(pr !== null ? { pr } : {}) });
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
      const d = moveDroplet(draft, issue, { lane: worker, at: "lane", handedOff: false, sendBack: reason, ...(pr !== null ? { pr } : {}) });
      return { kind: "fix-return", id, issue, lane: worker, pr: d.pr, reason, round };
    }

    case "fix-rounds-capped":
    case "drive-needs-human": {
      if (issue === null) return null;
      releaseLane(laneOf(draft, worker));
      const d = moveDroplet(draft, issue, { at: "needs-human", ...(pr !== null ? { pr } : {}) });
      return { kind: "escalate", id, issue, pr: d.pr };
    }

    case "merged": {
      if (issue === null) return null;
      releaseLane(laneOf(draft, worker));
      draft.rings += 1;
      // Only the newest merge keeps its tag on the trunk — older ones *are* the rings now.
      for (const [key, d] of draft.droplets) if (d.at === "trunk") draft.droplets.delete(key);
      const d = moveDroplet(draft, issue, { at: "trunk", ...(pr !== null ? { pr } : {}) });
      return { kind: "ring", id, issue, pr: d.pr, ring: draft.rings };
    }

    case "handoff": {
      if (issue === null) return null;
      releaseLane(laneOf(draft, worker));
      moveDroplet(draft, issue, { at: "backlog", handedOff: true });
      return { kind: "handoff", id, issue, lane: worker };
    }

    case "ceiling-escalated": {
      draft.ceilingReached = true;
      return { kind: "dim", id };
    }

    default: {
      if (!FAILURE_KINDS.has(e.kind) || issue === null) return null;
      const lane = laneOf(draft, worker);
      if (lane) lane.phase = "failed";
      moveDroplet(draft, issue, { failed: true });
      return { kind: "fail", id, issue, lane: worker };
    }
  }
}

/**
 * Fold a page of events onto the stage state.
 *
 * Events at or below `lastId` are skipped: the feed poll deliberately re-fetches an
 * overlapping tail (`queries.ts` holds `after` steady), so without this every poll would
 * re-count every merge.
 */
export function foldEvents(state: HeroState, events: LoopEvent[]): { state: HeroState; transitions: Transition[] } {
  const fresh = events.filter((e) => e.id > state.lastId).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) return { state, transitions: [] };

  const draft: Draft = {
    lanes: state.lanes.map((l) => ({ ...l })),
    droplets: new Map(state.droplets.map((d) => [d.issue, { ...d }])),
    pool: [...state.pool],
    rings: state.rings,
    ceilingReached: state.ceilingReached,
  };

  const transitions: Transition[] = [];
  for (const e of fresh) {
    const t = apply(draft, e);
    if (t) transitions.push(t);
  }

  return {
    state: {
      lanes: draft.lanes,
      droplets: [...draft.droplets.values()],
      pool: draft.pool,
      rings: draft.rings,
      ceilingReached: draft.ceilingReached,
      laneCountUnknown: state.laneCountUnknown,
      lastId: fresh.at(-1)?.id ?? state.lastId,
    },
    transitions,
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
