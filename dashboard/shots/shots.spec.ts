import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { LoopEvent } from "../src/api/types.ts";
import { contrastRatio, NON_TEXT_AA } from "../src/contrast.ts";
import { buildRoundLog } from "../src/demo/build-round-log.ts";
import type { DemoBundle } from "../src/demo/types.ts";
import { formatUsd } from "../src/format.ts";
import { STAGE, ZONE_DIVIDERS } from "../src/hero/stage.tsx";

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
// "active" is that same round scrubbed back to its first planning/reflection phase window
// (`scrubToActiveMoment`'s own doc, gate② finding [5]) — a real, work-in-flight fold, not a
// fabricated state; falls back to the arithmetic midpoint when the round carries no such window.
// `idle` is the CANONICAL pairing state against the frozen mockups below (unchanged meaning from
// before this state split); `active` is additional live-only evidence.
const STATES = ["idle", "active"] as const;

// §3 module name → candidate DOM anchors, tried in order.
//
// #927 (§729 remainder, D35; Q4 owner ruling): `lanes` no longer carries a `LiveOnly`-placeholder
// fallback — the board itself replays now (`App.tsx`'s `deriveReplayedLanes`), so `?demo` reaches
// the SAME `section[aria-label="lanes"]` anchor every other module already does, no fallback
// needed.
const MODULE_SELECTORS: Record<string, string[]> = {
  header: ["#overview"],
  "hero-panel": ["svg.hero"],
  lanes: ['section[aria-label="lanes"]'],
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
  // #921 gate② round 4 witness follow-up: without this, a crop-pair capture (full panel +
  // outcome-zone) can land mid-animation — the hero's own anime.js transitions (ring stroke
  // draw-on, droplet travel) are still running when the screenshot fires, so the two crops of the
  // SAME moment can show visibly different frames. `Hero.tsx`'s own `useReducedMotion` already
  // turns every transition into an instant swap to its settled final state (never a different
  // STATE, just no visual lag reaching it) — emulating it here removes the timing race
  // deterministically, rather than an arbitrary "wait N ms" this repo's own review doctrine bans
  // for exactly this class of flake.
  await page.emulateMedia({ reducedMotion: "reduce" });
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
      // #954 AC2 (gate② finding [1]): must run BEFORE this capture's own full-page screenshot —
      // 1024/720 are the criterion's own named widths.
      if (width === 1024 || width === 720) {
        await assertFeedEntryGeometry(page, idlePrefix);
      }
      await page.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-full.png`, fullPage: true });
      for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
        const locator = await firstMatch(page, selectors);
        if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-${moduleKey}.png` });
      }
      // #921 AC4/gate② finding [1]: the OUTCOME right-zone crop, at the mockup's own canonical
      // width only — the `?demo` idle end-state carries exactly 1 ring (this issue's own "single
      // ring, count legible" case). Confirmed against the REAL rendered `data-rings`, not assumed.
      if (width === CANONICAL_WIDTH) {
        await page.locator('.hero-trunk[data-rings="1"]').waitFor({ state: "visible" });
        await captureOutcomeZone(page, page.locator("svg.hero"), `${CAPTURES_DIR}/${idlePrefix}-hero-panel-outcome-zone.png`);
      }

      // #882, renamed/rescoped by #927: a SEPARATE live-mocked navigation of the SAME production
      // `App` tree — `/` (not `?demo`) with `/api/loop/state` fed a fixture-shaped lanes payload
      // through Playwright's own request interception, the real-browser equivalent of
      // `App.test.tsx`'s `stubFetch` pattern. §11's est telemetry overlay/live PR-open-early hint
      // are the genuinely live-only remainder (`?demo`'s own lanes capture above never carries
      // them — no live probe exists in replay) — this is what still needs a live route to show at
      // all, so it writes its own distinct `-lanes-live-overlay.png` file, alongside (never
      // instead of) the `?demo`-sourced `${idlePrefix}-lanes.png` the loop above now writes.
      await captureLiveOverlayLanes(page, theme, idlePrefix);
      await page.goto("/?demo");
      await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
      await page.locator("#overview").waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle");

      // Second state: scrub the transport to a genuine work-in-flight fold — the round's first
      // planning/reflection phase window when one exists (`scrubToActiveMoment`'s own doc, AC5
      // gate② finding [5]), giving genuine "active" evidence alongside the idle default above.
      const scrubbed = await scrubToActiveMoment(page);
      if (scrubbed) {
        const activePrefix = `${width}-${theme.key}-active`;
        // #922 AC5 gate② finding [5]: the hero-panel crop specifically must show the active
        // node's own halo — asserted once (1440px is the AC's own named canonical width) rather
        // than at every viewport, so a real fixture regression fails loudly instead of the crop
        // quietly going back to showing nothing active.
        if (width === CANONICAL_WIDTH) {
          await expect(
            page.locator(".hero-node-halo"),
            "the active capture must render a RUNNING planning/reflection node's halo (AC5)",
          ).toHaveCount(1);
        }
        await page.screenshot({ path: `${CAPTURES_DIR}/${activePrefix}-full.png`, fullPage: true });
        for (const [moduleKey, selectors] of Object.entries(MODULE_SELECTORS)) {
          const locator = await firstMatch(page, selectors);
          if (locator) await locator.screenshot({ path: `${CAPTURES_DIR}/${activePrefix}-${moduleKey}.png` });
        }
      }
    }
  }

  // #921 AC4: dedicated, on-demand real folds at the two moments `?demo`'s own single-round
  // bundle can't show on request (rings=0 — gate② PO review thread (b), never the bundle's own
  // "active" scrub, which only incidentally lands at rings=0 — and rings=24, nowhere near the
  // bundle's own 1-ring end state), at the mockup's own canonical 1440px width. One capture per
  // theme each, named for `buildContactSheet()`'s own dedicated `AC4_MOMENTS` pairing below.
  for (const theme of THEMES) {
    await captureRingsHero(page, theme, 0, "rings0");
    await captureRingsHero(page, theme, 24, "rings24");
    for (const slug of ["rings0", "rings24"]) {
      const file = `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-${slug}-hero-panel.png`;
      expect(existsSync(file), `${slug} hero-panel capture must exist: ${file}`).toBe(true);
    }
  }

  // #921 AC4/gate② finding [1]: the mockup's OWN OUTCOME right-zone crop, one per theme — paired
  // against the live crops above in `buildContactSheet()`'s own dedicated section below.
  for (const theme of THEMES) {
    const src = `${MOCKUPS_SRC_DIR}/hero-panel-${theme.key}.png`;
    if (existsSync(src)) await cropMockupOutcomeZone(page, src, `${MOCKUPS_OUT_DIR}/hero-panel-${theme.key}-outcome-zone.png`);
  }

  // #921 AC4/gate② finding [1]: presence-of-evidence assertion for every OUTCOME right-zone crop
  // named in the contact sheet's own AC4 section (`buildContactSheet()`, `AC4_MOMENTS`) — a
  // missing crop here is a real regression (a selector/route change silently broke a capture),
  // not something the contact sheet should quietly render blank.
  for (const prefix of [`${CANONICAL_WIDTH}-light-idle`, `${CANONICAL_WIDTH}-dark-idle`]) {
    const file = `${CAPTURES_DIR}/${prefix}-hero-panel-outcome-zone.png`;
    expect(existsSync(file), `OUTCOME right-zone capture must exist: ${file}`).toBe(true);
  }
  for (const theme of THEMES) {
    for (const slug of ["rings0", "rings24"]) {
      const zone = `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-${slug}-hero-panel-outcome-zone.png`;
      expect(existsSync(zone), `${slug} OUTCOME right-zone capture must exist: ${zone}`).toBe(true);
    }
    const mockupZone = `${MOCKUPS_OUT_DIR}/hero-panel-${theme.key}-outcome-zone.png`;
    expect(existsSync(mockupZone), `mockup OUTCOME right-zone crop must exist: ${mockupZone}`).toBe(true);
  }

  // #956 D13/D19/D23: three fixture moments the audit could not judge because no capture
  // exercised them at all — the hero's fix loop, the live header's PAUSE/STOP/EMERGENCY STOP
  // verbs, and a dimmed review-silence attention row. All three go through the real production
  // `App` -> `LiveApp` tree via `mockLiveApi` (never a hand-painted state), same discipline
  // `captureLiveOverlayLanes`/`captureRingsHero` above already apply — each function asserts the
  // fixture's own real content BEFORE its screenshot.
  for (const theme of THEMES) {
    await captureFixingFamily(page, theme);
    await captureLiveHeaderFamily(page, theme);
    await captureAttentionFamily(page, theme);
  }
  const d956Slugs = ["fixing-hero-panel", "fixing-lanes", "live-header", "attention3-needs-attention"];
  for (const theme of THEMES) {
    for (const slug of d956Slugs) {
      const file = `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-${slug}.png`;
      expect(existsSync(file), `#956 ${slug} capture must exist: ${file}`).toBe(true);
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
 * #922 AC8 gate② finding [7] (ac8-reduced-motion-animation-gap): happy-dom (`hero.test.ts`'s own
 * harness) never resolves the `animation` shorthand's own longhands — it echoes `""` for
 * `animationName` even under a matching `!important: none` rule (that file's own documented
 * limitation), so the unit-level reduced-motion test can only prove the WINNING computed VALUES
 * (fill-opacity at peak, etc), never that the animation itself is actually off. This is the real
 * browser probe the finding asks for instead: a genuine Chromium `getComputedStyle`, which DOES
 * resolve `animationName` correctly — removing `.hero[data-motion="reduced"] * { animation: none
 * !important }` (or the `prefers-reduced-motion` media-query twin) would turn this red, where the
 * happy-dom test's own fill-opacity assertions would stay green regardless.
 */
test("#922 AC8: prefers-reduced-motion resolves animation: none on the active node's disc AND halo, in a real browser", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: CANONICAL_WIDTH, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  const scrubbed = await scrubToActiveMoment(page);
  expect(scrubbed, "the fixture must carry a real scrub control to reach an active moment").toBe(true);

  const halo = page.locator(".hero-node-halo");
  await expect(halo, "the active node's halo must render under reduced motion (present, not removed)").toHaveCount(1);
  const disc = page.locator('[data-active="true"] .hero-planning-node');
  await expect(disc).toHaveCount(1);

  const [discAnimationName, haloAnimationName] = await Promise.all([
    disc.evaluate((el) => getComputedStyle(el).animationName),
    halo.evaluate((el) => getComputedStyle(el).animationName),
  ]);
  expect(discAnimationName, "the active disc's animation must actually resolve to none, not just a matching fill-opacity value").toBe(
    "none",
  );
  expect(haloAnimationName, "the halo's animation must actually resolve to none, not just a matching fill-opacity value").toBe("none");
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
 * bottom-edge/total-extent assertion at all.
 *
 * #927 gate② finding [0] (one-scroll-bound-weakened, run fec75181): the FIRST cut of #927's own
 * change to this test silently swapped the 1800px bound for a hardcoded 2100 while leaving the
 * test's own NAME and assertion text still claiming "one scroll (2× viewport height)" — an
 * internally-contradicting weakening of a bound this file's own history already fought two rounds
 * to tighten (findings ac1-geometry-not-pinned, ac1-one-scroll-boundary above), not a properly
 * recorded readjudication.
 *
 * #927 gate② finding [0] round 2 (ac4b-per-module-bounds, run 5c6c523c): applying ONE widened
 * bound to every module was itself still too loose — only `cost` (downstream of the now-taller
 * `lanes` real card grid) needed the wider reading at all; `hero`/`lanes`/`feed` never crossed the
 * ORIGINAL 1800px bound (measured 618px/1217px/1534px at 1440×900, `?demo` idle, post-#927 — see
 * below) and a shared 2100px bound would silently let any of the three regress past 1800px without
 * this test ever catching it. Split per module instead: `hero`/`lanes`/`feed` keep the ORIGINAL,
 * tighter `ONE_SCROLL_BOUNDARY_PX` (1800 = 2× viewport height — the same reading round 2's own
 * fix established); only `cost` gets the wider `COST_READJUDICATED_BOUNDARY_PX` (2100 — ~124px of
 * margin above the measured 1976.95px, the smallest round step past it, never a re-derivation from
 * `viewportHeight` that would silently track future growth unnoticed). `lanes` replaying a real
 * card grid (rather than `LiveOnly`'s short "live only" placeholder) is what pushes `cost`'s own
 * top edge past 1800px in the first place — #926's own AC2/AC3 already fixed that grid's real
 * mockup-scale anatomy (measured ~301px tall), so shrinking it back down to reclaim that headroom
 * would undo ALREADY-SHIPPED, separately-adjudicated requirements, not a legitimate fix for either
 * bound. Real measured tops at 1440×900 (`?demo`, idle, post-#927): hero 618px, lanes 1217px, feed
 * 1534px, cost 1977px.
 */
const ONE_SCROLL_BOUNDARY_PX = 1800;
const COST_READJUDICATED_BOUNDARY_PX = 2100;

test("§889 AC1 (cost's bound readjudicated by #927 — see doc comment): the round list never renders inline by default; hero/lanes/feed START within one scroll (1800px), cost within its readjudicated 2100px, all from the top at 1440px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  // The structural fix itself: the round list used to be `Transport.tsx`'s always-rendered
  // `<ul className="round-list">` — the ~9,000px/387-row live-route bulge the issue names. It now
  // lives entirely behind the header navigator's click-to-open state (`RoundNavigator.tsx`), so it
  // must be entirely absent from the DOM until that click happens — never present-but-hidden.
  expect(await page.locator(".round-list").count()).toBe(0);

  const modules: [string, Locator, number][] = [
    ["hero", page.locator("svg.hero"), ONE_SCROLL_BOUNDARY_PX],
    ["lanes", (await firstMatch(page, MODULE_SELECTORS.lanes ?? [])) ?? page.locator("nonexistent-lanes-anchor"), ONE_SCROLL_BOUNDARY_PX],
    ["feed", page.locator('section[aria-label="activity"]'), ONE_SCROLL_BOUNDARY_PX],
    ["cost", page.locator("#cost"), COST_READJUDICATED_BOUNDARY_PX],
  ];
  for (const [name, locator, boundaryPx] of modules) {
    const box = await locator.boundingBox();
    expect(box, `${name} module must render with a real bounding box`).not.toBeNull();
    expect(
      box?.y,
      `${name}'s top edge must start within its own ${boundaryPx}px bound from the top — never pushed further down by round history`,
    ).toBeLessThan(boundaryPx);
  }
});

/**
 * #926 AC1/Q3 owner ruling: lanes and activity now each claim a full-width `.stack` row (lanes
 * first), superseding #897's shared two-column `.lane-activity-row` split — that pairing left no
 * room for this issue's mockup-scale head/body card anatomy. `App.test.tsx`'s own STYLE test can
 * only prove the DECLARED `grid-column: 1/-1` (happy-dom has no real CSS Grid layout engine); a
 * real browser is what proves the cascade actually resolves both modules to the full row width
 * and stacks them, the same "real layout, not a stand-in" posture this file's other tests apply.
 */
test("#926 AC1: at 1440px, the lane board and activity feed each span the row's full width and stack — lanes above activity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const stackBox = await page.locator("main.stack").boundingBox();
  expect(stackBox, "the .stack row must render with a real bounding box").not.toBeNull();

  // #927: `?demo` is always replay mode (`App.tsx`'s `DemoApp` doc), but the real `LaneBoard`
  // mounts there now too (`deriveReplayedLanes`) — this is the SAME full-width panel-shaped
  // section every other module already renders, not a placeholder stand-in.
  const laneSlot = (await firstMatch(page, MODULE_SELECTORS.lanes ?? [])) ?? page.locator("nonexistent-lanes-anchor");
  const feedSlot = page.locator('section[aria-label="activity"]');
  const laneBox = await laneSlot.boundingBox();
  const feedBox = await feedSlot.boundingBox();
  expect(laneBox, "the lane board slot must render with a real bounding box").not.toBeNull();
  expect(feedBox, "the activity feed must render with a real bounding box").not.toBeNull();

  const tolerancePx = 24;
  // `.stack` (app.css) carries its own `padding: var(--space-4)` (16px each side) — a grid item's
  // own box sits inside that content box, never spanning the padding, so the target is the
  // CONTENT width, not `.stack`'s own border-box width `boundingBox()` reports.
  const stackContentWidth = stackBox!.width - 2 * 16;
  expect(laneBox!.width, "the lane board must span the .stack row's full content width").toBeGreaterThan(stackContentWidth - tolerancePx);
  expect(feedBox!.width, "the activity feed must span the .stack row's full content width").toBeGreaterThan(
    stackContentWidth - tolerancePx,
  );

  // Stacked, not side by side: activity's top edge must sit at/after the lane board's own bottom
  // edge — the opposite of #897's same-row check, which asserted an overlapping Y range.
  expect(feedBox!.y, "activity must render BELOW the lane board, not beside it").toBeGreaterThanOrEqual(
    laneBox!.y + laneBox!.height - tolerancePx,
  );
});

/**
 * #926 AC2: the board's own per-viewport card count/width — genuinely CI-checkable via real
 * `boundingBox()`es, distinct from AC5's human-witnessed crop-pair comparison. Uses the SAME
 * live-mocked `#882` fixture (`liveLanesLoopState`, `lanesMax: 4` — 3 real lanes + 1 idle slot) as
 * `captureLiveOverlayLanes` below, so the real `LaneBoard` mounts through the live route directly
 * (a `?demo` mount would work here too since #927 — the live route is kept for its own genuinely
 * live-only cards, matching `liveLanesLoopState`'s est/PR variety `?demo`'s replayed fold can't
 * produce on demand).
 */
test("#926 AC2: the board renders 3 cards per row at 1440px, 2 at 1024px, 1 at 720px, each >= 400px wide", async ({ page }) => {
  const expectedPerRow: Record<(typeof VIEWPORTS)[number], number> = { 1440: 3, 1024: 2, 720: 1 };
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    await mockLiveApi(page, liveLanesLoopState());
    await page.goto("/");
    const lanes = page.locator('section[aria-label="lanes"]');
    await lanes.waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");

    const cardBoxes = [];
    const cards = page.locator(".lane-card");
    for (let i = 0; i < (await cards.count()); i++) {
      const box = await cards.nth(i).boundingBox();
      if (box) cardBoxes.push(box);
    }
    expect(cardBoxes.length, `at ${width}px expected the fixture's 4 lane-card slots (3 real + 1 idle)`).toBe(4);

    // Group into rows by shared Y (a small tolerance for sub-pixel rounding across a row).
    const rowTolerancePx = 4;
    const rows: (typeof cardBoxes)[] = [];
    for (const box of cardBoxes) {
      const row = rows.find((r) => Math.abs(r[0]!.y - box.y) < rowTolerancePx);
      if (row) row.push(box);
      else rows.push([box]);
    }
    const firstRow = rows[0] ?? [];
    expect(firstRow.length, `at ${width}px expected ${expectedPerRow[width]} cards in the first row`).toBe(expectedPerRow[width]);
    for (const box of firstRow) {
      expect(box.width, `at ${width}px each card must be >= 400px wide`).toBeGreaterThanOrEqual(400);
    }
    await page.unroute("**/api/**");
  }
});

/**
 * #923 AC4: the two proportions this issue's own STYLE/WIRING tests can only pin as authored
 * declarations (no real layout engine in `happy-dom` — `App.test.tsx`'s own AC1/AC3 comments) are
 * checked here as scripted numeric facts against REAL rendered `boundingBox()`es, modeled on the
 * `#897 AC5` pattern directly above: `.spend-meter-bar`'s live width vs `.app-header`'s live
 * width, and `.transport-scrub`'s live width vs its own row's live width. `?demo` is always
 * replay mode once its fixture loads (`App.tsx`'s `DemoApp` doc) — the transport row and its scrub
 * bar are already on screen at `#overview`, no navigator click needed to reach them.
 */
test("#923 AC4: at 1440px, .spend-meter-bar's live width is >= 25% of .app-header's live width, and .transport-scrub's live width is >= 60% of its row's live width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const header = page.locator(".app-header");
  const headerBox = await header.boundingBox();
  expect(headerBox, "the .app-header must render with a real bounding box").not.toBeNull();

  const meter = page.locator(".spend-meter-bar");
  const meterBox = await meter.boundingBox();
  expect(meterBox, "the .spend-meter-bar capsule must render with a real bounding box").not.toBeNull();
  expect(
    meterBox!.width,
    `the spend meter (${meterBox!.width}px) must be >= 25% of the header's width (${(headerBox!.width * 0.25).toFixed(0)}px)`,
  ).toBeGreaterThanOrEqual(headerBox!.width * 0.25);

  const scrub = page.locator(".transport-scrub");
  const scrubRow = scrub.locator("xpath=..");
  const scrubBox = await scrub.boundingBox();
  const rowBox = await scrubRow.boundingBox();
  expect(scrubBox, "the .transport-scrub input must render with a real bounding box").not.toBeNull();
  expect(rowBox, "the scrub bar's own row must render with a real bounding box").not.toBeNull();
  expect(
    scrubBox!.width,
    `the scrubber (${scrubBox!.width}px) must be >= 60% of its row's width (${(rowBox!.width * 0.6).toFixed(0)}px)`,
  ).toBeGreaterThanOrEqual(rowBox!.width * 0.6);
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
 * 4. `--sap-fill` itself (#924: the filled-surface role split off `--sap`, the exact token
 *    `.transport-scrub`'s thumb/track rules now consume) resolves to a real, non-empty color at
 *    `:root` in both themes, AND — unlike `--sap-text` above, which still varies per theme — it
 *    resolves to the SAME color in both, proving the split's own deliberate invariant (tokens.css:
 *    `--sap-fill` is a flat amber in both themes, no longer `light-dark()`) rather than a stale
 *    assumption every themed token must differ. The source declaration for the thumb rule is
 *    cross-checked to reference that same token by name. Together these are the closest available
 *    real-browser proof for the thumb specifically: `getComputedStyle(el, pseudo)` is NOT usable
 *    for vendor slider pseudo-elements — verified directly (a scratch probe against this exact
 *    page returned the BASE element's own box for `::-webkit-slider-thumb`, while a `::before`
 *    sanity probe on the same API resolved correctly), which is a documented Chromium limitation
 *    of the query API itself, not of the underlying paint. A single-pixel screenshot sample would
 *    be the only way to query the pseudo-element's actual paint color directly, and this file's
 *    own stated posture is "no pixel-diff gate" — the token-level computed proof plus the
 *    source-level rule binding is the honest ceiling here, not a shortcut around a harder check.
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
  const backToLiveBackgroundByTheme: Record<string, string> = {};

  for (const theme of themes) {
    await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);

    // The play/speed BUTTONS' own real computed style, not just the scrub input's native-chrome
    // opt-out above — an operator probe against production (issue #889 comment) confirmed those
    // buttons computed `font-family: Arial`, no mono rule reaching them, while the sibling
    // `.transport-position` readout correctly resolved "JetBrains Mono Variable". Compares against
    // `.transport-position`'s own real computed font-family (a fact, not a hand-copied token
    // literal) rather than hardcoding the expected mono stack.
    const positionFontFamily = await page.locator(".transport-position").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(positionFontFamily, `${theme.key}: the .transport-position readout must resolve a real font-family`).not.toBe("");

    // #923: "back to live" moved to the header row's own `.header-back-to-live` button — no longer
    // inside `.transport-controls` (a single control now covers what three duplicate copies used
    // to). Its mono font is checked alongside play/speed below; its background is checked
    // separately further down (a DELIBERATELY flat `--sap-fill`, not the panel-themed background
    // the play/speed buttons still carry — see that check's own comment).
    const backToLive = page.locator(".header-back-to-live");
    const playButton = page.locator('.transport-controls button[aria-label="play"], .transport-controls button[aria-label="pause"]');
    const speedButton = page.locator(".transport-speed");
    expect(await speedButton.count(), `${theme.key}: exactly one cycling speed box must be present, never a three-chip row`).toBe(1);

    const monoTargets: [string, Locator][] = [
      ["back to live", backToLive],
      ["play/pause", playButton],
      ["speed", speedButton],
    ];
    for (const [label, locator] of monoTargets) {
      const fontFamily = await locator.first().evaluate((el) => getComputedStyle(el).fontFamily);
      expect(
        fontFamily,
        `${theme.key}: the ${label} button must resolve the SAME mono font-family as .transport-position, not native/body chrome`,
      ).toBe(positionFontFamily);
    }

    // Background too, per the same STYLE rule — the "no native default chrome" half of AC2, not
    // just the font. `playButton` (still inside `.transport-controls`, `var(--panel)`) is the
    // theme-varying proof; `.header-back-to-live` (D15's filled `--sap-fill` button) is checked
    // separately below against the SAME flat-token proof #924 already establishes for `--sap-fill`.
    const buttonBackground = await playButton.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(buttonBackground, `${theme.key}: the play button must resolve a real token background, not native transparent chrome`).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    buttonBackgroundByTheme[theme.key] = buttonBackground;
    backToLiveBackgroundByTheme[theme.key] = await backToLive.first().evaluate((el) => getComputedStyle(el).backgroundColor);

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

    const sapFillToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sap-fill").trim());
    expect(sapFillToken, `${theme.key}: --sap-fill must resolve to a real color at :root`).not.toBe("");
    sapTokenByTheme[theme.key] = sapFillToken;
  }

  expect(
    pillClosedColorByTheme.light,
    "the closed-pill tint must actually differ between light and dark themes — proof light-dark() genuinely cascades, not a theme-invariant hardcoded value",
  ).not.toBe(pillClosedColorByTheme.dark);
  // #924: --sap-fill is deliberately FLAT (same value both themes, tokens.css) — the inverse of
  // the light-dark() proofs above, on purpose.
  expect(
    sapTokenByTheme.light,
    "--sap-fill must resolve to the SAME color in both themes — it is deliberately flat, not light-dark()",
  ).toBe(sapTokenByTheme.dark);
  expect(
    buttonBackgroundByTheme.light,
    "the transport button background must actually differ between light and dark themes — proof light-dark() genuinely cascades onto it, not a theme-invariant hardcoded value",
  ).not.toBe(buttonBackgroundByTheme.dark);
  // #923 D15: the header's own BACK TO LIVE button is a filled `--sap-fill` surface — the
  // deliberately FLAT token, same posture the `sapTokenByTheme` proof above already establishes —
  // so its real computed background is the SAME real color in both themes, never light-dark().
  expect(
    backToLiveBackgroundByTheme.light,
    "the header's BACK TO LIVE button must resolve the SAME background color in both themes — --sap-fill is deliberately flat",
  ).toBe(backToLiveBackgroundByTheme.dark);
  expect(
    backToLiveBackgroundByTheme.light,
    "back-to-live button must resolve a real token background, not native transparent chrome",
  ).not.toBe("rgba(0, 0, 0, 0)");

  const panelsCss = readFileSync(fileURLToPath(new URL("../src/panels.css", import.meta.url)), "utf8");
  const thumbRule = panelsCss.match(/\.transport-scrub::-webkit-slider-thumb\s*\{([^}]*)\}/);
  expect(thumbRule, ".transport-scrub::-webkit-slider-thumb rule must exist").not.toBeNull();
  expect(thumbRule?.[1], "the thumb rule must consume the SAME --sap-fill token just proven above").toMatch(
    /background:\s*var\(--sap-fill\)/,
  );
});

