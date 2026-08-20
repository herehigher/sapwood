// pack.test.ts (#1032): proves the engine is packed from a clean checkout, then installed as the
// bare `sapwood` package into a temporary global prefix.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { availableDashboardPort, runDashboardCanary } from "./dashboard-canary.ts";
import { bundledDashboardDependencies } from "../engine/scripts/generate-third-party-notices.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function assertCleanWorkspaceDashboardLaunch(checkoutDir: string): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "sapwood-clean-dashboard-cwd-"));
  const dbPath = join(cwd, "data", "sapwood.sqlite");
  const port = await availableDashboardPort();
  const child = spawn(process.execPath, [join(checkoutDir, "dashboard", "dist-server", "start.js"), "--db-path", dbPath, "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  try {
    const actualPort = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`clean workspace dashboard did not start:\n${output}`)), 30_000);
      const inspect = () => {
        const match = /\{"ok":true,"port":(\d+)\}/.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolvePromise(Number(match[1]));
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`clean workspace dashboard exited before readiness (code ${code}):\n${output}`));
      });
      inspect();
    });
    assert.equal(actualPort, port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/events`)).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("packed engine tarball is fresh, map-free, and runnable from a clean checkout", { timeout: 600_000 }, async () => {
  const checkoutParent = mkdtempSync(join(tmpdir(), "sapwood-pack-checkout-"));
  const checkoutDir = join(checkoutParent, "repo");
  const packDir = mkdtempSync(join(tmpdir(), "sapwood-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "sapwood-install-"));
  const npmCacheDir = mkdtempSync(join(tmpdir(), "sapwood-npm-cache-"));
  const npmEnv = { ...process.env, npm_config_cache: npmCacheDir };
  let checkoutAdded = false;
  try {
    execFileSync("git", ["init", "-q"], { cwd: installDir, stdio: "pipe", timeout: 15_000 });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "unrelated",
      ],
      { cwd: installDir, stdio: "pipe", timeout: 15_000 },
    );
    execFileSync("git", ["worktree", "add", "--detach", checkoutDir, "HEAD"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 });
    checkoutAdded = true;
    assert.equal(existsSync(join(checkoutDir, "engine", "dist")), false, "the staged checkout must start without build output");
    execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: checkoutDir, env: npmEnv, stdio: "pipe", timeout: 180_000 });
    // The dashboard server deliberately leaves yaml/zod external. This launch immediately after
    // clean `npm ci` proves its workspace runtime dependencies resolve, rather than accidentally
    // passing only with a pre-lockfile-change node_modules tree.
    execFileSync("npm", ["run", "build", "--workspace", "dashboard"], { cwd: checkoutDir, env: npmEnv, stdio: "pipe", timeout: 180_000 });
    await assertCleanWorkspaceDashboardLaunch(checkoutDir);

    const staleInputs = [
      join(checkoutDir, "engine", "dist", "review-stale-engine.js"),
      join(checkoutDir, "dashboard", "dist", "review-stale-dashboard.js"),
      join(checkoutDir, "dashboard", "dist-server", "review-stale-server.js"),
      join(checkoutDir, "engine", "dashboard-dist", "review-stale-staged.js"),
    ];
    for (const staleInput of staleInputs) {
      mkdirSync(dirname(staleInput), { recursive: true });
      writeFileSync(staleInput, "export default 'stale';\n");
    }
    const packOutput = execFileSync("npm", ["pack", "--json", "--workspace", "engine", "--pack-destination", packDir], {
      cwd: checkoutDir,
      env: npmEnv,
      encoding: "utf8",
      timeout: 180_000,
    });
    // `release.ts stamp` intentionally reports the fresh stamp on stdout during prepack; npm's
    // JSON manifest is therefore the final JSON value rather than the entire command output.
    const manifestOffset = packOutput.lastIndexOf("\n[");
    assert.ok(manifestOffset !== -1, "npm pack --json did not emit a manifest array");
    const packManifest = JSON.parse(packOutput.slice(manifestOffset + 1)) as Array<{
      files?: Array<{ path: string }>;
      unpackedSize?: number;
    }>;

    const manifestVersion = (JSON.parse(readFileSync(join(checkoutDir, "engine", "package.json"), "utf8")) as { version: string }).version;
    const tarballPath = join(packDir, `sapwood-${manifestVersion}.tgz`);
    assert.ok(existsSync(tarballPath), `expected \`npm pack\` to produce ${tarballPath}`);
    const tarEntries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", timeout: 15_000 }).trim().split("\n");
    for (const staleInput of staleInputs) {
      const staleName = staleInput.slice(checkoutDir.length + 1);
      assert.equal(
        tarEntries.some((entry) => entry.endsWith(staleName.slice(staleName.indexOf("/") + 1))),
        false,
        `prepack must remove stale ${staleName} before staging`,
      );
    }
    assert.equal(
      tarEntries.some((entry) => entry.endsWith(".map")),
      false,
      "the published tarball must not contain source maps",
    );
    const packed = packManifest[0];
    assert.ok(packed, "npm pack --json must report one package manifest");
    const packedFiles = new Set(packed.files?.map((file) => file.path));
    for (const required of ["dashboard-dist/dist/index.html", "dashboard-dist/dist-server/start.js", "THIRD_PARTY_NOTICES"]) {
      assert.ok(packedFiles.has(required), `npm pack manifest is missing ${required}`);
    }
    const notices = execFileSync("tar", ["-xOzf", tarballPath, "package/THIRD_PARTY_NOTICES"], { encoding: "utf8", timeout: 15_000 });
    assert.match(notices, /Vite's optimized SPA output does not retain dependency @license banners/);
    // Rebuild only to recover the two bundles' input metadata. The staged package has already
    // been created above; this asserts the notice CONTENT against every package Vite/esbuild
    // actually bundled, not merely that a notice file happened to be included.
    execFileSync("npm", ["run", "build", "--workspace", "dashboard"], { cwd: checkoutDir, env: npmEnv, stdio: "pipe", timeout: 180_000 });
    for (const dependency of bundledDashboardDependencies(checkoutDir)) {
      assert.ok(notices.includes(`## ${dependency.name}@${dependency.version}`), `notice omits bundled ${dependency.name}`);
      for (const copyrightLine of dependency.copyrightLines) {
        assert.ok(notices.includes(copyrightLine), `notice omits ${dependency.name}'s copyright line: ${copyrightLine}`);
      }
    }
    assert.equal(
      [...packedFiles].some((path) => path.endsWith(".map")),
      false,
      "npm pack manifest must not contain source maps",
    );
    // The dashboard's static payload is about 1.1 MiB today; 10 MiB leaves room for deliberate UI
    // growth while still catching an accidental node_modules/source-tree inclusion.
    assert.ok(
      (packed.unpackedSize ?? Infinity) <= 10_000_000,
      `unpacked size ${packed.unpackedSize} exceeds the 10,000,000-byte package ceiling`,
    );
    assert.equal(existsSync(join(checkoutDir, "engine", "dashboard-dist")), false, "postpack must remove its owned staging tree");

    execFileSync(
      "npm",
      ["install", "--global", "--prefix", installDir, tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
      { cwd: checkoutDir, env: npmEnv, stdio: "pipe", timeout: 120_000 },
    );

    const installedRoot = join(installDir, "lib", "node_modules", "sapwood");
    const cliPath = join(installedRoot, "dist", "cli.js");
    const binPath = join(installDir, "bin", "sapwood");
    assert.ok(existsSync(cliPath), "installed package is missing dist/cli.js (the `sapwood` bin entry)");
    assert.ok(existsSync(binPath), "installed package is missing the `sapwood` bin link");
    assert.ok(
      existsSync(join(installedRoot, "dist", "guard", "guard-hook.js")),
      "installed package is missing the guard hook — a worker session's PreToolUse guard would silently not run",
    );
    assert.ok(existsSync(join(installedRoot, "prompts", "worker.md")), "installed package is missing a shipped role prompt");

    const installedExample = join(installedRoot, "sapwood.config.example.yaml");
    assert.equal(readFileSync(installedExample, "utf8"), readFileSync(join(checkoutDir, "sapwood.config.example.yaml"), "utf8"));
    const validConfig = join(installDir, "sapwood.config.yaml");
    writeFileSync(validConfig, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 1\nreviewer:\n  mode: human\n");

    const versionOut = execFileSync(binPath, ["--version"], { cwd: installDir, encoding: "utf8", timeout: 15_000 }).trim();
    assert.match(versionOut, new RegExp(`^${manifestVersion.replaceAll(".", "\\.")}\\+\\d{8}\\.[0-9a-f]{7}$`));
    assert.match(execFileSync(binPath, ["init", "--help"], { cwd: installDir, encoding: "utf8", timeout: 15_000 }), /usage: sapwood init/);
    assert.match(
      execFileSync(binPath, ["validate", validConfig], { cwd: installDir, encoding: "utf8", timeout: 15_000 }),
      /sapwood validate: OK/,
    );

    const canaryDir = mkdtempSync(join(tmpdir(), "sapwood-dashboard-canary-"));
    try {
      const port = await availableDashboardPort();
      const canary = await runDashboardCanary({
        command: binPath,
        args: ["dashboard", "--port", String(port)],
        cwd: canaryDir,
        env: npmEnv,
        timeoutMs: 30_000,
      });
      assert.match(canary.output, /serving at http:\/\/127\.0\.0\.1:/);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  } finally {
    if (checkoutAdded)
      execFileSync("git", ["worktree", "remove", "--force", checkoutDir], { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 });
    rmSync(checkoutParent, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
});
