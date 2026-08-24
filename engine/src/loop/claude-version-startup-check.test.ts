// claude-version-startup-check.test.ts (#799): pins the three arms the issue names (ok /
// below-floor / indeterminate — including the boundary-inclusive floor and BOTH failure shapes
// that must collapse to indeterminate), the drift test tying MIN_CLAUDE_CLI_VERSION to the two
// doc files' own DECLARATION lines (not any incidental occurrence — #799 gate② P1 #3), that
// exactly one durable event fires per run with the right arm/installed/floor/guidance payload
// (#799 gate② P2 #5), that the probe argv structurally cannot become a paid call, that a
// throwing/hanging probe AND a throwing logger/appendEvent still resolve without ever blocking
// or aborting the caller (#799 gate② P1 #1), and that the version parser binds to the real
// `claude --version` shape rather than manufacturing a false `ok` (#799 gate② P2 #6) — patterned
// on deploy-key-startup-check.test.ts, which already injects a fake preflight rather than
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
  DETECTOR_TIMEOUT_MS,
  detectClaudeVersionStartupTier,
  parseClaudeVersion,
  probeClaudeVersion,
} from "./claude-version-startup-check.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function fakeState(): { events: Array<[string, unknown]>; appendEvent: (kind: string, payload: unknown) => void } {
  const events: Array<[string, unknown]> = [];
  return { events, appendEvent: (kind, payload) => events.push([kind, payload]) };
}

const probeOf = (result: ClaudeVersionProbeResult): ((bin: string) => Promise<ClaudeVersionProbeResult>) => {
  return async () => result;
};

// ── AC1/AC2 (#799 gate② P1 #3 fix): the drift test parses the DECLARATION line specifically ───
//
// sol-high gate② reproduction: the prior whole-file `.includes(MIN_CLAUDE_CLI_VERSION)` check
// was a false negative — docs/guide/configuration.md states "2.1.209" TWICE (the declaration AND the
// evidence prose one line later), so mutating ONLY the declaration to "2.1.208" left the
// evidence occurrence intact and the old test stayed green. Fixed: extract the specific
// declaration phrase from each doc (never any other occurrence) and assert it appears EXACTLY
// once and equals the constant.
function extractDeclaredVersion(text: string, pattern: RegExp, label: string): string {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label} must state its declared floor EXACTLY once, matching ${pattern}`);
  const version = matches[0]?.[1];
  assert.ok(version, `${label}'s declaration pattern must capture a version group`);
  return version;
}

test("AC1/AC2: docs/guide/getting-started.md's declaration line equals MIN_CLAUDE_CLI_VERSION, and states it exactly once", () => {
  const gettingStarted = readFileSync(join(REPO_ROOT, "docs/guide/getting-started.md"), "utf8");
  const declared = extractDeclaredVersion(gettingStarted, /\*\*Claude Code CLI ≥ (\d+\.\d+\.\d+)\*\*/g, "docs/guide/getting-started.md");
  assert.equal(declared, MIN_CLAUDE_CLI_VERSION);
});

test("AC1/AC2: docs/guide/configuration.md's declaration line equals MIN_CLAUDE_CLI_VERSION, and states it exactly once (even though the version ALSO appears in evidence prose on the next line)", () => {
  const configuration = readFileSync(join(REPO_ROOT, "docs/guide/configuration.md"), "utf8");
  const declared = extractDeclaredVersion(
    configuration,
    /\*\*Minimum Claude Code CLI version: (\d+\.\d+\.\d+)\*\*/g,
    "docs/guide/configuration.md",
  );
  assert.equal(declared, MIN_CLAUDE_CLI_VERSION);
  // The false-negative sol-high demonstrated: whole-file `.includes` would still pass if ONLY
  // the declaration were mutated, because this evidence-prose occurrence survives untouched.
  // Asserting it's present (not asserting it MATCHES the declaration pattern) documents that
  // the drift test above deliberately does NOT rely on this second occurrence.
  assert.ok(
    configuration.includes(`\`${MIN_CLAUDE_CLI_VERSION}\` is the ONLY version`),
    "the evidence-prose occurrence is a SEPARATE, non-authoritative mention",
  );
});

test("MIN_CLAUDE_CLI_VERSION itself parses as a dotted major.minor.patch triple, no prerelease", () => {
  assert.deepEqual(parseClaudeVersion(MIN_CLAUDE_CLI_VERSION), {
    display: MIN_CLAUDE_CLI_VERSION,
    core: MIN_CLAUDE_CLI_VERSION.split(".").map(Number),
    prerelease: false,
  });
});

