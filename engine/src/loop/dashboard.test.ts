// dashboard.test.ts (#743) — `sapwood dashboard`: the CLI verb that starts dashboard/server.ts
// and opens a browser at the served URL. Covers: flag/env parsing (--port, --config, the fail-
// closed conventions shared with run/status/events), the platform browser-opener argv (pure, no
// real execFile), the orchestration order (#710 config resolution -> port -> dashboard/dist +
// compiled-server bundle present -> start server -> open browser) via injected fakes (no real
// subprocess spawn), and — separately — real end-to-end checks that the actual child-process
// mechanism (the compiled dashboard/dist-server/start.js, spawned with plain `node`) reports back
// the port it actually bound, both for an OS-assigned port and an explicit one, matching
// dashboard/server.ts:427's own contract.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseDashboardArgs, parseDashboardPortFlag, resolveDashboardPort, runCli, runDashboard } from "../cli.js";
import { DEFAULT_DASHBOARD_PORT } from "../state/read-model.js";
import { State } from "../state/state.js";
import {
  type BrowserOpenResult,
  type DashboardServerHandle,
  dashboardAssetPaths,
  openerArgv,
  startDashboardServer,
} from "./dashboard-launcher.js";

const MINIMAL_CONFIG = "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n";

const pExecFile = promisify(execFile);
const DASHBOARD_DIR = fileURLToPath(new URL("../../../dashboard", import.meta.url));

// The real end-to-end section below spawns the ACTUAL compiled dashboard/dist-server/start.js —
// including a request to "/", which needs the REAL vite SPA build (dashboard/dist/index.html) on
// disk to prove anything (a stub would just move the 404 site, not catch it). CI's own `npm
// --workspace engine test` step never runs `npm run build` for any workspace first
// (.github/workflows/ci.yml only typechecks/lints/tests), so this suite builds BOTH halves itself
// — the exact `npm run build -w dashboard` command (`vite build && node build-server.mjs`) an
// operator would run, just triggered as test setup instead of assumed pre-built.
before(async () => {
  await pExecFile("npm", ["run", "build"], { cwd: DASHBOARD_DIR });
});

// #786 gate② finding [ac3-unowned-process-match]: embedded in every dir this file creates (and
// therefore in the real dist-server child's own `--db-path` argv, since dbPath always lives under
// one of these dirs) so check-no-leaked-test-processes.ts can attribute a survivor to THIS run
// specifically — see worker.test.ts's REAP_TMP_PREFIX for the identical mechanism and rationale.
const DASHBOARD_CLI_TMP_PREFIX = `sapwood-dashboard-cli-${process.env.SAPWOOD_TEST_RUN_ID ?? String(process.pid)}-`;

/** Temp dir, cleaned up after `fn` (which may be async — the caller awaits this). */
async function withDataDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), DASHBOARD_CLI_TMP_PREFIX));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A dashboard/dist stub that satisfies runDashboard's dist-present check without a real vite
 *  build — the check only probes for index.html's existence. */
function stubAssets(dir: string): { distIndex: string; serverEntry: string } {
  const distDir = join(dir, "dist-stub");
  mkdirSync(distDir, { recursive: true });
  const indexPath = join(distDir, "index.html");
  writeFileSync(indexPath, "<html></html>");
  const entryPath = join(dir, "start-stub.js");
  writeFileSync(entryPath, "");
  return { distIndex: indexPath, serverEntry: entryPath };
}

function writePairedAssets(root: string): { distIndex: string; serverEntry: string } {
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "dist-server"), { recursive: true });
  const assets = { distIndex: join(root, "dist", "index.html"), serverEntry: join(root, "dist-server", "start.js") };
  writeFileSync(assets.distIndex, "<html></html>");
  writeFileSync(assets.serverEntry, "");
  return assets;
}

