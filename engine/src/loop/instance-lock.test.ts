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

/** In-memory LockFsOps with optional hooks to script a peer's interleaved action. */
function fakeFs(initial: string | null = null): LockFsOps & { content: string | null; afterCreate: (() => void) | undefined } {
  const fs = {
    content: initial,
    afterCreate: undefined as (() => void) | undefined,
    readFile(_path: string): string {
      if (fs.content === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return fs.content;
    },
    writeFileExclusive(_path: string, data: string): void {
      if (fs.content !== null) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      fs.content = data;
      fs.afterCreate?.();
    },
    unlink(_path: string): void {
      if (fs.content === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      fs.content = null;
    },
  };
  return fs;
}

test("verify race: a peer replaces our fresh lock between create and verify -> we back off (refuse), never double-drive", () => {
  const fs = fakeFs(JSON.stringify({ pid: 999999, token: "stale", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  fs.afterCreate = () => {
    // The peer (which read the SAME stale lock before our takeover) unlinks our fresh file and
    // installs its own — the exact interleave the module doc's concurrent-takeover residual
    // describes, scripted deterministically here.
    fs.content = JSON.stringify({ pid: 8888, token: "peer", acquiredAt: "2026-07-31T00:00:00.001Z" });
    fs.afterCreate = undefined;
  };
  const result = acquireInstanceLock(join("fake", "sapwood.lock"), { now: NOW, pid: 1212, isPidAlive: () => false, fs });
  assert.equal(result.acquired, false);
  if (!result.acquired) {
    assert.equal(result.holder.pid, 8888);
    assert.match(result.message, /during a concurrent start/);
  }
  assert.equal((JSON.parse(fs.content ?? "") as { pid: number }).pid, 8888, "the peer's lock survives our back-off");
});

test("lock vanishes between failed create and read (holder released): retried, then acquired", () => {
  const fs = fakeFs(JSON.stringify({ pid: 1, token: "leaving", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  const plainRead = fs.readFile.bind(fs);
  let reads = 0;
  fs.readFile = (path: string): string => {
    reads++;
    if (reads === 1) {
      // The holder's release lands between our EEXIST and this read.
      fs.content = null;
    }
    return plainRead(path);
  };
  const result = acquireInstanceLock(join("fake", "sapwood.lock"), {
    now: NOW,
    pid: 1313,
    isPidAlive: () => {
      throw new Error("never probed — the lock was gone before it could be inspected");
    },
    fs,
  });
  assert.equal(result.acquired, true);
  assert.equal((JSON.parse(fs.content ?? "") as { pid: number }).pid, 1313);
});

test("acquire attempts are bounded: pathological churn ends in a refusal, not an infinite loop", () => {
  // Script a lock that is ALWAYS present at create (EEXIST) and ALWAYS gone at read — every
  // pass takes the vanished-between branch, so only the attempt bound can end the loop.
  const fs = fakeFs(null);
  fs.writeFileExclusive = () => {
    throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  };
  const result = acquireInstanceLock(join("fake", "sapwood.lock"), { now: NOW, pid: 1414, fs });
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.match(result.message, /after 3 attempts/);
});

test("unexpected fs errors (EACCES) propagate — fail closed at startup with the real error", () => {
  const fs = fakeFs(null);
  fs.writeFileExclusive = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  assert.throws(() => acquireInstanceLock(join("fake", "sapwood.lock"), { now: NOW, pid: 1515, fs }), /EACCES/);
});
