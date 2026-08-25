# Design — instruction-path escalation derivations (2026-08)

> **Process record.** Internal design/research artifact from sapwood's own development
> history — not end-user documentation. Read current docs/code for shipped state:
> [`../security/instruction-path-escalation.md`](../security/instruction-path-escalation.md) is the
> mechanism reference this record was split out of (#1094, compressing "Instruction-path changes
> escalate to human review"). This document preserves the measurement and the historical evidence
> behind statements the current page keeps only as an accepted fact or a boundary.

## Origin: the `--setting-sources ""` / `-c project_doc_max_bytes=0` ambient-absorption measurement

The current page states only the fact this measurement grounds: the flag itself, not a local
settings deny wearing platform clothes, is what stops gate②'s Claude session from absorbing
ambient `CLAUDE.md` content. The measurement, verbatim from the pre-compression page:

---

This was measured live the same way the earlier measurement recorded in the peripheral-egress
section above was taken — a scratch directory whose `CLAUDE.md` declared a unique marker fact, a
one-shot `claude -p` asking for that fact: the default run answered with the marker, the
identical run with `--setting-sources ""` answered `UNKNOWN`. Same machine, same operator
settings, one flag changed — so the difference is the flag, not a local settings deny wearing
platform clothes.

---

(The "peripheral-egress section above" this refers to is [Peripheral network egress: WebSearch/WebFetch, detected not
pinned](../security/egress.md#peripheral-network-egress-websearchwebfetch-detected-not-pinned) —
moved to its own page by #1094 PR-S, after this measurement's own prose was written.)

## Origin: "The mechanism's own carriers join the escalation surface too" — the live-evidence case

The current page states only the ruling: the instruction-path matcher, `config.ts`'s defaults,
`docs/security.md`, and `docs/security/**` are themselves on the escalation surface, checked
against the deployed config rather than a PR's own diff. The live evidence that motivated adding
these paths, verbatim from the pre-compression page:

---

Live evidence for why this matters: a PR once merged with zero human eyes, touching the
instruction-path matcher itself (`engine/src/review/instruction-path-escalation.ts`), the
`escalation.instructionPaths` defaults (`engine/src/config/config.ts`), and this file. None of the
three were on any escalation or human-merge-only list, so the merge was compliant with the
letter — a PR gutting the matcher or shrinking the defaults would have reached autonomous merge
the same way. (That instance was benign; the finding is the reachable class.)

---
