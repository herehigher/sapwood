/**
 * The hero's animation layer — frontend-design.md §6.
 *
 * One anime.js timeline per row of the §6 transition table, and nothing else: state lives
 * in `state.ts`, markup in `stage.tsx`. Anything the timelines skip (reduced motion, a
 * coalesced burst, a replay jump) still renders correctly, because the stage already drew
 * the new state — the timelines only narrate the difference.
 */

import { createTimeline, utils } from "animejs";
import { useEffect, useRef, useState } from "react";
import type { EngineState } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";
import "./hero.css";
import { dropletPoint, HeroStage } from "./stage.tsx";
import {
  foldEvents,
  type HeroState,
  initialHeroState,
  isStageDimmed,
  type PlannedTransition,
  planTransitions,
  type Transition,
  transitionOrigin,
  withLaneCount,
  withLanePrs,
} from "./state.ts";

/** §5 motion tokens, in the units anime.js wants. Kept in sync with tokens.css by name. */
const BEAT = 240;
const TRAVEL = 900;
const RING_STROKE = 1200;
const EASE = "cubicBezier(.3,.7,.3,1)";

type Point = { x: number; y: number };
type Scene = { state: HeroState; plan: PlannedTransition[] };

export type HeroProps = {
  /** The polled event tail, already classified at the `domain-event.ts` parse boundary
   *  (`useEventHistory`'s `accumulateEventsPage`, #715 gate② round 5 [0]) — never the raw
   *  wire `LoopEvent`. The fold skips ids it has already seen, so overlap is free. */
  events: DomainEvent[];
  lanesMax: number | null;
  engine: EngineState;
  /**
   * Live lane rows from `/api/loop/state`. The only source of a driving lane's PR number —
   * `reclaim-done` doesn't carry it (§6 overlay). Empty in replay, where later events do.
   */
  lanes?: readonly { lane: string; pr: number | null }[];
  /** `lanes.prFixCap` — the "round n of cap" denominator. */
  fixCap?: number;
  /** Live round-phase cursor (`/api/loop/state`'s `round.phase`); null when no round is open. */
  roundPhase?: string | null;
  /** Replay transport speed; ≥ ×4 collapses animation per the §6 coalescing policy. */
  speed?: number;
};

export function Hero({ events, lanesMax, engine, lanes = [], fixCap = 2, roundPhase = null, speed = 1 }: HeroProps) {
  const reducedMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const previous = useRef(new Map<number, Point>());
  const [scene, setScene] = useState<Scene>(() => ({ state: initialHeroState(lanesMax), plan: [] }));

  useEffect(() => {
    setScene((prev) => {
      const base = withLaneCount(prev.state, lanesMax);
      const { state, transitions } = foldEvents(base, events);
      if (state === prev.state && transitions.length === 0) return prev;
      return { state, plan: planTransitions(transitions, { reducedMotion, speed }) };
    });
  }, [events, lanesMax, reducedMotion, speed]);

  // The PR tag the events cannot supply (§6 live overlay) — applied to the folded state
  // rather than inside it, so replay drives the identical reducer with no overlay at all.
  const state = withLanePrs(scene.state, lanes);

  useEffect(() => {
    const root = svgRef.current;
    if (root) previous.current = play(root, scene, previous.current);
  }, [scene]);

  return (
    <HeroStage
      ref={svgRef}
      state={state}
      fixCap={fixCap}
      roundPhase={roundPhase}
      dimmed={isStageDimmed(state, engine)}
      reducedMotion={reducedMotion}
    />
  );
}

/** §6: the JS half of the reduced-motion contract; app.css collapses the CSS half. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  useEffect(() => {
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

const droplet = (root: SVGSVGElement, issue: number) => root.querySelector<SVGGElement>(`.hero-droplet[data-issue="${issue}"]`);

/**
 * Run one scene: snap everything the plan did not animate, then narrate what it did.
 *
 * Snapping first is what makes the coalescing policy honest — a collapsed burst reaches its
 * true position immediately and only the newest ring is allowed to take its time (§6).
 * Returns the positions this pass left behind, so the next travel knows where it starts.
 */
