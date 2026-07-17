// proxy/tools.ts — #234: the forge MCP proxy's FIXED tool algebra v1. This module owns the
// per-tool arg schemas (strict zod, no repo/owner field exists anywhere in them — the repository
// is forcibly scoped server-side from engine config, never caller-controlled, issue #234's
// Custody & scope), the tool-list JSON-Schema descriptions mcp-server.ts serves over `tools/list`,
// and the pure response-shaping logic (caps, completeness flags, sanitized errors) that turns raw
// IForge reads into the exact canonical response journal.ts persists.
//
// SECURITY / HARD INVARIANT (pinned by worker.test.ts's #69 grep-invariant test, engine-wide):
// this module never imports node:child_process and never shells out — only worker.ts (spawn) and
// forge/gh.ts (execFile) may. Every read here goes through the IForge methods threaded in.
import { z } from "zod";
import type { IForge, IssueMeta, IssueRelations, IssueSearchResult, PRComment, RelatedRef } from "../forge/forge.js";

// ── Tool names (fixed algebra v1) ───────────────────────────────────────────────────────────

export const TOOL_ISSUE_DETAILS = "issue_details";
export const TOOL_ISSUE_COMMENTS = "issue_comments";
export const TOOL_ISSUE_RELATIONS = "issue_relations";
export const TOOL_SEARCH_ISSUES = "search_issues";

export const FORGE_MCP_SERVER_NAME = "forge";

