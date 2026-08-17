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

import { Sprout } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { readConfigPath } from "../config-captions.ts";
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
export const BACKLOG = { x: 46, y: 62, w: 96, chip: 32 } as const;
/**
 * #897 AC4: only the FRONT of the ready pool draws as filled cards — the frozen baseline's
 * "about to be worked" emphasis — the rest draws as outlined candidate cards below them (same
 * "cap what's emphasized" grammar `NEEDS_HUMAN_DRAW_CAP`/`CHECKPOINT_DRAW_CAP` already use).
 * 3 matches the baseline's own filled-card count.
 */
const BACKLOG_FILLED_CAP = 3;
/** `note` sits below the planning trio's own lowest content (`verify`'s caption) — #920 grew the
 *  trio's own vertical spread, so it no longer needs to independently clear the lane stack too;
 *  `LANES.top`'s own span (up to `lanes.max` 6) sits well above this y regardless. */
export const PLANNING = { x: 224, note: 430, noteX: 152 } as const;
/** #920 AC2: ≥ 30 stage units (≥ 60 px at 1440 rendered width) — the planning trio's own circle
 *  radius, exported so `hero.test.ts` reads it directly rather than a copied literal. */
export const PLANNING_NODE_R = 30;
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
/** #920 AC3: the small hollow-circle terminal drawn at BOTH ends of every lane channel. */
const LANE_TERMINAL_R = 4;
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
 * `ESCALATION.y - 30 - 2 * NEEDS_HUMAN_ROW_STEP - DROPLET_LABEL_FONT_PX` ≈ 198) — the cluster's
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
/**
 * #897 AC1: the fix-loop return arrow's own send-back-reason label — plain upright text, not a
 * `textPath` riding the arrow's own (right-to-left, at this stretch) curve, which rendered the
 * word rotated ~180°. Sits below the arc's own deepest dip (the curve's control-point y,
 * `GATES.y + 78`) with clearance from both the curve above and `LANES` row captions below it —
 * distinct from the arrow's own path direction, per the mockup (`hero-panel-{dark,light}.png`:
 * the label sits upright on its own baseline under the return leg, not painted along it).
 */
const FIXLOOP_LABEL = { x: 535, y: GATES.y + 100 } as const;
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
const NEEDS_HUMAN_COL_STEP = 38;
const NEEDS_HUMAN_ROW_STEP = 34;
/** #891 AC1: never draw more than this many needs-human droplets at once — see the doc above
 *  this cluster's own geometry constants for why 6 (2 cols × 3 rows) is the verified ceiling. */
const NEEDS_HUMAN_DRAW_CAP = NEEDS_HUMAN_COLS * 3;
/**
 * #745 gate② round 2 finding [1]: EVERY simultaneously-`at: "checkpoint"` droplet used to draw
 * at one fixed point — unlike `backlog` (slot counter) and `needs-human` (this same col/row
 * grid), `checkpoint` had no per-droplet offset at all. Two PRs out for review at once is the
 * normal steady state, not an edge case, so this collided on the most common path — the exact
 * "N chips staged at ONE coordinate" shape #745 reports. Same COLS/STEP magnitudes as
 * NEEDS_HUMAN — same droplet label format (`⤳ 9999`/`⊙ 9999`), same verified-safe sizing;
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
const CHECKPOINT_COL_STEP = 38;
const CHECKPOINT_ROW_STEP = 34;
const CHECKPOINT_ROWS_MAX = 3;
/** Vertical distance from `GATES.y` to checkpoint rank 0 — the grid's closest row to the gates.
 *  #920: 60 → 80, matching `GATES.r`'s own +10 growth (20 → 30) — keeps the gap between rank 0
 *  and the REVIEW-mode caption above `GATES` (which moved further from `GATES.y` by the same
 *  amount the circle grew) at its original, already-verified-safe margin. */
const CHECKPOINT_BASE_OFFSET = 80;
/** No badge needed at or under this many simultaneous checkpoint droplets — the grid draws all
 *  of them normally, exactly as before. */
