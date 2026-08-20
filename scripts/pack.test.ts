// pack.test.ts (#1032): proves the `engine` workspace is actually installable as the bare
// `sapwood` npm package on a machine with no clone of this repo — the delivery mechanism both
// `npm i -g sapwood@alpha` and the marketplace plugin's `npx sapwood@<version>` depend on.
// `npm pack` -> `npm install <tarball>` into a scratch prefix, then the installed binary is
// exercised exactly as an end user's shell would run it. The test owns the npm cache it uses, so
// npm's logs and metadata do not leak into the developer's home directory.
//
// Bounded, not timing-dependent: every subprocess call below carries its own `timeout` so one
// hung step fails fast and named, instead of the whole test silently riding out its own overall
// timeout with no indication of which step wedged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("packed engine tarball installs and runs as the `sapwood` npm package", { timeout: 300_000 }, () => {
  const packDir = mkdtempSync(join(tmpdir(), "sapwood-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "sapwood-install-"));
  const npmCacheDir = mkdtempSync(join(tmpdir(), "sapwood-npm-cache-"));
  const npmEnv = { ...process.env, npm_config_cache: npmCacheDir };
  try {
    // Rebuild first: a stale dist/ from a previous step would make this test pass for the wrong
    // reason (asserting yesterday's build is installable, not today's source).
    execFileSync("npm", ["run", "build", "--workspace", "engine"], { cwd: REPO_ROOT, env: npmEnv, stdio: "pipe", timeout: 120_000 });
    execFileSync("npm", ["run", "release", "--", "stamp"], { cwd: REPO_ROOT, env: npmEnv, stdio: "pipe", timeout: 15_000 });
    execFileSync("npm", ["pack", "--workspace", "engine", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      env: npmEnv,
      stdio: "pipe",
      timeout: 60_000,
    });

    const manifestVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "engine", "package.json"), "utf8")) as { version: string }).version;
    const tarballPath = join(packDir, `sapwood-${manifestVersion}.tgz`);
    assert.ok(existsSync(tarballPath), `expected \`npm pack\` to produce ${tarballPath}`);

    execFileSync(
      "npm",
      ["install", "--global", "--prefix", installDir, tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
      { cwd: REPO_ROOT, env: npmEnv, stdio: "pipe", timeout: 60_000 },
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

    // `prepack` (engine/package.json) copies the repo-root example in before packing —
    // byte-equal, not just present, so a stale/hand-edited package-local copy would fail loud.
    const installedExample = join(installedRoot, "sapwood.config.example.yaml");
    assert.ok(existsSync(installedExample), "installed package is missing sapwood.config.example.yaml (prepack should have copied it in)");
    assert.equal(
      readFileSync(installedExample, "utf8"),
      readFileSync(join(REPO_ROOT, "sapwood.config.example.yaml"), "utf8"),
      "installed sapwood.config.example.yaml must be byte-equal to the repo-root source of truth",
    );
    const validConfig = join(installDir, "sapwood.config.yaml");
    writeFileSync(validConfig, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 1\nreviewer:\n  mode: human\n");

    // execFileSync throws on a non-zero exit, so reaching the assertions below already proves
    // the process exited 0 — a separate status check would only restate that.
    const versionOut = execFileSync(binPath, ["--version"], { cwd: installDir, encoding: "utf8", timeout: 15_000 }).trim();
    assert.match(versionOut, new RegExp(`^${manifestVersion.replaceAll(".", "\\.")}\\+\\d{8}\\.[0-9a-f]{7}$`));

    const initHelpOut = execFileSync(binPath, ["init", "--help"], { cwd: installDir, encoding: "utf8", timeout: 15_000 });
    assert.match(initHelpOut, /usage: sapwood init/);

    const validateOut = execFileSync(binPath, ["validate", validConfig], { cwd: installDir, encoding: "utf8", timeout: 15_000 });
    assert.match(validateOut, /sapwood validate: OK/);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
});
