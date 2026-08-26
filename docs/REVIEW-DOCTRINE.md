<!--
  sapwood review doctrine — this repository's own residue. The framework's generic core
  (`engine/prompts/doctrine-core.md`) is injected before this file at every render site — do not
  duplicate anything that already lives there.

  Deliberately PROSE, not a lint/DSL. Curation rule: one-in-one-out above ~85% of the budget — an
  addition evicts or merges at least as much as it adds, joining an existing family rather than
  opening a new top-level bullet. A bold lead is an identifier: `git grep` it before renaming.
-->

# Review doctrine

This repo's own recurring technical invariants and prompt-architecture doctrine. Generic
doctrine, including how the loop treats review findings, ships in the framework core.

## Technical invariants

### Engine lifecycle & safety

- **Disabled-consumer rule.** The core states the general criterion; this repo's own
  consequence: an unconsumable probe defeats standby, burning peripheral sessions on work
  nothing will ever read (`config.ts`, `doctrine.ts`, `env-failure.ts`).
- **Same-tick window rule.** `tick()` reclaims before it dispatches. Any ledger-read dispatch
  gate must be a thunk evaluated post-reclaim, inside `tick()` itself — never a pre-tick scalar
  snapshot, never a post-tick check that races the same tick's own reclaim.
- **Crash-rerun set.** Persist state before any terminal transition. Use id cursors, not
  timestamps, for resumable reads. A resumed drain must never re-dispatch an earlier attempt's
  work; reruns must be idempotent — update-in-place, never a derived counter.
- **Safety-layer cross-check rule.** Any new state machine or dispatch path must be reviewed
  against each existing safety layer — kill switch, pause, cost/wall-clock ceiling, both drain
  paths: what does this mechanism do while that layer is active, and what does that layer's
  firing do to this mechanism's state?

### Is this test real?

- **VALUE (model the real thing, not a convenient proxy).** The core states the general rule;
  this repo's own note: NOT real rendered DOM in general — the default dashboard harness is
  DOM-free (`docs/dev-guide/07-dashboard.md`) — EXCEPT a computed-style claim; see STYLE below.
  Worked example: `textBox()`/`CHAR_ADVANCE` (`dashboard/src/hero/hero.test.ts`).
- **WIRING (unwired-test rule).** The core states the general rule and its data-flow sub-shape.
  This repo's own render target: `App`/`appContent`. `registerRealDom()`
  (`docs/dev-guide/07-dashboard.md`) closed the gap for CLICK wiring; QUERY/data-flow wiring has
  no equivalent shared helper yet (#925).
- **STYLE (computed-style ACs are VALUE's real-DOM exception).** The core states the general
  rule. This repo's own gap: `light-dark()` is unresolvable — `happy-dom` always echoes the raw
  unresolved text, either theme. Fix at the token: a literal-hex value pinned to its source by a
  `tokens.test.ts` assertion (`tokens.css`'s `--sap-fill-outline`/`--attention-tone-*` pattern),
  never a raw `.style` read.
- **COLLISION → COVERAGE (any AC/doc's "all/every named set" or "each X pairs with its Y"
  claim).** The core states the general rule. This repo's own sound infra:
  `assertNoOverlap`/`boxesOverlap` (`dashboard/src/hero/hero.test.ts`) — only as sound as the box
  list an author hand-curates against it.
- **PROSE-PIN (a positive assertion whose only oracle is the shipped prompt/doctrine file
  itself).** The core states the oracle criterion. This repo's own mechanism: a safety floor
  pinned by a `<!-- sapwood:floor:<name> -->` marker + mirror-equality across the carriers
  `engine/src/roles/prompts.test.ts` enumerates.

### Signal classification & escalation

- **Authoritative signals over inferred text.** Worked example: `classifyEnvFailure`
  (`engine/src/loop/env-failure.ts`) checks structured, provider-authoritative signals first,
  before falling back to the enumerated pattern list. NOT symmetric: a too-wide pattern gives a
  false POSITIVE halting a healthy engine immediately; a too-narrow list gives a false NEGATIVE
  bounded only by the peripheral-role empty-spin breaker — the dispatched-WORKER-lane path
  depends instead on the outer ceiling (`cost.roundBudgetUsd`).
- **A tier-C comment is an operator inbox item, not gate② evidence, and a missing tier-C RECORD
  is never a producer stall signal.** `docs/security.md`'s evidence tiers make tier-C
  (human-witnessed probe) producer-unforgeable BY DESIGN — the producer never self-executes or
  self-attests it, so a missing record stays `cannot-confirm` until posted; unlabeled, the gap
  reads as a producer failure though nothing here is producer-actionable. Author association
  authenticates the poster, never the claim — only a **body** edit is attestation: post the
  record into the body, advancing the [comment adjudication
  cursor](security/adjudication.md#the-comment-adjudication-cursor) past a comment that also
  carried it, in that SAME edit. `evaluate`/`buildPrompt` read only the dispatch-time AC
  snapshot, never a comment — only a body-carried record reaches a later review.

## Prompt architecture doctrine (#699)

Three governing principles for what belongs in a role's SHIPPED PROMPT TEXT
(`engine/prompts/*.md`), owner ruling 2026-08-06. Gate② standard for any prompt-touching PR,
applied clause-by-clause. Worked example: `docs/design/699-prompt-architecture-audit.md`.

1. **A — legitimate content.** Role definition, duties, scope, goals, deliverables, norms,
   constraints — the whole legitimate surface.
2. **B — judgment preemption.** A pre-baked conclusion or verdict-steering assertion that
   substitutes for the LLM's judgment. Disposition: delete, or rewrite as a judgment-preserving
   goal/constraint.
3. **C — machinery in prose.** A deterministic check/flow/value the engine, config, schema, or
   guard could enforce (or already does — a drifting duplicate). Disposition: name the target
   carrier and file a follow-up — never "fix" by rewording.

**Q3 safety-floor exception.** Unsafe-to-omit floors (AC-evidence tiers, human-merge-only paths)
remain in prompt text even when a pull-model skill serves the same source: sessions may not invoke
it, so it is not load-bearing. If principle 3 collides, record the tension instead of deleting.
Multi-carrier floors enumerated by `engine/src/roles/prompts.test.ts` (#628/#653) already require
mirror-equality across their carriers.
