// review/convergence.ts (#450, design #402 R3, §3b/§3c) — the convergence classifier: is a
// FIXABLE lane still making progress, or has it stalled? Pure, unprotected, zero I/O — every
// input is data the caller (`loop/conductor.ts`) already holds or has already read from the
// event ledger. Depends on #449 (R2)'s per-round finding record (`drive-fixup`'s `findings` +
// `fixDiffPaths` fields, `review/finding-key.ts`'s identity keys) — this module never re-derives
// a finding's identity, only consumes it.
//
// WHY THIS EXISTS (design #402's own framing): `lanes.prFixCap` was a cost ceiling being used as
// a quality ceiling — "rounds spent" and "no longer making progress" are different facts that
// were sharing one signal. This module supplies the second fact. `driveDecision` (conductor.ts)
// consumes it to escalate a STALLED lane before it pays for another fix round, while a lane that
// is still measurably converging keeps its full `prFixCap` budget (now 4, §8's own migration).
//
// THE SIX SHAPES (design #402 §3b's table, reproduced here as the classifier's own priority
// order — each row is checked in the table's own order, and the first match wins):
//
//   1. no previous round (round 1)                                          -> converging
//   2. curr.length < prev.length, OR curr ∩ prev = ∅ (new areas)            -> converging
//   3. a shared key (curr ∩ prev) whose path IS in fixDiffPaths             -> stalled: recurrence
//   4. curr.length >= prev.length for two consecutive rounds (flatStreak≥2) -> stalled: flat
//   5. a NEW key (curr \ prev) whose path IS in fixDiffPaths                -> stalled: marginal-complexity
//   6. anything else (count up once, no recurrence, no new-in-fix)          -> converging
//
// Row 2 is checked BEFORE row 3/5 deliberately (design #402 §3b's own row order): a round whose
// old findings are ALL gone, even if new ones happen to land inside the touched path, is "new
// areas" (continue), never `marginal-complexity` — only a round that ALSO still shares at least
// one prior finding (a non-empty intersection) is eligible for either stalled verdict. This is
// the literal reading of the design table's row order, not an inference: rows are evaluated
// top-down, first match wins, and row 2's "curr ∩ prev = ∅" clause is unconditional.
//
// EVALUATED OVER BLOCKING FINDINGS ONLY (issue #450 AC: "a round whose count rises only through
// advisories classifies as it would with those advisories absent"). `filterBlocking` below is the
// ONE place that filter is applied, so `classifyProgress`'s row-2/row-4 count comparisons and its
// row-3/row-5 key-set operations all see the identical, advisory-stripped view — a caller cannot
// accidentally compare a blocking-only count against a mixed key set.
//
// THE DEGRADATION RULE (architectural review amendment, 2026-07-31, folded from R2's
// `gatherFixDiffPaths`/`fixDiffPathsUnavailable` — newer than design #402 §3b's own text, which
// predates R2's implementation): when the CURRENT round's `fixDiffPaths` could not be computed to
// a trustworthy, complete range, R2's `gatherFixDiffPaths` already degrades it to `[]` (never a
// partial or approximated list — see that function's own doc, `loop/conductor.ts`). This module
// deliberately does NOT accept a separate "unavailable" boolean and re-implement that degrade: an
// empty `fixDiffPaths` array structurally CANNOT contain any path, so `recurrence` (row 3) and
// `marginal-complexity` (row 5) — both gated on `path ∈ fixDiffPaths` — cannot fire, automatically,
// by construction. `flat` (row 4) is untouched, since it never consults `fixDiffPaths` at all —
// exactly "count-only convergence (flat still can)" from this module's own verification plan. No
// second code path, no new parameter, no way for the two degrade rules (R2's and this one) to
// drift apart.
//
// UNLOCATED KEYS PARTICIPATE IN COUNTS, NEVER IN RECURRENCE (design #402 §3a's own accepted blind
// spot, restated here because THIS module is where it is enforced). An unlocated key
// (`finding-key.ts`'s `["<domain>","unloc",...]` tag) has no verified diff location, so
// `extractLocatedPath` below returns `undefined` for it — `undefined ∈ fixDiffPaths` (a `string[]`)
// is always `false`, so an unlocated key can never satisfy row 3 or row 5's path-membership test.
// It still counts toward `curr.length`/`prev.length` (rows 2/4) and toward key-set membership
// (rows 2/3/5's set operations) — "participates in counts, never in recurrence" is not a special
// case this module adds, it falls out of `extractLocatedPath`'s honest `undefined` for a key with
// no location to give.
//
// `flatStreak` IS NOT PERSISTED (design #402 §9: "new tables: zero", and this issue adds none
// either). `computeFlatStreak` below is a second pure helper, not a stored counter — the caller
// folds this lane's FULL `drive-fixup` history (already durable, `state.eventsSince`, the exact
// read pattern `loop/conductor.ts`'s `priorFixLegForVerdict` (#457) already uses for an identical
// "walk this lane's whole history" need) into a plain `number[]` of per-round blocking counts and
// calls `computeFlatStreak` fresh every tick. Reuse over new machinery: a bounded, cheap re-fold
// (prFixCap rounds, never more than a handful) costs nothing extra a stored field would save.
import type { FindingSeverity } from "./finding-axes.js";

