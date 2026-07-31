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
import { extractVerificationPlan, type IForge, type Issue } from "../forge/forge.js";
import { type LabelSpec, labelsInclude } from "../forge/labels.js";
import type { ProxyForge } from "../proxy/mcp-server.js";
import { createProxyMint } from "../proxy/mint.js";
import type { RoundPhase, RoundRow, State } from "../state/state.js";
import { createHeartbeatGate } from "../util/heartbeat.js";
import {
  type CeilingReason,
  engineSessionGapSec,
  escalatePark,
  evaluateCeiling,
  type FixLegResumeDeps,
  type MergeGate,
  probeForgeReachable,
  type Supervisor,
  type TickDeps,
  type TickResult,
  tick,
} from "./conductor.js";
import { pendingDurableConcerns } from "./dissent.js";
import { issuesMergedThisTick, prsOpenedThisTick, type StopConditionHit, type StopConfig } from "./driver.js";
import { emptySpinBreached, parkDurationExceededSec, probeBackoffSec, probeDueWithHint } from "./env-failure.js";
import { buildRoundArtifact, persistRoundArtifact, type RoundArtifact } from "./round-artifact.js";
import { startProgressWatchdog, systemWatchdogTimer } from "./watchdog.js";

export type { RoundPhase, RoundRow } from "../state/state.js";

/** Every RoundPhase except the two the round loop itself owns (`executing` is tick()'s
 *  dispatch-batch-then-drain step, no stub; `closed` is terminal). */
export type PeripheralPhase = Exclude<RoundPhase, "executing" | "closed">;

const SEQUENCE: readonly RoundPhase[] = ["aligning", "architecting", "plan_review", "executing", "harvesting", "retro", "closed"];

/** #374 review (Codex sol-high finding 5, P2): maps round-artifact.ts's fine-grained
 *  degradedPhases phase NAMES (po-align/po-triage/po-pool/architect/plan_review/harvest/retro —
 *  finding 4's fidelity fix) down to the round-phase they belong to, for the empty-spin
 *  breaker's "every phase that ran a session degraded" computation (see isRoundFullyDegraded's
 *  own doc — issue #374's AC requires FULLY degraded, not any single phase). po-align/po-triage/
 *  po-pool all fold into "aligning" — the ONE round-phase slot that bundles all three
 *  sub-sessions (round-defaults.ts's own aligning wrapper). */
const DEGRADED_PHASE_TO_ROUND_PHASE: Readonly<Record<string, PeripheralPhase>> = {
  "po-align": "aligning",
  "po-triage": "aligning",
  "po-pool": "aligning",
  architect: "architecting",
  plan_review: "plan_review",
  harvest: "harvesting",
  retro: "retro",
};

/** #206 (frontend-design.md §11): the round state machine's replay trail — "round R entered
 *  phase P". `rounds.phase` is an in-place UPDATE, so without this event history has no record
 *  that a round was ever *in* a phase, and the dashboard's phase strip (plus §8's spend
 *  phase-bucketing) reconstructs entirely from it. Emitted by whichever process ENTERS the
 *  phase (see the call site), so no crash window can drop a phase the round actually ran.
 *  Appended caller-side, like every other event in this loop: state methods never self-append
 *  (state.ts). */
function appendRoundPhase(state: Pick<State, "appendEvent">, roundId: number, phase: RoundPhase): void {
  state.appendEvent("round-phase", { round_id: roundId, phase });
}

/** #374 review (Codex sol-high finding 5, P2 — align to the AC): issue #374's own acceptance
 *  criterion says "N consecutive FULLY-degraded rounds (every phase session failed)" — the
 *  first cut of the empty-spin breaker fired on ANY single degraded phase (e.g. a retro-only
 *  degrade, unrelated to the other four phases being perfectly fine), a false positive this
 *  function closes. Pure and exported for direct unit testing.
 *
 *  A round counts as fully degraded only when EVERY peripheral phase this round both (a) was
 *  cfg-configured to be capable of running a session ("required", below) AND (b) actually ran
 *  one (`ranPhases`, round.ts's own PeripheralStub.ranSession bookkeeping — see that interface's
 *  doc) shows up in `degradedRoundPhases` (finding 4's fidelity fix feeds that set correctly —
 *  see DEGRADED_PHASE_TO_ROUND_PHASE). "Cfg-configured to be capable" is the coarse, config-only
 *  half of the check:
 *   - aligning: only required when SOME real session could run there at all — po-align
 *     (`roles.po.enabled`) or the opt-in pool-selection session (`roles.po.poolSelection`).
 *     With BOTH off, aligning never spawns any LLM session (round-defaults.ts's own doc: pool
 *     selection is a deterministic engine computation by default) — requiring it would be a
 *     permanent false negative for that deployment shape.
 *   - architecting / plan_review: required whenever the role is enabled at all.
 *   - harvesting: required only when there was actually something to brief — harvest.ts's own
 *     stub skips its session entirely when `artifact.escalations.needsHuman` is empty (its own
 *     doc: "no needs-human issues to brief -> no session"), a fact THIS round's own artifact
 *     already carries precisely.
 *   - retro: required only on retro's own cadence turn (`roundId % everyNRounds === 0`,
 *     retro.ts's own gate) — a thinned-out round genuinely never dispatches a session.
 *
 *  #394 (F23 — closes the pre-#394 "ACCEPTED LIMITATION" this doc used to carry): architecting/
 *  plan_review can ALSO skip their session entirely when there's simply nothing to review this
 *  round (architect.ts's own `candidates.length===0 && poolIssues.length===0` check;
 *  plan-review.ts's own `poolMembers.length===0` check) — a case the coarse cfg-only check above
 *  cannot see (it only knows the ROLE is enabled, not whether THIS round had anything to do).
 *  Before #394 this meant an empty-pool round during a quota storm could NEVER register as fully
 *  degraded: architecting/plan_review stayed in the "required" set (role enabled) but never
 *  joined `degradedRoundPhases` either (no session ran, so nothing degraded), permanently
 *  unsatisfying `every()` — exactly the scenario this breaker exists to catch, structurally
 *  disarmed. The `ranPhases` intersection below closes this: a phase excluded from `ranPhases`
 *  (because its own PeripheralStub reported no `ranSession`) is excluded from the requirement
 *  too, "skipped phases are evidence of nothing." `ranPhases` is round.ts's OWN observation of
 *  what actually happened this round — no new forge read, no speculative machinery, just the
 *  stub's own return value already threaded back.
 *
 *  #394 gate② round 2 (Codex sol-high BLOCK finding, P2 — a crash-RESUME variant of the same
 *  fidelity question, in the OVER-trigger direction): `ranPhases` is a fresh, in-process-only
 *  `Set` built by round.ts's own phase loop THIS run — a round PICKED UP already in-progress
 *  (`deps.state.openRound()` returned non-null: some EARLIER process advanced it and then the
 *  engine restarted, for any reason, not necessarily a crash) never re-enters whatever phases
 *  that earlier process already ran, so they can never be added to `ranPhases` here, REGARDLESS
 *  of whether they genuinely ran and SUCCEEDED before the restart.
 *
 *  This PR's own first cut of this doc claimed that gap was "bounded to one strike, since
 *  `consecutiveDegradedRounds` resets to 0 on every fresh engine start" — that reasoning is
 *  WRONG and has been retracted: the reset only makes the FIRST strike harmless when the
 *  configured threshold is ABOVE 1. `round.emptySpin.consecutiveDegradedRoundsThreshold` is
 *  `z.number().int().positive()` (config.ts) — `1` is a valid, supported value — and at
 *  threshold 1 a single false strike IS the whole breaker: earlier phases succeed, the engine
 *  restarts with the round cursor sitting at `executing`, the (now genuinely empty) board
 *  dispatches zero workers, harvest has nothing to brief, and retro alone degrades on something
 *  wholly unrelated to the LLM/provider — `ranPhases` (this process only ever saw retro) reads
 *  as fully degraded on the FIRST post-restart round, parking a perfectly healthy engine
 *  immediately. The fix is not "bound the count harder" (still rejected: persisting `ranPhases`
 *  itself, or the resume-boundary count, across a restart is new durable state and new
 *  crash-rerun semantics the marginal-complexity principle rules against for a bounded-scope
 *  backstop). It is simpler than that: a round with a resume boundary in its history has
 *  STRUCTURALLY INCOMPLETE evidence for this process's `ranPhases`, independent of how many
 *  strikes have accumulated — so don't judge it at all, the same "under-fire on an ambiguous
 *  signal" doctrine this doc already states for the retro.degraded case just below. `wasResumed`
 *  (this function's 5th argument) is a SINGLE boolean round.ts's own loop already knows for
 *  free — `deps.state.openRound()` returning non-null IS "this round pre-existed before this
 *  process looked at it," no new state, no new read. `true` short-circuits straight to `false`
 *  before any of the required/ran/degraded computation below runs at all.
 *
 *  #374 review (Codex sol-high verify-pass finding 3, P2 — narrows an over-broad false-park
 *  source): `artifact.retro.degraded` (retro.ts's `retro-pr-degraded` event) is DELIBERATELY
 *  never treated as retro-phase degradation here — retro.ts's openProposalPR (the only place
 *  that event fires) runs ONLY after the retro SESSION already returned `outcome === "done"`
 *  with a validated proposal (see retro.ts's own call site: `if (result.outcome === "done") {
 *  ... if (scratch.kind === "proposal") await openProposalPR(...) }`). Its failure modes
 *  (branch-verification miss, openPR throwing) are exclusively POST-session forge/git
 *  infrastructure problems — proof the LLM/provider is fine, the exact opposite of what this
 *  breaker exists to detect. A genuine retro SESSION failure is already captured correctly, via
 *  the `retro-degraded` event (a completely separate emission site, gated on the session's own
 *  outcome/isValid) folding into `artifact.degradedPhases` through the loop just above — that
 *  path is untouched. Counting `retro.degraded` here too would double up on a signal that can
 *  only ever mean "the session succeeded, something else broke", turning an unrelated forge/git
 *  hiccup into a false contributor toward parking the whole engine. The breaker must UNDER-fire
 *  on an ambiguous signal, never over-fire on a well-understood one. */
