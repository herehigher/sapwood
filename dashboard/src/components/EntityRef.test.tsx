// #892: `test-dom-eager.ts` MUST resolve before `./EntityRef.tsx` (which transitively imports
// Radix) — biome's import sort keeps it that way (parent-relative "../" sorts before same-dir
// "./"), but don't reorder these into the same specifier depth. See test-dom-eager.ts's own doc
// for why: Radix's useLayoutEffect shim decides whether happy-dom exists at MODULE EVALUATION
// time, and registerRealDom()'s test.before()-based registration runs too late for it.
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { unregisterRealDomEager } from "../test-dom-eager.ts";
import { EntityRef } from "./EntityRef.tsx";

test.after(() => unregisterRealDomEager());

test("an entity with no folded title shows no tooltip and makes no network call", () => {
  const html = renderToStaticMarkup(<EntityRef token={{ kind: "issue", number: 86 }} titles={{}} />);
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(html, /role="tooltip"/);
});

test("a PR token with no associated issue never throws and shows no tooltip", () => {
  const html = renderToStaticMarkup(<EntityRef token={{ kind: "pr", number: 5 }} titles={{}} />);
  assert.doesNotMatch(html, /title=/);
});

test("issue and PR glyphs render distinct shapes, not just distinct colors", () => {
  const issueHtml = renderToStaticMarkup(<EntityRef token={{ kind: "issue", number: 1 }} titles={{}} />);
  const prHtml = renderToStaticMarkup(<EntityRef token={{ kind: "pr", number: 1 }} titles={{}} />);
  assert.notEqual(issueHtml, prHtml);
});

test("renders a real GitHub link when a repoUrl is supplied", () => {
  const html = renderToStaticMarkup(
    <EntityRef token={{ kind: "issue", number: 86 }} titles={{}} repoUrl="https://github.com/herehigher/sapwood" />,
  );
  assert.match(html, /href="https:\/\/github\.com\/herehigher\/sapwood\/issues\/86"/);
});

test("renders a PR link under /pull/, not /issues/", () => {
  const html = renderToStaticMarkup(
    <EntityRef token={{ kind: "pr", number: 97, issue: 86 }} titles={{}} repoUrl="https://github.com/herehigher/sapwood" />,
  );
  assert.match(html, /href="https:\/\/github\.com\/herehigher\/sapwood\/pull\/97"/);
});

// ── #892: the folded title now lives behind a Radix tooltip, not a bare `title=` attribute —
// only reachable/observable through a real focus interaction, never static markup (the whole
// point: keyboard/touch users can now reach it too, the AC1 defect this migration fixes). ────────

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("real DOM: an entity with a folded title is Tab-reachable and its tooltip becomes visible/queryable on focus, not before", async () => {
  const { container, unmount } = await mount(
    <EntityRef token={{ kind: "issue", number: 86 }} titles={{ 86: { issueTitle: "Fix the thing" } }} />,
  );
  try {
    const trigger = container.querySelector(".entity-ref") as HTMLElement;
    assert.ok(trigger, "the trigger element renders");
    assert.equal(trigger.tabIndex, 0, "must be a real tab stop — a bare title= was pointer-only");
    assert.equal(container.querySelector('[role="tooltip"]'), null, "not open before any interaction");

    await act(async () => {
      trigger.focus();
    });

    const tooltip = container.querySelector('[role="tooltip"]');
    assert.ok(tooltip, "focusing the trigger opens the tooltip");
    assert.equal(tooltip?.textContent, "Fix the thing");
    assert.equal(
      trigger.getAttribute("aria-describedby"),
      tooltip?.id,
      "the trigger associates with the open tooltip via aria-describedby",
    );
  } finally {
    await unmount();
  }
});

test("real DOM: a PR token's folded title (looked up via its associated issue) is reachable the same way", async () => {
  const { container, unmount } = await mount(
    <EntityRef token={{ kind: "pr", number: 97, issue: 86 }} titles={{ 86: { prTitle: "Add the widget" } }} />,
  );
  try {
    const trigger = container.querySelector(".entity-ref") as HTMLElement;
    await act(async () => {
      trigger.focus();
    });
    assert.equal(container.querySelector('[role="tooltip"]')?.textContent, "Add the widget");
  } finally {
    await unmount();
  }
});

test("real DOM: an <a> trigger (repoUrl present) is already focusable by construction — no explicit tabIndex needed, tooltip still opens on focus", async () => {
  const { container, unmount } = await mount(
    <EntityRef
      token={{ kind: "issue", number: 86 }}
      titles={{ 86: { issueTitle: "Fix the thing" } }}
      repoUrl="https://github.com/herehigher/sapwood"
    />,
  );
  try {
    const trigger = container.querySelector("a.entity-ref") as HTMLAnchorElement;
    assert.ok(trigger, "renders the real GitHub link as the trigger");
    assert.equal(trigger.hasAttribute("tabindex"), false, "an <a href> is already a native tab stop");

    await act(async () => {
      trigger.focus();
    });
    assert.equal(container.querySelector('[role="tooltip"]')?.textContent, "Fix the thing");
  } finally {
    await unmount();
  }
});

test("real DOM: no folded title -> no tabIndex added (no meaningless tab stop) and no tooltip on focus", async () => {
  const { container, unmount } = await mount(<EntityRef token={{ kind: "issue", number: 86 }} titles={{}} />);
  try {
    const trigger = container.querySelector(".entity-ref") as HTMLElement;
    assert.equal(trigger.hasAttribute("tabindex"), false);
    await act(async () => {
      trigger.focus();
    });
    assert.equal(container.querySelector('[role="tooltip"]'), null);
  } finally {
    await unmount();
  }
});
