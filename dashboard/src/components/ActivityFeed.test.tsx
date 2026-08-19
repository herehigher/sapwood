import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent, Round } from "../api/types.ts";
import type { EventKind } from "../copy.ts";
import type { KnownDomainEvent, UnknownDomainEvent } from "../domain-event.ts";
import { toDomainEvent } from "../domain-event.ts";
import { formatAbsoluteTime } from "../format-time.ts";
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

/** Same convention `round-log.test.ts`/`useReplay.test.ts` already use for a `Round` fixture. */
function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "in_progress",
    startedAt: "2026-08-06T10:00:00Z",
    endedAt: null,
    startEventId: 0,
    startSpendId: 0,
    eventCount: 2,
    schemaVersion: null,
    artifact: null,
    ...overrides,
  };
}

test("renders newest first", () => {
  const events = [ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.ok(html.indexOf("#2") < html.indexOf("#1"));
});

test("relative timestamps render, not raw ISO strings", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /ago|just now/);
});

// ── #924: the shared .panel-head recipe — title only, no stat cluster ──────────────────────────

test("#924 AC1: the populated feed's head carries .panel-head (title only, no stat cluster)", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /<div class="panel-head"><h2>activity<\/h2><\/div>/);
});

test("aria-live polite is set on the feed list", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /aria-live="polite"/);
});

test("payload details collapse behind each entry, never inline in the sentence", () => {
  const events = [ev(1, "dispatched", { issue: 1, worker: "w1" })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  // the sentence itself never leaks the raw worker field
  const sentenceOnly = html.split("<details")[0] ?? "";
  assert.doesNotMatch(sentenceOnly, /"worker"/);
});

// ── #934: chronology only — no pinned rows, the strip is the sole "open items" surface ──────────

test("#934 AC1: a needs-human event renders only in chronological position, never pinned above a newer routine event", () => {
  const events = [
    ev(1, "drive-needs-human", { issue: 1, pr: 10 }), // older, attention
    ev(2, "dispatched", { issue: 2 }), // newer, routine
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  // Newest-first: the newer routine entry renders ABOVE the older attention entry — the opposite
  // of the retired pin contract, which forced the attention row to the top regardless of age.
  assert.ok(html.indexOf("Started work on issue") < html.indexOf("needs a human decision"));
});

test("#934 AC1: no 'pinned' string appears anywhere in the feed's disclosures, even with attention items and a truncated render", () => {
  const events = Array.from({ length: FEED_RENDER_CAP + 50 }, (_, i) => ev(i + 1, "drive-needs-human", { issue: i + 1, pr: i + 1 }));
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /pinned/i);
});

test("fresh DB (no round, no events) renders the documented idle caption", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[]} round={null} titles={{}} now={NOW} />);
  assert.match(html, /Waiting for the first dispatch/);
});

test("#934: a round in view with no events yet (its own fetch still resolving) renders the divider, never the idle caption", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[]} round={round({ roundId: 3, eventCount: 0 })} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Waiting for the first dispatch/);
  assert.match(html, /ROUND 3/);
});

test("disconnected renders the disconnected caption instead of the feed", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} disconnected now={NOW} />);
  assert.match(html, /disconnected/);
  assert.doesNotMatch(html, /feed-list/);
});

// ── #892: EntityRef's folded title moved from a bare `title=` (static-markup-visible) to a Radix
// tooltip that only mounts on real focus — see EntityRef.test.tsx's own real-DOM tests for the
// interactive open/aria-describedby proof. Here, `tabindex="0"` is the SSR-visible signal that a
// title was folded and wired through to a real (Tab-reachable) trigger — EntityRef only adds it
// when there's a title to show.
test("issue/PR numbers in feed sentences carry a type glyph and a folded-title tooltip trigger", () => {
  const events = [ev(1, "merged", { issue: 1, pr: 10, prTitle: "Add the widget" })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{ 1: { prTitle: "Add the widget" } }} now={NOW} />);
  assert.match(html, /<svg/);
  assert.match(html, /tabindex="0"/);
});

test("#715 gate② [3]: resume-held and needs-human-swept render their issue as a real entity token, not raw text", () => {
  const withTitleEvents = [ev(1, "resume-held", { worker: "w1", issue: 42, label: "sapwood:blocked" })];
  const withTitle = renderToStaticMarkup(
    <ActivityFeed events={withTitleEvents} round={null} titles={{ 42: { issueTitle: "Fix the thing" } }} now={NOW} />,
  );
  assert.match(withTitle, /<svg/);
  assert.match(withTitle, /tabindex="0"/);
  assert.match(withTitle, /#42/);

  const withoutTitleEvents = [ev(1, "needs-human-swept", { issue: 7, label: "sapwood:needs-human" })];
  const withoutTitle = renderToStaticMarkup(<ActivityFeed events={withoutTitleEvents} round={null} titles={{}} now={NOW} />);
  assert.match(withoutTitle, /<svg/);
  assert.doesNotMatch(withoutTitle, /tabindex=/, "no folded title -> no tooltip trigger, no meaningless tab stop");
  assert.match(withoutTitle, /#7/);
});

test("gate resolutions render a ✓/✕ glyph in the DOM regardless of outcome", () => {
  const approvedEvents = [ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "approved", findingCount: 0 })];
  const approved = renderToStaticMarkup(<ActivityFeed events={approvedEvents} round={null} titles={{}} now={NOW} />);
  const rejectedEvents = [ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "rejected", findingCount: 2 })];
  const rejected = renderToStaticMarkup(<ActivityFeed events={rejectedEvents} round={null} titles={{}} now={NOW} />);
  assert.match(approved, /glyph-ok/);
  assert.match(approved, /<svg/);
  assert.match(rejected, /glyph-fail/);
  assert.match(rejected, /<svg/);
});

