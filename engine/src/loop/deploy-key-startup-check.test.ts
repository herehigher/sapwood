// deploy-key-startup-check.test.ts (#671, redesigned by #1105): pins each of the four detection
// arms — L0 (disclosure only, never throws), and L1's three shapes (no anchor / unreadable key /
// preflight fails), each of which now THROWS a guidance-carrying message and refuses startup
// before any dispatch, plus L1 active (no throw). Also pins that exactly one durable event fires
// per run with the right tier+arm payload, and that the shared preflight is consumed at most once
// (the "no anchor" and "unreadable key" arms must never even touch it — there is nothing to
// probe).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LlmPingResult } from "../roles/worker.js";
import { detectDeployKeyStartupTier } from "./deploy-key-startup-check.js";

function fakeSupervisor(result: LlmPingResult | undefined): {
  calls: number;
  checkDeployKeyPreflight: () => Promise<LlmPingResult | undefined>;
} {
  const s = {
    calls: 0,
    checkDeployKeyPreflight: async () => {
      s.calls++;
      return result;
    },
  };
  return s;
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

test("arm 4: credentialTier L1, anchor found, SSH preflight fails -> THROWS naming the detail, exactly one probe consumed", async () => {
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
          { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }) },
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

test("arm 5: credentialTier L1, anchor found, preflight OK -> L1/active, one positive log line, no throw", async () => {
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
      { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }) },
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

test("reverse test: L0 never throws regardless of what the filesystem holds; L1 with a genuinely working anchor+preflight also never throws", async () => {
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
        fakeSupervisor({ ok: true }),
        { worker: { credentialTier: "L1" }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
        { root: dir, findAnchor: () => ({ keyPath, keyId: 1 }) },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
