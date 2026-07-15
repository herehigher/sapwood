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

- [ ] Concrete, checkable statement of what "done" looks like.

## Verification plan

If this chore is inherently unverifiable (no test/command can prove it — pure
cleanup, config bump with no behavior change, etc.), say so and apply the
`verify:n/a` label instead of filling this section (the doc-gate path, see
CLAUDE.md). If there IS something checkable (build still passes, a script still
runs, etc.), describe it here.
