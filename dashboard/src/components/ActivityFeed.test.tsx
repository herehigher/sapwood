import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import type { EventKind } from "../copy.ts";
import type { DomainEvent, KnownDomainEvent, UnknownDomainEvent } from "../domain-event.ts";
import { toDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
import { registerRealDom } from "../test-dom.ts";
import { ActivityFeed, FEED_RENDER_CAP } from "./ActivityFeed.tsx";

// #893: opt-in real DOM (one call, this file only — test-dom.ts's own doc) so the telemetry
// toggle's click-through can be proven for real, not just its collapsed initial render via
// `renderToStaticMarkup` (which never dispatches events).
registerRealDom();

const panelsCss = readFileSync(new URL("../panels.css", import.meta.url), "utf8");

const NOW = new Date("2026-08-06T12:00:00.000Z");

// `kind: EventKind`, not a bare `string` — #715 gate② round 4 [0] / round 5 [0]: `ActivityFeed`
// consumes `DomainEvent`, so this fixture produces the `KnownDomainEvent` shape `toDomainEvent`
// (domain-event.ts) actually classifies any real, mapped wire kind into.
const ev = (id: number, kind: EventKind, payload: Record<string, unknown> = {}): KnownDomainEvent => ({
  known: true,
  id,
  ts: new Date(NOW.getTime() - (100 - id) * 1000).toISOString(),
  kind,
  payload,
});

/** A raw, engine-shaped wire row (`api/types.ts`'s `LoopEvent` — `id`/`ts`/`kind`/`payload`,
 *  nothing else), for tests that must prove a payload survives the real `toDomainEvent` parse
 *  boundary rather than a hand-built `KnownDomainEvent` fixture (same pattern as
 *  `NeedsAttention.test.tsx`'s own `wire` helper). */
const wire = (id: number, kind: string, payload: Record<string, unknown> | null): LoopEvent => ({
  id,
  ts: new Date(NOW.getTime() - (100 - id) * 1000).toISOString(),
  kind,
  payload,
});

/** Most tests want the natural "pin whatever's currently open across these events" behavior —
 *  exactly what `useEventHistory` gives `ActivityFeed` in production. Deriving `pinnedAttention`
 *  from the same fixture `events` array (rather than hand-picking it) keeps these tests honest
 *  about the real prop contract instead of asserting against a value nothing would ever produce. */
const pinnedOf = (events: DomainEvent[]): DomainEvent[] => Object.values(foldOpenAttention(events));

test("renders newest first", () => {
  const events = [ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.ok(html.indexOf("#2") < html.indexOf("#1"));
});

test("relative timestamps render, not raw ISO strings", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.match(html, /ago|just now/);
});

test("aria-live polite is set on the feed list", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.match(html, /aria-live="polite"/);
});

test("payload details collapse behind each entry, never inline in the sentence", () => {
  const events = [ev(1, "dispatched", { issue: 1, worker: "w1" })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  // the sentence itself never leaks the raw worker field
  const sentenceOnly = html.split("<details")[0] ?? "";
  assert.doesNotMatch(sentenceOnly, /"worker"/);
});

test("a needs-human event pins above a subsequently-newer non-escalation event", () => {
  const events = [
    ev(1, "drive-needs-human", { issue: 1, pr: 10 }), // older, but attention
    ev(2, "dispatched", { issue: 2 }), // newer, but routine
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.ok(html.indexOf("needs a human decision") < html.indexOf("Started work on issue"));
});

test("fresh DB (no events, nothing pinned) renders the documented idle caption", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[]} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.match(html, /Waiting for the first dispatch/);
});

test("disconnected renders the disconnected caption instead of the feed", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} disconnected now={NOW} />);
  assert.match(html, /disconnected/);
  assert.doesNotMatch(html, /feed-list/);
});

