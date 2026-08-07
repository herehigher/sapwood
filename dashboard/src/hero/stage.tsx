/**
 * The fixed SVG stage — frontend-design.md §6, geometry settled by the 2026-07-21 mockup
 * amendment: a horizontal band under three phase captions, four zones left → right, closed
 * by a dashed bottom return path.
 *
 * Pure: it draws `HeroState` and nothing else. No anime.js, no polling, no time — the
 * animation layer lives in `Hero.tsx`. That split is what lets the §6 table be asserted
 * against real markup without a browser, and it means a redraw from state alone is always
 * correct even if every animation is skipped.
 *
 * §144: the planning trio and reflection pair are lit from the live round-phase cursor
 * (`round.phase` on `/api/loop/state`, shipped by #206) rather than drawn as a permanently
 * dimmed "reserved" row — issue #144's AC forbids any reserved/dormant slot on the stage.
 */

import type { Ref } from "react";
import { activePlanningNode, activeReflectionNode, type Droplet, type DropletAt, type HeroState } from "./state.ts";

// ── Geometry ──────────────────────────────────────────────────────────────────
// One coordinate space, shared with Hero.tsx's timelines so travel always lands where
// the next render draws.

export const STAGE = { w: 1200, h: 380 } as const;

// The backlog sits in from the left edge so the "saved for a successor" badge — the widest
// thing that hangs off a droplet — still fits inside the viewBox.
const BACKLOG = { x: 46, y: 62, w: 96, chip: 22 } as const;
/** `note` clears the tallest lane stack (`lanes.max` 6) rather than sitting under 3 lanes. */
const PLANNING = { x: 224, note: 300, noteX: 152 } as const;
/** §7: plain word first, internal term never. */
const PLANNING_NODES = [
  { node: "goal-align" as const, y: 96, label: "Goal & align", hint: "Decides what's worth doing this round and files it as issues" },
  { node: "arch-review" as const, y: 158, label: "Arch review", hint: "Checks the round's plans fit the architecture before work starts" },
  {
    node: "verify" as const,
    y: 220,
    label: "Verify",
    hint: "An independent review approves each plan — including how it will be verified — before any code is written",
  },
] as const;
const LANES = { x: 330, w: 372, top: 92, gap: 44 } as const;
const GATES = { ci: 762, review: 858, y: 156 } as const;
const ESCALATION = { x: 810, y: 320 } as const;
const TRUNK = { x: 1006, y: 156, step: 7, max: 12 } as const;
const REFLECTION = { x: 1118, bottom: 244 } as const;
const REFLECTION_NODES = [
  { node: "summary" as const, y: 110, label: "Summary" },
  { node: "retro" as const, y: 200, label: "Retro" },
] as const;

const laneY = (index: number) => LANES.top + index * LANES.gap;

/** The channel a droplet belongs to; channel 0 when its lane has already been released. */
const laneIndex = (state: HeroState, d: Droplet) => state.lanes.find((l) => l.worker === d.lane)?.channel ?? 0;

/**
 * Where a droplet sits, in stage coordinates. The single source for both draw and travel.
 *
 * `at` defaults to where the droplet actually is; pass a zone to get the same droplet's
 * coordinates somewhere else — that is how a first-seen droplet gets a travel origin
 * (`transitionOrigin`) instead of animating from its own destination.
 */
export function dropletPoint(state: HeroState, d: Droplet, at: DropletAt = d.at): { x: number; y: number } {
  switch (at) {
    case "backlog": {
      const rank = state.droplets.filter((o) => o.at === "backlog").findIndex((o) => o.issue === d.issue);
      return { x: BACKLOG.x + BACKLOG.w / 2, y: BACKLOG.y + 30 + Math.max(0, rank) * BACKLOG.chip };
    }
    case "lane":
      return { x: LANES.x + LANES.w * 0.55, y: laneY(laneIndex(state, d)) };
    case "checkpoint":
      return { x: (GATES.ci + GATES.review) / 2, y: GATES.y - 46 };
    case "needs-human": {
      const rank = state.droplets.filter((o) => o.at === "needs-human").findIndex((o) => o.issue === d.issue);
      return { x: ESCALATION.x + Math.max(0, rank) * 26, y: ESCALATION.y - 30 };
    }
    case "trunk":
      return { x: TRUNK.x, y: TRUNK.y };
  }
}

/** A droplet's fill token — §6/§5: `--sap` in motion, `--rust` stopped/escalated, `--moss` merged. */
function dropletFill(d: Droplet): string {
  if (d.at === "trunk") return "var(--moss)";
  if (d.failed || d.at === "needs-human") return "var(--rust)";
  return "var(--sap)";
}

// ── Component ─────────────────────────────────────────────────────────────────

export type HeroStageProps = {
  state: HeroState;
  /** `lanes.prFixCap` — the stage renders "round n of cap", the fold only knows n. */
  fixCap: number;
  /** Live round-phase cursor (`/api/loop/state`'s `round.phase`); null when no round is open. */
  roundPhase?: string | null;
  /** §6: ceiling breach / PAUSE / kill switch. Computed by `isStageDimmed`. */
  dimmed?: boolean;
  /** Drives the CSS ambient shimmer off; the travel/stroke half is `Hero.tsx`'s job. */
  reducedMotion?: boolean;
  ref?: Ref<SVGSVGElement>;
};

