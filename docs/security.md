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
   `--setting-sources ""`) — the **only** sealing floor; see [Review session mode](security/review-session-mode.md#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)
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
  same stance as the [managed-settings exception](security/role-sessions.md#managed-settings-allowmanagedpermissionrulesonly-exception)
  below: no startup refusal, no label, no gate, and an inconclusive read never fires the
  warning — it never enforces the backstop it names.
- **(b′) server-granularity MCP deny vs. `allowManagedPermissionRulesOnly`.** The
  server-granularity deny for producer legs (known forge-authority/github-class and
  known write/exec/filesystem-class MCP servers appended to `WORKER_DISALLOWED_TOOLS`)
  lands
  in `--disallowedTools`. As [documented above](security/role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry),
  a target repo whose managed settings set `allowManagedPermissionRulesOnly: true` causes the
  CLI to discard every CLI-argument permission rule — including this server deny, alongside
  the rest of sapwood's `--disallowedTools` containment. The owner ruling is disclose +
  detect-and-WARN — one startup warning naming both operator
  exits, no refusal; see the [managed-settings exception section](security/role-sessions.md#managed-settings-allowmanagedpermissionrulesonly-exception)
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
  is held back too — see the [fix-loop admission gate](security/role-sessions.md#fix-loop-fixing-lane-state) above. A
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
  [Worker denylist vs. peripheral allowlist](security/role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
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


## Mechanism reference

Per-mechanism detail lives in `docs/security/` — one page per topic, moved out of this file
so each stays independently hand-verifiable. This page states the normative model; each linked
page is the mechanism reference for its topic.

| Page | What it covers |
| --- | --- |
| [`security/credential-tiers.md`](security/credential-tiers.md) | Worker credential tiers (L0/L1/L2) and the L2 enterprise posture checklist. |
| [`security/execution-profiles.md`](security/execution-profiles.md) | `host.permissionMode` and the operator-configured Bash sandbox recipe. |
| [`security/egress.md`](security/egress.md) | Worker Bash-channel network egress and peripheral `WebSearch`/`WebFetch` egress. |
| [`security/role-sessions.md`](security/role-sessions.md) | The worker denylist vs. peripheral allowlist asymmetry, and issues-only role sessions (forge MCP proxy, managed-settings exception, fix-loop lane state). |
| [`security/review-session-mode.md`](security/review-session-mode.md) | The engine-agent reviewer's closed MCP/settings surface and forced-hard guard. |
| [`security/ambient-repo-context.md`](security/ambient-repo-context.md) | What ambient repo/user context a role session legitimately absorbs, and how it's recorded. |
| [`security/instruction-path-escalation.md`](security/instruction-path-escalation.md) | Why an edit to a standing-instruction path escalates to human review. |
| [`security/cost-ceilings.md`](security/cost-ceilings.md) | The soft per-worker budget vs. the hard daily/wall-clock cost ceilings. |
| [`security/adjudication.md`](security/adjudication.md) | The AC-authority dispatch snapshot, CI execution evidence for engine-agent review, and the comment-adjudication cursor. |

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
