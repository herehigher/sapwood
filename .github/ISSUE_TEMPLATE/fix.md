---
name: Fix / infra
about: A bug fix, build/tooling/scaffolding change, or other infra work
title: "fix: "
labels: type:infra
---

## Description

What's broken (or what infra/tooling gap exists), and what's the expected behavior
instead? Include repro steps for a bug, if applicable.

## Acceptance criteria

- [ ] Concrete, checkable statement of what "done" looks like.
- [ ] Add one line per criterion — each must be independently verifiable.

### Verification

<!-- Keep this as a SUBSECTION (###) of Acceptance criteria: gate② extracts one
     contiguous section from the first Acceptance/Verification heading, so the
     verification steps must live inside it to travel with the criteria. -->

How will the reviewer at gate② prove the fix actually works (and didn't regress
anything)? Name the tests to write/run, commands to execute, or observable outcomes
to check.
