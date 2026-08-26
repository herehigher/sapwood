// review/finding-key.ts (#449, design #402 R2, §3a) — the identity key a finding is recorded
// under in the per-round finding record (`drive-fixup`'s `findings` field, `loop/conductor.ts`).
// Pure, unprotected, zero I/O: every input here is data the caller already holds.
//
// STRUCTURAL DATA ONLY (design #402 §3a, D1's consuming-not-re-litigating stance, and the
// authoritative-signals rule, `engine/prompts/doctrine-core.md`). Neither function below
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
// ENCODING (#449 gate② Codex cross-vendor P1 fix): every key is `JSON.stringify` of a TAGGED
// TUPLE — `[domain, shape, ...fields]`, e.g. `["engine-agent","loc","security","src/x.ts"]` or
// `["classic","unloc","THREAD_1"]`. Round 1 of this module used hand-built colon-delimited
// strings (`"engine-agent:security:src/x.ts"`, `"engine-agent:security:«unlocated»:f1"`). Codex's
// cross-vendor review found the hole: nothing stops a repo from containing a path literally named
// `«unlocated»:f1` — a session-supplied `path` is untrusted text (validated only for diff
// membership, never for "does it look like our own marker"), so a colon-joined string can NEVER
// rule out one field's value forging a delimiter or tag another field relies on. JSON encoding
// closes this BY CONSTRUCTION, not by picking a glyph unlikely to collide: `JSON.stringify` quotes
// and escapes every string field (a `"`, `\`, or literal `["classic"` inside a path becomes
// `\"`/`\\`/`[\"classic\"` — still ONE array element, never a structural token), and a tuple's
// LENGTH plus its first two elements (`domain`, `shape`) are load-bearing, not any delimiter a
// field's own content could contain. Two tuples produce the same JSON string if and only if they
// are the same tuple, for any content of any field — this is exactly the guarantee `JSON.stringify`
// gives arrays of strings, and is why this module leans on it rather than a bespoke escaping
// scheme (reuse over new machinery, marginal-complexity discipline).
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
// free-text label, so downstream dedup/audit keys off it, not prose."
//
// PROSE-VIA-ID (#449 gate② Codex cross-vendor P2 fix). `Finding.id`'s own runtime validation
// (`isFinding`, `roles/reviewer.ts`) only requires a non-empty string — nothing stops a session
// from setting `id` to its ENTIRE finding body, which round 1 of this module then folded VERBATIM
// into the unlocated key, defeating the prose-free property (design #402 §2/D1's authoritative-
// signals rule) for exactly the lane it was meant to hold hardest. Fix: fold a SHORT CONTENT
// DIGEST of `id` (`shortIdDigest`, sha256 truncated to 16 hex chars — the same primitive #378's
// own `findingDigest` uses, at a shorter, disambiguation-only length; this is NOT a similarity
// hash, it never claims two DIFFERENT ids are "the same finding," only that raw prose can no
// longer round-trip through the key) — prose becomes structurally UNREPRESENTABLE in the key, not
// merely discouraged. Disclosed residual (unchanged from round 1, restated for the new encoding):
// two unlocated findings from DIFFERENT rounds that happen to reuse the identical `id` string
// still collide — accepted, since #3a already disclaims recurrence for the unlocated lane
// entirely (`located: false` below exists precisely so a consumer can refuse to trust such a key
// for recurrence, string equality notwithstanding).
//
// `located: false` is NOT part of the persisted `drive-fixup` payload (design #449's own payload
// shape is exactly `{key, severity, kind}` — no extra field). It exists on this module's return
// value for the caller's own tests and for any future consumer (R3) that wants to recognize an
// unlocated key without re-deriving it; the persisted `key` string itself already carries the
// `"unloc"` tag as its SECOND array element (`JSON.parse(key)[1] === "unloc"`), so a structural
// check is always available too — one that, unlike the round-1 substring marker, cannot be forged
// by a field's own content (a `path` value containing the literal text `"unloc"` still lands as
// tuple element 3+, never element 1, because JSON array position is what a JSON parse recovers).

import { createHash } from "node:crypto";
import type { FindingKind } from "./finding-axes.js";

/** The `kind` fallback for an engine-agent finding that never labelled itself — mirrors
 *  `finding-axes.ts`'s own "absent -> unclassified" fail-closed default (design #402 §1's table),
 *  restated here because THIS module's key must be equal for two findings that are both
 *  unclassified, not merely both `kind: undefined` (undefined !== undefined is never the failure
 *  mode, but "absent" and "explicitly unclassified" must still collapse to the same key). */
const UNCLASSIFIED_KIND = "unclassified";

/** #449 gate② Codex cross-vendor P2 fix: a short, non-reversible disambiguator for `Finding.id` —
 *  long enough that two distinct ids within one finding set essentially never collide (16 hex
 *  chars = 64 bits of a cryptographic digest), short enough that no meaningful amount of prose
 *  can be smuggled through it. Deliberately NOT the same length as #378's own `findingDigest`
 *  (`forge.ts`, full 64-char sha256): that digest's job is EQUALITY (deciding whether two spans
 *  carry the same finding), so it needs full collision resistance; this digest's job is bare
 *  DISAMBIGUATION among ids already known to differ as raw strings, a much weaker requirement. */
function shortIdDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/** JSON-encode a tagged tuple into a key string — see this module's header doc ("ENCODING") for
 *  why this closes the injection hole a delimiter-joined string cannot: `JSON.stringify` on an
 *  array of strings is injective (two arrays produce the same JSON text iff they are the same
 *  array, for ANY string content), so no field's value can ever forge a tag or a boundary another
 *  field relies on. */
function encodeKey(tuple: readonly string[]): string {
  return JSON.stringify(tuple);
}

export interface FindingKeyResult {
  /** Deterministic identity string, structural data only. Equal for two findings whose (kind,
   *  path) [engine-agent] or (path, #378 span digest) [classic] structurally match — see this
   *  module's own header doc for the exact per-path formula and the fail-closed degradation. */
  key: string;
  /** `false` when no verified, diff-anchored location was available and the key falls back to a
   *  per-finding disambiguator (a digest of the finding's own `id`, or the thread id) instead. A
   *  consumer (design #402 R3's classifier) must never treat two `located: false` keys as the
   *  same finding for recurrence purposes, even when their raw `key` strings happen to be equal —
   *  see the disclosed residual in this module's header doc. */
  located: boolean;
}

/**
 * The engine-agent path's identity key (design #402 §3a, amended #678): `(kind ?? "unclassified",
 * path, idDigest)`. The `path` here is `ClassifiedFinding.path` AFTER `finding-axes.ts`'s
 * `resolveFindingPath` has already dropped an out-of-diff value to `undefined` — this function
 * trusts `path === undefined` to mean "no verified location," never re-validating against a
 * changed-path set itself (that would duplicate R1's own job, the marginal-complexity violation
 * this module's header doc's "reuses" list exists to avoid).
 *
 * #678: the located key ALSO folds in `shortIdDigest(f.id)` — before this, the located key was
 * bare `(kind, path)`, so any two correctness findings in the same file collided regardless of
 * which defect they actually named (live evidence: PR #677's round 1
 * `unconfirmed-orphan-still-exits`/`graceful-handoff-double-sigterm` and round 2's
 * `lost-process-group-after-leader-exit`/`already-dead-lane-becomes-handoff` — four distinct
 * defects, one collapsed key, false recurrence on a large file). `f.id` is the reviewer's own
 * stable per-finding slug (`engine-reviewer.md`: "a short slug or ordinal — never reused across
 * findings in [one review]"); digested here for the same prose-via-id reason the unlocated path
 * already digests it (see this module's "PROSE-VIA-ID" header doc), never folded in raw. This is
 * candidate 1 of the issue's two: a content-hash of the finding body (candidate 2) was rejected —
 * any rewording defeats a content hash, and this module is structurally prose-free by design (see
 * "STRUCTURAL DATA ONLY" above), so hashing prose would mean accepting a `body` parameter neither
 * function has ever taken. Slugs are reviewer-authored, so a genuinely-identical defect reworded
 * into a new slug across rounds CAN still miss recurrence here — accepted, and the safer
 * direction (design #402 §3b's own fallback, the fix-rounds cap, still catches a lane that never
 * converges) over the alternative of FABRICATING recurrence between two unrelated findings that
 * merely share a file, which is what #677 actually hit.
 */
export function engineAgentFindingKey(f: { id: string; kind?: FindingKind; path?: string }): FindingKeyResult {
  const kind = f.kind ?? UNCLASSIFIED_KIND;
  if (f.path !== undefined) return { key: encodeKey(["engine-agent", "loc", kind, f.path, shortIdDigest(f.id)]), located: true };
  return { key: encodeKey(["engine-agent", "unloc", kind, shortIdDigest(f.id)]), located: false };
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
 * D1's narrower-never-wider fail-closed direction. `t.id` is GitHub's own opaque GraphQL node id
 * for the thread — provider-controlled, never session-supplied prose — so unlike `Finding.id`
 * (engine-agent path) it needs no digesting: there is no injection surface to close.
 */
export function classicThreadFindingKey(t: { id: string; path?: string | null; findingDigest?: string | null }): FindingKeyResult {
  if (t.path && t.findingDigest) return { key: encodeKey(["classic", "loc", t.path, t.findingDigest]), located: true };
  return { key: encodeKey(["classic", "unloc", t.id]), located: false };
}

/**
 * The verified path a key carries, or `null` when it carries none — the inverse of the two
 * encoders above, kept HERE so the tuple layout keeps exactly ONE owner (#453, design #402 R5:
 * retro's tendency table groups persisted finding records by path prefix and must not re-derive
 * this encoding for itself). `null` covers every case where no diff-anchored location exists:
 * an `"unloc"` key (either path), and — defensively — any string that isn't one of this module's
 * own tuples at all (a payload from a future/other encoding, or a corrupt row: an unreadable key
 * degrades to "unlocated", never to a thrown parse error in a digest builder).
 */
export function findingKeyPath(key: string): string | null {
  let tuple: unknown;
  try {
    tuple = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(tuple) || tuple[1] !== "loc") return null;
  // Position, not search: engine-agent's located tuple is [domain, "loc", kind, path], classic's
  // is [domain, "loc", path, findingDigest] — see this module's ENCODING doc.
  const path = tuple[0] === "engine-agent" ? tuple[3] : tuple[0] === "classic" ? tuple[2] : undefined;
  return typeof path === "string" ? path : null;
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
