// #469 (F32 class): the standby probe's SIGNAL REGISTRY — the declarative half of round.ts's
// `probeHasWork`. Every signal that can hold a round open lives here as one `ProbeSignal` entry,
// and the probe is a loop over this list rather than a hand-written chain of `if (...) return
// true;` branches.
//
// Why a registry rather than the chain it replaces: PR #466 (#432, F32) took five review rounds
// because signals kept being added or narrowed without a stated TERMINAL, and three separate
// findings in its round-4 confirm alone (unfiltered pool superset; unpostable durable concern;
// unremovable roundPool label) were the SAME defect class — a probe signal with no terminal pins
// rounds open forever. That rule was then recorded as a CODE COMMENT at the probe, which stops
// nobody: the next contributor can still add a branch that omits its terminal, and review is the
// only net. Here the rule is carried by the TYPE (`terminal` is required, non-optional) and by
// probe-signals.test.ts's bidirectional inventory (every truth-producing branch is an entry;
// every entry is reachable and individually decisive). Structure-preserving: the entries below
// are in the same order, with the same guards and the same reads, as the chain they came from,
// so probe behavior is byte-identical to pre-refactor.
//
//  DESIGN RULE — every signal admitted to this probe must NAME ITS TERMINAL: the state in which
//  a DETERMINISTIC failure (not just eventual success) stops that signal from counting. A signal
//  that only describes "when there's real work" and never "when a failure to act on it stops
//  mattering" is an F32 generator waiting to be found — it will eventually pin the probe true
//  over some permanently-stuck case its own author didn't enumerate.
//
// The probe itself: cheap (local SQLite reads + pure GitHub API, no LLM), true the moment there
// is ANY signal that a new round would have real work to do. 'Ready empty' alone is NOT "nothing
// to do": a plan-review candidate needs gate⓪; a plan-TRIAGE candidate (any open plan-less issue,
// regardless of board status — Codex P1 on PR #150: exactly what the aligning phase's PO triage
// pass consumes, so skipping it would back off forever over a backlog the PO exists to draft
// plans into) needs the PO; and — when `round.milestone` scopes this run — an open issue still
// sitting in that milestone (not yet Ready, not yet reviewed) is exactly the PO/aligning
// peripheral's job to decompose, so it counts as work too. Unset milestone can't express a
// "goals exhausted" signal at all (no scoping to ask about, and the future goal-file target this
// parenthetical anticipates — M5 #135 — isn't shipped yet), so it contributes no vote either
// way, same "unset = no scoping" stance as RoundScopedForge.
//
// An all-empty probe is still not proof of "nothing to do" — the PO can decompose the plan doc
// alone — which is why standby additionally requires the idle-round precondition (round.ts's
// lastRoundIdle). The known ceilings — WAITING-ON-HUMAN or observation-only work this probe
// deliberately does NOT hold rounds open for (the #212 stance: a human-latency window must never
// pin the probe true) — are no longer prose-only either: each is a registry entry with
// `probe: null`, so the inventory is complete rather than aspirational.
//
// #432 (F32) history, recorded so the next reader doesn't retrace it: round 1 narrowed the
// milestone catch-all with a `needsPlanTriage`-shape filter; round 2 (wrongly) DELETED the whole
// block on a claim that the plan-review/plan-triage reads already subsumed it — refuted at gate②
// review (`selectPlanTriageCandidates` iterates ProjectV2 board membership, while the catch-all
// deliberately reads the FULL repo backlog). Round 3 restored the catch-all and added a
// label-driven exclusion; round 4 replaced part of that exclusion with a `getPoolEligibleIssues()`
// probe line — and that line was ITSELF an F32 generator (round 5). Three separate times, a
// signal added to fix an under-count instead created an over-count.
import type { SapwoodConfig } from "../config/config.js";
import { extractVerificationPlan, type IForge } from "../forge/forge.js";
import { labelsInclude, labelsIncludeAny, labelsIncludeAnySubstring } from "../forge/labels.js";
import type { State } from "../state/state.js";
import { pendingDurableConcerns } from "./dissent.js";

