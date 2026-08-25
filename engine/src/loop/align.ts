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
// post-check defended against is now structurally impossible, exactly like the verification-plan-drafter's
// pre-#110 label post-check in plan-review.ts (see that module's doc).
//
// Locked decision 5 (only a human confirms `Ready`) remains enforced STRUCTURALLY: this module
// never calls forge.setBoardStatus, and the PO session's allowed tools (PO_ALLOWED_TOOLS) carry
// no `gh api`/`gh project` capability at all — the only channel GithubForge.setBoardStatus uses.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_GOAL_FILE, type SapwoodConfig } from "../config/config.js";
import { resolveRoundDirective } from "../config/directive.js";
import type { IForge, Issue } from "../forge/forge.js";
import { extractOrigin, extractVerificationPlan } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import { applyRoleBodyRewrite, checkMarkerWritePrecondition } from "../review/comment-cursor.js";
// po-pool's candidate digest now substitutes the SAME formatCandidate shape the architect
// phase already substitutes for these same pool members one phase later — see
// buildPoolCandidateDigest's own doc comment below.
import { formatCandidate } from "../roles/architect.js";
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import {
  envFailureHook,
  PO_ALIGN_ALLOWED_TOOLS,
  PO_ALLOWED_TOOLS,
  PO_DISALLOWED_TOOLS,
  PO_TRIAGE_ALLOWED_TOOLS,
  runSessionWithRetry,
} from "../roles/peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "../roles/plan-review.js";
import type { InputManifestRow, State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import { issuePriority } from "./conductor.js";
import { runDecompositionPass } from "./decompose.js";
import { type Concern, ConcernSchema, postConcerns, validateConcerns } from "./dissent.js";
import { createIssueProposals, normalizeProposalTitle, proposalMarker } from "./issue-creation.js";
import {
  escalatePoolRemovalFailures,
  type PeripheralStub,
  poolRemovalEscalated,
  poolRemovalFailureCount,
  removeRoundPoolLabel,
} from "./round.js";

/** #89's round convention (same shape as plan-review.ts's planReviewMarker): the round
 *  ledger's persisted marker for this phase, also embedded in every comment this phase posts
 *  so a round's alignment activity is traceable directly on GitHub. */
export function alignMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:aligning -->`;
}

/** Stable identity for one validated proposal. The index distinguishes intentionally similar
 *  proposals while the title hash keeps the marker useful when inspecting raw issue bodies. */
export function proposalId(roundId: number, index: number, title: string): string {
  const titleHash = createHash("sha256").update(title).digest("hex").slice(0, 16);
  return `${roundId}-${index}-${titleHash}`;
}

export { normalizeProposalTitle, proposalMarker } from "./issue-creation.js";

export function defaultPoPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own defaults.
  return join(here, "..", "..", "prompts", "po.md");
}

const DEFAULT_PLAN_MD_PATH = DEFAULT_GOAL_FILE;

/** #231: the goal file's read result, EXPLICIT — never a silent empty string. The PO's
 *  alignment context is substituted into the prompt (the sandboxed session has no Read tool,
 *  same "substitute it in" discipline as {{issue.body}} elsewhere); a missing/unreadable/moved
 *  goal file used to degrade to `""` (this function's pre-#231 behavior), so the align session
 *  would "decompose" against empty context with no visible sign anything was wrong —
 *  deterministic blindness, not correctness (see this module's #231 discussion at
 *  createAligningStub). `ok: false` is now the explicit signal that aborts the align-CREATION
 *  pass specifically (a durable event + a tick-error, no session spawned, no creations this
 *  pass) — never the whole phase: triage never reads this file and is unaffected. */
export type PlanMdRead = { ok: true; content: string } | { ok: false; reason: string };

export function readPlanMd(path: string = DEFAULT_PLAN_MD_PATH): PlanMdRead {
  try {
    return { ok: true, content: readFileSync(path, "utf8") };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

const NO_OPEN_ISSUES = "(no open issues yet)";
const BACKLOG_READ_FAILED = "(backlog digest unavailable: open-issue read failed)";

/** #231: one truncation-safe pack of whole `lines` into a `maxChars` budget — never slices a
 *  record mid-line (unlike retro-digest.ts's capDigest, a character-count cut meant for free
 *  text, not an ascending-numbered list). A record either fits whole or is OMITTED and counted;
 *  the returned counts/flag are exact regardless of whether anything was actually cut, so a
 *  caller can always tell "the high-numbered tail is either rendered or counted as omitted,
 *  never silently gone" (#231 acceptance criterion) — capDigest's old character-count cut over
 *  an ascending-issue-number list made the tail vanish with no trace, which is exactly the
 *  invisible hole this function replaces it for. Deterministic: the same `lines`+`maxChars`
 *  always yields the same prefix, same contract as capDigest, just record-granular instead of
 *  character-granular. `noun` only changes the truncation marker's wording. */
export interface BoundedDigest {
  text: string;
  total: number;
  rendered: number;
  omitted: number;
  truncated: boolean;
}

/** #558: one packable record — its rendered `text` plus the issue `number` that text is ABOUT.
 *  The number exists purely so the omission marker can NAME what it dropped: pre-#558 this
 *  function took bare strings, so the marker had nothing to name and could only count. Both
 *  callers already had the ordered `Issue[]` in scope at the call site, so carrying the id
 *  alongside the line is strictly cheaper than the alternative (having each caller re-derive its
 *  own trailing slice and splice numbers into the marker text after the fact — which would also
 *  put the marker's length outside this function's cap accounting, the one thing it exists to
 *  guarantee). */
export interface DigestRecord {
  number: number;
  text: string;
}

export function packDigestRecords(records: readonly DigestRecord[], maxChars: number, emptyText: string, noun = "issue"): BoundedDigest {
  const total = records.length;
  if (total === 0) return { text: emptyText, total: 0, rendered: 0, omitted: 0, truncated: false };

  const rendered: DigestRecord[] = [];
  let used = 0;
  for (const record of records) {
    const added = (rendered.length > 0 ? 1 : 0) + record.text.length; // +1 for the join newline
    if (used + added > maxChars) break;
    rendered.push(record);
    used += added;
  }
  if (rendered.length === total) {
    return { text: rendered.map((r) => r.text).join("\n"), total, rendered: total, omitted: 0, truncated: false };
  }

  // #558: two marker shapes, in preference order. NAMED is the point of this issue — a count
  // alone made an omitted record invisible to the session reading the digest (fatal for the pool
  // digest, which IS the selection surface: a candidate nobody can name cannot be selected and
  // drops out of the round with nothing in the prompt pointing at it). COUNT-ONLY is the
  // pre-#558 wording, kept as the documented degradation for when the named list itself is what
  // blows the cap. Both share the same tail: cap, rendered/total — unchanged from pre-#558, as
  // are `omitted` and `truncated` (naming is ADDITIVE, not a contract change).
  const suffix = (n: number): string => ` omitted — exceeded the ${maxChars}-char cap; ${n}/${total} rendered ...]`;
  const named = (n: number): string =>
    `\n\n[... ${noun}s ${records
      .slice(n)
      .map((r) => `#${r.number}`)
      .join(", ")}${suffix(n)}`;
  const counted = (n: number): string => `\n\n[... ${total - n} more ${noun}(s)${suffix(n)}`;
  // Never slices a record: drop whole trailing lines (bounded — at most `rendered.length`
  // iterations, and these lists are small: backlog/pool candidate counts) until a marker fits
  // alongside what's kept. Same "the cap is never exceeded either way" contract as capDigest.
  // Preference order inside one level is named-then-counted, but the LEVEL is chosen by whichever
  // of the two fits first: keeping one more record RENDERED (selectable) beats naming it (merely
  // visible), so a long named list never costs a record that the shorter count-only marker would
  // have kept.
  while (rendered.length > 0) {
    const body = rendered.map((r) => r.text).join("\n");
    for (const marker of [named(rendered.length), counted(rendered.length)]) {
      if (body.length + marker.length <= maxChars) {
        return { text: body + marker, total, rendered: rendered.length, omitted: total - rendered.length, truncated: true };
      }
    }
    rendered.pop();
  }
  // Nothing fits even with zero rendered records (a pathologically tiny cap) — same last-resort
  // ladder: the named marker, else the count-only one, else a hard truncation of it (capDigest's
  // own fallback shape). A partially-named list is deliberately NOT a rung: half a list of
  // numbers reads as "these are the omitted ones" and would be a lie.
  for (const marker of [named(0), counted(0)]) {
    if (marker.length <= maxChars) return { text: marker, total, rendered: 0, omitted: total, truncated: true };
  }
  return { text: counted(0).slice(0, maxChars), total, rendered: 0, omitted: total, truncated: true };
}

export interface BacklogDigestResult extends BoundedDigest {
  /** false iff the underlying open-issue read itself threw — the #231 fail-closed signal
   *  createAligningStub's creation loop keys off of to SUPPRESS issue creation for this pass
   *  (never a silent placeholder the align session can't tell apart from "zero open issues"). */
  ok: boolean;
  /** Failure reason, present only when `ok` is false. */
  reason?: string;
  /** #237: the issue numbers ACTUALLY rendered into `text`, in the same order — i.e. the
   *  session's real injected view of the open backlog, honoring packDigestRecords' truncation
   *  (a candidate past the cap was never shown, so it is never "in view" either). This is the
   *  bounds set align.ts's concern validation checks a `concerns` entry against: a concern about
   *  an issue that exists but was truncated out of the digest is just as out-of-view as one about
   *  an issue that was never a candidate at all. Empty on a read failure or an empty backlog. */
  renderedIssueNumbers: number[];
}

/** #444: milestone scope ORDERS and ANNOTATES this digest — it no longer EXCLUDES. An issue
 *  outside `cfg.round.milestone` (a later milestone, or no milestone at all — the shape every
 *  agent-filed proposal deliberately carries so it stays out of the pool) is still open work the
 *  align session must not duplicate, so it stays in the rendered dedup surface with an annotation
 *  saying it is out of this round's DECOMPOSITION scope. Empty string for an in-scope issue, and
 *  for every issue when the round is unscoped (`milestone === undefined`) — unchanged rendering
 *  on that path. */
function scopeAnnotation(issue: Issue, milestone: string | undefined): string {
  if (milestone === undefined || issue.milestone === milestone) return "";
  return issue.milestone === undefined ? " [no milestone — outside this round]" : ` [milestone: ${issue.milestone} — outside this round]`;
}

/** #528: how a recently-closed issue reads in the digest — deliberately NOT the milestone
 *  annotation's vocabulary: a closed issue is not "outside this round", it is settled work that
 *  must not be re-proposed at all. po.md explains the marker to the session. */
export const CLOSED_ANNOTATION = " [recently closed — do not re-propose]";

/** Engine-side PO context (#215): deterministic; milestone scope is applied here at the digest
 *  consumer.
 *  #231: a read failure is no longer swallowed into an indistinguishable placeholder string —
 *  `ok: false` (+ `reason`) is the explicit, checkable signal createAligningStub's creation loop
 *  and the durable `backlog-read-failed` honesty event key off of. Truncation never slices a
 *  mid-record line (packDigestRecords above), so a caller can always tell which issues were
 *  actually shown to the session vs. merely counted as omitted.
 *
 *  #444: the digest covers ALL open issues, not just this round's milestone. The pre-#444
 *  milestone filter made duplicate filings mechanical rather than unlucky — an issue in the NEXT
 *  milestone (#428) or carrying no milestone at all (#427, the agent-filed shape) simply could
 *  not be seen by the session asked not to duplicate it, so it got duplicated (#435, #439). The
 *  DECOMPOSITION focus is still this round's milestone, expressed by ordering (in-scope first, so
 *  the focus is what survives truncation) plus a per-record `scopeAnnotation` the prompt explains
 *  — never by hiding the rest. One packDigestRecords call over the whole list keeps the existing
 *  bounded-digest contract (single cap, exact counts, truncation marker) intact: no second
 *  budget, no second section, no new config key.
 *
 *  #528: `recentlyClosed` is the same widening on the STATE axis — a fact that shipped and was
 *  closed is still a fact the session must not re-propose (#525 re-proposed #461 hours after it
 *  shipped). Read by the CALLER (so one bounded read serves both this digest and the creation
 *  loop's mechanical dedup, and so a failed backstop read degrades open there instead of turning
 *  into an `ok: false` that suppresses creation). Rendered LAST — after the decomposition focus
 *  and the open dedup context — so a tight cap drops closed records first, and annotated
 *  distinctly (`CLOSED_ANNOTATION`). Same single packDigestRecords budget as #444: no second
 *  section, no second cap. Default `[]` keeps every pre-#528 caller byte-identical. */
export async function buildBacklogDigest(
  forge: IForge,
  cfg: SapwoodConfig,
  recentlyClosed: readonly Issue[] = [],
): Promise<BacklogDigestResult> {
  let issues: Issue[];
  try {
    const allIssues = await forge.listOpenIssues();
    issues = allIssues.filter((issue) => !labelsInclude(issue.labels, cfg.labels.decomposed));
  } catch (e) {
    return {
      text: BACKLOG_READ_FAILED,
      ok: false,
      total: 0,
      rendered: 0,
      omitted: 0,
      truncated: false,
      reason: String(e),
      renderedIssueNumbers: [],
    };
  }
  if (issues.length === 0 && recentlyClosed.length === 0) {
    return { text: NO_OPEN_ISSUES, ok: true, total: 0, rendered: 0, omitted: 0, truncated: false, renderedIssueNumbers: [] };
  }
  // #444: this round's milestone first (so the decomposition focus is what survives a truncated
  // cap), then the rest of the open backlog as dedup-only context; each half number-ascending, so
  // the whole list stays deterministic regardless of forge ordering.
  const byNumber = (a: Issue, b: Issue): number => a.number - b.number;
  const inScope = (issue: Issue): boolean => cfg.round.milestone === undefined || issue.milestone === cfg.round.milestone;
  const ordered = [...issues.filter(inScope).sort(byNumber), ...issues.filter((issue) => !inScope(issue)).sort(byNumber)];
  const openRecords = ordered.map((issue) => {
    const holds = cfg.escalation.humanLabels.filter((label) => labelsInclude(issue.labels, label));
    const annotation = holds.length > 0 ? ` [hold: ${holds.join(", ")}]` : "";
    return { number: issue.number, text: `- #${issue.number} — ${issue.title}${scopeAnnotation(issue, cfg.round.milestone)}${annotation}` };
  });
  // #528: closed records carry neither the scope nor the hold annotation — both describe live
  // routing state, meaningless for settled work. Number-ascending, same determinism rule.
  const closedRecords = [...recentlyClosed]
    .sort(byNumber)
    .map((issue) => ({ number: issue.number, text: `- #${issue.number} — ${issue.title}${CLOSED_ANNOTATION}` }));
  const packed = packDigestRecords([...openRecords, ...closedRecords], cfg.roles.po.backlogDigestMaxChars, NO_OPEN_ISSUES);
  // #237: packDigestRecords only ever drops a TRAILING run of whole records (its own doc
  // comment) — so the first `rendered` entries of `ordered` (same order the lines were built in)
  // are exactly what made it into `packed.text`.
  // #528: the closed tail is deliberately NOT in this set. It bounds #237's concern validation
  // ("was the session shown this issue?"), and a concern is a claim about LIVE work needing a
  // decision — a settled, closed issue is dedup context only, so the concerns channel keeps
  // exactly its pre-#528 bounds (closed lines sort last, so this is just the open prefix).
  return {
    ...packed,
    ok: true,
    renderedIssueNumbers: ordered.slice(0, packed.rendered).map((issue) => issue.number),
  };
}

// Placeholder Issue for template rendering in "align" mode: there is no single issue in scope
// (the whole point of that mode is creating NEW ones) — po.md's align section never references
// {{issue.*}}, so an empty/zero stand-in is never actually substituted into rendered output.
const NO_ISSUE: Issue = { number: 0, title: "", labels: [] };

