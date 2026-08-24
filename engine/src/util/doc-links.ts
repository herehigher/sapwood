// doc-links.ts: the ONE place production runtime output (CLI status/help lines, park/escalation
// GitHub comments, startup guidance) resolves a `docs/*.md` citation to something a reader can
// actually open. A bare repo-relative path only resolves inside a checkout of this repo — the
// npm package's `files` field ships no `docs/` directory, and a target repo the engine is
// installed into has no `docs/` of its own either, so a hardcoded `docs/troubleshooting.md` in
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
const DOC_BASE_URL = "https://github.com/herehigher/sapwood/blob/main/";

/** Canonical repo-relative path for every doc file a production runtime surface cites. Update
 *  ONLY this map when a doc moves (e.g. the docs reorganization this module anticipates) — every
 *  citation below is built from it, never a hardcoded path of its own. */
const DOC_PATHS = {
  gettingStarted: "docs/getting-started.md",
  configuration: "docs/configuration.md",
  troubleshooting: "docs/troubleshooting.md",
  security: "docs/security.md",
  supervision: "docs/supervision.md",
  reviewDoctrine: "docs/REVIEW-DOCTRINE.md",
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
  securityAcceptedBlindSpots: docUrl("security", "accepted-blind-spots"),
  securityManagedSettingsException: docUrl("security", "managed-settings-allowmanagedpermissionrulesonly-exception"),
  securityExecutionProfiles: docUrl("security", "execution-profiles-host-permission-mode--bash-sandbox"),
} as const;
