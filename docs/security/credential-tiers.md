# Worker credential tiers

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for worker credential tiers.

**Core property: producer ≠ merger is enforced by credential ABSENCE, not by deny rules.** Every other control on this page (the guard hook, `WORKER_DISALLOWED_TOOLS`, `allowManagedPermissionRulesOnly`'s own caveat) is a rule a sufficiently motivated argv can try to route around. A worker that structurally holds no forge API credential at all cannot open a PR, approve a review, or merge — not because a rule says no, but because the capability does not exist in its environment. The table below names this tier axis's L0/L1/L2 implementation.

**Naming note:** this is a CREDENTIAL-scope axis, distinct from the DISPATCH-autonomy ladder in [getting-started.md](../guide/getting-started.md#l0l3-autonomy-ladder) (L0 Observe / L1 Supervise / L2 Delegate / L3 Governed unattended merge) — the two share L0/L1 labels by coincidence, not because they're the same axis; a repo can independently be at autonomy-L3 and credential-L0, or autonomy-L1 and credential-L1.

| Tier | What the tier guarantees | Push mechanism | PR-open mechanism | Theft blast radius |
| --- | --- | --- | --- | --- |
| **L0** (`worker.credentialTier: L0`, the default) | No severing — the operator's real forge/git credentials, inherited verbatim. | `git push` over the engine's own checkout transport. | Reachable (`Bash(gh *)` granted); `associateLanePr` (`forge.ts`) adopts a worker-opened PR via the `sapwood:pr-owner` marker. | The operator's full forge credential — every repo and scope it carries. |
| **L1** (`worker.credentialTier: L1`, reconciled local anchor found) | No forge API credential in the env — composed by `workerDeployKeyEnv()`/`resolveDeployKeyPath()` (`worker.ts`). | `git push` over SSH via the deploy key only. | Structurally unreachable — `associateLanePr` is the only PR-open channel. | Git-transport write to this one repo only — no API write capability exists. |
| **L2** (enterprise guidance — not implemented) | See the [L2 enterprise posture checklist](#l2-enterprise-posture-checklist). | — | — | — |

**Two facts, two homes.** `worker.credentialTier` (`sapwood.config.yaml`, human-reviewed, audited) is the GOVERNING decision — WHETHER this repo's worker legs must run scoped — so it lives in committed config like every other governing value. WHERE this machine's own key sits is a fact about one machine, not a decision: it lives as a `.id` sidecar beside the key itself, under this machine's own gitignored `.sapwood/keys/` (`config/paths.ts::findDeployKeyAnchor`), discovered fresh each time, never written back to config.

`sapwood init` provisions the L1 key when the operator has repo-admin, degrading to a guidance WARN on any failure (never blocking `init` itself). Whether that failure MATTERS is decided separately, at `sapwood run` startup (`deploy-key-startup-check.ts::detectDeployKeyStartupTier`, run once before any dispatch): `L1` fails CLOSED rather than degrading silently. Once a local anchor exists, every `sapwood init` run RECONCILES rather than skipping, routing any failure to a WARN-only operator choice (register an additional key, or degrade). The local (key file, id sidecar) pair is the sole anchor — never a remote key's title — so the engine only ever adds a key, never deletes or modifies one remotely. Every condition this enforces, and the test pinning it, is in the table below.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| Default/unset `worker.credentialTier` is `L0` — the SSH preflight is never even invoked. | `worker.ts::resolveDeployKeyPath` | `worker.test.ts`: "dispatch: worker.credentialTier L0 (default)" (reverse test) |
| `worker.credentialTier` defaults to `L0`, accepts only `L0`/`L1`; `sapwood init` never writes any deploy-key fact into `sapwood.config.yaml`, in either reconcile outcome. | `config/config.ts` schema; `init.ts::ensureDeployKey`/`reconcileDeployKey` | `config.test.ts`: "worker.credentialTier: defaults to L0, accepts L0/L1, rejects any other value"; `init.test.ts`: "byte-identical before and after a RECONCILE-FAILURE run" |
| `sapwood run` startup fails closed for `L1` with no reconciled anchor — before any dispatch or board/label mutation: no local anchor, an unreadable key, a stale/read-only/unlisted remote id, or a failed preflight. | `deploy-key-startup-check.ts::detectDeployKeyStartupTier`, called from `cli.ts` right after `WorkerSupervisor` construction | `deploy-key-startup-check.test.ts`: arm 2 (missing), arm 3 (unreadable), arm 4a/4b (remote id stale/read-only), arm 5 (preflight fails) |
| A still-running lane from before this restart whose own persisted `credential_tier` doesn't match `L1` (a marker with none recorded, an unparseable marker, or an unlistable state directory all count) blocks startup, naming each lane/session/pid/tier and exactly two remedies (wait it out, or `kill <pid>`) — never `sapwood estop`. | `detectDeployKeyStartupTier`'s running-marker scan, `worker.ts::listRunningCredentialTiers` | `deploy-key-startup-check.test.ts`: "arm running-tier-mismatch" (four variants: mismatch, no tier recorded, dead pid, scan failure) |
| Startup's remote check requires an explicit `readOnly: false`; a missing/non-boolean field is never read as confirmed write access. | `detectDeployKeyStartupTier` | `deploy-key-startup-check.test.ts`: "arm 4c" |
| The startup check seeds the SAME memoized preflight a later dispatch/resume/fix reuses — anchor-seeded, never a second independent resolution. | `worker.ts::checkDeployKeyPreflight`, `deployKeyProbe` | `worker.test.ts`: "checkDeployKeyPreflight (#671): seeds the SAME memoized probe" |
| Every dispatch/resume/fix spawn re-resolves the anchor from disk, re-checks readability on every call, and refuses if the anchor's identity changed since this supervisor's memoized preflight bound to one. | `worker.ts::resolveDeployKeyPath` | `worker.test.ts`: "a discovered anchor whose key file is not currently readable"; "the deploy-key anchor changing between two dispatches on the SAME supervisor is REJECTED" |
| Reconcile checks local file existence, remote id listing, byte-identical public-key content, and SSH preflight — all four green before permission repair runs, the LAST gate. | `init.ts::reconcileDeployKey`, `enforceDeployKeyPermissions` | `init.test.ts`: "wrong permissions ... repaired to 0700/0600/0600" (repair order); "local .pub content does NOT match" (content mismatch) |
| Any reconcile failure is WARN-only and touches no file — not even the stale sidecar — remote never touched; a TTY offers (a) a fresh per-machine key or (b) degrade, non-interactive always (b). | `init.ts::armAuthFailsStaleOrMismatch` | `init.test.ts`: "RECONCILE FAILS (recorded id ... rotated/stale)" (no file modified); "TTY arm (a): operator chooses (a)" |
| Branch protection is checked once provisioning/reconcile succeeds (legacy endpoint, then rulesets on a 404); WARN only if both report unprotected, distinct from a "cannot verify" WARN on any other read failure. | `init.ts::checkDefaultBranchProtectionAction` | `init.test.ts`: "L1 active + default branch UNPROTECTED" (unprotected); "CANNOT BE VERIFIED" (cannot verify) |
| When more than one local sidecar exists (a stale primary plus a fresher per-host replacement), the most recently WRITTEN one wins as the anchor. | `config/paths.ts::findDeployKeyAnchor` | `paths.test.ts`: "when more than one sidecar exists ... the most recently WRITTEN one wins" |

**Registering a deploy key by hand**, when `sapwood init` cannot:

```
ssh-keygen -t ed25519 -N "" -f .sapwood/keys/worker-deploy-key
gh repo deploy-key add .sapwood/keys/worker-deploy-key.pub -R <owner>/<repo> --allow-write --title sapwood-worker
gh repo deploy-key list -R <owner>/<repo> --json id,title -q '.[] | select(.title=="sapwood-worker") | .id' > .sapwood/keys/worker-deploy-key.id
chmod 600 .sapwood/keys/worker-deploy-key .sapwood/keys/worker-deploy-key.id
# then set worker.credentialTier: L1 in the config, and re-run:
sapwood init
```

The key MUST live under `.sapwood/keys/` — `findDeployKeyAnchor` scans only `runtimePaths().keysDir`; a key placed anywhere else is never discovered, and `sapwood run` refuses L1 naming that directory. `title: sapwood-worker` for a fresh install with no repo-admin; `title: sapwood-worker-<hostname>` for an additional per-machine key when reconciling against an already-registered one (`init.ts::armAuthFailsStaleOrMismatch`), offered automatically from an interactive terminal.

### L2 enterprise posture checklist

L2 is optional, docs-only enterprise guidance, not a product-required deployment path. It builds on L1:

- **Use non-human identities.** Separately scoped machine-account or GitHub App identities for worker and merger, never a person's own GitHub identity; keep credentials distinct with no worker bypass of protected refs.

- **Enforce the full repository ruleset posture.** Restrict non-lane branch/tag creation, update, and deletion to trusted identities via rulesets, block force-push/deletion on `lane-*` branches, and review bypass lists so the worker cannot evade any of it.

- **Isolate the worker at the OS-account boundary.** Run worker legs under a dedicated OS account with no access to the conductor's or host user's credential stores, keychains, SSH agents, or config files; keep merger credentials on the separate conductor/host account only.

**Honest residuals — what L1 does NOT close:**

- **Cross-lane clobber, accepted.** A GitHub deploy key is repo-wide, not scoped to a branch, so two concurrently-dispatched lanes sharing the same L1 key could in principle push to each other's branch. What is NOT prevented: unique lane naming (`worker.ts::WorkerSupervisor.dispatch`) and git's non-fast-forward default only stop an *accidental* cross-lane push, not a worker leg that deliberately runs `git push --force` against a constructed branch name. Accepted — a naming-discipline mitigation, not a cryptographic or API-level scope boundary; no dedicated enforcement or test.

- **Raw git-transport push to the default branch — narrowed, not eliminated.** The guard also blocks `git push` reaching the default branch, active only when `SAPWOOD_DEFAULT_BRANCH` is set (`guard.ts::checkGitPushDefaultBranch`). Argv-visible forms only: an alias set by an earlier, separately-judged command — whether in a prior call or earlier in the SAME call, or carried in as `GIT_CONFIG_*` environment aliases — is not caught by an argv scan; accepted, not fixed, branch protection is the backstop of record (`guard.test.ts`: "a PRE-PERSISTED git-config alias is not detected by an argv scan").

- **Host-credential theft: engine-unpluggable.** L1 severs the env-var credential-lookup path only; it cannot touch the operator's real credential store on the host, and a leg that reads a stolen credential off disk can still attempt to authenticate with it (a constructed `gh` path, or curling the API directly) — the `steal.mjs` PoC, [role-sessions.md's HONEST SCOPE note](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry). Not sapwood-closable; branch protection remains the mandatory backstop regardless.
