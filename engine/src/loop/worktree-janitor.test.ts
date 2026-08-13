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
  type PresentDirectorySweepDeps,
  parseWorktreeListPorcelain,
  pruneSettledWorktreeRegistration,
  sweepPresentDirectoryWorktreesAndReport,
  sweepPresentDirectoryWorktreesOnce,
  sweepWorktreeJanitorOnce,
  WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS,
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
    { path: "/repo", lockReason: null, branch: "refs/heads/main" },
    {
      path: "/repo/.claude/worktrees/role-retro-9756358f",
      lockReason: "claude session role-retro-9756358f (pid 12345 start Tue Aug 11 07:02:48 2026)",
      branch: "refs/heads/worktree-role-retro-9756358f",
    },
    { path: "/repo/.claude/worktrees/fix-382", lockReason: null, branch: "refs/heads/feat/382" },
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

// ── #834 Phase 1: pruneSettledWorktreeRegistration — best-effort registration cleanup for a
//    MERGED lane's already-fs-deleted worktree directory (fabricated deps — no real git; the
//    PURITY check this composes with is worker.ts's real settleMergedWorktree, covered with real
//    fixtures over there per the fake-verdict doctrine rule). ──

test("pruneSettledWorktreeRegistration: unlock -> remove -> prune, in order", async () => {
  const calls: string[] = [];
  await pruneSettledWorktreeRegistration("/repo/.claude/worktrees/lane-1", {
    unlock: async () => void calls.push("unlock"),
    remove: async () => void calls.push("remove"),
    prune: async () => void calls.push("prune"),
  });
  assert.deepEqual(calls, ["unlock", "remove", "prune"]);
});

test("pruneSettledWorktreeRegistration: an unlock failure (never locked to begin with) does not block remove/prune", async () => {
  const calls: string[] = [];
  await pruneSettledWorktreeRegistration("/repo/.claude/worktrees/lane-1", {
    unlock: async () => {
      throw new Error("not locked");
    },
    remove: async () => void calls.push("remove"),
    prune: async () => void calls.push("prune"),
  });
  assert.deepEqual(calls, ["remove", "prune"]);
});

test("pruneSettledWorktreeRegistration: a remove failure does not block prune, and never throws", async () => {
  const calls: string[] = [];
  await pruneSettledWorktreeRegistration("/repo/.claude/worktrees/lane-1", {
    unlock: async () => void calls.push("unlock"),
    remove: async () => {
      throw new Error("boom");
    },
    prune: async () => void calls.push("prune"),
  });
  assert.deepEqual(calls, ["unlock", "prune"]);
});

test("pruneSettledWorktreeRegistration: a prune failure never throws", async () => {
  await pruneSettledWorktreeRegistration("/repo/.claude/worktrees/lane-1", {
    unlock: async () => {},
    remove: async () => {},
    prune: async () => {
      throw new Error("boom");
    },
  });
  // Reaching here (no throw) is the assertion.
});

// ── #834 Phase 2: sweepPresentDirectoryWorktreesOnce — the dead-owner/unlocked PRESENT-directory
//    arm. Fabricated-registration tests throughout (the issue's own explicit test shape for this
//    AC) — the isDirty/indexBaselineMs seams are injected fakes, never worker.ts's REAL
//    worktreeMaybeDirty (that real-fixture coverage lives in worker.test.ts's own #834 block,
//    against the REAL production settleMergedWorktree/resolveWorktreeIndexBaselineMs path). ──

const AGE_OLD = WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS + 1000;
const AGE_YOUNG = WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS - 1000;

