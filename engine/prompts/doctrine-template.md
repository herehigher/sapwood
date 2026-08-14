<!--
  sapwood review doctrine — repo-level review knowledge the loop carries forward across
  rounds, instead of it living only in a human/conductor's memory and evaporating. Read by the
  worker dispatch brief and the architect pass every round, and cited by the gated-reentry
  escalation comment when automatic fix attempts are exhausted.

  Configured as `doctrine.file` in sapwood.config.yaml (default: docs/REVIEW-DOCTRINE.md).
  Absent entirely -> the loop proceeds with an explicit 'none' placeholder, behavior unchanged
  (this file is optional, unlike the north-star goal file).

  Mechanism note: the reviewer applies the doctrine loaded at engine construction time, never a
  version edited on the PR's own branch — a PR that modifies this file cannot influence the
  doctrine used for its own review, but it can still pass under the prior rules. Flag a PR that
  edits this file for human attention rather than auto-merge, so a rule change gets a person's
  confirmation before it takes effect next round.

  This file was scaffolded because none existed yet — there is no review history to distill a
  real doctrine from on a fresh repo. It ships with placeholder EXAMPLE entries showing the shape
  a real entry takes (see "Technical invariants" below); replace them with this project's own
  recurring findings as they accumulate, and delete the placeholders once real entries exist.
  Deliberately PROSE, not a lint/DSL: these are judgment rules for an LLM reviewer, not
  machine-checkable patterns.

  Curation rule: this file is a fixed-size cache, not a log — the budget (`doctrine.maxChars`)
  is the design, and hitting it is a curation signal, never a reason to compress a new rule into
  telegram style. Above ~85% of that budget, an addition must evict or merge at least as much as
  it adds (one-in-one-out). A new rule joins an existing family/sub-case structure where one
  fits, rather than opening a new top-level bullet. Incident narrative is banned — a distilled
  worked example is not narrative: keep an example only for the discriminating criterion it
  carries (what to look at, what decides); the blow-by-blow story belongs in the issue/PR its
  bare anchor (#NNN) points to, once one exists. Mechanism claims cite symbols/files, never line
  ranges — line ranges rot as the code moves.
-->

# Review doctrine

Two kinds of content: technical invariants this repo's review history has already flagged more
than once, and doctrine for how the loop should treat review findings in general.

## Technical invariants

Recurring failure classes, stated as judgment rules for LLM reviewers — deliberately NOT a
lint/DSL, since spotting a violation requires reading design intent, not matching a pattern.

- **Authoritative signals over inferred text.** Detection and classification bind to a structured
  signal first — an API status field, an exit code, a typed event. Formats this project defines
  and parses fail-closed are contracts, not text matching, even when they travel as text. Only
  genuinely uncontrolled free text is last-resort: match narrow, signature-shaped patterns, never
  a wildcard, and name the failure direction (false-positive vs. false-negative) the choice
  favors. Generic engineering discipline, not project-specific — kept as a real default rather
  than an illustrative placeholder, unlike the two examples below.

The two entries below ARE fictional placeholder examples — there is no real review history yet on
a fresh repo. Replace them with this project's own recurring findings, in the same form, once
this project's own review history has flagged something more than once; delete them if nothing
has recurred yet.

- **Example (illustrative, not a real finding): currency-rounding boundary rule.** If this were a
  payments service, a rule distilled from two independent review findings might read: "A monetary
  amount is rounded to the currency's minor unit exactly ONCE, at the boundary where it leaves
  this service (an API response, a ledger write) — never inside an intermediate calculation.
  Rounding early and again later compounds into off-by-one-cent drift that only surfaces in
  reconciliation, days after the code that caused it shipped." That is the SHAPE a real entry
  takes: a specific, testable judgment call tied to a concrete failure mechanism, not a style
  preference.
- **Example (illustrative, not a real finding): cache-invalidation ordering rule.** If this were a
  content-management system, a rule might read: "A write that changes a resource's visibility
  (publish/unpublish, a permission change) invalidates any cache keyed on that resource BEFORE the
  write's transaction commits, never after. A commit-then-invalidate ordering leaves a window
  where a cached read can return content whose access was just revoked."

## Adjudication doctrine

How the loop should treat review findings in general — this half is project-agnostic; keep it as
a sensible default, or edit it to match this project's own norms:

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
   design/technical direction (an architect/plan re-review) instead of grinding through more fix
   rounds. The nearest mechanism for this is the fix-round cap escalating to a human — but the
   doctrine names DESIGN RE-ENTRY, not just human escalation, as the intended response.
