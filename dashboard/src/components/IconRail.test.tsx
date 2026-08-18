import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconRail, railContent } from "./IconRail.tsx";

/**
 * Walks a REAL React element tree (as returned by `railContent` — never a `renderToStaticMarkup`
 * HTML string, which strips function props) looking for a node with an exact `className` match.
 * This is what lets a test call the actual `onClick` prop IconRail wires onto its rendered gear,
 * instead of only asserting that button markup exists (#727 gate② finding
 * config-trigger-wiring-unexercised).
 */
function findByClassName(node: unknown, className: string): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props?.className === className) return node as { props: Record<string, unknown> };
  const children = props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByClassName(child, className);
    if (found) return found;
  }
  return null;
}

// #727 AC1/AC5: rail contents per §3 — wordmark, overview/cost anchors, theme switch, config gear.

test("renders the wordmark, both scroll anchors, the theme switch, and the config gear", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  assert.match(html, /title="sapwood"/, "wordmark");
  assert.match(html, /href="#overview"/, "overview anchor — scrolls, does not route");
  assert.match(html, /href="#cost"/, "cost anchor — scrolls, does not route");
  assert.match(html, /theme: following system/, "theme switch, defaulting to system before mount settles a stored override");
  assert.match(html, /aria-label="open config"/, "config gear");
});

// #892 AC2: the original AC2 coverage above only pinned `title="sapwood"` — the overview/cost
// anchors' titles were only reachable via their (distinct-selector) `href`, and the theme/config
// titles were only reachable via their `aria-label`, so a diff that quietly deleted the other
// four `title=` attributes would have stayed green. This pins all FIVE sites explicitly, each
// paired with its own accessible-name attribute, distinguishing the two shapes AC2 itself calls
// out: four sites where `title`/`aria-label` carry the SAME text (overview, cost, theme —
// decorative/label duplicates), one where they DIVERGE (config: "config" vs. "open config"), and
// the wordmark, which carries a `title` with no paired `aria-label` at all (decorative chrome,
// not a data hint — AC2's own wording for why it's excluded).
test("#892 AC2: all five IconRail title= sites survive untouched, each still paired with its own accessible name", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  assert.match(html, /<span class="icon-rail-wordmark" title="sapwood">/, "wordmark: title alone, decorative — no aria-label to duplicate");
  assert.match(
    html,
    /<a class="icon-rail-item" href="#overview" title="overview" aria-label="overview">/,
    "overview: title and aria-label carry the same text",
  );
  assert.match(
    html,
    /<a class="icon-rail-item" href="#cost" title="cost" aria-label="cost">/,
    "cost: title and aria-label carry the same text",
  );
  assert.match(
    html,
    /class="icon-rail-item icon-rail-theme" title="theme: following system — click for light" aria-label="theme: following system — click for light"/,
    "theme toggle: title and aria-label carry the same THEME_LABEL text",
  );
  assert.match(
    html,
    /class="icon-rail-item icon-rail-config" title="config" aria-label="open config"/,
    'config gear: title ("config") and aria-label ("open config") intentionally diverge — both must still be present',
  );
});

test("the rail is a <nav>, not routed links to a different page — no href besides the two in-page anchors", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.sort(), ["#cost", "#overview"]);
});

test("config gear renders as a button (relocated §3 E trigger, #145's drawer) — markup smoke check", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  assert.match(html, /<button type="button" class="icon-rail-item icon-rail-config"/);
});

// #727 gate② finding config-trigger-wiring-unexercised: the test above only proves the button
// exists — it stays green even with `onClick` deleted entirely, since SSR never serializes
// event-handler props. This calls the gear's REAL onClick (pulled off the actual element tree
// `IconRail` returns via `railContent`) and proves it invokes the exact `onOpenConfig` passed in.
test("the config gear's REAL onClick calls the passed-in onOpenConfig, not a copy or no-op", () => {
  let calls = 0;
  const tree = railContent(
    "system",
    () => {},
    () => {
      calls++;
    },
  );
  const gear = findByClassName(tree, "icon-rail-item icon-rail-config");
  assert.ok(gear, "config gear not found in the rail's real element tree");
  assert.equal(calls, 0);
  (gear!.props.onClick as () => void)();
  assert.equal(calls, 1, "one call to the gear's actual onClick must call onOpenConfig exactly once");
});