// ── AC4: three arms ──────────────────────────────────────────────────────────────────────────
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
  assert.equal(result.arm, "indeterminate");
});

test("AC4: unparseable stdout -> indeterminate, never ok, never below-floor", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "not a version\n" }),
  });
  assert.equal(result.arm, "indeterminate");
});

// ── AC5 (#799 gate② P2 #5 fix): both channels, once, guidance reaches the EVENT too ────────────
test("AC5: ok arm — one log line naming the version, no guidance, one event carrying arm/installed/floor, no guidance field", async () => {
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

test("AC5 / P2 #5: below-floor arm — one log line AND the durable event BOTH carry the actionable upgrade guidance", async () => {
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
  const [kind, payload] = state.events[0]!;
  assert.equal(kind, "claude-cli-version-checked");
  assert.deepEqual(payload, {
    arm: "below-floor",
    floor: "2.1.209",
    installed: "1.9.0",
    guidance: (payload as { guidance: string }).guidance,
  });
  // The named observable outcome (#799's issue text): `sapwood events` must SHOW the upgrade
  // command, not merely the log line — reading it straight off the event payload, not the log.
  assert.match((payload as { guidance: string }).guidance, /npm i -g @anthropic-ai\/claude-code@latest/);
  assert.match((payload as { guidance: string }).guidance, /floor: 2\.1\.209/);
  assert.match((payload as { guidance: string }).guidance, /installed: 1\.9\.0/);
});

test("AC5 / P2 #5: indeterminate arm — the durable event ALSO carries guidance; no installed field (nothing was read)", async () => {
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
  const [kind, payload] = state.events[0]!;
  assert.equal(kind, "claude-cli-version-checked");
  assert.deepEqual(payload, { arm: "indeterminate", floor: "2.1.209", guidance: (payload as { guidance: string }).guidance });
  assert.match((payload as { guidance: string }).guidance, /npm i -g @anthropic-ai\/claude-code@latest/);
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

// ── AC7 / #799 gate② P1 #1: failure containment — probe AND collaborator failures ──────────────
test("AC7: a probe that THROWS (rejected promise) resolves indeterminate rather than propagating", async () => {
  const state = fakeState();
  const logs: string[] = [];
  const result = await detectClaudeVersionStartupTier("claude", state, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.arm, "indeterminate");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /could not determine the installed version/);
});

test("P1 #1(b): a probe that throws SYNCHRONOUSLY (no promise ever returned) still resolves indeterminate, never throws", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: (): Promise<ClaudeVersionProbeResult> => {
      throw new Error("sync boom");
    },
  });
  assert.equal(result.arm, "indeterminate");
});

test("P1 #1(b): an injected probe that NEVER resolves still resolves indeterminate — bounded by the DETECTOR's own timeout, not left pending forever (sol-high gate② reproduction: probeClaudeVersion's own bound cannot protect against a probe that isn't it)", async () => {
  const state = fakeState();
  const started = Date.now();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: () => new Promise<ClaudeVersionProbeResult>(() => {}), // deliberately never settles
  });
  const elapsed = Date.now() - started;
  assert.equal(result.arm, "indeterminate");
  // Ordered by construction (docs/timing-dependent-tests-ban doctrine): DETECTOR_TIMEOUT_MS is
  // the ONLY thing that can end this call (the injected probe does zero real work and never
  // settles on its own) — bounding the assertion window around it is pinning the mechanism
  // under test, not timing an unrelated real operation.
  assert.ok(
    elapsed >= DETECTOR_TIMEOUT_MS - 200,
    `must not resolve BEFORE the detector timeout (${DETECTOR_TIMEOUT_MS}ms) — resolved at ${elapsed}ms, which would mean something ELSE short-circuited it`,
  );
  assert.ok(elapsed < DETECTOR_TIMEOUT_MS + 5_000, `must resolve near the detector timeout (${DETECTOR_TIMEOUT_MS}ms), took ${elapsed}ms`);
});

test("P1 #1(a): a throwing state.appendEvent must not propagate — the detector still resolves its normal arm, log still fires", async () => {
  const logs: string[] = [];
  const throwingState = {
    appendEvent: (): void => {
      throw new Error("db write failed");
    },
  };
  const result = await detectClaudeVersionStartupTier("claude", throwingState, (l) => logs.push(l), {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.209" }),
  });
  assert.deepEqual(
    result,
    { arm: "ok", installed: "2.1.209", floor: "2.1.209" },
    "a broken durable-event write must not corrupt the returned arm",
  );
  assert.equal(logs.length, 1, "the log line still fires even though the event write failed — dispatch would proceed either way");
});

