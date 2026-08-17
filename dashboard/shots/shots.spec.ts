import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        // #882: `lanes` is captured separately below, through a live-mocked navigation of the
        // REAL production `LaneBoard` — this `?demo` page can only ever reach this module
        // selector chain's fallback (`LiveOnly`'s "live only" placeholder), since `?demo` is
        // always `replay` mode (`App.tsx`'s `DemoApp` doc) and the real board only mounts live.
        if (moduleKey === "lanes") continue;
        const locator = await firstMatch(page, selectors);
        if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-${moduleKey}.png` });
      }

      // #882 (729 ledger rows 12-13, capture gap closure): a SEPARATE live-mocked navigation of
      // the SAME production `App` tree — `/` (not `?demo`) with `/api/loop/state` fed a
      // fixture-shaped lanes payload through Playwright's own request interception, the
      // real-browser equivalent of `App.test.tsx`'s `stubFetch` pattern. No `/api/rounds` rows
      // means `mode` never leaves "live", so `LiveOnly` renders its real `children` — the actual
      // `LaneBoard` — instead of the placeholder. Writes into the same `${idlePrefix}-lanes.png`
      // slot the loop above deliberately skipped.
      await captureLiveLanes(page, theme, idlePrefix);
      await page.goto("/?demo");
      await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
      await page.locator("#overview").waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");

      // Second state: scrub the transport back to the round's midpoint — a real, work-in-flight
      // fold (`scrubTo`'s own doc: a checkpointed re-fold to an earlier event, not a fabricated
      // state), giving genuine "active" evidence alongside the idle default above.
      const scrubbed = await scrubToMidpoint(page);
      if (scrubbed) {
        const activePrefix = `${width}-${theme.key}-active`;
        await page.screenshot({ path: `${CAPTURES_DIR}/${activePrefix}-full.png`, fullPage: true });
        for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
          // #882: the live-mocked capture above has no rounds to scrub (mode never leaves
          // "live"), so there is no genuine scrubbed moment for `lanes` to capture at "active" —
          // `OPTIONAL_AT` exempts it, same posture as `needs-attention`'s own empty-state
          // exemption below.
          if (moduleKey === "lanes") continue;
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

/**
 * #889 (§3 A implementation) Tier A, decomposed out of the live-route walk into a fixture-scale
 * structural fact per the issue's own verification plan: "an assertion that `.round-list` renders
 * only once the navigator is opened (never inline in the default render) and that at a 1440px
 * viewport hero/lanes/feed/cost sit within a single scroll (no round-history content pushes them
 * below the fold)". Reuses this same `?demo` fixture + 1440px viewport this file's capture loop
 * already exercises — no separate fixture or harness stood up for it.
 *
 * engine-agent audit run fe112e01-e488-4d80-864a-9a490750cfb1 finding [1] (ac1-geometry-not-pinned):
 * the previous version of this test used `toBeVisible()` (which permits an element far outside the
 * viewport — "visible" just means painted, not on-screen) plus a `scrollHeight < 4000` ceiling that,
 * against a 900px viewport, still permitted well over four viewport heights of content.
 *
 * engine-agent audit run 509eb47b-40b2-42a7-b540-aeb567ac08bf finding [0] (ac1-one-scroll-boundary):
 * round 2's fix replaced that with a 3× viewport (2700px) bound on the LAST module's (cost) BOTTOM
 * edge — correctly rejected as still too loose ("two additional viewport-height scrolls beyond the
 * initial viewport"). That bound was also measuring the wrong thing: the issue's own bug report is
 * "hero/lanes/feed/cost start ~9 screens below the fold" — about each module's TOP edge (where it
 * BEGINS) being pushed down by round-history content, never about the FULL EXTENT of a legitimately
 * long panel (the #880 two-panel cost composition is long on its own merits, unrelated to this
 * issue, and requiring it to fully fit on one screen would be a real design constraint this issue
 * never asked for). This version asserts only each module's TOP edge against the tightest genuinely
 * defensible one-scroll reading — 2× viewport height (900 × 2 = 1800), matching "start the page,
 * scroll down once by roughly a viewport, and you've reached every module's start" — with no
 * bottom-edge/total-extent assertion at all. Real measured tops at 1440×900 (`?demo`, idle):
 * hero 287px, lanes/feed 732px, cost 1225px — all comfortably inside 1800px with margin to spare.
 */
test("§889 AC1: the round list never renders inline by default, and hero/lanes/feed/cost each START within one scroll (2× viewport height) at 1440px", async ({
  page,
}) => {
  const viewportHeight = 900;
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  // The structural fix itself: the round list used to be `Transport.tsx`'s always-rendered
  // `<ul className="round-list">` — the ~9,000px/387-row live-route bulge the issue names. It now
  // lives entirely behind the header navigator's click-to-open state (`RoundNavigator.tsx`), so it
  // must be entirely absent from the DOM until that click happens — never present-but-hidden.
  expect(await page.locator(".round-list").count()).toBe(0);

  const oneScrollBoundaryPx = viewportHeight * 2;
  const modules: [string, Locator][] = [
    ["hero", page.locator("svg.hero")],
    ["lanes", (await firstMatch(page, MODULE_SELECTORS.lanes)) ?? page.locator("nonexistent-lanes-anchor")],
    ["feed", page.locator('section[aria-label="activity"]')],
    ["cost", page.locator("#cost")],
  ];
  for (const [name, locator] of modules) {
    const box = await locator.boundingBox();
    expect(box, `${name} module must render with a real bounding box`).not.toBeNull();
    expect(
      box?.y,
      `${name}'s top edge must start within a single scroll (2× viewport height) from the top — never pushed below the fold by round history`,
    ).toBeLessThan(oneScrollBoundaryPx);
  }
});

