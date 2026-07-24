/**
 * WCAG contrast check for the §5 design tokens.
 *
 * frontend-design.md §5 "Quality floor" makes this load-bearing rather than pro-forma:
 * *every* text-on-ground token pair is checked with a contrast tool at implementation,
 * per theme. This file is that tool — it is both the checker the test asserts against
 * and a script (`npm run contrast -w dashboard`) that prints the table for a PR body.
 */
import { readFileSync } from "node:fs";

/** WCAG 2.1 AA for normal-size text. */
export const AA = 4.5;

/** Grounds text can sit on (§5: `--heartwood` page, `--panel` cards/drawer). */
export const GROUNDS = ["--heartwood", "--panel"] as const;

/**
 * Tokens that are ever used as text. `--bark` is deliberately absent: §5 scopes it to
 * "borders and hairlines **only**" precisely because it is ≈3.9:1 on `--heartwood`.
 */
export const TEXT_TOKENS = ["--sapwood", "--bark-text", "--sap", "--moss", "--rust"] as const;

export type Theme = "heartwood" | "sapwood";
export type ContrastRow = { theme: Theme; text: string; ground: string; ratio: number; pass: boolean };

export function readTokensCss(): string {
  return readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
}

/** Every `--token: value` declaration, last one wins. Values keep their raw CSS text. */
export function parseTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

/**
 * Colour tokens split per theme. `light-dark(a, b)` yields a for light and b for dark;
 * a bare hex (e.g. `--bark`, identical in both themes) yields itself for both.
 */
export function parseColorTokens(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseTokens(css))) {
    const pair = value.match(/^light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)$/);
    if (pair) {
      light[name] = pair[1]!.toUpperCase();
      dark[name] = pair[2]!.toUpperCase();
    } else if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
      light[name] = dark[name] = value.toUpperCase();
    }
  }
  return { light, dark };
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** WCAG contrast ratio, rounded to the 2 decimals every contrast tool reports. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Every text-on-ground pair, both themes. */
export function checkContrast(css: string = readTokensCss()): ContrastRow[] {
  const themes = parseColorTokens(css);
  const rows: ContrastRow[] = [];
  for (const [theme, tokens] of [
    ["heartwood", themes.dark],
    ["sapwood", themes.light],
  ] as const) {
    for (const ground of GROUNDS) {
      for (const text of TEXT_TOKENS) {
        const ratio = contrastRatio(tokens[text]!, tokens[ground]!);
        rows.push({ theme, text, ground, ratio, pass: ratio >= AA });
      }
    }
  }
  return rows;
}

if (import.meta.filename === process.argv[1]) {
  const rows = checkContrast();
  const colors = parseColorTokens(readTokensCss());
  for (const r of rows) {
    const swatch = r.theme === "heartwood" ? colors.dark : colors.light;
    const label = `${r.theme.padEnd(9)} ${r.text.padEnd(11)} ${swatch[r.text]} on ${r.ground.padEnd(11)} ${swatch[r.ground]}`;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${label}  ${r.ratio.toFixed(2)}:1`);
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - failed}/${rows.length} pairs pass WCAG AA (${AA}:1)`);
  if (failed) process.exitCode = 1;
}
