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

// #727 AC4: frontend-design.md §3 is silent on the rail's OWN ≤720px behavior (only the five
// modules' single-column stacking is spelled out) — proposed reading for gate②: dock the rail
// horizontally at the top rather than keep a fixed-width sidebar on a narrow viewport.
test("#727 AC4: ≤720px docks the rail as a horizontal bar instead of a fixed-width sidebar", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const breakpoint = css.match(/@media \(max-width: 720px\) \{\s*\.app-shell[\s\S]*?\n\}\n/);
  assert.ok(breakpoint, "no ≤720px rule targeting .app-shell/.icon-rail found");
  assert.match(breakpoint![0], /\.icon-rail\s*\{[^}]*flex-direction:\s*row/, "rail switches to a row layout");
});
