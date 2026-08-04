import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configHash, DEFAULT_GOAL_FILE, DEFAULT_REVIEWER_AGENT_MODEL, dashboardConfigSubset, loadConfig, parseConfig } from "./config.js";

test("applies defaults when only required board fields given", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.repo, "widgets");
  assert.equal(cfg.board.status.backlog, "Todo"); // #173: existing configs adopt the default backlog
  assert.equal(cfg.board.status.ready, "Ready"); // default
  assert.equal(cfg.lanes.roundDispatchCap, 6); // #124: per-round quota, 2x lanes.max default
  assert.equal(cfg.worker.budgetUsdSoft, 10);
  assert.equal(cfg.worker.maxResumes, 2);
  // #501: default flipped different-model-codex -> engine-agent; a zero-config parse now
  // succeeds with a DEFAULT-INJECTED reviewer.agent block too (see the dedicated #501 test
  // block below for the full default-resolution matrix).
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.reviewer.agent?.model, DEFAULT_REVIEWER_AGENT_MODEL);
  assert.equal(cfg.labels.prefix, "sapwood:");
  assert.equal(cfg.labels.verifyNa, "sapwood:verify:n/a");
  assert.equal(cfg.labels.planApproved, "sapwood:plan:approved"); // #88 gate⓪
  assert.deepEqual(cfg.escalation.humanLabels, ["sapwood:needs-human", "sapwood:blocked"]);
  // #14 engine cost ceiling + kill switch: conservative defaults. (#431: the wall clock is a
  // per-process attention alarm at 24h — restarts renew it, so 4h's "runaway churn" framing no
  // longer applies.)
  assert.equal(cfg.cost.dailyBudgetUsd, 100);
  assert.equal(cfg.cost.maxWallClockSec, 86400);
  assert.equal(cfg.cost.drainWindowSec, 300);
  // #431: the rapid-restart detector's tunables ship as config keys, never constants.
  assert.deepEqual(cfg.engine.rapidRestart, { maxBirths: 5, windowSec: 600 });
});

test("labels.prefix derives omitted workflow and escalation defaults, including the empty-prefix escape hatch", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  const custom = parseConfig(`${base}labels: { prefix: "TEAM:" }`);
  assert.equal(custom.labels.prefix, "team:");
  assert.equal(custom.labels.inProgress, "team:in-progress");
  assert.equal(custom.labels.planApproved, "team:plan:approved");
  assert.deepEqual(custom.escalation.humanLabels, ["team:needs-human", "team:blocked"]);

  const bare = parseConfig(`${base}labels: { prefix: "" }`);
  assert.equal(bare.labels.prefix, "");
  assert.equal(bare.labels.needsHuman, "needs-human");
  assert.deepEqual(bare.escalation.humanLabels, ["needs-human", "blocked"]);
});

test("labels.prefix affects defaults only; explicit label and escalation values remain verbatim", () => {
  const cfg = parseConfig(`
board: { owner: a, repo: r, projectNumber: 1 }
labels: { prefix: "TEAM:", inProgress: Existing-Case, needsHuman: Human-Review }
escalation: { humanLabels: [human-review, Another-Hold] }
`);
  assert.equal(cfg.labels.prefix, "team:");
  assert.equal(cfg.labels.inProgress, "Existing-Case");
  assert.equal(cfg.labels.needsHuman, "Human-Review");
  assert.deepEqual(cfg.escalation.humanLabels, ["human-review", "Another-Hold"]);
});

test("omitted escalation derives from resolved custom labels, while an explicit array must include needsHuman", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { needsHuman: custom-hold }\n";
  const cfg = parseConfig(base);
  assert.deepEqual(cfg.escalation.humanLabels, ["custom-hold", "sapwood:blocked"]);

  assert.throws(
    () => parseConfig(`${base}escalation: { humanLabels: [sapwood:blocked] }`),
    /labels\.needsHuman.*must be listed case-insensitively/s,
  );
});

test("#248: escalation.holdLabels defaults to [<prefix>hold]; labels.prefix affects it the same way it affects humanLabels", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.deepEqual(cfg.escalation.holdLabels, ["sapwood:hold"]);

  const custom = parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { prefix: "TEAM:" }');
  assert.deepEqual(custom.escalation.holdLabels, ["team:hold"]);

  const bare = parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { prefix: "" }');
  assert.deepEqual(bare.escalation.holdLabels, ["hold"]);
});

test("#292: escalation.instructionPaths has trust-chain defaults, is configurable, and [] deliberately disables it", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.deepEqual(parseConfig(base).escalation.instructionPaths, [
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
    ".claude/rules/**",
    "AGENTS.md",
    // #527: the reviewer's own prompt carrier. Inert for any target repo that isn't the engine's
    // own source tree; closes the carrier for a self-hosting deployment.
    "engine/prompts/**",
    // #539: the mechanism's own carriers — the matcher/escalation implementation itself, and the
    // config file carrying the `escalation.*` schema block + these very defaults. A PR gutting
    // either would previously reach autonomous merge (#538 was the reachable, if benign, instance).
    "engine/src/review/instruction-path-escalation.ts",
    "engine/src/config/config.ts",
    // #539: docs/security.md carries the canonical human-merge-only list and documents this
    // mechanism's own trust chain — the same self-reference class as the two paths above.
    "docs/security.md",
  ]);
  assert.deepEqual(
    parseConfig(`${base}escalation: { instructionPaths: ["**/AGENTS.md", instructions/*.md] }`).escalation.instructionPaths,
    ["**/AGENTS.md", "instructions/*.md"],
  );
  assert.deepEqual(parseConfig(`${base}escalation: { instructionPaths: [] }`).escalation.instructionPaths, []);
});

test("#292: escalation.instructionPaths rejects silently inert non-canonical entries", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  const rejected: Array<[string, RegExp]> = [
    ["", /non-empty after trim/],
    ["   ", /non-empty after trim/],
    [" CLAUDE.md", /leading or trailing whitespace/],
    ["CLAUDE.md ", /leading or trailing whitespace/],
    ["./CLAUDE.md", /canonical repo-relative paths/],
    ["/CLAUDE.md", /canonical repo-relative paths/],
    ["../CLAUDE.md", /\.\. path segments/],
    ["docs/../CLAUDE.md", /\.\. path segments/],
    [".", /must not contain \. path segments/],
    [".claude/./rules/**", /must not contain \. path segments/],
    [".claude//rules/**", /empty \/\/ path segments/],
    [".claude/rules/", /must not end with/],
  ];
  for (const [path, message] of rejected) {
    assert.throws(() => parseConfig(`${base}escalation: { instructionPaths: [${JSON.stringify(path)}] }`), message, path);
  }

  assert.deepEqual(
    parseConfig(`${base}escalation: { instructionPaths: [CLAUDE.md, .claude/rules/**, "**/AGENTS.md", instructions/*.md] }`).escalation
      .instructionPaths,
    ["CLAUDE.md", ".claude/rules/**", "**/AGENTS.md", "instructions/*.md"],
  );
});

test("#248: an explicit escalation.holdLabels array is used verbatim, independent of humanLabels", () => {
  const cfg = parseConfig(`
board: { owner: a, repo: r, projectNumber: 1 }
escalation: { holdLabels: [reviewing, Do-Not-Merge] }
`);
  assert.deepEqual(cfg.escalation.holdLabels, ["reviewing", "Do-Not-Merge"]);
  assert.deepEqual(cfg.escalation.humanLabels, ["sapwood:needs-human", "sapwood:blocked"]); // unaffected
});

