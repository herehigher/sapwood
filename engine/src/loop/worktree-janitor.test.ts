// worktree-janitor.test.ts (#825) — Tier A: unit tests over FABRICATED `.claude/worktrees/`
// registrations (deps.listRegistrations returns canned data; no real git worktree is created).
// Covers the four Tier A cases from the issue's verification plan: dead-pid/missing-directory
// reaped, alive-pid never touched (any directory state), dead-pid/present-directory never
// reaped (scope boundary), and per-cycle batching.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyRegistration,
  createPresentDirectorySweepDeps,
  extractLockPid,
  type PresentDirectorySweepDeps,
  parseWorktreeListPorcelain,
  pruneSettledWorktreeRegistration,
  runPresentDirectoryWorktreeSweepToCompletion,
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
//    AC) — settleDirectory/indexBaselineMs are injected fakes here, never worker.ts's REAL
//    settleWorktreeDirectory/worktreeMaybeDirty (that real-fixture composition coverage is the
//    dedicated F7 block further down, against createPresentDirectorySweepDeps' REAL wiring). ──

const AGE_OLD = WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS + 1000;
const AGE_YOUNG = WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS - 1000;

function fakePresentDeps(
  over: Partial<PresentDirectorySweepDeps> & { registrations: WorktreeRegistration[] },
): PresentDirectorySweepDeps & {
  unlocked: string[];
  removed: string[];
  settleCalls: string[];
  pruneCalls: number;
} {
  const unlocked: string[] = [];
  const removed: string[] = [];
  const settleCalls: string[] = [];
  let pruneCalls = 0;
  return {
    unlocked,
    removed,
    settleCalls,
    get pruneCalls() {
      return pruneCalls;
    },
    listRegistrations: async () => over.registrations,
    worktreeRoot: over.worktreeRoot ?? ROOT,
    directoryExists: over.directoryExists ?? (() => true),
    isPidAlive: over.isPidAlive ?? (() => false),
    indexBaselineMs: over.indexBaselineMs ?? (() => 0),
    settleDirectory:
      over.settleDirectory ??
      ((path) => {
        settleCalls.push(path);
        return { verdict: "settled" };
      }),
    registrationAgeMs: over.registrationAgeMs ?? (() => AGE_OLD),
    unlock: over.unlock ?? (async (path) => void unlocked.push(path)),
    remove: over.remove ?? (async (path) => void removed.push(path)),
    prune: over.prune ?? (async () => void pruneCalls++),
  };
}

test("sweepPresentDirectoryWorktreesOnce: a LOCKED dead-pid present-directory registration that is purity-clean is reaped (unlock+remove+prune)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({ registrations: [reg], isPidAlive: () => false, directoryExists: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], retained: [], skipped: 0, failed: [], examinedPaths: [reg.path] });
  assert.deepEqual(deps.settleCalls, [reg.path]);
  assert.deepEqual(deps.unlocked, [reg.path]);
  assert.deepEqual(deps.removed, [reg.path]);
  assert.equal(deps.pruneCalls, 1);
});

test("sweepPresentDirectoryWorktreesOnce: a LOCKED dead-pid present-directory registration that is DIRTY is left in place and counted in the rollup — never unlocked/removed", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({
    registrations: [reg],
    isPidAlive: () => false,
    directoryExists: () => true,
    settleDirectory: () => ({ verdict: "retained" }),
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [reg.path], skipped: 0, failed: [], examinedPaths: [reg.path] });
  assert.deepEqual(deps.unlocked, []);
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepPresentDirectoryWorktreesOnce (gate② round 1, F1): a LOCKED dead-pid present-directory registration whose deletion FAILED (attempted but incomplete) is counted in failed, never in reaped — no unlock/remove/prune", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({
    registrations: [reg],
    isPidAlive: () => false,
    directoryExists: () => true,
    settleDirectory: () => ({ verdict: "failed", reason: "tombstone removal failed: boom" }),
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.retained, []);
  assert.deepEqual(result.failed, [{ path: reg.path, error: "tombstone removal failed: boom" }]);
  assert.deepEqual(deps.unlocked, [], "never proceeds to git against a directory that isn't PROVEN gone");
  assert.deepEqual(deps.removed, []);
  assert.equal(deps.pruneCalls, 0);
});

