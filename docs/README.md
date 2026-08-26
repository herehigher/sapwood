# Documentation map

This page routes, it does not duplicate. Each linked page carries its own
description; this table gives one line so you land in the right directory,
no more.

**Start here if you're operating sapwood:** [`security.md`](security.md) is
required reading before an autonomous run — the trust/governance model,
guard hook, human-merge-only paths, and cost ceilings.

## Root anchors (stay at `docs/` — engine config and runtime wire them by path)

| Doc | For |
| --- | --- |
| [`security.md`](security.md) | The trust/governance model — read before any autonomous run. |
| [`PLAN.md`](PLAN.md) | Architecture, locked decisions, and roadmap. |
| [`REVIEW-DOCTRINE.md`](REVIEW-DOCTRINE.md) | This repo's own review-doctrine residue, injected into role prompts after the framework's generic core (`engine/prompts/doctrine-core.md`). |

These three stay at the `docs/` root — not a stylistic choice: engine config
(`sapwood.config.yaml`'s `doctrine.file`/`goal.file` keys) and production
runtime output (`engine/src/util/doc-links.ts`) cite them by a path baked
into shipped code, so moving them would break a live wire, not just a link.

## [`security/`](security/) — mechanism reference

Per-mechanism detail for the security model above — one page per topic, linked from
`security.md`'s "Mechanism reference" table.

## [`guide/`](guide/) — for operators

Install, configure, run, and troubleshoot a sapwood deployment.

| Doc | For |
| --- | --- |
| [`guide/getting-started.md`](guide/getting-started.md) | Install, `sapwood init`, the autonomy ladder. |
| [`guide/configuration.md`](guide/configuration.md) | Every config key, default, and semantics. |
| [`guide/troubleshooting.md`](guide/troubleshooting.md) | Diagnosing and recovering from common failures. |
| [`guide/supervision.md`](guide/supervision.md) | The supervision playbook for a human or LLM operator watching a run. |

## [`dev-guide/`](dev-guide/) — for contributors

A codebase tour: architecture, modules, persistence, and the change-risk map
for anyone changing sapwood itself. Start at
[`dev-guide/README.md`](dev-guide/README.md).

## [`reference/`](reference/) — durable contracts and specs

Behavioral and data-contract references that code and tests hold themselves
to, not narrative docs.

| Doc | For |
| --- | --- |
| [`reference/role-paradigm.md`](reference/role-paradigm.md) | The contract every peripheral role session satisfies. |
| [`reference/round-artifact.md`](reference/round-artifact.md) | The round-summary JSON data contract. |
| [`reference/frontend-design.md`](reference/frontend-design.md) | The dashboard's design and data-contract spec. |
| [`reference/loop-walkthrough.md`](reference/loop-walkthrough.md) | Step-by-step engine behavior, including every boundary. |

## [`testing/`](testing/) — test-harness prompts and material

| Doc | For |
| --- | --- |
| [`testing/ux-simulated-user.md`](testing/ux-simulated-user.md) | The simulated-user session prompt for live UX probes. |

## [`design/`](design/) — decision records

Point-in-time design documents for specific issues/features, kept as the
historical record of *why* a decision was made. Not living references —
see `reference/` for those instead.

## [`research/`](research/) — market and landscape research

Point-in-time competitive/market research, kept as historical record.
