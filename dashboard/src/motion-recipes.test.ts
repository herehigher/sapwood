import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

const targets: { file: string; className: string }[] = [
  { file: "./components/ConfigDrawer.tsx", className: "recipe-drawer" },
  { file: "./components/ConfigDrawer.tsx", className: "recipe-press" },
  { file: "./components/PhaseInspectorDrawer.tsx", className: "recipe-drawer" },
  { file: "./components/PhaseInspectorDrawer.tsx", className: "recipe-press" },
  { file: "./components/Controls.tsx", className: "recipe-drawer" },
  { file: "./components/Controls.tsx", className: "recipe-press" },
  { file: "./components/NeedsAttention.tsx", className: "recipe-list-entry" },
  { file: "./hero/Legend.tsx", className: "recipe-press" },
];

test("every migrated dialog/list/press component's source carries its target motion-recipe class", () => {
  for (const { file, className } of targets) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, new RegExp(`className="[^"]*\\b${className}\\b`), `${file} must apply .${className}`);
  }
});

// ── no bare ms duration anywhere in the CSS this issue touched for these components ────────────

const combinedCss = `${panelsCss}\n${appCss}`;

test("no bare millisecond duration on the touched dialog/drawer/legend component rules", () => {
  for (const selector of [".config-drawer", ".controls-confirm", ".hero-legend-trigger", ".hero-legend-content", ".hint-tooltip"]) {
    const rule = cssBlock(combinedCss, selector);
    assert.doesNotMatch(rule, /\b\d+ms\b/, `${selector} must not introduce a bare ms duration`);
  }
});

// ── #892 AC5 (engine-agent audit run 7d33d9cd, finding [0] bare-tooltip-delay): a bare ms value
// can hide in a JSX timing PROP just as easily as in a CSS rule (`HintTooltip`'s own
// `delayDuration={300}` was exactly this — a literal Radix interprets as milliseconds, in a
// component this issue touches, that the CSS-only checks above could never see). Extends the
// same "no bare ms" guard to component SOURCE, not just CSS. ──────────────────────────────────

const TOUCHED_COMPONENT_SOURCES = [
  "./components/HintTooltip.tsx",
  "./components/EntityRef.tsx",
  "./components/NeedsAttention.tsx",
  "./components/Header.tsx",
  "./components/ConfigDrawer.tsx",
  "./components/PhaseInspectorDrawer.tsx",
  "./components/Controls.tsx",
  "./hero/Legend.tsx",
];

test("#892 AC5: no bare millisecond timing prop (delay/duration) is introduced on the touched components", () => {
  const bareTimingProp = /\b\w*(?:[Dd]elay|[Dd]uration)\w*=\{\s*\d+\s*\}/;
  for (const file of TOUCHED_COMPONENT_SOURCES) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      bareTimingProp,
      `${file} must not pass a bare numeric delay/duration prop — drop the override and use the library's own default, or route it through a var(--beat)/var(--tap) CSS token instead`,
    );
  }
});
