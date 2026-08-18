import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import { parseTokens } from "../contrast.ts";
import { CI_CAPTION } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import { toDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
// #892: must resolve before "./Legend.tsx" (transitively imports Radix, via Popover) — see this
// module's own doc for why registerRealDom()'s deferred (test.before) registration is too late
// for Radix's useLayoutEffect shim, which decides whether happy-dom exists at MODULE EVALUATION
// time.
import { unregisterRealDomEager } from "../test-dom-eager.ts";
import { Hero } from "./Hero.tsx";
import { LEGEND_ITEMS, Legend } from "./Legend.tsx";
import {
  BACKLOG,
  CHECKPOINT_DRAW_CAP,
  CHECKPOINT_OVERFLOW_REAL_CAP,
  checkpointOverflowPoint,
  DROPLET_NUM_FONT_PX,
  dropletPath,
  dropletPoint,
  dropletRadius,
  ESCALATION,
  ESCALATION_R,
  GATES,
  HeroStage,
  LANES,
  NODE_CAPTION_OFFSET,
  NODE_LABEL_OFFSET,
  PHASE_X,
  PLANNING,
  PLANNING_NODE_R,
  REAL_RENDER_SCALE_1440,
  REFLECTION,
  RING_COUNT_FONT_PX,
  RING_PITCH_MIN,
  ringCountFontPx,
  ringInnerRadius,
  ringOuterRadius,
  ringRadii,
  STAGE,
  TRUNK,
  TRUNK_DISC_R_MAX,
} from "./stage.tsx";
import {
  activePlanningNode,
  activeReflectionNode,
  type Droplet,
  foldEvents,
  type HeroState,
  initialHeroState,
  isStageDimmed,
  type LaneView,
  planTransitions,
  sendBackReason,
  type Transition,
  transitionOrigin,
  visibleLanes,
  withFoldTruncated,
  withLaneCount,
  withLanePrs,
  withVisibleLanes,
} from "./state.ts";

let seq = 0;
// `known: false` here is a test-fixture simplification, not a claim about these kinds' real
// classification — `state.ts`'s fold reads `kind`/`payload` only and never branches on `known`,
// so an UnknownDomainEvent shape exercises the exact same code path as a KnownDomainEvent would.
const ev = (kind: string, payload: Record<string, unknown> = {}): DomainEvent => ({
  known: false,
  id: ++seq,
  ts: new Date(Date.UTC(2026, 6, 24, 12, 0, seq)).toISOString(),
  kind,
  payload,
});

test.after(() => unregisterRealDomEager());

/** Fold a script from a fresh stage; the tests assert on both halves of the result. */
const run = (events: DomainEvent[], lanesMax: number | null = 3) => foldEvents(initialHeroState(lanesMax), events);

const kinds = (ts: Transition[]) => ts.map((t) => t.kind);
const droplet = (state: HeroState, issue: number) => state.droplets.find((d) => d.issue === issue);
// `lanesMax: 3` matches `run()`'s own default — every call site whose state was built with a
// different lanesMax passes it explicitly via `extra` (`withVisibleLanes` only ever CAPS from
// above, so a state with fewer lanes than the default is unaffected either way).
const markup = (state: HeroState, extra: Partial<Parameters<typeof HeroStage>[0]> = {}) =>
  renderToStaticMarkup(createElement(HeroStage, { state, lanesMax: 3, fixCap: 2, ...extra }));

/** #922 AC2: the bare number a droplet's belly is sized to fit — mirrors production's
 *  `dropletNumber` (stage.tsx): the PR once one exists, else the issue number. Never a prefix —
 *  the kind mark is a separate, secondary rendered element. */
const dropletNumberText = (d: Droplet) => String(d.pr === null ? d.issue : d.pr);

/** #922 AC2: a droplet's own rendered KIND mark + NUMBER, read straight off the `<g>` element
 *  carrying `data-issue={issue}` — the two are separate `<text>` elements. Returns `null` when no
 *  such droplet is drawn at all — the caller's own "must not draw" assertions use that directly,
 *  rather than a text-content regex that could trivially match nothing yet still "pass". */
function dropletKindAndNumber(html: string, issue: number): { kind: string; number: string } | null {
  const g = html.match(new RegExp(`<g class="hero-droplet" data-issue="${issue}"[^>]*>([\\s\\S]*?)<\\/g>`));
  if (!g) return null;
  const inner = g[1] as string;
  const kind = inner.match(/class="hero-droplet-kind"[^>]*>([^<]*)<\/text>/)?.[1] ?? "";
  const number = inner.match(/class="hero-num hero-droplet-num"[^>]*>([^<]*)<\/text>/)?.[1] ?? "";
  return { kind, number };
}
const heroCss = readFileSync(new URL("./hero.css", import.meta.url), "utf8");
// #886 final gate②: the computed-style test below used to inject ONLY `heroCss` — production
// actually cascades tokens.css → panels.css → hero.css, then app.css's own `body { ... }` rule
// (app.css's imports run first, its own rules after), so a same-specificity override landing
// in any of those other files, outside hero.css, could win in production while this test never
// saw it at all. Mirrors `Header.test.tsx`'s `.spend-meter-value` fix (#886 run 2e566ac9
// finding [3]) — full production cascade, in production order, not a partial mount.
const tokensCss = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const panelsCss = readFileSync(new URL("../panels.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const bodyFontSizeRule = appCss.match(/body\s*\{[^}]*\}/)?.[0];

// ── §6 transition table — one row at a time ────────────────────────────────────
// AC 1: "every event kind listed in the §6 transition table has a corresponding
// animation implemented, matching the described behavior".

test("§6 `dispatched`: droplet leaves the backlog for a lane channel, lane lights", () => {
  const poolEv = ev("pool-selected", { issues: [86, 88] });
  const dispatchEv = ev("dispatched", { worker: "w1", issue: 86 });
  const { state, transitions } = run([poolEv, dispatchEv]);

  assert.deepEqual(kinds(transitions), ["dispatch"]);
  assert.deepEqual(droplet(state, 86), {
    issue: 86,
    pr: null,
    lane: "w1",
    at: "lane",
    failed: false,
    handedOff: false,
    sendBack: null,
    touchedAt: dispatchEv.id,
    checkpointRank: null,
    roundId: null,
  });
  assert.equal(state.lanes[0]?.phase, "writing");
  assert.equal(state.lanes[0]?.issue, 86);
  // a dispatched issue is no longer a pending selection
  assert.deepEqual(state.pool, [88]);
});

test("§6 lane `running → driving`: droplet parks at the checkpoint pair", () => {
  // The engine's real payload — `{ worker, issue, next }`, no `pr`: conductor.ts stores the
  // PR on the worker row and the event carries only the transition. The tag comes from the
  // live lane overlay below, never from an invented payload field.
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING" }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint"]);
  assert.equal(droplet(state, 86)?.at, "checkpoint");
  assert.equal(state.lanes[0]?.phase, "driving");
});

test("the PR tag comes from the live lane overlay, since `reclaim-done` carries no PR number", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 86 }), ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING" })]);
  assert.equal(droplet(state, 86)?.pr, null);
  // #922 AC2: the kind mark (⊙) and the number (86) are two separate rendered elements —
  // `dropletKindAndNumber` reads both off the droplet's own `<g data-issue="86">`.
  assert.deepEqual(dropletKindAndNumber(markup(state), 86), { kind: "⊙", number: "86" });

  const tagged = withLanePrs(state, [{ lane: "w1", pr: 97 }]);
  assert.equal(droplet(tagged, 86)?.pr, 97);
  assert.deepEqual(dropletKindAndNumber(markup(tagged), 86), { kind: "⤳", number: "97" });

  assert.equal(droplet(withLanePrs(state, [{ lane: "w1", pr: null }]), 86)?.pr, null);
  assert.equal(droplet(withLanePrs(tagged, [{ lane: "w1", pr: 12 }]), 86)?.pr, 97);
  assert.equal(withLanePrs(state, []), state);
});

test("in replay the PR tag arrives with the first PR-bearing event", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING" }),
    ev("drive-queued", { worker: "w1", issue: 86, pr: 97, reason: "queued" }),
  ]);

  assert.equal(droplet(state, 86)?.pr, 97);
  assert.equal(droplet(state, 86)?.at, "checkpoint");
});

// ── #927 AC2 (§729 remainder, D35; Q4 owner ruling): the lane-narrative fields replay needs —
// `startedAt`, settled `costUsd`/`estCostUsd`/`costEstimated` — learned ONLY from `dispatched`'s
// own `ts` and `reclaim-done`'s own payload, never a live probe. ─────────────────────────────

test("#927 AC2: dispatched stamps startedAt and clears any prior cost; reclaim-done(DRIVING) settles cost onto the SAME lane, keeping the original dispatch clock", () => {
  const dispatchEv = ev("dispatched", { worker: "w1", issue: 94 });
  const { state: afterDispatch } = run([dispatchEv], 1);
  assert.equal(afterDispatch.lanes[0]?.phase, "writing");
  assert.equal(afterDispatch.lanes[0]?.startedAt, dispatchEv.ts);
  assert.equal(afterDispatch.lanes[0]?.costUsd, null);
  assert.equal(afterDispatch.lanes[0]?.estCostUsd, null);

  const reclaimEv = ev("reclaim-done", { worker: "w1", issue: 94, next: "DRIVING", costUsd: 1.1, estCostUsd: 1.05, costEstimated: false });
  const { state: afterReclaim } = run([dispatchEv, reclaimEv], 1);
  assert.equal(afterReclaim.lanes[0]?.phase, "driving");
  assert.equal(
    afterReclaim.lanes[0]?.startedAt,
    dispatchEv.ts,
    "a settled leg on the same worker keeps the ORIGINAL dispatch clock, not reclaim-done's own ts",
  );
  assert.equal(afterReclaim.lanes[0]?.costUsd, 1.1);
  assert.equal(afterReclaim.lanes[0]?.estCostUsd, 1.05);
  assert.equal(afterReclaim.lanes[0]?.costEstimated, false);
  // `reclaim-done` here carries no `pr` field — the PR tag is still unknown at this cursor.
  assert.equal(droplet(afterReclaim, 94)?.pr, null);

  // `merged` frees the lane (matches live's own `activeWorkers()` exclusion of a lane no
  // longer occupied) — the story continues on the droplet, not the released channel.
  const mergedEv = ev("merged", { worker: "w1", issue: 94, pr: 96 });
  const { state: afterMerged } = run([dispatchEv, reclaimEv, mergedEv], 1);
  assert.equal(afterMerged.lanes[0]?.worker, null);
  assert.equal(afterMerged.lanes[0]?.startedAt, null);
  assert.equal(afterMerged.lanes[0]?.costUsd, null);
  assert.equal(droplet(afterMerged, 94)?.pr, 96);
});

test("#927: a handoff frees the lane — startedAt/settled cost reset, ready for a fresh occupant", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 90 }), ev("handoff", { worker: "w1", issue: 90 })], 1);
  assert.equal(state.lanes[0]?.worker, null);
  assert.equal(state.lanes[0]?.startedAt, null);
  assert.equal(state.lanes[0]?.costUsd, null);
});

test("#927: est never renders while the lane is running — no reclaim-done yet means no fabricated cost figure", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 90 })], 1);
  assert.equal(state.lanes[0]?.costUsd, null);
  assert.equal(state.lanes[0]?.estCostUsd, null);
});

test("#927: a mid-fix handoff releases the lane's clock; fix-leg-resumed on a fresh claim re-stamps it, a same-worker fix round never resets it", () => {
  const dispatchEv = ev("dispatched", { worker: "w1", issue: 90 });
  const reclaimEv = ev("reclaim-done", { worker: "w1", issue: 90, next: "DRIVING", costUsd: 2, estCostUsd: 1.8, costEstimated: false });
  const fixStartEv = ev("fix-leg-started", { worker: "w1", issue: 90, fixRounds: 1 });
  const { state: sameWorker } = run([dispatchEv, reclaimEv, fixStartEv], 1);
  assert.equal(sameWorker.lanes[0]?.startedAt, dispatchEv.ts, "same worker, never released — original clock stands");

  const handoffEv = ev("handoff", { worker: "w1", issue: 90 });
  const resumeEv = ev("fix-leg-resumed", { worker: "w2", issue: 90, fixRounds: 1 });
  const { state: resumed } = run([dispatchEv, reclaimEv, handoffEv, resumeEv], 1);
  assert.equal(resumed.lanes[0]?.startedAt, resumeEv.ts, "released by the handoff — fix-leg-resumed re-stamps a fresh clock");
});

test("§6: the checkpoint pair is one waiting state — CI / Review, never gate①/gate②, never per-gate progress", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
  ]);
  const html = markup(state);

  assert.match(html, /data-gate="ci" data-state="waiting"/);
  assert.match(html, /data-gate="review" data-state="waiting"/);
  assert.equal(html.match(/data-state="waiting"/g)?.length, 2);
  assert.match(html, />CI</);
  assert.match(html, />Review</);
  assert.doesNotMatch(html, /gate[①②12]/i);
});

test("§6 `reclaim-done` without a PR frees the lane and stages nothing", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "ESCALATE_NOPR" }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch"]);
  assert.equal(droplet(state, 86), undefined);
  assert.equal(state.lanes[0]?.phase, "idle");
});

test("§6 `drive-fixup` (assumed order, reason already known) → `fix-leg-started`: droplet returns into its own lane with the send-back reason", () => {
  // This is the ASSUMED order — `drive-fixup` names the reason before the lane starts fixing.
  // It's a real, still-supported path (e.g. a mid-fix handoff/resume, covered below), but it
  // is NOT production's typical order for the first `fix-leg-started` of a fix round — see
  // the PRODUCTION-order test right after this one (#716 gate② P2-6).
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", {
      worker: "w1",
      issue: 86,
      pr: 97,
      fixRounds: 1,
      reason: "gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=2:ciRed=false",
    }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint", "fix-return"]);
  const fix = transitions[2];
  assert.ok(fix?.kind === "fix-return");
  assert.equal(fix.reason, "review findings");
  assert.equal(fix.round, 1);
  assert.equal(droplet(state, 86)?.at, "lane");
  assert.equal(state.lanes[0]?.phase, "fixing");
  assert.equal(state.lanes[0]?.fixRound, 1);
  assert.match(markup(state), /FIXING · round 1 of 2/);
});

test("§6 `fix-leg-started` → `drive-fixup`: PRODUCTION event order corrects the fallback reason label in place", () => {
  // #716 gate② P2-6: the engine durably writes `fix-leg-started` BEFORE `drive-fixup` — by
  // the time the real reason arrives, the droplet is already back in its lane wearing the
  // generic "review findings" fallback (neither event's own payload can see the other's
  // field). The ORIGINAL version of the test above exercised the opposite (assumed) order,
  // which happened to pass regardless of the bug because its chosen reason string mapped to
  // the SAME word as the fallback either way — this uses a DIFFERENT reason specifically so
  // the fallback and the correction are distinguishable.
  const started = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);

  assert.deepEqual(kinds(started.transitions), ["dispatch", "to-checkpoint", "fix-return"]);
  const fix = started.transitions[2];
  assert.ok(fix?.kind === "fix-return");
  // No `drive-fixup` has arrived yet — the fold has nothing to name the reason from, so the
  // droplet returns wearing the honest fallback, never a guess.
  assert.equal(fix.reason, "review findings");
  assert.equal(started.state.lanes[0]?.phase, "fixing");
  assert.equal(started.state.lanes[0]?.reason, "review findings");
  assert.match(markup(started.state), /review findings/);

  const corrected = foldEvents(started.state, [
    ev("drive-fixup", {
      worker: "w1",
      issue: 86,
      pr: 97,
      fixRounds: 1,
      reason: "gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=0:ciRed=true",
    }),
  ]);

  assert.deepEqual(kinds(corrected.transitions), ["fix-reason"]);
  const reasonFix = corrected.transitions[0];
  assert.ok(reasonFix?.kind === "fix-reason");
  assert.equal(reasonFix.reason, "checks failed");
  assert.equal(reasonFix.lane, "w1");
  assert.equal(corrected.state.lanes[0]?.reason, "checks failed");
  assert.equal(droplet(corrected.state, 86)?.sendBack, "checks failed");
  assert.match(markup(corrected.state), /checks failed/);
  assert.doesNotMatch(markup(corrected.state), /review findings/);
});

test("#728: the fix-return arc mounts only for an active fix loop and unmounts once it ends", () => {
  // No fixing lane at all — not just the label, the arc PATH element itself must be absent
  // (the AC's own wording: "render only during an active fix loop"), never a labelless arc
  // left drawn as visual debris.
  assert.doesNotMatch(markup(initialHeroState(3)), /<path id="hero-fixloop-path"/);

  const fixing = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", { worker: "w1", issue: 86, pr: 97, fixRounds: 1, reason: "gate:FIXABLE:merge-conflict" }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);
  const fixingHtml = markup(fixing.state);
  assert.match(fixingHtml, /<path id="hero-fixloop-path"/);
  assert.match(fixingHtml, /<text class="hero-fixloop-label"[^>]*>merge conflict<\/text>/);

  // The fix loop ends — the lane merges straight out of `fixing` — and folding that event
  // must fold the arc itself away, not just its label.
  const folded = foldEvents(fixing.state, [ev("merged", { worker: "w1", issue: 86, pr: 97 })]);
  const foldedHtml = markup(folded.state);
  assert.doesNotMatch(foldedHtml, /<path id="hero-fixloop-path"/);
  assert.doesNotMatch(foldedHtml, /hero-fixloop-label/);
});

test("§6 `fix-leg-resumed` re-lights the same fixing state after a handoff", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", { worker: "w1", issue: 86, pr: 97, fixRounds: 1, reason: "gate:FIXABLE:merge-conflict" }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
    ev("handoff", { worker: "w1", issue: 86 }),
    ev("fix-leg-resumed", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);

  assert.equal(kinds(transitions).at(-1), "fix-return");
  assert.equal(state.lanes[0]?.phase, "fixing");
  assert.equal(state.lanes[0]?.reason, "merge conflict");
  assert.equal(droplet(state, 86)?.at, "lane");
  assert.equal(droplet(state, 86)?.handedOff, false);
});

test("#716 gate②: the fix-return arrow carries the send-back reason as its own label, not only the lane caption", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", { worker: "w1", issue: 86, pr: 97, fixRounds: 1, reason: "gate:FIXABLE:merge-conflict" }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);
  const html = markup(state);
  assert.match(html, /<path id="hero-fixloop-path"/);
  assert.match(html, /<text class="hero-fixloop-label"[^>]*>merge conflict<\/text>/);

  // No fixing lane at all — no label on the arrow.
  assert.doesNotMatch(markup(initialHeroState(3)), /hero-fixloop-label/);
});

test("#897 AC1: the fix-loop label renders as plain upright text below the return leg, not a textPath riding the arrow", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", { worker: "w1", issue: 86, pr: 97, fixRounds: 1, reason: "gate:FIXABLE:merge-conflict" }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);
  const html = markup(state);

  // Plain text, not a textPath riding the arrow's own (right-to-left, at this stretch) curve —
  // no `<textPath>` element at all, so there is no path direction for the label to inherit a
  // rotation from.
  assert.doesNotMatch(html, /<textPath/);

  const labelMatch = html.match(/<text class="hero-fixloop-label" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>merge conflict<\/text>/);
  assert.ok(labelMatch, "the label must render as a plain <text> element carrying its own x/y");
  assert.doesNotMatch(labelMatch![0], /rotate\(/, "no rotation transform on the label");

  // Below the return leg's own deepest dip (the arc's control-point y, `GATES.y + 78`) —
  // distinct from the arrow's own path, which the label no longer rides.
  assert.ok(Number(labelMatch![2]) > GATES.y + 78, "the label must sit below the return leg's deepest point");
});

test("sendBackReason maps the engine's gate reason to the three §6/§7 words", () => {
  assert.equal(sendBackReason("gate:FIXABLE:merge-conflict"), "merge conflict");
  assert.equal(sendBackReason("gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=0:ciRed=true"), "checks failed");
  assert.equal(sendBackReason("gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=3:ciRed=false"), "review findings");
  assert.equal(sendBackReason(undefined), "review findings");
});

test("§6 `fix-rounds-capped`, `fix-leg-verdict-rerun` and `drive-needs-human` park the droplet on the escalation branch", () => {
  for (const kind of ["fix-rounds-capped", "fix-leg-verdict-rerun", "drive-needs-human"]) {
    const { state, transitions } = run([
      ev("dispatched", { worker: "w1", issue: 86 }),
      ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
      ev(kind, { worker: "w1", issue: 86, pr: 97, reason: "flaky", cap: 2, fixRounds: 2 }),
    ]);

    assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint", "escalate"], kind);
    assert.equal(droplet(state, 86)?.at, "needs-human", kind);
    assert.equal(state.lanes[0]?.phase, "idle", kind);
    assert.match(markup(state), /data-node="needs-human" data-count="1"/, kind);
  }
});

test("§6 `merged`: gates flash ✓, the droplet becomes a ring, the counter increments", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("merged", { worker: "w1", issue: 86, pr: 97, headOid: "abc" }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint", "ring"]);
  assert.equal(state.rings, 1);
  assert.equal(droplet(state, 86)?.at, "trunk");
  assert.equal(state.lanes[0]?.phase, "idle");

  const html = markup(state);
  assert.match(html, /class="hero-ring-count"[^>]*>1</);
  assert.equal(html.match(/class="hero-ring"/g)?.length, 1);
  // #716 gate② P2-5: the merged flash is a REAL ✓ glyph element on each gate, not just the
  // rect's border color — targets `.hero-gate-check` specifically, not the unrelated ✓ every
  // merged droplet's own label already carries (`stage.tsx`'s `d.at === "trunk" ? "✓ " : ""`),
  // which the old loose `/✓/` match could never actually distinguish from.
  assert.equal(html.match(/class="hero-gate-check"/g)?.length, 2, "both CI and Review gates carry the ✓ glyph element");
});

test("#897 AC2: CI and Review render as circular gate nodes carrying a hand-drawn icon marker, not rects", () => {
  const html = markup(initialHeroState(3));
  const ciGate = html.match(/<g class="hero-gate" data-gate="ci"[^>]*>([\s\S]*?)<\/g>\s*<g class="hero-gate" data-gate="review"/);
  assert.ok(ciGate, "the CI gate group must render");
  assert.match(ciGate![1] as string, /<circle class="hero-gate-node"/, "CI must render as a <circle>, not the old <rect>");
  // #920 gate② review thread (PRRT…FAN): the only <rect> now inside a gate is the invisible
  // `.hero-hit-target` (a real, deliberate fix for a Playwright click regression) — the check
  // narrows to "no VISIBLE rect" instead of "no rect at all".
  assert.doesNotMatch(ciGate![1] as string, /<rect(?! class="hero-hit-target")/, "no visible <rect> left inside the CI gate");
  // #922 AC7: CI's icon swaps to the standard GitHub Actions asset — the old hand-drawn gear is
  // gone entirely, nowhere in the hero.
  assert.match(ciGate![1] as string, /data-icon="github-actions"/, "CI carries the GitHub Actions icon marker");
  assert.doesNotMatch(html, /data-icon="gear"/, 'no data-icon="gear" anywhere in the hero');

  const reviewGate = html.match(/<g class="hero-gate" data-gate="review"[^>]*>([\s\S]*?)<\/g>\s*<line/);
  assert.ok(reviewGate, "the Review gate group must render");
  assert.match(reviewGate![1] as string, /<circle class="hero-gate-node"/, "Review must render as a <circle>, not the old <rect>");
  assert.doesNotMatch(reviewGate![1] as string, /<rect(?! class="hero-hit-target")/, "no visible <rect> left inside the Review gate");
  assert.match(reviewGate![1] as string, /data-icon="eye"/, "Review carries its icon marker via the existing data-icon convention");
});

test("#897 AC2: Summary/Retro reflection nodes sit below the trunk/outcome disc, not beside it at TRUNK.y", () => {
  const html = markup(initialHeroState(3));
  const nodeYs = [
    ...html.matchAll(new RegExp(`<circle class="hero-planning-node" cx="(-?[\\d.]+)" cy="(-?[\\d.]+)" r="${REFLECTION.r}">`, "g")),
  ].map(([, , y]) => Number(y));
  assert.equal(nodeYs.length, 2, "both Summary and Retro nodes must render");
  for (const y of nodeYs) assert.ok(y > TRUNK.y, `reflection node y=${y} must sit below TRUNK.y=${TRUNK.y}`);
});

test("§6 `handoff`: droplet folds back into the backlog with a progress badge", () => {
  const { state, transitions } = run([ev("dispatched", { worker: "w1", issue: 86 }), ev("handoff", { worker: "w1", issue: 86 })]);

  assert.deepEqual(kinds(transitions), ["dispatch", "handoff"]);
  assert.equal(droplet(state, 86)?.at, "backlog");
  assert.equal(droplet(state, 86)?.handedOff, true);
  assert.equal(state.lanes[0]?.phase, "idle");
  assert.match(markup(state), /saved for a successor/);
});

test("#891 'What': a fresh `dispatched` (not just `fix-leg-resumed`) ages out a stale handoff badge on re-dispatch", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("handoff", { worker: "w1", issue: 86 }),
    // A later round picks the same issue back up from scratch — not a fix-loop resume.
    ev("dispatched", { worker: "w2", issue: 86 }),
  ]);
  assert.equal(droplet(state, 86)?.handedOff, false);
  assert.equal(droplet(state, 86)?.at, "lane");
  assert.doesNotMatch(markup(state), /saved for a successor/);
});

test("a rescued `reclaim-failed` is a recovery, not a failure — it drives on", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-failed", { worker: "w1", issue: 86, next: "DRIVING" }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint"]);
  assert.equal(droplet(state, 86)?.failed, false);
  assert.equal(droplet(state, 86)?.at, "checkpoint");
  assert.equal(state.lanes[0]?.phase, "driving");
  assert.doesNotMatch(markup(state), /✕/);
});

test("a rescued `reclaim-dead` is a recovery too — flagged by `rescued`, not `next`", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-dead", { worker: "w1", issue: 86, rescued: true }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "to-checkpoint"]);
  assert.equal(droplet(state, 86)?.failed, false);
  assert.equal(state.lanes[0]?.phase, "driving");

  const dead = run([ev("dispatched", { worker: "w1", issue: 86 }), ev("reclaim-dead", { worker: "w1", issue: 86, rescued: false })]);
  assert.equal(droplet(dead.state, 86)?.failed, true);
});

test("a droplet that recovers loses its ✕ — the mark never outlives the failure", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-failed", { worker: "w1", issue: 86, next: "ESCALATE" }),
    ev("dispatched", { worker: "w2", issue: 86 }),
    ev("reclaim-done", { worker: "w2", issue: 86, next: "DRIVING" }),
    ev("merged", { worker: "w2", issue: 86, pr: 97 }),
  ]);

  assert.equal(droplet(state, 86)?.failed, false);
  assert.equal(droplet(state, 86)?.at, "trunk");
  assert.equal(state.rings, 1);
  assert.doesNotMatch(markup(state), /✕/);
});

test("§6 failure kinds stop the droplet with a static ✕ — no lane left lit", () => {
  for (const kind of ["reclaim-failed", "reclaim-dead", "rollback-escalated"]) {
    const { state, transitions } = run([
      ev("dispatched", { worker: "w1", issue: 86 }),
      ev(kind, { worker: "w1", issue: 86, next: "ESCALATE" }),
    ]);

    assert.deepEqual(kinds(transitions), ["dispatch", "fail"], kind);
    assert.equal(droplet(state, 86)?.failed, true, kind);
    assert.equal(droplet(state, 86)?.at, "lane", kind);
    assert.equal(state.lanes[0]?.phase, "failed", kind);
    assert.match(markup(state), /data-issue="86" data-at="lane" data-failed="true"/, kind);
    assert.match(markup(state), /✕/, kind);
  }
});

test("§6 `rollback-escalated` without a worker still marks its issue failed", () => {
  const { state, transitions } = run([ev("rollback-escalated", { issue: 90, target: "ready", reason: "label-failed" })]);

  assert.deepEqual(kinds(transitions), ["fail"]);
  assert.equal(droplet(state, 90)?.failed, true);
  assert.equal(droplet(state, 90)?.at, "backlog");
});

test("§6 `ceiling-escalated` / PAUSE / kill switch dim the stage", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("ceiling-escalated", { worker: "w1", issue: 86, reasons: ["dailyBudgetUsd"] }),
  ]);

  assert.deepEqual(kinds(transitions), ["dispatch", "dim"]);
  assert.deepEqual([...state.openCeilingReasons], ["dailyBudgetUsd"]);
  assert.equal(isStageDimmed(state, "running"), true);
  assert.match(markup(state, { dimmed: true }), /data-dimmed="true"/);

  const calm = initialHeroState(3);
  assert.equal(isStageDimmed(calm, "running"), false);
  for (const engine of ["paused", "winding-down", "stopping", "stopped"] as const) {
    assert.equal(isStageDimmed(calm, engine), true, engine);
  }
});

test("#716 gate② P1-2: `ceiling-breach-cleared` clears its OWN reason, un-dimming once the set is empty", () => {
  const dimmed = run([ev("ceiling-breach-entered", { reason: "dailyBudgetUsd" })]);
  assert.equal(isStageDimmed(dimmed.state, "running"), true);

  const cleared = foldEvents(dimmed.state, [ev("ceiling-breach-cleared", { reason: "dailyBudgetUsd" })]);
  assert.equal(cleared.state.openCeilingReasons.size, 0);
  assert.equal(isStageDimmed(cleared.state, "running"), false);
  // No stage animation for entered/cleared — §6 gives dimming no narrated moment of its own.
  assert.deepEqual(
    dimmed.transitions.filter((t) => t.kind !== "dim"),
    [],
  );
  assert.deepEqual(cleared.transitions, []);
});

test("#716 gate② round 2 P1-2: two OPEN reasons — clearing one leaves the stage dimmed by the other", () => {
  // The engine's real per-reason lifecycle: daily-budget clearing at midnight while
  // wall-clock stays breached must NOT undim the scene — a single shared boolean can't
  // represent that, which is exactly why this is now a set.
  const both = run([ev("ceiling-breach-entered", { reason: "dailyBudgetUsd" }), ev("ceiling-breach-entered", { reason: "wallClockSec" })]);
  assert.deepEqual([...both.state.openCeilingReasons].sort(), ["dailyBudgetUsd", "wallClockSec"]);
  assert.equal(isStageDimmed(both.state, "running"), true);

  const oneCleared = foldEvents(both.state, [ev("ceiling-breach-cleared", { reason: "dailyBudgetUsd" })]);
  assert.deepEqual([...oneCleared.state.openCeilingReasons], ["wallClockSec"]);
  assert.equal(isStageDimmed(oneCleared.state, "running"), true, "wallClockSec is still open — the scene must stay dimmed");

  const bothCleared = foldEvents(oneCleared.state, [ev("ceiling-breach-cleared", { reason: "wallClockSec" })]);
  assert.equal(bothCleared.state.openCeilingReasons.size, 0);
  assert.equal(isStageDimmed(bothCleared.state, "running"), false);
});

test("#716 gate② P1-2: `run-started` hard-resets the whole set — a fresh boot never inherits a stale historical breach", () => {
  const dimmed = run([ev("ceiling-escalated", { worker: "w1", issue: 86, reasons: ["dailyBudgetUsd"] })]);
  assert.equal(isStageDimmed(dimmed.state, "running"), true);

  // The dashboard folds from event id 0 — a LATER run's `run-started` must clear whatever a
  // PRIOR run's ceiling breach left open, with no `ceiling-breach-cleared` in between at all
  // (the prior process may simply have been killed, never emitting one).
  const restarted = foldEvents(dimmed.state, [ev("run-started", { config: {}, configHash: "abc" })]);
  assert.equal(restarted.state.openCeilingReasons.size, 0);
});

test("#716 gate② P1-2: a HISTORICAL ceiling-escalated does not dim a scene that has since moved on", () => {
  const { state } = run([
    ev("ceiling-escalated", { worker: "w1", issue: 86, reasons: ["dailyBudgetUsd"] }),
    ev("ceiling-breach-cleared", { reason: "dailyBudgetUsd" }),
    ev("run-started", { config: {}, configHash: "def" }),
    ev("dispatched", { worker: "w1", issue: 90 }),
  ]);
  assert.equal(state.openCeilingReasons.size, 0);
  assert.equal(isStageDimmed(state, "running"), false);
});

// #920 owner ruling Q6: dimming is a LIVE-open-round-only concept — replay (closed round at any
// cursor) and `?demo` must never dim, even when the folded state carries every signal that WOULD
// dim a live open round (a dimming engine state AND open ceiling reasons). `isLiveOpenRound`
// short-circuits the whole expression, so `engine` is never consulted for a replayed view.
test("#920 AC1: isStageDimmed only dims a LIVE OPEN round — the third param gates both engine state and ceiling reasons", () => {
  const dimmed = run([ev("ceiling-escalated", { worker: "w1", issue: 86, reasons: ["dailyBudgetUsd"] })]);
  assert.deepEqual([...dimmed.state.openCeilingReasons], ["dailyBudgetUsd"]);

  // Every signal that would dim a live open round is present — engine "stopped" AND an open
  // ceiling reason — but `isLiveOpenRound: false` (replay / `?demo`) must still read false.
  assert.equal(isStageDimmed(dimmed.state, "stopped", false), false, "replay/demo must never dim, regardless of engine state");
  assert.equal(isStageDimmed(dimmed.state, "running", false), false, "not even a dimming-adjacent engine state changes this");

  // The SAME state, viewed live with an open round, dims exactly as before.
  assert.equal(isStageDimmed(dimmed.state, "stopped", true), true);

  // Default (no third arg) preserves every pre-#920 direct caller's existing meaning.
  assert.equal(isStageDimmed(dimmed.state, "stopped"), true);
});

// ── Travel origin ─────────────────────────────────────────────────────────────

test("every travelling transition declares where it travels FROM", () => {
  const origins = Object.fromEntries(
    [
      ["dispatch", { kind: "dispatch", id: 1, issue: 1, lane: "w1" }],
      ["to-checkpoint", { kind: "to-checkpoint", id: 2, issue: 1, lane: "w1", pr: 11 }],
      ["fix-return", { kind: "fix-return", id: 3, issue: 1, lane: "w1", pr: 11, reason: "review findings", round: 1 }],
      ["fix-reason", { kind: "fix-reason", id: 9, issue: 1, lane: "w1", reason: "checks failed" }],
      ["escalate", { kind: "escalate", id: 4, issue: 1, pr: 11 }],
      ["ring", { kind: "ring", id: 5, issue: 1, pr: 11, ring: 1 }],
      ["handoff", { kind: "handoff", id: 6, issue: 1, lane: "w1" }],
      ["fail", { kind: "fail", id: 7, issue: 1, lane: "w1" }],
      ["dim", { kind: "dim", id: 8 }],
    ].map(([name, t]) => [name, transitionOrigin(t as Transition)]),
  );

  assert.deepEqual(origins, {
    dispatch: "backlog",
    "to-checkpoint": "lane",
    "fix-return": "checkpoint",
    "fix-reason": null,
    escalate: "checkpoint",
    ring: "checkpoint",
    handoff: "lane",
    fail: null,
    dim: null,
  });
});

