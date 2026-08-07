/**
 * #716 gate② P2-4: `Hero.tsx` used to build a brand-new anime.js timeline on every scene
 * without ever cancelling the previous one, and never reacted to `prefers-reduced-motion`
 * flipping true mid-animation at all. `AnimationController` is the fix, and — being
 * framework/DOM/anime.js-agnostic — is directly testable with a plain mock handle: no real
 * timers, no browser, no injected animejs module required.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AnimationController } from "./animator.ts";

test("start() cancels (reverts) the previous handle before adopting the new one", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  let firstReverted = false;
  let secondReverted = false;

  controller.start({ revert: () => (firstReverted = true) });
  assert.equal(firstReverted, false);
  assert.ok(controller.active);

  controller.start({ revert: () => (secondReverted = true) });
  assert.equal(firstReverted, true, "the first handle must be reverted before the second replaces it");
  assert.equal(secondReverted, false);
  assert.ok(controller.active);
});

test("cancel() reverts the tracked handle and forgets it — a second cancel is a harmless no-op", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  let calls = 0;
  controller.start({ revert: () => calls++ });

  controller.cancel();
  assert.equal(calls, 1);
  assert.equal(controller.active, false);

  controller.cancel();
  assert.equal(calls, 1, "cancelling with nothing tracked must not call revert again");
});

test("cancel() with nothing ever started is a no-op", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  assert.equal(controller.active, false);
  controller.cancel();
  assert.equal(controller.active, false);
});

test("the reduced-motion-mid-animation scenario: an in-flight handle is reverted the instant reduced motion is honored", () => {
  // Simulates Hero.tsx's actual call pattern: a timeline starts, then — before it would have
  // naturally finished — `reducedMotion` flips true and the component reacts by cancelling.
  const controller = new AnimationController<{ revert: () => void }>();
  let reverted = false;
  controller.start({ revert: () => (reverted = true) });
  assert.equal(reverted, false, "nothing has cancelled it yet");

  // The reduced-motion effect's own body, verbatim: `if (reducedMotion) controller.cancel()`.
  const reducedMotion = true;
  if (reducedMotion) controller.cancel();

  assert.equal(reverted, true);
  assert.equal(controller.active, false);
});

test("unmount cleanup: the tracked handle is reverted exactly once even if cancel is called from multiple cleanup paths", () => {
  // React calls an effect's cleanup once per re-run AND once on unmount — both routes in
  // Hero.tsx call the SAME `controller.cancel()`, so double-invocation must stay idempotent.
  const controller = new AnimationController<{ revert: () => void }>();
  let calls = 0;
  controller.start({ revert: () => calls++ });

  const cleanup = () => controller.cancel();
  cleanup(); // effect cleanup before a re-run
  cleanup(); // unmount

  assert.equal(calls, 1);
});
