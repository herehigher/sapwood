# 04 — Test & quality commands

The suite uses colocated `node:test` files loaded through `tsx`. The source carries roughly 1,900+ `test()`/`it()` declarations — "about 2,000 tests" is the useful scale; `npm test` reports the executed count, which differs from any static count (subtests, generated cases). No timing guarantee is encoded in the repository, so runtime depends on the machine.

## Command reference

| Working directory | Command | What it runs |
| --- | --- | --- |
| repository root | `npm test` | `npm run -ws test`; currently the engine's `node --import tsx --test "src/**/*.test.ts"`. |
| repository root | `npm run lint` | `biome ci .` using `biome.json`. |
| repository root | `npm run typecheck` | `npm run -ws typecheck`; currently `tsc -p tsconfig.typecheck.json` in the engine. |
| repository root | `npm run build` | `npm run -ws build`; currently `tsc` into `engine/dist/`. |
| `engine/` | `npm test` | All `src/**/*.test.ts` through `node:test` and `tsx`. |
| `engine/` | `npm run lint` | `biome ci src`. |
| `engine/` | `npm run typecheck` | `tsc -p tsconfig.typecheck.json`. |
| `engine/` | `npm run build` | `tsc`. |
| repository root | `python3 scripts/check-links.py` | Pre-publish dead-link check (#340) across README + docs entry pages: file existence, GitHub-style heading anchors, and private-repo-safe checks for `github.com/herehigher/sapwood/issues\|pull` links via `gh api`. Stdlib-only. Re-run this before any docs-affecting cutover (e.g. #329) to refresh the recorded result. |

`engine/tsconfig.json` is the BUILD config and excludes `src/**/*.test.ts` (and
`src/**/*.test-support.ts`) so `tsc` does not emit test files into `dist/`.
`engine/tsconfig.typecheck.json` extends it, drops that exclusion, and is what `npm run typecheck`
runs — so **every** fixture is type-checked, not merely stripped by `tsx`. It excludes nothing, and
must stay that way: an excluded test file is one where a fixture can drop a required dependency —
a required `now` clock, for instance — and still compile, which is the coverage hole the compiler
check exists to close. If a test file stops compiling, fix the file rather than excluding it.
A partial `IForge` double is the usual cause; `src/forge/unstubbed-forge.test-support.ts` exists so
a fixture can stub only the slice it drives (`class FakeForge extends UnstubbedForge`) without
restating the rest of the interface.

The root lint command and engine lint command are not identical: the root invokes Biome at the repository root, while `biome.json` limits included files to `engine/src/**/*.ts`.

## Running a subset

From `engine/`, run one file with the same loader as the package script:

```bash
node --import tsx --test src/roles/merge-driver.test.ts
```

Use `--test-name-pattern` after `--test` when a Node test name is sufficiently specific. `src/roles/worker.test.ts` exercises real local subprocess and filesystem behavior through fakes/helpers around the Claude boundary; under heavy parallel machine load, rerun that file alone to distinguish contention from a deterministic failure. There is no repository script for a separate serial mode.

## How tests are written here

Conventions a new test is expected to follow — they are visible throughout the
existing suite:

- **Colocated `*.test.ts`**, `node:test` + `node:assert`, no test framework.
  Pure logic is tested directly; processes and network are faked at the
  boundary (`claude`/`gh` spawn seams, fake `IForge` implementations), never
  hit for real.
- **Decision tables are tested row-for-row.** Gate/merge policy functions
  (`deriveGate`, `mergeDecision`) carry exhaustive case tables in
  `merge-driver.test.ts`; a behavior change edits the table in the same PR.
- **Security code gets adversarial coverage.** The guard has a differential
  fuzz suite (`guard.fuzz.test.ts`) and a bypass matrix alongside its unit
  tests; proxy changes test deny-by-default access, caps, and budgets.
- **Durable state gets crash-rerun tests.** State changes test restart replay,
  idempotent re-application, and upgrades from a populated previous-version
  database (`state.test.ts`); see the crash-consistency rules in
  [06 — Persistence](06-persistence.md).
- **Subprocess realism is bounded.** `worker.test.ts` exercises real local
  process/filesystem behavior around the spawn seam and can be
  contention-sensitive; everything else stays hermetic.
- **No assertion may depend on real time.** A test that seeds a timestamp
  injects that same clock into the code under test, and no assertion's
  pass/fail may turn on real timer ordering, real subprocess duration, or
  scheduler order — inject the seam, don't widen the margin. Every production
  `now` dependency is a *required* constructor/deps field precisely so the
  compiler catches a fixture that forgot; the exceptions that genuinely want
  the wall clock (monotonicity checks, a documented order-of-magnitude
  passthrough bound) say so in a comment at the site. A test that can hang on
  regression carries a hang guard with a named failure message
  (`materializer.test.ts`'s `withHangGuard`, `watchdog.test.ts`'s `waitFor`).
  This class has reddened `main` three times — see
  [REVIEW-DOCTRINE.md](../REVIEW-DOCTRINE.md#technical-invariants), "No
  timing-dependent assertions", for the worked examples.

## CI

CI is present at `.github/workflows/ci.yml`. On every pull request and pushes to `main`, its Ubuntu/Node 24 job runs:

```bash
npm ci
npm --workspace engine run typecheck
npm run lint
npm --workspace engine test
```

The workflow does not run `npm run build` as a separate step; type checking and tests are its compiled-code checks today.
