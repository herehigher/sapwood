---
name: Docs
about: A documentation-only change (README, the goal file, usage/config guides)
title: "docs: "
labels: type:docs
---

## Why

What durable-knowledge change is this (new/changed capability, behavior, decision,
or milestone), and why do the docs need to reflect it now?

## What

Which document and section will change, and what should be true afterward?

Out of scope: <!-- Encouraged: name one adjacent documentation change this issue will not do. -->

## Acceptance criteria
<!-- sapwood:ac -->

<!-- Each line MUST be a literal `- [ ]` checkbox (start unchecked — nothing should be done yet)
     — the engine parses this exact format into the acceptance-criteria set a worker is
     dispatched against and later reviewed on. Prose, nested sub-bullets, or a plain `-` bullet
     with no checkbox do not count. A criterion may wrap onto more than one line (like the
     example below) — that's fine, it's still one criterion. Exempt ONLY if this doc change is
     inherently unverifiable and carries the `verify:n/a` label (doc-gate path, see the
     Verification plan section below). Never write CI/build status as a criterion ("the docs
     build passes", "CI green") — CI enforces those unconditionally; execution steps belong in
     the Verification plan below. -->

- [ ] Concrete, checkable statement of what "done" looks like (e.g. which section of
      which doc is added/updated, and what it says).

## Verification plan
<!-- sapwood:verification -->

Most docs-only work is inherently unverifiable by test/command — if that's the case
here, say so and apply the `verify:n/a` label instead of filling this section (this
routes the issue through the doc-gate path instead of the usual verification gate).
If there IS something checkable (a link resolves, a generated doc matches source,
etc.), describe it here.
