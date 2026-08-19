// Exercises bin/sapwood-plugin.sh's two branches without touching the network or a real
// npm/npx install: both branches spawn a fake stand-in (a fake engine/dist/cli.js, a fake
// npx on PATH) that just echoes its argv back, so the assertion is purely "did the wrapper
// choose the right branch and pass the right argv through."
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRAPPER_PATH = join(REPO_ROOT, "bin", "sapwood-plugin.sh");
const RUN_TIMEOUT_MS = 10_000;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("sh", [WRAPPER_PATH, ...args], { encoding: "utf8", timeout: RUN_TIMEOUT_MS, env });
}

test("sapwood-plugin.sh: a local engine/dist/cli.js is preferred — argv passed through unchanged", () => {
  const pluginRoot = tmpDir("sapwood-plugin-wrapper-dist-");
  try {
    const distDir = join(pluginRoot, "engine", "dist");
    mkdirSync(distDir, { recursive: true });
    // Echoes its own argv as JSON so the assertion below can tell exactly what the wrapper
    // passed through, not just that something ran.
    writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");

    const out = runWrapper(["status", "--foo", "bar"], { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot });
    assert.equal(out.trim(), JSON.stringify(["status", "--foo", "bar"]));
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: no local dist falls back to `npx --yes sapwood@<plugin.json version>`", () => {
  // One fixture root, allocated before the try — both subdirectories below are plain mkdirSync
  // calls under it, so there is only ever one tmpDir() that can fail to be cleaned up, and the
  // single `finally` below always covers whatever got created.
  const root = tmpDir("sapwood-plugin-wrapper-npx-");
  try {
    const pluginRoot = join(root, "plugin");
    const fakeBinDir = join(root, "bin");
    const manifestDir = join(pluginRoot, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify({ name: "sapwood", version: "9.9.9-test.1" }, null, 2));

    // A fake npx on PATH, ahead of any real one, that just echoes its argv — no network, no
    // real package resolution.
    const fakeNpxPath = join(fakeBinDir, "npx");
    writeFileSync(fakeNpxPath, '#!/bin/sh\necho "$@"\n');
    chmodSync(fakeNpxPath, 0o755);

    const out = runWrapper(["status", "--foo"], {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });
    assert.equal(out.trim(), "--yes sapwood@9.9.9-test.1 status --foo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: plugin.json at 0.0.0 (unreleased checkout) with no local dist refuses instead of calling npx", () => {
  const pluginRoot = tmpDir("sapwood-plugin-wrapper-unreleased-");
  try {
    const manifestDir = join(pluginRoot, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify({ name: "sapwood", version: "0.0.0" }, null, 2));

    // Deliberately no fake npx on PATH: the 0.0.0 guard must exit before the script's `exec npx`
    // line ever runs, so this test doesn't need to intercept that call — if the guard has a bug
    // and falls through anyway, the real `npx` on PATH (if any) would attempt a real network
    // fetch or fail differently, and the predicate below would not match either way.
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot };
    assert.throws(
      () => runWrapper(["status"], env),
      (e: unknown) => {
        const err = e as { status?: number | null; stderr?: string };
        return err.status === 1 && (err.stderr ?? "").includes("unreleased checkout (version 0.0.0)");
      },
    );
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: CLAUDE_PLUGIN_ROOT unset fails fast with a clear message, never falls through silently", () => {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  assert.throws(() => runWrapper(["status"], env));
});
