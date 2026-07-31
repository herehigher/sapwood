// instance-lock.ts (#382, F9): single-instance lock on the data dir.
//
// Dogfood 2026-07-24 (F9): two `sapwood run` processes ran concurrently against ONE data dir /
// one board — both ticked, both drove lanes, one carried stale config. Double-drive of a shared
// board risks duplicate dispatch and conflicting merges. The lock makes that operator error a
// clean refusal instead of a silent double-run.
//
// Design: a plain JSON lockfile (`sapwood.lock`, beside `sapwood.sqlite` in the data dir)
// holding `{ pid, token, acquiredAt }`. No flock/OS-specific locking APIs, no new dependencies —
// the same portable file-in-data-dir posture as the KILL_SWITCH/PAUSE sentinels (state.ts
// killSwitchPath), except this file is ENGINE-written, never a human control input.
//
// Protocol (codex PR #467 round 3 — the invariant: NO process ever removes a lock it has not
// just re-verified as stale INSIDE a critical section; a live lock is never displaced):
//  * CREATE is `write temp file (unique name) -> linkSync(temp, lockPath)` — the lock NAME
//    appears atomically WITH its complete content (a bare `wx` create is atomic on the name
//    only, so a peer could observe an empty/partial lock and misclassify it as corrupt), and
//    linkSync can never clobber an existing lock. Mutex-free: an ordinary start (no lock on
//    disk, or a live holder to refuse to) never touches the takeover mutex at all.
//  * TAKEOVER of a stale lock is serialized by a mkdir mutex (`<lockPath>.takeover`): mkdir(2)
//    is atomic on darwin/linux — exactly one caller succeeds, losers get EEXIST (the classic
//    lock-directory primitive; never `recursive: true`, which swallows EEXIST). INSIDE the
//    mutex the lock is RE-read and staleness RE-judged with a fresh liveness probe before any
//    unlink — the delayed-judgment hazard (round 2's confirm-round P1: acting on a pre-mutex
//    read after a peer's takeover replaced the lock) is gone, because judgment and mutation now
//    sit in one serialized section. Then unlink + temp/link create, rmdir the mutex last. A
//    create-EEXIST inside the mutex means a mutex-free fresh starter linked into the brief
//    absent window: rmdir, loop, and refuse to that live holder.
//  * Soundness: the lock path is mutated only by (a) mutex holders — serialized, acting on a
//    freshly-validated in-section read — or (b) creators via linkSync, which cannot clobber and
//    only succeeds on an ABSENT path; and the only absent-path window the protocol produces
//    follows a mutex holder's removal of a verified-DEAD lock. So a live lock is never
//    displaced by anyone, and at most one process ever holds an acquired lock.
//
// Liveness: a lock whose recorded pid is dead (`process.kill(pid, 0)` throws ESRCH) is STALE and
// is taken over — so crash + restart (the supported recovery drill, and the #431 supervisor
// fast-restart regime) proceeds without any manual step. EPERM means the process EXISTS (it just
// belongs to another user), so it counts as ALIVE — see pidIsAlive.
//
// Residuals (honest, accepted):
//  * PID reuse (same direction heartbeat.ts already documents for its own kill(pid,0) probe): if
//    the previous holder died WITHOUT releasing and the OS has since recycled that exact pid onto
//    an unrelated live process, the liveness check reads ALIVE and this engine REFUSES to start.
//    The safe failure direction — a false refusal (fixed by deleting the lockfile, see
//    docs/troubleshooting.md), never a false takeover / double-drive. Closing it would need the
//    holder's process START TIME, which has no portable Node API (per-OS `ps` output parsing) —
//    rejected as machinery the residual doesn't justify.
//  * A crash INSIDE the sub-second takeover critical section leaves the mutex directory behind;
//    every later start that needs a takeover then refuses FAIL-CLOSED with a distinct message
//    naming the directory, until an operator removes it (docs/troubleshooting.md). This is the
//    deliberate round-3 conversion of round 2's unbounded silent double-drive hazard into a
//    bounded, visible refusal — and there is NO recursive stale-mutex takeover machinery on top,
//    which would recreate the original problem one level down (marginal-complexity principle).
//    Fresh creates never consult the mutex, so the one crash position that leaves the path
//    absent (after the in-mutex unlink, before the link — the lock removed there was freshly
//    verified dead) still restarts cleanly.
//  * Operator tampering: release()'s token guard reads-then-unlinks; under the invariant above
//    no peer can legitimately own the path while this process is alive (removal requires a
//    fresh in-mutex liveness probe to read DEAD, which an honest probe of a live pid cannot
//    return), so the remaining read/unlink TOCTOU requires an operator manually replacing the
//    lockfile between those two calls.
//  * A crash can leave a stray `sapwood.lock.tmp-*` file behind; its name embeds a per-start
//    random token and is never re-matched by any later acquire — harmless, safe to delete.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";

