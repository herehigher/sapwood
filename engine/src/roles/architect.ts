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
// write TARGETS from a pool — verification-plan-reviewer/verification-plan-drafter (PR1) only ever write the ONE issue
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
//
// #213: ADDITIVE to all of the above — a SECOND, independent batch under review in the SAME
// session/prompt/output: this round's ACTUAL pool (#212's cfg.labels.roundPool members — MAY
// OVERLAP with the drift-review `candidates` above since #214 widened pool candidacy to include
// issues still awaiting their first gate⓪ review, see ArchitectDeps.poolIssues's doc comment),
// each getting a per-issue VERDICT (pass/drop/needs-human) instead of a
// contradiction flag. THE POOL-SET INVARIANT mirrors the candidate-set invariant exactly (its own
// authoritative set, its own fail-closed/atomic check in validateArchitectOutput) — a verdict for
// an issue never shown as a pool member is rejected the same way an out-of-candidate-set
// contradiction is. Degrade policy is DELIBERATELY looser than the candidate-set path's: an
// invalid/failed session lets the pool proceed UNFILTERED (never a gate, always advisory) — see
// createArchitectStub's `architect-review-degraded` handling.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import { resolveRoundDirective } from "../config/directive.js";
import { NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge, Issue } from "../forge/forge.js";
import { type PeripheralStub, removeRoundPoolLabel } from "../loop/round.js";
import { capDigest } from "../retro/retro-digest.js";
import type { InputManifestRow, State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import { extractMarkdownSections } from "../util/markdown.js";
import {
  ARCHITECT_ALLOWED_TOOLS,
  envFailureHook,
  ROLE_ALLOWED_TOOLS,
  type RoleRunner,
  type RoleSessionResult,
  runSessionWithRetry,
} from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";

export interface ArchitectDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session (same "fake the collaborator, not the
   *  CLI" split plan-review.ts/conductor.test.ts use). */
  runner: Pick<RoleRunner, "run">;
  now: () => Date;
  log?: (message: string) => void;
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
  /** #213: this round's ROUND-POOL members (#212's cfg.labels.roundPool-labeled issues) — the
   *  batch-review target for the per-issue verdict mechanism (pass/drop/needs-human), a SEPARATE
   *  set from `candidates` below (this stub's own `getIssuesNeedingPlanReview` read, the
   *  pre-existing cross-issue-contradiction target) that MAY OVERLAP with it: since #214 widened
   *  pool candidacy past gate⓪-passed issues alone (Ready lane minus needsHuman/blocked — see
   *  `forge.getPoolEligibleIssues`'s doc), a pool member may still be AWAITING its first gate⓪
   *  review, in which case it legitimately appears in `candidates` too. Nothing here (or in
   *  `validateArchitectOutput` below) assumes disjointness either way — each output kind
   *  (contradiction vs. verdict) is validated against its OWN authoritative set regardless of
   *  whether the flagged/verdicted issue also appears in the other. Threaded the same way
   *  `lastMerged`/`doctrine` are: a real caller
   *  (round-defaults.ts's createDefaultPeripherals) computes this at architect-invocation time
   *  from a LIVE forge read (never cached across a crash-rerun) and assigns it before calling
   *  this stub; a caller that omits it (every direct unit test in this file, and any consumer
   *  that hasn't wired round-defaults.ts) gets an empty pool — same "nothing to batch-review"
   *  shape as a round whose pool genuinely selected zero issues, never a fabricated one. */
  poolIssues?: Issue[];
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
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ — same
  // resolution rationale as worker.ts's defaultPromptPath / plan-review.ts's own default paths.
  return join(here, "..", "..", "prompts", "architect.md");
}

const NO_ALIGNED_GOALS_YET =
  "(No PO/goal-alignment peripheral output is available yet — #89 has not shipped. Proceed " +
  "using only the architecture chapter and this round's candidate issues below.)";

/** #213: the explicit placeholder for an empty round pool (deps.poolIssues omitted, or the round
 *  genuinely selected zero issues into its pool) — never an empty substitution. Same "explicit
 *  placeholder, never blank" convention as NO_ALIGNED_GOALS_YET/NO_PRIOR_ROUND_YET/NO_DOCTRINE. */
export const NO_POOL_MEMBERS = "(This round's pool is empty — there is nothing to batch-review this pass.)";

/** #213: the explicit placeholder for zero drift-review candidates — reachable for the first
 *  time now that the phase runs whenever EITHER `candidates` OR `poolIssues` is non-empty (see
 *  createArchitectStub's early-return), so an all-approved round (every Ready issue already past
 *  gate⓪) can legitimately have zero candidates while still having pool members to batch-review. */
export const NO_CANDIDATES = "(No candidate issues are awaiting gate⓪ review this round.)";

// ── #251: input manifest for the architect's own engine-controlled channels ─────────────────
//
// #231 shipped `input_manifest` keyed on (round, phase, role, session, attempt) but scoped its
// coverage to the channels align.ts itself dispatches a session with (goal-file, backlog-digest,
// issue-body, pool-candidates) — a deliberate scoping ruling (#231 gate② F1), since instrumenting
// architect.ts then would have conflicted with #236's parallel rewrite of this exact file. #236
// has since landed (context-manifest recording, wired at this file's own runSessionWithRetry call
// below), so this follow-up (#251) closes that gap: every engine-controlled input this module
// substitutes into the architect prompt gets its own row, one attempt per session dispatch,
// mirroring align.ts's own `recordInputManifest`/`nextInputManifestAttempt` usage exactly.
//
// Architect dispatches exactly ONE session per phase call (no per-issue looping, unlike align.ts's
// po-triage) — so `role` and `session` are both the fixed string "architect" (matching the
// session's own roleId), and one attempt number covers every channel row below, derived
// immediately before the real dispatch (the #243 F4 rule: this stub's early-return above — zero
// candidates AND zero pool members — means a row is never written for a phase call that never
// reaches a session dispatch at all).
//
// Channels covered — every engine-controlled string substituted into the architect prompt:
// `last-merged` (deps.lastMerged), `aligned-goals` (deps.alignedGoals), `doctrine`
// (deps.doctrine), `directive` (this round's resolved directive), `candidate-issues` (the
// candidates.summary substitution — contradiction-review targets), `architecture-chapter` (the
// goal/architecture content loadArchitectureChapter produces), and `pool-digest` (the
// round.pool substitution — #213's batch-review target; a healthy all-approved round can have
// zero drift-review candidates but a non-empty pool, so this channel matters most for coverage).
//
// TWO HONESTY TIERS, not one blanket `ok: true` (gate② review, PR #258 round 2 — the original
// draft asserted `ok: true`/`truncated: false` uniformly, which was dishonest for the channels
// this module doesn't actually control):
//
//  - `last-merged`/`aligned-goals`/`doctrine`/`directive` are PASS-THROUGH strings: each is either
//    threaded in from ArchitectDeps (round-defaults.ts/doctrine.ts already collapsed a read
//    failure to an explicit placeholder before this module ever sees it — see each field's own
//    ArchitectDeps doc comment) or resolved by resolveRoundDirective (whose own degrade handling
//    is documented at its call site below). This module never reads or caps any of these four
//    itself, so it records `ok: true` (this IS what was substituted into the prompt, honestly)
//    but deliberately OMITS `truncated` rather than asserting `false` — this seam has no way to
//    know whether an upstream cap (e.g. doctrine.ts's own maxChars, or capDigest inside
//    resolveRoundDirective) already truncated the text before it arrived here, and a knowingly-
//    unverifiable `truncated: false` would be exactly the fabricated-success-claim InputManifest-
//    Row's own contract forbids.
//  - `candidate-issues`/`architecture-chapter`/`pool-digest` ARE read/capped by this module
//    itself, so they get the full, honest treatment: `architecture-chapter`'s `ok` reflects
//    loadArchitectureChapter's ACTUAL read outcome (false + `detail` on a missing/unreadable
//    PLAN.md — never a fabricated `version` for a placeholder that stands in for a failed read;
//    a missing "## Architecture" heading in an otherwise-successfully-read file is NOT a read
//    failure and stays `ok: true`, same distinction align.ts's buildBacklogDigest draws between
//    "zero issues" and "read threw"). `candidate-issues` has no cap applied at all here, so
//    `truncated: false` is honestly assertable. `pool-digest` goes through capDigest — a
//    CHARACTER-count cut, unlike align.ts's packDigestRecords (a whole-RECORD pack) — so this
//    module can state a genuine pre/post-cap `truncated` flag and the real pool size as `total`,
//    but cannot honestly claim a record-level `rendered`/`omitted` split capDigest doesn't
//    preserve.
const INPUT_MANIFEST_PHASE = "architecting";
const INPUT_MANIFEST_ROLE = "architect";
const INPUT_MANIFEST_SESSION = "architect";

/** Short, stable content fingerprint (#231's manifest `version` field) — same convention as
 *  align.ts's own contentVersion. */
function contentVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Best-effort input-manifest write (#231/#251): failing to RECORD what a session's input looked
 *  like must never block the session itself — the manifest is a record, not a gate. Mirrors
 *  align.ts's own recordInputManifest exactly. */
function recordInputManifest(state: State, row: InputManifestRow, log?: (message: string) => void): void {
  try {
    state.appendInputManifest(row);
  } catch (e) {
    (log ?? console.error)(
      `[sapwood:architect] round ${row.round_id}: failed to record the input-manifest row (session ${row.session}, channel ${row.channel}): ${String(e)}`,
    );
  }
}

/** Extract PLAN.md's "## Architecture" chapter (case-insensitive heading match) — same
 *  heading-to-next-heading-of-equal-or-shallower-level slicing forge.ts's
 *  extractVerificationPlan uses, generalized to an arbitrary heading pattern. null when no such
 *  heading exists; callers must supply an explicit fallback (never silently substitute the
 *  whole file — a fail-closed stance the caller documents at each call site). */
export function extractArchitectureChapter(planMd: string): string | null {
  return extractMarkdownSections(planMd, /Architecture\b/)[0] ?? null;
}

/** #251 gate② review round 3 (Codex delta-verify F2): ONE read, consumed by BOTH the prompt
 *  substitution (`loadArchitectureChapter` below, unchanged public signature) and the
 *  architecture-chapter input-manifest row — a duplicated existsSync/readFileSync check (this
 *  module's round-2 draft) could disagree with the real read under concurrent file replacement
 *  (a TOCTOU window: the file could be renamed/deleted between the two independent checks), and
 *  "the two can never disagree" was accordingly a false claim. `ok`/`detail` reflect the ACTUAL
 *  read outcome from this single pass (`false` + a reason only for ENOENT/an unreadable file —
 *  never for a missing "## Architecture" heading in an otherwise-successfully-read file, which
 *  is a content-shape issue, not a read failure). */
function loadArchitectureChapterWithStatus(path: string): { chapter: string; ok: boolean; detail: string | null } {
  if (!existsSync(path)) {
    return {
      chapter: `(PLAN.md not found at ${path} — proceeding with no architecture chapter available.)`,
      ok: false,
      detail: `PLAN.md not found at ${path}`,
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return {
      chapter: `(PLAN.md at ${path} could not be read: ${String(e)} — proceeding with no architecture chapter available.)`,
      ok: false,
      detail: `PLAN.md at ${path} could not be read: ${String(e)}`,
    };
  }
  const chapter = extractArchitectureChapter(text);
  return {
    chapter: chapter ?? `(No "## Architecture" heading found in ${path} — proceeding with no architecture chapter available.)`,
    ok: true,
    detail: null,
  };
}

/** Load + extract the architecture chapter from disk. Missing/unreadable file or missing
 *  heading both degrade to an explicit placeholder string (never a throw, never a silent
 *  substitution of the raw file) — architecture review is advisory, so a docs read failure
 *  must not abort the round; the placeholder makes the degradation visible to anyone reading
 *  the architect's rendered prompt/transcript. Public signature UNCHANGED (delegates to
 *  loadArchitectureChapterWithStatus above) — several existing call sites/tests already depend
 *  on this returning a plain string. */
export function loadArchitectureChapter(path: string): string {
  return loadArchitectureChapterWithStatus(path).chapter;
}

/** One candidate issue's block in the substituted prompt: number, title, labels, full body —
 *  the same information density the verification-plan-reviewer prompt gives a single issue, repeated per
 *  candidate here since the architect judges the whole batch at once.
 *
 *  Exported so `align.ts`'s `buildPoolCandidateDigest` can reuse this EXACT shape for the
 *  po-pool digest — the architect phase already substitutes every round-pool member's full
 *  body one phase later at this exact rendering, so po-pool's own digest substitutes the same
 *  shape instead of a title-only line. One renderer, no second one invented for the same
 *  information. */
export function formatCandidate(issue: Issue): string {
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
    throw new Error(`architect prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`);
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

const ArchitectContradictionSchema = z
  .object({
    issue: z.number().int().positive(),
    severe: z.boolean(),
  })
  .strict();

// #213: the per-pool-member verdict entry — deliberately carries NO label field (the issue's
// own "label-removal containment" acceptance criterion, mirroring #212: label choice is
// engine-side, unreachable from ANY session output). "pass" is never listed here at all — an
// unlisted pool member IS a pass, the same "silence means no flag" convention `contradictions`
// already uses for un-flagged candidates.
const ArchitectVerdictSchema = z
  .object({
    issue: z.number().int().positive(),
    verdict: z.enum(["drop", "needs-human"]),
  })
  .strict();

const ArchitectMetadataSchema = z
  .object({
    contradictions: z.array(ArchitectContradictionSchema),
    verdicts: z.array(ArchitectVerdictSchema),
  })
  .strict();

// #213: a SECOND own-line sub-delimiter, alongside CONTRADICTION — same BODY block, same
// containment doctrine, distinguished by kind so a contradiction explanation and a verdict
// reason can never be mixed up even if the SAME issue number happens to appear in both arrays
// (routine since #214: an unapproved pool member still awaiting gate⓪ IS a candidate too —
// nothing here assumes candidates/pool are disjoint, by design).
const MARKER_RE = /^<<<(CONTRADICTION|VERDICT) #(\d+)>>>[ \t]*$/gm;
const CONTRADICTION_MARKER_SUBSTRING = "<<<CONTRADICTION";
const VERDICT_MARKER_SUBSTRING = "<<<VERDICT";

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
interface ParsedArchitectBody {
  designNote: string;
  /** `<<<CONTRADICTION #N>>>` sections, keyed by issue. */
  contradictionSections: Map<number, string>;
  /** #213: `<<<VERDICT #N>>>` sections, keyed by issue — a SEPARATE map, so a duplicate check
   *  against one kind never collides with a legitimate section of the other kind for the same
   *  issue number. */
  verdictSections: Map<number, string>;
}

function parseArchitectBody(body: string): ParsedArchitectBody | null {
  const markers: Array<{ kind: "CONTRADICTION" | "VERDICT"; issue: number; index: number; end: number }> = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec iteration retains each match for its offsets.
  while ((m = MARKER_RE.exec(body)) !== null) {
    markers.push({ kind: m[1] as "CONTRADICTION" | "VERDICT", issue: Number(m[2]), index: m.index, end: m.index + m[0].length });
  }
  const designNote = (markers.length > 0 ? body.slice(0, markers[0]!.index) : body).trim();
  if (designNote === "") return null; // the design note is required every pass — see module doc
  const contradictionSections = new Map<number, string>();
  const verdictSections = new Map<number, string>();
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const sectionEnd = i + 1 < markers.length ? markers[i + 1]!.index : body.length;
    const text = body.slice(marker.end, sectionEnd).trim();
    if (text === "") return null; // a flagged issue with no explanation/reason text — malformed
    const sections = marker.kind === "CONTRADICTION" ? contradictionSections : verdictSections;
    if (sections.has(marker.issue)) return null; // duplicate marker (same kind, same issue) — ambiguous
    sections.set(marker.issue, text);
  }
  // Sub-delimiter containment (Codex round 1, P2 — see the doc comment above), extended to BOTH
  // marker kinds (#213): any REMAINING occurrence of either marker substring after the split
  // consumed every own-line marker is an inline/quoted mention — ambiguous by construction, fail
  // closed.
  const allText = [designNote, ...contradictionSections.values(), ...verdictSections.values()];
  if (allText.some((t) => t.includes(CONTRADICTION_MARKER_SUBSTRING) || t.includes(VERDICT_MARKER_SUBSTRING))) {
    return null;
  }
  return { designNote, contradictionSections, verdictSections };
}

export interface ArchitectContradiction {
  issue: number;
  severe: boolean;
  explanation: string;
}

/** #213: one pool member's batch-review outcome. Only `"drop"`/`"needs-human"` ever appear here
 *  — a "pass" is the absence of an entry (see the metadata schema's own doc comment). No label
 *  field: which label the engine applies for each `verdict` kind is a fixed, session-unreachable
 *  mapping in createArchitectStub (the containment acceptance criterion). */
export interface ArchitectVerdict {
  issue: number;
  verdict: "drop" | "needs-human";
  reason: string;
}

export type ArchitectValidation =
  | { ok: true; designNote: string; contradictions: ArchitectContradiction[]; verdicts: ArchitectVerdict[] }
  | { ok: false; reason: string };

/** Parse + schema-validate + candidate-set-validate an architect session's structured output.
 *  `candidateNumbers` is the round's candidate pool — the EXACT set the session's prompt showed
 *  it (issue #110's Design section: "the engine must validate every flagged issue number against
 *  the round's candidate set... FAIL-CLOSED: any number outside the set invalidates the whole
 *  output"). `poolNumbers` is #213's ANALOGOUS authoritative set for `verdicts` — this round's
 *  ACTUAL pool membership, independent of `candidateNumbers` (the two sets MAY OVERLAP since
 *  #214 — see ArchitectDeps.poolIssues's doc comment — but each metadata array is validated
 *  against its OWN set regardless, so overlap changes nothing here). This function is the single
 *  point that enforces BOTH
 *  invariants: it runs every check to completion and returns ok:false the moment any one fails,
 *  so a caller NEVER sees a partial `ok: true` result to selectively apply —
 *  createArchitectStub only ever writes anything (contradictions OR verdicts) after this returns
 *  ok:true for the WHOLE output, atomically. */
export function validateArchitectOutput(
  text: string,
  candidateNumbers: ReadonlySet<number>,
  poolNumbers: ReadonlySet<number>,
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
    return { ok: false, reason: "BODY block is malformed — empty design note, an empty/duplicate/unmatched section" };
  }
  const metaIssues = new Set(parsed.data.contradictions.map((c) => c.issue));
  // Codex round 1, P1: duplicate metadata entries for the same issue would otherwise fail OPEN —
  // both sides collapse to Sets (sizes match against one body section), and the write loop would
  // then apply the SAME issue twice, with conflicting `severe` values. Reject the duplication
  // itself, before any set comparison can mask it.
  if (metaIssues.size !== parsed.data.contradictions.length) {
    return { ok: false, reason: "duplicate issue in metadata contradictions" };
  }
  const bodyIssues = new Set(parsedBody.contradictionSections.keys());
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

  // #213: THE POOL-SET INVARIANT — same shape as the candidate-set invariant above, applied to
  // `verdicts` against `poolNumbers` instead of `candidates` against `candidateNumbers`. A
  // session verdict for an issue that was never actually shown as a pool member is exactly the
  // same class of untrusted-output hazard the candidate-set invariant already guards against.
  const metaVerdictIssues = new Set(parsed.data.verdicts.map((v) => v.issue));
  if (metaVerdictIssues.size !== parsed.data.verdicts.length) {
    return { ok: false, reason: "duplicate issue in metadata verdicts" };
  }
  const verdictBodyIssues = new Set(parsedBody.verdictSections.keys());
  if (metaVerdictIssues.size !== verdictBodyIssues.size || [...metaVerdictIssues].some((n) => !verdictBodyIssues.has(n))) {
    return { ok: false, reason: "structured output metadata verdicts don't match the BODY block's sections" };
  }
  const outOfPool = parsed.data.verdicts.filter((v) => !poolNumbers.has(v.issue));
  if (outOfPool.length > 0) {
    return {
      ok: false,
      reason: `verdict issue number(s) outside this round's pool: ${outOfPool.map((v) => `#${v.issue}`).join(", ")}`,
    };
  }

  const contradictions: ArchitectContradiction[] = parsed.data.contradictions.map((c) => ({
    issue: c.issue,
    severe: c.severe,
    explanation: parsedBody.contradictionSections.get(c.issue)!,
  }));
  const verdicts: ArchitectVerdict[] = parsed.data.verdicts.map((v) => ({
    issue: v.issue,
    verdict: v.verdict,
    reason: parsedBody.verdictSections.get(v.issue)!,
  }));
  return { ok: true, designNote: parsedBody.designNote, contradictions, verdicts };
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The reason string attached to the `architect-degraded` / `architect-review-degraded` events
 *  (and their stderr lines) when a session degrades (runSessionWithRetry's SECOND attempt still
 *  isn't usable) — a session-level failure (crashed/timed out) is distinguished from a session
 *  that exited clean but produced output that never validated, same split plan-review.ts's
 *  reviewerDegradeReason makes. Shared by BOTH degrade events (#213: architect-review-degraded is
 *  a DISTINCT event from architect-degraded, but the same underlying attempt/validation produces
 *  both, so the reason text is computed once, here, and reused). */
function architectDegradeReason(
  result: RoleSessionResult,
  candidateNumbers: ReadonlySet<number>,
  poolNumbers: ReadonlySet<number>,
): string {
  if (result.outcome !== "done") return `architect session failed twice (${result.outcome})`;
  const v = validateArchitectOutput(result.resultText ?? "", candidateNumbers, poolNumbers);
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
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
      // The candidate pool for this phase is the same "still awaiting gate⓪" set plan_review
      // consumes next in the sequence (aligning -> architecting -> plan_review -> executing):
      // Ready-lane, OPEN, not yet settled needs-human/blocked/verifyNa/planApproved. Sorted by
      // number for a DETERMINISTIC round-design-note anchor (see below) — getIssuesNeedingPlanReview
      // makes no ordering guarantee of its own.
      const candidates = [...(await deps.forge.getIssuesNeedingPlanReview())].sort((a, b) => a.number - b.number);
      // #213: this round's ACTUAL pool (cfg.labels.roundPool members) — a SEPARATE set from
      // `candidates` above that MAY OVERLAP with it since #214 (see ArchitectDeps.poolIssues's
      // doc comment). Threaded by round-defaults.ts, computed at invocation time from a live forge
      // read; an omitted/empty deps.poolIssues means "nothing to batch-review", never a fabricated
      // pool. Sorted for the same determinism reason as `candidates`.
      const poolIssues = [...(deps.poolIssues ?? [])].sort((a, b) => a.number - b.number);
      // #213: run the session whenever there is EITHER a drift-review candidate OR a pool member
      // to batch-review — the pre-#213 short-circuit only checked `candidates`, which would have
      // silently skipped the ENTIRE pool-verdict feature on any round where every Ready issue was
      // already gate⓪-approved (candidates empty, pool non-empty is a common case in a healthy
      // pipeline — though since #214 an unapproved pool member appears in BOTH arrays, so this is
      // no longer the only way `candidates` ends up empty while `poolIssues` doesn't).
      if (candidates.length === 0 && poolIssues.length === 0) return { marker: architectMarker(roundId) };

      const template = loadRolePromptTemplate(deps.cfg.roles.architect.promptFile, defaultArchitectPromptPath());
      // #128: deps.planMdPath is a TEST override only now — a real caller omits it and gets
      // cfg.goal.file (config-file-relative resolved, default "docs/PLAN.md"; was a hardcoded
      // <cwd>/docs/PLAN.md, then roles.architect.planMdPath (#104), which broke for any target
      // repo keeping its architecture doc elsewhere).
      const architecturePath = deps.planMdPath ?? deps.cfg.goal.file;
      // #251 gate② review round 3 (F2): ONE read (loadArchitectureChapterWithStatus, above),
      // consumed by both the prompt substitution and the architecture-chapter manifest row below
      // — a round-2 draft duplicated existsSync/readFileSync in two places, which could disagree
      // under concurrent file replacement (TOCTOU); a single read can't disagree with itself.
      const {
        chapter: architectureChapter,
        ok: architectureChapterOk,
        detail: architectureChapterDetail,
      } = loadArchitectureChapterWithStatus(architecturePath);
      // The round design note needs SOME issue to live on (GitHub has no round/project-level
      // comment surface this role can write to — its writes are issue comment/label edit only);
      // the lowest-numbered candidate is an arbitrary but deterministic, reproducible anchor —
      // chosen and applied by the ENGINE, never the session (the session has no gh grant to act
      // on a choice of its own here anyway). #213: with zero candidates (every Ready issue already
      // gate⓪-approved) the lowest-numbered POOL member is the fallback anchor instead — the
      // early-return above guarantees at least one of the two is non-empty, so this is never
      // undefined. (#214: `candidates` and `poolIssues` may overlap, but "zero candidates" is
      // still a real, reachable case — an all-approved round — so this fallback still matters.)
      const anchor = candidates[0] ?? poolIssues[0]!;
      const marker_ = architectMarker(roundId);
      // THE CANDIDATE-SET INVARIANT's authoritative set: exactly what this round's prompt showed
      // the session, nothing else — see validateArchitectOutput's module doc.
      const candidateNumbers = new Set(candidates.map((c) => c.number));
      // #213: THE POOL-SET INVARIANT's authoritative set — the ANALOGOUS "exactly what the
      // prompt showed as pool members" set, for verdicts.
      const poolNumbers = new Set(poolIssues.map((i) => i.number));
      // #251: pool-digest is a CHARACTER-count cut (capDigest), unlike align.ts's
      // packDigestRecords (a whole-RECORD pack) — the pre-cap joined text is kept in its own
      // variable so the manifest row below can honestly compare pre/post-cap length, rather than
      // guessing at a record-level truncated flag capDigest doesn't preserve.
      const poolIssuesJoined = poolIssues.length === 0 ? "" : poolIssues.map(formatCandidate).join("\n\n---\n\n");
      const poolDigest =
        poolIssues.length === 0 ? NO_POOL_MEMBERS : capDigest(poolIssuesJoined, deps.cfg.roles.architect.poolDigestMaxChars);
      const poolDigestTruncated = poolIssues.length > 0 && poolIssuesJoined.length > deps.cfg.roles.architect.poolDigestMaxChars;
      const lastMergedText = deps.lastMerged ?? NO_PRIOR_ROUND_YET;
      const alignedGoalsText = deps.alignedGoals ?? NO_ALIGNED_GOALS_YET;
      const doctrineText = deps.doctrine ?? NO_DOCTRINE;
      const candidatesSummaryText = candidates.length === 0 ? NO_CANDIDATES : candidates.map(formatCandidate).join("\n\n---\n\n");

      const prompt = renderArchitectPrompt(template, {
        "round.id": String(roundId),
        "round.marker": marker_,
        "round.designNoteIssue": String(anchor.number),
        "round.alignedGoals": alignedGoalsText,
        "round.lastMerged": lastMergedText,
        "round.doctrine": doctrineText,
        "plan.architectureChapter": architectureChapter,
        "candidates.summary": candidatesSummaryText,
        "round.pool": poolDigest,
        "labels.blocked": deps.cfg.labels.blocked,
        "labels.needsHuman": deps.cfg.labels.needsHuman,
        "round.directive": directive,
      });

      // #251: this session dispatch's input-manifest rows — ONE attempt number, derived
      // immediately before the real dispatch, shared across every engine-controlled channel this
      // prompt substitutes (see this file's own #251 module doc, above NO_CANDIDATES). Reached
      // only when this phase call intends to dispatch a session (the early-return above already
      // ruled out the zero-candidates-and-zero-pool case) — a crash strictly between this write
      // and the session actually running is possible and benign, the SAME accepted pre-dispatch
      // window align.ts's own input-manifest writes carry (a record-only table, never a gate; see
      // align.ts's own module doc for this exact tradeoff).
      const architectAttempt = deps.state.nextInputManifestAttempt(
        roundId,
        INPUT_MANIFEST_PHASE,
        INPUT_MANIFEST_ROLE,
        INPUT_MANIFEST_SESSION,
      );
      const architectManifestBase = {
        round_id: roundId,
        phase: INPUT_MANIFEST_PHASE,
        role: INPUT_MANIFEST_ROLE,
        session: INPUT_MANIFEST_SESSION,
        attempt: architectAttempt,
      };
      // Tier 1 — pass-through strings (see this file's own #251 module doc): `ok: true` (this IS
      // what was substituted), `total`/`rendered`/`omitted` describe THIS channel's own
      // single-blob granularity (never a claim about upstream record-packing), and `truncated` is
      // deliberately OMITTED — this module performs no capping of its own on any of these four.
      for (const [channel, text] of [
        ["last-merged", lastMergedText],
        ["aligned-goals", alignedGoalsText],
        ["doctrine", doctrineText],
        ["directive", directive],
      ] as const) {
        recordInputManifest(
          deps.state,
          { ...architectManifestBase, channel, ok: true, version: contentVersion(text), total: 1, rendered: 1, omitted: 0 },
          deps.log,
        );
      }
      // Tier 2 — channels this module itself reads/caps, given the full honest treatment.
      recordInputManifest(
        deps.state,
        {
          ...architectManifestBase,
          channel: "candidate-issues",
          ok: true,
          version: contentVersion(candidatesSummaryText),
          total: candidates.length,
          rendered: candidates.length,
          omitted: 0,
          truncated: false, // no cap applied to candidates.summary
        },
        deps.log,
      );
      recordInputManifest(
        deps.state,
        {
          ...architectManifestBase,
          channel: "architecture-chapter",
          ok: architectureChapterOk,
          // No fabricated version for a placeholder standing in for a failed read (InputManifest-
          // Row's own contract: version is "absent when there's nothing meaningful to hash").
          version: architectureChapterOk ? contentVersion(architectureChapter) : null,
          detail: architectureChapterOk ? null : architectureChapterDetail,
          total: 1,
          rendered: architectureChapterOk ? 1 : 0,
          omitted: architectureChapterOk ? 0 : 1,
          truncated: false, // loadArchitectureChapter extracts a heading section; it never caps by length
        },
        deps.log,
      );
      recordInputManifest(
        deps.state,
        {
          ...architectManifestBase,
          channel: "pool-digest",
          ok: true,
          version: contentVersion(poolDigest),
          total: poolIssues.length,
          // Record-level rendered/omitted are unknowable once capDigest has actually cut the
          // text (a character cut, not a per-issue drop) — left unset rather than guessed; when
          // nothing was cut, every pool issue is trivially known to be fully rendered.
          ...(poolDigestTruncated ? {} : { rendered: poolIssues.length, omitted: 0 }),
          truncated: poolDigestTruncated,
        },
        deps.log,
      );

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
        session: {
          roleId: "architect",
          prompt,
          model: role.model,
          effort: role.effort,
          fallbackModel: role.fallbackModel,
          // #410: WebSearch/WebFetch grant, default on — see PO_ALIGN_ALLOWED_TOOLS' own doc
          // (peripheral.ts) for why cfg.webAccess.enabled is read HERE, at the call site.
          allowedTools: deps.cfg.webAccess.enabled ? ARCHITECT_ALLOWED_TOOLS : ROLE_ALLOWED_TOOLS,
        },
        issue: 0, // round-scoped, not tied to any single issue (spend_ledger's documented sentinel)
        now: deps.now,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        // #236: record this phase's ambient-context manifest for EVERY attempt — same round-level
        // shape as `issue: 0` above. See peripheral.ts's RetriedSession.contextManifest doc for
        // the (round, phase, role, session, attempt) key this writes under.
        contextManifest: { roundId, phase: "architecting", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
        degradeEvent: "architect-degraded",
        degradePayload: (r) => ({
          round_id: roundId,
          outcome: r.outcome,
          session: r.name,
          reason: architectDegradeReason(r, candidateNumbers, poolNumbers),
        }),
        degradeMessage: (r) =>
          `[sapwood:architect] round ${roundId}: ${architectDegradeReason(r, candidateNumbers, poolNumbers)} — ` +
          `proceeding WITHOUT a round design note (advisory phase, round not wedged)`,
        isValid: (r) => validateArchitectOutput(r.resultText ?? "", candidateNumbers, poolNumbers).ok,
        // #374: quota/429 parks instead of degrading — see peripheral.ts's envFailureHook doc.
        envFailure: envFailureHook(deps.cfg, deps.state),
      });

      // The final attempt's own validity decides whether anything is written — NOT just whether
      // runSessionWithRetry degraded (it only degrades on a SECOND invalid/failed attempt; a
      // first-attempt success must still be validated and applied here). When the last attempt
      // never validates, runSessionWithRetry has already durably recorded the degradation above
      // (on its second attempt) — there is nothing further for this phase to do; it proceeds
      // with no note, the same advisory-degrade outcome an outright session failure produces.
      const validated = result.outcome === "done" ? validateArchitectOutput(result.resultText ?? "", candidateNumbers, poolNumbers) : null;
      if (validated?.ok) {
        // Writes are applied ATOMICALLY only after the WHOLE output validated — see
        // validateArchitectOutput's module doc: a run with one valid and one out-of-set flag
        // never reaches here at all (validated.ok is false for the ENTIRE output in that case).
        await deps.forge.addIssueComment(anchor.number, `${validated.designNote}\n\n${marker_}`);
        for (const c of validated.contradictions) {
          await deps.forge.addIssueComment(c.issue, c.explanation);
          if (c.severe) await deps.forge.addLabel(c.issue, deps.cfg.labels.blocked);
        }
        // #213: apply pool verdicts. `pass` is implicit (unlisted -> zero writes, per the
        // metadata schema's own doc comment) — this loop only ever sees `drop`/`needs-human`.
        //
        // Per-verdict write ORDER (Codex review round 2, P1 — reordered from an earlier
        // receipt-first draft): (1) the LABEL write (removeRoundPoolLabel / addLabel), (2) the
        // `architect-verdict-applied` receipt, (3) the reason comment. This ordering is load-
        // bearing, not cosmetic:
        //   - The label write is the ACTUAL governance effect (a dropped issue leaving the pool;
        //     a needs-human hold landing) and is naturally IDEMPOTENT — GitHub no-ops a repeat
        //     add/remove — so it is always safe to retry on a crash-rerun. It must therefore
        //     happen BEFORE the receipt: a receipt recorded first (the earlier draft's order)
        //     would let a crash between the receipt and the label write PERMANENTLY lose the
        //     label effect — the rerun sees the receipt and skips the issue outright, so a
        //     "dropped" issue silently stays pooled and gets dispatched anyway, or a
        //     "needs-human" hold never lands. That failure mode is worse than the one this
        //     receipt exists to prevent.
        //   - The receipt now attests "the label effect has landed" — recorded immediately after
        //     the label write succeeds, before the comment.
        //   - The comment is the ONLY genuinely non-idempotent write here (a repeat post creates
        //     a SECOND comment) and is placed last, still guarded by the same receipt: a rerun
        //     that finds the receipt skips straight past this issue, so the comment is never
        //     reposted.
        // Crash-window accounting under this order: before/at the label write -> no receipt was
        // recorded -> a rerun redoes the whole verdict from scratch (the label write is
        // idempotent, so this is harmless, and the comment could not have landed yet either).
        // After the receipt but before the comment -> the reason comment is lost for that pass
        // (bounded, cosmetic — the load-bearing label effect already landed) — an accepted
        // trade-off, same "never a duplicate, accept a bounded miss" philosophy #232's own
        // receipts document elsewhere in this codebase.
        const alreadyApplied = new Set(
          deps.state
            .eventsAfterId(0, ["architect-verdict-applied"])
            .filter((e) => (e.payload as { round_id?: unknown }).round_id === roundId)
            .map((e) => (e.payload as { issue: number }).issue),
        );
        for (const v of validated.verdicts) {
          if (alreadyApplied.has(v.issue)) continue; // already applied this round — crash-rerun replay
          // Failure containment (#232-pattern, unchanged in spirit from the receipt reorder
          // above): a TRANSIENT forge failure here (not a crash — a real thrown error, e.g. one
          // flaky removeLabel call) must never propagate — an uncaught throw would abort every
          // REMAINING verdict in this loop and throw the whole advisory phase. Contained
          // per-issue, mirroring align.ts's persistTriageDecision: on failure, record a PAIRED
          // `architect-verdict-lost` honesty event (round_id, issue, verdict, reason) + a log
          // line, then CONTINUE. A transient LABEL-write failure now (post-reorder) leaves NO
          // receipt behind — an IMPROVEMENT over the pre-reorder shape: a future phase rerun this
          // round will retry this exact verdict instead of having it silently swallowed forever.
          try {
            if (v.verdict === "drop") {
              // #147/#212 containment: the ONLY sanctioned way to remove the pool label — fails
              // closed for any other label, so a schema/typo mistake can never reach a different
              // one via this call site.
              await removeRoundPoolLabel(deps.forge, deps.cfg, v.issue, deps.cfg.labels.roundPool);
            } else {
              // needs-human: ADD the label — #147 semantics, only a human ever removes it.
              await deps.forge.addLabel(v.issue, deps.cfg.labels.needsHuman);
            }
            // The load-bearing label effect landed — NOW the receipt attests to it.
            deps.state.appendEvent("architect-verdict-applied", { round_id: roundId, issue: v.issue, verdict: v.verdict });
            await deps.forge.addIssueComment(v.issue, v.reason);
          } catch (e) {
            const reason = String(e);
            (deps.log ?? console.error)(
              `[sapwood:architect] round ${roundId}: verdict application failed for #${v.issue} (${v.verdict}) — ` +
                `LOST this pass: ${reason}`,
            );
            try {
              deps.state.appendEvent("architect-verdict-lost", { round_id: roundId, issue: v.issue, verdict: v.verdict, reason });
            } catch {
              /* best-effort honesty event — the log line above is the fallback record */
            }
          }
        }
      } else if (poolIssues.length > 0) {
        // #213 AC4 — degrade OPEN: an invalid/failed session (after runSessionWithRetry's retry)
        // never filters the pool — every pool member simply proceeds UNFILTERED (no verdict is
        // ever applied without a validated session output), and the skip is made OBSERVABLE via
        // its OWN honesty event, DISTINCT from `architect-degraded` above (that one already fired
        // when this was a second-attempt session failure; this one specifically records "pool
        // filtering was skipped", independent of whether the underlying cause was a session
        // failure or an invalid-output validation failure — including a first-attempt success
        // that still failed to validate, a case runSessionWithRetry's OWN degrade hook never
        // sees). Gated on a non-empty pool: with nothing to batch-review, "filtering was skipped"
        // would be a vacuous, valueless event.
        const reason = architectDegradeReason(result, candidateNumbers, poolNumbers);
        deps.state.appendEvent("architect-review-degraded", { round_id: roundId, reason });
        (deps.log ?? console.error)(
          `[sapwood:architect] round ${roundId}: pool review degraded — this round's pool proceeds UNFILTERED ` +
            `(advisory, never blocks dispatch): ${reason}`,
        );
      }

      // #394 (F23): a session genuinely ran above (the early "no candidates and no pool
      // members" return at the top of this function is the ONLY skip path) — see
      // PeripheralStub.ranSession's own doc for why this matters (round.ts's empty-spin breaker).
      return { marker: marker_, ranSession: true };
    },
  };
}
