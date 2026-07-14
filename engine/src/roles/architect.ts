// architect.ts — implements PeripheralStub for the `architecting` phase (#90, #77's round
// model): a round design/review pass between goal alignment and dispatch. The architect reads
// this round's candidate issues + the docs/PLAN.md architecture chapter (+ the PO/goal-
// alignment peripheral's output, when #89 ships one), produces/updates a round design note —
// cross-issue consistency, interface boundaries, risks — and flags any candidate issue whose
// approach contradicts the locked architecture (comment; `blocked` label if severe).
//
// #110 PR4 rework: the architect session is PURE COMPUTATION now — no `gh` tool grant is ever
// exercised by its prompt (the (now-unused) allow/deny-list constants in peripheral.ts are
// untouched; stripping them is PR5's sweep, not this one's). Its final message ends in a
// structured block (structured-output.ts's sentinel format); THIS module parses it, validates it
// against the architect's own zod schema, and performs EVERY GitHub write itself via IForge.
// Malformed/schema-invalid/out-of-candidate-set output is treated as an INVALID attempt for
// `runSessionWithRetry`'s `isValid` hook — retry once, then the architect's EXISTING advisory
// degrade path (proceed without a note; the round is never wedged), exactly the same fate a
// crashed/timed-out session already had. See validateArchitectOutput below.
//
// THE CANDIDATE-SET INVARIANT (issue #110's Design section, the one thing that makes this role
// different from every other #110 PR): the architect is the ONLY role whose session chooses
// write TARGETS from a pool — plan-reviewer/plan-drafter (PR1) only ever write the ONE issue
// they were dispatched for, but the architect sees this round's WHOLE candidate batch at once
// and picks which of them to flag. A session is untrusted output, not a trusted caller — so the
// engine must independently verify every flagged issue number is actually a member of the
// candidate set the session was shown, not just "some positive integer". FAIL-CLOSED, and
// ATOMIC: validateArchitectOutput runs to completion and returns ok:false the moment ANY flagged
// number is out of set, before createArchitectStub ever calls a single forge write — a run with
// one valid and one out-of-set number results in NOTHING being written, never a partial
// application of just the valid one. (Silently dropping the bad entry and keeping the good one
// would let a compromised/confused session's out-of-set write masquerade as a validation
// success; treating the whole output as untrustworthy is the only fail-closed reading.)
//
// Same peripheral shape as plan-review.ts's gate⓪ orchestration (#87) otherwise: this module's
// job is to gather context, render ONE prompt, run ONE session per round, and track round-level
// idempotence. Unlike plan-review's per-issue draft->re-review loop, the architect's whole point
// is a CROSS-issue pass — one session sees every candidate at once, not one session per issue —
// so there is no per-issue looping here at all.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PeripheralStub } from "../loop/round.js";
import type { IForge, Issue } from "../forge/forge.js";
import type { State } from "../state/state.js";
import type { SapwoodConfig } from "../config/config.js";
import { runSessionWithRetry, type RoleRunner, type RoleSessionResult } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import { resolveRoundDirective } from "../config/directive.js";
import { NO_DOCTRINE } from "../config/doctrine.js";

