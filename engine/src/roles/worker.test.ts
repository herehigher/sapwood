import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { estimateUsd, loadPricingTable } from "../config/pricing.js";
import { classifyEnvFailure, DEFAULT_FORGE_FAILURE_PATTERNS, DEFAULT_LLM_FAILURE_PATTERNS } from "../loop/env-failure.js";
import { mcpToolFullName, PR_TOOLS } from "../proxy/tools.js";
import { State } from "../state/state.js";
import {
  buildRenderFixPrompt,
  buildRenderPrompt,
  classifyEgressTarget,
  claudeArgs,
  defaultFixPromptPath,
  defaultPromptPath,
  deployKeyTransportOverlay,
  discoverClaudeBin,
  EMPTY_MCP_CONFIG_JSON,
  extractFailureText,
  extractRateLimitResetAt,
  guardSettings,
  hasQuotaErrorStatus,
  hasRejectedRateLimitEvent,
  loadFixPromptTemplate,
  loadWorkerPromptTemplate,
  MAX_EGRESS_SUSPECTS_PER_LEG,
  MAX_INCONCLUSIVE_PR_PROBES,
  parseAssistantUsageDeltas,
  parseCostUsd,
  parseCostUsdOrNull,
  parseModelUsage,
  parseResultText,
  parseSessionInit,
  parseToolUsage,
  probeDeployKeySsh,
  probeLlmPing,
  type ReapableChild,
  type ReapOutcome,
  reapChildren,
  renderPromptTemplate,
  resolveWorktreeHead,
  scanEgressSuspects,
  shellSingleQuote,
  spawnClaudeSession,
  spawnSshKeygen,
  WORKER_ALLOWED_TOOLS_NO_GH,
  WORKER_DISALLOWED_TOOLS,
  type WorkerDeps,
  WorkerSupervisor,
  workerCredentialFreeEnv,
  workerDeployKeyEnv,
} from "./worker.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

test("WorkerSupervisor: default guard hook resolves the compiled hook in the guard directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const supervisor = new WorkerSupervisor({ now: realClock, cfg, stateDir: dir, claudeBin: "claude" });
    const guardHookPath = (supervisor as unknown as { guardHookPath: string }).guardHookPath;
    assert.equal(guardHookPath, fileURLToPath(new URL("../guard/guard-hook.js", import.meta.url)));
    supervisor.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCostUsd: takes the last result line's total_cost_usd", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    `{"type":"assistant","message":{}}`,
    `{"type":"result","subtype":"success","total_cost_usd":0.0123,"usage":{}}`,
  ].join("\n");
  assert.equal(parseCostUsd(jsonl), 0.0123);
});

test("parseCostUsd: multiple results -> last wins; none -> 0; junk lines ignored", () => {
  assert.equal(parseCostUsd(`{"type":"result","total_cost_usd":0.1}\n{"type":"result","total_cost_usd":0.5}`), 0.5);
  assert.equal(parseCostUsd(`no json here\n{"type":"assistant"}`), 0);
  assert.equal(parseCostUsd(""), 0);
  assert.equal(parseCostUsd(`garbage{{{\n{"type":"result","total_cost_usd":0.2}`), 0.2);
});

test("parseCostUsdOrNull (#302 review Codex P1): null when NO cost record exists, distinct from a REAL recorded $0", () => {
  assert.equal(parseCostUsdOrNull(""), null);
  assert.equal(parseCostUsdOrNull(`no json here\n{"type":"assistant"}`), null);
  assert.equal(parseCostUsdOrNull(`{"type":"result"}`), null); // result line but no cost field
  assert.equal(parseCostUsdOrNull(`{"type":"result","total_cost_usd":0}`), 0); // honest zero
  assert.equal(parseCostUsdOrNull(`{"type":"result","total_cost_usd":0.5}`), 0.5);
});

const bashToolUseLine = (command: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

test("scanEgressSuspects (#304): detects configured executables, absolute paths, env/assignment prefixes, and later fragments", () => {
  const jsonl = [
    bashToolUseLine("curl https://example.invalid/a"),
    bashToolUseLine("/usr/bin/wget https://example.invalid/b"),
    bashToolUseLine("TOKEN=x env MODE=test /opt/bin/nc example.invalid 443"),
    bashToolUseLine("git status && sudo -n /usr/local/bin/scp artifact host:/tmp/artifact"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, ["curl", "wget", "nc", "scp"]), {
    hits: [
      { executable: "curl", snippet: "curl https://example.invalid/a" },
      { executable: "wget", snippet: "/usr/bin/wget https://example.invalid/b" },
      { executable: "nc", snippet: "TOKEN=x env MODE=test /opt/bin/nc example.invalid 443" },
      { executable: "scp", snippet: "sudo -n /usr/local/bin/scp artifact host:/tmp/artifact" },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#304): governed git/gh/package-manager flows and suspect names in arguments are non-hits", () => {
  const jsonl = [
    bashToolUseLine("git push origin HEAD"),
    bashToolUseLine("gh pr view 304"),
    bashToolUseLine("npm install"),
    bashToolUseLine("printf '%s' curl"),
    bashToolUseLine("echo https://example.invalid/wget"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, ["curl", "wget"]), { hits: [], truncated: false });
});

test("scanEgressSuspects (#304): deduplicates executable+snippet and caps snippets at 200 characters", () => {
  const longCommand = `curl https://example.invalid/${"x".repeat(240)}`;
  const jsonl = [bashToolUseLine("curl same"), bashToolUseLine("curl same"), bashToolUseLine(longCommand)].join("\n");
  const { hits, truncated } = scanEgressSuspects(jsonl, ["curl"]);
  assert.equal(hits.length, 2);
  assert.equal(truncated, false);
  assert.deepEqual(hits[0], { executable: "curl", snippet: "curl same" });
  assert.equal(hits[1]?.executable, "curl");
  assert.equal(hits[1]?.snippet.length, 200);
  assert.equal(hits[1]?.snippet, longCommand.slice(0, 200));
});

test("scanEgressSuspects (#304): malformed jsonl, malformed tool blocks, and empty input are skipped silently", () => {
  const jsonl = [
    "garbage{{{",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: null }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { command: "curl x" } }] } }),
    bashToolUseLine("curl https://example.invalid"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, ["curl"]), {
    hits: [{ executable: "curl", snippet: "curl https://example.invalid" }],
    truncated: false,
  });
  assert.deepEqual(scanEgressSuspects("", ["curl"]), { hits: [], truncated: false });
});

test("scanEgressSuspects (#341): heredoc and here-string bodies are data, never commands", () => {
  assert.deepEqual(
    scanEgressSuspects(
      [
        bashToolUseLine("cat > x.sh <<'EOF'\ncurl https://example.invalid/body\nEOF"),
        bashToolUseLine("cat <<< 'curl https://example.invalid/here-string'\ncurl https://example.invalid/skipped"),
      ].join("\n"),
      ["curl"],
    ),
    { hits: [], truncated: false },
  );
});

test("scanEgressSuspects (#341): a genuine suspect after a heredoc-free semicolon still hits", () => {
  assert.deepEqual(scanEgressSuspects(bashToolUseLine("printf ready; curl https://example.invalid/real"), ["curl"]), {
    hits: [{ executable: "curl", snippet: "curl https://example.invalid/real" }],
    truncated: false,
  });
});

test("scanEgressSuspects (#341): sudo/env arg-taking options cannot shift option arguments into executable position", () => {
  const jsonl = [
    bashToolUseLine("sudo --user ftp apt-get update"),
    bashToolUseLine("sudo -u ftp curl x"),
    bashToolUseLine("sudo --user=ftp curl y"),
    bashToolUseLine("env --unset=TOKEN curl z"),
    bashToolUseLine("env -S 'curl split'"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, ["curl", "ftp"]), {
    hits: [
      { executable: "curl", snippet: "sudo -u ftp curl x" },
      { executable: "curl", snippet: "sudo --user=ftp curl y" },
      { executable: "curl", snippet: "env --unset=TOKEN curl z" },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#341): per-leg evidence stops at the engine cap", () => {
  const jsonl = Array.from({ length: MAX_EGRESS_SUSPECTS_PER_LEG + 5 }, (_, i) =>
    bashToolUseLine(`curl https://example.invalid/${i}`),
  ).join("\n");
  const scan = scanEgressSuspects(jsonl, ["curl"]);
  assert.equal(scan.hits.length, MAX_EGRESS_SUSPECTS_PER_LEG);
  assert.equal(scan.truncated, true);
  assert.deepEqual(scan.hits.at(-1), {
    executable: "curl",
    snippet: `curl https://example.invalid/${MAX_EGRESS_SUSPECTS_PER_LEG - 1}`,
  });
});

// ── #410: the SAME scanner also recognizes WebFetch/WebSearch tool_use blocks (peripheral role
// sessions granted the #410 web-access tools) — unconditionally, not gated by the
// suspectCommands list Bash detection above uses; these two tool names ARE the whole peripheral-
// egress channel. No second scanner: this is scanEgressSuspects itself, extended. ──────────────

const webToolUseLine = (name: "WebFetch" | "WebSearch", detail: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: name === "WebFetch" ? { url: detail } : { query: detail } }] },
  });

test("scanEgressSuspects (#410): WebFetch/WebSearch tool_use blocks hit UNCONDITIONALLY — an EMPTY suspectCommands list (Bash detection fully disabled) still catches both", () => {
  const jsonl = [
    webToolUseLine("WebFetch", "https://example.invalid/docs"),
    webToolUseLine("WebSearch", "does a mature library already cover this"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, []), {
    hits: [
      { executable: "WebFetch", snippet: "https://example.invalid/docs" },
      { executable: "WebSearch", snippet: "does a mature library already cover this" },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#410): Bash and WebFetch/WebSearch hits share ONE dedup set and ONE per-session cap — a mixed transcript is bounded together, not one cap each", () => {
  const jsonl = [bashToolUseLine("curl https://example.invalid/a"), webToolUseLine("WebFetch", "https://example.invalid/b")].join("\n");
  const { hits, truncated } = scanEgressSuspects(jsonl, ["curl"]);
  assert.deepEqual(hits, [
    { executable: "curl", snippet: "curl https://example.invalid/a" },
    { executable: "WebFetch", snippet: "https://example.invalid/b" },
  ]);
  assert.equal(truncated, false);
});

test("scanEgressSuspects (#410): a non-string url/query, or a name other than WebFetch/WebSearch/Bash/Agent/Task, is a non-hit — never a throw", () => {
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: 42 } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: {} }] } }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { url: "https://example.invalid" } }] },
    }),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, []), { hits: [], truncated: false });
});

test("scanEgressSuspects (#410): WebFetch/WebSearch snippets are capped at 200 characters, same bound as a Bash snippet", () => {
  const longUrl = `https://example.invalid/${"x".repeat(240)}`;
  const { hits } = scanEgressSuspects(webToolUseLine("WebFetch", longUrl), []);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet.length, 200);
  assert.equal(hits[0]?.snippet, longUrl.slice(0, 200));
});

test("scanEgressSuspects (#410): the per-session cap is shared across a long run of WebFetch/WebSearch calls too, same MAX_EGRESS_SUSPECTS_PER_LEG bound Bash detection uses", () => {
  const jsonl = Array.from({ length: MAX_EGRESS_SUSPECTS_PER_LEG + 5 }, (_, i) => webToolUseLine("WebSearch", `query ${i}`)).join("\n");
  const scan = scanEgressSuspects(jsonl, []);
  assert.equal(scan.hits.length, MAX_EGRESS_SUSPECTS_PER_LEG);
  assert.equal(scan.truncated, true);
});

// ── #534: the SAME scanner also recognizes Agent/Task tool_use blocks — unconditionally, the
// SAME stance and SAME rationale as the WebFetch/WebSearch extension immediately above: a
// peripheral role session's ROLE_DISALLOWED_TOOLS now name-denies subagent spawn, so an
// attempted (or, for an ungated leg, a genuine) spawn is exactly the post-hoc-visible signal
// this scanner exists to surface. No second scanner: this is scanEgressSuspects itself,
// extended again. ──────────────────────────────────────────────────────────────────────────

const agentToolUseLine = (name: "Agent" | "Task", input: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("scanEgressSuspects (#534): Agent/Task tool_use blocks hit UNCONDITIONALLY — an EMPTY suspectCommands list (Bash detection fully disabled) still catches both, snippet prefers `description`", () => {
  const jsonl = [
    agentToolUseLine("Agent", { description: "Check if #485 already shipped", prompt: "run `git log --oneline -5 -- engine/...`" }),
    agentToolUseLine("Task", { description: "Run git log queries on conductor.ts", prompt: "..." }),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, []), {
    hits: [
      { executable: "Agent", snippet: "Check if #485 already shipped" },
      { executable: "Task", snippet: "Run git log queries on conductor.ts" },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#534): a missing `description` falls back to `prompt`; a missing/non-string BOTH is a non-hit, never a throw", () => {
  const jsonl = [
    agentToolUseLine("Agent", { prompt: "no description field here" }),
    agentToolUseLine("Task", { description: 42 }),
    agentToolUseLine("Agent", {}),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, []), {
    hits: [{ executable: "Agent", snippet: "no description field here" }],
    truncated: false,
  });
});

test("scanEgressSuspects (#534): Bash, WebFetch/WebSearch, and Agent/Task hits share ONE dedup set (a duplicate crossing signal families is caught) and ONE per-session cap (reached only by counting hits from all three families together)", () => {
  // Cross-family duplicate: a Bash command that literally invokes a program named "Task"
  // produces the exact SAME (executable, snippet) key as a genuine Agent/Task spawn whose
  // description matches that fragment text verbatim. A dedup structure partitioned by signal
  // family (one Set per family) would never catch this — each family's Set only ever sees
  // entries from its own branch — so this pair must collapse to ONE hit under a truly shared Set.
  const crossFamilyText = "Task --status";
  const bashSuspects = Array.from({ length: 7 }, (_, i) => `curl${i}`);
  const jsonl = [
    bashToolUseLine(crossFamilyText),
    agentToolUseLine("Task", { description: crossFamilyText }),
    // 7 more unique hits per family — 22 unique hits total (1 cross-family pair + 7 + 7 + 7),
    // well under MAX_EGRESS_SUSPECTS_PER_LEG (20) for any ONE family alone, but over it in
    // aggregate. A three-independent-caps implementation (one cap per family) would let all 22
    // through untruncated; the real shared cap must stop at 20.
    ...bashSuspects.map((name, i) => bashToolUseLine(`${name} https://example.invalid/bash-${i}`)),
    ...Array.from({ length: 7 }, (_, i) => webToolUseLine(i % 2 === 0 ? "WebFetch" : "WebSearch", `https://example.invalid/web-${i}`)),
    ...Array.from({ length: 7 }, (_, i) => agentToolUseLine(i % 2 === 0 ? "Agent" : "Task", { description: `spawn-${i}` })),
  ].join("\n");
  const { hits, truncated } = scanEgressSuspects(jsonl, ["Task", ...bashSuspects]);
  assert.equal(truncated, true);
  assert.equal(hits.length, MAX_EGRESS_SUSPECTS_PER_LEG);
  assert.equal(hits.filter((h) => h.executable === "Task" && h.snippet === crossFamilyText).length, 1);
});

test("scanEgressSuspects (#534): Agent/Task description snippets are capped at 200 characters, same bound as a Bash/WebFetch snippet", () => {
  const longDescription = "x".repeat(240);
  const { hits } = scanEgressSuspects(agentToolUseLine("Agent", { description: longDescription }), []);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet.length, 200);
  assert.equal(hits[0]?.snippet, longDescription.slice(0, 200));
});

test("scanEgressSuspects (#534 fix): an EMPTY `description` with a usable `prompt` falls back to `prompt` — an empty string is a string, not absent", () => {
  const jsonl = agentToolUseLine("Agent", { description: "", prompt: "spawn a subagent to check CI" });
  assert.deepEqual(scanEgressSuspects(jsonl, []), {
    hits: [{ executable: "Agent", snippet: "spawn a subagent to check CI" }],
    truncated: false,
  });
});

// ── #617 (seam 4, capability DR #616): the SAME scanner also recognizes generic `mcp__*`
// tool_use blocks — unconditionally, the SAME stance and SAME rationale as the WebFetch/
// WebSearch/Agent/Task extensions above: under official host inheritance an MCP tool is an
// egress-capable channel the guard hook never mediates. No second scanner: this is
// scanEgressSuspects itself, extended again. ──────────────────────────────────────────────────

const mcpToolUseLine = (name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("scanEgressSuspects (#617): mcp__ tool_use blocks hit UNCONDITIONALLY — an EMPTY suspectCommands list (Bash detection fully disabled) still catches them, snippet is the JSON-stringified input", () => {
  const jsonl = [
    mcpToolUseLine("mcp__server-filesystem__write_file", { path: "/tmp/x", content: "payload" }),
    mcpToolUseLine("mcp__Google_Drive__create_file", { name: "notes.txt" }),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, []), {
    hits: [
      { executable: "mcp__server-filesystem__write_file", snippet: JSON.stringify({ path: "/tmp/x", content: "payload" }) },
      { executable: "mcp__Google_Drive__create_file", snippet: JSON.stringify({ name: "notes.txt" }) },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#617): a tool name that merely CONTAINS 'mcp__' without starting with it is a non-hit — the match is a prefix, not a substring", () => {
  const jsonl = mcpToolUseLine("not_mcp__server__tool", { x: 1 });
  assert.deepEqual(scanEgressSuspects(jsonl, []), { hits: [], truncated: false });
});

test("scanEgressSuspects (#617): mcp__ snippets are capped at 200 characters, same bound as every other family", () => {
  const { hits } = scanEgressSuspects(mcpToolUseLine("mcp__server-filesystem__write_file", { content: "x".repeat(240) }), []);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet.length, 200);
});

test("scanEgressSuspects (#617): Bash, WebFetch/WebSearch, Agent/Task, and mcp__ hits share ONE dedup set and ONE per-session cap", () => {
  const jsonl = [
    bashToolUseLine("curl https://example.invalid/bash"),
    webToolUseLine("WebFetch", "https://example.invalid/web"),
    agentToolUseLine("Task", { description: "spawn" }),
    ...Array.from({ length: MAX_EGRESS_SUSPECTS_PER_LEG }, (_, i) =>
      mcpToolUseLine("mcp__server-filesystem__write_file", { path: `/tmp/${i}` }),
    ),
  ].join("\n");
  const { hits, truncated } = scanEgressSuspects(jsonl, ["curl"]);
  assert.equal(truncated, true);
  assert.equal(hits.length, MAX_EGRESS_SUSPECTS_PER_LEG);
});

// ── #387 (F18): loopback classification. The 2026-07-24 dogfood run flagged `curl
// http://127.0.0.1:...` dev-server smoke checks identically to real public egress; loopback
// noise trains an operator to skim the signal. Decision: TAG, never exclude — every hit is still
// journalled with the same evidence, it just carries `target: "loopback"` so the prominent line
// stays the public one. The tag is present ONLY when the snippet is provably loopback-only; its
// ABSENCE is the fail-closed default (full prominence), which is also why every public-egress
// assertion above is byte-identical to its pre-#387 shape. ────────────────────────────────────

test("classifyEgressTarget (#387): loopback URL matrix — localhost, 127/8, ::1 tag; public host, public IP literal, and lookalikes do not", () => {
  // loopback
  assert.equal(classifyEgressTarget("curl http://127.0.0.1:5173/health"), "loopback");
  assert.equal(classifyEgressTarget("curl http://127.1.2.3/"), "loopback"); // whole 127/8, not just .0.0.1
  assert.equal(classifyEgressTarget("curl -sf http://localhost:5173/"), "loopback");
  assert.equal(classifyEgressTarget("curl http://[::1]:5173/"), "loopback");
  assert.equal(classifyEgressTarget("http://dev.localhost:3000/api"), "loopback"); // RFC 6761 subdomain
  assert.equal(classifyEgressTarget("curl http://user:pw@127.0.0.1:8080/x"), "loopback"); // userinfo stripped
  // NOT loopback
  assert.equal(classifyEgressTarget("curl https://example.invalid/x"), undefined);
  assert.equal(classifyEgressTarget("curl http://93.184.216.34/x"), undefined); // public IP literal
  assert.equal(classifyEgressTarget("curl https://notlocalhost.invalid/"), undefined);
  assert.equal(classifyEgressTarget("curl https://localhost.example.invalid/"), undefined); // lookalike suffix
  assert.equal(classifyEgressTarget("curl http://127.0.0.1:5173/ https://example.invalid/x"), undefined); // mixed -> public
  // No URL at all (a WebSearch query, an Agent spawn description, a schemeless curl) is
  // UNCLASSIFIED, never "loopback" — the deliberate false-negative direction.
  assert.equal(classifyEgressTarget("does a mature library already cover this"), undefined);
  assert.equal(classifyEgressTarget("curl 127.0.0.1:5173/health"), undefined); // schemeless: known blind spot
});

test("scanEgressSuspects (#387): a loopback hit carries target:'loopback' in the payload; a public hit's payload is unchanged (no field)", () => {
  const jsonl = [
    bashToolUseLine("curl http://127.0.0.1:5173/"),
    bashToolUseLine("curl https://example.invalid/real"),
    webToolUseLine("WebFetch", "http://localhost:8080/docs"),
    webToolUseLine("WebSearch", "how do vite dev servers report readiness"),
  ].join("\n");
  assert.deepEqual(scanEgressSuspects(jsonl, ["curl"]), {
    hits: [
      { executable: "curl", snippet: "curl http://127.0.0.1:5173/", target: "loopback" },
      { executable: "curl", snippet: "curl https://example.invalid/real" },
      { executable: "WebFetch", snippet: "http://localhost:8080/docs", target: "loopback" },
      { executable: "WebSearch", snippet: "how do vite dev servers report readiness" },
    ],
    truncated: false,
  });
});

test("scanEgressSuspects (#387): classification reads the FULL text, not the 200-char snippet — a public URL truncated out of the evidence can never leave the hit tagged loopback", () => {
  const command = `curl http://127.0.0.1:5173/${"x".repeat(200)} https://example.invalid/exfil`;
  const { hits } = scanEgressSuspects(bashToolUseLine(command), ["curl"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet, command.slice(0, 200)); // the public URL is beyond the cap
  assert.equal(hits[0]?.target, undefined);
});

// ── #110 PR0: parseResultText — the read side for a role session's structured final-message
//    output. Mirrors parseCostUsd's own tolerance test shapes exactly (same fixture style). ──
test("parseResultText: takes the last result line's `result` string", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    `{"type":"assistant","message":{}}`,
    `{"type":"result","subtype":"success","result":"final answer"}`,
  ].join("\n");
  assert.equal(parseResultText(jsonl), "final answer");
});

test("parseResultText: multiple results -> last wins; garbage/partial lines ignored", () => {
  assert.equal(parseResultText(`{"type":"result","result":"first"}\n{"type":"result","result":"second"}`), "second");
  assert.equal(parseResultText(`garbage{{{\n{"type":"result","result":"ok"}`), "ok");
  assert.equal(parseResultText(`no json here\n{"type":"assistant"}`), "");
});

test('parseResultText: missing `result` field -> ""', () => {
  assert.equal(parseResultText(`{"type":"result","subtype":"success","total_cost_usd":0.1}`), "");
});

test("parseResultText: a LAST result line without a string `result` RESETS earlier text — never fail-open on stale text (Codex round 1 P2)", () => {
  // The last parseable result line is authoritative even when it carries no usable text —
  // an earlier line's "old" must NOT survive to be validated and applied downstream.
  assert.equal(parseResultText(`{"type":"result","result":"old"}\n{"type":"result","total_cost_usd":0.1}`), "");
  assert.equal(parseResultText(`{"type":"result","result":"old"}\n{"type":"result","result":42}`), "");
  // A trailing GARBAGE line (unparseable, mid-write) still leaves the last VALID text intact —
  // the reset applies only to parseable result lines, tolerance for the stream is unchanged.
  assert.equal(parseResultText(`{"type":"result","result":"kept"}\ngarbage{{{`), "kept");
});

test('parseResultText: non-string `result` field -> "" (never throws)', () => {
  assert.equal(parseResultText(`{"type":"result","result":{"nested":true}}`), "");
  assert.equal(parseResultText(`{"type":"result","result":42}`), "");
  assert.equal(parseResultText(`{"type":"result","result":null}`), "");
});

test('parseResultText: empty input -> ""', () => {
  assert.equal(parseResultText(""), "");
});

// ── #236: parseSessionInit — the session's own report of its ambient environment, parsed from
//    stream-json's `{"type":"system","subtype":"init",...}` line. Same tolerance-test shapes as
//    parseCostUsd/parseResultText. Field names/shape verified against a real Claude Code CLI
//    2.1.212 probe session (see context-manifest.ts's module doc). ──
test("parseSessionInit: a real-shaped init line yields model/cliVersion/tools/mcpServers/memoryPathAuto", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/some/worktree",
    model: "claude-haiku-4-5-20251001",
    claude_code_version: "2.1.212",
    tools: ["Read", "Bash"],
    mcp_servers: [
      { name: "codegraph", status: "pending" },
      { name: "github", status: "disabled" },
    ],
    memory_paths: { auto: "/Users/x/.claude/projects/repo/memory/" },
  });
  const jsonl = [initLine, `{"type":"assistant","message":{}}`, `{"type":"result","subtype":"success","total_cost_usd":0.01}`].join("\n");
  const info = parseSessionInit(jsonl);
  assert.equal(info.model, "claude-haiku-4-5-20251001");
  assert.equal(info.cliVersion, "2.1.212");
  assert.deepEqual(info.tools, ["Read", "Bash"]);
  assert.deepEqual(info.mcpServers, [
    { name: "codegraph", status: "pending" },
    { name: "github", status: "disabled" },
  ]);
  assert.equal(info.memoryPathAuto, "/Users/x/.claude/projects/repo/memory/");
});

test("parseSessionInit: no init line, garbage lines, or empty input -> honest empty defaults, never throws", () => {
  const empty = { model: null, cliVersion: null, tools: [], mcpServers: [], memoryPathAuto: null };
  assert.deepEqual(parseSessionInit(""), empty);
  assert.deepEqual(parseSessionInit(`garbage{{{\n{"type":"assistant","message":{}}`), empty);
  assert.deepEqual(parseSessionInit(`{"type":"system","subtype":"hook_started"}`), empty);
});

test("parseSessionInit: only the FIRST init line is used; malformed tools/mcp_servers/memory_paths shapes degrade to defaults instead of throwing", () => {
  const first = JSON.stringify({
    type: "system",
    subtype: "init",
    model: "first-model",
    tools: "not-an-array",
    mcp_servers: [{ status: "pending" }],
  });
  const second = JSON.stringify({ type: "system", subtype: "init", model: "second-model" });
  const info = parseSessionInit(`${first}\n${second}`);
  assert.equal(info.model, "first-model", "the FIRST init line wins");
  assert.deepEqual(info.tools, [], "non-array tools degrades to []");
  assert.deepEqual(
    info.mcpServers,
    [{ name: "unknown", status: "pending" }],
    "a server entry missing `name` degrades, never dropped silently",
  );
  assert.equal(info.memoryPathAuto, null);
});

// ── #47: per-model token usage capture (parseModelUsage) ──
test("parseModelUsage: full modelUsage map capture (newer CLI)", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      usage: { input_tokens: 999 }, // top-level usage ignored when modelUsage is present
      modelUsage: {
        "claude-opus-4-6": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 },
        "claude-sonnet-4-6": { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }),
  ].join("\n");
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "claude-opus-4-6", inputTokens: 100, outputTokens: 200, cacheReadTokens: 30, cacheCreationTokens: 10 },
    { model: "claude-sonnet-4-6", inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
});

test("parseModelUsage: modelUsage absent -> falls back to top-level usage attributed to the result's model id", () => {
  const jsonl = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.1,
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 40, output_tokens: 60, cache_creation_input_tokens: 5, cache_read_input_tokens: 15 },
  });
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "claude-sonnet-4-6", inputTokens: 40, outputTokens: 60, cacheReadTokens: 15, cacheCreationTokens: 5 },
  ]);
});

