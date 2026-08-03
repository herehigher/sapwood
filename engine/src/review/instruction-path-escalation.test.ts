import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, PRChangedFile } from "../forge/forge.js";
import {
  effectiveInstructionPaths,
  escalateInstructionPathChanges,
  instructionPathMatches,
  matchedInstructionPaths,
} from "./instruction-path-escalation.js";

test("#292 instructionPathMatches: matching is checkout-safe case-insensitive and * stays within one segment", () => {
  assert.equal(instructionPathMatches("CLAUDE.md", "CLAUDE.md"), true);
  assert.equal(instructionPathMatches("claude.md", "CLAUDE.md"), true);
  assert.equal(instructionPathMatches(".CLAUDE/RULES/evil.md", ".claude/rules/**"), true);
  assert.equal(instructionPathMatches("rules/a.md", "rules/*.md"), true);
  assert.equal(instructionPathMatches("rules/nested/a.md", "rules/*.md"), false);
});

test("#292 instructionPathMatches: an NFD checkout path matches its NFC-configured equivalent", () => {
  assert.equal(instructionPathMatches(".claude/rules/cafe\u0301.md", ".claude/rules/caf\u00e9.md"), true);
});

test("#292 instructionPathMatches: consecutive globstars memoize pathological non-matches", () => {
  const pattern = `${Array.from({ length: 14 }, () => "**").join("/")}/CLAUDE.md`;
  assert.equal(instructionPathMatches("a/b/c/d/e/f/g/h/i/j/k/l/m/n/nope.md", pattern), false);
});

test("#292 instructionPathMatches: ** recurses at any depth, including zero directories", () => {
  assert.equal(instructionPathMatches(".claude/rules/a.md", ".claude/rules/**"), true);
  assert.equal(instructionPathMatches(".claude/rules/team/backend/a.md", ".claude/rules/**"), true);
  assert.equal(instructionPathMatches("AGENTS.md", "**/AGENTS.md"), true);
  assert.equal(instructionPathMatches("packages/a/AGENTS.md", "**/AGENTS.md"), true);
});

test("#292 matchedInstructionPaths: a rename matches either old or new instruction path", () => {
  const files: PRChangedFile[] = [
    { filename: "docs/old.md", previousFilename: "CLAUDE.md" },
    { filename: ".claude/rules/nested/review.md" },
    { filename: "src/app.ts" },
  ];
  assert.deepEqual(matchedInstructionPaths(files, ["CLAUDE.md", ".claude/rules/**"]), ["CLAUDE.md", ".claude/rules/nested/review.md"]);
});

test("#292 escalation helper: label-presence latch writes label then one comment exactly once across ticks", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const calls: string[] = [];
  const labels: string[] = [];
  const forge = {
    getPRChangedFiles: async () => {
      calls.push("files");
      return { files: [{ filename: "AGENTS.md" }], complete: true };
    },
    addPRLabel: async (_pr: number, label: string) => {
      calls.push(`label:${label}`);
      labels.push(label);
    },
    addPRComment: async (_pr: number, body: string) => {
      calls.push(`comment:${body}`);
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;

  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "escalated");
  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "latched");
  assert.equal(calls.filter((call) => call === "files").length, 1);
  assert.equal(calls.filter((call) => call.startsWith("label:")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("comment:")).length, 1);
  assert.match(calls.find((call) => call.startsWith("comment:")) ?? "", /`AGENTS\.md`.*human-vetted reviewer authority.*#292/);
  // #397 bucket 2: this path's verdict is "a human must MERGE this PR", so the label it writes —
  // and the latch that proves the second tick was suppressed — is `human-merge-only`. `needs-human`
  // is never written here, on the PR or anywhere else.
  assert.deepEqual(labels, [cfg.labels.humanMergeOnly]);
  assert.equal(
    calls.some((call) => call.includes(cfg.labels.needsHuman)),
    false,
  );
});

test("#397: a PR carrying only needs-human does NOT satisfy the instruction-path latch — the two buckets stay apart", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename: "src/app.ts" }], complete: true }),
    addPRLabel: async () => assert.fail("a non-matching PR writes no instruction-path label"),
    addPRComment: async () => assert.fail("a non-matching PR posts no instruction-path comment"),
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  // Pre-#397 this returned "latched" (needs-human was the latch), which reported a bucket-1
  // escalation under a bucket-2 reason. It is now "clear": the ordinary human-label veto in
  // deriveGate handles a needs-human PR, and the conductor escalates it as bucket 1.
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [cfg.labels.needsHuman], cfg }), { kind: "clear" });
});

test("#292 escalation helper: instructionPaths [] is a true off-switch with zero forge calls", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    escalation: { instructionPaths: [] },
  });
  const forge = new Proxy({}, { get: () => () => assert.fail("disabled escalation must not touch forge") }) as Pick<
    IForge,
    "getPRChangedFiles" | "addPRLabel" | "addPRComment"
  >;
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg }), { kind: "clear" });
});

