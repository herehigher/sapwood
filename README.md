# sapwood

[![CI](https://github.com/herehigher/sapwood/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/herehigher/sapwood/actions/workflows/ci.yml?query=branch%3Amain)
[![npm version](https://img.shields.io/npm/v/sapwood)](https://www.npmjs.com/package/sapwood)
[![node >= 24](https://img.shields.io/badge/node-%E2%89%A524-blue)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

English · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

**Autonomous coding, governed.**

- issues in → reviewed PRs out.
- producer ≠ reviewer ≠ merger, fail-closed within the guarded built-in tool
  family — branch protection + distinct merger identity are the deployment
  backstop (see [Trust model
  prerequisites](docs/guide/getting-started.md#trust-model-prerequisites)).
- sapwood is a Claude Code plugin bundle (slash commands, skills, the guard
  hook) around the `sapwood` engine CLI. Install the plugin (recommended),
  or run the CLI from npm on its own — both are complete paths.

<!-- source: docs/assets/hero-loop.mmd — regenerate per docs/assets/diagram-style.md -->
![Hero loop](docs/assets/hero-loop.svg)
A human signs the issue Ready; a worker pushes while the fail-closed guard denies approve and merge within the guarded built-in tools (branch protection is the backstop); the engine opens or adopts the PR and gates it on CI + independent review — findings loop back under a fix cap, non-convergence stops for a human.

## Quick start

**Requirements**

- Node.js ≥ 24
- Claude Code CLI ≥ 2.1.209
- `gh` authenticated with the `project` scope
- A GitHub repo with a ProjectV2 board sapwood may drive

```
/plugin marketplace add herehigher/sapwood-plugin
/plugin install sapwood@sapwood
```

```yaml
board:
  owner: YOU
  repo: REPOSITORY
  projectNumber: PROJECT_NUMBER
```

```
npx sapwood@<version> validate
npx sapwood@<version> init
npx sapwood@<version> run --dry-run
```

`init` provisions labels, board lanes, starter files, and (with repo
admin) a deploy key — best-effort, idempotent. `run --dry-run` reads only,
nothing is written.

npm only: `npm i -g sapwood@alpha` gives the same CLI, no slash commands.
Pre-release: both channels go live with the first tagged release.

See [Install](docs/guide/getting-started.md#install) and [L1
recipe](docs/guide/getting-started.md#l1--supervise-one-issue).

## Why sapwood

sapwood turns a GitHub backlog into governed autonomy, trusted repos
first — no worker holds the keys to its own review. Like sapwood in a
tree, it grows at the living edge and hardens into heartwood.

## Design principles

- **producer ≠ reviewer ≠ merger** — plugin-enforced for the guarded
  built-in tool family; documented MCP/host blind spots; branch protection
  + distinct merger identity are the deployment backstop.
- **GitHub is the process truth** — board/issues/PRs/checks are the queue.
- **fail-closed, not advisory** — a blocked action is denied, not advised.
- **deterministic engine, model tokens only on legs that need thought** —
  orchestration is plain TypeScript.
- **rare edges degrade to `needs-human`, never to more machinery** —
  low-probability edges get a human, not new code.
- **legible, ledger-checked recorded spend** — ceilings are checked
  against the ledger; non-decisive review attempts and subagent fan-out can
  stay unledgered (see [cost ceilings](docs/security/cost-ceilings.md)).

**Three sources of truth:**

- **GitHub** — cross-actor truth: board, labels, issues, PRs.
- **SQLite** — engine's own actions: dispatched, observed, spent.
- **Repository docs** — durable knowledge: what is true now.

See [Persistence](docs/dev-guide/06-persistence.md).

## How it is different

Claude Code is today's worker runtime — sapwood dispatches it as headless
sessions; sapwood is the loop and governance layer above the coding agent,
not a competitor to it.

| What sapwood states | What to ask any harness |
| --- | --- |
| Merge authority: the producer never calls merge; engine autonomous merges go through the merge driver; otherwise a human — or an operator session the owner has explicitly authorized — merges. | Who can call merge, and can the producer reach it? |
| Enforcement: fail-closed within the guarded built-in tool family; not a sandbox; documented MCP/host blind spots. | What tool surface is mediated, and what is ambient? |
| Queue & exit: GitHub holds process truth; trail survives uninstall and the runner machine. | Where does the queue live, and what remains after? |
| Control flow: deterministic TypeScript, not model-decided transitions. | Is scheduling code, or a prompt the model can argue around? |
| Interruption: soft-budget handoff (resumable) → kill switch drains → emergency stop hard-kills and sacrifices in-flight WIP. | What happens to in-flight work at the e-stop? |

See [`docs/security.md`](docs/security.md).

## Architecture

<!-- source: docs/assets/architecture.mmd — regenerate per docs/assets/diagram-style.md -->
![Architecture layers](docs/assets/architecture.svg)
GitHub holds process truth; the engine orchestrates and records dispatches and ledgered spend; a worker can push, and the fail-closed guard denies approve and merge within the guarded built-in tools; the reviewer's verdict gates the merge; a human can pause, drain, or stop at any tick.

<!-- source: docs/assets/round-loop.mmd — regenerate per docs/assets/diagram-style.md -->
![Round loop](docs/assets/round-loop.svg)
A round is a batch wrapped in peripherals: align, plan, execute under a round budget and lane caps, harvest, and a retrospective that can only propose — through a PR a human merges.

Round phases: `aligning → architecting → plan_review → executing →
harvesting → retro → closed`. Default board lanes: `Todo → Ready → In
Progress → Done` (names are configurable). More:
[05](docs/dev-guide/05-core-modules.md) ·
[06](docs/dev-guide/06-persistence.md) ·
[walkthrough](docs/reference/loop-walkthrough.md).

## Autonomy levels

Lower = safer, more human effort; higher = more autonomous.

| Level | Unattended | Merges | Watches | To step up |
| --- | --- | --- | --- | --- |
| [L0 — Observe](docs/guide/getting-started.md#l0--observe) | Nothing — read-only | n/a | — | Move to L1 (single issue) |
| [L1 — Supervise one issue](docs/guide/getting-started.md#l1--supervise-one-issue) | Claim, push, open PR, review (1 issue) | Human | Human | Restore round driver; human merge |
| [L2 — Delegate work, keep merge](docs/guide/getting-started.md#l2--delegate-work-keep-merge) | Full rounds, capped lanes | Human | Human | Trust review/CI, switch merge mode |
| [L3 — Governed unattended merge](docs/guide/getting-started.md#l3--governed-unattended-merge) | Full rounds, gated merge | Conductor | Human | Add an LLM watcher |
| L4 — LLM-supervised run | Full rounds, gated merge (as L3) | Conductor (or an explicitly authorized supervisor) | LLM | Top of the ladder |

L4 keeps L3's engine authority and adds a trusted LLM supervisor whose
scope is watching, recording, nagging, tripping pause/kill switch, and
clearing breaker parks with a reason — by default it never adjudicates a
merge; the owner may extend that by explicit session-start authorization;
`sapwood:human-merge-only` PRs stay a human's call — structural against
the engine's merge path, policy for an authorized operator session (see
[Governance lines](docs/guide/supervision.md#governance-lines)).

Human controls (pause/kill switch/e-stop) apply at every level
([Human controls](docs/security.md#human-controls-three-tiers)); L3/L4
need the [Trust model
prerequisites](docs/guide/getting-started.md#trust-model-prerequisites).

## Status

Implemented on main, pre-release: engine, guard, round orchestrator,
dashboard. Release chain (catalog, npm publish) in progress. See
[CHANGELOG.md](CHANGELOG.md) "Unreleased" and [PLAN.md "Current
milestone"](docs/PLAN.md#current-milestone).

## Documentation

- [`getting-started.md`](docs/guide/getting-started.md) — install,
  `sapwood init`, autonomy ladder.
- [`security.md`](docs/security.md) — trust/governance model.
- [`docs/README.md`](docs/README.md) — doc map.
- [`dev-guide/README.md`](docs/dev-guide/README.md) — contributor tour.

## Acknowledgements

Inspired by:

- [walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) — project-based course on harness engineering: the environment, state, verification, and control mechanisms that make coding agents reliable.
- [alchaincyf/loop-engineering-orange-book](https://github.com/alchaincyf/loop-engineering-orange-book) — free Chinese-language guide (橙皮书) to loop engineering: architecture, cost, and real-world agent loops; "design the system that prompts the agent for you".
- [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering) — patterns, starters, and a CLI for designing the control loop around coding agents ("Stop prompting. Design the loop.").
- [@AnatoliKopadze — what a loop is](https://x.com/AnatoliKopadze/status/2068328135611822149) — verify, state, and a stop condition as the three parts that turn repetition into a loop; the four-condition test for whether a task deserves one.
- [@0xCodez — from prompter to loop designer](https://x.com/0xCodez/status/2064374643729773029) — 14-step roadmap: when a loop pays for itself, the five building blocks, and a human gate before merge or deploy.
- [@0xCodez — graph engineering](https://x.com/0xCodez/status/2079165300625330317) — 14-step roadmap from a linear agent chain to a graph: nodes with contracts, edges as data, fan-out / verify / converge across a subagent fleet.

They inform the craft — methodological prior art, not sapwood's category
label.

## Contributing · Security · License

See [CONTRIBUTING.md](CONTRIBUTING.md) (workflow) and
[docs/dev-guide/](docs/dev-guide/README.md) (tour). Security:
[SECURITY.md](SECURITY.md).

[MIT](LICENSE).