test("dashboardAssetPaths: installed package assets are selected when both files exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-assets-"));
  try {
    const packageRoot = join(dir, "package");
    const sourceRoot = join(dir, "not-a-source-checkout");
    const expected = writePairedAssets(packageRoot);
    assert.deepEqual(dashboardAssetPaths({ packageRoot, repositoryDashboardRoot: sourceRoot }), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardAssetPaths: contributor checkout assets win over stale packaging state", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-assets-"));
  try {
    const packageRoot = join(dir, "stale-package");
    const sourceRoot = join(dir, "dashboard");
    writePairedAssets(packageRoot);
    const expected = writePairedAssets(sourceRoot);
    writeFileSync(join(sourceRoot, "package.json"), '{"name":"@sapwood/dashboard"}\n');
    assert.deepEqual(dashboardAssetPaths({ packageRoot, repositoryDashboardRoot: sourceRoot }), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardAssetPaths: a half-built source candidate blocks fallback to staged package assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-assets-"));
  try {
    const packageRoot = join(dir, "package");
    const sourceRoot = join(dir, "dashboard");
    writePairedAssets(packageRoot);
    mkdirSync(join(sourceRoot, "dist"), { recursive: true });
    writeFileSync(join(sourceRoot, "package.json"), '{"name":"@sapwood/dashboard"}\n');
    writeFileSync(join(sourceRoot, "dist", "index.html"), "<html></html>");
    assert.equal(dashboardAssetPaths({ packageRoot, repositoryDashboardRoot: sourceRoot }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardAssetPaths: an unrelated node_modules/dashboard package cannot hide staged package assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-assets-"));
  try {
    const packageRoot = join(dir, "package");
    const sourceRoot = join(dir, "dashboard");
    const expected = writePairedAssets(packageRoot);
    writePairedAssets(sourceRoot);
    writeFileSync(join(sourceRoot, "package.json"), '{"name":"dashboard"}\n');
    assert.deepEqual(dashboardAssetPaths({ packageRoot, repositoryDashboardRoot: sourceRoot }), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardAssetPaths: a half-built candidate is never selected", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-assets-"));
  try {
    const packageRoot = join(dir, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "index.html"), "<html></html>");
    assert.equal(dashboardAssetPaths({ packageRoot, repositoryDashboardRoot: join(dir, "absent") }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeHandle(port: number): { handle: DashboardServerHandle; stopped: boolean[] } {
  const stopped: boolean[] = [];
  return { handle: { port, pid: -1, stop: async () => void stopped.push(true) }, stopped };
}

function collectingLog(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

// ── parseDashboardPortFlag / parseDashboardArgs ─────────────────────────────────────────────

test("parseDashboardPortFlag: parses a valid port", () => {
  assert.deepEqual(parseDashboardPortFlag(["--port", "8080"]), { rest: [], port: 8080 });
});

test("parseDashboardPortFlag: no --port present is a no-op", () => {
  assert.deepEqual(parseDashboardPortFlag(["--config", "x.yaml"]), { rest: ["--config", "x.yaml"] });
});

test("parseDashboardPortFlag: --port with no operand is an error, never a silent default", () => {
  assert.match(parseDashboardPortFlag(["--port"]).error ?? "", /--port requires a value/);
});

test("parseDashboardPortFlag: --port followed by a flag is an error, never consumed as a value", () => {
  assert.match(parseDashboardPortFlag(["--port", "--bogus"]).error ?? "", /--port requires a value/);
});

for (const bad of ["0", "65536", "abc", "3.5"]) {
  test(`parseDashboardPortFlag: rejects out-of-range/non-integer port ${JSON.stringify(bad)}`, () => {
    assert.match(parseDashboardPortFlag(["--port", bad]).error ?? "", /--port requires an integer between 1 and 65535/);
  });
}

// A leading "-" is indistinguishable from a flag under this file's shared value-taking
// convention (parseStopFlags/parseRunConfigFlag do the same) — "-1" is reported as a missing
// operand, not range-validated, same as an empty --port at the end of the line would be.
test('parseDashboardPortFlag: "-1" reads as a flag-shaped (missing) operand, not a range violation', () => {
  assert.match(parseDashboardPortFlag(["--port", "-1"]).error ?? "", /--port requires a value/);
});

test("parseDashboardArgs: --help/-h short-circuits before any flag validation", () => {
  assert.deepEqual(parseDashboardArgs(["node", "sapwood", "dashboard", "--help"]), { help: true });
  assert.deepEqual(parseDashboardArgs(["node", "sapwood", "dashboard", "-h"]), { help: true });
});

test("parseDashboardArgs: no flags at all — both configPath and port left undefined", () => {
  const parsed = parseDashboardArgs(["node", "sapwood", "dashboard"]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.configPath, undefined);
  assert.equal(parsed.port, undefined);
});

test("parseDashboardArgs: --port and --config combine, in either order", () => {
  const a = parseDashboardArgs(["node", "sapwood", "dashboard", "--port", "9001", "--config", "/tmp/c.yaml"]);
  assert.deepEqual(a, { help: false, configPath: "/tmp/c.yaml", port: 9001 });
  const b = parseDashboardArgs(["node", "sapwood", "dashboard", "--config", "/tmp/c.yaml", "--port", "9001"]);
  assert.deepEqual(b, { help: false, configPath: "/tmp/c.yaml", port: 9001 });
});

test("parseDashboardArgs: --config with no operand fails closed", () => {
  assert.match(parseDashboardArgs(["node", "sapwood", "dashboard", "--config"]).error ?? "", /--config requires a path/);
});

test("parseDashboardArgs: an unknown flag is rejected, never silently ignored", () => {
  assert.match(parseDashboardArgs(["node", "sapwood", "dashboard", "--bogus"]).error ?? "", /unknown argument\(s\): --bogus/);
});

// ── resolveDashboardPort ─────────────────────────────────────────────────────────────────────

test("resolveDashboardPort: an explicit flag always wins", () => {
  assert.deepEqual(resolveDashboardPort(9001, { SAPWOOD_DASHBOARD_PORT: "7000" }), { port: 9001 });
});

test("resolveDashboardPort: no flag, no env — the shared default (matches dashboard/server.ts's own bind default)", () => {
  assert.deepEqual(resolveDashboardPort(undefined, {}), { port: DEFAULT_DASHBOARD_PORT });
});

test("resolveDashboardPort: no flag, env set — env wins over the default", () => {
  assert.deepEqual(resolveDashboardPort(undefined, { SAPWOOD_DASHBOARD_PORT: "7000" }), { port: 7000 });
});

test("resolveDashboardPort: a malformed env value is a hard error, never a silent fallback to the default", () => {
  const r = resolveDashboardPort(undefined, { SAPWOOD_DASHBOARD_PORT: "not-a-port" });
  assert.match("error" in r ? r.error : "", /SAPWOOD_DASHBOARD_PORT must be an integer between 1 and 65535/);
});

// ── openerArgv (pure — no real execFile) ────────────────────────────────────────────────────

test("openerArgv: darwin uses `open`", () => {
  assert.deepEqual(openerArgv("http://127.0.0.1:4517", "darwin"), { cmd: "open", args: ["http://127.0.0.1:4517"] });
});

test("openerArgv: win32 uses `cmd /c start` with an empty title arg (so the URL is never read as the window title)", () => {
  assert.deepEqual(openerArgv("http://127.0.0.1:4517", "win32"), {
    cmd: "cmd",
    args: ["/c", "start", "", "http://127.0.0.1:4517"],
  });
});

test("openerArgv: linux and everything else falls back to `xdg-open`", () => {
  assert.deepEqual(openerArgv("http://127.0.0.1:4517", "linux"), { cmd: "xdg-open", args: ["http://127.0.0.1:4517"] });
  assert.deepEqual(openerArgv("http://127.0.0.1:4517", "freebsd"), { cmd: "xdg-open", args: ["http://127.0.0.1:4517"] });
});

// ── runCli wiring ────────────────────────────────────────────────────────────────────────────

test("runCli dashboard --help: prints usage, exit 0, never falls through to the async path", () => {
  const r = runCli(["node", "sapwood", "dashboard", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: sapwood dashboard/);
  assert.equal(r.validatedDashboard, undefined);
});

test("runCli dashboard --port abc: exit 1, error + usage on stderr, never the async fallthrough", () => {
  const r = runCli(["node", "sapwood", "dashboard", "--port", "abc"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--port requires an integer/);
  assert.match(r.stderr, /usage: sapwood dashboard/);
});

test("runCli dashboard: bare invocation signals the async path with an empty validated token", () => {
  const r = runCli(["node", "sapwood", "dashboard"]);
  assert.equal(r.code, -1);
  assert.deepEqual(r.validatedDashboard, {});
});

test("runCli dashboard --port 9001 --config /tmp/c.yaml: both flags carried into the validated token", () => {
  const r = runCli(["node", "sapwood", "dashboard", "--port", "9001", "--config", "/tmp/c.yaml"]);
  assert.equal(r.code, -1);
  assert.deepEqual(r.validatedDashboard, { configPath: "/tmp/c.yaml", port: 9001 });
});

// ── runDashboard orchestration (injected fakes — no real subprocess/execFile) ──────────────

test("runDashboard: an explicit --config that fails to load is a hard error — never reaches port/dist/server (#710 contract)", async () => {
  await withDataDir(async (dir) => {
    const missing = join(dir, "missing.yaml");
    let startCalls = 0;
    const { log, lines } = collectingLog();
    const code = await runDashboard(
      { configPath: missing },
      {
        log,
        startServer: async () => {
          startCalls++;
          return fakeHandle(4517).handle;
        },
      },
    );
    assert.equal(code, 1);
    assert.equal(startCalls, 0);
    assert.match(lines.join("\n"), /missing\.yaml/);
  });
});

test("runDashboard: a valid --config loads authoritatively and the run proceeds", async () => {
  await withDataDir(async (dir) => {
    const configPath = join(dir, "sapwood.config.yaml");
    writeFileSync(configPath, MINIMAL_CONFIG);
    let startedWith: unknown;
    const code = await runDashboard(
      { configPath },
      {
        startServer: async (opts) => {
          startedWith = opts;
          return fakeHandle(4517).handle;
        },
        openBrowser: async () => ({ opened: true }),
        waitForStop: async () => {},
        dashboardAssets: stubAssets(dir),
        log: () => {},
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(startedWith, {
      dbPath: ".sapwood/sapwood.sqlite",
      configPath,
      port: DEFAULT_DASHBOARD_PORT,
      serverEntry: join(dir, "start-stub.js"),
    });
  });
});

test("runDashboard: missing dashboard/dist bundle — clear error naming the build command, never reaches startServer/openBrowser", async () => {
  await withDataDir(async (_dir) => {
    let startCalls = 0;
    let browserCalls = 0;
    const { log, lines } = collectingLog();
    const code = await runDashboard(
      {},
      {
        log,
        startServer: async () => {
          startCalls++;
          return fakeHandle(4517).handle;
        },
        openBrowser: async () => {
          browserCalls++;
          return { opened: true };
        },
        dashboardAssets: null,
      },
    );
    assert.equal(code, 1);
    assert.equal(startCalls, 0);
    assert.equal(browserCalls, 0);
    const joined = lines.join("\n");
    assert.match(joined, /no paired dashboard build found/);
    assert.match(joined, /npm run build -w dashboard/);
  });
});

test("runDashboard: port already in use — names the port and the --port flag/env var, never a raw stack trace", async () => {
  await withDataDir(async (dir) => {
    let browserCalls = 0;
    const { log, lines } = collectingLog();
    const err = new Error("listen EADDRINUSE: address already in use 127.0.0.1:9001") as NodeJS.ErrnoException;
    err.code = "EADDRINUSE";
    const code = await runDashboard(
      { port: 9001 },
      {
        log,
        startServer: async () => {
          throw err;
        },
        openBrowser: async () => {
          browserCalls++;
          return { opened: true };
        },
        dashboardAssets: stubAssets(dir),
      },
    );
    assert.equal(code, 1);
    assert.equal(browserCalls, 0);
    const joined = lines.join("\n");
    assert.match(joined, /port 9001 is already in use/);
    assert.match(joined, /--port/);
    assert.match(joined, /SAPWOOD_DASHBOARD_PORT/);
  });
});

// #743 gate② finding [1]: the previous version of this test injected `waitForStop: async () =>
// {}` — an ALREADY-RESOLVED promise — which cannot distinguish the required behavior (the server
// stays alive until the operator's Ctrl+C) from a bug that stops it immediately after the
// browser-open failure. A deferred, manually-releasable seam makes the two distinguishable: assert
// runDashboard is still pending and the handle is still NOT stopped before the seam releases, only
// after. Deterministic seam control, not a real-timer race (review doctrine) — `setImmediate`
// drains the microtask queue so every already-resolved step ahead of `await waitForStop()` has run.
test("runDashboard: headless — the server stays alive until the stop seam resolves (Ctrl+C), not immediately after browser-open fails (AC2)", async () => {
  await withDataDir(async (dir) => {
    const { log, lines } = collectingLog();
    const { handle, stopped } = fakeHandle(4321);
    let releaseStop: (() => void) | undefined;
    const waitForStop = () =>
      new Promise<void>((resolveWait) => {
        releaseStop = resolveWait;
      });
    const resultPromise = runDashboard(
      {},
      {
        log,
        startServer: async () => handle,
        openBrowser: async (): Promise<BrowserOpenResult> => ({ opened: false, reason: "no display" }),
        waitForStop,
        dashboardAssets: stubAssets(dir),
      },
    );
    await new Promise((r) => setImmediate(r));
    assert.ok(releaseStop, "waitForStop must have been reached (every step ahead of it already resolved)");
    assert.deepEqual(stopped, [], "the server must not be stopped before the operator asks it to (Ctrl+C)");
    const joinedBeforeRelease = lines.join("\n");
    assert.match(joinedBeforeRelease, /http:\/\/127\.0\.0\.1:4321/);
    assert.match(joinedBeforeRelease, /no display/);
    assert.match(joinedBeforeRelease, /Ctrl\+C/);

    releaseStop?.();
    const code = await resultPromise;
    assert.equal(code, 0);
    assert.deepEqual(stopped, [true]);
  });
});

test("runDashboard: browser opens successfully — the opener is invoked with the exact served URL", async () => {
  await withDataDir(async (dir) => {
    let openedUrl: string | undefined;
    const { handle } = fakeHandle(6001);
    const code = await runDashboard(
      { port: 6001 },
      {
        startServer: async () => handle,
        openBrowser: async (url) => {
          openedUrl = url;
          return { opened: true };
        },
        waitForStop: async () => {},
        dashboardAssets: stubAssets(dir),
        log: () => {},
      },
    );
    assert.equal(code, 0);
    assert.equal(openedUrl, "http://127.0.0.1:6001");
  });
});

// ── real end-to-end: the actual child-process mechanism reports back the bound port ────────
// (Tier A per #743's verification plan — loopback-only network, no display. Spawns the real
// compiled dashboard/dist-server/start.js with plain `node` (built by this file's own `before`
// hook, above); slower than the fakes above, so kept to the cases the AC actually asks for.)

function seedDb(dbPath: string): void {
  const s = new State(dbPath);
  s.close();
}

// #786 (batch-12 close-out sweep): a suite-wide safety net for every real dist-server/start.js
// child the tests below spawn. Each test's own `finally` already awaits `handle.stop()` — but that
// line is unreachable if the test hangs on an earlier `await` (e.g. a stuck `fetch`) past
// `--test-timeout`: node:test reports a timed-out test as failed WITHOUT unwinding its still-
// pending promise chain, yet subsequent tests and this file's own `after()` hook still run
// (verified empirically against worker.test.ts's identical shape).
//
// #786 gate② finding [ac2-prehandle-leak]: tracking must begin at SPAWN time via `onSpawn`, not at
// promise-RESOLVE time — a resolve-time-only `.add()` misses the exact case where startup itself
// hangs and the caller times out before the resolved handle (and its `.pid`) ever arrives, leaving
// the already-spawned real child untracked and unreachable by `after()`.
const spawnedDashboardServerPids = new Set<number>();

/** The fallback sweep `after()` runs, extracted so a test can invoke it directly (see "exercises
 *  the after() fallback" below) and prove it actually finds + kills a tracked child, rather than
 *  trusting an untested code path to fire correctly only during a real, slow timeout — mirrors
 *  worker.test.ts's identical `sweepTermImmuneRegistry` (#786 gate② finding [ac2-timeout-fallback-
 *  untested]). Only untracks the pids it actually killed — a still-alive, still-owned entry (none
 *  should exist by the time `after()` calls this, but a mid-suite test-initiated call might have
 *  siblings) is left for its own owner to untrack via `waitForUntrackedDeath`/`.stop()`. */
function sweepDashboardServerRegistry(): number[] {
  const forceKilled: number[] = [];
  for (const pid of spawnedDashboardServerPids) {
    try {
      process.kill(pid, 0); // still alive? never signal a pid this check didn't just confirm
    } catch {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      forceKilled.push(pid);
    } catch {
      /* exited between the liveness check and here */
    }
  }
  for (const pid of forceKilled) spawnedDashboardServerPids.delete(pid);
  return forceKilled;
}

after(() => {
  // The sweep above always runs (cleanup is unconditional); this assertion only fires AFTER
  // cleanup, so it reports a real regression rather than masking one — every test's own `finally`
  // should already have reaped its own child via `handle.stop()`, so `after()` finding one still
  // alive means some test's own teardown didn't run (e.g. a hang past `--test-timeout`).
  const forceKilled = sweepDashboardServerRegistry();
  spawnedDashboardServerPids.clear();
  assert.deepEqual(
    forceKilled,
    [],
    `after() had to SIGKILL dashboard/dist-server/start.js pid(s) no test's own teardown reaped: ${forceKilled.join(", ")}`,
  );
});

/** For a call site that expects `startDashboardServer` to REJECT (no `DashboardServerHandle`, so
 *  no `.stop()` to await): dashboard-launcher.ts's own reject paths already fire `child.kill
 *  ("SIGTERM")` before rejecting, but fire-and-forget — the child may still be mid-shutdown when
 *  `assert.rejects` resolves. Named hang-guard poll (never a fixed sleep — this suite's own
 *  established idiom) for the signal-0 check to fail, THEN untrack, so this test's own teardown —
 *  not `after()`'s fallback — is what confirms and closes it out (#786 gate② finding [ac1-sigkill-
 *  teardown]'s same "deterministic, not fallback-only" requirement, applied to the reject path). */
async function waitForUntrackedDeath(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      spawnedDashboardServerPids.delete(pid);
      return;
    }
    await sleep(20);
  }
  throw new Error(`hang guard (${timeoutMs}ms): pid ${pid} never exited after its own reject-path SIGTERM`);
}

/** Wraps startDashboardServer so every real e2e test below tracks its child in the suite-wide
 *  registry above the INSTANT it's spawned (via `onSpawn`, #786 gate② finding [ac2-prehandle-
 *  leak] — never only once the startup promise resolves), and stops tracking it once `stop()` has
 *  actually confirmed the child exited. */
async function startTrackedDashboardServer(opts: Parameters<typeof startDashboardServer>[0]): Promise<DashboardServerHandle> {
  const handle = await startDashboardServer({ ...opts, onSpawn: (pid) => spawnedDashboardServerPids.add(pid) });
  return {
    ...handle,
    stop: async () => {
      await handle.stop();
      spawnedDashboardServerPids.delete(handle.pid);
    },
  };
}

// #786 gate② finding [ac2-timeout-fallback-untested]: invokes `sweepDashboardServerRegistry()` —
// the exact function `after()` calls — directly, against a real spawned dist-server/start.js child
// deliberately left tracked with nothing else about to reap it (standing in for a test whose own
// `finally`/`.stop()` never runs, e.g. a hang past `--test-timeout`), proving the fallback mechanism
// itself actually finds, kills, and untracks a survivor — without needing a real 60s hang.
test("sweepDashboardServerRegistry (#786): finds, SIGKILLs, and untracks a real dist-server child nothing else has reaped — the exact fallback after() relies on for a test that hung past its own teardown", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    let spawnedPid: number | undefined;
    const handle = await startDashboardServer({
      dbPath,
      port: 0,
      onSpawn: (pid) => {
        spawnedPid = pid;
        spawnedDashboardServerPids.add(pid);
      },
    });
    assert.equal(spawnedPid, handle.pid, "onSpawn must report the exact same pid the resolved handle carries");

    // Deliberately NO handle.stop() here — standing in for exactly what a hung test's own
    // unreachable `finally` looks like: the real child is alive and tracked, with nothing else
    // about to reap it, at the moment the sweep runs.
    const forceKilled = sweepDashboardServerRegistry();

    assert.deepEqual(forceKilled, [handle.pid], "the sweep must find and report this exact child, no more no less");
    // Confirms the sweep's SIGKILL actually ended it (SIGKILL delivery isn't synchronous) — reuses
    // the same bounded-poll-then-untrack helper the reject-path tests already trust for this.
    await waitForUntrackedDeath(handle.pid);
  });
});

test("startDashboardServer (real, e2e): an OS-assigned port (0) resolves with the actual bound port", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const handle = await startTrackedDashboardServer({ dbPath, port: 0 });
    try {
      assert.ok(Number.isInteger(handle.port) && handle.port > 0, `expected a real bound port, got ${handle.port}`);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      assert.equal(res.status, 200);
    } finally {
      await handle.stop();
    }
  });
});

// #743 gate② finding [0] (this round): bundling server.ts into dashboard/dist-server/start.js
// moves its `import.meta.dirname`-derived default static root one level deeper than where vite
// actually writes (dashboard/dist/) — start.ts now passes an explicit `staticDir` computed from
// its OWN post-bundle location to correct for that (start.ts's own doc has the full mechanics).
// The `/api/...` requests above never would have caught this — only a REAL request for the SPA
// shell proves the built UI is actually reachable, not just the API.
test("startDashboardServer (real, e2e): GET / serves the real built dashboard SPA (index.html), not a 404 from a mis-rooted static dir", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const handle = await startTrackedDashboardServer({ dbPath, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const body = await res.text();
      assert.match(body, /<!doctype html>/i, "expected the real vite-built index.html, not a 404 JSON error");
    } finally {
      await handle.stop();
    }
  });
});

test("startDashboardServer (real, e2e): a second bind on an already-occupied port rejects with EADDRINUSE, not a hang or a raw crash", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const first = await startTrackedDashboardServer({ dbPath, port: 0 });
    let secondPid: number | undefined;
    try {
      await assert.rejects(
        // #786 gate② finding [ac2-prehandle-leak]: `onSpawn` tracks the real child even on a
        // reject-bound call — a hang before EADDRINUSE is even decided would otherwise leave a
        // real spawned process untracked and unreachable by after().
        () =>
          startDashboardServer({
            dbPath,
            port: first.port,
            onSpawn: (pid) => {
              secondPid = pid;
              spawnedDashboardServerPids.add(pid);
            },
          }),
        (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE",
      );
    } finally {
      // #786 gate② finding [ac1-sigkill-teardown]: confirm the rejected second spawn's own
      // (already-fired) SIGTERM actually landed before this test's own teardown is done — closes
      // the exact race the file's `after()` assertion caught otherwise (fire-and-forget SIGTERM
      // inside dashboard-launcher.ts's reject path vs. this test finishing first).
      if (secondPid !== undefined) await waitForUntrackedDeath(secondPid);
      await first.stop();
    }
  });
});