test("attention-class entries render a static fail glyph alongside the rust dot", () => {
  const events = [ev(1, "verify-na-proposed", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /glyph-fail/);
  assert.match(html, /var\(--rust\)/);
});

// #924 AC3: --sap-fill is a FLAT color (never light-dark()), so it alone needs a light-theme
// outline to clear contrast against its neighbouring surface — --rust/--moss already darken per
// theme and clear unaided. The routine dot (neither attention nor a gate glyph) is the only one
// of the three that paints --sap-fill, so it's the only one that should carry the border.
test("#924 AC3: the routine feed dot (var(--sap-fill)) carries the light-theme outline border; the rust/moss dots do not", () => {
  const routine = [ev(1, "dispatched", { issue: 1 })];
  const routineHtml = renderToStaticMarkup(<ActivityFeed events={routine} round={null} titles={{}} now={NOW} />);
  assert.match(routineHtml, /background:var\(--sap-fill\);border:1px solid var\(--sap-fill-outline\)/);

  const attention = [ev(1, "verify-na-proposed", { issue: 1 })];
  const attentionHtml = renderToStaticMarkup(<ActivityFeed events={attention} round={null} titles={{}} now={NOW} />);
  assert.match(attentionHtml, /background:var\(--rust\);border:none/);

  const glyphOk = [ev(1, "merged", { issue: 1, pr: 10 })];
  const glyphOkHtml = renderToStaticMarkup(<ActivityFeed events={glyphOk} round={null} titles={{}} now={NOW} />);
  assert.match(glyphOkHtml, /background:var\(--moss\);border:none/);
});

test("#715 gate② round 3 [0]: engine-review-containment-gap renders its gaps as separate lines and links the security guide", () => {
  const events = [ev(1, "engine-review-containment-gap", { gaps: ["model-invoked-shell-execution"] })];
  const withRepo = renderToStaticMarkup(
    <ActivityFeed events={events} round={null} titles={{}} repoUrl="https://github.com/herehigher/sapwood" now={NOW} />,
  );
  assert.match(withRepo, /shell commands directly/);
  assert.match(withRepo, /href="https:\/\/github\.com\/herehigher\/sapwood\/blob\/main\/docs\/security\.md"/);

  // No repoUrl known -> the link degrades to plain text, never a guessed URL (same posture as
  // EntityRef with no repoUrl).
  const withoutRepo = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(withoutRepo, /<a /);
  assert.match(withoutRepo, /What this means/);
});

// ── #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null`, never an object ──

test("a null-payload row (corrupt legacy JSON) renders without throwing", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  const corruptAttention: KnownDomainEvent = {
    known: true,
    id: 2,
    ts: "2026-08-06T00:00:01Z",
    kind: "drive-needs-human",
    payload: null,
  };
  assert.doesNotThrow(() => renderToStaticMarkup(<ActivityFeed events={[corrupt, corruptAttention]} round={null} titles={{}} now={NOW} />));
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
    html = renderToStaticMarkup(<ActivityFeed events={[unknown]} round={null} titles={{}} now={NOW} />);
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
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  const rowCount = html.match(/class="feed-entry/g)?.length ?? 0;
  assert.ok(rowCount <= FEED_RENDER_CAP, `expected at most ${FEED_RENDER_CAP} rendered rows, got ${rowCount}`);
  assert.equal(rowCount, FEED_RENDER_CAP);
});

test("#722: truncation is disclosed honestly — 'showing latest N of M', never silent", () => {
  const events = Array.from({ length: 5000 }, (_, i) => ev(i + 1, "dispatched", { issue: i + 1 }));
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, new RegExp(`showing latest ${FEED_RENDER_CAP} of 5000`));
});

test("#722: no disclosure line renders when the event count is within the cap", () => {
  const events = [ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /showing latest/);
});

test("#722: the feed has its own scroll container, fixed max-height, distinct from the panel", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.match(html, /class="feed-scroll"/);
  assert.match(panelsCss, /\.feed-scroll\s*\{[^}]*max-height:[^}]*\}/s);
  assert.match(panelsCss, /\.feed-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s);
});

// ── #934: the round-in-view divider — "ROUND N · started · n events" ────────────────────────────