export interface ArchitectDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (same "fake the collaborator, not the
   *  CLI" split plan-review.ts/conductor.test.ts use). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
  /** Path to the repo's north-star goal file — the architecture-chapter source. Override for
   *  tests; a real caller omits this and gets `cfg.goal.file` (#128, promoted out of the
   *  #104-era `roles.architect.planMdPath` — was a hardcoded `<cwd>/docs/PLAN.md`, which broke
   *  for any target repo keeping its architecture doc elsewhere; now a real,
   *  config-file-relative-resolved top-level config key, the same one align.ts's goal-file read
   *  honors). Architecture review stays advisory either way: a missing/unreadable file degrades
   *  to an explicit placeholder (see loadArchitectureChapter) rather than failing the round. */
  planMdPath?: string;
  /** The round's aligned-goals text from the (not yet shipped, #89) PO/goal-alignment
   *  peripheral. Default: an explicit "not available yet" placeholder — #89 hasn't landed, so
   *  round.ts's `aligning` phase is still noopPeripheralStub and has nothing real to hand off.
   *  Once #89 ships, its caller wires this through without any architect.ts change. */
  alignedGoals?: string;
  /** #132: the PREVIOUS round's merged-PR outcomes — engine-assembled, deterministic, bounded
   *  post-review context (M5 item 12: "nobody reviews merged work for architectural drift").
   *  Same threading shape as `alignedGoals` above: a real caller (round-defaults.ts's
   *  createDefaultPeripherals) computes this at invocation time from the durable round-artifact
   *  ledger (round-artifact.ts's `round_artifacts` table, #123) and assigns it before calling
   *  this stub; a caller that omits it (every direct unit test in this file, and any consumer
   *  that hasn't wired round-defaults.ts) gets the explicit `NO_PRIOR_ROUND_YET` placeholder
   *  below — never an empty substitution. This module itself fetches nothing to produce this
   *  string; it only renders whatever the caller hands it (or the placeholder). */
  lastMerged?: string;
  /** #167: this repo's review-doctrine text (technical invariants + adjudication doctrine) —
   *  the THIRD engine-assembled block, threaded the same way `lastMerged` above is: a real
   *  caller (round-defaults.ts's createDefaultPeripherals) loads it at invocation time via
   *  doctrine.ts's `loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars)` and assigns it before
   *  calling this stub; a caller that omits it (every direct unit test in this file, and any
   *  consumer that hasn't wired round-defaults.ts) gets doctrine.ts's own `NO_DOCTRINE`
   *  placeholder below — never an empty substitution. Unlike `lastMerged`, this text has no
   *  round-scoping of its own (the doctrine file doesn't vary per round); it's still threaded
   *  through `ArchitectDeps` rather than loaded directly here so the load logic lives in exactly
   *  one place (doctrine.ts), shared with worker.ts's own injection, never duplicated. */
  doctrine?: string;
}

/** #132: the explicit placeholder used both when there IS no possible prior round (round 1) and
 *  when a real caller hasn't threaded `deps.lastMerged` at all — see the field's own doc comment
 *  above. round-defaults.ts's renderLastMergedFromArtifact uses this SAME wording (not a
 *  reimplementation) for its own "no prior round" cases, so the placeholder text is identical
 *  regardless of which layer produced it. */
export const NO_PRIOR_ROUND_YET =
  "(No prior round's merged-outcome data is available — this is round 1, or no prior round's " +
  "summary artifact could be found. There is nothing to post-review yet.)";

/** The round-scoped idempotency marker (#77 decision 4's `<!-- sapwood:round:N:<phase> -->`
 *  convention, same as plan-review.ts's planReviewMarker) — embedded verbatim in the round
 *  design note comment the engine posts, so the note is traceable on GitHub itself, not only in
 *  sapwood's own sqlite ledger. */
export function architectMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:architecting -->`;
}

export function defaultArchitectPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own default paths.
  return join(here, "..", "..", "prompts", "architect.md");
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

// ── #110 PR4: structured-output schema + candidate-set-validated writes ────────────────────
//
// The metadata block carries ONLY closed-form fields (issue.md #110's Design: "JSON carries
// metadata only — never JSON-string-escape a nested-fence markdown body"): which issues the
// architect flags, and whether each flag is severe. The free-text content — the round design
// note, and each flagged issue's contradiction explanation — travels in the ONE BODY block
// structured-output.ts's shape allows, using a small architect-owned sub-delimiter
// (`<<<CONTRADICTION #N>>>`) this module defines and parses itself (structured-output.ts's own
// four sentinels are untouched — this is a convention layered ON TOP of its single BODY segment,
// not a change to what it recognizes). Everything before the first such marker (or the whole
// body, when there are none) is the round design note; everything is required non-empty text —
// the architect prompt always posts the design note, and a declared-but-textless contradiction
// (or vice versa) is malformed output, not a partial one.

const ArchitectContradictionSchema = z.object({
  issue: z.number().int().positive(),
  severe: z.boolean(),
}).strict();

const ArchitectMetadataSchema = z.object({
  contradictions: z.array(ArchitectContradictionSchema),
}).strict();

const CONTRADICTION_MARKER_RE = /^<<<CONTRADICTION #(\d+)>>>[ \t]*$/gm;
const CONTRADICTION_MARKER_SUBSTRING = "<<<CONTRADICTION";

