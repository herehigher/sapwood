import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DomainEvent } from "../domain-event.ts";
import { LEGEND_ITEMS, Legend } from "./Legend.tsx";
import { BACKLOG, checkpointOverflowPoint, dropletPoint, GATES, HeroStage, STAGE, TRUNK } from "./stage.tsx";
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

/** Fold a script from a fresh stage; the tests assert on both halves of the result. */
const run = (events: DomainEvent[], lanesMax: number | null = 3) => foldEvents(initialHeroState(lanesMax), events);

const kinds = (ts: Transition[]) => ts.map((t) => t.kind);
const droplet = (state: HeroState, issue: number) => state.droplets.find((d) => d.issue === issue);
// `lanesMax: 3` matches `run()`'s own default — every call site whose state was built with a
// different lanesMax passes it explicitly via `extra` (`withVisibleLanes` only ever CAPS from
// above, so a state with fewer lanes than the default is unaffected either way).
const markup = (state: HeroState, extra: Partial<Parameters<typeof HeroStage>[0]> = {}) =>
  renderToStaticMarkup(createElement(HeroStage, { state, lanesMax: 3, fixCap: 2, ...extra }));
const heroCss = readFileSync(new URL("./hero.css", import.meta.url), "utf8");

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
  assert.match(markup(state), /data-issue="86"[^>]*>.*?⊙ 86/s);

  const tagged = withLanePrs(state, [{ lane: "w1", pr: 97 }]);
  assert.equal(droplet(tagged, 86)?.pr, 97);
  assert.match(markup(tagged), /⤳ 97/);

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
  assert.match(fixingHtml, /<textPath[^>]*href="#hero-fixloop-path"[^>]*>merge conflict<\/textPath>/);

  // The fix loop ends — the lane merges straight out of `fixing` — and folding that event
  // must fold the arc itself away, not just its label.
  const folded = foldEvents(fixing.state, [ev("merged", { worker: "w1", issue: 86, pr: 97 })]);
  const foldedHtml = markup(folded.state);
  assert.doesNotMatch(foldedHtml, /<path id="hero-fixloop-path"/);
  assert.doesNotMatch(foldedHtml, /<textPath/);
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

test("#716 gate② round 2 P2-5: the fix-return arrow carries the send-back reason as a textPath label, not only the lane caption", () => {
  const { state } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
    ev("drive-fixup", { worker: "w1", issue: 86, pr: 97, fixRounds: 1, reason: "gate:FIXABLE:merge-conflict" }),
    ev("fix-leg-started", { worker: "w1", issue: 86, pr: 97, fixRounds: 1 }),
  ]);
  const html = markup(state);
  assert.match(html, /<path id="hero-fixloop-path"/);
  assert.match(html, /<textPath[^>]*href="#hero-fixloop-path"[^>]*>merge conflict<\/textPath>/);

  // No fixing lane at all — no label on the arrow.
  assert.doesNotMatch(markup(initialHeroState(3)), /<textPath/);
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

test("§6 `handoff`: droplet folds back into the backlog with a progress badge", () => {
  const { state, transitions } = run([ev("dispatched", { worker: "w1", issue: 86 }), ev("handoff", { worker: "w1", issue: 86 })]);

  assert.deepEqual(kinds(transitions), ["dispatch", "handoff"]);
  assert.equal(droplet(state, 86)?.at, "backlog");
  assert.equal(droplet(state, 86)?.handedOff, true);
  assert.equal(state.lanes[0]?.phase, "idle");
  assert.match(markup(state), /saved for a successor/);
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

test("the backlog's selected chips read their fill from --sap, never a hardcoded hex", () => {
  const { state } = run([ev("pool-selected", { issues: [86] })]);
  const html = markup(state);
  assert.match(html, /class="hero-pool-chip"[\s\S]*?style="fill:var\(--sap\)"/);
});

test("a lane droplet in motion reads its fill from --sap; escalated/failed from --rust; merged from --moss", () => {
  const inMotion = run([ev("dispatched", { worker: "w1", issue: 1 })]);
  assert.match(markup(inMotion.state), /data-issue="1"[\s\S]*?<circle r="9" style="fill:var\(--sap\)"/);

  const escalated = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING" }),
    ev("drive-needs-human", { worker: "w1", issue: 1 }),
  ]);
  assert.match(markup(escalated.state), /data-issue="1"[\s\S]*?<circle r="9" style="fill:var\(--rust\)"/);

  const merged = run([ev("dispatched", { worker: "w1", issue: 1 }), ev("merged", { worker: "w1", issue: 1, pr: 11 })]);
  assert.match(markup(merged.state), /data-issue="1"[\s\S]*?<circle r="9" style="fill:var\(--moss\)"/);
});

