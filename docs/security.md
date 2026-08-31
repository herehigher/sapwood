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

The worker that writes code can never approve its own review or merge its own PR. This is
enforced structurally, not by asking the model nicely:

| Separation | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| No self-merge/approve via Bash | Every GitHub merge/approve/ready/release/label/project/issue-governance/lifecycle command — and the mutating `gh api`/GraphQL equivalents — is blocked before it runs, including behind exec-prefixes; opaque constructs (`eval`, `sh -c`, an interpreter's `-e`/`-c`, process substitution) are blocked outright, fail-closed, rather than inspected. | `guard.ts::guardDecision` (`scanGhOverreach`, `checkOpaque`) | `guard.test.ts` |
| Merge is never a worker action | Only the conductor's merge driver calls the merge API — the worker's own session path never does, even if the guard were bypassed. | `merge-driver.ts::driveOne` (sole caller of `IForge.mergePR`) | `merge-driver.test.ts` |
| Fail-closed on error | Malformed input or any exception while deciding denies — never a silent allow. | `guard-hook.ts::hookResponse` | `guard.test.ts` |

**Residual allow surface:** assignees, `--title`/`--body` edits, and the native
`--add/remove-blocked-by`/`--add/remove-blocking` relations stay allowed — no sapwood gate
reads those relations. Issue/PR comments also stay allowed when the command names no protected
REST path (`guard.ts::checkGhApi`) — the worker's refuse/hand-back channel. A no-PR escalation
does not depend on a human reading that comment: the engine re-surfaces the worker's own
final-message text (already parsed, never a new capability) as the `reason` on the escalation
event and its `needs-human` comment — a READ-side addition, not a new grant.

**Single-identity limitation for engine-agent review.** The engine-agent reviewer has no
GitHub credentials — the engine posts the audit comment and merges under one token identity,
with no separate account proving independence. Instead, producer≠reviewer is enforced at the
process/session boundary: a different-model, read-only, closed session judges; deterministic
engine code alone writes GitHub state. The audit trail — reviewed head + diff, run id, reviewer
identity, spend (never read as $0), prompt hash, tree-manifest hash — is recorded before any
merge/FIXABLE outcome: inspectable, not two principals.

**Single-identity limitation — merger (#1165, adjudicated 2026-08-31).** The same stance covers
the merge itself: producer ≠ merger rests on capability absence (`worker.credentialTier: L1`),
the guard, and the single `mergePR` call path — not on a second GitHub principal, so GitHub's
`mergedBy` shows the operator for engine and human merges alike. Platform facts established by
probe (commands and outputs on #1165), for anyone revisiting this: a GitHub App installation
token cannot call REST `GET /user` (GraphQL `viewer { login }` answers for user and
installation tokens alike — PR #1217 moves the engine's identity read onto it); App-authored
comments carry `author_association: NONE`; a **user-owned** Projects v2 board rejects item
mutations from an installation token under every grantable permission, so an App's
installation token cannot drive this engine's board writes; and without the Workflows permission GitHub refuses an App push creating a
branch whose workflow files differ from the default-branch head. The pre-designed upgrade
path — if GitHub-native merger attribution or independently revocable merge authority ever
becomes a requirement — is the suspended `sapwood-runner` App plus a merge-only token overlay
on the single `gh pr merge` call; nothing in the engine assumes it exists.

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

A live probe found an ambient, user-scope MCP server tool outside the worker's allowlist still
callable, and the inherited MCP surface included write/exec-class tools (filesystem
write/edit/move, Drive file creation, the full Playwright set, `codex`) — none of which the
guard hook's Bash/file-tool matcher mediates. Inherited MCP tools arrive **deferred, not in the
session's init inventory**, so a prompt or scanner reading the init tool list cannot conclude no
MCP tools are available; `--allowedTools` does not gate an inherited MCP tool either.

**Capability/context decision rule.** Within the trusted-repos threat model, input-side
prompt-injection hardening neither drives nor vetoes capability or context choices: prompt
scope is governed by noise, size, and determinism; capability by whether its effects are
enforceable at the action boundary — the same rule that governs engine-injected context and
retrieval design. This is why the zero-`gh` peripheral design and this section's
host-delegated rule were both decided by enforceability, not input trust; untrusted-repo
support revisits input-side hardening as its own milestone decision, not a standing constraint
here.

**Peripheral vs. producer split.** A peripheral session's action boundary is the CLI's own tool
grant (no `Bash`, no write tool) — genuinely enforceable, so capability is withheld there. A
producer leg's boundary differs in kind: the guard mediates Bash/file-tool calls but not
`mcp__*` calls at all (see "What stays engine-owned" below), so in-engine capability management
for the inherited MCP surface was never enforceable — this section applies that rule honestly,
choosing real enforcement points (write-path denial, branch protection) over an unenforceable
config knob.

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
- **Branch protection is the mandatory platform backstop.** Producer legs inherit the full host
  tool surface, so sapwood does not claim the engine alone prevents an inherited tool writing
  outside the reviewed PR path — a protected default branch (no direct pushes, required
  reviews/checks) is mandatory. Presence is detected, not just documented:
  `branch-protection-warning.ts::createBranchProtectionDetector` warns naming both operator
  exits **only when positively verified unprotected**; an inconclusive read never fires it, and
  the warning never enforces the backstop it names. [OpenSSF Scorecard](../.github/workflows/scorecard.yml)
  gives this platform posture an external, third-party-readable attestation — results at
  https://scorecard.dev/viewer/?uri=github.com/herehigher/sapwood.
- **(b′) server-granularity MCP deny vs. `allowManagedPermissionRulesOnly`.** The producer-leg
  server-granularity MCP deny lands in `--disallowedTools`; a target repo whose managed
  settings set `allowManagedPermissionRulesOnly: true` causes the CLI to discard every
  CLI-argument permission rule, including this deny. The ruling is disclose + detect-and-WARN,
  not silent acceptance — see the [managed-settings exception](security/role-sessions.md#managed-settings-allowmanagedpermissionrulesonly-exception).

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
comment, or doc may assert tool-inventory completeness about a producer leg's session — banned
phrases: "no tool of yours", "no way other than", "there is no such tool", "structural" (meaning
*cannot reach X*). State the engine-enforced fact instead: forge writes are applied by
deterministic engine code from validated structured output, never the session itself. One
exception: a sealed gate② session's `--strict-mcp-config`/`--setting-sources ""` seal makes
"read-only" truthfully assertable there.


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
- **The raw event feed is verbatim by contract, not scrubbed.** `/api/events` serves ledger
  events as written — by design including `egress-suspect` snippets and raw error text (see
  [egress](security/egress.md#worker-network-egress-bash-channel-containment-available-as-a-hardening-profile)) — since forensic value depends on it staying unredacted. The
  *served config* surface differs: already allowlisted (`CONFIG_ALLOWLIST`, `read-model.ts`),
  so a new key can't silently start serving. No public export of a live feed exists; the only
  public surface is the curated recorded-run demo fixture under `?demo`, hand-vetted, not a
  redaction of live data.


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
- `.github/CODEOWNERS` — the guard does **not** path-deny this file; its controls are
  process-level instead: `escalation.instructionPaths` (`sapwood.config.yaml`) labels any PR
  touching it `sapwood:human-merge-only`, so the conductor never merges it, and the file owns
  itself, so a change to it needs the repo owner's review.

The guard enforces this as a write-path denial (both for the `Write`/`Edit` tools and
for `Bash` redirection/`tee`/`sed -i`/`git mv`/etc. against these paths, checked
position-independently so a wrapper can't hide the write) — but the human-merge-only
rule is also a process rule: even a PR that touches these files and somehow passes CI
and review is not something the conductor should be configured to auto-merge.
<!-- sapwood:skill:human-merge-only-paths:end -->

### The protected live config and shipped starter are separate

The path-based denial protects this repo's root `sapwood.config.yaml` — the config the
autonomous loop actually runs from (`sapwood run`, no `--config`; see [configuration.md "Two
config files"](guide/configuration.md#two-config-files)) — so its PR history is the audit trail
of the governing values, and changing it stays human-merge-only through the guard.

`sapwood init`'s starter template (`sapwood.config.example.yaml`, `init.ts::sampleConfig`) sits
on the default `escalation.instructionPaths` surface and is separately guard-protected
(`guard.ts::protectedPathLabel`), denying the same write vectors — so a worker cannot weaken
its default `merge.mode: produce-pr-and-stop` pin. Not covered: `checkControlSentinelArg`'s
literal-argument scan (`.sapwood/`-only), so a script taking either config path as its own CLI
argument, or hardcoding it, is outside the guard — the residual "Sentinel isolation boundary"
documents below.

The consequence for the protected root config: **a worker cannot land a change to its
comments — even a purely editorial one carrying no security meaning at all.** The guard
denies the write (`BLOCK [write-path] sapwood.config.* (engine/guard config) is
human-merge-only`) without inspecting whether the edit touches `guard.mode` or a `#`
comment, which is the correct fail-closed behaviour: an intent-aware exception is exactly
the seam a worker could talk its way through.

A deliberate trade: an issue needing the protected root YAML changed has a **human-applied step
no worker can discharge**. A human-merge-only path changes only via a **direct PR edit a human
reviews and merges** — never an artifact a worker hands off, since the guard binds only
engine-spawned sessions, not a human's editor. Such an issue carves the work into a `##
Human-owned remainder (protected paths — not dispatched)` section (or belongs to a human
directly, if the edit is a prerequisite for everything else); until landed, the change lives on
the issue's remainder section, not the tree.

**Resolved at issue-authoring time, not just caught at gate⓪.** `po.md` (`align` and
`triage` modes) and `po-decompose.md` now carry the same protected-path check
`verification-plan-reviewer.md`/`verification-plan-drafter.md` apply, at the point an issue or
`ready` child is first drafted — resolving it into a carved-out remainder section immediately
instead of costing a gate⓪ bounce and repair round-trip. The gate⓪ check stays as the backstop
for whatever this upstream pass misses; it narrows how often that backstop fires, it does not
replace it.

### The `sapwood:human-merge-only` label

The same phrase now also names a **label**, deliberately — one fact, one term. Where the
list above is the *static* set of paths a human must merge, `sapwood:human-merge-only` is
the *runtime verdict* that a particular PR must be merged by a human. Today the
[instruction-path escalation](security/instruction-path-escalation.md) rule is its only
writer: a PR that edits the reviewer instruction graph is not broken and nothing is stuck, but
its merge decision is not the loop's to take.

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
keep an engine PR off those paths (gate⓪ AC screening, the `guard.ts` write-path block above,
and [instruction-path escalation](security/instruction-path-escalation.md)); a fourth scanner
would be redundant machinery. The label carries the **verdict**, not a new detection.

### The review-doctrine file is trusted prompt input

The review-doctrine file (`doctrine.file`, default `docs/REVIEW-DOCTRINE.md`) is
user-editable repo prose and is **not** guard-protected — its content is injected into the
worker brief, the fix leg, the architect pass, and the engine-agent reviewer, so it can
influence what those sessions do.
The hosted gate② review-trigger comment no longer carries any doctrine text; a hosted bot's own
standing review guidance lives in its own instruction file instead (`docs/guide/configuration.md#hosted-bot-review-guidelines`).
It sits inside this page's trusted-repo assumption: doctrine content is trusted
like the rest of the repo's prose, and changes to it deserve the same review scrutiny as
`reviewer.*`/`merge.*` config. It is deliberately not sanitized — prose written *for* LLM
readers, with gate② staying semantic, not a rules engine. The shipped generic core
(`engine/prompts/doctrine-core.md`) is release-controlled, not user-editable — only the
repo-level part loaded from `doctrine.file` is trusted-repo prose.

## Human controls (three tiers)

sapwood has three independent file-sentinel controls, all living next to the engine's
state DB (`.sapwood/`), without requiring a config edit:

| Tier | Sentinel | Effect | Set / lift |
| --- | --- | --- | --- |
| Emergency stop | `.sapwood/EMERGENCY_STOP` | Strictest; takes precedence over the kill switch every tick; hard-kills running/fixing lane process groups with no drain window — in-flight WIP is lost, and killed lanes escalate to `needs-human` with their evidence preserved. | `/sapwood-stop --emergency`; `--clear-emergency` only after human review |
| Kill switch | `.sapwood/KILL_SWITCH` | Freezes all new dispatch, merges, rollback retries, and reclaim of crashed lanes; running workers get `cost.drainWindowSec` to hand off, then a hard process-tree kill. | `/sapwood-stop` (set) / `--lift`, or touch/remove the file |
| Pause | `.sapwood/PAUSE` | Freezes new dispatch and a fresh fix leg's admission — an already-running worker or fix leg finishes normally, a `driving` lane already at MERGE/WAIT_REVIEW still resolves, and a lane blocked only on a fresh fix leg stays `driving` until PAUSE lifts. | `/sapwood-stop --pause` / `--resume` |

**Precedence:** emergency stop overrides the kill switch, and either strict tier subsumes
pause's dispatch restriction.

**Interaction with `--until-idle`:** `driver.ts::isIdle` requires zero active workers among
its other conditions — an active worker is a `running`, `driving`, or `fixing` lane, not just a
live process. A `driving` lane blocked on a fresh fix leg by PAUSE therefore keeps the run
non-idle: `--until-idle` does not exit while such a lane exists, and removing `.sapwood/PAUSE`
lets that fix leg dispatch on the next tick.

### Sentinel isolation boundary (honest statement)

The engine's `.sapwood/` runtime root sits outside worker git worktrees as a
**permission-layer boundary** — no worker launches with `--add-dir .sapwood`, so it has no
`claude`-tool path there. Not an OS-level sandbox, so the guard adds defense-in-depth two ways.
`checkWritePath`/`checkBashWritePath` deny the write-class built-in tools (`Write`/`Edit`/
`MultiEdit`/`NotebookEdit`) and the write-command set (`tee`/`dd`/`sed`/`perl`/`cp`/`install`/
`mv`/`rm`/`git`/`touch`, plus redirections) under `.sapwood`; separately, `checkControlSentinelArg`
blocks ANY command merely naming a `.sapwood` path as a literal argument, write or not. Both
match root or descendant, via relative traversal too, case-insensitively — `.sapwood-notes/`
does not match — and root equality also closes the older `rm -rf ../../.sapwood` gap.

Three residual classes are accepted, not closed, by this rule:

- **(a) Guarded built-in tool family only.** The guard's PreToolUse matcher covers only
  `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Read`/`Grep`/`Glob`/`NotebookRead` — no
  `mcp__` pattern at all (see [Worker denylist vs. peripheral allowlist](security/role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)).
  A write/exec-class MCP server an operator's config registers can write anywhere on disk,
  `.sapwood/` included, without the guard ever being asked.
- **(b) Symlink aliasing is a lexical residual.** The guard judges the path segments a
  Bash/file-tool argument spells out after traversal-collapse; it never `realpath`s or
  `lstat`s. A symlink whose own name carries no `.sapwood` segment but resolves onto the
  runtime root — or the reverse — is judged on the argument's text, not the resolved target.
- **(c) Opaque indirection is a lexical residual.** The Bash argv walk only sees tokens it can
  parse as a bare word or a `-`-prefixed glued flag: an environment assignment glued to the
  same command line (`TARGET=.sapwood/PAUSE node writer.js`) normalizes as one segment
  (`TARGET=.sapwood`, not `.sapwood`) and never matches; a script that hardcodes the path
  inside its own source is invisible to an argv scan; or any other CLI form the walk doesn't
  reach. No machinery is added to close this class — document the residual, don't chase it
  with more.

This list is not exhaustive.

**`sapwood pause`/`stop`/`estop` are their own, separately fenced class — not the residuals
above.** These are shipped, documented CLI verbs any worker can invoke by name;
`checkStopControlVerb` recognizes the bare `sapwood` binary, `node .../cli.js`/`cli.ts`, and
`npx sapwood[@version]` — the discoverable forms this repo teaches — and blocks them. **Hiding
the command word behind an arbitrary package spec instead** — `npx file:<path>/engine`, a
scoped package, an aliased binary, or any other unfenced form (this list is not exhaustive) —
**is not fenced, an accepted residual** in the same class as (c): an accident fence, not a
hostile jail.

Until every gap above is closed, treat the isolation boundary as "a worker won't accidentally
step here, and the obvious direct/indirect vectors are blocked," not "a worker provably cannot
reach here by any means."


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

| Rule | Enforcement | Test |
| --- | --- | --- |
| Dispatch requires a reviewed plan | For any issue not labelled `verify:n/a`, dispatch requires both a verification-plan section and the `plan:approved` label; `verify:n/a` routes through the doc-gate path only when `needs-human` is absent. | `forge.ts::getReadyIssues` / `forge.test.ts` |
| `needs-human`/`blocked` veto unconditionally | Present alongside any other label, either blocks dispatch regardless. | `forge.ts::getReadyIssues` / `forge.test.ts` |
| A weak plan self-heals, bounded | The reviewer never approves a plan it authored; a distinct issues-only drafting session (not a worker lane; it never implements the issue) repairs it for at most `roles.verificationPlanReviewer.maxDraftCycles` (default 2) attempts, then escalates to `needs-human` with the full trail. | `plan-review.ts::reviewOneIssue` / `plan-review.test.ts` |
| Output is validated, not trusted | Neither the reviewer nor the drafter session holds a `Bash` grant; the engine schema-validates the output and re-checks the issue body actually carries a verification-plan section before applying `plan:approved`, retrying once then escalating on malformed/invalid output. | `plan-review.ts::validateReviewerOutput`/`validateDrafterOutput` / `plan-review.test.ts` |
| Approval is re-endorsed, not permanent | A prior round's `plan:approved` is re-checked via a lightweight, zero-forge-write-on-confirm session each time the issue re-enters the round pool, before its approval is trusted for dispatch again — a session that can't confirm or fails escalates `needs-human`, but the label itself is never removed either way. | `plan-review.ts::confirmOneIssue` / `plan-review.test.ts` |

Every attempt is externalized as issue edits/comments, so a human can inspect or intervene at
any point. Implementation dispatch still requires `plan:approved` (or adjudicated
`verify:n/a`) regardless — only the repair path became more autonomous. See
[`docs/PLAN.md`](PLAN.md#round-orchestrator) (the "gate⓪ is scoped to the round pool..."
locked decision) for the full detail.


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
  flow) [Review session mode](security/review-session-mode.md) distills.
