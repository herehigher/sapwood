// retro.ts — implements PeripheralStub for the `retro` phase (#91, #77 decision 6): the
// self-evolution role. Analyzes the round (bounced plans, review rejections, budget overruns —
// and whatever else its own reading of the round's GitHub history surfaces) and proposes
// improvements to prompts/config/docs EXCLUSIVELY as a PR through the normal gate② path — never
// a direct write. See prompts/retro.md for the CTO + user 2026-07-10 review-findings-philosophy
// amendment this role's prompt must carry (recurring findings are a design signal, not a fix
// queue; review findings are evidence to judge, not orders to follow).
//
// UNLIKE plan-review.ts/harvest.ts's issues-only RoleRunner sessions, retro's job genuinely
// needs git (branch/commit/push) + `gh pr create` — a strictly wider write scope than
// peripheral.ts's ROLE_ALLOWED_TOOLS can express. RoleRunner still does the spawning (#87's
// spawn/sentinel/timeout/cost-parse machinery, unchanged); this module only supplies its own
// allowedTools/disallowedTools override (peripheral.ts's #91 addition) instead of the base
// issues-only pair.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeripheralStub } from "./round.js";
import type { State, RoundRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { RoleRunner } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { renderFactsTemplate } from "./harvest.js";

/** #91: retro's write scope — the FIRST role in this codebase whose job requires more than
 *  issues-only writes. Grants exactly what "propose via PR, never directly" needs: read-only
 *  git/gh history browsing, file edits inside its own ephemeral worktree, and `gh pr create` —
 *  nothing that mutates an issue (that is harvest's/plan-reviewer's/plan-drafter's scope, never
 *  retro's) and nothing that merges, reviews, or approves anything.
 *
 *  Same best-effort-pattern-layer caveat as every other allow/deny list in this codebase (see
 *  peripheral.ts's enforcement doc on ROLE_ALLOWED_TOOLS): the REAL boundary is the unchanged
 *  fail-closed guard hook every session gets, never weakened here. This pair only narrows what
 *  the CLI permission layer allows without an interactive prompt. */
export const RETRO_ALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit," +
  "Bash(git branch*),Bash(git checkout*),Bash(git add*),Bash(git commit*),Bash(git push*)," +
  "Bash(git diff*),Bash(git status*),Bash(git log*)," +
  "Bash(gh pr create*),Bash(gh pr view*),Bash(gh pr list*),Bash(gh pr diff*)," +
  "Bash(gh issue view*),Bash(gh issue list*)";

/** Direct-write / self-merge / issue-mutation paths retro must never reach — "proposals appear
 *  as branches/PRs only" (#91 acceptance criterion), asserted directly against these strings in
 *  retro.test.ts. `git push`ing straight to the default branch is denied by NAME (main/master)
 *  since a role session has no reliable way to ask "what is this repo's default branch" from a
 *  fixed string pattern; an unusual default-branch name is a residual gap the guard hook (not
 *  this best-effort list) is the real backstop for.
 *
 *  `gh pr create *--body-file*` (#101 push-time security review): every widened gh WRITE allow
 *  carries the matching --body-file deny, same rule the issues-only roles established. For
 *  retro specifically this is consistency/defense-in-depth rather than a hard boundary (retro
 *  HAS the Read tool — its job is reading the repo — so --body-file adds no capability the
 *  session lacks), but a uniform "no gh command ever reads its payload from a file" rule is
 *  cheaper to audit than per-role exceptions, and --body works everywhere --body-file would. */
export const RETRO_DISALLOWED_TOOLS =
  "Bash(git push*main*),Bash(git push*master*)," +
  "Bash(gh pr merge*),Bash(gh pr review*),Bash(gh pr ready*)," +
  "Bash(gh pr edit*),Bash(gh issue edit*),Bash(gh issue comment*),Bash(gh api*)," +
  "Bash(gh pr create *--body-file*)";

export interface RetroDeps {
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests fake the underlying session directly (same "fake the collaborator, not
   *  the CLI" split as plan-review.ts's/harvest.ts's own tests). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

export function retroMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:retro -->`;
}

export function defaultRetroPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "retro.md");
}

/** The round facts retro's prompt is seeded with — "bounced plans, review rejections, budget
 *  overruns" per #91's scope, sourced from durable `state` (events since round.started_at),
 *  same convention as harvest.ts's gatherRoundFacts. This is a STARTING POINT, never the whole
 *  analysis — the prompt (prompts/retro.md) explicitly instructs the session to go read the
 *  actual PRs/issues/history behind these counts before concluding anything; the numbers alone
 *  can't tell it WHY something recurred or whether it matters. */
export interface RetroFacts {
  roundId: number;
  /** Soft-budget graceful handoffs this round — the "budget overruns" signal. */
  handoffs: number;
  /** DRIVE-phase gate② rejections (`drive-needs-human` events) this round — the "review
   *  rejections" signal. KNOWN GAP (shared with harvest.ts): gate⓪'s plan-review bounces
   *  ("bounced plans" in the narrower sense) write straight to GitHub with no state event, so
   *  they are not counted here — the retro prompt is told to read PR/issue history directly
   *  rather than rely solely on this count for that category. */
  needsHumanEscalations: number;
  /** Hard-ceiling escalations (daily budget / wall-clock breach) this round — a second, more
   *  severe "budget overrun" signal, distinct from a single lane's soft-budget handoff. */
  ceilingEscalations: number;
}

const RETRO_EVENT_KINDS = ["handoff", "drive-needs-human", "ceiling-escalated"];

export function gatherRetroFacts(state: State, round: RoundRow): RetroFacts {
  const events = state.eventsSince(round.started_at, RETRO_EVENT_KINDS);
  const count = (kind: string): number => events.filter((e) => e.kind === kind).length;
  return {
    roundId: round.round_id,
    handoffs: count("handoff"),
    needsHumanEscalations: count("drive-needs-human"),
    ceilingEscalations: count("ceiling-escalated"),
  };
}

function factVars(facts: RetroFacts): Record<string, string> {
  return {
    "round.id": String(facts.roundId),
    "round.handoffs": String(facts.handoffs),
    "round.needsHumanEscalations": String(facts.needsHumanEscalations),
    "round.ceilingEscalations": String(facts.ceilingEscalations),
  };
}

/** Builds the `retro` phase's PeripheralStub. Idempotence (#77 decision 4): a non-null incoming
 *  marker means a prior attempt this round already ran this phase — returned UNCHANGED, no
 *  session re-dispatched. Unlike harvest's "no needs-human issues, no session" shortcut, retro
 *  always dispatches once per round when reached: recurring-pattern detection (prompts/retro.md
 *  rule 1) needs the session's OWN judgment over history the orchestrator doesn't pre-filter —
 *  there is no cheap structural test for "nothing worth proposing" the way harvest's empty
 *  needs-human list is. Whether every round should pay for a retro pass (vs. some cadence) is a
 *  deliberate follow-up decision for whoever wires this into runRounds, not this issue's scope.
 *
 *  KNOWN GAP: peripheral.ts's RoleRunner always deletes a session's ephemeral worktree
 *  afterward (documented there as safe because an issues-only role session never has real
 *  WIP) — retro is the first role that breaks that assumption: a session that times out or
 *  crashes after editing but before committing+pushing loses that attempt's draft silently,
 *  with no #69-style dirty-worktree retention/escalation. Accepted for this scoped PR (no
 *  safety issue — retro proposes nothing destructive, and the next round's retro simply tries
 *  again); worth revisiting if this proves costly in practice. */
export function createRetroStub(deps: RetroDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker };
      const round = deps.state.getRound(roundId);
      if (!round) return { marker: retroMarker(roundId) }; // defensive; round.ts always supplies a real row
      const facts = gatherRetroFacts(deps.state, round);
      const template = loadRolePromptTemplate(deps.cfg.roles.retro.promptFile, defaultRetroPromptPath());
      const rendered = renderFactsTemplate(template, factVars(facts));
      const role = deps.cfg.roles.retro;
      const iso = (): string => (deps.now ? deps.now() : new Date()).toISOString();
      const runOnce = async (): ReturnType<RetroDeps["runner"]["run"]> => {
        const result = await deps.runner.run({
          roleId: "retro", prompt: rendered, model: role.model, effort: role.effort,
          allowedTools: RETRO_ALLOWED_TOOLS, disallowedTools: RETRO_DISALLOWED_TOOLS,
        });
        // Round-level spend, no single associated issue — same 0 sentinel as harvest.ts.
        deps.state.recordSpend(result.name, 0, result.costUsd, iso(), result.modelUsage);
        return result;
      };
      // Same outcome-check-and-retry as harvest.ts (gate② P2 on the sibling #100/#101 PRs:
      // RoleRunner.run never throws on the session's own outcome, so an unchecked failed/
      // timeout session would silently count as "retro done"). Retry once; a second failure
      // degrades visibly (durable event + stderr) but still closes the phase — a retro session
      // proposes improvements only, so a lost pass costs one round's proposals and nothing
      // else; the next round's retro sees the same history and can pick it back up.
      let result = await runOnce();
      if (result.outcome !== "done") result = await runOnce();
      if (result.outcome !== "done") {
        deps.state.appendEvent("retro-degraded", {
          round_id: roundId, outcome: result.outcome, session: result.name, attempts: 2,
        });
        console.error(
          `sapwood: retro session failed twice (${result.outcome}) for round ${roundId} — ` +
            `closing the retro phase WITHOUT a proposal pass (degraded, see the retro-degraded ` +
            `event); the run is not blocked`,
        );
      }
      return { marker: retroMarker(roundId) };
    },
  };
}