/** The v1 fixed tool set, in `tools/list` order. */
export const TOOL_NAMES = [TOOL_ISSUE_DETAILS, TOOL_ISSUE_COMMENTS, TOOL_ISSUE_RELATIONS, TOOL_SEARCH_ISSUES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The `--allowedTools` entries a session needs to actually call these tools — Claude Code's MCP
 *  tool namespace is `mcp__<server>__<tool>` (worker.ts's ClaudeArgsOpts.allowedTools doc). */
export function mcpToolFullName(tool: ToolName): string {
  return `mcp__${FORGE_MCP_SERVER_NAME}__${tool}`;
}

export const PROXY_VERSION = "1";

// ── Server-enforced caps (config-driven — see config.ts's Proxy schema; never hardcoded here) ─

export interface ProxyCaps {
  /** issue_details: max issue numbers per call — an over-cap request is REJECTED (typed error),
   *  never silently truncated (issue #234 AC: "Proxy rejects: ... over-cap requests"). */
  maxIssuesPerCall: number;
  /** issue_details' DEFAULT view: how many of an issue's MOST RECENT comments to include when
   *  fullCommentStreamOptIn is false — bounded inclusion, not a rejection (the default-view
   *  completeness contract degrades via comments_complete/omitted counts, never an error). */
  defaultCommentsPerIssue: number;
  /** issue_comments: max `lastN` a caller may request explicitly — an over-cap lastN is
   *  REJECTED (typed error), same as maxIssuesPerCall. */
  maxCommentsPerCall: number;
  /** issue_relations: cap passed to IForge.getIssueRelations (both connections). */
  maxRelationsPerIssue: number;
  /** search_issues: cap passed to IForge.searchIssues. */
  maxSearchResults: number;
  /** When true, issue_details' default view uses maxCommentsPerCall (effectively "all, bounded
   *  only by the hard safety cap") instead of defaultCommentsPerIssue — issue #234's "Full
   *  comment stream is opt-in config". */
  fullCommentStreamOptIn: boolean;
}

// ── Arg schemas (strict — an unrecognized key, e.g. a caller-supplied `repo`/`owner`, fails
//    validation exactly like any other malformed-args case; this IS the out-of-repo-scope
//    enforcement mechanism, since no schema anywhere accepts a repo/owner field to begin with) ─

export const IssueDetailsArgs = z.object({ numbers: z.array(z.number().int().positive()).min(1) }).strict();
export const IssueCommentsArgs = z.object({ number: z.number().int().positive(), lastN: z.number().int().positive().optional() }).strict();
export const IssueRelationsArgs = z.object({ number: z.number().int().positive() }).strict();

/** #234 F1b (PR #252 review round 2, P1, defense-in-depth; tightened round 3 after a live-
 *  verified bypass): a `repo:`/`org:`/`user:` qualifier INSIDE the GitHub search query text is a
 *  SECOND scope-redirection surface, entirely separate from the argv-flag-injection vector the
 *  `--` terminator (searchIssues, forge.ts) already closes — GitHub's search query LANGUAGE has
 *  its own scope qualifiers, independent of how the query string reaches `gh` as an argv token.
 *  An embedded `repo:` empirically combines with the forced `--repo` (GitHub ANDs them, observed
 *  to return no/same-repo-only results) rather than overriding it — but a credential-mediating
 *  proxy's scope boundary must never rest on an implicit, unspecified combination behavior of the
 *  far side's query language; it must be provable at THIS boundary. The repository is already
 *  forced server-side, so a session has no legitimate reason to pass any of these three
 *  qualifiers — reject before the query ever reaches `gh`, UNCONDITIONALLY, wherever the token
 *  appears in the string. Every OTHER qualifier (`is:`, `in:`, `label:`, `state:`, `author:`,
 *  date ranges, free text — including free text that happens to mention "repo" as an ordinary
 *  word, e.g. "cannot find the repo in error output", which contains no `repo:` token at all)
 *  filters WITHIN the forced scope and stays allowed.
 *
 *  ANCHOR: a plain `\b` word boundary — NOT `(^|\s)` (the original, insufficiently strict form).
 *  `(^|\s)` only anchored on start-of-string-or-whitespace, so a qualifier preceded by ANY other
 *  non-word character slipped through unrejected — verified live: `"(repo:cli/cli OR foo)"`,
 *  `"foo,repo:x/y"`, and `"bar(org:evil)"` all PASSED validation under the old regex (no leak
 *  resulted, since the forced `--repo` still ANDs, but a provable boundary must not have a
 *  demonstrable hole regardless). `\b` matches at ANY word/non-word transition — `(`, `,`, space,
 *  start-of-string — so all three now correctly REJECT. `\b` still will NOT match mid-word: a
 *  token that merely ENDS in one of these three words (`myrepo:`, `superuser:`) has no
 *  word-boundary immediately before the `repo`/`user` substring (the preceding character is
 *  itself a word character), so those legitimately pass — this is a deliberate, verified property
 *  of `\b`, not a hole. */
const SCOPE_QUALIFIER_RE = /\b(repo|org|user):/i;

export const SearchIssuesArgs = z
  .object({ query: z.string().min(1) })
  .strict()
  .refine((v) => !SCOPE_QUALIFIER_RE.test(v.query), {
    message: "query must not contain a repo:/org:/user: scope qualifier — the repository is forced server-side, never caller-controlled",
    path: ["query"],
  });

const ARG_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  [TOOL_ISSUE_DETAILS]: IssueDetailsArgs,
  [TOOL_ISSUE_COMMENTS]: IssueCommentsArgs,
  [TOOL_ISSUE_RELATIONS]: IssueRelationsArgs,
  [TOOL_SEARCH_ISSUES]: SearchIssuesArgs,
};

/** Hand-written JSON Schema for `tools/list` — kept in sync with the zod schemas above by
 *  toolSchemasMatchArgSchemas (proxy/tools.test.ts): every zod-required/optional field appears
 *  here with the same required-ness, so a client's own arg validation (if any) never disagrees
 *  with this server's. No `zod-to-json-schema`-style codegen dependency (repo rule: zero new npm
 *  dependencies) — four small, stable schemas are cheap to hand-maintain. */
export const TOOL_DEFINITIONS: { name: ToolName; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: TOOL_ISSUE_DETAILS,
    description:
      "Fetch the default view (metadata, body, relations, and recent comments up to a cap) for one or more issues in this repository, by number.",
    inputSchema: {
      type: "object",
      properties: { numbers: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 } },
      required: ["numbers"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_ISSUE_COMMENTS,
    description:
      "Fetch an issue's comments, most recent first (optionally bounded to the last N), when the default view's cap wasn't enough.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1 }, lastN: { type: "integer", minimum: 1 } },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_ISSUE_RELATIONS,
    description: "Fetch an issue's relations: linked PRs, incoming cross-references/connections, and outgoing #N mentions in its body.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1 } },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_SEARCH_ISSUES,
    description: "Search issues in this repository (GitHub search syntax), capped matches.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

// ── Typed, sanitized tool errors (issue #234 AC: "nothing token-bearing in any error surface") ─

export type ProxyErrorCode = "unknown_tool" | "invalid_args" | "over_cap" | "budget_exhausted" | "upstream_error" | "persist_failed";

export interface ProxyToolError {
  code: ProxyErrorCode;
  message: string;
}

/** Token-shaped substrings that must never reach a session — GitHub PAT prefixes
 *  (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_), a bearer-scheme header value, and any bare 40-char hex
 *  string (a plausible legacy token or SHA that's cheaper to scrub than to risk). Scrubbed from
 *  upstream error TEXT ONLY — never applied to a successful tool response, which never contains
 *  credential material in the first place (IForge never returns one). */
const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+\S+/gi,
  /\b[0-9a-f]{40}\b/gi,
];

/** Scrub anything token-shaped out of raw upstream error text before it can reach a session or a
 *  journal row — issue #234 AC: "typed sanitized errors (never token-bearing — scrub upstream
 *  error text)". Never throws; a non-string input degrades to a fixed placeholder. */
export function sanitizeUpstreamError(text: unknown): string {
  let s = typeof text === "string" ? text : String(text);
  for (const re of TOKEN_PATTERNS) s = s.replace(re, "[redacted]");
  return s;
}

export function toolError(code: ProxyErrorCode, message: string): ProxyToolError {
  return { code, message: sanitizeUpstreamError(message) };
}

// ── Canonicalization (deterministic key-sorted JSON — the journal's canonical-args/response and
//    the evidence bundle's content-hash input both go through this, so the same logical value
//    always canonicalizes identically regardless of caller-side key order) ─────────────────────

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ── Arg validation + cap enforcement ────────────────────────────────────────────────────────

export type ArgValidation<T> = { ok: true; value: T } | { ok: false; error: ProxyToolError };

/** Validate `rawArgs` for `tool`. Unknown tool name -> "unknown_tool"; schema failure (including
 *  any unrecognized key — the out-of-repo-scope enforcement mechanism, see the module doc) ->
 *  "invalid_args"; a request shape that's schema-valid but exceeds a configured cap ->
 *  "over_cap". Never throws. */
export function validateToolArgs(tool: string, rawArgs: unknown, caps: ProxyCaps): ArgValidation<unknown> {
  if (!isToolName(tool)) return { ok: false, error: toolError("unknown_tool", `unknown tool "${tool}"`) };
  const schema = ARG_SCHEMAS[tool];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: toolError("invalid_args", `invalid arguments for ${tool}: ${parsed.error.message}`) };
  }
  const overCap = checkOverCap(tool, parsed.data, caps);
  if (overCap) return { ok: false, error: toolError("over_cap", overCap) };
  return { ok: true, value: parsed.data };
}

