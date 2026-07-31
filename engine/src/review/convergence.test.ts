// convergence.test.ts (#450, design #402 R3) — the pure classifier: six shapes, the degradation
// rule, and the unlocated-never-recurs property. See convergence.ts's own header doc for the exact
// per-row formula. Keys below are built with `finding-key.ts`'s OWN functions wherever a realistic
// located/unlocated shape matters — consuming R2's contract rather than hand-rolling JSON strings
// that could silently drift from what `finding-key.ts` actually produces (#449's own discipline,
// carried over here).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyProgress, computeFlatStreak, countBlocking, type FlatStreakRound, type ProgressFinding } from "./convergence.js";
import { classicThreadFindingKey, engineAgentFindingKey } from "./finding-key.js";

const locatedA = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/a.ts" }).key;
const locatedB = engineAgentFindingKey({ id: "f2", kind: "correctness", path: "src/b.ts" }).key;
const locatedC = engineAgentFindingKey({ id: "f3", kind: "design", path: "src/c.ts" }).key;
const unlocatedX = engineAgentFindingKey({ id: "finding-x", kind: "security" }).key;
const unlocatedY = engineAgentFindingKey({ id: "finding-y", kind: "security" }).key;

function blocking(key: string): ProgressFinding {
  return { key, severity: "blocking" };
}
function advisory(key: string): ProgressFinding {
  return { key, severity: "advisory" };
}

// ── the six shapes (design #402 §3b's table, one test per row) ────────────────────────────────

test("classifyProgress row 1: no previous round -> converging, by definition", () => {
  const result = classifyProgress(null, [blocking(locatedA)], [], 0);
  assert.equal(result, "converging");
});

test("classifyProgress row 2a: curr.length < prev.length -> converging (count falling)", () => {
  const prev = [blocking(locatedA), blocking(locatedB)];
  const curr = [blocking(locatedA)];
  const result = classifyProgress(prev, curr, ["src/a.ts"], 0);
  assert.equal(result, "converging");
});

test("classifyProgress row 2b: curr ∩ prev = ∅ -> converging (all old findings gone, new ones elsewhere)", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedB)];
  // locatedB's path IS in fixDiffPaths, which would satisfy marginal-complexity's OWN test —
  // proving row 2's disjoint-set check wins over row 5, exactly the table's own row order.
  const result = classifyProgress(prev, curr, ["src/b.ts"], 0);
  assert.equal(result, "converging");
});

test("classifyProgress row 3: a shared key whose path the fix leg touched -> stalled: recurrence", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA)];
  const result = classifyProgress(prev, curr, ["src/a.ts"], 0);
  assert.deepEqual(result, { stalled: "recurrence" });
});

test("classifyProgress row 4: non-decreasing for two consecutive rounds -> stalled: flat", () => {
  // A genuinely disjoint curr/prev would hit row 2 first — so give them ONE shared key plus one
  // extra apiece, none of which is inside fixDiffPaths, isolating row 4 from rows 3/5.
  const prev = [blocking(locatedA), blocking(locatedC)];
  const curr = [blocking(locatedA), blocking(locatedB)];
  const result = classifyProgress(prev, curr, [], 2);
  assert.deepEqual(result, { stalled: "flat" });
});

test("classifyProgress row 5: a NEW key inside the path the fix leg just touched -> stalled: marginal-complexity", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(locatedB)]; // shares locatedA, adds locatedB
  const result = classifyProgress(prev, curr, ["src/b.ts"], 0); // fixDiffPaths touches ONLY the new one
  assert.deepEqual(result, { stalled: "marginal-complexity" });
});

test("classifyProgress row 6: count up for one round, no recurrence, no new-in-fix -> converging (one bad round is not a trend)", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(locatedB)]; // shares locatedA, adds locatedB
  const result = classifyProgress(prev, curr, [], 1); // fixDiffPaths touches NEITHER, flatStreak < 2
  assert.equal(result, "converging");
});

// ── the two "continue" defaults, restated explicitly (issue #450 verification item 1) ─────────

