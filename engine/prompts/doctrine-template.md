<!--
  sapwood review doctrine (#167) — repo-level review knowledge the loop carries forward across
  rounds, instead of it living only in a human/conductor's memory and evaporating. Read by the
  worker dispatch brief and the architect pass every round, and cited by the gated-reentry
  escalation comment when automatic fix attempts are exhausted.

  Configured as `doctrine.file` in sapwood.config.yaml (default: docs/REVIEW-DOCTRINE.md).
  Absent entirely -> the loop proceeds with an explicit 'none' placeholder, behavior unchanged
  (this file is optional, unlike the north-star goal file).

  This file was scaffolded because none existed yet. It ships with the review doctrine distilled
  from the 2026-07-13 M5 wave-3 session (11 PRs, 20+ verified findings) — edit it as this repo's
  own review history accumulates its own recurring findings and adjudication calls. Deliberately
  PROSE, not a lint/DSL: these are judgment rules for an LLM reviewer, not machine-checkable
  patterns.
-->

# Review doctrine

Two kinds of content: technical invariants this repo's review history has already flagged more
than once, and doctrine for how the loop should treat review findings in general.

## Technical invariants

Recurring failure classes, stated as judgment rules for LLM reviewers — deliberately NOT a
lint/DSL, since spotting a violation requires reading design intent, not matching a pattern.

- **Disabled-consumer rule.** Any "is there work?" probe/signal must be gated on whether the
  role that consumes it is enabled/present. An unconsumable signal pins the probe true forever,
  defeats standby, and burns peripheral sessions on work nothing will ever read.
- **Same-tick window rule.** `tick()` reclaims before it dispatches. Any ledger-read dispatch
  gate must be a thunk evaluated post-reclaim, inside `tick()` itself — never a pre-tick scalar
  snapshot, and never a post-tick check that races the same tick's own reclaim.
- **Crash-rerun set.** Persist state before any terminal transition. Use id cursors, not
  timestamps, for resumable reads. A resumed drain must never re-dispatch what an earlier attempt
  already dispatched. Reruns must be idempotent — update-in-place, never a counter derived from
  how many times a probe happened to run.

## Adjudication doctrine

How the loop treats review findings (distilled CTO guidance, 2026-07-13, verbatim principles):

1. **Review findings are INPUTS, not truth.** Judge each finding against reality before acting;
   reject low-ROI or misdirecting findings WITH recorded reasons rather than applying every
   finding mechanically.
2. **A recurring finding class belongs at the DESIGN SOURCE.** When the same class of finding
   keeps coming back, rethink the approach or technical direction — don't keep chasing
   per-finding patches downward, round after round.
3. **A reviewer's angle can be wrong.** Divergence between the reviewer's read and the author's
   is signal for adjudication, not automatic compliance — weigh it, don't just apply it.
4. **Runaway complexity escalates to the top of the loop, not more patches.** When a feature's
   implementation effort turns counterintuitive or runaway-complex, re-examine the feature's
   design/technical direction (architect/plan re-review) instead of grinding through more fix
   rounds. The nearest mechanism today is the fix-round cap escalating to a human — but the
   doctrine names DESIGN RE-ENTRY, not just human escalation, as the intended response.
