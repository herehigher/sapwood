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
import { readConfigPath } from "../config-captions.ts";
import { activePlanningNode, activeReflectionNode, type Droplet, type DropletAt, type HeroState, withVisibleLanes } from "./state.ts";

// ── Geometry ──────────────────────────────────────────────────────────────────
// One coordinate space, shared with Hero.tsx's timelines so travel always lands where
// the next render draws.

export const STAGE = { w: 1200, h: 380 } as const;

// The backlog sits in from the left edge so the "saved for a successor" badge — the widest
// thing that hangs off a droplet — still fits inside the viewBox.
// #716 gate② round 2 PO probe P3: chip step bumped 22 → 26 — labels like "⊙ 725" stacked at
// the old 22px step were measured colliding with the next chip's label at small render sizes.
export const BACKLOG = { x: 46, y: 62, w: 96, chip: 26 } as const;
/** `note` clears the tallest lane stack (`lanes.max` 6) rather than sitting under 3 lanes. */
const PLANNING = { x: 224, note: 300, noteX: 152 } as const;
/** §7: plain word first, internal term never. `role` is the config-captions.ts `roles.<role>`
 *  path (#716 gate② P2-8's model·effort caption) — never worker.* (that's the lanes zone). */
const PLANNING_NODES = [
  {
    node: "goal-align" as const,
    y: 96,
    label: "Goal & align",
    hint: "Decides what's worth doing this round and files it as issues",
    role: "roles.po",
  },
  {
    node: "arch-review" as const,
    y: 158,
    label: "Arch review",
    hint: "Checks the round's plans fit the architecture before work starts",
    role: "roles.architect",
  },
  {
    node: "verify" as const,
    y: 220,
    label: "Verify",
    hint: "An independent review approves each plan — including how it will be verified — before any code is written",
    role: "roles.verificationPlanReviewer",
  },
] as const;
const LANES = { x: 330, w: 372, top: 92, gap: 44 } as const;
const GATES = { ci: 762, review: 858, y: 156 } as const;
export const ESCALATION = { x: 810, y: 320 } as const;
/**
 * #728 gate② finding [0]: caps the cluster's rightward spread so it stays clear of the trunk
 * rings (leftmost extent `TRUNK.x - TRUNK.max * TRUNK.step` = 922) AND the OUTCOME tally
 * text's actual rendered extent (not just its anchor point) — a wide escalation list wraps
 * into a new row (upward, away from the ESCALATION node) instead of running into either.
 *
 * All three numbers below come from `hero.test.ts`'s bounding-box check, not a guess:
 * - 2 columns, not 3: a droplet's own label ("⤳ 9999") has real rendered width — 3 columns'
 *   worth of that width crosses the tally's actual left edge once its string grows past a
 *   couple of digits per number, even though the 3rd column's own bare X coordinate looked
 *   clear.
 * - 38px column step: below a label's own worst-case rendered width, adjacent same-row
 *   droplets' labels would overlap EACH OTHER, independent of the tally/rings entirely.
 * - 34px row step: below a droplet's label-top-to-circle-bottom span, consecutive rows'
 *   droplets would overlap each other the same way.
 *
 * ponytail: verified collision-free up to 6 simultaneously escalated droplets (3 rows) —
 * the 4th row would reach the CI/REVIEW gates above. No live probe has reported anywhere near
 * that many at once; revisit (spill sideways past the gates, or cap+overflow-badge) if one
 * does.
 */
const NEEDS_HUMAN_COLS = 2;
const NEEDS_HUMAN_COL_STEP = 38;
const NEEDS_HUMAN_ROW_STEP = 34;
export const TRUNK = { x: 1006, y: 156, step: 7, max: 12 } as const;
const REFLECTION = { x: 1118, bottom: 244 } as const;
const REFLECTION_NODES = [
  { node: "summary" as const, y: 110, label: "Summary", role: "roles.harvest" },
  { node: "retro" as const, y: 200, label: "Retro", role: "roles.retro" },
] as const;

const laneY = (index: number) => LANES.top + index * LANES.gap;

/**
 * The channel a droplet belongs to. `withVisibleLanes` (state.ts, #716 gate② round 2 P1-1)
 * already drops any `at === "lane"` droplet whose lane was cut from the capped view before
 * this ever runs, so the `?? 0` fallback is defensive only — never remap a droplet whose real
 * lane is genuinely gone onto whatever else happens to draw at channel 0.
 */
const laneIndex = (state: HeroState, d: Droplet) => state.lanes.find((l) => l.worker === d.lane)?.channel ?? 0;

