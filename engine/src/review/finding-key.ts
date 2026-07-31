// review/finding-key.ts (#449, design #402 R2, §3a) — the identity key a finding is recorded
// under in the per-round finding record (`drive-fixup`'s `findings` field, `loop/conductor.ts`).
// Pure, unprotected, zero I/O: every input here is data the caller already holds.
//
// STRUCTURAL DATA ONLY (design #402 §3a, D1's consuming-not-re-litigating stance, and this
// repo's authoritative-signals doctrine, `docs/REVIEW-DOCTRINE.md`). Neither function below
// accepts a finding `body` / review-comment TEXT at all — not "ignores it", the parameter simply
// does not exist in either input type, so a caller cannot accidentally key on prose even by
// mistake. This is the property verification item 1 (finding-key.test.ts: "a reworded body with
// the same (kind, path) still produces an equal key") is really testing: the key is structurally
// incapable of seeing the reword.
//
// TWO PATHS, deliberately different shapes (design #402 §3a):
//  - engine-agent: `(kind ?? "unclassified", path ?? unlocated-with-id)` — `ClassifiedFinding`'s
//    own axes (`review/finding-axes.ts`, #448/R1). `path` here has ALREADY been validated against
//    the reviewed diff's changed-path set by `finding-axes.ts`'s `resolveFindingPath` before the
//    finding is ever persisted into the WAL's `EngineReviewArtifact` — this module does not
//    re-validate it (that would be re-implementing R1's own job).
//  - classic (thread-based): the review thread id, plus #378's span identity (`path` +
//    `findingDigest` — `forge.ts`'s `ReviewThreadSpan`) WHEN PRESENT. D1 is binding here: #378
//    already shipped (PR #445 + the protected-path patch PR #459) and its filter semantics are
//    consumed, never re-implemented or re-specified — this module only reads the fields #378
//    already produces. Absent span data (older/malformed thread, or `findingDigest` unkeyable —
//    see `forge.ts`'s own doc on an empty/whitespace-only comment body) degrades to thread-id
//    alone: NARROWER than the span-based key, never wider (D1's fail-closed direction) — a
//    degraded classic-path key can undercount recurrence (miss that a re-raised thread is "the
//    same" finding across two thread ids) but can never OVERcount it.
//
// UNLOCATED MARKING (design #402 §3a's own accepted blind spot; issue #449 verification item 2).
// The design doc's illustrative engine-agent formula is the bare tuple
// `(kind ?? "unclassified", path ?? "«unlocated»")` — read literally, that would give every
// unlocated finding of the same `kind` an IDENTICAL key, which is fine for classifyProgress's
// eventual recurrence rule (design #402 §3b: recurrence additionally requires the shared key's
// `path` to be a member of `fixDiffPaths`, and an unlocated finding has no path to be a member of
// anything — see §3a's own "accepted blind spot" paragraph) but fails this issue's OWN
// verification item 2 at the unit level: "two DIFFERENT unlocated findings do not compare equal
// in a way that would fake recurrence." This module closes that gap one step earlier than R3's
// classifier does, using data already sanctioned for exactly this purpose — `Finding.id`
// (`roles/reviewer.ts`): "Stable identifier for this finding within one review ... never a
// free-text label, so downstream dedup/audit keys off it, not prose." Folding `id` into an
// unlocated key's tail is therefore still "structural data only" (an id is not body text), and it
// makes two distinct unlocated findings within the SAME finding set provably non-equal, which the
// literal tuple alone does not. Disclosed residual: two unlocated findings from DIFFERENT rounds
// that happen to reuse the identical `id` string still collide — accepted, since #3a already
// disclaims recurrence for the unlocated lane entirely (`located: false` below exists precisely so
// a consumer can refuse to trust such a key for recurrence, string equality notwithstanding).
//
// `located: false` is NOT part of the persisted `drive-fixup` payload (design #449's own payload
// shape is exactly `{key, severity, kind}` — no extra field). It exists on this module's return
// value for the caller's own tests and for any future consumer (R3) that wants to recognize an
// unlocated key without re-deriving it; the persisted `key` string itself already carries the
// `«unlocated»` marker verbatim, so a string-level check is always available too.

import type { FindingKind } from "./finding-axes.js";

/** The literal marker embedded in an unlocated engine-agent key — deliberately the same glyph
 *  design #402 §3a's own formula uses, so a human reading the raw ledger recognizes it on sight. */
