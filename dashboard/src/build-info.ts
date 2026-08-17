/**
 * #894: build identity. `__BUILD_SHA__`/`__BUILD_TIME__` are injected by `vite.config.ts`'s
 * `define` from the git SHA of the tree actually being built — `typeof` guards them rather than
 * referencing them bare, so this module stays importable under this repo's plain `node --test`
 * harness (no vite processing at all), where the identifiers were never defined and would
 * otherwise be a `ReferenceError`. Production/dev builds always have them defined (`define`
 * applies to both `vite build` and `vite dev`); only the no-vite test harness sees `null`.
 */
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA: string | null = typeof __BUILD_SHA__ === "undefined" ? null : __BUILD_SHA__;
export const BUILD_TIME: string | null = typeof __BUILD_TIME__ === "undefined" ? null : __BUILD_TIME__;

/**
 * #894: honest match/mismatch between a served dist's build identity and the repo HEAD it's
 * meant to reflect. Either side unknown reads as fresh — the point is never to claim staleness
 * the server hasn't actually evidenced (same "never lie" posture `deriveEngineState` holds to).
 */
export function isDistStale(distSha: string | null, repoHeadSha: string | null): boolean {
  return distSha !== null && repoHeadSha !== null && distSha !== repoHeadSha;
}

/** The rail/drawer's compact rendering of a SHA — `"unknown"` rather than an empty string, so
 *  the surface never silently renders nothing. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}
