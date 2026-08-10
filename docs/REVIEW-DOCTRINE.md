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
- **Model the real thing, not a convenient proxy.** The failure class is DRIFT RISK, not
  "unreality": a test constant that silently duplicates a value the repo already defines
  elsewhere — a CSS rule, a cap constant — with nothing tying the two together, so the two can
  silently diverge the moment the real source changes and the test stays green regardless. The
  rule: read the value from its source, or pin the two together with an assertion that fails the
  moment they disagree. This does NOT require asserting against "the real computed style after
  cascade" or "real rendered bounding extents" in general — the default harness is DOM-free (real
  DOM is opt-in per test file, see docs/dev-guide/07-dashboard.md). This repo's own accepted
  remediation is a deterministic model plus a pinning assertion, not a live render: `textBox()`/
  `CHAR_ADVANCE` in dashboard/src/hero/hero.test.ts turns each element's font-size and character
  count into a rendered extent without a browser, tied to the same inputs the real draw path
  uses, and the cascade/source-order assertion in hero.test.ts pins `.hero-small`'s declaration
  order against every 9px caption rule instead of hand-copying which one wins. Evidence bar:
  three instances across two issues, one round (#353) — two shapes
  seen so far, not a closed list. (1) the test computes its expected value outside the thing it's
  testing (a hand-picked font-size, a center-point distance) instead of reading it from, or
  pinning it against, the source that actually decides it — PR #738 (issue #728)'s
  `hero-small`/`hero-outcome-tally` CSS-cascade reorder left the actual computed size at 10px
  while the overlap test still modeled 9px, and stayed green until a reviewer read the cascade by
  hand; the same PR's first round modeled overlap from element *centers* rather than the
  elements' actual rendered extents, so a wider label or a longer multi-digit tally could pass
  every assertion while visually colliding. (2) the test exercises only the easy/nominal instance
  of a rule while the AC's own wording names a combinatorial or boundary case it never constructs
  — PR #737's render-cap test used a single pinned row, so an over-cap or aged-out pin (the exact
  case the AC's "showing latest N of M" disclosure exists for) was never exercised. When an AC's
  claim is about geometry, a rendered count, or a boundary condition, trace the value to what
  actually decides it and either read it from there or pin the two together — never hand-copy a
  value that already lives somewhere else in the codebase.

  FINE, and NOT the same failure class: a literal that IS the specification — a golden value the
  test exists to pin down, with nothing else in the codebase claiming to own it — is fine. A
  literal that restates a value the codebase already owns elsewhere, untied to that source, is
  the defect, regardless of whether the value happens to be correct today. `textBox()`/
  `CHAR_ADVANCE` is the worked example of a compliant deterministic model: it substitutes for a
  live render, but every input it consumes (font-size, character count) is the same value the
  real draw path consumes, so it cannot silently diverge from what actually gets drawn.
- **Unwired-test rule.** A dashboard test that renders an extracted pure function, a bare
  component with hand-built props, or a query/hook in isolation proves that piece is correct in
  isolation — it does not prove the app actually wires it up. Recurring class across #759 and
  three consecutive review rounds of #766 (`round-tally-uses-nonexistent-field`,
  `live-only-test-does-not-cover-app-wiring`, `replay-spend-panel-wiring-unexercised`,
  `rounds-api-wiring-unexercised`, and others): a helper/component test stayed green while the
  real `App`/`appContent` tree either never called the helper, called it with the wrong data
  source, or dropped the prop on the floor between the wrapper and the real consumer. Any new
  dashboard behavior described by an acceptance criterion needs at least one test that renders
  the real `appContent`/`App` tree (or the smallest real ancestor that actually owns the wiring)
  with distinguishable fixture values at the seam under test — not only a unit test of the
  extracted piece. Extracted-function/component unit tests are still worth keeping alongside for
  their own edge cases; they just don't substitute for the wiring assertion.
- **Doctrine self-modification rule.** A PR that modifies this review-doctrine file itself must
  be prominently flagged in review, with a recommendation to route it needs-human rather than
  auto-merge. The reviewer applies the doctrine loaded at engine construction, never the version
  on the PR's branch — the change cannot influence the doctrine used for its own review, but it
  can still pass under the prior rules, so a human should confirm rule changes.
- **A tier-C cannot-confirm is not a producer stall signal (round #368 retro finding, PR #791).**
  `docs/security.md`'s evidence tiers make tier-C (human-witnessed probe) evidence
  producer-unforgeable BY DESIGN: "the producer never self-executes or self-attests it." When a
  criterion's only remaining gap is a missing tier-C probe RECORD on the issue — every other
  clause, and every CI/engine-checkable sub-fact decomposed out of the probe, already
  `confirmed`/`claim-accepted` — that gap cannot be closed by another fix round; only the operator
  posting the record closes it. It is correct for that criterion to stay `cannot-confirm` and for
  the PR to stay unmerged until the record lands — do not weaken that gate. But say so explicitly
  in the finding's body (name the AC, name that the remaining gap is operator-owned, not
  producer-owned) rather than writing it identically to a producer-fixable gap. PR #791 spent four
  engine-agent review rounds where an operator-owned tier-C gap sat alongside genuinely
  producer-fixable findings; the PO's own adjudication comment on that PR had to state after the
  fact that "the fix leg should NOT attempt to fabricate [the probe] ... and should treat AC3's
  probe row as out of its scope" — the review itself never said this, so nothing distinguished
  "still buggy, fix again" from "code is done, waiting on a human" in the record the convergence
  classifier (`review/convergence.ts`) and any human reading the thread had to work from. An
  unlabeled operator-owned gap reads exactly like a producer failure to a mechanism, or a
  reader, deciding whether a lane is still making progress — worth naming honestly at the point
  the finding is written, rather than leaving it to be reconstructed later from PO comments.

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