test("a first-seen droplet travels from its origin zone, not from where it already sits", () => {
  const { state, transitions } = run([ev("dispatched", { worker: "w1", issue: 86 })]);
  const step = transitions[0];
  assert.ok(step?.kind === "dispatch");

  const d = droplet(state, 86);
  const origin = transitionOrigin(step);
  assert.ok(d);
  assert.ok(origin);
  const from = dropletPoint(state, d, origin);
  const to = dropletPoint(state, d);

  assert.notDeepEqual(from, to);
  assert.ok(from.x < to.x, `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
});

// ── AC 2: no role-word captions, no reserved/dormant slot row ──────────────────

test("the stage carries no role-word captions and no reserved/dormant slot of any kind", () => {
  const { state } = run([
    ev("pool-selected", { issues: [86] }),
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("merged", { worker: "w1", issue: 86, pr: 97 }),
  ]);
  const html = markup(state);

  // No project-internal role words anywhere on the stage (§7: they live only in the legend).
  assert.doesNotMatch(html, /conductor|producer|reviewer|merge driver/i);
  // No permanently-dimmed/reserved row of any kind.
  assert.doesNotMatch(html, /reserved/i);
  assert.doesNotMatch(html, /coming with rounds/);
});

test("round-orchestrator events move nothing on the stage (they light the planning/reflection nodes, not droplets)", () => {
  const { transitions } = run([
    ev("round-phase", { round_id: 4, phase: "aligning" }),
    ev("align-summary", { created: 2, drafted: 1 }),
    ev("triage-degraded", { round_id: 4 }),
    ev("plan-review-escalated", { issue: 91 }),
    ev("retro-pr-opened", { pr: 99 }),
    ev("round-stop", { detail: "round budget" }),
  ]);

  assert.deepEqual(transitions, []);
});

test("the planning trio and reflection pair light from the live round-phase cursor, not fake progress", () => {
  assert.equal(activePlanningNode(null), null);
  assert.equal(activePlanningNode("aligning"), "goal-align");
  assert.equal(activePlanningNode("architecting"), "arch-review");
  assert.equal(activePlanningNode("plan_review"), "verify");
  assert.equal(activePlanningNode("executing"), null);
  assert.equal(activeReflectionNode("harvesting"), "summary");
  assert.equal(activeReflectionNode("retro"), "retro");
  assert.equal(activeReflectionNode("executing"), null);

  const html = markup(initialHeroState(3), { roundPhase: "architecting" });
  assert.match(html, /data-node="planning"/);
  // Only the phase's own node is marked active — no reserved styling anywhere.
  const active = [...html.matchAll(/data-active="true"/g)];
  assert.equal(active.length, 1);
  assert.doesNotMatch(html, /data-reserved/);
});

// ── AC 3: ring count ──────────────────────────────────────────────────────────

test("ring count increments exactly once per `merged` and persists across the session", () => {
  const merges = [
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("merged", { worker: "w2", issue: 2, pr: 12 }),
    ev("merged", { worker: "w3", issue: 3, pr: 13 }),
  ];
  const first = run(merges);
  assert.equal(first.state.rings, 3);

  const second = foldEvents(first.state, [ev("dispatched", { worker: "w1", issue: 4 }), ev("handoff", { worker: "w1", issue: 4 })]);
  assert.equal(second.state.rings, 3);
  assert.equal(second.transitions.filter((t) => t.kind === "ring").length, 0);
});

test("re-folding an overlapping poll page cannot double-count a merge", () => {
  const page = [ev("merged", { worker: "w1", issue: 1, pr: 11 })];
  const first = run(page);
  const second = foldEvents(first.state, page);

  assert.equal(second.state.rings, 1);
  assert.deepEqual(second.transitions, []);
});

// ── AC 4: coalescing policy ───────────────────────────────────────────────────

test("a burst of >2 pending transitions collapses to instant swaps, newest ring animating", () => {
  const { transitions } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("dispatched", { worker: "w3", issue: 3 }),
  ]);
  assert.equal(transitions.length, 5);

  const planned = planTransitions(transitions, { speed: 1 });
  assert.deepEqual(
    planned.map((p) => p.animate),
    [false, false, false, true, false],
  );
  assert.equal(planned.filter((p) => p.animate).length, 1);
  assert.equal(planned.find((p) => p.animate)?.kind, "ring");
});

test("two merges in one burst animate only the newest ring", () => {
  const { transitions } = run([
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("merged", { worker: "w2", issue: 2, pr: 12 }),
    ev("merged", { worker: "w3", issue: 3, pr: 13 }),
  ]);

  const planned = planTransitions(transitions, { speed: 1 });
  assert.deepEqual(
    planned.map((p) => p.animate),
    [false, false, true],
  );
});

test("≤2 pending transitions at ×1 animate normally", () => {
  const { transitions } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("dispatched", { worker: "w2", issue: 2 })]);

  assert.deepEqual(
    planTransitions(transitions, { speed: 1 }).map((p) => p.animate),
    [true, true],
  );
});

test("replay speed ≥ ×4 collapses even a small batch", () => {
  const { transitions } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("merged", { worker: "w1", issue: 1, pr: 11 })]);

  assert.deepEqual(
    planTransitions(transitions, { speed: 4 }).map((p) => p.animate),
    [false, true],
  );
  assert.deepEqual(
    planTransitions(transitions, { speed: 16 }).map((p) => p.animate),
    [false, true],
  );
});

test("a collapsed batch with no merge animates nothing at all", () => {
  const { transitions } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("dispatched", { worker: "w3", issue: 3 }),
  ]);

  assert.deepEqual(
    planTransitions(transitions, { speed: 1 }).map((p) => p.animate),
    [false, false, false],
  );
});

// ── AC 5: prefers-reduced-motion ──────────────────────────────────────────────

test("prefers-reduced-motion turns every transition — ring strokes included — into an instant swap", () => {
  const { state, transitions } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
  ]);

  for (const speed of [1, 4]) {
    const planned = planTransitions(transitions, { reducedMotion: true, speed });
    assert.equal(
      planned.every((p) => !p.animate),
      true,
      `speed ${speed}`,
    );
  }

  const reduced = markup(state, { reducedMotion: true });
  assert.match(reduced, /data-motion="reduced"/);
  assert.match(reduced, /class="hero-ring-count"[^>]*>1</);
  assert.match(reduced, /data-issue="1"/);
});

// ── AC 8/9/10: design tokens, never hardcoded hex ──────────────────────────────

test("the backlog's selected chips read their fill from --sap-fill, never a hardcoded hex", () => {
  const { state } = run([ev("pool-selected", { issues: [86] })]);
  const html = markup(state);
  assert.match(html, /class="hero-pool-chip"[\s\S]*?style="fill:var\(--sap-fill\)"/);
});

test("a lane droplet in motion reads its fill from --sap-fill; escalated/failed from --rust; merged from --moss", () => {
  const inMotion = run([ev("dispatched", { worker: "w1", issue: 1 })]);
  assert.match(markup(inMotion.state), /data-issue="1"[\s\S]*?<path class="hero-droplet-shape" d="[^"]*" style="fill:var\(--sap-fill\)"/);

  const escalated = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING" }),
    ev("drive-needs-human", { worker: "w1", issue: 1 }),
  ]);
  assert.match(markup(escalated.state), /data-issue="1"[\s\S]*?<path class="hero-droplet-shape" d="[^"]*" style="fill:var\(--rust\)"/);

  const merged = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("merged", { worker: "w1", issue: 1, pr: 11 })]);
  assert.match(markup(merged.state), /data-issue="1"[\s\S]*?<path class="hero-droplet-shape" d="[^"]*" style="fill:var\(--moss\)"/);
});

test("the escalation branch and NEEDS HUMAN node read their stroke from --rust, never a hardcoded hex", () => {
  const html = markup(initialHeroState(3));
  assert.match(html, /style="stroke:var\(--rust\)" class="hero-branch"/);
  // #922 AC4: a person-glyph <g> now sits between the circle and the label.
  assert.match(html, /<circle style="stroke:var\(--rust\)"[^>]*><\/circle>[\s\S]*?<text[^>]*>Needs human/);
  // No hardcoded rust hex sneaks in either theme's failure colour.
  assert.doesNotMatch(html, /#D9713F|#A34620|#C05A2E/i);
});

// gate② finding [2] (ac2-rust-ink-contrast): the CSS rule alone doesn't prove the cascade
// actually WINS — `.hero-droplet-num`'s own bare rule (--on-sap-fill) has EQUAL specificity to
// nothing; the `[data-at="needs-human"]`-scoped override needs a real `getComputedStyle` proof
// that IT wins over the bare rule, not just that its own source text mentions --on-rust.
//
// `--on-rust` is a literal-per-theme-scope token (tokens.css's own doc, same reason
// `--sap-fill-outline` is) — happy-dom never evaluates `light-dark()`/`prefers-color-scheme` the
// way a real browser does, so this reads the SAME `data-theme` attribute + regex-over-source
// approach `--sap-fill-outline`'s own tokens.test.ts case uses, rather than trusting
// `parseTokens`'s flat "last declaration in the file wins" (which would silently pass by
// COINCIDENCE of declaration order, not because the cascade genuinely resolved that theme).
test("#922 AC2: a needs-human/failed droplet's number resolves --on-rust; every other droplet still resolves --on-sap-fill, under the real production cascade, in both themes", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING" }),
    ev("drive-needs-human", { worker: "w2", issue: 2 }),
  ]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { lanesMax: 2 });
  document.body.appendChild(container);
  const expectedOnSapFill = parseTokens(tokensCss)["--on-sap-fill"];
  const [darkOnRust, lightOnRust] = [...tokensCss.matchAll(/--on-rust:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1]!.toUpperCase());
  try {
    for (const [themeAttr, expectedOnRust] of [
      ["heartwood", darkOnRust],
      ["sapwood", lightOnRust],
    ] as const) {
      document.documentElement.setAttribute("data-theme", themeAttr);

      const needsHumanNum = container.querySelector('.hero-droplet[data-at="needs-human"] .hero-droplet-num') as Element;
      assert.ok(needsHumanNum, `${themeAttr}: the needs-human droplet's own number must render`);
      assert.equal(
        getComputedStyle(needsHumanNum).fill,
        expectedOnRust,
        `${themeAttr}: a needs-human droplet's number must resolve --on-rust, not --on-sap-fill`,
      );

      const inMotionNum = container.querySelector('.hero-droplet[data-at="lane"] .hero-droplet-num') as Element;
      assert.ok(inMotionNum, `${themeAttr}: the in-motion droplet's own number must render`);
      assert.equal(
        getComputedStyle(inMotionNum).fill,
        expectedOnSapFill,
        `${themeAttr}: an in-motion droplet's number must still resolve --on-sap-fill, unaffected by the rust override`,
      );
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

test("the merged event's checkpoint flash and the new growth ring use --moss, never a hardcoded hex", () => {
  // The flash is an imperative anime.js class toggle (`.is-merged`), so its token binding is
  // asserted against the stylesheet that drives it, tied to the class the rendered gate carries.
  assert.match(markup(initialHeroState(3)), /class="hero-gate"/);
  assert.match(heroCss, /\.hero-gate\.is-merged \.hero-gate-node\s*\{[^}]*stroke:\s*var\(--moss\)/);

  // The newest ring is a static, server-rendered attribute — directly assertable. `data-ring`
  // (#716 gate② round 2 P1-3) sits between `data-current` and `style` in draw order, hence
  // the `[^>]*` between them rather than requiring them adjacent.
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 11 })]);
  assert.match(markup(state), /class="hero-ring"[^>]*data-current="true"[^>]*style="stroke:var\(--moss\)"/);
});

test("the ring count and the PLAN/IMPLEMENT/OUTCOME phase captions render with --font-display", () => {
  const html = markup(initialHeroState(3));
  assert.match(html, /class="hero-phase" style="font-family:var\(--font-display\)"[^>]*>\s*PLAN/);
  assert.match(html, /class="hero-phase" style="font-family:var\(--font-display\)"[^>]*>\s*IMPLEMENT/);
  assert.match(html, /class="hero-phase" style="font-family:var\(--font-display\)"[^>]*>\s*OUTCOME/);

  // #921: `initialHeroState` is a fresh, 0-ring state — the sapling glyph draws there, not the
  // numeral (AC1) — so this reads the font-family off a real post-merge state instead.
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 1 })]);
  assert.match(
    markup(state),
    new RegExp(`class="hero-ring-count" style="font-family:var\\(--font-display\\);font-size:${RING_COUNT_FONT_PX}px"`),
  );
});

// ── #879: hero panel typography + chip/card/icon detailing (fidelity-ledger rows 1, 2, 7) ──

// #879 gate② finding [1]: a regex read of the stylesheet TEXT proves the rule was authored, not
// that it actually cascades onto a rendered element. This test mounts the real markup into a
// REAL DOM (`registerRealDom()`, happy-dom) with the FULL production stylesheet cascade injected
// as actual `<style>` elements, then reads `getComputedStyle` off the matched element — proof the
// selector matches and the cascade applies, not just that the source text contains the rule.
//
// #886 gate② run 2e566ac9 finding [4]: the prior version accepted ANY non-default letter-spacing
// (`assert.notEqual(computed.letterSpacing, "normal")`), which would pass even for a later
// overriding rule with the WRONG spacing — the finding's own ask: "sensitive to the exact
// winning cascaded value". `hero.css`'s `.hero-phase` now declares `letter-spacing` as a literal
// `2.34px` rather than `0.18em` specifically so this can assert that exact value directly — see
// that rule's own doc for why: happy-dom resolves an `em` letter-spacing against the DEFAULT
// 16px font-size rather than this element's own cascaded 13px whenever the same selector's own
// rule declares a font-size at all (reproduced directly; splitting `font-size` and
// `letter-spacing` into separate rule blocks for the same selector does NOT avoid it — only
// verified in isolation, an EARLIER version of this fix mistook cross-test style-tag
// contamination for a genuine split-rule fix). A literal px value has no unit to mis-resolve.
//
// #886 final gate②: injecting `heroCss` ALONE proved the selector/cascade within hero.css, but
// left a same-specificity override landing in tokens.css/panels.css/app.css invisible to this
// test regardless of source order, since those files were never mounted at all. Confirmed by
// direct reproduction: a synthetic `.hero-phase { letter-spacing: 9px }` appended past `heroCss`
// alone DOES win (cascade mechanics behave as expected once mounted) — the gap was never that
// the cascade is unpredictable, only that this test never gave production's other sheets a
// chance to be seen. Fixed by mounting the real production order — tokens.css → panels.css →
// hero.css → app.css's own `body { ... }` rule (imports run first in app.css, its own rules
// after) — same pattern as `Header.test.tsx`'s `.spend-meter-value` fix. Re-verified against
// that full cascade: `.hero-phase` declares font-size/font-weight/letter-spacing all as literal
// values in its own rule (no inheritance, no `em` to mis-resolve), and no other shipped file
// declares a `.hero-phase` rule, so 2.34px is still the true winning value — this test now
// proves that rather than assuming it.
test("#879 gate② run 2e566ac9 finding [4]: PLAN/IMPLEMENT/OUTCOME headers render bold at the EXACT shipped letter-spacing, proven against the REAL production cascade (tokens.css + panels.css + hero.css + app.css's body rule)", () => {
  assert.ok(bodyFontSizeRule, "app.css must still declare a body { ... } rule for tokensCss/panelsCss/heroCss to cascade through");
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = markup(initialHeroState(3));
  document.body.appendChild(container);
  try {
    const phaseEl = container.querySelector(".hero-phase");
    assert.ok(phaseEl, "a real .hero-phase element must render and match the injected stylesheet's selector");
    const computed = getComputedStyle(phaseEl as Element);
    assert.equal(
      computed.fontWeight,
      "600",
      "the cascade must actually apply the bold weight to the rendered element, not just declare it in source",
    );
    assert.equal(computed.fontSize, "13px");
    assert.equal(
      computed.letterSpacing,
      "2.34px",
      "the exact winning cascaded value against the full production cascade, not merely 'some' spacing",
    );
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }

  const match = heroCss.match(/\.hero-phase\s*\{([^}]*)\}/);
  assert.ok(match, ".hero-phase rule must exist");
  const body = match?.[1] as string;
  assert.match(body, /font-weight:\s*600/);
  assert.match(body, /letter-spacing:\s*2\.34px\b/, "pin the exact shipped value");
  assert.match(
    body,
    /font-family:\s*var\(--font-display\)/,
    "font-family must stay Fraunces — reversing #728's adjudication is out of this issue's scope",
  );
});

// #895 item 5: below the app's 720px stacking floor, `.hero`'s `width: 100%` used to scale the
// whole stage — and every caption's authored font-size along with it — down to ~6px. STYLE
// doctrine (docs/REVIEW-DOCTRINE.md): a computed-style AC needs `registerRealDom()` plus a real
// `getComputedStyle` read against the FULL production cascade at a REAL simulated viewport width,
// never a regex read of the source text (which proves the rule was authored, not that it wins).
test("#895 item 5: at the 720px floor, the hero stage reflows (holds its native 1200px width) instead of scaling its captions down", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);

  const readHeroWidth = (viewportWidth: number): string => {
    (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({
      width: viewportWidth,
    });
    const container = document.createElement("div");
    container.innerHTML = markup(initialHeroState(3));
    document.body.appendChild(container);
    try {
      const heroEl = container.querySelector(".hero");
      assert.ok(heroEl, "a real .hero element must render");
      return getComputedStyle(heroEl as Element).width;
    } finally {
      document.body.removeChild(container);
    }
  };

  try {
    // Above the floor, the scaling rule (`width: 100%`) still wins — happy-dom's CSSOM-only
    // `getComputedStyle` can't resolve a percentage to an actual px layout value (no real layout
    // engine), but it DOES still report the literal cascaded value, so this confirms the 720px
    // media query hasn't fired early and pinned 1200px outside its own range.
    assert.equal(readHeroWidth(1200), "100%", "well above the floor, the scaling rule must still be the one that wins");
    // #895: 400px/1200px alone never pin the NAMED 720px boundary — a media query shipped as
    // `max-width: 719px` would still pass both. 721px (just outside) and 720px (the floor
    // itself, inclusive per `max-width`'s own semantics) pin the exact edge, tied to
    // `STAGE.w` (stage.tsx's own viewBox width) rather than a hand-copied `1200px` literal so
    // the two can never silently drift apart.
    assert.equal(readHeroWidth(721), "100%", "one px above the floor, the media query must not have fired yet");
    assert.equal(
      readHeroWidth(720),
      `${STAGE.w}px`,
      "AT the 720px floor itself (max-width is inclusive), the stage must already hold its native width",
    );
    assert.equal(
      readHeroWidth(400),
      `${STAGE.w}px`,
      "well below the floor, the stage must hold its native STAGE.w px width (reflow via horizontal scroll) rather than scaling down — the exact regression: captions shrinking to ~6px",
    );
  } finally {
    document.head.removeChild(style);
  }
});

// #928 AC3 (STYLE, registerRealDom() + full production cascade at a real simulated viewport
// width, through the REAL `<Hero>` wrapper — `HeroStage` alone never renders `.hero-scroll`, the
// same "wrapper, not the bare stage" posture #920 AC5/#891's wrapper tests above already take):
// the hero's own scroll container resolves `overflow-x: auto` at the 720px floor, and the
// caption's own authored font-size stays IDENTICAL to its 1440px value — proof #895 item 5's fix
// (captions never shrink) survives this issue's new wrapper rather than being quietly reverted by
// it.
test("#928 AC3: at 720px, .hero-scroll resolves overflow-x: auto and the hero caption's font-size is unchanged from 1440", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);

  const readAt = (viewportWidth: number): { scrollOverflowX: string; labelFontPx: number } => {
    (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({
      width: viewportWidth,
    });
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(Hero, { heroState: initialHeroState(3), steps: [], lanesMax: 3, engine: "running", fixCap: 2 }),
    );
    document.body.appendChild(container);
    try {
      const scrollEl = container.querySelector(".hero-scroll");
      assert.ok(scrollEl, "a real .hero-scroll wrapper must render around the stage");
      const label = container.querySelector(".hero-label");
      assert.ok(label, "a real .hero-label caption must render");
      return {
        scrollOverflowX: getComputedStyle(scrollEl as Element).overflowX,
        labelFontPx: Number.parseFloat(getComputedStyle(label as Element).fontSize),
      };
    } finally {
      document.body.removeChild(container);
    }
  };

  try {
    const at1440 = readAt(1440);
    const at720 = readAt(720);
    assert.equal(at720.scrollOverflowX, "auto", "the hero's own scroll container must resolve overflow-x: auto at the 720px floor");
    assert.equal(
      at720.labelFontPx,
      at1440.labelFontPx,
      "#895's fix must stay intact: the caption's authored font-size must not shrink at the 720px floor",
    );
  } finally {
    document.head.removeChild(style);
  }
});

// gate② finding [1] (ac3-height-self-reference): the old assertion interpolated
// BACKLOG_CHIP_H — the SAME constant that renders the rect — into the matcher, so it stayed
// green even if that constant regressed below the AC's own floor. The height is read off the
// rendered markup with no reference to the production constant, then checked against the AC's
// own independent 32px-equivalent literal.
test("#879/#922 AC3: the backlog's READY cards render as taller filled cards with bold, contrasting card text", () => {
  const { state } = run([ev("pool-selected", { issues: [94] })]);
  const html = markup(state);
  const chipMatch = html.match(/class="hero-pool-chip"[\s\S]*?<rect style="fill:var\(--sap-fill\)"[^>]*height="([\d.]+)"[^>]*rx="8"/);
  assert.ok(chipMatch, "a filled .hero-pool-chip rect must render");
  assert.ok(
    Number(chipMatch?.[1]) >= 32,
    `rendered chip height ${chipMatch?.[1]} must independently clear AC3's own >= 32 stage-px-equivalent floor`,
  );
  assert.match(html, /class="hero-num hero-pool-num hero-backlog-num"[^>]*>⊙ 94</);
  const poolNumRule = heroCss.match(/\.hero-pool-num\s*\{([^}]*)\}/);
  assert.ok(poolNumRule, ".hero-pool-num rule must exist");
  assert.match(poolNumRule?.[1] as string, /font-weight:\s*600/);
  assert.match(poolNumRule?.[1] as string, /fill:\s*var\(--on-sap-fill\)/);
});

// #922 AC1 (STYLE, registerRealDom() via the eager import + full production cascade, COVERAGE):
// every centred-below-circle node label (planning trio, CI, REVIEW, SUMMARY, RETRO, NEEDS HUMAN)
// resolves --font-data uppercase with >= 0.08em-equivalent letter-spacing, and its y sits below
// its own circle's bottom edge (cy + r) at text-anchor middle, cx. `text-anchor="middle"` is a
// markup-DERIVED filter, not a hand-typed zone list — lane labels (excluded from AC1's own
// enumeration) render with no text-anchor override at all, so this filter naturally excludes
// exactly the set AC1 doesn't name, and includes exactly the set it does.
test("#922 AC1: every centred-below-circle .hero-node-label resolves --font-data uppercase, >= 0.08em letter-spacing, below its own circle, text-anchor middle", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 10 }),
    ev("drive-needs-human", { worker: "w1", issue: 1, pr: 10 }),
  ]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { roundPhase: "aligning", config: { reviewer: { agent: { model: "fable", effort: "high" } } } });
  document.body.appendChild(container);
  try {
    const labels = [...container.querySelectorAll('.hero-node-label[text-anchor="middle"]')];
    // planning×3 + CI + Review + Summary + Retro + Needs human = 8 — every node AC1 names, none
    // hand-picked: this count falls out of the text-anchor="middle" filter itself.
    assert.equal(labels.length, 8, `expected 8 centred-below-circle labels, got ${labels.length}`);

    const computed = getComputedStyle(labels[0] as Element);
    assert.match(computed.fontFamily, /JetBrains Mono|monospace/, "font-family resolves through --font-data");
    assert.equal(computed.textTransform, "uppercase");
    const fontPx = Number.parseFloat(computed.fontSize);
    const letterSpacingPx = Number.parseFloat(computed.letterSpacing);
    assert.ok(
      letterSpacingPx >= 0.08 * fontPx,
      `letter-spacing ${letterSpacingPx}px must be >= 0.08em (${0.08 * fontPx}px) at ${fontPx}px`,
    );

    for (const label of labels) {
      const cx = Number(label.getAttribute("x"));
      const cy = Number(label.getAttribute("y"));
      // The label's own governing circle shares its x as the circle's cx (both centred on the
      // node's own centre) — found by scanning every drawn circle for that cx and taking the one
      // whose cy is closest to this label's own y (the node the label actually belongs to).
      const circles = [...container.querySelectorAll(`circle[cx="${cx}"]`)];
      assert.ok(circles.length > 0, `no circle found at cx=${cx} for label at (${cx},${cy})`);
      const owner = circles.reduce((closest, c) => {
        const cCy = Number(c.getAttribute("cy"));
        const closestCy = Number(closest.getAttribute("cy"));
        return Math.abs(cCy - cy) < Math.abs(closestCy - cy) ? c : closest;
      });
      const ownerCy = Number(owner.getAttribute("cy"));
      const ownerR = Number(owner.getAttribute("r"));
      assert.ok(cy > ownerCy + ownerR, `label y=${cy} must sit below its circle's bottom edge (cy + r = ${ownerCy + ownerR})`);
    }
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #922 AC3: no well rect, >= 3 filled + >= 3 outlined candidate cards, and an overflow "…" chip
// once the pool exceeds the drawn cap — asserted over a fixture large enough to exercise all
// three (COVERAGE: the drawn set is derived from the rendered markup, not a hand list).
test("#922 AC3: no .hero-well rect; >= 3 filled + >= 3 outlined candidate backlog cards; an overflow chip past the drawn cap", () => {
  const { state } = run([ev("pool-selected", { issues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })]);
  const html = markup(state);
  assert.doesNotMatch(html, /hero-well/, "no .hero-well rect anywhere in the hero markup");

  const filledChips = [...html.matchAll(/class="hero-pool-chip" data-issue="(\d+)"/g)];
  const candidates = [...html.matchAll(/class="hero-pool-candidate" data-issue="(\d+)"/g)];
  assert.ok(filledChips.length >= 3, `expected >= 3 filled chips, got ${filledChips.length}`);
  assert.ok(candidates.length >= 3, `expected >= 3 outlined candidates, got ${candidates.length}`);

  // BACKLOG_CANDIDATE_DRAW_CAP (5) + BACKLOG_FILLED_CAP (3) = 8 drawn; the 10-issue fixture
  // above has 2 left over, which must collapse into a single "…" overflow chip.
  assert.match(html, /class="hero-pool-candidate hero-pool-overflow" data-count="2"[^>]*>[\s\S]*?>…</);
});

// #922 AC3 (STYLE, registerRealDom() via the eager import + full production cascade): the
// backlog chip numeral resolves >= 14px at 1440 — both the filled and outlined variant, since
// the AC's wording ("chip numeral") doesn't single out only the filled ones.
//
// gate② finding [3] (ac3-real-render-scale): `1440 / STAGE.w` assumes the hero SVG gets the FULL
// 1440px of a 1440px viewport — it never does (the icon rail + `.stack`/`.panel` chrome eat into
// it first, `REAL_RENDER_SCALE_1440`'s own doc, stage.tsx). Using the naive ratio here would let
// a production size that only clears the OVERSTATED scale slip back in unnoticed.
test("#922 AC3: backlog chip numerals resolve >= 14px at 1440 under the real production cascade", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("pool-selected", { issues: [1, 2, 3, 4, 5, 6, 7] })]);
  const container = document.createElement("div");
  container.innerHTML = markup(state);
  document.body.appendChild(container);
  try {
    const filled = container.querySelector(".hero-pool-chip .hero-backlog-num") as Element;
    const candidate = container.querySelector(".hero-pool-candidate .hero-backlog-num") as Element;
    assert.ok(filled && candidate, "both a filled chip and an outlined candidate must render");
    for (const el of [filled, candidate]) {
      const px = Number.parseFloat(getComputedStyle(el).fontSize);
      const renderedAt1440 = px * REAL_RENDER_SCALE_1440;
      assert.ok(
        renderedAt1440 >= 14,
        `chip numeral ${px}px * ${REAL_RENDER_SCALE_1440} = ${renderedAt1440}px must clear the AC's >= 14px-at-1440 floor at the REAL render scale`,
      );
    }
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #922 AC4: the escalation node carries a person-glyph path (lucide's `UserRound`) inside the
// rust circle, and its label — the existing §7 copy string "Needs human", never a second one —
// sits below the circle, reading NEEDS HUMAN once CSS uppercases it.
test("#922 AC4: the escalation node group contains a person glyph and its label sits below the circle, reading NEEDS HUMAN via CSS uppercase", () => {
  const html = markup(initialHeroState(3));
  const escalationGroup = html.match(/<g class="hero-escalation"[^>]*>([\s\S]*?)<\/g>\s*<g class="hero-trunk"/)?.[1] as string;
  assert.ok(escalationGroup, "the escalation group must render");
  assert.match(escalationGroup, /class="lucide lucide-user-round"/, "a real lucide UserRound glyph, not a hand-drawn shape");
  assert.match(escalationGroup, /<path/, "lucide's own generated <path> inside the person glyph — not a hand-drawn identity shape");

  const labelMatch = escalationGroup.match(
    /<text class="hero-node-label" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">Needs human<\/text>/,
  );
  assert.ok(labelMatch, 'the label must be the existing §7 copy string "Needs human", never a second copy string');
  const [, xRaw, yRaw] = labelMatch as unknown as [string, string, string];
  assert.equal(Number(xRaw), ESCALATION.x, "centred at the node's own x");
  assert.ok(Number(yRaw) > ESCALATION.y + ESCALATION_R, "the label's y sits below the circle's own bottom edge (cy + r)");

  // #922 AC1 (uppercase via CSS, never a second copy string): the SAME .hero-node-label rule
  // every other node label uses (asserted globally by the dedicated AC1 test below) resolves
  // this text visually to "NEEDS HUMAN" — this test only pins that no second literal exists.
  assert.doesNotMatch(html, /NEEDS HUMAN</, "no separate uppercase copy string — CSS text-transform does the casing");
});

// #922 AC6: goal-align/arch-review/verify swap their hand-drawn glyphs for lucide's own
// Target/GitFork/Check — Summary/Retro (reflection zone) now ALSO carry a `hero-planning-icon`
// (bar-chart/trend-arrow), so the coverage count grows from 3 (planning only) to 5.
test("#922 AC6: each PLAN circle (goal-align/arch-review/verify) draws its own distinct lucide icon", () => {
  const html = markup(initialHeroState(3));
  for (const icon of ["target", "git-fork", "check"]) {
    assert.equal(
      (html.match(new RegExp(`data-icon="${icon}"`, "g")) ?? []).length,
      1,
      `exactly one ${icon} icon (goal-align/arch-review/verify each draw their own)`,
    );
  }
  const planningGroup = html.match(/<g class="hero-planning" data-node="planning">([\s\S]*?)<g class="hero-lanes">/)?.[1] as string;
  assert.equal((planningGroup.match(/class="hero-planning-icon"/g) ?? []).length, 3, "one icon per PLAN node, never zero or duplicated");
  for (const icon of ["target", "git-fork", "check"]) {
    assert.match(planningGroup, new RegExp(`class="lucide lucide-${icon}"`), `${icon} is a real lucide-stamped icon`);
  }
});

// gate② finding [4] (ac6-node-set-handlisted): the earlier version extracted two broad container
// strings and hand-asserted three expected class names ANYWHERE inside them — an added or
// duplicated reflection/escalation node with a missing/wrong icon could slip past that flat
// check. This derives the covered node SET from the rendered markup itself (circle count in the
// reflection zone, never a hand-typed "there are 2 nodes"), then proves a strict 1:1 icon-per-
// node mapping and ties each icon's own `data-icon` marker to its OWN rendered lucide-stamped
// class, not just "present somewhere in the zone".
test("#922 AC6 (COVERAGE): every rendered reflection + escalation node group carries exactly one lucide icon of its own", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 10 }),
    ev("drive-needs-human", { worker: "w1", issue: 1, pr: 10 }),
  ]);
  const html = markup(state);

  const reflectionGroup = html.match(
    /<g class="hero-reflection" data-node="reflection">([\s\S]*)<\/g>\s*<path\s+class="hero-return"/,
  )?.[1] as string;
  assert.ok(reflectionGroup, "the reflection group must render");
  const reflectionNodeCount = (reflectionGroup.match(/class="hero-planning-node"/g) ?? []).length;
  assert.ok(reflectionNodeCount >= 2, "the reflection zone must render at least Summary and Retro");
  const reflectionIcons = [...reflectionGroup.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1] as string);
  assert.equal(
    reflectionIcons.length,
    reflectionNodeCount,
    "every reflection node must carry exactly one icon marker — never zero or duplicated",
  );
  assert.equal(new Set(reflectionIcons).size, reflectionIcons.length, "no two reflection nodes may share the same icon");
  assert.ok(reflectionIcons.includes("chart-no-axes-column"), "Summary must carry ChartNoAxesColumn");
  assert.ok(reflectionIcons.includes("trending-up"), "Retro must carry TrendingUp");
  for (const icon of reflectionIcons) {
    const iconBlock = reflectionGroup.match(new RegExp(`data-icon="${icon}">([\\s\\S]*?)</g>`));
    assert.ok(iconBlock, `data-icon="${icon}" group must render`);
    assert.match(
      iconBlock?.[1] as string,
      new RegExp(`class="lucide lucide-${icon}"`),
      `${icon}'s own icon group must carry the real lucide-stamped class, not just be present elsewhere in the zone`,
    );
  }

  const escalationGroup = html.match(/<g class="hero-escalation"[^>]*>([\s\S]*?)<\/g>\s*<g class="hero-trunk"/)?.[1] as string;
  assert.ok(escalationGroup, "the escalation group must render");
  const escalationIcons = [...escalationGroup.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual(escalationIcons, ["user-round"], "the escalation node must carry exactly one icon marker: UserRound");
  const escalationIconBlock = escalationGroup.match(/data-icon="user-round">([\s\S]*?)<\/g>/);
  assert.ok(escalationIconBlock, "the user-round icon group must render");
  assert.match(escalationIconBlock?.[1] as string, /class="lucide lucide-user-round"/);
});

// #922 AC6 (mutation-kill, source-level): every hand-authored <path> in stage.tsx must be one of
// the IDENTITY shapes (the droplet) or a structural connector (arrowhead/lane-connector/fix-loop/
// escalation-branch/reflection-arm/return-path) — never a utility glyph. Re-adding a hand-drawn
// glyph <path> (e.g. reverting the planning trio's icons) introduces a className outside this
// allowlist and reddens this test.
test("#922 AC6 (mutation-kill): no hand-drawn <path> for a utility glyph remains in stage.tsx", () => {
  const rawStageTsx = readFileSync(new URL("./stage.tsx", import.meta.url), "utf8");
  // Strip comments first — a prose mention of `<path>` inside a /** ... */ doc comment (this
  // file has several, explaining WHY a glyph is no longer hand-drawn) would otherwise let the
  // path-block regex below run away from a real tag into the next REAL <path>'s own closing
  // `/>`, silently mis-attributing that real path's className to the comment's own dead span.
  const stageTsx = rawStageTsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const pathBlocks = [...stageTsx.matchAll(/<path\b([\s\S]*?)\/>/g)].map((m) => m[1] as string);
  assert.ok(pathBlocks.length > 0, "sanity: stage.tsx must still draw at least one <path>");
  const allowed = new Set([
    "hero-arrowhead", // the return path's arrowhead marker
    "hero-lane-connector", // a lane channel's curve into the CI node
    "hero-fixloop", // the fix-return arc
    "hero-branch", // the escalation branch's stem
    "hero-arm", // the reflection tree's stem/crossbar
    "hero-return", // the dashed return path
    "hero-droplet-shape", // IDENTITY: the sap droplet
  ]);
  for (const block of pathBlocks) {
    const cls = block.match(/className="([^"]+)"/)?.[1];
    assert.ok(cls, `a <path> with no className at all: ${block.slice(0, 80)}`);
    assert.ok(
      allowed.has(cls as string),
      `<path className="${cls}"> is not a known structural/identity path — a utility glyph must use lucide-react instead`,
    );
  }
});