// #743 gate② finding [0]: the only other real-server test above binds port 0 (an OS-assigned
// port) — AC1's own verification plan asks for BOTH an unspecified port and an explicit one to be
// proven through the real listen callback, not just the unspecified case. Discover a genuinely
// free port the same way the EADDRINUSE test above reuses one (bind 0, release, reuse the number)
// rather than a hardcoded literal that could collide with something else already listening in CI.
//
// #743 gate② finding [2]: `stop()` returning a real completion signal (dashboard-launcher.ts's own
// doc) is what makes reusing `explicitPort` immediately below SAFE — a fire-and-forget stop() that
// only sent SIGTERM without waiting for the child's actual exit raced this rebind against the OS
// releasing the old listening socket, the "timing-dependent assertion" class review doctrine bans.
// AWAITING stop() (not a bigger margin/sleep) is the fix: the port is only reused once it's real.
test("startDashboardServer (real, e2e): an explicit nonzero --port resolves with that EXACT port, through the real child process", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const probe = await startTrackedDashboardServer({ dbPath, port: 0 });
    const explicitPort = probe.port;
    await probe.stop();
    const handle = await startTrackedDashboardServer({ dbPath, port: explicitPort });
    try {
      assert.equal(handle.port, explicitPort);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      assert.equal(res.status, 200);
    } finally {
      await handle.stop();
    }
  });
});