test("#248: escalation.holdLabels colliding with escalation.humanLabels (or any other protected label) is rejected — collapsing tiers loses the one-fact-one-bit property", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}escalation: { holdLabels: [sapwood:needs-human] }`),
    /escalation\.holdLabels.*collides with labels\.needsHuman/is,
  );
  assert.throws(() => parseConfig(`${base}escalation: { holdLabels: [sapwood:blocked] }`), /escalation\.holdLabels.*collides with/is);
  assert.throws(
    () => parseConfig(`${base}labels: { roundPool: my-hold }\nescalation: { holdLabels: [my-hold] }`),
    /escalation\.holdLabels.*collides with labels\.roundPool/is,
  );
  // Case-insensitive, same semantics as every other collision guard.
  assert.throws(
    () => parseConfig(`${base}escalation: { holdLabels: [SAPWOOD:NEEDS-HUMAN] }`),
    /escalation\.holdLabels.*collides with labels\.needsHuman/is,
  );
  // Sanity: a genuinely distinct value is accepted.
  assert.doesNotThrow(() => parseConfig(`${base}escalation: { holdLabels: [hold] }`));
});

test("#248 review round 1 (G3): escalation.holdLabels rejects empty/whitespace-only entries, and trims real ones — hold labels are matched by exact identity, so a meaningless entry is a config error, not silently inert", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(() => parseConfig(`${base}escalation: { holdLabels: [""] }`), /escalation\.holdLabels/i);
  assert.throws(() => parseConfig(`${base}escalation: { holdLabels: ["   "] }`), /escalation\.holdLabels/i);
  const trimmed = parseConfig(`${base}escalation: { holdLabels: ["  reviewing  "] }`);
  assert.deepEqual(trimmed.escalation.holdLabels, ["reviewing"]);
});

test("#237: notify.mentions defaults to [board.owner] when omitted; an explicit array is used verbatim", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.deepEqual(cfg.notify.mentions, ["acme"]);

  const custom = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nnotify: { mentions: [alice, bob] }\n");
  assert.deepEqual(custom.notify.mentions, ["alice", "bob"]);
});

test("labels.prefix rejects whitespace", () => {
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { prefix: "team labels:" }'),
    /labels\.prefix.*whitespace|whitespace.*labels\.prefix/i,
  );
});

test("worker.maxResumes (#172): non-negative integer, default 2, 0 disables resume", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.equal(parseConfig(base).worker.maxResumes, 2);
  assert.equal(parseConfig(`${base}worker: { maxResumes: 0 }`).worker.maxResumes, 0);
  assert.equal(parseConfig(`${base}worker: { maxResumes: 5 }`).worker.maxResumes, 5);
  assert.throws(() => parseConfig(`${base}worker: { maxResumes: -1 }`), /maxResumes/i);
  assert.throws(() => parseConfig(`${base}worker: { maxResumes: 1.5 }`), /maxResumes/i);
});

test("worker.egressSuspectCommands (#304): shipped defaults parse and an override replaces them", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.deepEqual(parseConfig(base).worker.egressSuspectCommands, [
    "curl",
    "wget",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "ftp",
    "telnet",
  ]);
  assert.deepEqual(parseConfig(`${base}worker: { egressSuspectCommands: [fetch, custom-client] }`).worker.egressSuspectCommands, [
    "fetch",
    "custom-client",
  ]);
});

test("board.status.backlog is overridable and the status object remains strict", () => {
  const cfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7, status: { backlog: Triage } }");
  assert.equal(cfg.board.status.backlog, "Triage");
  assert.throws(
    () => parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7, status: { backolg: Todo } }"),
    /backolg|[Uu]nrecognized/,
  );
});

test("engine.tickIntervalSec (#46 loop driver): defaults to 60s, positive-int-guarded, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.tickIntervalSec, 60);
  // 90s, not 30s: #395 (gate② round 3, P2) added a cross-field floor tying the liveness watchdog
  // window (engine.tickIntervalSec x liveness.watchdogTickMultiplier) to a minimum safe against
  // the default role/worker heartbeat cadence — see that test for the dedicated coverage. 30s
  // combined with the default 10x multiplier would now fail THAT check; 90s clears it comfortably
  // while still exercising this test's own concern (a plain override is accepted and applied).
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 90 }");
  assert.equal(over.engine.tickIntervalSec, 90);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 0 }"), /tickIntervalSec/i);
});

test('engine.driver (#106): defaults to "rounds", overridable to "tick", rejects anything else', () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.driver, "rounds");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: tick }");
  assert.equal(over.engine.driver, "tick");
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { driver: bogus }"), /driver/i);
});

test("logging: defaults, overrides, and strict unknown-key rejection", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.deepEqual(cfg.logging, { path: "data/logs/sapwood.log", teeToStderr: true, maxBytes: 10 * 1024 * 1024 });
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nlogging: { path: logs/run.log, teeToStderr: false, maxBytes: 2048 }",
  );
  assert.deepEqual(over.logging, { path: "logs/run.log", teeToStderr: false, maxBytes: 2048 });
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlogging: { maxByte: 10 }"), /maxByte|[Uu]nrecognized/);
});

test("logging.path: loadConfig resolves both default and explicit relative paths against the config directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-config-logging-"));
  try {
    const defaultPath = join(dir, "default.yaml");
    writeFileSync(defaultPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    assert.equal(loadConfig(defaultPath).logging.path, join(dir, "data", "logs", "sapwood.log"));

    const customPath = join(dir, "custom.yaml");
    writeFileSync(customPath, "board: { owner: a, repo: r, projectNumber: 1 }\nlogging: { path: logs/custom.log }\n");
    assert.equal(loadConfig(customPath).logging.path, join(dir, "logs", "custom.log"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost: #14 ceiling fields are finite-guarded and overridable", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\ncost: { dailyBudgetUsd: 5, maxWallClockSec: 60, drainWindowSec: 10 }",
  );
  assert.equal(cfg.cost.dailyBudgetUsd, 5);
  assert.equal(cfg.cost.maxWallClockSec, 60);
  assert.equal(cfg.cost.drainWindowSec, 10);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { dailyBudgetUsd: 1e999 }"),
    /dailyBudgetUsd|finite/i,
  );
});

test("parses JSON too (YAML superset)", () => {
  const cfg = parseConfig('{"board":{"owner":"acme","repo":"widgets","projectNumber":7}}');
  assert.equal(cfg.board.owner, "acme");
});

test("rejects missing required repo", () => {
  assert.throws(() => parseConfig("board:\n  owner: acme\n  projectNumber: 7\n"), /repo/);
});

test("rejects missing required board identity with a field path", () => {
  assert.throws(() => parseConfig("lanes:\n  max: 5\n"), /board/);
});

test("loadConfig probes sapwood.config.json when no YAML file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, "sapwood.config.json"), '{"board":{"owner":"a","repo":"r","projectNumber":1}}');
    process.chdir(dir);
    assert.equal(loadConfig().board.owner, "a"); // default probe finds the .json
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws a clear error when no config file is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => loadConfig(), /no config found/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an unknown reviewer mode", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: yolo }"), /reviewer/);
});

test("rejects an unknown key (typo in a safety-critical field is not silently dropped)", () => {
  // roundBudgetUSd typo must error, not fall back to the default hard ceiling.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { roundBudgetUSd: 5 }"),
    /roundBudgetUSd|[Uu]nrecognized/,
  );
});

test("rejects an unknown top-level key", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanez: { max: 2 }"), /lanez|[Uu]nrecognized/);
});

test("rejects a non-finite budget ceiling (overflow must not disable the cap)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ncost: { roundBudgetUsd: 1e999 }"),
    /roundBudgetUsd|finite/i,
  );
});

test("#13/#170/#501: reviewer/merge defaults — engine-agent reviewer, conductor-merge, silence escalation", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.reviewer.deltaChainMax, 3);
  assert.equal(cfg.reviewer.escalateAfterSec, 86400);
  assert.equal(cfg.merge.mode, "conductor-merge");
});

test("#273: reviewer.deltaChainMax defaults to 3 and accepts only positive integers", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.equal(parseConfig(`${base}reviewer: { deltaChainMax: 5 }`).reviewer.deltaChainMax, 5);
  for (const value of [0, -1, 1.5]) {
    assert.throws(() => parseConfig(`${base}reviewer: { deltaChainMax: ${value} }`), /deltaChainMax/i);
  }
});

test("#170: reviewer.escalateAfterSec accepts a positive integer override", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { escalateAfterSec: 3600 }");
  assert.equal(cfg.reviewer.escalateAfterSec, 3600);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { escalateAfterSec: 0 }"),
    /escalateAfterSec/i,
  );
});

test("#170: removed reviewer poll keys are rejected clearly by the strict schema", () => {
  for (const key of ["pollIntervalSec", "pollTimeoutSec"]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { ${key}: 120 }`),
      new RegExp(`${key}|unrecognized`, "i"),
    );
  }
});

test("#170: the needs-human write label must be recognized by the human-label hold", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.doesNotThrow(() => parseConfig(base)); // shipped defaults agree
  assert.deepEqual(parseConfig(`${base}labels: { needsHuman: human-review }`).escalation.humanLabels, ["human-review", "sapwood:blocked"]);
  assert.equal(
    parseConfig(`${base}labels: { needsHuman: human-review }\nescalation: { humanLabels: [human-review] }`).labels.needsHuman,
    "human-review",
  );
  assert.doesNotThrow(() => parseConfig(`${base}labels: { needsHuman: Needs-Human }\nescalation: { humanLabels: [needs-human] }`));
  assert.throws(
    () => parseConfig(`${base}labels: { needsHuman: needs-human-now }\nescalation: { humanLabels: [needs-human] }`),
    /labels\.needsHuman.*must be listed case-insensitively in escalation\.humanLabels/i,
  );
});

// ── #212 gate② P1-1: labels.roundPool must not alias any other protected/workflow label ────────

test("#212 gate② P1-1: labels.roundPool colliding with labels.needsHuman is rejected — round close auto-removes roundPool, so aliasing it would silently strip the human-hold label too", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}labels: { roundPool: sapwood:needs-human }`),
    /labels\.roundPool.*collides with labels\.needsHuman/is,
  );
});

test("#212 gate② P1-1: the collision check is case-insensitive, same semantics as labelsInclude", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}labels: { roundPool: SAPWOOD:NEEDS-HUMAN }`),
    /labels\.roundPool.*collides with labels\.needsHuman/is,
  );
});

test("#212 gate② P1-1: labels.roundPool colliding with an escalation.humanLabels entry (not just labels.needsHuman itself) is rejected", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () =>
      parseConfig(
        `${base}labels: { needsHuman: needs-human, roundPool: extra-hold }\nescalation: { humanLabels: [needs-human, extra-hold] }`,
      ),
    /labels\.roundPool.*collides with escalation\.humanLabels/is,
  );
});

test("#212 gate② P1-1: labels.roundPool colliding with labels.planApproved or labels.verifyNa is rejected", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}labels: { roundPool: sapwood:plan:approved }`),
    /labels\.roundPool.*collides with labels\.planApproved/is,
  );
  assert.throws(
    () => parseConfig(`${base}labels: { roundPool: "sapwood:verify:n/a" }`),
    /labels\.roundPool.*collides with labels\.verifyNa/is,
  );
});

test("#212 gate② P1-1: a distinct labels.roundPool value (including the shipped default) is accepted", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.doesNotThrow(() => parseConfig(base)); // shipped default: sapwood:round:pool, no collision
  assert.doesNotThrow(() => parseConfig(`${base}labels: { roundPool: sapwood:my-custom-pool }`));
});

test("#310 gate② P1-2: split cannot alias originAgent and autonomously recurse", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(() => parseConfig(`${base}labels: { split: SAPWOOD:ORIGIN:AGENT }`), /labels\.split.*collides with labels\.originAgent/is);
});

test("#310 gate② P1-2: decomposed cannot alias originAgent and permanently fence every agent child", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}labels: { decomposed: SAPWOOD:ORIGIN:AGENT }`),
    /labels\.decomposed.*collides with labels\.originAgent/is,
  );
});

