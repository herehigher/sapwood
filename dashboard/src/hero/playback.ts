/**
 * The pure sequencing/endpoint layer between the hero's event fold (`state.ts`) and its
 * anime.js execution (`Hero.tsx`). Zero DOM, zero anime.js, zero timers — so #716 gate②
 * P1-1's fix is testable without a browser.
 *
 * P1-1: the animation layer used to animate EVERY transition in a poll's batch against the
 * batch's FINAL `dropletPoint` — a batch containing `dispatched` then `reclaim-done` for the
 * same issue animated the `dispatched` leg straight to the checkpoint (reclaim-done's
 * destination, since that's where the final state has the droplet), skipping the backlog→
 * lane beat entirely, while two separately-created, un-sequenced timelines wrote conflicting
 * `translateX/Y` onto the same element. `buildPlayback` gives each transition its OWN
 * before/after scene (`FoldStep.state`, `state.ts`'s per-event snapshot) to compute correct
 * endpoints from, and a non-overlapping `offset` so steps play in sequence, not concurrently.
 */

import { dropletPoint } from "./stage.tsx";
import { type FoldStep, type HeroState, planTransitions, type Transition, transitionOrigin, withVisibleLanes } from "./state.ts";

export type Point = { x: number; y: number };

/** §5 motion tokens, in the units anime.js wants. Kept in sync with tokens.css by name. */
export const BEAT = 240;
export const TRAVEL = 900;
export const RING_STROKE = 1200;

/**
 * How long a step's own animation(s) run — the budget the NEXT step's `offset` starts after,
 * so steps chain instead of overlapping. Mirrors the sub-animation timings `Hero.tsx`'s
 * DOM-touching player actually schedules for each kind (the travel, plus whatever narrates
 * alongside it, whichever finishes last).
 */
export function stepDuration(kind: Transition["kind"]): number {
  switch (kind) {
    case "dispatch":
    case "to-checkpoint":
    case "fix-return":
    case "escalate":
      return TRAVEL;
    case "ring":
      return TRAVEL - BEAT + RING_STROKE;
    case "handoff":
      return TRAVEL + BEAT;
    case "fail":
    case "fix-reason":
      return BEAT;
    case "dim":
      return 0;
  }
}

export type PlaybackStep = {
  transition: Transition;
  animate: boolean;
  /** Start time (ms) within this render pass's composed timeline — 0 for the first
   *  animating step, and non-overlapping with every other animating step's window. */
  offset: number;
  /** This step's own duration; 0 when it doesn't animate. */
  duration: number;
  /** Travel endpoints, only for transitions that actually move a droplet
   *  (`transitionOrigin(transition) !== null`); null otherwise (e.g. `fail`, `fix-reason`). */
  from: Point | null;
  to: Point | null;
  /** The display (capped, §6 P1-9) lane channel for `lightLane`/label-flash DOM targets,
   *  when the transition names a lane; null otherwise. */
  laneChannel: number | null;
};

const laneOf = (t: Transition): string | null => ("lane" in t ? t.lane : null);
const issueOf = (t: Transition): number | null => ("issue" in t ? t.issue : null);

/**
 * Build the sequenced, per-step playback plan for one fold's worth of steps.
 *
 * `previous` is the caller's cross-render memory of each issue's last-rendered position; this
 * function also chains THROUGH it locally, so a second transition for the same issue within
 * the SAME batch travels from the first one's destination, not from stale cross-batch history
 * (or from the final state directly, P1-1's bug). Returns the updated point map for every
 * currently-present droplet — the caller's new `previous` for its next render.
 */
export function buildPlayback(
  steps: readonly FoldStep[],
  finalState: HeroState,
  lanesMax: number | null,
  previous: ReadonlyMap<number, Point>,
  opts: { reducedMotion?: boolean; speed?: number } = {},
): { playback: PlaybackStep[]; finalPoints: Map<number, Point> } {
  const finalView = withVisibleLanes(finalState, lanesMax);
  const finalPoints = new Map(finalView.droplets.map((d) => [d.issue, dropletPoint(finalView, d)]));

  const plan = planTransitions(
    steps.map((s) => s.transition),
    opts,
  );

  const running = new Map(previous);
  let cursor = 0;
  const playback: PlaybackStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const { transition, state: stepState } = step;
    const animate = plan[i]?.animate ?? false;
    const view = withVisibleLanes(stepState, lanesMax);

    const issue = issueOf(transition);
    const travels = transitionOrigin(transition) !== null;
    let from: Point | null = null;
    let to: Point | null = null;

    if (issue !== null) {
      const d = view.droplets.find((o) => o.issue === issue);
      if (d && travels) {
        to = dropletPoint(view, d);
        const origin = transitionOrigin(transition);
        from = running.get(issue) ?? (origin ? dropletPoint(view, d, origin) : to);
        running.set(issue, to);
      } else if (d) {
        // A non-travelling touch (e.g. `fix-reason`) still teaches `running` where the
        // droplet actually is, so a LATER travelling step for the same issue doesn't fall
        // back to a stale position from before this one.
        running.set(issue, dropletPoint(view, d));
      }
    }

    const lane = laneOf(transition);
    const laneChannel = lane !== null ? (view.lanes.find((l) => l.worker === lane)?.channel ?? null) : null;

    const duration = animate ? stepDuration(transition.kind) : 0;
    playback.push({ transition, animate, offset: cursor, duration, from, to, laneChannel });
    if (animate) cursor += duration;
  }

  return { playback, finalPoints };
}