const UNLOCATED_MARKER = "«unlocated»";

/** The `kind` fallback for an engine-agent finding that never labelled itself — mirrors
 *  `finding-axes.ts`'s own "absent -> unclassified" fail-closed default (design #402 §1's table),
 *  restated here because THIS module's key must be equal for two findings that are both
 *  unclassified, not merely both `kind: undefined` (undefined !== undefined is never the failure
 *  mode, but "absent" and "explicitly unclassified" must still collapse to the same key). */
const UNCLASSIFIED_KIND = "unclassified";

export interface FindingKeyResult {
  /** Deterministic identity string, structural data only. Equal for two findings whose (kind,
   *  path) [engine-agent] or (path, #378 span digest) [classic] structurally match — see this
   *  module's own header doc for the exact per-path formula and the fail-closed degradation. */
  key: string;
  /** `false` when no verified, diff-anchored location was available and the key falls back to a
   *  per-finding disambiguator (the finding's own `id`, or the thread id) instead. A consumer
   *  (design #402 R3's classifier) must never treat two `located: false` keys as the same finding
   *  for recurrence purposes, even when their raw `key` strings happen to be equal — see the
   *  disclosed residual in this module's header doc. */
  located: boolean;
}

/**
 * The engine-agent path's identity key (design #402 §3a): `(kind ?? "unclassified", path)`. The
 * `path` here is `ClassifiedFinding.path` AFTER `finding-axes.ts`'s `resolveFindingPath` has
 * already dropped an out-of-diff value to `undefined` — this function trusts `path === undefined`
 * to mean "no verified location," never re-validating against a changed-path set itself (that
 * would duplicate R1's own job, the marginal-complexity violation this module's header doc's
 * "reuses" list exists to avoid).
 */
export function engineAgentFindingKey(f: { id: string; kind?: FindingKind; path?: string }): FindingKeyResult {
  const kind = f.kind ?? UNCLASSIFIED_KIND;
  if (f.path !== undefined) return { key: `engine-agent:${kind}:${f.path}`, located: true };
  return { key: `engine-agent:${kind}:${UNLOCATED_MARKER}:${f.id}`, located: false };
}

/**
 * The classic (thread-based) path's identity key (design #402 §3a, D1). `path`/`findingDigest`
 * are `ReviewThreadSpan`'s own #378 fields (`forge.ts`) — GitHub-authoritative diff-anchored data
 * for `path` (a review thread can only exist ON a diff line, so no separate diff-membership
 * validation is needed the way the session-supplied engine-agent `path` requires) and a
 * whitespace-normalized text digest for `findingDigest` (#378's own `findingDigest`, already
 * computed — this module never hashes prose itself). BOTH must be present to use the richer,
 * thread-id-independent key (design #402 §3a: "threads carry path/line, so both paths produce a
 * (path, span)-shaped key") — a resolved-then-reopened thread on the SAME finding gets the SAME
 * key across two different thread ids, which is the entire reason #378's span data is consumed
 * here rather than keying on thread id alone. Missing either field (older/malformed thread data,
 * or an unkeyable — empty/whitespace-only — originating comment) degrades to the thread id alone:
 * D1's narrower-never-wider fail-closed direction.
 */
export function classicThreadFindingKey(t: { id: string; path?: string | null; findingDigest?: string | null }): FindingKeyResult {
  if (t.path && t.findingDigest) return { key: `classic:${t.path}:${t.findingDigest}`, located: true };
  return { key: `classic:thread:${t.id}`, located: false };
}

/**
 * Bound a list to at most `max` entries, marking truncation rather than silently dropping the
 * tail (issue #449 AC: "both bounded — a fixed maximum entry count, with truncation marked in the
 * payload rather than silently dropped"). Shared by both the `findings` and `fixDiffPaths`
 * `drive-fixup` payload fields (`loop/conductor.ts`) so the two arrays cannot drift onto two
 * different truncation conventions. Deterministic (keeps the FIRST `max` entries in the caller's
 * own order — for `findings` that is the reviewer's own finding order; for `fixDiffPaths` it is
 * `IForge.getPRChangedFiles`'s forge-returned order), never a sample or a sort.
 */
export function boundRecords<T>(items: readonly T[], max: number): { entries: T[]; truncated: boolean } {
  if (items.length <= max) return { entries: [...items], truncated: false };
  return { entries: items.slice(0, max), truncated: true };
}
