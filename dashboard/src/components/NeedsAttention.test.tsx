import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
import { parseColorTokens as parseColorTokensLocal } from "../contrast.ts";
import { ATTENTION_CATEGORY } from "../copy.ts";
import { toDomainEvent } from "../domain-event.ts";
import { foldOpenAttention } from "../entities.ts";
import { foldEvents, initialHeroState } from "../hero/state.ts";
// #892: must resolve before "./NeedsAttention.tsx" (transitively imports Radix) — see this
// module's own doc for why.
import { unregisterRealDomEager } from "../test-dom-eager.ts";
import { NeedsAttention } from "./NeedsAttention.tsx";

test.after(() => unregisterRealDomEager());

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

// ── #924: the shared .panel-head recipe ─────────────────────────────────────────────────────────

test("#924 AC1: the populated strip's head carries .panel-head, with the summary stat cluster as its own .panel-head-stat last child", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(
    html,
    /<div class="attention-header panel-head"><h2>needs attention<\/h2><span class="muted data attention-summary panel-head-stat">/,
  );
});

// ── #925 gate① round-3 engine-agent finding [0] (ac4-entity-composition): the glyph precedes ONE
// uniformly-styled element carrying the COMPLETE "PR #NNN — title" string — never a "PR " literal
// or a title span composed as a separate sibling outside it (each would then escape the entity
// style, the exact defect the finding named — `entity.textContent` equality alone can't detect it,
// since text-content concatenation is identical either way; this asserts the actual markup shape).

test('gate① round-3 finding "ac4-entity-composition": the entity cell is exactly [glyph, ONE .attention-entity-ref element] — no sibling "PR " text or separate title span', () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{ 9102: { prTitle: "fix rounding" } }} now={NOW} />);
  // C1: the glyph now lives INSIDE `.attention-entity-ref` (a Radix `HintTooltip` trigger clones
  // exactly one child, so glyph+label share the one composed element) — still the ONLY styled
  // element in the cell, no sibling "PR " text or separate title span.
  assert.match(
    html,
    /<span class="attention-entity"><span class="attention-entity-ref data"[^>]*><svg[^>]*>[\s\S]*?<\/svg>PR #9202 — fix rounding<\/span><\/span>/,
    "the glyph must render INSIDE the one .attention-entity-ref element, nothing else in the cell",
  );
});

test('gate① round-3 finding "ac4-entity-composition": with a repoUrl, the SAME single composed string renders inside the anchor, not split around it', () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  const html = renderToStaticMarkup(
    <NeedsAttention items={[event]} titles={{ 9102: { prTitle: "fix rounding" } }} now={NOW} repoUrl="https://github.com/o/r" />,
  );
  assert.match(
    html,
    /<span class="attention-entity"><a class="attention-entity-ref data" href="https:\/\/github\.com\/o\/r\/pull\/9202"[^>]*><svg[^>]*>[\s\S]*?<\/svg>PR #9202 — fix rounding<\/a><\/span>/,
  );
});

// ── #881: category chip + reason/ask row shape (needs-attention-dark.png fidelity) ───────────

test("renders the row's category chip, matching the mockup's taxonomy", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>DECISION</);
});

test("renders a different chip label for a different category (CI)", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "ci-inert-escalated", { pr: 42, issue: 7, checks: [] }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>CI</);
});

// ── #893 / PR #900 gate② finding [1]: REVIEW SILENCE / DISSENT — folded through the REAL
// production history path (`toDomainEvent` parse boundary + `foldOpenAttention`, `foldAt`
// below), not a hand-classified `KnownDomainEvent` injected directly into `items`. A direct
// injection would stay green even if `hasAttention`/`openAttentionKey` failed to actually open a
// row for one of these kinds — folding first proves the kind really reaches `openAttention`, the
// same object `App.tsx` passes verbatim as `NeedsAttention`'s `items` prop (a real end-to-end
// wiring test lives in App.test.tsx, which additionally proves the `/api/events` → `App` half).

test("#893: review-silence-escalated reaches the strip and renders the REVIEW SILENCE chip", () => {
  const open = foldAt([wire(1, "2026-08-10T11:59:00.000Z", "review-silence-escalated", { pr: 42, issue: 7, silenceSec: 600 })]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>REVIEW SILENCE</);
  assert.match(html, /went unanswered/);
  assert.match(html, /asks: check the reviewer/);
});

test("#893: review-disputed reaches the strip and renders the DISSENT chip", () => {
  const open = foldAt([wire(1, "2026-08-10T11:59:00.000Z", "review-disputed", { pr: 42, issue: 7, worker: "w1" })]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>DISSENT</);
  assert.match(html, /successive reviews disagreed/);
});

test("#893: review-non-convergent ALSO renders the DISSENT chip — same category, different trigger", () => {
  const open = foldAt([wire(1, "2026-08-10T11:59:00.000Z", "review-non-convergent", { pr: 42, issue: 7, worker: "w1" })]);
  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>DISSENT</);
  assert.match(html, /failed to converge/);
});

