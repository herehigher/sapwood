# Role sessions

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for the worker denylist, the peripheral allowlist, and issues-only role sessions.

## Worker denylist vs. peripheral allowlist: deliberate asymmetry

Issues-only peripheral sessions have a fixed, narrow contract — inspect, return one structured
message, let the engine write — so `peripheral.ts` can deny `Bash` and every write tool outright.
A code-producing worker must run an arbitrary repo's own compiler/test/git tooling, so no portable
positive list of executables exists without either blocking real work or admitting general
interpreters equivalent to open-ended execution: sapwood treats worker Bash as broad and denies
the specific governance actions and protected paths a producer must never reach.

The asymmetry is compensated, but not erased, by independent controls:

- `peripheral.ts::ROLE_ALLOWED_TOOLS`/`peripheralSessionEnv` — every issues-only role gets
  `Read,Grep,Glob` only, no `gh` grant, forge credentials stripped; all forge writes go through
  validated engine code.
- `worker.ts::WORKER_ALLOWED_TOOLS`/`WORKER_ALLOWED_TOOLS_NO_GH` — an L0 leg gets `Bash(gh *)`
  (see [Worker credential tiers](credential-tiers.md#worker-credential-tiers)); a credential-free
  or L1-active leg drops it via `workerCredentialFreeEnv()` on every leg (dispatch/resume/fix),
  composing any deploy-key transport overlay onto that same stripped base.
- That environment is still not a filesystem sandbox: Bash still runs with the operator's real
  home directory and can read credentials stored there.
- `guard.ts::guardDecision` — judges the worker's actual Bash argv independently of CLI permission
  patterns, tokenizing fragments/substitutions to reject opaque execution (`eval`, shell `-c`,
  process substitution) and to block direct merge/approve/label/project-board mutations; it also
  confines guarded read-tool paths to the worktree and fails closed on malformed input.
- `worker.ts::WORKER_DISALLOWED_TOOLS` — denies `gh pr merge/ready/review`, `gh release`, and the
  governance-signal verbs `gh issue edit`, `gh label`, `gh project` at the permission layer, each
  whole-verb (broader than the guard's own narrower argv block on `gh pr review`/`gh release`);
  ordinary comment/view/title-body `gh` usage stays open.
- `guard.ts::checkGhApi` — judges `gh api` REST/GraphQL calls by argv shape (mutating
  endpoints/ProjectV2 field writes blocked); read-only `gh api` is deliberately not deny-listed,
  since no prefix rule can separate it from a mutation.
- `worker.ts::WORKER_DISALLOWED_TOOLS` (MCP denies) — server-granularity deny for known
  forge-authority/write-exec-class MCP servers (`mcp__github__*`, `mcp__server-filesystem__*`,
  `mcp__filesystem__*`, `mcp__Google_Drive__*`); a differently-named MCP server is the accepted
  blind spot this list does not cover — branch protection is the platform backstop, and a
  managed-settings host can void this whole list too (see [Managed-settings
  exception](#managed-settings-allowmanagedpermissionrulesonly-exception) below).
- `worker.ts` never adds `.sapwood/` as a Claude tool root; not Bash containment (worker Bash can
  still reach `../../.sapwood`), the residual the [Sentinel isolation
  boundary](../security.md#sentinel-isolation-boundary-honest-statement) documents.
- `merge-driver.ts`/`forge.ts::--match-head-commit` — merge authority is a separate choke point
  the worker has no reference to, reachable only after CI/review gates and a final fresh decision.

This is targeted governance containment, not general Bash containment: the denylist does not
prove an unrecognized command harmless, inspect script bodies, confine subprocess filesystem
access, or stop a socket opening — including data exfiltration, covered instead by [Worker network
egress](egress.md#worker-network-egress-bash-channel-containment-available-as-a-hardening-profile)'s
post-hoc lexical tripwire.

## Issues-only role sessions: read-only, worktree-confined, no shell

The round orchestrator's issues-only peripheral roles (verification-plan-reviewer/-drafter, PO
align/triage/pool, harvest, architect) hold no `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`
grant — their only output is a structured final message, validated by
`plan-review.ts`/`align.ts`/`harvest.ts`/`architect.ts` against a per-role schema and written via
`IForge`. A malformed or out-of-candidate-set output rejects the WHOLE output, retries once, then
hits the role's degrade path (gate⓪ → `needs-human`; advisory roles degrade-and-proceed durably).

**READ side:** `peripheral.ts::ROLE_ALLOWED_TOOLS` grants `Read`/`Grep`/`Glob` to every one of
these roles, architect included (reading is not producing/approving/merging). The real boundary is
`guard.ts::checkReadContainment`, resolving every read call's target against the session's own
`SAPWOOD_WORKTREE_ROOT` and blocking anything resolving outside it (absolute host path,
`../`-traversal, symlink escape) — regression- and live-probe-verified; a probe run without this
containment found exactly those two escape shapes leaking real host file content.

**WRITE/exec side:** `peripheral.ts::ROLE_DISALLOWED_TOOLS` denies `Write`/`Edit`/`MultiEdit`/
`NotebookEdit` and a blanket `Bash` via `--disallowedTools`, winning over allow from ANY source
(incl. a target's own `.claude/settings.json`) — with the one exception at [Managed-settings
exception](#managed-settings-allowmanagedpermissionrulesonly-exception). No shell exists here, so
older per-pattern `gh`-flag bypasses are moot; per-role deny constants are byte-identical to the
base, regression-tested. Read-only git stays excluded — the blanket deny covers it.

### Managed-settings `allowManagedPermissionRulesOnly` exception

Every containment from `--disallowedTools` is a CLI-argument permission rule, voided by managed
settings with `allowManagedPermissionRulesOnly: true` — silently, since `guardDecision()` never
sees it. The ruling is **disclose + detect-and-WARN**, not refusal; the warning names both exits.

- **Operator exit 1 — mirror the deny rules into managed settings.** Add sapwood's own deny
  set to the managed-settings `permissions.deny` list yourself, so the SAME containment is
  enforced by the layer that mode actually respects: `Bash`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, `Agent`, `Task` (peripheral roles' `ROLE_DISALLOWED_TOOLS`/`RETRO_DISALLOWED_TOOLS`
  above) plus the worker's narrower `gh` subcommand denies (`WORKER_DISALLOWED_TOOLS`:
  `gh pr merge`/`gh pr ready`/`gh pr review`/`gh release`/`gh issue edit`/`gh label`/`gh project`)
  if the worker also runs on this host.
- **Operator exit 2 — consciously accept the posture.** Do nothing, knowing that on this host
  sapwood's CLI-argument containment is void and the guard hook's argv-shaped checks are the
  only defense left standing.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| `allowManagedPermissionRulesOnly: true` emits ONE warning per start; unreadable/absent settings fail open. | `managed-permission-warning.ts::detectManagedPermissionMode` | `managed-permission-warning.test.ts` |
| `Agent`/`Task` denied for peripheral roles + gate② (`retro` has its own constant) — the code-producing worker deliberately retains spawn capability. | `peripheral.ts::ROLE_DISALLOWED_TOOLS`; `worker.ts::WORKER_DISALLOWED_TOOLS` | `peripheral.test.ts`; `worker.test.ts`: "#552 decision …" |
| Every `RoleRunner` session drops forge credentials, keeping Anthropic auth + guard mode. | `peripheral.ts::peripheralSessionEnv` | `peripheral.test.ts` (poisoned-parent-environment case) |
| `retro`: `Read`/`Grep`/`Glob` + local git, zero `gh`; digest read; engine-verified `openPR()` write. | `retro.ts`; `retro-digest.ts` | `retro.test.ts`; `retro-digest.test.ts` |
| gate⓪ shares the universal read-only baseline; verdict comes from structured output only. | `plan-review.ts` (`CONFIRM_ALLOWED_TOOLS`/`CONFIRM_DISALLOWED_TOOLS`) | `plan-review.test.ts` |

**Boundaries**

This deny is a name-list of the ONE known spawn channel over a CLI-defined, version-drifting tool
surface, never a claim the session's capability set is closed — a future CLI version could rename,
add, or remove a spawn-shaped tool. The cited tests prove only that `Agent`/`Task` are listed as
denied, not that no other spawn-shaped tool exists. It is scoped to the `claude` executor;
`codex-exec` differs (a read-only sandbox). Worker spawn decision + cost: [the design
record](../design/security-issues-only-derivations-2026-08.md#origin-issues-only-role-sessions--the-workers-spawn-capability-decision-and-its-cost-measurement) —
accepted, unbounded blind spot.

### The forge MCP proxy's role x tool matrix

`RoleRunner` sessions and worker legs can be attached (config-gated, default ON) to a revocable,
read-only forge MCP proxy returning sanitized data verbatim; review sessions are exempt. Nine
issues-only roles share four issue tools; `worker` gets the PR-facing set; others get none —
deny-by-default, frozen (`proxy/access.ts::PROXY_ROLE_TOOL_MATRIX`, `access.test.ts`). The matrix
is enforced server-side, fail-closed, in `mcp-server.ts::handleToolCall`; the CLI's own
`--allowedTools` widening is noise reduction only. This ten-role grant is deliberate (zero calls ≠
unneeded) — see [the design
record](../design/security-issues-only-derivations-2026-08.md#origin-the-forge-mcp-proxys-role-x-tool-matrix--the-ten-role-grant-is-deliberate).

| Invariant | Enforcement | Test |
| --- | --- | --- |
| `resume()`'s proxy attachment mirrors `dispatch()`'s byte-for-byte (mint-before-argv, `--allowedTools`, `--mcp-config`, `credentialFree` policy, teardown); on `credentialFree` mint failure, resume never deletes the jsonl/`.handoff` sentinel, preserving resumability. | `worker.ts` (`WorkerSupervisor.resume`) | `worker.test.ts` |
| `workerCredentialFreeEnv()` severs `gh`'s and git's on-disk credential lookup and narrows `--allowedTools` to drop `Bash(gh *)`. | `worker.ts::workerCredentialFreeEnv` | `worker.test.ts` |
| `--strict-mcp-config` makes the MCP config exclusive under `credentialFree`, so ambient host MCP servers never load — closing a gap worse than the disk-read residual below (network vs local-disk). | `worker.ts` (`dispatch()`/`resume()`) | `worker.test.ts` |
| A `credentialFree` mint failure REFUSES dispatch outright; an ordinary mint failure is non-fatal (lane dispatches unattached). Either way: a durable `proxy-mint-failed` event. | `worker.ts` | `worker.test.ts` |

**Boundaries**

- **HONEST SCOPE — this is NOT full isolation.** `workerCredentialFreeEnv` and the MCP seal do not
  confine a fix leg's `Bash(node *)`/`Bash(npm *)` disk reads — the lane runs with the operator's
  REAL `$HOME`. A live PoC (`steal.mjs`) confirmed this by reading `~/.config/gh/hosts.yml` and
  successfully authenticating to GitHub with the credential found there, bypassing every env var
  `workerCredentialFreeEnv` touches; the PoC narrative and the two rejected mitigations are in [the
  design
  record](../design/security-issues-only-derivations-2026-08.md#origin-honest-scope--this-is-not-full-isolation--the-stealmjs-proof-of-concept-and-rejected-mitigations).
- The upgrade path for a boundary that's actually closed is OS-level sandboxing (the
  operator-configured Bash-sandbox recipe — see [Execution
  profiles](execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox)) or a
  dedicated CI identity (unimplemented); `gh`'s plaintext `hosts.yml` is the sharpest instance of
  this risk, untouched by macOS's default OS-keychain storage.
- `workerCredentialFreeEnv()` alone gives no filesystem confinement; the Bash-sandbox recipe
  OS-blocks reads of its `denyRead` paths (`EPERM`-probed live) — without it there is no such
  guarantee, and even with it, unlisted/additive `allowRead` paths remain residuals.

#### Worker-leg user-settings persistence vector — detect & disclose

One specific consequence of the HONEST SCOPE residual above: `worker.ts`'s `claudeArgs` passes no
`--setting-sources` on ANY worker leg, so an ordinary worker session loads every file-based
settings source — project, local, AND the operator's own `~/.claude/settings.json` (review-session
mode closes exactly this with `--setting-sources ""`). Because a worker leg's `Bash` runs with the
operator's REAL `$HOME`, a producer leg in round N can write `~/.claude/settings.json` (permission
grants, hooks, `apiKeyHelper`), and every LATER worker leg inherits whatever that write left
behind.

**Startup detection and disclosure is what ships (arm 2)** — two other arms (pinning
`--setting-sources`; docs alone) were rejected; see [the design
record](../design/security-issues-only-derivations-2026-08.md#origin-worker-leg-user-settings-persistence-vector--arms-considered-and-rejected).
`user-settings-watch.ts::createUserSettingsWatch` hashes the settings file at startup, comparing it
each tick; a changed hash or containment-weakening key (`apiKeyHelper`, `hooks`) logs one WARN and
a durable event — never blocks. This closes nothing structurally; the broader residual stays open.

#### Role-session skill injection — an accident fence, not a jail

`skills-plugin.ts::extractMarkedSection` renders two v1 reference skills (`human-merge-only-paths`,
`ac-evidence-tiers`) verbatim from `docs/security.md`'s marker-delimited sections into an
immutable, content-hash-named plugin directory, attached via `claude --plugin-dir`. Content-side
only — input is only `docs/security.md`, never issue/PR-derived text — and a published hash
directory is never overwritten (an accident fence, not a jail: the goal is to stop a mistake, not
withstand an adversary who already has code-execution authority in the same repo).

A third skill, `sapwood-labels`, is rendered from `labels.ts::LABEL_SEMANTICS` against this repo's
resolved `cfg.labels`/`cfg.escalation.*` — never a `docs/security.md` marker — so it always shows
RESOLVED label names and each label's ACTUAL dispatch-hold/merge-veto membership (via the same
predicates `forge.ts::isDispatchable` and the merge gate use), never fixed prose. It closes three
incidents: a self-applied `human-merge-only`, an unlogged architect label-block, and supervisor
label-timeline misreads.

**Injection policy** (`skills-plugin.ts::shouldInjectSkillsPlugin`): every worker leg and
non-review peripheral session gets `--plugin-dir` when `roles.skills.enabled` is `true` (default
`false`); a review-mode session never does, enforced structurally in `RoleRunner.run()`.

**Boundaries**

- The guard's `.sapwood/` write-deny rule ([Sentinel isolation
  boundary](../security.md#sentinel-isolation-boundary-honest-statement)) covers a published
  role-skills hash directory like any other runtime-root path — narrowed to three classes, not
  machinery-closed: inherited MCP write tools never reach the guard hook; symlink aliasing is
  judged lexically; opaque indirection (an env-assignment token, a hardcoded path) is invisible to
  the same argv-only judgment.

### Fix-loop `fixing` lane state

The producing worker gets its own lane state to address review findings itself, before human
escalation, without ever handing it a new dispatch or forge credentials — routing findings
straight to `needs-human` would ask a human to *resolve* a review rather than adjudicate it; see
[the design
record](../design/security-issues-only-derivations-2026-08.md#origin-fix-loop-fixing-lane-state--why-a-new-lane-state-instead-of-needs-human)
for the fuller argument.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| A `driving` lane transitions to `fixing` via `resume()`; `fixing` occupies dispatch capacity exactly like `running`/`driving`. | `conductor.ts::startFixLeg` (transition); `state.ts::activeWorkers` (capacity count) | `conductor.test.ts`: "startFixLeg: transitions driving -> fixing, bumps fix_rounds, resumes the SAME lane (never a fresh dispatch — squash-branch-reuse hazard)" |
| `fix_rounds` (rework rounds) and `resume_attempts` (budget-exhaustion handoffs) are independent counters — starting a fix leg never touches `resume_attempts`. | `state.ts` schema v18→v19 (`workers.fix_rounds`); `conductor.ts::startFixLeg` | `conductor.test.ts`: "startFixLeg: fix_rounds is independent of resume_attempts …" |
| The `fixing → driving` edge (on any terminal outcome) clears the review-trigger pin, forcing a fresh review on the fix leg's new head. | `conductor.ts::reclaimTerminalLane` | `conductor.test.ts`: "tick FIXING RECLAIM + DRIVE, same tick: once a fixing lane lands back in driving with a cleared pin, the SAME tick's DRIVE loop re-triggers a fresh review on the new head" |
| A `fixing` lane is a live worker process under the SAME supervision as `running`, but invisible to the DRIVE loop — why the review-silence escalation cannot arm while a lane is fixing. | `state.ts::drivingWorkers` / `fixingWorkers` | `state.test.ts`: "fixingWorkers returns only state=fixing rows, disjoint from drivingWorkers …"; `conductor.test.ts`: "tick DRIVE: #170 review-silence escalation is provably NOT armed during `fixing` …" |
| With `prFixCap > 0`, ordinary findings route to `fixing` instead of a `failed`+PR row (fix_rounds cap escalation is the only other producer); at `prFixCap: 0` they fold directly to HUMAN instead. | `merge-driver.ts::deriveGate`; `conductor.ts::driveDecision`; `state.ts::gatedFailedWorkers` (doc) | `merge-driver.test.ts`: "MergeDriver.driveOne (#246): prFixCap: 0 -> unresolved findings (HANDLE_THREADS) still needs-human, byte-for-byte the pre-#246 path"; `conductor.test.ts` (fixable+under-cap dispatch fixtures) |
| An unresolved thread matching an already-resolved, non-outdated thread's (finding, span) key is an adjudicated re-raise, excluded from the blocking count. | `reviewer.ts::adjudicatedDuplicateThreads` | `reviewer.test.ts` (`adjudicatedDuplicateThreads` fixtures) |
| Same-tick fix-loop precedence is verdict-rerun → convergence-stalled → cap: a rerun wins outright; a stalled lane escalates before another fix round. | `conductor.ts` (verdict-rerun breaker); `review/convergence.ts` (progress classifier) | `conductor.test.ts`: "tick DRIVE (#457, F36): verdict-rerun breaker — a SECOND fixable for the SAME engine-agent verdictRunId dispatches NO fix leg …" |
| A driving lane's fix leg is exempt from `cost.roundBudgetUsd` (NEW dispatch only) but stays bounded by `lanes.prFixCap`/`worker.budgetUsdSoft`/the hard `cost.dailyBudgetUsd`. | `conductor.ts` (fix-leg admission path) | `conductor.test.ts`: "tick DRIVE (#375): fixable + round budget exceeded -> the fix leg is EXEMPT from cost.roundBudgetUsd …" |
| A fix leg's admission gate reads the genuine `.sapwood/PAUSE` sentinel only, never the wider `forceDispatchPause` flag — a round-level stop never blocks a fix leg alone. | `conductor.ts::fixLegAdmissionBlockReason` | `conductor.test.ts`: "tick DRIVE (#375 review round 2, P1): forceDispatchPause ALONE (no human PAUSE sentinel) does NOT block a FIXUP dispatch …"; "tick DRIVE (#375 review round 2, P1): a GENUINE human PAUSE sentinel (.sapwood/PAUSE, not forceDispatchPause) still blocks a FIXUP dispatch …" |
| Under `KILL_SWITCH`, a budget-blocked/capped/CI-wedged `driving` lane is terminal-for-drain past `cost.drainWindowSec` when `prFixCap > 0` — a lane with `fix_rounds: 0` and no CI wedge is left alone even under a daily-budget breach; at `prFixCap: 0`, EVERY driving lane is terminal-for-drain unconditionally. | `conductor.ts::drivingLaneTerminalForDrain` | `conductor.test.ts`: "tick: KILL_SWITCH drain — a driving lane mid-fix-loop (fix_rounds>0, under cap) blocked ONLY by the daily-budget ceiling is TERMINAL-for-drain too …"; "tick: KILL_SWITCH drain — a driving lane that never needed a fix leg (fix_rounds=0, e.g. MERGE/WAIT-gated) is left alone even past the drain window …" (both `prFixCap > 0` fixtures) |

**Boundaries**

- The fix leg's prompt (`worker.fixPromptFile`, default `prompts/fix.md`) instructs the worker to
  pull its own PR's review findings and CI-failure evidence via the PR-facing proxy tools, never
  via findings or CI-log text relayed through the prompt itself — no prompt-injection transport;
  `pr_failed_checks`' response is framed as untrusted CI/log data.
- A resolved thread whose code changed after resolution still reads as outdated and blocks again;
  an unresolved thread with no prior adjudication on its span still blocks; a standing
  `CHANGES_REQUESTED` still blocks; a review against a non-current head is excluded from both
  halves of the gate.
- The `roundBudgetUsd` exemption is uniform across every round/run-level stop reason: once any
  stop condition fires, new DISPATCH freezes, but a fix leg on an already-open PR is never "new
  dispatch" either way.
- At `prFixCap: 0`, `drivingLaneTerminalForDrain`'s own `fixRounds >= prFixCap` branch (`0 >= 0`)
  makes every driving lane terminal-for-drain unconditionally — a direct consequence of the
  function as written, not yet pinned by a named test at that specific input.
