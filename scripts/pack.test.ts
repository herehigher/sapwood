// pack.test.ts (#1032): proves the engine is packed from a clean checkout, then installed as the
// bare `sapwood` package into a temporary global prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("packed engine tarball is fresh, map-free, and runnable from a clean checkout", { timeout: 600_000 }, () => {
  const checkoutParent = mkdtempSync(join(tmpdir(), "sapwood-pack-checkout-"));
  const checkoutDir = join(checkoutParent, "repo");
  const packDir = mkdtempSync(join(tmpdir(), "sapwood-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "sapwood-install-"));
  const npmCacheDir = mkdtempSync(join(tmpdir(), "sapwood-npm-cache-"));
  const npmEnv = { ...process.env, npm_config_cache: npmCacheDir };
  let checkoutAdded = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", checkoutDir, "HEAD"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 });
    checkoutAdded = true;
    assert.equal(existsSync(join(checkoutDir, "engine", "dist")), false, "the staged checkout must start without build output");
    execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: checkoutDir, env: npmEnv, stdio: "pipe", timeout: 180_000 });

    const staleOutput = join(checkoutDir, "engine", "dist", "review-stale.js");
    mkdirSync(dirname(staleOutput), { recursive: true });
    writeFileSync(staleOutput, "export default 'stale';\n");
    execFileSync("npm", ["pack", "--workspace", "engine", "--pack-destination", packDir], {
      cwd: checkoutDir,
      env: npmEnv,
      stdio: "pipe",
      timeout: 180_000,
    });

    const manifestVersion = (JSON.parse(readFileSync(join(checkoutDir, "engine", "package.json"), "utf8")) as { version: string }).version;
    const tarballPath = join(packDir, `sapwood-${manifestVersion}.tgz`);
    assert.ok(existsSync(tarballPath), `expected \`npm pack\` to produce ${tarballPath}`);
    const tarEntries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", timeout: 15_000 }).trim().split("\n");
    assert.equal(tarEntries.includes("package/dist/review-stale.js"), false, "prepack must remove stale dist output before building");
    assert.equal(tarEntries.some((entry) => entry.endsWith(".map")), false, "the published tarball must not contain source maps");

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
    assert.match(execFileSync(binPath, ["validate", validConfig], { cwd: installDir, encoding: "utf8", timeout: 15_000 }), /sapwood validate: OK/);
  } finally {
    if (checkoutAdded) execFileSync("git", ["worktree", "remove", "--force", checkoutDir], { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 });
    rmSync(checkoutParent, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
});