test("renders no chip for an unrecognized event kind, never a fabricated label", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "some-future-kind-nobody-registered-yet", { pr: 42 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /attention-chip/);
});

test("row renders the mockup's shape — chip, reason + explicit ask, and a bordered age box", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "fix-rounds-capped", { pr: 9, issue: 1, fixRounds: 3, cap: 3 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /attention-chip"[^>]*>FIX CAP/);
  assert.match(html, /\(3\/3\)/);
  assert.match(html, /asks: adjudicate/);
  // #925 AC2: the only row in the fold is trivially the greatest-age one, so it carries the
  // emphasis modifier alongside the base age classes. gate① engine-agent finding [1]: no
  // `.muted` here — it would silently lose the cascade to `.attention-age-emphasis`'s own colour
  // override (equal specificity, `.muted` loads later), so the emphasis box drops it entirely.
  assert.match(html, /class="data attention-age attention-age-emphasis"/);
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
    // The one recorded dissent — `review-disputed`, one of the two real kinds `copy.ts`'s
    // `ATTENTION_CATEGORY` classifies DISSENT (`isDissentSignal`'s own source of truth).
    wire(2, "2026-08-08T12:00:00.000Z", "review-disputed", { pr: 2, issue: 20 }),
    // Newest — 1 hour back.
    wire(3, "2026-08-10T11:00:00.000Z", "rollback-escalated", { issue: 30 }),
  ];
  const open = foldAt(wireEvents);
  assert.equal(Object.keys(open).length, 3);

  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /3 waiting · oldest 5d · 1 dissent/);
});

// #925 AC4 follow-up: the header's "oldest" figure used to floor to whole days — a fold whose
// oldest item is only hours old (a real `?demo` idle-state shape, since B3's demo-clock fix)
// read "oldest 0d", contradicting the row right below it plainly showing "3h". The header now
// shares NeedsAttention's own `formatCompactAge` unit ladder via `attentionSummary`, so it reads
// the SAME magnitude the emphasized row does.
test('#925 AC4: the header "oldest" figure reads the compact age (e.g. "oldest 3h"), never floored to "oldest 0d", for a sub-day-old fold', () => {
  const wireEvents: LoopEvent[] = [
    // Oldest — 3 hours back.
    wire(1, "2026-08-10T09:00:00.000Z", "fix-rounds-capped", { issue: 10, pr: 1, fixRounds: 3, cap: 3 }),
    // Newest — 10 minutes back.
    wire(2, "2026-08-10T11:50:00.000Z", "drive-needs-human", { pr: 2, issue: 20 }),
  ];
  const open = foldAt(wireEvents);
  assert.equal(Object.keys(open).length, 2);

  const html = renderToStaticMarkup(<NeedsAttention items={Object.values(open)} titles={{}} now={NOW} />);
  assert.match(html, /2 waiting · oldest 3h · 0 dissent/);
});

// ── #892 AC1: the attention-age tooltip (was a bare `title=`) is a real Radix tooltip now —
// Tab-reachable, content visible/queryable on focus. ──────────────────────────────────────────

test("real DOM: the attention-age trigger is Tab-reachable and its tooltip (the absolute timestamp) opens on focus", async () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
    });
    const trigger = container.querySelector(".attention-age") as HTMLElement;
    assert.ok(trigger, "the age trigger renders");
    assert.equal(trigger.tabIndex, 0, "must be a real tab stop — a bare title= was pointer-only");
    assert.equal(container.querySelector('[role="tooltip"]'), null, "not open before any interaction");

    await act(async () => {
      trigger.focus();
    });

    const tooltip = container.querySelector('[role="tooltip"]');
    assert.ok(tooltip, "focusing the trigger opens the tooltip");
    assert.equal(trigger.getAttribute("aria-describedby"), tooltip?.id);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── #925: row anatomy — severity/chip/entity/age-emphasis/COVERAGE alignment ────────────────

const tokensCssRow = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const panelsCssRow = readFileSync(new URL("../panels.css", import.meta.url), "utf8");
const heroCssRow = readFileSync(new URL("../hero/hero.css", import.meta.url), "utf8");
// #925 gate① round-3 engine-agent finding [3] (ac5-layout-not-measured): mounting only
// tokens.css+panels.css let an app.css rule this row also depends on go untested. Full production
// order (tokens → panels → hero → app, app.css's own `@import` order — same posture App.test.tsx's
// own `mountAppWithCascade` already takes); `@import` lines resolve under Vite's bundler only, so
// they're stripped the same way that helper strips them for happy-dom's plain <style> injection.
const appCssRow = readFileSync(new URL("../app.css", import.meta.url), "utf8").replace(/^@import.*$/gm, "");

/** Real DOM, FULL production cascade (tokens → panels → hero → app) — every #925 assertion below
 *  is a computed-style claim (STYLE doctrine), never a stand-in read of the CSS source text. */