export function isRoundFullyDegraded(
  cfg: SapwoodConfig,
  artifact: RoundArtifact,
  roundId: number,
  ranPhases: ReadonlySet<PeripheralPhase>,
  wasResumed: boolean,
): boolean {
  // #394 gate② round 2 (Codex sol-high BLOCK finding, P2): a round PICKED UP already in-progress
  // (round.ts's own `deps.state.openRound()` returning non-null) has structurally incomplete
  // `ranPhases` evidence in THIS process — see this function's own doc, the paragraph above,
  // for the reachable at-threshold-1 over-trigger this closes. Short-circuits before any of the
  // required/ran/degraded computation below — a resumed round is simply never judged.
  if (wasResumed) return false;

  const degradedRoundPhases = new Set<PeripheralPhase>();
  for (const d of artifact.degradedPhases) {
    const rp = DEGRADED_PHASE_TO_ROUND_PHASE[d.phase];
    if (rp) degradedRoundPhases.add(rp);
  }

  const requiredPhases: PeripheralPhase[] = [];
  if (cfg.roles.po.enabled || cfg.roles.po.poolSelection) requiredPhases.push("aligning");
  if (cfg.roles.architect.enabled) requiredPhases.push("architecting");
  if (cfg.roles.planReviewer.enabled) requiredPhases.push("plan_review");
  if (cfg.roles.harvest.enabled && artifact.escalations.needsHuman.length > 0) requiredPhases.push("harvesting");
  if (cfg.roles.retro.enabled && roundId % cfg.roles.retro.everyNRounds === 0) requiredPhases.push("retro");

  // #394 (F23): a phase configured (and, per the checks above, expected) to run this round is
  // only genuinely "required" for the breaker if it ACTUALLY ran a session — round.ts's own
  // PeripheralStub.ranSession bookkeeping, threaded in as `ranPhases`. Without this intersection,
  // a phase that structurally short-circuited with NO session at all (architect/plan_review
  // hitting an EMPTY round pool — the exact dogfood scenario this issue fixes: aligning/retro
  // degraded every round, but architect/plan_review/harvest silently skipped, so they never
  // joined degradedRoundPhases either, and requiredPhases.every() stayed false forever) would be
  // wrongly counted as an unfulfilled requirement. "Skipped phases are evidence of nothing" — the
  // breaker must judge only the phases that actually attempted work.
  const ranRequiredPhases = requiredPhases.filter((p) => ranPhases.has(p));

  if (ranRequiredPhases.length === 0) return false; // nothing that could have run actually ran
  return ranRequiredPhases.every((p) => degradedRoundPhases.has(p));
}

/** One externalized-artifact-producing peripheral role session — STUBBED in #86 (the real
 *  role runner/prompts are a follow-up issue). Rerun-not-resume (#77 decision 4): run() is
 *  ALWAYS invoked fresh, never resuming a prior attempt's mid-session state — idempotency is
 *  the stub's OWN job, keyed by `marker`: null on the first attempt for this (round, phase);
 *  non-null when a prior attempt crashed after externalizing something (a comment, a document,
 *  ...) but before the round advanced past this phase. A correct stub must treat a non-null
 *  marker as "already done — do not duplicate that side effect" (it may simply return the same
 *  marker unchanged).
 *
 *  #394 (F23): `ranSession` — did this call actually dispatch at least one real role session,
 *  as opposed to short-circuiting (already-externalized marker, no candidates/pool members, no
 *  needs-human to brief, off-cadence, etc.)? OPTIONAL and defaults to `false` when omitted — the
 *  conservative, "under-trigger on an ambiguous signal" direction this codebase already takes
 *  elsewhere (env-failure.ts's own doc): an unset/false ranSession is read as "no evidence this
 *  phase ran," never as "assume it did." round.ts's own runPeripheral collects this per round
 *  into the `ranPhases` set isRoundFullyDegraded uses to decide which configured phases were
 *  genuinely required THIS round — see that function's own doc for why a bare "was it configured
 *  to run" check silently mis-served the exact scenario the empty-spin breaker exists for. */
export interface PeripheralStub {
  run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }): Promise<{ marker: string; ranSession?: boolean }>;
}

/** The only implementation shipped in #86 — every peripheral phase is a true no-op. Real role
 *  sessions are a follow-up issue (#86's own "out of scope" note). ranSession stays unset/false —
 *  a no-op never runs a real session. */
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
  engineAgentDriveDeps?: TickDeps["engineAgentDriveDeps"];
  now: () => Date;
  /** Injected sleep so tests can drive the loop without real wall-clock waits (same contract
   *  as driver.ts's DriverDeps.sleep). */
  sleep?: (ms: number) => Promise<void>;
  registerSignals?: (requestStop: () => void) => () => void;
  onTick?: (result: TickResult) => void;
  log?: (message: string) => void;
  /** #395: the liveness watchdog's exit hook — same contract as driver.ts's
   *  DriverDeps.watchdogExit (see its own doc). Default: `process.exit`. */
  watchdogExit?: (code: number) => void;
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
  /** #253: pure renderFixPrompt for a FIXABLE gate's fix-loop continuation — worker.ts's
   *  buildRenderFixPrompt(cfg) output, cli.ts's real caller always supplies it (already eagerly
   *  validated at startup, same as renderPrompt/probeLlmReachable above). Paired with
   *  `cfg.proxy.enabled && !cfg.proxy.shadow` — buildFixLegResume below only builds a real
   *  TickDeps.fixLegResume in that exact state (see its own doc for the full three-state
   *  rationale); with `proxy.enabled: false` OR `shadow: true` (the default once enabled) a
   *  FIXABLE gate still degrades to the pre-#246 needs-human escalation exactly as before (#246
   *  C1), unchanged. Omitted -> round.ts's own skeleton tests (which never exercise #246's
   *  FIXABLE path) keep compiling and behaving identically. */
  renderFixPrompt?: (issueNumber: number, pr: number) => string;
}

/** #253: builds this round's TickDeps.fixLegResume — the fix-loop worker leg's
 *  renderFixPrompt+mintProxy pair (conductor.ts's FixLegResumeDeps) — or `undefined` when no
 *  renderFixPrompt was supplied (RoundDeps.renderFixPrompt's own doc) or the proxy isn't in its
 *  PRODUCTION-ATTACH state.
 *
 *  #253 review round 2 (Codex sol-high, H1 — PM-narrowed three-state ruling): `cfg.proxy.shadow`
 *  gates PRODUCTION ATTACHMENT here, not per-consumer effect-suppression (building effect-
 *  suppression into every forge write this fix leg's output could reach — updateIssueBody,
 *  addLabel, commits — would be over-machinery for a transitional validation mode).
 *    1. `enabled: false` (default): this always returns `undefined`. Unchanged.
 *    2. `enabled: true, shadow: true` (the default once enabled): STILL returns `undefined` — NO
 *       fix leg in a live `sapwood run` ever gets a real mint. The machinery stays constructible
 *       (this function, `createProxyMint` directly) for a scoped harness — that's how the
 *       owner's live shadow bring-up (#253 item 2/3) exercises it — but no production session
 *       holds a handle, so no fix leg's forge writes can be proxy-informed. Structural, not a
 *       per-call check.
 *    3. `enabled: true, shadow: false`: the deliberate go-live flip — returns a real, mintable
 *       fixLegResume, exactly as this function did before this ruling.
 *  A FIXABLE gate degrades to the pre-#246 needs-human escalation (#246 C1) in states 1 AND 2.
 *
 *  `forge` is the round's own (possibly milestone/pool-scoped) forge — #234/#244's own doc
 *  establishes the proxy's read surface has no round/pool scoping concept of its own
 *  (RoundScopedForge/PoolScopedForge both plain-passthrough every proxy-tool method), so this is
 *  behaviorally identical to the raw forge either way. `roundId` becomes this mint's fixed audit
 *  identity for every session it mints this round (proxy/mint.test.ts's own journal-identity
 *  contract) — a REAL round id, unlike the tick driver's/RoleRunner-wide default's sentinel ones
 *  (see buildTickFixLegResume's own doc); `phase` is fixed to "executing" — the ONLY phase a fix
 *  leg is ever dispatched from (conductor.ts's DRIVE section, itself only reached from the
 *  executing-phase's own tick() calls). A fix leg's own resume attempt is not separately tracked
 *  here either (always `attempt: 1`, same sentinel-attempt stance as the tick driver) — true
 *  per-attempt identity is live-run territory (#253 item 3), not plumbed in this PR.
 *
 *  Observable guarantee in states 1/2 (#253 review round 2, H4): no handle, no listener, no
 *  bearer token, no journal write, no ProxyForge call, no argv change on any production fix leg.
 *
 *  Exported for direct testing: the full FIXABLE -> startFixLeg -> resume() path needs a
 *  scripted MergeGate + supervisor to exercise end-to-end (round.test.ts's own integration
 *  test), but this construction/gating logic is unit-testable on its own without any of that. */