/** Split the BODY block's raw text into the round design note (everything before the first
 *  marker) and a per-issue explanation map (everything between consecutive markers). null on any
 *  malformed shape: an empty design note, an empty explanation section, or a duplicate marker for
 *  the same issue number — all ambiguous, and this module never guesses at an ambiguous slice
 *  (structured-output.ts's own fail-closed stance, applied to this module's own sub-format).
 *
 *  SUB-DELIMITER CONTAINMENT (Codex review round 1, P2 — structured-output.ts's own
 *  no-embedded-sentinels doctrine, applied to this module's OWN sub-format): after splitting,
 *  the design note and every section text are checked for the `<<<CONTRADICTION` substring —
 *  any remaining occurrence (an inline/quoted mention, a marker-shaped line with trailing text
 *  that the own-line regex didn't consume) is ambiguous by construction and returns null. An
 *  explanation whose content legitimately needs to write the marker string is the same rare
 *  edge structured-output.ts already adjudicated for its sentinels: degrade-to-human via the
 *  isValid retry/degrade path, never more escaping machinery. (An EMBEDDED own-line marker is
 *  consumed by the split itself and lands in the duplicate-marker check below when its number
 *  also has a real section — the residual case, an embedded own-line marker for a section that
 *  never otherwise exists, is structurally indistinguishable from a valid output and is
 *  bounded by the candidate-set + metadata-match checks in validateArchitectOutput.) */
function parseArchitectBody(body: string): { designNote: string; sections: Map<number, string> } | null {
  const markers: Array<{ issue: number; index: number; end: number }> = [];
  CONTRADICTION_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONTRADICTION_MARKER_RE.exec(body)) !== null) {
    markers.push({ issue: Number(m[1]), index: m.index, end: m.index + m[0].length });
  }
  const designNote = (markers.length > 0 ? body.slice(0, markers[0]!.index) : body).trim();
  if (designNote === "") return null; // the design note is required every pass — see module doc
  const sections = new Map<number, string>();
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const sectionEnd = i + 1 < markers.length ? markers[i + 1]!.index : body.length;
    const text = body.slice(marker.end, sectionEnd).trim();
    if (text === "") return null; // a flagged issue with no explanation text — malformed
    if (sections.has(marker.issue)) return null; // duplicate marker for the same issue — ambiguous
    sections.set(marker.issue, text);
  }
  // Sub-delimiter containment (Codex round 1, P2 — see the doc comment above): any REMAINING
  // occurrence of the marker substring after the split consumed every own-line marker is an
  // inline/quoted mention — ambiguous by construction, fail closed.
  if ([designNote, ...sections.values()].some((t) => t.includes(CONTRADICTION_MARKER_SUBSTRING))) {
    return null;
  }
  return { designNote, sections };
}

export interface ArchitectContradiction {
  issue: number;
  severe: boolean;
  explanation: string;
}

export type ArchitectValidation =
  | { ok: true; designNote: string; contradictions: ArchitectContradiction[] }
  | { ok: false; reason: string };

/** Parse + schema-validate + candidate-set-validate an architect session's structured output.
 *  `candidateNumbers` is the round's candidate pool — the EXACT set the session's prompt showed
 *  it (issue #110's Design section: "the engine must validate every flagged issue number against
 *  the round's candidate set... FAIL-CLOSED: any number outside the set invalidates the whole
 *  output"). This function is the single point that enforces that: it runs every check to
 *  completion and returns ok:false the moment any one fails, so a caller NEVER sees a partial
 *  `ok: true` result to selectively apply — createArchitectStub only ever writes anything after
 *  this returns ok:true for the WHOLE output. */