test("parseModelUsage: modelUsage absent + no model field -> falls back to modelName, else 'unknown'", () => {
  const withModelName = JSON.stringify({
    type: "result",
    total_cost_usd: 0.1,
    modelName: "claude-haiku-4-6",
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.deepEqual(parseModelUsage(withModelName), [
    { model: "claude-haiku-4-6", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  const withNeither = JSON.stringify({ type: "result", total_cost_usd: 0.1, usage: { input_tokens: 3 } });
  assert.deepEqual(parseModelUsage(withNeither), [
    { model: "unknown", inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
});

test("parseModelUsage: malformed/missing usage -> zeros, never a parse failure (cost still recovers separately)", () => {
  // usage is entirely absent.
  const noUsage = JSON.stringify({ type: "result", total_cost_usd: 0.2 });
  assert.deepEqual(parseModelUsage(noUsage), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(parseCostUsd(noUsage), 0.2); // USD recording must keep working regardless

  // usage is the wrong shape (a string, not an object).
  const wrongShape = `{"type":"result","total_cost_usd":0.3,"usage":"not-an-object"}`;
  assert.deepEqual(parseModelUsage(wrongShape), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(parseCostUsd(wrongShape), 0.3);

  // usage fields are negative/non-numeric — clamp to 0, not NaN or negative.
  const badFields = JSON.stringify({
    type: "result",
    total_cost_usd: 0.4,
    usage: { input_tokens: -5, output_tokens: "oops", cache_read_input_tokens: null },
  });
  assert.deepEqual(parseModelUsage(badFields), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);

  // no result line at all / garbage-only stream -> empty, no throw.
  assert.deepEqual(parseModelUsage('no json here\n{"type":"assistant"}'), []);
  assert.deepEqual(parseModelUsage(""), []);
  assert.deepEqual(parseModelUsage("garbage{{{"), []);
});

test("parseModelUsage: multiple result lines -> last one wins (same as parseCostUsd)", () => {
  const jsonl = [
    JSON.stringify({ type: "result", total_cost_usd: 0.1, model: "m1", usage: { input_tokens: 1 } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.2, model: "m2", usage: { input_tokens: 2 } }),
  ].join("\n");
  assert.deepEqual(parseModelUsage(jsonl), [{ model: "m2", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }]);
});

// ── #33: parseAssistantUsageDeltas — the live in-flight cost-estimation signal ──
test("parseAssistantUsageDeltas: extracts per-message usage from streamed `assistant` lines, ignoring system/result lines and malformed json", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
    `garbage{{{`,
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
      },
    }),
    // a terminal result line must NOT be double-counted as an assistant delta
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 9.99, usage: { input_tokens: 99999 } }),
  ].join("\n");
  assert.deepEqual(parseAssistantUsageDeltas(jsonl), [
    { model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 2000 },
  ]);
});

test("parseAssistantUsageDeltas: no assistant lines / malformed message / missing usage -> [] or zeros, never throws", () => {
  assert.deepEqual(parseAssistantUsageDeltas(""), []);
  assert.deepEqual(parseAssistantUsageDeltas("garbage{{{\nnot json either"), []);
  assert.deepEqual(parseAssistantUsageDeltas(`{"type":"assistant","message":"not-an-object"}`), []);
  assert.deepEqual(parseAssistantUsageDeltas(`{"type":"assistant"}`), []); // no message field at all
  assert.deepEqual(parseAssistantUsageDeltas(JSON.stringify({ type: "assistant", message: { model: "m", usage: {} } })), [
    { model: "m", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ]);
});

// ── #235 PR-B: parseToolUsage — which tools/paths a session's stream actually invoked ──
test("parseToolUsage: counts tool_use blocks by name and collects Read/Grep/Glob paths, in first-seen tool order, sorted+deduplicated paths", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "/wt/src/b.ts" } },
          { type: "text", text: "reasoning, not a tool call" },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "2", name: "Grep", input: { pattern: "foo", path: "/wt/src" } }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "3", name: "Read", input: { file_path: "/wt/src/a.ts" } }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01 }),
  ].join("\n");
  const { toolUsage, readPaths } = parseToolUsage(jsonl);
  assert.deepEqual(toolUsage, [
    { tool: "Read", count: 2 },
    { tool: "Grep", count: 1 },
  ]);
  assert.deepEqual(readPaths, ["/wt/src", "/wt/src/a.ts", "/wt/src/b.ts"], "sorted, deduplicated");
});

test("parseToolUsage: Glob's explicit path is always captured verbatim, regardless of defaultSearchPath", () => {
  const withPath = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Glob", input: { pattern: "**/*.ts", path: "/wt/src" } }] },
  });
  assert.deepEqual(parseToolUsage(withPath).readPaths, ["/wt/src"]);
  assert.deepEqual(parseToolUsage(withPath, "/wt").readPaths, ["/wt/src"], "explicit path wins over defaultSearchPath, never overridden");
});

test("parseToolUsage (Codex review PR #257 F2): a PATHLESS Grep/Glob call still searches — and reads — the session's cwd, so it's recorded under defaultSearchPath when the caller supplies one (peripheral.ts passes the session's worktree root)", () => {
  const noPathGlob = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Glob", input: { pattern: "**/*.ts" } }] },
  });
  const withoutDefault = parseToolUsage(noPathGlob);
  assert.deepEqual(withoutDefault.toolUsage, [{ tool: "Glob", count: 1 }]);
  assert.deepEqual(
    withoutDefault.readPaths,
    [],
    "defaultSearchPath omitted -> caller doesn't know the worktree root yet, degrades honestly rather than fabricating one",
  );

  const withDefault = parseToolUsage(noPathGlob, "/wt/probe-role-1");
  assert.deepEqual(withDefault.toolUsage, [{ tool: "Glob", count: 1 }]);
  assert.deepEqual(
    withDefault.readPaths,
    ["/wt/probe-role-1"],
    "pathless Glob recorded under the supplied worktree root — it DID read from there",
  );

  const noPathGrep = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Grep", input: { pattern: "TODO" } }] },
  });
  assert.deepEqual(parseToolUsage(noPathGrep, "/wt/probe-role-1").readPaths, ["/wt/probe-role-1"], "same fallback applies to Grep");
});

test("parseToolUsage: defaultSearchPath does NOT apply to Read/NotebookRead — a missing file_path/notebook_path is a malformed call (no cwd-search fallback exists for a single-file read), so it contributes no read path even with a default supplied", () => {
  const readNoPath = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
  });
  const result = parseToolUsage(readNoPath, "/wt/probe-role-1");
  assert.deepEqual(result.toolUsage, [{ tool: "Read", count: 1 }]);
  assert.deepEqual(result.readPaths, [], "Read has no 'searches cwd' fallback — a missing file_path records nothing, default or not");
});

test("parseToolUsage: NotebookRead's notebook_path is captured under the same read-path record", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "NotebookRead", input: { notebook_path: "/wt/nb.ipynb" } }] },
  });
  assert.deepEqual(parseToolUsage(jsonl).readPaths, ["/wt/nb.ipynb"]);
});

test("parseToolUsage: a DENIED tool call (e.g. an attempted Bash, blocked by the guard hook or the CLI's own disallowedTools) is still counted — the attempt itself is diagnostic evidence, whether or not it executed", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Bash", input: { command: "cat /etc/passwd" } }] },
  });
  const { toolUsage, readPaths } = parseToolUsage(jsonl);
  assert.deepEqual(toolUsage, [{ tool: "Bash", count: 1 }]);
  assert.deepEqual(readPaths, [], "Bash has no read-path field in this module's mapping");
});

test("parseToolUsage: no assistant lines / malformed content / malformed tool_use shapes -> empty result, never throws", () => {
  assert.deepEqual(parseToolUsage(""), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage("garbage{{{\nnot json either"), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":"not-an-object"}`), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":"not-an-array"}}`), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":123}]}}`), {
    toolUsage: [],
    readPaths: [],
  });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":"nope"}]}}`), {
    toolUsage: [{ tool: "Read", count: 1 }],
    readPaths: [],
  });
  assert.deepEqual(parseToolUsage(`{"type":"result","total_cost_usd":0.1}`), { toolUsage: [], readPaths: [] });
});

test("discoverClaudeBin: env CLAUDE_BIN wins, else 'claude'", () => {
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.equal(discoverClaudeBin({}), "claude");
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "" }), "claude"); // empty -> default
});

test("claudeArgs: headless flags, stream-json, worktree/session; no --max-budget-usd (soft budget is monitored, not a hard cut)", () => {
  const args = claudeArgs({
    prompt: "do the thing",
    model: "opus",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "lane-1",
    name: "lane-1",
    sessionId: "uuid-1",
    addDir: "/repo/data",
  });
  assert.ok(args.includes("-p") && args.includes("do the thing"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(args.slice(args.indexOf("--fallback-model"), args.indexOf("--fallback-model") + 2), ["--fallback-model", "sonnet"]);
  assert.ok(args.includes("--worktree") && args.includes("lane-1"));
  assert.ok(args.includes("--session-id") && args.includes("uuid-1"));
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--add-dir") && args.includes("/repo/data"));
  assert.ok(!args.includes("--max-budget-usd")); // soft budget: monitored + graceful handoff, never a hard kill
});

test("claudeArgs: resumeSessionId (#46) uses --resume instead of --session-id, reusing the id", () => {
  const args = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "sess-1",
    resumeSessionId: "sess-1",
  });
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "sess-1"]);
  assert.ok(!args.includes("--session-id"));
});

test("claudeArgs: fallbackModel defaults, overrides, and supports explicit opt-out", () => {
  const defaults = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.deepEqual(defaults.slice(defaults.indexOf("--fallback-model"), defaults.indexOf("--fallback-model") + 2), [
    "--fallback-model",
    "sonnet",
  ]);
  const custom = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "haiku",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.deepEqual(custom.slice(custom.indexOf("--fallback-model"), custom.indexOf("--fallback-model") + 2), ["--fallback-model", "haiku"]);
  const none = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "none",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.ok(!none.includes("--fallback-model"));
});

test("claudeArgs: allowedTools/disallowedTools override the worker defaults when given (#87 role-runner reuse)", () => {
  const defaults = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  const idx = defaults.indexOf("--allowedTools");
  assert.equal(defaults[idx + 1], "Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),Bash(node *),Bash(npx *)");
  const scoped = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    allowedTools: "Bash(gh issue comment*)",
    disallowedTools: "Bash(gh pr *)",
  });
  const aIdx = scoped.indexOf("--allowedTools");
  const dIdx = scoped.indexOf("--disallowedTools");
  assert.equal(scoped[aIdx + 1], "Bash(gh issue comment*)");
  assert.equal(scoped[dIdx + 1], "Bash(gh pr *)");
});

test("claudeArgs: --settings only when given (guard hook wiring lands in #26)", () => {
  assert.ok(
    !claudeArgs({ prompt: "p", model: "m", effort: "high", fallbackModel: "sonnet", worktree: "w", name: "w", sessionId: "s" }).includes(
      "--settings",
    ),
  );
  const withSettings = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    settings: "/tmp/guard.json",
  });
  assert.deepEqual(withSettings.slice(withSettings.indexOf("--settings"), withSettings.indexOf("--settings") + 2), [
    "--settings",
    "/tmp/guard.json",
  ]);
});

test("claudeArgs: --mcp-config only when given (#234), inline JSON — never a file path", () => {
  const withoutProxy = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.ok(!withoutProxy.includes("--mcp-config"));
  const inlineJson = JSON.stringify({ mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {} } } });
  const withProxy = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    mcpConfig: inlineJson,
  });
  const i = withProxy.indexOf("--mcp-config");
  assert.ok(i !== -1);
  assert.equal(withProxy[i + 1], inlineJson);
});

test("claudeArgs (#639): pluginDir only when given -> --plugin-dir <path>; omitted -> no flag at all (the disabled-config regression)", () => {
  const withoutPluginDir = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.ok(!withoutPluginDir.includes("--plugin-dir"));
  const withPluginDir = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    pluginDir: "/data/generated/role-skills/abc123",
  });
  const i = withPluginDir.indexOf("--plugin-dir");
  assert.ok(i !== -1);
  assert.equal(withPluginDir[i + 1], "/data/generated/role-skills/abc123");
});

test("claudeArgs (#285): worktree is OPTIONAL — omitted entirely -> no --worktree flag at all (review session mode spawns against an already-materialized cwd instead, via spawnClaudeSession's own cwd opt)", () => {
  const withWorktree = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "lane-1",
    name: "lane-1",
    sessionId: "s",
  });
  assert.ok(withWorktree.includes("--worktree") && withWorktree.includes("lane-1"));

  const withoutWorktree = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    name: "review-1",
    sessionId: "s",
  });
  assert.ok(!withoutWorktree.includes("--worktree"), "no --worktree flag at all when worktree is omitted");
  // --name and everything else are unaffected by omitting worktree.
  assert.ok(withoutWorktree.includes("--name") && withoutWorktree.includes("review-1"));
});

test("claudeArgs (#285, Codex sol-high PR #300 review, P1): strictMcpConfig -> --strict-mcp-config; mcpConfig + strictMcpConfig together pin an EMPTY server map; settingSources -> --setting-sources <value>; all three omitted -> none of these flags appear at all", () => {
  const bare = claudeArgs({ prompt: "p", model: "m", effort: "high", fallbackModel: "sonnet", worktree: "w", name: "w", sessionId: "s" });
  assert.ok(!bare.includes("--strict-mcp-config"), "omitted -> no --strict-mcp-config flag");
  assert.ok(!bare.includes("--setting-sources"), "omitted -> no --setting-sources flag");

  const reviewShaped = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    name: "review-1",
    sessionId: "s",
    mcpConfig: EMPTY_MCP_CONFIG_JSON,
    strictMcpConfig: true,
    settingSources: "user",
  });
  assert.ok(reviewShaped.includes("--strict-mcp-config"));
  const mcpIdx = reviewShaped.indexOf("--mcp-config");
  assert.equal(reviewShaped[mcpIdx + 1], EMPTY_MCP_CONFIG_JSON);
  assert.equal(EMPTY_MCP_CONFIG_JSON, '{"mcpServers":{}}', "the empty-server-map JSON shape itself, pinned");
  const srcIdx = reviewShaped.indexOf("--setting-sources");
  assert.equal(reviewShaped[srcIdx + 1], "user");
});

// ── Integration: stub `claude` (zero token) drives the real spawn/sentinel/probe path ──
const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};