// ── #231: input manifest ─────────────────────────────────────────────────────────────────────
//
// "What did this decision actually see" — every engine-controlled input channel a PO/pool
// SESSION was actually given this round gets one durable input_manifest row (state.ts's
// migration v13->v14), keyed by (round, phase="aligning", role="po", session, attempt). This
// module dispatches three distinct sessions (po-align, po-triage, po-pool); `session` below is
// that session's roleId, further scoped to the specific issue for triage (one triage session
// per candidate issue per round, so "po-triage:123" and "po-triage:456" are independently
// attempt-tracked). `attempt` is never tracked in-memory here — see State.
// nextInputManifestAttempt's own doc comment for why the durable table itself is the counter.
//
// Coverage TODAY (#231, gate② scoping): every channel align.ts itself dispatches a session
// with — goal-file + backlog-digest (po-align), issue-body + backlog-digest (po-triage, one
// pair per candidate issue), pool-candidates (po-pool). Architect-side / round-context channels
// (round-defaults.ts's `lastMerged`, architect.ts's own goal/architecture-chapter read and
// candidate-issue "fetched details", doctrine, the round directive) are NOT instrumented here —
// they belong to modules a PARALLEL PR (#236) is actively rewiring; expanding this table's
// coverage into those files now would conflict with #236's in-flight rewrite for no
// decision-quality benefit, so it is left for a later follow-up.
//
// #232 (shipped): the manifest table ITSELF stays record-only (recordInputManifest's own doc
// comment) — #232 did not make appendInputManifest a gate. What #232 DID land is the linkage
// this comment used to only promise: `align.ts`'s triage decision/receipt events
// (`triage-decision-accepted`, `triage-body-committed`, `triage-comment-posted`,
// `triage-effects-committed`, `triage-stale-hash-skipped`) each carry the SAME (phase, role,
// session, attempt) identity tuple as this manifest — literally the same `attempt` number a
// dispatch's own recordInputManifest calls used, not a parallel/derived one — so a manifest row
// and the decision/receipts it informed are joinable by that key with no FK needed. See the
// "#232: triage write-ahead acceptance" section's own module doc, further down this file, for
// why that link is load-bearing rather than decorative (a receipt for the WRONG attempt must
// never be mistaken for the current decision's own — gate② finding F2 on PR #249).
const INPUT_MANIFEST_PHASE = "aligning";
const INPUT_MANIFEST_ROLE = "po";

/** Short, stable content fingerprint (#231's manifest `version` field) — same truncation
 *  convention as proposalId's title hash above, just applied to arbitrary input content. */
function contentVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Best-effort input-manifest write (#231): failing to RECORD what a session's input looked
 *  like must never block the session itself — the manifest is a record, not a gate (this
 *  module's own #231 design ruling; see state.ts's schema v13->v14 migration comment). Mirrors
 *  persistPoolSelection's catch-and-log shape further below in this file. */
function recordInputManifest(state: State, row: InputManifestRow, log?: (message: string) => void): void {
  try {
    state.appendInputManifest(row);
  } catch (e) {
    (log ?? console.error)(
      `[sapwood:po] round ${row.round_id}: failed to record the input-manifest row (session ${row.session}, channel ${row.channel}): ${String(e)}`,
    );
  }
}

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
// #237: `concerns` is OPTIONAL and additive alongside the normal deliverable (`issues` here,
// `issue`+BODY for triage below) — never a substitute for it. Bounds-checking against the
// session's own injected view happens in validateAlignOutput/validateTriageOutput (dissent.ts's
// validateConcerns), not in the schema itself — zod only enforces shape here.
const AlignMetadataSchema = z.object({ issues: z.array(AlignIssueMetaSchema), concerns: z.array(ConcernSchema).optional() }).strict();
const TriageMetadataSchema = z.object({ issue: z.number().int().positive(), concerns: z.array(ConcernSchema).optional() }).strict();

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

export type AlignValidation =
  | { ok: true; issues: Array<{ title: string; body: string }>; concerns: Concern[] }
  | { ok: false; reason: string };

interface PersistedProposal {
  proposalId: string;
  index: number;
  title: string;
  body: string;
}

const PersistedProposalSchema = z
  .object({ proposalId: z.string().min(1), index: z.number().int().nonnegative(), title: z.string().min(1), body: z.string().min(1) })
  .strict();
// #237: `concerns` is round-level (not per-proposal — a concern targets an EXISTING issue, never
// one of this batch's own new proposals), persisted alongside the proposal set in the SAME
// write-ahead event so a crash-rerun's replay (proposalProgress below) recovers both together —
// no second event kind needed for align-mode concern replay.
const ProposalSetEventSchema = z
  .object({
    round_id: z.number().int().positive(),
    proposals: z.array(PersistedProposalSchema),
    concerns: z.array(ConcernSchema).optional(),
  })
  .strict();
const ProposalCreatedEventSchema = z
  .object({ round_id: z.number().int().positive(), proposalId: z.string().min(1), issue: z.number().int().positive() })
  .passthrough();
const ProposalSkippedEventSchema = z.object({ round_id: z.number().int().positive(), proposalId: z.string().min(1) }).passthrough();
// #232 F3: a NON-terminal receipt (a proposal can be terminal — `proposal-created`/
// `proposal-skipped` — without ever reaching this branch, e.g. a collision-skipped proposal).
// Distinct from the terminal events above: this one exists solely so a crash strictly BETWEEN
// `addIssueComment` landing and the (only-then-appended) `proposal-created` receipt is
// distinguishable, on a marker-reconcile rerun, from "never commented" — comments are NOT
// idempotent (unlike the label writes alongside them), so re-running applyProposalGovernance
// blind on every reconcile would repost it. See applyProposalGovernance's own doc comment.
const ProposalCommentPostedEventSchema = z.object({ round_id: z.number().int().positive(), proposalId: z.string().min(1) }).passthrough();

/** Read this round's persist-first proposal journal. Malformed or divergent durable records
 *  fail closed: guessing would risk recreating issues. */
function proposalProgress(
  state: State,
  roundId: number,
): {
  proposals: PersistedProposal[] | null;
  /** #237: this round's persisted concerns (align-mode session), replayed verbatim on a
   *  crash-rerun — null exactly when `proposals` is null (no persisted set at all this round). */
  concerns: Concern[] | null;
  terminalIds: Set<string>;
  createdIssues: Map<string, number>;
  commentedIds: Set<string>;
} {
  const events = state.eventsAfterId(0, ["proposal-set-persisted", "proposal-created", "proposal-skipped", "proposal-comment-posted"]);
  let proposals: PersistedProposal[] | null = null;
  let concerns: Concern[] | null = null;
  const terminalIds = new Set<string>();
  const createdIssues = new Map<string, number>();
  const commentedIds = new Set<string>();
  for (const event of events) {
    // #310 reuses these exact proposal journal/receipt EVENT KINDS for scoped decompose
    // batches. The ordinary round-goal proposal reader owns only unscoped records.
    if (
      typeof event.payload === "object" &&
      event.payload !== null &&
      "scope" in event.payload &&
      typeof (event.payload as { scope?: unknown }).scope === "string"
    ) {
      continue;
    }
    const payloadRound =
      typeof event.payload === "object" && event.payload !== null && "round_id" in event.payload
        ? (event.payload as { round_id?: unknown }).round_id
        : undefined;
    if (payloadRound !== roundId) continue;
    if (event.kind === "proposal-set-persisted") {
      const parsed = ProposalSetEventSchema.safeParse(event.payload);
      if (!parsed.success) throw new Error(`malformed persisted proposal set for round ${roundId}`);
      if (proposals != null) throw new Error(`multiple persisted proposal sets for round ${roundId}`);
      proposals = parsed.data.proposals;
      concerns = parsed.data.concerns ?? [];
      continue;
    }
    if (event.kind === "proposal-comment-posted") {
      const parsed = ProposalCommentPostedEventSchema.safeParse(event.payload);
      if (!parsed.success) throw new Error(`malformed proposal-comment-posted record for round ${roundId}`);
      commentedIds.add(parsed.data.proposalId);
      continue;
    }
    const parsedCreated = event.kind === "proposal-created" ? ProposalCreatedEventSchema.safeParse(event.payload) : null;
    const parsedSkipped = event.kind === "proposal-skipped" ? ProposalSkippedEventSchema.safeParse(event.payload) : null;
    const terminal = parsedCreated?.success ? parsedCreated.data : parsedSkipped?.success ? parsedSkipped.data : null;
    if (terminal === null) throw new Error(`malformed proposal terminal event for round ${roundId}`);
    if (terminalIds.has(terminal.proposalId)) {
      throw new Error(`multiple terminal events for proposal ${terminal.proposalId} in round ${roundId}`);
    }
    terminalIds.add(terminal.proposalId);
    if (parsedCreated?.success) createdIssues.set(parsedCreated.data.proposalId, parsedCreated.data.issue);
  }
  if (proposals == null && terminalIds.size > 0)
    throw new Error(`proposal terminal event exists without a proposal set for round ${roundId}`);
  if (proposals != null) {
    const ids = new Set<string>();
    proposals.forEach((proposal, index) => {
      if (proposal.index !== index || proposal.proposalId !== proposalId(roundId, index, proposal.title) || ids.has(proposal.proposalId)) {
        throw new Error(`invalid persisted proposal identity for round ${roundId} at index ${index}`);
      }
      ids.add(proposal.proposalId);
    });
    for (const id of terminalIds) {
      if (!ids.has(id)) throw new Error(`unknown terminal proposal ${id} for round ${roundId}`);
    }
  }
  return { proposals, concerns, terminalIds, createdIssues, commentedIds };
}

/** Parse + schema-validate a po-align session's structured output. Deliberately does NOT
 *  content-check each issue body for a verification-plan section (unlike plan-review.ts's
 *  validateReviewerOutput/validateDrafterOutput): a planless created issue is not an INVALID
 *  session attempt here, it is a normal per-issue outcome the caller labels `needs-human` for
 *  (see createAligningStub below) — exactly the pre-#110 behavior, which never retried the
 *  session over a planless creation either. #442 adds the ONE exception, at the bottom of this
 *  function: the required `Origin:` evidence line, which unlike a plan has no downstream route
 *  to supply it later. */
/** #237: `inView` is the align session's ACTUAL injected view of existing issues (the rendered
 *  backlog-digest subset — buildBacklogDigest's `renderedIssueNumbers`), against which any
 *  `concerns` entry is bounds-checked. Omitted (undefined) skips that bounds check — every
 *  pre-#237 call site (and every existing test) that doesn't pass it keeps behaving exactly as
 *  before; a real dispatch (createAligningStub) always passes the real set. */
export function validateAlignOutput(text: string, inView?: ReadonlySet<number>): AlignValidation {
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
  const concerns = parsed.data.concerns ?? [];
  if (inView) {
    const concernsValid = validateConcerns(concerns, inView);
    if (!concernsValid.ok) return { ok: false, reason: concernsValid.reason };
  }
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
    return { ok: true, issues: [], concerns };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "issues declared but no BODY block present" };
  }
  const bodies = splitAlignIssueBodies(block.body, issues.length);
  if (!bodies) {
    return { ok: false, reason: `BODY block does not contain exactly ${issues.length} well-formed <<<ISSUE>>> segment(s)` };
  }
  // #442: the ONE content invariant this validator does enforce, and the exception that proves
  // the rule above. A missing verification plan is a per-issue OUTCOME with a route (the
  // `planless` label, a later triage pass) — a missing `Origin:` line has none: nothing
  // downstream can reconstruct which evidence triggered a proposal once the session that knew
  // is gone, so it is only ever recoverable by asking the session again. Hence a retryable
  // invalid output, exactly like a malformed BODY segment. Rejected whole rather than per-issue,
  // same fail-closed doctrine as the duplicate-title check above — a partial apply would file
  // the compliant half and silently drop the rest. PRESENCE only; what the line SAYS is human
  // triage prose the engine never reads (extractOrigin's own doc, F15).
  const missingOrigin = bodies.findIndex((body) => extractOrigin(body) == null);
  if (missingOrigin >= 0) {
    return {
      ok: false,
      reason: `issue ${missingOrigin + 1} has no \`Origin:\` evidence line (use \`static scan\` when that is the honest answer)`,
    };
  }
  return { ok: true, issues: issues.map((it, i) => ({ title: it.title, body: bodies[i]! })), concerns };
}

export type TriageValidation = { ok: true; issue: number; body: string; concerns: Concern[] } | { ok: false; reason: string };

/** Parse + schema-validate a po-triage session's structured output. Same shape as
 *  plan-review.ts's validateDrafterOutput (issue + a full revised body) but deliberately NOT
 *  reused directly: that function also re-verifies the verification-plan content invariant as
 *  part of `ok`, which would make a planless draft an INVALID attempt (retried, then
 *  session-degraded). The pre-#110 triage pass never retried on that condition — it accepted
 *  the (schema-shaped) draft, wrote it, and treated "still planless after writing it" as a
 *  SEPARATE, non-retried degradation (see createAligningStub below) — preserved here exactly.
 *
 *  #237: `inView` is this triage session's ACTUAL injected view (the target issue itself, plus
 *  the rendered backlog-digest subset it also sees — same buildBacklogDigest set align mode
 *  uses), against which any `concerns` entry is bounds-checked. Omitted skips that check, same
 *  back-compat stance as validateAlignOutput's own `inView` parameter above. */
export function validateTriageOutput(text: string, expectedIssue: number, inView?: ReadonlySet<number>): TriageValidation {
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
  const concerns = parsed.data.concerns ?? [];
  if (inView) {
    const concernsValid = validateConcerns(concerns, inView);
    if (!concernsValid.ok) return { ok: false, reason: concernsValid.reason };
  }
  if (block.body === undefined || block.body.trim() === "") {
    return { ok: false, reason: "triage output requires a non-empty BODY block" };
  }
  return { ok: true, issue: parsed.data.issue, body: block.body, concerns };
}

function alignDegradeReason(result: RoleSessionResult, inView: ReadonlySet<number>): string {
  if (result.outcome !== "done") return `po-align session failed twice (${result.outcome})`;
  const v = validateAlignOutput(result.resultText ?? "", inView);
  return v.ok ? "po-align output valid" : `po-align produced invalid structured output twice: ${v.reason}`;
}

function triageDegradeReason(result: RoleSessionResult, expectedIssue: number, inView: ReadonlySet<number>): string {
  if (result.outcome !== "done") return `po-triage session failed twice (${result.outcome})`;
  const v = validateTriageOutput(result.resultText ?? "", expectedIssue, inView);
  return v.ok ? "po-triage output valid" : `po-triage produced invalid structured output twice: ${v.reason}`;
}

// ── #232: triage write-ahead acceptance + effect receipts + concurrent-edit guard ──────────────
//
// Prior to #232, a validated triage draft went straight from `validateTriageOutput` to
// `forge.updateIssueBody` with no durable record of the ACCEPTED decision in between, and no
// check that the issue body the session read is still the body actually sitting on GitHub. Two
// gaps this section closes, following the SAME paradigms this file already uses elsewhere
// (never new side-path machinery, per #232's PM ruling):
//
//  1. Write-ahead acceptance (the #212 pool-selected / #216 proposal-journal pattern, applied to
//     triage): the instant a triage session's output validates, the engine durably records the
//     ACCEPTED decision — `triage-decision-accepted` {round_id, issue, phase, role, session,
//     attempt, body, expected_hash} — BEFORE calling forge.updateIssueBody. A crash-rerun of this
//     exact phase (marker still null) that reaches the SAME decision again finds it (triageProgress
//     below) and executes it directly — no second po-triage session, exactly the align-creation
//     phase's persisted-proposals replay one section up. `phase`/`role`/`session`/`attempt` are the
//     SAME identity tuple (and the SAME `attempt` number) as that dispatch's own input-manifest
//     rows (#231) — the link #231's own module doc pointed at this issue for (gate② finding F2 on
//     PR #249: this is the actual linkage, not just bookkeeping — see the attempt-matching note on
//     TriageProgress below for why it is load-bearing, not decorative).
//  2. Concurrent-edit guard (updateIssueBodyIfUnchanged below): the write carries `expected_hash`
//     — a content hash of the issue BODY the session actually read (captured at candidate-fetch
//     time, before the session ran) — and re-reads the LIVE body immediately before writing. A
//     mismatch means a human (or another process) edited the issue while the session was
//     running; the write is REFUSED (human amendment wins, the old body is kept), a
//     `triage-stale-hash-skipped` honesty event is recorded, and the candidate is left for a
//     FRESH read next round rather than blindly overwritten.
//
// Effect receipts: two, mirroring the two writes an accepted triage decision performs.
// `triage-body-committed` lands right after the guarded body write succeeds — a resumed decision
// that already has this receipt skips straight to the comment/no-comment step, so a crash between
// the body write and the comment never re-issues the (already-applied) body write. The terminal
// `triage-effects-committed` lands after that final step (comment posted, or the no-plan-after-
// draft degrade recorded) — its presence (alongside `triage-stale-hash-skipped`, also terminal)
// is what triageProgress's `terminalAttempts` map uses to skip an issue entirely on a later
// crash-rerun within the SAME round. Same accepted, documented tradeoff as the align-creation
// governance comment above (applyProposalGovernance) used to carry for its own comment step
// before #232 F3 closed that gap too: a receipt-guarded step never reposts once its own receipt
// lands.
//
// #232 gate② F1 (Codex sol high review of PR #249): the recovery loop's CANDIDATE SET cannot be
// `getIssuesNeedingPlanTriage()` alone — that selector EXCLUDES any issue whose body already
// contains a plan section (forge.ts), which is exactly what a landed-but-unreceipted body write
// produces. A decision stuck between "body committed" and "effects committed" (or even "decision
// accepted" and "body committed") would otherwise be invisible to a rerun's candidate scan
// forever, leaving it non-terminal with no path to ever complete. THE FIX (see createAligningStub
// below): the recovery set is `getIssuesNeedingPlanTriage()` UNION every non-terminal decision
// still in `triageProgress.decisions` — a journal-resumed issue is processed by NUMBER alone, its
// stored decision (body + expected_hash + attempt) is everything the resume path needs, and
// `updateIssueBodyIfUnchanged`'s own `current === newBody` short-circuit (above) correctly
// no-ops the body write when it already landed.
//
// #232 gate② F2 (same review): a malformed/unreadable `triage-decision-accepted` record is
// treated as absent (triageProgress, same low-stakes stance as always) — which means a FRESH
// session dispatch for that issue produces a NEW decision at a NEW attempt number. Without
// attempt-scoping, a SURVIVING VALID receipt from the stale/unreadable prior attempt could then
// falsely short-circuit the NEW decision's own effects (skip the guarded write, post a success
// comment for a body that was never actually written) — a receipt is only ever a valid resume
// signal for the EXACT decision attempt that produced it. Every decision/receipt event below now
// carries `attempt`, and TriageProgress's maps are attempt-scoped so a stale receipt for a
// DIFFERENT attempt than the currently-resumed (or freshly re-dispatched) decision is simply
// invisible to it — `nextInputManifestAttempt` (the same monotonic MAX+1 counter #231's input-
// manifest rows already use) guarantees a fresh dispatch always mints a brand-new attempt number
// no prior receipt could ever have been stamped with.
//
// Decision persistence itself is LOAD-BEARING (#232's core ask, same "record, not decorative"
// stance the pool-selected fix above applies): a failed `triage-decision-accepted` append aborts
// this issue's effect phase — no forge write happens for it this pass — with a `triage-decision-
// lost` honesty event and a `tick-error`, both best-effort (#243 F3: a second failure while
// reporting the first must never cascade). The loop then moves on to the NEXT candidate rather
// than aborting the whole triage pass — a single issue's bookkeeping failure must not sink every
// other candidate's work this round (unlike applyPoolLabels' ALL-writes-failed throw, which is a
// genuinely total-failure case; this is a per-issue one).

