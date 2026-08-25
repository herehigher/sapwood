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

Part of that same pre-public/post-public split: **event-kind renames are free today
(reset the dogfood DB when you rename) and become additive-only after public release**,
because a rename orphans users' existing `events` history. The rule is also recorded at
the source it governs, `engine/src/state/event-kinds/index.ts`.

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
  The issue lifecycle itself (close/reopen/transfer/delete) is
  engine/human-owned: the worker's `gh issue close|reopen|transfer|delete` is blocked at
  the same high-level-CLI-verb layer as the `edit` governance flags, symmetric with the
  REST/GraphQL mutations already blocked underneath it (`gh api -X PATCH
  repos/*/issues/<n>` state changes match `ISSUE_GOVERNANCE_PATH_RE`; GitHub has no REST
  transfer/delete endpoint, so those reach the guard only as `gh api graphql` mutations,
  already caught by the graphql-mutation check). `gh issue comment`/`view`/`list`/`status`/
  `create` remain allowed — comment is the worker's refuse/hand-back channel. A
  no-PR escalation does not depend on a human happening to read that comment: the engine
  itself re-surfaces the worker's own final-message text (already parsed, never a new
  capability) as a `reason` field on the escalation event and its own `needs-human` comment.
  The worker's write path is unchanged — this is a READ-side addition, not a new grant.
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
it records the reviewed head and diff, run id, the decisive attempt's actual reviewer identity
(provider + model, never fabricated), each executed attempt's spend (provider-reported, a pinned-
price estimate, or explicitly unknown — never silently read as $0), prompt hash, and
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

## Host-delegated capability management

