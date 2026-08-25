# Execution profiles

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for execution profiles: host permission mode and the Bash sandbox.

## Execution profiles: host permission mode + Bash sandbox

**`host.permissionMode` is a profile key, not a capability grant** — it configures HOW a
session's tools reach the host, never WHICH tools a producer leg is offered (that stays
[host-delegated capability management](../security.md#host-delegated-capability-management),
unchanged and unrelated; no `capabilities.*` surface is reopened here).

**The engine injects no sandbox settings into any session it spawns, and no sandbox-selecting
config key exists.** Claude Code's own built-in Bash sandbox (Seatbelt on macOS, bubblewrap+socat
on Linux/WSL2) is available only as an operator-configured recipe — see [`docs/guide/configuration.md`'s
Bash-sandbox recipes](../guide/configuration.md#bash-sandbox-and-outer-boundary-recipes) — never
something sapwood configures on a producer's behalf.

### Seven layers, none redundant with another

These seven mechanisms answer different questions; landing the Bash sandbox makes none redundant:

| # | Layer | Owner | What it answers |
|---|-------|-------|------------------|
| 1 | CLI `--allowedTools`/`--disallowedTools` | Host tool shaping (advisory for producers) | Which named tools/subcommands does the CLI offer this session at all? |
| 2 | Guard hook + deterministic engine writes + merge driver | Governance effects | Which write actions (merge, label, forge state change) are EVER trusted, regardless of what a session asked for? |
| 3 | L0/L1 credential tier ([worker credential tiers](credential-tiers.md#worker-credential-tiers)) | Credential identity | WHO is this session, forge-API-wise — the operator's full identity, or a scoped git-transport-only key, or nothing? |
| 4 | Bash sandbox (operator-configured, recipe below) | Execution reach — Bash subprocesses only | What can a Bash command this session RUNS read, write, or reach on the network, once it's already been allowed to run? |
| 5 | Forge MCP proxy | Information access | What forge (GitHub) data can this session read/write through the engine's own mediated channel, independent of raw `gh`/git? |
| 6 | AC-authority dispatch snapshot | Authoritative gate input | What is the issue's body/ACs AS OF DISPATCH, immune to a later producer-side edit? |
| 7 | Gate② review-session seal | Init integrity | Does the REVIEW session itself start with zero MCP servers, zero file-based settings, and a forced-hard guard? |

Layer 4 (the Bash-sandbox recipe) is orthogonal to layer 3 (credential identity vs. execution
reach — independent axes; never coupled to `worker.deployKeyPath`/`worker.deployKeyId` in
config). It applies to every Bash-bearing `claude` session the engine spawns — worker legs
(dispatch/resume/fix) and `retro` — never to gate② (no Bash at all in a review session) or to
`codex exec` (its own `--sandbox read-only`, a vendor-specific mechanism outside this recipe's
scope).

### Deployment-tier ladder

From lightest to strongest, matching Claude Code's own [sandbox
environments](https://code.claude.com/docs/en/sandbox-environments) taxonomy:

| Tier | Isolates | sapwood's stance |
|------|----------|-------------------|
| Host (default) | Nothing engine-configured; whatever the operator's own Claude settings already do | The engine's own default — it injects nothing |
| Bash sandbox (operator-configured) | Bash subprocesses only (filesystem + network); built-in tools (Read/Edit/Write), MCP servers, and hooks run unconstrained | Operator recipe only, in [`docs/guide/configuration.md`](../guide/configuration.md#bash-sandbox-and-outer-boundary-recipes) — no engine-side injection exists |
| `@anthropic-ai/sandbox-runtime` | The WHOLE `claude` process — Bash, built-in tools, MCP servers, and hooks together, same OS primitives as the Bash sandbox | Operator recipe only (same guide section); sapwood does not wrap its own process launch in it — framework code stays generic |
| Dev container / custom container | Full development environment, Docker-based | Operator recipe only (same guide section); the upstream example dev container's default-deny firewall is the documented starting point for pairing with `--dangerously-skip-permissions`-class unattended runs |
| Dedicated VM / Claude Code on the web | Full OS, or Anthropic-managed VM | Out of scope for sapwood's own engine; named for completeness, not built |

The Bash sandbox is **defense in depth** per Claude Code's own docs — not sufficient for fully
unattended runs on its own; the recommended unattended boundary is a container, VM, or the
sandbox runtime, which additionally wrap MCP servers and hooks. sapwood documents that
outer-boundary layer (below); it does not build one — containers are deployment-specific, and
framework code stays generic.

### `host.permissionMode`: `dontAsk | auto | bypassPermissions`

One global key, default `auto` (unchanged behavior), applied to every `claude` session the
engine spawns. The engine's deny side — `WORKER_DISALLOWED_TOOLS`, `ROLE_DISALLOWED_TOOLS`, the
guard hook, gate② seal — is **mode-independent and stays engine-owned** across all three values;
only the allow side moves.

- **`auto`** (default) — a classifier reviews actions in place of a human prompt; a `-p` session
  with no `--permission-prompt-tool` denies an action outright once the classifier's
  repeated-block threshold is hit, rather than hanging on a prompt that can never arrive.
- **`dontAsk`** — only an explicit `permissions.allow` rule, a [read-only Bash
  command](https://code.claude.com/docs/en/permissions#read-only-commands), or a
  PreToolUse-hook-approved call runs; everything else auto-denies. **The allow side is the
  OPERATOR's Claude settings** (`permissions.allow` merges with the engine's `--allowedTools`
  floor — there is no engine `allowedTools` config key). An operator's `permissions.allow` rules
  must cover both an explicitly-denied tool (`WORKER_DISALLOWED_TOOLS`) and an
  implicitly-denied one (never listed) for a `dontAsk` worker to stay productive.
- **`bypassPermissions`** — everything runs without a prompt or classifier check, including
  writes to Claude Code's own [protected
  paths](https://code.claude.com/docs/en/permission-modes#protected-paths); this is an operator
  call the engine does not gate — whether the operator's own OS-level isolation is adequate is a
  judgment the engine has no way to verify. At startup the engine emits one guidance WARN (log
  line + a `bypass-permissions-mode-configured` state event,
  `bypass-permissions-warning.ts::detectBypassPermissionsMode`)
  naming the outer-boundary recipe below.
  - **The deny side is unaffected by this mode**: `--disallowedTools` (`worker.ts::claudeArgs`,
    which appends it regardless of `permissionMode`) and the PreToolUse guard hook (spawned via a
    fixed env the mode cannot touch) both still block.
  - **Residual, engine-invisible:** a managed `permissions.disableBypassPermissionsMode:
    "disable"` policy silently removes this mode regardless of what `host.permissionMode`
    requests.

The key validates at load with a guidance message on an invalid value (`config.ts`'s `Host`
schema, same `.strict()`/enum rejection style as `guard.mode`).

### Bash sandbox: operator recipe (engine injection deferred)

The engine injects no sandbox settings into any session it spawns; an operator who wants Claude
Code's built-in Bash sandbox engaged configures it in their OWN Claude settings (the engine
neither requires nor prevents this, and never inspects or overrides it). The paste-ready floor,
the required `allowedDomains`/`excludedCommands` additions, and the L1 deploy-key note live in
[`docs/guide/configuration.md`'s Bash-sandbox
recipe](../guide/configuration.md#bash-sandbox-and-outer-boundary-recipes).

- **What it confines:** Bash subprocesses only — filesystem reads/writes and network egress from
  commands this session RUNS, once the command has already been allowed to run.
- **What it never confines, active or not:** built-in tools (Read/Edit/Write), MCP servers, and
  hooks run unconstrained regardless of whether this recipe is active — see the deployment-tier
  ladder above for what wraps the whole process instead.
- **Guaranteed once active:** the `dangerouslyDisableSandbox` escape hatch is off;
  `sandbox.filesystem.denyRead` closes the `worker.ts::workerCredentialFreeEnv` `steal.mjs`
  disk-read residual (observed: `EPERM`, with a specific `allowRead` entry able to re-open one
  named file); the guard hook and `--disallowedTools` keep firing regardless of sandbox state,
  including under `bypassPermissions`.
- **Residual even while active (settings additivity):** the array keys (`allowedDomains`,
  `excludedCommands`, `allowRead`, `allowWrite`) are ADDITIVE across settings sources with no lock
  outside managed settings — a worker-writable worktree's own `.claude/settings.json` can widen
  them (observed live). Boolean keys (`failIfUnavailable`, `allowUnsandboxedCommands`) resolve by
  settings-scope rank instead of merging, so they can't be locally re-opened the same way.
- **Residual even while active (managed-policy override):** a managed
  `allowManagedDomainsOnly`/`allowManagedPermissionRulesOnly` policy can silently change the
  effective floor the same way the existing [managed-settings
  exception](role-sessions.md#managed-settings-allowmanagedpermissionrulesonly-exception) already
  documents.
- **Residual even while active (match scope):** `excludedCommands` matches by command PREFIX, so
  an `ssh` child spawned by `git` or a `-c ...`-prefixed git invocation can escape an intended
  exclusion; an allowlisted domain is not a protocol-or-port restriction — CONNECT was verified
  to carry SSH:22 to an allowlisted `github.com` the same way it carries HTTPS.
- **Residual regardless of this recipe:** the sandbox never covers `Edit`/`Write`, and
  `bypassPermissions` skips protected-path checks — so a same-lane self-escalation via
  `.mcp.json`/`.claude/hooks` stays structurally possible, bounded only by the guard hook and by
  L1 credential absence.

### Operator recipe for an outer boundary (pointers, not files)

sapwood documents, and does not build, the container/VM/sandbox-runtime layer that wraps the
WHOLE `claude` process (MCP servers and hooks included, not just Bash) — see
[`docs/guide/configuration.md`'s outer-boundary
recipes](../guide/configuration.md#bash-sandbox-and-outer-boundary-recipes) for the three options
(`@anthropic-ai/sandbox-runtime`, dev container, custom container/VM).

None of the three is provisioned, launched, or verified by the engine; the same review checklist
applies regardless of who hosts it — what's mounted writable, what credentials are reachable
inside it, what the egress policy allows. This is what the `bypassPermissions` startup WARN
(above) points at.
