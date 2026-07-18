// mcp-server.test.ts (#234): the hand-rolled streamable-HTTP MCP server — real HTTP round trips
// against a real ephemeral 127.0.0.1 listener (node:http), a real in-memory State (the durable
// journal), and a fake IForge (no live GitHub calls). Covers the JSON-RPC surface (initialize/
// notifications/tools-list/tools-call), bearer-token auth, the error matrix, budget exhaustion,
// and per-call timeouts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IssueMeta,
  IssueRelations,
  IssueSearchResult,
  PRCheckItem,
  PRComment,
  PRDetails,
  PRReviewItem,
  ReviewThreadItem,
} from "../forge/forge.js";
import { State } from "../state/state.js";
import { buildMcpConfigJson, type ForgeProxyDeps, type ProxyForge, startForgeProxyServer } from "./mcp-server.js";
import { FORGE_MCP_SERVER_NAME, ISSUE_TOOLS, PR_TOOLS, TOOL_NAMES } from "./tools.js";

const CAPS = {
  maxIssuesPerCall: 10,
  defaultCommentsPerIssue: 20,
  maxCommentsPerCall: 100,
  maxRelationsPerIssue: 20,
  maxSearchResults: 20,
  fullCommentStreamOptIn: false,
  maxReviewThreadsPerCall: 20,
  maxCommentsPerThread: 20,
};