async function mountWithCascade(element: React.ReactElement) {
  const style = document.createElement("style");
  style.textContent = `${tokensCssRow}\n${panelsCssRow}\n${heroCssRow}\n${appCssRow}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      document.head.removeChild(style);
    },
  };
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FORTY_FIVE_MIN_MS = 45 * 60 * 1000;

// #925 gate① engine-agent finding [1] (ac2-bypasses-fold): a hand-built `toDomainEvent` array
// fed straight into `<NeedsAttention>` proves the component's own max-age arithmetic but never
// that a REAL `foldOpenAttention` collection (issue-keyed, `Object.values` order) still carries
// the ages/positions this test depends on — folded through the SAME production path #893's own
// tests already use (`foldAt`, above), never a direct construction.
function attentionRowsByAge(rows: { id: number; ageMs: number }[]) {
  const wireEvents: LoopEvent[] = rows.map(({ id, ageMs }) =>
    wire(id, new Date(NOW.getTime() - ageMs).toISOString(), "drive-needs-human", { pr: id, issue: id }),
  );
  return Object.values(foldAt(wireEvents));
}

test("#925 AC2: the row with the greatest age (3d) renders its age box at >=2x the height and font-size of the others (2h, 45m), regardless of render order", async () => {
  // id assigned so the OLDEST event (id=1) does NOT sort first — `NeedsAttention`'s own `sorted`
  // is descending by id, so a bug that always emphasised whichever row rendered first would still
  // pass a naively-ordered fixture.
  const items = attentionRowsByAge([
    { id: 3, ageMs: TWO_HOURS_MS },
    { id: 2, ageMs: FORTY_FIVE_MIN_MS },
    { id: 1, ageMs: THREE_DAYS_MS },
  ]);
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const ageBoxes = [...container.querySelectorAll(".attention-age")];
    assert.equal(ageBoxes.length, 3);
    const emphasized = ageBoxes.filter((el) => el.classList.contains("attention-age-emphasis"));
    assert.equal(emphasized.length, 1, "exactly one row must carry the emphasis modifier");
    const others = ageBoxes.filter((el) => !el.classList.contains("attention-age-emphasis"));
    assert.equal(others.length, 2);
    // B1 (#925 AC4): the emphasis box renders the COMPACT age ("3d", no " ago") — the small
    // boxes below keep the full form (asserted on `others` via their own age arithmetic already).
    assert.equal(emphasized[0]?.textContent, "3d", "the emphasis must land on the 3d-ago event specifically, in compact form");

    const emphasizedHeight = Number.parseFloat(getComputedStyle(emphasized[0] as Element).minHeight);
    const emphasizedFontSize = Number.parseFloat(getComputedStyle(emphasized[0] as Element).fontSize);
    for (const other of others) {
      const otherComputed = getComputedStyle(other as Element);
      const otherHeight = Number.parseFloat(otherComputed.minHeight);
      const otherFontSize = Number.parseFloat(otherComputed.fontSize);
      assert.ok(
        emphasizedHeight >= otherHeight * 2,
        `emphasized height (${emphasizedHeight}) must be >= 2x "${other.textContent}"'s (${otherHeight})`,
      );
      assert.ok(
        emphasizedFontSize >= otherFontSize * 2,
        `emphasized font-size (${emphasizedFontSize}) must be >= 2x "${other.textContent}"'s (${otherFontSize})`,
      );
    }
  } finally {
    await cleanup();
  }
});

test("#925 AC2: with a single row, that row is the emphasised one", async () => {
  const items = attentionRowsByAge([{ id: 1, ageMs: FORTY_FIVE_MIN_MS }]);
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const ageBox = container.querySelector(".attention-age");
    assert.ok(ageBox, "the age box must render");
    assert.ok(ageBox?.classList.contains("attention-age-emphasis"), "the lone row must carry the emphasis modifier");
  } finally {
    await cleanup();
  }
});

test("#925 AC2: the emphasis follows the greatest age when the fixture reorders which event is oldest", async () => {
  // Same three ages as the first test above, but under DIFFERENT ids/positions — proves the
  // emphasis is computed from age, not memorized from row position.
  const items = attentionRowsByAge([
    { id: 10, ageMs: FORTY_FIVE_MIN_MS },
    { id: 20, ageMs: THREE_DAYS_MS },
    { id: 30, ageMs: TWO_HOURS_MS },
  ]);
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const emphasized = container.querySelector(".attention-age-emphasis");
    assert.ok(emphasized, "one row must carry the emphasis modifier");
    assert.equal(emphasized?.textContent, "3d", "emphasis must follow the 3d-ago event (compact form), wherever it renders");
  } finally {
    await cleanup();
  }
});

// ── #925 AC3: colour is never the sole carrier; the severity element is aria-hidden ─────────

test("#925 AC3: a DISSENT row (--sap-text tone) still names its category in the chip's own text, and the severity element is aria-hidden", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "review-disputed", { pr: 42, issue: 7, worker: "w1" }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>DISSENT</, "the category must be readable as TEXT, not colour alone");
  assert.match(html, /class="attention-severity" aria-hidden="true"/);
});

