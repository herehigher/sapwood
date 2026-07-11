// retro.ts — implements PeripheralStub for the `retro` phase (#91, #77 decision 6): the
// self-evolution role. Analyzes the round (bounced plans, review rejections, budget overruns —
// and whatever else the round's own digest surfaces) and proposes improvements to
// prompts/config/docs EXCLUSIVELY as a PR through the normal gate② path — never a direct write.
// See prompts/retro.md for the CTO + user 2026-07-10 review-findings-philosophy amendment this
// role's prompt must carry (recurring findings are a design signal, not a fix queue; review
// findings are evidence to judge, not orders to follow).
//
// #111 PR-A (read-side hardening): retro no longer browses GitHub live. Its prompt is seeded
// with an ENGINE-BUILT, round-scoped digest (retro-digest.ts's buildRetroDigest — PR diffs +
// review signals for every PR the round touched, comments/labels for every escalated issue,
// commit history since round start), assembled deterministically BEFORE the session runs and
// substituted in as `{{round.digest}}` (run() below). The `gh pr view/list/diff` and
// `gh issue view/list` Bash grants that used to let the session fetch this itself are gone
// (RETRO_ALLOWED_TOOLS, below) — see #111's write-side half (PR-B, not this PR) for the
// remaining direct forge write (`gh pr create`), still granted here for now.
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
import type { IForge } from "./forge.js";
import type { State, RoundRow } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import { runSessionWithRetry, type RoleRunner } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { renderFactsTemplate } from "./harvest.js";
import { buildRetroDigest } from "./retro-digest.js";

/** #91: retro's write scope — the FIRST role in this codebase whose job requires more than
 *  issues-only writes. Grants exactly what "propose via PR, never directly" needs: LOCAL git
 *  history/diff/status (its own worktree, never GitHub), file edits inside its own ephemeral
 *  worktree, and `gh pr create` — nothing that mutates an issue (that is harvest's/
 *  plan-reviewer's/plan-drafter's scope, never retro's) and nothing that merges, reviews, or
 *  approves anything.
 *
 *  #111 PR-A: the live `gh pr view/list/diff` + `gh issue view/list` GitHub-browsing grants
 *  are GONE — that read surface is now the engine-built digest (module doc above), never a
 *  live session Bash call. `git diff/status/log` stay: local repo introspection inside the
 *  session's own worktree (checking its own uncommitted edits before it commits), not GitHub
 *  browsing — #111's scope item 1 names the `gh` browsing surface specifically, not local git
 *  plumbing a role that edits-and-commits routinely needs.
 *
 *  Same best-effort-pattern-layer caveat as every other allow/deny list in this codebase (see
 *  peripheral.ts's enforcement doc on ROLE_ALLOWED_TOOLS): the REAL boundary is the unchanged
 *  fail-closed guard hook every session gets, never weakened here. This pair only narrows what
 *  the CLI permission layer allows without an interactive prompt. */
export const RETRO_ALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit," +
  "Bash(git branch*),Bash(git checkout*),Bash(git add*),Bash(git commit*),Bash(git push*)," +
  "Bash(git diff*),Bash(git status*),Bash(git log*)," +
  "Bash(gh pr create*)";

/** Direct-write / self-merge / issue-mutation paths retro must never reach — "proposals appear
 *  as branches/PRs only" (#91 acceptance criterion), asserted directly against these strings in
 *  retro.test.ts. `git push`ing straight to the default branch is denied by NAME (main/master)
 *  since a role session has no reliable way to ask "what is this repo's default branch" from a
 *  fixed string pattern. RESIDUAL, stated honestly (fable review PR #103 P3): an unusual
 *  default-branch name slips this pattern AND the guard hook — the guard's git category
 *  protects boundary FILES, not push targets — so the only backstop today is GitHub-side
 *  branch protection, if the repo has it configured (nothing, otherwise). The structural fix
 *  (derive the repo's real default branch and deny it dynamically) is tracked in #102's
 *  tool-scope hardening, not here.
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
  /** #111 PR-A: the digest's read surface — every PR-diff/review/issue-comment/label fetch
   *  the engine makes on retro's behalf now goes through here, never through a live session
   *  Bash call (see retro-digest.ts's buildRetroDigest, the module doc above). */
  forge: IForge;
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
 *  analysis — the prompt (prompts/retro.md) points the session at the round's DIGEST (below,
 *  `{{round.digest}}` — retro-digest.ts's engine-built PR-diff/review/issue-comment text) for
 *  the actual detail behind these counts; the numbers alone can't tell it WHY something
 *  recurred or whether it matters. */
