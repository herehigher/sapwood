import type { DemoBundle } from "./types.ts";

/**
 * The `?demo` build-time export gate (#742; #735 adjudication: "the genuinely public boundary —
 * the #146 fixture export — gets its gate as an AC on #146"). Two independent scans over the
 * fully-rewritten bundle: a credential-shaped string, or a host-absolute path that survived
 * rewrite, both FAIL the export (never silently ship, never merely warn) — this is the one place
 * in the app that scrubs anything, deliberately not the live `/api/events` feed itself (§8: the
 * live feed stays verbatim; scrubbing belongs only at this public-export boundary).
 *
 * Per the doctrine on inferred-text matching (engine/prompts/doctrine-core.md): both pattern lists below
 * are narrow, enumerated signature shapes, not wildcards — a false NEGATIVE here (an unlisted
 * credential/path shape) is the accepted residual risk, favored over a false POSITIVE that would
 * make a legitimate fixture value (e.g. `/api/events`) unshippable.
 */

export class ExportGateError extends Error {}

/** Recognized credential-shaped signatures — provider-specific prefixes/lengths, not a generic
 *  "looks like a secret" heuristic. Exported so the Tier B post-build check (`bundle.test.ts`)
 *  greps the SHIPPED bundle with the exact same patterns this gate itself enforces, rather than a
 *  second, hand-copied list that could silently drift from what the gate actually checks. Each
 *  entry carries a `label` — #793 gate② finding [2] (export-gate-secret-echo): the gate's own
 *  thrown error names WHICH class matched, never the matched VALUE (see `matchedCredentialClass`
 *  below) — a planted real secret must never round-trip into a CI build log verbatim just because
 *  this gate caught it. */
export const CREDENTIAL_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /gh[oprsu]_[A-Za-z0-9]{36}/, label: "GitHub token" }, // personal/oauth/user-to-server/server-to-server/refresh
  { pattern: /AKIA[0-9A-Z]{16}/, label: "AWS access key id" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "PEM private key block" },
];

/** A host filesystem path — `/Users/<name>/…` or `/home/<name>/…` — never a URL route like
 *  `/api/events`, which has no such prefix. ponytail: Unix-only (macOS/Linux); this repo's
 *  recording and CI machines are both — add a Windows drive-letter pattern if that ever changes.
 *  Exported for the same reuse reason as `CREDENTIAL_PATTERNS` above. */
export const HOST_ABSOLUTE_PATH = /(?:\/Users\/|\/home\/)[^\s]+/g;

const REPO_NAME_MARKERS = ["sapwood-dogfood", "sapwood"];

/** Rewrites a host-absolute path repo-relative by truncating everything up to and including a
 *  recognized repo-name segment. A path with no recognized anchor is left untouched — caught by
 *  the residual scan below rather than guessed at, same fail-closed posture as the rest of this
 *  gate. Anything that isn't a host-absolute path (e.g. `/api/events`) never matches, so it
 *  passes through unchanged without needing its own exemption. */
export function rewriteAbsolutePaths(value: string): string {
  return value.replace(HOST_ABSOLUTE_PATH, (match) => {
    for (const marker of REPO_NAME_MARKERS) {
      const anchor = `/${marker}/`;
      const idx = match.indexOf(anchor);
      if (idx !== -1) return match.slice(idx + anchor.length);
    }
    return match;
  });
}

/** Returns the matched signature's CLASS LABEL only ("Anthropic API key", …) — never the matched
 *  substring itself. #793 gate② finding [2]: the caller (`exportDemoBundle`) interpolates this
 *  into the thrown `ExportGateError`, which `export-cli.ts` deliberately lets reach the build log
 *  uncaught — a real planted secret must never be reproduced there just because this gate is what
 *  caught it. */
function matchedCredentialClass(text: string): string | null {
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Same redaction stance as `matchedCredentialClass` above, for the residual-path scan: a survived
 *  host-absolute path routinely carries a real operator's OS username/hostname (`/Users/<name>/…`)
 *  — private host data with no safe "class" to name, so this reports presence only, never the
 *  path's own text. */
function hasResidualAbsolutePath(text: string): boolean {
  return text.match(HOST_ABSOLUTE_PATH) !== null;
}

function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walkStrings(v, fn)]));
  }
  return value;
}

/**
 * The export gate itself: rewrite every string leaf's host-absolute paths repo-relative, then
 * scan the result for a credential-shaped string or a host-absolute path that survived rewrite —
 * either throws `ExportGateError` (`export-cli.ts` lets that propagate as a nonzero exit, which
 * is what "fails the build" means here). Returns the rewritten bundle on success — never the
 * original, so a caller can't accidentally ship the pre-rewrite paths.
 */
export function exportDemoBundle(source: DemoBundle): DemoBundle {
  const rewritten = walkStrings(source, rewriteAbsolutePaths) as DemoBundle;
  const serialized = JSON.stringify(rewritten);

  // #793 gate② finding [2]: neither error interpolates the matched VALUE — only a class label
  // (credentials) or nothing at all (paths, which routinely carry a real username/hostname).
  const credentialClass = matchedCredentialClass(serialized);
  if (credentialClass) {
    throw new ExportGateError(
      `export gate: a ${credentialClass}-shaped credential string was found in the demo bundle export (value redacted)`,
    );
  }

  if (hasResidualAbsolutePath(serialized)) {
    throw new ExportGateError(
      "export gate: a host-absolute path survived rewrite in the demo bundle export (value redacted — may carry a private username/hostname)",
    );
  }

  return rewritten;
}