test("continue default #1: round 1 never looks like non-convergence, regardless of how many findings it has", () => {
  const result = classifyProgress(null, [blocking(locatedA), blocking(locatedB), blocking(locatedC)], ["src/a.ts", "src/b.ts"], 5);
  assert.equal(result, "converging", "round 1 has no previous round to compare against — always converging");
});

test("continue default #2: one bad round (count up, no recurrence, no new-in-fix) never escalates on its own", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(locatedB)];
  assert.equal(classifyProgress(prev, curr, [], 1), "converging");
});

// ── recurrence needs a code change — the #378 boundary pair (verification item 2) ─────────────

test("recurrence pair: SAME key both rounds, path ABSENT from fixDiffPaths -> converging; path PRESENT -> recurrence", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA)];
  const untouched = classifyProgress(prev, curr, [], 0);
  const touched = classifyProgress(prev, curr, ["src/a.ts"], 0);
  assert.equal(untouched, "converging", "the fix leg never touched src/a.ts — #378's case, not recurrence");
  assert.deepEqual(touched, { stalled: "recurrence" }, "the fix leg touched src/a.ts and the finding survived");
});

// ── advisories excluded (verification item 3) ──────────────────────────────────────────────────

test("advisories excluded: a round whose count 'rises' only through advisories classifies as if they were absent", () => {
  const prev = [blocking(locatedA)];
  const currWithoutAdvisory = [blocking(locatedA)];
  const currWithAdvisory = [blocking(locatedA), advisory(locatedB), advisory(locatedC)];
  const without = classifyProgress(prev, currWithoutAdvisory, ["src/a.ts", "src/b.ts", "src/c.ts"], 0);
  const withAdvisories = classifyProgress(prev, currWithAdvisory, ["src/a.ts", "src/b.ts", "src/c.ts"], 0);
  assert.deepEqual(without, withAdvisories, "advisory findings must not change the verdict at all");
  assert.deepEqual(without, { stalled: "recurrence" }, "sanity: the blocking-only shape is recurrence in both cases");
});

test("advisories excluded: an advisory-only curr\\prev addition never trips marginal-complexity", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), advisory(locatedB)]; // locatedB is advisory, inside fixDiffPaths
  const result = classifyProgress(prev, curr, ["src/b.ts"], 0);
  assert.equal(result, "converging", "the only curr\\prev key is advisory — filtered before the marginal-complexity check ever sees it");
});

// ── flat needs two rounds (verification item 4) ────────────────────────────────────────────────

test("flat needs two rounds: flatStreak: 1 -> converging, flatStreak: 2 -> flat (identical shared/added sets otherwise)", () => {
  const prev = [blocking(locatedA), blocking(locatedC)];
  const curr = [blocking(locatedA), blocking(locatedB)]; // shares A, drops C, adds B — none in fixDiffPaths
  const one = classifyProgress(prev, curr, [], 1);
  const two = classifyProgress(prev, curr, [], 2);
  assert.equal(one, "converging");
  assert.deepEqual(two, { stalled: "flat" });
});

// ── the degradation rule (architectural review amendment, 2026-07-31) ──────────────────────────
// `fixDiffPathsUnavailable` (or the paths legitimately empty) means R2's `gatherFixDiffPaths`
// already recorded `fixDiffPaths: []` — this module accepts no separate flag, the empty array
// alone must make recurrence/marginal-complexity structurally unreachable while flat is untouched.

test("degradation rule: empty fixDiffPaths (fixDiffPathsUnavailable) -> a recurrence candidate cannot fire, degrades to converging", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA)]; // would be recurrence with a non-empty, matching fixDiffPaths
  const result = classifyProgress(prev, curr, [], 0);
  assert.equal(result, "converging");
});

test("degradation rule: empty fixDiffPaths -> a marginal-complexity candidate cannot fire, degrades to converging", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(locatedB)]; // would be marginal-complexity with a matching fixDiffPaths
  const result = classifyProgress(prev, curr, [], 0);
  assert.equal(result, "converging");
});