export function HeroStage({ state, fixCap, roundPhase = null, dimmed = false, reducedMotion = false, ref }: HeroStageProps) {
  const waiting = state.droplets.some((d) => d.at === "checkpoint");
  const gateState = waiting ? "waiting" : "idle";
  const escalated = state.droplets.filter((d) => d.at === "needs-human").length;
  const anyRunning = state.lanes.some((l) => l.phase === "writing" || l.phase === "fixing");
  const activePlanning = activePlanningNode(roundPhase);
  const activeReflection = activeReflectionNode(roundPhase);

  return (
    <svg
      ref={ref}
      className="hero"
      viewBox={`0 0 ${STAGE.w} ${STAGE.h}`}
      data-dimmed={dimmed ? "true" : "false"}
      data-motion={reducedMotion ? "reduced" : "full"}
      data-running={anyRunning ? "true" : "false"}
      role="img"
      aria-label={`Loop stage: ${state.rings} merged pull request${state.rings === 1 ? "" : "s"} so far, ${escalated} item${escalated === 1 ? "" : "s"} waiting on a person. The activity feed carries the same information as text.`}
    >
      {/* ── Phase captions — §5: the big display face, sparingly ── */}
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={176} y={26} textAnchor="middle">
        PLAN
      </text>
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={620} y={26} textAnchor="middle">
        IMPLEMENT
      </text>
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={1030} y={26} textAnchor="middle">
        OUTCOME
      </text>

      {/* ── Zone 1: backlog ── */}
      <g className="hero-backlog">
        <text className="hero-label" x={BACKLOG.x} y={BACKLOG.y - 12}>
          BACKLOG
        </text>
        <rect className="hero-well" x={BACKLOG.x} y={BACKLOG.y} width={BACKLOG.w} height={210} rx={6} />
        {state.pool.map((issue, i) => (
          <g className="hero-pool-chip" key={issue} data-issue={issue}>
            <rect
              style={{ fill: "var(--sap)" }}
              x={BACKLOG.x + 8}
              y={BACKLOG.y + 10 + i * BACKLOG.chip}
              width={BACKLOG.w - 16}
              height={16}
              rx={8}
            />
            <text className="hero-num" x={BACKLOG.x + BACKLOG.w / 2} y={BACKLOG.y + 22 + i * BACKLOG.chip} textAnchor="middle">
              ⊙ {issue}
            </text>
          </g>
        ))}
      </g>

      {/*
       * ── Zone 2: planning ──
       * §144: lit from the live round-phase cursor, not a permanently dimmed reserved row —
       * `round-phase` (#206) is shipped engine reality, so this is real state, not fake progress.
       */}
      <g className="hero-planning" data-node="planning">
        {PLANNING_NODES.map((n) => (
          <g key={n.node} data-active={activePlanning === n.node ? "true" : "false"}>
            <title>{n.hint}</title>
            <circle className="hero-planning-node" cx={PLANNING.x} cy={n.y} r={17} />
            <text className="hero-node-label" x={PLANNING.x + 28} y={n.y + 4}>
              {n.label}
            </text>
          </g>
        ))}
      </g>

      {/* ── Zone 3: work lanes, checkpoints, fix loop, escalation branch ── */}
      <g className="hero-lanes">
        {state.lanes.map((lane) => (
          <g className="hero-lane" key={lane.channel} data-lane-index={lane.channel} data-phase={lane.phase} data-issue={lane.issue ?? ""}>
            <line className="hero-channel" x1={LANES.x} y1={laneY(lane.channel)} x2={LANES.x + LANES.w} y2={laneY(lane.channel)} />
            <text className="hero-node-label" x={LANES.x} y={laneY(lane.channel) - 10}>
              {state.laneCountUnknown ? "lane count unknown — config unreadable" : `Work lane ${lane.channel + 1}`}
            </text>
            {lane.worker && !state.laneCountUnknown && (
              <text className="hero-num hero-small" x={LANES.x + LANES.w} y={laneY(lane.channel) - 10} textAnchor="end">
                {lane.phase === "fixing"
                  ? `FIXING · round ${lane.fixRound} of ${fixCap}${lane.reason ? ` · ${lane.reason}` : ""}`
                  : lane.worker}
              </text>
            )}
            {lane.phase === "failed" && (
              <text className="hero-mark" x={LANES.x + LANES.w + 12} y={laneY(lane.channel) + 5}>
                ✕
              </text>
            )}
          </g>
        ))}

        {/* The fix loop, drawn as the engine's true shape: back into the lane itself. */}
        <path
          className="hero-fixloop"
          d={`M ${GATES.ci - 30} ${GATES.y + 26} C ${640} ${GATES.y + 78}, ${430} ${GATES.y + 78}, ${LANES.x + 40} ${laneY(0) + 12}`}
        />
      </g>

      {/*
       * The two checkpoints render as ONE waiting area (§6): both carry the same state, always.
       * v0.2 persists no gate substate, so faking per-gate progress would be a lie (§10).
       * Plain labels only — CI / Review, never gate①/gate②.
       */}
      <g className="hero-gates">
        <g className="hero-gate" data-gate="ci" data-state={gateState}>
          <rect x={GATES.ci - 34} y={GATES.y - 20} width={68} height={40} rx={6} />
          <text className="hero-node-label" x={GATES.ci} y={GATES.y + 5} textAnchor="middle">
            CI
          </text>
        </g>
        <g className="hero-gate" data-gate="review" data-state={gateState}>
          <rect x={GATES.review - 42} y={GATES.y - 20} width={84} height={40} rx={6} />
          <text className="hero-node-label" x={GATES.review} y={GATES.y + 5} textAnchor="middle">
            Review
          </text>
        </g>
        <line className="hero-arm" x1={GATES.ci + 34} y1={GATES.y} x2={GATES.review - 42} y2={GATES.y} />
        <line className="hero-arm" x1={GATES.review + 42} y1={GATES.y} x2={TRUNK.x - 40} y2={TRUNK.y} />
      </g>

      {/* Escalation branch — the one place rust appears on the stage. */}
      <g className="hero-escalation" data-node="needs-human" data-count={escalated}>
        <path
          style={{ stroke: "var(--rust)" }}
          className="hero-branch"
          d={`M ${ESCALATION.x} ${GATES.y} L ${ESCALATION.x} ${ESCALATION.y - 18}`}
        />
        <circle style={{ stroke: "var(--rust)" }} cx={ESCALATION.x} cy={ESCALATION.y} r={13} />
        <text className="hero-node-label" x={ESCALATION.x + 24} y={ESCALATION.y + 4}>
          Needs human
        </text>
      </g>

      {/* ── Zone 4: trunk cross-section + reflection ── */}
      <g className="hero-trunk" data-rings={state.rings}>
        {ringRadii(state.rings).map((r, i, all) => {
          const current = i === all.length - 1;
          return (
            <circle
              className="hero-ring"
              key={r}
              cx={TRUNK.x}
              cy={TRUNK.y}
              r={r}
              data-current={current ? "true" : "false"}
              style={current ? { stroke: "var(--moss)" } : undefined}
            />
          );
        })}
        <text className="hero-ring-count" style={{ fontFamily: "var(--font-display)" }} x={TRUNK.x} y={TRUNK.y + 106} textAnchor="middle">
          {state.rings}
        </text>
        <text className="hero-label" x={TRUNK.x} y={TRUNK.y + 124} textAnchor="middle">
          {state.rings === 1 ? "ring" : "rings"}
        </text>
      </g>

      <g className="hero-reflection" data-node="reflection">
        {REFLECTION_NODES.map((n) => (
          <g key={n.node} data-active={activeReflection === n.node ? "true" : "false"}>
            <circle className="hero-planning-node" cx={REFLECTION.x} cy={n.y} r={13} />
            <text className="hero-node-label" x={REFLECTION.x} y={n.y + 30} textAnchor="middle">
              {n.label}
            </text>
          </g>
        ))}
      </g>

      {/* The dashed return path that closes the loop back into planning. */}
      <path
        className="hero-return"
        d={`M ${REFLECTION.x} ${REFLECTION.bottom} L ${REFLECTION.x} ${STAGE.h - 20} L ${PLANNING.x} ${STAGE.h - 20} L ${PLANNING.x} ${PLANNING.note + 14}`}
      />

      {/* ── Droplets — real entities, moved only by real events ── */}
      <g className="hero-droplets">
        {state.droplets.map((d) => {
          const { x, y } = dropletPoint(state, d);
          return (
            <g
              className="hero-droplet"
              key={d.issue}
              data-issue={d.issue}
              data-at={d.at}
              data-failed={d.failed ? "true" : "false"}
              data-lane={d.lane ?? ""}
              transform={`translate(${x} ${y})`}
            >
              <circle r={9} style={{ fill: dropletFill(d) }} />
              <text className="hero-num hero-small" x={0} y={-14} textAnchor="middle">
                {d.at === "trunk" ? "✓ " : ""}
                {d.pr === null ? `⊙ ${d.issue}` : `⤳ ${d.pr}`}
              </text>
              {d.failed && (
                <text className="hero-mark" x={0} y={4} textAnchor="middle">
                  ✕
                </text>
              )}
              {d.handedOff && (
                <text className="hero-small hero-badge" x={0} y={24} textAnchor="middle">
                  saved for a successor
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * Radii for the cross-section, outermost = newest.
 *
 * ponytail: capped at TRUNK.max drawn rings — the count text is the real record, and a disc
 * of 400 hairlines is a grey blob. Lift the cap only if the disc ever needs to be exact.
 */
function ringRadii(rings: number): number[] {
  const drawn = Math.min(rings, TRUNK.max);
  return Array.from({ length: drawn }, (_, i) => (drawn - i) * TRUNK.step).reverse();
}
