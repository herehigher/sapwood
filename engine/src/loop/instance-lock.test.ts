// instance-lock.test.ts (#382): the acquire/refuse/takeover matrix, with injected seams only —
// pid liveness is always a scripted fake (or process.pid, whose liveness is a fact, not a
// timing), the fs is a real tmp dir or a scripted fake for race interleaves. No real timers, no
// subprocess lifetimes, no scheduler dependence anywhere (repo rule).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireInstanceLock, type LockFsOps, pidIsAlive } from "./instance-lock.js";

const NOW = () => new Date("2026-07-31T00:00:00.000Z");

function tmpLockPath(): { dir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-instance-lock-"));
  return { dir, lockPath: join(dir, "sapwood.lock") };
}

// ── pidIsAlive: process.kill(pid, 0) semantics, injected kill ──────────────────────────────

test("pidIsAlive: no throw -> alive", () => {
  assert.equal(
    pidIsAlive(1234, () => undefined),
    true,
  );
});

test("pidIsAlive: EPERM -> the process EXISTS (alive) — never treated as dead", () => {
  const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  assert.equal(
    pidIsAlive(1, () => {
      throw eperm;
    }),
    true,
  );
});

test("pidIsAlive: ESRCH (and any other error) -> dead", () => {
  const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  assert.equal(
    pidIsAlive(999999, () => {
      throw esrch;
    }),
    false,
  );
  const weird = new Error("no code at all");
  assert.equal(
    pidIsAlive(999999, () => {
      throw weird;
    }),
    false,
  );
});

// ── acquire: fresh, refuse, takeover ───────────────────────────────────────────────────────

