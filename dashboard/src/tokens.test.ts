import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AA,
  checkContrast,
  checkFillTextContrast,
  checkFillTrackContrast,
  contrastRatio,
  FILL_TOKENS,
  GROUNDS,
  NON_TEXT_AA,
  ON_FILL_TOKEN,
  parseColorTokens,
  parseTokens,
  readTokensCss,
  TEXT_TOKENS,
} from "./contrast.ts";

const css = readTokensCss();

// frontend-design.md §5 — every token named in the spec, colour and non-colour.
const COLOR_TOKENS = [
  "--heartwood",
  "--panel",
  "--sapwood",
  "--bark",
  "--bark-text",
  "--sap-text",
  "--sap-fill",
  "--on-sap-fill",
  "--moss",
  "--rust",
];
const TYPE_TOKENS = [
  "--font-display",
  "--font-body",
  "--font-data",
  "--text-0",
  "--text-1",
  "--text-2",
  "--text-3",
  "--text-4",
  "--leading-body",
  "--leading-display",
];
const SPACE_TOKENS = ["--space-1", "--space-2", "--space-3", "--space-4", "--radius-card", "--radius-pill", "--hairline"];
const MOTION_TOKENS = ["--beat", "--travel", "--ease"];

test("§5 colour tokens are defined for both themes", () => {
  const { light, dark } = parseColorTokens(css);
  for (const name of COLOR_TOKENS) {
    assert.match(dark[name] ?? "", /^#[0-9A-Fa-f]{6}$/, `dark ${name}`);
    assert.match(light[name] ?? "", /^#[0-9A-Fa-f]{6}$/, `light ${name}`);
  }
});

test("§5 grounds actually swap between themes", () => {
  const { light, dark } = parseColorTokens(css);
  assert.notEqual(light["--heartwood"], dark["--heartwood"]);
  assert.notEqual(light["--panel"], dark["--panel"]);
});

test("§5 type, space and motion tokens are defined", () => {
  const all = parseTokens(css);
  for (const name of [...TYPE_TOKENS, ...SPACE_TOKENS, ...MOTION_TOKENS]) {
    assert.ok(all[name], `missing ${name}`);
  }
  assert.equal(all["--beat"], "240ms");
  assert.equal(all["--travel"], "900ms");
  assert.equal(all["--text-0"], "13px"); // 13 px base, 1.25 ratio up to 33 px
  assert.equal(all["--text-4"], "33px");
});

test("§5 quality floor: every text-on-ground pair passes WCAG AA in both themes", () => {
  const failures = checkContrast(css).filter((row) => !row.pass);
  assert.deepEqual(failures, [], failures.map((f) => `${f.theme} ${f.text} on ${f.ground} = ${f.ratio}`).join("; "));
});

test("--bark is borders-only: it is deliberately not in the text set", () => {
  // §5 flags it as ≈3.9:1 on --heartwood — below AA for text. Guard against someone
  // "fixing" the contrast check by promoting it to a text token.
  assert.ok(!(TEXT_TOKENS as readonly string[]).includes("--bark"));
  assert.deepEqual([...GROUNDS], ["--heartwood", "--panel"]);
});

test("#728: the #144/#145 display-header font-token deviation is adjudicated in §5, matching the shipped face", () => {
  const doc = readFileSync(new URL("../../docs/frontend-design.md", import.meta.url), "utf8");
  assert.match(doc, /#144/);
  assert.match(doc, /#145/);
  assert.match(doc, /Fraunces/);
  assert.match(doc, /all-mono/);

  // The ruling says Fraunces stays — cross-check the shipped headers actually use it.
  const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  assert.match(appCss, /h1,\s*\nh2,\s*\nh3\s*\{[^}]*font-family:\s*var\(--font-display\)/);
});

test("contrastRatio matches known WCAG values", () => {
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(AA, 4.5);
});

// ── #924 (§729 remainder, Q5): --sap split into --sap-text/--sap-fill ──────────────────────────

test("AC3: --sap-text and --sap-fill are both listed in the text/fill sets contrast.ts checks", () => {
  assert.ok((TEXT_TOKENS as readonly string[]).includes("--sap-text"));
  assert.ok(!(TEXT_TOKENS as readonly string[]).includes("--sap-fill"), "a filled surface is never checked as text-on-ground");
  assert.deepEqual([...FILL_TOKENS], ["--sap-fill"]);
  assert.equal(ON_FILL_TOKEN, "--on-sap-fill");
});

test("AC3: --on-sap-fill on --sap-fill clears AA (4.5:1) in both themes", () => {
  const failures = checkFillTextContrast(css).filter((row) => !row.pass);
  assert.deepEqual(failures, [], failures.map((f) => `${f.theme} ${f.text} on ${f.ground} = ${f.ratio}`).join("; "));
});

// #924 gate② round 1 finding [2] (fixed): modeled against the REAL rendered .cost-bar-track
// (--bark at its own declared opacity, composited over --panel) — not a bare --heartwood pair
// that never existed as a rendered surface.
//
// #924 gate② round 2 finding [1] (ac3-light-track-contrast-fails) — DISPUTED, per the PO's own
// re-baselined AC3 (issue body edited 2026-08-17, PO adjudication on this PR's leg-2 review
// thread): AC3 now reads, verbatim, "--sap-fill on the pill track >= 3:1 in the DARK theme; in
// the LIGHT theme the same pair is physically below 3:1 (measured 1.15:1 with --bark at 0.4 over
// the panel ... this is expected, not a failure) and the compensation is mandatory: every filled
// --sap-fill element ... resolves a 1px --sap-text outline/stroke in the light theme". The finding
// judged this test against the OLD AC3 (both themes must pass unaided) — the PO's own ruling is
// explicit: do NOT darken/retint --sap-fill or the track to force 3:1 in light (that would break
// AC5's mockup match); the light-theme 1.15:1 row stays on record as a documented, expected
// exception the outline rule (not the fill/track colours) compensates for.
test("AC3 (re-baselined 2026-08-17): --sap-fill vs the real .cost-bar-track composite clears 3:1 in dark; light's 1.15:1 is recorded as the EXPECTED shortfall the outline rule compensates for, never 'fixed' by retinting the fill/track", () => {
  const rows = checkFillTrackContrast(css);
  const dark = rows.find((r) => r.theme === "heartwood");
  const light = rows.find((r) => r.theme === "sapwood");
  assert.ok(dark?.pass, `dark --sap-fill vs .cost-bar-track must clear ${NON_TEXT_AA}:1: ${dark?.ratio}`);
  assert.equal(light?.ratio, 1.15);
  assert.ok(
    !light?.pass,
    "light theme is the documented, EXPECTED exception the --sap-text outline compensates for — not a bug to fix here",
  );
});

// #924 gate② round 2 finding [2] (ac3-outline-resolution-unverified) fix, PO leg-2 adjudication:
// happy-dom never evaluates light-dark() (verified directly, both with and without a var()
// indirection, on both a bare HTML `color` and an SVG `stroke`) — the STYLE proof this pins
// therefore needs `--sap-fill-outline`'s WINNING declaration to be a literal hex, not a
// light-dark() call, in the light theme (tokens.css's `:root[data-theme="sapwood"]` /
// `@media (prefers-color-scheme: light)` rules). This test is the VALUE-family guarantee that
// hand-authored literal can never silently drift from --sap-text's own light-theme hex.
test("AC3: --sap-fill-outline's literal light-theme hex is pinned to --sap-text's own light value — never a hand-copied duplicate that can drift", () => {
  const { light } = parseColorTokens(css);
  const outlineDeclarations = [...css.matchAll(/--sap-fill-outline:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1]!.toUpperCase());
  assert.equal(outlineDeclarations.length, 2, "expected exactly the data-theme override + the prefers-color-scheme override");
  for (const hex of outlineDeclarations) {
    assert.equal(hex, light["--sap-text"], "--sap-fill-outline's literal light-theme hex must equal --sap-text's own light value");
  }
});

/**
 * #924 AC3 (coverage, not just resolution): "derive the AC3 outline test's covered set from the
 * production --sap-fill consumers (grep dashboard/src for --sap-fill fills) rather than a
 * hand-typed list, so a new consumer cannot ship un-outlined." A hand-listed set of shapes
 * (App.test.tsx's AC3 STYLE test) can miss a real production consumer (e.g. a feed dot or a
 * range-thumb pseudo-element) that never made the list, leaving a genuinely un-outlined surface
 * invisible to it. This test is the COVERAGE half of the fix: every `var(--sap-fill)` PAINT site
 * in production source (never a test file, which may legitimately reference the string in an
 * assertion) is enumerated here explicitly — adding a new one without updating this list fails
 * LOUDLY, forcing the same choice every existing site already made: give it
 * `--sap-fill-outline` or name why it's exempt.
 */
test("AC3 COVERAGE: every production var(--sap-fill) paint site is on record", () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const sites: string[] = [];
  for (const file of listSourceFiles(srcDir)) {
    if (/\.test\.(ts|tsx)$/.test(file)) continue; // a test file may legitimately quote the string
    if (!/\.(ts|tsx|css)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const rel = file.slice(srcDir.length);
    text.split("\n").forEach((line, i) => {
      if (line.includes("var(--sap-fill)")) sites.push(`${rel}:${i + 1}`);
    });
  }
  // Every known production consumer, each verified elsewhere to carry the --sap-fill-outline
  // compensation (or, for `ActivityFeed.tsx:86`, being the very declaration OF that compensation):
  // - panels.css .cost-bar-fill (stroke) — App.test.tsx's "AC2" + "AC3" STYLE tests.
  // - panels.css ::-webkit-slider-thumb / ::-moz-range-thumb (background) — `border: 1px solid
  //   var(--sap-fill-outline)` on the SAME two rules; a real browser's
  //   `getComputedStyle(el, pseudo)` cannot query a vendor slider pseudo-element at all
  //   (`shots.spec.ts`'s own documented Chromium limitation) — this file's own source-text
  //   presence is the achievable ceiling, same posture as that file's own thumb-rule check.
  // - ActivityFeed.tsx:82 (dotColor) + :86 (dotBorder — a companion string comparison, not a
  //   second paint site) — ActivityFeed.test.tsx's own markup test.
  // - hero/stage.tsx dropletFill's "sap" role + the .hero-pool-chip inline style — hero.css's
  //   `.hero-droplet-shape`/`.hero-pool-chip rect` outline rules, App.test.tsx's AC3 STYLE test.
  const knownSites = [
    "panels.css:301",
    "panels.css:623",
    "panels.css:631",
    "components/ActivityFeed.tsx:82",
    "components/ActivityFeed.tsx:86",
    "hero/stage.tsx:719",
    "hero/stage.tsx:1045",
  ];
  assert.deepEqual(
    sites.sort(),
    knownSites.sort(),
    `production var(--sap-fill) paint sites changed — add the new site to knownSites above once you've verified it carries --sap-fill-outline (or is exempt and why): ${JSON.stringify(sites)}`,
  );
});

/** Every file under `dir`, recursively — excluding `node_modules`/`dist`/generated output dirs. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "dist-server" || entry === "shots-output") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else out.push(full);
  }
  return out;
}

// PO gate② (issue #924, 2026-08-17): the original AC4 sweep only scanned `dashboard/src` — a
// regression shipped in `dashboard/shots/shots.spec.ts` (outside that scan) and broke
// `npm run shots -w dashboard`. Scans the whole `dashboard/` tree (src/, shots/, and any future
// sibling) so a renamed token can never again hide from this test in a directory it doesn't cover.
test("AC4: no var(--sap) literal remains anywhere under dashboard/ — every site repoints to --sap-text or --sap-fill", () => {
  const dashboardDir = new URL("..", import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of listSourceFiles(dashboardDir)) {
    if (file === self) continue; // this test's own doc comments name the banned literal
    if (!/\.(ts|tsx|css)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    // The exact 10-char literal `var(--sap)` — a closing paren immediately after "sap" never
    // matches `var(--sap-text)`/`var(--sap-fill)`, which have more characters before their own
    // closing paren.
    if (/var\(--sap\)/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
