import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import { ActivityFeed } from "./ActivityFeed.tsx";

const NOW = new Date("2026-08-06T12:00:00.000Z");

const ev = (id: number, kind: string, payload: Record<string, unknown> = {}): LoopEvent => ({
  id,
  ts: new Date(NOW.getTime() - (100 - id) * 1000).toISOString(),
  kind,
  payload,
});

test("renders newest first", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed events={[ev(1, "dispatched", { issue: 1 }), ev(2, "dispatched", { issue: 2 })]} titles={{}} now={NOW} />,
  );
  assert.ok(html.indexOf("#2") < html.indexOf("#1"));
});

test("relative timestamps render, not raw ISO strings", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[ev(1, "dispatched", { issue: 1 })]} titles={{}} now={NOW} />);
  assert.match(html, /ago|just now/);
});

test("aria-live polite is set on the feed list", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[ev(1, "dispatched", { issue: 1 })]} titles={{}} now={NOW} />);
  assert.match(html, /aria-live="polite"/);
});

test("payload details collapse behind each entry, never inline in the sentence", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[ev(1, "dispatched", { issue: 1, worker: "w1" })]} titles={{}} now={NOW} />);
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  // the sentence itself never leaks the raw worker field
  const sentenceOnly = html.split("<details")[0] ?? "";
  assert.doesNotMatch(sentenceOnly, /"worker"/);
});

test("a needs-human event pins above a subsequently-newer non-escalation event", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed
      events={[
        ev(1, "drive-needs-human", { issue: 1, pr: 10 }), // older, but attention
        ev(2, "dispatched", { issue: 2 }), // newer, but routine
      ]}
      titles={{}}
      now={NOW}
    />,
  );
  assert.ok(html.indexOf("needs a human decision") < html.indexOf("Started work on issue"));
});

test("fresh DB (no events) renders the documented idle caption", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[]} titles={{}} now={NOW} />);
  assert.match(html, /Waiting for the first dispatch/);
});

test("disconnected renders the disconnected caption instead of the feed", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[ev(1, "dispatched", { issue: 1 })]} titles={{}} disconnected now={NOW} />);
  assert.match(html, /disconnected/);
  assert.doesNotMatch(html, /feed-list/);
});

test("issue/PR numbers in feed sentences carry a type glyph and conditional tooltip", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed
      events={[ev(1, "merged", { issue: 1, pr: 10, prTitle: "Add the widget" })]}
      titles={{ 1: { prTitle: "Add the widget" } }}
      now={NOW}
    />,
  );
  assert.match(html, /<svg/);
  assert.match(html, /title="Add the widget"/);
});

test("#715 gate② [3]: resume-held and needs-human-swept render their issue as a real entity token, not raw text", () => {
  const withTitle = renderToStaticMarkup(
    <ActivityFeed
      events={[ev(1, "resume-held", { worker: "w1", issue: 42, label: "sapwood:blocked" })]}
      titles={{ 42: { issueTitle: "Fix the thing" } }}
      now={NOW}
    />,
  );
  assert.match(withTitle, /<svg/);
  assert.match(withTitle, /title="Fix the thing"/);
  assert.match(withTitle, /#42/);

  const withoutTitle = renderToStaticMarkup(
    <ActivityFeed events={[ev(1, "needs-human-swept", { issue: 7, label: "sapwood:needs-human" })]} titles={{}} now={NOW} />,
  );
  assert.match(withoutTitle, /<svg/);
  assert.doesNotMatch(withoutTitle, /title=/);
  assert.match(withoutTitle, /#7/);
});

test("gate resolutions render a ✓/✕ glyph in the DOM regardless of outcome", () => {
  const approved = renderToStaticMarkup(
    <ActivityFeed
      events={[ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "approved", findingCount: 0 })]}
      titles={{}}
      now={NOW}
    />,
  );
  const rejected = renderToStaticMarkup(
    <ActivityFeed
      events={[ev(1, "engine-review-verdict", { issue: 1, pr: 10, outcome: "rejected", findingCount: 2 })]}
      titles={{}}
      now={NOW}
    />,
  );
  assert.match(approved, /glyph-ok/);
  assert.match(approved, /<svg/);
  assert.match(rejected, /glyph-fail/);
  assert.match(rejected, /<svg/);
});

test("attention-class entries render a static fail glyph alongside the rust dot", () => {
  const html = renderToStaticMarkup(<ActivityFeed events={[ev(1, "verify-na-proposed", { issue: 1 })]} titles={{}} now={NOW} />);
  assert.match(html, /glyph-fail/);
  assert.match(html, /var\(--rust\)/);
});

test("a later escalation-resolved for the same (source, issue) unpins the escalation it resolves", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed
      events={[
        ev(1, "drive-needs-human", { issue: 5, pr: 50 }), // older escalation, issue 5
        ev(2, "dispatched", { issue: 9 }), // newer, routine
        ev(3, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }), // resolves #1
      ]}
      titles={{}}
      now={NOW}
    />,
  );
  // Neither the resolved escalation nor its resolution is pinned above the routine entry anymore.
  const needsHumanIdx = html.indexOf("needs a human decision");
  const dispatchedIdx = html.indexOf("Started work on issue");
  assert.ok(needsHumanIdx > dispatchedIdx, "resolved escalation should no longer be pinned above a routine entry");
});

test("an escalation with no issue in its payload is never superseded by escalation-resolved", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed
      events={[
        ev(1, "ceiling-escalated", {}),
        ev(2, "dispatched", { issue: 9 }),
        ev(3, "escalation-resolved", { issue: 9, source: "ceiling-escalated", via: "merged" }),
      ]}
      titles={{}}
      now={NOW}
    />,
  );
  assert.ok(html.indexOf("Safety ceiling reached") < html.indexOf("Started work on issue"));
});

test("#715 gate② [5]: resolving ONE of two simultaneously-open sources on the same issue leaves the other pinned", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed
      events={[
        ev(1, "drive-needs-human", { issue: 5, pr: 50 }), // source A, issue 5
        ev(2, "rollback-escalated", { issue: 5 }), // source B, SAME issue 5
        ev(3, "dispatched", { issue: 9 }), // newer, routine
        // Resolves ONLY source A (drive-needs-human) — source B must stay pinned.
        ev(4, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }),
      ]}
      titles={{}}
      now={NOW}
    />,
  );
  const needsHumanIdx = html.indexOf("needs a human decision");
  // renderToStaticMarkup HTML-escapes the apostrophe ("Couldn't" -> "Couldn&#x27;t"), so match on
  // an apostrophe-free substring of the sentence instead.
  const rollbackIdx = html.indexOf("automatically — flagged for a human");
  const dispatchedIdx = html.indexOf("Started work on issue");
  assert.ok(needsHumanIdx > dispatchedIdx, "the RESOLVED source should no longer be pinned above the routine entry");
  assert.ok(rollbackIdx !== -1 && rollbackIdx < dispatchedIdx, "the UNRESOLVED source on the same issue must stay pinned");
});
