# sapwood development guide

A contributor-facing tour of the codebase: what the pieces are, where they
live, how to run and test them, and which parts are dangerous to touch.
User-facing docs live under [../guide/](../guide/) ([getting-started](../guide/getting-started.md),
[configuration](../guide/configuration.md)) and [security](../security.md); this
guide is for people **changing sapwood itself**. Repository requirements are in the root [CLAUDE.md](../../CLAUDE.md); [CONTRIBUTING.md](../../CONTRIBUTING.md) covers how to land a change and where to find release guidance.

> Status tracks the engine at pre-v1. The dashboard is designed
> ([frontend-design.md](../reference/frontend-design.md)) and built — see
> [07](07-dashboard.md) for what exists.

## System architecture

The canonical architecture diagram lives in the
[root README](../../README.md#architecture) — one source, no sync burden across
translations. The shape in one paragraph: the **round driver** runs a governed
round (aligning → architecting → plan_review → executing → harvesting → retro),
driving the **conductor's tick loop** during execution; ticks dispatch one
headless **worker** per Ready issue into an isolated worktree under a
fail-closed **guard** hook, and reclaim finished lanes into the **merge gate**
(CI + independent review + a bounded fix loop). The engine's own GitHub
traffic crosses the **forge adapter**; a producer worker's job ends at
`git push` — the engine opens the PR itself once the branch is confirmed
pushed (adopting a worker-opened one instead of duplicating it, if the
worker's `gh` grant is still present and it opens one anyway), while judgment
roles get read-only forge evidence through a per-session **MCP proxy**. The
engine's own durable records land in **SQLite state**; wrapper evidence and
human controls stay on the filesystem (see [06](06-persistence.md)).

**The one invariant everything else hangs off:** producer ≠ reviewer ≠ merger.
The worker that writes code never approves or merges it; the guard hook
enforces this fail-closed at the tool-call layer, and the engine's
`MergeDriver` — driven by the conductor, never by a session — is the only
code path that ever calls merge.

Vocabulary (lane, tick, round, sentinel, gate②, harvest, handoff, park) is
defined behaviorally in [loop-walkthrough.md](../reference/loop-walkthrough.md);
skim it if a term below reads opaque.

## Guide sections

| Section | Covers |
| --- | --- |
| [01 — Tech stack](01-tech-stack.md) | Languages, runtime, dependencies, tooling choices and why |
| [02 — Repository layout](02-repo-layout.md) | Every directory, what owns what, core vs. hands-off areas |
| [03 — Running locally](03-running.md) | Install, build, first run, config, debugging a failed run |
| [04 — Test & quality commands](04-commands.md) | test / lint / typecheck / build, how tests are written here, CI |
| [05 — Core modules](05-core-modules.md) | Conductor, rounds, roles, forge, guard, proxy — where to look when changing behavior |
| [06 — Persistence layer](06-persistence.md) | Maintainer deep dive: every table, migrations, crash-consistency rules |
| [07 — Dashboard](07-dashboard.md) | Designed and built — what exists today, where it lives |
| [08 — Change-risk map](08-change-risk.md) | Human-merge-only surface, high-risk seams, rules that must survive any refactor |
| [09 — Plugin, commands & prompts](09-plugin-commands-prompts.md) | Plugin packaging, slash commands, role prompt assets |
| [10 — Releasing](10-releasing.md) | Versioning policy, the four-manifest lockstep rule, and the `scripts/release.ts` runbook |
| [11 — Writing for audiences](11-writing-for-audiences.md) | Target-repo vs. this-repo render location, the `#NNN` misresolution hazard, the edit rule, exemptions, and enforcement |

## Reading paths by task

| You want to… | Read |
| --- | --- |
| Get building and testing | 03 → 04 |
| Change scheduling / lane lifecycle | 05 (conductor, rounds) → 08 |
| Change gate or review behavior | 05 (merge gate) → 08 (most of it is human-merge-only) |
| Add or tune an autonomous role | 05 (peripheral roles) → 09 (prompts) → [role-paradigm](../reference/role-paradigm.md) |
| Change GitHub integration | 05 (forge adapter, proxy) → 08 |
| Touch durable state / recovery | 06 → 08 |
| Change a slash command or prompt | 09 |
| Debug a failed run or read `.sapwood/` output | 03 ("Debugging a failed run") → [Troubleshooting — Reading engine state at a glance](../guide/troubleshooting.md#reading-engine-state-at-a-glance) → 06 |
