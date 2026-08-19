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

import { ChartNoAxesColumn, Check, Eye, GitFork, Sprout, Target, TrendingUp, UserRound } from "lucide-react";
import type { ComponentType, KeyboardEvent, Ref } from "react";
import { GithubActionsGlyph } from "../components/icons.tsx";
import { readConfigPath } from "../config-captions.ts";
import { CI_CAPTION } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import { formatRelativeTime } from "../format-time.ts";
import type { StageNode } from "../inspector.ts";
import {
  activePlanningNode,
  activeReflectionNode,
  type Droplet,
  type DropletAt,
  ESCALATION_KINDS,
  type HeroState,
  isPendingConfident,
  withVisibleLanes,
} from "./state.ts";

/**
 * §6 phase inspector (#861): the accessible-activation props for one clickable stage node —
 * `role="button"`/`tabIndex` (an SVG `<g>` isn't natively focusable/operable) plus a real
 * `onKeyDown` for Enter/Space, mirroring `Controls.tsx`'s own keyboard-activation posture for
 * its non-native-button controls. Returns `{}` (no affordance at all) when the caller passes no
 * `onInspect` — the stage still renders identically with the inspector feature entirely absent.
 */
function inspectProps(node: StageNode, label: string, onInspect?: ((node: StageNode) => void) | undefined) {
  if (!onInspect) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: () => onInspect(node),
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onInspect(node);
    },
  };
}

/**
 * #920 gate② review thread (PRRT…FAN): a real Playwright regression — clicking an inspectable
 * node targets the CENTRE of its `<g>`'s own bounding box, which for a circle plus an
 * offset-beside (planning trio) or offset-below/-above (CI/Review) label routinely lands in the
 * unpainted gap between them once `PLANNING_NODE_R`/`GATES.r` grew: nothing is drawn there, so
 * the hit resolves to the bare `<svg>` and the click never reaches the node's own handler — the
 * same gap a real mouse click into that space would miss. Drawn FIRST inside the node's `<g>` (so
 * every other child paints over it), transparent but hit-testable — widens the actual clickable
 * region to the node's full visual footprint (circle + label + caption) instead of just the
 * circle.
 */
function hitTarget(x: number, y: number, width: number, height: number) {
  return <rect className="hero-hit-target" x={x} y={y} width={width} height={height} fill="transparent" pointerEvents="all" />;
}

// ── Geometry ──────────────────────────────────────────────────────────────────
// One coordinate space, shared with Hero.tsx's timelines so travel always lands where
// the next render draws.

// #920: re-based from 1200×380 (3.16:1) to 1200×515 (2.33:1) — the mockup's own band ratio.
// The old ratio was what forced every node/lane to draw at 40-60% of mockup scale; height alone
// grows (width stays 1200, every x constant below is untouched) and the extra room is spent on
// bigger nodes (`PLANNING_NODE_R`/`GATES.r`) and a taller OUTCOME column (trunk + reflection).
export const STAGE = { w: 1200, h: 515 } as const;

/** PLAN/IMPLEMENT/OUTCOME phase-caption x's — exported so the zone dividers (below) and their
 *  own test can read the SAME boundary anchors this file draws against, never a copied literal. */
export const PHASE_X = { plan: 176, implement: 620, outcome: 1030 } as const;
/** #920 AC5: two dashed zone dividers, PLAN|IMPLEMENT and IMPLEMENT|OUTCOME — chosen clear of the
 *  planning trio's circles/GATES.review's own circle (the two nearest neighbours on each side)
 *  rather than the phase captions' own midpoints, so the (thin, low-opacity) guide lines never
 *  cut through the zones' own primary shapes. */
/** #920 gate② review thread (PRRT…JE9): 280 sat INSIDE the planning trio's own label box (the
 *  widest label, "Goal & align" at `PLANNING_NODE_R`'s wider 12px-font offset, runs to x≈357) —
 *  366 clears it with margin, still strictly between `PHASE_X.plan`/`PHASE_X.implement`. */
export const ZONE_DIVIDERS = [366, 905] as const;

// The backlog sits in from the left edge so the "saved for a successor" badge — the widest
// thing that hangs off a droplet — still fits inside the viewBox.
// #716 gate② round 2 PO probe P3: chip step bumped 22 → 26 — labels like "⊙ 725" stacked at
// the old 22px step were measured colliding with the next chip's label at small render sizes.
// #879: bumped 26 → 32 — the frozen baseline draws the ready backlog as filled CARDS, not a
// thin list; a taller step is what gives the card rect (below) room to read as a card.
// #922 AC3: bumped 32 → 40 — the card rect itself grew 24 → 32 (the AC's own height floor), and a
// step equal to the rect's own height left zero gap between consecutive cards.
export const BACKLOG = { x: 46, y: 62, w: 96, chip: 40 } as const;
/** #922 AC3: the chip rect's own height — the AC's own ≥ 32 stage-px-equivalent floor. */
export const BACKLOG_CHIP_H = 32;
/**
 * #897 AC4: only the FRONT of the ready pool draws as filled cards — the frozen baseline's
 * "about to be worked" emphasis — the rest draws as outlined candidate cards below them (same
 * "cap what's emphasized" grammar `NEEDS_HUMAN_DRAW_CAP`/`CHECKPOINT_DRAW_CAP` already use).
 * 3 matches the baseline's own filled-card count.
 */
const BACKLOG_FILLED_CAP = 3;
/** #922 AC3: candidates beyond this many collapse into a single "…" chip instead of growing the
 *  column without limit — same "cap what's drawn, keep the true count elsewhere" grammar every
 *  other bounded cluster on this stage already uses (`NEEDS_HUMAN_DRAW_CAP`'s own doc). */
const BACKLOG_CANDIDATE_DRAW_CAP = 5;
/** `note` sits below the planning trio's own lowest content (`verify`'s caption) — #920 grew the
 *  trio's own vertical spread, so it no longer needs to independently clear the lane stack too;
 *  `LANES.top`'s own span (up to `lanes.max` 6) sits well above this y regardless. */
export const PLANNING = { x: 224, note: 430, noteX: 152 } as const;
/** #920 AC2: ≥ 30 stage units (≥ 60 px at 1440 rendered width) — the planning trio's own circle
 *  radius, exported so `hero.test.ts` reads it directly rather than a copied literal. */
export const PLANNING_NODE_R = 30;
/**
 * #922 AC1/AC7: the one below-circle label/caption offset every node type on the stage shares —
 * planning trio, both gates, the escalation node (REFLECTION_NODES keep their own pre-existing
 * r+12/r+24, already the same 12px label-to-caption gap this pair encodes). AC7 requires REVIEW's
 * caption sit "the same style/offset as the planning nodes' captions" — a shared constant is what
 * makes that true by construction rather than by two authors independently picking the same
 * number.
 */
export const NODE_LABEL_OFFSET = 16;
export const NODE_CAPTION_OFFSET = 28;
/** §7: plain word first, internal term never. `role` is the config-captions.ts `roles.<role>`
 *  path (#716 gate② P2-8's model·effort caption) — never worker.* (that's the lanes zone).
 *  #920: y-spacing widened (96/158/220 → 62px apart) to (140/250/360 → 110px apart) — two
 *  circles at the old spacing would now overlap by 2 units once `PLANNING_NODE_R` grew past 30,
 *  since 62 < 2 × 30. 110 clears `2 × PLANNING_NODE_R` with comfortable margin either side. */
const PLANNING_NODES = [
  {
    node: "goal-align" as const,
    y: 140,
    label: "Goal & align",
    hint: "Decides what's worth doing this round and files it as issues",
    role: "roles.po",
  },
  {
    node: "arch-review" as const,
    y: 250,
    label: "Arch review",
    hint: "Checks the round's plans fit the architecture before work starts",
    role: "roles.architect",
  },
  {
    node: "verify" as const,
    y: 360,
    label: "Verify",
    hint: "An independent review approves each plan — including how it will be verified — before any code is written",
    role: "roles.verificationPlanReviewer",
  },
] as const;
/**
 * Exported so `hero.test.ts` (#920 AC3) derives a channel's own terminal/row coordinates from
 * this constant + `laneY`'s own arithmetic, never a copied literal.
 *
 * #920 gate② review thread (PRRT…JE9): `x` moved 330 → 380 — the planning trio's own widest
 * label ("Goal & align", ending ≈357 at `PLANNING_NODE_R`'s wider offset) ran straight into the
 * lane label at the old 330, reading as "Goal & aligw1" in a live crop. `w` shrank 372 → 320 to
 * keep the channel's own end terminal comfortably short of the CI node's circle (`GATES.ci -
 * GATES.r` = 732) rather than growing into it now that `x` moved right by the same 50 units.
 */
export const LANES = { x: 380, w: 320, top: 150, gap: 44 } as const;
/**
 * #920 AC3: the small hollow-circle terminal drawn at BOTH ends of every lane channel.
 * #1026: exported — `FIXLOOP_ENTRY_X` (below) derives the fix-loop return path's own entry
 * point off this same constant rather than a copied literal.
 */
export const LANE_TERMINAL_R = 4;
/**
 * #897: `r` is new — the frozen baseline draws CI/Review as large circular gate nodes (with a
 * hand-drawn gear/eye glyph inside, `gateIcon` below), not the small rects this stage used to
 * draw. 20 keeps the circle's right edge (`GATES.review + r` = 878) well inside the same
 * clearance the old rect already held against the trunk rings' leftmost reach — margin only
 * grows (was 22px at the old rect's 900 edge, now 44px). #921: the disc's real leftmost reach is
 * now the FIXED `TRUNK_DISC_R_MAX` footprint ceiling, not `TRUNK.max * TRUNK.step` (that stopped
 * being the disc's true reach once pitch could compress) — `TRUNK.x - TRUNK_DISC_R_MAX` = 903,
 * still clear of `GATES.review + r` (888) by 15px at the CURRENT `r` = 30.
 *
 * #897: `r` shrank from an earlier 26 specifically to make room for the "CI"/"Review" word BELOW
 * the circle without reaching the needs-human cluster's own fixed ceiling (rank 5's droplet label top,
 * `ESCALATION.y - NEEDS_HUMAN_BASE_OFFSET - 2 * NEEDS_HUMAN_ROW_STEP - DROPLET_LABEL_FONT_PX`,
 * re-verified by this file's own stress tests whenever either constant moves) — the cluster's
 * own row cap (`NEEDS_HUMAN_DRAW_CAP`'s doc) was tuned against the OLD rect geometry, which drew
 * no text below itself at all; this stage's own below-circle label is what newly competes for
 * that space. The review-mode caption moved ABOVE the circle instead of stacking a second line
 * below it — there was no room below for two lines regardless of `r` (worked the algebra: even
 * at `r` = 15 the two-line channel between the circle and the cluster's ceiling has no valid Y
 * range for both a 12px label and a 9px caption with real margins). Above the circle, the gap
 * between the checkpoint grid's own closest row (`CHECKPOINT_BASE_OFFSET`, topmost content
 * bottom ≈ 105) and the circle top (`GATES.y - r`) is 31px — comfortable room `hero.test.ts`'s
 * own collision test verifies against the fixture that actually mounts both clusters at once.
 *
 * #920 AC2: `r` grew 20 → 30 (≥ 30 stage units, the AC's own floor) to close the mockup's own
 * node-scale gap; `y` moved 156 → 190 and `ESCALATION.y`/`CHECKPOINT_BASE_OFFSET` (below) moved
 * with it — `STAGE.h`'s own growth (380 → 515) is what bought the extra headroom this larger
 * circle needs above it (the checkpoint grid) and below it (the needs-human cluster) without
 * re-tuning either cluster's own column/row geometry.
 */
export const GATES = { ci: 762, review: 858, y: 190, r: 30 } as const;
export const ESCALATION = { x: 810, y: 460 } as const;
/** #922 AC4: grown from the old bare 13px circle to fit a person glyph — matches
 *  `REFLECTION_R`, the stage's other small icon-bearing node. */
export const ESCALATION_R = 16;
/**
 * #1026 (PO ruling, dogfood round 431 live review): the fix-loop return path's own exit off the
 * CI node — the LOWER-RIGHT rim point, 45° off centre. The lower-left rim (the first #1026 cut)
 * sits ~4px from where W3's own curved connector (`laneCiConnector`) lands on the CI circle —
 * the two visibly overlapped. The bottom pole (`GATES.ci`, `GATES.y + GATES.r`) fares no
 * better: W3's connector curve crosses it too, close to its own end terminal. Lower-right is
 * clear of every lane's incoming arm; the nearest neighbour is the NEEDS HUMAN escalation stem
 * (`ESCALATION.x` = `(GATES.ci + GATES.review) / 2` = 810), ~27px further right.
 */
export const FIXLOOP_EXIT = { x: GATES.ci + GATES.r * Math.SQRT1_2, y: GATES.y + GATES.r * Math.SQRT1_2 } as const;
/**
 * #1026: the fix-loop return path's own arm — where its horizontal run turns to approach the
 * lanes from the LEFT, then ticks right into whichever lane is fixing. Sits in the dead strip
 * between the PLAN|IMPLEMENT zone divider (`ZONE_DIVIDERS[0]` = 366) and the lane start
 * terminals (`LANES.x` = 380, terminal circles spanning `LANES.x ± LANE_TERMINAL_R`) — nothing
 * else draws there.
 */
export const FIXLOOP_ARM_X = LANES.x - 8;
/**
 * #1026: the return path's final tick lands here — 1px shy of a lane's own start terminal's
 * left edge (`LANES.x - LANE_TERMINAL_R`), so the arrowhead (`markerEnd`) points rightward INTO
 * the terminal rather than overlapping its own stroke.
 */
export const FIXLOOP_ENTRY_X = LANES.x - LANE_TERMINAL_R - 1;
/**
 * #1026: a fixing lane's own `FIXING · round N of M` caption's y-offset below its channel
 * line — the deepest text a lane draws (below `.hero-node-caption`'s own `+12`). Named so both
 * the caption's own render (below) and the fix-loop row's clearance (`FIXLOOP_RETURN_DY`) read
 * the SAME number rather than risking two hand-copied `14`s drifting apart.
 */