sapwood adopts **host-delegated capability management: it abandons in-engine
tool-permission/capability management for producer (worker) legs.** Producer legs officially inherit the operator's host Claude Code environment —
settings sources, MCP servers, skills — as documented behavior, not an accident of unset
flags. **No `capabilities.*` config surface will ever be built**; PLAN.md's locked-decisions
table (Decision #11) records the accepted rationale. Scope is **producer legs only** — the
reviewer/peripheral sealing floor below is untouched and stays non-negotiable.

A live probe (worker's exact dispatch argv: `--permission-mode auto`,
`WORKER_ALLOWED_TOOLS`/`WORKER_DISALLOWED_TOOLS` verbatim) confirmed the premise this
decision rests on: an ambient, user-scope MCP server tool not on the worker's allowlist was
still callable, and the inherited MCP surface included write/exec-class tools (filesystem
write/edit/move, Drive file creation, the full Playwright set, `codex`) — none of which the
guard hook's Bash/file-tool matcher mediates. Inherited MCP tools arrive **deferred, not in
the session's init inventory**, so a prompt or scanner that reads the init tool list and
concludes "no MCP tools available" is wrong; `--allowedTools` does not gate an inherited MCP
tool either (consistent with the Agent/Task-spawning finding below).

**Capability/context decision rule.** Within the trusted-repos threat model, input-side
prompt-injection hardening neither drives nor vetoes capability or context choices: prompt scope
is governed by noise, size, and determinism, while capability is decided by whether its effects
are enforceable at the action boundary. This is why the zero-`gh` peripheral design (below) was
decided by enforceability rather than by input-trust concerns, and the same rule governs
engine-injected context and retrieval design. Revisit input-side hardening when untrusted-repo
support is actually scheduled, as its own milestone-level threat-model decision rather than a
standing constraint on trusted-repo capabilities.

**Peripheral vs. producer split.** "Enforceable at the action boundary" cuts differently for the
two session classes this page distinguishes. A peripheral session's action boundary is the CLI's
own tool grant (no `Bash`, no write tool, the zero-`gh` design) — genuinely enforceable, so
capability was withheld there. A producer (worker) leg's action boundary is different in kind:
the guard hook mediates Bash/file-tool calls but cannot mediate `mcp__*` calls at all (see "What
stays engine-owned" below), so in-engine capability *management* for the inherited MCP surface
was never actually enforceable — host-delegated capability management (this section) is that same
rule applied honestly to that surface, choosing the real enforcement points (the guard's
write-path denial, branch protection) over a config knob that could not have been enforced.

### What stays engine-owned (the governance core)

Everything a producer leg's write path actually depends on stays engine-enforced; only
in-engine *tool-permission* management for producer legs is abandoned. Five mechanisms:

1. **The guard hook**, injected as inline `--settings` JSON (self-disable-proof, see
   [producer ≠ reviewer ≠ merger](#producer--reviewer--merger) above) — unchanged.
2. **Gate② review-session seal** (`--strict-mcp-config` + an empty `--mcp-config`, and
   `--setting-sources ""`) — the **only** sealing floor; see [Review session mode](#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)
   below. Non-review peripherals stay unsealed.
3. **Human-merge-only write-path enforcement** — the guard's `checkWritePath` — see
   [Human-merge-only paths](#human-merge-only-paths) below.
4. **Role routing, merge-driver identity/CI binding (the TOCTOU pin), the state ledger, and
   the audit trail** — `merge-driver.ts`'s `driveOne` remains the only caller of
   `IForge.mergePR`, pinned with `--match-head-commit`.
5. **`credentialFree` legs additionally force a sealed MCP surface**: `strictMcpConfig: true`
   plus an engine-composed, proxy-only `mcpConfig`, so a credential-free fix leg cannot reach
   an ambient forge-authority MCP server even though it keeps an open `--setting-sources`
   (stripping forge credentials is the action-side control, sealing MCP is the content-side
   complement).

### Accepted blind spots

- **Residual unknown MCP servers are the top-ranked accepted blind spot.** Server-granularity
  denial (below) only covers *known* forge-authority and filesystem/write/exec-class server
  names; an unrecognized server added to the operator's host environment is not caught by
  this mechanism. Branch protection (next bullet) is the backstop for exactly this gap.
- **Branch protection is the mandatory platform backstop.** Because producer legs inherit the
  full host tool surface, sapwood does not claim the engine alone prevents an inherited tool
  from writing to the repository outside the reviewed PR path; a protected default branch
  (no direct pushes, required reviews/checks) is documented as mandatory, not optional,
  precisely because the in-engine capability boundary was deliberately not built for producer
  legs. **This backstop's presence is now detected, not just documented.** Once per
  engine start, `engine/src/loop/branch-protection-warning.ts` reads the target repo's default
  branch protection state (classic branch-protection endpoint, then — only on a 404 — whether
  an active ruleset covers the branch) and logs one warning naming the branch and both operator
  exits when the branch is POSITIVELY VERIFIED unprotected. This is warn-only observation, the
  same stance as the [managed-settings exception](#managed-settings-allowmanagedpermissionrulesonly-exception)
  below: no startup refusal, no label, no gate, and an inconclusive read never fires the
  warning — it never enforces the backstop it names.
- **(b′) server-granularity MCP deny vs. `allowManagedPermissionRulesOnly`.** The
  server-granularity deny for producer legs (known forge-authority/github-class and
  known write/exec/filesystem-class MCP servers appended to `WORKER_DISALLOWED_TOOLS`)
  lands
  in `--disallowedTools`. As [documented above](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry),
  a target repo whose managed settings set `allowManagedPermissionRulesOnly: true` causes the
  CLI to discard every CLI-argument permission rule — including this server deny, alongside
  the rest of sapwood's `--disallowedTools` containment. The owner ruling is disclose +
  detect-and-WARN — one startup warning naming both operator
  exits, no refusal; see the [managed-settings exception section](#managed-settings-allowmanagedpermissionrulesonly-exception)
  below. The interaction stays named here, never silently accepted.

### Doctrine lines

<!-- sapwood:skill:ac-evidence-tiers:start -->
- **AC evidence is tiered by trust origin, not by reproducibility.** The invariant that
  matters is that **the producer cannot forge the evidence** — CI is the common-case
  implementation of that invariant, not its definition. A verification plan's acceptance-criteria
  evidence is ranked into one of four tiers:

  - **A — engine-verified.** Deterministic engine code computes the fact itself
    (`probePushedBranch`, diff-hash pinning). Zero extra trust links; the predicate is untouchable
    by the producer.
  - **B — CI-executed.** The trusted executor ran the repo's checks **on the reviewed head SHA**,
    and the engine consumes the check conclusion via API. **No re-run/reproduction requirement
    anywhere** — one execution bound to the pinned head suffices; reproducibility is an audit
    property, not an acceptance action. B sits below A because the producer influences check
    CONTENT (the PR contains the tests — it can weaken them); mitigations: gate② reviews test
    diffs, `ci.requiredChecks` is config-pinned (not PR-editable).
  - **C — human-witnessed probe.** An operator personally runs the check and records actor +
    steps + timestamp + artifact in the issue **body** (the dispatch snapshot is what gate② reads;
    a comment is not evidence). Non-reproducible but producer-unforgeable; costs human attention.
    Accepted ONLY when the plan names a structural reason CI cannot perform the
    check (missing credential, live external state), the reason is independently verified at
    gate⓪ (true, not merely present), CI/engine-checkable sub-facts are decomposed OUT of the
    probe into A/B, and the producer never self-executes or self-attests it.
  - **D — producer-side artifacts** (browser output, screenshots, session logs,
    inherited-host-tool observations): **never acceptance evidence**, advisory at most. This ban
    is the hard invariant — host-delegated capability means the producer leg's own session output
    cannot be treated as evidence of anything the engine did not independently verify.

  The repo already practices non-CI trusted evidence below tier A/B (the `verify:n/a` doc-gate;
  an operator-run probe recorded in the issue **body**) — this doctrine names that existing practice's
  rules instead of contradicting it with an absolute CI-only form.
<!-- sapwood:skill:ac-evidence-tiers:end -->
- **Hosts lacking a veto-hook + sealed-session primitive run `produce-PR-and-stop` only.**
  Autonomous merge (Decision #5) depends on the guard hook and the gate② seal existing and
  being wired; a host environment that cannot provide an equivalent PreToolUse veto hook and a
  sealed, closed-MCP/settings review session must not run autonomous-merge mode — the safe
  degrade is `produce-PR-and-stop`, where a human merges.

**Rewording principle.** Because producer legs inherit the host environment, no prompt,
source comment, or doc may assert tool-inventory completeness — "no tool of yours", "no way
other than", "there is no such tool", "structural" (in the sense of *the model structurally
cannot reach X*) — about a producer leg's own session. State the engine-enforced structural
fact instead: all forge writes are applied by deterministic engine code from validated
structured output, never by the session itself. (A closed, sealed gate② review session, per
the seal above, is the one place "read-only" can still be asserted truthfully — its `--strict-
mcp-config`/`--setting-sources ""` seal is the mechanism, not a description of the producer
leg's session.)

## Worker network egress: Bash-channel containment available as a hardening profile

sapwood's containment is action-side. The guard prevents a producer from approving or
merging its own work, protects security-bearing write paths, and confines guarded read-tool
calls to the worker's worktree. The conductor separately owns review and merge actions.
Those controls do **not** contain network egress from arbitrary commands a worker runs
through `Bash`. A worker that can execute `curl`, open a socket, or run an equivalent program
can send repository or environment data to an external endpoint.

**Amended by [DR #1009](https://github.com/herehigher/sapwood/issues/1009), re-adjudicating
[#304](https://github.com/herehigher/sapwood/issues/304) (c), further amended 2026-08-20
(owner ruling, deferral record [#1038](https://github.com/herehigher/sapwood/issues/1038)):**
#304 rejected egress isolation on the premise that no proxy/isolation layer existed and building
one would be heavy. That premise is gone — Claude Code's built-in Bash sandbox (see [Execution
profiles](#execution-profiles-host-permission-mode--bash-sandbox) below) IS a layer that could
close it, shipped by the host, requiring no engine-side build. Engine-enforced injection of that
sandbox was evaluated (DR #1009, probed P1–P8) and **deferred pre-release** — no engine-injected
sandbox config key ships, and the engine injects no sandbox settings into any session. **The Bash lexical
tripwire below is therefore the only engine-side mitigation for worker Bash egress**, full stop —
not conditional on any config key. The probed floor survives as an **operator recipe** (below):
an operator who wants Claude Code's built-in Bash sandbox enabled for engine-spawned sessions
configures it in their OWN Claude settings (project/user/managed) — the engine neither requires
nor prevents this.

That gap is an accepted boundary, not an isolation feature waiting to be implied by the rest of
the model. sapwood targets trusted repos first; the engine does not configure a network-isolated
sandbox or proxy for worker sessions. Operators must therefore treat worker Bash egress as a
blind spot — mitigated only by the lexical tripwire below and, if the operator has independently
configured one, whatever their own Bash-sandbox settings enforce — when deciding which
repositories, host credentials, and environment data are safe to expose to a run. This is not the
engine's only inherited-capability egress gap: host-delegated capability management (above)
documents a second, broader one — the operator's ambient host MCP surface, which a producer leg
inherits regardless of `Bash`, which the guard hook's matcher does not mediate, and which a Bash
sandbox would not cover either (MCP servers are separate processes, not Bash subprocesses). The
two are tracked separately because they arrived from different decisions and are detected by
different mechanisms (the Bash lexical tripwire below vs. `scanEgressSuspects`'s `mcp__*`
family), not because either is more or less real than the other.

The engine adds a monitor-only lexical tripwire at lane end. It scans the completed leg's
existing Claude stream-json log for Bash tool calls whose executable matches
`worker.egressSuspectCommands`, then writes deduplicated `egress-suspect` events through the
ordinary events ledger. Detection is post-hoc and fail-safe in the allow direction: it never
denies a command, holds a lane, adds `needs-human`, or changes the worker outcome, and a scan or
event-write failure is logged without becoming a gate. This is a **tripwire, not containment**.
It can catch naive or accidental exfiltration attempts and leave an audit trail, but a
deliberate adversary can trivially evade lexical executable matching — for example with an
interpreter one-liner or DNS exfiltration.

### Loopback targets: tagged, never excluded

A dogfood run flagged `curl http://127.0.0.1:5173/...` dev-server smoke checks with exactly the
prominence of real public egress the same run caught, which trains an operator to skim the
signal. The recorded decision is to **tag, not exclude**: a hit whose targets are all loopback is
still scanned, still deduplicated against the same per-leg cap, and still journalled with full
evidence — it simply carries `target: "loopback"` in the `egress-suspect` payload, and the round
artifact and harvest facts mark it so the prominent lines stay the public ones. Nothing is
suppressed, so the audit trail this tripwire exists to leave is unchanged.

The classification covers `localhost` (including RFC 6761 `*.localhost`), the whole `127/8`
block, and `::1`, matched only inside a `scheme://host` URL. Absence of the tag is the fail-closed
default — "not proven loopback" — and every ambiguity resolves that way: a snippet mixing loopback
and public URLs, an unparseable authority, a snippet with no URL at all (a `WebSearch` query, an
`Agent` spawn description), and a schemeless `curl 127.0.0.1:5173` are all left untagged at full
prominence. That direction is deliberate: a missed loopback URL only restores prior tripwire
behavior for a benign hit, whereas the opposite error would downgrade something that genuinely reached
the network. Classification reads the full observed text, not the 200-character evidence snippet,
so a public URL truncated out of the recorded evidence cannot leave a hit tagged loopback.

Note that loopback is not "safe" in general — a local port can be a proxy onward — which is
precisely why this is a prominence marker on a retained record, not an exclusion.

## Execution profiles: host permission mode + Bash sandbox

**[DR #1009](https://github.com/herehigher/sapwood/issues/1009) (owner-confirmed 2026-08-19),
re-adjudicating [#304](https://github.com/herehigher/sapwood/issues/304) (c) and amending
[Decision #11](PLAN.md#constraints-locked-decisions); further amended 2026-08-20 (owner ruling, deferral
record [#1038](https://github.com/herehigher/sapwood/issues/1038)):** every `claude` role
session sapwood spawns has run `--permission-mode auto` since the first `worker.ts`. #1011
implements the operator-choice half of that DR — `host.permissionMode`, below — as a config key.
The DR also probed Claude Code's built-in Bash sandbox (Seatbelt on macOS with nothing to
install, bubblewrap+socat on Linux/WSL2) as a candidate engine-injected floor for worker Bash
egress; the owner deferred that half pre-release (#1038) — **the engine injects no sandbox
settings and no sandbox-selecting config key exists.** The probed floor survives as an **operator
recipe** (below): paste-ready JSON for the operator's OWN Claude settings, not something sapwood
configures on their behalf. **`host.permissionMode` is a profile key, not a capability grant** —
it configures HOW a session's tools reach the host, never WHICH tools a producer leg is offered
(that stays [host-delegated capability management](#host-delegated-capability-management),
Decision #11, unchanged and unrelated). No `capabilities.*` surface is reopened by this DR.

### Seven layers, none redundant with another

These seven mechanisms answer different questions; landing the sandbox makes none redundant:

| # | Layer | Owner | What it answers |
|---|-------|-------|------------------|
| 1 | CLI `--allowedTools`/`--disallowedTools` | Host tool shaping (advisory for producers) | Which named tools/subcommands does the CLI offer this session at all? |
| 2 | Guard hook + deterministic engine writes + merge driver | Governance effects | Which write actions (merge, label, forge state change) are EVER trusted, regardless of what a session asked for? |
| 3 | L0/L1 credential tier (worker credential tiers, above) | Credential identity | WHO is this session, forge-API-wise — the operator's full identity, or a scoped git-transport-only key, or nothing? |
| 4 | Bash sandbox (operator-configured, recipe in this section) | Execution reach — Bash subprocesses only | What can a Bash command this session RUNS read, write, or reach on the network, once it's already been allowed to run? |
| 5 | Forge MCP proxy | Information access | What forge (GitHub) data can this session read/write through the engine's own mediated channel, independent of raw `gh`/git? |
| 6 | AC-authority dispatch snapshot | Authoritative gate input | What is the issue's body/ACs AS OF DISPATCH, immune to a later producer-side edit? |
| 7 | Gate② review-session seal | Init integrity | Does the REVIEW session itself start with zero MCP servers, zero file-based settings, and a forced-hard guard? |

Layer 4 (the recipe below) is orthogonal to layer 3 (credential identity vs. execution reach —
two independent axes; an operator-configured Bash sandbox is never coupled to
`worker.deployKeyPath`/`worker.deployKeyId` in config, though operationally an L1 deployment is
the natural pairing since both reduce the same class of theft-blast-radius). It would apply to
every Bash-bearing `claude` session the engine spawns — worker legs (dispatch/resume/fix) and
`retro` — never to gate② (D1: no Bash at all in a review session) or to `codex exec` (its own
`--sandbox read-only`, a vendor-specific mechanism outside this recipe's scope).

### Deployment-tier ladder

From lightest to strongest, matching Claude Code's own [sandbox
environments](https://code.claude.com/docs/en/sandbox-environments) taxonomy:

| Tier | Isolates | sapwood's stance |
|------|----------|-------------------|
| Host (default) | Nothing engine-configured; whatever the operator's own Claude settings already do | The engine's own default — it injects nothing |
| Bash sandbox (operator-configured, recipe in this section) | Bash subprocesses only (filesystem + network); built-in tools (Read/Edit/Write), MCP servers, and hooks run unconstrained | Operator recipe only — the probed floor (below) is paste-ready for the operator's OWN Claude settings; engine-side injection was evaluated and deferred (#1038) |
| `@anthropic-ai/sandbox-runtime` | The WHOLE `claude` process — Bash, built-in tools, MCP servers, and hooks together, same OS primitives as the Bash sandbox | Operator recipe only (below); sapwood does not wrap its own process launch in it — framework code stays generic (CLAUDE.md non-negotiable) |
| Dev container / custom container | Full development environment, Docker-based | Operator recipe only; the upstream example dev container's default-deny firewall is the documented starting point for pairing with `--dangerously-skip-permissions`-class unattended runs |
| Dedicated VM / Claude Code on the web | Full OS, or Anthropic-managed VM | Out of scope for sapwood's own engine; named for completeness, not built |

The docs' own framing is the one sapwood adopts verbatim: for `-p --permission-mode auto`
sessions, the Bash sandbox is **defense in depth**, explicitly "not sufficient for fully
unattended runs in either mode" — the recommended unattended boundary is a container, VM, or the
sandbox runtime, which additionally wrap MCP servers and hooks. **sapwood documents this
outer-boundary recipe below; it does not build one** — containers are deployment-specific, and
`engine/`, skills, and shipped prompts encode only generic dev-loop mechanics (CLAUDE.md
non-negotiable).

### `host.permissionMode`: `dontAsk | auto | bypassPermissions`

One global key, default `auto` (today's unchanged behavior), applied to every `claude` session
the engine spawns. The engine's deny side — `WORKER_DISALLOWED_TOOLS`, `ROLE_DISALLOWED_TOOLS`,
the guard hook, gate② seal — is **mode-independent and stays engine-owned** across all three
values; only the allow side moves.

- **`auto`** (default) — unchanged from today. A classifier reviews actions in place of a human
  prompt; a `-p` session with no `--permission-prompt-tool` denies an action outright once the
  classifier's repeated-block threshold is hit, rather than hanging on a prompt that can never
  arrive.
- **`dontAsk`** — only an explicit `permissions.allow` rule, a [read-only Bash
  command](https://code.claude.com/docs/en/permissions#read-only-commands), or a
  PreToolUse-hook-approved call runs; everything else auto-denies. **The allow side is the
  OPERATOR's Claude settings** (`permissions.allow` merges with the engine's `--allowedTools`
  floor — there is no engine `allowedTools` config key). Probed live (#1009 P7) against the
  worker's exact argv: a NAMED `WORKER_DISALLOWED_TOOLS` rule denies one way
  (`decision_reason_type: "subcommandResults"`), anything never explicitly allowed denies another
  way (`decision_reason_type: "mode"`) — both shapes an operator's `permissions.allow` rules need
  to cover for a `dontAsk` worker to stay productive.
- **`bypassPermissions`** — everything runs without a prompt or classifier check, including
  writes to Claude Code's own [protected
  paths](https://code.claude.com/docs/en/permission-modes#protected-paths). **This is an operator
  call the engine does not gate:** whether the operator's own OS-level isolation is adequate is a
  judgment the engine has no way to verify. At startup, when `bypassPermissions` is configured,
  the engine emits one guidance-carrying WARN (log line + a `bypass-permissions-mode-configured`
  state event, #1011) naming the outer-boundary recipe below. Probed live (#1009 P8): a headless
  `-p` session under `bypassPermissions` starts with no
  acceptance dialog, and the engine's deny side still fires — `--disallowedTools`
  (`decision_reason_type: "rule"`) AND an inline PreToolUse guard hook's `exit 2`
  (`PreToolUse:Bash hook error: ...`) both independently blocked a `gh pr merge` attempt,
  confirming "deny rules block in every mode, including `bypassPermissions`" for a CLI
  `--disallowedTools` entry specifically. **Residual, not independently probed:** a managed
  `permissions.disableBypassPermissionsMode: "disable"` silently removes this mode regardless of
  what `host.permissionMode` requests — engine-invisible.

### Bash sandbox: operator recipe (engine injection deferred)

**The engine injects no sandbox settings into any session it spawns, and no sandbox-selecting
config key exists.** DR #1009 probed Claude Code's built-in Bash sandbox as a candidate
engine-injected floor (P1–P8); the owner deferred engine-enforced injection pre-release
(2026-08-20, [#1038](https://github.com/herehigher/sapwood/issues/1038) — no known deployment,
dogfood included, would enable it today, so shipping the injection path plus its containment
tail would serve zero users). Re-introduction is deferred to real demand, tracked in #1038 along
with its adoption/containment designs.

An operator who wants Claude Code's built-in Bash sandbox engaged for engine-spawned sessions
configures it in their OWN Claude settings (project/user/managed) — the engine neither requires
nor prevents this, and never inspects or overrides it. The probed floor below is paste-ready for
that purpose:

```json
{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,
 "failIfUnavailable":true,"network":{"strictAllowlist":true},
 "filesystem":{"denyRead":["~/.config/gh","~/.ssh","~/.aws","~/.claude/.credentials.json"]}}}
```

This floor carries no `allowedDomains`/`allowRead`/`allowWrite` — an operator pasting it in must
add `allowedDomains` (`github.com` at minimum; a real deployment needs more — the forge API
endpoints, package registries, and any other host the worker's Bash calls legitimately reach) in
the same settings, or no sandboxed network destination is reachable at all.

**L1 deploy-key note:** plain `ssh` cannot resolve or reach GitHub from inside the sandbox
(confirmed live, #1009 P1(b)), so an operator running an L1 (deploy-key) deployment under this
recipe additionally needs `excludedCommands: ["git push *","git fetch *","git pull *","git
ls-remote *"]` — exactly the four network verbs deploy-key SSH transport needs, prefix-matched
against the command after any leading environment assignments (so `GIT_SSH_COMMAND=… git
ls-remote …` matches `git ls-remote *`; `git -c … ls-remote …` does not, and stays sandboxed).
`excludedCommands: ["git *"]` was tested and rejected as needlessly broad: it exempts every local
git operation (checkout/commit/merge/rebase/add/diff/log/status) along with the four verbs that
actually need it — an unnecessarily large unsandboxed surface for the same functional outcome.
(Verified feasible on claude 2.1.235: SSH:22 transits the sandbox's authenticated HTTP CONNECT
proxy via a proxy-aware `ProxyCommand`; not documented as a simpler alternative here because the
added complexity isn't worth the narrowing it would close.)

Enabling this recipe with `failIfUnavailable: true` (as shown) makes sandbox-initialization
failure block CLI startup instead of falling back unsandboxed, per Claude Code's own
documentation. Neither the engine nor this recipe positively attests per-leg engagement; #1010's
observability records whatever `<sandbox_violations>` count a session's own transcript reports,
independent of whether the sandbox was engaged by this recipe, some other operator
configuration, or not at all. In probing (P5 on claude 2.1.235), the init event exposed no
sandbox field, while a denied tool result carried `<sandbox_violations>`.

**Guaranteed, once an operator has this floor active:** the `dangerouslyDisableSandbox` escape
hatch is off; `sandbox.filesystem.denyRead` closes the worker.ts:1929 `steal.mjs` read (probed:
`EPERM`, with a specific `allowRead` entry able to re-open one named file); ordinary
git-over-HTTPS to an allowlisted domain transits the sandbox's CONNECT proxy cleanly; `npm
ci`/build/typecheck/lint run clean with the host allowing just `registry.npmjs.org` for this repo
(a local-port-binding test additionally needs `network.allowLocalBinding: true` — off by
default, `EPERM` on `listen(127.0.0.1)` without it); boolean keys (`allowUnsandboxedCommands`,
`failIfUnavailable`) resolve by settings-scope rank, not merge, so they can't be locally
re-opened the way array keys can (below); the guard hook and `--disallowedTools` both keep firing
regardless of sandbox state, including under `bypassPermissions` (probed) — those stay
engine-owned and are unaffected by whether an operator has this recipe active.

**Residual, even with this recipe active:** array keys (`allowedDomains`, `excludedCommands`,
`allowRead`, `allowWrite`) are ADDITIVE across settings sources with no lock outside managed
settings — a worker-writable worktree's own `.claude/settings.json` widened the inline floor's
`allowedDomains` in a live probe (#1009 P6); the effective allowlist is `allowedDomains` plus
every `WebFetch(domain:...)` rule, not `allowedDomains` alone. `excludedCommands` matches by
command PREFIX against the invocation after any leading environment assignments (so
`GIT_SSH_COMMAND=… git ls-remote …` matches `git ls-remote *`; `git -c … ls-remote …` does not,
and stays sandboxed) — `["ssh *"]` never matches an `ssh` child spawned by `git`, and a `-c
...`-prefixed git invocation escapes a subcommand-specific exclusion too (fails DNS the same as
any other unexcluded `git` call). The L1 exclusion above (four network verbs only) leaves them
running unsandboxed — their own filesystem writes included. An allowlisted domain is not a
protocol-or-port restriction — CONNECT was verified to carry SSH:22 to an allowlisted
`github.com` the same way it carries HTTPS. `bypassPermissions` skips protected-path checks and
the sandbox never covers `Edit`/`Write` at all, so a same-lane self-escalation via
`.mcp.json`/`.claude/hooks` stays structurally possible, bounded only by the guard hook and by L1
credential absence. A managed `allowManagedDomainsOnly`/`allowManagedPermissionRulesOnly` policy
can silently change the effective floor the same way the existing [managed-settings
exception](#managed-settings-allowmanagedpermissionrulesonly-exception) already documents.
GPG-signed commits fail under the default filesystem confinement (`~/.gnupg` unwritable, probed
P1a) — a host allowance (`filesystem.allowWrite: ["~/.gnupg"]`), not a change to the floor above,
closes it.

Sandbox coverage is Bash subprocesses only — built-in tools (Read/Edit/Write), MCP servers, and
hooks run unconstrained regardless of whether this recipe is active, which is why it is not
sufficient for unattended runs on its own; see the deployment-tier ladder above and the outer-
boundary recipe below for what wraps the whole process.

### Operator recipe for an outer boundary (pointers, not files)

sapwood documents, and does not build, the containers/VM/`srt` layer the deployment-tier ladder
names above — this stays deployment-specific, never framework code. None of the three is
provisioned, launched, or verified by the engine; the same review checklist applies regardless of
who hosts it — what's mounted writable, what credentials are reachable inside it, what the egress
policy allows. This is the recipe the `bypassPermissions` startup WARN (above) points at:

- **`@anthropic-ai/sandbox-runtime`** (experimental) — wraps the WHOLE `claude` process (MCP
  servers and hooks included, not just Bash) in the same Seatbelt/bubblewrap primitives the
  built-in sandbox uses. `npx @anthropic-ai/sandbox-runtime claude`, configured via
  `~/.srt-settings.json` or a passed `--settings` file; must explicitly allow-write the project
  directory, `~/.claude`/`~/.claude.json`, and `/tmp`, and allow-domain `api.anthropic.com` (or
  the configured provider) plus `claude.ai`/`platform.claude.com` for OAuth sessions.
- **Dev container** (stable) — the upstream [example dev
  container](https://code.claude.com/docs/en/devcontainer) with a default-deny iptables
  firewall, copied into a target repo and adjusted for its own base image and allowlist. Because
  the firewall blocks unapproved egress, this is the documented pairing for
  `--dangerously-skip-permissions`-class unattended work.
- **Custom container / dedicated VM** — an operator's own infrastructure; the same review
  checklist applies regardless of who hosts it.

## Peripheral network egress: WebSearch/WebFetch, detected not pinned

Three role sessions — `architect`, `po-align`, `po-triage` — are granted the CLI's built-in
`WebSearch`/`WebFetch` tools, `webAccess.enabled` (default `true`, a config key can disable it).
This is a bounded widening, not a relaxation of the posture above: unlike the worker's Bash
egress, this channel is exactly two named, read-only tools, carries no credential into any
project system, and every call is journalled (see the audit paragraph below). This design
rejected a domain allowlist (self-defeating — the point is discovering
things nobody knew to look for, and an allowlisted domain accepting an arbitrary path/query is
itself an egress channel) and MCP delivery (the guard hook has no `mcp__` handling at all, so a
built-in-tool grant stays visible to the engine's own enforcement layer and journal in a way an
engine-hosted MCP tool would not) — the same guard-blind-spot fact the host-delegated capability
management doctrine (above) later documented at doctrine level for producer legs generally; this
choice of `WebSearch`/`WebFetch` over MCP for this specific grant remains sound for the same
reason, it just no longer needs restating as though the guard's `mcp__` blindness were unique to
this decision.

**Grant, per-role, named exports.** `peripheral.ts`'s `ARCHITECT_ALLOWED_TOOLS`/
`PO_ALIGN_ALLOWED_TOOLS`/`PO_TRIAGE_ALLOWED_TOOLS` each widen the base `ROLE_ALLOWED_TOOLS`/
`PO_ALLOWED_TOOLS` with `WebSearch,WebFetch` — the same named-export-plus-pinned-regression-test
pattern `CONFIRM_ALLOWED_TOOLS` already established. `cfg.webAccess.enabled` is read at each
role's OWN call site (`architect.ts`, `align.ts`'s po-align/po-triage sessions), never inside
`peripheral.ts` itself — a role whose call site never threads that ternary in has no config path
that could ever reach the grant. `po-pool` (align.ts's third `PO_ALLOWED_TOOLS` caller) stays on
the ungranted base unconditionally: it renders a distinct prompt (`po-pool.md`), never `po.md`.

**The review family never gets the built-in `WebSearch`/`WebFetch` grant — only gate②'s sealed
review session is actually offline by construction.** `verification-plan-reviewer`,
`verification-plan-drafter`, `verification-plan-reviewer-confirm`, and every gate②
`engine-agent` review session never reference `cfg.webAccess` at all — refusal of THAT grant is
the absence of a wire-up, not a check that could be misconfigured. But under host-delegated
capability management
that is a narrower claim than "offline": only gate②'s review-session mode (`reviewCwd`, see
below) actually closes the MCP/settings surface (`--strict-mcp-config`/`--setting-sources ""`),
so only it is genuinely offline by construction. `verification-plan-reviewer`/`-drafter`/
`-confirm` run the ordinary unsealed `RoleRunner` path — no `WebSearch`/`WebFetch`, but an
ambient host MCP server inherited from settings sources is not excluded by this wire-up's
absence, and network reach through it is not covered by the audit journal below either (that
scanner recognizes named tools, not every possible inherited `mcp__*` schema's semantics).
Gate②'s review-session mode goes further still: it REFUSES a caller-supplied `allowedTools`
outright (thrown, not silently accepted) alongside `reviewCwd`, so even a future direct call
attempting to widen it would fail loudly rather than reopen the surface. A gate whose
conclusions could drift run to run over a live web result is not an inspectable gate — this is
recorded as a deliberate reproducibility property. Gate②'s `--strict-mcp-config`/
`--setting-sources ""` seal (see [Review session mode](#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)
below) is unaffected by anything in this section — it was justified independently, for a
materialized PR tree, and this section leaves it exactly as it was.

**The exception, stated exactly (`reviewer.agent.runner: codex-exec`).** An operator can
select a locally spawned `codex exec` process as the engine-agent review session's runner. It is
**off by default** and this section is what an operator should read before turning it on. For a
remote-provider CLI, "offline by construction" cannot mean a blanket network denial — the CLI needs
its own provider — and the CLI's read-only sandbox turns out to restrict far less than its name
suggests, so the adjudicated claim for that runner is narrower and is stated here rather than
quietly inherited:

- **No model-invoked egress beyond provider transport.** The session is pinned to
  `--sandbox read-only` (whose recorded permission profile is network-*restricted* for
  model-invoked commands), `-c tools.web_search=false`, and `-c mcp_servers={}` — a
  highest-precedence override, so no MCP server loads from any config source, including a
  producer-authored `.codex/config.toml` inside the reviewed tree. Plus `--ignore-user-config`
  (the operator's own `$CODEX_HOME/config.toml`, and therefore its hooks, never load),
  `--ignore-rules`, and the hardened env described below. The prompt reaches the CLI on
  **stdin from a file**; the module spawns an argv vector and never a shell, so
  producer-influenced text has no interpolation surface at all. The wall-clock session timeout
  terminates the whole detached **process group**, so a descendant forked by reviewed code cannot
  outlive it.
- **Recorded blind spot 1 — execution.** `--sandbox read-only` blocks *writes*, not *execution*: a
  shell-capable agent under it can still run producer-controlled code from the materialized tree.
  This is NOT equivalent to the Claude runner's Read/Grep/Glob-only, no-`Bash` profile.
- **Recorded blind spot 2 — host-wide reads, including your credentials.** The same sandbox does
  **not confine the read scope**. Measured on codex-cli 0.145.0: its read-only Seatbelt policy
  contains `(allow file-read*)`, and the session's own recorded permission profile reads
  `{special: root, access: read}`. `-C <treeDir>` sets the working directory; it is not a
  containment root. So a review session that is prompt-injected by the code it is reviewing — the
  threat this whole section exists for — can read **any file the engine's own user can read**,
  including `~/.codex/auth.json`, `~/.config/gh/hosts.yml`, and SSH private keys, and return their
  contents through provider-visible output. Treat enabling this runner as granting the reviewed
  code's author a read of your machine's user-readable files if they can steer the review session.
- **Recorded blind spot 3 — the inherited environment.** The session's environment is the engine's
  own, minus a denylist. `codexSessionEnv` strips the well-known credential families — forge tokens,
  `SSH_AUTH_SOCK`/`SSH_AGENT_PID`, AWS/GCP/Azure, `KUBECONFIG`, npm/pip/twine/cargo registry tokens,
  Docker — plus a generic sweep of any variable whose name ends in `_TOKEN`, `_SECRET`, `_API_KEY`,
  `_PASSWORD`, or `_CREDENTIALS`. **That list cannot be exhaustive.** Everything else is inherited,
  and dumping it costs a steered session one `env`. An operator who runs the engine from a shell
  carrying secrets should assume a steered review session can read them. (An allowlist was
  considered and rejected: one that silently omits something the CLI needs breaks every review, and
  the only way to find the omission is a paid live run — a denylist plus sweep, with an explicit
  keep-set for provider transport, has the bounded failure mode.)
- **The mitigations are partial, and named as such.** Alongside the strip above, `codexSessionEnv`
  redirects `GH_CONFIG_DIR` at an empty per-session directory and pins
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to `/dev/null` with `GIT_TERMINAL_PROMPT=0`. Those remove
  the ambient *handles*; they do not stop a *read* of the underlying files, which remain on disk and
  readable. **Filesystem confinement is what would actually close blind spot 2, and it is
  deliberately not shipped**: the adjudication rules out a new outer OS/container
  fence (trusted-repos posture; the marginal-complexity principle). Blind spots 1 and 2 are emitted
  at every codex-exec spawn as named entries in `engine-review-containment-gap`'s `gaps` payload
  (`model-invoked-shell-execution`, `host-wide-filesystem-reads`), so they are on the durable
  record rather than assumed away — and that pre-spawn record is **load-bearing**: if it cannot be
  written, the session is not spawned and the review degrades to `unavailable`, rather than running
  unrecorded.
- **Unchanged either way.** The default runner is `claude`, and nothing above applies to it — the
  Claude review session has no `Bash` at all and is guard-confined to the materialized tree. Gate②'s
  own safety properties are runner-independent: blocking stays engine-derived over live PR data, the
  session's output goes through the same element-wise validation for both runners, and an
  unidentifiable session model maps to `unavailable` rather than to a verdict.

**Detected, not pinned — the operator's own settings can still silently strip the grant.**
Sealing every peripheral session with `--strict-mcp-config`/`--setting-sources ""` (the same
triple gate②'s materialized-tree review sessions use) is not viable here: `--setting-sources ""`
also stops loading the target repo's own
`CLAUDE.md` — colliding with the locked ruling below ([Ambient repo context: record, don't
seal](#ambient-repo-context-record-dont-seal)): a peripheral session absorbing the repo's
own `CLAUDE.md` is a deliberately OPEN channel, never sealed, and pinning would seal it
as a side effect for every non-review session. Instead the design uses **lightweight startup
detection**, not containment. `cli.ts`'s `checkWebAccessSettingsDenial` — called from the same
best-effort startup pass as `normalizeUnplacedBoardItems`, right after `assertStopMilestoneExists`
— reads ONLY the operator's user-level settings (`$CLAUDE_CONFIG_DIR/settings.json`, or
`~/.claude/settings.json`; never project/local settings — project settings are repo-governed,
and an engine worktree carries no local settings of its own) and, when `webAccess.enabled` is
true and `permissions.deny` names `WebSearch`/`WebFetch` (bare, or a `Tool(...)`-qualified
prefix like `WebFetch(domain:x)`), emits one warning log line plus one durable
`web-access-denied-by-operator-settings` state event. This is exactly the failure mode a live
measurement hit: a granted session's own reported tool list simply omits the denied tool,
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
executables are legitimate, these two tool names ARE the entire ENGINE-GRANTED peripheral-egress
channel), and — by that same unconditional branch — `Agent`/`Task` `tool_use` blocks too (see
the subagent-spawn deny discussion below). Host-delegated capability management adds a second, INHERITED egress channel — any
`mcp__*` tool call — scanned unconditionally by the same function; see the
inheritance doctrine above and the worker-egress blind-spot section below. `RoleRunner.run()` calls it on every session's own completed jsonl and
emits the identical `egress-suspect` ledger event kind the worker's tripwire uses — `round-artifact.ts`'s
existing assembler needs no changes to surface either kind. This flagging is deliberately
**content-driven, not role-gated**: `--allowedTools`/`--disallowedTools` is a noise-reduction
permission layer, not a schema removal (see [Worker denylist vs. peripheral allowlist](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
below), so a session without the grant — a worker leg, or a peripheral role the grant
doesn't cover — can still EMIT a `WebFetch`/`WebSearch` tool_use block; the CLI's own
permission layer denies it at the paired `tool_result`, which this scanner does not read. A hit
therefore records an attempt, never proof of execution — the same "evidence, not a verdict"
stance the Bash tripwire above already takes. The engine deliberately keeps this unconditional
for every session kind: an attempted egress through a tool a session was never granted is
exactly what a post-hoc tripwire should surface, not suppress.

## Dashboard: loopback bind, not an auth boundary

`dashboard/server.ts` (contract: [`docs/reference/frontend-design.md` §8](reference/frontend-design.md#8-data-contract))
serves a local, read-only view of the engine's own ledger. Its posture:

- **Binds `127.0.0.1` only, no CORS.** The listener never binds `0.0.0.0`
  (`server.ts`'s `listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", resolve)`), and no route
  ever sends an `Access-Control-Allow-Origin` header — the dashboard is same-origin with
  this server, and granting none is deliberate, not an oversight.
- **Read-only projection.** The SQLite handle is opened in read-only mode, so no route —
  including the single write route — can write through it even by accident. The four
  `GET` routes (`/api/loop/state`, `/api/events`, `/api/spend`, `/api/rounds`) and the
  static asset handler only ever read; the one `POST /api/control` route, present only
  when `dashboard.controls` is enabled, does not touch the database at all — its sole
  effect is creating/removing the engine's own file sentinels (PAUSE, kill switch).
- **Not an auth boundary.** The bind above is the *only* access control: there is no
  authentication, session, or per-request authorization layer in front of any route.
  **Never reverse-proxy this port to a public host.** Anyone who can reach it sees
  operator-grade data — full lane state, cost figures, and the raw event feed below —
  with no login screen standing in the way.
- **The raw event feed is verbatim by contract, not scrubbed.** `/api/events` serves
  ledger events as written, which by design can include `egress-suspect` command
  snippets and raw error text (see the egress-scanning discussion above) — the forensic
  value of that feed depends on it being unredacted. This is distinct from the *served
  config* surface, which is already allowlisted (`CONFIG_ALLOWLIST`,
  `engine/src/state/read-model.ts`) so a config key added later doesn't silently start
  serving on the wire. There is no public export of a live run's raw feed; the only
  public-facing surface is the curated recorded-run demo fixture served under `?demo`,
  which is a separate, hand-vetted artifact rather than a redaction of live data.

## Worker credential tiers

**Core property: producer≠merger enforced by credential ABSENCE, not by deny rules.** Every
control elsewhere on this page (the guard hook, `WORKER_DISALLOWED_TOOLS`,
`allowManagedPermissionRulesOnly`'s own caveat) is a rule a sufficiently motivated argv can try
to route around. A worker that structurally HOLDS NO forge API credential at all cannot open a
PR, approve a review, or merge — not because a rule says no, but because the capability to do so
does not exist in its environment. This is the tier axis this section describes, with the table
below naming its L0/L1/L2 implementation. **Naming note:** this is a CREDENTIAL-scope
axis, distinct from the DISPATCH-autonomy ladder in
[getting-started.md](guide/getting-started.md#l0l3-autonomy-ladder) (L0 Observe / L1
Supervise / L2 Delegate / L3 Governed unattended merge) — the two share L0/L1 labels by
coincidence of both starting a tier count at zero, not because they're the same axis; a repo can
independently be at autonomy-L3 and credential-L0, or autonomy-L1 and credential-L1.

| Tier | What the worker leg's env holds | Push mechanism | PR-open mechanism | Theft blast radius |
| --- | --- | --- | --- | --- |
| **L0** (today's default, unset `worker.deployKeyPath`/`worker.deployKeyId`) | The operator's REAL, unrestricted environment — `GH_TOKEN`/`gh`'s stored host config/git credential helpers, all inherited verbatim (`process.env`, unchanged) | `git push` over whatever transport the engine's own checkout uses (typically HTTPS via `gh`'s credential helper) | The worker CAN reach `gh pr create` (the `Bash(gh *)` grant is present); in practice the prompt no longer instructs it, and `associateLanePr` opens the PR itself once the branch is confirmed pushed, adopting a worker-opened one via the `sapwood:pr-owner` marker rather than duplicating it | The operator's FULL forge credential — every repo it can reach, every write scope the token carries. Not scoped to this one repo. |
| **L1** (`worker.deployKeyPath`+`worker.deployKeyId` reconciled green) | `workerDeployKeyEnv()` COMPOSES the exact severing `workerCredentialFreeEnv()` does — `GH_CONFIG_DIR` repointed at a fresh, empty, per-lane directory, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, every `gh`/git credential-lookup env var stripped (`GH_*`, `GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, `GIT_CONFIG_*`, `SSH_AUTH_SOCK`) — PLUS `GIT_SSH_COMMAND` pinned to the per-repo write deploy key (`-o IdentitiesOnly=yes`, path shell-quoted) and an env-only `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` rewrite of the origin's HTTPS URL to the matching `git@github.com:` SSH form — no file touched, scoped to this one spawn's env. **A fix leg composes the SAME transport overlay onto its own `credentialFree` base** (the leg ALWAYS dispatches with `proxy.credentialFree: true` — `conductor.ts`'s `startFixLeg`) rather than losing L1, so every leg kind — dispatch, resume, fix — gets the deploy key when one is configured and preflight-green. `Bash(gh *)` drops out of the leg's `--allowedTools` grant (`WORKER_ALLOWED_TOOLS_NO_GH`) either way — a grant the env can no longer authenticate through is not offered either. | `git push` over SSH, authenticated ONLY by the deploy key | STRUCTURALLY UNREACHABLE — no forge API credential exists in the env at all, so there is no channel to attempt `gh pr create` through even if the prompt or a producer's own initiative tried. `associateLanePr` (engine-side, the operator's own credential) is the ONLY PR-open channel on this tier, not merely the preferred one. | The deploy key's own scope ONLY: git-transport write to this ONE repo, nothing else. A stolen key opens no other repo, carries no API write capability (label/milestone/board mutation, review approval, merge) in the FIRST place — theft is non-escalating BY CONSTRUCTION, not by a policy that could be bypassed. |
| **L2** (enterprise guidance — not implemented) | See the [L2 enterprise posture checklist](#l2-enterprise-posture-checklist). | — | — | — |

### L2 enterprise posture checklist

L2 is optional, docs-only enterprise guidance, not a product-required deployment path. It
builds on L1 where its additional isolation and repository policy controls fit the operating
environment:

- **Use non-human identities.** Give the worker and merger separately scoped machine-account or
  GitHub App identities; do not operate either role through a person's everyday GitHub identity.
  Keep their permissions and credentials distinct, with no worker bypass of protected refs.
- **Enforce the full repository ruleset posture.** Apply a branch ruleset that restricts create,
  update, and deletion of every non-lane branch to the appropriate trusted identities; apply a
  separate tag ruleset that restricts tag creation, update, and deletion; and apply a
  `lane-*`-pattern ruleset that blocks force pushes and deletion. Review ruleset bypass lists so
  the worker cannot evade any of these controls.
- **Isolate the worker at the OS-account boundary.** Run worker legs under a dedicated OS account
  that cannot read the conductor's or host user's credential stores, keychains, SSH agents, or
  configuration files. Keep merger credentials available only to the separate conductor/host
  account and enforce filesystem and OS credential-store permissions accordingly. This is the
  control that supplies actual unreadability against worker-led host-credential theft; L1 alone
  does not.

**Activation is opt-in, not default-on.** `worker.deployKeyPath`/`worker.deployKeyId` unset (the
shipped default, including this repo's own `sapwood.config.yaml`) is L0 — today's
behavior, byte-for-byte unchanged (`worker.test.ts`'s own reverse test pins this). `sapwood init`
provisions L1 autonomously WHEN the operator running it has repo-admin (`ssh-keygen -t ed25519 -N
""`; `gh repo deploy-key add --allow-write --title sapwood-worker`; the resolved key path AND the
key's GitHub-assigned id written into `worker.deployKeyPath`/`worker.deployKeyId` in the config
file) — every failure along that path degrades to a guidance-carrying WARN naming the exact fix
(the same pattern this repo already uses for `allowManagedPermissionRulesOnly`, see below) and
leaves the engine fully functional at L0, never a startup failure.

**The LOCAL `(deployKeyPath, deployKeyId)` pair is the anchor — a remote key's TITLE is never
authoritative for "mine".** A `sapwood-worker`-titled key on the repo may validly belong to a DIFFERENT
machine/operator. The engine never invokes or scripts remote deploy-key deletion or
modification, owned or not — a stale or foreign key is only ever surfaced in a WARN for a HUMAN
to review. `worker.deployKeyPath` and `worker.deployKeyId` are config-schema-enforced as a PAIR
— a config with only one set fails to parse at all, naming the missing half
and pointing at re-running `sapwood init` (which always writes or clears both together).

Once both ARE set, every `sapwood init` run RECONCILES rather than skipping: the local key file
must exist; the recorded id must still be listed on the repo; that id-matched remote entry's OWN
public-key content must match the local `.pub` file byte-for-byte (this proves
the pair was recorded TOGETHER by this machine's own provisioning, not merely "an id that
happens to be registered" plus "a local key that happens to authenticate" independently, which a
hand-edited or foreign id sharing a different but also-registered key could otherwise fake); and
the SSH preflight (`ssh -T git@github.com`, matched against GitHub's own documented success shape
— exit 1, stderr containing "successfully authenticated") must pass. All four green → a positive
confirmation and L1 stays active. Any ONE of them failing (a wiped local key file, a second machine, a
remotely rotated/foreign key, a rotated preflight) routes to a **WARN + operator choice**,
offered only when `sapwood init` is running interactively (a real TTY):
**(a)** leave every remote key untouched, clear the stale local anchor, generate a FRESH keypair
— never reusing a key file already sitting at the per-host path, or a per-host title already
registered remotely under someone else's provisioning (treated as foreign, same never-touch
rule): a numeric suffix (`-2`, `-3`, ...) picks a collision-free sibling path AND title together
— and register it as an ADDITIONAL deploy key, reading back its GitHub-assigned id from a
before/after id diff around the `add` call (never a title match, which a
stale/duplicate/racing title could match the wrong entry for; zero or more than one new id is
treated as an ordinary provisioning failure) — the new `(path, id)` becomes this machine's own
anchor; or **(b)** leave every remote key untouched, clear the stale local anchor, and proceed
degraded at L0. A non-interactive `sapwood init` (no TTY — the ordinary autonomous/CI invocation)
defaults to **(b)**, the no-write, never-wedge path, and the WARN still names (a)'s manual steps.
Because the stale anchor is CLEARED either way — for a JSON config, a parse → delete → 2-space
re-serialize → re-parse-and-verify round trip; for YAML, a surgical text edit scoped to the
top-level `worker:` block's own body only (never a whole-file scan,
which could otherwise strip or misread a same-shaped `deployKeyPath:`/`deployKeyId:` line sitting
inside an unrelated block scalar elsewhere in the file); a flow-style `worker: { ... }` mapping is
never edited (a hand-edit WARN instead, and this run's own report still degrades to L0 honestly
regardless of whether the file itself could be cleared) — "re-run `sapwood init`" is an
honest instruction: the next run either reconciles cleanly (choice (a) already happened) or
re-diagnoses the SAME state truthfully. Any other sapwood-titled key still on the repo is named in the WARN for
HUMAN cleanup.

**The private key does not end up staged by an ordinary `git add -A`.** The key lives under the
self-ignoring `.sapwood/` runtime root (its own `.gitignore` already excludes everything under
it), so `sapwood init` no longer needs to append a rule to the repo's own `.gitignore` to keep it
out of a sweep; a deliberate `git add -f` can still stage it.

**Startup visibility, not a gate.** `sapwood init` provisions and preflights the key, but
a RUNNING engine used to discover key problems only lazily, at the first dispatch's own memoized
SSH preflight — an operator could run a whole batch at L0 with no indication until they went
digging in a single leg's logs. At engine startup (`cli.ts`, right after `WorkerSupervisor`
construction, sharing that SAME instance's memoized preflight so this costs no extra SSH probe)
the engine now checks which of four shapes applies — `deployKeyPath` unset, the path set but the
key file missing/unreadable, the path set with the preflight failing, or the preflight passing —
and reports the effective tier (L0/L1) and why in both the log and a `deploy-key-tier-detected`
event. The two degrade shapes reuse the SAME guidance WARNs `sapwood init` itself emits
(`deployKeyProvisioningFailedAction`/`deployKeyPreflightFailedAction`) rather than a third
variant. This is disclosure only — L0 is a legal, fully-functional mode, and no arm blocks
startup or dispatch.

**Honest residuals — what L1 does NOT close:**

- **Cross-lane clobber, accepted.** A GitHub deploy key is a REPO-wide credential, not a
  per-branch one — there is no API-level way to scope it to "only this lane's branch." Two
  concurrently-dispatched lanes sharing the same repo-wide L1 key could, in principle, push to
  EACH OTHER's branch, not just their own. What actually bounds this in practice: each lane
  pushes to its own uniquely-named branch (`lane-<issue>-<random>`, this engine's own naming —
  see `worker.ts`'s `laneName` construction), so an ordinary (non-force) `git push` from one
  lane never even NAMES another lane's branch; and git's own default push semantics reject a
  non-fast-forward update outright — an accidental push that DID target another lane's branch
  would still have to match that branch's current remote head to succeed at all, the same
  built-in git safeguard that already applies to every other push in this engine, deploy key or
  not. **This is a NAMING-DISCIPLINE + git-default mitigation, not a cryptographic or API-level
  scope boundary** — a worker leg that explicitly ran `git push --force` against an arbitrary
  branch name it could construct (not itself impossible under the worker's `Bash(git *)` grant)
  is not stopped by anything L1 adds. L1 does not add branch-scoped git-refs enforcement,
  `--force-with-lease`, or any other push-time API check beyond what a worker leg does today;
  this residual is accepted, stated here rather than silently assumed closed.
- **Raw git-transport push to the default branch — narrowed, not eliminated.** Item 3
  below (and the "CAN still `git push` directly to an unprotected default branch, bypassing the
  review gate entirely via raw git transport" language it uses) named this as an open gap: the
  guard's Category C (`gh pr merge` etc.) enforces producer≠merger at the `gh` layer only —
  `guard.ts` had no `git push` handling at all, so a worker leg holding `Bash(git *)` (L0 host
  credentials, or an L1 deploy key on an unprotected default branch) could run `git push origin
  HEAD:<default-branch>` and skip gate①/gate② entirely. The engine now denies this at the guard
  layer too: a deny rule (authored as a human-merge-only edit, since guard.ts /
  the guard hook wiring is human-merge-only — see "Human-merge-only paths" below) blocks refspec
  destinations naming the default branch, `--delete`, and `--mirror`/`--all`, active only when the
  engine's trusted spawn env `SAPWOOD_DEFAULT_BRANCH` is set (worker.ts resolves it from the same
  fact `getDefaultBranchChecks` already keys on and threads it into every dispatch/resume/fix-leg
  spawn). Precise-destination matching alone cannot prove a push is safe: an unresolved shell
  variable/command-substitution (`HEAD:$SAPWOOD_DEFAULT_BRANCH`, expanded by the worker's OWN
  shell before git ever runs), a `-c alias.*=` config injection (redefining what a later
  subcommand token means), and a wildcard refspec destination (`refs/heads/*:refs/heads/*`) can
  all reach the default branch without ever spelling it out as a literal token the guard could
  string-compare — the rule's actual frame is "if this push's safety cannot be PROVEN, block it,"
  not an enumeration of literal forms. This is engine-side defense-in-depth
  AT the guard's own sanctioned enforcement point — it narrows the gap for a worker leg that goes
  through this guard's PreToolUse hook, but it is **not a replacement for branch protection**
  (item 3's own WARN): branch protection is the mandatory backstop of record regardless of
  whether this engine-side rule is active, and nothing here closes a leg that bypasses the
  guard hook itself (a non-`claude`-CLI process, or a session the engine didn't dispatch —
  SAPWOOD_DEFAULT_BRANCH unset leaves the rule inactive by
  design, same fail-safe stance the guard's other engine-set-env rules already take). **What the
  rule covers, stated plainly, not claimed as exhaustive:** every argv-VISIBLE raw-git push
  form — direct refspec destinations, `--delete`/`--mirror`/`--all`, `--repo`/`--repo=`, an argv
  `-c`/`--config` alias injection local to that one invocation, and any refspec token the guard
  cannot statically prove safe (an unresolved `$`/backtick/`*`). It does **not** cover a push
  whose effective subcommand is resolved through git STATE the argv itself never reveals — a
  PRE-PERSISTED, repo-local `git config alias.*` (set by an earlier, separately-judged command)
  or `GIT_CONFIG_*` environment aliases carried in from outside that one Bash call. Closing that
  class would mean modeling git's own config resolution across commands and environment, not
  scanning one more token spelling; it is an accepted residual, the same class
  `checkControlSentinelArg`'s "a script that hardcodes the path internally, with no CLI argument"
  residual already is — see [Sentinel isolation boundary](#sentinel-isolation-boundary-honest-statement)
  — and GitHub branch protection is the backstop of record for it: this rule was always
  framed as defense-in-depth AT the guard's enforcement point, never a complete jail around it.
- **Host-credential theft: engine-unpluggable.** L1 removes the forge API credential from the
  worker leg's OWN environment — it does nothing to, and cannot touch, the operator's real
  credential store on the HOST the engine itself runs on (`gh`'s `hosts.yml`, the OS keychain, an
  `ssh-agent` socket the OPERATOR's own shell has live, outside any worker leg's spawn env
  entirely). An attacker with host-level access (the operator's own machine compromised
  independently of anything sapwood spawns) reaches the operator's real credentials the same way
  they would with or without L1 — this is not a sapwood-closable surface, and L1 makes no claim
  otherwise. The [HONEST SCOPE](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
  residual below (`Bash(node *)`/`Bash(npm *)` reading `~/.config/gh/hosts.yml` directly, the
  `steal.mjs` PoC) is the WORKER-LEG-REACHABLE instance of this same class — L1 shrinks it
  (there is no `GH_TOKEN`/no `gh`-authenticated-forge-writes reachable through the deploy-key env
  itself once found), but does not eliminate the underlying filesystem-read residual: a leg that
  reads a stolen HOST credential off disk can still ATTEMPT to authenticate with it over its own
  `Bash(gh *)`-less env — the grant is gone, but nothing stops the leg from invoking `gh` via a
  path it constructs itself, or curling the API directly, if it found a usable token on disk.
  Branch protection on the default branch (the WARN this section's own preflight raises when
  it's missing) remains the mandatory backstop regardless.

**Guidance-carrying WARNs (every disclosure names its own fix in the same log
line, never a bare "something's wrong"):**

1. **`sapwood init` without repo-admin.** `gh repo deploy-key add` fails (typically a 403) →
   one WARN action line naming the exact manual steps (the `ssh-keygen -t ed25519` command, the
   repo's Settings → Deploy keys → paste the `.pub` + enable write access, the `title:
   sapwood-worker` to keep idempotency working, and the `worker.deployKeyPath`/
   `worker.deployKeyId` config keys to set once it's added — the id is shown on that same
   Settings page) plus this section as the docs anchor. The engine is fully functional at L0
   either way — init itself never fails over this.
2. **Reconcile fails — auth-fails/stale/mismatch.** Any of "local key file exists" / "recorded
   id still listed" / "local `.pub` content matches that entry's own registered key" / "SSH
   preflight green" failing (rotated key, wiped local key file, second machine, a foreign key sharing
   the `sapwood-worker` title, a hand-edited id pointing at an unrelated but also-registered key)
   → a WARN naming the specific reason(s), any other sapwood-titled key already on the repo (for
   HUMAN cleanup), and — on an interactive `sapwood init` — the (a)/(b) choice above; a
   non-interactive run defaults to (b) and still names (a)'s manual steps. Dispatch continues at
   L0, never wedges, and the underlying SSH-auth probe is memoized so this WARN fires once per
   engine process life, not once per lane. Because the stale local anchor is CLEARED as part of
   this WARN (JSON or YAML, by the config file's own format), re-running `sapwood init` genuinely
   re-diagnoses the state rather than replaying the same skip forever.
3. **L1 active but the default branch is unprotected — CONFIRMED.** `sapwood init` checks branch
   protection on the repo's default branch once provisioning/reconcile succeeds: the legacy
   branch-protection endpoint, AND — only when that endpoint 404s — whether any ruleset covers
   the branch (`repos/<owner>/<repo>/rules/branches/<branch>`; a non-empty ruleset array counts
   as protected). Only when BOTH report unprotected does the confirmed-unprotected WARN fire,
   naming branch protection (repo Settings → Branches → add a rule requiring the merge gate this
   engine already drives PRs through) as the fix — because even though the deploy key
   structurally cannot open a PR or merge, it CAN still `git push` directly to an unprotected
   default branch, bypassing the review gate entirely via raw git transport. Branch protection is
   the mandatory backstop this whole tier depends on, not an optional hardening step.
4. **Branch-protection status CANNOT be verified — a DISTINCT WARN from #3.** Any failure to even
   read the repo's default branch, a 403/plan-limit/network/any other error from the legacy
   endpoint that isn't a parseable 404 (e.g. a private-repo plan that can't expose protection
   status via the API at all, as observed in practice), or a failure reading
   rulesets after a legacy 404, is NOT read as "confirmed unprotected": it gets its own WARN
   naming the underlying error and the same advice ("if this repo's plan cannot expose
   protection, treat the default branch as unprotected and add a rule by hand") without CLAIMING
   the API confirmed anything.

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
  L0 (see [Worker credential tiers](#worker-credential-tiers) above for the full L0/L1
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
  deployKeyPath`/`worker.deployKeyId` reconciled green) gets the SAME `Bash(gh *)`
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
  [Accepted blind spots](#accepted-blind-spots) section above for what that detector does and
  does not do. Warn-only observation, same as everything else in this paragraph — it never
  enforces the backstop.
- `engine/src/roles/worker.ts` does not add the engine `.sapwood/` runtime root as a Claude
  tool root (there is no `--add-dir .sapwood`), so the tool layer does not offer a path into
  it. This is not Bash containment: worker Bash can reach `../../.sapwood`, exactly the
  residual documented under [Sentinel isolation boundary](#sentinel-isolation-boundary-honest-statement).
- Merge authority remains a separate choke point. Only
  `engine/src/roles/merge-driver.ts` calls `IForge.mergePR`, after the CI/review gates and a
  final fresh decision; `engine/src/forge/forge.ts` pins the operation with
  `--match-head-commit`. The worker has no reference to that driver, while both its CLI deny
  rules and the guard block direct merge commands.

This is targeted governance containment, **not general Bash containment**. The denylist does
not prove an unrecognized command harmless, inspect arbitrary script bodies, confine filesystem
access performed by a subprocess, or stop a permitted interpreter/package runner from opening
a socket. In particular it does not contain data exfiltration; see
[Worker network egress: Bash-channel containment available as a hardening profile](#worker-network-egress-bash-channel-containment-available-as-a-hardening-profile).
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
instead (`reviewer.agent.runner: codex-exec`, see [Peripheral network egress](#peripheral-network-egress-websearchwebfetch-detected-not-pinned)
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
  prompt. See [`configuration.md`](guide/configuration.md#roles) for the config key and
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
— see [`configuration.md`](guide/configuration.md#roles)) to a per-session, revocable,
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
profiles](#execution-profiles-host-permission-mode--bash-sandbox) below) or running fix legs
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
`ac-evidence-tiers`) verbatim from this file's own marker-delimited sections (see the
`<!-- sapwood:skill:*:start/end -->` comments above and around the "Doctrine lines" AC-evidence
tiers) into an immutable, content-hash-named plugin directory under
`.sapwood/cache/generated/role-skills/<hash>/`, attached to a session via `claude --plugin-dir`. This
CONTENT-side-only: the render path's only input is this engine-shipped file — never anything
issue-body- or PR-derived — and a published hash directory is never overwritten (the "accident
fence, not a jail" doctrine: the goal is to stop a mistake, not to withstand an adversary who
already has code-execution authority in the same repo).

**A third skill, `sapwood-labels`, lives on the same plugin dir.** Unlike the two above, its
content is NOT extracted from this file's markers — it is rendered from `engine/src/forge/
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
runtime-root write-deny rule ([Sentinel isolation boundary](#sentinel-isolation-boundary-honest-statement))
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
  dispatch — see [Human controls](#human-controls-three-tiers) below.
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

## Ambient repo context: record, don't seal

Every session above — worker or peripheral — spawns `claude -p` **inside a real repo
worktree**. That means it legitimately absorbs the target repo's `CLAUDE.md`, the
user's global `CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt
sections, exactly like any interactive session would. An earlier internal note claimed
peripheral role sessions got "no repo context beyond what's substituted into the
prompt" — that was never accurate once sessions ran in a real worktree, and the claim
is now corrected at its source (`config.ts`'s `RoleSession` schema comment).

**This channel stays
open in production.** Sealing it — running with no ambient `CLAUDE.md` at all — would
move the trust boundary to the *content* side, contradicting the locked boundary
this page already states above and in [PLAN.md](PLAN.md#security--trust-posture):
the boundary is what a session can **do** (the zero-write, zero-`Bash` tool allowlist,
now `Read`/`Grep`/`Glob` guard-confined to the worktree; the credential-stripped spawn env),
never what it can **read**. Repo
conventions
living in `CLAUDE.md` are exactly what a role session *should* absorb — the same
reason a human contributor reads it too. The obligation this channel creates is
**honesty and diagnosability, not isolation**: record what each session attempt
actually saw, so ambient drift between retries (a `CLAUDE.md` edited between attempt 1
and attempt 2, a dirty worktree, a config change) never makes two attempts of the same
phase look comparable when they weren't.

**Wired for every `runSessionWithRetry` peripheral call site** — harvest,
architect, plan-review (the reviewer, drafter, and confirm sessions), retro,
`decompose.ts`'s PO
decompose sub-mode (`po-decompose`), and `align.ts`'s
three PO sessions (`po-align`, `po-triage`, `po-pool`) — **plus
`WorkerSupervisor`'s `dispatch()`/`resume()`**: every worker/producer leg
records the same host-environment fingerprint. The mechanism is the SAME
`assembleContextManifest`/`capturePreSpawnManifestData` pair, factored out of
`peripheral.ts` into `context-manifest.ts` so both callers share it rather than
growing a second implementation — see `WorkerSupervisor.recordLaneContextManifest`'s
own doc for the worker-specific key/scope choices (a sentinel `roundId: 0, phase:
"worker"` row per lane name, most-recent-leg-wins on resume). One nuance a live
probe surfaced: a session's stream-json init line reports ZERO `mcp__`-prefixed tool
names even when ambient MCP servers are actually loaded (tool schemas arrive
deferred, after init) — the manifest's `mcpTools` field reads the init report's
SEPARATE `mcp_servers` field (name + connection status per server), which is NOT
subject to that deferral, rather than naively deriving MCP presence from the tool
name list.

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
  git's own plumbing files — see below — never a `git status` call);
- hashes of the `--settings` JSON and the guard hook file, so a hook/config change
  between attempts is also detectable; and
- **(#1010) the session's own init-reported EFFECTIVE host `permissionMode`** — the
  engine always REQUESTS one fixed mode (`worker.ts`'s `REQUESTED_PERMISSION_MODE`,
  `auto`), but Claude Code can silently fall back to a different one when that mode is
  unavailable (org settings turn it off / model unsupported), and in a headless `-p`
  run a fallback to Manual means "anything not allow-listed is denied, and Claude keeps
  working" — a leg then under-delivers with no engine-visible signal unless this field
  is read. `null` when the init line carried no such field, never a guess. At lane end
  (the same jsonl read `parseCostUsd`/`scanEgressSuspects` already use), a divergence
  from the requested mode also emits one `permission-mode-mismatch` event — informational
  only, fail-safe in the allow direction, never gating the lane/session's own outcome.
  The `system/init` line carries no separate sandbox field, so "was the Bash sandbox
  actually engaged" cannot be read the same way; that positive-attestation question is
  left to DR #1009.
- **(#1010) `sandboxViolationCount`** — how many `<sandbox_violations>` blocks the CLI
  appended to a denied command's own `tool_result` across the session (`worker.ts`'s
  `countSandboxViolations`: one string match over the already-parsed jsonl, no new
  scanner). Zero when none were found. Together with `permissionMode` above, this is
  today's full observability floor for the permission-mode/Bash-sandbox profile work
  (DR #1009) — a count of observed evidence, never a claim the sandbox was or wasn't
  engaged, and never affects the session's own outcome.

Manifests persist in the state DB's `context_manifests` table, keyed by
`(round, phase, role, session, attempt)` — the same tuple a separately
developed input manifest will eventually join on. That linkage is deliberately **not**
built here: this table is self-contained (its own migration, its own `State` methods),
so the two features merge independently regardless of order.

**Why no live `git status`.** This engine structurally never execs `git` outside
worker.ts's `claude` CLI launch and `gh.ts`'s `gh` calls — pinned by a grep-invariant
test (`worker.test.ts`) that also bans passing a `cwd` to any subprocess, so the
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
session's ENGINE-GRANTED `--allowedTools` string carries no WRITE-capable tool name —
`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/any `Bash(...)` entry — the common case, so
`dirty: false` is a guarantee about that grant, not about the session's total capability;
host-delegated capability management means an unsealed session can still inherit an ambient host MCP server with
its own write-capable tools, invisible to this name-based check — see the worker-egress
blind-spot section. `Read`/`Grep`/`Glob` is the universal issues-only baseline, so this
is no longer the same thing as "the allow-list is empty" — a read-only grant is still
`dirty: false`); `"unknown-write-capable-session"` (the grant
DOES include a write-capable tool, e.g. `retro`'s `Write`/`Edit`/`Bash(git ...)` — the
engine cannot rule out a write, so `dirty: true` conservatively, never a false
"definitely clean"); and `"worktree-missing"` (the worktree never appeared on disk at
all within the bounded wait — a distinct fact from either of the above, not folded
into a guess).

**What a session actually used.** Alongside HEAD/cleanliness, the manifest also
records which tools a session's stream actually INVOKED (`toolUsage`: name → call
count, parsed from its jsonl `tool_use` blocks — including a DENIED attempt, e.g. a
blocked `Bash` call, since the attempt itself is diagnostic evidence whether or not it
executed) and which paths its `Read`/`Grep`/`Glob`/`NotebookRead` calls named
(`readPaths`, sorted and deduplicated). This is a RECORD of what was asked for, not a
re-verification of where it landed — the guard hook above is the actual containment
enforcement; the manifest exists so a session's read footprint is diagnosable after
the fact, the same "record, don't seal" stance this whole section takes for ambient
`CLAUDE.md` absorption.

**Honest framing.** This same broad, recorded read access is what makes architecture-debt
detection possible at all — the architect role forms its drift/contradiction judgment from the
SAME ambient repo/doc access every session already has, not from a separate, more-privileged
audit grant. sapwood has no standing "audit role" with elevated read scope; if one is ever
justified, it is an addition to this recorded posture, not evidence that today's posture was
incomplete.

## Review session mode: closed MCP/settings surface, forced-hard guard

The engine-agent reviewer runs a static review session directly against an
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
  `Bash(node *)`/`Bash(npm *)` grant runs with the operator's REAL `$HOME` and, absent an
  operator-configured Bash sandbox, is not filesystem-confined from it (the "forge MCP proxy"
  section's `workerCredentialFreeEnv` HONEST SCOPE note, and its `steal.mjs` proof-of-concept —
  see also [Execution profiles](#execution-profiles-host-permission-mode--bash-sandbox) for the
  operator recipe that closes the named-path subset of this residual), so a producer could in
  principle have
  influenced the operator's own `~/.claude/settings.json` in an *earlier* round; a review session
  loading `user` settings would inherit whatever that earlier influence left behind. Loading no
  file sources at all removes that inheritance path for review specifically, without requiring the
  broader (still-open) worker HOME residual to be solved — ordinary WORKER legs (dispatch/resume/
  fix, as opposed to this review-session mode) are covered separately: see
  "Worker-leg user-settings persistence vector — detect & disclose" below
  for that mechanism.
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

**Not to be confused with the guard-hook read containment above.** This section's
`--bare` recipe seals a session's AMBIENT CONTEXT (no repo/user `CLAUDE.md`, no
auto-memory, no MCP) for reproducible eval comparisons — a different goal from that
containment,
which confines an ordinary (non-`--bare`) production session's explicit
`Read`/`Grep`/`Glob` tool CALLS to its own worktree via the guard hook, while leaving
ambient `CLAUDE.md` absorption open (see "Ambient repo context" above). Production
dispatch uses that containment; it never uses `--bare` — see why below.

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

## Instruction-path changes escalate to human review

Standing reviewer instructions are authority, so sapwood treats their merge history as a trust
chain. Before either a hosted-bot review trigger or a paid engine-agent session, the merge gate
checks the PR's rename-aware changed-file list against `escalation.instructionPaths`. A match on
an old or new path applies `labels.humanMergeOnly` before review proceeds and posts one
explanatory comment. If GitHub cannot provide a complete changed-file list within its API ceiling,
the PR also escalates fail-closed. The exact human-merge-only PR label is the latch: later ticks
neither fetch the file list nor repeat either write.

This is deliberately **escalation, not a guard write-denial**: editing standing instructions is
legitimate work, and denying the edit would mask that intent. The worker may produce the change; a
human must adjudicate it. Setting `escalation.instructionPaths: []` explicitly turns the mechanism
off.

**Merge authority stays human; review labor should not.** Rather than parking
the PR needs-human with zero engine review and leaving the human to arrange an out-of-band review
themselves, on a FRESH escalation (never on a later, already-`sapwood:human-merge-only`-
latched tick — the label write is the idempotence latch, so a repeat tick does not re-run this),
the engine also makes ONE advisory `evaluate()` call (one logical advisory evaluation — the
adapter's own `evaluate()` may retry an unparseable/failed attempt internally, engine-agent.ts's
own attempt-retry logic, so this is a claim about one evaluation being REQUESTED, not about how
many sessions run underneath it) and posts its verdict as a PR comment before parking, prefixed
with a prominent banner marking it "instruction-path change: human-merge-only — ADVISORY, not
consumed by the merge driver". That evaluation's instructions come from the reviewer's own
engine-construction-time sources — the doctrine text and prompt template `EngineAgentReviewer`
loads once at construction (engine-agent.ts), plus the dispatch-time AC snapshot
— never a live re-fetch of the PR's own (now human-merge-only) body, so an in-PR instruction-path
edit cannot influence how this review of itself is conducted. The verdict is advisory labor for
the human reviewer only: the route returns `needs-human` unconditionally, whether the evaluation
approves, rejects, or produces nothing at all — no verdict from it ever reaches the merge driver's
consume path. Fail-closed: if the diff fetch, the evaluation, or the comment post fails — OR the
whole operation exceeds a wall-clock deadline (`ADVISORY_REVIEW_DEADLINE_MS`, default 60s,
injectable via `EngineAgentDriveDeps.advisoryReviewDeadlineMs`; a never-settling dependency must
never make the park itself wait) — the PR still parks needs-human exactly as before, with no
different reason string a caller could key on. See `review/drive.ts`'s
`runAdvisoryInstructionPathReview`/`raceWithDeadline` for the implementation and `drive.test.ts`
for the regression coverage (never-consumed, fail-closed, deadline-bounded, latch-skips-rerun,
construction-time-instructions).

### Which carriers are covered, and how immediate the protection is

Two families, protecting two different sessions, with two different timings. Being precise about
this matters: the general claim "instructions absorbed by a review session were previously
human-vetted" is stronger than what the second family's mechanism actually delivers.

- **The ambient-context family** — `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
  `.claude/rules/**`, `AGENTS.md`. These are absorbed from the checkout by **worker** and other
  non-review sessions ([Ambient repo context: record, don't
  seal](#ambient-repo-context-record-dont-seal)), and by a hosted bot reading the PR head.
  They are **not** absorbed by sapwood's own gate② review session: it spawns with
  `--setting-sources ""` (see [Review session mode](#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)),
  which also stops the session's own cwd `CLAUDE.md` from loading at all. This was measured live
  the same way the earlier measurement recorded in the peripheral-egress
  section above was taken — a scratch directory whose `CLAUDE.md` declared a unique marker fact, a
  one-shot `claude -p` asking for that fact: the default run answered with the marker, the
  identical run with `--setting-sources ""` answered `UNKNOWN`. Same machine, same operator
  settings, one flag changed — so the difference is the flag, not a local settings deny wearing
  platform clothes.
- **The reviewer's own carriers** — the doctrine file (`doctrine.file`, default
  `docs/REVIEW-DOCTRINE.md`, substituted verbatim into the reviewer prompt) and the reviewer prompt
  itself (shipped as `engine/prompts/**`, repointable via `reviewer.agent.promptFile`). These are
  what a gate② review session actually reads as standing instruction. **Both paths are derived from
  config**, not literals, so an operator who repoints either one stays covered: `loadConfig`
  captures the pre-resolution `doctrine.fileRaw` and `reviewer.agent.promptFileRaw`
  before resolving each to an absolute local path, and the escalation matches those repo-relative
  raw forms against the PR's changed files. The `engine/prompts/**` glob remains a literal default
  covering the shipped prompt, inert in any target repo that is not the engine's own source tree.
  A derived path that points outside the repo (absolute, or `..`-escaping) is skipped rather than
  smuggled into the pattern list — it could never match a repo-relative changed-file path anyway.

The forge-read provenance mechanism's own carriers, `engine/src/forge/forge.ts` and
`engine/src/proxy/**`, are also in `escalation.instructionPaths`: an edit to either does not
reach autonomous merge through this instruction-path channel.

**The second family's protection is delayed by one round, not immediate — say so rather than
overclaim.** Both the doctrine and the prompt are loaded by the ENGINE from its own
config-resolved path at construction, never from the materialized tree under review. A PR editing
them therefore cannot weaken *its own* review; what it would weaken is **every subsequent review
after it merges**. The escalation closes that: the edit cannot reach autonomous merge, so no
un-vetted reviewer instruction ever becomes the authority for a later round. What it does not and
cannot do is make an in-flight review notice the change.

### The mechanism's own carriers join the escalation surface too

Live evidence for why this matters: a PR once merged with zero human eyes,
touching the instruction-path matcher itself (`engine/src/review/instruction-path-escalation.ts`), the
`escalation.instructionPaths` defaults (`engine/src/config/config.ts`), and this file. None of the
three were on any escalation or human-merge-only list, so the merge was compliant with the letter —
a PR gutting the matcher or shrinking the defaults would have reached autonomous merge the same
way. (That instance was benign; the finding is the reachable class.) The ruling put these three paths in the **escalation surface**, alongside the two carrier families
above — not the guard deny-list: the worker may still produce a change here, a human adjudicates
the merge.

**Say the self-reference honestly (SAID — Self-Applies-Its-own-Defenses).** The escalation list now
protects the file that implements it and the file that carries its own defaults. That is
deliberate, not circular: `escalateInstructionPathChanges` evaluates every PR against the
**deployed** config (the version the engine loaded at construction), never against the PR's own
diff. A PR that edits these three paths is checked against the instruction-path list as it exists
on `main` *before* that PR merges — so once this protection itself is deployed, an in-flight edit to
the matcher or its defaults is caught by the very entries this PR adds.

**The exposure window is exactly one bootstrap PR, not an ongoing gap.** Before these three paths
were deployed in `escalation.instructionPaths`, nothing stopped an autonomous merge to any of them
(the evidence above). The PR that first adds them is necessarily evaluated
against the OLD deployed defaults — which do not yet cover its own diff — so it is the one PR that
cannot be protected by its own change. Every PR after it merges is covered. This is why that
bootstrap PR is itself human-merge-expected: the engine has no config-side signal to escalate its own bootstrap PR,
so the merge decision for this one PR is a human responsibility, not an engine one.

## Human-merge-only paths

<!-- sapwood:skill:human-merge-only-paths:start -->
Some files are structurally off-limits to an autonomous worker because changing them
would let a worker weaken the very mechanism that constrains it. Any change to these is
**human-merge-only**, regardless of what merge mode is configured:

- `guard.ts` / `guard-hook.ts` (the guard hook wiring)
- `reviewer.ts` / `merge-driver.ts`
- `engine/dist/guard/guard.js`, `engine/dist/guard/guard-hook.js`, `engine/dist/roles/reviewer.js`,
  `engine/dist/roles/merge-driver.js` — the compiled artifacts each PreToolUse invocation and the
  conductor actually execute; protecting only the `.ts` sources above would leave the running
  gate overwritable through its own build output.
- `sapwood.config.yaml` / `sapwood.config.yml` / `sapwood.config.json` — **the whole file**, not just its
  security-relevant fields (guard mode, reviewer mode, merge mode). The guard's actual
  match (`engine/src/guard/guard.ts`) is a path pattern on `sapwood.config.(ya?ml|json)`,
  with no per-field carve-out: a comment-only edit, a non-security default, or reformatting
  is blocked exactly like a guard-mode change. Do not read "security-relevant config" below
  as scoping the block to a subset of the file's contents — it names *why* the file is
  protected, not *how much* of it is.
- `sapwood.config.example.yaml` / `sapwood.config.example.yml` / `sapwood.config.example.json` — the `sapwood init` starter
  template, guard-protected as a sibling rule to the root config above (same whole-file,
  no-per-field-carve-out treatment; `engine/src/guard/guard.ts`'s match is a path pattern on
  `sapwood.config.example.(ya?ml|json)`, case-insensitive). It carries the same
  `merge.mode: produce-pr-and-stop` safe-by-default pin every future `sapwood init` inherits,
  so weakening it here degrades that default repo-wide, not just this repo's live config.
- `.claude/settings*.json` and `.github/workflows/**`

The guard enforces this as a write-path denial (both for the `Write`/`Edit` tools and
for `Bash` redirection/`tee`/`sed -i`/`git mv`/etc. against these paths, checked
position-independently so a wrapper can't hide the write) — but the human-merge-only
rule is also a process rule: even a PR that touches these files and somehow passes CI
and review is not something the conductor should be configured to auto-merge.
<!-- sapwood:skill:human-merge-only-paths:end -->

### The protected live config and shipped starter are separate

The path-based denial protects this repository's root `sapwood.config.yaml`: it is the
configuration the autonomous loop on this repository actually runs from (`sapwood run` from
the repo root, no `--config` — see [configuration.md "Two config files"](guide/configuration.md#two-config-files)),
so its PR history is the audit trail of the governing values, and changing it remains
human-merge-only through the guard.
`sapwood init` instead ships `sapwood.config.example.yaml` as the starter template
(`engine/src/loop/init.ts`'s `sampleConfig()`/`ensureConfig()`). That template belongs
to the default `escalation.instructionPaths` surface, so edits to it route to human merge
review, **and** it is also guard-protected in its own right: `guard.ts`'s
`protectedPathLabel` matches `sapwood.config.example.(ya?ml|json)`, case-insensitively, as a
sibling rule to the root config's, denying the same recognized write vectors as the root
config — the `Write`/`Edit` tools, Bash redirection, and the write-command set (`touch`,
`rm`, `mv`, `cp`, `install`, `git rm`/`mv`/`restore`/`checkout`, `sed -i`, `perl -i`, `tee`,
`dd`) when the template path appears as their argument — so a worker can no longer weaken the
`merge.mode: produce-pr-and-stop` pin every future `sapwood init` inherits from this file
through any of those routes. This does **not** extend to the literal-argument scan
(`checkControlSentinelArg`) that catches an arbitrary command merely naming a path under the
`.sapwood/` runtime root — that scanner is deliberately scoped to `.sapwood/` only (a
marginal-complexity ruling), so a script that takes the template's path as its own CLI
argument (e.g. `node writer.js sapwood.config.example.yaml`) or hardcodes the path internally
is outside the guard's coverage — the same residual class the "Sentinel isolation boundary"
section below documents for the runtime root.

The consequence for the protected root config: **a worker cannot land a change to its
comments — even a purely editorial one carrying no security meaning at all.** The guard
denies the write (`BLOCK [write-path] sapwood.config.* (engine/guard config) is
human-merge-only`) without inspecting whether the edit touches `guard.mode` or a `#`
comment, which is the correct fail-closed behaviour: an intent-aware exception is exactly
the seam a worker could talk its way through.

This is a deliberate trade, not a defect — but it means any issue whose acceptance
criteria require the protected root YAML to change has a **human-applied step that no worker can
discharge**. A human-merge-only path is changed only by a **direct edit in the PR whose diff a
human reviews and merges** — never by an artifact a worker produces for a human to apply. The
guard binds engine-spawned sessions' tool calls, never a human's editor or a human-directed
session, which is why the direct edit is available at all where a worker's write is denied. So an
issue drafted against such a path carves the protected-path work into a `## Human-owned remainder
(protected paths — not dispatched)` section, its dispatchable rest landing normally; when the
protected edit is a prerequisite the whole issue depends on, nothing is left to dispatch and the
issue belongs to a human directly. Until the human PR lands, the pending protected change lives
on the open issue's remainder section — the process-truth home for it — not as any committed
artifact in the tree.

**Resolved at issue-authoring time, not just caught at gate⓪.**
`verification-plan-reviewer.md`/`verification-plan-drafter.md` catch an acceptance criterion that
still asks for a direct edit to one of these paths — but that used to be the *only* check,
so an issue drafted with such a criterion could reliably cost a gate⓪ bounce and a repair round-trip
before it could dispatch. `po.md` (both `align` and `triage` modes) and
`po-decompose.md` now carry the identical check at the point an issue or `ready` child is first
drafted, resolving it into a carved-out human-owned remainder/section immediately rather than
leaving it for the reviewer to find. The gate⓪ check stays in place as the backstop for whatever
this upstream pass misses — this narrows how often it fires, it does not replace it.

### The `sapwood:human-merge-only` label

The same phrase now also names a **label**, deliberately — one fact, one term. Where the
list above is the *static* set of paths a human must merge, `sapwood:human-merge-only` is
the *runtime verdict* that a particular PR must be merged by a human. Today the
instruction-path escalation above is its only writer: a PR that edits the reviewer
instruction graph is not broken and nothing is stuck, but its merge decision is not the
loop's to take.

Its contract:

- **Engine-written, on the PR, exactly once.** No automated act ever removes it or
  re-decides it — unlike `sapwood:needs-human`, whose removal *is* the gated-reentry
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
keep an engine PR off those paths (gate⓪ AC screening, the `guard.ts` write-path block
above, and the instruction-path escalation above); a fourth scanner would be redundant machinery. The label carries the
**verdict**, not a new detection.

### The review-doctrine file is trusted prompt input

The review-doctrine file (`doctrine.file`, default `docs/REVIEW-DOCTRINE.md`) is
user-editable repo prose and is **not** guard-protected — yet its content is injected
verbatim into the gate② review-trigger comment that the review bot reads, so it can
influence the gate verdict (it could, in principle, instruct the reviewer to wave
things through). It sits inside this page's trusted-repo assumption: doctrine content
is trusted exactly like the rest of the repo's prose, and changes to it deserve the
same review scrutiny as review-gate configuration (`reviewer.*`, `merge.*`). It is
deliberately not sanitized — it's prose written *for* LLM readers, and gate② stays
semantic, not a rules engine.

## Human controls (three tiers)

sapwood has three independent file-sentinel controls, all living next to the engine's
state DB (`.sapwood/`), without requiring a config edit:

- **Emergency stop** (`.sapwood/EMERGENCY_STOP`) — the strictest tier. It takes precedence over
  the kill switch every tick and hard-kills running/fixing lane process groups without a drain
  window. In-flight WIP is lost; killed lanes escalate to `needs-human` with their evidence
  preserved. Use `/sapwood-stop --emergency` to set it and `--clear-emergency` only after human
  review.
- **Kill switch** (`.sapwood/KILL_SWITCH`) — the drain-first tier. Freezes *all* new dispatch and
  merges. Running workers are asked to hand off gracefully within
  `cost.drainWindowSec`; past that window the conductor escalates to a hard
  process-tree kill. Everything else freezes too: no dispatch, no drive/merge, no
  rollback retry, no reclaim-and-requeue of crashed lanes. Set/lift it with
  `/sapwood-stop` (no argument to set, `--lift` to remove) or by touching/removing the
  file directly.
- **Pause** (`.sapwood/PAUSE`) — the gentle tier. Freezes new dispatch: no new lane is claimed,
  **and** a driving lane's fix-leg admission gate reads this same sentinel, so a fresh fix leg
  is held back too — see the [fix-loop admission gate](#fix-loop-fixing-lane-state) above. A
  worker or fix leg **already running** keeps running to its own completion, and the ordinary
  gate scans for every `driving` lane — the review trigger, CI/merge polling, the merge itself —
  keep executing exactly as normal, so a lane whose verdict is already `MERGE`/`WAIT_REVIEW`
  still merges or keeps polling and eventually leaves `driving`. What does NOT proceed: a
  `driving` lane whose next action is a *fresh* fix leg stays `driving`, blocked rather than
  finished, for as long as PAUSE stands — it resumes the instant the sentinel is lifted, never
  stuck permanently. No drain, nothing killed either way. Use this to stop taking on new issues
  and new rework while letting already-running work and already-mergeable PRs land (e.g. before
  a maintenance window). Set/lift with `/sapwood-stop --pause` / `--resume`.

The precedence order is emergency stop, then kill switch, then pause: emergency stop wins over
the kill switch, and either strict tier subsumes pause's dispatch restriction.

**Interaction with `--until-idle`:** idleness (`driver.ts`'s `isIdle`) requires — among its
conditions — zero active workers (`running`, `driving`, or `fixing`, not just live processes);
the full condition set lives in `isIdle` itself. A paused engine dispatches nothing new, and a `driving` lane
whose verdict is already `MERGE`/`WAIT_REVIEW` keeps resolving normally and eventually leaves
`driving`; but a `driving` lane whose next action is a fresh fix leg stays `driving` — blocked,
not finished — for as long as PAUSE stands, so **`--until-idle` does not exit on its own while
such a lane exists**. Removing `.sapwood/PAUSE` lets that lane's fix leg dispatch on the next tick,
after which the run can idle out normally; lifting it doesn't resume anything by itself beyond
that — a fully drained/idle run still needs a new `sapwood run`. Under the daemon (`forever`)
mode, the engine keeps ticking regardless, and `--resume` takes effect on the very next tick.

### Sentinel isolation boundary (honest statement)

The engine's `.sapwood/` runtime root (the state DB) sits outside worker git worktrees as a
**permission-layer boundary** — the worker process is not launched with `--add-dir .sapwood`,
so it has no `claude`-tool path into that directory. This is **not an OS-level sandbox**,
so the guard (`engine/src/guard/guard.ts`) adds defense-in-depth on top of that boundary.

The guard's write-deny rule (`protectedPathLabel`, `checkControlSentinelArg`) no longer
enumerates individual filenames — it targets the fixed `.sapwood/` runtime root as a whole
(#1079), so one segment-equality rule covers the three control sentinels together with
everything else the runtime directory holds, instead of naming each path separately (see
[configuration.md "The `.sapwood/` runtime directory"](guide/configuration.md#the-sapwood-runtime-directory)
for the layout itself, not restated here). A
write-class built-in tool (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) or a Bash write vector
(`touch`/`rm`/`mv`/`sed -i`/`perl -i`/`tee`/`dd`/`cp`/`install`/redirect-to-path, or
`git rm`/`mv`/`restore`/`checkout`) is denied whenever its lexically normalized target contains an
exact path segment `.sapwood` — the root itself (`rm -rf .sapwood`) or any descendant
(`.sapwood/PAUSE`, `.sapwood/cache/x`) — including via relative traversal
(`../../.sapwood/KILL_SWITCH`) and glued to a flag (`--target=.sapwood/PAUSE`), matched
case-insensitively (macOS/APFS default is case-insensitive, so `.SAPWOOD/pause` still hits
the real directory). A sibling name that merely starts with the segment
(`.sapwood-notes/`) or carries it inside a filename (`notes/about.sapwood.md`) does not
match — segment equality, not substring. Root equality also closes the old "directory
deleted without ever naming a sentinel" gap: `rm -rf ../../.sapwood` now matches directly,
since the root itself is a hit, not just a file inside it.

Honest scope, stated plainly, not claimed as exhaustive — three residual classes, not one
mechanism this rule closes completely:

- **(a) Guarded built-in tool family only.** Inherited MCP write tools never reach the guard
  hook — its PreToolUse matcher names only `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/
  `Read`/`Grep`/`Glob`/`NotebookRead`, no `mcp__` pattern at all (see
  [Worker denylist vs. peripheral allowlist](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
  for the full account). A write/exec-class MCP server an operator's config registers can
  write anywhere on disk, `.sapwood/` included, without the guard ever being asked.
- **(b) Symlink aliasing is a lexical residual — the same class this rule already carried,
  not widened or closed by moving from an enumerated regex to a root rule.** The guard judges
  the path segments a Bash/file-tool argument spells out after `normalizePath`'s traversal
  collapse; it does not `realpath`/`lstat` anything (no filesystem canonicalisation is
  added). A symlink whose own name carries no `.sapwood` segment but resolves onto
  something under the runtime root — or the reverse — is judged on the argument's text, not
  the filesystem's resolved target.
- **(c) Opaque indirection is a lexical residual too — the same class the previous sentinel
  regex already had, not widened.** The Bash argv walk (`checkControlSentinelArg`) only sees
  tokens on the command line it can parse as a bare word or a `-`-prefixed glued flag; a path
  reaching the filesystem some other way is invisible to it: an environment assignment glued
  to the SAME command line (`TARGET=.sapwood/PAUSE node writer.js` — the token
  `TARGET=.sapwood/PAUSE` normalizes as one segment, `TARGET=.sapwood`, not `.sapwood`, so it
  never matches, and the assignment isn't a `-`-prefixed flag either); a script that hardcodes
  the path *inside its own source* rather than taking it as a CLI argument (`node
  some-script.js`, no path argument — the guard judges the Bash command line, not a script's
  file contents); or any other CLI form the walk doesn't reach. No machinery is added here to
  close this class — the same "document the residual, don't chase it with more machinery"
  stance this file's other HONEST SCOPE notes already take.

**`sapwood pause`/`stop`/`estop` are NOT an instance of the residual class above —
they are their own, distinct class the guard fences separately.** The bullets above are
obscure hand-rolled forms a worker would have to construct deliberately. `sapwood pause`,
`sapwood stop`, and `sapwood estop --confirm` are the opposite: a shipped, operator-
documented CLI verb (docs/guide/getting-started.md, docs/guide/supervision.md,
commands/sapwood-stop.md all tell an operator to run it) that any worker with ordinary
Bash access can invoke by name. They resolve the sentinel path internally
(`dirname(dbPath)` + the fixed filename) rather than taking it as a CLI argument, so no
`.sapwood/PAUSE`/`.sapwood/KILL_SWITCH`/`.sapwood/EMERGENCY_STOP` token ever appears on the
Bash command line for `checkControlSentinelArg` to match — including `sapwood estop clear`,
which lifts an already-fired EMERGENCY_STOP with no sentinel path in sight. `guard.ts` is
human-merge-only, so this fence was authored as a human-merge-only edit — extending
`checkControlSentinelArg`'s Bash-argument accident fence to recognize the three
stop-control verbs, the same route as the default-branch-push deny rule. **This fence
is in place.**

**The fence covers the *discoverable* stop-control invocation forms** — the
bare `sapwood` binary, `node .../cli.js`/`cli.ts` (path-prefixed or direct-executed), and
`npx sapwood[@version]` (npm's own documented "run a specific/latest version" syntax) —
the shapes this repo's own operator docs and `--help` text teach. An invocation that hides
the command word behind an arbitrary package spec instead — `npx file:<path>/engine`, a
scoped package such as `npx @<scope>/engine`, or an aliased binary — is **not** fenced and
is an **accepted residual**, in the SAME class as the hardcoded-path-inside-a-script
residual documented above: an accident fence recognizes the invocations an operator
would actually reach for, not every way a determined adversary could construct one. This
list is not exhaustive.

Until every gap above is closed, treat the isolation boundary as "a worker won't
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
  directly, so total recorded spend is the sum of the real legs. The live estimate this
  bullet describes is blind to a spawned subagent's own spend — see the paragraph
  under [Worker denylist vs. peripheral allowlist](#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
  above for the measured size of that gap and why it's accepted unbounded.
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings.
  Breaching either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses. Their roles differ:
  `dailyBudgetUsd` is the **durable** runaway-spend boundary — a UTC-calendar-day
  ledger sum that survives restarts. `maxWallClockSec` is a **per-process attention
  alarm** — one clock per process life, anchored at process start in memory, fresh on
  every restart at any gap length. A restart is a *sanctioned* renewal (manual, script,
  or a user-configured supervisor — the human's standing intent); the durable
  cross-restart bounds are money (`dailyBudgetUsd`), gates, guard, and the kill switch,
  never the wall clock. Entering a breach emits a reason-bearing
  `ceiling-breach-entered` event once per episode.

**Engine-agent review-session spend.** Under
`reviewer.mode: engine-agent`, gate②'s review session is itself a paid Claude session — its cost
reaches `spend_ledger` too, recorded once a verdict is decisive
(`review/production.ts`'s `recordWalDecisiveOutcome`, via `State.recordEngineReviewVerdictAndSpend`),
so `dailyBudgetUsd`/`roundBudgetUsd` (both plain, worker-unfiltered `SUM(usd)` reads) count it
like any other spend. The verdict-announcing event, the WAL's `decisive_outcome` write, and this
spend all land in **one SQLite transaction** — doing this as separate writes (event
first, spend last) would let a crash between them leave the verdict durably recorded while the spend
silently, permanently never lands (the event's own existence is the replay dedup memory, so a
retry would read "already handled" and skip the spend forever). It is ledgered under a key
**distinct** from the reviewed lane's own worker name (`<lane>:engine-review`), deliberately:
recording it under the lane's own name would make `State.getWorkerActualModels(issue)` — keyed
on an exact `worker` match — pick up the reviewer's own model as one of "the producing lane's
actual models," poisoning engine-agent.ts's D5 same-model check on that lane's next review (a
fix-round re-review would then see the reviewer overlapping itself and fail closed forever). A
review attempt that never reaches a decisive verdict (all retries exhausted, a setup failure, a
D5 same-model refusal) still records nothing to the ledger — its cost is real but stays visible
only in that attempt's own WAL artifact; this mirrors the whole-logical-review cap, which
reads the WAL, never the ledger, for the exact same reason. **This attributes what IS recorded —
it does not widen this**: the deliberate-absence posture for non-decisive attempts is unchanged,
still no ledger row of any kind for one.

**Durable spend attribution.** `spend_ledger` carries three additional columns, written by
every real spend site: `actor_kind` (`worker` | `fix-leg` | `peripheral-role` | `engine-review` —
conductor.ts's reclaim path sets the first two from whether the terminal lane was a `fixing`-origin
leg; peripheral.ts's shared `runSessionWithRetry` sets `peripheral-role` for every po-align/
po-triage/architect/plan-review/harvest/retro session; production.ts's decisive-verdict callback
above sets `engine-review`), `role` (the peripheral role id, `peripheral-role` rows only), and
`estimated` (0/1, tri-state — NULL when a caller never classified the distinction). `estimated` is
populated at every terminal settlement, worker/fix-leg rows included: `worker.ts`'s
`writeTerminalSentinel` persists which of "a real provider-reported `total_cost_usd`" vs. "the
pinned-price estimator's substitute" fed the recorded cost, threaded through `LaneProbe.costEstimated`
into `conductor.ts`'s terminal `settleTerminalWorker` calls, alongside the engine-review site's own
pre-existing `ReviewSessionSpend.kind` distinction — see docs/guide/supervision.md's Est-vs-real cost
method for how this feeds the estimator-bias query. Pre-v1, plain schema bump: no
migration/backfill for rows written before this — they read `actor_kind IS NULL` forever,
rendered `unclassified` by the read-model (`State.spendSummaryForDay`), same "never guess" stance
as every other unattributed row. `spendPage` (the raw `/api/spend` paging transport) surfaces all
three columns verbatim too — its own "the ledger's own columns" doc now matches what it returns.

The shared read-model's spend section (`status --json`'s `spend` key) reports the real
`lanes`/`roles`/`review` split (`settledByWorker`/`settledByRole`/`reviewUsd`) plus the
`unclassifiedUsd` leftover bucket — now a COMPLEMENT query (every row not validly matching one of
the three positive buckets, including a corrupt/unrecognized `actor_kind` value or a
`peripheral-role` row missing its `role`), not an `actor_kind IS NULL`-only query, so a
malformed row can never silently vanish from every total — and its `incomplete` flag.
`incomplete` is true whenever `unclassifiedUsd > 0` **or** `reviewer.mode` is `engine-agent`
(the schema default): the deliberate-absence posture above means a non-decisive review attempt's
cost can be real yet leave **no ledger row of any kind**, so `unclassifiedUsd` alone can never
prove the day is complete under that mode — `incomplete: false` is only reachable under a
non-engine-agent reviewer mode. See `state/read-model.ts`'s `StatusSpendDTO` doc for the exact
identity `todayUsd` holds by construction.

**Supervisor prerequisite:** operators running unattended under a supervisor
MUST configure the supervisor's own crash-loop circuit-breaker — e.g. systemd's
`StartLimitBurst=5` / `StartLimitIntervalSec=600` (or the equivalent restart-limit in
your process manager) — sapwood *assumes* it. A crash-looping engine is visible in the
supervisor's restart counters; alert THERE. Defense-in-depth behind that assumption:
the engine's own rapid-restart detector (`engine.rapidRestart`, default 5 starts in
10 minutes) parks autonomous dispatch with an escalation when it observes its own
crash-loop, and the single-instance data-dir lock keeps a supervisor's fast
restarts from ever double-driving one board. A crash loop's blast radius is bounded
either way by `dailyBudgetUsd` and the merge gates.

In both directions the design favors **drain-then-escalate over an immediate hard
stop** — a hard kill is the last resort, not the first response, because it destroys
in-progress work as well as spend.

## The `origin:agent` label convention

Any GitHub issue created *by an agent* (as opposed to authored directly by a human)
must carry the `origin:agent` label. `sapwood init` provisions this label like the rest
of the taxonomy.

The labelling is **shipped machinery, not just a convention**. Two PO roles open issues
on your behalf today, and each applies the label itself at creation time as part of its
governance pass: the aligning role (`engine/src/loop/align.ts`, goal-alignment
proposals) and the decomposition role (`engine/src/loop/decompose.ts`, `split`
children). Both label idempotently, so a resumed run re-applies rather than skips it —
provenance is marked on every agent-created issue, not best-effort.

The human confirmation such an issue needs is the ordinary `Ready` move, and no separate
gate mechanism exists or is needed. Per [`PLAN.md`](PLAN.md)'s "Ready-as-signature"
section, moving *any* issue to `Ready` — agent- or
human-authored — is itself the human signature endorsing that issue's why/what. An agent
can propose work; a human still decides what actually enters the dispatch queue, and
that card move *is* the decision.

## The `plan:approved` label and gate⓪

Decision #8's `Ready` gate requires more than a verification plan merely *existing* — a
plan must also pass agent quality review before dispatch, and `verify:n/a` is not simply
self-declared by whoever wrote the issue.

`getReadyIssues` (`engine/src/forge/forge.ts`) now requires, for any issue not labelled
`verify:n/a`, **both** a verification-plan section in the body **and** the
`plan:approved` label — plan presence alone no longer dispatches. `verify:n/a` still
routes through the doc-gate path, but only when `needs-human` is absent: the
verification-plan-reviewer peripheral may *propose* `verify:n/a` for genuinely unverifiable work, but
it always pairs that proposal with `needs-human` in the same action, so it's a human —
never the agent — who actually opens the doc-gate path, by removing `needs-human`
themselves. `needs-human` and `blocked` block dispatch unconditionally, regardless of
any other label present.

**A plan below standard self-heals rather than stalls**: when the
reviewer finds the plan missing or inadequate beyond its minor-correction latitude, it
does not park the issue for a human — its structured decision names precisely what's
missing, the engine posts that as a comment (the brief), and the loop dispatches a
**scoped plan-drafting session**: issues-only writes, a session distinct from the
reviewer (plan-author ≠ plan-approver — the reviewer never approves a plan it
authored), never a full worker lane, and it never implements the issue itself. The
draft then comes back through a fresh plan-review. The cycle is bounded — at most
`roles.verificationPlanReviewer.maxDraftCycles` draft→re-review attempts per issue (default 2) —
after which the loop applies `needs-human` with the full attempt trail preserved
(Decision #9's degrade-to-human). Every attempt is externalized as issue edits/
comments, so a human can inspect or intervene at any point. The Ready-gate enforcement
above is unchanged by any of this: implementation dispatch still requires
`plan:approved` (or adjudicated `verify:n/a`) — only the repair path became more
autonomous.

The verification-plan-reviewer/verification-plan-drafter sessions are wired and pure computation:
neither holds a `Bash` tool grant, so neither ever runs `gh` itself. Each session's
final message ends in a structured, sentinel-delimited output block; the engine
(`plan-review.ts`) parses it, validates it against a zod schema, re-checks the one
content invariant worth cheaply verifying — an "approve"/drafted body must actually
carry a verification-plan section, since schema-valid is not the same as truthful —
and only then applies `plan:approved` (or any body correction) itself via `IForge`.
Malformed, schema-invalid, or content-invalid output is treated as a failed attempt:
retried once, then escalated to `needs-human` with the full attempt trail, exactly like
an outright session crash. The shipped default prompt lives at
`engine/prompts/verification-plan-reviewer.md` (`roles.verificationPlanReviewer.promptFile` overrides it — same
pattern as `worker.promptFile`).

**`plan:approved` is re-endorsed, not permanent.** The verification-plan-reviewer's candidate
sweep above is now scoped to the round pool rather than the whole Ready lane, and a
prior round's `plan:approved` is re-checked — a lightweight, zero-forge-write-on-confirm
session — every time that issue re-enters a pool, before its approval is trusted for
dispatch again; a session that can't confirm or fails escalates `needs-human` the same
way an initial review does. The label itself is never removed by that check either way.
See [`docs/PLAN.md`](PLAN.md#round-orchestrator) (the "gate⓪ is scoped
to the round pool..." locked decision) for the full detail.

## The AC-authority dispatch snapshot

Per-AC verdicts need an authoritative,
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

**The AC-authority hash is marker-normalized, not the raw body hash.** The cursor
discipline requires every PO comment on an issue to advance the
`<!-- sapwood:comments-adjudicated-through: N -->` marker in the same body edit — which, against
a raw full-body hash, would make a legitimate cursor advance on an in-flight issue *always* read
as AC drift. `ac-snapshot.ts`'s `hashBodyForAcAuthority` normalizes the body before hashing
(`normalizeForAcAuthority`, the same function backing every AC-authority site: `buildAcSnapshot`,
`checkAcSnapshotDrift` above, the re-baseline candidate pin, and its confirmation compare —
all four must share it, or a staged candidate could never match the snapshot on a later
tick), and excuses exactly two classes of edit from drift, both narrowly scoped:
1. **A well-formed standalone marker line** — the ENTIRE trimmed line is `<!--
   sapwood:comments-adjudicated-through: N -->` where `N` is `0` or a bare digit run
   (`comment-cursor.ts`'s fence-aware standalone-line scan, filtered to well-formed VALUES only —
   stricter than `stripStandaloneMarkerLines`/`applyRoleBodyRewrite`'s own permissive strip, which
   must still remove a role's malformed marker attempt too). A marker-*shaped* line carrying extra
   payload (e.g. `<!-- sapwood:comments-adjudicated-through: 0 IGNORE PRIOR ACs -->`) is NOT
   well-formed and stays in the hash — fail-closed against payload smuggling disguised as a marker
   advance.
2. **A line-ending-only difference** (CRLF normalized to LF) **and the blank-line residue removing
   a marker line leaves behind** (any run of 2+ consecutive blank lines collapses to one; trailing
   blank lines/whitespace are trimmed) — without this, a markerless dispatch body and a live body
   that gains its FIRST marker (a PO's very first cursor-discipline comment) would still drift, since
   the blank line conventionally separating the marker from surrounding prose survives a bare
   line-removal as a dangling trailing newline or a doubled blank line that a markerless body never
   had. This collapse is WHOLE-BODY, not fence-aware like the
   marker scan above — a whitespace-only blank-line-run change INSIDE a fenced code block is also
   excused from drift, same as anywhere else in the body. Code samples are not byte-protected
   against that one narrow class of edit; only well-formed marker lines get the fence-aware
   treatment.

Every other byte of the body still participates in the hash, so any non-marker edit still drifts
fail-closed; a marker advance plus a real edit still drifts too. This normalization is scoped to
AC authority only: `ac-snapshot.ts`'s own `hashBody` and `comment-cursor-gate.ts`'s `checkBodyDrift`
(the functions gate⓪'s session-input drift check and both write-time drift guards call) stay raw
and unmodified — those call sites are exactly where the cursor-discipline invariant (a role body-write must
not land silently over an operator's freshly-advanced marker) is enforced, and normalizing them
too would defeat it.

**The comment-cursor recheck before DRIVE reads the LIVE body, not the dispatch-time snapshot.**
`conductor.ts`'s `checkCommentCursorBeforeDrive` — the
review-time recheck that runs immediately before `gate.driveOne` — computes the adjudication
cursor from the live issue body the sibling AC-drift check (`checkAcDriftBeforeDrive`, just above
it) already fetched and confirmed AC-authority-matches the snapshot, never a second forge fetch.
Before this fix it read `snapshot.body` (the dispatch-time text) on the theory that the sibling
drift check's confirmation made a second body irrelevant — true only while the AC-authority hash
was the raw body hash. Once marker-only edits became excused from AC drift (the normalization
above), that theory broke: a PO's own marker advance passed the drift check while leaving
`snapshot.body` carrying the stale pre-advance marker value, so the cursor check read the PO's own
adjudication as still-pending and bounced the lane to `comment-cursor-stale` — a real production
failure, not a hypothetical.

**The engine-agent session consumes the snapshot directly.** Its adapter resolves
`state.getAcSnapshot(issue)` and builds the review prompt from that frozen full body and AC
manifest; it never re-fetches the issue body or re-extracts acceptance criteria for session input.
A missing snapshot is `unavailable` fail-closed. The hosted-bot trigger still performs its own live
`getIssueBody` read to build the `@codex review` comment, but the conductor's full-body drift gate
above runs before either reviewer kind reaches its gate path.

**Snapshot ownership is bound to the lane, not just the issue.** `ac_snapshots` is
upsert-by-issue (one row per issue number) — but a `failed`-with-PR lane awaiting a
human's GATED RECLAIM is *not* counted as in-flight (`activeWorkers()` excludes
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

## CI execution evidence for engine-agent review

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

The paragraph above describes `loadConfig`/`parseConfig` — every read-only consumer (`status`,
`events`, and this same drive path once a run is already in flight) — which is why it still only
warns. `sapwood run` itself goes further: it refuses to start at all under this exact
combination, with a hard startup error naming the combination, the consequence, and both
remedies, so the "queues before spending" drive-path behavior above is unreachable via `run` in
practice — a run under this combination never gets far enough to dispatch a PR that could queue.
`sapwood validate` mirrors that same refusal rather than only warning, so an operator never
sees `validate: OK` on a config `run` would hard-refuse.

**Gate① is rollup-wide and strictly broader than `requiredChecks`.** `requiredChecks`
narrows which checks count as trusted EVIDENCE for a code-verifiable AC; it never narrows which
checks gate the merge itself. `PRStatus.ciGreen` requires the ENTIRE status-check rollup to pass,
`requiredChecks` or not — so a non-required check can still BLOCK a merge (by being red, pending,
or concluding without passing) but can never AUTHORIZE one on its own; only a fully green rollup
does that.

## The comment-adjudication cursor

Workers are dispatched with the issue BODY only (`{{issue.body}}`, `worker.ts`), which stays
maintainer-writable while the comment stream does not. The comment-adjudication cursor closes the
resulting gap — a body that has gone stale relative to its own comment thread — before gate⓪
review or dispatch spends against it. It is a deterministic, trust-independent staleness gate, no
LLM in the loop, keyed on one body marker: `<!-- sapwood:comments-adjudicated-through: <comment-id> -->`,
meaning "a maintainer has adjudicated every comment at or before this one." Pure marker parsing and
pending-comment computation live in `comment-cursor.ts`; the impure fetch/escalate half lives in
`comment-cursor-gate.ts`; both are wired into engine-side checkpoints at gate⓪ (four
sub-checkpoints, each before the effect it protects), dispatch (before the leg spawns), drive
(before a verdict-driven action), and fix-leg spawn (before a FIXUP leg spawns) — none touching
the worker's own prompt.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| A cursor targets a comment by stream position, never by numeric id; a missing marker fails closed only when non-engine comments exist, while a duplicate, non-numeric, or dangling-target marker always fails closed. | `comment-cursor.ts::computeCommentCursor` | `comment-cursor.test.ts`: "malformed marker (non-numeric, not '0'): fails closed" |
| No role may create, move, or delete the cursor marker: any role-emitted marker is stripped, and the current body's marker (if any) is reattached byte-for-byte. | `comment-cursor.ts::applyRoleBodyRewrite` | `comment-cursor.test.ts`: "applyRoleBodyRewrite (#703a): … carries the ORIGINAL marker byte-for-byte" |
| An operator-owned fence (`<!-- sapwood:operator-owned -->` … `<!-- /sapwood:operator-owned -->`) is recognized standalone-line/fence-aware and extracted byte-for-byte, CRLF included. | `comment-cursor.ts::extractOperatorOwnedFences` | `comment-cursor.test.ts`: "extractOperatorOwnedFences: preserves CRLF bytes internal to a fence" |
| A role write that alters, removes, or rewords a single byte inside a current-body operator-owned fence refuses the ENTIRE write, never a partial repair. | `comment-cursor.ts::applyRoleBodyRewrite` (`missingOperatorFences`) | `comment-cursor.test.ts`: "#827: a role-proposed body that alters a byte inside an operator-owned fence is rejected" |
| An unclosed current fence refuses the whole write outright; a fence-only CRLF/LF edit still counts as a byte change; a role-forged fence tag is stripped, its content kept. | `comment-cursor.ts::applyRoleBodyRewrite` (`operatorFenceScanResult`, `stripUnpreservedOperatorFenceTags`) | `comment-cursor.test.ts`: "applyRoleBodyRewrite (P1a, mutation-kill target): a malformed opener in the CURRENT body refuses the ENTIRE write outright" |
| The operator-owned fence's open tag is excluded by name from the generic marked-mode scan, so its presence never poisons AC/verification extraction into a false "planless" read. | `forge.ts::associateMarkedSections` | `forge.test.ts`: "#827: an operator-owned fence coexisting with a LEGACY (unanchored) verification plan does not poison extraction" |
| PO-triage body normalization happens exactly once, against a fresh live-body read taken immediately before the write — the write-ahead journal itself stores the raw, un-normalized body. | `align.ts::updateIssueBodyIfUnchanged` (normalizes at write time); `align.ts::persistTriageDecision` (journals the raw body) | `align.test.ts`: "#703 v2, gate② P1-1 … never writes the journaled marker" |
| When the current body's own marker state is already invalid (duplicate/malformed), the role write is refused entirely — never repaired. | `comment-cursor.ts::checkMarkerWritePrecondition` | `comment-cursor.test.ts`: "checkMarkerWritePrecondition: more than one marker line refuses — reason 'duplicate-marker'" |
| The final pre-write check is a synchronous string compare with no I/O between the read and the write, so nothing async can land in the gap. | `comment-cursor-gate.ts::checkBodyDrift`, called from `plan-review.ts`'s write sites | `plan-review.test.ts`: "the reviewer approve-with-revision's FINAL getIssueBody and updateIssueBody are ADJACENT in the forge call trace" |
| A marker counts only as the entire trimmed line outside a fence; any attempt-shaped payload between the colon and `-->` is validated, never silently read as absent. | `comment-cursor.ts::scanStandaloneMarkerLines` (recognizes the attempt); `computeCommentCursor` + `checkMarkerWritePrecondition` (validate it, fail closed) | `comment-cursor.test.ts`: "#703 v2 gate② P2-1: a BLANK-value marker attempt … fails closed as malformed" |
| A comment is exempt only when it carries `ENGINE_COMMENT_MARKER` AND its author matches the authenticated actor; an unresolvable actor exempts none. | `comment-cursor-gate.ts::fetchCommentStream` | `comment-cursor-gate.test.ts`: "unresolvable actor (getAuthenticatedActor -> null) exempts NO comment, ever" |
| Any id-less comment anywhere in the fetched stream fails the whole check closed, naming its stream position, never a substituted placeholder id. | `comment-cursor.ts::computeCommentCursor` | `comment-cursor.test.ts`: "a comment with a null id anywhere in the stream fails closed: comment-id-missing" |
| Cursor freshness is re-checked, always against the exact body a decision was computed from. At gate⓪: `pre-spend` before the verification-plan-reviewer/confirm session is spent on, `pre-apply` before any reviewer-derived body or label write, `pre-drafter-write` before the drafter's own body write, and `post-confirm` before an existing approval is implicitly preserved. At dispatch, before the leg spawns. At drive, before a verdict-driven action. At fix-leg spawn, before a FIXUP leg spawns. | `plan-review.ts::checkGate0CommentCursor` (gate⓪); `conductor.ts` dispatch loop (dispatch); `conductor.ts::checkAcAuthorityFreshness` (drive, fix-leg spawn) | `plan-review.test.ts`: "a DIRECT body edit landing DURING the confirm session discards a 'confirm' outcome too"; `conductor.test.ts`: "tick dispatch (#652): a non-engine comment already present … blocks dispatch"; "comment-cursor-stale(checkpoint: fix-leg-spawn), no fix leg spawned" |
| A confirmed stale/invalid cursor applies needs-human plus one deduplicated pointer comment naming the marker line to paste; dedup/post failures are reported, never thrown. | `comment-cursor-gate.ts::escalateCommentCursorStale` | `comment-cursor-gate.test.ts`: "escalateCommentCursorStale: the SAME cursor/pending set never produces a second comment" |

**Boundaries**

- A body with no marker and zero comments is the pass-through case — behavior-identical to
  pre-mechanism, no new write/label/outcome (`comment-cursor.test.ts`: "no marker, zero comments:
  ok, cursor 0, nothing pending").
- A deleted comment that is merely PENDING, not the cursor's target, supplies no content and is
  not a failure — only a dangling TARGET fails closed (`comment-cursor.test.ts`: "a deleted
  PENDING comment (not the cursor target) simply no longer supplies content — not a failure").
- A byte-identical operator-owned fence that only changed position is not a violation — the
  comparison is a multiset, never positional.
- A comment/body fetch failure performs no issue write; it propagates through each checkpoint's
  own existing retry/environment-failure path, never becoming a human adjudication.
- When a round dispatches nothing and also produced `comment-cursor-stale` events, the round log
  names the held-back issue(s) — a read of already-appended events, no write of any kind, including
  on the read's own failure path (`round.test.ts:667`).

**Rollout is a one-time backfill, not a migration.** No new CLI, no migration state, no schema
change; existing commented issues just need a maintainer to record-ruling → rewrite-body →
advance-cursor once.

**v1 residual: edits are out of scope, ordering is by comment CREATION only.** Editing an
already-cursored comment does not reopen it; a binding amendment needs a NEW comment. Accepted,
not hidden: "the cursor is current" means every comment created at or before its target was
adjudicated, not that every comment's current text was seen.

### Residual notes for this doc package

- **The worker prompt surface is unchanged.** Workers are dispatched with the issue body only
  (`{{issue.body}}`, `worker.ts`); nothing in this doc package touches what a dispatched worker
  session is shown.
- **"No issue-comment tools" is a proxy-grant claim, not a Bash claim.** The cursor closes the
  engine's own forge-proxy comment-reading tools (`PROXY_ROLE_TOOL_MATRIX`). An **L0** worker still
  holds `Bash(gh *)` (see [Worker credential tiers](#worker-credential-tiers)) and could read
  comments via `gh` on its own initiative; **L1** is what actually closes this channel, stripping
  the forge credential and `Bash(gh *)` together (`WORKER_ALLOWED_TOOLS_NO_GH`).
- **The public/private threat-model split.** In a public repo, comment entries from an author
  outside GitHub `OWNER`/`MEMBER`/`COLLABORATOR`, the authenticated engine actor, or the reviewer-bot
  allowlist are dropped at five forge reads (issue/PR comments, reviews, review threads, tails);
  missing author provenance fails the whole read. Nothing else in the engine filters comment
  provenance. The filter records only an aggregate withheld count and does not write to GitHub.
  Editing an already-cursored comment remains the separate "v1 residual" case above.
- **`docs/security.md` itself, and the prompt files, both ride the instruction-path escalation.**
  `engine/prompts/**` and `docs/security.md` are both entries in `escalation.instructionPaths`
  (see [Instruction-path changes escalate to human review](#instruction-path-changes-escalate-to-human-review)),
  routing `sapwood:human-merge-only` as designed. `docs/guide/supervision.md` is not on that list.

## See also

- [Trust model prerequisites](guide/getting-started.md#trust-model-prerequisites) — the required
  GitHub-side and identity setup before unattended merge.
- [`configuration.md`](guide/configuration.md) — the `guard`, `reviewer`, `merge`, `ci`,
  `escalation`, `cost`, `labels`, and `roles` config sections referenced above.
- [`PLAN.md`](PLAN.md) — the full architecture, decision log, and the v0.2 round
  orchestrator's self-feed design.
- [`design/279-engine-review-agent.md`](design/279-engine-review-agent.md) — the full
  engine-agent reviewer design (materialization, review session mode, the drive/audit
  flow) the "Review session mode" section above distills.