test("P1 #1(a): a throwing logger must not propagate — the detector still resolves its normal arm, event still appended", async () => {
  const state = fakeState();
  const throwingLog = (): void => {
    throw new Error("stderr write failed");
  };
  const result = await detectClaudeVersionStartupTier("claude", state, throwingLog, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.209" }),
  });
  assert.deepEqual(result, { arm: "ok", installed: "2.1.209", floor: "2.1.209" }, "a broken logger must not corrupt the returned arm");
  assert.equal(state.events.length, 1, "the durable event still gets appended even though the logger failed");
});

test("P1 #1: both a throwing appendEvent AND a throwing logger AT ONCE still resolve without throwing — dispatch would proceed", async () => {
  const doubleThrowingState = {
    appendEvent: (): void => {
      throw new Error("db write failed");
    },
  };
  const doubleThrowingLog = (): void => {
    throw new Error("stderr write failed");
  };
  await assert.doesNotReject(() =>
    detectClaudeVersionStartupTier("claude", doubleThrowingState, doubleThrowingLog, {
      floor: "2.1.209",
      probe: probeOf({ ok: true, stdout: "1.0.0" }), // below-floor arm too, to exercise the guidance-building path
    }),
  );
});

test("AC7: a nonexistent binary -> indeterminate, never throws", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("/no/such/binary/sapwood-799", state, () => {}, { floor: "2.1.209" });
  assert.equal(result.arm, "indeterminate");
});

test("AC7: a probe that never resolves (probeClaudeVersion's OWN production probe against a real hanging child) is hard-killed by probeClaudeVersion's own bounded timeout, never left dangling", async () => {
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

test("reverse test: every arm/failure shape resolves without throwing and never blocks — the check is visibility, not a gate", async () => {
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

// ── #799 gate② P2 #6: the parser binds to the real claude --version shape ─────────────────────
test("P2 #6: the real `claude --version` shape — 'X.Y.Z (Claude Code)' — parses correctly -> ok", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.227 (Claude Code)\n" }),
  });
  assert.deepEqual(result, { arm: "ok", installed: "2.1.227", floor: "2.1.209" });
});

test("P2 #6 (sol-high reproduction 1): a prerelease of the floor version (2.1.209-beta.1) parses with prerelease:true, and its numeric core alone", () => {
  assert.deepEqual(parseClaudeVersion("2.1.209-beta.1"), { display: "2.1.209-beta.1", core: [2, 1, 209], prerelease: true });
});

test("P2 #6 (sol-high reproduction 1): installed 2.1.209-beta.1 against floor 2.1.209 -> below-floor, NEVER ok (a prerelease sorts below its own stable release, SemVer §11)", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.1.209-beta.1 (Claude Code)\n" }),
  });
  assert.equal(result.arm, "below-floor");
  assert.equal(result.installed, "2.1.209-beta.1");
});

test("P2 #6: a prerelease of a NEWER core still compares ABOVE an older stable floor (prerelease precedence only breaks a TIE on the numeric core)", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "2.2.0-beta.1 (Claude Code)\n" }),
  });
  assert.equal(result.arm, "ok");
});

test("P2 #6 (sol-high reproduction 2): unrelated leading digits (a build/date string preceding the real version) must NOT be parsed as the version — undefined, not the date", () => {
  assert.equal(parseClaudeVersion("build 2026.08.12; Claude Code 2.1.100"), undefined);
});

test("P2 #6 (sol-high reproduction 2): a build/date-prefixed output never manufactures a false ok end-to-end — indeterminate", async () => {
  const state = fakeState();
  const result = await detectClaudeVersionStartupTier("claude", state, () => {}, {
    floor: "2.1.209",
    probe: probeOf({ ok: true, stdout: "build 2026.08.12; Claude Code 2.1.100\n" }),
  });
  assert.equal(result.arm, "indeterminate");
});

test("P2 #6: missing-patch / empty output still correctly -> indeterminate (no regression from the anchored-at-start rewrite)", () => {
  assert.equal(parseClaudeVersion("2.1"), undefined);
  assert.equal(parseClaudeVersion(""), undefined);
  assert.equal(parseClaudeVersion("   \n"), undefined);
});