test("degradation rule: flat STILL fires with empty fixDiffPaths — count-only convergence is not blind, only narrower", () => {
  const prev = [blocking(locatedA), blocking(locatedC)];
  const curr = [blocking(locatedA), blocking(locatedB)];
  const result = classifyProgress(prev, curr, [], 2);
  assert.deepEqual(result, { stalled: "flat" }, "flat never consults fixDiffPaths at all");
});

// ── truncation rule (#450 gate② Codex cross-vendor, PM-narrowed ruling): a capped snapshot's
// COUNT is a floor, never a fact — `flat` and the count-falling row are disabled whenever EITHER
// compared round is truncated; `recurrence`/`marginal-complexity` (key-identity, not count) are
// UNAFFECTED and evaluate normally over the visible keys. ──────────────────────────────────────

test("truncation rule: the EXACT 100->75->51 finding scenario — a genuinely falling count read through two truncated 50-item snapshots never classifies as flat", () => {
  // The actual finding sets don't matter here (only their LENGTH and truncation bits do for row
  // 4) — shared+disjoint shape is irrelevant since flat is checked independently of shared/added.
  // Use a shared key so row 2's disjoint clause doesn't short-circuit before reaching row 4.
  const prev = [blocking(locatedA), blocking(locatedB)];
  const curr = [blocking(locatedA), blocking(locatedC)];
  // flatStreak: 2 is exactly what the bug would have computed (three constant `50`s read as
  // non-decreasing) — passed in directly to prove classifyProgress itself refuses to honor it,
  // independent of whatever computeFlatStreak returns upstream.
  const untrustedBothTruncated = classifyProgress(prev, curr, [], 2, true, true);
  assert.equal(untrustedBothTruncated, "converging", "flat must not fire when BOTH compared rounds are truncated");
  const prevOnlyTruncated = classifyProgress(prev, curr, [], 2, true, false);
  assert.equal(prevOnlyTruncated, "converging", "flat must not fire when ONLY prev is truncated");
  const currOnlyTruncated = classifyProgress(prev, curr, [], 2, false, true);
  assert.equal(currOnlyTruncated, "converging", "flat must not fire when ONLY curr is truncated");
  // Sanity: the IDENTICAL inputs, untruncated, DO classify as flat — proves the truncation flags
  // (not some other difference) are what suppressed it above.
  const untruncated = classifyProgress(prev, curr, [], 2);
  assert.deepEqual(untruncated, { stalled: "flat" }, "same shapes, untruncated -> flat fires normally");
});

test("truncation rule: a truncated pair whose SHARED key's path IS in fixDiffPaths still fires recurrence — identity-based rows are unaffected by truncation", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA)];
  const result = classifyProgress(prev, curr, ["src/a.ts"], 0, true, true);
  assert.deepEqual(result, { stalled: "recurrence" }, "recurrence is key-identity, not count — truncation must not suppress it");
});

test("truncation rule: a truncated pair with a NEW key inside the touched path still fires marginal-complexity", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(locatedB)];
  const result = classifyProgress(prev, curr, ["src/b.ts"], 0, true, true);
  assert.deepEqual(result, { stalled: "marginal-complexity" });
});

test("truncation rule: the count-falling continue row is ALSO disabled under truncation, but the final verdict is unaffected when nothing else fires (still converging)", () => {
  const prev = [blocking(locatedA), blocking(locatedB)];
  const curr = [blocking(locatedA)]; // fewer VISIBLE findings — would fire row 2 if trusted
  const result = classifyProgress(prev, curr, [], 0, true, false);
  assert.equal(result, "converging", "falls through to row 6 instead of row 2's shortcut, same final answer");
});

test("truncation rule: omitting prevTruncated/currTruncated defaults BOTH to false — every pre-#450-gate②-Codex call is byte-identical", () => {
  const prev = [blocking(locatedA), blocking(locatedC)];
  const curr = [blocking(locatedA), blocking(locatedB)];
  const withoutFlags = classifyProgress(prev, curr, [], 2);
  const withExplicitFalse = classifyProgress(prev, curr, [], 2, false, false);
  assert.deepEqual(withoutFlags, withExplicitFalse);
  assert.deepEqual(withoutFlags, { stalled: "flat" });
});