test("the theme switch's REAL onClick likewise calls the passed-in onToggleTheme, not a copy", () => {
  let calls = 0;
  const tree = railContent(
    "system",
    () => {
      calls++;
    },
    () => {},
  );
  const themeButton = findByClassName(tree, "icon-rail-item icon-rail-theme");
  assert.ok(themeButton, "theme switch not found in the rail's real element tree");
  (themeButton!.props.onClick as () => void)();
  assert.equal(calls, 1);
});

// #727 gate② finding wrapper-wiring-unexercised: the two "REAL onClick" tests above call
// `railContent` directly with TEST-SUPPLIED callbacks — they never run `IconRail`'s own body, so
// they'd stay green even if `IconRail` stopped forwarding its real `onToggleTheme`/`onOpenConfig`
// into `railContent` (e.g. `return railContent(theme ?? "system", () => {}, () => {})`). The
// tests below actually MOUNT `IconRail` — call it as a real function from inside an active React
// render (its own module comment: calling it directly outside a render throws "invalid hook
// call") — and click the buttons on the exact tree ITS OWN body returned.

/** `IconRail` can't be invoked directly outside a render (see IconRail.tsx's own comment on why
 *  it was split from `railContent`). This wrapper calls it FROM INSIDE a real render pass — so
 *  its `useState`/`useEffect` run for real — and stashes the REAL element tree it returns (with
 *  IconRail's own `onToggleTheme`/`onOpenConfig` wiring still attached, not a reconstruction)
 *  into `capture`, for the test to walk and click once `renderToStaticMarkup` has returned. */
function MountIconRail({ onOpenConfig, capture }: { onOpenConfig: () => void; capture: { tree: ReturnType<typeof IconRail> | null } }) {
  capture.tree = IconRail({ onOpenConfig });
  return capture.tree;
}

/** Minimal stand-ins for `document`/`localStorage` — this repo's test harness has neither. Same
 *  idiom as theme.test.ts's own `withFakeBrowserGlobals` (duplicated locally rather than
 *  imported — matches this repo's existing pattern of duplicating small test helpers per file,
 *  e.g. `findByClassName`'s copy in App.test.tsx). Installed only for the duration of `run()`. */
function withFakeBrowserGlobals<T>(run: () => T): { result: T; setAttributeCalls: Array<[string, string]> } {
  const setAttributeCalls: Array<[string, string]> = [];
  const g = globalThis as unknown as { document?: unknown; localStorage?: unknown };
  g.document = {
    documentElement: {
      setAttribute: (name: string, value: string) => setAttributeCalls.push([name, value]),
      removeAttribute: () => {},
    },
  };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  let result: T;
  try {
    result = run();
  } finally {
    delete g.document;
    delete g.localStorage;
  }
  return { result, setAttributeCalls };
}

test("mounting the REAL IconRail: clicking its actually-rendered config gear fires the exact onOpenConfig it was mounted with", () => {
  let calls = 0;
  const capture: { tree: ReturnType<typeof IconRail> | null } = { tree: null };
  renderToStaticMarkup(
    <MountIconRail
      onOpenConfig={() => {
        calls++;
      }}
      capture={capture}
    />,
  );

  const gear = findByClassName(capture.tree, "icon-rail-item icon-rail-config");
  assert.ok(gear, "config gear not found in IconRail's own real rendered tree");
  assert.equal(calls, 0, "no calls before the click");
  (gear!.props.onClick as () => void)();
  assert.equal(calls, 1, "IconRail's own rendered gear must call the onOpenConfig it was actually given, not a substitute");
});

test("mounting the REAL IconRail: clicking its actually-rendered theme switch drives the real DOM mutation (system -> sapwood)", () => {
  const capture: { tree: ReturnType<typeof IconRail> | null } = { tree: null };
  renderToStaticMarkup(<MountIconRail onOpenConfig={() => {}} capture={capture} />);

  const themeButton = findByClassName(capture.tree, "icon-rail-item icon-rail-theme");
  assert.ok(themeButton, "theme switch not found in IconRail's own real rendered tree");

  const { setAttributeCalls } = withFakeBrowserGlobals(() => (themeButton!.props.onClick as () => void)());
  assert.deepEqual(
    setAttributeCalls,
    [["data-theme", "sapwood"]],
    "IconRail's own rendered theme switch must drive the real toggleTheme -> applyTheme DOM write, not a substitute",
  );
});

/** Pulls one `selector { ... }` block's declaration body out of a larger CSS chunk — used below
 *  to check the ACTUAL layout properties per selector, not just that ANY property changed
 *  somewhere in the breakpoint (#727 gate② finding responsive-dock-test-incomplete: the previous
 *  version asserted only `.icon-rail`'s `flex-direction: row` and would have stayed green even
 *  if `.app-shell`'s column stacking, or the rail's full-width/auto-height sizing, were deleted —
 *  none of those individually keep the rail docked as a horizontal bar without the others). */
