// escalation-sweep.test.ts (#441, F34): the WRITE half — the sweepable fold, the ownership proof,
// the crash-window replay, and the exactly-once latch. Same "fake the collaborator, not the CLI"
// split as escalation-reconcile.test.ts, whose reconciler produces this module's only input.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { IForge, IssueMeta, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { State } from "../state/state.js";
import { reconcileEscalations } from "./escalation-reconcile.js";
import { SWEPT_KIND, sweepableHolds, sweepResolvedHolds } from "./escalation-sweep.js";

/** Only the three methods this module and its upstream reconciler touch are real; everything else
 *  throws by name (UnstubbedForge). `removed` is the assertion surface: exactly which labels came
 *  off which issues, in order. */
class FakeForge extends UnstubbedForge implements IForge {
  issueStates: Record<number, "OPEN" | "CLOSED"> = {};
  issueLabels: Record<number, string[]> = {};
  prStates: Record<number, "OPEN" | "CLOSED" | "MERGED"> = {};
  removed: Array<[number, string]> = [];
  /** Issue numbers whose removeLabel should throw (degradation test). */
  failRemovalsFor = new Set<number>();

  override async removeLabel(issue: number, label: string): Promise<void> {
    if (this.failRemovalsFor.has(issue)) throw new Error("forge exploded");
    this.removed.push([issue, label]);
    // GitHub's own semantics, which the sweep's retry safety rests on: idempotent.
    this.issueLabels[issue] = (this.issueLabels[issue] ?? []).filter((l) => l !== label);
  }
  override async getIssueMeta(issue: number): Promise<IssueMeta> {
    return {
      number: issue,
      title: "",
      state: this.issueStates[issue] ?? "OPEN",
      labels: this.issueLabels[issue] ?? [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  override async getPRStatus(pr: number): Promise<PRStatus> {
    return { number: pr, headOid: "x", state: this.prStates[pr] ?? "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
}

const mkCfg = (): SapwoodConfig => ConfigSchema.parse({ board: { owner: "owner", repo: "r", projectNumber: 1 } });
const NEEDS_HUMAN = mkCfg().labels.needsHuman;

const sweptEvents = (state: State) => state.eventsAfterId(0, [SWEPT_KIND]).map((e) => e.payload as Record<string, unknown>);

// ── the fold: who owns the label ─────────────────────────────────────────────────────────────

test("sweepableHolds: a resolved, label-proven escalation is sweepable", () => {
  const holds = sweepableHolds([
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "fix-rounds-capped", via: "merged" } },
  ]);
  assert.deepEqual([...holds.values()], [{ source: "fix-rounds-capped", issue: 7, via: "merged" }]);
});

test("sweepableHolds: a NOT-label-proven source (best-effort addLabel) is never sweepable", () => {
  // ceiling-escalated `.catch(() => {})`s its addLabel, so a label on this issue may be anyone's.
  const holds = sweepableHolds([
    { kind: "ceiling-escalated", payload: { worker: "w1", issue: 7 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "ceiling-escalated", via: "issue-closed" } },
  ]);
  assert.equal(holds.size, 0);
});

test("sweepableHolds: drive-needs-human is sweepable on labeled:1 and NOT on labeled:0 — proof is per-payload", () => {
  const proven = sweepableHolds([
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 12, labeled: 1 } },
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "drive-needs-human", via: "merged" } },
  ]);
  assert.equal(proven.size, 1);
  const unproven = sweepableHolds([
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 12, labeled: 0 } },
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "drive-needs-human", via: "merged" } },
  ]);
  assert.equal(unproven.size, 0);
});

test("sweepableHolds: the LATEST escalation's proof wins — a labeled:0 re-escalation cannot inherit an earlier proof", () => {
  const holds = sweepableHolds([
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 12, labeled: 1 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "drive-needs-human", via: "merged", pr: 12 } },
    { kind: SWEPT_KIND, payload: { issue: 7, source: "drive-needs-human", via: "merged" } },
    { kind: "drive-needs-human", payload: { worker: "w1", issue: 7, pr: 13, labeled: 0 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "drive-needs-human", via: "merged", pr: 13 } },
  ]);
  assert.equal(holds.size, 0);
});

