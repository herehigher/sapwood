// proxy/mcp-server.ts — #234: a hand-rolled, MINIMAL streamable-HTTP MCP server. ZERO new npm
// dependencies (repo culture: runtime deps are yaml+zod only) — built entirely on node:http,
// node:crypto. Binds 127.0.0.1 on an ephemeral port (`listen(0, "127.0.0.1")`); implements just
// the JSON-RPC 2.0 methods the Claude Code CLI's MCP client needs: `initialize`,
// `notifications/initialized`, `tools/list`, `tools/call`. Responds `application/json` only — a
// GET (the streamable-HTTP SSE stream variant) is rejected with 405 rather than implemented
// (issue #234's transport direction: "simple POST request/response is sufficient").
//
// SECURITY: a random bearer token is minted per session (startForgeProxyServer's caller mints one
// server per role session), checked on EVERY request (including `initialize`), revoked at
// teardown (`stop()` flips a flag BEFORE closing the socket, so a request racing the shutdown
// still sees 401, never a late-arriving success) — wrong/revoked -> 401 and NOTHING else (no
// body, no error detail: an attacker probing the port learns nothing). The repository is
// FORCIBLY scoped server-side (`deps.scope`, `deps.forge` — both engine-config-derived, never
// request-controlled): no tool argument schema anywhere in proxy/tools.ts accepts an owner/repo
// field, so there is no argument shape that could even ASK for a different repo.
//
// HARD INVARIANT (worker.test.ts's #69 grep-invariant test, engine-wide): no node:child_process
// import, no subprocess call, anywhere in this module — only worker.ts (spawn) and forge/gh.ts
// (execFile) may shell out. This server never does.
import { randomBytes } from "node:crypto";
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
  fetchSearchIssuesResponse,
  type IssueCommentsArgs,
  type IssueDetailsArgs,
  type IssueRelationsArgs,
  mcpToolFullName,
  PROXY_VERSION,
  type ProxyCaps,
  type ProxyToolError,
  type SearchIssuesArgs,
  sanitizeUpstreamError,
  TOOL_DEFINITIONS,
  TOOL_ISSUE_COMMENTS,
  TOOL_ISSUE_DETAILS,
  TOOL_ISSUE_RELATIONS,
  TOOL_NAMES,
  type ToolName,
  validateToolArgs,
} from "./tools.js";

export type ProxyForge = Pick<IForge, "getIssueMeta" | "getIssueBody" | "getIssueComments" | "getIssueRelations" | "searchIssues">;

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
  /** `mcp__forge__<tool>` for every fixed tool — the `--allowedTools` entries a session needs. */
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
      log(`[sapwood:forge-proxy] unhandled request error (non-fatal): ${String(e)}`);
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
    // 401 and NOTHING else (issue #234's Custody & scope).
    if (revoked || req.headers.authorization !== `Bearer ${token}`) {
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
      case "tools/list":
        return { tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
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
      return {
        value: { issues: views },
        upstreamIds: numbers,
        counts: { requested: numbers.length, returned: views.length },
        truncated: views.some((v) => !v.comments.complete || v.relations.truncated),
      };
    }
    if (tool === TOOL_ISSUE_COMMENTS) {
      const { number, lastN } = args as z.infer<typeof IssueCommentsArgs>;
      const value = await fetchIssueCommentsResponse(deps.forge, number, lastN, deps.caps);
      return { value, upstreamIds: [number], counts: { total: value.total, returned: value.returned }, truncated: !value.complete };
    }
    if (tool === TOOL_ISSUE_RELATIONS) {
      const { number } = args as z.infer<typeof IssueRelationsArgs>;
      const value = await fetchIssueRelationsResponse(deps.forge, number, deps.caps);
      return {
        value,
        upstreamIds: [number],
        counts: { linkedPRs: value.linkedPRs.length, crossReferences: value.crossReferences.length },
        truncated: value.truncated,
      };
    }
    // TOOL_SEARCH_ISSUES — the fourth and last fixed-algebra member (validateToolArgs already
    // rejected anything else as unknown_tool).
    const { query } = args as z.infer<typeof SearchIssuesArgs>;
    const value = await fetchSearchIssuesResponse(deps.forge, query, deps.caps);
    return { value, counts: { returned: value.results.length }, truncated: value.truncated };
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
    toolNames: TOOL_NAMES.map(mcpToolFullName),
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
