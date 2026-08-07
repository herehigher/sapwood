/**
 * #716 gate② P2-4: `Hero.tsx` used to build a brand-new anime.js timeline on every scene
 * without ever cancelling the previous one, and never reacted to `prefers-reduced-motion`
 * flipping true mid-animation at all. `AnimationController` is the fix, and — being
 * framework/DOM/anime.js-agnostic — is directly testable with a plain mock handle: no real
 * timers, no browser, no injected animejs module required.
 *
 * #716 gate② round 2 P2-4: `revert()` alone wasn't the whole contract — the "ring"
 * transition's gate-flash `classList` mutation (`Hero.tsx`) happens OUTSIDE anime.js, so
 * cancelling mid-merge used to leave the gates stuck `--moss`/✓ forever. `start()` now takes
 * an optional `cleanup` alongside the handle, and `cancel()` always runs it. The tests below
 * simulate Hero's actual gate-class side effect with a plain mock "gates" collection — no DOM
 * required, since the contract under test is "cleanup runs on cancel", not "querySelector
 * finds the right elements" (that half is inherently DOM-only, see the PR's documented
 * coverage boundary).
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

// ── #716 gate② round 2 P2-4: the Hero cleanup contract — gate classes restored on cancel ──

test("cancel() runs the side-effect cleanup registered at start(), in addition to revert()", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  let reverted = false;
  let cleanedUp = false;

  controller.start({ revert: () => (reverted = true) }, () => (cleanedUp = true));
  controller.cancel();

  assert.equal(reverted, true);
  assert.equal(cleanedUp, true);
});

test("Hero's actual gate-flash scenario: cancelling mid-merge restores the gates' classList, not just the timeline", () => {
  // Simulates `Hero.tsx`'s `play()`/`cancel()` pairing exactly: a "ring" step adds
  // `is-merged` to a set of gate-like objects (a `classList` mutation `Timeline.revert()`
  // has no idea about), and the SAME `cleanup` the controller was started with is what
  // strips it back off — idempotent, so it's safe to call whether or not a merge ever
  // actually completed.
  const gates = [{ classes: new Set<string>() }, { classes: new Set<string>() }];
  const applyMergedFlash = () => {
    for (const g of gates) g.classes.add("is-merged");
  };
  const stripMergedFlash = () => {
    for (const g of gates) g.classes.delete("is-merged");
  };

  const controller = new AnimationController<{ revert: () => void }>();
  applyMergedFlash(); // the timeline's own "add" callback having already fired
  controller.start({ revert: () => {} }, stripMergedFlash);
  assert.ok(
    gates.every((g) => g.classes.has("is-merged")),
    "precondition: mid-merge, gates are flashed",
  );

  // Reduced motion flips on (or a fresh scene lands) — Hero's effect cancels mid-merge.
  controller.cancel();

  assert.ok(
    gates.every((g) => !g.classes.has("is-merged")),
    "cancelling mid-merge must restore the gates, not leave them stuck moss/✓",
  );
});

test("start() cancels the PREVIOUS handle's cleanup too, not just its revert()", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  const firstCleanupCalls: string[] = [];
  const secondCleanupCalls: string[] = [];

  controller.start({ revert: () => {} }, () => firstCleanupCalls.push("cleaned"));
  controller.start({ revert: () => {} }, () => secondCleanupCalls.push("cleaned"));

  assert.deepEqual(firstCleanupCalls, ["cleaned"], "the first scene's side effects must be undone before the second scene's begin");
  assert.deepEqual(secondCleanupCalls, []);

  controller.cancel();
  assert.deepEqual(secondCleanupCalls, ["cleaned"]);
});

test("cleanup is optional — start() without one behaves exactly as before (handle-replacement only)", () => {
  const controller = new AnimationController<{ revert: () => void }>();
  let reverted = false;
  controller.start({ revert: () => (reverted = true) });
  controller.cancel();
  assert.equal(reverted, true);
});