// #892: EntityRef's folded title moved from a bare `title=` (static-markup-visible) to a Radix
// tooltip that only mounts on real focus — see EntityRef.test.tsx's own real-DOM tests for the
// interactive open/aria-describedby proof. Here, `tabindex="0"` is the SSR-visible signal that a
// title was folded and wired through to a real (Tab-reachable) trigger — EntityRef only adds it
// when there's a title to show.
test("issue/PR numbers in feed sentences carry a type glyph and a folded-title tooltip trigger", () => {
  const events = [ev(1, "merged", { issue: 1, pr: 10, prTitle: "Add the widget" })];
  const html = renderToStaticMarkup(
    <ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{ 1: { prTitle: "Add the widget" } }} now={NOW} />,
  );
  assert.match(html, /<svg/);
  assert.match(html, /tabindex="0"/);
});

test("#715 gate② [3]: resume-held and needs-human-swept render their issue as a real entity token, not raw text", () => {
  const withTitleEvents = [ev(1, "resume-held", { worker: "w1", issue: 42, label: "sapwood:blocked" })];
  const withTitle = renderToStaticMarkup(
    <ActivityFeed
      events={withTitleEvents}
      pinnedAttention={pinnedOf(withTitleEvents)}
      titles={{ 42: { issueTitle: "Fix the thing" } }}
      now={NOW}
    />,
  );
  assert.match(withTitle, /<svg/);
  assert.match(withTitle, /tabindex="0"/);
  assert.match(withTitle, /#42/);

  const withoutTitleEvents = [ev(1, "needs-human-swept", { issue: 7, label: "sapwood:needs-human" })];
  const withoutTitle = renderToStaticMarkup(
    <ActivityFeed events={withoutTitleEvents} pinnedAttention={pinnedOf(withoutTitleEvents)} titles={{}} now={NOW} />,
  );
  assert.match(withoutTitle, /<svg/);
  assert.doesNotMatch(withoutTitle, /tabindex=/, "no folded title -> no tooltip trigger, no meaningless tab stop");
  assert.match(withoutTitle, /#7/);
});

test("gate resolutions render a ✓/✕ glyph in the DOM regardless of outcome", () => {
  const approvedEvents = [ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "approved", findingCount: 0 })];
  const approved = renderToStaticMarkup(
    <ActivityFeed events={approvedEvents} pinnedAttention={pinnedOf(approvedEvents)} titles={{}} now={NOW} />,
  );
  const rejectedEvents = [ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "rejected", findingCount: 2 })];
  const rejected = renderToStaticMarkup(
    <ActivityFeed events={rejectedEvents} pinnedAttention={pinnedOf(rejectedEvents)} titles={{}} now={NOW} />,
  );
  assert.match(approved, /glyph-ok/);
  assert.match(approved, /<svg/);
  assert.match(rejected, /glyph-fail/);
  assert.match(rejected, /<svg/);
});

