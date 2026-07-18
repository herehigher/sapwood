// proxy/mcp-server.ts — #234: a hand-rolled, MINIMAL streamable-HTTP MCP server. ZERO new npm
// dependencies (repo culture: runtime deps are yaml+zod only) — built entirely on node:http,
// node:crypto. Binds 127.0.0.1 on an ephemeral port (`listen(0, "127.0.0.1")`); implements just
// the JSON-RPC 2.0 methods the Claude Code CLI's MCP client needs: `initialize`,
// `notifications/initialized`, `tools/list`, `tools/call`. Responds `application/json` only — a
// GET (the streamable-HTTP SSE stream variant) is rejected with 405 rather than implemented
// (issue #234's transport direction: "simple POST request/response is sufficient").
//
// SECURITY: a random bearer token is minted per session (startForgeProxyServer's caller mints one
// server per role session), checked on EVERY request (including `initialize`) via a CONSTANT-TIME
// comparison (#234 F7, PR #252 review — `crypto.timingSafeEqual`, length-guarded first since it
// throws on a length mismatch rather than returning false; a plain `!==` string compare leaks
// timing information proportional to the matching-prefix length), revoked at teardown (`stop()`
// flips a flag BEFORE closing the socket, so a request racing the shutdown still sees 401, never
// a late-arriving success) — wrong/revoked -> 401 and NOTHING else (no body, no error detail: an
// attacker probing the port learns nothing). The repository is FORCIBLY scoped server-side
// (`deps.scope`, `deps.forge` — both engine-config-derived, never request-controlled): no tool
// argument schema anywhere in proxy/tools.ts accepts an owner/repo field, so there is no argument
// shape that could even ASK for a different repo.
//
// KNOWN LIMITATION (#234 F7, PR #252 review, Codex #5 — accepted, not fixed in this PR): the
// bearer token travels to the `claude` child process embedded in the inline `--mcp-config` JSON
// argv value (peripheral.ts's RoleRunner), so any OTHER process running as the SAME UID as the
// engine can read it off that child's argv via `ps`/`/proc`. This is accepted because a same-UID
// process is already inside this system's trust boundary — it can read the engine's OWN forge
// credentials, config, and state DB directly, so a leaked proxy token grants it nothing it didn't
// already have. Revisit if the transport ever moves off argv (e.g. an fd/temp-file handoff) —
// deliberately NOT attempted here (out of scope for this PR, see the PR body).
//
// HARD INVARIANT (worker.test.ts's #69 grep-invariant test, engine-wide): no node:child_process
// import, no subprocess call, anywhere in this module — only worker.ts (spawn) and forge/gh.ts
// (execFile) may shell out. This server never does.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { z } from "zod";
import type { IForge } from "../forge/forge.js";
import type { ForgeProxyIdentity } from "../state/state.js";
import { markDelivered, type ProxyBudget, type ProxyJournalState, ProxyTimeoutError, runJournaledCall } from "./journal.js";
import {
  FORGE_MCP_SERVER_NAME,
  fetchIssueCommentsResponse,
  fetchIssueDetailsView,
  fetchIssueRelationsResponse,
  fetchPRChecksResponse,
  fetchPRDetailsResponse,
  fetchPRReviewsResponse,
  fetchPRReviewThreadsResponse,
  fetchSearchIssuesResponse,
  type IssueCommentsArgs,
  type IssueDetailsArgs,
  type IssueRelationsArgs,
  mcpToolFullName,
  type PRChecksArgs,
  type PRDetailsArgs,
  PROXY_VERSION,
  type PRReviewsArgs,
  type PRReviewThreadsArgs,
  type ProxyCaps,
  type ProxyToolError,
  type SearchIssuesArgs,
  sanitizeUpstreamError,
  TOOL_DEFINITIONS,
  TOOL_ISSUE_COMMENTS,
  TOOL_ISSUE_DETAILS,
  TOOL_ISSUE_RELATIONS,
  TOOL_NAMES,
  TOOL_PR_DETAILS,
  TOOL_PR_REVIEW_THREADS,
  TOOL_PR_REVIEWS,
  TOOL_SEARCH_ISSUES,
  type ToolName,
  toolError,
  validateToolArgs,
} from "./tools.js";

