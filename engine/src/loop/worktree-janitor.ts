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
// mtime, resolveWorktreeIndexBaselineMs — see that function's doc) plus conservative liveness/
// age/merged-branch gates per class. See that function's own doc for the full policy; the
// PRINCIPLE above is unchanged — nothing here ever deletes a present directory without first
// proving it clean via the filesystem purity check, never git's own status/clean-filter path
// (the #65 RCE class worker.ts's retainOrDeleteWorktree doc explains at length).
//
// #69 SIXTH legitimate child_process importer (worker.test.ts's grep-invariant enumerates the
// other five). execFile only, every git invocation targets the repo via `-C`, never a subprocess
// `cwd:` option — the same discipline review/materializer.ts already uses for its own engine-side
// git calls. This keeps "git only ever runs in the trusted main-repo context, never a worker
// worktree" mechanically checkable rather than just asserted in prose (the issue's own explicit
// constraint, mirroring retainOrDeleteWorktree's `git worktree prune` note). #834's own present-
// directory reaping keeps the SAME discipline: the directory is always fs-deleted FIRST (never a
// git call against a still-present worker-controlled tree), so every git call here ever only
// ever touches an ALREADY-missing path — see sweepPresentDirectoryWorktreesOnce's own doc.
import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveWorktreeGitDir, resolveWorktreeIndexBaselineMs } from "../roles/context-manifest.js";
import { worktreeMaybeDirty } from "../roles/worker.js";
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
  /** #834 Phase 2: the worktree's checked-out branch (`branch refs/heads/X` porcelain line),
   *  full ref form. Omitted for a DETACHED worktree (a bare `detached` line, no `branch` line at
   *  all) — the present-directory sweep's UNLOCKED arm treats a missing branch as "never a merge
   *  candidate": there is nothing to prove "fully merged into the default branch" against. */
  branch?: string;
}

/** Pure parser for `git worktree list --porcelain` output. Entries are blank-line-separated
 *  blocks; this janitor only needs the `worktree`/`locked`/`branch` lines out of each. */