// ── unlocated keys: participate in counts, never in recurrence ────────────────────────────────

test("unlocated keys: a shared UNLOCATED key never triggers recurrence, even though it is in curr ∩ prev", () => {
  const prev = [blocking(unlocatedX)];
  const curr = [blocking(unlocatedX)];
  // No path exists to test membership against — an unlocated key can never satisfy row 3, no
  // matter what fixDiffPaths contains.
  const result = classifyProgress(prev, curr, ["src/anything.ts"], 0);
  assert.equal(result, "converging");
});

test("unlocated keys: a NEW unlocated key never triggers marginal-complexity", () => {
  const prev = [blocking(locatedA)];
  const curr = [blocking(locatedA), blocking(unlocatedX)];
  const result = classifyProgress(prev, curr, ["src/anything.ts"], 0);
  assert.equal(result, "converging");
});

test("unlocated keys: they DO participate in counts — two different unlocated findings still trip flat at streak 2", () => {
  // Two DIFFERENT unlocated keys alone would make curr ∩ prev = ∅ (row 2 wins, not flat) — so
  // pair each with a shared locatable key, keeping the intersection non-empty and reaching row 4.
  const prev = [blocking(locatedA), blocking(unlocatedX)];
  const curr = [blocking(locatedA), blocking(unlocatedY)];
  const result = classifyProgress(prev, curr, [], 2);
  assert.deepEqual(result, { stalled: "flat" }, "unlocated findings still count toward the LENGTH comparison");
});

// ── classic-path keys work identically (both domains share one classifier) ────────────────────

test("classic-path (thread) keys: recurrence fires the same way as engine-agent keys", () => {
  const key = classicThreadFindingKey({ id: "T1", path: "src/thread.ts", findingDigest: "deadbeef" }).key;
  const prev = [blocking(key)];
  const curr = [blocking(key)];
  const result = classifyProgress(prev, curr, ["src/thread.ts"], 0);
  assert.deepEqual(result, { stalled: "recurrence" });
});

// ── computeFlatStreak: the pure trailing-streak counter ─────────────────────────────────────────

/** Untruncated round shorthand — `r(3)` === `{ count: 3, truncated: false }`. */
function r(count: number): FlatStreakRound {
  return { count, truncated: false };
}
/** Truncated round shorthand. */
function rt(count: number): FlatStreakRound {
  return { count, truncated: true };
}

test("computeFlatStreak: empty history -> 0, nothing to compare against", () => {
  assert.equal(computeFlatStreak([], r(3)), 0);
});

test("computeFlatStreak: first non-decreasing observation -> 1 (not yet two)", () => {
  assert.equal(computeFlatStreak([r(3)], r(3)), 1);
  assert.equal(computeFlatStreak([r(3)], r(5)), 1);
});

test("computeFlatStreak: second consecutive non-decreasing round -> 2", () => {
  assert.equal(computeFlatStreak([r(3), r(3)], r(3)), 2);
  assert.equal(computeFlatStreak([r(1), r(2)], r(3)), 2);
});

test("computeFlatStreak: a falling round resets the streak to 0", () => {
  assert.equal(computeFlatStreak([r(3), r(3)], r(1)), 0);
});

test("computeFlatStreak: a streak can restart after a reset", () => {
  // rounds: 5, 5 (non-decreasing, streak=1), 2 (falling, streak=0), 2 (non-decreasing, streak=1)
  assert.equal(computeFlatStreak([r(5), r(5), r(2)], r(2)), 1);
});

// ── computeFlatStreak: truncated rounds are NEUTRAL (#450 gate② Codex cross-vendor, PM-narrowed
// ruling) — neither extend nor break a streak; the walk skips over them entirely. ────────────────

