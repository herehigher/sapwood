# Supervision

The playbook for whoever is watching a `sapwood run` session — a human, or a trusted
LLM supervisor session (see [Governance lines](#governance-lines) for what that role
means). sapwood ships **no daemon/supervisor process of its own**: `sapwood
run` is a foreground engine loop, and something outside it — a terminal, a service
manager, or an operator session — launches it, watches it, and stops it. This page is
that "something outside it"'s manual. It is procedure, not new machinery: every verb
and label named here already exists ([`status`](#supervising-a-run),
[`events`](#supervising-a-run), `park clear`, `gh`); this page is the recipe for using
them as a coherent supervision loop.

Machine-enforced facts (the guard hook, human-merge-only paths, the kill switch vs.
pause distinction, cost ceilings) live in [`docs/security.md`](security.md) and
[`docs/configuration.md`](configuration.md) — this page **points at** them and never
re-enumerates them. What a given event/park-source/escalation-bucket *means* lives in
the generated `sapwood-event-glossary` skill — this page points at that too.

## Supervising a run

Two read-only CLI verbs read the state DB directly, with no live engine session
required — the same DB a running engine is currently writing (WAL, concurrent-read
safe):

- **`sapwood status [db-path] [--json]`** — a point-in-time snapshot: active/driving
  lanes, spend vs. the daily ceiling, e-stop/kill switch/pause state, park episodes, base-CI-red.
  `--json` prints a documented, additive-only DTO (`formatVersion 1`) instead of the text
  summary — ignore fields you don't recognize rather than fail on them.
- **`sapwood events [db-path] [options]`** — the event ledger itself, id-cursor and
  kind-filterable. This is the codified monitor recipe: a poll loop no longer hand-rolls
  SQL, it calls this verb on a cadence.

**The poll-cursor recipe.** Keep `nextSinceId` from the previous call and feed it back
as `--since-id` on the next one — every page (including an empty one) advances the
cursor to the ledger's current tail, so a poller can never get stuck rescanning the same
range. **Bootstrap the cursor with `--tail 0`** instead of a raw `select max(id)`
against the sqlite file — a monitor's most common need is "stream from NOW," and
`--tail 0 --json` returns an empty `events` array plus the ledger's CURRENT head as
`nextSinceId`, with no history read at all:

```bash
sapwood events --tail 0 --json              # bootstrap: learn "now" with no history read
# -> read .nextSinceId from the response, e.g. 482
sapwood events --since-id 482 --json        # first poll: only what's new since "now"
```

Need full history instead of "from now"? `--since-id 0 --json` still walks the whole
ledger from the start exactly as before — `--tail 0` only replaces the "where do I
start watching" bootstrap, it does not remove `--since-id 0`'s full-history mode.
`--tail N` also answers "show me the last N events" directly for a one-off look (same
`--kind`/`--exclude-kind`/`--issue` filters as `--since-id`, applied before the N-newest
cut) — but `--tail` and `--since-id` are one cursor semantics, not two that combine:
passing both is a rejected argument (exit 1), never an invented precedence between "the
N newest" and "everything after id X".

Narrow a poll to what you actually need to watch with `--kind`/`--exclude-kind`
(repeatable, mutually exclusive — combining them is a rejected argument, not an invented
precedence) and page with `--limit` (hard-capped; an over-cap request is rejected, never
silently clamped). A busy writer past the finite lock timeout is reported as a clear
"busy, try again" failure — poll again, never treat it as "nothing happened." Reading
through a read-only filesystem snapshot (no live WAL visibility) is reported via
`snapshot.mode: "immutable-fallback"` under `--json` — know which kind of read you're
getting before trusting an empty page as "truly nothing new."

`status`/`events` are **DB-only by design** — neither makes a live GitHub call. The
gated/human-merge/needs-human queues live on GitHub and are read from there; see
[Queue queries](#queue-queries) below — that split is not incidental, see the next
section for the general rule it follows.

### Where facts live: GitHub vs the state DB

GitHub (issues, the Project board, PRs) holds cross-actor **process** truth for anything
a human or another agent must read in order to act: what's in flight, by whom, the
needs-human/gated/hold queues above, and adjudications recorded in issue bodies — labels
are the work queue, review verdicts land as PR reviews. For that class of fact — a
human-decision queue, an adjudication — GitHub is authoritative on a conflict, never the
DB.

The sqlite state DB, by contrast, is this ONE engine instance's runtime **belief** — the
event ledger, lane rows, spend ledger, heartbeats, pids, worktree paths — facts
meaningful only on the machine the engine actually runs on. `status`/`events` are
projections of that belief, never an independent read of reality: their job is to
surface a belief-vs-reality gap to the operator (a dead pid a lane still calls
"running", a stale heartbeat, a schema this build no longer understands), never to
arbitrate it — arbitration is a human's or another agent's call, made through GitHub,
the same as every other decision this page routes there.

Two corollaries follow, and they are not symmetric. Machine-local facts (a pid, a
worktree path) never get written to GitHub at all — they mean nothing off the machine
that produced them. The DB→GitHub mirrors that DO exist (the lane-state-label pattern:
a `driving`/`fixing` lane belief projects to a PR visibility label) are meant to heal on
drift, but at least one has a documented, bounded blind spot rather than a full heal
path: a crash in the apply window leaves the lane permanently unlabelled — nothing
retries, because the belief already says "labelled" (`lane-state-label.ts`'s own header
doc, "THE RESIDUAL BLIND SPOT"). A mirrored label's **absence is therefore never proof a
lane is inactive** — that is exactly backwards from the authority rule above: for lane
activity, the DB belief (read via `status`) is the honest check, GitHub's label is only
ever a best-effort, occasionally-lagging cache of it.

### Detached operation

A `sapwood run` you intend to leave running past your own shell session must be
**detached from the launching session's lifetime**, never left in a terminal's
foreground or handed to a session-managed background task. Session-managed background
tasks carry a runtime ceiling; on expiry the harness TERMs the whole process group. The
engine reads that correctly — two signals are exactly the freeze-drain-then-hard-exit
sequence [Stop ritual](#stop-ritual)'s drain-semantics bullet already documents — but an
operator who expected a supervised stop instead gets an unattended one: an un-drained
hard-exit that kills in-flight lanes mid-flight. The engine does nothing wrong in this
case; a launch method that isn't actually detached ties the engine to a clock that will
eventually run out.

Verified working pattern: `nohup`, backgrounded, and `disown`'d out of the launching
shell's job table — this defeats `SIGHUP`-on-shell-exit and any other signal the shell
would otherwise deliver to its own job, nothing more (the pgid/session/cgroup hierarchy
below says precisely what it does and doesn't cover). `run`'s data dir
(`data/sapwood.sqlite`, `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`, sessions, worktree roots) resolves
**relative to the process's cwd, not to `--config`'s directory** — `run --help`
names the DB, `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`, sessions, and worktree roots
(`docs/configuration.md`'s loader-resolution note carries the full rule) — so `cd` into
the deployment checkout FIRST, or the detached process silently
takes root wherever the launching shell happened to be sitting. Use an absolute `node`
here too (the lazy-load gotcha below applies to this line exactly as much as a script).
Create the shell redirect's log directory before backgrounding, too: the shell performs
the `>>` open BEFORE it runs `nohup` at all (not something `nohup` itself does), so a
missing directory fails the launch right there — loudly, at the prompt; both bash and
zsh report the failed redirect (`No such file or directory` / `no such file or
directory`) and never start the background job — no engine, no lock, nothing to `ps -p`
later. `run`'s OWN structured log (`cfg.logging.path`) creates its own directory lazily
once the engine itself starts (`logger.ts`) — a different file, created too late to help
this redirect, which is why `mkdir -p` comes first below:

```bash
DEPLOY=/absolute/path/to/deployment-checkout   # the repo root `data/` must resolve under
NODE=/absolute/path/to/node                    # from `node -e 'console.log(process.execPath)'` — see the node gotcha below
mkdir -p "$DEPLOY"/data/logs
cd "$DEPLOY" && nohup "$NODE" "$DEPLOY"/engine/dist/cli.js run --config <cfg-path> \
  >> "$DEPLOY"/data/logs/detached.log 2>&1 &
disown
```

The criterion that actually matters here is whether your launcher's job control gives
the backgrounded process its own process group at all — not whether the shell is
"interactive" in the abstract. An ordinary interactive shell's job control does this by
default; a launcher that doesn't can silently break detachment: an automation
harness's shell running `nohup ... & disown` without job control ever assigning the
child a group of its own leaves it inheriting the launcher's process group, so a later
group-directed signal from that same launching environment can kill the "detached"
engine collaterally.

Even a `nohup`+`disown` that DOES land the child in its own process group only clears
the first of a three-layer hierarchy, and each layer defeats a strictly smaller class of
launcher-side cleanup than the next — say precisely which, rather than implying any one
of them delivers more than it does:

1. **Own process group** (plain `nohup`+`disown`, job control working as intended)
   defeats `SIGHUP`-on-shell-exit and any signal the launching shell delivers to "its own
   job." It does **not** defeat a launcher that reaps by POSIX session id, by cgroup, or
   by the whole process tree instead of by a group-directed signal.
2. **Own session** (`setsid`/the double-fork below) additionally defeats
   session-id-based reaping — a controlling terminal's process dying and cascading
   through its session, for instance. It does **not** escape a **cgroup** the child was
   forked inside, or a container/job whose lifetime is enforced by killing that cgroup or
   its whole process tree wholesale: a CI runner that cleans up its job's cgroup at
   job-end kills the pgid-only form and the setsid form identically — neither is a
   supervisor.
3. **A supervisor living outside the container/cgroup/session entirely** — a system
   service manager (systemd/launchd), a separate always-up host, or an explicit "remove
   this pid from cleanup scope" step in the harness — is the only guarantee stronger than
   layer 2. Layers 1–2 protect the engine from its OWN launching session signaling it;
   neither protects it from the launching ENVIRONMENT being torn down wholesale.

Give the engine layer 2 whenever you can't be certain your launcher's job control
assigns a fresh pgid — most automation harnesses, CI runners, and agent-session shells —
since it strictly subsumes layer 1 at no extra cost, while being honest that it's still
not layer 3: `setsid <cmd>` is the one-line form where the OS ships it, but macOS does
not, so the portable equivalent is a small double-fork. Pass the paths in as environment
variables, not string-interpolated into the Python source (a quoted heredoc treats
`$DEPLOY` as literal text, not a shell expansion — silent `FileNotFoundError` in a
process whose parent has already exited "successfully"), and `chdir` explicitly before
`execv` rather than trusting the double-forked child inherited the right cwd:

```bash
export DEPLOY NODE
python3 - <<'PY'
import os

deploy = os.environ["DEPLOY"]
node = os.environ["NODE"]

if os.fork(): raise SystemExit(0)      # orphan the child from this shell
os.setsid()                            # new session + process group of its own
if os.fork(): raise SystemExit(0)      # never reacquire a controlling terminal

os.chdir(deploy)                       # `run`'s data dir is cwd-relative — root it here explicitly
log_dir = os.path.join(deploy, "data", "logs")
os.makedirs(log_dir, exist_ok=True)
log = open(os.path.join(log_dir, "detached.log"), "a")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execv(node, [node, os.path.join(deploy, "engine", "dist", "cli.js"),
                 "run", "--config", "<cfg-path>"])
PY
```

Then confirm it's actually alive the way [Batch open ritual](#batch-open-ritual)'s
Single-instance check already tells you to, not by trusting your own memory of having
started it — same check for either launch form above: read
`"$DEPLOY"/data/sapwood.lock`'s recorded `pid` and `ps -p <pid>` it yourself — the lock
is authoritative, a shell job you believe is running is not. Check it by the SAME
absolute path you launched under, never a bare `data/sapwood.lock` typed from whatever
directory the checking shell happens to be in — the lock, like the DB below, is
cwd-relative by default and resolves to nothing from anywhere else.

Three script-environment gotchas apply to any detached script,
not just the launch line above:

- **Hard-code the absolute `node` binary — a bare `node` is not safe outside an
  interactive shell.** Ordinary nvm setups leave `node` a real binary on an exported
  `PATH`, which a child process inherits fine — but some nvm setups (lazy-load
  wrappers, used to avoid nvm's per-shell startup cost) make `node` a shell *function*
  instead, resolved only inside an interactive shell that has sourced nvm's init code.
  A detached or non-interactive process (a `nohup`'d launch, a cron job, a
  service-manager unit) never sources that init code, so under a lazy-load setup
  specifically, `node` resolves to nothing and every poll or launch built on it fails.
  Resolve the real binary once, interactively, and paste the absolute path into the
  detached script regardless of which kind of nvm setup you're on — it costs nothing
  when `node` was already a real binary, and it's the only fix when it wasn't:
  ```bash
  node -e 'console.log(process.execPath)'
  # -> e.g. /Users/you/.nvm/versions/node/v20.x.x/bin/node — hard-code this, not `node`
  ```
- **zsh does not word-split an unquoted variable.** `CLI="node cli.js"` followed by
  `$CLI events` does not run `node` with args `cli.js events` — it tries to run the
  single, nonexistent command `"node cli.js"` and fails **loudly**: `command not found`,
  exit 127, same as any other typo — this is not a silent failure by itself. Build the
  command as an array (`CLI=(node cli.js)`, invoked `${CLI[@]}`) or force the split
  explicitly (`${=CLI}`) — never rely on an unquoted string variable splitting the way
  it would in bash. What actually makes this silent isn't zsh: a monitor
  script that redirects its own stderr to `/dev/null` swallows the loud 127 and
  turns a visible typo into a dead poller nobody notices —
  the general lesson, independent of this specific splitting bug, is don't blind an
  unattended script's own stderr.
- **The state DB path defaults to `data/sapwood.sqlite`, resolved against the
  invoking process's cwd — pass it explicitly, same as the deploy-dir rule above.**
  `status`/`events`/`park clear` all fall back to this cwd-relative default when no
  positional `db-path` is given, and `--config` does **not** change that resolution
  (`docs/configuration.md`'s loader-resolution note: logging/prompt/goal/doctrine paths
  go config-file-relative, but the DB, `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`, sessions, and worktree
  roots stay cwd-relative regardless). A detached poller's cwd is arbitrary — polling
  from anywhere but the deployment checkout silently prints `sapwood events: no state DB
  at data/sapwood.sqlite — engine has never run` and **exits 0**, indistinguishable from
  "nothing new yet" unless you're reading the message itself. Pass the DB positionally,
  as an absolute path, on every `status`/`events` call a detached script makes.

**Canonical detached monitor loop.** The [poll-cursor recipe](#supervising-a-run) above,
run from a detached script with all three gotchas fixed and both `--config` and the DB
path passed explicitly on every read (a detached poller has no interactive session, and
no reliable cwd, to infer either from — see [Config provenance](#batch-open-ritual)).
Every read also validates its own response and keeps the OLD cursor on any failure
(command error, empty output, unparseable JSON, a missing `nextSinceId`) rather than
letting a single transient failure — the documented busy-timeout case included — corrupt
`CURSOR` into an empty string that would make every subsequent `--since-id ""` fail
forever:

```bash
NODE=/absolute/path/to/node          # from `node -e 'console.log(process.execPath)'`, resolved once
CLI=("$NODE" /absolute/path/to/engine/dist/cli.js)   # array — zsh-safe by construction
CFG=/absolute/path/to/config.yaml
DB=/absolute/path/to/deployment-checkout/data/sapwood.sqlite   # NEVER the bare default

# One node call does the validation AND the printing: line 1 of stdout is the next
# cursor, everything after is one event per line — malformed/empty input exits 1 and
# prints nothing, so a failed parse is unambiguous to the caller below.
PARSE='
const fs = require("fs");
let d;
try { d = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { process.exit(1); }
if (typeof d.nextSinceId !== "number" || !Array.isArray(d.events)) process.exit(1);
console.log(d.nextSinceId);
d.events.forEach(e => console.log(JSON.stringify(e)));
'

# bootstrap: learn "now" with no history read — retry (transient busy timeouts are
# expected) until a valid cursor comes back, rather than starting the loop on garbage.
CURSOR=""
while [ -z "$CURSOR" ]; do
  if RESP=$("${CLI[@]}" events "$DB" --config "$CFG" --tail 0 --json); then
    CURSOR=$(echo "$RESP" | "$NODE" -e "$PARSE" | head -n1)
  fi
  [ -z "$CURSOR" ] && { echo "bootstrap failed — retrying" >&2; sleep 5; }
done

while true; do
  if ! RESP=$("${CLI[@]}" events "$DB" --config "$CFG" --since-id "$CURSOR" --json); then
    echo "poll failed (busy/transient?) — keeping cursor at $CURSOR, retrying" >&2
    sleep 30
    continue
  fi
  PARSED=$(echo "$RESP" | "$NODE" -e "$PARSE")
  if [ $? -ne 0 ] || [ -z "$PARSED" ]; then
    echo "unparseable response — keeping cursor at $CURSOR, retrying" >&2
    sleep 30
    continue
  fi
  CURSOR=$(echo "$PARSED" | head -n1)
  echo "$PARSED" | tail -n +2   # the new events, one JSON object per line
  sleep 30
done
```

No jq dependency, no bare `node`/`sapwood` invocation, no unquoted-string command, no
cwd-relative DB/lock/deploy-dir default left to chance, and no single transient failure
able to corrupt the cursor — the failure shapes above are structurally excluded rather
than left to the operator to remember on every invocation. This is a recipe, not new
machinery: `run --detach` or an engine daemon mode is deliberately out of scope here
(marginal-complexity doctrine — nobody has asked for it, and a `cd`-first launch in
whichever of the two forms above matches your launcher, plus the lock-file liveness
check, already covers the verified failure modes).

## Batch open ritual

Before dispatching a batch of work (starting a new `sapwood run`, or resuming after a
gap), work through these in order:

1. **Single-instance check.** Only one `sapwood run` may hold a given data dir
   (`data/sapwood.lock`, docs/troubleshooting.md's "Single-instance lock"). Don't guess —
   either read the lock file's recorded `pid` and confirm liveness yourself
   (`ps -p <pid>`), or let `sapwood run`/`sapwood park clear` make the call: both refuse
   with the holder's pid named when a live engine already has the lock. A refusal here
   means stop and investigate, never retry-until-it-works.
2. **dist/build freshness.** The `/sapwood-run`, `/sapwood-status`, and `/sapwood-stop`
   slash commands invoke the engine's TypeScript source directly (via `tsx`) and are
   always fresh. The bare `sapwood events` / `sapwood park clear` verbs used for
   supervision have no slash-command wrapper yet and, when invoked through a built
   `dist/cli.js` (`docs/getting-started.md`'s "About the bare `sapwood` command"), can be
   running against a stale build if engine source changed since the last
   `npm --workspace engine run build`. Before trusting their output in a batch, either
   rebuild (`npm ci && npm --workspace engine run build`) or invoke them the same way the
   slash commands do (`node .../node_modules/.bin/tsx .../engine/src/cli.ts <verb>`),
   which reads source directly and sidesteps the staleness question entirely.
3. **Config provenance.** Run `sapwood status --json` and read its `config` section:
   `{available: true, provenance: <resolved path>, lanesMax, dailyBudgetUsd}` when a
   config loaded, `{available: false}` when it didn't. `provenance` names the *exact*
   file that was actually loaded (an explicit `--config` or the default probe order) —
   confirm it's the profile you intend to run under before dispatching against it,
   especially when more than one config file exists in the tree.
4. **Dry-run pool sanity.** `sapwood run --dry-run` resolves config and previews an
   **empty-lane-set candidate/upper bound** — ready count, dispatchable count (after the
   real eligibility filter), the effective per-round lane limit, and a cost preview —
   with no worker spawned and no state written. It assumes a fresh round starting from
   zero occupied lanes; it does **not** read live lane occupancy, in-flight dedup, or the
   meta-floor anti-starvation accounting, so treat it as a rough upper bound on what
   *could* dispatch, never a replay of the exact next tick (`computeDryRunPreview`'s own
   doc, `engine/src/cli.ts`; see also [Est-vs-real cost method](#est-vs-real-cost-method)
   below, which leans on this same caveat). Run it before every batch open, not just the
   first one: it catches a config that would starve dispatch (0 dispatchable) or a pool
   that's unexpectedly large/small for what you intended, before any spend happens.

## Batch close ritual

Before ending a supervision session:

1. **Queue sweep.** Run the [queue queries](#queue-queries) below and account for every
   result — a batch does not "close" with an unexplained `needs-human` or
   `human-merge-only` item sitting unmentioned. Either it's handled (a decision recorded,
   a follow-up filed) or it's explicitly carried forward, never silently dropped.
2. **Owner-ruling recovery ritual.** A ruling recorded ONLY as a comment is not evidence a
   worker will ever see — workers read the issue body only (`{{issue.body}}`, see
   [`docs/security.md`](security.md#the-comment-adjudication-cursor)), and comments
   remain audit evidence, never the contract a worker is dispatched against; the body
   remains the worker contract. Skipping this step has a real, paid-for cost: an owner's
   ruling left only in a comment can go unseen by both a later automated pass (which then
   treats the issue as still unresolved) and the worker (who faithfully implements the
   stale body) — producing real defects downstream. Any owner ruling that lands during a
   session — a scope call, a merge authorization, a policy decision — is closed out with
   all four steps below, in order, **in that same session**, before the session ends. Do
   not defer "I'll write it up later," and do not stop partway (recording the ruling
   without rewriting the body reproduces the exact trap this ritual exists to prevent):
   1. **Record the ruling** as a comment on the relevant issue/PR.
   2. **Rewrite the authoritative body** to fold the ruling in — the comment is evidence
      that a decision was made, not the decision a worker will act on.
   3. **Advance the [adjudication
      cursor](security.md#the-comment-adjudication-cursor)**
      (`<!-- sapwood:comments-adjudicated-through: <comment-id> -->`) to the ruling
      comment or later, so gate⓪ and dispatch see the body as current rather than stale.
   4. **Remove `needs-human`**, if it was applied for this reason.
3. **Tier-C probe record.** When you personally run a tier-C human-witnessed probe
   (`docs/security.md`'s `ac-evidence-tiers`), the record only reaches gate② if it lands
   in the issue **body** — a comment is an operator inbox item, not evidence
   (`docs/REVIEW-DOCTRINE.md`'s tier-C doctrine), and gate② never reads one. Same
   record/cursor sub-steps as the owner-ruling recovery ritual above (steps 1-3): fold the
   record into the body, and if you also posted it — or anything else — as a comment,
   advance the adjudication cursor past it in that SAME body edit. That edit does not
   walk straight into a rebaseline: it is a body drift the engine fails closed on, exactly
   like any other. On this lane's next drive attempt, `checkAcDriftBeforeDrive`
   (`engine/src/loop/conductor.ts`) detects the drift, applies `needs-human`, and marks
   the row rebaseline-eligible — expect that label, don't treat its absence as "nothing
   happened." Review the new body, then remove `needs-human` (ritual step 4) to authorize
   GATED RECLAIM, which is what actually rebaselines and re-snapshots the AC authority
   ahead of the next `evaluate()`. Never post the probe record as a comment only: it stays
   invisible to gate②, the criterion stays `cannot-confirm`, and that gap is the
   operator's, not the producer's.
4. **Evidence posting.** Where a decision or intervention isn't self-evident from the
   event ledger alone (a `park clear --reason`, a manual label change, a judgment call
   the ledger can't express), post it as a comment on the issue/PR it concerns. GitHub is
   the audit trail for *process* — this durable-knowledge doc is not where a single
   session's blow-by-blow belongs (see this repo's own `CLAUDE.md`, "Documentation
   principle").
5. **Dashboard rebuild.** If this session merged any dashboard-touching PR, rebuild
   before the next viewing (`npm run build -w dashboard`) and restart the running
   `sapwood dashboard` process (stop it, then re-run `sapwood dashboard`) rather than
   leaving the old one up. An in-place rebuild alone already reaches the build-identity
   chip — the server rereads its dist statics per request and its build-meta
   sidecar per poll, so it never needs a restart just to notice a fresher `dist/`.
   Restart anyway: it's the only way to run this session's own server-code changes
   (`server.ts`/`start.ts` — Node doesn't hot-reload a running process) and to cover a
   deploy that repoints the `dist` symlink to a new target rather than overwriting it in
   place (the server resolves its static root's real path once at startup, not per
   request). The chip catches a stale *dist*, not stale server code or a re-pointed
   symlink — restarting is still on the operator for those.

## Stop ritual

Emergency stop (`data/EMERGENCY_STOP`), kill switch (`data/KILL_SWITCH`), and pause
(`data/PAUSE`) are plain file sentinels next to the engine's state DB — see
`/sapwood-stop`'s own doc (`commands/sapwood-stop.md`) for the same three tiers and
their distinct semantics. This section covers the supervision-side placement/removal
discipline layered on top.

Every `mkdir -p data && touch ...` / `rm -f ...` pair below has an equivalent
first-class CLI verb — `sapwood pause`/`pause clear`, `sapwood stop`/`stop clear`,
`sapwood estop --confirm`/`estop clear` — a thin wrapper over the exact same file, so
either form is fine; the CLI form additionally prints the tier's live semantics and
(for `stop`) the configured drain window, and `estop` refuses to activate without
`--confirm` (owner ruling, non-negotiable — see `sapwood estop --help`).

- **Emergency-stop placement and clearing.** Set it only for credential exposure,
  destructive calls, or a cost blowout that cannot wait for the drain window:

  ```bash
  mkdir -p data && touch data/EMERGENCY_STOP
  # equivalent: sapwood estop --confirm
  ```

  It is checked before `data/KILL_SWITCH` every tick and wins when both are present. In the normal
  path, it hard-kills every running/fixing lane's process group on that same tick: there is no drain
  window, in-flight WIP is lost, and killed lanes escalate to `needs-human` with their
  evidence preserved. The kill itself is forge-free — a synchronous durable-PID signal that runs
  before any forge call, so a hung or rejecting forge call can never delay or prevent it.
  Everything after the kill — terminal-state classification/probing, drain escalation, and the
  `needs-human` labels/comments — may still touch the forge, and is best-effort; none of it gates
  process termination anymore. Clear it only after human review of the emergency and of those
  escalations:

  ```bash
  rm -f data/EMERGENCY_STOP
  # equivalent: sapwood estop clear (no --confirm needed to clear)
  ```

- **Kill-switch placement and clearing.** For any other stop, use the drain-first kill
  switch. Set `data/KILL_SWITCH` at the point you actually want dispatch/merges to
  freeze — the engine picks it up at the very next tick-top gate, so there's no reason
  to pre-place it "just in case." The natural placement for a clean stop is **at the
  last expected merge** of a batch: once the lane(s) you're waiting on have merged, set
  the sentinel before anything new could be dispatched into the gap.

  ```bash
  mkdir -p data && touch data/KILL_SWITCH
  # equivalent: sapwood stop
  # After the drain/stop is complete and you intend to allow dispatch again:
  rm -f data/KILL_SWITCH
  # equivalent: sapwood stop clear
  ```

- **Drain semantics.** A first stop signal (SIGTERM/SIGINT, or the kill-switch sentinel)
  freezes dispatch and asks in-flight lanes to hand off gracefully within
  `cfg.cost.drainWindowSec` (default 300s) before the conductor escalates to a hard kill.
  A **second** signal skips the drain and hard-exits immediately — in-flight lanes are
  NOT drained, so only send a second signal when you deliberately want to abandon
  whatever's running. `sapwood status` while draining shows the same active/driving
  lanes you'd see mid-run; watch it (or poll `events`) until active lanes reach zero
  rather than assuming the drain finished the moment you set the sentinel.
- **Spin/livelock SUSPICION.** An engine PID that stays alive while the event cursor
  stops advancing across polls, with CPU or RSS still rising, is a reason to look — not
  a diagnosis, and not on its own a reason to stop the engine. Those same signals are
  produced by healthy work: CPU/RSS rise during any real build or test run, and a lane's
  `worker-heartbeat`/`role-session-heartbeat` is scoped to that lane's own progress — not
  the engine's global event cursor, so one lane's ticks can never starve another
  concurrent lane's heartbeat comparison. Corroborate before acting: check
  whether that SPECIFIC lane's own heartbeat/drive-queued reason has stopped changing —
  not just whether the global cursor has — and whether that lane's own worker log has
  stopped growing. Only once corroborated, capture the PID/process tree and last event
  page, then follow the Stop ritual—using the second signal if graceful drain cannot
  complete—verify every lane descendant is gone, and do not restart unchanged.
- **Pause placement and clearing.** Pause is the gentle tier: it freezes only new lane
  dispatch while in-flight workers and PR review/merge proceed normally. Use it to hold
  the queue while triaging or before a maintenance window, not to stop unsafe work.

  ```bash
  mkdir -p data && touch data/PAUSE
  # equivalent: sapwood pause
  rm -f data/PAUSE
  # equivalent: sapwood pause clear
  ```

- **Sentinel removal.** `data/EMERGENCY_STOP`, `data/KILL_SWITCH`, and `data/PAUSE` are
  OUT-OF-BAND controls — the engine never removes any of them itself. Remove a sentinel
  only once you intend the *next* `sapwood run` (or the next tick, if the process is
  still alive under a signal stop rather than a hard exit) to resume the control tier it
  governs. A leftover strict sentinel after a stop-and-restart cycle silently blocks the
  fresh run. After clearing an emergency stop, remember that a remaining kill switch
  still wins over pause; confirm the intended state with `sapwood status` before assuming
  the next run will dispatch.

## Interpretation pointers

What a given event kind, park source, or escalation bucket **means**, and how urgent it
is, is generated reference — read the `sapwood-event-glossary` skill
(`.claude-plugin/skills/sapwood-event-glossary/SKILL.md`), not this doc: it's
regenerated from the engine's own source of truth and would drift the moment this page
tried to duplicate it. Its `routine` / `expected-noise` / `investigate` / `intervene`
actionability tiers are the vocabulary the rest of this playbook assumes.

**Expected-noise counting.** A single `expected-noise` event (a failed canary probe, a
retried thread write) is not a signal on its own — these kinds exist precisely because
the underlying retry/degrade path is supposed to self-heal. What IS worth reading is the
*count* over a window: `sapwood events --kind <kind> --since-id <cursor>` and counting
the matches tells you whether a given expected-noise kind is firing once (ignore it) or
repeatedly (worth reading the surrounding `investigate`/`intervene` events for what's
actually wrong upstream). This is a supervisor-side read, not an engine threshold — no
kind is reclassified by count; you are just choosing where to look next.

**`permission-mode-mismatch`.** A lane/session's own init line reported an
effective host permission mode different from the one the engine requested (today:
always `auto`) — Claude Code silently falling back to a different mode (e.g. Manual,
when auto is unavailable) can leave a headless leg under-delivering with no other
visible signal. `sapwood events --kind permission-mode-mismatch` surfaces it; see the
glossary for the full meaning. Never gates a lane's outcome — read it for context, not
as an escalation.

## Known blind spot: persistent forge-fetch failure in queued arms

**This is an accepted, bounded blind spot.** Several
`queued`-outcome arms in the drive family — `ac-drift-check-unavailable`
(`checkAcDriftBeforeDrive`), `comment-cursor-check-unavailable`
(`checkCommentCursorBeforeDrive`), and the `*-escalation-write-failed` /
`fix-leg-dispatch-failed` group — retry forever on a forge fetch that fails on *every*
attempt, not just a transient one. There is deliberately no consecutive-failure escalation
cap: distinguishing "permanently broken" from "rate-limited/network-blip" by a bare retry
count would either escalate a healthy lane on a bad day or need a second knob to avoid
that, and no evidence of an actual silent wedge has shown up to justify the
complexity (marginal-complexity doctrine — see `REVIEW-DOCTRINE.md`'s adjudication
principles). The containment is honest visibility —
one `drive-queued` event per reason change (never per-tick spam) plus this
watch recipe — not an automatic escalation.

Spot a wedged lane with the same two read-only verbs from
[Supervising a run](#supervising-a-run):

```bash
# 1. Which lanes are driving right now, and on which (worker, issue, pr)?
sapwood status --json

# 2. For a lane that's been driving far longer than this repo's PRs normally take to
#    clear gate②, has its drive-queued reason stopped changing? These reason strings are
#    the forge-fetch-failure class:
#      ac-drift-check-unavailable, comment-cursor-check-unavailable,
#      review-disputed-escalation-write-failed, review-non-convergent-escalation-write-failed,
#      fix-rounds-cap-label-failed, fix-rounds-cap-comment-failed, fix-leg-dispatch-failed
sapwood events --issue <N> --kind drive-queued
```

If the same reason string keeps recurring across repeated polls with no `merged`,
`needs-human`, `ac-snapshot-drift`, or `comment-cursor-stale` event ever following it, the
forge call behind that arm is very likely broken for good, not transient — escalate by
hand (apply `needs-human`, comment the issue with the evidence) the same as any other
operator-observed intervention (see [Batch close ritual](#batch-close-ritual)).

## Queue queries

The gated (awaiting review gate) and human-merge-only/needs-human queues live on
GitHub, not in the state DB — `status`/`events` are deliberately DB-only (see
[Supervising a run](#supervising-a-run), and [Where facts live](#where-facts-live-github-vs-the-state-db)
for the general rule this is one instance of). Query them with `gh` directly. Label names
below are the shipped defaults (`labels.prefix: sapwood:`); a repo running a different
prefix or a fully custom label set needs the equivalent substitution. `blocked`/`hold`
meaning (and how each differs from `needs-human`) lives in `docs/configuration.md`'s
`escalation.humanLabels`/`holdLabels` tables — read there, never re-derived here.

```bash
# Issues/PRs a human owes the next decision on:
gh issue list --repo OWNER/REPO --label "sapwood:needs-human" --state open
gh pr list    --repo OWNER/REPO --label "sapwood:needs-human" --state open

# Why is issue N labelled needs-human? The reason is on the carrier itself (a
# marker-deduped comment on the FIRST escalation) and in the ledger — the latter is one
# command, no jq projection needed:
sapwood events --issue N

# PRs a human must merge (one-way verdict — never re-decided by the loop):
gh pr list    --repo OWNER/REPO --label "sapwood:human-merge-only" --state open

# blocked:
gh issue list --repo OWNER/REPO --label "sapwood:blocked" --state open
gh pr list    --repo OWNER/REPO --label "sapwood:blocked" --state open

# hold:
gh pr list    --repo OWNER/REPO --label "sapwood:hold" --state open

# split (awaiting po-decompose): human-applied, or engine-applied at the resume cap —
# either origin, po-decompose picks it up next round with no other change:
gh issue list --repo OWNER/REPO --label "sapwood:split" --state open
```

`sapwood status`'s `gated PRs (awaiting review gate)` count is the DB-side lane view
(PRs currently `driving`, waiting on gate②) — cross-reference it against the `gh pr
list` queries above rather than treating either alone as the complete picture: a PR can
be `driving` in the DB and simultaneously carry a human hold label on GitHub.

Merging a `sapwood:human-merge-only` PR by hand is the only manual step left in that
flow — sapwood closes the lane out on its own next tick once the merge lands: the board
item moves to `done`, `labels.inProgress` comes off the issue, and the worktree goes
through the same clean/dirty check as the [dirty-worktree
degrade](troubleshooting.md#dirty-worktree-degrade) path above. A clean worktree (or one
that never existed) gets a best-effort deletion attempt as part of that close-out —
nothing else for you to do, though an unremovable-but-clean directory doesn't block the
close-out either, so it can rarely survive on disk as a harmless leftover. A dirty one is
retained and escalated with `labels.needsHuman` exactly like any other dirty-worktree
degrade; that's the one case still left to a human, and it's salvaged the same way.

## Governance lines

- **List-never-merge.** A supervisor session's job is visibility and, where authorized,
  narrowly-scoped intervention (the kill switch, the pause sentinel, `park clear`) — it
  is never a merge decision. Merge authority follows the configured merge gate
  (`docs/security.md`), and `sapwood:human-merge-only` PRs are a human's call
  structurally, not a supervisor's to route around.
- **Owner decides, supervisor records+nags.** Scope/policy/merge-authorization decisions
  are the owner's; a supervisor session's job is to surface the queues that need a
  decision, record the decision once made (see [Batch close ritual](#batch-close-ritual)
  above), and follow up on anything left open — never to decide on the owner's behalf.
- **Breaker-park clear discipline.** `park clear --reason "<text>"` records the
  operator's reason for clearing a park episode verbatim in the receipt event and echoes
  it in stdout. It's advisory for a human clearing by hand; for an agent supervisor it is
  **required practice** — every clear an agent supervisor performs carries a `--reason`.
  Clearing the SAME source repeatedly in one session is a signal the underlying problem
  isn't actually resolving — treat a second same-source clear as a reason to stop
  clearing and escalate to a human (apply `needs-human` / raise it explicitly) rather
  than clear a third time.

> **Supervisor governance ruling.** An LLM supervisor
> session occupies the TRUSTED OPERATOR role. Interventions (kill-switch sentinel, pause
> sentinel, `park clear`) are operator surface — producer≠reviewer≠merger does not
> implicate the supervisor. Auditability requirement: agent-performed breaker-park
> clears must carry a recorded reason; repeated clears of the same source escalate to
> needs-human instead of auto-clearing. "Who watches the supervisor" stays an explicitly
> open PLAN.md long-arc item — not resolved, not silently assumed.

## Est-vs-real cost method

`sapwood run --dry-run` prices a batch BEFORE it starts (`previewUsd` — candidate count
× the configured soft per-worker budget). `sapwood status --json`'s `spend` section
prices what actually happened: `todayUsd`, split by real attribution
(`settledByWorker`/`settledByRole`/`reviewUsd`) plus `unclassifiedUsd` + an
`incomplete` flag so a client can never mistake attribution gaps for zero spend. The
engine itself already reconciles ITS OWN per-lane estimate against the real terminal
`total_cost_usd` at terminal settlement (done/failed/handoff alike, not just a clean
finish), when a positive terminal cost is actually available — logging the divergence
when it is, and logging the estimate as the recorded spend (never a fabricated $0) when
it isn't (`writeTerminalSentinel`'s own doc, `engine/src/roles/worker.ts`; see
`docs/PLAN.md`'s Security model) — that is a per-lane mechanism, not a supervision one.

`spend_ledger` also carries a per-row `estimated` flag so the est-vs-real
divergence above can be queried instead of grepped from logs — populated where the
engine distinguishes a pinned-price estimate from a real provider-reported total at
the write site itself: the engine-review site's own `ReviewSessionSpend.kind`, and
every worker/fix-leg terminal settlement —
`writeTerminalSentinel`'s own `costEstimated` computation is persisted onto the
terminal sentinel, threaded through `LaneProbe.costEstimated`, and lands in
`spend_ledger.estimated` at `conductor.ts`'s `settleTerminalWorker` call. A
worker/fix-leg row's `estimated` is `NULL` for older/legacy lane rows or when the
sentinel never classified the distinction (still never guessed). A
`peripheral-role` row's `estimated` is still `NULL` always — `peripheral.ts`'s
`runSessionWithRetry` does not yet thread this signal through — so the dogfood
estimator-bias series (opus vs. sonnet, per-leg) can be run by query for
worker/fix-leg/engine-review lanes; peripheral-role rows still need to be wired in
a later change.

The supervision-side practice is a coarser, session-scoped series: note the dry-run
preview at batch open, note the settled spend at batch close, and track the two numbers
against each other across sessions. A preview that's consistently far from settled
spend (in either direction) is worth investigating — a stale `pricing.yaml`, a
config change that shifted which model workers run under, or a batch composition that
doesn't match what dry-run assumed (dry-run prices an empty-lane-set fresh round; it
does not replay exact next-tick occupancy). This is pure supervisor-side bookkeeping —
no new engine machinery backs it, and none should: the per-lane reconciliation the
engine already does is the authoritative number.

The estimator itself (`parseAssistantUsageDeltas` + `estimateUsd`) carries synthetic unit
coverage in-repo; validating it against a REAL captured dogfood transcript is an operator step,
not a repo test — real transcripts are one issue's dev-time artefacts and live in the deploy's
own `data/fixtures/estimator/`, never this repo. Run `npx tsx scripts/estimator-replay.ts <dir>`
from `engine/` against such a directory; it prints each file's estimate/real/signed error and
exits non-zero if any file lands outside the adjudicated [-12%, +5%] band.

## UX dogfood harness: simulated-user supervision

Everything above watches the **ENGINE** loop — dispatch, gates, budgets. This section is the
second, parallel channel: a **sonnet 5 session simulating a real
user watches the FRONTEND** (the dashboard and its content modules) — walking the panel the way a person
would and reporting what the experience is actually like. It separates "is the panel's code
correct" (gate②'s job, ordinary review) from "is the panel usable" (nobody's job otherwise), and
reuses this doc's own separation discipline: the simulated user observes and reports **one-way**;
it never produces, approves, merges, or files.

### Activation threshold

Capability-gated, not milestone-gated: the replay phase below activates
once `sapwood dashboard` AND at least one content module (hero or
lane board) are merged to `main`, **and** the dev server renders the seeded demo fixture
end-to-end (panel paints; not a blank shell). No calendar gate, no dedicated hardening milestone —
the first walk is scheduled by the PM immediately after the second of those two PRs merges,
PO-supervised. Met as of this writing: `sapwood dashboard` (the launcher), `Hero`, `LaneBoard`,
and the `?demo` fixture (`dashboard/src/demo/source.ts`) all ship on `main`.

### Personas and journey scripts

Two to start; may grow with evidence gathered during replay-phase walks — this list is not a
ceiling.

**First-time user** — no docs read. Can they tell what the engine is doing and why?

1. Open `sapwood dashboard` against the demo fixture (`?demo`) cold, with no explanation. What do
   they think the Header word and Hero stage are telling them right now?
2. Scan the lane board — can they tell, from the panel alone, how many lanes are active and what
   each one is doing?
3. Read the activity feed / needs-attention list — do the sentences read as plain English, or do
   they require glossary knowledge (event kinds, park sources) the panel doesn't supply?
4. Find the cost strip — can they tell what it's showing and whether it's something to worry
   about?

**Operator mid-incident** — a lane is wedged. Can they find it, understand it, and reach the right
control?

1. Given a fixture/replay state with a stalled lane, can they locate it on the lane board without
   being told which one?
2. Can they tell *why* it's wedged (reason text) and how urgent it is, from the panel's own
   language and visual weight?
3. Can they find the right control (kill switch / pause, via Controls/IconRail) and do they
   understand the confirm step before anything actually fires?
4. Using the round navigator / transport scrubber, can they scrub back to the moment before the
   stall and see what led to it?

### Two operating phases

- **Replay phase.** v0.2 batches: after each merged dashboard increment, walk both journey scripts
  above against the demo fixture / replay data (`?demo`, or a recorded round played back through
  the transport scrubber). Bounded, single-journey-set sessions.
- **Live phase.** Once the panel attaches to a real engine run: continuous observation during the
  flagship recorded dogfood run ([`docs/PLAN.md`](PLAN.md)'s dashboard dogfood), operator persona
  first. Runs only during an owner-authorized dogfood run, never ad hoc.

### Report contract

One ledger per supervised session, one-way to the PM supervisor. Per finding:

| Field | Meaning |
|---|---|
| `persona` | `first-time-user` or `operator-mid-incident` (or a later-added persona) |
| `journeyStep` | which numbered step above the finding occurred on |
| `expectation` | what the persona expected to see/happen |
| `observed` | what the panel actually showed |
| `severity` | one of `blocks-comprehension`, `friction`, `polish` |
| `suggestion` | phrased as user experience ("the wedge reason isn't visible without a click"), **never** as an implementation directive ("change `NeedsAttention.tsx` to...") |

A session that finds nothing records an explicit clean pass — "no findings" is a valid, complete
ledger, not an omission.

Ledgers are archived at `data/review/ux/` (one file per session), each pinned with the dashboard
commit SHA and the fixture/replay id (e.g. the demo fixture's round id, or a recorded round's own
id) the walk was run against — so a finding is reproducible against the exact panel state it
describes, not a moving target.

That path lives inside the engine's runtime `data/` directory, gitignored repo-wide by design — the
ledger is an operator-side artifact, never a tracked file a PR tree could contain. A reviewer
cannot confirm a walk by inspecting the tree; the reviewable evidence for any given session is the
operator's witness record folded into the relevant issue **body** (actor, steps, timestamp,
findings summary, artifact path) — a PR or issue comment is an operator inbox/audit item, never
gate② evidence — per the tier-C human-witnessed-probe doctrine below.

**Evidence class.** Per [`docs/security.md`](security.md)'s evidence tiers, the simulated user's
report is producer-side session output — **trust-origin evidence class C at best** (a
human/PO-witnessed probe, never self-attested). It informs PM triage; it never auto-satisfies any
acceptance criterion on its own.

### Discipline boundaries and tool surface

The session is read/browse/screenshot only. This is a supervisor-launched session, not an
engine-dispatched one, so there is no `commands/*.md`/`engine/prompts/` loader to hang enforcement
off of — the boundary has to be real at the CLI invocation itself, or it is nothing.
`docs/security.md`'s own doctrine is explicit that `--allowedTools`/`--disallowedTools` alone is
**noise reduction, not a seal**: an ambient host MCP server from settings sources stays loadable
and callable "regardless of `--allowedTools`" unless the MCP surface itself is closed. The only
sealing floor this repo documents (and the one `engine/src/roles/worker.ts`'s `strictMcpConfig`/
`settingSources` options and every credential-free/gate②-review leg already use in production) is
`--strict-mcp-config` plus an explicit `--mcp-config` and `--setting-sources ""`. The launch
recipe below is that same mechanism, not new machinery:

```bash
# Zero ambient MCP servers except the one browser-automation server this session needs, named
# explicitly — the same shape as worker.ts's EMPTY_MCP_CONFIG_JSON, with one server added back in,
# itself launched origin-restricted to wherever `sapwood dashboard` actually serves (default port
# 4517, engine/src/state/read-model.ts's DEFAULT_DASHBOARD_PORT — adjust if launched with --port)
# and `--isolated` so the browser gets a fresh, ephemeral profile with no saved cookies/auth state
# to inherit from the operator's own logged-in browser.
DASHBOARD_ORIGIN="http://localhost:4517"
MCP_CONFIG='{"mcpServers":{"browser":{"command":"npx","args":["@playwright/mcp@latest","--isolated","--allowed-origins","'"$DASHBOARD_ORIGIN"'","--blocked-origins","https://github.com;https://api.github.com;https://*.github.com"]}}}'

claude \
  --strict-mcp-config --mcp-config "$MCP_CONFIG" \
  --setting-sources "" \
  --allowedTools "Read,Edit(data/review/ux/**),mcp__browser__*" \
  --disallowedTools "Bash,mcp__forge__*,mcp__github__*" \
  --append-system-prompt "$(cat docs/prompts/ux-simulated-user.md)"
```

- `--strict-mcp-config` + the explicit `--mcp-config` above discards every MCP server from every
  OTHER source (project `.mcp.json`, user/project/local settings, any ambient host config) — only
  the one named `browser` server loads, regardless of what else is configured on the launching
  host. This is the actual perimeter; the tool names in `--allowedTools` below are what's usable
  WITHIN that already-closed surface, not what closes it.
- `--setting-sources ""` loads zero file-based settings sources, closing the `user`-scope ambient
  inheritance gap the same doctrine names.
- **The browser server itself is the widest tool in this grant** — navigation, click, and form
  actions are a channel to anywhere a browser can reach, not just the dashboard, so closing the
  MCP surface down to "one server" is not by itself enough. Two of `@playwright/mcp`'s own launch
  flags narrow that channel: `--allowed-origins "$DASHBOARD_ORIGIN"` rejects navigation to
  anything but the dashboard's own origin (so a page can't be driven to `github.com` even if
  asked), and `--blocked-origins` names GitHub's own hosts as a second, belt-and-suspenders deny
  in case the allow-list is ever loosened for a future journey that needs a second origin.
  `--isolated` additionally guarantees the browser context is fresh and ephemeral every launch —
  no persisted cookies, no saved login, nothing an accidental cross-origin navigation could ride
  on even if the origin lists were misconfigured. State the residual honestly: this is the
  MCP server's own origin-enforcement behaving as documented, not sapwood's PreToolUse guard hook
  — a bug in that enforcement is a channel this doesn't defend against. It is a real, configured
  control, though, not merely an unenforced instruction.
- `--allowedTools "Read,Edit(data/review/ux/**),mcp__browser__*"` grants exactly: reading any
  file (to consult its own report contract), writing only under `data/review/ux/` (to file its
  ledger, nothing else), and the browser-automation tools to walk the journeys.
- `--disallowedTools "Bash,mcp__forge__*,mcp__github__*"` is a third, belt-and-suspenders veto —
  in case a future edit to `$MCP_CONFIG` ever names a forge-authority or exec-capable server, this
  still blocks it by name, the same defense-in-depth stance `worker.ts`'s own denylist takes.
- No `gh`, no `Bash`, no forge-authority MCP tool name, and the one browser tool it does have is
  both origin-restricted to the dashboard and running with no authenticated state to inherit — the
  session has no path to GitHub or a project board left that isn't already closed by one of the
  controls above.

### Findings routing

**Findings-routing statement.** Findings route exclusively through PM triage → owner why/what
gate; no direct issue creation by the simulated-user session. It never creates, files, or comments
on a GitHub issue itself — anything a finding suggests should become an issue passes through PM
triage and the owner why/what gate as agent-origin, the same as any other proposed work.

## See also

- [`docs/security.md`](security.md) — the trust/governance model: the guard hook,
  human-merge-only paths (canonical list — never re-enumerated here), the kill switch vs.
  pause distinction, cost ceilings.
- [`docs/configuration.md`](configuration.md) — every config key referenced above
  (`labels`, `escalation`, `cost`, `engine`) with its default and full semantics.
- [`docs/troubleshooting.md`](troubleshooting.md) — the single-instance lock, park
  episodes (env-failure/rapid-restart/consecutive-stalls/idle-churn), and what to do
  when each fires — the mechanics this playbook assumes.
- [`docs/PLAN.md`](PLAN.md) — architecture, the v1.1 real-supervisor roadmap item, and
  the open "who watches the supervisor" long-arc question.
- `sapwood-event-glossary` skill
  (`.claude-plugin/skills/sapwood-event-glossary/SKILL.md`) — what every event
  kind/park source/escalation bucket means and how actionable it is.
- [`docs/prompts/ux-simulated-user.md`](prompts/ux-simulated-user.md) — the session prompt for
  the [UX dogfood harness](#ux-dogfood-harness-simulated-user-supervision) above.