const TriageDecisionEventSchema = z
  .object({
    round_id: z.number().int().positive(),
    issue: z.number().int().positive(),
    phase: z.string().min(1),
    role: z.string().min(1),
    session: z.string().min(1),
    attempt: z.number().int().positive(),
    body: z.string(),
    expected_hash: z.string(),
    // #237: persisted alongside the decision (same write-ahead event, no second event kind) so a
    // crash-rerun's replay recovers a triage session's concerns exactly like it recovers the
    // decision's body/hash.
    concerns: z.array(ConcernSchema).optional(),
  })
  .passthrough();
const TriageTerminalEventSchema = z
  .object({
    round_id: z.number().int().positive(),
    issue: z.number().int().positive(),
    attempt: z.number().int().positive(),
  })
  .passthrough();

interface TriageProgress {
  /** Accepted-but-not-yet-(fully)-terminal decisions for THIS round, by issue number — a
   *  crash-rerun resumes effects from here without dispatching another session. Each decision
   *  carries its own `attempt` (the same number as that dispatch's input-manifest rows), which
   *  every terminal/receipt lookup below must match — see this section's module doc (F2).
   *  `concerns` (#237) replays this decision's session's concerns verbatim on resume. */
  decisions: Map<number, { body: string; expectedHash: string; attempt: number; concerns: Concern[] }>;
  /** issue -> the ATTEMPT of its terminal event (`triage-effects-committed` or
   *  `triage-stale-hash-skipped`) for THIS round, if any. A decision is fully resolved only when
   *  `terminalAttempts.get(issue) === decisions.get(issue).attempt` — a terminal event for a
   *  DIFFERENT (stale/superseded) attempt must never short-circuit the current one (F2). */
  terminalAttempts: Map<number, number>;
  /** issue -> the ATTEMPT of its `triage-body-committed` receipt for THIS round, if any. Same
   *  attempt-matching discipline as `terminalAttempts` — only relevant when it equals the
   *  CURRENT decision's own attempt. */
  bodyCommittedAttempts: Map<number, number>;
  /** issue -> the ATTEMPT of its `triage-comment-posted` receipt for THIS round, if any (#232
   *  F3 symmetry: `addIssueComment` is not idempotent, same as align-creation's audit comment —
   *  a crash strictly between the comment landing and `triage-effects-committed` must not
   *  repost it on a later crash-rerun of this SAME attempt). Same attempt-matching discipline. */
  commentPostedAttempts: Map<number, number>;
}

/** Read this round's triage decision/receipt journal (same "scan from event id 0, filter by
 *  round_id in the payload" shape as proposalProgress/readPersistedPoolSelection above). A
 *  malformed record is treated as absent — logged, never thrown: unlike align-creation's
 *  proposalProgress (where a corrupt journal risks a double-create), triage is idempotent and
 *  low-stakes (drafting a plan again merely costs a session) — a single corrupt row must not
 *  sink the whole aligning phase over a pre-Ready bookkeeping detail. Chronological (ORDER BY
 *  id) scan, last-matching-event-per-issue wins for every map — same idiom as
 *  readPersistedPoolSelection's last-wins replay target. */
function triageProgress(state: State, roundId: number, log?: (message: string) => void): TriageProgress {
  const warn = log ?? console.error;
  const events = state.eventsAfterId(0, [
    "triage-decision-accepted",
    "triage-body-committed",
    "triage-comment-posted",
    "triage-effects-committed",
    "triage-stale-hash-skipped",
  ]);
  const decisions = new Map<number, { body: string; expectedHash: string; attempt: number; concerns: Concern[] }>();
  const terminalAttempts = new Map<number, number>();
  const bodyCommittedAttempts = new Map<number, number>();
  const commentPostedAttempts = new Map<number, number>();
  for (const event of events) {
    const payloadRound =
      typeof event.payload === "object" && event.payload !== null && "round_id" in event.payload
        ? (event.payload as { round_id?: unknown }).round_id
        : undefined;
    if (payloadRound !== roundId) continue;
    if (event.kind === "triage-decision-accepted") {
      const parsed = TriageDecisionEventSchema.safeParse(event.payload);
      if (!parsed.success) {
        warn(`[sapwood:po] round ${roundId}: malformed triage-decision-accepted record — treating as absent`);
        continue;
      }
      decisions.set(parsed.data.issue, {
        body: parsed.data.body,
        expectedHash: parsed.data.expected_hash,
        attempt: parsed.data.attempt,
        concerns: parsed.data.concerns ?? [],
      });
      continue;
    }
    const parsed = TriageTerminalEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      warn(`[sapwood:po] round ${roundId}: malformed ${event.kind} record — treating as absent`);
      continue;
    }
    if (event.kind === "triage-body-committed") bodyCommittedAttempts.set(parsed.data.issue, parsed.data.attempt);
    else if (event.kind === "triage-comment-posted") commentPostedAttempts.set(parsed.data.issue, parsed.data.attempt);
    else terminalAttempts.set(parsed.data.issue, parsed.data.attempt); // triage-effects-committed | triage-stale-hash-skipped
  }
  return { decisions, terminalAttempts, bodyCommittedAttempts, commentPostedAttempts };
}

/** Write-ahead persist ONE issue's accepted triage decision, BEFORE any forge effect (#232).
 *  `attempt` MUST be the same number already derived for that dispatch's input-manifest rows
 *  (#231/#232 F2 linkage) — every receipt this decision later earns carries the SAME attempt, so
 *  a stale receipt from a different (superseded/unreadable) attempt can never be mistaken for
 *  this one's (see this section's module doc). Returns whether the write landed. On failure: a
 *  `triage-decision-lost` honesty event + a `tick-error` (each independently best-effort, #243
 *  F3) and `false` — the caller MUST NOT perform the body write / comment for this issue this
 *  pass; the candidate is untouched, so it naturally re-matches getIssuesNeedingPlanTriage on a
 *  later attempt. */
function persistTriageDecision(
  state: State,
  roundId: number,
  issue: number,
  attempt: number,
  body: string,
  expectedHash: string,
  concerns: Concern[],
  log?: (message: string) => void,
): boolean {
  const warn = log ?? console.error;
  try {
    state.appendEvent("triage-decision-accepted", {
      round_id: roundId,
      issue,
      phase: INPUT_MANIFEST_PHASE,
      role: INPUT_MANIFEST_ROLE,
      session: `po-triage:${issue}`,
      attempt,
      body,
      expected_hash: expectedHash,
      concerns,
    });
    return true;
  } catch (e) {
    const reason = String(e);
    warn(
      `[sapwood:po] round ${roundId}: failed to persist the triage decision for #${issue} — write is SKIPPED this pass (fail-closed): ${reason}`,
    );
    try {
      state.appendEvent("triage-decision-lost", { round_id: roundId, issue, attempt, reason });
    } catch {
      /* best-effort honesty event — the tick-error below still records the failure */
    }
    try {
      state.appendEvent("tick-error", { error: `round ${roundId}: triage-decision-accepted append failed for #${issue}: ${reason}` });
    } catch {
      /* best-effort */
    }
    return false;
  }
}

type BodyWriteGuardResult =
  | { applied: true }
  | { applied: false; reason: "hash-mismatch"; actualHash: string }
  | { applied: false; reason: "invalid-marker"; detail: string }
  | { applied: false; reason: "operator-fence-violation"; detail: string }
  | { applied: false; reason: "malformed-operator-fence"; detail: string };

/** The #232 concurrent-edit guard, extended by #703 v2 gate② (P1-1) to be the ONE place a
 *  triage body-write is normalized against the adjudication marker — for BOTH a fresh decision's
 *  first write AND a crash-RESUMED (replayed) decision's write, since both funnel through this
 *  single call site (round.ts:2389-ish). `roleBody` is the RAW role-produced text (the session's
 *  own output, or a journaled decision's `body` field, unmodified) — this function is the ONLY
 *  place that normalizes it, never a value pre-normalized elsewhere.
 *
 *  #703 v2 gate② P1-1 finding: a `triage-decision-accepted` record persisted by a PRE-#703 engine
 *  (mid-round deploy upgrade — `triageProgress` scopes strictly to the CURRENT round_id, so this
 *  is a same-round crash-resume, not a cross-round replay) could carry a role-set marker (e.g. an
 *  engine comment id) straight through to a verbatim write once the validator was relaxed to
 *  accept it. PO-adjudicated fix (overriding the reviewer's "version journal records" suggestion,
 *  per the pre-v1 no-migration doctrine): do NOT version anything — always re-derive the marker
 *  HERE, against whatever is live right now, so "whatever marker is live at write time wins" is
 *  true for every decision regardless of which engine version produced its journal record.
 *
 *  Order of operations, in this exact sequence:
 *   1. `checkMarkerWritePrecondition(current)` — the refusal arm (ruling item 2): a `current`
 *      body whose OWN marker state is already invalid (duplicate/malformed — independent of any
 *      role, a human can leave a body in this state directly) refuses the ENTIRE write, never
 *      "repairs" it. Checked BEFORE any normalization or hash comparison.
 *   2. `applyRoleBodyRewrite(current, roleBody)` — strips any marker `roleBody` carries and
 *      reattaches `current`'s marker byte-for-byte (or none, if `current` has none). #827: ALSO
 *      refuses the whole write (`ok: false`, `reason: "operator-fence-violation"`) if `roleBody`
 *      altered/removed any operator-owned fenced block `current` carries, or (`reason:
 *      "malformed-operator-fence"`, gate② round 1 fix) if `current`'s own fence boundary is
 *      already malformed (an unclosed opener) — both surfaced here as their own `BodyWriteGuardResult`
 *      arms, same non-repairing stance as step 1's marker refusal. A role-forged fence tag inside
 *      `roleBody` is silently stripped (content kept) rather than refused — see
 *      `stripUnpreservedOperatorFenceTags`'s own doc.
 *   3. `current === newBody` short-circuit — resume-safe by construction: idempotent by
 *      `applyRoleBodyRewrite`'s own doc (re-normalizing an ALREADY-normalized `current` against
 *      the SAME `roleBody` reproduces `current` byte-for-byte), so a genuine crash-resume where
 *      the write already landed on an earlier attempt still hits this short-circuit — #232's
 *      resume-safety holds regardless of which engine version wrote it.
 *   4. The EXISTING hash guard, UNCHANGED: `expectedHash` is the hash of the RAW body a session
 *      actually read (candidate-fetch time); a `current` that no longer hashes to it refuses the
 *      write — "human amendment wins, the old body is kept." This is also the P1-1 finding's own
 *      accepted fallback ("or the write is refused"): a replayed decision whose live body has
 *      moved on since a (possibly pre-deploy) session read it fails this same check, exactly like
 *      an ordinary concurrent edit. */
async function updateIssueBodyIfUnchanged(
  forge: IForge,
  issue: number,
  roleBody: string,
  expectedHash: string,
): Promise<BodyWriteGuardResult> {
  const current = await forge.getIssueBody(issue);
  const precondition = checkMarkerWritePrecondition(current);
  if (!precondition.ok) {
    return { applied: false, reason: "invalid-marker", detail: precondition.detail };
  }
  const rewrite = applyRoleBodyRewrite(current, roleBody);
  if (!rewrite.ok) {
    return { applied: false, reason: rewrite.reason, detail: rewrite.detail };
  }
  const newBody = rewrite.body;
  if (current === newBody) return { applied: true };
  const actualHash = contentVersion(current);
  if (actualHash !== expectedHash) return { applied: false, reason: "hash-mismatch", actualHash };
  await forge.updateIssueBody(issue, newBody);
  return { applied: true };
}

// ── #212/#233: round-pool selection ─────────────────────────────────────────────────────────
//
// The engine ALWAYS computes the CANDIDATE set deterministically (Ready, milestone-scoped by
// whatever `forge` already applies — see AlignDeps.forge — ordered prio:0-first then
// issue-number-ascending, capped at ceil(lanes.roundDispatchCap * round.poolFactor)). #233:
// controlled experiments across model tiers found the (then title-only) PO pool-selection
// SESSION selects EVERY candidate at every tier — it had no evidentiary basis to narrow the
// reservoir from a bare title/number digest, so it just burned a session per round reproducing
// this same deterministic set. Worse, `round.poolFactor` exists to absorb architect/gate⓪
// attrition AFTER selection; a session that DOES narrow the reservoir pre-gates risks
// underfilling the round. So the deterministic candidate set is the MAIN path — this is
// `selectRoundPool`'s documented behavior AND `runPoolSelection`'s default
// (roles.po.poolSelection: false). A later change gave the OPT-IN session itself (below) each
// candidate's FULL body, not just title/number — that changed what the session is SHOWN when
// `poolSelection: true`, not this #233 finding or the default it justifies: the finding was
// never re-run against the body-bearing digest, so it remains the reason the default stays
// `false`, not evidence about how a full-body session would behave.
//
// The session (originally "the PO explicitly selects a round pool") is KEPT as an opt-in
// experiment behind `roles.po.poolSelection: true`, decoupled from `roles.po.enabled` (which
// only gates align/triage — see round-defaults.ts). When enabled, runPoolSelection hands the
// candidate set to a dedicated PO session (runPoolSelection below) whose ONLY deliverable is
// which of those candidate NUMBERS belong in this round's pool — the engine then applies
// cfg.labels.roundPool to exactly that selection, from validated structured output, never from
// anything the session could name directly (no label field exists in the schema: the
// removeLabel/addLabel containment invariant holds structurally, the same "engine performs
// every write itself" stance as align/triage above). Invalid-twice or a failed session degrades
// OPEN to the full deterministic candidate set — never an empty pool, never a wedged round.
// Either way (`poolSelection` true or false), the engine WRITES the durable `pool-selected`
// event — it records what was actually acted on, not what could be recomputed, which is what
// makes a crash-rerun of this exact phase replay-safe when the write lands.
// #232: persistPoolSelection's write is now LOAD-BEARING (fail-closed), not best-effort — an
// append failure ABORTS this pass's label effects entirely (reconcilePoolLabels is never
// called), because a label write with no matching durable record is exactly the "decorative
// record at the moment it's load-bearing" hazard #232 exists to close: GitHub's live label
// state would silently become the only truth, and a crash right after would leave nothing to
// replay from. On failure the engine records BOTH a `pool-selection-decision-lost` honesty
// event and a `tick-error` (each independently best-effort — a SECOND failure while reporting
// the first must never cascade into an unhandled throw, the #243 F3 lesson) and returns without
// touching labels; the round is never wedged — this phase's marker still advances normally
// (same "degrade open, low stakes, next round retries fresh" stance as po-degraded/
// triage-degraded elsewhere in this file), it just skips this round's pool-label update.
//
// #212 gate② r2 (replacing r1's "adopt existing" heuristic, found unsalvageable in review):
// labels alone cannot tell a SAME-ROUND crash rerun apart from a PRIOR-round residual — a
// persistent removeLabel failure or the disabled/fail-open read paths could each starve a fresh
// selection or union onto stale state indefinitely. The fix is a durable EVENT, not a label
// heuristic: the instant this round's target is computed (whichever path computed it), the
// engine appends a `pool-selected` event {round_id, issues} — BEFORE any label write — and a
// crash-rerun of this exact phase (marker still null) replays that event's issue numbers
// verbatim instead of recomputing. This is what kills PO-session nondeterminism-on-rerun
// structurally: a fresh session could pick a DIFFERENT subset than the crashed attempt, and
// union-only label application would then break the cap. Once the target (replayed or freshly
// computed) is known, `reconcilePoolLabels` makes the open backlog's labels match it EXACTLY —
// adding where missing, removing from anything labelled but not in the target — which also
// heals prior-round residuals and cross-milestone strays as a side effect, with no heuristic of
// its own needed.
export interface PoolSelectionDeps {
  forge: IForge;
  cfg: SapwoodConfig;
  log?: (message: string) => void;
}

