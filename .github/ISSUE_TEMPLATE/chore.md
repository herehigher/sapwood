---
name: Chore
about: Maintenance or dogfood task (no new capability, no user-facing behavior change)
title: "chore: "
labels: type:chore
---

## Description

What's the maintenance task, and why now? (e.g. dependency bump, repo hygiene,
dogfooding follow-up.)

## Acceptance criteria

- [ ] Concrete, checkable statement of what "done" looks like.

### Verification

<!-- Keep this as a SUBSECTION (###) of Acceptance criteria: gate② extracts one
     contiguous section from the first Acceptance/Verification heading, so the
     verification steps must live inside it to travel with the criteria. -->

If this chore is inherently unverifiable (no test/command can prove it — pure
cleanup, config bump with no behavior change, etc.), say so and apply the
`verify:n/a` label instead of filling this section (the doc-gate path, see
CLAUDE.md). If there IS something checkable (build still passes, a script still
runs, etc.), describe it here.