test("sweepableHolds: a resolution with NO escalation event in the ledger proves nothing (truncated history fails closed)", () => {
  const holds = sweepableHolds([{ kind: "escalation-resolved", payload: { issue: 7, source: "fix-rounds-capped", via: "merged" } }]);
  assert.equal(holds.size, 0);
});

test("sweepableHolds: a via:'label-removed' resolution sweeps nothing — that resolution IS the observation the label is gone", () => {
  const holds = sweepableHolds([
    { kind: "resume-capped", payload: { worker: "w1", issue: 7 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "resume-capped", via: "label-removed" } },
  ]);
  assert.equal(holds.size, 0);
});

// ── #441 review round 2 (Codex P1): ownership proof is not permission ────────────────────────
// The label may be provably the engine's AND the escalation may be provably over as a strip row,
// and lifting the hold can still be wrong. Only a witness that represents completion or release
// authorizes the write.

test("sweepableHolds (r2 P1): a via:'pr-closed' resolution is NOT sweepable even with full ownership proof — a closed-unmerged PR still owes a human decision", () => {
  const holds = sweepableHolds([
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } }, // `always`-proven
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "fix-rounds-capped", via: "pr-closed" } },
  ]);
  assert.equal(holds.size, 0, "closing a PR is producer-reachable and reopenable — never a release");
});

test("sweepableHolds (r2 P1): a LEGACY bare via:'closed' row is not sweepable — the ledger cannot say which entity closed, so it fails closed forever", () => {
  const holds = sweepableHolds([
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
    { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "fix-rounds-capped", via: "closed" } },
  ]);
  assert.equal(holds.size, 0, "an upgrade must not replay the P1 against every historical PR closure");
});

test("sweepableHolds (r2 P1): the via allowlist is closed — board-fixed and an unknown future via both sweep nothing", () => {
  for (const via of ["board-fixed", "some-future-arm", ""]) {
    const holds = sweepableHolds([
      { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
      { kind: "escalation-resolved", payload: { issue: 7, pr: 12, source: "fix-rounds-capped", via } },
    ]);
    assert.equal(holds.size, 0, `via ${JSON.stringify(via)} must not authorize a write`);
  }
});

test("sweepableHolds: its own receipt drops the key; a LATER re-escalation + resolution makes it sweepable again", () => {
  const base = [
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "fix-rounds-capped", via: "merged", pr: 12 } },
    { kind: SWEPT_KIND, payload: { issue: 7, source: "fix-rounds-capped", via: "merged" } },
  ];
  assert.equal(sweepableHolds(base).size, 0);
  assert.equal(
    sweepableHolds([
      ...base,
      { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 13 } },
      { kind: "escalation-resolved", payload: { issue: 7, source: "fix-rounds-capped", via: "issue-closed", pr: 13 } },
    ]).size,
    1,
    "a second episode gets its own sweep — the receipt is scoped to the resolution it latched",
  );
});

test("sweepableHolds: a re-escalation with no resolution yet is NOT sweepable — the label is a live hold again", () => {
  const holds = sweepableHolds([
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 12 } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "fix-rounds-capped", via: "merged", pr: 12 } },
    { kind: "fix-rounds-capped", payload: { worker: "w1", issue: 7, pr: 13 } },
  ]);
  assert.equal(holds.size, 0);
});

test("sweepableHolds: a malformed payload (no numeric issue) is skipped, never thrown", () => {
  assert.equal(
    sweepableHolds([
      { kind: "resume-capped", payload: { worker: "w1" } },
      { kind: "resume-capped", payload: null },
    ]).size,
    0,
  );
});

// ── the pass: AC1 ────────────────────────────────────────────────────────────────────────────

