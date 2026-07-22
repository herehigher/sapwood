import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, PRChangedFile } from "../forge/forge.js";
import { escalateInstructionPathChanges, instructionPathMatches, matchedInstructionPaths } from "./instruction-path-escalation.js";

test("#292 instructionPathMatches: literals are exact/case-sensitive and * stays within one segment", () => {
  assert.equal(instructionPathMatches("CLAUDE.md", "CLAUDE.md"), true);
  assert.equal(instructionPathMatches("claude.md", "CLAUDE.md"), false);
  assert.equal(instructionPathMatches("rules/a.md", "rules/*.md"), true);
  assert.equal(instructionPathMatches("rules/nested/a.md", "rules/*.md"), false);
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
      return [{ filename: "AGENTS.md" }];
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
    getPRChangedFiles: async () => [{ filename: "CLAUDE.md" }],
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