/** The classifier's verdict (design #402 §3b's own literal signature). `"converging"` covers
 *  rows 1, 2, and 6 of the table above — the classifier does not distinguish WHY a round is not
 *  stalled, only that it is not; a caller that wants the finer distinction has the finding records
 *  themselves to inspect. */
export type ConvergenceVerdict = "converging" | { stalled: ConvergenceStallSignal };

/** The three ways a lane can stall (design #402 §3b's rows 3/4/5), in the SAME priority order this
 *  module's own row-scan checks them. */
export type ConvergenceStallSignal = "recurrence" | "flat" | "marginal-complexity";

/** The one shape `classifyProgress`/`computeFlatStreak`'s callers need from a recorded finding —
 *  deliberately a subset of `loop/conductor.ts`'s own `FixupFindingRecordEntry` (`{key, severity,
 *  kind?}`), so that type satisfies this one structurally without a conversion step; this module
 *  never reads `kind` (analysis-only for §5 tendency, not §3 convergence — D2's gate-consuming-axis
 *  discipline applies here too, just for "counts" instead of "the gate"). */
export interface ProgressFinding {
  key: string;
  severity: FindingSeverity;
}

/** D2/D3's `effectiveSeverity` already decided this bit before the finding ever reached the
 *  `drive-fixup` payload (`loop/conductor.ts`'s `gatherFixupFindingRecord`) — this module trusts
 *  the recorded `severity` verbatim, never re-derives it. */
function filterBlocking(entries: readonly ProgressFinding[]): ProgressFinding[] {
  return entries.filter((f) => f.severity === "blocking");
}

/** The blocking-only count `computeFlatStreak`'s caller folds per round, and the same count
 *  `classifyProgress` compares internally (rows 2/4) — ONE filter definition, so the two can never
 *  see a different notion of "how many findings this round had." */
export function countBlocking(entries: readonly ProgressFinding[]): number {
  return filterBlocking(entries).length;
}

/**
 * A located key's `path` segment, or `undefined` for an unlocated key or anything unparseable —
 * NEVER throws (a malformed key degrades to "no path", the same fail-narrow direction every other
 * default in this design takes, never a crash on data this module does not control the shape of).
 *
 * Parses `finding-key.ts`'s own JSON-tagged-tuple encoding (that module's "ENCODING" header doc):
 * `["engine-agent","loc",kind,path]` (path at index 3) or `["classic","loc",path,findingDigest]`
 * (path at index 2) — the position differs BY DOMAIN, which is exactly why this function switches
 * on `tuple[0]` rather than assuming one fixed index. `tuple[1] !== "loc"` (including every
 * `"unloc"` key) returns `undefined` immediately — the tag, not a string comparison on the path
 * itself, is what proves a key IS or IS NOT located, so no field's own content can be mistaken for
 * the tag (the identical injection-closure property `finding-key.ts`'s own tests pin).
 */