test("fresh acquire: creates the lockfile with this pid; release removes it", () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    const result = acquireInstanceLock(lockPath, { now: NOW, pid: 4242 });
    assert.equal(result.acquired, true);
    assert.equal(existsSync(lockPath), true);
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string; acquiredAt: string };
    assert.equal(holder.pid, 4242);
    assert.equal(holder.acquiredAt, "2026-07-31T00:00:00.000Z");
    assert.equal(typeof holder.token, "string");
    if (result.acquired) {
      assert.equal(result.tookOver, null);
      result.release();
    }
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second acquire against a LIVE holder: refused, message names pid + lock path, file untouched", () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    const first = acquireInstanceLock(lockPath, { now: NOW, pid: 1111 });
    assert.equal(first.acquired, true);
    const before = readFileSync(lockPath, "utf8");
    const second = acquireInstanceLock(lockPath, { now: NOW, pid: 2222, isPidAlive: () => true });
    assert.equal(second.acquired, false);
    if (!second.acquired) {
      assert.equal(second.holder.pid, 1111);
      assert.match(second.message, /pid 1111/);
      assert.ok(second.message.includes(lockPath));
      assert.match(second.message, /refusing to start/);
    }
    assert.equal(readFileSync(lockPath, "utf8"), before, "a refused acquire must not disturb the live holder's lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refusal with the REAL default liveness probe: process.pid is definitionally alive", () => {
  // No fake seam here on purpose: the holder pid is OUR OWN pid, whose liveness is a fact of
  // this very test process — deterministic, no subprocess, no timing.
  const { dir, lockPath } = tmpLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "t", acquiredAt: "2026-07-30T00:00:00.000Z" }));
    const result = acquireInstanceLock(lockPath, { now: NOW, pid: process.pid + 1 });
    assert.equal(result.acquired, false);
    if (!result.acquired) assert.equal(result.holder.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale takeover: dead recorded pid -> lock is taken over, tookOver names the dead holder", () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "old", acquiredAt: "2026-07-30T00:00:00.000Z" }));
    const result = acquireInstanceLock(lockPath, { now: NOW, pid: 3333, isPidAlive: () => false });
    assert.equal(result.acquired, true);
    if (result.acquired) {
      assert.deepEqual(result.tookOver, { pid: 999999, acquiredAt: "2026-07-30T00:00:00.000Z" });
      const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      assert.equal(holder.pid, 3333, "the lock now records the new holder");
      result.release();
    }
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(`${lockPath}.takeover`), false, "a completed takeover leaves no mutex dir behind (real fs)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt lockfile (unparseable / non-integer pid): treated as stale, taken over — never bricks startup", () => {
  for (const corrupt of ["not json at all", "{}", JSON.stringify({ pid: -1 }), JSON.stringify({ pid: "12" })]) {
    const { dir, lockPath } = tmpLockPath();
    try {
      writeFileSync(lockPath, corrupt);
      const result = acquireInstanceLock(lockPath, {
        now: NOW,
        pid: 4444,
        isPidAlive: () => {
          throw new Error("liveness must never be probed for an unparseable lock");
        },
      });
      assert.equal(result.acquired, true, `corrupt lock ${JSON.stringify(corrupt)} must be taken over`);
      if (result.acquired) assert.deepEqual(result.tookOver, { pid: null, acquiredAt: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("null lockPath (in-memory State): no-op acquire, release is safe to call", () => {
  const result = acquireInstanceLock(null, { now: NOW });
  assert.equal(result.acquired, true);
  if (result.acquired) {
    assert.equal(result.lockPath, null);
    result.release(); // must not throw
  }
});

// ── release safety ─────────────────────────────────────────────────────────────────────────

test("release only removes its OWN lock: a peer's newer lock is left untouched", () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    const result = acquireInstanceLock(lockPath, { now: NOW, pid: 5555 });
    assert.equal(result.acquired, true);
    // Simulate: this holder died-and-was-taken-over from a peer's point of view (or an operator
    // replaced the lock) — release must not unlink the peer's claim.
    writeFileSync(lockPath, JSON.stringify({ pid: 6666, token: "peer-token", acquiredAt: "2026-07-31T01:00:00.000Z" }));
    if (result.acquired) result.release();
    assert.equal(existsSync(lockPath), true);
    assert.equal((JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid, 6666);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release after the lock is already gone: silent no-op", () => {
  const { dir, lockPath } = tmpLockPath();
  try {
    const result = acquireInstanceLock(lockPath, { now: NOW, pid: 7777 });
    assert.equal(result.acquired, true);
    rmSync(lockPath);
    if (result.acquired) result.release(); // must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── scripted-fs interleaves + crash aftermaths (not reproducible deterministically on a real
// fs). Both codex review rounds' probes are re-encoded here against the round-3 mkdir-mutex
// protocol: the round-1 delayed-actor interleave (a live survivor) and the confirm-round P1
// (the delayed actor CRASHES mid-takeover). An in-process scripted "crash" cannot stop a
// function mid-flight, so the crash cases pin the protocol by constructing the exact post-crash
// on-disk states — one per position a takeover can die at — and asserting every later start
// ends in refusal or a sound create, never a second owner.

const FAKE_LOCK = join("fake", "sapwood.lock");
const FAKE_MUTEX = `${FAKE_LOCK}.takeover`;

/** In-memory multi-path LockFsOps with a directory set for the mkdir mutex. Hooks:
 *  `beforeTakeoverMutex` fires ONCE just before the first mkdir of the mutex — the serialization
 *  point where a whole peer takeover can be scripted (codex round-1 delayed-judgment probe);
 *  `afterLockUnlink` fires ONCE right after the lock path is unlinked — the in-mutex absent
 *  window where a mutex-free fresh starter can be scripted. */
function fakeFs(initialLock: string | null = null): LockFsOps & {
  files: Map<string, string>;
  dirs: Set<string>;
  mkdirCalls: number;
  beforeTakeoverMutex: (() => void) | undefined;
  afterLockUnlink: (() => void) | undefined;
} {
  const files = new Map<string, string>();
  if (initialLock !== null) files.set(FAKE_LOCK, initialLock);
  const err = (code: string) => Object.assign(new Error(code), { code });
  const fs = {
    files,
    dirs: new Set<string>(),
    mkdirCalls: 0,
    beforeTakeoverMutex: undefined as (() => void) | undefined,
    afterLockUnlink: undefined as (() => void) | undefined,
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) throw err("ENOENT");
      return content;
    },
    writeFileExclusive(path: string, data: string): void {
      if (files.has(path)) throw err("EEXIST");
      files.set(path, data);
    },
    unlink(path: string): void {
      if (!files.has(path)) throw err("ENOENT");
      files.delete(path);
      if (path === FAKE_LOCK && fs.afterLockUnlink !== undefined) {
        const hook = fs.afterLockUnlink;
        fs.afterLockUnlink = undefined; // once
        hook();
      }
    },
    link(existingPath: string, newPath: string): void {
      const content = files.get(existingPath);
      if (content === undefined) throw err("ENOENT");
      if (files.has(newPath)) throw err("EEXIST"); // link never clobbers — real semantics
      files.set(newPath, content);
    },
    mkdir(path: string): void {
      fs.mkdirCalls++;
      if (path === FAKE_MUTEX && fs.beforeTakeoverMutex !== undefined) {
        const hook = fs.beforeTakeoverMutex;
        fs.beforeTakeoverMutex = undefined; // once — a second firing would recurse forever
        hook();
      }
      if (fs.dirs.has(path)) throw err("EEXIST");
      fs.dirs.add(path);
    },
    rmdir(path: string): void {
      if (!fs.dirs.has(path)) throw err("ENOENT");
      fs.dirs.delete(path);
    },
  };
  return fs;
}

function lockPid(fs: { files: Map<string, string> }): number | null {
  const raw = fs.files.get(FAKE_LOCK);
  return raw === undefined ? null : (JSON.parse(raw) as { pid: number }).pid;
}

const STALE = JSON.stringify({ pid: 999999, token: "stale", acquiredAt: "2026-07-30T00:00:00.000Z" });

test("REGRESSION (codex round 1): two contenders racing the SAME stale lock never BOTH acquire — the delayed contender's in-mutex re-validation sees the winner's fresh lock and refuses", () => {
  const fs = fakeFs(STALE);
  let b: ReturnType<typeof acquireInstanceLock> | null = null;
  // A reads the stale lock and judges it dead; just before A enters the takeover mutex, B's
  // ENTIRE takeover runs to completion (same stale read, mutex, re-validate, unlink, create,
  // rmdir, acquired). A then proceeds on what is now a stale judgment.
  fs.beforeTakeoverMutex = () => {
    b = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 2222, isPidAlive: () => false, fs });
  };
  const a = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1111, isPidAlive: (pid) => pid !== 999999, fs });
  assert.ok(b !== null, "the scripted peer takeover ran");
  const bResult = b as ReturnType<typeof acquireInstanceLock>;
  assert.equal(bResult.acquired, true, "B (whose takeover completed first) holds the lock");
  assert.equal(a.acquired, false, "A's delayed claim must back off, never evict B");
  if (!a.acquired) assert.equal(a.holder.pid, 2222, "A's refusal names the actual live holder");
  assert.equal(lockPid(fs), 2222, "B's fresh lock was never displaced");
  assert.equal(fs.dirs.size, 0, "no mutex dir left behind by either contender");
});

test("REGRESSION (codex confirm round, P1): delayed contender crashes INSIDE the mutex before touching the lock -> live winner's lock intact; a later start refuses to the live winner (never a second owner)", () => {
  // Post-crash state, constructed directly: B (pid 2222, alive) completed a takeover and runs;
  // delayed A crashed right after mkdir — orphan mutex dir, B's lock untouched (under the
  // round-3 protocol A had mutated NOTHING yet: its only pre-crash act was the mkdir).
  const bFresh = JSON.stringify({ pid: 2222, token: "b", acquiredAt: "2026-07-31T00:00:01.000Z" });
  const fs = fakeFs(bFresh);
  fs.dirs.add(FAKE_MUTEX);
  const c = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 3333, isPidAlive: (pid) => pid === 2222, fs });
  assert.equal(c.acquired, false, "C refuses — B still owns the lock");
  if (!c.acquired) assert.equal(c.holder.pid, 2222, "the refusal names the LIVE winner, pre-mutex (no mutex churn)");
  assert.equal(lockPid(fs), 2222, "B's lock is never displaced by the crash aftermath");
  assert.ok(fs.dirs.has(FAKE_MUTEX), "the orphan mutex is left for the operator — never auto-taken-over");
});

test("crash aftermath: orphan mutex + STALE lock -> every later takeover refuses FAIL-CLOSED with the distinct mutex message; the stale lock is untouched", () => {
  const fs = fakeFs(STALE);
  fs.dirs.add(FAKE_MUTEX); // a previous engine died mid-takeover before removing the stale lock
  const c = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 3333, isPidAlive: () => false, fs });
  assert.equal(c.acquired, false);
  if (!c.acquired) {
    assert.ok(c.message.includes(FAKE_MUTEX), "the refusal names the mutex directory");
    assert.match(c.message, /crashed mid-takeover/);
    assert.match(c.message, /remove that directory/);
  }
  assert.equal(lockPid(fs), 999999, "the stale lock is not touched while the mutex is wedged");
});