test("attention-class entries render a static fail glyph alongside the rust dot", () => {
  const events = [ev(1, "verify-na-proposed", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.match(html, /glyph-fail/);
  assert.match(html, /var\(--rust\)/);
});

test("a later escalation-resolved for the same (source, issue) unpins the escalation it resolves", () => {
  const events = [
    ev(1, "drive-needs-human", { issue: 5, pr: 50 }), // older escalation, issue 5
    ev(2, "dispatched", { issue: 9 }), // newer, routine
    ev(3, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }), // resolves #1
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  // Neither the resolved escalation nor its resolution is pinned above the routine entry anymore.
  const needsHumanIdx = html.indexOf("needs a human decision");
  const dispatchedIdx = html.indexOf("Started work on issue");
  assert.ok(needsHumanIdx > dispatchedIdx, "resolved escalation should no longer be pinned above a routine entry");
});

test("an escalation with no issue in its payload is never superseded by escalation-resolved", () => {
  const events = [
    ev(1, "ceiling-escalated", {}),
    ev(2, "dispatched", { issue: 9 }),
    ev(3, "escalation-resolved", { issue: 9, source: "ceiling-escalated", via: "merged" }),
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.ok(html.indexOf("Safety ceiling reached") < html.indexOf("Started work on issue"));
});

test("#715 gate② [5]: resolving ONE of two simultaneously-open sources on the same issue leaves the other pinned", () => {
  const events = [
    ev(1, "drive-needs-human", { issue: 5, pr: 50 }), // source A, issue 5
    ev(2, "rollback-escalated", { issue: 5 }), // source B, SAME issue 5
    ev(3, "dispatched", { issue: 9 }), // newer, routine
    // Resolves ONLY source A (drive-needs-human) — source B must stay pinned.
    ev(4, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }),
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  const needsHumanIdx = html.indexOf("needs a human decision");
  // renderToStaticMarkup HTML-escapes the apostrophe ("Couldn't" -> "Couldn&#x27;t"), so match on
  // an apostrophe-free substring of the sentence instead.
  const rollbackIdx = html.indexOf("automatically · asks: return it to the backlog by hand");
  const dispatchedIdx = html.indexOf("Started work on issue");
  assert.ok(needsHumanIdx > dispatchedIdx, "the RESOLVED source should no longer be pinned above the routine entry");
  assert.ok(rollbackIdx !== -1 && rollbackIdx < dispatchedIdx, "the UNRESOLVED source on the same issue must stay pinned");
});

// ── #715 gate② [0]: pinned attention survives past the bounded display window ──────────────────

test("#715 gate② [0]: an open escalation that has aged out of the bounded `events` window still renders, pinned", () => {
  // Simulates what `useEventHistory` produces once `events` (the display window) has scrolled
  // past the original escalation: `pinnedAttention` still carries it (durable fold), even though
  // it is ABSENT from `events` entirely.
  const escalation = ev(1, "drive-needs-human", { issue: 5, pr: 50 });
  const recentWindow = [ev(9001, "dispatched", { issue: 200 }), ev(9002, "dispatched", { issue: 201 })];
  const html = renderToStaticMarkup(<ActivityFeed events={recentWindow} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.match(html, /needs a human decision/);
  assert.equal(html.match(/needs a human decision/g)?.length, 1);
});

test("#715 gate② [0]: idle caption does not render when events is empty but something is still pinned", () => {
  const escalation = ev(1, "drive-needs-human", { issue: 5, pr: 50 });
  const html = renderToStaticMarkup(<ActivityFeed events={[]} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Waiting for the first dispatch/);
  assert.match(html, /needs a human decision/);
});

test("#715 gate② [0]: a pinned item that is ALSO still within the recent window renders once, not twice", () => {
  const escalation = ev(5, "drive-needs-human", { issue: 5, pr: 50 });
  const events = [escalation, ev(6, "dispatched", { issue: 9 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.equal(html.match(/needs a human decision/g)?.length, 1);
});

test("#715 gate② round 3 [0]: engine-review-containment-gap renders its gaps as separate lines and links the security guide", () => {
  const events = [ev(1, "engine-review-containment-gap", { gaps: ["model-invoked-shell-execution"] })];
  const withRepo = renderToStaticMarkup(
    <ActivityFeed events={events} pinnedAttention={[]} titles={{}} repoUrl="https://github.com/herehigher/sapwood" now={NOW} />,
  );
  assert.match(withRepo, /shell commands directly/);
  assert.match(withRepo, /href="https:\/\/github\.com\/herehigher\/sapwood\/blob\/main\/docs\/security\.md"/);

  // No repoUrl known -> the link degrades to plain text, never a guessed URL (same posture as
  // EntityRef with no repoUrl).
  const withoutRepo = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(withoutRepo, /<a /);
  assert.match(withoutRepo, /What this means/);
});

// ── #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null`, never an object ──

test("a null-payload row (corrupt legacy JSON) renders without throwing, both alone and pinned", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.doesNotThrow(() => renderToStaticMarkup(<ActivityFeed events={[corrupt]} pinnedAttention={[]} titles={{}} now={NOW} />));

  const corruptAttention: KnownDomainEvent = {
    known: true,
    id: 2,
    ts: "2026-08-06T00:00:01Z",
    kind: "drive-needs-human",
    payload: null,
  };
  assert.doesNotThrow(() =>
    renderToStaticMarkup(<ActivityFeed events={[corruptAttention]} pinnedAttention={[corruptAttention]} titles={{}} now={NOW} />),
  );
});

// ── #715 gate② round 5 [0]: the unknown-wire-kind fallback path — required, not a bug (§8) ───────

test("an unknown-kind event (a wire kind newer than this client's copy map) renders the honest fallback sentence, never throws, never hidden", () => {
  const unknown: UnknownDomainEvent = {
    known: false,
    id: 1,
    ts: "2026-08-06T00:00:00Z",
    kind: "a-kind-from-a-newer-engine",
    payload: { some: "future-shape" },
  };
  let html = "";
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup(<ActivityFeed events={[unknown]} pinnedAttention={[]} titles={{}} now={NOW} />);
  });
  assert.match(html, /Unrecognized event: a-kind-from-a-newer-engine/);
  // Routine dot color, no attention class, no gate glyph — an unknown kind is never mistaken for
  // an escalation or a gate outcome it never claimed to be.
  assert.doesNotMatch(html, /feed-entry-attention/);
  assert.doesNotMatch(html, /glyph-ok|glyph-fail/);
});

// ── #722: bound the feed's rendered surface — cap + scroll container ────────────────────────────

test("#722: a fixture of thousands of events renders no more than FEED_RENDER_CAP <li> rows", () => {
  const events = Array.from({ length: 5000 }, (_, i) => ev(i + 1, "dispatched", { issue: i + 1 }));
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  const rowCount = html.match(/class="feed-entry/g)?.length ?? 0;
  assert.ok(rowCount <= FEED_RENDER_CAP, `expected at most ${FEED_RENDER_CAP} rendered rows, got ${rowCount}`);
  assert.equal(rowCount, FEED_RENDER_CAP);
});

test("#722: truncation is disclosed honestly — 'showing latest N of M', never silent", () => {
  const events = Array.from({ length: 5000 }, (_, i) => ev(i + 1, "dispatched", { issue: i + 1 }));
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.match(html, new RegExp(`showing latest ${FEED_RENDER_CAP} of 5000`));
});

test("#722: no disclosure line renders when the event count is within the cap", () => {
  const events = [ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /showing latest/);
});

test("#722: the feed has its own scroll container, fixed max-height, distinct from the panel", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{}} now={NOW} />);
  assert.match(html, /class="feed-scroll"/);
  assert.match(panelsCss, /\.feed-scroll\s*\{[^}]*max-height:[^}]*\}/s);
  assert.match(panelsCss, /\.feed-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s);
});