test("spawnClaudeSession (#285): opts.cwd, when given, is the spawned process's REAL working directory — a real subprocess test, not a config assertion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-spawn-cwd-"));
  const targetCwd = mkdtempSync(join(tmpdir(), "sapwood-spawn-cwd-target-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\npwd\nexit 0\n`);
    const jsonlPath = join(dir, "out.jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    const session = spawnClaudeSession(bin, [], { jsonlFd, env: process.env, cwd: targetCwd });
    await new Promise<void>((resolve, reject) => {
      session.onExit(() => resolve());
      session.onError(reject);
    });
    closeSync(jsonlFd);
    const out = readFileSync(jsonlPath, "utf8").trim();
    // realpathSync both sides: macOS's tmpdir() lives under a `/tmp` -> `/private/tmp` symlink,
    // so a real shell's `pwd` (which resolves symlinks) can legitimately differ byte-for-byte
    // from the un-resolved path string this test passed in, while still being the SAME directory.
    assert.equal(realpathSync(out), realpathSync(targetCwd), "the spawned process actually ran with cwd=targetCwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("spawnClaudeSession (#285): opts.cwd OMITTED -> the spawned process inherits the ENGINE's own cwd (today's unchanged behavior for every non-review-session caller)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-spawn-cwd-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\npwd\nexit 0\n`);
    const jsonlPath = join(dir, "out.jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    const session = spawnClaudeSession(bin, [], { jsonlFd, env: process.env });
    await new Promise<void>((resolve, reject) => {
      session.onExit(() => resolve());
      session.onError(reject);
    });
    closeSync(jsonlFd);
    const out = readFileSync(jsonlPath, "utf8").trim();
    assert.equal(realpathSync(out), realpathSync(process.cwd()), "no cwd given -> inherits the engine process's own cwd, unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** #403 (F25), PR #430 gate② round 3: a NAMED HANG GUARD, not a real-time budget. This used to be
 *  a fixed 400x20ms poll whose expiry WAS the assertion, so under concurrent load a merely-slow
 *  real subprocess failed the test for scheduler reasons (the same shape that failed live in
 *  conductor.test.ts's #169 integration test during this PR's load evidence). The bound is now
 *  deliberately generous — orders of magnitude above the real work being waited on — so it bounds
 *  a genuinely wedged child rather than deciding any verdict, and it fails by name when it fires. */
const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`hang guard (${timeoutMs}ms): ${message}`);
    await sleep(20);
  }
};
const waitForFile = (path: string, message = `timed out waiting for ${path}`): Promise<void> => waitFor(() => existsSync(path), message);
const waitForHeartbeatTick = async (path: string): Promise<void> => {
  rmSync(path, { force: true });
  await waitForFile(path, "heartbeat tick did not recreate its marker");
};
const longRunningStub = (dir: string, beforeReady = "", readyName = "stub-ready"): { bin: string; ready: string } => {
  const ready = join(dir, readyName);
  const bin = mkStub(dir, `#!/usr/bin/env bash\n${beforeReady}touch "${ready}"\nfor _ in $(seq 1 600); do sleep 1; done\n`);
  return { bin, ready };
};
const FAST_STUB = `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.0001,"model":"claude-stub","usage":{"input_tokens":12,"output_tokens":34}}'\nexit 0\n`;

// A present (dummy) guard hook so hard-mode dispatch doesn't fail closed; the stub `claude`
// ignores --settings, so its contents don't matter here (the hook mode is unit-tested separately).
const mkHook = (dir: string): string => {
  const p = join(dir, "guard-hook.js");
  writeFileSync(p, "process.exit(0)\n");
  return p;
};

// ── #168 (P1-1 amendment, final form): probeLlmPing — the LLM-source park probe's real
//    implementation: a minimal stripped inference ping; success = exit 0 AND trimmed stdout
//    containing "pong" (case-insensitive). Failure carries a `detail` (first stderr/error
//    line) so the park-probe event can name its own cause. ──────────────────────────────────

test("probeLlmPing: exit 0 + 'pong' on stdout -> ok (case-insensitive, whitespace-tolerant), no detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "  Pong  "\nexit 0\n`);
    assert.deepEqual(await probeLlmPing(bin, "haiku", 0.05, 30), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: exit 0 but NON-pong stdout -> failure, detail carries the first output line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "I'm sorry, I can't help with that."\nexit 0\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("I'm sorry"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing (P3): a sentence CONTAINING 'pong' is a failure — success requires the normalized output to EQUAL 'pong'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "I cannot return only pong"\nexit 0\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false, "a refusal mentioning 'pong' must never read as provider health");
    assert.ok(r.detail?.includes("I cannot return only pong"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: non-zero exit -> failure even with 'pong' on stdout; detail prefers the STDERR error line (the 'Exceeded USD budget' / 'unknown option' operator signal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho pong\necho "Error: Exceeded USD budget (0.01)" >&2\nexit 1\n`);
    const r = await probeLlmPing(bin, "haiku", 0.01, 30);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "Error: Exceeded USD budget (0.01)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: an older CLI rejecting the ping's flags surfaces the unknown-option line as detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "error: unknown option '--no-session-persistence'" >&2\nexit 1\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("unknown option"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: a nonexistent binary -> failure with a spawn detail, never throws", async () => {
  const r = await probeLlmPing("/no/such/binary/sapwood-168", "haiku", 0.05, 30);
  assert.equal(r.ok, false);
  assert.ok(r.detail);
});

test("probeLlmPing: a hang past probeTimeoutSec is hard-killed and resolves failure with a timeout detail, never left dangling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\necho pong\n`);
    const start = Date.now();
    const r = await probeLlmPing(bin, "haiku", 0.05, 1); // 1s timeout vs a 30s hang
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("timed out"));
    // #403 (F25): a DELIBERATE real-time assertion, and the margin ordering is why it is not the
    // banned "two uncontrolled real operations race" shape (docs/REVIEW-DOCTRINE.md). The stub
    // does zero real work — it sleeps 30s — so the only thing that can end this call inside the
    // bound is the timeout kill under test. The three numbers are ordered by construction and by
    // orders of magnitude, not by tuning: probe timeout 1s < this bound 10s < stub sleep 30s. A
    // run 9x slower than expected still passes; a regression that drops the kill cannot pass.
    assert.ok(Date.now() - start < 10_000, "resolved via the timeout kill, not by waiting out the 30s sleep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #578: the verdict must be read once stdout has DRAINED, not the instant the process exits.
// Node's 'exit' fires when the child terminates, with its stdio pipes possibly still holding
// unread bytes; the probe used to read `stdout` there and could see "" for a child that had
// already written "pong" — the exact 2026-08-03 main CI failure (`{ ok: false, detail: 'ping
// exited 0 with no output' }` on the argv test, 28ms, green everywhere else). This stub makes
// that ordering DETERMINISTIC instead of a load-dependent race: a backgrounded writer inherits
// the stdout pipe and emits "pong" long after the direct child has exited 0, so reading at
// 'exit' can only ever see empty output and reading at 'close' can only ever see "pong". No
// wall-clock assertion — the 0.3s is the fake's controlled ordering, not a margin being raced.
test("probeLlmPing (#578): output still in flight when the process exits is NOT read as 'exited 0 with no output' — the verdict waits for stdout to drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\n( sleep 0.3; echo pong ) &\nexit 0\n`);
    assert.deepEqual(await probeLlmPing(bin, "haiku", 0.05, 30), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: invoked with exactly the verified argv — -p, --model, --no-session-persistence, --system-prompt, --strict-mcp-config, --tools '', --max-budget-usd, --output-format text, prompt (and NO --max-tokens, which the CLI rejects)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  const argsFile = join(dir, "args.txt");
  try {
    // NUL-separated capture: one argv entry is the EMPTY string (--tools ""), which a
    // newline-separated printf would silently swallow on split.
    const bin = mkStub(dir, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\necho pong\nexit 0\n`);
    assert.deepEqual(await probeLlmPing(bin, "my-cheap-model", 0.05, 30), { ok: true });
    const argv = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(argv, [
      "-p",
      "--model",
      "my-cheap-model",
      "--no-session-persistence",
      "--system-prompt",
      "You are a heartbeat responder. Only output the requested word.",
      "--strict-mcp-config",
      "--tools",
      "",
      "--max-budget-usd",
      "0.05",
      "--output-format",
      "text",
      "Respond with the single word 'pong' and nothing else.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #377: no PR-association dep (WorkerDeps.lanePr) — a lane built this way is never associated
// with any PR, exactly what every test using this helper already asserted through the deleted
// `hasOpenPr: async () => false`.
const sup = (dir: string, claudeBin: string, worktreeRoot?: string) =>
  new WorkerSupervisor({
    now: realClock,
    cfg,
    stateDir: dir,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    claudeBin,
    renderPrompt: () => "test prompt",
    heartbeatMs: 50,
    guardHookPath: mkHook(dir),
  });

test("dispatch -> stub claude runs -> .done sentinel + parsed cost; probe sees DONE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    const { name, sessionId } = await s.dispatch({ number: 7, title: "t", labels: [] });
    assert.ok(name && sessionId);
    // wait for the stub to exit and the sentinel to land
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "done sentinel written");
    const sentinel = JSON.parse(readFileSync(join(dir, `${name}.done.json`), "utf8"));
    assert.equal(sentinel.issue, 7);
    assert.equal(sentinel.total_cost_usd, 0.0001);
    assert.ok(!existsSync(join(dir, `${name}.running.json`)), "running marker cleared on completion");
    const probe = await s.probe(name);
    assert.equal(probe.done, true);
    assert.equal(probe.failed, false);
    // #14: the terminal sentinel's total_cost_usd feeds the conductor's engine-ceiling
    // ledger (state.recordSpend) — probe() must surface it.
    assert.equal(probe.costUsd, 0.0001);
    // #47: the sentinel also carries model_usage (from the stub's flat "usage" — no
    // modelUsage map, so it's the fallback-attributed single entry) — probe() surfaces it too.
    assert.deepEqual(probe.modelUsage, [
      { model: "claude-stub", inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#304 wiring: a completed lane records one egress-suspect event through the existing state path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  let state: State | undefined;
  try {
    const toolLine = bashToolUseLine("curl https://example.invalid/upload");
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho '${toolLine}'\necho '{"type":"result","total_cost_usd":0.0001}'\nexit 0\n`);
    state = new State(join(dir, "state.sqlite"));
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      state,
    });
    const { name } = await s.dispatch({ number: 304, title: "egress", labels: [] });
    await waitForFile(join(dir, `${name}.done.json`));
    assert.deepEqual(state.eventsSince("1970-01-01T00:00:00.000Z", ["egress-suspect"]), [
      {
        kind: "egress-suspect",
        payload: { worker: name, issue: 304, executable: "curl", snippet: "curl https://example.invalid/upload" },
      },
    ]);
    assert.equal((await s.probe(name)).done, true);
    s.dispose();
  } finally {
    state?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#341 wiring: a completed lane writes at most the per-leg egress cap and logs truncation once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  let state: State | undefined;
  try {
    const toolLines = Array.from({ length: MAX_EGRESS_SUSPECTS_PER_LEG + 5 }, (_, i) =>
      bashToolUseLine(`curl https://example.invalid/${i}`),
    );
    const transcript = toolLines.map((line) => `echo '${line}'`).join("\n");
    const bin = mkStub(dir, `#!/usr/bin/env bash\n${transcript}\necho '{"type":"result","total_cost_usd":0.0001}'\nexit 0\n`);
    const logs: string[] = [];
    state = new State(join(dir, "state.sqlite"));
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      log: (line) => logs.push(line),
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      state,
    });
    const { name } = await s.dispatch({ number: 304, title: "egress cap", labels: [] });
    await waitForFile(join(dir, `${name}.done.json`));
    const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["egress-suspect"]);
    assert.equal(events.length, MAX_EGRESS_SUSPECTS_PER_LEG);
    assert.equal(
      logs.filter(
        (line) =>
          line.includes(`egress tripwire evidence capped at ${MAX_EGRESS_SUSPECTS_PER_LEG} suspects`) && line.includes(`lane ${name}`),
      ).length,
      1,
    );
    assert.equal((await s.probe(name)).done, true);
    s.dispose();
  } finally {
    state?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#304 fail-safe: an egress event write failure is logged but cannot change a completed lane's outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const toolLine = bashToolUseLine("curl https://example.invalid/upload");
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho '${toolLine}'\necho '{"type":"result","total_cost_usd":0.0001}'\nexit 0\n`);
    const logs: string[] = [];
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      log: (line) => logs.push(line),
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      state: {
        appendEvent: () => {
          throw new Error("events unavailable");
        },
        maxEventId: () => 0,
        recordContextManifest: () => {},
      },
    });
    const { name } = await s.dispatch({ number: 304, title: "egress", labels: [] });
    await waitForFile(join(dir, `${name}.done.json`));
    const probe = await s.probe(name);
    assert.equal(probe.done, true);
    assert.equal(probe.failed, false);
    assert.ok(logs.some((line) => line.includes("egress tripwire failed (non-fatal)") && line.includes("events unavailable")));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 lanePr supplies prNumber and derives hasPr from it (the lane's own PR, not the issue's)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      lanePr: async (lane) => ({ pr: lane.issue === 8 ? 42 : null, inconclusive: false }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.hasPr, true);
    assert.equal(probe.prNumber, 42);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #595 lanePr's outcome.title rides onto LaneProbe.prTitle (the SAME association read, no extra call)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      lanePr: async (lane) =>
        lane.issue === 8 ? { pr: 42, inconclusive: false, title: "feat: the lane's PR" } : { pr: null, inconclusive: false },
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.prNumber, 42);
    assert.equal(probe.prTitle, "feat: the lane's PR");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #595 lanePr's outcome without a title omits LaneProbe.prTitle rather than writing undefined/null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      lanePr: async () => ({ pr: 42, inconclusive: false }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.prNumber, 42);
    assert.equal(probe.prTitle, undefined);
    assert.ok(!Object.hasOwn(probe, "prTitle"));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 lanePr returning null -> hasPr false, prNumber undefined (fail closed, never a guessed PR)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      lanePr: async () => ({ pr: null, inconclusive: false }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.hasPr, false);
    assert.equal(probe.prNumber, undefined);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 passes the lane's OWN branch (read from its worktree git HEAD, no git subprocess) and gates PR creation on the lane having terminated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    // A long-running stub keeps the lane RUNNING for the first probe; the terminal sentinel is
    // written by hand for the second, so neither probe races the child's own exit.
    const { bin, ready } = longRunningStub(dir);
    const seen: { name: string; issue: number; branch: string | null; sessionOver: boolean }[] = [];
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      lanePr: async (lane) => {
        seen.push(lane);
        return { pr: null, inconclusive: false };
      },
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 377, title: "t", labels: [] });
    await waitForFile(ready);
    // A LINKED worktree exactly as the `claude` CLI creates it: `.git` is a file pointing at the
    // parent repo's per-worktree gitdir, whose HEAD names the branch the worker switched to.
    const gitDir = join(dir, "parent-git", "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(worktreeRoot, name), { recursive: true });
    writeFileSync(join(worktreeRoot, name, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feat/377-pr-owner-marker\n");

    await s.probe(name);
    assert.deepEqual(seen.at(-1), { name, issue: 377, branch: "feat/377-pr-owner-marker", sessionOver: false });

    writeFileSync(join(dir, `${name}.done.json`), JSON.stringify({ name, issue: 377 }));
    await s.probe(name);
    assert.equal(seen.at(-1)!.sessionOver, true, "once the worker has terminated the engine may open the missing PR itself");

    // A detached HEAD (or a reclaimed worktree) is unknowable, not guessable -> null branch.
    writeFileSync(join(gitDir, "HEAD"), "9f1c0de0c0ffee0c0ffee0c0ffee0c0ffee0c0ff\n");
    await s.probe(name);
    assert.equal(seen.at(-1)!.branch, null);

    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 gate② P1 — a CONFIRMED-DEAD wrapper with no sentinel still permits the engine-authored PR (a pushed branch must not be requeued as unPRed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const seen: { name: string; issue: number; branch: string | null; sessionOver: boolean }[] = [];
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: mkStub(dir, FAST_STUB),
      lanePr: async (lane) => {
        seen.push(lane);
        return { pr: null, inconclusive: false };
      },
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    // A detached lane that died after pushing: running.json persisted, no terminal sentinel was
    // ever written (no attached onExit handler), and the wrapper pid is confirmed gone. An
    // impossible pid rather than a killed real one — the death signal must not depend on timing.
    writeFileSync(join(dir, "lane-dead.running.json"), JSON.stringify({ issue: 377, wrapper_pid: 999999999 }));
    const probe = await s.probe("lane-dead");
    assert.equal(probe.wrapperAlive, 0, "sanity: confirmed dead, the structured signal this gate keys on");
    assert.equal(probe.done, false);
    assert.equal(probe.failed, false);
    assert.equal(probe.handoff, false);
    assert.equal(seen.at(-1)!.sessionOver, true, "nothing is left alive to race the engine's own `gh pr create`");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 gate② round 3 (P1) — an INCONCLUSIVE association (forge write failed) is surfaced, so the conductor defers instead of settling the lane as no-PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: mkStub(dir, FAST_STUB),
      lanePr: async () => ({ pr: null, inconclusive: true }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    writeFileSync(join(dir, "lane-blip.done.json"), JSON.stringify({ issue: 377 }));
    const probe = await s.probe("lane-blip");
    assert.equal(probe.hasPr, false);
    assert.equal(probe.prNumber, undefined);
    assert.equal(probe.prAssociationInconclusive, true, "UNKNOWN is not the same claim as 'this lane has no PR'");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 gate② round 3 (P1) — the inconclusive deferral is BOUNDED: after the cap the lane settles by the ordinary no-PR rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const logs: string[] = [];
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      log: (line) => logs.push(line),
      stateDir: dir,
      claudeBin: mkStub(dir, FAST_STUB),
      // A PERMANENTLY failing openPR (e.g. "No commits between main and <branch>") — not every
      // write failure is transient, so an unbounded defer would hold the lane slot forever.
      lanePr: async () => ({ pr: null, inconclusive: true }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    writeFileSync(join(dir, "lane-wedge.done.json"), JSON.stringify({ issue: 377 }));
    for (let i = 0; i < MAX_INCONCLUSIVE_PR_PROBES; i++) {
      assert.equal((await s.probe("lane-wedge")).prAssociationInconclusive, true, `attempt ${i + 1} still retryable`);
    }
    const settled = await s.probe("lane-wedge");
    assert.equal(settled.prAssociationInconclusive, undefined, "retry budget spent -> the lane settles rather than wedging a slot");
    assert.equal(settled.hasPr, false);
    assert.ok(logs.some((l) => l.includes("lane-wedge") && l.includes("PR association still unknown")));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 gate② round 3 (P1) — a CONCLUSIVE answer resets the retry budget (a later blip gets its own full allowance)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    let inconclusive = true;
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: mkStub(dir, FAST_STUB),
      lanePr: async () => (inconclusive ? { pr: null, inconclusive: true } : { pr: 42, inconclusive: false }),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    writeFileSync(join(dir, "lane-blip2.done.json"), JSON.stringify({ issue: 377 }));
    for (let i = 0; i < MAX_INCONCLUSIVE_PR_PROBES; i++) await s.probe("lane-blip2");
    inconclusive = false;
    assert.equal((await s.probe("lane-blip2")).prNumber, 42, "the forge recovered within the budget");
    inconclusive = true;
    assert.equal((await s.probe("lane-blip2")).prAssociationInconclusive, true, "budget reset by the conclusive answer");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #377 gate② round 5 (P1) — a branch another LIVE lane is sitting on is never used for association (a worker can `git checkout` its way onto one)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    const seen: { branch: string | null }[] = [];
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: mkStub(dir, FAST_STUB),
      lanePr: async (lane) => {
        seen.push({ branch: lane.branch });
        return { pr: null, inconclusive: false };
      },
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const onBranch = (lane: string, branch: string): void => {
      const gitDir = join(dir, "parent-git", "worktrees", lane);
      mkdirSync(gitDir, { recursive: true });
      mkdirSync(join(worktreeRoot, lane), { recursive: true });
      writeFileSync(join(worktreeRoot, lane, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    };
    // lane-victim legitimately owns feat/294-hold. lane-thief's worker checked out the SAME
    // branch — permitted by the producer's own git grant — which under a bare HEAD read would
    // hand lane-thief the stamp-and-adopt of lane-victim's branch PR.
    writeFileSync(join(dir, "lane-victim.running.json"), JSON.stringify({ issue: 294, wrapper_pid: process.pid }));
    writeFileSync(join(dir, "lane-thief.done.json"), JSON.stringify({ issue: 999 }));
    onBranch("lane-victim", "feat/294-hold");
    onBranch("lane-thief", "feat/294-hold");

    await s.probe("lane-thief");
    assert.equal(seen.at(-1)!.branch, null, "a contested branch is not a usable association key");

    // The victim's own probe is unaffected once the thief is gone: exclusivity, not first-come.
    rmSync(join(worktreeRoot, "lane-thief"), { recursive: true, force: true });
    rmSync(join(dir, "lane-thief.done.json"), { force: true });
    await s.probe("lane-victim");
    assert.equal(seen.at(-1)!.branch, "feat/294-hold");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: costUsd is 0 while a lane is still running (no terminal sentinel yet)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 4, title: "t", labels: [] });
    await waitForFile(ready);
    const probe = await s.probe(name);
    assert.equal(probe.done, false);
    assert.equal(probe.costUsd, 0);
    assert.ok(Number.isFinite(probe.dispatchedAgeSec));
    assert.ok(probe.dispatchedAgeSec! >= 0, "probe surfaces age from persisted dispatched_at");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: recovers costUsd from the jsonl when a restart-orphaned lane has NO terminal sentinel (Codex PR #41 R3 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    // Simulate a lane orphaned by an engine restart: claude finished and wrote its terminal
    // result line to the jsonl, but no attached onExit handler existed to write a sentinel.
    // The probe must not report 0 — that would omit real spend from the daily-cap ledger.
    writeFileSync(join(dir, "lane-orphan.running.json"), JSON.stringify({ issue: 5, wrapper_pid: 999999999 }));
    writeFileSync(
      join(dir, "lane-orphan.jsonl"),
      `{"type":"system"}\n{"type":"result","subtype":"success","total_cost_usd":1.25,"model":"claude-opus-4-6","usage":{"input_tokens":7}}\n`,
    );
    const probe = await s.probe("lane-orphan");
    assert.equal(probe.done, false); // no sentinel — classifyLane will call this DEAD (pid gone)
    assert.ok(Number.isNaN(probe.dispatchedAgeSec), "missing dispatched_at is an explicit unbounded/fail-safe age");
    assert.equal(probe.costUsd, 1.25); // but the real cost is still recovered from the jsonl
    // #47: same fallback recovery applies to model usage — no sentinel, so it's reparsed too.
    assert.deepEqual(probe.modelUsage, [
      { model: "claude-opus-4-6", inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch rejects a name already in use (no concurrent same-name clobber)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    writeFileSync(join(dir, "lane-x.running.json"), "{}"); // pretend a lane is occupying the name
    await assert.rejects(() => s.dispatch({ number: 1, title: "t", labels: [] }, "lane-x"), /in use|occupied|exists/i);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaim kills a stubborn (ignores TERM) claude subtree via SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Stubborn stub: ignore TERM -> only a process-group KILL stops it.
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 2, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before reclaim");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    await s.reclaim(name);
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "process group killed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff -> graceful SIGTERM -> .handoff sentinel (resumable, not killed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // A COOPERATIVE worker: catches SIGTERM and exits 0 (it checkpointed/committed). Only a
    // clean exit-0 after a handoff request counts as a resumable .handoff.
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handoff sentinel written on cooperative drain");
    assert.ok(!existsSync(join(dir, `${name}.done.json`)) && !existsSync(join(dir, `${name}.failed.json`)));
    const probe = await s.probe(name);
    assert.equal(probe.handoff, true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff reaches a RESTARTED-engine lane via the persisted pid (Codex PR #41 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // A cooperative worker that exits 0 on TERM. Dispatch with supervisor #1, then simulate
    // an engine restart: dispose() #1 (clears its in-memory lane map — its exit handler
    // becomes a no-op) and create supervisor #2 over the SAME stateDir. #2 has no in-memory
    // handle, only the persisted running.json — the ceiling drain must still reach the
    // process group via the persisted pid instead of silently no-opping.
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 8, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    s1.dispose(); // "restart": the new supervisor knows this lane only from disk
    const s2 = sup(dir, bin);
    assert.equal(s2.requestHandoff(name), true); // persisted-pid fallback fires
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process group");
    assert.equal(s2.requestHandoff(name), false); // idempotent: second request is a no-op
    assert.equal(s2.requestHandoff("lane-unknown"), false); // no persisted lane -> false, no throw
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff, worker dies by signal (no clean wrap-up), and no worktree exists on disk -> STILL .handoff, never .failed (#60 supersedes Codex R3 P2: the real CLI never exits 0 on SIGTERM, so gating .handoff on code===0 made it unreachable; the supervisor now guarantees resumability itself, tag-agnostic to exit code)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir); // no TERM trap -> SIGTERM kills it (code null)
    const s = sup(dir, bin); // no worktreeRoot override -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await waitForFile(ready, "stub reached its running state before handoff");
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handoff-requested + signal-killed is .handoff, not .failed");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#172: resumed no-result SIGTERM ignores leg 1's result and ledgers its baseline-adjusted estimate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const firstLine = JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-4-6", usage: { input_tokens: 1_000, output_tokens: 200 } },
  });
  const resumedLine = JSON.stringify({
    type: "assistant",
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 500, output_tokens: 300 } },
  });
  const firstResult = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 1,
    model: "claude-opus-4-6",
    usage: { input_tokens: 1_000, output_tokens: 200 },
  });
  const logs: string[] = [];
  const state = new State(":memory:");
  try {
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  echo '${resumedLine}'`,
        "else",
        `  echo '${firstLine}'`,
        `  echo '${firstResult}'`,
        "fi",
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      log: (line) => logs.push(line),
    });
    const pricing = loadPricingTable(cfg);
    const resumedExpected = parseAssistantUsageDeltas(resumedLine).reduce((sum, d) => sum + estimateUsd(d, pricing), 0);
    const { name } = await s.dispatch({ number: 172, title: "t", labels: [] });
    const jsonlPath = join(dir, `${name}.jsonl`);
    for (let i = 0; i < 400 && !readFileSync(jsonlPath, "utf8").includes(firstResult); i++) await sleep(20);
    assert.ok(readFileSync(jsonlPath, "utf8").includes(firstResult), "leg 1 result flushed before SIGTERM");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    const firstProbe = await s.probe(name);
    assert.equal(firstProbe.costUsd, 1);
    state.recordSpend(name, 172, firstProbe.costUsd, new Date().toISOString());

    await s.resume({ number: 172, title: "t", labels: [] }, name);
    for (let i = 0; i < 400 && !readFileSync(jsonlPath, "utf8").includes(resumedLine); i++) await sleep(20);
    assert.ok(readFileSync(jsonlPath, "utf8").includes(resumedLine), "leg 2 usage flushed before SIGTERM");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    const resumedProbe = await s.probe(name);
    const resumedCost = resumedProbe.costUsd ?? Number.NaN;
    assert.ok(
      Math.abs(resumedCost - resumedExpected) < 1e-12,
      `resumed no-result leg cost ${resumedCost} should equal baseline-adjusted estimate ${resumedExpected}`,
    );
    state.recordSpend(name, 172, resumedCost, new Date().toISOString());
    assert.ok(Math.abs(state.spentUsdForWorker(name) - (1 + resumedExpected)) < 1e-12);
    assert.equal(logs.filter((line) => line.includes("source=assistant-usage-estimate")).length, 1);
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #46: resume() — --resume after a .handoff ────────────────────────────────────────────────

test("resumeIntentState: reads only matching resume-authored confirmed/unconfirmed markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, mkStub(dir, FAST_STUB));
    const marker = join(dir, "lane-intent.running.json");
    assert.equal(s.resumeIntentState("lane-intent", 172), "none");
    writeFileSync(
      marker,
      JSON.stringify({ name: "lane-intent", issue: 172, session_id: "s", resume_pending_db: true, spawn_confirmed: false }),
    );
    assert.equal(s.resumeIntentState("lane-intent", 172), "unconfirmed");
    assert.equal(s.resumeIntentState("lane-intent", 999), "none");
    writeFileSync(
      marker,
      JSON.stringify({ name: "lane-intent", issue: 172, session_id: "s", resume_pending_db: true, spawn_confirmed: true }),
    );
    assert.equal(s.resumeIntentState("lane-intent", 172), "confirmed");
    writeFileSync(marker, JSON.stringify({ name: "lane-intent", issue: 172, spawn_confirmed: false }));
    assert.equal(s.resumeIntentState("lane-intent", 172), "none", "dispatch markers are not resume intents");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fails closed when the lane has no .handoff sentinel (nothing to resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-never-handed-off"),
      /no \.handoff sentinel|nothing to resume/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a dead matching running sentinel is durable interrupted-resume proof and is adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, mkStub(dir, FAST_STUB));
    writeFileSync(
      join(dir, "lane-dead.running.json"),
      JSON.stringify({
        name: "lane-dead",
        issue: 1,
        session_id: "survivor",
        wrapper_pid: 999_999_999,
        resume_pending_db: true,
        spawn_confirmed: true,
      }),
    );
    assert.deepEqual(await s.resume({ number: 1, title: "t", labels: [] }, "lane-dead"), {
      name: "lane-dead",
      sessionId: "survivor",
    });
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: spawn error removes the unconfirmed intent and leaves handoff retryable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, join(dir, "missing-claude"));
    writeFileSync(
      join(dir, "lane-spawn-error.handoff.json"),
      JSON.stringify({ name: "lane-spawn-error", issue: 2, session_id: "retry-session" }),
    );
    writeFileSync(join(dir, "lane-spawn-error.jsonl"), "");

    await assert.rejects(() => s.resume({ number: 2, title: "t", labels: [] }, "lane-spawn-error"), /resume-spawn failed/i);
    assert.equal(existsSync(join(dir, "lane-spawn-error.running.json")), false);
    assert.equal(existsSync(join(dir, "lane-spawn-error.handoff.json")), true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume (#395 PM follow-up): resume()'s OWN spawn confirmation await — a separate call site from dispatch()'s, missed in the first pass — is bounded too. A never-arriving notification is killed and reported, never hangs forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    // A prior dispatch's handoff sentinel — resume() reads this from DISK, not from any
    // in-memory state of whichever supervisor instance created it (the same cross-restart
    // contract a real engine resume relies on), so a SEPARATE supervisor instance (below,
    // configured with the zero timeout under test) can resume it directly.
    writeFileSync(
      join(dir, "lane-resume-timeout.handoff.json"),
      JSON.stringify({ name: "lane-resume-timeout", issue: 5, session_id: "retry-session-395" }),
    );
    writeFileSync(join(dir, "lane-resume-timeout.jsonl"), "");
    const bin = mkStub(dir, FAST_STUB);
    const liveCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      liveness: { spawnConfirmTimeoutMs: 1 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: liveCfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      sleep: async () => {
        /* resolves immediately — deterministically wins the race, same technique as dispatch()'s
           own #395 regression test above */
      },
    });
    await assert.rejects(() => s.resume({ number: 5, title: "t", labels: [] }, "lane-resume-timeout"), /spawn confirmation timed out/i);
    assert.equal(existsSync(join(dir, "lane-resume-timeout.running.json")), false, "no bogus running marker left behind");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume (#395 gate② P2-2): a merely-DELAYED (not lost) real spawn event racing the timeout must NOT resurrect running.json after the failure path already removed it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(join(dir, "lane-race.handoff.json"), JSON.stringify({ name: "lane-race", issue: 6, session_id: "retry-session-race" }));
    writeFileSync(join(dir, "lane-race.jsonl"), "");
    // A REAL, working binary — its 'spawn' event WILL eventually fire genuinely (just later than
    // the injected sleep below, which deterministically wins the timeout race first — same
    // "microtask beats a real OS process-spawn notification" evidence as this file's other
    // #395 regression tests).
    const bin = mkStub(dir, FAST_STUB);
    const liveCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      liveness: { spawnConfirmTimeoutMs: 1 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: liveCfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      sleep: async () => {
        /* resolves immediately — wins the timeout race before the real 'spawn' event arrives */
      },
    });
    await assert.rejects(() => s.resume({ number: 6, title: "t", labels: [] }, "lane-race"), /spawn confirmation timed out/i);
    assert.equal(existsSync(join(dir, "lane-race.running.json")), false, "removed by the failure path");
    // Give the real (merely delayed, not lost) 'spawn' event time to actually fire its late
    // handler. Before the #395 gate② P2-2 fix, that handler unconditionally re-wrote
    // running.json with spawn_confirmed:true + a real-but-by-then-dead pid — exactly the marker
    // the adoption/RESUME_UNDECIDABLE machinery trusts.
    await sleep(300);
    assert.equal(
      existsSync(join(dir, "lane-race.running.json")),
      false,
      "the late spawn handler must not resurrect running.json once the race already settled on timed-out",
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: --resume reuses the ORIGINAL session id, clears .handoff, and the resumed run's terminal cost is probed normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const ready = join(dir, "stub-ready");
    // Cooperative stub: a fresh dispatch sleeps and hands off cleanly on TERM. A --resume
    // invocation instead prints ONE more (higher, "cumulative") result line and exits 0 —
    // standing in for claude continuing the same session after --resume.
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.05,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name, sessionId } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handed off before resuming");

    const resumed = await s.resume({ number: 3, title: "t", labels: [] }, name);
    assert.equal(resumed.name, name);
    assert.equal(resumed.sessionId, sessionId); // SAME session — no --fork-session
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "handoff sentinel cleared once live again");

    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "resumed run reached a fresh terminal sentinel");
    const probe = await s.probe(name);
    assert.equal(probe.done, true);
    // probe() surfaces the resumed leg's raw per-leg reported cost as-is (0.05); #172 records
    // that value directly in State.recordSpend.
    assert.equal(probe.costUsd, 0.05);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: also sets SAPWOOD_WORKTREE_ROOT to the same lane's resolved worktree path (#235 PR-A) — a resumed leg keeps Read containment too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    const ready = join(dir, "stub-ready");
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  echo "$SAPWOOD_WORKTREE_ROOT" > "${join(dir, "resume-root.seen.tmp")}"`,
        `  mv "${join(dir, "resume-root.seen.tmp")}" "${join(dir, "resume-root.seen")}"`,
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.05,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin, worktreeRoot);
    const { name } = await s.dispatch({ number: 4, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    await s.resume({ number: 4, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "resume-root.seen"), "resumed worktree root was not published");
    assert.equal(readFileSync(join(dir, "resume-root.seen"), "utf8").trim(), join(worktreeRoot, name));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fails closed in hard mode when the guard hook is missing (no unguarded resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    // A supervisor whose guard hook path doesn't exist, same as dispatch()'s hard-mode guard.
    const s2 = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(() => s2.resume({ number: 3, title: "t", labels: [] }, name), /guard hook not found|unguarded/i);
    s.dispose();
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardSettings: PreToolUse hook runs `node <hookPath>` and fails closed (exit 2) on a hook crash", () => {
  const s = guardSettings("/x/dist/guard-hook.js") as {
    disableAllHooks: boolean;
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  assert.equal(s.disableAllHooks, false); // force hooks on so a global disable can't silence the guard
  const entry = s.hooks.PreToolUse[0]!;
  assert.match(entry.matcher, /Bash/);
  // #620: the matcher carries the WHOLE guarded family — NotebookEdit's omission was a silent
  // write-path bypass (the hook only fires for tools the matcher names). Pin the exact string so
  // any future tool addition/removal is a deliberate, reviewed edit here too.
  assert.equal(entry.matcher, "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead");
  assert.equal(entry.hooks[0]!.type, "command");
  const cmd = entry.hooks[0]!.command;
  assert.match(cmd, /^node '\/x\/dist\/guard-hook\.js'/); // single-quoted hook path (no shell expansion)
  assert.match(cmd, /\bexit 2\b/); // a hook launch/runtime failure blocks (fail-closed, hard)
  assert.match(cmd, /SAPWOOD_GUARD_MODE.*soft.*exit 0/); // soft mode allows on crash (observe-only)
});

test("shellSingleQuote: suppresses shell expansion of $, backticks, $()", () => {
  assert.equal(shellSingleQuote("/a/b"), "'/a/b'");
  assert.equal(shellSingleQuote("/p/$(rm -rf x)/h.js"), "'/p/$(rm -rf x)/h.js'"); // $() not expanded
  assert.equal(shellSingleQuote("/it's/here"), "'/it'\\''s/here'"); // embedded quote escaped
});

test("guard hook wrapper fails closed: a crashing hook exits 2 in hard mode, 0 in soft (Codex #26 P1)", async () => {
  // A hook path that makes `node` exit non-zero (module not found). In hard mode the wrapper
  // must map that to exit 2 (BLOCKING); in soft (observe-only) it allows (exit 0).
  const cmd = (
    guardSettings("/nonexistent/sapwood-guard-hook.js") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    }
  ).hooks.PreToolUse[0]!.hooks[0]!.command;
  const run = (mode: string): Promise<number | null> =>
    new Promise((resolve) => {
      const c = spawn("sh", ["-c", cmd], { stdio: "ignore", env: { ...process.env, SAPWOOD_GUARD_MODE: mode } });
      c.on("exit", (code) => resolve(code));
    });
  assert.equal(await run("hard"), 2); // fail-closed: a broken hook BLOCKS the tool
  assert.equal(await run("soft"), 0); // observe-only: a broken hook allows
});

test("dispatch passes INLINE guard --settings (no mutable file) + sets SAPWOOD_GUARD_MODE in the worker env (#26)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "worker-forge-token";
    const hook = mkHook(dir);
    // Stub records argv + security-relevant env. Unlike peripherals, workers legitimately
    // retain forge credentials so they can push branches and open PRs through the guard.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho "$GH_TOKEN" > "${join(dir, "token.seen.tmp")}"\nmv "${join(dir, "token.seen.tmp")}" "${join(dir, "token.seen")}"\necho "$SAPWOOD_GUARD_MODE" > "${join(dir, "mode.seen.tmp")}"\nmv "${join(dir, "mode.seen.tmp")}" "${join(dir, "mode.seen")}"\nexit 0\n`,
    );
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "soft" } });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: scfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 7, title: "t", labels: [] });
    assert.ok(!existsSync(join(dir, `${name}.settings.json`)), "no mutable settings file written");
    // mode.seen is the stub's LAST write — waiting on it guarantees args.seen exists too
    // (waiting on args.seen could race the second write on a slow FS). (Codex #26 R6 P3.)
    await waitForFile(join(dir, "mode.seen"), "guard env marker was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /--settings/);
    assert.match(args, /guard-hook\.js/); // the inline JSON carries the hook command
    assert.match(args, /disableAllHooks/);
    assert.equal(readFileSync(join(dir, "mode.seen"), "utf8").trim(), "soft"); // env reached the worker
    assert.equal(readFileSync(join(dir, "token.seen"), "utf8").trim(), "worker-forge-token");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

// #235 PR-A: SAPWOOD_WORKTREE_ROOT reaches the worker's spawn env, resolved to the ABSOLUTE
// path of THIS lane's worktree — the guard hook reads it to confine Read/Grep/Glob (see
// guard.ts's checkReadContainment). Set at spawn exactly where SAPWOOD_GUARD_MODE is, both on
// fresh dispatch() and on resume() (a resumed leg must keep the same containment).
test("dispatch sets SAPWOOD_WORKTREE_ROOT to the resolved absolute worktree path (#235 PR-A)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const worktreeRoot = join(dir, "worktrees");
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho "$SAPWOOD_WORKTREE_ROOT" > "${join(dir, "root.seen.tmp")}"\nmv "${join(dir, "root.seen.tmp")}" "${join(dir, "root.seen")}"\nexit 0\n`,
    );
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "hard" } });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: scfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await waitForFile(join(dir, "root.seen"), "worker worktree root was not published");
    assert.equal(readFileSync(join(dir, "root.seen"), "utf8").trim(), join(worktreeRoot, name));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch fails closed in hard mode when the guard hook is missing (no unguarded worker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(() => s.dispatch({ number: 1, title: "t", labels: [] }), /guard hook not found|unguarded/i);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch rejects (and cleans up) when claude can't spawn — bad CLAUDE_BIN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, join(dir, "does-not-exist-claude"));
    await assert.rejects(() => s.dispatch({ number: 4, title: "t", labels: [] }, "lane-bad"), /spawn failed/i);
    // no bogus running marker / jsonl left behind for the conductor to misread
    assert.ok(!existsSync(join(dir, "lane-bad.running.json")));
    assert.ok(!existsSync(join(dir, "lane-bad.jsonl")));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#395): cfg.liveness.spawnConfirmTimeoutMs is threaded through — a generous bound never fires on a normally-spawning worker (regression: the new plumbing doesn't disturb the healthy path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const liveCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      liveness: { spawnConfirmTimeoutMs: 5_000 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: liveCfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "done sentinel written — the configured timeout never fired");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#395 PM follow-up): a spawn confirmation that never arrives is bounded, killed, AND its (already-provisioned) worktree is removed — a fresh lane never gets tracked, so nothing else would ever sweep it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    const bin = mkStub(dir, FAST_STUB);
    const liveCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      liveness: { spawnConfirmTimeoutMs: 1 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: liveCfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      // Deterministic: an injected `sleep` resolving on the next microtask reliably wins the
      // race against a real (if fast) OS process-spawn confirmation — same technique
      // util/spawn-confirm.test.ts uses in isolation, exercised here end-to-end through
      // dispatch() itself.
      sleep: async () => {
        /* resolves immediately */
      },
    });
    // Simulate the live-incident shape: the (about-to-be-killed) child already started
    // provisioning its own worktree before the notification was lost. A real `claude` CLI
    // does this itself (this test's stub binary doesn't understand --worktree at all), so the
    // directory is created here directly to exercise the cleanup path in isolation.
    const laneWorktree = join(worktreeRoot, "lane-timeout-wt");
    mkdirSync(laneWorktree, { recursive: true });
    writeFileSync(join(laneWorktree, "marker.txt"), "partially provisioned");
    await assert.rejects(() => s.dispatch({ number: 9, title: "t", labels: [] }, "lane-timeout-wt"), /spawn confirmation timed out/i);
    assert.ok(!existsSync(laneWorktree), "the orphaned worktree was removed — nothing else ever tracks this never-registered lane");
    assert.ok(!existsSync(join(dir, "lane-timeout-wt.running.json")));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#395 gate② round 3, P1): a LIVE worker leg heart-beats against a real State, and heartbeats STOP the instant the child is no longer alive — end-to-end through heartbeatTick's real wiring, not just the isolated createHeartbeatGate unit tests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n"); // ignores TERM -> only SIGKILL ends it
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 15, // fast cadence so this test observes several ticks quickly
      guardHookPath: mkHook(dir),
      state,
    });
    const { name } = await s.dispatch({ number: 11, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before we start observing heartbeats");
    const pid = (s as unknown as { lanes: Map<string, { child: { pid?: number } }> }).lanes.get(name)!.child.pid!;
    // While genuinely alive: at least one heartbeat lands (the lane does nothing else
    // state-worthy while just sleeping, so this is a direct test of the liveness guard passing).
    await waitFor(() => state.eventsAfterId(0, ["worker-heartbeat"]).length > 0, "no worker-heartbeat while the child was genuinely alive");
    const beforeKillCount = state.eventsAfterId(0, ["worker-heartbeat"]).length;
    // Kill the child OUTSIDE the lane's own tracked lifecycle (no onExit, no lane cleanup) — the
    // same shape as this issue's live incident: the process is gone, but the engine's own
    // bookkeeping doesn't know yet (a lost exit notification). heartbeatTick keeps firing on its
    // setInterval regardless; only the liveness guard can tell the difference.
    process.kill(pid, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false; // still alive by the OS's own account — keep waiting
      } catch {
        return true; // confirmed dead
      }
    }, "the killed child never actually died");
    const countAtDeath = state.eventsAfterId(0, ["worker-heartbeat"]).length;
    await sleep(80); // several more heartbeatMs cadences' worth of real time
    const countAfterWaiting = state.eventsAfterId(0, ["worker-heartbeat"]).length;
    assert.ok(beforeKillCount > 0, "sanity: heartbeats fired while genuinely alive");
    assert.equal(
      countAfterWaiting,
      countAtDeath,
      "no FURTHER worker-heartbeat events were appended once the child was confirmed dead, even though the setInterval kept firing",
    );
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces worker timeout: a run past timeoutSec is killed and marked failed (Codex R2 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n"); // ignores TERM -> needs the KILL
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    let fakeNowMs = Date.now();
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 20,
      guardHookPath: mkHook(dir),
      now: () => new Date(fakeNowMs),
    });
    const { name } = await s.dispatch({ number: 5, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before timeout");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    fakeNowMs += (tcfg.worker.timeoutSec + 1) * 1000;
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "timed-out worker marked failed");
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "timed-out worker process killed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #33: soft per-worker budget auto-enforcement via live token estimation ──

test("#33: crossing worker.budgetUsdSoft mid-run triggers requestHandoff exactly once, and the lane ends up .handoff (graceful), never .failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Emits one streamed assistant usage line big enough to cross a tiny budget, then sleeps
    // with no TERM trap (the empirically-confirmed real CLI shape, #60) so the SIGTERM the
    // budget check fires actually ends the process and lets onExit write the sentinel.
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    // opus: $5/MTok input + $25/MTok output -> 1000 in + 1000 out = $0.005 + $0.025 = $0.03,
    // comfortably over a $0.01 soft budget.
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 0.01 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    let handoffCalls = 0;
    const original = s.requestHandoff.bind(s);
    s.requestHandoff = (name: string) => {
      handoffCalls++;
      return original(name);
    };
    const { name } = await s.dispatch({ number: 33, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "soft-budget crossing led to a graceful .handoff");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)), "never a hard-kill .failed for a budget-triggered handoff");
    // The terminal sentinel means onExit cleared the heartbeat interval, so the count is final.
    assert.equal(handoffCalls, 1, "requestHandoff fired exactly once for the soft-budget crossing");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33: a cache-heavy stream under budget does NOT trigger a handoff -- cache reads are priced at the cache-read rate, not the input rate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // 1,000,000 cache-read tokens at opus's cache-read rate (~$0.50/MTok) is ~$0.50 --
    // comfortably under a $2 budget. Priced (WRONGLY) at the input rate ($5/MTok) it would be
    // ~$5.00 and cross the budget on the very first heartbeat tick -- exactly the cache-heavy
    // over-trigger failure mode #33 flags.
    const usageLine = `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000000}}}`;
    const { bin, ready } = longRunningStub(dir, `echo '${usageLine}'\n`);
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 2 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 34, title: "t", labels: [] });
    await waitForFile(ready, "cache-heavy usage was flushed before checking the budget");
    assert.ok(readFileSync(join(dir, `${name}.jsonl`), "utf8").includes(usageLine));
    await waitForHeartbeatTick(join(dir, `${name}.heartbeat`));
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "cache-heavy run under budget must NOT hand off");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33 (PR #85 review): a broken worker.pricingFile fails at SUPERVISOR CONSTRUCTION (fail-closed, before any dispatch), naming the path — and a valid custom file's rates actually drive the budget check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Fail-closed: constructing the supervisor with a missing pricingFile throws immediately.
    const badCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { pricingFile: "/nonexistent/rates.yaml" },
    });
    assert.throws(
      () => new WorkerSupervisor({ now: realClock, cfg: badCfg, stateDir: dir, claudeBin: "claude", guardHookPath: mkHook(dir) }),
      /\/nonexistent\/rates\.yaml/,
    );

    // And a VALID custom table is what the budget check prices against: rates 100x the
    // shipped defaults make a tiny usage line cross a budget the default table wouldn't.
    const ratesPath = join(dir, "expensive.yaml");
    writeFileSync(ratesPath, "models: { opus: { input: 500, output: 2500, cacheWrite: 625, cacheRead: 50, contextWindow: 200000 } }\n");
    // 1000 in + 1000 out at 100x rates = $3.00; the shipped table would price it $0.03 —
    // under this $1 budget. A handoff proves the CUSTOM table is in effect.
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const cfgCustom = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 1, pricingFile: ratesPath },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: cfgCustom,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 35, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "custom pricingFile rates drove the soft-budget handoff");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33 (gate② P1): resume() over a jsonl already past budgetUsdSoft does NOT instantly re-handoff — the soft budget bounds spend PER RUN; new post-resume usage crossing it again MUST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-33-resume";
    // Fabricate a budget-triggered handed-off lane: a .handoff sentinel + a preserved jsonl
    // whose PRE-EXISTING assistant lines already exceed the $0.01 budget (1000 in + 1000 out
    // on opus ≈ $0.03). resume() appends to this same file — without a baseline, the first
    // heartbeat tick after resume would read ≥ budget and hand off again, forever.
    writeFileSync(
      join(dir, `${name}.handoff.json`),
      JSON.stringify({ name, issue: 33, session_id: "11111111-1111-1111-1111-111111111111", total_cost_usd: 0 }),
    );
    const preExisting = `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`;
    writeFileSync(join(dir, `${name}.jsonl`), preExisting);
    // The resumed stub waits for the test to prove a heartbeat checked the pre-existing spend,
    // then emits NEW usage that crosses the budget again.
    const ready = join(dir, "stub-ready");
    const emitNewUsage = join(dir, "emit-new-usage");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `touch "${ready}"`,
        `while [ ! -f "${emitNewUsage}" ]; do sleep 0.02; done`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 0.01 },
    });
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    await s.resume({ number: 33, title: "t", labels: [] }, name);
    await waitForFile(ready, "resumed stub reached its pre-new-usage wait");
    await waitForHeartbeatTick(join(dir, `${name}.heartbeat`));
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "pre-handoff spend alone must NOT re-trigger a handoff after resume");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    writeFileSync(emitNewUsage, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "new post-resume spend crossing the budget triggers a fresh graceful handoff");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #155: per-probe lane telemetry (priced-cost snapshot, context size, token composition) ──

test("#155: probe() persists the live telemetry trio (estCostUsd, contextTokens, tokenComposition) computed from the jsonl-so-far", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 155, title: "t", labels: [] });
    // No heartbeat wait needed — probe() re-derives the trio fresh from the jsonl on every call.
    // Poll until BOTH streamed lines have landed (contextTokens reflects only the newest one).
    let p = await s.probe(name);
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 2010; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.ok(p.liveTelemetry, "a still-running in-memory lane carries live telemetry");
    // opus: input $5/MTok, output $25/MTok, cacheRead $0.5/MTok (shipped pricing.yaml).
    // Line 1: 100in+50out -> 0.0005 + 0.00125 = 0.00175
    // Line 2: 10in+5out+2000cacheRead -> 0.00005 + 0.000125 + 0.001 = 0.001175
    const expectedCost = 0.00175 + 0.001175;
    assert.ok(Math.abs(p.liveTelemetry!.estCostUsd - expectedCost) < 1e-9, `estCostUsd ${p.liveTelemetry!.estCostUsd} ~= ${expectedCost}`);
    // contextTokens: the NEWEST assistant message's input + cache_read + cache_creation only.
    assert.equal(p.liveTelemetry!.contextTokens, 10 + 2000 + 0);
    // tokenComposition: cumulative 4-class split across BOTH streamed messages.
    assert.deepEqual(p.liveTelemetry!.tokenComposition, {
      inputTokens: 110,
      outputTokens: 55,
      cacheCreationTokens: 0,
      cacheReadTokens: 2000,
    });
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #287 (E4b, AC#1): probe()'s early actual-model signal ──────────────────────────────────────

test("#287: probe() reports actualModel from the session-init line's own self-report, as soon as it's observed — the earliest available signal, well before any terminal reclaim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"system","subtype":"init","model":"claude-opus-4-8"}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 287, title: "t", labels: [] });
    let p = await s.probe(name);
    for (let i = 0; i < 200 && p.actualModel == null; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.equal(p.actualModel, "claude-opus-4-8");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#287: probe() reports no actualModel before the init line has landed (honest 'not yet observed', never a guess)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, [`#!/usr/bin/env bash`, `for _ in $(seq 1 600); do sleep 1; done`, ``].join("\n"));
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 288, title: "t", labels: [] });
    const p = await s.probe(name);
    assert.equal(p.actualModel, undefined);
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: contextTokens is deliberately NON-monotonic — a later, smaller assistant message (an auto-compact) drops it, never a running max", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const marker = join(dir, "emit-second");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        // Large first turn: a big context.
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":50000,"output_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        // Wait for the test to observe the large value before compacting.
        `while [ ! -f "${marker}" ]; do sleep 0.02; done`,
        // Small second turn (post-compaction context is much smaller).
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":500,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 156, title: "t", labels: [] });
    let p = await s.probe(name);
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 50000; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.equal(p.liveTelemetry?.contextTokens, 50000, "large first turn -> large context");
    writeFileSync(marker, "");
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 500; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.equal(p.liveTelemetry?.contextTokens, 500, "smaller second turn DROPS contextTokens — never smoothed into a running max");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: a resumed lane's persisted estCostUsd covers only the CURRENT leg (reuses the #33 baseline) — pre-handoff usage alone must not show as live cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-155-resume";
    writeFileSync(
      join(dir, `${name}.handoff.json`),
      JSON.stringify({ name, issue: 157, session_id: "22222222-2222-2222-2222-222222222222", total_cost_usd: 0 }),
    );
    // Pre-existing (pre-handoff) usage: opus 1000in+1000out ≈ $0.03 — would show as live cost
    // if the baseline weren't subtracted.
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
    );
    const marker = join(dir, "emit-new-usage");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `while [ ! -f "${marker}" ]; do sleep 0.02; done`,
        // New post-resume usage: opus 200in+0out -> $0.001.
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    await s.resume({ number: 157, title: "t", labels: [] }, name);
    // Right after resume, before the stub emits anything new: the whole-file total already
    // includes the pre-handoff line, but the baseline snapshot cancels it out.
    const p1 = await s.probe(name);
    assert.ok(p1.liveTelemetry, "resumed lane is tracked in-memory too");
    assert.ok(
      Math.abs(p1.liveTelemetry!.estCostUsd) < 1e-9,
      `pre-handoff spend must not leak into the resumed leg's live cost (got ${p1.liveTelemetry!.estCostUsd})`,
    );
    writeFileSync(marker, "");
    let p2 = await s.probe(name);
    for (let i = 0; i < 200 && !(p2.liveTelemetry && p2.liveTelemetry.estCostUsd > 0); i++) {
      await sleep(20);
      p2 = await s.probe(name);
    }
    const expectedNewLegCost = (200 / 1_000_000) * 5; // opus input rate
    assert.ok(
      Math.abs(p2.liveTelemetry!.estCostUsd - expectedNewLegCost) < 1e-9,
      `new-leg estCostUsd ${p2.liveTelemetry!.estCostUsd} ~= ${expectedNewLegCost}`,
    );
    // contextTokens/tokenComposition are NOT baseline-adjusted — they read the whole jsonl-so-far
    // (resume APPENDS), so they include the pre-handoff line too.
    assert.equal(p2.liveTelemetry!.contextTokens, 200); // newest message only
    assert.deepEqual(p2.liveTelemetry!.tokenComposition, {
      inputTokens: 1200,
      outputTokens: 1000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: a DETACHED lane (no in-memory handle) carries no live telemetry — never invents a second baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-155-detached";
    writeFileSync(
      join(dir, `${name}.running.json`),
      JSON.stringify({ name, issue: 158, session_id: "s", wrapper_pid: 999999, started_at: new Date().toISOString() }),
    );
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
    );
    const s = sup(dir, "claude"); // no dispatch/resume -> no in-memory Lane for this name
    const p = await s.probe(name);
    assert.equal(p.liveTelemetry, undefined, "a detached lane has no known baseline -> no live telemetry, never a guessed one");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #168: environment-failure failureText capture — probe() reads the SAME jsonl already used
//    for terminalCostUsd/terminalModelUsage (no new capture mechanism), only for a FAILED lane.

test("#168: probe() of a FAILED lane surfaces failureText from the jsonl (stdout+stderr merged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-failed";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0, exit_code: 1 }));
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"system","subtype":"init"}\n` +
        `API Error: 429 too many requests — rate_limit_error\n` + // raw stderr, non-JSON line
        `{"type":"result","subtype":"error","is_error":true,"result":"request failed"}\n`,
    );
    const s = sup(dir, "claude"); // no live process — a static terminal sentinel + jsonl is enough
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.ok(p.failureText?.includes("429 too many requests"), "raw non-JSON stderr lines are captured, not just parsed JSON fields");
    assert.ok(p.failureText?.includes("rate_limit_error"));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168: probe() of a DONE (non-failed) lane never populates failureText", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-done";
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0.01, exit_code: 0 }),
    );
    writeFileSync(join(dir, `${name}.jsonl`), `{"type":"result","subtype":"success","total_cost_usd":0.01}\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.done, true);
    assert.equal(p.failureText, undefined);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168: failureText is tail-capped for a large jsonl — the classifiable error near the end still comes through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-tail";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0 }));
    const padding = "x".repeat(10_000);
    writeFileSync(join(dir, `${name}.jsonl`), `${padding}\nCould not resolve host: github.com\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.ok(p.failureText && p.failureText.length <= 4000, "capped, not the whole 10k+ jsonl");
    assert.ok(p.failureText?.includes("Could not resolve host"), "the tail (where the error actually is) survives the cap");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #247/#601: a DONE-or-FAILED lane's resultText capture — probe() reads the SAME per-leg
//    jsonl slice terminalCostUsd/terminalModelUsage's jsonl-fallback already reads
//    (currentLegJsonl). A fix leg's structured threadResponses block lives here for a DONE lane;
//    a plain refusal/hand-back message lives here for either a DONE or a FAILED lane (#601).

test("#247: probe() of a DONE lane surfaces resultText from the jsonl's final structured result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-done";
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0.01, exit_code: 0 }),
    );
    const resultText = '<<<SAPWOOD_RESULT>>>\n{"threadResponses":[]}\n<<<END_SAPWOOD_RESULT>>>';
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","total_cost_usd":0.01,"result":${JSON.stringify(resultText)}}\n`,
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.done, true);
    assert.equal(p.resultText, resultText);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#601: probe() of a FAILED (non-DONE) lane ALSO populates resultText — the worker's own stated reason, same as a DONE lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-failed";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0 }));
    writeFileSync(join(dir, `${name}.jsonl`), `{"type":"result","subtype":"error","is_error":true,"result":"some text"}\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.equal(p.resultText, "some text");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#247: resultText is scoped to the CURRENT LEG's jsonl offset — a resumed fix leg's own final message, never an earlier leg's superseded result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-leg";
    const legOneLine = `{"type":"result","subtype":"success","total_cost_usd":0.01,"result":"leg one final message — stale"}\n`;
    const legOneBytes = Buffer.byteLength(legOneLine, "utf8");
    const legTwoResult = '<<<SAPWOOD_RESULT>>>\n{"threadResponses":[]}\n<<<END_SAPWOOD_RESULT>>>';
    const legTwoLine = `{"type":"result","subtype":"success","total_cost_usd":0.02,"result":${JSON.stringify(legTwoResult)}}\n`;
    writeFileSync(join(dir, `${name}.jsonl`), legOneLine + legTwoLine);
    writeFileSync(
      join(dir, `${name}.running.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", dispatched_at: new Date().toISOString(), jsonl_leg_offset: legOneBytes }),
    );
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0.02, exit_code: 0 }),
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.resultText, legTwoResult, "only the SECOND (current) leg's result text — the first leg's is never leaked through");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #168 (PR #180 review P1-3): failureText is built from STRUCTURED error records only —
//    NEVER assistant message content. A worker legitimately WORKING ON rate-limit handling
//    prints the exact signature strings as part of doing its job; that must never park the
//    engine on an ordinary task failure.

