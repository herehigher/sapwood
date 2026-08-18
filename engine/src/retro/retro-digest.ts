// retro-digest.ts — #111 PR-A: the engine-built, round-scoped context digest that replaces
// retro's live adaptive `gh pr view/list/diff` + `gh issue view/list` browsing. Assembled
// DETERMINISTICALLY, engine-side, BEFORE the retro session ever runs — the session reads the
// finished text (substituted into its prompt as `{{round.digest}}`, see retro.ts), it never
// fetches any of this itself. Same "engine builds the context, the session only judges it"
// shape as harvest.ts's/plan-review.ts's own round-fact gathering, just wider: PR description +
// diff + review signals for every PR the round's own event ledger says was touched, plus
// comments/labels for every issue the ledger flagged as escalated, plus the round's commit
// history.
//
// #453 (design #402 R5) adds ONE section that is deliberately NOT round-scoped: the
// finding-class tendency table, which spans the last `roles.retro.tendencyRounds` rounds. See
// its own section header below for why, and for the D5 ruling that keeps the engine tabulating
// and never acting.
//
// Commit history is sourced from `IForge.getCommitsSince` (a GitHub API read via `gh api`),
// deliberately NOT a local `git log` subprocess: worker.test.ts's #69 grep-invariant pins the
// ONLY engine modules ever allowed to shell a subprocess as worker.ts (spawn, the claude CLI)
// and gh.ts (execFile, the `gh` binary) — this module must not (and does not) import
// node:child_process itself. See forge.ts's IForge.getCommitsSince doc for the full rationale.
//
// BOUNDED (issue #111 acceptance criterion): the whole assembled text is capped at
// `roles.retro.digestMaxChars` (a config key, per this repo's user-tunables-in-config
// convention — see docs/configuration.md). Oversize input is truncated DETERMINISTICALLY
// (always the same prefix for the same content+cap) and the truncation is marked in the
// digest text itself — never a silent drop. AUDITABLE: every source read here already has a
// durable engine-side record (the events this module reads FROM, the IForge calls it makes),
// and the digest text itself is exactly what got substituted into the session's prompt — an
// operator can always reconstruct why a given retrospective said what it said.
//
// Individual PR/issue fetch failures are contained per-item (a transient `gh` hiccup on one
// touched PR must not blank out the whole digest, or crash the retro phase) — same
// fail-toward-more-work stance as the rest of this codebase (e.g. conductor.ts's
// `addPRComment(...).catch(() => {})`). A failed item's section says so, in place of its data.
import type { IForge, PRComment, PRReviewData, PRStatus } from "../forge/forge.js";
import { findingKeyPath } from "../review/finding-key.js";
// #964: import ONLY — reviewer.ts is human-merge-only, never edited from here. Reused so this
// module's and retro.ts's own changes-requested checks can never independently drift from
// gate②'s real predicate (see classifyOutstandingPR's own doc for the specific bug this closes).
import { changesRequestedOnHead } from "../roles/reviewer.js";
import { kindsTagged } from "../state/event-kinds/index.js";
import type { RoundRow, State } from "../state/state.js";

/** Durable event kinds whose payload carries a `pr` field (conductor.ts's DRIVE-phase
 *  appendEvent call sites) — the digest's "PRs touched this round" source. Deliberately NOT
 *  the reviewer-fallback announcement events (`reviewer-fallback-*`): those report on the
 *  review-gate MECHANISM, not on a PR's own content, and are already implied by whichever of
 *  the four kinds below the same driveOne tick also appends.
 *
 *  #425: DERIVED from the central registry's `pr-touched` tag — see RETRO_EVENT_KINDS' own note
 *  in retro.ts for why the lists are tag queries now rather than re-spelled strings. */
export const PR_TOUCHED_EVENT_KINDS = kindsTagged("pr-touched");

/** Every PR number touched by the round, sorted ascending, deduped. Pure given `state`'s
 *  current contents — exported so tests can assert on it directly, same convention as
 *  harvest.ts's gatherRoundFacts / retro.ts's gatherRetroFacts. */