test("sweepResolvedHolds (AC1): an engine-applied needs-human is removed when its escalation resolves", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("fix-rounds-capped", { worker: "w1", issue: 7, pr: 12 });
  state.appendEvent("escalation-resolved", { issue: 7, pr: 12, source: "fix-rounds-capped", via: "merged" });
  forge.issueLabels[7] = [NEEDS_HUMAN];

  await sweepResolvedHolds(forge, state, mkCfg());

  assert.deepEqual(forge.removed, [[7, NEEDS_HUMAN]]);
  assert.deepEqual(sweptEvents(state), [{ issue: 7, source: "fix-rounds-capped", via: "merged", label: NEEDS_HUMAN }]);
  state.close();
});

test("sweepResolvedHolds (AC1): a HAND-applied label on an issue with no engine escalation is never touched", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  // The whole ledger for #7 is unrelated engine activity. A human typed the label.
  state.appendEvent("dispatched", { worker: "w1", issue: 7 });
  state.appendEvent("merged", { worker: "w1", issue: 7, pr: 12 });
  forge.issueLabels[7] = [NEEDS_HUMAN];

  await sweepResolvedHolds(forge, state, mkCfg());

  assert.deepEqual(forge.removed, [], "no escalation event = no ownership proof = no write, ever");
  assert.equal(forge.issueLabels[7]?.length, 1);
  assert.deepEqual(sweptEvents(state), []);
  state.close();
});

test("sweepResolvedHolds (AC1): a hand-applied label survives even when a NOT-proven escalation on the same issue resolves", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  // env-failure-preserved applies NO label at all (#168 contract) — anything present is a human's.
  state.appendEvent("env-failure-preserved", { worker: "w1", issue: 7, pr: 12 });
  state.appendEvent("escalation-resolved", { issue: 7, pr: 12, source: "env-failure-preserved", via: "merged" });
  forge.issueLabels[7] = [NEEDS_HUMAN];

  await sweepResolvedHolds(forge, state, mkCfg());

  assert.deepEqual(forge.removed, []);
  state.close();
});

test("sweepResolvedHolds: an issue whose OTHER escalation is still open is left alone entirely", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("fix-rounds-capped", { worker: "w1", issue: 7, pr: 12 });
  state.appendEvent("escalation-resolved", { issue: 7, pr: 12, source: "fix-rounds-capped", via: "merged" });
  state.appendEvent("resume-capped", { worker: "w1", issue: 7 }); // a SECOND, still-open hold
  forge.issueLabels[7] = [NEEDS_HUMAN];

  await sweepResolvedHolds(forge, state, mkCfg());

  assert.deepEqual(forge.removed, [], "one label, two owners — removing it would clear a live hold");

  // Once that one resolves too, the sweep proceeds: ONE removal for the shared carrier, but a
  // receipt each, so a later re-escalation of either source can still earn its own sweep.
  state.appendEvent("escalation-resolved", { issue: 7, source: "resume-capped", via: "issue-closed" });
  await sweepResolvedHolds(forge, state, mkCfg());
  assert.deepEqual(forge.removed, [[7, NEEDS_HUMAN]], "two owners, one label, one write");
  assert.deepEqual(
    sweptEvents(state).map((p) => p.source),
    ["fix-rounds-capped", "resume-capped"],
    "both resolutions latch — neither retries forever",
  );
  state.close();
});

// ── exactly once + the crash windows ─────────────────────────────────────────────────────────

test("sweepResolvedHolds: a steady-state re-sweep writes NOTHING — the receipt is the latch", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("resume-capped", { worker: "w1", issue: 7 });
  state.appendEvent("escalation-resolved", { issue: 7, source: "resume-capped", via: "issue-closed" });

  await sweepResolvedHolds(forge, state, mkCfg());
  await sweepResolvedHolds(forge, state, mkCfg());
  await sweepResolvedHolds(forge, state, mkCfg());

  assert.equal(forge.removed.length, 1);
  assert.equal(sweptEvents(state).length, 1);
  state.close();
});

