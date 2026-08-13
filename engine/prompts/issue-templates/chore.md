---
name: Chore
about: Maintenance task (no new capability, no user-facing behavior change)
title: "chore: "
labels: type:chore
---

## Why

Why is this maintenance task needed now? (For example: a dependency bump, repo
hygiene, or a follow-up from an earlier round of work.)

## What

Describe the scoped maintenance change and its intended result.

Out of scope: <!-- Encouraged: name one adjacent thing this issue will not do. -->

## Acceptance criteria
<!-- sapwood:ac -->

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
<!-- sapwood:verification -->

If this chore is inherently unverifiable (no test/command can prove it — pure
cleanup, config bump with no behavior change, etc.), say so and apply the
`verify:n/a` label instead of filling this section (this routes the issue
through the doc-gate path instead of the usual verification gate). If there IS
something checkable (build still passes, a script still runs, etc.), describe
it here.