function play(root: SVGSVGElement, { state, plan }: Scene, previous: Map<number, Point>): Map<number, Point> {
  const points = new Map(state.droplets.map((d) => [d.issue, dropletPoint(state, d)]));
  const travelling = new Set(plan.filter((p) => p.animate && "issue" in p).map((p) => (p as { issue: number }).issue));

  for (const [issue, point] of points) {
    if (travelling.has(issue)) continue;
    const el = droplet(root, issue);
    if (el) utils.set(el, { translateX: point.x, translateY: point.y });
  }

  for (const step of plan) {
    if (!step.animate) continue;
    const tl = createTimeline({ defaults: { ease: EASE } });

    switch (step.kind) {
      // Droplet detaches from the backlog stack and travels into a lane channel; the lane
      // lights in the same beat.
      case "dispatch": {
        travel(tl, root, state, step, previous, points, TRAVEL);
        lightLane(tl, root, state, step.lane);
        break;
      }

      // The PR-open transition: the droplet emerges carrying a PR tag and parks at the
      // CI / REVIEW pair, which breathes (CSS) while the PR waits. No per-gate progress.
      case "to-checkpoint": {
        travel(tl, root, state, step, previous, points, TRAVEL);
        break;
      }

      // The loop's proof moment: back along the return arrow into the lane it came from,
      // with the send-back reason lighting on the way.
      case "fix-return": {
        travel(tl, root, state, step, previous, points, TRAVEL);
        const arrow = root.querySelector<SVGPathElement>(".hero-fixloop");
        if (arrow) tl.add(arrow, { opacity: [0.35, 1, 0.35], duration: TRAVEL }, 0);
        lightLane(tl, root, state, step.lane);
        break;
      }

      // Onto the rust escalation branch. Still, not loud.
      case "escalate": {
        travel(tl, root, state, step, previous, points, TRAVEL);
        const branch = root.querySelector<SVGPathElement>(".hero-branch");
        if (branch) tl.add(branch, { opacity: [0.4, 1], duration: BEAT }, TRAVEL - BEAT);
        break;
      }

      // The one celebratory moment: gates flash ✓ (--moss), the droplet crosses the merge arm
      // into the trunk, and a new ring — also --moss — strokes in behind it.
      case "ring": {
        const gates = [...root.querySelectorAll<SVGGElement>(".hero-gate")];
        for (const g of gates) g.classList.add("is-merged");
        tl.onComplete = () => {
          for (const g of gates) g.classList.remove("is-merged");
        };
        travel(tl, root, state, step, previous, points, TRAVEL);
        const ring = root.querySelector<SVGCircleElement>('.hero-ring[data-current="true"]');
        if (ring) {
          const circumference = 2 * Math.PI * ring.r.baseVal.value;
          utils.set(ring, { strokeDasharray: circumference, strokeDashoffset: circumference });
          tl.add(ring, { strokeDashoffset: [circumference, 0], duration: RING_STROKE }, TRAVEL - BEAT);
        }
        const count = root.querySelector<SVGTextElement>(".hero-ring-count");
        if (count) tl.add(count, { opacity: [0.3, 1], duration: BEAT }, TRAVEL);
        break;
      }

      // Folds back into the backlog with its "saved for a successor" badge.
      case "handoff": {
        travel(tl, root, state, step, previous, points, TRAVEL);
        const badge = droplet(root, step.issue)?.querySelector<SVGTextElement>(".hero-badge");
        if (badge) tl.add(badge, { opacity: [0, 1], duration: BEAT }, TRAVEL);
        break;
      }

      // Failures are still, not loud: the droplet stops where it stands and the ✕ fades up.
      case "fail": {
        const mark = droplet(root, step.issue)?.querySelector<SVGTextElement>(".hero-mark");
        if (mark) tl.add(mark, { opacity: [0, 1], duration: BEAT });
        break;
      }

      // Ceiling / PAUSE / kill switch: dimming and the ambient stop are CSS states driven by
      // `data-dimmed`, so there is nothing to time here — the row exists to keep the
      // coalescing budget honest about how many transitions a burst carried.
      case "dim":
        break;
    }
  }

  return points;
}

/**
 * Animate a droplet from where it was to where it now is.
 *
 * A droplet the stage has never rendered has no previous position — falling back to `to`
 * would animate it to itself, so a first `dispatched` would pop into the lane with no
 * journey at all. The transition's own semantic origin (`transitionOrigin`) is the fallback,
 * which is where the §6 table says the travel begins.
 */
function travel(
  tl: ReturnType<typeof createTimeline>,
  root: SVGSVGElement,
  state: HeroState,
  step: Transition,
  previous: Map<number, Point>,
  points: Map<number, Point>,
  duration: number,
): void {
  if (!("issue" in step)) return;
  const el = droplet(root, step.issue);
  const to = points.get(step.issue);
  const d = state.droplets.find((o) => o.issue === step.issue);
  if (!el || !to || !d) return;

  const origin = transitionOrigin(step);
  const from = previous.get(step.issue) ?? (origin ? dropletPoint(state, d, origin) : to);
  utils.set(el, { translateX: from.x, translateY: from.y });
  tl.add(el, { translateX: [from.x, to.x], translateY: [from.y, to.y], duration }, 0);
}

function lightLane(tl: ReturnType<typeof createTimeline>, root: SVGSVGElement, state: HeroState, worker: string | null): void {
  const lane = state.lanes.find((l) => l.worker === worker);
  const channel = lane && root.querySelector<SVGLineElement>(`.hero-lane[data-lane-index="${lane.channel}"] .hero-channel`);
  if (channel) tl.add(channel, { opacity: [0.3, 1], duration: BEAT }, 0);
}
