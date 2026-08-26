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

**Carrier split.** This file carries this repository's review doctrine; the engine substitutes it
into the engine-agent review session and, in hosted-bot mode, appends it to the review-request
comment (the `same-model-trusted` and `human` modes post no trigger, so nothing carries it to
those reviewers). Standing review-round discipline for a hosted bot lives in that bot's own
instruction file — see
[Hosted-bot review guidelines](guide/configuration.md#hosted-bot-review-guidelines); per-PR
verification, diff scope, and reviewed-head identity travel in the review-request comment. Keep
each rule in one carrier.

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
  layer is active, and what does that layer's firing do to this mechanism's state? (#168.)
- **Unwired-function rule.** A shipped recovery/cleanup function with zero production callers is
  a defect, not a reserve: verify every new cleanup, resume, or clear entry point has a live
  caller on the path that needs it. (#172, #168.)

### Is this test real?

- **No timing-dependent assertions.** BANNED: an assertion whose pass/fail is decided by a close
  race between uncontrolled real operations — real work vs. a real timer, no seam controlling
  either side. Reddened `main` three times (#403, #416). For a LOAD-BEARING race, the fix is a
  seam: a fake clock/collaborator, or a fast, deterministic, selectively self-terminating fake
  (PR #418's fake-git shim). FINE: an outer hang-guard bounding catastrophe rather than deciding
  the verdict, or a real passthrough timed against a generous, documented, non-load-bearing
  margin — PR #418's `REAL_OP_TIMEOUT_MS` widened 500ms→1000ms, then 1000ms→3000ms (#403), each
  widen stated in-code as measured-cost < margin < guard-ceiling, not chosen by feel. Ask: does
  the verdict depend on which of two uncontrolled real operations finishes first? If yes, it
  needs a seam; if it's a documented backstop around a deterministic fake or bounded passthrough,
  it is compliant.
- **Test-realism family — prove it against the real thing, not a stand-in for it.** Four variants
  of one failure: an assertion that looks like it proves an acceptance criterion but actually
  proves something else — a copied constant, a fixture's own preset, or an isolated unit — never
  engaging the production path the AC is actually about.
  - **VALUE (model the real thing, not a convenient proxy).** Failure class: DRIFT RISK — a test
    constant that silently duplicates a value the repo already defines elsewhere (a CSS rule, a
    cap constant), with nothing tying the two together, so they can silently diverge while the
    test stays green. Rule: read the value from its source only to prevent drift, never as the
    proof — identity with the constant that produced the render proves nothing about it (#936:
    ZONE_DIVIDERS compared against itself "proved" a divider position drawn from ZONE_DIVIDERS).
    Assert an independently derived bound when the AC states an invariant. This does NOT require
    real rendered DOM in general — the default dashboard harness is DOM-free
    (docs/dev-guide/07-dashboard.md) — EXCEPT a computed-style claim itself; see STYLE below.
    Worked example: `textBox()`/`CHAR_ADVANCE` (`dashboard/src/hero/hero.test.ts`) turns
    font-size/char-count into a rendered extent without a browser, tied to the real draw path's
    own inputs.
    Four shapes (#353, #728, #737): (1) the test computes its
    expected value outside the thing it's testing instead of reading/pinning it against the real
    source; (2) the test exercises only the easy/nominal instance while the AC's own wording
    names a combinatorial or boundary case it never constructs; (3) identity with the value's own
    producing constant — the ZONE_DIVIDERS case above (#936, #922); (4) proxy-shares-assumption:
    the test's own helper embeds the same simplifying assumption as the code under test, so a
    wrong assumption in production can't fail its own proxy (#922). FINE: a literal that IS the
    specification — a golden value nothing else in the codebase claims to own.
  - **DECISION (fake-verdict rule, engine side).** Presetting a fake collaborator to already
    return the acceptance criterion's target decision, then asserting against the fake's own
    canned value, proves only that the fake echoes what it was told. Distinct from VALUE (a
    copied constant drifting from its source): here the deciding code path never executes at
    all. Worked
    example: PR #835 (issue #824)'s `ac1`/`ac2` fixtures preset
    `FakeSupervisor.reclaimResults` straight to the AC's target `worktreeRetained` value with no
    baseline ever established, so `WorkerSupervisor.reclaim`'s real mtime/ctime policy never ran;
    fixed by building a real fixture (real directory, real `dispatched_at`, a real post-baseline
    write) and letting production decide. If the fake's return value IS the fact the AC asks to
    prove, the deciding code never ran — run the real function instead.
  - **WIRING (unwired-test rule).** A dashboard test that renders an extracted pure function, a
    bare component, or a hook in isolation proves that piece correct alone — it does not prove
    the app wires it up. Recurring class (#759, #766, #927, #934): a helper/component test stayed
    green while the real app tree never called the helper, called it with the wrong data source,
    dropped the prop between wrapper and consumer, or asserted only the interaction's start/end
    state while the AC's real weight sits at an interior step (a scrub midpoint, a post-click
    state) the test never drove to. Any new dashboard rendered-UI behavior needs at least
    one test rendering today's real entry points (e.g. `App`/`appContent`, or the smallest real
    ancestor owning the wiring) with distinguishable fixture values at the seam under test — not
    only a unit test of the extracted piece; ACs with no render path (server routes, pure modules)
    are outside this rule. Distinct from VALUE above: that sub-case governs which VALUE an
    assertion checks, this one governs which TREE produces it.
    **Data-flow sub-shape (#866, #868, #925), one level up.** Real entry-point rendering isn't
    enough if its props/state are hand-assembled into a combination the real derivation could
    never produce — mount with real prefetched/settled queries and a stubbed `fetch`, over a
    fixture building the AC's named boundary case. `registerRealDom()`
    (`docs/dev-guide/07-dashboard.md`) solved this for CLICK wiring (retro #355); QUERY/data-flow
    wiring has no equivalent shared helper yet. Same shape at #925: `NeedsAttention` fixtures
    built `DomainEvent`s via `toDomainEvent` directly instead of folding wire events through
    `foldOpenAttention`, so its real output combination was never under test.
  - **STYLE (computed-style ACs are VALUE's real-DOM exception).** "Authored" isn't "rendered" —
    a CSS/typography AC needs `registerRealDom()` plus a real `getComputedStyle` read, never a
    stand-in. (a) Text vs. cascade (#879 / PR #886): a regex on declaration TEXT proves a rule
    exists, not that it cascades; mount every inherited stylesheet, in production order, and
    assert the exact value — never `notEqual`/existence. (b) `light-dark()` is unresolvable here
    (#924 AC3, #923, #925): happy-dom always echoes the raw unresolved text, either theme. Fix at
    the token: a literal-hex value pinned to its source by a
    `tokens.test.ts` assertion (`tokens.css`'s `--sap-fill-outline`/`--attention-tone-*`
    pattern), never a raw `.style` read.
  - **COLLISION → COVERAGE (any AC/doc's "all/every named set" or "each X pairs with its Y"
    claim).** `assertNoOverlap`/`boxesOverlap` (`dashboard/src/hero/hero.test.ts`) is sound
    infra, but each PR hand-curates a partial box list, missing neighbors its author forgot —
    recurring (#728, #901); same trap: a hand-picked locator list (#972, #989), and a
    whole-document `.toContain()` proving presence but not pairing WITHIN a row (#956, #990). A
    constant is fine only for static geometry; else derive the covered set from the AC/doc's
    wording, never a hand-typed list or the implementation's own array.
  - **STRUCTURE-AS-FINISH (design-fidelity ACs need a crop-pair oracle, not element-presence).**
    Failure: a ledger/AC closes "resolved" because the element exists and its token resolved,
    while the render is far from mockup finish (#729). Rule: name the visual properties
    claimed — type family/scale/weight, stroke, contrast, density, size ratio, alignment — against
    a mockup crop pair; element-present/token-exact alone is never finish evidence, and
    "resolved" needs the crop pair on record.
  - **PROSE-PIN (a positive assertion whose only oracle is the shipped prompt/doctrine file
    itself).** Earns a place only via a second drifting oracle, a negative lint (`doesNotMatch`
    over a banned class), or a safety floor pinned by a `<!-- sapwood:floor:<name> -->` marker
    + mirror-equality across carriers — else route the AC through the doc-gate (`verify:n/a`)
    (#963).

### Documentation claims

- **Doc-claim grounding rule.** Ground each behavioral/guarantee claim in the exact function/branch,
  not a partial-read generalization. A fallible operation is best-effort unless code checks and
  reports its outcome; do not generalize a one-path policy to another lane. A procedure/recipe must
  be run before calling it working. Docs-only PRs need symbol/branch citations, not memory (#854, #700).
- **Comment discipline** (reviewer bar; producer baseline:
  `engine/prompts/worker.md`'s “Working language & comments”). Source comments explain a
  non-obvious **why**, never narrate code's **what**; narration is a finding. Production-source
  archaeology—origin stories, review/fix-round chronicles, and reviewer attributions—belongs in
  issue/PR; a bare `#NNN` may anchor rule provenance. Every `ponytail:` simplification names its
  ceiling and upgrade path; either omitted is a finding.

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
  pattern gives a false POSITIVE that halts a healthy engine immediately; a too-narrow list gives
  a false NEGATIVE that — per `DEFAULT_LLM_FAILURE_PATTERNS`'s own accounting — the empty-spin
  breaker bounds only on the peripheral-role path; the dispatched-WORKER-lane path depends
  instead on the OUTER safety ceiling (`cost.roundBudgetUsd`/`dailyBudgetUsd`). Prefer narrow
  anyway, naming that outer-layer dependency and the residual blind spot explicitly rather than
  claiming full coverage.
- **Doctrine self-modification rule.** A PR changing this doctrine must be flagged for human
  confirmation and human merge. With default/enabled instruction-path escalation,
  `instruction-path-escalation.ts` derives its carrier and
  `instruction-path-escalation.test.ts` pins escalation. The reviewer uses the construction-time
  snapshot, so the change cannot judge itself.
- **A tier-C cannot-confirm is not a producer stall signal, and it burns spend twice** (#791,
  #865). `docs/security.md`'s evidence tiers make tier-C (human-witnessed probe)
  producer-unforgeable BY DESIGN — the producer never self-executes or self-attests it, so a
  missing tier-C RECORD stays `cannot-confirm` until posted. Name the gap operator-owned in the
  finding body — unlabeled, it reads as a producer failure to `review/convergence.ts` and any
  human — the gate stays `FIXABLE` regardless: a paid fix leg dispatches, disputes, and
  escalates with nothing producer-actionable. `evaluate`/`buildPrompt` (`engine-agent.ts`) read
  only `getAcSnapshot`'s snapshot, never a comment: a COMMENT-carried record can't reach a later
  review; a BODY-carried one can, via `checkAcDriftBeforeDrive` flagging drift and gated
  re-entry's `buildAcSnapshot` (`ac-snapshot.ts`)/`State.recordAcSnapshotAndReclaimWorker`
  re-snapshot. #865's unimplemented fix routes an all-operator-owned verdict to `ESCALATE`;
  until then, closing one needs a human merge decision reading the record, or a body-carried
  rebaseline. Grounding: `docs/security.md`'s AC-evidence-tier doctrine, Decision #8.
- **A tier-C comment is an operator inbox item, not gate② evidence.** Author association
  (`OWNER`, etc.) authenticates the poster, never the claim — it is not attestation; folding
  the record into the issue **body** IS the attestation. Post the record into the body; if a
  comment also carried it, advance the [comment adjudication
  cursor](security/adjudication.md#the-comment-adjudication-cursor) past it in that SAME body edit — the
  cursor adjudicates comments, so a body-only path has nothing to advance past. Never
  comment-only, for the same reasons the bullet above already gives
  (`checkAcDriftBeforeDrive`, `needs-human`, rebaseline).

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
   implementation effort turns counterintuitive or runaway-complex, re-examine its design/
   technical direction (architect/plan re-review) instead of grinding through more fix rounds —
   the doctrine names DESIGN RE-ENTRY, not just the fix-round cap's human escalation, as the
   intended response.

## Prompt architecture doctrine (#699)

Three governing principles for what belongs in a role's SHIPPED PROMPT TEXT
(`engine/prompts/*.md`), owner ruling 2026-08-06. Gate② standard for any prompt-touching PR,
applied clause-by-clause, not file-by-file. Worked example:
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

**Q3 safety-floor exception.** Unsafe-to-omit floors (AC-evidence tiers and human-merge-only paths)
remain in prompt text even when a pull-model skill serves the same source: sessions may not invoke
it, so it is not load-bearing. If principle 3 collides, record the tension and proposed carrier
instead of deleting. For multi-carrier floors enumerated by `engine/src/roles/prompts.test.ts`
(#628/#653), its marker/mirror test requires equality after whitespace normalization across the
enumerated prompt carriers; otherwise retain the carrier tension.
