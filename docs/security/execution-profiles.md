# Execution profiles

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for execution profiles: host permission mode and the Bash sandbox.

## Execution profiles: host permission mode + Bash sandbox

**[DR #1009](https://github.com/herehigher/sapwood/issues/1009) (owner-confirmed 2026-08-19),
re-adjudicating [#304](https://github.com/herehigher/sapwood/issues/304) (c) and amending
[Decision #11](../PLAN.md#constraints-locked-decisions); further amended 2026-08-20 (owner ruling, deferral
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
(that stays [host-delegated capability management](../security.md#host-delegated-capability-management),
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
exception](role-sessions.md#managed-settings-allowmanagedpermissionrulesonly-exception) already documents.
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