test("#879/#922 AC2: issue tokens render as a droplet (teardrop path), never a bare circle", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 1 })]);
  const html = markup(state);
  // #922 AC2: the belly radius (and so the path's own tip coordinate) is sized to
  // the droplet's own bare NUMBER ("1", an unstarted PR-less droplet's issue number — the kind
  // mark never counts toward the fit) — read from the SAME production function rather than a
  // hand-copied literal (VALUE doctrine).
  const expectedPath = dropletPath(dropletRadius("1"));
  assert.match(html, new RegExp(`class="hero-droplet-shape" d="${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /class="hero-droplet"[\s\S]{0,40}<circle r="9"/, "no droplet may still draw the old bare circle");
});

// #886 gate② run b2a4f37d finding [0] + run 2e566ac9 finding [1]: two earlier rounds moved the
// NUMBER off-center to dodge the newest-merge droplet `merged` (state.ts) always parks at the
// trunk — first landing directly on top of it (dead center), then well below the real one-merge
// demo's tiny radius-7 ring (a bound loose enough that the prior version of THIS test, checking
// against `initialHeroState`'s theoretical max radius, never caught it). This round moves the
// DROPLET instead (`TRUNK_DROPLET_OFFSET`, stage.tsx) so the number can stay genuinely centered
// at any ring count, verified here against the real one-merge demo state specifically.
test("#879/#886: against the REAL single-merge demo state, the outcome number sits genuinely centered on the ring — the trunk droplet moved out of the way, not the number", () => {
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 11 })]);
  assert.equal(state.rings, 1, "this fixture's point is the real one-ring state the live demo capture renders, not a synthetic maximum");

  const html = markup(state);
  const match = html.match(/class="hero-ring-count"[^>]*x="(-?[\d.]+)" y="(-?[\d.]+)"/);
  assert.ok(match, "hero-ring-count must render with x/y");
  assert.equal(Number(match?.[1]), TRUNK.x, "horizontally dead-center on the trunk");
  assert.equal(
    Number(match?.[2]),
    TRUNK.y + 11,
    "vertically dead-center on the trunk (+11 is only a baseline-centering nudge, not a collision offset)",
  );
});

test("#879: the current (outermost) ring strokes bolder than the rest — a bold ring, not a hairline", () => {
  const currentRule = heroCss.match(/\.hero-ring\[data-current="true"\]\s*\{([^}]*)\}/);
  assert.ok(currentRule, '.hero-ring[data-current="true"] rule must exist');
  assert.match(currentRule?.[1] as string, /stroke-width:\s*3/);
  const baseRule = heroCss.match(/\.hero-ring\s*\{([^}]*)\}/);
  assert.match(baseRule?.[1] as string, /stroke-width:\s*1\.5/, "older rings stay hairline-thin — only the current ring bolds");
});

test("#728 gate② finding [0] (run 31f166a9): `.hero-small` (10px) is declared BEFORE every 9px caption rule, so the lane caption and outcome tally — both `hero-small` PLUS a 9px class — render at their intended 9px, not the 10px a later `.hero-small` would silently win with", () => {
  const smallIndex = heroCss.indexOf(".hero-small {");
  assert.ok(smallIndex >= 0, ".hero-small rule must exist");
  for (const rule of [".hero-node-caption {", ".hero-staleness,", ".hero-fixloop-label {"]) {
    const ruleIndex = heroCss.indexOf(rule);
    assert.ok(ruleIndex >= 0, `${rule} rule must exist`);
    assert.ok(smallIndex < ruleIndex, `.hero-small must precede ${rule} in source order (equal specificity — later wins)`);
  }
});

// ── #716 gate② P2-8: staleness, round outcome tally, model·effort/review-mode captions ──

test("P2-8: the planning group's staleness caption reads seconds since the last folded event", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 86 })]);
  const eventTs = state.lastEventTs;
  assert.ok(eventTs);
  const later = new Date(new Date(eventTs).getTime() + 14_000);
  const html = markup(state, { now: later });
  assert.match(html, /last event 14s ago/);

  // A fresh stage with nothing folded yet has no event to be stale about.
  assert.doesNotMatch(markup(initialHeroState(3)), /last event/);
});

test("#895 item 1: the staleness caption rolls over units (s/m/h/d) instead of ever rendering raw seconds", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 86 })]);
  const eventTs = state.lastEventTs;
  assert.ok(eventTs);
  const at = (deltaMs: number) => new Date(new Date(eventTs).getTime() + deltaMs);

  assert.match(markup(state, { now: at(90_000) }), /last event 1m ago/);
  assert.match(markup(state, { now: at(7_500_000) }), /last event 2h ago/);
  // The issue's own reported defect: a multi-day gap used to render as raw seconds
  // ("last event 424778s ago") — this is that exact scale, now unit-rolled.
  assert.match(markup(state, { now: at(424_778_000) }), /last event 4d ago/);
  assert.doesNotMatch(markup(state, { now: at(424_778_000) }), /\d+s ago/);
});

// #895: an unparseable `lastEventTs` must render no caption at all, never a fabricated "just
// now" — `formatRelativeTime` (format-time.ts) degrades an unparseable date to "just now" as
// its own honest default for callers that always have some real elapsed time to show; for this
// caption a malformed timestamp isn't "no time has passed", it's "no honest reading exists".
test("#895: an unparseable lastEventTs renders no staleness caption, never a fabricated 'just now'", () => {
  const state: HeroState = { ...initialHeroState(3), lastEventTs: "not-a-real-timestamp" };
  assert.doesNotMatch(markup(state), /last event/, "an invalid timestamp must render no caption at all, not a fabricated 'just now'");
});

test("P2-8: the round outcome tally is THIS round's merges, never the all-time ring count", () => {
  const roundOne = run([
    ev("pool-selected", { round_id: 1, issues: [1, 2] }),
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
  ]);
  assert.equal(roundOne.state.roundMerged, 1);
  assert.equal(roundOne.state.rings, 1);

  const roundTwo = foldEvents(roundOne.state, [
    ev("pool-selected", { round_id: 2, issues: [3] }),
    ev("dispatched", { worker: "w1", issue: 3 }),
    ev("merged", { worker: "w1", issue: 3, pr: 13 }),
  ]);
  // Round 2 has merged exactly ONE issue so far — never the all-time total (2).
  assert.equal(roundTwo.state.roundMerged, 1);
  assert.equal(roundTwo.state.rings, 2);

  const html = markup(roundTwo.state);
  assert.match(html, /1 merged · \d+ pending · \d+ needs human/);
  // Anchored to the tally's own format (`class="hero-outcome-tally"`) — the stage's
  // `aria-label` separately says "2 merged pull requests" (state.rings, the honest all-time
  // count, used correctly there), which a bare `/2 merged/` would collide with.
  assert.doesNotMatch(html, /class="hero-outcome-tally"[^>]*>2 merged/);
});

test("P2-8: LLM-backed stage nodes render their configured model·effort caption", () => {
  const config = {
    roles: { po: { model: "opus", effort: "high" }, harvest: { model: "sonnet", effort: "low" } },
    worker: { model: "sonnet", effort: "medium" },
  };
  const html = markup(initialHeroState(3), { config });
  assert.match(html, /opus · high/); // Goal & align (roles.po)
  assert.match(html, /sonnet · low/); // Summary (roles.harvest)
  assert.match(html, /sonnet · medium/); // lanes (worker.*)

  // No config, no caption — an honest gap, never a guessed model name.
  const bare = markup(initialHeroState(3));
  assert.doesNotMatch(bare, /opus|sonnet/);
});

// #922 AC7: REVIEW is a model-backed node like every other — its caption comes from
// reviewer.agent.model/.effort, never the internal reviewer.mode word (§7).
test("#922 AC7: REVIEW's caption prefers reviewer.agent.model·effort; falls back to a hosted-bot's plain mode word; never the internal 'engine-agent' mode string", () => {
  const withAgent = markup(initialHeroState(3), {
    config: { reviewer: { mode: "engine-agent", agent: { model: "fable", effort: "high" } } },
  });
  assert.match(withAgent, /fable · high/);
  assert.doesNotMatch(withAgent, /engine-agent/, "the internal mode string never appears in the hero markup");

  const hostedBot = markup(initialHeroState(3), { config: { reviewer: { mode: "codex" } } });
  assert.match(hostedBot, /class="hero-node-caption"[^>]*>codex</);

  const noReviewerConfig = markup(initialHeroState(3), { config: { worker: { model: "sonnet", effort: "medium" } } });
  const reviewGroup = noReviewerConfig.match(/<g class="hero-gate" data-gate="review"[^>]*>([\s\S]*?)<\/g>\s*<line/)?.[1] as string;
  assert.doesNotMatch(reviewGroup, /hero-node-caption/, "no reviewer config at all draws no caption — an honest gap");

  // engine-agent mode with no agent model configured: still never shows the internal term.
  const engineAgentNoModel = markup(initialHeroState(3), { config: { reviewer: { mode: "engine-agent" } } });
  assert.doesNotMatch(engineAgentNoModel, /engine-agent/);
});

// gate② finding [5] (ac7-wiring-coverage-incomplete): the test above covers REVIEW's caption
// TEXT only — this proves the remaining AC7 wiring/asset requirements: REVIEW's caption sits at
// the SAME offset (GATES.r + NODE_CAPTION_OFFSET) planning captions use, the CI caption reads the
// CI_CAPTION constant at that same slot, and GithubActionsGlyph's own rendered markup is the real
// devicon asset (128x128 viewBox, no legacy #2088ff/#79b8ff literal, every fill currentColor).
test("#922 AC7: REVIEW's caption sits at the same offset as the planning captions; CI's caption+asset render the required constant/markup", () => {
  const html = markup(initialHeroState(3), { config: { reviewer: { agent: { model: "fable", effort: "high" } } } });

  const reviewCaptionMatch = html.match(
    /<text class="hero-node-caption" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">fable · high<\/text>/,
  );
  assert.ok(reviewCaptionMatch, "the Review caption must render");
  const [, reviewCapX, reviewCapY] = reviewCaptionMatch as unknown as [string, string, string];
  assert.equal(Number(reviewCapX), GATES.review, "the Review caption is centred on the Review gate's own x");
  assert.equal(
    Number(reviewCapY),
    GATES.y + GATES.r + NODE_CAPTION_OFFSET,
    "the Review caption sits at GATES.r + NODE_CAPTION_OFFSET below the gate — the SAME offset formula the planning nodes' own captions use",
  );

  // Scoped to the CI gate's own group — never a blanket html.match, which would silently grab
  // whichever `.hero-node-caption` happens to be FIRST in DOM order instead of proving it's CI's.
  const ciGate = html.match(
    /<g class="hero-gate" data-gate="ci"[^>]*>([\s\S]*?)<\/g>\s*<g class="hero-gate" data-gate="review"/,
  )?.[1] as string;
  assert.ok(ciGate, "the CI gate group must render");
  const ciCaptionMatch = ciGate.match(/<text class="hero-node-caption" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">([^<]*)<\/text>/);
  assert.ok(ciCaptionMatch, "the CI gate's own hero-node-caption must render");
  const [, ciCapX, ciCapY, ciCapText] = ciCaptionMatch as unknown as [string, string, string, string];
  assert.equal(ciCapText, CI_CAPTION, "CI's caption reads the CI_CAPTION constant, never a guessed/hand-copied word");
  // gate② finding [6] (ac7-ci-caption-self-reference): the assertion above compares the render
  // against the SAME `CI_CAPTION` import that produced it — changing that constant's value would
  // leave it green. This pins the literal word independently, so a changed constant reddens here.
  assert.equal(ciCapText, "github", 'CI\'s caption must literally read "github", independent of the CI_CAPTION import');
  assert.equal(Number(ciCapX), GATES.ci, "the CI caption is centred on the CI gate's own x");
  assert.equal(
    Number(ciCapY),
    GATES.y + GATES.r + NODE_CAPTION_OFFSET,
    "the CI caption sits in the SAME below-label slot every other node caption uses",
  );

  // GithubActionsGlyph's own rendered asset markup — the standard devicon path data, recoloured
  // to currentColor, never the original literal hex fills.
  const glyphMatch = ciGate.match(/<svg viewBox="([^"]*)"[^>]*>([\s\S]*?)<\/svg>/);
  assert.ok(glyphMatch, "the GithubActionsGlyph's own nested <svg> must render inside the CI gate");
  const [, glyphViewBox, glyphInner] = glyphMatch as unknown as [string, string, string];
  assert.equal(glyphViewBox, "0 0 128 128", "the standard devicon GitHub Actions asset's own viewBox");
  const glyphFills = [...glyphInner.matchAll(/fill="([^"]*)"/g)].map((m) => m[1] as string);
  assert.ok(glyphFills.length >= 2, "the asset's two <path>s must each carry their own fill");
  assert.ok(
    glyphFills.every((f) => f === "currentColor"),
    `every fill must resolve to currentColor, never a literal hex: ${JSON.stringify(glyphFills)}`,
  );
  assert.doesNotMatch(glyphInner, /#2088ff|#79b8ff/i, "no legacy literal hex from the original asset remains");
  assert.doesNotMatch(html, /#2088ff|#79b8ff/i, "no legacy literal hex anywhere in the hero markup");
});

// ── "?" legend toggle ──────────────────────────────────────────────────────────

test("the legend exposes all three metaphor keys — droplet, lane, ring — and role vocabulary lives only here", () => {
  assert.equal(LEGEND_ITEMS.length, 3);
  // #892: was a native <details> (content always in static markup); now a Radix popover, whose
  // content only mounts on real interaction — see the real-DOM test below for the open/content
  // proof. This half stays SSR-only for what's still SSR-visible: the closed trigger button.
  const html = renderToStaticMarkup(createElement(Legend));
  assert.match(html, /<button[^>]*aria-label="Legend"[^>]*>\?<\/button>/);
  assert.doesNotMatch(html, /droplet = an issue moving through the loop/, "closed by default — content isn't in the DOM until opened");
});

test("real DOM: clicking the legend trigger opens the popover with all three metaphor keys, role vocabulary lives only here", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Legend));
    });
    const trigger = container.querySelector('button[aria-label="Legend"]') as HTMLButtonElement;
    assert.ok(trigger, "the trigger renders as a real, accessibly-named button");
    assert.equal(container.querySelector('[role="dialog"], [data-state="open"]'), null, "closed before any interaction");

    await act(async () => {
      trigger.click();
    });

    // Popover.Portal renders content into document.body, not `container` — same reason the
    // header-reflow fix works (the content never becomes part of .app-header's own subtree).
    const html = document.body.innerHTML;
    assert.match(html, /droplet = an issue moving through the loop/);
    assert.match(html, /lane = one autonomous worker/);
    assert.match(html, /ring = one merged PR/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── Stage rendering ───────────────────────────────────────────────────────────

test("the stage draws one channel per `lanes.max`, each with its plain-language label", () => {
  const html = markup(initialHeroState(3));
  assert.equal(html.match(/class="hero-lane"/g)?.length, 3);
  // #716 gate② P1-9 (PO live probe, baseline + §6): the plain slot label is `w{n}`, not the
  // generic "Work lane N" this used to render.
  assert.match(html, />w1</);
  assert.match(html, />w3</);
  assert.doesNotMatch(html, /Work lane/);
});

test("#895 item 7: a raw engine worker id never renders as primary lane-caption text — a short #issue form renders instead, full id kept as an inline <title> tooltip", () => {
  const { state } = run([ev("dispatched", { worker: "lane-880-a048dacf", issue: 880 })]);
  const html = markup(state);
  // The short display form is the visible text, with the full id in a real, INLINE <title>
  // tooltip (`itemProp` is what keeps React 19 from hoisting a bare <title> to document.head).
  assert.match(html, /<title itemProp="worker-id">lane-880-a048dacf<\/title>#880<\/text>/);
  // The raw id never appears as VISIBLE TEXT anywhere else — strip the tooltip's own text
  // (the one legitimate occurrence), then every remaining tag (dropping non-text attributes
  // like the droplet's own pre-existing `data-lane`, out of this item's scope), leaving only
  // rendered text nodes to check.
  const withoutTooltipText = html.replace(/<title[^>]*>[^<]*<\/title>/g, "");
  const visibleText = withoutTooltipText.replace(/<[^>]*>/g, "");
  assert.doesNotMatch(visibleText, /lane-880-a048dacf/);
});

test("an unreadable config draws one placeholder channel with the §3 direction", () => {
  const html = markup(initialHeroState(null));
  assert.equal(html.match(/class="hero-lane"/g)?.length, 1);
  assert.match(html, /lane count unknown — config unreadable/);
});

test("a worker beyond `lanes.max` still gets a channel rather than vanishing", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("dispatched", { worker: "w2", issue: 2 })], 1);
  assert.equal(state.lanes.length, 2);
  assert.equal(state.lanes[1]?.issue, 2);
});

test("a freed channel is reused by the next dispatch", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
  ]);

  assert.equal(state.lanes.length, 3);
  assert.equal(state.lanes[0]?.worker, "w2");
  assert.equal(state.lanes[0]?.issue, 2);
});

test("the lane count re-fits when the config arrives, without losing what was folded", () => {
  const { state } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("merged", { worker: "w1", issue: 1, pr: 11 })], null);
  assert.equal(state.laneCountUnknown, true);
  assert.match(markup(state), /lane count unknown — config unreadable/);

  const fitted = withLaneCount(state, 3);
  assert.equal(fitted.lanes.length, 3);
  assert.equal(fitted.laneCountUnknown, false);
  assert.equal(fitted.rings, 1);
  assert.equal(fitted.lastId, state.lastId);
  assert.doesNotMatch(markup(fitted), /config unreadable/);

  assert.equal(withLaneCount(fitted, 3), fitted);
});

// ── #716 gate② P1-9 (PO live probe): tracks cap at the CONFIGURED slot count ──────

const laneAt = (channel: number, phase: LaneView["phase"] = "idle", worker: string | null = null, touchedAt = 0): LaneView => ({
  channel,
  worker,
  issue: null,
  phase,
  fixRound: 0,
  reason: null,
  touchedAt,
  startedAt: null,
  costUsd: null,
  estCostUsd: null,
  costEstimated: null,
});

test("#716 gate② P1-9: visibleLanes caps at lanesMax, prioritizing active lanes over idle overflow", () => {
  // 5 idle lanes, lanesMax 3 — the fold never had reason to draw more than 3 real tracks.
  const idleOnly = Array.from({ length: 5 }, (_, i) => laneAt(i));
  const cappedIdle = visibleLanes(idleOnly, 3);
  assert.equal(cappedIdle.length, 3);
  assert.deepEqual(
    cappedIdle.map((l) => l.channel),
    [0, 1, 2],
  );

  // Two ACTIVE lanes buried among idle ones must survive the cut over idle overflow.
  const mixed = [laneAt(0), laneAt(1, "fixing", "w2"), laneAt(2), laneAt(3, "writing", "w4"), laneAt(4)];
  const cappedMixed = visibleLanes(mixed, 2);
  assert.equal(cappedMixed.length, 2);
  assert.deepEqual(
    cappedMixed.map((l) => l.worker),
    ["w2", "w4"],
  );
  // Renumbered 0..n-1 for display — the raw channel 1/3 must not leak into the DOM index.
  assert.deepEqual(
    cappedMixed.map((l) => l.channel),
    [0, 1],
  );

  // Nothing to cap: lanesMax unreadable (`null`) or already within budget passes through
  // (renumbered, but never dropped).
  assert.equal(visibleLanes(idleOnly, null).length, 5);
  assert.equal(visibleLanes([laneAt(0), laneAt(1)], 3).length, 2);
});

test("#716 gate② round 2 P1-1 + PO probe: among SAME-tier lanes, the MOST RECENTLY touched survives — not first-seen/array order", () => {
  // Three long-`driving` (PR-out-for-review) lanes, all tied at the same priority tier, plus
  // one touched far more recently — the exact shape the PO's live probe found: three old
  // `driving` lanes (lane-401/-403/-434) drawn while the genuinely active lane
  // (lane-293-6f5f168d) was cut, because a plain priority-only sort's ties resolve to array
  // (creation) order — i.e. OLDEST first, backwards from what the operator needs to see.
  const stale = [laneAt(0, "driving", "lane-401", 10), laneAt(1, "driving", "lane-403", 20), laneAt(2, "driving", "lane-434", 30)];
  const fresh = laneAt(3, "driving", "lane-293-6f5f168d", 999);
  const capped = visibleLanes([...stale, fresh], 3);

  assert.equal(capped.length, 3);
  assert.ok(
    capped.some((l) => l.worker === "lane-293-6f5f168d"),
    "the most recently touched lane must survive the cut over older same-tier lanes",
  );
  // The survivors are the three most recently touched overall (293@999, 434@30, 403@20) —
  // 401@10, the OLDEST, is the one that gets cut.
  assert.deepEqual(capped.map((l) => l.worker).sort(), ["lane-293-6f5f168d", "lane-403", "lane-434"]);
});

test("#716 gate② round 2 P1-1 + PO probe: a live DB's worth of abandoned lanes folds down to lanesMax tracks — active lane IS drawn, omitted-lane droplets are DROPPED, never piled onto channel 0", () => {
  // Simulates the PO's live probe: many distinct worker identities dispatch-then-fail (a
  // FAILED, never-revisited channel is never released — `moveDroplet`'s own doc — so it
  // permanently occupies a slot in the RAW fold, same as a worker name the fold has simply
  // never reused). One currently-active worker (w40) is still on shift.
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 39; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-failed", { worker: `w${i}`, issue: i, next: "ESCALATE" }));
  }
  events.push(ev("dispatched", { worker: "w40", issue: 40 }));

  const { state } = run(events, 3);
  // The RAW fold really did grow past the configured slot count — this is the bug's root
  // shape, not something `run()`'s fixture massaged away.
  assert.ok(state.lanes.length > 3, `expected raw fold to overflow past 3, got ${state.lanes.length}`);
  // Every dead worker's droplet is still riding its lane, un-released — this is the pile-up
  // bug's precondition: 40 real `at: "lane"` droplets, only 3 tracks to draw them on.
  assert.equal(state.droplets.filter((d) => d.at === "lane").length, 40);

  const view = withVisibleLanes(state, 3);
  assert.equal(view.lanes.length, 3);
  // (a) the active lane IS on a track.
  assert.ok(
    view.lanes.some((l) => l.worker === "w40"),
    "the active lane must survive the cap",
  );
  const visibleWorkers = new Set(view.lanes.map((l) => l.worker));
  // (b) NO droplet renders for an omitted lane — every surviving droplet's lane is one of the
  // 3 tracks actually drawn, never remapped onto whichever happens to occupy channel 0.
  assert.equal(view.droplets.length, 3, "only the surviving lanes' droplets remain — 37 must be dropped, not remapped");
  for (const d of view.droplets) {
    assert.ok(
      d.lane !== null && visibleWorkers.has(d.lane),
      `droplet for issue ${d.issue} (lane ${d.lane}) must belong to a surviving lane`,
    );
  }
  assert.ok(
    view.droplets.some((d) => d.lane === "w40"),
    "the active worker's own droplet must survive",
  );

  const html = markup(state, { lanesMax: 3 });
  assert.equal(html.match(/class="hero-lane"/g)?.length, 3, "the stage draws exactly lanesMax tracks, never state.lanes.length");
  assert.equal(html.match(/class="hero-droplet"/g)?.length, 3, "no extra droplets pile onto an omitted lane's channel");
  assert.match(html, /data-issue="40"/, "the active worker's issue is actually drawn, not silently cut along with its 37 dead siblings");
});

test("the backlog renders this round's selection pool", () => {
  const { state } = run([ev("pool-selected", { round_id: 1, issues: [86, 88, 90] })]);
  const html = markup(state);

  assert.equal(html.match(/class="hero-pool-chip"/g)?.length, 3);
  assert.match(html, /BACKLOG/);
});

test("#897 AC4: BACKLOG carries the ready count, and the pool beyond the filled cap draws as an outlined candidate stack", () => {
  const { state } = run([ev("pool-selected", { round_id: 1, issues: [86, 88, 90, 92, 94] })]);
  const html = markup(state);

  // N is `state.pool.length` — the same array both the filled and candidate cards below draw
  // from, never a second guess at "how many are ready".
  assert.equal(state.pool.length, 5);
  assert.match(html, /BACKLOG \(5 ready\)/);

  // Two distinguishable element sets: the existing filled pool chips, capped, and a separate
  // outlined candidate-stack set for the rest — not just one filled-chip list.
  assert.equal(html.match(/class="hero-pool-chip"/g)?.length, 3, "only the front of the queue draws filled");
  assert.equal(html.match(/class="hero-pool-candidate"/g)?.length, 2, "the rest draws as a distinguishable outlined set");
  assert.match(html, /class="hero-pool-candidate" data-issue="92"/);
  assert.match(html, /class="hero-pool-candidate" data-issue="94"/);
});

test("#897 AC4: a pool at or under the filled cap draws no candidate stack at all", () => {
  const { state } = run([ev("pool-selected", { round_id: 1, issues: [86, 88, 90] })]);
  const html = markup(state);
  assert.match(html, /BACKLOG \(3 ready\)/);
  assert.doesNotMatch(html, /hero-pool-candidate/);
});

// #897: the two tests above assert class names/counts only — removing or overriding
// `.hero-pool-candidate rect { fill: none; stroke: ... }` would leave both green. This mounts the
// REAL production cascade (tokens.css → panels.css → hero.css → app.css's body rule, same order
// the #879 gate② test above already established) into a real DOM and reads `getComputedStyle`,
// proving the candidate rect actually resolves to no fill with a visible stroke, and that a
// filled pool chip resolves distinguishably (NOT `fill: none`) under the exact same cascade.
//
// #897: `notEqual(stroke, "none")`/`notEqual(stroke, "")` still passes for a transparent stroke
// or `stroke-opacity: 0` — the STYLE doctrine's own "never notEqual/existence" rule. Every value
// below is now the EXACT resolved string, verified empirically against this repo's real
// happy-dom harness rather than assumed: `var(--bark)` (a plain hex, `tokens.css`) resolves to
// the literal `"#8A7A64"` and `stroke-opacity: 0.35` resolves to the literal `"0.35"`, both
// through a CSS class rule exactly like `.hero-pool-candidate rect` declares. `var(--sap-fill)`
// (#924: a plain hex, unlike `--sap-text`'s `light-dark()`) resolves through happy-dom's cascade
// to the literal, deterministic string `"#E8A33D"` — verified directly against THIS shape (an
// inline `fill: var(--sap-fill)` on an SVG rect, the exact form `.hero-pool-chip`'s own rect
// authors), not assumed from `shots/shots.spec.ts`'s own doc, which found a BARE top-level
// `color`/background `light-dark()` resolves EMPTY in happy-dom — a different context this
// repo's test suite hasn't previously exercised through a `var()` indirection. Both `--bark` and
// `--sap-fill` resolve to real, exact, deterministic strings THIS cascade produces every time —
// not a resolved final RGB (a real browser only would give that, per `shots.spec.ts`'s same
// doc), but exact and non-fakeable regardless: a transparent/removed stroke or a no-fill
// regression on either element changes one of these literal strings.
test("#897 AC4: a candidate card's rect resolves to the EXACT no-fill/visible-stroke values, distinguishable from a filled pool chip's EXACT fill, under the real production cascade", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = markup(run([ev("pool-selected", { round_id: 1, issues: [86, 88, 90, 92, 94] })]).state);
  document.body.appendChild(container);
  try {
    const candidateRect = container.querySelector(".hero-pool-candidate rect");
    assert.ok(candidateRect, "a real .hero-pool-candidate rect must render and match the injected stylesheet's selector");
    const candidateComputed = getComputedStyle(candidateRect as Element);
    assert.equal(candidateComputed.fill, "none", "the candidate card must actually cascade to no fill, not just declare it in source");
    assert.equal(candidateComputed.stroke, "#8A7A64", "the candidate card's stroke must resolve to the EXACT --bark hex, never a stand-in");
    assert.equal(
      candidateComputed.strokeOpacity,
      "0.35",
      "the candidate card's stroke must resolve a NONZERO opacity — a `stroke-opacity: 0` regression would still pass a bare non-empty/non-none check",
    );

    const filledRect = container.querySelector(".hero-pool-chip rect");
    assert.ok(filledRect, "a real .hero-pool-chip rect must also render for the distinguishability comparison");
    const filledComputed = getComputedStyle(filledRect as Element);
    assert.equal(
      filledComputed.fill,
      "#E8A33D",
      "a filled pool chip must resolve to the EXACT --sap-fill token text, distinguishable from the candidate's exact 'none'",
    );
    // #924 AC3: the PAINTED surface, not just the token — a `fill-opacity` regression could
    // leave `fill` correctly resolving to `--sap-fill`'s own hex while still compositing it
    // translucent over the panel underneath. `--on-sap-fill`'s own AA claim (contrast.ts's
    // checkFillTextContrast) is only true of the REAL rendered pixels when this is exactly "1" —
    // full opacity, no compositing.
    assert.equal(
      filledComputed.fillOpacity,
      "1",
      "a filled pool chip must paint fully opaque — a translucent chip breaks AC3's ink contrast",
    );
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// ── #728: backlog chip / needs-human / outcome-tally overlap ──────────────────
//
// The hero is one `viewBox`-scaled SVG (`.hero { width: 100%; height: auto }`, asserted
// below) — every element scales together, so geometry that doesn't collide in the SVG's own
// intrinsic coordinate space cannot collide at any rendered container width either. Checking
// the intrinsic positions once is equivalent to checking it at 1440/1024/720px.
//
// #728 gate② finding [0]: comparing anchor-point CENTERS against a fixed-pixel margin (the
// original version of these two tests) never actually establishes non-overlap — it passes
// whether or not the rendered text/circles truly collide, since it ignores every element's
// real width/height. These bounding-box helpers turn each element's font-size + character
// count into an actual rendered extent and assert real rectangle intersection instead.
type Box = { left: number; right: number; top: number; bottom: number };

// Every element boxed below draws --font-data (ui-monospace: SF Mono/Menlo/Consolas), whose
// glyphs run close to a fixed 0.62em advance — a monospace character count gives a
// deterministic, no-browser width. The one exception, the "saved for a successor" badge, draws
// --font-body (system-ui, proportional, narrower on average); reusing the same 0.62em advance
// for it is deliberately conservative — an overestimate, never a too-tight one.
const CHAR_ADVANCE = 0.62;
const ASCENT = 0.8;
const DESCENT = 0.25;

const textBox = (text: string, centerX: number, baselineY: number, fontPx: number): Box => {
  const halfWidth = (text.length * fontPx * CHAR_ADVANCE) / 2;
  return { left: centerX - halfWidth, right: centerX + halfWidth, top: baselineY - fontPx * ASCENT, bottom: baselineY + fontPx * DESCENT };
};

const circleBox = (centerX: number, centerY: number, r: number): Box => ({
  left: centerX - r,
  right: centerX + r,
  top: centerY - r,
  bottom: centerY + r,
});

/**
 * gate② finding [0] (ac2-geometry-oracle-assumes-fit): the droplet's true rendered footprint,
 * parsed from its OWN `d` attribute's literal numbers — never by re-calling `dropletRadius`/
 * `dropletPath` (that would just prove the two functions agree with each other, not that the
 * markup they produced together is actually the shape/size claimed). `dropletPath`'s own grammar
 * is `M0,tip C c1x,c1y c2x,c2y c2x,beltY A r,r 0 1 1 -c2x,beltY C ...` — a teardrop whose tip and
 * the arc's own two (explicit, on-path) endpoints are read directly; the arc's own DEEPEST point
 * (never a literal number in the string) is computed from real circular-arc geometry: two points
 * that share a y and sit exactly 2r apart are a semicircle's diameter, and sweep-flag=1/large-
 * arc-flag=1 (checked, not assumed) draws the branch bulging AWAY from the tip.
 */
function dropletPathBBox(d: string): Box {
  const mMove = d.match(/^M0,(-?[\d.]+)/);
  assert.ok(mMove, `droplet path "${d}" must open with an M0,<tip> move`);
  const tip = Number(mMove?.[1]);

  // The first C command's THREE point pairs — the arc's own start point is this curve's own
  // endpoint (the third pair), never the earlier control points.
  const mCurve1 = d.match(/C(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)/);
  assert.ok(mCurve1, `droplet path "${d}" must have a C command with 3 point pairs before the arc`);
  const [, , , , , curveEndXRaw, curveEndYRaw] = mCurve1 as unknown as string[];
  const arcStartX = Number(curveEndXRaw);
  const beltY = Number(curveEndYRaw);

  const mArc = d.match(/A(-?[\d.]+),(-?[\d.]+) 0 (\d) (\d) (-?[\d.]+),(-?[\d.]+)/);
  assert.ok(mArc, `droplet path "${d}" must have an A (arc) command`);
  const [, rxRaw, ryRaw, largeArcRaw, sweepRaw, arcEndXRaw, arcEndYRaw] = mArc as unknown as string[];
  const rx = Number(rxRaw);
  assert.equal(rx, Number(ryRaw), "the arc must be circular (rx === ry)");
  assert.equal(Number(arcEndYRaw), beltY, "the arc's end point must sit at the SAME y as its start (a diameter-separated semicircle)");
  const arcEndX = Number(arcEndXRaw);
  assert.ok(Math.abs(arcStartX + arcEndX) < 1e-6, "the arc's two endpoints must be symmetric about x=0");
  assert.ok(Math.abs(Math.abs(arcStartX - arcEndX) - 2 * rx) < 1e-6, "the arc's endpoints must be exactly 2r apart (a true diameter)");
  assert.equal(largeArcRaw, "1", "large-arc-flag must be 1");
  assert.equal(sweepRaw, "1", "sweep-flag must be 1 — the branch this bbox math assumes bulges AWAY from the tip");
  return { left: -rx, right: rx, top: tip, bottom: beltY + rx };
}

/**
 * #808: `textBox()`'s 0.8 ASCENT undershoots real rendered ink — measured by rendering this
 * file's own `HeroStage` markup + `hero.css`/`tokens.css` in a real Chromium tab (chrome-devtools
 * MCP), 1700px container width over the 1200×380 viewBox (1.417× scale, converted back to
 * SVG-unit space via `getBoundingClientRect` and the SVG's own screen-CTM scale factor — SVG
 * `width:100%` scales uniformly, so unit-space clearance is scale-invariant regardless of which
 * physical viewport width renders it). `--font-data` resolved to ui-monospace/SF Mono on that
 * Chrome; both the 10px droplet chip label (`hero-num.hero-small`) and the 9px caption
 * (`hero-node-caption`) measured a real ascent of ~0.92–0.94em above baseline, against
 * `textBox()`'s modeled 0.8em — a ~15% underestimate, exactly the gap #808's PR #791 live-DOM
 * probe found (a checkpoint chip's label-box bottom edge shaving the Review gate's
 * "engine-agent" caption top, real ink contact `textBox()`'s model could not see). 1.0em here
 * adds a safety margin above the measured ~0.94em for font stacks that one macOS measurement
 * never sampled — CI's Linux font fallback in particular, since `dashboard/package.json` ships
 * no Playwright/e2e harness to measure it directly there. DESCENT/CHAR_ADVANCE are untouched:
 * the same measurement found `textBox()`'s existing 0.25/0.62 already conservative (real
 * ~0.21–0.24 / ~0.60–0.61) — #808's probe named an ascent-side gap specifically, not those.
 */
const CAPTION_SAFE_ASCENT = 1.0;

/** Same shape as `textBox()`, refined per `CAPTION_SAFE_ASCENT` above; `anchor` matches the
 *  element's own `text-anchor` (default SVG behavior — no attribute — is "start", i.e. `x` is
 *  the left edge, not the center `textBox()` always assumes; "end" — `x` is the RIGHT edge,
 *  e.g. stage.tsx's right-anchored `.hero-label` ring/rings caption). */
const captionSafeTextBox = (
  text: string,
  x: number,
  baselineY: number,
  fontPx: number,
  anchor: "start" | "middle" | "end" = "middle",
): Box => {
  const width = text.length * fontPx * CHAR_ADVANCE;
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  return { left, right: left + width, top: baselineY - fontPx * CAPTION_SAFE_ASCENT, bottom: baselineY + fontPx * DESCENT };
};

/**
 * #808 gate② finding [0] (run 9c57bd50): the font-size arguments fed to `captionSafeTextBox`
 * below used to be hand-copied literals (9/10/12) — a silent duplicate of `hero.css`'s own
 * `.hero-node-caption`/`.hero-small`/`.hero-node-label` rules with nothing tying the two
 * together, so a future CSS size edit could desync the oracle from what actually renders while
 * this test stayed green. Reads the effective px straight from `heroCss` instead. All three
 * selectors below are single, non-combined rules — no cascade ambiguity to resolve here, unlike
 * `.hero-small` vs. `.hero-node-caption`'s own declared-AFTER precedence (already pinned by the
 * `#728 gate② finding [0]` source-order test above, which is why `.hero-small`'s 10px — not
 * `.hero-num`'s 11px — is the effective droplet-label size read below).
 */
function cssFontSizePx(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = heroCss.match(new RegExp(`${escaped}\\s*\\{[^}]*font-size:\\s*(\\d+)px`));
  if (!match) throw new Error(`${selector} must declare a pixel font-size in hero.css`);
  return Number(match[1]);
}

const CAPTION_FONT_PX = cssFontSizePx(".hero-node-caption");
const DROPLET_LABEL_FONT_PX = cssFontSizePx(".hero-small");
const GATE_NODE_LABEL_FONT_PX = cssFontSizePx(".hero-node-label");
const RING_WORD_FONT_PX = cssFontSizePx(".hero-label");

const boxesOverlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Every pairwise combination of `boxes` must be collision-free. */
function assertNoOverlap(boxes: { label: string; box: Box }[]): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      assert.ok(!boxesOverlap(a.box, b.box), `${a.label} ${JSON.stringify(a.box)} overlaps ${b.label} ${JSON.stringify(b.box)}`);
    }
  }
}

