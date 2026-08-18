/**
 * The hero's animation layer — frontend-design.md §6.
 *
 * State lives in `state.ts`, sequencing/endpoints in `playback.ts`, markup in `stage.tsx`;
 * this file is the thin DOM + anime.js glue over `playback.ts`'s pure plan. Anything the
 * timelines skip (reduced motion, a coalesced burst, a replay jump) still renders correctly,
 * because the stage already drew the new state — the timelines only narrate the difference.
 */

import { createTimeline, cubicBezier, utils } from "animejs";
import { useEffect, useRef, useState } from "react";
import type { EngineState } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";
import type { StageNode } from "../inspector.ts";
// hero.css is pulled in via app.css's @import (same pattern as panels.css) rather than a
// direct module-level import here: a direct `import "./hero.css"` only resolves under Vite's
// bundler and breaks the plain `node --import tsx --test` runner App.test.tsx (and any other
// module that transitively imports this file) runs under, which has no CSS loader.
import { AnimationController } from "./animator.ts";
import { BEAT, buildPlayback, type PlaybackStep, type Point, RING_STROKE, TRAVEL } from "./playback.ts";
import { HeroStage } from "./stage.tsx";
import type { FoldStep, HeroState } from "./state.ts";
import { isStageDimmed, withLanePrs } from "./state.ts";

// #895 item 2: anime.js v4 dropped the string easing syntax — passing it through still "works"
// (falls back silently) but prints a console warning per resolved property and never actually
// applies the §5 easing token. The imported-function form is the only v4 form that both applies
// the curve and stays warning-free. Exported so a test can assert this exact curve is what
// `createTimeline`'s `defaults.ease` actually carries.
export const EASE = cubicBezier(0.3, 0.7, 0.3, 1);

type Timeline = ReturnType<typeof createTimeline>;

export type HeroProps = {
  /** #740: the shared reducer's hero slice (`replay/reducer.ts`'s `foldReplay`), folded by the
   *  caller — `useEventHistory` in live mode, a replay/scrub hook later. Hero no longer folds
   *  events itself; this is the fold's OUTPUT, pre-PR-overlay (see `lanes` below). */
  heroState: HeroState;
  /** This render's own fresh transitions/steps from the SAME fold call that produced `heroState`
   *  — Hero's animation input (`buildPlayback`). Empty when nothing new folded. */
  steps: FoldStep[];
  lanesMax: number | null;
  engine: EngineState;
  /**
   * Live lane rows from `/api/loop/state`. The only source of a driving lane's PR number —
   * `reclaim-done` doesn't carry it (§6 overlay). Empty in replay, where later events do.
   * `issue` (already present on every real `Lane` row `App.tsx` passes) is threaded straight
   * through to `HeroStage` as `liveLanes` too — #745 gate② round 4 PO ruling's "engine's live
   * lane list still tracks it" confidence check, matched by issue.
   */
  lanes?: readonly { lane: string; pr: number | null; issue: number }[];
  /** #803: `/api/loop/state`'s `mergedPrs` — the persisted merged-witness projection, threaded
   *  straight through to `HeroStage` (see its own doc). Empty in replay, same as `lanes`. */
  mergedPrs?: readonly number[];
  /** `lanes.prFixCap` — the "round n of cap" denominator. */
  fixCap?: number;
  /** Live round-phase cursor (`/api/loop/state`'s `round.phase`); null when no round is open. */
  roundPhase?: string | null;
  /** Replay transport speed; ≥ ×4 collapses animation per the §6 coalescing policy. */
  speed?: number;
  /** Allowlisted config (§3 E) — threaded straight to `HeroStage` for the model·effort /
   *  review-mode captions (#716 gate② P2-8). `null`/absent draws no captions. */
  config?: Record<string, unknown> | null;
  /** §6 phase inspector (#861) — threaded straight to `HeroStage`; see its own doc. */
  onInspect?: ((node: StageNode) => void) | undefined;
  /** #891: `entities.ts`'s `foldOpenAttention` result — threaded straight to `HeroStage`; see
   *  its own doc for why the hero tally/aria-label and the needs-attention strip must read this
   *  SAME fold rather than two independently-derived counts. */
  openAttention?: readonly DomainEvent[] | undefined;
  /** #895 item 1: the caller's own honest clock for the staleness caption — threaded straight to
   *  `HeroStage`'s own `now` prop (which already defaults to the real clock when this is absent).
   *  `App.tsx` passes the live wall clock in live mode, but the REPLAY CURSOR's own timestamp
   *  while replaying — without this, `HeroStage` fell back to `new Date()` even mid-replay, so a
   *  multi-day-old replayed round's staleness caption compared a historical event against the
   *  real live clock instead of the "as-of" instant the rest of the replayed view honors. */
  now?: Date | undefined;
};

