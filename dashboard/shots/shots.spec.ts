import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// #729 fidelity ledger finding [0]: "idle" is `?demo`'s default position — the round's
// fully-folded END state (`useDemoReplay.ts`'s `endPosition` doc), nothing left in flight.
// "active" is that same round scrubbed back to its midpoint event — a real, work-in-flight fold,
// not a fabricated state. `idle` is the CANONICAL pairing state against the frozen mockups below
// (unchanged meaning from before this state split); `active` is additional live-only evidence.
const STATES = ["idle", "active"] as const;

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

// A stale capture left over from a PREVIOUS run would let `missingCaptures()` below pass on a
// selector that matches nothing THIS run — the presence assertion is only honest evidence if
// this run's files are the only files it can see. Wipe captures/mockups before every run;
// `contact-sheet.html` gets overwritten unconditionally by `buildContactSheet()` regardless.
rmSync(CAPTURES_DIR, { recursive: true, force: true });
rmSync(MOCKUPS_OUT_DIR, { recursive: true, force: true });
for (const dir of [OUTPUT_DIR, CAPTURES_DIR, MOCKUPS_OUT_DIR]) {
  mkdirSync(dir, { recursive: true });
}

test.describe.configure({ mode: "serial" });

test("capture the ?demo fixture across viewports/themes/states and build the contact sheet", async ({ page }) => {
  for (const width of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?demo");
      // theme.ts: `<html data-theme>` is the only thing tokens.css reads for the manual
      // override — setting it directly is enough for a screenshot; no click needed.
      await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
      await page.locator("#overview").waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");

      const idlePrefix = `${width}-${theme.key}-idle`;
      await page.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-full.png`, fullPage: true });
      for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
        const locator = await firstMatch(page, selectors);
        if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-${moduleKey}.png` });
      }

      // Second state: scrub the transport back to the round's midpoint — a real, work-in-flight
      // fold (`scrubTo`'s own doc: a checkpointed re-fold to an earlier event, not a fabricated
      // state), giving genuine "active" evidence alongside the idle default above.
      const scrubbed = await scrubToMidpoint(page);
      if (scrubbed) {
        const activePrefix = `${width}-${theme.key}-active`;
        await page.screenshot({ path: `${CAPTURES_DIR}/${activePrefix}-full.png`, fullPage: true });
        for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
          const locator = await firstMatch(page, selectors);
          if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${activePrefix}-${moduleKey}.png` });
        }
      }
    }
  }

  // Every module's selector chain (the `lanes` fallback included — the chain only guarantees
  // "one of these matched", not which one) must have matched SOMETHING at every
  // viewport/theme/state combination. A selector miss here (a renamed aria-label, a removed id) is
  // a real regression the run should fail on, not a gap the contact sheet quietly omits a row
  // for. Presence-of-evidence assertion, not a pixel comparison — the no-pixel-diff stance
  // stands.
  const missing = missingCaptures();
  expect(missing, `missing crop captures (a module selector matched nothing):\n${missing.join("\n")}`).toEqual([]);

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

/** Drives the real `<input aria-label="scrub">` (`Transport.tsx`) to its midpoint event via
 *  React's own `onChange` — a native property-setter write + a dispatched `input` event, the
 *  standard way to drive a React-controlled input from outside React (`fill()` does not reliably
 *  reach range inputs' React handlers). Returns false when no scrub control is present (nothing to
 *  scrub — never treated as a failure, since not every module renders the transport). */
async function scrubToMidpoint(page: Page): Promise<boolean> {
  const scrub = page.locator('input[aria-label="scrub"]');
  if ((await scrub.count()) === 0) return false;
  await scrub.evaluate((el: HTMLInputElement) => {
    const midpoint = Math.round((Number(el.min) + Number(el.max)) / 2);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(midpoint));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  return true;
}

// `NeedsAttention.tsx` renders nothing at all when its item list is empty (frontend-design.md:
// "empty = not rendered, empty is trustworthy") — at the round's SCRUBBED MIDPOINT nothing has
// necessarily escalated to a human yet, so an absent capture there is a genuine, honest "nothing
// waiting at this point in the round" fact, not a selector miss. Exempted from the presence
// requirement for `active` only; still required for `idle` (the round's settled end, where the
// fixture's own final needs-human item is expected to exist).
const OPTIONAL_AT: Partial<Record<(typeof STATES)[number], string[]>> = { active: ["needs-attention"] };

/** Every module × viewport × theme × state crop the capture loop above is supposed to have
 *  written — anything absent (and not exempted above) means a selector chain matched nothing for
 *  that combination. */
function missingCaptures(): string[] {
  const missing: string[] = [];
  for (const width of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const state of STATES) {
        for (const moduleKey of Object.keys(MODULE_SELECTORS)) {
          if (OPTIONAL_AT[state]?.includes(moduleKey)) continue;
          const file = `${CAPTURES_DIR}/${width}-${theme.key}-${state}-${moduleKey}.png`;
          if (!existsSync(file)) missing.push(file);
        }
      }
    }
  }
  return missing;
}

type PairRow = { moduleKey: string; theme: string; state: (typeof STATES)[number]; mockup: string; capture: string };

function buildContactSheet(): void {
  const mockupFiles = existsSync(MOCKUPS_SRC_DIR) ? readdirSync(MOCKUPS_SRC_DIR).filter((f) => f.endsWith(".png")) : [];
  for (const file of mockupFiles) copyFileSync(`${MOCKUPS_SRC_DIR}/${file}`, `${MOCKUPS_OUT_DIR}/${file}`);

  const pairRows: PairRow[] = [];
  for (const file of mockupFiles) {
    const match = file.match(/^(.+)-(light|dark)\.png$/);
    const moduleKey = match?.[1];
    const theme = match?.[2];
    if (!moduleKey || !theme || !(moduleKey in MODULE_SELECTORS)) continue;
    // Every mockup is paired against BOTH live states — the frozen mockups predate this state
    // split and each shows whichever moment its own design pass chose, so a reviewer needs both
    // live states side by side to judge fidelity rather than one arbitrarily privileged over the
    // other.
    for (const state of STATES) {
      const capture = `captures/${CANONICAL_WIDTH}-${theme}-${state}-${moduleKey}.png`;
      if (!existsSync(`${OUTPUT_DIR}/${capture}`)) {
        // `missingCaptures()` (called before this function ever runs) already asserts every
        // required module/viewport/theme/state crop exists — an absence here is either that
        // invariant broken (fail loud) or an `OPTIONAL_AT` exemption genuinely having nothing to
        // show at this state (skip the row honestly, same as the no-mockup case below).
        if (!OPTIONAL_AT[state]?.includes(moduleKey)) {
          throw new Error(`invariant violated: capture missing for an existing mockup pairing (${capture})`);
        }
        continue;
      }
      pairRows.push({ moduleKey, theme, state, mockup: `mockups/${file}`, capture });
    }
  }

  // Modules with genuinely no frozen mockup PNG on disk for either theme — never a
  // capture-presence gap (the throw above rules that out), the honest "no baseline to compare
  // against yet" case.
  const pairedModules = new Set(pairRows.map((r) => r.moduleKey));
  const modulesWithNoMockup = Object.keys(MODULE_SELECTORS).filter((m) => !pairedModules.has(m));

  const rowsHtml = pairRows
    .map(
      (r) => `
      <tr>
        <td class="label">${r.moduleKey} · ${r.theme} · ${r.state}<br><span class="tag">mockup vs. live</span></td>
        <td><img src="${r.mockup}" alt="${r.moduleKey} ${r.theme} mockup"></td>
        <td><img src="${r.capture}" alt="${r.moduleKey} ${r.theme} ${r.state} live capture"></td>
      </tr>`,
    )
    .join("");

  const fullPageRowsHtml = VIEWPORTS.flatMap((width) =>
    THEMES.flatMap((t) =>
      STATES.map(
        (state) => `
      <tr>
        <td class="label">${width}px · ${t.key} · ${state}<br><span class="tag">full page</span></td>
        <td colspan="2"><img src="captures/${width}-${t.key}-${state}-full.png" alt="${width} ${t.key} ${state} full page"></td>
      </tr>`,
      ),
    ),
  ).join("");

  const noMockupNote = modulesWithNoMockup.length
    ? `<p class="note">Module captured, no frozen mockup exists yet, for: ${modulesWithNoMockup.join(", ")} —
       see these in the full-page captures below (and the activity feed / replay transport / icon rail,
       which have no per-module mockup at all, are visible only there).</p>`
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
${noMockupNote}

<h2>Full-page captures — every viewport × theme combination</h2>
<table>${fullPageRowsHtml}</table>
</body>
</html>`;

  writeFileSync(`${OUTPUT_DIR}/contact-sheet.html`, html);
}