/**
 * #892 AC5: the Legend "?" popover no longer reflows the header. Was a native `<details>` whose
 * `<ul>` content grew `.hero-legend`'s own in-flow box on open, shoving everything after it (the
 * "?" trigger itself included) down — moving it out from under the pointer mid-interaction, the
 * exact defect this issue's "Why" names. Now a Radix `Popover.Portal`, which renders `.app-header`
 * a sibling in a completely different part of the tree (document.body), never a child — this is
 * the real-browser proof no component test (DOM-presence only, no real CSS layout engine) can
 * give: `.app-header`'s own `boundingBox()` (y/height) must be bit-for-bit identical before and
 * after the popover opens.
 */
test("#892 AC5: opening the legend popover does not reflow .app-header — same y/height before and after", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const header = page.locator(".app-header");
  const before = await header.boundingBox();
  expect(before, "the header must render with a real bounding box before opening the legend").not.toBeNull();

  const trigger = page.locator('button[aria-label="Legend"]');
  await trigger.click();
  await expect(page.locator("text=droplet = an issue moving through the loop")).toBeVisible();

  const after = await header.boundingBox();
  expect(after, "the header must still render with a real bounding box once the legend is open").not.toBeNull();
  expect(after?.y, "the header's top edge must not move — no reflow from the popover's own content").toBe(before?.y);
  expect(after?.height, "the header's height must not grow — the popover's content lives outside .app-header entirely").toBe(
    before?.height,
  );
});

