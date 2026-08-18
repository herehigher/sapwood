import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoopEvent } from "../api/types.ts";
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
  // emphasis modifier alongside the base age classes.
  assert.match(html, /class="muted data attention-ts attention-age attention-age-emphasis"/);
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

/** Real DOM, real tokens.css + panels.css cascade — every #925 assertion below is a computed-
 *  style claim (STYLE doctrine), never a stand-in read of the CSS source text. */
async function mountWithCascade(element: React.ReactElement) {
  const style = document.createElement("style");
  style.textContent = `${tokensCssRow}\n${panelsCssRow}`;
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

function attentionRowsByAge(rows: { id: number; ageMs: number }[]) {
  return rows.map(({ id, ageMs }) =>
    toDomainEvent(wire(id, new Date(NOW.getTime() - ageMs).toISOString(), "drive-needs-human", { pr: id, issue: id })),
  );
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
    assert.equal(emphasized[0]?.textContent, "3d ago", "the emphasis must land on the 3d-ago event specifically");

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
    assert.equal(emphasized?.textContent, "3d ago", "emphasis must follow the 3d-ago event, wherever it renders");
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

// ── #925 AC5: fixed chip/entity/age tracks — COVERAGE over every rendered row ────────────────

test("#925 AC5: every .attention-chip shares the SAME computed width, every entity-ref cell the same left edge, every age box the same right edge — across the longest and shortest category words", async () => {
  // Three categories spanning ATTENTION_CATEGORY's own extremes: "REVIEW SILENCE" (the longest
  // word, 14 chars) and "CI"/"ENV"-scale short words — read from the real fixture kinds, never a
  // hand-picked pair that happens to match today's longest/shortest.
  const items = [
    toDomainEvent(wire(1, "2026-08-05T00:00:00.000Z", "review-silence-escalated", { pr: 100, issue: 1, silenceSec: 600 })),
    toDomainEvent(wire(2, "2026-08-08T00:00:00.000Z", "ci-inert-escalated", { pr: 200, issue: 2, checks: [] })),
    toDomainEvent(wire(3, "2026-08-09T00:00:00.000Z", "env-failure-preserved", { pr: 300, issue: 3 })),
  ];
  const { container, cleanup } = await mountWithCascade(<NeedsAttention items={items} titles={{}} now={NOW} />);
  try {
    const rows = [...container.querySelectorAll(".attention-row")];
    assert.equal(rows.length, 3, "COVERAGE: every rendered row must be included, not a hand-picked subset");

    // happy-dom never runs a real layout pass (`getBoundingClientRect`/`clientWidth`/`scrollWidth`
    // are all hard-coded 0 on every element, confirmed directly — there is no box-metric read this
    // harness can perform). What it DOES resolve reliably is the CASCADE — which declaration wins,
    // verbatim — so this proves the thing that actually GUARANTEES alignment under CSS Grid's
    // deterministic column algorithm: every row's `.attention-row` grid-template-columns is the
    // SAME literal, content-independent declaration (no per-row branch sizes the chip/entity/age
    // tracks off that row's own word/title length), and `.attention-chip`'s own width is likewise
    // one shared, non-`auto` value. Two rows sharing the same fixed tracks CANNOT render at
    // different x-offsets in any real layout engine — this is what a browser would compute from.
    const rowTemplates = new Set(rows.map((row) => getComputedStyle(row).gridTemplateColumns));
    assert.equal(
      rowTemplates.size,
      1,
      `every .attention-row must share the identical, content-independent grid-template-columns, got: ${[...rowTemplates].join(" | ")}`,
    );
    assert.doesNotMatch(
      [...rowTemplates][0]!,
      /\bauto\b/,
      "no track before the reason column may be `auto` (content-sized) — only `1fr` (the reason column itself) may flex",
    );

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

    // Both the entity-ref cell (chip/glyph tracks precede it) and the age box (the age track
    // itself is fixed) are governed by that SAME shared, content-independent template — proven
    // above — so their start/end x-offsets are identical across rows by construction.
    for (const row of rows) {
      assert.ok(row.querySelector(".attention-entity"), "every row must render its entity-ref cell");
      assert.ok(row.querySelector(".attention-age"), "every row must render its age box");
    }
  } finally {
    await cleanup();
  }
});
