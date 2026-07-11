// harvest.ts — implements PeripheralStub for the `harvesting` phase (#91, #77 decision 2):
// the round-close summary role. round.ts always runs every peripheral phase (harvesting
// included) before closing an already-open round — even when a final `stop.*` condition fired
// mid-round (runRounds only withholds the NEXT round in that case; see round.ts's own module
// doc) — and skips a peripheral ONLY when KILL_SWITCH is active (runPeripheral's own check,
// generic across every phase). Neither behavior needs any special-casing here: this module
// implements the STUB's own contract only (marker idempotence + what one invocation does).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeripheralStub } from "./round.js";
import type { State, RoundRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import { ROLE_DISALLOWED_TOOLS, runSessionWithRetry, type RoleRunner } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";

/** Harvest's deny-list: the base denies PLUS all of `gh issue edit` — harvest writes issue
 *  COMMENTS only (see prompts/harvest.md), never a body edit and never a label, so unlike the
 *  plan-reviewer (whose legitimate job includes labels) it gets the edit verb denied entirely.
 *  In particular this pattern-denies self-applying gate-relevant labels (plan:approved /
 *  verify:n/a) or lifting needs-human/blocked — the #101 push-time security review's pitfall
 *  class. Best-effort layer as always (see ROLE_ALLOWED_TOOLS's enforcement doc); the residual
 *  is additionally contained structurally: harvest's briefing targets are exclusively
 *  needs-human issues, and needs-human is an UNCONDITIONAL dispatch blocker (isDispatchable
 *  checks it before any other label), so even a rogue label write there cannot make anything
 *  dispatchable. No authoritative post-check needed for a role with no label capability and no
 *  gate-relevant write path. */
export const HARVEST_DISALLOWED_TOOLS = ROLE_DISALLOWED_TOOLS + ",Bash(gh issue edit*)";

export interface HarvestDeps {
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests fake the underlying session directly — peripheral.test.ts already
   *  covers the real claude-stub spawn path (same "fake the collaborator, not the CLI" split
   *  plan-review.ts's own tests use). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

/** The round-scoped idempotency marker this phase persists via round.ts's ledger (#77
 *  decision 4's `<!-- sapwood:round:N:<phase> -->` convention, same shape as
 *  plan-review.ts's planReviewMarker). */
export function harvestMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:harvesting -->`;
}

export function defaultHarvestPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as plan-review.ts's defaultPlanReviewerPromptPath.
  return join(here, "..", "prompts", "harvest.md");
}

/** The round-ledger facts this phase summarizes (#91's acceptance criterion: "contains the
 *  round ledger facts"). Sourced entirely from durable `state` — events + spend_ledger since
 *  the round STARTED (round.started_at) — never a live GitHub query: harvest reports on what
 *  THIS run's ledger recorded, not the board's current live state. */
export interface RoundLedgerFacts {
  roundId: number;
  prsOpened: number;
  prsMerged: number;
  issuesClosed: number;
  spentUsd: number;
  roundBudgetUsd: number;
  /** Distinct issue numbers escalated to needs-human since round start — a DRIVE-phase gate②
   *  rejection (`drive-needs-human`) OR a gate⓪ plan-review escalation (`plan-review-escalated`,
   *  #104: plan-review.ts's `escalate()` now appends this event alongside its forge label/
   *  comment, closing the gap this doc used to name). Deduped across both kinds — the same
   *  issue can appear in only one at a time in practice (gate⓪ blocks dispatch entirely), but
   *  the Set guards it regardless. */
  needsHumanIssues: number[];
}

const HARVEST_EVENT_KINDS = [
  "merged", "reclaim-done", "reclaim-failed", "reclaim-dead", "drive-needs-human", "plan-review-escalated",
];

/** Assemble this round's ledger facts. Pure given `state`'s current contents — exported so
 *  fake-data tests can assert on it directly, independent of the session-dispatch plumbing. */
export function gatherRoundFacts(state: State, round: RoundRow, roundBudgetUsd: number): RoundLedgerFacts {
  const events = state.eventsSince(round.started_at, HARVEST_EVENT_KINDS);
  const prsMerged = events.filter((e) => e.kind === "merged").length;
  // Reuses driver.ts's prsOpenedThisTick DEFINITION (first reclaim transition into `driving`)
  // but reads it off the durable events log instead of an in-memory TickResult, since harvest
  // runs well after the ticks that produced these events — same three qualifying shapes:
  // reclaim-done/reclaim-failed with next === "DRIVING", and reclaim-dead with rescued === true.
  const prsOpened = events.filter((e) => {
    if (e.kind === "reclaim-done" || e.kind === "reclaim-failed") {
      return (e.payload as { next?: string }).next === "DRIVING";
    }
    if (e.kind === "reclaim-dead") return (e.payload as { rescued?: boolean }).rescued === true;
    return false;
  }).length;
  const needsHumanIssues = [
    ...new Set(
      events
        .filter((e) => e.kind === "drive-needs-human" || e.kind === "plan-review-escalated")
        .map((e) => (e.payload as { issue: number }).issue),
    ),
  ];
  return {
    roundId: round.round_id,
    prsOpened,
    prsMerged,
    // A merged lane's PR closes its issue via the worker's own `Closes #N` convention
    // (worker.md) — the same "merged" event backs both counts; there is no separate
    // issues-closed tracking to reconcile against.
    issuesClosed: prsMerged,
    spentUsd: state.spentUsdSince(round.started_at),
    roundBudgetUsd,
    needsHumanIssues,
  };
}

function factVars(facts: RoundLedgerFacts): Record<string, string> {
  return {
    "round.id": String(facts.roundId),
    "round.prsOpened": String(facts.prsOpened),
    "round.prsMerged": String(facts.prsMerged),
    "round.issuesClosed": String(facts.issuesClosed),
    "round.spentUsd": facts.spentUsd.toFixed(2),
    "round.roundBudgetUsd": facts.roundBudgetUsd.toFixed(2),
    "round.needsHumanCount": String(facts.needsHumanIssues.length),
    "round.needsHumanList": facts.needsHumanIssues.length > 0
      ? facts.needsHumanIssues.map((n) => `#${n}`).join(", ")
      : "(none)",
    // P2 (fable review, PR #103): the session embeds this verbatim in each briefing comment —
    // the same on-GitHub traceability convention plan-review.ts's comments follow.
    "round.marker": harvestMarker(facts.roundId),
  };
}

/** `{{var}}` substitution for round-fact-only prompts (harvest/retro — neither renders a
 *  single Issue, unlike plan-review.ts's per-issue renderRolePrompt). FAILS CLOSED on any
 *  unknown placeholder, same #74 stance as every other prompt renderer in this codebase. */
export function renderFactsTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (Object.hasOwn(vars, name)) return vars[name]!;
    throw new Error(
      `role prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`,
    );
  });
}