test("extractFailureText: assistant/user/system records and SUCCESSFUL results are excluded; stderr lines + errored results + error records are included", () => {
  const jsonl = [
    `{"type":"system","subtype":"init","model":"opus"}`,
    `{"type":"assistant","message":{"content":[{"type":"text","text":"I will add handling for rate_limit_error and 429 Too Many Requests"}]}}`,
    `{"type":"user","message":{"content":"also handle Could not resolve host"}}`,
    `gh: Bad credentials (HTTP 401)`, // raw stderr — included
    `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, // API error record — included
    `{"type":"result","subtype":"success","result":"clean run mentioning usage limit reached","total_cost_usd":0.1}`, // successful result — excluded
    `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"request failed"}`, // errored result — included
  ].join("\n");
  const out = extractFailureText(jsonl);
  assert.ok(out.includes("gh: Bad credentials"));
  assert.ok(out.includes("overloaded_error"));
  assert.ok(out.includes("[error_during_execution] request failed"));
  assert.ok(!out.includes("429 Too Many Requests"), "assistant content is NEVER included");
  assert.ok(!out.includes("Could not resolve host"), "user content is NEVER included");
  assert.ok(!out.includes("usage limit reached"), "a successful result's text is NEVER included");
});

test("extractFailureText: an unparseable {-prefixed line (mid-write stream fragment, possibly of an assistant message) is SKIPPED, never included", () => {
  const truncatedAssistant = `{"type":"assistant","message":{"content":[{"type":"text","text":"discussing rate_limit_error and how`;
  assert.equal(extractFailureText(truncatedAssistant), "");
});

// ── #374: extractRateLimitResetAt — the Claude CLI's structured rate_limit_event telemetry ────

/** #403 (F25): the seeded "now" every extractRateLimitResetAt case below is judged against. The
 *  function's sanity horizon compares the parsed hint to this value, so leaving it to the real
 *  clock would make each case's verdict a function of the day the suite runs. */
const RL_NOW_MS = Date.parse("2026-07-24T00:00:00Z");

test("extractRateLimitResetAt: a real captured rate_limit_event line yields resetsAt in epoch MILLISECONDS", () => {
  const jsonl = [
    `{"type":"system","subtype":"init","model":"opus"}`,
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1784885400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"session_id":"s1"}`,
    `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 6:30pm (Asia/Tokyo)","total_cost_usd":0}`,
  ].join("\n");
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), 1784885400 * 1000);
});

test("extractRateLimitResetAt: no rate_limit_event line -> null (an absent hint, never a fabricated one)", () => {
  const jsonl = [`{"type":"system","subtype":"init"}`, `gh: Bad credentials (HTTP 401)`].join("\n");
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), null);
});

test("extractRateLimitResetAt: a non-'rejected' status (e.g. an 'allowed' telemetry line) is ignored", () => {
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784885400,"rateLimitType":"five_hour"}}`;
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), null);
});

test("extractRateLimitResetAt: the LAST rejected record wins when more than one appears", () => {
  const jsonl = [
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1000}}`,
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":2000}}`,
  ].join("\n");
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), 2000 * 1000);
});

test("extractRateLimitResetAt: malformed/truncated JSON lines and a missing rate_limit_info are tolerated, never throw", () => {
  const jsonl = [`{"type":"rate_limit_event"`, `{"type":"rate_limit_event","rate_limit_info":null}`, "not json at all"].join("\n");
  assert.doesNotThrow(() => extractRateLimitResetAt(jsonl, RL_NOW_MS));
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), null);
});

test("extractRateLimitResetAt: empty input -> null", () => {
  assert.equal(extractRateLimitResetAt("", RL_NOW_MS), null);
});

// ── #374 review (PM P2): the sanity horizon — an untrusted third-party timestamp must never be
//    able to withhold every future probe permanently. ──────────────────────────────────────────

test("extractRateLimitResetAt: a hint within the 48h horizon is honored", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  const resetsAtSec = Math.floor(nowMs / 1000) + 6 * 3600; // 6h out — a real five_hour-ish tier
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAtSec}}}`;
  assert.equal(extractRateLimitResetAt(jsonl, nowMs), resetsAtSec * 1000);
});

test("extractRateLimitResetAt: resetsAt accidentally in epoch-MILLISECONDS scale (a units mismatch) lands ~1000x too far out -> treated as ABSENT (null), never a centuries-long stall", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  // A real epoch-ms value (already ~1784885400000) misread as seconds and re-multiplied by 1000
  // by this function lands far beyond the 48h horizon — exactly the failure mode the horizon
  // check exists to catch, regardless of which specific unit confusion produced it.
  const msMistakenForSeconds = 1784885400000;
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${msMistakenForSeconds}}}`;
  assert.equal(extractRateLimitResetAt(jsonl, nowMs), null);
});

test("extractRateLimitResetAt: a hint exactly AT the 48h horizon is honored; one second past it is rejected", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  const atHorizonSec = Math.floor(nowMs / 1000) + 48 * 3600;
  const pastHorizonSec = atHorizonSec + 1;
  const atJsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${atHorizonSec}}}`;
  const pastJsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${pastHorizonSec}}}`;
  assert.equal(extractRateLimitResetAt(atJsonl, nowMs), atHorizonSec * 1000);
  assert.equal(extractRateLimitResetAt(pastJsonl, nowMs), null);
});

test("extractRateLimitResetAt: a hint in the PAST (already-elapsed reset) is honored unchanged — only an over-future hint is rejected", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  const pastSec = Math.floor(nowMs / 1000) - 3600; // 1h ago
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${pastSec}}}`;
  assert.equal(extractRateLimitResetAt(jsonl, nowMs), pastSec * 1000);
});

// ── #374 review (Codex sol-high finding 8): the horizon clamp only bounds the FUTURE side — a
//    corrupted resetsAt (e.g. -1e20) sits arbitrarily far in the PAST and must never survive to
//    reach a downstream `new Date(...).toISOString()` call, which THROWS on an Invalid Date. ────

test("extractRateLimitResetAt: a wildly corrupted resetsAt (-1e20) is outside JS's valid Date range -> rejected (null), never a value that would crash a downstream toISOString()", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":-1e20}}`;
  const result = extractRateLimitResetAt(jsonl, nowMs);
  assert.equal(result, null);
});

test("extractRateLimitResetAt: a Date-valid but ancient value (millennia in the past) is still honored — only OUT-OF-RANGE values are rejected, not merely large-magnitude-but-legal ones", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  // ~8000 years before the epoch in seconds, comfortably within Date's ~273,790-year range once
  // converted to ms — legal, just very old; probeDueWithHint reads this as "probe immediately".
  const ancientSec = -8000 * 365 * 24 * 3600;
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${ancientSec}}}`;
  const result = extractRateLimitResetAt(jsonl, nowMs);
  assert.equal(result, ancientSec * 1000);
  assert.doesNotThrow(() => new Date(result!).toISOString());
});

test("extractRateLimitResetAt: a resetsAt exactly at the Date-valid boundary is honored; one unit past it is rejected", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00Z");
  const validBoundarySec = 8_640_000_000_000_000 / 1000; // exactly at the ECMAScript Date limit
  const pastBoundarySec = validBoundarySec + 1;
  const validJsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${validBoundarySec}}}`;
  const invalidJsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${pastBoundarySec}}}`;
  // The boundary value itself is far beyond the 48h future horizon, so it's rejected on THAT
  // basis too — this test only asserts neither call throws and the out-of-range one is null.
  assert.doesNotThrow(() => extractRateLimitResetAt(validJsonl, nowMs));
  assert.equal(extractRateLimitResetAt(invalidJsonl, nowMs), null);
});

// ── #394 (F22): hasRejectedRateLimitEvent — the structured, text-free classification signal ──

test("hasRejectedRateLimitEvent: a real captured rejected rate_limit_event line -> true", () => {
  const jsonl =
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1784885400,"rateLimitType":"five_hour",` +
    `"overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"session_id":"s1"}`;
  assert.equal(hasRejectedRateLimitEvent(jsonl), true);
});

test("hasRejectedRateLimitEvent: no rate_limit_event line at all -> false", () => {
  const jsonl = `{"type":"assistant","message":{}}\n{"type":"result","subtype":"success","result":"ok"}`;
  assert.equal(hasRejectedRateLimitEvent(jsonl), false);
});

test("hasRejectedRateLimitEvent: a non-'rejected' status (e.g. 'allowed') is ignored -> false", () => {
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784885400}}`;
  assert.equal(hasRejectedRateLimitEvent(jsonl), false);
});

test("hasRejectedRateLimitEvent: true EVEN WITHOUT a resetsAt field — the rejection itself is the signal, not the reset hint", () => {
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}`;
  assert.equal(hasRejectedRateLimitEvent(jsonl), true);
});

test("hasRejectedRateLimitEvent: true even when resetsAt is malformed/out-of-range — extractRateLimitResetAt's sanity horizon is a SCHEDULING concern, not a classification one", () => {
  const jsonl = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":-1e20}}`;
  assert.equal(hasRejectedRateLimitEvent(jsonl), true);
  assert.equal(extractRateLimitResetAt(jsonl, RL_NOW_MS), null, "sanity check: the scheduling hint itself IS rejected as out-of-range");
});

test("hasRejectedRateLimitEvent: malformed/truncated JSON lines and a missing rate_limit_info are tolerated, never throw", () => {
  const jsonl = [`{"type":"rate_limit_event"`, `{"type":"rate_limit_event","rate_limit_info":null}`, "not json at all"].join("\n");
  assert.doesNotThrow(() => hasRejectedRateLimitEvent(jsonl));
  assert.equal(hasRejectedRateLimitEvent(jsonl), false);
});

test("hasRejectedRateLimitEvent: empty input -> false", () => {
  assert.equal(hasRejectedRateLimitEvent(""), false);
});

// ── #394 gate② round 3 (Codex sol-high BLOCK finding, P2): hasQuotaErrorStatus — the SECOND
//    structured, text-free classification signal (an errored `result` record carrying the
//    transport-level `api_error_status:429`), needed because NOT every real quota failure emits
//    a `rate_limit_event` line (a real captured transcript proves this — see the fixture below,
//    the exact shape extractRateLimitResetAt's own #374 test already uses). ────────────────────

test("hasQuotaErrorStatus: a real captured errored-result record (is_error:true, api_error_status:429) -> true", () => {
  const jsonl = `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 6:30pm (Asia/Tokyo)","total_cost_usd":0}`;
  assert.equal(hasQuotaErrorStatus(jsonl), true);
});

test("hasQuotaErrorStatus: no result line at all -> false", () => {
  const jsonl = `{"type":"assistant","message":{}}\n{"type":"system","subtype":"init"}`;
  assert.equal(hasQuotaErrorStatus(jsonl), false);
});

test("hasQuotaErrorStatus: a SUCCESSFUL result (is_error absent/false) with api_error_status:429 present anyway is ignored -> false — is_error alone gates inclusion", () => {
  const jsonl = `{"type":"result","subtype":"success","is_error":false,"api_error_status":429,"result":"ok"}`;
  assert.equal(hasQuotaErrorStatus(jsonl), false);
});

test("hasQuotaErrorStatus: an errored result with a DIFFERENT api_error_status (e.g. 500) is NOT a quota signal -> false", () => {
  const jsonl = `{"type":"result","is_error":true,"api_error_status":500,"result":"internal server error"}`;
  assert.equal(hasQuotaErrorStatus(jsonl), false);
});

test("hasQuotaErrorStatus: api_error_status as a STRING ('429', not the number 429) DOES match — accepted defensively (no capture has shown this shape; the string has no other possible meaning in this field)", () => {
  const jsonl = `{"type":"result","is_error":true,"api_error_status":"429","result":"..."}`;
  assert.equal(hasQuotaErrorStatus(jsonl), true);
});

test("hasQuotaErrorStatus: malformed/truncated JSON lines are tolerated, never throw", () => {
  const jsonl = [`{"type":"result"`, `{"type":"result","is_error":true`, "not json at all"].join("\n");
  assert.doesNotThrow(() => hasQuotaErrorStatus(jsonl));
  assert.equal(hasQuotaErrorStatus(jsonl), false);
});

test("hasQuotaErrorStatus: empty input -> false", () => {
  assert.equal(hasQuotaErrorStatus(""), false);
});

