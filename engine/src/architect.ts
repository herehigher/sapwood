// architect.ts — implements PeripheralStub for the `architecting` phase (#90, #77's round
// model): a round design/review pass between goal alignment and dispatch. The architect reads
// this round's candidate issues + the docs/PLAN.md architecture chapter (+ the PO/goal-
// alignment peripheral's output, when #89 ships one), produces/updates a round design note —
// cross-issue consistency, interface boundaries, risks — and flags any candidate issue whose
// approach contradicts the locked architecture (comment; `blocked` label if severe).
//
// Same peripheral shape as plan-review.ts's gate⓪ orchestration (#87): a ROLE SESSION (issues-
// only writes, no code/PR access — see peripheral.ts's ROLE_ALLOWED_TOOLS) does the actual
// GitHub writes via its own `gh issue comment`/`gh issue edit` tool calls; this module's job is
// only to gather context, render ONE prompt, run ONE session per round, and track round-level
// idempotence. Unlike plan-review's per-issue draft->re-review loop, the architect's whole
// point is a CROSS-issue pass — one session sees every candidate at once, not one session per
// issue — so there is no per-issue looping here at all.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeripheralStub } from "./round.js";
import type { IForge, Issue } from "./forge.js";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { RoleRunner } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";

export interface ArchitectDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (same "fake the collaborator, not the
   *  CLI" split plan-review.ts/conductor.test.ts use). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
  /** Path to the repo's PLAN.md — the architecture-chapter source. Default: docs/PLAN.md under
   *  process.cwd() (the repo root the engine is invoked from — same cwd-relative convention as
   *  peripheral.ts's RoleRunnerDeps.stateDir/worktreeRoot defaults). Deliberately NOT a config
   *  key: architecture review is advisory (never a dispatch gate), so a missing/unreadable file
   *  degrades to an explicit placeholder (see loadArchitectureChapter) rather than failing the
   *  round — keeping this a deps-level default also avoids growing config.ts, which two sibling
   *  role-issue PRs are touching concurrently. */
  planMdPath?: string;
  /** The round's aligned-goals text from the (not yet shipped, #89) PO/goal-alignment
   *  peripheral. Default: an explicit "not available yet" placeholder — #89 hasn't landed, so
   *  round.ts's `aligning` phase is still noopPeripheralStub and has nothing real to hand off.
   *  Once #89 ships, its caller wires this through without any architect.ts change. */
  alignedGoals?: string;
}

/** The round-scoped idempotency marker (#77 decision 4's `<!-- sapwood:round:N:<phase> -->`
 *  convention, same as plan-review.ts's planReviewMarker) — embedded verbatim in the round
 *  design note comment the architect session posts, so the note is traceable on GitHub itself,
 *  not only in sapwood's own sqlite ledger. */
export function architectMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:architecting -->`;
}

export function defaultArchitectPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own default paths.
  return join(here, "..", "prompts", "architect.md");
}

export function defaultPlanMdPath(): string {
  return join(process.cwd(), "docs", "PLAN.md");
}

const NO_ALIGNED_GOALS_YET =
  "(No PO/goal-alignment peripheral output is available yet — #89 has not shipped. Proceed " +
  "using only the architecture chapter and this round's candidate issues below.)";

/** Extract PLAN.md's "## Architecture" chapter (case-insensitive heading match) — same
 *  heading-to-next-heading-of-equal-or-shallower-level slicing forge.ts's
 *  extractVerificationPlan uses, generalized to an arbitrary heading pattern. null when no such
 *  heading exists; callers must supply an explicit fallback (never silently substitute the
 *  whole file — a fail-closed stance the caller documents at each call site). */
export function extractArchitectureChapter(planMd: string): string | null {
  const heading = /^(#{1,6})\s*Architecture\b[^\n]*$/im.exec(planMd);
  if (!heading) return null;
  const level = heading[1]!.length;
  const afterHeading = planMd.slice(heading.index + heading[0].length);
  const nextHeading = new RegExp(`^#{1,${level}}\\s`, "m").exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  return (heading[0] + section).trim();
}