export function isToolName(tool: string): tool is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(tool);
}

function checkOverCap(tool: ToolName, args: unknown, caps: ProxyCaps): string | null {
  if (tool === TOOL_ISSUE_DETAILS) {
    const { numbers } = args as z.infer<typeof IssueDetailsArgs>;
    if (numbers.length > caps.maxIssuesPerCall) {
      return `requested ${numbers.length} issue numbers, exceeds the cap of ${caps.maxIssuesPerCall}`;
    }
  } else if (tool === TOOL_ISSUE_COMMENTS) {
    const { lastN } = args as z.infer<typeof IssueCommentsArgs>;
    if (lastN !== undefined && lastN > caps.maxCommentsPerCall) {
      return `requested lastN=${lastN}, exceeds the cap of ${caps.maxCommentsPerCall}`;
    }
  }
  return null;
}

// ── Default-view completeness (issue #234's "fail toward inclusion" contract) ──────────────

export interface CommentsView {
  comments: PRComment[];
  total: number;
  returned: number;
  complete: boolean;
  /** 1-based, inclusive index range of the OLDEST comments omitted (comments are kept
   *  newest-first-by-inclusion — see capComments' doc) — undefined when complete. */
  omittedRange?: { from: number; to: number };
}

/** Keep the `cap` MOST RECENT of `all` (chronological, oldest-first input — gh's own default
 *  order, same as parsePRComments' output) — never the oldest `cap`. Rationale (issue #234's
 *  default-view contract): "amendment-bearing comments supersede stale bodies; no semantic
 *  classifier may silently drop a comment" — the newest comments are the ones most likely to
 *  carry a correction/amendment to an issue whose body has gone stale, so a bounded default view
 *  must fail toward keeping THOSE, not the earliest discussion. The omitted range names exactly
 *  which (oldest) comments were cut, so a session that needs pre-history can retrieve it via
 *  issue_comments rather than being silently denied it. */