test("sweepPresentDirectoryWorktreesOnce (gate② round 2, G2): a failed settlement's tombstonePath, when present, is threaded into the failed entry", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const tombstonePath = "/repo/.claude/worktrees/.settle-tombstone-abc123";
  const deps = fakePresentDeps({
    registrations: [reg],
    isPidAlive: () => false,
    directoryExists: () => true,
    settleDirectory: () => ({ verdict: "failed", reason: "re-verified dirty; rename-back failed: boom", tombstonePath }),
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.failed, [{ path: reg.path, error: "re-verified dirty; rename-back failed: boom", tombstonePath }]);
});

test("sweepPresentDirectoryWorktreesOnce: an alive-pid LOCKED present-directory registration is never touched (classifyRegistration's own 'alive' verdict, unchanged)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({ registrations: [reg], isPidAlive: () => true, directoryExists: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.retained, []);
  assert.deepEqual(deps.settleCalls, []);
  assert.deepEqual(deps.unlocked, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration that is old enough and purity-clean is reaped (remove+prune, but NEVER unlock — it was never locked)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null };
  const deps = fakePresentDeps({
    registrations: [reg],
    directoryExists: () => true,
    registrationAgeMs: () => AGE_OLD,
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], retained: [], skipped: 0, failed: [], examinedPaths: [reg.path] });
  assert.deepEqual(deps.settleCalls, [reg.path]);
  assert.deepEqual(deps.unlocked, [], "an unlocked registration is never unlock()'d");
  assert.deepEqual(deps.removed, [reg.path]);
  assert.equal(deps.pruneCalls, 1);
});

test("sweepPresentDirectoryWorktreesOnce (#834 Ruling addendum): a BRANCHLESS/detached UNLOCKED present-directory registration is eligible exactly like any other — the merged-branch gate that used to make 'detached' permanently unreachable is gone", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/detached-1", lockReason: null };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true, registrationAgeMs: () => AGE_OLD });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [reg.path], retained: [], skipped: 0, failed: [], examinedPaths: [reg.path] });
  assert.deepEqual(deps.settleCalls, [reg.path]);
  assert.deepEqual(deps.removed, [reg.path]);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration UNDER the age threshold is skipped and never reaches settleDirectory", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true, registrationAgeMs: () => AGE_YOUNG });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [], examinedPaths: [] });
  assert.deepEqual(deps.settleCalls, []);
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED present-directory registration with an UNRESOLVABLE age (NaN) is skipped — fail-safe, never a candidate", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => true, registrationAgeMs: () => Number.NaN });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 1, failed: [], examinedPaths: [] });
});

test("sweepPresentDirectoryWorktreesOnce: an UNLOCKED registration whose directory is MISSING is out of this arm's scope entirely (not skipped, not reaped — sweepWorktreeJanitorOnce's own 'unlocked' verdict is untouched)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/fix-382", lockReason: null };
  const deps = fakePresentDeps({ registrations: [reg], directoryExists: () => false });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 0, failed: [], examinedPaths: [] });
});

test("sweepPresentDirectoryWorktreesOnce: per-cycle work is bounded to batchSize — overflow candidates are counted as skipped, not touched (gate② round 4, A2: window is now simply the first batchSize candidates from the head — no more offset rotation)", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 5 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakePresentDeps({ registrations, isPidAlive: () => false, directoryExists: () => true });
  const result = await sweepPresentDirectoryWorktreesOnce(deps, 2);
  assert.equal(result.reaped.length, 2);
  assert.equal(result.skipped, 3);
  assert.equal(result.examinedPaths.length, 2, "only the head window was examined — the rest counted skipped, not touched");
});

