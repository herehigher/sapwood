# Worker credential tiers

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for worker credential tiers.

## Worker credential tiers

**Core property: producer ≠ merger is enforced by credential ABSENCE, not by deny rules.** Every
other control on this page (the guard hook, `WORKER_DISALLOWED_TOOLS`,
`allowManagedPermissionRulesOnly`'s own caveat) is a rule a sufficiently motivated argv can try to
route around. A worker that structurally holds no forge API credential at all cannot open a PR,
approve a review, or merge — not because a rule says no, but because the capability does not
exist in its environment. The table below names this tier axis's L0/L1/L2 implementation.

**Naming note:** this is a CREDENTIAL-scope axis, distinct from the DISPATCH-autonomy ladder in
[getting-started.md](../guide/getting-started.md#l0l3-autonomy-ladder) (L0 Observe / L1 Supervise
/ L2 Delegate / L3 Governed unattended merge) — the two share L0/L1 labels by coincidence, not
because they're the same axis; a repo can independently be at autonomy-L3 and credential-L0, or
autonomy-L1 and credential-L1.

| Tier | What the worker leg's env holds | Push mechanism | PR-open mechanism | Theft blast radius |
| --- | --- | --- | --- | --- |
| **L0** (today's default, unset `worker.deployKeyPath`/`worker.deployKeyId`) | The operator's real, unrestricted environment — `GH_TOKEN`/`gh`'s stored host config/git credential helpers, inherited verbatim (`process.env`, unchanged). | `git push` over whatever transport the engine's own checkout uses (typically HTTPS via `gh`'s credential helper). | Reachable — `Bash(gh *)` is granted. In practice `associateLanePr` opens the PR itself once the branch is confirmed pushed, adopting a worker-opened one via the `sapwood:pr-owner` marker rather than duplicating it (`forge.ts::associateLanePr`). | The operator's full forge credential — every repo it can reach, every write scope the token carries. |
| **L1** (`worker.deployKeyPath`+`worker.deployKeyId` reconciled green) | `workerDeployKeyEnv()` composes the same severing `workerCredentialFreeEnv()` does (`GH_CONFIG_DIR` repointed at an empty per-lane dir, `GIT_CONFIG_GLOBAL`/`SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, every `gh`/git credential-lookup env var stripped) plus `GIT_SSH_COMMAND` pinned to the deploy key (`-o IdentitiesOnly=yes`) and an env-only `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` rewrite of the origin's HTTPS URL to SSH form. A fix leg composes the same overlay onto its own `credentialFree` base (`conductor.ts::startFixLeg` requires `proxy.credentialFree`), so dispatch/resume/fix all get the deploy key when one is configured and preflight-green. `Bash(gh *)` drops from the leg's `--allowedTools` grant either way (`WORKER_ALLOWED_TOOLS_NO_GH`). | `git push` over SSH, authenticated only by the deploy key. | Structurally unreachable — no forge API credential exists in the env, so there is no channel for `gh pr create`. `associateLanePr` (the engine's own credential) is the only PR-open channel on this tier. | The deploy key's own scope only: git-transport write to this one repo. No API write capability (labels, project board, review approval, merge) exists in the first place. |
| **L2** (enterprise guidance — not implemented) | See the [L2 enterprise posture checklist](#l2-enterprise-posture-checklist). | — | — | — |

### L2 enterprise posture checklist

L2 is optional, docs-only enterprise guidance, not a product-required deployment path. It builds
on L1:

- **Use non-human identities.** Give the worker and merger separately scoped machine-account or
  GitHub App identities, not a person's everyday GitHub identity; keep their credentials distinct
  with no worker bypass of protected refs.
- **Enforce the full repository ruleset posture.** Apply a branch ruleset restricting create,
  update, and deletion of every non-lane branch to the appropriate trusted identities; apply a
  separate tag ruleset restricting tag creation, update, and deletion; apply a `lane-*`-pattern
  ruleset blocking force pushes and deletion. Review ruleset bypass lists so the worker cannot
  evade any of these controls.
- **Isolate the worker at the OS-account boundary.** Run worker legs under a dedicated OS account
  that cannot read the conductor's or host user's credential stores, keychains, SSH agents, or
  configuration files. Keep merger credentials available only to the separate conductor/host
  account and enforce filesystem and OS credential-store permissions accordingly.

**Activation is opt-in, not default-on.** `worker.deployKeyPath`/`worker.deployKeyId` unset (the
shipped default, including this repo's own `sapwood.config.yaml`) is L0, byte-for-byte unchanged.
`sapwood init` provisions L1 autonomously when the operator running it has repo-admin; without
repo-admin, or on any provisioning/reconcile failure, the engine degrades to a guidance-carrying
WARN and runs at L0 — never a startup or dispatch failure. The private key lives under the
self-ignoring `.sapwood/keys/` runtime root (`config/paths.ts::SAPWOOD_DIR`), so it is never swept
by an ordinary `git add -A` (a deliberate `git add -f` can still stage it).

| Invariant | Enforcement | Test |
| --- | --- | --- |
| Unset `deployKeyPath` is L0, byte-identical to today — the SSH preflight is never even invoked. | `worker.ts::WorkerSupervisor.resolveDeployKeyPath` | `worker.test.ts:8437`: "dispatch: worker.deployKeyPath UNSET -> L0, byte-identical to today (reverse test)" |
| `deployKeyPath` and `deployKeyId` are a schema-enforced pair — a config with only one set fails to parse, naming the missing half. | `config/config.ts` schema | `config.test.ts:1269`: "rejects a config with ONLY deployKeyPath set, naming deployKeyId as the missing half" |
| Every `sapwood init` run with both configured RECONCILES, never skips. Five checks must all be green: the local key file exists; its directory/file permissions repair to 0700/0600; the recorded id is still listed on the repo; that entry's own public-key content matches the local `.pub` file byte-for-byte; the SSH preflight passes. | `init.ts::reconcileDeployKey`, `init.ts::enforceDeployKeyPermissions` | `init.test.ts:1615` (all green -> positive confirmation, no re-provisioning); `init.test.ts:1686-1687` (dir repaired to 0700, key file to 0600) |
| The local `(path, id)` pair is the anchor, never the remote key's title — a `sapwood-worker`-titled key may validly belong to a different machine. The engine never deletes or modifies a remote deploy key. | `init.ts::armAuthFailsStaleOrMismatch` | `init.test.ts:1804`: "RECONCILE FAILS ... non-interactive default (b): WARN + config anchor CLEARED, remote NEVER touched" |
| Any reconcile check failing clears the stale local anchor and, only on an interactive `sapwood init`, offers a choice: (a) register a fresh, ADDITIONAL per-machine key (never reusing an existing local path or a remotely-registered per-host title), or (b) proceed degraded at L0. A non-interactive run always defaults to (b). | `init.ts::armAuthFailsStaleOrMismatch`, `init.ts::pickFreshArmAKeySlot` | `init.test.ts:2000`: "arm (a), interactive: operator chooses (a) -> registers an ADDITIONAL per-machine key ... leaves the existing remote key untouched" |
| A running engine reports the effective tier once per engine start (log + `deploy-key-tier-detected` event), sharing the same memoized SSH preflight the first dispatch would otherwise pay for separately. Disclosure only — never a gate. | `deploy-key-startup-check.ts::detectDeployKeyStartupTier` | `deploy-key-startup-check.test.ts`: "reverse test: every arm resolves without throwing and never blocks — the check is visibility, not a gate" |
| Branch protection is checked once provisioning/reconcile succeeds: the legacy branch-protection endpoint, then — only on its 404 — whether any ruleset covers the branch. A WARN fires only when both report unprotected; any other read failure produces a distinct "cannot verify" WARN, never claimed as confirmed. | `init.ts::checkDefaultBranchProtectionAction` | `init.test.ts:2452` (confirmed unprotected); `init.test.ts:2484` (cannot verify, distinct from confirmed); `init.test.ts:2552`/`2589` (ruleset cases) |

**Registering a deploy key by hand**, when `sapwood init` cannot: `ssh-keygen -t ed25519 -N "" -f
<path>`; `gh repo deploy-key add <path>.pub -R <owner>/<repo> --allow-write --title <title>`; set
`worker.deployKeyPath`/`worker.deployKeyId` in the config; re-run `sapwood init` to confirm the
preflight. A fresh install with no repo-admin uses `title: sapwood-worker`
(`init.ts::deployKeyProvisioningFailedAction`); a later reconcile failure — where a
`sapwood-worker`-titled key may already exist, possibly belonging to a different machine — uses
`title: sapwood-worker-<hostname>` for a new, additional per-machine key instead
(`init.ts::armAuthFailsStaleOrMismatch`), offered automatically when re-run from an interactive
terminal. This recipe is currently docs-only here, not yet in `docs/guide/`.

**Honest residuals — what L1 does NOT close:**

- **Cross-lane clobber, accepted.** A GitHub deploy key is repo-wide, not scoped to a single
  branch — two concurrently-dispatched lanes sharing the same L1 key could, in principle, push to
  each other's branch. What bounds this in practice: each lane pushes to its own uniquely-named
  branch (`lane-<issue>-<random>`, `worker.ts::WorkerSupervisor.dispatch`), so an ordinary
  (non-force) push from one lane never even names another lane's branch, and git's own
  non-fast-forward default rejects an accidental push that did. This is a naming-discipline +
  git-default mitigation, not a cryptographic or API-level scope boundary — a worker leg that
  explicitly ran `git push --force` against a constructed branch name is not stopped by anything
  L1 adds. Accepted, stated here rather than silently assumed closed.
- **Raw git-transport push to the default branch — narrowed, not eliminated.** The guard's
  gh-overreach check enforces producer≠merger at the `gh` layer only; a worker leg holding
  `Bash(git *)` (L0 host credentials, or an L1 deploy key on an unprotected default branch) could
  otherwise run `git push origin HEAD:<default-branch>` and skip the review gate entirely via raw
  git transport. The guard now denies this too: a rule blocks refspec destinations naming the
  default branch, `--delete`, and `--mirror`/`--all`, active only when the engine's trusted spawn
  env `SAPWOOD_DEFAULT_BRANCH` is set (`worker.ts` threads it into every dispatch/resume/fix-leg
  spawn from the same fact `getDefaultBranchChecks` keys on). Precise-destination matching alone
  cannot prove a push is safe, so the rule's frame is "if this push's safety cannot be proven,
  block it": an unresolved shell variable/command-substitution, a `-c alias.*=` config injection,
  and a wildcard refspec destination all reach the default branch without ever spelling it out as
  a literal token. **What the rule covers, stated plainly, not claimed as exhaustive:** every
  argv-visible raw-git push form — direct refspec destinations, `--delete`/`--mirror`/`--all`,
  `--repo`/`--repo=`, an argv `-c`/`--config` alias injection local to that one invocation, and any
  refspec token the guard cannot statically prove safe. It does **not** cover a push whose
  effective subcommand is resolved through git STATE the argv itself never reveals — a
  pre-persisted, repo-local `git config alias.*` (set by an earlier, separately-judged command) or
  `GIT_CONFIG_*` environment aliases carried in from outside that one Bash call. Closing that class
  would mean modeling git's own config resolution across commands and environment, not scanning
  one more token spelling — the same class `checkControlSentinelArg`'s "a script that hardcodes
  the path internally, with no CLI argument" residual already is (see [Sentinel isolation
  boundary](../security.md#sentinel-isolation-boundary-honest-statement)) — and GitHub branch
  protection is the backstop of record for it: this rule is defense-in-depth at the guard's own
  enforcement point, never a complete jail around it. Enforcement: `guard.ts::checkGitPushDefaultBranch`
  (Category D). Tests: `guard.test.ts` `GIT_PUSH_ALLOW_NOT_A_REFSPEC` (value-taking flags whose
  value equals the default-branch name are not over-blocked); `guard.test.ts:654`: "a PRE-PERSISTED
  git-config alias is not detected by an argv scan" (the accepted residual, pinned as a known
  ALLOW, not an oversight).
- **Host-credential theft: engine-unpluggable.** L1 removes the forge API credential from the
  worker leg's own environment — it does nothing to, and cannot touch, the operator's real
  credential store on the host the engine itself runs on (`gh`'s `hosts.yml`, the OS keychain, an
  `ssh-agent` socket the operator's own shell has live). An attacker with host-level access reaches
  the operator's real credentials the same way with or without L1 — not a sapwood-closable
  surface. The worker-leg-reachable instance of this same class (`Bash(node *)`/`Bash(npm *)`
  reading `~/.config/gh/hosts.yml` directly, the `steal.mjs` proof-of-concept) is
  [role-sessions.md's HONEST SCOPE
  note](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry) — L1 shrinks
  it (no `GH_TOKEN`/`gh`-authenticated-forge-write reachable through the deploy-key env itself) but
  does not eliminate the underlying filesystem-read residual: a leg that reads a stolen host
  credential off disk can still attempt to authenticate with it via a `gh` path it constructs
  itself, or by curling the API directly. Branch protection on the default branch remains the
  mandatory backstop regardless.
