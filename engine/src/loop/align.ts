// align.ts — implements PeripheralStub for the `aligning` phase (#89, the PO/product-owner
// peripheral from #77): goal alignment/decomposition at round start, plus the round-start
// triage pass that keeps gate⓪ fed. Complements (not replaces) plan-review.ts's #77 Amendment
// 2 on-demand self-heal — that phase repairs a Ready-lane plan the reviewer just bounced;
// this phase runs earlier and proactively, so a plan-less issue already carries one by the
// time a human ever moves it to `Ready` (round-start batch path per #89's comment amendment).
//
// #110 PR2 rework (same pattern as PR1's plan-review.ts rewrite): the PO session is PURE
// COMPUTATION now — no `gh` tool grant is ever exercised by either mode's prompt. Each
// session's final message ends in a structured block (structured-output.ts's sentinel
// format); THIS module parses it, validates it against a per-mode zod schema, and performs
// EVERY GitHub write itself via IForge. Malformed/schema-invalid output is an INVALID attempt
// for `runSessionWithRetry`'s `isValid` hook — retry once, then align's EXISTING degrade path
// (a durable `po-degraded`/`triage-degraded` event + a log line; the round is never wedged —
// align is advisory/pre-Ready, see createAligningStub below, unchanged from pre-#110).
//
// AUTHORITATIVE gate⓪-bypass containment from the pre-#110 design (a created issue smuggling
// `plan:approved`/`verify:n/a` via `gh issue create --label`) is DELETED OUTRIGHT, not ported:
// the align-mode metadata schema has no label field at all, and the engine is the only thing
// that ever calls `forge.createIssue` (title + body only — see IForge) or `forge.addLabel`, so
// a created issue simply cannot carry a dispatch-path label at creation. The behavior the old
// post-check defended against is now structurally impossible, exactly like the plan-drafter's
// pre-#110 label post-check in plan-review.ts (see that module's doc).
//
// Locked decision 5 (only a human confirms `Ready`) remains enforced STRUCTURALLY: this module
// never calls forge.setBoardStatus, and the PO session's allowed tools (PO_ALLOWED_TOOLS) carry
// no `gh api`/`gh project` capability at all — the only channel GithubForge.setBoardStatus uses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import { resolveRoundDirective } from "../config/directive.js";
import type { IForge, Issue } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import { capDigest } from "../retro/retro-digest.js";
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "../roles/plan-review.js";
import type { State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import type { PeripheralStub } from "./round.js";

/** #89's round convention (same shape as plan-review.ts's planReviewMarker): the round
 *  ledger's persisted marker for this phase, also embedded in every comment this phase posts
 *  so a round's alignment activity is traceable directly on GitHub. */
export function alignMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:aligning -->`;
}

export function defaultPoPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own defaults.
  return join(here, "..", "..", "prompts", "po.md");
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

const NO_OPEN_ISSUES = "(no open issues yet)";
const BACKLOG_READ_FAILED = "(backlog digest unavailable: open-issue read failed)";

/** Engine-side PO context (#215): deterministic, milestone-scopeable via RoundScopedForge,
 *  and contained on forge failure. Sorting here (rather than trusting gh's presentation order)
 *  makes crash-rerun assembly byte-identical for the same backlog. Every return path is capped
 *  at the boundary so placeholders cannot accidentally bypass the configured size limit. */
export async function buildBacklogDigest(forge: IForge, cfg: SapwoodConfig): Promise<string> {
  let uncapped: string;
  try {
    const issues = await forge.listOpenIssues();
    if (issues.length === 0) {
      uncapped = NO_OPEN_ISSUES;
    } else {
      const ordered = [...issues].sort((a, b) => a.number - b.number);
      uncapped = ordered
        .map((issue) => {
          const holds = cfg.escalation.humanLabels.filter((label) => labelsInclude(issue.labels, label));
          const annotation = holds.length > 0 ? ` [hold: ${holds.join(", ")}]` : "";
          return `- #${issue.number} — ${issue.title}${annotation}`;
        })
        .join("\n");
    }
  } catch {
    uncapped = BACKLOG_READ_FAILED;
  }
  return capDigest(uncapped, cfg.roles.po.backlogDigestMaxChars);
}