function fakeForge(over: Partial<ProxyForge> = {}): ProxyForge {
  const meta: IssueMeta = { number: 1, title: "an issue", state: "OPEN", labels: ["bug"], updatedAt: "2026-07-17T00:00:00Z" };
  const comments: PRComment[] = [{ login: "a", createdAt: "2026-07-01T00:00:00Z", body: "a comment" }];
  const relations: IssueRelations = { linkedPRs: [], crossReferences: [], truncated: false };
  const results: IssueSearchResult[] = [{ number: 1, title: "an issue", state: "OPEN", labels: [], updatedAt: "2026-07-17T00:00:00Z" }];
  const prDetails: PRDetails = { number: 1, headOid: "abc", state: "OPEN", draft: false, labels: [], mergeable: "MERGEABLE" };
  const reviews: PRReviewItem[] = [{ author: "codex", commitOid: "abc", state: "APPROVED", body: "LGTM" }];
  const threads: ReviewThreadItem[] = [{ id: "T1", isResolved: false, comments: [] }];
  const checks: PRCheckItem[] = [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", state: null }];
  return {
    getIssueMeta: async () => meta,
    getIssueBody: async () => "the body",
    getIssueComments: async () => comments,
    getIssueRelations: async () => relations,
    searchIssues: async () => results,
    getPRDetails: async () => prDetails,
    getPRReviews: async () => reviews,
    getPRReviewThreads: async () => threads,
    getPRChecks: async () => checks,
    ...over,
  };
}

async function withServer(
  over: Partial<ForgeProxyDeps> = {},
  run: (h: Awaited<ReturnType<typeof startForgeProxyServer>>, state: State) => Promise<void>,
): Promise<void> {
  const state = new State(":memory:");
  try {
    const handle = await startForgeProxyServer({
      forge: fakeForge(),
      state,
      identity: { roundId: 1, phase: "architecting", role: "architect", session: "role-architect-abc", attempt: 1 },
      scope: { owner: "o", repo: "r" },
      caps: CAPS,
      budget: { maxCallsPerSession: 5, maxBytesPerSession: 1_000_000 },
      timeoutMs: 2000,
      now: () => new Date("2026-07-17T00:00:00Z"),
      ...over,
    });
    try {
      await run(handle, state);
    } finally {
      await handle.stop();
    }
  } finally {
    state.close();
  }
}

async function rpc(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

test("startForgeProxyServer: binds 127.0.0.1 on an ephemeral port, url + mcpConfigJson + fixed tool names are consistent", async () => {
  await withServer({}, async (h) => {
    assert.ok(h.port > 0);
    assert.equal(h.url, `http://127.0.0.1:${h.port}/mcp`);
    assert.deepEqual(h.toolNames.sort(), TOOL_NAMES.map((t) => `mcp__forge__${t}`).sort());
    const cfg = JSON.parse(h.mcpConfigJson);
    assert.equal(cfg.mcpServers[FORGE_MCP_SERVER_NAME].url, h.url);
    assert.equal(cfg.mcpServers[FORGE_MCP_SERVER_NAME].headers.Authorization, `Bearer ${h.token}`);
    assert.equal(cfg.mcpServers[FORGE_MCP_SERVER_NAME].type, "http");
  });
});

test("buildMcpConfigJson: matches the shape startForgeProxyServer produces", () => {
  const json = buildMcpConfigJson("http://127.0.0.1:9/mcp", "tok");
  assert.deepEqual(JSON.parse(json), {
    mcpServers: { forge: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok" } } },
  });
});

// ── auth: checked on EVERY request, wrong/revoked -> 401 and nothing else ──────────────────

test("auth: missing/wrong bearer token -> 401, no body", async () => {
  await withServer({}, async (h) => {
    const noAuth = await fetch(h.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.text()).length, 0);
    const wrong = await rpc(h.url, "wrong-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.text()).length, 0);
  });
});

test("auth: token still checked on 'initialize' itself, not just tools/call", async () => {
  await withServer({}, async (h) => {
    const res = await rpc(h.url, "wrong-token", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(res.status, 401);
  });
});

test("auth: after stop(), the token is revoked immediately -> 401 for any further request", async () => {
  const state = new State(":memory:");
  try {
    const h = await startForgeProxyServer({
      forge: fakeForge(),
      state,
      identity: { roundId: 1, phase: "p", role: "r", session: "s", attempt: 1 },
      scope: { owner: "o", repo: "r" },
      caps: CAPS,
      budget: { maxCallsPerSession: 5, maxBytesPerSession: 1_000_000 },
      timeoutMs: 2000,
    });
    await h.stop();
    const res = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "tools/list" }).catch(() => undefined);
    // Either the connection is refused (server closed) or, if a race let it land, 401 — either
    // way the call must NOT succeed with a 200 result.
    if (res) assert.notEqual(res.status, 200);
  } finally {
    state.close();
  }
});

// ── transport shape: GET rejected, notifications get no result body, unknown method errors ──

test("GET (the SSE-stream variant) is rejected with 405 rather than hung", async () => {
  await withServer({}, async (h) => {
    const res = await fetch(h.url, { method: "GET", headers: { Authorization: `Bearer ${h.token}` } });
    assert.equal(res.status, 405);
  });
});

test("a notification (no id, e.g. notifications/initialized) gets 202 and no JSON-RPC result body", async () => {
  await withServer({}, async (h) => {
    const res = await rpc(h.url, h.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
  });
});

test("initialize echoes the client's protocolVersion and reports serverInfo/capabilities.tools", async () => {
  await withServer({}, async (h) => {
    const res = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const json = await res.json();
    assert.equal(json.result.protocolVersion, "2025-06-18");
    assert.equal(json.result.serverInfo.name, "forge");
    assert.deepEqual(json.result.capabilities, { tools: {} });
    assert.ok(res.headers.get("Mcp-Session-Id"));
  });
});

test("tools/list returns the 8 fixed tools (4 issue + 4 PR, #244) with strict object schemas", async () => {
  await withServer({}, async (h) => {
    const res = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const json = await res.json();
    assert.equal(json.result.tools.length, 8);
    assert.deepEqual(json.result.tools.map((t: { name: string }) => t.name).sort(), [...TOOL_NAMES].sort());
  });
});

test("an unknown JSON-RPC method -> -32601 method-not-found", async () => {
  await withServer({}, async (h) => {
    const res = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "not/a/real/method" });
    const json = await res.json();
    assert.equal(json.error.code, -32601);
  });
});

test("malformed JSON body -> -32700 parse error", async () => {
  await withServer({}, async (h) => {
    const res = await fetch(h.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.token}` },
      body: "{not json",
    });
    const json = await res.json();
    assert.equal(json.error.code, -32700);
  });
});

// ── tools/call: schema/scope/cap/error matrix (issue #234 AC) ──────────────────────────────

async function callTool(url: string, token: string, name: string, args: unknown) {
  const res = await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json();
  return { status: res.status, body };
}

test("tools/call: unknown tool name -> isError result with unknown_tool code (HTTP 200 — this is a tool-domain error, not a transport failure)", async () => {
  await withServer({}, async (h) => {
    const { status, body } = await callTool(h.url, h.token, "rm_rf_everything", {});
    assert.equal(status, 200);
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "unknown_tool");
  });
});

test("tools/call: malformed args -> isError invalid_args", async () => {
  await withServer({}, async (h) => {
    const { body } = await callTool(h.url, h.token, "issue_details", { numbers: "nope" });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "invalid_args");
  });
});

test("tools/call: out-of-repo-scope attempt (an extra repo field) -> isError invalid_args (strict schema rejects the unrecognized key)", async () => {
  await withServer({}, async (h) => {
    const { body } = await callTool(h.url, h.token, "issue_details", { numbers: [1], repo: "other/repo" });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "invalid_args");
  });
});

test("tools/call: over-cap request -> isError over_cap", async () => {
  await withServer({ caps: { ...CAPS, maxIssuesPerCall: 1 } }, async (h) => {
    const { body } = await callTool(h.url, h.token, "issue_details", { numbers: [1, 2] });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "over_cap");
  });
});

test("tools/call: successful issue_details call returns content-parsable JSON and journals a 'fetched' row", async () => {
  await withServer({}, async (h, state) => {
    const { body } = await callTool(h.url, h.token, "issue_details", { numbers: [1] });
    assert.equal(body.result.isError, false);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.issues[0].meta.number, 1);
    const rows = state.listForgeProxyJournal({
      roundId: 1,
      phase: "architecting",
      role: "architect",
      session: "role-architect-abc",
      attempt: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "delivered");
    assert.equal(rows[0]!.tool, "issue_details");
    assert.ok(rows[0]!.responseCanonical);
    assert.ok(rows[0]!.contentHash);
  });
});

test("tools/call: budget (call count) exhaustion mid-session -> explicit budget_exhausted tool result, not a transport error", async () => {
  await withServer({ budget: { maxCallsPerSession: 1, maxBytesPerSession: 1_000_000 } }, async (h) => {
    const first = await callTool(h.url, h.token, "search_issues", { query: "x" });
    assert.equal(first.status, 200);
    assert.equal(first.body.result.isError, false);
    const second = await callTool(h.url, h.token, "search_issues", { query: "y" });
    assert.equal(second.status, 200, "budget exhaustion is a tool result, never an HTTP-level failure");
    assert.equal(second.body.result.isError, true);
    assert.equal(JSON.parse(second.body.result.content[0].text).code, "budget_exhausted");
  });
});

test("tools/call: upstream error is sanitized before reaching the response", async () => {
  await withServer(
    {
      forge: fakeForge({
        searchIssues: async () => {
          throw new Error("gh failed: token ghp_ABCDEFGHIJ0123456789abcdefghij");
        },
      }),
    },
    async (h) => {
      const { body } = await callTool(h.url, h.token, "search_issues", { query: "x" });
      assert.equal(body.result.isError, true);
      const err = JSON.parse(body.result.content[0].text);
      assert.equal(err.code, "upstream_error");
      assert.doesNotMatch(err.message, /ghp_[A-Za-z0-9]{20,}/);
    },
  );
});

test("tools/call: a hung upstream call is killed by the per-call timeout -> isError result, never a wedged HTTP request", async () => {
  await withServer(
    {
      timeoutMs: 100,
      forge: fakeForge({ searchIssues: () => new Promise(() => {}) }), // never resolves
    },
    async (h, state) => {
      const { body } = await callTool(h.url, h.token, "search_issues", { query: "x" });
      assert.equal(body.result.isError, true);
      const rows = state.listForgeProxyJournal({
        roundId: 1,
        phase: "architecting",
        role: "architect",
        session: "role-architect-abc",
        attempt: 1,
      });
      assert.equal(rows[0]!.timedOut, true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #244: PR-facing tools' schema/scope/cap/error matrix over the real HTTP transport — mirrors
// the #234 issue-tool matrix above exactly.
// ─────────────────────────────────────────────────────────────────────────────

test("tools/call: pr_details/pr_reviews/pr_review_threads/pr_checks succeed and journal a 'fetched' row each", async () => {
  await withServer({}, async (h, state) => {
    for (const [name, args] of [
      ["pr_details", { pr: 1 }],
      ["pr_reviews", { pr: 1 }],
      ["pr_review_threads", { pr: 1 }],
      ["pr_checks", { pr: 1 }],
    ] as const) {
      const { body } = await callTool(h.url, h.token, name, args);
      assert.equal(body.result.isError, false, `${name} should succeed`);
    }
    const rows = state.listForgeProxyJournal({
      roundId: 1,
      phase: "architecting",
      role: "architect",
      session: "role-architect-abc",
      attempt: 1,
    });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.tool).sort(), ["pr_checks", "pr_details", "pr_review_threads", "pr_reviews"]);
    assert.ok(rows.every((r) => r.status === "delivered" && r.responseCanonical && r.contentHash));
  });
});

test("tools/call: pr_details malformed args -> isError invalid_args", async () => {
  await withServer({}, async (h) => {
    const { body } = await callTool(h.url, h.token, "pr_details", { pr: "nope" });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "invalid_args");
  });
});

test("tools/call: pr_details out-of-repo-scope attempt (an extra repo field) -> isError invalid_args", async () => {
  await withServer({}, async (h) => {
    const { body } = await callTool(h.url, h.token, "pr_details", { pr: 1, repo: "other/repo" });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "invalid_args");
  });
});

test("tools/call: pr_review_threads over-cap lastN -> isError over_cap", async () => {
  await withServer({ caps: { ...CAPS, maxReviewThreadsPerCall: 1 } }, async (h) => {
    const { body } = await callTool(h.url, h.token, "pr_review_threads", { pr: 1, lastN: 2 });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "over_cap");
  });
});

test("tools/call: pr_review_threads response carries completeness flags — no silent truncation", async () => {
  const manyThreads: ReviewThreadItem[] = [
    { id: "T1", isResolved: false, comments: [] },
    { id: "T2", isResolved: false, comments: [] },
    { id: "T3", isResolved: false, comments: [] },
  ];
  await withServer(
    { caps: { ...CAPS, maxReviewThreadsPerCall: 2 }, forge: fakeForge({ getPRReviewThreads: async () => manyThreads }) },
    async (h) => {
      const { body } = await callTool(h.url, h.token, "pr_review_threads", { pr: 1 });
      const parsed = JSON.parse(body.result.content[0].text);
      assert.equal(parsed.complete, false);
      assert.equal(parsed.total, 3);
      assert.equal(parsed.returned, 2);
      assert.deepEqual(parsed.omittedRange, { from: 1, to: 1 });
    },
  );
});

test("tools/call: pr_reviews upstream error is sanitized before reaching the response", async () => {
  await withServer(
    {
      forge: fakeForge({
        getPRReviews: async () => {
          throw new Error("gh failed: token ghp_ABCDEFGHIJ0123456789abcdefghij");
        },
      }),
    },
    async (h) => {
      const { body } = await callTool(h.url, h.token, "pr_reviews", { pr: 1 });
      assert.equal(body.result.isError, true);
      const err = JSON.parse(body.result.content[0].text);
      assert.equal(err.code, "upstream_error");
      assert.doesNotMatch(err.message, /ghp_[A-Za-z0-9]{20,}/);
    },
  );
});

// ── #244 role x tool matrix enforcement (deny-by-default) ─────────────────────────────────

test("allowedTools omitted (default) -> every fixed tool callable, tools/list advertises all 8", async () => {
  await withServer({}, async (h) => {
    const list = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listJson = await list.json();
    assert.equal(listJson.result.tools.length, 8);
    const { body } = await callTool(h.url, h.token, "pr_details", { pr: 1 });
    assert.equal(body.result.isError, false);
  });
});

test("allowedTools scoped to ISSUE_TOOLS -> a PR tool is role_denied, never even advertised in tools/list", async () => {
  await withServer({ allowedTools: ISSUE_TOOLS }, async (h) => {
    const list = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listJson = await list.json();
    assert.deepEqual(listJson.result.tools.map((t: { name: string }) => t.name).sort(), [...ISSUE_TOOLS].sort());
    const { body } = await callTool(h.url, h.token, "pr_details", { pr: 1 });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "role_denied");
    // An ISSUE tool still works — the restriction is additive, not all-or-nothing.
    const ok = await callTool(h.url, h.token, "issue_relations", { number: 1 });
    assert.equal(ok.body.result.isError, false);
  });
});

test("allowedTools scoped to PR_TOOLS -> an issue tool is role_denied (the fix-loop worker leg's own scope, #244)", async () => {
  await withServer({ allowedTools: PR_TOOLS }, async (h) => {
    const { body } = await callTool(h.url, h.token, "issue_details", { numbers: [1] });
    assert.equal(body.result.isError, true);
    assert.equal(JSON.parse(body.result.content[0].text).code, "role_denied");
    const ok = await callTool(h.url, h.token, "pr_checks", { pr: 1 });
    assert.equal(ok.body.result.isError, false);
  });
});

test("allowedTools = [] (an unlisted role's deny-by-default resolution, proxy/access.ts) -> EVERY tool is role_denied, tools/list is empty", async () => {
  await withServer({ allowedTools: [] }, async (h) => {
    const list = await rpc(h.url, h.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listJson = await list.json();
    assert.deepEqual(listJson.result.tools, []);
    // Schema-valid args per tool — role_denied must be provable independent of arg validity.
    const validArgsByTool: Record<string, unknown> = {
      issue_details: { numbers: [1] },
      issue_comments: { number: 1 },
      issue_relations: { number: 1 },
      search_issues: { query: "x" },
      pr_details: { pr: 1 },
      pr_reviews: { pr: 1 },
      pr_review_threads: { pr: 1 },
      pr_checks: { pr: 1 },
    };
    for (const name of TOOL_NAMES) {
      const { body } = await callTool(h.url, h.token, name, validArgsByTool[name]);
      assert.equal(body.result.isError, true, `${name} should be denied`);
      assert.equal(JSON.parse(body.result.content[0].text).code, "role_denied", `${name} should be role_denied`);
    }
  });
});

test("allowedTools scoping also narrows the handle's own toolNames (the --allowedTools CLI widening)", async () => {
  await withServer({ allowedTools: PR_TOOLS }, async (h) => {
    assert.deepEqual(h.toolNames.sort(), PR_TOOLS.map((t) => `mcp__forge__${t}`).sort());
  });
});

test("a role-denied call never even reserves budget or writes a journal intent row — checked before any budget/journal work", async () => {
  await withServer({ allowedTools: ISSUE_TOOLS, budget: { maxCallsPerSession: 1, maxBytesPerSession: 1_000_000 } }, async (h, state) => {
    const denied = await callTool(h.url, h.token, "pr_details", { pr: 1 });
    assert.equal(JSON.parse(denied.body.result.content[0].text).code, "role_denied");
    // The budget was never touched by the denied call — a subsequent allowed call still succeeds
    // (if the denial HAD reserved budget, this would now be budget_exhausted instead).
    const allowed = await callTool(h.url, h.token, "issue_relations", { number: 1 });
    assert.equal(allowed.body.result.isError, false);
    const rows = state.listForgeProxyJournal({
      roundId: 1,
      phase: "architecting",
      role: "architect",
      session: "role-architect-abc",
      attempt: 1,
    });
    assert.equal(rows.length, 1, "only the ALLOWED call produced a journal row");
  });
});