// ── #394 gate② round 3: the EXACT gap this second signal closes (Codex's own concrete trace) —
//    an errored 429 result whose human-readable text uses an UNLISTED tier word ("monthly", not
//    session/weekly/5-hour) and carries NO rate_limit_event line anywhere. Before this signal
//    existed, classifyEnvFailure would have missed this entirely (no structured match, no text
//    pattern match) and treated it as an ordinary task failure — UNBOUNDED on the worker-lane
//    path (see env-failure.ts's own module doc for why the empty-spin breaker does not cover
//    that path). ─────────────────────────────────────────────────────────────────────────────

test("#394 gate② round 3 (Codex's concrete trace): is_error:true + api_error_status:429 + an UNLISTED tier word ('monthly') + NO rate_limit_event line -> classifies as llm via the SECOND structured signal alone", () => {
  const jsonl = `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your monthly limit · resets Aug 1","total_cost_usd":0}`;

  // The extraction-level proof: the rejected-event signal is genuinely absent (no rate_limit_event
  // line at all in this jsonl) — only the second signal fires.
  assert.equal(hasRejectedRateLimitEvent(jsonl), false, "no rate_limit_event line exists in this jsonl");
  assert.equal(hasQuotaErrorStatus(jsonl), true, "the errored 429 result record is present");

  // The text-pattern fallback would ALSO miss this (proving the second structured signal is
  // doing real work here, not just duplicating what the text list already catches): "monthly"
  // is not in DEFAULT_LLM_FAILURE_PATTERNS' enumerated tier alternation.
  const failureText = extractFailureText(jsonl);
  const patterns = { llm: [...DEFAULT_LLM_FAILURE_PATTERNS], forge: [...DEFAULT_FORGE_FAILURE_PATTERNS] };
  assert.equal(
    classifyEnvFailure(failureText, patterns),
    null,
    "sanity check: the TEXT alone, without any structured signal, does not classify",
  );

  // The full pipeline, as a real caller assembles it (worker.ts's terminalEnvSignalStructured /
  // the peripheral-session equivalent): OR the two structured signals, pass the result as the
  // 3rd argument.
  const structuredSignal = hasRejectedRateLimitEvent(jsonl) || hasQuotaErrorStatus(jsonl);
  assert.equal(classifyEnvFailure(failureText, patterns, structuredSignal), "llm");
});

test("#394 gate② round 3: the negative counterpart — an errored result with NO 429 status and text matching NO listed tier word stays unclassified (an ordinary task failure, not llm)", () => {
  const jsonl = `{"type":"result","is_error":true,"api_error_status":500,"result":"internal server error, please retry"}`;

  assert.equal(hasRejectedRateLimitEvent(jsonl), false);
  assert.equal(hasQuotaErrorStatus(jsonl), false, "500, not 429 — not a quota signal");

  const failureText = extractFailureText(jsonl);
  const patterns = { llm: [...DEFAULT_LLM_FAILURE_PATTERNS], forge: [...DEFAULT_FORGE_FAILURE_PATTERNS] };
  const structuredSignal = hasRejectedRateLimitEvent(jsonl) || hasQuotaErrorStatus(jsonl);
  assert.equal(
    classifyEnvFailure(failureText, patterns, structuredSignal),
    null,
    "neither structured signal fired and the text matches no configured pattern -> an ordinary, unclassified task failure",
  );
});

test("#168 P1-3 contractual negative: exact configured signatures inside ASSISTANT text + a non-env failure -> task failure, no env classification, no park", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-neg";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0 }));
    // A worker FIXING rate-limit handling: its assistant messages carry the exact signature
    // strings verbatim; the actual failure is an ordinary failing test.
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"content":[{"type":"text","text":"Testing the retry path for rate_limit_error, 429 too many requests, usage limit reached, and Could not resolve host"}]}}\n` +
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"AssertionError: retry test failed — expected 3 retries, got 0"}\n`,
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.ok(!p.failureText?.includes("rate_limit_error"), "the assistant's signature strings never reach failureText");
    assert.equal(
      classifyEnvFailure(p.failureText ?? "", {
        llm: [...DEFAULT_LLM_FAILURE_PATTERNS],
        forge: [...DEFAULT_FORGE_FAILURE_PATTERNS],
      }),
      null,
      "an ordinary task failure whose assistant text discusses the signatures classifies as a TASK failure",
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast non-zero exit writes .failed (exit handler attached before the await) — Codex R2 P2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 3\n`); // exits immediately, like the CLI rejecting args
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] }, "lane-fast");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "fast exit still recorded a .failed sentinel");
    const probe = await s.probe(name);
    assert.equal(probe.failed, true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #69: the drain contract is sentinel-only — the supervisor NEVER runs git in a worker
// worktree (that's #65's clean-filter RCE class, deleted at the root). Resumability =
// `claude --resume <session_id>` reusing the untouched worktree in place. ────────────────

test("#69: drain (SIGTERM) -> .handoff sentinel carries the session_id, NO git subprocess is spawned, and the worktree is left byte-for-byte untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  const shimDir = mkdtempSync(join(tmpdir(), "sapwood-gitshim-"));
  const gitLog = join(shimDir, "git-invocations.log");
  const oldPath = process.env.PATH;
  try {
    // Exec spy: a `git` shim FIRST on PATH — any git subprocess the supervisor (or anything
    // it spawns) launches during the drain would append here. The invariant: it never does.
    writeFileSync(join(shimDir, "git"), `#!/usr/bin/env bash\necho "$@" >> "${gitLog}"\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${oldPath}`;

    const name = "lane-69-a";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted work\n"); // WIP at kill time

    // The empirically-confirmed real CLI shape (#60): no SIGTERM trap -> dies by signal.
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName, sessionId } = await s.dispatch({ number: 69, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub reached its running state before drain");
    assert.equal(s.requestHandoff(laneName), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), ".handoff written despite a signal-killed exit");
    assert.ok(!existsSync(join(dir, `${laneName}.failed.json`)));

    const sentinel = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(sentinel.session_id, sessionId, "sentinel carries the resumable session_id");

    assert.ok(!existsSync(gitLog), "NO git subprocess was spawned during the drain");
    assert.equal(readFileSync(join(worktreePath, "wip.txt"), "utf8"), "uncommitted work\n", "worktree untouched");

    s.dispose();
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("#69 grep-invariant (engine-wide, fable P3; extended #284, #285, #443): the ONLY child_process importers are worker.ts (spawn), gh.ts (execFile), review/materializer.ts (execFile), and review/codex-exec.ts (spawn, gate②'s cross-vendor review runner) — and the ONLY subprocess call site that may ever pass a cwd is spawnClaudeSession's own OPTIONAL, caller-supplied opt (#285 review session mode) — WorkerSupervisor's own dispatch()/resume() spawn() calls stay cwd-less, so the engine structurally CANNOT exec git in a worker worktree", () => {
  const srcDir = new URL("../", import.meta.url);
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  // Sanity: the four known subprocess modules are present in the scan set.
  assert.ok(
    files.includes("roles/worker.ts") &&
      files.includes("forge/gh.ts") &&
      files.includes("review/materializer.ts") &&
      files.includes("review/codex-exec.ts"),
  );
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), "utf8");
    const importsChildProcess = /from "node:child_process"/.test(src);
    if (f === "roles/worker.ts") {
      // spawn ONLY (the claude CLI launch); every exec-style API (what #62's preserveHandoffWip
      // used) is banned — this pins the deletion.
      assert.match(src, /import \{ type ChildProcess, spawn \} from "node:child_process"/, "worker.ts imports spawn only");
      assert.doesNotMatch(src, /\b(execFileSync|execFile|execSync|spawnSync|exec)\b/, "worker.ts has no exec API");
      assert.doesNotMatch(src, /["'`]git["'`]/, "worker.ts references no `git` command");
      assert.doesNotMatch(src, /preserveHandoffWip|runGit|tryGit|noHooksDir/, "deleted helpers not stranded");
      // #285: spawnClaudeSession — the ONE shared primitive peripheral.ts's review-session path
      // uses — may now take an OPTIONAL `cwd` (an already-materialized review tree, never a
      // worker worktree). WorkerSupervisor's own dispatch()/resume() spawn() calls (the
      // code-producing WORKER path this invariant's title is actually about) must still NEVER
      // pass one: extracting spawnClaudeSession's function body and asserting `cwd:` appears
      // ONLY there (and only as the caller-supplied `opts.cwd`) keeps that half of the
      // invariant intact rather than just deleting the check.
      const fnStart = src.indexOf("export function spawnClaudeSession");
      assert.ok(fnStart > -1, "spawnClaudeSession must still be present");
      const fnEnd = src.indexOf("\nexport interface WorkerDeps", fnStart);
      assert.ok(fnEnd > fnStart, "spawnClaudeSession's body must end before the next top-level export (WorkerDeps)");
      const before = src.slice(0, fnStart);
      const fnBody = src.slice(fnStart, fnEnd);
      const after = src.slice(fnEnd);
      assert.doesNotMatch(
        before,
        /\bcwd:/,
        "no cwd anywhere before spawnClaudeSession (WorkerSupervisor's dispatch/resume spawns stay cwd-less)",
      );
      assert.doesNotMatch(
        after,
        /\bcwd:/,
        "no cwd anywhere after spawnClaudeSession (WorkerSupervisor's dispatch/resume spawns stay cwd-less)",
      );
      assert.match(fnBody, /\bcwd:\s*opts\.cwd\b/, "spawnClaudeSession's own cwd: is sourced ONLY from an explicit caller-supplied opt");
    } else if (f === "forge/gh.ts") {
      // execFile ONLY, no spawn/sync variants, and gh runs in the engine's own cwd (no cwd option).
      assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn)\b/, "gh.ts uses execFile only");
      assert.doesNotMatch(src, /\bcwd:/, "gh.ts passes no cwd to execFile");
    } else if (f === "review/materializer.ts") {
      // #284: a THIRD legitimate importer — the private-clone materializer invokes `git` itself
      // (clone/checkout/rev-parse), ENGINE-side, structurally outside every worker worktree
      // (never runs in a worker's worktree, never touches the shared repo's config). execFile
      // (async) ONLY, same discipline as gh.ts; every git target is passed via `-C`, never a
      // subprocess `cwd` option.
      assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn)\b/, "materializer.ts uses execFile only");
      // Object-literal `cwd:` (an execFile options property) is banned; a `cwd: string` TS
      // parameter annotation (this module's own `defaultPrivateCloneDir(cwd = process.cwd())`
      // helpers) is a different, unrelated thing and must not false-positive here.
      assert.doesNotMatch(src, /[{,]\s*cwd\s*:/, "materializer.ts passes no cwd option to execFile (uses -C instead)");
    } else if (f === "review/codex-exec.ts") {
      // #443: a FOURTH legitimate importer — gate②'s cross-vendor review runner spawns the local
      // `codex` CLI. Same discipline as the three above, plus the two properties that make its own
      // containment claims checkable rather than asserted in prose:
      //   - spawn ONLY (no exec/shell-string API can smuggle producer-influenced text into a shell);
      //   - its ONE `cwd:` is the caller-supplied materialized review tree, never anything derived
      //     locally — a codex session is structurally incapable of running in the engine's own
      //     checkout or in a worker worktree.
      assert.doesNotMatch(src, /\b(execFileSync|execFile|execSync|spawnSync|exec)\s*\(/, "codex-exec.ts uses spawn only");
      assert.doesNotMatch(src, /shell\s*:/, "codex-exec.ts never spawns through a shell");
      const cwdSites = src.match(/[{,]\s*cwd\s*:\s*[^,\n]+/g) ?? [];
      assert.deepEqual(
        cwdSites.map((s) => s.replace(/^[{,]\s*/, "").trim()),
        ["cwd: req.treeDir"],
        "codex-exec.ts's only subprocess cwd is the caller-supplied materialized tree",
      );
    } else {
      // Every other engine module must not shell out at all.
      assert.equal(importsChildProcess, false, `${f} must not import node:child_process`);
    }
  }
});

test("#69: timeout still tags .failed even if a handoff was already requested (timeout is a distinct, non-drain hard-kill path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Ignores TERM so it survives requestHandoff's SIGTERM; only the timeout's SIGKILL stops it.
    // #241 (same class of race as #229/PR #240): touch a ready-sentinel immediately after the
    // trap is installed, so requestHandoff's SIGTERM can never beat the trap. That alone still
    // left two real-time races on a real wall-clock timeoutSec (Codex second-opinion review):
    //   (a) the bounded trap-ready poll is itself real-time-unbounded under load -- if it ran
    //       long enough for the real timeout to fire FIRST, requestHandoff would never get a
    //       pending handoff to race against;
    //   (b) even a fast trap-ready could land inside killTree's own 200ms SIGTERM->SIGKILL grace,
    //       letting requestHandoff() return true AFTER timedOut was already set -- silently
    //       reversing "handoff pending, THEN timeout" (the ordering this test exists to pin
    //       down) while every assertion still happened to pass.
    // Both windows exist only because "elapsed since dispatch" was read off the real wall clock.
    // Fix: inject a fully controllable fake clock (WorkerSupervisor's `now` dep, already designed
    // for this) and DRIVE elapsed time explicitly instead of racing it:
    //   1. freeze the clock at dispatch, so elapsedSec is provably 0 no matter how long the real
    //      trap-ready handshake takes in wall-clock time -- the timeout branch cannot fire.
    //   2. confirm the trap, call requestHandoff(), and assert it returns true -- still provably
    //      BEFORE any timeout, since the fake clock has not moved.
    //   3. only THEN advance the fake clock past timeoutSec, and let the heartbeat timer (real,
    //      but fast) observe the new elapsed time and drive the hard-kill path.
    // This proves the exact ordering deterministically; the only remaining real-time waits are
    // monotonic bounded polls for effects that are certain to eventually happen (never a race
    // against a competing real deadline).
    // #241 (Codex delta confirm, P2): a finite `sleep 30` was still a theoretical real-time race
    // -- if the event loop stalled ~30s after the fake-clock advance, the stub would exit
    // NATURALLY (code 0) before heartbeatTick ever observed the new elapsed time, writing
    // .handoff (handoffRequested, not timedOut) instead of .failed. The 600s bounded loop
    // pushes that window far past any test lifetime (while still self-reaping a failure-path
    // orphan): within the test, the stub can only end via the timeout path's SIGKILL.
    const trapReady = join(dir, "trap-ready");
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\ntouch "${trapReady}"\nfor _ in $(seq 1 600); do sleep 1; done\n`);
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    let fakeNowMs = Date.now();
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 20, // real timer -- but the elapsed-time MATH below is driven by fakeNowMs, not by how fast this fires
      guardHookPath: mkHook(dir),
      now: () => new Date(fakeNowMs),
    });
    const { name: laneName } = await s.dispatch({ number: 63, title: "t", labels: [] });
    // Bounded poll (20ms x 400 = 8s ceiling, same pattern PR #240 used for its own trap-ready
    // handshake) for the trap to be provably installed. The fake clock is still frozen at
    // dispatch time here, so no matter how long this takes in real wall-clock time, the
    // supervisor's own elapsed-time math still reads exactly 0 -- the timeout branch structurally
    // cannot fire during this window (race (a), closed).
    for (let i = 0; i < 400 && !existsSync(trapReady); i++) await sleep(20);
    assert.ok(existsSync(trapReady), "stub's TERM trap was installed before requestHandoff's SIGTERM");
    // Still provably pre-timeout (elapsed reads 0): a pending handoff is established first.
    assert.equal(s.requestHandoff(laneName), true); // sets handoffRequested; the stub ignores this TERM
    // Only NOW advance the fake clock past timeoutSec -- the ordering (handoff pending, THEN
    // timeout) is asserted by construction, not raced (race (b), closed).
    fakeNowMs += (tcfg.worker.timeoutSec + 1) * 1000;
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.failed.json`)), "timeout wins over a pending handoff request");
    assert.ok(!existsSync(join(dir, `${laneName}.handoff.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #69 dirty-worktree retention: reclaim() deletes a worktree ONLY when provably clean
// (pure filesystem mtime heuristic — never a git call); possibly-dirty survives on disk. ──

test("#69: reclaim RETAINS a worktree with a file written after dispatch (possibly dirty) — left on disk for human salvage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-dirty";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(join(worktreePath, "src"), { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 70, title: "t", labels: [] }, name);
    await sleep(50); // ensure the WIP write lands strictly after the recorded lane start
    writeFileSync(join(worktreePath, "src", "wip.txt"), "uncommitted work\n");

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true);
    assert.equal(r.worktreePath, worktreePath); // absolute path, for the conductor's escalation
    assert.ok(existsSync(join(worktreePath, "src", "wip.txt")), "worktree (and its WIP) survives");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69: reclaim DELETES a clean worktree (no file touched since dispatch) — no retention noise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-clean";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "checked-out.txt"), "pre-existing\n"); // pre-dispatch content
    await sleep(20); // strictly before the lane's recorded start

    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 71, title: "t", labels: [] }, name);
    await waitForFile(ready);

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, false);
    assert.ok(!existsSync(worktreePath), "clean worktree removed as before");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69: reclaim of a lane with NO worktree on disk -> nothing retained, nothing to report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin); // default worktreeRoot -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 72, title: "t", labels: [] });
    await waitForFile(ready);
    const r = await s.reclaim(name);
    assert.deepEqual(r, { worktreePath: null, worktreeRetained: false });
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#69: DETACHED reclaim (post-restart, persisted pid) retains a dirty worktree using running.json's dispatched_at as the baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-det";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s1 = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s1.dispatch({ number: 73, title: "t", labels: [] }, name);
    await sleep(50);
    writeFileSync(join(worktreePath, "wip.txt"), "post-dispatch work\n"); // dirty
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin, worktreeRoot);
    const r = await s2.reclaim(laneName);
    assert.equal(r.worktreeRetained, true);
    assert.ok(existsSync(join(worktreePath, "wip.txt")), "worktree survives a detached reclaim too");
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (fable P1): a RESUMED lane that crashes does NOT lose pre-handoff WIP — the retention baseline is the immutable first-dispatch time, not the resume-time started_at", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-resume-wip";
    const ready = join(dir, "stub-ready");
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    // Cooperative worker: hands off on TERM. A --resume run just prints a result and exits.
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.02}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 74, title: "t", labels: [] }, name);
    await sleep(50);
    // Pre-handoff WIP: written DURING the first run, mtime after first dispatch.
    writeFileSync(join(worktreePath, "wip.txt"), "pre-handoff uncommitted work\n");
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(laneName), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), "handed off");
    // The handoff sentinel carried the immutable first-dispatch baseline forward.
    const handoff = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(typeof handoff.dispatched_at, "string", "dispatched_at persisted into the sentinel");

    // A long gap, then RESUME — the resumed run's started_at is now, AFTER the WIP's mtime.
    // #403 (F25): a DELIBERATE real-clock read (this lane runs on `realClock`). The assertion
    // below is pure MONOTONICITY — `dispatched_at` predates `started_at` — which is exactly the
    // case the issue says to leave alone: a seeded clock would make it vacuous, and the only way
    // it can fail is if the system clock runs backwards.
    await sleep(200);
    const resumed = await s.resume({ number: 74, title: "t", labels: [] }, name);
    assert.equal(resumed.name, name);
    // running.json's started_at moved to resume-time, but dispatched_at is the ORIGINAL.
    const running = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    assert.ok(Date.parse(running.dispatched_at) < Date.parse(running.started_at), "dispatched_at predates the resume start");

    // The resumed lane is reclaimed (crash / DEAD / escalation). Pre-handoff WIP has an mtime
    // BEFORE the resume start — baselining on started_at would judge it clean and DELETE it
    // (the exact silent loss fable reproduced). Baselining on dispatched_at retains it.
    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "resumed-then-crashed lane RETAINS its pre-handoff WIP");
    assert.ok(existsSync(join(worktreePath, "wip.txt")), "WIP file survives — not silently deleted");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (fable P2b): a file whose mtime is BACKDATED before dispatch still reads dirty via ctime — mtime-backdating cannot defeat retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-backdate";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 75, title: "t", labels: [] }, name);
    await sleep(50);
    const wip = join(worktreePath, "wip.txt");
    writeFileSync(wip, "uncommitted work\n"); // written after dispatch -> ctime is now
    // Backdate mtime+atime to the epoch (what `touch -t`/`touch -r .git/index` does). ctime is
    // NOT settable by utimes and stays at the write time (after dispatch).
    utimesSync(wip, new Date(0), new Date(0));

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "ctime still exceeds the baseline -> retained despite backdated mtime");
    assert.ok(existsSync(wip), "backdated WIP survives");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (Codex PR #72 round-2): a WIP entry whose mtime EQUALS dispatched_at exactly (same coarse-fs tick) reads dirty -> RETAINED, never deleted as clean (inclusive >= boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-sametick";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 76, title: "t", labels: [] }, name);
    await sleep(50);
    const wip = join(worktreePath, "wip.txt");
    writeFileSync(wip, "same-tick WIP\n");

    // Simulate the exact-equality tick deterministically. Pick a WHOLE-SECOND baseline in the
    // FUTURE and set the WIP file's mtime to exactly it. Whole-second matters: a modern-epoch
    // ms value loses sub-ms precision as a float (statMs = ns/1e6), so an arbitrary integer ms
    // reads back as e.g. …601.999 — never exactly equal to an integer baseline. A whole-second
    // instant has no sub-second part, so lstat's mtimeMs is an exact integer that round-trips
    // through the ISO dispatched_at. FUTURE so every ctime (pinned at write time, unsettable by
    // utimes) stays BELOW it, ruling out the ctime path. Under `>=` the file reads dirty
    // (mtime == baseline); under a strict `>` nothing exceeds the baseline -> deleted as clean.
    const baselineMs = (Math.floor(Date.now() / 1000) + 100) * 1000; // whole-second ms, future
    utimesSync(wip, new Date(baselineMs), new Date(baselineMs));
    assert.equal(lstatSync(wip).mtimeMs, baselineMs, "fs stored the exact whole-second mtime");
    const running = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    running.dispatched_at = new Date(baselineMs).toISOString();
    writeFileSync(join(dir, `${laneName}.running.json`), JSON.stringify(running));

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "mtime == baseline must be treated as dirty (>=), not clean");
    assert.ok(existsSync(wip), "same-tick WIP survives — not deleted as clean");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// ── #63: detached-lane handoff — probe() confirms death and finalizes (no onExit callback
// exists for a lane the engine only knows via a persisted running.json). #69: the finalize
// is sentinel-only now — no WIP commit/push, the worktree stays untouched. ──────────────────

test("#63/#69: detached handoff-requested lane confirmed dead -> probe() writes .handoff (session_id intact), clears running.json, leaves the worktree untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-63-a";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted work\n"); // WIP at kill time

    // No TERM trap -> the real CLI's empirically-confirmed shape (#60): dies by signal.
    const { bin, ready } = longRunningStub(dir);
    const s1 = sup(dir, bin, worktreeRoot);
    const { name: laneName, sessionId } = await s1.dispatch({ number: 63, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub reached its running state before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    s1.dispose(); // "restart": s2 has no in-memory lane handle for this name — only the persisted file

    const s2 = sup(dir, bin, worktreeRoot);
    assert.equal(s2.requestHandoff(laneName), true); // detached branch: SIGTERM via the persisted pid
    const runningAfterRequest = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    assert.equal(runningAfterRequest.handoff_requested, true, "request persisted onto running.json");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process");

    // probe() is what wins the race against DEAD-reclassification (#63) — it must confirm
    // death and finalize as .handoff right here, not via any onExit callback.
    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, true);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), ".handoff sentinel written by probe()");
    assert.ok(!existsSync(join(dir, `${laneName}.running.json`)), "running marker cleared");
    const sentinel = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(sentinel.session_id, sessionId, "resumable session_id carried through the detached path");
    // #69: sentinel-only — the worktree was not committed, cleaned, or otherwise touched.
    assert.equal(readFileSync(join(worktreePath, "wip.txt"), "utf8"), "uncommitted work\n");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#63: a SECOND engine restart before death is confirmed still finalizes — the persisted running.json handoff_requested field survives even though the fresh instance's in-memory set is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir); // no trap -> dies on SIGTERM
    const s1 = sup(dir, bin);
    const { name: laneName } = await s1.dispatch({ number: 64, title: "t", labels: [] });
    await waitForFile(ready, "stub reached its running state before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // restart #1: engine forgets the in-process lane

    const sMid = sup(dir, bin);
    assert.equal(sMid.requestHandoff(laneName), true); // detached SIGTERM sent + persisted
    // Simulate restart #2 landing before anyone ever calls probe() on sMid (i.e. before death
    // is confirmed): a brand-new instance whose in-memory detachedHandoffRequested is empty.
    const s2 = sup(dir, bin);
    assert.equal(
      s2.requestHandoff(laneName),
      false,
      "second restart reads handoff_requested, re-signals once, and does not re-announce adoption",
    );

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "the SIGTERM sent before restart #2 still killed it");

    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, true, "persisted handoff_requested field alone is enough to finalize");
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)));
    assert.ok(!existsSync(join(dir, `${laneName}.running.json`)));

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#169: persisted handoff_requested closes the write-before-signal crash window by re-sending SIGTERM without re-announcing adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  let s1: WorkerSupervisor | undefined;
  let s2: WorkerSupervisor | undefined;
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 169, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before simulating the crash window");
    const runningPath = join(dir, `${name}.running.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8")) as Record<string, unknown> & { wrapper_pid: number };
    const pid = running.wrapper_pid;
    assert.equal(alive(pid), true);

    // Simulate: running.json flag persisted, then the engine died before sending SIGTERM.
    writeFileSync(runningPath, `${JSON.stringify({ ...running, handoff_requested: true })}\n`);
    s1.dispose();
    s1 = undefined;

    s2 = sup(dir, bin);
    const proto = WorkerSupervisor.prototype as unknown as {
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    const s2Hooks = s2 as unknown as {
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    let signalCount = 0;
    s2Hooks.signalGroup = (targetPid, sig) => {
      signalCount++;
      proto.signalGroup.call(s2, targetPid, sig);
    };

    assert.equal(s2.requestHandoff(name), false, "persisted flag suppresses only the duplicate adoption event");
    assert.equal(signalCount, 1, "fresh supervisor re-sends SIGTERM once");
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the wrapper despite the pre-existing persisted flag");

    assert.doesNotThrow(() => assert.equal(s2?.requestHandoff(name), false));
    assert.equal(signalCount, 1, "in-memory set prevents a second signal from the same supervisor");
  } finally {
    s1?.dispose();
    s2?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63: wrapperAlive() === -1 (unreadable pid) -> probe() does not throw, does not finalize, lane stays as-is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    // A persisted lane that claims a handoff was requested but carries no readable wrapper_pid
    // (garbage/missing) -> persistedPid() is null -> wrapperAlive() is -1 (unknown), not 0.
    writeFileSync(join(dir, "lane-63-c.running.json"), JSON.stringify({ issue: 1, session_id: "s", handoff_requested: true }));
    const probe = await s.probe("lane-63-c");
    assert.equal(probe.wrapperAlive, -1);
    assert.equal(probe.handoff, false, "an unknown pid is never treated as confirmed-dead");
    assert.equal(probe.done, false);
    assert.equal(probe.failed, false);
    assert.ok(!existsSync(join(dir, "lane-63-c.handoff.json")));
    assert.ok(existsSync(join(dir, "lane-63-c.running.json")), "running marker untouched — still just 'unknown'");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63/#69: a lane already reclaim()'d must never also be finalized as .handoff — and its dirty worktree is RETAINED by that reclaim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-63-d";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    // Ignores TERM -> survives requestHandoff's SIGTERM; only reclaim()'s SIGKILL stops it —
    // mirroring the "reclaim kills a stubborn claude subtree via SIGKILL" pattern above.
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n");
    const s1 = sup(dir, bin, worktreeRoot);
    const { name: laneName } = await s1.dispatch({ number: 65, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted\n"); // post-dispatch WIP -> dirty
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose();

    const s2 = sup(dir, bin, worktreeRoot);
    assert.equal(s2.requestHandoff(laneName), true); // detached SIGTERM sent (ignored by the stub)
    assert.equal(alive(pid), true, "stub ignores TERM — still alive right after the drain request");

    // The conductor's escalation path (ceiling drain window elapsed, or a DEAD reclassification)
    // reaches this same lane and reclaims it — it's going FAILED, not resumable.
    const r = await s2.reclaim(laneName);
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "reclaim()'s SIGKILL escalation tore it down");
    assert.equal(r.worktreeRetained, true, "dirty worktree preserved for human salvage (#69)");
    assert.ok(existsSync(join(worktreePath, "wip.txt")));

    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, false, "a reclaimed lane must never be finalized as resumable");
    assert.ok(!existsSync(join(dir, `${laneName}.handoff.json`)), "no .handoff written");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#63 F1: a failure persisting handoff_requested onto running.json is swallowed — requestHandoff still returns true and the SIGTERM still lands (Codex second-opinion review, PR #67: it's called unguarded from the conductor's CEILING drain loop, which must never abort mid-tick)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 66, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin);
    // Force the persist write to fail exactly like an ENOSPC/EACCES/EROFS would — stubbing
    // the private writeJsonAtomic is the most portable way to force this (a chmod-based
    // fixture would be a no-op when the test runs as root). requestHandoff must swallow it.
    (s2 as unknown as { writeJsonAtomic: (p: string, obj: unknown) => void }).writeJsonAtomic = () => {
      throw new Error("simulated disk failure");
    };

    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = s2.requestHandoff(name);
    });
    assert.equal(result, true, "SIGTERM still gets sent even though the persist write failed");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process despite the persist failure");

    // Confirms this actually exercised the failing write path (not a silent no-op): the field
    // never landed, because the stubbed writeJsonAtomic threw instead of writing.
    const running = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8"));
    assert.notEqual(running.handoff_requested, true);

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63 P2: requestHandoff's detached branch persists handoff_requested BEFORE sending the SIGTERM, not after (Codex second-opinion review, PR #67 — closes the gap where the engine could die between 'signal sent' and 'flag persisted', losing the very record the flag exists to survive)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 67, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin);
    // A shared call-order log — wrap (not replace) the real private writeJsonAtomic/signalGroup
    // so the actual persist + actual SIGTERM still happen (this test also verifies the
    // end-to-end outcome), while recording which one ran first.
    const order: string[] = [];
    const proto = WorkerSupervisor.prototype as unknown as {
      writeJsonAtomic: (p: string, obj: unknown) => void;
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    const s2Hooks = s2 as unknown as {
      writeJsonAtomic: (p: string, obj: unknown) => void;
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    s2Hooks.writeJsonAtomic = (p, obj) => {
      order.push("persist");
      proto.writeJsonAtomic.call(s2, p, obj);
    };
    s2Hooks.signalGroup = (targetPid, sig) => {
      order.push("signal");
      proto.signalGroup.call(s2, targetPid, sig);
    };

    assert.equal(s2.requestHandoff(name), true);
    assert.deepEqual(order, ["persist", "signal"], "the persisted flag write must happen before the SIGTERM is sent");

    const running = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8"));
    assert.equal(running.handoff_requested, true, "persist actually landed on disk");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM still reached the detached process");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #74: file-based worker prompt ──

test("renderPromptTemplate: substitutes issue.number/title/body/labels", () => {
  const issue = { number: 42, title: "Fix the thing", labels: ["type:docs", "verify:n/a"], body: "do X and Y" };
  const out = renderPromptTemplate("Issue #{{issue.number}}: {{issue.title}} [{{issue.labels}}]\n\n{{issue.body}}", issue);
  assert.equal(out, "Issue #42: Fix the thing [type:docs, verify:n/a]\n\ndo X and Y");
});

test("renderPromptTemplate: absent issue.body substitutes as empty string, never throws", () => {
  const issue = { number: 1, title: "t", labels: [] }; // no body field
  assert.equal(renderPromptTemplate("body=[{{issue.body}}]", issue), "body=[]");
});

test("renderPromptTemplate: fails closed on an unknown {{var}} — no silent literal passthrough", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{issue.author}}", issue), /unknown variable.*issue\.author/i);
});

test("renderPromptTemplate: fails closed on names outside [\\w.] — {{issue-title}} is not literal passthrough", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{issue-title}}", issue), /unknown variable.*issue-title/i);
});

test("renderPromptTemplate: fails closed on prototype-chain names — {{constructor}} never resolves", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{constructor}}", issue), /unknown variable.*constructor/i);
  assert.throws(() => renderPromptTemplate("hello {{toString}}", issue), /unknown variable.*toString/i);
});