/** Exactly the reads the registry performs — narrow `Pick`s (not the whole `State`/`IForge`) so
 *  the inventory test can drive one signal at a time from a plain object literal, and so adding
 *  a read to a signal is a visible edit here rather than an invisible reach through a fat dep. */
export type ProbeCtx = {
  cfg: SapwoodConfig;
  state: Pick<State, "pendingRollbacks" | "activeWorkers" | "handoffWorkers" | "gatedFailedWorkers" | "eventsAfterId">;
  /** The round's own (possibly milestone-scoped) forge — the same one runExecuting uses. */
  forge: Pick<
    IForge,
    | "getReadyIssues"
    | "getIssuesNeedingPlanReview"
    | "getIssuesNeedingPlanTriage"
    | "getPoolEligibleIssues"
    | "countOpenIssuesInMilestone"
    | "listOpenIssues"
    | "getIssueMeta"
    | "getPRLabels"
  >;
  /** #147 GATED RECLAIM is skipped entirely without a merge gate — presence, not the gate itself. */
  mergeGateConfigured: boolean;
};

/** One probe signal, or one deliberately-unprobed blind spot.
 *
 *  `terminal` is REQUIRED and non-optional on purpose: it is the whole point of this file (see
 *  the module doc's DESIGN RULE). It answers "what deterministic failure state stops this signal
 *  from counting" — never the happy path where the signal's work simply gets consumed.
 *
 *  `probe: null` marks a documented blind spot: work that exists but which this pure-API probe
 *  deliberately does not hold rounds open for. Registered anyway so the inventory is complete —
 *  a reader can see that the case was considered, not forgotten. */
export type ProbeSignal = {
  /** Stable identity: the inventory test's key, AND (#470) the name this signal reports into
   *  the `idle-churn-detected` event when it is the one holding rounds open — so it is a ledger
   *  contract, not just a label. Unique. */
  name: string;
  /** `local`: SQLite only (cheap, checked first). `forge`: a GitHub read. `none`: neither —
   *  the fact isn't observable through any API this probe could call. */
  read: "local" | "forge" | "none";
  /** WHO consumes this signal, and what that consumer is gated on — the disabled-consumer rule:
   *  an unconsumable signal pins the probe true forever and defeats standby. */
  consumer: string;
  /** The state in which a DETERMINISTIC failure stops this signal counting. Required. */
  terminal: string;
  /** The consumer's gate, evaluated BEFORE `probe` — a disabled role must not even issue the
   *  API read (round.test.ts asserts the call never happens, so this is an `&&`, not a
   *  discarded result). Omitted = always consumable. */
  enabled?: (ctx: ProbeCtx) => boolean;
  /** True = this signal alone justifies opening a round. `null` = declared blind spot. */
  probe: ((ctx: ProbeCtx) => boolean | Promise<boolean>) | null;
};

