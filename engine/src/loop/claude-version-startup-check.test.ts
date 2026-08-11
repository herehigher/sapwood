// claude-version-startup-check.test.ts (#799): pins the three arms the issue names (ok /
// below-floor / indeterminate — including the boundary-inclusive floor and BOTH failure shapes
// that must collapse to indeterminate), the drift test tying MIN_CLAUDE_CLI_VERSION to the two
// doc files, that exactly one durable event fires per run with the right arm/installed/floor
// payload, that the probe argv structurally cannot become a paid call, and that a throwing/
// hanging probe still resolves without ever blocking the caller — patterned on
// deploy-key-startup-check.test.ts, which already injects a fake preflight rather than
// constructing a real supervisor.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MIN_CLAUDE_CLI_VERSION } from "../roles/worker.js";
import {
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  type ClaudeVersionProbeResult,
  detectClaudeVersionStartupTier,
  parseClaudeVersion,
  probeClaudeVersion,
} from "./claude-version-startup-check.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function fakeState(): { events: Array<[string, unknown]>; appendEvent: (kind: string, payload: unknown) => void } {
  const events: Array<[string, unknown]> = [];
  return { events, appendEvent: (kind, payload) => events.push([kind, payload]) };
}

// ── AC1/AC2: the drift test ─────────────────────────────────────────────────────────────────
test("AC1/AC2: MIN_CLAUDE_CLI_VERSION, docs/getting-started.md, and docs/configuration.md all state the exact same version", () => {
  const gettingStarted = readFileSync(join(REPO_ROOT, "docs/getting-started.md"), "utf8");
  const configuration = readFileSync(join(REPO_ROOT, "docs/configuration.md"), "utf8");
  assert.ok(
    gettingStarted.includes(MIN_CLAUDE_CLI_VERSION),
    `docs/getting-started.md must state the exact floor "${MIN_CLAUDE_CLI_VERSION}" (real file, not a fixture)`,
  );
  assert.ok(
    configuration.includes(MIN_CLAUDE_CLI_VERSION),
    `docs/configuration.md must state the exact floor "${MIN_CLAUDE_CLI_VERSION}" (real file, not a fixture)`,
  );
});

test("MIN_CLAUDE_CLI_VERSION itself parses as a dotted major.minor.patch triple", () => {
  assert.deepEqual(parseClaudeVersion(MIN_CLAUDE_CLI_VERSION), MIN_CLAUDE_CLI_VERSION.split(".").map(Number));
});

// ── AC4: three arms ──────────────────────────────────────────────────────────────────────────
const probeOf = (result: ClaudeVersionProbeResult): ((bin: string) => Promise<ClaudeVersionProbeResult>) => {
  return async () => result;
};

test("AC4: a version above the floor -> ok", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.5.0 (Claude Code)\n" }),
  });
  assert.deepEqual(result, { arm: "ok", installed: "2.5.0", floor: "2.1.209" });
});

test("AC4: the floor exactly -> ok (boundary inclusive)", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.209\n" }),
  });
  assert.deepEqual(result, { arm: "ok", installed: "2.1.209", floor: "2.1.209" });
});

test("AC4: a version below the floor -> below-floor, never ok", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.0.5\n" }),
  });
  assert.deepEqual(result, { arm: "below-floor", installed: "2.0.5", floor: "2.1.209" });
});

test("AC4: a non-zero exit -> indeterminate, never ok, never below-floor", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: false, detail: "version probe exited 1: error: unknown option '--version'" }),
  });
  assert.deepEqual(result, { arm: "indeterminate", floor: "2.1.209" });
});

test("AC4: unparseable stdout -> indeterminate, never ok, never below-floor", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "not a version\n" }),
  });
  assert.deepEqual(result, { arm: "indeterminate", floor: "2.1.209" });
});

// ── AC5: both channels, once ────────────────────────────────────────────────────────────────
test("AC5: ok arm — one log line naming the version, no guidance, one event carrying arm/installed/floor", async () => {
  const state = fakeState();
  const logs: string[] = [];
  await detectClaudeVersionStartupTier("claude", state, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.209\n" }),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /2\.1\.209/);
  assert.doesNotMatch(logs[0]!, /upgrade/i, "the ok arm carries no upgrade guidance");
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0], ["claude-cli-version-checked", { arm: "ok", floor: "2.1.209", installed: "2.1.209" }]);
});

