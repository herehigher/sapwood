// pack.test.ts (#1032): proves the `engine` workspace is actually installable as the bare
// `sapwood` npm package on a machine with no clone of this repo — the delivery mechanism both
// `npm i -g sapwood@alpha` and the marketplace plugin's `npx sapwood@<version>` depend on.
// `npm pack` -> `npm install <tarball>` into a scratch prefix, then the installed binary is
// exercised exactly as an end user's shell would run it. Only the sapwood tarball itself is
// installed from a local file path; `--prefer-offline` keeps the two runtime deps (yaml, zod)
// from a redundant registry round-trip when they're already in npm's local cache — which they
// are here, since `npm ci` at the start of the same job/session already populated it. A truly
// cold cache (no prior `npm ci`) would still need network for those two deps; this test does
// not attempt to guarantee offline-from-scratch, only that it adds no NEW network dependency
// beyond what the surrounding job already pays for.
//
// Bounded, not timing-dependent: every subprocess call below carries its own `timeout` so one
// hung step fails fast and named, instead of the whole test silently riding out its own overall
// timeout with no indication of which step wedged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("packed engine tarball installs and runs as the `sapwood` npm package", { timeout: 300_000 }, () => {
  const packDir = mkdtempSync(join(tmpdir(), "sapwood-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "sapwood-install-"));
  try {
    // Rebuild first: a stale dist/ from a previous step would make this test pass for the wrong
    // reason (asserting yesterday's build is installable, not today's source).
    execFileSync("npm", ["run", "build", "--workspace", "engine"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 120_000 });
    execFileSync("npm", ["pack", "--workspace", "engine", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 60_000,
    });

    const manifestVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "engine", "package.json"), "utf8")) as { version: string }).version;
    const tarballPath = join(packDir, `sapwood-${manifestVersion}.tgz`);
    assert.ok(existsSync(tarballPath), `expected \`npm pack\` to produce ${tarballPath}`);

    execFileSync(
      "npm",
      ["install", "--prefix", installDir, tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
      { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 },
    );

    const installedRoot = join(installDir, "node_modules", "sapwood");
    const cliPath = join(installedRoot, "dist", "cli.js");
    assert.ok(existsSync(cliPath), "installed package is missing dist/cli.js (the `sapwood` bin entry)");
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

    // execFileSync throws on a non-zero exit, so reaching either assertion below already proves
    // the process exited 0 — a separate status check would only restate that.
    const versionOut = execFileSync("node", [cliPath, "--version"], { encoding: "utf8", timeout: 15_000 }).trim();
    assert.equal(versionOut, manifestVersion, "`sapwood --version` must print the packed manifest's version");

    const helpOut = execFileSync("node", [cliPath, "--help"], { encoding: "utf8", timeout: 15_000 });
    assert.match(helpOut, /usage: sapwood/);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});