export const PROBE_SIGNALS: readonly ProbeSignal[] = [
  {
    name: "pending-rollbacks",
    read: "local",
    // Codex P2 (PR #150 round 4): pending rollback rows are retried ONLY inside a tick
    // (conductor.ts), and the failure that created one can be exactly what removed the board's
    // Ready signal (a claimed-but-dead issue is invisible to every API probe below) — so an
    // outstanding row counts as work, or standby would starve the retry indefinitely.
    consumer: "conductor.ts tick() rollback retry — unconditional, no role gate",
    terminal:
      "the row is DELETED (state.ts clearPendingRollback) either on a successful board write or once attempts hit the bounded retry cap and the conductor escalates to needs-human instead — a permanently-failing rollback stops counting at the cap, it is not retried forever",
    probe: (ctx) => ctx.state.pendingRollbacks().length > 0,
  },
  {
    name: "pending-durable-concerns",
    read: "local",
    // #432 round 4 (Codex P1 finding 2, gate② review 3): a durable dissent CONCERN whose
    // comment-post transiently failed (dissent.ts's postConcernIfNew) is engine-owned pending
    // work — reconcileDurableConcerns' own retry sweep runs every round regardless of
    // roles.po.enabled, so this is consumable no matter what's enabled. Dissent intentionally
    // writes NO labels (module doc, #237 AC3), so no label-driven exemption in the milestone
    // catch-all below could ever represent it; pendingDurableConcerns (dissent.ts) is the SAME
    // pure-local SQLite read reconcileDurableConcerns folds over — cheap, checked here beside
    // pending-rollbacks, before any network call.
    consumer: "dissent.ts reconcileDurableConcerns retry sweep — unconditional, runs regardless of roles.po.enabled",
    terminal:
      "the concern leaves the pending fold on its receipt (`concern-posted`) OR on `concern-post-escalated` after cfg.roles.po.maxConcernPostAttempts deterministic failures — that escalation event is UNCONDITIONAL (appended even when its own label write fails, #432 round 6), precisely so an issue that is deleted/transferred/inaccessible cannot pin this signal forever",
    probe: (ctx) => pendingDurableConcerns(ctx.state).length > 0,
  },
  // #433 (F33): a CARRIED lane is work. Rounds are dispatch windows and lanes cross them by
  // design, but every phase that finishes a lane — reclaim, resume, drive, gated reentry — only
  // ever runs inside a round's own executing tick. So withholding the next round over an empty
  // BACKLOG orphans whatever the last round left in flight: the lane's remaining work is not on
  // the board at all, and no probe below can see it. Local SQLite reads, so they sit with
  // pending-rollbacks above as the cheap signals checked before any network call. Each set is
  // exactly what its consumer can still act on (disabled-consumer rule).
  {
    name: "active-lanes",
    read: "local",
    consumer: "conductor.ts tick() RECLAIM/DRIVE/FIXING phases — always live, no gate",
    terminal:
      "reclaim SETTLES the row out of running/driving/fixing on every disposition, failure included (dead lane, ceiling drain, ESCALATE_NOPR, gate② needs-human all move it to `failed`/`handoff`) — a lane that cannot make progress leaves this set rather than staying in it",
    probe: (ctx) => ctx.state.activeWorkers().length > 0,
  },
  {
    name: "handoff-resume-candidates",
    read: "local",
    consumer: "conductor.ts resume scheduler — always live, no gate",
    terminal:
      "state.ts handoffWorkers() ALREADY excludes `resume_capped = 1` rows — a one-way latch set once maxResumes is exhausted and the needs-human escalation lands, so a lane that keeps failing to resume stops counting permanently",
    probe: (ctx) => ctx.state.handoffWorkers().length > 0,
  },
  {
    name: "gated-reentry-candidates",
    read: "forge",
    // #637: align.ts's OWN align-creation skip guard (alignCreationHasNothingToDo) dropped
    // gated-reentry from ITS carried-lane set — a gated lane awaiting human release cannot
    // consume anything the skipped align-CREATION session would have produced (#147/#499's
    // gated-reclaim path never reads align output). That is a DIFFERENT question from this
    // signal's own (does GATED RECLAIM below still have work to do), so the two "carried lane"
    // sets are deliberately allowed to diverge from here on — this signal's own semantics below
    // are unchanged and still accurate for ITS consumer.
    consumer: "conductor.ts tick() GATED RECLAIM (#147) — skipped entirely without a merge gate, so gated on deps.mergeGate",
    // #730 gate② P1: TERMINAL parity follows GATED RECLAIM's carrier semantics exactly.
    // conductor.ts:3982 derives `holdSet = carrier === "pr" ? [...humanLabels, ...holdLabels]
    // : humanLabels`; #400's owner-ratified contract is that hold has ONE carrier, the PR. Thus
    // human labels retain their substring semantics on either object, but an exact hold label is
    // terminal only on the PR. An issue-side hold after needs-human is cleared is already
    // consumable by GATED RECLAIM, so excluding it here would strand that work in standby.
    //
    // #630 (F32 follow-through, live park batch-7 round 312): a needs-human carrier OUTSIDE the
    // run's `round.milestone` scope is not work this run can ever consume — the aligning/PO and
    // gate⓪ passes it would wake are all milestone-scoped, and a human release of a candidate the
    // run cannot dispatch into does nothing this run can observe or act on either. Reuses the SAME
    // scope RoundScopedForge already applies to dispatch (round.ts) rather than a new age
    // heuristic or config key — milestone unset stays "no scoping" (RoundScopedForge's own
    // convention), so this signal's behavior is unchanged for every run that doesn't set
    // round.milestone. Gated reclaim's own dispatch/reentry decision (conductor.ts, which already
    // reads getIssueMeta per candidate) is UNTOUCHED: an off-milestone candidate keeps its labels
    // and its human queue entry, it just no longer holds THIS probe's standby open.
    terminal:
      "state.ts gatedFailedWorkers() ALREADY excludes `gated_reentry_capped = 1` (fail-closed one-way latch once reentry attempts are spent) and `gated_escalation_labeled = 0` (a row whose escalation label write failed is permanently invisible here) — neither shape is retried forever. A human-label block on either object, or an exact hold-label block on the PR, is also this signal's terminal: conductor.ts:3982's #400 `holdSet` makes an issue-side hold non-blocking, while those carrier-correct blocks mean the engine cannot re-enter until a human changes that fact, so they are standby-compatible rather than probe work. On TOP of that, a candidate whose issue's milestone doesn't match cfg.round.milestone stops counting for THIS signal the moment it (or the run's own milestone) moves into scope — it remains visible to gatedFailedWorkers() itself, so GATED RECLAIM still reclaims it the instant a differently-scoped run (or this run once re-milestoned) executes a tick; a human release on an indefinite timescale is exactly what the #630 disabled-consumer analysis says must not pin a probe open.",
    enabled: (ctx) => ctx.mergeGateConfigured,
    probe: async (ctx) => {
      const candidates = ctx.state.gatedFailedWorkers();
      if (candidates.length === 0) return false;
      const milestone = ctx.cfg.round.milestone;
      // Carrier parity with conductor.ts:3982: human labels retain their historical substring
      // semantics on either object; #400's exact hold-label check belongs only to the PR.
      const issueHumanBlocked = (labels: readonly string[]) => labelsIncludeAnySubstring(labels, ctx.cfg.escalation.humanLabels);
      const prHumanBlocked = (labels: readonly string[]) =>
        labelsIncludeAnySubstring(labels, ctx.cfg.escalation.humanLabels) || labelsIncludeAny(labels, ctx.cfg.escalation.holdLabels);
      for (const w of candidates) {
        const meta = await ctx.forge.getIssueMeta(w.issue);
        if (milestone && meta.milestone !== milestone) continue;
        if (issueHumanBlocked(meta.labels)) continue;
        if (w.pr != null && prHumanBlocked(await ctx.forge.getPRLabels(w.pr))) continue;
        return true;
      }
      return false;
    },
  },
  {
    name: "ready-issues",
    read: "forge",
    consumer: "conductor.ts tick() DISPATCH — always live, no role gate",
    terminal:
      "forge.ts isDispatchable excludes `needsHuman`/`blocked`/`decomposed` and the #94 forbidden verifyNa+planApproved mixed state — every deterministic failure path an undispatchable-but-Ready issue can take ends in one of those labels, at which point it leaves this set; a successful dispatch claims it off the Ready lane instead",
    probe: async (ctx) => (await ctx.forge.getReadyIssues()).length > 0,
  },
  // #127 gate② F2: each candidate signal below only counts as work when the role that CONSUMES
  // it is enabled. A plan-review candidate is only ever consumed by the verification-plan-reviewer (gate⓪), a
  // triage candidate only by the PO's aligning pass — with that role disabled
  // (roles.<role>.enabled: false) the candidate can never be consumed, so counting it would pin
  // this probe true forever: standby never engages and every round burns the remaining
  // peripheral sessions doing nothing, indefinitely.
  {
    name: "plan-review-candidates",
    read: "forge",
    consumer: "plan-review.ts gate⓪ — gated on cfg.roles.verificationPlanReviewer.enabled",
    terminal:
      "forge.ts needsPlanReview excludes `needsHuman`/`blocked`/`planless`/`decomposed`, so a candidate the reviewer cannot settle stops counting the moment its escalation lands (`plan-review-escalated` applies needsHuman); an approved one carries planApproved and fails the predicate on its own",
    enabled: (ctx) => ctx.cfg.roles.verificationPlanReviewer.enabled,
    probe: async (ctx) => (await ctx.forge.getIssuesNeedingPlanReview()).length > 0,
  },
  {
    name: "plan-triage-candidates",
    read: "forge",
    consumer: "align.ts PO aligning/triage pass — gated on cfg.roles.po.enabled",
    terminal:
      "forge.ts needsPlanTriage excludes `needsHuman`/`blocked`/`planless`/`verifyNa`/`decomposed` — an issue triage cannot draft a plan into ends up fenced `planless` (align.ts) or held, and leaves the set; a drafted plan fails the predicate directly",
    enabled: (ctx) => ctx.cfg.roles.po.enabled,
    probe: async (ctx) => (await ctx.forge.getIssuesNeedingPlanTriage()).length > 0,
  },
  {
    name: "pooled-plan-review-repair",
    read: "forge",
    // #432 round 5 (Codex P1 finding 1, gate② confirm round 2 — round 4's own version of this
    // line was itself an F32 generator): the round-pool's ELIGIBLE set (forge.ts's
    // selectPoolEligibleIssues/isPoolEligible, #214) is Ready-lane-scoped, hold-excluding, and
    // excludes the #94 forbidden verifyNa+planApproved mixed state, but it is a SUPERSET of what
    // the class-2 repair session actually consumes — plan-review.ts's createPlanReviewStub reads
    // `eligible.filter((i) => labelsInclude(i.labels, l.roundPool))`, never the raw eligible
    // list. A valid PO pool-selection judgment of `selected: []` (round-defaults.ts's own doc:
    // "controlled experiments found the session selects every candidate at every model tier" is
    // the DEFAULT deterministic-pool case, but `roles.po.poolSelection: true` makes a genuine
    // empty selection reachable) leaves the eligible-but-unpooled remainder with NO consumer this
    // round — round 4's unfiltered read pinned the probe true on exactly that remainder,
    // reopening a paid PO selection pass every idle round for nothing. Filtering by
    // `cfg.labels.roundPool` (present in the SAME read's label arrays — no extra forge call)
    // makes the probe literally `getPoolEligibleIssues() ∩ roundPool`, the exact set
    // createPlanReviewStub consumes. Round-pool selection runs UNCONDITIONALLY every round
    // regardless of roles.po.enabled (round-defaults.ts ~200); the repair SESSION is gated on
    // roles.verificationPlanReviewer.enabled (createPlanReviewStub's own gate) — same disabled-consumer rule.
    // This replaced round 3's `plan:approved` label exemption in the milestone catch-all, which
    // over-counted (a valid approved issue demoted off Ready, or the #94 forbidden state, both
    // pinned the probe true with nothing able to consume them) and under-delivered (the
    // broken-body case it was cited for never needed it — a broken body already fails
    // `planCompleteOrExempt` and counts on its own).
    consumer: "plan-review.ts createPlanReviewStub class-2 repair — gated on cfg.roles.verificationPlanReviewer.enabled",
    terminal:
      "the roundPool LABEL itself: applied atomically with pool selection (align.ts reconcilePoolLabels, always reachable, never role-gated) and removed by round-close (round.ts removeRoundPoolLabel) or the next round-open reconcile; a removal that fails deterministically caps at cfg.round.maxPoolRemovalAttempts and escalates (`round-pool-removal-capped` + needsHuman), which drops the issue out of isPoolEligible — so an unremovable label cannot pin this signal forever",
    enabled: (ctx) => ctx.cfg.roles.verificationPlanReviewer.enabled,
    probe: async (ctx) => (await ctx.forge.getPoolEligibleIssues()).some((i) => labelsInclude(i.labels, ctx.cfg.labels.roundPool)),
  },
  {
    name: "milestone-backlog",
    read: "forge",
    // #127 gate② R1 (same disabled-consumer rule): the milestone catch-all exists because an
    // open not-yet-Ready issue in the round's milestone is exactly what the PO/aligning pass
    // decomposes (or gate⓪ approves) — with BOTH gate⓪ roles off, nothing enabled can consume
    // that signal either; the only consumable signal left is Ready+dispatchable, already covered
    // by ready-issues above. Counting it anyway would pin the probe true and defeat standby.
    consumer:
      "align.ts PO decomposition / plan-review.ts gate⓪ — gated on cfg.round.milestone AND (po.enabled || verificationPlanReviewer.enabled)",
    terminal:
      "the per-exclusion set inside the predicate, each of which is where a deterministic failure lands: `inProgress` (#391 — a claim, healed back to Ready by startup's F20 sweep if stale), cfg.escalation.humanLabels (#212 — a human already owns it), `planless` (#397 — the fence for an issue triage cannot draft), and fully-specified-without-a-consumable-signal (#432 — waiting on a human Ready-promotion). An issue no enabled role can act on carries one of these and stops counting",
    enabled: (ctx) => Boolean(ctx.cfg.round.milestone) && (ctx.cfg.roles.po.enabled || ctx.cfg.roles.verificationPlanReviewer.enabled),
    probe: async (ctx) => {
      // Cheapest read first: zero open issues in the milestone settles the question with no
      // further fetch.
      const milestone = ctx.cfg.round.milestone;
      const count = await ctx.forge.countOpenIssuesInMilestone(milestone as string);
      if (count === 0) return false;
      // #212 (documented residual, round.ts:426-427 pre-fix): a milestone holding open issues ALL
      // carrying a human-hold label (cfg.escalation.humanLabels) is not consumable by anything
      // enabled either — a human is already in the loop for every one of them, same "only a
      // consumable signal counts" rule as the two role-gated checks above. Nothing enabled can
      // ever act on a held issue, so it must not pin the probe true forever (a milestone that's
      // gone all-held would otherwise open an empty round after empty round, burning every
      // peripheral session on a backlog nothing can consume). One non-held open issue in the
      // milestone still counts. listOpenIssues() is the full open backlog (RoundScopedForge
      // deliberately does not milestone-scope it — see its own doc comment), so the milestone
      // filter is applied here, matching what countOpenIssuesInMilestone itself counts.
      // #397: `planless` is excluded here for the SAME disabled-consumer reason as a human hold —
      // a plan-less fenced issue is invisible to every triage/review/pool predicate (forge.ts's
      // isPlanless), so nothing enabled can consume it either. It used to be covered incidentally
      // because the fence borrowed `needsHuman` (a humanLabels member); spelling it out keeps
      // this probe's behavior byte-for-byte identical under the new name.
      //
      // #391 (F21): a CLAIMED issue (cfg.labels.inProgress) doesn't count either — same "only a
      // consumable signal counts" rule, applied to the other way an issue leaves the Ready lane.
      // A claimed issue is off the Ready column, so it is invisible to
      // getReadyIssues/getPoolEligibleIssues/getIssuesNeedingPlanReview, and it has a plan already
      // so triage skips it: no enabled role can consume it. Live claims are harmless to exclude
      // (an occupied lane means the round wasn't idle, and standby needs lastRoundIdle); STALE
      // ones — a lane that died leaving the label behind — are exactly the residue that churned 16
      // empty rounds on 2026-07-24, pinning this probe true over a backlog with a provably empty
      // pool. Startup's own F20 heal strips the stale label and returns the issue to Ready, at
      // which point it counts again, legitimately.
      //
      // Residual, stated rather than overclaimed: the label is the only claim signal available
      // here (listOpenIssues carries labels, not board status), so an issue whose claim landed as
      // a board write but whose addLabel failed still pins this probe. That direction is the
      // deliberate one — it errs toward opening a round, the same fail-toward-more-work stance
      // this probe's own catch uses.
      //
      // #432 (F32, PM gate⓪ adjudication 2026-07-31, round 4 — round 3's shape narrowed further
      // after gate② review found the label set itself wrong in BOTH directions): a
      // fully-specified issue (plan/AC already drafted, or explicitly plan-exempt) that carries
      // NONE of the labels below is nothing any enabled role can act on — it is just waiting on a
      // human Ready-promotion, the exact F32 churn (8 such issues in v0.2.1 pinned this probe true
      // for six empty rounds). This is a MINIMAL, label-driven exclusion layered on top of the
      // #212/#397/#391 exclusions above — it does NOT replace the catch-all's own repo-wide
      // `listOpenIssues()` read (board-scoped selectors like selectPlanTriageCandidates iterate
      // ProjectV2 `project.items` only and would miss an off-board milestone issue entirely — the
      // exact gap round 2's deletion opened).
      //
      // "Plan-complete-or-exempt" = extractVerificationPlan(body) != null (forge.ts, the same read
      // isDispatchable/needsPlanTriage share — needsPlanReview does NOT: it is a pure label-only
      // predicate, forge.ts ~2288, so it is not part of this list) OR the issue carries verifyNa
      // (the doc-gate path — no plan is ever expected). An issue in EITHER state is only excluded
      // when it ALSO carries none of:
      //  - cfg.labels.split: a human-fired decompose request. isDecomposeCandidate (decompose.ts)
      //    is exactly `split ∧ ¬decomposed ∧ ¬needsHuman ∧ ¬blocked` — consumed by
      //    runDecompositionPass, called from align.ts's aligning-phase handler INSIDE alignStub.run,
      //    which round-defaults.ts gates on `cfg.roles.po.enabled` — a live decompose candidate,
      //    fully specified or not, must still wake the loop when the PO is on, or the human's split
      //    request stalls in standby indefinitely.
      //  - cfg.labels.decomposed: a fenced parent whose decomposition may still have an
      //    unreconciled LOCAL journal (decompose.ts's `recoveries` set, `runDecompositionPass`) —
      //    the same align.ts call site/gate as `split` above. `needsPlanTriage` explicitly EXCLUDES
      //    `decomposed` (forge.ts), so this recovery work is invisible to the triage signal above
      //    by design; excluding it here too would silently strand it in standby. This probe has no
      //    local-journal read of its own (SQLite state, not a forge call), so — same "residual,
      //    stated rather than overclaimed" stance as the claimed-issue comment above — every
      //    decomposed-labelled issue counts, even ones whose journal is ALREADY fully reconciled: a
      //    same-round-idle over-count, never a missed recovery.
      //  - cfg.labels.roundPool (#432 round 4, Codex P2 finding 3): a stale pool label is an
      //    engine-OWNED artifact (align.ts's `reconcilePoolLabels`, on every round-open
      //    pool-selection pass, and round.ts's own round-close removal sweep) whose retry is
      //    unconditional, not role-gated; a milestone issue carrying a stale `roundPool` label the
      //    LAST cleanup attempt failed to strip is exactly the kind of engine-owned residue #391's
      //    claimed-issue exclusion already treats as "the round wasn't idle" for.
      //
      // No new prose heuristic: every check reuses an existing predicate/label-config key
      // (extractVerificationPlan, cfg.labels.verifyNa/split/decomposed/roundPool) already shared
      // with the consumers cited.
      const cfg = ctx.cfg;
      const openIssues = await ctx.forge.listOpenIssues();
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
    },
  },

  // ── declared blind spots: real work this probe deliberately does NOT hold rounds open for ──
  // Each is bounded and self-corrects the next time ANY other signal legitimately wakes the loop
  // (the #212 stance: a human-latency window must never pin the probe true). Registered with
  // `probe: null` so the inventory is complete rather than aspirational — a reader can see the
  // case was weighed, not missed.
  {
    name: "plan-doc-edit-during-standby",
    read: "none",
    consumer: "align.ts PO plan-doc decomposition — gated on cfg.roles.po.enabled",
    terminal:
      "human act observed on the next legitimate wake: a plan-doc edit made DURING standby is invisible to this pure-API probe, so the operator files an issue (any probe signal above) or restarts the run to wake the PO",
    probe: null,
  },
  {
    name: "dissent-adjudication-scan",
    read: "forge",
    consumer: "dissent.ts scanForAdjudication — a human REPLYING to an already-posted concern",
    terminal:
      "human act observed on the next legitimate wake: the scan needs live forge reads (getIssueMeta/getIssueBody/getIssueComments) per open concern — not a cheap local fact like pending-durable-concerns above — so it is not probed. A still-open concern simply stays unadjudicated in `sapwood status` until the next wake re-runs the scan (bounded: a stale dashboard row, never a stuck decision)",
    probe: null,
  },
  {
    name: "escalation-resolution-reconcile",
    read: "forge",
    consumer: "escalation-reconcile.ts reconcileEscalations + escalation-sweep.ts sweepResolvedHolds — unconditional, round-level",
    terminal:
      "human act observed on the next legitimate wake: likewise a live-forge read, not a local fact. Its resolution sources are wider than label removal alone — a merge, a PR close, an issue close, or a board-status repair all observe as resolved (ResolutionVia) — and post-#468/#441 an `escalation-resolved` event also feeds sweepResolvedHolds, which strips the engine-applied needs-human label the resolution proved is no longer earned. During standby THAT sweep is deferred alongside the dashboard entry, so a resolved escalation's issue keeps a stale hold label (and stays excluded from every held-issue-sensitive read, including milestone-open-issues' humanLabels exclusion) until the next wake. Bounded the same way: a stale label/row, never a stuck decision — the underlying work was never blocked, only its bookkeeping lagged",
    probe: null,
  },
  // NOT a blind spot, and deliberately absent from this list: an eligible-but-unpooled issue
  // (`getPoolEligibleIssues()` member with no `roundPool` label). See pooled-eligible-issues'
  // comment — it is a rendered PO judgment (a valid `selected: []`), not pending work of any
  // kind, so it correctly never counts and needs no terminal of its own.
];

/** Iterate the registry in order; the FIRST consumable signal that fires wins, and its `name`
 *  is the return value (#470: the probe reports WHICH signal held the round open, so the
 *  idle-churn breaker's event carries the F32 diagnosis instead of the next incident having to
 *  re-derive it from source). `null` = nothing to do. Same ordering, same guards, same
 *  short-circuiting as the `if (...) return true;` chain this replaced — a gated-off signal
 *  never issues its read (round.test.ts asserts exactly that for the two role-gated forge
 *  signals). Throws propagate to round.ts's probe, which contains them (and reports
 *  `probe-error` as the signal name, fail-open to opening the round). */
export async function firstWorkSignal(ctx: ProbeCtx): Promise<string | null> {
  for (const signal of PROBE_SIGNALS) {
    if (signal.probe === null) continue;
    if (signal.enabled && !signal.enabled(ctx)) continue;
    if (await signal.probe(ctx)) return signal.name;
  }
  return null;
}