const PoolSelectedEventSchema = z.object({ round_id: z.number().int().positive(), issues: z.array(z.number().int().positive()) }).strict();

/** Read THIS round's durable pool-selection record (the crash-rerun REPLAY target), if any.
 *  Same "scan from event id 0, filter by round_id in the payload" pattern as proposalProgress
 *  above — pool-selected events are round-scoped by their own payload field, not by a cursor.
 *
 *  #212 gate② r3 (finding 3): LAST-EVENT-WINS, never a throw. Rationale: persistPoolSelection
 *  is written at most once per round UNDER NORMAL OPERATION, but a corrupt/unparseable record
 *  (a prior schema, manual DB surgery, ...) must not become a self-amplifying failure — the
 *  r2 design threw on a malformed OR duplicated record, which (if that record survives) wedges
 *  EVERY future attempt this round: recompute -> append ANOTHER event -> still throws on the
 *  next read (now with two-plus matches) -> recompute again, forever. Taking only the LAST
 *  matching event and treating it — and it alone — as authoritative bounds the damage to
 *  exactly one extra append: a malformed last event reads as "no persisted decision," so this
 *  call computes fresh and appends ONE new (valid) event; the very next read then finds THAT
 *  event last and replays it normally. Growth stops at +1, never runs away.
 *
 *  `null` means no record exists for this round at all (or the only/last one found is
 *  malformed — indistinguishable from "no decision yet" for replay purposes); an empty array
 *  `[]` is itself a valid persisted decision ("this round selected nothing") and must be told
 *  apart from `null` — callers check `!= null`, never truthiness. A thrown `state.eventsAfterId`
 *  (e.g. a DB read failure) still propagates — that's the caller's (runPoolSelection's) own
 *  contained-read boundary, unchanged. */
function readPersistedPoolSelection(state: State, roundId: number): number[] | null {
  const events = state.eventsAfterId(0, ["pool-selected"]);
  let lastForRound: unknown;
  let found = false;
  for (const event of events) {
    const payloadRound =
      typeof event.payload === "object" && event.payload !== null && "round_id" in event.payload
        ? (event.payload as { round_id?: unknown }).round_id
        : undefined;
    if (payloadRound !== roundId) continue;
    lastForRound = event.payload; // chronological order (ORDER BY id) — later matches overwrite
    found = true;
  }
  if (!found) return null;
  const parsed = PoolSelectedEventSchema.safeParse(lastForRound);
  return parsed.success ? parsed.data.issues : null;
}

/** Persist THIS round's pool-selection decision, ONCE, BEFORE any label write — the durable
 *  record runPoolSelection's replay-first check (readPersistedPoolSelection above) reads back
 *  on a crash-rerun. Written at most once per round by construction: this is only ever called
 *  from runPoolSelection's "no persisted record found yet" branch, never from the replay
 *  branch.
 *
 *  #232: LOAD-BEARING, not best-effort — returns whether the write actually landed, and the
 *  caller (runPoolSelection) MUST skip reconcilePoolLabels entirely when it returns false. A
 *  label write with no matching durable record is exactly the hazard #232 closes: GitHub's live
 *  label state would become the only truth, and a crash right after would leave nothing for the
 *  next attempt to replay — the same double-write/double-session risk the whole `pool-selected`
 *  event exists to prevent (see this section's module doc). On failure, records a dedicated
 *  `pool-selection-decision-lost` honesty event AND a `tick-error` — each wrapped in its OWN
 *  try/catch (the #243 F3 lesson: a second failure while reporting the first must never cascade
 *  into an unhandled throw that escapes this contained boundary) — then returns false. The round
 *  is never wedged: the caller still returns normally and the aligning phase's marker still
 *  advances (degrade open, same low-stakes "next round retries fresh" stance as po-degraded/
 *  triage-degraded elsewhere in this file) — only this round's pool-label update is skipped. */
function persistPoolSelection(state: State, roundId: number, target: readonly Issue[], log?: (message: string) => void): boolean {
  const warn = log ?? console.error;
  try {
    state.appendEvent("pool-selected", { round_id: roundId, issues: target.map((i) => i.number) });
    return true;
  } catch (e) {
    const reason = String(e);
    warn(
      `[sapwood:pool] round ${roundId}: failed to persist the pool-selection record — label reconcile is SKIPPED ` +
        `this pass (fail-closed): ${reason}`,
    );
    try {
      state.appendEvent("pool-selection-decision-lost", { round_id: roundId, reason });
    } catch {
      /* best-effort honesty event — the tick-error below still records the failure */
    }
    try {
      state.appendEvent("tick-error", {
        error: `round ${roundId}: pool-selected append failed — pool label reconcile skipped this pass: ${reason}`,
      });
    } catch {
      /* best-effort — the pool-selection-decision-lost event above (if it landed) is the durable record */
    }
    return false;
  }
}

/** The deterministic candidate/fallback ordering: Ready-lane-minus-holds, sorted prio:0-first
 *  then issue-number-ascending, capped at `ceil(cfg.lanes.roundDispatchCap * cfg.round.poolFactor)`.
 *  Pure read, no forge writes — shared by the candidate digest (below) and every fallback path. A
 *  forge read failure propagates (callers decide how to degrade; see selectRoundPool/
 *  runPoolSelection).
 *
 *  #214: sourced from forge.getPoolEligibleIssues() — WIDER than getReadyIssues() alone (gate⓪-
 *  passed ∪ still-awaiting-plan-review). Scoping the pool to gate⓪-passed issues only would
 *  deadlock the system: gate⓪ itself is now scoped to the pool (plan-review.ts's
 *  createPlanReviewStub), so an unapproved issue that could never enter the pool would also
 *  never get reviewed, never get approved, and so never dispatch. Dispatch itself stays exactly
 *  as narrow as before — round.ts's PoolScopedForge (executing-phase only) still wraps
 *  getReadyIssues(), so a pool member without plan:approved still cannot be dispatched merely
 *  for having a pool label. */
async function computePoolCandidates(forge: IForge, cfg: SapwoodConfig): Promise<Issue[]> {
  const cap = Math.ceil(cfg.lanes.roundDispatchCap * cfg.round.poolFactor);
  const eligible = await forge.getPoolEligibleIssues();
  return [...eligible]
    .sort((a, b) => issuePriority(a.labels, cfg.labels.prefix) - issuePriority(b.labels, cfg.labels.prefix) || a.number - b.number)
    .slice(0, cap);
}

/** Apply `cfg.labels.roundPool` to every issue in `issues` that doesn't already carry it.
 *  Idempotent (addLabel is a GitHub-side no-op on an already-present label) — safe to call with
 *  the SAME set on a crash-rerun, no durable marker of its own needed (round.ts's rerun-not-
 *  resume phase marker covers the narrow post-return crash window, same as every other
 *  peripheral). A per-issue write failure is contained and logged — it stays out of the pool
 *  rather than aborting the whole selection, UNLESS every single one failed (see the throw
 *  below): a non-empty selection that landed ZERO labels is not a partial degrade, it's total
 *  forge failure, and must not read as "the pool is now correctly empty." */
async function applyPoolLabels(
  forge: IForge,
  cfg: SapwoodConfig,
  issues: readonly Issue[],
  log?: (message: string) => void,
): Promise<void> {
  const warn = log ?? console.error;
  let successes = 0;
  for (const issue of issues) {
    if (labelsInclude(issue.labels, cfg.labels.roundPool)) {
      successes++; // already labelled — idempotent skip counts as achieved
      continue;
    }
    try {
      await forge.addLabel(issue.number, cfg.labels.roundPool);
      successes++;
    } catch (e) {
      warn(`[sapwood:pool] round-pool selection: failed to label #${issue.number} — it stays out of this round's pool: ${String(e)}`);
    }
  }
  // #212 gate② P2-4: propagate a TOTAL failure (every write in a non-empty set failed) instead
  // of returning as if the pool were legitimately empty. #379 F2 changed WHERE that propagation
  // stops, not whether it happens: runPoolSelection (the one production call site) now catches
  // it, records a durable `pool-labels-failed` event, and returns an empty pool — so the round
  // parks (nothing carries the pool label, so PoolScopedForge finds nothing to dispatch) and the
  // next round re-selects. It no longer escapes the aligning PeripheralStub into round.ts, which
  // used to kill the engine outright. A validly EMPTY selection (the session
  // chose zero candidates, or the deterministic path had zero candidates to begin with) never
  // hits this — `issues.length === 0` short-circuits the guard, exactly the "select none is a
  // valid, complete outcome" case the po-pool prompt documents.
  if (issues.length > 0 && successes === 0) {
    throw new Error(
      `round-pool selection: ALL ${issues.length} label write(s) failed — refusing to report an empty pool as a ` +
        `correct selection; this round dispatches nothing and the next round re-selects`,
    );
  }
}

/** Optional durable-event context for reconcilePoolLabels' incomplete-removal honesty record —
 *  omitted by callers (e.g. selectRoundPool) that have no round context of their own; the
 *  reconcile still runs identically, it just can't durably record an incomplete pass (a log
 *  line still fires either way). #432 round 5: `eventsAfterId` joined `appendEvent` in the Pick
 *  so a supplied eventCtx can also feed `escalatePoolRemovalFailures`' own ledger-count read
 *  (round.ts) — every real caller passes a full `State`, so this is additive for them; only a
 *  caller with genuinely no round context (selectRoundPool) omits eventCtx entirely and skips
 *  both the honesty record and the escalation check, exactly as it already skipped the former. */
interface ReconcileEventCtx {
  state: Pick<State, "appendEvent" | "eventsAfterId">;
  roundId: number;
}

/** Reconcile the open backlog's round-pool labels to EXACTLY `target`: add the label to every
 *  target member lacking it (applyPoolLabels above — idempotent, throws on TOTAL add failure
 *  per #212 gate② P2-4), then remove it from every OTHER open issue that carries it. This heals
 *  prior-round residuals, cross-milestone strays, and partial-crash leftovers as a side effect
 *  of selection itself — no adopt-existing heuristic needed (gate② r1's version of that idea is
 *  removed entirely; the durable pool-selected event, see readPersistedPoolSelection/
 *  persistPoolSelection above, is what owns crash-rerun safety now — this function only owns
 *  convergence).
 *
 *  #212 gate② r3 (finding 1): REMOVE-side failures (a per-issue removeLabel throw, or the
 *  listOpenIssues read itself failing) stay DEGRADE-OPEN — logged and skipped, never thrown.
 *  A transient forge blip must not turn a prioritization mechanism (which pool an already
 *  plan-approved, governed issue sits in) into a phase-retry loop; the aligning marker
 *  advancing past an incomplete reconcile is an accepted bounded residual — round.ts's own
 *  round-close sweep, and the NEXT round's reconcile pass, are further nets against a stray
 *  label that resists removal here. But "logged" alone is not durable, so when `eventCtx` is
 *  supplied, any such failure also appends a `pool-reconcile-incomplete` {round_id,
 *  failed_issues | read_failed} event — an honesty record a human/dashboard can act on, without
 *  making the phase itself retry. Removal is routed through round.ts's removeRoundPoolLabel —
 *  the SAME hardcoded, non-session-reachable containment as round close, never a bespoke
 *  `forge.removeLabel` call site. */
async function reconcilePoolLabels(
  forge: IForge,
  cfg: SapwoodConfig,
  target: readonly Issue[],
  log?: (message: string) => void,
  eventCtx?: ReconcileEventCtx,
): Promise<void> {
  const warn = log ?? console.error;
  await applyPoolLabels(forge, cfg, target, log);

  const recordIncomplete = (detail: { read_failed: true } | { failed_issues: number[] }): void => {
    if (!eventCtx) return;
    try {
      eventCtx.state.appendEvent("pool-reconcile-incomplete", { round_id: eventCtx.roundId, ...detail });
    } catch (e) {
      warn(`[sapwood:pool] round-pool reconcile: failed to record the incomplete-reconcile honesty event: ${String(e)}`);
    }
  };

  const targetNumbers = new Set(target.map((i) => i.number));
  let openIssues: Issue[];
  try {
    openIssues = await forge.listOpenIssues();
  } catch (e) {
    warn(`[sapwood:pool] round-pool reconcile: open-backlog read failed — stray labels left unhealed this pass: ${String(e)}`);
    recordIncomplete({ read_failed: true });
    return;
  }
  // #432 round 6 (P1-2/P2-3, gate② third confirm): the SAME idempotence + cap-before-attempt
  // ordering round.ts's own round-close sweep uses — see that call site's own comment for the
  // full crash-window argument. Both checks are only reachable when eventCtx is supplied (a bare
  // selectRoundPool caller has no state handle to count against, same limitation recordIncomplete
  // already had) — without it, this loop falls back to its pre-#432 behavior unchanged.
  const failedRemovals: number[] = [];
  for (const issue of openIssues) {
    if (targetNumbers.has(issue.number)) continue;
    if (!labelsInclude(issue.labels, cfg.labels.roundPool)) continue;
    if (eventCtx) {
      if (poolRemovalEscalated(eventCtx.state, issue.number)) continue;
      if (poolRemovalFailureCount(eventCtx.state, issue.number) >= cfg.round.maxPoolRemovalAttempts) {
        await escalatePoolRemovalFailures(forge, cfg, eventCtx.state, [issue.number], log);
        continue;
      }
    }
    try {
      await removeRoundPoolLabel(forge, cfg, issue.number, cfg.labels.roundPool);
    } catch (e) {
      warn(`[sapwood:pool] round-pool reconcile: failed to remove the stale pool label from #${issue.number}: ${String(e)}`);
      failedRemovals.push(issue.number);
    }
  }
  if (failedRemovals.length > 0) {
    recordIncomplete({ failed_issues: failedRemovals });
    if (eventCtx) await escalatePoolRemovalFailures(forge, cfg, eventCtx.state, failedRemovals, log);
  }
}

/** The deterministic, no-session pool selection: the FULL candidate set (computePoolCandidates),
 *  reconciled unconditionally (reconcilePoolLabels above — adds to every candidate, removes from
 *  every other open issue that's stray-labelled). #233: this is now the MAIN path — the default
 *  (roles.po.poolSelection: false) target runPoolSelection below computes, not just a fallback —
 *  called directly by runPoolSelection, and (2) still exported for direct testing/any caller
 *  that wants "the label state made to match top-cap Ready" with no event bookkeeping of its
 *  own. A forge read failure degrades to "pool left as whatever it already was" (logged, never
 *  thrown, no reconcile attempted at all) — the executing phase simply dispatches into whatever
 *  the pool already contains this round. Returns the selected issues (empty on a read failure)
 *  for callers/tests that want to observe the pick. */
export async function selectRoundPool(deps: PoolSelectionDeps): Promise<Issue[]> {
  const { forge, cfg } = deps;
  const log = deps.log ?? console.error;
  let candidates: Issue[];
  try {
    candidates = await computePoolCandidates(forge, cfg);
  } catch (e) {
    log(`[sapwood:pool] round-pool selection: Ready read failed — pool left unchanged this round: ${String(e)}`);
    return [];
  }
  await reconcilePoolLabels(forge, cfg, candidates, deps.log);
  return candidates;
}

export function defaultPoolPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "po-pool.md");
}

