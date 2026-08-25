# sapwood — Goal & Plan

## Goal

**sapwood** packages the **autonomous development framework** — an AI-led,
GitHub-native, self-directed dev loop — as a TypeScript engine and ships it as a
**public, production-usable Claude Code plugin** so any repo can run
"GitHub issues in → reviewed PRs out" with a real governance layer.

**The product is the trust/governance layer, not a dashboard.** producer≠reviewer≠merger,
enforced by a fail-closed hook, is the thing no competitor (Sweep, OpenHands,
Copilot Workspace, Claude's own `/loop`) ships. We lead with that.

sapwood ships the generic method — the dev-loop mechanics, not application-specific
behavior tied to any one team's workflow.

**Headline:** "the autonomous coding loop with governance built in" — a
fail-closed safety layer (producer≠reviewer≠merger) + GitHub as the source of
truth + a configurable review chain. This is the durable differentiator;
governance is opinionated, so it's the part Anthropic/GitHub are least likely to
absorb (a real platform risk — see "Open items" below).

**Target user (v1):** a solo dev or small-team lead who actively uses Claude
Code, maintains a GitHub repo with a live issue backlog, and is comfortable with
AI opening PRs. **Trust context = trusted repos first** (your own / your team's),
where issue authors are trusted.

**Long-term arc:** evolve into a **governance layer for AI-led development** —
pluggable forge (GitLab/Gitea), pluggable reviewer, public-repo hardening
(untrusted-input safe), and a real supervisor. The forge
goal is deliberately scoped: v1 isolates GitHub calls, but its board, review,
check-ownership, search, relation, and sub-issue semantics are GitHub-shaped. A
second forge reuses the portable subset and semantically ports the rest; it is
not promised as an endpoint swap.

**Dogfooding is the proof and the pitch:** sapwood builds sapwood — ongoing
feature work is driven through sapwood's own loop. The flagship demonstration is
the dashboard (`dashboard/`, see [`dev-guide/07-dashboard.md`](dev-guide/07-dashboard.md)):
it is designed in full and built out, itself built by the loop it visualizes —
stronger evidence than any test suite that the loop handles real, non-trivial
work. History-*aggregation* metrics (cycle time, merge/rework rate) stay deferred to a
later phase, gated on GitHub-history extraction work that does not exist yet — see
[`frontend-design.md`](reference/frontend-design.md) for the full scope.

**What the framework does.** A 3-layer nested loop: `/loop` (harness) ⊃ `/dev-round`
(one full round A–E) ⊃ `/dev-loop` → the engine's `tick()` (one scheduling beat).

- **Work queue = GitHub itself**: a ProjectV2 board `Status` field + issue labels
  *are* the task state (no DB). All via `gh` CLI (REST + GraphQL).
- **Workers = headless `claude -p`** in isolated git worktrees, one per issue.
  Completion signaled by the wrapper writing `.done.json`/`.failed.json` sentinels
  — **not** the model's self-report (keep this; it's the robust part).
- **Safety core = fail-closed PreToolUse hook** enforcing **producer≠reviewer≠merger**.
- **State** = `data/sessions/run-state.json` + per-worker sentinels + per-round
  `metrics.json`/`events.jsonl`.

## Non-goals

Derived from what the sections below already scope out — nothing here is a new claim:

- **No in-engine capability/tool-permission management.** Producer legs inherit the
  operator's host Claude Code environment instead; no `capabilities.*` config surface
  will ever be built (Decision #11 below).
- **No second task-queue database or intake API.** GitHub itself — the ProjectV2 board
  + issue labels — is the work queue; sapwood adds no separate store or ingestion
  surface for tasks.
- **No automatic multi-generation decomposition.** A gate⓪ `too_large` or resume-cap
  trigger admits one oversized issue for one controlled split; a further pass over a
  remaining container is human-fired, never automatic recursion.
- **Not (yet) an untrusted-public-repo product.** Trust context is trusted-repos-first
  (Decision #3 below); public-repo hardening is on the long-term arc above, not shipped.
- **No dashboard-as-product.** The product is the trust/governance layer; the dashboard
  is a dogfooding demonstration, not what sapwood sells.

## Constraints (locked decisions)

This section holds the repo's own locked decisions — durable, numbered rulings later
work must not silently re-litigate. It is a different thing from the `## Constraints`
section of an **issue** body (the `feature.md`/`fix.md` templates, po-decompose's cut
guidance): an issue's own Constraints name the hard limits *that one piece of work* must
respect, not a pointer back here.

**producer ≠ reviewer ≠ merger** is the one constraint every decision below is read
against: the worker that writes code never approves or merges it, enforced
structurally by the fail-closed guard hook (`guard.ts`), not by a prompt — production,
gate②'s fresh non-author review, and the Conductor's merge stay in separate hands no
matter how the round loop (see "Architecture" below) is shaped. Every path listed in
[`docs/security.md`'s "Human-merge-only paths"](security.md#human-merge-only-paths) is
human-merge-only; that list is authoritative and is not paraphrased here.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Form factor | Claude Code plugin (full bundle: skills + commands + hook + engine) |
| 2 | Engine language | TypeScript (whole stack) |
| 3 | Trust context | **Trusted repos first**, architected toward public-repo hardening |
| 4 | Dashboard | Deferred past v1, now shipped in v0.2 (`dashboard/`, [`dev-guide/07-dashboard.md`](dev-guide/07-dashboard.md)). v1 shipped a CLI/terminal status view first, validating demand before building it. |
| 5 | Default merge gate | **Autonomous-merge gated on a fresh, different-model PR review** — gate① CI green + gate② a fresh non-author review → the Conductor merges (producer≠merger). Reviewer is pluggable: the local **engine-agent** session (Decision #10 — **default**), hosted different-model Codex, same-model-trusted, or human; **produce-PR-and-stop** remains selectable when a human must merge. |
| 6 | Method | TDD + two-gate + taxonomy as overridable defaults |
| 7 | Config format | **YAML default** — `sapwood.config.yaml`, hand-edited with inline comments (serves "易读易配置"). Zod-validated after parse. The YAML parser also reads JSON for free (YAML ⊃ JSON), so `.json` works with zero extra code; no separate `.ts` config. |
| 8 | Dispatch readiness | **An issue is not `Ready` until it carries a verification plan** — acceptance criteria + how to prove them (tests to write/run, commands, observable outcomes). Authored by the issue author/triage *before* the producer starts (keeps producer≠author). Enforced at the `Ready` gate (`getReadyIssues` refuses issues without one) **and** re-checked by the reviewer at gate② (the PR must satisfy the stated plan). Inherently-unverifiable issues (docs/knowledge, chore) are labelled `verify:n/a` and use the round-close doc gate / a lighter definition-of-done instead, so the gate never blocks legitimate work. A **verification-plan-reviewer peripheral (gate⓪)** additionally reviews each plan's quality/feasibility post-`Ready`, pre-dispatch, in a session distinct from both the plan's author and the producer — presence alone is not the bar; `getReadyIssues` requires the plan **and** its `plan:approved` label (fail-closed). `verify:n/a` is never self-declared: gate⓪ can only *propose* it, always paired with `needs-human`, and a human finalizes the adjudication by removing `needs-human` (→ doc-gate path). |
| 9 | Edge-case handling | **Rare edge cases degrade to `needs-human`, never to more machinery.** Automation covers the common path only; when a low-probability edge would require new hardening/persistence/recovery code, the correct handling is: preserve the evidence, label `needs-human`, stop. First application: the drain path never runs git in worker worktrees (sentinel-only handoff + dirty-worktree retention). |
| 10 | Engine-agent reviewer | **Engine-composed, static, different-Claude-model gate② session:** no producer-code execution/Bash; an engine-private, config-isolated checkout; runs serially after trusted CI and reruns only when needed; checkbox ACs receive engine IDs; configured and actual reviewer models must differ from the producer's; materializes the exact head from a private clone; includes instruction context but changes to configured instruction paths escalate to human review. The dispatch-time full-body/AC snapshot is authoritative session input; code-verifiable confirmation requires app-slug-bound `ci.requiredChecks`; `engine-agent` is primary-only (never a fallback) and has no fallback model. |
| 11 | Host-delegated capability management | sapwood delegates tool-permission/capability management to the host for producer (worker) legs, rather than managing capabilities in-engine. Producer legs officially **inherit the operator's host Claude Code environment** — settings sources, MCP servers, skills — as documented behavior. **No `capabilities.*` config surface will ever be built.** Scope is **producer legs only**: the reviewer/peripheral sealing floor (gate② seal, Decision #10) is untouched. Rationale: permission control is where complexity bugs live; config-surface complexity hurts UX; this is an LLM-core product and cutting tools cuts the model's hands; favor empowerment under the trusted-repos-first threat model (Decision #3). The engine keeps a small governance core instead — enumerated in [`docs/security.md`](security.md). Two host EXECUTION-PROFILE keys sit alongside this decision without reopening it: `host.permissionMode: dontAsk\|auto\|bypassPermissions` (default `auto`) and `bashSandbox: host-managed\|required` (default `host-managed`) — a profile key configures HOW a session's already-granted tools reach the host, never WHICH tools a producer leg is offered. **Floor = governance core** (engine-configured; `required` is checked at CLI-init time only via `failIfUnavailable`; `bypassPermissions` triggers one guidance WARN, never an engine refusal); **allowances = host** (`allowedDomains`/`allowRead`/`allowWrite` stay in the operator's Claude settings; `required`+L1 additionally floors `excludedCommands` at the four git-remote-mutation verbs — push/fetch/pull/ls-remote; no domain/path allowance surface is added to sapwood YAML). Full mechanics, the seven-layer table, and the deployment-tier ladder: [`docs/security.md`'s "Execution profiles"](security.md#execution-profiles-host-permission-mode--bash-sandbox). **The `bashSandbox` axis is deferred pre-release** — no such config key ships and the engine injects no sandbox settings; the probed floor survives as the operator recipe in that same section; `host.permissionMode` stands exactly as specified. |
| 12 | Producer PR-opening ownership | **engine-open-PR is the ordinary path** for worker lanes — a worker's job ends at pushing its branch; the engine performs the forge-API PR-open from deterministic code, at reclaim (`forge.ts::associateLanePr` — branch known, no open PR on it, branch confirmed pushed via `probePushedBranch`, session over → the engine calls `forge.openPR` with an engine-authored body carrying the `sapwood:pr-owner` marker). The worker prompt does not instruct `gh pr create`; a worker that opens its own PR anyway (possible at credential tier L0, where the `gh` grant remains; structurally impossible at L1 — see docs/security.md's worker credential tiers) has it adopted via the marker, never duplicated. Motivated by the producer≠merger consequence of the L1 credential tier: a worker holding only a git-transport deploy key, no API credential at all, structurally cannot open a PR, making engine-open the only channel rather than an option. No engine git invocation targets a worker worktree on this path: `associateLanePr`'s forge calls are pure API writes. |

## Architecture

**Plugin layout:**

```
sapwood/
├── .claude-plugin/    # plugin manifest (skills, commands, hooks)
├── skills/            # dev-round, dev-loop
├── commands/          # /sapwood-init, /sapwood-run, /sapwood-status, /sapwood-stop ...
├── engine/            # TS orchestration engine
│   ├── src/loop/      # conductor, driver, round orchestrator, escalation sweep
│   ├── src/roles/     # worker, reviewer, merge-driver, architect, plan-review, peripheral
│   ├── src/review/    # convergence / review-layering
│   ├── src/retro/     # retrospective role + PR proposal digest
│   ├── src/guard/     # fail-closed PreToolUse hook
│   ├── src/config/    # sapwood.config.yaml loader (yaml→zod), doctrine
│   ├── src/state/     # SQLite (WAL) state + structured-output validation
│   ├── src/forge/     # IForge interface + GithubForge impl
│   ├── src/proxy/     # read-only forge MCP proxy
│   ├── src/util/      # shared helpers
│   ├── src/cli.ts     # `sapwood` binary: init / run / status / stop / validate
│   ├── src/index.ts   # package's public export surface
│   └── prompts/       # shipped role prompts (worker.md, fix.md, po.md, po-decompose.md, …)
├── dashboard/         # React dashboard (event schema, lane board, event feed, replay)
└── docs/              # getting-started, config ref, security model, dev-guide, troubleshooting
```

Maintained module map: [`dev-guide/02-repo-layout.md`](dev-guide/02-repo-layout.md) and
[`dev-guide/05-core-modules.md`](dev-guide/05-core-modules.md).

**Engine design notes**

- **`IForge` seam.** `GithubForge` implements 44 methods — ~25 portable primitives, ~19
  GitHub-specific (ProjectV2 lanes/fields, review-thread/raw-check models, `gh search`,
  sub-issues, GraphQL node IDs). A GitLab/Gitea port is a semantic port, not an endpoint swap;
  don't regroup while there is one implementation. No repo-specific hard-coding in config —
  board/label names and the trusted-reviewer login are all configurable.
- **SQLite (WAL) state** — atomic, single-writer-serial, concurrent reads for `sapwood status`;
  fully durable, so restart is always a clean resume.
- **Structured tick results** — a typed discriminated union, not a stringly-typed protocol.
- **Sentinel-based completion** + heartbeat/PID liveness + a soft-budget `.handoff` terminal
  state (work preserved, resumable) — see [security.md](security.md).
- **Drain before kill, always.** A stop signal asks workers to hand off first; a hard
  process-tree kill is the bounded `cost.drainWindowSec` last resort. Full three-tier model:
  [Human controls](security.md#human-controls-three-tiers).
- **Claude CLI coupling isolated in `worker.ts`** — every `claude -p` flag and cost parsing lives
  in one module; a pinned minimum CLI version is enforced (`MIN_CLAUDE_CLI_VERSION`) and
  floor-checked (`engine/scripts/check-claude-cli-flags.ts`).
- **Lifecycle:** the conductor ticks via `ScheduleWakeup` (session-bound; durable SQLite makes
  restart clean); `sapwood status` reads SQLite with no live session. A real supervisor
  (launchd/daemon) is a v1.1 item — see [supervision.md](guide/supervision.md).
- **Skill↔engine IPC** goes only through the `sapwood` CLI / a read-only state read, never
  bespoke SQLite coupling per skill.

Fully shipped; see [core-modules.md](dev-guide/05-core-modules.md), [security.md](security.md),
and [role-paradigm.md](reference/role-paradigm.md) — this chapter stays a map, not a
restatement.

**Fix loop (`fixing` lane state).** A gate②/CI finding routes to a bounded, mechanical rework
pass — `driving → fixing → driving` — before human escalation. Bounded by `lanes.prFixCap` and a
progress classifier (`review/convergence.ts`): a lane whose findings stop shrinking escalates to
`needs-human`. Full mechanism: [Fix-loop lane state](security.md#fix-loop-fixing-lane-state).

**The three-tier escalation model.** Humans intervene to *review*, never to *resolve reviews* —
three labels, each encoding exactly one fact:

| tier | written by | gate behavior | lane | queue |
|---|---|---|---|---|
| `hold` | human | WAIT | **held** (keeps its slot) | none (self-assigned, short) |
| `needs-human` | **engine** | ESCALATE marker | released | human queue; removal = sign-off |
| `blocked` | **engine** or human | veto | released | nobody's queue (external wait) |

`blocked` on a PR is the human veto channel — the merge gate matches `escalation.humanLabels`
against the PR's own labels before consulting any review/CI signal; a PR-level `hold` sits
between that check and every review signal, never interrupting an in-flight fix leg. Write-side
asymmetry is the audit trail: only `needsHuman`/`blocked` are ever engine-applied — a human
applies and removes `hold` themselves. Full mechanism: [Human controls](security.md#human-controls-three-tiers)
and [Human-merge-only paths](security.md#human-merge-only-paths).

### Security & trust posture

**Positioning.** sapwood makes autonomous development bounded, inspectable, recoverable, and
conservatively governed: models get broad read access within a recorded, metered scope, but
action capabilities stay bounded by role, the guard, engine validation, and review gates —
humans own why/what at `Ready`, the engine owns durable process and effects.

**The trust boundary is on the ACTION side, not the content side.** Issue/PR content is
semi-trusted, and every session is assumed corruptible by injection or drift; the safety claim
rests on what a session can *do*. The guard hook's fail-closed hard mode constrains worker
actions; producer≠reviewer≠merger keeps production, review, and merge in separate hands;
issues-only peripheral sessions hold a shared read-only, worktree-confined, no-shell grant with
no forge credential — the engine alone writes, from validated structured output. Full mechanism:
[Issues-only role sessions](security.md#issues-only-role-sessions-read-only-worktree-confined-no-shell).

**The guardrail/shackle criterion.** A mediation design must never deny a session evidence AND
still demand a definitive judgment from it — that's a shackle; a guardrail pairs denial with a
first-class abstention/escalation path instead, which is why sapwood ships an engine-hosted,
read-only forge MCP proxy, widening what a session may ask for without ever forcing a verdict.
Full contract: [forge MCP proxy](security.md#the-forge-mcp-proxys-role-x-tool-matrix).

**Ambient repo context — record, don't seal.** Every session runs inside a real repo worktree
and legitimately absorbs its `CLAUDE.md`/auto-memory; sealing it would move the trust boundary to
the content side, so it was rejected — every session instead assembles a **context manifest**
recording every source absorbed. Full model: [record, don't seal](security.md#ambient-repo-context-record-dont-seal).

**Validation depth ∝ decision weight.** Judgment enters the engine only through a role session's
validated structured output; the engine validates *format* and *permission*, never *decision
quality*, so the deeper the write a field drives, the deeper its validation must be — checked by
gate② on every "bring judgment in" change. Full principle and the write-inventory table:
[role-paradigm.md's "Validation depth ∝ decision
weight"](reference/role-paradigm.md#validation-depth--decision-weight-the-structured-output-write-inventory).

### Round orchestrator

A **round orchestrator** sits *above* the tick engine, wrapping peripheral roles (goal alignment,
architecture review, gate⓪ plan review, harvest, retrospective) around the existing dispatch loop
without rewriting it:

```
while True:
    if a final stop condition is met: break        # v1: stop.* config
    peripheral: goal alignment / decomposition       # PO role
    peripheral: architecture design / review         # architect role
    for lane in the parallel cap:                    # existing: lanes.max / roundDispatchCap
        await lane(round stop conditions)            # existing: cost.roundBudgetUsd
    peripheral: harvest (results roll-up)
    peripheral: retrospective / self-evolution
```

A round dispatches a batch, ticks the engine until it drains, runs the peripherals, then opens
the next — **`conductor.ts` is not rewritten**; a round is just another caller of `tick()`.

**Round bounds.** Round-level conditions (first hit ends *this* round) are the round budget
(`cost.roundBudgetUsd`), an opened-PR cap (`lanes.roundDispatchCap`), and a round milestone;
final-level `stop.*` conditions are preemptive — no new round opens, the current winds down, the
process exits. A driving lane's fix leg is exempt from `cost.roundBudgetUsd`. **The round pool**
— "this round's tasks" — is an explicit, bounded selection: the PO may select up to
`ceil(lanes.roundDispatchCap × round.poolFactor)` Ready issues during aligning, returning numbers
only; the **engine** applies the pool label. Default, or on degrade, the pool is the deterministic
top-of-candidates set. Full mechanics: [configuration.md](guide/configuration.md#round).

**Peripherals never review or merge, and self-evolution goes through a PR.**
`guard.ts`/`reviewer.ts`/`merge-driver.ts` stay fixed regardless of orchestration config; only
the kill switch skips a graceful exit's final harvest+retrospective pass. Peripheral phases
recover by rerun, not resume — a `rounds` ledger plus idempotent externalized GitHub artifacts
stand in for mid-conversation model state — and retro proposes any prompt/doc/config change
through that same gate② PR path; `worker.promptFile` gives it an addressable target.

**Ready-as-signature.** Moving an issue to `Ready` — confirming an `origin:agent` proposal or
leaving a human-authored body untouched — is a human signature endorsing that issue's why/what.
Past `Ready`, **dissent, not revision, is the only agent channel**: a role may raise a premise
concern but may not itself revise the why/what or hold up dispatch — the one place autonomy is
deliberately bounded by design.

**PO decomposition.** Splitting an oversized issue is engine-initiated: gate⓪'s `too_large`
decision, or the resume-cap CAPPED branch, triggers it; a human may still apply `split` directly,
but it's no longer the main path either routes around. Child kinds, the `Cut:` grammar, and the
full mechanics live once, in [`po-decompose.md`](../engine/prompts/po-decompose.md) and
[role-paradigm.md](reference/role-paradigm.md).

**gate⓪ — the verification-plan quality gate.** Decision #8 enforces plan *presence*; gate②
re-checks the PR against it; plan *quality* needs its own review first, and `verify:n/a` is
never self-declared. A **verification-plan-reviewer** peripheral runs post-`Ready`, pre-dispatch,
distinct from both the plan's author and the producer. Approve →
engine applies `plan:approved`; bounce → its comment briefs a scoped, self-healing plan-draft
dispatch; unverifiable → it only ever **proposes** `verify:n/a`, paired with `needs-human`, so a
human finalizes the adjudication. `getReadyIssues` requires the plan **and** `plan:approved`,
fail-closed. Scoped to the round pool with a freshness re-confirm at every entry —
**`plan:approved` means re-endorsed each round, not approved forever.** Full self-heal
mechanics: [The `plan:approved` label and gate⓪](security.md#the-planapproved-label-and-gate).

**The autonomy principle.** Humans decide only the *why/what* of an issue — moving it to
`Ready`; everything after is agentic, and rare edges degrade to `needs-human` (Decision #9), safe
because every agent decision is externalized — comments, labels, events — observable and
traceable. **Dispatch heuristic:** within equal priority, prefer lightweight issues first.

## Current milestone

M0–M4 are **delivered and closed**. **v0.2 — the round orchestrator + dashboard — is
the only open milestone**: peripheral roles, round summaries, and the dashboard are
built and shipping inside the npm package; the release chain (marketplace catalog,
publish gating) is in progress. See "[Round orchestrator](#round-orchestrator)"
above for the detailed design, the repository's
[milestones](https://github.com/herehigher/sapwood/milestones) for open work, and
[CHANGELOG.md](../CHANGELOG.md) "Unreleased" for a fine-grained view of recent work.

## Open items

- **Platform risk:** Anthropic/GitHub could ship native "issues → PRs." Mitigation =
  lead with governance depth + community, the part hardest to absorb.
- **Persistence / "who watches the supervisor":** v1 workers are session-bound (die on
  SIGHUP); durable SQLite makes restart clean and `sapwood status` surfaces dead workers, but
  nothing yet supervises the conductor process itself — a real supervisor (launchd/daemon) is
  the open v1.1 item. See [`docs/supervision.md`](guide/supervision.md) for the operator playbook that
  stands in for it today.
- **Naming:** "sapwood" communicates nothing to a stranger; revisit before public
  launch (minor, pre-launch).
- **Duplicate `Ready` issues (accepted and disclosed):** no role checks whether a
  human-authored `Ready` issue duplicates another open issue — align's dedup covers only
  the PO's own proposals, gate⓪ is barred from judging *why/what*, and architect reads a
  round's pool, not the backlog. Two duplicate `Ready` issues become two workers and two
  conflicting PRs. **Ruled: accept and disclose**, per Decision #9 (rare edge → no new
  machinery) and trusted-repos-first; a keyword-match dup warning at the gate would fire on
  unrelated issues sharing vocabulary, and a warning humans learn to ignore costs more than
  the duplicate. Stated for users in
  [`getting-started.md`](guide/getting-started.md#what-the-ready-gate-does-not-check-duplicates).
  Revisit only if a real run is actually bitten.
- **Comment-carried design guidance has no worker carrier (accepted-for-now, watch):**
  guidance left only in an issue/PR comment — an architect design note, a PO/human review
  thread on an engine-agent lane, any of it — never reaches a fix leg. `worker.md`'s dispatch
  prompt substitutes the issue body plus doctrine/labels/title and has no comment channel, and
  a resumed session keeps its original body regardless of what gets commented afterward.
  Carriers that do reach a worker: a body rebaseline (trips drift detection → re-approval →
  re-entry) or a RESOLVED review thread; an open thread cannot land guidance. **Ruled: no
  prompt-side patch** — worker legs are deliberately denied GitHub-read tool access
  (Decision #11), so a real fix is engine-side (fold guidance into the body, or an
  engine-computed prompt block). Same accept-and-document stance as the "Duplicate `Ready`
  issues" item above (Decision #9).
- **Multi-provider outlook (deliberately not scheduled):**
  mixing models *across platforms* per stage needs no rewrite — the seams already exist
  (per-stage `model`/`effort` config, the narrow spawn/jsonl/sentinel contract,
  engine-mediated writes, a reviewer tier already heterogeneous by Decision #5). Judgment
  roles would port cheaply behind a runner-adapter seam; code-writing workers are the
  expensive tail (each platform needs a guard-hook equivalent, security-reviewed,
  human-merge-only). If ever scheduled: sequence lightweight-first (roles before workers),
  and let no platform difference leak past the adapter layer into the conductor.
- **Verification:** the acceptance set (`npm run build && npm run typecheck && npm run test
  && npm run lint`) is the gate; the mechanisms this doc describes are pinned by the test
  suite, not restated here as a separate checklist. No test in this suite currently pins an
  end-to-end live-dogfood run against a real `claude`/`gh`; that remains a manual,
  pre-release check, not an automated one.
