import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { cubicBezier } from "animejs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { registerRealDom } from "../test-dom.ts";
import { AnimationController } from "./animator.ts";
import { EASE, Hero } from "./Hero.tsx";
import { foldEvents, initialHeroState } from "./state.ts";

// #895 item 2: anime.js v4 dropped the string easing syntax ("cubicBezier(.3,.7,.3,1)") — it
// still "works" (silently falls back) but prints a console warning per resolved property and
// never actually applies the curve. The fix is the v4 imported-function form; both halves of
// that need proving: the exported easing IS that function (not the dropped string), and mounting
// Hero — which actually drives `createTimeline`/`tl.add` through a real animating transition —
// emits zero anime.js easing warnings. A separate file from `hero.test.ts` (not `Hero.test.ts`,
// which would collide with it on this repo's case-insensitive filesystem) since this is the one
// test in the hero module that needs a real DOM mount (`registerRealDom`) rather than the
// module's usual DOM-free `renderToStaticMarkup` harness.

registerRealDom();

test("#895 item 2: Hero's EASE constant is the v4 cubicBezier(.3,.7,.3,1) function, not the dropped string form", () => {
  assert.equal(typeof EASE, "function", "the v4 imported-function easing form must be a function, never a string");
  // Same deterministic curve math, sampled — proves the §5 token (.3,.7,.3,1) is what's actually
  // wired in, not just some arbitrary function.
  const reference = cubicBezier(0.3, 0.7, 0.3, 1);
  assert.equal(EASE(0.25), reference(0.25));
  assert.equal(EASE(0.5), reference(0.5));
  assert.equal(EASE(0.75), reference(0.75));
});

test("#895 item 2: mounting Hero through a real animating transition emits zero anime.js easing console warnings", async () => {
  const { state, steps } = foldEvents(initialHeroState(3), [
    { known: false, id: 1, ts: "2026-08-14T12:00:00Z", kind: "dispatched", payload: { worker: "w1", issue: 86 } },
  ]);

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Hero, { heroState: state, steps, lanesMax: 3, engine: "running" }));
    });
  } finally {
    console.warn = originalWarn;
    // Unmounting inside `act()` (same pattern `App.test.tsx`'s own `mountSettledApp` uses) runs
    // Hero's effect cleanup synchronously — `AnimationController.cancel()` — so the anime.js
    // timeline this test deliberately triggers is fully reverted before the test ends, rather
    // than left animating past teardown (`registerRealDom()`'s `test.after` tears `window` down,
    // which anime.js's own in-flight rAF loop would otherwise touch after that point).
    await act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
  }

  const easingWarning = warnings.find((args) => typeof args[0] === "string" && args[0].includes("has been removed from the core"));
  assert.equal(
    easingWarning,
    undefined,
    `mounting Hero must never emit anime.js's dropped-string-easing warning; got: ${JSON.stringify(warnings)}`,
  );
});

// #895: the two tests above prove `EASE` itself has the right curve, and that mounting emits no
// warning — neither proves the timeline `Hero.tsx`'s `play()` actually builds
// (`createTimeline({ defaults: { ease: EASE } })`) is the one that ends up running; production
// could quietly switch to a different, still-valid easing function and both would stay green.
// `AnimationController.prototype.start` (animator.ts) is the one place the created `Timeline`
// instance ever leaves `play()` — spying there (a class-prototype method, not an ES module
// namespace export, so `mock.method` can wrap it and still call through) captures the real
// object the real mounted path builds.
test("#895: the real Timeline anime.js's createTimeline() builds during a real Hero mount carries the exact EASE function, not a different valid easing", async () => {
  const { state, steps } = foldEvents(initialHeroState(3), [
    { known: false, id: 1, ts: "2026-08-14T12:00:00Z", kind: "dispatched", payload: { worker: "w1", issue: 86 } },
  ]);

  const startSpy = mock.method(AnimationController.prototype, "start");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Hero, { heroState: state, steps, lanesMax: 3, engine: "running" }));
    });
    assert.equal(startSpy.mock.calls.length, 1, "a real animating transition must start exactly one tracked timeline");
    const timeline = startSpy.mock.calls[0]?.arguments[0] as { defaults: { ease: unknown } };
    assert.equal(
      timeline.defaults.ease,
      EASE,
      "the real Timeline's own defaults.ease must be the exact EASE export, not a re-derived or different curve",
    );
  } finally {
    startSpy.mock.restore();
    await act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
  }
});