export function parseWorktreeListPorcelain(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  for (const block of output.split("\n\n")) {
    let path: string | null = null;
    let lockReason: string | null = null;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line === "locked") lockReason = "";
      else if (line.startsWith("locked ")) lockReason = line.slice("locked ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (path !== null) registrations.push({ path, lockReason, ...(branch !== undefined ? { branch } : {}) });
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
 *  never be swept just because its branch happens to already be merged (a fast-follow fix-leg
 *  can merge before its OWN worktree naturally winds down) — this is the one signal standing in
 *  for "nothing is actively using this" where the UNLOCKED class carries no pid to check at all.
 *  24h comfortably clears any single lane's realistic lifetime (worker.ts's own heartbeat-stale/
 *  timeout bounds are all well under an hour) while still being tight enough to clear a real,
 *  weeks-old backlog (#825's own census). */
export const WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS = 24 * 60 * 60 * 1000;

export interface PresentDirectorySweepDeps extends WorktreeJanitorClassifyDeps {
  listRegistrations(): Promise<WorktreeRegistration[]>;
  /** Resolves the git-index-mtime PURITY BASELINE for a present directory — NaN when
   *  unresolvable (fail-safe: worktreeMaybeDirty then reads dirty). Real default:
   *  resolveWorktreeIndexBaselineMs (context-manifest.ts), the SAME baseline peripheral.ts's
   *  maybeRetainWorktree and worker.ts's settleMergedWorktree (#834 Phase 1) already use. */
  indexBaselineMs(path: string): number;
  /** worker.ts's worktreeMaybeDirty, unchanged — the ONE purity scan every caller in this
   *  codebase shares; only the baseline differs. */
  isDirty(path: string, sinceMs: number): boolean;
  /** fs-only directory deletion — MUST run, and MUST succeed, before either `unlock` or `remove`
   *  below ever touches the path: git must never clean-check a still-PRESENT worker-controlled
   *  tree (the #65 RCE class worker.ts's retainOrDeleteWorktree doc explains at length). Real
   *  default: `rmSync(path, { recursive: true, force: true })`. */
  removeDirectory(path: string): void;
  /** Elapsed ms since this registration was created — NaN when unresolvable (fail-safe: never a
   *  candidate, the conservative direction). Real default resolves the linked worktree's git
   *  ADMIN directory (resolveWorktreeGitDir) and reads ITS OWN mtime: `git worktree add` creates
   *  that directory once and, short of `git worktree repair`/relocation, nothing an ordinary
   *  commit/checkout inside the worktree ever touches its entry set again — a stable
   *  "registration age" proxy without a second, less-portable birthtime read. */
  registrationAgeMs(path: string): number;
  /** `true` when `branch` (a full `refs/heads/...` ref) is already an ancestor of the TRUSTED
   *  main checkout's current HEAD — this janitor's own operational convention (every module in
   *  this file only ever runs from the trusted main-repo cwd, never a worker worktree) makes
   *  "ancestor of HEAD" and "merged into the default branch" the same fact without a second
   *  default-branch-resolution path (forge.ts's getDefaultBranchChecks) this module has no forge
   *  handle to call anyway. `false` on ANY git error (unresolvable branch, detached HEAD, etc.)
   *  — fail-safe: never a merge candidate without proof. */
  isBranchMerged(branch: string): Promise<boolean>;
  unlock(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  prune(): Promise<void>;
}

export interface PresentDirectorySweepResult {
  reaped: string[];
  /** Purity-dirty candidates left untouched in place — counted, never per-directory-escalated
   *  (the issue's own explicit "never per-directory events for the stock" line). */
  retained: string[];
  /** Every registration this arm looked at but did not reap: alive-owner, under-age, unmerged-
   *  branch, detached/branchless, or candidates beyond this cycle's batch bound. One number —
   *  the whole POINT of the rollup is that the stock never generates per-entry noise. */
  skipped: number;
  failed: Array<{ path: string; error: string }>;
}

type PresentDirectoryCandidate =
  | { path: string; kind: "locked-dead" }
  | { path: string; kind: "unlocked-merged-candidate"; branch: string };

/** #834 Phase 2: ONE bounded cycle over the present-directory stock, covering exactly the two
 *  conservative classes the issue names:
 *   - LOCKED + dead owner pid + directory present (classifyRegistration's own "present" verdict,
 *     today's 5-member class per #825's census) — purity-checked, no other gate needed (a dead
 *     pid already proves nobody is driving it).
 *   - UNLOCKED + directory present — a MUCH weaker signal (no pid to check at all), so gated by
 *     ALL THREE of: a real branch to check (never detached), registration age past
 *     WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS, and that branch fully merged into the trusted
 *     checkout's HEAD (isBranchMerged) — checked LAST, since it is the only per-candidate git
 *     call, after the batch bound below has already shrunk the candidate set.
 *  Bounded to `batchSize` REAPABLE candidates (reusing WORKTREE_JANITOR_BATCH_SIZE, the issue's
 *  own instruction) — the expensive isBranchMerged check runs only inside that bound, so a
 *  147-registration backlog costs at most `batchSize` subprocess calls per cycle, not 147.
 *  Every candidate, clean or dirty, is fs-DELETED (removeDirectory) BEFORE any git call — see
 *  PresentDirectorySweepDeps.removeDirectory's own doc for why that ordering is load-bearing,
 *  never just tidiness. */
export async function sweepPresentDirectoryWorktreesOnce(
  deps: PresentDirectorySweepDeps,
  batchSize: number = WORKTREE_JANITOR_BATCH_SIZE,
): Promise<PresentDirectorySweepResult> {
  const registrations = await deps.listRegistrations();
  const candidates: PresentDirectoryCandidate[] = [];
  let skipped = 0;
  for (const reg of registrations) {
    const verdict = classifyRegistration(reg, deps);
    if (verdict === "present") {
      candidates.push({ path: reg.path, kind: "locked-dead" });
      continue;
    }
    if (verdict === "unlocked" && deps.directoryExists(reg.path)) {
      if (!reg.branch) {
        skipped++; // detached/no branch line -> never provably "fully merged"
        continue;
      }
      const ageMs = deps.registrationAgeMs(reg.path);
      if (!Number.isFinite(ageMs) || ageMs < WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS) {
        skipped++; // unresolvable or too young -> the conservative "leave it" direction
        continue;
      }
      candidates.push({ path: reg.path, kind: "unlocked-merged-candidate", branch: reg.branch });
    }
    // "reap"/"alive"/"out-of-root"/(unlocked, no directory): not this arm's concern.
  }
  const batch = candidates.slice(0, batchSize);
  skipped += candidates.length - batch.length; // overflow beyond this cycle's bound
  const reaped: string[] = [];
  const retained: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const c of batch) {
    if (c.kind === "unlocked-merged-candidate") {
      const merged = await deps.isBranchMerged(c.branch);
      if (!merged) {
        skipped++;
        continue;
      }
    }
    const baseline = deps.indexBaselineMs(c.path);
    if (deps.isDirty(c.path, baseline)) {
      retained.push(c.path);
      continue;
    }
    try {
      deps.removeDirectory(c.path);
    } catch (error) {
      failed.push({ path: c.path, error: String(error) });
      continue; // never call git against a directory we failed to remove — see doc above
    }
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
  if (reaped.length > 0) await deps.prune();
  return { reaped, retained, skipped, failed };
}

/** Real deps for sweepPresentDirectoryWorktreesOnce — reuses createWorktreeJanitorDeps's own
 *  git-backed listRegistrations/isPidAlive/directoryExists/unlock/remove/prune wholesale (#834's
 *  own "reuse the janitor's existing deps machinery" instruction) rather than growing a second
 *  git-wiring implementation, and adds only the purity/age/merged reads this arm needs on top. */
export function createPresentDirectorySweepDeps(repoRoot: string = process.cwd()): PresentDirectorySweepDeps {
  const base = createWorktreeJanitorDeps(repoRoot);
  return {
    ...base,
    indexBaselineMs: resolveWorktreeIndexBaselineMs,
    isDirty: worktreeMaybeDirty,
    removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
    registrationAgeMs(path) {
      const gitDir = resolveWorktreeGitDir(path);
      if (gitDir === null) return Number.NaN;
      try {
        return Date.now() - statSync(gitDir).mtimeMs;
      } catch {
        return Number.NaN;
      }
    },
    async isBranchMerged(branch) {
      try {
        await pexecFile("git", ["-C", repoRoot, "merge-base", "--is-ancestor", branch, "HEAD"]);
        return true;
      } catch {
        return false; // not an ancestor, or unresolvable — never a merge candidate without proof
      }
    },
  };
}

/** #834 Phase 2 AC: exactly ONE `worktree-janitor-rollup` event per sweep — never a per-
 *  directory event for the present-directory stock (retained/skipped counts alone are the
 *  honest signal; a per-entry escalation storm is exactly what #825's own missing-directory reap
 *  design already rejected for its class too). Best-effort: a failed event append is logged,
 *  never thrown — same posture as cli.ts's other best-effort startup passes. */
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