test("#728: the stage scales as one unit — geometry checked once covers every rendered width, including 1440/1024/720", () => {
  assert.match(heroCss, /\.hero\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
});

// #920 AC2: the mockup's own 2.33:1 band, re-based from the old 3.16:1 (1200×380). Reads
// STAGE/GATES/PLANNING_NODE_R straight from stage.tsx — never a copied literal.
test("#920 AC2: STAGE is a 2.2-2.5:1 band, and the planning/CI/Review nodes are >= 30 stage units radius", () => {
  const ratio = STAGE.w / STAGE.h;
  assert.ok(ratio >= 2.2 && ratio <= 2.5, `STAGE.w/STAGE.h = ${ratio} must be within [2.2, 2.5]`);
  assert.ok(PLANNING_NODE_R >= 30, `PLANNING_NODE_R (${PLANNING_NODE_R}) must be >= 30 stage units`);
  assert.ok(GATES.r >= 30, `GATES.r (${GATES.r}) must be >= 30 stage units`);
});

/** Every rendered `.hero-lane` group, by its own `data-lane-index` — #920 AC3's own "derived from
 *  the rendered elements, not a hand list" requirement. */
function laneBlocks(html: string): { channel: number; block: string }[] {
  return [...html.matchAll(/<g class="hero-lane"[^>]*data-lane-index="(\d+)"[^>]*>([\s\S]*?)<\/g>/g)].map(([, ch, block]) => ({
    channel: Number(ch),
    block: block as string,
  }));
}

// #920 AC3: every visible lane channel — at lanesMax 1..4, the SET the AC itself names — carries
// hollow-circle terminals at both ends and a curved connector whose start is the end terminal and
// whose end point lies exactly on the CI node's own circle.
test("#920 AC3: every visible lane channel gets hollow-circle terminals at both ends, and a connector reaching the CI node's own circle boundary", () => {
  for (const lanesMax of [1, 2, 3, 4]) {
    const html = markup(initialHeroState(lanesMax), { lanesMax });
    const blocks = laneBlocks(html);
    assert.equal(blocks.length, lanesMax, `lanesMax=${lanesMax} must render exactly that many .hero-lane groups`);

    for (const { channel, block } of blocks) {
      const terminals = [...block.matchAll(/<circle class="hero-lane-terminal" cx="(-?[\d.]+)" cy="(-?[\d.]+)"/g)].map(([, cx, cy]) => ({
        x: Number(cx),
        y: Number(cy),
      }));
      assert.equal(terminals.length, 2, `lane ${channel} must carry exactly two hollow terminals (lanesMax=${lanesMax})`);
      const rowY = LANES.top + channel * LANES.gap;
      assert.deepEqual(terminals[0], { x: LANES.x, y: rowY }, `lane ${channel} start terminal`);
      assert.deepEqual(terminals[1], { x: LANES.x + LANES.w, y: rowY }, `lane ${channel} end terminal`);

      const pathMatch = block.match(/<path class="hero-lane-connector" d="([^"]*)"/);
      assert.ok(pathMatch, `lane ${channel} must render a connector path (lanesMax=${lanesMax})`);
      const nums = (pathMatch![1] as string).match(/-?[\d.]+/g)!.map(Number);
      assert.equal(nums.length, 8, "M sx sy C c1x c1y, c2x c2y, ex ey — 8 numbers");
      const [startX, startY, , , , , endX, endY] = nums as [number, number, number, number, number, number, number, number];
      assert.deepEqual({ x: startX, y: startY }, terminals[1], `lane ${channel} connector must start at its own end terminal`);
      const dist = Math.hypot(endX - GATES.ci, endY - GATES.y);
      assert.ok(
        Math.abs(dist - GATES.r) <= 1,
        `lane ${channel} connector end must land on the CI circle: distance ${dist} vs GATES.r ${GATES.r}`,
      );
    }
  }
});

// #920 gate② finding [1] (ac3-hollow-style-unverified): "hollow" is a rendered CSS fact
// (`fill: none`), not something the markup structure test above can see — a `.hero-lane-terminal`
// rule declaring `fill: var(--sap-fill)` would leave that test green while violating
// "hollow-circle terminal" outright. STYLE doctrine (docs/REVIEW-DOCTRINE.md): `registerRealDom()` + a real
// `getComputedStyle` read against the FULL production cascade, never a regex on the source text —
// same pattern the #879 gate② finding [1] fix already established in this file.
test("#920 gate② finding [1]: a real .hero-lane-terminal renders fill:none under the production cascade — hollow is a rendered fact, not just a class name", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = markup(initialHeroState(2), { lanesMax: 2 });
  document.body.appendChild(container);
  try {
    const terminal = container.querySelector(".hero-lane-terminal");
    assert.ok(terminal, "a real .hero-lane-terminal element must render and match the injected stylesheet's selector");
    const computed = getComputedStyle(terminal as Element);
    assert.equal(
      computed.fill,
      "none",
      "a lane terminal must render hollow (fill: none) under the real cascade, not merely carry the class name",
    );
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #920 gate② review thread (PRRT…JE1, revised at …gI/…GgJ): round 1's fix (`--bark-text`, the
// MUTED text token) still only reached 51% of the mockup's own contrast in dark theme — the
// mockup draws these in the SAME PRIMARY ink as `.hero-node-label` (`--sapwood`), not a
// separately-muted variant. "No 45% wash" (AC6) isn't only about `[data-dimmed]`, it's every idle
// stage line drawn at a muted token. STYLE doctrine: prove the RESOLVED colour against a real
// `.hero-node-label` element (never a hardcoded theme RGB that could drift from `--sapwood`'s own
// definition).
//
// #920 gate② finding [1] (ac7-style-coverage-incomplete): mounting the cascade ONCE without ever
// setting `data-theme` never actually exercised the explicit `sapwood`/`heartwood` overrides
// (`--sapwood`'s own `light-dark()` definition could regress in one theme's own branch and this
// would still pass) — looped over both, same `document.documentElement.setAttribute("data-theme",
// …)` pattern `Transport.test.tsx`'s own gate② fix already established.
test("#920 gate② review thread (PRRT…gI/…GgJ) + finding [1]: idle planning/gate node strokes resolve to the SAME colour as .hero-node-label's PRIMARY ink, at full opacity, in BOTH themes — no muted wash", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = markup(initialHeroState(3));
  document.body.appendChild(container);
  try {
    for (const themeAttr of ["heartwood", "sapwood"]) {
      document.documentElement.setAttribute("data-theme", themeAttr);

      const inkEl = container.querySelector(".hero-node-label");
      assert.ok(inkEl, `${themeAttr}: a real .hero-node-label element must render`);
      const inkColor = getComputedStyle(inkEl as Element).fill;
      assert.notEqual(inkColor, "", `${themeAttr}: the primary ink token must actually resolve to a real colour under the mounted cascade`);

      const planningNode = container.querySelector(".hero-planning-node");
      assert.ok(planningNode, `${themeAttr}: a real .hero-planning-node must render`);
      const planningComputed = getComputedStyle(planningNode as Element);
      assert.equal(
        planningComputed.stroke,
        inkColor,
        `${themeAttr}: idle planning-node stroke must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(
        planningComputed.strokeOpacity,
        "1",
        `${themeAttr}: idle planning-node stroke must render at full opacity, no muted wash`,
      );

      const gateNode = container.querySelector(".hero-gate-node");
      assert.ok(gateNode, `${themeAttr}: a real .hero-gate-node must render`);
      const gateComputed = getComputedStyle(gateNode as Element);
      assert.equal(
        gateComputed.stroke,
        inkColor,
        `${themeAttr}: idle gate-node stroke must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(gateComputed.strokeOpacity, "1", `${themeAttr}: idle gate-node stroke must render at full opacity, no muted wash`);

      // #920 gate② review thread (PRRT…JE1's own family): the reflection T + return path share
      // this same fix (`.hero-arm`/`.hero-return` in hero.css).
      const armEl = container.querySelector(".hero-arm");
      assert.ok(armEl, `${themeAttr}: a real .hero-arm element (the reflection tree) must render`);
      const armComputed = getComputedStyle(armEl as Element);
      assert.equal(
        armComputed.stroke,
        inkColor,
        `${themeAttr}: the reflection tree's stroke must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(armComputed.strokeOpacity, "1", `${themeAttr}: the reflection tree's stroke must render at full opacity, no muted wash`);

      const returnEl = container.querySelector(".hero-return");
      assert.ok(returnEl, `${themeAttr}: a real .hero-return element must render`);
      const returnComputed = getComputedStyle(returnEl as Element);
      assert.equal(
        returnComputed.stroke,
        inkColor,
        `${themeAttr}: the return path's stroke must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(returnComputed.strokeOpacity, "1", `${themeAttr}: the return path's stroke must render at full opacity, no muted wash`);
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #922 "What" / gate② finding [2] (ac5-lane-stroke-still-muted): idle lane strokes must clear
// >= 60% alpha (--bark) and every active state (writing/fixing/driving) resolves --sap-text at
// full opacity — the pre-fix 0.35 idle / 0.5 driving values never actually closed this issue's
// own explicit floor, and nothing pinned the winning computed style to catch it staying muted.
//
// gate② finding [4] (ac5-waypoint-color): the lane's own `.hero-lane-terminal` waypoints must
// take the SAME colour as their channel, at every phase this test already exercises — the
// pre-fix terminal was a fixed --bark @ 0.5 regardless of phase, so an active lane's own start/
// end circles stayed muted even while its channel read as fully active.
test("#922: idle lane channel/connector strokes resolve --bark at >= 60% alpha; writing/fixing/driving resolve --sap-text at 100%, in both themes", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  // 3 lanes, only 2 dispatched — the 3rd stays genuinely `data-phase="idle"` (state.ts's own
  // default), so the idle CSS rule is proven against a REAL idle lane, not just the first
  // `.hero-channel` element happening to be a different, non-idle phase.
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING", pr: 20 }),
  ]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { lanesMax: 3 });
  document.body.appendChild(container);
  const expectedBark = parseTokens(tokensCss)["--bark"];
  const expectedSapText = parseTokens(tokensCss)["--sap-text"];
  try {
    for (const themeAttr of ["heartwood", "sapwood"] as const) {
      document.documentElement.setAttribute("data-theme", themeAttr);

      const idleChannel = container.querySelector('.hero-lane[data-phase="idle"] .hero-channel') as Element;
      assert.ok(idleChannel, `${themeAttr}: a genuinely idle (undispatched) lane must render`);
      const idleComputed = getComputedStyle(idleChannel);
      assert.equal(idleComputed.stroke, expectedBark, `${themeAttr}: idle channel stroke must resolve to --bark`);
      assert.ok(
        Number.parseFloat(idleComputed.strokeOpacity) >= 0.6,
        `${themeAttr}: idle channel stroke-opacity ${idleComputed.strokeOpacity} must clear the AC's own >= 60% floor`,
      );

      const idleConnector = container.querySelector('.hero-lane[data-phase="idle"] .hero-lane-connector') as Element;
      assert.ok(idleConnector, `${themeAttr}: the idle lane's own connector must render`);
      assert.ok(
        Number.parseFloat(getComputedStyle(idleConnector).strokeOpacity) >= 0.6,
        `${themeAttr}: idle connector stroke-opacity must clear the AC's own >= 60% floor`,
      );

      // gate② finding [4]: the idle lane's own waypoints match its channel — --bark at >= 60%.
      const idleTerminals = container.querySelectorAll('.hero-lane[data-phase="idle"] .hero-lane-terminal');
      assert.equal(idleTerminals.length, 2, `${themeAttr}: the idle lane must draw both its own waypoint terminals`);
      for (const terminal of idleTerminals) {
        const terminalComputed = getComputedStyle(terminal);
        assert.equal(
          terminalComputed.stroke,
          expectedBark,
          `${themeAttr}: idle waypoint stroke must resolve to --bark, the SAME colour as its channel`,
        );
        assert.ok(
          Number.parseFloat(terminalComputed.strokeOpacity) >= 0.6,
          `${themeAttr}: idle waypoint stroke-opacity ${terminalComputed.strokeOpacity} must clear the AC's own >= 60% floor`,
        );
      }

      const writingChannel = container.querySelector('.hero-lane[data-phase="writing"] .hero-channel') as Element;
      assert.ok(writingChannel, `${themeAttr}: a writing-phase lane must render`);
      const writingComputed = getComputedStyle(writingChannel);
      assert.equal(writingComputed.stroke, expectedSapText, `${themeAttr}: writing channel stroke must resolve to --sap-text`);
      assert.equal(writingComputed.strokeOpacity, "1", `${themeAttr}: writing channel must render at full (100%) opacity`);

      // gate② finding [4]: the writing lane's own waypoints match its channel — --sap-text at 100%.
      const writingTerminals = container.querySelectorAll('.hero-lane[data-phase="writing"] .hero-lane-terminal');
      assert.equal(writingTerminals.length, 2, `${themeAttr}: the writing lane must draw both its own waypoint terminals`);
      for (const terminal of writingTerminals) {
        const terminalComputed = getComputedStyle(terminal);
        assert.equal(
          terminalComputed.stroke,
          expectedSapText,
          `${themeAttr}: writing waypoint stroke must resolve to --sap-text, the SAME colour as its channel`,
        );
        assert.equal(
          terminalComputed.strokeOpacity,
          "1",
          `${themeAttr}: writing waypoint must render at full (100%) opacity, same as its channel`,
        );
      }

      const drivingChannel = container.querySelector('.hero-lane[data-phase="driving"] .hero-channel') as Element;
      assert.ok(drivingChannel, `${themeAttr}: a driving-phase lane must render`);
      const drivingComputed = getComputedStyle(drivingChannel);
      assert.equal(drivingComputed.stroke, expectedSapText, `${themeAttr}: driving channel stroke must resolve to --sap-text`);
      assert.equal(drivingComputed.strokeOpacity, "1", `${themeAttr}: driving channel must render at full (100%) opacity, same as active`);
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// gate② finding [4] (ac5-waypoint-color): a FAILED lane's own waypoints take --rust at 0.8, the
// SAME colour its channel already resolves (`.hero-lane[data-phase="failed"] .hero-channel`) —
// a separate fixture since neither existing failed-phase fixture in this file asserts channel
// colour either, so this is new coverage for both, not just the waypoint half.
test("#922: a FAILED lane's channel and waypoint terminals both resolve --rust at 0.8", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("reclaim-failed", { worker: "w1", issue: 1 })]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { lanesMax: 1 });
  document.body.appendChild(container);
  const expectedRust = parseTokens(tokensCss)["--rust"];
  try {
    const failedChannel = container.querySelector('.hero-lane[data-phase="failed"] .hero-channel') as Element;
    assert.ok(failedChannel, "the fixture must actually render a failed-phase lane");
    const channelComputed = getComputedStyle(failedChannel);
    assert.equal(channelComputed.stroke, expectedRust, "failed channel stroke must resolve to --rust");
    assert.equal(channelComputed.strokeOpacity, "0.8", "failed channel stroke-opacity must be 0.8");

    const failedTerminals = container.querySelectorAll('.hero-lane[data-phase="failed"] .hero-lane-terminal');
    assert.equal(failedTerminals.length, 2, "the failed lane must draw both its own waypoint terminals");
    for (const terminal of failedTerminals) {
      const terminalComputed = getComputedStyle(terminal);
      assert.equal(terminalComputed.stroke, expectedRust, "failed waypoint stroke must resolve to --rust, the SAME colour as its channel");
      assert.equal(terminalComputed.strokeOpacity, "0.8", "failed waypoint stroke-opacity must be 0.8, the SAME as its channel");
    }
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #920 gate② finding [1] (ac7-style-coverage-incomplete): "Keep the ACTIVE amber treatment as
// is" (the review thread's own instruction) had no regression guard at all — a future edit could
// silently drop `[data-active="true"] .hero-planning-node`'s own `--sap-text` override (collapsing
// active nodes onto the same idle ink this round just fixed) and nothing would catch it. Proves
// the active node's resolved stroke is DIFFERENT from the idle ink and matches the exact raw
// `--sap-text` declaration `tokens.css` itself carries (#897's own precedent: happy-dom doesn't
// evaluate `light-dark()` per theme at all, it echoes the raw `"light-dark(A, B)"` text back
// unconditionally — this is a same-cascade, theme-invariant comparison, not a per-theme resolve).
// #924: no longer the SAME token as `.hero-pool-chip rect`'s own fill — that one is now
// `--sap-fill`, a flat amber that no longer darkens for light theme the way `--sap-text` still
// does.
// #922 AC8 (STYLE + a11y, registerRealDom() via the eager import at the top of this file): the
// RUNNING role breathes as a filled disc + halo, never just an animated edge — supersedes the
// #920 test this replaces (that one asserted the OLD animated-stroke-only treatment AC8 retires).
test("#922 AC8: the active node's disc fills --sap-fill with a running 2.8s fill animation and a halo; its glyph ink is static --on-sap-fill; inactive nodes have no halo and a transparent disc", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("pool-selected", { issues: [1] })]);
  const container = document.createElement("div");
  // `roundPhase: "aligning"` lights the "goal-align" node (`activePlanningNode`, state.ts) —
  // the SAME live-cursor mechanism production drives this from, never a hand-set `data-active`.
  container.innerHTML = markup(state, { roundPhase: "aligning" });
  document.body.appendChild(container);
  const expectedSapFill = parseTokens(tokensCss)["--sap-fill"];
  const expectedOnSapFill = parseTokens(tokensCss)["--on-sap-fill"];
  assert.ok(expectedSapFill && expectedOnSapFill, "--sap-fill/--on-sap-fill must be declared in tokens.css");
  try {
    const activeGroup = container.querySelector('[data-active="true"]') as Element;
    assert.ok(activeGroup, "the active planning node's group must render");

    const halo = activeGroup.querySelector(".hero-node-halo");
    assert.ok(halo, "the active node renders a .hero-node-halo glow circle");
    assert.equal(halo?.getAttribute("r"), String(PLANNING_NODE_R + 6), "the halo is r + 6, per the AC");

    const disc = activeGroup.querySelector(".hero-planning-node") as Element;
    const discComputed = getComputedStyle(disc);
    assert.equal(discComputed.fill, expectedSapFill, "the active disc's fill resolves to --sap-fill (flat, both themes)");

    const icon = activeGroup.querySelector(".hero-planning-icon") as Element;
    const iconComputed = getComputedStyle(icon);
    assert.equal(iconComputed.color, expectedOnSapFill, "the glyph's own ink resolves to --on-sap-fill, fixed (never animated)");

    const idleGroup = container.querySelector('[data-active="false"]') as Element;
    assert.ok(idleGroup, "an idle (inactive) planning node must also render, for contrast");
    assert.equal(idleGroup.querySelector(".hero-node-halo"), null, "an inactive node has no halo element at all");
    const idleDisc = idleGroup.querySelector(".hero-planning-node") as Element;
    assert.equal(getComputedStyle(idleDisc).fill, "none", "an inactive node's disc stays transparent");
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }

  // happy-dom's getComputedStyle never resolves the `animation` shorthand (no precedent anywhere
  // else in this codebase relies on it) — the duration/easing/no-glyph-animation half of the AC
  // is pinned at the source level instead, against the exact rule this markup's class resolves.
  const activeRule = heroCss.match(/\[data-active="true"\] \.hero-planning-node \{([^}]*)\}/)?.[1] as string;
  assert.ok(activeRule, '[data-active="true"] .hero-planning-node rule must exist');
  assert.match(activeRule, /animation:\s*hero-breathe-fill\s+2\.8s\s+cubic-bezier\(0\.45,\s*0,\s*0\.55,\s*1\)/);
  const activeIconRule = heroCss.match(/\[data-active="true"\] \.hero-planning-icon \{([^}]*)\}/)?.[1] as string;
  assert.ok(activeIconRule, '[data-active="true"] .hero-planning-icon rule must exist');
  assert.doesNotMatch(activeIconRule, /animation/, "the glyph itself carries no animation — only the disc under it moves");
});

test("#922 AC8: a waiting gate breathes its STROKE only (--sap-text) at 3.6s, never the fill channel", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING" })]);
  const container = document.createElement("div");
  container.innerHTML = markup(state);
  document.body.appendChild(container);
  const expectedSapText = parseTokens(tokensCss)["--sap-text"];
  try {
    const waitingNode = container.querySelector('.hero-gate[data-state="waiting"] .hero-gate-node') as Element;
    assert.ok(waitingNode, "a waiting gate must render");
    assert.equal(getComputedStyle(waitingNode).stroke, expectedSapText);
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
  // Source-level (getComputedStyle never resolves the `animation` shorthand, see the sibling
  // active-node test's own note): duration, AND that the keyframe this rule names never declares
  // fill-opacity — the STROKE-only half of the AC.
  const waitingRule = heroCss.match(/\.hero-gate\[data-state="waiting"\] \.hero-gate-node \{([^}]*)\}/)?.[1] as string;
  assert.ok(waitingRule, "the waiting-gate rule must exist");
  assert.match(waitingRule, /animation:\s*hero-breathe-wait\s+3\.6s/);
  const waitKeyframe = heroCss.match(/@keyframes hero-breathe-wait\s*\{([\s\S]*?)\n\}/)?.[1] as string;
  assert.ok(waitKeyframe, "hero-breathe-wait keyframe must exist");
  assert.doesNotMatch(waitKeyframe, /fill-opacity/);
});

test("#922 AC8: the current ring breathes at 4.4s — no two hero animation periods coincide", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  // Two workers: w1 merges (produces the ring to assert on), w2 stays writing so
  // `data-running="true"` still holds once w1's own lane returns to idle after its merge.
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("merged", { worker: "w1", issue: 1, pr: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
  ]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { roundPhase: "aligning" });
  document.body.appendChild(container);
  try {
    const currentRing = container.querySelector('[data-running="true"].hero .hero-ring[data-current="true"]') as Element;
    assert.ok(currentRing, "the current ring must render while any lane runs");
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
  const runningRingRule = heroCss.match(/\.hero\[data-running="true"\] \.hero-ring\[data-current="true"\] \{([^}]*)\}/)?.[1] as string;
  assert.ok(runningRingRule, "the running-ring rule must exist");
  assert.match(runningRingRule, /animation:\s*hero-breathe\s+4\.4s/);

  // COVERAGE: derive every hero animation's (name, duration) pair from source, never a
  // hand-picked subset. The AC's own "never beat" requirement is about independent breathing
  // CHANNELS — hero-breathe-fill and hero-breathe-glow are ONE channel by design (the halo
  // deliberately breathes IN SYNC with its own disc, same 2.8s), so channels are grouped by their
  // shared period before checking that no two DIFFERENT channels coincide.
  const animations = [...heroCss.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s/g)].map((m) => ({
    name: m[1] as string,
    duration: m[2] as string,
  }));
  assert.ok(animations.length >= 5, "expected at least the fill/glow/wait/ring/shimmer animations");
  const channelsByDuration = new Map<string, Set<string>>();
  for (const { name, duration } of animations) {
    const channel = name === "hero-breathe-glow" ? "hero-breathe-fill" : name; // synced with the disc, not an independent channel
    if (!channelsByDuration.has(duration)) channelsByDuration.set(duration, new Set());
    channelsByDuration.get(duration)!.add(channel);
  }
  for (const [duration, channels] of channelsByDuration) {
    assert.equal(
      channels.size,
      1,
      `period ${duration}s must belong to exactly one independent channel, found: ${[...channels].join(", ")}`,
    );
  }
  assert.equal(
    channelsByDuration.size,
    4,
    `expected 4 distinct periods (fill+glow, wait, ring, shimmer): ${[...channelsByDuration.keys()].join(", ")}`,
  );
});

// gate② finding [6] (ac8-reflection-reduced-motion-unverified), first half: the earlier test only
// exercised a PLANNING node — removing the REFLECTION node's own halo/fill-animation rule would
// stay green. `roundPhase: "harvesting"` lights Summary via `activeReflectionNode` (state.ts), the
// SAME live-cursor mechanism production drives this from.
test("#922 AC8: an active REFLECTION node (Summary) also renders a halo and a --sap-fill disc, same as a planning node", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 1 })]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { roundPhase: "harvesting" });
  document.body.appendChild(container);
  const expectedSapFill = parseTokens(tokensCss)["--sap-fill"];
  try {
    const reflectionGroup = container.querySelector('.hero-reflection [data-active="true"]') as Element;
    assert.ok(reflectionGroup, "the active reflection node's own group must render");
    const halo = reflectionGroup.querySelector(".hero-node-halo");
    assert.ok(halo, "the active reflection node renders a .hero-node-halo glow circle");
    assert.equal(
      halo?.getAttribute("r"),
      String(REFLECTION.r + 6),
      "the halo is r + 6, per the AC — REFLECTION.r, not the planning node's radius",
    );
    const disc = reflectionGroup.querySelector(".hero-planning-node") as Element;
    assert.equal(
      getComputedStyle(disc).fill,
      expectedSapFill,
      "the active reflection disc's fill resolves to --sap-fill, same as a planning node",
    );

    const idleReflectionGroup = container.querySelector('.hero-reflection [data-active="false"]') as Element;
    assert.ok(idleReflectionGroup, "the idle reflection node (Retro) must also render, for contrast");
    assert.equal(idleReflectionGroup.querySelector(".hero-node-halo"), null, "the idle reflection node has no halo at all");
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// gate② finding [6], second half: the earlier reduced-motion test only regex-matched CSS SOURCE
// text — it never rendered the `data-motion="reduced"` path to prove the cascade actually WINS in
// production, and never checked the lucide icon's OWN descendant ink (only the wrapper's `color`).
// This renders both the media-query path (`window.matchMedia` isn't wired in happy-dom, so the
// `[data-motion="reduced"]` attribute selector — the SAME one the manual/replay path uses,
// `stage.tsx`'s own `reducedMotion` prop — is the one this harness can actually drive) and reads
// real computed values off the active node's disc, halo, AND the lucide glyph's own nested <svg>.
test('#922 AC8: data-motion="reduced" renders the active halo/disc statically at peak alpha in the REAL production cascade, including the lucide glyph\'s own descendant ink', () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const { state } = run([ev("pool-selected", { issues: [1] })]);
  const container = document.createElement("div");
  container.innerHTML = markup(state, { roundPhase: "aligning", reducedMotion: true });
  document.body.appendChild(container);
  const expectedPeak = parseTokens(tokensCss)["--sap-fill-halo-peak"];
  const expectedOnSapFill = parseTokens(tokensCss)["--on-sap-fill"];
  try {
    const svgRoot = container.querySelector("svg.hero") as Element;
    assert.equal(svgRoot.getAttribute("data-motion"), "reduced", "the fixture must actually render the reduced-motion path");

    const activeGroup = container.querySelector('[data-active="true"]') as Element;
    assert.ok(activeGroup, "the active planning node's group must render");
    const disc = activeGroup.querySelector(".hero-planning-node") as Element;
    const discComputed = getComputedStyle(disc);
    // happy-dom never resolves the `animation` shorthand's own longhands (echoes "" for
    // `animationName` even under a matching `!important: none` rule — the sibling active-node
    // test's own note); the VALUE that actually matters under reduced motion — the winning
    // fill-opacity is the peak, not the animation's own floor — is what happy-dom DOES resolve
    // correctly, and is the real proof this half of the AC needs.
    assert.equal(
      discComputed.fillOpacity,
      expectedPeak,
      `the disc's fill-opacity must resolve to the theme's own peak (${expectedPeak}), never the animation's floor`,
    );

    const halo = activeGroup.querySelector(".hero-node-halo") as Element;
    assert.ok(halo, "the halo must still render (present, not removed) under reduced motion");
    const haloComputed = getComputedStyle(halo);
    assert.equal(haloComputed.fillOpacity, "0.24", "the halo resolves to the AC's own fixed ~0.24 under reduced motion");

    // The lucide glyph's own nested <svg> — its `stroke="currentColor"` attribute must resolve
    // through the SAME `color` inheritance the wrapper's own computed `color` proves, not just
    // assert the wrapper's property and assume the descendant picks it up.
    const iconSvg = activeGroup.querySelector(".hero-planning-icon svg") as Element;
    assert.ok(iconSvg, "the lucide icon's own nested <svg> must render inside the active node");
    const iconSvgComputed = getComputedStyle(iconSvg);
    assert.equal(
      iconSvgComputed.color,
      expectedOnSapFill,
      "the lucide glyph's OWN <svg> element resolves --on-sap-fill via inherited color, not just its wrapper",
    );
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #920 AC5: two dashed zone dividers, a return-path arrowhead marker, and the hero root inside a
// `.panel` (the last part is a WIRING claim — see the Hero/App-level test in App.test.tsx; this
// half checks what HeroStage itself draws).
//
// #920 gate② finding [2] (ac5-divider-test-is-self-referential): comparing the rendered dividers
// only against `ZONE_DIVIDERS` — the SAME constant used to draw them — proves nothing about
// where they actually sit relative to the zones they're supposed to separate; moving
// `ZONE_DIVIDERS` outside the PLAN/IMPLEMENT/OUTCOME boundaries entirely would still pass. This
// asserts the real boundary inequalities against `PHASE_X` instead.
test("#920 AC5: two dashed PLAN|IMPLEMENT / IMPLEMENT|OUTCOME dividers sit between their own zone captions, and the return path ends in an arrowhead marker under the planning trio's x", () => {
  const html = markup(initialHeroState(3));

  const dividers = [...html.matchAll(/<line class="hero-divider" x1="(-?[\d.]+)" y1="[\d.]+" x2="(-?[\d.]+)" y2="[\d.]+"/g)].map(
    ([, x1, x2]) => {
      assert.equal(x1, x2, "a zone divider must be a vertical line");
      return Number(x1);
    },
  );
  assert.equal(dividers.length, 2, "exactly two zone dividers must render");
  const [plan, implement] = dividers as [number, number];
  assert.ok(
    PHASE_X.plan < plan && plan < PHASE_X.implement,
    `the PLAN|IMPLEMENT divider (${plan}) must sit strictly between PHASE_X.plan (${PHASE_X.plan}) and PHASE_X.implement (${PHASE_X.implement})`,
  );
  assert.ok(
    PHASE_X.implement < implement && implement < PHASE_X.outcome,
    `the IMPLEMENT|OUTCOME divider (${implement}) must sit strictly between PHASE_X.implement (${PHASE_X.implement}) and PHASE_X.outcome (${PHASE_X.outcome})`,
  );

  assert.match(html, /<marker id="hero-return-arrow"/, "the return path's arrowhead must be a real SVG marker");
  const returnMatch = html.match(/<path class="hero-return" marker-end="url\(#hero-return-arrow\)" d="([^"]*)"/);
  assert.ok(returnMatch, "the return path must carry marker-end pointing at the arrowhead def");
  const nums = (returnMatch![1] as string).match(/-?[\d.]+/g)!.map(Number);
  const endX = nums[nums.length - 2] as number;
  assert.equal(endX, PLANNING.x, "the return path's own end point must land on the planning trio's shared x");
});

// #920 gate② finding [2] (ac5-divider-test-is-self-referential, second half): "dashed" is a
// rendered CSS fact (`stroke-dasharray`), not provable from markup/constant comparisons alone —
// removing `.hero-divider`'s `stroke-dasharray` would leave the test above green. STYLE doctrine:
// a real `getComputedStyle` read against the full production cascade.
//
// #920 gate② review thread (PRRT…gG/…GgE): round 1's 0.34-opacity `--bark-text` fix still
// measured ~15% of the mockup's own contrast — the mockup's dividers are the SAME primary ink as
// the labels (`--sapwood`), just dashed. Extended to assert the resolved colour/opacity too, not
// only the dash pattern.
//
// #920 gate② finding [1] (ac7-style-coverage-incomplete): the dash check used to read its own
// EXPECTED value out of `heroCss` via the SAME regex it then compared against — a rule changed to
// the WRONG dash pattern (e.g. `2 4` instead of the mockup's own `3 5`) would still pass, since
// the oracle just echoes whatever hero.css happens to say. `3 5` is now a pinned literal (the
// mockup's own dash cadence, not a value this file owns) — VALUE doctrine's own "a literal that
// IS the specification" exception. Also looped over both explicit themes, same as the sibling
// ink-colour test above.
test("#920 gate② finding [2] + review thread (PRRT…gG/…GgE) + finding [1]: a real .hero-divider renders the mockup's own 3 5 dash, at the SAME primary ink as .hero-node-label, full opacity, in BOTH themes", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = markup(initialHeroState(3));
  document.body.appendChild(container);
  try {
    for (const themeAttr of ["heartwood", "sapwood"]) {
      document.documentElement.setAttribute("data-theme", themeAttr);

      const divider = container.querySelector(".hero-divider");
      assert.ok(divider, `${themeAttr}: a real .hero-divider element must render and match the injected stylesheet's selector`);
      const computed = getComputedStyle(divider as Element);
      // Pinned literal (the mockup's own dash cadence), not read back from hero.css's own rule.
      assert.equal(computed.strokeDasharray, "3 5", `${themeAttr}: the divider must render the mockup's own 3 5 dash pattern exactly`);

      const inkEl = container.querySelector(".hero-node-label");
      assert.ok(inkEl, `${themeAttr}: a real .hero-node-label element must render`);
      const inkColor = getComputedStyle(inkEl as Element).fill;
      assert.equal(
        computed.stroke,
        inkColor,
        `${themeAttr}: the divider's stroke must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(
        computed.strokeOpacity,
        "1",
        `${themeAttr}: the divider must render at full opacity — the dash pattern alone carries the 'quiet' read`,
      );

      const rule = container.querySelector(".hero-outcome-rule");
      assert.ok(rule, `${themeAttr}: a real .hero-outcome-rule element must render`);
      const ruleComputed = getComputedStyle(rule as Element);
      assert.equal(
        ruleComputed.stroke,
        inkColor,
        `${themeAttr}: the outcome hairline rule must resolve to the SAME colour as .hero-node-label's primary ink`,
      );
      assert.equal(ruleComputed.strokeOpacity, "1", `${themeAttr}: the outcome hairline rule must render at full opacity`);
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #920 gate② review thread (PRRT…JE9): `PLANNING_NODE_R` growing to 30 pushed the planning trio's
// own label offset (`PLANNING.x + PLANNING_NODE_R + 14`) far enough right that the widest label
// ("Goal & align") ran straight into the w1 lane label at the OLD `LANES.x` — a live crop read
// "Goal &amp;aligw1". `LANES.x`/`ZONE_DIVIDERS[0]` moved to clear it (their own doc in stage.tsx);
// this is the regression guard, derived from the RENDERED label boxes at every `lanesMax` 1..4 —
// never a hand-typed pair (COVERAGE doctrine).
test("#920 gate② review thread (PRRT…JE9): the planning trio's own labels never collide with the lane labels, at lanesMax 1..4", () => {
  for (const lanesMax of [1, 2, 3, 4]) {
    const html = markup(initialHeroState(lanesMax), { lanesMax });
    const planningGroupMatch = html.match(/<g class="hero-planning" data-node="planning">([\s\S]*?)<g class="hero-lanes">/);
    assert.ok(planningGroupMatch, `lanesMax=${lanesMax}: the planning group must render`);
    // #922 AC1: planning labels moved centred-below their circle (text-anchor="middle"), no
    // longer right-anchored beside it — the geometry this test's own name once guarded against
    // (a label running into the lane column) no longer applies the same way, but the coverage
    // discipline (derive the set from rendered markup) stays.
    const planningLabels = [
      ...(planningGroupMatch![1] as string).matchAll(
        /<text class="hero-node-label" x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="middle">([^<]*)</g,
      ),
    ].map(([, x, y, text]) => ({
      label: `planning label "${text}"`,
      box: captionSafeTextBox((text as string).replace(/&amp;/g, "&"), Number(x), Number(y), GATE_NODE_LABEL_FONT_PX, "middle"),
    }));
    assert.equal(planningLabels.length, 3, `lanesMax=${lanesMax}: all three planning labels must render`);

    const laneLabels = laneBlocks(html).map(({ channel, block }) => {
      const m = block.match(/<text class="hero-node-label" x="(-?[\d.]+)" y="(-?[\d.]+)">([^<]*)</);
      assert.ok(m, `lane ${channel}: its own label must render`);
      const [, x, y, text] = m as unknown as [string, string, string, string];
      return {
        label: `lane ${channel} label "${text}"`,
        box: captionSafeTextBox(text, Number(x), Number(y), GATE_NODE_LABEL_FONT_PX, "start"),
      };
    });

    assertNoOverlap([...planningLabels, ...laneLabels]);
  }
});

test("#728 gate② [0]: backlog chip/droplet text boxes never overlap, by actual rendered extent — not just anchor spacing", () => {
  const { state } = run([
    ev("pool-selected", { round_id: 1, issues: [10, 11] }),
    ev("dispatched", { worker: "w1", issue: 20 }),
    ev("handoff", { worker: "w1", issue: 20 }),
    ev("dispatched", { worker: "w2", issue: 21 }),
    ev("handoff", { worker: "w2", issue: 21 }),
  ]);
  assert.deepEqual(state.pool, [10, 11]);

  const d20 = droplet(state, 20);
  const d21 = droplet(state, 21);
  assert.ok(d20 && d21);
  const p20 = dropletPoint(state, d20);
  const p21 = dropletPoint(state, d21);
  const centerX = BACKLOG.x + BACKLOG.w / 2;

  // Mirrors stage.tsx's own draw formulas exactly (pool chip text y, droplet label -14 / badge
  // +24 offsets) — the point is to box what actually gets drawn, not a paraphrase of it.
  assertNoOverlap([
    { label: "pool chip 10", box: textBox("⊙ 10", centerX, BACKLOG.y + 22 + 0 * BACKLOG.chip, 11) },
    { label: "pool chip 11", box: textBox("⊙ 11", centerX, BACKLOG.y + 22 + 1 * BACKLOG.chip, 11) },
    { label: "droplet 20 label", box: textBox("⊙ 20", centerX, p20.y - 14, 10) },
    { label: "droplet 20 badge", box: textBox("saved for a successor", centerX, p20.y + 24, 10) },
    { label: "droplet 21 label", box: textBox("⊙ 21", centerX, p21.y - 14, 10) },
    { label: "droplet 21 badge", box: textBox("saved for a successor", centerX, p21.y + 24, 10) },
  ]);

  const html = markup(state);
  assert.equal(html.match(/saved for a successor/g)?.length, 2);
});

test("#728 gate② [0]: the needs-human cluster's real circle/label extents never collide with each other, the trunk rings, or the outcome tally's actual rendered text", () => {
  const events: DomainEvent[] = [];
  // A deliberately inflated, multi-digit round (double-digit merged/pending, several distinct
  // fix rounds) — the finding's own scenario ("a longer multi-digit tally... would leave every
  // assertion green") — to stress the tally's real rendered width, not just today's small one.
  for (let i = 1; i <= 24; i++) events.push(ev("merged", { worker: `m${i}`, issue: i, pr: i }));
  for (let i = 1; i <= 13; i++) events.push(ev("dispatched", { worker: `p${i}`, issue: 100 + i }));
  // 6, not an arbitrarily larger number: `stage.tsx`'s own NEEDS_HUMAN_COLS/ROW_STEP doc
  // records this as the verified-safe ceiling (3 rows) before a 4th row would reach the
  // CI/REVIEW gates above — this is the stress case that ceiling promises, not a random pick.
  for (let i = 1; i <= 6; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: 200 + i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: 200 + i, next: "DRIVING", pr: 9000 + i }));
    events.push(ev("drive-needs-human", { worker: `w${i}`, issue: 200 + i, pr: 9000 + i }));
  }
  const { state } = run(events, 43);
  const escalated = state.droplets.filter((d) => d.at === "needs-human");
  assert.equal(escalated.length, 6);
  assert.equal(state.roundMerged, 24);

  // #745 gate② round 5: this test's own point is the tally TEXT's real rendered extent, not the
  // confident/qualified split — the 13 dispatched-but-not-yet-checkpointed issues are the
  // realistic "engine still actively tracking them" shape (`isPendingConfident`'s live-lane-list
  // voucher), matching what `/api/loop/state`'s `lanes.items[]` would actually carry for a real
  // in-flight lane, so the tally stays the unqualified double-digit stress case this test wants.
  const html = markup(state, { lanesMax: 43, liveLanes: Array.from({ length: 13 }, (_, i) => ({ issue: 100 + i + 1 })) });
  const tallyMatch = html.match(/class="hero-num hero-small hero-outcome-tally" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(tallyMatch, "outcome tally must render");
  const [, tallyXRaw, tallyYRaw, tallyText] = tallyMatch as unknown as [string, string, string, string];
  assert.match(tallyText, /24 merged · 13 pending · 6 needs human/);

  const boxes: { label: string; box: Box }[] = [
    // #920 gate② review thread (PRRT…JE5): the tally moved BELOW the Summary/Retro row entirely
    // (`OUTCOME_TALLY_Y`'s own doc) — centered again, since it no longer shares the stem's own
    // y-band at all.
    { label: "outcome tally", box: textBox(tallyText, Number(tallyXRaw), Number(tallyYRaw), 9) },
    // Only the OUTERMOST drawn ring — concentric rings sharing one center are, by design,
    // always nested/touching each other (that's the trunk cross-section, not a collision); the
    // outermost one is simply the single furthest-reaching edge the escalation cluster/tally
    // could actually run into, and the only ring box worth checking against them.
    // #921: the real growth-rule radius (`ringOuterRadius`), not a re-derived formula — VALUE
    // doctrine.
    { label: "outermost trunk ring", box: circleBox(TRUNK.x, TRUNK.y, ringOuterRadius(state.rings)) },
  ];
  for (const d of escalated) {
    const { x, y } = dropletPoint(state, d);
    // #922 AC2: the number renders INSIDE the shape, whose own belly radius is
    // sized to fit it (`dropletRadius`) — never a fixed r=9 with a label floating above at
    // y-14. The shape fits the bare NUMBER only, never the kind mark (production's own
    // `dropletNumber`/`dropletKind`).
    const number = dropletNumberText(d);
    const r = dropletRadius(number);
    // #922 AC2: the number renders INSIDE the shape (`r` is sized to fit it exactly), so the
    // shape's own circle box already subsumes the label — no separate label box is needed, and
    // pushing one would spuriously "collide" with its own circle.
    boxes.push({ label: `needs-human #${d.issue} circle`, box: circleBox(x, y, r) });
  }
  assertNoOverlap(boxes);

  assert.match(html, /data-node="needs-human" data-count="6"/);
});

/** A path `d`'s straight-line segments (this file only ever draws axis-aligned M/L moves for the
 *  reflection tree), each turned into a thin occupied box — the same "real rendered extent, not
 *  just an anchor point" discipline `textBox()`/`circleBox()` already apply to text/circles. */
function pathSegmentBoxes(d: string): Box[] {
  const strokeHalf = 2; // generous over the arm's actual ~1px-2px stroke-width
  const boxes: Box[] = [];
  for (const sub of d.split(/(?=M)/).filter(Boolean)) {
    const pts = [...sub.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, , x, y]) => ({ x: Number(x), y: Number(y) }));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      boxes.push({
        left: Math.min(a.x, b.x) - strokeHalf,
        right: Math.max(a.x, b.x) + strokeHalf,
        top: Math.min(a.y, b.y) - strokeHalf,
        bottom: Math.max(a.y, b.y) + strokeHalf,
      });
    }
  }
  return boxes;
}

