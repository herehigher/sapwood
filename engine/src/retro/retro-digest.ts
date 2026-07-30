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
import type { IForge, PRComment, PRReviewData } from "../forge/forge.js";
import type { RoundRow, State } from "../state/state.js";

/** Durable event kinds whose payload carries a `pr` field (conductor.ts's DRIVE-phase
 *  appendEvent call sites) — the digest's "PRs touched this round" source. Deliberately NOT
 *  the reviewer-fallback announcement events (`reviewer-fallback-*`): those report on the
 *  review-gate MECHANISM, not on a PR's own content, and are already implied by whichever of
 *  the four kinds below the same driveOne tick also appends. */
export const PR_TOUCHED_EVENT_KINDS = ["merged", "drive-needs-human", "drive-queued", "drive-stopped"];

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
const ISSUES_SHARE = 0.25; // reserved fraction of maxChars for the whole issues section
const COMMITS_SHARE = 0.1; // reserved fraction of maxChars for commit history
const PR_ITEM_MAX = 20_000;
const ISSUE_ITEM_MAX = 5_000;

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
): Promise<string> {
  const prs = gatherTouchedPRs(deps.state, round);
  const issues = gatherDigestIssues(deps.state, round, issueEventKinds);

  const issuesBudget = Math.floor(maxChars * ISSUES_SHARE);
  const commitsBudget = Math.floor(maxChars * COMMITS_SHARE);
  const prsBudget = Math.max(maxChars - issuesBudget - commitsBudget, 0);
  const perPrCap = fairShare(prsBudget, prs.length, PR_ITEM_MAX);
  const perIssueCap = fairShare(issuesBudget, issues.length, ISSUE_ITEM_MAX);

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

  const full = [
    `# Round #${round.round_id} digest (since ${round.started_at})`,
    `## PRs touched this round (${prs.length})`,
    prs.length > 0 ? prSections.join("\n\n") : "(none)",
    `## Escalated issues this round (${issues.length})`,
    issues.length > 0 ? issueSections.join("\n\n") : "(none)",
    "## Commit history since round start",
    commitsText,
  ].join("\n\n");

  return capDigest(full, maxChars);
}
