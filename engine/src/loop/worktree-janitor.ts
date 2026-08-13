// worktree-janitor.ts (#825) — reaps orphaned, LOCKED `.claude/worktrees/` registrations. Role/
// lane sessions launch under the `claude` CLI's own `--worktree` flag, which locks the
// registration for the session's lifetime; a session that crashes instead of exiting cleanly
// never releases that lock, and nothing else in the engine ever cleans up the resulting `git
// worktree` metadata. `git worktree list` in this repo's own dogfood checkout accumulated
// hundreds of such entries (#825's own evidence) before a naive per-entry cleanup loop timed out.
//
// classifyRegistration's own base scope stays narrow: sweepWorktreeJanitorOnce (#825's original
// pass) reaps ONLY a dead-pid/MISSING-directory registration. A present directory is never
// reaped BY THAT PASS, regardless of owner liveness — bypassing worker.ts's own mtime/ctime
// purity check (worktreeMaybeDirty) would risk deleting real, uncommitted work.
//
// #834 (the real 150-dir/4.5GB backlog #825's own pass turned out to skip entirely — its census
// found ZERO dead-pid/missing-directory members) extends this module with a SECOND, separate
// pass — sweepPresentDirectoryWorktreesOnce — that DOES reach present directories, but only
// behind the SAME purity check (worktreeMaybeDirty, baselined on the worktree's own git-index
// mtime, resolveWorktreeIndexBaselineMs — see that function's doc) plus a conservative
// liveness/age gate per class. See that function's own doc for the full policy; the PRINCIPLE
// above is unchanged — nothing here ever deletes a present directory without first proving it
// clean via the filesystem purity check, never git's own status/clean-filter path (the #65 RCE
// class worker.ts's retainOrDeleteWorktree doc explains at length).
//
// #834's Ruling addendum (owner, live Tier C run 2026-08-13): the UNLOCKED arm originally also
// gated on the candidate's branch being merged into the default branch (`isBranchMerged`,
// `merge-base --is-ancestor`). That gate was structurally dead in THIS repo: a squash-merged lane
// branch is never an ancestor of the default branch, so the check returned false for every one of
// 137 of 146 live candidates, permanently. DROPPED — the UNLOCKED gate is registration age plus
// the purity check alone. Safety argument: deleting a worktree DIRECTORY loses no committed
// work — the branch ref and its commits survive `git worktree remove` regardless of merge state —
// and the purity check already protects any uncommitted work; the merged-branch condition was
// guarding a fact those two already cover.
//
// #834: that safety argument has a hole — "the branch ref and its commits survive" is only true
// when the worktree actually HAS a branch ref backing its HEAD. A DETACHED worktree's own commits
// can be reachable ONLY via that worktree's own admin HEAD (and its reflog); deleting the
// registration deletes the admin directory, and a detached-only commit goes unreachable
// (GC-eligible) the moment it does — confirmed with a real `git fsck --unreachable --no-reflogs`
// repro. Fix: EVERY deletable class (LOCKED dead-pid included, not just UNLOCKED) requires a
// SYMBOLIC admin HEAD (`ref: refs/heads/...`) before a candidate is even considered
// (hasSymbolicHead below) — a raw-SHA (detached), unreadable, or missing HEAD is a
// classification-skip, never a candidate. This makes the Ruling addendum's own safety argument
// actually hold for every candidate it reaches: git itself refuses to delete a branch checked out
// in ANY worktree (`error: cannot delete branch '...' used by worktree`), so a symbolic HEAD
// whose target ref later vanishes out from under it would require deliberate manual ref surgery —
// outside this janitor's own accident-fence threat model (it fences against automation reaping
// live work, not against a human hand-deleting a ref another worktree still points at).
//
// #834: the index-mtime purity baseline has a blind spot for STAGED-but-uncommitted work,
// independent of the merge gate this PR otherwise dropped — `git add` writes the index file AFTER
// the staged file's own mtime, so once the tree ages past the registration-age threshold, every
// real file in it reads OLDER than the index and the mtime-only scan calls it clean even with
// staged content sitting in the index (reproduced: a worktree with only a staged addition, index
// artificially aged, reads purity-clean and gets deleted without this fix). Fix:
// hasNoStagedWorktreeChanges below, applied to EVERY present-directory candidate class (LOCKED
// dead-pid too, not just UNLOCKED) — `git --git-dir=<adminDir> diff --cached --quiet` compares the
// index against HEAD directly, catching what an mtime comparison structurally cannot. This
// targets the worktree's ADMIN directory specifically (never `-C repoRoot`, which would inspect
// the MAIN repo's own index, not this candidate's) — the admin directory lives under the TRUSTED
// main repo's own `.git/worktrees/`, never inside the worker-controlled tree itself, so this stays
// outside the #65 clean-filter RCE class: `diff --cached` compares index bytes against HEAD
// without materializing or filtering any working-tree file, and no configured filter/hook ever
// executes for it. That command line is itself an execution surface the SHARED repo config can
// reach (writable by any worker with an ordinary `Bash(git *)` grant) — `diff.external`/per-path
// diff drivers, `textconv`, and `core.fsmonitor` are all config-named programs git can invoke
// during this exact invocation, confirmed by real repro. Pinned off explicitly: `--no-ext-diff`
// and `--no-textconv` on the command line, plus `-c diff.external= -c core.fsmonitor= -c
// core.pager=` — see hasNoStagedWorktreeChanges's own doc for the full enumeration and why each
// one is real. `-c` values on the command line always win over any config source, so none of
// these can be shadowed by what the untrusted shared config sets.
//
// #69 SIXTH legitimate child_process importer (worker.test.ts's grep-invariant enumerates the
// other five). execFile only; every git invocation either targets the repo via `-C` or, for
// hasNoStagedWorktreeChanges above, an explicit `--git-dir=<adminDir>` — never a subprocess `cwd:`
// option either way, and never a path inside a worker-controlled tree — the same discipline
// review/materializer.ts already uses for its own engine-side git calls. This keeps "git only
// ever runs in the trusted main-repo context, never a worker worktree" mechanically checkable
// rather than just asserted in prose (the issue's own explicit constraint, mirroring
// retainOrDeleteWorktree's `git worktree prune` note). #834's own present-directory DELETION
// keeps the SAME discipline: the directory is always fs-deleted FIRST (never a git call against a
// still-present worker-controlled tree), so every deletion-adjacent git call here only ever
// touches an ALREADY-missing path — see sweepPresentDirectoryWorktreesOnce's own doc. (The
// durable-ref and staged-content gates above are pre-deletion PROOF-GATHERING calls, not deletion
// calls — they read admin-side state that always exists ahead of and independent of the
// fs-delete-first sequencing.)
//
// #834: the staged-content blind spot above isn't unique to this module's own sweep —
// conductor.ts's settleMergedLane (Phase 1's merged-lane close-out, via worker.ts's
// Supervisor.settleMergedWorktree) runs the SAME index-mtime-only purity check and has the SAME
// hole. worker.ts's #69 grep-invariant forbids git there, so hasNoStagedWorktreeChanges below is
// EXPORTED (not module-private) so settleMergedLane can run the identical check itself, BEFORE
// ever calling settleMergedWorktree — one implementation, two callers, see that function's own
// doc.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveWorktreeGitDir, resolveWorktreeIndexBaselineMs } from "../roles/context-manifest.js";
import { settleWorktreeDirectory, type WorktreeDirectorySettleOutcome } from "../roles/worker.js";
import type { State } from "../state/state.js";
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

