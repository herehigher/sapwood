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
| **L0** (unset deploy-key config) | No severing — the operator's real forge/git credentials, inherited verbatim. | `git push` over the engine's own checkout transport. | Reachable (`Bash(gh *)` granted); `associateLanePr` (`forge.ts`) adopts a worker-opened PR via the `sapwood:pr-owner` marker. | The operator's full forge credential — every repo and scope it carries. |
| **L1** (deploy key reconciled green) | No forge API credential in the env — composed by `workerDeployKeyEnv()`/`resume()` (`worker.ts`; `worker.test.ts:8262`,`9588`). | `git push` over SSH via the deploy key only. | Structurally unreachable — `associateLanePr` is the only PR-open channel. | Git-transport write to this one repo only — no API write capability exists. |
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

**Activation is opt-in, not default-on.** Unset `deployKeyPath`/`deployKeyId` is L0, byte-for-byte
unchanged; `sapwood init` provisions L1 autonomously when the operator has repo-admin, else
degrades to a guidance WARN at L0 — never a startup or dispatch failure. The private key lives
under the self-ignoring `.sapwood/keys/` root (`config/paths.ts::runtimePaths`'s `keysDir`),
never swept by an ordinary `git add -A`.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| Unset `deployKeyPath` is L0, byte-identical to today — the SSH preflight is never even invoked. | `worker.ts::WorkerSupervisor.resolveDeployKeyPath` | `worker.test.ts:8437`: "dispatch: worker.deployKeyPath UNSET -> L0, byte-identical to today (reverse test)" |
| `deployKeyPath` and `deployKeyId` are a schema-enforced pair — a config with only one set fails to parse, naming the missing half. | `config/config.ts` schema | `config.test.ts:1269`: "rejects a config with ONLY deployKeyPath set, naming deployKeyId as the missing half" |
| Every `sapwood init` run with both configured RECONCILES, never skips — five ordered checks (enumerated in `reconcileDeployKey`'s own doc comment) must all be green, or it fails closed into the choice/degrade arm below. | `init.ts::reconcileDeployKey`, `init.ts::enforceDeployKeyPermissions` | `init.test.ts:1615` (all green); `init.test.ts:1686-1687` (0700/0600 repair) |
| The local `(path, id)` pair is the anchor, never the remote key's title — a `sapwood-worker`-titled key may validly belong to a different machine. The engine never deletes or modifies a remote deploy key. | `init.ts::armAuthFailsStaleOrMismatch` | `init.test.ts:1804`: "RECONCILE FAILS ... non-interactive default (b): WARN + config anchor CLEARED, remote NEVER touched" |
| Any reconcile failure offers, only interactively, (a) a fresh ADDITIONAL per-machine key or (b) degrade to L0 (non-interactive always (b)); either way it ATTEMPTS to clear the stale anchor, but a flow-style `worker: { ... }` mapping or a parse/verify failure leaves it uncleared with a hand-edit WARN instead. | `init.ts::armAuthFailsStaleOrMismatch`, `init.ts::clearDeployKeyConfigFromYaml` | `init.test.ts:2000` (arm a); the flow-style/failure clear path is untested through this call site — unit-tested only via the sibling writer, `init.test.ts:1022` |
| A running engine reports the effective tier once per start (log + `deploy-key-tier-detected` event) — disclosure only, never a gate. | `deploy-key-startup-check.ts::detectDeployKeyStartupTier` | `deploy-key-startup-check.test.ts`: "reverse test: ... never blocks" |
| Branch protection is checked once provisioning/reconcile succeeds (legacy endpoint, then rulesets on a 404); WARN only if both report unprotected, distinct from a "cannot verify" WARN on any other read failure. | `init.ts::checkDefaultBranchProtectionAction` | `init.test.ts:2452`/`2552` (unprotected/ruleset); `init.test.ts:2484`/`2589` (cannot verify) |

**Registering a deploy key by hand**, when `sapwood init` cannot:

```
ssh-keygen -t ed25519 -N "" -f <path>
gh repo deploy-key add <path>.pub -R <owner>/<repo> --allow-write --title <title>
# then set worker.deployKeyPath/worker.deployKeyId in the config, and re-run:
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
  blocks `git push` reaching the default branch when `SAPWOOD_DEFAULT_BRANCH` is set
  (`guard.ts::checkGitPushDefaultBranch`). Argv-visible forms only: an alias set by an earlier,
  separately-judged command — whether in a prior call or earlier in the SAME call — is not caught
  by an argv scan; accepted, not fixed, branch protection is the backstop of record
  (`guard.test.ts:654`: "a PRE-PERSISTED git-config alias is not detected by an argv scan").

- **Host-credential theft: engine-unpluggable.** L1 severs the env-var credential-lookup path
  only; it cannot touch the operator's real credential store on the host, and a leg that reads a
  stolen credential off disk can still attempt to authenticate with it (a constructed `gh` path,
  or curling the API directly) — the `steal.mjs` PoC, [role-sessions.md's HONEST SCOPE
  note](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry). Not
  sapwood-closable; branch protection remains the mandatory backstop regardless.
