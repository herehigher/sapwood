import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_GOAL_FILE, loadConfig, parseConfig } from "./config.js";

test("applies defaults when only required board fields given", () => {
  const cfg = parseConfig("board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
  assert.equal(cfg.board.owner, "acme");
  assert.equal(cfg.board.repo, "widgets");
  assert.equal(cfg.board.status.backlog, "Todo"); // #173: existing configs adopt the default backlog
  assert.equal(cfg.board.status.ready, "Ready"); // default
  assert.equal(cfg.lanes.roundDispatchCap, 6); // #124: per-round quota, 2x lanes.max default
  assert.equal(cfg.worker.budgetUsdSoft, 10);
  assert.equal(cfg.worker.maxResumes, 2);
  assert.equal(cfg.reviewer.mode, "different-model-codex");
  assert.equal(cfg.labels.prefix, "sapwood:");
  assert.equal(cfg.labels.verifyNa, "sapwood:verify:n/a");
  assert.equal(cfg.labels.planApproved, "sapwood:plan:approved"); // #88 gate⓪
  assert.deepEqual(cfg.escalation.humanLabels, ["sapwood:needs-human", "sapwood:blocked"]);
  // #14 engine cost ceiling + kill switch: conservative defaults.
  assert.equal(cfg.cost.dailyBudgetUsd, 100);
  assert.equal(cfg.cost.maxWallClockSec, 14400);
  assert.equal(cfg.cost.drainWindowSec, 300);
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
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nengine: { tickIntervalSec: 30 }");
  assert.equal(over.engine.tickIntervalSec, 30);
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

test("#13/#170: reviewer/merge defaults — codex reviewer, conductor-merge, silence escalation", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.reviewer.mode, "different-model-codex");
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

// worker.model defaults to "opus" — reviewer.agent.model must differ (D5), so every fixture
// below that isn't SPECIFICALLY testing the D5 collision pins worker.model to "sonnet".
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

test("#286: reviewer.mode: engine-agent REQUIRES reviewer.agent — missing ⇒ reject", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent }"),
    /reviewer\.agent is not set|requires reviewer\.agent/,
  );
});

test("#286: reviewer.agent REQUIRES agent.model — present block without model ⇒ reject", () => {
  assert.throws(() => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent, agent: {} }"), /model/);
});

test("#286: reviewer.agent present while mode != engine-agent ⇒ reject (dead-config rejection)", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: human, agent: { model: opus } }"),
    /reviewer\.agent is set but reviewer\.mode is.*human/,
  );
  // Also rejected against the DEFAULT mode (different-model-codex), not just an explicit one.
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { agent: { model: opus } }"),
    /reviewer\.agent is set but reviewer\.mode is.*different-model-codex/,
  );
});

test("#286 (D5): reviewer.agent.model === worker.model ⇒ reject at parse", () => {
  assert.throws(
    () =>
      parseConfig(
        "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { model: opus }\nreviewer: { mode: engine-agent, agent: { model: opus } }",
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
test("lanes.prFixCap: defaults to 2, overridable, nonnegative-int-guarded, 0 is legal (disables the FIXABLE gate)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.lanes.prFixCap, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nlanes: { prFixCap: 5 }");
  assert.equal(over.lanes.prFixCap, 5);
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

// ── #88 gate⓪: labels.planApproved + roles.planReviewer.promptFile ──────────────────────────
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

test("roles.planReviewer.promptFile: unset by default, overridable, strict schema (same #74 pattern as worker.promptFile)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.promptFile, undefined);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFile: prompts/custom-plan-reviewer.md } }",
  );
  assert.equal(over.roles.planReviewer.promptFile, "prompts/custom-plan-reviewer.md");
});

test("roles.planReviewer.promptFile: a typo'd key under roles.planReviewer.* is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.maxDraftCycles: defaults to 2, overridable (#77 Amendment 2 — gate⓪ self-heal bound)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.maxDraftCycles, 2);
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: 5 } }");
  assert.equal(over.roles.planReviewer.maxDraftCycles, 5);
});

