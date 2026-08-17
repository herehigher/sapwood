import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { registerRealDom } from "../test-dom.ts";
import { PhaseInspectorDrawer } from "./PhaseInspectorDrawer.tsx";

registerRealDom();

/** Same pattern `IconRail.test.tsx`/`hero/hero.test.ts` already use for pinning a real CSS rule's
 *  declarations, rather than asserting against a hand-copied string a stylesheet edit could drift
 *  away from unnoticed. */
function cssBlock(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no ${selector} rule found`);
  return match![1]!;
}

// #868 gate② finding [0] (phase-inspector-not-side-drawer): AC1 requires a SIDE drawer, but
// `.phase-inspector` used to inherit ONLY `.config-drawer`'s styling, and `app.css`'s
// `.stack > .config-drawer { grid-column: 1 / -1 }` rule makes every `.config-drawer` span the
// full grid row — so the inspector rendered as another full-width panel stacked at the BOTTOM of
// the page, never a side drawer. This pins the actual side-drawer layout rule, not just its
// presence: taken out of the grid flow entirely (`position: fixed`, under which `grid-column` has
// no effect at all, per spec — a regression here would have to remove `position: fixed` itself,
// not just the grid rule), docked to the viewport's right edge, full viewport height, and a
// deliberately BOUNDED width — a `width: 100%` side "drawer" would just reproduce the same
// full-bleed bug this finding is about, one level down.
test("#868 gate② finding [0]: .phase-inspector renders as a real side drawer — fixed, right-docked, full height, bounded width — not the full-width bottom panel .config-drawer alone produces", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const rule = cssBlock(css, ".phase-inspector");

  assert.match(
    rule,
    /position:\s*fixed/,
    "must be taken out of `.stack`'s grid flow entirely — an in-flow drawer inherits the full-width grid-column rule regardless of any width declared here",
  );
  assert.match(rule, /top:\s*0/, "docks against the viewport top");
  assert.match(rule, /right:\s*0/, "docks against the viewport's right edge — the defining trait of a SIDE drawer");
  assert.match(rule, /height:\s*100vh/, "spans the full viewport height, a side panel's shape, not a bottom panel's auto height");

  const widthMatch = rule.match(/width:\s*([^;]+);/);
  assert.ok(widthMatch, "must declare an explicit width — an undeclared width on a fixed element collapses to its content, not a panel");
  assert.doesNotMatch(
    widthMatch![1]!.trim(),
    /^100%$/,
    "a full-viewport-width value would just reproduce the bottom-panel bug one level down — a side drawer's width must be bounded",
  );
});

// ── #892 (#876 C-2): a real <dialog>, opened via .showModal() — Tier A per the verification plan
// (focus-trap/Escape themselves are Playwright-only, see shots.spec.ts; App.test.tsx covers the
// click-to-open/close-button wiring end to end). ──────────────────────────────────────────────

test("real DOM: renders a real <dialog> element and calls .showModal() when a node opens it — .open reflects state, unmounts entirely when node is null", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <PhaseInspectorDrawer node={null} onClose={() => {}} artifact={null} events={[]} config={null} logPath={null} titles={{}} />,
      );
    });
    assert.equal(container.querySelector("dialog"), null, "no node -> nothing renders");

    await act(async () => {
      root.render(
        <PhaseInspectorDrawer node="goal-align" onClose={() => {}} artifact={null} events={[]} config={null} logPath={null} titles={{}} />,
      );
    });
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    assert.ok(dialog, "renders a real <dialog> element");
    assert.equal(dialog.open, true, ".showModal() must have been invoked");

    await act(async () => {
      root.render(
        <PhaseInspectorDrawer node={null} onClose={() => {}} artifact={null} events={[]} config={null} logPath={null} titles={{}} />,
      );
    });
    assert.equal(container.querySelector("dialog"), null, "closing (node -> null) unmounts the dialog entirely");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
