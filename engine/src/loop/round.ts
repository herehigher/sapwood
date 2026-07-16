// round.ts — the round-loop skeleton (#86, implementing #77 decisions 1/2/4): layers ABOVE
// the tick engine (conductor.ts's tick()), never rewrites it. A round = dispatch one batch ->
// tick until that batch drains -> peripheral-phase stubs -> close -> (maybe) next round.
//
// This is a STANDALONE loop, not a modification of driver.ts's runDriver: that function has
// 20+ tests validating its flat forever/once/until-idle behavior, and interleaving round-phase
// branching into it would be the highest-risk way to satisfy "existing tests stay green."
// round.ts calls tick() directly (same as runDriver does) and reuses driver.ts's two pure
// stop-condition counters (issuesMergedThisTick/prsOpenedThisTick) and its StopConfig/
// StopConditionHit shapes for the FINAL (whole-run) stop conditions, driven at round
// boundaries instead of every tick.
//
// Peripheral role sessions (aligning/architecting/plan_review/harvesting/retro) are STUBBED
// here — the real role runner + prompts are a follow-up issue (#86's own scope note). Rerun-
// not-resume (#77 decision 4): a crash mid-phase leaves the `rounds` row `in_progress` at that
// exact phase; on restart round.ts resumes AT that phase (never re-running an earlier,
// already-completed one) and re-invokes its stub FRESH — never resuming a prior attempt's
// mid-session state. The stub is handed the row's persisted marker and is contractually
// responsible for treating a non-null marker as "already externalized, don't duplicate."

import type { SapwoodConfig } from "../config/config.js";
import type { IForge, Issue } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { RoundPhase, RoundRow, State } from "../state/state.js";
import { type MergeGate, type Supervisor, type TickDeps, type TickResult, tick } from "./conductor.js";
import { issuesMergedThisTick, prsOpenedThisTick, type StopConditionHit, type StopConfig } from "./driver.js";
import { buildRoundArtifact, persistRoundArtifact } from "./round-artifact.js";

export type { RoundPhase, RoundRow } from "../state/state.js";

/** Every RoundPhase except the two the round loop itself owns (`executing` is tick()'s
 *  dispatch-batch-then-drain step, no stub; `closed` is terminal). */
export type PeripheralPhase = Exclude<RoundPhase, "executing" | "closed">;

const SEQUENCE: readonly RoundPhase[] = ["aligning", "architecting", "plan_review", "executing", "harvesting", "retro", "closed"];

/** One externalized-artifact-producing peripheral role session — STUBBED in #86 (the real
 *  role runner/prompts are a follow-up issue). Rerun-not-resume (#77 decision 4): run() is
 *  ALWAYS invoked fresh, never resuming a prior attempt's mid-session state — idempotency is
 *  the stub's OWN job, keyed by `marker`: null on the first attempt for this (round, phase);
 *  non-null when a prior attempt crashed after externalizing something (a comment, a document,
 *  ...) but before the round advanced past this phase. A correct stub must treat a non-null
 *  marker as "already done — do not duplicate that side effect" (it may simply return the same
 *  marker unchanged). */
export interface PeripheralStub {
  run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }): Promise<{ marker: string }>;
}

/** The only implementation shipped in #86 — every peripheral phase is a true no-op. Real role
 *  sessions are a follow-up issue (#86's own "out of scope" note). */
export const noopPeripheralStub: PeripheralStub = {
  async run({ marker }) {
    return { marker: marker ?? "noop" };
  },
};

/** Which round-level condition ended this round's DISPATCH (never its drain — in-flight lanes
 *  always finish; see runExecuting). OR semantics, first hit wins, mirroring driver.ts's
 *  StopConditionHit for the final conditions. */
export interface RoundStopHit {
  name: "roundBudgetUsd" | "roundDispatchCap" | "milestone";
  detail: string;
}

export interface RoundDeps {
  forge: IForge;
  state: State;
  supervisor: Supervisor;
  cfg: SapwoodConfig;
  /** The round loop's own tick cadence — same role as DriverDeps.tickIntervalSec. */
  tickIntervalSec: number;
  mergeGate?: MergeGate;
  now?: () => Date;
  /** Injected sleep so tests can drive the loop without real wall-clock waits (same contract
   *  as driver.ts's DriverDeps.sleep). */
  sleep?: (ms: number) => Promise<void>;
  registerSignals?: (requestStop: () => void) => () => void;
  onTick?: (result: TickResult) => void;
  log?: (message: string) => void;
  /** Observability/test hook: fired once a peripheral phase's stub has run and its marker has
   *  been persisted (i.e. right before advancing past that phase). */
  onRoundPhase?: (roundId: number, phase: PeripheralPhase) => void;
  /** Observability/test hook: fired the moment a round-level stop condition is first detected. */
  onRoundStop?: (roundId: number, hit: RoundStopHit) => void;
  /** Peripheral stub per phase; unset phases default to noopPeripheralStub. */
  peripherals?: Partial<Record<PeripheralPhase, PeripheralStub>>;
  /** #212: when set, restricts the executing phase's dispatch to Ready issues carrying this
   *  label (round.ts wraps the executing-phase forge in PoolScopedForge, see its own doc
   *  comment) and clears the label from any still-undispatched pool member at round close.
   *  Unset (the default for a bare round.ts caller/test) means no pool scoping at all — today's
   *  behavior, unchanged. A real caller (cli.ts) always passes `cfg.labels.roundPool` so
   *  production dispatch is pool-restricted; round.ts's own skeleton tests opt in explicitly
   *  per-test, the same "unset = passthrough" convention as cfg.round.milestone/RoundScopedForge. */
  poolLabel?: string;
  /** FINAL (whole-run) stop conditions — same shape/semantics as driver.ts's StopConfig,
   *  checked preemptively before opening a NEW round (never mid-round: a round already open
   *  always finishes its remaining phases, including harvest+retro, first). */
  stop?: StopConfig;
  /** #168: threaded straight into every tick's TickDeps.probeLlmReachable (see its doc comment
   *  for the disabled-consumer rationale and the boolean-or-{ok,detail} return shape — omitted
   *  means an llm-sourced park never auto-probes; the duration-based human escalation still
   *  fires regardless). cli.ts wires the real implementation (worker.ts's probeLlmPing) for a
   *  live `sapwood run`; tests inject a fake or leave it unset. */
  probeLlmReachable?: () => Promise<boolean | { ok: boolean; detail?: string }>;
}