export function validateArchitectOutput(
  text: string,
  candidateNumbers: ReadonlySet<number>,
): ArchitectValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = ArchitectMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "structured output requires a non-empty BODY block (the round design note)" };
  }
  const parsedBody = parseArchitectBody(block.body);
  if (!parsedBody) {
    return { ok: false, reason: "BODY block is malformed — empty design note, an empty/duplicate contradiction section" };
  }
  const metaIssues = new Set(parsed.data.contradictions.map((c) => c.issue));
  // Codex round 1, P1: duplicate metadata entries for the same issue would otherwise fail OPEN —
  // both sides collapse to Sets (sizes match against one body section), and the write loop would
  // then apply the SAME issue twice, with conflicting `severe` values. Reject the duplication
  // itself, before any set comparison can mask it.
  if (metaIssues.size !== parsed.data.contradictions.length) {
    return { ok: false, reason: "duplicate issue in metadata contradictions" };
  }
  const bodyIssues = new Set(parsedBody.sections.keys());
  if (metaIssues.size !== bodyIssues.size || [...metaIssues].some((n) => !bodyIssues.has(n))) {
    return { ok: false, reason: "structured output metadata contradictions don't match the BODY block's sections" };
  }
  // THE CANDIDATE-SET INVARIANT (module doc): fail closed, and check EVERY flagged number before
  // returning — never stop at the first bad one, since the reason string should name them all.
  const outOfSet = parsed.data.contradictions.filter((c) => !candidateNumbers.has(c.issue));
  if (outOfSet.length > 0) {
    return {
      ok: false,
      reason: `flagged issue number(s) outside this round's candidate set: ${outOfSet.map((c) => `#${c.issue}`).join(", ")}`,
    };
  }
  const contradictions: ArchitectContradiction[] = parsed.data.contradictions.map((c) => ({
    issue: c.issue, severe: c.severe, explanation: parsedBody.sections.get(c.issue)!,
  }));
  return { ok: true, designNote: parsedBody.designNote, contradictions };
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The reason string attached to the `architect-degraded` event / stderr line when a session
 *  degrades (runSessionWithRetry's SECOND attempt still isn't usable) — a session-level failure
 *  (crashed/timed out) is distinguished from a session that exited clean but produced output
 *  that never validated, same split plan-review.ts's reviewerDegradeReason makes. */