/**
 * #892 AC3 (#876 C-2 ruling): native `<dialog>.showModal()` focus-trap containment and
 * Escape→cancel, proven for real — happy-dom's `<dialog>` doesn't implement either (see this
 * issue's verification plan and `test-dom.ts`'s own doc), so a component-suite assertion here
 * would prove nothing about the real defect. `PhaseInspectorDrawer` is the one migrated dialog
 * reachable from the `?demo` fixture this pipeline drives without a mocked live route.
 * `ConfigDrawer` and `Controls`' confirm dialog are both `LiveOnly`-gated (`App.tsx`'s
 * `mode === "live"`) and get their own dedicated real-browser focus-trap/Escape proof further
 * below, through the same mocked live-API route `captureLiveOverlayLanes` drives — all three route
 * through the exact same browser mechanism (`.showModal()` on a native `<dialog>`), so this test
 * plus those two together are this AC's full real-browser coverage, not proof scoped to one call
 * site alone. `ConfigDrawer.test.tsx`/`Controls.test.tsx` (Tier A) separately pin
 * `showModal()`-was-invoked/`.open`-state, which happy-dom CAN legitimately cover.
 */
test("#892 AC3: the phase inspector dialog traps focus (background inert) and Escape cancels it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  // Baseline, BEFORE the dialog ever opens: `.icon-rail-config` is a real, natively focusable
  // `<button>` (unlike `.icon-rail-wordmark`, a plain non-interactive `<span>`) — calling
  // `.focus()` on a non-focusable element is ALREADY a no-op with no modal in play, so it can't
  // attribute a later "still not focused" result to inertness specifically. Confirming it CAN
  // take focus now is what makes the later "can't focus it anymore" check inside the modal
  // actually mean something.
  const bgFocusable = await page.evaluate(() => {
    const bg = document.querySelector<HTMLElement>(".icon-rail-config");
    bg?.focus();
    return document.activeElement === bg;
  });
  expect(
    bgFocusable,
    "sanity check: .icon-rail-config must be focusable with no dialog open, or the inertness check below proves nothing",
  ).toBe(true);

  const node = page.locator('[aria-label^="inspect "]').first();
  await node.click();
  const dialog = page.locator('dialog[aria-label="phase inspector"]');
  await expect(dialog).toBeVisible();

  // Focus containment: Tab repeatedly. A real UA focus trap keeps the active element either
  // inside the dialog or resting on `<body>` (Chromium's own behavior once a modal's focusable
  // descendants are exhausted — a harmless, non-interactive fallback, never the SAME thing as
  // reaching an actual background control) — but the SAME known-focusable background control
  // (`.icon-rail-config`, just proven reachable above) must never become the active element,
  // which is the concrete, unambiguous proof background content stays unreachable.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await dialog.evaluate((el) => ({
      insideDialog: el.contains(document.activeElement),
      isBody: document.activeElement === document.body,
      isBackgroundConfigButton: document.activeElement?.classList.contains("icon-rail-config") ?? false,
    }));
    expect(
      info.insideDialog || info.isBody,
      `Tab press #${i + 1}: focus must stay inside the dialog (or rest on <body>), never land on a background element`,
    ).toBe(true);
    expect(info.isBackgroundConfigButton, `Tab press #${i + 1} must never reach the background icon rail`).toBe(false);
  }

  // Background inert: the SAME control just proven focusable above must now be a no-op .focus()
  // target while the dialog is modal — the actual "inert" behavior, not merely "Tab doesn't
  // happen to land there".
  const stillOutside = await page.evaluate(() => {
    const bg = document.querySelector<HTMLElement>(".icon-rail-config");
    bg?.focus();
    return document.activeElement !== bg;
  });
  expect(stillOutside, "a background element must not be focusable while the dialog is modal (background inert)").toBe(true);

  // Escape -> cancel: the native `close` event this issue wires to `onClose` must actually remove
  // the dialog from the page.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

/** #892 AC4: sanity check shared by the two dialog tests below — the SAME background control the
 *  containment check later proves unreachable must be genuinely focusable right now, with no
 *  dialog open, or "still not focused" inside the modal wouldn't mean anything (the phase
 *  inspector test above establishes the same precondition for its own background target). */
async function assertBackgroundFocusable(page: Page, backgroundSelector: string): Promise<void> {
  const bgFocusable = await page.evaluate((selector) => {
    const bg = document.querySelector<HTMLElement>(selector);
    bg?.focus();
    return document.activeElement === bg;
  }, backgroundSelector);
  expect(
    bgFocusable,
    `sanity check: ${backgroundSelector} must be focusable with no dialog open, or the inertness check below proves nothing`,
  ).toBe(true);
}

/** #892 AC4: the shared native `<dialog>` proof — repeated Tab never lands focus on the
 *  known-focusable background control (containment) or escapes to nowhere (rests on `<body>` at
 *  worst, Chromium's own harmless fallback), the SAME control is a `.focus()` no-op while the
 *  dialog is open (background inert), and Escape closes the dialog via its native `close` event.
 *  Factored out of the phase inspector test above (which stays as its own inline proof for the
 *  ORIGINAL migrated dialog) so `ConfigDrawer` and `Controls`' confirm dialog below don't each
 *  repeat the same 20-line Tab loop for what is, per this issue's own AC4, one shared browser
 *  mechanism (`.showModal()` on a native `<dialog>`). */
async function assertDialogTrapsFocusAndEscapeCancels(page: Page, dialog: Locator, backgroundSelector: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await dialog.evaluate(
      (el, selector) => ({
        insideDialog: el.contains(document.activeElement),
        isBody: document.activeElement === document.body,
        isBackgroundTarget: document.activeElement === document.querySelector(selector),
      }),
      backgroundSelector,
    );
    expect(
      info.insideDialog || info.isBody,
      `Tab press #${i + 1}: focus must stay inside the dialog (or rest on <body>), never land on a background element`,
    ).toBe(true);
    expect(info.isBackgroundTarget, `Tab press #${i + 1} must never reach the background control`).toBe(false);
  }

  const stillOutside = await page.evaluate((selector) => {
    const bg = document.querySelector<HTMLElement>(selector);
    bg?.focus();
    return document.activeElement !== bg;
  }, backgroundSelector);
  expect(stillOutside, "a background element must not be focusable while the dialog is modal (background inert)").toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/**
 * #892 AC4: `ConfigDrawer` is wrapped in `LiveOnly` (App.tsx) — it only ever mounts in live mode,
 * so the `?demo` fixture the phase-inspector test above uses can never reach it. Reuses the same
 * `mockLiveApi`/`liveLanesLoopState` fixture `captureLiveOverlayLanes` below drives, the real-browser
 * equivalent of `App.test.tsx`'s live-mode render, to reach the real production `App` ->
 * `LiveApp` -> `ConfigDrawer` tree rather than a standalone stand-in built to bypass that gate.
 */