test("#925 AC3: a DECISION row (--rust tone) still names its category in the chip's own text, and the severity element is aria-hidden", () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 42, issue: 7 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>DECISION</);
  assert.match(html, /class="attention-severity" aria-hidden="true"/);
});

// ── #925 AC5: fixed chip/entity/age tracks — FAST STRUCTURAL GUARD only; the actual geometry ──
// proof is dashboard/shots/shots.spec.ts's Playwright spec (real Chromium layout, real
// boundingBox()/scrollWidth/clientWidth reads at the ?demo fixture's real >=3 rows). This test
// exists to fail FAST, on every `npm test`, before a PR ever reaches the slower `npm run shots`
// run — it proves a structural invariant that's necessary for the real geometry to hold, not the
// geometry itself. (PM 2026-08-18, in response to gate① round-3 finding [3].)

/**
 * #925 gate① round-3 engine-agent finding [3] (ac5-layout-not-measured): happy-dom never runs a
 * real layout pass — confirmed directly against this exact harness (`GlobalRegistrator`,
 * happy-dom 20.11.2): `getBoundingClientRect`/`offsetLeft`/`scrollWidth`/`clientWidth` all read
 * back hard-coded zero on every element, real DOM or not. There is no box-metric read this test
 * runner can perform — adding one would mean a second, browser-backed test harness (Playwright/a
 * real headless browser) for one file, which is new machinery a vitest-only fix would want to
 * avoid; `dashboard/shots/shots.spec.ts` already IS that browser-backed harness for this repo, so
 * the real measurement lives there instead (its own "#925 AC5 (REAL measurement...)" test).
 *
 * What happy-dom DOES resolve faithfully is the CASCADE: which declaration wins, verbatim, on
 * every element. That is provably sufficient for a FAST guard, not a fallback for the real proof:
 * CSS Grid's column-sizing algorithm is DETERMINISTIC — a track's start/end offset depends only on
 * the tracks strictly before it, never on that track's own or a later track's content.
 * `.attention-row`'s template is `4px | <chip, fixed> | <entity, 1fr> | <reason, minmax(auto,40%)>
 * | <age, 96px fixed>`:
 *   - the entity cell's LEFT edge depends only on the severity (4px) and chip tracks, both fixed,
 *     literal, and — proven below — IDENTICAL across every row's own template string. Two rows
 *     sharing that identical prefix cannot start their entity cell at different x-offsets in any
 *     real layout engine, regardless of how the entity/reason split resolves afterward.
 *   - the age box's RIGHT edge is the row's own right edge, because age is the LAST track and a
 *     fixed 96px (never `fr`/`%`/`auto`) — it never participates in free-space distribution, so
 *     its right edge is always exactly 96px + the row's own padding/border in from the row's own
 *     right edge, identical for every row at the same container width.
 *   - the chip's own width is the SAME shared, non-`auto`, non-computed CSS custom property on
 *     every row (never sized off that row's own category word).
 * A regression that broke any of these would ALSO fail the real Playwright measurement, but this
 * catches it on every `npm test` run, seconds instead of the shots suite's tens of seconds.
 */
