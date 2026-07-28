<!--
  sapwood review doctrine (#167) — repo-level review knowledge the loop carries forward across
  rounds, instead of it living only in a human/conductor's memory and evaporating. Read by the
  worker dispatch brief and the architect pass every round, and cited by the gated-reentry
  escalation comment when automatic fix attempts are exhausted.

  Configured as `doctrine.file` in sapwood.config.yaml (default: docs/REVIEW-DOCTRINE.md).
  Absent entirely -> the loop proceeds with an explicit 'none' placeholder, behavior unchanged
  (this file is optional, unlike the north-star goal file).

  This is sapwood's OWN repo-level doctrine (#411), not the shipped scaffold — `sapwood init`
  writes engine/prompts/doctrine-template.md into a NEW user's repo iff no doctrine file exists
  yet; this repo predates that path, so the channel had never actually been turned on here (every
  worker dispatch, architect pass, and gated-reentry escalation ran with no doctrine at all until
  #411). Seeded from engine/prompts/doctrine-template.md as of #409/PR#414 (the six technical
  invariants + four adjudication principles distilled from the 2026-07-13 M5 wave-3 session, plus
  the authoritative-signals-over-inferred-text and doctrine-self-modification rules added since),
  with two further invariants this repo has earned since: authoritative signals over inferred
  text, enriched with the specific reasoning from engine/src/loop/env-failure.ts:31-91, and no
  timing-dependent assertions (the class that reddened main three times, most recently #416).
  Maintain this file the same way the template says to maintain its own: edit it as this repo's
  review history accumulates its own recurring findings and adjudication calls. Deliberately
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
- **Safety-layer cross-check rule.** Any new engine state machine or dispatch path must be
  reviewed against each existing safety layer — kill switch, pause, cost/wall-clock ceiling, and
  both drain paths (graceful handoff and hard escalation) — one at a time: what does this
  mechanism do while that layer is active, and what does that layer's firing do to this
  mechanism's state? (From #168: paid probes running past a breached ceiling, and drains either
  falsely clearing or permanently wedging a canary episode, were all misses of exactly this
  cross-product.)
- **Unwired-function rule.** A shipped recovery/cleanup function with zero production callers is
  a defect, not a reserve: verify every new cleanup, resume, or clear entry point has a live
  caller on the path that needs it. (Recurring class: `supervisor.resume()` in #172,
  `clearEscalationMarker()` in #168's first round.)
- **Authoritative signals over inferred text.** Detection and classification bind to a structured
  signal first — an API status field, an exit code, a typed event. Formats this project defines
  and parses fail-closed are contracts, not text matching: a payload this codebase itself
  produces and rejects on malformed input (e.g. a worker's own structured result record) is
  authoritative like a provider signal, not "inferred text," even though it happens to be
  serialized as text on the wire. When only uncontrolled free text is available — output neither
  this project nor the upstream provider guarantees a shape for — treat it as last resort only:
  enumerate specific, signature-shaped patterns rather than reaching for a wildcard, and name
  which failure direction the choice favors. This project's own environment-failure classifier
  (`engine/src/loop/env-failure.ts:31-91`) is the worked example: it checks two structured,
  provider-authoritative signals first (a rejected `rate_limit_event`, an errored result carrying
  `api_error_status:429`) and falls back to an enumerated text-pattern list only when both are
  absent — deliberately narrow, not a `hit your \S+ limit` wildcard, because the two failure
  directions are NOT symmetric: a too-narrow pattern list produces a false NEGATIVE (misses a
  real signal — costs money, bounded and recoverable), while a too-wide pattern produces a false
  POSITIVE (fires on an unrelated failure — halts a healthy system, worse). When a reviewer is
  choosing between widening a match or narrowing it, name which of these two failure directions
  the change trades toward, and prefer the narrower one by default. State the residual blind spot
  honestly rather than claiming full coverage: even with structured signals checked first, a
  failure that clears every structured check AND uses unlisted wording still goes unclassified —
  a genuinely narrow gap, not zero, and the doctrine here is to say so rather than overclaim.
- **No timing-dependent assertions.** A test must never depend on a real timer, subprocess speed,
  or scheduler/OS ordering to pass — this class has reddened `main` three separate times,
  including twice on the same day (#403; most recently #416, PR #418). The fix is always removing
  the dependence, never widening the margin: inject a fake clock/collaborator at the seam the code
  already has (or add one), replace a real subprocess with a fast, deterministic, selectively
  self-terminating fake (PR #418's fake-git shim — a stand-in that returns control on the exact
  condition the test needs, not a sleep-then-check race) rather than asserting against real
  wall-clock elapsed time. A red PR that passed on its own branch but reds on `main` under the
  same CI runner is a strong signal this class is in play. When reviewing a new test, ask whether
  it would still pass on a machine ten times slower or faster — if the answer depends on actual
  elapsed time, subprocess scheduling, or which of two concurrent operations happens to finish
  first, the test needs a seam, not a bigger margin.
- **Doctrine self-modification rule.** A PR that modifies this review-doctrine file itself must
  be prominently flagged in review, with a recommendation to route it needs-human rather than
  auto-merge. The reviewer applies the doctrine loaded at engine construction, never the version
  on the PR's branch — the change cannot influence the doctrine used for its own review, but it
  can still pass under the prior rules, so a human should confirm rule changes.

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