test("defaultPromptPath: resolves to the shipped prompts/worker.md, which exists and mentions the vars", () => {
  const p = defaultPromptPath();
  assert.ok(existsSync(p), `expected shipped default prompt at ${p}`);
  const text = readFileSync(p, "utf8");
  assert.match(text, /\{\{issue\.number\}\}/);
  assert.match(text, /\{\{issue\.title\}\}/);
  assert.match(text, /\{\{issue\.body\}\}/);
});

test("loadWorkerPromptTemplate: unset promptFile -> the shipped default (byte-identical)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  assert.equal(loadWorkerPromptTemplate(scfg), readFileSync(defaultPromptPath(), "utf8"));
});

test("loadWorkerPromptTemplate: promptFile set -> loads that file's raw content", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "custom.md");
    writeFileSync(p, "Custom prompt for #{{issue.number}}");
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { promptFile: p } });
    assert.equal(loadWorkerPromptTemplate(scfg), "Custom prompt for #{{issue.number}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWorkerPromptTemplate: fails fast, naming the path, when promptFile is missing (never silently falls back)", () => {
  const scfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    worker: { promptFile: "/nonexistent/does-not-exist.md" },
  });
  assert.throws(() => loadWorkerPromptTemplate(scfg), /\/nonexistent\/does-not-exist\.md/);
});

test("loadWorkerPromptTemplate: fails fast when promptFile exists but is unreadable (permission denied)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "unreadable.md");
    writeFileSync(p, "secret template");
    chmodSync(p, 0o000);
    if (process.getuid && process.getuid() === 0) return; // root ignores perms — skip under root
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { promptFile: p } });
    assert.throws(() => loadWorkerPromptTemplate(scfg), /unreadable/i);
  } finally {
    chmodSync(join(dir, "unreadable.md"), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: loads once, eagerly (fail-fast happens at build time, not on first render)", () => {
  const scfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    worker: { promptFile: "/nonexistent/does-not-exist.md" },
  });
  assert.throws(() => buildRenderPrompt(scfg), /\/nonexistent\/does-not-exist\.md/);
});

