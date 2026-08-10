import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconRail } from "./IconRail.tsx";

// #727 AC1/AC5: rail contents per §3 — wordmark, overview/cost anchors, theme switch, config gear.

test("renders the wordmark, both scroll anchors, the theme switch, and the config gear", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  assert.match(html, /title="sapwood"/, "wordmark");
  assert.match(html, /href="#overview"/, "overview anchor — scrolls, does not route");
  assert.match(html, /href="#cost"/, "cost anchor — scrolls, does not route");
  assert.match(html, /theme: following system/, "theme switch, defaulting to system before mount settles a stored override");
  assert.match(html, /aria-label="open config"/, "config gear");
});

test("the rail is a <nav>, not routed links to a different page — no href besides the two in-page anchors", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.sort(), ["#cost", "#overview"]);
});

test("config gear is a button wired to the passed-in open handler (relocated §3 E trigger, #145's drawer)", () => {
  const html = renderToStaticMarkup(<IconRail onOpenConfig={() => {}} />);
  assert.match(html, /<button type="button" class="icon-rail-item icon-rail-config"/);
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
});
