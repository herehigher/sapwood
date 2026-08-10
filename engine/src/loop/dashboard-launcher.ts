// dashboard-launcher.ts (#743) — the ONLY child_process touchpoints `sapwood dashboard` needs:
// opening the platform browser, and spawning dashboard/start.ts as a child process. Split out of
// cli.ts (which otherwise stays exec-free) for the same reason worker.ts/gh.ts/materializer.ts/
// review/codex-exec.ts are: worker.test.ts's "#69 grep-invariant" enumerates the ONLY engine
// files allowed to `import ... from "node:child_process"` and fails closed on every other file —
// this module is the fifth, dashboard-scoped entry in that list (see that test's own update).
//
// DELIBERATE dependency-posture exception (gate② finding, flagged for human confirmation): the
// child is spawned via `node --import tsx`, so `tsx` is now a real DEPENDENCY of
// engine/package.json (moved out of devDependencies), not just yaml+zod. This is required because
// dashboard/server.ts's NodeNext `.js` import specifiers point at uncompiled TypeScript siblings
// (`../engine/src/config/config.js` etc — dashboard/tsconfig.server.json is typecheck-only, no
// build emits that path) that plain `node` cannot resolve on its own (verified experimentally:
// ERR_MODULE_NOT_FOUND). The alternative — a real compiled `dist` entry for the dashboard server,
// so no loader is needed at all at runtime — is a separate, larger undertaking (a new
// engine-vs-dashboard build/import convention, not a fix-round-sized change) and is left as
// follow-up if this trade-off is rejected.
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

export interface BrowserOpenResult {
  opened: boolean;
  reason?: string;
}

/** The platform opener argv: darwin's `open`, Windows' `cmd /c start`, everything else's
 *  `xdg-open`. `start`'s first argument after the flag is read as a window TITLE by cmd's own
 *  quoting rules, so an empty title arg is required or a URL can be mis-parsed as the title.
 *  Takes `platform` as a parameter (default `process.platform`) so this stays a pure function a
 *  test can call for all three shapes without mocking global state. */
export function openerArgv(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

const pExecFile = promisify(execFile);

/** Real browser-open: an argv array through execFile, never a shell (SECURITY — same discipline
 *  as forge/gh.ts's own `gh` calls) — a URL is never at risk of shell interpretation. A missing
 *  opener binary (the expected headless/CI/Docker shape) rejects; caught and reported honestly,
 *  never thrown up to crash the CLI (AC2). */
export async function openBrowserReal(url: string): Promise<BrowserOpenResult> {
  const { cmd, args } = openerArgv(url);
  try {
    await pExecFile(cmd, args);
    return { opened: true };
  } catch (e) {
    return { opened: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface DashboardServerHandle {
  port: number;
  stop: () => void;
}

export interface StartDashboardServerOpts {
  dbPath: string;
  configPath?: string;
  port: number;
}

/** Spawns dashboard/start.ts (which calls dashboard/server.ts's own `createDashboardServer`) as a
 *  CHILD PROCESS — never a static `import` here, which would invert dashboard/server.ts's
 *  existing one-way `dashboard -> engine` dependency into a cycle (#743's own constraint: no
 *  `engine -> dashboard` static import anywhere reachable from engine/src/cli.ts). The child is
 *  `node --import tsx dashboard/start.ts ...`: dashboard/server.ts uses NodeNext-style `.js`
 *  import specifiers that point at TypeScript siblings (e.g. `../engine/src/config/config.js`,
 *  which is never compiled — dashboard/tsconfig.server.json is typecheck-only), so plain `node`
 *  cannot resolve them (verified: ERR_MODULE_NOT_FOUND) — tsx's loader is what makes that
 *  resolution work, the same way it already does for this repo's own test suites. Argv array
 *  throughout, no shell involved anywhere.
 *
 *  start.ts reports its outcome as ONE JSON line on stdout — `{"ok":true,"port":N}` or
 *  `{"ok":false,"code":"EADDRINUSE"|null,"message":"..."}` — so this function can tell "listening"
 *  apart from "port already in use" without scraping human-facing log text; stderr is inherited
 *  so a real crash still surfaces in the operator's terminal. */
export function startDashboardServer(opts: StartDashboardServerOpts): Promise<DashboardServerHandle> {
  const entry = resolve(import.meta.dirname, "..", "..", "..", "dashboard", "start.ts");
  const args = ["--import", "tsx", entry, "--db-path", opts.dbPath, "--port", String(opts.port)];
  if (opts.configPath !== undefined) args.push("--config", opts.configPath);
  // Argv array, no shell involved — same discipline as this function's own execFile call above.
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });

  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered += chunk.toString("utf8");
      const nl = buffered.indexOf("\n");
      if (nl === -1) return;
      settled = true;
      let msg: { ok: boolean; port?: number; code?: string | null; message?: string };
      try {
        msg = JSON.parse(buffered.slice(0, nl));
      } catch {
        child.kill("SIGTERM");
        reject(new Error("dashboard server produced an unreadable startup line"));
        return;
      }
      if (msg.ok && typeof msg.port === "number") {
        resolvePromise({ port: msg.port, stop: () => child.kill("SIGTERM") });
      } else {
        const err = new Error(msg.message ?? "dashboard server failed to start") as NodeJS.ErrnoException;
        if (msg.code) err.code = msg.code;
        child.kill("SIGTERM");
        reject(err);
      }
    });
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`dashboard server exited before starting (code ${code})`));
    });
  });
}

/** Resolves once the operator asks the dashboard to stop (Ctrl+C) — the default, real behavior of
 *  a long-running `sapwood dashboard` session, same shape as `sapwood run`'s own daemon lifetime. */
export function waitForStopSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const onSignal = () => resolvePromise();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
