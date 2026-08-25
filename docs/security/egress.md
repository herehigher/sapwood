# Network egress

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for worker and peripheral network egress.

## Worker network egress: Bash-channel containment available as a hardening profile

The guard hook is action-side: it stops a producer from self-approving or merging, protects
security-bearing write paths, and confines guarded read-tool calls to the worker's worktree. It
does not contain network egress from arbitrary commands a worker runs through `Bash` — a worker
that can `curl`, open a socket, or run an equivalent program can send repository or environment
data to an external endpoint. See [Design derivations](../design/security-egress-derivations-2026-08.md)
for why engine-enforced sandbox injection was evaluated and deferred.

The engine ships no sandbox config key and injects no sandbox settings into any session. **The
Bash lexical tripwire below is the only engine-side mitigation for worker Bash egress — full
stop, not conditional on any config key.** An operator who wants Claude Code's own built-in Bash
sandbox for engine-spawned sessions configures it in their OWN Claude settings
(project/user/managed); the engine neither requires nor prevents this.

This is an accepted boundary, not a feature the rest of the model implies. sapwood targets
trusted repos first and configures no network-isolated sandbox or proxy for worker sessions.
Operators must treat worker Bash egress as a blind spot — mitigated only by the lexical tripwire
below and, if independently configured, the operator's own Bash-sandbox settings — when deciding
which repos, credentials, and environment data are safe to expose to a run.

