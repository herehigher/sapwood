import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import { toDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
import { NeedsAttention } from "./NeedsAttention.tsx";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function wire(id: number, ts: string, kind: string, payload: Record<string, unknown> | null): LoopEvent {
  return { id, ts, kind, payload };
}

test("renders nothing — zero height — when the strip is empty (the calm default)", () => {
  const html = renderToStaticMarkup(<NeedsAttention items={[]} titles={{}} now={NOW} />);
  assert.equal(html, "");
});

test("an attention-marked event adds a row, rendering the same §7 sentence the feed would", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /needs a human decision/);
  assert.match(html, />#42</);
});

test("aria-live is present so a new row announces itself", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /aria-live="polite"/);
});

test("does not render, import, or re-implement the legend", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /droplet = an issue moving through the loop/);
  assert.doesNotMatch(html, /aria-label="Legend"/);
});

// ── #361 verification plan: a scripted sequence covering each resolution kind ────────────────

function foldAt(events: LoopEvent[]) {
  return foldOpenAttention(events.map(toDomainEvent));
}

test("scripted sequence: escalation-resolved clears exactly the matching (source, issue) row", () => {
  const open = foldAt([
    wire(1, "2026-08-10T11:00:00.000Z", "drive-needs-human", { pr: 1, issue: 10 }),
    wire(2, "2026-08-10T11:05:00.000Z", "escalation-resolved", { source: "drive-needs-human", issue: 10, via: "merged", pr: 1 }),
  ]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.equal(html, "", "the resolved row must not render");
});

test("scripted sequence: worktree-released clears the matching worktree-retained row, keyed by worktreePath", () => {
  const open = foldAt([
    wire(1, "2026-08-10T11:00:00.000Z", "worktree-retained", { worker: "w1", worktreePath: "/tmp/w1" }),
    wire(2, "2026-08-10T11:05:00.000Z", "worktree-released", { worker: "w1", worktreePath: "/tmp/w1" }),
  ]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.equal(html, "");
});

test("scripted sequence: dispatched (an issue-scoped clear) removes an open item for the same issue", () => {
  const open = foldAt([
    wire(1, "2026-08-10T11:00:00.000Z", "rollback-escalated", { issue: 5 }),
    wire(2, "2026-08-10T11:05:00.000Z", "dispatched", { issue: 5 }),
  ]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.equal(html, "");
});

test("scripted sequence: a steady-state re-observation of the same open event adds nothing new", () => {
  const wireEvent = wire(1, "2026-08-10T11:00:00.000Z", "drive-needs-human", { pr: 1, issue: 10 });
  const openOnce = foldAt([wireEvent]);
  const openTwice = foldAt([wireEvent, wireEvent]);
  assert.deepEqual(Object.keys(openOnce), Object.keys(openTwice));
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(openTwice)} titles={{}} now={NOW} />);
  assert.equal(html.match(/needs a human decision/g)?.length, 1);
});