test("#892 AC4: the config drawer traps focus (background inert) and Escape cancels it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLiveApi(page, liveLanesLoopState());
  await page.goto("/");
  await page.locator('section[aria-label="lanes"]').waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const backgroundSelector = ".icon-rail-config";
  await assertBackgroundFocusable(page, backgroundSelector);

  await page.locator('[aria-label="open config"]').click();
  const dialog = page.locator('dialog[aria-label="config"]');
  await expect(dialog).toBeVisible();

  await assertDialogTrapsFocusAndEscapeCancels(page, dialog, backgroundSelector);
});

/**
 * #892 AC4: `Controls`' confirm dialog only renders while `mode === "live"` AND the caller's
 * `controlsEnabled` is true (App.tsx) — same live-only gate as `ConfigDrawer`, reached the same
 * way. Beyond the shared focus-trap/Escape proof, this pins the misfire-protection contract
 * itself in a real browser: Escape must cancel WITHOUT ever reaching `POST /api/control` (the
 * hold-to-arm/confirm reducer's whole point, `Controls.tsx`'s own doc), and the control must
 * return to its normal, un-armed, clickable state afterward — not left disabled or wedged in
 * `confirming`.
 */
test("#892 AC4: the operations confirm dialog traps focus (background inert) and Escape cancels without firing the control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLiveApi(page, liveLanesLoopState());
  let controlCalls = 0;
  // Registered AFTER `mockLiveApi`'s own `**/api/**` route, so Playwright tries this
  // more-recently-added, more-specific handler first for `/api/control` — the general route
  // above has no `/api/control` entry in its `byPath` map and would otherwise 404 it.
  await page.route("**/api/control", async (route) => {
    controlCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "running" }) });
  });
  await page.goto("/");
  await page.locator('section[aria-label="lanes"]').waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const backgroundSelector = ".icon-rail-config";
  await assertBackgroundFocusable(page, backgroundSelector);

  const pauseButton = page.locator("fieldset.controls button", { hasText: "Pause" });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  const dialog = page.locator('dialog[aria-label="confirm pause"]');
  await expect(dialog).toBeVisible();

  await assertDialogTrapsFocusAndEscapeCancels(page, dialog, backgroundSelector);

  expect(controlCalls, "Escape must cancel the confirm dialog without ever POSTing the control").toBe(0);

  // Un-armed afterward: the same verb is visible and clickable again, not left disabled by a
  // reducer stuck outside `idle` — proves Escape's `cancel` action actually landed, not just that
  // the dialog element itself closed.
  await expect(pauseButton).toBeVisible();
  await expect(pauseButton).toBeEnabled();
});

/**
 * #924 AC2 (simplest architecture that is correct — no runtime measurement needed): `CostBar.tsx`
 * has no `viewBox`/`preserveAspectRatio` — the settled fill is a real
 * rounded `<rect rx>`, whose rounding is carved INWARD from its own x/width box (unlike a stroked
 * line's round linecap, which bulges OUTWARD past its own endpoint), so it's fully contained at
 * every settled percentage with no runtime measurement or scale-compensation machinery needed.
 * This is the real-pixel proof that holds in an actual browser, reusing the SAME fixtures the
 * rest of this file already drives — never a bespoke harness: the mocked live lane board (w1: est-
 * only, 0% settled; w3: costUsd $1.10 of a $10 soft budget ≈ 11% settled, `.lane-card-bar`) and
 * the `?demo` fixture's cost panel (its "Lanes" by-stage bar self-scales to its own group's own
 * max, i.e. 100% settled; "Goal & align" stays at 0%, the only spend this fixture records is in
 * the "Lanes"/executing phase).
 */
test("#924 AC2: the pill's round caps stay inside the bar box at 0%/partial/100% settled, with the light outline present at both caps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 0% (est-only, no settled fill at all) and ~11% partial (lane w3: $1.10 of a $10 soft budget).
  await mockLiveApi(page, liveLanesLoopState());
  await page.goto("/");
  await page.locator('section[aria-label="lanes"]').waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "sapwood"));

  const w1Card = page.locator(".lane-card", { hasText: "w1" });
  expect(await w1Card.locator(".cost-bar-fill").count(), "lane w1 (est-only, 0% settled) must render no fill rect at all").toBe(0);

  const w3Card = page.locator(".lane-card", { hasText: "w3" });
  await assertPillCapsContained(page, w3Card.locator("svg.lane-card-bar"), "lane w3 (~11% settled)", { left: true, right: false });

  // 100%: the ?demo fixture's cost panel "Lanes" by-stage bar self-scales to its own group max.
  await page.goto("/?demo");
  await page.locator("#cost").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "sapwood"));

  const lanesRow = page.locator("#cost .cost-bar-row", { hasText: "Lanes" }).first();
  await assertPillCapsContained(page, lanesRow.locator("svg.cost-bar"), "Lanes stage (100% settled)", { left: true, right: true });

  const zeroRow = page.locator("#cost .cost-bar-row", { hasText: "Goal & align" }).first();
  expect(await zeroRow.locator(".cost-bar-fill").count(), "Goal & align stage (0% settled) must render no fill rect at all").toBe(0);
});

/**
 * #926 AC3 (rendered oracle, real Chromium): the est-only lane card's own hatch stroke must
 * clear >= 3:1 against the track in dark theme. `App.test.tsx`'s own real-DOM test proves the
 * SAME contract in happy-dom, but happy-dom cannot resolve `var()` from a plain SVG presentation
 * attribute at all (confirmed directly — `getComputedStyle(line).stroke` reads back `""`, not the
 * unfixed `--bark` OR the fixed `--sap-fill`), so it needed `CostBar.tsx`'s `<line>` moved onto a
 * `style=` declaration to become resolvable there. A real browser has no such gap — this test
 * reads the SAME computed `stroke` real Chromium actually paints with, AND independently confirms
 * a real pixel was painted with it (not just declared), the two kinds of evidence together closing
 * the exact hole the CSS-source/luminance-math "oracle" (tokens.test.ts, removed) left open: it
 * asserted the TOKEN pair would clear 3:1 if rendered, never that the referenced `<pattern>`
 * actually was the lane's own.
 */