/**
 * #897 AC5's own verification plan asks for a 1440px viewport measurement of the lanes/activity
 * row's rendered x-extent, proving the mockup's full-width split (no unused trailing region). The
 * component test suite (`App.test.tsx`) can only prove the `.lane-activity-row` wrapper exists in
 * the markup and that its CSS carries the intended `auto-fit` declaration — `happy-dom` (that
 * suite's DOM) has no real CSS Grid layout engine, so it cannot compute what width that grid
 * actually resolves to. A REAL browser is the only thing that can prove the cascade genuinely
 * closes the dead zone the issue reported, the same "real layout, not a stand-in" posture this
 * file's other tests above already apply to click hit-testing and computed style.
 */
test("#897 AC5: at 1440px, the lane board and activity feed together span the row's full width — no trailing dead zone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const row = page.locator(".lane-activity-row");
  const rowBox = await row.boundingBox();
  expect(rowBox, "the .lane-activity-row wrapper must render with a real bounding box").not.toBeNull();

  // `?demo` is always replay mode (`App.tsx`'s `DemoApp` doc) — the real `LaneBoard` never
  // mounts there, so the row's first child is `LiveOnly`'s "live only" placeholder instead. Both
  // are the SAME panel-shaped element the real split renders (`LiveOnly.tsx`'s own doc: "reads as
  // the SAME panel, dimmed"), so measuring the placeholder's extent is honest evidence for the
  // row's actual column split either way.
  const laneSlot = (await firstMatch(page, MODULE_SELECTORS.lanes)) ?? page.locator("nonexistent-lanes-anchor");
  const feedSlot = page.locator('section[aria-label="activity"]');
  const laneBox = await laneSlot.boundingBox();
  const feedBox = await feedSlot.boundingBox();
  expect(laneBox, "the lane board slot must render with a real bounding box").not.toBeNull();
  expect(feedBox, "the activity feed must render with a real bounding box").not.toBeNull();

  // The mockup's split is two side-by-side panels filling the row — proven by the pair's
  // combined horizontal extent actually reaching the row's own edges, not just existing
  // somewhere inside it. A tolerance covers the row's own padding/gap, never a half-canvas gap.
  const tolerancePx = 24;
  const leftmost = Math.min(laneBox!.x, feedBox!.x);
  const rightmost = Math.max(laneBox!.x + laneBox!.width, feedBox!.x + feedBox!.width);
  expect(leftmost - rowBox!.x, "the pair's leftmost edge must reach the row's own left edge").toBeLessThan(tolerancePx);
  expect(
    rowBox!.x + rowBox!.width - rightmost,
    "the pair's rightmost edge must reach the row's own right edge — no unused trailing region",
  ).toBeLessThan(tolerancePx);

  // The two panels must actually be SIDE BY SIDE at this width (the mockup's split), not stacked
  // — a meaningful overlap in Y with distinct X ranges is what "sharing a row" means.
  expect(Math.abs(laneBox!.y - feedBox!.y), "lane board and activity feed must sit on the same row, not stacked").toBeLessThan(tolerancePx);

  // #897: the edge-union and same-y checks above also pass if both panels render at the SAME x
  // range, each spanning the row's full width (full overlap) — neither checks horizontal ordering
  // or non-overlap. The lane slot renders first in `.lane-activity-row`'s markup (App.tsx) and
  // this row's own auto-fit grid (app.css) places DOM order left-to-right, so a genuine split
  // requires the lane slot's right edge to precede the feed's left edge, within the same row-gap
  // tolerance used above.
  expect(
    feedBox!.x - (laneBox!.x + laneBox!.width),
    "the lane slot's right edge must clear the activity feed's left edge (within the row gap) — proves the panels sit side by side rather than overlapping",
  ).toBeGreaterThan(-tolerancePx);

  // Each panel must also claim a real share of the row, not a sliver beside a panel that spans
  // nearly the whole width. `.lane-activity-row` (app.css) is two equal `1fr` auto-fit columns, so
  // an even split is the design's own target; 20% of the row is a conservative floor only a
  // genuine two-panel split can clear.
  const minSharePx = rowBox!.width * 0.2;
  expect(laneBox!.width, `the lane slot must occupy at least 20% (${minSharePx.toFixed(0)}px) of the row's width`).toBeGreaterThan(
    minSharePx,
  );
  expect(feedBox!.width, `the activity feed must occupy at least 20% (${minSharePx.toFixed(0)}px) of the row's width`).toBeGreaterThan(
    minSharePx,
  );
});