// #920 AC4: the reflection tree is now a PLAIN T (no `detourX` jog) — the stem's x is pinned to
// the disc centre x, and the fix that keeps the straight stem clear of the ring-count/tally boxes
// is purely a Y-band one (`REFLECTION_BAR_Y`'s own doc in stage.tsx), not an X detour. Stressed
// at a 3-digit ring count / 6-digit PR, the same fixture #886's own ring-count-vs-droplet test
// already established as this stage's worst-case digit stretch.
test("#920 AC4: the reflection tree is a plain T — stem x equals the disc centre x, detourX is gone, and no reflection path intersects the outcome-tally or ring-count boxes", () => {
  assert.equal(REFLECTION.stemX, TRUNK.x, "the reflection stem's x must equal the disc centre x");
  assert.ok(!("detourX" in REFLECTION), "REFLECTION.detourX must no longer exist");

  const events: DomainEvent[] = [];
  for (let i = 1; i <= 999; i++) events.push(ev("merged", { worker: `m${i}`, issue: i, pr: 999999 }));
  const { state } = run(events, 3);
  assert.equal(state.rings, 999, "stress case: a 3-digit ring total");
  const html = markup(state);

  const countMatch = html.match(/class="hero-ring-count"[^>]*x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(countMatch, "hero-ring-count must render");
  const [, cxRaw, cyRaw, countText] = countMatch as unknown as [string, string, string, string];
  // #921: RING_COUNT_FONT_PX read from stage.tsx, never a hand-copied literal (VALUE doctrine).
  const countBox = textBox(countText, Number(cxRaw), Number(cyRaw), RING_COUNT_FONT_PX);

  const tallyMatch = html.match(/class="hero-num hero-small hero-outcome-tally" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(tallyMatch, "outcome tally must render");
  const [, tallyXRaw, tallyYRaw, tallyText] = tallyMatch as unknown as [string, string, string, string];
  // #920 gate② review thread (PRRT…JE5): centered again — the tally now sits BELOW the whole
  // Summary/Retro row, so it never shares the stem's y-band at all.
  const tallyBox = textBox(tallyText, Number(tallyXRaw), Number(tallyYRaw), 9);

  const reflectionGroupMatch = html.match(/<g class="hero-reflection" data-node="reflection">([\s\S]*?)<\/g>\s*<path class="hero-return"/);
  assert.ok(reflectionGroupMatch, "the hero-reflection group must render");
  const pathMatch = (reflectionGroupMatch![1] as string).match(/<path class="hero-arm" d="([^"]*)"/);
  assert.ok(pathMatch, "the reflection tree's connector <path> must render");
  const segments = pathSegmentBoxes(pathMatch![1] as string);
  assert.ok(segments.length >= 2, "the stem and the bar must each contribute a segment");

  for (const seg of segments) {
    assert.ok(
      !boxesOverlap(seg, countBox),
      `reflection path segment ${JSON.stringify(seg)} overlaps the ring-count box ${JSON.stringify(countBox)}`,
    );
    assert.ok(
      !boxesOverlap(seg, tallyBox),
      `reflection path segment ${JSON.stringify(seg)} overlaps the outcome-tally box ${JSON.stringify(tallyBox)}`,
    );
  }
});

// #920 gate② review thread (PRRT…gJ/…GgK), COLLISION class: a live crop showed the "Summary"/
// "Retro" labels sitting ON the circles' own bottom arc (text-on-stroke) — extends the AC4
// collision set with the caption boxes × the circle boxes those findings named, derived from
// rendered coordinates rather than a hand-typed pair (COVERAGE doctrine).
test("#920 gate② review thread (PRRT…gJ/…GgK): the Summary/Retro labels never collide with their own circles, and the crossbar stops at the circles' edges (not centre-to-centre)", () => {
  const html = markup(initialHeroState(3));
  const reflectionGroupMatch = html.match(/<g class="hero-reflection" data-node="reflection">([\s\S]*?)<\/g>\s*<path class="hero-return"/);
  assert.ok(reflectionGroupMatch, "the hero-reflection group must render");
  const group = reflectionGroupMatch![1] as string;

  const circles = [...group.matchAll(/<circle class="hero-planning-node" cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="(-?[\d.]+)">/g)].map(
    ([, cx, cy, r]) => ({ x: Number(cx), y: Number(cy), r: Number(r) }),
  );
  assert.equal(circles.length, 2, "both Summary and Retro circles must render");

  const labels = [...group.matchAll(/<text class="hero-node-label" x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="middle">([^<]*)</g)].map(
    ([, x, y, text]) => ({ x: Number(x), y: Number(y), text: text as string }),
  );
  assert.equal(labels.length, 2, "both Summary and Retro labels must render");

  const boxes: { label: string; box: Box }[] = [];
  for (const c of circles) boxes.push({ label: `circle at (${c.x},${c.y})`, box: circleBox(c.x, c.y, c.r) });
  for (const l of labels)
    boxes.push({ label: `label "${l.text}"`, box: captionSafeTextBox(l.text, l.x, l.y, GATE_NODE_LABEL_FONT_PX, "middle") });
  assertNoOverlap(boxes);

  // The crossbar must stop at each circle's own EDGE, not run centre-to-centre through them.
  const pathMatch = group.match(/<path class="hero-arm" d="([^"]*)"/);
  assert.ok(pathMatch, "the reflection tree's connector <path> must render");
  // Excludes the stem's own end point (also at y === barY, x === stemX) — the bar's own two
  // points are the only ones off that shared x.
  const barPoints = [...(pathMatch![1] as string).matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)]
    .map(([, , x, y]) => ({ x: Number(x), y: Number(y) }))
    .filter((p) => p.y === REFLECTION.barY && p.x !== REFLECTION.stemX);
  const barXs = barPoints.map((p) => p.x).sort((a, b) => a - b);
  assert.equal(barXs.length, 2, "the bar must carry exactly two points at barY, excluding the stem's own end point");
  const sortedCircles = [...circles].sort((a, b) => a.x - b.x);
  const [leftCircle, rightCircle] = sortedCircles as unknown as [(typeof circles)[number], (typeof circles)[number]];
  assert.equal(barXs[0], leftCircle.x + leftCircle.r, "the bar's left end must sit exactly on the left circle's own edge, not its centre");
  assert.equal(
    barXs[1],
    rightCircle.x - rightCircle.r,
    "the bar's right end must sit exactly on the right circle's own edge, not its centre",
  );
});

// #920 gate② finding [3] (reflection-loop-is-disconnected) + finding [0]
// (reflection-stem-max-envelope-gap): the tree must be GENUINELY attached at the disc's own
// ACTUAL rendered bottom edge — `ringOuterRadius(state.rings)`, never the max envelope, which
// left an 82-unit undrawn gap at the shipped demo's own 1-ring count (finding [0]'s own report)
// — and the dashed return path picks up directly below the tally (the tree's own true bottom now
// that the tally/rule moved there), never a floating coordinate between the Summary/Retro
// circles (the review thread's own complaint about the earlier layout).
test("#920: the reflection tree's stem is genuinely attached to the disc's OWN rendered bottom edge (not the max envelope); the return path starts below the tally, on the same column", () => {
  // The fixture's own default (`initialHeroState`) is a 0-ring, low-count state — exactly the
  // regime finding [0] reports as broken (the shipped demo itself sits at 1 ring). `ringOuterRadius`
  // is read from stage.tsx, never re-derived, so this can't silently drift from the real formula.
  const state = initialHeroState(3);
  assert.equal(
    state.rings,
    0,
    "fixture sanity: this must be the LOW-count regime finding [0] reports, not the saturated 999-ring stress case",
  );
  const html = markup(state);
  const expectedStemTop = TRUNK.y + ringOuterRadius(state.rings);
  assert.ok(
    expectedStemTop < TRUNK.y + TRUNK.max * TRUNK.step,
    "sanity: at this low a ring count, the real outer radius must be well short of the max envelope",
  );

  const reflectionGroupMatch = html.match(/<g class="hero-reflection" data-node="reflection">([\s\S]*?)<\/g>\s*<path class="hero-return"/);
  assert.ok(reflectionGroupMatch, "the hero-reflection group must render");
  const pathMatch = (reflectionGroupMatch![1] as string).match(/<path class="hero-arm" d="([^"]*)"/);
  assert.ok(pathMatch, "the reflection tree's connector <path> must render");
  const d = pathMatch![1] as string;

  const points = [...d.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, , x, y]) => ({ x: Number(x), y: Number(y) }));
  assert.ok(points.length >= 2, "the connector path must carry real coordinate points");
  const topmostY = Math.min(...points.map((p) => p.y));
  assert.equal(
    topmostY,
    expectedStemTop,
    "the connector's topmost point must sit at the disc's own ACTUAL rendered bottom edge, not the max envelope",
  );
  assert.ok(
    points.some((p) => p.y === topmostY && p.x === TRUNK.x),
    `the connector must carry a point at (TRUNK.x, the real outer radius) = (${TRUNK.x}, ${topmostY})`,
  );
  // The crossbar's own two ends are the Summary/Retro circle centres — `barY` === `REFLECTION.y`.
  assert.equal(REFLECTION.barY, REFLECTION.y, "the crossbar must sit AT the circles' own centre y, not hung below them by a drop segment");
  const bottommostY = Math.max(...points.map((p) => p.y));
  assert.equal(bottommostY, REFLECTION.barY, "the arm's own bottommost point is the bar, where the Summary/Retro circles sit");

  // The return path starts strictly below `REFLECTION.bottom` computed from the tally's own
  // position — same column, positioned as the visual continuation of the tree, not floating
  // between the two circles (`REFLECTION.bottom` sits well past both `REFLECTION.y + r` circle
  // bottoms and the tally's own row).
  const returnMatch = html.match(/<path class="hero-return" marker-end="url\(#hero-return-arrow\)" d="M (-?[\d.]+) (-?[\d.]+)/);
  assert.ok(returnMatch, "the return path must render");
  const [, returnStartX, returnStartY] = returnMatch as unknown as [string, string, string];
  assert.equal(Number(returnStartX), TRUNK.x, "the return path must start on the disc centre x, the SAME column the stem/tally occupy");
  assert.equal(Number(returnStartY), REFLECTION.bottom, "the return path must start at REFLECTION.bottom, directly below the tally");
  assert.ok(
    REFLECTION.bottom > REFLECTION.y + REFLECTION.r,
    "REFLECTION.bottom must sit below the Summary/Retro circles' own bottom edge, not between them",
  );
});

// #920 gate② finding [0]'s own named regression: "the shipped demo has one ring, so its circle
// ends at y=192... Derive the stem start from the rendered outer radius." This is that exact
// low-count/demo case, checked against the ACTUAL rendered `<circle class="hero-ring">` radius —
// never `ringOuterRadius` compared only to itself.
test("#920 gate② finding [0]: at the demo's own 1-ring count, the stem attaches exactly to the RENDERED outer ring circle's radius", () => {
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 1 })], 3);
  assert.equal(state.rings, 1, "fixture sanity: this is the shipped demo's own reported ring count");
  const html = markup(state);

  const ringMatch = html.match(/<circle class="hero-ring" cx="[\d.]+" cy="[\d.]+" r="(-?[\d.]+)" data-current="true"/);
  assert.ok(ringMatch, "the outermost (current) ring circle must render");
  const renderedOuterRadius = Number(ringMatch![1]);
  assert.equal(
    renderedOuterRadius,
    ringOuterRadius(1),
    "ringOuterRadius must match the ACTUAL rendered outer ring's own radius, not a copied value",
  );
  assert.ok(renderedOuterRadius < TRUNK.max * TRUNK.step, "sanity: at 1 ring, the real radius is nowhere near the max envelope");

  const reflectionGroupMatch = html.match(/<g class="hero-reflection" data-node="reflection">([\s\S]*?)<\/g>\s*<path class="hero-return"/);
  assert.ok(reflectionGroupMatch, "the hero-reflection group must render");
  const pathMatch = (reflectionGroupMatch![1] as string).match(/<path class="hero-arm" d="([^"]*)"/);
  assert.ok(pathMatch, "the reflection tree's connector <path> must render");
  const points = [...(pathMatch![1] as string).matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, , x, y]) => ({
    x: Number(x),
    y: Number(y),
  }));
  const topmostY = Math.min(...points.map((p) => p.y));
  assert.equal(
    topmostY,
    TRUNK.y + renderedOuterRadius,
    "the stem's own topmost point must sit exactly at the rendered ring's own edge — no gap",
  );
});

// #886 gate② run 2e566ac9 finding [1]: the earlier fix kept the droplet dead-center and moved
// the NUMBER away to dodge it (first landing on top of it, then reading as "well outside" a low
// ring count). This round moves the DROPLET instead (`TRUNK_DROPLET_OFFSET`, stage.tsx) so the
// number can stay genuinely centered. Stressed at a 3-digit ring total and a 5-digit PR number —
// #922 AC2's own "PR 12345" — the widest number this file's own `DROPLET_MAX_R` still fits
// without clipping the number's text box.
// `TRUNK_DROPLET_OFFSET`'s own doc argues the vertical component alone already clears the label
// regardless of either string's width; this proves that against the ACTUAL rendered boxes rather
// than trusting the doc's arithmetic, the same discipline #728's NEEDS_HUMAN_COL_STEP/ROW_STEP
// doc cites for its own cluster.
test("#886 gate② run 2e566ac9 finding [1]: the centered ring count never collides with the newest-merge droplet, now offset away from the trunk center — stressed at multi-digit ring/PR counts", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 999; i++) events.push(ev("merged", { worker: `m${i}`, issue: i, pr: 12345 }));
  const { state } = run(events, 3);
  assert.equal(state.rings, 999, "stress case: a 3-digit ring total, the widest realistic .hero-ring-count string");
  const html = markup(state);

  const countMatch = html.match(/class="hero-ring-count"[^>]*x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(countMatch, "hero-ring-count must render");
  const [, cxRaw, cyRaw, countText] = countMatch as unknown as [string, string, string, string];
  assert.equal(countText, "999");
  // #921: RING_COUNT_FONT_PX read from stage.tsx, never a hand-copied literal (VALUE doctrine).
  const countBox = textBox(countText, Number(cxRaw), Number(cyRaw), RING_COUNT_FONT_PX);

  const trunkDroplet = state.droplets.find((d) => d.at === "trunk");
  assert.ok(trunkDroplet, "the newest merge must still park a droplet at the trunk");
  const { x: dropX, y: dropY } = dropletPoint(state, trunkDroplet as Droplet);
  assert.notEqual(dropX, TRUNK.x, "the droplet — not the number — carries the offset now");
  assert.notEqual(dropY, TRUNK.y);

  const dropletRe = new RegExp(`<g class="hero-droplet"[^>]*transform="translate\\(${dropX} ${dropY}\\)">([\\s\\S]*?)</g>`);
  const dropletInner = html.match(dropletRe)?.[1];
  assert.ok(dropletInner, "the trunk droplet must render at its own offset transform");
  // #922 AC2: the number now renders INSIDE the shape (`.hero-droplet-num`), at a y
  // derived from the shape's own (number-sized) belly radius — never a fixed y="-14" above it. The
  // kind mark ("✓", trunk's own mark) is a separate, smaller sibling element and
  // never counts toward the shape's fit.
  const kindMatch = dropletInner?.match(/<text class="hero-droplet-kind"[^>]*>([^<]*)<\/text>/);
  assert.equal(kindMatch?.[1], "✓", "the trunk droplet's own kind mark must still read '✓'");
  const labelMatch = dropletInner?.match(
    /<text class="hero-num hero-droplet-num" x="0" y="(-?[\d.]+)" text-anchor="middle" style="font-size:([\d.]+)px">([^<]*)<\/text>/,
  );
  assert.ok(labelMatch, "the newest-merge droplet must still carry its own PR number");
  const [, labelYRaw, fontPxRaw, labelText] = labelMatch as unknown as [string, string, string, string];
  assert.equal(labelText, String(trunkDroplet?.pr));
  const r = dropletRadius(labelText);
  assert.equal(Number(fontPxRaw), DROPLET_NUM_FONT_PX, "the number's font-size never shrinks — the 11px floor is inviolable");
  const labelBox = textBox(labelText, dropX, dropY + Number(labelYRaw), Number(fontPxRaw));
  const shapeBox = circleBox(dropX, dropY, r);

  assert.ok(
    !boxesOverlap(countBox, labelBox),
    `ring count ${JSON.stringify(countBox)} overlaps the trunk droplet's label ${JSON.stringify(labelBox)}`,
  );
  assert.ok(
    !boxesOverlap(countBox, shapeBox),
    `ring count ${JSON.stringify(countBox)} overlaps the trunk droplet's shape ${JSON.stringify(shapeBox)}`,
  );
});

// ── #921: sapling at zero merges, one ring per merge, disc growth rule ──
//
// Owner ruling Q1 (2026-08-17): strictly one ring per merge — no decorative base grain; the
// zero-merge state starts from a small sapling glyph; the count renders at mockup scale once
// ≥ 1 ring exists.

/** Extracts the `.hero-trunk` group's own inner markup, tolerant of the nested `.hero-sapling`
 *  group's own `</g>` — stops only at the `</g>` immediately followed by the KNOWN next sibling
 *  (`.hero-reflection`), the same non-greedy-anchored-on-the-next-sibling trick this file's other
 *  nested-group extractions already use (e.g. the `.hero-reflection` capture below, anchored on
 *  `<path class="hero-return"`). */
const trunkGroupInner = (html: string): string | undefined =>
  html.match(/<g class="hero-trunk"[^>]*>([\s\S]*?)<\/g>\s*<g class="hero-reflection"/)?.[1];

test('#921 AC1: rings=0 renders the sapling glyph — data-rings="0", a .hero-sapling group wrapping lucide-react\'s Sprout (lucide-sprout class), coloured via --moss, no hand-drawn <path> — and no .hero-ring-count numeral', () => {
  const state = initialHeroState(3);
  assert.equal(state.rings, 0);
  const html = markup(state);

  assert.match(html, /<g class="hero-trunk" data-rings="0">/);
  const trunk = trunkGroupInner(html);
  assert.ok(trunk, "the .hero-trunk group must render");

  assert.match(trunk as string, /<g class="hero-sapling" style="color:var\(--moss\)">/);
  // lucide-react's own `createLucideIcon` class convention (`Icon.mjs`) — the package's real
  // rendered class, not a hand-typed guess at what it might be.
  assert.match(trunk as string, /class="lucide lucide-sprout"/);
  // No hand-drawn sapling glyph — every `<path>` inside the sapling group belongs to the
  // imported `Sprout` icon (three path segments, lucide-react's own `sprout.mjs`), not a
  // bespoke shape this file drew itself the way `DROPLET_SHAPE`/`planningIcon`/`gateIcon` do.
  assert.equal((trunk as string).match(/<path/g)?.length, 3, "exactly Sprout's own three path segments, nothing hand-drawn");

  assert.doesNotMatch(trunk as string, /class="hero-ring-count"/);
  assert.doesNotMatch(trunk as string, /class="hero-ring"/);
  assert.doesNotMatch(trunk as string, /class="hero-label"/, "no 'ring'/'rings' unit word floats over an empty disc");
});

test('#921 AC1: rings=1 renders exactly one .hero-ring and the numeral "1", no sapling', () => {
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 1 })]);
  assert.equal(state.rings, 1);
  const html = markup(state);
  const trunk = trunkGroupInner(html);
  assert.ok(trunk, "the .hero-trunk group must render");

  assert.equal((trunk as string).match(/class="hero-ring"/g)?.length, 1);
  assert.match(trunk as string, /class="hero-ring-count"[^>]*>1</);
  assert.doesNotMatch(trunk as string, /hero-sapling/);
});

test("#921 AC1: rings=N renders exactly min(N, TRUNK.max) rings — one per real merge, no base grain, at N under and over the draw cap", () => {
  for (const n of [2, 12, 24, TRUNK.max, TRUNK.max + 7]) {
    const events: DomainEvent[] = [];
    for (let i = 1; i <= n; i++) events.push(ev("merged", { worker: `m${i}`, issue: i, pr: i }));
    const { state } = run(events, 3);
    assert.equal(state.rings, n);
    const html = markup(state);
    const trunk = trunkGroupInner(html);
    assert.ok(trunk, `n=${n}: the .hero-trunk group must render`);
    assert.equal(
      (trunk as string).match(/class="hero-ring"/g)?.length,
      Math.min(n, TRUNK.max),
      `n=${n}: exactly min(n, TRUNK.max) rings, never more (no decorative base grain) and never fewer`,
    );
    assert.match(trunk as string, new RegExp(`class="hero-ring-count"[^>]*>${n}<`));
  }
});

