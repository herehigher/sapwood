// dashboard.test.ts (#743) — `sapwood dashboard`: the CLI verb that starts dashboard/server.ts
// and opens a browser at the served URL. Covers: flag/env parsing (--port, --config, the fail-
// closed conventions shared with run/status/events), the platform browser-opener argv (pure, no
// real execFile), the orchestration order (#710 config resolution -> port -> dashboard/dist
// bundle present -> start server -> open browser) via injected fakes (no real subprocess spawn),
// and — separately — real end-to-end checks that the actual child-process mechanism
// (dashboard/start.ts under `node --import tsx`) reports back the port it actually bound, both
// for an OS-assigned port and an explicit one, matching dashboard/server.ts:427's own contract.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDashboardArgs, parseDashboardPortFlag, resolveDashboardPort, runCli, runDashboard } from "../cli.js";
import { DEFAULT_DASHBOARD_PORT } from "../state/read-model.js";
import { State } from "../state/state.js";
import { type BrowserOpenResult, type DashboardServerHandle, openerArgv, startDashboardServer } from "./dashboard-launcher.js";

const MINIMAL_CONFIG = "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n";

/** Temp dir, cleaned up after `fn` (which may be async — the caller awaits this). */
async function withDataDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-cli-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A dashboard/dist stub that satisfies runDashboard's dist-present check without a real vite
 *  build — the check only probes for index.html's existence. */
function stubDist(dir: string): string {
  const distDir = join(dir, "dist-stub");
  mkdirSync(distDir, { recursive: true });
  const indexPath = join(distDir, "index.html");
  writeFileSync(indexPath, "<html></html>");
  return indexPath;
}

function fakeHandle(port: number): { handle: DashboardServerHandle; stopped: boolean[] } {
  const stopped: boolean[] = [];
  return { handle: { port, stop: () => stopped.push(true) }, stopped };
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
        dashboardDistIndex: stubDist(dir),
        log: () => {},
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(startedWith, { dbPath: "data/sapwood.sqlite", configPath, port: DEFAULT_DASHBOARD_PORT });
  });
});

test("runDashboard: missing dashboard/dist bundle — clear error naming the build command, never reaches startServer/openBrowser", async () => {
  await withDataDir(async (dir) => {
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
        dashboardDistIndex: join(dir, "dist", "index.html"), // deliberately never written
      },
    );
    assert.equal(code, 1);
    assert.equal(startCalls, 0);
    assert.equal(browserCalls, 0);
    const joined = lines.join("\n");
    assert.match(joined, /no dashboard build found/);
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
        dashboardDistIndex: stubDist(dir),
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

test("runDashboard: headless — browser cannot open, logs the URL and the message, exits 0 rather than crashing (AC2)", async () => {
  await withDataDir(async (dir) => {
    const { log, lines } = collectingLog();
    const { handle, stopped } = fakeHandle(4321);
    const code = await runDashboard(
      {},
      {
        log,
        startServer: async () => handle,
        openBrowser: async (): Promise<BrowserOpenResult> => ({ opened: false, reason: "no display" }),
        waitForStop: async () => {},
        dashboardDistIndex: stubDist(dir),
      },
    );
    assert.equal(code, 0);
    const joined = lines.join("\n");
    assert.match(joined, /http:\/\/127\.0\.0\.1:4321/);
    assert.match(joined, /no display/);
    assert.deepEqual(stopped, [true]); // the server is stopped on exit, not left dangling
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
        dashboardDistIndex: stubDist(dir),
        log: () => {},
      },
    );
    assert.equal(code, 0);
    assert.equal(openedUrl, "http://127.0.0.1:6001");
  });
});

// ── real end-to-end: the actual child-process mechanism reports back the bound port ────────
// (Tier A per #743's verification plan — loopback-only network, no display. Spawns the real
// `node --import tsx dashboard/start.ts` child; slower than the fakes above, so kept to the two
// cases the AC actually asks for: an OS-assigned port and an explicit one.)

function seedDb(dbPath: string): void {
  const s = new State(dbPath);
  s.close();
}

test("startDashboardServer (real, e2e): an OS-assigned port (0) resolves with the actual bound port", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const handle = await startDashboardServer({ dbPath, port: 0 });
    try {
      assert.ok(Number.isInteger(handle.port) && handle.port > 0, `expected a real bound port, got ${handle.port}`);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      assert.equal(res.status, 200);
    } finally {
      handle.stop();
    }
  });
});

test("startDashboardServer (real, e2e): a second bind on an already-occupied port rejects with EADDRINUSE, not a hang or a raw crash", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const first = await startDashboardServer({ dbPath, port: 0 });
    try {
      await assert.rejects(
        () => startDashboardServer({ dbPath, port: first.port }),
        (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE",
      );
    } finally {
      first.stop();
    }
  });
});

// #743 gate② finding [0]: the only other real-server test above binds port 0 (an OS-assigned
// port) — AC1's own verification plan asks for BOTH an unspecified port and an explicit one to be
// proven through the real listen callback, not just the unspecified case. Discover a genuinely
// free port the same way the EADDRINUSE test above reuses one (bind 0, release, reuse the number)
// rather than a hardcoded literal that could collide with something else already listening in CI.
test("startDashboardServer (real, e2e): an explicit nonzero --port resolves with that EXACT port, through the real child process", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const probe = await startDashboardServer({ dbPath, port: 0 });
    const explicitPort = probe.port;
    probe.stop();
    const handle = await startDashboardServer({ dbPath, port: explicitPort });
    try {
      assert.equal(handle.port, explicitPort);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      assert.equal(res.status, 200);
    } finally {
      handle.stop();
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
    const handle = await startDashboardServer({ dbPath, configPath, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/loop/state`);
      // biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
      const body = (await res.json()) as any;
      assert.equal(body.lanes.max, 9, "the served config must be the explicitly-named file's, not null or a different default");
    } finally {
      handle.stop();
    }
  });
});

test("startDashboardServer (real, e2e): an explicit --config naming a missing/invalid file fails the real server startup, never a silent config:null degrade", async () => {
  await withDataDir(async (dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    seedDb(dbPath);
    const missingConfigPath = join(dir, "does-not-exist.yaml");
    await assert.rejects(() => startDashboardServer({ dbPath, configPath: missingConfigPath, port: 0 }));
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
