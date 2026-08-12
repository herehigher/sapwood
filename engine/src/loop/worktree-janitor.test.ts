// worktree-janitor.test.ts (#825) — Tier A: unit tests over FABRICATED `.claude/worktrees/`
// registrations (deps.listRegistrations returns canned data; no real git worktree is created).
// Covers the four Tier A cases from the issue's verification plan: dead-pid/missing-directory
// reaped, alive-pid never touched (any directory state), dead-pid/present-directory never
// reaped (scope boundary), and per-cycle batching.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRegistration,
  extractLockPid,
  parseWorktreeListPorcelain,
  sweepWorktreeJanitorOnce,
  type WorktreeJanitorClassifyDeps,
  type WorktreeJanitorDeps,
  type WorktreeRegistration,
} from "./worktree-janitor.js";

const ROOT = "/repo/.claude/worktrees";
const classifyDeps = (over: Partial<WorktreeJanitorClassifyDeps> = {}): WorktreeJanitorClassifyDeps => ({
  worktreeRoot: ROOT,
  isPidAlive: () => false,
  directoryExists: () => false,
  ...over,
});

function fakeDeps(over: Partial<WorktreeJanitorDeps> & { registrations: WorktreeRegistration[] }): WorktreeJanitorDeps & {
  unlocked: string[];
  removed: string[];
  pruneCalls: number;
} {
  const unlocked: string[] = [];
  const removed: string[] = [];
  let pruneCalls = 0;
  return {
    unlocked,
    removed,
    get pruneCalls() {
      return pruneCalls;
    },
    listRegistrations: async () => over.registrations,
    worktreeRoot: over.worktreeRoot ?? ROOT,
    directoryExists: over.directoryExists ?? (() => false),
    isPidAlive: over.isPidAlive ?? (() => false),
    unlock: over.unlock ?? (async (path) => void unlocked.push(path)),
    remove: over.remove ?? (async (path) => void removed.push(path)),
    prune: over.prune ?? (async () => void pruneCalls++),
  };
}

test("parseWorktreeListPorcelain extracts path + lock reason from real porcelain shape", () => {
  const output = [
    "worktree /repo",
    "HEAD aaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/role-retro-9756358f",
    "HEAD bbbb",
    "branch refs/heads/worktree-role-retro-9756358f",
    "locked claude session role-retro-9756358f (pid 12345 start Tue Aug 11 07:02:48 2026)",
    "",
    "worktree /repo/.claude/worktrees/fix-382",
    "HEAD cccc",
    "branch refs/heads/feat/382",
    "",
  ].join("\n");
  const regs = parseWorktreeListPorcelain(output);
  assert.deepEqual(regs, [
    { path: "/repo", lockReason: null },
    {
      path: "/repo/.claude/worktrees/role-retro-9756358f",
      lockReason: "claude session role-retro-9756358f (pid 12345 start Tue Aug 11 07:02:48 2026)",
    },
    { path: "/repo/.claude/worktrees/fix-382", lockReason: null },
  ]);
});

test("extractLockPid parses the claude CLI's own lock-reason format", () => {
  assert.equal(extractLockPid("claude session lane-825-401fc0d4 (pid 5514 start Wed Aug 12 00:33:28 2026)"), 5514);
  assert.equal(extractLockPid("some unrelated reason"), null);
});

test("extractLockPid (#825 gate② [janitor-scope-not-enforced]): a reason that merely CONTAINS a pid <digits> fragment, but isn't the anchored claude-session format, does not parse", () => {
  assert.equal(extractLockPid("debug pid 111"), null);
  assert.equal(extractLockPid("pid 111"), null);
  assert.equal(extractLockPid("claude session x (pid 111 start now) extra trailing text"), null);
});

test("classifyRegistration: dead pid + missing directory -> reap (AC1)", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const verdict = classifyRegistration(reg, classifyDeps({ isPidAlive: () => false, directoryExists: () => false }));
  assert.equal(verdict, "reap");
});

test("classifyRegistration: alive pid -> alive, regardless of directory state (AC2)", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => true, directoryExists: () => false })), "alive");
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => true, directoryExists: () => true })), "alive");
});

test("classifyRegistration: dead pid + present directory -> present, never reaped (AC3)", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => false, directoryExists: () => true })), "present");
});

test("classifyRegistration: unlocked registration is out of scope", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null };
  assert.equal(classifyRegistration(reg, classifyDeps()), "unlocked");
});

test("classifyRegistration: lock reason with no parseable pid is treated as alive (fail-safe)", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "some hand-written reason" };
  assert.equal(classifyRegistration(reg, classifyDeps()), "alive");
});

test("classifyRegistration: a lock reason merely CONTAINING a pid <digits> fragment (not the claude CLI's own anchored format) is treated as alive, never reaped (#825 gate② [janitor-scope-not-enforced])", () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "debug pid 111" };
  // Dead pid + missing directory would otherwise be "reap" — this reason must not parse as an owner pid at all.
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => false, directoryExists: () => false })), "alive");
});