/**
 * engine-agent audit run fe112e01-e488-4d80-864a-9a490750cfb1 finding [0]
 * (dropdown-clipped-by-navigator): `.round-nav`'s `overflow: hidden` (added for the joined-stepper
 * look) used to clip `.round-nav-list-wrap` — its own absolutely positioned child — out of the
 * paint/hit-test tree the instant it opened below the stepper's small border box. A DOM-presence
 * check (`happy-dom` in the component test suite) cannot catch this: the clipped element still has
 * non-zero `getBoundingClientRect()` dimensions, it simply isn't painted or hit-testable there. This
 * is the real-browser proof: `elementFromPoint` at the dropdown's own center must actually resolve
 * to the dropdown (not whatever sits behind the clip), and a genuine click on one of its rows must
 * succeed rather than time out on Playwright's actionability check.
 */
test("§889 finding [0]: the opened round-list dropdown is not clipped by the navigator's own overflow, and its rows are actually clickable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  await page.locator(".round-nav-pill").click();
  const dropdown = page.locator(".round-nav-list-wrap");
  await expect(dropdown).toBeVisible();

  const box = await dropdown.boundingBox();
  expect(box, "the opened dropdown must report a real bounding box").not.toBeNull();
  const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  const hitsDropdown = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el !== null && el.closest(".round-nav-list-wrap") !== null;
    },
    { x: centerX, y: centerY },
  );
  expect(
    hitsDropdown,
    "the dropdown must actually be hit-testable at its own center point — not clipped invisible by an ancestor's overflow",
  ).toBe(true);

  // End-to-end proof: a real click on a row inside the opened dropdown must actually reach that
  // row (Playwright's actionability check times out if the target point isn't hit-testable, which
  // is exactly what the clipping bug caused).
  await dropdown.locator(".round-row button").first().click({ timeout: 5000 });
});