export function gatherTouchedPRs(state: State, round: RoundRow): number[] {
  // #403 (F25), PR #430 gate② P2: id cursor, not `started_at` — see gatherRetroFacts's own
  // comment (retro.ts) for why comparing an injected-clock round boundary against a machine-clock
  // event `ts` silently empties the round.
  const events = state.eventsAfterId(round.start_event_id ?? 0, PR_TOUCHED_EVENT_KINDS);
  const prs = new Set<number>();
  for (const e of events) {
    const pr = (e.payload as { pr?: number }).pr;
    if (typeof pr === "number") prs.add(pr);
  }
  return [...prs].sort((a, b) => a - b);
}

/** Every issue number named by any of `kinds`' events since round start, sorted ascending,
 *  deduped — the digest's "escalated issues" source. The caller (retro.ts) passes its OWN
 *  RETRO_EVENT_KINDS list (handoff/drive-needs-human/plan-review-escalated/ceiling-escalated)
 *  rather than this module owning a second copy of that list — retro.ts's own gatherRetroFacts
 *  already names the authoritative set of event kinds retro's "raw material" comes from
 *  (prompts/retro.md: bounced plans, review rejections, budget overruns); duplicating it here
 *  would be two sources of truth for the same list. */
export function gatherDigestIssues(state: State, round: RoundRow, kinds: string[]): number[] {
  // #403 (F25), PR #430 gate② P2: id cursor, not `started_at` — same reason as gatherTouchedPRs.
  const events = state.eventsAfterId(round.start_event_id ?? 0, kinds);
  const issues = new Set<number>();
  for (const e of events) {
    const issue = (e.payload as { issue?: number }).issue;
    if (typeof issue === "number") issues.add(issue);
  }
  return [...issues].sort((a, b) => a - b);
}

// ── #964: "your outstanding PRs" — retro's own PR lifecycle, across ALL history ──────────────
//
// Every OTHER gatherer in this module is scoped to ONE round's start_event_id window; this one
// deliberately is not. A retro proposal PR outlives the round that opened it — a red PR opened
// two rounds ago is still retro's own responsibility to notice and repair THIS round, not just
// the round it was born in. So the source read here walks the WHOLE ledger.

/** #425: DERIVED from the central registry's `retro-pr-lifecycle` tag — see that tag's own note
 *  (event-kinds/types.ts) for why `retro-pr-degraded` is deliberately excluded (it never names a
 *  PR that exists on the forge). */
export const RETRO_PR_LIFECYCLE_EVENT_KINDS = kindsTagged("retro-pr-lifecycle");

/** One PR retro has opened or updated, folded to its LATEST known (branch, head) — `head` is the
 *  headOid the engine recorded at open/update time (#964 adds this field going forward; a
 *  pre-#964 `retro-pr-opened` row simply has none, see `updateProposalPR`'s legacy fallback in
 *  retro.ts). */
export interface RetroPRRecord {
  pr: number;
  branch: string;
  head?: string;
}

// ponytail: last 5 own PRs is the read bound; add a durable terminal event if retro PRs pile up past that
export const RETRO_PR_LIFECYCLE_READ_BOUND = 5;

/** Fold retro's WHOLE PR lifecycle (every `retro-pr-opened`/`retro-pr-updated` event ever
 *  appended) down to one row per PR number, latest event wins, NEWEST-TOUCHED-FIRST, capped at
 *  `RETRO_PR_LIFECYCLE_READ_BOUND` — `eventsAfterId` returns rows in ascending id order; each PR
 *  is re-keyed (delete then set) on every touch so a `Map`'s insertion-order iteration reflects
 *  RECENCY, not first-seen order, and reversing it puts the most recently touched PR first. This
 *  is the read-cost bound for both consumers below (`gatherOutstandingRetroPRs` and retro.ts's
 *  `hasActionableOwnPR`): at most `RETRO_PR_LIFECYCLE_READ_BOUND` `getPRStatus` calls per read,
 *  regardless of how many PRs retro has EVER opened — a MERGED/CLOSED one is simply dropped by
 *  its caller after a live read (unchanged), never specially remembered. A malformed payload
 *  (missing `pr`/`branch`) contributes nothing rather than throwing — same "never fail the whole
 *  digest over one bad row" stance the rest of this module takes. Shared by this module's own
 *  outstanding-PR section AND retro.ts's `update` scratch-outcome verification
 *  (`updateProposalPR`) — ONE fold, not two independently-maintained ones; an `update:` scratch
 *  naming a PR that has aged out of this window degrades the same way as one retro never opened
 *  — a deliberate, documented consequence of the bound, not a bug. */
