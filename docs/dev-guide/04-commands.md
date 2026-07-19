# 04 — Test & quality commands

The suite uses colocated `node:test` files loaded through `tsx`. A static source count finds 1,998 `test()`/`it()` declarations, so “about 2,000 tests” is the useful scale; generated/subtest execution can differ. No timing guarantee is encoded in the repository, so runtime depends on the machine.

## Command reference

| Working directory | Command | What it runs |
| --- | --- | --- |
| repository root | `npm test` | `npm run -ws test`; currently the engine's `node --import tsx --test "src/**/*.test.ts"`. |
| repository root | `npm run lint` | `biome ci .` using `biome.json`. |
| repository root | `npm run typecheck` | `npm run -ws typecheck`; currently `tsc --noEmit` in the engine. |
| repository root | `npm run build` | `npm run -ws build`; currently `tsc` into `engine/dist/`. |
| `engine/` | `npm test` | All `src/**/*.test.ts` through `node:test` and `tsx`. |
| `engine/` | `npm run lint` | `biome ci src`. |
| `engine/` | `npm run typecheck` | `tsc --noEmit`. |
| `engine/` | `npm run build` | `tsc`. |

The root lint command and engine lint command are not identical: the root invokes Biome at the repository root, while `biome.json` limits included files to `engine/src/**/*.ts`.

## Running a subset

From `engine/`, run one file with the same loader as the package script:

```bash
node --import tsx --test src/roles/merge-driver.test.ts
```

Use `--test-name-pattern` after `--test` when a Node test name is sufficiently specific. `src/roles/worker.test.ts` exercises real local subprocess and filesystem behavior through fakes/helpers around the Claude boundary; under heavy parallel machine load, rerun that file alone to distinguish contention from a deterministic failure. There is no repository script for a separate serial mode.

## CI

CI is present at `.github/workflows/ci.yml`. On every pull request and pushes to `main`, its Ubuntu/Node 24 job runs:

```bash
npm ci
npm --workspace engine run typecheck
npm run lint
npm --workspace engine test
```

The workflow does not run `npm run build` as a separate step; type checking and tests are its compiled-code checks today.