test("#310 gate② P1-2: split and decomposed reject aliases with each other and hold/escalation labels", () => {
  const base = "board: { owner: a, repo: r, projectNumber: 1 }\n";
  assert.throws(
    () => parseConfig(`${base}labels: { split: custom, decomposed: CUSTOM }`),
    /labels\.(split|decomposed).*collides with labels\.(decomposed|split)/is,
  );
  assert.throws(
    () => parseConfig(`${base}labels: { split: reviewing }\nescalation: { holdLabels: [REVIEWING] }`),
    /labels\.split.*collides with escalation\.holdLabels/is,
  );
});

// ── #156: reviewer.triggerCommand — user-defined review trigger entry point ─────────────────

test("#156: reviewer.triggerCommand defaults to `@codex review` (byte-for-byte today's hardcoded trigger)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.triggerCommand, "@codex review");
});

test("#156: reviewer.triggerCommand accepts a custom value", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { triggerCommand: '/review-please' }");
  assert.equal(cfg.reviewer.triggerCommand, "/review-please");
});

test("#156: reviewer.triggerCommand rejects an empty string", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { triggerCommand: '' }"), /reviewer/);
});

test("#13: produce-pr-and-stop is a merge.mode value, not a reviewer.mode value", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: produce-pr-and-stop }"), /reviewer/);
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: produce-pr-and-stop }");
  assert.equal(cfg.merge.mode, "produce-pr-and-stop");
});

test("#13: reviewer.mode accepts same-model-trusted and human", () => {
  // #286: same-model-trusted as PRIMARY now requires a non-empty trustedReviewers list (the
  // primary-mode extension of the pre-existing fallback-only empty-trustedReviewers rejection,
  // see the #286 same-model-trusted-empty tests below) — supply one here so this test still
  // exercises only what it's named for (the enum accepting both values).
  assert.equal(
    parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: same-model-trusted, trustedReviewers: [bot] }").reviewer
      .mode,
    "same-model-trusted",
  );
  assert.equal(parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human }").reviewer.mode, "human");
});

// ── #501: default reviewer kind flips to engine-agent — config default-resolution matrix ──────
//
// AC coverage: zero config; only worker.model set (collision, incl. its error message — see the
// dedicated D5-extended test above); each explicit mode (regression-pinned); user agent block
// with/without engine-agent (dead-config both directions — see the #286 batch below); injected
// default does NOT trip dead-config.

test("#501: zero config resolves reviewer.mode to engine-agent with a valid injected agent block (model != worker.model's own default)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.worker.model, "opus"); // #582 option (a): worker default unchanged; reviewer default moved to fable
  assert.equal(cfg.reviewer.agent?.model, DEFAULT_REVIEWER_AGENT_MODEL);
  assert.notEqual(cfg.reviewer.agent?.model, cfg.worker.model);
});

test("#501: explicit mode: different-model-codex parses and behaves exactly as today — no agent block, regression-pinned", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: different-model-codex }");
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.reviewer.agent, undefined);
});

test("#501: explicit mode: same-model-trusted and mode: human still parse with no injected agent block", () => {
  const trusted = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: same-model-trusted, trustedReviewers: [bot] }",
  );
  assert.equal(trusted.reviewer.mode, "same-model-trusted");
  assert.equal(trusted.reviewer.agent, undefined);
  const human = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human }");
  assert.equal(human.reviewer.mode, "human");
  assert.equal(human.reviewer.agent, undefined);
});

test("#501: explicit mode: engine-agent with a user-supplied agent block is used verbatim — no injection happens over it", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: haiku, effort: low } }",
  );
  assert.equal(cfg.reviewer.agent?.model, "haiku");
  assert.equal(cfg.reviewer.agent?.effort, "low"); // the user's own value, not ReviewerAgent's "high" default
});

test("#13: rejects an unknown merge mode", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nmerge: { mode: yolo }"), /merge/);
});

test("#54: reviewer.fallback defaults empty, failoverAfterSec defaults sane (no silent degradation)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.deepEqual(cfg.reviewer.fallback, []);
  assert.equal(cfg.reviewer.failoverAfterSec, 1200);
});

test("#54: reviewer.fallback accepts an ordered list of the same three reviewer kinds", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted, human] }",
  );
  assert.deepEqual(cfg.reviewer.fallback, ["same-model-trusted", "human"]);
});

test("#54: reviewer.fallback rejects an unknown kind", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [yolo] }"), /reviewer/);
});

test("#54: reviewer.failoverAfterSec accepts a custom positive integer", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { failoverAfterSec: 300 }");
  assert.equal(cfg.reviewer.failoverAfterSec, 300);
});

test("#54 R2 (fable-review P3): fallback containing same-model-trusted with EMPTY trustedReviewers is rejected at parse — a failover that can never fire must not ship silently", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [same-model-trusted] }"),
    /silently inert|trustedReviewers/,
  );
  // Explicit empty list is just as inert as the default.
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [], fallback: [human, same-model-trusted] }",
      ),
    /silently inert|trustedReviewers/,
  );
});

test("#54 R2: the same fallback parses fine once trustedReviewers is non-empty, and human-only fallback needs no allowlist", () => {
  const ok = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted] }",
  );
  assert.deepEqual(ok.reviewer.fallback, ["same-model-trusted"]);
  const humanOnly = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [human] }");
  assert.deepEqual(humanOnly.reviewer.fallback, ["human"]);
});

// ── #286 (E4a, design #279 §7): reviewer.mode: engine-agent + reviewer.agent strictness batch ──

// worker.model defaults to "sonnet" (#582) — reviewer.agent.model must differ (D5), so every
// fixture below that isn't SPECIFICALLY testing the D5 collision pins worker.model explicitly.
const BASE_ENGINE_AGENT =
  "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: opus } }\n";

test("#286: reviewer.mode: engine-agent + reviewer.agent parses with sane defaults", () => {
  const cfg = parseConfig(BASE_ENGINE_AGENT);
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.reviewer.agent?.model, "opus");
  assert.equal(cfg.reviewer.agent?.effort, "high");
  assert.equal(cfg.reviewer.agent?.costCapUsd, 3);
  assert.equal(cfg.reviewer.agent?.retryAfterSec, 900);
  assert.equal(cfg.reviewer.agent?.treeRetentionCap, 10);
  assert.equal(cfg.reviewer.agent?.promptFile, undefined);
});

// ── #443: reviewer.agent.runner — the executor seam's config surface ──────────────────────────

test("#443: reviewer.agent.runner defaults to claude (unset = today's behavior), accepts codex-exec, and rejects anything else", () => {
  assert.equal(parseConfig(BASE_ENGINE_AGENT).reviewer.agent?.runner, "claude");
  const codex = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: gpt-5.4-codex, runner: codex-exec } }\n",
  );
  assert.equal(codex.reviewer.agent?.runner, "codex-exec");
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: opus, runner: gemini } }\n",
      ),
    /runner/,
  );
});

test("#443: the #501 default-injected agent block carries runner: claude — the zero-config default reviewer is still the local Claude session", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent }");
  assert.equal(cfg.reviewer.agent?.runner, "claude");
});

test("#443: `runner` inside the agent block inherits the EXISTING dead-config rule — set while mode isn't engine-agent ⇒ rejected with the whole block", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: different-model-codex, agent: { model: opus, runner: codex-exec } }\n",
      ),
    /reviewer\.agent is set but reviewer\.mode is.*different-model-codex/,
  );
});

test("#443 (R1): reviewer.agent.codexPricing is dead config for the claude runner (rejected), and configurable for codex-exec", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\n" +
          "reviewer: { mode: engine-agent, agent: { model: opus, codexPricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } } }\n",
      ),
    /codexPricing is set but reviewer\.agent\.runner is .*claude.*, not codex-exec/,
  );
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\n" +
      "reviewer: { mode: engine-agent, agent: { model: gpt-5.4-codex, runner: codex-exec, codexPricing: { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 } } }\n",
  );
  assert.deepEqual(cfg.reviewer.agent?.codexPricing, { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 });
});

test("#443 (D5 generalization): the parse-time model-collision check applies to the claude runner only — a codex-exec review is cross-PROVIDER by construction, so an identical model STRING is not a collision", () => {
  // Same model name on both sides, claude runner ⇒ still rejected, exactly as before #443.
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: opus } }\n",
      ),
    /D5/,
  );
  // Same model name, codex-exec runner ⇒ parses: the runtime (provider, model) check is what
  // establishes separation for that runner, and no `provider` config key was invented.
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: opus, runner: codex-exec } }\n",
  );
  assert.equal(cfg.reviewer.agent?.runner, "codex-exec");
});

test("#314: reviewer.agent.treeRetentionCap is configurable and must be a positive integer", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: opus, treeRetentionCap: 3 } }\n",
  );
  assert.equal(cfg.reviewer.agent?.treeRetentionCap, 3);
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: opus, treeRetentionCap: 0 } }\n",
      ),
    /treeRetentionCap/,
  );
});

test("#501: reviewer.mode: engine-agent with reviewer.agent omitted ⇒ default-injected (sane defaults, model differs from worker.model's own default)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent }");
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.worker.model, "opus"); // worker.model's own default (unchanged by #582 option (a))
  assert.equal(cfg.reviewer.agent?.model, DEFAULT_REVIEWER_AGENT_MODEL);
  assert.equal(cfg.reviewer.agent?.effort, "high");
  assert.equal(cfg.reviewer.agent?.costCapUsd, 3);
  assert.equal(cfg.reviewer.agent?.retryAfterSec, 900);
  assert.equal(cfg.reviewer.agent?.treeRetentionCap, 10);
  assert.equal(cfg.reviewer.agent?.promptFile, undefined);
});