test("crash aftermath: orphan mutex + ABSENT lock (died between unlink and link) -> a later start creates fresh, mutex-free (the removed lock was freshly verified dead)", () => {
  const fs = fakeFs(null);
  fs.dirs.add(FAKE_MUTEX);
  const c = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 3333, isPidAlive: () => false, fs });
  assert.equal(c.acquired, true, "an orphan mutex never blocks the ordinary create path");
  assert.equal(lockPid(fs), 3333);
  assert.ok(fs.dirs.has(FAKE_MUTEX), "the orphan mutex is untouched — no auto-cleanup machinery");
});

test("crash aftermath: orphan mutex + the crashed taker's own published lock (died after link, before rmdir) -> later starts refuse fail-closed on the mutex, never double-drive", () => {
  const aFresh = JSON.stringify({ pid: 1111, token: "a", acquiredAt: "2026-07-31T00:00:01.000Z" });
  const fs = fakeFs(aFresh);
  fs.dirs.add(FAKE_MUTEX);
  // pid 1111 is the crashed taker: dead. The pre-check judges it stale, but the wedged mutex
  // stops any takeover — bounded retries, then the distinct fail-closed refusal.
  const c = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 3333, isPidAlive: () => false, fs });
  assert.equal(c.acquired, false);
  if (!c.acquired) assert.ok(c.message.includes(FAKE_MUTEX));
  assert.equal(lockPid(fs), 1111, "the dead taker's lock stays for the operator to inspect");
});