test("#926 AC3: the lane card's own est hatch resolves --sap-fill and clears 3:1 against the track in dark theme (real pixel)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLiveApi(page, liveLanesLoopState());
  await page.goto("/");
  await page.locator('section[aria-label="lanes"]').waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "heartwood"));

  // w1: costUsd null, estCostUsd 0.53 — est-only, 0% settled, same fixture the #924 AC2 test above
  // already relies on for "no fill rect at all".
  const w1Card = page.locator(".lane-card", { hasText: "w1" });
  const hatchRect = w1Card.locator("svg.lane-card-bar rect[fill]");
  await expect(hatchRect, "lane w1 (est-only) must render a hatch rect").toHaveCount(1);
  await hatchRect.scrollIntoViewIfNeeded();

  // Resolve the SAME way a browser does: follow `fill="url(#id)"` to the actual referenced
  // `<pattern>` (`getElementById` — SVG ids are document-global, never scoped to their own
  // subtree) and read ITS OWN `<line>`'s computed stroke. A stale shared id would resolve to
  // whichever `<pattern>` is first in the DOM instead — the header spend meter's, carrying
  // `--bark`, not this bar's own `--hatch-stroke-lane`.
  const strokeRgb = await hatchRect.evaluate((rect) => {
    const url = rect.getAttribute("fill") ?? "";
    const id = url.match(/^url\(#(.+)\)$/)?.[1];
    if (!id) throw new Error(`unexpected fill value: ${url}`);
    const pattern = document.getElementById(id);
    const line = pattern?.querySelector("line");
    if (!line) throw new Error("no <line> found inside the referenced pattern");
    return getComputedStyle(line).stroke;
  });
  const sapFillHex = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sap-fill").trim());
  const barkHex = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bark").trim());
  expect(
    rgbStringToHex(strokeRgb),
    `the lane's own hatch line must resolve --sap-fill (${sapFillHex}) — the lane-scoped override — not --bark (${barkHex}), the shared default a stale shared pattern id would leak in`,
  ).toBe(sapFillHex.toUpperCase());

  // Real-pixel corroboration that paint, not just declared style, reached the page: the hatch is
  // a repeating 3px diagonal pattern, so a single fixed coordinate risks landing on a gap between
  // strokes — scan the rect's own tiny bounding box for its most-saturated pixel (the stroke's own
  // peak) instead of guessing one coordinate.
  const geometry = await hatchRect.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, centerY: r.top + r.height / 2 };
  });
  const trackRgb = await samplePixel(page, geometry.right + 12, geometry.centerY);
  const peakRgb = await scanPeakDeltaPixel(
    page,
    geometry.x,
    geometry.y,
    Math.max(1, Math.round(geometry.width)),
    Math.max(1, Math.round(geometry.height)),
    [trackRgb[0], trackRgb[1], trackRgb[2]],
  );
  const trackHex = rgbToHex(trackRgb[0], trackRgb[1], trackRgb[2]);
  const peakHex = rgbToHex(peakRgb[0], peakRgb[1], peakRgb[2]);
  const ratio = contrastRatio(peakHex, trackHex);
  expect(
    ratio,
    `lane hatch peak pixel ${peakHex} vs sampled track ${trackHex} must clear ${NON_TEXT_AA}:1 in dark theme, measured ${ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(NON_TEXT_AA);
});

/** `rgb(r, g, b)`/`rgba(r, g, b, a)`, as `getComputedStyle` returns it, to `#RRGGBB`. */
function rgbStringToHex(rgb: string): string {
  const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`not an rgb()/rgba() colour: ${rgb}`);
  return rgbToHex(Number(match[1]), Number(match[2]), Number(match[3]));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Screenshots a small region and returns the pixel with the greatest colour distance from
 *  `referenceRgb` — the region's own most-saturated point, robust to a fixed-coordinate sample
 *  missing a thin repeating stroke entirely. */
async function scanPeakDeltaPixel(
  page: Page,
  x: number,
  y: number,
  width: number,
  height: number,
  referenceRgb: [number, number, number],
): Promise<[number, number, number]> {
  const buffer = await page.screenshot({ clip: { x, y, width, height } });
  const base64 = buffer.toString("base64");
  return page.evaluate(
    async ({ base64, referenceRgb }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to decode the cropped screenshot"));
        img.src = `data:image/png;base64,${base64}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let best: [number, number, number] = [referenceRgb[0], referenceRgb[1], referenceRgb[2]];
      let bestDist = -1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] as number;
        const g = data[i + 1] as number;
        const b = data[i + 2] as number;
        const dist = (r - referenceRgb[0]) ** 2 + (g - referenceRgb[1]) ** 2 + (b - referenceRgb[2]) ** 2;
        if (dist > bestDist) {
          bestDist = dist;
          best = [r, g, b];
        }
      }
      return best;
    },
    { base64, referenceRgb },
  );
}

/**
 * #925 AC5 — THE real measurement AC5 names ("every chip the SAME computed width, every entity
 * ref cell the same left edge, every age box the same right edge... the longest word still fits").
 * happy-dom (`NeedsAttention.test.tsx`'s own harness) never runs a real layout pass — confirmed
 * directly against it: `getBoundingClientRect`/`scrollWidth`/`clientWidth` all read back
 * hard-coded 0 on every element, real DOM or not. That suite's own "#925 AC5" test is the FAST
 * structural guard (a CSS-Grid-determinism argument over `getComputedStyle`'s CASCADE reads, which
 * happy-dom DOES resolve faithfully — that test's own comment makes the case for why the structural
 * proof is sound) — it is not, and was never meant to be, a stand-in for measuring real boxes.
 * THIS is the actual geometry oracle, run against Chromium's real layout engine at the `?demo`
 * fixture's real rows: FIX CAP / DECISION / REVIEW SILENCE — three categories, including
 * `ATTENTION_CATEGORY`'s own longest word, no fixture rebuild needed (leg 2's demo-fixture growth,
 * #925 AC4, already put >=3 rows across >=3 categories on this exact page).
 */
test("#925 AC5 (REAL measurement, the actual geometry proof — see NeedsAttention.test.tsx's own AC5 test for the fast structural guard): every .attention-chip is the same rendered width, every entity cell shares the same left edge, every age box shares the same right edge, and REVIEW SILENCE fits inside its chip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const rows = page.locator(".attention-row");
  expect(await rows.count(), "COVERAGE: the ?demo fixture must render >= 3 rows for this oracle to mean anything").toBeGreaterThanOrEqual(
    3,
  );

  const categories = (await page.locator(".attention-chip").allTextContents()).map((t) => t.trim());
  expect(new Set(categories).size, "COVERAGE: the rendered rows must span >= 3 distinct categories").toBeGreaterThanOrEqual(3);
  expect(categories, "the fixture must include ATTENTION_CATEGORY's own longest word").toContain("REVIEW SILENCE");

  const tolerancePx = 1;

  const chipWidths = await page.locator(".attention-chip").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  const firstChipWidth = chipWidths[0]!;
  for (const w of chipWidths) {
    expect(
      Math.abs(w - firstChipWidth),
      `every .attention-chip must render at the SAME width (±${tolerancePx}px), got: ${chipWidths.join(", ")}`,
    ).toBeLessThanOrEqual(tolerancePx);
  }

  const entityLefts = await page.locator(".attention-entity").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  const firstEntityLeft = entityLefts[0]!;
  for (const l of entityLefts) {
    expect(
      Math.abs(l - firstEntityLeft),
      `every entity cell must share the SAME left edge (±${tolerancePx}px), got: ${entityLefts.join(", ")}`,
    ).toBeLessThanOrEqual(tolerancePx);
  }

  const ageRights = await page.locator(".attention-age").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
  const firstAgeRight = ageRights[0]!;
  for (const r of ageRights) {
    expect(
      Math.abs(r - firstAgeRight),
      `every age box must share the SAME right edge (±${tolerancePx}px), got: ${ageRights.join(", ")}`,
    ).toBeLessThanOrEqual(tolerancePx);
  }

  // The load-bearing "fit" claim: scrollWidth (the chip's own unclipped content) <= clientWidth
  // (its rendered visible box) proves the longest real category word never overflows its
  // fixed-width chip — a real-browser fact `white-space: nowrap` alone can't establish (nowrap
  // only stops a SECOND line; it says nothing about whether the first one fits).
  const longestChip = page.locator(".attention-chip", { hasText: "REVIEW SILENCE" });
  await expect(longestChip, "the REVIEW SILENCE chip must render").toHaveCount(1);
  const [scrollWidth, clientWidth] = await longestChip.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(
    scrollWidth,
    `REVIEW SILENCE must fit inside its own chip: scrollWidth (${scrollWidth}px) <= clientWidth (${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth);
});

/**
 * #925 AC4 — real-Chromium companion to `NeedsAttention.test.tsx`'s own regex guard
 * (`/^\d+[smhd]$/`, which happy-dom's zeroed layout metrics can't itself prove FITS): the
 * emphasis box's own bold ≥40px numeral must fit inside its box, and the box itself must stay
 * inside the panel it sits in — neither may overflow, under a real browser layout engine.
 */
test("#925 AC4 (REAL measurement): the emphasis age box's text fits inside the box, and the box's own right edge sits inside the needs-attention panel's content box", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const emphasis = page.locator(".attention-age-emphasis");
  await expect(emphasis, "exactly one row must carry the emphasis box").toHaveCount(1);

  const [scrollWidth, clientWidth] = await emphasis.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(
    scrollWidth,
    `the emphasis numeral must fit its own box: scrollWidth (${scrollWidth}px) <= clientWidth (${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth);

  const panel = page.locator('section[aria-label="needs attention"]');
  const [emphasisRight, panelContentRight] = await Promise.all([
    emphasis.evaluate((el) => el.getBoundingClientRect().right),
    panel.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const paddingRight = Number.parseFloat(getComputedStyle(el).paddingRight);
      return rect.right - paddingRight;
    }),
  ]);
  expect(
    emphasisRight,
    `the emphasis box's own right edge (${emphasisRight}px) must sit inside the panel's content box (${panelContentRight}px) — never spill past it`,
  ).toBeLessThanOrEqual(panelContentRight + 1);
});

/**
 * #928 AC1: below the 720px floor, `.hero`'s own native 1200px width (hero.css, #895 item 5) must
 * scroll INSIDE its own `.hero-scroll` container instead of widening the whole page — the exact
 * defect this issue fixes (`document.documentElement.scrollWidth` used to read ~1216 at this
 * viewport). `.icon-rail`'s own width matching the viewport is a DOWNSTREAM consequence, not a
 * separate fix (this issue's own "What": "follows from the document no longer widening") — checked
 * here as the AC's own proof that the consequence actually landed, not re-derived logic.
 */
test("#928 AC1: at 720px, the document never scrolls horizontally, the hero stage overflows INSIDE its own container, and the rail spans the viewport", async ({
  page,
}) => {
  for (const theme of THEMES) {
    await page.setViewportSize({ width: 720, height: 1024 });
    await page.goto("/?demo");
    await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
    await page.locator("#overview").waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");

    const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docScrollWidth, `${theme.key}: the document must never scroll horizontally at the 720px floor`).toBeLessThanOrEqual(720);

    const heroScroll = page.locator(".hero-scroll");
    await expect(heroScroll, `${theme.key}: a real .hero-scroll container must render`).toHaveCount(1);
    const [scrollWidth, clientWidth] = await heroScroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(
      scrollWidth,
      `${theme.key}: the hero's native-width stage must overflow INSIDE .hero-scroll (scrollWidth ${scrollWidth}px > clientWidth ${clientWidth}px)`,
    ).toBeGreaterThan(clientWidth);

    const railBox = await page.locator(".icon-rail").boundingBox();
    expect(railBox, `${theme.key}: .icon-rail must render with a real bounding box`).not.toBeNull();
    expect(
      Math.round(railBox!.width),
      `${theme.key}: .icon-rail must span the full viewport width once the document no longer widens`,
    ).toBe(720);
  }
});

/**
 * #928 AC2: the lane board and activity feed (both full-width `.stack` rows since #926) must stack
 * vertically at 720px, and no `.stack` child may spill past the viewport on the x-axis — the SAME
 * "modules stack A→B→C→D→E" quality floor #926 AC1 already proves at 1440px, re-checked here at
 * the floor width itself, where the pre-fix bug this issue closes (the page-level horizontal
 * overflow) is what could have silently pushed a module's own box past [0, 720] on x.
 */
test("#928 AC2: at 720px, lanes and activity stack (no horizontal overlap), and every .stack child stays within [0, 720] on x", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 1024 });
  await page.goto("/?demo");
  await page.locator("#overview").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const laneSlot = (await firstMatch(page, MODULE_SELECTORS.lanes ?? [])) ?? page.locator("nonexistent-lanes-anchor");
  const feedSlot = page.locator('section[aria-label="activity"]');
  const laneBox = await laneSlot.boundingBox();
  const feedBox = await feedSlot.boundingBox();
  expect(laneBox, "the lane board slot must render with a real bounding box").not.toBeNull();
  expect(feedBox, "the activity feed must render with a real bounding box").not.toBeNull();
  expect(feedBox!.y, "activity must render BELOW the lane board, not beside it, at the 720px floor").toBeGreaterThanOrEqual(
    laneBox!.y + laneBox!.height - 1,
  );

  const stackChildBoxes = await page.locator("main.stack > *").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  expect(stackChildBoxes.length, "at least one .stack child must render").toBeGreaterThan(0);
  for (const [i, box] of stackChildBoxes.entries()) {
    expect(box.left, `.stack child #${i}'s left edge must not sit left of the viewport`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `.stack child #${i}'s right edge (${box.right}px) must not spill past the 720px viewport`).toBeLessThanOrEqual(721);
  }
});

/**
 * #954 AC2: the real-layout companion to `ActivityFeed.test.tsx`'s AC1 structural proof (happy-dom
 * performs no layout, so it can prove the grid's declared tracks/containment but never real boxes).
 * Over every rendered `.feed-entry` on the CURRENT page: the dot never orphans onto its own line
 * above the sentence, and the meta cell (timestamp + "▶ details") never strands below it — the
 * exact defect `1024-dark-idle-full.png` recorded (#729 D33, #929). Called from the main capture
 * loop below, at 1024/720, BEFORE that loop's own `page.screenshot` (#954 gate② finding [1]: a
 * standalone test declared after the capture test still runs its own assertions after the
 * screenshot file already exists on disk, contrary to AC2's own "before the existing full-page
 * screenshot" wording) — never re-navigates/re-themes the page itself, so it must run while the
 * caller's own `?demo` + theme + viewport state is still current.
 */
async function assertFeedEntryGeometry(page: Page, label: string): Promise<void> {
  const entries = page.locator(".feed-entry");
  const entryCount = await entries.count();
  expect(entryCount, `${label}: COVERAGE: the ?demo fixture must render >= 1 .feed-entry`).toBeGreaterThan(0);

  const geometries = await entries.evaluateAll((els) =>
    els.map((el) => {
      const dot = el.querySelector(".feed-dot")!.getBoundingClientRect();
      const sentenceEl = el.querySelector(".feed-sentence")!;
      const sentence = sentenceEl.getBoundingClientRect();
      const meta = el.querySelector(".feed-meta")!.getBoundingClientRect();
      const cs = getComputedStyle(sentenceEl);
      const fontSize = Number.parseFloat(cs.fontSize);
      const lineHeight = cs.lineHeight.endsWith("px") ? Number.parseFloat(cs.lineHeight) : Number.parseFloat(cs.lineHeight) * fontSize;
      return { dot, sentence, meta, sentenceLineHeight: lineHeight };
    }),
  );

  // #954 gate② finding [1]: AC2's own "±1 px" tolerance is named ONLY for the .feed-meta/
  // .feed-sentence top comparison — the dot inequalities are the criterion's exact wording
  // (`dot.top >= sentence.top && dot.bottom <= sentence.top + sentenceLineHeight`), no slack.
  const metaTolerancePx = 1;
  for (const [i, g] of geometries.entries()) {
    expect(
      g.dot.top,
      `${label} entry #${i}: .feed-dot top (${g.dot.top}) must not sit above the sentence's first line (${g.sentence.top})`,
    ).toBeGreaterThanOrEqual(g.sentence.top);
    expect(
      g.dot.bottom,
      `${label} entry #${i}: .feed-dot bottom (${g.dot.bottom}) must stay within the sentence's first line (${g.sentence.top + g.sentenceLineHeight})`,
    ).toBeLessThanOrEqual(g.sentence.top + g.sentenceLineHeight);
    expect(
      Math.abs(g.meta.top - g.sentence.top),
      `${label} entry #${i}: .feed-meta top (${g.meta.top}) must equal .feed-sentence top (${g.sentence.top}), never stranded below`,
    ).toBeLessThanOrEqual(metaTolerancePx);
    expect(
      g.meta.left,
      `${label} entry #${i}: .feed-meta left (${g.meta.left}) must sit to the right of .feed-sentence left (${g.sentence.left})`,
    ).toBeGreaterThan(g.sentence.left);
  }
}

