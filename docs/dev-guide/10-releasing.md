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
step derives from them. `.claude-plugin/marketplace.json`'s `plugins[0].source.ref` is a
second derived carrier, in the same relationship: `prepare` sets it to `v<version>`
right after the four manifests (`main` at the pre-first-release `0.0.0` baseline, since
there is no tag yet to point at), and it is never hand-edited either. A lockstep test
(`scripts/release.test.ts`) fails the build the moment any manifest, the lockfile's
derived entries, or the marketplace ref drifts from the rest.

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

**Rollback.** Versions never go backwards. If a release is bad: delete the tag and
the GitHub Release, then ship a patch. Don't reuse or force-move a tag that was
ever pushed.

**Delivery channels.** A release ships as (1) a git tag + GitHub Release, (2) the
`sapwood` npm package, and (3) the Claude Code marketplace plugin, whose slash
commands fall back to `npx sapwood@<version>` when no local `engine/dist` build is
present — all three keyed to the same tag. `prepare` moves the marketplace `ref` to
`v<version>` in lockstep with the four manifests (see above); `publish` performs (1)
and (2).

**Package name: bare `sapwood`, not `@sapwood/engine`.** The `engine` workspace
publishes under the bare npm name `sapwood`, not the scoped `@sapwood/engine` its
`package.json` used before this decision. The `@sapwood` scope stays reserved for
possible future split packages, but the one package this monorepo ships today is
the bare name — it's what both `npm i -g sapwood@alpha` and the marketplace's
`npx sapwood@<version>` resolve. `dashboard` stays unpublished (`"private": true`);
it imports the engine by relative path within the workspace, never by package
name, so the rename carries no cross-workspace reference to update.

**npm publish dist-tag.** A plain release publishes under `latest`. Every
pre-release publishes under `alpha`, never `latest`. `latest` is what a bare
`npm install sapwood` (no version) and `npx sapwood@latest` resolve, so a
pre-release landing there would silently become the default install for everyone.

**npm publish token: lives on the publishing human's machine.** `npm publish`
authenticates via `npm login` run once, locally, by whoever executes `publish`.
There is no `NPM_TOKEN` CI secret or automated npm-publish workflow today. An
`NPM_TOKEN` workflow remains an open, human-merge-only owner decision; this
release path stays human-triggered unless the owner makes and merges that change.

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
#    GitHub Release with the CHANGELOG section as its notes, then `npm publish`es
#    the engine workspace as `sapwood` under the selected dist-tag (see "npm
#    publish dist-tag" above). Requires a prior local `npm login`.
npm run release -- publish
# or, to see the exact commands without running them:
npm run release -- publish --dry-run

# 4. Verify.
gh release view v0.3.0-alpha.1
git describe --tags
npm view sapwood dist-tags

# 5. Rollback, if needed.
gh release delete v0.3.0-alpha.1 --yes
git push origin :refs/tags/v0.3.0-alpha.1
# then ship a patch through the same runbook.
# npm never lets a version be re-published or removed after ~72h (unpublish policy);
# ship a corrected version instead — see npm's own unpublish policy for the narrow
# window in which `npm unpublish` still applies.

# 5b. Retry, if only the npm step failed (tag + GitHub Release already exist —
#     `publish` itself refuses to re-run once the tag exists, so retry this one
#     step by hand from the tagged commit). <dist-tag> is whatever
#     `npm run release -- publish --dry-run` printed for this version (see "npm
#     publish dist-tag" above — latest or alpha):
git checkout v0.3.0-alpha.1
npm publish --workspace engine --tag <dist-tag>
```
