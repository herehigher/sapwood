// deploy-key-startup-check.test.ts (#671): pins each of the four detection arms the issue names
// (unset / file missing / preflight fail / OK), that the two degrade arms reuse init.ts's EXACT
// guidance wording (no third variant), that exactly one durable event fires per run with the
// right tier+arm payload, and that the shared preflight is consumed at most once (the "missing"
// arm must never even touch it — there is nothing to probe).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LlmPingResult } from "../roles/worker.js";
import { detectDeployKeyStartupTier } from "./deploy-key-startup-check.js";
import { DEPLOY_KEY_TITLE, deployKeyPreflightFailedAction, deployKeyProvisioningFailedAction } from "./init.js";

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

test("arm 1: worker.deployKeyPath unset -> L0/unset, one INFO log pointing at sapwood init, no probe consumed", async () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const supervisor = fakeSupervisor({ ok: true });
  const result = await detectDeployKeyStartupTier(
    supervisor,
    { worker: { deployKeyPath: undefined }, board: { owner: "o", repo: "r" } },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.deepEqual(result, { tier: "L0", arm: "unset" });
  assert.equal(supervisor.calls, 0, "unset arm must never touch the shared preflight");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /L0/);
  assert.match(logs[0]!, /sapwood init/);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L0", arm: "unset" }]);
});

test("arm 2: path set but key file missing -> L0/missing, WARN reuses deployKeyProvisioningFailedAction's exact wording, no probe consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "does-not-exist");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    const result = await detectDeployKeyStartupTier(
      supervisor,
      { worker: { deployKeyPath: keyPath }, board: { owner: "o", repo: "r" } },
      { appendEvent: (kind, payload) => events.push([kind, payload]) },
      (line) => logs.push(line),
    );
    assert.deepEqual(result, { tier: "L0", arm: "missing" });
    assert.equal(supervisor.calls, 0, "missing-file arm must never touch the shared preflight — nothing to probe");
    assert.equal(logs.length, 1);
    // The exact guidance string init.ts's own provisioning-failed helper produces — same wording
    // `sapwood init` itself would emit for the same failure shape, not a third variant. The
    // errno detail in parens differs machine to machine, so compare everything up to it.
    const expectedGuidance = deployKeyProvisioningFailedAction("o/r", keyPath, DEPLOY_KEY_TITLE, new Error("ENOENT"));
    assert.equal(logs[0]!.split("(")[0], `[sapwood:startup] ${expectedGuidance.split("(")[0]}`);
    assert.match(logs[0]!, /could not provision a write deploy key/);
    assert.match(logs[0]!, /ssh-keygen -t ed25519/);
    assert.match(logs[0]!, /sapwood init/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L0", arm: "missing", keyPath }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 3: path set, file present, SSH preflight fails -> L0/preflight-failed, WARN reuses deployKeyPreflightFailedAction's exact wording", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: false, detail: "Permission denied (publickey)." });
    const result = await detectDeployKeyStartupTier(
      supervisor,
      { worker: { deployKeyPath: keyPath }, board: { owner: "o", repo: "r" } },
      { appendEvent: (kind, payload) => events.push([kind, payload]) },
      (line) => logs.push(line),
    );
    assert.deepEqual(result, { tier: "L0", arm: "preflight-failed" });
    assert.equal(supervisor.calls, 1, "preflight-failed arm must consume exactly one shared probe");
    assert.equal(logs.length, 1);
    const expectedGuidance = deployKeyPreflightFailedAction(keyPath, "Permission denied (publickey).");
    assert.equal(logs[0]!, `[sapwood:startup] ${expectedGuidance}`);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L0", arm: "preflight-failed", keyPath }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arm 4: path set, file present, preflight OK -> L1/active, one positive log line, no guidance WARN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "not-a-real-key");
    const logs: string[] = [];
    const events: Array<[string, unknown]> = [];
    const supervisor = fakeSupervisor({ ok: true });
    const result = await detectDeployKeyStartupTier(
      supervisor,
      { worker: { deployKeyPath: keyPath }, board: { owner: "o", repo: "r" } },
      { appendEvent: (kind, payload) => events.push([kind, payload]) },
      (line) => logs.push(line),
    );
    assert.deepEqual(result, { tier: "L1", arm: "active" });
    assert.equal(supervisor.calls, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /L1 active/);
    assert.doesNotMatch(logs[0]!, /WARN/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ["deploy-key-tier-detected", { tier: "L1", arm: "active", keyPath }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverse test: every arm resolves without throwing and never blocks — the check is visibility, not a gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploy-key-startup-"));
  const noop = { appendEvent: () => {} };
  const silent = () => {};
  try {
    const keyPath = join(dir, "worker-deploy-key");
    writeFileSync(keyPath, "k");
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: true }),
        { worker: { deployKeyPath: undefined }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
      ),
    );
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: true }),
        { worker: { deployKeyPath: join(dir, "missing") }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
      ),
    );
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: false, detail: "x" }),
        { worker: { deployKeyPath: keyPath }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
      ),
    );
    await assert.doesNotReject(() =>
      detectDeployKeyStartupTier(
        fakeSupervisor({ ok: true }),
        { worker: { deployKeyPath: keyPath }, board: { owner: "o", repo: "r" } },
        noop,
        silent,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
