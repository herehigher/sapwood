import { isAbsolute } from "node:path";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, PRChangedFile } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";

/**
 * #292: match a repo-root-relative Git path against the deliberately small instruction-path
 * glob subset. Git paths are case-sensitive, but reviewer instructions are consumed on
 * case-insensitive macOS/Windows checkouts too; case-folding makes a suspicious case variant
 * escalate safely. `*` matches within one path segment, while a whole `**` segment matches
 * zero or more segments. NFC normalization makes canonically equivalent checkout names match.
 * Keeping this pure and zero-dependency makes the reviewer-authority trust boundary auditable.
 */
export function instructionPathMatches(path: string, pattern: string): boolean {
  path = path.normalize("NFC").toLowerCase();
  pattern = pattern.normalize("NFC").toLowerCase();
  if (!pattern.includes("*")) return path === pattern;
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  const visited = new Set<number>();

  const match = (patternIndex: number, pathIndex: number): boolean => {
    const state = patternIndex * (pathSegments.length + 1) + pathIndex;
    if (visited.has(state)) return false;
    visited.add(state);
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

/**
 * #527: the patterns #292's trust chain is actually enforced against — the configured list PLUS
 * the reviewer's own doctrine carrier, which is a target-repo file in EVERY deployment and whose
 * text is substituted verbatim into every engine-agent review prompt. A literal default entry
 * would not do: an operator who repoints `doctrine.file` must stay covered, so the path is
 * DERIVED from config rather than hardcoded. #549: the reviewer's OTHER carrier, its prompt file,
 * is derived the same way now that `loadConfig` captures a `reviewer.agent.promptFileRaw` — the
 * literal `engine/prompts/**` default entry still covers the SHIPPED prompt (inert outside a
 * self-hosting target repo), but a repointed `reviewer.agent.promptFile` no longer falls outside
 * every pattern. It is unset in every default deployment, so nothing is added there.
 *
 * Repo-relative by construction: both `cfg.doctrine.file` and `cfg.reviewer.agent.promptFile` are
 * resolved to ABSOLUTE local paths by loadConfig for the engine's own reads, which would both fail
 * `InstructionPath` validation and never match a forge's repo-relative changed-file paths — so the
 * pre-resolution raw value is what's matched (falling back to the resolved key, which is still raw
 * when cfg came from ConfigSchema.parse directly). A value that isn't repo-relative-shaped
 * (absolute, or escaping via `..`) is skipped rather than smuggled in: it can never correspond to a
 * changed-file path anyway. Assumes the config file sits at the repo root, the same assumption
 * every other repo-relative config path already makes.
 *
 * An empty configured list stays the documented off-switch — nothing is unioned onto it, so no
 * forge read happens. Duplicates are harmless: matching de-duplicates by matched PATH, not by
 * pattern.
 */
export function effectiveInstructionPaths(cfg: SapwoodConfig): string[] {
  const configured = cfg.escalation.instructionPaths;
  if (configured.length === 0) return [];
  const carriers = [cfg.doctrine.fileRaw ?? cfg.doctrine.file, cfg.reviewer.agent?.promptFileRaw ?? cfg.reviewer.agent?.promptFile];
  return [...configured, ...carriers.map(repoRelativeCarrier).filter((path) => path !== undefined)];
}

/** #527/#549: a configured carrier path in the repo-relative form a changed-file list can match,
 *  or undefined when it points outside the repo (absolute or `..`-escaping) and so never can. */
function repoRelativeCarrier(configured: string | undefined): string | undefined {
  if (configured === undefined) return undefined;
  const path = configured.startsWith("./") ? configured.slice(2) : configured;
  const outsideRepo = path.length === 0 || isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..");
  return outsideRepo ? undefined : path;
}

/** #292: shared result used by both reviewer kinds so instruction-authority escalation cannot
 * drift between the classic review trigger and the engine-agent paid-session preflight.
 * Escalated `matchedPaths` are render-safe by contract for every downstream sink. */
export type InstructionPathEscalationResult =
  | { kind: "clear" | "latched" }
  | { kind: "escalated"; matchedPaths: string[]; reason: "instruction-path-change" | "instruction-path-list-incomplete" }
  | { kind: "unavailable"; reason: string };

function sanitizePathForComment(path: string): string {
  return [...path]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 ||
        code === 127 ||
        character === "`" ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? "?"
        : character;
    })
    .join("");
}