export function Hero({
  heroState,
  steps,
  lanesMax,
  engine,
  lanes = [],
  mergedPrs = [],
  fixCap = 2,
  roundPhase = null,
  speed = 1,
  config = null,
  onInspect,
  openAttention,
  now,
}: HeroProps) {
  const reducedMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const previous = useRef(new Map<number, Point>());
  const controller = useRef(new AnimationController<Timeline>());

  // The PR tag the events cannot supply (§6 live overlay) — applied for the STATIC render
  // only, so replay (no overlay) drives the identical reducer with no overlay at all. The
  // animation pass below deliberately keeps reading `heroState` (pre-overlay), same as it
  // always has — a PR tag never changes a droplet's on-stage POSITION, only its label.
  const state = withLanePrs(heroState, lanes);

  // #716 gate② P1-1 + P2-4: `buildPlayback` gives each transition its own intermediate scene
  // and a non-overlapping offset (P1-1); this effect's dependency array is what makes P2-4's
  // "cancel whatever's in flight" true for every trigger that matters — a fresh fold, a
  // lanesMax/speed change, AND reduced-motion flipping mid-animation all re-run it, and
  // React calls the previous run's cleanup (which cancels the tracked timeline) before the
  // new one starts. The same cleanup fires on unmount.
  useEffect(() => {
    const { playback, finalPoints } = buildPlayback(steps, heroState, lanesMax, previous.current, { reducedMotion, speed });
    previous.current = finalPoints;
    const root = svgRef.current;
    if (!root) return;
    const result = play(root, playback, finalPoints);
    if (result) controller.current.start(result.timeline, result.cleanup);
    else controller.current.cancel();
    return () => controller.current.cancel();
  }, [steps, heroState, lanesMax, reducedMotion, speed]);

  // #920 owner ruling Q6: dimming is a LIVE-open-round-only concept — `roundPhase` is already
  // `null` in both replay and `?demo` (`App.tsx`'s own call site: `mode === "live" ? round.phase
  // : null`), so this is the same signal `App.tsx` already computes `roundPhase` from, not a new
  // one invented here.
  const isLiveOpenRound = roundPhase !== null;

  return (
    // #920: the hero draws inside a `.panel` card, matching the mockup band rather than floating
    // bare SVG furniture directly in the page grid. #924: `.panel-head` — the same title-row
    // anatomy every other module carries (§6 calls this section "the Loop") — title only, no stat
    // cluster: the SVG's own outcome ring/tally already carries the hero's own numbers, so a
    // second header count would just duplicate them.
    <div className="hero-frame panel">
      <div className="panel-head">
        <h2>loop</h2>
      </div>
      <HeroStage
        ref={svgRef}
        state={state}
        lanesMax={lanesMax}
        fixCap={fixCap}
        roundPhase={roundPhase}
        dimmed={isStageDimmed(state, engine, isLiveOpenRound)}
        reducedMotion={reducedMotion}
        config={config}
        liveLanes={lanes}
        mergedPrs={mergedPrs}
        onInspect={onInspect}
        openAttention={openAttention}
        now={now}
      />
    </div>
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
 * Run one render pass: snap everything the plan did not animate straight to its final
 * position, then narrate the animating steps as ONE sequenced timeline (#716 gate② P1-1 —
 * each step's own `offset`, from `buildPlayback`, keeps steps from overlapping). Returns the
 * created timeline plus a `cleanup` — a strip-every-gate's-`is-merged`-class function, always
 * safe to call idempotently — or `null` when nothing in this pass animates (the caller still
 * needs to know that, to cancel whatever a PREVIOUS pass left in flight — P2-4).
 *
 * Snapping first is what makes the coalescing policy honest — a collapsed burst reaches its
 * true position immediately and only the newest ring is allowed to take its time (§6).
 */
function play(
  root: SVGSVGElement,
  playback: PlaybackStep[],
  finalPoints: Map<number, Point>,
): { timeline: Timeline; cleanup: () => void } | null {
  const travelling = new Set(
    playback.filter((p) => p.animate && p.to !== null && "issue" in p.transition).map((p) => (p.transition as { issue: number }).issue),
  );

  for (const [issue, point] of finalPoints) {
    if (travelling.has(issue)) continue;
    const el = droplet(root, issue);
    if (el) utils.set(el, { translateX: point.x, translateY: point.y });
  }

  const animating = playback.filter((p) => p.animate);
  if (animating.length === 0) return null;

  const tl = createTimeline({ defaults: { ease: EASE } });
  // #716 gate② round 3 P2: every ring this pass masks with an inline `stroke-dasharray`/
  // `stroke-dashoffset` (below) — tracked so `cleanup` can strip those inline styles back
  // off, the same way it already strips the gates' `is-merged` class.
  const maskedRings: SVGCircleElement[] = [];

  for (const step of animating) {
    const { transition, offset, from, to, laneChannel, duration } = step;

    switch (transition.kind) {
      // Droplet detaches from the backlog stack and travels into a lane channel; the lane
      // lights in the same beat.
      case "dispatch": {
        travelOn(tl, root, transition.issue, from, to, TRAVEL, offset);
        lightLane(tl, root, laneChannel, offset);
        break;
      }

      // The PR-open transition: the droplet emerges carrying a PR tag and parks at the
      // CI / REVIEW pair, which breathes (CSS) while the PR waits. No per-gate progress.
      case "to-checkpoint": {
        travelOn(tl, root, transition.issue, from, to, TRAVEL, offset);
        break;
      }

      // The loop's proof moment: back along the return arrow into the lane it came from,
      // with the send-back reason lighting on the way.
      case "fix-return": {
        travelOn(tl, root, transition.issue, from, to, TRAVEL, offset);
        const arrow = root.querySelector<SVGPathElement>(".hero-fixloop");
        if (arrow) tl.add(arrow, { opacity: [0.35, 1, 0.35], duration: TRAVEL }, offset);
        lightLane(tl, root, laneChannel, offset);
        break;
      }

      // #716 gate② P2-6: production names the real send-back reason AFTER the droplet is
      // already back in its lane — this corrects the label in place. No travel; a small
      // flash on the lane's own caption is the whole narration.
      case "fix-reason": {
        if (laneChannel !== null) {
          const label = root.querySelector<SVGTextElement>(`.hero-lane[data-lane-index="${laneChannel}"] .hero-num`);
          if (label) tl.add(label, { opacity: [0.3, 1], duration: BEAT }, offset);
        }
        break;
      }

      // Onto the rust escalation branch. Still, not loud.
      //
      // #808 gate② finding [0]: `travelOn` draws a STRAIGHT LINE from the checkpoint rank to
      // the needs-human rank. Both zones anchor their columns at the same x
      // (`(GATES.ci + GATES.review) / 2` in stage.tsx, `ESCALATION.x` here) directly under the
      // Review gate's mode caption, and the two zones straddle the gate row vertically — ANY
      // straight line between them crosses the gate row, and there is no slack left to route
      // around it: left is the LANES zone's own right-edge content (channel line + PR-chip
      // "hero-mark" run right up to `LANES.x + LANES.w + 12`), right is boxed in by the Review
      // gate rect and the trunk rings' leftmost reach (`TRUNK.x - TRUNK.max * TRUNK.step`) with
      // only ~20px between them — too narrow a corridor to route a detour waypoint through
      // safely at every checkpoint-rank × needs-human-rank pairing. `fadeAcross` sidesteps the
      // crossing itself instead of threading it: the droplet fades out AT its settled
      // checkpoint point, jumps instantly (fully transparent, so invisible) straight to its
      // settled needs-human point, then fades back in — it is NEVER rendered at any
      // interpolated point in between, so it cannot bbox-intersect anything that only lives
      // between the two zones (the caption included). Both endpoints are themselves already
      // proven collision-free by `hero.test.ts`'s settled-position oracles (#745/#808 AC1).
      case "escalate": {
        fadeAcross(tl, root, transition.issue, from, to, TRAVEL, offset);
        const branch = root.querySelector<SVGPathElement>(".hero-branch");
        if (branch) tl.add(branch, { opacity: [0.4, 1], duration: BEAT }, offset + TRAVEL - BEAT);
        break;
      }

      // The one celebratory moment: gates flash ✓ (--moss), the droplet crosses the merge arm
      // into the trunk, and a new ring — also --moss — strokes in behind it.
      case "ring": {
        const gates = [...root.querySelectorAll<SVGGElement>(".hero-gate")];
        // #716 gate② round 2 P1-3: BOTH the add and the remove are now scheduled ON the
        // timeline, at THIS step's own offset/offset+duration — not "add synchronously at
        // play()-call time, remove on a timer". Two non-coalesced merges in one poll used to
        // both add the class the instant `play()` ran (before either step's visual window
        // even started), so step 1's scheduled removal (firing at t=duration) killed the
        // class before step 2's window (which starts at that same instant) ever got a
        // matching add of its own — the flash never reappeared for step 2. Scheduling both
        // ends per-step means step 2's add (inserted after step 1's remove in call order)
        // wins at the shared boundary tick, and each step's flash is honestly its own.
        tl.call(() => {
          for (const g of gates) g.classList.add("is-merged");
        }, offset);
        tl.call(() => {
          for (const g of gates) g.classList.remove("is-merged");
        }, offset + duration);
        travelOn(tl, root, transition.issue, from, to, TRAVEL, offset);
        // #716 gate② round 2 P1-3: target THIS transition's own ring (`data-ring`, stage.tsx)
        // rather than the sole `data-current="true"` element — two non-coalesced merges in
        // one poll used to both animate the SAME (newest) circle.
        const ring = root.querySelector<SVGCircleElement>(`.hero-ring[data-ring="${transition.ring}"]`);
        if (ring) {
          const circumference = 2 * Math.PI * ring.r.baseVal.value;
          // #716 gate② round 3 P2: this `utils.set` runs synchronously, BEFORE the timeline
          // segment below ever plays — it masks the ring fully offset (invisible) as the
          // tween's start point. `Timeline.revert()` only knows how to undo properties IT
          // animated; a cancel that lands before the tween starts (or mid-tween) leaves this
          // imperative pre-set mask in place, rendering the newest ring invisible — exactly
          // the reduced-motion-instant-final-scene AC this stage promises never to violate.
          // `maskedRings` lets `cleanup` strip the mask back off, same as the gate classes.
          utils.set(ring, { strokeDasharray: circumference, strokeDashoffset: circumference });
          tl.add(ring, { strokeDashoffset: [circumference, 0], duration: RING_STROKE }, offset + TRAVEL - BEAT);
          maskedRings.push(ring);
        }
        const count = root.querySelector<SVGTextElement>(".hero-ring-count");
        if (count) tl.add(count, { opacity: [0.3, 1], duration: BEAT }, offset + TRAVEL);
        break;
      }

      // Folds back into the backlog with its "saved for a successor" badge.
      case "handoff": {
        travelOn(tl, root, transition.issue, from, to, TRAVEL, offset);
        const badge = droplet(root, transition.issue)?.querySelector<SVGTextElement>(".hero-badge");
        if (badge) tl.add(badge, { opacity: [0, 1], duration: BEAT }, offset + TRAVEL);
        break;
      }

      // Failures are still, not loud: the droplet stops where it stands and the ✕ fades up.
      case "fail": {
        const mark = droplet(root, transition.issue)?.querySelector<SVGTextElement>(".hero-mark");
        if (mark) tl.add(mark, { opacity: [0, 1], duration: BEAT }, offset);
        break;
      }

      // Ceiling / PAUSE / kill switch: dimming and the ambient stop are CSS states driven by
      // `data-dimmed`, so there is nothing to time here — the row exists to keep the
      // coalescing budget honest about how many transitions a burst carried.
      case "dim":
        break;
    }
  }

  // #716 gate② round 2 P2-4 + round 3 P2: two side effects above happen OUTSIDE anime.js's
  // own tracked properties — the gate `classList` mutation, and the ring's imperative
  // pre-tween `stroke-dasharray`/`stroke-dashoffset` mask. `Timeline.revert()` has no idea
  // either exists, so cancelling mid-merge (reduced motion flipping on, or a fresh scene
  // landing) used to leave the gates stuck permanently `--moss`/✓ AND the newest ring stuck
  // fully dash-offset (invisible) — the second one a direct AC violation (reduced motion
  // promises an instant, fully-visible final scene). This cleanup — idempotent, safe to call
  // whether or not a merge ever actually ran — is handed to `AnimationController.start()`
  // and always runs on `cancel()`.
  const cleanup = () => {
    for (const g of root.querySelectorAll<SVGGElement>(".hero-gate.is-merged")) g.classList.remove("is-merged");
    for (const ring of maskedRings) {
      ring.style.removeProperty("stroke-dasharray");
      ring.style.removeProperty("stroke-dashoffset");
    }
  };

  return { timeline: tl, cleanup };
}

function travelOn(
  tl: Timeline,
  root: SVGSVGElement,
  issue: number,
  from: Point | null,
  to: Point | null,
  duration: number,
  offset: number,
): void {
  if (!from || !to) return;
  const el = droplet(root, issue);
  if (!el) return;
  utils.set(el, { translateX: from.x, translateY: from.y });
  tl.add(el, { translateX: [from.x, to.x], translateY: [from.y, to.y], duration }, offset);
}

/** See the `escalate` case's own doc for why this exists instead of `travelOn`: it renders the
 *  droplet at exactly TWO positions — `from` and `to`, snapped via `utils.set`, never tweened —
 *  with an opacity fade bridging the gap so the jump itself isn't a visible pop. */
function fadeAcross(
  tl: Timeline,
  root: SVGSVGElement,
  issue: number,
  from: Point | null,
  to: Point | null,
  duration: number,
  offset: number,
): void {
  if (!from || !to) return;
  const el = droplet(root, issue);
  if (!el) return;
  const half = duration / 2;
  utils.set(el, { translateX: from.x, translateY: from.y, opacity: 1 });
  tl.add(el, { opacity: [1, 0], duration: half }, offset);
  tl.call(() => utils.set(el, { translateX: to.x, translateY: to.y }), offset + half);
  tl.add(el, { opacity: [0, 1], duration: half }, offset + half);
}

function lightLane(tl: Timeline, root: SVGSVGElement, laneChannel: number | null, offset: number): void {
  if (laneChannel === null) return;
  const channel = root.querySelector<SVGLineElement>(`.hero-lane[data-lane-index="${laneChannel}"] .hero-channel`);
  if (channel) tl.add(channel, { opacity: [0.3, 1], duration: BEAT }, offset);
}
