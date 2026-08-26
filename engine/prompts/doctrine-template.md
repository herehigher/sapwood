<!--
  sapwood review doctrine — this repository's own review knowledge, read by the worker dispatch
  brief, the fix leg, the architect pass, and the engine-agent reviewer every round. Generic
  doctrine — including how the loop should treat review findings in general — ships in the
  framework and is injected before this file at every one of those sites; do not copy it here.
  See docs/guide/configuration.md#doctrine for the full topology.

  This file was scaffolded because none existed yet — there is no review history to distill a
  real doctrine from on a fresh repo. It ships with placeholder EXAMPLE entries showing the shape
  a real entry takes; replace them with this project's own recurring findings as they accumulate,
  and delete the placeholders once real entries exist. Deliberately PROSE, not a lint/DSL: these
  are judgment rules for an LLM reviewer, not machine-checkable patterns.

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

This project's own technical invariants — recurring failure classes its review history has
already flagged more than once. Generic doctrine ships in the framework core, injected before
this file; it is not repeated here.

## Technical invariants

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
