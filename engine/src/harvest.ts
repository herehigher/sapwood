// harvest.ts — implements PeripheralStub for the `harvesting` phase (#91, #77 decision 2):
// the round-close summary role. round.ts always runs every peripheral phase (harvesting
// included) before closing an already-open round — even when a final `stop.*` condition fired
// mid-round (runRounds only withholds the NEXT round in that case; see round.ts's own module
// doc) — and skips a peripheral ONLY when KILL_SWITCH is active (runPeripheral's own check,
// generic across every phase). Neither behavior needs any special-casing here: this module
// implements the STUB's own contract only (marker idempotence + what one invocation does).
//
// #110 PR3 rework: the harvest session is PURE COMPUTATION now — no `gh` tool grant is ever
// exercised by its prompt (HARVEST_DISALLOWED_TOOLS is untouched; stripping the now-unused
// allow-list is PR5's sweep, not this one's). Its final message ends in a structured block
// (structured-output.ts's sentinel format); THIS module parses it, validates it against a
// per-role zod schema, and performs every issue-comment write itself via IForge. Unlike
// plan-reviewer/plan-drafter (one BODY block per session, one issue per session), a single
// harvest session briefs a VARIABLE number of issues in one pass — the round's whole
// needs-human set — so its comment bodies travel as an ARRAY of short strings INSIDE the JSON
// metadata rather than the single sentinel-delimited BODY segment: harvest's own prompt caps
// each comment at "a few lines, not a report" (no revised-issue-body-scale markdown, no code
// fences to protect from JSON-string escaping), so the escaping cost the BODY segment exists to
// avoid for plan-review's long bodies never applies here.
//
// Harvest's write targets are CLOSED-FORM PRE-SESSION (unlike architect's from-a-pool choice,
// PR4): gatherRoundFacts computes the round's needsHumanIssues set from the durable ledger
// BEFORE the session ever runs, deterministically. The session's only latitude is what to SAY
// about each one, never WHICH issues to brief — validateHarvestOutput enforces this fail-closed,
// rejecting the whole batch if any returned issue number falls outside that pre-computed set.
// Malformed/schema-invalid/out-of-set output is an INVALID attempt for runSessionWithRetry's
// `isValid` hook — retried once, then harvest's EXISTING advisory degrade path (the
// `harvest-degraded` event, unchanged shape): a summary-role session that never wedges the round
// even on total failure, now equally true when its output merely fails to validate.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PeripheralStub } from "./round.js";
import type { IForge } from "./forge.js";
import type { State, RoundRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import {
  ROLE_DISALLOWED_TOOLS, runSessionWithRetry, type RoleRunner, type RoleSessionResult,
} from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { parseStructuredBlock } from "./structured-output.js";

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
  /** #110 PR3: the write surface for every comment the harvest phase posts — the session
   *  itself never touches `gh` (see the module doc); this is the ONLY channel a validated
   *  harvest decision reaches GitHub through. */
  forge: IForge;
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

// ── #110 PR3: structured-output schema + validator ──────────────────────────────────────────
//
// Unlike plan-review.ts's per-issue sessions (one BODY block, one target), one harvest session
// briefs a VARIABLE number of issues — the round's whole needsHumanIssues set — in a single
// pass. structured-output.ts's sentinel format carries exactly one optional BODY segment per
// session, which doesn't fit an N-target result, so harvest's comment bodies travel as an array
// of short strings INSIDE the JSON metadata instead: harvest.md caps each comment at "a few
// lines, not a report" (round-context prose, never a revised issue body), so none of the
// nested-code-fence/JSON-escaping hazard the BODY segment exists to avoid for plan-review's
// long bodies applies here.
const HarvestMetadataSchema = z.object({
  comments: z.array(
    z.object({
      issue: z.number().int().positive(),
      body: z.string(),
    }).strict(),
  ),
}).strict();

export interface HarvestComment {
  issue: number;
  body: string;
}

export type HarvestValidation = { ok: true; comments: HarvestComment[] } | { ok: false; reason: string };

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Parse + schema-validate + set-validate a harvest session's structured output. `needsHumanIssues`
 *  is the round's PRE-COMPUTED write-target set (gatherRoundFacts, run BEFORE the session) — the
 *  session has no latitude to choose WHICH issues get briefed, only what to say about each one
 *  (module doc). Every returned issue number is checked against that set; ANY number outside it
 *  fails the WHOLE batch closed — never partially honored — the same all-or-nothing posture
 *  validateReviewerOutput/validateDrafterOutput take for a schema/content failure. An empty
 *  `comments` array is valid (harvest.md: nothing to brief -> emit nothing and stop).
 *
 *  Duplicate issue numbers are rejected outright (Codex review round 1, P1): the contract is ONE
 *  comment per needs-human issue, so a batch briefing the same issue twice is ambiguous by
 *  construction — honoring it would post duplicate comments; picking one silently would be the
 *  engine editorializing over unvalidated intent. Fail the WHOLE batch closed instead, same
 *  doctrine as the out-of-set case above. */
export function validateHarvestOutput(text: string, needsHumanIssues: number[]): HarvestValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = HarvestMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  const allowed = new Set(needsHumanIssues);
  for (const c of parsed.data.comments) {
    if (!allowed.has(c.issue)) {
      return {
        ok: false,
        reason: `comment targets issue #${c.issue}, outside this round's needs-human set ` +
          `(${needsHumanIssues.length > 0 ? needsHumanIssues.map((n) => `#${n}`).join(", ") : "empty"})`,
      };
    }
    if (c.body.trim() === "") {
      return { ok: false, reason: `comment for issue #${c.issue} has an empty body` };
    }
  }
  const targets = parsed.data.comments.map((c) => c.issue);
  if (new Set(targets).size !== targets.length) {
    return { ok: false, reason: "duplicate issue in comments — one comment per needs-human issue, never two" };
  }
  return { ok: true, comments: parsed.data.comments };
}