export const LANE_FIXING_CAPTION_DY = 14;
/**
 * #1026 (PO ruling, dogfood round 431 live review): how far below the LAST lane's own channel
 * line the fix-loop return path's shared horizontal row sits. Every fixing lane's path uses this
 * SAME row (`fixLoopPath` below) — never a per-lane offset — so the row sits under the bottom-
 * most lane on the stage, clearing every lane's captions by construction (a lower lane's row
 * clears a higher lane's text just by being further down the page). It still has to clear the
 * LAST lane's own captions, so the offset is that lane's deepest caption
 * (`LANE_FIXING_CAPTION_DY`) plus 10px of real clearance below it.
 */
export const FIXLOOP_RETURN_DY = LANE_FIXING_CAPTION_DY + 10;
/**
 * #728 gate② finding [0]: caps the cluster's rightward spread so it stays clear of the trunk
 * rings (leftmost extent `TRUNK.x - TRUNK_DISC_R_MAX` = 903, #921 — the disc's real fixed
 * ceiling, not `TRUNK.max * TRUNK.step`) AND the OUTCOME tally text's actual rendered extent
 * (not just its anchor point) — a wide escalation list wraps into a new row (upward, away from
 * the ESCALATION node) instead of running into either.
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
 * Verified collision-free up to 6 simultaneously DRAWN escalated droplets (3 rows) — the 4th
 * row would reach the CI/REVIEW gates above. #891 (a live DB's real scale DID eventually report
 * more than that) is the revisit this file's own ponytail note flagged: `NEEDS_HUMAN_DRAW_CAP`
 * below caps what actually draws at this verified-safe ceiling, folding the rest into
 * `boundAttentionDroplets`'s collapsed counter chip instead of growing the grid further.
 */
const NEEDS_HUMAN_COLS = 2;
/** #922 AC2: widened from 38/34 — `dropletRadius`'s own floor grew 9 → 9.8 (and grows further for
 *  a droplet with a longer number), so the old step no longer clears the same margin between
 *  adjacent droplet bodies. Kept proportionally generous (step − 2 × footprint ≈ the old margin).
 *  Column width is a true 2r (the shape's own x-range is exactly [-r, r]), so COL_STEP's own
 *  margin against 2 × DROPLET_MAX_R holds: `DROPLET_MAX_R` is 22 (that constant's own doc), so
 *  2 × 22 = 44 — a real, if narrower, margin under 46. Row HEIGHT is not 2r —
 *  `dropletPath`'s own tip/belly extend to 9r/7 each way (≈2.571r total, gate② finding [0]'s own
 *  "moving the text/shrinking the path can leave it green" catch, surfaced once the collision
 *  oracle read the REAL rendered path instead of a circleBox stand-in) — ROW_STEP is sized against
 *  that true height at the worst-case DROPLET_MAX_R (2.571 × 22 ≈ 56.6), not the old (too-small)
 *  2r guess; 66 keeps a real ~9.4px margin over it. */
const NEEDS_HUMAN_COL_STEP = 46;
const NEEDS_HUMAN_ROW_STEP = 66;
/**
 * gate② finding [1] (ac2-escalation-overlap): the rank-0 droplet's own vertical offset from
 * `ESCALATION.y` — was a bare inline `30`, which at the worst-case `DROPLET_MAX_R` let the
 * droplet's own bottom edge (`y + r * 9/7`) reach INSIDE the escalation circle (top edge
 * `ESCALATION.y - ESCALATION_R` = 444) instead of clearing it. 56 keeps the worst-case droplet's
 * bottom edge (`ESCALATION.y - 56 + r * 9/7`, ≈ 432.3 at `DROPLET_MAX_R`'s own 22) a real
 * ~11.7px above the circle's own top edge.
 */
const NEEDS_HUMAN_BASE_OFFSET = 56;
/** #891 AC1: never draw more than this many needs-human droplets at once — see the doc above
 *  this cluster's own geometry constants for why 6 (2 cols × 3 rows) is the verified ceiling. */
const NEEDS_HUMAN_DRAW_CAP = NEEDS_HUMAN_COLS * 3;
/**
 * #745 gate② round 2 finding [1]: EVERY simultaneously-`at: "checkpoint"` droplet used to draw
 * at one fixed point — unlike `backlog` (slot counter) and `needs-human` (this same col/row
 * grid), `checkpoint` had no per-droplet offset at all. Two PRs out for review at once is the
 * normal steady state, not an edge case, so this collided on the most common path — the exact
 * "N chips staged at ONE coordinate" shape #745 reports. Same COLS/STEP magnitudes as
 * NEEDS_HUMAN — same droplet number/kind-mark rendering, same verified-safe sizing;
 * grows UPWARD (away from the CI/Review gates below), the same direction NEEDS_HUMAN grows away
 * from its own anchor.
 *
 * #745 gate② round 4 finding [0]: an UNBOUNDED grid converts the reported pileup into a WORSE
 * failure — rank ≥ 6 draws above the viewBox (y ≤ 8, a 9px-radius circle's top already
 * negative), i.e. silently clipped, invisible work, exactly the failure mode this issue exists
 * to kill. `CHECKPOINT_ROWS_MAX` caps the grid at its own previously-verified-safe 3 rows
 * (`CHECKPOINT_DRAW_CAP` slots, no badge needed); once more droplets than that are
 * simultaneously parked, only `CHECKPOINT_OVERFLOW_REAL_CAP` real chips draw — one row short of
 * the grid's capacity — and the whole LAST row is spent on a single "+N more" badge instead of
 * growing the grid further, the same "cap the drawn count, keep the true number in a small
 * separate readout" mechanism `TRUNK.max` already uses for the ring cross-section (`ringRadii`
 * below). The badge takes its OWN row rather than sharing the last real row (a droplet's label
 * and the badge's own are both wide enough to collide by rendered text width sharing one row —
 * caught by this file's own bbox test, not a guess). Never above-viewBox growth, never silent
 * clipping. Verified collision-free AND in-bounds up to 39 simultaneous checkpoint droplets —
 * the scale #745's own probe actually reported.
 *
 * #745 gate② round 5 PO pre-merge Tier-C probe (1700px, live DB): despite the above, a drawn
 * checkpoint chip's label still bbox-intersected the Review gate's own "engine-agent" mode
 * caption. `CHECKPOINT_BASE_OFFSET` (was a bare `-46` inline) widens the gap between the
 * grid's row 0 (closest to the gates) and the gate row itself; paired with pushing the
 * caption further down (stage.tsx's REVIEW node caption `y`) — the cheap half on each side.
 * `hero.test.ts`'s own gate-cluster bbox check (covering every rank up to
 * `CHECKPOINT_DRAW_CAP - 1`) is the regression guard for this specific pair.
 *
 * #808: that round-5 fix still left a real-font-metric residual (40.8×3.35px live-probe shave),
 * closed at the Tier A oracle level by `hero.test.ts`'s `captionSafeTextBox`/`CAPTION_SAFE_ASCENT`
 * (real ascent runs ~15% over the plain model). Root-caused here for the PRODUCTION side: no
 * *settled* checkpoint rank (0..`CHECKPOINT_DRAW_CAP-1`, this offset) is ever within tens of px of
 * the Review caption — the actual "ghost droplet" a live probe can catch is a droplet mid-`escalate`
 * (state.ts `transitionOrigin`: `escalate` always originates at `checkpoint`), whose straight-line
 * anime.js translate from a checkpoint rank to a `needs-human` rank necessarily crosses the gate
 * row, and both zones anchor their columns at the same x (`(GATES.ci + GATES.review) / 2` here,
 * `ESCALATION.x` there). This offset bump (and the caption's matching push below) is a genuine,
 * if modest, extra margin for the SETTLED positions this file's own bbox tests check — it does
 * NOT close the escalate-transit crossing itself (a y-margin bump can't fix an x-column
 * coincidence; there is no detour room either, see `Hero.tsx`'s own note). That crossing is
 * closed at the animation layer instead: `Hero.tsx`'s `fadeAcross` (the `escalate` case) never
 * renders the droplet at any point OTHER than its settled checkpoint/needs-human position — no
 * interpolated frame exists to intersect the caption with.
 */
const CHECKPOINT_COLS = 2;
/** #922 AC2: widened alongside NEEDS_HUMAN_COL_STEP/ROW_STEP — same growth, same reason
 *  (`NEEDS_HUMAN_COL_STEP`/`_ROW_STEP`'s own doc: ROW_STEP is sized against the shape's true
 *  ≈2.571r height, not a plain 2r; both raised alongside `DROPLET_MAX_R`'s own 20 → 22). */
const CHECKPOINT_COL_STEP = 46;
const CHECKPOINT_ROW_STEP = 66;
/** #922 AC2 gate② finding [0]: was 3 — the taller ROW_STEP (above) needed to hold the shape's
 *  true height no longer fits 3 rows between `CHECKPOINT_BASE_OFFSET` and the top of the
 *  viewBox (y=0); 2 rows is what the same vertical budget actually holds without pushing rank 2
 *  above the stage. `CHECKPOINT_DRAW_CAP` (below) shrinks with it — a real capacity cut, not a
 *  cosmetic one, since the old 3-row cap was never actually collision-safe once the collision
 *  oracle read the shape's REAL rendered path instead of a circleBox stand-in. */
const CHECKPOINT_ROWS_MAX = 2;
/** Vertical distance from `GATES.y` to checkpoint rank 0 — the grid's closest row to the gates.
 *  #920: 60 → 80, matching `GATES.r`'s own +10 growth (20 → 30) — keeps the gap between rank 0
 *  and the REVIEW-mode caption above `GATES` (which moved further from `GATES.y` by the same
 *  amount the circle grew) at its original, already-verified-safe margin. */
const CHECKPOINT_BASE_OFFSET = 80;
/** No badge needed at or under this many simultaneous checkpoint droplets — the grid draws all
 *  of them normally, exactly as before. Exported so `hero.test.ts` reads the real, current cap
 *  rather than a hand-copied literal that can silently drift once the grid's own geometry
 *  changes (VALUE doctrine). */
export const CHECKPOINT_DRAW_CAP = CHECKPOINT_COLS * CHECKPOINT_ROWS_MAX;
/**
 * How many REAL chips draw once there's overflow — one full row short of `CHECKPOINT_DRAW_CAP`,
 * so the "+N more" badge can have the LAST row entirely to itself rather than sharing a row with
 * a real chip: a droplet's label ("⤳ 9999") and the badge's own ("+34 more") are both wide
 * enough that two side-by-side in the same row collide by rendered text width even though their
 * anchor points don't (caught by this file's own bbox test, not a guess).
 */
export const CHECKPOINT_OVERFLOW_REAL_CAP = CHECKPOINT_COLS * (CHECKPOINT_ROWS_MAX - 1);
/**
 * #897 AC3: the frozen baseline's cross-section is dense and fine-grained (many close rings),
 * not the ~12 coarse widely-spaced circles this stage used to draw. #921: `step` is now the
 * NOMINAL pitch only (`ringRadii`'s own doc — the real per-ring spacing compresses once the
 * disc nears `TRUNK_DISC_R_MAX`, the disc's real fixed footprint ceiling that the DOWNSTREAM
 * fixed layout — `REFLECTION_BAR_Y` etc. — sizes off directly, never `max * step`). Bumped 2 → 3
 * so the disc actually REACHES `TRUNK_DISC_R_MAX` by the mockup's own N = 24 (issue #921's own
 * worked example) instead of still growing toward it at a smaller nominal pitch.
 */
export const TRUNK = { x: 1006, y: 190, step: 3, max: 42 } as const;
/**
 * #921: the 1440px reference width `hero.test.ts`'s own #728 scale-invariance test established —
 * every element scales UNIFORMLY at any rendered `.hero` container width (`width: 100%` over the
 * fixed `STAGE` viewBox), so a target render size pinned at this one reference width converts to
 * every other width through this same ratio.
 */
const RENDER_SCALE_1440 = 1440 / STAGE.w;
/**
 * gate② finding [0] (ac2-real-render-scale): `RENDER_SCALE_1440` above assumes the hero SVG gets
 * the FULL 1440px of a 1440px viewport — it never does. The icon rail (`app.css` `.icon-rail`:
 * 56px width + 1px `border-right`), `.stack`'s own padding (`app.css`, 2 × `--space-4` = 32px),
 * and `.hero-frame`'s own `.panel` padding + border (`app.css` `.panel`: 2 × `--space-4` = 32px +
 * 2 × 1px hairline) all eat into it first — 1440 − (56 + 1 + 32 + 32 + 2) = 1317px is the SVG's
 * own REAL rendered width at that viewport. Every size floor #922 introduces (the droplet's own
 * height, the backlog numeral) is sized against THIS scale. `RENDER_SCALE_1440` above stays as
 * originally defined — #921's own RING_COUNT_FONT_PX/TRUNK_DISC_R_MAX/RING_PITCH_MIN were sized
 * and reviewed against it; reconciling those to the real scale too is a separate round, not
 * #922's, since it risks silently re-tuning already-shipped geometry this issue never touched.
 */
const HERO_ICON_RAIL_PX = 56 + 1; // app.css .icon-rail: width 56px + border-right 1px hairline
const HERO_STACK_PADDING_PX = 2 * 16; // app.css .stack: padding var(--space-4) (16px), both sides
const HERO_PANEL_CHROME_PX = 2 * 16 + 2 * 1; // app.css .panel (.hero-frame): padding var(--space-4) + border hairline, both sides
export const REAL_RENDER_SCALE_1440 = (1440 - HERO_ICON_RAIL_PX - HERO_STACK_PADDING_PX - HERO_PANEL_CHROME_PX) / STAGE.w;
/**
 * #921 AC2: the outcome count's rendered size floor — the frozen mockup's own ~75px cap-height
 * serif "24" against the old `--text-4` (33px, only ~40px at 1440) sitting well under AC2's 56px
 * floor. `--text-4` tops out at 33px (its own 1.25-ratio ladder), so this is a literal, not that
 * token — `hero.test.ts`'s own AC2 reads this exact export back rather than a copied number.
 * 48 × `RENDER_SCALE_1440` = 57.6px, clearing the floor with a small margin.
 */