test("#722: needs-human pinning still holds entries at the top of the (now capped) render", () => {
  const escalation = ev(1, "drive-needs-human", { issue: 1, pr: 10 });
  const routine = Array.from({ length: 500 }, (_, i) => ev(i + 100, "dispatched", { issue: i + 100 }));
  const events = [escalation, ...routine];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.ok(html.indexOf("needs a human decision") < html.indexOf("Started work on issue"));
});

test("#722: a pinned item that has aged out of the render window's cap still renders, pinned", () => {
  // The escalation is the OLDEST event (id 1) and would be cut by a naive newest-N-of-events
  // cap — `pinnedAttention` must still surface it (durable fold, same contract as the existing
  // aged-out-of-`events` tests above).
  const escalation = ev(1, "drive-needs-human", { issue: 1, pr: 10 });
  const routine = Array.from({ length: FEED_RENDER_CAP + 50 }, (_, i) => ev(i + 100, "dispatched", { issue: i + 100 }));
  const events = [escalation, ...routine];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.match(html, /needs a human decision/);
  assert.equal(html.match(/needs a human decision/g)?.length, 1);
});

// ── #722 gate② [0]: pinned-bypasses-cap — pinned is durable/unbounded, so pinned count can itself
// exceed FEED_RENDER_CAP, and a pinned entry mixed into a truncated render breaks the "latest N"
// framing (a pinned row need not be among the newest). Both must be disclosed honestly, never
// silently mis-stated. ──────────────────────────────────────────────────────────────────────────