test("sweepPresentDirectoryWorktreesOnce: a mixed batch (locked-dead-clean, locked-dead-dirty, unlocked-old-clean) reaps/retains/skips correctly in one cycle", async () => {
  const lockedClean: WorktreeRegistration = { path: "/repo/.claude/worktrees/a", lockReason: "claude session a (pid 1 start now)" };
  const lockedDirty: WorktreeRegistration = { path: "/repo/.claude/worktrees/b", lockReason: "claude session b (pid 2 start now)" };
  const unlockedOld: WorktreeRegistration = { path: "/repo/.claude/worktrees/c", lockReason: null };
  const alive: WorktreeRegistration = { path: "/repo/.claude/worktrees/d", lockReason: "claude session d (pid 3 start now)" };
  const deps = fakePresentDeps({
    registrations: [lockedClean, lockedDirty, unlockedOld, alive],
    isPidAlive: (pid) => pid === 3,
    directoryExists: () => true,
    settleDirectory: (path) => (path === lockedDirty.path ? { verdict: "retained" } : { verdict: "settled" }),
    registrationAgeMs: () => AGE_OLD,
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped.sort(), [lockedClean.path, unlockedOld.path].sort());
  assert.deepEqual(result.retained, [lockedDirty.path]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.failed, []);
});

// ── #834 (gate② round 1, F5; dual-mode DELETED round 4, A2 — owner ruling): head-of-line
//    starvation used to be fenced by TWO windowing strategies (a randomized-offset rotation for
//    the single-cycle caller, plus the identity-based `alreadyExamined` cursor for the
//    to-completion caller). The owner ruled that dual-mode split unjustified complexity and had
//    the offset mode deleted outright — there is now exactly ONE windowing rule (see
//    sweepPresentDirectoryWorktreesOnce's own doc). A single bounded cycle with no
//    `alreadyExamined` set is now honestly OPPORTUNISTIC, not starvation-proof — the test below
//    pins that plainly, and the actual starvation-proof guarantee is exercised ONLY through the
//    identity-based to-completion tests further down (the one caller that still needs it). ──

test("sweepPresentDirectoryWorktreesOnce (gate② round 4, A2): a single bounded cycle with no alreadyExamined set is a plain HEAD window — a permanently-dirty head candidate is NOT starvation-proof within one call (that guarantee now belongs solely to the to-completion identity cursor, tested separately)", async () => {
  const dirtyHead: WorktreeRegistration[] = Array.from({ length: 3 }, (_, i) => ({
    path: `/repo/.claude/worktrees/dirty-${i}`,
    lockReason: `claude session dirty-${i} (pid ${i} start now)`,
  }));
  const cleanTail: WorktreeRegistration = {
    path: "/repo/.claude/worktrees/clean-tail",
    lockReason: "claude session clean-tail (pid 9 start now)",
  };
  const registrations = [...dirtyHead, cleanTail];
  const deps = fakePresentDeps({
    registrations,
    isPidAlive: () => false,
    directoryExists: () => true,
    settleDirectory: (path) => (path.startsWith("/repo/.claude/worktrees/dirty-") ? { verdict: "retained" } : { verdict: "settled" }),
  });
  // batchSize=3: this single cycle's window is exactly the three permanently-dirty head
  // entries — cleanTail is never even reached, and a SECOND call with the SAME (no-set) deps
  // would examine the exact same head window again, forever. Honest, not a bug: the
  // to-completion path is the one that must (and does, elsewhere) reach cleanTail.
  const result = await sweepPresentDirectoryWorktreesOnce(deps, 3);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.retained.sort(), dirtyHead.map((r) => r.path).sort());
  assert.equal(result.skipped, 1, "cleanTail counted skipped — outside this cycle's fixed head window");
  assert.deepEqual(
    result.examinedPaths.sort(),
    dirtyHead.map((r) => r.path).sort(),
    "only the head window was ever examined — no rotation, no identity cursor, in this mode",
  );
});

/** #834 (gate② round 2, G1): a listRegistrations fake that REFLECTS removals — `remove()` deletes
 *  the matching entry from the live list, exactly like a real `git worktree remove` does. This
 *  is the load-bearing difference from `fakePresentDeps` above (whose `registrations` array
 *  never shrinks): round 1's own to-completion test used the STATIC version, which is exactly
 *  why the index-based cursor bug (G1) slipped through gate② round 1 — a candidate list that
 *  never actually shrinks can never expose an index cursor pointing past the end of a shrunken
 *  one. Every to-completion test below uses THIS fake. */
function fakeShrinkingPresentDeps(
  initial: WorktreeRegistration[],
  overrides: Partial<PresentDirectorySweepDeps> = {},
): PresentDirectorySweepDeps & { settleCalls: string[]; removedCalls: string[] } {
  let live = [...initial];
  const settleCalls: string[] = [];
  const removedCalls: string[] = [];
  const base: PresentDirectorySweepDeps = {
    listRegistrations: async () => live,
    worktreeRoot: ROOT,
    directoryExists: () => true,
    isPidAlive: () => false,
    indexBaselineMs: () => 0,
    settleDirectory: (path) => {
      settleCalls.push(path);
      return { verdict: "settled" };
    },
    registrationAgeMs: () => AGE_OLD,
    unlock: async () => {},
    remove: async (path) => {
      removedCalls.push(path);
      live = live.filter((r) => r.path !== path); // the real-world shrinkage the fix must survive
    },
    prune: async () => {},
  };
  return { ...base, ...overrides, settleCalls, removedCalls };
}

