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
import { capDigest } from "../retro/retro-digest.js";
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "../roles/plan-review.js";
import type { State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import { issuePriority } from "./conductor.js";
import type { PeripheralStub } from "./round.js";

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

/** Engine-side PO context (#215): deterministic, milestone-scoped here at the digest consumer,
 *  and contained on forge failure. Sorting here (rather than trusting gh's presentation order)
 *  makes crash-rerun assembly byte-identical for the same backlog. Every return path is capped
 *  at the boundary so placeholders cannot accidentally bypass the configured size limit. */
export async function buildBacklogDigest(forge: IForge, cfg: SapwoodConfig): Promise<string> {
  let uncapped: string;
  try {
    const allIssues = await forge.listOpenIssues();
    const issues = filterIssuesByMilestone(allIssues, cfg.round.milestone);
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

function filterIssuesByMilestone(issues: Issue[], milestone: string | undefined): Issue[] {
  return milestone === undefined ? issues : issues.filter((issue) => issue.milestone === milestone);
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

// ── #212: round-pool selection ──────────────────────────────────────────────────────────────
//
// The architecture note ("the PO explicitly selects a round pool") is a real session, not just
// a bound: with roles.po.enabled, the engine computes the CANDIDATE set deterministically (Ready,
// milestone-scoped by whatever `forge` already applies — see AlignDeps.forge — ordered
// prio:0-first then issue-number-ascending, capped at ceil(lanes.roundDispatchCap *
// round.poolFactor)) and hands it to a dedicated PO session (runPoolSelection below) whose ONLY
// deliverable is which of those candidate NUMBERS belong in this round's pool — the engine then
// applies cfg.labels.roundPool to exactly that selection, from validated structured output,
// never from anything the session could name directly (no label field exists in the schema:
// the removeLabel/addLabel containment invariant holds structurally, the same "engine performs
// every write itself" stance as align/triage above). Invalid-twice or a failed session degrades
// OPEN to the full deterministic candidate set (selectRoundPool below) — never an empty pool,
// never a wedged round. roles.po.enabled=false skips the session entirely and IS that same
// deterministic path (#212 AC7: "the selection bound must not depend on an optional role") —
// round-defaults.ts calls runPoolSelection unconditionally every round regardless of the PO
// role's enabled state; only whether it *pays for a session* differs.
export interface PoolSelectionDeps {
  forge: IForge;
  cfg: SapwoodConfig;
  log?: (message: string) => void;
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

/** The deterministic, no-session pool selection: the FULL candidate set (computePoolCandidates),
 *  labelled unconditionally. This is (1) roles.po.enabled=false's documented AC7 fallback, and
 *  (2) the degrade-OPEN target when the PO's selection session is invalid twice or fails twice
 *  (runPoolSelection below) — "no LLM judgment available" always degrades to "take the whole
 *  bound," never to an empty pool. A forge read failure degrades to "pool left as whatever it
 *  already was" (logged, never thrown) — the executing phase simply dispatches into whatever
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
  await applyPoolLabels(forge, cfg, candidates, deps.log);
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
 *  most deployments tune). */
function buildPoolCandidateDigest(candidates: readonly Issue[], cfg: SapwoodConfig): string {
  const uncapped =
    candidates.length === 0
      ? "(no Ready candidates this round)"
      : candidates.map((issue) => `- #${issue.number} — ${issue.title}`).join("\n");
  return capDigest(uncapped, cfg.roles.po.backlogDigestMaxChars);
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
 *  the AC7 rationale). roles.po.enabled=false, or zero Ready candidates, never dispatches a
 *  session: the former is the documented deterministic fallback, the latter is simply nothing
 *  to choose from (no point paying for a session over an empty list). Otherwise: build the
 *  candidate digest, run the po-pool session (same runner machinery + zero-gh-grant tool scope
 *  as align/triage: PO_ALLOWED_TOOLS/PO_DISALLOWED_TOOLS, runSessionWithRetry's retry-once-then-
 *  degrade), validate its output against the candidate bound, and apply labels to exactly the
 *  validated selection. Invalid twice / failed twice degrades OPEN to the full candidate set
 *  (selectRoundPool's own deterministic path) — a durable `pool-degraded` event + a log line,
 *  never an empty pool from a session outage. */
export async function runPoolSelection(deps: PoolSelectionRunDeps): Promise<Issue[]> {
  const { forge, cfg } = deps;
  if (!cfg.roles.po.enabled) {
    return selectRoundPool({ forge, cfg, ...(deps.log !== undefined ? { log: deps.log } : {}) });
  }
  const log = deps.log ?? console.error;

  // #212 gate② P1-2: "crash recovery = re-read the label" (issue #212's own design line). A
  // crash AFTER the PO session's labels were applied but BEFORE the aligning phase's marker
  // persisted (round.ts's runPeripheral) restarts this whole function from scratch with the
  // marker still null. A FRESH session's selection can differ from the prior attempt's (LLM
  // nondeterminism) — and applyPoolLabels only ADDS, so a second pass would UNION the two
  // selections onto the same issues, breaking the cap and pooling issues the fresh session
  // never actually chose. If ANY open issue already carries the pool label, this IS that exact
  // same-round rerun: adopt it verbatim, no session, no additional labels. Prior-round
  // staleness cannot produce a false positive here — the round-close sweep (round.ts, gate②
  // P1-3) is now exhaustive over the full open backlog, so the label never survives past its
  // own round's close.
  let existing: Issue[];
  try {
    existing = (await forge.listOpenIssues()).filter((i) => labelsInclude(i.labels, cfg.labels.roundPool));
  } catch (e) {
    log(`[sapwood:pool] round ${deps.roundId}: existing-pool read failed — proceeding to a fresh selection: ${String(e)}`);
    existing = [];
  }
  if (existing.length > 0) {
    log(
      `[sapwood:pool] round ${deps.roundId}: adopted existing pool (${existing.length} issue(s) already carry ` +
        `${cfg.labels.roundPool}) — same-round crash-rerun, no new session, no additional labels.`,
    );
    return existing;
  }

  let candidates: Issue[];
  try {
    candidates = await computePoolCandidates(forge, cfg);
  } catch (e) {
    log(`[sapwood:pool] round-pool selection: Ready read failed — pool left unchanged this round: ${String(e)}`);
    return [];
  }
  if (candidates.length === 0) return [];

  const now = deps.now ?? ((): Date => new Date());
  const role = deps.cfg.roles.po;
  const template = loadRolePromptTemplate(role.poolPromptFile, defaultPoolPromptPath());
  const candidateNumbers = candidates.map((c) => c.number);
  // computePoolCandidates already slices to ceil(roundDispatchCap * poolFactor) — the candidate
  // list's own length IS the effective cap (it can be smaller when Ready itself has fewer
  // eligible issues than the configured bound allows).
  const cap = candidates.length;
  const prompt = renderRolePrompt(template, NO_ISSUE, cfg, {
    "pool.digest": buildPoolCandidateDigest(candidates, cfg),
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

  if (!validated.ok) {
    // Degrade OPEN: the full deterministic candidate set, not an empty pool.
    await applyPoolLabels(forge, cfg, candidates, deps.log);
    return candidates;
  }
  const selectedNumbers = new Set(validated.selected);
  const chosen = candidates.filter((c) => selectedNumbers.has(c.number));
  await applyPoolLabels(forge, cfg, chosen, deps.log);
  return chosen;
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
        const alignPrompt = renderRolePrompt(template, NO_ISSUE, deps.cfg, {
          "po.mode": "align",
          "round.milestone": deps.cfg.round.milestone ?? "(none configured for this round — decompose against docs/PLAN.md alone)",
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
      const createdIssues = alignValidated.ok ? (persistedProposals ?? []) : [];
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
