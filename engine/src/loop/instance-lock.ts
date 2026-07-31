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
// Protocol (codex PR #467 round 2, findings 1+2 — two atomic primitives, no unconditional
// unlink/rename of a live lock anywhere):
//  * CREATE is `write temp file (unique name) -> linkSync(temp, lockPath)` — the lock NAME
//    appears atomically WITH its complete content (round 1's `wx` create was atomic on the name
//    only, so a peer could observe an empty/partial lock and misclassify it as corrupt).
//  * TAKEOVER of a stale lock is `renameSync(lockPath, <aside name only this process uses>)` —
//    exactly one contender's rename succeeds (losers get ENOENT, loop, see the winner's fresh
//    lock, and refuse). The rename claims whatever is AT the path, which in the delayed-decision
//    interleave (finding 1) can already be a peer's FRESH lock: the aside file is exclusively
//    ours after the rename, so it is inspected race-free — only byte-identical to the content we
//    judged stale is it discarded; anything else is a live peer's lock, restored atomically via
//    linkSync (which cannot clobber) and then refused to.
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
//  * THREE-OR-MORE simultaneous starts over one stale lock: while a delayed contender's wrongly-
//    renamed-aside fresh lock is being restored, the path is briefly absent and a third contender
//    can create there (the restoring linkSync then fails EEXIST and the aside file is left on
//    disk as evidence). Two-contender arbitration — the sanctioned regime, since a supervisor
//    (#431) restarts ONE process at a time — is fully closed; perfect n-way arbitration needs an
//    atomic compare-and-swap no portable fs API offers.
//  * Operator tampering: release()'s token guard reads-then-unlinks; with the protocol above no
//    peer ever legitimately owns the path while this process is alive, so the residual TOCTOU
//    (finding 2) requires an operator manually replacing the lockfile between those two calls.
//  * A crash can leave a stray `sapwood.lock.tmp-*`/`sapwood.lock.aside-*` file behind; the
//    unique names mean it is never re-matched by any later acquire — harmless, safe to delete.
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

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

/** Filesystem seam (tmp-dir real fs in most tests; scripted fakes for the race interleaves that
 *  cannot be reproduced deterministically with a real fs). Same inject-the-collaborator
 *  convention as cli.ts's WebAccessDenialCheckDeps.readFile. */
export interface LockFsOps {
  /** `readFileSync(path, "utf8")` contract — throws on missing/unreadable. */
  readFile: (path: string) => string;
  /** `writeFileSync(path, data, { flag: "wx" })` contract — throws EEXIST when the file exists. */
  writeFileExclusive: (path: string, data: string) => void;
  /** `unlinkSync(path)` contract — throws on missing. */
  unlink: (path: string) => void;
  /** `renameSync(oldPath, newPath)` contract — atomic move; throws ENOENT when oldPath is gone. */
  rename: (oldPath: string, newPath: string) => void;
  /** `linkSync(existingPath, newPath)` contract — atomic creation of `newPath` for content that
   *  already fully exists at `existingPath`; throws EEXIST when `newPath` exists (never
   *  clobbers), ENOENT when `existingPath` is gone. */
  link: (existingPath: string, newPath: string) => void;
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
  rename: (oldPath, newPath) => renameSync(oldPath, newPath),
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
};

/** Bounded acquire attempts: each pass is create-or-inspect; >1 pass only ever happens when a
 *  stale lock was just claimed aside (retry the create) or the file vanished between our failed
 *  create and our read (a holder released, or a peer's claim is in flight — retry). 3 passes is
 *  enough for every legitimate sequence; exhausting them means pathological churn, reported as a
 *  refusal (fail closed). */
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

/** Acquire the single-instance lock at `lockPath`, or report the live holder.
 *
 *  `lockPath: null` (in-memory State — tests) is a no-op acquire, same convention as
 *  state.ts's killSwitchPath/pausePath ("null dir -> never active"): there is no shared data
 *  dir, so there is nothing to double-drive.
 *
 *  A lockfile that exists but cannot be parsed (manual tampering — never a crashed writer,
 *  since the temp+link create makes partial content unobservable) is treated as STALE — a
 *  corrupt lock must never permanently brick startup — and taken over through the same
 *  rename-aside claim as a dead-pid lock.
 *
 *  Unexpected fs errors (EACCES/EIO on any create/read/rename/link/unlink step) propagate —
 *  fail closed at startup with the REAL error, never misreported as lock churn (codex PR #467
 *  finding 5); only ENOENT where it means "the lock changed hands, re-inspect" is handled. A
 *  propagated error never strands this process's own fresh lock (it is removed first). */