/** The pool-selection session's candidate digest — each candidate renders as a
 *  `formatCandidate`-shaped block (number, title, labels, FULL body — `architect.ts::
 *  formatCandidate`, the exact same PER-CANDIDATE renderer the architect phase already
 *  substitutes for these same round-pool members one phase later, at the engine's expense
 *  either way), in the SAME prio/number order the session sees as "already ranked for you."
 *  Reason: a title-only digest gave po-pool no signal to distinguish near-identical titles
 *  (see `align.test.ts`'s "select the omitted candidate" / near-duplicate-title cases); the
 *  architect phase pays for a full-body render of these same candidates one phase later
 *  regardless, so substituting that same shape here costs nothing new. This is independent of
 *  which forge tools po-pool holds (`proxy/access.ts`'s `PROXY_ROLE_TOOL_MATRIX` — po-pool keeps
 *  its `ISSUE_TOOLS` grant; a role may hold a read-only lookup tool AND still get a body
 *  substituted, the two are not exclusive). Be precise about how far the architect-phase
 *  equivalence goes: the per-candidate render is byte-identical, but the ASSEMBLED digest is not
 *  — the architect phase joins candidate blocks with `"\n\n---\n\n"` and caps via `capDigest`'s
 *  mid-record character slicing under `roles.architect.poolDigestMaxChars`, while this digest
 *  joins with a bare `"\n"` and caps via `packDigestRecords`' whole-record omission under
 *  `roles.po.backlogDigestMaxChars` (see below). Same renderer, not the same rendering or the
 *  same cap semantics — "the engine already pays this cost" is true of the per-candidate render
 *  only. This REPLACES the pre-existing title-only line (`- #N — title`).
 *
 *  Capped by the SAME existing cap as before — `roles.po.backlogDigestMaxChars` (reused
 *  deliberately, not a new budget). With a title-only digest that reuse WAS a safety valve most
 *  deployments would never tune, since the digest was naturally far smaller than the cap. With
 *  full-body candidates it is a REAL budget: this digest now has the same size profile as
 *  `architect.poolDigestMaxChars`, not the tiny title-only one this cap was originally sized for
 *  — see `docs/guide/configuration.md`'s `po.backlogDigestMaxChars` row for the consequence when it
 *  bites (a candidate can drop out of the round with nothing naming it; #558 tracks fixing the
 *  shared omission marker). #231: whole-record packed (packDigestRecords), the same fix as
 *  buildBacklogDigest above — a candidate near the cap's tail is rendered or counted as omitted,
 *  never silently sliced away mid-line; a candidate's own multi-line body is one "record" for
 *  this purpose (never split across the cap boundary).
 *
 *  `renderedCandidateNumbers` mirrors `buildBacklogDigest`'s `renderedIssueNumbers` — the
 *  numbers actually packed into `text`, same order, honoring `packDigestRecords`' truncation.
 *  This is a PREREQUISITE for showing full bodies at all: `runPoolSelection` used to validate a
 *  session's selection against EVERY candidate (`candidates.map(c => c.number)`), not just the
 *  ones this digest rendered — so a candidate `packDigestRecords` omitted under the cap could
 *  still be named and ACCEPTED, contradicting po-pool.md's "you cannot select an issue you were
 *  never shown" and align.ts's own claim (below) to validate against "the candidate set the
 *  session was shown." That gap was latent (never triggered) on a title-only digest, because a
 *  title-only line is short enough that the cap essentially never bites; substituting full
 *  bodies here makes the cap a real budget and the bug reachable, which is why this fix ships
 *  together with the substitution rather than separately. This return value is what makes the
 *  validation claim true: the caller now builds its bound set from here, not from `candidates`
 *  directly. */
interface PoolCandidateDigest extends BoundedDigest {
  renderedCandidateNumbers: number[];
}

function buildPoolCandidateDigest(candidates: readonly Issue[], cfg: SapwoodConfig): PoolCandidateDigest {
  const records = candidates.map((issue) => ({ number: issue.number, text: formatCandidate(issue) }));
  const packed = packDigestRecords(records, cfg.roles.po.backlogDigestMaxChars, "(no Ready candidates this round)", "candidate issue");
  // packDigestRecords only ever drops a TRAILING run of whole records (its own doc comment) —
  // so the first `packed.rendered` entries of `candidates` (the same order `lines` was built in)
  // are exactly what made it into `packed.text`. Same technique buildBacklogDigest already uses
  // for `renderedIssueNumbers`.
  return { ...packed, renderedCandidateNumbers: candidates.slice(0, packed.rendered).map((issue) => issue.number) };
}

const PoolSelectionMetadataSchema = z.object({ selected: z.array(z.number().int().positive()) }).strict();

export type PoolSelectionValidation = { ok: true; selected: number[] } | { ok: false; reason: string };

/** Parse + schema-validate + BOUND-check a po-pool session's structured output. Deliberately
 *  fails closed on anything outside the candidate set the session was shown: a selected number
 *  not present in `candidateNumbers`, a duplicate, or a selection longer than `cap` are all
 *  INVALID attempts for runSessionWithRetry — never silently clamped/deduped and applied
 *  partially (the same "schema-valid is not the same as truthful" stance #110 established for
 *  the align/triage sessions above, extended here to a structural bound instead of a content
 *  check). No BODY block: the deliverable is numbers only, nothing that needs the multi-segment
 *  body machinery align/triage use. */
export function validatePoolSelectionOutput(text: string, candidateNumbers: readonly number[], cap: number): PoolSelectionValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = PoolSelectionMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  const { selected } = parsed.data;
  if (selected.length > cap) {
    return { ok: false, reason: `selected ${selected.length} issue(s), exceeding the cap of ${cap}` };
  }
  if (new Set(selected).size !== selected.length) {
    return { ok: false, reason: "duplicate issue number in the selected array" };
  }
  const candidateSet = new Set(candidateNumbers);
  const outOfBounds = selected.filter((n) => !candidateSet.has(n));
  if (outOfBounds.length > 0) {
    return { ok: false, reason: `selected issue(s) not in the candidate list: ${outOfBounds.join(", ")}` };
  }
  return { ok: true, selected };
}

function poolDegradeReason(result: RoleSessionResult, candidateNumbers: readonly number[], cap: number): string {
  if (result.outcome !== "done") return `po-pool session failed twice (${result.outcome})`;
  const v = validatePoolSelectionOutput(result.resultText ?? "", candidateNumbers, cap);
  return v.ok ? "po-pool output valid" : `po-pool produced invalid structured output twice: ${v.reason}`;
}

export interface PoolSelectionRunDeps extends PoolSelectionDeps {
  state: State;
  runner: Pick<RoleRunner, "run">;
  roundId: number;
  now: () => Date;
  /** #394 (F23 gate② fix): fired synchronously, exactly once, iff this call actually dispatches
   *  the po-pool session (never on the replay/deterministic/zero-candidates no-session paths) —
   *  round-defaults.ts's aligning wrapper uses this to fold pool-selection's own dispatch status
   *  into the aligning phase's overall PeripheralStub.ranSession, alongside align-session/triage
   *  (see createAligningStub's own ranSession doc). Optional and additive: every existing caller/
   *  test that omits it is unaffected — this changes no other observable behavior of this
   *  function, only whether that one extra bit gets reported. */
  onSessionRan?: () => void;
}

/** Orchestrates one round's pool selection end to end (round-defaults.ts's ONE call site,
 *  invoked every round regardless of roles.po.enabled — see this section's own module doc for
 *  the gate② r2 durable-event design). #233: the session path is now gated by its OWN switch,
 *  `roles.po.poolSelection`, deliberately independent of `roles.po.enabled` (which only gates
 *  align/triage — a deployment can run align/triage with the pool session off, or vice versa).
 *  Shape:
 *
 *  1. REPLAY FIRST, on every path: read this round's persisted `pool-selected` event
 *     (readPersistedPoolSelection). Found -> the target is that event's issue numbers (mapped
 *     back to live Issue objects via a fresh listOpenIssues() read) — no session, no recompute,
 *     straight to reconcile. This is the crash-rerun path: a prior attempt this round already
 *     decided, and replaying is what makes a fresh (possibly DIFFERENT) PO session on rerun
 *     structurally impossible.
 *  2. Not found, roles.po.poolSelection=false (the default): the target is the deterministic
 *     candidate set (computePoolCandidates) — the MAIN path now, no session ever. #233:
 *     controlled experiments found the session selects every candidate at every model tier
 *     anyway, so this is not merely a degrade fallback — it is the intended default behavior.
 *  3. Not found, roles.po.poolSelection=true, zero candidates: nothing to choose from — the
 *     target is simply empty (still persisted + reconciled, so any stale labels get healed).
 *  4. Not found, roles.po.poolSelection=true, candidates exist: run the po-pool session (same
 *     runner machinery + zero-gh-grant tool scope as align/triage — PO_ALLOWED_TOOLS/
 *     PO_DISALLOWED_TOOLS, runSessionWithRetry's retry-once-then-degrade), validate its output
 *     against the candidate bound, and the target is either the validated selection (a proper
 *     subset is a real outcome) or — invalid/failed twice — the full candidate set (degrade
 *     OPEN, a durable `pool-degraded` event + a log line, never an empty pool from a session
 *     outage).
 *
 *  Once the target is known (replayed OR freshly computed), a fresh computation is persisted
 *  (persistPoolSelection, before any label write) and — ONLY if that write lands — every path
 *  converges through the same `reconcilePoolLabels` call: add where the target lacks the label,
 *  remove it from any other open issue that has it. Reconcile is what heals residuals; the event
 *  (when it lands) is what makes reruns replay instead of recompute; neither alone would be.
 *  persistPoolSelection is ATTEMPTED on EVERY freshly-computed path (never the replay branch,
 *  which has nothing new to persist) — it records what was actually acted on, not what could be
 *  recomputed. #232: that write is now LOAD-BEARING — an append failure SKIPS reconcile entirely
 *  for this pass (persistPoolSelection's own doc comment covers the honesty-event/tick-error
 *  containment) rather than proceeding to label GitHub with no durable record behind it; the next
 *  round's own runPoolSelection call retries fresh (nothing persisted this round to replay). */
export async function runPoolSelection(deps: PoolSelectionRunDeps): Promise<Issue[]> {
  const { forge, cfg } = deps;
  const log = deps.log ?? console.error;

  let persisted: number[] | null;
  try {
    persisted = readPersistedPoolSelection(deps.state, deps.roundId);
  } catch (e) {
    log(`[sapwood:pool] round ${deps.roundId}: persisted pool-selection record corrupt — treating as absent: ${String(e)}`);
    persisted = null;
  }

  // #232: whether THIS invocation's fresh decision (if any) actually landed durably — gates
  // reconcile below. true by default for the replay branch: it persists nothing new, so there is
  // no fresh write whose failure could strand a label effect.
  let decisionPersisted = true;
  let target: Issue[];
  if (persisted != null) {
    const targetSet = new Set(persisted);
    let openIssues: Issue[];
    try {
      openIssues = await forge.listOpenIssues();
    } catch (e) {
      log(
        `[sapwood:pool] round ${deps.roundId}: open-backlog read failed while replaying the persisted selection — ` +
          `pool left unchanged this pass: ${String(e)}`,
      );
      return [];
    }
    target = openIssues.filter((i) => targetSet.has(i.number));
    log(
      `[sapwood:pool] round ${deps.roundId}: replaying the persisted selection (${target.length}/${persisted.length} ` +
        `target issue(s) still open) — no session, no recompute.`,
    );
  } else if (!cfg.roles.po.poolSelection) {
    // #233: the deterministic MAIN path — default behavior, not a fallback. Independent of
    // roles.po.enabled (which only gates align/triage).
    let candidates: Issue[];
    try {
      candidates = await computePoolCandidates(forge, cfg);
    } catch (e) {
      log(`[sapwood:pool] round-pool selection: Ready read failed — pool left unchanged this round: ${String(e)}`);
      return [];
    }
    decisionPersisted = persistPoolSelection(deps.state, deps.roundId, candidates, log);
    target = candidates;
  } else {
    let candidates: Issue[];
    try {
      candidates = await computePoolCandidates(forge, cfg);
    } catch (e) {
      log(`[sapwood:pool] round-pool selection: Ready read failed — pool left unchanged this round: ${String(e)}`);
      return [];
    }
    if (candidates.length === 0) {
      decisionPersisted = persistPoolSelection(deps.state, deps.roundId, candidates, log);
      target = candidates;
    } else {
      const now = deps.now;
      const role = cfg.roles.po;
      const template = loadRolePromptTemplate(role.poolPromptFile, defaultPoolPromptPath());
      // computePoolCandidates already slices to ceil(roundDispatchCap * poolFactor) — the
      // candidate list's own length IS the effective cap (it can be smaller when Ready itself
      // has fewer eligible issues than the configured bound allows).
      const cap = candidates.length;
      const poolDigest = buildPoolCandidateDigest(candidates, cfg);
      // #557 FIX 1: the bound set for validation is what the digest actually
      // RENDERED, not every candidate computePoolCandidates produced — a candidate
      // packDigestRecords omitted under the cap was never shown to the session, so it must be
      // rejected the same way an out-of-bounds number is (see PoolCandidateDigest's own doc).
      const candidateNumbers = poolDigest.renderedCandidateNumbers;
      // #231: input manifest for the pool-candidates channel — recorded ONLY on this real
      // session-dispatch path (never the replay branch above, nor the deterministic
      // no-session default: neither reads/shows a candidate digest to any session).
      recordInputManifest(
        deps.state,
        {
          round_id: deps.roundId,
          phase: INPUT_MANIFEST_PHASE,
          role: INPUT_MANIFEST_ROLE,
          session: "po-pool",
          attempt: deps.state.nextInputManifestAttempt(deps.roundId, INPUT_MANIFEST_PHASE, INPUT_MANIFEST_ROLE, "po-pool"),
          channel: "pool-candidates",
          ok: true,
          // #231 gate② (Codex sol high F2): hash the RENDERED digest text, not just the
          // candidate numbers — a title-only edit (candidate set unchanged, wording drifted)
          // must still show up as a version change, since that's what the session actually saw.
          version: contentVersion(poolDigest.text),
          total: poolDigest.total,
          rendered: poolDigest.rendered,
          omitted: poolDigest.omitted,
          truncated: poolDigest.truncated,
        },
        log,
      );
      const prompt = renderRolePrompt(template, NO_ISSUE, cfg, {
        "pool.digest": poolDigest.text,
        "pool.cap": String(cap),
      });
      // #394 (F23): this IS the one real session dispatch on this function's session path (the
      // replay/deterministic/zero-candidates branches above all return before reaching here) —
      // see PoolSelectionRunDeps.onSessionRan's own doc.
      deps.onSessionRan?.();
      const result = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "po-pool",
          prompt,
          model: role.model,
          effort: role.effort,
          fallbackModel: role.fallbackModel,
          allowedTools: PO_ALLOWED_TOOLS,
          disallowedTools: PO_DISALLOWED_TOOLS,
        },
        issue: 0,
        now,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        // #251: record this session's ambient-context manifest for EVERY attempt, same (round,
        // phase, role, session, attempt) key shape as the input-manifest rows above — see
        // peripheral.ts's RetriedSession.contextManifest doc. Completes the 9/9 wiring #236
        // deferred for align.ts's three PO sessions.
        contextManifest: {
          roundId: deps.roundId,
          phase: INPUT_MANIFEST_PHASE,
          record: (key, json, at) => deps.state.recordContextManifest(key, json, at),
        },
        degradeEvent: "pool-degraded",
        degradePayload: (r) => ({
          round_id: deps.roundId,
          outcome: r.outcome,
          session: r.name,
          reason: poolDegradeReason(r, candidateNumbers, cap),
        }),
        degradeMessage: (r) =>
          `[sapwood:pool] round ${deps.roundId}: po-pool selection session failed twice (${r.outcome}) — ` +
          `degrading to the deterministic top-${cap} selection: ${poolDegradeReason(r, candidateNumbers, cap)}`,
        isValid: (r) => validatePoolSelectionOutput(r.resultText ?? "", candidateNumbers, cap).ok,
        // #374: quota/429 parks instead of degrading — see peripheral.ts's envFailureHook doc.
        envFailure: envFailureHook(deps.cfg, deps.state),
      });
      const validated: PoolSelectionValidation =
        result.outcome === "done"
          ? validatePoolSelectionOutput(result.resultText ?? "", candidateNumbers, cap)
          : { ok: false, reason: `po-pool session failed twice (${result.outcome})` };

      // Degrade OPEN (invalid twice / failed twice) -> the full deterministic candidate set,
      // never an empty pool from a session outage. Otherwise the validated selection itself —
      // a proper subset is a real outcome, not a degrade.
      target = validated.ok ? candidates.filter((c) => new Set(validated.selected).has(c.number)) : candidates;
      // #212 gate② r3 (finding 2, documented not fixed — INHERENT: the po-pool session and this
      // sqlite write can't be made atomic across a subprocess boundary). Ceiling: a crash in
      // that window costs one duplicate po-pool session on rerun, never a wrong pool —
      // reconcilePoolLabels replaces label state to match the target rather than unioning, so
      // labels still converge correctly. A session-started sentinel would trade that rare
      // double-spend for a worse wedge risk (a crash mid-session strands the sentinel forever),
      // so it's not worth building unless the double-spend itself becomes the real cost driver.
      decisionPersisted = persistPoolSelection(deps.state, deps.roundId, target, log);
    }
  }

  // #232: the decision write is load-bearing — a failed append skips reconcile entirely rather
  // than labeling GitHub against a decision that was never durably recorded (see
  // persistPoolSelection's own doc comment for the honesty-event/tick-error containment already
  // performed at the failure site above).
  if (decisionPersisted) {
    // #379 F2: a TOTAL label-write failure (applyPoolLabels' throw — see its own doc) is an
    // ENVIRONMENT condition, not a defect to die on: the label may not exist, or this token may
    // not be allowed to write it. Contained HERE, at the one production call site, so the
    // failure behaves the way applyPoolLabels' own message always claimed it did — the round
    // dispatches nothing and the NEXT round re-selects from scratch. Before this, the throw
    // propagated through the aligning PeripheralStub and out of runRounds itself, killing the
    // engine with exit 1 (dogfood 2026-07-24: all 8 pool-label writes failed on first start
    // against labels this repo had never created). The failure is NOT silent — it lands as a
    // durable `pool-labels-failed` event next to the log line — and that event is LOAD-BEARING,
    // not just observability: round.ts's dispatch gate (poolReconcileFailedThisRound) reads it
    // to withhold every dispatch wave this round. An empty RETURN value here would not park
    // anything on its own — the executing phase re-reads pool membership LIVE off GitHub
    // (PoolScopedForge), so an earlier round's residual label, which the reconcile's removal
    // loop never got to, would otherwise dispatch as though this round had selected it (#379
    // gate② P1). `selectRoundPool` (the exported, no-event, direct-call variant) still
    // propagates the throw: it has no state handle to record with, so its caller must see it.
    try {
      await reconcilePoolLabels(forge, cfg, target, log, { state: deps.state, roundId: deps.roundId });
    } catch (e) {
      log(`[sapwood:pool] round ${deps.roundId}: ${String(e)}`);
      try {
        deps.state.appendEvent("pool-labels-failed", { round_id: deps.roundId, attempted: target.length, error: String(e) });
      } catch (writeError) {
        log(`[sapwood:pool] round ${deps.roundId}: failed to record the pool-label-failure event: ${String(writeError)}`);
      }
      return [];
    }
  } else {
    log(`[sapwood:pool] round ${deps.roundId}: skipping label reconcile — the pool-selection decision failed to persist this pass`);
  }
  return target;
}

