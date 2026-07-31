// instance-lock.ts (#382, F9): single-instance lock on the data dir.
//
// Dogfood 2026-07-24 (F9): two `sapwood run` processes ran concurrently against ONE data dir /
// one board — both ticked, both drove lanes, one carried stale config. Double-drive of a shared
// board risks duplicate dispatch and conflicting merges. The lock makes that operator error a
// clean refusal instead of a silent double-run.
//
// Design: a plain JSON lockfile (`sapwood.lock`, beside `sapwood.sqlite` in the data dir)
// holding `{ pid, token, acquiredAt }`, created with an O_EXCL-style atomic create (`writeFileSync`
// flag "wx"). No flock/OS-specific locking APIs, no new dependencies — the same portable
// file-in-data-dir posture as the KILL_SWITCH/PAUSE sentinels (state.ts killSwitchPath), except
// this file is ENGINE-written, never a human control input.
//
// Liveness: a lock whose recorded pid is dead (`process.kill(pid, 0)` throws ESRCH) is STALE and
// is taken over — so crash + restart (the supported recovery drill, and the #431 supervisor
// fast-restart regime) proceeds without any manual step. EPERM means the process EXISTS (it just
// belongs to another user), so it counts as ALIVE — see pidIsAlive.
//
// PID-reuse residual (honest, accepted — same direction heartbeat.ts already documents for its
// own kill(pid,0) probe): if the previous holder died WITHOUT releasing and the OS has since
// recycled that exact pid onto an unrelated live process, the liveness check reads ALIVE and this
// engine REFUSES to start. That failure direction is the safe one — a false refusal (fixed by
// deleting the lockfile, see docs/troubleshooting.md), never a false takeover / double-drive.
// Closing it would need the holder's process START TIME, which has no portable Node API (parsing
// per-OS `ps` output) — rejected as machinery the residual doesn't justify.
//
// Concurrent-takeover residual (honest, accepted): two processes started in the SAME instant can
// both observe the SAME stale lock, and in a narrow window (one unlinks the stale file after the
// other has already unlinked it and re-created a fresh one) both believe they took over. The
// post-create token verify below shrinks that window to the microseconds between create and
// verify; closing it entirely needs an atomic compare-and-delete no portable fs API offers.
// Strictly better than the status quo (no lock at all), and the sanctioned concurrent regime —
// a supervisor restarting a crashed engine (#431) — starts ONE process at a time by construction.
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

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
};

/** Bounded acquire attempts: each pass is create-or-inspect; >1 pass only ever happens when a
 *  stale lock was just unlinked (retry the create) or the file vanished between our failed
 *  create and our read (a holder released — retry). 3 passes is enough for every legitimate
 *  sequence; exhausting them means pathological churn, reported as a refusal (fail closed). */
const MAX_ACQUIRE_ATTEMPTS = 3;

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
 *  A lockfile that exists but cannot be parsed (crashed writer mid-create, manual tampering)
 *  is treated as STALE — a corrupt lock must never permanently brick startup — and taken over
 *  through the same unlink-and-recreate path as a dead-pid lock.
 *
 *  Unexpected fs errors (EACCES on the data dir, etc.) propagate — fail closed at startup with
 *  the real error, same stance as every other startup fail-fast in cli.ts. */
export function acquireInstanceLock(lockPath: string | null, deps: InstanceLockDeps): InstanceLockResult {
  if (lockPath === null) {
    return { acquired: true, lockPath: null, tookOver: null, release: () => {} };
  }
  const fs = deps.fs ?? realFs;
  const isPidAlive = deps.isPidAlive ?? pidIsAlive;
  const pid = deps.pid ?? process.pid;
  const token = (deps.token ?? (() => randomBytes(16).toString("hex")))();
  const payload = JSON.stringify({ pid, token, acquiredAt: deps.now().toISOString() }) + "\n";
  let tookOver: LockHolder | null = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      fs.writeFileExclusive(lockPath, payload);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // The lock exists — read it to decide live holder vs stale takeover.
      let raw: string;
      try {
        raw = fs.readFile(lockPath);
      } catch {
        continue; // vanished between our failed create and this read (holder released) — retry
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
      // Dead pid or unparseable lock -> stale. Unlink and retry the atomic create. See the
      // module doc's concurrent-takeover residual for the narrow race this leaves open.
      tookOver = holder !== null ? { pid: holder.pid, acquiredAt: holder.acquiredAt ?? null } : { pid: null, acquiredAt: null };
      try {
        fs.unlink(lockPath);
      } catch {
        /* already gone — a peer's takeover beat ours; the next create attempt arbitrates */
      }
      continue;
    }
    // Created. Verify our token survived — a peer racing the SAME stale lock can have unlinked
    // our fresh file in the interleave window; backing off on mismatch (or ENOENT) leaves at
    // most one winner instead of two double-driving engines.
    let verifyRaw: string | null;
    try {
      verifyRaw = fs.readFile(lockPath);
    } catch {
      verifyRaw = null;
    }
    if (verifyRaw !== null && parseHolder(verifyRaw)?.token === token) {
      return {
        acquired: true,
        lockPath,
        tookOver,
        release: () => {
          try {
            if (parseHolder(fs.readFile(lockPath))?.token === token) fs.unlink(lockPath);
          } catch {
            /* best-effort: already gone or unreadable — nothing of ours to release */
          }
        },
      };
    }
    // Lost the verify race — whatever is there now is a peer's live claim.
    const peer = verifyRaw !== null ? parseHolder(verifyRaw) : null;
    return {
      acquired: false,
      lockPath,
      holder: { pid: peer?.pid ?? null, acquiredAt: peer?.acquiredAt ?? null },
      message:
        `another sapwood engine took the data-dir lock at ${lockPath} during a concurrent start — ` +
        `refusing to start (one engine per data dir/board, #382).`,
    };
  }
  return {
    acquired: false,
    lockPath,
    holder: { pid: null, acquiredAt: null },
    message:
      `could not acquire the data-dir lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts ` +
      `(the lock kept churning) — refusing to start (one engine per data dir/board, #382).`,
  };
}