// #743 gate② finding [1]: an explicit `--config` must be authoritative end-to-end through the
// REAL child process, not just at the parent-side `resolveCliConfig` check runDashboard's own
// (fake-injected) tests above cover — this proves the actual SERVED config is the named file's,
// and that a bad explicit path fails the real server startup rather than silently degrading to
// `config: null` (dashboard/server.ts's normal best-effort posture for an OMITTED --config).
test("startDashboardServer (real, e2e): an explicit --config is what's actually served, not a coincidentally-discoverable default or a silent null", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const configPath = join(dir, "sapwood.config.yaml");
    // lanes.max: 9 is a value nothing else in this fixture would produce by coincidence.
    writeFileSync(configPath, "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 9 }\ncost: { dailyBudgetUsd: 50 }\n");
    const handle = await startTrackedDashboardServer({ dbPath, configPath, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      // biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
      const body = (await res.json()) as any;
      assert.equal(body.lanes.max, 9, "the served config must be the explicitly-named file's, not null or a different default");
    } finally {
      await handle.stop();
    }
  });
});

test("startDashboardServer (real, e2e): an explicit --config naming a MISSING file fails the real server startup, never a silent config:null degrade", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const missingConfigPath = join(dir, "does-not-exist.yaml");
    // #786 gate② finding [ac2-prehandle-leak]: onSpawn tracks the real child before the reject
    // decision is even made.
    let spawnedPid: number | undefined;
    await assert.rejects(() =>
      startDashboardServer({
        dbPath,
        configPath: missingConfigPath,
        port: 0,
        onSpawn: (pid) => {
          spawnedPid = pid;
          spawnedDashboardServerPids.add(pid);
        },
      }),
    );
    // #786 gate② finding [ac1-sigkill-teardown]: confirm the rejected spawn's own (already-fired)
    // SIGTERM actually landed before this test's own teardown is done.
    if (spawnedPid !== undefined) await waitForUntrackedDeath(spawnedPid);
  });
});

