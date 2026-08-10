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

**Carrier split (#434).** This file governs the **engine's own** reviewer; standing
review-*discipline* rules for the **external** review bot live in the repo-root
[`AGENTS.md`](../AGENTS.md), which that bot reads directly, and per-PR context stays in the
verification plan appended to the review-request comment. The three carriers deliberately do not
restate each other — a rule belongs to exactly one of them.

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
  directions are NOT symmetric in kind, not just in size: a too-wide pattern produces a false
  POSITIVE that fires immediately and visibly on an unrelated failure, halting a healthy,
  unaffected engine. A too-narrow pattern list produces a false NEGATIVE (misses a real signal)
  whose worst case is NOT locally bounded — `env-failure.ts:93-104` states this honestly rather
  than overclaiming: on the peripheral-role path a miss still eventually trips the empty-spin
  breaker, but on the dispatched-WORKER-lane path nothing in the classifier itself stops the SAME
  unclassified failure text from recurring on every subsequently dispatched issue; only the
  engine's own OUTER safety ceiling (`cost.roundBudgetUsd` / `dailyBudgetUsd`), not anything in
  this file, bounds that recurring spend. Prefer the narrower pattern list anyway — an immediate,
  engine-halting false positive is worse than a false negative whose worst case is contained by
  an outer layer — but name that outer-layer dependency explicitly rather than calling a false
  negative "bounded" on its own account. When a reviewer is choosing between widening a match or
  narrowing it, name which of these two failure directions the change trades toward. State the
  residual blind spot honestly rather than claiming full coverage: even with structured signals
  checked first, a failure that clears every structured check AND uses unlisted wording still
  goes unclassified — a genuinely narrow gap, not zero, and the doctrine here is to say so rather
  than overclaim.
- **No timing-dependent assertions.** BANNED: an assertion whose PASS/FAIL outcome is decided by
  a close race between uncontrolled real operations — real work vs. a real timer, a single winner
  asserted, with no seam controlling either side. This class has reddened `main` three separate
  times, including twice on the same day (#403; most recently #416). For a LOAD-BEARING race —
  one where the timing decides the actual behavior under test — the fix is always a seam, never a
  bigger margin: inject a fake clock/collaborator at the seam the code already has (or add one),
  or replace a real subprocess with a fast, deterministic, selectively self-terminating fake (PR
  #418's fake-git shim — hangs ONLY on the specific operation under test, `exec`s the real binary
  for everything else, so a timeout signal lands directly on the process actually sleeping, no
  orphan possible) rather than asserting against real wall-clock elapsed time.

  FINE, and NOT the same failure class: an outer hang-guard whose only job is bounding
  catastrophe (a wedged process reaching the test-runner's own ceiling) rather than deciding the
  test's pass/fail outcome; a real, bounded passthrough operation timed against a generous,
  documented, non-load-bearing margin. PR #418 round 3's `REAL_OP_TIMEOUT_MS` 500ms->1000ms widen
  is the worked example of doing this correctly: the margin sits ~20-60x above the measured real
  op cost and ~20x below the fake shim's sleep, and that ordering (measured cost < margin < guard
  ceiling) is stated in the code as the reason for the number, not chosen by feel. A red PR that
  passed on its own branch but reds on `main` under the same CI runner is a strong signal the
  BANNED shape, not the FINE one, is in play. When reviewing a new test with a timing element,
  ask: does the test's verdict itself depend on which of two uncontrolled real operations finishes
  first? If yes, it needs a seam. If the timing is only a generous, documented backstop around a
  deterministic fake or a bounded real passthrough, it is doctrine-compliant as written.
- **Model the real thing, not a convenient proxy.** A test that encodes an acceptance criterion
  must assert against the value the runtime actually produces — the real computed style after
  cascade, the real rendered bounding extents, the real count after every filtering/capping rule
  — never a value the test additionally models or assumes alongside the system under test. Two
  failure shapes recur, both from round #353: (1) the test computes its expected value outside
  the thing it's testing (a hand-picked font-size, a center-point distance) instead of reading it
  from the actual render/computed style, so the two silently diverge the moment the real source
  changes — PR #728's `hero-small`/`hero-outcome-tally` CSS-cascade reorder left the actual
  computed size at 10px while the overlap test still modeled 9px, and stayed green until a
  reviewer read the cascade by hand; the same PR's first round modeled overlap from element
  *centers* rather than the elements' actual rendered extents, so a wider label or a longer
  multi-digit tally could pass every assertion while visually colliding. (2) the test exercises
  only the easy/nominal instance of a rule while the AC's own wording names a combinatorial or
  boundary case it never constructs — PR #737's render-cap test used a single pinned row, so an
  over-cap or aged-out pin (the exact case the AC's "showing latest N of M" disclosure exists
  for) was never exercised. When an AC's claim is about geometry, a rendered count, or a boundary
  condition, assert it from the actual rendered/computed output at that boundary, not from a
  value modeled alongside it.
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
