#!/usr/bin/env -S npx tsx
// worktree-janitor.ts (#825, extended #834 gate② round 1 F5) — the operator-run, one-shot
// backlog-clearance path (Tier C / AC5): loops BOTH janitor passes to completion against the
// REAL `.claude/worktrees/` registrations of the repo this is invoked from — the missing-
// directory reap (#825's original pass) and the dead-owner/unlocked PRESENT-directory sweep
// (#834 Phase 2) — printing before/after `git worktree list` counts. This is the SAME code path
// (runPresentDirectoryWorktreeSweepToCompletion) engine startup's own single-cycle sweep uses,
// just looped to full coverage instead of bounded to one cycle. Run from the trusted main-repo
// checkout (never from inside a worker worktree): `npx tsx scripts/worktree-janitor.ts`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createPresentDirectorySweepDeps,
  createWorktreeJanitorDeps,
  runPresentDirectoryWorktreeSweepToCompletion,
  runWorktreeJanitorToCompletion,
} from "../src/loop/worktree-janitor.js";

const pexecFile = promisify(execFile);

async function countRegistrations(): Promise<number> {
  const { stdout } = await pexecFile("git", ["-C", process.cwd(), "worktree", "list", "--porcelain"]);
  return stdout.split("\n\n").filter((block) => block.startsWith("worktree ")).length;
}

const before = await countRegistrations();
console.log(`worktree-janitor: ${before} registration(s) before this run`);

const missingResult = await runWorktreeJanitorToCompletion(createWorktreeJanitorDeps());
console.log(
  `worktree-janitor: missing-directory pass done — reaped ${missingResult.reaped.length}, failed ${missingResult.failed.length}, ` +
    `skipped ${missingResult.skippedAlive} alive-owner + ${missingResult.skippedPresent} present-directory registration(s)`,
);

// #834 Phase 2 (gate② round 1, F5): the present-directory arm, looped to completion — the
// operator one-shot stock clearance the issue's AC5 explicitly requires "the same code path" for.
const presentResult = await runPresentDirectoryWorktreeSweepToCompletion(createPresentDirectorySweepDeps());
console.log(
  `worktree-janitor: present-directory pass done — reaped ${presentResult.reaped.length}, ` +
    `retained ${presentResult.retained.length} dirty, skipped ${presentResult.skipped}, failed ${presentResult.failed.length}`,
);

const after = await countRegistrations();
console.log(`worktree-janitor: ${after} registration(s) after this run`);

if (missingResult.failed.length > 0 || presentResult.failed.length > 0) {
  if (missingResult.failed.length > 0) {
    console.error(`worktree-janitor: ${missingResult.failed.length} missing-directory registration(s) failed to reap:`);
    for (const f of missingResult.failed) console.error(`  ${f.path}: ${f.error}`);
  }
  if (presentResult.failed.length > 0) {
    console.error(`worktree-janitor: ${presentResult.failed.length} present-directory registration(s) failed:`);
    for (const f of presentResult.failed) console.error(`  ${f.path}: ${f.error}`);
  }
  process.exit(1);
}
