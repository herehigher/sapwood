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
import { existsSync, statSync } from "node:fs";
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

/** #834 (gate② round 1, F2): resolves the repo's DEFAULT BRANCH ref via `git symbolic-ref
 *  refs/remotes/origin/HEAD` — the standard git plumbing fact for "what branch does origin
 *  consider default", INDEPENDENT of whatever branch the trusted checkout HAPPENS to currently
 *  be on. This is a real, previously-fixed bug: nothing pins the checkout this janitor runs
 *  from to the default branch, so an engine invoked from an integration/release branch would
 *  otherwise silently judge ancestry against ITS OWN transient checkout state, reading an
 *  UNMERGED candidate as "merged" the moment it merges into that other branch. `null` on any
 *  resolution failure (no `origin` remote, no configured HEAD for it) — the fail-safe direction:
 *  isBranchMerged then never treats anything as a merge candidate rather than guessing. */
async function resolveDefaultBranchRef(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    const ref = stdout.trim();
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

export interface PresentDirectorySweepDeps extends WorktreeJanitorClassifyDeps {
  listRegistrations(): Promise<WorktreeRegistration[]>;
  /** Resolves the git-index-mtime PURITY BASELINE for a present directory — NaN when
   *  unresolvable (fail-safe: worktreeMaybeDirty then reads dirty). Real default:
   *  resolveWorktreeIndexBaselineMs (context-manifest.ts), the SAME baseline peripheral.ts's
   *  maybeRetainWorktree and worker.ts's settleMergedWorktree (#834 Phase 1) already use. */
  indexBaselineMs(path: string): number;
  /** #834 (gate② round 1, F4): the shared TOCTOU-safe rename-tombstone-verify-delete primitive
   *  (worker.ts's settleWorktreeDirectory) — ONE implementation, reused by Phase 1 (worker.ts's
   *  own settleMergedWorktree) and this arm, per the owner's explicit "one implementation, two
   *  callers" instruction; see that function's own doc for the full TOCTOU-closing rationale
   *  (rename first, re-verify the tombstone, only then delete — never a plain check-then-rmSync).
   *  Injectable so classification-only tests (batch bound, age gate, branch-merged gate) can
   *  fake it without touching real fs; F7's composition tests use the REAL implementation
   *  against a real fixture. */
  settleDirectory(worktreePath: string, worktreeRoot: string, baselineMs: number): WorktreeDirectorySettleOutcome;
  /** Elapsed ms since this registration's last git activity — NaN when unresolvable (fail-safe:
   *  never a candidate, the conservative direction). Real default resolves the linked worktree's
   *  git ADMIN directory (resolveWorktreeGitDir) and reads ITS OWN mtime. #834 (gate② round 1,
   *  F9): this is honestly a LAST-GIT-ACTIVITY (quiescence) proxy, not a pure creation-time one
   *  — ordinary git operations run INSIDE the worktree (commit, checkout, even a plain `git
   *  status` under some configurations) create and remove an `index.lock` file in this exact
   *  admin directory, which bumps its mtime each time. That is actually the BETTER gate for this
   *  arm's purpose: "how long has NOTHING touched this worktree via git", not merely "how long
   *  ago was it created" — a worktree whose lane is still alive and running normal git commands
   *  keeps resetting this clock, exactly the "still in use, leave it" signal this gate wants. */
  registrationAgeMs(path: string): number;
  /** `true` when `branch` (a full `refs/heads/...` ref) is already an ancestor of the repo's
   *  DEFAULT BRANCH (resolveDefaultBranchRef — `git symbolic-ref refs/remotes/origin/HEAD`,
   *  #834 gate② round 1 F2), never merely the trusted checkout's current HEAD (see
   *  resolveDefaultBranchRef's own doc for why those two are NOT the same fact). `false` on ANY
   *  git error (unresolvable branch, unresolvable default-branch ref, detached HEAD, etc.) —
   *  fail-safe: never a merge candidate without proof. */
  isBranchMerged(branch: string): Promise<boolean>;
  unlock(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  prune(): Promise<void>;
}

export interface PresentDirectorySweepResult {
  reaped: string[];
  /** Purity-dirty candidates, or an untouched failed-rename attempt (settleDirectory's own
   *  `"retained"` verdict covers both — see its doc) — left in place — counted, never
   *  per-directory-escalated (the issue's own explicit "never per-directory events for the
   *  stock" line). An attempted-but-INCOMPLETE deletion is a DIFFERENT bucket: `failed`, below. */
  retained: string[];
  /** Every registration this arm looked at but did not reap: alive-owner, under-age, unmerged-
   *  branch, detached/branchless, beyond this cycle's window, or a prune-step failure (#834
   *  gate② round 1, F6 — counted here under a sentinel path since it isn't about any ONE
   *  directory). One number — the whole POINT of the rollup is that the stock never generates
   *  per-entry noise. For a SINGLE cycle this is the complete picture; a caller that runs
   *  MULTIPLE cycles against the same candidate pool (the to-completion path) must NOT simply
   *  sum this field across cycles — see `mergeGateSkipped`'s own doc and
   *  runPresentDirectoryWorktreeSweepToCompletion's doc for why. */
  skipped: number;
  /** #834 (gate② round 4, A2): the subset of `skipped` produced specifically by the in-batch
   *  `isBranchMerged` gate (an unlocked-merged-candidate whose branch turned out NOT to be
   *  merged) — broken out because the to-completion runner needs it separately: once a candidate
   *  is examined at all (added to the identity-based `seen` set, regardless of verdict), it never
   *  reappears in any LATER cycle's classification pass, so a merge-gate skip from an early cycle
   *  would otherwise vanish from the run's final total instead of landing in either `skipped` or
   *  any other bucket. Always `0` for a candidate that never reached the merge-gate check
   *  (classification-skipped, or LOCKED+dead-pid, which has no merge gate at all). */
  mergeGateSkipped: number;
  /** An attempted-but-incomplete deletion (settleDirectory's own `"failed"` verdict) or a whole-
   *  sweep prune failure (F6, under PRUNE_FAILURE_SENTINEL_PATH). `tombstonePath` (#834 gate②
   *  round 2, G2; wording corrected round 3, W1) is present on every reachable `"failed"`
   *  verdict — the path where any SURVIVING residue would be, never a guarantee everything
   *  survives (a recursive removal can delete several entries before failing on a later one) —
   *  see WorktreeDirectorySettleOutcome's own doc. */
  failed: Array<{ path: string; error: string; tombstonePath?: string }>;
  /** #834 (gate② round 2, G1): the exact candidate PATHS this cycle's window actually examined
   *  (every entry in `batch`, regardless of individual verdict) — the identity-based cursor
   *  runPresentDirectoryWorktreeSweepToCompletion accumulates across cycles. Empty exactly when
   *  nothing was in this cycle's window (candidate pool exhausted, or none to begin with). */
  examinedPaths: string[];
}

/** #834 (gate② round 1, F6): the sentinel `path` a whole-sweep prune-step failure is recorded
 *  under — the result shape has no separate slot for a failure that isn't about any one
 *  directory (the reaped directories are already gone from disk either way; only the git
 *  registration-metadata prune step itself failed). */
const PRUNE_FAILURE_SENTINEL_PATH = "<worktree-janitor-prune>";

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
 *     WORKTREE_JANITOR_MIN_REGISTRATION_AGE_MS, and that branch fully merged into the repo's
 *     DEFAULT branch (isBranchMerged) — checked LAST, since it is the only per-candidate git
 *     call, after the window below has already shrunk the candidate set.
 *
 *  WINDOWING (#834 gate② round 1, F5; collapsed to ONE mode round 4, A2 — the owner's own
 *  architecture ruling): the CLASSIFICATION pass above always scans every registration (cheap:
 *  no subprocess calls), but the batch of candidates this cycle actually EXAMINES through the
 *  merge/purity gates is a `batchSize`-wide WINDOW, never the WHOLE candidate list at once. There
 *  used to be a SECOND windowing mode (a randomized numeric `offset`, for the single-cycle
 *  engine-startup caller) alongside this one — the owner ruled that dual-mode split unjustified
 *  complexity and had it deleted; there is now exactly ONE windowing rule, for every caller:
 *   - `alreadyExamined` provided (the to-completion caller, gate② round 2 G1): candidates whose
 *     path is already in that set are filtered out FIRST, then the window is the first
 *     `batchSize` of what remains — an IDENTITY-based cursor, immune to the list shrinking when
 *     a candidate gets reaped between cycles.
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
 *  (the shared rename-tombstone-verify-delete primitive, #834 gate② round 1 F1/F4) — never a
 *  separate check-then-delete pair, which would leave a TOCTOU window between the purity read
 *  and the deletion. */
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

  // #834 (gate② round 2, G1): the to-completion caller's identity-based cursor — filter OUT
  // already-examined candidates before windowing, so a candidate the CALLER already looked at
  // this run is never re-selected regardless of what position it now sits at. (Round 4, A2: the
  // single-cycle caller passes no set at all, so `unexamined` is just `candidates` — the window
  // is then simply the first `batchSize` of the full list, from the head, every time.)
  const unexamined = alreadyExamined ? candidates.filter((c) => !alreadyExamined.has(c.path)) : candidates;
  const batch = unexamined.slice(0, batchSize);
  skipped += unexamined.length - batch.length; // candidates outside this cycle's window

  const reaped: string[] = [];
  const retained: string[] = [];
  const failed: Array<{ path: string; error: string; tombstonePath?: string }> = [];
  let mergeGateSkipped = 0;
  for (const c of batch) {
    if (c.kind === "unlocked-merged-candidate") {
      const merged = await deps.isBranchMerged(c.branch);
      if (!merged) {
        skipped++;
        mergeGateSkipped++; // #834 (gate② round 4, A2) — see this field's own doc
        continue;
      }
    }
    const baseline = deps.indexBaselineMs(c.path);
    const settled = deps.settleDirectory(c.path, deps.worktreeRoot, baseline);
    if (settled.verdict === "retained") {
      retained.push(c.path);
      continue;
    }
    if (settled.verdict === "failed") {
      // #834 (gate② round 2, G2; wording corrected round 3, W1): tombstonePath, when present, is
      // where any SURVIVING residue would be — deletion may be only partially complete, never
      // assume full recovery — see WorktreeDirectorySettleOutcome's own doc.
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
      // #834 (gate② round 1, F6): a prune failure must never escape this function — every
      // reaped directory is ALREADY gone from disk either way, and letting this throw would
      // skip sweepPresentDirectoryWorktreesAndReport's own single rollup event entirely.
      failed.push({ path: PRUNE_FAILURE_SENTINEL_PATH, error: String(error) });
    }
  }
  return { reaped, retained, skipped, mergeGateSkipped, failed, examinedPaths: batch.map((c) => c.path) };
}

/** Real deps for sweepPresentDirectoryWorktreesOnce — reuses createWorktreeJanitorDeps's own
 *  git-backed listRegistrations/isPidAlive/directoryExists/unlock/remove/prune wholesale (#834's
 *  own "reuse the janitor's existing deps machinery" instruction) rather than growing a second
 *  git-wiring implementation, and adds only the purity/age/merged reads this arm needs on top.
 *  The default-branch ref (#834 gate② round 1, F2) is resolved AT MOST ONCE per deps object —
 *  memoized in this closure, not re-resolved per candidate — since it cannot change mid-sweep. */
export function createPresentDirectorySweepDeps(repoRoot: string = process.cwd()): PresentDirectorySweepDeps {
  const base = createWorktreeJanitorDeps(repoRoot);
  let defaultBranchRefPromise: Promise<string | null> | undefined;
  const resolveDefaultBranchRefOnce = (): Promise<string | null> => {
    if (defaultBranchRefPromise === undefined) defaultBranchRefPromise = resolveDefaultBranchRef(repoRoot);
    return defaultBranchRefPromise;
  };
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
    async isBranchMerged(branch) {
      const defaultRef = await resolveDefaultBranchRefOnce();
      if (defaultRef === null) return false; // no resolvable default branch -> never a candidate
      try {
        await pexecFile("git", ["-C", repoRoot, "merge-base", "--is-ancestor", branch, defaultRef]);
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
 *  never thrown — same posture as cli.ts's other best-effort startup passes. This is a SINGLE
 *  bounded cycle (#834 gate② round 4, A2 — the owner's dual-windowing-mode ruling deleted the
 *  offset-rotation mode this used to also support): with no `alreadyExamined` set,
 *  sweepPresentDirectoryWorktreesOnce examines the first `batchSize` candidates from the head of
 *  the list every call — OPPORTUNISTIC, not a coverage guarantee; see cli.ts's own startup
 *  wiring doc for why that trade-off is accepted there. */
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

/** #834 (gate② round 1, F5; cursor fixed round 2, G1; skipped-count fixed round 4, A2) — the
 *  present-directory arm's own to-completion path, the AC5 operator one-shot counterpart to
 *  runWorktreeJanitorToCompletion above, but with a DIFFERENT termination rule: unlike the
 *  missing-directory reap (where a successfully-reaped candidate LEAVES the candidate list, so
 *  the list itself shrinks toward empty across cycles), a retained/skipped present-directory
 *  candidate is NOT removed from the registration list and reappears at the SAME position on
 *  every re-scan — "no more work to do" here means "every candidate has now been examined once
 *  in this run", not "the list is empty". This is the ONLY caller that ever passes
 *  `alreadyExamined` to sweepPresentDirectoryWorktreesOnce (#834 gate② round 4, A2 — the
 *  single-cycle engine-startup caller never does, by owner ruling: see that function's own
 *  windowing doc).
 *
 *  IDENTITY-based cursor (G1): accumulates a `seen` SET of candidate PATHS across cycles, passed
 *  as `alreadyExamined` — each cycle examines the first `batchSize` candidates NOT already in
 *  `seen`, which is correct regardless of how the underlying list reshuffles or shrinks between
 *  calls (an index-based cursor is not — a cycle that reaps candidates 0-2 out of 7 shrinks the
 *  NEXT `listRegistrations()` call to 4 elements, and an index computed against the OLD 7-element
 *  list points past the end of the new one; this was the exact bug the reviewer reproduced in
 *  gate② round 2). Terminates the instant a cycle's `examinedPaths` comes back empty.
 *
 *  SKIPPED-COUNT ARITHMETIC (#834 gate② round 4, A2 — found independently by both the reviewer
 *  and the PO): `reaped`/`retained`/`failed` accumulate across every cycle unchanged, since each
 *  cycle's window is disjoint from every earlier one in the same run. `skipped` needs TWO
 *  components, not one:
 *   1. The TERMINATING (final, empty-window) cycle's own `skipped` — by construction that cycle's
 *      internal candidate count is 0, so its `skipped` is exactly the count of permanently
 *      classification-skipped candidates (under-age, no-branch/detached) as of the final scan,
 *      each counted exactly once, with zero window-overflow component (gate② round 3, W4 — a
 *      naive SUM across cycles re-counts these on every single cycle, since they never enter
 *      `candidates` and so never join `seen`).
 *   2. The SUM, across every cycle, of each cycle's own `mergeGateSkipped` — an unlocked-merged-
 *      candidate whose branch fails `isBranchMerged` DOES join `seen` (it was examined, just not
 *      reaped), so it drops out of every later cycle's classification pass and would otherwise
 *      vanish from the terminating cycle's count entirely (gate② round 4, A2's own finding: W4's
 *      fix alone undercounts these). Summing `mergeGateSkipped` specifically — never the whole
 *      combined `skipped` field — is exact, because the identity-based cursor guarantees each
 *      candidate is examined AT MOST ONCE across the whole run, so there is nothing to
 *      double-count.
 *  Two local variables carry this (`finalSkipped`, `mergeGateSkippedSum`) — no new counters or
 *  state beyond that, per the owner's explicit instruction.
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
  let mergeGateSkippedSum = 0;
  const seen = new Set<string>();
  let cycle = 0;
  for (;;) {
    cycle++;
    const result = await sweepPresentDirectoryWorktreesOnce(deps, batchSize, seen);
    totalReaped.push(...result.reaped);
    totalRetained.push(...result.retained);
    totalFailed.push(...result.failed);
    mergeGateSkippedSum += result.mergeGateSkipped;
    log(
      `[sapwood:worktree-janitor] present-dir cycle ${cycle}: reaped ${result.reaped.length}, retained ${result.retained.length}, ` +
        `skipped ${result.skipped}, failed ${result.failed.length}`,
    );
    if (result.examinedPaths.length === 0) {
      // See this function's own doc for the full arithmetic: the terminating cycle's `skipped`
      // (classification-only, by construction) plus the run-wide sum of merge-gate skips.
      finalSkipped = result.skipped + mergeGateSkippedSum;
      break;
    }
    for (const p of result.examinedPaths) seen.add(p);
  }
  return {
    reaped: totalReaped,
    retained: totalRetained,
    skipped: finalSkipped,
    mergeGateSkipped: mergeGateSkippedSum,
    failed: totalFailed,
    examinedPaths: [],
  };
}