test("#921 AC2 (STYLE, full production cascade): .hero-ring-count resolves Fraunces and a rendered size >= 56px at a 1440px-wide hero", () => {
  assert.ok(bodyFontSizeRule);
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontSizeRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  const { state } = run([ev("merged", { worker: "w1", issue: 1, pr: 1 })]);
  container.innerHTML = markup(state);
  document.body.appendChild(container);
  try {
    const countEl = container.querySelector(".hero-ring-count");
    assert.ok(countEl, "a real .hero-ring-count element must render and match the injected stylesheet's cascade");
    const computed = getComputedStyle(countEl as Element);
    assert.match(computed.fontFamily, /Fraunces/, "font-family must resolve through --font-display to Fraunces");
    assert.equal(computed.fontSize, `${RING_COUNT_FONT_PX}px`, "the exact winning cascaded (inline) font-size, not a stand-in");

    // STYLE proves the authored/cascaded value; the 1440px-wide-hero claim is that authored
    // SVG-unit value scaled by the SAME uniform ratio the #728 scale-invariance test established
    // (`.hero`'s `width: 100%` over the fixed `STAGE` viewBox scales every element together at
    // any rendered width) — not a browser layout measurement happy-dom's CSSOM-only
    // `getComputedStyle` can't produce (#895's own test already established that gap for `.hero`
    // itself: a percentage width never resolves to a real px layout value here).
    const renderedAt1440 = Number.parseFloat(computed.fontSize) * (1440 / STAGE.w);
    assert.ok(renderedAt1440 >= 56, `rendered size at 1440px must be >= 56px; got ${renderedAt1440}`);
    // Exact expected value, not merely a floor check — ties this number to RING_COUNT_FONT_PX
    // (48) rather than an independent magic constant that could silently drift from it.
    assert.ok(Math.abs(renderedAt1440 - RING_COUNT_FONT_PX * (1440 / STAGE.w)) < 0.001);
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});

// #921 gate② PO review thread: a live crop at rings = 1 caught the "ring" unit-word caption
// drawn ON the ring's own lower-left stroke — text on stroke, in both themes. The caption's own Y
// is now dynamic (`ringWordY`, stage.tsx), tracking the disc's real rendered edge — this is the
// COLLISION regression guard: caption box × outermost ring circle box, at rings 1..3 (the low
// counts where the disc is smallest relative to the caption's own fixed font size, so the
// tightest margin).
test("#921 gate② PO review thread: the 'ring'/'rings' unit-word caption never collides with the outermost ring's own circle, at rings 1..3", () => {
  for (const n of [1, 2, 3]) {
    const { state } = run(
      Array.from({ length: n }, (_, i) => ev("merged", { worker: `m${i + 1}`, issue: i + 1, pr: i + 1 })),
      3,
    );
    assert.equal(state.rings, n);
    const html = markup(state);

    const wordMatch = html.match(/class="hero-label" x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="end">([^<]*)</);
    assert.ok(wordMatch, `n=${n}: the ring/rings unit-word caption must render`);
    const [, wordXRaw, wordYRaw, wordText] = wordMatch as unknown as [string, string, string, string];
    const wordBox = captionSafeTextBox(wordText, Number(wordXRaw), Number(wordYRaw), RING_WORD_FONT_PX, "end");

    const outer = ringOuterRadius(n);
    const ringBox = circleBox(TRUNK.x, TRUNK.y, outer);

    assert.ok(
      !boxesOverlap(wordBox, ringBox),
      `n=${n}: the unit-word caption ${JSON.stringify(wordBox)} overlaps the outermost ring's own circle ${JSON.stringify(ringBox)}`,
    );
  }
});

test("#921 AC3: the growth rule at N = 1, 12, 24, 42 — constant pitch under the footprint ceiling, saturating exactly at TRUNK_DISC_R_MAX, never exceeding 40% of STAGE.h, the numeral's box fits inside the inner clearance", () => {
  let previousOuter = 0;
  for (const n of [1, 12, 24, 42]) {
    const { state } = run(
      Array.from({ length: n }, (_, i) => ev("merged", { worker: `m${i + 1}`, issue: i + 1, pr: i + 1 })),
      3,
    );
    assert.equal(state.rings, n);
    const outer = ringOuterRadius(n);
    const r0 = ringInnerRadius(n);

    // Monotonic, non-decreasing growth — the disc never shrinks as merges accrue; once
    // saturated (N >= 24, per the compression rule below) it holds flat at TRUNK_DISC_R_MAX
    // rather than continuing to grow, so this is `>=`, not strict `>`.
    assert.ok(outer >= previousOuter, `n=${n}: outer radius (${outer}) must not shrink below the previous count's (${previousOuter})`);
    previousOuter = outer;

    // The disc's footprint never exceeds ~40% of the hero band height (the issue's own ceiling).
    assert.ok(2 * outer <= 0.4 * STAGE.h + 0.001, `n=${n}: disc diameter (${2 * outer}) must not exceed 40% of STAGE.h (${0.4 * STAGE.h})`);

    // The numeral's own rendered box — real font-size + real digit count, VALUE doctrine — must
    // fit entirely inside the inner clearance radius: every corner of its box sits within r0 of
    // the disc centre.
    const countBox = textBox(String(n), TRUNK.x, TRUNK.y + 11, RING_COUNT_FONT_PX);
    const corners = [
      [countBox.left, countBox.top],
      [countBox.right, countBox.top],
      [countBox.left, countBox.bottom],
      [countBox.right, countBox.bottom],
    ];
    for (const [cx, cy] of corners) {
      const dist = Math.hypot((cx as number) - TRUNK.x, (cy as number) - TRUNK.y);
      assert.ok(dist <= r0 + 0.01, `n=${n}: numeral corner (${cx}, ${cy}) at distance ${dist} must fit inside r0 (${r0})`);
    }

    // #921 gate② round 4 finding [1] (ac3-growth-oracle): exact VALUE-derived radii, not just
    // "monotonic and below the ceiling" (a badly wrong growth formula could still pass those).
    // Read every input from its own source — TRUNK.step, TRUNK_DISC_R_MAX, r0 — never a
    // hand-copied number, so this test can't silently drift from the production formula it's
    // meant to police.
    const actualRadii = ringRadii(n);
    if (n === 1 || n === 12) {
      // Nominal branch: pitch is the constant TRUNK.step (the compression threshold isn't
      // reached yet at these counts, per the AC3's own math — verified by the loose "outer <
      // TRUNK_DISC_R_MAX" branch below too).
      const expectedRadii = Array.from({ length: n }, (_, i) => r0 + (i + 1) * TRUNK.step);
      assert.deepEqual(
        actualRadii.map((r) => Number(r.toFixed(6))),
        expectedRadii.map((r) => Number(r.toFixed(6))),
        `n=${n}: every ring radius must equal r0 + i*TRUNK.step exactly (nominal branch)`,
      );
      assert.ok(
        Math.abs(outer - (r0 + n * TRUNK.step)) < 0.001,
        `n=${n}: outer radius must equal r0 + N*TRUNK.step exactly (${r0 + n * TRUNK.step}), got ${outer}`,
      );
      // #921: pitch stays constant (nominal TRUNK.step) below the compression threshold — the
      // outer radius must still be well short of the footprint ceiling.
      assert.ok(outer < TRUNK_DISC_R_MAX, `n=${n}: outer radius (${outer}) must still be short of TRUNK_DISC_R_MAX (${TRUNK_DISC_R_MAX})`);
    } else {
      // Compressed branch (n === 24 || n === 42): the growth rule's own stated formula —
      // pitch = (R_max - r0) / N — read from TRUNK_DISC_R_MAX/r0, both real sources, not copied.
      const expectedPitch = (TRUNK_DISC_R_MAX - r0) / n;
      const expectedRadii = Array.from({ length: n }, (_, i) => r0 + (i + 1) * expectedPitch);
      assert.deepEqual(
        actualRadii.map((r) => Number(r.toFixed(6))),
        expectedRadii.map((r) => Number(r.toFixed(6))),
        `n=${n}: every ring radius must equal r0 + i*((R_max-r0)/N) exactly (compressed branch)`,
      );
      // #921: "the outer radius at 24 ≈ R_max" — and, by this file's own compression formula
      // (`ringRadii`'s doc: pitch compresses to land EXACTLY on the ceiling once active), every N
      // past the compression threshold saturates at the SAME TRUNK_DISC_R_MAX, not just N=24.
      assert.ok(
        Math.abs(outer - TRUNK_DISC_R_MAX) < 0.01,
        `n=${n}: outer radius (${outer}) must have reached TRUNK_DISC_R_MAX (${TRUNK_DISC_R_MAX})`,
      );
    }
  }
});

// #921 gate② round 3 finding [0] (ac1-min-pitch-crossover): the growth rule's own THIRD limiting
// term — how many rings the footprint fits at the hairline-resolvable minimum pitch
// (`ringsThatFitFootprint`, stage.tsx) — is restored as a real cap on `drawn`, correcting round
// 2's misreading of AC1's checklist wording as an unconditional override (that misreading is what
// round 3's own finding calls out: "AC1's adjudicated footprint rule is not implemented"). Pinned
// exactly at the FIRST N where it binds: every 1-2 digit total (through N = 99) still draws
// exactly `min(N, TRUNK.max)`; N = 100, the smallest 3-digit total, is the first to draw fewer.
test("#921 gate② round 3 finding [0]: the footprint-fit cap is inert through every 1-2 digit total (drawn = min(N, TRUNK.max) exactly up to N = 99), and binds for the FIRST time at N = 100", () => {
  assert.equal(ringRadii(99).length, Math.min(99, TRUNK.max), "N=99 (2 digits): the footprint-fit cap must not bind yet");
  assert.equal(ringRadii(TRUNK.max).length, TRUNK.max, "N=TRUNK.max (2 digits): still exactly TRUNK.max rings");
  const drawnAt100 = ringRadii(100).length;
  assert.ok(drawnAt100 < TRUNK.max, `N=100 (3 digits) must draw FEWER than TRUNK.max (${TRUNK.max}) — proof the cap actually engaged here`);
  assert.equal(
    drawnAt100,
    36,
    "the exact pinned value at the first binding N — VALUE doctrine: a real computed boundary, not a loose bound",
  );
});

// #921 gate② round 3 findings [0]/[1] (ac1-min-pitch-crossover / ac3-extreme-footprint):
// substantive boundary coverage at all three counts the reviewer named (100, 1000, 1000000) —
// AC1's real, capped draw count (component-tested against the REAL production markup) and AC3's
// footprint ceiling (now held EXACTLY, not merely approximated) at every one of them.
for (const n of [100, 1000, 1_000_000]) {
  test(`#921 gate② round 3: at rings=${n}, AC3's footprint ceiling holds exactly (outer pins at TRUNK_DISC_R_MAX, never past it) and AC1's real (footprint-capped) draw count renders`, () => {
    const outer = ringOuterRadius(n);
    assert.ok(2 * outer <= 0.4 * STAGE.h + 0.001, `disc diameter (${2 * outer}) must not exceed 40% of STAGE.h (${0.4 * STAGE.h})`);
    assert.ok(
      outer <= TRUNK_DISC_R_MAX + 0.01,
      `outer radius (${outer}) must never exceed TRUNK_DISC_R_MAX (${TRUNK_DISC_R_MAX}) — AC3 holds unconditionally now, even at this scale`,
    );

    const drawn = ringRadii(n).length;
    const html = markup({ ...initialHeroState(3), rings: n });
    const trunk = trunkGroupInner(html);
    assert.ok(trunk, `n=${n}: the .hero-trunk group must render`);
    assert.equal(
      (trunk as string).match(/class="hero-ring"/g)?.length ?? 0,
      drawn,
      `n=${n}: the REAL rendered ring count must match the production formula's own drawn count`,
    );
    // The numeral itself stays the honest, uncapped record regardless of how many (or how few)
    // rings physically fit — asserted against the real rendered font-size too (#921 gate② round
    // 3 finding [1]): AC2's floor holds at every count this loop realistically reaches (n=100,
    // 1000), only easing at the true 7-digit extreme where the numeral's own box would otherwise
    // blow the footprint ceiling before a single ring is even drawn.
    assert.match(trunk as string, new RegExp(`class="hero-ring-count"[^>]*>${n}<`));
    const expectedFont = n < 1_000_000 ? RING_COUNT_FONT_PX : ringCountFontPx(n);
    assert.match(
      trunk as string,
      new RegExp(`class="hero-ring-count" style="font-family:var\\(--font-display\\);font-size:${expectedFont}px"`),
    );
  });
}

// #921 gate② round 3 finding [1] (ac3-extreme-footprint): AC3's footprint ceiling must hold at
// EVERY count, including scales where the DEFAULT numeral font's own box would itself exceed
// TRUNK_DISC_R_MAX (7+ digits — the reviewer's own rings=1,000,000 example). Rather than accept a
// documented miss (round 2's resolution), the numeral itself now shrinks (`ringCountFontPx`) so
// its own clearance box never exceeds the ceiling — AC3 holds unconditionally.
//
// #921 gate② round 4 finding [0] (ac3-extreme-clearance): searching against the bare
// TRUNK_DISC_R_MAX let r0 pin RIGHT AT the ceiling, leaving zero room for even one ring's own
// minimum pitch — `ringsThatFitFootprint` correctly computed zero drawn rings at this extreme,
// which is the bug the AC names (a disc with a numeral but NO ring texture at all is not the
// growth rule's "the count is the record" exception — that exception covers rings 42..N being
// undrawn, never rings 1..N). `ringCountFontPx` now searches against TRUNK_DISC_R_MAX minus TWO
// RING_PITCH_MIN slots, read directly from stage.tsx (VALUE doctrine) — this test asserts the
// exact boundary AND that real ring texture survives even at this extreme.
test("#921 gate② round 4 finding [0]: at the reviewer's own 7-digit extreme (rings=1,000,000), the numeral shrinks to leave TWO minimum-pitch ring slots — AC3's ceiling holds exactly AND at least one ring actually renders", () => {
  const rings = 1_000_000;
  const defaultBoxRadius = Math.hypot((String(rings).length * RING_COUNT_FONT_PX * 0.62) / 2, RING_COUNT_FONT_PX - 11);
  assert.ok(
    defaultBoxRadius > TRUNK_DISC_R_MAX,
    `fixture sanity: the numeral's box AT THE DEFAULT FONT (${defaultBoxRadius}) must itself exceed TRUNK_DISC_R_MAX (${TRUNK_DISC_R_MAX}) — the exact scale this finding names`,
  );

  const shrunkFont = ringCountFontPx(rings);
  assert.ok(
    shrunkFont < RING_COUNT_FONT_PX,
    `the numeral must actually shrink below the default (${RING_COUNT_FONT_PX}px) here — got ${shrunkFont}px`,
  );

  const r0 = ringInnerRadius(rings);
  const reservedCeiling = TRUNK_DISC_R_MAX - 2 * RING_PITCH_MIN;
  assert.ok(
    r0 <= reservedCeiling + 0.01,
    `the numeral's OWN clearance (r0 = ${r0}) must fit inside TRUNK_DISC_R_MAX minus two RING_PITCH_MIN slots (${reservedCeiling}) — round 4's own stricter boundary, not just the bare ceiling`,
  );

  const radii = ringRadii(rings);
  assert.ok(
    radii.length >= 1,
    `at least one ring must actually render here — a numeral with NO ring texture at all is the exact bug this finding names, got ${radii.length}`,
  );
  for (const r of radii) {
    assert.ok(r >= r0 - 0.01, `every ring radius (${r}) must stay at/outside r0 (${r0}) — pitch never goes negative/inward-crossing`);
  }

  const outer = ringOuterRadius(rings);
  assert.ok(
    outer <= TRUNK_DISC_R_MAX + 0.01,
    `AC3 must hold EXACTLY here, not as a documented miss (outer ${outer} vs TRUNK_DISC_R_MAX ${TRUNK_DISC_R_MAX})`,
  );

  // Component-level proof (real render, not just the pure function) — the "at least one ring"
  // requirement rendered against the REAL production markup.
  const html = markup({ ...initialHeroState(3), rings });
  const trunk = trunkGroupInner(html);
  assert.ok(trunk, "the .hero-trunk group must render");
  assert.equal(
    (trunk as string).match(/class="hero-ring"/g)?.length ?? 0,
    radii.length,
    "the REAL rendered ring count must match the production formula's own drawn count",
  );
});

// #921 AC3b (carried from #920 gate② r5 finding [0], PR #936 — the low-count remainder #920
// could not close inside its fix cap): today at rings = 1, `ringOuterRadius(1) = 2` puts the
// stem top at y ≈ 192 while the 33px numeral box spans ≈ 174–209 — the stem abuts/crosses the
// numeral's foot. With this issue's disc geometry (`r0` sized to the numeral's own box) the stem
// naturally starts below the count/sapling at every one of these low counts.
test("#921 AC3b: the reflection stem starts at the disc's rendered bottom edge and never crosses the ring-count numeral or the sapling, at rings = 0, 1, 2, 12, 24", () => {
  for (const n of [0, 1, 2, 12, 24]) {
    const { state } =
      n === 0
        ? { state: initialHeroState(3) }
        : run(
            Array.from({ length: n }, (_, i) => ev("merged", { worker: `m${i + 1}`, issue: i + 1, pr: i + 1 })),
            3,
          );
    assert.equal(state.rings, n);
    const html = markup(state);

    const reflectionGroupMatch = html.match(
      /<g class="hero-reflection" data-node="reflection">([\s\S]*?)<\/g>\s*<path class="hero-return"/,
    );
    assert.ok(reflectionGroupMatch, `n=${n}: the hero-reflection group must render`);
    const pathMatch = (reflectionGroupMatch![1] as string).match(/<path class="hero-arm" d="([^"]*)"/);
    assert.ok(pathMatch, `n=${n}: the reflection tree's connector <path> must render`);
    const points = [...(pathMatch![1] as string).matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, , x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
    const stemTopY = Math.min(...points.map((p) => p.y));
    const discBottomY = TRUNK.y + ringOuterRadius(n);
    assert.ok(
      stemTopY >= discBottomY - 0.01,
      `n=${n}: stem top (${stemTopY}) must sit at/below the disc's rendered bottom edge (${discBottomY})`,
    );

    // The numeral's/sapling's own box must not intersect the reflection path's segments. At
    // rings=0, the sapling's own square footprint is read back from its RENDERED <svg>
    // width/height rather than a re-derived constant (VALUE doctrine).
    const box =
      n === 0
        ? (() => {
            const trunk = trunkGroupInner(html);
            const saplingSize = Number(trunk?.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1]);
            assert.ok(saplingSize > 0, "the sapling's own rendered width must be readable");
            const half = saplingSize / 2;
            return { left: TRUNK.x - half, right: TRUNK.x + half, top: TRUNK.y - half, bottom: TRUNK.y + half };
          })()
        : textBox(String(n), TRUNK.x, TRUNK.y + 11, RING_COUNT_FONT_PX);

    const segments = pathSegmentBoxes(pathMatch![1] as string);
    for (const seg of segments) {
      assert.ok(
        !boxesOverlap(seg, box),
        `n=${n}: reflection path segment ${JSON.stringify(seg)} overlaps the ${n === 0 ? "sapling" : "ring-count"} box ${JSON.stringify(box)}`,
      );
    }
  }
});

// ── #745: a droplet the fold can no longer vouch for must not be COUNTED as confident pending ──
//
// #745 gate② round 5 PO pre-merge Tier-C probe (superseding round 4's ruling on this ONE point):
// event-age/threshold inference is DELETED entirely — no constant, no band, in any form — AND
// so is "the fold isn't currently known truncated" as a confidence source. Round 4's own first
// cut still tried that third disjunct, measured from live tail-catch-up (`page.events.length >=
// EVENTS_PAGE`); the live probe caught it wrongly confidently-tallying 40 long-terminal PRs once
// the catch-up flag flipped false a minute after load — tail-caught-up is not the same claim as
// "this droplet's lifecycle is fully covered" (schema-era gaps, external merges bypassing
// conductor.ts). `isPendingConfident` (state.ts) now asks ONLY a positive voucher: is this a
// fold-vouched backlog/handoff droplet, or does the engine's OWN live lane list still name it.
// Everything else renders under the qualified form, ALWAYS — `state.foldTruncated` only tunes
// the qualifier's WORDING ("in window" vs "unverified"), never whether one appears at all.

test("#745 AC1: a PR's terminal event, when actually folded, resolves the droplet cleanly — proving the derivation below is honest, not just broken in a way that happens to pass", () => {
  const events = [
    ev("dispatched", { worker: "w-422", issue: 422 }),
    ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 }),
    ev("merged", { worker: "w-422", issue: 422, pr: 900 }),
  ];
  const { state } = run(events, 3);

  assert.equal(droplet(state, 422)?.at, "trunk", "a PR whose terminal event IS folded resolves out of pending, exactly as it always did");
  const html = markup(state);
  assert.match(
    html.match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /1 merged · 0 pending · 0 needs human/,
  );
});

test("#745 AC1: merges outside the folded input, on a fold the caller reports truncated, are qualified 'in window' — never counted in the confident figure — with NO age inference involved", () => {
  // Deliberately a SMALL event-id gap (the terminal `merged` row was never folded at all, not
  // "folded a long time ago") — an age-based mutant would see nothing to flag here and this
  // assertion would fail, proving the split is driven by a positive voucher, not event distance.
  const dispatch422 = ev("dispatched", { worker: "w-422", issue: 422 });
  const toCheckpoint422 = ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 });
  // Issue 422's own terminal event genuinely falls OUTSIDE this fold's input (a human
  // merged/closed it directly on GitHub, bypassing conductor.ts's merge-driver) — nothing else
  // ever names it again.
  const untruncated = run([dispatch422, toCheckpoint422], 3).state;
  const truncated = withFoldTruncated(untruncated, true);

  const stillThere = droplet(truncated, 422);
  assert.ok(stillThere, "a droplet the fold can't vouch for must still be drawn — never silently deleted");
  assert.equal(stillThere?.at, "checkpoint", "its position is untouched — only the confident tally count excludes it, not the stage");
  assert.match(
    markup(truncated).match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 0 pending \(1 in window\) · 0 needs human/,
    "'in window' is the transient-catch-up wording, chosen only because this fixture explicitly reports truncated=true",
  );
});

// #745 gate② round 5 PO pre-merge Tier-C probe: THIS is the test that inverts round 1's own
// (round-4-era) expectation — a fully-caught-up fold (`foldTruncated: false`) is NOT, by itself,
// a confidence voucher. A droplet with no terminal event and no live-lane-list backing must
// render QUALIFIED regardless — "unverified" is the caught-up-but-still-unvouched wording. The
// mutation-kill pair for finding [1]: restoring `|| !foldTruncated` inside `isPendingConfident`
// makes this specific assertion fail (both droplets would read back as unqualified "2 pending").
test("#745 AC1: the SAME missing-terminal-event droplet, even when the fold is NOT reported truncated, still renders qualified 'unverified' — a caught-up fold is not a confidence voucher", () => {
  // Deliberately a LARGE event-id gap (thousands of unrelated events between arrival and now) —
  // proves this has nothing to do with event age either: qualified regardless of how old or how
  // fresh the droplet's last touch is, because neither age NOR "not truncated" ever vouches for it.
  const dispatch422 = ev("dispatched", { worker: "w-422", issue: 422 });
  const toCheckpoint422 = ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 });
  const farLater = { ...ev("dispatched", { worker: "w-other-1", issue: 1 }), id: toCheckpoint422.id + 3000 };
  const { state } = run([dispatch422, toCheckpoint422, farLater], 3);
  assert.equal(state.foldTruncated, false, "the fixture's own fold must not be truncated — that's the case under test");

  assert.ok(droplet(state, 422), "still drawn, as always");
  assert.match(
    markup(state).match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 0 pending \(2 unverified\) · 0 needs human/,
    "'unverified' is the caught-up-but-still-unvouched wording — neither droplet has a positive voucher, so BOTH are qualified even though the fold is not truncated",
  );
});

test("#745 AC1: a droplet the engine's live lane list still tracks stays in the confident figure EITHER WAY — truncated or not", () => {
  const dispatch422 = ev("dispatched", { worker: "w-422", issue: 422 });
  const toCheckpoint422 = ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 });
  const untruncated = run([dispatch422, toCheckpoint422], 3).state;

  const htmlTruncated = markup(withFoldTruncated(untruncated, true), { liveLanes: [{ issue: 422 }] });
  assert.match(
    htmlTruncated.match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 1 pending · 0 needs human/,
    "the engine still naming this issue is authoritative — no windowed qualifier even though the fold is truncated",
  );

  const htmlUntruncated = markup(untruncated, { liveLanes: [{ issue: 422 }] });
  assert.match(
    htmlUntruncated.match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 1 pending · 0 needs human/,
    "and equally so when the fold reports itself caught up — the live voucher, not the truncation flag, is what's doing the work",
  );
});

test('#745 AC1 / round 4 finding [1]: a handoff ("saved for a successor") droplet is NEVER flagged uncertain, even on a truncated fold', () => {
  const { state } = run([ev("dispatched", { worker: "w-1", issue: 1 }), ev("handoff", { worker: "w-1", issue: 1 })]);
  const truncated = withFoldTruncated(state, true);
  assert.equal(droplet(truncated, 1)?.at, "backlog");
  assert.equal(droplet(truncated, 1)?.handedOff, true);

  assert.match(
    markup(truncated).match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 1 pending · 0 needs human/,
    "fold-vouched backlog/handoff state is confident by construction — the fold's truncation never touches it",
  );
});

// ── #803: the merged-witness projection binds the tally to authoritative persisted signal ──
//
// PR #791's own review found: `/api/loop/state`'s `lanes.items[]` carries a PR NUMBER but
// never its STATE, and a live lane row can never carry a terminal PR state anyway (the tick that
// first observes a terminal PR state settles the lane out of `lanes.items` in the same synchronous
// step). `mergedPrs` (server.ts, sourced from `State.mergedPrNumbers`)
// is the structural fix: the set of PR numbers the persisted event log witnesses as MERGED,
// covering paths this fold's own event-driven transitions never handle (`gated-reentry-merged`,
// `lane-revival-terminal`, `human-merge-only-closed` — only the plain `merged` kind moves a
// droplet to `at: "trunk"` in state.ts's reducer). A droplet whose `pr` is in that projection
// must never count as pending, confident OR windowed — the #745 qualifier is reserved for PRs
// with NO persisted terminal witness at all.
test("#803 AC2: a droplet whose PR is in the merged-witness projection never counts as pending — not confident, not windowed", () => {
  const dispatch422 = ev("dispatched", { worker: "w-422", issue: 422 });
  const toCheckpoint422 = ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 });
  const { state } = run([dispatch422, toCheckpoint422], 3);
  assert.equal(state.foldTruncated, false);
  assert.equal(
    droplet(state, 422)?.at,
    "checkpoint",
    "the fold's own reducer never handles a gated-reentry/revival/human-merge-only witness",
  );

  // With no mergedPrs projection at all, this droplet renders under the #745 "unverified"
  // qualifier — the regression control proving the new behavior below is additive, not a
  // pre-existing loosening of the #745 rule.
  assert.match(
    markup(state).match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 0 pending \(1 unverified\) · 0 needs human/,
  );

  // The engine's persisted event log witnesses PR 900 as merged (e.g. via `gated-reentry-merged`)
  // even though nothing folded that specific kind into this droplet's own transitions.
  const html = markup(state, { mergedPrs: [900] });
  assert.match(
    html.match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 0 pending · 0 needs human/,
    "a persisted merged witness excludes the droplet from the tally entirely — no windowed qualifier either",
  );
  assert.equal(
    droplet(state, 422)?.at,
    "checkpoint",
    "the projection only affects the TALLY — the droplet stays drawn on stage, never deleted",
  );
});

test("#803 AC2: the projection is keyed by PR number — an unrelated PR in mergedPrs never suppresses a different droplet", () => {
  const dispatch422 = ev("dispatched", { worker: "w-422", issue: 422 });
  const toCheckpoint422 = ev("reclaim-done", { worker: "w-422", issue: 422, next: "DRIVING", pr: 900 });
  const { state } = run([dispatch422, toCheckpoint422], 3);

  const html = markup(state, { mergedPrs: [901] });
  assert.match(
    html.match(/class="hero-num hero-small hero-outcome-tally"[^>]*>([^<]*)</)?.[1] as string,
    /0 merged · 0 pending \(1 unverified\) · 0 needs human/,
    "a different PR in the projection must not suppress this droplet's own unmatched pending count",
  );
});

// ── #745 AC2: simultaneous checkpoint droplets must not collide at one shared coordinate ───
//
// #745 gate② round 2 finding [1]: EVERY `at: "checkpoint"` droplet drew at one fixed point —
// unlike `backlog`/`needs-human`, `checkpoint` had no per-droplet offset at all, so two PRs out
// for review at once (the normal steady state, not an edge case) already collided before this
// fix. Round 2 [0]'s never-delete staleness policy (previous test block) makes any such pileup
// durable rather than self-clearing, so a fixed point was no longer tenable. Reproduced through
// the real fold exactly as the finding's own repro: two separate issues each reach checkpoint
// via their own dispatch+reclaim-done pair — no hand-placed state.
//
// #745 gate② round 2 finding [2]: the round-1 `dispatched`-case lane-reuse eviction is removed
// (state.ts) — confirmed dead code on the production path (worker names embed the issue number
// plus a UUID, so `lane.issue !== issue` can never hold for a fresh dispatch) and, worse, unsafe
// in the hypothetical it claimed to guard: `claimLane`'s worker-string match doesn't check lane
// phase, so it could have deleted a genuinely live `at: "checkpoint"` droplet outright. The
// checkpoint offset above is the real, reachable fix for the reported pileup; this file no
// longer carries a test for the removed branch.

test("#745 AC2: two PRs simultaneously out for review render at distinct stage positions, never the identical coordinate", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING", pr: 12 }),
  ]);
  const d1 = droplet(state, 1);
  const d2 = droplet(state, 2);
  assert.ok(d1 && d2);
  assert.equal(d1.at, "checkpoint");
  assert.equal(d2.at, "checkpoint");

  const p1 = dropletPoint(state, d1);
  const p2 = dropletPoint(state, d2);
  assert.notDeepEqual(p1, p2, "two simultaneously-checkpointed droplets must not share a stage position");

  const r1 = dropletRadius("11");
  const r2 = dropletRadius("12");
  // #922 AC2: the number renders INSIDE the shape (`r` fits it exactly) — the circle box alone
  // is the real footprint; no separate label box (which would spuriously self-overlap its own
  // circle now that it's drawn inside, not floating above it).
  const boxes: { label: string; box: Box }[] = [
    { label: "checkpoint #1 circle", box: circleBox(p1.x, p1.y, r1) },
    { label: "checkpoint #2 circle", box: circleBox(p2.x, p2.y, r2) },
  ];
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

// gate② finding [0]: reads CHECKPOINT_DRAW_CAP from source (never a hand-copied "6") and checks
// each droplet's REAL rendered path bbox (`dropletPathBBox`), not a circleBox derived by
// re-calling `dropletRadius` — CHECKPOINT_ROWS_MAX was cut 3 -> 2 by this same finding, once the
// real (taller-than-a-circle) teardrop geometry showed the old 3-row cap was never actually
// collision-safe.
test("#745 AC2: CHECKPOINT_DRAW_CAP simultaneous checkpoint droplets — CHECKPOINT_COLS/STEP's own documented verified-safe ceiling — stay collision-free and within stage bounds", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= CHECKPOINT_DRAW_CAP; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const { state } = run(events, CHECKPOINT_DRAW_CAP);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, CHECKPOINT_DRAW_CAP);

  const html = markup(state, { lanesMax: CHECKPOINT_DRAW_CAP });
  const droplets = renderedDroplets(html);
  assert.equal(droplets.length, CHECKPOINT_DRAW_CAP, "every checkpoint droplet up to the draw cap must actually render");

  const boxes: { label: string; box: Box }[] = [];
  for (const d of droplets) {
    const pathBox = dropletPathBBox(d.path);
    boxes.push({
      label: `checkpoint #${d.issue} circle`,
      box: { left: d.x + pathBox.left, right: d.x + pathBox.right, top: d.y + pathBox.top, bottom: d.y + pathBox.bottom },
    });
  }
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

/** Every rendered `.hero-droplet` group's own `data-issue`, translate offset, path `d`, and
 *  number-text `y`/font-size/content — read straight off the markup, never recomputed from
 *  `dropletRadius`/`dropletPath` (gate② finding [0]'s own "read what actually rendered" ask).
 *  The kind mark and the number are two sibling `<text>` elements — the `[\s\S]*?` between
 *  `</path>` and the number's own `<text>` skips over the kind mark without caring about its
 *  exact content; `dropletKindAndNumber` above reads that separately, when a test needs it. */
