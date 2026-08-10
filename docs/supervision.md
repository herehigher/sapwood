# Supervision

The playbook for whoever is watching a `sapwood run` session — a human, or a trusted
LLM supervisor session (see [Governance lines](#governance-lines) for what that role
means). Pre-#407, sapwood ships **no daemon/supervisor process of its own**: `sapwood
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
  lanes, spend vs. the daily ceiling, kill-switch/pause state, park episodes, base-CI-red.
  `--json` prints a documented, additive-only DTO (`formatVersion 1`) instead of the text
  summary — ignore fields you don't recognize rather than fail on them.
- **`sapwood events [db-path] [options]`** — the event ledger itself, id-cursor and
  kind-filterable. This is the codified monitor recipe: a poll loop no longer hand-rolls
  SQL, it calls this verb on a cadence.

**The poll-cursor recipe.** Keep `nextSinceId` from the previous call and feed it back
as `--since-id` on the next one — every page (including an empty one) advances the
cursor to the ledger's current tail, so a poller can never get stuck rescanning the same
range. **Bootstrap the cursor with `--tail 0`** (#709) instead of a raw `select max(id)`
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
tasks carry a runtime ceiling (10 minutes in the incident this section is drawn from,
wave-2, 2026-08-07); on expiry the harness TERMs the whole process group. The engine
reads that correctly — two signals are exactly the freeze-drain-then-hard-exit sequence
[Stop ritual](#stop-ritual)'s drain-semantics bullet already documents — but an operator
who expected a supervised stop instead got an unattended one: one un-drained hard-exit,
three lanes killed mid-flight, ~$30 bounded loss. The engine did nothing wrong; the
launch method never detached it from a clock that was always going to run out.

Verified working pattern: `nohup`, backgrounded, and `disown`'d out of the launching
shell's job table — this defeats `SIGHUP`-on-shell-exit and any other signal the shell
would otherwise deliver to its own job, nothing more (the pgid/session/cgroup hierarchy
below says precisely what it does and doesn't cover). `run`'s data dir
(`data/sapwood.sqlite`, `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`, sessions, worktree roots) resolves
**relative to the process's cwd, not to `--config`'s directory** — the CLI's own `run
--help` says so (`docs/configuration.md`'s loader-resolution note carries the same
rule) — so `cd` into the deployment checkout FIRST, or the detached process silently
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
default; the incident below is an **example of a launcher that didn't**: an automation
harness's shell ran `nohup ... & disown` without job control ever assigning the child a
group of its own, so it inherited the launcher's process group, and a later
group-directed signal from that same launching environment killed the "detached" engine
collaterally. Live-verified 2026-08-07: pid 95193, launched this way, died to an
external SIGKILL ~23 minutes in, together with its codex-exec review child; the exact
external signal source was never identified, but the shared-pgid mechanism is
confirmed.

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

Three script-environment gotchas from the same incident apply to any detached script,
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
  it would in bash. What made this silent in the incident wasn't zsh: the monitor
  script itself redirected its own stderr to `/dev/null`, which is what actually
  swallowed the loud 127 and turned a visible typo into a dead poller nobody noticed —
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
   [`docs/security.md`](security.md#the-comment-adjudication-cursor-652)), and comments
   remain audit evidence, never the contract a worker is dispatched against; the body
   remains the worker contract. Two incidents are the paid-for cost of skipping this: the
   #604 incident (an owner's verbal endorsement was never recorded, and a later architect
   pass treated the issue as unresolved and blocked it) and the batch-8 incident (PR #651
   round 1: a binding owner ruling sat in issue comment #3 while the worker faithfully
   implemented the stale body — 5 P1s in one PR). Any owner ruling that lands during a
   session — a scope call, a merge authorization, a policy decision — is closed out with
   all four steps below, in order, **in that same session**, before the session ends. Do
   not defer "I'll write it up later," and do not stop partway (recording the ruling
   without rewriting the body reproduces the exact trap that caused batch-8):
   1. **Record the ruling** as a comment on the relevant issue/PR.
   2. **Rewrite the authoritative body** to fold the ruling in — the comment is evidence
      that a decision was made, not the decision a worker will act on.
   3. **Advance the [#652 adjudication
      cursor](security.md#the-comment-adjudication-cursor-652)**
      (`<!-- sapwood:comments-adjudicated-through: <comment-id> -->`) to the ruling
      comment or later, so gate⓪ and dispatch see the body as current rather than stale.
   4. **Remove `needs-human`**, if it was applied for this reason.
3. **Evidence posting.** Where a decision or intervention isn't self-evident from the
   event ledger alone (a `park clear --reason`, a manual label change, a judgment call
   the ledger can't express), post it as a comment on the issue/PR it concerns. GitHub is
   the audit trail for *process* — this durable-knowledge doc is not where a single
   session's blow-by-blow belongs (see this repo's own `CLAUDE.md`, "Documentation
   principle").

## Stop ritual

Emergency stop (`data/EMERGENCY_STOP`), kill switch (`data/KILL_SWITCH`), and pause
(`data/PAUSE`) are plain file sentinels next to the engine's state DB — see
`/sapwood-stop`'s own doc (`commands/sapwood-stop.md`) for the same three tiers and
their distinct semantics. This section covers the supervision-side placement/removal
discipline layered on top:

- **Emergency-stop placement and clearing.** Set it only for credential exposure,
  destructive calls, or a cost blowout that cannot wait for the drain window:

  ```bash
  mkdir -p data && touch data/EMERGENCY_STOP
  ```

  It is checked before `data/KILL_SWITCH` every tick and wins when both are present. On
  that tick, it hard-kills every running/fixing lane's process group: there is no drain
  window, in-flight WIP is lost, and killed lanes escalate to `needs-human` with their
  evidence preserved. Clear it only after human review of the emergency and of those
  escalations:

  ```bash
  rm -f data/EMERGENCY_STOP
  ```

- **Kill-switch placement and clearing.** For any other stop, use the drain-first kill
  switch. Set `data/KILL_SWITCH` at the point you actually want dispatch/merges to
  freeze — the engine picks it up at the very next tick-top gate, so there's no reason
  to pre-place it "just in case." The natural placement for a clean stop is **at the
  last expected merge** of a batch: once the lane(s) you're waiting on have merged, set
  the sentinel before anything new could be dispatched into the gap.

  ```bash
  mkdir -p data && touch data/KILL_SWITCH
  # After the drain/stop is complete and you intend to allow dispatch again:
  rm -f data/KILL_SWITCH
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
  `worker-heartbeat`/`role-session-heartbeat` is scoped to that lane's own progress (#688
  fixed a gate that scoped it to the GLOBAL event cursor instead — a live batch-10
  incident, two concurrent lanes on the same cadence, the earlier lane's heartbeat
  starved permanently because the LATER lane's own ticks kept advancing the id it was
  compared against; a single lane run never hit it). Corroborate before acting: check
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
  rm -f data/PAUSE
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

## Known blind spot: persistent forge-fetch failure in queued arms

**Adjudicated bounded blind spot (#662, 2026-08-06 ruling, Option B).** Several
`queued`-outcome arms in the drive family — `ac-drift-check-unavailable`
(`checkAcDriftBeforeDrive`), `comment-cursor-check-unavailable`
(`checkCommentCursorBeforeDrive`), and the `*-escalation-write-failed` /
`fix-leg-dispatch-failed` group — retry forever on a forge fetch that fails on *every*
attempt, not just a transient one. There is deliberately no consecutive-failure escalation
cap: distinguishing "permanently broken" from "rate-limited/network-blip" by a bare retry
count would either escalate a healthy lane on a bad day or need a second knob to avoid
that, and no dogfood evidence of an actual silent wedge has shown up to justify the
complexity (marginal-complexity doctrine — see `REVIEW-DOCTRINE.md`'s adjudication
principles, and #662 for the full ruling record). The containment is honest visibility —
one `drive-queued` event per reason change (never per-tick spam, #383 dedup) plus this
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

# Why is issue N labelled needs-human? The reason is on the carrier itself (#655's own
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
```

`sapwood status`'s `gated PRs (awaiting review gate)` count is the DB-side lane view
(PRs currently `driving`, waiting on gate②) — cross-reference it against the `gh pr
list` queries above rather than treating either alone as the complete picture: a PR can
be `driving` in the DB and simultaneously carry a human hold label on GitHub.

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
- **Breaker-park clear discipline.** `park clear --reason "<text>"` (#644) records the
  operator's reason for clearing a park episode verbatim in the receipt event and echoes
  it in stdout. It's advisory for a human clearing by hand; for an agent supervisor it is
  **required practice** — every clear an agent supervisor performs carries a `--reason`.
  Clearing the SAME source repeatedly in one session is a signal the underlying problem
  isn't actually resolving — treat a second same-source clear as a reason to stop
  clearing and escalate to a human (apply `needs-human` / raise it explicitly) rather
  than clear a third time.

> **OWNER RULING RECORDED (2026-08-04, PM session, this round):** an LLM supervisor
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
(`settledByWorker`/`settledByRole`/`reviewUsd`, #645) plus `unclassifiedUsd` + an
`incomplete` flag so a client can never mistake attribution gaps for zero spend. The
engine itself already reconciles ITS OWN per-lane estimate against the real terminal
`total_cost_usd` at terminal settlement (done/failed/handoff alike, not just a clean
finish), when a positive terminal cost is actually available — logging the divergence
when it is, and logging the estimate as the recorded spend (never a fabricated $0) when
it isn't (`writeTerminalSentinel`'s own doc, `engine/src/roles/worker.ts`; see
`docs/PLAN.md`'s Security model) — that is a per-lane mechanism, not a supervision one.

`spend_ledger` also carries a per-row `estimated` flag (#645) so the est-vs-real
divergence above can be queried instead of grepped from logs — populated where the
engine distinguishes a pinned-price estimate from a real provider-reported total at
the write site itself: the engine-review site's own `ReviewSessionSpend.kind`, AND
(as of #645's spend-attribution work) every worker/fix-leg terminal settlement —
`writeTerminalSentinel`'s own `costEstimated` computation is now persisted onto the
terminal sentinel, threaded through `LaneProbe.costEstimated`, and lands in
`spend_ledger.estimated` at `conductor.ts`'s `settleTerminalWorker` call. A
worker/fix-leg row's `estimated` is `NULL` only for a lane that predates this change or
whose sentinel never classified the distinction (still never guessed). A
`peripheral-role` row's `estimated` is still `NULL` always — `peripheral.ts`'s
`runSessionWithRetry` does not yet thread this signal through — so the dogfood
estimator-bias series (opus vs. sonnet, per-leg) can now be run by query for
worker/fix-leg/engine-review lanes, and still needs peripheral-role rows wired by a
later issue.

The supervision-side practice is a coarser, session-scoped series: note the dry-run
preview at batch open, note the settled spend at batch close, and track the two numbers
against each other across sessions. A preview that's consistently far from settled
spend (in either direction) is worth investigating — a stale `pricing.yaml`, a
config change that shifted which model workers run under, or a batch composition that
doesn't match what dry-run assumed (dry-run prices an empty-lane-set fresh round; it
does not replay exact next-tick occupancy). This is pure supervisor-side bookkeeping —
no new engine machinery backs it, and none should: the per-lane reconciliation the
engine already does is the authoritative number.

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
