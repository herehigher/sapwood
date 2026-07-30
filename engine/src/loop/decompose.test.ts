import assert from "node:assert/strict";
import test from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, Issue, SubIssue } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import { buildBacklogDigest } from "./align.js";
import { decomposeProposalId, isDecomposeCandidate, runDecompositionPass, validateDecomposeOutput } from "./decompose.js";
import { proposalMarker } from "./issue-creation.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

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
    return {
      outcome: "done",
      name: `session-${this.calls.length}`,
      costUsd: 0,
      costKnown: true,
      modelUsage: [],
      exitCode: 0,
      resultText: this.text,
    };
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
  let collisionOnFenceTitle: string | null = null;
  let throwAfterCommentFor: number | null = null;
  let failIssueFetchFor: number | null = null;
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
    set collisionOnFence(value: string | null) {
      collisionOnFenceTitle = value;
    },
    set throwAfterCommentOnceFor(value: number | null) {
      throwAfterCommentFor = value;
    },
    set failIssueFetchOnceFor(value: number | null) {
      failIssueFetchFor = value;
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
      if (issue === parent.number && label === cfg.labels.decomposed && collisionOnFenceTitle !== null) {
        issues.push({ number: 88, title: collisionOnFenceTitle, body: "raced into existence", labels: [] });
        labels.set(88, []);
        collisionOnFenceTitle = null;
      }
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
      if (throwAfterCommentFor === issue) {
        throwAfterCommentFor = null;
        throw new Error("process died after comment landed");
      }
    },
    async getIssueComments(issue: number) {
      return comments.get(issue) ?? [];
    },
    async getIssueBody(issue: number) {
      return issues.find((item) => item.number === issue)?.body ?? "";
    },
    async getIssueMeta(issue: number) {
      if (failIssueFetchFor === issue) {
        failIssueFetchFor = null;
        throw new Error("transient issue fetch failure");
      }
      const found = issues.find((item) => item.number === issue);
      if (!found) throw new Error(`issue #${issue} not found`);
      return {
        number: found.number,
        title: found.title,
        state: "OPEN" as const,
        labels: [...found.labels],
        updatedAt: "2026-01-01T00:00:00Z",
      };
    },
    async listOpenIssues() {
      return [...issues];
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

function persistDecomposedSet(
  state: State,
  roundId: number,
  parent: number,
  overrides: Partial<{
    scope: string;
    parent: number;
    proposals: Array<{
      proposalId: string;
      index: number;
      title: string;
      body: string;
      kind: "ready" | "remainder";
      blockedBy: number[];
    }>;
    coverage: unknown;
  }> = {},
) {
  const proposals = overrides.proposals ?? [
    {
      proposalId: decomposeProposalId(roundId, parent, 0, "Ready child"),
      index: 0,
      title: "Ready child",
      body: readyBody,
      kind: "ready" as const,
      blockedBy: [],
    },
    {
      proposalId: decomposeProposalId(roundId, parent, 1, "Remainder child"),
      index: 1,
      title: "Remainder child",
      body: remainderBody,
      kind: "remainder" as const,
      blockedBy: [0],
    },
  ];
  state.appendEvent("proposal-set-persisted", {
    outcome: "decomposed",
    round_id: roundId,
    scope: overrides.scope ?? `decompose:#${parent}`,
    parent: overrides.parent ?? parent,
    proposals,
    coverage:
      overrides.coverage ??
      ({
        mappings: [
          { parentIntent: "Core behavior", children: [0] },
          { parentIntent: "Adapter behavior", children: [1] },
        ],
        remainders: [1],
      } as const),
  });
  return proposals;
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

test("validateDecomposeOutput: reserved proposal markers cannot be smuggled through sibling titles or bodies", () => {
  const siblingMarker = proposalMarker(decomposeProposalId(7, 10, 1, "Remainder child"));
  const bodySmuggle = validateDecomposeOutput(result(mixedMetadata, [`${readyBody}\n\n${siblingMarker}`, remainderBody]), 8);
  assert.match((bodySmuggle as { reason: string }).reason, /reserved sapwood proposal-marker namespace/);

  const titleSmuggle = {
    ...mixedMetadata,
    children: [{ ...mixedMetadata.children[0], title: `Ready child ${siblingMarker}` }, mixedMetadata.children[1]],
  };
  assert.match(
    (validateDecomposeOutput(result(titleSmuggle, [readyBody, remainderBody]), 8) as { reason: string }).reason,
    /reserved sapwood proposal-marker namespace/,
  );
});

test("validateDecomposeOutput: forge-invalid whitespace/overlong titles and whitespace-only coverage/evidence fail before fencing", () => {
  const cases: Array<[unknown, string[] | undefined]> = [
    [
      { ...mixedMetadata, children: [{ ...mixedMetadata.children[0], title: "   " }, mixedMetadata.children[1]] },
      [readyBody, remainderBody],
    ],
    [
      { ...mixedMetadata, children: [{ ...mixedMetadata.children[0], title: "x".repeat(257) }, mixedMetadata.children[1]] },
      [readyBody, remainderBody],
    ],
    [
      { ...mixedMetadata, coverage: { ...mixedMetadata.coverage, mappings: [{ parentIntent: "   ", children: [0] }] } },
      [readyBody, remainderBody],
    ],
    [
      {
        ...mixedMetadata,
        children: [mixedMetadata.children[0], { ...mixedMetadata.children[1], unresolvedContext: { reason: "   " } }],
      },
      [readyBody, remainderBody],
    ],
    [
      {
        ...mixedMetadata,
        children: [mixedMetadata.children[0], { ...mixedMetadata.children[1], informationNeeded: "   " }],
      },
      [readyBody, remainderBody],
    ],
    [{ outcome: "unresolved", reason: "   ", unresolvedContext: { reason: "evidence" } }, undefined],
    [{ outcome: "unresolved", reason: "decision", unresolvedContext: { reason: "   " } }, undefined],
  ];
  for (const [metadata, bodies] of cases) {
    assert.equal(validateDecomposeOutput(result(metadata, bodies), 8).ok, false);
  }
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
    { now: realClock, forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
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
    { now: realClock, forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
    6,
    advisoryForge.issues,
  );
  assert.equal(advisoryRunner.calls.length, 1, "the same why/what firing does not loop");
  advisoryForge.issues[0] = { ...advisoryForge.issues[0]!, body: "why, now with the missing compatibility choice" };
  await runDecompositionPass(
    { now: realClock, forge: advisoryForge as unknown as IForge, state: new State(":memory:"), cfg, runner: advisoryRunner },
    7,
    advisoryForge.issues,
  );
  assert.equal(advisoryRunner.calls.length, 2, "new why/what evidence re-arms the advisory attempt");

  const failedParent: Issue = { number: 9, title: "Too many children", body: "why", labels: [cfg.labels.split] };
  const failedForge = fakeForge(failedParent);
  await runDecompositionPass(
    {
      now: realClock,
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
    { now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])) },
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
    { now: realClock, forge: failedFence as unknown as IForge, state: failedFenceState, cfg, runner: failedFenceRunner },
    8,
    failedFence.issues,
  );
  assert.equal(failedFence.issues.length, 1);
  assert.equal(failedFenceState.eventsAfterId(0, ["proposal-set-persisted"]).length, 1);
  failedFence.failFence = false;
  await runDecompositionPass(
    { now: realClock, forge: failedFence as unknown as IForge, state: failedFenceState, cfg, runner: failedFenceRunner },
    9,
    failedFence.issues,
  );
  assert.equal(failedFence.issues.length, 3, "the persisted set resumes after the fence write recovers");
  assert.equal(failedFenceRunner.calls.length, 1, "fence recovery does not pay for another PO session");

  const retryForge = fakeForge(parent);
  retryForge.failAttachOnce = true;
  const state = new State(":memory:");
  await runDecompositionPass(
    {
      now: realClock,
      forge: retryForge as unknown as IForge,
      state,
      cfg,
      runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
    },
    9,
    retryForge.issues,
  );
  assert.equal(state.eventsAfterId(0, ["tick-error"]).length, 1);
  const createdCount = retryForge.issues.length;
  const fencedParent = { ...parent, labels: [...parent.labels, cfg.labels.decomposed] };
  retryForge.issues[0] = fencedParent;
  await runDecompositionPass(
    { now: realClock, forge: retryForge as unknown as IForge, state, cfg, runner: new Runner("unused") },
    10,
    retryForge.issues,
  );
  assert.equal(retryForge.issues.length, createdCount, "reconcile never recreates children");
  assert.deepEqual(retryForge.subIssues.map((item) => item.number).sort(), [100, 101]);
  assert.equal((retryForge.comments.get(11) ?? []).filter((comment) => comment.body.includes("decompose-coverage")).length, 1);
  const writesAfterReconcile = retryForge.order.length;
  await runDecompositionPass(
    { now: realClock, forge: retryForge as unknown as IForge, state, cfg, runner: new Runner("unused") },
    11,
    retryForge.issues,
  );
  assert.equal(retryForge.order.length, writesAfterReconcile, "a fully reconciled standing fence is a write-free no-op");
});

test("proposal reconciliation ignores unrelated issues carrying a copied marker outside the exact trailer or under the wrong title", async () => {
  const parent: Issue = { number: 20, title: "Oversized", body: "big", labels: [cfg.labels.split] };
  const fake = fakeForge(parent);
  const copied = proposalMarker(decomposeProposalId(12, parent.number, 0, "Ready child"));
  fake.issues.push(
    { number: 77, title: "Unrelated issue", body: `unrelated ${copied} trailing text`, labels: [] },
    { number: 78, title: "Also unrelated", body: `unrelated body\n\n${copied}`, labels: [] },
  );
  fake.labels.set(77, []);
  fake.labels.set(78, []);
  await runDecompositionPass(
    {
      now: realClock,
      forge: fake as unknown as IForge,
      state: new State(":memory:"),
      cfg,
      runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
    },
    12,
    fake.issues,
  );
  assert.equal(fake.order.filter((item) => item.startsWith("create:")).length, 2);
  assert.deepEqual(fake.labels.get(77), [], "the copied marker cannot route governance writes to an unrelated issue");
  assert.deepEqual(fake.labels.get(78), [], "even an exact trailer must agree with the proposal title");
});

test("title collisions are caller-specific: decompose preflights before fencing, then escalates a post-fence race durably and stays write-free", async () => {
  const preflightParent: Issue = { number: 21, title: "Oversized", body: "big", labels: [cfg.labels.split] };
  const preflight = fakeForge(preflightParent);
  preflight.issues.push({ number: 70, title: "READY   CHILD!", body: "existing", labels: [] });
  preflight.labels.set(70, []);
  const preflightState = new State(":memory:");
  await runDecompositionPass(
    {
      now: realClock,
      forge: preflight as unknown as IForge,
      state: preflightState,
      cfg,
      runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
    },
    13,
    preflight.issues,
  );
  assert.equal(
    preflight.order.some((item) => item.startsWith("status:")),
    false,
  );
  assert.equal(
    preflight.order.some((item) => item.startsWith("create:")),
    false,
  );
  assert.ok(preflight.labels.get(21)!.includes(cfg.labels.needsHuman));
  assert.equal(preflightState.eventsAfterId(0, ["proposal-set-persisted"]).length, 0);

  const racedParent: Issue = { number: 22, title: "Oversized race", body: "big", labels: [cfg.labels.split] };
  const raced = fakeForge(racedParent);
  raced.collisionOnFence = "Ready child";
  const racedState = new State(":memory:");
  await runDecompositionPass(
    {
      now: realClock,
      forge: raced as unknown as IForge,
      state: racedState,
      cfg,
      runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
    },
    14,
    raced.issues,
  );
  assert.equal(
    raced.order.some((item) => item.startsWith("create:")),
    false,
  );
  assert.ok(raced.labels.get(22)!.includes(cfg.labels.needsHuman));
  assert.equal(racedState.eventsAfterId(0, ["proposal-skipped"]).length, 1);
  assert.match(raced.comments.get(22)![0]!.body, /No colliding proposal was silently skipped/);

  raced.issues[0] = { ...racedParent, labels: [...racedParent.labels, cfg.labels.decomposed, cfg.labels.needsHuman] };
  const writes = raced.order.length;
  await runDecompositionPass(
    { now: realClock, forge: raced as unknown as IForge, state: racedState, cfg, runner: new Runner("unused") },
    15,
    raced.issues,
  );
  assert.equal(raced.order.length, writes, "a collision-escalated standing fence is a write-free no-op");
});

test("child governance comment is live-marker idempotent across a crash after comment delivery but before any receipt", async () => {
  const parent: Issue = { number: 23, title: "Crash window", body: "big", labels: [cfg.labels.split] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  fake.throwAfterCommentOnceFor = 100;
  await assert.rejects(
    () =>
      runDecompositionPass(
        {
          now: realClock,
          forge: fake as unknown as IForge,
          state,
          cfg,
          runner: new Runner(result(mixedMetadata, [readyBody, remainderBody])),
        },
        15,
        fake.issues,
      ),
    /process died after comment landed/,
  );
  assert.equal((fake.comments.get(100) ?? []).length, 1);
  assert.equal(state.eventsAfterId(0, ["proposal-comment-posted"]).length, 0);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 0);

  fake.issues[0] = { ...parent, labels: [...parent.labels, cfg.labels.decomposed] };
  const rerun = new Runner("must not run");
  await runDecompositionPass({ now: realClock, forge: fake as unknown as IForge, state, cfg, runner: rerun }, 16, fake.issues);
  assert.equal(rerun.calls.length, 0);
  assert.equal((fake.comments.get(100) ?? []).length, 1, "the live governance marker prevents a duplicate");
  assert.equal(state.eventsAfterId(0, ["proposal-comment-posted"]).length, 2);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 2);
});