test("#286: reviewer.agent REQUIRES agent.model — present block without model ⇒ reject", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent, agent: {} }"), /model/);
});

test("#286: reviewer.agent present while mode != engine-agent ⇒ reject (dead-config rejection)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human, agent: { model: opus } }"),
    /reviewer\.agent is set but reviewer\.mode is.*human/,
  );
  // #501: mode's own default flipped to engine-agent, so an agent block with mode OMITTED is no
  // longer dead-config (it's now the ordinary "let the model default too" shape) — regression-pin
  // the EXPLICIT-non-engine-agent-mode case instead: the AC's "explicit mode: different-model-codex
  // ... configs ... behave exactly as today, including the dead-config rejection of a user-supplied
  // reviewer.agent block alongside them" requirement.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: different-model-codex, agent: { model: opus } }"),
    /reviewer\.agent is set but reviewer\.mode is.*different-model-codex/,
  );
});

test("#501: reviewer.agent present with mode OMITTED ⇒ mode defaults to engine-agent, so the block is NOT dead-config (the injected-default transform never even runs — a user block already satisfies it)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { agent: { model: haiku } }");
  assert.equal(cfg.reviewer.mode, "engine-agent");
  assert.equal(cfg.reviewer.agent?.model, "haiku");
});

test("#286 (D5): reviewer.agent.model === worker.model ⇒ reject at parse (user-supplied agent block, exact message, no DEFAULTED wording)", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: opus } }",
      ),
    /must differ from worker\.model/,
  );
  try {
    parseConfig(
      "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: opus } }",
    );
    assert.fail("expected parse to throw");
  } catch (err) {
    assert.doesNotMatch(String(err), /DEFAULTED/);
  }
});

test("#501 (D5 extended): worker.model = the INJECTED reviewer.agent default ⇒ reject with the defaulted-case message naming the one-line fix", () => {
  // Zero-config reviewer (mode omitted, agent omitted) resolves to engine-agent + an INJECTED
  // agent.model of DEFAULT_REVIEWER_AGENT_MODEL ("sonnet") — an operator who sets ONLY
  // worker.model to that same value collides with it, exactly as if they'd written it themselves
  // (D5 cannot be silently defeated by defaults), but the message must say DEFAULTED and name the
  // fix, per #501's issue text ("set reviewer.agent.model").
  assert.throws(
    () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: ${DEFAULT_REVIEWER_AGENT_MODEL} }`),
    /DEFAULTED.*collides with worker\.model.*set reviewer\.agent\.model to a different Claude model/s,
  );
});

// #582 (owner ruling 2026-08-03): D5 only ever enforced that the two models DIFFER, so the
// post-#501 shipped pair (worker opus / reviewer sonnet) had the WEAKER model gating the
// stronger one's output. gate② is the loop's trust anchor (the conductor merges on its verdict),
// so the shipped defaults must put the reviewer at or above the producer's tier. Owner ruling
// (option (a), 2026-08-03): the reviewer default moves to a THIRD tier above opus ("fable")
// instead of swapping the pair — a swap made a config that only sets `worker.model: opus`
// (this repo's own sapwood.config.yaml) collide with its own defaulted reviewer under D5.
test("#582: shipped defaults put the reviewer AT OR ABOVE the worker's tier (worker opus / reviewer fable), still D5-distinct", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.model, "opus");
  assert.equal(cfg.reviewer.agent?.model, "fable");
  assert.equal(DEFAULT_REVIEWER_AGENT_MODEL, "fable");
  assert.notEqual(cfg.reviewer.agent?.model, cfg.worker.model); // D5 satisfied by the defaults alone
});

test("#582 option (a): a config that sets ONLY worker.model: opus (this repo's own shape) stays valid — the defaulted fable reviewer neither collides nor downgrades", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }");
  assert.equal(cfg.worker.model, "opus");
  assert.equal(cfg.reviewer.agent?.model, "fable");
});

test("#582: the tier flip does NOT soften D5 — an explicit same-model pair still fails loud at parse", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: sonnet } }",
      ),
    /must differ from worker\.model/,
  );
});

test("#286 (D5): reviewer.agent.model different from worker.model parses fine", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\nreviewer: { mode: engine-agent, agent: { model: opus } }",
  );
  assert.equal(cfg.reviewer.agent?.model, "opus");
  assert.equal(cfg.worker.model, "sonnet");
});

test("#286: reviewer.fallback containing engine-agent ⇒ reject (enum excludes it)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [engine-agent] }"), /reviewer/);
});

test("#286: DUPLICATE kinds in reviewer.fallback ⇒ reject, for every kind", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { fallback: [human, human] }"), /duplicate/);
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted, human, same-model-trusted] }",
      ),
    /duplicate/,
  );
});

test("#286: reviewer.fallback with distinct kinds (no duplicates) still parses fine", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { trustedReviewers: [bot], fallback: [same-model-trusted, human] }",
  );
  assert.deepEqual(cfg.reviewer.fallback, ["same-model-trusted", "human"]);
});

test("#286: PRIMARY mode: same-model-trusted with EMPTY trustedReviewers ⇒ reject (extends the fallback-only rule)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: same-model-trusted }"),
    /silently inert|trustedReviewers/,
  );
});

test("#286: reviewer.agent is .strict() — an agent.fallbackModel key rejects", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent, agent: { model: opus, fallbackModel: sonnet } }",
      ),
    /reviewer/,
  );
});

test("#286 (design #279 §4.3): reviewer.mode: engine-agent with empty/absent ci.requiredChecks WARNS (console.warn), never rejects", () => {
  const calls: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    const cfg = parseConfig(BASE_ENGINE_AGENT);
    assert.equal(cfg.reviewer.mode, "engine-agent");
    assert.deepEqual(cfg.ci.requiredChecks, []);
  } finally {
    console.warn = original;
  }
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]![0]), /ci\.requiredChecks is empty/);
});

test("#286 (design #279 §4.3): reviewer.mode: engine-agent with ci.requiredChecks set does NOT warn", () => {
  const calls: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    parseConfig(`${BASE_ENGINE_AGENT}ci: { requiredChecks: [{ name: test }] }`);
  } finally {
    console.warn = original;
  }
  assert.equal(calls.length, 0);
});

test("#286: ci.requiredChecks defaults empty; app defaults to github-actions", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.deepEqual(cfg.ci.requiredChecks, []);
  const withCheck = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nci: { requiredChecks: [{ name: build }] }");
  assert.deepEqual(withCheck.ci.requiredChecks, [{ name: "build", app: "github-actions" }]);
  const withApp = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nci: { requiredChecks: [{ name: build, app: custom-app }] }");
  assert.deepEqual(withApp.ci.requiredChecks, [{ name: "build", app: "custom-app" }]);
});

test("#286: reviewer.agent.promptFile resolves relative to the config file's directory (loadConfig), like worker.promptFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: sonnet }\n" +
        "reviewer: { mode: engine-agent, agent: { model: opus, promptFile: my-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.reviewer.agent?.promptFile, join(dir, "my-reviewer.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#549: reviewer.agent.promptFileRaw keeps the pre-resolution value loadConfig resolved away", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\n" +
        "reviewer: { mode: engine-agent, agent: { model: sonnet, promptFile: prompts/my-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    // Same contract as doctrine.fileRaw: raw for citing/matching, resolved for the engine's reads.
    assert.equal(cfg.reviewer.agent?.promptFileRaw, "prompts/my-reviewer.md");
    assert.equal(cfg.reviewer.agent?.promptFile, join(dir, "prompts", "my-reviewer.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#549: an ABSOLUTE reviewer.agent.promptFile is captured raw unchanged (nothing to resolve)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\n" +
        "reviewer: { mode: engine-agent, agent: { model: sonnet, promptFile: /etc/sapwood/my-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.reviewer.agent?.promptFileRaw, "/etc/sapwood/my-reviewer.md");
    assert.equal(cfg.reviewer.agent?.promptFile, "/etc/sapwood/my-reviewer.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#549: an unset reviewer.agent.promptFile leaves promptFileRaw unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent, agent: { model: sonnet } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.reviewer.agent?.promptFileRaw, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overrides survive validation", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 9 }\nworker: { effort: low }");
  assert.equal(cfg.lanes.max, 9);
  assert.equal(cfg.worker.effort, "low");
});

// ── #147: lanes.gatedReentryCap (bounds the GATED RECLAIM phase's reentry attempts) ──
test("lanes.gatedReentryCap: defaults to 2 (prFixCap's shape), overridable, nonnegative-int-guarded", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.lanes.gatedReentryCap, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: 0 }");
  assert.equal(over.lanes.gatedReentryCap, 0); // 0 is legal — disables automatic reentry outright
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: -1 }"), /gatedReentryCap/);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { gatedReentryCap: 1.5 }"), /gatedReentryCap/);
});

// ── #246: lanes.prFixCap (the FIXABLE gate's fix_rounds cap) — first real consumer of a key
// accepted since #147 as "reserved, not yet wired" ──
// #450 (design #402 R3, §8, D6, issue #450 verification item 8): default raised 2 -> 4 —
// convergence (review/convergence.ts) now supplies the quality stop, so prFixCap goes back to
// being a pure cost ceiling. Schema shape, key name, and semantics are UNCHANGED: still
// nonnegative-int-guarded, still overridable to any value (an explicit config is completely
// unaffected — this test's own `over`/`zero`/throwing cases are byte-identical to before #450),
// and `prFixCap: 0` still folds straight to needs-human exactly as today (pinned explicitly below,
// same assertion this test already made pre-#450).
test("lanes.prFixCap: defaults to 4 (#450: was 2), overridable, nonnegative-int-guarded, 0 is legal (disables the FIXABLE gate)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.lanes.prFixCap, 4);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: 5 }");
  assert.equal(over.lanes.prFixCap, 5);
  const explicitOldDefault = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: 2 }");
  assert.equal(explicitOldDefault.lanes.prFixCap, 2, "an explicit config setting the OLD default is completely unaffected by this issue");
  const zero = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: 0 }");
  assert.equal(zero.lanes.prFixCap, 0);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: -1 }"), /prFixCap/);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: 1.5 }"), /prFixCap/);
});

// ── #74: worker.promptFile ──
test("worker.promptFile: unset by default, overridable, strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.promptFile, undefined);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { promptFile: prompts/custom-worker.md }");
  assert.equal(over.worker.promptFile, "prompts/custom-worker.md");
});

test("worker.promptFile: a typo'd key under worker.* is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { promptFiel: x.md }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

// ── #33 follow-up (PR #85 human review): worker.pricingFile ──
test("worker.pricingFile: unset by default, overridable, follows the #74 promptFile shape", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.pricingFile, undefined);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: pricing/my-rates.yaml }");
  assert.equal(over.worker.pricingFile, "pricing/my-rates.yaml");
});

test("worker.pricingFile: a RELATIVE path resolves against the CONFIG FILE's directory, exactly like promptFile (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { pricingFile: rates/my-rates.yaml }");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.worker.pricingFile, join(dir, "rates", "my-rates.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #606 (#351 final ruling): worker.deployKeyPath ──
test("worker.deployKeyPath: unset by default, overridable, follows the #74 promptFile shape", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.deployKeyPath, undefined);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nworker: { deployKeyPath: data/worker-deploy-key }");
  assert.equal(over.worker.deployKeyPath, "data/worker-deploy-key");
});

test("worker.deployKeyPath: a RELATIVE path resolves against the CONFIG FILE's directory, exactly like promptFile (#74)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { deployKeyPath: data/worker-deploy-key }");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.worker.deployKeyPath, join(dir, "data", "worker-deploy-key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.deployKeyPath: an ABSOLUTE path is left untouched by loadConfig's relative-resolution step", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const abs = join(dir, "elsewhere", "worker-deploy-key");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\nworker: { deployKeyPath: ${abs} }`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.worker.deployKeyPath, abs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #606 gate② round 1 (owner ruling): worker.deployKeyId — the (path, id) LOCAL anchor pair ──
test("worker.deployKeyId: unset by default, overridable to a positive integer, no path-resolution applied (it's not a file path)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.deployKeyId, undefined);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { deployKeyPath: data/worker-deploy-key, deployKeyId: 159210179 }",
  );
  assert.equal(over.worker.deployKeyId, 159210179);
  assert.equal(over.worker.deployKeyPath, "data/worker-deploy-key");
});

