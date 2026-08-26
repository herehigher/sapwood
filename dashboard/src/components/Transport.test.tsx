import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Round } from "../api/types.ts";
import { registerRealDom } from "../test-dom.ts";
import { nextSpeed, Transport } from "./Transport.tsx";

registerRealDom();

const panelsCss = readFileSync(new URL("../panels.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const heroCss = readFileSync(new URL("../hero/hero.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
// Same extraction Header.test.tsx uses: the real `body { ... }` rule, pulled from source
// rather than hand-copied, so the ambient (pre-fix) font-family a button would inherit
// without its own rule can't silently desync from what actually ships. The
// `.transport-position` oracle this file compares against gets ITS mono font from app.css's
// `code, .data { font-family: var(--font-data); }` rule (`Transport.tsx` gives it the `data`
// class), not from panels.css — that rule is extracted too, for the same reason.
const bodyFontFamilyRule = appCss.match(/body\s*\{[^}]*\}/)?.[0];
const dataClassFontFamilyRule = appCss.match(/code,\s*\.data\s*\{[^}]*\}/)?.[0];

const NOW = new Date("2026-08-10T12:00:00Z");

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "done",
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T10:30:00Z",
    startEventId: 100,
    startSpendId: 50,
    eventCount: 42,
    schemaVersion: 1,
    artifact: { schemaVersion: 1, prsMerged: 3, spendUsd: 4.5 },
    ...overrides,
  };
}

// ── #889: live mode renders nothing at all — the round list moved to the header navigator ──────

test("live mode (nothing selected) renders nothing — no panel, no round list, no controls", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round()]} selectedRoundId={null} now={NOW} />);
  assert.equal(html, "");
});

test("disconnected renders nothing — the header's own navigator already carries that state", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={null} disconnected now={NOW} />);
  assert.equal(html, "");
});

test("a selectedRoundId not (yet) present in `rounds` renders nothing rather than crashing", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={5} now={NOW} />);
  assert.equal(html, "");
});

// ── transport controls: only render once a round is actually selected ──────────────────────────

test("selecting a round reveals play/pause, a single cycling speed box, and scrub controls", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} cursorId={100} now={NOW} />);
  assert.match(html, /aria-label="play"/);
  assert.match(html, /aria-label="scrub"/);
  assert.match(html, /class="transport-speed"[^>]*>×1</, "default speed (1) renders as a single ×1 box");
});

test("playing=true shows the pause glyph/label instead of play", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} playing cursorId={100} now={NOW} />);
  assert.match(html, /aria-label="pause"/);
  assert.doesNotMatch(html, /aria-label="play"/);
});

// #923 (D17): "speed as one bordered '× N' box (cycling ...), no three-chip row" — replaces the
// old three separately-bordered ×1/×4/×16 buttons with a single button showing the CURRENT speed.
test("nextSpeed cycles 1 -> 4 -> 16 -> 1, wrapping around", () => {
  assert.equal(nextSpeed(1), 4);
  assert.equal(nextSpeed(4), 16);
  assert.equal(nextSpeed(16), 1);
});

test("the speed box renders only the current speed, not a three-chip row", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} speed={4} cursorId={100} now={NOW} />);
  assert.match(html, /class="transport-speed"[^>]*>×4</);
  assert.doesNotMatch(html, />×1</);
  assert.doesNotMatch(html, />×16</);
  assert.equal((html.match(/class="transport-speed"/g) ?? []).length, 1, "exactly one speed control, never a three-chip row");
});

test("the scrub bar spans the round's event window and shows the current 'event n/N' position", () => {
  const r = round({ roundId: 1, startEventId: 500, eventCount: 300 });
  const html = renderToStaticMarkup(<Transport rounds={[r]} selectedRoundId={1} cursorId={650} now={NOW} />);
  assert.match(html, /min="500"/);
  assert.match(html, /max="800"/);
  assert.match(html, /value="650"/);
  assert.match(html, /event 150\/300/);
});

// ── #766 gate② finding [3] (round-log-load-rejection-sticks): loading / error / retry ──────────

