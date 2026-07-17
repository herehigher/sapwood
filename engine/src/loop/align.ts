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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import { resolveRoundDirective } from "../config/directive.js";
import type { IForge, Issue } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "../roles/plan-review.js";
import type { InputManifestRow, State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import { issuePriority } from "./conductor.js";
import { type PeripheralStub, removeRoundPoolLabel } from "./round.js";

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

export function proposalMarker(id: string): string {
  return `<!-- sapwood:proposal:${id} -->`;
}

/** Mechanical duplicate guard only: case, compatibility forms, punctuation, and whitespace
 *  do not make two otherwise-identical titles distinct. Semantic duplication remains a PO
 *  judgment problem (#215). */
export function normalizeProposalTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function defaultPoPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own defaults.
  return join(here, "..", "..", "prompts", "po.md");
}

const DEFAULT_PLAN_MD_PATH = "docs/PLAN.md";

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

export function packDigestRecords(lines: readonly string[], maxChars: number, emptyText: string, noun = "issue"): BoundedDigest {
  const total = lines.length;
  if (total === 0) return { text: emptyText, total: 0, rendered: 0, omitted: 0, truncated: false };

  const rendered: string[] = [];
  let used = 0;
  for (const line of lines) {
    const added = (rendered.length > 0 ? 1 : 0) + line.length; // +1 for the join newline
    if (used + added > maxChars) break;
    rendered.push(line);
    used += added;
  }
  if (rendered.length === total) {
    return { text: rendered.join("\n"), total, rendered: total, omitted: 0, truncated: false };
  }

  const marker = (renderedCount: number): string =>
    `\n\n[... ${total - renderedCount} more ${noun}(s) omitted — exceeded the ${maxChars}-char cap; ${renderedCount}/${total} rendered ...]`;
  // Never slices a record: drop whole trailing lines (bounded — at most `rendered.length`
  // iterations, and these lists are small: backlog/pool candidate counts) until the marker fits
  // alongside what's kept. Same "the cap is never exceeded either way" contract as capDigest.
  while (rendered.length > 0) {
    const body = rendered.join("\n");
    const m = marker(rendered.length);
    if (body.length + m.length <= maxChars) {
      return { text: body + m, total, rendered: rendered.length, omitted: total - rendered.length, truncated: true };
    }
    rendered.pop();
  }
  // Nothing fits even with zero rendered lines (a pathologically tiny cap) — last-resort hard
  // truncation of the marker itself, same fallback shape as capDigest's own.
  const m = marker(0);
  return { text: m.length <= maxChars ? m : m.slice(0, maxChars), total, rendered: 0, omitted: total, truncated: true };
}

export interface BacklogDigestResult extends BoundedDigest {
  /** false iff the underlying open-issue read itself threw — the #231 fail-closed signal
   *  createAligningStub's creation loop keys off of to SUPPRESS issue creation for this pass
   *  (never a silent placeholder the align session can't tell apart from "zero open issues"). */
  ok: boolean;
  /** Failure reason, present only when `ok` is false. */
  reason?: string;
}

/** Engine-side PO context (#215): deterministic, milestone-scoped here at the digest consumer.
 *  #231: a read failure is no longer swallowed into an indistinguishable placeholder string —
 *  `ok: false` (+ `reason`) is the explicit, checkable signal createAligningStub's creation loop
 *  and the durable `backlog-read-failed` honesty event key off of. Truncation never slices a
 *  mid-record line (packDigestRecords above), so a caller can always tell which issues were
 *  actually shown to the session vs. merely counted as omitted. */