/**
 * engine-agent audit run 509eb47b-40b2-42a7-b540-aeb567ac08bf finding [1] (ac2-style-evidence-missing):
 * AC2's "no native default chrome" + "token-styled … in both themes" claims had no test reading
 * REAL computed style — the component tests (`RoundNavigator.test.tsx`) assert authored markup/
 * class names, never what the cascade actually resolves to, and `shots.spec.ts`'s capture loop is
 * explicitly presence-only, never a style assertion. `docs/REVIEW-DOCTRINE.md`'s own STYLE rule
 * ("computed-style ACs are VALUE's real-DOM exception … never a stand-in") applies directly here.
 * This repo's `happy-dom` unit-test harness cannot even serve as that stand-in for the THEME half
 * of the claim: verified directly (a scratch `light-dark()` resolution in `@happy-dom/global-
 * registrator` returns an EMPTY computed color, never the real hex) — tokens.css's whole palette is
 * declared through `light-dark()`, so only a REAL browser (Chromium, via Playwright) can prove a
 * theme-dependent token actually resolves differently per theme. This test is that real-browser
 * proof, for both themes declared explicitly on `<html data-theme>` (the same manual override
 * `theme.ts` and this file's own capture loop already use):
 *
 * 1. Structural joined-stepper fidelity: the three slots carry NO border-radius of their own — only
 *    the wrapping `.round-nav-stepper` does. A regression back to three independently rounded
 *    buttons (the ORIGINAL finding [0], run 9aaabee8) would fail this.
 * 2. `appearance: none` actually applies to `.transport-scrub` — proof the native range widget is
 *    opted out of, not merely retinted (the ORIGINAL finding [0]'s `accent-color`-only regression).
 * 3. The closed-pill's tint (`.round-nav-pill-closed`) resolves to a DIFFERENT real color between
 *    the two themes — the concrete, non-fakeable proof that `light-dark()` genuinely cascades here
 *    rather than a theme-invariant hardcoded value.
 * 4. `--sap` itself (the exact token `.transport-scrub`'s thumb/track rules consume) resolves to a
 *    different real color per theme at `:root` — AND the source declaration for the thumb rule
 *    references that same token by name. Together these are the closest available real-browser
 *    proof for the thumb specifically: `getComputedStyle(el, pseudo)` is NOT usable for vendor
 *    slider pseudo-elements — verified directly (a scratch probe against this exact page returned
 *    the BASE element's own box for `::-webkit-slider-thumb`, while a `::before` sanity probe on
 *    the same API resolved correctly), which is a documented Chromium limitation of the query API
 *    itself, not of the underlying paint. A single-pixel screenshot sample would be the only way to
 *    query the pseudo-element's actual paint color directly, and this file's own stated posture is
 *    "no pixel-diff gate" — the token-level computed proof plus the source-level rule binding is
 *    the honest ceiling here, not a shortcut around a harder check.
 */
