# Worker credential tiers

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for worker credential tiers.

## Worker credential tiers

**Core property: producer≠merger enforced by credential ABSENCE, not by deny rules.** Every
control elsewhere on this page (the guard hook, `WORKER_DISALLOWED_TOOLS`,
`allowManagedPermissionRulesOnly`'s own caveat) is a rule a sufficiently motivated argv can try
to route around. A worker that structurally HOLDS NO forge API credential at all cannot open a
PR, approve a review, or merge — not because a rule says no, but because the capability to do so
does not exist in its environment. This is the tier axis this section describes, with the table
below naming its L0/L1/L2 implementation. **Naming note:** this is a CREDENTIAL-scope
axis, distinct from the DISPATCH-autonomy ladder in
[getting-started.md](../guide/getting-started.md#l0l3-autonomy-ladder) (L0 Observe / L1
Supervise / L2 Delegate / L3 Governed unattended merge) — the two share L0/L1 labels by
coincidence of both starting a tier count at zero, not because they're the same axis; a repo can
independently be at autonomy-L3 and credential-L0, or autonomy-L1 and credential-L1.

| Tier | What the worker leg's env holds | Push mechanism | PR-open mechanism | Theft blast radius |
| --- | --- | --- | --- | --- |
| **L0** (`worker.credentialTier: L0`, the default) | The operator's REAL, unrestricted environment — `GH_TOKEN`/`gh`'s stored host config/git credential helpers, all inherited verbatim (`process.env`, unchanged) | `git push` over whatever transport the engine's own checkout uses (typically HTTPS via `gh`'s credential helper) | The worker CAN reach `gh pr create` (the `Bash(gh *)` grant is present); in practice the prompt no longer instructs it, and `associateLanePr` opens the PR itself once the branch is confirmed pushed, adopting a worker-opened one via the `sapwood:pr-owner` marker rather than duplicating it | The operator's FULL forge credential — every repo it can reach, every write scope the token carries. Not scoped to this one repo. |
| **L1** (`worker.credentialTier: L1`, a reconciled local anchor found) | `workerDeployKeyEnv()` COMPOSES the exact severing `workerCredentialFreeEnv()` does — `GH_CONFIG_DIR` repointed at a fresh, empty, per-lane directory, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, every `gh`/git credential-lookup env var stripped (`GH_*`, `GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, `GIT_CONFIG_*`, `SSH_AUTH_SOCK`) — PLUS `GIT_SSH_COMMAND` pinned to the per-repo write deploy key (`-o IdentitiesOnly=yes`, path shell-quoted) and an env-only `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` rewrite of the origin's HTTPS URL to the matching `git@github.com:` SSH form — no file touched, scoped to this one spawn's env. **A fix leg composes the SAME transport overlay onto its own `credentialFree` base** (the leg ALWAYS dispatches with `proxy.credentialFree: true` — `conductor.ts`'s `startFixLeg`) rather than losing L1, so every leg kind — dispatch, resume, fix — gets the deploy key when the local anchor is discovered and preflight-green (never a silent downgrade — see below). `Bash(gh *)` drops out of the leg's `--allowedTools` grant (`WORKER_ALLOWED_TOOLS_NO_GH`) either way — a grant the env can no longer authenticate through is not offered either. | `git push` over SSH, authenticated ONLY by the deploy key | STRUCTURALLY UNREACHABLE — no forge API credential exists in the env at all, so there is no channel to attempt `gh pr create` through even if the prompt or a producer's own initiative tried. `associateLanePr` (engine-side, the operator's own credential) is the ONLY PR-open channel on this tier, not merely the preferred one. | The deploy key's own scope ONLY: git-transport write to this ONE repo, nothing else. A stolen key opens no other repo, carries no API write capability (label/milestone/board mutation, review approval, merge) in the FIRST place — theft is non-escalating BY CONSTRUCTION, not by a policy that could be bypassed. |
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

**Two separate facts, two separate homes.** `worker.credentialTier` (`sapwood.config.yaml`,
human-reviewed, audited) says WHETHER this repo's worker legs must run scoped — that is a
governing decision, so it lives in the committed config like every other governing value. WHERE
this machine's own key sits is a fact about ONE machine, not a decision, and never belongs in a
file whose git history is the shared audit trail — it lives as a sidecar file beside the key
itself, under this machine's own gitignored `.sapwood/keys/` (see below), discovered fresh each
time, never written back to config. Splitting these closes two gaps the earlier, single
config-anchored `(path, id)` design had: two operator machines sharing one repo used to thrash
each other's `sapwood init` writes onto the SAME committed anchor slot, and a fresh clone whose
committed anchor pointed at a machine-specific key that wasn't there fell back to the WIDER
credential tier (L0) instead of refusing.

**Activation is opt-in, not default-on.** `worker.credentialTier: L0` (the shipped default,
including this repo's own `sapwood.config.yaml`) is today's behavior, byte-for-byte unchanged
(`worker.test.ts`'s own reverse test pins this) — L0 never even looks for a local key. Setting
`worker.credentialTier: L1` is the operator's decision that this repo's worker MUST run scoped;
`sapwood init` provisions the actual key autonomously WHEN the operator running it has repo-admin
(`ssh-keygen -t ed25519 -N ""`; `gh repo deploy-key add --allow-write --title sapwood-worker`; the
key's GitHub-assigned id written into a `.id` sidecar beside the key, mode 0600, under
`.sapwood/keys/`) — every provisioning failure degrades to a guidance-carrying WARN naming the
exact fix (the same pattern this repo already uses for `allowManagedPermissionRulesOnly`, see
below); `sapwood init` itself never fails over this. Whether that failure actually MATTERS is
decided separately, at `sapwood run` startup, by `worker.credentialTier` (see "Startup gate,
not just visibility" below) — L1 configured with no working key is a hard refusal before any
dispatch or board/label mutation (state creation, the `run-started` event, and stateful startup
detectors are unaffected — this gate is a dispatch/mutation boundary, not a zero-writes one),
never a silent run at L0.

**The LOCAL (key file, id sidecar) pair is the anchor — a remote key's TITLE is never
authoritative for "mine".** A `sapwood-worker`-titled key on the repo may validly belong to a
DIFFERENT machine/operator. The engine never invokes or scripts remote deploy-key deletion or
modification, owned or not — a stale or foreign key is only ever surfaced in a WARN for a HUMAN
to review.

Once a local anchor IS discovered (a valid `.id` sidecar under `.sapwood/keys/`), every `sapwood
init` run RECONCILES rather than skipping: the local key file must exist; the recorded id must
still be listed on the repo; that id-matched remote entry's OWN public-key content must match the
local `.pub` file byte-for-byte (this proves the pair was recorded TOGETHER by this machine's own
provisioning, not merely "an id that happens to be registered" plus "a local key that happens to
authenticate" independently, which a hand-edited or foreign id sharing a different but
also-registered key could otherwise fake); and the SSH preflight (`ssh -T git@github.com`,
matched against GitHub's own documented success shape — exit 1, stderr containing "successfully
authenticated") must pass. All four green → the key's and id-sidecar's own file permissions are
repaired to 0600 (dir 0700) as the LAST gate, only once every other signal already agrees the
anchor is valid — a WARN-only outcome below never touches permissions on the way there — and only
then a positive confirmation and L1 stays active. Any ONE of the four failing (a wiped local key
file, a second machine, a remotely rotated/foreign key, a rotated preflight), or that final
permission repair itself failing (a directory/symlink standing in for the key or sidecar),
routes to a **WARN + operator choice**, offered only when `sapwood init` is
running interactively (a real TTY): **(a)** leave every remote key AND every local file
untouched, generate a FRESH keypair — never reusing a key file already sitting at the per-host
path, or a per-host title already registered remotely under someone else's provisioning (treated
as foreign, same never-touch rule): a numeric suffix (`-2`, `-3`, ...) picks a collision-free
sibling path AND title together — and register it as an ADDITIONAL deploy key, reading back its
GitHub-assigned id from a before/after id diff around the `add` call (never a title match, which
a stale/duplicate/racing title could match the wrong entry for; zero or more than one new id is
treated as an ordinary provisioning failure) — the new key's OWN sidecar is written beside it,
never overwriting the stale one; or **(b)** leave every remote key AND every local file untouched,
and proceed degraded (dispatch continues at L0 if `credentialTier` is still L0; if it's already
L1, `sapwood run` will refuse at startup until this is fixed). A non-interactive `sapwood init`
(no TTY — the ordinary autonomous/CI invocation) defaults to **(b)**, the no-write, never-wedge
path, and the WARN still names (a)'s manual steps. Unlike the retired config-anchored design, a
WARN-only outcome touches NO file at all — not even the stale sidecar it's warning about — so
"re-run `sapwood init`" is an honest instruction either way: the next run either reconciles
cleanly (choice (a) already happened) or re-diagnoses the SAME state truthfully, never a false
convergence promise. Any other sapwood-titled key still on the repo is named in the WARN for
HUMAN cleanup.

**The private key does not end up staged by an ordinary `git add -A`.** The key lives under the
self-ignoring `.sapwood/` runtime root (its own `.gitignore` already excludes everything under
it), so `sapwood init` no longer needs to append a rule to the repo's own `.gitignore` to keep it
out of a sweep; a deliberate `git add -f` can still stage it.

**Startup gate for L1, not just visibility.** `sapwood init` provisions and preflights the key,
but a RUNNING engine used to discover key problems only lazily, at the first dispatch's own
memoized SSH preflight — a batch could run at the WIDER tier (L0) with no indication until an
operator went digging in a single leg's logs. At engine startup (`cli.ts`, right after
`WorkerSupervisor` construction, sharing that SAME instance's memoized preflight so this costs no
extra SSH probe) `deploy-key-startup-check.ts` checks `worker.credentialTier` first: `L0` logs
one disclosure line and returns — a legal, fully-functional mode, never blocked. `L1` is
fail-closed: no local anchor found, the anchored key file unreadable, the anchor's id no longer
listed on the repo OR listed but registered read-only (one authoritative `gh repo deploy-key
list` read — SSH auth succeeding proves the key works, not that this specific id still carries
write access), or the SSH preflight failing, each log a guidance-carrying message AND throw,
refusing `sapwood run` before any dispatch or board/label mutation (state creation, the
`run-started` event, and stateful startup detectors are unaffected) — the same
never-silent-downgrade stance `worker.ts`'s own per-leg resolution takes. That per-leg resolution
re-resolves the anchor and re-checks its readability (`accessSync`) on EVERY dispatch/resume/fix
spawn, not just once at startup, and refuses outright if the anchor's identity has changed since
this supervisor last bound its memoized preflight to one — a leg never runs under a key that was
never itself probed. Every outcome — L0's disclosure and L1's four failure shapes — is also
recorded as a `deploy-key-tier-detected` event.

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
  residual already is — see [Sentinel isolation boundary](../security.md#sentinel-isolation-boundary-honest-statement)
  — and GitHub branch protection is the backstop of record for it: this rule was always
  framed as defense-in-depth AT the guard's enforcement point, never a complete jail around it.
- **Host-credential theft: engine-unpluggable.** L1 removes the forge API credential from the
  worker leg's OWN environment — it does nothing to, and cannot touch, the operator's real
  credential store on the HOST the engine itself runs on (`gh`'s `hosts.yml`, the OS keychain, an
  `ssh-agent` socket the OPERATOR's own shell has live, outside any worker leg's spawn env
  entirely). An attacker with host-level access (the operator's own machine compromised
  independently of anything sapwood spawns) reaches the operator's real credentials the same way
  they would with or without L1 — this is not a sapwood-closable surface, and L1 makes no claim
  otherwise. The [HONEST SCOPE](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
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
   sapwood-worker` to keep idempotency working, and the id sidecar to write beside the key once
   it's added — the id is shown on that same Settings page) plus this section as the docs anchor.
   `sapwood init` itself never fails over this; whether it MATTERS depends on
   `worker.credentialTier` at `sapwood run` time (see "Startup gate for L1" above).
2. **Reconcile fails — auth-fails/stale/mismatch.** Any of "local key file exists" / "recorded
   id still listed" / "local `.pub` content matches that entry's own registered key" / "SSH
   preflight green" failing (rotated key, wiped local key file, second machine, a foreign key sharing
   the `sapwood-worker` title, a hand-edited id pointing at an unrelated but also-registered key)
   → a WARN naming the specific reason(s), any other sapwood-titled key already on the repo (for
   HUMAN cleanup), and — on an interactive `sapwood init` — the (a)/(b) choice above; a
   non-interactive run defaults to (b) and still names (a)'s manual steps. This WARN touches NO
   file (unlike the retired config-anchored design, which used to clear the stale anchor as part
   of it), and the underlying SSH-auth probe is memoized so it fires once per engine process
   life, not once per lane.
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