/** The reason string attached to the `harvest-degraded` degrade message (stderr line only —
 *  the durable event's payload shape stays exactly {round_id, outcome, session, attempts},
 *  unchanged from pre-#110, per the module's preserve-event-shapes constraint) — distinguishes
 *  a session-level failure (crashed/timed out) from a session that exited clean but whose
 *  output never validated, same split reviewerDegradeReason (plan-review.ts) makes. */
function harvestDegradeReason(result: RoleSessionResult, needsHumanIssues: number[]): string {
  if (result.outcome !== "done") return `harvest session failed twice (${result.outcome})`;
  const v = validateHarvestOutput(result.resultText ?? "", needsHumanIssues);
  return v.ok ? "harvest output valid" : `harvest produced invalid structured output twice: ${v.reason}`;
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
        // are the operator's signal. #110 PR3: `isValid` extends "failure" to include a "done"
        // session whose structured output is malformed/schema-invalid/out-of-set — the SAME
        // degrade path, never a silently-honored partial result and never a wedged round.
        const result = await runSessionWithRetry({
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
          // Payload shape preserved EXACTLY (pre-#110): {round_id, outcome, session, attempts}.
          // `outcome` is the SESSION's own outcome (RoleSessionResult.outcome) — a "done" session
          // that degraded on invalid output still reports "done" here; harvestDegradeReason
          // (below, stderr-only) is where the invalid-output cause is actually named.
          degradePayload: (result) => ({
            round_id: roundId, outcome: result.outcome, session: result.name, attempts: 2,
          }),
          degradeMessage: (result) =>
            `[sapwood:harvest] round ${roundId}: ${harvestDegradeReason(result, facts.needsHumanIssues)} — ` +
            `closing the harvesting phase WITHOUT posting round-context comments (degraded, see ` +
            `the harvest-degraded event); the run is not blocked`,
          isValid: (result) => validateHarvestOutput(result.resultText ?? "", facts.needsHumanIssues).ok,
        });
        // Every comment write originates from a SCHEMA-VALIDATED, SET-VALIDATED session decision
        // (module doc) — the session itself never touches `gh`. A degraded (still-invalid-after-
        // retry, or session-failed-twice) result posts nothing: runSessionWithRetry already fired
        // the harvest-degraded event/stderr line above, and honoring a result that never
        // validated would be exactly the silent-partial-result outcome this rework exists to
        // prevent.
        if (result.outcome === "done") {
          const validated = validateHarvestOutput(result.resultText ?? "", facts.needsHumanIssues);
          if (validated.ok) {
            const roundMarker = harvestMarker(roundId);
            for (const c of validated.comments) {
              await deps.forge.addIssueComment(c.issue, `${c.body}\n\n${roundMarker}`);
            }
          }
        }
      }
      return { marker: harvestMarker(roundId) };
    },
  };
}