export function acquireInstanceLock(lockPath: string | null, deps: InstanceLockDeps): InstanceLockResult {
  if (lockPath === null) {
    return { acquired: true, lockPath: null, tookOver: null, release: () => {} };
  }
  const fs = deps.fs ?? realFs;
  const isPidAlive = deps.isPidAlive ?? pidIsAlive;
  const pid = deps.pid ?? process.pid;
  const token = (deps.token ?? (() => randomBytes(16).toString("hex")))();
  const payload = JSON.stringify({ pid, token, acquiredAt: deps.now().toISOString() }) + "\n";
  // Both sidecar names embed the per-acquire random token: unique per contender, so they are
  // contention-free by construction (and a crashed process's leftovers are never re-matched).
  const tempPath = `${lockPath}.tmp-${token}`;
  const asidePath = `${lockPath}.aside-${token}`;
  let tookOver: LockHolder | null = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    // ── Atomic create WITH complete content: full payload to a uniquely-named temp file,
    // then link into place — the lock name can never be observed empty/partial.
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
      // (not) — discard it either way. A real failure here propagates, but never with our own
      // fresh lock stranded behind it.
      fs.unlink(tempPath);
    } catch (e) {
      if (errnoCode(e) !== "ENOENT") {
        if (created) bestEffortUnlink(fs, lockPath);
        throw e;
      }
    }
    if (created) {
      return {
        acquired: true,
        lockPath,
        tookOver,
        release: () => {
          // Token-guarded: only ever unlinks THIS acquisition's own lock. With the claim
          // protocol above no peer legitimately owns the path while we are alive, so the
          // read-then-unlink TOCTOU that remains requires operator tampering (module doc).
          try {
            if (parseHolder(fs.readFile(lockPath))?.token === token) fs.unlink(lockPath);
          } catch {
            /* best-effort: already gone or unreadable — nothing of ours to release */
          }
        },
      };
    }

    // ── EEXIST: inspect the current holder.
    let raw: string;
    try {
      raw = fs.readFile(lockPath);
    } catch (e) {
      if (errnoCode(e) === "ENOENT") continue; // changed hands between link and read — re-inspect
      throw e;
    }
    const holder = parseHolder(raw);
    if (holder !== null && isPidAlive(holder.pid)) {
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
    }

    // ── Stale (dead pid) or corrupt: claim it atomically by renaming it to a name only this
    // process uses. Exactly one contender's rename succeeds; losers get ENOENT, loop, see the
    // winner's fresh lock, and refuse.
    try {
      fs.rename(lockPath, asidePath);
    } catch (e) {
      if (errnoCode(e) === "ENOENT") continue; // lost the claim race — re-inspect
      throw e;
    }
    // The aside file is exclusively ours — inspect it race-free. The rename claimed whatever
    // was AT the path, which in the delayed-decision interleave (codex PR #467 finding 1) can
    // already be a peer's FRESH lock rather than the stale content we judged.
    let asideRaw: string;
    try {
      asideRaw = fs.readFile(asidePath);
    } catch (e) {
      // Our own exclusively-named file is unreadable — a real fs problem. Restore whatever we
      // claimed (best-effort: the path may have been re-claimed meanwhile, in which case the
      // aside file stays on disk as evidence) and fail closed with the real error.
      try {
        fs.link(asidePath, lockPath);
        bestEffortUnlink(fs, asidePath);
      } catch {
        /* the original read error is the story */
      }
      throw e;
    }
    if (asideRaw === raw) {
      // Byte-identical to the content we judged stale — the claim is confirmed. Discard it and
      // loop back to the atomic-create path. A failure here propagates (nothing stranded: the
      // lock path is free and the aside name is uniquely ours).
      fs.unlink(asidePath);
      tookOver = holder !== null ? { pid: holder.pid, acquiredAt: holder.acquiredAt ?? null } : { pid: null, acquiredAt: null };
      continue;
    }
    // Delayed-decision interleave: we renamed away a peer's FRESH lock. Restore it atomically
    // (link cannot clobber) and fall through to the next pass, where the live holder refuses us.
    try {
      fs.link(asidePath, lockPath);
      fs.unlink(asidePath); // the content is back at lockPath — this only drops the extra name
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") throw e;
      // A third contender created at the path during our rename window (n>=3 simultaneous
      // starts over one stale lock — module-doc residual). The aside file stays as evidence.
    }
    // Fall through to the next pass, where the restored/new live holder refuses us.
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
