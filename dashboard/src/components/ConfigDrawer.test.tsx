import assert from "node:assert/strict";
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

// ── #892 (#876 C-2): a real <dialog>, opened via .showModal() — Tier A per the verification plan
// (focus-trap/Escape themselves are Playwright-only, see shots.spec.ts). ─────────────────────────

test("real DOM: renders a real <dialog> element and calls .showModal() on open — .open reflects state", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ConfigDrawer config={SAMPLE_CONFIG} open />);
    });
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    assert.ok(dialog, "renders a real <dialog> element");
    assert.equal(dialog.tagName, "DIALOG");
    assert.equal(dialog.open, true, ".showModal() must have been invoked");

    await act(async () => {
      root.render(<ConfigDrawer config={SAMPLE_CONFIG} open={false} />);
    });
    assert.equal(container.querySelector("dialog"), null, "closing unmounts the dialog entirely");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("real DOM: the close button's onClose wiring fires the caller's onClose callback", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = false;
  try {
    await act(async () => {
      root.render(<ConfigDrawer config={SAMPLE_CONFIG} open onClose={() => (closed = true)} />);
    });
    const closeButton = container.querySelector('[aria-label="close config"]') as HTMLButtonElement;
    assert.ok(closeButton, "renders a close control");
    await act(async () => {
      closeButton.click();
    });
    assert.equal(closed, true);

    // The dialog's native `close` event (fired by Escape in a real browser — see shots.spec.ts)
    // must ALSO reach the same onClose callback, keeping React state in sync with the native
    // element regardless of how it closed.
    closed = false;
    await act(async () => {
      root.render(<ConfigDrawer config={SAMPLE_CONFIG} open onClose={() => (closed = true)} />);
    });
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    await act(async () => {
      dialog.close();
    });
    assert.equal(closed, true, "the native close event must reach onClose too");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