/**
 * A genuine RENDERED-PIXEL sample at one page coordinate — not a geometry-box comparison (a
 * `<rect>`'s `getBoundingClientRect()` is verified directly to report the geometry-only box,
 * excluding its own stroke, so it can't itself prove whether a 1px CENTERED stroke's own 0.5px
 * straddle past the box edge actually painted or got clipped) and not `elementFromPoint` (a DOM
 * hit-test, not a paint fact). `page.screenshot({ clip })` captures the SAME rendering the user
 * sees — real overflow/clip behaviour, real antialiasing — as a PNG; decoding happens back in the
 * PAGE (via `Image` + `<canvas>`, both standard browser APIs — no new dependency) rather than in
 * Node, which has no built-in image codec.
 */
async function samplePixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  const crop = 8;
  const buffer = await page.screenshot({ clip: { x: x - crop / 2, y: y - crop / 2, width: crop, height: crop } });
  const base64 = buffer.toString("base64");
  return page.evaluate(async (base64) => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("failed to decode the cropped screenshot"));
      img.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const center = Math.floor(canvas.width / 2);
    const d = ctx.getImageData(center, center, 1, 1).data;
    return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
  }, base64);
}

/**
 * Real-pixel proof for one `<CostBar>` instance's own `.cost-bar-fill` rect, checked at whichever
 * end(s) actually sit at the bar's own box edge for that settled percentage (a cap mid-track has
 * nothing edge-specific to prove — a large geometric clearance there is correct, not a defect).
 * Three kinds of evidence: (1) the rect's own bounding box (geometry only, excludes the stroke)
 * never extends past the bar's own box — the P2 regression's own containment half, at the fill
 * geometry level; (2) `overflow: visible` on the containing `.cost-bar` svg (panels.css) — the
 * fix for the STROKE's own 0.5px straddle at the box edge (a 1px stroke is centred on its own
 * path, so it oversteps the box by half its own width; `overflow: hidden`, the SVG default, would
 * clip that straddle away, thinning the light outline exactly where it matters); (3) a REAL pixel
 * sample (`samplePixel`) right at the box edge — must differ from the background (paint reaches
 * there, not clipped short — the P2 regression's own failure mode: the cap's outer curve clipped
 * away entirely at 100% spend), and 2px further out — must equal the background (nothing bleeds
 * past). `rx`'s own genuine roundedness (as opposed to a square end) is a declarative fact, not a
 * pixel one — CostBar.test.tsx's own markup test and App.test.tsx's "AC2 (pill end caps)" STYLE
 * test both pin the `rx` attribute directly.
 */
async function assertPillCapsContained(
  page: Page,
  svgLocator: Locator,
  label: string,
  ends: { left: boolean; right: boolean },
): Promise<void> {
  const fill = svgLocator.locator(".cost-bar-fill");
  await expect(fill, `${label}: a real .cost-bar-fill must render`).toHaveCount(1);
  // Pixel sampling reads the current viewport's own rendered output — a card scrolled below the
  // fold (this fixture's third lane card, at 1440x900) would sample the wrong content entirely.
  await fill.scrollIntoViewIfNeeded();

  const geometry = await fill.evaluate((el: SVGRectElement) => {
    const svgEl = el.closest("svg") as SVGSVGElement;
    const rect = el.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      centerY: (rect.top + rect.bottom) / 2,
      svgLeft: svgRect.left,
      svgRight: svgRect.right,
      overflow: getComputedStyle(svgEl).overflow,
    };
  });

  const SLACK = 0.5;
  expect(geometry.left, `${label}: the fill must never paint left of the bar's own box`).toBeGreaterThanOrEqual(geometry.svgLeft - SLACK);
  expect(geometry.right, `${label}: the fill must never paint right of the bar's own box`).toBeLessThanOrEqual(geometry.svgRight + SLACK);
  expect(geometry.overflow, `${label}: the bar's own svg must not clip its own 1px centred outline stroke at the edges`).toBe("visible");

  if (ends.left) {
    const atEdge = await samplePixel(page, geometry.left, geometry.centerY);
    const outside = await samplePixel(page, geometry.left - 2, geometry.centerY);
    expect(atEdge, `${label}: real paint (fill or its outline) must reach the box's own left edge — the cap's own tip`).not.toEqual(
      outside,
    );
    const farOutside = await samplePixel(page, geometry.left - 4, geometry.centerY);
    expect(outside, `${label}: nothing may paint left of the bar's own box`).toEqual(farOutside);
  }
  if (ends.right) {
    const atEdge = await samplePixel(page, geometry.right, geometry.centerY);
    const outside = await samplePixel(page, geometry.right + 2, geometry.centerY);
    expect(atEdge, `${label}: real paint (fill or its outline) must reach the box's own right edge — the cap's own tip`).not.toEqual(
      outside,
    );
    const farOutside = await samplePixel(page, geometry.right + 4, geometry.centerY);
    expect(outside, `${label}: nothing may paint right of the bar's own box`).toEqual(farOutside);
  }

  // The light outline (AC3) — a plain stroke directly on this same rect (panels.css), so its own
  // declaration is a computed-style fact, cross-checked against the pixel evidence above.
  const strokeInfo = await fill.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { stroke: computed.stroke, strokeWidth: computed.strokeWidth };
  });
  expect(strokeInfo.stroke, `${label}: the light-theme outline stroke must resolve to a real, non-transparent colour`).not.toBe("none");
  expect(strokeInfo.stroke, `${label}: the light-theme outline stroke must resolve to a real, non-transparent colour`).not.toBe("");
  expect(strokeInfo.strokeWidth, `${label}: the outline is a plain 1px stroke`).toBe("1px");
}

/** #882: the fixture-shaped `/api/loop/state` lanes payload fed to `captureLiveOverlayLanes` below —
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
          fixRound: 0,
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
          // #926: matches the mockup's "FIXING · ROUND 1/2" (`lanes.prFixCap` config below is
          // unset, so `resolveFixCap`'s default cap of 2 applies).
          fixRound: 1,
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
          fixRound: 0,
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

/** #956: the shared `/api/*` route registration every live-mocked capture below routes through —
 *  a static JSON body per path, except `/api/events`, which respects its own `after` cursor (real
 *  API paging semantics, `queries.ts`'s `eventsQuery`): a poll past `after=lastId` returns nothing
 *  fresh, so a capture slower than `POLL_MS` (3s) can't re-fold the same fixture events twice and
 *  change the folded state out from under the screenshot. Originally `mockRingsApi`'s own private
 *  paging logic; factored out so `mockLiveApi` below can carry real events too, once, without every
 *  caller re-implementing the same cursor arithmetic. */
async function registerApiMocks(page: Page, byPath: Record<string, unknown>, events: readonly LoopEvent[] = []): Promise<void> {
  const lastId = events.reduce((max, e) => Math.max(max, e.id), 0);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const fresh = events.filter((e) => e.id > after);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: fresh, lastId }) });
      return;
    }
    const body = byPath[url.pathname];
    if (body === undefined) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** #882: intercepts every `/api/*` call the production `LiveApp` route makes (`api/client.ts`'s
 *  four endpoints) and fulfills it with fixture data, in-browser — the real-Chromium-page
 *  equivalent of `App.test.tsx`'s `stubFetch` (`byPath` -> `{status, body}`), which only works
 *  against that file's Node `fetch` mock. Takes the loop-state payload as a parameter (rather than
 *  building its own) so the caller can derive fixture markers from the SAME object being served,
 *  never a hand-copied duplicate of it. #956: `events` is optional (defaults to none, `/api/events`
 *  then serves an always-empty page, unchanged from before this parameter existed) — a caller that
 *  needs a real folded hero/attention state (the fixing/attention capture families below) passes
 *  its own real `LoopEvent`s instead. */
async function mockLiveApi(page: Page, loopState: unknown, events: readonly LoopEvent[] = []): Promise<void> {
  await registerApiMocks(
    page,
    {
      "/api/loop/state": loopState,
      "/api/spend": { spend: [], lastId: 0 },
      "/api/rounds": { rounds: [] },
    },
    events,
  );
}

/**
 * #882, renamed/rescoped by #927 (§729 remainder, D35; Q4 owner ruling): the lanes module's
 * LIVE-OVERLAY variant — navigates to `/` (never `?demo`, which is always `replay` mode) with
 * `/api/*` mocked, so the SAME production `App` -> `LiveApp` -> `LaneBoard` tree renders for real,
 * not a standalone/mock stand-in. `?demo`'s own lanes capture (the main loop above) now shows the
 * replayed narrative directly — this capture exists ONLY for what §11 still keeps genuinely
 * live-only: the est telemetry overlay and the live `/api/loop/state` PR-open-early hint, neither
 * of which any replay/`?demo` moment can ever show (no live probe exists in replay). Writes its
 * own `-lanes-live-overlay.png` file, alongside (never instead of) the `?demo`-sourced
 * `${idlePrefix}-lanes.png` the main loop writes for the SAME idle prefix.
 *
 * `LaneBoard` renders the SAME `section[aria-label="lanes"]` anchor in its config-unreadable state
 * (`lanesMax === null`, before the mocked `/api/loop/state` response has actually landed) as it
 * does once the fixture data has arrived — `waitFor({state: "visible"})` alone can't tell those
 * two apart, so a slow or broken mock could still pass this capture while showing the wrong state
 * entirely. Before taking the screenshot, assert the section actually carries the fixture's OWN
 * distinguishable content (every lane name + issue number, `toContainText` on real, retrying
 * locators) — real proof the mocked data flowed all the way through the production
 * `App` -> `LiveApp` -> `LaneBoard` tree, not a config-unreadable stand-in.
 */
async function captureLiveOverlayLanes(page: Page, theme: { key: string; attr: string }, idlePrefix: string): Promise<void> {
  const loopState = liveLanesLoopState();
  await mockLiveApi(page, loopState);
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const lanes = page.locator('section[aria-label="lanes"]');
  await lanes.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  for (const lane of loopState.lanes.items) {
    await expect(lanes, `the live-mocked lanes capture must render fixture lane "${lane.lane}"`).toContainText(lane.lane);
    await expect(lanes, `the live-mocked lanes capture must render fixture issue #${lane.issue}`).toContainText(`#${lane.issue}`);
  }
  const settledLane = loopState.lanes.items.find((lane) => lane.costUsd !== null);
  if (settledLane) {
    await expect(lanes, `the live-mocked lanes capture must render fixture lane "${settledLane.lane}"'s real settled cost`).toContainText(
      formatUsd(settledLane.costUsd as number),
    );
  }
  await expect(
    page.locator('[aria-label="live only"]'),
    "the live-mocked capture must never fall back to a LiveOnly placeholder",
  ).toHaveCount(0);

  await lanes.screenshot({ path: `${CAPTURES_DIR}/${idlePrefix}-lanes-live-overlay.png` });
  await page.unroute("**/api/**");
}

/** #921 AC4: `rings` real `merged` events, real `LoopEvent` shape (`api/types.ts`) — the moment
 *  needed to judge the ring disc at a specific scale, which `?demo`'s own demo bundle (1 merge,
 *  its own idle end-state) can't show for any OTHER count on demand. Empty at `rings === 0`. */
function ringsMergedEvents(rings: number): LoopEvent[] {
  const now = Date.now();
  return Array.from({ length: rings }, (_, i) => {
    const n = i + 1;
    return {
      id: n,
      ts: new Date(now - (rings - n) * 60_000).toISOString(),
      kind: "merged",
      payload: { worker: `w${(n % 4) + 1}`, issue: 900 + n, pr: 9000 + n },
    };
  });
}