// Placeholder Issue for template rendering in "align" mode: there is no single issue in scope
// (the whole point of that mode is creating NEW ones) — po.md's align section never references
// {{issue.*}}, so an empty/zero stand-in is never actually substituted into rendered output.
const NO_ISSUE: Issue = { number: 0, title: "", labels: [] };

// ── #110 PR2: structured-output schemas + validators ────────────────────────────────────────
//
// Two independent per-mode schemas (align creates zero or more NEW issues; triage revises the
// body of ONE existing issue) around the SAME outer sentinel shape structured-output.ts parses
// — issue #110's Design section anticipates each PR2-4 role adding its own schema this way.
//
// Align's deliverable is fundamentally a LIST of (title, body) pairs, which the outer format
// (one JSON metadata segment + one raw BODY segment) doesn't have a native shape for. Titles are
// small closed-form strings, so they travel in the JSON metadata array; bodies are long markdown
// that must never be JSON-string-escaped (structured-output.ts's module doc — a body containing
// its own code fences would break escaping under no supervision). So the single BODY segment
// carries EVERY issue's body, each wrapped in a locally-scoped `<<<ISSUE>>>`/`<<<END_ISSUE>>>`
// pair, one per metadata array entry, in order — a nested application of the same fail-closed
// containment discipline structured-output.ts's own parser uses (only-whitespace between/after
// segments, no embedded sentinels), just scoped to this module rather than shared, since no
// other #110 PR needs a multi-body BODY segment.

const AlignIssueMetaSchema = z.object({ title: z.string().min(1) }).strict();
const AlignMetadataSchema = z.object({ issues: z.array(AlignIssueMetaSchema) }).strict();
const TriageMetadataSchema = z.object({ issue: z.number().int().positive() }).strict();

const ISSUE_BODY_START = "<<<ISSUE>>>";
const ISSUE_BODY_END = "<<<END_ISSUE>>>";

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Split align mode's BODY segment into exactly `count` per-issue body segments, in the SAME
 *  order as the metadata `issues` array. Mirrors parseStructuredBlock's own fail-closed
 *  containment rules at this nested layer: only whitespace is allowed before the first segment,
 *  between segments, and after the last one; a segment containing either of its own delimiters
 *  is ambiguous. Returns null on ANY shape mismatch — never a partial/best-guess split. */
function splitAlignIssueBodies(raw: string, count: number): string[] | null {
  const bodies: string[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const startIdx = raw.indexOf(ISSUE_BODY_START, cursor);
    if (startIdx === -1) return null; // missing segment
    if (raw.slice(cursor, startIdx).trim() !== "") return null; // stray text before/between
    const contentStart = startIdx + ISSUE_BODY_START.length;
    const endIdx = raw.indexOf(ISSUE_BODY_END, contentStart);
    if (endIdx === -1) return null; // truncated segment
    const body = raw.slice(contentStart, endIdx).replace(/^\n/, "").replace(/\n$/, "");
    if (body.trim() === "" || body.includes(ISSUE_BODY_START) || body.includes(ISSUE_BODY_END)) return null;
    bodies.push(body);
    cursor = endIdx + ISSUE_BODY_END.length;
  }
  if (raw.slice(cursor).trim() !== "") return null; // stray text after the last segment
  return bodies;
}

export type AlignValidation = { ok: true; issues: Array<{ title: string; body: string }> } | { ok: false; reason: string };

/** Parse + schema-validate a po-align session's structured output. Deliberately does NOT
 *  content-check each issue body for a verification-plan section (unlike plan-review.ts's
 *  validateReviewerOutput/validateDrafterOutput): a planless created issue is not an INVALID
 *  session attempt here, it is a normal per-issue outcome the caller labels `needs-human` for
 *  (see createAligningStub below) — exactly the pre-#110 behavior, which never retried the
 *  session over a planless creation either. */