const CHECKPOINT_DRAW_CAP = CHECKPOINT_COLS * CHECKPOINT_ROWS_MAX;
/**
 * How many REAL chips draw once there's overflow — one full row short of `CHECKPOINT_DRAW_CAP`,
 * so the "+N more" badge can have the LAST row entirely to itself rather than sharing a row with
 * a real chip: a droplet's label ("⤳ 9999") and the badge's own ("+34 more") are both wide
 * enough that two side-by-side in the same row collide by rendered text width even though their
 * anchor points don't (caught by this file's own bbox test, not a guess).
 */
const CHECKPOINT_OVERFLOW_REAL_CAP = CHECKPOINT_COLS * (CHECKPOINT_ROWS_MAX - 1);
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
/**
 * #921 growth rule (issue anchors: `TRUNK`/`ringRadii`/`TRUNK_DROPLET_OFFSET`): the inner
 * clearance radius no ring may draw inside of — sized to the numeral's OWN rendered box
 * (half-diagonal from the disc centre, `RING_COUNT_FONT_PX` at `rings`' own digit count) rather
 * than a fixed guess, so a wider running total (more digits) automatically buys more clearance
 * instead of eventually colliding with a numeral a fixed radius never anticipated.
 */
export function ringInnerRadius(rings: number): number {
  const digits = String(rings).length;
  const halfWidth = (digits * RING_COUNT_FONT_PX * RING_COUNT_CHAR_ADVANCE) / 2;
  const above = RING_COUNT_FONT_PX * RING_COUNT_ASCENT - RING_COUNT_BASELINE_DY;
  const below = RING_COUNT_FONT_PX * RING_COUNT_DESCENT + RING_COUNT_BASELINE_DY;
  return Math.hypot(halfWidth, Math.max(above, below));
}
/**
 * #921: the mockup's own disc footprint — ~128px radius at 1440 (i.e. ~256px disc at 24 rings,
 * issue #921's "What") — capped at ~40% of the hero band height (the issue's own footprint
 * ceiling) so a future `STAGE.h` change can't silently push the disc past it; `Math.min` picks
 * whichever ceiling is tighter, rather than two independent, potentially-disagreeing caps.
 */
export const TRUNK_DISC_R_MAX = Math.min(128 / RENDER_SCALE_1440, 0.2 * STAGE.h);
/** #921: a ring pitch below this compresses past what a hairline stroke can actually resolve —
 *  the issue's own "≥ 1.5px [at 1440]" floor, converted to this file's SVG-unit space. */
const RING_PITCH_MIN = 1.5 / RENDER_SCALE_1440;
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
 * instead. Past that, floored at `ringInnerRadius(rings)` (never a bare `TRUNK.step`) — if the
 * drawn-ring array is ever empty despite `rings > 0` (a digit count wide enough that
 * `TRUNK.step`'s nominal reach never even fits one ring; not reached at any count this file's own
 * tests exercise), the numeral itself is still the real bottom edge to attach below.
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
 */
const RING_WORD_Y = TRUNK.y + 40;
const RING_WORD_RIGHT_X = TRUNK.x - 10;
/**
 * #886 gate② run 2e566ac9 finding [1]: where the newest-merge droplet parks, offset from
 * `dropletPoint`'s "trunk" case — frees the true trunk CENTER for the outcome number (below).
 * Chosen for vertical clearance from the number's own worst-case rendered box (a multi-digit
 * ring count centered at `TRUNK.y + 11`, `RING_COUNT_FONT_PX`): the droplet's own label sits 14px
 * above its shape (`hero-droplet`'s own `y=-14` convention). #921: widened -40 → -48 — growing
 * `RING_COUNT_FONT_PX` (33 → 48, AC2) grew the numeral's own box upward by the same amount,
 * eating most of the old offset's margin; -48 restores comparable clearance, verified against a
 * deliberately stressed digit count (3-digit ring total, 6-digit PR number) by `hero.test.ts`'s
 * own test, the same discipline #728's NEEDS_HUMAN_COL_STEP/ROW_STEP doc already uses for its own
 * cluster. The horizontal +40 component only keeps the marker visually near "where the merge arm
 * feeds in" (`GATES.review` → `TRUNK`), not load-bearing for the clearance itself.
 */
