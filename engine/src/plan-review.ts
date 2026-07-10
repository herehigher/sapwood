// plan-review.ts — implements PeripheralStub for the `plan_review` phase (#87, #77
// Amendment 2's self-heal): gate⓪'s draft -> re-review orchestration for every Ready-lane
// issue that hasn't yet passed plan review this round.
//
// Idempotence (#77 decision 4, round.ts's PeripheralStub contract): a non-null incoming marker
// means a PRIOR attempt this round already ran (and externalized) this phase's work — the
// whole phase is treated as one unit of idempotent work, so a non-null marker is returned
// UNCHANGED, with no candidate re-processed. This is coarser than per-issue idempotence, but it
// is the only granularity round.ts's ledger tracks (one artifact_ref per round+phase), and it
// is fail-safe in the direction that matters: skipping a partially-worked round's remaining
// issues (they're picked up again once dispatchable, or by the next round) is far cheaper than
// risking duplicate reviewer/drafter sessions and duplicate label/comment side effects.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeripheralStub } from "./round.js";
import type { IForge, Issue } from "./forge.js";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import { RoleRunner } from "./peripheral.js";

export interface PlanReviewDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (RoleRunner itself is tested against a
   *  real `claude` stub binary in peripheral.test.ts — this orchestrator's own tests fake the
   *  runner directly, the same "fake the collaborator, not the CLI" split conductor.test.ts
   *  uses for Supervisor). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

/** The round-scoped idempotency marker this phase persists via round.ts's ledger (#77
 *  decision 4's `<!-- sapwood:round:N:<phase> -->` externalized-artifact convention). Also
 *  appended to every issue comment this phase posts, so a round's plan-review activity is
 *  traceable directly on GitHub — not only in sapwood's own sqlite ledger (Amendment 1's
 *  externalization precondition). */