/** Load + extract the architecture chapter from disk. Missing/unreadable file or missing
 *  heading both degrade to an explicit placeholder string (never a throw, never a silent
 *  substitution of the raw file) — architecture review is advisory, so a docs read failure
 *  must not abort the round; the placeholder makes the degradation visible to anyone reading
 *  the architect's rendered prompt/transcript. */
export function loadArchitectureChapter(path: string): string {
  if (!existsSync(path)) {
    return `(PLAN.md not found at ${path} — proceeding with no architecture chapter available.)`;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return `(PLAN.md at ${path} could not be read: ${String(e)} — proceeding with no architecture chapter available.)`;
  }
  const chapter = extractArchitectureChapter(text);
  return chapter ?? `(No "## Architecture" heading found in ${path} — proceeding with no architecture chapter available.)`;
}

/** One candidate issue's block in the substituted prompt: number, title, labels, full body —
 *  the same information density the plan-reviewer prompt gives a single issue, repeated per
 *  candidate here since the architect judges the whole batch at once. */
function formatCandidate(issue: Issue): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "(none)";
  return `### #${issue.number} — ${issue.title}\nLabels: ${labels}\n\n${issue.body ?? ""}`;
}

/** `{{var}}` substitution for the architect prompt — same fail-closed-on-unknown-var regex
 *  substitution as plan-review.ts's renderRolePrompt, but with the architect's OWN var set
 *  (round-scoped, not single-issue-scoped, so ISSUE_VARS doesn't apply here). */
export function renderArchitectPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (Object.hasOwn(vars, name)) return vars[name]!;
    throw new Error(
      `architect prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`,
    );
  });
}

/** Builds the `architecting` phase's PeripheralStub. Round-level idempotence (#77 decision 4,
 *  the same coarse "whole phase is one unit of idempotent work" stance plan-review.ts's
 *  createPlanReviewStub documents): a non-null incoming marker means a prior attempt this round
 *  already ran (and externalized) the architect's work, so it is returned UNCHANGED with no
 *  session run. No candidates -> nothing to design-review, marker set with no session run
 *  either (same shape as plan-review's own "no candidates" short-circuit). */
export function createArchitectStub(deps: ArchitectDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker }; // already externalized this round — no duplicate work
      // The candidate pool for this phase is the same "still awaiting gate⓪" set plan_review
      // consumes next in the sequence (aligning -> architecting -> plan_review -> executing):
      // Ready-lane, OPEN, not yet settled needs-human/blocked/verifyNa/planApproved. Sorted by
      // number for a DETERMINISTIC round-design-note anchor (see below) — getIssuesNeedingPlanReview
      // makes no ordering guarantee of its own.
      const candidates = [...(await deps.forge.getIssuesNeedingPlanReview())].sort((a, b) => a.number - b.number);
      if (candidates.length === 0) return { marker: architectMarker(roundId) };

      const template = loadRolePromptTemplate(deps.cfg.roles.architect.promptFile, defaultArchitectPromptPath());
      const architectureChapter = loadArchitectureChapter(deps.planMdPath ?? defaultPlanMdPath());
      // The round design note needs SOME issue to live on (GitHub has no round/project-level
      // comment surface this role can write to — its tools are issue comment/edit only); the
      // lowest-numbered candidate is an arbitrary but deterministic, reproducible anchor.
      const anchor = candidates[0]!;
      const marker_ = architectMarker(roundId);

      const prompt = renderArchitectPrompt(template, {
        "round.id": String(roundId),
        "round.marker": marker_,
        "round.designNoteIssue": String(anchor.number),
        "round.alignedGoals": deps.alignedGoals ?? NO_ALIGNED_GOALS_YET,
        "plan.architectureChapter": architectureChapter,
        "candidates.summary": candidates.map(formatCandidate).join("\n\n---\n\n"),
        "labels.blocked": deps.cfg.labels.blocked,
      });

      const role = deps.cfg.roles.architect;
      const result = await deps.runner.run({ roleId: "architect", prompt, model: role.model, effort: role.effort });
      const iso = (deps.now ? deps.now() : new Date()).toISOString();
      // Spend is round-scoped, not tied to any single issue — `issue` is a plain int column
      // with no FK, so 0 is a documented sentinel ("no single issue"), not a real issue number.
      deps.state.recordSpend(result.name, 0, result.costUsd, iso, result.modelUsage);

      return { marker: marker_ };
    },
  };
}