test("#292 escalation helper: changed-files failure queues fail-closed and performs no writes", async () => {
  let writes = 0;
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const forge = {
    getPRChangedFiles: async () => {
      throw new Error("API down");
    },
    addPRLabel: async () => {
      writes++;
    },
    addPRComment: async () => {
      writes++;
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  const result = await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg });
  assert.equal(result.kind, "unavailable");
  assert.equal(writes, 0);
});

test("#292 escalation helper: a post-label comment failure is latched and never retried", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const labels: string[] = [];
  let comments = 0;
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename: "CLAUDE.md" }], complete: true }),
    addPRLabel: async (_pr: number, label: string) => {
      labels.push(label);
    },
    addPRComment: async () => {
      comments++;
      throw new Error("receipt lost");
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "escalated");
  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "latched");
  assert.equal(comments, 1);
});

test("#292 escalation helper: an incomplete 3,000-file list escalates without pattern matching", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const files = Array.from({ length: 3000 }, (_, index) => ({ filename: `src/generated-${index}.ts` }));
  let comment = "";
  const forge = {
    getPRChangedFiles: async () => ({ files, complete: false }),
    addPRLabel: async () => {},
    addPRComment: async (_pr: number, body: string) => {
      comment = body;
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;

  const result = await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg });
  assert.deepEqual(result, { kind: "escalated", matchedPaths: [], reason: "instruction-path-list-incomplete" });
  assert.match(comment, /changed-file list exceeded the GitHub API ceiling.*could not be verified.*instruction-path-list-incomplete/s);
});