test("#934: a round in view renders the divider with its own roundId, absolute start time, and full eventCount", () => {
  const events = [ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })];
  const startedAt = "2026-08-06T09:15:00Z";
  const html = renderToStaticMarkup(
    <ActivityFeed events={events} round={round({ roundId: 7, startedAt, eventCount: 2 })} titles={{}} now={NOW} />,
  );
  assert.match(html, /feed-round-divider/);
  assert.match(html, /ROUND 7/);
  assert.match(html, /2 events/);
  // engine-agent finding [0]: this test's own name claims "absolute start time", but the
  // assertions above never checked it — a divider that rendered "ROUND 7 · <garbage> · 2 events"
  // would still pass. `formatAbsoluteTime` (format-time.ts) is the ONE call site every absolute
  // time on the dashboard renders through (that file's own doc) — reading the expected string off
  // it here (rather than a hand-typed literal) keeps this pinned to the real environment's clock
  // formatting (locale/timezone-offset), matching what `ActivityFeed.tsx` itself actually calls.
  assert.match(
    html,
    new RegExp(`ROUND 7 · ${formatAbsoluteTime(startedAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · 2 events`),
    "the divider must render the round's own formatted absolute start time, not just the roundId/count either side of it",
  );
});

test("#934: the divider's count is the round's own eventCount, not events.length — honest even while the round's own fetch is still catching up", () => {
  // Only 1 of the round's 50 total events has loaded so far (a per-round fetch mid-flight) — the
  // divider must still read the round's server-known total, never the partial array length.
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={round({ roundId: 9, eventCount: 50 })} titles={{}} now={NOW} />);
  assert.match(html, /ROUND 9/);
  assert.match(html, /50 events/);
});

test("#934: no round in view (fresh DB) renders no divider", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[]} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /feed-round-divider/);
});

test("#934: the panel title stays 'activity' — the divider is a second row, not a title replacement", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={round({ roundId: 4 })} titles={{}} now={NOW} />);
  assert.match(html, /<div class="panel-head"><h2>activity<\/h2><\/div>/);
});

// ── #893: telemetry tier — collapsed by default, honest disclosure, opt-in reveal ─────────────

test("#893: a real, previously-unmapped heartbeat kind renders zero 'Unrecognized event' rows — AC2", () => {
  const events = [ev(1, "worker-heartbeat", { worker: "w1" }), ev(2, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Unrecognized event/);
});

test("#893: telemetry rows are collapsed from the default view, with an honest disclosure count", () => {
  const events = [
    ev(1, "worker-heartbeat", { worker: "w1" }),
    ev(2, "role-session-heartbeat", { worker: "w1" }),
    ev(3, "dispatched", { issue: 1 }),
  ];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /Telemetry: worker-heartbeat/, "telemetry rows must not render inline by default");
  assert.match(html, /2 telemetry event\(s\) hidden/, "the count of hidden telemetry rows must be disclosed honestly");
  assert.match(html, /Started work on issue/, "narrative rows still render normally alongside the disclosure");
});

test("#893: no telemetry disclosure renders when there is nothing to hide", () => {
  const events = [ev(1, "dispatched", { issue: 1 })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /telemetry event/);
});

test("#893: the telemetry toggle reveals hidden rows with an honest generic sentence, through a real click", async () => {
  const events = [ev(1, "worker-heartbeat", { worker: "w1" }), ev(2, "dispatched", { issue: 1 })];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
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
// describe what actually RENDERED, never the pre-cap total, once FEED_RENDER_CAP truncates
// telemetry rows. ─────────────────────────────────────────────────────────────────────────────

test("#900 finding [0]: the shown-state disclosure reports the RENDERED count, not the pre-cap total, once FEED_RENDER_CAP truncates telemetry rows", async () => {
  // 201 telemetry-only events, zero narrative: only FEED_RENDER_CAP (200) of them can actually
  // render once shown, so the disclosure must say "200 of 201", never "201".
  const events = Array.from({ length: FEED_RENDER_CAP + 1 }, (_, i) => ev(i + 1, "worker-heartbeat", { worker: "w1" }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
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
  const html = renderToStaticMarkup(<ActivityFeed events={[event]} round={null} titles={{}} now={NOW} />);
  assert.match(html, /est \$6\.21 → real \$5\.80/);
});

test("#890: a lane-settlement event whose settled costUsd is itself an estimate renders no calibration line — never labels an estimate as real", () => {
  const event = toDomainEvent(
    wire(1, "reclaim-done", { worker: "w1", issue: 90, next: "DRIVING", costUsd: 5.8, estCostUsd: 6.21, costEstimated: true }),
  );
  const html = renderToStaticMarkup(<ActivityFeed events={[event]} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /est \$/);
});

test("#890: a lane-settlement event with no est/real figures on the payload renders no calibration line at all", () => {
  const events = [ev(1, "reclaim-done", { worker: "w1", issue: 90, next: "DRIVING" })];
  const html = renderToStaticMarkup(<ActivityFeed events={events} round={null} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /est \$/);
});