test("computeFlatStreak: a truncated round in the MIDDLE of an otherwise non-decreasing run is invisible — the streak bridges the gap, neither broken nor double-counted", () => {
  // round1=3 (untrunc), round2=TRUNCATED (any count), round3=3 (untrunc, curr): skips round2
  // entirely, compares round1 directly against round3 -> ONE observation, streak=1.
  assert.equal(computeFlatStreak([r(3), rt(999)], r(3)), 1);
});

test("computeFlatStreak: a streak can accumulate to 2 THROUGH a truncated middle round", () => {
  // round1=3, round2=TRUNCATED, round3=3, round4=3(curr): round1->round3 bridges the gap
  // (streak=1), round3->round4 extends it (streak=2) — the truncated round contributed neither.
  assert.equal(computeFlatStreak([r(3), rt(999), r(3)], r(3)), 2);
});

test("computeFlatStreak: the CURRENT round itself truncated -> its own slot is skipped, but the walk still reports the trailing streak among the PAST rounds behind it (harmless: classifyProgress never consults this value when curr is truncated)", () => {
  // curr (rt(999)) is skipped entirely; the two PAST rounds behind it (both count 3, untruncated)
  // are compared to each other instead — a streak that describes THEM, not curr.
  assert.equal(computeFlatStreak([r(3), r(3)], rt(999)), 1);
});

test("computeFlatStreak: the EXACT 100->75->51 finding scenario — three truncated 50-item snapshots (a genuinely falling count) never accumulate a streak", () => {
  // Every round is truncated (all three capped at 50) — every slot is skipped, streak stays 0.
  assert.equal(computeFlatStreak([rt(50), rt(50)], rt(50)), 0);
});

test("computeFlatStreak: an ALL-truncated history never breaks a real streak once untruncated rounds resume", () => {
  // round1=TRUNCATED, round2=TRUNCATED, round3=5(untrunc), round4=5(untrunc,curr): only round3/4
  // are ever compared (nothing untruncated behind round3 to bridge to) — streak=1, not reset to 0
  // by the truncated prefix, and not inflated by it either.
  assert.equal(computeFlatStreak([rt(1), rt(2), r(5)], r(5)), 1);
});

// ── countBlocking: the shared filter definition ─────────────────────────────────────────────────

test("countBlocking: counts only severity: blocking entries", () => {
  const entries: ProgressFinding[] = [blocking(locatedA), advisory(locatedB), blocking(locatedC), advisory(unlocatedX)];
  assert.equal(countBlocking(entries), 2);
});

test("countBlocking: empty input -> 0", () => {
  assert.equal(countBlocking([]), 0);
});

// ── grep invariants (mirrors finding-key.test.ts's own discipline) ─────────────────────────────

test("convergence.ts is pure — no timestamp/wall-clock comparison anywhere in this module", () => {
  const source = readFileSync(new URL("./convergence.ts", import.meta.url), "utf8");
  for (const forbidden of ["Date.now(", "new Date(", ".getTime(", "Date.parse("]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.()]/g, "\\$&")), `convergence.ts unexpectedly uses ${forbidden}`);
  }
});

test("#450: no PROTECTED_SUFFIXES source file contains this issue's new symbols (guard/reviewer/merge-driver never touched)", () => {
  const protectedFiles = [
    new URL("../guard/guard.ts", import.meta.url),
    new URL("../guard/guard-hook.ts", import.meta.url),
    new URL("../roles/reviewer.ts", import.meta.url),
    new URL("../roles/merge-driver.ts", import.meta.url),
  ];
  const introducedSymbols = [
    "classifyProgress",
    "computeFlatStreak",
    "ConvergenceVerdict",
    "ConvergenceStallSignal",
    "ProgressFinding",
    "review-non-convergent",
    "escalateNonConvergent",
  ];
  for (const url of protectedFiles) {
    const source = readFileSync(url, "utf8");
    for (const symbol of introducedSymbols) {
      assert.doesNotMatch(source, new RegExp(symbol), `${url.pathname} unexpectedly references ${symbol}`);
    }
  }
});