/** Builds the `harvesting` phase's PeripheralStub. The round-summary ARTIFACT (#91 acceptance
 *  criterion 1) is TWO-PART: (1) a durable `harvest-summary` state event carrying the full
 *  RoundLedgerFacts, appended unconditionally once per round — the machine-readable summary
 *  (exactly what the #17 dashboard's round view needs); (2) marker-stamped briefing comments
 *  on the round's needs-human issues, when there are any — the human-facing half. A deliberate
 *  deviation from a "post one summary comment somewhere" reading: harvest has no natural
 *  GitHub anchor at round close (no single issue/PR owns a round), so the durable event is the
 *  canonical artifact and GitHub carries only the parts humans are already waiting on.
 *
 *  Idempotence (#77 decision 4): a non-null incoming marker means a prior attempt this round
 *  already externalized this phase's work — returned UNCHANGED, no session re-dispatched. No
 *  `needs-human` issues to brief -> no session (mirrors plan-review.ts's "no candidates, no
 *  session run" shortcut) — but the summary event above still lands. */
export function createHarvestStub(deps: HarvestDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker };
      const round = deps.state.getRound(roundId);
      // Defensive only: round.ts always supplies a real in-progress round row when it invokes
      // a peripheral stub. Never observed to fail; fails toward "close the phase" rather than
      // throwing, consistent with this codebase's fail-toward-more-work stance elsewhere.
      if (!round) return { marker: harvestMarker(roundId) };
      const facts = gatherRoundFacts(deps.state, round, deps.cfg.cost.roundBudgetUsd);
      // P2 (fable review, PR #103): the round-summary ARTIFACT itself — a durable
      // `harvest-summary` event carrying the full ledger facts, appended UNCONDITIONALLY
      // (before and independent of any session dispatch), so a round with an empty
      // needs-human list — no session at all — still externalizes its summary, and a failed
      // session never loses it. Exactly once per round: round.ts persists the phase marker
      // only after run() returns, so a crash mid-phase re-invokes this with marker null —
      // the existing-event check (not the marker) is what dedups that rerun.
      const summaryExists = deps.state
        .eventsSince(round.started_at, ["harvest-summary"])
        .some((e) => (e.payload as { round_id?: number }).round_id === roundId);
      if (!summaryExists) deps.state.appendEvent("harvest-summary", { round_id: roundId, facts });
      if (facts.needsHumanIssues.length > 0) {
        const template = loadRolePromptTemplate(deps.cfg.roles.harvest.promptFile, defaultHarvestPromptPath());
        const rendered = renderFactsTemplate(template, factVars(facts));
        const role = deps.cfg.roles.harvest;
        // RoleRunner.run never throws on the session's OWN outcome (failed/timeout return
        // normally) — checked here, not assumed (gate② P2 on the sibling #100/#101 PRs: both
        // stubs originally ignored result.outcome and silently marked the phase externalized
        // over a dead session). #104: ported to peripheral.ts's shared runSessionWithRetry
        // (outcome-check -> retry-once -> visible-degradation, ONE implementation for
        // architect/align/harvest/retro) — a second failure DEGRADES VISIBLY but still closes
        // the phase below: harvest must never wedge the round or block run termination (#91's
        // graceful-stop requirement) over a summary comment — the durable event + stderr line
        // are the operator's signal.
        await runSessionWithRetry({
          runner: deps.runner,
          state: deps.state,
          session: {
            roleId: "harvest", prompt: rendered, model: role.model, effort: role.effort,
            disallowedTools: HARVEST_DISALLOWED_TOOLS,
          },
          // Round-level spend, no single associated issue — 0 is the sentinel (spend_ledger's
          // `issue` column is NOT NULL; harvest is the first role whose session isn't scoped
          // to one issue).
          issue: 0,
          now: deps.now ?? (() => new Date()),
          degradeEvent: "harvest-degraded",
          degradePayload: (result) => ({
            round_id: roundId, outcome: result.outcome, session: result.name, attempts: 2,
          }),
          degradeMessage: (result) =>
            `sapwood: harvest session failed twice (${result.outcome}) for round ${roundId} — ` +
            `closing the harvesting phase WITHOUT a round summary (degraded, see the ` +
            `harvest-degraded event); the run is not blocked`,
        });
      }
      return { marker: harvestMarker(roundId) };
    },
  };
}