test("roles.planReviewer.maxDraftCycles: zero, negative, and non-integer are rejected (positive int only — 0 would make every bounce an instant needs-human)", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycles: ${bad} } }`),
      /maxDraftCycles/,
    );
  }
});

test("roles.planReviewer.maxDraftCycles: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { maxDraftCycle: 3 } }"),
    /maxDraftCycle|[Uu]nrecognized/,
  );
});

test("roles.planReviewer.promptFile: a relative path resolves against the config file's directory, not cwd (same #74 pattern as worker.promptFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { promptFile: my-plan-reviewer.md } }\n",
    );
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.planReviewer.promptFile, join(dir, "my-plan-reviewer.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #87: role runner — model/effort defaults + the plan-drafter role ────────────────────────

test("roles.planReviewer.model/effort: default to a lighter model/effort than worker.model/effort, overridable", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planReviewer.model, "sonnet");
  assert.equal(cfg.roles.planReviewer.effort, "medium");
  const over = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { model: opus, effort: high } }");
  assert.equal(over.roles.planReviewer.model, "opus");
  assert.equal(over.roles.planReviewer.effort, "high");
});

test("worker/roles fallbackModel: default to sonnet, allow an override, and accept explicit none", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.worker.fallbackModel, "sonnet");
  assert.equal(cfg.roles.planReviewer.fallbackModel, "sonnet");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nworker: { fallbackModel: haiku }\nroles: { planReviewer: { fallbackModel: none } }",
  );
  assert.equal(over.worker.fallbackModel, "haiku");
  assert.equal(over.roles.planReviewer.fallbackModel, "none");
});

test("roles.planDrafter: promptFile unset by default, model/effort defaulted, strict schema (#74/#77 Amendment 2 pattern)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.planDrafter.promptFile, undefined);
  assert.equal(cfg.roles.planDrafter.model, "sonnet");
  assert.equal(cfg.roles.planDrafter.effort, "medium");
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: prompts/custom-drafter.md, model: opus } }",
  );
  assert.equal(over.roles.planDrafter.promptFile, "prompts/custom-drafter.md");
  assert.equal(over.roles.planDrafter.model, "opus");
});

test("roles.planDrafter: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFiel: x.md } }"),
    /promptFiel|[Uu]nrecognized/,
  );
});

test("roles.planDrafter.promptFile: a relative path resolves against the config file's directory, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planDrafter: { promptFile: my-plan-drafter.md } }\n");
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.roles.planDrafter.promptFile, join(dir, "my-plan-drafter.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("roles.po: promptFile unset by default, model/effort defaulted, strict schema (same #74 pattern as roles.planReviewer/planDrafter)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.promptFile, undefined);
  assert.equal(cfg.roles.po.model, "sonnet");
  assert.equal(cfg.roles.po.effort, "medium");
  assert.equal(cfg.roles.po.backlogDigestMaxChars, 20_000);
  const over = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\nroles: { po: { promptFile: prompts/custom-po.md, model: opus, effort: high } }",
  );
  assert.equal(over.roles.po.promptFile, "prompts/custom-po.md");
  assert.equal(over.roles.po.model, "opus");
  assert.equal(over.roles.po.effort, "high");
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

test("roles.*.enabled: defaults to true for every toggleable role (po/architect/planReviewer/harvest/retro)", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  assert.equal(cfg.roles.po.enabled, true);
  assert.equal(cfg.roles.architect.enabled, true);
  assert.equal(cfg.roles.planReviewer.enabled, true);
  assert.equal(cfg.roles.harvest.enabled, true);
  assert.equal(cfg.roles.retro.enabled, true);
});

test("roles.*.enabled: explicit false is honored for each toggleable role", () => {
  for (const role of ["po", "architect", "planReviewer", "harvest", "retro"] as const) {
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

test("roles.planReviewer.enabled: a typo'd key is rejected, not silently dropped (.strict())", () => {
  assert.throws(
    () => parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nroles: { planReviewer: { enable: false } }"),
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

// ── #234: forge MCP proxy config — ships OFF, shadow-mode-first when enabled ────────────────

test("proxy: defaults are off, shadow, and conservative caps/budget/timeout", () => {
  const cfg = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\n");
  assert.equal(cfg.proxy.enabled, false);
  assert.equal(cfg.proxy.shadow, true);
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

test("proxy: every key is overridable, and the section remains strict (rejects an unknown key)", () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      "proxy:\n  enabled: true\n  shadow: false\n  caps: { maxIssuesPerCall: 3 }\n  budget: { maxCallsPerSession: 5 }\n  timeoutMs: 5000\n",
  );
  assert.equal(cfg.proxy.enabled, true);
  assert.equal(cfg.proxy.shadow, false);
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
