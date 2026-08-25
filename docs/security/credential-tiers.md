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

| Tier | What the tier guarantees | Push mechanism | PR-open mechanism | Theft blast radius |
| --- | --- | --- | --- | --- |
| **L0** (`worker.credentialTier: L0`, the default) | No severing — the operator's real forge/git credentials, inherited verbatim. | `git push` over the engine's own checkout transport. | Reachable (`Bash(gh *)` granted); `associateLanePr` (`forge.ts`) adopts a worker-opened PR via the `sapwood:pr-owner` marker. | The operator's full forge credential — every repo and scope it carries. |
| **L1** (`worker.credentialTier: L1`, reconciled local anchor found) | No forge API credential in the env — composed by `workerDeployKeyEnv()`/`resolveDeployKeyPath()` (`worker.ts`; `worker.test.ts:8231`,`8447`). | `git push` over SSH via the deploy key only. | Structurally unreachable — `associateLanePr` is the only PR-open channel. | Git-transport write to this one repo only — no API write capability exists. |
| **L2** (enterprise guidance — not implemented) | See the [L2 enterprise posture checklist](#l2-enterprise-posture-checklist). | — | — | — |

### L2 enterprise posture checklist

L2 is optional, docs-only enterprise guidance, not a product-required deployment path. It builds
on L1:

- **Use non-human identities.** Separately scoped machine-account or GitHub App identities for
  worker and merger, never a person's own GitHub identity; keep credentials distinct with no
  worker bypass of protected refs.

- **Enforce the full repository ruleset posture.** Restrict non-lane branch/tag creation, update,
  and deletion to trusted identities via rulesets, block force-push/deletion on `lane-*` branches,
  and review bypass lists so the worker cannot evade any of it.

- **Isolate the worker at the OS-account boundary.** Run worker legs under a dedicated OS account
  with no access to the conductor's or host user's credential stores, keychains, SSH agents, or
  config files; keep merger credentials on the separate conductor/host account only.

**Two separate facts, two separate homes.** `worker.credentialTier` (`sapwood.config.yaml`,
human-reviewed, audited) says WHETHER this repo's worker legs must run scoped — a governing
decision, so it lives in the committed config like every other governing value. WHERE this
machine's own key sits is a fact about one machine, not a decision: it lives as a `.id` sidecar
beside the key itself, under this machine's own gitignored `.sapwood/keys/`
(`config/paths.ts::findDeployKeyAnchor`), discovered fresh each time, never written back to
config. This replaces a retired single config-anchored `(path, id)` pair, which let two operator
machines sharing one repo thrash each other's `sapwood init` writes onto the same committed slot,
and let a fresh clone whose committed anchor pointed at a machine-specific key that wasn't there
fall back to the wider tier (L0) instead of refusing.

**Activation is opt-in, not default-on.** `worker.credentialTier: L0` (the shipped default,
including this repo's own `sapwood.config.yaml`) is today's behavior, byte-for-byte unchanged —
L0 never even looks for a local key (`worker.ts::resolveDeployKeyPath` returns immediately;
`worker.test.ts:8447`). Setting `worker.credentialTier: L1` is the operator's decision that this
repo's worker MUST run scoped: `sapwood init` provisions the key autonomously when the operator
running it has repo-admin (`ssh-keygen -t ed25519`; `gh repo deploy-key add --allow-write --title
sapwood-worker`; the id written into a `.id` sidecar beside the key, mode 0600, under
`.sapwood/keys/`), degrading to a guidance WARN naming the exact fix on any failure — `sapwood
init` itself never fails over this. Whether that failure actually MATTERS is answered separately,
at `sapwood run` startup: `deploy-key-startup-check.ts::detectDeployKeyStartupTier` runs once,
immediately after `WorkerSupervisor` construction, strictly before any dispatch. `L0` logs one
disclosure line and returns — legal, unblocked. `L1` is FAIL-CLOSED: no local anchor, an
unreadable key file, a still-running lane from before this restart whose own persisted
`credential_tier` doesn't match `L1` (a legacy marker with none recorded counts as a mismatch,
never a silent pass), the anchor's remote id no longer listed or not confirmed `readOnly: false`,
or a failed SSH preflight each throw before any dispatch or board/label mutation (state creation,
the `run-started` event, and stateful startup detectors are unaffected) — never a silent run at
L0. This is a reversal of the retired config-anchored design's WARN-only startup posture.

**The local (key file, id sidecar) pair is the anchor — a remote key's title is never
authoritative for "mine".** A `sapwood-worker`-titled key on the repo may validly belong to a
different machine/operator. The engine never invokes or scripts remote deploy-key deletion or
modification, owned or not — a stale or foreign key is only ever surfaced in a WARN for a human to
review.

Once a local anchor is discovered, every `sapwood init` run RECONCILES rather than skipping — five
ordered checks in `init.ts::reconcileDeployKey`: the local key file must exist, the recorded id
must still be listed on the repo, that entry's own public-key content must match the local `.pub`
file byte-for-byte (proving the pair was recorded together, not merely coincidentally valid), the
SSH preflight must pass, and the key's and sidecar's own file permissions are repairable to 0600
(dir 0700) — the fifth check, gated on the other four already being green, so an anchor already
headed for the WARN-only arm below never has its permissions touched on the way there
(`init.ts::enforceDeployKeyPermissions`). All five green → a positive confirmation and L1 stays
active. Any one check failing routes to a
**WARN + operator choice**, offered only on a real TTY: **(a)** generate a fresh per-machine
keypair (title `sapwood-worker-<hostname>`, `init.ts::armAuthFailsStaleOrMismatch`) and register
it as an ADDITIONAL deploy key, reading back its id from a before/after diff and writing its own
sidecar without touching the stale one; or **(b)** leave every remote key and local file
untouched and proceed degraded (dispatch continues at L0 if `credentialTier` is still L0; if
already L1, `sapwood run` refuses at startup until fixed). Non-interactive `sapwood init` (no TTY
— the ordinary autonomous/CI invocation) always defaults to **(b)**, the no-write path — the WARN
still names (a)'s manual steps. A WARN-only outcome touches NO file at all, unlike the retired
config-anchored design, so "re-run `sapwood init`" is an honest instruction either way.

**The private key does not end up staged by an ordinary `git add -A`.** The key lives under the
self-ignoring `.sapwood/` runtime root, so `sapwood init` no longer needs to append a rule to the
repo's own `.gitignore`; a deliberate `git add -f` can still stage it.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| Default/unset `worker.credentialTier` is `L0`, byte-identical to today — the SSH preflight is never even invoked. | `worker.ts::resolveDeployKeyPath` | `worker.test.ts:8447`: "dispatch: worker.credentialTier L0 (default) -> byte-identical to today (reverse test)" |
| `sapwood init` never writes `worker.credentialTier` or any deploy-key fact into `sapwood.config.yaml` — the config file is byte-identical before and after any reconcile outcome. | `init.ts::ensureDeployKey`/`reconcileDeployKey` | `init.test.ts:1201`: "sapwood.config.yaml is byte-identical before and after a RECONCILE-FAILURE run" |
| `sapwood run` startup fails closed for `L1` with no working, remotely-confirmed anchor — before any dispatch or board/label mutation. | `deploy-key-startup-check.ts::detectDeployKeyStartupTier`, called from `cli.ts` right after `WorkerSupervisor` construction | `deploy-key-startup-check.test.ts`: arm 2 (:80, missing anchor), arm 3 (:109, unreadable key), arm 5 (:280, preflight fails) |
| A still-running lane from before this restart whose own persisted `credential_tier` doesn't match `L1` (including a legacy marker with none recorded) blocks startup, naming the lane. | `detectDeployKeyStartupTier`'s running-marker scan, `worker.ts::listRunningCredentialTiers` | `deploy-key-startup-check.test.ts:138,168` |
| Startup's remote check requires an explicit `readOnly: false`; a missing/non-boolean field is never read as confirmed write access. | `detectDeployKeyStartupTier` | `deploy-key-startup-check.test.ts:248` (arm 4c) |
| The startup check seeds the SAME memoized preflight a later dispatch/resume/fix reuses — anchor-seeded, never a second independent resolution. | `worker.ts::checkDeployKeyPreflight`, `deployKeyProbe` | `worker.test.ts:8591` |
| Every dispatch/resume/fix spawn re-resolves the anchor from disk and re-checks readability (`accessSync`) on every call, and refuses if the anchor's identity changed since this supervisor's memoized preflight bound to one. | `worker.ts::resolveDeployKeyPath` | `worker.test.ts:8749` (unreadable key); `worker.test.ts:8781` ("the deploy-key anchor changing between two dispatches on the SAME supervisor is REJECTED") |
| Reconcile checks local file existence, remote id listing, byte-identical public-key content, and SSH preflight — all four green before permission repair runs, the LAST gate. | `init.ts::reconcileDeployKey`, `enforceDeployKeyPermissions` | `init.test.ts:1318` (repair order); `init.test.ts:1529` (`.pub` content mismatch) |
| Any reconcile failure is WARN-only and touches no file — not even the stale sidecar — remote never touched; a TTY offers (a) fresh per-machine key or (b) degrade, non-interactive always (b). | `init.ts::armAuthFailsStaleOrMismatch` | `init.test.ts:1459` (stale, no file modified); `init.test.ts:1641` (TTY arm a) |
| Branch protection is checked once provisioning/reconcile succeeds (legacy endpoint, then rulesets on a 404); WARN only if both report unprotected, distinct from a "cannot verify" WARN on any other read failure. | `init.ts::checkDefaultBranchProtectionAction` | `init.test.ts:2047` (unprotected); `init.test.ts:2080` (cannot verify) |

**Registering a deploy key by hand**, when `sapwood init` cannot:

```
ssh-keygen -t ed25519 -N "" -f <path>
gh repo deploy-key add <path>.pub -R <owner>/<repo> --allow-write --title sapwood-worker
# write the key's GitHub-assigned id into a "<path>.id" sidecar beside the key (mode 0600), set
# worker.credentialTier: L1 in the config, then re-run:
sapwood init
```

`title: sapwood-worker` for a fresh install with no repo-admin
(`init.ts::deployKeyProvisioningFailedAction`); `title: sapwood-worker-<hostname>` for an
additional per-machine key when reconciling against an already-registered key
(`init.ts::armAuthFailsStaleOrMismatch`), offered automatically from an interactive terminal.

**Honest residuals — what L1 does NOT close:**

- **Cross-lane clobber, accepted.** A GitHub deploy key is repo-wide, not scoped to a branch, so
  two concurrently-dispatched lanes sharing the same L1 key could in principle push to each
  other's branch. What is NOT prevented: unique lane naming
  (`worker.ts::WorkerSupervisor.dispatch`) and git's non-fast-forward default only stop an
  *accidental* cross-lane push, not a worker leg that deliberately runs `git push --force` against
  a constructed branch name. Accepted — a naming-discipline mitigation, not a cryptographic or
  API-level scope boundary; no dedicated enforcement or test.

- **Raw git-transport push to the default branch — narrowed, not eliminated.** The guard also
  blocks `git push` reaching the default branch, active only when `SAPWOOD_DEFAULT_BRANCH` is set
  (`guard.ts::checkGitPushDefaultBranch`). Argv-visible forms only: an alias set by an earlier,
  separately-judged command — whether in a prior call or earlier in the SAME call, or carried in
  as `GIT_CONFIG_*` environment aliases — is not caught by an argv scan; accepted, not fixed,
  branch protection is the backstop of record (`guard.test.ts:654`: "a PRE-PERSISTED git-config
  alias is not detected by an argv scan").

- **Host-credential theft: engine-unpluggable.** L1 severs the env-var credential-lookup path
  only; it cannot touch the operator's real credential store on the host, and a leg that reads a
  stolen credential off disk can still attempt to authenticate with it (a constructed `gh` path,
  or curling the API directly) — the `steal.mjs` PoC, [role-sessions.md's HONEST SCOPE
  note](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry). Not
  sapwood-closable; branch protection remains the mandatory backstop regardless.
