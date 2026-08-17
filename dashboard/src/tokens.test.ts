import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AA,
  checkContrast,
  checkFillGroundContrast,
  checkFillTextContrast,
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

test("AC3: --sap-fill vs the page ground clears the 3:1 non-text boundary in dark, and the known light-theme shortfall (1.88:1) the outline rule compensates for is on record", () => {
  const rows = checkFillGroundContrast(css);
  const dark = rows.find((r) => r.theme === "heartwood");
  const light = rows.find((r) => r.theme === "sapwood");
  assert.ok(dark?.pass, `dark --sap-fill vs --heartwood must clear ${NON_TEXT_AA}:1: ${dark?.ratio}`);
  assert.equal(light?.ratio, 1.88);
  assert.ok(!light?.pass, "light theme is the documented exception the --sap-text outline compensates for");
});

/** Every source file under `dashboard/src`, recursively — excluding `node_modules`/`dist`. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else out.push(full);
  }
  return out;
}

test("AC4: no var(--sap) literal remains anywhere in dashboard/src — every site repoints to --sap-text or --sap-fill", () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of listSourceFiles(srcDir)) {
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