export interface RoundsResult {
  /** Rounds fully closed this run. */
  rounds: number;
  ticks: number;
  tickErrors: number;
  /** "kill-switch": a peripheral phase was blocked by an active KILL_SWITCH — the round loop
   *  stops immediately, without running that (or any later) peripheral for the round in
   *  flight. "signal"/"stop-condition": graceful — the round already open always finishes
   *  harvest+retro and closes before the loop stops; only a NEW round is withheld. */
  stoppedBy: "signal" | "stop-condition" | "kill-switch";
  stopCondition?: StopConditionHit;
}

function defaultRegisterSignals(requestStop: () => void): () => void {
  const handler = (): void => requestStop();
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

/** Wraps an IForge so getReadyIssues() only returns issues in the configured round milestone
 *  (#86's "also filters dispatch candidates" half of round.milestone). Every other method
 *  delegates unchanged — explicit passthrough, no Proxy magic. milestone undefined ->
 *  passthrough getReadyIssues() too (today's behavior, no scoping). */
export class RoundScopedForge implements IForge {
  constructor(
    private readonly inner: IForge,
    private readonly milestone: string | undefined,
  ) {}

  async getReadyIssues(): Promise<Issue[]> {
    const issues = await this.inner.getReadyIssues();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }

  listUnplacedIssues() {
    return this.inner.listUnplacedIssues();
  }
  readStartupReconcileData() {
    return this.inner.readStartupReconcileData();
  }

  detectOwnerKind(owner: string) {
    return this.inner.detectOwnerKind(owner);
  }
  claimIssue(issue: number) {
    return this.inner.claimIssue(issue);
  }
  setBoardStatus(issue: number, status: Parameters<IForge["setBoardStatus"]>[1]) {
    return this.inner.setBoardStatus(issue, status);
  }
  addLabel(issue: number, label: string) {
    return this.inner.addLabel(issue, label);
  }
  removeLabel(issue: number, label: string) {
    return this.inner.removeLabel(issue, label);
  }
  addPRLabel(pr: number, label: string) {
    return this.inner.addPRLabel(pr, label);
  }
  openPR(branch: string, title: string, body: string) {
    return this.inner.openPR(branch, title, body);
  }
  getPRStatus(pr: number) {
    return this.inner.getPRStatus(pr);
  }
  mergePR(pr: number, headOid: string) {
    return this.inner.mergePR(pr, headOid);
  }
  addPRComment(pr: number, body: string) {
    return this.inner.addPRComment(pr, body);
  }
  addIssueComment(issue: number, body: string) {
    return this.inner.addIssueComment(issue, body);
  }
  getPRReviewData(pr: number) {
    return this.inner.getPRReviewData(pr);
  }
  getPRDiff(pr: number) {
    return this.inner.getPRDiff(pr);
  }
  getCommitsSince(sinceIso: string) {
    return this.inner.getCommitsSince(sinceIso);
  }
  branchExists(branch: string) {
    return this.inner.branchExists(branch);
  }
  getIssueBody(issue: number) {
    return this.inner.getIssueBody(issue);
  }
  updateIssueBody(issue: number, body: string) {
    return this.inner.updateIssueBody(issue, body);
  }
  countOpenIssuesInMilestone(milestone: string) {
    return this.inner.countOpenIssuesInMilestone(milestone);
  }
  listMilestoneTitles() {
    return this.inner.listMilestoneTitles();
  }
  getIssueLabels(issue: number) {
    return this.inner.getIssueLabels(issue);
  }
  getIssueComments(issue: number) {
    return this.inner.getIssueComments(issue);
  }

  /** Same milestone scoping as getReadyIssues() above — the plan_review peripheral's
   *  candidates are dispatch candidates too (just for review, not for a worker), so this round
   *  should only review issues actually in scope for it. */
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    const issues = await this.inner.getIssuesNeedingPlanReview();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }

  createIssue(title: string, body: string) {
    return this.inner.createIssue(title, body);
  }
  listOpenIssueNumbers() {
    return this.inner.listOpenIssueNumbers();
  }
  listOpenIssues(): Promise<Issue[]> {
    // This is intentionally the full OPEN backlog: PO proposal marker reconciliation and
    // normalized-title dedup must see issues created without a milestone. A reconciled issue
    // CLOSED by a human between crash and rerun remains a known, accepted blind spot because
    // this scan is open-issues-only by design. Digest-only milestone scoping lives in align.ts.
    return this.inner.listOpenIssues();
  }

  /** #89: same milestone scoping as getIssuesNeedingPlanReview above — the PO/triage
   *  peripheral's candidates are dispatch candidates too (just pre-Ready), so a round scoped to
   *  one milestone should only triage issues actually in scope for it. */
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    const issues = await this.inner.getIssuesNeedingPlanTriage();
    return this.milestone ? issues.filter((i) => i.milestone === this.milestone) : issues;
  }
}

/** #212: wraps an IForge so getReadyIssues() only returns issues carrying the round-pool label
 *  — used EXCLUSIVELY for the executing phase's own dispatch-tick calls (see runExecuting
 *  below), never for the peripherals' forge or the standby probe's: an un-pooled Ready issue
 *  must keep counting as probe work (probeHasWork below), and the aligning phase's own
 *  pool-selection pass (align.ts's selectRoundPool) needs the FULL, un-pool-filtered Ready list
 *  to choose from. Same explicit-passthrough shape as RoundScopedForge above (no Proxy magic).
 *  Only constructed when a poolLabel is actually configured (see RoundDeps.poolLabel) — unset
 *  means no pool scoping, today's behavior, unchanged (same "unset = passthrough" convention as
 *  RoundScopedForge's milestone). */
export class PoolScopedForge implements IForge {
  constructor(
    private readonly inner: IForge,
    private readonly poolLabel: string,
  ) {}

  async getReadyIssues(): Promise<Issue[]> {
    const issues = await this.inner.getReadyIssues();
    return issues.filter((i) => labelsInclude(i.labels, this.poolLabel));
  }

