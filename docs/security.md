# Security & trust model

sapwood's core claim is that it's safe to let an autonomous worker write code in your
repo because the loop structurally prevents it from also approving or merging that
code — not because you trust the model to behave. This page describes that model as it
exists today.

## Trust context

sapwood targets **trusted repos first**: your own repo or your team's, where issue
authors are trusted and issue text is not treated as hostile input. The architecture is
built toward public-repo hardening (scoped ephemeral tokens, an allowlisted-reviewer
requirement instead of any-non-author-approval, a threat model treating issue text as
adversarial), but those hardenings are not all in place yet — don't point an
unhardened sapwood at a public repo with untrusted issue authors.

## producer ≠ reviewer ≠ merger

The worker that writes code can never approve its own review or merge its own PR. This
is enforced structurally, not by asking the model nicely:

- **The fail-closed guard hook (`guard.ts`)** is a PreToolUse hook wired into every
  worker's headless `claude -p` session. It's a pure, zero-dependency, deterministic
  function: given a tool name and its input, it decides allow/block. For `Bash`, it
  tokenizes the command (shlex-equivalent splitting, recursing into `$()`/backtick
  substitutions), strips exec-prefixes (`env`, `npx`, leading assignments, etc.), and
  blocks any GitHub-overreach command a producer must never run: `gh pr merge`,
  `gh pr review --approve`, `gh pr ready`, `gh release`, `gh label`, `gh project`,
  governance-changing `gh issue edit` flags, `gh issue close`/`reopen`/`transfer`/`delete`,
  and the mutating `gh api`/GraphQL equivalents. REST path tokens are decoded strictly
  before matching and malformed path escapes fail closed; the mixed command scan decodes
  valid percent pairs best-effort while preserving stray `%` in API field values. Plain
  issue title/body edits remain allowed. Issue/PR comment API calls, including values
  containing stray `%`, remain allowed when the scanned command contains no protected
  REST path. Residual allow surface: assignees, `--title`/`--body` (`-b`/`-F`), and native
  `--add-blocked-by`/`--remove-blocked-by`/`--add-blocking`/`--remove-blocking`
  relations remain allowed because no sapwood gate reads those relations (dispatch
  ordering uses `blocked-by:#N` labels, already covered by `--add-label`/`--remove-label`).
  Under #290/#353, the issue lifecycle itself (close/reopen/transfer/delete) is
  engine/human-owned: the worker's `gh issue close|reopen|transfer|delete` is blocked at
  the same high-level-CLI-verb layer as the `edit` governance flags, symmetric with the
  REST/GraphQL mutations #352 already blocks underneath it (`gh api -X PATCH
  repos/*/issues/<n>` state changes match `ISSUE_GOVERNANCE_PATH_RE`; GitHub has no REST
  transfer/delete endpoint, so those reach the guard only as `gh api graphql` mutations,
  already caught by the graphql-mutation check). `gh issue comment`/`view`/`list`/`status`/
  `create` remain allowed — comment is the worker's refuse/hand-back channel.
  Opaque constructs a worker could hide anything inside —
  `eval`, `sh -c`, an interpreter's `-e`/`-c`, process substitution — are blocked
  outright, fail-closed, rather than inspected.
- **The merge is always executed by the conductor**, never the worker. Only
  `merge-driver.ts`'s `driveOne` calls the merge API; `tick()` (the path a worker's own
  session runs inside) never does. This holds even if the guard hook were somehow
  bypassed — it's a structural separation, not just an argv check.
- **Fail-closed on error.** The hook denies on malformed JSON, a non-object payload, a
  malformed `tool_input` for a guarded tool, or any exception thrown while deciding. A
  safety hook that can be disabled by feeding it garbage isn't one.

**Single-identity limitation for engine-agent review.** The engine-agent review session has no
GitHub credentials or forge access at all. The limitation is that the engine posts the audit
comment and performs the merge under one token identity; there is no separate reviewer account
whose GitHub approval proves account-level independence. For this reviewer kind,
producer≠reviewer is enforced at the process/session boundary — a different-model, read-only,
closed review session produces structured judgment, while deterministic engine code alone writes
GitHub state and merges — not at the GitHub-account boundary. This is a bounded limitation, not an
identity claim. The compensating control is the receipted, non-authoritative audit-comment trail:
it records the reviewed head and diff, run id, actual reviewer model(s), prompt hash, and
materialized-tree manifest hash before any engine-agent-derived merge/FIXABLE outcome is consumed.
It makes the separation and evidence inspectable, but does not turn the shared account into two
independent principals.

### Guard modes: hard vs. soft

`guard.mode` (default `hard`) controls how the hook responds to a blocked command:

- **`hard`** — fail-closed deny. This is the actual safety boundary and the only mode
  that should run against real, unattended dispatch.
- **`soft`** — observe-only: the hook logs what it *would* have blocked but allows the
  command through anyway. This exists only as a first-run/dogfood affordance for
  watching what the guard would catch without yet trusting it to block — never the
  shipped default, and not a mode to leave on for real autonomous runs.

The mode reaches the guard hook via a spawn-time environment variable
(`SAPWOOD_GUARD_MODE`) that the engine sets when it launches the worker process — not a
worker-writable settings file — so a worker cannot weaken its own guard mode by editing
config mid-run.

## Worker network egress: accepted blind spot

sapwood's containment is action-side. The guard prevents a producer from approving or
merging its own work, protects security-bearing write paths, and confines guarded read-tool
calls to the worker's worktree. The conductor separately owns review and merge actions.
Those controls do **not** contain network egress from arbitrary commands a worker runs
through `Bash`. A worker that can execute `curl`, open a socket, or run an equivalent program
can send repository or environment data to an external endpoint.

That gap is an accepted boundary, not an isolation feature waiting to be implied by the rest
of the model. sapwood targets trusted repos first, and by owner decision does not place worker
sessions in a network-isolated sandbox or proxy. Operators must therefore treat worker Bash
egress as an explicit blind spot when deciding which repositories, host credentials, and
environment data are safe to expose to a run.

The engine adds a monitor-only lexical tripwire at lane end. It scans the completed leg's
existing Claude stream-json log for Bash tool calls whose executable matches
`worker.egressSuspectCommands`, then writes deduplicated `egress-suspect` events through the
ordinary events ledger. Detection is post-hoc and fail-safe in the allow direction: it never
denies a command, holds a lane, adds `needs-human`, or changes the worker outcome, and a scan or
event-write failure is logged without becoming a gate. This is a **tripwire, not containment**.
It can catch naive or accidental exfiltration attempts and leave an audit trail, but a
deliberate adversary can trivially evade lexical executable matching — for example with an
interpreter one-liner or DNS exfiltration.

## Peripheral network egress: WebSearch/WebFetch, detected not pinned (#410)

Three role sessions — `architect`, `po-align`, `po-triage` — are granted the CLI's built-in
`WebSearch`/`WebFetch` tools, `webAccess.enabled` (default `true`, a config key can disable it).
This is a bounded widening, not a relaxation of the posture above: unlike the worker's Bash
egress, this channel is exactly two named, read-only tools, carries no credential into any
project system, and every call is journalled (see the audit paragraph below). The decision
record (issue #410) rejected a domain allowlist (self-defeating — the point is discovering
things nobody knew to look for, and an allowlisted domain accepting an arbitrary path/query is
itself an egress channel) and MCP delivery (the guard hook has no `mcp__` handling at all, so a
built-in-tool grant stays visible to the engine's own enforcement layer and journal in a way an
engine-hosted MCP tool would not).

**Grant, per-role, named exports.** `peripheral.ts`'s `ARCHITECT_ALLOWED_TOOLS`/
`PO_ALIGN_ALLOWED_TOOLS`/`PO_TRIAGE_ALLOWED_TOOLS` each widen the base `ROLE_ALLOWED_TOOLS`/
`PO_ALLOWED_TOOLS` with `WebSearch,WebFetch` — the same named-export-plus-pinned-regression-test
pattern `CONFIRM_ALLOWED_TOOLS` already established. `cfg.webAccess.enabled` is read at each
role's OWN call site (`architect.ts`, `align.ts`'s po-align/po-triage sessions), never inside
`peripheral.ts` itself — a role whose call site never threads that ternary in has no config path
that could ever reach the grant. `po-pool` (align.ts's third `PO_ALLOWED_TOOLS` caller) stays on
the ungranted base unconditionally: it renders a distinct prompt (`po-pool.md`), never `po.md`.

**The review family stays offline by construction** — with one honestly-scoped exception named
below. `plan-reviewer`, `plan-drafter`,
`plan-reviewer-confirm`, and every gate② `engine-agent` review session never reference
`cfg.webAccess` at all — refusal is the absence of a wire-up, not a check that could be
misconfigured. Gate②'s review-session mode (`reviewCwd`, see below) goes further still: it
REFUSES a caller-supplied `allowedTools` outright (thrown, not silently accepted) alongside
`reviewCwd`, so even a future direct call attempting to widen it would fail loudly rather than
reopen the surface. A gate whose conclusions could drift run to run over a live web result is
not an inspectable gate — this is recorded as a deliberate reproducibility property. Gate②'s
`--strict-mcp-config`/`--setting-sources ""` seal (see [Review session mode](#review-session-mode-closed-mcpsettings-surface-forced-hard-guard-285)
below) is unaffected by anything in this section — it was justified independently, for a
materialized PR tree, and #410 leaves it exactly as it was.

**The exception, stated exactly (#443, `reviewer.agent.runner: codex-exec`).** An operator can
select a locally spawned `codex exec` process as the engine-agent review session's runner. For a
remote-provider CLI, "offline by construction" cannot mean a blanket network denial — the CLI needs
its own provider — so the adjudicated claim for that runner is narrower and is stated here rather
than quietly inherited:

- **No model-invoked egress beyond provider transport.** The session is pinned to
  `--sandbox read-only` (whose recorded permission profile is network-*restricted* for
  model-invoked commands), `-c tools.web_search=false`, and `-c mcp_servers={}` — a
  highest-precedence override, so no MCP server loads from any config source, including a
  producer-authored `.codex/config.toml` inside the reviewed tree. Plus `--ignore-user-config`
  (the operator's own `$CODEX_HOME/config.toml`, and therefore its hooks, never load),
  `--ignore-rules`, and a credential-stripped env (no `GH_*`/`GITHUB_TOKEN`/git credential
  vectors — the same denylist every Claude role session gets). The prompt reaches the CLI on
  **stdin from a file**; the module spawns an argv vector and never a shell, so
  producer-influenced text has no interpolation surface at all.
- **The recorded blind spot.** `--sandbox read-only` blocks *writes*, not *execution*: a
  shell-capable agent under it can still run producer-controlled code from the materialized tree.
  This is NOT equivalent to the Claude runner's Read/Grep/Glob-only, no-`Bash` profile, and the
  adjudication (2026-08-01, R2) deliberately did not add an outer OS/container fence for it
  (trusted-repos posture; the marginal-complexity principle). Instead every codex-exec spawn emits
  a named blind-spot warning event (`engine-review-containment-gap`), so the gap is on the durable
  record rather than assumed away.
- **Unchanged either way.** The default runner is `claude`, and nothing above applies to it. Gate②'s
  own safety properties are runner-independent: blocking stays engine-derived over live PR data, the
  session's output goes through the same element-wise validation for both runners, and an
  unidentifiable session model maps to `unavailable` rather than to a verdict.

**Detected, not pinned — the operator's own settings can still silently strip the grant.** An
earlier version of this feature pinned `--strict-mcp-config`/`--setting-sources ""` for EVERY
peripheral session (the same triple #285 uses for gate②'s materialized-tree review sessions).
A live measurement found that `--setting-sources ""` ALSO stops loading the target repo's own
`CLAUDE.md` — colliding with the locked ruling below ([Ambient repo context: record, don't
seal](#ambient-repo-context-record-dont-seal-236)): a peripheral session absorbing the repo's
own `CLAUDE.md` is a deliberately OPEN channel, never sealed, and pinning would have sealed it
as a side effect for every non-review session. The owner rejected the pinning and adopted the
fallback the original decision record reserved for exactly this case: **lightweight startup
detection**, not containment. `cli.ts`'s `checkWebAccessSettingsDenial` — called from the same
best-effort startup pass as `normalizeUnplacedBoardItems`, right after `assertStopMilestoneExists`
— reads ONLY the operator's user-level settings (`$CLAUDE_CONFIG_DIR/settings.json`, or
`~/.claude/settings.json`; never project/local settings — project settings are repo-governed,
and an engine worktree carries no local settings of its own) and, when `webAccess.enabled` is
true and `permissions.deny` names `WebSearch`/`WebFetch` (bare, or a `Tool(...)`-qualified
prefix like `WebFetch(domain:x)`), emits one warning log line plus one durable
`web-access-denied-by-operator-settings` state event. This is exactly the failure mode #410's
own measurement hit: a granted session's own reported tool list simply omits the denied tool,
with **zero** permission-denial signal — indistinguishable from "this CLI version doesn't have
the tool" without this check. Detection only: it never blocks startup, never spawns a probe
session, and never mutates the operator's settings. The prompts' first-class abstention wording
(`po.md`/`architect.md`, below) is the session-side complement this fallback depends on: a
session whose tool turned out silently absent is expected to report that it could not verify
something externally, rather than silently omit the check or guess.

**Audit: the SAME scanner, not a second one.** `worker.ts`'s `scanEgressSuspects` — the function
the worker's own Bash lexical tripwire already calls — now ALSO recognizes `WebFetch`/
`WebSearch` `tool_use` blocks directly from the structured stream-json transcript
(unconditionally, not gated by `worker.egressSuspectCommands`: unlike Bash, where most
executables are legitimate, these two tool names ARE the entire sanctioned peripheral-egress
channel). `RoleRunner.run()` calls it on every session's own completed jsonl and emits the
identical `egress-suspect` ledger event kind the worker's tripwire uses — `round-artifact.ts`'s
existing assembler needs no changes to surface either kind. This flagging is deliberately
**content-driven, not role-gated**: `--allowedTools`/`--disallowedTools` is a noise-reduction
permission layer, not a schema removal (see [Worker denylist vs. peripheral allowlist](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
below), so a session without the grant — a worker leg, or a peripheral role the #410 grant
doesn't cover — can still EMIT a `WebFetch`/`WebSearch` tool_use block; the CLI's own
permission layer denies it at the paired `tool_result`, which this scanner does not read. A hit
therefore records an attempt, never proof of execution — the same "evidence, not a verdict"
stance the Bash tripwire above already takes. The engine deliberately keeps this unconditional
for every session kind: an attempted egress through a tool a session was never granted is
exactly what a post-hoc tripwire should surface, not suppress.

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

- Under the owner ruling in #290, the #305 compensating controls now deny producer
  label, milestone, and project-board mutations while preserving comment channels;
  credential removal in #351 remains the endgame rather than a claim that argv
  inspection removes ambient credentials.
- `engine/src/roles/peripheral.ts` gives every issues-only role
  `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` and a cross-source veto over `Bash` and write tools,
  strips forge credential variables in `peripheralSessionEnv()`, and leaves forge writes to
  validated engine code. Those sessions have no `gh` grant. This is **not** true of every role:
  `engine/src/roles/worker.ts` deliberately gives an ordinary initial coding leg
  `Bash(gh *)` and inherits the engine environment so the stock worker workflow can push and
  open its PR. Only credential-free fix legs remove that grant
  (`WORKER_ALLOWED_TOOLS_NO_GH`) and use `workerCredentialFreeEnv()` to strip token/config
  variables, point `GH_CONFIG_DIR` at an empty per-lane directory, disable global/system git
  config and terminal prompting, and drop `SSH_AUTH_SOCK`. Even that environment is not a
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
  Since #350, `engine/src/roles/worker.ts`'s `WORKER_DISALLOWED_TOOLS` also denies `gh pr
  review*` and `gh release*` at the CLI permission layer (alongside the pre-existing `gh pr
  merge*`/`gh pr ready*`). This is intentionally broader than the guard's argv block, not a
  duplicate of it: the permission layer denies the entire `gh pr review` and `gh release`
  verbs — including `gh pr review --comment` — while the guard's argv block only stops
  `--approve`/`--request-changes`. The producer's actual comment channels remain `gh pr
  comment` and `gh issue comment`, both left open by both layers.
  Since #488, that deny-list also carries the **governance-signal** verbs `gh issue edit*`,
  `gh label*`, and `gh project*`, so the boundary the guard has enforced at the argv layer
  since #305/#352/#353 now also holds at the permission layer. It matters because every
  dispatch/merge gate treats issue labels and the board `Status` field as engine-or-human-only
  signals (`plan:approved`, `labels.roundPool`, `escalation.humanLabels`, the `Ready` lane): a
  producer that can set them forges the signals those gates trust. Same intentional coarseness
  as the `gh pr review*` entry — `gh issue edit*` denies the whole verb, including the plain
  `--body` edit the guard still permits. `gh api` is deliberately NOT on the deny-list:
  read-only `gh api` is ordinary worker usage and a prefix rule cannot separate it from a
  mutation, which is exactly the argv-shape judgement the guard's `checkGhApi` makes (REST
  label/milestone/state endpoints and GraphQL mutations, including ProjectV2 field writes).
  This closes design #279 §5a's deferred "standalone hardening issue".
- `engine/src/roles/worker.ts` does not add the engine `data/` directory as a Claude tool
  root (there is no `--add-dir data`), so the tool layer does not offer a path into it.
  This is not Bash containment: worker Bash can reach `../../data`, exactly the residual
  documented under [Sentinel isolation boundary](#sentinel-isolation-boundary-honest-statement).
- Merge authority remains a separate choke point. Only
  `engine/src/roles/merge-driver.ts` calls `IForge.mergePR`, after the CI/review gates and a
  final fresh decision; `engine/src/forge/forge.ts` pins the operation with
  `--match-head-commit`. The worker has no reference to that driver, while both its CLI deny
  rules and the guard block direct merge commands.

This is targeted governance containment, **not general Bash containment**. The denylist does
not prove an unrecognized command harmless, inspect arbitrary script bodies, confine filesystem
access performed by a subprocess, or stop a permitted interpreter/package runner from opening
a socket. In particular it does not contain data exfiltration; see
[Worker network egress: accepted blind spot](#worker-network-egress-accepted-blind-spot).
The lexical egress tripwire described there is post-hoc evidence only, not a missing enforcement
layer that this denylist silently supplies.

## Issues-only role sessions: read-only, worktree-confined, no shell (#110, #235)

Workers are guarded by the argv-inspecting hook above. The round orchestrator's
issues-only peripheral roles — plan-reviewer, plan-drafter, PO/align+triage+pool,
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

**On the READ side (#235), every one of these roles is explicitly granted
`Read`/`Grep`/`Glob`** — `peripheral.ts`'s `ROLE_ALLOWED_TOOLS` is
`"Read,Grep,Glob"`, no longer the empty string, and the architect is not a special
case: the 2026-07-17 owner ruling is that whether to read is the model's own
role-scoped judgment (an architect reasoning about a contradiction via an approval
protocol instead of just reading the code is absurd), because reading is not
producing/approving/merging. What makes this safe is a **real, fail-closed
containment mechanism**, not a permission-layer convention: the guard hook's
`checkReadContainment` (`guard.ts`, landed as #235's PR-A) resolves every
`Read`/`Grep`/`Glob`/`NotebookRead` call's target path against the session's own
`SAPWOOD_WORKTREE_ROOT` (an env var the engine sets at spawn time, the same
credential-stripped, engine-controlled channel `SAPWOOD_GUARD_MODE` already uses) and
**blocks** anything that resolves outside it — an absolute host path, a
`../`-traversal, a symlink escape. A live probe (a real `claude -p --worktree`
session, this role's exact allow/deny pair) is part of this feature's verification:
host-path and traversal reads are denied, an in-worktree read succeeds. Before #235
PR-A, this containment did not exist — a real probe found an absolute host path and a
`../`-traversal BOTH escaped the worktree and returned real host file content, which
is why the read-only allow-list widening in this section shipped only once that gap
was closed, never before.

**`--disallowedTools` is the write/exec-side cross-source veto**: `peripheral.ts`'s
`ROLE_DISALLOWED_TOOLS` denies `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and a
**blanket `Bash`** — the bare tool name, not a pattern list. `--disallowedTools` wins
over allow from ANY source, including a target repo's own checked-out
`.claude/settings.json`, an authorization surface this engine does not control — so
this is the real boundary, not a convention a repo's own config could quietly
override. Because no shell exists for these sessions to reach `gh` (or anything else)
through at all, the pattern-layer bypass classes earlier hardening closed one glob at
a time (#102's short `-F`/`-l`/`-p` flag aliases, #108's quoted/escaped `-F`
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
history) genuinely needs it. (`Grep`/`Glob` joined its allow-list in #235 alongside
every other role's — retro's job was already code-aware and already carried `Read`;
it was simply missing the other two read tools.) Its `gh` surface, however, is now **zero** — no `gh` entry of any kind remains in
its allowedTools (#111, shipped in two halves):

- **Read side (#111 PR-A):** retro never browses GitHub live. Instead the engine
  builds a round-scoped digest (PR descriptions + diffs + review signals for every PR
  the round touched, comments/labels for every escalated issue, commit history since
  round start) *before* the session runs, bounded by a hard, deterministically-
  truncated character cap (`roles.retro.digestMaxChars`), and substitutes it into the
  prompt. See [`configuration.md`](configuration.md#roles) for the config key and
  `engine/src/retro/retro-digest.ts` for the assembly.
- **Write side (#111 PR-B):** PR creation originates in engine TypeScript, never in
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
stance the issues-only roles took after #110.

**gate⓪'s freshness re-confirm session** ("does this plan still hold against current
`main`?", #214) needed repo read access before #235 for the same reason every other
role does now: a plan referencing a file since renamed is otherwise unverifiable. Before
#235, this was its OWN sanctioned widening (`CONFIRM_ALLOWED_TOOLS`, narrower than
retro's git-and-file-edit grant) — the base issues-only allow-list carried no `Read` at
all yet. #235 makes `Read`/`Grep`/`Glob` the UNIVERSAL issues-only baseline, so
`CONFIRM_ALLOWED_TOOLS`/`CONFIRM_DISALLOWED_TOOLS` are now byte-identical to
`ROLE_ALLOWED_TOOLS`/`ROLE_DISALLOWED_TOOLS` — kept as their own named exports purely
for call-site clarity in `plan-review.ts`. The session reads the conductor's own
checkout, the same ephemeral worktree every role session already gets and the same
guard-hook containment described above; its freshness relative to `main` is the
conductor's responsibility, not a property this grant controls. This session's
decision, like every other role's, is read from its structured output only, applied by
the engine (`plan-review.ts`), never by a tool call of its own.

### The forge MCP proxy's role x tool matrix (#234, #244)

`RoleRunner` peripheral sessions and worker legs can be attached (config-gated, shadow-mode-first
— see [`configuration.md`](configuration.md#roles)) to a per-session, revocable, read-only forge
MCP proxy that returns sanitized forge data verbatim, with no gate/verdict logic of its own
(fresh-head counting, identity filtering, trigger-pin checks stay
in `reviewer.ts`/`merge-driver.ts`). The live (state 3: `enabled: true, shadow: false`)
production-attachment path is real code, exercised by tests — not merely
constructible-but-inert — but whether a given deployment's OWN config flips it live is that
deployment's choice; this shipped tree's own default config keeps the proxy off
(`enabled: false`). Each session's role scopes it to a fixed subset of the tool
algebra (`proxy/access.ts`'s `PROXY_ROLE_TOOL_MATRIX`), enforced server-side in the proxy itself
(the CLI's own `--allowedTools` widening is noise reduction only, same stance as every other
allow/deny pair on this page) — a role absent from the table below is granted **no tool at all**
(deny-by-default, regression-tested):

| Role | Tools granted |
| --- | --- |
| `po-pool` / `po-align` / `po-triage` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `harvest` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `architect` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `plan-reviewer` / `plan-drafter` / `plan-reviewer-confirm` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `retro` | `issue_details`, `issue_comments`, `issue_relations`, `search_issues` |
| `worker` (the fix-loop leg's PR-review evidence channel) | `pr_details`, `pr_reviews`, `pr_review_threads`, `pr_checks` |
| *(any other role id)* | none — deny-by-default |

**Scope, updated by #245: `WorkerSupervisor.resume()` now attaches a proxy too.** #244 shipped
`dispatch()`-only attachment deliberately (the `resume()` crash-consistency machinery was already
substantial, and consumer-shaped wiring belonged with the actual consumer). #245 (the M9 fix loop)
is that consumer: a fix leg is a *resumed* leg (same worker row/worktree/branch/session — see
"Fix-loop `fixing` lane state" below), and it needs `pr_review_threads`/`pr_reviews`/`pr_checks` as
its evidence channel exactly as much as a fresh dispatch would. `resume()`'s attachment mirrors
`dispatch()`'s byte-for-byte: mint-before-argv, `--allowedTools` widening with the proxy's own
tool names, inline `--mcp-config` injection, `credentialFree`'s fail-closed policy, and teardown on
every exit path (including the two resume-specific spawn-failure branches `dispatch()` doesn't
have — the synchronous `spawn()` throw and the async `'error'`-before-`'spawn'` race). One
resume-only divergence: a `credentialFree` mint failure closes the (already-opened) jsonl fd but
does **not** delete the jsonl file or the `.handoff` sentinel the way `dispatch()`'s cleanup deletes
its fresh, empty jsonl — a resume's jsonl holds real prior-leg history, and a refused resume must
leave the lane exactly as resumable as it was before the call, not destroy its record.

**`credentialFree` severs the `gh`/git CREDENTIALED-TOOL reach — not a worker leg's forge reach in
general.** That distinction matters and is stated precisely here after a round-2 delta review
(P1) proved the broader claim false: env-VAR stripping by itself is NOT sufficient for a
Bash-granted worker: `gh` falls back to on-disk stored credentials (`$HOME/.config/gh/hosts.yml`)
when no token env var is present, and git can still reach a credential helper, a cached SSH agent,
or an interactive prompt regardless of which env vars are absent. `worker.ts`'s
`workerCredentialFreeEnv` (opt-in via `WorkerProxyOpts.credentialFree`) additionally:

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

A mint failure is non-fatal for an ordinary (non-`credentialFree`) proxy attachment — the lane
still dispatches, unattached, same posture as `peripheral.ts`'s `RoleRunner`. `credentialFree:
true` is different: a leg dispatched that way has neither that credentialed-tool path nor (if
mint fails) a working evidence channel, so `dispatch()` REFUSES outright rather than run silently
degraded. Either branch records a durable `proxy-mint-failed` state event (lane/role/sanitized
reason, via `WorkerDeps.state`) before deciding which way to go.

**HONEST SCOPE — this is NOT full isolation (round-2 delta review, P1; PM ruling 2026-07-18, same
"document the residual, don't chase it with more machinery" stance as the Sentinel isolation
boundary section below).** `workerCredentialFreeEnv` closes `gh`'s and git's OWN credential-lookup
paths. It structurally CANNOT confine what arbitrary code run under this lane's
`Bash(node *)`/`Bash(npm *)` grant can read off disk — a fix leg genuinely needs those grants to
run its own test suite, and it still executes with the operator's REAL `$HOME`. A live proof-of-
concept (`node steal.mjs`, a script invoked through exactly that grant) read
`~/.config/gh/hosts.yml` directly and reached GitHub with the credential found there, bypassing
every env var `workerCredentialFreeEnv` touches entirely — filesystem access is orthogonal to
environment-variable redirection, and no amount of env-var scrubbing closes it. Two mitigations
this repo deliberately does NOT attempt: **HOME isolation** (redirecting `$HOME` would break the
`claude` CLI's own config/auth, which the lane also needs merely to run) and **stripping
`Bash(node *)`/`Bash(npm *)`** (a fix leg's whole job requires running tests). The upgrade path
for a boundary that's actually closed is **OS-level sandboxing** (container/chroot/Landlock-style
filesystem confinement) or running fix legs under a **dedicated, narrowly-scoped CI identity**
whose credential store holds nothing worth stealing — neither is implemented here. One narrowing
worth naming precisely: `hosts.yml` is `gh`'s plaintext-token storage path; on macOS, `gh auth
login` by default stores the token in the OS **keychain** instead, which neither this mechanism
nor the PoC exposes — the risk this note describes is sharpest wherever `gh` ends up with a
plaintext on-disk token (Linux, CI images, an explicit non-keychain login), not a universal
property of every `gh` installation.

### Fix-loop `fixing` lane state (#245)

Review findings (`HANDLE_THREADS`) used to fold straight to `needs-human` (`merge-driver.ts`'s
`deriveGate`) — asking a human to *resolve* a review, which inverts the autonomy principle
(humans adjudicate reviews, they never resolve them). #245 gives the producing worker its own
lane state to address findings itself, *before* human escalation, without ever handing it a new
dispatch or forge credentials:

- **New `WorkerState`: `fixing`.** `driving` (holds a PR awaiting gate①/gate②) → `fixing` (a
  LIVE fix-leg worker process reworking that same PR) → back to `driving` once the fix leg
  reaches a terminal outcome. `state.ts`'s `activeWorkers()` counts `running + driving + fixing`
  — a fixing lane occupies capacity exactly like the other two. The actual gate decision that
  triggers `driving → fixing` (deriving `FIXABLE` from a live review verdict) is sibling issue
  #246; #245 ships the lane-state machinery and the seam (`conductor.ts`'s `startFixLeg`) #246
  calls once it decides.
- **Fix leg = `resume()`, never a new `dispatch()`.** `startFixLeg` reuses #172's resume
  machinery outright — same worker row, same worktree/branch/session lineage — specifically to
  avoid the squash-branch-reuse hazard a fresh dispatch against this lane's (possibly-stale,
  possibly-ahead) head would create. The fix leg's prompt (`worker.fixPromptFile`, engine-shipped
  default `prompts/fix.md` — same `#74` config pattern as `worker.promptFile`) instructs the
  worker to pull its own PR's review findings via the PR-facing proxy tools
  (`pr_review_threads`/`pr_reviews`/`pr_checks`/`pr_details`) — never via findings text relayed
  through the prompt itself (no prompt-injection transport).
- **`fix_rounds`** is a new per-PR counter (`workers.fix_rounds`, schema v18→v19), counting
  rework rounds — deliberately independent of `resume_attempts` (#172's continuation-leg
  counter): one axis is "how many times did this PR need fixing", the other is "how many budget-
  exhaustion handoffs did one leg need" — they never share a counter, and a lane can spend both
  independently.
- **The `fixing` → `driving` edge clears the review-trigger pin** (`review_triggered_head`/`at`
  reset to `null`), reusing `MergeDriver.driveOne`'s own re-trigger machinery to force a fresh
  review on the fix leg's new head — the same shape as #147's gated-PR reentry.
- **Supervision**: a `fixing` lane is a live worker process, so the SAME heartbeat/timeout/soft-
  budget supervision and crash-safety machinery (`reclaimTerminalLane`, dirty-worktree retention,
  the kill-switch drain) applies to it as to a `running` lane. It is NOT scanned by the DRIVE
  loop (`state.drivingWorkers()` excludes `fixing` rows by construction), which is also why
  #170's review-silence escalation structurally cannot arm while a lane is fixing — that clock
  only ever fires from inside the DRIVE loop.
- **Narrowed `gatedFailedWorkers()` semantics**: once #246 wires the `FIXABLE` gate in, ordinary
  review findings no longer produce a `failed`+PR row at all (they route to `fixing` instead) —
  the only remaining producer of that shape is the `fix_rounds` cap escalation. Findings no
  longer masquerade as `failed`.

## Ambient repo context: record, don't seal (#236)

Every session above — worker or peripheral — spawns `claude -p` **inside a real repo
worktree**. That means it legitimately absorbs the target repo's `CLAUDE.md`, the
user's global `CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt
sections, exactly like any interactive session would. An earlier internal note claimed
peripheral role sessions got "no repo context beyond what's substituted into the
prompt" — that was never accurate once sessions ran in a real worktree, and the claim
is now corrected at its source (`config.ts`'s `RoleSession` schema comment).

**Owner ruling (2026-07-17), Codex concurring after challenge: this channel stays
open in production.** Sealing it — running with no ambient `CLAUDE.md` at all — would
move the trust boundary to the *content* side, contradicting the locked boundary
this page already states above and in [PLAN.md](PLAN.md#security--trust-model-trusted-first-designed-toward-public):
the boundary is what a session can **do** (the zero-write, zero-`Bash` tool allowlist
— empty until #235, now `Read`/`Grep`/`Glob` guard-confined to the worktree, #110/
#235; the credential-stripped spawn env, #218), never what it can **read**. Repo
conventions
living in `CLAUDE.md` are exactly what a role session *should* absorb — the same
reason a human contributor reads it too. The obligation this channel creates is
**honesty and diagnosability, not isolation**: record what each session attempt
actually saw, so ambient drift between retries (a `CLAUDE.md` edited between attempt 1
and attempt 2, a dirty worktree, a config change) never makes two attempts of the same
phase look comparable when they weren't.

**Wired for all 9/9 `runSessionWithRetry` peripheral call sites today** — harvest,
architect, plan-review (the reviewer, drafter, and #214's confirm sessions), retro,
and (as of [#251](https://github.com/herehigher/sapwood/issues/251)) `align.ts`'s
three PO sessions (`po-align`, `po-triage`, `po-pool`).

**The context manifest.** Every wired role session attempt (`RoleRunner.run()` in
`peripheral.ts`) assembles a manifest in TWO PHASES, each with its own recorded
timestamp (`capturedPreSpawn` / `capturedPostExit`) so the manifest states its own
timing rather than leaving it implicit:

- **Pre-spawn (filesystem-derived half):** captured as early as this engine can
  possibly observe it — anchored to the session's OWN `{"type":"system","subtype":
  "init"}` stream-json line (polled from its still-growing jsonl file,
  `worker.ts`'s `hasSessionInitLine`), **never at session teardown**. The init line
  is the CLI's own signal that it finished loading context (worktree provisioning
  included) and is about to hand control to the model — the exact "what the session
  saw" instant. This matters most for `retro`, the one role that holds write-capable
  tools: capturing at teardown (the original design) would have recorded "what the
  session left behind" — its own proposal commit, a possibly-edited `CLAUDE.md` —
  not what it started with. An EARLIER version of this fix anchored to a bounded wait
  for the worktree DIRECTORY to exist instead of the init line; a focused-suite run
  caught that race live (directory existence does not imply checkout-complete —
  `CLAUDE.md` was recorded absent once, flaky), which is why the anchor is the
  session's own content signal, not a filesystem race. If the init line is never
  observed within the bound (a hung or crashed-before-init session), capture still
  proceeds — best-effort, never blocking — and the manifest's `captureBasis` field
  (`"init-observed"` vs. `"timeout-fallback"`) names which case fired, so a
  lower-confidence capture is never silently presented as equally reliable.
- **Post-exit (self-report half):** the session's own stream-json init report — model/
  CLI version/tool inventory/MCP servers — plus the auto-memory source, whose path is
  only knowable from that same report. These don't drift with worktree edits (the
  init event fires once, near stream start), so reading them at exit costs nothing
  extra and needs no earlier synchronization.

It records:

- **a deliberately bounded, ENUMERATED set of standard sources** — never Claude Code's
  full `CLAUDE.md` resolution graph (`@import` directives, ancestor-directory files
  above the worktree root, any managed/enterprise policy layer are named in the
  manifest's own `knownUnprobed` field, not chased). The manifest's `probedPaths`
  field lists exactly what WAS checked: `<worktree>/CLAUDE.md`,
  `<worktree>/CLAUDE.local.md`, `<worktree>/.claude/CLAUDE.md`, every `*.md`
  RECURSIVELY under `<worktree>/.claude/rules/` (if present — nested subdirectories
  included, not just direct children), and the user-global `CLAUDE.md` — from
  `$CLAUDE_CONFIG_DIR/CLAUDE.md` when that environment variable is set (honoring an
  operator's relocated config dir), else `~/.claude/CLAUDE.md`;
- **every present source captured CONTENT-ADDRESSED inline, with no exceptions** —
  even a worktree-rooted, git-tracked file. An earlier design gave git-trackable
  sources a hash-only "recoverable from git history" shape; that was deleted after
  review because it isn't trustworthy for a write-capable session (`retro`): the file
  could be modified, added, removed, or untracked before `retro`'s own commit, so
  `path + commit` would not reliably reproduce the captured content via `git show`.
  A resolved `gitCommit` survives only as **ADVISORY metadata** on the snapshot — "the
  worktree's HEAD at capture time" — never a recoverability claim. Absence is recorded
  too, distinguishing a confirmed-nonexistent file (`"absent"`) from any OTHER read
  failure (`"unreadable"` — permissions, a directory where a file was expected, ...) —
  the latter is a genuine blind spot that must never masquerade as "this layer
  legitimately doesn't exist";
- the model/CLI version/tool-inventory-hash/prompt actually used — read from the
  session's *own* stream-json init report where possible (`roles/worker.ts`'s
  `parseSessionInit`), with an explicit `modelSource` field (`"session-init"` vs.
  `"requested-fallback"`) so a fallback-model switch, a CLI upgrade mid-fleet, or a
  session that crashed before ever reporting in is visible rather than silently
  assumed to match the request. (The tool-inventory hash is named for what it is: a
  hash of the session's reported tool NAMES, not a schema-version string the CLI
  doesn't emit.)
- MCP server availability (name + live connection status, from the same init report);
- the worktree's resolved git HEAD (via a **namespace-aware** pure-filesystem read of
  git's own plumbing files — see below — never a `git status` call); and
- hashes of the `--settings` JSON and the guard hook file, so a hook/config change
  between attempts is also detectable.

Manifests persist in the state DB's `context_manifests` table, keyed by
`(round, phase, role, session, attempt)` — the same tuple issue #231's separately
developed input manifest will eventually join on. That linkage is deliberately **not**
built here: this table is self-contained (its own migration, its own `State` methods),
so the two features merge independently regardless of order.

**Why no live `git status`.** This engine structurally never execs `git` outside
worker.ts's `claude` CLI launch and `gh.ts`'s `gh` calls — pinned by a grep-invariant
test (`worker.test.ts`, #69) that also bans passing a `cwd` to any subprocess, so the
engine cannot exec git *in a worker worktree* even accidentally. The context manifest
honors that boundary: a worktree's HEAD commit is recovered by reading git's own
plumbing files directly (`.git`'s `gitdir:` pointer, `HEAD`, loose/packed refs) —
pure filesystem, no subprocess. The lookup is **namespace-aware**, matching git's own
repository-layout model: once a worktree has a `commondir`, EVERY `refs/*` ref is
SHARED (resolved from the repo-wide common store only — a stale or shadowing
worktree-local file under the same path, left over from an older git version, a
manual edit, or a corrupted worktree, must never be consulted, let alone win) EXCEPT
three genuinely per-worktree namespaces, resolved worktree-local only:
`refs/bisect/*` (an in-progress `git bisect`), `refs/rewritten/*` (`git rebase
--update-refs` scratch state), and `refs/worktree/*`. (An earlier version of this fix
inverted the model — treating only `refs/heads/tags/remotes` as shared — which got
common cases right by coincidence but would have mis-resolved any other shared
namespace, e.g. `refs/notes/*`, from a stale worktree-local shadow.) `dirty` is
derived, never measured,
from three distinct, honestly-labeled bases: `"structural-no-write-tools"` (the
session's tool grant carries no WRITE-capable tool — `Write`/`Edit`/`MultiEdit`/
`NotebookEdit`/any `Bash(...)` entry — the common case, so `dirty: false` is a
structural guarantee; #235 makes `Read`/`Grep`/`Glob` the universal issues-only
baseline, so this is no longer the same thing as "the allow-list is empty" — a
read-only grant is still `dirty: false`); `"unknown-write-capable-session"` (the grant
DOES include a write-capable tool, e.g. `retro`'s `Write`/`Edit`/`Bash(git ...)` — the
engine cannot rule out a write, so `dirty: true` conservatively, never a false
"definitely clean"); and `"worktree-missing"` (the worktree never appeared on disk at
all within the bounded wait — a distinct fact from either of the above, not folded
into a guess).

**What a session actually used (#235).** Alongside HEAD/cleanliness, the manifest also
records which tools a session's stream actually INVOKED (`toolUsage`: name → call
count, parsed from its jsonl `tool_use` blocks — including a DENIED attempt, e.g. a
blocked `Bash` call, since the attempt itself is diagnostic evidence whether or not it
executed) and which paths its `Read`/`Grep`/`Glob`/`NotebookRead` calls named
(`readPaths`, sorted and deduplicated). This is a RECORD of what was asked for, not a
re-verification of where it landed — the guard hook above is the actual containment
enforcement; the manifest exists so a session's read footprint is diagnosable after
the fact, the same "record, don't seal" stance this whole section takes for ambient
`CLAUDE.md` absorption.

## Review session mode: closed MCP/settings surface, forced-hard guard (#285)

The engine-agent reviewer (design #279) runs a static review session directly against an
already-**materialized** tree — `review/materializer.ts`'s private-clone checkout of the exact
reviewed commit, with no `.git` at all (D1: static-only, no producer-code execution). Unlike an
ordinary worker/peripheral session, this materialized cwd is **producer-controlled content** — the
PR head under review — so the ambient-context posture the section above locks in ("what a session
can *read* is not the boundary") needs one further closure specific to this mode: a materialized
tree can carry its own `.mcp.json` or `.claude/settings.json`, and neither the `--disallowedTools
Bash` grant nor the PreToolUse guard hook mediates MCP-server-process launches or
settings-declared hooks at all — both fire at session **init**, before any tool call either
mechanism could ever intercept. `peripheral.ts`'s `RoleRunner.run({ reviewCwd })` closes this,
hardcoded (not caller-overridable) for every review session:

- **`--strict-mcp-config` + an explicit empty `--mcp-config '{"mcpServers":{}}'`** — zero MCP
  servers configured from any source (project/user/ambient included), regardless of what the
  materialized tree's own `.mcp.json` declares (the CLI never even reads it under
  `--strict-mcp-config`).
- **`--setting-sources ""`** — zero FILE-based settings sources loaded (neither `project` nor
  `local`, both resolved against the session's own cwd — the materialized/producer tree — nor
  `user`, the operator's own `~/.claude/settings.json`). Verified empirically against a live
  `claude` CLI (not assumed from `--help` text alone): with the default (unrestricted) sources, a
  debug-log run showed the CLI applying the operator's real `~/.claude/settings.json` permission
  entries at session init; with `--setting-sources ""`, that application never happened, while the
  CLI still ran a full turn cleanly (exit 0, empty stderr). Excluding `user` too — not just
  `project`/`local` — closes a specific residual this page already names above: a worker leg's
  `Bash(node *)`/`Bash(npm *)` grant runs with the operator's REAL `$HOME` and structurally cannot
  be filesystem-confined from it (the "forge MCP proxy" section's `workerCredentialFreeEnv` HONEST
  SCOPE note, and its `steal.mjs` proof-of-concept), so a producer could in principle have
  influenced the operator's own `~/.claude/settings.json` in an *earlier* round; a review session
  loading `user` settings would inherit whatever that earlier influence left behind. Loading no
  file sources at all removes that inheritance path for review specifically, without requiring the
  broader (still-open) worker HOME residual to be solved.
- **The guard hook keeps working regardless** — it is mounted via **inline** `--settings`
  (`guardSettings()`'s JSON, passed as a CLI argument value, never a file), which this "Benchmark
  isolation recipe" section already establishes is a *separate* mechanism from file-based settings
  discovery (inline `--settings` layers additively; excluding file sources via `--setting-sources`
  doesn't touch it). A review session's read-containment (`SAPWOOD_WORKTREE_ROOT` = the
  materialized tree) is therefore unaffected by closing every file-based settings source.
- **Guard mode is forced `hard`** for every review session (`SAPWOOD_GUARD_MODE=hard` in the spawn
  env), regardless of the engine's configured `guard.mode` — a review session is security-bearing
  by construction and must never silently inherit a weaker, soft (observe-only) posture just
  because the operator runs ordinary worker/role sessions that way.
- **The tool profile (`Read`/`Grep`/`Glob`, no `Bash`) and the no-forge-proxy rule are hardcoded**
  in `RoleRunner.run()` itself, not a caller convention — supplying `allowedTools`/
  `disallowedTools`/`proxy` alongside `reviewCwd` is refused (thrown), the same treatment a
  materialized directory that doesn't exist at spawn time gets (every setup failure maps to a
  `session-unavailable` outcome, never a silent degraded run).

**Projection sanitization contract.** `review/materializer.ts` creates an engine-private bare clone
outside every worker worktree and materializes the pinned head into a temporary plain tree. That
private clone may be reused only after its origin identity matches the requested source and its
allowlisted local config is re-asserted clean both before and after an env-isolated, hooks-disabled
fetch with an explicit mirror refspec; any failed assertion or operation discards it and falls back
to a fresh clone. Every git operation ignores global/system config, and hooks are disabled
command-locally on both fetch and checkout. Dangerous exec-capable clone-local keys fail closed,
and the remote section is restricted to an explicit `url`/`fetch` subkey allowlist;
checkout also disables replacement objects and materializes symlinks as plain text; the resulting
tree contains no `.git` directory, the requested OID is verified after checkout, and a hashed
manifest of the resulting tree is recorded. Instruction files remain
present by design. Their authority risk is handled by the
instruction-path escalation below, while the closed session profile above prevents project MCP or
settings files in that producer-controlled tree from gaining an execution channel.

The other sanitization boundary is the write from the session to GitHub. The session's structured
output is data, never instructions for the engine to execute: a strict schema accepts only complete
per-AC judgments and findings, and deterministic code derives the verdict. When `review/audit.ts`
renders the human evidence record, it escapes table cells and blockquotes every line of finding
prose before it crosses into a PR comment. That quoting prevents session prose from matching the
hosted-reviewer's clean-verdict or reviewed-head parsers. Audit comments are explicitly
non-authoritative and are never read back as gate② approvals.

### Benchmark isolation recipe (evals only — never production)

**Not to be confused with #235's guard-hook read containment above.** This section's
`--bare` recipe seals a session's AMBIENT CONTEXT (no repo/user `CLAUDE.md`, no
auto-memory, no MCP) for reproducible eval comparisons — a different goal from #235,
which confines an ordinary (non-`--bare`) production session's explicit
`Read`/`Grep`/`Glob` tool CALLS to its own worktree via the guard hook, while leaving
ambient `CLAUDE.md` absorption open (see "Ambient repo context" above). Production
dispatch uses #235's containment; it never uses `--bare` — see why below.

Isolation is the *correct* tool for one use case: comparing models/prompts/configs in
a controlled eval where ambient repo/user state must NOT leak into the comparison. For
that case only, run `claude -p` against a **clean, throwaway directory** with explicit,
full prompt injection instead of ambient discovery:

- **`--bare` is MANDATORY, not optional.** Per Claude Code's own docs, `--bare` is the
  *only* mode where the flags you pass become the SOLE inputs — without it, `~/.claude`
  and the current-directory config still load underneath whatever you pass
  (`--settings` is *additive* to the ambient settings layers, not a replacement; an
  `--mcp-config` can still retain ambient MCP servers rather than fully overriding
  them). Skipping `--bare` and hand-picking a few explicit flags does **not** achieve
  isolation — it just adds explicit context on top of the same ambient channel this
  page otherwise documents as intentionally open. `--bare` skips hooks, LSP, plugin
  sync, attribution, auto-memory, background prefetches, keychain reads, and
  `CLAUDE.md` auto-discovery in one flag, and sets `CLAUDE_CODE_SIMPLE=1`.
- a fresh, empty working directory (no repo `CLAUDE.md`, no prior session state);
- `--system-prompt` / `--system-prompt-file` and `--append-system-prompt[-file]` to
  supply exactly the context the eval wants the model to have, explicitly (`--bare`'s
  own doc names these as the intended way to inject context under it);
- `--add-dir` only for the specific paths the eval needs;
- `--mcp-config` (fully replacing, not augmenting, the MCP surface) or omit MCP
  entirely, plus `--settings`, to pin the exact tool/MCP surface rather than
  inheriting whatever's ambient on the runner machine;
- `--agents`/`--plugin-dir` pinned or omitted, same rationale.

**It is not acceptable for production dispatch under any configuration**: `--bare`
disables hooks, and the fail-closed guard hook (`guard.ts`) is the actual
producer≠reviewer≠merger safety boundary this whole page describes — running without
it is running unguarded, full stop, regardless of how convenient the isolation is for
reproducibility. Benchmark runs are a separate, offline, human-supervised activity;
they never feed sapwood's own dispatch loop.

## Instruction-path changes escalate to human review (#292)

Standing reviewer instructions are authority, so sapwood treats their merge history as a trust
chain. Before either a hosted-bot review trigger or a paid engine-agent session, the merge gate
checks the PR's rename-aware changed-file list against `escalation.instructionPaths`. A match on
an old or new path applies `labels.needsHuman` before review proceeds and posts one explanatory
comment. If GitHub cannot provide a complete changed-file list within its API ceiling, the PR also
escalates fail-closed. The exact needs-human PR label is the latch: later ticks neither fetch the
file list nor repeat either write.

This ensures instructions absorbed by a review session were previously human-vetted, while an
instruction edit in the current PR can never use its own new authority to reach autonomous merge.
The default paths cover `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
`.claude/rules/**`, and `AGENTS.md`, so the same rule protects both engine-agent context and the
hosted bot's PR-head guidance. This is deliberately **escalation, not a guard write-denial**:
editing standing instructions is legitimate work, and denying the edit would mask that intent.
The worker may produce the change; a human must adjudicate it. Setting
`escalation.instructionPaths: []` explicitly turns the mechanism off.

## Human-merge-only paths

Some files are structurally off-limits to an autonomous worker because changing them
would let a worker weaken the very mechanism that constrains it. Any change to these is
**human-merge-only**, regardless of what merge mode is configured:

- `guard.ts` / the guard hook wiring
- `reviewer.ts` / `merge-driver.ts`
- security-relevant config (guard mode, reviewer mode, merge mode)
- `.claude/settings*.json` and `.github/workflows/**`

The guard enforces this as a write-path denial (both for the `Write`/`Edit` tools and
for `Bash` redirection/`tee`/`sed -i`/`git mv`/etc. against these paths, checked
position-independently so a wrapper can't hide the write) — but the human-merge-only
rule is also a process rule: even a PR that touches these files and somehow passes CI
and review is not something the conductor should be configured to auto-merge.

### The `sapwood:human-merge-only` label (#397)

The same phrase now also names a **label**, deliberately — one fact, one term. Where the
list above is the *static* set of paths a human must merge, `sapwood:human-merge-only` is
the *runtime verdict* that a particular PR must be merged by a human. Today the
instruction-path escalation above (#292) is its only writer: a PR that edits the reviewer
instruction graph is not broken and nothing is stuck, but its merge decision is not the
loop's to take.

Its contract:

- **Engine-written, on the PR, exactly once.** No automated act ever removes it or
  re-decides it — unlike `sapwood:needs-human`, whose removal *is* the #147 gated-reentry
  handshake that hands the lane back to automation.
- **Not a member of `escalation.humanLabels`.** That array is checked against *issue*-side
  labels (the reclaim fence, `orderForDispatch`, the standby probe), which a PR-only label
  could never satisfy; adding it there would be a no-op for those checks while widening
  `deriveGate`'s veto set for no benefit. The merge veto does not depend on it either — both
  gate paths return their `needs-human` outcome from the escalation result itself, before
  `deriveGate` is consulted.
- **The lane is excluded from reclaim structurally, not by a label fence.** A worker settling
  on this verdict terminates *without* `gated_escalation_labeled`, the same mechanism
  `state.ts` already uses to keep no-PR-failed and label-write-failed rows permanently
  invisible to `State.gatedFailedWorkers()`. A row that never enters `gatedFailedWorkers()`
  can never be gate-reclaimed, so nothing can re-escalate it or re-apply `needs-human`.

There is deliberately **no** static human-merge-only *path scan* on PRs. Three layers already
keep an engine PR off those paths (gate⓪ AC screening #376, the `guard.ts` write-path block
above, and #292); a fourth scanner would be redundant machinery. The label carries the
**verdict**, not a new detection.

### The review-doctrine file is trusted prompt input (#167)

The review-doctrine file (`doctrine.file`, default `docs/REVIEW-DOCTRINE.md`) is
user-editable repo prose and is **not** guard-protected — yet its content is injected
verbatim into the gate② review-trigger comment that the review bot reads, so it can
influence the gate verdict (it could, in principle, instruct the reviewer to wave
things through). It sits inside this page's trusted-repo assumption: doctrine content
is trusted exactly like the rest of the repo's prose, and changes to it deserve the
same review scrutiny as review-gate configuration (`reviewer.*`, `merge.*`). It is
deliberately not sanitized — it's prose written *for* LLM readers, and gate② stays
semantic, not a rules engine.

## Two-tier human controls

sapwood has two independent file-sentinel controls, both living next to the engine's
state DB (`data/`), neither requiring a config edit:

- **Kill switch** (`data/KILL_SWITCH`) — the strict tier. Freezes *all* new dispatch and
  merges. Running workers are asked to hand off gracefully within
  `cost.drainWindowSec`; past that window the conductor escalates to a hard
  process-tree kill. Everything else freezes too: no dispatch, no drive/merge, no
  rollback retry, no reclaim-and-requeue of crashed lanes. Set/lift it with
  `/sapwood-stop` (no argument to set, `--lift` to remove) or by touching/removing the
  file directly.
- **Pause** (`data/PAUSE`) — the gentle tier. Freezes *new dispatch only*. Everything
  already in flight — running workers, PRs already moving through the review/merge
  gate — proceeds exactly as normal. No drain, nothing killed. Use this to stop taking
  on new issues while letting the current round finish (e.g. before a maintenance
  window). Set/lift with `/sapwood-stop --pause` / `--resume`.

If both sentinels are present, the kill switch's stricter behavior governs.

**Interaction with `--until-idle`:** a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run exits on its own — "finish the
round, then stop." Removing `data/PAUSE` afterward doesn't resume anything by itself;
start a new `sapwood run`. Under the daemon (`forever`) mode, the engine keeps ticking
and `--resume` takes effect on the very next tick.

### Sentinel isolation boundary (honest statement)

The engine's `data/` directory (which holds both sentinels and the state DB) sits
outside worker git worktrees as a **permission-layer boundary** — the worker process is
not launched with `--add-dir data`, so it has no `claude`-tool path into that directory.
This is **not an OS-level sandbox**, so the guard (`engine/src/guard/guard.ts`) adds
defense-in-depth (#81) on top of that boundary: any `Write`/`Edit` targeting
`data/KILL_SWITCH` or `data/PAUSE` (including via relative traversal, e.g.
`../../data/PAUSE`) is denied, as is `Bash` `touch`/`rm`/`mv`/`git rm`/redirect-to-path
targeting either sentinel, and a sentinel path appearing as a literal argument to any
other command (e.g. `node some-script.js ../../data/PAUSE`) — including glued to a
flag (`--target=../../data/PAUSE`) — with the
sentinel names matched case-insensitively (macOS/APFS default is case-insensitive, so
`data/pause` hits the real file). What remains open, deliberately documented rather
than blocked:

- a script written via the ordinarily-permitted `Write` tool that hardcodes the
  sentinel path *inside its own source* rather than taking it as a CLI argument — the
  guard judges the Bash command line, not a script's file contents, so
  `node some-script.js` (no path argument) is opaque to it;
- directory-level deletion that never names a sentinel, e.g. `rm -rf ../../data`
  (removes both sentinels *and* the state DB). Blocking the bare `data` suffix would
  false-positive on a worker legitimately removing a `data/` dir inside its own repo,
  so this stays a documented residual instead of a guard rule.

Until those are closed too, treat the isolation boundary as "a worker won't
accidentally step here, and the obvious direct/indirect vectors are blocked," not "a
worker provably cannot reach here by any means."

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget," and they behave differently on purpose:

- **`worker.budgetUsdSoft`** is a **soft** per-worker budget, auto-enforced via a live
  token estimate. stream-json carries no in-progress `total_cost_usd` (only the
  terminal result line has that), so the worker accumulates a running USD estimate
  from every streamed assistant message's token usage (priced by a small, explicitly
  approximate per-model rate table — the shipped `pricing.yaml`, overridable via
  `worker.pricingFile` — with cache reads priced at the cache-read rate, not the
  input rate, so a cache-heavy run doesn't look artificially expensive). Crossing
  the threshold triggers a graceful handoff — finish the current atomic step, commit +
  push WIP, write a progress note, drop a `.handoff` sentinel carrying a resumable
  session id, exit clean — **never** a mid-work `SIGKILL`. A hard kill mid-step both
  burns the spend and throws away the work; a graceful handoff preserves both. The
  estimate is reconciled against the real terminal cost when a lane finishes (the
  divergence is logged, not enforced) — it is a trigger signal, not a billing source
  of truth, so `worker.timeoutSec` plus the hard ceiling below remain the actual
  backstop. A handed-off lane re-enters before fresh dispatch when capacity and spend
  gates permit. Each resumed leg gets a fresh soft budget, bounded by
  `worker.maxResumes` (default 2); resumed `total_cost_usd` is per-leg and is ledgered
  directly, so total recorded spend is the sum of the real legs.
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings.
  Breaching either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses. Their roles differ (#431):
  `dailyBudgetUsd` is the **durable** runaway-spend boundary — a UTC-calendar-day
  ledger sum that survives restarts. `maxWallClockSec` is a **per-process attention
  alarm** — one clock per process life, anchored at process start in memory, fresh on
  every restart at any gap length. A restart is a *sanctioned* renewal (manual, script,
  or a user-configured supervisor — the human's standing intent); the durable
  cross-restart bounds are money (`dailyBudgetUsd`), gates, guard, and the kill switch,
  never the wall clock. Entering a breach emits a reason-bearing
  `ceiling-breach-entered` event once per episode.

**Supervisor prerequisite (#431):** operators running unattended under a supervisor
MUST configure the supervisor's own crash-loop circuit-breaker — e.g. systemd's
`StartLimitBurst=5` / `StartLimitIntervalSec=600` (or the equivalent restart-limit in
your process manager) — sapwood *assumes* it. A crash-looping engine is visible in the
supervisor's restart counters; alert THERE. Defense-in-depth behind that assumption:
the engine's own rapid-restart detector (`engine.rapidRestart`, default 5 starts in
10 minutes) parks autonomous dispatch with an escalation when it observes its own
crash-loop, and the `#382` single-instance data-dir lock keeps a supervisor's fast
restarts from ever double-driving one board. A crash loop's blast radius is bounded
either way by `dailyBudgetUsd` and the merge gates.

In both directions the design favors **drain-then-escalate over an immediate hard
stop** — a hard kill is the last resort, not the first response, because it destroys
in-progress work as well as spend.

## The `origin:agent` label convention

Any GitHub issue created *by an agent* (as opposed to authored directly by a human)
must carry the `origin:agent` label. `sapwood init` provisions this label like the rest
of the taxonomy.

Today this is a **convention, not yet enforced machinery** — no part of sapwood
currently opens issues on your behalf, so nothing yet applies the label automatically.
The machinery lands with v0.2's round-orchestrator peripheral roles (see
[`PLAN.md`](PLAN.md)'s v0.2 chapter): when a peripheral role (e.g. goal-alignment /
decomposition) opens an issue, it will apply `origin:agent` itself, and an
agent-created issue will additionally require **explicit human confirmation** before it
can enter `Ready` — an agent can propose work, but a human still decides what actually
enters the dispatch queue. Provisioning the label now means that gate can be turned on
later without a taxonomy migration.

## The `plan:approved` label and gate⓪ (#88)

Decision #8's `Ready` gate originally checked only that a verification plan *existed* —
not whether it was any good — and `verify:n/a` was self-declared by whoever wrote the
issue. A 2026-07-09 amendment to Decision #8 (locked in issue #77's comments) closes
that gap: a plan must also pass agent quality review before dispatch.

`getReadyIssues` (`engine/src/forge/forge.ts`) now requires, for any issue not labelled
`verify:n/a`, **both** a verification-plan section in the body **and** the
`plan:approved` label — plan presence alone no longer dispatches. `verify:n/a` still
routes through the doc-gate path, but only when `needs-human` is absent: the
plan-reviewer peripheral may *propose* `verify:n/a` for genuinely unverifiable work, but
it always pairs that proposal with `needs-human` in the same action, so it's a human —
never the agent — who actually opens the doc-gate path, by removing `needs-human`
themselves. `needs-human` and `blocked` block dispatch unconditionally, regardless of
any other label present.

**A plan below standard self-heals rather than stalls** (#77 Amendment 2): when the
reviewer finds the plan missing or inadequate beyond its minor-correction latitude, it
does not park the issue for a human — its structured decision names precisely what's
missing, the engine posts that as a comment (the brief), and the loop dispatches a
**scoped plan-drafting session**: issues-only writes, a session distinct from the
reviewer (plan-author ≠ plan-approver — the reviewer never approves a plan it
authored), never a full worker lane, and it never implements the issue itself. The
draft then comes back through a fresh plan-review. The cycle is bounded — at most
`roles.planReviewer.maxDraftCycles` draft→re-review attempts per issue (default 2) —
after which the loop applies `needs-human` with the full attempt trail preserved
(Decision #9's degrade-to-human). Every attempt is externalized as issue edits/
comments, so a human can inspect or intervene at any point. The Ready-gate enforcement
above is unchanged by any of this: implementation dispatch still requires
`plan:approved` (or adjudicated `verify:n/a`) — only the repair path became more
autonomous.

The plan-reviewer/plan-drafter sessions are wired and, since #110, pure computation:
neither holds a `Bash` tool grant, so neither ever runs `gh` itself. Each session's
final message ends in a structured, sentinel-delimited output block; the engine
(`plan-review.ts`) parses it, validates it against a zod schema, re-checks the one
content invariant worth cheaply verifying — an "approve"/drafted body must actually
carry a verification-plan section, since schema-valid is not the same as truthful —
and only then applies `plan:approved` (or any body correction) itself via `IForge`.
Malformed, schema-invalid, or content-invalid output is treated as a failed attempt:
retried once, then escalated to `needs-human` with the full attempt trail, exactly like
an outright session crash. The shipped default prompt lives at
`engine/prompts/plan-reviewer.md` (`roles.planReviewer.promptFile` overrides it — same
`#74` pattern as `worker.promptFile`).

**`plan:approved` is re-endorsed, not permanent (#214).** The plan-reviewer's candidate
sweep above is now scoped to the round pool rather than the whole Ready lane, and a
prior round's `plan:approved` is re-checked — a lightweight, zero-forge-write-on-confirm
session — every time that issue re-enters a pool, before its approval is trusted for
dispatch again; a session that can't confirm or fails escalates `needs-human` the same
way an initial review does. The label itself is never removed by that check either way.
See [`docs/PLAN.md`](PLAN.md#v02-north-star-the-round-orchestrator) (the "gate⓪ is scoped
to the round pool..." locked decision, issue #214) for the full detail.

## The AC-authority dispatch snapshot (#283, design #279 §5)

Per-AC verdicts (the engine-side review agent design, #279) need an authoritative,
immutable acceptance-criteria set to judge a PR against — but the producer holds `gh
issue edit` capability (`worker.ts`'s own grant), so the live issue body is **not**
authoritative once a worker has been dispatched against it: a worker (or anyone else
with write access) could edit the issue after dispatch and silently shift what the
final review measures the PR against.

The fix is engine-side, not a new permission boundary: **before a worker ever spawns**,
the conductor's DISPATCH loop (`conductor.ts`) extracts the checkbox acceptance-criteria
set (`- [ ]` lines under `## Acceptance criteria` — `forge.ts`'s
`extractAcceptanceCriteria`) from the exact body `getReadyIssues` already fetched, and
persists a snapshot — `{full body hash, full body text, AC manifest}` — via
`State.recordAcSnapshot`, inside the same fail-closed unit as the dispatch attempt
itself (a write failure rolls the board claim back to `Ready` exactly like a spawn
failure would). `isDispatchable` (`forge.ts`) additionally refuses to dispatch any
non-`verify:n/a` issue whose checkbox AC set is missing or malformed — a bare
`Verification`/`Acceptance` section with no real `- [ ]` lines is no longer enough,
matching the `plan:approved` re-check in `plan-review.ts`'s `validateReviewerOutput`/
`validateDrafterOutput` (same "approve claim must be true" doctrine, extended to the
checkbox set the snapshot is built from).

**A drifted lane never reaches the merge/review gate.** Before the conductor's DRIVE
loop ever hands a driving lane to `gate.driveOne`, it re-reads the issue's LIVE body
(this IS a live fetch — it exists specifically to detect an edit, not to avoid one) and
compares its full hash against the recorded snapshot (`ac-snapshot.ts`'s
`checkAcSnapshotDrift`) — ANY drift, not just inside the AC section (a verification-plan
edit counts too), fails closed: the lane is escalated to `needs-human` with a
drift-explaining comment, and `driveOne` is **never** invoked for that lane that tick,
for any reviewer kind. There is no re-extraction path — a drifted lane cannot silently
proceed; a human must re-adjudicate (a renewed gate⓪ pass) before the lane can drive
again. A lane with no recorded snapshot (dispatched before this feature shipped) is not
treated as drift — it drives normally, so this only ever tightens NEW dispatches.

**The engine-agent session consumes the snapshot directly.** Its adapter resolves
`state.getAcSnapshot(issue)` and builds the review prompt from that frozen full body and AC
manifest; it never re-fetches the issue body or re-extracts acceptance criteria for session input.
A missing snapshot is `unavailable` fail-closed. The hosted-bot trigger still performs its own live
`getIssueBody` read to build the `@codex review` comment, but the conductor's full-body drift gate
above runs before either reviewer kind reaches its gate path.

**Snapshot ownership is bound to the lane, not just the issue.** `ac_snapshots` is
upsert-by-issue (one row per issue number) — but a `failed`-with-PR lane awaiting a
human's GATED RECLAIM (#147) is *not* counted as in-flight (`activeWorkers()` excludes
`failed`), so a fresh dispatch of the *same* issue number can legitimately overwrite the
issue-keyed snapshot while the older, un-reclaimed lane still exists. Each `WorkerRow`
therefore stamps its own dispatch-time hash (`workers.ac_body_hash`) at creation, from
the exact snapshot just recorded in the same synchronous step (never re-read from the
table) — the drift check verifies that hash still matches the issue's *current* stored
snapshot before ever trusting it as that lane's authority. A mismatch (a different,
later lane's snapshot having since replaced it) — or the snapshot going missing entirely
despite a lane's own record of having recorded one — is treated as a fail-closed
anomaly, escalated exactly like an ordinary live-body edit, never silently absorbed.

Ids in the AC manifest are ordinal+hash (`<1-based position>-<8 hex chars of
sha256(text)>`) — stable for a single extraction (the same body always yields the same
ids), but never assumed stable across a body edit; drift detection is what prevents a
changed body from ever being silently re-extracted into a NEW id set that the engine
would then treat as equivalent to the old one.

## CI execution evidence for engine-agent review (design #279 §4)

A code-verifiable AC reaches `confirmed` only through two complementary checks. The review session
statically maps the AC to a named, substantive, non-skipped test on the discovery path and checks
that its assertions are meaningful. Separately, deterministic engine code requires every
configured `ci.requiredChecks` `{name, app}` pair to match a current-head CheckRun with conclusion
`SUCCESS` whose check suite belongs to that exact GitHub App slug. The app binding is part of the
trust boundary: a same-named check from another app is not evidence. Legacy status contexts and
`SKIPPED`, `NEUTRAL`, queued, or in-progress CheckRuns do not satisfy the chain.

`ci.requiredChecks: []` is parse-valid but emits a warning under `reviewer.mode: engine-agent`.
The shipped drive path then fails its CI-evidence preflight and queues before spending on a review
session. Workflow-command binding remains a documented residual: the agent reviews workflow-file
changes in the diff, but the engine does not statically prove that a named CheckRun executed a
particular command.

## See also

- [`configuration.md`](configuration.md) — the `guard`, `reviewer`, `merge`, `ci`,
  `escalation`, `cost`, `labels`, and `roles` config sections referenced above.
- [`PLAN.md`](PLAN.md) — the full architecture, decision log, and the v0.2 round
  orchestrator's self-feed design.
- [`design/279-engine-review-agent.md`](design/279-engine-review-agent.md) — the full
  engine-agent reviewer design (materialization, review session mode, the drive/audit
  flow) the "Review session mode" section above distills.