export async function buildBacklogDigest(forge: IForge, cfg: SapwoodConfig): Promise<BacklogDigestResult> {
  let issues: Issue[];
  try {
    const allIssues = await forge.listOpenIssues();
    issues = filterIssuesByMilestone(allIssues, cfg.round.milestone);
  } catch (e) {
    return { text: BACKLOG_READ_FAILED, ok: false, total: 0, rendered: 0, omitted: 0, truncated: false, reason: String(e) };
  }
  if (issues.length === 0) {
    return { text: NO_OPEN_ISSUES, ok: true, total: 0, rendered: 0, omitted: 0, truncated: false };
  }
  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const lines = ordered.map((issue) => {
    const holds = cfg.escalation.humanLabels.filter((label) => labelsInclude(issue.labels, label));
    const annotation = holds.length > 0 ? ` [hold: ${holds.join(", ")}]` : "";
    return `- #${issue.number} — ${issue.title}${annotation}`;
  });
  return { ...packDigestRecords(lines, cfg.roles.po.backlogDigestMaxChars, NO_OPEN_ISSUES), ok: true };
}

function filterIssuesByMilestone(issues: Issue[], milestone: string | undefined): Issue[] {
  return milestone === undefined ? issues : issues.filter((issue) => issue.milestone === milestone);
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
// Coverage in THIS PR: goal-file + backlog-digest (po-align), issue-body (po-triage),
// pool-candidates (po-pool) — every input channel align.ts itself reads. Two more channels the
// issue names (`lastMerged`, architect's "fetched details") belong to OTHER peripherals
// (round-defaults.ts / harvest.ts / architect.ts) outside this module's own dispatch sites and
// are deliberately left uninstrumented here — see this PR's description for that scope call.
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

interface PersistedProposal {
  proposalId: string;
  index: number;
  title: string;
  body: string;
}

const PersistedProposalSchema = z
  .object({ proposalId: z.string().min(1), index: z.number().int().nonnegative(), title: z.string().min(1), body: z.string().min(1) })
  .strict();
const ProposalSetEventSchema = z.object({ round_id: z.number().int().positive(), proposals: z.array(PersistedProposalSchema) }).strict();
const ProposalCreatedEventSchema = z
  .object({ round_id: z.number().int().positive(), proposalId: z.string().min(1), issue: z.number().int().positive() })
  .passthrough();
const ProposalSkippedEventSchema = z.object({ round_id: z.number().int().positive(), proposalId: z.string().min(1) }).passthrough();

/** Read this round's persist-first proposal journal. Malformed or divergent durable records
 *  fail closed: guessing would risk recreating issues. */
function proposalProgress(
  state: State,
  roundId: number,
): { proposals: PersistedProposal[] | null; terminalIds: Set<string>; createdIssues: Map<string, number> } {
  const events = state.eventsAfterId(0, ["proposal-set-persisted", "proposal-created", "proposal-skipped"]);
  let proposals: PersistedProposal[] | null = null;
  const terminalIds = new Set<string>();
  const createdIssues = new Map<string, number>();
  for (const event of events) {
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
  return { proposals, terminalIds, createdIssues };
}

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

// ── #212/#233: round-pool selection ─────────────────────────────────────────────────────────
//
// The engine ALWAYS computes the CANDIDATE set deterministically (Ready, milestone-scoped by
// whatever `forge` already applies — see AlignDeps.forge — ordered prio:0-first then
// issue-number-ascending, capped at ceil(lanes.roundDispatchCap * round.poolFactor)). #233:
// controlled experiments across model tiers found a title-only PO pool-selection SESSION
// selects EVERY candidate at every tier — it has no evidentiary basis to narrow the reservoir
// from a bare title/number digest, so it just burns a session per round reproducing this same
// deterministic set. Worse, `round.poolFactor` exists to absorb architect/gate⓪ attrition
// AFTER selection; a session that DOES narrow the reservoir pre-gates risks underfilling the
// round. So the deterministic candidate set is now the MAIN path — this is `selectRoundPool`'s
// documented behavior AND `runPoolSelection`'s default (roles.po.poolSelection: false).
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
// Either way (`poolSelection` true or false), the engine ATTEMPTS to write the durable
// `pool-selected` event — it records what was actually acted on, not what could be recomputed,
// which is what makes a crash-rerun of this exact phase replay-safe when the write lands.
// persistPoolSelection's write is best-effort today, not fail-closed (see its own doc comment):
// an append failure is logged and reconciliation proceeds regardless, on every path, exactly as
// before #233. Making the write load-bearing (fail closed, or otherwise guaranteed) is scoped
// to #232, not this change.
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
 *  branch. Best-effort: a write failure here is logged, never thrown — GitHub's live label
 *  state (reconciled immediately after this call returns) remains the actual source of truth;
 *  losing the durable record only costs a future crash-rerun the replay optimization (it
 *  recomputes, and — on the session path — pays for a fresh session), never correctness:
 *  reconcile still converges labels to whatever target that rerun lands on. */
function persistPoolSelection(state: State, roundId: number, target: readonly Issue[], log?: (message: string) => void): void {
  try {
    state.appendEvent("pool-selected", { round_id: roundId, issues: target.map((i) => i.number) });
  } catch (e) {
    (log ?? console.error)(`[sapwood:pool] round ${roundId}: failed to persist the pool-selection record: ${String(e)}`);
  }
}

/** The deterministic candidate/fallback ordering: Ready, sorted prio:0-first then issue-number-
 *  ascending, capped at `ceil(cfg.lanes.roundDispatchCap * cfg.round.poolFactor)`. Pure read, no
 *  forge writes — shared by the candidate digest (below) and every fallback path. A forge read
 *  failure propagates (callers decide how to degrade; see selectRoundPool/runPoolSelection). */
async function computePoolCandidates(forge: IForge, cfg: SapwoodConfig): Promise<Issue[]> {
  const cap = Math.ceil(cfg.lanes.roundDispatchCap * cfg.round.poolFactor);
  const ready = await forge.getReadyIssues();
  return [...ready]
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
  // of returning as if the pool were legitimately empty. Thrown out of the aligning phase's
  // PeripheralStub, this reaches round.ts's runPeripheral uncaught — the phase marker is never
  // persisted, so a crash-rerun (the SAME rerun-not-resume contract every peripheral relies on)
  // retries selection from scratch instead of silently advancing past aligning with an empty
  // pool and a marker that claims the phase succeeded. A validly EMPTY selection (the session
  // chose zero candidates, or the deterministic path had zero candidates to begin with) never
  // hits this — `issues.length === 0` short-circuits the guard, exactly the "select none is a
  // valid, complete outcome" case the po-pool prompt documents.
  if (issues.length > 0 && successes === 0) {
    throw new Error(
      `round-pool selection: ALL ${issues.length} label write(s) failed — refusing to silently advance past ` +
        `aligning with an empty pool; the phase will retry on the next attempt`,
    );
  }
}

/** Optional durable-event context for reconcilePoolLabels' incomplete-removal honesty record —
 *  omitted by callers (e.g. selectRoundPool) that have no round context of their own; the
 *  reconcile still runs identically, it just can't durably record an incomplete pass (a log
 *  line still fires either way). */
interface ReconcileEventCtx {
  state: Pick<State, "appendEvent">;
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
  const failedRemovals: number[] = [];
  for (const issue of openIssues) {
    if (targetNumbers.has(issue.number)) continue;
    if (!labelsInclude(issue.labels, cfg.labels.roundPool)) continue;
    try {
      await removeRoundPoolLabel(forge, cfg, issue.number, cfg.labels.roundPool);
    } catch (e) {
      warn(`[sapwood:pool] round-pool reconcile: failed to remove the stale pool label from #${issue.number}: ${String(e)}`);
      failedRemovals.push(issue.number);
    }
  }
  if (failedRemovals.length > 0) recordIncomplete({ failed_issues: failedRemovals });
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

/** The pool-selection session's candidate digest — number, title, and the raw prio label (if
 *  any) for every candidate, in the SAME prio/number order the session sees as "already ranked
 *  for you." Deterministic, capped (reuses roles.po.backlogDigestMaxChars — the candidate set is
 *  naturally small, bounded by the pool cap, so this is a safety valve here, not a real budget
 *  most deployments tune). #231: whole-record packed (packDigestRecords), the same fix as
 *  buildBacklogDigest above — a candidate near the cap's tail is rendered or counted as
 *  omitted, never silently sliced away mid-line. */
function buildPoolCandidateDigest(candidates: readonly Issue[], cfg: SapwoodConfig): BoundedDigest {
  const lines = candidates.map((issue) => `- #${issue.number} — ${issue.title}`);
  return packDigestRecords(lines, cfg.roles.po.backlogDigestMaxChars, "(no Ready candidates this round)", "candidate issue");
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
  now?: () => Date;
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
 *  (persistPoolSelection, before any label write) and EVERY path converges through the same
 *  `reconcilePoolLabels` call — add where the target lacks the label, remove it from any other
 *  open issue that has it. Reconcile is what heals residuals; the event (when it lands) is what
 *  makes reruns replay instead of recompute; neither alone would be. persistPoolSelection is
 *  ATTEMPTED on EVERY path, including the deterministic default — it records what was actually
 *  acted on, not what could be recomputed. That write is best-effort, not fail-closed, today
 *  (see persistPoolSelection's own doc comment): an append failure is logged and reconcile still
 *  runs against the freshly-computed target, so a crash immediately after a failed write forfeits
 *  only the replay optimization on the next rerun (it recomputes, and on the session path pays
 *  for a fresh session), never correctness. Making this write load-bearing is scoped to #232,
 *  not this change. */
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
    persistPoolSelection(deps.state, deps.roundId, candidates, log);
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
      persistPoolSelection(deps.state, deps.roundId, candidates, log);
      target = candidates;
    } else {
      const now = deps.now ?? ((): Date => new Date());
      const role = cfg.roles.po;
      const template = loadRolePromptTemplate(role.poolPromptFile, defaultPoolPromptPath());
      const candidateNumbers = candidates.map((c) => c.number);
      // computePoolCandidates already slices to ceil(roundDispatchCap * poolFactor) — the
      // candidate list's own length IS the effective cap (it can be smaller when Ready itself
      // has fewer eligible issues than the configured bound allows).
      const cap = candidates.length;
      const poolDigest = buildPoolCandidateDigest(candidates, cfg);
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
          version: contentVersion(candidateNumbers.join(",")),
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
      });
      const validated: PoolSelectionValidation =
        result.outcome === "done"
          ? validatePoolSelectionOutput(result.resultText ?? "", candidateNumbers, cap)
          : { ok: false, reason: `po-pool session failed twice (${result.outcome})` };

      // Degrade OPEN (invalid twice / failed twice) -> the full deterministic candidate set,
      // never an empty pool from a session outage. Otherwise the validated selection itself —
      // a proper subset is a real outcome, not a degrade.
      target = validated.ok ? candidates.filter((c) => new Set(validated.selected).has(c.number)) : candidates;
      // #212 gate② r3 (finding 2, documented not fixed — this crash window is INHERENT): the
      // po-pool SESSION above (an external `claude` process, seconds to minutes) and this
      // sqlite write are two separate operations that cannot be made atomic — no lock spans a
      // subprocess boundary. A crash between the session returning and this line means the
      // decision it just made is lost: on rerun, readPersistedPoolSelection finds nothing and
      // this whole branch runs AGAIN, paying for a SECOND (possibly differently-selected)
      // po-pool session. A session-started sentinel (persisted before dispatch, not after)
      // would only trade this for a WORSE failure mode: a crash mid-session would then leave a
      // sentinel claiming "in progress" forever with no result to replay, wedging every future
      // attempt behind a decision that never landed — a wedge risk in exchange for avoiding a
      // rare double-spend. Not worth it. Correctness (as opposed to cost) is preserved
      // regardless: reconcilePoolLabels REPLACES the label state to match the target, it never
      // unions — so even if this exact window fires twice in a row, the FINAL attempt's
      // selection is what the open backlog's labels converge to; a duplicate session only ever
      // costs money, never a wrong pool.
      persistPoolSelection(deps.state, deps.roundId, target, log);
    }
  }

  await reconcilePoolLabels(forge, cfg, target, log, { state: deps.state, roundId: deps.roundId });
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
  now?: () => Date;
  log?: (message: string) => void;
  /** Override for readPlanMd's path — tests inject a fixed string via a temp file. A real
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

      // Compute at align invocation time from the full injected forge backlog. Milestone scope
      // belongs only to the digest; reconciliation/title dedup below must see every open issue.
      // Reuse the same snapshot for triage prompt rendering later in this phase.
      const backlogDigest = await buildBacklogDigest(deps.forge, deps.cfg);
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
      // fresh round (round.milestone unset) — decomposition still has docs/PLAN.md to work from
      // alone. A persisted proposal set bypasses the session entirely on a crash rerun.
      // #104: ported to peripheral.ts's shared runSessionWithRetry (outcome-check -> retry-once
      // -> visible-degradation). Same retry-once stance as plan-review.ts's reviewer sessions;
      // the divergence from plan-review's needs-human escalation is deliberate and cheap here:
      // this phase runs PRE-Ready, so a double failure never poisons a dispatch decision — the
      // round advances (marker still set) and the degradation is made observable (a durable
      // event + a log line) instead of wedging the round; the next round retries naturally. ──
      let persistedProposals = priorProgress.proposals;
      let alignValidated: AlignValidation;
      if (persistedProposals != null) {
        // Crash reruns replay the durable proposal set directly. They never resume an old model
        // session, and they do not pay for a fresh session whose output would be discarded.
        alignValidated = { ok: true, issues: persistedProposals.map(({ title, body }) => ({ title, body })) };
      } else {
        // #231: this is the ONE place a fresh po-align session attempt happens this phase call
        // — the input-manifest attempt number (state-derived, see State.
        // nextInputManifestAttempt's own doc comment) covers every input channel this session
        // dispatch actually consumes, and is provably distinguishable from a prior crash-rerun's
        // attempt at the SAME round/phase/session with zero in-memory bookkeeping.
        const attempt = deps.state.nextInputManifestAttempt(roundId, INPUT_MANIFEST_PHASE, INPUT_MANIFEST_ROLE, "po-align");
        const goalFilePath = deps.planMdPath ?? deps.cfg.goal.file;
        const planRead = readPlanMd(goalFilePath);
        recordInputManifest(
          deps.state,
          {
            round_id: roundId,
            phase: INPUT_MANIFEST_PHASE,
            role: INPUT_MANIFEST_ROLE,
            session: "po-align",
            attempt,
            channel: "goal-file",
            ok: planRead.ok,
            total: 1,
            rendered: planRead.ok ? 1 : 0,
            omitted: planRead.ok ? 0 : 1,
            truncated: false,
            version: planRead.ok ? contentVersion(planRead.content) : null,
            detail: planRead.ok ? null : planRead.reason,
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

        if (!planRead.ok) {
          // #231: an explicit, fail-closed abort of the align-CREATION pass specifically —
          // never a silent "" that lets the session decompose against empty context. No
          // session is spawned (no cost paid for a session working from a false "I read the
          // goal" premise), no creations happen this pass; triage (below, unconditional) never
          // reads this file and is unaffected — the round is never wedged, only this one
          // consuming behavior degrades.
          deps.state.appendEvent("goal-file-unreadable", { round_id: roundId, path: goalFilePath, reason: planRead.reason });
          try {
            deps.state.appendEvent("tick-error", {
              error: `round ${roundId}: goal file unreadable at ${goalFilePath}: ${planRead.reason}`,
            });
          } catch {
            /* the durable goal-file-unreadable event above already recorded this — a tick-error
               write failure here only loses the aggregate count, not the honesty record */
          }
          (deps.log ?? console.error)(
            `[sapwood:po] round ${roundId}: goal file unreadable at ${goalFilePath} — skipping the align-creation ` +
              `session this pass (triage still proceeds): ${planRead.reason}`,
          );
          alignValidated = { ok: false, reason: `goal file unreadable: ${planRead.reason}` };
        } else {
          const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
            "po.mode": "align",
            "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against docs/PLAN.md alone)",
            "plan.md": planRead.content,
            "round.directive": directive,
            "backlog.digest": backlogDigest.text,
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
          alignValidated =
            alignResult.outcome === "done"
              ? validateAlignOutput(alignResult.resultText ?? "")
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
          deps.state.appendEvent("proposal-set-persisted", { round_id: roundId, proposals: persistedProposals });
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
      const terminalIds = priorProgress.terminalIds;
      // This read is deliberately fail-closed (unlike the prompt's best-effort digest): it is
      // the reconciliation and pre-create duplicate boundary, so an incomplete backlog must
      // stop creation rather than turn into duplicates.
      const openIssues = createdIssues.length > 0 ? await deps.forge.listOpenIssues() : [];
      const knownOpenIssues = [...openIssues];
      for (const { proposalId: id, title, body } of createdIssues) {
        if (terminalIds.has(id)) {
          const issue = priorProgress.createdIssues.get(id);
          if (issue !== undefined) alignSummaryCreated.push({ issue, title, hasPlan: extractVerificationPlan(body) != null });
          continue;
        }
        const marker = proposalMarker(id);
        const reconciled = knownOpenIssues.find((issue) => issue.body?.includes(marker));
        if (reconciled) {
          const hasPlan = extractVerificationPlan(body) != null;
          await applyProposalGovernance(reconciled.number, hasPlan);
          deps.state.appendEvent("proposal-created", { round_id: roundId, proposalId: id, issue: reconciled.number, reconciled: true });
          terminalIds.add(id);
          alignSummaryCreated.push({ issue: reconciled.number, title, hasPlan });
          continue;
        }
        const normalizedTitle = normalizeProposalTitle(title);
        const collision = knownOpenIssues.find((issue) => normalizeProposalTitle(issue.title) === normalizedTitle);
        if (collision) {
          deps.state.appendEvent("proposal-skipped", {
            round_id: roundId,
            proposalId: id,
            title,
            reason: "normalized-title-collision",
            existingIssue: collision.number,
          });
          terminalIds.add(id);
          continue;
        }
        const markedBody = `${body}\n\n${marker}`;
        const issueNumber = await deps.forge.createIssue(title, markedBody);
        knownOpenIssues.push({ number: issueNumber, title, labels: [], body: markedBody });
        const hasPlan = extractVerificationPlan(body) != null;
        await applyProposalGovernance(issueNumber, hasPlan);
        // A receipt means both creation AND its load-bearing governance writes completed.
        // A crash before this append is reconciled by the body marker on the next run.
        deps.state.appendEvent("proposal-created", { round_id: roundId, proposalId: id, issue: issueNumber });
        terminalIds.add(id);
        alignSummaryCreated.push({ issue: issueNumber, title, hasPlan });
      }

      async function applyProposalGovernance(issueNumber: number, hasPlan: boolean): Promise<void> {
        // Labels are idempotent and load-bearing. On the rare marker-reconcile path the audit
        // comment may be duplicated; that is accepted in preference to leaving governance
        // incomplete after an accepted-create/lost-receipt crash.
        await deps.forge.addLabel(issueNumber, l.originAgent);
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
        // #231: the triage session's own input-manifest row (channel "issue-body") — the ONE
        // input this mode consumes beyond the fixed template (round.directive/backlog.digest
        // are shared context, already accounted for under po-align's own manifest rows above).
        // `session` is scoped to THIS issue so a crash-rerun's re-triage of the same still-
        // planless issue is its own distinguishable attempt, independent of every other
        // candidate this loop processes.
        recordInputManifest(
          deps.state,
          {
            round_id: roundId,
            phase: INPUT_MANIFEST_PHASE,
            role: INPUT_MANIFEST_ROLE,
            session: `po-triage:${issue.number}`,
            attempt: deps.state.nextInputManifestAttempt(roundId, INPUT_MANIFEST_PHASE, INPUT_MANIFEST_ROLE, `po-triage:${issue.number}`),
            channel: "issue-body",
            ok: true,
            version: contentVersion(issue.body ?? ""),
            total: 1,
            rendered: 1,
            omitted: 0,
            truncated: false,
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