/**
 * Where a droplet sits, in stage coordinates. The single source for both draw and travel.
 *
 * `at` defaults to where the droplet actually is; pass a zone to get the same droplet's
 * coordinates somewhere else — that is how a first-seen droplet gets a travel origin
 * (`transitionOrigin`) instead of animating from its own destination.
 *
 * `state.lanes` must already be the CAPPED, renumbered view (`withVisibleLanes` in
 * `state.ts`, #716 gate② P1-9) — this function trusts `state.lanes`' `channel` values as
 * the real, drawn track index, so callers own applying the cap before this ever sees state.
 */
export function dropletPoint(state: HeroState, d: Droplet, at: DropletAt = d.at): { x: number; y: number } {
  switch (at) {
    case "backlog": {
      // #728 gate② finding [0]: shares ONE vertical counter with the pool chips drawn in the
      // same narrow column (stage.tsx's `state.pool.map`) — a backlog droplet's row starts
      // only after every pool chip's own row, so the two lists can never land on the same
      // slot. A handed-off droplet carries a second line (the "saved for a successor" badge,
      // by far the widest/tallest text this column ever draws), so it claims THREE rows'
      // worth of room — `hero.test.ts`'s bounding-box check is what set this number: two rows
      // left only a few px of clearance between the badge and the next label.
      const backlogDroplets = state.droplets.filter((o) => o.at === "backlog");
      let slot = state.pool.length;
      for (const o of backlogDroplets) {
        if (o.issue === d.issue) break;
        slot += o.handedOff ? 3 : 1;
      }
      return { x: BACKLOG.x + BACKLOG.w / 2, y: BACKLOG.y + 30 + slot * BACKLOG.chip };
    }
    case "lane":
      return { x: LANES.x + LANES.w * 0.55, y: laneY(laneIndex(state, d)) };
    case "checkpoint":
      return { x: (GATES.ci + GATES.review) / 2, y: GATES.y - 46 };
    case "needs-human": {
      // #728: wraps after NEEDS_HUMAN_COLS instead of spreading rightward without limit — an
      // unbounded row used to run the cluster straight into the trunk rings and the OUTCOME
      // tally text once several issues escalated at once.
      const rank = Math.max(
        0,
        state.droplets.filter((o) => o.at === "needs-human").findIndex((o) => o.issue === d.issue),
      );
      const col = rank % NEEDS_HUMAN_COLS;
      const row = Math.floor(rank / NEEDS_HUMAN_COLS);
      return { x: ESCALATION.x + col * NEEDS_HUMAN_COL_STEP, y: ESCALATION.y - 30 - row * NEEDS_HUMAN_ROW_STEP };
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
  /** `lanes.max` — caps the drawn tracks to the CONFIGURED slot count (#716 gate② P1-9);
   *  `null` draws whatever `state.lanes` already carries (the fold's own "unknown" placeholder). */
  lanesMax: number | null;
  /** `lanes.prFixCap` — the stage renders "round n of cap", the fold only knows n. */
  fixCap: number;
  /** Live round-phase cursor (`/api/loop/state`'s `round.phase`); null when no round is open. */
  roundPhase?: string | null;
  /** §6: ceiling breach / PAUSE / kill switch. Computed by `isStageDimmed`. */
  dimmed?: boolean;
  /** Drives the CSS ambient shimmer off; the travel/stroke half is `Hero.tsx`'s job. */
  reducedMotion?: boolean;
  /** Allowlisted config (§3 E's subset), for the model·effort captions §6 documents on the
   *  LLM-backed nodes (planning trio, lanes, SUMMARY, RETRO) and REVIEW's mode word. `null`/
   *  absent draws no captions — an honest gap, never a guessed model name (#716 gate② P2-8). */
  config?: Record<string, unknown> | null;
  /** Test-injectable clock for the staleness caption (#716 gate② P2-8) — defaults to the real
   *  clock; never a real timer inside this component (repo bans timing-dependent tests). */
  now?: Date;
  ref?: Ref<SVGSVGElement>;
};

/** `roles.<role>.model`/`.effort`, or top-level `worker.model`/`.effort` when `rolePath` is
 *  already the leaf ("worker") — §3 C's mono `model · effort` caption, config-sourced only,
 *  never a live telemetry guess. `null` when the config doesn't name a model (honest gap). */
function modelEffortCaption(config: Record<string, unknown> | null | undefined, rolePath: string): string | null {
  if (!config) return null;
  const model = readConfigPath(config, `${rolePath}.model`);
  if (typeof model !== "string") return null;
  const effort = readConfigPath(config, `${rolePath}.effort`);
  return typeof effort === "string" ? `${model} · ${effort}` : model;
}

/** §6: "how long since anything happened" — the OUTCOME zone's staleness caption. Whole
 *  seconds, floored; a future/unparseable timestamp (clock skew) reads as "just now" rather
 *  than a negative or NaN caption. */
function stalenessCaption(lastEventTs: string | null, now: Date): string | null {
  if (lastEventTs === null) return null;
  const ts = Date.parse(lastEventTs);
  if (Number.isNaN(ts)) return null;
  const secs = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  return `last event ${secs}s ago`;
}

export function HeroStage({
  state: rawState,
  lanesMax,
  fixCap,
  roundPhase = null,
  dimmed = false,
  reducedMotion = false,
  config = null,
  now,
  ref,
}: HeroStageProps) {
  // #716 gate② P1-9: every downstream position/render computation reads the CAPPED,
  // renumbered lane view — never `rawState.lanes` directly — so a droplet's channel lookup
  // and the DOM row it actually lands in can never disagree.
  const state = withVisibleLanes(rawState, lanesMax);
  const clock = now ?? new Date();
  const waiting = state.droplets.some((d) => d.at === "checkpoint");
  const gateState = waiting ? "waiting" : "idle";
  const escalated = state.droplets.filter((d) => d.at === "needs-human").length;
  const anyRunning = state.lanes.some((l) => l.phase === "writing" || l.phase === "fixing");
  const activePlanning = activePlanningNode(roundPhase);
  const activeReflection = activeReflectionNode(roundPhase);
  const staleness = stalenessCaption(state.lastEventTs, clock);
  const reviewMode = config ? readConfigPath(config, "reviewer.mode") : undefined;
  // §6: "N merged · N pending · N needs human" — merged is THIS round's tally (never the
  // all-time ring count); pending/needs-human are the droplets currently in each state.
  const pendingCount = state.droplets.filter((d) => d.at === "backlog" || d.at === "lane" || d.at === "checkpoint").length;
  const outcomeTally = `${state.roundMerged} merged · ${pendingCount} pending · ${escalated} needs human`;
  // #716 gate② round 2 P2-5: the fix-return arrow's own label (§6: "labeled with the send-back
  // reason") — the first currently-fixing lane, in channel order.
  const fixingReason = state.lanes.find((l) => l.phase === "fixing")?.reason ?? null;

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
        {PLANNING_NODES.map((n) => {
          const caption = modelEffortCaption(config, n.role);
          return (
            <g key={n.node} data-active={activePlanning === n.node ? "true" : "false"}>
              <title>{n.hint}</title>
              <circle className="hero-planning-node" cx={PLANNING.x} cy={n.y} r={17} />
              <text className="hero-node-label" x={PLANNING.x + 28} y={n.y + 4}>
                {n.label}
              </text>
              {caption && (
                <text className="hero-node-caption" x={PLANNING.x + 28} y={n.y + 17}>
                  {caption}
                </text>
              )}
            </g>
          );
        })}
        {staleness && (
          <text className="hero-label hero-staleness" x={PLANNING.noteX} y={PLANNING.note}>
            {staleness}
          </text>
        )}
      </g>

      {/* ── Zone 3: work lanes, checkpoints, fix loop, escalation branch ── */}
      <g className="hero-lanes">
        {(() => {
          const laneCaption = modelEffortCaption(config, "worker");
          return state.lanes.map((lane) => (
            <g
              className="hero-lane"
              key={lane.channel}
              data-lane-index={lane.channel}
              data-phase={lane.phase}
              data-issue={lane.issue ?? ""}
            >
              <line className="hero-channel" x1={LANES.x} y1={laneY(lane.channel)} x2={LANES.x + LANES.w} y2={laneY(lane.channel)} />
              <text className="hero-node-label" x={LANES.x} y={laneY(lane.channel) - 10}>
                {/* #716 gate② P1-9 (PO live probe, baseline + §6): the primary label is the
                 * plain slot name `w{n}`, not the generic "Work lane N" this rendered before. */}
                {state.laneCountUnknown ? "lane count unknown — config unreadable" : `w${lane.channel + 1}`}
              </text>
              {laneCaption && !state.laneCountUnknown && (
                <text className="hero-num hero-small hero-node-caption" x={LANES.x} y={laneY(lane.channel) + 12}>
                  {laneCaption}
                </text>
              )}
              {lane.worker && !state.laneCountUnknown && (
                // #744: the FIXING phrase is long enough to run under the PR-bearing droplet's
                // own label (which sits just above the channel line, `y - 14`, fixed regardless
                // of phase) — drop it below the line instead of fighting for the same strip a
                // short worker name safely shares with that label.
                <text
                  className="hero-num hero-small"
                  x={LANES.x + LANES.w}
                  y={laneY(lane.channel) + (lane.phase === "fixing" ? 14 : -10)}
                  textAnchor="end"
                >
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
          ));
        })()}

        {/* The fix loop, drawn as the engine's true shape: back into the lane itself.
         * #728: mounted only while a lane is actually fixing — an unlabeled arc left drawn
         * after the fix loop ends read as stray, unexplained stage furniture. */}
        {fixingReason && (
          <>
            <path
              id="hero-fixloop-path"
              className="hero-fixloop"
              d={`M ${GATES.ci - 30} ${GATES.y + 26} C ${640} ${GATES.y + 78}, ${430} ${GATES.y + 78}, ${LANES.x + 40} ${laneY(0) + 12}`}
            />
            {/* #716 gate② round 2 P2-5: the AC wants the send-back reason word ON the return
             * arrow itself, via textPath — the per-lane caption flash (above) narrates WHICH
             * lane, this narrates WHAT the loop is doing. One shared path draws one label; when
             * several lanes are fixing at once, the first (channel order) wins rather than
             * concatenating an ambiguous list. */}
            <text className="hero-fixloop-label">
              <textPath href="#hero-fixloop-path" startOffset="50%" textAnchor="middle">
                {fixingReason}
              </textPath>
            </text>
          </>
        )}
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
          {/* #716 gate② P2-5: the merged flash used to be a border-color change ONLY
           * (`.hero-gate.is-merged rect`) — a real ✓ glyph is the non-color-carried channel
           * this file's own §5 doctrine requires; shown via CSS opacity keyed off `.is-merged`
           * (Hero.tsx toggles that class), never a second render path. */}
          <text className="hero-gate-check" x={GATES.ci + 24} y={GATES.y - 8} textAnchor="middle">
            ✓
          </text>
        </g>
        <g className="hero-gate" data-gate="review" data-state={gateState}>
          <rect x={GATES.review - 42} y={GATES.y - 20} width={84} height={40} rx={6} />
          <text className="hero-node-label" x={GATES.review} y={GATES.y + 5} textAnchor="middle">
            Review
          </text>
          <text className="hero-gate-check" x={GATES.review + 32} y={GATES.y - 8} textAnchor="middle">
            ✓
          </text>
          {/* §6: REVIEW carries the review MODE word (e.g. "codex"), not a model·effort pair —
           * it isn't itself model-backed, the mode just names which reviewer runs. */}
          {typeof reviewMode === "string" && (
            <text className="hero-node-caption" x={GATES.review} y={GATES.y + 18} textAnchor="middle">
              {reviewMode}
            </text>
          )}
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
          // #716 gate② round 2 P1-3: each drawn ring's real 1-indexed ring NUMBER (not its
          // draw-order index, which resets every time older rings age out past TRUNK.max) —
          // lets `Hero.tsx` target the ring a specific `merged` transition actually produced
          // (`transition.ring`) instead of always hitting the sole `data-current="true"` one,
          // which two non-coalesced merges in one poll both animated onto the same circle.
          const ringNumber = state.rings - all.length + 1 + i;
          return (
            <circle
              className="hero-ring"
              key={r}
              cx={TRUNK.x}
              cy={TRUNK.y}
              r={r}
              data-current={current ? "true" : "false"}
              data-ring={ringNumber}
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
        {/* §6: "the round's outcome tally (N merged · N pending · N needs human) — small
         * numbers, never repeating the all-time ring count." `roundMerged` is the round-
         * scoped counter (#716 gate② P2-8); `state.rings` above stays the all-time one.
         * #716 gate② round 2 PO probe P3: shifted left of TRUNK.x (was centered ON it) — the
         * live probe measured double-digit counts clipping past the STAGE.w right edge. */}
        <text className="hero-num hero-small hero-outcome-tally" x={TRUNK.x - 30} y={TRUNK.y + 140} textAnchor="middle">
          {outcomeTally}
        </text>
      </g>

      <g className="hero-reflection" data-node="reflection">
        {REFLECTION_NODES.map((n) => {
          const caption = modelEffortCaption(config, n.role);
          return (
            <g key={n.node} data-active={activeReflection === n.node ? "true" : "false"}>
              <circle className="hero-planning-node" cx={REFLECTION.x} cy={n.y} r={13} />
              <text className="hero-node-label" x={REFLECTION.x} y={n.y + 30} textAnchor="middle">
                {n.label}
              </text>
              {caption && (
                <text className="hero-node-caption" x={REFLECTION.x} y={n.y + 43} textAnchor="middle">
                  {caption}
                </text>
              )}
            </g>
          );
        })}
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