const TRUNK_DROPLET_OFFSET = { dx: 40, dy: -48 } as const;
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

const laneY = (index: number) => LANES.top + index * LANES.gap;

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
  // node along its own approach angle — the same "ease into the target" shape `hero-fixloop`'s
  // own curve already uses elsewhere on this stage.
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
      return { x: ESCALATION.x + col * NEEDS_HUMAN_COL_STEP, y: ESCALATION.y - 30 - row * NEEDS_HUMAN_ROW_STEP };
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
    case "trunk":
      return { x: TRUNK.x + TRUNK_DROPLET_OFFSET.dx, y: TRUNK.y + TRUNK_DROPLET_OFFSET.dy };
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

/** A droplet's fill token — §6/§5: `--sap` in motion, `--rust` stopped/escalated, `--moss` merged. */
function dropletFill(d: Droplet): string {
  if (d.at === "trunk") return "var(--moss)";
  if (d.failed || d.at === "needs-human") return "var(--rust)";
  return "var(--sap)";
}

/**
 * #879: the frozen baseline draws every issue token as a teardrop, not a bare circle. Kept
 * within the SAME ~9px reach the old `<circle r={9}>` had (tip at y=-9, belly arc capped at
 * y=+9, x within ±7) — `hero.test.ts`'s collision math (`circleBox(x, y, 9)`) treats a
 * droplet's footprint as that 9px-radius circle, and every hairline-margin overlap check in
 * this file (checkpoint grid, needs-human cluster, backlog column) was tuned against it; a
 * shape that grew past that footprint would silently invalidate those margins.
 */
const DROPLET_SHAPE = "M0,-9 C4,-4.5 7,-1 7,2 A7,7 0 1 1 -7,2 C-7,-1 -4,-4.5 0,-9 Z";

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

/**
 * #879: the frozen baseline draws a small glyph inside each PLAN circle — target (goal-align),
 * a tiny hierarchy (arch-review), a checkmark (verify). Hand-drawn vector primitives, not a new
 * icon-font/library dependency, matching how the stage already draws every other glyph (✓/✕
 * text, hairline shapes) — three static, tightly-scoped shapes don't earn a package.
 * `[data-active="true"] .hero-planning-icon` (hero.css) recolors the same way the node's own
 * circle does; the icon carries no state of its own.
 */
function planningIcon(node: (typeof PLANNING_NODES)[number]["node"], cx: number, cy: number) {
  switch (node) {
    case "goal-align":
      return (
        <g className="hero-planning-icon" data-icon="target">
          <circle cx={cx} cy={cy} r={6.5} />
          <circle className="hero-planning-icon-dot" cx={cx} cy={cy} r={1.6} />
        </g>
      );
    case "arch-review":
      return (
        <g className="hero-planning-icon" data-icon="tree">
          <line x1={cx} y1={cy - 4} x2={cx} y2={cy + 1} />
          <line x1={cx} y1={cy + 1} x2={cx - 6} y2={cy + 5} />
          <line x1={cx} y1={cy + 1} x2={cx + 6} y2={cy + 5} />
          <rect x={cx - 2} y={cy - 8} width={4} height={4} />
          <rect x={cx - 8} y={cy + 5} width={4} height={4} />
          <rect x={cx + 4} y={cy + 5} width={4} height={4} />
        </g>
      );
    case "verify":
      return (
        <g className="hero-planning-icon" data-icon="check">
          <path d={`M ${cx - 5} ${cy} L ${cx - 1.5} ${cy + 4} L ${cx + 5} ${cy - 5}`} />
        </g>
      );
  }
}

/**
 * #897 AC2: the frozen baseline draws a hand-drawn glyph inside each gate circle — a gear for
 * CI, an eye for Review — same "hand-drawn vector primitive, no icon-font" posture as
 * `planningIcon` above (two static, tightly-scoped shapes don't earn a package either). A
 * distinct `hero-gate-icon` class, not a reuse of `hero-planning-icon` — the two zones stay
 * separately countable (`hero.test.ts`'s own "one icon per PLAN node" oracle depends on
 * `hero-planning-icon` never drawing outside the planning trio); `hero.css` shares the actual
 * stroke styling between the two classes.
 */
