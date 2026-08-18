import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane } from "./api/types.ts";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { Controls } from "./components/Controls.tsx";
import { LaneBoard } from "./components/LaneBoard.tsx";
import type { EventKind } from "./copy.ts";
import type { KnownDomainEvent } from "./domain-event.ts";

/**
 * #892 AC4: the `.recipe-drawer`/`.recipe-list-entry`/`.recipe-press` motion recipes
 * (frontend-design.md §2 adjudication log) are applied to their target components — a
 * grep-level check confirms no bare millisecond duration is introduced on the touched
 * components (`--beat`/`--tap`, from tokens.css, are the only legitimate duration source).
 */

function readCss(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no ${selector} rule found`);
  return match![1]!;
}

const panelsCss = readCss("./panels.css");
const appCss = readCss("./app.css");

test("the three motion-recipe classes exist and use only token-scoped durations, never a bare millisecond", () => {
  for (const selector of [".recipe-drawer[open]", ".recipe-list-entry", ".recipe-press", ".recipe-press:active"]) {
    const rule = cssBlock(panelsCss, selector);
    assert.doesNotMatch(rule, /\b\d+ms\b/, `${selector} must route its duration through var(--beat)/var(--tap), not a bare ms value`);
  }
});

test(".recipe-drawer[open] transitions off --beat (the state-flip token), never --travel (hero token movement) or a bare value", () => {
  const rule = cssBlock(panelsCss, ".recipe-drawer[open]");
  assert.match(rule, /var\(--beat\)/);
});

test(".recipe-press transitions off --tap (deliberately shorter than --beat — a press is felt, not narrated)", () => {
  const rule = cssBlock(panelsCss, ".recipe-press");
  assert.match(rule, /var\(--tap\)/);
});

// ── target components actually carry the recipe classes (component source, not just CSS) ──────
//
// #892 AC4: a "does this string appear anywhere in the file" check can't tell two candidate sites
// apart — it stays green even if one site loses the class while a sibling site keeps it. Every
// target below has exactly one recipe-bearing element in its file, so a file-wide match IS
// genuinely per-site for these. `Controls.tsx` (Confirm and Cancel are two separate buttons in
// its confirm dialog) and `ActivityFeed.tsx` (the attention/ordinary rows are two branches of one
// ternary) do NOT have that property — they get real rendered-markup, per-site assertions further
// below instead of an entry here.

const targets: { file: string; className: string }[] = [
  { file: "./components/ConfigDrawer.tsx", className: "recipe-drawer" },
  { file: "./components/ConfigDrawer.tsx", className: "recipe-press" },
  { file: "./components/PhaseInspectorDrawer.tsx", className: "recipe-drawer" },
  { file: "./components/PhaseInspectorDrawer.tsx", className: "recipe-press" },
  { file: "./components/Controls.tsx", className: "recipe-drawer" },
  { file: "./components/NeedsAttention.tsx", className: "recipe-list-entry" },
  { file: "./hero/Legend.tsx", className: "recipe-press" },
];

test("every single-site migrated dialog/list/press component's source carries its target motion-recipe class", () => {
  for (const { file, className } of targets) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches either a plain `className="…"` literal or a `className={…}` expression whose own
    // literal text carries the class name — either way this only matches when the class name is
    // genuinely present in the attribute, so removing it still fails this assertion.
    assert.match(
      source,
      new RegExp(`className=(?:"[^"]*\\b${escaped}\\b[^"]*"|\\{[^{}]*\\b${escaped}\\b[^{}]*\\})`),
      `${file} must apply .${className}`,
    );
  }
});

// ── per-site rendered-markup checks: components with more than one candidate class site ────────
//
// #892 AC4: renders the REAL component (not a hand-built markup stand-in) so each assertion is
// tied to the actual class list React puts on the actual element — the only way to prove BOTH
// sites still carry the class rather than just one of them somewhere in the file.

function elementHtml(html: string, tag: string, containsText: string): string {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>\\s*${containsText}\\s*<\\/${tag}>`));
  assert.ok(match, `no <${tag}>…${containsText}…</${tag}> found in rendered markup`);
  return match![0]!;
}

