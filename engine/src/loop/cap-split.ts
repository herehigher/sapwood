// cap-split.ts — shared marker vocabulary for the resume-cap -> engine `split` seam (#965).
//
// conductor.ts's RESUME phase writes these at the CAPPED branch; decompose.ts reads them back
// when generating a cap-split parent's children. A STANDALONE module (neither conductor.ts nor
// decompose.ts) is deliberate: decompose.ts already imports round.ts (removeRoundPoolLabel),
// and round.ts imports conductor.ts, so a decompose.ts -> conductor.ts import would close a
// cycle. Both sides import this file instead.
import { z } from "zod";
import { ENGINE_COMMENT_MARKER } from "../forge/forge.js";
import type { State } from "../state/state.js";

/** Stamped into a cap-split child's issue BODY (by decompose.ts, at proposal-persist time) so a
 * LATER resume-cap on that SAME child never cap-splits again (#965 AC2 — "no cap-split of a
 * cap-split"; split storms are bounded by #874's own per-round gate⓪-split cap, this is the
 * sibling one-way fence for the OTHER split source). conductor.ts's CAPPED branch checks the
 * capped issue's body for this exact marker before applying `labels.split`. */
export const CAP_SPLIT_ORIGIN_MARKER = "<!-- sapwood:origin:cap-split -->";

const WIP_POINTER_PREFIX = "<!-- sapwood:cap-split-wip:";
const WIP_POINTER_SUFFIX = " -->";

/** The WIP-pointer comment's payload — everything po-decompose's digest may show for a
 * cap-split parent. Every field but `issue` is optional: a lane that hit the resume cap before
 * ever opening a PR has no branch/head/diffstat to report, and the comment says so honestly
 * rather than fabricating a value (same "absent fact stays absent" stance conductor.ts's
 * spawnFactFrom already takes for `worktreePath`). */
export const CapSplitWipPointerSchema = z
  .object({
    issue: z.number().int().positive(),
    pr: z.number().int().positive().optional(),
    branch: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    diffstat: z.string().min(1).optional(),
  })
  .strict();
export type CapSplitWipPointer = z.infer<typeof CapSplitWipPointerSchema>;

/** Render the one structured WIP-pointer comment body conductor.ts posts on a cap-split parent.
 * The marker line embeds the payload as JSON (an "authoritative signal over an inferred one" —
 * worker.md's own doctrine) so decompose.ts parses it back exactly, never by re-deriving it from
 * this prose. */
export function renderCapSplitWipComment(
  cfg: { splitLabel: string; maxResumes: number; attempts: number },
  pointer: CapSplitWipPointer,
): string {
  const lines: string[] = [
    `sapwood: worker resume cap (${cfg.maxResumes}) reached after ${cfg.attempts} resumed leg(s) — ` +
      `applying \`${cfg.splitLabel}\` for decomposition instead of a human hold. The preserved worktree ` +
      "and WIP branch below are evidence for the decomposer, not a merge-ready deliverable.",
    "",
    pointer.branch !== undefined ? `- Branch: \`${pointer.branch}\`` : "- Branch: unknown (no PR opened for this WIP yet)",
    pointer.pr !== undefined ? `- PR: #${pointer.pr}` : "- PR: none opened yet",
    ...(pointer.headSha !== undefined ? [`- Head: \`${pointer.headSha}\``] : []),
    ...(pointer.diffstat !== undefined ? [`- Diff vs base: ${pointer.diffstat}`] : []),
    "",
    `${WIP_POINTER_PREFIX}${JSON.stringify(pointer)}${WIP_POINTER_SUFFIX}`,
  ];
  return lines.join("\n");
}

/** Parse the WIP-pointer comment back out of a comment stream, or `null` if none exists, the
 * marker is malformed, or no comment PROVABLY came from the engine — fail-closed to "no pointer"
 * (#965 AC3: absent renders nothing, never a crash or a fabricated value).
 *
 * A structured marker SHAPE alone proves nothing about who wrote it: on a public repo, anyone
 * who can comment could post a schema-valid `<!-- sapwood:cap-split-wip:{...} -->` line to
 * suppress the engine's own pointer or to make decompose.ts render a forged WIP digest.
 * `actor`/`ENGINE_COMMENT_MARKER` is the SAME engine-comment-exemption authority every other
 * comment-authority reader in this codebase uses — `comment-cursor-gate.ts`'s
 * `fetchCommentStream` (design adjudicated 2026-08-05): a comment counts ONLY when its author
 * matches the resolved `actor` AND it carries the central `ENGINE_COMMENT_MARKER` (forge.ts),
 * never either alone. `actor: null` (unresolvable identity) exempts NOTHING — the same
 * maximally-fail-closed reading `checkCommentCursorFreshness` documents.
 *
 * This is still never the sole origin signal: `wasCapSplitByState` below is the durable OR'd
 * check decompose.ts actually classifies on — this function's return value feeds the DIGEST
 * fields only. */
