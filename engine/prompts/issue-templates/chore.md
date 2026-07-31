---
name: Chore
about: Maintenance or dogfood task (no new capability, no user-facing behavior change)
title: "chore: "
labels: type:chore
---

## Why

Why is this maintenance or dogfood task needed now? (For example: dependency bump,
repo hygiene, or a dogfooding follow-up.)

## What

Describe the scoped maintenance change and its intended result.

Out of scope: <!-- Encouraged: name one adjacent thing this issue will not do. -->

## Acceptance criteria

<!-- Each line MUST be a literal `- [ ]` checkbox (start unchecked — nothing should be done yet)
     — the engine parses this exact format into the acceptance-criteria set a worker is
     dispatched against and later reviewed on. Prose, nested sub-bullets, or a plain `-` bullet
     with no checkbox do not count. A criterion may wrap onto more than one line (indent the
     continuation, like this comment) — that's fine, it's still one criterion. Exempt ONLY if
     this chore is inherently unverifiable and carries the `verify:n/a` label (doc-gate path,
     see the Verification plan section below). Never write CI/suite/typecheck status as a
     criterion ("the test suite passes", "CI green") — CI enforces those unconditionally;
     execution steps belong in the Verification plan below. -->

- [ ] Concrete, checkable statement of what "done" looks like.

## Verification plan

If this chore is inherently unverifiable (no test/command can prove it — pure
cleanup, config bump with no behavior change, etc.), say so and apply the
`verify:n/a` label instead of filling this section (the doc-gate path, see
CLAUDE.md). If there IS something checkable (build still passes, a script still
runs, etc.), describe it here.
