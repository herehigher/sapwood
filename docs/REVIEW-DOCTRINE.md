<!--
  sapwood review doctrine (#167) — repo-level review knowledge carried forward across rounds
  instead of living only in a human/conductor's memory. Read by the worker dispatch brief and
  the architect pass every round; cited by the gated-reentry escalation comment when automatic
  fix attempts are exhausted.

  Configured as `doctrine.file` in sapwood.config.yaml (default: docs/REVIEW-DOCTRINE.md).
  Absent entirely -> the loop proceeds with an explicit 'none' placeholder (this file is
  optional, unlike the north-star goal file). Budget: `doctrine.maxChars` (20000, #411's
  no-silent-truncation test) — this file must stay comfortably under that.

  Deliberately PROSE, not a lint/DSL: these are judgment rules for an LLM reviewer, not
  machine-checkable patterns. Maintain by editing as this repo's review history accumulates new
  recurring findings and adjudication calls — and by cutting what a mechanism (a guard rule, a
  pinned test, a schema) has since taken over, so the same rule is never carried in both places
  at once.

  Curation rule (#838): this file is a fixed-size cache, not a log — the budget is the design,
  and hitting it is a curation signal, never a reason to compress a new rule into telegram style.
  Above ~85% of `doctrine.maxChars`, an addition must evict or merge at least as much as it adds
  (one-in-one-out). A new rule joins an existing family/sub-case structure where one fits (see the
  test-realism family) rather than opening a new top-level bullet. Incident narrative is banned —
  a distilled worked example is not narrative: keep an example only for the discriminating
  criterion it carries (what to look at, what decides); the blow-by-blow story lives in the
  issue/PR its bare anchor (#NNN) points to. Mechanism claims cite symbols/files, never line ranges
  (they rot).
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

### Engine lifecycle & safety

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
  both drain paths (graceful handoff and hard escalation): what does this mechanism do while that
  layer is active, and what does that layer's firing do to this mechanism's state? (#168: paid
  probes running past a breached ceiling, and drains falsely clearing or permanently wedging a
  canary episode, were both misses of exactly this cross-product.)
- **Unwired-function rule.** A shipped recovery/cleanup function with zero production callers is
  a defect, not a reserve: verify every new cleanup, resume, or clear entry point has a live
  caller on the path that needs it. (Recurring class: `supervisor.resume()` in #172,
  `clearEscalationMarker()` in #168's first round.)

### Is this test real?

- **No timing-dependent assertions.** BANNED: an assertion whose pass/fail is decided by a close
  race between uncontrolled real operations — real work vs. a real timer, no seam controlling
  either side. This class has reddened `main` three times (#403, #416). For a LOAD-BEARING race,
  the fix is always a seam: inject a fake clock/collaborator, or a fast, deterministic, selectively
  self-terminating fake (PR #418's fake-git shim — hangs only on the operation under test, `exec`s
  the real binary for everything else). FINE, and not the same failure class: an outer hang-guard
  bounding catastrophe rather than deciding the test's verdict, or a real passthrough timed against
  a generous, documented, non-load-bearing margin — PR #418's `REAL_OP_TIMEOUT_MS` is the worked
  example: widened 500ms→1000ms (#418 round 3), then 1000ms→3000ms (#403, under measured
  contention) — each widen stated in-code as measured-cost < margin < guard-ceiling, not chosen by
  feel. A red PR that passes on its own branch but reds on `main` under the same runner is a strong
  BANNED-shape signal. Ask: does the verdict depend on which of two uncontrolled real operations
  finishes first? If yes, it needs a seam; if it's a documented backstop around a deterministic
  fake or bounded passthrough, it is compliant.
- **Test-realism family — prove it against the real thing, not a stand-in for it.** Three variants
  of one failure: an assertion that looks like it proves an acceptance criterion but actually
  proves something else — a copied constant, a fixture's own preset, or an isolated unit — never
  engaging the production path the AC is actually about.
  - **VALUE (model the real thing, not a convenient proxy).** Failure class: DRIFT RISK — a test
    constant that silently duplicates a value the repo already defines elsewhere (a CSS rule, a
    cap constant), with nothing tying the two together, so they can silently diverge while the
    test stays green. Rule: read the value from its source, or pin the two together with an
    assertion that fails the moment they disagree. This does NOT require asserting against real
    rendered DOM in general — the default dashboard harness is DOM-free
    (docs/dev-guide/07-dashboard.md). Worked example: `textBox()`/`CHAR_ADVANCE` in
    `dashboard/src/hero/hero.test.ts` turns font-size and character count into a rendered extent
    without a browser, tied to the same inputs the real draw path uses, plus a cascade/source-order
    assertion pinning declaration order instead of hand-copying which rule wins. Two shapes seen
    (#353, PR #738 (issue #728), PR #737): (1) the test computes its expected value outside the
    thing it's testing instead of reading/pinning it against the real source; (2) the test
    exercises only the easy/nominal instance while the AC's own wording names a combinatorial or
    boundary case it never constructs. FINE: a literal that IS the specification — a golden value
    nothing else in the codebase claims to own.
  - **DECISION (fake-verdict rule, engine side).** Presetting a fake collaborator to already
    return the acceptance criterion's target decision, then asserting against the fake's own
    canned value, proves only that the fake echoes what it was told — the real policy function
    that is supposed to decide that value never runs. Sibling of VALUE above but distinct: VALUE
    is a copied constant drifting from its source; DECISION is the deciding code path never
    executing at all. Worked example: PR #835 (issue #824)'s `ac1`/`ac2` fixtures preset
    `FakeSupervisor.reclaimResults` straight to the AC's target `worktreeRetained` value with no
    baseline ever established, so `WorkerSupervisor.reclaim`'s real mtime/ctime policy never ran;
    fixed by building a real fixture (real directory, real `dispatched_at`, a real post-baseline
    write) and letting production decide. If the fake's return value IS the fact the AC asks to
    prove, the deciding code never ran — run the real function instead.
  - **WIRING (unwired-test rule).** A dashboard test that renders an extracted pure function, a
    bare component, or a hook in isolation proves that piece correct alone — it does not prove
    the app wires it up. Recurring class (#759, #766): a helper/component test stayed green while
    the real app tree never called the helper, called it with the wrong data source, or dropped
    the prop between wrapper and consumer. Any new dashboard rendered-UI behavior needs at least
    one test rendering today's real entry points (e.g. `App`/`appContent`, or the smallest real
    ancestor owning the wiring) with distinguishable fixture values at the seam under test — not
    only a unit test of the extracted piece; ACs with no render path (server routes, pure modules)
    are outside this rule. Distinct from VALUE above: that sub-case governs which VALUE an
    assertion checks, this one governs which TREE produces it.
    **Data-flow sub-shape (#866, #868), one level up the stack.** Rendering the real entry point
    isn't enough if its props are still hand-assembled or its state hand-constructed into a
    combination the real derivation could never itself produce — mount with real
    prefetched/settled queries and a stubbed `fetch` instead, over a fixture that builds the AC's
    named boundary/adversarial case, not just the nominal one. `docs/dev-guide/07-dashboard.md`'s
    `registerRealDom()` solved this for CLICK wiring (retro #355); QUERY/data-flow wiring has no
    equivalent shared helper yet — cite one here once a PR extracts it.

### Documentation claims

- **Doc-claim grounding rule.** Ground every behavioral/guarantee claim in a doc change in the
  exact function/branch it describes, not a plausible generalization from a partial read. A
  fallible operation (delete, prune) is best-effort unless the code checks and reports the
  outcome; a policy specific to one call path isn't generalized to every lane in that state when
  another path (e.g. a human-merge-only exception) handles it differently. A documented procedure
  or recipe is itself a claim: either it has actually been run, or it isn't asserted as working. A
  docs-only PR has no test suite to catch a false claim the way code does, so name the exact
  symbol/branch backing a claim rather than writing it from memory of "roughly how it works"
  (#854, #700).

### Signal classification & escalation

- **Authoritative signals over inferred text.** Bind detection and classification to a structured
  signal first — an API status field, exit code, typed event. Formats this project defines and
  parses fail-closed are contracts, not text matching, even when they travel as text (e.g. a
  worker's own structured result record). Only genuinely uncontrolled free text is last-resort:
  match narrow, signature-shaped patterns, never a wildcard, and name which failure direction the
  choice favors. Worked example: `classifyEnvFailure` (`engine/src/loop/env-failure.ts`) checks
  two structured, provider-authoritative signals first (a rejected `rate_limit_event`, an errored
  result carrying `api_error_status:429`) before falling back to the enumerated pattern list
  (`DEFAULT_LLM_FAILURE_PATTERNS`). The two failure directions are NOT symmetric: a too-wide
  pattern gives a false POSITIVE that halts a healthy engine immediately and visibly; a too-narrow
  list gives a false NEGATIVE that — per `DEFAULT_LLM_FAILURE_PATTERNS`'s own accounting — the
  empty-spin breaker bounds on the peripheral-role path, but nothing in the classifier bounds on
  the dispatched-WORKER-lane path; only the OUTER safety ceiling (`cost.roundBudgetUsd`/
  `dailyBudgetUsd`) contains a recurring miss there. Prefer narrow anyway, naming that outer-layer
  dependency explicitly rather than calling a miss self-bounded. State the residual blind spot
  honestly (a genuinely narrow gap, not zero) rather than claiming full coverage.
- **Doctrine self-modification rule.** A PR that modifies this review-doctrine file itself must
  be prominently flagged in review, with a recommendation to route it needs-human rather than
  auto-merge. The reviewer applies the doctrine loaded at engine construction, never the version
  on the PR's branch — the change cannot influence the doctrine used for its own review, but it
  can still pass under the prior rules, so a human should confirm rule changes. This file is
  deliberately NOT guard-protected (docs/security.md) — this prose IS the enforcement.
- **A tier-C cannot-confirm is not a producer stall signal** (round #368 retro, PR #791).
  `docs/security.md`'s evidence tiers make tier-C (human-witnessed probe) evidence
  producer-unforgeable BY DESIGN — the producer never self-executes or self-attests it. When a
  criterion's only remaining gap is a missing tier-C RECORD — every other clause and sub-fact
  already confirmed — no fix round can close it; only the operator posting the record can. It is
  correct for that criterion to stay `cannot-confirm` and the PR to stay unmerged — do not weaken
  the gate. But say so explicitly in the finding's body (name the AC, name the gap as
  operator-owned, not producer-owned) rather than writing it identically to a producer-fixable
  gap: an unlabeled operator-owned gap reads exactly like a producer failure to the convergence
  classifier (`review/convergence.ts`) and to any human reading the thread.
- **A fully operator-owned rejection still pays for a fix leg it cannot use** — residual gap in
  the rule above. Labeling a tier-C gap `operator-owned` changes what the finding SAYS, not what
  `driveDecision` (`conductor.ts`) DOES: the gate stays `FIXABLE`, so — where ordinary
  scheduling/admission conditions permit a leg at all — a paid one still dispatches with nothing
  producer-actionable to fix, disputes, and escalates `needs-human` — spend that buys
  no information either way the operator later rules. Today's only lever is that labeling itself,
  in the finding's BODY prose; a STRUCTURED per-finding owner tag letting `driveDecision` route an
  all-operator-owned verdict straight to `ESCALATE` (mixed verdicts still get `FIXUP` for their
  producer-fixable share) is #865's code fix, not something the current finding schema
  (id/body/severity/kind/path) can carry. Grounding: `docs/security.md`'s AC-evidence-tier
  doctrine (Decision #8, `docs/PLAN.md`) and its Cost ceiling constraint. (#857, #862, #863)

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

## Prompt architecture doctrine (#699)

Three governing principles for what belongs in a role's SHIPPED PROMPT TEXT
(`engine/prompts/*.md`), owner ruling 2026-08-06. Standing test for gate② on any prompt-touching
PR; apply clause-by-clause, not file-by-file. Worked example:
`docs/design/699-prompt-architecture-audit.md`.

1. **A — legitimate content.** Role definition, duties, scope, goals, deliverables, norms,
   constraints. That is the whole legitimate surface.
2. **B — judgment preemption.** Content that substitutes for the LLM's judgment — a pre-baked
   conclusion, a verdict-steering assertion, a claim-shaped statement the model should derive
   from evidence instead. Disposition: delete, or rewrite as a judgment-preserving
   goal/constraint.
3. **C — machinery in prose.** A deterministic check/flow/value the engine, config, schema, or
   guard could enforce (or already does — a drifting duplicate). Disposition: name the target
   carrier and file a follow-up to move it there — never "fix" by rewording.

**Q3 safety-floor exception.** A rule whose omission produces unsafe output (the AC-evidence-tier
floor; the human-merge-only-paths enumeration) stays prompt-resident even where a pull-model
channel — `engine/src/roles/skills-plugin.ts`'s (#639/#640) on-demand skill serving the same
`docs/security.md` content — also exists: a session must actively invoke a skill, so it is never
a load-bearing substitute for content that must be unconditionally seen. Where principle 3
collides with a floor like this, record the tension and the proposed carrier instead of
deleting — a mechanically-pinned mirror-pair test against the canonical source
(`engine/src/roles/prompts.test.ts`'s `#628`/`#653` tests) is the shipped answer when a floor has
more than one hand-maintained carrier.
