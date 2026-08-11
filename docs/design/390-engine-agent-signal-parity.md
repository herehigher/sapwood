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
  `engine/src/loop/conductor.test.ts`), committed skipped pending the wiring below.
- **Landed (#788), via PR #814:** the wiring in `engine/src/roles/merge-driver.ts` — `holdFrom`
  (the shared hold-observation computation), `engineAgentHold` (the live-read fallback for
  outcomes with no PR data of their own), and `driveEngineAgentOne`'s split into a signal wrapper
  plus the unchanged `gateEngineAgentOutcome` gate half. Applied by this commit (PR #814's branch
  dies on merge; the squash SHA that lands it is recorded on issue #788 at merge time). The patch
  had to be rebased by hand against #782's `ciPendingObservation`/`ciPendingEscalation` wiring,
  which landed in `merge-driver.ts` after this appendix was originally authored against PR #517's
  tip — both signal families are preserved, and `merge-driver.ts`'s own module header now states
  the full current coverage (`holdObservation` + `reviewerTransition` + `reviewSilenceEscalation`
  + `ciPendingObservation`) rather than #390's original stale "ciPendingObservation stays
  classic-only" claim. All four previously-skipped parity tests in `merge-driver.test.ts` now run
  and pass; the `#390 gap` pin (asserting `holdObservation === undefined`) is deleted.

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

Re-open this if the engine-agent path ever grows a fallback lock. `merge-driver.ts`'s own module
header now carries this decision, so the file no longer claims a deviation it does not have.

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
  - The zero-extra-read alternative — returning the already-fetched `data0.labels` from
    `EngineAgentDriveOutcome` in `review/drive.ts` — was left out of the #788 landing to respect
    #390's stated scope (a change in a second production file). It would be a drop-in replacement
    for the `engineAgentHold` body if a future change wants to spend it.

## Verification

This design's diff was originally verified against a scratch copy of the tree (never against the
protected file in this repo — see the history below), before #782 landed and required a hand
rebase (see `## Status`); the numbers below are that original scratch-tree run, kept as the
historical record of why the design was trusted enough to ship as an appendix:

- **with the patch applied:** `merge-driver.test.ts` 145 pass / 0 fail / 0 skipped; full engine
  suite **3665 pass / 0 fail**; `tsc` typecheck clean; `biome ci` clean.
- **as committed (patch not applied):** full engine suite 3661 pass / 0 fail / 6 skipped — four
  of those skips are #390's parity tests, waiting on the patch.
- `git apply --check` against PR #517's tip: clean.

The four parity tests were committed **skipped** because a producer could not land the code they
assert, not because they were aspirational. Applying the (rebased) wiring un-skipped all four,
updated every existing exact-shape assertion that then carries a `holdObservation`, and **deleted
the `#390 gap` test** — the test that used to run asserting the then-current, broken, absent
observation. Before and after were mutually exclusive by construction, so the change could not be
left half-applied silently. The actual #788 landing (post-#782 rebase) runs the full
`merge-driver.test.ts` at 166 pass / 0 fail / 0 skipped and the full engine suite at 4735 pass /
0 fail — higher than the scratch-tree counts above because #782 (and other work) added tests of
its own in the interim; see PR #814 for that run's own numbers.