export function validateAlignOutput(text: string): AlignValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = AlignMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  const { issues } = parsed.data;
  // Codex review round 1: duplicate titles in one batch would double-create the same issue on
  // GitHub (the engine loops the array verbatim). A session declaring the same title twice is
  // ambiguous by construction — rejected whole, same fail-closed doctrine as every other
  // duplicate/ambiguity rejection in the #110 sequence (never a partial/best-guess apply).
  if (new Set(issues.map((it) => it.title)).size !== issues.length) {
    return { ok: false, reason: "duplicate issue title in the issues array" };
  }
  if (issues.length === 0) {
    if (block.body !== undefined && block.body.trim() !== "") {
      return { ok: false, reason: "no issues declared but a BODY block was present" };
    }
    return { ok: true, issues: [] };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "issues declared but no BODY block present" };
  }
  const bodies = splitAlignIssueBodies(block.body, issues.length);
  if (!bodies) {
    return { ok: false, reason: `BODY block does not contain exactly ${issues.length} well-formed <<<ISSUE>>> segment(s)` };
  }
  return { ok: true, issues: issues.map((it, i) => ({ title: it.title, body: bodies[i]! })) };
}

export type TriageValidation = { ok: true; issue: number; body: string } | { ok: false; reason: string };

/** Parse + schema-validate a po-triage session's structured output. Same shape as
 *  plan-review.ts's validateDrafterOutput (issue + a full revised body) but deliberately NOT
 *  reused directly: that function also re-verifies the verification-plan content invariant as
 *  part of `ok`, which would make a planless draft an INVALID attempt (retried, then
 *  session-degraded). The pre-#110 triage pass never retried on that condition — it accepted
 *  the (schema-shaped) draft, wrote it, and treated "still planless after writing it" as a
 *  SEPARATE, non-retried degradation (see createAligningStub below) — preserved here exactly. */
export function validateTriageOutput(text: string, expectedIssue: number): TriageValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = TriageMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (parsed.data.issue !== expectedIssue) {
    return { ok: false, reason: `structured output issue number mismatch (expected #${expectedIssue}, got #${parsed.data.issue})` };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "triage output requires a non-empty BODY block" };
  }
  return { ok: true, issue: parsed.data.issue, body: block.body };
}

function alignDegradeReason(result: RoleSessionResult): string {
  if (result.outcome !== "done") return `po-align session failed twice (${result.outcome})`;
  const v = validateAlignOutput(result.resultText ?? "");
  return v.ok ? "po-align output valid" : `po-align produced invalid structured output twice: ${v.reason}`;
}

function triageDegradeReason(result: RoleSessionResult, expectedIssue: number): string {
  if (result.outcome !== "done") return `po-triage session failed twice (${result.outcome})`;
  const v = validateTriageOutput(result.resultText ?? "", expectedIssue);
  return v.ok ? "po-triage output valid" : `po-triage produced invalid structured output twice: ${v.reason}`;
}