function renderedDroplets(
  html: string,
): { issue: number; x: number; y: number; path: string; textY: number; fontPx: number; text: string }[] {
  const re =
    /<g class="hero-droplet" data-issue="(\d+)"[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)">[\s\S]*?<path class="hero-droplet-shape" d="([^"]*)"[^>]*><\/path>[\s\S]*?<text class="hero-num hero-droplet-num" x="0" y="(-?[\d.]+)" text-anchor="middle" style="font-size:([\d.]+)px">([^<]*)<\/text>/g;
  return [...html.matchAll(re)].map(([, issue, x, y, path, textY, fontPx, text]) => ({
    issue: Number(issue),
    x: Number(x),
    y: Number(y),
    path: path as string,
    textY: Number(textY),
    fontPx: Number(fontPx),
    text: text as string,
  }));
}

/**
 * #922 AC2: every droplet's number renders at the FIXED `DROPLET_NUM_FONT_PX`, never a
 * digit-count-derived smaller size — this is the mutation-kill guard: reintroducing any shrink
 * (making `d.fontPx` depend on the number's length again) reddens the first assertion below for
 * every droplet this helper checks, not just a hand-picked one.
 *
 * gate② finding [0] (ac2-geometry-oracle-assumes-fit): height/containment read from the ACTUAL
 * rendered `d`/`<text>` (via `dropletPathBBox`/`renderedDroplets`), never recomputed through
 * `dropletRadius`/`dropletPath` — a text position or path-radius bug the two functions still
 * privately agree on would otherwise stay invisible.
 *
 * gate② finding [0] (ac2-real-render-scale): `1440 / STAGE.w` assumes the SVG gets the full
 * 1440px viewport width — at a REAL 1440px viewport the SVG's own content is ~1318px wide (icon
 * rail + `.stack`/`.panel` chrome, `REAL_RENDER_SCALE_1440`'s own doc in stage.tsx), so the naive
 * ratio overstates the render scale and lets a too-small production floor through; every check
 * here goes through `REAL_RENDER_SCALE_1440`, never the naive ratio.
 */
function assertDropletNumeralsHold(html: string, label: string) {
  const droplets = renderedDroplets(html);
  assert.ok(droplets.length > 0, `${label}: at least one droplet must render`);
  for (const d of droplets) {
    assert.equal(d.fontPx, DROPLET_NUM_FONT_PX, `${label}: droplet #${d.issue}'s number must render at the fixed floor, never shrunk`);
    const numFontPxAt1440 = d.fontPx * REAL_RENDER_SCALE_1440;
    assert.ok(
      numFontPxAt1440 >= 11,
      `${label}: droplet #${d.issue}'s number ${d.fontPx}px * ${REAL_RENDER_SCALE_1440} = ${numFontPxAt1440}px must clear the AC's own >= 11px-at-1440 floor at the REAL render scale`,
    );

    const pathBox = dropletPathBBox(d.path);
    const heightPx = (pathBox.bottom - pathBox.top) * REAL_RENDER_SCALE_1440;
    assert.ok(
      heightPx >= 28,
      `${label}: droplet #${d.issue}'s rendered path height ${heightPx}px must clear the AC's own >= 28px-at-1440 floor at the REAL render scale`,
    );
    const textBoxForDroplet = textBox(d.text, 0, d.textY, d.fontPx);
    assert.ok(
      textBoxForDroplet.left >= pathBox.left &&
        textBoxForDroplet.right <= pathBox.right &&
        textBoxForDroplet.top >= pathBox.top &&
        textBoxForDroplet.bottom <= pathBox.bottom,
      `${label}: droplet #${d.issue}'s number text box ${JSON.stringify(textBoxForDroplet)} must sit fully inside its own path box ${JSON.stringify(pathBox)}`,
    );
  }
}

// Neighbour-collision at the raised radii is proven by the "4 lanes, 6 checkpoint droplets"
// COLLISION test below (`renderedDroplets`'s own regex feeds it the same real path boxes) and by
// the dedicated max-radius COLLISION test further down — not duplicated here.
test("#922 AC2: the droplet numeral never shrinks — >= 11px at 1440, fully contained, across the stress/idle/demo fixtures and hand-picked 4-/5-digit numbers", () => {
  // "demo": a plain steady-state single dispatch, realistic 1-3 digit PR.
  const demoHtml = markup(
    run([ev("dispatched", { worker: "w1", issue: 1 }), ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 42 })]).state,
  );
  assertDropletNumeralsHold(demoHtml, "demo fixture");

  // "idle": a single parked-PR droplet on the escalation branch, at a realistic 4-digit issue/PR
  // (#922 AC2's own report named a 4-digit parked-PR droplet measuring under the 11px floor).
  const idleHtml = markup(
    run([
      ev("dispatched", { worker: "w1", issue: 9202 }),
      ev("reclaim-done", { worker: "w1", issue: 9202, next: "DRIVING", pr: 9202 }),
      ev("drive-needs-human", { worker: "w1", issue: 9202, pr: 9202 }),
    ]).state,
  );
  assert.deepEqual(dropletKindAndNumber(idleHtml, 9202), { kind: "PR", number: "9202" }, "the idle fixture must draw 'PR 9202'");
  assertDropletNumeralsHold(idleHtml, "idle fixture");

  // A merged (trunk) droplet at a realistic 4-digit PR — the AC's other named case, "✓ 9201".
  const trunkHtml = markup(run([ev("merged", { worker: "w1", issue: 1, pr: 9201 })]).state);
  assert.deepEqual(dropletKindAndNumber(trunkHtml, 1), { kind: "✓", number: "9201" }, "the merged fixture must draw '✓ 9201'");
  assertDropletNumeralsHold(trunkHtml, "trunk fixture");

  // "stress": the AC's own named fixture — 4 lanes, 6 checkpoint droplets.
  const stressEvents: DomainEvent[] = [];
  const workers = ["w1", "w2", "w3", "w4"];
  for (let i = 1; i <= 6; i++) {
    const worker = workers[(i - 1) % 4] as string;
    stressEvents.push(ev("dispatched", { worker, issue: i }));
    stressEvents.push(ev("reclaim-done", { worker, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const stressHtml = markup(run(stressEvents, 4).state, { lanesMax: 4 });
  assertDropletNumeralsHold(stressHtml, "stress fixture");

  // Hand-picked 4-/5-digit numbers: a bare 4-digit issue number and an in-flight 5-digit PR —
  // both realistic within weeks for sapwood's own repo (already in the 900s).
  const issue9202Html = markup(run([ev("dispatched", { worker: "w1", issue: 9202 })]).state);
  assert.deepEqual(dropletKindAndNumber(issue9202Html, 9202), { kind: "⊙", number: "9202" });
  assertDropletNumeralsHold(issue9202Html, "hand-picked issue #9202");

  const pr12345Html = markup(
    run([ev("dispatched", { worker: "w1", issue: 1 }), ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 12345 })]).state,
  );
  assert.deepEqual(dropletKindAndNumber(pr12345Html, 1), { kind: "⤳", number: "12345" });
  assertDropletNumeralsHold(pr12345Html, "hand-picked PR #12345");
});

/** The checkpoint overflow badge's own rendered box — the `<g class="hero-checkpoint-overflow">`
 *  wrapper's real transform PLUS its child `<text>`'s own real x/y and content, summed for the
 *  absolute position; never a hand-recomputed offset. `.hero-small`'s 10px (hero.css) is the one
 *  value still cited from the stylesheet rather than the markup — a `font-size` set only by a CSS
 *  class (never inlined on this element) isn't readable from static markup alone. */
function renderedCheckpointOverflowBadge(html: string): { label: string; box: Box } | null {
  const m = html.match(
    /<g class="hero-checkpoint-overflow" data-count="\d+" transform="translate\((-?[\d.]+) (-?[\d.]+)\)"><text class="hero-num hero-small hero-badge" x="0" y="(-?[\d.]+)" text-anchor="middle">([^<]*)<\/text><\/g>/,
  );
  if (!m) return null;
  const [, gxRaw, gyRaw, textYRaw, text] = m;
  return {
    label: `checkpoint overflow badge ("${text}")`,
    box: textBox(text as string, Number(gxRaw), Number(gyRaw) + Number(textYRaw), 10),
  };
}

/** A lane's own rendered node-label box — the `<text class="hero-node-label">` inside that lane's
 *  own `<g data-lane-index>`, real x/y read straight off the markup; never a hand-recomputed
 *  `laneY(...) - 10` offset. `GATE_NODE_LABEL_FONT_PX` (12px, `.hero-node-label`'s own CSS rule)
 *  is the one value still cited from the stylesheet, same reasoning as the badge helper above. */
function renderedLaneLabel(html: string, channel: number): { label: string; box: Box } | null {
  const laneBlock = html.match(new RegExp(`<g class="hero-lane" data-lane-index="${channel}"[^>]*>([\\s\\S]*?)<\\/g>`));
  if (!laneBlock) return null;
  const m = (laneBlock[1] as string).match(/<text class="hero-node-label" x="(-?[\d.]+)" y="(-?[\d.]+)">([^<]*)<\/text>/);
  if (!m) return null;
  const [, xRaw, yRaw, text] = m;
  return {
    label: `lane ${channel} label ("${text}")`,
    box: captionSafeTextBox(text as string, Number(xRaw), Number(yRaw), GATE_NODE_LABEL_FONT_PX, "start"),
  };
}

// #922 AC2's own named stress fixture, verbatim: "4 lanes, 6 checkpoint droplets" — 4 lane
// workers cycle through 6 dispatches total (checkpoint droplets are tracked independently by
// issue, so a lane cycling to a new dispatch doesn't remove an earlier issue's own still-parked
// checkpoint droplet), keeping every lane label AND every checkpoint droplet on stage at once.
// gate② finding [0]: uses each droplet's OWN rendered path bbox (`dropletPathBBox`, parsed from
// the actual `d` attribute) as its collision footprint — not a `circleBox` derived by re-calling
// `dropletRadius`, which would only prove the two production functions agree with each other.
// The same finding cut CHECKPOINT_ROWS_MAX 3 -> 2 (CHECKPOINT_DRAW_CAP's own doc): 6 checkpoint
// droplets still exist/fold at once (the AC's own named fixture), but only CHECKPOINT_DRAW_CAP
// of them actually DRAW — the rest fold into the overflow badge, whose own box is checked here
// too, alongside every drawn droplet and lane label — both read from the ACTUAL rendered markup
// (`renderedCheckpointOverflowBadge`/`renderedLaneLabel` above), never a hand-recomputed offset.
test("#922 AC2: no droplet number overlaps a neighbouring droplet or a lane label — the AC's own '4 lanes, 6 checkpoint droplets' stress fixture", () => {
  const events: DomainEvent[] = [];
  const workers = ["w1", "w2", "w3", "w4"];
  for (let i = 1; i <= 6; i++) {
    const worker = workers[(i - 1) % 4] as string;
    events.push(ev("dispatched", { worker, issue: i }));
    events.push(ev("reclaim-done", { worker, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const { state } = run(events, 4);
  assert.equal(state.lanes.length, 4, "the fixture must actually render 4 lanes");
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 6, "the fixture must actually fold 6 simultaneous checkpoint droplets");

  const html = markup(state, { lanesMax: 4 });
  const droplets = renderedDroplets(html);
  // 6 folded checkpoint droplets exceed CHECKPOINT_DRAW_CAP, so overflow triggers — only
  // CHECKPOINT_OVERFLOW_REAL_CAP (one row short of the full grid) actually draw.
  assert.equal(droplets.length, CHECKPOINT_OVERFLOW_REAL_CAP, "exactly the overflow-real-cap's worth of checkpoint droplets must render");
  assert.match(html, new RegExp(`class="hero-checkpoint-overflow" data-count="${6 - CHECKPOINT_OVERFLOW_REAL_CAP}"`));

  // Only the rendered PATH box per droplet — the dedicated containment test above already proves
  // each droplet's own number sits inside its own path, so pushing both here would spuriously
  // self-overlap (a droplet's own number is INSIDE its own path by design); the path box alone is
  // the more conservative (strictly larger) footprint for the cross-droplet/lane collision check.
  const boxes: { label: string; box: Box }[] = [];
  for (const d of droplets) {
    const pathBox = dropletPathBBox(d.path);
    boxes.push({
      label: `checkpoint #${d.issue} rendered path`,
      box: { left: d.x + pathBox.left, right: d.x + pathBox.right, top: d.y + pathBox.top, bottom: d.y + pathBox.bottom },
    });
  }
  const overflowBadge = renderedCheckpointOverflowBadge(html);
  assert.ok(overflowBadge, "the overflow badge must render");
  boxes.push(overflowBadge as { label: string; box: Box });
  for (const lane of state.lanes) {
    const laneLabel = renderedLaneLabel(html, lane.channel);
    assert.ok(laneLabel, `lane ${lane.channel}'s own label must render`);
    boxes.push(laneLabel as { label: string; box: Box });
  }
  assertNoOverlap(boxes);
});

// COLLISION at max radius: the fixture above only ever carries 3-digit PR numbers (101..106),
// so the geometry constants sized against `DROPLET_MAX_R` (`NEEDS_HUMAN_COL_STEP`/`ROW_STEP`,
// `CHECKPOINT_COL_STEP`/`ROW_STEP` — stage.tsx's own doc on each) are never actually exercised at
// the radius they were sized for. This fixture forces every droplet's own PR to 5 digits — the
// widest number `DROPLET_MAX_R` (22) still fits without clipping (`dropletRadius`'s own doc:
// halfWidth("90001".length=5) ≈ 21.05) — across BOTH clusters the ceiling's own margin math
// covers: checkpoint (the AC's own named fixture, same 4-lanes/6-droplets shape) and needs-human
// (its own draw cap, 6).
test("#922 AC2 COLLISION at max radius: adjacent checkpoint and needs-human droplets carrying realistic 5-digit numbers do not overlap", () => {
  const events: DomainEvent[] = [];
  const workers = ["w1", "w2", "w3", "w4"];
  for (let i = 1; i <= 6; i++) {
    const worker = workers[(i - 1) % 4] as string;
    events.push(ev("dispatched", { worker, issue: i }));
    events.push(ev("reclaim-done", { worker, issue: i, next: "DRIVING", pr: 90000 + i }));
  }
  for (let i = 201; i <= 206; i++) {
    events.push(ev("dispatched", { worker: `h${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `h${i}`, issue: i, next: "DRIVING", pr: 90000 + i }));
    events.push(ev("drive-needs-human", { worker: `h${i}`, issue: i, pr: 90000 + i }));
  }
  const { state } = run(events, 4);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  const escalated = state.droplets.filter((d) => d.at === "needs-human");
  assert.equal(checkpointed.length, 6, "the fixture must actually fold 6 simultaneous checkpoint droplets");
  assert.equal(escalated.length, 6, "the fixture must actually fold 6 simultaneous needs-human droplets, filling the draw cap");

  const html = markup(state, { lanesMax: 4 });
  const droplets = renderedDroplets(html);
  assert.equal(
    droplets.length,
    CHECKPOINT_OVERFLOW_REAL_CAP + 6,
    "the overflow-real-cap's worth of checkpoint droplets plus every needs-human droplet must render",
  );
  // Sanity on the fixture itself: every rendered droplet's own half-width must actually sit near
  // the ceiling (`DROPLET_MAX_R`, 22) — proving this fixture exercises the radius the geometry
  // constants above were sized for, not a smaller realistic one that would silently understate
  // the collision risk.
  for (const d of droplets) {
    const pathBox = dropletPathBBox(d.path);
    const halfWidthPx = (pathBox.right - pathBox.left) / 2;
    assert.ok(
      halfWidthPx >= 20,
      `droplet #${d.issue}'s rendered half-width ${halfWidthPx} must sit near DROPLET_MAX_R (22) — this fixture's own 5-digit numbers`,
    );
  }

  const boxes: { label: string; box: Box }[] = [];
  for (const d of droplets) {
    const pathBox = dropletPathBBox(d.path);
    boxes.push({
      label: `droplet #${d.issue} rendered path`,
      box: { left: d.x + pathBox.left, right: d.x + pathBox.right, top: d.y + pathBox.top, bottom: d.y + pathBox.bottom },
    });
  }
  // 6 checkpoint droplets > CHECKPOINT_OVERFLOW_REAL_CAP, so the overflow badge must render at
  // this fixture too (same trigger as the base "4 lanes, 6 checkpoint droplets" test above) —
  // required, not optional: a parse miss here must fail the test, not silently drop the check.
  const overflowBadge = renderedCheckpointOverflowBadge(html);
  assert.ok(overflowBadge, "the checkpoint overflow badge must render at this fixture (6 checkpoints > CHECKPOINT_OVERFLOW_REAL_CAP)");
  boxes.push(overflowBadge as { label: string; box: Box });
  // This fixture's own `state.lanes` carries 10 distinct workers (4 checkpoint + 6 needs-human)
  // — `lanesMax: 4` at render time caps that down to the 4 most-recently-touched (`markup`'s own
  // `withVisibleLanes`), so only SOME of `state.lanes` actually draws. Iterate the channels the
  // markup itself actually rendered, never the raw (uncapped) fold state — every channel found
  // this way is guaranteed to have its own label, so `renderedLaneLabel` returning null here is a
  // real parse bug, not a fixture mismatch.
  const renderedLaneChannels = [...html.matchAll(/<g class="hero-lane" data-lane-index="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(renderedLaneChannels.length > 0, "at least one lane must actually render at this fixture");
  for (const channel of renderedLaneChannels) {
    const laneLabel = renderedLaneLabel(html, channel);
    assert.ok(laneLabel, `lane ${channel}'s own label must render`);
    boxes.push(laneLabel as { label: string; box: Box });
  }
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

/** gate② finding [1] (ac2-escalation-overlap): every rendered NODE circle on the stage — planning/
 *  reflection discs, the CI/Review gates, and the escalation circle — read straight off the
 *  markup (COVERAGE), never a hand-picked subset. The prior collision tests compared droplets
 *  against gates/rings/tallies/labels but NEVER the escalation circle itself — exactly how the
 *  rank-0 needs-human droplet's overlap (the PO witness's own report) went unnoticed. */
function renderedNodeCircles(html: string): { label: string; box: Box }[] {
  const boxes: { label: string; box: Box }[] = [];
  for (const [i, m] of [...html.matchAll(/<circle class="hero-planning-node" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].entries()) {
    boxes.push({ label: `planning/reflection node #${i} circle`, box: circleBox(Number(m[1]), Number(m[2]), Number(m[3])) });
  }
  for (const [i, m] of [...html.matchAll(/<circle class="hero-gate-node" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].entries()) {
    boxes.push({ label: `gate node #${i} circle`, box: circleBox(Number(m[1]), Number(m[2]), Number(m[3])) });
  }
  const escalationMatch = html.match(/<circle style="stroke:var\(--rust\)" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  if (escalationMatch) {
    boxes.push({
      label: "escalation circle",
      box: circleBox(Number(escalationMatch[1]), Number(escalationMatch[2]), Number(escalationMatch[3])),
    });
  }
  return boxes;
}

// gate② finding [1] (ac2-escalation-overlap): the idle fixture — a SINGLE parked-PR droplet on
// the escalation branch, the exact shape the PO witness reported overlapping the NEEDS HUMAN
// glyph by ~16px — plus the AC's own named stress fixture ("4 lanes, 6 checkpoint droplets"),
// cross-checked against EVERY rendered node circle (COVERAGE), not just the CI/Review gates the
// earlier tests happened to check. The escalation circle specifically gets a real >= 12px
// clearance assertion (the AC's own number), not just non-overlap — a 1px gap would still pass a
// bare `!boxesOverlap` check but not the AC's own wording.
test("#922 AC2 gate② finding [1]: every rendered droplet clears every rendered node circle (COVERAGE); the escalation circle by >= 12px — idle and stress fixtures", () => {
  const idleEvents = [
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 10 }),
    ev("drive-needs-human", { worker: "w1", issue: 1, pr: 10 }),
  ];
  const idleHtml = markup(run(idleEvents).state);
  assert.equal(renderedDroplets(idleHtml).length, 1, "the idle fixture must actually draw exactly one droplet");
  assert.equal(dropletKindAndNumber(idleHtml, 1)?.kind, "PR", "the idle fixture's droplet must be a parked-PR droplet");

  const stressEvents: DomainEvent[] = [];
  const workers = ["w1", "w2", "w3", "w4"];
  for (let i = 1; i <= 6; i++) {
    const worker = workers[(i - 1) % 4] as string;
    stressEvents.push(ev("dispatched", { worker, issue: i }));
    stressEvents.push(ev("reclaim-done", { worker, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const stressHtml = markup(run(stressEvents, 4).state, { lanesMax: 4 });

  for (const html of [idleHtml, stressHtml]) {
    const nodeCircles = renderedNodeCircles(html);
    assert.ok(nodeCircles.length > 0, "at least one node circle must render");
    const escalationCircle = nodeCircles.find((n) => n.label === "escalation circle");
    assert.ok(escalationCircle, "the escalation circle must be derivable from the rendered markup");

    for (const d of renderedDroplets(html)) {
      const pathBox = dropletPathBBox(d.path);
      const box: Box = { left: d.x + pathBox.left, right: d.x + pathBox.right, top: d.y + pathBox.top, bottom: d.y + pathBox.bottom };
      for (const node of nodeCircles) {
        assert.ok(
          !boxesOverlap(box, node.box),
          `droplet #${d.issue} ${JSON.stringify(box)} overlaps ${node.label} ${JSON.stringify(node.box)}`,
        );
      }
      // The escalation branch's own droplets sit ABOVE the circle by construction
      // (`dropletPoint`'s needs-human case) — a real vertical clearance, not just non-overlap.
      if (box.bottom <= escalationCircle!.box.top) {
        assert.ok(
          escalationCircle!.box.top - box.bottom >= 12,
          `droplet #${d.issue}'s bottom edge must clear the escalation circle's top edge by >= 12px, got ${escalationCircle!.box.top - box.bottom}px`,
        );
      }
    }
  }
});

// #745 gate② round 5 PO pre-merge Tier-C probe (1700px, live DB): a drawn checkpoint chip's
// label bbox-intersected the Review gate's own "engine-agent" mode caption — the same defect
// family as #728/#744 (real rendered extent, not anchor-point spacing). Checked at every rank up
// to `CHECKPOINT_DRAW_CAP - 1` (the pre-overflow ceiling) against the FULL CI/Review gate
// cluster: the gate circles, both node labels, and the Review caption (rendered with
// `reviewer.mode` set, the exact live shape — the caption doesn't even mount without it).
//
// #897: rewritten for the circular gate shape (`GATES.r`, not a rect) — label/caption positions
// are read DYNAMICALLY off the rendered markup (same discipline the caption match already used)
// rather than hand-copied constants, so a future geometry tweak can't silently desync this
// oracle from what's actually drawn (the VALUE doctrine's own "read the value from its source"
// rule) — the STALE version of this test (hardcoded `GATES.y + 5`, a rect box) is exactly the
// failure this rewrite closes: it kept passing against geometry that no longer existed.
test("#745 gate②: no checkpoint chip, at any rank up to the grid's capacity, intersects the CI/Review gate cluster (circle, label, or mode caption)", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 6; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const { state } = run(events, 6);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 6, "exercise every rank up to CHECKPOINT_DRAW_CAP - 1 (0..5)");

  // #922 AC7: REVIEW's caption is now a model·effort pair — "fable · high" is 12 characters,
  // the same width `textBox()` modeled for the old "engine-agent" mode word this fixture used to
  // mount, so the collision geometry this test proves stays the same live shape.
  const html = markup(state, { config: { reviewer: { agent: { model: "fable", effort: "high" } } } });
  const captionMatch = html.match(/class="hero-node-caption" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">fable · high</);
  assert.ok(captionMatch, "the fixture must actually mount the Review gate's caption (the live shape under test)");
  const [, capXRaw, capYRaw] = captionMatch as unknown as [string, string, string];

  const ciLabelMatch = html.match(/<text class="hero-node-label" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">CI<\/text>/);
  assert.ok(ciLabelMatch, "the CI gate label must render");
  const [, ciLabelXRaw, ciLabelYRaw] = ciLabelMatch as unknown as [string, string, string];

  const reviewLabelMatch = html.match(/<text class="hero-node-label" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">Review<\/text>/);
  assert.ok(reviewLabelMatch, "the Review gate label must render");
  const [, reviewLabelXRaw, reviewLabelYRaw] = reviewLabelMatch as unknown as [string, string, string];

  const gateBoxes: { label: string; box: Box }[] = [
    { label: "CI gate circle", box: circleBox(GATES.ci, GATES.y, GATES.r) },
    { label: "CI gate label", box: textBox("CI", Number(ciLabelXRaw), Number(ciLabelYRaw), 12) },
    { label: "Review gate circle", box: circleBox(GATES.review, GATES.y, GATES.r) },
    { label: "Review gate label", box: textBox("Review", Number(reviewLabelXRaw), Number(reviewLabelYRaw), 12) },
    { label: "Review gate caption (fable · high)", box: textBox("fable · high", Number(capXRaw), Number(capYRaw), 9) },
  ];

  const checkpointBoxes: { label: string; box: Box }[] = [];
  for (const d of checkpointed) {
    const { x, y } = dropletPoint(state, d);
    const number = dropletNumberText(d);
    const r = dropletRadius(number);
    checkpointBoxes.push({ label: `checkpoint #${d.issue} circle`, box: circleBox(x, y, r) });
    checkpointBoxes.push({
      label: `checkpoint #${d.issue} number`,
      box: textBox(number, x, y + ((r * 9) / 7) * 0.35, DROPLET_NUM_FONT_PX),
    });
  }

  // Cross-product only — gate circle/label/caption overlapping EACH OTHER is by design (the
  // caption sits above the circle, the label below it — see `GATES`'s own doc); what must never
  // overlap is a checkpoint chip against any piece of the gate cluster.
  for (const chip of checkpointBoxes) {
    for (const gate of gateBoxes) {
      assert.ok(
        !boxesOverlap(chip.box, gate.box),
        `${chip.label} ${JSON.stringify(chip.box)} overlaps ${gate.label} ${JSON.stringify(gate.box)}`,
      );
    }
  }

  // #808: the loop above is `textBox()`'s plain model — the exact one that "already showed
  // clearance" for this pair while the real 1700px live-DOM probe still found a marginal
  // ink-level shave (`CAPTION_SAFE_ASCENT`'s own doc comment). `textBox()` cannot see that gap
  // by construction: it is font-metric/leading blindness in the oracle, not a defect in this
  // specific pair's geometry (this second pass re-checks the SAME ranks against the SAME
  // cluster and stays green — the margin `GATES`'s own doc already carries is wide enough to
  // absorb the refined ascent too). Re-run with `captionSafeTextBox` as the regression guard
  // against a FUTURE geometry change that narrows this pair back down to something only the
  // refined oracle would catch.
  const gateBoxesRefined: { label: string; box: Box }[] = [
    { label: "CI gate circle", box: circleBox(GATES.ci, GATES.y, GATES.r) },
    { label: "CI gate label", box: captionSafeTextBox("CI", Number(ciLabelXRaw), Number(ciLabelYRaw), GATE_NODE_LABEL_FONT_PX) },
    { label: "Review gate circle", box: circleBox(GATES.review, GATES.y, GATES.r) },
    {
      label: "Review gate label",
      box: captionSafeTextBox("Review", Number(reviewLabelXRaw), Number(reviewLabelYRaw), GATE_NODE_LABEL_FONT_PX),
    },
    {
      label: "Review gate caption (fable · high)",
      box: captionSafeTextBox("fable · high", Number(capXRaw), Number(capYRaw), CAPTION_FONT_PX, "middle"),
    },
  ];
  const checkpointBoxesRefined: { label: string; box: Box }[] = checkpointed.map((d) => {
    const { x, y } = dropletPoint(state, d);
    const number = dropletNumberText(d);
    const r = dropletRadius(number);
    return {
      label: `checkpoint #${d.issue} number (refined)`,
      box: captionSafeTextBox(number, x, y + ((r * 9) / 7) * 0.35, DROPLET_NUM_FONT_PX),
    };
  });
  for (const chip of checkpointBoxesRefined) {
    for (const gate of gateBoxesRefined) {
      assert.ok(
        !boxesOverlap(chip.box, gate.box),
        `${chip.label} ${JSON.stringify(chip.box)} overlaps ${gate.label} ${JSON.stringify(gate.box)} (refined ascent)`,
      );
    }
  }
});

// #897: the checkpoint cluster above ONLY exercises checkpoint chips against the gate cluster —
// this asserts the NEEDS-HUMAN cluster (a DIFFERENT zone, below-and-right of the gates) clears
// the gate cluster too, at its own documented draw cap (6, `NEEDS_HUMAN_DRAW_CAP`), with the
// Review mode caption mounted (the live shape the relevant rank-5 math was computed against).
// Dedicated fixture + oracle, not folded into the checkpoint test above, since the two clusters
// occupy different geometry.
test("#897 AC2: no needs-human droplet, at any rank up to the cluster's draw cap, intersects the CI/Review gate cluster (circle, label, or mode caption)", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 6; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: 200 + i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: 200 + i, next: "DRIVING", pr: 9000 + i }));
    events.push(ev("drive-needs-human", { worker: `w${i}`, issue: 200 + i, pr: 9000 + i }));
  }
  const { state } = run(events, 43);
  const escalated = state.droplets.filter((d) => d.at === "needs-human");
  assert.equal(escalated.length, 6, "exercise every rank up to NEEDS_HUMAN_DRAW_CAP (0..5), including the finding's own rank 5");

  const html = markup(state, { lanesMax: 43, config: { reviewer: { agent: { model: "fable", effort: "high" } } } });
  const captionMatch = html.match(/class="hero-node-caption" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">fable · high</);
  assert.ok(captionMatch, "the fixture must actually mount the Review gate's caption (the live shape the finding computed against)");
  const [, capXRaw, capYRaw] = captionMatch as unknown as [string, string, string];
  const ciLabelMatch = html.match(/<text class="hero-node-label" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">CI<\/text>/);
  assert.ok(ciLabelMatch);
  const [, ciLabelXRaw, ciLabelYRaw] = ciLabelMatch as unknown as [string, string, string];
  const reviewLabelMatch = html.match(/<text class="hero-node-label" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">Review<\/text>/);
  assert.ok(reviewLabelMatch);
  const [, reviewLabelXRaw, reviewLabelYRaw] = reviewLabelMatch as unknown as [string, string, string];

  const gateBoxesRefined: { label: string; box: Box }[] = [
    { label: "CI gate circle", box: circleBox(GATES.ci, GATES.y, GATES.r) },
    { label: "CI gate label", box: captionSafeTextBox("CI", Number(ciLabelXRaw), Number(ciLabelYRaw), GATE_NODE_LABEL_FONT_PX) },
    { label: "Review gate circle", box: circleBox(GATES.review, GATES.y, GATES.r) },
    {
      label: "Review gate label",
      box: captionSafeTextBox("Review", Number(reviewLabelXRaw), Number(reviewLabelYRaw), GATE_NODE_LABEL_FONT_PX),
    },
    {
      label: "Review gate caption (fable · high)",
      box: captionSafeTextBox("fable · high", Number(capXRaw), Number(capYRaw), CAPTION_FONT_PX, "middle"),
    },
  ];

  for (const d of escalated) {
    const { x, y } = dropletPoint(state, d);
    // #922 AC2: a needs-human droplet carrying a PR reads "PR N" — the "PR" mark
    // is a separate, smaller sibling element (production's own `dropletKind`); the shape
    // still fits the bare NUMBER only.
    const number = dropletNumberText(d);
    const r = dropletRadius(number);
    const needsHumanBoxes: { label: string; box: Box }[] = [
      { label: `needs-human #${d.issue} circle`, box: circleBox(x, y, r) },
      { label: `needs-human #${d.issue} number`, box: captionSafeTextBox(number, x, y + ((r * 9) / 7) * 0.35, DROPLET_NUM_FONT_PX) },
    ];
    for (const nh of needsHumanBoxes) {
      for (const gate of gateBoxesRefined) {
        assert.ok(
          !boxesOverlap(nh.box, gate.box),
          `${nh.label} ${JSON.stringify(nh.box)} overlaps ${gate.label} ${JSON.stringify(gate.box)}`,
        );
      }
    }
  }
});

// ── #808: refined font-metric oracle — every droplet chip label vs. every hero-node-caption ──
//
// AC1/AC2: `textBox()`'s ASCENT undershoots real rendered ink (`CAPTION_SAFE_ASCENT`'s doc
// comment records the measured basis), so this test rebuilds every drawn droplet chip label
// and every drawn `hero-node-caption` element with `captionSafeTextBox` and cross-checks the
// full set — every zone the stage draws captions in (planning trio, lanes, Review, reflection
// pair) against every droplet state (backlog incl. a handed-off 3-row chip, a plain lane, a
// fixing lane, a full CHECKPOINT_DRAW_CAP of checkpoint chips, needs-human, and a merged/trunk
// droplet) at once — not just the checkpoint-vs-Review-gate pair #745 already covered.
test("#808 AC1: every droplet chip label and every hero-node-caption element stay collision-free under the refined ascent, across every zone at once", () => {
  const config = {
    roles: {
      po: { model: "opus", effort: "high" },
      architect: { model: "sonnet", effort: "medium" },
      verificationPlanReviewer: { model: "sonnet", effort: "medium" },
      harvest: { model: "sonnet", effort: "low" },
      retro: { model: "sonnet", effort: "low" },
    },
    worker: { model: "sonnet", effort: "medium" },
    // #922 AC7: REVIEW's caption is now a model·effort pair (reviewer.agent.*), never the
    // internal reviewer.mode word — this fixture must mount a real caption to exercise the
    // Review-gate-caption collision surface this test's own name promises.
    reviewer: { agent: { model: "fable", effort: "high" } },
  };

  const events: DomainEvent[] = [ev("pool-selected", { round_id: 1, issues: [90, 91] })];
  for (let i = 0; i < CHECKPOINT_DRAW_CAP; i++) {
    // fills CHECKPOINT_DRAW_CAP — every rank the grid draws
    events.push(ev("dispatched", { worker: `c${i}`, issue: 10 + i }));
    events.push(ev("reclaim-done", { worker: `c${i}`, issue: 10 + i, next: "DRIVING", pr: 700 + i }));
  }
  events.push(ev("dispatched", { worker: "w9", issue: 50 }));
  events.push(ev("reclaim-done", { worker: "w9", issue: 50, next: "DRIVING", pr: 500 }));
  events.push(ev("drive-needs-human", { worker: "w9", issue: 50, pr: 500, reason: "flaky", cap: 2, fixRounds: 2 }));
  events.push(ev("dispatched", { worker: "w10", issue: 60 }));
  events.push(ev("reclaim-done", { worker: "w10", issue: 60, next: "DRIVING", pr: 600 }));
  events.push(ev("merged", { worker: "w10", issue: 60, pr: 600, headOid: "abc" })); // trunk droplet
  events.push(ev("dispatched", { worker: "w11", issue: 70 }));
  events.push(ev("handoff", { worker: "w11", issue: 70 })); // handed-off backlog droplet (3-row chip)
  // #808 gate② finding [0] (run a343c343): the plain/fixing lane droplets are dispatched LAST,
  // deliberately — `withVisibleLanes` caps `state.lanes` at `lanesMax` and (same-tier) keeps the
  // MOST recently touched (`state.ts`'s `visibleLanes` tie-break); with CHECKPOINT_DRAW_CAP + 2
  // active-tier lane workers open (`c0`..`c(CHECKPOINT_DRAW_CAP - 1)` + these two) against
  // `lanesMax: CHECKPOINT_DRAW_CAP + 1` below, whichever ONE was touched LEAST recently loses its
  // slot — and #716 gate② round 2 P1-1's rule then DROPS any droplet still `at: "lane"` whose lane
  // lost that slot, never drawing it at all. Dispatching `w1`/`w2` last makes THEM the most-
  // recently-touched pair instead, so both survive and actually render (the earlier ordering
  // silently evicted them, the exact gap the finding caught below).
  events.push(ev("dispatched", { worker: "w1", issue: 1 })); // plain lane droplet
  events.push(ev("dispatched", { worker: "w2", issue: 2 }));
  events.push(ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING", pr: 200 }));
  events.push(
    ev("drive-fixup", {
      worker: "w2",
      issue: 2,
      pr: 200,
      fixRounds: 1,
      reason: "gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=2:ciRed=false",
    }),
  );
  events.push(ev("fix-leg-started", { worker: "w2", issue: 2, pr: 200, fixRounds: 1 })); // fixing lane

  // `markup()` renders the fixed 1200×380 viewBox `stage.tsx` always draws — the same shape a
  // ≥1600px real viewport shows, per `hero.css`'s `width:100%;height:auto` (`#728`'s own "scales
  // as one unit" test above): SVG percentage-width scaling is uniform, so this file's SVG-UNIT
  // boxes are the same at 1600px, 1700px (the value `CAPTION_SAFE_ASCENT` was measured against),
  // or any other width — there is no separate "render at 1600px" step to simulate here.
  const lanesMax = CHECKPOINT_DRAW_CAP + 1;
  const { state } = run(events, lanesMax);
  const html = markup(state, { config, lanesMax });

  // Same regex-based extraction the round 5 gate-cluster test above already uses for the
  // Review caption, generalized to every `hero-node-caption` element the stage draws (planning
  // trio + lanes + Review + reflection pair) — `text-anchor` is captured too since PLANNING/lane
  // captions render with no `text-anchor` attribute (SVG default "start", `x` = left edge) while
  // Review/reflection render `text-anchor="middle"` (`x` = center) — `captionSafeTextBox`'s
  // `anchor` param needs the right one or its horizontal box is wrong.
  const captionRe =
    /<text class="[^"]*hero-node-caption[^"]*" x="(-?[\d.]+)" y="(-?[\d.]+)"(?: text-anchor="(middle|end)")?>([^<]*)<\/text>/g;
  const captionBoxes: { label: string; box: Box }[] = [];
  for (const [, xRaw, yRaw, anchorRaw, text] of html.matchAll(captionRe)) {
    const anchor = anchorRaw === "middle" ? "middle" : "start";
    captionBoxes.push({
      label: `caption "${text}" @ (${xRaw},${yRaw})`,
      box: captionSafeTextBox(text as string, Number(xRaw), Number(yRaw), CAPTION_FONT_PX, anchor),
    });
  }
  // Sanity: the fixture must actually exercise every caption zone, or this test silently checks
  // fewer pairs than it claims to (planning×3 + lanes×lanesMax + CI×1 + Review×1 + reflection×2).
  // #922 AC7: CI now always carries a caption too (the constant "github" word), unlike before
  // where it had no caption slot at all.
  assert.equal(
    captionBoxes.length,
    3 + lanesMax + 1 + 1 + 2,
    `fixture must mount every hero-node-caption zone (planning×3, lanes×${lanesMax}, CI×1, Review×1, reflection×2)`,
  );

  // #808 gate② finding [0] (run a343c343): parse every RENDERED `hero-droplet` group's own
  // transform + label text straight from `html`, never reconstruct from `state.droplets` —
  // reconstructing from state (via `dropletPoint`/a hand-copied label formula) proves nothing
  // about what actually drew, and silently asserted against 2 droplets `withVisibleLanes` had
  // already dropped from the markup entirely (see the event-ordering comment above).
  const dropletRe =
    /<g class="hero-droplet" data-issue="(\d+)" data-at="([a-z-]+)"[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)">([\s\S]*?)<\/g>/g;
  const dropletBoxes: { label: string; box: Box }[] = [];
  for (const [, issue, at, xRaw, yRaw, inner] of html.matchAll(dropletRe)) {
    // #922 AC2: the number now renders INSIDE the shape — a dynamic y and a FIXED
    // inline font-size (`DROPLET_NUM_FONT_PX`, never shrunk), never a fixed y="-14" above
    // the shape at a fixed 10px.
    const labelMatch = (inner ?? "").match(
      /<text class="hero-num hero-droplet-num" x="0" y="(-?[\d.]+)" text-anchor="middle" style="font-size:([\d.]+)px">([^<]*)<\/text>/,
    );
    assert.ok(labelMatch, `droplet #${issue} (at=${at}) must render its own chip label`);
    const [, labelYRaw, fontPxRaw, text] = labelMatch as unknown as [string, string, string, string];
    dropletBoxes.push({
      label: `droplet #${issue} ("${text}", at=${at}) @ (${xRaw},${yRaw})`,
      box: captionSafeTextBox(text, Number(xRaw), Number(yRaw) + Number(labelYRaw), Number(fontPxRaw)),
    });
  }
  // Sanity: the fixture must actually RENDER every droplet state under test —
  // checkpoint×CHECKPOINT_DRAW_CAP + needs-human + trunk + handed-off backlog + plain lane +
  // fixing lane — or this test silently checks fewer pairs than it claims to (the exact failure
  // mode the finding caught: more states folded than actually drawn, under the ORIGINAL event
  // order above).
  assert.equal(
    dropletBoxes.length,
    CHECKPOINT_DRAW_CAP + 5,
    "fixture must RENDER every droplet state under test, not just fold it into state.droplets",
  );

  // Cross-product only, same as the round 5 test above — captions/droplets overlapping their
  // OWN zone furniture is out of #808's scope (#745/#728/#744 already cover those pairs); what
  // must never overlap is a droplet chip label against a caption from a DIFFERENT zone.
  for (const d of dropletBoxes) {
    for (const c of captionBoxes) {
      assert.ok(!boxesOverlap(d.box, c.box), `${d.label} ${JSON.stringify(d.box)} overlaps ${c.label} ${JSON.stringify(c.box)}`);
    }
  }
});

// ── #808 gate② finding [0]: escalate never tweens through the caption — a trajectory-level pin ──
//
// No y-margin bump can close the escalate-transit crossing (see `CHECKPOINT_BASE_OFFSET`'s own
// doc in stage.tsx) — checkpoint and needs-human share an x column with the Review caption, and
// there is no safe detour corridor (LANES content on the left, the trunk rings/Review rect boxing
// in the right). The actual fix is architectural: `Hero.tsx`'s `escalate` case renders the
// droplet at exactly its settled checkpoint/needs-human points and NEVER at anything interpolated
// between them (`fadeAcross`, an opacity cross-fade with a `utils.set` snap at the midpoint, not a
// `travelOn` translate tween) — so there is no in-between frame left for a live probe to catch
// crossing the caption. This can't be proven by rendering (no DOM/anime.js harness here, and
// Hero.tsx's own DOM-querying half is established as untestable in this suite —
// `animator.test.ts`'s own doc), so it pins the SOURCE structure instead: the `escalate` case
// must route through `fadeAcross`, and `fadeAcross` itself must never build a continuous
// translateX/Y tween array — the same "read the real declaration, don't hand-copy it" discipline
// `cssFontSizePx` already uses for `heroCss`, applied to `Hero.tsx`.
test("#808 gate② finding [0]: the escalate transition never tweens through an interpolated point — fadeAcross snaps, it doesn't travel", () => {
  const heroTsx = readFileSync(new URL("./Hero.tsx", import.meta.url), "utf8");

  const escalateCaseMatch = heroTsx.match(/case "escalate": \{([\s\S]*?)\n {6}\}/);
  assert.ok(escalateCaseMatch, "Hero.tsx must still define an `escalate` transition case");
  const escalateBody = escalateCaseMatch?.[1] as string;
  assert.match(escalateBody, /fadeAcross\(/, "escalate must route through fadeAcross, not a straight-line travel");
  assert.doesNotMatch(escalateBody, /travelOn\(/, "escalate must not fall back to travelOn's straight-line tween");

  const fadeAcrossMatch = heroTsx.match(/function fadeAcross\([\s\S]*?\n\}/);
  assert.ok(fadeAcrossMatch, "Hero.tsx must define fadeAcross");
  const fadeAcrossBody = fadeAcrossMatch?.[0] as string;
  // A continuous tween looks like `translateX: [a, b]` (an anime.js keyframe array) — fadeAcross
  // must only ever assign translateX/Y as single discrete values via `utils.set`, one at `from`
  // (synchronous, before the timeline plays) and one at `to` (via `tl.call`, at the fade's
  // midpoint) — never an array a tween would interpolate through.
  assert.doesNotMatch(fadeAcrossBody, /translateX:\s*\[/, "fadeAcross must never tween translateX through an array of values");
  assert.doesNotMatch(fadeAcrossBody, /translateY:\s*\[/, "fadeAcross must never tween translateY through an array of values");
  assert.match(fadeAcrossBody, /utils\.set\(el,\s*\{\s*translateX:\s*from\.x/, "fadeAcross must snap straight to `from` first");
  assert.match(
    fadeAcrossBody,
    /utils\.set\(el,\s*\{\s*translateX:\s*to\.x/,
    "fadeAcross must snap straight to `to` at the midpoint, not tween there",
  );
});

// ── #745 gate② round 4 finding [0]: checkpoint zone overflow bound — never above-viewBox growth ──

test("#745 gate② round 4 finding [0]: 39 simultaneous checkpoint droplets — the reported scale — draws only the grid's documented capacity plus a correct '+N more' badge, all within the stage bounds", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 39; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: 1000 + i }));
  }
  const { state } = run(events, 39);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 39, "the fixture must actually produce 39 simultaneous checkpoint droplets — the reported scale");

  const html = markup(state);
  const drawnChips = [...html.matchAll(/class="hero-droplet" data-issue="(\d+)" data-at="checkpoint"/g)].map((m) => Number(m[1]));
  // One row short of the grid's own row capacity — the badge takes the whole last row to itself
  // rather than sharing it with a real chip (label-width collision; see stage.tsx's
  // `CHECKPOINT_OVERFLOW_REAL_CAP` doc). Read from source, not a hand-copied literal.
  assert.equal(
    drawnChips.length,
    CHECKPOINT_OVERFLOW_REAL_CAP,
    `expected ${CHECKPOINT_OVERFLOW_REAL_CAP} real chips drawn (one row reserved for the badge), got ${drawnChips.length}`,
  );

  const expectedOverflow = 39 - CHECKPOINT_OVERFLOW_REAL_CAP;
  const badgeMatch = html.match(/class="hero-checkpoint-overflow" data-count="(\d+)"/);
  assert.ok(badgeMatch, "the overflow badge must render");
  assert.equal(
    Number(badgeMatch?.[1]),
    expectedOverflow,
    `the badge must read the true remainder: 39 total - ${CHECKPOINT_OVERFLOW_REAL_CAP} drawn`,
  );
  assert.match(html, new RegExp(`\\+${expectedOverflow} more`));

  // Every DRAWN element — the real chips AND the badge — must have its real rendered bbox fully
  // inside the viewBox, AND none may collide with each other (the badge sharing no row with a
  // real chip's label is exactly what this checks). gate② finding [0]: each chip's REAL rendered
  // path bbox (`dropletPathBBox`), not a circleBox derived by re-calling `dropletRadius`.
  const droplets = renderedDroplets(html);
  assert.equal(droplets.length, CHECKPOINT_OVERFLOW_REAL_CAP, "every drawn checkpoint chip must actually render with its own path/number");
  const boxes: { label: string; box: Box }[] = [];
  for (const d of droplets) {
    const pathBox = dropletPathBBox(d.path);
    boxes.push({
      label: `checkpoint #${d.issue} circle`,
      box: { left: d.x + pathBox.left, right: d.x + pathBox.right, top: d.y + pathBox.top, bottom: d.y + pathBox.bottom },
    });
  }
  const badgePoint = checkpointOverflowPoint();
  boxes.push({ label: "overflow badge", box: textBox(`+${expectedOverflow} more`, badgePoint.x, badgePoint.y - 14, 10) });
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

test("#745 gate② round 4 finding [0] secondary regression: a departed checkpoint droplet's origin for a later ring/escalate transition is the point it was ACTUALLY drawn at, not rank 0", () => {
  const { state: afterCheckpoints } = run(
    [
      ev("dispatched", { worker: "w1", issue: 1 }),
      ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
      ev("dispatched", { worker: "w2", issue: 2 }),
      ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING", pr: 12 }),
      ev("dispatched", { worker: "w3", issue: 3 }),
      ev("reclaim-done", { worker: "w3", issue: 3, next: "DRIVING", pr: 13 }),
    ],
    3,
  );
  const d3AtCheckpoint = droplet(afterCheckpoints, 3);
  assert.ok(d3AtCheckpoint && d3AtCheckpoint.at === "checkpoint");
  assert.equal(d3AtCheckpoint.checkpointRank, 2, "the fixture must actually put issue 3 at rank 2 (the 3rd checkpoint arrival)");
  // The ground truth: where issue 3 was ACTUALLY drawn while genuinely at checkpoint.
  const drawnAt = dropletPoint(afterCheckpoints, d3AtCheckpoint);

  // Issue 3 escalates — `fix-rounds-capped` moves it OFF checkpoint onto needs-human, with no
  // prior rendered position for `buildPlayback` to fall back to (fresh `Map()` — see
  // playback.ts), forcing the checkpoint-origin lookup this regression affects.
  const { state: escalated } = foldEvents(afterCheckpoints, [ev("fix-rounds-capped", { worker: "w3", issue: 3, pr: 13 })]);
  const d3Escalated = droplet(escalated, 3);
  assert.ok(d3Escalated && d3Escalated.at === "needs-human");
  assert.equal(d3Escalated.checkpointRank, 2, "the frozen rank must survive the move off checkpoint");

  const origin = dropletPoint(escalated, d3Escalated, "checkpoint");
  assert.deepEqual(
    origin,
    drawnAt,
    "a departed droplet's checkpoint ORIGIN must equal the point it was actually drawn at, never a re-derived (and now-missing) rank",
  );

  const rank0Point = dropletPoint(afterCheckpoints, droplet(afterCheckpoints, 1) as Droplet); // issue 1 is genuinely rank 0
  assert.notDeepEqual(origin, rank0Point, "must NOT silently fall back to rank 0 just because issue 3 is no longer AT checkpoint");
});

// ── #744: lane status phrase / PR chip overlap (same defect family as #728, on the lane track) ──

test("#744: on a fixing track, the lane status phrase and the droplet's PR chip never overlap, by actual rendered extent", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 739 }),
    ev("drive-fixup", {
      worker: "w1",
      issue: 86,
      pr: 739,
      fixRounds: 2,
      reason: "gate:FIXABLE:REQUEST_CHANGES:unresolvedThreads=2:ciRed=false",
    }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 739, fixRounds: 2 }),
  ]);
  assert.equal(state.lanes[0]?.phase, "fixing");
  assert.equal(state.lanes[0]?.fixRound, 2);
  const d = droplet(state, 86);
  assert.equal(d?.pr, 739);

  const html = markup(state, { fixCap: 4 });
  // The exact phrase the probe screenshotted colliding with "⤳ 739".
  const statusMatch = html.match(/<text class="hero-num hero-small" x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="end">(FIXING[^<]*)<\/text>/);
  assert.ok(statusMatch, "lane status phrase must render");
  const [, statusXRaw, statusYRaw, statusText] = statusMatch as unknown as [string, string, string, string];
  assert.match(statusText, /FIXING · round 2 of 4 · review findings/);

  const p = dropletPoint(state, d!);
  // #922 AC2: the kind mark and the number are two sibling elements — check the droplet's
  // own number directly.
  assert.deepEqual(dropletKindAndNumber(html, 86), { kind: "⤳", number: "739" });

  // text-anchor="end" means the captured x is the RIGHT edge, not the center textBox expects.
  const statusWidth = statusText.length * 10 * CHAR_ADVANCE;
  const statusCenterX = Number(statusXRaw) - statusWidth / 2;

  assertNoOverlap([
    { label: "lane status phrase", box: textBox(statusText, statusCenterX, Number(statusYRaw), 10) },
    { label: "PR chip", box: textBox("⤳ 739", p.x, p.y - 14, 10) },
  ]);
});

// ── #891: hero tally/aria share the strip's own `foldOpenAttention`, droplet bounding, aria
// scope split ── every test below runs through the REAL production entry point per the issue's
// own verification plan: a wire `LoopEvent` → `toDomainEvent` → `foldOpenAttention`, never a
// hand-built `openAttention` array — the same discipline `NeedsAttention.test.tsx` already
// established for the strip side of this same fold.

let wireSeq = 0;
function wire(ts: string, kind: string, payload: Record<string, unknown> | null): LoopEvent {
  return { id: ++wireSeq, ts, kind, payload };
}
const foldAttention = (events: LoopEvent[]) => foldOpenAttention(events.map(toDomainEvent));

test("#891 AC2 (fold-sharing, mutation-kill): an escalation resolved WITHOUT redispatch vanishes from the hero tally/aria — proving they read the shared fold, not the hero's own stale droplet count", () => {
  const events = [
    wire("2026-08-10T11:00:00.000Z", "dispatched", { worker: "w1", issue: 86 }),
    wire("2026-08-10T11:01:00.000Z", "reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    wire("2026-08-10T11:02:00.000Z", "drive-needs-human", { worker: "w1", issue: 86, pr: 97 }),
    // Resolved by something OTHER than a fresh dispatch/merge (§3) — the hero's OWN droplet fold
    // (state.ts) has no case for this kind at all, so `state.droplets` still shows the droplet
    // parked at "needs-human" forever. Only `foldOpenAttention` (entities.ts) actually clears it.
    wire("2026-08-10T11:05:00.000Z", "escalation-resolved", { source: "drive-needs-human", issue: 86, via: "board-fixed" }),
  ];
  const { state } = run(events.map(toDomainEvent));
  assert.equal(state.droplets.find((d) => d.issue === 86)?.at, "needs-human", "the hero's own fold never learns this resolved");
  assert.equal(state.roundEscalated, 1);

  const open = foldAttention(events);
  assert.deepEqual(Object.keys(open), [], "the shared fold IS empty — this is the divergence the mutation would miss");

  const html = markup(state, { openAttention: Object.values(open) });
  assert.match(html, /0 needs human/, "outcome tally must read the shared (empty) fold, not the stale droplet count (would read 1)");
  assert.match(html, /0 items currently waiting on a person/, "aria-label must read the same shared fold");
});

test("#891 AC4: the hero aria-label names the all-time scope and the this-round scope in separate clauses", () => {
  const events = [
    wire("2026-08-10T11:00:00.000Z", "dispatched", { worker: "w1", issue: 1 }),
    wire("2026-08-10T11:01:00.000Z", "reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 1 }),
    wire("2026-08-10T11:02:00.000Z", "merged", { worker: "w1", issue: 1, pr: 1 }),
    wire("2026-08-10T11:03:00.000Z", "dispatched", { worker: "w1", issue: 2 }),
    wire("2026-08-10T11:04:00.000Z", "reclaim-done", { worker: "w1", issue: 2, next: "DRIVING", pr: 2 }),
    wire("2026-08-10T11:05:00.000Z", "drive-needs-human", { worker: "w1", issue: 2, pr: 2 }),
  ];
  const { state } = run(events.map(toDomainEvent));
  const open = foldAttention(events);
  const html = markup(state, { openAttention: Object.values(open) });

  // Two DISTINCT clauses, never one mixed together — the #891 gap was exactly this conflation.
  assert.match(html, /1 merged pull request all-time\./);
  assert.match(html, /This round: 1 merged\./);
  assert.match(html, /1 item currently waiting on a person\./);
});

test("#891 AC1: needs-human droplets bound to the open round + a draw cap; historical/overflow droplets collapse into ONE counter chip, never piling up unbounded", () => {
  const events: LoopEvent[] = [];
  // Round 1: one escalation that's never resolved AND never touched again (a real "weeks-old
  // escalated droplet, still parked" per the issue's own failure description) plus a
  // handed-off droplet nobody ever redispatched (the issue's OTHER named failure: a stale
  // "saved for a successor" badge sitting in the backlog zone).
  events.push(wire("2026-07-01T00:00:00.000Z", "pool-selected", { round_id: 1, issues: [1, 50] }));
  events.push(wire("2026-07-01T00:01:00.000Z", "dispatched", { worker: "w1", issue: 1 }));
  events.push(wire("2026-07-01T00:02:00.000Z", "reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 1 }));
  events.push(wire("2026-07-01T00:03:00.000Z", "drive-needs-human", { worker: "w1", issue: 1, pr: 1 }));
  events.push(wire("2026-07-01T00:04:00.000Z", "dispatched", { worker: "w2", issue: 50 }));
  events.push(wire("2026-07-01T00:05:00.000Z", "handoff", { worker: "w2", issue: 50 }));

  // Round 2, the OPEN round: 7 fresh escalations — one more than NEEDS_HUMAN_DRAW_CAP (6).
  events.push(wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }));
  for (let i = 101; i <= 107; i++) {
    events.push(wire("2026-08-10T00:01:00.000Z", "dispatched", { worker: `w${i}`, issue: i }));
    events.push(wire("2026-08-10T00:02:00.000Z", "reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: i }));
    events.push(wire("2026-08-10T00:03:00.000Z", "drive-needs-human", { worker: `w${i}`, issue: i, pr: i }));
  }

  const { state } = run(events.map(toDomainEvent), 43);
  const open = foldAttention(events);
  // Nothing has resolved — the shared fold still names all 8 escalations open (issue 1 + 101..107).
  assert.equal(Object.keys(open).length, 8);

  const html = markup(state, { lanesMax: 43, openAttention: Object.values(open) });

  // Only 6 (the verified-safe draw cap) of the 7 CURRENT-round escalations draw — the round-1
  // one (issue 1) never draws at all, it's historical from the first render.
  assert.match(html, /data-node="needs-human" data-count="6"/);
  assert.equal(dropletKindAndNumber(html, 1), null, "the round-1 (historical) escalated droplet must not draw");
  assert.doesNotMatch(html, /saved for a successor/, "the round-1 (historical) handoff badge must not draw");

  // Collapsed = 1 historical needs-human (issue 1) + 1 current-round overflow (issue 107, the
  // 7th by arrival order) + 1 historical backlog (issue 50) = 3.
  const badgeMatch = html.match(/class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="(\d+)"/);
  assert.ok(badgeMatch, "the collapsed counter chip must render");
  assert.equal(badgeMatch?.[1], "3");
  assert.match(html, /\+3 earlier — see strip/);

  // The tally/aria text itself still reports the HONEST total (8) — bounding is a STAGE drawing
  // concern only, never a smaller/wrong count (#891 AC2).
  assert.match(html, /8 needs human/);
});

/** Extracts a drawn droplet's `transform="translate(x y)"` by its `data-issue`, straight from
 *  the rendered markup — the actual DOM position, not a re-derivation of it. */
function dropletTransform(html: string, issue: number): { x: number; y: number } {
  const match = html.match(new RegExp(`data-issue="${issue}"[^>]*transform="translate\\(([-\\d.]+) ([-\\d.]+)\\)"`));
  assert.ok(match, `droplet #${issue} must be drawn`);
  return { x: Number(match![1]), y: Number(match![2]) };
}

test("#891 gate① engine-agent finding [0] (ac1-hidden-ranks-not-compacted): a drawn needs-human droplet's rank COMPACTS around hidden historical predecessors, never inheriting a rank/position from an entity that never draws", () => {
  const events: LoopEvent[] = [];
  // Two historical (round 1) escalations — never resolved, never touched again — arriving
  // BEFORE the current-round ones in arrival order, exactly the shape that used to push a
  // drawn droplet's rank (and therefore its stage position) two slots further than it should be.
  events.push(wire("2026-07-01T00:00:00.000Z", "pool-selected", { round_id: 1, issues: [1, 2] }));
  for (const issue of [1, 2]) {
    events.push(wire("2026-07-01T00:01:00.000Z", "dispatched", { worker: `h${issue}`, issue }));
    events.push(wire("2026-07-01T00:02:00.000Z", "reclaim-done", { worker: `h${issue}`, issue, next: "DRIVING", pr: issue }));
    events.push(wire("2026-07-01T00:03:00.000Z", "drive-needs-human", { worker: `h${issue}`, issue, pr: issue }));
  }
  // Two current-round (round 2) escalations — the ones that must actually draw.
  events.push(wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }));
  for (const issue of [101, 102]) {
    events.push(wire("2026-08-10T00:01:00.000Z", "dispatched", { worker: `w${issue}`, issue }));
    events.push(wire("2026-08-10T00:02:00.000Z", "reclaim-done", { worker: `w${issue}`, issue, next: "DRIVING", pr: issue }));
    events.push(wire("2026-08-10T00:03:00.000Z", "drive-needs-human", { worker: `w${issue}`, issue, pr: issue }));
  }

  const { state } = run(events.map(toDomainEvent));
  const open = foldAttention(events);
  assert.equal(Object.keys(open).length, 4, "nothing has resolved — all 4 are still open");

  const html = markup(state, { openAttention: Object.values(open) });

  // The expected positions are `dropletPoint`'s OWN formula, evaluated against the compacted
  // collection (the two historical droplets excluded) — exactly what stage.tsx's internal
  // `geometryState` now feeds it. Read from the source, never a hand-copied coordinate.
  const compacted: HeroState = { ...state, droplets: state.droplets.filter((d) => d.issue === 101 || d.issue === 102) };
  const expected101 = dropletPoint(compacted, droplet(compacted, 101)!);
  const expected102 = dropletPoint(compacted, droplet(compacted, 102)!);
  assert.notDeepEqual(expected101, expected102, "sanity check on the fixture itself — the two compacted ranks must be distinct");

  assert.deepEqual(
    dropletTransform(html, 101),
    expected101,
    "issue 101 must draw at the COMPACTED rank 0 — NOT rank 2, as if the 2 hidden historical droplets still occupied ranks ahead of it",
  );
  assert.deepEqual(dropletTransform(html, 102), expected102, "issue 102 must draw at the COMPACTED rank 1, not rank 3");

  const pos101 = dropletTransform(html, 101);
  const pos102 = dropletTransform(html, 102);
  assertNoOverlap([
    { label: "needs-human #101", box: circleBox(pos101.x, pos101.y, dropletRadius("101")) },
    { label: "needs-human #102", box: circleBox(pos102.x, pos102.y, dropletRadius("102")) },
  ]);
});

test("#891 gate① engine-agent finding [0]: a drawn backlog droplet's slot COMPACTS around a hidden historical (never-redispatched) handoff predecessor", () => {
  const events: LoopEvent[] = [
    // Round 1: a handed-off droplet nobody ever redispatches — historical from round 2 on.
    wire("2026-07-01T00:00:00.000Z", "pool-selected", { round_id: 1, issues: [50] }),
    wire("2026-07-01T00:01:00.000Z", "dispatched", { worker: "h50", issue: 50 }),
    wire("2026-07-01T00:02:00.000Z", "handoff", { worker: "h50", issue: 50 }),
    // Round 2, the open round: a fresh dispatch that then hands off too — the one that must
    // actually draw, and draw at the FIRST backlog slot, not the third (after the hidden one's
    // own 3-row handoff-badge reservation).
    wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }),
    wire("2026-08-10T00:01:00.000Z", "dispatched", { worker: "w60", issue: 60 }),
    wire("2026-08-10T00:02:00.000Z", "handoff", { worker: "w60", issue: 60 }),
  ];

  const { state } = run(events.map(toDomainEvent));
  const compacted: HeroState = { ...state, droplets: state.droplets.filter((d) => d.issue === 60) };
  const expected60 = dropletPoint(compacted, droplet(compacted, 60)!);

  const html = markup(state);
  assert.equal(dropletKindAndNumber(html, 50), null, "the round-1 (historical) handoff droplet must not draw");
  assert.deepEqual(
    dropletTransform(html, 60),
    expected60,
    "issue 60 must draw at the FIRST compacted backlog slot, not three rows down as if the hidden historical droplet's own handoff-badge reservation still counted",
  );
});

test("#891 gate① engine-agent finding [0] (ac1-collapsed-chip-overlap): the collapsed counter chip never collides with the staleness caption, the outcome tally, the escalation node's own label, or the needs-human cluster — stressed at the issue's own reported scale", () => {
  const events: LoopEvent[] = [];
  // 42 historical (round 1) escalations — the issue's own reported scale ("+42 more") — plus a
  // large merged count, matching this file's own "#728 gate② [0]" stress-test doctrine: a
  // deliberately inflated fixture, not today's small one.
  events.push(wire("2026-07-01T00:00:00.000Z", "pool-selected", { round_id: 1, issues: [] }));
  for (let i = 1; i <= 42; i++) {
    events.push(wire("2026-07-01T00:01:00.000Z", "dispatched", { worker: `h${i}`, issue: i }));
    events.push(wire("2026-07-01T00:02:00.000Z", "reclaim-done", { worker: `h${i}`, issue: i, next: "DRIVING", pr: i }));
    events.push(wire("2026-07-01T00:03:00.000Z", "drive-needs-human", { worker: `h${i}`, issue: i, pr: i }));
  }
  events.push(wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }));
  for (let i = 1; i <= 24; i++) events.push(wire("2026-08-10T00:01:00.000Z", "merged", { worker: `m${i}`, issue: 1000 + i, pr: 1000 + i }));
  // 6 CURRENT-round escalations — fills the draw cap, the needs-human cluster's own worst case.
  for (let i = 101; i <= 106; i++) {
    events.push(wire("2026-08-10T00:02:00.000Z", "dispatched", { worker: `w${i}`, issue: i }));
    events.push(wire("2026-08-10T00:03:00.000Z", "reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: i }));
    events.push(wire("2026-08-10T00:04:00.000Z", "drive-needs-human", { worker: `w${i}`, issue: i, pr: i }));
  }

  const { state } = run(events.map(toDomainEvent), 43);
  const open = foldAttention(events);
  assert.equal(Object.keys(open).length, 48, "42 historical + 6 current-round escalations, nothing resolved");

  const html = markup(state, {
    lanesMax: 43,
    openAttention: Object.values(open),
    // A large elapsed time — the staleness caption's own worst-case rendered width, the exact
    // neighbor this finding named.
    now: new Date(new Date(state.lastEventTs!).getTime() + 999_999_000),
  });

  const chipMatch = html.match(
    /class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="(\d+)" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</,
  );
  assert.ok(chipMatch, "the collapsed chip must render");
  const [, countRaw, chipXRaw, chipYRaw, chipText] = chipMatch as unknown as [string, string, string, string, string];
  assert.equal(countRaw, "42");
  assert.match(chipText, /\+42 earlier — see strip/);

  const staleMatch = html.match(/class="hero-label hero-staleness" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(staleMatch, "the staleness caption must render");
  const [, staleXRaw, staleYRaw, staleText] = staleMatch as unknown as [string, string, string, string];

  const tallyMatch = html.match(/class="hero-num hero-small hero-outcome-tally" x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)</);
  assert.ok(tallyMatch, "the outcome tally must render");
  const [, tallyXRaw, tallyYRaw, tallyText] = tallyMatch as unknown as [string, string, string, string];

  const boxes: { label: string; box: Box }[] = [
    { label: "collapsed chip", box: textBox(chipText, Number(chipXRaw), Number(chipYRaw), DROPLET_LABEL_FONT_PX) },
    // 9px, matching `.hero-staleness, .hero-outcome-tally`'s shared CSS rule — the same literal
    // this file's own pre-existing outcome-tally collision tests already use.
    { label: "staleness caption", box: textBox(staleText, Number(staleXRaw), Number(staleYRaw), 9) },
    // #920 gate② review thread (PRRT…JE5): centered again — the tally now sits below the whole
    // Summary/Retro row.
    { label: "outcome tally", box: textBox(tallyText, Number(tallyXRaw), Number(tallyYRaw), 9) },
    // #922 AC1: the escalation node's own "Needs human" label moved centred BELOW the circle
    // (was to the right) — the chip's closest neighbor is now below it instead of beside it.
    {
      label: "needs-human node label",
      box: captionSafeTextBox(
        "Needs human",
        ESCALATION.x,
        ESCALATION.y + ESCALATION_R + NODE_LABEL_OFFSET,
        GATE_NODE_LABEL_FONT_PX,
        "middle",
      ),
    },
  ];
  const drawn = state.droplets.filter((d) => d.at === "needs-human" && d.issue >= 101);
  assert.equal(drawn.length, 6, "all 6 current-round escalations must be within the draw cap");
  // #891: `dropletPoint(state, d)` against the raw, UNCOMPACTED `state` (42 historical droplets
  // still ahead of these 6 in array order) computes ranks 42–47, nowhere near where production
  // actually draws — a collision oracle built on that position could never catch a real overlap.
  // `dropletTransform`, reading the `transform="translate(…)"` straight off the RENDERED markup,
  // is what `dropletPoint`'s own compacted-rank tests above already use for exactly this reason:
  // assert against what production drew, not a recomputation that can silently diverge from it.
  for (const d of drawn) {
    const { x, y } = dropletTransform(html, d.issue);
    // #922 AC2: a needs-human droplet carrying a PR reads "PR N" — the shape fits
    // the bare NUMBER only (production's own `dropletNumber`).
    const number = dropletNumberText(d);
    const r = dropletRadius(number);
    // #922 AC2: no separate label box — it's drawn inside the circle, which would self-overlap.
    boxes.push({ label: `needs-human #${d.issue} circle`, box: circleBox(x, y, r) });
  }
  assertNoOverlap(boxes);
});

test("#891 gate① engine-agent finding [1] (ac2-hero-wrapper-unpinned): the REAL <Hero> wrapper — not `HeroStage` rendered directly — forwards `openAttention` through to the rendered tally/aria", () => {
  const events = [
    wire("2026-08-10T11:00:00.000Z", "dispatched", { worker: "w1", issue: 86 }),
    wire("2026-08-10T11:01:00.000Z", "reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    wire("2026-08-10T11:02:00.000Z", "drive-needs-human", { worker: "w1", issue: 86, pr: 97 }),
    // Resolved WITHOUT redispatch — the hero's own droplet fold never learns this (same
    // mutation-kill shape as the AC2 test above), so the droplet stays "at: needs-human"
    // forever. Only forwarding `openAttention` all the way through `<Hero>` into `HeroStage`
    // makes the rendered count honestly 0.
    wire("2026-08-10T11:05:00.000Z", "escalation-resolved", { source: "drive-needs-human", issue: 86, via: "board-fixed" }),
  ];
  const { state } = run(events.map(toDomainEvent));
  const open = foldAttention(events);
  assert.deepEqual(Object.keys(open), [], "the shared fold is empty");

  // `createElement(Hero, ...)`, never `HeroStage` — this is the whole point of the finding:
  // hero.test.ts's other #891 tests all render `HeroStage` directly, which never exercises
  // `Hero.tsx`'s OWN `openAttention={openAttention}` forward. Removing that one line from
  // Hero.tsx would leave every one of those tests green.
  const html = renderToStaticMarkup(
    createElement(Hero, {
      heroState: state,
      steps: [],
      lanesMax: 3,
      engine: "running",
      fixCap: 2,
      openAttention: Object.values(open),
    }),
  );
  assert.match(
    html,
    /0 needs human/,
    "Hero must forward openAttention through to HeroStage — reverting Hero.tsx's own forward would leave this at 1 (the stale droplet count) instead",
  );
  assert.match(html, /0 items currently waiting on a person/);
});

// #920 AC5: "the hero root sits inside an element carrying `.panel`" — a WIRING claim about
// `Hero.tsx`'s own wrapper, not `HeroStage`'s markup (`HeroStage` draws only the bare `<svg>`).
// Same `createElement(Hero, ...)` posture as the wrapper-forwarding test above, for the same
// reason: `HeroStage` rendered directly would never exercise the wrapper at all.
test("#920 AC5: the REAL <Hero> wrapper draws the stage inside an element carrying .panel", () => {
  const html = renderToStaticMarkup(
    createElement(Hero, { heroState: initialHeroState(3), steps: [], lanesMax: 3, engine: "running", fixCap: 2 }),
  );
  // #924: the `.panel-head` title row (AC1) now sits between the `.panel` wrapper and the `<svg>`
  // — still the SAME wrapper element, `<svg class="hero">` still nested inside it, after the head.
  // #928: `<svg class="hero">` now sits one level deeper, inside its own `.hero-scroll` container
  // (hero.css's scroll boundary for the stage's native 1200px floor) — still a descendant of the
  // same `.panel`, never re-parented outside it.
  assert.match(
    html,
    /<div class="[^"]*\bpanel\b[^"]*">\s*<div class="panel-head">[\s\S]*?<\/div>\s*<div class="hero-scroll">\s*<svg class="hero"/,
    'the rendered <svg class="hero"> must sit inside its own .hero-scroll container, inside the same element carrying the .panel class, after its panel-head',
  );
});

test("#891 gate① engine-agent finding [0] (ac1-null-round-never-collapses): a droplet folded BEFORE the fold ever saw a round boundary (roundId still null) collapses to historical once a LATER round opens — null is not permanently 'current'", () => {
  const events: LoopEvent[] = [
    // No `pool-selected`/`round-phase` yet — this issue's droplet is stamped `roundId: null`,
    // the "no round boundary observed yet" state (`Droplet.roundId`'s own doc), not "this round".
    wire("2026-07-01T00:00:00.000Z", "dispatched", { worker: "h1", issue: 1 }),
    wire("2026-07-01T00:01:00.000Z", "reclaim-done", { worker: "h1", issue: 1, next: "DRIVING", pr: 1 }),
    wire("2026-07-01T00:02:00.000Z", "drive-needs-human", { worker: "h1", issue: 1, pr: 1 }),
    // A round boundary opens WEEKS later — the fold now knows a real round exists, and issue 1's
    // still-null stamp predates it just as surely as an explicit older `roundId` would.
    wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }),
  ];

  const { state } = run(events.map(toDomainEvent));
  assert.equal(
    droplet(state, 1)?.roundId,
    null,
    "sanity check on the fixture: issue 1's droplet was never touched after the round boundary",
  );
  assert.equal(state.roundId, 2);

  const open = foldAttention(events);
  assert.equal(Object.keys(open).length, 1, "issue 1's escalation is still open — nothing has resolved it");

  const html = markup(state, { openAttention: Object.values(open) });
  assert.equal(
    dropletKindAndNumber(html, 1),
    null,
    "a null-stamped droplet from before the first round boundary must NOT draw once a later round is known",
  );
  assert.match(
    html,
    /class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="1"/,
    "it must collapse into the historical counter chip instead",
  );
});

test("#891 PO adjudication: historical classification is ONE round-identity predicate — backlog, lane, checkpoint, needs-human, AND trunk all collapse the same way, no per-zone carve-out left to forget a zone", () => {
  const events: LoopEvent[] = [];
  events.push(wire("2026-07-01T00:00:00.000Z", "pool-selected", { round_id: 1, issues: [] }));
  // One historical (round 1) droplet parked in EVERY zone the stage can draw one at — none of
  // these is ever touched again after this round closes.
  events.push(wire("2026-07-01T00:01:00.000Z", "dispatched", { worker: "h-nh", issue: 1 }));
  events.push(wire("2026-07-01T00:02:00.000Z", "reclaim-done", { worker: "h-nh", issue: 1, next: "DRIVING", pr: 1 }));
  events.push(wire("2026-07-01T00:03:00.000Z", "drive-needs-human", { worker: "h-nh", issue: 1, pr: 1 }));
  events.push(wire("2026-07-01T00:04:00.000Z", "dispatched", { worker: "h-bl", issue: 2 }));
  events.push(wire("2026-07-01T00:05:00.000Z", "handoff", { worker: "h-bl", issue: 2 }));
  events.push(wire("2026-07-01T00:06:00.000Z", "dispatched", { worker: "h-ln", issue: 3 }));
  events.push(wire("2026-07-01T00:07:00.000Z", "dispatched", { worker: "h-cp", issue: 4 }));
  events.push(wire("2026-07-01T00:08:00.000Z", "reclaim-done", { worker: "h-cp", issue: 4, next: "DRIVING", pr: 4 }));
  // The reviewer's own example: `dispatched → reclaim-done → rollback-escalated` leaves a
  // failed droplet parked at `checkpoint` that nothing revisits.
  events.push(wire("2026-07-01T00:09:00.000Z", "rollback-escalated", { worker: "h-cp", issue: 4 }));
  events.push(wire("2026-07-01T00:10:00.000Z", "dispatched", { worker: "h-tr", issue: 5 }));
  events.push(wire("2026-07-01T00:11:00.000Z", "reclaim-done", { worker: "h-tr", issue: 5, next: "DRIVING", pr: 5 }));
  events.push(wire("2026-07-01T00:12:00.000Z", "merged", { worker: "h-tr", issue: 5, pr: 5 }));

  // The round boundary that leaves all five behind.
  events.push(wire("2026-08-10T00:00:00.000Z", "pool-selected", { round_id: 2, issues: [] }));

  // One current-round (round 2) droplet in the same four still-live zones (a fresh merge would
  // itself delete any lingering trunk droplet, historical or not, independent of this predicate
  // — so trunk's OWN collapse is exercised only by issue 5 above, not duplicated here) — every
  // one of these must keep drawing.
  events.push(wire("2026-08-10T00:01:00.000Z", "dispatched", { worker: "c-nh", issue: 101 }));
  events.push(wire("2026-08-10T00:02:00.000Z", "reclaim-done", { worker: "c-nh", issue: 101, next: "DRIVING", pr: 101 }));
  events.push(wire("2026-08-10T00:03:00.000Z", "drive-needs-human", { worker: "c-nh", issue: 101, pr: 101 }));
  events.push(wire("2026-08-10T00:04:00.000Z", "dispatched", { worker: "c-bl", issue: 102 }));
  events.push(wire("2026-08-10T00:05:00.000Z", "handoff", { worker: "c-bl", issue: 102 }));
  events.push(wire("2026-08-10T00:06:00.000Z", "dispatched", { worker: "c-ln", issue: 103 }));
  events.push(wire("2026-08-10T00:07:00.000Z", "dispatched", { worker: "c-cp", issue: 104 }));
  events.push(wire("2026-08-10T00:08:00.000Z", "reclaim-done", { worker: "c-cp", issue: 104, next: "DRIVING", pr: 104 }));

  const { state } = run(events.map(toDomainEvent), 20);
  const open = foldAttention(events);
  // Issue 1, issue 4 (`rollback-escalated` is itself an attention-opening kind — `copy.ts`'s
  // `hasAttention` — independent of this test's round-identity predicate), and issue 101: none
  // of the three has been resolved.
  assert.equal(Object.keys(open).length, 3, "issues 1, 4, and 101 all still have open attention");

  // Sanity check on the fixture itself — otherwise the assertions below would prove nothing.
  for (const issue of [1, 2, 3, 4, 5]) assert.equal(droplet(state, issue)?.roundId, 1, `issue ${issue} fixture must be stamped round 1`);
  for (const issue of [101, 102, 103, 104])
    assert.equal(droplet(state, issue)?.roundId, 2, `issue ${issue} fixture must be stamped round 2`);
  assert.equal(state.roundId, 2);
  assert.equal(droplet(state, 4)?.at, "checkpoint");
  assert.equal(droplet(state, 4)?.failed, true, "the rollback-escalated checkpoint droplet must actually be marked failed");
  assert.equal(droplet(state, 5)?.at, "trunk");

  const html = markup(state, { lanesMax: 20, openAttention: Object.values(open) });

  // None of the five round-1 droplets draw, in ANY zone — proving the SAME predicate, not a
  // per-zone list, is what excludes them. `dropletKindAndNumber` reads the droplet's
  // own `<g data-issue>` directly, since the kind mark and number are two sibling elements.
  assert.equal(dropletKindAndNumber(html, 1), null, "historical needs-human droplet (issue 1) must not draw");
  assert.equal(dropletKindAndNumber(html, 2), null, "historical backlog droplet (issue 2) must not draw");
  assert.equal(dropletKindAndNumber(html, 3), null, "historical lane droplet (issue 3) must not draw");
  assert.equal(
    dropletKindAndNumber(html, 4),
    null,
    "historical checkpoint droplet (issue 4, the reviewer's own dispatched→reclaim-done→rollback-escalated example) must not draw",
  );
  assert.equal(dropletKindAndNumber(html, 5), null, "historical trunk droplet (issue 5) must not draw");

  // Every current-round droplet, in the same four zones, keeps drawing — #922 AC2: needs-human +
  // PR reads "PR N".
  assert.deepEqual(dropletKindAndNumber(html, 101), { kind: "PR", number: "101" }, "current-round needs-human droplet must draw");
  assert.deepEqual(dropletKindAndNumber(html, 102), { kind: "⊙", number: "102" }, "current-round backlog droplet must draw");
  assert.deepEqual(dropletKindAndNumber(html, 103), { kind: "⊙", number: "103" }, "current-round lane droplet must draw");
  assert.deepEqual(dropletKindAndNumber(html, 104), { kind: "⤳", number: "104" }, "current-round checkpoint droplet must draw");

  // Collapsed accounting: all 5 historical droplets, from all 5 zones, land in ONE chip — never
  // scattered per-zone, never silently dropped without being counted anywhere.
  assert.match(html, /class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="5"/);
  assert.match(html, /\+5 earlier — see strip/);
  assert.match(html, /data-node="needs-human" data-count="1"/, "only the one CURRENT-round escalation draws in the needs-human cluster");
});

test("#891: purely historical checkpoint droplets past the checkpoint zone's own draw cap trigger NO zone overflow badge — the single collapsed chip is the only place they're counted", () => {
  const events: DomainEvent[] = [];
  events.push(ev("pool-selected", { round_id: 1 }));
  // 50 historical (round 1) checkpoint droplets — well past CHECKPOINT_DRAW_CAP on their own —
  // never touched again after this round closes.
  for (let i = 1; i <= 50; i++) {
    events.push(ev("dispatched", { worker: `h${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `h${i}`, issue: i, next: "DRIVING", pr: i }));
  }
  // The round boundary that leaves all 50 behind — nothing else happens in round 2.
  events.push(ev("pool-selected", { round_id: 2 }));

  const { state } = run(events, 60);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 50, "sanity check on the fixture: 50 historical checkpoint droplets, none touched since");
  assert.ok(
    checkpointed.every((d) => d.roundId === 1),
    "sanity check: every one of them is stamped to the closed round",
  );

  const html = markup(state, { lanesMax: 60 });

  // The zone's own overflow badge must not render at all — these 50 droplets are entirely
  // historical, so there is no CURRENT-round overflow for it to report.
  assert.doesNotMatch(
    html,
    /class="hero-checkpoint-overflow"/,
    "50 historical checkpoint droplets must never trigger the zone's OWN overflow badge — they belong to the single collapsed chip, not a second, contradictory count",
  );
  // None of the 50 draw individually either.
  const drawnChips = [...html.matchAll(/class="hero-droplet" data-issue="(\d+)" data-at="checkpoint"/g)];
  assert.equal(drawnChips.length, 0, "no historical checkpoint droplet may draw individually");

  // The single collapsed chip is the ONLY place all 50 are counted.
  assert.match(html, /class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="50"/);
  assert.match(html, /\+50 earlier — see strip/);
});

test("#891: a genuine CURRENT-round checkpoint overflow still renders its own zone badge, with a count unaffected by unrelated historical droplets sitting in the same zone", () => {
  const events: DomainEvent[] = [];
  events.push(ev("pool-selected", { round_id: 1 }));
  // 50 historical (round 1) checkpoint droplets, same shape as the no-badge case above — present
  // in the SAME zone, to prove they don't leak into the count below.
  for (let i = 1; i <= 50; i++) {
    events.push(ev("dispatched", { worker: `h${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `h${i}`, issue: i, next: "DRIVING", pr: i }));
  }
  events.push(ev("pool-selected", { round_id: 2 }));
  // 8 CURRENT-round (round 2) checkpoint droplets — a genuine overflow on their own (past
  // CHECKPOINT_DRAW_CAP), independent of the 50 historical ones above.
  for (let i = 101; i <= 108; i++) {
    events.push(ev("dispatched", { worker: `c${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `c${i}`, issue: i, next: "DRIVING", pr: i }));
  }

  const { state } = run(events, 60);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 58, "sanity check on the fixture: 50 historical + 8 current-round checkpoint droplets");
  assert.equal(checkpointed.filter((d) => d.roundId === 1).length, 50, "sanity check: 50 stamped to the closed round");
  assert.equal(checkpointed.filter((d) => d.roundId === 2).length, 8, "sanity check: 8 stamped to the open round");

  const html = markup(state, { lanesMax: 60 });

  // None of the 50 historical droplets draw individually.
  const drawnChips = [...html.matchAll(/class="hero-droplet" data-issue="(\d+)" data-at="checkpoint"/g)].map((m) => Number(m[1]));
  assert.ok(
    drawnChips.every((issue) => issue >= 101),
    `no historical (issue <= 50) checkpoint droplet may draw individually, got ${JSON.stringify(drawnChips)}`,
  );

  // The zone's own badge reports ONLY the 8 current-round droplets' own remainder (8 total -
  // CHECKPOINT_OVERFLOW_REAL_CAP drawn) — never inflated by the 50 historical droplets the
  // collapsed chip already accounts for.
  const expectedBadge = 8 - CHECKPOINT_OVERFLOW_REAL_CAP;
  const badgeMatch = html.match(/class="hero-checkpoint-overflow" data-count="(\d+)"/);
  assert.ok(badgeMatch, "a genuine CURRENT-round overflow must still render its own badge");
  assert.equal(
    Number(badgeMatch?.[1]),
    expectedBadge,
    "the badge must count only the 8 current-round droplets' own remainder, never the 50 historical ones too",
  );
  assert.match(html, new RegExp(`\\+${expectedBadge} more`));

  // The single collapsed chip is the ONLY place the 50 historical droplets are counted.
  assert.match(html, /class="hero-num hero-small hero-badge hero-attention-collapsed" data-count="50"/);
  assert.match(html, /\+50 earlier — see strip/);
});