export function buildFixLegResume(
  deps: Pick<RoundDeps, "cfg" | "state" | "renderFixPrompt" | "now" | "log">,
  forge: ProxyForge,
  roundId: number,
): FixLegResumeDeps | undefined {
  if (!deps.cfg.proxy.enabled || deps.cfg.proxy.shadow || !deps.renderFixPrompt) return undefined;
  return {
    renderFixPrompt: deps.renderFixPrompt,
    mintProxy: createProxyMint({
      cfg: deps.cfg,
      forge,
      state: deps.state,
      roundId,
      phase: "executing",
      now: deps.now,
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    }),
  };
}

export interface RoundsResult {
  /** Rounds fully closed this run. */
  rounds: number;
  ticks: number;
  tickErrors: number;
  /** "kill-switch": a peripheral phase was blocked by an active KILL_SWITCH — the round loop
   *  stops immediately, without running that (or any later) peripheral for the round in
   *  flight. "signal"/"stop-condition": graceful — the round already open always finishes
   *  harvest+retro and closes before the loop stops; only a NEW round is withheld. #395's
   *  liveness watchdog (watchdog.ts) is NOT a `stoppedBy` value here — it runs as an
   *  independent background timer, never cooperatively unwinding this loop; a real stall means
   *  `runRounds` itself never returns (the nonzero exit is the operative signal). */
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
  listIssuesAbsentFromBoard() {
    return this.inner.listIssuesAbsentFromBoard();
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
  ensureRepoLabels(specs: readonly LabelSpec[]) {
    return this.inner.ensureRepoLabels(specs);
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
  getPRChangedFiles(pr: number): ReturnType<IForge["getPRChangedFiles"]> {
    return this.inner.getPRChangedFiles(pr);
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

  /** #214: same milestone scoping as getReadyIssues/getIssuesNeedingPlanReview above — the
   *  round pool's candidate source is a dispatch candidate set too, so a round scoped to one
   *  milestone should only pool-select issues actually in scope for it. */
  async getPoolEligibleIssues(): Promise<Issue[]> {
    const issues = await this.inner.getPoolEligibleIssues();
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

  // #234: plain passthroughs — the forge MCP proxy's read surface has no round/pool scoping
  // concept of its own (a session addresses issues by number, already validated by its own
  // schema/scope enforcement in proxy/tools.ts).
  getIssueMeta(issue: number) {
    return this.inner.getIssueMeta(issue);
  }
  getIssueRelations(issue: number, cap: number) {
    return this.inner.getIssueRelations(issue, cap);
  }
  addSubIssue(parent: number, child: number) {
    return this.inner.addSubIssue(parent, child);
  }
  getSubIssues(parent: number) {
    return this.inner.getSubIssues(parent);
  }
  searchIssues(query: string, cap: number) {
    return this.inner.searchIssues(query, cap);
  }
  // #244: same plain-passthrough stance as the #234 block above — the PR-facing proxy tools
  // have no round/pool scoping concept either (a session addresses a PR by number).
  getPRDetails(pr: number) {
    return this.inner.getPRDetails(pr);
  }
  getPRReviews(pr: number, cap: number) {
    return this.inner.getPRReviews(pr, cap);
  }
  getPRComments(pr: number, cap: number) {
    return this.inner.getPRComments(pr, cap);
  }
  getPRReviewThreads(pr: number, commentsCap: number) {
    return this.inner.getPRReviewThreads(pr, commentsCap);
  }
  getPRChecks(pr: number, cap: number) {
    return this.inner.getPRChecks(pr, cap);
  }
  // #247: same plain-passthrough stance as the #234/#244 blocks above — the fix-loop's
  // thread-reply/resolve writes have no round/pool scoping concept either (the engine already
  // validated the threadId against the journal before calling either method).
  replyToReviewThread(threadId: string, body: string) {
    return this.inner.replyToReviewThread(threadId, body);
  }
  resolveReviewThread(threadId: string) {
    return this.inner.resolveReviewThread(threadId);
  }
  getReviewThreadCommentsTail(threadId: string, cap: number) {
    return this.inner.getReviewThreadCommentsTail(threadId, cap);
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
  listIssuesAbsentFromBoard() {
    return this.inner.listIssuesAbsentFromBoard();
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
  ensureRepoLabels(specs: readonly LabelSpec[]) {
    return this.inner.ensureRepoLabels(specs);
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
  getPRChangedFiles(pr: number): ReturnType<IForge["getPRChangedFiles"]> {
    return this.inner.getPRChangedFiles(pr);
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
  // #214: plain passthrough, deliberately NOT pool-label-filtered — "pool eligible" (this round's
  // CANDIDATE set, #214) is a different concept from "already pool scoped" (this class's own
  // getReadyIssues filter, used ONLY for the executing phase's dispatch). Both align.ts's
  // selection pass and plan-review.ts's gate⓪ scoping need the full eligible set to choose/filter
  // from, same rationale as this class's own doc comment for why getReadyIssues stays unfiltered
  // for those callers too.
  getPoolEligibleIssues() {
    return this.inner.getPoolEligibleIssues();
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

  // #234: plain passthroughs — see RoundScopedForge's identical note above.
  getIssueMeta(issue: number) {
    return this.inner.getIssueMeta(issue);
  }
  getIssueRelations(issue: number, cap: number) {
    return this.inner.getIssueRelations(issue, cap);
  }
  addSubIssue(parent: number, child: number) {
    return this.inner.addSubIssue(parent, child);
  }
  getSubIssues(parent: number) {
    return this.inner.getSubIssues(parent);
  }
  searchIssues(query: string, cap: number) {
    return this.inner.searchIssues(query, cap);
  }
  // #244: plain passthroughs — see RoundScopedForge's identical note above.
  getPRDetails(pr: number) {
    return this.inner.getPRDetails(pr);
  }
  getPRReviews(pr: number, cap: number) {
    return this.inner.getPRReviews(pr, cap);
  }
  getPRComments(pr: number, cap: number) {
    return this.inner.getPRComments(pr, cap);
  }
  getPRReviewThreads(pr: number, commentsCap: number) {
    return this.inner.getPRReviewThreads(pr, commentsCap);
  }
  getPRChecks(pr: number, cap: number) {
    return this.inner.getPRChecks(pr, cap);
  }
  // #247: same plain-passthrough stance as the other #234/#244 read tools above.
  replyToReviewThread(threadId: string, body: string) {
    return this.inner.replyToReviewThread(threadId, body);
  }
  resolveReviewThread(threadId: string) {
    return this.inner.resolveReviewThread(threadId);
  }
  getReviewThreadCommentsTail(threadId: string, cap: number) {
    return this.inner.getReviewThreadCommentsTail(threadId, cap);
  }
}

/** #212 (2026-07-16 AC addendum): `IForge.removeLabel` is a capability this issue introduced, and
 *  label REMOVAL is a governance-significant act — #147's gated reentry reads a human clearing
 *  `needs-human`/`blocked` as the very signal that authorizes reclaiming a lane, and gate⓪ treats
 *  `plan:approved`/`verify:n/a` presence as a human-trusted adjudication. An engine- or
 *  session-driven removal of any of those forges that signature unless the engine can prove it is
 *  removing its OWN mark for a reason a person would recognise.
 *
 *  THE AUTHORIZED ENGINE REMOVAL PATHS — the complete list. `forge.removeLabel` is called from
 *  exactly two places in engine code, each narrowly scoped by a DIFFERENT provenance check, and a
 *  third call site is a defect until it is added here with one of its own:
 *
 *  1. **`removeRoundPoolLabel` (this function) — round-pool label, checked by ROUND OWNERSHIP.**
 *     Fails CLOSED (throws, never removes) for any label other than the engine-owned
 *     `cfg.labels.roundPool`, so a future call site — or a schema field a session could ever
 *     populate — accidentally wired to a different label can never silently slip through. Two
 *     callers today, both engine-only: round close (below) and align.ts's pool-selection
 *     reconcile pass (clears a stray pool label from an open issue outside this round's selected
 *     target, at selection time rather than waiting for close).
 *
 *  2. **`escalation-sweep.ts`'s `sweepResolvedHolds` — `cfg.labels.needsHuman` ONLY, checked by
 *     event-log PROOF plus an authorizing WITNESS** (#441, F34). The `needs-human`-is-human-only
 *     rule this comment used to state absolutely was itself the bug: nothing ever removed the
 *     label on the paths where the ENGINE knows its own escalation is over, so a resolved
 *     escalation kept suppressing automation forever. That path is now permitted, and it is
 *     permitted narrowly, on two independent conditions that must BOTH hold:
 *       - ownership: the escalation kind's entry in `escalation-reconcile.ts`'s
 *         `ESCALATION_SOURCES` proves the ENGINE applied that label (`always`, or `payload` with
 *         `labeled: 1`). A hand-applied label — anything with no engine escalation in the ledger
 *         — has no proof and is never touched, which is exactly the #147 invariant preserved.
 *       - authorization: the resolution's witness is in `SWEEPABLE_VIA` = {merged, issue-closed},
 *         both producer-unreachable (the guard blocks `gh pr merge` and every `gh issue`
 *         lifecycle verb). A `pr-closed` witness is explicitly NOT sufficient — see that
 *         constant's doc.
 *     It does not route through this function on purpose: this one's whole value is that it
 *     rejects every label but `roundPool`, and widening it to a second label with different
 *     provenance rules would destroy that guarantee rather than extend it.
 *
 *  Everything else — `blocked`, `plan:approved`, `verify:n/a`, and `needs-human` outside the
 *  proven-and-authorized case above — remains removable by a human only. */
export async function removeRoundPoolLabel(forge: IForge, cfg: SapwoodConfig, issue: number, label: string): Promise<void> {
  if (!labelsInclude([label], cfg.labels.roundPool)) {
    throw new Error(
      `removeRoundPoolLabel: refusing to remove label "${label}" — this entry point may only ever ` +
        `remove cfg.labels.roundPool ("${cfg.labels.roundPool}"). The only other authorized engine ` +
        `removal is escalation-sweep.ts clearing an engine-applied needs-human whose escalation is ` +
        `provably resolved (#441); every other label (blocked, plan:approved, verify:n/a, ...) is ` +
        `removable by a human only (#147 invariant)`,
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
  const now = deps.now;
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
  // #395: the liveness watchdog — an INDEPENDENT background timer for this call's whole
  // lifetime (every round-phase: aligning/architecting/plan_review/executing/harvesting/retro,
  // not just tick()'s own dispatch/reclaim/drive), stopped in this function's `finally`
  // alongside `unregister()`. Same contract as driver.ts's runDriver — see watchdog.ts's own
  // doc for why this is progress-based, never raced against any single tick() call.
  const watchdog = startProgressWatchdog({
    timer: systemWatchdogTimer,
    windowMs: deps.tickIntervalSec * 1000 * cfg.liveness.watchdogTickMultiplier,
    state: deps.state,
    exit: deps.watchdogExit ?? ((code: number) => process.exit(code)),
    eventPayload: { tickIntervalSec: deps.tickIntervalSec, watchdogTickMultiplier: cfg.liveness.watchdogTickMultiplier },
    // #395 item 2: deps.state is the real State here — every enrichment read is a genuine table
    // read, never a fake.
    enrich: deps.state,
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
  // #395 (gate② round 3): shared by BOTH the standby-backoff wait and the park-recovery wait
  // below (mutually exclusive execution paths — never both live at once, so one cursor is
  // enough). No child process to probe here (isAlive: () => true — see each call site's own
  // comment for exactly what these heartbeats do and do not prove), so only the gate's
  // spam-suppression half is load-bearing: skip the append once something ELSE (a park-probe, a
  // standby-wait, a tick-error, ...) has already proven progress this cadence.
  const loopHeartbeatGate = createHeartbeatGate(deps.state, () => true);
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
  // #374 (F16): the empty-spin breaker's own counter — consecutive CLOSED rounds, in a row,
  // that dispatched nothing AND had at least one peripheral role session degrade. In-memory
  // only, same "restart is a fresh shot" stance as standbyAttempts/lastRoundIdle above — a
  // restart is itself evidence of a human/operator touching the engine, so starting this back
  // at 0 is the accepted, documented scope boundary (never a churn-inducing false reset:
  // env-classified quota storms re-park within one round via item 1's role-session wiring
  // regardless of this counter's value).
  let consecutiveDegradedRounds = 0;

  /** #374 (F16 root cause: "ceilingBreached=true did not stop round churn" / 145 empty rounds in
   *  3.5h): withhold opening a NEW round while the engine is ceiling-breached OR env-parked —
   *  the SAME two safety states that already stop DISPATCH inside tick() (conductor.ts's
   *  ceilingBreached/parkActive gates), now ALSO gating round-opening. ONLY from round 2 onward
   *  — the caller only invokes this when `roundsClosed > 0` — the very FIRST round of a run
   *  always opens unconditionally regardless of any pre-existing park/ceiling state, exactly the
   *  existing #168 contract round.test.ts already pins ("a pre-parked episode's ping probe runs
   *  DURING the round's executing phase" — that round must actually open for its tick() to ever
   *  run). This mirrors standby's own `roundsClosed > 0` gate just above/below, for the same
   *  reason: round 1 gives the PO its decomposition shot / lets a pre-existing park's OWN
   *  tick()-driven probe machinery run at all before this gate could ever have an opinion.
   *
   *  Probes on the identical cadence/primitives conductor.ts's own PARK section uses
   *  (env-failure.ts's probeBackoffSec/probeDueWithHint, conductor.ts's probeForgeReachable/
   *  escalatePark) — never a parallel mechanism, just a second call site for the same one.
   *  Ceiling reasons are re-derived FRESH every wait iteration (evaluateCeiling), never trusted
   *  from a stale stored marker — engineSessionStart's wall-clock bookkeeping is safe to touch
   *  from here too (its own doc: "call once per tick" means roughly this cadence, not an
   *  exclusive tick()-only invariant; multiple forward-only calls never corrupt it).
   *
   *  llm-ping semantics match conductor.ts's canary doctrine EXACTLY (settleCanary's own doc: a
   *  green ping on the cheapest model is NOT itself proof the worker/role's real model/tier has
   *  quota back) — a successful ping here does NOT clear the episode; it only ARMS this round to
   *  open (the round's own peripheral role sessions become the real canary, via item 1's
   *  runSessionWithRetry env-classification wiring: a non-classified attempt clears the episode
   *  for real, a re-classified one simply continues it). Gated the SAME way conductor.ts gates
   *  its own canary: only when no FORGE episode is ALSO open (`state.parkRow("forge") == null`)
   *  — a mixed storm never opens a round that would just fail on forge writes anyway. `forge`
   *  itself IS a genuine recovery signal (conductor.ts's own doc: "the cheap IForge read is a
   *  GENUINE recovery signal") and clears outright on success, same as conductor.ts.
   *
   *  Returns (clear to open) the instant ceiling is clear AND (nothing is parked OR the llm
   *  episode alone just got a green light), or immediately when KILL_SWITCH is active or a
   *  signal arrives — same "let the round open & block normally at its first peripheral phase"
   *  contract the standby loop above already documents for KILL_SWITCH.
   *
   *  #374 review (Codex sol-high finding 2, P1): the llm ping is skipped entirely while
   *  ceiling-breached (same `!ceilingBreached` gate conductor.ts's own llm-probe section uses) —
   *  it is a REAL, PAID API call, and a simultaneous quota park + daily-budget/wall-clock breach
   *  must never keep spending past the hard ceiling just to test recovery. The free forge probe
   *  is unaffected either way (conductor.ts's own stance: an IForge read is a genuine, zero-cost
   *  recovery signal regardless of ceiling state); duration-based escalation is unaffected too.
   *
   *  #374 review (Codex sol-high verify-pass finding 2, P2): this loop's OWN exit condition is
   *  ceiling/park state alone — it has no notion of the run's FINAL stop conditions
   *  (stop.onMilestoneComplete etc, checkFinalMilestone/checkFinalSpend just below). Without a
   *  re-check, a milestone that completes EXTERNALLY while the engine sits parked would never be
   *  noticed: this loop keeps waiting for ceiling/park to clear (which, for a permanently-broken
   *  provider, may be never) instead of recognizing the run is already, independently, done. The
   *  re-check sits right before the wait at the BOTTOM of the loop (not the top) — deliberately:
   *  the common case (nothing parked, no ceiling breach) already returns immediately above without
   *  ever waiting, and the outer caller ALSO runs both checks just before invoking this function
   *  (see its own call site) — re-checking again on that already-clear fast path would be a
   *  redundant network call every round boundary for zero benefit. Placed here, the extra check
   *  only ever fires on an iteration that is actually ABOUT to sit out a wait for recovery — the
   *  exact situation the bug this closes is about. Same re-check every standby wake already
   *  performs (below). Referencing checkFinalSpend/checkFinalMilestone here before their own
   *  `const` declarations further down this closure is safe: this function is only ever CALLED
   *  later (line ~1305, well after both are assigned), so by the time this body actually
   *  executes, both names are long past their TDZ. */
  const waitForDispatchClear = async (): Promise<void> => {
    for (;;) {
      if (signalled || deps.state.isKillSwitchActive()) return;
      const nowDate = now();
      const sessionStart = deps.state.engineSessionStart(nowDate, engineSessionGapSec(deps.tickIntervalSec));
      const ceilingReasons: CeilingReason[] = evaluateCeiling({
        dailySpendUsd: deps.state.dailySpendUsd(nowDate),
        dailyBudgetUsd: cfg.cost.dailyBudgetUsd,
        wallClockElapsedSec: (nowDate.getTime() - sessionStart.getTime()) / 1000,
        maxWallClockSec: cfg.cost.maxWallClockSec,
      });
      if (ceilingReasons.length > 0) deps.state.recordCeilingBreach(ceilingReasons, nowDate);
      else deps.state.clearCeilingBreach();

      let llmGreenLight = false;
      for (const episode of deps.state.parkedSources()) {
        const backoffSec = probeBackoffSec(episode.probeAttempts, cfg.envFailure.probeBackoffBaseSec, cfg.envFailure.probeBackoffMaxSec);
        if (!probeDueWithHint(episode.lastProbeAt, nowDate.getTime(), backoffSec, episode.resetHintAt)) continue;
        if (episode.source === "forge") {
          const ok = await probeForgeReachable(forge);
          deps.state.appendEvent("park-probe", {
            source: "forge",
            success: ok,
            attempts: ok ? episode.probeAttempts : episode.probeAttempts + 1,
          });
          if (ok) {
            deps.state.clearPark("forge");
            deps.state.appendEvent("park-resumed", { source: "forge", enteredAt: episode.enteredAt, via: "round-open-probe" });
          } else {
            deps.state.bumpParkProbe("forge", iso());
          }
        } else if (deps.probeLlmReachable && ceilingReasons.length === 0) {
          // Disabled-consumer rule (doctrine): no wired probe -> untouched, same as
          // conductor.ts's own llm probe section. #374 review (Codex sol-high finding 2, P1):
          // ALSO skip while ceiling-breached, same as conductor.ts's own llm-probe section
          // (`!ceilingBreached`) — the ping is a REAL, PAID API call (~$0.016 measured); a
          // simultaneous quota park + daily-budget/wall-clock breach must never keep burning
          // probe spend past the hard ceiling. The FREE forge probe above is unaffected (no
          // ceiling gate on it, matching conductor.ts: an IForge read is a genuine, free
          // recovery signal regardless of ceiling state). Duration escalation below still fires
          // regardless of ceiling either way.
          const raw = await deps.probeLlmReachable();
          const ok = typeof raw === "boolean" ? raw : raw.ok;
          const detail = typeof raw === "boolean" ? undefined : raw.detail;
          deps.state.appendEvent("park-probe", {
            source: "llm",
            success: ok,
            attempts: ok ? episode.probeAttempts : episode.probeAttempts + 1,
            ...(!ok && detail != null ? { reason: detail } : {}),
          });
          if (ok) {
            // Touch (pace), never bump (grow backoff) — a green ping is a successful probe, not
            // a failure, same "touch on success" contract conductor.ts's own llm branch uses.
            deps.state.touchParkProbe("llm", iso());
            llmGreenLight = true;
          } else {
            deps.state.bumpParkProbe("llm", iso());
          }
        }
      }
      for (const episode of deps.state.parkedSources()) {
        if (
          episode.escalatedAt == null &&
          parkDurationExceededSec(episode.enteredAt, nowDate.getTime(), cfg.envFailure.parkEscalateAfterSec)
        ) {
          await escalatePark(forge, deps.state, cfg, episode, deps.state.parkRow("forge") != null, iso, deps.log);
        }
      }

      const parkClearToOpen = !deps.state.isParked() || (llmGreenLight && deps.state.parkRow("forge") == null);
      if (ceilingReasons.length === 0 && parkClearToOpen) return;

      // #374 review (Codex sol-high verify-pass finding 2, P2): about to actually sit out a wait
      // for ceiling/park to clear — re-check the run's FINAL stop condition first. A hit here
      // means the run is independently done regardless of whether recovery ever comes; return
      // immediately (no sleep) so the caller's own post-call finalStopHit check (see its site)
      // stops the run cleanly instead of looping forever on a park that may never clear.
      checkFinalSpend();
      await checkFinalMilestone();
      if (finalStopHit) return;

      if (signalled) return;
      await interTickWait(deps.tickIntervalSec * 1000);
      if (deps.state.isKillSwitchActive()) return;
      // #395 (gate② round 3): a per-iteration heartbeat — this loop's own probe cadence
      // (envFailure.probeBackoffMaxSec / parkEscalateAfterSec, both up to 1800-3600s default) can
      // leave many consecutive iterations with no probe due and therefore no park-probe event,
      // well past the liveness watchdog's own window. This evidences ONLY that this loop's own
      // interTickWait cycle is still running (bounded by tickIntervalSec each time) — it proves
      // NOTHING about whether the forge/probe calls THIS loop makes will ever complete; it is not
      // a progress proxy for those. loopHeartbeatGate additionally skips the append whenever a
      // real park-probe/standby-wait/etc. already fired this cadence (#395 P2-2).
      loopHeartbeatGate.tick("park-wait-heartbeat", { parked: deps.state.isParked() });
    }
  };

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
   *  #432 (F32) history, recorded so the next reader doesn't retrace it: round 1 of #432 narrowed
   *  the milestone catch-all below with a `needsPlanTriage`-shape filter; round 2 (wrongly)
   *  DELETED the whole block on a claim that the plan-review/plan-triage reads above already
   *  subsumed it. That claim was refuted at gate② review — `selectPlanTriageCandidates` iterates
   *  ProjectV2 board membership (`project.items`), while this catch-all deliberately reads
   *  `listOpenIssues()` (the FULL repo backlog, RoundScopedForge does NOT board-scope it — see its
   *  own doc comment); an off-board milestone issue is real, consumable work the triage read can
   *  never see. The catch-all is restored below AS IT STOOD before #432, with round 3 adding one
   *  narrow, cited exclusion for the ACTUAL F32 shape — see that exclusion's own comment.
   *
   *  An all-empty probe is still not proof of "nothing to do" — the PO can decompose the plan
   *  doc alone — which is why standby additionally requires the idle-round precondition (see
   *  lastRoundIdle). Known ceilings, all WAITING-ON-HUMAN or observation-only work this probe
   *  deliberately does NOT hold rounds open for (the #212 stance: a human-latency window must
   *  never pin the probe true) — each is bounded and self-corrects the next time ANY other
   *  signal legitimately wakes the loop:
   *   - a plan-doc edit made DURING standby is invisible to this pure-API probe — the operator
   *     files an issue (any probe signal) or restarts the run to wake the PO;
   *   - dissent.ts's `scanForAdjudication` (a human REPLYING to an already-posted concern) needs
   *     live forge reads (getIssueMeta/getIssueBody/getIssueComments) per open concern — not a
   *     cheap local fact like `pendingDurableConcerns` above, so it is not probed here; a
   *     still-open concern simply stays unadjudicated in `sapwood status` until the next
   *     legitimate wake re-runs the scan (bounded: a stale dashboard row, never a stuck decision);
   *   - escalation-reconcile.ts's `reconcileEscalations` (recording `escalation-resolved` after a
   *     human removes a hold label) is likewise a live-forge read, not a local fact — a resolved
   *     escalation's attention entry stays stale until the next legitimate wake sweeps it.
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
      // #432 round 4 (Codex P1 finding 2, gate② review 3): a durable dissent CONCERN whose
      // comment-post transiently failed (dissent.ts's postConcernIfNew) is engine-owned pending
      // work — reconcileDurableConcerns' own retry sweep runs every round regardless of
      // roles.po.enabled, so this is consumable no matter what's enabled. Dissent intentionally
      // writes NO labels (module doc, #237 AC3), so no label-driven exemption in the milestone
      // catch-all below could ever represent it; pendingDurableConcerns (dissent.ts) is the
      // SAME pure-local SQLite read reconcileDurableConcerns folds over — cheap, checked here
      // beside pendingRollbacks, before any network call.
      if (pendingDurableConcerns(deps.state).length > 0) return true;
      // #433 (F33): a CARRIED lane is work. Rounds are dispatch windows and lanes cross them by
      // design, but every phase that finishes a lane — reclaim, resume, drive, gated reentry —
      // only ever runs inside a round's own executing tick. So withholding the next round over an
      // empty BACKLOG orphans whatever the last round left in flight: the lane's remaining work is
      // not on the board at all, and no probe below can see it. Local SQLite reads, so they sit
      // with pendingRollbacks above as the cheap signals checked before any network call.
      //
      // Each set is exactly what its consumer can still act on (disabled-consumer rule — an
      // unconsumable signal here would pin the probe true forever and defeat standby):
      //  - activeWorkers(): running/driving/fixing — reclaim/drain/drive continuation, always live.
      //  - handoffWorkers(): resume candidates, ALREADY excluding resume_capped rows (terminal to
      //    the scheduler, never resumed again).
      //  - gatedFailedWorkers(): #147 gated-reentry candidates, already excluding capped/unlabelled
      //    rows — but consumed ONLY by tick()'s GATED RECLAIM phase, which is skipped entirely
      //    without a mergeGate, so this one is gated on the gate being configured.
      if (deps.state.activeWorkers().length > 0) return true;
      if (deps.state.handoffWorkers().length > 0) return true;
      if (deps.mergeGate !== undefined && deps.state.gatedFailedWorkers().length > 0) return true;
      if ((await forge.getReadyIssues()).length > 0) return true;
      // #127 gate② F2: each candidate signal below only counts as work when the role that
      // CONSUMES it is enabled. A plan-review candidate is only ever consumed by the
      // plan-reviewer (gate⓪), a triage candidate only by the PO's aligning pass — with that
      // role disabled (roles.<role>.enabled: false) the candidate can never be consumed, so
      // counting it would pin this probe true forever: standby never engages and every round
      // burns the remaining peripheral sessions doing nothing, indefinitely.
      if (cfg.roles.planReviewer.enabled && (await forge.getIssuesNeedingPlanReview()).length > 0) return true;
      if (cfg.roles.po.enabled && (await forge.getIssuesNeedingPlanTriage()).length > 0) return true;
      // #432 round 4 (Codex P1 finding 1, gate② review 3): the round-pool's OWN candidate set —
      // forge.ts's selectPoolEligibleIssues/isPoolEligible (#214) — is Ready-lane-scoped,
      // hold-excluding (needsHuman/blocked), and excludes the #94 forbidden verifyNa+planApproved
      // mixed state, but is DELIBERATELY body-independent otherwise: a Ready, plan:approved issue
      // whose body/AC became unparseable AFTER approval is still pool-eligible by design (forge.ts
      // ~2256-2289's own doc), because that is EXACTLY the class-2 self-heal shape
      // plan-review.ts's confirmOneIssue (~737-805) repairs once the issue re-enters the pool.
      // Round-pool selection itself runs UNCONDITIONALLY every round regardless of
      // roles.po.enabled (round-defaults.ts ~200), but the REPAIR session is gated on
      // roles.planReviewer.enabled (createPlanReviewStub's own gate) — same disabled-consumer
      // rule as the two lines above. Probe and consumer are now literally the SAME selector, not
      // a label proxy for it — this replaces the round-3 `plan:approved` label exemption below,
      // which over-counted (a valid approved issue demoted off Ready, or the #94 forbidden
      // verifyNa+planApproved state, both pinned the probe true with nothing able to consume
      // them) and under-delivered (the broken-body case it was cited for never needed it — a
      // broken body already fails `planCompleteOrExempt` below and counts on its own).
      if (cfg.roles.planReviewer.enabled && (await forge.getPoolEligibleIssues()).length > 0) return true;
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
        // #397: `planless` is excluded here for the SAME disabled-consumer reason as a human
        // hold — a plan-less fenced issue is invisible to every triage/review/pool predicate
        // (forge.ts's isPlanless), so nothing enabled can consume it either. It used to be
        // covered incidentally because the fence borrowed `needsHuman` (a humanLabels member);
        // spelling it out keeps this probe's behavior byte-for-byte identical under the new name.
        //
        // #391 (F21): a CLAIMED issue (cfg.labels.inProgress) doesn't count either — same "only
        // a consumable signal counts" rule as the human-hold exclusion above, applied to the
        // other way an issue leaves the Ready lane. A claimed issue is off the Ready column, so
        // it is invisible to getReadyIssues/getPoolEligibleIssues/getIssuesNeedingPlanReview, and
        // it has a plan already so triage skips it: no enabled role can consume it. Live claims
        // are harmless to exclude (an occupied lane means the round wasn't idle, and standby
        // needs lastRoundIdle); STALE ones — a lane that died leaving the label behind — are
        // exactly the residue that churned 16 empty rounds on 2026-07-24, pinning this probe true
        // over a backlog with a provably empty pool. Startup's own F20 heal strips the stale
        // label and returns the issue to Ready, at which point it counts again, legitimately.
        //
        // Residual, stated rather than overclaimed: the label is the only claim signal available
        // here (listOpenIssues carries labels, not board status), so an issue whose claim landed
        // as a board write but whose addLabel failed still pins this probe. That direction is the
        // deliberate one — it errs toward opening a round, the same fail-toward-more-work stance
        // this probe's own catch uses.
        //
        // #432 (F32, PM gate⓪ adjudication 2026-07-31, round 4 — round 3's shape narrowed
        // further after gate② review found the label set itself wrong in BOTH directions): a
        // fully-specified issue (plan/AC already drafted, or explicitly plan-exempt) that carries
        // NONE of the two labels below is nothing any enabled role can act on — it is just
        // waiting on a human Ready-promotion, the exact F32 churn (8 such issues in v0.2.1 pinned
        // this probe true for six empty rounds). This is a MINIMAL, label-driven exclusion
        // layered on top of the #212/#397/#391 exclusions above — it does NOT replace the
        // catch-all's own repo-wide `listOpenIssues()` read (board-scoped selectors like
        // selectPlanTriageCandidates iterate ProjectV2 `project.items` only and would miss an
        // off-board milestone issue entirely — the exact gap round 2's deletion opened).
        //
        // "Plan-complete-or-exempt" = extractVerificationPlan(body) != null (forge.ts, the same
        // read isDispatchable/needsPlanTriage share — needsPlanReview does NOT: it is a pure
        // label-only predicate, forge.ts ~2229, so it is not part of this list) OR the issue
        // carries verifyNa (the doc-gate path — no plan is ever expected). An issue in EITHER
        // state is only excluded when it ALSO carries none of:
        //  - cfg.labels.split: a human-fired decompose request. isDecomposeCandidate (decompose.ts)
        //    is exactly `split ∧ ¬decomposed ∧ ¬needsHuman ∧ ¬blocked` — consumed by
        //    runDecompositionPass, called from align.ts's aligning-phase handler (~1486-1490)
        //    INSIDE alignStub.run, which round-defaults.ts gates on `cfg.roles.po.enabled` (the
        //    `deps.cfg.roles.po.enabled ? await alignStub.run(ctx) : ...` branch) — a live
        //    decompose candidate, fully specified or not, must still wake the loop when the PO is
        //    on, or the human's split request stalls in standby indefinitely.
        //  - cfg.labels.decomposed: a fenced parent whose decomposition may still have an
        //    unreconciled LOCAL journal (decompose.ts's `recoveries` set, `runDecompositionPass`)
        //    — the same align.ts call site/gate as `split` above. `needsPlanTriage` explicitly
        //    EXCLUDES `decomposed` (forge.ts), so this recovery work is invisible to the triage
        //    line above by design; excluding it here too would silently strand it in standby.
        //    This probe has no local-journal read of its own (SQLite state, not a forge call), so
        //    — same "residual, stated rather than overclaimed" stance as the claimed-issue
        //    comment above — every decomposed-labelled issue counts, even ones whose journal is
        //    ALREADY fully reconciled: a same-round-idle over-count, never a missed recovery.
        //
        // #432 round 4 (Codex P1 finding 1): `cfg.labels.planApproved` was HERE in round 3 and is
        // now deliberately REMOVED — it was wrong in both directions. Over-counting: a VALID
        // approved issue demoted off Ready back to a non-Ready status (or an issue stuck in the
        // #94 forbidden verifyNa+planApproved mixed state, which every real selector treats as
        // human-cleanup-only) still carries the label, so this probe pinned itself true forever
        // with nothing enabled able to consume either shape — violating this very issue's own
        // acceptance criteria. Under-delivering: the ONE case it was actually cited for — a Ready,
        // approved issue whose body/AC became unparseable — never needed the label at all, since a
        // broken body already fails `planCompleteOrExempt` above and counts on its own. The real
        // gap (Ready + approved + a plan SECTION present but otherwise unparseable, e.g. a
        // malformed checkbox AC list — a shape `extractVerificationPlan` alone can't distinguish
        // from "fine") is now covered by the STATUS-AWARE `getPoolEligibleIssues()` probe line
        // above instead: a single selector shared with the class-2 repair consumer, not a label
        // proxy that can drift from what that selector actually requires (Ready-lane scoping,
        // hold-exclusion, #94-exclusion — none of which a label check alone can express).
        //
        // #432 round 4 (Codex P2 finding 3): `cfg.labels.roundPool` joins the signal set — a
        // stale pool label is an engine-OWNED artifact (align.ts's `reconcilePoolLabels`, on
        // every round-open pool-selection pass, and round.ts's own round-close removal sweep,
        // ~1701) whose retry is unconditional, not role-gated; a milestone issue carrying a stale
        // `roundPool` label the LAST cleanup attempt failed to strip is exactly the kind of
        // engine-owned residue #391's claimed-issue exclusion above already treats as "the round
        // wasn't idle" for — this label just needed the same "still counts" treatment split/
        // decomposed get, so the retry net isn't withheld by an otherwise-fully-specified body.
        // No new prose heuristic: every check above reuses an existing predicate/label-config key
        // (extractVerificationPlan, cfg.labels.verifyNa/split/decomposed/roundPool) already shared
        // with the consumers cited.
        const openIssues = await forge.listOpenIssues();
        return openIssues.some((i) => {
          if (i.milestone !== cfg.round.milestone) return false;
          if (labelsInclude(i.labels, cfg.labels.inProgress)) return false;
          if (cfg.escalation.humanLabels.some((label) => labelsInclude(i.labels, label))) return false;
          if (labelsInclude(i.labels, cfg.labels.planless)) return false;
          const planCompleteOrExempt = extractVerificationPlan(i.body ?? "") != null || labelsInclude(i.labels, cfg.labels.verifyNa);
          const carriesConsumableSignal =
            labelsInclude(i.labels, cfg.labels.split) ||
            labelsInclude(i.labels, cfg.labels.decomposed) ||
            labelsInclude(i.labels, cfg.labels.roundPool);
          if (planCompleteOrExempt && !carriesConsumableSignal) return false;
          return true;
        });
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
    fixLegResume?: FixLegResumeDeps;
  }): TickDeps => ({
    forge: over.forge,
    state: deps.state,
    supervisor: deps.supervisor,
    cfg: deps.cfg,
    tickIntervalSec: deps.tickIntervalSec,
    // exactOptionalPropertyTypes: only include optional keys when actually provided — an
    // explicit `undefined` is not the same as an omitted key under this tsconfig setting.
    ...(deps.mergeGate !== undefined ? { mergeGate: deps.mergeGate } : {}),
    ...(deps.engineAgentDriveDeps !== undefined ? { engineAgentDriveDeps: deps.engineAgentDriveDeps } : {}),
    now: deps.now,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(over.forceDispatchPause !== undefined ? { forceDispatchPause: over.forceDispatchPause } : {}),
    ...(over.roundSpendUsd !== undefined ? { roundSpendUsd: over.roundSpendUsd } : {}),
    ...(over.dispatchCapOverride !== undefined ? { dispatchCapOverride: over.dispatchCapOverride } : {}),
    // #253: this round's fix-loop mint (buildFixLegResume, gated on `cfg.proxy.enabled &&
    // !cfg.proxy.shadow` + RoundDeps.renderFixPrompt) — see runExecuting's own construction site
    // for the roundId/phase audit identity this carries.
    ...(over.fixLegResume !== undefined ? { fixLegResume: over.fixLegResume } : {}),
    // #154 (Codex P1, PR #160): the run-level spend stop must freeze a tick's OWN refill the
    // moment its reclaim phase banks the crossing spend — thunk evaluated inside tick(),
    // post-reclaim (see TickDeps.runSpendStopCrossed). Only wired when the stop is configured.
    ...(deps.stop?.afterSpendUsd !== undefined
      ? { runSpendStopCrossed: () => deps.state.spentUsdAfterId(runSpendAnchorId) >= deps.stop!.afterSpendUsd! }
      : {}),
    // #168: passthrough — see RoundDeps.probeLlmReachable's doc comment.
    ...(deps.probeLlmReachable !== undefined ? { probeLlmReachable: deps.probeLlmReachable } : {}),
  });

  /** Run one peripheral phase's stub, persist its marker, fire the observability hook. `ok`
   *  false (never invoking the stub) when KILL_SWITCH is active — the caller must stop the
   *  whole loop without advancing past this phase; `ranSession` is threaded straight from the
   *  stub's own PeripheralStub.run() return (#394 F23) — see that interface's own doc. */
  const runPeripheral = async (round: RoundRow, phase: PeripheralPhase): Promise<{ ok: boolean; ranSession: boolean }> => {
    if (deps.state.isKillSwitchActive()) return { ok: false, ranSession: false };
    const stub = peripherals[phase] ?? noopPeripheralStub;
    // Rerun-not-resume marker: only the phase we are CURRENTLY sitting in (round.phase ===
    // phase — true both for a fresh phase just advanced into this run, and for a phase we
    // resumed directly into after a crash) carries a meaningful persisted marker. Any other
    // phase in the sequence is being entered fresh this run, so its marker is null regardless
    // of what artifact_ref happens to hold (it belongs to whatever phase set it last).
    const marker = round.phase === phase ? round.artifact_ref : null;
    const { marker: newMarker, ranSession } = await stub.run({ roundId: round.round_id, phase, marker });
    deps.state.setRoundMarker(round.round_id, newMarker, iso());
    deps.onRoundPhase?.(round.round_id, phase);
    return { ok: true, ranSession: ranSession ?? false };
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
    // #253: this round's fix-loop mint, built ONCE per round (not per tick) — roundId is fixed
    // for the round's whole executing phase, so there is no reason to re-derive it on every
    // wave/drain tick below. `undefined` (cfg.proxy.enabled: false, OR shadow: true — the default
    // once enabled, OR no RoundDeps.renderFixPrompt supplied) means TickDeps.fixLegResume stays
    // entirely unset, exactly as before this issue — a FIXABLE gate still degrades to the
    // pre-#246 needs-human escalation (#246 C1), unchanged. See buildFixLegResume's own doc for
    // the three-state shadow-vs-attach ruling (#253 review round 2, H1).
    const fixLegResume = buildFixLegResume(deps, dispatchForge, round.round_id);
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

    /** #379 gate② P1: did THIS round's pool-label reconcile fail totally (align.ts's
     *  runPoolSelection recording `pool-labels-failed`)? Pool membership is read LIVE off GitHub
     *  by PoolScopedForge — never from the selection's return value — and reconcilePoolLabels
     *  throws BEFORE its stale-label removal loop, so a total add-failure leaves any earlier
     *  round's residual pool labels in place. Without this gate those residuals would sail
     *  through the executing filter and dispatch as if this round had selected them: the round
     *  wouldn't park at all, it would dispatch a pool nobody chose. Blocking new waves (the
     *  caller turns this into forceDispatchPause + a zero cap) is the containment; in-flight
     *  lanes still drain and a durable handoff still resumes, same as every other wave block.
     *
     *  Same durable round window and THUNK discipline as dispatchedThisRound above — evaluated
     *  inside tryDispatchWave, never snapshotted before the phase, so a crash-resumed executing
     *  phase reads the same fact a from-scratch run would. Payload round_id is matched
     *  explicitly rather than trusting the id cursor alone. The event itself is the durable
     *  record (it names the round and the attempt count); this gate adds no second one. */
    const poolReconcileFailedThisRound = (): boolean =>
      deps.poolLabel !== undefined &&
      deps.state
        .eventsAfterId(round.start_event_id ?? 0, ["pool-labels-failed"])
        .some((e) => (e.payload as { round_id?: number }).round_id === round.round_id);

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
      // #379 gate② P1: a totally-failed pool-label reconcile blocks every wave this round — see
      // poolReconcileFailedThisRound's own doc for why an empty selection alone doesn't park.
      if (poolReconcileFailedThisRound()) {
        deps.log?.(
          `[sapwood:pool] round ${round.round_id}: pool-label reconcile failed for every write — withholding dispatch this round ` +
            `(any leftover pool label from an earlier round is NOT this round's selection); the next round re-selects`,
        );
        return false;
      }
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
          ...(fixLegResume !== undefined ? { fixLegResume } : {}),
        }),
      );
      if (batchResult) {
        for (const d of batchResult.dispatched) if (d.kind === "dispatched") dispatchedNames.push(d.worker);
        for (const r of batchResult.resumed) {
          if (r.kind === "resumed" && !dispatchedNames.includes(r.worker)) dispatchedNames.push(r.worker);
        }
        // #245 round-2 fix (Codex sol-high review, verifying the A2 finding): a `fixing` lane's
        // own soft-budget handoff lands in `fixingReclaimed`, a SEPARATE array from the ordinary
        // RECLAIM phase's `reclaimed` — checking `reclaimed` alone would miss it and let this
        // loop think it's idle (break) with a fix-leg-origin handoff sitting there needing the
        // NEXT tick's RESUME phase to restore it.
        recoveryBeatPending =
          batchResult.reclaimed.some((r) => r.kind === "handoff") || batchResult.fixingReclaimed.some((r) => r.kind === "handoff");
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
          ...(fixLegResume !== undefined ? { fixLegResume } : {}),
        }),
      );
      if (tickResult) {
        for (const d of tickResult.dispatched) if (d.kind === "dispatched") dispatchedNames.push(d.worker);
        for (const r of tickResult.resumed) {
          if (r.kind === "resumed" && !dispatchedNames.includes(r.worker)) dispatchedNames.push(r.worker);
        }
        // #245 round-2 fix: same fixingReclaimed check as the wave-1 branch above.
        recoveryBeatPending =
          tickResult.reclaimed.some((r) => r.kind === "handoff") || tickResult.fixingReclaimed.some((r) => r.kind === "handoff");
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
      // #394 gate② round 2: `openRound()` returning non-null means this round already existed
      // as in_progress BEFORE this call looked — it was opened by an EARLIER process (or an
      // earlier call to this function) and is being picked up rather than started fresh HERE.
      // Every fresh round this SAME call opens goes through `startRound()` below instead, right
      // after this in_progress-round check fails once its own round properly closes — so this
      // boolean is exactly, and only, "this round's `ranPeripheralPhases` set (below) may be
      // missing evidence for phases an earlier process already ran." See
      // isRoundFullyDegraded's own doc for why this matters.
      const roundWasResumed = round != null;
      if (!round) {
        checkFinalSpend(); // #154: cheapest check first (local read), then the network one
        await checkFinalMilestone();
        if (finalStopHit) {
          return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
        }

        // #374 review (Codex sol-high finding 1, P1): withhold opening a NEW round while
        // ceiling-breached or env-parked (see waitForDispatchClear's own doc) — run BEFORE
        // standby engages below, never after. Ordering matters: standby's own wait loop probes
        // ONLY backlog emptiness (probeHasWork), with no knowledge of park/ceiling state at
        // all — an idle backlog PLUS an open park would previously let standby's loop spin
        // forever waiting for backlog work to appear, never once probing recovery
        // (probeForgeReachable/probeLlmReachable), never reaching duration-based escalation,
        // never honoring a reset-time hint — recovery could then ONLY happen by some Ready work
        // appearing, entirely unrelated to whether the provider/forge ever came back. Running
        // this gate FIRST closes that gap structurally: by the time standby's own loop could
        // possibly run below, ceiling is clear and nothing is parked, so standby's
        // backlog-only probe is asking about a genuinely SAFE-to-dispatch state — the only
        // question left is real backlog emptiness, exactly what it exists to answer. `roundsClosed
        // > 0` ONLY — never gates the very first round of a run (see the doc's own explanation:
        // round 1 always opens unconditionally, matching the pre-existing #168 contract).
        if (roundsClosed > 0) {
          await waitForDispatchClear();
          if (signalled) {
            return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "signal" };
          }
          // #374 review (Codex sol-high verify-pass finding 2, P2): UNCONDITIONALLY refresh the
          // final-stop check here, every time, regardless of which path waitForDispatchClear
          // returned by. Its own internal re-check (see its doc) only fires on an iteration about
          // to actually sit out a wait — deliberately NOT on the fast/already-clear success path
          // (line ~884), so a never-parked run's common case stays cheap (no redundant network
          // call). That means the EXACT iteration where ceiling/park recovery clears — the
          // success path itself — never re-checks internally: a milestone that completed
          // during/around that very recovery probe would otherwise go unnoticed until AFTER a
          // pointless round already opened. Re-running checkFinalSpend/checkFinalMilestone HERE
          // closes that gap for free in every OTHER case: both are no-ops (an early `if
          // (finalStopHit) return` inside each) the instant finalStopHit is already set from
          // inside the loop's own bottom-of-loop check, so this only ever does REAL work in the
          // one case that matters — the recovery-clear iteration, where finalStopHit was never
          // set internally at all.
          checkFinalSpend();
          await checkFinalMilestone();
          if (finalStopHit) {
            return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "stop-condition", stopCondition: finalStopHit };
          }
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
              // #395 (gate② round 3): a per-slice heartbeat, SEPARATE from standby-wait above
              // (which keeps its existing one-per-backoff-step schedule, unchanged) — a single
              // backoff step can legitimately run up to cfg.round.standby.backoffCapSec (default
              // 1800s), well past the liveness watchdog's own window, with standby-wait itself
              // firing only once at the start. This evidences ONLY that this loop's own
              // interTickWait slicing is still running (bounded by tickIntervalSec each time,
              // the SAME cadence the KILL_SWITCH check above already uses — no new cadence
              // introduced) — it proves NOTHING about probeHasWork or any other awaited call
              // ever completing; it is not a progress proxy for those. loopHeartbeatGate
              // additionally skips the append whenever real progress already fired this cadence.
              loopHeartbeatGate.tick("standby-heartbeat", { attempt: standbyAttempts, remainingSec });
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
      // #394 (F23): every peripheral phase THIS round that actually ran a session (not a
      // structural skip) — accumulated as runPeripheral reports back, fed to
      // isRoundFullyDegraded at round close. Fresh per round, same lifetime as workersThisRound/
      // ranExecuting above.
      const ranPeripheralPhases = new Set<PeripheralPhase>();

      while (SEQUENCE[idx] !== "closed") {
        const phase = SEQUENCE[idx]!;
        // On ENTRY, not on transition (#206, gate② P1): the event means "this round entered
        // phase X", so it is emitted by whichever process actually enters it. That closes every
        // crash window at once — a crash after startRound (or after any advanceRoundPhase)
        // leaves the round resumable AT that phase, and the restart re-enters it and says so.
        // The cost is a duplicate whenever a phase is genuinely re-run (rerun-not-resume, #77
        // dec. 4), which the replay fold absorbs as a no-op; the alternative direction — a phase
        // the round entered but the trail never recorded — is unreconstructable.
        appendRoundPhase(deps.state, round.round_id, phase);
        if (phase === "executing") {
          workersThisRound = await runExecuting(round, phase !== startedPhase);
          ranExecuting = true;
        } else if (phase !== "closed") {
          // Narrowed to PeripheralPhase: every RoundPhase except "executing" (handled above)
          // and "closed" (excluded by the while guard — this branch is unreachable at
          // runtime, kept only so TypeScript can see the exhaustive narrowing).
          const result = await runPeripheral(round, phase);
          if (!result.ok) {
            killSwitchStop = true;
            break;
          }
          if (result.ranSession) ranPeripheralPhases.add(phase);
        }
        idx++;
        const nextPhase = SEQUENCE[idx]!;
        deps.state.advanceRoundPhase(round.round_id, nextPhase, iso());
        round = deps.state.getRound(round.round_id)!;
      }

      if (killSwitchStop) {
        return { rounds: roundsClosed, ticks, tickErrors, stoppedBy: "kill-switch" };
      }

      // #212 (gate② P1-3, superseding gate① F2's dispatched-events exemption): clear the pool
      // label from EVERY still-open issue that carries it — no exemption for "dispatched this
      // round." GitHub is the source of truth for pool membership (PoolScopedForge's own doc
      // comment), so this is a live re-read, never a durable pointer, and it sweeps the FULL
      // open backlog (forge.listOpenIssues(), not just getReadyIssues()) so a pool member that
      // moved OFF Ready for ANY reason — this round's own dispatch, a human board action, a
      // milestone edit, gate⓪ revoking plan:approved — still gets cleared. "Persists through
      // dispatch" (the #212 lifecycle) covers only a SAME-ROUND dead-lane requeue (see
      // PoolScopedForge's own doc comment) — a dispatched issue that requeues in some LATER
      // round must re-enter the pool via that round's own selection, never by inheriting a
      // stale label (the exact selection-bypass gate① F2 was meant to close, and gate② review
      // found the F2 fix still hadn't gone far enough: an actually-dispatched-but-still-open
      // issue was the one remaining exempted case). Merged/closed issues are already excluded —
      // listOpenIssues() never returns them. P2-5: the try/catch is PER ISSUE (not wrapped
      // around the whole loop) — one failed removeLabel logs a tick-error and the sweep
      // continues to every remaining issue, rather than a single bad issue aborting the clear
      // for everything after it in iteration order.
      if (deps.poolLabel) {
        let openIssues: Issue[] = [];
        try {
          openIssues = await forge.listOpenIssues();
        } catch (e) {
          tickErrors++;
          try {
            deps.state.appendEvent("tick-error", { error: `round-pool label clear failed (listOpenIssues): ${String(e)}` });
          } catch {
            /* state write failed too — tickErrors still counts it */
          }
        }
        for (const issue of openIssues) {
          if (!labelsInclude(issue.labels, deps.poolLabel)) continue;
          try {
            await removeRoundPoolLabel(forge, cfg, issue.number, deps.poolLabel);
          } catch (e) {
            tickErrors++;
            try {
              deps.state.appendEvent("tick-error", { error: `round-pool label clear failed for #${issue.number}: ${String(e)}` });
            } catch {
              /* state write failed too — tickErrors still counts it */
            }
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
      // #374: captured (not discarded) — the empty-spin breaker below reads this SAME artifact's
      // degradedPhases rather than re-deriving anything, so a round-level "did every peripheral
      // session degrade" signal costs nothing extra to compute.
      let artifact: RoundArtifact | null = null;
      try {
        artifact = buildRoundArtifact(deps.state, round, deps.cfg.cost.roundBudgetUsd, closedAt);
        persistRoundArtifact(deps.state, artifact, closedAt);
      } catch (e) {
        tickErrors++;
        try {
          deps.state.appendEvent("tick-error", { error: `round artifact persistence failed: ${String(e)}` });
        } catch {
          /* state write failed too — tickErrors still counts it */
        }
      }
      // The terminal `closed` — the one phase the loop above never "enters" (the while guard
      // excludes it). BEFORE closeRound, unlike the entry emissions: once the row is `done`, no
      // resume ever revisits this round, so a crash between the two must lose the close (which
      // the resume path redoes) rather than the event (which nothing would).
      appendRoundPhase(deps.state, round.round_id, "closed");
      deps.state.closeRound(round.round_id, closedAt);
      roundsClosed++;
      // #125 idle-round precondition: record whether THIS round dispatched nothing — the gate
      // that lets standby engage at the top of the next iteration (see lastRoundIdle's comment).
      // A resumed round that skipped executing is NOT idle-evidence (see ranExecuting above).
      lastRoundIdle = ranExecuting && workersThisRound === 0;
      // #374 (F16): the empty-spin breaker — independent of error CLASSIFICATION (item 1's
      // env-park wiring may simply not recognize an unfamiliar systemic failure's text). A round
      // that dispatched nothing AND was FULLY degraded (isRoundFullyDegraded's own doc — issue
      // #374's AC: "every phase session failed", not any single one, closing the retro-only
      // false positive) is one strike; N consecutive strikes force the SAME "llm" park episode
      // item 1 already uses, so waitForDispatchClear (above) bounds the churn even when the
      // failure text never matched a known signature. `artifact == null` (its own build/persist
      // THREW, see the try/catch above) counts as NOT degraded — a contained observability
      // failure must never itself trip a safety breaker.
      const roundDegraded =
        ranExecuting &&
        workersThisRound === 0 &&
        artifact != null &&
        isRoundFullyDegraded(cfg, artifact, round.round_id, ranPeripheralPhases, roundWasResumed);
      consecutiveDegradedRounds = roundDegraded ? consecutiveDegradedRounds + 1 : 0;
      if (emptySpinBreached(consecutiveDegradedRounds, cfg.round.emptySpin.consecutiveDegradedRoundsThreshold)) {
        const reason =
          `empty-spin breaker: ${consecutiveDegradedRounds} consecutive rounds with no dispatch and a degraded ` +
          `peripheral session (round ${round.round_id} last) — independent of error classification (#374 F16)`;
        deps.state.enterPark("llm", reason, null, closedAt);
        try {
          deps.state.appendEvent("empty-spin-park", {
            consecutiveDegradedRounds,
            threshold: cfg.round.emptySpin.consecutiveDegradedRoundsThreshold,
            roundId: round.round_id,
          });
        } catch {
          /* best-effort — the park row itself is still the durable record */
        }
        consecutiveDegradedRounds = 0; // episode entered (or already open) — the gate above takes over
      }
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
    watchdog.stop();
  }
}