test("§889 AC2: navigator/transport controls resolve real token-based styling in both themes, not native chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const themes = [
    { key: "light", attr: "sapwood" },
    { key: "dark", attr: "heartwood" },
  ] as const;
  const pillClosedColorByTheme: Record<string, string> = {};
  const sapTokenByTheme: Record<string, string> = {};
  const buttonBackgroundByTheme: Record<string, string> = {};

  for (const theme of themes) {
    await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);

    // The back-to-live/play/speed BUTTONS' own real computed style, not just the scrub input's
    // native-chrome opt-out above — an operator probe against production (issue #889 comment)
    // confirmed those buttons computed `font-family: Arial`, no mono rule reaching them, while the
    // sibling `.transport-position` readout correctly resolved "JetBrains Mono Variable". Compares
    // against `.transport-position`'s own real computed font-family (a fact, not a hand-copied
    // token literal) rather than hardcoding the expected mono stack.
    const positionFontFamily = await page.locator(".transport-position").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(positionFontFamily, `${theme.key}: the .transport-position readout must resolve a real font-family`).not.toBe("");

    const backToLive = page.locator(".transport-controls button", { hasText: "back to live" });
    const playButton = page.locator('.transport-controls button[aria-label="play"], .transport-controls button[aria-label="pause"]');
    const speedButtons = page.locator(".transport-speeds button");
    expect(await speedButtons.count(), `${theme.key}: ×1/×4/×16 speed buttons must all be present`).toBe(3);

    const monoTargets: [string, Locator][] = [
      ["back to live", backToLive],
      ["play/pause", playButton],
      ["×1 speed", speedButtons.nth(0)],
      ["×4 speed", speedButtons.nth(1)],
      ["×16 speed", speedButtons.nth(2)],
    ];
    for (const [label, locator] of monoTargets) {
      const fontFamily = await locator.first().evaluate((el) => getComputedStyle(el).fontFamily);
      expect(
        fontFamily,
        `${theme.key}: the ${label} button must resolve the SAME mono font-family as .transport-position, not native/body chrome`,
      ).toBe(positionFontFamily);
    }

    // Background too, per the same STYLE rule — the "no native default chrome" half of AC2, not
    // just the font.
    const buttonBackground = await backToLive.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(
      buttonBackground,
      `${theme.key}: back-to-live button must resolve a real token background, not native transparent chrome`,
    ).not.toBe("rgba(0, 0, 0, 0)");
    buttonBackgroundByTheme[theme.key] = buttonBackground;

    const stepperRadius = await page.locator(".round-nav-stepper").evaluate((el) => getComputedStyle(el).borderRadius);
    expect(stepperRadius, `${theme.key}: the stepper group itself must be rounded`).not.toBe("0px");
    const slotRadii = await page
      .locator(".round-nav-arrow, .round-nav-pill")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
    expect(slotRadii.length, `${theme.key}: expected the two arrows + pill to be present`).toBe(3);
    for (const radius of slotRadii) {
      expect(radius, `${theme.key}: individual stepper slots must NOT carry their own border-radius (that's what makes it JOINED)`).toBe(
        "0px",
      );
    }

    const scrubAppearance = await page.locator(".transport-scrub").evaluate((el) => getComputedStyle(el).appearance);
    expect(scrubAppearance, `${theme.key}: the scrub input must opt out of native appearance, not just retint it`).toBe("none");

    const pillClosedColor = await page.locator(".round-nav-pill-closed").evaluate((el) => getComputedStyle(el).color);
    expect(pillClosedColor, `${theme.key}: the closed-round pill's tint must resolve to a real color`).not.toBe("");
    pillClosedColorByTheme[theme.key] = pillClosedColor;

    const sapToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sap").trim());
    expect(sapToken, `${theme.key}: --sap must resolve to a real color at :root`).not.toBe("");
    sapTokenByTheme[theme.key] = sapToken;
  }

  expect(
    pillClosedColorByTheme.light,
    "the closed-pill tint must actually differ between light and dark themes — proof light-dark() genuinely cascades, not a theme-invariant hardcoded value",
  ).not.toBe(pillClosedColorByTheme.dark);
  expect(sapTokenByTheme.light, "--sap itself must differ between light and dark themes at :root").not.toBe(sapTokenByTheme.dark);
  expect(
    buttonBackgroundByTheme.light,
    "the transport button background must actually differ between light and dark themes — proof light-dark() genuinely cascades onto it, not a theme-invariant hardcoded value",
  ).not.toBe(buttonBackgroundByTheme.dark);

  const panelsCss = readFileSync(fileURLToPath(new URL("../src/panels.css", import.meta.url)), "utf8");
  const thumbRule = panelsCss.match(/\.transport-scrub::-webkit-slider-thumb\s*\{([^}]*)\}/);
  expect(thumbRule, ".transport-scrub::-webkit-slider-thumb rule must exist").not.toBeNull();
  expect(thumbRule?.[1], "the thumb rule must consume the SAME --sap token just proven to differ per theme above").toMatch(
    /background:\s*var\(--sap\)/,
  );
});