/** `process.kill(pid, 0)` semantics, exported for direct testing with an injected `kill`:
 *  no throw -> the process exists; EPERM -> the process ALSO exists (we merely may not signal
 *  it — treating EPERM as "dead" would let a second engine run whenever the holder belongs to
 *  another user, the exact double-drive this lock exists to prevent); ESRCH (or anything
 *  else) -> no such process. */
export function pidIsAlive(pid: number, kill: (pid: number, signal: number) => unknown = process.kill.bind(process)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What the lockfile records about its holder — `pid`/`acquiredAt` are null when the file was
 *  unreadable/corrupt (reported honestly, never fabricated). */
export interface LockHolder {
  pid: number | null;
  acquiredAt: string | null;
}

export type InstanceLockResult =
  | {
      acquired: true;
      lockPath: string | null;
      /** Set when acquisition went through a stale-lock takeover — the dead holder's record. */
      tookOver: LockHolder | null;
      /** Best-effort release for the normal shutdown path: unlinks the lockfile ONLY when it
       *  still carries this acquisition's own token (never a peer's newer lock), and never
       *  throws — shutdown must not gain a new failure mode from cleanup. */
      release: () => void;
    }
  | { acquired: false; lockPath: string; holder: LockHolder; message: string };

/** Filesystem seam (tmp-dir real fs in most tests; scripted fakes for the race interleaves and
 *  crash aftermaths that cannot be reproduced deterministically with a real fs). Same
 *  inject-the-collaborator convention as cli.ts's WebAccessDenialCheckDeps.readFile. */
export interface LockFsOps {
  /** `readFileSync(path, "utf8")` contract — throws on missing/unreadable. */
  readFile: (path: string) => string;
  /** `writeFileSync(path, data, { flag: "wx" })` contract — throws EEXIST when the file exists. */
  writeFileExclusive: (path: string, data: string) => void;
  /** `unlinkSync(path)` contract — throws on missing. */
  unlink: (path: string) => void;
  /** `linkSync(existingPath, newPath)` contract — atomic creation of `newPath` for content that
   *  already fully exists at `existingPath`; throws EEXIST when `newPath` exists (never
   *  clobbers), ENOENT when `existingPath` is gone. */
  link: (existingPath: string, newPath: string) => void;
  /** `mkdirSync(path)` contract — NON-recursive (atomic: exactly one racing caller succeeds);
   *  throws EEXIST when the directory exists. */
  mkdir: (path: string) => void;
  /** `rmdirSync(path)` contract — throws on missing. */
  rmdir: (path: string) => void;
}

export interface InstanceLockDeps {
  /** REQUIRED, never defaulted (#403/F25): the one wall-clock read here (the lockfile's
   *  informational `acquiredAt`) must be traceable to the caller's clock, same as every module. */
  now: () => Date;
  pid?: number;
  /** Liveness probe seam — production default is the real pidIsAlive above. */
  isPidAlive?: (pid: number) => boolean;
  token?: () => string;
  fs?: LockFsOps;
}

const realFs: LockFsOps = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFileExclusive: (path, data) => writeFileSync(path, data, { flag: "wx" }),
  unlink: (path) => unlinkSync(path),
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
  mkdir: (path) => mkdirSync(path),
  rmdir: (path) => rmdirSync(path),
};

/** Bounded acquire attempts: each pass is create-or-inspect; >1 pass only ever happens when
 *  the file vanished between our failed create and our read (a holder released — retry), the
 *  takeover mutex was busy, or an in-mutex step found the world changed (lock vanished / a
 *  fresh starter claimed the absent window). 3 passes is enough for every legitimate sequence;
 *  exhausting them means pathological churn or a wedged mutex, reported as a refusal (fail
 *  closed — with a distinct message for the wedged-mutex case). */
const MAX_ACQUIRE_ATTEMPTS = 3;

/** Node errno accessor — undefined for non-errno errors, which every `code !== "X"` guard below
 *  then treats as unexpected (propagated). */
function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** Cleanup on an already-failing path: swallow everything so the ORIGINAL error stays the one
 *  reported. Never used for a load-bearing removal. */
function bestEffortUnlink(fs: LockFsOps, path: string): void {
  try {
    fs.unlink(path);
  } catch {
    /* the original error is the story */
  }
}

