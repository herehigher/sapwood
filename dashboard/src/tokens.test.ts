import assert from "node:assert/strict";
import test from "node:test";
import { AA, checkContrast, contrastRatio, GROUNDS, parseColorTokens, parseTokens, readTokensCss, TEXT_TOKENS } from "./contrast.ts";

const css = readTokensCss();

// frontend-design.md §5 — every token named in the spec, colour and non-colour.
const COLOR_TOKENS = ["--heartwood", "--panel", "--sapwood", "--bark", "--bark-text", "--sap", "--moss", "--rust"];
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

test("contrastRatio matches known WCAG values", () => {
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(AA, 4.5);
});
