#!/usr/bin/env node
// start.ts (#743) — the tiny process entry `sapwood dashboard` (engine/src/cli.ts) spawns as a
// child: `node --import tsx start.ts --db-path P --port N [--config C]`. A child, not a static
// import, because dashboard/server.ts's NodeNext `.js` import specifiers point at TypeScript
// siblings (e.g. `../engine/src/config/config.js`, never compiled — tsconfig.server.json is
// noEmit-only) that plain `node` cannot resolve; tsx's loader is what makes that resolution work,
// the same way it already does for this repo's own test suites.
//
// Reports its outcome as ONE JSON line on stdout — `{"ok":true,"port":N}` or
// `{"ok":false,"code":"EADDRINUSE"|null,"message":"..."}` — so the parent CLI process can tell
// "listening" apart from "port already in use" without scraping human-facing log text. Nothing
// else ever writes to stdout from this process.
import { createDashboardServer } from "./server.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dbPath = arg("--db-path");
const portArg = arg("--port");
const configPath = arg("--config");
if (dbPath === undefined || portArg === undefined) {
  console.error("dashboard/start.ts: --db-path and --port are required");
  process.exit(1);
}

try {
  const { port } = await createDashboardServer({
    dbPath,
    ...(configPath !== undefined ? { configPath } : {}),
    port: Number(portArg),
    now: () => new Date(),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, port })}\n`);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? null, message: err.message })}\n`);
  process.exit(1);
}
