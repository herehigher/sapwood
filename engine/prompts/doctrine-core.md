Generic review-loop doctrine, shipped with the framework and injected ahead of a target
repository's own review-doctrine residue — judgment rules for an LLM reviewer, prose, never a
lint/DSL.

## Technical invariants

- **Carrier split.** This file carries doctrine generic across projects; a target repository's
  own residue file carries that repository's own review knowledge. A hosted review bot's standing
  round discipline belongs in that bot's own instruction file, never injected doctrine text — see
  `docs/guide/configuration.md#hosted-bot-review-guidelines`.
- **Disabled-consumer rule.** A signal or probe answering "is there work?" must be gated on
  whether its consumer is actually enabled/present. An unconsumable signal that is never gated
  this way pins itself true forever, burning cycles on work nothing will ever read.
- **Unwired-function rule.** A shipped recovery or cleanup function with zero production callers
  is a defect, not a reserve capability — verify every new cleanup, resume, or clear entry point
  has a live caller on the path that needs it.
- **No timing-dependent assertions.** BANNED: an assertion whose pass/fail is decided by a close
  race between uncontrolled real operations — real work vs. a real timer, no seam controlling
  either side. For a load-bearing race, the fix is a seam: a fake clock/collaborator, or a fast,
  deterministic, self-terminating fake. FINE: an outer hang-guard bounding catastrophe rather than
  deciding the verdict, or a real passthrough timed against a generous, documented margin, stated
  in-code as measured-cost < margin < guard-ceiling.
- **Test-realism family — prove it against the real thing, not a stand-in for it.** Four variants
  of one failure: an assertion that looks like it proves a criterion but actually proves something
  else — a copied constant, a fixture's own preset, an isolated unit — never the production path
  the criterion is actually about.
  - **VALUE (model the real thing, not a convenient proxy).** DRIFT RISK: a test constant that
    silently duplicates a value the codebase already defines elsewhere, nothing tying the two
    together, so they can diverge while the test stays green. Read the value from its source only
    to prevent drift, never as the proof; assert an independently derived bound instead. Four
    shapes: (1) the value computed outside the thing under test rather than read from the real
    source; (2) only the easy/nominal instance exercised while the criterion names a boundary case
    never constructed; (3) identity with the value's own producing constant; (4)
    proxy-shares-assumption — the test's own helper embeds the same simplifying assumption as the
    code under test. FINE: a literal that IS the specification. STYLE below is this rule's one
    real-rendering exception.
  - **DECISION (fake-verdict rule, engine side).** Presetting a fake collaborator to already
    return the criterion's target decision, then asserting against the fake's own canned value,
    proves only that the fake echoes what it was told. If the fake's return value IS the fact the
    criterion asks to prove, the deciding code never ran — run the real function instead.
  - **WIRING (unwired-test rule).** A test that renders an extracted pure function, a bare
    component, or a hook in isolation proves that piece correct alone — not that the surrounding
    application wires it up. Recurring class: a green helper/component test while the real
    application tree never called the helper, called it with the wrong data source, dropped a
    prop between wrapper and consumer, or asserted only an interaction's start/end state while the
    criterion's real weight sits at an interior step never driven to. Any new rendered-UI behavior
    needs at least one test rendering today's real entry points, not only the extracted piece.
    One level up: real entry-point rendering is not enough if its props/state are a
    hand-assembled combination the real derivation could never itself produce.
  - **STYLE (computed-style ACs are VALUE's real-DOM exception).** "Authored" is not "rendered" —
    a CSS/typography criterion needs a real DOM plus a real computed-style read, never a
    stand-in. A regex on declaration text proves a rule exists, not that it cascades; mount every
    inherited stylesheet, in production order, and assert the exact value, never a mere
    existence/inequality check.
  - **COLLISION → COVERAGE (any "all/every named set" or "each X pairs with its Y" claim).** A
    hand-curated partial list misses neighbors its author forgot — same trap as a hand-picked
    locator list, or a whole-document containment check proving presence but not pairing. Derive
    the covered set from the criterion or doc's own wording, never a hand-typed list.
  - **STRUCTURE-AS-FINISH (design-fidelity ACs need a crop-pair oracle, not element-presence).**
    A ticket closing "resolved" because the element exists and its token resolved, while the
    render is far from the intended finish. Name the visual properties claimed against a
    design-reference crop pair; element-present/token-exact alone is never finish evidence.
  - **PROSE-PIN (a positive assertion whose only oracle is the shipped prompt/doctrine file
    itself) (doc-content test partition).** Earns a place only via a second, independently
    drifting oracle, a negative lint over a banned class, or a safety floor pinned by a marker
    plus mirror-equality across carriers — else route the criterion through the doc-gate
    exemption.
- **Doc-claim grounding rule.** Ground each behavioral/guarantee claim in the exact
  function/branch, not a partial-read generalization. A fallible operation is best-effort unless
  code checks and reports its outcome. A procedure must be run before calling it working.
  Docs-only changes need symbol/branch citations, not memory.
- **Comment discipline.** Source comments explain a non-obvious why, never narrate code's what —
  narration is a finding. Production-source archaeology belongs in the issue or pull request,
  never in the code; a bare issue reference may anchor rule provenance.
- **Authoritative signals over inferred text.** Bind detection/classification to a structured
  signal first — an API status field, an exit code, a typed event. Formats a project defines and
  parses fail-closed are contracts, not text matching, even when they travel as text. Only
  genuinely uncontrolled free text is last-resort: match narrow, signature-shaped patterns, never
  a wildcard, and name which failure direction the choice favors.
- **Doctrine self-modification rule.** A change to this doctrine — framework core or a
  repository's own residue — must be flagged for human confirmation and human merge; a reviewing
  session applies the doctrine loaded at construction time, never a version edited on the branch
  under review, so a change cannot judge itself, and takes effect only next round.

## How the loop treats review findings

1. **Review findings are INPUTS, not truth.** Judge each finding against reality before acting;
   reject low-ROI or misdirecting findings WITH recorded reasons rather than applying every
   finding mechanically.
2. **A recurring finding class belongs at the DESIGN SOURCE.** When the same class keeps coming
   back, rethink the approach or technical direction — don't keep chasing per-finding patches
   downward, round after round.
3. **A reviewer's angle can be wrong.** Divergence between the reviewer's read and the author's
   is signal for adjudication, not automatic compliance — weigh it, don't just apply it.
4. **Runaway complexity escalates to the top of the loop, not more patches.** When a feature's
   implementation effort turns counterintuitive or runaway-complex, re-examine its design/
   technical direction (an architect/plan re-review) instead of grinding through more fix rounds —
   DESIGN RE-ENTRY, not just human escalation.