/**
 * #292: enforce the human-vetted standing-instructions trust chain at merge-gate time. An empty
 * `escalation.instructionPaths` list is a deliberate off-switch: no forge read occurs. The exact,
 * case-insensitive human-merge-only label is the idempotence latch. On escalation the label is written
 * BEFORE the comment; if comment delivery then fails, the label remains the latch and the comment
 * is not retried forever (the crash window between those writes is an accepted bounded audit
 * blind spot; human authority is preserved by the label). The changed-files read is bounded by
 * the latch: latched PRs never fetch the list again.
 */
export async function escalateInstructionPathChanges(input: {
  forge: Pick<IForge, "getPRChangedFiles" | "addPRLabel" | "addPRComment">;
  pr: number;
  labels: readonly string[];
  cfg: SapwoodConfig;
}): Promise<InstructionPathEscalationResult> {
  const patterns = effectiveInstructionPaths(input.cfg);
  if (patterns.length === 0) return { kind: "clear" };
  // #397 bucket 2: this path's verdict is "a human must MERGE this PR", never "the machine got
  // stuck" — so both the latch and the write are `humanMergeOnly`, and `needsHuman` is not written
  // anywhere on this path. The merge veto does not depend on the label being in
  // `escalation.humanLabels`: both call sites (merge-driver.ts's driveOne, review/drive.ts's
  // engine-agent preflight) return `needs-human` from THIS result before deriveGate is ever
  // consulted, so the label carries the verdict for a human reader, not the gate.
  if (labelsInclude(input.labels, input.cfg.labels.humanMergeOnly)) return { kind: "latched" };

  let changedFiles: Awaited<ReturnType<IForge["getPRChangedFiles"]>>;
  try {
    changedFiles = await input.forge.getPRChangedFiles(input.pr);
  } catch (error) {
    return { kind: "unavailable", reason: `instruction-path-files-unavailable: ${String(error)}` };
  }
  const matchedPaths = changedFiles.complete ? matchedInstructionPaths(changedFiles.files, patterns).map(sanitizePathForComment) : [];
  const incomplete = !changedFiles.complete;
  if (!incomplete && matchedPaths.length === 0) return { kind: "clear" };

  try {
    await input.forge.addPRLabel(input.pr, input.cfg.labels.humanMergeOnly);
  } catch (error) {
    return { kind: "unavailable", reason: `instruction-path-label-failed: ${String(error)}` };
  }

  try {
    if (incomplete) {
      await input.forge.addPRComment(
        input.pr,
        "Sapwood escalated this PR for human review because its changed-file list exceeded the GitHub API ceiling and could not be verified. " +
          "The reviewer instruction graph may therefore be incomplete (instruction-path-list-incomplete).",
      );
    } else {
      const renderedPaths = matchedPaths.map((path) => `\`${path}\``).join(", ");
      await input.forge.addPRComment(
        input.pr,
        `Sapwood escalated this PR for human review because it changes reviewer instruction path(s): ${renderedPaths}. ` +
          "Standing instructions are human-vetted reviewer authority; in-PR instruction-graph edits must never reach autonomous merge.",
      );
    }
  } catch {
    // Label-first is intentional: it is already the durable latch, so never retry the comment.
  }
  return { kind: "escalated", matchedPaths, reason: incomplete ? "instruction-path-list-incomplete" : "instruction-path-change" };
}