/** Mutex flavor of bestEffortUnlink — an fs error must not additionally leave the takeover
 *  mutex behind when removing it is still possible, but the ORIGINAL error stays the story. */
function bestEffortRmdir(fs: LockFsOps, path: string): void {
  try {
    fs.rmdir(path);
  } catch {
    /* the original error is the story */
  }
}

function parseHolder(raw: string): { pid: number; token?: string; acquiredAt?: string } | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown; acquiredAt?: unknown } | null;
    if (parsed === null || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: parsed.pid,
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      ...(typeof parsed.acquiredAt === "string" ? { acquiredAt: parsed.acquiredAt } : {}),
    };
  } catch {
    return null;
  }
}

/** The atomic-create primitive (round 2, codex-confirmed): full payload to the uniquely-named
 *  temp file, then link into place — the lock name can never be observed empty/partial, and
 *  link cannot clobber. Returns false on EEXIST (someone holds the path); every other error
 *  propagates, with the temp file cleaned up and — if the link had already succeeded — our own
 *  fresh lock removed first (an error must never strand it). */
function createViaTempLink(fs: LockFsOps, tempPath: string, lockPath: string, payload: string): boolean {
  fs.writeFileExclusive(tempPath, payload);
  let created = false;
  try {
    fs.link(tempPath, lockPath);
    created = true;
  } catch (e) {
    if (errnoCode(e) !== "EEXIST") {
      bestEffortUnlink(fs, tempPath);
      throw e;
    }
  }
  try {
    // The temp name is now a duplicate hard link (created) or a losing attempt's leftover
    // (not) — discard it either way.
    fs.unlink(tempPath);
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") {
      if (created) bestEffortUnlink(fs, lockPath);
      throw e;
    }
  }
  return created;
}

/** Acquire the single-instance lock at `lockPath`, or report the live holder.
 *
 *  `lockPath: null` (in-memory State — tests) is a no-op acquire, same convention as
 *  state.ts's killSwitchPath/pausePath ("null dir -> never active"): there is no shared data
 *  dir, so there is nothing to double-drive.
 *
 *  A lockfile that exists but cannot be parsed (manual tampering — never a crashed writer,
 *  since the temp+link create makes partial content unobservable) is treated as STALE — a
 *  corrupt lock must never permanently brick startup — and taken over through the same
 *  serialized in-mutex re-validation as a dead-pid lock (the in-mutex re-read simply parses
 *  null again; no liveness probe is possible or needed for it).
 *
 *  Unexpected fs errors (EACCES/EIO on any create/read/link/unlink/mkdir step) propagate —
 *  fail closed at startup with the REAL error, never misreported as lock churn; only ENOENT
 *  where it means "the lock changed hands, re-inspect" is handled. A propagated error never
 *  strands this process's own fresh lock, and never leaves the takeover mutex behind when
 *  removing it is still possible. */
