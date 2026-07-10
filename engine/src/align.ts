// align.ts — implements PeripheralStub for the `aligning` phase (#89, the PO/product-owner
// peripheral from #77): goal alignment/decomposition at round start, plus the round-start
// triage pass that keeps gate⓪ fed. Complements (not replaces) plan-review.ts's #77 Amendment
// 2 on-demand self-heal — that phase repairs a Ready-lane plan the reviewer just bounced;
// this phase runs earlier and proactively, so a plan-less issue already carries one by the
// time a human ever moves it to `Ready` (round-start batch path per #89's comment amendment).
//
// Locked decision 5 (only a human confirms `Ready`) is enforced STRUCTURALLY, not by
// convention: the PO session's allowed tools (PO_ALLOWED_TOOLS) carry no `gh api`/`gh project`
// capability at all — the only channel GithubForge.setBoardStatus uses — so there is no
// board-status write path for this role to reach even if a session tried. This module never
// calls forge.setBoardStatus either.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeripheralStub } from "./round.js";
import type { IForge, Issue } from "./forge.js";
import { extractVerificationPlan } from "./forge.js";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { RoleRunner } from "./peripheral.js";
import { PO_ALLOWED_TOOLS } from "./peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "./plan-review.js";

/** #89's round convention (same shape as plan-review.ts's planReviewMarker): the round
 *  ledger's persisted marker for this phase, also embedded in every comment this phase posts
 *  so a round's alignment activity is traceable directly on GitHub. */
export function alignMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:aligning -->`;
}

export function defaultPoPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own defaults.
  return join(here, "..", "prompts", "po.md");
}

const DEFAULT_PLAN_MD_PATH = "docs/PLAN.md";

/** Best-effort docs/PLAN.md loader: the PO's alignment context, substituted into the prompt
 *  (the sandboxed session has no Read tool, same "substitute it in" discipline as
 *  {{issue.body}} elsewhere). Contained — a missing/unreadable/moved doc file never aborts the
 *  round; the alignment session simply proceeds with an empty note, the same fail-toward-more-
 *  work stance as round.ts's other contained reads (e.g. checkFinalMilestone). */
export function loadPlanMd(path: string = DEFAULT_PLAN_MD_PATH): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Placeholder Issue for template rendering in "align" mode: there is no single issue in scope
// (the whole point of that mode is creating NEW ones) — po.md's align section never references
// {{issue.*}}, so an empty/zero stand-in is never actually substituted into rendered output.
const NO_ISSUE: Issue = { number: 0, title: "", labels: [] };

export interface AlignDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (RoleRunner itself is tested against a
   *  real `claude` stub binary in peripheral.test.ts — this orchestrator's own tests fake the
   *  runner directly, same split as plan-review.ts's PlanReviewDeps). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
  /** Override for loadPlanMd's path — tests inject a fixed string via a temp file, or rely on
   *  the real docs/PLAN.md when omitted. */
  planMdPath?: string;
}

/** Builds the `aligning` phase's PeripheralStub. Idempotent at the round-ledger granularity
 *  (same rerun-not-resume contract as plan-review.ts's createPlanReviewStub): a non-null
 *  incoming marker means a PRIOR attempt this round already ran and externalized this phase's
 *  work, so it is returned UNCHANGED with nothing re-run. */
export function createAligningStub(deps: AlignDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker };
      const iso = (): string => (deps.now ? deps.now() : new Date()).toISOString();
      const template = loadRolePromptTemplate(deps.cfg.roles.po.promptFile, defaultPoPromptPath());
      const role = deps.cfg.roles.po;
      const mark = alignMarker(roundId);

      // ── Alignment/decomposition pass: ONE session, dispatched even with an unscoped round
      // (round.milestone unset) — decomposition still has docs/PLAN.md to work from alone. ──
      const before = new Set(await deps.forge.listOpenIssueNumbers());
      const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
        "po.mode": "align",
        "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against docs/PLAN.md alone)",
        "plan.md": loadPlanMd(deps.planMdPath),
      });
      const alignResult = await deps.runner.run({
        roleId: "po-align", prompt: alignPrompt, model: role.model, effort: role.effort,
        allowedTools: PO_ALLOWED_TOOLS,
      });
      deps.state.recordSpend(alignResult.name, 0, alignResult.costUsd, iso(), alignResult.modelUsage);

      // Discover what the session actually made (it has no structured return channel — see
      // peripheral.ts's module doc) via a before/after diff of open issue numbers.
      const after = await deps.forge.listOpenIssueNumbers();
      const created = after.filter((n) => !before.has(n));

      for (const issueNumber of created) {
        // The session cannot have touched origin:agent or Ready itself (no gh api/project
        // capability, and origin:agent isn't in its allowed tools either) — this orchestrator
        // stamps it directly, unconditionally, so the fact is guaranteed rather than merely
        // best-effort. See peripheral.ts's PO_ALLOWED_TOOLS doc for the structural boundary.
        const labels = await deps.forge.getIssueLabels(issueNumber);
        if (!labels.includes("origin:agent")) await deps.forge.addLabel(issueNumber, "origin:agent");

        const body = await deps.forge.getIssueBody(issueNumber);
        const hasPlan = extractVerificationPlan(body) != null;
        const note = hasPlan
          ? `Created by sapwood's round ${roundId} PO alignment pass (goal decomposition).`
          : `Created by sapwood's round ${roundId} PO alignment pass, but with no verification ` +
            `plan detected — applying \`${deps.cfg.labels.needsHuman}\` so it is never dispatched ` +
            `planless. A human (or a future triage pass) needs to supply one.`;
        if (!hasPlan) await deps.forge.addLabel(issueNumber, deps.cfg.labels.needsHuman);
        await deps.forge.addIssueComment(issueNumber, `${note}\n\n${mark}`);
      }

      // ── Triage pass: existing plan-less issues get a plan drafted directly into the body.
      // Marker-idempotent at the round-ledger granularity above; ALSO naturally idempotent at
      // the per-issue level, since a successfully drafted issue now carries a plan section and
      // so no longer matches getIssuesNeedingPlanTriage's candidate query on any later run. ──
      const triageCandidates = await deps.forge.getIssuesNeedingPlanTriage();
      const triaged: number[] = [];
      for (const issue of triageCandidates) {
        const triagePrompt = renderRolePrompt(template, issue, deps.cfg, {
          "po.mode": "triage",
          "round.milestone": deps.cfg.round.milestone ?? "",
          "plan.md": "",
        });
        const result = await deps.runner.run({
          roleId: "po-triage", prompt: triagePrompt, model: role.model, effort: role.effort,
          allowedTools: PO_ALLOWED_TOOLS,
        });
        deps.state.recordSpend(result.name, issue.number, result.costUsd, iso(), result.modelUsage);
        triaged.push(issue.number);
        await deps.forge.addIssueComment(
          issue.number,
          `PO triage pass (round ${roundId}) drafted a plan into this issue's body.\n\n${mark}`,
        );
      }

      return { marker: mark };
    },
  };
}
