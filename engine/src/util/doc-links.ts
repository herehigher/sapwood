// doc-links.ts: the ONE place production runtime output (CLI status/help lines, park/escalation
// GitHub comments, startup guidance) resolves a `docs/*.md` citation to something a reader can
// actually open. A bare repo-relative path only resolves inside a checkout of this repo — the
// npm package's `files` field ships no `docs/` directory, and a target repo the engine is
// installed into has no `docs/` of its own either, so a hardcoded `docs/guide/troubleshooting.md` in
// that output is a dead end for both audiences. A canonical `blob/main` URL resolves from
// anywhere. Centralizing the base + per-file path here also means the doc reorganization that
// follows this module (moving files under `docs/` into subfolders) is a same-file change, not a
// hunt through every production call site that cites one.
//
// Deliberately a literal owner/repo, not derived from `package.json` at runtime: this repo's
// `docs/` only ever exists in herehigher/sapwood itself, never in whatever target repo the
// engine happens to be dispatching against — so the pair names WHERE THE DOCS LIVE, a fact about
// this repo, not about the caller's environment. Matches `engine/package.json`'s own
// `repository`/`homepage` fields, the existing canonical source for the same pair.
//
// `.claude-plugin/CLAUDE.md` cites the same doc set for a session running inside a target repo
// (it ships in the plugin, so it cannot import this module) — its URLs are hand-kept
// byte-identical to this module's output; update both together when a path here changes.
const DOC_BASE_URL = "https://github.com/herehigher/sapwood/blob/main/";

/** Canonical repo-relative path for every doc file a production runtime surface cites. Update
 *  ONLY this map when a doc moves (e.g. the docs reorganization this module anticipates) — every
 *  citation below is built from it, never a hardcoded path of its own. */
const DOC_PATHS = {
  gettingStarted: "docs/guide/getting-started.md",
  configuration: "docs/guide/configuration.md",
  troubleshooting: "docs/guide/troubleshooting.md",
  security: "docs/security.md",
  // #1094 PR-S: docs/security.md split into the core model + per-mechanism pages under
  // docs/security/ — these DOC_LINKS entries now point at their new page, not the core file.
  securityExecutionProfiles: "docs/security/execution-profiles.md",
  securityRoleSessions: "docs/security/role-sessions.md",
  securityAdjudication: "docs/security/adjudication.md",
  supervision: "docs/guide/supervision.md",
  reviewDoctrine: "docs/REVIEW-DOCTRINE.md",
  // #1123 PR-2: the framework-owned, generic review-doctrine core — a shipped prompt asset, not
  // a docs/ page, but cited the same way (anchored, validated by doc-links.test.ts against the
  // file's own real heading slugs).
  doctrineCore: "engine/prompts/doctrine-core.md",
  plan: "docs/PLAN.md",
} as const;

function docUrl(doc: keyof typeof DOC_PATHS, anchor?: string): string {
  return `${DOC_BASE_URL}${DOC_PATHS[doc]}${anchor ? `#${anchor}` : ""}`;
}

/** One canonical URL per doc citation a production runtime surface actually uses. Add an entry
 *  here (never a fresh literal at a call site) when a new site needs to cite a doc — anchored
 *  entries name the heading they point at in the key itself so a caller never hand-writes a
 *  fragment. */
export const DOC_LINKS = {
  gettingStarted: docUrl("gettingStarted"),
  configuration: docUrl("configuration"),
  troubleshooting: docUrl("troubleshooting"),
  security: docUrl("security"),
  supervision: docUrl("supervision"),
  reviewDoctrine: docUrl("reviewDoctrine"),
  doctrineCore: docUrl("doctrineCore"),
  // #1123 PR-2: the gated-reentry-cap escalation comment's anchored pointer — the
  // `## How the loop treats review findings` heading in the core (DOC_LINKS entries anchor by
  // slug so a heading rename breaks doc-links.test.ts, never a runtime string silently).
  doctrineCoreAdjudication: docUrl("doctrineCore", "how-the-loop-treats-review-findings"),
  plan: docUrl("plan"),
  securityAcceptedBlindSpots: docUrl("security", "accepted-blind-spots"),
  securityManagedSettingsException: docUrl("securityRoleSessions", "managed-settings-allowmanagedpermissionrulesonly-exception"),
  securityExecutionProfiles: docUrl("securityExecutionProfiles", "execution-profiles-host-permission-mode--bash-sandbox"),
  securityAcAuthorityDispatchSnapshot: docUrl("securityAdjudication", "the-ac-authority-dispatch-snapshot"),
  // #1123 PR-3 (#865): the AC evidence-tier doctrine (tier A-D, including tier C's
  // human-witnessed-probe rule) — the operator-owned escalation comment points here so an
  // operator knows exactly what record to post into the issue body to reclaim the lane.
  securityAcEvidenceTiers: docUrl("security", "doctrine-lines"),
} as const;