/** #834 Phase 1: prunes a MERGED lane's now-directory-less git-worktree REGISTRATION — worker.ts
 *  structurally cannot do this itself (its own #69 grep-invariant only lets it launch the
 *  `claude` CLI, nothing else), so conductor.ts's settleMergedLane calls here instead, AFTER
 *  worker.ts's settleMergedWorktree has already fs-deleted the directory. The SAME unlock ->
 *  remove -> prune sequence sweepWorktreeJanitorOnce's own "reap" verdict already runs against a dead-pid/
 *  missing-directory registration — `git worktree remove` succeeds fine against an
 *  administrative entry whose directory is already gone (confirmed: that IS the reap verdict's
 *  own precondition). Best-effort per step: `unlock` failing (never locked to begin with — a
 *  lane's ordinary dispatch never locks its own registration the way a role/`claude --worktree`
 *  session does) or `remove` failing must never surface as a settlement failure to the caller —
 *  only wired to log, never to throw, mirroring sweepWorktreeJanitorOnce's own per-entry
 *  tolerance narrowed to a single path. */
export async function pruneSettledWorktreeRegistration(
  worktreePath: string,
  deps: Pick<WorktreeJanitorDeps, "unlock" | "remove" | "prune"> = createWorktreeJanitorDeps(),
): Promise<void> {
  try {
    await deps.unlock(worktreePath);
  } catch {
    /* not locked, or already unlocked — fine, an ordinary lane's registration usually isn't */
  }
  try {
    await deps.remove(worktreePath);
  } catch {
    /* best-effort disk-hygiene, same stance as retainOrDeleteWorktree's own dangling-registration
     * note — never turns into a settlement failure the caller must handle */
  }
  try {
    await deps.prune();
  } catch {
    /* best-effort */
  }
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

// ── #834 Phase 2: the dead-owner/unlocked PRESENT-directory sweep — the real 150-dir/4.5GB
//    backlog #825's own pass (above) turned out to skip entirely (its own census: ZERO members
//    in its dead-pid/missing-directory reap class against the live checkout). Deliberately a
//    SEPARATE pass from sweepWorktreeJanitorOnce, not a change to classifyRegistration's verdicts
//    — that function's existing five-verdict contract (and its own test suite) stays exactly as
//    #825 left it; this arm asks a NARROWER, additional question ("is this present-directory
//    registration ALSO conservatively safe to reap") only for the two classes named below. ──

/** #834 Phase 2: how old an UNLOCKED, directory-present registration's registration must be
 *  before it is even a CANDIDATE for this sweep — a FIXED CONSTANT, never a config key (the
 *  issue's own explicit scope line). A freshly-created worktree a still-driving lane owns must
 *  never be swept just because it happens to look old enough at a glance — this is the one signal
 *  standing in for "nothing is actively using this" where the UNLOCKED class carries no pid to
 *  check at all (per #834's Ruling addendum, the ONLY such signal now that the merged-branch gate
 *  is gone — see this module's own header doc). 24h comfortably clears any single lane's
 *  realistic lifetime (worker.ts's own heartbeat-stale/timeout bounds are all well under an hour)
 *  while still being tight enough to clear a real, weeks-old backlog (#825's own census). */
export const WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS = 24 * 60 * 60 * 1000;

export interface PresentDirectorySweepDeps extends WorktreeJanitorClassifyDeps {
  listRegistrations(): Promise<WorktreeRegistration[]>;
  /** Resolves the git-index-mtime PURITY BASELINE for a present directory — NaN when
   *  unresolvable (fail-safe: worktreeMaybeDirty then reads dirty). Real default:
   *  resolveWorktreeIndexBaselineMs (context-manifest.ts), the SAME baseline peripheral.ts's
   *  maybeRetainWorktree and worker.ts's settleMergedWorktree (#834 Phase 1) already use. */
  indexBaselineMs(path: string): number;
  /** The shared TOCTOU-safe rename-tombstone-verify-delete primitive (worker.ts's
   *  settleWorktreeDirectory) — ONE implementation, reused by Phase 1 (worker.ts's own
   *  settleMergedWorktree) and this arm, per the owner's explicit "one implementation, two
   *  callers" instruction; see that function's own doc for the full TOCTOU-closing rationale
   *  (rename first, re-verify the tombstone, only then delete — never a plain check-then-rmSync).
   *  Injectable so classification-only tests (batch bound, age gate) can fake it without
   *  touching real fs; the real-composition tests further down use the REAL implementation
   *  against a real fixture. */
  settleDirectory(worktreePath: string, worktreeRoot: string, baselineMs: number): WorktreeDirectorySettleOutcome;
  /** Elapsed ms since this registration's last git activity — NaN when unresolvable (fail-safe:
   *  never a candidate, the conservative direction). Real default resolves the linked worktree's
   *  git ADMIN directory (resolveWorktreeGitDir) and reads ITS OWN mtime — honestly a
   *  LAST-GIT-ACTIVITY (quiescence) proxy, not a pure creation-time one: ordinary git operations
   *  run INSIDE the worktree (commit, checkout, even a plain `git status` under some
   *  configurations) create and remove an `index.lock` file in this exact admin directory, which
   *  bumps its mtime each time. That is actually the BETTER gate for this arm's purpose: "how
   *  long has NOTHING touched this worktree via git", not merely "how long ago was it created" —
   *  a worktree whose lane is still alive and running normal git commands keeps resetting this
   *  clock, exactly the "still in use, leave it" signal this gate wants. Per #834's Ruling
   *  addendum, this (plus the purity check and the hasSymbolicHead/hasNoStagedChanges gates
   *  below) is the ENTIRE UNLOCKED gate — see this module's own header doc for why the
   *  formerly-paired merged-branch check was dropped. */
  registrationAgeMs(path: string): number;
  /** #834: `true` only when the worktree's ADMIN HEAD file (resolveWorktreeGitDir →
   *  `<gitDir>/HEAD`, a plain fs read — no git subprocess, no porcelain branch parsing) is a
   *  SYMBOLIC ref (`ref: refs/heads/...`) — the shape a checked-out branch produces. `false` for
   *  a raw 40-hex SHA (detached HEAD), an unreadable/missing HEAD file, or an unresolvable admin
   *  directory — fail-safe, never guessed eligible. Checked for EVERY present-directory candidate
   *  class, LOCKED dead-pid included — see this module's own header doc for why a detached
   *  worktree's commits need this gate regardless of pid liveness (a dead pid says nothing about
   *  what the worktree's HEAD points at). Real default: worktreeHeadIsSymbolic below. */
  hasSymbolicHead(path: string): boolean;
  /** #834: `true` only when `git --git-dir=<adminDir> diff --cached --quiet` exits 0 against this
   *  candidate's worktree — i.e. the index matches HEAD, nothing staged. ANY non-zero exit (real
   *  staged content) OR any error (unresolvable admin dir, anything else) reads `false` —
   *  fail-safe, never guessed clean; see this module's own header doc for why the index-mtime
   *  purity baseline alone cannot see staged-but-uncommitted work, and why this stays outside the
   *  #65 clean-filter RCE class. Checked for EVERY present-directory candidate class (LOCKED
   *  dead-pid included) — a dead pid or an old, purity-clean-by-mtime registration says nothing
   *  about what's sitting in the index. Real default: git-backed, targeting the admin directory
   *  via `--git-dir`, never `-C repoRoot` (see header doc). */
  hasNoStagedChanges(path: string): Promise<boolean>;
  unlock(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  prune(): Promise<void>;
}

export interface PresentDirectorySweepResult {
  reaped: string[];
  /** Purity-dirty candidates, a candidate with staged-but-uncommitted content
   *  (`hasNoStagedChanges` reading false), or an untouched failed-rename attempt
   *  (settleDirectory's own `"retained"` verdict covers the purity case — see its doc) — left in
   *  place — counted, never per-directory-escalated (the issue's own explicit "never
   *  per-directory events for the stock" line). An attempted-but-INCOMPLETE deletion is a
   *  DIFFERENT bucket: `failed`, below. */
  retained: string[];
  /** Every registration this arm looked at but did not reap: alive-owner, under-age (or an
   *  unresolvable age reading), a non-symbolic/unreadable admin HEAD (classification-time, every
   *  candidate class), beyond this cycle's window, or a prune-step failure (counted here under a
   *  sentinel path since it isn't about any ONE directory). One number — the whole POINT of the
   *  rollup is that the stock never generates per-entry noise. Every candidate this cycle's
   *  window actually REACHES (i.e. every entry counted in `examinedPaths`) ends in exactly one of
   *  `reaped`/`retained`/`failed` — never `skipped` — so a caller running multiple cycles against
   *  the same candidate pool (the to-completion path) can safely take the TERMINATING (final,
   *  empty-window) cycle's own `skipped` as the run's total; see
   *  runPresentDirectoryWorktreeSweepToCompletion's own doc. */
  skipped: number;
  /** An attempted-but-incomplete deletion (settleDirectory's own `"failed"` verdict) or a
   *  whole-sweep prune failure (under PRUNE_FAILURE_SENTINEL_PATH). `tombstonePath` is present on
   *  every reachable `"failed"` verdict — the path where any SURVIVING residue would be, never a
   *  guarantee everything survives (a recursive removal can delete several entries before
   *  failing on a later one) — see WorktreeDirectorySettleOutcome's own doc. */
  failed: Array<{ path: string; error: string; tombstonePath?: string }>;
  /** The exact candidate PATHS this cycle's window actually examined (every entry in `batch`,
   *  regardless of individual verdict) — the identity-based cursor
   *  runPresentDirectoryWorktreeSweepToCompletion accumulates across cycles. Empty exactly when
   *  nothing was in this cycle's window (candidate pool exhausted, or none to begin with). */
  examinedPaths: string[];
}

/** The sentinel `path` a whole-sweep prune-step failure is recorded under — the result shape has
 *  no separate slot for a failure that isn't about any one directory (the reaped directories are
 *  already gone from disk either way; only the git registration-metadata prune step itself
 *  failed). */
const PRUNE_FAILURE_SENTINEL_PATH = "<worktree-janitor-prune>";

type PresentDirectoryCandidate = { path: string; kind: "locked-dead" } | { path: string; kind: "unlocked-candidate" };

/** #834: ONE bounded cycle over the present-directory stock, covering exactly the two
 *  conservative classes the issue names, each gated by the SAME three checks before it ever
 *  reaches settleDirectory: a SYMBOLIC admin HEAD (hasSymbolicHead — a non-symbolic/unreadable
 *  HEAD means the worktree's commits have no durable ref surviving the registration prune, so
 *  it's never a candidate, dead pid or not), NO staged content (hasNoStagedChanges, checked in
 *  the batch loop below — the index-mtime purity baseline can't see it, see this module's own
 *  header doc), and the purity baseline itself:
 *   - LOCKED + dead owner pid + directory present (classifyRegistration's own "present" verdict).
 *   - UNLOCKED + directory present — a much weaker signal (no pid to check at all), so ALSO
 *     gated by registration age past WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS. Age + a symbolic
 *     HEAD + purity + no staged content is the full UNLOCKED gate (see this module's own header
 *     doc for #834's Ruling addendum, which dropped the branch-merged-into-default gate this
 *     class used to also carry).
 *
 *  WINDOWING: the CLASSIFICATION pass above always scans every registration (cheap: no
 *  subprocess calls), but the batch of candidates this cycle actually EXAMINES through the
 *  staged/purity gates is a `batchSize`-wide WINDOW, never the WHOLE candidate list at once.
 *  Exactly ONE windowing rule, for every caller:
 *   - `alreadyExamined` provided (the to-completion caller): candidates whose path is already in
 *     that set are filtered out FIRST, then the window is the first `batchSize` of what remains
 *     — an IDENTITY-based cursor, immune to the list shrinking when a candidate gets reaped
 *     between cycles.
 *   - `alreadyExamined` omitted (the single-cycle engine-startup caller): the window is simply
 *     the first `batchSize` candidates from the head of the list, unconditionally — see cli.ts's
 *     own startup wiring doc for why a fixed head window is an accepted, OPPORTUNISTIC trade-off
 *     there (the to-completion path, not this one, is what provably reaches everything).
 *
 *  `examinedPaths` in the result is the exact set of candidate paths this cycle's window
 *  actually reached (regardless of verdict) — what the to-completion caller accumulates into its
 *  own `alreadyExamined` set for the next call.
 *
 *  Every candidate this cycle actually reaches, clean or dirty, goes through settleDirectory
 *  (the shared rename-tombstone-verify-delete primitive) — never a separate check-then-delete
 *  pair, which would leave a TOCTOU window between the purity read and the deletion. Every
 *  candidate this cycle's window reaches ends in exactly one of `reaped`/`retained`/`failed` —
 *  never `skipped` (that bucket is classification-only, above). */
export async function sweepPresentDirectoryWorktreesOnce(
  deps: PresentDirectorySweepDeps,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
  alreadyExamined?: ReadonlySet<string>,
): Promise<PresentDirectorySweepResult> {
  const registrations = await deps.listRegistrations();
  const candidates: PresentDirectoryCandidate[] = [];
  let skipped = 0;
  for (const reg of registrations) {
    const verdict = classifyRegistration(reg, deps);
    if (verdict === "present") {
      // #834: a dead pid proves nobody is DRIVING this worktree, but says nothing about what its
      // HEAD points at — a detached LOCKED worktree needs the identical durable-ref gate the
      // UNLOCKED arm applies below, or its commits are just as unreachable once pruned.
      if (!deps.hasSymbolicHead(reg.path)) {
        skipped++;
        continue;
      }
      candidates.push({ path: reg.path, kind: "locked-dead" });
      continue;
    }
    if (verdict === "unlocked" && deps.directoryExists(reg.path)) {
      if (!deps.hasSymbolicHead(reg.path)) {
        skipped++; // detached/unreadable HEAD -> no durable ref, never a candidate
        continue;
      }
      const ageMs = deps.registrationAgeMs(reg.path);
      if (!Number.isFinite(ageMs) || ageMs < WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS) {
        skipped++; // unresolvable or too young -> the conservative "leave it" direction
        continue;
      }
      candidates.push({ path: reg.path, kind: "unlocked-candidate" });
    }
    // "reap"/"alive"/"out-of-root"/(unlocked, no directory): not this arm's concern.
  }

  // The to-completion caller's identity-based cursor — filter OUT already-examined candidates
  // before windowing, so a candidate the CALLER already looked at this run is never re-selected
  // regardless of what position it now sits at. The single-cycle caller passes no set at all, so
  // `unexamined` is just `candidates` — the window is then simply the first `batchSize` of the
  // full list, from the head, every time.
  const unexamined = alreadyExamined ? candidates.filter((c) => !alreadyExamined.has(c.path)) : candidates;
  const batch = unexamined.slice(0, batchSize);
  skipped += unexamined.length - batch.length; // candidates outside this cycle's window

  const reaped: string[] = [];
  const retained: string[] = [];
  const failed: Array<{ path: string; error: string; tombstonePath?: string }> = [];
  for (const c of batch) {
    // Staged-but-uncommitted content is invisible to the index-mtime purity baseline (below) —
    // checked for EVERY class, LOCKED dead-pid included, before that baseline even runs. A
    // `false` reading (real staged content OR any resolution error) is the same "leave it, count
    // it" bucket as a purity-dirty verdict.
    if (!(await deps.hasNoStagedChanges(c.path))) {
      retained.push(c.path);
      continue;
    }
    const baseline = deps.indexBaselineMs(c.path);
    const settled = deps.settleDirectory(c.path, deps.worktreeRoot, baseline);
    if (settled.verdict === "retained") {
      retained.push(c.path);
      continue;
    }
    if (settled.verdict === "failed") {
      // tombstonePath, when present, is where any SURVIVING residue would be — deletion may be
      // only partially complete, never assume full recovery — see
      // WorktreeDirectorySettleOutcome's own doc.
      failed.push({
        path: c.path,
        error: settled.reason ?? "settle failed",
        ...(settled.tombstonePath !== undefined ? { tombstonePath: settled.tombstonePath } : {}),
      });
      continue; // never call git against a directory that isn't PROVEN gone
    }
    // settled.verdict === "settled" — the directory is provably gone; prune its registration.
    try {
      if (c.kind === "locked-dead") {
        try {
          await deps.unlock(c.path);
        } catch {
          /* best-effort — an already-unlocked registration (a benign race) is fine */
        }
      }
      await deps.remove(c.path);
      reaped.push(c.path);
    } catch (error) {
      failed.push({ path: c.path, error: String(error) });
    }
  }
  if (reaped.length > 0) {
    try {
      await deps.prune();
    } catch (error) {
      // A prune failure must never escape this function — every reaped directory is ALREADY gone
      // from disk either way, and letting this throw would skip
      // sweepPresentDirectoryWorktreesAndReport's own single rollup event entirely.
      failed.push({ path: PRUNE_FAILURE_SENTINEL_PATH, error: String(error) });
    }
  }
  return { reaped, retained, skipped, failed, examinedPaths: batch.map((c) => c.path) };
}

/** #834: true only when `<gitDir>/HEAD` is a SYMBOLIC ref (`ref: refs/heads/<name>`), verified
 *  STRICTLY:
 *   - the path must `lstat` as a REGULAR FILE — a SYMLINK HEAD is rejected outright, never
 *     followed (modern git itself never creates one; a symlink here is either stale/foreign
 *     tooling or hostile, and this function trusts neither).
 *   - its RAW first line must match `ref: refs/heads/<non-whitespace>` EXACTLY via an anchored
 *     regex, never a mere `startsWith` — trailing garbage after the ref name on the same line,
 *     or any ADDITIONAL non-empty line, is rejected. Only a single trailing newline is tolerated
 *     (the well-formed shape splits into exactly `[line, ""]`).
 *  Plain filesystem read via resolveWorktreeGitDir + readFileSync — no git subprocess, no
 *  porcelain branch parsing (see this module's own header doc for why: a detached worktree's
 *  commits have no durable ref outside its own admin HEAD/reflog, which the registration prune
 *  deletes). Any resolution failure (unresolvable admin dir, unreadable/missing HEAD file, a
 *  symlink, malformed content) reads false — fail-safe, never guessed eligible. */
const SYMBOLIC_HEAD_LINE_RE = /^ref: refs\/heads\/\S+$/;

function worktreeHeadIsSymbolic(worktreePath: string): boolean {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (gitDir === null) return false;
  const headPath = join(gitDir, "HEAD");
  try {
    if (!lstatSync(headPath).isFile()) return false; // a symlink (or anything else) is never trusted
    const lines = readFileSync(headPath, "utf8").split("\n");
    if (lines.length > 2 || (lines.length === 2 && lines[1] !== "")) return false; // trailing garbage line(s)
    const firstLine = lines[0]!.replace(/\r$/, ""); // tolerate a CRLF line ending only
    return SYMBOLIC_HEAD_LINE_RE.test(firstLine);
  } catch {
    return false;
  }
}

/** #834: `true` only when `git --git-dir=<adminDir> diff --cached --quiet` exits 0 for
 *  `worktreePath` — the index matches HEAD, nothing staged. Non-zero exit (real staged content)
 *  OR any RESOLUTION error (unresolvable admin dir, an unrecognized git failure) reads `false` —
 *  fail-safe, never guessed clean. An UNBORN HEAD is NOT lumped into that fail-safe bucket by
 *  git's own exit-code semantics, and this function doesn't fight that: an EMPTY index on an
 *  unborn HEAD exits 0 (nothing staged, nothing to lose — correctly `true`), while STAGED content
 *  on an unborn HEAD exits 1 exactly like the ordinary case (correctly `false`) — see the `catch`
 *  block below for the confirmed-by-real-repro behavior. See this module's own header doc for why
 *  the index-mtime purity baseline alone cannot see staged-but-uncommitted work.
 *
 *  The shared repo config (writable by any worker with an ordinary `Bash(git *)` grant — `git
 *  config --local` in a LINKED worktree writes the shared `.git/config`, since a worktree has no
 *  config of its own by default) can name arbitrary programs `git diff` executes. This function
 *  pins off every such vector it can reach,
 *  explicitly and belt-and-braces, rather than trusting `--quiet`'s own "exit-code only" fast
 *  path to skip them (that fast path is an unstated implementation detail this function must
 *  never depend on for safety — a config knob can defeat it: `diff.<driver>.trustExitCode`
 *  makes git honor the DRIVER's own exit code even under `--quiet`/`--exit-code`, confirmed by
 *  real repro below):
 *   - `diff.external` / a per-path driver (`.gitattributes` `diff=<name>` +
 *     `diff.<name>.command`, optionally paired with `diff.<name>.trustExitCode` to force
 *     invocation even under `--quiet`) — pinned off by BOTH `-c diff.external=` (the global
 *     knob) AND `--no-ext-diff` (disables per-path drivers too, per `git-diff`'s own doc)
 *     redundantly, since either alone is a real config surface an attacker's config could try to
 *     re-enable via a still-later `-c` if only one were used (`-c` values on THIS command line
 *     always win regardless of order, but belt-and-braces costs nothing).
 *   - `diff.<driver>.textconv` (binary-to-text conversion before diffing) — pinned off by
 *     `--no-textconv`.
 *   - `core.fsmonitor` — a config-named PROGRAM git may exec while refreshing the index for ANY
 *     command that reads it, `--quiet` included (CONFIRMED: reproduced a real fsmonitor hook
 *     executing under the exact `--quiet` invocation this function used before this fix,
 *     independent of ext-diff/textconv entirely). Pinned off by `-c core.fsmonitor=`.
 *   - `core.pager` — belt-and-braces even though `--quiet` produces no output to page: pinned
 *     off by `-c core.pager=` so a future change to the invocation (e.g. dropping `--quiet`)
 *     can't silently reintroduce a pager-exec surface.
 *  Filter/smudge/clean drivers (`filter.<driver>.*`) are NOT a vector here: those run on
 *  checkout/`git add`, never on `diff --cached`, which only compares already-written index bytes
 *  against HEAD — never applies a content filter. Hooks (pre-commit, etc.) are not invoked by
 *  `git diff` at all. `-c` values on THIS command line take precedence over any config source
 *  (worktree-local, repo, global, system) regardless of what the shared config says, so these
 *  five overrides cannot be shadowed by anything the untrusted config sets.
 *
 *  EXPORTED (not module-private like worktreeHeadIsSymbolic above) because conductor.ts's
 *  settleMergedLane needs the IDENTICAL check at merged-lane close-out: worker.ts's #69
 *  grep-invariant forbids git there, so the caller runs this same helper BEFORE
 *  ever invoking Supervisor.settleMergedWorktree — one implementation, two callers, the same
 *  "one implementation, two callers" stance settleWorktreeDirectory (worker.ts) already
 *  established for the TOCTOU-safe deletion primitive itself. */
export async function hasNoStagedWorktreeChanges(worktreePath: string): Promise<boolean> {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (gitDir === null) return false; // unresolvable admin dir -> fail-safe dirty
  try {
    // `--git-dir` targets the candidate's OWN admin directory directly — never `-C repoRoot`,
    // which would inspect the MAIN repo's index instead of this worktree's. `diff --cached
    // --quiet` compares the index against HEAD only; it never touches, materializes, or filters
    // a working-tree file, and runs from this process's own cwd (never a path inside the
    // worker-controlled tree). The `-c`/`--no-ext-diff`/`--no-textconv` set above pins off every
    // config-driven execution vector this function's own doc enumerates — see that doc for why
    // each one is needed and confirmed real.
    await pexecFile("git", [
      "--git-dir",
      gitDir,
      "-c",
      "diff.external=",
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.pager=",
      "diff",
      "--cached",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    return true; // exit 0 -> index matches HEAD, nothing staged
  } catch {
    // exit 1 (real staged content) or any error -> dirty. Includes an UNBORN HEAD: an empty
    // index against no HEAD at all reads CLEAN (this command exits 0 the same as any other
    // no-difference case — there is nothing staged to lose), while any actually staged content
    // on an unborn HEAD reads dirty exactly like the ordinary case, never a special "unknown".
    return false;
  }
}

/** Real deps for sweepPresentDirectoryWorktreesOnce — reuses createWorktreeJanitorDeps's own
 *  git-backed listRegistrations/isPidAlive/directoryExists/unlock/remove/prune wholesale (#834's
 *  own "reuse the janitor's existing deps machinery" instruction) rather than growing a second
 *  git-wiring implementation, and adds only the purity/age/symbolic-head/staged-content reads this
 *  arm needs on top. (The default-branch-ancestry read this used to also wire up here was removed
 *  per #834's Ruling addendum — see this module's own header doc.) */
export function createPresentDirectorySweepDeps(repoRoot: string = process.cwd()): PresentDirectorySweepDeps {
  const base = createWorktreeJanitorDeps(repoRoot);
  return {
    ...base,
    indexBaselineMs: resolveWorktreeIndexBaselineMs,
    settleDirectory: settleWorktreeDirectory,
    registrationAgeMs(path) {
      const gitDir = resolveWorktreeGitDir(path);
      if (gitDir === null) return Number.NaN;
      try {
        return Date.now() - statSync(gitDir).mtimeMs;
      } catch {
        return Number.NaN;
      }
    },
    hasSymbolicHead: worktreeHeadIsSymbolic,
    hasNoStagedChanges: hasNoStagedWorktreeChanges,
  };
}

/** #834 Phase 2 AC: exactly ONE `worktree-janitor-rollup` event per sweep — never a per-
 *  directory event for the present-directory stock (retained/skipped counts alone are the
 *  honest signal; a per-entry escalation storm is exactly what #825's own missing-directory reap
 *  design already rejected for its class too). Best-effort: a failed event append is logged,
 *  never thrown — same posture as cli.ts's other best-effort startup passes. This is a SINGLE
 *  bounded cycle: with no `alreadyExamined` set, sweepPresentDirectoryWorktreesOnce examines the
 *  first `batchSize` candidates from the head of the list every call — OPPORTUNISTIC, not a
 *  coverage guarantee; see cli.ts's own startup wiring doc for why that trade-off is accepted
 *  there. */
export async function sweepPresentDirectoryWorktreesAndReport(
  deps: PresentDirectorySweepDeps,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
): Promise<PresentDirectorySweepResult> {
  const result = await sweepPresentDirectoryWorktreesOnce(deps, batchSize);
  try {
    state.appendEvent("worktree-janitor-rollup", {
      reaped: result.reaped.length,
      retained: result.retained.length,
      skipped: result.skipped,
      failed: result.failed.length,
    });
  } catch (error) {
    log(`[sapwood:worktree-janitor] rollup event append failed (non-fatal): ${String(error)}`);
  }
  return result;
}

/** #834: the present-directory arm's own to-completion path, the AC5 operator one-shot
 *  counterpart to runWorktreeJanitorToCompletion above, but with a DIFFERENT termination rule:
 *  unlike the missing-directory reap (where a successfully-reaped candidate LEAVES the candidate
 *  list, so the list itself shrinks toward empty across cycles), a retained/skipped
 *  present-directory candidate is NOT removed from the registration list and reappears at the
 *  SAME position on every re-scan — "no more work to do" here means "every candidate has now been
 *  examined once in this run", not "the list is empty". This is the ONLY caller that ever passes
 *  `alreadyExamined` to sweepPresentDirectoryWorktreesOnce (the single-cycle engine-startup
 *  caller never does, by owner ruling: see that function's own windowing doc).
 *
 *  IDENTITY-based cursor: accumulates a `seen` SET of candidate PATHS across cycles, passed as
 *  `alreadyExamined` — each cycle examines the first `batchSize` candidates NOT already in
 *  `seen`, which is correct regardless of how the underlying list reshuffles or shrinks between
 *  calls. An INDEX-based cursor is not: a cycle that reaps candidates 0-2 out of 7 shrinks the
 *  NEXT `listRegistrations()` call to 4 elements, and an index computed against the OLD
 *  7-element list points past the end of the new one. Terminates the instant a cycle's
 *  `examinedPaths` comes back empty.
 *
 *  SKIPPED-COUNT ARITHMETIC: `reaped`/`retained`/`failed` accumulate across every cycle unchanged,
 *  since each cycle's window is disjoint from every earlier one in the same run. With the
 *  merged-branch gate gone (#834's Ruling addendum — see this module's own header doc), every
 *  candidate the window ever REACHES ends in reaped/retained/failed, never skipped — a candidate
 *  can no longer be examined (join `seen`) and then vanish from every bucket. So `skipped` is
 *  exactly ONE component: the TERMINATING (final, empty-window) cycle's own `skipped` — by
 *  construction that cycle's internal candidate count is 0, so its `skipped` is exactly the count
 *  of permanently classification-skipped (under-age, or unresolvable-age) candidates as of the
 *  final scan, each counted exactly once (a naive SUM across cycles would re-count these on every
 *  single cycle, since they never enter `candidates` and so never join `seen`).
 *
 *  This is the SAME code path scripts/worktree-janitor.ts (the operator one-shot script) now runs
 *  alongside the existing missing-directory pass. */
export async function runPresentDirectoryWorktreeSweepToCompletion(
  deps: PresentDirectorySweepDeps,
  log: (message: string) => void = console.error,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
): Promise<PresentDirectorySweepResult> {
  const totalReaped: string[] = [];
  const totalRetained: string[] = [];
  const totalFailed: Array<{ path: string; error: string; tombstonePath?: string }> = [];
  let finalSkipped = 0;
  const seen = new Set<string>();
  let cycle = 0;
  for (;;) {
    cycle++;
    const result = await sweepPresentDirectoryWorktreesOnce(deps, batchSize, seen);
    totalReaped.push(...result.reaped);
    totalRetained.push(...result.retained);
    totalFailed.push(...result.failed);
    log(
      `[sapwood:worktree-janitor] present-dir cycle ${cycle}: reaped ${result.reaped.length}, retained ${result.retained.length}, ` +
        `skipped ${result.skipped}, failed ${result.failed.length}`,
    );
    if (result.examinedPaths.length === 0) {
      // See this function's own doc: the terminating (empty-window) cycle's own `skipped` IS the
      // run's total — nothing else to add now that every reached candidate ends in
      // reaped/retained/failed.
      finalSkipped = result.skipped;
      break;
    }
    for (const p of result.examinedPaths) seen.add(p);
  }
  return {
    reaped: totalReaped,
    retained: totalRetained,
    skipped: finalSkipped,
    failed: totalFailed,
    examinedPaths: [],
  };
}
