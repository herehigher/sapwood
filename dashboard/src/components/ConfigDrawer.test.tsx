import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CONFIG_GROUPS } from "../config-captions.ts";
import { registerRealDom } from "../test-dom.ts";
import { ConfigDrawer } from "./ConfigDrawer.tsx";

registerRealDom();

const SAMPLE_CONFIG = {
  board: { owner: "herehigher", repo: "sapwood" },
  lanes: { max: 3 },
  worker: { budgetUsdSoft: 5, model: "claude-sonnet-5" },
};

test("renders only the six documented groups, each with its plain-language captions", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open />);
  for (const group of CONFIG_GROUPS) {
    assert.match(html, new RegExp(group.replace("&", "&amp;")));
  }
  assert.match(html, /reaching it asks the worker to wrap up and hand off/);
});

test("only allowlisted keys present in config render — never a raw dump of unknown fields", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={{ ...SAMPLE_CONFIG, secretToken: "should-never-render" }} open />);
  assert.doesNotMatch(html, /secretToken/);
  assert.doesNotMatch(html, /should-never-render/);
});

test("has no edit affordance anywhere — no input, no editable form control", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open />);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /contenteditable/);
});

test("unreadable config renders the documented placeholder, not an empty drawer", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={null} open />);
  assert.match(html, /config unreadable/);
});

test("renders nothing when closed", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open={false} />);
  assert.equal(html, "");
});

// ── #894: build identity + stale-dist chip ──────────────────────────────────────────────────

test("#894 AC1: renders the build SHA + time footer, and no stale chip when distSha/repoHeadSha are unset", () => {
  const html = renderToStaticMarkup(
    <ConfigDrawer config={SAMPLE_CONFIG} open buildSha="abc1234deadbeef" buildTime="2026-08-17T10:00:00.000Z" />,
  );
  assert.match(html, /config-drawer-build/);
  assert.match(html, /abc1234/, "the shown SHA is the real 7-char short form");
  assert.doesNotMatch(html, /deadbeef/, "shortSha truncates — never the full 40-char SHA on screen");
  assert.doesNotMatch(html, /config-drawer-stale-chip/, "no server comparison facts supplied — nothing to claim stale");
});

test("#894: an unset build identity renders the honest 'unknown' placeholder, never an empty footer", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open />);
  assert.match(html, /build unknown/);
});

test("#894 AC2: the stale-dist chip renders when distSha diverges from repoHeadSha, naming both short SHAs", () => {
  const html = renderToStaticMarkup(
    <ConfigDrawer
      config={SAMPLE_CONFIG}
      open
      buildSha="1111111"
      buildTime="2026-08-17T10:00:00.000Z"
      distSha="aaaaaaa1111"
      repoHeadSha="bbbbbbb2222"
    />,
  );
  assert.match(html, /config-drawer-stale-chip/);
  assert.match(html, /panel built at aaaaaaa, repo at bbbbbbb/);
});

test("#894 AC2: the stale-dist chip is absent when distSha equals repoHeadSha — fresh, no false alarm", () => {
  const html = renderToStaticMarkup(
    <ConfigDrawer
      config={SAMPLE_CONFIG}
      open
      buildSha="1111111"
      buildTime="2026-08-17T10:00:00.000Z"
      distSha="ccccccc3333"
      repoHeadSha="ccccccc3333"
    />,
  );
  assert.doesNotMatch(html, /config-drawer-stale-chip/);
});

test("#894 AC2: an unknown side (either distSha or repoHeadSha null) never renders the stale chip — no guessed staleness", () => {
  const distUnknown = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open distSha={null} repoHeadSha="ccccccc3333" />);
  assert.doesNotMatch(distUnknown, /config-drawer-stale-chip/);
  const repoUnknown = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open distSha="ccccccc3333" repoHeadSha={null} />);
  assert.doesNotMatch(repoUnknown, /config-drawer-stale-chip/);
});

const tokensCss = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const panelsCss = readFileSync(new URL("../panels.css", import.meta.url), "utf8");

/** #894 AC1 verification plan: "render the actual production component tree that hosts the
 *  build-identity surface ... once with the theme set to 'sapwood' ... and once with
 *  'heartwood' ... assert the SHA/time text is present and legible (non-empty, not visually
 *  suppressed) in both renders." `ConfigDrawer` IS that production surface — this mounts it
 *  directly (not a synthetic standalone identity component) through the real `<html data-theme>`
 *  mechanism `theme.ts`'s `applyTheme` uses, with the real production stylesheet cascade
 *  (tokens.css + app.css + panels.css) so `.muted`'s `--bark-text` — already AA-contrast-checked
 *  against both grounds by `contrast.ts`/`tokens.test.ts` — actually resolves per theme. */
async function renderThemedFooter(theme: "sapwood" | "heartwood") {
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${appCss}\n${panelsCss}`;
  document.head.appendChild(style);
  document.documentElement.setAttribute("data-theme", theme);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConfigDrawer config={SAMPLE_CONFIG} open buildSha="abc1234deadbeef" buildTime="2026-08-17T10:00:00.000Z" />);
  });
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.head.removeChild(style);
    document.documentElement.removeAttribute("data-theme");
  };
  return { container, cleanup };
}

test("#894 AC1: the build-identity footer is present and legible in the sapwood (light) theme", async () => {
  const { container, cleanup } = await renderThemedFooter("sapwood");
  try {
    const el = container.querySelector(".config-drawer-build");
    assert.ok(el, "the real build-identity element renders");
    assert.ok((el.textContent ?? "").trim().length > 0, "non-empty text");
    assert.match(el.textContent ?? "", /abc1234/);
    const computed = getComputedStyle(el);
    assert.notEqual(computed.display, "none");
    assert.notEqual(computed.visibility, "hidden");
    assert.notEqual(computed.opacity, "0");
  } finally {
    await cleanup();
  }
});

test("#894 AC1: the build-identity footer is present and legible in the heartwood (dark) theme", async () => {
  const { container, cleanup } = await renderThemedFooter("heartwood");
  try {
    const el = container.querySelector(".config-drawer-build");
    assert.ok(el, "the real build-identity element renders");
    assert.ok((el.textContent ?? "").trim().length > 0, "non-empty text");
    assert.match(el.textContent ?? "", /abc1234/);
    const computed = getComputedStyle(el);
    assert.notEqual(computed.display, "none");
    assert.notEqual(computed.visibility, "hidden");
    assert.notEqual(computed.opacity, "0");
  } finally {
    await cleanup();
  }
});