export function gatherRetroPRLifecycle(state: State): RetroPRRecord[] {
  const events = state.eventsAfterId(0, RETRO_PR_LIFECYCLE_EVENT_KINDS);
  const byPr = new Map<number, RetroPRRecord>();
  for (const e of events) {
    const p = e.payload as { pr?: unknown; branch?: unknown; head?: unknown };
    if (typeof p.pr !== "number" || typeof p.branch !== "string") continue;
    byPr.delete(p.pr); // re-touching an existing PR moves it to the "most recent" end
    byPr.set(p.pr, { pr: p.pr, branch: p.branch, ...(typeof p.head === "string" ? { head: p.head } : {}) });
  }
  return [...byPr.values()].reverse().slice(0, RETRO_PR_LIFECYCLE_READ_BOUND);
}

/** One outstanding PR as the digest renders it. `actionable` names WHY a human (or retro itself,
 *  via the `update` scratch outcome) needs to look — never omitted for an unreadable status: a
 *  forge-read failure renders `reasons: ["status: unknown ..."]` and `actionable: true` (#964
 *  AC1's fail-closed direction — an indeterminate status must never silently drop the row, and
 *  must never read as "this PR is fine"). `excerpt` is present only for a `ciRed` row and is
 *  ALREADY bounded by the forge-side hard cap (`getFailedCheckSummary`'s own `FAILED_CHECK_
 *  SUMMARY_CAP`) before this module's own per-item cap is applied on top (belt and suspenders,
 *  same layering the rest of this module already uses — a section cap on top of a per-item cap
 *  on top of the final whole-digest safety net). */
export interface OutstandingRetroPR {
  pr: number;
  branch: string;
  /** `"unknown"` only when the forge status read itself threw — never a real PR state. */
  state: "OPEN" | "CLOSED" | "MERGED" | "unknown";
  actionable: boolean;
  reasons: string[];
  excerpt?: string;
}

/** The GraphQL-normalized `ciChecks` conclusion strings PRStatus.ciRed/ciChecks already treat as
 *  FAILING (parsePRStatus's own `FAILING` set, forge.ts — not exported, so named again here
 *  rather than reached into; both sets exist to answer the exact same question off the exact
 *  same transport, so keeping them textually identical is a review-time discipline, not a shared
 *  import worth the coupling). */
const CI_CHECK_FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);

/** Classify ONE outstanding PR against the forge's live status — the per-PR body of
 *  `gatherOutstandingRetroPRs`, split out so each reason (red CI, inert CI, conflicting,
 *  changes-requested) is independently testable. Never throws: every forge call it makes is
 *  individually contained, same "one bad item never blanks the whole digest" stance as
 *  `buildRetroDigest`'s per-PR/per-issue loops below. */