function fakePresentDeps(
  over: Partial<PresentDirectorySweepDeps> & { registrations: WorktreeRegistration[] },
): PresentDirectorySweepDeps & {
  unlocked: string[];
  removed: string[];
  removedDirs: string[];
  pruneCalls: number;
  branchMergedCalls: string[];
} {
  const unlocked: string[] = [];
  const removed: string[] = [];
  const removedDirs: string[] = [];
  const branchMergedCalls: string[] = [];
  let pruneCalls = 0;
  return {
    unlocked,
    removed,
    removedDirs,
    branchMergedCalls,
    get pruneCalls() {
      return pruneCalls;
    },
    listRegistrations: async () => over.registrations,
    worktreeRoot: over.worktreeRoot ?? ROOT,
    directoryExists: over.directoryExists ?? (() => true),
    isPidAlive: over.isPidAlive ?? (() => false),
    indexBaselineMs: over.indexBaselineMs ?? (() => 0),
    isDirty: over.isDirty ?? (() => false),
    removeDirectory: over.removeDirectory ?? ((path) => void removedDirs.push(path)),
    registrationAgeMs: over.registrationAgeMs ?? (() => AGE_OLD),
    isBranchMerged:
      over.isBranchMerged ??
      (async (branch) => {
        branchMergedCalls.push(branch);
        return true;
      }),
    unlock: over.unlock ?? (async (path) => void unlocked.push(path)),
    remove: over.remove ?? (async (path) => void removed.push(path)),
    prune: over.prune ?? (async () => void pruneCalls++),
  };
}

test("sweepPresentDirectoryWorktreesOnce: a LOCKED dead-pid present-directory registration that is purity-clean is reaped (unlock+remove+prune)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({ registrations: [reg], isPidAlive: () => false, directoryExists: () => true, isDirty: () => false });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], retained: [], skipped: 0, failed: [] });
  assert.deepEqual(deps.removedDirs, [reg.path]);
  assert.deepEqual(deps.unlocked, [reg.path]);
  assert.deepEqual(deps.removed, [reg.path]);
  assert.equal(deps.pruneCalls, 1);
});

test("sweepPresentDirectoryWorktreesOnce: a LOCKED dead-pid present-directory registration that is DIRTY is left in place and counted in the rollup — never fs-deleted, never unlocked/removed", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({ registrations: [reg], isPidAlive: () => false, directoryExists: () => true, isDirty: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [reg.path], skipped: 0, failed: [] });
  assert.deepEqual(deps.removedDirs, []);
  assert.deepEqual(deps.unlocked, []);
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepPresentDirectoryWorktreesOnce: an alive-pid LOCKED present-directory registration is never touched (classifyRegistration's own 'alive' verdict, unchanged)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({ registrations: [reg], isPidAlive: () => true, directoryExists: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.retained, []);
  assert.deepEqual(deps.removedDirs, []);
  assert.deepEqual(deps.unlocked, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration whose branch is merged and old enough and purity-clean is reaped (remove+prune, but NEVER unlock — it was never locked)", async () => {
  const reg: WorktreeRegistration = {
    path: "/repo/.claude/worktrees/fix-382",
    lockReason: null,
    branch: "refs/heads/fix-382",
  };
  const deps = fakePresentDeps({
    registrations: [reg],
    directoryExists: () => true,
    registrationAgeMs: () => AGE_OLD,
    // Deliberately the DEFAULT isBranchMerged (records into branchMergedCalls and returns true)
    // — not overridden, so the call-recorded assertion below actually proves something.
    isDirty: () => false,
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], retained: [], skipped: 0, failed: [] });
  assert.deepEqual(deps.removedDirs, [reg.path]);
  assert.deepEqual(deps.unlocked, [], "an unlocked registration is never unlock()'d");
  assert.deepEqual(deps.removed, [reg.path]);
  assert.equal(deps.pruneCalls, 1);
  assert.deepEqual(deps.branchMergedCalls, [reg.branch]);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration UNDER the age threshold is skipped and NEVER reaches the branch-merged git check", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null, branch: "refs/heads/fix-382" };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true, registrationAgeMs: () => AGE_YOUNG });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [] });
  assert.deepEqual(deps.branchMergedCalls, [], "the expensive git check never runs for an under-age candidate");
  assert.deepEqual(deps.removedDirs, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration with an UNRESOLVABLE age (NaN) is skipped — fail-safe, never a candidate", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null, branch: "refs/heads/fix-382" };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true, registrationAgeMs: () => Number.NaN });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [] });
  assert.deepEqual(deps.branchMergedCalls, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration whose branch is NOT merged is skipped, never fs-deleted", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null, branch: "refs/heads/fix-382" };
  const deps = fakePresentDeps({
    registrations: [reg],
    directoryExists: () => true,
    registrationAgeMs: () => AGE_OLD,
    isBranchMerged: async () => false,
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [] });
  assert.deepEqual(deps.removedDirs, [], "never fs-deleted without proof of a merged branch");
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration with NO branch (detached) is skipped — never a merge candidate", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/detached-1", lockReason: null };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [] });
  assert.deepEqual(deps.branchMergedCalls, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED registration whose directory is MISSING is out of this arm's scope entirely (not skipped, not reaped — sweepWorktreeJanitorOnce's own 'unlocked' verdict is untouched)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null, branch: "refs/heads/fix-382" };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => false });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 0, failed: [] });
});