export interface AlignDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (RoleRunner itself is tested against a
   *  real `claude` stub binary in peripheral.test.ts — this orchestrator's own tests fake the
   *  runner directly, same split as plan-review.ts's PlanReviewDeps). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
  log?: (message: string) => void;
  /** Override for loadPlanMd's path — tests inject a fixed string via a temp file. A real
   *  caller omits this and gets `cfg.goal.file` (#128, promoted out of the #104-era
   *  `roles.architect.planMdPath`): align.ts and architect.ts both read the project's
   *  north-star goal file, so they honor the SAME resolved config value rather than each
   *  hardcoding their own default. */
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
      const now = deps.now ?? ((): Date => new Date());

      // #126: this round's directive (human steering, why/what) — resolved ONCE per run() call
      // and threaded into BOTH prompt renders below (align + every triage session). aligning IS
      // round open, so this call is the round's designated first consumer (consume: true —
      // directive.ts's "EXACTLY ONE CONSUMER PER ROUND"): event-sourced consume-once, so a
      // crash-rerun of this exact phase call (marker still null) replays the SAME recorded
      // content rather than re-reading a possibly-edited file, and a stale directive can never
      // silently re-apply to a later round once archived.
      const directive = resolveRoundDirective(deps.state, deps.cfg, roundId, {
        consume: true,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });

      // Compute at align invocation time from the injected forge. In live round wiring that
      // forge is RoundScopedForge, so the digest inherits the exact existing milestone boundary.
      // Reuse the same snapshot for triage prompt rendering later in this phase.
      const backlogDigest = await buildBacklogDigest(deps.forge, deps.cfg);

      // ── Alignment/decomposition pass: ONE session, dispatched even with an unscoped round
      // (round.milestone unset) — decomposition still has docs/PLAN.md to work from alone.
      // #104: ported to peripheral.ts's shared runSessionWithRetry (outcome-check -> retry-once
      // -> visible-degradation). Same retry-once stance as plan-review.ts's reviewer sessions;
      // the divergence from plan-review's needs-human escalation is deliberate and cheap here:
      // this phase runs PRE-Ready, so a double failure never poisons a dispatch decision — the
      // round advances (marker still set) and the degradation is made observable (a durable
      // event + a log line) instead of wedging the round; the next round retries naturally. ──
      const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
        "po.mode": "align",
        "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against docs/PLAN.md alone)",
        // #128: deps.planMdPath is a TEST override only now — a real caller omits it and gets
        // cfg.goal.file (the same resolved value architect.ts's own goal-file read honors).
        "plan.md": loadPlanMd(deps.planMdPath ?? deps.cfg.goal.file),
        "round.directive": directive,
        "backlog.digest": backlogDigest,
      });
      const alignResult = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "po-align",
          prompt: alignPrompt,
          model: role.model,
          effort: role.effort,
          fallbackModel: role.fallbackModel,
          allowedTools: PO_ALLOWED_TOOLS,
          disallowedTools: PO_DISALLOWED_TOOLS,
        },
        // Align spend is round-scoped, not tied to any single issue — `issue` is a plain int
        // column with no FK, so 0 is a documented sentinel ("no single issue").
        issue: 0,
        now,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        degradeEvent: "po-degraded",
        degradePayload: (result) => ({
          round_id: roundId,
          outcome: result.outcome,
          session: result.name,
          reason: alignDegradeReason(result),
        }),
        degradeMessage: (result) =>
          `[sapwood:po] round ${roundId}: po-align session failed twice (${result.outcome}) — ` +
          `proceeding (pre-Ready, low stakes; the next round retries naturally): ${alignDegradeReason(result)}`,
        isValid: (result) => validateAlignOutput(result.resultText ?? "").ok,
      });
      const alignValidated: AlignValidation =
        alignResult.outcome === "done"
          ? validateAlignOutput(alignResult.resultText ?? "")
          : { ok: false, reason: `po-align session failed twice (${alignResult.outcome})` };

      // Every created issue originates from the VALIDATED array above — the engine is the only
      // caller of forge.createIssue, and its (title, body) signature carries no label field, so
      // a created issue structurally cannot carry a dispatch-path label at creation (the
      // pre-#110 poisoned-label post-check this replaces is deleted outright, see module doc).
      const createdIssues = alignValidated.ok ? alignValidated.issues : [];
      // #123: the aligning phase's own structured summary — what the PO actually decomposed/
      // triaged this round — collected as the loops run and externalized as ONE `align-summary`
      // event at the end. Consumed by the round artifact (round-artifact.ts) and by the
      // architect's pre-dispatch context (round-defaults.ts), replacing the old deterministic
      // pointer note. State event only — no new forge write.
      const alignSummaryCreated: Array<{ issue: number; title: string; hasPlan: boolean }> = [];
      const alignSummaryTriaged: Array<{ issue: number; drafted: boolean }> = [];
      for (const { title, body } of createdIssues) {
        const issueNumber = await deps.forge.createIssue(title, body);
        // Labels are the orchestrator's job, unconditionally — the session has no label channel
        // at all, so there is no race to guard against here (unlike the pre-#110 before/after
        // diff, which could observe a concurrently-human-created issue and had to check for a
        // pre-existing origin:agent label first; that race is gone along with the diff).
        await deps.forge.addLabel(issueNumber, l.originAgent);
        const hasPlan = extractVerificationPlan(body) != null;
        const note = hasPlan
          ? `Created by sapwood's round ${roundId} PO alignment pass (goal decomposition).`
          : `Created by sapwood's round ${roundId} PO alignment pass, but with no verification ` +
            `plan detected — applying \`${l.needsHuman}\` so it is never dispatched ` +
            `planless. A human (or a future triage pass) needs to supply one.`;
        if (!hasPlan) await deps.forge.addLabel(issueNumber, l.needsHuman);
        await deps.forge.addIssueComment(issueNumber, `${note}\n\n${mark}`);
        alignSummaryCreated.push({ issue: issueNumber, title, hasPlan });
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
          "round.directive": directive,
          "backlog.digest": backlogDigest,
        });
        const triageResult = await runSessionWithRetry({
          runner: deps.runner,
          state: deps.state,
          session: {
            roleId: "po-triage",
            prompt: triagePrompt,
            model: role.model,
            effort: role.effort,
            fallbackModel: role.fallbackModel,
            allowedTools: PO_ALLOWED_TOOLS,
            disallowedTools: PO_DISALLOWED_TOOLS,
          },
          issue: issue.number,
          now,
          ...(deps.log !== undefined ? { log: deps.log } : {}),
          degradeEvent: "triage-degraded",
          degradePayload: (result) => ({
            round_id: roundId,
            issue: issue.number,
            outcome: result.outcome,
            session: result.name,
            reason: triageDegradeReason(result, issue.number),
          }),
          degradeMessage: (result) =>
            `[sapwood:po] round ${roundId}: po-triage session failed twice (${result.outcome}) for issue ` +
            `#${issue.number} — proceeding (pre-Ready, low stakes; the next round retries naturally): ` +
            `${triageDegradeReason(result, issue.number)}`,
          isValid: (result) => validateTriageOutput(result.resultText ?? "", issue.number).ok,
        });
        const validated: TriageValidation =
          triageResult.outcome === "done"
            ? validateTriageOutput(triageResult.resultText ?? "", issue.number)
            : { ok: false, reason: `po-triage session failed twice (${triageResult.outcome})` };

        if (!validated.ok) {
          // Malformed-twice/failed-twice already went through runSessionWithRetry's own
          // isValid-driven retry+degrade above (triage-degraded fired there) — nothing further
          // to do: no write, no success comment, the candidate re-matches next round.
          alignSummaryTriaged.push({ issue: issue.number, drafted: false });
          continue;
        }
        // The write is EARNED by validated output, never by the session's exit code alone —
        // same "schema-valid is not the same as truthful" stance issue #110 requires, applied
        // to the write itself rather than just the comment below.
        await deps.forge.updateIssueBody(issue.number, validated.body);
        const planLanded = extractVerificationPlan(validated.body) != null;
        alignSummaryTriaged.push({ issue: issue.number, drafted: planLanded });
        if (planLanded) {
          await deps.forge.addIssueComment(
            issue.number,
            `PO triage pass (round ${roundId}) drafted a plan into this issue's body.\n\n${mark}`,
          );
        } else {
          // A schema-VALID draft that still left the body planless is its own degradation shape
          // (distinct from a malformed/failed session, which already degraded above) — the
          // pre-#110 "done but still planless" outcome, preserved: no success comment (it would
          // be a false audit-trail entry), a durable event, the candidate re-matches next round.
          try {
            deps.state.appendEvent("triage-degraded", { round_id: roundId, issue: issue.number, outcome: "no-plan-after-draft" });
          } catch {
            /* state write failed — the console line below still lands */
          }
          (deps.log ?? console.error)(
            `[sapwood:po] round ${roundId}: triage left issue #${issue.number} still planless — ` +
              `no success comment posted; the candidate re-matches next round`,
          );
        }
      }

      // #123: externalize the phase's structured summary exactly once, after both passes —
      // but ONLY when the align pass actually validated (Codex P2, PR #152): a degraded
      // po-align session must read as a MISSING summary downstream (artifact align: null,
      // architect falls back to its pointer note), never as a successful "decomposed nothing"
      // — the po-degraded event and the artifact's degradedPhases already tell that story.
      // Contained: a state-write failure loses the summary the same null-degrading way.
      if (alignValidated.ok) {
        try {
          deps.state.appendEvent("align-summary", {
            round_id: roundId,
            created: alignSummaryCreated,
            triaged: alignSummaryTriaged,
          });
        } catch {
          /* telemetry only — the phase's forge writes above already landed */
        }
      }

      return { marker: mark };
    },
  };
}
