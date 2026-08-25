# Role sessions

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for the worker denylist, the peripheral allowlist, and issues-only role sessions.

## Worker denylist vs. peripheral allowlist: deliberate asymmetry

The stronger-looking policy belongs to the narrower job by design. Issues-only peripheral
sessions have a fixed contract: inspect repository context, return one validated structured
message, and let deterministic engine code perform any forge write. They therefore need only
`Read`/`Grep`/`Glob`, and `peripheral.ts` can deny `Bash` and every write tool outright. A
code-producing worker has the opposite shape: it must edit arbitrary repositories and run their
particular compiler, package manager, test runner, generator, and git workflow. A portable
positive list of executable names would either reject ordinary build/test work or admit general
interpreters and package runners that are themselves equivalent to open-ended execution.
Sapwood therefore treats worker Bash as a broad capability and denies the governance actions
and protected paths the producer must never reach. The policy paradigm follows the role's
required capability shape, not its privilege rank.

The asymmetry is compensated, but not erased, by several independent controls:

- Compensating controls deny producer
  label, milestone, and project-board mutations while preserving comment channels;
  credential removal remains the endgame rather than a claim that argv
  inspection removes ambient credentials.
- `engine/src/roles/peripheral.ts` gives every issues-only role
  `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` and a cross-source veto over `Bash` and write tools,
  strips forge credential variables in `peripheralSessionEnv()`, and leaves forge writes to
  validated engine code. Those sessions have no `gh` grant. This is **not** true of every role at
  L0 (see [Worker credential tiers](credential-tiers.md#worker-credential-tiers) above for the full L0/L1
  picture): `engine/src/roles/worker.ts` gives an ordinary L0 coding leg `Bash(gh *)` and
  inherits the engine environment, though the stock worker workflow no longer uses it to open a
  PR: the worker's job ends at push, and the engine opens the PR itself once
  the session is over — the grant stays for the rest of ordinary `gh` usage
  (`gh pr comment`, `gh pr view`, `gh issue view`, …) and as the surface a worker could still
  reach for despite the prompt, which `associateLanePr` (`forge.ts`) adopts rather than
  duplicates. Credential-free fix legs remove that grant
  (`WORKER_ALLOWED_TOOLS_NO_GH`) and use `workerCredentialFreeEnv()` to strip token/config
  variables, point `GH_CONFIG_DIR` at an empty per-lane directory, disable global/system git
  config and terminal prompting, and drop `SSH_AUTH_SOCK`; an L1-active leg (`worker.
  credentialTier: L1` with a reconciled local anchor) gets the SAME `Bash(gh *)`
  narrowing on EVERY leg — dispatch, resume, and fix alike — not just the fix-loop's opt-in
  credential-free path. A fix leg's env COMPOSES the deploy-key transport
  overlay (`GIT_SSH_COMMAND`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`) onto its OWN
  `workerCredentialFreeEnv()` base rather than the two postures being mutually exclusive — a
  fix leg with a preflight-green deploy key can push its own fix over SSH while every bit of the
  credential-free severing (`GH_CONFIG_DIR` still the empty per-lane directory,
  `GIT_CONFIG_GLOBAL`/`SYSTEM` still nulled) stays intact. Even that environment is not a
  filesystem sandbox: arbitrary Node/npm code still runs with the operator's real home
  directory and can read credentials stored there.
- `engine/src/guard/guard.ts` judges the worker's actual Bash argv independently of the CLI
  permission patterns. It tokenizes command fragments and substitutions, rejects opaque
  execution such as `eval`, shell `-c`, interpreter eval flags, and process substitution, and
  blocks producer overreach through `gh pr merge`/`ready`, approving or requesting changes,
  releases, label/milestone/project-board changes, sensitive REST mutations, and GraphQL
  mutations. Plain issue title/body edits and issue/PR comment channels remain available.
  The same guard protects
  human-merge-only files and engine control sentinels from recognized write vectors and confines
  guarded read-tool paths to the session worktree. Malformed guarded input fails closed.
  `engine/src/roles/worker.ts`'s `WORKER_DISALLOWED_TOOLS` also denies `gh pr
  review*` and `gh release*` at the CLI permission layer (alongside the pre-existing `gh pr
  merge*`/`gh pr ready*`). This is intentionally broader than the guard's argv block, not a
  duplicate of it: the permission layer denies the entire `gh pr review` and `gh release`
  verbs — including `gh pr review --comment` — while the guard's argv block only stops
  `--approve`/`--request-changes`. The producer's actual comment channels remain `gh pr
  comment` and `gh issue comment`, both left open by both layers.
  That deny-list also carries the **governance-signal** verbs `gh issue edit*`,
  `gh label*`, and `gh project*`, so the boundary the guard has enforced at the argv layer
  also holds at the permission layer. It matters because every
  dispatch/merge gate treats issue labels and the board `Status` field as engine-or-human-only
  signals (`plan:approved`, `labels.roundPool`, `escalation.humanLabels`, the `Ready` lane): a
  producer that can set them forges the signals those gates trust. Same intentional coarseness
  as the `gh pr review*` entry — `gh issue edit*` denies the whole verb, including the plain
  `--body` edit the guard still permits. `gh api` is deliberately NOT on the deny-list:
  read-only `gh api` is ordinary worker usage and a prefix rule cannot separate it from a
  mutation, which is exactly the argv-shape judgement the guard's `checkGhApi` makes (REST
  label/milestone/state endpoints and GraphQL mutations, including ProjectV2 field writes).
  That same deny-list also carries
  **server-granularity MCP denies** — `mcp__github__*`, `mcp__server-filesystem__*`,
  `mcp__filesystem__*`, `mcp__Google_Drive__*` — the CLI's own documented
  whole-server wildcard rule shape. Host-delegated capability management has producer legs officially
  inherit the operator's ENTIRE host MCP surface (no `capabilities.*` config surface
  will ever be built to narrow it); a live probe found the
  inherited surface callable and including write/exec-class tools
  (`server-filesystem__write_file`/`edit_file`/`move_file`, `Google_Drive__create_file`),
  none reaching the guard hook (its PreToolUse matcher is
  `Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead` — no `mcp__` pattern at all).
  This deny list is a COARSE, WHOLESALE, name-based accident fence — not a hostile-jail
  — covering exactly two named categories: forge-authority ("github-class") and
  write/exec-class ("filesystem-class") servers, by their KNOWN/common registration
  name. **Residual unknown servers are the top-ranked accepted blind spot**: any MCP
  server an operator's own config registers under a different name is simply not
  covered, and this list makes no claim otherwise — **branch protection is the
  mandatory platform backstop** regardless of what this list denies. **The
  `allowManagedPermissionRulesOnly` interaction**: it discards `--disallowedTools`
  wholesale (see the paragraph above) — a host with that managed-settings mode on
  drops these MCP denies (and every other entry in `WORKER_DISALLOWED_TOOLS`) too,
  which is exactly why branch protection, not this list, is the backstop of record — and
  its presence, not just its documentation, is now checked once per engine start; see the
  [Accepted blind spots](../security.md#accepted-blind-spots) section above for what that detector does and
  does not do. Warn-only observation, same as everything else in this paragraph — it never
  enforces the backstop.
- `engine/src/roles/worker.ts` does not add the engine `.sapwood/` runtime root as a Claude
  tool root (there is no `--add-dir .sapwood`), so the tool layer does not offer a path into
  it. This is not Bash containment: worker Bash can reach `../../.sapwood`, exactly the
  residual documented under [Sentinel isolation boundary](../security.md#sentinel-isolation-boundary-honest-statement).
- Merge authority remains a separate choke point. Only
  `engine/src/roles/merge-driver.ts` calls `IForge.mergePR`, after the CI/review gates and a
  final fresh decision; `engine/src/forge/forge.ts` pins the operation with
  `--match-head-commit`. The worker has no reference to that driver, while both its CLI deny
  rules and the guard block direct merge commands.

This is targeted governance containment, **not general Bash containment**. The denylist does
not prove an unrecognized command harmless, inspect arbitrary script bodies, confine filesystem
access performed by a subprocess, or stop a permitted interpreter/package runner from opening
a socket. In particular it does not contain data exfiltration; see
[Worker network egress: Bash-channel containment available as a hardening profile](egress.md#worker-network-egress-bash-channel-containment-available-as-a-hardening-profile).
The lexical egress tripwire described there is post-hoc evidence only, not a missing enforcement
layer that this denylist silently supplies.

## Issues-only role sessions: read-only, worktree-confined, no shell

Workers are guarded by the argv-inspecting hook above. The round orchestrator's
issues-only peripheral roles — verification-plan-reviewer, verification-plan-drafter, PO/align+triage+pool,
harvest, and architect — take a different, stronger approach on the WRITE side: they
hold no `Bash` tool grant at all, and no `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
grant either. Each session's only output channel is its final message, which ends in a
structured, sentinel-delimited block. The deterministic engine
(`plan-review.ts`/`align.ts`/`harvest.ts`/`architect.ts`) parses that block, validates
it against a per-role zod schema plus the content invariants worth cheaply re-checking
(e.g. an "approve" claim's body must actually carry a verification-plan section —
schema-valid is not the same as truthful), and performs every GitHub write itself via
`IForge`. Validation is fail-closed: ambiguous, duplicate, or out-of-candidate-set
output (the architect is the one role that picks write targets from a pool — every
flagged issue number is checked against the exact candidate set its prompt was shown)
rejects the WHOLE structured output, never a partial/best-guess apply. A malformed or
invalid attempt retries once; a second failure hits the role's existing degrade path —
gate⓪ escalates to `needs-human` with the attempt trail, the advisory roles (PO,
harvest, architect) degrade-and-proceed with a durable state event, never a silent
no-op and never a wedged round.

**On the READ side, every one of these roles is explicitly granted
`Read`/`Grep`/`Glob`** — `peripheral.ts`'s `ROLE_ALLOWED_TOOLS` is
`"Read,Grep,Glob"`, no longer the empty string, and the architect is not a special
case: whether to read is the model's own
role-scoped judgment (an architect reasoning about a contradiction via an approval
protocol instead of just reading the code is absurd), because reading is not
producing/approving/merging. What makes this safe is a **real, fail-closed
containment mechanism**, not a permission-layer convention: the guard hook's
`checkReadContainment` (`guard.ts`) resolves every
`Read`/`Grep`/`Glob`/`NotebookRead` call's target path against the session's own
`SAPWOOD_WORKTREE_ROOT` (an env var the engine sets at spawn time, the same
credential-stripped, engine-controlled channel `SAPWOOD_GUARD_MODE` already uses) and
**blocks** anything that resolves outside it — an absolute host path, a
`../`-traversal, a symlink escape. A live probe (a real `claude -p --worktree`
session, this role's exact allow/deny pair) is part of this feature's verification:
host-path and traversal reads are denied, an in-worktree read succeeds. This containment
has to hold before the read-only allow-list can safely widen — a probe run without it found
an absolute host path and a
`../`-traversal BOTH escaped the worktree and returned real host file content.

**`--disallowedTools` is the write/exec-side cross-source veto**: `peripheral.ts`'s
`ROLE_DISALLOWED_TOOLS` denies `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and a
**blanket `Bash`** — the bare tool name, not a pattern list. `--disallowedTools` wins
over allow from ANY source, including a target repo's own checked-out
`.claude/settings.json`, an authorization surface this engine does not control — so
this is the real boundary, not a convention a repo's own config could quietly
override, **with one honest exception, disclosed here and detected, not
refused**: a target's managed settings can set `allowManagedPermissionRulesOnly: true`,
and the shipped CLI's own contract for that mode (verified directly against the binary)
reads "only permission rules (allow/deny/ask) from managed settings are respected.
User, project, local, and CLI argument permission rules are ignored." `--disallowedTools`
IS a CLI-argument permission rule, so under that mode sapwood's ENTIRE `--disallowedTools`
containment layer is discarded wholesale — not just the `Agent`/`Task` deny below, the
blanket `Bash` and write denies too — and the guard hook is no backstop for the loss,
since `guardDecision()` only inspects write/read/Bash-shaped calls and passes
everything else through. The ruling is disclose + detect-and-WARN,
not startup refusal and not a `needs-human` escalation: see the exception section right
below for the detection contract and both operator exits. Because no shell
exists for these sessions to reach `gh` (or anything else)
through at all, the pattern-layer bypass classes earlier hardening closed one glob at
a time (short `-F`/`-l`/`-p` flag aliases, quoted/escaped `-F`
spellings) are structurally moot for them — not closed by a better pattern, but by
removing the capability the pattern was constraining; the blanket `Bash` deny
subsumes every one of those old per-pattern entries by construction. Per-role deny
constants (`PLAN_DRAFTER_DISALLOWED_TOOLS`, `PO_DISALLOWED_TOOLS`,
`HARVEST_DISALLOWED_TOOLS`, `CONFIRM_DISALLOWED_TOOLS`) are now byte-identical to the
base and kept as their own named exports purely for call-site clarity — each is still
independently regression-tested, so a future re-widening of any one role's grant
lands inside a failing test rather than silently reopening a closed bypass class.
Read-only git (`git log` etc.) deliberately stays **out** of the allow-list: the
blanket `Bash` deny already covers it, and adding it back would be a live capability,
not a trip-wire.

### Managed-settings `allowManagedPermissionRulesOnly` exception

Every containment a peripheral role
session (or the worker) gets from `--disallowedTools`/`--allowedTools` — the blanket
`Bash` deny, the `Write`/`Edit`/`MultiEdit`/`NotebookEdit` deny, the `Agent`/`Task`
spawn deny above — is a **CLI-argument permission rule**. On a host whose managed
settings set `allowManagedPermissionRulesOnly: true`, the shipped CLI ignores CLI-argument
permission rules entirely, so this whole list is void — silently, from sapwood's point of
view, since `guardDecision()` (`guard.ts`) only inspects write/read/Bash-shaped calls and
is no backstop for a permission mode it never sees.

The ruling is **disclose + detect-and-WARN**, not refusal:

- **Detection.** At every engine start, the engine reads the platform's fixed managed-settings
  path (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
  `/etc/claude-code/managed-settings.json` on Linux/WSL,
  `C:\Program Files\ClaudeCode\managed-settings.json` on Windows —
  `managed-permission-warning.ts`'s `managedSettingsPath`). If `allowManagedPermissionRulesOnly`
  is `true`, it emits exactly ONE engine-log warning for that start. No startup refusal, no
  `needs-human` escalation. Absent or unreadable managed settings (the normal, unmanaged host)
  fails open silently — zero behavior change.
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

The warning text itself names both exits and this anchor, so an operator seeing it in the
engine log never has to come find this section from memory.

**`--disallowedTools` also carries a name-list deny of the subagent-spawn channel —
`Agent`/`Task` — for every role session whose deny list derives from `ROLE_DISALLOWED_TOOLS`
(po, architect, verification-plan-reviewer, verification-plan-drafter, harvest, and the verification-plan-reviewer's confirm variant)
and, because `RoleRunner.run()`'s `reviewMode` branch hardcodes `ROLE_ALLOWED_TOOLS`/
`ROLE_DISALLOWED_TOOLS` directly, the `claude`-runner gate② reviewer too. `retro` gets the
identical `Agent`/`Task` deny by a SEPARATE append to `RETRO_DISALLOWED_TOOLS` (`retro.ts`) —
that constant is an independent literal, not derived from `ROLE_DISALLOWED_TOOLS`, so the
addition above did not reach it automatically; see the retro row of `docs/reference/role-paradigm.md`'s
write-scope tier ladder for why retro's own deny matters most (it is the one peripheral role
with a real write grant).** This is a name-list deny of the ONE known
spawn channel over a CLI-defined, version-drifting tool surface — the engine denies the tool
names `Agent`/`Task` on two separate legs of evidence, neither of which is "a live probe found
these names in the current CLI's role-shaped tool list": both names' REGISTRY presence was
confirmed by a direct probe run WITH the deny already in place — both were absent from the
usable tool surface, but the error text itself ("Agent exists but is not enabled in this
context") establishes the name is registered — and an earlier incident, where a live
session really did spawn three subagents, is the other leg. Neither leg claims either name is
live in the role-shaped tool surface; this is never a claim that the session's capability set is
closed: the same "authorization surface this engine does not control" caveat in the paragraph
above applies here too — a future CLI version could rename, add, or remove a spawn-shaped tool,
and only a live probe (not this document) can say what that surface currently contains. **Scoped to the
`claude` executor**: the executor seam lets gate② run on the `codex-exec` runner
instead (`reviewer.agent.runner: codex-exec`, see [Peripheral network egress](egress.md#peripheral-network-egress-websearchwebfetch-detected-not-pinned)
above, "The exception, stated exactly"), where `--disallowedTools` does not exist as a concept
at all — that runner's containment is its own, entirely different shape (a read-only sandbox,
not a tool-name deny list), disclosed separately as `engine-review-containment-gap`. The gate②
`claude`-runner reviewer's deny
rests on the **declared-contract** argument alone, not a cost argument: that session already
carries a hard, CLI-enforced `--max-budget-usd` ceiling (`RoleSessionOpts.maxBudgetUsd`), so the
deny closes an undeclared capability, not an unbounded cost (whether a *child's* spend counts
against that same ceiling is CLI accounting this repo has not probed; the argument does not rest
on it). Escape hatch: if large-diff review quality ever
measurably suffers from the loss of parallel sub-reads, split a `REVIEW_DISALLOWED_TOOLS`
constant at the `reviewMode` branch in `peripheral.ts` — a one-constant change. **The
code-producing worker deliberately retains spawn capability** — `WORKER_DISALLOWED_TOOLS`
(`worker.ts::WORKER_DISALLOWED_TOOLS`) does not deny `Agent`/`Task` — so "role sessions cannot
spawn subagents" names a peripheral-role-and-gate②-reviewer boundary, never a sapwood-wide one.

**The worker's decision, and why it differs from the peripheral-role deny above, honestly stated.**
That earlier deny
cost nothing — a peripheral role's observed spawn was pure circumvention of its own deliberate
lack of a shell, zero legitimate benefit. Subagent use is a mainline coding capability for the
worker (parallel sub-reads on a large refactor), so denying it has a real cost, and the
separation-of-duties boundary holds regardless of the answer: the guard hook rides in via
`--settings` and its PreToolUse fires on a child's tool calls too, so `WORKER_DISALLOWED_TOOLS`'
merge/approve/ready/label/project denies are inherited by anything a worker spawns. This was
never a producer≠merger hole; it is a soft-budget accounting question, decided as follows:
**keep spawn enabled, and accept the soft-budget overshoot it opens as a documented, unbounded
blind spot** — no new poll-tightening or child-cost-accounting machinery, per this repo's
marginal-complexity rule (`docs/PLAN.md`), because a live measurement (below) shows the overshoot
is small relative to a worker leg's own budget, not because the blind spot is bounded by any code
in this engine.

The concrete mechanism: `checkSoftBudget()`/`liveTelemetry()` (`worker.ts`) re-derive the running
spend estimate by re-parsing **one file**, `lane.jsonlPath` — the parent session's own
stream-json transcript. Claude Code's CLI writes a spawned subagent's entire turn history
(its own `assistant`/`user`/`tool_use` lines, token usage included) to a **separate** file —
observed on disk as `<parent-session-dir>/subagents/agent-<id>.jsonl` — that neither
`checkSoftBudget` nor `liveTelemetry` ever reads. The parent's own jsonl gains exactly one small
`assistant` entry for the turn where it issues the `Agent`/`Task` tool call, and one more once the
tool result returns; every token the child itself spent in between is structurally invisible to
the live estimator for the child's entire lifetime — not a one-poll delay, a complete gap bounded
only by how long the child runs.

**Live measurement:** one real subagent call (`Explore`
agent type, a research task comparable to ordinary worker sub-reads) spent 30 input + 1,268
output + 125,616 cache-creation + 384,230 cache-read tokens over ~37.5 wall-clock seconds
(15 of its own `assistant` turns) — roughly **$0.61** at this repo's shipped `sonnet` rate
(`engine/pricing.yaml`). The parent's own jsonl recorded the dispatching tool_use at T+0 and the
next line — the tool_result, once the child fully finished — 43 seconds later: zero new assistant
lines from the parent in between, the entire 37.5s child run included.
Against the dogfooded `opus`/`high` worker-leg soft budget of $8–20 (`docs/guide/configuration.md`),
one subagent call is roughly 3–8% of the whole per-leg budget — small enough that
accepting it unbounded, rather than building accounting for it, is the marginal-complexity call.

**Stated honestly, not overclaimed:** this measurement covers ONE sequential subagent call. A
worker that fans out several/many children concurrently (the CLI has no cap sapwood imposes) can
accumulate a correspondingly larger invisible total — nothing in this engine bounds that other
than the worker's own prompted behavior, which today does not direct large fan-outs. The existing
`egress-suspect` event (`worker.ts`) already logs every `Agent`/`Task` tool_use a worker
leg makes, but for network-egress containment, not cost — it is not a cost-accounting signal and
this decision does not lean on it as one. If a future dogfood round measures a worker leg whose
subagent fan-out meaningfully erodes the soft budget's purpose (frequent late handoffs, or spend
well past `budgetUsdSoft` before the next graceful SIGTERM), that is the trigger to revisit this
as a bounding problem (tighter `heartbeatMs`, or summing `subagents/*.jsonl` into
`liveTelemetry()`) — not a reason to have built that machinery pre-emptively today.

Every `RoleRunner` session is additionally spawned without forge credentials:
`peripheralSessionEnv()` in `peripheral.ts` strips inherited `GH_*`,
`GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, and `GIT_CONFIG_*`
variables through a case-normalized denylist, while preserving the CLI's own
Anthropic authentication and `SAPWOOD_GUARD_MODE`. For the five issues-only roles,
the zero-`Bash`/zero-write tool grant (`Read`/`Grep`/`Glob` allowed, guard-confined
to the worktree, as described above — no `gh`-reaching capability of any kind)
remains the primary boundary; environment absence is a backstop, regression-tested
with a poisoned parent environment, so a future allowlist-widening regression
cannot turn an inherited engine credential into forge authority. Worker-class
`retro` receives the same stripped environment but keeps push working through the
ambient git credential helper, as described below. Code-producing worker lanes are
unaffected: they legitimately hold the token, mediated by the guard hook.

**`retro` is the one exception**, by session class rather than role name: it is
worker-class, with `Read`/`Grep`/`Glob` + local git only — file edits, commit, and
push inside its own ephemeral worktree (proposals land exclusively as PRs through the
normal review gate, never a direct write) — the same broader trust level a
code-producing worker gets, because its job (editing prompts/docs/config from round
history) genuinely needs it. (`Grep`/`Glob` joined its allow-list alongside
every other role's — retro's job was already code-aware and already carried `Read`;
it was simply missing the other two read tools.) Its `gh` surface, however, is now **zero** — no `gh` entry of any kind remains in
its allowedTools:

- **Read side:** retro never browses GitHub live. Instead the engine
  builds a round-scoped digest (PR descriptions + diffs + review signals for every PR
  the round touched, comments/labels for every escalated issue, commit history since
  round start) *before* the session runs, bounded by a hard, deterministically-
  truncated character cap (`roles.retro.digestMaxChars`), and substitutes it into the
  prompt. See [`configuration.md`](../guide/configuration.md#roles) for the config key and
  `engine/src/retro/retro-digest.ts` for the assembly.
- **Write side:** PR creation originates in engine TypeScript, never in
  the session. The session's job ends at commit+push: it writes its intended PR
  (branch/title/body — or an explicit `none` for a quiet round) to a fixed scratch
  path in its worktree (`.sapwood-retro-pr`; the engine chooses the path). Post-
  session the engine parses that file fail-closed, **verifies the claimed branch
  actually exists on the forge** (an engine-side `gh api` read — a session claim is
  never trusted as evidence of a push), and only then calls `forge.openPR()` itself.
  Partial failures degrade visibly and durably (`retro-pr-degraded` event; a pushed
  branch whose `openPR` failed is preserved evidence for a human), never a silent
  no-op and never a wedged round.

The dangerous verbs `guard.ts` already blocks category-C are unchanged, and retro's
old `gh` deny patterns are kept byte-identical as regression trip-wires — the same
stance the issues-only roles take.

**gate⓪'s freshness re-confirm session** ("does this plan still hold against current
`main`?") needs repo read access for the same reason every other
role does: a plan referencing a file since renamed is otherwise unverifiable.
`Read`/`Grep`/`Glob` is the UNIVERSAL issues-only baseline, so
`CONFIRM_ALLOWED_TOOLS`/`CONFIRM_DISALLOWED_TOOLS` are byte-identical to
`ROLE_ALLOWED_TOOLS`/`ROLE_DISALLOWED_TOOLS` — kept as their own named exports purely
for call-site clarity in `plan-review.ts`. The session reads the conductor's own
checkout, the same ephemeral worktree every role session already gets and the same
guard-hook containment described above; its freshness relative to `main` is the
conductor's responsibility, not a property this grant controls. This session's
decision, like every other role's, is read from its structured output only, applied by
the engine (`plan-review.ts`), never by a tool call of its own.

### The forge MCP proxy's role x tool matrix

`RoleRunner` peripheral sessions and worker legs can be attached (config-gated, ON by default
— see [`configuration.md`](../guide/configuration.md#roles)) to a per-session, revocable,
read-only forge MCP proxy that returns sanitized forge data verbatim, with no gate/verdict logic
of its own (fresh-head counting, identity filtering, trigger-pin checks stay in
`reviewer.ts`/`merge-driver.ts`). The production-attachment path (state: `proxy.enabled: true`)
is real code, exercised by tests — not merely constructible-but-inert — and it is **this shipped
tree's own default**: an operator who leaves `proxy` unset gets a live, attached proxy, not an
inert one; only an explicit `proxy.enabled: false` opts back out. Review sessions are exempt
regardless of `enabled` — see the exception below. Each session's role scopes it to a fixed
subset of the tool algebra (`proxy/access.ts`'s `PROXY_ROLE_TOOL_MATRIX`), enforced server-side
in the proxy itself (the CLI's own `--allowedTools` widening is noise reduction only, same stance
as every other allow/deny pair on this page) — a role absent from the table below is granted **no
tool from this proxy** (deny-by-default, regression-tested, scoped to the proxy's own
`mcp__forge__*` namespace only — it says nothing about an ambient host MCP server a session may
separately inherit under host-delegated capability management, see the worker-egress blind-spot section):

| Role | Tools granted |
| --- | --- |
| `po-pool` / `po-align` / `po-triage` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `harvest` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `architect` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `verification-plan-reviewer` / `verification-plan-drafter` / `verification-plan-reviewer-confirm` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `retro` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `worker` (the fix-loop leg's PR-review evidence channel) | `pr_details`, `pr_reviews`, `pr_review_threads`, `pr_checks`, `pr_audit_comments`, `pr_failed_checks` |
| *(any other role id)* | none — deny-by-default |

**This ten-role grant is deliberate, not an oversight to narrow.** Every one of these tools is
read-only and costs nothing when a session never calls it, and a measured zero-call count is not
evidence that a grant is unneeded: zero calls means the role's TASK never asked for a
lookup, not that the capability itself has no use — the lever for changing that is the task step
a prompt gives the role, not the grant it holds.

**`WorkerSupervisor.resume()` also attaches a proxy.** A fix leg is a *resumed* leg (same worker
row/worktree/branch/session — see
"Fix-loop `fixing` lane state" below), and it needs `pr_review_threads`/`pr_reviews`/`pr_checks`/
`pr_failed_checks` as its evidence channel exactly as much as a fresh dispatch would. `resume()`'s
attachment mirrors
`dispatch()`'s byte-for-byte: mint-before-argv, `--allowedTools` widening with the proxy's own
tool names, inline `--mcp-config` injection, `credentialFree`'s fail-closed policy, and teardown on
every exit path (including the two resume-specific spawn-failure branches `dispatch()` doesn't
have — the synchronous `spawn()` throw and the async `'error'`-before-`'spawn'` race). One
resume-only divergence: a `credentialFree` mint failure closes the (already-opened) jsonl fd but
does **not** delete the jsonl file or the `.handoff` sentinel the way `dispatch()`'s cleanup deletes
its fresh, empty jsonl — a resume's jsonl holds real prior-leg history, and a refused resume must
leave the lane exactly as resumable as it was before the call, not destroy its record.

**`credentialFree` severs the `gh`/git CREDENTIALED-TOOL reach AND seals the MCP config
surface — not a worker leg's forge reach in general.** That distinction matters: env-VAR stripping
by itself is NOT sufficient for a Bash-granted worker: `gh` falls back to on-disk stored
credentials (`$HOME/.config/gh/hosts.yml`) when no token env var is present, and git can still
reach a credential helper, a cached SSH agent, or an interactive prompt regardless of which env
vars are absent. `worker.ts`'s `workerCredentialFreeEnv` (opt-in via
`WorkerProxyOpts.credentialFree`) additionally:

- points `GH_CONFIG_DIR` at a **fresh, empty, per-lane** scratch directory — `gh`'s own stored
  host/token config is read from there, never from the operator's real `$HOME/.config/gh`;
- sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` — a `credential.helper`
  entry in either config file is never read;
- sets `GIT_TERMINAL_PROMPT=0` — git fails closed rather than blocking on an interactive prompt;
- drops `SSH_AUTH_SOCK` — an inherited SSH agent socket is a live credential channel on its own;
- narrows the leg's own `--allowedTools` to drop `Bash(gh *)` (`WORKER_ALLOWED_TOOLS_NO_GH`) — a
  grant a severed env can never authenticate through shouldn't still be offered. `Bash(git *)`
  stays: worktree-local git operations (diff, log, add, commit) remain legitimately useful once
  git's OWN credential path is severed, same "read is not the boundary, doing is" stance this page
  takes everywhere else.

**MCP seal — the ambient-MCP gap is closed.** Without this seal, `--mcp-config`
(the proxy's own server, set whenever a proxy attaches) would be merely
**additive**, so a `credentialFree` leg's ambient host MCP servers would still load from settings
sources and stay **callable regardless of `--allowedTools`**,
write/exec-class tools included, none reaching the guard hook — worse than the
`steal.mjs` disk-read residual below: a live network channel, not a local-disk read. `dispatch()`
and `resume()` now pass `--strict-mcp-config` whenever `credentialFree` is set, alongside the
already-inline `--mcp-config` — together these make the MCP config **exclusive**: the CLI loads
ONLY the proxy's own server, ignoring every other config source (project `.mcp.json`, user
settings, ambient host servers). Non-`credentialFree` paths (including an attached,
non-`credentialFree` proxy) are unaffected — this flag is scoped to `credentialFree` alone.

A mint failure is non-fatal for an ordinary (non-`credentialFree`) proxy attachment — the lane
still dispatches, unattached, same posture as `peripheral.ts`'s `RoleRunner`. `credentialFree:
true` is different: a leg dispatched that way has neither that credentialed-tool path nor (if
mint fails) a working evidence channel, so `dispatch()` REFUSES outright rather than run silently
degraded. Either branch records a durable `proxy-mint-failed` state event (lane/role/sanitized
reason, via `WorkerDeps.state`) before deciding which way to go.

**HONEST SCOPE — this is NOT full isolation (the same
"document the residual, don't chase it with more machinery" stance as the Sentinel isolation
boundary section below).** `workerCredentialFreeEnv` closes `gh`'s and git's OWN credential-lookup
paths, and the MCP seal above closes the ambient-MCP gap — together they do NOT structurally
confine what arbitrary code run under this lane's `Bash(node *)`/`Bash(npm *)` grant can read off
disk — a fix leg genuinely needs those grants to run its own test suite, and it still executes with
the operator's REAL `$HOME`. A live proof-of-concept (`node steal.mjs`, a script invoked through
exactly that grant) read `~/.config/gh/hosts.yml` directly and reached GitHub with the credential
found there, bypassing every env var `workerCredentialFreeEnv` touches entirely — filesystem
access is orthogonal to environment-variable redirection AND to the MCP seal, and no amount of
either closes it. Two mitigations this repo deliberately does NOT attempt: **HOME isolation**
(redirecting `$HOME` would break the `claude` CLI's own config/auth, which the lane also needs
merely to run) and **stripping `Bash(node *)`/`Bash(npm *)`** (a fix leg's whole job requires
running tests). The upgrade path for a boundary that's actually closed is **OS-level sandboxing**
(container/chroot/Landlock-style filesystem confinement, available as the operator-configured
Bash-sandbox recipe — see [Execution
profiles](execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox) below) or running fix legs
under a **dedicated, narrowly-scoped CI identity** whose credential store holds nothing worth
stealing — the CI-identity path remains unimplemented. One narrowing worth naming precisely:
`hosts.yml` is `gh`'s plaintext-token storage path; on macOS, `gh auth login` by default stores
the token in the OS **keychain** instead, which neither this mechanism nor the PoC exposes — the
risk this note describes is sharpest wherever `gh` ends up with a plaintext on-disk token (Linux,
CI images, an explicit non-keychain login), not a universal property of every `gh` installation.

`workerCredentialFreeEnv()` alone provides no filesystem confinement. An operator who has
configured the Bash-sandbox recipe above gets OS-blocked Bash reads of the named `denyRead`
paths (probed live against this exact PoC path — `node -e
"readFileSync(process.env.HOME+'/.config/gh/hosts.yml')"` returned `EPERM`); without that
operator configuration there is no such guarantee. Even with the recipe active it is still not a
home-directory jail: unlisted paths and additive `allowRead` entries remain residuals.

#### Worker-leg user-settings persistence vector — detect & disclose

The HONEST SCOPE note above covers the `Bash(node *)`/`Bash(npm *)` filesystem-read residual in
general; this narrower note is about one SPECIFIC consequence of it: `worker.ts`'s `claudeArgs` passes no `--setting-sources` flag on ANY worker leg
(dispatch, resume, or fix), so an ordinary worker session loads every file-based settings source —
project, local, AND the operator's own `~/.claude/settings.json` — unlike the review-session mode
above, which closes exactly that `user`-scope inheritance with `--setting-sources ""`. Because a
worker leg's `Bash` grant runs with the operator's REAL `$HOME` (the HONEST SCOPE residual, same
paragraph), a producer leg in round N can in principle write `~/.claude/settings.json`
(permission grants, hooks, or an `apiKeyHelper`), and every LATER worker leg — any lane, any round
— inherits whatever that write left behind.

**Startup detection and disclosure is what ships (arm 2).** Two other arms were considered and rejected for this specific vector:

- **Arm (1), pinning `--setting-sources` on worker legs** — ruled out. A prior measurement already
  found that `--setting-sources ""` also stops the repo's own `CLAUDE.md` from loading, which
  collides with the locked ruling below ("ambient repo context: record, don't seal"). A partial
  source list (e.g. `"project,local"`) is unproven and carries a named `apiKeyHelper`-breakage
  risk on hosts whose Claude auth lives in user settings — config-gating that would add a new
  config key and a host-compatibility matrix for a vector the L1 direction (worker =
  transport-only deploy key) is independently shrinking.
- **Arm (3), documentation alone** — insufficient on its own: the vector is producer-influenceable
  across rounds, which warrants observability, not prose alone.

**What shipped:** `engine/src/loop/user-settings-watch.ts`'s `createUserSettingsWatch` —
constructed once at engine startup (both drivers, `cli.ts`), it snapshots/hashes the operator's
user-level settings file at construction, then its returned closure rides each driver's existing
per-tick `onTick` hook to compare the CURRENT file against what was last observed. A later tick
whose content hash differs, or whose set of containment-weakening keys (`apiKeyHelper`, `hooks`)
differs from what was last observed, logs one WARN and appends exactly one durable
`user-settings-drift-detected` event — never blocks, never mutates,
never throws out of the tick loop. Same injected-`readFile`-seam testability convention as
`checkWebAccessSettingsDenial`.

This closes nothing structurally — the broader worker-HOME filesystem-confinement residual (the
`steal.mjs`-class gap the HONEST SCOPE note above describes) remains its own still-open item. If
detection later shows this vector being exercised in practice, arm (1)'s probe-then-pin gets its
own issue with that evidence as the Why.

#### Role-session skill injection — an accident fence, not a jail

`engine/src/roles/skills-plugin.ts` renders two v1 reference skills (`human-merge-only-paths`,
`ac-evidence-tiers`) verbatim from [`docs/security.md`](../security.md)'s own marker-delimited sections (see
the `<!-- sapwood:skill:*:start/end -->` comments around [Human-merge-only
paths](../security.md#human-merge-only-paths) and [Doctrine lines](../security.md#doctrine-lines) in the core
file) into an immutable, content-hash-named plugin directory under
`.sapwood/cache/generated/role-skills/<hash>/`, attached to a session via `claude --plugin-dir`. This
CONTENT-side-only: the render path's only input is [`docs/security.md`](../security.md) — never anything
issue-body- or PR-derived — and a published hash directory is never overwritten (the "accident
fence, not a jail" doctrine: the goal is to stop a mistake, not to withstand an adversary who
already has code-execution authority in the same repo).

**A third skill, `sapwood-labels`, lives on the same plugin dir.** Unlike the two above, its
content is NOT extracted from [`docs/security.md`](../security.md)'s markers — it is rendered from `engine/src/forge/
labels.ts`'s `LABEL_SEMANTICS` registry (writer/remover/gates/distinguish-from per label) against
THIS repo's fully-resolved `cfg.labels`/`cfg.escalation.holdLabels`/`cfg.escalation.humanLabels`,
so a `labels.prefix` remap always shows the RESOLVED names a session actually sees on real
issues/PRs, never a default or a template — and whether a label actually vetoes a PR merge
(substring match against `escalation.humanLabels`, the merge gate's own rule) or holds an issue
out of dispatch is likewise rendered from real resolved config using the SAME predicates those
gates call, never asserted as fixed prose. Dispatch hold is NOT
`escalation.humanLabels` membership alone: `needs-human`/`blocked`/`reserve`/`decomposed`/
`split` (#874) hold dispatch UNCONDITIONALLY in every config (forge.ts's `isDispatchable`,
gate⓪; conductor.ts's `orderForDispatch`), regardless of `escalation.humanLabels`; every other
label holds dispatch only if it is an EXACT member of that resolved list. `split` is a dispatch
exclusion until the decomposer fences the parent with `decomposed` — the same composed set
`decomposed` itself joins, closing the race where a concurrent or stale `plan:approved` could
otherwise dispatch an issue the engine already split (or a human split as override) before that
fence lands. The three escalation rows (`needs-human`/
`blocked`/`reserve`) always show both facts, member/unconditional or not; `decomposed`/`split`
always show the Dispatch hold fact (unconditional), but — unlike those three — neither is in the
ALWAYS_RENDER set, so their Merge veto fact follows the same rule as every other label: rendered
only when its resolved name actually matches `escalation.humanLabels`. Under default config
`decomposed` is not a member, so no Merge veto line renders for it there, but a repo whose
`escalation.humanLabels` explicitly includes `decomposed` does see its Merge veto MEMBER line,
exactly like any other label. The
registry is the PROMOTION of label semantics that used to live only as TS doc
comments on `labels.ts`, unreadable from any role session — the incidents this closes: a worker
self-applying `human-merge-only`, an architect blocking a Ready issue via label with no
engine event, and repeated supervisor label-timeline misreads. Same CONTENT-side-only
posture as the two marker-extracted skills: the render path's only input is the engine's own
resolved config, never issue-body- or PR-derived text.

**Injection policy** (`shouldInjectSkillsPlugin` in the same module): every worker leg (fresh
dispatch, resume, fix-entry) and every non-review peripheral role session gets `--plugin-dir`
attached when `roles.skills.enabled` is `true` (default `false` — see config.ts's own comment);
a review-mode session (`reviewCwd`) NEVER does, enforced structurally in
`RoleRunner.run()` itself, the same way that mode already hardcodes its tool profile and closes
its MCP/settings surface.

**Narrowed to three documented classes, not machinery-closed (#656):** the guard's `.sapwood/`
runtime-root write-deny rule ([Sentinel isolation boundary](../security.md#sentinel-isolation-boundary-honest-statement))
covers a published role-skills hash directory the same way it covers every other path under the
runtime root — a worker's `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, or a Bash write vector,
targeting it is denied without a role-skills-specific rule. What remains open is exactly the
three classes that section documents, no wider: inherited MCP write tools never reach the guard
hook; symlink aliasing is judged lexically, on the argument's text, not the filesystem's
resolved target; and opaque indirection (an environment-assignment token, a script's hardcoded
path, or another CLI form the argv walk doesn't parse) is invisible to the same argv-only
judgment the previous sentinel regex already had. Detection/disclosure of anything outside
those three classes is still the honest response, not a claim that this rule closes every
route in.

### Fix-loop `fixing` lane state

Routing review findings (`HANDLE_THREADS`) straight to `needs-human` (`merge-driver.ts`'s
`deriveGate`) would ask a human to *resolve* a review, inverting the autonomy principle
(humans adjudicate reviews, they never resolve them). Instead, the producing worker gets its own
lane state to address findings itself, *before* human escalation, without ever handing it a new
dispatch or forge credentials:

- **New `WorkerState`: `fixing`.** `driving` (holds a PR awaiting gate①/gate②) → `fixing` (a
  LIVE fix-leg worker process reworking that same PR) → back to `driving` once the fix leg
  reaches a terminal outcome. `state.ts`'s `activeWorkers()` counts `running + driving + fixing`
  — a fixing lane occupies capacity exactly like the other two. The actual gate decision that
  triggers `driving → fixing` (deriving `FIXABLE` from a live review verdict) is a separate
  mechanism; this lane state provides the machinery and the seam (`conductor.ts`'s `startFixLeg`)
  that decision calls once made.
- **Fix leg = `resume()`, never a new `dispatch()`.** `startFixLeg` reuses the resume
  machinery outright — same worker row, same worktree/branch/session lineage — specifically to
  avoid the squash-branch-reuse hazard a fresh dispatch against this lane's (possibly-stale,
  possibly-ahead) head would create. The fix leg's prompt (`worker.fixPromptFile`, engine-shipped
  default `prompts/fix.md` — same config pattern as `worker.promptFile`) instructs the
  worker to pull its own PR's review findings and CI-failure evidence via the PR-facing proxy
  tools (`pr_review_threads`/`pr_reviews`/`pr_checks`/`pr_details`/`pr_failed_checks`) — never via
  findings or CI-log text relayed through the prompt itself (no prompt-injection transport;
  `pr_failed_checks`' response is framed as untrusted CI/log data, same stance as every other
  externally-influenceable proxy read).
- **`fix_rounds`** is a new per-PR counter (`workers.fix_rounds`, schema v18→v19), counting
  rework rounds — deliberately independent of `resume_attempts` (the continuation-leg
  counter): one axis is "how many times did this PR need fixing", the other is "how many budget-
  exhaustion handoffs did one leg need" — they never share a counter, and a lane can spend both
  independently.
- **The `fixing` → `driving` edge clears the review-trigger pin** (`review_triggered_head`/`at`
  reset to `null`), reusing `MergeDriver.driveOne`'s own re-trigger machinery to force a fresh
  review on the fix leg's new head — the same shape as the engine's existing gated-PR reentry.
- **Supervision**: a `fixing` lane is a live worker process, so the SAME heartbeat/timeout/soft-
  budget supervision and crash-safety machinery (`reclaimTerminalLane`, dirty-worktree retention,
  the kill-switch drain) applies to it as to a `running` lane. It is NOT scanned by the DRIVE
  loop (`state.drivingWorkers()` excludes `fixing` rows by construction), which is also why
  the review-silence escalation structurally cannot arm while a lane is fixing — that clock
  only ever fires from inside the DRIVE loop.
- **Narrowed `gatedFailedWorkers()` semantics**: with the `FIXABLE` gate wired in, ordinary
  review findings no longer produce a `failed`+PR row at all (they route to `fixing` instead) —
  the only remaining producer of that shape is the `fix_rounds` cap escalation. Findings no
  longer masquerade as `failed`.
- **Adjudicated findings do not re-consume fix rounds.** Gate② tracks each review thread's span
  (`path`/`line`/`originalLine`), GitHub's own `isOutdated` staleness field, and a
  whitespace-normalized digest of the originating comment identifying which finding the thread is
  about, all from the same paged read that already produces the blocking-thread count. An
  unresolved thread carrying the same finding at the same span as an already-resolved thread
  whose code has not moved since is an *adjudicated re-raise* and is excluded from the blocking
  count — keyed on (finding, span), never a thread id (a re-raise always arrives as a brand-new
  thread) and never a span alone (two unrelated findings can share a line). A resolved thread
  whose code changed after resolution still reads as outdated and blocks again; an unresolved
  thread with no prior adjudication on its span still blocks; a standing `CHANGES_REQUESTED`
  still blocks; a review submitted against a non-current head is excluded from both halves of the
  gate. Both exclusions are named in the `FIXABLE` outcome's own reason — a filter that silently
  shrank gate② input would be exactly the invisible weakening this mechanism exists to avoid.
- **Precedence when more than one fix-loop signal fires on the same tick: verdict-rerun →
  convergence-stalled → cap.** A byte-identical rerun (its own fix leg already ran and pushed
  nothing) wins outright regardless of measured progress; a stalled lane
  (`review/convergence.ts`'s progress classifier) escalates to `needs-human` before paying
  another fix round; `lanes.prFixCap` remains the cost backstop for a lane still genuinely
  converging.
- **A driving lane's fix leg is exempt from `cost.roundBudgetUsd` outright.** An already-open PR
  has no completion path other than merge or fix — there is no "abandon the PR" outcome — so
  gating a fix leg on round spend could wedge a round forever once spend crossed the cap while a
  PR still needed rework. `cost.roundBudgetUsd` gates *new* dispatch only; a fix leg remains
  bounded by the three other, pre-existing limits: `lanes.prFixCap` (attempts, above),
  `worker.budgetUsdSoft` (the leg's own per-worker graceful-handoff ceiling), and
  `cost.dailyBudgetUsd` (the hard daily ceiling — deliberately NOT exempted, since it is the
  actual safety boundary against runaway spend, not a per-round pacing device). The exemption is
  uniform across every round/run-level stop reason, not just the spend cap: once
  `roundBudgetUsd`/`roundDispatchCap`/a round milestone/a `stop.*` condition fires, further
  dispatch waves freeze via the same "no new dispatch this round" signal (never a human pause),
  and a fix leg on an already-open PR is never "new dispatch" either way — new DISPATCH itself
  stays fully frozen regardless. **A fix leg's admission gate reads the genuine `.sapwood/PAUSE`
  sentinel only, never `forceDispatchPause`.** DISPATCH and RESUME's own admission checks OR the
  two together into one wider flag (`conductor.ts`'s `paused`), but the fix-leg admission gate
  (`fixLegAdmissionBlockReason`) deliberately reads the narrower `humanPauseOnly` —
  `state.isPauseActive()` alone. So a round/run-level stop condition firing never blocks a fix
  leg on its own, while a human-set `.sapwood/PAUSE` still does, exactly like it blocks new lane
  dispatch — see [Human controls](../security.md#human-controls-three-tiers) below.
- **Terminal-for-drain under the `KILL_SWITCH` bounded drain.** A `driving` lane has no live
  process for the drain to hand off or kill, so left alone it could sit untouched for as long as
  the switch stayed active. Three cases: a `driving` lane that is daily-budget-blocked or
  fix-rounds-capped is escalated to `needs-human` past the same bounded `cost.drainWindowSec`,
  exactly like a hard-killed running/fixing lane, so the engine always exits within the drain
  window; a `driving` lane that has never needed a fix leg (MERGE-/WAIT-gated) is left alone —
  it isn't stuck for a budget reason, and resumes the instant the breach/switch clears; and a
  lane whose CI-pending pin is already past `ci.pendingEscalateAfterSec` is terminal-for-drain
  too, in BOTH drain arms — the kill-switch heuristic's own input and the ceiling path's observed
  set — because gate① being permanently stuck is exactly "can never make forward progress," and
  it is invisible in `fix_rounds` (such a lane has spent none). A pin that is merely fresh stays
  a healthy WAIT.
