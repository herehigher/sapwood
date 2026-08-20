// build-server.mjs (#743 gate② rework) — bundles start.ts (and everything it pulls in from
// dashboard/server.ts + engine/src/**) into ONE self-contained, plain-JS entry that `node` can run
// directly, with no loader. This is the "runnable server entry" half of the #743 launcher: without
// it, `sapwood dashboard` would need `node --import tsx` at runtime just to resolve
// dashboard/server.ts's NodeNext `.js`-specifier imports (which point at uncompiled TypeScript
// siblings — verified experimentally that plain `node` cannot resolve them), which would make
// `tsx` an undeclared/otherwise-deviant RUNTIME dependency of the engine (gate② finding). esbuild
// resolves the same `.js`-points-at-`.ts` convention natively while bundling, so the OUTPUT here
// needs nothing beyond plain Node.
//
// TRANSPILE-ONLY, deliberately: esbuild does not type-check. `npm run typecheck` (tsc against
// tsconfig.server.json, unchanged by this file) is still the one place that catches a type error
// in this path — this script's only job is producing a runnable artifact.
//
// `yaml`/`zod` stay EXTERNAL (real node_modules imports at runtime, exactly like every other
// engine caller) — bundling them in would duplicate code for no reason and risk exactly the kind
// of CJS/ESM interop breakage a bundled copy of `yaml` hit during development (a dynamic
// `require("process")` from its CJS build). Node builtins (`node:*`) are external by construction.
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const OUT_DIR = "dist-server";
mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: ["start.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: `${OUT_DIR}/start.js`,
  external: ["yaml", "zod"],
  legalComments: "inline",
  logLevel: "info",
});
