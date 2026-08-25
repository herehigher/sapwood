// deploy-key-startup-check.test.ts (#671, #1105): pins each detection arm — L0 (disclosure only,
// never throws), and L1's failure shapes (no anchor / unreadable key / a still-running lane whose
// tier doesn't match / stale-or-read-only remote id / preflight fails), each of which THROWS a
// guidance-carrying message and refuses startup before any dispatch, plus L1 active (no throw).
// Also pins that exactly one durable event fires per run with the right tier+arm payload, and
// that the shared preflight is consumed at most once (the arms that fail before it must never
// even touch it — there is nothing to probe).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LlmPingResult } from "../roles/worker.js";
import { detectDeployKeyStartupTier } from "./deploy-key-startup-check.js";

function fakeSupervisor(
  result: LlmPingResult | undefined,
  runningMarkers: Array<{ name: string; tier: unknown }> = [],
): {
  calls: number;
  checkDeployKeyPreflight: (anchor: { keyPath: string; keyId: number }) => Promise<LlmPingResult | undefined>;
  listRunningCredentialTiers: () => Array<{ name: string; tier: unknown }>;
} {
  const s = {
    calls: 0,
    checkDeployKeyPreflight: async () => {
      s.calls++;
      return result;
    },
    listRunningCredentialTiers: () => runningMarkers,
  };
  return s;
}

/** A fake `gh repo deploy-key list --json id,title,readOnly` — reconciled(keyId) is the shape
 *  every L1-active/preflight-failed test needs so the new remote-authority check (#1105) doesn't
 *  reach the real `gh` binary. */
function fakeRun(entries: Array<{ id: number; readOnly?: boolean }>): (args: string[]) => Promise<string> {
  return async () =>
    JSON.stringify(
      entries.map((e) => ({ id: e.id, title: "sapwood-worker", ...(e.readOnly !== undefined ? { readOnly: e.readOnly } : {}) })),
    );
}

test("arm 1: credentialTier L0 -> L0/l0, one INFO log, no probe consumed, never throws", async () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const supervisor = fakeSupervisor({ ok: true });
  const result = await detectDeployKeyStartupTier(
    supervisor,
    { worker: { credentialTier: "L0" }, board: { owner: "o", repo: "r" } },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.deepEqual(result, { tier: "L0", arm: "l0" });
  assert.equal(supervisor.calls, 0, "L0 must never touch the shared preflight");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /L0/);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L0", arm: "l0" }]);
});

test("arm 1b: credentialTier L0 -> never even ASKS for running-marker tiers (the scan itself is L1-only)", async () => {
  let scanCalls = 0;
  const supervisor = fakeSupervisor({ ok: true });
  const originalList = supervisor.listRunningCredentialTiers;
  supervisor.listRunningCredentialTiers = () => {
    scanCalls++;
    return originalList();
  };
  await detectDeployKeyStartupTier(
    supervisor,
    { worker: { credentialTier: "L0" }, board: { owner: "o", repo: "r" } },
    { appendEvent: () => {} },
    () => {},
  );
  assert.equal(scanCalls, 0, "L0 must never scan running markers at all");
});

test("arm 2: credentialTier L1, no local anchor -> THROWS naming sapwood init, WARN logged first, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => undefined },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 0, "no-anchor arm must never touch the shared preflight — nothing to probe");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /no local deploy-key anchor/);
    assert.match(logs[0]!, /sapwood init/);
    assert.match(logs[0]!, /Refusing to start before any dispatch/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "missing" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 3: credentialTier L1, anchor found but key file unreadable -> THROWS, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "does-not-exist");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }) },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 0, "unreadable-key arm must never touch the shared preflight");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /could not be read/);
    assert.match(logs[0]!, /sapwood init/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "missing" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm running-tier-mismatch: credentialTier L1, a still-running lane's marker does not carry a matching tier -> THROWS naming the lane, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true }, [{ name: "lane-stale-l0", tier: "L0" }]);
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
        ),
      /sapwood estop/,
    );
    assert.equal(supervisor.calls, 0, "a running-tier mismatch must never reach the shared preflight");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /lane-stale-l0/);
    assert.match(logs[0]!, /Refusing to start before any dispatch/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "running-tier-mismatch" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm running-tier-mismatch: a marker with NO credential_tier recorded at all (pre-#1105) counts as a mismatch, never as a silent pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const supervisor = fakeSupervisor({ ok: true }, [{ name: "lane-legacy", tier: undefined }]);
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: () => {} },
          () => {},
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
        ),
      /lane-legacy/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 4a: credentialTier L1, anchor readable but remote id no longer listed -> THROWS stale, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 2 }]) },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 0, "a stale remote id must never reach the shared preflight");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /no longer registered/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "stale" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 4b: credentialTier L1, anchor's remote id is registered read-only -> THROWS stale, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: true }]) },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 0, "a read-only remote key must never reach the shared preflight");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /read-only/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "stale" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 4c: credentialTier L1, anchor's remote entry carries no readOnly field at all (missing/non-boolean) -> THROWS stale, never accepted as confirmed write access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          // #1105: entry present, id matches, but readOnly is OMITTED — the exact shape an
          // older `gh` (or an unexpected response) could produce. Must refuse the same as an
          // explicit readOnly:true, never be silently accepted as write access.
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1 }]) },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 0, "an unconfirmed-write-access remote entry must never reach the shared preflight");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /could not be confirmed/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "stale" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 5: credentialTier L1, anchor found, reconciled remotely, SSH preflight fails -> THROWS naming the detail, exactly one probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: false, detail: "Permission denied (publickey)." });
    await assert.rejects(
      () =>
        detectDeployKeyStartupTier(
          supervisor,
          { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
          { appendEvent: (kind, payload) => events.push([kind, payload]) },
          (line) => logs.push(line),
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
        ),
      /sapwood init/,
    );
    assert.equal(supervisor.calls, 1, "preflight-failed arm must consume exactly one shared probe");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /SSH auth preflight failed/);
    assert.match(logs[0]!, /Permission denied \(publickey\)\./);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "preflight-failed" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 6: credentialTier L1, anchor found, reconciled remotely, preflight OK -> L1/active, one positive log line, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    const result = await detectDeployKeyStartupTier(
      supervisor,
      { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
      { appendEvent: (kind, payload) => events.push([kind, payload]) },
      (line) => logs.push(line),
      { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
    );
    assert.deepEqual(result, { tier: "L1", arm: "active" });
    assert.equal(supervisor.calls, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /L1 active/);
    assert.doesNotMatch(logs[0]!, /Refusing to start/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "active" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 6b: credentialTier L1, every running marker already carries a matching L1 tier -> starts normally, past the mismatch gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const supervisor = fakeSupervisor({ ok: true }, [
      { name: "lane-a", tier: "L1" },
      { name: "lane-b", tier: "L1" },
    ]);
    const result = await detectDeployKeyStartupTier(
      supervisor,
      { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
      { appendEvent: () => {} },
      () => {},
      { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
    );
    assert.deepEqual(result, { tier: "L1", arm: "active" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverse test: L0 never throws regardless of what the filesystem holds; L1 with a genuinely working, remotely-reconciled anchor+preflight also never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  const noop = { appendEvent: () => {} };
  const silent = () => {};
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "k");
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: false, detail: "irrelevant at L0" }),
        { worker: { credentialTier: "L0" }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
        { root: dir, findAnchor: () => undefined },
      ),
    );
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: true }, [{ name: "lane-a", tier: "L1" }]),
        { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
        { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }), run: fakeRun([{ id: 1, readOnly: false }]) },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
