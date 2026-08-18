// cap-split.ts — shared marker vocabulary for the resume-cap -> engine `split` seam (#965).
//
// conductor.ts's RESUME phase writes these at the CAPPED branch; decompose.ts reads them back
// when generating a cap-split parent's children. A STANDALONE module (neither conductor.ts nor
// decompose.ts) is deliberate: decompose.ts already imports round.ts (removeRoundPoolLabel),
// and round.ts imports conductor.ts, so a decompose.ts -> conductor.ts import would close a
// cycle. Both sides import this file instead.
import { z } from "zod";

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

/** Bounded, marker-idempotent scan: is a WIP-pointer comment for `issue` already on the thread?
 * Same "check before write" shape conductor.ts uses for every other marker-deduped comment. */
export function hasCapSplitWipComment(comments: readonly { body: string }[], issue: number): boolean {
  return findCapSplitWipPointer(comments, issue) !== null;
}

/** Parse the WIP-pointer comment back out of a comment stream, or `null` if none exists / the
 * marker is malformed — fail-closed to "no pointer" (#965 AC3: absent renders nothing, never a
 * crash or a fabricated value). A comment is untrusted data regardless of who is presumed to
 * have authored it (worker.md doctrine) — schema-validated, never blindly cast. */
export function findCapSplitWipPointer(comments: readonly { body: string }[], issue: number): CapSplitWipPointer | null {
  for (const comment of comments) {
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
 * one line — independent of how large the input diff is. */
export function summarizeUnifiedDiffStat(diff: string): string {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files.add(line);
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue; // per-file diff headers, not content
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(files.size, "file")} changed, ${plural(insertions, "insertion")}(+), ${plural(deletions, "deletion")}(-)`;
}
