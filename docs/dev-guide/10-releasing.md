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
step derives from them. A lockstep test (`scripts/release.test.ts`) fails the build the
moment any manifest, or the lockfile's derived entries, drifts from the rest.

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
commands run `npx sapwood@<version>` — all three keyed to the same tag, with the
marketplace `ref` and the npx pin moving in lockstep with it. Today `publish`
performs (1); the npm and marketplace steps are appended to `PUBLISH_STEPS` when
they land.

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
#    GitHub Release with the CHANGELOG section as its notes.
npm run release -- publish
# or, to see the exact commands without running them:
npm run release -- publish --dry-run

# 4. Verify.
gh release view v0.3.0-alpha.1
git describe --tags

# 5. Rollback, if needed.
gh release delete v0.3.0-alpha.1 --yes
git push origin :refs/tags/v0.3.0-alpha.1
# then ship a patch through the same runbook.
```
