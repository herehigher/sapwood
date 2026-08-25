# sapwood — Project Goals & Plan

## Context

**sapwood** packages the **autonomous development framework** — an AI-led,
GitHub-native, self-directed dev loop — as a TypeScript engine and ships it as a
**public, production-usable Claude Code plugin** so any repo can run
"GitHub issues in → reviewed PRs out" with a real governance layer.

**The product is the trust/governance layer, not a dashboard.** producer≠reviewer≠merger,
enforced by a fail-closed hook, is the thing no competitor (Sweep, OpenHands,
Copilot Workspace, Claude's own `/loop`) ships. We lead with that.

sapwood ships the generic method — the dev-loop mechanics, not application-specific
behavior tied to any one team's workflow.

## Current milestone

M0–M4 are **delivered and closed**. **v0.2 — the round orchestrator + dashboard — is
the only open milestone**: peripheral roles, round summaries, and the dashboard are
built and shipping inside the npm package; the release chain (marketplace catalog,
publish gating) is in progress. See "[v0.2 north star: the round orchestrator](#v02-north-star-the-round-orchestrator)"
below for the detailed design, the repository's
[milestones](https://github.com/herehigher/sapwood/milestones) for open work, and
[CHANGELOG.md](../CHANGELOG.md) "Unreleased" for a fine-grained view of recent work.

## Positioning & vision

- **Headline:** "the autonomous coding loop with governance built in" — a
  fail-closed safety layer (producer≠reviewer≠merger) + GitHub as the source of
  truth + a configurable review chain. This is the durable differentiator;
  governance is opinionated, so it's the part Anthropic/GitHub are least likely to
  absorb (a real platform risk — see "Key risks" below).
- **Target user (v1):** a solo dev or small-team lead who actively uses Claude
  Code, maintains a GitHub repo with a live issue backlog, and is comfortable with
  AI opening PRs. **Trust context = trusted repos first** (your own / your team's),
  where issue authors are trusted.
- **Long-term arc:** evolve into a **governance layer for AI-led development** —
  pluggable forge (GitLab/Gitea), pluggable reviewer, public-repo hardening
  (untrusted-input safe), and a real supervisor. The forge
  goal is deliberately scoped: v1 isolates GitHub calls, but its board, review,
  check-ownership, search, relation, and sub-issue semantics are GitHub-shaped. A
  second forge reuses the portable subset and semantically ports the rest; it is
  not promised as an endpoint swap.
- **Dogfooding is the proof and the pitch:** sapwood builds sapwood — ongoing
  feature work is driven through sapwood's own loop. The flagship demonstration is
  the dashboard (`dashboard/`, see [`dev-guide/07-dashboard.md`](dev-guide/07-dashboard.md)):
  it is designed in full and built out, itself built by the loop it visualizes —
  stronger evidence than any test suite that the loop handles real, non-trivial
  work. History-*aggregation* metrics (cycle time, merge/rework rate) stay deferred to a
  later phase, gated on GitHub-history extraction work that does not exist yet — see
  [`frontend-design.md`](reference/frontend-design.md) for the full scope.

## What the framework does

A 3-layer nested loop: `/loop` (harness) ⊃ `/dev-round` (one full round A–E) ⊃
`/dev-loop` → the engine's `tick()` (one scheduling beat).

- **Work queue = GitHub itself**: a ProjectV2 board `Status` field + issue labels
  *are* the task state (no DB). All via `gh` CLI (REST + GraphQL).
- **Workers = headless `claude -p`** in isolated git worktrees, one per issue.
  Completion signaled by the wrapper writing `.done.json`/`.failed.json` sentinels
  — **not** the model's self-report (keep this; it's the robust part).
- **Safety core = fail-closed PreToolUse hook** enforcing **producer≠reviewer≠merger**.
- **State** = `data/sessions/run-state.json` + per-worker sentinels + per-round
  `metrics.json`/`events.jsonl`.

## Locked decisions

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

## Architecture (v1)

**Plugin layout:**

```
sapwood/
├── .claude-plugin/          # plugin manifest (skills, commands, hooks)
├── skills/                  # dev-round, dev-loop
├── commands/                # /sapwood-init, /sapwood-run, /sapwood-status, /sapwood-stop ...
├── engine/                  # TS orchestration engine
│   ├── src/loop/            # conductor, driver, round orchestrator, escalation sweep
│   ├── src/roles/           # worker, reviewer, merge-driver, architect, plan-review, peripheral
│   ├── src/review/          # convergence / review-layering
│   ├── src/guard/           # fail-closed PreToolUse hook
│   ├── src/config/          # sapwood.config.yaml loader (yaml→zod), doctrine
│   ├── src/state/           # SQLite (WAL) state + structured-output validation
│   ├── src/forge/           # IForge interface + GithubForge impl
│   ├── src/proxy/           # read-only forge MCP proxy
│   ├── src/util/            # shared helpers
│   └── prompts/             # shipped role prompts (worker.md, fix.md, po.md, po-decompose.md, …)
├── dashboard/                # React dashboard (event schema, lane board, event feed, replay)
└── docs/                     # getting-started, config ref, security model, dev-guide, troubleshooting
```

See [`docs/dev-guide/02-repo-layout.md`](dev-guide/02-repo-layout.md) for the maintained module
map and [`docs/dev-guide/05-core-modules.md`](dev-guide/05-core-modules.md) for what each module
owns.

**Engine design notes**

- **`IForge` seam.** `GithubForge` implements 44 methods; ~25 are portable forge primitives
  (issues, comments, string labels, PRs/MRs, branches/commits/diffs, milestones, summarized
  CI/merge status) and ~19 encode GitHub semantics (ProjectV2 lanes/field mutations, the
  review-thread and raw-check models, `gh search` syntax, issue relations, native sub-issues,
  GraphQL node-ID operations). A GitLab/Gitea port would be a semantic port, not an endpoint
  swap; do not regroup the interface while there is exactly one implementation. Config carries
  no repository-specific hard-coding — `PROJECT_NUMBER`, owner kind, board lane names, and the
  trusted-reviewer login are all configurable per deployment.
- **SQLite (WAL) state** — atomic writes, no read-modify-write races. Conductor is
  single-writer-serial; WAL gives concurrent reads (for `sapwood status`). Fully durable → engine
  restart is always a clean resume. Schema is versioned (migration path).
- **Structured tick results** (a typed discriminated union), not a stringly-typed text protocol.
- **Sentinel-based completion** + heartbeat/PID liveness classification, plus a soft-budget
  `.handoff` terminal state (work preserved, resumable) — see [`docs/security.md`](security.md).
- **Kill switch / EMERGENCY_STOP drain before kill, always.** A stop signal asks in-flight
  workers to hand off gracefully first; a hard process-tree kill (`worker.ts` kills the whole
  detached process group, never a plain PID kill that leaves orphans running) is the bounded
  `cost.drainWindowSec` last resort, never the first response. Full three-tier model (PAUSE /
  KILL_SWITCH / EMERGENCY_STOP): [`docs/security.md`'s "Human controls (three tiers)"](security.md#human-controls-three-tiers).
- **Claude CLI coupling isolated in `worker.ts`**: every `claude -p` flag, the `stream-json` cost
  parsing, and `CLAUDE_BIN` discovery live in one module. A pinned minimum Claude Code CLI
  version is enforced/reported (`worker.ts`'s `MIN_CLAUDE_CLI_VERSION`,
  `loop/claude-version-startup-check.ts`); a manual floor-check script
  (`engine/scripts/check-claude-cli-flags.ts`) verifies the pinned floor offers every flag the
  engine emits, run when the floor or the engine's flag surface moves.
- **Lifecycle:** the conductor ticks via `ScheduleWakeup` (session-bound — a documented
  limitation; durable SQLite makes restart clean). `sapwood status` (the CLI, not a skill) reads
  SQLite directly and works with no live session; it detects a dead engine and prints the
  restart command. A real supervisor (launchd/daemon) is a v1.1 item — see
  [`docs/supervision.md`](guide/supervision.md) for the current operator playbook.
- **Skill↔engine IPC:** skills/commands talk to the engine only through the `sapwood` CLI / a
  read-only state read — never bespoke SQLite coupling per skill.

The scheduler (`conductor.ts`), worker lane (`worker.ts`), guard (`guard.ts`), review gate
(`reviewer.ts`/`merge-driver.ts`), cost ceilings, and the round orchestrator (PO / architect /
gate⓪ / harvest / retro peripherals wrapped around the tick engine) are all shipped; see
[`docs/dev-guide/05-core-modules.md`](dev-guide/05-core-modules.md),
[`docs/security.md`](security.md), and [`docs/role-paradigm.md`](reference/role-paradigm.md) for the full
mechanism — this chapter stays a map, not a restatement.

**Fix loop (`fixing` lane state).** A gate②/CI finding routes to a bounded, mechanical rework
pass — `driving → fixing → driving` — before human escalation, instead of folding straight to
`needs-human`. Bounded by `lanes.prFixCap` (a cost ceiling) and a separate progress classifier
(`review/convergence.ts`, the quality stop): a lane whose findings stop shrinking escalates to
`needs-human` before paying another round. Full mechanism, the precedence between a stalled
review and a byte-identical rerun, the adjudicated-re-raise finding filter, and the
`cost.roundBudgetUsd` fix-leg exemption: see
[`docs/security.md`'s "Fix-loop `fixing` lane state"](security.md#fix-loop-fixing-lane-state).

**The three-tier escalation model.** Humans intervene to *review*, never to *resolve reviews* —
three labels, each encoding exactly one fact:

| tier | written by | gate behavior | lane | queue |
|---|---|---|---|---|
| `hold` | human | WAIT | **held** (keeps its slot) | none (self-assigned, short) |
| `needs-human` | **engine** | ESCALATE marker | released | human queue; removal = sign-off |
| `blocked` | **engine** or human | veto | released | nobody's queue (external wait) |

Collapsing any two of these loses a bit: escalations would pollute the human queue with
external-dependency waits (`blocked`), and removing one shared label would sign off two unrelated
facts at once. `blocked` on a PR is the human veto channel — the merge gate matches
`escalation.humanLabels` (`needs-human` *and* `blocked`) against the **PR's own** labels before
consulting any review or CI signal. A PR-level `hold` sits between that check and every review
signal in `deriveGate`'s ordering — before `MERGE`/`WAIT_REVIEW`/`HANDLE_THREADS`/`FIXABLE`
alike — and never interrupts an in-flight fix leg (a hold only ever gates the *next* drive
decision). Write-side asymmetry is the audit trail: the engine never writes a hold label —
only `needsHuman`/`blocked` are ever engine-applied — a human applies and removes `hold`
themselves. Accepted, documented bounded blind spot (marginal-complexity principle: zero new
machinery over a perfect fix): the review-silence clock has no memory of a hold's own
start/end — while held it's suppressed outright, and once removed the very next tick resumes
counting off the same, unchanged trigger pin, so a hold outlasting `reviewer.escalateAfterSec`
can fire the escalation on the very first post-removal tick (a single, tick-scale-imprecise
evaluation, never a repeated burst). Full mechanism (the `human-merge-only`/`planless` labels
that round out the ESCALATE tier, the gated-reentry handshake): see
[`docs/security.md`'s "Human controls (three tiers)"](security.md#human-controls-three-tiers) and
[`docs/security.md`'s "Human-merge-only paths"](security.md#human-merge-only-paths).

## Security & trust model (trusted-first, designed toward public)

**Positioning statement.** sapwood makes autonomous development bounded, inspectable,
recoverable, and conservatively governed. Models receive broad read access within a recorded,
metered repository scope; action capabilities remain explicitly bounded by role, the guard,
engine validation, forge controls, and review gates. Humans own why/what at `Ready`; the engine
owns durable process and effects; models supply judgment without being treated as deterministic.
It does not make missing intent or missing evidence deterministic.

**The trust boundary is on the ACTION side, not the content side.** Under the trusted-repos-first
scope, issue and PR content is semi-trusted input, and every model session — worker or
peripheral — is assumed corruptible by prompt injection, hallucination, or drift; at the boundary
those causes are indistinguishable. The safety claim rests on what a session can *do*, not on
making everything it can *read* trusted: the guard hook's fail-closed hard mode constrains worker
actions, while producer ≠ reviewer ≠ merger keeps production, gate②'s fresh different-model
review, and the Conductor's merge in separate hands. Issues-only peripheral sessions carry a
shared read-only, worktree-confined, no-shell grant with no forge credential of their own; the
engine alone executes forge writes from schema-validated structured output. Full mechanism
(`checkReadContainment`, the allow/deny matrix): see
[`docs/security.md`'s "Issues-only role sessions"](security.md#issues-only-role-sessions-read-only-worktree-confined-no-shell).

**The guardrail/shackle criterion.** A mediation design for role-session information access must
never deny a request AND still demand a definitive judgment from the same session — that
combination is a shackle: it manufactures confidence from a session denied the evidence to earn
it. The alternative is a guardrail: explicit denial paired with a first-class
abstention/escalation path, so a session that cannot get evidence can say so instead of guessing.
This is why sapwood ships an engine-hosted, read-only forge MCP proxy — built to widen what a
session may ask for without ever forcing a verdict once it has asked. Full contract: see
[`docs/security.md`'s forge MCP proxy section](security.md#the-forge-mcp-proxys-role-x-tool-matrix)
and [`docs/configuration.md`](guide/configuration.md#proxy).

**Ambient repo context — record, don't seal.** Every session — worker or peripheral — runs
`claude -p` inside a real repo worktree and therefore legitimately absorbs that worktree's
`CLAUDE.md`, the user's global `CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt
sections, same as any interactive session would. Applying the action-side boundary above, sealing
this channel would be a *content*-side intervention, and the trust boundary stays action-side —
sealing it was considered and rejected. The obligation is honesty and diagnosability, not
isolation: every such session attempt assembles a **context manifest** recording every source it
absorbed. Full model and the isolation recipe (production never seals; only a throwaway benchmark
run does — `--bare` also disables hooks, and the guard hook is the actual safety boundary): see
[`docs/security.md`'s "Ambient repo context: record, don't seal"](security.md#ambient-repo-context-record-dont-seal).

### Validation depth ∝ decision weight (the structured-output write inventory)

**The principle.** Judgment flows back into the deterministic engine through exactly
one channel: a role session's structured output (a sentinel-delimited JSON block +
optional raw body — `structured-output.ts`, or, for `retro`, a fixed scratch file).
The engine validates *format* and *permission*, never *decision quality*. So as a
role's output gains **decision weight** — the moment its fields start driving a
dispatch-gating label, a config change, or dispatch order rather than an advisory
comment — the engine-side validation of that output **must deepen in proportion**.
Otherwise a de-facto conductor agent quietly reassembles itself through the
structured-output pipe, unnamed and ungoverned: the containment #110 bought by
removing every role's tool grants is only as strong as what the engine chooses to
honor from what those roles now *say*.

This inventory is the standing safety baseline. **Every future "bring judgment in"
change — a new role, a wider schema, a role output newly wired to a heavier write —
updates the table below in the same PR**, and gate② checks that it did. If a field's
decision weight rises a rung (comment → label → dispatch order → config), its
validation column must show a matching deepening (schema-only → schema + content
invariant → schema + cross-check against an engine-computed set / bound), or the
change doesn't ship.

This inventory's completeness is a checked fact, not a point-in-time citation that goes stale
silently: `engine/src/loop/write-inventory.test.ts`, driven off the declarative registry
`engine/src/loop/write-inventory-registry.ts`, asserts in CI that every structured-output session
whose validated output drives an `IForge` write has a row below (each row carries a
`<!-- sapwood:write-inventory-role:… -->` marker the test reads), and that every row names a real
one — bidirectionally, so neither a missing row nor an orphaned one can land unnoticed.
Each row: the role, which structured-output fields drive which `IForge` write, the validation
gating that write, and today's decision weight.

| Role | Output fields → engine write | Validation (`engine/src/…`) | Decision weight |
|------|------------------------------|-----------------------------|-----------------|
| **PO / decompose (#310)** <!-- sapwood:write-inventory-role:po-decompose --> | `outcome:"decomposed"` + bounded child set + coverage mapping → fence parent (`decomposed`, Todo, no round-pool), then `createIssue`, child governance labels/comments, `addSubIssue`, and one parent coverage comment. `outcome:"unresolved"` → advisory parent comment only. | `DecomposeOutputMetadataSchema` (strict two-branch union) + `validateDecomposeOutput`: `maxChildren`, exact body cardinality, unique titles, complete/in-range coverage and dependency indices, ready-child acceptance criteria + verification section, and honest planless remainder metadata. The proposal set is journaled before child creation and reconciled by body marker and receipts. | **Medium, pre-Ready** — the session chooses backlog child boundaries, but cannot make any child dispatchable: every child starts outside Ready; planless remainders also receive `needs-human`. The parent fence is engine-computed from the `split` signature — human-applied, or engine-applied by EITHER of two triggers (gate⓪'s early `too_large` decision or the late resume-cap CAPPED branch) — never session-selected. No per-round allowance gates either engine trigger. |
| **PO / aligning** <!-- sapwood:write-inventory-role:po-aligning --> | *align mode:* `issues:[{title}]` + per-issue bodies → `createIssue` + `addLabel(origin:agent)` + `addLabel(needs-human)` when planless + `addIssueComment` — `align.ts:291-304`. *triage mode:* `issue` + drafted body → `updateIssueBody` + `addIssueComment` — `align.ts:351`. *both modes:* optional `concerns:[{issue, reason}]` alongside the deliverable above → `addIssueComment` only, via `dissent.ts::postConcerns` (triage concerns dropped if their decision was itself discarded — stale-hash refusal / decision-lost) | *align:* `validateAlignOutput` (`align.ts:138`): `AlignMetadataSchema` (strict) + per-issue body split; **post-write plan check** — a planless creation earns `needs-human` at creation time (`align.ts:297-304`). *triage:* `validateTriageOutput` (`align.ts:184`): `TriageMetadataSchema` (strict) + issue match + non-empty body — **deliberately no plan invariant**: the drafted body is written via `updateIssueBody` first, then a plan-conditional success comment (`align.ts:351-356`); a still-planless draft records `triage-degraded` (no label, no success comment) and re-matches triage next round. *concerns:* `dissent.ts::validateConcerns` — **set cross-check**, same doctrine as harvest's below: every `issue` must be inside the session's own injected view — the rendered backlog-digest subset for ALIGN mode; the target issue ONLY for TRIAGE mode (matching the prompt's own contract) — or the whole batch is rejected; one concern per issue per session | **Low (pre-Ready)** — a created issue structurally cannot carry a dispatch label (engine applies labels, session has no channel); planless creations are fenced `needs-human`, planless triage drafts stay undispatchable via gate⓪'s `plan:approved` requirement; degrade proceeds (low stakes, next round retries). *concerns:* **lowest possible — comment-only, by construction.** No schema field a concern carries maps to any label/status/dispatch write path; delivery is idempotent by a deterministic marker (issue + a hash of the concern's wording **and** the concerned issue's body at post time, so a why/what edit re-arms the same worded concern — including an edit this SAME engine made, since the outcome, `body-changed`, deliberately carries no human-attribution claim). A missing durable receipt behind an already-live marker is reconciled in place rather than lost, and `dissent.ts::reconcileDurableConcerns` durably sweeps the SAME thing across the whole ledger every round — the backstop for a concern whose decision reached its terminal receipt before `postConcerns` ever delivered it — always attributed to that decision's own original round, never the round the sweep runs in. Adjudication (`closed`/`external-reply`/`body-changed`) runs as its own round-level scan, unconditional on `roles.po.enabled`; `closed` and `body-changed` are BOTH neutral/unattributed (the conductor's own `Closes #N` merges can close an issue exactly like a human would), leaving `external-reply` as the only outcome with any actor claim at all (and even that is "not this engine," never "a human specifically"). |
| **po-pool** <!-- sapwood:write-inventory-role:po-pool --> | `selected: number[]` (no BODY block) → round-pool label reconcile: `cfg.labels.roundPool` added to every issue in the validated target, removed from every OTHER open issue that carries it — `align.ts::reconcilePoolLabels`, called from `align.ts::runPoolSelection` (`align.ts:1638`). Opt-in via `roles.po.poolSelection` (default `false`); when off (the MAIN path), the target is the deterministic full candidate set with no session at all. | `align.ts::validatePoolSelectionOutput` (`align.ts:1360`): strict-schema (`PoolSelectionMetadataSchema`, `{selected: number[]}`) + cap bound (rejects if `selected.length > cap`) + duplicate rejection + candidate-set cross-check (every `selected` number must be in the digest's actually-RENDERED candidate set, `poolDigest.renderedCandidateNumbers`) — any failure rejects the WHOLE output, never a partial clamp/apply. A session that fails or invalidates twice degrades OPEN to the full deterministic candidate set (`pool-degraded` event), never an empty pool. | **Medium, bounded** — the session (when enabled) chooses a SUBSET of an engine-computed candidate set capped at `ceil(roundDispatchCap * poolFactor)`; it can never add an out-of-candidate-set issue nor exceed the cap. Round-pool membership is the effective dispatch-consideration set for this round's executing phase — the third rung of this section's own comment → label → dispatch order → config ladder — but carries **no** `Ready`/`plan:approved` effect of its own: gate⓪ (verification-plan-reviewer's row above) still separately gates every issue's actual dispatchability regardless of pool membership. |
| **architect** <!-- sapwood:write-inventory-role:architect --> | `contradictions:[{issue, severe}]` + design note + per-issue explanations → `addIssueComment(anchor, designNote)`; per contradiction `addIssueComment` + `addLabel(blocked)` when `severe` — `architect.ts:387-390` | `validateArchitectOutput` (`architect.ts:235`): `ArchitectMetadataSchema` (strict) + `parseArchitectBody` fail-closed sub-format parse (`architect.ts:190`; own-line `<<<CONTRADICTION #n>>>` markers, no embedded sub-delimiters) **+ set cross-check** — every flagged `issue` must be inside the engine-computed candidate set or the whole output is rejected before any write (`architect.ts:270-278`) | **Medium** — the `blocked` label gates dispatch of the flagged issue; the design-note comments are advisory. Validation matches: schema + structural body parse + candidate-set bound on the label target; the prose itself carries no truth check. |
| **verification-plan-reviewer** <!-- sapwood:write-inventory-role:verification-plan-reviewer --> | `decision`∈{approve, draft_request, verify_na, needs_human, too_large} + `issue` + optional body → `updateIssueBody` + `addLabel(plan:approved)` (approve); `addLabel(needs-human)`+`addLabel(verify:n/a)`+`addIssueComment` (verify_na); routes to drafter **and posts the reviewer brief via `addIssueComment`** before the drafter runs (draft_request); `addLabel(needs-human)`+`addIssueComment` directly, no drafter cycle (needs_human — reserved for a human-merge-only path that is a plan-wide prerequisite no redraft can route around, OR a dependency/toolchain adoption, a persistent schema/public-interface shape, an architecture-level choice, or an unstated non-functional target — neither is a wording gap a redraft fixes); `addLabel(split)`+`addIssueComment`, idempotent (no write, no event, if `split` already present), zero draft cycles spent (too_large — the gate⓪-early half of the SAME writer entry the resume-cap CAPPED branch uses) — `plan-review.ts::reviewOneIssue` | `validateReviewerOutput` (`plan-review.ts::validateReviewerOutput`): `VerificationPlanReviewerMetadataSchema` (a discriminated union, strict per branch — `too_large` alone requires the non-empty `evidence` field; every other decision rejects it) **+ content invariant** — `extractVerificationPlan` must find a plan in the approved body **+** issue-number match to the expected candidate | **High** — `plan:approved` is the gate⓪ dispatch key; a false approve dispatches an unverifiable issue. Deepest validation (schema + content + identity). |
| **verification-plan-drafter** <!-- sapwood:write-inventory-role:verification-plan-drafter --> | `issue` + body (revised issue body, required) → `updateIssueBody` only — `plan-review.ts:422` | `validateDrafterOutput` (`plan-review.ts:205`): `VerificationPlanDrafterMetadataSchema` (strict) + non-empty body + issue-number match **+ content invariant** — `extractVerificationPlan` must find a verification/acceptance section in the drafted body (`plan-review.ts:224-226`) | **Medium** — writes the body but **never** the `plan:approved` label (author ≠ approver); the reviewer must independently re-approve before dispatch, so the drafter's write is always re-gated. |
| **harvest** <!-- sapwood:write-inventory-role:harvest --> | `comments:[{issue, body}]` → `addIssueComment` only — `harvest.ts:347` | `validateHarvestOutput` (`harvest.ts:217`): `HarvestMetadataSchema` (strict) **+ set cross-check** — every `issue` must be in the engine's pre-computed `needsHumanIssues` set (`gatherRoundFacts`, fixed *before* the session); any out-of-set number fails the **whole** batch | **Low** — comment-only, and the session's target choice is **bounded** by the engine-computed set: it may brief any subset (including none — an empty `comments` array is valid) but can never add an out-of-set target. No labels, no dispatch effect — the set cross-check is the guard against write-target choice leaking beyond the engine's bound. |
| **retro** <!-- sapwood:write-inventory-role:retro --> | Scratch file (`.sapwood-retro-pr`), not the JSON block, three outcomes: `branch`/`title`/`body` → `openPR(branch, title, body)` (new proposal — `retro.ts::openProposalPR`); `update: <pr>`/`branch`/optional body → `updateIssueBody(pr, body)` ONLY, never `openPR` (repair to a PR retro itself opened — `retro.ts::updateProposalPR`; an empty body is a no-op, the push itself is the repair); `none` → no write. | `parseRetroScratch` (`retro.ts::parseRetroScratch`): fail-closed labeled-header parse + `invalidBranchReason` (no default-branch, no `..`, argv-safe) on either outcome. New-proposal path: **+ engine-side `forge.branchExists`** push verification before `openPR` (a session's push claim is never trusted). Update path: **+ target-identity check** — the PR must appear in `retro-digest.ts::gatherRetroPRLifecycle`'s own newest-5 read window (a fixed bound, not a full-history search) AND the scratch's branch must equal that PR's RECORDED branch, both checked BEFORE any forge call, **+** `forge.branchExists` **+** the branch's head must have moved since the last recorded push (`getPRStatus.headOid` vs. the recorded `head`, or a pre-existing legacy row with no recorded head — current head differs from base). Any mismatch degrades (`retro-pr-degraded`), never opens/merges/closes anything. | **Low at write, gate②-bound** — a proposal or a repair is *only* a PR (open or updated); it changes nothing until gate② (CI green + fresh non-author review) merges it. The heavy validation here is authenticity (branch really pushed, and — for an update — that PR really is one retro owns) and identity, not decision quality — correctly, since the merge gate owns the quality call. The update path adds no close/merge capability: a human still closes a PR whose finding retro reports as no longer standing. |

The rows below follow the round's own phase sequence (`round.ts`'s `SEQUENCE`: `aligning` — which
bundles decompose, then align/triage, then pool selection, in that order, as ONE round-phase slot
— then `architecting`, then `plan_review` [reviewer, then drafter], then `executing` [no
structured-output row of its own], then `harvesting`, then `retro`). That sequence is NOT a
weight ranking, and weight is not monotonic along it: `architect`'s **Medium** row sits below
`PO / aligning`'s **Low** one, for example. Reading the weight and validation columns TOGETHER,
for each row on its own terms, is the whole point. The one **High**-weight
output (verification-plan-reviewer's `plan:approved`) carries the deepest validation of any row
(schema + content invariant + identity); every other row's validation depth is matched to THAT
row's own weight, independent of where it sits in the pipeline — schema-only for a pure-comment
write, schema + a set/bound cross-check for a label whose target is engine-computed-bounded
(architect's `blocked`, harvest's comment target, po-pool's round-pool label), schema + a content
invariant only where the write is itself the dispatch key. A future change that adds a heavier
write behind lighter validation — regardless of which row it lands in — is exactly what this
principle exists to catch.

For the full per-role contract behind this table (responsibility, write-scope tier,
marker idempotency, output schema, escalation path) see
[`docs/reference/role-paradigm.md`](reference/role-paradigm.md).

## Onboarding / DX (v1)

Onboarding is a shipped, tested surface, not a plan item — see
[`docs/getting-started.md`](guide/getting-started.md) for the full walkthrough (`sapwood init`'s auth
preflight and idempotent provisioning, the `--dry-run` trust ramp, the L0–L3 autonomy ladder, and
the minimum doc set) and [`docs/configuration.md`](guide/configuration.md) for every config key it
writes or reads.

## Build sequencing (planning only)

See "[Current milestone](#current-milestone)" above.

## v0.2 north star: the round orchestrator

v0.2 introduces a **round orchestrator**: a layer *above* the tick engine that adds peripheral
roles (goal alignment, architecture review, gate⓪ plan review, harvest, retrospective) around the
existing dispatch loop, without rewriting it. This section is the durable record of that design.

**The model — a round is a batch, wrapped in peripherals:**

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

The round loop dispatches a batch, ticks the existing engine until that batch drains,
runs the peripherals, then opens the next round. **The tick engine (`conductor.ts`) is
not rewritten** — a round is a caller of `tick()`, the same relationship `driver.ts`
already has to it.

**Two-level termination.** Round-level conditions (OR'd, first hit ends *this* round, not the
run) are the round budget (`cost.roundBudgetUsd`) and an opened-PR cap
(`lanes.roundDispatchCap`), plus a round milestone/theme. Final-level conditions are `stop.*` —
preemptive: hitting one mid-round means no new round opens, the current one winds down, and the
process exits. Round-budget accounting anchors to a durable spend-ledger window opened with the
round, so opening/closing peripherals and worker legs count exactly once across crash/resume —
see [`docs/dev-guide/06-persistence.md`](dev-guide/06-persistence.md). A driving lane's fix leg
is exempt from `cost.roundBudgetUsd` outright (fix-loop mechanism, above) — round budget paces
new work, never finishing a PR already open.

**The round pool — explicit per-round task selection.** "This round's tasks" is an explicit,
bounded selection, not an open-ended per-tick query: the PO selects up to
`ceil(lanes.roundDispatchCap × round.poolFactor)` issues from Ready during aligning, returning
issue numbers only — the **engine** applies the pool label from validated output. With
`roles.po.poolSelection: false` (the default), or on session degrade, the pool is the
deterministic top-of-candidates set: the selection *bound* never depends on an optional role.
Full write-ahead/crash-recovery mechanics and the probe-signals registry that keeps a stalled
milestone from pinning rounds open forever: see [`docs/configuration.md`](guide/configuration.md#round)
and [`docs/troubleshooting.md`](guide/troubleshooting.md).

**Peripherals never review or merge.** The goal-alignment/PO, architect, gate⓪
verification-plan-reviewer, harvest, and retrospective roles read and write issues and docs only.
`guard.ts`, `reviewer.ts`, and `merge-driver.ts` stay fixed and non-configurable
regardless of orchestration config —
producer≠reviewer≠merger holds no matter how the round loop is shaped. A graceful exit
(a final stop condition, or the run simply ending) still runs harvest and retrospective
once before stopping, so a round's output is never orphaned — only the kill switch skips
peripherals outright.

**Recovery is rerun-not-resume for peripheral phases.** Workers keep the existing
handoff+resume model (code WIP is expensive to redo). Peripheral phases get a cheaper contract:
phase-level rerun, backed by a `rounds` ledger (round id, phase, status, artifact reference) plus
idempotent externalized artifacts on GitHub itself (marker comments/labels a rerun checks for
before re-posting) — never an attempt to restore a model's mid-conversation state, only its
externally-visible artifacts. What a fresh peripheral session "remembers" across rounds is never
conversational continuity — it is externalized institutional memory, held in artifacts a fresh
session re-reads as relevant to its own role, not a uniform feed every role consumes alike.

**Self-evolution goes through a PR, never a direct write.** When the retrospective role
proposes a change to a prompt, doc, or config, it opens a PR through the same gate②
path every other change takes — never a direct write to disk. This is why
`worker.promptFile` landed in v1: it gives the retrospective role a concrete file
to open a PR against, rather than an inline prompt with no addressable target.

**Ready-as-signature.** Moving an issue to `Ready` — whether confirming an `origin:agent`
proposal or leaving a human-authored issue's why/what untouched — is a human signature: it
endorses that issue's why/what regardless of who typed the body. Past that point, **dissent, not
revision, is the only agent channel past `Ready`**: a role that believes a `Ready` issue's
premise is wrong may raise it, but may not itself revise the why/what or hold up/reject dispatch.
This human confirmation step is the product, not a limitation to be automated away — it is the
one place autonomy is deliberately bounded by design, matching the positioning statement's
"humans own why/what at Ready" (Security & trust model, above).

**PO decomposition and issue granularity.** Granularity is a *how* decision, so splitting an
oversized issue is engine-initiated, not human-initiated: gate⓪'s `too_large` decision is the
early trigger (post-Ready, before a lane is ever spent) and the resume-cap CAPPED branch is the
late one (after a lane exhausts its resume budget); a human may still apply `split` directly as
an override channel, but it is no longer the main path either trigger routes around. The child
kinds (leaf / container / remainder), the `Cut:` grammar, and the full trigger mechanics are
defined once, in the shipped decompose prompt —
[`engine/prompts/po-decompose.md`](../engine/prompts/po-decompose.md) — and their per-role
contract in [`docs/role-paradigm.md`](reference/role-paradigm.md); this paragraph never restates them.

**gate⓪ — the verification-plan quality gate.** Decision #8 enforces plan *presence* (dispatch
refuses a plan-less issue) and gate② re-checks the finished PR against the plan — but plan
*quality*/feasibility needs its own review before a producer spends budget on it, and
`verify:n/a` is never self-declared. gate⓪ closes both holes: a **verification-plan-reviewer**
peripheral runs post-`Ready`, pre-dispatch, in a session distinct from both the plan's author and
the producer, holding no shell — it computes a decision only. Approve → the engine applies
`plan:approved`; bounce → the reviewer's comment becomes the brief for a scoped, self-healing
plan-draft dispatch (never a parked issue); judged inherently unverifiable → it only ever
**proposes** `verify:n/a`, always paired with `needs-human`, so a human — never the agent —
finalizes the adjudication by removing `needs-human`. Enforcement is fail-closed in code, never a
prompt: `getReadyIssues` requires the plan present **and** `plan:approved`; `needs-human`/`blocked`
never dispatch. Full self-heal mechanics (the plan-drafting session, the
`maxDraftCycles`-bounded cycle): see
[`docs/security.md`'s "The `plan:approved` label and gate⓪"](security.md#the-planapproved-label-and-gate).

**gate⓪ is scoped to the round pool, with a freshness re-confirm at every pool entry.** The
verification-plan-reviewer's candidate set is the round pool itself, not the whole Ready lane: an
unadjudicated pool member gets the full draft→re-review cycle; a member whose `plan:approved` was
granted in a **prior** round instead gets a lightweight, zero-forge-write **confirm** session
("does this plan still hold against current `main`?"), invalid/failed twice escalating
`needs-human` (this feature's one fail-closed gate, unlike the architect's degrade-open review); a
member approved **this round** is skipped outright; a `verify:n/a` member is untouched.
**`plan:approved` is no longer "approved forever" — it means approved when granted, re-endorsed at
every round-pool entry before dispatch.** Dispatch itself is unaffected: the executing phase's
pool-scoped forge wrapper still requires gate⓪-passed (`getReadyIssues`).

**The autonomy principle (governs gate⓪ and every future gate).** Humans decide only the
*why/what* of an issue — the act of moving it to `Ready` (including the initial confirmation of
`origin:agent` issues). Everything after `Ready` — plan drafting, plan review, execution,
acceptance — is agentic; the loop never hangs waiting for a human on the normal path, and rare
edges still degrade to `needs-human` (Decision #9). The precondition that makes this safe: every
agent decision is externalized — issue comments, labels, the round ledger, structured events —
observable and traceable, so a human can watch and intervene on unexpected behavior rather than
being polled for routine approval.

**Dispatch heuristic:** within equal priority, prefer lightweight issues first.

## Key risks / watch items

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

## Verification (how we'll prove v1)

Covered by the acceptance set (`npm run build && npm run typecheck && npm run test && npm run
lint`) plus the live-dogfood/session-death/soft-budget/hard-ceiling drills documented in
[`docs/dev-guide/03-running.md`](dev-guide/03-running.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) — not restated here.