test("classifyRegistration: a registration OUTSIDE worktreeRoot is never reaped, even dead pid + missing directory (#825 gate② [janitor-scope-not-enforced])", () => {
  const reg: WorktreeRegistration = { path: "/repo/some/other/place", lockReason: "claude session role-x (pid 111 start now)" };
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => false, directoryExists: () => false })), "out-of-root");
});

test("classifyRegistration: a sibling directory whose name merely starts with worktreeRoot (e.g. worktrees-legacy) is out-of-root, not a false-positive prefix match", () => {
  const reg: WorktreeRegistration = {
    path: "/repo/.claude/worktrees-legacy/role-x",
    lockReason: "claude session role-x (pid 111 start now)",
  };
  assert.equal(classifyRegistration(reg, classifyDeps({ isPidAlive: () => false, directoryExists: () => false })), "out-of-root");
});

test("sweepWorktreeJanitorOnce: reaps a dead-pid/missing-directory registration (AC1)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakeDeps({ registrations: [reg], isPidAlive: () => false, directoryExists: () => false });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], failed: [], skippedAlive: 0, skippedPresent: 0, remaining: 0 });
  assert.deepEqual(deps.unlocked, [reg.path]);
  assert.deepEqual(deps.removed, [reg.path]);
  assert.equal(deps.pruneCalls, 1);
});

test("sweepWorktreeJanitorOnce: an alive-pid registration is never unlocked/removed (AC2)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakeDeps({ registrations: [reg], isPidAlive: () => true, directoryExists: () => false });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result, { reaped: [], failed: [], skippedAlive: 1, skippedPresent: 0, remaining: 0 });
  assert.deepEqual(deps.unlocked, []);
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepWorktreeJanitorOnce: a dead-pid/present-directory registration is never touched (AC3)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakeDeps({ registrations: [reg], isPidAlive: () => false, directoryExists: () => true });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result, { reaped: [], failed: [], skippedAlive: 0, skippedPresent: 1, remaining: 0 });
  assert.deepEqual(deps.unlocked, []);
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepWorktreeJanitorOnce: bounds work to batchSize — a bigger backlog spans multiple cycles (AC4)", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 30 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakeDeps({ registrations, isPidAlive: () => false, directoryExists: () => false });
  const first = await sweepWorktreeJanitorOnce(deps, 10);
  assert.equal(first.reaped.length, 10);
  assert.equal(first.remaining, 20);
  assert.equal(deps.unlocked.length, 10);

  const second = await sweepWorktreeJanitorOnce(
    fakeDeps({
      registrations: registrations.filter((r) => !first.reaped.includes(r.path)),
      isPidAlive: () => false,
      directoryExists: () => false,
    }),
    10,
  );
  assert.equal(second.reaped.length, 10);
  assert.equal(second.remaining, 10);
});

test("sweepWorktreeJanitorOnce: mixed backlog — reaps candidates, skips alive/present, batches correctly", async () => {
  const dead: WorktreeRegistration = { path: "/repo/.claude/worktrees/dead", lockReason: "claude session dead (pid 1 start now)" };
  const alive: WorktreeRegistration = { path: "/repo/.claude/worktrees/alive", lockReason: "claude session alive (pid 2 start now)" };
  const present: WorktreeRegistration = { path: "/repo/.claude/worktrees/present", lockReason: "claude session present (pid 3 start now)" };
  const unlocked: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-1", lockReason: null };
  const deps = fakeDeps({
    registrations: [dead, alive, present, unlocked],
    isPidAlive: (pid) => pid === 2,
    directoryExists: (path) => path === present.path,
  });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result.reaped, [dead.path]);
  assert.equal(result.skippedAlive, 1);
  assert.equal(result.skippedPresent, 1);
  assert.equal(result.remaining, 0);
});

test("sweepWorktreeJanitorOnce: a registration outside worktreeRoot is never unlocked/removed, even dead-pid + missing-directory (#825 gate② [janitor-scope-not-enforced])", async () => {
  const outOfRoot: WorktreeRegistration = { path: "/repo/some/other/place", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakeDeps({ registrations: [outOfRoot], isPidAlive: () => false, directoryExists: () => false });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result, { reaped: [], failed: [], skippedAlive: 0, skippedPresent: 0, remaining: 0 });
  assert.deepEqual(deps.unlocked, []);
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepWorktreeJanitorOnce: a failed unlock/remove is recorded and does not block the rest of the batch", async () => {
  const bad: WorktreeRegistration = { path: "/repo/.claude/worktrees/bad", lockReason: "claude session bad (pid 1 start now)" };
  const good: WorktreeRegistration = { path: "/repo/.claude/worktrees/good", lockReason: "claude session good (pid 2 start now)" };
  const deps = fakeDeps({
    registrations: [bad, good],
    isPidAlive: () => false,
    directoryExists: () => false,
    unlock: async (path) => {
      if (path === bad.path) throw new Error("boom");
    },
  });
  const result = await sweepWorktreeJanitorOnce(deps);
  assert.deepEqual(result.reaped, [good.path]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.path, bad.path);
  assert.equal(deps.pruneCalls, 1); // still pruned — `good` was actually removed
});