test("#925 AC5 fast structural guard (see shots.spec.ts for the real geometry measurement): chip width, entity-cell left edge, and age-box right edge are all fixed-track invariants, plus the longest category word structurally fits its chip", async () => {
  // Three categories spanning ATTENTION_CATEGORY's own extremes: "REVIEW SILENCE" (the longest
  // word) and "CI" (the shortest) — read from the real fixture kinds, never a hand-picked pair
  // that happens to match today's longest/shortest.
  const items = [
    toDomainEvent(wire(1, "2026-08-05T00:00:00.000Z", "review-silence-escalated", { pr: 100, issue: 1, silenceSec: 600 })),
    toDomainEvent(wire(2, "2026-08-08T00:00:00.000Z", "ci-inert-escalated", { pr: 200, issue: 2, checks: [] })),
    toDomainEvent(wire(3, "2026-08-09T00:00:00.000Z", "env-failure-preserved", { pr: 300, issue: 3 })),
  ];
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const rows = [...container.querySelectorAll(".attention-row")];
    assert.equal(rows.length, 3, "COVERAGE: every rendered row must be included, not a hand-picked subset");

    const rowTemplates = new Set(rows.map((row) => getComputedStyle(row).gridTemplateColumns));
    assert.equal(
      rowTemplates.size,
      1,
      `every .attention-row must share the identical, content-independent grid-template-columns, got: ${[...rowTemplates].join(" | ")}`,
    );
    const template = [...rowTemplates][0]!;
    const tracks = template.trim().split(/\s+(?![^(]*\))/); // split on top-level whitespace only, not inside minmax()/calc()
    assert.equal(tracks.length, 5, `expected exactly 5 tracks (severity/chip/entity/reason/age), got: ${template}`);
    const [severityTrack, chipTrack, entityTrack, reasonTrack, ageTrack] = tracks;

    // Severity + chip precede the entity cell — both fixed, neither `fr`/`%`/`auto` on their own,
    // so the entity cell's left edge is pinned by construction (the argument above).
    assert.equal(severityTrack, "4px", "the severity bar must be a literal fixed width");
    assert.doesNotMatch(chipTrack!, /^(auto|.*fr$)/, "the chip track must be a fixed, non-flexible size");
    // Entity is the row's ONE flexible track — it, and only it, may consume free space.
    assert.equal(entityTrack, "1fr", "the entity cell must be the row's sole flexible track");
    assert.match(reasonTrack!, /^minmax\(auto,/, "the reason column keeps a content-driven floor so it can never be squeezed to nothing");
    // Age is the LAST track and fixed — its right edge is always the row's own right edge.
    assert.equal(ageTrack, "96px", "the age box must be a literal fixed width, and the row's trailing track");

    const chips = rows.map((row) => row.querySelector(".attention-chip") as HTMLElement);
    assert.ok(
      chips.every((chip) => chip),
      "every row must render a chip",
    );
    const chipWidths = new Set(chips.map((chip) => getComputedStyle(chip).width));
    assert.equal(chipWidths.size, 1, `every .attention-chip must share the same declared width, got: ${[...chipWidths].join(", ")}`);
    assert.doesNotMatch([...chipWidths][0]!, /^auto$/, ".attention-chip's width must be a fixed value, never content-sized `auto`");

    // The longest word ("REVIEW SILENCE") must never wrap onto a second line inside its box.
    const longestChip = chips.find((chip) => chip.textContent === "REVIEW SILENCE");
    assert.ok(longestChip, "the REVIEW SILENCE fixture row must render its chip");
    assert.equal(getComputedStyle(longestChip as HTMLElement).whiteSpace, "nowrap");

    // "the fixture's longest word still fits on one line inside the chip" — happy-dom can't
    // measure rendered text width (above), so this proves the load-bearing DESIGN invariant
    // instead: the chip track's own `ch` coefficient (panels.css's `--attention-chip-w: calc(Nch +
    // 26px)`) must be sized to at least as many characters as ATTENTION_CATEGORY's OWN longest
    // real word — read from the taxonomy itself, never a hand-copied number that can drift out of
    // sync with a future category addition.
    const chCoefficient = Number(chipTrack!.match(/calc\((\d+)ch/)?.[1]);
    assert.ok(
      Number.isFinite(chCoefficient) && chCoefficient > 0,
      `chip track must be a \`calc(Nch + ...)\` expression, got: ${chipTrack}`,
    );
    const longestCategoryWord = Math.max(...Object.values(ATTENTION_CATEGORY).map((word) => word.length));
    assert.ok(
      chCoefficient >= longestCategoryWord,
      `the chip's ch-width (${chCoefficient}) must cover ATTENTION_CATEGORY's own longest word ("${
        Object.values(ATTENTION_CATEGORY).sort((a, b) => b.length - a.length)[0]
      }", ${longestCategoryWord} chars) — a future category addition longer than this must bump the CSS constant too`,
    );

    // Both the entity-ref cell (severity/chip tracks precede it) and the age box (the age track
    // itself is fixed and trailing) are governed by that SAME shared, content-independent
    // template — proven above — so their left/right x-offsets are identical across rows.
    for (const row of rows) {
      assert.ok(row.querySelector(".attention-entity"), "every row must render its entity-ref cell");
      assert.ok(row.querySelector(".attention-age"), "every row must render its age box");
    }
  } finally {
    await cleanup();
  }
});

// #925 gate① round-3 engine-agent finding [3]: the reason track's own `auto` minimum must stay a
// mutation-check anchor — a track sizing regression that DROPPED the flexible split (e.g. reverting
// both entity and reason to fixed pixel tracks) would still pass a template-equality-only check.
test("#925 AC5 mutation-anchor: the entity track is the row's ONLY `1fr` track — asserts the flex split is exactly one track wide, not zero or two", async () => {
  const items = [toDomainEvent(wire(1, "2026-08-05T00:00:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }))];
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const row = container.querySelector(".attention-row") as HTMLElement;
    const template = getComputedStyle(row).gridTemplateColumns;
    const frTrackCount = (template.match(/(?:^|\s)1fr(?:\s|$)/g) ?? []).length;
    assert.equal(frTrackCount, 1, `exactly one track may be \`1fr\` (the entity cell), got ${frTrackCount} in: ${template}`);
  } finally {
    await cleanup();
  }
});

// #925 gate① engine-agent finding [3] (inspect-control-breaks-grid): a mapped kind rendered with
// `onInspect` (App's own real production wiring for plan-review-escalated/verify-na-proposed/
// ci-inert-escalated) used to add a 6th direct grid child, auto-placing the age box into a
// SECOND implicit grid row instead of the fixed right-edge track — invisible to the AC5 test
// above, which mounts without `onInspect` and never covers this shape. Mixes an unmapped kind
// (no inspect control, no chip) alongside a mapped one WITH `onInspect` in the SAME fixture, so
// the fixed-track invariant is proven across every combination of optional content a real row
// can carry, not just the nominal case.
test("#925 gate① finding [3]: a row rendered WITH onInspect (a real mapped kind) keeps exactly 5 direct grid children and the SAME grid-template-columns as a row with no chip and no inspect control", async () => {
  const items = [
    // Mapped kind + onInspect: severity, category(chip), entity, reason(sentence+button), age.
    toDomainEvent(wire(1, "2026-08-09T00:00:00.000Z", "plan-review-escalated", { issue: 1 })),
    // Unmapped kind, no onInspect target, no chip: severity, category(empty), entity(empty),
    // reason(sentence only), age — still exactly 5 cells.
    toDomainEvent(wire(2, "2026-08-08T00:00:00.000Z", "some-future-kind-nobody-registered-yet", { pr: 2 })),
  ];
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} onInspect={() => {}} />);
  try {
    const rows = [...container.querySelectorAll(".attention-row")];
    assert.equal(rows.length, 2);

    const inspectButton = container.querySelector(".attention-inspect");
    assert.ok(inspectButton, "the mapped row must render its inspect control");
    const inspectRow = inspectButton!.closest(".attention-row") as HTMLElement;
    assert.ok(inspectRow, "the inspect control must live inside an .attention-row");

    for (const row of rows) {
      assert.equal(
        [...row.children].length,
        5,
        `every .attention-row must have exactly 5 direct children (severity, category, entity, reason, age) — got ${[...row.children].map((c) => c.className).join(", ")}`,
      );
    }

    const templates = new Set(rows.map((row) => getComputedStyle(row).gridTemplateColumns));
    assert.equal(
      templates.size,
      1,
      `the mapped row's grid-template-columns must be IDENTICAL to the unmapped row's, got: ${[...templates].join(" | ")}`,
    );

    // The inspect button must sit inside the SAME cell as the sentence (the reason column) —
    // never as its own direct grid child, which is what pushed the age box into a second row.
    assert.ok(inspectButton!.closest(".attention-reason"), "the inspect control must live inside .attention-reason");
    assert.equal(
      inspectButton!.parentElement?.querySelector(".attention-sentence")?.parentElement,
      inspectButton!.parentElement,
      "the inspect control and the sentence must share the same parent cell",
    );

    // The age box of the row WITH the inspect control must still be a direct grid child (Radix's
    // `asChild` trigger clone leaves no wrapper node) — never nested inside .attention-reason
    // alongside the button.
    const inspectRowAge = inspectRow.querySelector(".attention-age");
    assert.ok(inspectRowAge, "the mapped row must still render its age box");
    assert.equal(
      (inspectRowAge as HTMLElement).parentElement,
      inspectRow,
      "the age box must be a direct child of .attention-row, not nested inside .attention-reason",
    );
  } finally {
    await cleanup();
  }
});

// ── #925 gate① round 2 engine-agent finding "sentence-prefix-dropped": the reason cell must
// never slice text out of the sentence — copy.ts's own shapes don't guarantee the entity token is
// a leading prefix. ────────────────────────────────────────────────────────────────────────────

test('gate① finding "sentence-prefix-dropped": gated-flag-unprovable (entity token mid-sentence) renders its FULL sentence in the reason cell, none of it dropped', () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "gated-flag-unprovable", { worker: "w1", issue: 42 }));
  const html = renderToStaticMarkup(<NeedsAttention items={[event]} titles={{}} now={NOW} />);
  assert.match(html, /class="attention-chip"[^>]*>FLAG</);
  // The text BEFORE the entity token (the reason's own subject/verb) must survive — the exact
  // defect the finding named: a prior version discarded this text along with the token itself.
  // React HTML-escapes the apostrophe as `&#x27;`, so the raw text is split across those escapes.
  assert.match(html, /Lane <\/span><span>w1<\/span><span>&#x27;s reentry flag couldn&#x27;t be found on either carrier/);
  assert.match(html, /asks: check issue/);
  assert.match(html, /&#x27;s labels by hand/);
});

