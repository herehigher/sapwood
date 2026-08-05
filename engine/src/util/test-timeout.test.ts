// #667: node's --test-timeout is diagnostic (a named verdict), not containment. It marks a
// hung test failed and prints `✖ <name> (<ms>ms)` on schedule, but the PROCESS keeps running if
// the hang left an active handle behind — the 2026-08-05 incident (a missing FakeForge stub ->
// driver.test.ts livelock) produced total silence because --test-timeout was 0 (off) by default,
// not because the flag can't report. Actual containment is the host's own Bash-call clamp
// (BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS), which SIGTERMs the whole process tree — this
// test only proves the verdict itself fires and is machine-parseable, then kills the child itself
// rather than relying on the flag to do it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CHILD_TIMEOUT_MS = 300;

// Same shape as the existing `waitFor` hang guard in worker.test.ts (#403/#430): a deliberately
// generous, documented bound around a real subprocess's own deterministic output, not a race
// between two independently-timed operations. It fails by name when it fires.
const waitFor = async (predicate: () => boolean, message: () => string, timeoutMs = 10_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("--test-timeout=<n> (#667): a hanging test gets a named, machine-parseable verdict on stdout, even though the child process outlives it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-test-timeout-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const fixture = join(dir, "hang.fixture.mjs");
    // The setInterval is the point: a bare unresolved promise doesn't hold Node's event loop
    // open by itself, so a process hung ONLY on that would exit on its own once the test runner
    // gives up on it. The incident's real hang held a live handle open, which is why the flag is
    // reporting-only and containment has to live one layer up, at the host.
    writeFileSync(
      fixture,
      [
        `import { test } from "node:test";`,
        `test("hangs forever", async () => {`,
        `  setInterval(() => {}, 60_000);`,
        `  await new Promise(() => {});`,
        `});`,
        "",
      ].join("\n"),
    );

    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (set by the outer `node --test` running THIS file)
    // inherit into the child's env by default and make node:test treat the child as a recursive
    // invocation of itself, silently skipping the fixture instead of running it — strip them so
    // the child runs as a genuinely independent `node --test` process.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;

    // Matches engine/package.json's `test` script invocation style (node --import tsx --test).
    // detached: true (same pattern as spawnClaudeSession in roles/worker.ts) so the kill below
    // can target the whole process group — node --test itself forks a grandchild to actually
    // run the isolated test file, and killing only this wrapper pid leaves that grandchild
    // running, exactly the grandchild-reaping problem this repo's own worker supervision solves.
    child = spawn(process.execPath, ["--import", "tsx", "--test", `--test-timeout=${CHILD_TIMEOUT_MS}`, fixture], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      detached: true,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    await waitFor(
      () => /✖ hangs forever \(\d+(\.\d+)?ms\)/.test(stdout),
      () => `expected a named timeout verdict for "hangs forever" in child stdout, got:\n${stdout}`,
    );
    assert.match(stdout, /✖ hangs forever \(\d+(\.\d+)?ms\)/);
  } finally {
    if (child?.pid != null) {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid -> the whole detached process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