async function classifyOutstandingPR(forge: IForge, rec: RetroPRRecord, status: PRStatus): Promise<OutstandingRetroPR> {
  const reasons: string[] = [];
  let excerpt: string | undefined;
  if (status.ciRed) {
    const failing = (status.ciChecks ?? []).filter((c) => CI_CHECK_FAILING_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
    reasons.push(`red CI — failing check(s): ${failing.length > 0 ? failing.join(", ") : "(unnamed)"}`);
    try {
      excerpt = await forge.getFailedCheckSummary(rec.pr);
    } catch (e) {
      excerpt = `(failure excerpt fetch failed: ${String(e)})`;
    }
  }
  if (status.ciInert) {
    const inert = (status.ciChecks ?? [])
      .filter((c) => c.conclusion !== "SUCCESS" && !CI_CHECK_FAILING_CONCLUSIONS.has(c.conclusion))
      .map((c) => c.name);
    reasons.push(`inert CI — check(s) concluded without ever passing: ${inert.length > 0 ? inert.join(", ") : "(unnamed)"}`);
  }
  if (status.mergeable === "CONFLICTING") reasons.push("conflicting with the base branch");
  try {
    const review = await forge.getPRReviewData(rec.pr);
    // #964: NOT "the last review event is CHANGES_REQUESTED" — that ignores per-reviewer
    // STANDING state (a later APPROVE from reviewer B would hide reviewer A's still-open
    // request) and head-pinning (a request left on an OLD head must not read as actionable
    // after a push superseded it). `changesRequestedOnHead` is reviewer.ts's own gate② predicate
    // for exactly this question — reused here (import only; reviewer.ts is human-merge-only)
    // rather than re-derived, so the two callers can never disagree.
    if (changesRequestedOnHead(review.reviews, status.headOid, review.author)) {
      reasons.push("changes requested — a standing CHANGES_REQUESTED review on the current head");
    }
  } catch (e) {
    reasons.push(`review status: unknown — forge read failed (${String(e)})`);
  }
  return {
    pr: rec.pr,
    branch: rec.branch,
    state: status.state,
    actionable: reasons.length > 0,
    reasons,
    ...(excerpt !== undefined ? { excerpt } : {}),
  };
}

/** Every PR retro currently has open on the forge, classified. NOT round-scoped (see this
 *  section's own header comment) — reads `gatherRetroPRLifecycle`'s bounded (at most
 *  `RETRO_PR_LIFECYCLE_READ_BOUND`) fold, then drops anything the forge now reports MERGED/CLOSED
 *  (no longer outstanding at all) and a forge-read failure renders `state: "unknown"`,
 *  `actionable: true` rather than being dropped (#964 AC1: never omit a PR whose status could
 *  not be read). */
export async function gatherOutstandingRetroPRs(forge: IForge, state: State): Promise<OutstandingRetroPR[]> {
  const rows: OutstandingRetroPR[] = [];
  for (const rec of gatherRetroPRLifecycle(state)) {
    let status: PRStatus;
    try {
      status = await forge.getPRStatus(rec.pr);
    } catch (e) {
      rows.push({
        pr: rec.pr,
        branch: rec.branch,
        state: "unknown",
        actionable: true,
        reasons: [`status: unknown — forge read failed (${String(e)})`],
      });
      continue;
    }
    if (status.state === "MERGED" || status.state === "CLOSED") continue;
    rows.push(await classifyOutstandingPR(forge, rec, status));
  }
  return rows;
}

function formatOutstandingPRRow(row: OutstandingRetroPR): string {
  const header = `### PR #${row.pr} (branch: ${row.branch}, state: ${row.state})`;
  if (!row.actionable) return `${header}\nGreen and waiting for a human — no action needed from you.`;
  const reasonsText = row.reasons.map((r) => `- ${r}`).join("\n");
  const excerptText = row.excerpt !== undefined ? `\nFailure excerpt:\n${row.excerpt}` : "";
  return `${header}\nACTIONABLE:\n${reasonsText}${excerptText}`;
}

// ── #453 (design #402 R5, §5): the finding-class tendency table ─────────────────────────────
//
// A finding CLASS that recurs across many PRs is evidence about the DESIGN, not about those PRs
// — this project has lived it (crash-consistency findings recurred across #191/#170/#172 and
// again in the M9 wave until the design was reconsidered at source), and nothing in the engine
// noticed a pattern it raised a dozen times. Retro is the right home and had been asked to do
// this without ever being given the data.
//
// THE ENGINE ONLY TABULATES (design #402 ruling D5). Nothing below turns a class into an issue,
// a threshold, or a verdict — the table is input to retro's own judgment, which reaches the
// backlog only through retro's existing gate②-reviewed PR path. An engine threshold firing at
// `count === 3` would be a backlog spam generator with no adjudication, and would be wrong
// precisely in the interesting cases: recognizing "the same class" requires reading design
// intent, which is exactly why docs/REVIEW-DOCTRINE.md is deliberately prose and not a lint/DSL.
//
// CROSS-ROUND, not just cross-PR. Everything else in this module is bounded by ONE round's
// `start_event_id`; the #191/#170/#172 -> M9-wave shape recurs ACROSS rounds, so this read walks
// back to the `start_event_id` of the earliest round in a `tendencyRounds`-wide window (the
// current round INCLUSIVE — K=1 is "this round only"). Id cursors throughout (#403 F25): the
// round boundary comes from the injected clock and `events.ts` from the machine clock, so any
// timestamp comparison here would silently empty a round.

/** The durable event kind carrying #449's (design #402 R2) per-round finding record — the only
 *  source this table reads. `drive-fixup`'s payload gained `findings: [{key, severity, kind}]`
 *  there; before it, a fix dispatch recorded a gate-reason STRING and no finding identity at
 *  all, which is why this table could not exist until R2 landed. */
export const FINDING_RECORD_EVENT_KINDS = ["drive-fixup"];

/** One `(kind, path-prefix)` class as the digest renders it. `prs`/`rounds` are the recurrence
 *  evidence: a count of 5 on one PR in one round is one noisy review; a count of 5 across four
 *  PRs and three rounds is a statement about the design. */
export interface TendencyRow {
  kind: string;
  pathPrefix: string;
  count: number;
  /** Distinct PR numbers the class was raised on, ascending. */
  prs: number[];
  /** How many DISTINCT rounds in the window raised it. */
  rounds: number;
}

export interface FindingTendency {
  /** Sorted deterministically: count desc, then kind, then prefix — same input always renders
   *  the same table, the digest's standing determinism contract. */
  rows: TendencyRow[];
  /** The rounds actually tabulated — `< tendencyRounds` when the ledger holds fewer (a young
   *  run degrades to what exists rather than erroring). */
  roundsCovered: number;
  firstRoundId: number;
  lastRoundId: number;
}

/** `kind` fallback for a finding record that carried none — mirrors finding-axes.ts's own
 *  "absent -> unclassified" default, so an unlabelled finding still lands in a real row instead
 *  of vanishing from the table. */
const UNCLASSIFIED_KIND = "unclassified";
/** The path-prefix cell for a finding with no diff-anchored location (finding-key.ts's `unloc`
 *  keys). Kept as a VISIBLE row rather than dropped: "many unlocated findings" is itself a
 *  tendency worth seeing, and a silent drop would understate a class's count. */
const UNLOCATED_PREFIX = "(unlocated)";

/** Directory granularity — the unit a design decision actually lives at. A file-level key would
 *  split one recurring class across every file it touched; a repo-level one would merge every
 *  class into a single row. */
function pathPrefixOf(path: string | null): string {
  if (path === null) return UNLOCATED_PREFIX;
  const i = path.lastIndexOf("/");
  return i === -1 ? "(repo root)" : path.slice(0, i + 1);
}

/** Tabulate `(kind, path-prefix)` recurrence across the last `tendencyRounds` rounds, current
 *  round inclusive. Pure given `state`'s contents — exported so tests assert on it directly,
 *  same convention as gatherTouchedPRs/gatherDigestIssues above. Never throws: a malformed or
 *  foreign-shaped payload contributes nothing rather than failing the whole digest. */
export function gatherFindingTendency(state: State, round: RoundRow, tendencyRounds: number): FindingTendency {
  const k = Math.max(1, Math.floor(tendencyRounds));
  // Round boundaries, earliest first. A missing row (a gap in `rounds`, or a window that reaches
  // back before the run began) is simply absent — "fewer rounds than K exist" degrades to what
  // the ledger holds, which is why this is a scan and not `getRound(n - K)` alone.
  const boundaries: { roundId: number; startEventId: number }[] = [];
  for (let id = Math.max(1, round.round_id - k + 1); id < round.round_id; id++) {
    const r = state.getRound(id);
    if (r) boundaries.push({ roundId: r.round_id, startEventId: r.start_event_id ?? 0 });
  }
  boundaries.push({ roundId: round.round_id, startEventId: round.start_event_id ?? 0 });

  const events = state.eventsAfterId(boundaries[0]!.startEventId, FINDING_RECORD_EVENT_KINDS);
  const classes = new Map<string, { kind: string; pathPrefix: string; count: number; prs: Set<number>; rounds: Set<number> }>();
  for (const e of events) {
    const p = e.payload as { pr?: unknown; findings?: unknown };
    if (!Array.isArray(p.findings)) continue;
    // The event's own ledger id places it in a round: the last boundary it sits after. Ids, not
    // timestamps — the same cursor `startRound` stamps the boundary with.
    let roundId = boundaries[0]!.roundId;
    for (const b of boundaries) if (e.id > b.startEventId) roundId = b.roundId;
    for (const f of p.findings as { key?: unknown; kind?: unknown }[]) {
      if (typeof f?.key !== "string") continue;
      const kind = typeof f.kind === "string" ? f.kind : UNCLASSIFIED_KIND;
      const pathPrefix = pathPrefixOf(findingKeyPath(f.key));
      const mapKey = JSON.stringify([kind, pathPrefix]); // same injective-encoding reason as finding-key.ts's own
      const row = classes.get(mapKey) ?? { kind, pathPrefix, count: 0, prs: new Set<number>(), rounds: new Set<number>() };
      row.count += 1;
      if (typeof p.pr === "number") row.prs.add(p.pr);
      row.rounds.add(roundId);
      classes.set(mapKey, row);
    }
  }

  const rows = [...classes.values()]
    .map((r) => ({ kind: r.kind, pathPrefix: r.pathPrefix, count: r.count, prs: [...r.prs].sort((a, b) => a - b), rounds: r.rounds.size }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.pathPrefix.localeCompare(b.pathPrefix));

  return { rows, roundsCovered: boundaries.length, firstRoundId: boundaries[0]!.roundId, lastRoundId: round.round_id };
}

/** Render the tendency section. The heading and the blind-spot note are ALWAYS present, empty
 *  window included (issue #453 AC: a missing section reads as "no data was looked at", which is
 *  a different and much worse claim than "nothing recurred"). */
function formatTendencySection(t: FindingTendency, tendencyRounds: number): string {
  const header = [
    `## Finding-class tendency (last ${t.roundsCovered} round(s): #${t.firstRoundId}-#${t.lastRoundId}; roles.retro.tendencyRounds=${tendencyRounds})`,
    "Engine-tabulated from this run's own durable finding records. It is a TABLE, not a verdict:",
    "a class recurring across PRs and rounds is evidence about the DESIGN, not about those PRs —",
    "judge it, and if it holds, propose at the design source rather than filing another point fix.",
    "Blind spot, stated rather than papered over: a genuine recurring class goes unnoticed if retro",
    "is disabled or judges wrong. The mitigation is that this table is durable and visible, not that",
    "the engine acts on it — no engine path turns a finding or a finding class into an issue.",
  ].join("\n");
  if (t.rows.length === 0) {
    return `${header}\n\n(no finding records in this window — ${t.roundsCovered} round(s) tabulated, zero recorded findings)`;
  }
  const rows = t.rows.map((r) => `| ${r.kind} | ${r.pathPrefix} | ${r.count} | ${r.prs.map((n) => `#${n}`).join(", ")} | ${r.rounds} |`);
  return [
    header,
    "",
    "| kind | path prefix | findings | distinct PRs | distinct rounds |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function formatPRSection(pr: number, body: string, diff: string, review: PRReviewData): string {
  const reviews =
    review.reviews.length > 0
      ? review.reviews.map((r) => `  - ${r.author}: ${r.state} (commit ${r.commitOid.slice(0, 7)})`).join("\n")
      : "  (no reviews)";
  const comments =
    (review.comments ?? []).length > 0
      ? (review.comments ?? []).map((c) => `  - ${c.login} (${c.createdAt}): ${c.body}`).join("\n")
      : "  (no top-level comments)";
  return [
    `### PR #${pr}`,
    `State: ${review.state}${review.isDraft ? " (draft)" : ""} | unresolved review threads: ${review.unresolvedThreads}`,
    "Description:",
    body.trim() === "" ? "(no description)" : body,
    "Reviews:",
    reviews,
    "Comments:",
    comments,
    "Diff:",
    "```diff",
    diff.trim() === "" ? "(empty diff)" : diff,
    "```",
  ].join("\n");
}

function formatIssueSection(issue: number, labels: string[], comments: PRComment[]): string {
  const labelsText = labels.length > 0 ? labels.join(", ") : "(none)";
  const commentsText =
    comments.length > 0 ? comments.map((c) => `  - ${c.login} (${c.createdAt}): ${c.body}`).join("\n") : "  (no comments)";
  return [`### Issue #${issue}`, `Labels: ${labelsText}`, "Comments:", commentsText].join("\n");
}

/** Deterministic hard cap (#111 acceptance criterion: "bounded, auditable, hard context-size
 *  cap"). Same content + same `maxChars` always yields the same output — a prefix of `text`
 *  plus a fixed truncation marker naming the cap and how much was cut, never a silent drop.
 *  If the marker itself doesn't fit under `maxChars` (a pathologically tiny cap), the marker
 *  alone is truncated to fit — the digest is never allowed to exceed the cap either way. Used
 *  BOTH per-item (each PR/issue section, below) and as buildRetroDigest's final whole-digest
 *  safety net. */
export function capDigest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[... digest truncated: exceeded the ${maxChars}-char cap — ${text.length - maxChars} chars omitted ...]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length) + marker;
}

/** Fair-share budget for one item within a `total`-char pool split across `count` items —
 *  each item gets its PROPORTIONAL slice, floored at 1 (never zero — an item never silently
 *  vanishes) and ceilinged at `max` (one item never hogs the whole pool when there's only one
 *  of it). `count === 0` returns 0 (nothing to share).
 *
 *  Codex review round 1 (PR #118): the previous version also applied hard per-item MINIMUM
 *  floors (1,500/PR, 300/issue) even when the pool couldn't afford them — e.g.
 *  digestMaxChars=200 with two touched PRs still allocated 1,500 chars EACH, so the assembled
 *  digest blew the overall cap and the final whole-digest capDigest front-truncated it,
 *  silently dropping later PRs/issues/commits: the exact starvation failure per-item budgets
 *  exist to prevent. A floor that scales down with the pool (min(ITEM_MIN, share)) can never
 *  lift an item above its proportional share, making the MIN constants inert — so they are
 *  REMOVED rather than kept as dead parameters. Per-item budgets now sum to <= `total` by
 *  construction (up to the 1-char floor at absurdly tiny pools), leaving the final capDigest
 *  as a marked last-resort backstop for fixed header/join overhead, never the mechanism that
 *  drops whole items. */
function fairShare(total: number, count: number, max: number): number {
  if (count <= 0) return 0;
  return Math.min(max, Math.max(1, Math.floor(total / count)));
}

export interface RetroDigestDeps {
  forge: IForge;
  state: State;
}

// Section budget split of `maxChars` (dry-run finding, #111 PR-A: rendering the digest against
// this repo's own real #110 round — PRs #112-#117 — showed that capping only the FINAL
// concatenated text starves everything after the first couple of PRs: two large diffs alone
// exhausted the default 60,000-char cap, so PRs #114-#117, the escalated-issues section, and
// the commit history never appeared in the digest AT ALL. Fixed by budgeting PER SECTION and
// PER ITEM up front — every touched PR and every escalated issue is GUARANTEED some share of
// the cap (fairShare above), never zero, regardless of how large any single diff is. The
// FINAL capDigest call below remains as the absolute safety net (join overhead, a
// pathologically small maxChars), but with per-item budgets in place it rarely does more than
// trim a few trailing bytes.
// #964: adjusted downward (was 0.25/0.1/0.1) to make room for OUTSTANDING_SHARE below — no new
// config key, per this repo's user-tunables-in-config convention (docs/configuration.md): the
// digest still has exactly one cap, `roles.retro.digestMaxChars`, just one more section sharing it.
const ISSUES_SHARE = 0.2; // reserved fraction of maxChars for the whole issues section
const COMMITS_SHARE = 0.08; // reserved fraction of maxChars for commit history
// #453: the tendency table is a compact fixed-width table plus a short header — it needs a
// reserved share for the same starvation reason every other section has one (a couple of large
// PR diffs must not push it out of the digest entirely), but a small one.
const TENDENCY_SHARE = 0.07;
// #964: "your outstanding PRs" — a small, usually-empty-or-short section most rounds, but the one
// most likely to carry an actual failure excerpt (bounded again at the item level below), so it
// gets a real reserved share rather than living entirely off the PR-touched leftover.
const OUTSTANDING_SHARE = 0.15;
const PR_ITEM_MAX = 20_000;
const ISSUE_ITEM_MAX = 5_000;
const OUTSTANDING_ITEM_MAX = 6_000;

/** Assemble this round's read-only digest: PR diffs + review signals for every PR the round's
 *  ledger says was touched, comments/labels for every issue the ledger flagged as escalated,
 *  and the round's commit history (forge.getCommitsSince) — engine-built, deterministic given
 *  the same ledger/forge state, and bounded by `maxChars` (capDigest above, applied both
 *  per-section and as the final safety net — see the module-level comment above this function).
 *  `issueEventKinds` is the caller's own escalation-event-kind list (retro.ts's
 *  RETRO_EVENT_KINDS) — see gatherDigestIssues's doc for why this module doesn't own a second
 *  copy of it. */
export async function buildRetroDigest(
  deps: RetroDigestDeps,
  round: RoundRow,
  maxChars: number,
  issueEventKinds: string[],
  tendencyRounds: number,
): Promise<string> {
  const prs = gatherTouchedPRs(deps.state, round);
  const issues = gatherDigestIssues(deps.state, round, issueEventKinds);
  // #964: NOT round-scoped (see this section's own header comment above) — reads the whole
  // ledger's retro-pr-lifecycle history, independent of `round`.
  const outstanding = await gatherOutstandingRetroPRs(deps.forge, deps.state);

  const issuesBudget = Math.floor(maxChars * ISSUES_SHARE);
  const commitsBudget = Math.floor(maxChars * COMMITS_SHARE);
  const tendencyBudget = Math.floor(maxChars * TENDENCY_SHARE);
  const outstandingBudget = Math.floor(maxChars * OUTSTANDING_SHARE);
  const prsBudget = Math.max(maxChars - issuesBudget - commitsBudget - tendencyBudget - outstandingBudget, 0);
  const perPrCap = fairShare(prsBudget, prs.length, PR_ITEM_MAX);
  const perIssueCap = fairShare(issuesBudget, issues.length, ISSUE_ITEM_MAX);
  const perOutstandingCap = fairShare(outstandingBudget, outstanding.length, OUTSTANDING_ITEM_MAX);

  const prSections: string[] = [];
  for (const pr of prs) {
    try {
      // getIssueBody(pr) — PRs are issues under the hood in GitHub's REST model, same endpoint
      // getIssueBody already targets for real issues (#111 dry-run finding: `gh pr view`'s
      // human-readable output shows the PR's own "what/why" description; the digest's earlier
      // draft omitted it entirely, since formatPRSection only pulled diff+review data — a live
      // browsing session would have seen it and the digest didn't. Fixed here, not just noted.
      const [body, diff, review] = await Promise.all([
        deps.forge.getIssueBody(pr),
        deps.forge.getPRDiff(pr),
        deps.forge.getPRReviewData(pr),
      ]);
      prSections.push(capDigest(formatPRSection(pr, body, diff, review), perPrCap));
    } catch (e) {
      prSections.push(`### PR #${pr}\n(digest fetch failed: ${String(e)})`);
    }
  }

  // #964: capped PER ROW, same fair-share-then-cap pattern as the PR/issue loops above — one
  // huge failure excerpt must not push every other outstanding PR out of the digest.
  const outstandingSections = outstanding.map((row) => capDigest(formatOutstandingPRRow(row), perOutstandingCap));

  const issueSections: string[] = [];
  for (const issue of issues) {
    try {
      const [labels, comments] = await Promise.all([deps.forge.getIssueLabels(issue), deps.forge.getIssueComments(issue)]);
      issueSections.push(capDigest(formatIssueSection(issue, labels, comments), perIssueCap));
    } catch (e) {
      issueSections.push(`### Issue #${issue}\n(digest fetch failed: ${String(e)})`);
    }
  }

  let commitsText: string;
  try {
    const commits = await deps.forge.getCommitsSince(round.started_at);
    if (commits.length === 0) {
      commitsText = "(no commits)";
    } else {
      const joined = commits.map((c) => `${c.sha.slice(0, 7)} ${c.date} ${c.author}: ${c.message.split("\n")[0]}`).join("\n");
      commitsText = capDigest(joined, commitsBudget);
    }
  } catch (e) {
    commitsText = `(commit history unavailable: ${String(e)})`;
  }

  // #453: cross-ROUND, so it sits outside the per-round sections above — capped like every other
  // section (deterministic, marked), never silently dropped.
  const tendencyText = capDigest(
    formatTendencySection(gatherFindingTendency(deps.state, round, tendencyRounds), tendencyRounds),
    tendencyBudget,
  );

  const full = [
    `# Round #${round.round_id} digest (since ${round.started_at})`,
    `## Your outstanding PRs (${outstanding.length})`,
    outstanding.length > 0 ? outstandingSections.join("\n\n") : "(none — no PR you opened is still open on the forge)",
    `## PRs touched this round (${prs.length})`,
    prs.length > 0 ? prSections.join("\n\n") : "(none)",
    `## Escalated issues this round (${issues.length})`,
    issues.length > 0 ? issueSections.join("\n\n") : "(none)",
    "## Commit history since round start",
    commitsText,
    tendencyText,
  ].join("\n\n");

  return capDigest(full, maxChars);
}