test("runPresentDirectoryWorktreeSweepToCompletion (gate② round 1, F5): reaches the ENTIRE candidate list in one call, accumulating every cycle's counts — the operator one-shot's own full-coverage guarantee (SHRINKING registrations, per gate② round 2 G1)", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 7 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakeShrinkingPresentDeps(registrations);
  const logs: string[] = [];
  const result = await runPresentDirectoryWorktreeSweepToCompletion(deps, (m) => logs.push(m), 3);
  assert.equal(result.reaped.length, 7, "every candidate reached, across ceil(7/3) = 3 cycles");
  assert.deepEqual(
    new Set(deps.settleCalls),
    new Set(registrations.map((r) => r.path)),
    "each candidate examined EXACTLY once — no re-examination within the single lap",
  );
  assert.equal(result.examinedPaths.length, 0, "the final aggregated result's own examinedPaths is always empty — see the field's own doc");
  assert.ok(
    logs.some((m) => m.includes("cycle 3")),
    "logged every cycle, including the final partial one",
  );
});

test("runPresentDirectoryWorktreeSweepToCompletion (gate② round 2, G1 — the reviewer's own reproduction): 7 candidates, batchSize=3 — cycle 1 reaps indices 0-2 and SHRINKS the list to 4; the OLD index-based cursor (nextOffset: 3) would then point at the last element and silently skip candidates 3-5. The identity-based cursor must reach ALL 7.", async () => {
  const registrations: WorktreeRegistration[] = Array.from({ length: 7 }, (_, i) => ({
    path: `/repo/.claude/worktrees/role-${i}`,
    lockReason: `claude session role-${i} (pid ${i} start now)`,
  }));
  const deps = fakeShrinkingPresentDeps(registrations);
  const result = await runPresentDirectoryWorktreeSweepToCompletion(deps, () => {}, 3);
  assert.deepEqual(
    new Set(result.reaped),
    new Set(registrations.map((r) => r.path)),
    "all 7 candidates reaped — none silently skipped when the list shrinks mid-run",
  );
  assert.equal(result.reaped.length, 7);
  assert.deepEqual(new Set(deps.removedCalls), new Set(registrations.map((r) => r.path)));
});

test("runPresentDirectoryWorktreeSweepToCompletion (gate② round 3, W4 — the PO's own finding): the returned `skipped` is the TERMINATING cycle's count, never the sum across cycles — a run spanning multiple cycles must not inflate the permanently-skipped total", async () => {
  // 3 reapable (LOCKED dead-pid, purity-clean) candidates, batchSize=2 -> forces 3 cycles
  // (reap 2, reap 1, terminate) via the identity cursor. 2 PERMANENTLY-skipped (UNLOCKED,
  // under-age) registrations sit alongside them — classification re-counts these on EVERY
  // cycle's full re-scan (they never enter `candidates`, so they're never added to `seen`), which
  // is exactly the inflation source: summing would report 3 cycles * 2 = 6 (or more, once
  // window-overflow is folded in too), never the true count of 2.
  const reapable: WorktreeRegistration[] = Array.from({ length: 3 }, (_, i) => ({
    path: `/repo/.claude/worktrees/reapable-${i}`,
    lockReason: `claude session reapable-${i} (pid ${i} start now)`,
  }));
  const permanentlySkipped: WorktreeRegistration[] = Array.from({ length: 2 }, (_, i) => ({
    path: `/repo/.claude/worktrees/young-${i}`,
    lockReason: null, // unlocked + present + under-age -> classification-skipped, every scan
  }));
  const deps = fakeShrinkingPresentDeps([...reapable, ...permanentlySkipped], {
    registrationAgeMs: (path) => (path.includes("/young-") ? AGE_YOUNG : AGE_OLD),
  });
  const logs: string[] = [];
  const result = await runPresentDirectoryWorktreeSweepToCompletion(deps, (m) => logs.push(m), 2);
  assert.equal(result.reaped.length, 3, "all 3 reapable candidates still reached, across multiple cycles");
  assert.equal(
    result.skipped,
    2,
    "exactly the 2 permanently-skipped candidates — NOT inflated by however many cycles it took to drain the reapable set",
  );
  assert.ok(logs.length >= 3, "this run genuinely spanned multiple cycles (the scenario the inflation bug needed)");
});

