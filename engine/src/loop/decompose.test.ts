import assert from "node:assert/strict";
import test from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, Issue, SubIssue } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import { buildBacklogDigest } from "./align.js";
import { isDecomposeCandidate, runDecompositionPass, validateDecomposeOutput } from "./decompose.js";

const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
const readyBody = "## Why\nSmall.\n\n## What\nOne lane.\n\n## Acceptance criteria\n\n- [ ] Works\n\n## Verification plan\n\n- Run npm test";
const remainderBody = "## Why\nUnresolved.\n\n## What\nAdapter-specific remainder.";

function result(metadata: unknown, bodies?: string[]): string {
  let text = `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;
  if (bodies) {
    text += `\n${BODY_BLOCK_START}\n${bodies.map((body) => `<<<ISSUE>>>\n${body}\n<<<END_ISSUE>>>`).join("\n")}\n${BODY_BLOCK_END}`;
  }
  return text;
}

const mixedMetadata = {
  outcome: "decomposed",
  children: [
    { title: "Ready child", kind: "ready", blockedBy: [] },
    {
      title: "Remainder child",
      kind: "remainder",
      blockedBy: [0],
      unresolvedContext: { reason: "Adapter boundary is unknown." },
      informationNeeded: "Name the adapter owner.",
    },
  ],
  coverage: {
    mappings: [
      { parentIntent: "Core behavior", children: [0] },
      { parentIntent: "Adapter behavior", children: [1] },
    ],
    remainders: [1],
  },
} as const;

class Runner {
  calls: RoleSessionOpts[] = [];
  constructor(private readonly text: string) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    return { outcome: "done", name: `session-${this.calls.length}`, costUsd: 0, costKnown: true, modelUsage: [], resultText: this.text };
  }
}

function fakeForge(parent: Issue) {
  const order: string[] = [];
  const issues: Issue[] = [parent];
  const labels = new Map<number, string[]>([[parent.number, [...parent.labels]]]);
  const comments = new Map<number, Array<{ login: string; createdAt: string; body: string }>>();
  const subIssues: SubIssue[] = [];
  let next = 100;
  let failFence = false;
  let failAttachOnce = false;
  const forge = {
    order,
    issues,
    labels,
    comments,
    subIssues,
    set failFence(value: boolean) {
      failFence = value;
    },
    set failAttachOnce(value: boolean) {
      failAttachOnce = value;
    },
    async setBoardStatus(issue: number, status: string) {
      order.push(`status:${issue}:${status}`);
    },
    async removeLabel(issue: number, label: string) {
      order.push(`remove:${issue}:${label}`);
      labels.set(
        issue,
        (labels.get(issue) ?? []).filter((item) => item !== label),
      );
    },
    async addLabel(issue: number, label: string) {
      order.push(`label:${issue}:${label}`);
      if (failFence && issue === parent.number && label === cfg.labels.decomposed) throw new Error("fence failed");
      labels.set(issue, [...(labels.get(issue) ?? []), label]);
    },
    async createIssue(title: string, body: string) {
      order.push(`create:${title}`);
      const number = next++;
      issues.push({ number, title, body, labels: [] });
      labels.set(number, []);
      return number;
    },
    async addIssueComment(issue: number, body: string) {
      order.push(`comment:${issue}`);
      comments.set(issue, [...(comments.get(issue) ?? []), { login: "engine", createdAt: "2026-01-01T00:00:00Z", body }]);
    },
    async getIssueComments(issue: number) {
      return comments.get(issue) ?? [];
    },
    async getIssueBody(issue: number) {
      return issues.find((item) => item.number === issue)?.body ?? "";
    },
    async getSubIssues() {
      return [...subIssues];
    },
    async addSubIssue(_parent: number, child: number) {
      order.push(`attach:${child}`);
      if (failAttachOnce) {
        failAttachOnce = false;
        throw new Error("attach unavailable");
      }
      if (!subIssues.some((item) => item.number === child)) subIssues.push({ number: child, title: `#${child}`, state: "OPEN" });
    },
  };
  return forge;
}

test("validateDecomposeOutput: both union branches validate; mixed output preserves ready and honest remainder bodies", () => {
  const mixed = validateDecomposeOutput(result(mixedMetadata, [readyBody, remainderBody]), 8);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.ok && mixed.outcome === "decomposed" ? mixed.children[1]!.kind : null, "remainder");
  assert.match(mixed.ok && mixed.outcome === "decomposed" ? mixed.children[1]!.body : "", /Information needed: Name the adapter owner/);

  const unresolved = validateDecomposeOutput(
    result({ outcome: "unresolved", reason: "Misaligned.", unresolvedContext: { reason: "Goal conflict." } }),
    8,
  );
  assert.deepEqual(unresolved.ok && unresolved.outcome, "unresolved");
});

