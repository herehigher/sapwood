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
// verification-plan-reviewer/verification-plan-drafter (one BODY block per session, one issue per session), a single
// harvest session briefs a VARIABLE number of issues in one pass — the round's whole
// needs-human set — so its comment bodies travel as an ARRAY of short strings INSIDE the JSON
// metadata rather than the single sentinel-delimited BODY segment: harvest's own prompt caps
// each comment at "a few lines, not a report" (no revised-issue-body-scale markdown, no code
// fences to protect from JSON-string escaping), so the escaping cost the BODY segment exists to
// avoid for plan-review's long bodies never applies here.
//
// Harvest's write targets are CLOSED-FORM PRE-SESSION (unlike architect's from-a-pool choice,
// PR4): the round artifact (#123, round-artifact.ts — supersedes the old gatherRoundFacts)
// computes the round's needsHumanIssues set from the durable ledger
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
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import {
  envFailureHook,
  ROLE_DISALLOWED_TOOLS,
  type RoleRunner,
  type RoleSessionResult,
  runSessionWithRetry,
} from "../roles/peripheral.js";
import { loadRolePromptTemplate } from "../roles/plan-review.js";
import type { State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import type { PeripheralStub } from "./round.js";
import { buildRoundArtifact, capRoundArtifactMarkdown, type RoundArtifact, renderRoundArtifactMarkdown } from "./round-artifact.js";

/** Harvest's deny-list: harvest writes issue COMMENTS only (see prompts/harvest.md), never a
 *  body edit and never a label — it gets a distinct named export from the base for the same
 *  call-site-documentation reason PO_DISALLOWED_TOOLS does (peripheral.ts). Before #235 PR-B
 *  this carried an EXTRA `Bash(gh issue edit*)` pattern-deny on top of the base, closing the
 *  self-applying-a-label pitfall class the #101 push-time security review flagged. #235 PR-B's
 *  blanket Bash deny (ROLE_DISALLOWED_TOOLS) already makes that redundant — no Bash grant
 *  reaches `gh` to mutate a label with in the first place — so the extra pattern is dropped.
 *  Residual containment is unchanged and structural either way: harvest's briefing targets are
 *  exclusively needs-human issues, and needs-human is an UNCONDITIONAL dispatch blocker
 *  (isDispatchable checks it before any other label), so even a rogue label write there cannot
 *  make anything dispatchable. */
export const HARVEST_DISALLOWED_TOOLS = ROLE_DISALLOWED_TOOLS;

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
  now: () => Date;
  log?: (message: string) => void;
}

/** The round-scoped idempotency marker this phase persists via round.ts's ledger (#77
 *  decision 4's `<!-- sapwood:round:N:<phase> -->` convention, same shape as
 *  plan-review.ts's planReviewMarker). */
