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

// ── race interleaves (scripted fs — not reproducible deterministically on a real fs) ───────

const FAKE_LOCK = join("fake", "sapwood.lock");

/** In-memory multi-path LockFsOps. `beforeLockPathClaim` fires ONCE, just before the first
 *  operation that removes the lock path's current name (unlink OR rename of the lock path) —
 *  the exact interleave point where a whole peer takeover can be scripted (codex PR #467
 *  finding 1's delayed-actor probe). Hard-link aliasing is modeled as a content copy, which is
 *  observationally equivalent for these string payloads. */
function fakeFs(initialLock: string | null = null): LockFsOps & {
  files: Map<string, string>;
  beforeLockPathClaim: (() => void) | undefined;
} {
  const files = new Map<string, string>();
  if (initialLock !== null) files.set(FAKE_LOCK, initialLock);
  const err = (code: string) => Object.assign(new Error(code), { code });
  const fireClaimHook = (path: string) => {
    if (path === FAKE_LOCK && fs.beforeLockPathClaim !== undefined) {
      const hook = fs.beforeLockPathClaim;
      fs.beforeLockPathClaim = undefined; // once — a second firing would recurse forever
      hook();
    }
  };
  const fs = {
    files,
    beforeLockPathClaim: undefined as (() => void) | undefined,
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
      fireClaimHook(path);
      if (!files.has(path)) throw err("ENOENT");
      files.delete(path);
    },
    rename(oldPath: string, newPath: string): void {
      fireClaimHook(oldPath);
      const content = files.get(oldPath);
      if (content === undefined) throw err("ENOENT");
      files.delete(oldPath);
      files.set(newPath, content); // renameSync clobbers newPath — real semantics
    },
    link(existingPath: string, newPath: string): void {
      const content = files.get(existingPath);
      if (content === undefined) throw err("ENOENT");
      if (files.has(newPath)) throw err("EEXIST"); // link never clobbers — real semantics
      files.set(newPath, content);
    },
  };
  return fs;
}

function lockPid(fs: { files: Map<string, string> }): number | null {
  const raw = fs.files.get(FAKE_LOCK);
  return raw === undefined ? null : (JSON.parse(raw) as { pid: number }).pid;
}

test("REGRESSION (codex PR #467 finding 1): two contenders racing the SAME stale lock never BOTH acquire — a delayed claim must not evict the winner's fresh lock", () => {
  const stale = JSON.stringify({ pid: 999999, token: "stale", acquiredAt: "2026-07-30T00:00:00.000Z" });
  const fs = fakeFs(stale);
  let b: ReturnType<typeof acquireInstanceLock> | null = null;
  // A reads the stale lock and judges it dead; just before A's FIRST claim operation on the
  // lock path, B's ENTIRE takeover runs to completion (reads the same stale lock, claims it,
  // creates its own fresh lock, returns acquired). A then resumes acting on its stale decision.
  fs.beforeLockPathClaim = () => {
    b = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 2222, isPidAlive: () => false, fs });
  };
  const a = acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1111, isPidAlive: (pid) => pid !== 999999, fs });
  assert.ok(b !== null, "the scripted peer takeover ran");
  const bResult = b as ReturnType<typeof acquireInstanceLock>;
  assert.equal(bResult.acquired, true, "B (whose takeover completed first) holds the lock");
  assert.equal(a.acquired, false, "A's delayed claim must back off, never evict B");
  if (!a.acquired) assert.equal(a.holder.pid, 2222, "A's refusal names the actual live holder");
  assert.equal(lockPid(fs), 2222, "B's fresh lock survives A's delayed claim");
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
  fs.writeFileExclusive = (path: string, data: string) => {
    if (path === FAKE_LOCK) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    fs.files.set(path, data); // temp-file writes proceed normally
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

test("P2-5 (codex PR #467 finding 5): a non-ENOENT READ error after EEXIST propagates — never misreported as churn", () => {
  const fs = fakeFs(JSON.stringify({ pid: 1, token: "t", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  fs.readFile = () => {
    throw Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES" });
  };
  assert.throws(() => acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1616, fs }), /EACCES/);
});

test("P2-5: a non-ENOENT RENAME error during takeover propagates", () => {
  const fs = fakeFs(JSON.stringify({ pid: 999999, token: "stale", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  fs.rename = () => {
    throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  };
  assert.throws(() => acquireInstanceLock(FAKE_LOCK, { now: NOW, pid: 1717, isPidAlive: () => false, fs }), /EIO/);
});
