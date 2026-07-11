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
  `gh pr review --approve`, `gh pr ready`, `gh release`, and the mutating `gh api`/
  GraphQL equivalents. Opaque constructs a worker could hide anything inside —
  `eval`, `sh -c`, an interpreter's `-e`/`-c`, process substitution — are blocked
  outright, fail-closed, rather than inspected.
- **The merge is always executed by the conductor**, never the worker. Only
  `merge-driver.ts`'s `driveOne` calls the merge API; `tick()` (the path a worker's own
  session runs inside) never does. This holds even if the guard hook were somehow
  bypassed — it's a structural separation, not just an argv check.
- **Fail-closed on error.** The hook denies on malformed JSON, a non-object payload, a
  malformed `tool_input` for a guarded tool, or any exception thrown while deciding. A
  safety hook that can be disabled by feeding it garbage isn't one.

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

## Issues-only role sessions carry no shell (#110)

Workers are guarded by the argv-inspecting hook above. The round orchestrator's
issues-only peripheral roles — plan-reviewer, plan-drafter, PO/align+triage, harvest,
and architect — take a different, stronger approach: they hold no `Bash` tool grant at
all (`peripheral.ts`'s `ROLE_ALLOWED_TOOLS`/`PO_ALLOWED_TOOLS` are the empty string).
Each session is pure computation — its prompt never instructs a `gh` command, and it
has no shell to run one through even if it tried. Its final message ends in a
structured, sentinel-delimited output block instead. The deterministic engine
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

Because no shell exists for these sessions to reach `gh` through at all, the
pattern-layer bypass classes earlier hardening closed one glob at a time (#102's short
`-F`/`-l`/`-p` flag aliases, #108's quoted/escaped `-F` spellings) are structurally
moot for them — not closed by a better pattern, but by removing the capability the
pattern was constraining. The old deny-list entries stay in `peripheral.ts`, byte-
identical, as a regression trip-wire: a future PR that re-widens the allow-list with a
`Bash(...)` entry lands back inside those denies rather than silently reopening a
closed bypass class.

**`retro` is the one exception**, by session class rather than role name: it is
worker-class, with `Read`/git + `gh pr create` (proposals land exclusively as PRs
through the normal review gate, never a direct write) — the same broader trust level a
code-producing worker gets, because its job (reading round history, editing prompts/
docs/config) genuinely needs it. Its own hardening (beyond the dangerous verbs
`guard.ts` already blocks category-C, and `gh issue *` already denied wholesale) is
tracked separately in #111.

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
This is **not an OS-level sandbox**, so the guard (`engine/src/guard.ts`) adds
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
  backstop.
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings —
  the actual runaway-spend safety boundary, independent of any single worker. Breaching
  either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses.

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

`getReadyIssues` (`engine/src/forge.ts`) now requires, for any issue not labelled
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

## See also

- [`configuration.md`](configuration.md) — the `guard`, `reviewer`, `merge`, `cost`,
  `labels`, and `roles` config sections referenced above.
- [`PLAN.md`](PLAN.md) — the full architecture, decision log, and the v0.2 round
  orchestrator's self-feed design.
