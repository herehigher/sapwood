import type { SapwoodConfig } from "../config/config.js";
import type { IForge, PRChangedFile } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";

/**
 * #292: match a repo-root-relative Git path against the deliberately small instruction-path
 * glob subset. Literal patterns are exact and case-sensitive (Git semantics); `*` matches
 * within one path segment, while a whole `**` segment matches zero or more segments.
 * Keeping this pure and zero-dependency makes the reviewer-authority trust boundary auditable.
 */
export function instructionPathMatches(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");

  const match = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const segment = patternSegments[patternIndex]!;
    if (segment === "**") {
      return match(patternIndex + 1, pathIndex) || (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    }
    if (pathIndex === pathSegments.length) return false;
    const expression = segment
      .split("*")
      .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${expression}$`).test(pathSegments[pathIndex]!) && match(patternIndex + 1, pathIndex + 1);
  };

  return match(0, 0);
}

/**
 * #292: return every old or new changed-file path that edits the configured instruction
 * resolution graph. Previous names are authority-bearing too: renaming/deleting CLAUDE.md must
 * escalate just like adding it. Paths are de-duplicated while preserving forge order for a
 * stable explanatory audit comment.
 */
export function matchedInstructionPaths(files: readonly PRChangedFile[], patterns: readonly string[]): string[] {
  const matched = new Set<string>();
  for (const file of files) {
    for (const path of [file.filename, file.previousFilename]) {
      if (path !== undefined && patterns.some((pattern) => instructionPathMatches(path, pattern))) matched.add(path);
    }
  }
  return [...matched];
}

/** #292: shared result used by both reviewer kinds so instruction-authority escalation cannot
 * drift between the classic review trigger and the engine-agent paid-session preflight. */
export type InstructionPathEscalationResult =
  | { kind: "clear" | "latched" }
  | { kind: "escalated"; matchedPaths: string[] }
  | { kind: "unavailable"; reason: string };

/**
 * #292: enforce the human-vetted standing-instructions trust chain at merge-gate time. An empty
 * `escalation.instructionPaths` list is a deliberate off-switch: no forge read occurs. The exact,
 * case-insensitive needs-human label is the idempotence latch. On a match the label is written
 * BEFORE the comment; if comment delivery then fails, the label remains the latch and the comment
 * is not retried forever (human authority is preserved even when audit delivery is unavailable).
 */
export async function escalateInstructionPathChanges(input: {
  forge: Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  pr: number;
  labels: readonly string[];
  cfg: SapwoodConfig;
}): Promise<InstructionPathEscalationResult> {
  const patterns = input.cfg.escalation.instructionPaths;
  if (patterns.length === 0) return { kind: "clear" };
  if (labelsInclude(input.labels, input.cfg.labels.needsHuman)) return { kind: "latched" };

  let files: PRChangedFile[];
  try {
    files = await input.forge.getPRChangedFiles(input.pr);
  } catch (error) {
    return { kind: "unavailable", reason: `instruction-path-files-unavailable: ${String(error)}` };
  }
  const matchedPaths = matchedInstructionPaths(files, patterns);
  if (matchedPaths.length === 0) return { kind: "clear" };

  try {
    await input.forge.addPRLabel(input.pr, input.cfg.labels.needsHuman);
  } catch (error) {
    return { kind: "unavailable", reason: `instruction-path-label-failed: ${String(error)}` };
  }

  const renderedPaths = matchedPaths.map((path) => `\`${path}\``).join(", ");
  try {
    await input.forge.addPRComment(
      input.pr,
      `Sapwood escalated this PR for human review because it changes reviewer instruction path(s): ${renderedPaths}. ` +
        "Standing instructions are human-vetted reviewer authority; in-PR instruction-graph edits must never reach autonomous merge (#292).",
    );
  } catch {
    // Label-first is intentional: it is already the durable latch, so never retry the comment.
  }
  return { kind: "escalated", matchedPaths };
}
