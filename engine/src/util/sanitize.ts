// util/sanitize.ts — #234's token-scrubbing primitive, moved here (#975) so a dependency-free
// leaf module can be reused by proxy/tools.ts, proxy/journal.ts, proxy/mcp-server.ts, and
// roles/worker.ts WITHOUT any of them importing each other for it. Zero engine-internal imports
// by design — anything imported here becomes a constraint on who can safely import this file.

/** Token-shaped substrings that must never reach a session — GitHub PAT prefixes
 *  (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_), a bearer-scheme header value, any bare 40-char hex
 *  string (a plausible legacy token or SHA that's cheaper to scrub than to risk), a URL's
 *  embedded userinfo (`https://user:pass@host/...` OR `https://ghp_xxx@host/...` — EITHER shape,
 *  colon or no colon, is a credential-bearing git remote URL, a realistic upstream-error shape),
 *  and a token-bearing query parameter (`token=`/`access_token=`/`x-access-token=`,
 *  case-insensitive). Each entry pairs its own `replacement` (rather than a single shared
 *  "[redacted]" literal) so the userinfo/query-param patterns can preserve their surrounding,
 *  non-secret structure (`://[redacted]@`, `token=[redacted]`) via `$1`-style backreferences —
 *  same diagnosability stance as Bearer's own pattern (keeps the scheme word, scrubs only the
 *  value). Round-2 delta review, P2: the userinfo pattern originally REQUIRED a `user:pass` pair
 *  (missing a BARE-token userinfo, e.g. `https://ghp_xxx@github.com`, no colon at all) — broadened
 *  to redact ANY userinfo shape (`://<anything but / or @>@`). Scrubbed from upstream error TEXT
 *  ONLY — never applied to a successful tool response, which never contains credential material
 *  in the first place (IForge never returns one). */
const TOKEN_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[redacted]" },
  { pattern: /\bBearer\s+\S+/gi, replacement: "[redacted]" },
  { pattern: /\b[0-9a-f]{40}\b/gi, replacement: "[redacted]" },
  // `scheme://<userinfo>@` — ANY userinfo shape (bare token OR user:pass), non-greedy up to the
  // FIRST `@` so a legitimate path/query containing `@` later in the URL is never over-matched.
  // `$1` (the captured `://`) is preserved; only the userinfo itself is redacted.
  { pattern: /(:\/\/)[^\s/@]+@/g, replacement: "$1[redacted]@" },
  // A token-bearing query parameter — the key name (`$1`) is preserved, only the value redacted.
  { pattern: /\b(token|access_token|x-access-token)=[^&\s]+/gi, replacement: "$1=[redacted]" },
];

/** Scrub anything token-shaped out of raw upstream error text before it can reach a session or a
 *  journal row — issue #234 AC: "typed sanitized errors (never token-bearing — scrub upstream
 *  error text)". Never throws; a non-string input degrades to a fixed placeholder.
 *
 *  #975: this is ALSO the sanitizer `forge.ts`'s `getFailedCheckSummary` runs every per-source
 *  failure reason (annotations-fetch / log-tail-fetch error text) through before embedding it in
 *  an otherwise-successful excerpt — that embedded text reaches a session WITHOUT ever passing
 *  through `toolError`/`runJournaledCall`'s own top-level-throw sanitization (`pr_failed_checks`
 *  deliberately never throws on a forge read failure, see `fetchPRFailedChecksResponse`'s own
 *  doc), so it needed the SAME scrub applied at its own embedding point instead. */
export function sanitizeUpstreamError(text: unknown): string {
  let s = typeof text === "string" ? text : String(text);
  for (const { pattern, replacement } of TOKEN_PATTERNS) s = s.replace(pattern, replacement);
  return s;
}
