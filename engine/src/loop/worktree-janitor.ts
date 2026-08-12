// worktree-janitor.ts (#825) — reaps orphaned, LOCKED `.claude/worktrees/` registrations. Role/
// lane sessions launch under the `claude` CLI's own `--worktree` flag, which locks the
// registration for the session's lifetime; a session that crashes instead of exiting cleanly
// never releases that lock, and nothing else in the engine ever cleans up the resulting `git
// worktree` metadata. `git worktree list` in this repo's own dogfood checkout accumulated
// hundreds of such entries (#825's own evidence) before a naive per-entry cleanup loop timed out.
//
// Scope is deliberately narrow (see the issue's "Out of scope" note): a registration is reaped
// ONLY when its lock-owner pid is dead AND its directory is already gone. A present directory is
// NEVER touched here, regardless of its owner's liveness — the M3 dirty-worktree retention
// invariant (worker.ts's retainOrDeleteWorktree/worktreeMaybeDirty) is the only code allowed to
// delete a directory that still exists, and only after its own mtime/ctime purity check against
// the lane's immutable dispatch baseline. Reaping a present directory here would bypass that
// check entirely.
//
// #69 SIXTH legitimate child_process importer (worker.test.ts's grep-invariant enumerates the
// other five). execFile only, every git invocation targets the repo via `-C`, never a subprocess
// `cwd:` option — the same discipline review/materializer.ts already uses for its own engine-side
// git calls. This keeps "git only ever runs in the trusted main-repo context, never a worker
// worktree" mechanically checkable rather than just asserted in prose (the issue's own explicit
// constraint, mirroring retainOrDeleteWorktree's `git worktree prune` note).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pidIsAlive } from "./instance-lock.js";

const pexecFile = promisify(execFile);

/** Bounds per-cycle work (AC4) — a backlog of hundreds must never be walked in one unbounded
 *  loop. Engine startup calls sweepWorktreeJanitorOnce exactly once per start and picks up the
 *  rest on the next start/cycle; only the explicit one-shot backlog-clearance path (AC5) loops. */
export const WORKTREE_JANITOR_BATCH_SIZE = 25;

export interface WorktreeRegistration {
  path: string;
  /** `null` when the registration carries no `locked` line at all (an ordinary, unlocked
   *  worktree — out of scope for this janitor). Empty string is a real, if unusual, possibility
   *  (`git worktree lock` with no `--reason`). */
  lockReason: string | null;
}

/** Pure parser for `git worktree list --porcelain` output. Entries are blank-line-separated
 *  blocks; this janitor only needs the `worktree`/`locked` lines out of each. */
export function parseWorktreeListPorcelain(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  for (const block of output.split("\n\n")) {
    let path: string | null = null;
    let lockReason: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line === "locked") lockReason = "";
      else if (line.startsWith("locked ")) lockReason = line.slice("locked ".length);
    }
    if (path !== null) registrations.push({ path, lockReason });
  }
  return registrations;
}

/** The `claude` CLI's own lock-reason format (confirmed against this repo's live registrations,
 *  #825): `claude session <name> (pid <pid> start <date>)`, anchored start-to-end — a reason
 *  that merely CONTAINS a `pid <digits>` fragment (e.g. an unrelated hand-lock reading `debug
 *  pid 123`) does NOT match. #825 gate② finding [janitor-scope-not-enforced]: a loose substring
 *  match let an out-of-contract lock reason parse as an owner pid at all; failing to match here
 *  means "unknown owner", never a guessed pid — classifyRegistration treats that the same as an
 *  unparseable reason: an unrecognized owner is never assumed dead. */
const CLAUDE_SESSION_LOCK_RE = /^claude session \S+ \(pid (\d+) start .+\)$/;

export function extractLockPid(lockReason: string): number | null {
  const m = CLAUDE_SESSION_LOCK_RE.exec(lockReason);
  return m ? Number(m[1]) : null;
}

/** True when `candidatePath` resolves to strictly inside `root` (never equal to it — the root
 *  directory itself is never a worktree registration). Used to keep this janitor's blast radius
 *  to the repo's OWN `.claude/worktrees/` tree — see classifyRegistration's "out-of-root" verdict. */