test("sweepResolvedHolds crash window 1 (resolution appended, process dies BEFORE the removal): the next pass heals it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-sweep-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const before = new State(path);
    before.appendEvent("fix-rounds-capped", { worker: "w1", issue: 7, pr: 12 });
    before.appendEvent("escalation-resolved", { issue: 7, pr: 12, source: "fix-rounds-capped", via: "merged" });
    before.close(); // kill -9 exactly between the evidence and the effect

    const after = new State(path);
    const forge = new FakeForge();
    forge.issueLabels[7] = [NEEDS_HUMAN];
    await sweepResolvedHolds(forge, after, mkCfg());
    assert.deepEqual(forge.removed, [[7, NEEDS_HUMAN]], "the stale hold heals from the unchanged ledger — no F34 wedge");
    assert.equal(sweptEvents(after).length, 1);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepResolvedHolds crash window 2 (removal landed, process dies BEFORE the receipt): the retry is a no-op and latches exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-sweep-latch-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const before = new State(path);
    before.appendEvent("resume-undecidable", { worker: "w1", issue: 7 });
    before.appendEvent("escalation-resolved", { issue: 7, source: "resume-undecidable", via: "issue-closed" });
    const forge = new FakeForge();
    forge.issueLabels[7] = [NEEDS_HUMAN];
    // Simulate the crash: the removal happens, the receipt append does not.
    before.appendEvent = () => {
      throw new Error("kill -9");
    };
    await sweepResolvedHolds(forge, before, mkCfg(), () => {});
    assert.deepEqual(forge.removed, [[7, NEEDS_HUMAN]]);
    before.close();

    const after = new State(path);
    assert.deepEqual(sweptEvents(after), [], "no receipt survived the crash");
    await sweepResolvedHolds(forge, after, mkCfg());
    assert.deepEqual(forge.removed, [
      [7, NEEDS_HUMAN],
      [7, NEEDS_HUMAN],
    ]);
    assert.equal(forge.issueLabels[7]?.length, 0, "the repeated removal is a no-op — removeLabel is idempotent by contract");
    assert.equal(sweptEvents(after).length, 1, "and now it latches, exactly once");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepResolvedHolds: a removeLabel failure writes NO receipt and is retried on the next pass", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.appendEvent("verify-na-proposed", { worker: "w1", issue: 7 });
  state.appendEvent("escalation-resolved", { issue: 7, source: "verify-na-proposed", via: "issue-closed" });
  forge.failRemovalsFor.add(7);
  const logs: string[] = [];

  await sweepResolvedHolds(forge, state, mkCfg(), (m) => logs.push(m));
  assert.deepEqual(sweptEvents(state), []);
  assert.equal(logs.length, 1, "never silent");

  forge.failRemovalsFor.clear();
  await sweepResolvedHolds(forge, state, mkCfg());
  assert.deepEqual(forge.removed, [[7, NEEDS_HUMAN]]);
  assert.equal(sweptEvents(state).length, 1);
  state.close();
});

test("sweepResolvedHolds: an unreadable ledger writes nothing (fail closed)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  state.eventsAfterId = () => {
    throw new Error("db gone");
  };
  const logs: string[] = [];
  await sweepResolvedHolds(forge, state, mkCfg(), (m) => logs.push(m));
  assert.deepEqual(forge.removed, []);
  assert.equal(logs.length, 1);
  state.close();
});

// ── end to end: the F34 shape ────────────────────────────────────────────────────────────────

test("reconcile + sweep in ONE pass (F34): a fix-rounds-capped escalation whose PR was merged loses its label the same pass it resolves", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  // The dogfood shape: the engine capped #403's fix rounds (label proven — the event is appended
  // strictly after its own addLabel returned), a human then landed the work by hand.
  state.appendEvent("fix-rounds-capped", { worker: "w1", issue: 403, pr: 430 });
  forge.issueLabels[403] = [NEEDS_HUMAN];
  forge.prStates[430] = "MERGED";

  await reconcileEscalations(forge, state, cfg);
  await sweepResolvedHolds(forge, state, cfg);

  assert.equal(state.eventsAfterId(0, ["escalation-resolved"]).length, 1);
  assert.deepEqual(forge.removed, [[403, NEEDS_HUMAN]]);
  assert.deepEqual(forge.issueLabels[403], [], "the dead hold is gone — RESUME can no longer read it as a live human hold");

  // And the pair is stable: a second round re-observes nothing and writes nothing.
  await reconcileEscalations(forge, state, cfg);
  await sweepResolvedHolds(forge, state, cfg);
  assert.equal(forge.removed.length, 1);
  assert.equal(state.eventsAfterId(0, ["escalation-resolved"]).length, 1);
  state.close();
});