export function capComments(all: PRComment[], cap: number): CommentsView {
  const total = all.length;
  if (total <= cap) return { comments: all, total, returned: total, complete: true };
  const kept = all.slice(total - cap);
  return { comments: kept, total, returned: kept.length, complete: false, omittedRange: { from: 1, to: total - cap } };
}

/** Outgoing `#N` mentions in `text` — this repo's own bare-issue-reference convention (same
 *  shape as forge.ts's BARE_ISSUE_PREFIX/ISSUE_NUMBER_END, kept as an independent, self-contained
 *  regex here rather than importing forge.ts's unexported fragments: this is scanning for EVERY
 *  mention, not resolving a single ambiguous reference the way forge.ts's referencedIssue does,
 *  so the two have different jobs even though the pattern looks similar). De-duplicated,
 *  ascending numeric order. */
export function outgoingMentions(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(/(?:^|[^0-9])#(\d+)(?!\d)/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

// ── Response shapes ─────────────────────────────────────────────────────────────────────────

export interface IssueDetailsView {
  meta: IssueMeta;
  body: string;
  relations: IssueRelations & { outgoingMentions: number[] };
  comments: CommentsView;
}

export interface IssueCommentsResponse extends CommentsView {
  number: number;
}

export interface IssueRelationsResponse extends IssueRelations {
  number: number;
  outgoingMentions: number[];
}

export interface SearchIssuesResponse {
  query: string;
  results: IssueSearchResult[];
  cap: number;
  /** True when `results.length === cap` — GitHub search gives no total-match count, so hitting
   *  the cap exactly is the only honest truncation signal available (same stance as
   *  IssueRelations.truncated). */
  truncated: boolean;
}

/** issue_details' default view for ONE issue number — fetches meta/body/comments/relations via
 *  the threaded IForge, applies the comment cap (issue #234's fail-toward-inclusion contract) and
 *  derives outgoing mentions from the body text. Pure orchestration over injected async reads;
 *  mcp-server.ts is the only caller, wrapping this in the journal's write-ahead ordering. */
export async function fetchIssueDetailsView(
  forge: Pick<IForge, "getIssueMeta" | "getIssueBody" | "getIssueComments" | "getIssueRelations">,
  number: number,
  caps: ProxyCaps,
): Promise<IssueDetailsView> {
  const [meta, body, allComments, relations] = await Promise.all([
    forge.getIssueMeta(number),
    forge.getIssueBody(number),
    forge.getIssueComments(number),
    forge.getIssueRelations(number, caps.maxRelationsPerIssue),
  ]);
  const commentsCap = caps.fullCommentStreamOptIn ? caps.maxCommentsPerCall : caps.defaultCommentsPerIssue;
  return {
    meta,
    body,
    relations: { ...relations, outgoingMentions: outgoingMentions(body) },
    comments: capComments(allComments, commentsCap),
  };
}

export async function fetchIssueCommentsResponse(
  forge: Pick<IForge, "getIssueComments">,
  number: number,
  lastN: number | undefined,
  caps: ProxyCaps,
): Promise<IssueCommentsResponse> {
  const all = await forge.getIssueComments(number);
  const cap = lastN ?? caps.maxCommentsPerCall;
  return { number, ...capComments(all, cap) };
}

export async function fetchIssueRelationsResponse(
  forge: Pick<IForge, "getIssueRelations" | "getIssueBody">,
  number: number,
  caps: ProxyCaps,
): Promise<IssueRelationsResponse> {
  const [relations, body] = await Promise.all([forge.getIssueRelations(number, caps.maxRelationsPerIssue), forge.getIssueBody(number)]);
  return { number, ...relations, outgoingMentions: outgoingMentions(body) };
}

export async function fetchSearchIssuesResponse(
  forge: Pick<IForge, "searchIssues">,
  query: string,
  caps: ProxyCaps,
): Promise<SearchIssuesResponse> {
  const results = await forge.searchIssues(query, caps.maxSearchResults);
  return { query, results, cap: caps.maxSearchResults, truncated: results.length >= caps.maxSearchResults };
}

// Re-exported so mcp-server.ts/journal.ts never need their own import of RelatedRef just to
// thread it through a type signature.
export type { RelatedRef };