function cssBlock(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no ${selector} rule found`);
  return match![1]!;
}

// #727 AC4: frontend-design.md §3 is silent on the rail's OWN ≤720px behavior (only the five
// modules' single-column stacking is spelled out) — proposed reading for gate②: dock the rail
// horizontally at the top rather than keep a fixed-width sidebar on a narrow viewport.
test("#727 AC4: ≤720px docks the rail as a horizontal bar instead of a fixed-width sidebar", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const breakpoint = css.match(/@media \(max-width: 720px\) \{\s*\.app-shell[\s\S]*?\n\}\n/);
  assert.ok(breakpoint, "no ≤720px rule targeting .app-shell/.icon-rail found");
  const block = breakpoint![0];

  // The shell stops being a left/right split — without this, `.icon-rail`'s own row layout
  // would just sit ABOVE a still-side-by-side shell rather than docking full-width at the top.
  assert.match(cssBlock(block, ".app-shell"), /flex-direction:\s*column/, ".app-shell must stack vertically");

  // The rail itself: row layout, full page width, and auto height — drop any one of these and
  // it stays a narrow/tall sidebar rather than becoming a horizontal top bar.
  const rail = cssBlock(block, ".icon-rail");
  assert.match(rail, /flex-direction:\s*row/, ".icon-rail must lay its items out horizontally");
  assert.match(rail, /width:\s*100%/, ".icon-rail must span the full width once docked");
  assert.match(rail, /height:\s*auto/, ".icon-rail must drop its 100vh sidebar height once docked");

  // #727 gate② finding mobile-anchor-hidden-under-rail: the docked rail is `position: sticky;
  // top: 0`, so plain hash navigation would align an anchor target's top edge directly under
  // it. Both `#overview` and `#cost` (the rail's own two anchor targets) need a scroll offset
  // sized to clear the docked bar.
  const anchors = cssBlock(block, "#overview,\\s*#cost");
  assert.match(anchors, /scroll-margin-top:\s*\d/, "#overview/#cost need scroll-margin-top to clear the sticky mobile rail");
});

// #727 gate② finding rail-ac1-coverage: the earlier tests checked CONTENTS but never the base
// (non-mobile) rail's own required layout — a regression that dropped the fixed 56px width, the
// sticky positioning, or the gear's bottom-pin would previously have gone unnoticed.
test("#727 AC1: the base rail is a 56px sticky sidebar with the config gear pinned to its bottom", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const rail = cssBlock(css, ".icon-rail");
  assert.match(rail, /width:\s*56px/, "§3's ~56px rail width");
  assert.match(rail, /position:\s*sticky/, "the rail must stay in view while the page scrolls");
  assert.match(rail, /top:\s*0/, "sticky against the viewport top");

  const gear = cssBlock(css, ".icon-rail-config");
  assert.match(gear, /margin-top:\s*auto/, '§3: "config gear at bottom" — pinned below the anchors/theme switch');
});

/** Pulls the `.icon-rail-config` button's own markup out of the full rail, mirroring
 *  hero.test.ts's `trunkGroupInner` extraction pattern used for the analogous Sprout proof. */
function configButtonMarkup(html: string): string | undefined {
  return html.match(/<button type="button" class="icon-rail-item icon-rail-config"[^>]*>[\s\S]*?<\/button>/)?.[0];
}

// #955 AC1: GearGlyph (brightness-lookalike, owner observation #729/#929) is replaced by
// lucide-react's Settings icon, same proof shape as hero.test.ts's #921 lucide-sprout check.
test("#955 AC1: the config button renders lucide-react's Settings icon, not the old hand-drawn gear", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  const button = configButtonMarkup(html);
  assert.ok(button, ".icon-rail-config button not found");

  // lucide-react's own `createLucideIcon` class convention — the package's real rendered class.
  assert.match(button as string, /<svg[^>]*class="lucide lucide-settings"/);

  // No hand-drawn GearGlyph remnants: its 2.4-radius hub circle and its eight-stroke radiating path.
  assert.doesNotMatch(button as string, /<circle[^>]*r="2\.4"/);
  assert.doesNotMatch(button as string, /M8 1\.5 V3\.3/);
});

// #955 AC2: source-text assertion — GearGlyph must be gone, not just unused.
test("#955 AC2: IconRail.tsx no longer defines or references GearGlyph", () => {
  const source = readFileSync(new URL("./IconRail.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /GearGlyph/);
});