export function planReviewMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:plan_review -->`;
}

export function defaultPlanReviewerPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath.
  return join(here, "..", "prompts", "plan-reviewer.md");
}

export function defaultPlanDrafterPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "plan-drafter.md");
}

/** Load a role prompt TEMPLATE, raw and un-substituted (#74 pattern, generalized beyond
 *  worker.ts's own worker-only loader): the operator's configured file, or the shipped
 *  default. FAIL-FAST: a configured-but-missing/unreadable file throws, naming the path —
 *  never a silent fallback. */
export function loadRolePromptTemplate(configured: string | undefined, defaultPath: string): string {
  if (configured === undefined) return readFileSync(defaultPath, "utf8");
  if (!existsSync(configured)) {
    throw new Error(`role promptFile not found: ${configured} — refusing to run`);
  }
  try {
    return readFileSync(configured, "utf8");
  } catch (e) {
    throw new Error(`role promptFile unreadable: ${configured} (${String(e)}) — refusing to run`);
  }
}

const ISSUE_VARS: Record<string, (issue: Issue) => string> = {
  "issue.number": (issue) => String(issue.number),
  "issue.title": (issue) => issue.title,
  "issue.body": (issue) => issue.body ?? "",
  "issue.labels": (issue) => issue.labels.join(", "),
};

function configVars(cfg: SapwoodConfig): Record<string, string> {
  return {
    "labels.planApproved": cfg.labels.planApproved,
    "labels.needsHuman": cfg.labels.needsHuman,
    "labels.blocked": cfg.labels.blocked,
    "labels.verifyNa": cfg.labels.verifyNa,
    "roles.planReviewer.maxDraftCycles": String(cfg.roles.planReviewer.maxDraftCycles),
  };
}

/** `{{var}}` substitution for role prompts (#74's pattern, reused: simple regex substitution,
 *  FAILS CLOSED on any unknown `{{...}}` placeholder — never a silent literal pass-through).
 *  Wider var set than worker.ts's renderPromptTemplate (issue + config + role-specific `extra`
 *  vars, e.g. the plan-drafter's `{{reviewer.brief}}`), so implemented locally rather than
 *  reusing that function's fixed issue-only var map. */
export function renderRolePrompt(
  template: string,
  issue: Issue,
  cfg: SapwoodConfig,
  extra: Record<string, string> = {},
): string {
  const cvars = configVars(cfg);
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (Object.hasOwn(ISSUE_VARS, name)) return ISSUE_VARS[name]!(issue);
    if (Object.hasOwn(cvars, name)) return cvars[name]!;
    if (Object.hasOwn(extra, name)) return extra[name]!;
    throw new Error(
      `role prompt template: unknown variable {{${name}}} — supported: ` +
        `${[...Object.keys(ISSUE_VARS), ...Object.keys(cvars), ...Object.keys(extra)].join(", ")}`,
    );
  });
}

/** One issue's draft→re-review cycle (#77 Amendment 2): run the reviewer; check the issue's
 *  CURRENT labels afterward to learn its outcome (the session itself applies plan:approved or
 *  needs-human — this orchestrator never applies either on the reviewer's behalf); on neither,
 *  it's outcome 2 (request-a-draft) — brief a plan-drafter session with the reviewer's most
 *  recent comment, then loop. Bounded by cfg.roles.planReviewer.maxDraftCycles; exhausted ->
 *  this orchestrator itself applies needs-human with the attempt trail (Decision #9).
 *
 *  Every cycle re-renders the reviewer/drafter prompts from the issue's CURRENT body
 *  (forge.getIssueBody), never the phase-start snapshot — the drafter's whole output IS a body
 *  edit, and the session cannot re-read the issue itself (`gh issue view` is in
 *  ROLE_DISALLOWED_TOOLS by design), so a stale render would make the reviewer re-judge the
 *  pre-draft plan forever and the self-heal path could never converge (fable review P1).
 *
 *  A reviewer SESSION failure (failed/timeout) is not outcome 2 (fable review P2): it produced
 *  no verdict at all, so briefing a drafter off "the most recent comment" would act on
 *  something that is not a reviewer bounce. Failed sessions are retried once; a second failure
 *  escalates needs-human with the trail, drafter never run. Same stance for a "done" session
 *  that left no usable brief (no label AND no non-empty comment — a contract violation of the
 *  prompt's "every pass ends in exactly one of the three outcomes"). */
async function reviewOneIssue(
  deps: PlanReviewDeps,
  issue: Issue,
  reviewerTemplate: string,
  drafterTemplate: string,
  roundId: number,
): Promise<void> {
  const l = deps.cfg.labels;
  const maxCycles = deps.cfg.roles.planReviewer.maxDraftCycles;
  const iso = (): string => (deps.now ? deps.now() : new Date()).toISOString();
  const marker = planReviewMarker(roundId);
  const trail: string[] = [];

  const escalate = async (reason: string): Promise<void> => {
    await deps.forge.addLabel(issue.number, l.needsHuman);
    await deps.forge.addIssueComment(
      issue.number,
      `gate⓪ plan-review ${reason} — applying \`${l.needsHuman}\`. A human plan (or accepting ` +
        `\`${l.verifyNa}\` by removing \`${l.needsHuman}\`) is needed to make this issue ` +
        `dispatchable again.\n\nAttempt trail:\n- ${trail.join("\n- ")}\n\n${marker}`,
    );
  };

  const runSession = async (
    roleId: "plan-reviewer" | "plan-drafter",
    prompt: string,
    cycle: number,
    tag = "",
  ): ReturnType<PlanReviewDeps["runner"]["run"]> => {
    const role = roleId === "plan-reviewer" ? deps.cfg.roles.planReviewer : deps.cfg.roles.planDrafter;
    const result = await deps.runner.run({ roleId, prompt, model: role.model, effort: role.effort });
    deps.state.recordSpend(result.name, issue.number, result.costUsd, iso(), result.modelUsage);
    trail.push(`cycle ${cycle}: ${roleId}${tag} session ${result.name} -> ${result.outcome}`);
    return result;
  };

  for (let cycle = 0; cycle <= maxCycles; cycle++) {
    // P1: refetch the CURRENT body every cycle — after cycle 0 it's the drafter's edit the
    // reviewer must judge, not the phase-start snapshot. Labels aren't refetched for the
    // render: the outcome routing below reads live labels anyway, and only this orchestrator's
    // own sessions move the labels this prompt branches on.
    const currentIssue: Issue = { ...issue, body: await deps.forge.getIssueBody(issue.number) };
    const reviewerPrompt = renderRolePrompt(reviewerTemplate, currentIssue, deps.cfg);
    let reviewResult = await runSession("plan-reviewer", reviewerPrompt, cycle);
    if (reviewResult.outcome !== "done") {
      // P2: a crashed/timed-out reviewer produced no verdict — retry once, then escalate.
      reviewResult = await runSession("plan-reviewer", reviewerPrompt, cycle, " (retry)");
      if (reviewResult.outcome !== "done") {
        await escalate(`reviewer session failed twice (${reviewResult.outcome})`);
        return;
      }
    }

    const labels = await deps.forge.getIssueLabels(issue.number);
    if (labels.includes(l.planApproved)) return; // outcome 1 — approved, done
    if (labels.includes(l.needsHuman)) return; // outcome 3 (verify:n/a proposal) — a human resolves it

    // Outcome 2: request-a-draft. At the cycle bound already -> self-heal exhausted, escalate.
    if (cycle >= maxCycles) {
      await escalate(`self-heal exhausted after ${maxCycles} draft→re-review cycle(s)`);
      return;
    }

    // Brief the drafter with the reviewer's most recent comment (its bounce/draft-request).
    // P2 guard: a "done" reviewer that applied no label AND left no non-empty comment violated
    // its every-pass-ends-in-an-outcome contract — there is nothing to brief a drafter with,
    // so escalate rather than dispatch a drafter off nothing (or off a stale earlier comment
    // that happens to be empty-adjacent).
    const comments = await deps.forge.getIssueComments(issue.number);
    const brief = comments.length > 0 ? comments[comments.length - 1]!.body : "";
    if (brief.trim() === "") {
      await escalate("reviewer bounced without a usable brief comment");
      return;
    }
    const drafterPrompt = renderRolePrompt(drafterTemplate, currentIssue, deps.cfg, { "reviewer.brief": brief });
    await runSession("plan-drafter", drafterPrompt, cycle);
    // Loop back -> re-run the reviewer against the drafter's edit (body refetched above).
  }
}

/** Builds the `plan_review` phase's PeripheralStub. Loads both role prompt templates ONCE,
 *  eagerly (fail-fast on a bad promptFile before any session runs — the #74 buildRenderPrompt
 *  stance), the first time `run()` is actually invoked with fresh work to do (never on a
 *  skip-via-marker return, so a config that will never be reached because plan_review is
 *  disabled/no-op for this deployment never pays the load-and-validate cost). */
export function createPlanReviewStub(deps: PlanReviewDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker }; // already externalized this round — no duplicate work
      const candidates = await deps.forge.getIssuesNeedingPlanReview();
      if (candidates.length > 0) {
        const reviewerTemplate = loadRolePromptTemplate(
          deps.cfg.roles.planReviewer.promptFile,
          defaultPlanReviewerPromptPath(),
        );
        const drafterTemplate = loadRolePromptTemplate(
          deps.cfg.roles.planDrafter.promptFile,
          defaultPlanDrafterPromptPath(),
        );
        for (const issue of candidates) {
          await reviewOneIssue(deps, issue, reviewerTemplate, drafterTemplate, roundId);
        }
      }
      return { marker: planReviewMarker(roundId) };
    },
  };
}
