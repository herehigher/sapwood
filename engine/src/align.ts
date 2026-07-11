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
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry } from "./peripheral.js";
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
  /** Override for loadPlanMd's path — tests inject a fixed string via a temp file. A real
   *  caller omits this and gets `cfg.roles.architect.planMdPath` (#104): align.ts and
   *  architect.ts both read the repo's architecture doc, so they honor the SAME config key
   *  rather than each hardcoding their own default. */
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
      const template = loadRolePromptTemplate(deps.cfg.roles.po.promptFile, defaultPoPromptPath());
      const role = deps.cfg.roles.po;
      const l = deps.cfg.labels;
      const mark = alignMarker(roundId);

      /** One PO session, spend ledgered under its own name. RoleRunner.run never throws on the
       *  session's OWN outcome (peripheral.ts) — failed/timeout is a normal return the caller
       *  must handle. #104: ported to peripheral.ts's shared runSessionWithRetry (outcome-check
       *  -> retry-once -> visible-degradation, ONE implementation for architect/align/harvest/
       *  retro). Same retry-once stance as plan-review.ts's reviewer sessions (fable PR #101 P2,
       *  mirroring PR #100's architect fix); the divergence from plan-review's needs-human
       *  escalation is deliberate and cheap here: this phase runs PRE-Ready, so a double failure
       *  never poisons a dispatch decision — the round advances (marker still set) and the
       *  degradation is made observable (a durable event + a log line) instead of wedging the
       *  round; the next round retries naturally. */
      const runSession = (
        roleId: "po-align" | "po-triage",
        prompt: string,
        issue: number,
        degradeEvent: "po-degraded" | "triage-degraded",
      ): ReturnType<typeof runSessionWithRetry> =>
        runSessionWithRetry({
          runner: deps.runner,
          state: deps.state,
          session: {
            roleId, prompt, model: role.model, effort: role.effort,
            allowedTools: PO_ALLOWED_TOOLS, disallowedTools: PO_DISALLOWED_TOOLS,
          },
          // Align spend is round-scoped, not tied to any single issue — `issue` is a plain int
          // column with no FK, so 0 is a documented sentinel ("no single issue").
          issue,
          now: deps.now ?? (() => new Date()),
          degradeEvent,
          degradePayload: (result) => ({
            round_id: roundId, ...(issue !== 0 ? { issue } : {}), outcome: result.outcome, session: result.name,
          }),
          degradeMessage: (result) =>
            `[sapwood:po] round ${roundId}: ${roleId} session failed twice (${result.outcome})` +
            `${issue !== 0 ? ` for issue #${issue}` : ""} — proceeding (pre-Ready, low stakes; ` +
            `the next round retries naturally)`,
        });

      // ── Alignment/decomposition pass: ONE session, dispatched even with an unscoped round
      // (round.milestone unset) — decomposition still has docs/PLAN.md to work from alone. ──
      const before = new Set(await deps.forge.listOpenIssueNumbers());
      const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
        "po.mode": "align",
        "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against docs/PLAN.md alone)",
        // #104: deps.planMdPath is a TEST override only now — a real caller omits it and gets
        // cfg.roles.architect.planMdPath (the same key architect.ts's own PLAN.md read honors).
        "plan.md": loadPlanMd(deps.planMdPath ?? deps.cfg.roles.architect.planMdPath),
      });
      await runSession("po-align", alignPrompt, 0, "po-degraded");

      // Discover what the session actually made (it has no structured return channel — see
      // peripheral.ts's module doc) via a before/after diff of open issue numbers. Runs even
      // after a degraded session: a session that failed AFTER creating some issues still needs
      // those creations stamped/checked below. KNOWN, ACCEPTED RACE (fable PR #101 nit): an
      // issue created CONCURRENTLY by a human (or another agent) while the session runs also
      // lands in this diff and gets mistaken for PO output — stamped origin:agent, possibly
      // needs-human'd. Low probability (the window is one session), mild consequence (wrong
      // provenance label + an explanatory comment a human can see and revert; never a dispatch
      // enablement — the containment below only ever BLOCKS), and the alternative (parsing the
      // session's freeform output for issue URLs) trades a visible mislabel for silent misses.
      const after = await deps.forge.listOpenIssueNumbers();
      const created = after.filter((n) => !before.has(n));

      for (const issueNumber of created) {
        // The session cannot have set board Status itself (no gh api/project capability) —
        // and labels are the orchestrator's job: origin:agent is stamped here directly,
        // unconditionally, so the fact is guaranteed rather than merely best-effort. See
        // peripheral.ts's PO_ALLOWED_TOOLS/PO_DISALLOWED_TOOLS docs for the structural boundary.
        const labels = await deps.forge.getIssueLabels(issueNumber);
        if (!labels.includes(l.originAgent)) await deps.forge.addLabel(issueNumber, l.originAgent);

        // AUTHORITATIVE gate⓪-bypass containment (security review, PR #101): the create
        // --label deny in PO_DISALLOWED_TOOLS is only the best-effort pattern layer — a
        // created issue that nonetheless carries a dispatch-path label (plan:approved /
        // verify:n/a) would walk straight through getReadyIssues once a human moves it to
        // Ready, without any plan-reviewer ever seeing it. Same stance as plan-review.ts's
        // drafter label post-check: needs-human is an unconditional dispatch blocker, so
        // applying it CONTAINS the poisoned label without needing label-removal capability.
        // NB: plan-review's own post-check cannot cover this — it snapshots labels of
        // pre-existing issues; a freshly created issue has no before-snapshot.
        const poisoned = [
          ...(labels.includes(l.planApproved) ? [`\`${l.planApproved}\``] : []),
          ...(labels.includes(l.verifyNa) ? [`\`${l.verifyNa}\``] : []),
        ];
        if (poisoned.length > 0) {
          await deps.forge.addLabel(issueNumber, l.needsHuman);
          await deps.forge.addIssueComment(
            issueNumber,
            `Created by sapwood's round ${roundId} PO alignment pass, but carrying ` +
              `${poisoned.join(", ")} at creation — a dispatch-path label the PO must never ` +
              `self-apply (gate⓪ bypass). Applying \`${l.needsHuman}\` to contain it; a human ` +
              `needs to remove the poisoned label(s) before this issue can proceed.\n\n${mark}`,
          );
          continue;
        }

        const body = await deps.forge.getIssueBody(issueNumber);
        const hasPlan = extractVerificationPlan(body) != null;
        const note = hasPlan
          ? `Created by sapwood's round ${roundId} PO alignment pass (goal decomposition).`
          : `Created by sapwood's round ${roundId} PO alignment pass, but with no verification ` +
            `plan detected — applying \`${l.needsHuman}\` so it is never dispatched ` +
            `planless. A human (or a future triage pass) needs to supply one.`;
        if (!hasPlan) await deps.forge.addLabel(issueNumber, l.needsHuman);
        await deps.forge.addIssueComment(issueNumber, `${note}\n\n${mark}`);
      }

      // ── Triage pass: existing plan-less issues get a plan drafted directly into the body.
      // Marker-idempotent at the round-ledger granularity above; ALSO naturally idempotent at
      // the per-issue level, since a successfully drafted issue now carries a plan section and
      // so no longer matches getIssuesNeedingPlanTriage's candidate query on any later run. ──
      const triageCandidates = await deps.forge.getIssuesNeedingPlanTriage();
      for (const issue of triageCandidates) {
        const triagePrompt = renderRolePrompt(template, issue, deps.cfg, {
          "po.mode": "triage",
          "round.milestone": deps.cfg.round.milestone ?? "",
          "plan.md": "",
        });
        const result = await runSession("po-triage", triagePrompt, issue.number, "triage-degraded");
        // The success comment is EARNED by the re-fetched body, never by the session's exit
        // code (fable PR #101 P2): a failed/no-op session must not leave a comment claiming a
        // draft that never landed — that false audit-trail entry would also invert the natural
        // per-issue idempotence above (the un-drafted issue re-matches next round while
        // already "documented" as drafted). Still planless after the session (and its retry)
        // -> no comment, a durable degradation event, and the candidate re-matches next round.
        const bodyAfter = await deps.forge.getIssueBody(issue.number);
        if (extractVerificationPlan(bodyAfter) != null) {
          await deps.forge.addIssueComment(
            issue.number,
            `PO triage pass (round ${roundId}) drafted a plan into this issue's body.\n\n${mark}`,
          );
        } else if (result.outcome === "done") {
          // A "done" session that left the body planless is its own degradation shape (the
          // failed-twice shape was already externalized inside runSession — not repeated here).
          try {
            deps.state.appendEvent("triage-degraded", { round_id: roundId, issue: issue.number, outcome: "no-plan-after-draft" });
          } catch { /* state write failed — the console line below still lands */ }
          console.error(
            `[sapwood:po] round ${roundId}: triage left issue #${issue.number} still planless — ` +
              `no success comment posted; the candidate re-matches next round`,
          );
        }
      }

      return { marker: mark };
    },
  };
}