test("in-mutex absent window: a mutex-free fresh starter that links first WINS — the takeover backs off and refuses to it", () => {
  const fs = fakeFs(STALE);
  const cFresh = JSON.stringify({ pid: 4444, token: "c", acquiredAt: "2026-07-31T00:00:02.000Z" });
  // The instant A's in-mutex unlink opens the absent window, fresh starter C links its lock in.
  fs.afterLockUnlink = () => {
    fs.files.set(FAKE_LOCK, cFresh);
  };
  const a = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1111, isPidAlive: (pid) => pid === 4444, fs });
  assert.equal(a.acquired, false, "A's takeover create hits EEXIST and backs off");
  if (!a.acquired) assert.equal(a.holder.pid, 4444, "A refuses to the fresh starter");
  assert.equal(lockPid(fs), 4444, "C's lock is never displaced");
  assert.equal(fs.dirs.size, 0, "A exited the mutex cleanly on its way out");
});

test("invariant: ordinary starts never touch the takeover mutex — fresh create and live-holder refusal both make zero mkdir calls", () => {
  const freshFs = fakeFs(null);
  const fresh = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1111, isPidAlive: () => true, fs: freshFs });
  assert.equal(fresh.acquired, true);
  assert.equal(freshFs.mkdirCalls, 0, "fresh create is mutex-free");

  const liveFs = fakeFs(JSON.stringify({ pid: 2222, token: "live", acquiredAt: "2026-07-31T00:00:00.000Z" }));
  const refused = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 3333, isPidAlive: () => true, fs: liveFs });
  assert.equal(refused.acquired, false);
  assert.equal(liveFs.mkdirCalls, 0, "live-holder refusal is mutex-free");
});

test("lock vanishes between failed create and read (holder released): retried, then acquired", () => {
  const fs = fakeFs(JSON.stringify({ pid: 1, token: "leaving", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  const plainRead = fs.readFile.bind(fs);
  let lockReads = 0;
  fs.readFile = (path: string): string => {
    if (path === FAKE_LOCK && ++lockReads === 1) {
      // The holder's release lands between our EEXIST and this read.
      fs.files.delete(FAKE_LOCK);
    }
    return plainRead(path);
  };
  const result = acquireInstanceLock(FAKE_LOCK, {
    now: NOW,
    pid: 1313,
    isPidAlive: () => {
      throw new Error("never probed — the lock was gone before it could be inspected");
    },
    fs,
  });
  assert.equal(result.acquired, true);
  assert.equal(lockPid(fs), 1313);
});

test("acquire attempts are bounded: pathological churn ends in a refusal, not an infinite loop", () => {
  // Script a lock that is ALWAYS present at name-creation time (EEXIST) and ALWAYS gone at
  // read — every pass takes the vanished-between branch, so only the bound can end the loop.
  const fs = fakeFs(null);
  fs.link = (_existingPath: string, newPath: string) => {
    if (newPath === FAKE_LOCK) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    throw new Error("unexpected link target");
  };
  const result = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1414, fs });
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.match(result.message, /after 3 attempts/);
});

test("unexpected fs errors (EACCES) on create propagate — fail closed at startup with the real error", () => {
  const fs = fakeFs(null);
  fs.writeFileExclusive = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  assert.throws(() => acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1515, fs }), /EACCES/);
});

test("a non-ENOENT READ error after EEXIST propagates — never misreported as churn", () => {
  const fs = fakeFs(JSON.stringify({ pid: 1, token: "t", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  fs.readFile = () => {
    throw Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES" });
  };
  assert.throws(() => acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1616, fs }), /EACCES/);
});

test("a non-ENOENT UNLINK error inside the mutex propagates with the real error AND releases the mutex on the way out", () => {
  const fs = fakeFs(STALE);
  const plainUnlink = fs.unlink.bind(fs);
  fs.unlink = (path: string) => {
    if (path === FAKE_LOCK) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
    plainUnlink(path); // temp-file unlinks proceed normally
  };
  assert.throws(() => acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1717, isPidAlive: () => false, fs }), /EACCES/);
  assert.equal(fs.dirs.size, 0, "the fs error does not additionally wedge the takeover mutex");
  assert.equal(lockPid(fs), 999999, "the stale lock is left in place for the next attempt");
});
