/**
 * A tiny, framework-agnostic "at most one thing is animating" controller.
 *
 * #716 gate② P2-4: `Hero.tsx` used to build a brand-new anime.js timeline on every scene
 * without ever cancelling the previous one — an in-flight timeline from an earlier poll could
 * keep animating (fighting the newly-snapped state) indefinitely — and never reacted to
 * `prefers-reduced-motion` flipping true mid-animation at all. Both are the same missing
 * piece: nothing tracked "the current handle" so it could be cancelled.
 *
 * #716 gate② round 2 P2-4: `revert()` alone isn't enough — the "ring" transition's gate
 * flash (`Hero.tsx`) mutates `classList` directly, a side effect anime.js's own `revert()`
 * knows nothing about and therefore never undoes. Cancelling mid-merge left the gates stuck
 * permanently `--moss`/✓. `start()` now takes an optional `cleanup` callback alongside the
 * handle, run on every `cancel()` right after `revert()` — the ONE place a caller's non-
 * anime.js side effects get torn down, so "cancel" is a complete promise, not just "stop the
 * tween".
 *
 * Generic over any `{ revert(): void }`-shaped handle (anime.js's `Timeline`/`Timer` both
 * have one) so this is unit-testable with a plain mock — no real anime.js, DOM, or timers.
 */
export interface Revertable {
  revert(): void;
}

export class AnimationController<T extends Revertable = Revertable> {
  private current: T | null = null;
  private cleanup: (() => void) | null = null;

  /** Whether something is currently being tracked. `Timeline.revert()` is idempotent, so a
   *  cancel with nothing tracked is always a harmless no-op — this is a convenience, not a
   *  guard callers must consult before calling `cancel()`. */
  get active(): boolean {
    return this.current !== null;
  }

  /**
   * Cancels whatever is currently tracked, if anything, and forgets it. Runs the tracked
   * handle's `revert()` FIRST, then its `cleanup` (if one was given at `start()`) — cleanup
   * runs even if `revert()` throws is deliberately NOT guaranteed here: a caller's cleanup
   * must itself be safe to call unconditionally (idempotent, side-effect-only), the same
   * contract `Hero.tsx`'s gate-class cleanup already holds.
   */
  cancel(): void {
    this.current?.revert();
    this.current = null;
    this.cleanup?.();
    this.cleanup = null;
  }

  /**
   * Cancels the previous handle (if any) — running ITS cleanup too — and starts tracking a
   * new one. The single operation that makes "a new scene replaces whatever was still
   * animating, side effects included" true by construction, never by remembering to call
   * `cancel()` first at every call site.
   */
  start(next: T, cleanup?: () => void): void {
    this.cancel();
    this.current = next;
    this.cleanup = cleanup ?? null;
  }
}
