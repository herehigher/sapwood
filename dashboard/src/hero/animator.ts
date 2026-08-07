/**
 * A tiny, framework-agnostic "at most one thing is animating" controller.
 *
 * #716 gate② P2-4: `Hero.tsx` used to build a brand-new anime.js timeline on every scene
 * without ever cancelling the previous one — an in-flight timeline from an earlier poll could
 * keep animating (fighting the newly-snapped state) indefinitely — and never reacted to
 * `prefers-reduced-motion` flipping true mid-animation at all. Both are the same missing
 * piece: nothing tracked "the current handle" so it could be cancelled.
 *
 * Generic over any `{ revert(): void }`-shaped handle (anime.js's `Timeline`/`Timer` both
 * have one) so this is unit-testable with a plain mock — no real anime.js, DOM, or timers.
 */
export interface Revertable {
  revert(): void;
}

export class AnimationController<T extends Revertable = Revertable> {
  private current: T | null = null;

  /** Whether something is currently being tracked. `Timeline.revert()` is idempotent, so a
   *  cancel with nothing tracked is always a harmless no-op — this is a convenience, not a
   *  guard callers must consult before calling `cancel()`. */
  get active(): boolean {
    return this.current !== null;
  }

  /** Cancels whatever is currently tracked, if anything, and forgets it. */
  cancel(): void {
    this.current?.revert();
    this.current = null;
  }

  /** Cancels the previous handle (if any) and starts tracking a new one — the single
   *  operation that makes "a new scene replaces whatever was still animating" true by
   *  construction, never by remembering to call `cancel()` first at every call site. */
  start(next: T): void {
    this.cancel();
    this.current = next;
  }
}