test("validateDecomposeOutput: maxChildren, ready-plan/AC, coverage, and remainder honesty fail closed", () => {
  assert.match((validateDecomposeOutput(result(mixedMetadata, [readyBody, remainderBody]), 1) as { reason: string }).reason, /maxChildren/);
  assert.match(
    (validateDecomposeOutput(result(mixedMetadata, ["planless", remainderBody]), 8) as { reason: string }).reason,
    /acceptance criteria/,
  );
  assert.match(
    (
      validateDecomposeOutput(
        result(mixedMetadata, ["## Acceptance criteria\n\n- [ ] checkbox without verification", remainderBody]),
        8,
      ) as { reason: string }
    ).reason,
    /verification plan/,
  );
  const badCoverage = { ...mixedMetadata, coverage: { mappings: [{ parentIntent: "Only core", children: [0] }], remainders: [] } };
  assert.match((validateDecomposeOutput(result(badCoverage, [readyBody, remainderBody]), 8) as { reason: string }).reason, /omits/);
});

test("anti-recursion: origin:agent is autonomous-ineligible; a human split re-admits it; decomposed always fences", () => {
  const child: Issue = { number: 2, title: "child", labels: [cfg.labels.originAgent] };
  assert.equal(isDecomposeCandidate(child, cfg), false);
  assert.equal(isDecomposeCandidate({ ...child, labels: [...child.labels, cfg.labels.split] }, cfg), true);
  assert.equal(isDecomposeCandidate({ ...child, labels: [...child.labels, cfg.labels.split, cfg.labels.decomposed] }, cfg), false);
  assert.equal(
    isDecomposeCandidate({ ...child, labels: [...child.labels, cfg.labels.split, cfg.labels.needsHuman] }, cfg),
    false,
    "a failed attempt parked at needs-human does not loop",
  );
});

test("#310 backlog blindness: the PO digest omits decomposed parents", async () => {
  const digest = await buildBacklogDigest(
    {
      async listOpenIssues() {
        return [
          { number: 1, title: "tracking parent", labels: [cfg.labels.decomposed] },
          { number: 2, title: "real backlog child", labels: [] },
        ];
      },
    } as unknown as IForge,
    cfg,
  );
  assert.equal(digest.ok, true);
  assert.doesNotMatch(digest.text, /tracking parent/);
  assert.match(digest.text, /real backlog child/);
});