/** #921 AC4: mocks `/api/loop/state` (`rings`) and `/api/events` (the same `rings` real merges,
 *  none at `rings === 0`) so the capture comes from the REAL production fold (`useEventHistory`
 *  -> `foldReplay`), never a prop override — same posture as `mockLiveApi`/`captureLiveOverlayLanes`
 *  above. #956: the `after`-cursor paging this used to implement privately now lives in
 *  `registerApiMocks`, shared with `mockLiveApi`. */
async function mockRingsApi(page: Page, rings: number): Promise<void> {
  const events = ringsMergedEvents(rings);
  const loopState = {
    engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
    lanes: { max: 3, items: [] },
    round: null,
    spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
    rings,
    mergedPrs: events.map((e) => (e.payload as { pr: number }).pr),
    logPath: null,
    config: { board: { owner: "herehigher", repo: "sapwood" } },
    controlsEnabled: true,
  };
  await registerApiMocks(
    page,
    {
      "/api/loop/state": loopState,
      "/api/spend": { spend: [], lastId: 0 },
      "/api/rounds": { rounds: [] },
    },
    events,
  );
}

/** #921 AC4: navigates the real production `App` -> `LiveApp` tree (never `?demo`, and never a
 *  `HeroStage` prop override) with `/api/*` mocked to a real `rings`-merge fold, and crops the
 *  hero panel — the same "real fold, not a prop override" discipline `captureLiveOverlayLanes` already
 *  applies to the lanes module. Asserts the fold actually produced the real, DEDICATED count (not
 *  just that something rendered — at `rings === 0` that means the sapling, never a numeral or a
 *  ring, same PO review-thread ask: a rings=0 state on demand, not one only incidentally reachable
 *  by scrubbing `?demo`'s own single-merge round to a moment before its merge) before the
 *  screenshot is evidence of anything. */
async function captureRingsHero(page: Page, theme: { key: string; attr: string }, rings: number, slug: string): Promise<void> {
  await mockRingsApi(page, rings);
  await page.setViewportSize({ width: CANONICAL_WIDTH, height: 900 });
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const hero = page.locator("svg.hero");
  await hero.waitFor({ state: "visible" });
  await page.locator(`.hero-trunk[data-rings="${rings}"]`).waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  if (rings === 0) {
    await expect(page.locator(".hero-sapling"), "rings=0 must render the real sapling glyph").toHaveCount(1);
  }
  await expect(page.locator(".hero-ring"), `the real fold must draw exactly ${rings} rings, one per merge`).toHaveCount(rings);

  await hero.screenshot({ path: `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-${slug}-hero-panel.png` });
  // #921 AC4/gate② finding [1]: the OUTCOME right-zone crop, so the disc footprint/count scale
  // can be judged against the mockup's own right zone directly, not the whole panel.
  await captureOutcomeZone(page, hero, `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-${slug}-hero-panel-outcome-zone.png`);
  await page.unroute("**/api/**");
}

/**
 * #956 D13: the minimal real `LoopEvent` sequence `hero/state.ts`'s fold needs to put w2's droplet
 * on the fix leg wearing its PR — production order, per `state.ts`'s own `#716 gate② P2-6` note:
 * `dispatched` (w2 claims issue 90) -> `reclaim-done` (PR 99 opens, `next: "DRIVING"`) ->
 * `fix-leg-started` (`fixRounds: 2` — the round number the "FIXING · round n of cap" text reads;
 * the cap denominator itself comes from `config.lanes.prFixCap`, not this payload) -> `drive-fixup`
 * (re-labels the reason in place, since the lane is already fixing by the time this lands — the
 * SAME already-fixing branch that note describes).
 */
function fixingHeroEvents(): LoopEvent[] {
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return [
    { id: 1, ts: minutesAgo(40), kind: "dispatched", payload: { worker: "w2", issue: 90 } },
    {
      id: 2,
      ts: minutesAgo(30),
      kind: "reclaim-done",
      payload: { worker: "w2", issue: 90, pr: 99, next: "DRIVING", costUsd: null, estCostUsd: 1.69, costEstimated: null },
    },
    { id: 3, ts: minutesAgo(20), kind: "fix-leg-started", payload: { worker: "w2", issue: 90, pr: 99, fixRounds: 2, cap: 3 } },
    { id: 4, ts: minutesAgo(19), kind: "drive-fixup", payload: { worker: "w2", issue: 90, pr: 99 } },
  ];
}

/** #956 D13: `/api/loop/state`'s own lanes payload for the fixing family — `LaneBoard` (live mode)
 *  reads its cards straight from here, never from the event fold `fixingHeroEvents` above drives
 *  (that fold is what the HERO panel reads instead, `App.tsx`'s live-mode wiring for each). Kept in
 *  sync by hand with `fixingHeroEvents` (same worker/issue/pr/round), the same relationship
 *  `liveLanesLoopState`/`captureLiveOverlayLanes` already have. `lanes.prFixCap: 3` is what makes
 *  the hero's "round 2 of 3" cap denominator legible — unset, `resolveFixCap`'s default of 2 would
 *  render "round 2 of 2" instead. */