test("worker.deployKeyId: rejects zero/negative/non-integer values — a GitHub deploy-key id is always a positive integer", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nworker: { deployKeyId: ${bad} }`));
  }
});

// ── #88 gate⓪: labels.planApproved + roles.verificationPlanReviewer.promptFile ──────────────────────────
// Session wiring (actually loading/rendering this prompt) lands with the peripheral-role-
// runner issue; here the config surface is validated + path-resolved, same "accepted, not
// yet wired" shape as lanes.reserveCap/frictionMin (prFixCap itself is wired as of #246 — see
// deriveGate/driveDecision's own tests in merge-driver.test.ts/conductor.test.ts).

test("labels.planApproved: defaults to sapwood:plan:approved, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.labels.planApproved, "sapwood:plan:approved");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { planApproved: custom:approved }");
  assert.equal(over.labels.planApproved, "custom:approved");
});

test("labels.originAgent: defaults to sapwood:origin:agent, overridable (#89 — the PO provenance stamp, config-driven like every sibling label)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.labels.originAgent, "sapwood:origin:agent");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlabels: { originAgent: bot:made }");
  assert.equal(over.labels.originAgent, "bot:made");
});

test("roles.verificationPlanReviewer.promptFile: unset by default, overridable, strict schema (same #74 pattern as worker.promptFile)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.verificationPlanReviewer.promptFile, undefined);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { promptFile: prompts/custom-verification-plan-reviewer.md } }",
  );
  assert.equal(over.roles.verificationPlanReviewer.promptFile, "prompts/custom-verification-plan-reviewer.md");
});

test("roles.verificationPlanReviewer.promptFile: a typo'd key under roles.verificationPlanReviewer.* is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.verificationPlanReviewer.maxDraftCycles: defaults to 2, overridable (#77 Amendment 2 — gate⓪ self-heal bound)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.verificationPlanReviewer.maxDraftCycles, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { maxDraftCycles: 5 } }");
  assert.equal(over.roles.verificationPlanReviewer.maxDraftCycles, 5);
});

test("roles.verificationPlanReviewer.maxDraftCycles: zero, negative, and non-integer are rejected (positive int only — 0 would make every bounce an instant needs-human)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { maxDraftCycles: ${bad} } }`),
      /maxDraftCycles/,
    );
  }
});

test("roles.verificationPlanReviewer.maxDraftCycles: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { maxDraftCycle: 3 } }"),
    /maxDraftCycle|[Uu]nrecognized/,
  );
});

test("roles.verificationPlanReviewer.promptFile: a relative path resolves against the config file's directory, not cwd (same #74 pattern as worker.promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { promptFile: my-verification-plan-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.verificationPlanReviewer.promptFile, join(dir, "my-verification-plan-reviewer.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #87: role runner — model/effort defaults + the verification-plan-drafter role ────────────────────────

test("roles.verificationPlanReviewer.model/effort: default to a lighter model/effort than worker.model/effort, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.verificationPlanReviewer.model, "sonnet");
  assert.equal(cfg.roles.verificationPlanReviewer.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { model: opus, effort: high } }",
  );
  assert.equal(over.roles.verificationPlanReviewer.model, "opus");
  assert.equal(over.roles.verificationPlanReviewer.effort, "high");
});

test("worker/roles fallbackModel: default to sonnet, allow an override, and accept explicit none", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.fallbackModel, "sonnet");
  assert.equal(cfg.roles.verificationPlanReviewer.fallbackModel, "sonnet");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { fallbackModel: haiku }\nroles: { verificationPlanReviewer: { fallbackModel: none } }",
  );
  assert.equal(over.worker.fallbackModel, "haiku");
  assert.equal(over.roles.verificationPlanReviewer.fallbackModel, "none");
});

test("roles.verificationPlanDrafter: promptFile unset by default, model/effort defaulted, strict schema (#74/#77 Amendment 2 pattern)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.verificationPlanDrafter.promptFile, undefined);
  assert.equal(cfg.roles.verificationPlanDrafter.model, "sonnet");
  assert.equal(cfg.roles.verificationPlanDrafter.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanDrafter: { promptFile: prompts/custom-drafter.md, model: opus } }",
  );
  assert.equal(over.roles.verificationPlanDrafter.promptFile, "prompts/custom-drafter.md");
  assert.equal(over.roles.verificationPlanDrafter.model, "opus");
});

test("roles.verificationPlanDrafter: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanDrafter: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.verificationPlanDrafter.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanDrafter: { promptFile: my-verification-plan-drafter.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.verificationPlanDrafter.promptFile, join(dir, "my-verification-plan-drafter.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #413: the pre-rename gate⓪ keys are gone, and say so by name ───────────────────────────
// Hard rename, no dual-key shim — the owner's pre-v1 ruling (PR #555: 初版开发无需考虑迁移问题)
// says a shipped-config compatibility path isn't owed here. `.strict()` alone would already
// fail closed, but its bare unrecognized-key error names only the DEAD key; these tests pin the
// added half — the error also names the LIVE one, so the fix is readable off the message.
test("#413: roles.planReviewer is rejected with an error naming its replacement, roles.verificationPlanReviewer", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: 3 } }"),
    /planReviewer.*renamed.*verificationPlanReviewer/is,
  );
});

test("#413: roles.planDrafter is rejected with an error naming its replacement, roles.verificationPlanDrafter", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: x.md } }"),
    /planDrafter.*renamed.*verificationPlanDrafter/is,
  );
});

test("#413: the renamed keys carry the old ones' whole surface — every sub-key parses, and .strict() still rejects a typo under them", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "roles: { verificationPlanReviewer: { promptFile: a.md, confirmPromptFile: b.md, maxDraftCycles: 5, enabled: false, model: opus }, verificationPlanDrafter: { promptFile: c.md } }",
  );
  assert.equal(cfg.roles.verificationPlanReviewer.promptFile, "a.md");
  assert.equal(cfg.roles.verificationPlanReviewer.confirmPromptFile, "b.md");
  assert.equal(cfg.roles.verificationPlanReviewer.maxDraftCycles, 5);
  assert.equal(cfg.roles.verificationPlanReviewer.enabled, false);
  assert.equal(cfg.roles.verificationPlanReviewer.model, "opus");
  assert.equal(cfg.roles.verificationPlanDrafter.promptFile, "c.md");
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

// ── #90: roles.architect (round design/review peripheral) ──────────────────────────────────

test("roles.architect: promptFile unset by default, model/effort defaulted, strict schema (same #74 pattern)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.architect.promptFile, undefined);
  assert.equal(cfg.roles.architect.model, "sonnet");
  assert.equal(cfg.roles.architect.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFile: prompts/custom-architect.md, model: opus } }",
  );
  assert.equal(over.roles.architect.promptFile, "prompts/custom-architect.md");
  assert.equal(over.roles.architect.model, "opus");
});