export interface AlignDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (RoleRunner itself is tested against a
   *  real `claude` stub binary in peripheral.test.ts — this orchestrator's own tests fake the
   *  runner directly, same split as plan-review.ts's PlanReviewDeps). */
  runner: Pick<RoleRunner, "run">;
  now: () => Date;
  log?: (message: string) => void;
  /** Override for readPlanMd's path — tests inject a fixed string via a temp file. A real
   *  caller omits this and gets `cfg.goal.file` (#128): align.ts and architect.ts both read the
   *  project's north-star goal file, so they honor the SAME resolved config value rather than
   *  each hardcoding their own default. */
  planMdPath?: string;
  /** #1078: override for resolveRoundDirective's directive-file path — same seam as planMdPath
   *  above, tests inject a fixed tmp-dir string. A real caller omits this and gets
   *  runtimePaths(defaultRuntimeRoot()).directiveMd (round.directiveFile is retired — no config
   *  key names this path any more). */
  directivePath?: string;
}

/** #621: is there anything THIS round's align-CREATION (decompose) session would actually be
 *  reacting to? An empty Ready pool (this round's milestone scope, same read architect.ts's own
 *  empty-pool short-circuit uses) with no lane CARRIED over a round boundary means the session
 *  would dispatch into a provable no-op: nothing dispatchable, nothing mid-flight to reconsider.
 *  Local (SQLite) reads first, so the one network call (getReadyIssues) is skipped whenever a
 *  carried lane alone already answers the question. Never gates the TRIAGE pass below, which is
 *  already naturally free of this cost (it only dispatches a session per actual planless
 *  candidate).
 *
 *  #637: the carried-lane set here is active/handoff ONLY — gated-reentry (state.
 *  gatedFailedWorkers()) is deliberately EXCLUDED, diverging from probe-signals.ts's own #433
 *  "CARRIED lane" trio (active-lanes/handoff-resume-candidates/gated-reentry-candidates), which
 *  keeps gated-reentry for its OWN, different consumer (conductor.ts's GATED RECLAIM tick-side
 *  phase, #147/#499) and stays accurate as written — the two sets are allowed to differ because
 *  they answer different questions. Live evidence (batch-7, round 317, PR #629's own batch): an
 *  empty Ready pool with three gated-reentry lanes still counted as "carried" here and dispatched
 *  a judgment-tier po-align session that produced `{proposals: [], concerns: []}` — a provable
 *  no-op, since nothing on the gated-reclaim path reads align-CREATION output (only issue
 *  creation/triage consume it). A lane latched to the human-merge queue awaiting release cannot
 *  consume anything a skipped session would have produced, so it no longer holds this skip open.
 *
 *  `roundId <= 1` is exempt (same "no possible prior round" cutoff round-defaults.ts's own
 *  renderLastMergedFromArtifact uses): round.ts's own standby doc is explicit that "the first
 *  round of a run ALWAYS opens, giving the PO its decomposition shot" even over an all-empty
 *  probe — an empty Ready pool on round 1 is exactly the fresh/unscoped-repo case decompose
 *  exists to bootstrap FROM, never evidence there is nothing to do. Skipping it there would
 *  defeat the entire reason round 1 is allowed to open in the first place. */
