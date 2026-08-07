import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventKind } from "../copy.ts";
import type { DomainEvent, KnownDomainEvent, UnknownDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
import { ActivityFeed } from "./ActivityFeed.tsx";

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

test("issue/PR numbers in feed sentences carry a type glyph and conditional tooltip", () => {
  const events = [ev(1, "merged", { issue: 1, pr: 10, prTitle: "Add the widget" })];
  const html = renderToStaticMarkup(
    <ActivityFeed events={events} pinnedAttention={pinnedOf(events)} titles={{ 1: { prTitle: "Add the widget" } }} now={NOW} />,
  );
  assert.match(html, /<svg/);
  assert.match(html, /title="Add the widget"/);
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
  assert.match(withTitle, /title="Fix the thing"/);
  assert.match(withTitle, /#42/);

  const withoutTitleEvents = [ev(1, "needs-human-swept", { issue: 7, label: "sapwood:needs-human" })];
  const withoutTitle = renderToStaticMarkup(
    <ActivityFeed events={withoutTitleEvents} pinnedAttention={pinnedOf(withoutTitleEvents)} titles={{}} now={NOW} />,
  );
  assert.match(withoutTitle, /<svg/);
  assert.doesNotMatch(withoutTitle, /title=/);
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
  const rollbackIdx = html.indexOf("automatically — flagged for a human");
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
  // It renders exactly once, not duplicated.
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
