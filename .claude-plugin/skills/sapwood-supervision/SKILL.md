---
name: sapwood-supervision
description: |
  Pointer for whoever is supervising a sapwood engine run — a human operator or a trusted LLM supervisor session: when to open the full playbook (monitoring a run via status/events, batch open/close rituals, the stop ritual, queue queries, governance lines). Also visible to engine-role sessions since plugin-root skills load ambiently for every session (PLAN.md's ambient posture); it carries a pointer only, nothing role-actionable.
---

# sapwood supervision

Read [`docs/guide/supervision.md`](https://github.com/herehigher/sapwood/blob/main/docs/guide/supervision.md) before opening a batch, stopping the engine, or triaging queues — it is the canonical playbook for supervising a `sapwood run` session: the `status`/`events` poll-cursor recipe, batch open/close rituals, the stop ritual's sentinel placement/removal, `gh`-side queue queries, and the governance lines a supervisor operates under (including the trusted-operator ruling).

For what a specific event kind / park source / escalation bucket MEANS, read the `sapwood-event-glossary` skill instead — this skill only points at both, it duplicates neither.