test("roles.architect: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.architect.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { promptFile: my-architect.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.architect.promptFile, join(dir, "my-architect.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #89: roles.po (the PO/product-owner peripheral) ─────────────────────────────────────────

test("roles.po: promptFile unset by default, model/effort defaulted, strict schema (same #74 pattern as roles.verificationPlanReviewer/verificationPlanDrafter)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.promptFile, undefined);
  assert.equal(cfg.roles.po.model, "sonnet");
  assert.equal(cfg.roles.po.effort, "medium");
  assert.equal(cfg.roles.po.backlogDigestMaxChars, 20_000);
  assert.equal(cfg.roles.po.decomposePromptFile, undefined);
  assert.equal(cfg.roles.po.maxChildren, 8);
  assert.equal(cfg.roles.po.acceptanceCriteriaHint, 5);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: prompts/custom-po.md, decomposePromptFile: prompts/custom-decompose.md, maxChildren: 6, acceptanceCriteriaHint: 4, model: opus, effort: high } }",
  );
  assert.equal(over.roles.po.promptFile, "prompts/custom-po.md");
  assert.equal(over.roles.po.decomposePromptFile, "prompts/custom-decompose.md");
  assert.equal(over.roles.po.maxChildren, 6);
  assert.equal(over.roles.po.acceptanceCriteriaHint, 4);
  assert.equal(over.roles.po.model, "opus");
  assert.equal(over.roles.po.effort, "high");
});

test("roles.po decomposition bounds are positive integers", () => {
  for (const setting of ["maxChildren: 0", "maxChildren: 1.5", "acceptanceCriteriaHint: 0"]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { ${setting} } }`),
      /greater than 0|integer/,
    );
  }
});

test("roles.po.backlogDigestMaxChars: accepts a bounded override and rejects values too small for explicit placeholders", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { backlogDigestMaxChars: 500 } }");
  assert.equal(cfg.roles.po.backlogDigestMaxChars, 500);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { backlogDigestMaxChars: 199 } }"),
    /backlogDigestMaxChars|greater than or equal to 200/,
  );
});

test("roles.po: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.po.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: my-po.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.po.promptFile, join(dir, "my-po.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roles.po.decomposePromptFile: a relative path resolves against the config file's directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { decomposePromptFile: po-decompose.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.po.decomposePromptFile, join(dir, "po-decompose.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #233: roles.po.poolSelection — the round-pool selection SESSION's own opt-in switch,
// decoupled from roles.po.enabled (which only gates align/triage) ──────────────────────────

test("roles.po.poolSelection: defaults to false — the pool-selection session is an opt-in experiment, not the default", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.poolSelection, false);
});

test("roles.po.poolSelection: explicit true is honored", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { poolSelection: true } }");
  assert.equal(cfg.roles.po.poolSelection, true);
});

test("roles.po.poolSelection: independent of roles.po.enabled in both directions — neither key defaults or drives the other", () => {
  // enabled: false, poolSelection left unset -> poolSelection still defaults false on its own,
  // not because enabled turned it off.
  const enabledOff = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { enabled: false } }");
  assert.equal(enabledOff.roles.po.enabled, false);
  assert.equal(enabledOff.roles.po.poolSelection, false);

  // poolSelection: true, enabled left unset -> enabled still defaults true on its own, not
  // flipped on by poolSelection.
  const poolSelectionOn = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { poolSelection: true } }");
  assert.equal(poolSelectionOn.roles.po.enabled, true);
  assert.equal(poolSelectionOn.roles.po.poolSelection, true);

  // Both explicit and DIVERGENT — neither key ever silently coerces the other.
  const divergent = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { enabled: false, poolSelection: true } }");
  assert.equal(divergent.roles.po.enabled, false);
  assert.equal(divergent.roles.po.poolSelection, true);
});

test("roles.po.poolSelection: a non-boolean value is rejected", () => {
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { poolSelection: "nope" } }'),
    /poolSelection/,
  );
});

// ── #91: roles.harvest / roles.retro (round-close peripheral roles) ────────────────────────

test("roles.harvest: promptFile unset by default, model/effort defaulted (same #74/#88 pattern), strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.harvest.promptFile, undefined);
  assert.equal(cfg.roles.harvest.model, "sonnet");
  assert.equal(cfg.roles.harvest.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFile: prompts/custom-harvest.md, model: opus, effort: high } }",
  );
  assert.equal(over.roles.harvest.promptFile, "prompts/custom-harvest.md");
  assert.equal(over.roles.harvest.model, "opus");
  assert.equal(over.roles.harvest.effort, "high");
});

test("roles.harvest: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.harvest.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { harvest: { promptFile: my-harvest.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.harvest.promptFile, join(dir, "my-harvest.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roles.retro: promptFile unset by default, model/effort defaulted, strict schema", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.retro.promptFile, undefined);
  assert.equal(cfg.roles.retro.model, "sonnet");
  assert.equal(cfg.roles.retro.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFile: prompts/custom-retro.md, model: opus } }",
  );
  assert.equal(over.roles.retro.promptFile, "prompts/custom-retro.md");
  assert.equal(over.roles.retro.model, "opus");
});

test("roles.retro: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.retro.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { promptFile: my-retro.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.retro.promptFile, join(dir, "my-retro.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #76: goal-based stop conditions ─────────────────────────────────────────────────────────

test("stop: absent by default — every field undefined, no behavior change (#76 regression contract)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.stop.afterIssuesMerged, undefined);
  assert.equal(cfg.stop.afterPRsOpened, undefined);
  assert.equal(cfg.stop.onMilestoneComplete, undefined);
});

test("stop: all three fields overridable", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" + "stop: { afterIssuesMerged: 3, afterPRsOpened: 5, onMilestoneComplete: M4 }",
  );
  assert.equal(cfg.stop.afterIssuesMerged, 3);
  assert.equal(cfg.stop.afterPRsOpened, 5);
  assert.equal(cfg.stop.onMilestoneComplete, "M4");
});

test("stop.afterIssuesMerged / afterPRsOpened: zero and negative are rejected (positive int only)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterIssuesMerged: ${bad} }`),
      /afterIssuesMerged/,
    );
    assert.throws(() => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterPRsOpened: ${bad} }`), /afterPRsOpened/);
  }
});

test("stop.onMilestoneComplete: an empty string is rejected (a name is required once the key is set)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nstop: { onMilestoneComplete: '' }"),
    /onMilestoneComplete/,
  );
});

test("stop: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nstop: { afterIssuesMerge: 3 }"),
    /afterIssuesMerge|[Uu]nrecognized/,
  );
});

// ── #86: round.milestone — round-level dispatch-candidate filter + stop condition ───────────

test("round.milestone: absent by default — no scoping, no behavior change", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.milestone, undefined);
});

test("round.milestone: overridable to a milestone title", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestone: M4 }");
  assert.equal(cfg.round.milestone, "M4");
});

test("round.milestone: an empty string is rejected (a name is required once the key is set)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestone: '' }"), /milestone/);
});

test("round: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { milestne: M4 }"), /milestne|[Uu]nrecognized/);
});

// ── #126: round.directiveFile / round.directiveMaxChars — round directive file ──────────────

test("round.directiveFile: defaults to data/DIRECTIVE.md", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.directiveFile, "data/DIRECTIVE.md");
});

test("round.directiveFile: overridable, and NOT resolved relative to the config file (unlike roles.*.promptFile/planMdPath) — same cwd-relative convention as the engine's own data/sapwood.sqlite default", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveFile: custom/STEER.md }");
  assert.equal(cfg.round.directiveFile, "custom/STEER.md");
});

test("round.directiveFile: an empty string is rejected (always has a value, same shape as roles.architect.planMdPath)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveFile: '' }"), /directiveFile/);
});

test("round.directiveMaxChars: defaults to 20000, a positive int", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.round.directiveMaxChars, 20_000);
});

test("round.directiveMaxChars: zero/negative rejected (same positive-int contract as roles.harvest.artifactMaxChars)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nround: { directiveMaxChars: 0 }"), /directiveMaxChars/);
});

// ── #128: goal.file (top-level north-star goal file, promoted out of the #104-era
// roles.architect.planMdPath) — precedence, deprecation, config-file-relative resolution ───────

test("goal.file: defaults to docs/PLAN.md when neither key is set", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.goal.file, DEFAULT_GOAL_FILE);
  assert.equal(cfg.goal.file, "docs/PLAN.md");
});

test("goal.file: only the new key set — it wins, no error, no deprecation noise", () => {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: notes/GOAL.md }");
    assert.equal(cfg.goal.file, "notes/GOAL.md");
    assert.equal(calls.length, 0, "no deprecation line when only the new key is set");
  } finally {
    console.error = orig;
  }
});

test("goal.file: only the OLD key (roles.architect.planMdPath) set — it wins, and exactly ONE deprecation line is logged", () => {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: notes/ARCH.md } }");
    assert.equal(cfg.goal.file, "notes/ARCH.md");
    assert.equal(calls.length, 1, "exactly one deprecation line");
    assert.match(String(calls[0]![0]), /goal\.file/);
    assert.match(String(calls[0]![0]), /roles\.architect\.planMdPath|deprecat/i);
  } finally {
    console.error = orig;
  }
});

test("goal.file: both keys set and they AGREE — resolves cleanly, no error", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "goal: { file: notes/SAME.md }\nroles: { architect: { planMdPath: notes/SAME.md } }",
  );
  assert.equal(cfg.goal.file, "notes/SAME.md");
});

test("goal.file: both keys set and they DISAGREE — hard config error naming both keys", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\n" +
          "goal: { file: notes/NEW.md }\nroles: { architect: { planMdPath: notes/OLD.md } }",
      ),
    (e: Error) => /goal\.file/.test(e.message) && /roles\.architect\.planMdPath/.test(e.message),
  );
});

test("goal.file: a relative path resolves against the config file's directory, not cwd (same #74 pattern as promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: my-plan.md }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "my-plan.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: the DEFAULT value is also resolved relative to the config file's directory (not left cwd-relative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "docs", "PLAN.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: resolved from the deprecated old key is ALSO config-file-relative resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  const orig = console.error;
  console.error = () => {}; // silence the expected deprecation line for this test
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { architect: { planMdPath: notes/ARCH.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, join(dir, "notes", "ARCH.md"));
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal.file: an absolute path is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const absPath = join(dir, "elsewhere", "GOAL.md");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\ngoal: { file: ${absPath} }\n`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.goal.file, absPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #167: doctrine.file (repo-level review doctrine) — same top-level, always-resolved shape
// as goal.file, but with a real .default() (no deprecated back-compat key to reconcile) ────────