  listUnplacedIssues() {
    return this.inner.listUnplacedIssues();
  }
  readStartupReconcileData() {
    return this.inner.readStartupReconcileData();
  }
  detectOwnerKind(owner: string) {
    return this.inner.detectOwnerKind(owner);
  }
  claimIssue(issue: number) {
    return this.inner.claimIssue(issue);
  }
  setBoardStatus(issue: number, status: Parameters<IForge["setBoardStatus"]>[1]) {
    return this.inner.setBoardStatus(issue, status);
  }
  addLabel(issue: number, label: string) {
    return this.inner.addLabel(issue, label);
  }
  removeLabel(issue: number, label: string) {
    return this.inner.removeLabel(issue, label);
  }
  addPRLabel(pr: number, label: string) {
    return this.inner.addPRLabel(pr, label);
  }
  openPR(branch: string, title: string, body: string) {
    return this.inner.openPR(branch, title, body);
  }
  getPRStatus(pr: number) {
    return this.inner.getPRStatus(pr);
  }
  mergePR(pr: number, headOid: string) {
    return this.inner.mergePR(pr, headOid);
  }
  addPRComment(pr: number, body: string) {
    return this.inner.addPRComment(pr, body);
  }
  addIssueComment(issue: number, body: string) {
    return this.inner.addIssueComment(issue, body);
  }
  getPRReviewData(pr: number) {
    return this.inner.getPRReviewData(pr);
  }
  getPRDiff(pr: number) {
    return this.inner.getPRDiff(pr);
  }
  getCommitsSince(sinceIso: string) {
    return this.inner.getCommitsSince(sinceIso);
  }
  branchExists(branch: string) {
    return this.inner.branchExists(branch);
  }
  getIssueBody(issue: number) {
    return this.inner.getIssueBody(issue);
  }
  updateIssueBody(issue: number, body: string) {
    return this.inner.updateIssueBody(issue, body);
  }
  countOpenIssuesInMilestone(milestone: string) {
    return this.inner.countOpenIssuesInMilestone(milestone);
  }
  listMilestoneTitles() {
    return this.inner.listMilestoneTitles();
  }
  getIssueLabels(issue: number) {
    return this.inner.getIssueLabels(issue);
  }
  getIssueComments(issue: number) {
    return this.inner.getIssueComments(issue);
  }
  getIssuesNeedingPlanReview() {
    return this.inner.getIssuesNeedingPlanReview();
  }
  createIssue(title: string, body: string) {
    return this.inner.createIssue(title, body);
  }
  listOpenIssueNumbers() {
    return this.inner.listOpenIssueNumbers();
  }
  listOpenIssues() {
    return this.inner.listOpenIssues();
  }
  getIssuesNeedingPlanTriage() {
    return this.inner.getIssuesNeedingPlanTriage();
  }
}

/** #212 (2026-07-16 AC addendum): `IForge.removeLabel` is a new capability this issue
 *  introduces, and label REMOVAL is otherwise reserved for an explicit human act — #147's gated
 *  reentry reads a human clearing `needs-human`/`blocked` as the very signal that authorizes
 *  reclaiming a lane, and gate⓪ treats `plan:approved`/`verify:n/a` presence as a human-trusted
 *  adjudication. An engine- or session-driven removal of any of those would forge that
 *  signature. This function is the ONE place engine code may call `forge.removeLabel` — it
 *  fails CLOSED (throws, never removes) for any label other than the engine-owned
 *  `cfg.labels.roundPool`, so a future call site (or a schema field a session could ever
 *  populate) accidentally wired to a different label can never silently slip through. Round
 *  close (below) is the only caller today. */
export async function removeRoundPoolLabel(forge: IForge, cfg: SapwoodConfig, issue: number, label: string): Promise<void> {
  if (!labelsInclude([label], cfg.labels.roundPool)) {
    throw new Error(
      `removeRoundPoolLabel: refusing to remove label "${label}" — engine code may only ever remove ` +
        `cfg.labels.roundPool ("${cfg.labels.roundPool}"); every other label (needs-human, blocked, ` +
        `plan:approved, verify:n/a, ...) is removable by a human only (#147 invariant)`,
    );
  }
  await forge.removeLabel(issue, label);
}

/**
 * Run rounds until a stop condition fires. Always attempts at least one round.
 *
 * Outer shape per round: check final `stop.*` preemptively (before opening a NEW round only —
 * never mid-round) -> peripheral phases (aligning/architecting/plan_review) -> `executing`
 * (one dispatch-enabled tick, then drain-only ticks until nothing's in flight) -> peripheral
 * phases (harvesting/retro) -> close. Rerun-not-resume: a round already `in_progress` on
 * startup (state.openRound()) is picked up AT its persisted phase, not restarted from
 * `aligning` — earlier, already-completed phases are never re-run.
 */
