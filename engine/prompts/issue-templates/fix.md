---
name: Fix / infra
about: A bug fix, build/tooling/scaffolding change, or other infra work
title: "fix: "
labels: type:infra
---

## Why

What's broken (or what infra/tooling gap exists), who does it affect, and why fix it
now? Include repro steps for a bug, if applicable.

## What

Describe the expected behavior or scoped infra/tooling change.

Out of scope: <!-- Encouraged: name one adjacent thing this issue will not do. -->

## Constraints

<!-- OPTIONAL — keep only when hard implementation boundaries exist (ordering,
     human-merge-only files, known gotchas); delete otherwise. Include only
     issue-specific boundaries, never a restatement of repo doctrine. -->

## Acceptance criteria

<!-- Each line MUST be a literal `- [ ]` checkbox — the engine parses this exact format into
     the acceptance-criteria set a worker is dispatched against and later reviewed on. Prose,
     nested sub-bullets, or a plain `-` bullet with no checkbox do not count: a missing or
     malformed checkbox set here blocks dispatch (gate⓪) even with plan:approved applied. -->

- [ ] Concrete, checkable statement of what "done" looks like.
- [ ] Add one line per criterion — each must be independently verifiable.

## Verification plan

How will the reviewer at gate② prove the fix actually works (and didn't regress
anything)? Name the tests to write/run, commands to execute, or observable outcomes
to check.
