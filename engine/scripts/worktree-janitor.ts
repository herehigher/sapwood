#!/usr/bin/env -S npx tsx
// worktree-janitor.ts (#825) — the operator-run, one-shot backlog-clearance path (Tier C / AC5):
// loops the janitor to completion against the REAL `.claude/worktrees/` registrations of the repo
// this is invoked from, printing before/after `git worktree list` counts. Run from the trusted
// main-repo checkout (never from inside a worker worktree): `npx tsx scripts/worktree-janitor.ts`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktreeJanitorDeps, runWorktreeJanitorToCompletion } from "../src/loop/worktree-janitor.js";

const pexecFile = promisify(execFile);

async function countRegistrations(): Promise<number> {
  const { stdout } = await pexecFile("git", ["-C", process.cwd(), "worktree", "list", "--porcelain"]);
  return stdout.split("\n\n").filter((block) => block.startsWith("worktree ")).length;
}

const before = await countRegistrations();
console.log(`worktree-janitor: ${before} registration(s) before this run`);
const result = await runWorktreeJanitorToCompletion(createWorktreeJanitorDeps());
const after = await countRegistrations();
console.log(
  `worktree-janitor: done — reaped ${result.reaped.length}, failed ${result.failed.length}, ` +
    `skipped ${result.skippedAlive} alive-owner + ${result.skippedPresent} present-directory registration(s)`,
);
console.log(`worktree-janitor: ${after} registration(s) after this run`);
if (result.failed.length > 0) {
  console.error(`worktree-janitor: ${result.failed.length} registration(s) failed to reap:`);
  for (const f of result.failed) console.error(`  ${f.path}: ${f.error}`);
  process.exit(1);
}