test("unresolved feasibility is advisory-only; invalid or over-bound output lands needs-human with evidence and no children", async () => {
  const advisoryParent: Issue = { number: 8, title: "Questionable split", body: "why", labels: [cfg.labels.split] };
  const advisoryForge = fakeForge(advisoryParent);
  const advisoryRunner = new Runner(
    result({
      outcome: "unresolved",
      reason: "The requested split conflicts with the stated goal.",
      unresolvedContext: { reason: "The parent does not choose which compatibility contract wins." },
    }),
  );
  await runDecompositionPass(
    { forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
    5,
    advisoryForge.issues,
  );
  assert.equal(advisoryForge.issues.length, 1);
  assert.deepEqual(advisoryForge.labels.get(8), [cfg.labels.split]);
  assert.match(advisoryForge.comments.get(8)![0]!.body, /advisory only/);
  assert.equal(
    advisoryForge.order.some((item) => item.startsWith("status:")),
    false,
  );
  await runDecompositionPass(
    { forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
    6,
    advisoryForge.issues,
  );
  assert.equal(advisoryRunner.calls.length, 1, "the same why/what firing does not loop");
  advisoryForge.issues[0] = { ...advisoryForge.issues[0]!, body: "why, now with the missing compatibility choice" };
  await runDecompositionPass(
    { forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
    7,
    advisoryForge.issues,
  );
  assert.equal(advisoryRunner.calls.length, 2, "new why/what evidence re-arms the advisory attempt");

  const failedParent: Issue = { number: 9, title: "Too many children", body: "why", labels: [cfg.labels.split] };
  const failedForge = fakeForge(failedParent);
  await runDecompositionPass(
    {
      forge: failedForge as unknown as IForge,
      state: new State(":memory:"),
      cfg: ConfigSchema.parse({
        board: { owner: "o", repo: "r", projectNumber: 4 },
        roles: { po: { maxChildren: 1 } },
      }),
      runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
    },
    6,
    failedForge.issues,
  );
  assert.equal(failedForge.issues.length, 1);
  assert.ok(failedForge.labels.get(9)!.includes(cfg.labels.needsHuman));
  assert.match(failedForge.comments.get(9)![0]!.body, /maxChildren/);
  assert.equal(
    failedForge.order.some((item) => item.startsWith("status:")),
    false,
  );
});

test("mixed decomposition: fence and journal precede creates; children stay outside Ready; remainder uses planless needs-human; coverage posts once", async () => {
  const parent: Issue = {
    number: 10,
    title: "Oversized",
    body: "big",
    labels: [cfg.labels.split, cfg.labels.roundPool],
  };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  await runDecompositionPass(
    { forge: fake as unknown as IForge, state, cfg, runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])) },
    7,
    fake.issues,
  );
  const fenceIndex = fake.order.indexOf(`label:10:${cfg.labels.decomposed}`);
  const firstCreate = fake.order.findIndex((item) => item.startsWith("create:"));
  assert.ok(fake.order.indexOf("status:10:backlog") < fenceIndex);
  assert.ok(fake.order.indexOf(`remove:10:${cfg.labels.roundPool}`) < fenceIndex);
  assert.ok(fenceIndex < firstCreate);
  assert.equal(state.eventsAfterId(0, ["proposal-set-persisted"]).length, 1);
  assert.deepEqual(fake.labels.get(100), [cfg.labels.originAgent]);
  assert.ok(fake.labels.get(101)!.includes(cfg.labels.needsHuman));
  assert.ok(fake.labels.get(101)!.includes(`${cfg.labels.prefix}blocked-by:#100`));
  assert.deepEqual(
    fake.subIssues.map((item) => item.number),
    [100, 101],
  );
  assert.equal((fake.comments.get(10) ?? []).filter((comment) => comment.body.includes("decompose-coverage")).length, 1);
  assert.deepEqual(
    fake.order.filter((item) => item.startsWith("status:") && !item.endsWith(":backlog")),
    [],
  );
});

test("fence label failure creates zero children; attach failure is recorded and retries under the standing fence without recreating", async () => {
  const parent: Issue = { number: 11, title: "Oversized", body: "big", labels: [cfg.labels.split] };
  const failedFence = fakeForge(parent);
  failedFence.failFence = true;
  const failedFenceState = new State(":memory:");
  const failedFenceRunner = new Runner(result(mixedMetadata, [readyBody, remainderBody]));
  await runDecompositionPass(
    {
      forge: failedFence as unknown as IForge,
      state: failedFenceState,
      cfg,
      runner: failedFenceRunner,
    },
    8,
    failedFence.issues,
  );
  assert.equal(failedFence.issues.length, 1);
  assert.equal(failedFenceState.eventsAfterId(0, ["proposal-set-persisted"]).length, 1);
  failedFence.failFence = false;
  await runDecompositionPass(
    { forge: failedFence as unknown as IForge, state: failedFenceState, cfg, runner: failedFenceRunner },
    9,
    failedFence.issues,
  );
  assert.equal(failedFence.issues.length, 3, "the persisted set resumes after the fence write recovers");
  assert.equal(failedFenceRunner.calls.length, 1, "fence recovery does not pay for another PO session");

  const retryForge = fakeForge(parent);
  retryForge.failAttachOnce = true;
  const state = new State(":memory:");
  await runDecompositionPass(
    { forge: retryForge as unknown as IForge, state, cfg, runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])) },
    9,
    retryForge.issues,
  );
  assert.equal(state.eventsAfterId(0, ["tick-error"]).length, 1);
  const createdCount = retryForge.issues.length;
  const fencedParent = { ...parent, labels: [...parent.labels, cfg.labels.decomposed] };
  retryForge.issues[0] = fencedParent;
  await runDecompositionPass({ forge: retryForge as unknown as IForge, state, cfg, runner: new Runner("unused") }, 10, retryForge.issues);
  assert.equal(retryForge.issues.length, createdCount, "reconcile never recreates children");
  assert.deepEqual(retryForge.subIssues.map((item) => item.number).sort(), [100, 101]);
  assert.equal((retryForge.comments.get(11) ?? []).filter((comment) => comment.body.includes("decompose-coverage")).length, 1);
  const writesAfterReconcile = retryForge.order.length;
  await runDecompositionPass({ forge: retryForge as unknown as IForge, state, cfg, runner: new Runner("unused") }, 11, retryForge.issues);
  assert.equal(retryForge.order.length, writesAfterReconcile, "a fully reconciled standing fence is a write-free no-op");
});