// ── #925 gate① round 2 engine-agent finding "ac4-age-box": the emphasis box's numeral/border use
// the primary-text role (not muted), stay single-line, and the row is tall enough that the box
// itself is at most two-thirds of the row's own height. ──────────────────────────────────────

test('gate① finding "ac4-age-box": the emphasis box resolves --attention-emphasis-text (not --bark-text) for both colour and border, never wraps, and its own height is at most 2/3 of the row height', async () => {
  const items = attentionRowsByAge([{ id: 1, ageMs: THREE_DAYS_MS }]);
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  const expectedEmphasisText = parseColorTokensLocal(tokensCssRow).dark["--attention-emphasis-text"];
  const expectedMuted = parseColorTokensLocal(tokensCssRow).dark["--bark-text"];
  try {
    const row = container.querySelector(".attention-row") as HTMLElement;
    assert.ok(row, "the row must render");
    assert.ok(row.classList.contains("attention-row-emphasis"), "the sole row must carry the emphasis row modifier");

    const box = container.querySelector(".attention-age-emphasis") as HTMLElement;
    assert.ok(box, "the emphasis box must render");
    assert.ok(!box.classList.contains("muted"), ".muted would silently lose the cascade to the emphasis box's own colour override");

    const boxComputed = getComputedStyle(box);
    assert.equal(boxComputed.whiteSpace, "nowrap", "the age text must never wrap onto a second line");
    assert.equal(
      boxComputed.color.toUpperCase(),
      expectedEmphasisText,
      "the numeral must resolve the primary-text role, not muted --bark-text",
    );
    assert.notEqual(boxComputed.color.toUpperCase(), expectedMuted, "must NOT resolve to --bark-text");
    assert.equal(boxComputed.borderColor.toUpperCase(), expectedEmphasisText, "the border must resolve the SAME primary-text role");

    const rowMinHeight = Number.parseFloat(getComputedStyle(row).minHeight);
    const boxMinHeight = Number.parseFloat(boxComputed.minHeight);
    assert.ok(
      boxMinHeight <= rowMinHeight * (2 / 3),
      `the box's own height (${boxMinHeight}) must be at most 2/3 of the row's height (${rowMinHeight}, 2/3 = ${rowMinHeight * (2 / 3)})`,
    );
  } finally {
    await cleanup();
  }
});

