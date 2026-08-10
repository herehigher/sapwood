#!/usr/bin/env node
// start.ts (#743) — the tiny process entry `sapwood dashboard` (engine/src/cli.ts) spawns as a
// child: `node dist-server/start.js --db-path P --port N [--config C]` (build-server.mjs's own
// doc has the full "why bundled, not run as TypeScript source" rationale).
//
// Reports its outcome as ONE JSON line on stdout — `{"ok":true,"port":N}` or
// `{"ok":false,"code":"EADDRINUSE"|null,"message":"..."}` — so the parent CLI process can tell
// "listening" apart from "port already in use" without scraping human-facing log text. Nothing
// else ever writes to stdout from this process.
import { resolve } from "node:path";
import { loadConfig, type SapwoodConfig } from "../engine/src/config/config.js";
import { createDashboardServer } from "./server.js";

// #743 gate② finding: server.ts's own default static root is `join(import.meta.dirname, "dist")`
// — correct when server.ts runs from ITS OWN source location (dashboard/, a sibling of dashboard/
// dist/), which is still true for server.test.ts's direct unbundled import and stays unchanged.
// Once bundled, THIS file's `import.meta.dirname` denotes wherever the bundle actually sits
// (dashboard/dist-server/, one level DEEPER than dashboard/ — build-server.mjs's OUT_DIR), so
// leaving `staticDir` unset here would make server.ts look for the SPA under dashboard/dist-server/
// dist/, which vite never writes to, 404ing "/" even with a real build present. Pass it explicitly,
// computed relative to THIS file's own (post-bundle) runtime location rather than assumed.
const staticDir = resolve(import.meta.dirname, "..", "dist");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Writes the failure line and sets a nonzero exit code — deliberately NEVER `process.exit()`
 *  (#743 gate② finding): calling `exit()` immediately after `write()` can terminate the process
 *  before an async write to a PIPED stdout (this process's stdout, per dashboard-launcher.ts's own
 *  `stdio: ["ignore", "pipe", "inherit"]`) actually flushes to the parent, truncating the very
 *  message this exists to deliver. `exitCode` lets Node drain stdout naturally and exit once the
 *  event loop empties — nothing on any failure path below keeps it alive past this point (no
 *  server was ever started), so the process still exits promptly, just without racing the write. */
function failClosed(code: string | null, message: string): void {
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const dbPath = arg("--db-path");
  const portArg = arg("--port");
  const configPath = arg("--config");
  if (dbPath === undefined || portArg === undefined) {
    console.error("dashboard/start.ts: --db-path and --port are required");
    process.exitCode = 1;
    return;
  }

  // #743 (gate② finding): an explicit `--config` is authoritative — engine/src/cli.ts's own
  // `runDashboard` already validated it once in the parent process (the #710 contract every other
  // CLI command shares), but that check and this one are two SEPARATE process starts. Re-resolving
  // it HERE, strictly, and passing the loaded object straight into `createDashboardServer`'s
  // `config` option (rather than handing it `configPath` again for that function's own
  // best-effort internal load) closes the window where the file could go missing/invalid between
  // those two checks and the server would otherwise silently fall back to `config: null` —
  // dashboard/server.ts's normal degrade-gracefully posture is correct for every OTHER caller (an
  // omitted `--config`, or direct programmatic use), just not for this launcher path where the
  // operator explicitly named a file.
  let config: SapwoodConfig | undefined;
  if (configPath !== undefined) {
    try {
      config = loadConfig(configPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      failClosed(err.code ?? null, err.message);
      return;
    }
  }

  try {
    const { port } = await createDashboardServer({
      dbPath,
      ...(config !== undefined ? { config } : {}),
      port: Number(portArg),
      staticDir,
      now: () => new Date(),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, port })}\n`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    failClosed(err.code ?? null, err.message);
  }
}

await main();
