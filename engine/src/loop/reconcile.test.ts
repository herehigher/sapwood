import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type IssueMeta, type PRStatus, referencedIssue, type StartupReconcileData } from "../forge/forge.js";
import { State, type WorkerRow } from "../state/state.js";
import {
  auditGatedEscalationFlags,
  diffStartupOrphans,
  type LaneRevivalForge,
  type ReconcileForge,
  reconcileStartup,
  reviveEnvFailedPrLanes,
  sweepStaleRoleSessions,
} from "./reconcile.js";

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

const cfg = {
  board: { owner: "acme", repo: "sapwood", status: { inProgress: "In Progress" } },
  labels: { inProgress: "in-progress" },
};

/** A reconcile-shaped forge whose issues are all OPEN and unlabelled unless `meta` says
 *  otherwise; every write is recorded rather than performed. */
function mkForge(
  read: () => Promise<StartupReconcileData>,
  meta: Record<number, Partial<IssueMeta>> = {},
): ReconcileForge & { removed: Array<[number, string]>; statuses: Array<[number, string]> } {
  const removed: Array<[number, string]> = [];
  const statuses: Array<[number, string]> = [];
  return {
    removed,
    statuses,
    readStartupReconcileData: read,
    async getIssueMeta(issue) {
      return { number: issue, title: `#${issue}`, state: "OPEN", labels: [], updatedAt: "2026-07-25T00:00:00.000Z", ...meta[issue] };
    },
    async removeLabel(issue, label) {
      removed.push([issue, label]);
    },
    async setBoardStatus(issue, status) {
      statuses.push([issue, status]);
    },
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

test("reconcileStartup emits orphans then one bounded completion, and touches nothing it cannot prove is dead", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  let reads = 0;
  const input: StartupReconcileData = {
    placements: [{ number: 171, repo: "acme/sapwood", status: "In Progress" }],
    openPrs: [{ number: 200, body: "Closes #171" }],
  };
  try {
    const result = await reconcileStartup(
      mkForge(async () => {
        reads++;
        return input;
      }),
      state,
      cfg,
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
      mkForge(async () => ({ placements: [{ number: 171, repo: "acme/sapwood", status: "In Progress" }], openPrs: [] })),
      state,
      cfg,
    );
    assert.deepEqual(healthy, []);
    assert.equal(state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected"]).length, 0);
    await assert.doesNotReject(() =>
      reconcileStartup(
        mkForge(async () => {
          throw new Error("forge down");
        }),
        state,
        cfg,
        (message) => logs.push(message),
      ),
    );
    assert.match(logs[0] ?? "", /forge down/);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #391 (F19/F20): quota-storm residue — reconcile HEALS instead of only reporting ─────────

test("#391 F20: reconcileStartup heals a dead PR-less lane's issue — board back to Ready, in-progress label stripped, both named in the events", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  try {
    const forge = mkForge(async () => ({
      placements: [
        { number: 145, repo: "acme/sapwood", status: "In Progress" }, // dead PR-less lane
        { number: 144, repo: "acme/sapwood", status: "In Progress" }, // lane still holds a PR
        { number: 146, repo: "acme/sapwood", status: null }, // unplaced — a different residue class
      ],
      openPrs: [{ number: 373, body: "Closes #144" }],
    }));
    const orphans = await reconcileStartup(forge, state, cfg);
    assert.equal(orphans.length, 4, "detection is unchanged — 3 issue orphans + the engine PR");
    // Board FIRST, then the label: a partial failure must leave the issue dispatchable rather
    // than invisible to both the pool and the standby probe.
    assert.deepEqual(forge.statuses, [[145, "ready"]]);
    assert.deepEqual(forge.removed, [[145, "in-progress"]]);
    const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-healed", "reconcile-completed"]);
    assert.deepEqual(events[0]?.payload, { issue: 145, actions: ["board-ready", "label-removed"] });
    assert.deepEqual((events[1]?.payload as { healed?: number[] })?.healed, [145]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#391 F20: a CLOSED orphaned issue is never resurrected, and a heal failure is reported without failing startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  const logs: string[] = [];
  try {
    const forge = mkForge(
      async () => ({
        placements: [
          { number: 145, repo: "acme/sapwood", status: "In Progress" },
          { number: 147, repo: "acme/sapwood", status: "In Progress" },
        ],
        openPrs: [],
      }),
      { 147: { state: "CLOSED" } },
    );
    forge.setBoardStatus = async () => {
      throw new Error("board write refused");
    };
    await assert.doesNotReject(() => reconcileStartup(forge, state, cfg, (m) => logs.push(m)));
    assert.deepEqual(forge.removed, [], "the label is only stripped once the board write landed");
    const failed = state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-heal-failed"]);
    assert.equal(failed.length, 1, "only the OPEN orphan was even attempted");
    assert.match(JSON.stringify(failed[0]?.payload), /board write refused/);
    assert.match(logs.join("\n"), /board write refused/);
    const completed = state.eventsSince("1970-01-01T00:00:00.000Z", ["reconcile-completed"])[0]?.payload as { healed: number[] };
    assert.deepEqual(completed.healed, []);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#391 F19: the gated-flag audit sets gated_escalation_labeled=1 for a lane whose issue still carries the hold, and surfaces the unprovable rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  try {
    // Both lanes are the storm's residue shape: failed + PR + flag 0 (the reclaim-failed/env-era
    // escalation path never set it), so gatedFailedWorkers() excludes them and gated reentry can
    // never fire, no matter what a human does with the label.
    state.upsertWorker({ ...worker(294, "failed", 372), gated_escalation_labeled: 0 });
    state.upsertWorker({ ...worker(295, "failed", 371), gated_escalation_labeled: 0 });
    assert.deepEqual(state.gatedFailedWorkers(), []);
    const forge = {
      async getIssueMeta(issue: number): Promise<IssueMeta> {
        return {
          number: issue,
          title: `#${issue}`,
          state: "OPEN",
          labels: issue === 294 ? ["needs-human"] : [],
          updatedAt: "2026-07-25T00:00:00.000Z",
        };
      },
    };
    await auditGatedEscalationFlags(forge, state, { escalation: { humanLabels: ["needs-human", "blocked"] } });
    assert.equal(state.getWorker("lane-294")?.gated_escalation_labeled, 1, "the hold is live — the flag is provably correctable");
    assert.equal(state.getWorker("lane-295")?.gated_escalation_labeled, 0, "no live hold — never fabricate the proof");
    assert.deepEqual(
      state.eventsSince("1970-01-01T00:00:00.000Z", ["gated-flag-healed", "gated-flag-unprovable"]).map((e) => [e.kind, e.payload]),
      [
        ["gated-flag-healed", { worker: "lane-294", issue: 294, pr: 372 }],
        ["gated-flag-unprovable", { worker: "lane-295", issue: 295, pr: 371 }],
      ],
    );
    // Removing the label is now the ONLY manual step: lane-294 is a reentry candidate.
    assert.deepEqual(
      state.gatedFailedWorkers().map((w) => w.name),
      ["lane-294"],
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#391 F19: a per-issue read failure leaves that lane's flag untouched and never aborts the audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-reconcile-"));
  const state = new State(join(root, "state.sqlite"));
  const logs: string[] = [];
  try {
    state.upsertWorker({ ...worker(294, "failed", 372), gated_escalation_labeled: 0 });
    state.upsertWorker({ ...worker(295, "failed", 371), gated_escalation_labeled: 0 });
    const forge = {
      async getIssueMeta(issue: number): Promise<IssueMeta> {
        if (issue === 294) throw new Error("gh rate limited");
        return { number: issue, title: `#${issue}`, state: "OPEN", labels: ["needs-human"], updatedAt: "2026-07-25T00:00:00.000Z" };
      },
    };
    await assert.doesNotReject(() =>
      auditGatedEscalationFlags(forge, state, { escalation: { humanLabels: ["needs-human"] } }, (m) => logs.push(m)),
    );
    assert.equal(state.getWorker("lane-294")?.gated_escalation_labeled, 0);
    assert.equal(state.getWorker("lane-295")?.gated_escalation_labeled, 1, "the second lane is still audited");
    assert.match(logs.join("\n"), /gh rate limited/);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #447 (F28 residual): the env-failed, PR-BEARING, never-escalated lane's revival path ─────

const REVIVAL_CFG = { escalation: { humanLabels: ["needs-human", "blocked"] } };

/** A revival-shaped forge: per-issue labels and per-PR state, both defaulting to the lane-378
 *  shape (no hold label on the issue, PR still OPEN). */
function mkRevivalForge(
  labels: Record<number, string[]> = {},
  prState: Record<number, PRStatus["state"]> = {},
): LaneRevivalForge & { prReads: number[] } {
  const prReads: number[] = [];
  return {
    prReads,
    async getIssueLabels(issue: number) {
      return labels[issue] ?? [];
    },
    async getPRStatus(pr: number): Promise<PRStatus> {
      prReads.push(pr);
      return { number: pr, headOid: "h", state: prState[pr] ?? "OPEN", mergeable: "MERGEABLE", ciGreen: true };
    },
  };
}

/** The 2026-07-30 lane-378 shape: env-failure-preserved left it `failed` with its PR and
 *  gated_escalation_labeled=0 (zero forge writes on that path — nothing was ever labelled). */
function seedEnvFailedPrLane(state: State, issue: number, pr: number, fixRounds = 0): void {
  state.upsertWorker({ ...worker(issue, "failed", pr), gated_escalation_labeled: 0, fix_rounds: fixRounds });
}

test("#447: an env-failed lane holding an OPEN PR with no hold label is revived to `driving` — fix_rounds, PR and the gated marker untouched, one event naming lane/issue/PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-revive-"));
  const state = new State(join(root, "state.sqlite"));
  try {
    seedEnvFailedPrLane(state, 378, 445, 2);
    assert.deepEqual(state.gatedFailedWorkers(), [], "not gated reentry's property — nothing ever labelled it");
    assert.deepEqual(await reviveEnvFailedPrLanes(mkRevivalForge(), state, REVIVAL_CFG), ["lane-378"]);
    const revived = state.getWorker("lane-378");
    assert.equal(revived?.state, "driving", "exactly what the four manual UPDATEs did");
    assert.equal(revived?.pr, 445);
    assert.equal(revived?.fix_rounds, 2, "the fix context the DRIVE loop re-enters with survives");
    assert.equal(revived?.gated_escalation_labeled, 0, "gated-reentry semantics unchanged — no proof fabricated");
    assert.deepEqual(
      state.eventsSince("1970-01-01T00:00:00.000Z", ["lane-revived"]).map((e) => e.payload),
      [{ worker: "lane-378", issue: 378, pr: 445 }],
    );
    // Idempotent: the revived row is `driving`, so it is no longer a candidate.
    assert.deepEqual(await reviveEnvFailedPrLanes(mkRevivalForge(), state, REVIVAL_CFG), []);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#447: a hold label leaves the lane to gated reentry, a MERGED/CLOSED PR to the terminal paths, and #397's human-merge-only latch is never re-driven", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-revive-"));
  const state = new State(join(root, "state.sqlite"));
  try {
    seedEnvFailedPrLane(state, 378, 445); // revivable
    seedEnvFailedPrLane(state, 379, 446); // needs-human -> the gated path's property
    seedEnvFailedPrLane(state, 380, 447); // blocked -> the FULL hold set, not needs-human alone
    seedEnvFailedPrLane(state, 381, 448); // PR merged -> terminal, nothing to drive
    seedEnvFailedPrLane(state, 382, 449); // PR closed -> terminal, nothing to drive
    // #397 bucket 2 settles to the IDENTICAL row shape with nothing on the issue — only the
    // durable verdict tells it apart from an env failure.
    seedEnvFailedPrLane(state, 383, 450);
    state.appendEvent("drive-human-merge-only", {
      worker: "lane-383",
      issue: 383,
      pr: 450,
      reason: "gate:HUMAN:instruction-path-change:CLAUDE.md",
    });
    const forge = mkRevivalForge({ 379: ["needs-human"], 380: ["blocked"] }, { 447: "MERGED", 448: "MERGED", 449: "CLOSED" });
    assert.deepEqual(await reviveEnvFailedPrLanes(forge, state, REVIVAL_CFG), ["lane-378"]);
    for (const [name, issue] of [
      ["lane-379", 379],
      ["lane-380", 380],
      ["lane-381", 381],
      ["lane-382", 382],
      ["lane-383", 383],
    ] as const) {
      assert.equal(state.getWorker(name)?.state, "failed", `#${issue} must stay where its own owner can find it`);
    }
    assert.deepEqual(forge.prReads, [445, 448, 449], "a held or bucket-2 lane is decided before any PR read");
    assert.deepEqual(
      state.eventsSince("1970-01-01T00:00:00.000Z", ["lane-revived"]).map((e) => e.payload),
      [{ worker: "lane-378", issue: 378, pr: 445 }],
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#447: a per-lane forge failure leaves that lane exactly as it was and never aborts the pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-revive-"));
  const state = new State(join(root, "state.sqlite"));
  const logs: string[] = [];
  try {
    seedEnvFailedPrLane(state, 378, 445);
    seedEnvFailedPrLane(state, 379, 446);
    const forge = mkRevivalForge();
    forge.getIssueLabels = async (issue: number) => {
      if (issue === 378) throw new Error("gh rate limited");
      return [];
    };
    await assert.doesNotReject(() => reviveEnvFailedPrLanes(forge, state, REVIVAL_CFG, (m) => logs.push(m)));
    assert.equal(state.getWorker("lane-378")?.state, "failed", "still a candidate for the next pass");
    assert.equal(state.getWorker("lane-379")?.state, "driving", "the second lane is still revived");
    assert.match(logs.join("\n"), /gh rate limited/);
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
