// dashboard-launcher.ts (#743) — the ONLY child_process touchpoints `sapwood dashboard` needs:
// opening the platform browser, and spawning dashboard/dist-server/start.js as a child process.
// Split out of cli.ts (which otherwise stays exec-free) for the same reason worker.ts/gh.ts/
// materializer.ts/review/codex-exec.ts are: worker.test.ts's "#69 grep-invariant" enumerates the
// ONLY engine files allowed to `import ... from "node:child_process"` and fails closed on every
// other file — this module is the fifth, dashboard-scoped entry in that list (see that test's own
// update).
//
// The child runs a COMPILED entry, not TypeScript source: dashboard/server.ts's NodeNext `.js`
// import specifiers point at uncompiled TypeScript siblings (`../engine/src/config/config.js` etc
// — dashboard/tsconfig.server.json is typecheck-only, no build emits that path), so plain `node`
// cannot resolve them on its own (verified experimentally: ERR_MODULE_NOT_FOUND). An earlier
// version of this launcher worked around that with `node --import tsx`, which a gate② review
// correctly flagged as an undeclared/deviant runtime dependency (`tsx` is a dev tool, and the
// issue's own "yaml+zod only" runtime posture predates this feature). `dashboard/build-server.mjs`
// (run by `npm run build -w dashboard`, alongside the existing `vite build`) now bundles
// dashboard/start.ts — and everything it transitively imports from dashboard/server.ts and
// engine/src/** — into ONE self-contained plain-JS file at dashboard/dist-server/start.js, which
// this function spawns with a bare `node`, no loader flag, no `tsx` dependency of any kind at
// runtime. A missing dashboard/dist-server bundle is caught by engine/src/cli.ts's `runDashboard`
// BEFORE this function is ever called (same "run the build command" message that already covers
// the vite SPA bundle).
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  /** The real child process pid (#786) — exposed so a caller that needs to prove the child is
   *  actually gone (a test's own suite-wide leak sweep, never production logic) can check it
   *  directly, without reaching into this module's internals. */
  pid: number;
  /** Sends SIGTERM and resolves once the child has ACTUALLY exited (not just once the signal was
   *  sent) — a caller that wants to immediately reuse the same port (a restart, or this module's
   *  own tests rebinding on an explicit port) must wait for the OS to actually release the
   *  listening socket. An earlier version returned `void` here; a test that killed one server and
   *  immediately started another on the SAME port raced the first child's real exit against the
   *  second's bind attempt — the "timing-dependent assertion" class this repo's review doctrine
   *  bans, now closed with a real completion signal instead of a bigger margin (gate② finding). */
  stop: () => Promise<void>;
}

export interface DashboardAssetPaths {
  serverEntry: string;
  distIndex: string;
}

export interface DashboardAssetPathRoots {
  packageRoot?: string;
  repositoryDashboardRoot?: string;
}

function pairedAssets(root: string): DashboardAssetPaths | undefined {
  const assets = { serverEntry: join(root, "dist-server", "start.js"), distIndex: join(root, "dist", "index.html") };
  return existsSync(assets.serverEntry) && existsSync(assets.distIndex) ? assets : undefined;
}

function isSourceDashboard(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "@sapwood/dashboard";
  } catch {
    return false;
  }
}

/** Resolve the complete dashboard layout as one unit. A source checkout deliberately uses its
 * repository build even if a previous pack left its ignored staging directory behind: that tree
 * is packaging state, never a contributor runtime. An installed package has no sibling dashboard
 * workspace, so it selects its staged assets. */
export function dashboardAssetPaths(roots: DashboardAssetPathRoots = {}): DashboardAssetPaths | undefined {
  const packageRoot = roots.packageRoot ?? resolve(import.meta.dirname, "..", "..", "dashboard-dist");
  const repositoryDashboardRoot = roots.repositoryDashboardRoot ?? resolve(import.meta.dirname, "..", "..", "..", "dashboard");
  if (isSourceDashboard(repositoryDashboardRoot)) return pairedAssets(repositoryDashboardRoot);
  return pairedAssets(packageRoot) ?? pairedAssets(repositoryDashboardRoot);
}

export interface StartDashboardServerOpts {
  dbPath: string;
  configPath?: string;
  port: number;
  /** The server half of a layout `dashboardAssetPaths` selected with its paired SPA asset. */
  serverEntry?: string;
  /** Optional hook (#786 gate② finding [ac2-prehandle-leak]): fires SYNCHRONOUSLY the instant the
   *  child is spawned, before startup confirmation even begins — never only once the returned
   *  promise resolves. A caller that needs to track the real pid for its own leak-cleanup registry
   *  (a test, never production) must be able to do so before any `await` that could hang; waiting
   *  for the resolved `DashboardServerHandle.pid` misses exactly the case where startup itself
   *  hangs and the caller times out first, leaving the already-spawned child untracked. Never used
   *  by production code (cli.ts's runDashboard doesn't pass it). */
  onSpawn?: (pid: number) => void;
}

/** Spawns the bundled dashboard/dist-server/start.js (built from dashboard/start.ts, which calls
 *  dashboard/server.ts's own `createDashboardServer`) as a CHILD PROCESS — never a static `import`
 *  here, which would invert dashboard/server.ts's existing one-way `dashboard -> engine`
 *  dependency into a cycle (#743's own constraint: no `engine -> dashboard` static import anywhere
 *  reachable from engine/src/cli.ts). Plain `node`, no loader flag, argv array throughout, no
 *  shell involved anywhere — see dashboardServerEntryPath's doc for why a COMPILED entry exists at
 *  all rather than running start.ts's own TypeScript source directly.
 *
 *  The child reports its outcome as ONE JSON line on stdout — `{"ok":true,"port":N}` or
 *  `{"ok":false,"code":"EADDRINUSE"|null,"message":"..."}` — so this function can tell "listening"
 *  apart from "port already in use" without scraping human-facing log text; stderr is inherited
 *  so a real crash still surfaces in the operator's terminal. */
export function startDashboardServer(opts: StartDashboardServerOpts): Promise<DashboardServerHandle> {
  const entry = opts.serverEntry ?? dashboardAssetPaths()?.serverEntry;
  if (entry === undefined) return Promise.reject(new Error("no paired dashboard assets found"));
  const args = [entry, "--db-path", opts.dbPath, "--port", String(opts.port)];
  if (opts.configPath !== undefined) args.push("--config", opts.configPath);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (typeof child.pid === "number") opts.onSpawn?.(child.pid);

  function stop(): Promise<void> {
    // Already exited (e.g. it crashed on its own) — nothing to wait for, and attaching a listener
    // for an "exit" that already happened would wait forever.
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolveStop) => {
      child.once("exit", () => resolveStop());
      child.kill("SIGTERM");
    });
  }

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
        resolvePromise({ port: msg.port, pid: child.pid as number, stop });
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