test("runPresentDirectoryWorktreeSweepToCompletion (gate② round 4, A2, adapted for #834's Ruling addendum): a mixed run (1 reapable + 1 permanently-classification-skipped) pins the exact total — 1 skipped, never inflated or undercounted", async () => {
  const reapable: WorktreeRegistration = {
    path: "/repo/.claude/worktrees/reapable-1",
    lockReason: "claude session reapable-1 (pid 1 start now)",
  };
  const young: WorktreeRegistration = { path: "/repo/.claude/worktrees/young-1", lockReason: null }; // under-age -> classification-skipped
  const deps = fakeShrinkingPresentDeps([reapable, young], {
    registrationAgeMs: (path) => (path === young.path ? AGE_YOUNG : AGE_OLD),
  });
  const result = await runPresentDirectoryWorktreeSweepToCompletion(deps, () => {}, 25);
  assert.deepEqual(result.reaped, [reapable.path]);
  assert.equal(result.retained.length, 0);
  assert.equal(result.skipped, 1, "the under-age candidate, counted exactly once");
});

test("runPresentDirectoryWorktreeSweepToCompletion: an empty candidate list terminates after one no-op cycle", async () => {
  const deps = fakePresentDeps({ registrations: [] });
  const result = await runPresentDirectoryWorktreeSweepToCompletion(deps);
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 0, failed: [], examinedPaths: [] });
});

// ── #834 (gate② round 1, F6): a prune-step failure must never escape sweepPresentDirectoryWorktreesOnce
//    — every reaped directory is already gone from disk either way; only the rollup event
//    (sweepPresentDirectoryWorktreesAndReport) must still land. ──

test("sweepPresentDirectoryWorktreesOnce (gate② round 1, F6): a prune() failure is counted in failed, never thrown — the reaped directories still count as reaped (they ARE gone from disk)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({
    registrations: [reg],
    isPidAlive: () => false,
    directoryExists: () => true,
    prune: async () => {
      throw new Error("git worktree prune boom");
    },
  });
  const result = await sweepPresentDirectoryWorktreesOnce(deps);
  assert.deepEqual(result.reaped, [reg.path]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!.error, /git worktree prune boom/);
});

test("sweepPresentDirectoryWorktreesAndReport (gate② round 1, F6): the rollup event still lands exactly once even when the sweep partially failed (a prune failure)", async () => {
  const reg: WorktreeRegistration = { path: "/repo/.claude/worktrees/role-x", lockReason: "claude session role-x (pid 111 start now)" };
  const deps = fakePresentDeps({
    registrations: [reg],
    isPidAlive: () => false,
    directoryExists: () => true,
    prune: async () => {
      throw new Error("boom");
    },
  });
  const events: Array<{ kind: string; payload: unknown }> = [];
  const state = { appendEvent: (kind: string, payload: unknown) => void events.push({ kind, payload }) };
  const result = await sweepPresentDirectoryWorktreesAndReport(deps, state);
  assert.equal(events.length, 1, "the rollup event still lands despite the prune failure");
  assert.deepEqual(events[0]?.payload, {
    reaped: result.reaped.length,
    retained: result.retained.length,
    skipped: result.skipped,
    failed: result.failed.length,
  });
  assert.equal(result.failed.length, 1);
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
    settleDirectory: (path) => (path.endsWith("role-1") ? { verdict: "retained" } : { verdict: "settled" }), // one dirty, three clean
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
  assert.deepEqual(result, { reaped: [], retained: [], skipped: 0, failed: [], examinedPaths: [] });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /rollup event append failed/);
});

// ── #834 (gate② round 1, F7): REAL composition — createPresentDirectorySweepDeps wired to the
//    REAL resolveWorktreeIndexBaselineMs -> settleWorktreeDirectory -> worktreeMaybeDirty chain
//    against a REAL temp directory with a REAL git index file (the fake-verdict doctrine rule:
//    no preset verdicts for the purity check itself). Only listRegistrations/liveness/git-backed
//    deps (unlock/remove/prune) are overridden — everything purity-related is the
//    genuine production path. Mirrors worker.test.ts's own #834 mkGitIndexFixture shape. ──