export async function runRounds(deps: RoundDeps): Promise<RoundsResult> {
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const cfg = deps.cfg;
  const forge: IForge = cfg.round.milestone ? new RoundScopedForge(deps.forge, cfg.round.milestone) : deps.forge;
  const peripherals = deps.peripherals ?? {};

  let signalled = false;
  let wakeFromSleep: (() => void) | null = null;
  const unregister = (deps.registerSignals ?? defaultRegisterSignals)(() => {
    signalled = true;
    wakeFromSleep?.();
  });
  // Same signal-abortable inter-tick wait as driver.ts's interTickWait — see its comment there
  // for the shutdown-latency rationale this shape closes.
  const interTickWait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        wakeFromSleep = null;
        resolve();
      };
      if (deps.sleep) {
        wakeFromSleep = finish;
        void deps.sleep(ms).then(finish);
      } else {
        const t = setTimeout(finish, ms);
        wakeFromSleep = () => {
          clearTimeout(t);
          finish();
        };
      }
      if (signalled) wakeFromSleep?.();
    });

  let ticks = 0;
  let tickErrors = 0;
  let roundsClosed = 0;
  let issuesMerged = 0;
  let prsOpened = 0;
  // #154: this run's spend-ledger anchor — same in-memory-constant-for-the-process-lifetime
  // contract as driver.ts's runDriver (see its own comment): captured ONCE, here, at engine
  // startup, never re-captured per round. A restart calls runRounds fresh and gets a fresh
  // anchor (afterSpendUsd starts back at $0), unlike cfg.cost.dailyBudgetUsd's cross-restart sum.
  const runSpendAnchorId = deps.state.maxSpendLedgerId();
  let finalStopHit: StopConditionHit | undefined;
  // #125 standby: consecutive empty probes since the last time a round actually opened — the
  // exponential-backoff exponent. In-memory only (never persisted): a process restart is a fresh
  // start at n=0, same as #109's idle throttle carries no state across restarts either.
  let standbyAttempts = 0;
  // #125 idle-round precondition (Codex P1, PR #150 round 2): did the LAST round this run
  // completed dispatch nothing (workersThisRound === 0 — the same signal the #109 throttle
  // keys on)? Standby may only engage after such a round: the probe's three API signals can
  // all be empty while the aligning phase's PO still has real work — decomposing the plan doc
  // (align.ts's align mode reads docs/PLAN.md ALONE) into a first backlog on a fresh/unscoped
  // repo — so the first round of a run ALWAYS opens, giving the PO its decomposition shot; if
  // it drafts issues, the probe sees them (triage/Ready) and rounds continue. Only once a full
  // round came up empty AND the board is still probe-empty does the run sleep. In-memory only,
  // like standbyAttempts: a restart is a fresh shot for the PO (deliberate — the cheapest
  // "wake the PO" lever an operator has).
  let lastRoundIdle = false;

  /** Contained tick() call (same containment stance as driver.ts's runDriver): a thrown tick
   *  is a structured tick-error event, never a crash, never a hot retry loop (callers still
   *  sleep the normal cadence around this). Also updates the FINAL stop-condition counters. */
  const runTick = async (tickDeps: TickDeps): Promise<TickResult | null> => {
    try {
      const result = await tick(tickDeps);
      ticks++;
      deps.onTick?.(result);
      issuesMerged += issuesMergedThisTick(result);
      prsOpened += prsOpenedThisTick(result);
      if (!finalStopHit) {
        const stop = deps.stop;
        if (stop?.afterIssuesMerged !== undefined && issuesMerged >= stop.afterIssuesMerged) {
          finalStopHit = { name: "afterIssuesMerged", threshold: stop.afterIssuesMerged, detail: `merged ${issuesMerged}` };
        } else if (stop?.afterPRsOpened !== undefined && prsOpened >= stop.afterPRsOpened) {
          finalStopHit = { name: "afterPRsOpened", threshold: stop.afterPRsOpened, detail: `opened ${prsOpened}` };
        } else if (
          // #154: same live-query style as driver.ts's runDriver — spend is only known at
          // worker completion, so this reads durable state fresh rather than accumulating a
          // counter from tick results. Gate② B1 (PR #160): threshold IN the guard like every
          // sibling branch — this is the chain tail today, but an inconsistent guard style is
          // exactly how the next appended condition gets silently starved.
          stop?.afterSpendUsd !== undefined &&
          deps.state.spentUsdAfterId(runSpendAnchorId) >= stop.afterSpendUsd
        ) {
          const runSpendUsd = deps.state.spentUsdAfterId(runSpendAnchorId);
          finalStopHit = { name: "afterSpendUsd", threshold: stop.afterSpendUsd, detail: `spent $${runSpendUsd.toFixed(2)}` };
        }
      }
      return result;
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: String(e) });
      } catch {
        /* state write failed too — tickErrors still counts it */
      }
      return null;
    }
  };

  /** #154 (Codex P2, PR #160): re-check the run-spend budget at ROUND boundaries too. The
   *  tick-level check above can't be the only one: closing peripherals (harvest/retro) ledger
   *  their role-session spend via runSessionWithRetry AFTER the executing phase's final tick,
   *  so a budget crossed by that spend would otherwise go unnoticed until the NEXT round's
   *  first tick — after that round already opened and dispatched a fresh wave. Sync SQLite
   *  read, no network; same first-hit-wins contract as every other condition. */
  const checkFinalSpend = (): void => {
    const threshold = deps.stop?.afterSpendUsd;
    if (threshold === undefined || finalStopHit) return;
    const runSpendUsd = deps.state.spentUsdAfterId(runSpendAnchorId);
    if (runSpendUsd >= threshold) {
      finalStopHit = { name: "afterSpendUsd", threshold, detail: `spent $${runSpendUsd.toFixed(2)}` };
    }
  };

  /** #76-style onMilestoneComplete, checked at ROUND boundaries (not every tick) — this run's
   *  FINAL condition, distinct from cfg.round.milestone's per-round scoping. Contained: a
   *  throwing read is a tick-error, never a fired condition, never a crash. */
  const checkFinalMilestone = async (): Promise<void> => {
    const m = deps.stop?.onMilestoneComplete;
    if (!m || finalStopHit) return;
    try {
      const openLeft = await deps.forge.countOpenIssuesInMilestone(m);
      if (openLeft === 0) finalStopHit = { name: "onMilestoneComplete", threshold: m, detail: "0 open issues left" };
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: `stop-condition milestone check failed: ${String(e)}` });
      } catch {
        /* state write failed too — tickErrors still counts it */
      }
    }
  };

  /** #125 standby: cheap pre-round probe (one local SQLite read + pure GitHub API, no LLM) —
   *  true the moment there is ANY signal that a new round would have real work to do. 'Ready empty' alone is NOT "nothing to do": a
   *  plan-review candidate needs gate⓪; a plan-TRIAGE candidate (any open plan-less issue,
   *  regardless of board status — Codex P1 on PR #150: exactly what the aligning phase's PO
   *  triage pass consumes, so skipping it would back off forever over a backlog the PO exists
   *  to draft plans into) needs the PO; and — when `round.milestone` scopes this run — an open
   *  issue still sitting in that milestone (not yet Ready, not yet reviewed) is exactly the PO/
   *  aligning peripheral's job to decompose, so it counts as work too. Unset milestone can't
   *  express a "goals exhausted" signal at all (no scoping to ask about, and the future
   *  goal-file target this parenthetical anticipates — M5 #135 — isn't shipped yet), so it
   *  contributes no vote either way, same "unset = no scoping" stance as RoundScopedForge. Reads
   *  the same (possibly milestone-scoped) `forge` runExecuting/checkFinalMilestone already use.
   *
   *  An all-empty probe is still not proof of "nothing to do" — the PO can decompose the plan
   *  doc alone — which is why standby additionally requires the idle-round precondition (see
   *  lastRoundIdle). Known ceiling: a plan-doc edit made DURING standby is invisible to this
   *  pure-API probe — the operator files an issue (any probe signal) or restarts the run to
   *  wake the PO.
   *
   *  Contained, fail-OPEN to round-opening (gate② on PR #150; same tick-error containment as
   *  checkFinalMilestone above): standby is exactly the long-idle mode where this probe runs
   *  for hours, so a transient GitHub failure (rate limit, network blip) is near-certain
   *  eventually — it must never crash the run OR read as "nothing to do" (an indefinite silent
   *  wait). A throwing probe is a recorded tick-error and counts as "has work": the round opens
   *  and pre-#125 behavior resumes — the peripherals can cope with an occasionally-unnecessary
   *  round, same fail-toward-more-work stance as every other contained read in this module. */
  const probeHasWork = async (): Promise<boolean> => {
    try {
      // Codex P2 (PR #150 round 4): pending rollback rows are retried ONLY inside a tick
      // (conductor.ts), and the failure that created one can be exactly what removed the
      // board's Ready signal (a claimed-but-dead issue is invisible to every API probe below) —
      // so an outstanding row counts as work, or standby would starve the retry indefinitely.
      // Local SQLite read: the cheapest signal, checked first.
      if (deps.state.pendingRollbacks().length > 0) return true;
      if ((await forge.getReadyIssues()).length > 0) return true;
      // #127 gate② F2: each candidate signal below only counts as work when the role that
      // CONSUMES it is enabled. A plan-review candidate is only ever consumed by the
      // plan-reviewer (gate⓪), a triage candidate only by the PO's aligning pass — with that
      // role disabled (roles.<role>.enabled: false) the candidate can never be consumed, so
      // counting it would pin this probe true forever: standby never engages and every round
      // burns the remaining peripheral sessions doing nothing, indefinitely.
      if (cfg.roles.planReviewer.enabled && (await forge.getIssuesNeedingPlanReview()).length > 0) return true;
      if (cfg.roles.po.enabled && (await forge.getIssuesNeedingPlanTriage()).length > 0) return true;
      // #127 gate② R1 (same disabled-consumer rule): the milestone catch-all exists because an
      // open not-yet-Ready issue in the round's milestone is exactly what the PO/aligning pass
      // decomposes (or gate⓪ approves) — with BOTH gate⓪ roles off, nothing enabled can consume
      // that signal either; the only consumable signal left is Ready+dispatchable, already
      // covered by the getReadyIssues check above. Counting it anyway would pin the probe true
      // and defeat standby, the same failure class as the two role-gated signals above.
      if (cfg.round.milestone && (cfg.roles.po.enabled || cfg.roles.planReviewer.enabled)) {
        // Cheapest read first: zero open issues in the milestone settles the question with no
        // further fetch.
        const count = await forge.countOpenIssuesInMilestone(cfg.round.milestone);
        if (count === 0) return false;
        // #212 (documented residual, round.ts:426-427 pre-fix): a milestone holding open issues
        // ALL carrying a human-hold label (cfg.escalation.humanLabels) is not consumable by
        // anything enabled either — a human is already in the loop for every one of them, same
        // "only a consumable signal counts" rule as the two role-gated checks above. Nothing
        // enabled can ever act on a held issue, so it must not pin the probe true forever (a
        // milestone that's gone all-held would otherwise open an empty round after empty round,
        // burning every peripheral session on a backlog nothing can consume). One non-held open
        // issue in the milestone still counts. listOpenIssues() is the full open backlog
        // (RoundScopedForge deliberately does not milestone-scope it — see its own doc comment),
        // so the milestone filter is applied here, matching what countOpenIssuesInMilestone
        // itself counts.
        const openIssues = await forge.listOpenIssues();
        return openIssues.some(
          (i) => i.milestone === cfg.round.milestone && !cfg.escalation.humanLabels.some((label) => labelsInclude(i.labels, label)),
        );
      }
      return false;
    } catch (e) {
      tickErrors++;
      try {
        deps.state.appendEvent("tick-error", { error: `standby probe failed: ${String(e)}` });
      } catch {
        /* state write failed too — tickErrors still counts it */
      }
      return true;
    }
  };

  const toTickDeps = (over: {
    forge: IForge;
    forceDispatchPause?: boolean;
    roundSpendUsd?: () => number;
    dispatchCapOverride?: number;
  }): TickDeps => ({
    forge: over.forge,
    state: deps.state,
    supervisor: deps.supervisor,
    cfg: deps.cfg,
    tickIntervalSec: deps.tickIntervalSec,
    // exactOptionalPropertyTypes: only include optional keys when actually provided — an
    // explicit `undefined` is not the same as an omitted key under this tsconfig setting.
    ...(deps.mergeGate !== undefined ? { mergeGate: deps.mergeGate } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(over.forceDispatchPause !== undefined ? { forceDispatchPause: over.forceDispatchPause } : {}),
    ...(over.roundSpendUsd !== undefined ? { roundSpendUsd: over.roundSpendUsd } : {}),
    ...(over.dispatchCapOverride !== undefined ? { dispatchCapOverride: over.dispatchCapOverride } : {}),
    // #154 (Codex P1, PR #160): the run-level spend stop must freeze a tick's OWN refill the
    // moment its reclaim phase banks the crossing spend — thunk evaluated inside tick(),
    // post-reclaim (see TickDeps.runSpendStopCrossed). Only wired when the stop is configured.
    ...(deps.stop?.afterSpendUsd !== undefined
      ? { runSpendStopCrossed: () => deps.state.spentUsdAfterId(runSpendAnchorId) >= deps.stop!.afterSpendUsd! }
      : {}),
    // #168: passthrough — see RoundDeps.probeLlmReachable's doc comment.
    ...(deps.probeLlmReachable !== undefined ? { probeLlmReachable: deps.probeLlmReachable } : {}),
  });

  /** Run one peripheral phase's stub, persist its marker, fire the observability hook. Returns
   *  false (never invoking the stub) when KILL_SWITCH is active — the caller must stop the
   *  whole loop without advancing past this phase. */
  const runPeripheral = async (round: RoundRow, phase: PeripheralPhase): Promise<boolean> => {
    if (deps.state.isKillSwitchActive()) return false;
    const stub = peripherals[phase] ?? noopPeripheralStub;
    // Rerun-not-resume marker: only the phase we are CURRENTLY sitting in (round.phase ===
    // phase — true both for a fresh phase just advanced into this run, and for a phase we
    // resumed directly into after a crash) carries a meaningful persisted marker. Any other
    // phase in the sequence is being entered fresh this run, so its marker is null regardless
    // of what artifact_ref happens to hold (it belongs to whatever phase set it last).
    const marker = round.phase === phase ? round.artifact_ref : null;
    const { marker: newMarker } = await stub.run({ roundId: round.round_id, phase, marker });
    deps.state.setRoundMarker(round.round_id, newMarker, iso());
    deps.onRoundPhase?.(round.round_id, phase);
    return true;
  };

  /** #95 follow-up: persist a round-stop hit to the durable event log (in addition to firing
   *  the observability hook) the instant it's first detected — so `round-stop` events survive
   *  an engine restart/crash even if nothing ever reads deps.onRoundStop live. Contained: same
   *  fail-toward-more-work stance as the tick-error appendEvent calls above — a write failure
   *  here must never abort the round loop or swallow the stop condition itself. */
  const emitRoundStop = (round: RoundRow, hit: RoundStopHit): void => {
    try {
      deps.state.appendEvent("round-stop", { round_id: round.round_id, name: hit.name, detail: hit.detail });
    } catch {
      /* state write failed — the hit still reaches onRoundStop below */
    }
    deps.onRoundStop?.(round.round_id, hit);
  };

  /** The `executing` phase (#124: multi-wave refill). `lanes.max` bounds CONCURRENCY only
   *  (tick()'s own lanesUsed>=cfg.lanes.max check, unchanged); `roundDispatchCap` is this
   *  round's total work QUOTA, refilled in waves as lanes free — every dispatch-enabled tick
   *  this function issues draws from the SAME quota, not a fresh per-tick allowance (that
   *  cross-tick pooling is exactly what TickDeps.dispatchCapOverride, passed below, is for; see
   *  its own doc comment for the tick-driver divergence this creates).
   *
   *  Quota bookkeeping is DURABLE and crash-safe without any new schema (`dispatchedThisRound`
   *  below): it counts this round's own "dispatched" events (`round.start_event_id` is the
   *  #123 id-cursor already marking where this round's ledger window begins), and tick()
   *  durably appends one such event the instant it dispatches a lane (conductor.ts, right next
   *  to the worker row it creates) — so the count is read fresh from durable state before every
   *  wave decision, never accumulated in an in-memory variable that a crash could lose or
   *  double-count. A crash/restart mid-round resumes at this exact phase with `freshBatch`
   *  false (see below) and therefore never attempts another wave at all — so the only thing
   *  this durability has to guarantee is that a CONTINUING process (no crash) never
   *  over-dispatches past the quota across its own waves, which a fresh durable read on every
   *  wave decision gives for free.
   *
   *  Round spend is the durable spend-ledger window anchored by `round.start_spend_id` at
   *  startRound(), so opening peripherals and settled worker legs share one exact accounting
   *  basis across crash/resume. A missing cursor (only possible for a legacy/injected row)
   *  degrades to the former per-lane sum rather than throwing.
   *
   *  `freshBatch` is false only when we RESUMED directly into `executing` after a crash
   *  mid-drain — re-attempting ANY new wave in that case would risk double-dispatching on top
   *  of lanes already recovering via tick()'s own reclaim logic, so a resumed pass NEVER
   *  dispatches (not even if quota/lanes still have room) — it only drains what's already
   *  there. Returns how many workers this round put in flight (dispatched, or — resumed —
   *  inherited from activeWorkers): the caller's idle-throttle signal (#109 gate② P1, below). */
  // #212: the executing phase's OWN dispatch-scoped forge — restricted to pool-labelled Ready
  // issues when a poolLabel is configured (see RoundDeps.poolLabel's own doc comment). Built
  // ONCE, outside runExecuting, since it wraps the same (possibly milestone-scoped) `forge`
  // instance every dispatch tick this round already uses; unset poolLabel is a plain
  // passthrough (no behavior change at all — same "unset = no scoping" contract as `forge`
  // itself above).
  const dispatchForge: IForge = deps.poolLabel ? new PoolScopedForge(forge, deps.poolLabel) : forge;

  const runExecuting = async (round: RoundRow, freshBatch: boolean): Promise<number> => {
    let stopHit: RoundStopHit | undefined;
    const dispatchedNames: string[] = [];
    const inheritedActiveWorkers = freshBatch ? [] : deps.state.activeWorkers();
    const inheritedActiveCount = inheritedActiveWorkers.length;
    if (round.start_spend_id == null && !freshBatch) {
      for (const worker of inheritedActiveWorkers) dispatchedNames.push(worker.name);
    }
    const spentSoFar = (): number =>
      round.start_spend_id == null
        ? dispatchedNames.reduce((sum, name) => sum + deps.state.spentUsdForWorker(name), 0)
        : deps.state.spentUsdAfterId(round.start_spend_id);

    /** Observability only: tick() owns the dispatch gate. Recording after each tick makes an
     *  opening-peripheral-only crossing visible even when zero lanes were dispatched. */
    const recordBudgetStop = (): void => {
      const spent = spentSoFar();
      if (!stopHit && spent >= cfg.cost.roundBudgetUsd) {
        stopHit = { name: "roundBudgetUsd", detail: `spent $${spent.toFixed(2)}` };
        emitRoundStop(round, stopHit);
      }
    };

    // #124: the durable per-round dispatch count — see this function's own doc comment above.
    const dispatchedThisRound = (): number => deps.state.eventsAfterId(round.start_event_id ?? 0, ["dispatched"]).length;

    // #124: may this call attempt ONE MORE dispatch-enabled tick (a fresh wave)? False forever
    // on a resumed drain (freshBatch); otherwise true until the round-quota or the milestone
    // scope is exhausted, at which point the round-stop hit is recorded (first hit wins) and
    // every later call returns false without re-checking (stopHit itself short-circuits).
    // `lanes.max` needs NO check here — tick()'s own dispatch loop re-reads active lane count
    // AFTER its reclaim phase and caps there; this function only decides whether tick() is
    // ALLOWED to dispatch at all, never how many lanes it may fill.
    const tryDispatchWave = async (): Promise<boolean> => {
      // #154 (Codex P1, PR #160): finalStopHit — a RUN-level stop condition (afterSpendUsd /
      // afterIssuesMerged / afterPRsOpened, set by the per-tick check above) — must freeze new
      // waves in THIS round too, not just withhold the next round. A #124/#154 interaction:
      // pre-#124 all dispatch happened before any condition could fire mid-round, so the gap
      // was unreachable; with multi-wave refill, "graceful wind-down" means in-flight lanes
      // finish but no further wave opens once ANY run-level condition has fired.
      if (!freshBatch || stopHit || finalStopHit) return false;
      const already = dispatchedThisRound();
      if (already >= cfg.lanes.roundDispatchCap) {
        stopHit = { name: "roundDispatchCap", detail: `dispatched ${already}` };
        emitRoundStop(round, stopHit);
        return false;
      }
      if (cfg.round.milestone) {
        try {
          const openLeft = await deps.forge.countOpenIssuesInMilestone(cfg.round.milestone);
          if (openLeft === 0) {
            stopHit = { name: "milestone", detail: "0 open issues left" };
            emitRoundStop(round, stopHit);
            return false;
          }
        } catch {
          /* contained: fail toward dispatching normally, same stance as driver.ts */
        }
      }
      return true;
    };

    // Wave 1: a fresh round always attempts its first dispatch tick IMMEDIATELY (no inter-tick
    // wait) — same zero-latency start as pre-#124's single batch. roundSpendUsd is a THUNK
    // (gate② P1-2 on PR #157): tick() evaluates it AFTER its own reclaim phase, right where
    // overBudget is computed — spentSoFar reads the live durable round ledger window, so both
    // opening-peripheral spend and spend banked by THIS tick's reclaim are visible to THIS
    // tick's dispatch gate. A lane freed by a budget-blowing reclaim is never refilled in the
    // same tick.
    // #172: a resumed `executing` phase may start with no running/driving lane but a durable
    // handoff waiting for RESUME. Give it one recovery tick before judging the round drained.
    // Thereafter only a handoff RECLAIMED by the immediately-previous successful tick arms the
    // next beat; a held/paused handoff that was skipped does not keep a round open forever.
    let recoveryBeatPending = !freshBatch && deps.state.handoffWorkers().length > 0;
    if (freshBatch) {
      const attempt = await tryDispatchWave();
      const remaining = Math.max(0, cfg.lanes.roundDispatchCap - dispatchedThisRound());
      const batchResult = await runTick(
        toTickDeps({
          forge: dispatchForge,
          // A crash-resumed drain forbids NEW dispatch waves, but its handoff lanes still need
          // RESUME. A zero dispatch cap expresses that distinction without PAUSE-blocking resume.
          forceDispatchPause: freshBatch && !attempt,
          roundSpendUsd: () => spentSoFar(),
          dispatchCapOverride: attempt ? remaining : 0,
        }),
      );
      if (batchResult) {
        for (const d of batchResult.dispatched) if (d.kind === "dispatched") dispatchedNames.push(d.worker);
        for (const r of batchResult.resumed) {
          if (r.kind === "resumed" && !dispatchedNames.includes(r.worker)) dispatchedNames.push(r.worker);
        }
        recoveryBeatPending = batchResult.reclaimed.some((r) => r.kind === "handoff");
      }
    }
    recordBudgetStop();

    // Drain + later waves, on cadence, until nothing's left in flight. tick() handles
    // KILL_SWITCH drain-then-escalate entirely internally — no special-casing needed here.
    // Every iteration re-evaluates tryDispatchWave(): tick()'s own RECLAIM phase runs BEFORE
    // its DISPATCH phase, so a lane that frees up on this very tick can be refilled by the SAME
    // call (#124 multi-wave refill) whenever quota + milestone scope still allow it. Never
    // abandoned early by a signal: an already-open round always finishes draining (never kills
    // in-flight work) — only opening a NEW round afterward is withheld.
    for (;;) {
      if (deps.state.activeWorkers().length === 0 && !recoveryBeatPending) break;
      await interTickWait(deps.tickIntervalSec * 1000);
      const attempt = await tryDispatchWave();
      const remaining = Math.max(0, cfg.lanes.roundDispatchCap - dispatchedThisRound());
      const tickResult = await runTick(
        toTickDeps({
          forge: dispatchForge,
          forceDispatchPause: freshBatch && !attempt,
          // Same thunk as wave 1 (gate② P1-2): evaluated inside tick(), post-reclaim, so a
          // same-tick reclaim that crosses cost.roundBudgetUsd blocks the same tick's refill.
          roundSpendUsd: () => spentSoFar(),
          dispatchCapOverride: attempt ? remaining : 0,
        }),
      );
      if (tickResult) {
        for (const d of tickResult.dispatched) if (d.kind === "dispatched") dispatchedNames.push(d.worker);
        for (const r of tickResult.resumed) {
          if (r.kind === "resumed" && !dispatchedNames.includes(r.worker)) dispatchedNames.push(r.worker);
        }
        recoveryBeatPending = tickResult.reclaimed.some((r) => r.kind === "handoff");
      }
      recordBudgetStop();
      if (deps.state.activeWorkers().length === 0 && !recoveryBeatPending) break;
    }
    // stopHit has already been externalized (emitRoundStop) — the caller only needs the
    // in-flight count for the idle throttle.
    return Math.max(inheritedActiveCount, dispatchedNames.length);
  };

  try {
    for (;;) {
      if (signalled) {
        return finalStopHit
          ? { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit }
          : { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "signal" };
      }

      let round = deps.state.openRound();
      if (!round) {
        checkFinalSpend(); // #154: cheapest check first (local read), then the network one
        await checkFinalMilestone();
        if (finalStopHit) {
          return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
        }

        // #125 standby: withhold opening a NEW round while the probe is provably empty, backing
        // off tickIntervalSec * 2^n (capped at round.standby.backoffCapSec) between probes — any
        // hit resets the exponent and opens the round immediately, no extra wait. Guarded by the
        // idle-round precondition (`roundsClosed > 0 && lastRoundIdle`, see lastRoundIdle's own
        // comment): standby only engages after a full round this run already came up empty, so
        // the PO always gets its plan-doc decomposition shot first. KILL_SWITCH
        // bypasses this entirely: a round is always OPENED first and blocked at its very first
        // peripheral phase (runPeripheral's own check) instead, the same contract every other
        // caller of this loop already relies on — standby must never turn that into "loops
        // forever probing instead" for an operator who just wants the freeze to take effect.
        if (cfg.round.standby.enabled && roundsClosed > 0 && lastRoundIdle && !deps.state.isKillSwitchActive()) {
          while (!(await probeHasWork())) {
            if (deps.state.isKillSwitchActive()) break; // let the round open & block normally
            const waitSec = Math.min(deps.tickIntervalSec * 2 ** standbyAttempts, cfg.round.standby.backoffCapSec);
            // Observability-only write, best-effort (Codex P2 round 5, PR #150): this block sits
            // outside the contained tick(), so a transient state-write failure here must degrade
            // to a lost telemetry row, never take down an idle daemon — same stance as
            // checkFinalMilestone's nested catch above.
            try {
              deps.state.appendEvent("standby-wait", { attempt: standbyAttempts, waitSec });
            } catch {
              /* telemetry only — the wait itself proceeds */
            }
            standbyAttempts++;
            // Codex P1 (PR #150 round 3): a backoff wait can be minutes long, and a KILL_SWITCH
            // created mid-sleep must not sit unnoticed until it elapses — kill-switch
            // acknowledgment is a documented safety property, and its check points must never be
            // farther apart than the tick cadence. So wait in tickIntervalSec-sized slices,
            // re-checking the sentinel between slices (one standby-wait event per backoff step
            // above, NOT per slice — the schedule and total wait are unchanged).
            let remainingSec = waitSec;
            while (remainingSec > 0 && !signalled && !deps.state.isKillSwitchActive()) {
              const sliceSec = Math.min(remainingSec, deps.tickIntervalSec);
              await interTickWait(sliceSec * 1000);
              remainingSec -= sliceSec;
            }
            if (deps.state.isKillSwitchActive()) break; // let the round open & block normally
            if (signalled) break;
            // Codex P2 (PR #150): re-check the FINAL stop condition on every standby wake —
            // checkFinalMilestone only ran once, before this block, so a stop.onMilestoneComplete
            // milestone completed EXTERNALLY while the board is otherwise idle (exactly the
            // --milestone scope+stop pairing, PR #149) would otherwise leave this loop probing
            // forever instead of ending the run.
            await checkFinalMilestone();
            if (finalStopHit) {
              return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
            }
          }
          // finalStopHit can't be set here (both checks above already returned if it were) —
          // a signal breaking the wait is always a plain "signal" stop, unlike the loop-top check.
          if (signalled) {
            return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "signal" };
          }
          if (standbyAttempts > 0) {
            try {
              deps.state.appendEvent("standby-exit", { attempts: standbyAttempts });
            } catch {
              /* telemetry only — see the standby-wait catch above */
            }
            standbyAttempts = 0;
          }
        }

        round = deps.state.startRound(iso());
      }

      const startedPhase = round.phase; // captured once — the freshBatch test for `executing`
      let idx = SEQUENCE.indexOf(round.phase);
      let killSwitchStop = false;
      let workersThisRound = 0;
      // #125 (Codex P2 round 6): a round resumed PAST executing (process restart mid-harvest/
      // retro) never calls runExecuting in this process, so workersThisRound === 0 says nothing
      // about idleness — and it must not arm standby, or a restart lands straight back in
      // standby without the fresh PO shot the restart-as-wakeup path documents.
      let ranExecuting = false;

      while (SEQUENCE[idx] !== "closed") {
        const phase = SEQUENCE[idx]!;
        if (phase === "executing") {
          workersThisRound = await runExecuting(round, phase !== startedPhase);
          ranExecuting = true;
        } else if (phase !== "closed") {
          // Narrowed to PeripheralPhase: every RoundPhase except "executing" (handled above)
          // and "closed" (excluded by the while guard — this branch is unreachable at
          // runtime, kept only so TypeScript can see the exhaustive narrowing).
          const ok = await runPeripheral(round, phase);
          if (!ok) {
            killSwitchStop = true;
            break;
          }
        }
        idx++;
        const nextPhase = SEQUENCE[idx]!;
        deps.state.advanceRoundPhase(round.round_id, nextPhase, iso());
        round = deps.state.getRound(round.round_id)!;
      }

      if (killSwitchStop) {
        return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "kill-switch" };
      }

      // #212: release any still-undispatched pool member back to plain Ready — GitHub is the
      // source of truth for pool membership (PoolScopedForge's own doc comment), so this is a
      // live re-read of Ready + the pool label, never a durable pointer. A pool member that WAS
      // dispatched this round already left the Ready lane (claimIssue), so it simply doesn't
      // show up here — its label persists untouched, exactly the lifecycle #212 specifies.
      // Contained: same fail-toward-closing-the-round stance as the artifact persistence below —
      // a forge failure here degrades to a tick-error, never blocks the round from closing (a
      // stray label is a cosmetic residual, not a correctness hazard: the next round's selection
      // simply treats an already-labelled issue as already-idempotently-labelled).
      if (deps.poolLabel) {
        try {
          const stillReady = await forge.getReadyIssues();
          for (const issue of stillReady) {
            if (labelsInclude(issue.labels, deps.poolLabel)) {
              await removeRoundPoolLabel(forge, cfg, issue.number, deps.poolLabel);
            }
          }
        } catch (e) {
          tickErrors++;
          try {
            deps.state.appendEvent("tick-error", { error: `round-pool label clear failed: ${String(e)}` });
          } catch {
            /* state write failed too — tickErrors still counts it */
          }
        }
      }

      const closedAt = iso();
      // #123: the FINAL round summary artifact — assembled from the round's own ledger window
      // and persisted (DB row = source of truth; the markdown view is derived from it inside
      // persistRoundArtifact). Persisted BEFORE closeRound (Codex P2, PR #152): a process kill
      // between the two would otherwise leave a status='done' round that openRound never
      // revisits — the artifact would be lost forever. This order fails toward a RESUMABLE
      // round instead: crash after persist -> the round is still in_progress, the resume path
      // re-runs the (marker-idempotent) close and the upsert overwrites with the same window.
      // Contained: an assembly/validation/persistence BUG still degrades to a durable
      // tick-error and the round still closes — the artifact is best-effort, the close is not.
      try {
        persistRoundArtifact(deps.state, buildRoundArtifact(deps.state, round, deps.cfg.cost.roundBudgetUsd, closedAt), closedAt);
      } catch (e) {
        tickErrors++;
        try {
          deps.state.appendEvent("tick-error", { error: `round artifact persistence failed: ${String(e)}` });
        } catch {
          /* state write failed too — tickErrors still counts it */
        }
      }
      deps.state.closeRound(round.round_id, closedAt);
      roundsClosed++;
      // #125 idle-round precondition: record whether THIS round dispatched nothing — the gate
      // that lets standby engage at the top of the next iteration (see lastRoundIdle's comment).
      // A resumed round that skipped executing is NOT idle-evidence (see ranExecuting above).
      lastRoundIdle = ranExecuting && workersThisRound === 0;
      // #109 gate② P1 (idle throttle): an IDLE round — zero workers in flight — closing and the
      // next opening back-to-back would run the real peripheral role sessions (PO/architect/
      // plan-review/harvest/retro Claude sessions, the production default since #106)
      // continuously on an empty backlog, burning tokens with no throttle. Wait one tick cadence
      // before opening the next round, via the SAME signal-abortable interTickWait the drain
      // loop uses: a SIGINT during this wait resolves it immediately (never delays shutdown —
      // the loop top's `signalled` check runs right after). A round that dispatched work is NOT
      // additionally throttled: its drain loop already paced it on the tick cadence.
      if (workersThisRound === 0 && !signalled) {
        await interTickWait(deps.tickIntervalSec * 1000);
      }
      // Loop back to the top: re-check signal / final-stop before opening the NEXT round.
    }
  } finally {
    unregister();
  }
}