test("unresolved decision is write-ahead durable and replays before the firing-marker early exit", async () => {
  const parent: Issue = { number: 24, title: "Unresolved crash", body: "why", labels: [cfg.labels.split] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  fake.throwAfterCommentOnceFor = parent.number;
  const runner = new Runner(
    result({
      outcome: "unresolved",
      reason: "The split is not supportable.",
      unresolvedContext: { reason: "Ownership evidence is missing." },
    }),
  );
  await runDecompositionPass({ now: realClock, forge: fake as unknown as IForge, state, cfg, runner }, 16, fake.issues);
  assert.equal(state.eventsAfterId(0, ["proposal-set-persisted"]).length, 1);
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);
  assert.equal((fake.comments.get(parent.number) ?? []).length, 1);

  await runDecompositionPass({ now: realClock, forge: fake as unknown as IForge, state, cfg, runner }, 17, fake.issues);
  assert.equal(runner.calls.length, 1, "replay never pays for a second PO session");
  assert.equal((fake.comments.get(parent.number) ?? []).length, 1, "the concern marker prevents a duplicate");
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 1, "the lost receipt is reconciled despite the firing marker");
});

test("decomposition journal rejects forged identities, scope drift, invalid references, duplicate terminals, and duplicate issue receipts", async () => {
  const parent: Issue = { number: 25, title: "Fenced", body: "big", labels: [cfg.labels.decomposed] };

  async function rejectsJournal(
    configure: (state: State, proposals: ReturnType<typeof persistDecomposedSet>) => void,
    overrides: Parameters<typeof persistDecomposedSet>[3] = {},
  ) {
    const fake = fakeForge(parent);
    const state = new State(":memory:");
    const proposals = persistDecomposedSet(state, 17, parent.number, overrides);
    configure(state, proposals);
    await assert.rejects(
      () =>
        runDecompositionPass(
          { now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner("unused") },
          18,
          fake.issues,
        ),
      /(invalid|malformed|mismatch|multiple|duplicate|unknown|out-of-range|omits)/,
    );
    assert.equal(fake.order.length, 0);
  }

  await rejectsJournal(() => {}, {
    proposals: [
      {
        proposalId: "forged",
        index: 0,
        title: "Ready child",
        body: readyBody,
        kind: "ready",
        blockedBy: [],
      },
    ],
    coverage: { mappings: [{ parentIntent: "intent", children: [0] }], remainders: [] },
  });
  await rejectsJournal(() => {}, { parent: parent.number + 1 });
  await rejectsJournal(() => {}, {
    coverage: { mappings: [{ parentIntent: "intent", children: [99] }], remainders: [1] },
  });
  await rejectsJournal((state, proposals) => {
    const receipt = {
      round_id: 17,
      scope: `decompose:#${parent.number}`,
      parent: parent.number,
      proposalId: proposals[0]!.proposalId,
      issue: 500,
    };
    state.appendEvent("proposal-created", receipt);
    state.appendEvent("proposal-created", receipt);
  });
  await rejectsJournal((state, proposals) => {
    for (const proposal of proposals) {
      state.appendEvent("proposal-created", {
        round_id: 17,
        scope: `decompose:#${parent.number}`,
        parent: parent.number,
        proposalId: proposal.proposalId,
        issue: 500,
      });
    }
  });
  await rejectsJournal((state) => {
    state.appendEvent("proposal-created", {
      round_id: 17,
      scope: `decompose:#${parent.number}`,
      parent: parent.number,
      proposalId: "unknown",
      issue: 500,
    });
  });
});