export const RING_COUNT_FONT_PX = 48;
/** #921: the same conservative half-width/ascent/descent text-metric shape `hero.test.ts`'s own
 *  `textBox()`/`CAPTION_SAFE_ASCENT` use, kept independently here since production geometry
 *  can't import a test module — `ringInnerRadius` below is what actually needs it. */
const RING_COUNT_CHAR_ADVANCE = 0.62;
const RING_COUNT_ASCENT = 1.0;
const RING_COUNT_DESCENT = 0.25;
/** The numeral's own baseline offset from `TRUNK`'s true centre — the `<text>` element's own
 *  `TRUNK.y + 11` cap-height centring nudge, below. */
const RING_COUNT_BASELINE_DY = 11;
/** The numeral's own rendered-box half-diagonal (from the disc centre) at a given font size and
 *  digit count — the shared metric both `ringInnerRadius` and `ringCountFontPx` need, so the two
 *  can never silently diverge on what "fits" means. */
function ringCountBoxRadius(fontPx: number, digits: number): number {
  const halfWidth = (digits * fontPx * RING_COUNT_CHAR_ADVANCE) / 2;
  const above = fontPx * RING_COUNT_ASCENT - RING_COUNT_BASELINE_DY;
  const below = fontPx * RING_COUNT_DESCENT + RING_COUNT_BASELINE_DY;
  return Math.hypot(halfWidth, Math.max(above, below));
}
/**
 * #921 gate② round 3 finding [1] (ac3-extreme-footprint): AC3's footprint ceiling must hold at
 * EVERY count, including scales where the numeral's own box — at the default/AC2 floor
 * `RING_COUNT_FONT_PX` — would itself exceed `TRUNK_DISC_R_MAX` (7+ digits; the reviewer's own
 * rings=1,000,000 example: ~110.5 vs the 103-unit ceiling). Since `ringInnerRadius` sizes the
 * disc's inner clearance directly off the numeral's box, the only way to keep that clearance
 * inside the ceiling at extreme digit counts is to shrink the numeral itself — binary search
 * (30 iterations, well past the precision this geometry needs) for the largest font size, never
 * above `RING_COUNT_FONT_PX`, whose own box still fits inside `TRUNK_DISC_R_MAX`. A no-op for
 * any realistic count (verified through 6 digits — under one million rings — `hero.test.ts`'s
 * own AC2/AC3 tests): the numeral stays at exactly `RING_COUNT_FONT_PX`, AC2's own floor, until
 * scale genuinely forces a trade-off no fixed font size can avoid.
 *
 * #921 gate② round 4 finding [0] (ac3-extreme-clearance): searching against the bare
 * `TRUNK_DISC_R_MAX` let `r0` pin RIGHT AT the ceiling — leaving zero room for even one ring's
 * own minimum pitch, so `ringsThatFitFootprint` correctly computed zero drawn rings at the
 * extreme (rings=1,000,000), and the count went undrawn entirely (the disc is JUST the numeral,
 * no ring texture at all). The search target is now `TRUNK_DISC_R_MAX` minus TWO
 * `RING_PITCH_MIN` slots — one reserved slot alone risks `ringsThatFitFootprint`'s own
 * `Math.floor` rounding a hairline-thin remaining gap down to zero on floating-point noise; two
 * slots is real margin, not just a boundary the solver can land exactly on. The numeral still
 * shrinks no more than necessary — this only tightens the target the binary search converges to.
 */
export function ringCountFontPx(rings: number): number {
  const digits = String(rings).length;
  const ceiling = TRUNK_DISC_R_MAX - 2 * RING_PITCH_MIN;
  if (ringCountBoxRadius(RING_COUNT_FONT_PX, digits) <= ceiling) return RING_COUNT_FONT_PX;
  let lo = 1;
  let hi = RING_COUNT_FONT_PX;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ringCountBoxRadius(mid, digits) <= ceiling) lo = mid;
    else hi = mid;
  }
  return lo;
}
/**
 * #921 growth rule (issue anchors: `TRUNK`/`ringRadii`/`trunkDropletOffset`): the inner
 * clearance radius no ring may draw inside of — sized to the numeral's OWN rendered box
 * (half-diagonal from the disc centre, `ringCountFontPx(rings)` at `rings`' own digit count)
 * rather than a fixed guess, so a wider running total (more digits) automatically buys more
 * clearance instead of eventually colliding with a numeral a fixed radius never anticipated —
 * and, past the point a fixed font size can no longer fit at all, the numeral itself shrinks
 * (`ringCountFontPx`) rather than let the disc's own inner clearance blow the footprint ceiling.
 */
export function ringInnerRadius(rings: number): number {
  return ringCountBoxRadius(ringCountFontPx(rings), String(rings).length);
}
/**
 * #921: the mockup's own disc footprint — ~128px radius at 1440 (i.e. ~256px disc at 24 rings,
 * issue #921's "What") — capped at ~40% of the hero band height (the issue's own footprint
 * ceiling) so a future `STAGE.h` change can't silently push the disc past it; `Math.min` picks
 * whichever ceiling is tighter, rather than two independent, potentially-disagreeing caps.
 */
export const TRUNK_DISC_R_MAX = Math.min(128 / RENDER_SCALE_1440, 0.2 * STAGE.h);
/** #921: a ring pitch below this compresses past what a hairline stroke can actually resolve —
 *  the issue's own "≥ 1.5px [at 1440]" floor, converted to this file's SVG-unit space —
 *  `ringsThatFitFootprint`'s own floor on how many rings the footprint can still fit. Exported so
 *  `hero.test.ts` (#921 gate② round 4 finding [0]) reads the exact two-slot reservation
 *  `ringCountFontPx` searches against, rather than a hand-copied literal. */
export const RING_PITCH_MIN = 1.5 / RENDER_SCALE_1440;
/**
 * #921: the sapling glyph's own footprint at zero rings — "≈ 40% of the disc footprint" (the
 * issue's own sizing), i.e. 40% of the max disc's DIAMETER (`2 * TRUNK_DISC_R_MAX`).
 */
const HERO_SAPLING_SIZE = 0.4 * (2 * TRUNK_DISC_R_MAX);
/** #921 AC3b: a small, deliberate real gap between the sapling glyph's own bounding box and the
 *  reflection stem's start — unlike a ring (whose disc IS the record and attaches with no gap at
 *  all, #920 gate② finding [0]), the sapling's box is a generic icon viewport with real ink
 *  short of its own edges; a stem starting EXACTLY on that box's edge reads as touching it. */
const SAPLING_STEM_CLEARANCE = 6;
/**
 * #920 gate② finding [0] (reflection-stem-max-envelope-gap): the disc's own ACTUAL rendered
 * outer radius at a given count, without re-drawing it — the reflection stem attaches HERE
 * (`TRUNK.y + ringOuterRadius(...)`), never at the `TRUNK.max * TRUNK.step` max envelope.
 * #921: at zero rings there is no ring to measure — the sapling glyph's own box
 * (`HERO_SAPLING_SIZE`, plus `SAPLING_STEM_CLEARANCE`) is what the stem must actually clear
 * instead. Past that, floored at `ringInnerRadius(rings)` (never a bare `TRUNK.step`) — the
 * numeral's own clearance stays the real bottom edge to attach below whenever the footprint-fit
 * cap (`ringsThatFitFootprint`) leaves zero rings drawn (extreme digit counts, #921 gate② round
 * 3's AC3 fix).
 */
export function ringOuterRadius(rings: number): number {
  if (rings === 0) return HERO_SAPLING_SIZE / 2 + SAPLING_STEM_CLEARANCE;
  const radii = ringRadii(rings);
  return Math.max(radii[radii.length - 1] ?? ringInnerRadius(rings), TRUNK.step);
}
/**
 * "ring"/"rings" — the unit word under the big display number. #920 gate② finding [0]: now that
 * the stem's own start (`ringOuterRadius`) shrinks to as little as `TRUNK.step` at a low count,
 * there is no Y-band left between the number's own text and the disc edge wide enough to fit a
 * caption without it landing inside the stem's (now much shorter) own path — the fix used for the
 * outcome tally in the SAME situation applies here too: offset OFF the stem's shared x column
 * (`RING_WORD_RIGHT_X`) rather than trying to out-race a shrinking Y gap.
 *
 * #921 gate② PO review thread (fixed y `TRUNK.y + 40` still sat ON the ring's lower-left arc at
 * low counts — text on stroke, a live crop at rings = 1 caught it): `y` is now DYNAMIC, sized off
 * the disc's own real rendered edge (`ringOuterRadius`, the same source the reflection stem's own
 * start already reads from) rather than a fixed guess — the caption sits BELOW the disc, in the
 * same real gap the stem's own top clears (`hero.test.ts`'s AC3b), never on top of a ring's
 * stroke at any count.
 */
function ringWordY(rings: number): number {
  return TRUNK.y + ringOuterRadius(rings) + 14;
}
const RING_WORD_RIGHT_X = TRUNK.x - 10;
/**
 * #886 gate② run 2e566ac9 finding [1]: where the newest-merge droplet parks, offset from
 * `dropletPoint`'s "trunk" case — frees the true trunk CENTER for the outcome number (below).
 * Chosen for vertical clearance from the number's own worst-case rendered box (a multi-digit
 * ring count centered at `TRUNK.y + 11`, `RING_COUNT_FONT_PX`).
 *
 * #922 AC2: the droplet's own number now renders INSIDE the shape, whose belly radius GROWS to
 * fit its own NUMBER (`dropletRadius` — never the kind mark) — a fixed offset tuned
 * for the old constant-size droplet left no margin once a droplet's own number (worst case: the
 * trunk's own multi-digit PR) grew the shape past that fixed clearance. The offset now grows WITH
 * the droplet's own radius past `DROPLET_MIN_R` — verified against a deliberately stressed digit
 * count (3-digit ring total, 5-digit PR number) by `hero.test.ts`'s own test, the same discipline #728's
 * NEEDS_HUMAN_COL_STEP/ROW_STEP doc already uses for its own cluster. The horizontal +40 base
 * only keeps the marker visually near "where the merge arm feeds in" (`GATES.review` → `TRUNK`),
 * not load-bearing for the clearance itself — only the vertical component needs to keep pace
 * with growth, since the ring count sits ABOVE the droplet's parked position.
 */
function trunkDropletOffset(r: number): { dx: number; dy: number } {
  const grow = Math.max(0, r - DROPLET_MIN_R);
  return { dx: 40 + grow * 0.6, dy: -48 - grow * 1.3 };
}
/**
 * #897 AC2: the frozen baseline connects Summary/Retro BELOW the outcome disc as a lower
 * reflection tree — not beside the trunk at its own y-band (the old `REFLECTION.x` column
 * stacked at y 110/200, alongside `TRUNK.y`).
 *
 * #920 AC4 (D11/D12) + gate② finding [3] + review thread (PRRT…JE5): `detourX`'s horizontal jog
 * is GONE — a "plain T": one stem (`stemX` exactly `TRUNK.x`) descends from the disc's own bottom
 * edge (`ringOuterRadius`, gate② finding [0] — NOT the max envelope) to `barY`, where a crossbar's
 * own TWO ENDS are the Summary/Retro circles themselves (`y` === `barY` — the circles sit ON the
 * bar line, not hung below it by a separate drop segment). This closes finding [3]'s "no segment
 * joining them" gap (the stem is genuinely, continuously attached to the disc) without needing
 * detourX's jog OR the earlier round's right-anchor trick: the ring word/rule/tally all move
 * BELOW the Summary/Retro row entirely (`OUTCOME_RULE_Y`/`OUTCOME_TALLY_Y` below, past the
 * captions), so nothing ever sits in the stem's own y-band between the disc and the bar to cross
 * in the first place — a plain CENTERED tally is safe again once it is no longer between the ring
 * and the bar. `bottom` is where the dashed return path picks up, directly below the tally (the
 * review thread's own "connect the return path from the tree… from the tally/rule end").
 *
 * `barY`/`y`/`OUTCOME_RULE_Y`/`OUTCOME_TALLY_Y`/`bottom` stay anchored to the disc's own MAX
 * envelope, not the dynamic `ringOuterRadius` — the crossbar/captions/rule/tally are a
 * fixed-size readout regardless of ring count; only the stem's own TOP (how far it has to
 * travel to reach the disc) is what varies with the count. #921: that envelope is now
 * `TRUNK_DISC_R_MAX` (the disc's real fixed footprint ceiling) rather than `TRUNK.max *
 * TRUNK.step` — the latter stopped being the disc's true max reach once pitch could compress,
 * and using it here would keep dragging this whole fixed layout down every time `TRUNK.step`
 * tunes the (unrelated) nominal ring pitch.
 */
const REFLECTION_BAR_Y = TRUNK.y + TRUNK_DISC_R_MAX + 60;
const REFLECTION_R = 16;
/** #920 gate② review thread (PRRT…gJ/…GgK): the Summary/Retro label's own baseline, clear of the
 *  circle's bottom edge (`REFLECTION_R + 12`, not the old `+20` that sat ON the circle's stroke) —
 *  the model-effort caption (when present) sits a further 12 below that. */
const REFLECTION_CAPTION_BOTTOM = REFLECTION_BAR_Y + REFLECTION_R + 24;
/** Below the Summary/Retro captions row above — the hairline rule, then the tally beneath it,
 *  per the mockup's own bottom-of-tree ordering. */