test("buildRenderPrompt: empty/whitespace template throws at build time — never dispatch an undirected worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "empty.md");
    writeFileSync(p, "  \n\n\t");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
    });
    assert.throws(() => buildRenderPrompt(scfg), /empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: substituted config values are literal — a {{issue.body}}-valued config var is NOT re-expanded", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "inject.md");
    writeFileSync(p, "label: {{labels.verifyNa}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      labels: { verifyNa: "{{issue.body}}" },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [], body: "SECRET" });
    assert.equal(rendered, "label: {{issue.body}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: config vars substitute at build time — customized labels.verifyNa reaches the prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "cfg-var.md");
    writeFileSync(p, "skip red/green if labelled {{labels.verifyNa}} on #{{issue.number}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      labels: { verifyNa: "no-verify" },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 7, title: "t", labels: [] });
    assert.equal(rendered, "skip red/green if labelled no-verify on #7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: the shipped default prompt builds clean (all its vars are known)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: ["verify:n/a"], body: "b" });
  assert.match(rendered, /labelled `sapwood:verify:n\/a`/);
  assert.doesNotMatch(rendered, /\{\{/);
});

// ── #245 round-2 fix A7: buildRenderFixPrompt — deliberately NARROWER var set than
//    buildRenderPrompt's own (issue.number/pr.number/labels.verifyNa only; never
//    issue.title/body/labels — a fix leg's evidence channel is the PR-facing proxy tools, not
//    issue prose) — and takes a bare issue NUMBER, never a fabricated `Issue` object. ──────────

test("defaultFixPromptPath: resolves to the shipped prompts/fix.md, which exists and mentions pr.number/issue.number", () => {
  const p = defaultFixPromptPath();
  assert.ok(existsSync(p));
  const content = readFileSync(p, "utf8");
  assert.match(content, /\{\{pr\.number\}\}/);
  assert.match(content, /\{\{issue\.number\}\}/);
  assert.match(content, /mcp__forge__pr_audit_comments/);
  assert.match(content, /findings are carried only by `pr_audit_comments`/);
});

test("loadFixPromptTemplate: unset fixPromptFile -> the shipped default (byte-identical)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  assert.equal(loadFixPromptTemplate(scfg), readFileSync(defaultFixPromptPath(), "utf8"));
});

test("loadFixPromptTemplate: fails fast, naming the path, when fixPromptFile is missing (never silently falls back)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: "/no/such/fix.md" } });
  assert.throws(() => loadFixPromptTemplate(scfg), /fix\.md/);
});

test("buildRenderFixPrompt: the shipped default prompt builds clean (all its vars are known) and takes a bare issue NUMBER + pr number", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const rendered = buildRenderFixPrompt(scfg)(42, 77);
  assert.match(rendered, /#77/);
  assert.match(rendered, /#42/);
  assert.doesNotMatch(rendered, /\{\{/);
});

test("buildRenderFixPrompt: supported vars are issue.number/pr.number/labels.verifyNa ONLY — issue.title/issue.body/issue.labels are UNKNOWN and fail closed at build time (A7 narrowing)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    for (const badVar of ["issue.title", "issue.body", "issue.labels"]) {
      const p = join(dir, `bad-${badVar.replace(".", "-")}.md`);
      writeFileSync(p, `fix {{${badVar}}}`);
      const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: p } });
      assert.throws(() => buildRenderFixPrompt(cfg), new RegExp(`unknown variable.*${badVar.replace(".", "\\.")}`, "i"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderFixPrompt: {{issue.number}}/{{pr.number}}/{{labels.verifyNa}} all substitute correctly from a custom template", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    const p = join(dir, "custom-fix.md");
    writeFileSync(p, "fix issue #{{issue.number}} pr #{{pr.number}}, skip if {{labels.verifyNa}}");
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { fixPromptFile: p },
      labels: { verifyNa: "verify:custom" },
    });
    const rendered = buildRenderFixPrompt(cfg)(9, 99);
    assert.equal(rendered, "fix issue #9 pr #99, skip if verify:custom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderFixPrompt: empty/whitespace template throws at build time — never start an undirected fix leg", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    const p = join(dir, "empty-fix.md");
    writeFileSync(p, "   \n  ");
    const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: p } });
    assert.throws(() => buildRenderFixPrompt(cfg), /empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #167: {{doctrine}} — repo-level review doctrine injected into the worker brief ─────────────

test("buildRenderPrompt: with no doctrine.file on disk, {{doctrine}} substitutes the explicit 'none' placeholder — behavior unchanged, never an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "DOCTRINE: {{doctrine}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      doctrine: { file: join(dir, "does-not-exist-DOCTRINE.md") },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.match(rendered, /DOCTRINE: \(No review doctrine file is configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: with a doctrine.file present, {{doctrine}} substitutes its content, bounded by doctrine.maxChars", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "DOCTRINE: {{doctrine}}");
    const doctrinePath = join(dir, "DOCTRINE.md");
    writeFileSync(doctrinePath, "the disabled-consumer rule matters here");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      doctrine: { file: doctrinePath },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.equal(rendered, "DOCTRINE: the disabled-consumer rule matters here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: an oversized doctrine.file is deterministically truncated with a marked cut when substituted into {{doctrine}}", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "{{doctrine}}");
    const doctrinePath = join(dir, "DOCTRINE.md");
    writeFileSync(doctrinePath, "y".repeat(5000));
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      // #167 review (Codex P3): doctrine.maxChars now has a 200-char floor (config.ts) so the
      // truncation marker itself always fits — 200 is the smallest legal value here.
      doctrine: { file: doctrinePath, maxChars: 200 },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.ok(rendered.length <= 200, `expected <= 200 chars, got ${rendered.length}`);
    assert.match(rendered, /truncated/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: unknown {{var}} in the template throws at BUILD time, before any issue is claimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "bad-var.md");
    writeFileSync(p, "work on {{issue.url}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
    });
    assert.throws(() => buildRenderPrompt(scfg), /unknown variable.*issue\.url/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: end-to-end — the dispatched worker's -p prompt equals the rendered template file (fake supervisor)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const templatePath = join(dir, "e2e-worker.md");
    writeFileSync(templatePath, 'Do issue #{{issue.number}} ("{{issue.title}}"):\n{{issue.body}}');
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: templatePath },
    });
    const renderPrompt = buildRenderPrompt(scfg);
    const hook = mkHook(dir);
    // stub records its argv so we can inspect exactly what -p carried (same trick as the
    // #26 inline-settings test above).
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: scfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt,
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await s.dispatch({ number: 74, title: "File-based worker prompt", labels: [], body: "wire promptFile through renderPrompt" });
    await waitForFile(join(dir, "args.seen"), "rendered-prompt argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const expected = renderPromptTemplate(readFileSync(templatePath, "utf8"), {
      number: 74,
      title: "File-based worker prompt",
      labels: [],
      body: "wire promptFile through renderPrompt",
    });
    assert.ok(args.includes(expected), `expected the rendered template in the spawned argv, got:\n${args}`);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #668 (controlled-exit child reaping): reapChildren's own escalation state machine, against
// FAKE children — no real subprocess, no real timer (opts.sleep resolves immediately), per this
// repo's test doctrine (no-timing-dependent assertions; a seam, not a real-clock race). The
// WorkerSupervisor.reapAll() adapter wiring (real pid/process-group semantics, requestHandoff
// idempotency, dispose() vs reapAll()) is covered separately below with real short-lived stub
// subprocesses, the same convention this file already uses for every other kill-path test.
// ─────────────────────────────────────────────────────────────────────────────
function fakeChild(
  name: string,
  opts: { diesOn?: NodeJS.Signals | "never"; startDead?: boolean } = {},
): ReapableChild & { signals: NodeJS.Signals[] } {
  const diesOn = opts.diesOn ?? "SIGTERM";
  let dead = opts.startDead ?? false;
  const signals: NodeJS.Signals[] = [];
  return {
    name,
    signals,
    isAlive: () => !dead,
    signal: (sig) => {
      signals.push(sig);
      if (diesOn !== "never" && sig === diesOn) dead = true;
    },
  };
}
const INSTANT_SLEEP = async (): Promise<void> => {};

test("reapChildren (#668): a child already dead before reap starts is never signaled at all — AC5 (reap must not manufacture work against a leg that already exited on its own)", async () => {
  const c = fakeChild("lane-a", { startDead: true });
  const outcomes = await reapChildren([c], { sleep: INSTANT_SLEEP });
  assert.deepEqual(c.signals, [], "an already-dead child gets zero signals");
  assert.deepEqual(outcomes, [{ name: "lane-a", alreadyDead: true, escalated: false, confirmedDead: true } satisfies ReapOutcome]);
});

test("reapChildren (#668): a child that dies from SIGTERM alone within the grace period is NEVER escalated to SIGKILL — the reverse of AC3/AC4, proving reap doesn't become a mid-work kill (AC5)", async () => {
  const c = fakeChild("lane-b", { diesOn: "SIGTERM" });
  const outcomes = await reapChildren([c], { sleep: INSTANT_SLEEP });
  assert.deepEqual(c.signals, ["SIGTERM"], "SIGKILL was never sent to a lane that already died gracefully");
  assert.deepEqual(outcomes, [{ name: "lane-b", alreadyDead: false, escalated: false, confirmedDead: true } satisfies ReapOutcome]);
});

test("reapChildren (#668): a child that survives the grace period is escalated to SIGTERM-then-SIGKILL, and death is VERIFIED (not assumed) before returning — AC3/AC4", async () => {
  const c = fakeChild("lane-c", { diesOn: "SIGKILL" });
  const outcomes = await reapChildren([c], { sleep: INSTANT_SLEEP });
  assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"], "SIGTERM first, SIGKILL only after SIGTERM alone failed");
  assert.deepEqual(outcomes, [{ name: "lane-c", alreadyDead: false, escalated: true, confirmedDead: true } satisfies ReapOutcome]);
});

test("reapChildren (#668): a child that survives even SIGKILL is reported as such — the orphan-process-group case AC4 forbids — logged rather than silently assumed dead or retried forever", async () => {
  const c = fakeChild("lane-d", { diesOn: "never" });
  const logged: string[] = [];
  const outcomes = await reapChildren([c], { sleep: INSTANT_SLEEP, log: (m) => logged.push(m) });
  assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(outcomes, [{ name: "lane-d", alreadyDead: false, escalated: true, confirmedDead: false } satisfies ReapOutcome]);
  assert.ok(
    logged.some((m) => m.includes("lane-d") && m.includes("orphan process group")),
    `expected an orphan-process-group log naming lane-d, got: ${JSON.stringify(logged)}`,
  );
});

test("reapChildren (#668): a mixed batch escalates EACH child independently — a graceful lane never receives the SIGKILL another lane's stubbornness triggers", async () => {
  const graceful = fakeChild("lane-graceful", { diesOn: "SIGTERM" });
  const stubborn = fakeChild("lane-stubborn", { diesOn: "SIGKILL" });
  const outcomes = await reapChildren([graceful, stubborn], { sleep: INSTANT_SLEEP });
  assert.deepEqual(graceful.signals, ["SIGTERM"]);
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  const byName = new Map(outcomes.map((o) => [o.name, o]));
  assert.equal(byName.get("lane-graceful")?.escalated, false);
  assert.equal(byName.get("lane-stubborn")?.escalated, true);
});

test("reapChildren (#668): opts.graceMs is the ACTUAL bound the grace-phase poll loop uses — plumbed through, never hardcoded to the module default", async () => {
  const events: string[] = [];
  const c: ReapableChild = {
    name: "lane-e",
    isAlive: () => !events.includes("SIGKILL"),
    signal: (sig) => events.push(sig),
  };
  await reapChildren([c], {
    graceMs: 40,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
  });
  const sigkillIdx = events.indexOf("SIGKILL");
  assert.ok(sigkillIdx > 0, `expected SIGKILL to be sent, got: ${JSON.stringify(events)}`);
  const graceSleeps = events.slice(0, sigkillIdx).filter((e) => e.startsWith("sleep:"));
  assert.equal(
    graceSleeps.length,
    Math.ceil(40 / 25),
    `a 3000ms default would poll 120 times; the custom 40ms bound should poll only ceil(40/25), got: ${JSON.stringify(events)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #668: WorkerSupervisor.reapAll() — the production adapter over reapChildren, against REAL
// short-lived stub subprocesses (same convention as every other kill-path test in this file:
// longRunningStub + trap TERM). reapChildren's own escalation state machine is exhaustively
// covered above with fake children; these tests prove the adapter's isAlive/signal wiring
// (real pid, real process group) and its composition with requestHandoff are correct.
// ─────────────────────────────────────────────────────────────────────────────

test("WorkerSupervisor.reapAll (#668): no live lanes -> resolves to [] immediately, no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reap-"));
  try {
    const s = sup(dir, "claude"); // never dispatches -> this.lanes is empty
    assert.deepEqual(await s.reapAll(), []);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkerSupervisor.reapAll (#668): a lane that hands off cleanly on SIGTERM is reaped WITHOUT ever needing SIGKILL — reap composes with graceful handoff instead of overriding it (AC5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reap-"));
  try {
    // Cooperative: catches SIGTERM and exits 0, exactly like an ordinary graceful handoff.
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 668, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before reap");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);

    const outcomes = await s.reapAll();

    assert.deepEqual(outcomes, [{ name, alreadyDead: false, escalated: false, confirmedDead: true }]);
    assert.equal(alive(pid), false, "the process group is actually dead, not just assumed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkerSupervisor.reapAll (#668): a lane that IGNORES SIGTERM is escalated to a whole-process-group SIGKILL, and group death is proven before reapAll resolves — AC3/AC4", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reap-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n"); // ignores TERM -> only SIGKILL ends it
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 669, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM-ignoring trap before reap");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);

    // A small custom grace period keeps this test fast — the escalation timing itself (does the
    // bound get honored) is already covered deterministically above via fake children.
    const outcomes = await s.reapAll({ graceMs: 100 });

    assert.deepEqual(outcomes, [{ name, alreadyDead: false, escalated: true, confirmedDead: true }]);
    assert.equal(alive(pid), false, "the whole process group (negative pid) is dead, not just the leader");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkerSupervisor.reapAll (#668): a lane ALREADY mid-drain (requestHandoff already sent by the existing ceiling/kill-switch path) is not double-SIGTERM'd, but reapAll still finishes the job — composes with, doesn't duplicate, the existing drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reap-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n"); // ignores TERM -> can ONLY die via reapAll's own SIGKILL
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 670, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM-ignoring trap before drain");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;

    assert.equal(s.requestHandoff(name), true); // simulates an EARLIER ceiling/kill-switch drain
    assert.equal(alive(pid), true, "SIGTERM alone doesn't end a lane that ignores it");

    const outcomes = await s.reapAll({ graceMs: 100 });

    assert.deepEqual(outcomes, [{ name, alreadyDead: false, escalated: true, confirmedDead: true }]);
    assert.equal(alive(pid), false, "reapAll still reaps a lane an earlier drain already signaled");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #244: worker-leg forge MCP proxy attachment — mirrors peripheral.ts's RoleRunner mechanism
// (#234), extended here to WorkerSupervisor.dispatch(). Unattached dispatch (every test above
// this section) is COMPLETELY UNCHANGED — these tests only cover the NEW opt-in `proxy` param.
// ─────────────────────────────────────────────────────────────────────────────

function fakeWorkerProxyHandle(over: Partial<{ mcpConfigJson: string; toolNames: string[] }> = {}) {
  const calls = { minted: 0, stopped: 0 };
  const handle = {
    port: 1,
    token: "proxy-test-token",
    url: "http://127.0.0.1:1/mcp",
    mcpConfigJson: JSON.stringify({
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer proxy-test-token" } } },
    }),
    // #556: derived from PR_TOOLS, not a hand-copied list — this fake stands in for what
    // createProxyMint actually grants a fix-loop worker leg (asserted in proxy/mint.test.ts), so
    // a wire-name change has to reach the argv assertions below rather than drifting past them.
    toolNames: PR_TOOLS.map(mcpToolFullName),
    ...over,
    stop: async () => {
      calls.stopped++;
    },
  };
  return { calls, handle };
}

test("dispatch: a proxy opt mints a handle, widens --allowedTools with the handle's own tool names, and injects --mcp-config inline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { calls, handle } = fakeWorkerProxyHandle();
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: {
        mint: async (session) => {
          calls.minted++;
          assert.equal(session.role, "worker");
          return handle as never;
        },
      },
    });
    await waitForFile(join(dir, "args.seen"), "proxy dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /mcp__forge__pr_details/);
    assert.match(args, /--mcp-config/);
    assert.ok(args.includes(JSON.stringify(handle.mcpConfigJson)) === false); // sanity: not double-JSON-encoded
    const i = args.trim().split("\n").indexOf("--mcp-config");
    assert.equal(args.trim().split("\n")[i + 1], handle.mcpConfigJson);
    assert.equal(calls.minted, 1);
    // #617 (seam 1): a non-credentialFree proxy attachment must NOT emit --strict-mcp-config —
    // the seal is scoped to credentialFree alone; an ordinary attached-proxy dispatch keeps
    // today's (additive) --mcp-config semantics unchanged.
    assert.ok(!args.trim().split("\n").includes("--strict-mcp-config"), "non-credentialFree dispatch must not emit --strict-mcp-config");
    for (let i2 = 0; i2 < 400 && !existsSync(join(dir, `${name}.done.json`)); i2++) await sleep(20);
    for (let i2 = 0; i2 < 400 && calls.stopped === 0; i2++) await sleep(20);
    assert.equal(calls.stopped, 1, "the proxy is torn down once the lane's process exits (onExit)");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: no proxy opt (every ordinary caller today) -> no --mcp-config flag, --allowedTools unchanged — byte-identical to pre-#244 behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await s.dispatch({ number: 1, title: "t", labels: [] });
    await waitForFile(join(dir, "args.seen"), "ordinary dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.doesNotMatch(args, /--mcp-config/);
    assert.doesNotMatch(args, /mcp__forge__/);
    assert.match(args, /Bash\(gh \*\)/, "the code-producing worker's own default --allowedTools is unchanged");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#639): WorkerDeps.skillsPluginDir set -> --plugin-dir <dir> reaches argv (fresh dispatch is YES per the injection policy table)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
      skillsPluginDir: "/data/generated/role-skills/deadbeef",
    });
    await s.dispatch({ number: 1, title: "t", labels: [] });
    await waitForFile(join(dir, "args.seen"), "skills-plugin dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8").trim().split("\n");
    const i = args.indexOf("--plugin-dir");
    assert.ok(i !== -1, "--plugin-dir must reach argv when WorkerDeps.skillsPluginDir is set");
    assert.equal(args[i + 1], "/data/generated/role-skills/deadbeef");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#639): WorkerDeps.skillsPluginDir UNSET (today's default, roles.skills.enabled: false) -> no --plugin-dir flag at all — the disabled-path byte-identical-argv regression", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await s.dispatch({ number: 1, title: "t", labels: [] });
    await waitForFile(join(dir, "args.seen"), "ordinary dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.doesNotMatch(args, /--plugin-dir/);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a proxy mint FAILURE is non-fatal — the lane still dispatches and runs, unattached (mirrors peripheral.ts's RoleRunner stance)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed");
        },
      },
    });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "lane still completes despite the mint failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a spawn failure with a proxy attached still tears down the minted proxy (never leaks a live listener/token)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    const { calls, handle } = fakeWorkerProxyHandle();
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-bad-proxy", {
          proxy: {
            mint: async () => {
              calls.minted++;
              return handle as never;
            },
          },
        }),
      /spawn failed/i,
    );
    assert.equal(calls.minted, 1);
    assert.equal(calls.stopped, 1, "the proxy is torn down even though dispatch() THREW rather than returned");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 (Codex sol-high PR #260 review round 2, P2): the credentialFree GH_CONFIG_DIR scratch
// directory (created BEFORE spawn, once mint has already succeeded) must be cleaned up on the
// spawn-failure path too — not just onExit — or it leaks as directory litter under stateDir
// every time a credentialFree leg fails to spawn.
test("dispatch: a spawn failure on a credentialFree leg (mint succeeded, spawn failed) removes the GH_CONFIG_DIR scratch directory it already created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-credfree-spawnfail", {
          proxy: { mint: async () => handle as never, credentialFree: true },
        }),
      /spawn failed/i,
    );
    const ghConfigDir = join(dir, "lane-credfree-spawnfail.gh-config-empty");
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory must not survive a spawn failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 AC (issue's own phrasing): "#218 credential-free regression tests extended to a worker
// leg with the proxy handle attached (spawn env token-free; proxy is the only forge reach)".
// HONEST SCOPE (round-2 delta review, P1): "only forge reach" holds for the `gh`/git
// CREDENTIALED-TOOL path this test asserts — it does NOT mean a worker leg's Bash(node/npm)
// grant can't read an ambient credential store directly off disk (workerCredentialFreeEnv's own
// doc names that residual explicitly; it is NOT closed here or anywhere in this PR). Distinct
// from the ordinary dispatch env test above (line ~1238), which asserts workers LEGITIMATELY
// keep GH_TOKEN by default — this is the NEW, separately-opted-into shape
// (WorkerProxyOpts.credentialFree).
test("dispatch: credentialFree opt strips forge/git credential env vars and severs gh/git's own credential-lookup paths for a worker leg — same denylist as peripheral.ts's #218 regression, NOT a claim of full isolation (see workerCredentialFreeEnv's doc)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const release = join(dir, "release-stub");
  const poisoned = {
    GH_TOKEN: "poison-gh-token",
    GITHUB_TOKEN: "poison-github-token",
    GITHUB_ENTERPRISE_TOKEN: "poison-github-enterprise-token",
    GH_CONFIG_DIR: "/poison/gh-config",
    GH_HOST: "poison.example",
    GIT_ASKPASS: "/poison/askpass",
    GIT_CONFIG_GLOBAL: "/poison/gitconfig",
    GIT_CONFIG_COUNT: "1",
    SSH_AUTH_SOCK: "/poison/ssh-agent.sock",
    ANTHROPIC_API_KEY: "preserved-anthropic-auth",
  } as const;
  const previous = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poisoned);
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nenv > "${join(dir, "env.seen.tmp")}"\nmv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\nfor _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: { mint: async () => handle as never, credentialFree: true },
    });
    await waitForFile(join(dir, "env.seen"), "credential-free dispatch env was not published");
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_CONFIG_DIR",
      "GH_HOST",
      "GIT_ASKPASS",
      "GIT_CONFIG_GLOBAL",
    ]) {
      assert.ok(!envText.includes(`${key}=poison`), `${key} leaked into the credential-free worker leg's env`);
    }
    assert.ok(envText.includes("ANTHROPIC_API_KEY=preserved-anthropic-auth"), "Claude auth is preserved");
    assert.ok(!envText.includes("proxy-test-token"), "the proxy's bearer token never reaches the spawn env — --mcp-config only");
    // #244 (Codex sol-high PR #260 review, P1): env-var stripping alone is insufficient — assert
    // the FULL severing shape: GH_CONFIG_DIR repointed at a fresh, EMPTY, per-lane directory
    // (never the poisoned value, never the real $HOME/.config/gh), GIT_CONFIG_GLOBAL/SYSTEM
    // pointed at /dev/null, GIT_TERMINAL_PROMPT=0 (fail closed rather than prompt), and no
    // SSH_AUTH_SOCK at all (an inherited agent socket is a live credential channel on its own).
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine, "GH_CONFIG_DIR must be set");
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.notEqual(ghConfigDir, "/poison/gh-config");
    assert.ok(existsSync(ghConfigDir), "the GH_CONFIG_DIR path must actually exist as a directory");
    assert.deepEqual(readdirSync(ghConfigDir), [], "GH_CONFIG_DIR must be a FRESH, EMPTY directory — never gh's real stored config");
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(envText, /^GIT_CONFIG_SYSTEM=\/dev\/null$/m);
    assert.match(envText, /^GIT_TERMINAL_PROMPT=0$/m);
    assert.doesNotMatch(envText, /^SSH_AUTH_SOCK=/m);
    // #244 (Codex sol-high PR #260 review, P1): the grant itself narrows — a credentialFree leg
    // whose env can no longer authenticate `gh` at all must not still be OFFERED `gh` as a tool.
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const allowedToolsIdx = args.trim().split("\n").indexOf("--allowedTools");
    const allowedTools = args.trim().split("\n")[allowedToolsIdx + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/, "credentialFree must drop Bash(gh *) from the grant");
    assert.match(allowedTools, /Bash\(git \*\)/, "git stays — its own credential path is what's severed, not the tool grant");
    // #617 (seam 1, capability DR #616): credentialFree ⇒ SEALED MCP surface — --strict-mcp-config
    // present, and --mcp-config carries ONLY the proxy's own server (never additive with any
    // ambient host config).
    const argLines = args.trim().split("\n");
    assert.ok(argLines.includes("--strict-mcp-config"), "credentialFree dispatch must emit --strict-mcp-config");
    const mcpConfigIdx = argLines.indexOf("--mcp-config");
    assert.notEqual(mcpConfigIdx, -1, "credentialFree dispatch must emit --mcp-config");
    assert.equal(argLines[mcpConfigIdx + 1], handle.mcpConfigJson, "--mcp-config must be the proxy's own (proxy-only) config, unchanged");
    // #244 (Codex sol-high PR #260 review round 2, P2): the per-lane GH_CONFIG_DIR scratch
    // directory is cleaned up once the lane exits — never left behind as directory litter.
    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && existsSync(ghConfigDir); i++) await sleep(20);
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory must be removed once the lane exits (onExit)");
    s.dispose();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workerCredentialFreeEnv: pure unit — composes the exact env shape (GH_CONFIG_DIR/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_TERMINAL_PROMPT, no SSH_AUTH_SOCK/GH_TOKEN)", () => {
  const previous = { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    process.env.GH_TOKEN = "poison";
    const env = workerCredentialFreeEnv("/tmp/fake-gh-config-dir");
    assert.equal(env.GH_CONFIG_DIR, "/tmp/fake-gh-config-dir");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  } finally {
    if (previous.SSH_AUTH_SOCK === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous.SSH_AUTH_SOCK;
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
});

test("WORKER_ALLOWED_TOOLS_NO_GH: byte-identical to WORKER_ALLOWED_TOOLS minus Bash(gh *), git stays", () => {
  assert.doesNotMatch(WORKER_ALLOWED_TOOLS_NO_GH, /Bash\(gh \*\)/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Bash\(git \*\)/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Read/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Write/);
});

// ── #606 (#351 final ruling): L1 scoped-worker-identity — deploy-key env, preflight probe,
//    keypair generation, and dispatch()/resume() wiring ─────────────────────────────────────

// #606 gate② round 1 (P2-9): deployKeyTransportOverlay shell-quotes the key path (shellSingleQuote)
// since GIT_SSH_COMMAND is shell-PARSED by git — an unquoted path with a space would break/mutate
// the command.
test("deployKeyTransportOverlay: pure unit — GIT_SSH_COMMAND shell-quotes the deploy key path, GIT_CONFIG_* rewrites origin to SSH", () => {
  const overlay = deployKeyTransportOverlay("/tmp/fake-deploy-key", "o", "r");
  assert.equal(overlay.GIT_SSH_COMMAND, "ssh -i '/tmp/fake-deploy-key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new");
  // env-based git config injection (no file touched) — two insteadOf entries so the origin's
  // conventional HTTPS spelling (with or without a trailing .git) both rewrite to the same SSH URL.
  assert.equal(overlay.GIT_CONFIG_COUNT, "2");
  assert.equal(overlay.GIT_CONFIG_KEY_0, "url.git@github.com:o/r.git.insteadOf");
  assert.equal(overlay.GIT_CONFIG_VALUE_0, "https://github.com/o/r.git");
  assert.equal(overlay.GIT_CONFIG_KEY_1, "url.git@github.com:o/r.git.insteadOf");
  assert.equal(overlay.GIT_CONFIG_VALUE_1, "https://github.com/o/r");
});

test("deployKeyTransportOverlay (#606 gate② round 1, P2-9): a key path containing a space is shell-quoted so it survives git's shell-parsed GIT_SSH_COMMAND intact", () => {
  const overlay = deployKeyTransportOverlay("/tmp/my keys/worker-deploy-key", "o", "r");
  assert.equal(
    overlay.GIT_SSH_COMMAND,
    "ssh -i '/tmp/my keys/worker-deploy-key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
  );
});

test("workerDeployKeyEnv (#606 gate② round 1, P1-3): pure unit — composes the FULL workerCredentialFreeEnv severing (GH_CONFIG_DIR repointed, GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, GIT_TERMINAL_PROMPT=0, no SSH_AUTH_SOCK/GH_TOKEN) with the deploy-key transport overlay, other env preserved", () => {
  const previous = { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    process.env.GH_TOKEN = "poison";
    process.env.ANTHROPIC_API_KEY_TEST_MARKER_606 = "kept";
    const env = workerDeployKeyEnv("/tmp/fake-deploy-key", "/tmp/fake-gh-config-dir-606", "o", "r");
    // the deploy-key transport overlay
    assert.equal(env.GIT_SSH_COMMAND, "ssh -i '/tmp/fake-deploy-key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new");
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "url.git@github.com:o/r.git.insteadOf");
    assert.equal(env.GIT_CONFIG_VALUE_0, "https://github.com/o/r.git");
    assert.equal(env.GIT_CONFIG_KEY_1, "url.git@github.com:o/r.git.insteadOf");
    assert.equal(env.GIT_CONFIG_VALUE_1, "https://github.com/o/r");
    // P1-3: the FULL workerCredentialFreeEnv severing, not just token-var stripping — GH_CONFIG_DIR
    // repointed at the empty per-lane dir, GIT_CONFIG_GLOBAL/SYSTEM nulled, GIT_TERMINAL_PROMPT=0.
    assert.equal(env.GH_CONFIG_DIR, "/tmp/fake-gh-config-dir-606");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY_TEST_MARKER_606, "kept");
  } finally {
    delete process.env.ANTHROPIC_API_KEY_TEST_MARKER_606;
    if (previous.SSH_AUTH_SOCK === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous.SSH_AUTH_SOCK;
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
});

test("workerDeployKeyEnv: no forge API credential of ANY kind survives — the whole GH_/GITHUB_/GIT_CONFIG_ prefixed family is stripped before the deploy-key-specific and GH_CONFIG_DIR keys are added back", () => {
  const poisoned = { GH_TOKEN: "p", GITHUB_TOKEN: "p", GITHUB_ENTERPRISE_TOKEN: "p", GH_HOST: "p", GIT_ASKPASS: "/p" };
  const previous = Object.fromEntries(Object.keys(poisoned).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, poisoned);
    const env = workerDeployKeyEnv("/tmp/fake-deploy-key", "/tmp/fake-gh-config-dir-606b", "o", "r");
    for (const key of Object.keys(poisoned)) assert.equal(env[key], undefined, `${key} must not survive workerDeployKeyEnv`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeDeployKeySsh: exit 1 + stderr containing 'successfully authenticated' -> ok (GitHub's own documented SSH-auth success shape)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploykey-probe-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho "Hi someuser! You've successfully authenticated, but GitHub does not provide shell access." >&2\nexit 1\n`,
    );
    assert.deepEqual(await probeDeployKeySsh("/tmp/fake-deploy-key", 15, bin), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeDeployKeySsh: exit 0 is NOT success — GitHub's SSH endpoint never grants shell access, so exit 0 means the probe never reached authentication at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploykey-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 0\n`);
    const r = await probeDeployKeySsh("/tmp/fake-deploy-key", 15, bin);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeDeployKeySsh: exit 1 with an UNRELATED stderr (e.g. permission denied, no matching key) -> failure, detail carries the first stderr line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploykey-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "git@github.com: Permission denied (publickey)." >&2\nexit 1\n`);
    const r = await probeDeployKeySsh("/tmp/fake-deploy-key", 15, bin);
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /Permission denied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeDeployKeySsh: a nonexistent binary -> failure with a spawn detail, never throws", async () => {
  const r = await probeDeployKeySsh("/tmp/fake-deploy-key", 15, "/no/such/binary/sapwood-606");
  assert.equal(r.ok, false);
  assert.match(r.detail ?? "", /spawn/i);
});

test("probeDeployKeySsh: a hang past timeoutSec is hard-killed and resolves failure with a timeout detail, never left dangling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-deploykey-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const start = Date.now();
    const r = await probeDeployKeySsh("/tmp/fake-deploy-key", 1, bin); // 1s timeout vs a 30s hang
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /timed out/i);
    // #606 gate② round 1 (P2-10): mirrors probeLlmPing's own timeout test (#403/F25) — a
    // DELIBERATE real-time assertion, and the margin ordering is why it is not the banned "two
    // uncontrolled real operations race" shape (docs/REVIEW-DOCTRINE.md). The stub does zero real
    // work — it sleeps 30s — so the only thing that can end this call inside the bound is the
    // timeout kill under test. The three numbers are ordered by construction and by orders of
    // magnitude, not by tuning: probe timeout 1s < this bound 10s < stub sleep 30s. A run 9x
    // slower than expected still passes; a regression that drops the kill cannot pass.
    assert.ok(Date.now() - start < 10_000, "resolved via the timeout kill, not by waiting out the 30s sleep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnSshKeygen: generates a real ed25519 keypair (private key 0600, public key present) — a real ssh-keygen invocation, not a fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-sshkeygen-"));
  try {
    const keyPath = join(dir, "worker-deploy-key");
    await spawnSshKeygen(keyPath);
    assert.ok(existsSync(keyPath), "private key must be written");
    assert.ok(existsSync(`${keyPath}.pub`), "public key must be written");
    const priv = readFileSync(keyPath, "utf8");
    assert.match(priv, /BEGIN OPENSSH PRIVATE KEY/);
    const pub = readFileSync(`${keyPath}.pub`, "utf8");
    assert.match(pub, /^ssh-ed25519 /);
    assert.doesNotMatch(priv, /Proc-Type: 4,ENCRYPTED/, 'generated with -N "" -> no passphrase, unattended-readable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnSshKeygen: a nonexistent parent directory rejects (does not throw synchronously, never wedges the caller)", async () => {
  await assert.rejects(() => spawnSshKeygen("/no/such/dir/sapwood-606/worker-deploy-key"));
});

// #606 gate② round 2 (R3-6): the config schema now enforces deployKeyPath/deployKeyId as a PAIR
// (init.ts owns reconciling them; worker.ts's own runtime never reads deployKeyId at all — only
// resolveDeployKeyPath's SSH preflight against deployKeyPath matters here), so every fixture
// built from this helper needs a syntactically-valid deployKeyId alongside deployKeyPath purely
// to satisfy the schema. The exact number is never read by anything under test in this file.
const cfgWithDeployKey = (deployKeyPath: string): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { deployKeyPath, deployKeyId: 1 } });

test("dispatch: worker.deployKeyPath configured + preflight OK -> L1 active — GIT_SSH_COMMAND present, no gh credential reachable via env, Bash(gh *) absent from --allowedTools, Bash(git *) stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const release = join(dir, "release-l1-dispatch");
  try {
    process.env.GH_TOKEN = "poison-gh-token";
    process.env.GITHUB_TOKEN = "poison-github-token";
    const hook = mkHook(dir);
    // #606 gate② round 1 (P1-3): the stub PAUSES on `release` before exiting — GH_CONFIG_DIR is
    // now created for an ordinary L1 leg too (not just credentialFree), and onExit removes it as
    // soon as the child exits, so the directory-existence assertion below needs the child still
    // alive to observe it (same release-gate pattern the credentialFree tests already use).
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nenv > "${join(dir, "env.seen.tmp")}"\nmv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\nfor _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const deployKeyCfg = cfgWithDeployKey("/tmp/fake-deploy-key-606");
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
      probeDeployKeySsh: async () => ({ ok: true }),
    });
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-l1-dispatch");
    await waitForFile(join(dir, "env.seen"), "L1 dispatch env was not published");
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    assert.match(
      envText,
      /^GIT_SSH_COMMAND=ssh -i '\/tmp\/fake-deploy-key-606' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new$/m,
    );
    assert.doesNotMatch(envText, /GH_TOKEN=poison/);
    assert.doesNotMatch(envText, /GITHUB_TOKEN=poison/);
    // #606 gate② round 1 (P1-3): "transport-only" now means the SAME full severing
    // workerCredentialFreeEnv demonstrates — GH_CONFIG_DIR repointed at a fresh, empty, per-lane
    // directory (never the real $HOME/.config/gh), GIT_CONFIG_GLOBAL/SYSTEM nulled.
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine, "GH_CONFIG_DIR must be set for an ordinary L1 leg too, not just credentialFree");
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.ok(existsSync(ghConfigDir), "GH_CONFIG_DIR path must actually exist as a directory");
    assert.deepEqual(readdirSync(ghConfigDir), [], "GH_CONFIG_DIR must be a FRESH, EMPTY directory");
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(envText, /^GIT_CONFIG_SYSTEM=\/dev\/null$/m);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const argLines = args.trim().split("\n");
    const allowedTools = argLines[argLines.indexOf("--allowedTools") + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/, "L1 must drop Bash(gh *) from the grant");
    assert.match(allowedTools, /Bash\(git \*\)/, "git stays — L1 pushes via git, not gh");
    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, "lane-l1-dispatch.done.json")); i++) await sleep(20);
    s.dispose();
  } finally {
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
    if (previous.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: worker.deployKeyPath UNSET -> L0, byte-identical to today (reverse test) — GH_TOKEN inherited, Bash(gh *) present, the injected probeDeployKeySsh dep is never even called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previous = { GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.GH_TOKEN = "real-token-606";
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nenv > "${join(dir, "env.seen.tmp")}"\nmv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    let probeCalled = false;
    const s = new WorkerSupervisor({
      now: realClock,
      cfg, // no worker.deployKeyPath set — the shared, default test cfg
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
      probeDeployKeySsh: async () => {
        probeCalled = true;
        return { ok: true };
      },
    });
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-l0-reverse");
    await waitForFile(join(dir, "env.seen"), "L0 dispatch env was not published");
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    assert.match(envText, /^GH_TOKEN=real-token-606$/m, "L0 keeps today's full credentialed env");
    assert.doesNotMatch(envText, /^GIT_SSH_COMMAND=/m);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    // L0 (no proxy, no deploy key) passes NEITHER --allowedTools nor --disallowedTools override at
    // the claudeArgs opts layer — claudeArgs itself defaults to WORKER_ALLOWED_TOOLS internally, so
    // the ARGV still carries --allowedTools with the DEFAULT (gh-including) string.
    const argLines = args.trim().split("\n");
    const allowedTools = argLines[argLines.indexOf("--allowedTools") + 1]!;
    assert.match(allowedTools, /Bash\(gh \*\)/, "L0 keeps Bash(gh *) — unchanged from today");
    assert.equal(probeCalled, false, "deployKeyPath unset -> resolveDeployKeyEnv must short-circuit before ever probing");
    s.dispose();
  } finally {
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch (#554 pattern): deployKeyPath set but preflight auth fails -> guidance-carrying WARN naming the re-provision fix, dispatch continues at L0 (never wedges)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const logs: string[] = [];
    const deployKeyCfg = cfgWithDeployKey("/tmp/fake-deploy-key-606-preflight-fail");
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
      log: (m) => logs.push(m),
      probeDeployKeySsh: async () => ({ ok: false, detail: "Permission denied (publickey)." }),
    });
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-l1-preflight-fail");
    await waitFor(() => logs.some((l) => l.includes("deploy-key")), "expected a deploy-key preflight WARN log line");
    const warn = logs.find((l) => l.includes("deploy-key"))!;
    assert.match(warn, /preflight failed/i);
    assert.match(warn, /Permission denied \(publickey\)/);
    assert.match(warn, /sapwood init/, "the WARN must name the exact re-provision fix");
    assert.match(warn, /L0/);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: the deploy-key preflight probe is memoized — TWO dispatches share ONE probe call and ONE WARN log line, never re-probed per lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const logs: string[] = [];
    let probeCount = 0;
    const deployKeyCfg = cfgWithDeployKey("/tmp/fake-deploy-key-606-memo");
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
      log: (m) => logs.push(m),
      probeDeployKeySsh: async () => {
        probeCount++;
        return { ok: false, detail: "network unreachable" };
      },
    });
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-l1-memo-1");
    await s.dispatch({ number: 2, title: "t2", labels: [] }, "lane-l1-memo-2");
    await waitFor(() => existsSync(join(dir, "lane-l1-memo-2.done.json")), "second dispatch did not complete");
    assert.equal(probeCount, 1, "the SSH-auth preflight must run at most once per supervisor life");
    assert.equal(logs.filter((l) => l.includes("preflight failed")).length, 1, "the WARN must fire exactly once, not once per dispatch");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: worker.deployKeyPath configured + preflight OK -> L1 active on a resumed leg too (same env/tool-narrowing as dispatch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const deployKeyCfg = cfgWithDeployKey("/tmp/fake-deploy-key-606-resume");
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: mkStub(dir, FAST_STUB),
      renderPrompt: () => "p",
      guardHookPath: hook,
      probeDeployKeySsh: async () => ({ ok: true }),
    });
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-l1-resume");
    await waitFor(() => existsSync(join(dir, `${name}.done.json`)), "initial dispatch did not complete");

    const bin2 = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args2.seen.tmp")}"\nmv "${join(dir, "args2.seen.tmp")}" "${join(dir, "args2.seen")}"\nenv > "${join(dir, "env2.seen.tmp")}"\nmv "${join(dir, "env2.seen.tmp")}" "${join(dir, "env2.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s2 = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: bin2,
      renderPrompt: () => "p",
      guardHookPath: hook,
      probeDeployKeySsh: async () => ({ ok: true }),
    });
    // A resumed leg needs a fresh handoff sentinel (dispatch() above already reached .done, not
    // .handoff) — write one directly, mirroring the shape requestHandoff itself writes.
    writeFileSync(
      join(dir, `${name}.handoff.json`),
      JSON.stringify({ session_id: "resume-606-session", dispatched_at: new Date().toISOString() }),
    );
    await s2.resume({ number: 1, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "env2.seen"), "L1 resume env was not published");
    const envText = readFileSync(join(dir, "env2.seen"), "utf8");
    assert.match(
      envText,
      /^GIT_SSH_COMMAND=ssh -i '\/tmp\/fake-deploy-key-606-resume' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new$/m,
    );
    // #606 gate② round 1 (P1-3): full severing on a resumed L1 leg too, not just dispatch.
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine, "GH_CONFIG_DIR must be set for a resumed L1 leg too");
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(envText, /^GIT_CONFIG_SYSTEM=\/dev\/null$/m);
    const args = readFileSync(join(dir, "args2.seen"), "utf8");
    const argLines = args.trim().split("\n");
    const allowedTools = argLines[argLines.indexOf("--allowedTools") + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/, "L1 resume must drop Bash(gh *) from the grant");
    assert.match(allowedTools, /Bash\(git \*\)/);
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #350: pin the FULL deny-list string so an accidental future edit (e.g. dropping a pattern
// while adding another) fails loudly. The permission layer is intentionally broader than
// guard.ts's argv-layer block: it denies the whole `gh pr review`/`gh release` verbs, while
// the guard only blocks the `--approve`/`--request-changes` argv shapes — out of scope for
// this constant. #617 ((b′), capability DR #616): the `mcp__` suffix is the server-granularity
// MCP deny — see WORKER_DISALLOWED_TOOLS's own doc for the forge-authority/write-exec-class
// rationale and the #554 (allowManagedPermissionRulesOnly) interaction.
test("WORKER_DISALLOWED_TOOLS: exact deny-list value — merge/ready (pre-existing), review/release (#350), governance (#488), MCP server denies (#617)", () => {
  assert.equal(
    WORKER_DISALLOWED_TOOLS,
    "Bash(gh pr merge*),Bash(gh pr ready*),Bash(gh pr review*),Bash(gh release*),Bash(gh issue edit*),Bash(gh label*),Bash(gh project*)," +
      "mcp__github__*,mcp__server-filesystem__*,mcp__filesystem__*,mcp__Google_Drive__*",
  );
});

/** Minimal `Bash(<prefix>*)` matcher — the only rule shape this deny-list uses. Lets the #488
 *  cases below read as "which commands does a worker session lose", not as a string diff. */
const deniedBy = (command: string): string | undefined =>
  WORKER_DISALLOWED_TOOLS.split(",").find((rule) => command.startsWith(rule.replace(/^Bash\(/, "").replace(/\*?\)$/, "")));

// #488: the dispatch/merge gates treat issue labels and board Status as engine-or-human-only
// signals (plan:approved, round:pool, the Ready lane). A producer that can set them forges the
// very signals those gates trust — so the permission layer denies them too, mirroring the
// guard's own already-enforced Category C blocks on `gh label`/`gh project`/governance-flag
// `gh issue edit` (guard.test.ts's BLOCK matrix). `gh api` is deliberately NOT denied here:
// read-only `gh api` is ordinary worker usage and a coarse prefix rule cannot separate it from
// a mutation, which is exactly the argv-shape judgement the guard already makes.
test("WORKER_DISALLOWED_TOOLS: label / board-status mutation is denied for the producer (#488)", () => {
  for (const cmd of [
    "gh issue edit 488 --add-label sapwood:plan:approved",
    "gh issue edit 488 --remove-label sapwood:blocked",
    "gh label create forged",
    "gh label edit hold --color ff0000",
    "gh label delete hold",
    "gh project item-edit --id ITEM --field-id STATUS --single-select-option-id READY",
    "gh project item-add 4 --url https://github.com/o/r/issues/488",
  ]) {
    assert.ok(deniedBy(cmd), `expected a deny rule to cover: ${cmd}`);
  }
});

// The change is a boundary narrowing, not a `gh` removal — the stock worker workflow (push,
// open the PR, talk on the issue/PR, read state) must survive it untouched.
test("WORKER_DISALLOWED_TOOLS: ordinary worker gh usage stays allowed (#488)", () => {
  for (const cmd of [
    "gh pr create --title t --body b",
    "gh pr comment 488 --body b",
    "gh pr view 488",
    "gh issue view 488",
    "gh issue comment 488 --body b",
    "gh issue list --label sapwood:round:pool",
    "gh api repos/o/r/issues/488",
  ]) {
    assert.equal(deniedBy(cmd), undefined, `expected no deny rule to cover: ${cmd}`);
  }
});

// #617 ((b′), capability DR #616): server-granularity MCP denies for the two named categories —
// forge-authority (github-class) and write/exec-class (filesystem-class), the exact write/exec
// tool names the #616 live probe found inherited and callable.
test("WORKER_DISALLOWED_TOOLS: known forge-authority + write/exec-class MCP servers are denied (#617)", () => {
  const entries = WORKER_DISALLOWED_TOOLS.split(",");
  for (const rule of ["mcp__github__*", "mcp__server-filesystem__*", "mcp__filesystem__*", "mcp__Google_Drive__*"]) {
    assert.ok(entries.includes(rule), `expected ${rule} in WORKER_DISALLOWED_TOOLS`);
  }
});

// #552 decision (docs/security.md, "the code-producing worker deliberately retains spawn
// capability"): unlike #534's peripheral-role/gate②-reviewer deny (ROLE_DISALLOWED_TOOLS names
// Agent/Task explicitly, peripheral.test.ts), the coding worker's OWN deny list stays a gh-verb
// pattern list only — no name-list entry for either subagent-spawn tool. Pins the DECISION, not
// just WORKER_DISALLOWED_TOOLS' string value (already pinned above): a future edit that adds
// Agent/Task here would silently reverse #552's ruling without ever touching this test's name.
test("WORKER_DISALLOWED_TOOLS: Agent/Task are NOT denied — the coding worker keeps subagent spawn (#552 decision)", () => {
  for (const spawnTool of ["Agent", "Task"]) {
    assert.ok(
      !WORKER_DISALLOWED_TOOLS.split(",").includes(spawnTool),
      `${spawnTool} must stay unlisted — #552 decided to keep worker subagent spawn, accepting the soft-budget blind spot as documented in docs/security.md`,
    );
  }
});

// #244 (Codex sol-high PR #260 review, P2): fail-closed policy — credentialFree + a failed mint
// leaves a leg with NEITHER the gh/git credentialed-tool path (severed by workerCredentialFreeEnv)
// NOR a working evidence channel, so dispatch() must REFUSE outright rather than silently run
// degraded (distinct from the non-credentialFree mint-failure case above, which stays non-fatal).
test("dispatch: credentialFree + mint FAILURE refuses the dispatch outright (fail-closed) — no lane created, no sentinel written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-credfree-mintfail", {
          proxy: {
            mint: async () => {
              throw new Error("mint failed");
            },
            credentialFree: true,
          },
        }),
      /credentialFree|refused/i,
    );
    assert.ok(!existsSync(join(dir, "lane-credfree-mintfail.jsonl")), "no jsonl left behind for a refused dispatch");
    assert.ok(!existsSync(join(dir, "lane-credfree-mintfail.running.json")), "no running marker left behind for a refused dispatch");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 (Codex sol-high PR #260 review, P2): durable mint-failure observability — a
// `proxy-mint-failed` event, recorded via WorkerDeps.state, for BOTH branches (non-fatal and
// fail-closed) so a repeated/systemic mint failure is queryable, not just a transient log line.
test("dispatch: a mint failure records a durable 'proxy-mint-failed' event (WorkerDeps.state) — both the non-fatal and the fail-closed branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
      state,
    });
    // Branch 1: non-fatal (no credentialFree) — the lane still dispatches.
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-mintfail-nonfatal", {
      proxy: {
        mint: async () => {
          throw new Error("mint failed #1");
        },
      },
    });
    // Branch 2: fail-closed (credentialFree) — dispatch is refused.
    await assert.rejects(() =>
      s.dispatch({ number: 2, title: "t", labels: [] }, "lane-mintfail-failclosed", {
        proxy: {
          mint: async () => {
            throw new Error("mint failed #2");
          },
          credentialFree: true,
        },
      }),
    );
    const events = state.eventsSince("1970-01-01T00:00:00Z", ["proxy-mint-failed"]);
    assert.equal(events.length, 2);
    const lanes = events.map((e) => (e.payload as { lane: string }).lane).sort();
    assert.deepEqual(lanes, ["lane-mintfail-failclosed", "lane-mintfail-nonfatal"]);
    for (const e of events) {
      const payload = e.payload as { role: string; reason: string };
      assert.equal(payload.role, "worker");
      assert.ok(payload.reason.includes("mint failed"));
    }
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a proxy attached WITHOUT credentialFree keeps today's env inheritance — a worker leg legitimately keeps GH_TOKEN unless it explicitly opts into credentialFree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "worker-forge-token";
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho "$GH_TOKEN" > "${join(dir, "token.seen.tmp")}"\nmv "${join(dir, "token.seen.tmp")}" "${join(dir, "token.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, { proxy: { mint: async () => handle as never } });
    await waitForFile(join(dir, "token.seen"), "inherited worker token was not published");
    assert.equal(readFileSync(join(dir, "token.seen"), "utf8").trim(), "worker-forge-token");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