function gateIcon(gate: "ci" | "review", cx: number, cy: number) {
  switch (gate) {
    case "ci":
      return (
        <g className="hero-gate-icon" data-icon="gear">
          <circle cx={cx} cy={cy} r={7} />
          <circle className="hero-planning-icon-dot" cx={cx} cy={cy} r={2.2} />
          {[0, 45, 90, 135].map((deg) => (
            <line
              key={deg}
              x1={cx + 10 * Math.cos((deg * Math.PI) / 180)}
              y1={cy + 10 * Math.sin((deg * Math.PI) / 180)}
              x2={cx - 10 * Math.cos((deg * Math.PI) / 180)}
              y2={cy - 10 * Math.sin((deg * Math.PI) / 180)}
            />
          ))}
        </g>
      );
    case "review":
      return (
        <g className="hero-gate-icon" data-icon="eye">
          <path d={`M ${cx - 11} ${cy} Q ${cx} ${cy - 8} ${cx + 11} ${cy} Q ${cx} ${cy + 8} ${cx - 11} ${cy} Z`} />
          <circle className="hero-planning-icon-dot" cx={cx} cy={cy} r={2.6} />
        </g>
      );
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
  const reviewMode = config ? readConfigPath(config, "reviewer.mode") : undefined;
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
  // #716 gate② round 2 P2-5: the fix-return arrow's own label (§6: "labeled with the send-back
  // reason") — the first currently-fixing lane, in channel order.
  const fixingReason = state.lanes.find((l) => l.phase === "fixing")?.reason ?? null;
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
        <rect className="hero-well" x={BACKLOG.x} y={BACKLOG.y} width={BACKLOG.w} height={210} rx={6} />
        {state.pool.slice(0, BACKLOG_FILLED_CAP).map((issue, i) => (
          <g className="hero-pool-chip" key={issue} data-issue={issue}>
            <rect
              style={{ fill: "var(--sap)" }}
              x={BACKLOG.x + 8}
              y={BACKLOG.y + 6 + i * BACKLOG.chip}
              width={BACKLOG.w - 16}
              height={24}
              rx={8}
            />
            {/* #879: --heartwood is the frozen baseline's dark-on-amber card text — it inverts
             * with --sap the same way it inverts with the page ground, so one token reads dark
             * on the bright dark-theme amber AND light on the darker light-theme amber. */}
            <text
              className="hero-num hero-pool-num"
              x={BACKLOG.x + BACKLOG.w / 2}
              y={BACKLOG.y + 22 + i * BACKLOG.chip}
              textAnchor="middle"
            >
              ⊙ {issue}
            </text>
          </g>
        ))}
        {/* #897 AC4: the rest of the ready pool — an outlined candidate stack, distinguishable
         * from the filled cards above rather than folded into the same filled-chip list. */}
        {state.pool.slice(BACKLOG_FILLED_CAP).map((issue, i) => (
          <g className="hero-pool-candidate" key={issue} data-issue={issue}>
            <rect x={BACKLOG.x + 8} y={BACKLOG.y + 6 + (i + BACKLOG_FILLED_CAP) * BACKLOG.chip} width={BACKLOG.w - 16} height={24} rx={8} />
            <text
              className="hero-num"
              x={BACKLOG.x + BACKLOG.w / 2}
              y={BACKLOG.y + 22 + (i + BACKLOG_FILLED_CAP) * BACKLOG.chip}
              textAnchor="middle"
            >
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
            <g
              key={n.node}
              data-active={activePlanning === n.node ? "true" : "false"}
              {...inspectProps(n.node, `inspect ${n.label}`, onInspect)}
            >
              <title>{n.hint}</title>
              {hitTarget(PLANNING.x - PLANNING_NODE_R - 4, n.y - PLANNING_NODE_R - 4, PLANNING_NODE_R * 2 + 178, PLANNING_NODE_R + 38)}
              <circle className="hero-planning-node" cx={PLANNING.x} cy={n.y} r={PLANNING_NODE_R} />
              {planningIcon(n.node, PLANNING.x, n.y)}
              <text className="hero-node-label" x={PLANNING.x + PLANNING_NODE_R + 14} y={n.y + 4}>
                {n.label}
              </text>
              {caption && (
                <text className="hero-node-caption" x={PLANNING.x + PLANNING_NODE_R + 14} y={n.y + 17}>
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
                  y={laneY(lane.channel) + (lane.phase === "fixing" ? 14 : -10)}
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
            {/* #897 AC1: the send-back reason renders as plain upright text below the return
             * leg — the per-lane caption flash (above) narrates WHICH lane, this narrates WHAT
             * the loop is doing. A `textPath` riding the arrow's own curve rendered the word
             * rotated ~180° at this stretch (the curve runs right-to-left here); plain text has
             * no path to inherit a direction from. One shared label; when several lanes are
             * fixing at once, the first (channel order) wins rather than concatenating an
             * ambiguous list. */}
            <text className="hero-fixloop-label" x={FIXLOOP_LABEL.x} y={FIXLOOP_LABEL.y} textAnchor="middle">
              {fixingReason}
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
        {/* #897 AC2: large circular gate nodes with a hand-drawn icon marker (`gateIcon`), not
         * the small rects this stage used to draw — the primary "CI"/"Review" label moves below
         * the circle (the circle itself carries the icon), matching the planning trio's own
         * circle-then-label-below convention. */}
        <g className="hero-gate" data-gate="ci" data-state={gateState} {...inspectProps("ci", "inspect CI", onInspect)}>
          {hitTarget(GATES.ci - GATES.r - 4, GATES.y - GATES.r - 30, GATES.r * 2 + 8, GATES.r * 2 + 60)}
          <circle className="hero-gate-node" cx={GATES.ci} cy={GATES.y} r={GATES.r} />
          {gateIcon("ci", GATES.ci, GATES.y)}
          <text className="hero-node-label" x={GATES.ci} y={GATES.y + GATES.r + 16} textAnchor="middle">
            CI
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
          <text className="hero-node-label" x={GATES.review} y={GATES.y + GATES.r + 16} textAnchor="middle">
            Review
          </text>
          <text className="hero-gate-check" x={GATES.review + GATES.r - 4} y={GATES.y - GATES.r + 6} textAnchor="middle">
            ✓
          </text>
          {/* §6: REVIEW carries the review MODE word (e.g. "codex", "engine-agent"), not a
           * model·effort pair — it isn't itself model-backed, the mode just names which
           * reviewer runs.
           * #745 gate② round 5 PO pre-merge Tier-C probe (1700px, live DB): a drawn checkpoint
           * chip's label bbox-intersected this caption — pushed further from the gate box as the
           * cheap half of the fix, paired with the checkpoint grid's own extra clearance below
           * (`dropletPoint`'s checkpoint case).
           * #897: moved ABOVE the circle (`GATES.y - GATES.r - 12`) — the space below the circle
           * is spoken for by the "Review" word label
           * alone (`GATES`'s own doc: no room below for two stacked lines before the needs-human
           * cluster's fixed ceiling). Above the circle sits comfortably clear of the checkpoint
           * grid's own closest content — same doc's own margin accounting. */}
          {typeof reviewMode === "string" && (
            <text className="hero-node-caption" x={GATES.review} y={GATES.y - GATES.r - 12} textAnchor="middle">
              {reviewMode}
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
          d={`M ${ESCALATION.x} ${GATES.y} L ${ESCALATION.x} ${ESCALATION.y - 18}`}
        />
        <circle style={{ stroke: "var(--rust)" }} cx={ESCALATION.x} cy={ESCALATION.y} r={13} />
        <text className="hero-node-label" x={ESCALATION.x + 24} y={ESCALATION.y + 4}>
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
             * low-ring-count case a live probe actually captures. `TRUNK_DROPLET_OFFSET` (above)
             * moves the DROPLET out of the way instead, so this can stay truly centered at any ring
             * count. +11 is a baseline-centering nudge for the display font's cap-height, not a
             * collision-avoidance number. #921 AC2: `fontSize` is now inline (`RING_COUNT_FONT_PX`,
             * ≥ 56px at 1440 — the frozen mockup's own cap-height "24") rather than `hero.css`'s old
             * `--text-4` (33px, whose 1.25-ratio ladder tops out short of the floor). */}
            <text
              className="hero-ring-count"
              style={{ fontFamily: "var(--font-display)", fontSize: RING_COUNT_FONT_PX }}
              x={TRUNK.x}
              y={TRUNK.y + 11}
              textAnchor="middle"
            >
              {state.rings}
            </text>
            {/* #920 gate② finding [0]: right-anchored (`RING_WORD_RIGHT_X`'s own doc) — the stem's
             * own start now shrinks with the ring count, leaving no safe Y-gap to sit in at a low
             * count, so this clears the stem's shared x column instead. */}
            <text className="hero-label" x={RING_WORD_RIGHT_X} y={RING_WORD_Y} textAnchor="end">
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
          return (
            <g
              key={n.node}
              data-active={activeReflection === n.node ? "true" : "false"}
              {...inspectProps(n.node, `inspect ${n.label}`, onInspect)}
            >
              <circle className="hero-planning-node" cx={n.x} cy={REFLECTION.y} r={REFLECTION.r} />
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
              <path className="hero-droplet-shape" d={DROPLET_SHAPE} style={{ fill: dropletFill(d) }} />
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
         * lowest row (`ESCALATION.y - 30`, itself well above this y), below the node's own
         * label/circle, and above the dashed return path's horizontal leg (`STAGE.h - 20`).
         * Shortened text, verified collision-free against every neighboring caption/tally by
         * `hero.test.ts`'s own worst-case stress test, the same discipline this file's other
         * geometry constants already cite. */}
        {collapsedCount > 0 && (
          <text
            className="hero-num hero-small hero-badge hero-attention-collapsed"
            data-count={collapsedCount}
            x={ESCALATION.x}
            y={ESCALATION.y + 34}
            textAnchor="middle"
          >
            +{collapsedCount} earlier — see strip
          </text>
        )}
      </g>
    </svg>
  );
}

/**
 * Radii for the cross-section, outermost = newest — empty at zero rings (the sapling glyph
 * draws instead, `HeroStage`'s own trunk group).
 *
 * ponytail: capped at TRUNK.max drawn rings — the count text is the real record, and a disc
 * of 400 hairlines is a grey blob. Lift the cap only if the disc ever needs to be exact.
 *
 * #921 growth rule: pitch stays the nominal `TRUNK.step` while the whole drawn set still fits
 * inside `TRUNK_DISC_R_MAX` past the inner clearance (`ringInnerRadius`, sized to `rings`' own
 * digit count — the REAL total, not the capped `drawn` count, since the numeral shows the real
 * total even once ring-drawing itself saturates). Once it wouldn't fit, EVERY ring's pitch
 * compresses together (never just the newest ones) so the outermost ring lands exactly on the
 * ceiling instead of overshooting it, floored at `RING_PITCH_MIN` so a stroke never blurs into
 * unreadable sub-hairline spacing — verified within `TRUNK_DISC_R_MAX` for ring totals up to two
 * digits (`hero.test.ts`'s own AC3, N ≤ `TRUNK.max`); a 3+-digit running total's bigger inner
 * clearance can compress the floor-bound pitch enough to push the outer radius slightly past
 * `TRUNK_DISC_R_MAX` — accepted, since the issue's own footprint numbers are an explicit "~"
 * mockup-scale target, not a hard viewBox bound, and `TRUNK.max`'s existing "count is the
 * record" cap still bounds how many rings ever draw regardless.
 */
function ringRadii(rings: number): number[] {
  const drawn = Math.min(rings, TRUNK.max);
  if (drawn === 0) return [];
  const r0 = ringInnerRadius(rings);
  const nominalReach = r0 + drawn * TRUNK.step;
  const pitch = nominalReach <= TRUNK_DISC_R_MAX ? TRUNK.step : Math.max((TRUNK_DISC_R_MAX - r0) / drawn, RING_PITCH_MIN);
  return Array.from({ length: drawn }, (_, i) => r0 + (i + 1) * pitch);
}