test("sweepPresentDirectoryWorktreesOnce: per-cycle work is bounded to batchSize — overflow candidates are counted as skipped, not touched", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 5 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakePresentDeps({ registrations, isPidAlive: () => false, directoryExists: () => true, isDirty: () => false });
  const result = await sweepPresentDirectoryWorktreesOnce(deps, 2);
  assert.equal(result.reaped.length, 2);
  assert.equal(result.skipped, 3);
});

test("sweepPresentDirectoryWorktreesOnce: a mixed batch (locked-dead-clean, locked-dead-dirty, unlocked-merged-clean) reaps/retains/skips correctly in one cycle", async () => {
  const lockedClean: WorktreeRegistration = { path: "/repo/.claude/worktrees/a", lockReason: "claude session a (pid 1 start now)" };
  const lockedDirty: WorktreeRegistration = { path: "/repo/.claude/worktrees/b", lockReason: "claude session b (pid 2 start now)" };
  const unlockedMerged: WorktreeRegistration = { path: "/repo/.claude/worktrees/c", lockReason: null, branch: "refs/heads/c" };
  const alive: WorktreeRegistration = { path: "/repo/.claude/worktrees/d", lockReason: "claude session d (pid 3 start now)" };
  const deps = fakePresentDeps({
    registrations: [lockedClean, lockedDirty, unlockedMerged, alive],
    isPidAlive: (pid) => pid === 3,
    directoryExists: () => true,
    isDirty: (path) => path === lockedDirty.path,
    registrationAgeMs: () => AGE_OLD,
    isBranchMerged: async () => true,
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped.sort(), [lockedClean.path, unlockedMerged.path].sort());
  assert.deepEqual(result.retained, [lockedDirty.path]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.failed, []);
});

test("sweepPresentDirectoryWorktreesAndReport: exactly ONE worktree-janitor-rollup event per sweep, never a per-directory event for the stock", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 4 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakePresentDeps({
    registrations,
    isPidAlive: () => false,
    directoryExists: () => true,
    isDirty: (path) => path.endsWith("role-1"), // one dirty, three clean
  });
  const events: Array<{ kind: string; payload: unknown }> = [];
  const state = { appendEvent: (kind: string, payload: unknown) => void events.push({ kind, payload }) };
  const result = await sweepPresentDirectoryWorktreesAndReport(deps, state);
  assert.equal(events.length, 1, "exactly one rollup event, regardless of how many directories were touched");
  assert.equal(events[0]?.kind, "worktree-janitor-rollup");
  assert.deepEqual(events[0]?.payload, {
    reaped: result.reaped.length,
    retained: result.retained.length,
    skipped: result.skipped,
    failed: result.failed.length,
  });
  assert.equal(result.reaped.length, 3);
  assert.equal(result.retained.length, 1);
});

test("sweepPresentDirectoryWorktreesAndReport: a failing appendEvent never throws (best-effort, logged)", async () => {
  const deps = fakePresentDeps({ registrations: [] });
  const state = {
    appendEvent: () => {
      throw new Error("db closed");
    },
  };
  const logs: string[] = [];
  const result = await sweepPresentDirectoryWorktreesAndReport(deps, state, (m) => logs.push(m));
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 0, failed: [] });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /rollup event append failed/);
});