test("AC5: below-floor arm — one log line with actionable upgrade guidance, one event", async () => {
  const state = fakeState();
  const logs: string[] = [];
  await detectClaudeVersionStartupTier("claude", state, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "1.9.0\n" }),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /BELOW/);
  assert.match(logs[0]!, /npm i -g @anthropic-ai\/claude-code@latest/);
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0], ["claude-cli-version-checked", { arm: "below-floor", floor: "2.1.209", installed: "1.9.0" }]);
});

test("AC5: indeterminate arm — one log line saying 'could not determine', with guidance, no installed field in the event", async () => {
  const state = fakeState();
  const logs: string[] = [];
  await detectClaudeVersionStartupTier("claude", state, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: probeOf({ ok: false, detail: "version probe spawn failed: ENOENT" }),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /could not determine the installed version/);
  assert.match(logs[0]!, /npm i -g @anthropic-ai\/claude-code@latest/);
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0], ["claude-cli-version-checked", { arm: "indeterminate", floor: "2.1.209" }]);
});

// ── AC6: no inference — structural argv proof ───────────────────────────────────────────────
test("AC6: the version probe's argv is exactly ['--version'] — structurally cannot become a paid inference call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-claude-version-probe-"));
  try {
    const argsFile = join(dir, "args.txt");
    const bin = join(dir, "claude-stub");
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\necho '2.1.209'\nexit 0\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    const result = await probeClaudeVersion(bin);
    assert.deepEqual(result, { ok: true, stdout: "2.1.209\n" });
    const argv = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(argv, ["--version"]);
    for (const forbidden of ["-p", "--model", "--max-budget-usd"]) {
      assert.ok(!argv.includes(forbidden), `the version probe's argv must never contain "${forbidden}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC7: failure containment ────────────────────────────────────────────────────────────────
test("AC7: a probe that THROWS resolves indeterminate rather than propagating", async () => {
  const state = fakeState();
  const logs: string[] = [];
  const result = await detectClaudeVersionStartupTier("claude", state, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(result, { arm: "indeterminate", floor: "2.1.209" });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /could not determine the installed version/);
});

test("AC7: a probe that never resolves is hard-killed by probeClaudeVersion's own bounded timeout, never left dangling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-claude-version-hang-"));
  try {
    // #578-style ordering discipline (worker.test.ts's own probeLlmPing hang test): the stub
    // sleeps 30s — far longer than CLAUDE_VERSION_PROBE_TIMEOUT_MS (5s) — so the only way this
    // call resolves within the assertion bound below is the hard-kill under test, not the stub
    // finishing on its own. A short-but-not-3600s sleep also bounds how long the orphaned
    // grandchild `sleep` (node's SIGKILL reaches the spawned bash, not bash's own un-detached
    // child — the same residual worker.ts's own probeLlmPing hang test accepts) lingers after
    // this test moves on.
    const bin = join(dir, "claude-stub-hang");
    writeFileSync(bin, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    const started = Date.now();
    const result = await probeClaudeVersion(bin);
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; detail: string }).detail, /timed out/);
    assert.ok(
      elapsed < CLAUDE_VERSION_PROBE_TIMEOUT_MS + 5_000,
      `hard-kill must land near the ${CLAUDE_VERSION_PROBE_TIMEOUT_MS}ms bound, took ${elapsed}ms`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC7: a nonexistent binary -> indeterminate, never throws", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("/no/such/binary/sapwood-799", state, () => {}, { floor: "2.1.209" });
  assert.equal(result.arm, "indeterminate");
});

test("reverse test: every arm resolves without throwing and never blocks — the check is visibility, not a gate", async () => {
  const state = fakeState();
  const noop = () => {};
  await assert.doesNotReject(() =>
    detectClaudeVersionStartupTier("claude", state, noop, { floor: "2.1.209", probe: probeOf({ ok: true, stdout: "9.9.9" }) }),
  );
  await assert.doesNotReject(() =>
    detectClaudeVersionStartupTier("claude", state, noop, { floor: "2.1.209", probe: probeOf({ ok: true, stdout: "0.0.1" }) }),
  );
  await assert.doesNotReject(() =>
    detectClaudeVersionStartupTier("claude", state, noop, { floor: "2.1.209", probe: probeOf({ ok: false, detail: "x" }) }),
  );
  await assert.doesNotReject(() =>
    detectClaudeVersionStartupTier("claude", state, noop, {
      floor: "2.1.209",
      probe: async () => {
        throw new Error("boom");
      },
    }),
  );
});