function extractLocatedPath(key: string): string | undefined {
  let tuple: unknown;
  try {
    tuple = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(tuple) || tuple.length < 3 || tuple[1] !== "loc") return undefined;
  const pathIndex = tuple[0] === "engine-agent" ? 3 : tuple[0] === "classic" ? 2 : -1;
  const path = pathIndex >= 0 ? tuple[pathIndex] : undefined;
  return typeof path === "string" ? path : undefined;
}

/**
 * The classifier (design #402 §3b). `prev === null` means round 1 — no previous `drive-fixup` has
 * ever been recorded for this lane (the caller's own `state.eventsSince`-derived history is empty),
 * which is structurally different from a previous round that recorded zero findings (`prev === []`,
 * a real round whose count legitimately fell to zero and then rose again — `[].length === 0` still
 * participates in the row-2/row-4 count comparisons below, `null` never does). See this module's
 * header doc for the six rows, the degradation rule, and the unlocated-never-recurs property — all
 * enforced here, none re-explained inline.
 */
export function classifyProgress(
  prev: readonly ProgressFinding[] | null,
  curr: readonly ProgressFinding[],
  fixDiffPaths: readonly string[],
  flatStreak: number,
): ConvergenceVerdict {
  if (prev === null) return "converging"; // row 1

  const prevBlocking = filterBlocking(prev);
  const currBlocking = filterBlocking(curr);
  const prevKeys = new Set(prevBlocking.map((f) => f.key));
  const currKeys = new Set(currBlocking.map((f) => f.key));
  const shared = [...currKeys].filter((k) => prevKeys.has(k));

  // row 2: count falling, or every old finding is gone (new areas) -> converging.
  if (currBlocking.length < prevBlocking.length || shared.length === 0) return "converging";

  // row 3: a shared key the fix leg's own diff touched, and it is STILL there -> recurrence.
  for (const key of shared) {
    const path = extractLocatedPath(key);
    if (path !== undefined && fixDiffPaths.includes(path)) return { stalled: "recurrence" };
  }

  // row 4: non-decreasing for two consecutive rounds (this one included) -> flat.
  if (flatStreak >= 2) return { stalled: "flat" };

  // row 5: a NEW key, inside the path the fix leg just touched -> marginal-complexity.
  const added = [...currKeys].filter((k) => !prevKeys.has(k));
  for (const key of added) {
    const path = extractLocatedPath(key);
    if (path !== undefined && fixDiffPaths.includes(path)) return { stalled: "marginal-complexity" };
  }

  // row 6: count up for exactly one round, no recurrence, no new-in-fix -> one bad round is not a
  // trend, converging.
  return "converging";
}

/**
 * The trailing run length of consecutive non-decreasing rounds, ending at (and including) the
 * CURRENT round — `classifyProgress`'s own `flatStreak` input, computed fresh from a plain
 * `number[]` of past per-round blocking counts (oldest first) plus this round's own count. No
 * persisted counter (this module's header doc); the caller re-derives `pastCounts` from the event
 * ledger every call.
 *
 * `computeFlatStreak([], anyCount) === 0` — a single count has nothing to compare against, and
 * `classifyProgress`'s own `prev === null` round-1 case never consults this value anyway (stated
 * here so a caller does not need to special-case round 1 before calling this).
 * `computeFlatStreak([3], 3) === 1` — the FIRST non-decreasing observation (issue #450 verification
 * item 4: "flatStreak: 1 -> continue", i.e. not yet two).
 * `computeFlatStreak([3, 3], 3) === 2` — the SECOND consecutive one (verification item 4:
 * "flatStreak: 2 -> flat").
 */
export function computeFlatStreak(pastCounts: readonly number[], currCount: number): number {
  const counts = [...pastCounts, currCount];
  let streak = 0;
  for (let i = counts.length - 1; i >= 1; i--) {
    if (counts[i]! >= counts[i - 1]!) streak++;
    else break;
  }
  return streak;
}