// #743 gate② finding [1] (this round): the test above only ever named a MISSING path — AC3's
// "missing/invalid" also covers a config that EXISTS but fails schema validation (a real file, a
// real parse, a real Zod rejection), which is a genuinely different code path through loadConfig
// than ENOENT. `lanes.max: -1` is syntactically valid YAML (so this isn't retesting the missing-
// file case under a different name) but violates the schema (`z.number().int().positive()`).
test("startDashboardServer (real, e2e): an explicit --config naming a SCHEMA-INVALID file fails the real server startup, never a silent config:null degrade", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const invalidConfigPath = join(dir, "sapwood.config.yaml");
    writeFileSync(invalidConfigPath, "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: -1 }\n");
    // #786 gate② finding [ac2-prehandle-leak]: onSpawn tracks the real child before the reject
    // decision is even made.
    let spawnedPid: number | undefined;
    await assert.rejects(() =>
      startDashboardServer({
        dbPath,
        configPath: invalidConfigPath,
        port: 0,
        onSpawn: (pid) => {
          spawnedPid = pid;
          spawnedDashboardServerPids.add(pid);
        },
      }),
    );
    // #786 gate② finding [ac1-sigkill-teardown]: confirm the rejected spawn's own (already-fired)
    // SIGTERM actually landed before this test's own teardown is done.
    if (spawnedPid !== undefined) await waitForUntrackedDeath(spawnedPid);
  });
});

