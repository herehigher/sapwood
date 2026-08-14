import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * `npm run shots` (frontend-design.md §2, #876 D) — captures the `?demo` fixture at every
 * viewport/theme combination the design targets, then builds a static contact sheet pairing each
 * frozen mockup (`docs/design/mockup/`) with its live counterpart. Evidence for a human reviewer
 * or gate②, never a pixel-diff gate — no `expect(...).toHaveScreenshot()` anywhere below.
 */

const OUTPUT_DIR = fileURLToPath(new URL("../shots-output", import.meta.url));
const CAPTURES_DIR = `${OUTPUT_DIR}/captures`;
const MOCKUPS_SRC_DIR = fileURLToPath(new URL("../../docs/design/mockup", import.meta.url));
const MOCKUPS_OUT_DIR = `${OUTPUT_DIR}/mockups`;

const VIEWPORTS = [1440, 1024, 720] as const;
const THEMES = [
  { key: "light", attr: "sapwood" },
  { key: "dark", attr: "heartwood" },
] as const;

// §3 module name → candidate DOM anchors, tried in order. `lanes`'s primary target is the real
// lane board; its fallback is `LiveOnly`'s "live only" placeholder — `?demo`'s `mode` is always
// "replay" (App.tsx's `DemoApp` doc), so the real `LaneBoard` never mounts under `?demo` and the
// placeholder is the honest, reachable capture for that module slot.
const MODULE_SELECTORS: Record<string, string[]> = {
  header: ["#overview"],
  "hero-panel": ["svg.hero"],
  lanes: ['section[aria-label="lanes"]', '[aria-label="live only"]'],
  cost: ["#cost"],
  "needs-attention": ['section[aria-label="needs attention"]'],
};

// The desktop width `docs/design/mockup/`'s frozen PNGs were rendered at — the width the
// per-module comparison rows pair against.
const CANONICAL_WIDTH = 1440;

for (const dir of [OUTPUT_DIR, CAPTURES_DIR, MOCKUPS_OUT_DIR]) {
  mkdirSync(dir, { recursive: true });
}

test.describe.configure({ mode: "serial" });

test("capture the ?demo fixture across viewports/themes and build the contact sheet", async ({ page }) => {
  for (const width of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?demo");
      // theme.ts: `<html data-theme>` is the only thing tokens.css reads for the manual
      // override — setting it directly is enough for a screenshot; no click needed.
      await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
      await page.locator("#overview").waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");

      const prefix = `${width}-${theme.key}`;
      await page.screenshot({ path: `${CAPTURES_DIR}/${prefix}-full.png`, fullPage: true });

      for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
        const locator = await firstMatch(page, selectors);
        if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${prefix}-${moduleKey}.png` });
      }
    }
  }

  buildContactSheet();
  expect(existsSync(`${OUTPUT_DIR}/contact-sheet.html`)).toBe(true);
});

async function firstMatch(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

type PairRow = { moduleKey: string; theme: string; mockup: string; capture: string };

function buildContactSheet(): void {
  const mockupFiles = existsSync(MOCKUPS_SRC_DIR) ? readdirSync(MOCKUPS_SRC_DIR).filter((f) => f.endsWith(".png")) : [];
  for (const file of mockupFiles) copyFileSync(`${MOCKUPS_SRC_DIR}/${file}`, `${MOCKUPS_OUT_DIR}/${file}`);

  const pairRows: PairRow[] = [];
  for (const file of mockupFiles) {
    const match = file.match(/^(.+)-(light|dark)\.png$/);
    const moduleKey = match?.[1];
    const theme = match?.[2];
    if (!moduleKey || !theme || !(moduleKey in MODULE_SELECTORS)) continue;
    const capture = `captures/${CANONICAL_WIDTH}-${theme}-${moduleKey}.png`;
    if (!existsSync(`${OUTPUT_DIR}/${capture}`)) continue;
    pairRows.push({ moduleKey, theme, mockup: `mockups/${file}`, capture });
  }

  const pairedModules = new Set(pairRows.map((r) => r.moduleKey));
  const uncoveredModules = Object.keys(MODULE_SELECTORS).filter((m) => !pairedModules.has(m));

  const rowsHtml = pairRows
    .map(
      (r) => `
      <tr>
        <td class="label">${r.moduleKey} · ${r.theme}<br><span class="tag">mockup vs. live</span></td>
        <td><img src="${r.mockup}" alt="${r.moduleKey} ${r.theme} mockup"></td>
        <td><img src="${r.capture}" alt="${r.moduleKey} ${r.theme} live capture"></td>
      </tr>`,
    )
    .join("");

  const fullPageRowsHtml = VIEWPORTS.flatMap((width) =>
    THEMES.map(
      (t) => `
      <tr>
        <td class="label">${width}px · ${t.key}<br><span class="tag">full page</span></td>
        <td colspan="2"><img src="captures/${width}-${t.key}-full.png" alt="${width} ${t.key} full page"></td>
      </tr>`,
    ),
  ).join("");

  const uncoveredNote = uncoveredModules.length
    ? `<p class="note">No frozen mockup for: ${uncoveredModules.join(", ")} — see these in the full-page
       captures below (and the activity feed / replay transport / icon rail, which have no per-module
       mockup at all, are visible only there).</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>sapwood dashboard — shots contact sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #251b10; color: #f1e7d2; }
  h1, h2 { font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 32px; }
  td { border: 1px solid #4a3f30; padding: 8px; vertical-align: top; }
  td.label { white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .tag { color: #8fa36b; }
  img { max-width: 100%; display: block; }
  p.note { color: #a6957c; max-width: 70ch; }
</style>
</head>
<body>
<h1>sapwood dashboard — shots contact sheet</h1>
<p class="note">Generated by <code>npm run shots</code> from the <code>?demo</code> fixture. No pixel-diff
  assertion backs any row here — this is evidence for a human reviewer or gate②, directional against the
  frozen mockups in <code>docs/design/mockup/</code>, never a pixel contract.</p>

<h2>Per-module comparisons (${CANONICAL_WIDTH}px)</h2>
<table>${rowsHtml || "<tr><td>No mockup/capture pairs found.</td></tr>"}</table>
${uncoveredNote}

<h2>Full-page captures — every viewport × theme combination</h2>
<table>${fullPageRowsHtml}</table>
</body>
</html>`;

  writeFileSync(`${OUTPUT_DIR}/contact-sheet.html`, html);
}
