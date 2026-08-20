// Exercises bin/sapwood-plugin.sh's two branches without touching the network or a real
// npm/npx install: both branches spawn a fake stand-in (a fake engine/dist/cli.js, a fake
// npx on PATH) that just echoes its argv back, so the assertion is purely "did the wrapper
// choose the right branch and pass the right argv through."
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRAPPER_PATH = join(REPO_ROOT, "bin", "sapwood-plugin.sh");
const RUN_TIMEOUT_MS = 10_000;

test("plugin CLI command docs invoke the shared wrapper with their matching verb", () => {
  for (const [file, verb] of [
    ["sapwood-run.md", "run"],
    ["sapwood-status.md", "status"],
    ["sapwood-dashboard.md", "dashboard"],
  ]) {
    const command = readFileSync(join(REPO_ROOT, "commands", file!), "utf8");
    assert.ok(command.includes(`sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" ${verb} $ARGUMENTS`));
  }
});

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("sh", [WRAPPER_PATH, ...args], { encoding: "utf8", timeout: RUN_TIMEOUT_MS, env });
}

test("sapwood-plugin.sh: a local engine/dist/cli.js is preferred — argv passed through unchanged for every wrapped command", () => {
  const pluginRoot = tmpDir("sapwood-plugin-wrapper-dist-");
  try {
    const distDir = join(pluginRoot, "engine", "dist");
    mkdirSync(distDir, { recursive: true });
    // Echoes its own argv as JSON so the assertion below can tell exactly what the wrapper
    // passed through, not just that something ran.
    writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");

    for (const [verb, ...args] of [
      ["run", "--dry-run"],
      ["status", "--foo", "bar"],
      ["dashboard", "--port", "9876"],
    ]) {
      const out = runWrapper([verb!, ...args], { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot });
      assert.equal(out.trim(), JSON.stringify([verb, ...args]));
    }
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: no local dist falls back to `npx --yes sapwood@<plugin.json version>` for every wrapped command", () => {
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

    for (const [verb, ...args] of [
      ["run", "--dry-run"],
      ["status", "--foo"],
      ["dashboard", "--port", "9876"],
    ]) {
      const out = runWrapper([verb!, ...args], {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });
      assert.equal(out.trim(), ["--yes", "sapwood@9.9.9-test.1", verb, ...args].join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: plugin.json at 0.0.0 (unreleased checkout) with no local dist refuses instead of calling npx", () => {
  // One fixture root: pluginRoot for the (missing) dist + manifest, bin for a fake npx that
  // proves — not just assumes — the refusal happens before `exec npx` ever runs.
  const root = tmpDir("sapwood-plugin-wrapper-unreleased-");
  try {
    const pluginRoot = join(root, "plugin");
    const fakeBinDir = join(root, "bin");
    const manifestDir = join(pluginRoot, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify({ name: "sapwood", version: "0.0.0" }, null, 2));

    // A fake npx, first on PATH, that would prove it ran (writes a marker file) and would fail
    // loudly if it did (non-zero exit) — either signal makes a regression that reaches this line
    // impossible to mistake for a pass. The marker file's absence after the call is the real
    // assertion that npx was never invoked, not just that the process exited 1 with our message.
    const npxMarker = join(root, "npx-was-called");
    const fakeNpxPath = join(fakeBinDir, "npx");
    writeFileSync(fakeNpxPath, `#!/bin/sh\ntouch "${npxMarker}"\nexit 1\n`);
    chmodSync(fakeNpxPath, 0o755);

    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    };
    assert.throws(
      () => runWrapper(["status"], env),
      (e: unknown) => {
        const err = e as { status?: number | null; stderr?: string };
        return err.status === 1 && (err.stderr ?? "").includes("unreleased checkout (version 0.0.0)");
      },
    );
    assert.equal(existsSync(npxMarker), false, "the 0.0.0 guard must exit before `exec npx` ever runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: a local dist takes priority even when plugin.json is at 0.0.0 — the refusal only guards the npx branch", () => {
  const pluginRoot = tmpDir("sapwood-plugin-wrapper-dist-at-0.0.0-");
  try {
    const distDir = join(pluginRoot, "engine", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");

    const manifestDir = join(pluginRoot, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify({ name: "sapwood", version: "0.0.0" }, null, 2));

    const out = runWrapper(["status", "--foo"], { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot });
    assert.equal(out.trim(), JSON.stringify(["status", "--foo"]));
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("sapwood-plugin.sh: CLAUDE_PLUGIN_ROOT unset fails fast with a clear message, never falls through silently", () => {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  assert.throws(() => runWrapper(["status"], env));
});
