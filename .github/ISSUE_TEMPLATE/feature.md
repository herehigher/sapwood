---
name: Feature
about: A new capability for this project
title: "feat: "
labels: type:feature
---

## Why

What problem does this solve, and why does the loop or its users need it now?

## What

Describe the new capability and the intended behavior.

Out of scope: <!-- Encouraged: name one adjacent thing this issue will not do. -->

## Constraints

<!-- OPTIONAL — keep only when hard implementation boundaries exist (ordering,
     human-merge-only files, known gotchas); delete otherwise. Include only
     issue-specific boundaries, never a restatement of repo doctrine. -->

## Acceptance criteria
<!-- sapwood:ac -->

<!-- Each line MUST be a literal `- [ ]` checkbox (start unchecked — nothing should be done yet)
     — the engine parses this exact format into the acceptance-criteria set a worker is
     dispatched against and later reviewed on. Prose, nested sub-bullets, or a plain `-` bullet
     with no checkbox do not count: a missing or malformed checkbox set here blocks dispatch
     (gate⓪) even with plan:approved applied. A criterion may wrap onto more than one line
     (indent the continuation, like this comment) — that's fine, it's still one criterion.
     Never write CI/suite/typecheck status as a criterion ("the test suite passes", "CI green")
     — CI enforces those unconditionally; execution steps belong in the Verification plan
     below. -->

- [ ] Concrete, checkable statement of what "done" looks like.
- [ ] Add one line per criterion — each must be independently verifiable.

## Verification plan
<!-- sapwood:verification -->

How will the reviewer at gate② prove the criteria above are actually met? Name the
tests to write/run, commands to execute, or observable outcomes to check.
