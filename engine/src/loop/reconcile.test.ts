import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { referencedIssue, type StartupReconcileData } from "../forge/forge.js";
import { State, type WorkerRow } from "../state/state.js";
import { diffStartupOrphans, reconcileStartup, sweepStaleRoleSessions } from "./reconcile.js";

function worker(issue: number, state: WorkerRow["state"], pr?: number): WorkerRow {
  return {
    name: `lane-${issue}`,
    issue,
    session_id: `session-${issue}`,
    state,
    started_at: "2026-07-15T00:00:00.000Z",
    ended_at: null,
    ...(pr === undefined ? {} : { pr }),
  };
}

test("referencedIssue accepts a single closing/bare reference and skips ambiguity", () => {
  assert.equal(referencedIssue("Fixes #171"), 171);
  assert.equal(referencedIssue("Implementation for #171"), 171);
  assert.equal(referencedIssue("Fixes #171 and closes #172"), null);
  assert.equal(referencedIssue("Mentions #171 and #172"), null);
  assert.equal(referencedIssue("No issue link"), null);
});

test("diffStartupOrphans reports In-Progress, unplaced, and engine PR orphans", () => {
  const orphans = diffStartupOrphans({
    placements: [
      { number: 10, repo: "acme/sapwood", status: "In Progress" },
      { number: 11, repo: "acme/sapwood", status: null },
      { number: 12, repo: "other/repo", status: "In Progress" },
    ],
    openPrs: [
      { number: 50, body: "Fixes #10" },
      { number: 51, body: "Human change without issue" },
    ],
    workers: [],
    repoFullName: "acme/sapwood",
    inProgressStatus: "In Progress",
  });
  assert.deepEqual(orphans, [
    { kind: "issue", issue: 10, reason: "in-progress" },
    { kind: "issue", issue: 11, reason: "unplaced" },
    { kind: "pr", pr: 50, issue: 10, reason: "open-engine-pr" },
  ]);
});

test("diffStartupOrphans treats running, driving, and handoff rows as owners", () => {
  const placements = [
    { number: 10, repo: "acme/sapwood", status: "In Progress" },
    { number: 11, repo: "acme/sapwood", status: "In Progress" },
    { number: 12, repo: "acme/sapwood", status: null },
  ];
  const openPrs = [
    { number: 50, body: "Fixes #10" },
    { number: 51, body: "Fixes #11" },
    { number: 52, body: "Fixes #12" },
  ];
  assert.deepEqual(
    diffStartupOrphans({
      placements,
      openPrs,
      workers: [worker(10, "running"), worker(11, "driving", 51), worker(12, "handoff")],
      repoFullName: "acme/sapwood",
      inProgressStatus: "In Progress",
    }),
    [],
  );
});

test("reconcileStartup emits orphans then one bounded completion and performs reads only", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  let reads = 0;
  const input: StartupReconcileData = {
    placements: [{ number: 171, repo: "acme/sapwood", status: "In Progress" }],
    openPrs: [{ number: 200, body: "Closes #171" }],
  };
  try {
    const result = await reconcileStartup(
      {
        async readStartupReconcileData() {
          reads++;
          return input;
        },
      },
      state,
      { board: { owner: "acme", repo: "sapwood", status: { inProgress: "In Progress" } } },
    );
    assert.equal(reads, 1);
    assert.equal(result.length, 2);
    assert.deepEqual(
      state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected", "reconcile-completed"]).map((event) => event.kind),
      ["orphan-detected", "orphan-detected", "reconcile-completed"],
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileStartup is quiet when healthy and forge failure is non-fatal", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  state.upsertWorker(worker(171, "handoff"));
  const logs: string[] = [];
  try {
    const healthy = await reconcileStartup(
      {
        async readStartupReconcileData() {
          return { placements: [{ number: 171, repo: "acme/sapwood", status: "In Progress" }], openPrs: [] };
        },
      },
      state,
      { board: { owner: "acme", repo: "sapwood", status: { inProgress: "In Progress" } } },
    );
    assert.deepEqual(healthy, []);
    assert.equal(state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected"]).length, 0);
    await assert.doesNotReject(() =>
      reconcileStartup(
        {
          async readStartupReconcileData() {
            throw new Error("forge down");
          },
        },
        state,
        { board: { owner: "acme", repo: "sapwood", status: { inProgress: "In Progress" } } },
        (message) => logs.push(message),
      ),
    );
    assert.match(logs[0] ?? "", /forge down/);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("role debris sweep removes confirmed-dead role debris only", () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-role-sweep-"));
  const roles = join(root, "data", "sessions", "roles");
  const workerState = join(root, "data", "sessions", "state");
  const worktrees = join(root, ".claude", "worktrees");
  mkdirSync(roles, { recursive: true });
  mkdirSync(workerState, { recursive: true });
  for (const name of ["role-dead-aaaa", "role-alive-bbbb", "role-unreadable-cccc", "role-bad-dddd"]) {
    mkdirSync(join(worktrees, name), { recursive: true });
  }
  mkdirSync(join(worktrees, "lane-171"), { recursive: true });
  writeFileSync(join(roles, "role-dead-aaaa.running.json"), JSON.stringify({ wrapper_pid: 101 }));
  writeFileSync(join(roles, "role-alive-bbbb.running.json"), JSON.stringify({ wrapper_pid: 102 }));
  writeFileSync(join(roles, "role-unreadable-cccc.running.json"), JSON.stringify({ wrapper_pid: 103 }));
  writeFileSync(join(roles, "role-bad-dddd.running.json"), "not-json");
  writeFileSync(join(workerState, "lane-171.running.json"), JSON.stringify({ wrapper_pid: 101 }));
  const events: unknown[] = [];
  try {
    assert.deepEqual(
      sweepStaleRoleSessions(
        { appendEvent: (_kind, payload) => events.push(payload) },
        {
          stateDir: roles,
          worktreeRoot: worktrees,
          pidStatus: (pid) => (pid === 101 ? "dead" : pid === 103 ? "unreadable" : "alive"),
        },
      ),
      ["role-dead-aaaa"],
    );
    assert.equal(existsSync(join(roles, "role-dead-aaaa.running.json")), false);
    assert.equal(existsSync(join(worktrees, "role-dead-aaaa")), false);
    assert.equal(existsSync(join(roles, "role-alive-bbbb.running.json")), true);
    assert.equal(existsSync(join(roles, "role-unreadable-cccc.running.json")), true);
    assert.equal(existsSync(join(worktrees, "role-unreadable-cccc")), true);
    assert.equal(existsSync(join(roles, "role-bad-dddd.running.json")), true);
    assert.equal(existsSync(join(workerState, "lane-171.running.json")), true);
    assert.equal(existsSync(join(worktrees, "lane-171")), true);
    assert.deepEqual(events, [{ session: "role-dead-aaaa", removed: ["worktree", "sentinel"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
