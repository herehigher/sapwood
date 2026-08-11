# #390 — engine-agent stateless signal parity (hold observation)

> **Process record.** Internal design/research artifact from sapwood's own development history — not end-user documentation.

Design/handoff record for issue #390. Two things live here, and the reason they live in a
*file* rather than only in PR #517's description is itself a finding from this repo's own
engine-agent reviewer: a reviewing session's materials contain the file diff, the issue body,
the acceptance-criteria list and the doctrine — **not the PR body**. Anything a reviewer must
check has to be in the diff. PR #517's description carries the same two sections verbatim (the
acceptance criteria ask for them there); this file is the reviewable copy.

## Status

- **Landed in PR #517:** the tests (`engine/src/roles/merge-driver.test.ts`,
  `engine/src/loop/conductor.test.ts`).
- **Not landed, and not landable by a producer:** the wiring in
  `engine/src/roles/merge-driver.ts`. That file is on `docs/security.md`'s *Human-merge-only
  paths* list — the guard denies a non-human session's write to it. It ships as the appendix
  patch below, for a human to apply and merge themselves.

## What was wrong

`driveEngineAgentOne` (#287) returns before `driveOne`'s classic signal wrapping, so on an
engine-agent-configured project the `holdObservation` (#294) never reached the conductor. The
*gate* was always correct — `review/drive.ts`'s `checkPreflight` evaluates `holdLabels` and
queues a held PR — but with no signal reported, `pr-held`/`pr-released` could never fire and a
held PR was indistinguishable from one waiting on review in persisted data.

The conductor half needs no change at all: it consumes `holdObservation` reviewer-kind
agnostically. `conductor.test.ts`'s `tick DRIVE (#390)` test proves that on engine-agent-shaped
outcomes, and it runs in CI today.

## reviewerTransition / reviewSilenceEscalation decision

**Decision: implement `holdObservation`; defer any further `reviewerTransition` (#54) /
`reviewSilenceEscalation` (#170) work.** #390's premise that all three signals are absent is out
of date for two of them — what is actually stale is `merge-driver.ts`'s own #287 doc comment.

#288 already wired both on the one engine-agent shape that has an equivalent clock: an
`unavailable` attempt pin aged against the persisted first-attempt time. `driveEngineAgentOne`'s
unavailable branch returns a `reviewerTransition` on a fallback switch and a
`reviewSilenceEscalation` past `escalateAfterSec`; `merge-driver.test.ts`'s `#288/#54` and
`#288/#170` tests pin exactly that behavior.

What remains is not missing wiring but shapes with nothing to key off:

- a `revert` transition belongs to `resolveReviewVerdict`'s fallback-**lock** lifecycle, which
  this path never enters — it consults fallbacks directly and holds no lock to revert *from*;
- silence on a pin that is decisive-or-absent is not silence. A decisive pin means gate② *spoke*
  (the aging arm that matters there is #426's gate①-pending clock, already wired), and no pin at
  all means no attempt has been made yet, so there is nothing to have been silent since.

Re-open this if the engine-agent path ever grows a fallback lock. The appendix patch below
carries this decision into `merge-driver.ts`'s module header, so the file stops claiming a
deviation it no longer has.

## Design notes on the wiring

- **One shared computation.** `holdFrom` wraps the existing `firstMatchingLabel` witness
  (`forge/labels.ts`, added by #294 for exactly this) and is called by both drive paths, so the
  classic path's former inline `.find(...)` and the engine-agent path cannot drift. Exact
  case-insensitive identity (#248 G3), reported in the label's **on-PR casing** — the conductor's
  `pr-held` payload names the string a human actually applied.
  - One behavior nuance: the classic path's inline matcher lowercased both sides;
    `firstMatchingLabel` also **trims** (repo-standard `normalizeLabel`), so a whitespace-padded
    configured hold label now matches where it previously would not. Full suite green.
- **One attachment point.** `driveEngineAgentOne` splits into a signal wrapper plus an unchanged
  `gateEngineAgentOutcome`, so a branch nobody remembers to update still reports the observation
  — the same lesson #426 review round 3 applied to the classic path's `observed` wrapper.
- **`merged` is terminal:** reported `held:false` unconditionally, the same ruling the classic
  path's own MERGED early-return takes (#294 round 2) — the conductor closes the lane on that
  very outcome, so announcing a hold no later pass could release would strand the episode.
- **The cost, stated plainly.** Outcomes carrying no PR data of their own (`queued`,
  `needs-human`) need labels the pipeline read but does not return, so `engineAgentHold` spends
  **one extra `getPRReviewData` read** on those passes. It is skipped entirely when
  `escalation.holdLabels` is empty (`held:false` by construction) and never happens on `merged`.
  This mirrors how #288's own engine-agent signals already work on this path — they refetch
  `status`+`data` themselves — rather than inventing a second pattern. A failed read reports
  nothing, which is a no-op at the conductor, never a release.
  - The zero-extra-read alternative is to return the already-fetched `data0.labels` from
    `EngineAgentDriveOutcome` in `review/drive.ts`. That is a change in a second production file
    and was left out to respect #390's stated scope; it would be a drop-in replacement for the
    `engineAgentHold` body if whoever applies the patch prefers it.

## Verification

The patch below was applied to a scratch copy of the tree (never to the protected file in this
repo) and the suite run there:

- **with the patch applied:** `merge-driver.test.ts` 145 pass / 0 fail / 0 skipped; full engine
  suite **3665 pass / 0 fail**; `tsc` typecheck clean; `biome ci` clean.
- **as committed (patch not applied):** full engine suite 3661 pass / 0 fail / 6 skipped — four
  of those skips are #390's parity tests, waiting on the patch.
- `git apply --check` against PR #517's tip: clean.

The four parity tests are committed **skipped** because a producer cannot land the code they
assert, not because they are aspirational. The patch un-skips all four in its own hunks, updates
the seven existing exact-shape assertions that then carry a `holdObservation`, and **deletes the
`#390 gap` test** — the test that runs today asserting the current, broken, absent observation.
Before and after are mutually exclusive by construction, so the change cannot be left
half-applied silently.

## Proposed merge-driver.ts diff

Transient appendix: delete this section once the patch is applied and merged. Apply from the repo root
with `git apply`. The first hunks are `merge-driver.ts` (the wiring plus the #287 doc-comment
correction); the rest are `merge-driver.test.ts` (un-skips, assertion updates, gap-pin deletion).

```diff
diff --git a/engine/src/roles/merge-driver.ts b/engine/src/roles/merge-driver.ts
index ef52d82..a4800b3 100644
--- a/engine/src/roles/merge-driver.ts
+++ b/engine/src/roles/merge-driver.ts
@@ -25,11 +25,30 @@
 // behavior change for the three existing Reviewer kinds — see finalizeVerdict's own doc) the
 // classic path already used inline. #288's production composition binds its dependency-rich
 // construction and crash-safe audit delivery outside buildReviewerByKind's limited classic seam.
+//
+// STATELESS SIGNAL PARITY on that second path (#390), closing #287's documented deviation:
+//  - `holdObservation` (#294) — reported on EVERY engine-agent pass, from `driveEngineAgentOne`'s
+//    own wrapper, using the SAME `holdFrom` helper the classic path uses. This was the whole gap:
+//    the engine-agent GATE always honored a hold (checkPreflight evaluates holdLabels and queues),
+//    but nothing reported it, so the conductor could never emit pr-held/pr-released for such a
+//    lane and a held PR was indistinguishable from "waiting on review" in persisted data.
+//  - `reviewerTransition` (#54) and `reviewSilenceEscalation` (#170) — already present since #288,
+//    on the ONE engine-agent shape that has an equivalent clock: an `unavailable` attempt pin aged
+//    against the persisted FIRST-attempt time (see driveEngineAgentOne's own unavailable branch).
+//    Deliberately NOT extended further. The remaining shapes have no engine-agent equivalent to
+//    key off rather than a missing wire: a `revert` transition is `resolveReviewVerdict`'s
+//    fallback-lock lifecycle, which this path never enters (it consults fallbacks directly, and
+//    holds no lock to revert FROM), and silence on a pin that is decisive-or-absent is not silence
+//    at all — a decisive pin means gate② SPOKE (the aging arm that matters there is #426's
+//    gate①-pending clock, already wired), and no pin means no attempt has been made yet, so there
+//    is nothing to have been silent since. Re-open this if engine-agent ever grows a fallback lock.
+//  - `ciPendingObservation`/`ciPendingEscalation` (#426) stay classic-only for now — out of #390's
+//    scope, and unlike the hold they need a head-scoped pin this path does not thread through.
 
 import type { SapwoodConfig } from "../config/config.js";
 import type { IForge, PRReviewData, PRStatus } from "../forge/forge.js";
-import { labelsInclude, labelsIncludeAny, labelsIncludeAnySubstring } from "../forge/labels.js";
-import type { EngineAgentDriveDeps } from "../review/drive.js";
+import { firstMatchingLabel, labelsInclude, labelsIncludeAny, labelsIncludeAnySubstring } from "../forge/labels.js";
+import type { EngineAgentDriveDeps, EngineAgentDriveOutcome } from "../review/drive.js";
 import { driveEngineAgentReview } from "../review/drive.js";
 import { escalateInstructionPathChanges } from "../review/instruction-path-escalation.js";
 import type {
@@ -465,12 +484,9 @@ export class MergeDriver {
     // from mixed reads" stance the gate itself takes, and both are one-tick transients — an
     // absent observation is a no-op at the conductor, never a release.
     // Exact case-insensitive identity (#248 G3), reported in on-PR casing (see the
-    // DriveOutcome.holdObservation doc above).
-    const heldLabel = data.labels.find((l) => cfg.escalation.holdLabels.some((h) => h.toLowerCase() === l.toLowerCase()));
-    const holdObservation: NonNullable<DriveOutcome["holdObservation"]> = {
-      held: heldLabel != null,
-      ...(heldLabel != null ? { label: heldLabel } : {}),
-    };
+    // DriveOutcome.holdObservation doc above). #390: computed by the shared `holdFrom` helper —
+    // the engine-agent path reports the same observation through the same one computation.
+    const holdObservation = this.holdFrom(data.labels);
     // #426 review round 3 (P2): every `observed(...)` return additionally reports the LIVE HEAD it
     // saw, with `pending: "unknown"` — such a pass never derived a gate, so it genuinely does not
     // know whether gate① is pending, but it DOES know which head it is looking at. That is enough
@@ -750,11 +766,11 @@ export class MergeDriver {
    * assertion passes unchanged): the only difference is this no longer wraps each return in
    * `withSignals` (that wrapper is #54/#170-specific — reviewer-failover-transition /
    * review-silence-escalation signals keyed off the CLASSIC `ReviewTriggerPin`, which the
-   * engine-agent path has no equivalent of yet — see review/drive.ts's own doc on its companion
-   * `engine_review_first_attempt_at` clock). The classic call site re-wraps this method's return
-   * in `withSignals` itself (unchanged shape); `driveEngineAgentOne` (below) calls this directly,
-   * with no signal wrapping — engine-agent's #54/#170-equivalent visibility is out of this PR's
-   * scope (documented deviation, PR body).
+   * engine-agent path keys off its own `engine_review_first_attempt_at` clock instead — see
+   * review/drive.ts's own doc). The classic call site re-wraps this method's return in
+   * `withSignals` itself (unchanged shape); `driveEngineAgentOne` (below) calls this directly and
+   * attaches its OWN signals in its wrapper (#390: `holdObservation` on every pass, via the shared
+   * `holdFrom` helper; #288: the failover/silence pair on the unavailable-pin shape).
    *
    * `status`/`data` must already be a MUTUALLY CONSISTENT, freshly-fetched pair for the SAME
    * head — this method does not re-verify that itself (both callers already guarantee it: the
@@ -890,13 +906,67 @@ export class MergeDriver {
     engineAgentDeps: Omit<EngineAgentDriveDeps, "forge" | "cfg" | "reviewerAdapter"> | undefined,
   ): Promise<DriveOutcome> {
     if (!engineAgentDeps) {
+      // A lane with no drive context never read the PR at all — no observation to report, which
+      // is a no-op at the conductor (never a release). Same stance as the classic path's own
+      // gate-data-unavailable queue.
       return { kind: "queued", pr, reason: "engine-agent: no drive context supplied for this lane (missing engineAgentDeps)" };
     }
-    const outcome = await driveEngineAgentReview(
+    const review = await driveEngineAgentReview(
       { ...engineAgentDeps, forge: this.deps.forge, cfg: this.deps.cfg, reviewerAdapter },
       pr,
       issue,
     );
+    const gated = await this.gateEngineAgentOutcome(pr, review, engineAgentDeps);
+    // #390: the ONE place the engine-agent path attaches its hold observation — the analogue of
+    // the classic path's `withSignals`/early-return pair, in a single wrapper so a branch nobody
+    // remembers to update still reports it (the same "attach it in the shared wrapper" lesson
+    // #426 review round 3 applied to `observed`). Outcomes that carry their own PR read use ITS
+    // labels — the exact snapshot this pass gated on; everything else asks `engineAgentHold`.
+    const hold = "data" in review ? this.holdFrom(review.data.labels) : await this.engineAgentHold(pr, gated);
+    return hold ? { ...gated, holdObservation: hold } : gated;
+  }
+
+  /** #294/#390: the ONE hold-observation computation both drive paths use. Exact case-insensitive
+   *  identity (#248 G3) via the shared `firstMatchingLabel` witness, reported in the label's ON-PR
+   *  casing so the conductor's `pr-held` payload names the string a human actually applied. Pure:
+   *  it never gates anything — `deriveGate`'s own holdLabels WAIT check remains the sole
+   *  scheduling effect of a hold. */
+  private holdFrom(labels: readonly string[]): NonNullable<DriveOutcome["holdObservation"]> {
+    const label = firstMatchingLabel(labels, this.deps.cfg.escalation.holdLabels);
+    return { held: label != null, ...(label != null ? { label } : {}) };
+  }
+
+  /** #390: the hold observation for an engine-agent outcome that carries no PR data of its own
+   *  (queued / needs-human / merged — see EngineAgentDriveOutcome).
+   *   - MERGED is terminal: reported NOT-held unconditionally, the SAME ruling the classic path's
+   *     own MERGED early-return takes (#294 round 2) — the conductor closes the lane on this very
+   *     outcome, so announcing a hold no later pass could ever release would strand the episode,
+   *     while `held:false` lets a previously-announced one close with `pr-released`.
+   *   - No hold label CONFIGURED -> `held:false` by construction, with no read at all.
+   *   - Otherwise ONE live label read. That it is a SEPARATE read from the one drive.ts gated on
+   *     is deliberate and not a mixed-read violation of the gate's own stance: the observation
+   *     gates nothing (it is pure visibility), and it is the same shape #288's own engine-agent
+   *     signals already use on this path (the unavailable-pin branch below refetches status+data
+   *     for exactly this reason) — engine-agent signals are derived from a merge-driver-side live
+   *     read, never from drive.ts's internal gate reads. A failed read reports NOTHING, which is a
+   *     no-op at the conductor and never a release (see DriveOutcome.holdObservation). */
+  private async engineAgentHold(pr: number, outcome: DriveOutcome): Promise<DriveOutcome["holdObservation"]> {
+    if (outcome.kind === "merged" || this.deps.cfg.escalation.holdLabels.length === 0) return { held: false };
+    try {
+      return this.holdFrom((await this.deps.forge.getPRReviewData(pr)).labels);
+    } catch {
+      return undefined;
+    }
+  }
+
+  /** #390: `driveEngineAgentOne`'s gate half — the pipeline outcome -> DriveOutcome mapping,
+   *  UNCHANGED from #287/#460/#503/#288 (mechanical split, so the signal wrapper above has exactly
+   *  one place to attach to). Never throws, same contract as its caller. */
+  private async gateEngineAgentOutcome(
+    pr: number,
+    outcome: EngineAgentDriveOutcome,
+    engineAgentDeps: Omit<EngineAgentDriveDeps, "forge" | "cfg" | "reviewerAdapter">,
+  ): Promise<DriveOutcome> {
     // #303 review round 2 (P1): terminal-state outcomes (merged/needs-human) map directly —
     // same shape the classic path's own MERGED early-return already produces (no finalizeVerdict
     // involvement, mirroring merge-driver.ts's own MERGED check above in the classic branch).
diff --git a/engine/src/roles/merge-driver.test.ts b/engine/src/roles/merge-driver.test.ts
index e44c556..c993d7b 100644
--- a/engine/src/roles/merge-driver.test.ts
+++ b/engine/src/roles/merge-driver.test.ts
@@ -2203,7 +2203,13 @@ test("MergeDriver.driveOne (engine-agent, #460): CONFLICTING -> FIXABLE:merge-co
   const recorded: EARecorded = { pin: null, wal: null };
   const driver = new MergeDriver({ forge, reviewer, cfg });
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "fixable", pr: 7, reason: "gate:FIXABLE:merge-conflict", prescription: "conflict" });
+  assert.deepEqual(outcome, {
+    kind: "fixable",
+    pr: 7,
+    reason: "gate:FIXABLE:merge-conflict",
+    prescription: "conflict",
+    holdObservation: { held: false }, // #390
+  });
   assert.equal(evaluated, false, "a conflicted head never spawns a paid engine-agent session");
   assert.equal(recorded.wal, null, "no WAL for a route that never reached identity/session");
   assert.equal(recorded.pin, null, "no attempt pin for a route that never reached the attempt-gate");
@@ -2229,7 +2235,7 @@ test("MergeDriver.driveOne (engine-agent, #460): prFixCap:0 escalates the confli
   const recorded: EARecorded = { pin: null, wal: null };
   const driver = new MergeDriver({ forge, reviewer, cfg });
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "needs-human", pr: 7, reason: "gate:HUMAN:merge-conflict" });
+  assert.deepEqual(outcome, { kind: "needs-human", pr: 7, reason: "gate:HUMAN:merge-conflict", holdObservation: { held: false } }); // #390
 });
 
 test("MergeDriver.driveOne (engine-agent, #460): produce-pr-and-stop reports FIXABLE without acting (same 'stopped' outcome the classic conflict route reuses)", async () => {
@@ -2464,7 +2470,7 @@ test("MergeDriver.driveOne (engine-agent, produce-pr-and-stop human-merge transi
   const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
   const driver = new MergeDriver({ forge, reviewer, cfg });
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
+  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } }); // #390
   assert.equal(evaluated, false, "MERGED short-circuits before the decisive-pin consume path is ever reached");
 });
 
@@ -2483,7 +2489,7 @@ test("MergeDriver.driveOne (engine-agent, produce-pr-and-stop human-merge transi
   const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
   const driver = new MergeDriver({ forge, reviewer, cfg });
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
+  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } }); // #390
   assert.equal(evaluated, false);
   assert.equal(recorded.pin, null);
   assert.equal(recorded.wal, null);
@@ -2497,7 +2503,12 @@ test("MergeDriver.driveOne (engine-agent): a COHERENT CLOSED-without-merge -> ne
   const recorded: EARecorded = { pin: null, wal: null };
   const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "needs-human", pr: 7, reason: "engine-agent: gate:HUMAN:pr-state-CLOSED" });
+  assert.deepEqual(outcome, {
+    kind: "needs-human",
+    pr: 7,
+    reason: "engine-agent: gate:HUMAN:pr-state-CLOSED",
+    holdObservation: { held: false }, // #390
+  });
 });
 
 test("MergeDriver.driveOne (engine-agent): split-state reads (status OPEN, review-data CLOSED) -> queued, never derives anything from a mixed pair", async () => {
@@ -2678,6 +2689,7 @@ test("MergeDriver.driveOne (engine-agent, #503): required check CONCLUDED FAILUR
     pr: 7,
     reason: "gate:FIXABLE:CI_RED:test@github-actions",
     prescription: "ci-red",
+    holdObservation: { held: false }, // #390
   });
   assert.equal(evaluated, false, "a red build never spawns a paid engine-agent session");
   assert.equal(recorded.wal, null);
@@ -2704,7 +2716,7 @@ test("MergeDriver.driveOne (engine-agent, #503): prFixCap:0 preserves the pre-#5
   const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg({ lanes: { prFixCap: 0 } }) });
   const recorded: EARecorded = { pin: null, wal: null };
   const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "gate-pending:ci-red-held" });
+  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "gate-pending:ci-red-held", holdObservation: { held: false } }); // #390
 });
 
 test("MergeDriver.driveOne (engine-agent, #503): produce-pr-and-stop reports FIXABLE:CI_RED without acting", async () => {
@@ -2727,19 +2739,8 @@ test("MergeDriver.driveOne (engine-agent, #503): produce-pr-and-stop reports FIX
 // but the conductor never saw a `holdObservation`, so `pr-held`/`pr-released` never fired and a
 // held PR was indistinguishable from "waiting on review" in persisted data. These pin the parity
 // on the OUTCOME side; conductor.test.ts's own #390 test pins the event side.
-//
-// THE FOUR PARITY TESTS BELOW ARE SKIPPED ON PURPOSE, and this is the whole reason:
-// `merge-driver.ts` is on docs/security.md's "Human-merge-only paths" list, so the producer that
-// wrote these tests cannot land the wiring they assert — it ships as a paste-ready diff in the PR
-// body for a human to apply. Applying that diff un-skips all four (its own hunks do it), updates
-// the seven existing exact-shape assertions above that now carry a `holdObservation`, and deletes
-// the gap-pin test at the end of this file. Until then the gap-pin test is what CI actually runs:
-// it asserts the CURRENT (broken) behavior, so this file states the defect in runnable form rather
-// than only describing it.
-
-test("MergeDriver.driveOne (engine-agent, #390): a HELD pass reports the hold observation in the label's ON-PR casing, and still never spawns a paid session", {
-  skip: "#390: un-skipped by the merge-driver.ts diff in this PR body — a producer cannot land that human-merge-only file",
-}, async () => {
+
+test("MergeDriver.driveOne (engine-agent, #390): a HELD pass reports the hold observation in the label's ON-PR casing, and still never spawns a paid session", async () => {
   const forge = new EngineAgentFakeForge();
   forge.reviewData = { ...forge.reviewData, labels: ["type:Bug", "Sapwood:Hold"] };
   let evaluated = false;
@@ -2762,9 +2763,7 @@ test("MergeDriver.driveOne (engine-agent, #390): a HELD pass reports the hold ob
   assert.equal(evaluated, false, "a held PR never spawns a paid engine-agent session");
 });
 
-test("MergeDriver.driveOne (engine-agent, #390): an UNHELD pass carries held:false — the release half of the pair, reported even on the terminal merged outcome", {
-  skip: "#390: un-skipped by the merge-driver.ts diff in this PR body — a producer cannot land that human-merge-only file",
-}, async () => {
+test("MergeDriver.driveOne (engine-agent, #390): an UNHELD pass carries held:false — the release half of the pair, reported even on the terminal merged outcome", async () => {
   const forge = new EngineAgentFakeForge();
   const reviewer = {
     kind: "engine-agent" as const,
@@ -2786,9 +2785,7 @@ test("MergeDriver.driveOne (engine-agent, #390): an UNHELD pass carries held:fal
   assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
 });
 
-test("MergeDriver.driveOne (engine-agent, #390): hold then release across two passes — the observation flips held:true -> held:false, which is what the conductor turns into pr-held/pr-released", {
-  skip: "#390: un-skipped by the merge-driver.ts diff in this PR body — a producer cannot land that human-merge-only file",
-}, async () => {
+test("MergeDriver.driveOne (engine-agent, #390): hold then release across two passes — the observation flips held:true -> held:false, which is what the conductor turns into pr-held/pr-released", async () => {
   const forge = new EngineAgentFakeForge();
   const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
   const cfg = mkEngineAgentCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["sapwood:hold"] } });
@@ -2805,9 +2802,7 @@ test("MergeDriver.driveOne (engine-agent, #390): hold then release across two pa
   assert.deepEqual(released.holdObservation, { held: false });
 });
 
-test("MergeDriver.driveOne (engine-agent, #390): with NO hold label configured the observation is held:false by construction — no extra PR read is spent to learn it", {
-  skip: "#390: un-skipped by the merge-driver.ts diff in this PR body — a producer cannot land that human-merge-only file",
-}, async () => {
+test("MergeDriver.driveOne (engine-agent, #390): with NO hold label configured the observation is held:false by construction — no extra PR read is spent to learn it", async () => {
   const forge = new EngineAgentFakeForge();
   forge.reviewData = { ...forge.reviewData, isDraft: true }; // any early preflight queue will do
   const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
@@ -2822,23 +2817,3 @@ test("MergeDriver.driveOne (engine-agent, #390): with NO hold label configured t
     "only the drive pipeline's own PR-data read — the observation costs nothing when no hold label is configured",
   );
 });
-
-// ── #390 gap pin: what CI runs TODAY, until the human applies this PR's merge-driver.ts diff ──
-// The four tests above are the target behavior and are skipped; this one is the red half, kept
-// runnable so the defect is a CI-observable fact rather than a claim in an issue body. The diff
-// DELETES this test in the same hunk that un-skips the others — the two states are mutually
-// exclusive by construction, so neither can be left half-applied silently.
-test("MergeDriver.driveOne (engine-agent, #390 gap): an engine-agent pass carries NO hold observation, so the conductor can never emit pr-held for a held engine-agent lane", async () => {
-  const forge = new EngineAgentFakeForge();
-  forge.reviewData = { ...forge.reviewData, labels: ["Sapwood:Hold"] };
-  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
-  const cfg = mkEngineAgentCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["sapwood:hold"] } });
-  const recorded: EARecorded = { pin: null, wal: null };
-  const driver = new MergeDriver({ forge, reviewer, cfg });
-  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
-  // The GATE is correct — the hold is honored (queued/WAIT, no paid session). Only the visibility
-  // signal is missing, which is exactly the scope of #390.
-  assert.equal(outcome.kind, "queued");
-  assert.match((outcome as { reason: string }).reason, /hold-label-present/);
-  assert.equal(outcome.holdObservation, undefined);
-});
```