// #617 (seam 3, capability DR #616): a worker/producer leg now records the SAME ContextManifest
// fingerprint peripheral.ts's RoleRunner already records for its 10 peripheral call sites — see
// WorkerSupervisor.recordLaneContextManifest's own doc for the (roundId:0, phase:"worker") key.
test("dispatch: a worker leg records a ContextManifest fingerprint via WorkerDeps.state.recordContextManifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const hook = mkHook(dir);
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-stub-model",
      claude_code_version: "9.9.9",
      tools: ["Read", "Write", "Bash"],
      mcp_servers: [{ name: "server-filesystem", status: "pending" }],
    });
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho '${initLine}'\necho '{"type":"result","total_cost_usd":0.0001}'\nexit 0\n`);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: hook,
      state,
      preSpawnCaptureTimeoutMs: 2_000,
      preSpawnCapturePollMs: 20,
    });
    const { name } = await s.dispatch({ number: 617, title: "manifest test", labels: [] });
    await waitForFile(join(dir, `${name}.done.json`), "lane did not reach a terminal sentinel");
    // The pre-spawn capture is fire-and-forget (never awaited by dispatch()) — poll for the
    // manifest row to land rather than assuming it's there the instant done.json is.
    let recorded: { recordedAt: string; json: string } | undefined;
    for (let i = 0; i < 200 && !recorded; i++) {
      recorded = state.getContextManifest({ roundId: 0, phase: "worker", role: "worker", session: name, attempt: 1 });
      if (!recorded) await sleep(20);
    }
    assert.ok(recorded, "expected a context_manifests row for this lane");
    const manifest = JSON.parse(recorded!.json);
    assert.equal(manifest.model, "claude-stub-model");
    assert.equal(manifest.modelSource, "session-init");
    assert.equal(manifest.cliVersion, "9.9.9");
    assert.ok(typeof manifest.toolInventoryHash === "string" && manifest.toolInventoryHash.length > 0);
    // #616 probe nuance: mcpTools comes from the init report's mcp_servers field (name:status),
    // NOT derived from the (possibly MCP-tool-empty, deferred-loading) `tools` inventory above —
    // even though `tools` here carries zero mcp__-prefixed entries, the server still shows up.
    assert.deepEqual(manifest.mcpTools, ["server-filesystem:pending"]);
    assert.ok(typeof manifest.settingsHash === "string" && manifest.settingsHash.length > 0);
    // The stub never provisions a real `--worktree` checkout (it just echoes JSON and exits), so
    // this reads as "worktree-missing" rather than "unknown-write-capable-session" — a real
    // `claude` CLI dispatch DOES provision one; see WorktreeGitState.dirtyBasis's own doc for why
    // both bases record `dirty: true` regardless (the manifest never guesses "clean").
    assert.equal(manifest.worktree.dirtyBasis, "worktree-missing");
    assert.equal(manifest.worktree.dirty, true);
    assert.equal(manifest.captureBasis, "init-observed");
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a resumed leg's ContextManifest OVERWRITES the prior leg's row under the same (lane-name-keyed) identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const { s, name } = await mkHandoffLane(dir, `  echo '{"type":"system","subtype":"init","model":"resumed-model"}'\n  ${RESULT_LINE}`, {
      state,
      preSpawnCaptureTimeoutMs: 2_000,
      preSpawnCapturePollMs: 20,
    });
    await s.resume({ number: 9, title: "t", labels: [] }, name);
    let recorded: { recordedAt: string; json: string } | undefined;
    for (let i = 0; i < 200 && !recorded; i++) {
      recorded = state.getContextManifest({ roundId: 0, phase: "worker", role: "worker", session: name, attempt: 1 });
      if (!recorded) await sleep(20);
    }
    assert.ok(recorded, "expected a context_manifests row for the resumed lane");
    assert.equal(JSON.parse(recorded!.json).model, "resumed-model");
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245: resume()'s own forge MCP proxy attachment — mirrors dispatch()'s #244 mechanism above,
// extended to WorkerSupervisor.resume() (the fix-loop worker leg's evidence channel). Every
// resume() test ABOVE this section (no proxy/prompt opt) is unchanged behavior; these tests
// cover only the NEW opt-in `proxy`/`prompt` params.
// ─────────────────────────────────────────────────────────────────────────────

/** Dispatches a cooperative (TERM-trap) lane and hands it off, leaving a `.handoff` sentinel
 *  ready for resume() — the common setup every test below needs. `postResumeBody` is the bash
 *  fragment that runs ONLY on the `--resume` invocation (the fresh dispatch always sleeps +
 *  traps TERM, standing in for the original leg). */
async function mkHandoffLane(
  dir: string,
  postResumeBody: string,
  extraDeps: Partial<WorkerDeps> = {},
): Promise<{ s: WorkerSupervisor; name: string; sessionId: string; hook: string }> {
  const hook = mkHook(dir);
  const ready = join(dir, "stub-ready");
  const bin = mkStub(
    dir,
    [
      "#!/usr/bin/env bash",
      'if [[ "$*" == *"--resume"* ]]; then',
      postResumeBody,
      "fi",
      "trap 'exit 0' TERM",
      `touch "${ready}"`,
      "for _ in $(seq 1 600); do sleep 1; done",
      "",
    ].join("\n"),
  );
  const s = new WorkerSupervisor({
    now: realClock,
    cfg,
    stateDir: dir,
    claudeBin: bin,
    renderPrompt: () => "issue-rendered-prompt",
    heartbeatMs: 50,
    guardHookPath: hook,
    ...extraDeps,
  });
  const { name, sessionId } = await s.dispatch({ number: 9, title: "t", labels: [] });
  await waitForFile(ready, "stub installed its TERM trap before handoff");
  assert.equal(s.requestHandoff(name), true);
  for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
  assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handed off before resuming");
  return { s, name, sessionId, hook };
}

const RESULT_LINE =
  'echo \'{"type":"result","subtype":"success","total_cost_usd":0.01,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'\nexit 0';

test("resume: a proxy opt mints a handle, widens --allowedTools with the handle's own tool names, and injects --mcp-config inline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    const { calls, handle } = fakeWorkerProxyHandle();
    const resumed = await s.resume({ number: 9, title: "t", labels: [] }, name, {
      proxy: {
        mint: async (session) => {
          calls.minted++;
          assert.equal(session.role, "worker");
          assert.equal(session.session, name);
          return handle as never;
        },
      },
    });
    assert.equal(resumed.name, name);
    await waitForFile(join(dir, "args.seen"), "proxy resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /mcp__forge__pr_details/);
    // #556: the audit tool's wire name reaches --allowedTools verbatim — asserted from the
    // CONSTRUCTED argv (the value the CLI actually receives), literal, not constant-derived.
    const allowedIdx = args.trim().split("\n").indexOf("--allowedTools");
    const allowed = args.trim().split("\n")[allowedIdx + 1]!;
    assert.match(allowed, /mcp__forge__pr_audit_comments/);
    assert.match(args, /--mcp-config/);
    const idx = args.trim().split("\n").indexOf("--mcp-config");
    assert.equal(args.trim().split("\n")[idx + 1], handle.mcpConfigJson);
    assert.equal(calls.minted, 1);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && calls.stopped === 0; i++) await sleep(20);
    assert.equal(calls.stopped, 1, "the proxy is torn down once the resumed lane's process exits (onExit)");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume (#639): WorkerDeps.skillsPluginDir set -> --plugin-dir <dir> reaches the RESUMED leg's argv too (resume/fix legs are YES per the injection policy table)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
      { skillsPluginDir: "/data/generated/role-skills/deadbeef" },
    );
    await s.resume({ number: 9, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "args.seen"), "skills-plugin resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8").trim().split("\n");
    const i = args.indexOf("--plugin-dir");
    assert.ok(i !== -1, "--plugin-dir must reach the resumed leg's argv too");
    assert.equal(args[i + 1], "/data/generated/role-skills/deadbeef");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume (#639 gate② round 1): WorkerDeps.skillsPluginDir set -> --plugin-dir <dir> reaches a genuine FIX-ENTRY resumed leg's argv too (opts.sessionId, no .handoff sentinel — mirrors the A1 fix-leg-entry test above, the gate found the #639 coverage above only exercised ordinary handoff-resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  printf '%s\\n' "$@" > "${join(dir, "fix-args.seen.tmp")}"`,
        `  mv "${join(dir, "fix-args.seen.tmp")}" "${join(dir, "fix-args.seen")}"`,
        RESULT_LINE,
        "fi",
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.001,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "exit 0",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "issue-rendered-prompt",
      heartbeatMs: 50,
      guardHookPath: hook,
      skillsPluginDir: "/data/generated/role-skills/deadbeef",
    });
    // Same driving-lane precondition as the A1 fix-leg-entry test: a fresh dispatch completes
    // DONE quickly (no --resume in the fake stub's first invocation), leaving a done sentinel
    // and NO handoff sentinel — exactly what a fix leg starts from.
    const { name, sessionId } = await s.dispatch({ number: 21, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "no handoff sentinel — the fix-leg-entry precondition");

    const resumed = await s.resume({ number: 21, title: "t", labels: [] }, name, {
      sessionId,
      prompt: "fix-leg: address PR #650's gate② review findings",
    });
    assert.equal(resumed.sessionId, sessionId, "SAME session — a fix leg continues the original conversation");

    await waitForFile(join(dir, "fix-args.seen"), "fix-leg argv was not published");
    const args = readFileSync(join(dir, "fix-args.seen"), "utf8").trim().split("\n");
    const i = args.indexOf("--plugin-dir");
    assert.ok(i !== -1, "--plugin-dir must reach a genuine FIX-ENTRY resumed leg's argv too");
    assert.equal(args[i + 1], "/data/generated/role-skills/deadbeef");

    for (let i2 = 0; i2 < 400 && !existsSync(join(dir, `${name}.done.json`)); i2++) await sleep(20);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: opts.prompt REPLACES the ordinary issue-rendered prompt — the fix leg's own fix instruction — and is the exact string passed to claude -p", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    await s.resume({ number: 9, title: "t", labels: [] }, name, { prompt: "fix-leg: address PR #42's review findings" });
    await waitForFile(join(dir, "args.seen"), "prompt-override resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8").trim().split("\n");
    const promptIdx = args.indexOf("-p");
    assert.equal(args[promptIdx + 1], "fix-leg: address PR #42's review findings");
    assert.ok(!args.includes("issue-rendered-prompt"), "the ordinary renderPrompt output must not appear when opts.prompt overrides it");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: no proxy/prompt opt -> byte-identical to pre-#245 behavior (renderPrompt output, no --mcp-config)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    await s.resume({ number: 9, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "args.seen"), "ordinary resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.doesNotMatch(args, /--mcp-config/);
    assert.doesNotMatch(args, /mcp__forge__/);
    assert.match(args, /issue-rendered-prompt/);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a proxy mint FAILURE is non-fatal — the resumed leg still runs, unattached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    await s.resume({ number: 9, title: "t", labels: [] }, name, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed");
        },
      },
    });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "resumed leg still completes despite the mint failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: credentialFree + mint FAILURE refuses the resume outright (fail-closed) — .handoff sentinel and prior jsonl are left INTACT (never destroyed, unlike dispatch()'s fresh-lane cleanup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    const priorJsonl = readFileSync(join(dir, `${name}.jsonl`), "utf8");
    await assert.rejects(
      () =>
        s.resume({ number: 9, title: "t", labels: [] }, name, {
          proxy: {
            mint: async () => {
              throw new Error("mint failed");
            },
            credentialFree: true,
          },
        }),
      /credentialFree|refused/i,
    );
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "a refused resume must leave the lane exactly as resumable as before");
    assert.equal(readFileSync(join(dir, `${name}.jsonl`), "utf8"), priorJsonl, "prior-leg jsonl history must survive a refused resume");
    // A genuine retry (no credentialFree, or a working mint) must still be possible afterward.
    const retried = await s.resume({ number: 9, title: "t", labels: [] }, name);
    assert.equal(retried.name, name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: credentialFree strips forge/git credential env vars and narrows --allowedTools (drops Bash(gh *), keeps Bash(git *)) for the resumed leg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const release = join(dir, "release-resumed-stub");
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "poison-gh-token";
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  env > "${join(dir, "env.seen.tmp")}"\n  mv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\n  for _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done\n  ${RESULT_LINE}`,
    );
    const { handle } = fakeWorkerProxyHandle();
    await s.resume({ number: 9, title: "t", labels: [] }, name, { proxy: { mint: async () => handle as never, credentialFree: true } });
    await waitForFile(join(dir, "env.seen"), "credential-free resume env was not published");
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    assert.ok(!envText.includes("GH_TOKEN=poison-gh-token"), "GH_TOKEN must not leak into a credentialFree resumed leg's env");
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine);
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.ok(existsSync(ghConfigDir), "GH_CONFIG_DIR must exist as a fresh directory");
    assert.deepEqual(readdirSync(ghConfigDir), []);
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const allowedToolsIdx = args.trim().split("\n").indexOf("--allowedTools");
    const allowedTools = args.trim().split("\n")[allowedToolsIdx + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/);
    assert.match(allowedTools, /Bash\(git \*\)/);
    // #617 (seam 1): same seal as dispatch() — --strict-mcp-config present, --mcp-config carries
    // ONLY the proxy's own (proxy-only) server.
    const argLines = args.trim().split("\n");
    assert.ok(argLines.includes("--strict-mcp-config"), "credentialFree resume must emit --strict-mcp-config");
    const mcpConfigIdx = argLines.indexOf("--mcp-config");
    assert.notEqual(mcpConfigIdx, -1, "credentialFree resume must emit --mcp-config");
    assert.equal(argLines[mcpConfigIdx + 1], handle.mcpConfigJson);
    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && existsSync(ghConfigDir); i++) await sleep(20);
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory is cleaned up once the lane exits");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a non-credentialFree proxy attachment must NOT emit --strict-mcp-config — the seal is scoped to credentialFree alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    const { handle } = fakeWorkerProxyHandle();
    await s.resume({ number: 9, title: "t", labels: [] }, name, { proxy: { mint: async () => handle as never } });
    await waitForFile(join(dir, "args.seen"), "resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.ok(!args.trim().split("\n").includes("--strict-mcp-config"), "non-credentialFree resume must not emit --strict-mcp-config");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a mint failure records a durable 'proxy-mint-failed' event (WorkerDeps.state) — both the non-fatal and the fail-closed branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const hook = mkHook(dir);
    const ready = join(dir, "stub-ready");
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  ${RESULT_LINE}`,
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
      state,
    });
    const { name: name1 } = await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-resume-mintfail-1");
    await waitForFile(ready, "first stub installed its TERM trap before handoff");
    s.requestHandoff(name1);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name1}.handoff.json`)); i++) await sleep(20);
    await s.resume({ number: 1, title: "t", labels: [] }, name1, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed #1");
        },
      },
    });

    rmSync(ready, { force: true });
    const { name: name2 } = await s.dispatch({ number: 2, title: "t", labels: [] }, "lane-resume-mintfail-2");
    await waitForFile(ready, "second stub installed its TERM trap before handoff");
    s.requestHandoff(name2);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name2}.handoff.json`)); i++) await sleep(20);
    await assert.rejects(() =>
      s.resume({ number: 2, title: "t", labels: [] }, name2, {
        proxy: {
          mint: async () => {
            throw new Error("mint failed #2");
          },
          credentialFree: true,
        },
      }),
    );

    const events = state.eventsSince("1970-01-01T00:00:00Z", ["proxy-mint-failed"]);
    assert.equal(events.length, 2);
    for (const e of events) {
      const payload = e.payload as { role: string; reason: string };
      assert.equal(payload.role, "worker");
      assert.ok(payload.reason.includes("mint failed"));
    }
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix (Codex sol-high review, PR #263): A1 — resume() must support FIX-LEG ENTRY
// (starting a fix leg from a `driving` lane, which has a `.done`/`.failed` sentinel but NO
// `.handoff` sentinel — the ordinary #172 handoff-resume precondition). The real WorkerSupervisor
// used to throw "no .handoff sentinel — nothing to resume" here, which every prior test missed
// because they all used a FakeSupervisor. This section is a REAL WorkerSupervisor integration.
// ─────────────────────────────────────────────────────────────────────────────

test("resume: FIX-LEG ENTRY (opts.sessionId, no .handoff sentinel) — real WorkerSupervisor integration: dispatch -> done (driving precondition) -> resume -> a second leg reusing the SAME session (A1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  printf '%s\\n' "$@" > "${join(dir, "fix-args.seen.tmp")}"`,
        `  mv "${join(dir, "fix-args.seen.tmp")}" "${join(dir, "fix-args.seen")}"`,
        RESULT_LINE,
        "fi",
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.001,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "exit 0",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "issue-rendered-prompt",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    // Fresh dispatch completes DONE quickly (the fake stub exits 0 immediately when NOT
    // --resume) — exactly the `driving`-lane precondition a fix leg starts from: a done
    // sentinel, no handoff sentinel.
    const { name, sessionId } = await s.dispatch({ number: 20, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));
    assert.ok(
      !existsSync(join(dir, `${name}.handoff.json`)),
      "no handoff sentinel — this is exactly the driving-lane precondition a fix leg starts from",
    );

    // The real bug A1 fixes: resume() used to unconditionally require .handoff and throw here.
    const resumed = await s.resume({ number: 20, title: "t", labels: [] }, name, {
      sessionId,
      prompt: "fix-leg: address PR #77's review findings",
    });
    assert.equal(resumed.name, name);
    assert.equal(resumed.sessionId, sessionId, "SAME session — a fix leg continues the original conversation, never --fork-session");

    await waitForFile(join(dir, "fix-args.seen"), "fix-leg argv was not published");
    const args = readFileSync(join(dir, "fix-args.seen"), "utf8").trim().split("\n");
    const promptIdx = args.indexOf("-p");
    assert.equal(args[promptIdx + 1], "fix-leg: address PR #77's review findings");
    const resumeIdx = args.indexOf("--resume");
    assert.equal(args[resumeIdx + 1], sessionId, "claude --resume reuses the ORIGINAL session id");

    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.done, true, "the fix leg reaches its own fresh terminal sentinel");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #606 gate② round 1 (P1-4): production fix legs ALWAYS dispatch with proxy.credentialFree:true
// (conductor.ts's startFixLeg, conductor.ts:4354) — before this fix, dispatch()/resume() treated
// deployKeyEnv and credentialFree as MUTUALLY EXCLUSIVE, so a fix leg with an L1 deploy key
// configured got NEITHER an API credential NOR the deploy key and could not push its own fix.
// This test is the "genuinely fix-shaped" case: opts.sessionId + opts.prompt (fix-leg entry,
// mirroring the FIX-LEG ENTRY test above) PLUS a credentialFree proxy PLUS worker.deployKeyPath
// configured — asserting the two postures COMPOSE rather than one silently winning.
test("resume: FIX-LEG ENTRY (opts.sessionId+prompt) WITH credentialFree AND worker.deployKeyPath configured -> composed env: GIT_SSH_COMMAND present (the fix leg can push via the deploy key) AND the credential-free severing stays fully intact (GH_CONFIG_DIR fresh empty dir, GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, no GH_TOKEN)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previousGhToken = process.env.GH_TOKEN;
  // #606 gate② round 1 (P1-3/P1-4): the --resume leg PAUSES on `release` before exiting — the
  // GH_CONFIG_DIR directory-existence assertion below needs the child still alive to observe it
  // (onExit removes it as soon as the child exits; same release-gate pattern the credentialFree
  // tests above already use).
  const release = join(dir, "release-fix-p14");
  try {
    process.env.GH_TOKEN = "poison-gh-token-p14";
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  printf '%s\\n' "$@" > "${join(dir, "fix-args-p14.seen.tmp")}"`,
        `  mv "${join(dir, "fix-args-p14.seen.tmp")}" "${join(dir, "fix-args-p14.seen")}"`,
        `  env > "${join(dir, "fix-env-p14.seen.tmp")}"`,
        `  mv "${join(dir, "fix-env-p14.seen.tmp")}" "${join(dir, "fix-env-p14.seen")}"`,
        `  for _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done`,
        RESULT_LINE,
        "fi",
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.001,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "exit 0",
      ].join("\n"),
    );
    const deployKeyCfg = cfgWithDeployKey("/tmp/fake-deploy-key-606-p14");
    const s = new WorkerSupervisor({
      now: realClock,
      cfg: deployKeyCfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "issue-rendered-prompt",
      heartbeatMs: 50,
      guardHookPath: hook,
      probeDeployKeySsh: async () => ({ ok: true }),
    });
    // Fresh dispatch -> done (the driving-lane precondition a fix leg starts from).
    const { name, sessionId } = await s.dispatch({ number: 21, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));

    const { handle } = fakeWorkerProxyHandle();
    const resumed = await s.resume({ number: 21, title: "t", labels: [] }, name, {
      sessionId,
      prompt: "fix-leg: address PR #99's review findings",
      proxy: { mint: async () => handle as never, credentialFree: true },
    });
    assert.equal(resumed.sessionId, sessionId, "SAME session — a fix leg continues the original conversation");

    await waitForFile(join(dir, "fix-env-p14.seen"), "fix-leg env was not published");
    const envText = readFileSync(join(dir, "fix-env-p14.seen"), "utf8");
    // The deploy-key overlay: the fix leg CAN push through the deploy key.
    assert.match(
      envText,
      /^GIT_SSH_COMMAND=ssh -i '\/tmp\/fake-deploy-key-606-p14' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new$/m,
    );
    assert.match(envText, /^GIT_CONFIG_COUNT=2$/m);
    // ...and the credential-free severing stays fully intact — COMPOSED, never replaced.
    assert.doesNotMatch(envText, /GH_TOKEN=poison-gh-token-p14/);
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine, "GH_CONFIG_DIR must still be set — the deploy key does not override credentialFree's own isolation");
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.ok(existsSync(ghConfigDir), "GH_CONFIG_DIR must exist as a fresh directory");
    assert.deepEqual(readdirSync(ghConfigDir), [], "GH_CONFIG_DIR must be a FRESH, EMPTY directory");
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(envText, /^GIT_CONFIG_SYSTEM=\/dev\/null$/m);
    assert.match(envText, /^GIT_TERMINAL_PROMPT=0$/m);

    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry fails closed with NO terminal sentinel at all (never starts a fix leg with no prior-leg evidence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-never-existed", { sessionId: "sess-x", prompt: "fix it" }),
      /no done\/failed terminal sentinel/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry fails closed when opts.sessionId is set but opts.prompt is missing (caller bug, not a runtime condition)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-x", { sessionId: "sess-x" }),
      /opts\.sessionId .* requires opts\.prompt/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #245 round-2 fix (A4): a failure AFTER a successful mint (here: the durable intent-write,
// writeJsonAtomic(runningPath, ...)) must still tear down the minted proxy and remove any
// GH_CONFIG_DIR already created — not just a credentialFree mint-failure's own throw.
test("resume: a failure AFTER a successful mint (intent-write failure) tears down the minted proxy and removes any created GH_CONFIG_DIR (A4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    const runningPath = join(dir, `${name}.running.json`);
    // Force writeJsonAtomic's internal rename to fail deterministically: pre-create the EXACT
    // tmp path it will try to write to as a DIRECTORY (EISDIR on writeFileSync) — no reliance
    // on filesystem permission bits, which root/CI environments can bypass.
    mkdirSync(`${runningPath}.tmp.${process.pid}`, { recursive: true });
    const { calls, handle } = fakeWorkerProxyHandle();
    await assert.rejects(() =>
      s.resume({ number: 9, title: "t", labels: [] }, name, {
        proxy: {
          mint: async () => {
            calls.minted++;
            return handle as never;
          },
          credentialFree: true,
        },
      }),
    );
    assert.equal(calls.minted, 1, "mint succeeded before the intent-write failed");
    assert.equal(calls.stopped, 1, "A4: the minted proxy must be torn down even though the failure happened AFTER mint, not at mint time");
    const ghConfigDir = join(dir, `${name}.gh-config-empty`);
    assert.ok(!existsSync(ghConfigDir), "A4: the GH_CONFIG_DIR scratch directory created before the intent-write failure must be removed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix ROUND 2 (Codex sol-high delta re-review): B1 — fix-leg entry required a
// `.done`/`.failed` sentinel to EXIST but never consumed it, so once the fix leg was live
// (lane spawned, spawn confirmed), FIXING RECLAIM's probe() kept reading the STALE prior-leg
// sentinel as if it were the new leg's own terminal signal.
// ─────────────────────────────────────────────────────────────────────────────

test("resume: FIX-LEG ENTRY consumes the stale prior-leg terminal sentinel on spawn confirmation — a live fix child is never mistaken for already-terminal (B1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        "  trap 'exit 0' TERM",
        "  for _ in $(seq 1 600); do sleep 1; done",
        "fi",
        RESULT_LINE,
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name, sessionId } = await s.dispatch({ number: 30, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "sanity: the stale sentinel exists before the fix leg even starts");

    await s.resume({ number: 30, title: "t", labels: [] }, name, { sessionId, prompt: "fix it" });

    assert.ok(!existsSync(join(dir, `${name}.done.json`)), "B1: the stale sentinel is consumed once THIS leg's spawn is confirmed durable");
    const probe = await s.probe(name);
    assert.equal(probe.done, false, "a live, still-sleeping fix child must never be reported done via a stale sentinel");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry does NOT remove the stale terminal sentinel when the spawn attempt itself fails — the next retry's entry check must still pass (B1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: bin,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name, sessionId } = await s.dispatch({ number: 31, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));

    const s2 = new WorkerSupervisor({
      now: realClock,
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s2.resume({ number: 31, title: "t", labels: [] }, name, { sessionId, prompt: "fix it" }),
      /resume-spawn failed/i,
    );
    assert.ok(
      existsSync(join(dir, `${name}.done.json`)),
      "the stale sentinel must survive a FAILED spawn attempt — the next retry's entry check needs it",
    );
    s.dispose();
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #490: resolveWorktreeHead — pure-file worktree head resolution ────────────────────────────

test("resolveWorktreeHead (#490): detached HEAD (raw sha) resolves directly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "AB12cd34ab12cd34ab12cd34ab12cd34ab12cd34\n");
    assert.equal(resolveWorktreeHead(join(dir, ".git")), "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (#490): linked-worktree gitdir file -> symbolic HEAD -> loose ref in the commondir", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    const common = join(dir, "main-repo-.git");
    const wtGit = join(common, "worktrees", "lane-a");
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    mkdirSync(wtGit, { recursive: true });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    writeFileSync(join(common, "refs", "heads", "feature"), "1234567890abcdef1234567890abcdef12345678\n");
    assert.equal(resolveWorktreeHead(join(dir, "wt", ".git")), "1234567890abcdef1234567890abcdef12345678");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (#490): packed ref (no loose file) resolves through packed-refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(dir, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\nfeedfacefeedfacefeedfacefeedfacefeedface refs/heads/main\n",
    );
    assert.equal(resolveWorktreeHead(join(dir, ".git")), "feedfacefeedfacefeedfacefeedfacefeedface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (#490): missing/unresolvable shapes return null, never a guess", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    assert.equal(resolveWorktreeHead(join(dir, "nope", ".git")), null);
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/gone\n");
    assert.equal(resolveWorktreeHead(join(dir, ".git")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (#490, #509 P2): a stale refs/heads shadow in the WORKTREE gitdir must not win over the common store", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    const common = join(dir, "main-repo-.git");
    const wtGit = join(common, "worktrees", "lane-a");
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    mkdirSync(join(wtGit, "refs", "heads"), { recursive: true });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    // The shadow (stale/worker-created) and the real shared ref disagree — the COMMON one wins.
    writeFileSync(join(wtGit, "refs", "heads", "feature"), "baadf00dbaadf00dbaadf00dbaadf00dbaadf00d\n");
    writeFileSync(join(common, "refs", "heads", "feature"), "1234567890abcdef1234567890abcdef12345678\n");
    assert.equal(resolveWorktreeHead(join(dir, "wt", ".git")), "1234567890abcdef1234567890abcdef12345678");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (#490, #509 P2): a worktree-local namespace (refs/bisect) resolves from the worktree gitdir and never falls through to the common packed-refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-wth-"));
  try {
    const common = join(dir, "main-repo-.git");
    const wtGit = join(common, "worktrees", "lane-a");
    mkdirSync(join(wtGit, "refs", "bisect"), { recursive: true });
    mkdirSync(common, { recursive: true });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "HEAD"), "ref: refs/bisect/bad\n");
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    writeFileSync(join(wtGit, "refs", "bisect", "bad"), "feedfacefeedfacefeedfacefeedfacefeedface\n");
    // A same-named entry in the common packed-refs must be ignored for a worktree-local ref.
    writeFileSync(join(common, "packed-refs"), "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34 refs/bisect/bad\n");
    assert.equal(resolveWorktreeHead(join(dir, "wt", ".git")), "feedfacefeedfacefeedfacefeedfacefeedface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