// ── #925 AC4: B1 compact emphasis age, B2 styled entity ref, C1 entity tooltip ───────────────

test("B1: the emphasis box's text always matches /^\\d+[smhd]$/ — the bare compact age, never the small boxes' ' ago' full form", async () => {
  const items = attentionRowsByAge([
    { id: 3, ageMs: TWO_HOURS_MS },
    { id: 2, ageMs: FORTY_FIVE_MIN_MS },
    { id: 1, ageMs: THREE_DAYS_MS },
  ]);
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const emphasized = container.querySelector(".attention-age-emphasis");
    assert.ok(emphasized, "one row must carry the emphasis modifier");
    assert.match(
      emphasized?.textContent ?? "",
      /^\d+[smhd]$/,
      `the emphasis text must be a bare compact age (no " ago"), got: "${emphasized?.textContent}"`,
    );
  } finally {
    await cleanup();
  }
});

test("B2: .attention-entity-ref (both the <span> and <a> variants) resolves the SAME cream --attention-emphasis-text colour and is never underlined, in both themes", async () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  // `--attention-emphasis-text` itself is declared as 3 separate literal-hex overrides (never a
  // single `light-dark()` call — same happy-dom-testability posture as --attention-tone-rust/
  // -review/-reason-text above), so `parseColorTokensLocal` can't split IT into dark/light (it
  // only splits genuine `light-dark(...)` values). `--sapwood` is the token it MIRRORS
  // (tokens.css's own comment on `--attention-emphasis-text`, and `tokens.test.ts`'s "AC1/AC4"
  // pin) — read the expected per-theme hexes from that source of truth instead.
  const { light, dark } = parseColorTokensLocal(tokensCssRow);
  const expectedDark = dark["--sapwood"]!;
  const expectedLight = light["--sapwood"]!;

  for (const repoUrl of [undefined, "https://github.com/o/r"] as const) {
    const { container, cleanup } = await mountWithCascade(
      <NeedsAttention items={[event]} titles={{ 9102: { prTitle: "fix rounding" } }} now={NOW} repoUrl={repoUrl} />,
    );
    try {
      const ref = container.querySelector(".attention-entity-ref") as HTMLElement;
      assert.ok(ref, "the entity-ref element must render");
      assert.equal(ref.tagName, repoUrl ? "A" : "SPAN", "element kind must match whether a repoUrl is present");

      document.documentElement.setAttribute("data-theme", "heartwood");
      let computed = getComputedStyle(ref);
      assert.equal(
        computed.color.toUpperCase(),
        expectedDark,
        `dark theme (${ref.tagName}): must resolve the row's own cream primary-text colour, not a UA link colour`,
      );
      assert.equal(computed.textDecoration, "none", `dark theme (${ref.tagName}): must never underline`);

      document.documentElement.setAttribute("data-theme", "sapwood");
      computed = getComputedStyle(ref);
      assert.equal(
        computed.color.toUpperCase(),
        expectedLight,
        `light theme (${ref.tagName}): must resolve the row's own cream primary-text colour, not a UA link colour`,
      );
      assert.equal(computed.textDecoration, "none", `light theme (${ref.tagName}): must never underline`);
    } finally {
      document.documentElement.removeAttribute("data-theme");
      await cleanup();
    }
  }
});