A second, broader inherited-capability egress gap exists separately: the operator's ambient host
MCP surface, which a producer leg inherits regardless of `Bash`, which the guard hook's matcher
does not mediate, and which a Bash sandbox would not cover either — MCP servers are separate
processes, not Bash subprocesses. See [Host-delegated capability management](../security.md#host-delegated-capability-management).
The two gaps are detected by different mechanisms — this section's lexical tripwire vs.
`scanEgressSuspects`'s `mcp__*` family below — and are tracked separately.

The engine adds a monitor-only lexical tripwire at lane end (`worker.ts::recordEgressSuspects`).
It scans the completed leg's Claude stream-json log for Bash tool calls whose executable matches
`worker.egressSuspectCommands`, then writes deduplicated `egress-suspect` events through the
ordinary events ledger (`worker.test.ts`: "#304 wiring: a completed lane records one
egress-suspect event through the existing state path").

Detection is post-hoc and fail-safe in the allow direction: it never denies a command, holds a
lane, adds `needs-human`, or changes the worker outcome; a scan or event-write failure is logged
without becoming a gate (`worker.test.ts`: "#304 fail-safe: an egress event write failure is
logged but cannot change a completed lane's outcome"). This is a
**tripwire, not containment** — it can catch naive or accidental exfiltration and leave an audit
trail, but a deliberate adversary can trivially evade lexical executable matching (an interpreter
one-liner, DNS exfiltration).

### Loopback targets: tagged, never excluded

A hit whose targets are all loopback is tagged, not excluded: it is still scanned, deduplicated
against the same per-leg cap (`MAX_EGRESS_SUSPECTS_PER_LEG`), and journalled with full evidence
(`worker.ts::classifyEgressTarget`; `worker.test.ts`: "scanEgressSuspects (#387): a loopback hit
carries target:'loopback' in the payload; a public hit's payload is unchanged (no field)"). See
[Design derivations](../design/security-egress-derivations-2026-08.md) for the motivating
observation.

It carries `target: "loopback"` in the `egress-suspect` payload, so the round artifact and
harvest facts (`round-artifact.ts`, `harvest.ts`) mark it while the prominent lines stay the
public hits.

Classification (`worker.ts::classifyEgressTarget`) matches only inside a `scheme://host` URL;
see `worker.test.ts`: "classifyEgressTarget (#387): loopback URL matrix — localhost, 127/8, ::1
tag; public host, public IP literal, and lookalikes do not" for the exact host forms covered and
its non-matches.

Absence of the tag is the fail-closed default — every ambiguity (a mixed loopback/public
snippet, an unparseable authority, no URL at all, a schemeless host) is left untagged at full
prominence, never the reverse: a missed loopback URL only restores ordinary tripwire behavior for
a benign hit, while the opposite error would downgrade a real one.

Classification reads the full observed text, not the 200-character evidence snippet, so a public
URL truncated out of the recorded evidence cannot be tagged loopback (`worker.test.ts`:
"scanEgressSuspects (#387): classification reads the FULL text, not the 200-char snippet … a
public URL truncated out of the evidence can never leave the hit tagged loopback").

Loopback is not "safe" in general — a local port can be a proxy onward — which is why this is a
prominence marker on a retained record, never an exclusion.

## Peripheral network egress: WebSearch/WebFetch, detected not pinned

Three role sessions — `architect`, `po-align`, `po-triage` — are granted the CLI's built-in
`WebSearch`/`WebFetch` tools via `webAccess.enabled` (default `true`; a config key can disable
it). This is a bounded widening: exactly two named, read-only tools, no credential into any
project system, and every call is journalled (see Audit below). See
[Design derivations](../design/security-egress-derivations-2026-08.md) for the rejected
domain-allowlist and MCP-delivery alternatives.

**Grant, per-role, named exports.** `peripheral.ts`'s `ARCHITECT_ALLOWED_TOOLS`/
`PO_ALIGN_ALLOWED_TOOLS`/`PO_TRIAGE_ALLOWED_TOOLS` each widen the base `ROLE_ALLOWED_TOOLS`/
`PO_ALLOWED_TOOLS` with `WebSearch,WebFetch`, the same pattern `CONFIRM_ALLOWED_TOOLS` already
established. `cfg.webAccess.enabled` is read at each role's OWN call site (`architect.ts`,
`align.ts`'s po-align/po-triage sessions), never inside `peripheral.ts` itself.

`po-pool` (align.ts's third `PO_ALLOWED_TOOLS` caller) stays on the ungranted base
unconditionally — it renders a distinct prompt (`po-pool.md`), never `po.md`.

**The review family never gets this grant.** `verification-plan-reviewer`,
`verification-plan-drafter`, `verification-plan-reviewer-confirm`, and every gate②
`engine-agent` review session never reference `cfg.webAccess` — no call site threads it in. That
is narrower than "offline": only gate②'s review-session mode (`reviewCwd`, see [Review session
mode](review-session-mode.md#review-session-mode-closed-mcpsettings-surface-forced-hard-guard))
actually closes the MCP/settings surface (`--strict-mcp-config`/`--setting-sources ""`).

The verification-plan family runs the ordinary unsealed `RoleRunner` path instead, so an ambient
host MCP server inherited from settings sources is not excluded by this grant's absence. The
audit scanner below can flag an `mcp__*` tool-call ATTEMPT there (same evidence-not-execution
limit as everywhere else in this page), but not the underlying network reach an MCP server
process itself performs, and not every inherited schema's semantics.

Gate②'s review-session mode also refuses a caller-supplied `allowedTools` outright (thrown, not
silently accepted). A gate whose conclusions could drift run to run over a live web result is not
an inspectable gate — recorded as a deliberate reproducibility property.

**The exception, stated exactly (`reviewer.agent.runner: codex-exec`).** An operator can select a
locally spawned `codex exec` process as the engine-agent review session's runner — **off by
default**. For a remote-provider CLI, "offline by construction" cannot mean a blanket network
denial, so the adjudicated claim for this runner is stated here rather than inherited:

- **No model-invoked egress beyond provider transport.** The session is pinned to `--sandbox
  read-only` (network-restricted for model-invoked commands per its own permission profile),
  `-c tools.web_search=false`, and `-c mcp_servers={}` (highest-precedence: no MCP server loads
  from any config source, including a producer-authored `.codex/config.toml`), plus
  `--ignore-user-config` (the operator's own `$CODEX_HOME/config.toml`, and therefore its hooks,
  never load) and `--ignore-rules`.
- **Stdin, an argv vector, and a hard timeout.** The prompt reaches the CLI on stdin from a file;
  the module spawns an argv vector, never a shell. The wall-clock session timeout terminates the
  whole process group.
- **No producer-writable project instructions, either.** The session pins
  `-c project_doc_max_bytes=0`, disabling codex-cli's own project-instruction discovery —
  without it, the reviewed tree's root `AGENTS.md`/`AGENTS.override.md` would load as standing
  instructions even under `--ignore-user-config`/`--ignore-rules` (those seal config.toml and
  exec-policy `.rules`, not project docs). The review task and doctrine remain engine-supplied.
- **Recorded blind spot 1 — execution.** `--sandbox read-only` blocks *writes*, not *execution*: a
  shell-capable agent under it can still run producer-controlled code from the materialized
  tree. This is not equivalent to the Claude runner's Read/Grep/Glob-only, no-`Bash` profile.
- **Recorded blind spot 2 — host-wide reads, including your credentials.** The same sandbox does
  not confine the read scope (`-C <treeDir>` sets the working directory, not a containment root):
  a prompt-injected review session can read any file the engine's own user can read, including
  `~/.codex/auth.json`, `~/.config/gh/hosts.yml`, and SSH private keys, and return their contents
  through provider-visible output (measurement: [Design
  derivations](../design/security-egress-derivations-2026-08.md)).
- **The operator directive this earns.** Treat enabling this runner as granting the reviewed
  code's author a read of your machine's user-readable files if they can steer the review
  session.
- **Recorded blind spot 3 — the inherited environment.** The session's environment is the
  engine's own, minus a denylist: `codexSessionEnv`'s per-key predicate `isStrippedEnvKey`
  strips well-known credential families and a generic secret-shaped-name sweep, keeping only an
  explicit provider-transport keep-set (`codex-exec.test.ts`: "isStrippedEnvKey: the well-known
  credential FAMILIES … are dropped"; "the keep-set WINS over the sweep").
- **That list cannot be exhaustive.** The rest of the environment is inherited, and dumping it
  costs a steered session one `env` (an allowlist was considered and rejected — see [Design
  derivations](../design/security-egress-derivations-2026-08.md)). An operator who runs the
  engine from a shell carrying secrets should assume a steered review session can read them.
- **The mitigations are partial, and named as such.** `codexSessionEnv` also redirects
  `GH_CONFIG_DIR` at an empty per-session directory and pins
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to `/dev/null` with `GIT_TERMINAL_PROMPT=0`. Those
  remove ambient *handles*; they do not stop a *read* of the underlying files, which stay on disk
  and readable. Filesystem confinement would close blind spot 2 and is deliberately not shipped
  (trusted-repos posture; the marginal-complexity principle).
- **The gaps are on the durable record.** Blind spots 1 and 2 are emitted at every codex-exec
  spawn as named `gaps` entries in `engine-review-containment-gap`
  (`model-invoked-shell-execution`, `host-wide-filesystem-reads`). That pre-spawn write is
  load-bearing: if it cannot be written, the session is not spawned and the review degrades to
  `unavailable` rather than running unrecorded.
- **Unchanged either way.** The default runner is `claude`, which has no `Bash` at all and is
  guard-confined to the materialized tree. Gate②'s own safety properties are runner-independent:
  blocking stays engine-derived over live PR data, output goes through the same element-wise
  validation for both runners, and an unidentifiable session model maps to `unavailable` rather
  than a verdict.

**Detected, not pinned — the operator's own settings can still silently strip the grant.**
Sealing every peripheral session with `--strict-mcp-config`/`--setting-sources ""` is not viable
here: it would also stop loading the target repo's own `CLAUDE.md` (see [Ambient repo context:
record, don't seal](ambient-repo-context.md#ambient-repo-context-record-dont-seal)), a
deliberately open channel that must not be sealed as a side effect.

See [Design derivations](../design/security-egress-derivations-2026-08.md) for the rejected
pinning approach. Instead, the design uses lightweight startup detection, not containment.

`cli.ts::checkWebAccessSettingsDenial` — called from the same best-effort startup pass as
`normalizeUnplacedBoardItems` — reads ONLY the operator's user-level settings
(`$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json`; never project/local settings)
and, when `webAccess.enabled` is true and `permissions.deny` names `WebSearch`/`WebFetch` (bare,
or a `Tool(...)`-qualified prefix), emits one warning log line plus one durable
`web-access-denied-by-operator-settings` state event.

This is exactly the failure mode a live measurement hit: a granted session's own reported tool
list simply omits the denied tool, with zero permission-denial signal. Detection only: it never
blocks startup, never spawns a probe session, and never mutates the operator's settings. The
prompts' first-class abstention wording (`po.md`/`architect.md`) is the session-side complement
this fallback depends on: a session whose tool turned out silently absent is expected to report
that it could not verify something externally, rather than guess.

**Audit: the SAME scanner, not a second one.** `worker.ts`'s `scanEgressSuspects` — the function
the Bash tripwire above already calls — also recognizes `WebFetch`/`WebSearch` `tool_use` blocks
directly from the structured stream-json transcript, unconditionally (unlike Bash, these two tool
names ARE the entire engine-granted peripheral-egress channel), and by that same unconditional
branch, `Agent`/`Task` `tool_use` blocks and any `mcp__*` tool call too.

This flagging is deliberately **content-driven, not role-gated**: `--allowedTools`/
`--disallowedTools` is a noise-reduction permission layer, not a schema removal (see [Worker
denylist vs. peripheral allowlist](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)).

So a session without the grant — a worker leg, or a peripheral role the grant doesn't cover —
can still EMIT a `WebFetch`/`WebSearch` tool_use block; the CLI's own permission layer denies it
at the paired `tool_result`, which this scanner does not read. A hit therefore records an
attempt, never proof of execution. `RoleRunner.run()` calls this scanner on every session's own
completed jsonl; `round-artifact.ts`'s existing assembler needs no changes to surface either
kind.