function mkGitIndexFixture(worktreeRoot: string, name: string): { worktreePath: string; indexPath: string } {
  const worktreePath = join(worktreeRoot, name);
  const gitDir = join(worktreeRoot, `${name}-gitdir`);
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
  const indexPath = join(gitDir, "index");
  writeFileSync(indexPath, "");
  return { worktreePath, indexPath };
}

test("sweepPresentDirectoryWorktreesOnce (gate② round 1, F7, real composition): a REAL purity-clean present directory is actually deleted from disk and its registration reaped", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-janitor-real-"));
  try {
    const name = "role-real-clean";
    const { worktreePath, indexPath } = mkGitIndexFixture(worktreeRoot, name);
    writeFileSync(join(worktreePath, "committed.txt"), "clean\n");
    const farFuture = new Date("2099-01-01T00:00:00Z");
    utimesSync(indexPath, farFuture, farFuture);

    const real = createPresentDirectorySweepDeps(worktreeRoot);
    const reg: WorktreeRegistration = { path: worktreePath, lockReason: `claude session ${name} (pid 111 start now)` };
    const deps: PresentDirectorySweepDeps = {
      ...real,
      worktreeRoot,
      listRegistrations: async () => [reg],
      isPidAlive: () => false,
      unlock: async () => {},
      remove: async () => {},
      prune: async () => {},
    };
    const result = await sweepPresentDirectoryWorktreesOnce(deps);
    assert.deepEqual(result.reaped, [worktreePath]);
    assert.ok(!existsSync(worktreePath), "the REAL directory is actually gone");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("sweepPresentDirectoryWorktreesOnce (gate② round 1, F7, real composition): a REAL dirty present directory (a file written after the index) is retained, not deleted", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-janitor-real-"));
  try {
    const name = "role-real-dirty";
    const { worktreePath } = mkGitIndexFixture(worktreeRoot, name); // index written "now"
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted\n"); // strictly after -> dirty (inclusive >=)

    const real = createPresentDirectorySweepDeps(worktreeRoot);
    const reg: WorktreeRegistration = { path: worktreePath, lockReason: `claude session ${name} (pid 111 start now)` };
    const deps: PresentDirectorySweepDeps = {
      ...real,
      worktreeRoot,
      listRegistrations: async () => [reg],
      isPidAlive: () => false,
      unlock: async () => {},
      remove: async () => {},
      prune: async () => {},
    };
    const result = await sweepPresentDirectoryWorktreesOnce(deps);
    assert.deepEqual(result.retained, [worktreePath]);
    assert.deepEqual(result.reaped, []);
    assert.ok(existsSync(join(worktreePath, "wip.txt")), "the REAL worktree (and its WIP) survives untouched");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("sweepPresentDirectoryWorktreesOnce (gate② round 1, F7, real composition): a MISSING git index (NaN baseline) is retained — fail-safe, never guessed clean", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-janitor-real-"));
  try {
    const name = "role-real-no-index";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true }); // no `.git` pointer at all -> NaN baseline
    writeFileSync(join(worktreePath, "file.txt"), "content\n");

    const real = createPresentDirectorySweepDeps(worktreeRoot);
    const reg: WorktreeRegistration = { path: worktreePath, lockReason: `claude session ${name} (pid 111 start now)` };
    const deps: PresentDirectorySweepDeps = {
      ...real,
      worktreeRoot,
      listRegistrations: async () => [reg],
      isPidAlive: () => false,
      unlock: async () => {},
      remove: async () => {},
      prune: async () => {},
    };
    const result = await sweepPresentDirectoryWorktreesOnce(deps);
    assert.deepEqual(result.retained, [worktreePath]);
    assert.deepEqual(result.reaped, []);
    assert.ok(existsSync(worktreePath), "an unresolvable baseline never gets deleted");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// #834's Ruling addendum (see worktree-janitor.ts's own header doc): the default-branch-ancestry
// check (isBranchMerged / resolveDefaultBranchRef) this module used to expose here was DROPPED —
// it was structurally dead in a squash-merge repo (a squashed lane branch is never an ancestor of
// the default branch), and deleting a worktree directory loses no committed work regardless of
// merge state (the branch ref and its commits survive `git worktree remove`). The real-git
// fixture coverage that used to live here (default-branch-vs-current-HEAD disambiguation,
// unresolvable-origin/HEAD fail-safe) went with it.