test("reconcile + sweep (r2 P1, the negative case): an escalation resolved by a CLOSED-unmerged PR keeps its needs-human and writes no receipt", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  // Same ownership proof as the F34 case above — the ONLY difference is how it resolved.
  state.appendEvent("fix-rounds-capped", { worker: "w1", issue: 403, pr: 430 });
  forge.issueLabels[403] = [NEEDS_HUMAN];
  forge.prStates[430] = "CLOSED";

  await reconcileEscalations(forge, state, cfg);
  await sweepResolvedHolds(forge, state, cfg);

  // The strip row still clears — that half is unchanged and is what #295 is for.
  assert.deepEqual(state.eventsAfterId(0, ["escalation-resolved"])[0]?.payload, {
    issue: 403,
    pr: 430,
    source: "fix-rounds-capped",
    via: "pr-closed",
  });
  // But the HOLD stays: a closed-unmerged PR is not a completion witness.
  assert.deepEqual(forge.removed, []);
  assert.deepEqual(forge.issueLabels[403], [NEEDS_HUMAN]);
  assert.deepEqual(sweptEvents(state), []);
  state.close();
});

test("reconcile + sweep (r2 P1, no churn): repeated passes over a CLOSED-PR escalation never remove the label, however many rounds run", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("drive-needs-human", { worker: "w1", issue: 403, pr: 430, labeled: 1 });
  forge.issueLabels[403] = [NEEDS_HUMAN];
  forge.prStates[430] = "CLOSED";

  // The churn loop codex described starts with ONE wrongful removal: label gone -> GATED RECLAIM
  // reads absence as authorization -> reclaims the still-CLOSED PR -> DRIVE re-derives HUMAN ->
  // re-escalates -> swept again ... until gated-reentry-capped latches an unlabelled, invisible
  // lane. Cutting it at the source means the label must survive EVERY pass, not just the first.
  for (let round = 0; round < 5; round++) {
    await reconcileEscalations(forge, state, cfg);
    await sweepResolvedHolds(forge, state, cfg);
    assert.deepEqual(forge.issueLabels[403], [NEEDS_HUMAN], `round ${round}: the human gate still stands`);
  }
  assert.deepEqual(forge.removed, []);
  assert.deepEqual(sweptEvents(state), []);

  // The restriction is about the WITNESS, not a blanket refusal. Reopen the PR, let the lane
  // re-escalate (which is what re-opens the fold entry — a resolved key is not re-observed), and
  // land it for real: the very next pass sweeps.
  forge.prStates[430] = "MERGED";
  state.appendEvent("drive-needs-human", { worker: "w1", issue: 403, pr: 430, labeled: 1 });
  await reconcileEscalations(forge, state, cfg);
  await sweepResolvedHolds(forge, state, cfg);
  assert.deepEqual(forge.removed, [[403, NEEDS_HUMAN]]);
  assert.equal(sweptEvents(state).length, 1);
  state.close();
});

test("sweepableHolds (#404): the ownership fold reads the SAME payload predicate as openEscalations", () => {
  // The ESCALATE branch labelled the issue before its event, so a resolved one is sweepable...
  const proven = sweepableHolds([
    { kind: "reclaim-failed", payload: { worker: "w1", issue: 7, next: "ESCALATE" } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "reclaim-failed", via: "issue-closed" } },
  ]);
  assert.deepEqual([...proven.values()], [{ source: "reclaim-failed", issue: 7, via: "issue-closed" }]);
  // ...while the DRIVING continuation never labelled anything, so it can never own a label to
  // sweep. Both folds go through `attentionProof`, so they cannot disagree about which is which.
  const continuation = sweepableHolds([
    { kind: "reclaim-failed", payload: { worker: "w1", issue: 7, next: "DRIVING" } },
    { kind: "escalation-resolved", payload: { issue: 7, source: "reclaim-failed", via: "issue-closed" } },
  ]);
  assert.equal(continuation.size, 0);
});