// ── structural: no engine module statically imports anything under dashboard/ (AC6) ────────

test("#743 AC6 (structural, dependency-direction): no engine/src module statically imports a dashboard/ path — an engine -> dashboard import would invert dashboard/server.ts's existing one-way dashboard -> engine dependency into a cycle", () => {
  const srcDir = new URL("../", import.meta.url); // engine/src/
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.includes("cli.ts") && files.includes("loop/dashboard-launcher.ts"), "sanity: the scan set includes the launcher files");
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), "utf8");
    // Real ESM import/re-export declarations (`import ... from "..."` / `export ... from "..."`),
    // spanning multi-line brace lists too (non-greedy up to the next `from "..."` after the
    // keyword) — not a bare substring grep, so a COMMENT mentioning "dashboard/server.ts" (there
    // are several, by design, in cli.ts and dashboard-launcher.ts) never false-positives here.
    const importStatements = src.match(/\b(?:import|export)\b[\s\S]*?\bfrom\s+["'][^"']+["']/g) ?? [];
    for (const stmt of importStatements) {
      const specifier = stmt.match(/from\s+["']([^"']+)["']/)?.[1];
      if (specifier && /(^|\/)dashboard\//.test(specifier)) offenders.push(`${f}: ${stmt.replace(/\s+/g, " ").trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "no engine/src module may statically import a dashboard/ path");
});