async function alignCreationHasNothingToDo(forge: IForge, state: State, roundId: number): Promise<boolean> {
  if (roundId <= 1) return false;
  if (state.activeWorkers().length > 0) return false;
  if (state.handoffWorkers().length > 0) return false;
  return (await forge.getReadyIssues()).length === 0;
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
      const now = deps.now;

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
        ...(deps.directivePath !== undefined ? { directivePath: deps.directivePath } : {}),
      });

      let priorProgress: ReturnType<typeof proposalProgress>;
      try {
        priorProgress = proposalProgress(deps.state, roundId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Align degrades open, but creation fails closed: preserve the corrupt journal as a
        // durable honesty event, perform no forge writes, and advance this phase so restarts do
        // not wedge forever on the same malformed record.
        deps.state.appendEvent("proposal-journal-corrupt", { round_id: roundId, reason });
        (deps.log ?? console.error)(`[sapwood:po] round ${roundId}: proposal journal corrupt — creating nothing: ${reason}`);
        return { marker: mark };
      }

      // #310: human-fired oversized issues are handled before the ordinary backlog digest so a
      // successfully fenced tracking parent is not shown to po-align/triage in this same phase.
      try {
        const preDecomposeOpenIssues = await deps.forge.listOpenIssues();
        await runDecompositionPass(deps, roundId, preDecomposeOpenIssues);
      } catch (error) {
        // The ordinary backlog digest below owns its existing explicit failure contract. A
        // decomposition discovery read/session failure must not prevent triage from proceeding.
        (deps.log ?? console.error)(`[sapwood:po] decomposition pass degraded open: ${String(error)}`);
      }

      // #528: ONE bounded recently-closed read per aligning pass, feeding BOTH dedup layers below
      // (the digest the align session sees, and createIssueProposals' mechanical marker/title
      // checks). Deliberately best-effort, unlike the open-issue reads on either side of it: this
      // is a backstop, so a failed read must degrade to the pre-#528 open-only surface — its worst
      // case is today's known blind spot (a re-proposed shipped fact, closeable by hand) — rather
      // than suppress ALL issue creation the way the load-bearing open read does. Named in the log
      // so a round that filed a duplicate can be told apart from one that saw the closed set.
      let recentlyClosedIssues: Issue[] = [];
      try {
        recentlyClosedIssues = await deps.forge.listRecentlyClosedIssues();
      } catch (error) {
        (deps.log ?? console.error)(
          `[sapwood:po] round ${roundId}: recently-closed dedup read failed — closed issues are absent from ` +
            `this pass's dedup surface (degraded to the open-only surface): ${String(error)}`,
        );
      }

      // Compute at align invocation time from the full injected forge backlog. Milestone scope
      // belongs only to the digest; reconciliation/title dedup below must see every open issue.
      // Reuse the same snapshot for triage prompt rendering later in this phase.
      const backlogDigest = await buildBacklogDigest(deps.forge, deps.cfg, recentlyClosedIssues);
      if (!backlogDigest.ok) {
        // #231: a failed open-issue read must SUPPRESS issue creation for this pass (see the
        // creation loop below, gated on `backlogDigest.ok`) rather than let the align session
        // create against an invisible/placeholder inventory with no real duplicate detection.
        // Recorded once per phase invocation, durable and visible regardless of whether a
        // po-align session even runs this pass (the replay branch below still reads the
        // backlog fresh, for triage's prompt) — same "record the hole, don't hide it" stance
        // as the goal-file failure further down.
        try {
          deps.state.appendEvent("backlog-read-failed", { round_id: roundId, reason: backlogDigest.reason ?? "unknown" });
        } catch {
          /* the log line below still lands even if the durable write fails */
        }
        (deps.log ?? console.error)(
          `[sapwood:po] round ${roundId}: backlog digest read failed — issue creation is suppressed this pass ` +
            `(triage proceeds unaffected): ${backlogDigest.reason ?? "unknown"}`,
        );
      }

      // ── Alignment/decomposition pass: at most ONE session, dispatched even with an unscoped
      // fresh round (round.milestone unset) — decomposition still has the goal file to work from
      // alone. A persisted proposal set bypasses the session entirely on a crash rerun.
      // #104: ported to peripheral.ts's shared runSessionWithRetry (outcome-check -> retry-once
      // -> visible-degradation). Same retry-once stance as plan-review.ts's reviewer sessions;
      // the divergence from plan-review's needs-human escalation is deliberate and cheap here:
      // this phase runs PRE-Ready, so a double failure never poisons a dispatch decision — the
      // round advances (marker still set) and the degradation is made observable (a durable
      // event + a log line) instead of wedging the round; the next round retries naturally. ──
      let persistedProposals = priorProgress.proposals;
      let alignValidated: AlignValidation;
      // #394 (F23 gate② fix): true iff the align-CREATION session below actually dispatched
      // (never on the persisted-proposal replay path, nor the goal-file-unreadable abort path)
      // — see the function's own ranSession return for why this matters.
      let alignSessionRan = false;
      // #237: the align session's actual injected view of existing issues — the rendered
      // backlog-digest subset (same set the read-failure suppression above already gates
      // creation on). A concern naming any other issue is out-of-view, invalid output.
      const alignInView = new Set<number>(backlogDigest.ok ? backlogDigest.renderedIssueNumbers : []);
      if (persistedProposals != null) {
        // Crash reruns replay the durable proposal set directly. They never resume an old model
        // session, and they do not pay for a fresh session whose output would be discarded.
        alignValidated = {
          ok: true,
          issues: persistedProposals.map(({ title, body }) => ({ title, body })),
          concerns: priorProgress.concerns ?? [],
        };
      } else if (await alignCreationHasNothingToDo(deps.forge, deps.state, roundId)) {
        // #621: an empty Ready pool with no carried lane — the align-creation session would pay
        // judgment-tier price to reproduce "nothing to do". Skip it outright: no goal-file read,
        // no session, no spend. `align-skipped` is the durable record (never a fabricated
        // WAL/ledger spend entry — this branch never touches the spend ledger at all); triage
        // (below, unconditional) is untouched, and the round proceeds through its remaining
        // phases exactly as it would on any other degrade-open outcome.
        try {
          deps.state.appendEvent("align-skipped", { round_id: roundId, reason: "empty-pool" });
        } catch (e) {
          (deps.log ?? console.error)(`[sapwood:po] round ${roundId}: failed to record the align-skipped honesty event: ${String(e)}`);
        }
        (deps.log ?? console.error)(
          `[sapwood:po] round ${roundId}: Ready pool empty and no carried lane — skipping the po-align session ` +
            `this pass (triage still proceeds unaffected)`,
        );
        alignValidated = { ok: true, issues: [], concerns: [] };
      } else {
        const goalFilePath = deps.planMdPath ?? deps.cfg.goal.file;
        const planRead = readPlanMd(goalFilePath);

        if (!planRead.ok) {
          // #231: an explicit, fail-closed abort of the align-CREATION pass specifically —
          // never a silent "" that lets the session decompose against empty context. No
          // session is spawned (no cost paid for a session working from a false "I read the
          // goal" premise), no creations happen this pass; triage (below, unconditional) never
          // reads this file and is unaffected — the round is never wedged, only this one
          // consuming behavior degrades. The durable goal-file-unreadable event below IS this
          // failure's honesty record — no input-manifest row is written here (#231 gate② F4:
          // there is no session attempt to describe; minting one anyway would be a phantom
          // attempt for a dispatch that never happened).
          try {
            deps.state.appendEvent("goal-file-unreadable", { round_id: roundId, path: goalFilePath, reason: planRead.reason });
          } catch (e) {
            // #231 gate② (Codex sol high F3): unguarded, this throw would escape stub.run —
            // runPeripheral has no catch for a peripheral's own run(), so the phase marker
            // would never persist and the round would wedge, directly contradicting "the round
            // is never wedged" above. Contained exactly like the tick-error append below.
            (deps.log ?? console.error)(
              `[sapwood:po] round ${roundId}: failed to record the goal-file-unreadable honesty event: ${String(e)}`,
            );
          }
          try {
            deps.state.appendEvent("tick-error", {
              error: `round ${roundId}: goal file unreadable at ${goalFilePath}: ${planRead.reason}`,
            });
          } catch {
            /* the goal-file-unreadable append above (or its own log line) already recorded
               this — a tick-error write failure here only loses the aggregate count */
          }
          (deps.log ?? console.error)(
            `[sapwood:po] round ${roundId}: goal file unreadable at ${goalFilePath} — skipping the align-creation ` +
              `session this pass (triage still proceeds): ${planRead.reason}`,
          );
          alignValidated = { ok: false, reason: `goal file unreadable: ${planRead.reason}` };
        } else {
          // #231: this is the ONE place a fresh po-align session attempt happens this phase
          // call. The attempt number is derived HERE — immediately before the real dispatch,
          // after the goal-file check has passed (#231 gate② F4) — not earlier: deriving it
          // before the goal-file check would mint a manifest attempt for a session that never
          // actually ran whenever that check fails, and a crash between an early derivation and
          // this point would leave an attempt number no dispatch ever used. Every input channel
          // THIS session dispatch actually consumes (goal file + backlog digest) shares this
          // one attempt number, and is provably distinguishable from a prior crash-rerun's
          // attempt at the SAME round/phase/session with zero in-memory bookkeeping.
          const attempt = deps.state.nextInputManifestAttempt(roundId, INPUT_MANIFEST_PHASE, INPUT_MANIFEST_ROLE, "po-align");
          recordInputManifest(
            deps.state,
            {
              round_id: roundId,
              phase: INPUT_MANIFEST_PHASE,
              role: INPUT_MANIFEST_ROLE,
              session: "po-align",
              attempt,
              channel: "goal-file",
              // Only ever written here, on the success path (see above) — a REAL dispatch's
              // goal-file channel row always records what it actually read.
              ok: true,
              total: 1,
              rendered: 1,
              omitted: 0,
              truncated: false,
              version: contentVersion(planRead.content),
            },
            deps.log,
          );
          recordInputManifest(
            deps.state,
            {
              round_id: roundId,
              phase: INPUT_MANIFEST_PHASE,
              role: INPUT_MANIFEST_ROLE,
              session: "po-align",
              attempt,
              channel: "backlog-digest",
              ok: backlogDigest.ok,
              total: backlogDigest.total,
              rendered: backlogDigest.rendered,
              omitted: backlogDigest.omitted,
              truncated: backlogDigest.truncated,
              version: backlogDigest.ok ? contentVersion(backlogDigest.text) : null,
              detail: backlogDigest.ok ? null : (backlogDigest.reason ?? "unknown"),
            },
            deps.log,
          );
          const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
            "po.mode": "align",
            "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against the goal file alone)",
            "plan.md": planRead.content,
            "round.directive": directive,
            "backlog.digest": backlogDigest.text,
          });
          alignSessionRan = true;
          const alignResult = await runSessionWithRetry({
            runner: deps.runner,
            state: deps.state,
            session: {
              roleId: "po-align",
              prompt: alignPrompt,
              model: role.model,
              effort: role.effort,
              fallbackModel: role.fallbackModel,
              // #410: WebSearch/WebFetch grant, default on — cfg.webAccess.enabled read HERE, at
              // the call site, never inside peripheral.ts itself (see PO_ALIGN_ALLOWED_TOOLS'
              // own doc for why that placement is what makes the ungranted roles' refusal
              // structural rather than conventional).
              allowedTools: deps.cfg.webAccess.enabled ? PO_ALIGN_ALLOWED_TOOLS : PO_ALLOWED_TOOLS,
              disallowedTools: PO_DISALLOWED_TOOLS,
            },
            issue: 0,
            now,
            ...(deps.log !== undefined ? { log: deps.log } : {}),
            // #251: record this session's ambient-context manifest for EVERY attempt, same
            // (round, phase, role, session, attempt) key shape as the input-manifest rows above
            // — see peripheral.ts's RetriedSession.contextManifest doc. Completes the 9/9 wiring
            // #236 deferred for align.ts's three PO sessions.
            contextManifest: {
              roundId,
              phase: INPUT_MANIFEST_PHASE,
              record: (key, json, at) => deps.state.recordContextManifest(key, json, at),
            },
            degradeEvent: "po-degraded",
            degradePayload: (result) => ({
              round_id: roundId,
              outcome: result.outcome,
              session: result.name,
              reason: alignDegradeReason(result, alignInView),
            }),
            degradeMessage: (result) =>
              `[sapwood:po] round ${roundId}: po-align session failed twice (${result.outcome}) — ` +
              `proceeding (pre-Ready, low stakes; the next round retries naturally): ${alignDegradeReason(result, alignInView)}`,
            isValid: (result) => validateAlignOutput(result.resultText ?? "", alignInView).ok,
            // #374: quota/429 parks instead of degrading — see peripheral.ts's envFailureHook doc.
            envFailure: envFailureHook(deps.cfg, deps.state),
          });
          alignValidated =
            alignResult.outcome === "done"
              ? validateAlignOutput(alignResult.resultText ?? "", alignInView)
              : { ok: false, reason: `po-align session failed twice (${alignResult.outcome})` };
        }
      }
      if (persistedProposals == null) {
        if (alignValidated.ok) {
          persistedProposals = alignValidated.issues.map(({ title, body }, index) => ({
            proposalId: proposalId(roundId, index, title),
            index,
            title,
            body,
          }));
          // Persist-first: no forge creation is reachable until the full validated set lands.
          // #237: concerns travel in the SAME event so a crash-rerun's replay (persistedProposals
          // != null, above) recovers them too — see proposalProgress's own doc comment.
          deps.state.appendEvent("proposal-set-persisted", {
            round_id: roundId,
            proposals: persistedProposals,
            concerns: alignValidated.concerns,
          });
        }
      }

      // Every created issue originates from the VALIDATED array above — the engine is the only
      // caller of forge.createIssue, and its (title, body) signature carries no label field, so
      // a created issue structurally cannot carry a dispatch-path label at creation (the
      // pre-#110 poisoned-label post-check this replaces is deleted outright, see module doc).
      // #231: ALSO gated on the backlog digest read having succeeded this pass — a failed read
      // means there is no reliable duplicate-detection inventory, so creation is suppressed
      // entirely (zero forge.createIssue calls) regardless of what a session proposed or
      // whether these proposals came from a fresh session or a same-round replay; the durable
      // proposal journal is left non-terminal, and the NEXT round's own fresh align pass is
      // where these effectively retry (see the backlog-read-failed honesty event above).
      const backlogOk = backlogDigest.ok;
      const pendingProposalCount = alignValidated.ok ? (persistedProposals ?? []).length : 0;
      const createdIssues = alignValidated.ok && backlogOk ? (persistedProposals ?? []) : [];
      if (alignValidated.ok && !backlogOk && pendingProposalCount > 0) {
        (deps.log ?? console.error)(
          `[sapwood:po] round ${roundId}: backlog digest unavailable — suppressing creation of ${pendingProposalCount} ` +
            `validated proposal(s) this pass`,
        );
      }
      // #123: the aligning phase's own structured summary — what the PO actually decomposed/
      // triaged this round — collected as the loops run and externalized as ONE `align-summary`
      // event at the end. Consumed by the round artifact (round-artifact.ts) and by the
      // architect's pre-dispatch context (round-defaults.ts), replacing the old deterministic
      // pointer note. State event only — no new forge write.
      const alignSummaryCreated: Array<{ issue: number; title: string; hasPlan: boolean }> = [];
      const alignSummaryTriaged: Array<{ issue: number; drafted: boolean }> = [];
      // #237: every triage session's validated concerns this round (both resumed and freshly
      // dispatched) whose accompanying decision actually took effect (finding 6 — collected
      // further down, past both early-continues), fed to postConcerns alongside the align
      // session's own concerns once both passes complete (see the end of this run() call).
      const triageConcernsCollected: Concern[] = [];
      const terminalIds = priorProgress.terminalIds;
      // This read is deliberately fail-closed (unlike the prompt's best-effort digest): it is
      // the reconciliation and pre-create duplicate boundary, so an incomplete backlog must
      // stop creation rather than turn into duplicates.
      const openIssues = createdIssues.length > 0 ? await deps.forge.listOpenIssues() : [];
      const knownOpenIssues = [...openIssues];
      const created = await createIssueProposals({
        forge: deps.forge,
        proposals: createdIssues.map((proposal) => ({ id: proposal.proposalId, title: proposal.title, body: proposal.body })),
        knownOpenIssues,
        recentlyClosedIssues,
        terminalIds,
        createdIssues: priorProgress.createdIssues,
        markerFor: proposalMarker,
        normalizeTitle: normalizeProposalTitle,
        applyGovernance: async ({ proposal, issue }) => {
          await applyProposalGovernance(
            issue,
            extractVerificationPlan(proposal.body) != null,
            proposal.id,
            priorProgress.commentedIds.has(proposal.id),
          );
        },
        onCreated: ({ proposal, issue, reconciled }) => {
          deps.state.appendEvent("proposal-created", {
            round_id: roundId,
            proposalId: proposal.id,
            issue,
            ...(reconciled ? { reconciled: true } : {}),
          });
        },
        onSkipped: (proposal, collision, collisionClosed) => {
          deps.state.appendEvent("proposal-skipped", {
            round_id: roundId,
            proposalId: proposal.id,
            title: proposal.title,
            reason: "normalized-title-collision",
            existingIssue: collision.number,
            // #528: same skip POLICY on both surfaces, distinguishable receipts — a duplicate of a
            // shipped fact reads differently in the log than a duplicate of live work. Absent
            // (not `false`) on the open path, so pre-#528 receipts stay byte-identical.
            ...(collisionClosed ? { existingIssueClosed: true } : {}),
          });
        },
      });
      for (const result of created) {
        alignSummaryCreated.push({
          issue: result.issue,
          title: result.proposal.title,
          hasPlan: extractVerificationPlan(result.proposal.body) != null,
        });
      }

      // #232 F3 (Codex sol high review of PR #249): the ORIGINAL shape here — one receipt
      // (`proposal-created`) appended only AFTER every governance write, including the audit
      // comment — has the same "receipt too coarse" gap #232 fixed for triage: labels are
      // idempotent (safe to always redo, unlike the comment) but `addIssueComment` is NOT — a
      // crash strictly BETWEEN the comment landing and `proposal-created` being appended means a
      // marker-reconcile rerun (the `reconciled` branch above) would call this function AGAIN and
      // repost a duplicate comment. `alreadyCommented` (from priorProgress.commentedIds, read
      // ONCE at the top of this phase call, same "journal read before the loop runs" shape as
      // triageJournal) is what makes the comment step itself resume-safe: skip it entirely when a
      // `proposal-comment-posted` receipt already exists for this proposal, so only the
      // receipt-less remainder (here: none — labels are always safely re-applied) ever repeats.
      async function applyProposalGovernance(
        issueNumber: number,
        hasPlan: boolean,
        thisProposalId: string,
        alreadyCommented: boolean,
      ): Promise<void> {
        // Labels are idempotent and load-bearing — always safe to re-apply on any rerun,
        // regardless of `alreadyCommented`.
        await deps.forge.addLabel(issueNumber, l.originAgent);
        // #397 class 6: a PO-created issue with no verification plan is a routing fence, not an
        // escalation — a human owes nothing here, a plan does. `planless` keeps it off exactly the
        // queues `needsHuman` kept it off (forge.ts's isPlanless) without entering the human queue.
        if (!hasPlan) await deps.forge.addLabel(issueNumber, l.planless);
        if (alreadyCommented) return; // the receipt-less remainder is empty — nothing left to do
        const note = hasPlan
          ? `Created by sapwood's round ${roundId} PO alignment pass (goal decomposition).`
          : `Created by sapwood's round ${roundId} PO alignment pass, but with no verification ` +
            `plan detected — applying \`${l.planless}\` so it is never dispatched ` +
            `planless. A human (or a future triage pass) needs to supply one.`;
        await deps.forge.addIssueComment(issueNumber, `${note}\n\n${mark}`);
        try {
          deps.state.appendEvent("proposal-comment-posted", { round_id: roundId, proposalId: thisProposalId });
        } catch {
          // Best-effort receipt: if THIS append itself fails, a later rerun (before
          // `proposal-created` lands) will repost the comment once more — the same accepted
          // rare-duplicate tradeoff the pre-#232 code already carried for every crash window,
          // just narrowed here to "this specific append also failed" instead of "any crash after
          // the comment at all."
        }
      }

      // ── Triage pass: existing plan-less issues get a plan drafted directly into the body.
      // Marker-idempotent at the round-ledger granularity above; ALSO naturally idempotent at
      // the per-issue level, since a successfully drafted issue now carries a plan section and
      // so no longer matches getIssuesNeedingPlanTriage's candidate query on any later run.
      // #232: additionally write-ahead/receipted/concurrency-guarded — see this file's own
      // "#232: triage write-ahead acceptance" section doc comment above for the full design. ──
      const triageCandidates = await deps.forge.getIssuesNeedingPlanTriage();
      const candidatesByNumber = new Map(triageCandidates.map((issue) => [issue.number, issue]));
      // #232: this round's own decision/receipt journal, read ONCE before the loop — a
      // crash-rerun of this exact phase (marker still null) consults it per candidate below
      // instead of blindly re-dispatching a session for an issue whose decision already landed.
      const triageJournal = triageProgress(deps.state, roundId, deps.log);
      // #232 gate② F1: the RECOVERY set is candidates UNION every non-terminal decision from the
      // journal — getIssuesNeedingPlanTriage() alone would silently drop an issue whose body
      // write already landed (it now HAS a plan section, so the real selector excludes it) but
      // whose receipt(s) never did, leaving that decision permanently unterminated. A number that
      // only exists in the journal (not in candidatesByNumber) is processed below purely by
      // number — its stored decision (body + expected_hash + attempt) is everything the resume
      // path needs; no `Issue` object is required for it.
      const recoveryOnlyNumbers = [...triageJournal.decisions.keys()].filter((n) => !candidatesByNumber.has(n));
      const triageWorkNumbers = [...triageCandidates.map((issue) => issue.number), ...recoveryOnlyNumbers];
      // #374 review (Codex sol-high verify-pass finding 1, P1 — fixes a journal-resumption loss
      // the finding-1 canary fix itself introduced): once true, the REMAINING candidates that
      // would need a FRESH session are skipped — but a journal resumption (an earlier attempt
      // THIS round already durably recorded a decision for) dispatches NO session at all, so it
      // must still execute even after the park is observed; skipping it too would permanently
      // lose its still-pending comment/concern/receipts, since no later pass ever re-dispatches a
      // session for a number the journal already has a decision for (see `resumed` below —
      // triageProgress only reads THIS round's decisions, and the phase marker persists at this
      // function's return regardless). See the per-iteration check just below the loop line for
      // where this is consulted, and the `sawEnvPark`-setting fresh-dispatch branch further down
      // for where it gets set.
      let envParkedThisPass = false;
      // #394 (F23 gate② fix): true iff ANY triage iteration below actually dispatches a fresh
      // session (the `resumed` branch replays a durably-recorded decision with no session at
      // all) — folded into this function's own ranSession return alongside alignSessionRan.
      let triageSessionRan = false;
      for (let triageIdx = 0; triageIdx < triageWorkNumbers.length; triageIdx++) {
        const number = triageWorkNumbers[triageIdx]!;
        const resumed = triageJournal.decisions.get(number);
        // A resumption dispatches nothing — it is always safe (and REQUIRED, see the doc above)
        // to keep processing it even once envParkedThisPass is true. Only a candidate that would
        // need a brand-new session is skipped here.
        if (envParkedThisPass && !resumed) {
          alignSummaryTriaged.push({ issue: number, drafted: false });
          continue;
        }
        let validated: TriageValidation;
        let expectedHash: string;
        let attempt: number;
        let bodyAlreadyCommitted: boolean;
        // #374 review (Codex sol-high verify-pass finding 1, P1 — fixes a recovery canary
        // starvation the original finding-6 fix introduced): set ONLY when THIS iteration's OWN
        // fresh session dispatch comes back env-classified — NEVER pre-checked against "a park
        // row merely exists" before dispatching. The first (and every) candidate always gets a
        // real attempt; only once one of them actually observes a classified quota/429 does the
        // loop start skipping FRESH candidates for the rest of this pass (journal resumptions are
        // exempt — see envParkedThisPass's own doc above). Gating on pre-existing park state
        // instead would let an ARMED recovery round (round.ts's green-ping canary, which only
        // arms the round to open — it never clears the episode outright) skip every candidate
        // before any of them had a chance to prove recovery, wedging the engine parked forever. A
        // resumed (durably-decided, no fresh session) candidate can never set this — it
        // dispatches nothing.
        let sawEnvPark = false;

        if (resumed) {
          // #232 gate② F2: a terminal event only resolves THIS decision when its attempt
          // matches — a terminal event recorded for a DIFFERENT (stale/superseded) attempt must
          // never short-circuit the current one (see this section's module doc above).
          if (triageJournal.terminalAttempts.get(number) === resumed.attempt) continue;
          // #232: RESUME — an accepted decision exists from an earlier attempt this round with
          // no terminal receipt (crash between decision-persist and effect-commit). The durable
          // decision IS what executes now — no session, no re-validation, no re-render.
          validated = { ok: true, issue: number, body: resumed.body, concerns: resumed.concerns };
          expectedHash = resumed.expectedHash;
          attempt = resumed.attempt;
          bodyAlreadyCommitted = triageJournal.bodyCommittedAttempts.get(number) === attempt;
        } else {
          // No readable decision for this number — either genuinely fresh, or #232 gate② F2's
          // malformed/unreadable-record case (treated as absent). Either way this dispatches a
          // BRAND NEW session/attempt, and any receipt that might exist for a stale attempt is
          // never consulted below (bodyAlreadyCommitted starts false; the attempt-matching check
          // above is what keeps a stale receipt from a prior attempt out of this decision's way).
          const issue = candidatesByNumber.get(number);
          if (!issue) continue; // unreachable by construction — every non-resumed number came from triageCandidates
          // #231: this triage session's own input-manifest rows. `session` is scoped to THIS
          // issue so a crash-rerun's re-triage of the same still-planless issue is its own
          // distinguishable attempt, independent of every other candidate this loop processes.
          // ONE attempt number covers BOTH channels this dispatch actually consumes (#231 gate②
          // F2/F4 — same "derive once per dispatch, share across its channel rows" shape as
          // po-align above), and ALSO becomes this decision's own identity (#232 gate② F2 — the
          // SAME number links the accepted-decision event and both its receipts back to this
          // exact input-manifest attempt):
          //  - "issue-body": the po.md triage prompt renders {{issue.number}}/{{issue.title}}/
          //    {{issue.labels}}/{{issue.body}} (see po.md's triage section) — the version hash
          //    covers that FULL rendered context, not body alone, so a title/label edit with an
          //    unchanged body still shows up as a version change (#231 gate② F2).
          //  - "backlog-digest": the triage prompt ALSO substitutes {{backlog.digest}} (po.md's
          //    shared template) — recording the SAME backlogDigest object's real ok/counts/
          //    truncated flags here (not an assumed ok:true) closes the incoherence a failed
          //    backlog read previously left: a triage session that actually saw the failure
          //    placeholder must not have its only manifest row claim ok:true (#231 gate② F2).
          const triageAttempt = deps.state.nextInputManifestAttempt(
            roundId,
            INPUT_MANIFEST_PHASE,
            INPUT_MANIFEST_ROLE,
            `po-triage:${number}`,
          );
          recordInputManifest(
            deps.state,
            {
              round_id: roundId,
              phase: INPUT_MANIFEST_PHASE,
              role: INPUT_MANIFEST_ROLE,
              session: `po-triage:${number}`,
              attempt: triageAttempt,
              channel: "issue-body",
              ok: true,
              version: contentVersion(
                JSON.stringify({ number: issue.number, title: issue.title, labels: issue.labels, body: issue.body ?? "" }),
              ),
              total: 1,
              rendered: 1,
              omitted: 0,
              truncated: false,
            },
            deps.log,
          );
          recordInputManifest(
            deps.state,
            {
              round_id: roundId,
              phase: INPUT_MANIFEST_PHASE,
              role: INPUT_MANIFEST_ROLE,
              session: `po-triage:${number}`,
              attempt: triageAttempt,
              channel: "backlog-digest",
              ok: backlogDigest.ok,
              total: backlogDigest.total,
              rendered: backlogDigest.rendered,
              omitted: backlogDigest.omitted,
              truncated: backlogDigest.truncated,
              version: backlogDigest.ok ? contentVersion(backlogDigest.text) : null,
              detail: backlogDigest.ok ? null : (backlogDigest.reason ?? "unknown"),
            },
            deps.log,
          );
          const triagePrompt = renderRolePrompt(template, issue, deps.cfg, {
            "po.mode": "triage",
            "round.milestone": deps.cfg.round.milestone ?? "",
            "plan.md": "",
            "round.directive": directive,
            "backlog.digest": backlogDigest.text,
          });
          // #237 finding 7 (2026-07-18 adjudication): narrowed to the target issue ONLY — the
          // triage prompt (po.md) explicitly tells the session "the only issue you may name is
          // {{issue.number}} itself"; the backlog digest is duplicate-avoidance CONTEXT for the
          // drafted body, never a grant to raise a concern about some OTHER issue in it (that
          // capability belongs to align mode alone). Widening this set would accept output the
          // prompt itself never offers, a contract mismatch between prompt and validator.
          const triageInView = new Set<number>([issue.number]);
          triageSessionRan = true;
          const triageResult = await runSessionWithRetry({
            runner: deps.runner,
            state: deps.state,
            session: {
              roleId: "po-triage",
              prompt: triagePrompt,
              model: role.model,
              effort: role.effort,
              fallbackModel: role.fallbackModel,
              // #410: same grant/call-site rationale as the po-align session above.
              allowedTools: deps.cfg.webAccess.enabled ? PO_TRIAGE_ALLOWED_TOOLS : PO_ALLOWED_TOOLS,
              disallowedTools: PO_DISALLOWED_TOOLS,
            },
            issue: issue.number,
            now,
            ...(deps.log !== undefined ? { log: deps.log } : {}),
            // #251: record this session's ambient-context manifest for EVERY attempt, same
            // (round, phase, role, session, attempt) key shape as the input-manifest rows above
            // — see peripheral.ts's RetriedSession.contextManifest doc. Completes the 9/9 wiring
            // #236 deferred for align.ts's three PO sessions.
            contextManifest: {
              roundId,
              phase: INPUT_MANIFEST_PHASE,
              record: (key, json, at) => deps.state.recordContextManifest(key, json, at),
            },
            degradeEvent: "triage-degraded",
            degradePayload: (result) => ({
              round_id: roundId,
              issue: issue.number,
              outcome: result.outcome,
              session: result.name,
              reason: triageDegradeReason(result, issue.number, triageInView),
            }),
            degradeMessage: (result) =>
              `[sapwood:po] round ${roundId}: po-triage session failed twice (${result.outcome}) for issue ` +
              `#${issue.number} — proceeding (pre-Ready, low stakes; the next round retries naturally): ` +
              `${triageDegradeReason(result, issue.number, triageInView)}`,
            isValid: (result) => validateTriageOutput(result.resultText ?? "", issue.number, triageInView).ok,
            // #374: quota/429 parks instead of degrading — see peripheral.ts's envFailureHook doc.
            envFailure: envFailureHook(deps.cfg, deps.state),
          });
          sawEnvPark = triageResult.envParked === true;
          validated =
            triageResult.outcome === "done"
              ? validateTriageOutput(triageResult.resultText ?? "", issue.number, triageInView)
              : { ok: false, reason: `po-triage session failed twice (${triageResult.outcome})` };
          // #232: the concurrent-edit guard's precondition — the hash of the BODY this session
          // actually read (captured HERE, at candidate-fetch/prompt-render content, before the
          // write ever happens), not re-derived later when the live body may already differ.
          expectedHash = contentVersion(issue.body ?? "");
          attempt = triageAttempt;
          bodyAlreadyCommitted = false; // a brand-new attempt can never already have a receipt
          // #703 v2 gate② (P1-1): role-marker normalization/precondition is deliberately NOT
          // applied here, at decision time — `validated.body` is persisted into the
          // `triage-decision-accepted` journal RAW, exactly as the session produced it (roles
          // have no standing over the marker, but that is enforced at the WRITE boundary, not by
          // pre-editing what gets journaled). See `updateIssueBodyIfUnchanged`'s own doc for why:
          // normalizing HERE (against `issue.body`) and AGAIN at write time would be redundant in
          // the common case, but WRONG for a crash-resumed decision from a pre-#703 engine —
          // "whatever marker is live at write time wins" must hold for every decision regardless
          // of which engine version produced its journal record, so there is exactly ONE
          // normalization point: the write itself, applied uniformly to fresh and resumed alike.
        }

        if (!validated.ok) {
          // Malformed-twice/failed-twice already went through runSessionWithRetry's own
          // isValid-driven retry+degrade above (triage-degraded fired there) — nothing further
          // to do: no write, no success comment, the candidate re-matches next round.
          alignSummaryTriaged.push({ issue: number, drafted: false });
          if (sawEnvPark) {
            envParkedThisPass = true;
            // #374 review (Codex sol-high verify-pass finding 1, P1): never a `break` — the
            // remaining FRESH candidates are skipped (via the per-iteration check at the top of
            // this loop, from the NEXT iteration onward), but any remaining JOURNAL RESUMPTION
            // still executes this same pass (see envParkedThisPass's own doc above for why that
            // distinction is load-bearing).
            const remainingFresh = triageWorkNumbers.slice(triageIdx + 1).filter((n) => !triageJournal.decisions.has(n)).length;
            (deps.log ?? console.error)(
              `[sapwood:po] round ${roundId}: llm park active — skipping ${remainingFresh} remaining FRESH ` +
                `triage candidate(s) this pass (journal resumptions, if any, still run)`,
            );
          }
          continue;
        }
        // #232: write-ahead acceptance — the validated decision is durably recorded BEFORE any
        // forge effect. Skipped on the resume path (`resumed` already IS that durable record).
        if (!resumed) {
          const persisted = persistTriageDecision(
            deps.state,
            roundId,
            number,
            attempt,
            validated.body,
            expectedHash,
            validated.concerns,
            deps.log,
          );
          if (!persisted) {
            // Fail-closed: the decision itself never landed durably, so no effect may start for
            // it this pass (persistTriageDecision already recorded the honesty event + tick-
            // error). The round is not wedged — this candidate simply re-matches next round.
            alignSummaryTriaged.push({ issue: number, drafted: false });
            continue;
          }
        }

        // #232: guarded, resume-safe body write (updateIssueBodyIfUnchanged's own doc comment
        // covers the resume-safety and stale-hash-refusal contracts). The write is EARNED by
        // validated output, never by the session's exit code alone — same "schema-valid is not
        // the same as truthful" stance issue #110 requires, applied to the write itself rather
        // than just the comment below. Skipped entirely when a `triage-body-committed` receipt
        // for THIS EXACT attempt already exists — the write already landed; re-running the guard
        // would just re-read the (now matching) live body for no benefit.
        if (!bodyAlreadyCommitted) {
          // #703 v2 gate② (P1-1): `validated.body` here is the RAW role/journal text, fresh OR
          // resumed alike — `updateIssueBodyIfUnchanged` is now the ONE place that normalizes it
          // against whatever marker is actually live, and the ONE place that can refuse the
          // write over an invalid CURRENT marker. See that function's own doc for the full design
          // (including why this fixes a pre-#703-journaled decision replayed after a mid-round
          // deploy, without any journal-versioning machinery).
          const guard = await updateIssueBodyIfUnchanged(deps.forge, number, validated.body, expectedHash);
          if (!guard.applied) {
            if (guard.reason === "invalid-marker") {
              // #703 v2 gate② (P1-1 + item 2, the refusal arm): the CURRENT live body's own
              // marker state is already invalid (duplicate/malformed) — refused, never "repaired."
              // No forge write of any kind happens on this branch, so — unlike the concurrent-
              // edit case below — there is nothing here for a same-round crash-resume to need a
              // terminal receipt to avoid re-doing: re-hitting this exact branch again is a no-op
              // repeat of the same refusal, harmless. `getIssuesNeedingPlanTriage` naturally
              // re-offers this issue every future round until a human fixes the marker directly.
              (deps.log ?? console.error)(
                `[sapwood:po] round ${roundId}: triage write refused for #${number} — the issue body's ` +
                  `adjudication-cursor marker is invalid (${guard.detail}); a role write cannot repair ` +
                  `human-owned marker state — fix it directly, this issue re-matches every future round`,
              );
              alignSummaryTriaged.push({ issue: number, drafted: false });
              continue;
            }
            if (guard.reason === "operator-fence-violation" || guard.reason === "malformed-operator-fence") {
              // #827 / gate② round 1 fix (P1a): the role's triage body-write altered/removed an
              // operator-owned fenced block (the PO's own testimony), OR the CURRENT body's own
              // fence boundary is malformed (an unclosed opener) — both refused, same
              // non-repairing stance as the invalid-marker arm above; a malformed fence is never
              // silently "repaired" or treated as absent. No forge write happened, so a
              // same-round crash-resume hitting this branch again is a harmless repeat.
              try {
                deps.state.appendEvent("operator-fence-violated", {
                  round_id: roundId,
                  issue: number,
                  phase: "po-triage",
                  detail: guard.detail,
                });
              } catch {
                /* best-effort honesty event — the log line below still lands */
              }
              (deps.log ?? console.error)(`[sapwood:po] round ${roundId}: triage write refused for #${number} — ${guard.detail}`);
              alignSummaryTriaged.push({ issue: number, drafted: false });
              continue;
            }
            // Concurrent edit detected: refuse the write, keep the old body, record a durable
            // honesty event (terminal for this round — see triageProgress's `terminalAttempts`
            // map), and degrade open. The candidate's body is untouched, so a FRESH round-start
            // read (a new triage session against the NOW-current body) can retry it, never a
            // blind overwrite.
            try {
              deps.state.appendEvent("triage-stale-hash-skipped", {
                round_id: roundId,
                issue: number,
                phase: INPUT_MANIFEST_PHASE,
                role: INPUT_MANIFEST_ROLE,
                session: `po-triage:${number}`,
                attempt,
                expected_hash: expectedHash,
                actual_hash: guard.actualHash,
              });
            } catch {
              /* best-effort honesty event — the log line below still lands */
            }
            (deps.log ?? console.error)(
              `[sapwood:po] round ${roundId}: triage write refused for #${number} — the issue body changed since ` +
                `the session read it (concurrent edit); the old body is kept, retry next round from a fresh read`,
            );
            alignSummaryTriaged.push({ issue: number, drafted: false });
            continue;
          }
          // #232: body-write receipt — so a crash strictly BETWEEN this write and the comment
          // below is distinguishable, on a later crash-rerun this same round, from "never wrote"
          // without relying on updateIssueBodyIfUnchanged's own content-equality check alone.
          try {
            deps.state.appendEvent("triage-body-committed", {
              round_id: roundId,
              issue: number,
              phase: INPUT_MANIFEST_PHASE,
              role: INPUT_MANIFEST_ROLE,
              session: `po-triage:${number}`,
              attempt,
            });
          } catch {
            /* best-effort — updateIssueBodyIfUnchanged's own content-equality check still makes a
               re-run's write idempotent even without this receipt */
          }
        }

        // #237 finding 6 (2026-07-18 adjudication): collected ONLY once the decision this
        // concern rode along with actually took effect — either a resumed decision (already
        // durably persisted in an earlier attempt, by definition) or a freshly-persisted
        // decision whose guarded body write just succeeded (or was already committed). Both
        // early `continue`s above (persistTriageDecision failure, stale-hash refusal) skip this
        // line entirely — a concern must never outlive the decision it was validated alongside;
        // if the PO still holds it, the SAME worded concern is re-raised (and reposted) next
        // round once the candidate is re-triaged from a fresh read.
        triageConcernsCollected.push(...validated.concerns);

        const planLanded = extractVerificationPlan(validated.body) != null;
        alignSummaryTriaged.push({ issue: number, drafted: planLanded });
        if (planLanded) {
          // #232 F3 symmetry: `addIssueComment` is not idempotent — skip re-posting when a
          // `triage-comment-posted` receipt for THIS EXACT attempt already exists (a crash
          // strictly between the comment landing and `triage-effects-committed` below, on a
          // later crash-rerun this same round).
          if (triageJournal.commentPostedAttempts.get(number) !== attempt) {
            await deps.forge.addIssueComment(number, `PO triage pass (round ${roundId}) drafted a plan into this issue's body.\n\n${mark}`);
            try {
              deps.state.appendEvent("triage-comment-posted", {
                round_id: roundId,
                issue: number,
                phase: INPUT_MANIFEST_PHASE,
                role: INPUT_MANIFEST_ROLE,
                session: `po-triage:${number}`,
                attempt,
              });
            } catch {
              // Best-effort: if THIS append itself fails, a later crash-rerun (before
              // triage-effects-committed lands) may repost the comment once more — the narrowed
              // "this specific append also failed" tradeoff, same shape as
              // applyProposalGovernance's own proposal-comment-posted append above.
            }
          }
        } else {
          // A schema-VALID draft that still left the body planless is its own degradation shape
          // (distinct from a malformed/failed session, which already degraded above) — the
          // pre-#110 "done but still planless" outcome, preserved: no success comment (it would
          // be a false audit-trail entry), a durable event, the candidate re-matches next round.
          try {
            deps.state.appendEvent("triage-degraded", { round_id: roundId, issue: number, outcome: "no-plan-after-draft" });
          } catch {
            /* state write failed — the console line below still lands */
          }
          (deps.log ?? console.error)(
            `[sapwood:po] round ${roundId}: triage left issue #${number} still planless — ` +
              `no success comment posted; the candidate re-matches next round`,
          );
        }
        // #232: terminal receipt — this issue's decision is now fully resolved for THIS round
        // (comment posted-or-skipped-via-receipt, or explicitly degraded above). Best-effort:
        // losing it only costs a LATER crash-rerun this round the chance to skip straight past
        // this issue (it would redo the resume-safe guard/write and comment steps, both of which
        // are themselves receipt-guarded no-ops by this point).
        try {
          deps.state.appendEvent("triage-effects-committed", {
            round_id: roundId,
            issue: number,
            phase: INPUT_MANIFEST_PHASE,
            role: INPUT_MANIFEST_ROLE,
            session: `po-triage:${number}`,
            attempt,
          });
        } catch {
          /* best-effort receipt — see the comment above */
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

      // #237: the PO dissent channel — post this round's freshly validated concerns (align +
      // every triage session), idempotent by marker (dissent.ts's postConcernIfNew). #237
      // finding 5 (2026-07-18 adjudication): the adjudication SCAN is deliberately NOT called
      // here — it is a separate, unconditional round-level call wired from round-defaults.ts's
      // aligning wrapper, so it still runs even when this phase never reaches this line
      // (roles.po.enabled: false skips alignStub.run entirely; a corrupt proposal journal
      // early-returns above). Posting is still gated by the SAME phase marker every other
      // aligning-phase write already is (this call only happens once per round, on the attempt
      // that reaches here with `marker` still null coming in).
      await postConcerns({
        forge: deps.forge,
        state: deps.state,
        cfg: deps.cfg,
        roundId,
        concerns: [...(alignValidated.ok ? alignValidated.concerns : []), ...triageConcernsCollected],
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });

      // #394 (F23 gate② fix): ranSession is the OR of the two session dispatch points THIS
      // function itself owns (alignSessionRan/triageSessionRan, tracked above at their exact
      // `runSessionWithRetry` call sites — never inferred from "did we reach here", which gate②
      // review traced to a REACHABLE permanent-block: cfg.goal.file unreadable (persists every
      // round, no align session) + an empty board (zero Ready issues, zero triage sessions) +
      // a quota storm the text/telemetry classifier misses would have every round report
      // ranSession:true while never landing in degradedPhases, making the empty-spin breaker's
      // required-set check permanently unsatisfiable — the exact failure mode this breaker
      // exists to catch). round-pool selection is this round-phase's THIRD possible session
      // (#212/#233's runPoolSelection, dispatched separately by round-defaults.ts's aligning
      // wrapper, never from inside this function) — that caller ORs in its own
      // PoolSelectionRunDeps.onSessionRan signal alongside this function's return before handing
      // the final ranSession to round.ts; see that wrapper's own comment.
      return { marker: mark, ranSession: alignSessionRan || triageSessionRan };
    },
  };
}
