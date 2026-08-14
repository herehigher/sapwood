import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import { toDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
import { foldEvents, initialHeroState } from "../hero/state.ts";
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

// ── #881: category chip + reason/ask row shape (needs-attention-dark.png fidelity) ───────────

test("renders the row's category chip, matching the mockup's taxonomy", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip">DECISION</);
});

test("renders a different chip label for a different category (CI)", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "ci-inert-escalated", { pr: 42, issue: 7, checks: [] }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip">CI</);
});

test("renders no chip for an unrecognized event kind, never a fabricated label", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "some-future-kind-nobody-registered-yet", { pr: 42 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /attention-chip/);
});

test("row renders the mockup's shape — chip, reason + explicit ask, and a bordered age box", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "fix-rounds-capped", { pr: 9, issue: 1, fixRounds: 3, cap: 3 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /attention-chip">FIX CAP/);
  assert.match(html, /\(3\/3\)/);
  assert.match(html, /asks: adjudicate/);
  assert.match(html, /class="muted data attention-ts attention-age"/);
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

// ── #891: shared-fold reconciliation sentence + the header summary line ──────────────────────

test("#891 AC2: an empty fold with a nonzero round escalation count renders the reconciliation sentence, not the calm empty default", () => {
  const wireEvents: LoopEvent[] = [
    wire(1, "2026-08-10T11:00:00.000Z", "dispatched", { worker: "w1", issue: 10 }),
    wire(2, "2026-08-10T11:01:00.000Z", "reclaim-done", { worker: "w1", issue: 10, next: "DRIVING", pr: 1 }),
    wire(3, "2026-08-10T11:02:00.000Z", "drive-needs-human", { worker: "w1", issue: 10, pr: 1 }),
    // Resolved without a fresh dispatch/merge — the shared fold clears it.
    wire(4, "2026-08-10T11:03:00.000Z", "escalation-resolved", { source: "drive-needs-human", issue: 10, via: "board-fixed" }),
    wire(5, "2026-08-10T11:10:00.000Z", "dispatched", { worker: "w2", issue: 20 }),
    wire(6, "2026-08-10T11:11:00.000Z", "reclaim-done", { worker: "w2", issue: 20, next: "DRIVING", pr: 2 }),
    wire(7, "2026-08-10T11:12:00.000Z", "fix-leg-verdict-rerun", { worker: "w2", issue: 20, pr: 2 }),
    wire(8, "2026-08-10T11:13:00.000Z", "escalation-resolved", { source: "fix-leg-verdict-rerun", issue: 20, via: "merged", pr: 2 }),
  ];
  const open = foldAt(wireEvents);
  assert.deepEqual(Object.keys(open), [], "the shared fold must be genuinely empty");

  const { state } = foldEvents(initialHeroState(3), wireEvents.map(toDomainEvent));
  assert.equal(state.roundEscalated, 2, "the round DID escalate twice — a fact the empty fold alone can't show");

  const html = renderToStaticMarkup(
    <NeedsAttention items={Object.values(open)} titles={{}} now={NOW} roundEscalated={state.roundEscalated} />,
  );
  assert.match(html, /2 escalations this round, all since resolved/);
});

test("#891 AC2: an empty fold with NO round escalations still renders nothing — the reconciliation sentence is not a permanent fixture", () => {
  const html = renderToStaticMarkup(<NeedsAttention items={[]} titles={{}} now={NOW} roundEscalated={0} />);
  assert.equal(html, "");
});

test("#891 AC3: the strip's header summary line matches the mockup's grammar — 'N waiting · oldest Xd · M dissent'", () => {
  const wireEvents: LoopEvent[] = [
    // Oldest — 5 days back.
    wire(1, "2026-08-05T12:00:00.000Z", "drive-needs-human", { pr: 1, issue: 10 }),
    // The one recorded dissent (`fix-leg-verdict-rerun` — the nearest real signal to the
    // mockup's illustrative DISSENT chip, per `copy.ts`'s `isDissentSignal`).
    wire(2, "2026-08-08T12:00:00.000Z", "fix-leg-verdict-rerun", { pr: 2, issue: 20 }),
    // Newest — 1 hour back.
    wire(3, "2026-08-10T11:00:00.000Z", "rollback-escalated", { issue: 30 }),
  ];
  const open = foldAt(wireEvents);
  assert.equal(Object.keys(open).length, 3);

  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /3 waiting · oldest 5d · 1 dissent/);
});