/** #882: the fixture-shaped `/api/loop/state` lanes payload fed to `captureLiveLanes` below —
 *  three active-lane variety (running/fixing/driving) plus one open idle slot (`lanesMax: 4`),
 *  matching the card shapes `docs/design/mockup/lanes-{dark,light}.png` exercises: a droplet +
 *  issue, a PR link, a spend bar, and elapsed time. Timestamps are computed relative to the
 *  capture's own run time so "elapsed" never balloons as this fixture ages. */
function liveLanesLoopState() {
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return {
    engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
    lanes: {
      max: 4,
      items: [
        {
          lane: "w1",
          issue: 94,
          state: "running",
          pr: null,
          startedAt: minutesAgo(8),
          endedAt: null,
          costUsd: null,
          estCostUsd: 0.53,
          contextTokens: null,
          tokenComposition: null,
        },
        {
          lane: "w2",
          issue: 90,
          state: "fixing",
          pr: 99,
          startedAt: minutesAgo(32),
          endedAt: null,
          costUsd: null,
          estCostUsd: 1.69,
          contextTokens: null,
          tokenComposition: null,
        },
        {
          lane: "w3",
          issue: 87,
          state: "driving",
          pr: 96,
          startedAt: minutesAgo(5),
          endedAt: null,
          costUsd: 1.1,
          estCostUsd: null,
          contextTokens: null,
          tokenComposition: null,
        },
      ],
    },
    round: null,
    spend: { todayUsd: 3.32, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
    rings: 0,
    mergedPrs: [],
    logPath: null,
    config: { board: { owner: "herehigher", repo: "sapwood" }, worker: { budgetUsdSoft: 10 } },
    controlsEnabled: true,
  };
}

/** #882: intercepts every `/api/*` call the production `LiveApp` route makes (`api/client.ts`'s
 *  four endpoints) and fulfills it with fixture data, in-browser — the real-Chromium-page
 *  equivalent of `App.test.tsx`'s `stubFetch` (`byPath` -> `{status, body}`), which only works
 *  against that file's Node `fetch` mock. */
async function mockLiveApi(page: Page): Promise<void> {
  const byPath: Record<string, unknown> = {
    "/api/loop/state": liveLanesLoopState(),
    "/api/events": { events: [], lastId: 0 },
    "/api/spend": { spend: [], lastId: 0 },
    "/api/rounds": { rounds: [] },
  };
  await page.route("**/api/**", async (route) => {
    const body = byPath[new URL(route.request().url()).pathname];
    if (body === undefined) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** #882: the `lanes` module's real capture — navigates to `/` (never `?demo`, which is always
 *  `replay` mode and can never mount the real board) with `/api/*` mocked, so the SAME production
 *  `App` -> `LiveApp` -> `LiveOnly mode="live"` -> `LaneBoard` tree this app ships renders for
 *  real, not a standalone/mock stand-in built to bypass that wiring. */
async function captureLiveLanes(page: Page, theme: { key: string; attr: string }, idlePrefix: string): Promise<void> {
  await mockLiveApi(page);
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const lanes = page.locator('section[aria-label="lanes"]');
  await lanes.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await lanes.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-lanes.png` });
  await page.unroute("**/api/**");
}

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
//
// #882: `lanes` is exempted from `active` too — its capture comes from a SEPARATE live-mocked
// navigation (`captureLiveLanes`) that has no rounds to scrub, so `mode` never leaves "live" and
// there is no genuine scrubbed moment to capture; `idle` still required (that's the capture the
// re-audit needs).
const OPTIONAL_AT: Partial<Record<(typeof STATES)[number], string[]>> = { active: ["needs-attention", "lanes"] };

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