test("#722 gate② [0]: more pinned entries than FEED_RENDER_CAP all render — the cap is intentionally exceeded, and says so", () => {
  const escalations = Array.from({ length: FEED_RENDER_CAP + 50 }, (_, i) => ev(i + 1, "drive-needs-human", { issue: i + 1, pr: i + 1 }));
  const html = renderToStaticMarkup(<ActivityFeed events={escalations} pinnedAttention={escalations} titles={{}} now={NOW} />);
  const rowCount = html.match(/class="feed-entry/g)?.length ?? 0;
  // An open escalation must never be silently dropped by the display cap (durable pin contract) —
  // but that means more than FEED_RENDER_CAP rows can mount, so it must be disclosed, not silent.
  assert.equal(rowCount, escalations.length, "every pinned entry renders — pinning is never truncated");
  assert.match(html, new RegExp(`${escalations.length} pinned`));
  assert.match(html, new RegExp(`exceed[s]? the ${FEED_RENDER_CAP}`));
});

test("#722 gate② [0]: with zero routine rows, pinned-over-cap is STILL disclosed (not masked by the truncated-rest check)", () => {
  const escalations = Array.from({ length: FEED_RENDER_CAP + 10 }, (_, i) => ev(i + 1, "drive-needs-human", { issue: i + 1, pr: i + 1 }));
  // No routine events at all — `rest` is empty, so a disclosure gated only on "was `rest` cut?"
  // would wrongly stay silent even though the cap was blown by pinned entries alone.
  const html = renderToStaticMarkup(<ActivityFeed events={escalations} pinnedAttention={escalations} titles={{}} now={NOW} />);
  assert.match(html, /pinned/);
  assert.match(html, new RegExp(`exceed[s]? the ${FEED_RENDER_CAP}`));
});

test("#722 gate② [0]: the disclosure names the pinned exception rather than implying pure recency", () => {
  // The pinned escalation is the OLDEST event (id 1) yet occupies a render slot alongside the
  // newest routine entries — "showing latest N of M" alone would misdescribe that slot as
  // recency-selected when it is actually a pinned exception.
  const escalation = ev(1, "drive-needs-human", { issue: 1, pr: 10 });
  const routine = Array.from({ length: FEED_RENDER_CAP + 50 }, (_, i) => ev(i + 100, "dispatched", { issue: i + 100 }));
  const events = [escalation, ...routine];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[escalation]} titles={{}} now={NOW} />);
  assert.match(html, /1 pinned always included/);
});

// ── #893: telemetry tier — collapsed by default, honest disclosure, opt-in reveal ─────────────

test("#893: a real, previously-unmapped heartbeat kind renders zero 'Unrecognized event' rows — AC2", () => {
  const events = [ev(1, "worker-heartbeat", { worker: "w1" }), ev(2, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Unrecognized event/);
});

test("#893: telemetry rows are collapsed from the default view, with an honest disclosure count", () => {
  const events = [
    ev(1, "worker-heartbeat", { worker: "w1" }),
    ev(2, "role-session-heartbeat", { worker: "w1" }),
    ev(3, "dispatched", { issue: 1 }),
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Telemetry: worker-heartbeat/, "telemetry rows must not render inline by default");
  assert.match(html, /2 telemetry event\(s\) hidden/, "the count of hidden telemetry rows must be disclosed honestly");
  assert.match(html, /Started work on issue/, "narrative rows still render normally alongside the disclosure");
});

test("#893: no telemetry disclosure renders when there is nothing to hide", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /telemetry event/);
});