test('C1: the composed entity trigger (glyph + label) is Tab-reachable and its tooltip reveals the FULL "PR #N — title" label', async () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<NeedsAttention items={[event]} titles={{ 9102: { prTitle: "fix rounding" } }} now={NOW} />);
    });
    const trigger = container.querySelector(".attention-entity-ref") as HTMLElement;
    assert.ok(trigger, "the entity trigger renders");
    assert.equal(trigger.tabIndex, 0, "must be a real tab stop — a folded title needs a keyboard path, not hover-only");
    assert.equal(container.querySelector('[role="tooltip"]'), null, "not open before any interaction");

    await act(async () => {
      trigger.focus();
    });

    const tooltip = container.querySelector('[role="tooltip"]');
    assert.ok(tooltip, "focusing the trigger opens the tooltip");
    assert.match(
      tooltip?.textContent ?? "",
      /PR #9202 — fix rounding/,
      "the tooltip must carry the FULL composed label — replacing EntityRef dropped this reveal path, C1's own regression",
    );
    assert.equal(trigger.getAttribute("aria-describedby"), tooltip?.id);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── #925 gate① round-3 engine-agent finding [1] (ac4-entity-clipping): the round-2 fix
// over-corrected — it grew the entity track without bound and disabled clipping entirely, so a
// long title could paint across the reason column instead of stopping at its edge. The title must
// consume free space while there is any, and truncate via CSS ellipsis exactly once the reason
// column's own track is reached — never earlier (a short title), never by JS string-slicing. ────

test('gate① round-3 finding "ac4-entity-clipping": a long title truncates via CSS ellipsis, the DOM always keeps the FULL text, and the reason column keeps its own non-zero floor', async () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  const longTitle = "a substantially long PR title meant to exceed the entity column's own available space by a wide margin";
  const { container, cleanup } = await mountWithCascade(
    <NeedsAttention items={[event]} titles={{ 9102: { prTitle: longTitle } }} now={NOW} />,
  );
  try {
    const entity = container.querySelector(".attention-entity") as HTMLElement;
    assert.ok(entity, "the entity cell must render");
    assert.equal(
      entity.textContent,
      `PR #9202 — ${longTitle}`,
      "the FULL title is always in the DOM — truncation is a CSS visual effect, never a JS string slice",
    );

    // The truncation mechanism itself: the entity cell clips its OWN overflow once its `1fr` track
    // runs out of room, rather than letting a long title paint into or push out the reason column.
    const entityComputed = getComputedStyle(entity);
    assert.equal(entityComputed.overflow, "hidden", "the entity cell must clip once its 1fr track's available space runs out");
    assert.equal(entityComputed.textOverflow, "ellipsis", "clipped content must ellipsize, never just vanish mid-character");
    assert.equal(entityComputed.whiteSpace, "nowrap", "still a single line — nowrap only wraps, it never itself clips");
    assert.equal(
      Number.parseFloat(entityComputed.minWidth),
      0,
      "a grid item's default min-width:auto would override the ellipsis and never let this cell shrink below its own content",
    );

    // The reason column's own `minmax(auto, 40%)` floor (panels.css) is a fixture of the row's
    // shared, content-independent template — a long title can only consume the ENTITY track's own
    // `1fr`, never the reason track's track FUNCTION itself, regardless of the title's length.
    const row = container.querySelector(".attention-row") as HTMLElement;
    assert.match(
      getComputedStyle(row).gridTemplateColumns,
      /minmax\(auto, 40%\)/,
      "the reason column keeps its own content-driven floor regardless of the entity title's length",
    );
    const reason = container.querySelector(".attention-reason") as HTMLElement;
    assert.ok(
      reason?.textContent && reason.textContent.length > 0,
      "the reason cell must still render its own content — never squeezed to nothing by a long title",
    );
  } finally {
    await cleanup();
  }
});

test('gate① round-3 finding "ac4-entity-clipping": a short title renders in full under the SAME static CSS — never a JS length-conditional branch', async () => {
  const event = toDomainEvent(wire(1, "2026-08-10T11:59:00.000Z", "drive-needs-human", { pr: 9202, issue: 9102 }));
  const shortTitle = "fix typo";
  const { container, cleanup } = await mountWithCascade(
    <NeedsAttention items={[event]} titles={{ 9102: { prTitle: shortTitle } }} now={NOW} />,
  );
  try {
    const entity = container.querySelector(".attention-entity") as HTMLElement;
    assert.equal(
      entity.textContent,
      `PR #9202 — ${shortTitle}`,
      "a short title renders in full — truncated only when the reason column is actually reached, never while free space remains",
    );

    // The SAME overflow/ellipsis/nowrap declarations as the long-title case above — the mechanism
    // is passive CSS that only visually activates once content exceeds the resolved track width;
    // NeedsAttention.tsx has no title-length branch that would need its own, separate coverage.
    const entityComputed = getComputedStyle(entity);
    assert.equal(entityComputed.overflow, "hidden");
    assert.equal(entityComputed.textOverflow, "ellipsis");
    assert.equal(entityComputed.whiteSpace, "nowrap");
  } finally {
    await cleanup();
  }
});