export function findCapSplitWipPointer(
  comments: readonly { login: string; body: string }[],
  actor: string | null,
  issue: number,
): CapSplitWipPointer | null {
  if (actor === null) return null;
  for (const comment of comments) {
    if (comment.login !== actor || !comment.body.includes(ENGINE_COMMENT_MARKER)) continue;
    const start = comment.body.indexOf(WIP_POINTER_PREFIX);
    if (start < 0) continue;
    const jsonStart = start + WIP_POINTER_PREFIX.length;
    const end = comment.body.indexOf(WIP_POINTER_SUFFIX, jsonStart);
    if (end < 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(comment.body.slice(jsonStart, end));
    } catch {
      continue;
    }
    const parsed = CapSplitWipPointerSchema.safeParse(raw);
    if (parsed.success && parsed.data.issue === issue) return parsed.data;
  }
  return null;
}

/** A `git diff --stat`-shaped one-line summary computed from a unified diff (`IForge.getPRDiff`)
 * — GitHub-API-sourced, never a local git invocation: worker.test.ts's #69 grep-invariant limits
 * git-shelling to a short named allowlist (worker.ts/gh.ts/review/materializer.ts/
 * review/codex-exec.ts/loop/dashboard-launcher.ts/loop/worktree-janitor.ts) that this module is
 * deliberately not part of, and a worker-controlled worktree is never a safe `git` invocation
 * target regardless (worker.ts's laneBranch doc). Output is inherently bounded — three counts,
 * one line — independent of how large the input diff is.
 *
 * #965: `---`/`+++` are per-file diff HEADER lines, not content
 * — but only in the narrow window between a `diff --git` line and that file's first `@@` hunk
 * header. An ADDED line whose own text starts with `++ ` renders, prefixed by the unified diff's
 * own leading `+`, as a full `+++ ...` line — indistinguishable from a real file header by a bare
 * `startsWith` check (the same trap applies to a REMOVED line starting with `-- ` and `--- `). A
 * one-bit "am I still in this file's header block" state, reset at each `diff --git` and cleared
 * at that file's first `@@`, disambiguates the two without ever needing to pattern-match content. */
export function summarizeUnifiedDiffStat(diff: string): string {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  let inFileHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files.add(line);
      inFileHeader = true;
      continue;
    }
    if (line.startsWith("@@")) {
      inFileHeader = false;
      continue;
    }
    if (inFileHeader) continue; // `--- a/…`, `+++ b/…`, `index …`, rename/mode lines — never content
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(files.size, "file")} changed, ${plural(insertions, "insertion")}(+), ${plural(deletions, "deletion")}(-)`;
}

/** #965: the DURABLE half of "is this parent a cap-split origin" — the
 *  WIP-pointer COMMENT `findCapSplitWipPointer` reads is best-effort (conductor.ts's CAPPED
 *  branch posts it AFTER the label/latch/event already landed, and a write failure there only
 *  ever appends a `resume-cap-split-comment-failed` degrade event — see that branch's own doc).
 *  A comment-write failure must never silently downgrade a genuine cap-split parent to "ordinary
 *  human split": decompose.ts ORs this state read with the comment check before deciding whether
 *  to stamp `CAP_SPLIT_ORIGIN_MARKER` into every child — otherwise a lost comment reopens exactly
 *  the cap-split-of-a-cap-split chain #965 AC2 exists to close. The `resume-capped{split:true}`
 *  event is durable and journaled BY CONSTRUCTION: the label write's own success gates whether
 *  this event is ever appended at all (label-first-or-no-event doctrine, conductor.ts's CAPPED
 *  branch), so its presence alone already proves the split happened — independent of whatever
 *  became of the follow-up comment. Scoped to `issue` (not `worker`): the same issue may cycle
 *  through several lane names across a resume-cap's lifetime, but its OWN identity as a
 *  cap-split parent never does. */
export function wasCapSplitByState(state: Pick<State, "eventsAfterId">, issue: number): boolean {
  return state.eventsAfterId(0, ["resume-capped"]).some((event) => {
    const payload = event.payload as { issue?: unknown; split?: unknown } | null;
    return payload?.issue === issue && payload?.split === true;
  });
}
