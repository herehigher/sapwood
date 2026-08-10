#!/usr/bin/env node
// export-cli.ts (#742) — the build-time step `npm run build` (dashboard/package.json) runs BEFORE
// `vite build`: writes the sanitized `?demo` fixture to `dashboard/public/demo-fixture.json`,
// which Vite then copies verbatim into `dist/` (its default `publicDir` passthrough) — a same-
// origin static asset, never one of the `/api/*` routes. `exportDemoBundle` throwing propagates
// as an uncaught exception here, which exits this process nonzero and fails the `&&`-chained
// `npm run build` — that IS the export gate "failing the build".
import { mkdirSync, writeFileSync } from "node:fs";
import { exportDemoBundle } from "./export.ts";
import { DEMO_SOURCE } from "./source.ts";

const outDir = new URL("../../public/", import.meta.url);
const outFile = new URL("../../public/demo-fixture.json", import.meta.url);

mkdirSync(outDir, { recursive: true });
const bundle = exportDemoBundle(DEMO_SOURCE);
writeFileSync(outFile, JSON.stringify(bundle));
console.log(`demo export: wrote ${outFile.pathname}`);
