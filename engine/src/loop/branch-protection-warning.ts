// branch-protection-warning.ts (#633): the owner-ruled disclose + detect-and-WARN response,
// extending #554/#622's shipped mechanism (managed-permission-warning.ts) to the branch-
// protection precondition DR #616 names — twice — as the mandatory platform backstop for
// producer legs inheriting the operator's full host tool surface (docs/security.md's "Accepted
// blind spots" section and its human-merge-only section). No code path in engine/src read
// branch-protection/ruleset state before this — #616's backstop of record was never verified.
// Same ruling as #554: no startup refusal, no needs-human escalation, no label, no gate — one
// engine-log warning per start naming both operator exits, and ONLY when the branch is
// POSITIVELY VERIFIED unprotected, never on an inconclusive read (a warning operators learn to
// distrust is worse than none — #560's logic).
import { type GhRunner, gh } from "../forge/gh.js";
import { DOC_LINKS } from "../util/doc-links.js";

export type BranchProtectionState = { kind: "protected" } | { kind: "confirmed-unprotected"; branch: string } | { kind: "cannot-verify" };

/** Reads default-branch protection state for `repo` ("owner/repo"). Three states, not two (the
 *  issue's own scope note): the legacy branch-protection endpoint 404ing means only that CLASSIC
 *  protection is absent — rulesets are a distinct GitHub feature the legacy endpoint never
 *  reports, so only a 404 on BOTH counts as confirmed-unprotected. Any other failure — reading
 *  the default branch itself, a non-404 from the legacy endpoint (403/plan-limit/network/
 *  unclassifiable), or a failure reading rulesets after a legacy 404 — collapses to
 *  "cannot-verify", never "confirmed-unprotected". Never throws. */
export async function readBranchProtectionState(run: GhRunner, repo: string): Promise<BranchProtectionState> {
  let branch: string;
  try {
    const out = (await run(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
    if (!out) return { kind: "cannot-verify" };
    branch = out;
  } catch {
    return { kind: "cannot-verify" };
  }
  try {
    await run(["api", `repos/${repo}/branches/${branch}/protection`]);
    return { kind: "protected" };
  } catch (e) {
    // execFile errors (via util.promisify) carry the real status text in LATER lines of
    // `.message` ("Command failed: gh api ...\n...HTTP 404...") and/or on a separate `.stderr`
    // property — never just the first line. Classify on the full text (message + stderr, if
    // present) or a first-line-only read silently reclassifies every genuinely-unprotected
    // branch as cannot-verify and this detector never warns (the bug this comment guards).
    //
    // The marker itself must be anchored to gh's own error-line shape — `gh: <msg> (HTTP
    // <code>)`, verified against a real `gh api` 404 — not a bare `\d{3}` scan: a bare scan
    // false-matches an unrelated 3-digit run elsewhere in the text (e.g. a repo/branch/path
    // segment like "project-404"), which would misclassify a real 5xx/network failure as a 404
    // and fire a false unprotected-WARN (#673 gate② P1 on the first fix attempt).
    const message = e instanceof Error ? e.message : String(e);
    const stderr = typeof (e as { stderr?: unknown })?.stderr === "string" ? (e as { stderr: string }).stderr : "";
    const text = `${message}\n${stderr}`;
    const status = text.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
    if (status !== "404") return { kind: "cannot-verify" };
    // Legacy protection is absent — this repo's plan may still enforce a RULESET on the branch
    // instead (a separate GitHub feature the legacy endpoint doesn't report at all), so check
    // that before declaring confirmed-unprotected.
    try {
      const rulesetsRaw = await run(["api", `repos/${repo}/rules/branches/${branch}`]);
      const rulesets: unknown = JSON.parse(rulesetsRaw);
      if (Array.isArray(rulesets) && rulesets.length > 0) return { kind: "protected" };
    } catch {
      return { kind: "cannot-verify" };
    }
    return { kind: "confirmed-unprotected", branch };
  }
}

const warningMessage = (repo: string, branch: string): string =>
  `[sapwood:startup] default branch "${branch}" on ${repo} has NO branch protection (checked both the ` +
  `legacy branch-protection endpoint and any active ruleset covering the branch) — branch protection is ` +
  `the mandatory platform backstop <${DOC_LINKS.securityAcceptedBlindSpots}>'s section names for a producer ` +
  `leg's inherited host tool surface: even though the engine itself only merges through the reviewed PR ` +
  `path, an inherited host tool can still \`git push\` straight to "${branch}", bypassing review ` +
  `entirely. Two exits: enable branch protection (repo Settings -> Branches, require the merge gate this ` +
  `engine already drives PRs through), or consciously accept this posture. Either way, see ` +
  `${DOC_LINKS.securityAcceptedBlindSpots} for the full detail. No action is taken automatically.`;

/** Builds the once-per-engine-start detector. Unlike its filesystem-reading siblings
 *  (detectManagedPermissionMode, checkWebAccessSettingsDenial), this check is a REAL network
 *  read, so cli.ts constructs it ONCE per start and the returned closure carries its own
 *  "already ran" guard — a defensive bound on "one read per engine start" (the issue's own scope
 *  note) that holds independent of caller discipline. Returns whether the warning fired, mostly
 *  for tests — no dispatch gate reads it, same as detectManagedPermissionMode. Never throws:
 *  readBranchProtectionState already fails open on any read error. */
export function createBranchProtectionDetector(
  repo: string,
  log: (message: string) => void = (line) => console.error(line),
  opts: { run?: GhRunner } = {},
): () => Promise<boolean> {
  const run = opts.run ?? gh;
  let checked = false;
  return async () => {
    if (checked) return false;
    checked = true;
    const state = await readBranchProtectionState(run, repo);
    if (state.kind !== "confirmed-unprotected") return false;
    log(warningMessage(repo, state.branch));
    return true;
  };
}