export function harvestMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:harvesting -->`;
}

export function defaultHarvestPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as plan-review.ts's defaultVerificationPlanReviewerPromptPath.
  return join(here, "..", "..", "prompts", "harvest.md");
}

/** #123: the harvest prompt's `{{var}}` map, derived ENTIRELY from the round artifact — the
 *  engine-built mechanical record round-artifact.ts assembles from the ledger. gatherRoundFacts
 *  and the RoundLedgerFacts shape are gone (assembleRoundArtifact supersedes both; the durable
 *  `harvest-summary` event they fed is superseded by the persisted round_artifacts row): harvest
 *  keeps only its JUDGMENT duties — deciding what to SAY about each needs-human issue — while
 *  every number it references is pre-computed. The individual fact vars are kept alongside the
 *  new {{round.artifact}} block so a user's custom promptFile written against the pre-#123
 *  variable set still renders (renderFactsTemplate fails closed on unknown vars). */
export function factVars(artifact: RoundArtifact, artifactMd: string): Record<string, string> {
  const needsHuman = artifact.escalations.needsHuman;
  const egressSuspects = artifact.egressSuspects;
  return {
    "round.id": String(artifact.roundId),
    "round.artifact": artifactMd,
    "round.prsOpened": String(artifact.prsOpened),
    "round.prsMerged": String(artifact.prsMerged),
    "round.issuesClosed": String(artifact.issuesClosed),
    "round.spentUsd": artifact.spendUsd.toFixed(2),
    "round.roundBudgetUsd": artifact.roundBudgetUsd.toFixed(2),
    "round.needsHumanCount": String(needsHuman.length),
    "round.needsHumanList": needsHuman.length > 0 ? needsHuman.map((n) => `#${n}`).join(", ") : "(none)",
    "round.egressSuspectCount": String(egressSuspects.length),
    // Codex sol-high PR #417 review, P2-a follow-up (delta re-review): a role session's own
    // egress-suspect events (peripheral.ts's #410 WebFetch/WebSearch audit) carry `issue: 0`
    // — the SAME round-level sentinel every other role-session record uses, never a real
    // issue number. `issue #0: ...` would read as a reference to a nonexistent issue; render
    // these as a role-session line instead, keyed off `worker` (the session's own lane/
    // sentinel name), matching round-artifact.ts's `renderRoundArtifactMarkdown` fix for the
    // SAME underlying data. Worker-leg events (a real issue number) are unaffected.
    "round.egressSuspectList":
      egressSuspects.length > 0
        ? egressSuspects
            .map((s) => {
              // #387 (F18): loopback-only hits stay in the list (tag, not exclude) but say so,
              // so a harvest prompt reading this line doesn't weigh dev-server smoke checks the
              // same as real public egress.
              const target = s.target === "loopback" ? " (loopback)" : "";
              return s.issue === 0 ? `role session ${s.worker}: ${s.executable}${target}` : `issue #${s.issue}: ${s.executable}${target}`;
            })
            .join(", ")
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
    throw new Error(`role prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`);
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
const HarvestMetadataSchema = z
  .object({
    comments: z.array(
      z
        .object({
          issue: z.number().int().positive(),
          body: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

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
        reason:
          `comment targets issue #${c.issue}, outside this round's needs-human set ` +
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
      // #123: the round artifact IS this phase's mechanical input — built mid-round (endedAt
      // null, unpersisted: the FINAL persisted artifact is round.ts's own close-time build) and
      // rendered into the prompt as {{round.artifact}}. The pre-#123 `harvest-summary` event is
      // gone: the persisted round_artifacts row is the machine-readable round record now (one
      // source of truth), and harvest keeps only judgment + the needs-human briefing.
      const artifact = buildRoundArtifact(deps.state, round, deps.cfg.cost.roundBudgetUsd, null);
      const needsHumanIssues = artifact.escalations.needsHuman;
      // #394 (F23): did THIS call actually dispatch a harvest session? Nothing-to-brief
      // (needsHumanIssues.length === 0) is the ONLY skip path — see PeripheralStub.ranSession's
      // own doc for why round.ts's empty-spin breaker needs this distinguished from "ran and
      // succeeded silently".
      let ranSession = false;
      if (needsHumanIssues.length > 0) {
        ranSession = true;
        const template = loadRolePromptTemplate(deps.cfg.roles.harvest.promptFile, defaultHarvestPromptPath());
        const artifactMd = capRoundArtifactMarkdown(renderRoundArtifactMarkdown(artifact), deps.cfg.roles.harvest.artifactMaxChars);
        // #701: the configured default working language for the needs-human briefing comments
        // this role composes (an issues/PRs surface) — see config.ts's `language` section doc
        // comment.
        const rendered = renderFactsTemplate(template, {
          ...factVars(artifact, artifactMd),
          "lang.issuesAndPrs": deps.cfg.language.issuesAndPrs,
        });
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
            roleId: "harvest",
            prompt: rendered,
            model: role.model,
            effort: role.effort,
            fallbackModel: role.fallbackModel,
            disallowedTools: HARVEST_DISALLOWED_TOOLS,
          },
          // Round-level spend, no single associated issue — 0 is the sentinel (spend_ledger's
          // `issue` column is NOT NULL; harvest is the first role whose session isn't scoped
          // to one issue).
          issue: 0,
          now: deps.now,
          ...(deps.log !== undefined ? { log: deps.log } : {}),
          // #236: record this phase's ambient-context manifest for EVERY attempt (round-scoped,
          // no single associated issue — same round-level shape as `issue: 0` above). See
          // peripheral.ts's RetriedSession.contextManifest doc for the (round, phase, role,
          // session, attempt) key this writes under.
          contextManifest: { roundId, phase: "harvesting", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
          degradeEvent: "harvest-degraded",
          // Payload shape preserved EXACTLY (pre-#110): {round_id, outcome, session, attempts}.
          // `outcome` is the SESSION's own outcome (RoleSessionResult.outcome) — a "done" session
          // that degraded on invalid output still reports "done" here; harvestDegradeReason
          // (below, stderr-only) is where the invalid-output cause is actually named.
          degradePayload: (result) => ({
            round_id: roundId,
            outcome: result.outcome,
            session: result.name,
            attempts: 2,
          }),
          degradeMessage: (result) =>
            `[sapwood:harvest] round ${roundId}: ${harvestDegradeReason(result, needsHumanIssues)} — ` +
            `closing the harvesting phase WITHOUT posting round-context comments (degraded, see ` +
            `the harvest-degraded event); the run is not blocked`,
          isValid: (result) => validateHarvestOutput(result.resultText ?? "", needsHumanIssues).ok,
          // #374: quota/429 parks instead of degrading — see peripheral.ts's envFailureHook doc.
          envFailure: envFailureHook(deps.cfg, deps.state),
        });
        // Every comment write originates from a SCHEMA-VALIDATED, SET-VALIDATED session decision
        // (module doc) — the session itself never touches `gh`. A degraded (still-invalid-after-
        // retry, or session-failed-twice) result posts nothing: runSessionWithRetry already fired
        // the harvest-degraded event/stderr line above, and honoring a result that never
        // validated would be exactly the silent-partial-result outcome this rework exists to
        // prevent.
        if (result.outcome === "done") {
          const validated = validateHarvestOutput(result.resultText ?? "", needsHumanIssues);
          if (validated.ok) {
            const roundMarker = harvestMarker(roundId);
            for (const c of validated.comments) {
              await deps.forge.addIssueComment(c.issue, `${c.body}\n\n${roundMarker}`);
            }
          }
        }
      }
      return { marker: harvestMarker(roundId), ranSession };
    },
  };
}