export type ProxyForge = Pick<
  IForge,
  | "getIssueMeta"
  | "getIssueBody"
  | "getIssueComments"
  | "getIssueRelations"
  | "searchIssues"
  | "getPRDetails"
  | "getPRReviews"
  | "getPRReviewThreads"
  | "getPRChecks"
>;

export interface ForgeProxyDeps {
  forge: ProxyForge;
  state: ProxyJournalState;
  identity: ForgeProxyIdentity;
  scope: { owner: string; repo: string };
  caps: ProxyCaps;
  budget: ProxyBudget;
  /** Hard per-call ceiling — a hung upstream `gh` call must never wedge the session waiting on
   *  the proxy forever (mirrors worker.ts's own timeout-ceiling stance elsewhere in this repo). */
  timeoutMs: number;
  /** #244: the fixed-algebra subset THIS session's role may call — proxy/access.ts's role x tool
   *  matrix (deny-by-default for an unrecognized role). Omitted -> every fixed tool is allowed
   *  (today's #234 behavior, unchanged — every existing caller that doesn't yet pass this keeps
   *  working exactly as before). Enforced HERE, server-side (handleToolCall/`tools/list`), not
   *  merely via the CLI's `--allowedTools` widening (`ForgeProxyHandle.toolNames` below narrows
   *  to the same subset, but that's noise reduction only — same stance as every other
   *  allowed/disallowedTools pair in this codebase, see peripheral.ts's doc). */
  allowedTools?: readonly ToolName[];
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ForgeProxyHandle {
  port: number;
  token: string;
  url: string;
  /** Inline `--mcp-config` JSON — worker.ts's claudeArgs()/peripheral.ts's RoleRunner pass this
   *  straight through, never written to a file (same inline-never-a-file stance as --settings). */
  mcpConfigJson: string;
  /** `mcp__forge__<tool>` for every tool this session's role is granted (#244: ForgeProxyDeps.
   *  allowedTools, all fixed tools when omitted) — the `--allowedTools` entries a session needs. */
  toolNames: string[];
  /** Revoke the token FIRST (any in-flight/late request 401s immediately), then close the
   *  listener and any still-open sockets. Idempotent — a second call is a no-op. */
  stop: () => Promise<void>;
}

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

class JsonRpcMethodNotFound extends Error {}

export async function startForgeProxyServer(deps: ForgeProxyDeps): Promise<ForgeProxyHandle> {
  const now = deps.now ?? ((): Date => new Date());
  const log = deps.log ?? ((): void => {});
  const token = randomBytes(32).toString("hex");
  let revoked = false;

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((e) => {
      // #244 (Codex sol-high PR #260 review, P2): every log interpolation of a caught error
      // routes through sanitizeUpstreamError — this is a bare `log()` line, not a tool-result
      // error (which already sanitizes via toolError), so it needed its own explicit scrub.
      log(
        `[sapwood:forge-proxy] unhandled request error (non-fatal): ${sanitizeUpstreamError(e instanceof Error ? e.message : String(e))}`,
      );
      try {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      } catch {
        /* connection already gone */
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      // The streamable-HTTP SSE-stream variant — deliberately unimplemented (issue #234's
      // transport direction permits rejecting it); a client falls back to plain POST.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Bearer token checked on EVERY request, before any body is even read — wrong/revoked ->
    // 401 and NOTHING else (issue #234's Custody & scope). Constant-time compare (#234 F7) —
    // see the module doc's SECURITY note.
    if (revoked || !safeEqualToken(req.headers.authorization, token)) {
      res.writeHead(401).end();
      return;
    }
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413).end();
      return;
    }
    let rpc: JsonRpcRequest;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as JsonRpcRequest).method !== "string") {
        throw new Error("not a JSON-RPC request object");
      }
      rpc = parsed as JsonRpcRequest;
    } catch {
      writeJson(res, 200, jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    if (rpc.id === undefined || rpc.id === null) {
      // A notification (e.g. notifications/initialized) — JSON-RPC 2.0 gets no response body;
      // 202 Accepted is the streamable-HTTP transport's documented shape for this case.
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    try {
      result = await dispatch(rpc);
    } catch (e) {
      if (e instanceof JsonRpcMethodNotFound) {
        writeJson(res, 200, jsonRpcError(rpc.id, -32601, e.message));
      } else {
        writeJson(res, 200, jsonRpcError(rpc.id, -32603, sanitizeUpstreamError(e instanceof Error ? e.message : String(e))));
      }
      return;
    }
    const extraHeaders = rpc.method === "initialize" ? { "Mcp-Session-Id": randomBytes(16).toString("hex") } : undefined;
    writeJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result }, extraHeaders);
  }

  async function dispatch(rpc: JsonRpcRequest): Promise<unknown> {
    switch (rpc.method) {
      case "initialize": {
        const params = rpc.params as { protocolVersion?: string } | undefined;
        return {
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: FORGE_MCP_SERVER_NAME, version: PROXY_VERSION },
        };
      }
      case "tools/list": {
        // #244: a role's `tools/list` view is scoped to its own allowed subset too — a denied
        // tool isn't just rejected on call, it's never even ADVERTISED to this session.
        const allowed = deps.allowedTools;
        const visible = allowed === undefined ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => allowed.includes(t.name));
        return { tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      }
      case "tools/call":
        return handleToolCall(rpc.params as { name?: string; arguments?: unknown } | undefined);
      default:
        throw new JsonRpcMethodNotFound(`unknown method "${rpc.method}"`);
    }
  }

  async function handleToolCall(params: { name?: string; arguments?: unknown } | undefined): Promise<unknown> {
    const name = params?.name ?? "";
    const rawArgs = params?.arguments ?? {};
    const validation = validateToolArgs(name, rawArgs, deps.caps);
    if (!validation.ok) return toolResultError(validation.error);
    const tool = name as ToolName; // validateToolArgs's isToolName check narrows this

    // #244: role x tool matrix enforcement — a real, schema-valid tool name this SESSION's role
    // isn't granted (proxy/access.ts). The REAL boundary (not the CLI's --allowedTools noise
    // reduction) — see ForgeProxyDeps.allowedTools' doc. Checked AFTER schema/cap validation (a
    // malformed call is still `invalid_args`/`over_cap` regardless of role) but BEFORE any
    // budget/journal/upstream work — a denied call never even reserves budget or writes an
    // intent row.
    if (deps.allowedTools !== undefined && !deps.allowedTools.includes(tool)) {
      return toolResultError(toolError("role_denied", `tool "${tool}" is not granted to this session's role`));
    }

    // #234: deferred — see follow-up (Codex #8, PR #252 review; moves with #244/consumer
    // adoption). `withTimeout` below races the promise and rejects on the timer, but does NOT
    // abort the underlying `gh` subprocess `fetchForTool` kicked off (forge/gh.ts's execFile has
    // no AbortSignal wired through IForge today) — a timed-out call's `gh` process keeps running
    // in the background until it naturally exits. Left unfixed here because the pile-up this
    // could cause is already BOUNDED once F3/F4's budget enforcement is in place (a session can
    // only ever have `maxCallsPerSession` calls in flight, each capped at `timeoutMs`); wiring a
    // real AbortSignal through IForge's gh() call chain is a larger, cross-cutting change that
    // belongs with a live caller motivating it, not spec-first in this PR.
    const outcome = await runJournaledCall({
      state: deps.state,
      identity: deps.identity,
      tool,
      args: validation.value,
      caps: deps.caps,
      budget: deps.budget,
      scope: deps.scope,
      now,
      fetch: () => withTimeout(fetchForTool(tool, validation.value), deps.timeoutMs),
    });
    if (!outcome.ok) return toolResultError(outcome.error);
    if (outcome.journalId !== undefined) markDelivered(deps.state, outcome.journalId, now);
    return { content: [{ type: "text", text: JSON.stringify(outcome.response) }], isError: false };
  }

  async function fetchForTool(
    tool: ToolName,
    args: unknown,
  ): Promise<{
    value: unknown;
    upstreamIds?: (string | number)[];
    upstreamUpdatedAt?: string;
    counts?: Record<string, number>;
    truncated?: boolean;
  }> {
    if (tool === TOOL_ISSUE_DETAILS) {
      const { numbers } = args as z.infer<typeof IssueDetailsArgs>;
      const views = await Promise.all(numbers.map((n) => fetchIssueDetailsView(deps.forge, n, deps.caps)));
      // #234 F6 (PR #252 review, Codex #9): the journal's audit contract wants "upstream ids +
      // updatedAt" per call — for a BATCH call there is no single entity's updatedAt, so the
      // most recent among the fetched issues is recorded (a defensible audit signal: "as of
      // this call, nothing in this batch was newer than X"), never a fabricated single value.
      // exactOptionalPropertyTypes: the key is OMITTED (never set to explicit undefined) when
      // there's nothing to report (an empty batch never happens here, but maxUpdatedAt is shared
      // with search_issues, which can).
      const detailsUpdatedAt = maxUpdatedAt(views.map((v) => v.meta.updatedAt));
      return {
        value: { issues: views },
        upstreamIds: numbers,
        ...(detailsUpdatedAt !== undefined ? { upstreamUpdatedAt: detailsUpdatedAt } : {}),
        counts: { requested: numbers.length, returned: views.length },
        truncated: views.some((v) => !v.comments.complete || v.relations.truncated),
      };
    }
    if (tool === TOOL_ISSUE_COMMENTS) {
      const { number, lastN } = args as z.infer<typeof IssueCommentsArgs>;
      const value = await fetchIssueCommentsResponse(deps.forge, number, lastN, deps.caps);
      // #234 F6: no updatedAt source here without a SEPARATE getIssueMeta call this tool has no
      // other reason to make (PRComment carries only createdAt) — upstreamIds (the issue number
      // this call was scoped to) is the audit signal this tool has to offer.
      return { value, upstreamIds: [number], counts: { total: value.total, returned: value.returned }, truncated: !value.complete };
    }
    if (tool === TOOL_ISSUE_RELATIONS) {
      const { number } = args as z.infer<typeof IssueRelationsArgs>;
      const value = await fetchIssueRelationsResponse(deps.forge, number, deps.caps);
      // #234 F6: same rationale as issue_comments above — the related nodes' own numbers ARE
      // recorded (upstreamIds), but relations carries no per-node updatedAt from the GraphQL
      // shape this tool already fetches.
      return {
        value,
        upstreamIds: [number, ...value.linkedPRs.map((p) => p.number), ...value.crossReferences.map((c) => c.number)],
        counts: { linkedPRs: value.linkedPRs.length, crossReferences: value.crossReferences.length },
        truncated: value.truncated,
      };
    }
    if (tool === TOOL_SEARCH_ISSUES) {
      const { query } = args as z.infer<typeof SearchIssuesArgs>;
      const value = await fetchSearchIssuesResponse(deps.forge, query, deps.caps);
      // #234 F6: every matched issue's number, plus the most recent updatedAt among the matches
      // (same batch-audit rationale as issue_details above) — `gh search issues` already returns
      // updatedAt per result, so this costs nothing extra to thread through. Omitted (never
      // explicit undefined, exactOptionalPropertyTypes) when a search legitimately returns zero
      // matches.
      const searchUpdatedAt = maxUpdatedAt(value.results.map((r) => r.updatedAt));
      return {
        value,
        upstreamIds: value.results.map((r) => r.number),
        ...(searchUpdatedAt !== undefined ? { upstreamUpdatedAt: searchUpdatedAt } : {}),
        counts: { returned: value.results.length },
        truncated: value.truncated,
      };
    }
    if (tool === TOOL_PR_DETAILS) {
      const { pr } = args as z.infer<typeof PRDetailsArgs>;
      const value = await fetchPRDetailsResponse(deps.forge, pr);
      // #244: a fixed-field single-PR read (no batching, no cap) — no updatedAt/truncation
      // signal to report, same stance as issue_relations/issue_comments' no-updatedAt case.
      return { value, upstreamIds: [pr] };
    }
    if (tool === TOOL_PR_REVIEWS) {
      const { pr } = args as z.infer<typeof PRReviewsArgs>;
      const value = await fetchPRReviewsResponse(deps.forge, pr, deps.caps);
      // #244 (Codex sol-high PR #260 review, P1): same completeness-drives-truncation contract
      // as issue_comments/pr_review_threads — a capped `reviews(last: cap)` fetch can be
      // incomplete even with no client-supplied lastN to reject.
      return { value, upstreamIds: [pr], counts: { total: value.total, returned: value.returned }, truncated: !value.complete };
    }
    if (tool === TOOL_PR_REVIEW_THREADS) {
      const { pr, lastN } = args as z.infer<typeof PRReviewThreadsArgs>;
      const value = await fetchPRReviewThreadsResponse(deps.forge, pr, lastN, deps.caps);
      // #244: same completeness-drives-truncation contract as issue_comments above. truncated
      // also fires on pageCapped (the underlying fetch's own 50-page safety ceiling), which
      // capThreads/fetchPRReviewThreadsResponse already folds into `complete`.
      return { value, upstreamIds: [pr], counts: { total: value.total, returned: value.returned }, truncated: !value.complete };
    }
    // TOOL_PR_CHECKS — the eighth and last fixed-algebra member (validateToolArgs already
    // rejected anything else as unknown_tool).
    const { pr } = args as z.infer<typeof PRChecksArgs>;
    const value = await fetchPRChecksResponse(deps.forge, pr, deps.caps);
    // #244 (Codex sol-high PR #260 review, P1): same completeness contract as pr_reviews above.
    return { value, upstreamIds: [pr], counts: { total: value.total, returned: value.returned }, truncated: !value.complete };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("forge proxy server: failed to bind an ephemeral 127.0.0.1 port");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;

  return {
    port,
    token,
    url,
    mcpConfigJson: buildMcpConfigJson(url, token),
    // #244: scoped to deps.allowedTools when supplied (proxy/access.ts's role x tool matrix) —
    // the CLI's own `--allowedTools` widening never offers a role-denied tool as callable in the
    // first place, consistent with (but not a substitute for) the server-side enforcement above.
    toolNames: (deps.allowedTools ?? TOOL_NAMES).map(mcpToolFullName),
    stop: async () => {
      if (revoked) return; // idempotent
      revoked = true; // any in-flight/late request 401s from here, before the socket even closes
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** The `--mcp-config` inline JSON for a streamable-HTTP MCP server, bearer-authenticated —
 *  verified shape against a live `claude` CLI's `--mcp-config`/`--strict-mcp-config` help text
 *  (2026-07-17); exported for worker.ts/peripheral.ts callers and direct testing. */
export function buildMcpConfigJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [FORGE_MCP_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

function toolResultError(error: ProxyToolError): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** #234 F7: constant-time comparison of the request's `Authorization` header against the
 *  expected `Bearer <token>` value. `timingSafeEqual` THROWS on a length mismatch rather than
 *  returning false, so lengths are compared first (a length mismatch is itself a legitimate,
 *  cheap "reject" — it leaks only the LENGTH of a wrong guess, not which bytes matched, and the
 *  real 32-byte-random token space makes a length-only guess useless). `header` may be undefined
 *  (no Authorization header sent at all) — degrades to a clean reject, never a throw. */
function safeEqualToken(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const actual = Buffer.from(header ?? "", "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** #234 F6: the most recent (lexicographically greatest — valid for same-format ISO 8601
 *  timestamps, which is all IForge ever returns) of a batch call's per-entity `updatedAt`
 *  values, for the journal's `upstream_updated_at` audit column. undefined for an empty batch
 *  (never a fabricated placeholder). */
function maxUpdatedAt(dates: string[]): string | undefined {
  return dates.length === 0 ? undefined : dates.reduce((max, d) => (d > max ? d : max));
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProxyTimeoutError(`tool call timed out after ${timeoutMs}ms`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