// #923 (D15): "back to live" moved to the header row (App.tsx) — a single control covering
// loading/error/normal alike, so this component's own loading state no longer duplicates it.
test("loading=true shows an honest 'loading round…' caption, no play/speed/scrub controls yet (nothing to control)", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} loading now={NOW} />);
  assert.match(html, /loading round…/);
  assert.doesNotMatch(html, /aria-label="play"/);
  assert.doesNotMatch(html, /aria-label="scrub"/);
});

test("loadError (not loading) shows an honest failure caption and a retry control, never a silently blank panel", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} loading={false} loadError={new Error("network down")} now={NOW} />,
  );
  assert.match(html, /could not load this round/);
  assert.match(html, /<button[^>]*>retry<\/button>/);
  assert.doesNotMatch(html, /aria-label="scrub"/, "no scrub bar over a log that failed to load");
});

test("no loadError and not loading: the ordinary transport controls render, not the error state", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} loading={false} loadError={null} now={NOW} />,
  );
  assert.doesNotMatch(html, /could not load this round/);
  assert.match(html, /aria-label="scrub"/);
});

// ── the transport buttons themselves must resolve real token-based (mono) styling — an operator
// probe against production (issue #889 comment) confirmed every `.transport-controls button`
// computed `font-family: Arial` (no mono rule reaches them) while the sibling `.transport-position`
// readout correctly resolved "JetBrains Mono Variable". engine/prompts/doctrine-core.md's STYLE rule: a
// computed-style AC needs `registerRealDom()` + a real `getComputedStyle` read against the FULL
// production cascade, mounted in production order — never a regex match on declaration text, which
// proves a rule exists but never that it wins the cascade onto the element.
test("gate② finding: play/speed buttons resolve the SAME mono font-family as the sibling .transport-position readout, in both themes", () => {
  assert.ok(bodyFontFamilyRule, "app.css must still declare a body { ... } rule for the ambient (pre-fix) inherited font to extract");
  assert.ok(dataClassFontFamilyRule, "app.css must still declare the code, .data { ... } rule .transport-position's mono font depends on");
  const style = document.createElement("style");
  // Exactly the order the browser sees: app.css's own three `@import`s (tokens, panels, hero —
  // in that source order) load BEFORE app.css's own rules (`body`, `code, .data`, ...) that
  // follow them in the file — mounting body/.data ahead of panels would prove nothing about
  // whether a later app-level rule could still out-cascade panels.css's fix.
  style.textContent = `${tokensCss}\n${panelsCss}\n${heroCss}\n${bodyFontFamilyRule}\n${dataClassFontFamilyRule}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} loading={false} loadError={null} cursorId={100} now={NOW} />,
  );
  document.body.appendChild(container);
  try {
    // font-family isn't itself theme-dependent (`--font-data` carries one value, not a
    // `light-dark()` pair) — asserted under both attributes anyway, proving the theme override
    // mechanism doesn't somehow knock the rule out in either direction.
    for (const themeAttr of ["heartwood", "sapwood"]) {
      document.documentElement.setAttribute("data-theme", themeAttr);

      const positionEl = container.querySelector(".transport-position");
      assert.ok(positionEl, `${themeAttr}: .transport-position must render`);
      const monoFontFamily = getComputedStyle(positionEl as Element).fontFamily;
      const bodyFontFamily = getComputedStyle(document.body).fontFamily;
      assert.notEqual(monoFontFamily, "", `${themeAttr}: sanity check — the sibling mono readout must resolve a real font-family`);
      assert.notEqual(
        monoFontFamily,
        bodyFontFamily,
        `${themeAttr}: sanity check — .transport-position must actually BE mono, distinct from the ambient body font, or this oracle proves nothing`,
      );

      const playButton = container.querySelector(
        '.transport-controls button[aria-label="play"], .transport-controls button[aria-label="pause"]',
      );
      const speedButton = container.querySelector(".transport-speed");

      const targets: [string, Element | null | undefined][] = [
        ["play", playButton],
        ["speed", speedButton],
      ];
      for (const [label, el] of targets) {
        assert.ok(el, `${themeAttr}: the ${label} button must render`);
        assert.equal(
          getComputedStyle(el as Element).fontFamily,
          monoFontFamily,
          `${themeAttr}: the ${label} button must resolve the SAME mono token as .transport-position, not the ambient body font`,
        );
      }
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    document.body.removeChild(container);
    document.head.removeChild(style);
  }
});