test("doctrine.file: defaults to docs/REVIEW-DOCTRINE.md and doctrine.maxChars defaults to 20000", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.doctrine.file, "docs/REVIEW-DOCTRINE.md");
  assert.equal(cfg.doctrine.maxChars, 20_000);
});

test("doctrine.file/maxChars: both overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: notes/DOCTRINE.md, maxChars: 500 }");
  assert.equal(cfg.doctrine.file, "notes/DOCTRINE.md");
  assert.equal(cfg.doctrine.maxChars, 500);
});

test("doctrine.maxChars: rejects non-positive-int", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 0 }"));
});

// #167 review (Codex P3): a cap below the floor could crowd out capDigest's own truncation
// marker (retro-digest.ts), silently defeating the "marked cut, never a silent drop" contract
// doctrine.maxChars's doc comment promises. 200 is the floor.
test("doctrine.maxChars: rejects a value below the 200-char floor (would crowd out capDigest's truncation marker)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 199 }"));
});

test("doctrine.maxChars: accepts exactly the 200-char floor", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { maxChars: 200 }");
  assert.equal(cfg.doctrine.maxChars, 200);
});

test("doctrine.file: a relative path resolves against the config file's directory, not cwd (same #74 pattern as goal.file/promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: my-doctrine.md }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, join(dir, "my-doctrine.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctrine.file: the DEFAULT value is also resolved relative to the config file's directory (not left cwd-relative)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, join(dir, "docs", "REVIEW-DOCTRINE.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctrine.file: an absolute path is left untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const absPath = join(dir, "elsewhere", "DOCTRINE.md");
    writeFileSync(cfgPath, `board: { owner: a, repo: r, projectNumber: 1 }\ndoctrine: { file: ${absPath} }\n`);
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.doctrine.file, absPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #453: roles.retro.tendencyRounds (the finding-class tendency window) ────────────────────

test("roles.retro.tendencyRounds: defaults to 3 rounds (current round inclusive)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.retro.tendencyRounds, 3);
});

test("roles.retro.tendencyRounds: operator-tunable to widen or narrow the window", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { tendencyRounds: 8 } }");
  assert.equal(cfg.roles.retro.tendencyRounds, 8);
});

test("roles.retro.tendencyRounds: zero/negative/non-integer is rejected (positive int only)", () => {
  for (const bad of ["0", "-1", "2.5"]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { tendencyRounds: ${bad} } }`),
      /tendencyRounds/,
      `tendencyRounds: ${bad} must be rejected`,
    );
  }
});

// ── #104: roles.retro.everyNRounds (retro cadence) ──────────────────────────────────────────

test("roles.retro.everyNRounds: defaults to 1 (every round)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.retro.everyNRounds, 1);
});

test("roles.retro.everyNRounds: overridable to thin the cadence", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 3 } }");
  assert.equal(cfg.roles.retro.everyNRounds, 3);
});

test("roles.retro.everyNRounds: zero/negative is rejected (positive int only)", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 0 } }"), /everyNRounds/);
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: -1 } }"),
    /everyNRounds/,
  );
});

test("roles.retro.everyNRounds: a non-integer is rejected", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { everyNRounds: 1.5 } }"),
    /everyNRounds/,
  );
});

// ── #127: roles.<role>.enabled toggles — switch peripheral roles off per deployment ────────

test("roles.*.enabled: defaults to true for every toggleable role (po/architect/verificationPlanReviewer/harvest/retro)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.enabled, true);
  assert.equal(cfg.roles.architect.enabled, true);
  assert.equal(cfg.roles.verificationPlanReviewer.enabled, true);
  assert.equal(cfg.roles.harvest.enabled, true);
  assert.equal(cfg.roles.retro.enabled, true);
});

test("roles.*.enabled: explicit false is honored for each toggleable role", () => {
  for (const role of ["po", "architect", "verificationPlanReviewer", "harvest", "retro"] as const) {
    const cfg = parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { ${role}: { enabled: false } }`);
    assert.equal(cfg.roles[role].enabled, false, `roles.${role}.enabled should be false`);
  }
});

test("roles.*.enabled: an unknown role key under roles is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { notARole: { enabled: false } }"),
    /notARole|[Uu]nrecognized/,
  );
});

test("roles.verificationPlanReviewer.enabled: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { verificationPlanReviewer: { enable: false } }"),
    /enable\b|[Uu]nrecognized/,
  );
});

test("roles.*.enabled: a non-boolean value is rejected", () => {
  assert.throws(() => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nroles: { retro: { enabled: "nope" } }'), /enabled/);
});

// ── #168 (PR #180 review P3-1): envFailure config validation — fail-fast at load ────────────

test("envFailure: defaults apply (patterns non-empty, escalate 1h, backoff 30s..30min, ping on haiku, 30s timeout, $0.05 ping budget)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.ok(cfg.envFailure.llmPatterns.length > 0);
  assert.ok(cfg.envFailure.forgePatterns.length > 0);
  assert.equal(cfg.envFailure.parkEscalateAfterSec, 3600);
  assert.equal(cfg.envFailure.probeBackoffBaseSec, 30);
  assert.equal(cfg.envFailure.probeBackoffMaxSec, 1800);
  assert.equal(cfg.envFailure.probeModel, "haiku");
  assert.equal(cfg.envFailure.probeTimeoutSec, 30);
  assert.equal(cfg.envFailure.probeMaxBudgetUsd, 0.05);
});

test("envFailure: probeModel/probeTimeoutSec/probeMaxBudgetUsd are overridable; empty model, non-positive timeout, and non-positive/non-finite budget are rejected at load", () => {
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeModel: my-cheap-alias, probeTimeoutSec: 10, probeMaxBudgetUsd: 0.1 }",
  );
  assert.equal(over.envFailure.probeModel, "my-cheap-alias");
  assert.equal(over.envFailure.probeTimeoutSec, 10);
  assert.equal(over.envFailure.probeMaxBudgetUsd, 0.1);
  assert.throws(() => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeModel: "" }'));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeTimeoutSec: 0 }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeMaxBudgetUsd: 0 }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeMaxBudgetUsd: 1e999 }"));
});

test("envFailure: a custom valid override parses; a MALFORMED regex pattern is a fail-fast load error naming the entry (never a silent literal-substring degradation)", () => {
  const ok = parseConfig(
    'board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: ["my_custom_error", "quota (exceeded|reached)"] }',
  );
  assert.deepEqual(ok.envFailure.llmPatterns, ["my_custom_error", "quota (exceeded|reached)"]);
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: ["([unterminated"] }'),
    /not a valid regular expression/,
  );
  assert.throws(
    () => parseConfig('board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { forgePatterns: ["ok", "*bad*"] }'),
    /not a valid regular expression/,
  );
});

test("envFailure: an EMPTY pattern array is rejected at load — silently disabling a source's detection must be impossible by accident", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { llmPatterns: [] }"));
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { forgePatterns: [] }"));
});

test("envFailure: probeBackoffMaxSec below probeBackoffBaseSec is rejected at load; equal is legal (a flat backoff)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeBackoffBaseSec: 60, probeBackoffMaxSec: 30 }"),
    /probeBackoffMaxSec/,
  );
  const flat = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nenvFailure: { probeBackoffBaseSec: 60, probeBackoffMaxSec: 60 }",
  );
  assert.equal(flat.envFailure.probeBackoffMaxSec, 60);
});

// ── #395 (gate② round 3, P2): the liveness watchdog window's cross-field floor/ceiling ─────────

test("liveness: shipped defaults produce a watchdog window that exactly clears the cross-field floor (never rejected)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.engine.tickIntervalSec, 60);
  assert.equal(cfg.liveness.watchdogTickMultiplier, 10);
  // 60 x 10 x 1000 = 600_000ms, exactly 20 x the 30_000ms default heartbeat cadence — the floor
  // is inclusive (>=), so the shipped defaults must never trip their own validation.
});

test("liveness: a watchdogTickMultiplier/tickIntervalSec combo whose PRODUCT falls below the heartbeat-cadence floor is rejected at load — a healthy role session or worker leg would be killed before its first heartbeat", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 1 }\nliveness: { watchdogTickMultiplier: 10 }",
      ),
    /liveness-watchdog window.*below the 600000ms floor/,
  );
  // Below the floor even with the multiplier left at its default (10) — tickIntervalSec alone
  // can trip it, exactly the PM-reported footgun (tickIntervalSec: 1 -> a 10s window).
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 1 }"),
    /liveness-watchdog window/,
  );
  // A fractional multiplier can ALSO trip it even with the default tickIntervalSec.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nliveness: { watchdogTickMultiplier: 0.5 }"),
    /liveness-watchdog window/,
  );
});

test("liveness: raising BOTH tickIntervalSec and watchdogTickMultiplier so their product clears the floor is accepted", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 1 }\nliveness: { watchdogTickMultiplier: 601 }",
  );
  assert.equal(cfg.engine.tickIntervalSec, 1);
  assert.equal(cfg.liveness.watchdogTickMultiplier, 601);
});

