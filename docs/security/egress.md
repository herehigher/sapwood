# Network egress

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for worker and peripheral network egress.

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
profiles](execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox) below) IS a layer that could
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
`--setting-sources ""` seal (see [Review session mode](review-session-mode.md#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)
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
seal](ambient-repo-context.md#ambient-repo-context-record-dont-seal)): a peripheral session absorbing the repo's
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
permission layer, not a schema removal (see [Worker denylist vs. peripheral allowlist](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
below), so a session without the grant — a worker leg, or a peripheral role the grant
doesn't cover — can still EMIT a `WebFetch`/`WebSearch` tool_use block; the CLI's own
permission layer denies it at the paired `tool_result`, which this scanner does not read. A hit
therefore records an attempt, never proof of execution — the same "evidence, not a verdict"
stance the Bash tripwire above already takes. The engine deliberately keeps this unconditional
for every session kind: an attempted egress through a tool a session was never granted is
exactly what a post-hoc tripwire should surface, not suppress.