const OUTCOME_RULE_Y = REFLECTION_CAPTION_BOTTOM + 18;
const OUTCOME_TALLY_Y = OUTCOME_RULE_Y + 18;
export const REFLECTION = {
  stemX: TRUNK.x,
  spread: 44,
  barY: REFLECTION_BAR_Y,
  y: REFLECTION_BAR_Y,
  r: REFLECTION_R,
  // Where the dashed return path picks up — directly below the tally, the tree's own true
  // bottom now that the tally moved here (review thread PRRT…JE5's "from the tally/rule end").
  bottom: OUTCOME_TALLY_Y + 20,
} as const;
const REFLECTION_NODES = [
  { node: "summary" as const, x: REFLECTION.stemX - REFLECTION.spread, label: "Summary", role: "roles.harvest" },
  { node: "retro" as const, x: REFLECTION.stemX + REFLECTION.spread, label: "Retro", role: "roles.retro" },
] as const;

export const laneY = (index: number) => LANES.top + index * LANES.gap;

/**
 * #1026 (PO ruling, dogfood round 431 live review): the return path for ONE fixing lane —
 * orthogonal segments only (no free curve). Every fixing lane shares the SAME drop off
 * `FIXLOOP_EXIT`, the SAME horizontal row (`rowY`, one shared bus below the whole stage's
 * lanes — the caller computes it once from the LAST channel, never a per-lane offset), and the
 * SAME arm (`FIXLOOP_ARM_X`) — the paths are visually identical up to this point and diverge
 * only in their final two points: down (or up) to their OWN channel's row, then a short
 * rightward tick into their OWN start terminal. Reading as one shared return bus with each
 * fixing lane tapping off it, not competing separate arcs.
 */
export function fixLoopPath(channel: number, rowY: number): string {
  return `M ${FIXLOOP_EXIT.x} ${FIXLOOP_EXIT.y} L ${FIXLOOP_EXIT.x} ${rowY} L ${FIXLOOP_ARM_X} ${rowY} L ${FIXLOOP_ARM_X} ${laneY(channel)} L ${FIXLOOP_ENTRY_X} ${laneY(channel)}`;
}

/**
 * #920 AC3: a lane channel no longer stops short of CI with no visible convergence — a curved
 * connector carries it the rest of the way, ending exactly ON the CI node's own circle (not at
 * an arbitrary point near it), so every lane visibly joins the same gate regardless of which row
 * it draws on. The end point is the closest point on the CI circle to the channel's own end
 * terminal — i.e. straight out from `GATES`' centre through the terminal — which is what makes
 * several lanes at different rows converge naturally into the one node instead of all aiming at
 * its bare centre (which would draw every curve crossing every other one right at the node).
 */
function laneCiConnector(startY: number): { end: { x: number; y: number }; d: string } {
  const startX = LANES.x + LANES.w;
  const dx = GATES.ci - startX;
  const dy = GATES.y - startY;
  const dist = Math.hypot(dx, dy);
  const end = { x: GATES.ci - (dx / dist) * GATES.r, y: GATES.y - (dy / dist) * GATES.r };
  // A gentle bezier: the curve travels mostly horizontal off the terminal, then bends into the
  // node along its own approach angle.
  const c1 = { x: startX + (end.x - startX) * 0.6, y: startY };
  const c2 = { x: end.x - (end.x - startX) * 0.2, y: end.y };
  return { end, d: `M ${startX} ${startY} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}` };
}

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
    case "checkpoint": {
      // #745 gate② round 2 [1]: rank among CURRENTLY checkpoint-parked droplets, same
      // `Math.max(0, findIndex(...))` idiom NEEDS_HUMAN uses below — for a droplet genuinely AT
      // checkpoint right now, live re-derivation is correct (it compacts as earlier droplets
      // leave, same as NEEDS_HUMAN/backlog).
      //
      // #745 gate② round 4 finding [0] secondary regression: for a droplet whose real `at` has
      // ALREADY moved on — an `escalate`/`ring` transition's checkpoint ORIGIN, looked up via
      // this function's own `at` override — the CURRENT checkpoint list no longer contains it
      // at all, so re-deriving from live membership always missed and fell back to rank 0,
      // animating from the wrong point whenever its real rank was > 0. `checkpointRank` is the
      // rank frozen at the droplet's own last checkpoint arrival (`toCheckpoint`) — exactly the
      // point it was actually drawn at — and is what this branch reads once `d` is no longer AT
      // checkpoint.
      const rank =
        d.at === "checkpoint"
          ? Math.max(
              0,
              state.droplets.filter((o) => o.at === "checkpoint").findIndex((o) => o.issue === d.issue),
            )
          : (d.checkpointRank ?? 0);
      const col = rank % CHECKPOINT_COLS;
      const row = Math.floor(rank / CHECKPOINT_COLS);
      return {
        x: (GATES.ci + GATES.review) / 2 + col * CHECKPOINT_COL_STEP,
        y: GATES.y - CHECKPOINT_BASE_OFFSET - row * CHECKPOINT_ROW_STEP,
      };
    }
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
      return { x: ESCALATION.x + col * NEEDS_HUMAN_COL_STEP, y: ESCALATION.y - NEEDS_HUMAN_BASE_OFFSET - row * NEEDS_HUMAN_ROW_STEP };
    }
    // #886 gate② run 2e566ac9 finding [1]: the frozen baseline's outcome ring has NOTHING
    // else drawn near it — just a big centered number. `merged` (state.ts) always parks the
    // newest-merge droplet's PR tag at the trunk, so the two can't both sit dead-center; earlier
    // attempts moved the NUMBER off-center to dodge the droplet (read as "floating below the
    // ring" for the realistic low-ring-count case a live probe actually captures). This moves
    // the DROPLET instead — up-right of center, near where the merge arm feeds in — freeing
    // the true center for the number to match the baseline exactly, at any ring count. The
    // offset is verified collision-free against a worst-case ring/PR digit count by
    // `hero.test.ts`'s own stress test (mirrors the #728 needs-human-cluster stress pattern).
    case "trunk": {
      const { dx, dy } = trunkDropletOffset(dropletRadius(dropletNumber(d)));
      return { x: TRUNK.x + dx, y: TRUNK.y + dy };
    }
  }
}

/**
 * #891 AC1: which `backlog`/`needs-human` droplets to actually DRAW, and how many collapse into
 * the single "+N from earlier rounds" counter chip instead — the fix for a live DB's real scale
 * piling weeks-old escalated/parked droplets onto the stage forever (this cluster's own former
 * ponytail note on NEEDS_HUMAN_COLS/STEP predicted exactly this once a live probe hit it).
 *
 * `openAttention`, when the caller has it (App.tsx always does in production — `undefined` here
 * means only "this render doesn't know," never "nothing is open"), is `entities.ts`'s
 * `foldOpenAttention` result — the SAME durable fold the needs-attention strip renders from
 * (#891 AC2's "single source"). A `needs-human` droplet whose own escalation event is no longer
 * in that set was resolved by something other than a fresh dispatch/merge (§3: an
 * `escalation-resolved` naming a different resolution path) — this file's own droplet `at` never
 * learns that on its own, so without this check a resolved-weeks-ago droplet would keep drawing
 * forever. `undefined` (caller doesn't have the fold) degrades to the OLD unfiltered behavior —
 * never hiding a droplet this function can't actually confirm is resolved.
 *
 * Independent of the fold: a droplet nothing has touched since an OLDER round (`Droplet.roundId`
 * — re-stamped to the current round on every move) is historical regardless of whether its
 * attention is still technically open — an issue escalated three weeks ago and still unresolved
 * is exactly the strip's job to keep surfacing, not the stage's.
 *
 * #891: historical classification is ONE predicate on round identity — `isHistorical` below —
 * applied to every droplet the SAME way regardless of which zone it currently sits in. An
 * earlier version special-cased needs-human and backlog only, which left a droplet stranded in
 * any OTHER zone (lane, checkpoint, trunk) rendering forever once its round closed — e.g. a
 * `dispatched → reclaim-done → rollback-escalated` droplet parks at `checkpoint` failed, and with
 * no zone-specific carve-out for checkpoint at all, nothing ever folded it into the collapsed
 * accounting. No zone gets its own carve-out anymore, so no zone can be individually forgotten
 * again.
 */
function boundAttentionDroplets(
  state: HeroState,
  openAttention: readonly DomainEvent[] | undefined,
): { hiddenIssues: Set<number>; drawnNeedsHumanCount: number; collapsedCount: number } {
  const openEscalatedIssues =
    openAttention === undefined
      ? null
      : new Set(
          openAttention
            .filter((e) => ESCALATION_KINDS.has(e.kind))
            .map((e) => e.payload?.issue)
            .filter((issue): issue is number => typeof issue === "number"),
        );
  const isConfirmedOpen = (d: Droplet) => openEscalatedIssues === null || openEscalatedIssues.has(d.issue);
  // #891 gate① engine-agent finding [0] (ac1-null-round-never-collapses): a droplet's `roundId`
  // is `null` ONLY while the fold has never yet seen a round boundary (`Droplet.roundId`'s own
  // doc) — once `state.roundId` becomes a real number, a still-`null`-stamped droplet PREDATES
  // that first boundary and is exactly as historical as one stamped to an explicit older round.
  // Plain `!==` already covers the genuinely-current case too: while `state.roundId` is ALSO
  // still `null` (no boundary seen at all yet), `null !== null` is `false`.
  const isHistorical = (d: Droplet) => d.roundId !== state.roundId;

  const needsHuman = state.droplets.filter((d) => d.at === "needs-human");
  const resolved = needsHuman.filter((d) => !isConfirmedOpen(d));
  const confirmedOpen = needsHuman.filter(isConfirmedOpen);
  const currentRoundOpen = confirmedOpen.filter((d) => !isHistorical(d));
  const historicalOpen = confirmedOpen.filter(isHistorical);
  const overflow = currentRoundOpen.slice(NEEDS_HUMAN_DRAW_CAP);

  // Every OTHER zone (backlog, lane, checkpoint, trunk) has nothing but this same predicate
  // governing it — no per-zone list to grow or forget. needs-human is excluded here because its
  // own resolved/overflow accounting above already covers it, on a fact (the shared attention
  // fold) this predicate alone can't see.
  const historicalElsewhere = state.droplets.filter((d) => d.at !== "needs-human" && isHistorical(d));

  const hiddenIssues = new Set([...resolved, ...historicalOpen, ...overflow, ...historicalElsewhere].map((d) => d.issue));

  return {
    hiddenIssues,
    drawnNeedsHumanCount: currentRoundOpen.length - overflow.length,
    collapsedCount: historicalOpen.length + overflow.length + historicalElsewhere.length,
  };
}

/**
 * The fixed slot the checkpoint zone's "+N more" overflow badge draws at — the FIRST cell of
 * the grid's LAST row (`CHECKPOINT_OVERFLOW_REAL_CAP`), which the real-chip draw loop leaves
 * empty specifically so the badge never shares a row with a real chip's label (see that
 * constant's own doc). Never a rank grown past the grid's capacity (#745 gate② round 4 finding
 * [0]). Same coordinate formula `dropletPoint`'s checkpoint case uses, evaluated at a fixed rank
 * rather than a per-droplet one.
 */
export function checkpointOverflowPoint(): { x: number; y: number } {
  const rank = CHECKPOINT_OVERFLOW_REAL_CAP;
  const col = rank % CHECKPOINT_COLS;
  const row = Math.floor(rank / CHECKPOINT_COLS);
  return { x: (GATES.ci + GATES.review) / 2 + col * CHECKPOINT_COL_STEP, y: GATES.y - CHECKPOINT_BASE_OFFSET - row * CHECKPOINT_ROW_STEP };
}

/** A droplet's fill token — §6/§5: `--sap-fill` in motion, `--rust` stopped/escalated, `--moss`
 *  merged (#924: the filled-surface role, split from the stroke/text role `--sap-text`). */
function dropletFill(d: Droplet): string {
  if (d.at === "trunk") return "var(--moss)";
  if (d.failed || d.at === "needs-human") return "var(--rust)";
  return "var(--sap-fill)";
}

/** #922 AC2: the 11px numeral floor is inviolable — never shrunk — so the droplet's own NUMBER
 *  (never a prefix) is the only input `dropletRadius` sizes the shape against. `dropletKind` is
 *  the small secondary glyph identifying WHAT the number is (parked-PR / in-flight-PR / bare-issue
 *  / merged) — drawn separately, at its own smaller size, never counted toward the shape's own
 *  fit. */
function dropletKind(d: Droplet): string {
  if (d.at === "needs-human" && d.pr !== null) return "PR";
  if (d.at === "trunk") return "✓";
  return d.pr === null ? "⊙" : "⤳";
}

/** The bare number a droplet's belly is actually sized to fit — the PR once one exists, else the
 *  issue number. Never a prefix (`dropletKind`'s job) — see that function's own doc. */
function dropletNumber(d: Droplet): string {
  return String(d.pr === null ? d.issue : d.pr);
}

/**
 * #879: the frozen baseline draws every issue token as a teardrop, not a bare circle. #922 AC2:
 * the number renders INSIDE the shape (was floating above it) — so the shape's own belly radius
 * must fit its own NUMBER's text box, not just clear a fixed height floor. `dropletRadius` sizes
 * that belly to the ACTUAL number (never a guessed fixed max, and never the kind mark — content
 * fits the shape, not the font), the same "grow to fit content,
 * floor at a minimum" posture `ringCountFontPx`/`ringInnerRadius` (above) already use for the
 * trunk's own display number — a droplet carrying a short issue number stays compact near the
 * floor; one carrying a longer PR number grows to fit it.
 *
 * `DROPLET_MIN_R` is the floor: sized so the rendered height clears AC2's own ≥ 28px floor at the
 * REAL render scale (`REAL_RENDER_SCALE_1440`, gate② finding [0] — not the naive
 * `RENDER_SCALE_1440`, which overstates how much of a 1440px viewport the SVG actually gets):
 * height = (18/7) × r stage units (the tip/belly-bottom span at the r=7 baseline this ratio comes
 * from) × `REAL_RENDER_SCALE_1440` (≈1.0975) ≥ 28 needs r ≳ 9.92; 10.5 clears it with real margin
 * (≈29.6px). `dropletPath(r)` generalizes that SAME tip/belly-radius/control-point ratio to any
 * belly radius `r` — a droplet that grows for its number keeps the identical teardrop silhouette,
 * just bigger.
 */