test("liveness: a watchdog window past Node's own setTimeout ceiling (~24.8 days) is rejected at load — Node silently clamps an over-large delay to fire almost immediately, the opposite of 'conservative'", () => {
  // 2_147_484 x 1 x 1000 = 2_147_484_000ms, just over Node's 2_147_483_647ms 32-bit-int ceiling.
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 2147484 }\nliveness: { watchdogTickMultiplier: 1 }",
      ),
    /setTimeout ceiling/,
  );
});

// ── #234/#551: forge MCP proxy config — ships ON by default (#551 flip), no `shadow` state ──

test("proxy (#551): defaults are enabled and conservative caps/budget/timeout; no `shadow` key exists on the parsed config", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n");
  assert.equal(cfg.proxy.enabled, true);
  assert.ok(!("shadow" in cfg.proxy), "#551 deleted `shadow` from ProxyConfig entirely");
  assert.equal(cfg.proxy.caps.maxIssuesPerCall, 10);
  assert.equal(cfg.proxy.caps.defaultCommentsPerIssue, 20);
  assert.equal(cfg.proxy.caps.maxCommentsPerCall, 100);
  assert.equal(cfg.proxy.caps.maxRelationsPerIssue, 20);
  assert.equal(cfg.proxy.caps.maxSearchResults, 20);
  assert.equal(cfg.proxy.caps.fullCommentStreamOptIn, false);
  // #244: pr_review_threads' own caps.
  assert.equal(cfg.proxy.caps.maxReviewThreadsPerCall, 20);
  assert.equal(cfg.proxy.caps.maxCommentsPerThread, 20);
  assert.equal(cfg.proxy.budget.maxCallsPerSession, 30);
  assert.equal(cfg.proxy.budget.maxBytesPerSession, 2_000_000);
  assert.equal(cfg.proxy.timeoutMs, 30_000);
});

test("webAccess (#410): default is enabled, same as proxy (#551) — both grants ship ON by default", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n");
  assert.equal(cfg.webAccess.enabled, true);
});

test("webAccess (#410): a config key can disable it, and the section remains strict (rejects an unknown key)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n" + "webAccess:\n  enabled: false\n");
  assert.equal(cfg.webAccess.enabled, false);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nwebAccess: { bogusKey: true }\n"));
});

test("proxy: every remaining key is overridable, and the section remains strict (rejects an unknown key)", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "proxy:\n  enabled: false\n  caps: { maxIssuesPerCall: 3 }\n  budget: { maxCallsPerSession: 5 }\n  timeoutMs: 5000\n",
  );
  assert.equal(cfg.proxy.enabled, false);
  assert.equal(cfg.proxy.caps.maxIssuesPerCall, 3);
  assert.equal(cfg.proxy.caps.defaultCommentsPerIssue, 20, "other caps keep their own defaults");
  assert.equal(cfg.proxy.budget.maxCallsPerSession, 5);
  assert.equal(cfg.proxy.timeoutMs, 5000);
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nproxy: { bogusKey: true }\n"));
});

test("proxy: #244's new caps (maxReviewThreadsPerCall/maxCommentsPerThread) are overridable independently of the #234 caps", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" + "proxy:\n  caps: { maxReviewThreadsPerCall: 5, maxCommentsPerThread: 7 }\n",
  );
  assert.equal(cfg.proxy.caps.maxReviewThreadsPerCall, 5);
  assert.equal(cfg.proxy.caps.maxCommentsPerThread, 7);
  assert.equal(cfg.proxy.caps.maxIssuesPerCall, 10, "other caps keep their own defaults");
});

// #244 (Codex sol-high PR #260 review, P1): pr_reviews/pr_checks' own fetch-bound caps.
test("proxy: review/check/audit fetch caps default independently and are overridable", () => {
  const defaults = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n");
  assert.equal(defaults.proxy.caps.maxReviewsPerCall, 50);
  assert.equal(defaults.proxy.caps.maxChecksPerCall, 50);
  assert.equal(defaults.proxy.caps.maxAuditCommentsPerCall, 20);
  assert.equal(defaults.proxy.caps.maxAuditCommentScanWindow, 100);
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "proxy:\n  caps: { maxReviewsPerCall: 12, maxChecksPerCall: 34, maxAuditCommentsPerCall: 9, maxAuditCommentScanWindow: 77 }\n",
  );
  assert.equal(cfg.proxy.caps.maxReviewsPerCall, 12);
  assert.equal(cfg.proxy.caps.maxChecksPerCall, 34);
  assert.equal(cfg.proxy.caps.maxAuditCommentsPerCall, 9);
  assert.equal(cfg.proxy.caps.maxAuditCommentScanWindow, 77);
  for (const invalid of [0, -1, 1.5]) {
    assert.throws(() =>
      parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nproxy:\n  caps: { maxAuditCommentScanWindow: ${invalid} }\n`),
    );
  }
  assert.throws(() =>
    parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nproxy:\n  caps: { maxAuditCommentScanWindowTypo: 77 }\n"),
  );
});

// #244 (Codex sol-high PR #260 review, P1/P2 audit): every cap fed straight into a GraphQL
// first:/last: argument is bounded at 100 — GitHub's own GraphQL API rejects a connection
// argument above that, so this must be caught at config-parse time, not on the first live call.
test("proxy: caps fed into a GraphQL first:/last: argument reject a value above 100", () => {
  for (const key of [
    "maxRelationsPerIssue",
    "maxCommentsPerThread",
    "maxReviewsPerCall",
    "maxChecksPerCall",
    "maxAuditCommentsPerCall",
    "maxAuditCommentScanWindow",
  ]) {
    // A plain string as assert.throws' 2nd argument is ambiguous (Node treats it as an error-message
    // MATCHER, not a description) — pass no validator at all; the loop variable already narrows
    // which key a failure belongs to via the surrounding test name + stack.
    assert.throws(() => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nproxy:\n  caps: { ${key}: 101 }\n`));
    // exactly 100 is still valid
    assert.doesNotThrow(() => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nproxy:\n  caps: { ${key}: 100 }\n`));
  }
});

// ── #210 (frontend-design §11 follow-up 5): dashboard.controls — the gate on the dashboard's
//   Operations verbs (start/pause/resume/stop) and their POST /api/control route. Ships true
//   (the dashboard the round-2 amendment designed drives the loop); false = pure spectator. ──

test("#210: dashboard.controls defaults to true, round-trips true/false through loadConfig, and stays strict", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-config-dashboard-"));
  try {
    const write = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, `board: { owner: a, repo: r, projectNumber: 1 }\n${body}`);
      return p;
    };
    assert.equal(loadConfig(write("absent.yaml", "")).dashboard.controls, true, "absent -> controls on");
    assert.equal(loadConfig(write("on.yaml", "dashboard: { controls: true }\n")).dashboard.controls, true);
    assert.equal(loadConfig(write("off.yaml", "dashboard: { controls: false }\n")).dashboard.controls, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndashboard: { control: false }"),
    /control|[Uu]nrecognized/,
    "a typo'd key is rejected, not silently dropped — unknown-key strictness is untouched",
  );
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\ndashboard: { controls: yes-please }"));
});

// ── #206: the run-started config snapshot (frontend-design.md §3 E / §11) ────────────────────

test("dashboardConfigSubset: carries the drawer's groups + the per-role model/effort captions", () => {
  const subset = dashboardConfigSubset(parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n"));
  assert.equal(subset.board.owner, "a");
  assert.equal(subset.lanes.roundDispatchCap, 6);
  assert.equal(subset.worker.budgetUsdSoft, 10);
  assert.equal(subset.guard.mode, "hard");
  assert.equal(subset.cost.dailyBudgetUsd, 100);
  assert.equal(subset.reviewer.mode, "engine-agent"); // #501
  assert.equal(subset.merge.mode, "conductor-merge");
  assert.equal(subset.labels.needsHuman, "sapwood:needs-human");
  // §3 C/§6 captions read these — the allowlist "must include" them (frontend-design.md §3 E).
  assert.equal(subset.roles.architect.model, "sonnet");
  assert.equal(subset.roles.retro.effort, "medium");
  assert.equal(subset.worker.model, "opus"); // #582 option (a): unchanged
});

test("dashboardConfigSubset: unlisted keys never leave the engine — no local paths, no proxy block", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-subset-"));
  try {
    const file = join(dir, "sapwood.config.yaml");
    writeFileSync(
      file,
      "board: { owner: a, repo: r, projectNumber: 1 }\n" +
        "logging: { path: logs/secret-place.log }\n" +
        "proxy: { enabled: true }\n" +
        "worker: { pricingFile: pricing.yaml }\n",
    );
    const cfg = loadConfig(file);
    const subset = dashboardConfigSubset(cfg) as Record<string, unknown>;
    // loadConfig resolves these to ABSOLUTE local paths (this machine's directory layout) —
    // the same leak #167 keeps off GitHub comments must not reach the dashboard either.
    assert.equal(subset.proxy, undefined);
    assert.equal(subset.logging, undefined);
    assert.equal(subset.goal, undefined);
    assert.equal(subset.doctrine, undefined);
    const serialized = JSON.stringify(subset);
    assert.ok(!serialized.includes(dir), `no local filesystem path leaked: ${serialized}`);
    assert.ok(!serialized.includes("pricingFile"));
    assert.ok(!serialized.includes("promptFile"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configHash: stable for identical config (key order included), changes when config changes", () => {
  const a = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 4 }\n");
  const b = parseConfig("lanes: { max: 4 }\nboard: { projectNumber: 1, repo: r, owner: a }\n");
  assert.equal(configHash(a), configHash(b), "same resolved config, different key order -> same hash");
  const c = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 5 }\n");
  assert.notEqual(configHash(a), configHash(c));
  // The hash covers the FULL resolved config, not just the allowlisted subset — a change to a
  // key the drawer never shows still marks the run as differently-configured.
  const d = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { max: 4 }\nlogging: { teeToStderr: false }\n");
  assert.notEqual(configHash(a), configHash(d));
});