test("the escalation branch and NEEDS HUMAN node read their stroke from --rust, never a hardcoded hex", () => {
  const html = markup(initialHeroState(3));
  assert.match(html, /style="stroke:var\(--rust\)" class="hero-branch"/);
  assert.match(html, /<circle style="stroke:var\(--rust\)"[^>]*><\/circle><text[^>]*>Needs human/);
  // No hardcoded rust hex sneaks in either theme's failure colour.
  assert.doesNotMatch(html, /#D9713F|#A34620|#C05A2E/i);
});

test("the merged event's checkpoint flash and the new growth ring use --moss, never a hardcoded hex", () => {
  // The flash is an imperative anime.js class toggle (`.is-merged`), so its token binding is
  // asserted against the stylesheet that drives it, tied to the class the rendered gate carries.
  assert.match(markup(initialHeroState(3)), /class="hero-gate"/);
  assert.match(heroCss, /\.hero-gate\.is-merged rect\s*\{[^}]*stroke:\s*var\(--moss\)/);

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
  assert.match(html, /class="hero-ring-count" style="font-family:var\(--font-display\)"/);
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

test("P2-8: LLM-backed stage nodes render their configured model·effort caption; REVIEW shows the review mode word", () => {
  const config = {
    roles: { po: { model: "opus", effort: "high" }, harvest: { model: "sonnet", effort: "low" } },
    worker: { model: "sonnet", effort: "medium" },
    reviewer: { mode: "engine-agent" },
  };
  const html = markup(initialHeroState(3), { config });
  assert.match(html, /opus · high/); // Goal & align (roles.po)
  assert.match(html, /sonnet · low/); // Summary (roles.harvest)
  assert.match(html, /sonnet · medium/); // lanes (worker.*)
  assert.match(html, /engine-agent/); // REVIEW's mode word, not a model·effort pair

  // No config, no caption — an honest gap, never a guessed model name.
  const bare = markup(initialHeroState(3));
  assert.doesNotMatch(bare, /opus|sonnet|engine-agent/);
});

// ── "?" legend toggle ──────────────────────────────────────────────────────────

test("the legend exposes all three metaphor keys — droplet, lane, ring — and role vocabulary lives only here", () => {
  assert.equal(LEGEND_ITEMS.length, 3);
  const html = renderToStaticMarkup(createElement(Legend));

  assert.match(html, /<details class="hero-legend">/);
  assert.match(html, /<summary[^>]*>\?<\/summary>/);
  assert.match(html, /droplet = an issue moving through the loop/);
  assert.match(html, /lane = one autonomous worker/);
  assert.match(html, /ring = one merged PR/);
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
    { label: "outcome tally", box: textBox(tallyText, Number(tallyXRaw), Number(tallyYRaw), 9) },
    // Only the OUTERMOST drawn ring — concentric rings sharing one center are, by design,
    // always nested/touching each other (that's the trunk cross-section, not a collision); the
    // outermost one is simply the single furthest-reaching edge the escalation cluster/tally
    // could actually run into, and the only ring box worth checking against them.
    { label: "outermost trunk ring", box: circleBox(TRUNK.x, TRUNK.y, Math.min(state.rings, TRUNK.max) * TRUNK.step) },
  ];
  for (const d of escalated) {
    const { x, y } = dropletPoint(state, d);
    const label = d.pr === null ? `⊙ ${d.issue}` : `⤳ ${d.pr}`;
    boxes.push({ label: `needs-human #${d.issue} circle`, box: circleBox(x, y, 9) });
    boxes.push({ label: `needs-human #${d.issue} label`, box: textBox(label, x, y - 14, 10) });
  }
  assertNoOverlap(boxes);

  assert.match(html, /data-node="needs-human" data-count="6"/);
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

  const boxes: { label: string; box: Box }[] = [
    { label: "checkpoint #1 circle", box: circleBox(p1.x, p1.y, 9) },
    { label: "checkpoint #1 label", box: textBox("⤳ 11", p1.x, p1.y - 14, 10) },
    { label: "checkpoint #2 circle", box: circleBox(p2.x, p2.y, 9) },
    { label: "checkpoint #2 label", box: textBox("⤳ 12", p2.x, p2.y - 14, 10) },
  ];
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

test("#745 AC2: six simultaneous checkpoint droplets — CHECKPOINT_COLS/STEP's own documented verified-safe ceiling — stay collision-free and within stage bounds", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 6; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const { state } = run(events, 6);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 6);

  const boxes: { label: string; box: Box }[] = [];
  for (const d of checkpointed) {
    const { x, y } = dropletPoint(state, d);
    boxes.push({ label: `checkpoint #${d.issue} circle`, box: circleBox(x, y, 9) });
    boxes.push({ label: `checkpoint #${d.issue} label`, box: textBox(`⤳ ${d.pr}`, x, y - 14, 10) });
  }
  assertNoOverlap(boxes);
  for (const { label, box } of boxes) {
    assert.ok(box.left >= 0 && box.right <= STAGE.w, `${label} left=${box.left} right=${box.right} lies outside [0, ${STAGE.w}]`);
    assert.ok(box.top >= 0 && box.bottom <= STAGE.h, `${label} top=${box.top} bottom=${box.bottom} lies outside [0, ${STAGE.h}]`);
  }
});

// #745 gate② round 5 PO pre-merge Tier-C probe (1700px, live DB): a drawn checkpoint chip's
// label bbox-intersected the Review gate's own "engine-agent" mode caption — the same defect
// family as #728/#744 (real rendered extent, not anchor-point spacing). Checked at every rank up
// to `CHECKPOINT_DRAW_CAP - 1` (the pre-overflow ceiling) against the FULL CI/Review gate
// cluster: both rects, both node labels, and the Review caption (rendered with `reviewer.mode`
// set, the exact live shape — the caption doesn't even mount without it).
test("#745 gate② round 5 PO pre-merge Tier-C probe: no checkpoint chip, at any rank up to the grid's capacity, intersects the CI/Review gate cluster (rect, label, or mode caption)", () => {
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 6; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-done", { worker: `w${i}`, issue: i, next: "DRIVING", pr: 100 + i }));
  }
  const { state } = run(events, 6);
  const checkpointed = state.droplets.filter((d) => d.at === "checkpoint");
  assert.equal(checkpointed.length, 6, "exercise every rank up to CHECKPOINT_DRAW_CAP - 1 (0..5)");

  const html = markup(state, { config: { reviewer: { mode: "engine-agent" } } });
  const captionMatch = html.match(/class="hero-node-caption" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">engine-agent</);
  assert.ok(captionMatch, "the fixture must actually mount the Review gate's mode caption (the live shape under test)");
  const [, capXRaw, capYRaw] = captionMatch as unknown as [string, string, string];

  const gateBoxes: { label: string; box: Box }[] = [
    { label: "CI gate rect", box: { left: GATES.ci - 34, right: GATES.ci + 34, top: GATES.y - 20, bottom: GATES.y + 20 } },
    { label: "CI gate label", box: textBox("CI", GATES.ci, GATES.y + 5, 12) },
    { label: "Review gate rect", box: { left: GATES.review - 42, right: GATES.review + 42, top: GATES.y - 20, bottom: GATES.y + 20 } },
    { label: "Review gate label", box: textBox("Review", GATES.review, GATES.y + 5, 12) },
    { label: "Review gate mode caption (engine-agent)", box: textBox("engine-agent", Number(capXRaw), Number(capYRaw), 9) },
  ];

  const checkpointBoxes: { label: string; box: Box }[] = [];
  for (const d of checkpointed) {
    const { x, y } = dropletPoint(state, d);
    checkpointBoxes.push({ label: `checkpoint #${d.issue} circle`, box: circleBox(x, y, 9) });
    checkpointBoxes.push({ label: `checkpoint #${d.issue} label`, box: textBox(`⤳ ${d.pr}`, x, y - 14, 10) });
  }

  // Cross-product only — gate rect/label/caption overlapping EACH OTHER is by design (the
  // caption and label are drawn inside/beside their own rect); what must never overlap is a
  // checkpoint chip against any piece of the gate cluster.
  for (const chip of checkpointBoxes) {
    for (const gate of gateBoxes) {
      assert.ok(
        !boxesOverlap(chip.box, gate.box),
        `${chip.label} ${JSON.stringify(chip.box)} overlaps ${gate.label} ${JSON.stringify(gate.box)}`,
      );
    }
  }
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
  // One row short of the grid's 3-row capacity (4, not 6) — the badge takes the whole last row
  // to itself rather than sharing it with a real chip (label-width collision; see stage.tsx's
  // `CHECKPOINT_OVERFLOW_REAL_CAP` doc).
  assert.equal(drawnChips.length, 4, `expected 4 real chips drawn (one row reserved for the badge), got ${drawnChips.length}`);

  const badgeMatch = html.match(/class="hero-checkpoint-overflow" data-count="(\d+)"/);
  assert.ok(badgeMatch, "the overflow badge must render");
  assert.equal(Number(badgeMatch?.[1]), 35, "the badge must read the true remainder: 39 total - 4 drawn = 35");
  assert.match(html, /\+35 more/);

  // Every DRAWN element — the 4 real chips AND the badge — must have its real rendered bbox
  // fully inside the viewBox, AND none may collide with each other (the badge sharing no row
  // with a real chip's label is exactly what this checks).
  const boxes: { label: string; box: Box }[] = [];
  for (const issue of drawnChips) {
    const d = checkpointed.find((o) => o.issue === issue);
    assert.ok(d, `drawn issue #${issue} must be one of the real checkpoint droplets`);
    const { x, y } = dropletPoint(state, d as Droplet);
    boxes.push({ label: `checkpoint #${issue} circle`, box: circleBox(x, y, 9) });
    boxes.push({ label: `checkpoint #${issue} label`, box: textBox(`⤳ ${d?.pr}`, x, y - 14, 10) });
  }
  const badgePoint = checkpointOverflowPoint();
  boxes.push({ label: "overflow badge", box: textBox("+35 more", badgePoint.x, badgePoint.y - 14, 10) });
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
  assert.match(html, /⤳ 739/);

  // text-anchor="end" means the captured x is the RIGHT edge, not the center textBox expects.
  const statusWidth = statusText.length * 10 * CHAR_ADVANCE;
  const statusCenterX = Number(statusXRaw) - statusWidth / 2;

  assertNoOverlap([
    { label: "lane status phrase", box: textBox(statusText, statusCenterX, Number(statusYRaw), 10) },
    { label: "PR chip", box: textBox("⤳ 739", p.x, p.y - 14, 10) },
  ]);
});