function assertHasClass(elementSource: string, className: string, description: string): void {
  assert.match(elementSource, new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`), `${description} must carry .${className}`);
}

test("#892 AC4: Controls' confirm dialog — BOTH the Confirm and Cancel buttons carry .recipe-press, not just one", () => {
  const html = renderToStaticMarkup(<Controls enabled initialState={{ phase: "confirming", verb: "pause" }} />);
  assertHasClass(elementHtml(html, "button", "Confirm"), "recipe-press", "the Confirm button");
  assertHasClass(elementHtml(html, "button", "Cancel"), "recipe-press", "the Cancel button");
});

// One event that lands in FeedEntry's `attention` branch (`hasAttention`, copy.ts), one that
// lands in the ordinary branch — same fixture shape ActivityFeed.test.tsx's own `ev` helper
// builds, reproduced locally here rather than imported so this file's render checks stay
// independent of that test file's internals.
const attentionEvent: KnownDomainEvent = {
  known: true,
  id: 1,
  ts: "2026-08-06T00:00:00Z",
  kind: "drive-needs-human" as EventKind,
  payload: { issue: 1, pr: 10 },
};

const routineEvent: KnownDomainEvent = {
  known: true,
  id: 2,
  ts: "2026-08-06T00:01:00Z",
  kind: "dispatched" as EventKind,
  payload: { issue: 2 },
};

test("#892 AC4: the activity feed — BOTH an attention row and an ordinary row carry .recipe-list-entry, not just one", () => {
  const html = renderToStaticMarkup(
    <ActivityFeed events={[attentionEvent, routineEvent]} pinnedAttention={[]} titles={{}} now={new Date("2026-08-06T12:00:00Z")} />,
  );
  const rows = html.match(/<li class="[^"]*\bfeed-entry\b[^"]*"/g) ?? [];
  assert.equal(rows.length, 2, "expected exactly one attention row and one ordinary row");
  const attentionRow = rows.find((row) => row.includes("feed-entry-attention"));
  const ordinaryRow = rows.find((row) => !row.includes("feed-entry-attention"));
  assert.ok(attentionRow, "expected one row carrying feed-entry-attention (the attention branch)");
  assert.ok(ordinaryRow, "expected one row NOT carrying feed-entry-attention (the ordinary branch)");
  assertHasClass(attentionRow!, "recipe-list-entry", "the attention row");
  assertHasClass(ordinaryRow!, "recipe-list-entry", "the ordinary row");
});

const laneFixture: Lane = {
  lane: "w1",
  issue: 86,
  state: "running",
  pr: null,
  startedAt: "2026-08-06T11:50:00.000Z",
  endedAt: null,
  costUsd: null,
  estCostUsd: null,
  fixRound: 0,
  contextTokens: null,
  tokenComposition: null,
};

test("#892 AC4: the lane board — a real lane card carries .recipe-list-entry", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[laneFixture]} titles={{}} now={new Date("2026-08-06T12:00:00Z")} />);
  const cards = html.match(/<div class="lane-card panel[^"]*"/g) ?? [];
  assert.equal(cards.length, 1, "expected exactly one real (non-empty) lane card");
  assertHasClass(cards[0]!, "recipe-list-entry", "the lane card");
});

// ── no bare ms duration anywhere in the CSS this issue touched for these components ────────────

const combinedCss = `${panelsCss}\n${appCss}`;

test("no bare millisecond duration on the touched dialog/drawer/legend component rules", () => {
  for (const selector of [".config-drawer", ".controls-confirm", ".hero-legend-trigger", ".hero-legend-content", ".hint-tooltip"]) {
    const rule = cssBlock(combinedCss, selector);
    assert.doesNotMatch(rule, /\b\d+ms\b/, `${selector} must not introduce a bare ms duration`);
  }
});

// ── #892 AC5: a bare ms value can hide in more shapes than a CSS rule or a JSX timing PROP
// (`HintTooltip`'s own `delayDuration={300}` was exactly the JSX-prop shape — a literal Radix
// interprets as milliseconds, in a component this issue touches, that the CSS-only checks above
// could never see) — a CSS-in-JS string (`transitionDuration: "300ms"`) or a literal handed
// straight to `setTimeout`/`setInterval` both route a duration around the shared `--beat`/`--tap`
// tokens just as effectively. Extends the same "no bare ms" guard to component SOURCE, in all
// three shapes, not just CSS. ───────────────────────────────────────────────────────────────────

const TOUCHED_COMPONENT_SOURCES = [
  "./components/HintTooltip.tsx",
  "./components/EntityRef.tsx",
  "./components/NeedsAttention.tsx",
  "./components/Header.tsx",
  "./components/ConfigDrawer.tsx",
  "./components/PhaseInspectorDrawer.tsx",
  "./components/Controls.tsx",
  "./components/ActivityFeed.tsx",
  "./components/LaneBoard.tsx",
  "./hero/Legend.tsx",
];

const BARE_TIMING_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b\w*(?:[Dd]elay|[Dd]uration)\w*=\{\s*\d+\s*\}/, label: "a bare numeric delay/duration JSX prop" },
  {
    pattern: /\b\w*(?:[Dd]elay|[Dd]uration)\w*\s*:\s*["'`]\s*\d+ms\s*["'`]/,
    label: "a bare millisecond CSS-in-JS string value",
  },
  {
    // Allows one level of nested parens in the callback argument (a plain or single-call-body
    // arrow function) without matching past the real closing paren into unrelated later code.
    pattern: /\bset(?:Timeout|Interval)\((?:[^()]|\([^()]*\))*,\s*\d+\s*\)/,
    label: "a literal millisecond delay passed directly to setTimeout/setInterval",
  },
];

test("#892 AC5: no bare millisecond timing (delay/duration prop, CSS-in-JS string, or setTimeout/setInterval literal) is introduced on the touched components", () => {
  for (const file of TOUCHED_COMPONENT_SOURCES) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const { pattern, label } of BARE_TIMING_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${file} must not introduce ${label} — route it through a var(--beat)/var(--tap) CSS token, a named constant, or the library's own default instead`,
      );
    }
  }
});