const DROPLET_MIN_R = 10.5;
/** #922 AC2: the number's own font-size — FIXED, never shrunk. 11 stage units ×
 *  `REAL_RENDER_SCALE_1440` (≈1.0975) ≈ 12.07px at 1440, clearing the AC's own ≥ 11px floor at
 *  the REAL render scale with real margin. Every droplet's number renders at exactly this size,
 *  regardless of digit count — a droplet whose number would blow past `DROPLET_MAX_R` grows the
 *  SHAPE up to that ceiling instead (`dropletRadius`); past the ceiling the number's text box can
 *  exceed the path box, which is why the ceiling itself is sized to the widest number this file
 *  actually expects (`DROPLET_MAX_R`'s own doc), not the font. */
export const DROPLET_NUM_FONT_PX = 11;
const DROPLET_CHAR_ADVANCE = 0.62;
const DROPLET_TEXT_PAD = 4;
/** #922 AC2: the number's own secondary kind mark (`dropletKind`) — smaller than the number
 *  itself (never competes with it for the AC's own ≥ 11px floor, which names the NUMBER only) and
 *  never counted toward `dropletRadius`'s own fit. 7 rendered too faint to read at 1440 (a live
 *  shot measured it a ~3px tick); 9 is the smallest size that stays legibly a mark rather than
 *  noise, and the widest mark ("PR", 2 chars) at 9 still sits well inside `DROPLET_MIN_R`'s own
 *  belly (half-width ≈ 5.4 against a floor of 10.5). */
const DROPLET_MARK_FONT_PX = 9;
/** #922 AC2: vertical gap between the number (its own fixed anchor, unchanged) and the kind mark
 *  drawn above it — a plain constant offset, not a second fitted layout, since the mark's own
 *  small size clears the belly at every radius between `DROPLET_MIN_R` and `DROPLET_MAX_R`
 *  (verified by `hero.test.ts`'s containment checks). Wider than `DROPLET_MARK_FONT_PX` itself (9)
 *  because some glyphs (`✓`'s own tall ascender in this font) render close enough to their own
 *  em-box top to touch the number's own top edge at a tighter gap; 11 keeps a visible gap for
 *  every mark this file draws. */
const DROPLET_MARK_OFFSET = 11;
/** #922 AC2: the belly radius ceiling, covering a realistic 4-5 digit PR/issue number (sapwood's
 *  own repo is already in the 4-digit range) WITHOUT shrinking the number's font —
 *  `dropletRadius`'s own half-width formula gives
 *  "9202" (4 digits) ≈ 17.6 and "12345" (5 digits) ≈ 21.05, both under 22. Two adjacent
 *  needs-human/checkpoint columns (`NEEDS_HUMAN_COL_STEP`/`CHECKPOINT_COL_STEP`, both 46) still
 *  never touch (2 × 22 = 44, a real — if narrower — margin under 46); a 6th digit would clip the
 *  number's own text box (out of the AC's own "realistic" scope, and never reached by any fixture
 *  this file exercises).
 */
const DROPLET_MAX_R = 22;

/** #922 AC2: the belly radius a droplet needs so its own NUMBER's text box sits fully inside
 *  the path box — never smaller than `DROPLET_MIN_R` (the height floor) nor larger than
 *  `DROPLET_MAX_R` (the collision ceiling; a number past both the ceiling AND `DROPLET_MIN_R`'s
 *  clearance is out of scope, see that constant's own doc). The number's font is always
 *  `DROPLET_NUM_FONT_PX` — never re-derived here, never shrunk. Takes the bare number text
 *  (`dropletNumber`), never the kind mark. Exported so `hero.test.ts` derives the exact same
 *  footprint this file actually draws, never a copied literal. */
export function dropletRadius(number: string): number {
  const halfWidth = (number.length * DROPLET_NUM_FONT_PX * DROPLET_CHAR_ADVANCE) / 2 + DROPLET_TEXT_PAD;
  return Math.max(DROPLET_MIN_R, Math.min(DROPLET_MAX_R, halfWidth));
}

/** Same teardrop silhouette as the original hand-tuned r=7 shape, generalized to any belly
 *  radius `r` by a uniform scale (`k = r / 7`) of every coordinate. */
export function dropletPath(r: number): string {
  const k = r / 7;
  const tip = -9 * k;
  const c1x = 4 * k;
  const c1y = -4.5 * k;
  const c2x = 7 * k;
  const c2y = -1 * k;
  const beltY = 2 * k;
  return `M0,${tip} C${c1x},${c1y} ${c2x},${c2y} ${c2x},${beltY} A${r},${r} 0 1 1 ${-c2x},${beltY} C${-c2x},${c2y} ${-c1x},${c1y} 0,${tip} Z`;
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
  now?: Date | undefined;
  /**
   * The engine's own live lane rows (`/api/loop/state`'s `lanes.items[]`) — the SAME rows
   * `Hero.tsx` already threads through `withLanePrs` for the PR tag, passed straight through
   * here too. `isPendingConfident` (state.ts) matches these by `issue`: a pending droplet the
   * engine still names here is confident regardless of this fold's own `foldTruncated` state.
   * Empty in replay, where the live overlay does not exist (§6).
   */
  liveLanes?: readonly { issue: number }[];
  /**
   * #803: PR numbers the persisted event log witnesses as MERGED (`/api/loop/state`'s
   * `mergedPrs`, keyed by `State.mergedPrNumbers`'s merged-witness projection). A droplet whose
   * `pr` appears here never counts as pending — not confident, not the #745 windowed qualifier
   * either — since three of the four merged-witness kinds (`gated-reentry-merged`,
   * `lane-revival-terminal`, `human-merge-only-closed`) are never folded into a droplet's own
   * `at` transition (only plain `merged` is, in state.ts's reducer), so this projection is the
   * only place those PRs' terminal state ever reaches the tally. Empty in replay, same as
   * `liveLanes` — the live overlay does not exist there (§6).
   */
  mergedPrs?: readonly number[];
  /** §6 phase inspector (#861): fired with the clicked node's identity. Absent renders every
   *  stage node with no click/keyboard affordance at all (the feature is additive-only). */
  onInspect?: ((node: StageNode) => void) | undefined;
  /**
   * #891 AC1/AC2: `entities.ts`'s `foldOpenAttention` result — the SAME fold the needs-attention
   * strip renders from (`App.tsx`'s `activeOpenAttention`). Drives BOTH the bounded needs-human
   * droplet drawing (`boundAttentionDroplets`) and the outcome-tally/aria-label "needs human"
   * count, so the stage and the strip can never read two different numbers for the same fact.
   * `undefined` (a caller that hasn't wired this yet) degrades to the pre-#891 behavior on both:
   * every `at: "needs-human"` droplet still draws, and the tally/aria count falls back to that
   * same raw droplet count — an honest "don't know" never means "hide everything."
   */
  openAttention?: readonly DomainEvent[] | undefined;
  ref?: Ref<SVGSVGElement>;
};

/** `roles.<role>.model`/`.effort`, or top-level `worker.model`/`.effort` when `rolePath` is
 *  already the leaf ("worker") — §3 C's mono `model · effort` caption, config-sourced only,
 *  never a live telemetry guess. `null` when the config doesn't name a model (honest gap). */
export function modelEffortCaption(config: Record<string, unknown> | null | undefined, rolePath: string): string | null {
  if (!config) return null;
  const model = readConfigPath(config, `${rolePath}.model`);
  if (typeof model !== "string") return null;
  const effort = readConfigPath(config, `${rolePath}.effort`);
  return typeof effort === "string" ? `${model} · ${effort}` : model;
}

/** #922 owner ruling: REVIEW's caption prefers a real model·effort pair (`reviewer.agent.*`,
 *  same allowlisted path AC7 names); a hosted-bot mode with no agent model (e.g. `codex`) falls
 *  back to that plain mode word instead — never the internal `reviewer.mode` value directly
 *  (§7's "plain word first, internal term never" — `reviewer.mode` can legitimately hold an
 *  internal term like "engine-agent"). No config at all draws nothing (honest gap). */
function reviewCaption(config: Record<string, unknown> | null | undefined): string | null {
  const modelEffort = modelEffortCaption(config, "reviewer.agent");
  if (modelEffort) return modelEffort;
  if (!config) return null;
  const mode = readConfigPath(config, "reviewer.mode");
  return typeof mode === "string" && mode !== "engine-agent" ? mode : null;
}

/** #1019 owner ruling (:4517 walk): the reflection pair draws its glyph at 14px inside a 32px
 *  ring (ratio 14/32) while the planning trio/gates drew a fixed 16px glyph inside their bigger
 *  60px rings (ratio 0.27) — visibly emptier next to the small ones. Deriving every node's glyph
 *  size from its OWN ring radius at the reflection pair's ratio means a future ring-radius growth
 *  (like #920's PLANNING_NODE_R/GATES.r bump to 30) keeps the same glyph density with no second
 *  literal to remember to update by hand. */
export function nodeIconSizeFor(r: number): number {
  return Math.round((2 * r * 14) / 32);
}

const PLANNING_ICON_SIZE = nodeIconSizeFor(PLANNING_NODE_R);
const GATE_ICON_SIZE = nodeIconSizeFor(GATES.r);

/** #922 AC6: every hero UTILITY glyph (planning trio, gates, reflection pair, escalation) sources
 *  from `lucide-react` — standard resources first, per the owner ruling; the hero's own IDENTITY
 *  set (droplet, rings) stays hand-drawn. One shared size/placement helper so every node icon is
 *  centred on `(cx, cy)` the same way `Sprout`'s own sapling glyph already is above. Colour is
 *  never set per-icon: `className` carries `.hero-planning-icon`/`.hero-gate-icon`, whose `color`
 *  (hero.css) every lucide icon's own `currentColor` stroke/fill inherits — the SAME mechanism
 *  the sapling already validates, extended to a class instead of an inline style so
 *  `[data-active="true"]` can still switch it. `size` has no default — #1019 made every caller's
 *  size a function of its own ring radius, so a silently-wrong default can no longer hide. */
function nodeIcon(
  Icon: ComponentType<{ x: number; y: number; width: number; height: number; strokeWidth?: number }>,
  cx: number,
  cy: number,
  className: string,
  dataIcon: string,
  size: number,
) {
  return (
    <g className={className} data-icon={dataIcon}>
      <Icon x={cx - size / 2} y={cy - size / 2} width={size} height={size} strokeWidth={1.6} />
    </g>
  );
}

/** #922 AC8: the breathing halo — a larger, blurred circle drawn BEHIND the node's own disc
 *  (source order), r+6 per the AC's own spec. Callers render this only for the currently active
 *  node — an inactive node carries no halo element at all, not merely a hidden one. */
function nodeHalo(cx: number, cy: number, r: number) {
  return <circle className="hero-node-halo" cx={cx} cy={cy} r={r + 6} filter="url(#hero-node-glow)" />;
}

function planningIcon(node: (typeof PLANNING_NODES)[number]["node"], cx: number, cy: number) {
  switch (node) {
    case "goal-align":
      return nodeIcon(Target, cx, cy, "hero-planning-icon", "target", PLANNING_ICON_SIZE);
    case "arch-review":
      return nodeIcon(GitFork, cx, cy, "hero-planning-icon", "git-fork", PLANNING_ICON_SIZE);
    case "verify":
      return nodeIcon(Check, cx, cy, "hero-planning-icon", "check", PLANNING_ICON_SIZE);
  }
}

/**
 * #922 owner ruling: CI swaps its icon for the standard GitHub Actions asset
 * (`GithubActionsGlyph`, `components/icons.tsx`) — never lucide, since no lucide entry names it.
 * Review swaps its hand-drawn eye for lucide's own `Eye`, same `nodeIcon` placement/colour
 * mechanism as the planning trio.
 */
function gateIcon(gate: "ci" | "review", cx: number, cy: number) {
  switch (gate) {
    case "ci":
      return (
        <g className="hero-gate-icon" data-icon="github-actions">
          <GithubActionsGlyph x={cx - GATE_ICON_SIZE / 2} y={cy - GATE_ICON_SIZE / 2} width={GATE_ICON_SIZE} height={GATE_ICON_SIZE} />
        </g>
      );
    case "review":
      return nodeIcon(Eye, cx, cy, "hero-gate-icon", "eye", GATE_ICON_SIZE);
  }
}

/** §6: "how long since anything happened" — the OUTCOME zone's staleness caption. Reuses
 *  `format-time.ts`'s `formatRelativeTime` (already the whole app's one relative-time rollover:
 *  s/m/h/d/mo/y) rather than a raw-seconds count of its own — #895: a multi-day-old replayed
 *  round used to render "last event 424778s ago". `now` must be the caller's own honest clock
 *  (`HeroStage`'s own doc: never a real timer inside this component) — in replay that is the
 *  replay cursor's own timestamp, never the live wall clock (`Hero.tsx`'s `now` prop).
 *
 *  #895: `formatRelativeTime` degrades an unparseable date to "just now" — its own honest
 *  default for callers that always have SOME real elapsed time to show. For this caption that
 *  default is wrong: an unparseable `lastEventTs` isn't "no time has passed", it's "no honest
 *  reading exists" — guard it out to no caption, same as the `lastEventTs === null` case. */