test("durable decomposition replay is independent of current maxChildren config drift", async () => {
  const parent: Issue = { number: 26, title: "Fenced config drift", body: "big", labels: [cfg.labels.decomposed] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  persistDecomposedSet(state, 18, parent.number);
  const narrower = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    roles: { po: { maxChildren: 1 } },
  });
  await runDecompositionPass(
    { now: realClock, forge: fake as unknown as IForge, state, cfg: narrower, runner: new Runner("unused") },
    19,
    fake.issues,
  );
  assert.equal(fake.order.filter((item) => item.startsWith("create:")).length, 2);
});

test("replay rejects a schema-valid proposal-created receipt pointing at an unrelated live issue before recovery writes", async () => {
  const parent: Issue = { number: 27, title: "Fenced wrong receipt", body: "big", labels: [cfg.labels.decomposed] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  const proposals = persistDecomposedSet(state, 19, parent.number);
  fake.issues.push({ number: 999, title: "Unrelated issue", body: "right shape, wrong content", labels: [] });
  fake.labels.set(999, []);
  state.appendEvent("proposal-created", {
    round_id: 19,
    scope: `decompose:#${parent.number}`,
    parent: parent.number,
    proposalId: proposals[0]!.proposalId,
    issue: 999,
  });

  await runDecompositionPass(
    { now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner("unused") },
    20,
    fake.issues,
  );

  assert.equal(
    fake.order.some((write) => write === "attach:999" || write.startsWith("label:999:")),
    false,
  );
  assert.ok(fake.labels.get(parent.number)!.includes(cfg.labels.needsHuman));
  assert.match(fake.comments.get(parent.number)![0]!.body, /#999/);
  assert.match(fake.comments.get(parent.number)![0]!.body, /title match=false, trailer match=false/);
  const escalated = state.eventsAfterId(0, ["proposal-skipped"]);
  assert.equal(escalated.length, 1);
  assert.equal((escalated[0]!.payload as { existingIssue: number }).existingIssue, 999);
  const writesAfterEscalation = fake.order.length;
  await runDecompositionPass(
    { now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner("unused") },
    21,
    fake.issues,
  );
  assert.equal(fake.order.length, writesAfterEscalation, "the durable escalation makes later replay a write-free no-op");
});

test("replay admits correct proposal-created receipts after exact trailer and normalized-title verification", async () => {
  const parent: Issue = { number: 28, title: "Fenced correct receipts", body: "big", labels: [cfg.labels.decomposed] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  const proposals = persistDecomposedSet(state, 20, parent.number);
  for (const [index, proposal] of proposals.entries()) {
    const issue = 700 + index;
    fake.issues.push({
      number: issue,
      title: index === 0 ? " READY child! " : proposal.title,
      body: `${proposal.body}\n\n${proposalMarker(proposal.proposalId)}`,
      labels: [],
    });
    fake.labels.set(issue, []);
    state.appendEvent("proposal-created", {
      round_id: 20,
      scope: `decompose:#${parent.number}`,
      parent: parent.number,
      proposalId: proposal.proposalId,
      issue,
    });
  }

  const narrower = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    roles: { po: { maxChildren: 1 } },
  });
  await runDecompositionPass(
    { now: realClock, forge: fake as unknown as IForge, state, cfg: narrower, runner: new Runner("unused") },
    21,
    fake.issues,
  );

  assert.equal(
    fake.order.some((write) => write.startsWith("create:")),
    false,
  );
  assert.ok(fake.order.includes(`label:701:${cfg.labels.prefix}blocked-by:#700`));
  assert.ok(fake.order.includes("attach:700"));
  assert.ok(fake.order.includes("attach:701"));
  assert.match(fake.comments.get(parent.number)![0]!.body, /#700/);
  assert.match(fake.comments.get(parent.number)![0]!.body, /#701/);
});

test("transient live fetch failure propagates before receipt admission and rerun retries", async () => {
  const parent: Issue = { number: 29, title: "Fenced transient receipt", body: "big", labels: [cfg.labels.decomposed] };
  const fake = fakeForge(parent);
  const state = new State(":memory:");
  const proposals = persistDecomposedSet(state, 21, parent.number, {
    proposals: [
      {
        proposalId: decomposeProposalId(21, parent.number, 0, "Ready child"),
        index: 0,
        title: "Ready child",
        body: readyBody,
        kind: "ready",
        blockedBy: [],
      },
    ],
    coverage: { mappings: [{ parentIntent: "Core behavior", children: [0] }], remainders: [] },
  });
  fake.issues.push({
    number: 800,
    title: proposals[0]!.title,
    body: `${proposals[0]!.body}\n\n${proposalMarker(proposals[0]!.proposalId)}`,
    labels: [],
  });
  fake.labels.set(800, []);
  state.appendEvent("proposal-created", {
    round_id: 21,
    scope: `decompose:#${parent.number}`,
    parent: parent.number,
    proposalId: proposals[0]!.proposalId,
    issue: 800,
  });
  fake.failIssueFetchOnceFor = 800;

  await assert.rejects(
    () =>
      runDecompositionPass({ now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner("unused") }, 22, fake.issues),
    /transient issue fetch failure/,
  );
  // Copy, not `fake.order` itself: node:assert's `asserts actual is T` signature would otherwise
  // narrow the live array to `never[]` for the rest of the test.
  assert.deepEqual([...fake.order], []);
  assert.equal(state.eventsAfterId(0, ["proposal-skipped"]).length, 0);

  await runDecompositionPass(
    { now: realClock, forge: fake as unknown as IForge, state, cfg, runner: new Runner("unused") },
    23,
    fake.issues,
  );
  assert.ok(fake.order.includes("attach:800"));
});