function fixingLoopState() {
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return {
    engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
    lanes: {
      max: 3,
      items: [
        {
          lane: "w2",
          issue: 90,
          state: "fixing",
          pr: 99,
          startedAt: minutesAgo(40),
          endedAt: null,
          costUsd: null,
          estCostUsd: 1.69,
          fixRound: 2,
          contextTokens: null,
          tokenComposition: null,
        },
      ],
    },
    round: null,
    spend: { todayUsd: 1.69, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
    rings: 0,
    mergedPrs: [],
    logPath: null,
    config: { board: { owner: "herehigher", repo: "sapwood" }, worker: { budgetUsdSoft: 10 }, lanes: { prFixCap: 3 } },
    controlsEnabled: true,
  };
}

/**
 * #956 AC1: navigates the real production `App` -> `LiveApp` tree with `/api/*` mocked to
 * `fixingLoopState`/`fixingHeroEvents` — same "real fold, not a prop override" discipline
 * `captureLiveOverlayLanes`/`captureRingsHero` above already apply. Asserts the hero SVG actually
 * folded the real `FIXING · round 2 of 3` label and the lanes section actually renders the real
 * `w2`/`#90` fixture content (retrying locators) BEFORE either screenshot.
 */
async function captureFixingFamily(page: Page, theme: { key: string; attr: string }): Promise<void> {
  await mockLiveApi(page, fixingLoopState(), fixingHeroEvents());
  await page.setViewportSize({ width: CANONICAL_WIDTH, height: 900 });
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const lanes = page.locator('section[aria-label="lanes"]');
  await lanes.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  const hero = page.locator("svg.hero");
  await expect(hero, "AC1: the fixing fixture's real event fold must render w2 on the fix leg").toContainText("FIXING · round 2 of 3");
  await expect(lanes, "AC1: the fixing fixture's lanes section must render fixture lane w2").toContainText("w2");
  await expect(lanes, "AC1: the fixing fixture's lanes section must render fixture issue #90").toContainText("#90");

  await hero.screenshot({ path: `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-fixing-hero-panel.png` });
  await lanes.screenshot({ path: `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-fixing-lanes.png` });
  await page.unroute("**/api/**");
}

/** #956: the minimal live-mocked `/api/loop/state` shared by the live-header and attention capture
 *  families below — no lanes, no spend, just the engine/controls fields each family's own
 *  assertions actually read. `engine.state: "running"` + `controlsEnabled: true` is what AC2 needs
 *  to reach every control verb (`Controls.tsx` renders `null` entirely while `!enabled`). */
function minimalLoopState() {
  return {
    engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
    lanes: { max: 1, items: [] },
    round: null,
    spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
    rings: 0,
    mergedPrs: [],
    logPath: null,
    config: { board: { owner: "herehigher", repo: "sapwood" } },
    controlsEnabled: true,
  };
}

/**
 * #956 AC2: the live header family — `#overview` (the `header` module's own anchor,
 * `MODULE_SELECTORS`) with a real, live-mocked, `controlsEnabled`/`running` engine so
 * `Controls.tsx` actually renders every verb, `CONTROL_COPY`'s own label casing (`Pause`/`Stop`
 * title-case, `EMERGENCY STOP` genuinely upper-case — `.controls` carries no `text-transform` of
 * its own). Asserts all three, plus that `LiveOnly`'s placeholder never leaked in (live mode, so it
 * structurally can't — `LiveOnly.tsx`'s own doc — checked directly anyway, same proof
 * `captureLiveOverlayLanes` already gives its own live-mocked capture).
 */
async function captureLiveHeaderFamily(page: Page, theme: { key: string; attr: string }): Promise<void> {
  await mockLiveApi(page, minimalLoopState());
  await page.setViewportSize({ width: CANONICAL_WIDTH, height: 900 });
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const overview = page.locator("#overview");
  await overview.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  await expect(overview, "AC2: the live header must render the Pause verb").toContainText("Pause");
  await expect(overview, "AC2: the live header must render the Stop verb").toContainText("Stop");
  await expect(overview, "AC2: the live header must render the EMERGENCY STOP verb").toContainText("EMERGENCY STOP");
  await expect(
    page.locator('[aria-label="live only"]'),
    "AC2: a live-mocked capture must never fall back to the LiveOnly placeholder",
  ).toHaveCount(0);

  await overview.screenshot({ path: `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-live-header.png` });
  await page.unroute("**/api/**");
}

/**
 * #956 D23: three real, open, attention-class `LoopEvent`s spanning three of `copy.ts`'s
 * `ATTENTION_CATEGORY` chips — FIX CAP (`fix-rounds-capped`), REVIEW SILENCE
 * (`review-silence-escalated`, the dimmed row this issue names — payload shape confirmed at
 * `copy.ts`'s own entry: `{worker, issue, pr, head, silenceSec}`), and CEILING (`ceiling-escalated`)
 * — the same three-chip pattern `needs-attention-dark.png` shows. Distinct issue numbers so
 * `entities.ts`'s `foldOpenAttention` never dedups or clears one against another.
 */
function attentionEvents(): LoopEvent[] {
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return [
    { id: 1, ts: minutesAgo(180), kind: "ceiling-escalated", payload: { reasons: ["dailyBudgetUsd"] } },
    {
      id: 2,
      ts: minutesAgo(90),
      kind: "review-silence-escalated",
      payload: { worker: "w1", issue: 202, pr: 302, head: "a1b2c3d", silenceSec: 5400 },
    },
    {
      id: 3,
      ts: minutesAgo(30),
      kind: "fix-rounds-capped",
      payload: { worker: "w2", issue: 201, pr: 301, fixRounds: 3, cap: 3 },
    },
  ];
}

/**
 * #956 AC3: navigates the real production `App` -> `LiveApp` tree with `/api/*` mocked to
 * `attentionEvents` above (never a hand-painted `NeedsAttention` prop set), so the row set comes
 * from the real `useEventHistory` -> `foldOpenAttention` fold — same "real fold, not a prop
 * override" discipline the fixing/live-header families above apply. Asserts the real REVIEW
 * SILENCE chip and three distinct rows spanning three categories BEFORE the screenshot.
 */
async function captureAttentionFamily(page: Page, theme: { key: string; attr: string }): Promise<void> {
  await mockLiveApi(page, minimalLoopState(), attentionEvents());
  await page.setViewportSize({ width: CANONICAL_WIDTH, height: 900 });
  await page.goto("/");
  await page.evaluate((attr) => document.documentElement.setAttribute("data-theme", attr), theme.attr);
  const attention = page.locator('section[aria-label="needs attention"]');
  await attention.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");

  await expect(attention, "AC3: the attention fixture's real fold must render a REVIEW SILENCE chip").toContainText("REVIEW SILENCE");
  await expect(page.locator(".attention-row"), "AC3: the attention fixture must render 3 distinct rows").toHaveCount(3);
  const categories = new Set(await page.locator(".attention-chip").allTextContents());
  expect(categories.size, "AC3: the attention fixture's rows must span >= 3 distinct chip categories").toBeGreaterThanOrEqual(3);

  await attention.screenshot({ path: `${CAPTURES_DIR}/${CANONICAL_WIDTH}-${theme.key}-attention3-needs-attention.png` });
  await page.unroute("**/api/**");
}

/** #921 AC4/gate② finding [1]: the OUTCOME zone's own right-hand boundary — everything from the
 *  IMPLEMENT|OUTCOME divider (`ZONE_DIVIDERS[1]`, `stage.tsx`) to the stage's right edge —
 *  expressed as a fraction of `STAGE.w` so the SAME fraction crops both the live SVG's own
 *  rendered width AND the mockup PNG's pixel width identically: the mockup
 *  (`docs/design/mockup/hero-panel-dark.png`, 1915×821 per a direct pixel-dimension read) shares
 *  the stage's own 2.33:1 aspect ratio, so a fraction of one is the same region as that fraction
 *  of the other — never a hand-picked pixel rectangle that could silently drift from either.
 */
const OUTCOME_ZONE_X_FRACTION = ZONE_DIVIDERS[1] / STAGE.w;

/** #921 AC4/gate② finding [1]: crops the LIVE hero capture down to just the OUTCOME right zone —
 *  a page-relative `clip` computed from the hero SVG's own real rendered bounding box.
 *  `page.screenshot`'s own `clip` crops the VIEWPORT's captured pixels, not the full scrollable
 *  page — `scrollIntoViewIfNeeded()` (then re-reading the box, since scrolling moves it) is what
 *  keeps the whole element, and therefore the whole clip, actually within that viewport. */
async function captureOutcomeZone(page: Page, heroLocator: Locator, destPath: string): Promise<void> {
  await heroLocator.scrollIntoViewIfNeeded();
  const box = await heroLocator.boundingBox();
  if (!box) throw new Error("hero locator has no bounding box to crop the OUTCOME zone from");
  const x = box.x + box.width * OUTCOME_ZONE_X_FRACTION;
  await page.screenshot({ path: destPath, clip: { x, y: box.y, width: box.x + box.width - x, height: box.height } });
}

/** #921 AC4/gate② finding [1]: the SAME OUTCOME-zone crop, applied to a frozen mockup PNG on
 *  disk — loaded into a blank page at its own natural pixel size (never re-scaled) so the same
 *  fraction crops the same region. No new dependency: `page.screenshot`'s own `clip` option
 *  (already what crops the live captures above) does the cropping, not an image library. */
async function cropMockupOutcomeZone(page: Page, srcPath: string, destPath: string): Promise<void> {
  const dataUri = `data:image/png;base64,${readFileSync(srcPath).toString("base64")}`;
  await page.setContent(`<!doctype html><html><body style="margin:0"><img id="mockup-src" src="${dataUri}"></body></html>`);
  const size = await page
    .locator("#mockup-src")
    .evaluate((img) => ({ width: (img as HTMLImageElement).naturalWidth, height: (img as HTMLImageElement).naturalHeight }));
  await page.setViewportSize(size);
  const x = Math.round(size.width * OUTCOME_ZONE_X_FRACTION);
  await page.screenshot({ path: destPath, clip: { x, y: 0, width: size.width - x, height: size.height } });
}

async function firstMatch(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

/** #922 AC5 gate② finding [5] (ac5-active-capture): the round's own REAL first planning/reflection
 *  phase window (aligning/architecting/plan_review/harvesting/retro — `PLANNING_PHASE`/
 *  `REFLECTION_PHASE`, state.ts) — never an arithmetic "midpoint" of the whole event range, which
 *  can just as easily land inside a driving/fixing phase that draws no active planning node at
 *  all (the finding's own root cause: the fixture's `roundPhase` used to be hardcoded `null` in
 *  replay regardless, but even after wiring it live an arithmetic midpoint is not guaranteed to
 *  land inside a phase this stage actually renders as "active"). Reads the SAME `/demo-fixture.json`
 *  the app itself fetches and folds it through the SAME production `buildRoundLog` (real
 *  `phaseWindows`, never a hand-guessed event index), so this reuses the existing `?demo` machinery
 *  rather than standing up a second data path. */
const ACTIVE_PHASES = new Set(["aligning", "architecting", "plan_review", "harvesting", "retro"]);

/** Drives the real `<input aria-label="scrub">` (`Transport.tsx`) to a genuine, real-fixture
 *  moment via React's own `onChange` — a native property-setter write + a dispatched `input`
 *  event, the standard way to drive a React-controlled input from outside React (`fill()` does
 *  not reliably reach range inputs' React handlers). Scrubs to the FIRST planning/reflection
 *  phase window's own start event (AC5's own ask: a capture with a RUNNING planning/reflection
 *  node) when one exists; falls back to the arithmetic midpoint otherwise (a genuine, if less
 *  targeted, work-in-flight fold — never a fabricated state). Returns false when no scrub control
 *  is present (nothing to scrub — never treated as a failure, since not every module renders the
 *  transport). */
async function scrubToActiveMoment(page: Page): Promise<boolean> {
  const scrub = page.locator('input[aria-label="scrub"]');
  if ((await scrub.count()) === 0) return false;

  const bundle = (await page.evaluate(() => fetch("/demo-fixture.json").then((r) => r.json()))) as DemoBundle;
  const round = bundle.rounds[0];
  const log = round ? buildRoundLog(bundle, round, null) : null;
  const activeWindow = log?.phaseWindows.find((w) => ACTIVE_PHASES.has(w.phase));
  const activeEvent = activeWindow ? log?.events.find((e) => e.kind === "round-phase" && e.ts === activeWindow.startTs) : undefined;

  await scrub.evaluate((el: HTMLInputElement, targetEventId: number | null) => {
    const target = targetEventId ?? Math.round((Number(el.min) + Number(el.max)) / 2);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(target));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, activeEvent?.id ?? null);
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
// #927: `lanes` is no longer exempted here — the board replays now (`deriveReplayedLanes`), so
// `?demo`'s own scrubbed-active moment genuinely occupies a lane the same way `idle` does; both
// states are real, required evidence (verification plan: "confirm the ?demo lanes captures exist
// for idle+active").
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

  // #921 AC4 / gate② finding [1]: three moments (rings=0 sapling, 1 single legible ring, 24 full
  // mockup-scale footprint) alongside idle/active — outside the STATES grid `missingCaptures()`/
  // the rows above enforce (only idle/active exist there, and only the WHOLE panel, never a
  // zone crop), so this gets its own dedicated section rather than a hand-typed third STATES
  // entry that would force every OTHER module through this same moment/crop too. Right-zone
  // crops (`captureOutcomeZone`/`cropMockupOutcomeZone`, same `ZONE_DIVIDERS[1]`-derived fraction
  // on both sides) so the disc footprint/count scale is judged at comparable scale, not against
  // the whole panel's unrelated PLAN/IMPLEMENT content. Named so an operator can find it and
  // record the Tier-C witnessed comparison (`docs/security.md`'s evidence tiers — this repo's own
  // review doctrine is explicit that a producer can never self-attest a Tier-C record) directly
  // on issue #921.
  const AC4_MOMENTS = [
    // #921 gate② PO review thread (b): a DEDICATED, on-demand rings=0 capture — never the
    // `?demo` bundle's own "active" scrub, which only INCIDENTALLY lands at rings=0 for as long
    // as that bundle's one round happens to carry exactly one merge past its own midpoint.
    { rings: 0, label: "sapling", capturePrefix: (t: string) => `${CANONICAL_WIDTH}-${t}-rings0` },
    { rings: 1, label: "single ring", capturePrefix: (t: string) => `${CANONICAL_WIDTH}-${t}-idle` },
    { rings: 24, label: "mockup-scale footprint", capturePrefix: (t: string) => `${CANONICAL_WIDTH}-${t}-rings24` },
  ] as const;
  const outcomeZoneRowsHtml = AC4_MOMENTS.flatMap((moment) =>
    THEMES.map((t) => {
      const mockupFile = `mockups/hero-panel-${t.key}-outcome-zone.png`;
      const captureFile = `captures/${moment.capturePrefix(t.key)}-hero-panel-outcome-zone.png`;
      if (!existsSync(`${OUTPUT_DIR}/${mockupFile}`) || !existsSync(`${OUTPUT_DIR}/${captureFile}`)) return "";
      return `
      <tr>
        <td class="label">OUTCOME zone · ${t.key} · rings=${moment.rings} (${moment.label})<br><span class="tag">mockup vs. a real fold</span></td>
        <td><img src="${mockupFile}" alt="OUTCOME zone ${t.key} mockup"></td>
        <td><img src="${captureFile}" alt="OUTCOME zone ${t.key} rings=${moment.rings} live capture"></td>
      </tr>`;
    }),
  ).join("");

  // #956 AC4: the three live-mocked capture families (D13/D19/D23), each paired against its own
  // named mockup crop — same "missing capture is an invariant violation, missing mockup is an
  // honest not-yet-baselined gap" split `AC4_MOMENTS` above already applies. `fixing` needs BOTH
  // its own hero-panel AND lanes mockup; `live-header`/`attention3` each pair against one file.
  const D956_FAMILIES = [
    { slug: "fixing-hero-panel", mockup: (t: string) => `hero-panel-${t}.png`, label: "fixing (hero panel)" },
    { slug: "fixing-lanes", mockup: (t: string) => `lanes-${t}.png`, label: "fixing (lanes)" },
    { slug: "live-header", mockup: (t: string) => `header-${t}.png`, label: "live header" },
    { slug: "attention3-needs-attention", mockup: (t: string) => `needs-attention-${t}.png`, label: "attention (review silence)" },
  ] as const;
  const d956RowsHtml = D956_FAMILIES.flatMap((family) =>
    THEMES.map((t) => {
      const mockupFile = `mockups/${family.mockup(t.key)}`;
      const captureFile = `captures/${CANONICAL_WIDTH}-${t.key}-${family.slug}.png`;
      // No frozen baseline for this theme yet (e.g. `needs-attention-light.png` doesn't exist on
      // disk) — an honest gap, same as `modulesWithNoMockup` above, never a failure.
      if (!existsSync(`${OUTPUT_DIR}/${mockupFile}`)) return "";
      if (!existsSync(`${OUTPUT_DIR}/${captureFile}`)) {
        // The main test's own presence assertions (before `buildContactSheet()` ever runs) already
        // guarantee every #956 capture exists — reaching here means that invariant broke.
        throw new Error(`invariant violated: capture missing for an existing mockup pairing (${captureFile})`);
      }
      return `
      <tr>
        <td class="label">${family.label} · ${t.key}<br><span class="tag">mockup vs. a real fold</span></td>
        <td><img src="${mockupFile}" alt="${family.label} ${t.key} mockup"></td>
        <td><img src="${captureFile}" alt="${family.label} ${t.key} live capture"></td>
      </tr>`;
    }),
  ).join("");

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

<h2>OUTCOME right-zone crop pairs at rings = 0, 1, 24 (#921 AC4) — Tier-C: record the witnessed crop comparison on the issue</h2>
<table>${outcomeZoneRowsHtml || "<tr><td>No OUTCOME-zone capture/mockup pair found.</td></tr>"}</table>

<h2>Fixing / live header / attention capture families (#956) — Tier-C: record the witnessed crop comparison on the issue</h2>
<table>${d956RowsHtml || "<tr><td>No #956 capture/mockup pair found.</td></tr>"}</table>

<h2>Full-page captures — every viewport × theme combination</h2>
<table>${fullPageRowsHtml}</table>
</body>
</html>`;

  writeFileSync(`${OUTPUT_DIR}/contact-sheet.html`, html);
}