export function acquireInstanceLock(lockPath: string | null, deps: InstanceLockDeps): InstanceLockResult {
  if (lockPath === null) {
    return { acquired: true, lockPath: null, tookOver: null, release: () => {} };
  }
  const fs = deps.fs ?? realFs;
  const isPidAlive = deps.isPidAlive ?? pidIsAlive;
  const pid = deps.pid ?? process.pid;
  const token = (deps.token ?? (() => randomBytes(16).toString("hex")))();
  const payload = JSON.stringify({ pid, token, acquiredAt: deps.now().toISOString() }) + "\n";
  // The temp name embeds the per-acquire random token: unique per contender, contention-free by
  // construction (and a crashed process's leftover is never re-matched).
  const tempPath = `${lockPath}.tmp-${token}`;
  // The takeover mutex is a FIXED name on purpose — it is the serialization point every
  // takeover must agree on, unlike the per-contender temp file.
  const mutexPath = `${lockPath}.takeover`;
  let tookOver: LockHolder | null = null;
  let mutexBlocked = false;

  const acquiredResult = (): InstanceLockResult => ({
    acquired: true,
    lockPath,
    tookOver,
    release: () => {
      // Token-guarded: only ever unlinks THIS acquisition's own lock. Under the module
      // invariant no peer can legitimately own the path while we are alive (removal requires
      // an in-mutex liveness probe to read DEAD), so the read-then-unlink TOCTOU that remains
      // requires operator tampering (module doc).
      try {
        if (parseHolder(fs.readFile(lockPath))?.token === token) fs.unlink(lockPath);
      } catch {
        /* best-effort: already gone or unreadable — nothing of ours to release */
      }
    },
  });
  const refuseLiveHolder = (holder: { pid: number; acquiredAt?: string }): InstanceLockResult => {
    const acquiredAt = holder.acquiredAt ?? null;
    return {
      acquired: false,
      lockPath,
      holder: { pid: holder.pid, acquiredAt },
      message:
        `another sapwood engine (pid ${holder.pid}${acquiredAt ? `, lock acquired ${acquiredAt}` : ""}) already holds ` +
        `the data-dir lock at ${lockPath} — refusing to start (one engine per data dir/board, #382). ` +
        `If that pid is NOT a sapwood engine (a recycled pid after a crash), delete the lock file and retry.`,
    };
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    // ── Mutex-free fast path: atomic create. An ordinary start (no lock on disk) begins and
    // ends here, never touching the takeover mutex.
    if (createViaTempLink(fs, tempPath, lockPath, payload)) {
      return acquiredResult();
    }

    // ── EEXIST: inspect the current holder (still mutex-free — refusing to a live holder
    // must not churn the mutex either).
    let raw: string;
    try {
      raw = fs.readFile(lockPath);
    } catch (e) {
      if (errnoCode(e) === "ENOENT") continue; // changed hands between link and read — re-inspect
      throw e;
    }
    const preHolder = parseHolder(raw);
    if (preHolder !== null && isPidAlive(preHolder.pid)) {
      return refuseLiveHolder(preHolder);
    }

    // ── Pre-judged stale (dead pid) or corrupt: enter the serialized takeover critical
    // section. EEXIST = another takeover is in flight, or a crashed one left the mutex behind
    // — bounded retries (this loop), then a fail-closed refusal with a distinct message.
    try {
      fs.mkdir(mutexPath);
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") throw e;
      mutexBlocked = true;
      continue;
    }

    // ── Inside the mutex: RE-read and RE-judge with a fresh liveness probe. The pre-mutex
    // read above was only a hint; every mutation below acts exclusively on this fresh,
    // serialized judgment (round 3's invariant — no delayed-decision mutation can exist).
    let raw2: string;
    try {
      raw2 = fs.readFile(lockPath);
    } catch (e) {
      bestEffortRmdir(fs, mutexPath);
      if (errnoCode(e) === "ENOENT") continue; // the holder released while we took the mutex
      throw e;
    }
    const holder = parseHolder(raw2);
    if (holder !== null && isPidAlive(holder.pid)) {
      // A LIVE lock — a peer's completed takeover replaced the stale one while our judgment
      // was pending (round 2's delayed-decision interleave). It is never displaced: exit the
      // critical section and refuse to it.
      fs.rmdir(mutexPath);
      return refuseLiveHolder(holder);
    }
    // Freshly re-verified DEAD (or unparseable) INSIDE the critical section — removal is safe.
    try {
      fs.unlink(lockPath);
    } catch (e) {
      bestEffortRmdir(fs, mutexPath);
      if (errnoCode(e) === "ENOENT") continue; // tampering-grade anomaly — re-inspect, don't die
      throw e;
    }
    let claimed: boolean;
    try {
      claimed = createViaTempLink(fs, tempPath, lockPath, payload);
    } catch (e) {
      bestEffortRmdir(fs, mutexPath);
      throw e;
    }
    if (!claimed) {
      // A mutex-free fresh starter linked into the brief absent window (legitimate by the
      // soundness argument: the path was absent because a verified-dead lock was removed).
      // That starter is the live holder now — exit the mutex, loop, read it, refuse to it.
      fs.rmdir(mutexPath);
      continue;
    }
    tookOver = holder !== null ? { pid: holder.pid, acquiredAt: holder.acquiredAt ?? null } : { pid: null, acquiredAt: null };
    try {
      fs.rmdir(mutexPath);
    } catch (e) {
      // The takeover succeeded but the mutex cannot be released — fail closed with the real
      // error, never stranding our own fresh lock behind it.
      bestEffortUnlink(fs, lockPath);
      throw e;
    }
    return acquiredResult();
  }

  if (mutexBlocked) {
    return {
      acquired: false,
      lockPath,
      holder: { pid: null, acquiredAt: null },
      message:
        `a takeover-mutex directory exists at ${mutexPath} (another engine's stale-lock takeover is in flight, ` +
        `or a previous engine crashed mid-takeover and left it behind) — refusing to start ` +
        `(one engine per data dir/board, #382). If no sapwood engine is running against this data dir, ` +
        `remove that directory and retry.`,
    };
  }
  return {
    acquired: false,
    lockPath,
    holder: { pid: null, acquiredAt: null },
    message:
      `could not acquire the data-dir lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts ` +
      `(the lock kept changing hands) — refusing to start (one engine per data dir/board, #382).`,
  };
}