export interface RetroFacts {
  roundId: number;
  /** Soft-budget graceful handoffs this round — the "budget overruns" signal. */
  handoffs: number;
  /** DRIVE-phase gate② rejections (`drive-needs-human`) PLUS gate⓪ plan-review escalations
   *  (`plan-review-escalated`) this round — the "review rejections" signal, now covering both
   *  gates (#104: plan-review.ts's `escalate()` appends the latter alongside its forge label/
   *  comment, closing the gap this doc used to name — only gate② was visible here before). The
   *  retro prompt points at the round digest for PR/issue detail rather than relying solely on
   *  this count — the numbers are a starting point, not the whole analysis (see the interface
   *  doc above). */
  needsHumanEscalations: number;
  /** Hard-ceiling escalations (daily budget / wall-clock breach) this round — a second, more
   *  severe "budget overrun" signal, distinct from a single lane's soft-budget handoff. */
  ceilingEscalations: number;
}

/** The event kinds retro's own "raw material" comes from (prompts/retro.md: bounced plans,
 *  review rejections, budget overruns) — backs BOTH gatherRetroFacts's counts (below) and
 *  retro-digest.ts's per-issue digest detail (buildRetroDigest's `issueEventKinds` param, run()
 *  below) — one list, not two independently-maintained ones. */
const RETRO_EVENT_KINDS = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];

export function gatherRetroFacts(state: State, round: RoundRow): RetroFacts {
  const events = state.eventsSince(round.started_at, RETRO_EVENT_KINDS);
  const count = (kind: string): number => events.filter((e) => e.kind === kind).length;
  return {
    roundId: round.round_id,
    handoffs: count("handoff"),
    needsHumanEscalations: count("drive-needs-human") + count("plan-review-escalated"),
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
 *  otherwise dispatches once per round when reached: recurring-pattern detection (prompts/
 *  retro.md rule 1) needs the session's OWN judgment over history the orchestrator doesn't
 *  pre-filter — there is no cheap structural test for "nothing worth proposing" the way
 *  harvest's empty needs-human list is. #104: the ONE cadence knob is
 *  `roles.retro.everyNRounds` (default 1 = every round, unchanged from #91) — a round whose id
 *  isn't a multiple of N skips the session entirely (still sets the marker; the phase always
 *  closes, never wedges the round).
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
      const cadence = deps.cfg.roles.retro.everyNRounds;
      if (roundId % cadence !== 0) return { marker: retroMarker(roundId) }; // thinned round — no session, phase still closes
      const round = deps.state.getRound(roundId);
      if (!round) return { marker: retroMarker(roundId) }; // defensive; round.ts always supplies a real row
      const facts = gatherRetroFacts(deps.state, round);
      // #111 PR-A: the engine-built read digest — PR diffs + review signals for every PR the
      // round touched, comments/labels for every escalated issue, commit history since round
      // start (retro-digest.ts's IForge.getCommitsSince — a `gh api` read, never a local `git
      // log` subprocess; see that module's doc for the #69 grep-invariant this respects).
      // Assembled BEFORE the session runs, bounded by roles.retro.digestMaxChars (a hard cap,
      // deterministic truncation — retro-digest.ts's capDigest), and substituted into the
      // prompt below as `{{round.digest}}` — the session's ONLY read surface into this round's
      // history now (RETRO_ALLOWED_TOOLS above carries no `gh` read grant anymore).
      const digest = await buildRetroDigest(
        { forge: deps.forge, state: deps.state },
        round,
        deps.cfg.roles.retro.digestMaxChars,
        RETRO_EVENT_KINDS,
      );
      const template = loadRolePromptTemplate(deps.cfg.roles.retro.promptFile, defaultRetroPromptPath());
      const rendered = renderFactsTemplate(template, { ...factVars(facts), "round.digest": digest });
      const role = deps.cfg.roles.retro;
      // Same outcome-check-and-retry as harvest.ts (gate② P2 on the sibling #100/#101 PRs:
      // RoleRunner.run never throws on the session's own outcome, so an unchecked failed/
      // timeout session would silently count as "retro done"). #104: ported to peripheral.ts's
      // shared runSessionWithRetry (outcome-check -> retry-once -> visible-degradation, ONE
      // implementation for architect/align/harvest/retro) — a second failure degrades visibly
      // (durable event + stderr) but still closes the phase — a retro session proposes
      // improvements only, so a lost pass costs one round's proposals and nothing else; the
      // next round's retro sees the same history and can pick it back up.
      await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "retro", prompt: rendered, model: role.model, effort: role.effort,
          allowedTools: RETRO_ALLOWED_TOOLS, disallowedTools: RETRO_DISALLOWED_TOOLS,
        },
        issue: 0, // round-level spend, no single associated issue — same 0 sentinel as harvest.ts
        now: deps.now ?? (() => new Date()),
        degradeEvent: "retro-degraded",
        degradePayload: (result) => ({
          round_id: roundId, outcome: result.outcome, session: result.name, attempts: 2,
        }),
        degradeMessage: (result) =>
          `sapwood: retro session failed twice (${result.outcome}) for round ${roundId} — ` +
          `closing the retro phase WITHOUT a proposal pass (degraded, see the retro-degraded ` +
          `event); the run is not blocked`,
      });
      return { marker: retroMarker(roundId) };
    },
  };
}