test("#893: the telemetry toggle reveals hidden rows with an honest generic sentence, through a real click", async () => {
  const events = [ev(1, "worker-heartbeat", { worker: "w1" }), ev(2, "dispatched", { issue: 1 })];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
    });
    assert.doesNotMatch(container.innerHTML, /Telemetry: worker-heartbeat/, "collapsed by default");
    const toggle = container.querySelector(".feed-telemetry-toggle");
    assert.ok(toggle, "the show/hide toggle must render whenever telemetry rows are hidden");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.match(container.innerHTML, /Telemetry: worker-heartbeat/, "the honest generic line renders once shown");
    assert.match(container.innerHTML, /showing 1 telemetry event\(s\)/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── PR #900 gate② finding [0] (telemetry-visible-count): the disclosure's "showing N" must
// describe what actually RENDERED, never the pre-cap total — FEED_RENDER_CAP truncates `rest`
// (narrative + telemetry mixed) after `telemetryCount` is already computed. ─────────────────────

test("#900 finding [0]: the shown-state disclosure reports the RENDERED count, not the pre-cap total, once FEED_RENDER_CAP truncates telemetry rows", async () => {
  // 201 telemetry-only events, zero pinned, zero narrative: only FEED_RENDER_CAP (200) of them
  // can actually render once shown, so the disclosure must say "200 of 201", never "201".
  const events = Array.from({ length: FEED_RENDER_CAP + 1 }, (_, i) => ev(i + 1, "worker-heartbeat", { worker: "w1" }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
    });
    assert.match(container.innerHTML, new RegExp(`${FEED_RENDER_CAP + 1} telemetry event\\(s\\) hidden`));
    const toggle = container.querySelector(".feed-telemetry-toggle");
    assert.ok(toggle);
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const rowCount = container.innerHTML.match(/Telemetry: worker-heartbeat/g)?.length ?? 0;
    assert.equal(rowCount, FEED_RENDER_CAP, "only the cap's worth of telemetry rows actually render");
    assert.match(container.innerHTML, new RegExp(`showing ${FEED_RENDER_CAP} of ${FEED_RENDER_CAP + 1} telemetry event\\(s\\)`));
    assert.doesNotMatch(container.innerHTML, new RegExp(`showing ${FEED_RENDER_CAP + 1} telemetry event\\(s\\)(?! of)`));
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("#900 finding [0]: with pinned rows alone exceeding the cap, the shown-state disclosure says ZERO telemetry rows rendered, never a false 'showing N'", async () => {
  // Pinned attention is exempt from the cap and always renders FIRST — enough of it alone (well
  // past FEED_RENDER_CAP) leaves zero render slots for `rest`, so no telemetry row can render at
  // all even though the toggle is on.
  const pinnedAttention = Array.from({ length: FEED_RENDER_CAP + 10 }, (_, i) =>
    ev(i + 1, "drive-needs-human", { issue: i + 1, pr: i + 1 }),
  );
  const events = [...pinnedAttention, ev(9001, "worker-heartbeat", { worker: "w1" }), ev(9002, "role-session-heartbeat", { worker: "w1" })];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActivityFeed events={events} pinnedAttention={pinnedAttention} titles={{}} now={NOW} />);
    });
    const toggle = container.querySelector(".feed-telemetry-toggle");
    assert.ok(toggle);
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.doesNotMatch(
      container.innerHTML,
      /Telemetry: worker-heartbeat/,
      "pinned rows alone already exceed the cap — no room for telemetry rows",
    );
    assert.match(container.innerHTML, /showing 0 of 2 telemetry event\(s\)/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── #890 (§3 E): est→real calibration line on lane settlement — issue verification plan Tier A ─
//
// A raw, engine-shaped `reclaim-done` wire row (`conductor.ts`'s `reclaimTerminalLane` —
// `costUsd` the settled figure, `costEstimated` its own known-real flag, `estCostUsd` the lane's
// last-known live estimate), pushed through the REAL `toDomainEvent` parse boundary rather than
// a hand-built `KnownDomainEvent` fixture, asserting the rendered sentence carries the exact
// "est $X → real $Y" text.

test("#890: a lane-settlement event carrying estCostUsd and a known-real costUsd renders the est→real calibration line, through the real toDomainEvent boundary", () => {
  const event = toDomainEvent(
    wire(1, "reclaim-done", { worker: "w1", issue: 90, next: "DRIVING", costUsd: 5.8, estCostUsd: 6.21, costEstimated: false }),
  );
  const html = renderToStaticMarkup(<ActivityFeed events={[event]} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.match(html, /est \$6\.21 → real \$5\.80/);
});

test("#890: a lane-settlement event whose settled costUsd is itself an estimate renders no calibration line — never labels an estimate as real", () => {
  const event = toDomainEvent(
    wire(1, "reclaim-done", { worker: "w1", issue: 90, next: "DRIVING", costUsd: 5.8, estCostUsd: 6.21, costEstimated: true }),
  );
  const html = renderToStaticMarkup(<ActivityFeed events={[event]} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /est \$/);
});

test("#890: a lane-settlement event with no est/real figures on the payload renders no calibration line at all", () => {
  const events = [ev(1, "reclaim-done", { worker: "w1", issue: 90, next: "DRIVING" })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} pinnedAttention={[]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /est \$/);
});