function architectDegradeReason(result: RoleSessionResult, candidateNumbers: ReadonlySet<number>): string {
  if (result.outcome !== "done") return `architect session failed twice (${result.outcome})`;
  const v = validateArchitectOutput(result.resultText ?? "", candidateNumbers);
  return v.ok ? "architect output valid" : `architect produced invalid structured output twice: ${v.reason}`;
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
      // #126: this round's directive (human steering, why/what). Consumption belongs to round
      // OPEN — with the PO role enabled, aligning already consumed (or established the absence
      // of) this round's directive, and this call only ever reads BACK that durable event
      // (consume: false: a file dropped between aligning and architecting must wait for the
      // next round's opener, never a half-round apply — directive.ts's "EXACTLY ONE CONSUMER
      // PER ROUND", gate② I2). Only when the PO role is disabled (#127) and aligning never runs
      // at all does THIS call become the round's designated first consumer.
      const directive = resolveRoundDirective(deps.state, deps.cfg, roundId, {
        consume: !deps.cfg.roles.po.enabled,
      });
      // The candidate pool for this phase is the same "still awaiting gate⓪" set plan_review
      // consumes next in the sequence (aligning -> architecting -> plan_review -> executing):
      // Ready-lane, OPEN, not yet settled needs-human/blocked/verifyNa/planApproved. Sorted by
      // number for a DETERMINISTIC round-design-note anchor (see below) — getIssuesNeedingPlanReview
      // makes no ordering guarantee of its own.
      const candidates = [...(await deps.forge.getIssuesNeedingPlanReview())].sort((a, b) => a.number - b.number);
      if (candidates.length === 0) return { marker: architectMarker(roundId) };

      const template = loadRolePromptTemplate(deps.cfg.roles.architect.promptFile, defaultArchitectPromptPath());
      // #128: deps.planMdPath is a TEST override only now — a real caller omits it and gets
      // cfg.goal.file (config-file-relative resolved, default "docs/PLAN.md"; was a hardcoded
      // <cwd>/docs/PLAN.md, then roles.architect.planMdPath (#104), which broke for any target
      // repo keeping its architecture doc elsewhere).
      const architectureChapter = loadArchitectureChapter(deps.planMdPath ?? deps.cfg.goal.file);
      // The round design note needs SOME issue to live on (GitHub has no round/project-level
      // comment surface this role can write to — its writes are issue comment/label edit only);
      // the lowest-numbered candidate is an arbitrary but deterministic, reproducible anchor —
      // chosen and applied by the ENGINE, never the session (the session has no gh grant to act
      // on a choice of its own here anyway).
      const anchor = candidates[0]!;
      const marker_ = architectMarker(roundId);
      // THE CANDIDATE-SET INVARIANT's authoritative set: exactly what this round's prompt showed
      // the session, nothing else — see validateArchitectOutput's module doc.
      const candidateNumbers = new Set(candidates.map((c) => c.number));

      const prompt = renderArchitectPrompt(template, {
        "round.id": String(roundId),
        "round.marker": marker_,
        "round.designNoteIssue": String(anchor.number),
        "round.alignedGoals": deps.alignedGoals ?? NO_ALIGNED_GOALS_YET,
        "round.lastMerged": deps.lastMerged ?? NO_PRIOR_ROUND_YET,
        "round.doctrine": deps.doctrine ?? NO_DOCTRINE,
        "plan.architectureChapter": architectureChapter,
        "candidates.summary": candidates.map(formatCandidate).join("\n\n---\n\n"),
        "labels.blocked": deps.cfg.labels.blocked,
        "round.directive": directive,
      });

      const role = deps.cfg.roles.architect;

      // RoleRunner.run never throws on the session's OWN outcome (peripheral.ts) — a failed/
      // timeout session is a normal return, so it must be handled (fable PR #100 P2). #104:
      // runs through peripheral.ts's shared runSessionWithRetry (outcome-check -> retry-once ->
      // visible-degradation, ONE implementation for architect/align/harvest/retro); #110 PR4
      // widens its `isValid` hook to the structured-output + candidate-set check above. Same
      // retry-once stance as plan-review.ts's reviewer sessions; the DIVERGENCE is what happens
      // on the second failure: plan-review escalates needs-human (its verdict gates dispatch),
      // but the architect is ADVISORY — no dispatch decision depends on its note, so wedging the
      // round (or rerunning a session that keeps failing forever) would cost more than the note
      // is worth. Deliberate degradation instead: the marker is STILL set (the round advances; a
      // rerun will NOT retry this phase), and the skip is made observable — a durable
      // `architect-degraded` event plus a log line — never a silent no-op.
      const result = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: { roleId: "architect", prompt, model: role.model, effort: role.effort },
        issue: 0, // round-scoped, not tied to any single issue (spend_ledger's documented sentinel)
        now: deps.now ?? (() => new Date()),
        degradeEvent: "architect-degraded",
        degradePayload: (r) => ({
          round_id: roundId, outcome: r.outcome, session: r.name,
          reason: architectDegradeReason(r, candidateNumbers),
        }),
        degradeMessage: (r) =>
          `[sapwood:architect] round ${roundId}: ${architectDegradeReason(r, candidateNumbers)} — ` +
          `proceeding WITHOUT a round design note (advisory phase, round not wedged)`,
        isValid: (r) => validateArchitectOutput(r.resultText ?? "", candidateNumbers).ok,
      });

      // The final attempt's own validity decides whether anything is written — NOT just whether
      // runSessionWithRetry degraded (it only degrades on a SECOND invalid/failed attempt; a
      // first-attempt success must still be validated and applied here). When the last attempt
      // never validates, runSessionWithRetry has already durably recorded the degradation above
      // (on its second attempt) — there is nothing further for this phase to do; it proceeds
      // with no note, the same advisory-degrade outcome an outright session failure produces.
      if (result.outcome === "done") {
        const validated = validateArchitectOutput(result.resultText ?? "", candidateNumbers);
        if (validated.ok) {
          // Writes are applied ATOMICALLY only after the WHOLE output validated — see
          // validateArchitectOutput's module doc: a run with one valid and one out-of-set flag
          // never reaches here at all (validated.ok is false for the ENTIRE output in that case).
          await deps.forge.addIssueComment(anchor.number, `${validated.designNote}\n\n${marker_}`);
          for (const c of validated.contradictions) {
            await deps.forge.addIssueComment(c.issue, c.explanation);
            if (c.severe) await deps.forge.addLabel(c.issue, deps.cfg.labels.blocked);
          }
        }
      }

      return { marker: marker_ };
    },
  };
}