function isUnderRoot(candidatePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidatePath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type WorktreeJanitorVerdict = "reap" | "alive" | "present" | "unlocked" | "out-of-root";

export interface WorktreeJanitorClassifyDeps {
  directoryExists(path: string): boolean;
  isPidAlive(pid: number): boolean;
  /** #825 gate② finding [janitor-scope-not-enforced]: the janitor's blast radius is bounded to
   *  THIS repo's own `.claude/worktrees/` tree — a locked registration living anywhere else
   *  (e.g. a differently-named `.claude/worktrees-legacy/`, or an unrelated repo's own worktree
   *  sharing this process's filesystem) is never a candidate, regardless of lock-reason shape or
   *  pid liveness. See createWorktreeJanitorDeps for the real default. */
  worktreeRoot: string;
}

/** #825 AC1-3 (+ gate② finding [janitor-scope-not-enforced]): the janitor's whole scope
 *  boundary, in one place.
 *   - a path outside `deps.worktreeRoot`: "out-of-root" — never touched, no matter what the lock
 *     reason says or whether its pid is dead. Checked FIRST, before the lock reason is even
 *     parsed: scope is a property of the PATH, not something a crafted lock reason can talk its
 *     way around.
 *   - unlocked (no `locked` line at all): out of scope — this janitor only governs LOCKED
 *     role/lane registrations, never an ordinary developer worktree.
 *   - a lock reason that doesn't match the claude CLI's own anchored format (or has no
 *     parseable pid): "alive" — an unrecognized owner is never assumed dead.
 *   - dead pid + missing directory: "reap".
 *   - dead pid + present directory: "present" — never reaped by THIS janitor (out of scope; the
 *     mtime/ctime purity check owns present-directory deletion).
 *   - alive pid (any directory state): "alive" — never touched. */
export function classifyRegistration(reg: WorktreeRegistration, deps: WorktreeJanitorClassifyDeps): WorktreeJanitorVerdict {
  if (!isUnderRoot(reg.path, deps.worktreeRoot)) return "out-of-root";
  if (reg.lockReason === null) return "unlocked";
  const pid = extractLockPid(reg.lockReason);
  if (pid === null || deps.isPidAlive(pid)) return "alive";
  return deps.directoryExists(reg.path) ? "present" : "reap";
}

export interface WorktreeJanitorDeps extends WorktreeJanitorClassifyDeps {
  listRegistrations(): Promise<WorktreeRegistration[]>;
  unlock(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  prune(): Promise<void>;
}

export interface WorktreeJanitorResult {
  reaped: string[];
  failed: Array<{ path: string; error: string }>;
  skippedAlive: number;
  skippedPresent: number;
  /** Reapable candidates found this cycle beyond the batch — > 0 means another cycle has work
   *  left to do. */
  remaining: number;
}

/** One bounded cycle (AC4): classifies every registration, reaps up to `batchSize` dead-pid/
 *  missing-directory candidates (unlock -> remove, best-effort per entry so one bad registration
 *  never blocks the rest of the batch — same stance as cli.ts's normalizeUnplacedBoardItems),
 *  then prunes once if anything was actually removed. Callers own the cadence: engine startup
 *  calls this once per start (bounding startup stall — AC4/AC5's "startup never stalls on the
 *  backlog"); runWorktreeJanitorToCompletion calls it in a loop for the one-shot path (AC5). */
export async function sweepWorktreeJanitorOnce(
  deps: WorktreeJanitorDeps,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
): Promise<WorktreeJanitorResult> {
  const registrations = await deps.listRegistrations();
  const candidates: string[] = [];
  let skippedAlive = 0;
  let skippedPresent = 0;
  for (const reg of registrations) {
    const verdict = classifyRegistration(reg, deps);
    if (verdict === "reap") candidates.push(reg.path);
    else if (verdict === "alive") skippedAlive++;
    else if (verdict === "present") skippedPresent++;
  }
  const batch = candidates.slice(0, batchSize);
  const reaped: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const path of batch) {
    try {
      await deps.unlock(path);
      await deps.remove(path);
      reaped.push(path);
    } catch (error) {
      failed.push({ path, error: String(error) });
    }
  }
  if (reaped.length > 0) await deps.prune();
  return { reaped, failed, skippedAlive, skippedPresent, remaining: candidates.length - batch.length };
}

/** Real git-backed deps — every invocation targets `repoRoot` via `-C`, never a subprocess
 *  `cwd:` option (worker.test.ts's #69 grep-invariant). Default `process.cwd()` matches every
 *  other engine module's "the engine always starts in the trusted main repo" convention (see
 *  worker.ts's/reconcile.ts's own `worktreeRoot` default). */
export function createWorktreeJanitorDeps(repoRoot: string = process.cwd()): WorktreeJanitorDeps {
  return {
    worktreeRoot: join(repoRoot, ".claude", "worktrees"),
    async listRegistrations() {
      const { stdout } = await pexecFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
      return parseWorktreeListPorcelain(stdout);
    },
    directoryExists: existsSync,
    isPidAlive: pidIsAlive,
    async unlock(path) {
      await pexecFile("git", ["-C", repoRoot, "worktree", "unlock", path]);
    },
    async remove(path) {
      await pexecFile("git", ["-C", repoRoot, "worktree", "remove", path]);
    },
    async prune() {
      await pexecFile("git", ["-C", repoRoot, "worktree", "prune"]);
    },
  };
}

/** #825 AC5 / Tier C: the one-shot backlog-clearance path — loops sweepWorktreeJanitorOnce until
 *  a cycle reaps nothing more (either no candidates left, or the remaining candidates all fail),
 *  logging each cycle's counts. This is the path an operator runs by hand against the dogfood
 *  checkout for the acceptance evidence (before/after `git worktree list` counts); engine
 *  startup itself only ever calls sweepWorktreeJanitorOnce ONCE per start. */
export async function runWorktreeJanitorToCompletion(
  deps: WorktreeJanitorDeps,
  log: (message: string) => void = console.error,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
): Promise<WorktreeJanitorResult> {
  const totalReaped: string[] = [];
  const totalFailed: Array<{ path: string; error: string }> = [];
  let lastSkippedAlive = 0;
  let lastSkippedPresent = 0;
  let cycle = 0;
  for (;;) {
    cycle++;
    const result = await sweepWorktreeJanitorOnce(deps, batchSize);
    totalReaped.push(...result.reaped);
    totalFailed.push(...result.failed);
    lastSkippedAlive = result.skippedAlive;
    lastSkippedPresent = result.skippedPresent;
    log(
      `[sapwood:worktree-janitor] cycle ${cycle}: reaped ${result.reaped.length}, failed ${result.failed.length}, ${result.remaining} remaining`,
    );
    // No progress this cycle (either nothing left to do, or everything in the batch failed) —
    // stop rather than spin forever on a persistently-failing entry.
    if (result.reaped.length === 0 || result.remaining === 0) break;
  }
  return { reaped: totalReaped, failed: totalFailed, skippedAlive: lastSkippedAlive, skippedPresent: lastSkippedPresent, remaining: 0 };
}