test("#292 escalation helper: matched paths are defanged before rendering in an engine-authored comment", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const filename = ".claude/rules/evil`\n\u202e@user.md";
  let comment = "";
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename }], complete: true }),
    addPRLabel: async () => {},
    addPRComment: async (_pr: number, body: string) => {
      comment = body;
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;

  const result = await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg });
  assert.deepEqual(result, {
    kind: "escalated",
    matchedPaths: [".claude/rules/evil???@user.md"],
    reason: "instruction-path-change",
  });
  assert.doesNotMatch(comment, /evil`|\n|\u202e/);
  assert.match(comment, /`\.claude\/rules\/evil\?\?\?@user\.md`/);
});

test("#527 effectiveInstructionPaths: the engine-resolved doctrine file is unioned in, in repo-relative form", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  assert.ok(effectiveInstructionPaths(cfg).includes("docs/REVIEW-DOCTRINE.md"));
  // The reviewer's other carrier ships as a default list entry, not a derived one.
  assert.ok(effectiveInstructionPaths(cfg).includes("engine/prompts/**"));
});

test("#527 effectiveInstructionPaths: an operator-reconfigured doctrine.file is followed by its raw repo-relative form, never loadConfig's absolute path", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, doctrine: { file: "review/rules.md" } });
  // Mirrors loadConfig's annotation: fileRaw keeps the pre-resolution value, file becomes absolute.
  cfg.doctrine.fileRaw = "review/rules.md";
  cfg.doctrine.file = "/home/op/repo/review/rules.md";
  const patterns = effectiveInstructionPaths(cfg);
  assert.ok(patterns.includes("review/rules.md"));
  assert.ok(!patterns.includes("docs/REVIEW-DOCTRINE.md"));
  assert.ok(
    patterns.every((pattern) => !pattern.startsWith("/")),
    "an absolute path could never match a repo-relative changed-file path",
  );
});

test("#527 effectiveInstructionPaths: a doctrine path outside the repo-relative shape is skipped, not smuggled in", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  for (const outside of ["/etc/doctrine.md", "../sibling/doctrine.md"]) {
    cfg.doctrine.fileRaw = outside;
    assert.deepEqual(effectiveInstructionPaths(cfg), cfg.escalation.instructionPaths);
  }
});

test("#527 effectiveInstructionPaths: the [] off-switch still disables everything, doctrine included", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, escalation: { instructionPaths: [] } });
  assert.deepEqual(effectiveInstructionPaths(cfg), []);
});

test("#527 escalation helper: a PR editing the doctrine file escalates through the existing #292 path", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const labels: string[] = [];
  let comments = 0;
  const forge = {
    // Rename-aware: the doctrine file is matched under its PREVIOUS name too.
    getPRChangedFiles: async () => ({
      files: [{ filename: "docs/DOCTRINE.md", previousFilename: "docs/REVIEW-DOCTRINE.md" }],
      complete: true,
    }),
    addPRLabel: async (_pr: number, label: string) => {
      labels.push(label);
    },
    addPRComment: async () => {
      comments++;
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;

  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg }), {
    kind: "escalated",
    matchedPaths: ["docs/REVIEW-DOCTRINE.md"],
    reason: "instruction-path-change",
  });
  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "latched");
  assert.deepEqual(labels, [cfg.labels.humanMergeOnly]);
  assert.equal(comments, 1);
});

test("#527 escalation helper: a PR editing the reviewer prompt escalates in a self-hosting deployment", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename: "engine/prompts/engine-reviewer.md" }], complete: true }),
    addPRLabel: async () => {},
    addPRComment: async () => {},
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg }), {
    kind: "escalated",
    matchedPaths: ["engine/prompts/engine-reviewer.md"],
    reason: "instruction-path-change",
  });
});

test("#527 escalation helper: a target repo with no engine/prompts and an untouched doctrine sees no behavior change", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename: "src/app.ts" }, { filename: "docs/PLAN.md" }], complete: true }),
    addPRLabel: async () => assert.fail("a non-instruction PR writes no label"),
    addPRComment: async () => assert.fail("a non-instruction PR posts no comment"),
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg }), { kind: "clear" });
});

test("#549 effectiveInstructionPaths: an unset reviewer.agent.promptFile changes nothing — no entry, no reordering", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  assert.deepEqual(effectiveInstructionPaths(cfg), [...cfg.escalation.instructionPaths, "docs/REVIEW-DOCTRINE.md"]);
});

test("#549 effectiveInstructionPaths: a repointed reviewer.agent.promptFile is followed by its raw repo-relative form, never loadConfig's absolute path", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "engine-agent", agent: { model: "opus", promptFile: "prompts/my-reviewer.md" } },
  });
  // Mirrors loadConfig's annotation: promptFileRaw keeps the pre-resolution value, promptFile becomes absolute.
  cfg.reviewer.agent!.promptFileRaw = "prompts/my-reviewer.md";
  cfg.reviewer.agent!.promptFile = "/home/op/repo/prompts/my-reviewer.md";
  const patterns = effectiveInstructionPaths(cfg);
  assert.ok(patterns.includes("prompts/my-reviewer.md"));
  assert.ok(
    patterns.every((pattern) => !pattern.startsWith("/")),
    "an absolute path could never match a repo-relative changed-file path (and InstructionPath rejects a leading /)",
  );
});

test("#549 effectiveInstructionPaths: a prompt path outside the repo-relative shape is skipped, not smuggled in", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "engine-agent", agent: { model: "opus", promptFile: "prompts/my-reviewer.md" } },
  });
  const unchanged = [...cfg.escalation.instructionPaths, "docs/REVIEW-DOCTRINE.md"];
  for (const outside of ["/etc/my-reviewer.md", "../sibling/my-reviewer.md"]) {
    cfg.reviewer.agent!.promptFileRaw = outside;
    assert.deepEqual(effectiveInstructionPaths(cfg), unchanged);
  }
});

test("#549 effectiveInstructionPaths: the [] off-switch still disables everything, a repointed prompt included", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    escalation: { instructionPaths: [] },
    reviewer: { mode: "engine-agent", agent: { model: "opus", promptFile: "prompts/my-reviewer.md" } },
  });
  assert.deepEqual(effectiveInstructionPaths(cfg), []);
});

test("#549 escalation helper: a PR editing a repointed reviewer prompt escalates through the existing #292 path", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "engine-agent", agent: { model: "opus", promptFile: "prompts/my-reviewer.md" } },
  });
  const labels: string[] = [];
  let comments = 0;
  const forge = {
    getPRChangedFiles: async () => ({ files: [{ filename: "prompts/my-reviewer.md" }], complete: true }),
    addPRLabel: async (_pr: number, label: string) => {
      labels.push(label);
    },
    addPRComment: async () => {
      comments++;
    },
  } satisfies Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;

  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg }), {
    kind: "escalated",
    matchedPaths: ["prompts/my-reviewer.md"],
    reason: "instruction-path-change",
  });
  assert.equal((await escalateInstructionPathChanges({ forge, pr: 7, labels, cfg })).kind, "latched");
  assert.deepEqual(labels, [cfg.labels.humanMergeOnly]);
  assert.equal(comments, 1);
});

test("#549 escalation helper: with instructionPaths [] a repointed-prompt edit still reaches no forge call", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    escalation: { instructionPaths: [] },
    reviewer: { mode: "engine-agent", agent: { model: "opus", promptFile: "prompts/my-reviewer.md" } },
  });
  const forge = new Proxy({}, { get: () => () => assert.fail("disabled escalation must not touch forge") }) as Pick<
    IForge,
    "getPRChangedFiles" | "addPRLabel" | "addPRComment"
  >;
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg }), { kind: "clear" });
});

test("#527 escalation helper: with instructionPaths [] a doctrine edit still reaches no forge call", async () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, escalation: { instructionPaths: [] } });
  const forge = new Proxy({}, { get: () => () => assert.fail("disabled escalation must not touch forge") }) as Pick<
    IForge,
    "getPRChangedFiles" | "addPRLabel" | "addPRComment"
  >;
  assert.deepEqual(await escalateInstructionPathChanges({ forge, pr: 7, labels: [], cfg }), { kind: "clear" });
});