function stalenessCaption(lastEventTs: string | null, now: Date): string | null {
  if (lastEventTs === null) return null;
  if (Number.isNaN(Date.parse(lastEventTs))) return null;
  return `last event ${formatRelativeTime(lastEventTs, now)}`;
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
  liveLanes = [],
  mergedPrs = [],
  onInspect,
  openAttention,
  ref,
}: HeroStageProps) {
  // #716 gate② P1-9: every downstream position/render computation reads the CAPPED,
  // renumbered lane view — never `rawState.lanes` directly — so a droplet's channel lookup
  // and the DOM row it actually lands in can never disagree.
  const state = withVisibleLanes(rawState, lanesMax);
  const clock = now ?? new Date();
  const waiting = state.droplets.some((d) => d.at === "checkpoint");
  const gateState = waiting ? "waiting" : "idle";
  // #891 AC1/AC2: `escalatedDrawn` bounds what actually DRAWS in the needs-human cluster
  // (never more than `NEEDS_HUMAN_DRAW_CAP`, never a droplet resolved or left over from an
  // earlier round); `openAttentionCount` is the tally/aria-label's own number — the SHARED
  // fold's total, matching the strip exactly, deliberately NOT the same figure as what's drawn
  // (a bounded stage view and an honest count are different jobs — see `boundAttentionDroplets`'s
  // own doc). `openAttention === undefined` (caller hasn't wired the fold) falls back to the
  // pre-#891 raw droplet count for BOTH, never a fabricated zero.
  const { hiddenIssues, drawnNeedsHumanCount, collapsedCount } = boundAttentionDroplets(state, openAttention);
  const escalated = drawnNeedsHumanCount;
  const openAttentionCount =
    openAttention === undefined ? state.droplets.filter((d) => d.at === "needs-human").length : openAttention.length;
  // #891 gate① engine-agent finding [0] (ac1-hidden-ranks-not-compacted): `dropletPoint`'s
  // needs-human/backlog cases each derive a droplet's RANK (and, for backlog, its slot) from
  // `state.droplets` filtered by zone — hidden droplets (`hiddenIssues`, above) still sat in that
  // array, so a historical/resolved/overflow droplet ahead of a DRAWN one in arrival order still
  // consumed a rank/slot, pushing the drawn droplet further down than the cap accounts for
  // (backlog's slot counter isn't even bounded, so this could push a droplet below the well's
  // drawn rect entirely). `geometryState` is what every position computation below reads instead
  // — the exact same "capped, renumbered view" discipline `withVisibleLanes` already established
  // for lanes (#716 gate② P1-9's own doc): drawing and RANKING must never disagree about which
  // droplets exist.
  const geometryState: HeroState =
    hiddenIssues.size > 0 ? { ...state, droplets: state.droplets.filter((d) => !hiddenIssues.has(d.issue)) } : state;
  const anyRunning = state.lanes.some((l) => l.phase === "writing" || l.phase === "fixing");
  const activePlanning = activePlanningNode(roundPhase);
  const activeReflection = activeReflectionNode(roundPhase);
  const staleness = stalenessCaption(state.lastEventTs, clock);
  // §6: "N merged · N pending · N needs human" — merged is THIS round's tally (never the
  // all-time ring count); pending/needs-human are the droplets currently in each state.
  //
  // #745 gate② round 5 PO pre-merge Tier-C probe: no event-age inference, in any form, AND no
  // "fold isn't known truncated" inference either — `isPendingConfident` (state.ts) asks ONLY
  // a POSITIVE voucher (fold-vouched backlog/handoff, or still named by the engine's live lane
  // list); everything else renders qualified, ALWAYS, regardless of `state.foldTruncated`. A
  // droplet the fold can't vouch for still stays drawn on stage exactly like any other pending
  // droplet — only the confident "N pending" HEADLINE number excludes it, with the excluded
  // count named separately. `foldTruncated` only picks the qualifier's WORDING: "in window"
  // while genuinely still catching up (transient), "unverified" once caught up but still
  // unvouched (persistent) — never a silent deletion, never a silently smaller or wrong number.
  // #803: a droplet whose PR the persisted event log witnesses as MERGED is excluded from the
  // pending set entirely — checked BEFORE the #745 confident/windowed split, so such a droplet
  // never lands in either bucket (see mergedPrs's own doc for why three of the four
  // merged-witness kinds never reach here via the fold's own `at` transitions).
  const mergedPrSet = new Set(mergedPrs);
  const pendingDroplets = state.droplets
    .filter((d) => d.at === "backlog" || d.at === "lane" || d.at === "checkpoint")
    .filter((d) => d.pr === null || !mergedPrSet.has(d.pr));
  const liveIssues = new Set(liveLanes.map((l) => l.issue));
  const windowedCount = pendingDroplets.filter((d) => !isPendingConfident(d, liveIssues)).length;
  const pendingCount = pendingDroplets.length - windowedCount;
  const windowedWord = state.foldTruncated ? "in window" : "unverified";
  const outcomeTally =
    windowedCount > 0
      ? `${state.roundMerged} merged · ${pendingCount} pending (${windowedCount} ${windowedWord}) · ${openAttentionCount} needs human`
      : `${state.roundMerged} merged · ${pendingCount} pending · ${openAttentionCount} needs human`;
  // #1026: every currently-fixing lane draws its OWN return path — gated on phase (the real
  // "is this lane fixing" fact), not on whether a reason has arrived yet (`lane.reason` can
  // still be null for a beat after `fix-leg-started`, before `drive-fixup` names it — see the
  // production-order test in hero.test.ts). `state.lanes` is already channel-ordered, so index 0
  // here is "first in channel order" for the shared label below.
  const fixingLanes = state.lanes.filter((l) => l.phase === "fixing");
  const firstFixingLane = fixingLanes[0];
  // #1026 (PO ruling, dogfood round 431 live review): the shared row every fixing lane's return
  // path uses — below the STAGE's own last channel (`state.lanes` is the capped/renumbered view
  // `laneY`/the lanes map both already iterate over, #716 gate② P1-9 — never a hard-coded lane
  // count), so it clears every lane's captions regardless of which one is actually fixing. At
  // the default `lanesMax` = 3 (`laneY(2)` = 238), this resolves to y = 262 — well below
  // `FIXLOOP_EXIT.y` (≈211), so the drop off the CI node is always downward, never back through
  // the node's own circle the way the first #1026 cut's per-lane offset could be for a lane
  // above CI's own centre.
  const lastChannel = state.lanes.length - 1;
  const fixLoopRowY = laneY(lastChannel) + FIXLOOP_RETURN_DY;
  // Cap the checkpoint zone's DRAWN chips — never let a rank grow the grid above the viewBox.
  // At or under `CHECKPOINT_DRAW_CAP`, every droplet draws normally (unchanged). Past it, only
  // `CHECKPOINT_OVERFLOW_REAL_CAP` real chips draw — one row short of the grid's capacity — so
  // the badge can take the whole last row for itself, never colliding by label width with a real
  // chip's own (see that constant's own doc). `geometryState.droplets`, NOT raw `state.droplets`
  // — this zone's own "+N more" badge must count only droplets that could actually still be
  // DRAWN here (the same historical-round exclusion `geometryState` already applies for every
  // other zone's position math): a historical checkpoint droplet already folded into
  // `boundAttentionDroplets`'s single collapsed chip via `hiddenIssues` above, so counting it
  // AGAIN in this zone's own overflow badge double-accounts the same droplet in two numbers on
  // the same stage — the badge would report drawable current-round overflow that isn't real
  // while the collapsed chip already claimed those very droplets as historical.
  const checkpointDroplets = geometryState.droplets.filter((d) => d.at === "checkpoint");
  const checkpointOverflowCount = Math.max(0, checkpointDroplets.length - CHECKPOINT_DRAW_CAP);
  const hiddenCheckpointIssues = new Set(
    checkpointOverflowCount > 0 ? checkpointDroplets.slice(CHECKPOINT_OVERFLOW_REAL_CAP).map((d) => d.issue) : [],
  );

  return (
    <svg
      ref={ref}
      className="hero"
      viewBox={`0 0 ${STAGE.w} ${STAGE.h}`}
      data-dimmed={dimmed ? "true" : "false"}
      data-motion={reducedMotion ? "reduced" : "full"}
      data-running={anyRunning ? "true" : "false"}
      role="img"
      // #891 AC4: two scope-named clauses, never mixed into one — "all-time" (the trunk ring
      // count, `state.rings`) is a wholly different fact from "this round" (`state.roundMerged`)
      // and the currently-open attention count (its own honest "currently" scope: an item can
      // stay open across many rounds, so it is never claimed as "this round" either — see
      // `openAttentionCount`'s own doc). The old single-clause wording mixed exactly these two
      // (frontend-design.md §6 keeps them deliberately distinct).
      aria-label={`Loop stage: ${state.rings} merged pull request${state.rings === 1 ? "" : "s"} all-time. This round: ${state.roundMerged} merged. ${openAttentionCount} item${openAttentionCount === 1 ? "" : "s"} currently waiting on a person. The activity feed carries the same information as text.`}
    >
      {/* #920 AC5: the dashed return path's own arrowhead — a real SVG marker (not a manually
       * drawn triangle), so it inherits the path's own orientation at its end point automatically
       * (`orient="auto-start-reverse"`). */}
      <defs>
        <marker id="hero-return-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className="hero-arrowhead" d="M 0 0 L 10 5 L 0 10 Z" />
        </marker>
        {/* #1026: a sibling marker, same triangle — the shared `hero-return-arrow` above stays
         * `--bark` (the big dashed close-the-loop-into-planning return, unrelated to this one);
         * the fix loop's own arrowhead is the amber in-motion ink, never that muted black. */}
        <marker id="hero-fixloop-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className="hero-fixloop-arrowhead" d="M 0 0 L 10 5 L 0 10 Z" />
        </marker>
        {/* #922 AC8: the active-node halo's own blur — stdDeviation ≈ 3, per the AC's own wording;
         * `x`/`y`/`width`/`height` widen the filter region past its 10% default margin so the
         * blur isn't itself clipped at the halo circle's own edge. */}
        <filter id="hero-node-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      {/* ── Phase captions — §5: the big display face, sparingly ── */}
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={PHASE_X.plan} y={26} textAnchor="middle">
        PLAN
      </text>
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={PHASE_X.implement} y={26} textAnchor="middle">
        IMPLEMENT
      </text>
      <text className="hero-phase" style={{ fontFamily: "var(--font-display)" }} x={PHASE_X.outcome} y={26} textAnchor="middle">
        OUTCOME
      </text>

      {/* #920 AC5: two dashed zone dividers, PLAN|IMPLEMENT and IMPLEMENT|OUTCOME — a background
       * guide, not a foreground shape, so it draws behind everything else (source order). */}
      {ZONE_DIVIDERS.map((x) => (
        <line key={x} className="hero-divider" x1={x} y1={40} x2={x} y2={STAGE.h - 30} />
      ))}

      {/* ── Zone 1: backlog ── */}
      <g className="hero-backlog">
        {/* #897 AC4: "BACKLOG (N ready)" — N is `state.pool.length`, the SAME array the filled/
         * candidate cards below draw from (one number, one source, never a second guess at
         * "how many are ready"). */}
        <text className="hero-label" x={BACKLOG.x} y={BACKLOG.y - 12}>
          BACKLOG ({state.pool.length} ready)
        </text>
        {/* #922 AC3: no well rect — a frameless column of filled/outlined cards, per the mockup. */}
        {state.pool.slice(0, BACKLOG_FILLED_CAP).map((issue, i) => (
          <g className="hero-pool-chip" key={issue} data-issue={issue}>
            <rect
              style={{ fill: "var(--sap-fill)" }}
              x={BACKLOG.x + 8}
              y={BACKLOG.y + 6 + i * BACKLOG.chip}
              width={BACKLOG.w - 16}
              height={BACKLOG_CHIP_H}
              rx={8}
            />
            {/* #924: `.hero-pool-num` (hero.css) fills from --on-sap-fill — always dark ink on
             * this card's amber, in both themes (see hero.css's own doc). */}
            <text
              className="hero-num hero-pool-num hero-backlog-num"
              x={BACKLOG.x + BACKLOG.w / 2}
              y={BACKLOG.y + 6 + BACKLOG_CHIP_H / 2 + 5 + i * BACKLOG.chip}
              textAnchor="middle"
            >
              ⊙ {issue}
            </text>
          </g>
        ))}
        {/* #897 AC4: the rest of the ready pool — an outlined candidate stack, distinguishable
         * from the filled cards above rather than folded into the same filled-chip list.
         * #922 AC3: capped at `BACKLOG_CANDIDATE_DRAW_CAP` — the true remainder collapses into a
         * single "…" chip below instead of growing the column without limit. */}
        {state.pool.slice(BACKLOG_FILLED_CAP, BACKLOG_FILLED_CAP + BACKLOG_CANDIDATE_DRAW_CAP).map((issue, i) => (
          <g className="hero-pool-candidate" key={issue} data-issue={issue}>
            <rect
              x={BACKLOG.x + 8}
              y={BACKLOG.y + 6 + (i + BACKLOG_FILLED_CAP) * BACKLOG.chip}
              width={BACKLOG.w - 16}
              height={BACKLOG_CHIP_H}
              rx={8}
            />
            <text
              className="hero-num hero-backlog-num"
              x={BACKLOG.x + BACKLOG.w / 2}
              y={BACKLOG.y + 6 + BACKLOG_CHIP_H / 2 + 5 + (i + BACKLOG_FILLED_CAP) * BACKLOG.chip}
              textAnchor="middle"
            >
              ⊙ {issue}
            </text>
          </g>
        ))}
        {state.pool.length > BACKLOG_FILLED_CAP + BACKLOG_CANDIDATE_DRAW_CAP && (
          <g
            className="hero-pool-candidate hero-pool-overflow"
            data-count={state.pool.length - BACKLOG_FILLED_CAP - BACKLOG_CANDIDATE_DRAW_CAP}
          >
            <rect
              x={BACKLOG.x + 8}
              y={BACKLOG.y + 6 + (BACKLOG_CANDIDATE_DRAW_CAP + BACKLOG_FILLED_CAP) * BACKLOG.chip}
              width={BACKLOG.w - 16}
              height={BACKLOG_CHIP_H}
              rx={8}
            />
            <text
              className="hero-num hero-backlog-num"
              x={BACKLOG.x + BACKLOG.w / 2}
              y={BACKLOG.y + 6 + BACKLOG_CHIP_H / 2 + 5 + (BACKLOG_CANDIDATE_DRAW_CAP + BACKLOG_FILLED_CAP) * BACKLOG.chip}
              textAnchor="middle"
            >
              …
            </text>
          </g>
        )}
      </g>

      {/*
       * ── Zone 2: planning ──
       * §144: lit from the live round-phase cursor, not a permanently dimmed reserved row —
       * `round-phase` (#206) is shipped engine reality, so this is real state, not fake progress.
       */}
      <g className="hero-planning" data-node="planning">
        {PLANNING_NODES.map((n) => {
          const caption = modelEffortCaption(config, n.role);
          const active = activePlanning === n.node;
          return (
            <g key={n.node} data-active={active ? "true" : "false"} {...inspectProps(n.node, `inspect ${n.label}`, onInspect)}>
              <title>{n.hint}</title>
              {hitTarget(
                PLANNING.x - PLANNING_NODE_R - 60,
                n.y - PLANNING_NODE_R - 4,
                PLANNING_NODE_R * 2 + 120,
                PLANNING_NODE_R + NODE_CAPTION_OFFSET + 10,
              )}
              {active && nodeHalo(PLANNING.x, n.y, PLANNING_NODE_R)}
              <circle className="hero-planning-node" cx={PLANNING.x} cy={n.y} r={PLANNING_NODE_R} />
              {planningIcon(n.node, PLANNING.x, n.y)}
              <text className="hero-node-label" x={PLANNING.x} y={n.y + PLANNING_NODE_R + NODE_LABEL_OFFSET} textAnchor="middle">
                {n.label}
              </text>
              {caption && (
                <text className="hero-node-caption" x={PLANNING.x} y={n.y + PLANNING_NODE_R + NODE_CAPTION_OFFSET} textAnchor="middle">
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
              {...inspectProps("lane", `inspect w${lane.channel + 1}`, onInspect)}
            >
              <line className="hero-channel" x1={LANES.x} y1={laneY(lane.channel)} x2={LANES.x + LANES.w} y2={laneY(lane.channel)} />
              {/* #920 AC3: a hollow-circle terminal at both ends of the channel — the start (the
               * lane's own origin) and the end (where the curved connector into CI takes over). */}
              <circle className="hero-lane-terminal" cx={LANES.x} cy={laneY(lane.channel)} r={LANE_TERMINAL_R} />
              <circle className="hero-lane-terminal" cx={LANES.x + LANES.w} cy={laneY(lane.channel)} r={LANE_TERMINAL_R} />
              <path className="hero-lane-connector" d={laneCiConnector(laneY(lane.channel)).d} />
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
                  y={laneY(lane.channel) + (lane.phase === "fixing" ? LANE_FIXING_CAPTION_DY : -10)}
                  textAnchor="end"
                >
                  {lane.phase === "fixing" ? (
                    `FIXING · round ${lane.fixRound} of ${fixCap}${lane.reason ? ` · ${lane.reason}` : ""}`
                  ) : (
                    // #895 item 7: the engine's raw worker id ("lane-880-a048dacf") used to leak
                    // here as primary text — a short, stable form instead, full id kept as the
                    // hover title. `<text>` has no `title` ATTRIBUTE in SVG's own spec (only this
                    // `<title>` child element is) — but a bare `<title>` here silently vanished:
                    // React 19's Document Metadata feature hoists any `<title>` it finds straight
                    // to `document.head` instead of rendering it inline. `itemProp` (any value)
                    // is React's own documented escape hatch — it marks this as metadata about
                    // THIS element, not the document, and keeps it in place.
                    <>
                      <title itemProp="worker-id">{lane.worker}</title>
                      {lane.issue !== null ? `#${lane.issue}` : `w${lane.channel + 1}`}
                    </>
                  )}
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

        {/* #1026 (PO ruling, dogfood round 431 live review): one return path PER fixing lane,
         * back into THAT lane's own start — sharing one drop/row/arm bus (`fixLoopRowY`,
         * `FIXLOOP_ARM_X`) so several fixing lanes at once read as one shared return line, not
         * competing arcs. #728: mounted only while a lane is actually fixing — an unlabeled arc
         * left drawn after the fix loop ends read as stray, unexplained stage furniture. */}
        {fixingLanes.map((lane) => (
          <path
            key={lane.channel}
            id={`hero-fixloop-path-w${lane.channel + 1}`}
            className="hero-fixloop"
            markerEnd="url(#hero-fixloop-arrow)"
            d={fixLoopPath(lane.channel, fixLoopRowY)}
          />
        ))}
        {firstFixingLane?.reason && (
          /* #897 AC1: the send-back reason renders as plain upright text below the return leg —
           * the per-lane caption flash (above) narrates WHICH lane, this narrates WHAT the loop
           * is doing. One shared label, centered under the shared row (#1026: every fixing lane
           * uses the same row now, so there is no longer a "first lane's own run" to center
           * under); when several lanes are fixing at once, the first (channel order) wins the
           * TEXT rather than concatenating an ambiguous list. Conditioned on `reason` (not just
           * phase): a lane can be `fixing` for a beat with `reason` still null (see
           * `fixingLanes`'s own doc above) — the paths still draw, the label just waits for a
           * real word to show. */
          <text className="hero-fixloop-label" x={(FIXLOOP_ARM_X + FIXLOOP_EXIT.x) / 2} y={fixLoopRowY + 12} textAnchor="middle">
            {firstFixingLane.reason}
          </text>
        )}
      </g>

      {/*
       * The two checkpoints render as ONE waiting area (§6): both carry the same state, always.
       * v0.2 persists no gate substate, so faking per-gate progress would be a lie (§10).
       * Plain labels only — CI / Review, never gate①/gate②.
       */}
      <g className="hero-gates">
        {/* #897 AC2: large circular gate nodes with an icon marker (`gateIcon`), not the small
         * rects this stage used to draw — the primary "CI"/"Review" label sits below the circle
         * (the circle itself carries the icon), matching the planning trio's own
         * circle-then-label-below convention; #922 AC1/AC7 adds a small-print caption in the same
         * slot every other node's caption uses. */}
        <g className="hero-gate" data-gate="ci" data-state={gateState} {...inspectProps("ci", "inspect CI", onInspect)}>
          {hitTarget(GATES.ci - GATES.r - 4, GATES.y - GATES.r - 30, GATES.r * 2 + 8, GATES.r * 2 + 60)}
          <circle className="hero-gate-node" cx={GATES.ci} cy={GATES.y} r={GATES.r} />
          {gateIcon("ci", GATES.ci, GATES.y)}
          <text className="hero-node-label" x={GATES.ci} y={GATES.y + GATES.r + NODE_LABEL_OFFSET} textAnchor="middle">
            CI
          </text>
          {/* #922 owner ruling: CI's caption is the plain, non-configurable provider word — a
           * constant (`copy.ts`), never a config read (the CI provider isn't configurable in
           * v0.2, unlike REVIEW's genuinely-configurable reviewer identity below). */}
          <text className="hero-node-caption" x={GATES.ci} y={GATES.y + GATES.r + NODE_CAPTION_OFFSET} textAnchor="middle">
            {CI_CAPTION}
          </text>
          {/* #716 gate② P2-5: the merged flash used to be a border-color change ONLY
           * (`.hero-gate.is-merged circle`) — a real ✓ glyph is the non-color-carried channel
           * this file's own §5 doctrine requires; shown via CSS opacity keyed off `.is-merged`
           * (Hero.tsx toggles that class), never a second render path. */}
          <text className="hero-gate-check" x={GATES.ci + GATES.r - 4} y={GATES.y - GATES.r + 6} textAnchor="middle">
            ✓
          </text>
        </g>
        <g className="hero-gate" data-gate="review" data-state={gateState} {...inspectProps("review", "inspect Review", onInspect)}>
          {hitTarget(GATES.review - GATES.r - 4, GATES.y - GATES.r - 30, GATES.r * 2 + 8, GATES.r * 2 + 60)}
          <circle className="hero-gate-node" cx={GATES.review} cy={GATES.y} r={GATES.r} />
          {gateIcon("review", GATES.review, GATES.y)}
          <text className="hero-node-label" x={GATES.review} y={GATES.y + GATES.r + NODE_LABEL_OFFSET} textAnchor="middle">
            Review
          </text>
          <text className="hero-gate-check" x={GATES.review + GATES.r - 4} y={GATES.y - GATES.r + 6} textAnchor="middle">
            ✓
          </text>
          {/* #922 owner ruling: REVIEW carries a model·effort caption like every other model-backed
           * node — never the internal `reviewer.mode` word (§7). `reviewCaption` falls back to the
           * reviewer's plain name for a hosted-bot mode with no agent model, and draws nothing at
           * all absent config (the existing "honest gap" rule) — same `.hero-node-caption` slot
           * and offset as the planning trio's own captions (`NODE_CAPTION_OFFSET`), directly below
           * the label instead of the old above-circle placement. */}
          {reviewCaption(config) && (
            <text className="hero-node-caption" x={GATES.review} y={GATES.y + GATES.r + NODE_CAPTION_OFFSET} textAnchor="middle">
              {reviewCaption(config)}
            </text>
          )}
        </g>
        <line className="hero-arm" x1={GATES.ci + GATES.r} y1={GATES.y} x2={GATES.review - GATES.r} y2={GATES.y} />
        {/* The merge arm — §6: "answers only to review", the segment carrying a merged PR into
         * the trunk. Its own clickable node (AC3's "the merge arm carries no caption") — distinct
         * from CI/Review, which sit above it. */}
        <g {...inspectProps("merge", "inspect merge", onInspect)}>
          <line className="hero-arm" x1={GATES.review + GATES.r} y1={GATES.y} x2={TRUNK.x - 40} y2={TRUNK.y} />
        </g>
      </g>

      {/* Escalation branch — the one place rust appears on the stage. */}
      <g className="hero-escalation" data-node="needs-human" data-count={escalated}>
        <path
          style={{ stroke: "var(--rust)" }}
          className="hero-branch"
          d={`M ${ESCALATION.x} ${GATES.y} L ${ESCALATION.x} ${ESCALATION.y - ESCALATION_R - 5}`}
        />
        <circle style={{ stroke: "var(--rust)" }} cx={ESCALATION.x} cy={ESCALATION.y} r={ESCALATION_R} />
        {/* #922 AC4/AC6: a person glyph (lucide `UserRound`) inside the rust hairline circle —
         * `--rust` is the escalation node's own colour, so the icon inherits it via `color`
         * (`hero.css`'s `.hero-escalation-icon`), not the planning/gate icon's idle `--bark`. */}
        {nodeIcon(UserRound, ESCALATION.x, ESCALATION.y, "hero-escalation-icon", "user-round", 14)}
        <text className="hero-node-label" x={ESCALATION.x} y={ESCALATION.y + ESCALATION_R + NODE_LABEL_OFFSET} textAnchor="middle">
          Needs human
        </text>
      </g>

      {/* ── Zone 4: trunk cross-section + reflection ── */}
      <g className="hero-trunk" data-rings={state.rings}>
        {state.rings === 0 ? (
          // #921 owner ruling (2026-08-17): zero merges is a sapling, not a bare "0" against no
          // ring — `lucide-react`'s `Sprout` (standard resources first; hand-drawn only what has
          // no standard equivalent), never a hand-drawn `<path>` here. Colour is set ONCE, on the
          // wrapper `<g>` — `Sprout`'s own stroke is `currentColor` (lucide-react's default), so
          // it inherits `--moss` through SVG `color` inheritance rather than a per-path override.
          <g className="hero-sapling" style={{ color: "var(--moss)" }}>
            <Sprout
              x={TRUNK.x - HERO_SAPLING_SIZE / 2}
              y={TRUNK.y - HERO_SAPLING_SIZE / 2}
              width={HERO_SAPLING_SIZE}
              height={HERO_SAPLING_SIZE}
            />
          </g>
        ) : (
          <>
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
            {/* #879/#886: dead center — the frozen baseline's bold display number fills the ring
             * cross-section with nothing else drawn near it. Earlier rounds moved this text itself
             * off-center to dodge the newest-merge droplet that always parks at the trunk (see
             * `merged` in state.ts); that read as "floating below the ring" for the realistic
             * low-ring-count case a live probe actually captures. `trunkDropletOffset` (above)
             * moves the DROPLET out of the way instead, so this can stay truly centered at any ring
             * count. +11 is a baseline-centering nudge for the display font's cap-height, not a
             * collision-avoidance number. #921 AC2: `fontSize` is now inline (`RING_COUNT_FONT_PX`,
             * ≥ 56px at 1440 — the frozen mockup's own cap-height "24") rather than `hero.css`'s old
             * `--text-4` (33px, whose 1.25-ratio ladder tops out short of the floor). #921 gate②
             * round 3 finding [1]: `ringCountFontPx` (not the bare constant) — a no-op at any
             * realistic count (stays exactly `RING_COUNT_FONT_PX`), only shrinking the RENDERED
             * numeral to match what `ringInnerRadius` actually solved for once digit width alone
             * would otherwise blow the footprint ceiling. */}
            <text
              className="hero-ring-count"
              style={{ fontFamily: "var(--font-display)", fontSize: ringCountFontPx(state.rings) }}
              x={TRUNK.x}
              y={TRUNK.y + 11}
              textAnchor="middle"
            >
              {state.rings}
            </text>
            {/* #920 gate② finding [0]: right-anchored (`RING_WORD_RIGHT_X`'s own doc) — off the
             * stem's shared x column. #921 gate② PO review thread: `y` (`ringWordY`) now tracks
             * the disc's own real rendered edge — below it at every count, never on a ring's own
             * stroke. */}
            <text className="hero-label" x={RING_WORD_RIGHT_X} y={ringWordY(state.rings)} textAnchor="end">
              {state.rings === 1 ? "ring" : "rings"}
            </text>
          </>
        )}
      </g>

      <g className="hero-reflection" data-node="reflection">
        {/* #920 AC4/gate② finding [3] + finding [0] + review thread (PRRT…JE5): a plain T — the
         * stem descends from the disc's own ACTUAL rendered bottom edge (`ringOuterRadius`, not
         * the max envelope — gate② finding [0]) to `barY`, where a crossbar's own two ENDS are
         * the Summary/Retro circles (`REFLECTION.y === barY` — the circles sit ON the bar line,
         * not hung below it by a separate drop). Genuinely, continuously attached to the disc at
         * every ring count — no jog, no gap.
         * #920 gate② review thread (PRRT…gJ/…GgK): the bar used to run CENTRE-to-CENTRE
         * (`stemX ± spread`), passing straight THROUGH both circles — it now stops at each
         * circle's own EDGE (`± (spread - r)`), matching the mockup's own bar-meets-circle-edge
         * drawing. */}
        <path
          className="hero-arm"
          d={[
            `M ${REFLECTION.stemX} ${TRUNK.y + ringOuterRadius(state.rings)}`,
            `L ${REFLECTION.stemX} ${REFLECTION.barY}`,
            `M ${REFLECTION.stemX - REFLECTION.spread + REFLECTION.r} ${REFLECTION.barY}`,
            `L ${REFLECTION.stemX + REFLECTION.spread - REFLECTION.r} ${REFLECTION.barY}`,
          ].join(" ")}
        />
        {REFLECTION_NODES.map((n) => {
          const caption = modelEffortCaption(config, n.role);
          const active = activeReflection === n.node;
          return (
            <g key={n.node} data-active={active ? "true" : "false"} {...inspectProps(n.node, `inspect ${n.label}`, onInspect)}>
              {active && nodeHalo(n.x, REFLECTION.y, REFLECTION.r)}
              <circle className="hero-planning-node" cx={n.x} cy={REFLECTION.y} r={REFLECTION.r} />
              {/* #922 AC6: bar-chart (Summary) / trend-arrow (Retro) — every reflection/escalation
               * node carries a glyph now, matching the planning trio and gates. #1019: sourced
               * from `nodeIconSizeFor` (not a standalone `14` literal) — this IS the ratio every
               * other node's glyph now matches, so it stays the one place the ratio is defined. */}
              {nodeIcon(
                n.node === "summary" ? ChartNoAxesColumn : TrendingUp,
                n.x,
                REFLECTION.y,
                "hero-planning-icon",
                n.node === "summary" ? "chart-no-axes-column" : "trending-up",
                nodeIconSizeFor(REFLECTION.r),
              )}
              {/* #920 gate② review thread (PRRT…gJ/…GgK): the label used to sit ON the circle's
               * own bottom arc (`REFLECTION.y + 20` vs a circle bottom of `REFLECTION.y + r` =
               * +16) — text-on-stroke. `REFLECTION.r + 12` gives real clearance below the edge. */}
              <text className="hero-node-label" x={n.x} y={REFLECTION.y + REFLECTION.r + 12} textAnchor="middle">
                {n.label}
              </text>
              {caption && (
                <text className="hero-node-caption" x={n.x} y={REFLECTION.y + REFLECTION.r + 24} textAnchor="middle">
                  {caption}
                </text>
              )}
            </g>
          );
        })}
        {/* #920 gate② review thread (PRRT…JE5): the hairline rule + outcome tally now sit BELOW
         * the whole Summary/Retro row, matching the mockup's own bottom-of-tree ordering — the
         * disc's ring word (above) is the only OUTCOME-column text that stays near the ring. */}
        <line className="hero-outcome-rule" x1={TRUNK.x - 60} y1={OUTCOME_RULE_Y} x2={TRUNK.x + 60} y2={OUTCOME_RULE_Y} />
        {/* §6: "the round's outcome tally (N merged · N pending · N needs human) — small
         * numbers, never repeating the all-time ring count." `roundMerged` is the round-
         * scoped counter (#716 gate② P2-8); `state.rings` above stays the all-time one. */}
        <text className="hero-num hero-small hero-outcome-tally" x={TRUNK.x} y={OUTCOME_TALLY_Y} textAnchor="middle">
          {outcomeTally}
        </text>
      </g>

      {/* The dashed return path that closes the loop back into planning — #920 AC5: terminates in
       * an arrowhead under the planning trio's own x (`PLANNING.x`, the trio's shared column). */}
      <path
        className="hero-return"
        markerEnd="url(#hero-return-arrow)"
        d={`M ${REFLECTION.stemX} ${REFLECTION.bottom} L ${REFLECTION.stemX} ${STAGE.h - 20} L ${PLANNING.x} ${STAGE.h - 20} L ${PLANNING.x} ${PLANNING.note + 14}`}
      />

      {/* ── Droplets — real entities, moved only by real events ── */}
      <g className="hero-droplets">
        {state.droplets.map((d) => {
          // #745 gate② round 4 finding [0]: overflow past the checkpoint grid's documented
          // capacity draws NOTHING for this droplet individually — it's folded into the single
          // "+N more" badge below instead, never an above-viewBox chip.
          if (hiddenCheckpointIssues.has(d.issue)) return null;
          // #891 AC1: a resolved, historical-round, or needs-human-cap-overflow droplet draws
          // nothing either — folded into the combined "+N from earlier" chip below instead
          // (`boundAttentionDroplets`'s own doc).
          if (hiddenIssues.has(d.issue)) return null;
          // `geometryState`, not `state`: a needs-human/backlog rank must be computed among the
          // droplets that ACTUALLY draw, never among the hidden ones sitting ahead of it too
          // (`geometryState`'s own doc above).
          const { x, y } = dropletPoint(geometryState, d);
          // #922 AC2: the shape grows to fit THIS droplet's own NUMBER
          // only (never a fixed guess, `dropletRadius`'s own doc) — the kind mark is secondary and
          // never grows the shape. `bottom` is the shape's own real rendered bottom edge (the same
          // 9/7 ratio `dropletPath` draws its tip at, mirrored) — every element below the number
          // anchors off it instead of a fixed offset that only held for the old constant-size
          // shape.
          const kind = dropletKind(d);
          const number = dropletNumber(d);
          const r = dropletRadius(number);
          const bottom = (r * 9) / 7;
          const numY = bottom * 0.35;
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
              <path className="hero-droplet-shape" d={dropletPath(r)} style={{ fill: dropletFill(d) }} />
              {/* #922 AC2: the kind mark (⊙ / ⤳ / ✓ / PR) — WHAT the number is, drawn smaller
               *  and above it, never sized into the shape's own fit (`dropletRadius`'s own doc). */}
              <text
                className="hero-droplet-kind"
                x={0}
                y={numY - DROPLET_MARK_OFFSET}
                textAnchor="middle"
                style={{ fontSize: DROPLET_MARK_FONT_PX }}
              >
                {kind}
              </text>
              <text className="hero-num hero-droplet-num" x={0} y={numY} textAnchor="middle" style={{ fontSize: DROPLET_NUM_FONT_PX }}>
                {number}
              </text>
              {d.failed && (
                <text className="hero-mark" x={0} y={bottom + 12} textAnchor="middle">
                  ✕
                </text>
              )}
              {d.handedOff && (
                <text className="hero-small hero-badge" x={0} y={bottom + (d.failed ? 26 : 12)} textAnchor="middle">
                  saved for a successor
                </text>
              )}
            </g>
          );
        })}
        {checkpointOverflowCount > 0 &&
          (() => {
            const { x, y } = checkpointOverflowPoint();
            const hiddenCount = checkpointDroplets.length - CHECKPOINT_OVERFLOW_REAL_CAP;
            return (
              <g className="hero-checkpoint-overflow" data-count={hiddenCount} transform={`translate(${x} ${y})`}>
                <text className="hero-num hero-small hero-badge" x={0} y={-14} textAnchor="middle">
                  +{hiddenCount} more
                </text>
              </g>
            );
          })()}
        {/* #891 AC1: droplets `boundAttentionDroplets` excluded for being resolved, from an
         * earlier round, or beyond the needs-human draw cap collapse here — ONE combined chip
         * rather than a per-zone one, since to the viewer they're all the same fact ("more is
         * waiting than the stage shows right now — see the strip/feed").
         *
         * #891 gate① engine-agent finding [0] (ac1-collapsed-chip-overlap): the original spot
         * below the backlog well (94, 296) sat 4px off the staleness caption's own baseline
         * (`PLANNING.noteX`/`PLANNING.note` = 152, 300) with a long enough label to run straight
         * into it. Moved below the ESCALATION node instead — the one stretch of the stage
         * nothing else draws into at ANY zone's worst case: below the needs-human cluster's
         * lowest row (`ESCALATION.y - NEEDS_HUMAN_BASE_OFFSET`, itself well above this y), below
         * the node's own label/circle, and above the dashed return path's horizontal leg
         * (`STAGE.h - 20`).
         * Shortened text, verified collision-free against every neighboring caption/tally by
         * `hero.test.ts`'s own worst-case stress test, the same discipline this file's other
         * geometry constants already cite.
         * #922: pushed from the old fixed `+ 34` to below the escalation node's own label
         * (`ESCALATION_R + NODE_LABEL_OFFSET`, now that AC1 moved that label below the circle
         * instead of beside it) plus a caption-line gap, so it never sits on top of that label. */}
        {collapsedCount > 0 && (
          <text
            className="hero-num hero-small hero-badge hero-attention-collapsed"
            data-count={collapsedCount}
            x={ESCALATION.x}
            y={ESCALATION.y + ESCALATION_R + NODE_LABEL_OFFSET + 14}
            textAnchor="middle"
          >
            +{collapsedCount} earlier — see strip
          </text>
        )}
      </g>
    </svg>
  );
}

/** #921 gate② round 3 finding [0] (ac1-min-pitch-crossover): the growth rule's own THIRD limiting
 *  term (issue's own "What", verbatim: "the pitch compresses … so every ring still draws down to
 *  a hairline-resolvable pitch (≥ 1.5px), after which the existing TRUNK.max drawn-window cap
 *  applies and the count is the record") — how many rings the footprint can still fit at the
 *  hairline-resolvable minimum pitch, given the inner clearance `r0` already claims. Once this is
 *  SMALLER than `TRUNK.max`, it — not `TRUNK.max` — is the binding cap on how many rings draw;
 *  the numeral (the real, uncapped `rings` count) stays "the record" for the gap. */
function ringsThatFitFootprint(r0: number): number {
  return Math.max(0, Math.floor((TRUNK_DISC_R_MAX - r0) / RING_PITCH_MIN));
}
/**
 * Radii for the cross-section, outermost = newest — empty at zero rings (the sapling glyph
 * draws instead, `HeroStage`'s own trunk group) OR once the footprint-fit cap
 * (`ringsThatFitFootprint`) itself lands at zero (extreme digit counts).
 *
 * ponytail: capped at TRUNK.max drawn rings — the count text is the real record, and a disc
 * of 400 hairlines is a grey blob. Lift the cap only if the disc ever needs to be exact.
 *
 * #921 growth rule: `drawn` is `min(rings, TRUNK.max)`, further capped by `ringsThatFitFootprint`
 * — the growth rule's own third term (that function's own doc). Pitch stays the nominal
 * `TRUNK.step` while the whole drawn set still fits inside `TRUNK_DISC_R_MAX` past the inner
 * clearance (`ringInnerRadius`, sized to `rings`' own digit count — the REAL total, not the
 * capped `drawn` count, since the numeral shows the real total even once ring-drawing itself
 * saturates). Once it wouldn't fit at the nominal pitch, EVERY ring's pitch compresses together
 * (never just the newest ones) so the outermost ring lands exactly on the ceiling instead of
 * overshooting it — down to `RING_PITCH_MIN`, the hairline floor `ringsThatFitFootprint` itself
 * enforces by construction (once `drawn` rings fit at that floor, this file never asks for fewer
 * than the floor pitch to squeeze in more).
 *
 * #921 gate② round 2 findings [0]/[1] (ac1-secondary-ring-cap / ac3-wide-count-footprint) vs.
 * round 3 findings [0]/[1] (ac1-min-pitch-crossover / ac3-extreme-footprint): round 1 had this
 * same footprint-fit cap; round 2 dropped it, reading AC1's checklist wording ("exactly
 * min(N, TRUNK.max)") as an unconditional override of the growth rule's own third term — round 3
 * corrected that misreading (the growth rule's own prose already names the exception: "the count
 * is the record" once the footprint-fit cap binds, not "exactly min(N, TRUNK.max) always"). The
 * cap is restored, and `ringInnerRadius` (via `ringCountFontPx`) now ALSO shrinks the numeral
 * itself for the truly extreme scale (7+ digits, round 3 finding [1]) where even the DEFAULT
 * font's own box would exceed `TRUNK_DISC_R_MAX` before any ring is drawn — so AC3's footprint
 * ceiling now holds at every count the growth rule can reach, not just up to a digit-width
 * boundary. First binding boundary pinned exactly (`hero.test.ts`'s own AC1 test): N = 100 (the
 * smallest 3-digit total) is the first N where `ringsThatFitFootprint` draws fewer than
 * `TRUNK.max` — every 1-2 digit N (up to N = 99) still draws exactly `min(N, TRUNK.max)`.
 */
export function ringRadii(rings: number): number[] {
  const capped = Math.min(rings, TRUNK.max);
  if (capped === 0) return [];
  const r0 = ringInnerRadius(rings);
  const drawn = Math.min(capped, ringsThatFitFootprint(r0));
  if (drawn === 0) return [];
  const nominalReach = r0 + drawn * TRUNK.step;
  const pitch = nominalReach <= TRUNK_DISC_R_MAX ? TRUNK.step : (TRUNK_DISC_R_MAX - r0) / drawn;
  return Array.from({ length: drawn }, (_, i) => r0 + (i + 1) * pitch);
}
