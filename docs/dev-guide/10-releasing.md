# 10 — Releasing

How sapwood is versioned, and the exact steps that cut a release. Contribution
mechanics (branch/PR, quality gate, human-merge-only rules) are in the root
[CONTRIBUTING.md](../../CONTRIBUTING.md); this page is about the release act itself.

## Policy

**SemVer 2.0.0.** Pre-1.0, the ladder is `0.3.0-alpha.N → 0.3.0 → 0.3.1`: MINOR
names a milestone (a public-facing body of work, e.g. "v0.3.0 — Public launch"),
PATCH is an in-milestone fix. `0.3.0-alpha.N` pre-releases precede the milestone's
own cut so an early-access signal reaches the version string itself, not just prose.

**One version, four manifests, one writer.** The whole monorepo carries a single
version, held in lockstep across exactly four files:

- `package.json`
- `engine/package.json`
- `dashboard/package.json`
- `.claude-plugin/plugin.json`

These are written **only** by `scripts/release.ts` — never by hand. `package-lock.json`'s
own root/`engine`/`dashboard` entries agree with them too, but not because anyone edits
a fifth place: the script runs `npm install --package-lock-only --ignore-scripts`
immediately after bumping the four manifests, and those entries are simply what that
step derives from them. `.claude-plugin/marketplace.json` is a local/catalog manifest
with a relative `./` source; it is not a version carrier or a release-time mutation.
A lockstep test (`scripts/release.test.ts`) fails the build when a manifest or derived
lockfile entry drifts from the release version.

**Three layers, one truth:**

| layer | example | who writes |
|---|---|---|
| tag + the four manifests | `0.3.0-alpha.1` (tag `v0.3.0-alpha.1`) | human via `scripts/release.ts` |
| built artefact `sapwood --version` | `0.3.0-alpha.1+20260819.a1b2c3d` | CI/build stamp |
| future automated nightly channel (named, not built) | `0.3.0-alpha.1.202608191430+a1b2c3d` | automation only |

Rationale for keeping these three layers distinct:

- Build metadata (the `+…` suffix) is **ignored for precedence** by SemVer, and npm
  treats `1.2.3+a` and `1.2.3+b` as the *same* version (republishing over an existing
  version is blocked) — so it can carry a build stamp without ever becoming a second
  version identity.
- `^0.3.0` never matches `0.3.0-alpha.*` (npm/semver range semantics) — a pre-release
  is opt-in by construction, not by convention.
- No mainstream project puts a timestamp in a human-cut tag: Kubernetes, Next.js,
  Rust, and Go all keep release tags terse and put timestamps only in nightly/canary
  identifiers or in `--version`/build-info output; PEP 440 gives timestamped local
  versions their own segment, separate from the release segment. sapwood follows the
  same split — a person writes `0.3.0-alpha.1`, the build adds the rest.

**Preconditions**, all true before `prepare` is even worth running:

- `main` is green (CI passing on the commit `prepare` will branch from).
- The milestone is cleared, or its remainder has been moved to a later milestone.
- The CHANGELOG has content to promote (an `## [Unreleased]` section that isn't empty).
- The getting-started install path has been walked end-to-end on a clean machine,
  for the version about to ship — not just unit-tested.

**Who publishes.** A human. The loop may *prepare* a release — bump the four
manifests and open the CHANGELOG PR — but it cannot *publish* one: the guard denies
`gh release` and a direct push to the default branch from any session it governs.
Publishing is a human running `scripts/release.ts publish` from their own machine
or an authorized CI job triggered by a human-pushed tag.

**Release immutability: ON.** GitHub's repository-level "Enable release immutability"
setting is ON. Once a release is published (not draft), its tag is locked to the commit
it points at and its assets can't be added, changed, or removed —
[GitHub's immutable releases doc](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
This matters here because consumers install by exactly those two things: the
`v<version>` tag that `scripts/release.ts` also mirrors onto the marketplace catalog,
and `release-evidence.txt`, which is an audit artifact only if it can't be rewritten
after the fact. That's why `publish` creates the GitHub Release as a **draft**
(`--draft`) and `release.yml` attaches evidence to the draft before publishing it
(`gh release edit … --draft=false`) — see "Runbook" below.

**Rollback.** Versions never go backwards, and once a release is published under
immutability it can't be quietly rewritten. Deleting a published release is
possible, but GitHub retires its tag name permanently either way — even after
deletion, that exact tag can never be reused (protection against tag-reuse/"repository
resurrection" attacks, per the doc above) — so deleting buys nothing and only throws
away the audit trail immutability exists to keep. The actual rollback is: ship a new
version through the normal runbook, and run `npm deprecate sapwood@<bad-version>
"<reason; see <new-version>>"` so installers are warned off the bad version on the
registry side. (npm itself refuses to unpublish or overwrite a version more than
~72h old regardless — see the Runbook's Rollback step below — so a corrected
version is the only path either way.)

**Delivery channels.** A release ships as (1) a git tag + GitHub Release, (2) the bare
`sapwood` npm package (including its dashboard), and (3) the thin Claude Code shell promoted
into the separate catalog repository. `publish` first dispatches the Windows pack/install/dashboard
smoke workflow against `origin/main` and waits for it — a red run stops the release before the
tag exists. Then the promotion order is npm publish, dashboard canary,
exact `npm view sapwood@<version> version` verification, then catalog promotion. The promotion
copies only `.claude-plugin/`, `commands/`, and `bin/` from the release commit, stamps its
manifest with the version, records the source commit in the catalog promotion commit message,
pushes the catalog, and tags it with the same `v<version>` so catalog history maps
one-to-one onto releases. Its catalog CI rejects files outside that shell and validates the two
manifest versions.

**Package name: bare `sapwood`, not `@sapwood/engine`.** The `engine` workspace
publishes under the bare npm name `sapwood`, not the scoped `@sapwood/engine` its
`package.json` used before this decision. The `@sapwood` scope stays reserved for
possible future split packages, but the one package this monorepo ships today is
the bare name — it's what both `npm i -g sapwood@alpha` and the marketplace's
`npx sapwood@<version>` resolve. `dashboard` stays unpublished (`"private": true`);
it imports the engine by relative path within the workspace, never by package
name, so the rename carries no cross-workspace reference to update.

**npm publish dist-tag.** Same pre-release rule as the GitHub Release's
`--prerelease` flag, applied to npm's own tag concept: a plain release publishes
under `latest`. A pre-release publishes under its own first identifier
(`0.3.0-alpha.1` → `alpha`, `0.3.0-beta.1` → `beta`, `0.3.0-rc.1` → `rc`) when
that identifier is purely alphabetic, so distinct pre-release tracks install
side by side under their own tags instead of colliding on one hardcoded name; a
non-alphabetic first identifier (`0.3.0-1`) falls back to the generic `next`.
Either way, a pre-release **never** publishes under `latest` — `latest` is what
a bare `npm install sapwood` (no version) and `npx sapwood@latest` resolve, so a
pre-release landing there would silently become the default install for everyone.

**npm publish token: lives on the publishing human's machine.** `npm publish`
authenticates via `npm login` run once, locally, by whoever executes `publish`.
There is no `NPM_TOKEN` CI secret or automated npm-publish workflow today. An
`NPM_TOKEN` workflow remains an open, human-merge-only owner decision; this
release path stays human-triggered unless the owner makes and merges that change.

**npm provenance: `--provenance` is the required form, but nothing runs it yet.**
npm's provenance attestation needs two things — see
[npm's provenance docs](https://docs.npmjs.com/generating-provenance-statements/):
an OIDC ID token, which only a supported CI provider can mint (for GitHub Actions
that means the job has `permissions: id-token: write` and runs on a GitHub-hosted
runner), and a `package.json` `repository` field matching, case-sensitively, the
repo being published from — `engine/package.json`'s already does.
`.github/workflows/release.yml`'s `attach-evidence` job carries `id-token: write`
for this reason. That grant alone doesn't get us provenance today, though: `npm
publish` still runs from `scripts/release.ts publish` on the operator's own
machine via a local `npm login`, not inside that or any CI job, and a local run
has no OIDC token to mint from regardless of flags. `npm publish --provenance` is
the form to use whenever this step actually runs inside a CI job — passing
`--provenance` from a local run today would not produce a valid attestation.

**Pre-releases always pass `--prerelease`.** `gh release create` does not infer
pre-release status from a `-` in the tag name, so `publish` passes `--prerelease`
itself whenever the version contains one.

## Runbook

```sh
# 1. Prepare — bumps the four manifests, moves CHANGELOG Unreleased -> the new
#    version section, opens a PR.
npm run release -- prepare 0.3.0-alpha.1

# 2. Review the PR like any other change, then merge it (ordinary PR merge — this
#    step is not part of the script).

# 3. Publish — from main, at the merged commit. Tags, pushes the tag, creates the
#    GitHub Release as a draft with the CHANGELOG section as its notes (release.yml
#    attaches evidence and publishes it once CI runs against the tag — see "Release
#    immutability" above), then `npm publish`es the engine workspace as `sapwood`
#    under the version's own dist-tag (see "npm publish dist-tag" above), runs the
#    dashboard canary, verifies that npm serves the exact version, then promotes the
#    shell into the catalog. Requires a prior local `npm login` and the catalog remote.
npm run release -- publish --catalog https://github.com/herehigher/sapwood-plugin.git
# or, to see the exact commands without running them:
npm run release -- publish --catalog https://github.com/herehigher/sapwood-plugin.git --dry-run

# 4. Verify. The release shows as a draft until release.yml finishes attaching
#    evidence and publishing it — allow a few minutes for that run.
gh release view v0.3.0-alpha.1
git describe --tags
npm view sapwood dist-tags

# 5. Rollback, if needed — see "Rollback" above (Policy section): a published
#    release's tag and assets are frozen, and its tag name can never be reused
#    even if the release itself is deleted, so deleting buys nothing. Ship a new
#    version through this same runbook instead, and warn installers off the bad
#    one on the npm side:
npm deprecate sapwood@0.3.0-alpha.1 "broken; use <new-version> instead"
# npm also refuses to unpublish or overwrite a version more than ~72h old
# regardless — see npm's own unpublish policy for the narrow window in which
# `npm unpublish` still applies.

# 5b. Retry, if only the npm step failed (tag + GitHub Release already exist —
#     `publish` itself refuses to re-run once the tag exists, so retry this one
#     step by hand from the tagged commit). <dist-tag> is whatever
#     `npm run release -- publish --dry-run` printed for this version (see "npm
#     publish dist-tag" above — latest / alpha / beta / rc / next):
git checkout v0.3.0-alpha.1
npm publish --workspace engine --tag <dist-tag>

# 5c. Retry only catalog promotion after a catalog push failure. This verifies the
#     published npm version again, then replaces the catalog shell from the release tag.
npm run release -- promote --catalog https://github.com/herehigher/sapwood-plugin.git
```
