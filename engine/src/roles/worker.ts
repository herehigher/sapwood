// worker.ts — the ONE module that touches the Claude CLI. Every `claude -p` flag, the
// stream-json cost parsing, CLAUDE_BIN discovery, the worktree, the sentinels, and the
// process-tree kill live here (PLAN.md: "Claude CLI coupling isolated in worker.ts").
//
// It implements the conductor's `Supervisor` seam (dispatch/probe/reclaim). Completion is
// signalled by SENTINEL FILES the wrapper writes — never the model's self-report (the robust
// part of 0day's loop_worker.sh, ported):
//   <name>.running.json   — written at spawn (issue + session_id + pid); resume marker
//   <name>.done.json      — clean exit (carries parsed total_cost_usd)
//   <name>.failed.json    — non-zero exit
//   <name>.handoff.json   — soft-budget graceful handoff (resumable; NOT a kill)
//   <name>.heartbeat      — mtime touched on an interval (outer liveness, not self-report)
//   <name>.jsonl          — claude stream-json output
//
// SECURITY: spawn uses an argv array + detached process group — never a shell. The coarse
// allowed/disallowedTools below are noise-reduction only; the real boundary is the
// fail-closed PreToolUse guard hook wired in via --settings (#26) — but only for the
// Bash/Write/Edit/MultiEdit/Read/Grep/Glob/NotebookRead tool family its matcher covers. A
// producer leg inherits the operator's host MCP surface (capability DR #616) and no `mcp__`
// tool call reaches this hook at all; see docs/security.md's "Worker network egress: accepted
// blind spot" section for the residual and branch protection as the mandatory backstop.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine } from "../config/doctrine.js";
import { estimateUsd, loadPricingTable, type PricingTable } from "../config/pricing.js";
import type { Issue, LanePrOutcome } from "../forge/forge.js";
import type { LaneProbe, ReclaimResult, ResumeIntentState, Supervisor } from "../loop/conductor.js";
import type { ForgeProxyHandle } from "../proxy/mcp-server.js";
import { sanitizeUpstreamError } from "../proxy/tools.js";
import type { CategorizedTokenUsage, ContextManifestKey, ModelUsageEntry, State } from "../state/state.js";
import { createHeartbeatGate, type HeartbeatGate } from "../util/heartbeat.js";
import { awaitSpawnConfirmation } from "../util/spawn-confirm.js";
import {
  assembleContextManifest,
  capturePreSpawnManifestData,
  KNOWN_UNPROBED_NOTE,
  type PreSpawnManifestCapture,
} from "./context-manifest.js";

/** A durable resume intent exists, but the engine restarted before spawn confirmation made
 *  the outcome knowable. Retrying could create a second Claude process in the same worktree. */
export class UnresumableLaneError extends Error {
  constructor(
    readonly lane: string,
    readonly issue: number,
  ) {
    super(`resume: ${lane} issue #${issue} has an unconfirmed spawn intent`);
    this.name = "UnresumableLaneError";
  }
}

/** Last `total_cost_usd` across the stream-json result lines (0 if none/garbage). #60/#69: a
 *  lane that's hard-killed (escalated past drain, or never resumed after a handoff) before ever
 *  producing a terminal "result" line has genuinely unrecoverable cost here — total_cost_usd
 *  only ever appears on that line, never mid-stream. That's a known ceiling, not a bug; the
 *  common drain case avoids it because a later `claude --resume` (reusing the untouched
 *  worktree in place) produces a real result line normally. */
export function parseCostUsd(jsonl: string): number {
  return parseCostUsdOrNull(jsonl) ?? 0;
}

/** #302 review (Codex P1, cost cap): the HONEST variant of `parseCostUsd` — `null` when the
 *  transcript carries NO cost record at all (no parseable `type:"result"` line with a numeric
 *  `total_cost_usd`, e.g. a session killed before it ever wrote one), vs. a real recorded number
 *  (possibly a true $0). `parseCostUsd` (above) keeps its 0-fallback contract for the many spend-
 *  accounting callers where under-counting an unknown is the accepted behavior; a caller whose
 *  DECISION depends on the difference (engine-agent.ts's retry-budget arithmetic: an UNKNOWN
 *  attempt-1 cost must never be treated as "$0 spent, full cap remains") reads this one. */
export function parseCostUsdOrNull(jsonl: string): number | null {
  let cost: number | null = null;
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; total_cost_usd?: number };
      if (obj.type === "result" && typeof obj.total_cost_usd === "number") cost = obj.total_cost_usd;
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return cost;
}

/** #304 / #410 / #534: one suspicious egress-shaped call observed in a completed session's
 *  stream-json transcript — a lexically suspicious Bash executable (a worker leg), a structured
 *  WebFetch/WebSearch tool_use block (a peripheral role session granted the #410 web-access
 *  tools), or a structured Agent/Task tool_use block (the #534 subagent-spawn channel).
 *  `executable` names the Bash executable OR the literal tool name (`"WebFetch"`/`"WebSearch"`/
 *  `"Agent"`/`"Task"`); `snippet` is evidence, not a command/query/description to replay, and is
 *  capped so a single tool call cannot inflate the events ledger without bound.
 *
 *  #387 (F18): `target` is present ONLY on a provably loopback-only hit (see
 *  `classifyEgressTarget`). Its ABSENCE is the fail-closed default — "not proven loopback", which
 *  covers real public egress AND every hit carrying no URL at all (a WebSearch query, an Agent
 *  spawn description) — so a public-egress hit's payload is byte-identical to its pre-#387 shape
 *  and nothing an operator should look at first ever loses prominence through a classifier bug. */
export interface EgressSuspect {
  executable: string;
  snippet: string;
  target?: "loopback";
}

const EGRESS_SNIPPET_MAX_CHARS = 200;
export const MAX_EGRESS_SUSPECTS_PER_LEG = 20;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Splits only on ordinary shell command separators outside quotes. On an unquoted heredoc or
 *  here-string operator (`<<`/`<<<`), fragments through that line are retained, then scanning
 *  stops at its newline so body data is never treated as commands. This deliberately over-skips
 *  every later line in the same tool call; false negatives are acceptable for this monitor-only
 *  lexical signal. Separators before that newline still end fragments normally. */
function shellFragments(command: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let lineHasHeredoc = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      lineHasHeredoc = true;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      const fragment = command.slice(start, i).trim();
      if (fragment) fragments.push(fragment);
      start = i + 1;
      if (ch === "\n" && lineHasHeredoc) return fragments;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) fragments.push(tail);
  return fragments;
}

/** Small word lexer for executable position only. Quotes group a word and are removed; no shell
 *  expansion is attempted. Malformed trailing quotes simply leave the accumulated word usable. */
function shellWords(fragment: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = (): void => {
    if (word.length > 0) words.push(word);
    word = "";
  };
  for (const ch of fragment) {
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
    }
  }
  if (escaped) word += "\\";
  flush();
  return words;
}

function fragmentExecutable(fragment: string): string | null {
  const words = shellWords(fragment);
  let i = 0;
  const skipAssignments = (): void => {
    while (i < words.length && SHELL_ASSIGNMENT.test(words[i]!)) i++;
  };
  skipAssignments();
  while (i < words.length && (words[i] === "env" || words[i] === "sudo")) {
    const prefix = words[i++]!;
    while (i < words.length) {
      const word = words[i]!;
      if (SHELL_ASSIGNMENT.test(word)) {
        i++;
        continue;
      }
      if (word === "--") {
        i++;
        break;
      }
      if (!word.startsWith("-")) break;
      i++;
      if (word.startsWith("--") && word.includes("=")) continue;
      if (
        (prefix === "env" && ["-u", "--unset", "-S", "--split-string"].includes(word)) ||
        (prefix === "sudo" &&
          [
            "-C",
            "-D",
            "-g",
            "-h",
            "-p",
            "-R",
            "-T",
            "-t",
            "-u",
            "--close-from",
            "--chdir",
            "--group",
            "--host",
            "--prompt",
            "--role",
            "--type",
            "--user",
          ].includes(word))
      ) {
        i++; // option argument; an absent one simply reaches end and produces no hit
      }
    }
    skipAssignments();
  }
  const executable = words[i];
  if (!executable) return null;
  return executable.split("/").filter(Boolean).at(-1) ?? null;
}

export interface EgressSuspectScan {
  hits: EgressSuspect[];
  truncated: boolean;
}

/** Every `scheme://authority` occurrence in a free-text snippet. Deliberately scheme-anchored:
 *  the alternative (a generic `host[:port][/path]` token match) cannot tell a URL path segment
 *  (`/foo.json`) from a bare hostname, and a mis-parsed path segment would either fabricate a
 *  public host or, worse, let a public one hide. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#'"]+)/gi;
/** `localhost` (and RFC 6761 `*.localhost`), the whole 127/8 block, and `::1` — bracketed or
 *  bare, with or without an IPv4-mapped prefix. Anchored: `localhost.example.invalid` is a
 *  PUBLIC lookalike, not loopback. */
const LOOPBACK_HOST = /^(localhost|[^\s]+\.localhost|127(\.\d{1,3}){3}|\[?(::1|::ffff:127(\.\d{1,3}){3})\]?)$/i;

/** Strips userinfo and port from a URL authority, keeping an IPv6 literal's brackets intact. */
function authorityHost(authority: string): string {
  const hostPort = authority.split("@").at(-1) ?? authority;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    return close === -1 ? hostPort : hostPort.slice(0, close + 1);
  }
  return hostPort.split(":")[0] ?? hostPort;
}

/** #387 (F18): classifies an egress hit's target as loopback-only, or leaves it UNCLASSIFIED.
 *
 *  Dogfood run 2026-07-24 flagged `curl http://127.0.0.1:5173/...` dev-server smoke checks
 *  identically to real public egress (which the same run also caught — including a spoofed-UA
 *  font download). The decision recorded in docs/security.md is TAG, never exclude: a loopback
 *  hit is still journalled with full evidence, it just carries a marker so the prominent line in
 *  a round artifact stays the public one.
 *
 *  Returns `"loopback"` only when the text contains at least one URL and EVERY one of them
 *  targets loopback; otherwise `undefined`. The input is uncontrolled free text (a shell
 *  fragment, a WebFetch url), so per this repo's doctrine on inferred text the matching is
 *  deliberately narrow and the favoured failure direction is stated: a MISSED loopback URL
 *  (schemeless `curl 127.0.0.1:5173`, an unusual literal) merely leaves a benign hit at today's
 *  full prominence — the pre-#387 status quo. The opposite error, tagging something that reaches
 *  the network as loopback, would DOWNGRADE a real egress signal, so every ambiguity resolves
 *  against the tag: a mixed snippet, an unparseable authority, and text with no URL at all are
 *  all unclassified. */
export function classifyEgressTarget(text: string): "loopback" | undefined {
  const hosts = [...text.matchAll(URL_IN_TEXT)].map((m) => authorityHost(m[1] ?? ""));
  return hosts.length > 0 && hosts.every((h) => LOOPBACK_HOST.test(h)) ? "loopback" : undefined;
}

/** #304 / #410 / #534: scans `tool_use` blocks from stream-json and returns deduplicated egress
 *  hits — the ONE scanner for all three egress-shaped signal families this codebase has (#410's
 *  decision record: "the audit reuses the existing scanner... no second scanner is introduced"):
 *
 *  - **Bash** (#304, worker legs): only the executable position is considered (after leading
 *    assignments plus ordinary `env`/`sudo` prefixes) against the CALLER-SUPPLIED
 *    `suspectCommands` list; suspect names appearing in arguments are intentionally ignored.
 *  - **WebFetch/WebSearch** (#410): UNCONDITIONALLY a hit — every call is journalled, not just
 *    a configured subset, because these two tool names ARE the entire ENGINE-GRANTED
 *    peripheral-egress channel (unlike Bash, where most executables are legitimate worker
 *    activity and only a configured suspect list is worth flagging). `executable` carries the
 *    literal tool name; `snippet` is `WebFetch`'s `url` or `WebSearch`'s `query`, truncated the
 *    same way a Bash snippet is. (Capability DR #616 adds a second, INHERITED egress channel —
 *    ambient `mcp__*` tools — covered by its own family below; these two names are no longer
 *    the only sanctioned channel, just the only engine-granted one.)
 *
 *    Codex sol-high PR #417 review, P2-b (corrects an earlier, inaccurate version of this doc):
 *    this branch is **content-driven, not role-gated** — it hits on ANY `WebFetch`/`WebSearch`
 *    `tool_use` block this jsonl contains, worker leg included. A worker leg's own
 *    `WORKER_ALLOWED_TOOLS` never lists either tool, but `--allowedTools`/`--disallowedTools`
 *    is a noise-reduction PERMISSION layer, not a schema removal (this module's own header
 *    doc) — the model can still EMIT a `WebFetch`/`WebSearch` `tool_use` block, which the CLI
 *    then permission-denies at the paired `tool_result` (never scanned here). A hit therefore
 *    means "this session attempted the call," never "the call executed" — exactly the same
 *    "evidence, not a verdict" stance the Bash branch above already takes (a Bash hit doesn't
 *    prove the command ran either, e.g. under guard denial). PM ruling (#410 amendment
 *    follow-up): keep this UNCONDITIONAL for worker legs too — an attempted egress through a
 *    tool the leg was never granted is exactly what a post-hoc tripwire should surface, not
 *    suppress.
 *
 *  - **Agent/Task** (#534): the SAME unconditional stance as WebFetch/WebSearch, for the same
 *    reason and by the same PM ruling — a peripheral role session's `ROLE_DISALLOWED_TOOLS` now
 *    name-denies subagent spawn (#534), so an `Agent`/`Task` `tool_use` block appearing in ANY
 *    leg's jsonl (worker leg included — a worker leg is not denied these names, so a hit here is
 *    a legitimate spawn ATTEMPT, not an attempted circumvention. This scanner reads only the
 *    assistant `tool_use` block, never the paired `tool_result`, so — same as every other family
 *    above — a hit is never proof the spawn actually went through, only that it was requested;
 *    the tripwire still journals it, same as a Bash hit journals legitimate worker activity that
 *    happens to match the configured suspect list) is exactly the post-hoc-visible signal this
 *    scanner exists to surface. `executable`
 *    carries the literal tool name (`Agent` or `Task`); `snippet` is the spawn's `description`
 *    field when it is a NON-EMPTY string (the short, human-readable summary a live #534
 *    transcript showed the model supplies, e.g. `"Check if #485 already shipped"`), falling back
 *    to `prompt` when `description` is empty or absent — never neither, so a hit is never
 *    recorded with an empty snippet when the block carries usable text.
 *
 *  - **`mcp__*`** (#617, seam 4 of capability DR #616): the SAME unconditional stance as
 *    WebFetch/WebSearch/Agent/Task above, for a NEW reason those didn't have: DR #616's ruling has
 *    producer legs officially inherit the operator's entire host MCP surface, and the #616 live
 *    probe found that surface callable — including write/execution-class tools — with NONE of it
 *    reaching the guard hook (its PreToolUse matcher is `Bash|Write|Edit|MultiEdit|Read|Grep|Glob|
 *    NotebookRead`, no `mcp__` pattern). Under inheritance an MCP tool is an egress-capable channel
 *    exactly like WebFetch/WebSearch — this scanner is the ONE place that channel becomes visible
 *    post-hoc. Any `tool_use` block whose `name` starts with `mcp__` is a hit (`WORKER_DISALLOWED_TOOLS`'s
 *    own (b′) deny only covers a few KNOWN server names — this scan deliberately covers every
 *    `mcp__` name, including the engine's own `mcp__forge__*` evidence-channel calls: a legitimate
 *    call being ALSO visible here costs nothing, since this is a post-hoc tripwire, never a deny
 *    decision, and the scanner cannot distinguish "the engine's own sealed proxy" from "an ambient
 *    host server" by name pattern alone). `executable` carries the literal tool name
 *    (`"mcp__<server>__<tool>"`); `snippet` is the JSON-stringified `input` — no single fixed
 *    field like WebFetch's `url` exists across every possible server's arbitrary tool schema —
 *    truncated the same way every other family's snippet is, so `classifyEgressTarget` still
 *    tags a loopback-only URL embedded anywhere in that stringified input.
 *
 *  Same tolerance as the sibling parsers: malformed/partial lines and malformed blocks are
 *  skipped silently. Collection stops at the engine-owned per-leg cap, bounding both evidence and
 *  its dedup set (shared across all four signal families — Bash, WebFetch/WebSearch, Agent/Task,
 *  and `mcp__*` — one session emitting a mix of any of them is still bounded by ONE cap, not one
 *  each). This is a post-hoc tripwire, never a deny decision. */
export function scanEgressSuspects(jsonl: string, suspectCommands: readonly string[]): EgressSuspectScan {
  const suspects = new Set(suspectCommands);
  const hits: EgressSuspect[] = [];
  const seen = new Set<string>();
  // #387: `text` is the FULL observed text; the snippet cap is applied here so classification
  // always reads what the session actually asked for, never a 200-char prefix a public URL may
  // have fallen off the end of. Dedup still keys on the (capped) snippet, exactly as before.
  const addHit = (executable: string, text: string): boolean => {
    const snippet = text.slice(0, EGRESS_SNIPPET_MAX_CHARS);
    const key = `${executable}\0${snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const target = classifyEgressTarget(text);
    hits.push(target ? { executable, snippet, target } : { executable, snippet });
    return hits.length === MAX_EGRESS_SUSPECTS_PER_LEG;
  };
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;
      const input = b.input;
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      if (b.name === "Bash") {
        const command = (input as Record<string, unknown>).command;
        if (typeof command !== "string") continue;
        for (const fragment of shellFragments(command)) {
          const executable = fragmentExecutable(fragment);
          if (!executable || !suspects.has(executable)) continue;
          if (addHit(executable, fragment)) return { hits, truncated: true };
        }
      } else if (b.name === "WebFetch" || b.name === "WebSearch") {
        const detail = (input as Record<string, unknown>)[b.name === "WebFetch" ? "url" : "query"];
        if (typeof detail !== "string") continue;
        if (addHit(b.name, detail)) return { hits, truncated: true };
      } else if (b.name === "Agent" || b.name === "Task") {
        // #534: same unconditional stance as WebFetch/WebSearch above — see this function's own
        // doc. Prefer `description` (the short human-readable summary) when non-empty, else
        // fall back to `prompt`.
        const rec = input as Record<string, unknown>;
        const detail = (typeof rec.description === "string" && rec.description) || (typeof rec.prompt === "string" && rec.prompt) || null;
        if (detail === null) continue;
        if (addHit(b.name, detail)) return { hits, truncated: true };
      } else if (typeof b.name === "string" && b.name.startsWith("mcp__")) {
        // #617 (seam 4): same unconditional stance as WebFetch/WebSearch/Agent/Task above — see
        // this function's own doc. No fixed field to prefer (arbitrary per-server input shape),
        // so the whole input is the evidence.
        let detail: string;
        try {
          detail = JSON.stringify(input);
        } catch {
          continue; // unreachable in practice (input is already-parsed JSON), but never throw here
        }
        if (addHit(b.name, detail)) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}

/** #110 PR0: the READ side for a role session's structured final-message output. Extracts the
 *  `result` string from the LAST `type:"result"` line of a stream-json transcript — the same
 *  line parseCostUsd/parseModelUsage already treat as authoritative. Mirrors parseCostUsd's
 *  tolerance for the stream itself: a non-`{`-prefixed line is skipped outright, a JSON.parse
 *  failure is ignored (never thrown, mid-write tolerance), and an input with no valid result
 *  line returns "".
 *
 *  DELIBERATE divergence from parseCostUsd (Codex review round 1, P2): the last PARSEABLE
 *  result line is AUTHORITATIVE, even when its `result` field is missing/non-string — such a
 *  line RESETS the value to "" rather than letting an EARLIER line's text survive. Cost keeps
 *  the last-VALID value (a lost cost number only under-counts spend); decision text feeding a
 *  validator must never fail open by resurrecting stale text from a superseded result line.
 *  Later #110 PRs parse each role's structured decision block out of this text (per-role zod
 *  schema, sentinel-delimited raw-text bodies); this PR only adds the parse primitive — no
 *  call site uses it yet, so this change is zero behavior change. */
export function parseResultText(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; result?: unknown };
      if (obj.type === "result") text = typeof obj.result === "string" ? obj.result : "";
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return text;
}

/** #236: the session's OWN report of what it started with — parsed from stream-json's
 *  `{"type":"system","subtype":"init",...}` line (verified against Claude Code CLI 2.1.212 by
 *  running a real probe session; see roles/context-manifest.ts's module doc for how this feeds
 *  the ambient context manifest). This is the most honest source for "what a session actually
 *  saw": the tool-schema inventory (`tools`), MCP server availability (`mcp_servers`, each
 *  carrying its own connection `status` — pending/disabled/needs-auth, not just a name), the
 *  CLI's own version (`claude_code_version`), the model it actually ran under (`model` — may
 *  differ from the requested `--model` on a fallback-model switch), and the auto-memory
 *  directory it loaded from (`memory_paths.auto`). Scans for the FIRST such line only (the init
 *  event fires once, near stream start); tolerant exactly like parseCostUsd/parseModelUsage/
 *  parseResultText — never throws, a missing/malformed line or absent field resolves to
 *  null/[], never a guess. (The init event also carries the session's working directory, but
 *  callers derive that themselves from the lane/worktree name they already know, so it's not
 *  duplicated here.) */
export interface SessionInitInfo {
  model: string | null;
  cliVersion: string | null;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  memoryPathAuto: string | null;
}

export function parseSessionInit(jsonl: string): SessionInitInfo {
  const empty: SessionInitInfo = { model: null, cliVersion: null, tools: [], mcpServers: [], memoryPathAuto: null };
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "system" || obj.subtype !== "init") continue;
    const tools = Array.isArray(obj.tools) ? obj.tools.filter((x): x is string => typeof x === "string") : [];
    const mcpServersRaw = Array.isArray(obj.mcp_servers) ? obj.mcp_servers : [];
    const mcpServers = mcpServersRaw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        name: typeof s.name === "string" ? s.name : "unknown",
        status: typeof s.status === "string" ? s.status : "unknown",
      }));
    const memoryPaths = obj.memory_paths;
    const memoryPathAuto =
      memoryPaths && typeof memoryPaths === "object" && typeof (memoryPaths as Record<string, unknown>).auto === "string"
        ? ((memoryPaths as Record<string, unknown>).auto as string)
        : null;
    return {
      model: typeof obj.model === "string" ? obj.model : null,
      cliVersion: typeof obj.claude_code_version === "string" ? obj.claude_code_version : null,
      tools,
      mcpServers,
      memoryPathAuto,
    };
  }
  return empty; // no init line found — honest empty, never a thrown error
}

/** #236 (Codex F1 residual, R1): a cheap presence check for the SAME init line parseSessionInit
 *  looks for — used to POLL a still-growing jsonl file (peripheral.ts's context-manifest
 *  capture) without paying the full parse-and-build cost on every poll tick. The init line is
 *  the CLI's own signal that it finished loading its context (CLAUDE.md layers, MCP servers,
 *  tool schema) and is about to hand control to the model — i.e. exactly the "what the session
 *  saw" moment, and (as a side effect) proof the worktree provisioning this same startup did is
 *  complete. Same tolerance as every other parser here: a partial/garbage line is skipped, never
 *  thrown. */
export function hasSessionInitLine(jsonl: string): boolean {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; subtype?: string };
      if (obj.type === "system" && obj.subtype === "init") return true;
    } catch {}
  }
  return false;
}

/** Bounded poll of `jsonlPath` for the session's own init line — the synchronization primitive
 *  #236's pre-spawn manifest capture uses (originally peripheral.ts-only; #617 moves it here,
 *  exported, so WorkerSupervisor's own manifest wiring for worker/producer legs reuses the SAME
 *  poll rather than a parallel implementation, and peripheral.ts imports it from here like every
 *  other worker.ts-owned session-stream primitive it already depends on). Resolves `true` the
 *  instant the line is observed, or `false` once `timeoutMs` elapses without it ever appearing (a
 *  hung/crashed-before-init session) — never throws, never waits longer than the bound. Reads the
 *  file fresh on every poll tick (the same tolerant, still-growing-file reader every other jsonl
 *  consumer in this codebase uses); a file that doesn't exist yet reads as `""`, not an error. */
export async function waitForInitLine(jsonlPath: string, timeoutMs: number, pollMs: number): Promise<boolean> {
  // #403 (F25) per-site decision: DELIBERATE wall-clock read, kept. This is elapsed-time
  // arithmetic over a REAL polling loop against a REAL file a REAL subprocess is writing —
  // measuring how long that has actually taken is the whole job, and a seeded clock would either
  // never expire or expire instantly. Nothing here is asserted against a seeded date; the only
  // caller-visible output is a boolean whose timeout bound tests set explicitly.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let content = "";
    try {
      content = readFileSync(jsonlPath, "utf8");
    } catch {
      /* not created / not flushed yet — keep polling */
    }
    if (hasSessionInitLine(content)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

/** Per-model token usage from the last stream-json result line (#47). Mirrors parseCostUsd's
 *  tolerance exactly: a missing result line, a malformed `usage`/`modelUsage`, or a garbage
 *  line never throws — it just yields zeros. Cost accounting (parseCostUsd) must keep working
 *  on ANY CLI version regardless of what this function finds.
 *
 *  Prefers the newer CLI's per-model `modelUsage` map. When that's absent, falls back to
 *  attributing the flat top-level `usage` block to the session's reported model id
 *  (`model` or `modelName` on the result object) — or "unknown" if neither is present. */
export function parseModelUsage(jsonl: string): ModelUsageEntry[] {
  let usage: ModelUsageEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === "result") usage = extractModelUsage(obj);
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return usage;
}

function extractModelUsage(obj: Record<string, unknown>): ModelUsageEntry[] {
  const modelUsage = obj.modelUsage;
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    const entries = Object.entries(modelUsage as Record<string, unknown>)
      .filter(([model]) => typeof model === "string" && model.length > 0)
      .map(([model, u]) => ({ model, ...toCategorized(u) }));
    if (entries.length > 0) return entries;
  }
  // Fallback: no (usable) modelUsage map — attribute the flat top-level usage to the
  // session's main model id, or "unknown" if the result line carries no model identifier.
  const model = (typeof obj.model === "string" && obj.model) || (typeof obj.modelName === "string" && obj.modelName) || "unknown";
  return [{ model, ...toCategorized(obj.usage) }];
}

/** Normalizes a stream-json usage block (either snake_case, e.g. top-level `usage`, or
 *  camelCase, e.g. a `modelUsage` entry) into token counts. Missing/non-numeric/negative
 *  fields become 0 — never a parse failure. */
function toCategorized(u: unknown): CategorizedTokenUsageRaw {
  const r = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    inputTokens: num(r.input_tokens ?? r.inputTokens),
    outputTokens: num(r.output_tokens ?? r.outputTokens),
    cacheCreationTokens: num(r.cache_creation_input_tokens ?? r.cacheCreationInputTokens),
    cacheReadTokens: num(r.cache_read_input_tokens ?? r.cacheReadInputTokens),
  };
}

type CategorizedTokenUsageRaw = Omit<ModelUsageEntry, "model">;

/** #33: the LIVE in-flight cost-estimation signal — distinct from parseModelUsage/parseCostUsd,
 *  which only ever read the terminal `result` line (absent until the whole run finishes).
 *  Claude Code's stream-json carries a `message.usage` block on every streamed `assistant`
 *  event, and that block is PER-MESSAGE (not cumulative) — so summing every assistant line's
 *  usage across the jsonl-so-far gives the running total spent up to that point. Same tolerance
 *  guarantee as parseModelUsage: a malformed/partial line (the stream may be mid-write, or the
 *  worker's Bash tool literally echoed the string "assistant" as text) is skipped, never thrown,
 *  and a line missing/misshaping `message`/`usage` yields zeros rather than aborting the scan. */
export function parseAssistantUsageDeltas(jsonl: string): ModelUsageEntry[] {
  const out: ModelUsageEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const m = message as Record<string, unknown>;
    const model = typeof m.model === "string" && m.model.length > 0 ? m.model : "unknown";
    out.push({ model, ...toCategorized(m.usage) });
  }
  return out;
}

/** #235 PR-B: one tool name and how many times the session's stream invoked it — counts EVERY
 *  `tool_use` block the session emitted, whether Claude Code actually allowed the call or the
 *  guard hook/CLI denied it (a denied attempt is still evidence worth recording: "this session
 *  tried to Bash" is itself a diagnosable fact, not something to silently drop because it never
 *  executed). */
export interface ToolUsageEntry {
  tool: string;
  count: number;
}

/** #235 PR-B: which repository paths a session's Read/Grep/Glob/NotebookRead tool calls actually
 *  named — the manifest's "what did this session actually look at" half, alongside
 *  toolInventoryHash's "what COULD it have used". Mirrors guard.ts's own checkReadContainment
 *  path resolution exactly (Read/NotebookRead: a required single-file path; Grep/Glob: an
 *  OPTIONAL search-root path — when explicitly supplied, recorded EXACTLY as the session
 *  supplied it, absolute-or-relative, never re-resolved). A Grep/Glob call with NO `path`
 *  doesn't skip the repository — it searches the session's own cwd (the worktree root), and
 *  Claude Code's own containment resolves it there too (`guard.ts`'s `checkReadContainment`
 *  falls back to `cwd` for exactly this case) — so `parseToolUsage`'s caller-supplied
 *  `defaultSearchPath` (the session's worktree root) is recorded for that case instead of
 *  silently dropping it (Codex review, PR #257 F2: a pathless Grep/Glob still reads and returns
 *  file contents; omitting it from `readPaths` understated what the session actually used). This
 *  is a RECORD of what was asked for / where it searched, not a re-check of where it landed —
 *  #235 PR-A's guard hook is the actual containment enforcement. */
export interface ToolUsageResult {
  toolUsage: ToolUsageEntry[];
  readPaths: string[];
}

const READ_PATH_FIELD: Record<string, string> = {
  Read: "file_path",
  NotebookRead: "notebook_path",
  Grep: "path",
  Glob: "path",
};

/** Grep/Glob search the session's cwd when called with no `path` — Read/NotebookRead have no
 *  such fallback (a missing `file_path`/`notebook_path` is simply a malformed call, the same
 *  fail-closed shape `guard.ts`'s own containment check treats it as), so only these two tools
 *  get `defaultSearchPath` substituted in `parseToolUsage` below. */
const PATHLESS_SEARCHES_CWD = new Set(["Grep", "Glob"]);

/** #235 PR-B: parse every `tool_use` block from a session's stream-json transcript — the SAME
 *  jsonl every other parser in this module scans (peripheral.ts's context-manifest assembly
 *  passes the identical string already read for parseCostUsd/parseModelUsage/parseResultText).
 *  Same tolerance guarantee as every sibling parser here: a partial/garbage line is skipped,
 *  never thrown; a malformed/missing `message.content` array yields nothing for that line rather
 *  than aborting the whole scan. Tool names are counted in FIRST-SEEN order for readability;
 *  `readPaths` is sorted + deduplicated (see ToolUsageResult's doc for exactly which field each
 *  read-shaped tool contributes).
 *
 *  `defaultSearchPath` (optional, typically the session's resolved worktree root — peripheral.ts
 *  passes it) is the path recorded for a Grep/Glob call with no explicit `path` field (see
 *  PATHLESS_SEARCHES_CWD's doc and ToolUsageResult's doc for why this isn't just dropped).
 *  Omitted -> a pathless Grep/Glob call is still counted in `toolUsage` but contributes no entry
 *  to `readPaths` (the pre-fix behavior, kept as the default so a caller that doesn't know its
 *  session's worktree root yet degrades honestly rather than fabricating one). */
export function parseToolUsage(jsonl: string, defaultSearchPath?: string): ToolUsageResult {
  const counts = new Map<string, number>();
  const pathSet = new Set<string>();
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || typeof b.name !== "string" || b.name.length === 0) continue;
      const name = b.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const pathField = READ_PATH_FIELD[name];
      if (!pathField) continue;
      const input = b.input;
      const rawPath =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[pathField] : undefined;
      if (typeof rawPath === "string" && rawPath.length > 0) {
        pathSet.add(rawPath);
      } else if (PATHLESS_SEARCHES_CWD.has(name) && defaultSearchPath) {
        pathSet.add(defaultSearchPath);
      }
    }
  }
  const toolUsage: ToolUsageEntry[] = [...counts.entries()].map(([tool, count]) => ({ tool, count }));
  return { toolUsage, readPaths: [...pathSet].sort() };
}

/** CLAUDE_BIN env override, else `claude` on PATH. */
export function discoverClaudeBin(env: Record<string, string | undefined>): string {
  const b = env.CLAUDE_BIN?.trim();
  return b ? b : "claude";
}

/** #168: the ping probe's outcome. `detail` is set on FAILURE only — the first stderr (or
 *  stdout) error line, a timeout note, or a spawn error — so the recorded probe event lets an
 *  operator distinguish "provider still down" (a 429/overloaded error) from a local
 *  misconfiguration ("Error: Exceeded USD budget (0.01)" = envFailure.probeMaxBudgetUsd set
 *  too low; see docs/configuration.md). */
export interface LlmPingResult {
  ok: boolean;
  detail?: string;
}

/** The ping's fixed prompt pair — deliberately strict so the response is a single word
 *  (minimum output tokens) and deliberately engine-internal, not config. The custom
 *  --system-prompt REPLACES the CLI's default (much larger) system prompt. */
const LLM_PING_SYSTEM_PROMPT = "You are a heartbeat responder. Only output the requested word.";
const LLM_PING_PROMPT = "Respond with the single word 'pong' and nothing else.";

/** #168 (PR #180 review, P1-1 amendment — final form): the LLM-source probe for conductor.ts's
 *  park machinery (TickDeps.probeLlmReachable) — a REAL minimal inference ping, verified
 *  working against claude CLI 2.1.209 in exactly this form (returns "pong", exit 0):
 *
 *      claude -p --model <probeModel> --no-session-persistence \
 *        --system-prompt "<LLM_PING_SYSTEM_PROMPT>" --strict-mcp-config --tools "" \
 *        --max-budget-usd <probeMaxBudgetUsd> --output-format text "<LLM_PING_PROMPT>"
 *
 *  Flag rationale: --no-session-persistence keeps probe runs off the disk (no session files);
 *  --system-prompt REPLACES the CLI's default full system prompt; --strict-mcp-config +
 *  --tools "" strip MCP servers and tool schemas from the request — the smallest prompt
 *  surface and the fewest failure modes the CLI supports. (--max-tokens does NOT exist in the
 *  CLI — verified unknown-option error — and must not be added.)
 *
 *  Success = exit code 0 AND the trimmed, lowercased stdout being EXACTLY "pong" (PR #180
 *  round-3 P3: a contains-check passed refusals like "I cannot return only pong"; normalized
 *  equality cannot). This replaced
 *  the original `claude --version` check, which proves nothing about the PROVIDER — the CLI
 *  stays installed and executable throughout a rate-limit/credit outage. The ping proves
 *  network + auth + some account capacity on the cheapest model (cfg.envFailure.probeModel,
 *  default "haiku"). It deliberately does NOT prove the WORKER's model/tier has quota
 *  (model-specific caps, primary-model-only overload) — exactly why the canary +
 *  episode-continuity layers above it remain: ping (cheap filter, paced by backoff) ->
 *  success unlocks ONE canary lane -> only the canary reaching a non-env terminal clears the
 *  llm episode. A false-positive ping costs one bounded canary spawn and never resets the
 *  episode clock. The ping subsumes CLI-breakage detection too (broken CLI = ping fails).
 *
 *  COST (empirical, honest number): ~$0.016 measured per probe even fully stripped — the CLI
 *  still sends ~7.4k scaffolding tokens as cache-creation plus ~240 output tokens, so the
 *  floor is >$0.01, never "a few tokens". `--max-budget-usd` bounds it
 *  (cfg.envFailure.probeMaxBudgetUsd, default 0.05): a cap at or below the floor (e.g. 0.01)
 *  empirically FAILS every probe with "Error: Exceeded USD budget (0.01)" exit 1 — which is
 *  why the failure detail is surfaced: a too-low cap keeps the engine parked, a fail-safe but
 *  confusing state without the stderr line in the event. An OLDER CLI lacking these flags
 *  fails every probe with "error: unknown option ..." — same surfacing, remedy is a CLI
 *  upgrade (see docs/configuration.md).
 *
 *  Never throws — any spawn error, non-zero exit, non-"pong" output, or a hang past
 *  `timeoutSec` (hard kill) resolves `{ ok: false, detail }`. */
export function probeLlmPing(claudeBin: string, probeModel: string, probeMaxBudgetUsd: number, timeoutSec: number): Promise<LlmPingResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: LlmPingResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() ?? "";
    let child: ChildProcess;
    try {
      child = spawn(
        claudeBin,
        [
          "-p",
          "--model",
          probeModel,
          "--no-session-persistence",
          "--system-prompt",
          LLM_PING_SYSTEM_PROMPT,
          "--strict-mcp-config",
          "--tools",
          "",
          "--max-budget-usd",
          String(probeMaxBudgetUsd),
          "--output-format",
          "text",
          LLM_PING_PROMPT,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      finish({ ok: false, detail: `ping spawn failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, detail: `ping timed out after ${timeoutSec}s (hard-killed)` });
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, detail: `ping spawn error: ${e.message}` });
    });
    // #578: 'close', NOT 'exit'. 'exit' fires the moment the child terminates, while its stdio
    // pipes may still hold bytes this process has not read — reading `stdout` there made a
    // healthy "pong" ping resolve `{ ok: false, detail: 'ping exited 0 with no output' }` under
    // load (2026-08-03, reddened main). 'close' fires only after every stdio stream is closed,
    // so the buffers below are complete by construction rather than by luck. The hang cost is
    // already bounded: a child whose pipe is held open by a surviving grandchild never emits
    // 'close', and `timer` above hard-kills and resolves that case exactly as before.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim().toLowerCase() === "pong") {
        finish({ ok: true });
        return;
      }
      // Failure detail: prefer the first stderr error line (where "Exceeded USD budget" and
      // API errors land), else the first stdout line, else the bare exit code.
      const detail = firstLine(stderr) || firstLine(stdout) || `ping exited ${code} with no output`;
      finish({ ok: false, detail });
    });
  });
}

export interface ClaudeArgsOpts {
  prompt: string;
  model: string;
  effort: string;
  fallbackModel: string;
  /** `--worktree <name>` — tells the CLI to create/use a git worktree of ITS OWN inherited cwd
   *  (the engine's repo). Omitted -> no `--worktree` flag at all: #285's review session mode
   *  spawns against an already-materialized plain source tree (review/materializer.ts's
   *  checkout output, no `.git` at all — D1) via an explicit `cwd` on the spawned process
   *  instead (see spawnClaudeSession's `cwd` opt) — asking the CLI to ALSO create a worktree
   *  there would be nonsensical (there is no repo to create one from) and wrong (it would land
   *  under the engine's OWN worktreeRoot, not the materialized tree). Every caller except
   *  peripheral.ts's review-session path supplies this, unchanged. */
  worktree?: string;
  name: string;
  sessionId: string;
  addDir?: string;
  settings?: string; // --settings value: inline JSON string (or path); omitted -> no --settings (#26)
  /** #46: resume a prior session (`--resume <id>`) instead of starting a fresh one
   *  (`--session-id <id>`) — the handoff-resume path. Omitted -> the normal fresh-dispatch
   *  `--session-id` flag, unchanged. `--resume` reuses the SAME session (no --fork-session),
   *  so `sessionId` above should equal this value when both are set. */
  resumeSessionId?: string;
  /** #87: override the coarse `--allowedTools`/`--disallowedTools` noise-reduction pair below —
   *  peripheral.ts's role sessions need a narrower (issues-only) scope than a code-producing
   *  worker's. Omitted -> today's worker defaults, unchanged. Same caveat as the worker
   *  defaults: this is noise reduction only, never the real security boundary (the guard hook
   *  is — see guardSettings). */
  allowedTools?: string;
  disallowedTools?: string;
  /** #234: inline `--mcp-config` JSON for the engine-hosted read-only forge MCP proxy — same
   *  inline-never-a-file stance as `settings` above (a file under stateDir would be a
   *  worker/session-writable on-disk target). Omitted -> no `--mcp-config` flag, unchanged
   *  behavior for every caller that doesn't attach a proxy: peripheral.ts's RoleRunner supplies
   *  it when its own `proxy` opt is present, and so do this module's own `dispatch()`/`resume()`
   *  (WorkerSupervisor) when a `proxyHandle` was minted — RoleRunner is not the only caller.
   *  #285: review sessions also set this, to `EMPTY_MCP_CONFIG_JSON` — see `strictMcpConfig`'s
   *  doc. */
  mcpConfig?: string;
  /** #285 (review session mode, D1 static-only, Codex sol-high P1): `--strict-mcp-config` —
   *  verified real against a live `claude` CLI (worker.ts's own `probeLlmPing` already uses it,
   *  and it's independently confirmed in `claude --help`: "Only use MCP servers from
   *  --mcp-config, ignoring all other MCP configurations"). Paired with `mcpConfig:
   *  EMPTY_MCP_CONFIG_JSON` (below) this closes an execution surface `--disallowedTools Bash`
   *  and the PreToolUse guard hook do NOT mediate at all: the CLI starts MCP server PROCESSES at
   *  session init, before any tool call the guard could ever intercept — a materialized review
   *  tree can carry a producer-authored `.mcp.json` (or a project `.claude/settings.json`
   *  declaring `enabledMcpjsonServers`) that would otherwise be picked up and LAUNCHED. Omitted
   *  -> no `--strict-mcp-config` flag, unchanged behavior for every non-review caller (today:
   *  none besides `probeLlmPing`, which sets its own argv directly, not through this field). */
  strictMcpConfig?: boolean;
  /** #285 (review session mode): `--setting-sources <sources>` — restricts WHICH settings
   *  layers Claude Code loads (verified against `claude --help`: "Comma-separated list of
   *  setting sources to load (user, project, local)"). The "project"/"local" sources resolve
   *  against the spawned process's OWN cwd — for a review session that cwd IS the materialized
   *  (producer-controlled) tree, so an unrestricted default would load a producer-authored
   *  `.claude/settings.json`/`.claude/settings.local.json` verbatim, HOOKS included (a much
   *  bigger execution surface than MCP: settings-declared hooks run arbitrary shell commands
   *  directly, and Claude Code's own hooks/PreToolUse arrays are known to CONCATENATE across
   *  settings layers rather than being replaced by this module's own inline `--settings` JSON —
   *  omitted keys/arrays there keep the file's values, see `guardSettings`'s own doc).
   *
   *  Review sessions pass `""` (Codex sol-high PR #300 review, SECOND round, P1: an earlier
   *  version of this fix passed `"user"`, keeping the operator's own `~/.claude/settings.json`
   *  in scope — but this repo's OWN security.md documents that a worker leg's `Bash(node
   *  *)`/`Bash(npm *)` grant runs with the operator's REAL, unconfined `$HOME` (the
   *  `workerCredentialFreeEnv` "HONEST SCOPE" note's own `steal.mjs` proof-of-concept), so a
   *  producer could in principle have influenced that real `~/.claude/settings.json` in an
   *  EARLIER round — loading it here would reopen exactly the static-only (D1) surface this
   *  whole field exists to close). `""` loads ZERO file-based settings sources at all —
   *  VERIFIED against a live `claude` CLI, not assumed from `--help` text: a debug-log run with
   *  the default (unrestricted) sources showed the CLI applying the operator's real
   *  `~/.claude/settings.json` permission entries at session init (`"Applying permission
   *  update ... destination 'userSettings'"`); the SAME run with `--setting-sources ""` never
   *  emitted that line, while the CLI still completed a full turn cleanly (exit 0, empty
   *  stderr) — proving both that the flag is accepted with an empty value AND that it actually
   *  suppresses file-based loading, not just user-facing sources. The guard hook itself is
   *  UNAFFECTED — it rides in on `--settings` (inline JSON, a wholly separate flag from
   *  `--setting-sources`; see `docs/security.md`'s "Benchmark isolation recipe" section, which
   *  already documents `--settings` as additive to whatever settings SOURCES load, never a
   *  replacement for them). Omitted -> no `--setting-sources` flag, unchanged behavior (today's
   *  default: user+project+local, correct for every OTHER role/worker session, whose cwd is the
   *  ENGINE's own trusted worktree, never a reviewed PR's tree). NOTE: an empty string is a
   *  MEANINGFUL value here, not "unset" — see `claudeArgs`' own `!== undefined` check below. */
  settingSources?: string;
  /** #286 (E4a, design #279 §6): `--max-budget-usd <value>` — a HARD per-session cost ceiling,
   *  verified real against a live `claude` CLI (worker.ts's own `probeLlmPing` already uses it;
   *  see that function's doc for the exact "Error: Exceeded USD budget (...)" failure shape).
   *  Deliberately DISTINCT from the module-level "no --max-budget-usd" note on `claudeArgs`
   *  itself, just below: that note is about the code-PRODUCING worker leg, whose budget is soft
   *  (monitored + graceful handoff, PLAN.md) — a review session has no in-progress work to hand
   *  off gracefully (D1: static-only, no code execution, bounded single-turn judgment), so a HARD
   *  cap is the right shape there, not a contradiction of the worker's own soft-budget policy.
   *  engine-agent.ts sets this to the REMAINING logical-review budget (reviewer.agent.costCapUsd
   *  on attempt 1; the cap minus attempt 1's own recorded cost on a retry). Omitted -> no
   *  `--max-budget-usd` flag at all, unchanged behavior for every other caller (worker/role
   *  sessions never set this). */
  maxBudgetUsd?: number;
}

/** #285: the `--mcp-config` value review sessions pass alongside `--strict-mcp-config` — an
 *  explicit, EMPTY server map. Belt-and-suspenders with `--strict-mcp-config` (which alone,
 *  given no `--mcp-config` at all, likely already yields zero servers per its own documented
 *  semantics) — passing this explicitly removes any ambiguity about what "no --mcp-config at
 *  all" resolves to, and gives spawn-args tests a concrete, asserted value to pin. */
export const EMPTY_MCP_CONFIG_JSON = JSON.stringify({ mcpServers: {} });

/** The code-producing worker's own default `--allowedTools`/`--disallowedTools` pair — extracted
 *  as named exports (#244) so a caller that widens them (e.g. WorkerSupervisor.dispatch's own
 *  proxy-tool widening, mirroring peripheral.ts's ROLE_ALLOWED_TOOLS pattern) has the base
 *  string to compose with, rather than re-typing it. Byte-identical to claudeArgs' own prior
 *  inline defaults — zero behavior change for every caller that doesn't reference these. */
export const WORKER_ALLOWED_TOOLS = "Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),Bash(node *),Bash(npx *)";
/** #350: defense-in-depth on top of the guard's argv-layer block (guard.ts) — neither `gh pr
 *  review` nor `gh release` is needed by any stock worker workflow, so denying them here too
 *  costs nothing while narrowing the CLI-permission surface. The guard stays the primary,
 *  wrapper-bypass-resistant boundary; this is the permission layer, out of scope for guard.ts.
 *
 *  #488 (design #279 §5a's deferred hardening) adds the GOVERNANCE-SIGNAL verbs: issue labels
 *  and the board `Status` field are what every dispatch/merge gate in this engine treats as an
 *  engine-or-human-only signal (`plan:approved`, `labels.roundPool`, `escalation.humanLabels`,
 *  the `Ready` lane). A producer able to set them forges exactly the signals those gates were
 *  built to trust, so the permission layer denies them alongside the guard, which has blocked
 *  the same commands at the argv layer since #305/#352/#353 (`gh label`, `gh project`, and
 *  governance-flagged `gh issue edit` — see guard.ts's checkCategoryC). Same intentional
 *  coarseness as the `gh pr review*` entry above: `Bash(gh issue edit*)` denies the whole verb,
 *  including the plain `--body` edit the guard's argv check still permits. `gh api` is
 *  deliberately absent — read-only `gh api` is ordinary worker usage and a prefix rule can't
 *  separate it from a mutation, which is precisely the argv-shape judgement checkGhApi makes.
 *  Comment channels (`gh pr comment`, `gh issue comment`) stay open in both layers.
 *
 *  #617 ((b′), capability DR #616): the `mcp__` entries below are a SEPARATE addition, appended
 *  to the same string rather than a new constant, so every existing caller (claudeArgs' own
 *  `?? WORKER_DISALLOWED_TOOLS` default) gets the widened deny automatically. DR #616's ruling
 *  has producer legs officially inherit the operator's ENTIRE host MCP surface (settings sources,
 *  servers, skills) — the live probe backing that DR found the inherited surface callable and
 *  including write/execution-class tools (`server-filesystem__write_file`/`edit_file`/`move_file`,
 *  `Google_Drive__create_file`), none of which reach the guard hook (its PreToolUse matcher is
 *  `Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead` — see guardSettings below — carrying no
 *  `mcp__` pattern at all). This is a COARSE, WHOLESALE, name-based accident fence, not a
 *  hostile-jail (M12 positioning) — it denies by known/common SERVER NAME (`mcp__<server>__*`,
 *  the CLI's own documented whole-server wildcard rule shape) for the two categories #616 scoped:
 *  forge-authority ("github-class" — a server that could exercise GitHub write authority the
 *  guard/permission layer otherwise reserves for `gh`) and write/execution-class ("filesystem-class" —
 *  a server that can write to disk or a cloud drive on the operator's behalf). Residual UNKNOWN
 *  servers — any name an operator's own MCP config doesn't match — are an ACCEPTED BLIND SPOT
 *  (docs/security.md's blind-spot section), not a gap this list claims to close; branch
 *  protection is the documented, mandatory backstop regardless of what this list denies.
 *
 *  #554 interaction (MUST read before relying on this list): `allowManagedPermissionRulesOnly`
 *  discards `--disallowedTools` WHOLESALE — a host with that setting on drops this deny (and
 *  every other entry in this constant) entirely, silently. This list is defense-in-depth on top
 *  of branch protection, never a substitute for it. */
export const WORKER_DISALLOWED_TOOLS =
  "Bash(gh pr merge*),Bash(gh pr ready*),Bash(gh pr review*),Bash(gh release*),Bash(gh issue edit*),Bash(gh label*),Bash(gh project*)," +
  "mcp__github__*,mcp__server-filesystem__*,mcp__filesystem__*,mcp__Google_Drive__*";
/** #244 (Codex sol-high PR #260 review, P1): the credential-free worker leg's own `--allowedTools`
 *  base — WORKER_ALLOWED_TOOLS with `Bash(gh *)` dropped. Once `workerCredentialFreeEnv` severs
 *  `gh`'s on-disk/env credential reach, the grant itself should stop offering `gh` at all — a
 *  session with a `gh` grant it can never authenticate through would just fail loudly instead of
 *  never trying, and (worse) `gh`'s failure mode on SOME subcommands degrades to anonymous/
 *  public-only reads rather than a clean error. `Bash(git *)` stays: git's credential path is
 *  what workerCredentialFreeEnv actually severs (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null,
 *  GIT_TERMINAL_PROMPT=0, no SSH_AUTH_SOCK), so worktree-local git operations (diff, log, add,
 *  commit) remain legitimately useful and safe. */
export const WORKER_ALLOWED_TOOLS_NO_GH = WORKER_ALLOWED_TOOLS.split(",")
  .filter((t) => t !== "Bash(gh *)")
  .join(",");

/** The full `claude -p` argv. Pure, so every flag is testable without spawning. NOTE: no
 *  --max-budget-usd — the per-worker budget is SOFT (monitored + graceful handoff), never a
 *  hard mid-step kill (PLAN.md). The hard ceiling is the conductor's, not the CLI's. */
export function claudeArgs(o: ClaudeArgsOpts): string[] {
  return [
    "-p",
    o.prompt,
    "--model",
    o.model,
    "--effort",
    o.effort,
    ...(o.fallbackModel === "none" ? [] : ["--fallback-model", o.fallbackModel]),
    ...(o.worktree ? ["--worktree", o.worktree] : []),
    "--name",
    o.name,
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : ["--session-id", o.sessionId]),
    "--permission-mode",
    "auto",
    // Coarse noise-reduction only — the real boundary is the guard hook (#26).
    "--allowedTools",
    o.allowedTools ?? WORKER_ALLOWED_TOOLS,
    "--disallowedTools",
    o.disallowedTools ?? WORKER_DISALLOWED_TOOLS,
    ...(o.addDir ? ["--add-dir", o.addDir] : []),
    ...(o.settings ? ["--settings", o.settings] : []),
    ...(o.mcpConfig ? ["--mcp-config", o.mcpConfig] : []),
    ...(o.strictMcpConfig ? ["--strict-mcp-config"] : []),
    // #285 (Codex sol-high PR #300 review, second round, P1): `!== undefined`, NOT bare
    // truthiness — review sessions pass settingSources: "" (verified against a live claude CLI:
    // an empty value loads ZERO file-based settings sources, see settingSources' own doc). A
    // truthy check would silently DROP the flag for an empty string, falling back to the CLI's
    // default (load everything) and defeating the entire closure this field exists for.
    ...(o.settingSources !== undefined ? ["--setting-sources", o.settingSources] : []),
    // #286 (E4a): see ClaudeArgsOpts.maxBudgetUsd's own doc — a review session's HARD per-session
    // cost ceiling, distinct from the worker's own soft budget policy this module's header note
    // (above claudeArgs) documents.
    ...(o.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(o.maxBudgetUsd)] : []),
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--verbose",
  ];
}

const SENTINEL_EXTS = ["running.json", "done.json", "failed.json", "handoff.json", "heartbeat", "jsonl"];

/** #168: tail cap for terminalFailureText's extracted text — see extractFailureText's doc. */
const FAILURE_TEXT_TAIL_CHARS = 4000;

/** #168 (PR #180 review P1-3): build the env-failure classification input from STRUCTURED
 *  error records only — NEVER from assistant message content. The naive version (a raw tail of
 *  the whole jsonl) let a worker legitimately WORKING ON rate-limit handling — whose assistant
 *  messages print the exact signature strings (`rate_limit_error`, `429 Too Many Requests`) as
 *  part of doing its job — park the entire engine on an ordinary task failure. Included, line
 *  by line:
 *   - NON-JSON lines: the process's own stderr (spawn merges stdout+stderr onto one fd; stdout
 *     is exclusively JSON stream lines, so a bare-text line can only be stderr/CLI output —
 *     where real 429/network/auth errors actually land). A `{`-prefixed line that fails to
 *     parse is SKIPPED, not included: it is far more likely a mid-write/truncated stream
 *     fragment (possibly of an assistant message — content leak risk) than stderr that happens
 *     to start with `{`.
 *   - `type:"result"` records ONLY when errored (`is_error` true, or a non-"success" subtype):
 *     their subtype + `result` text is the CLI's own terminal error report.
 *   - `type:"error"` records: the API's structured error line (e.g.
 *     `{"type":"error","error":{"type":"rate_limit_error",...}}`).
 *   - Everything else — `assistant`/`user`/`system`/successful `result` — is NEVER included. */
export function extractFailureText(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("{")) {
      out.push(t); // raw stderr / CLI error output
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // mid-write/truncated stream fragment — never classify on possibly-content bytes
    }
    if (obj.type === "result") {
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      const errored = obj.is_error === true || (subtype !== "" && subtype !== "success");
      if (errored) {
        const text = typeof obj.result === "string" ? obj.result : "";
        out.push(`[${subtype || "error"}] ${text}`.trim());
      }
      continue;
    }
    if (obj.type === "error") {
      out.push(t); // structured API error record — exactly what the signature sets describe
    }
    // assistant / user / system / anything else: excluded by design (see doc comment).
  }
  return out.join("\n");
}

/** #374 review (PM P2): a sanity horizon on the reset-time hint — see extractRateLimitResetAt's
 *  own doc for why this exists. `resetsAt` is UNTRUSTED third-party input feeding a scheduling
 *  decision (env-failure.ts's probeDueWithHint) that can otherwise wait forever: if the CLI ever
 *  emitted milliseconds instead of seconds (a units mismatch lands ~1000x too far out — e.g.
 *  epoch ms 1784885400000 treated as seconds and re-multiplied by 1000 lands in the year 58652),
 *  or the value were simply corrupted, or local clock skew were severe, the naive hint could sit
 *  centuries in the future — and probeDueWithHint would then withhold EVERY future probe
 *  permanently (escalatePark still fires once at the duration threshold, but nothing ever probes
 *  again afterward: the engine sits parked forever with no path back except a human clearing it
 *  by hand). The real quota tiers observed are 5-hour and weekly; 48h comfortably covers both
 *  with margin. A candidate hint further than this from `nowMs` is rejected here, at the single
 *  extraction site every downstream consumer (conductor.ts's worker-leg park entry, peripheral.ts's
 *  role-session park entry, round.ts's round-opening gate) reads from — so the fallback ("treat
 *  as absent, use ordinary bounded-exponential backoff instead") is uniform and automatic, with
 *  no per-consumer clamping needed. */
export const MAX_RATE_LIMIT_RESET_HORIZON_MS = 48 * 60 * 60 * 1000;

/** #374 review (Codex sol-high finding 8): the ECMAScript spec's OWN hard limit on valid `Date`
 *  values — exactly ±100,000,000 days (≈273,790 years) from the epoch (MDN's documented bound,
 *  never a tunable). `new Date(ms)` for any `ms` outside this range silently constructs an
 *  Invalid Date, and calling `.toISOString()` on one THROWS a RangeError — a corrupted or
 *  adversarial `resetsAt` (e.g. `-1e20`) survives the future-horizon check above (it can sit
 *  arbitrarily far in the PAST, which that check never bounds) and would otherwise reach exactly
 *  that call in conductor.ts's/peripheral.ts's `new Date(rateLimitResetAtMs).toISOString()` —
 *  crashing the reclaim/park path itself. Bounding by this constant closes that crash
 *  unconditionally, in both directions, at the single extraction site. */
const JS_DATE_VALID_RANGE_MS = 8_640_000_000_000_000;

/** #374 (dogfood F16/F17): the Claude CLI's own structured rate-limit telemetry line —
 *  `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<epoch
 *  seconds>,"rateLimitType":"five_hour",...}}` — captured verbatim in a real session transcript
 *  alongside (not instead of) the human-readable "You've hit your session limit · resets
 *  6:30pm (Asia/Tokyo)" text extractFailureText already surfaces for classification. This is a
 *  SEPARATE, purely structural extraction: a SCHEDULING input (the exact reset instant, as a
 *  machine timestamp) for env-failure.ts's probeDueWithHint, never a classification input —
 *  extractFailureText deliberately does NOT include `rate_limit_event` lines (they are neither
 *  a `result` nor an `error` record), so this reads the SAME jsonl independently rather than
 *  widening that function's classification surface.
 *
 *  Returns the LAST "rejected" record's `resetsAt` converted to epoch MILLISECONDS, or `null`
 *  when no such record is present, every record found has a non-"rejected" status, a line fails
 *  to parse, the resulting value falls outside JS_DATE_VALID_RANGE_MS in EITHER direction (finding
 *  8 — never lets a corrupted/adversarial value reach a downstream `.toISOString()` and throw),
 *  OR the value is further than MAX_RATE_LIMIT_RESET_HORIZON_MS in the FUTURE beyond `nowMs` (see
 *  that constant's own doc) — tolerant by construction (never throws): an absent hint simply
 *  means the ordinary bounded backoff schedule applies, exactly the pre-#374 behavior. A value
 *  merely far in the PAST (but still Date-valid) is honored unchanged — that just means "probe
 *  immediately", never a reason to reject. `nowMs` is REQUIRED (#403/F25: it used to default to
 *  `Date.now()`, which made the horizon check silently wall-clock-relative — a fixture seeding a
 *  reset hint got a verdict that depended on the day the suite ran). Both production callers pass
 *  their own injected clock. */
export function extractRateLimitResetAt(jsonl: string, nowMs: number): number | null {
  let resetAtMs: number | null = null;
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // mid-write/truncated stream fragment
    }
    if (obj.type !== "rate_limit_event") continue;
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    if (info?.status !== "rejected") continue;
    const resetsAt = info.resetsAt;
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
      resetAtMs = resetsAt * 1000;
    }
  }
  if (resetAtMs == null) return null;
  if (!Number.isFinite(resetAtMs) || Math.abs(resetAtMs) > JS_DATE_VALID_RANGE_MS) return null;
  if (resetAtMs - nowMs > MAX_RATE_LIMIT_RESET_HORIZON_MS) return null;
  return resetAtMs;
}

/** #394 (F22): did this jsonl carry AT LEAST ONE rejected `rate_limit_event` — the Claude CLI's
 *  own structured, text-free confirmation the provider actually refused a request? Deliberately
 *  a separate scan from extractRateLimitResetAt above (not "resetAtMs != null"): a rejection is
 *  real evidence of an env failure regardless of whether its `resetsAt` field also happens to be
 *  present/parseable/in-range — extractRateLimitResetAt's sanity-horizon rejection is a SCHEDULING
 *  concern (never schedule a probe centuries out), not a reason to discard classification
 *  evidence too. Same tolerant parsing as extractRateLimitResetAt: a malformed/truncated line is
 *  skipped, never thrown. This is ONE of TWO structured, text-free classification signals — see
 *  hasQuotaErrorStatus below for the other — both feeding env-failure.ts's classifyEnvFailure as
 *  PRIMARY signals (see that function's own doc for why two, and what neither one covers) ahead
 *  of any text pattern. This is the read half; conductor.ts's LaneProbe.envSignalStructured /
 *  peripheral.ts's RoleSessionResult.envSignalStructured are the write/thread halves — both
 *  computed as `hasRejectedRateLimitEvent(jsonl) || hasQuotaErrorStatus(jsonl)`. */
export function hasRejectedRateLimitEvent(jsonl: string): boolean {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // mid-write/truncated stream fragment
    }
    if (obj.type !== "rate_limit_event") continue;
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    if (info?.status === "rejected") return true;
  }
  return false;
}

/** #394 gate② round 3 (Codex sol-high BLOCK finding, P2): the SECOND structured, text-free
 *  signal — did this jsonl carry a `type:"result"` record the CLI itself marked as an actual
 *  429 at the transport level (`is_error:true`, `api_error_status:429`)? This closes a real gap
 *  `hasRejectedRateLimitEvent` alone leaves open: NOT every quota/rate-limit failure emits a
 *  `rate_limit_event` line — a captured real transcript (worker.test.ts's own #374 fixture) shows
 *  the CLI can produce an errored `result` record with `api_error_status:429` and NO
 *  `rate_limit_event` anywhere in the same jsonl. Without this second signal, a session whose
 *  ONLY evidence is that errored-429 result record — and whose human-readable `result` text uses
 *  a tier word this file's enumerated pattern list doesn't happen to list (e.g. "monthly", a tier
 *  neither #374 nor #394 has captured verbatim) — would classify as an ORDINARY task failure, not
 *  `llm`, with NO fallback catching it: env-failure.ts's own doc explains exactly which paths
 *  this is (and isn't) bounded on. `api_error_status` is accepted as EITHER the number `429` or
 *  the string `"429"`. No capture in this repo has actually shown the string form — the one real
 *  captured errored-429 result (this file's #374 fixture) carries it unquoted, numeric. The
 *  string is accepted DEFENSIVELY, not because a stringified record has been observed: it costs
 *  nothing (there is nothing else `api_error_status` holding the string `"429"` could mean in
 *  this field) and it forecloses the exact class of bug #394 is about. #394 exists because the
 *  engine held a confident, unverified assumption about the CLI's wire shape that reality did not
 *  match; hard-coding this REPLACEMENT signal to one JSON type for the same field, on nothing but
 *  assumption, would plant that identical failure mode one layer over. Do not tighten this back
 *  to `=== 429`, and do not read this comment as asserting a stringified capture exists — none
 *  does. `is_error` still gates inclusion — that check is deliberate and separate, matching the
 *  same field extractFailureText already relies on, regardless of the record's own (misleadingly
 *  non-error-sounding) `subtype`. Same tolerant parsing as its sibling above: a
 *  malformed/truncated line is skipped, never thrown. */
export function hasQuotaErrorStatus(jsonl: string): boolean {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // mid-write/truncated stream fragment
    }
    if (obj.type !== "result") continue;
    if (obj.is_error === true && (obj.api_error_status === 429 || obj.api_error_status === "429")) return true;
  }
  return false;
}

/** Per-worker Claude Code settings wiring the fail-closed PreToolUse guard hook (#26). The
 *  command runs `node <hookPath>` (hookPath is trusted — our own dist path — and quoted); the
 *  matcher covers exactly the tools the guard inspects — Read/Grep/Glob/NotebookRead joined
 *  Bash/Write/Edit/MultiEdit in #235 PR-A (worktree read-containment; NotebookRead added in
 *  PM review of the same PR — same read-family gap, same fix). This matcher IS what makes
 *  Claude Code invoke the hook at all for a given tool: guard.ts/guard-hook.ts's own widened
 *  GUARDED_TOOLS set is necessary but not sufficient — without the matcher change here too, a
 *  Read call would never reach the hook process in the first place (Phase-0's exact finding:
 *  GUARDED_TOOLS never included Read, so "the guard never even saw the call").
 *
 *  FAIL-CLOSED even if `node` can't run the hook (stale dist whose guard-hook.js imports a
 *  missing guard.js, a module-load/syntax error, missing node/PATH): Claude Code treats a
 *  non-zero *non-2* PreToolUse exit as NON-blocking, so the tool would proceed unguarded — a
 *  fail-OPEN in the only live safety boundary (Codex #26 P1). So a hook launch/runtime failure
 *  is mapped to exit 2 (BLOCKING) in hard mode. Soft mode is observe-only, so a crash there
 *  allows (exit 0). Mode is read from the SAPWOOD_GUARD_MODE spawn env. */
export function guardSettings(hookPath: string): object {
  // The command is shell-evaluated, so single-quote the path: double quotes still expand $,
  // backticks, and $() — an install path containing those would break or inject (Codex #26 R2).
  // Single quotes suppress all expansion; embedded single quotes are escaped '\'' .
  const hook = shellSingleQuote(hookPath);
  const command =
    `node ${hook} || { [ "$SAPWOOD_GUARD_MODE" = soft ] && exit 0 || ` +
    `{ echo '[sapwood-guard] hook failed to run — blocking (fail-closed)' >&2; exit 2; }; }`;
  return {
    // Force hooks ON for the worker session: a user/local settings layer with
    // "disableAllHooks": true would otherwise survive (omitted --settings keys keep file
    // values), leaving the guard inert — a fail-OPEN even with the hook file present (Codex
    // #26 R3 P1). Explicitly re-enabling here overrides that layer.
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead", hooks: [{ type: "command", command }] },
      ],
    },
  };
}

/** #87: an opaque handle over a spawned `claude` process — deliberately leaks NO
 *  `child_process` types to callers (`ChildProcess` never appears in this interface), so
 *  peripheral.ts (the role runner) can drive a spawned session without itself importing
 *  `node:child_process` — worker.ts stays the engine's ONE module that touches the CLI /
 *  subprocess layer (CLAUDE.md non-negotiable; pinned by the #69 grep-invariant test). */
export interface SpawnedSession {
  readonly pid: number | undefined;
  onSpawn(cb: () => void): void;
  onError(cb: (e: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  /** SIGTERM/SIGKILL the WHOLE detached process group (negative pid), falling back to just
   *  the leader pid if group-signalling fails — same tolerance as WorkerSupervisor's own
   *  killGroup/signalGroup. */
  killGroup(sig: NodeJS.Signals): void;
}

/** Spawn a `claude` session: argv array (no shell), detached process group (so the caller can
 *  kill the whole tree), stdio wired to the given jsonl fd. The SAME primitive
 *  WorkerSupervisor.dispatch/resume use internally (not re-implemented — this function is
 *  exported so peripheral.ts's narrower role-session shape reuses it directly rather than
 *  opening a second `child_process` import site).
 *
 *  `opts.cwd` (#285, review session mode): OMITTED for every caller except peripheral.ts's
 *  review-session path — the process then inherits the ENGINE's own cwd, exactly today's
 *  behavior, and the CLI's `--worktree <name>` flag (claudeArgs) resolves relative to it. When
 *  supplied, it points the spawned `claude` process directly at an ALREADY-MATERIALIZED plain
 *  source tree (review/materializer.ts's private-clone checkout output — no `.git`, D1) instead
 *  — paired, at the call site, with omitting `--worktree` entirely (asking the CLI to also
 *  create a worktree there would be nonsensical: there is no repo to create one from). This is
 *  the ONLY subprocess `cwd` option in this engine (worker.test.ts's #69 grep-invariant test
 *  pins that WorkerSupervisor's own dispatch()/resume() spawn() calls never set one — this
 *  optional field exists solely for the narrow, guard-active, no-Bash review-session shape). */
export function spawnClaudeSession(
  bin: string,
  args: string[],
  opts: { jsonlFd: number; env: NodeJS.ProcessEnv; cwd?: string },
): SpawnedSession {
  const child = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", opts.jsonlFd, opts.jsonlFd],
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const killGroup = (sig: NodeJS.Signals): void => {
    if (child.pid == null) return;
    try {
      process.kill(-child.pid, sig); // negative pid -> the whole detached process group
    } catch {
      try {
        process.kill(child.pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  return {
    get pid() {
      return child.pid;
    },
    onSpawn: (cb) => child.once("spawn", cb),
    onError: (cb) => child.on("error", cb),
    onExit: (cb) => child.once("exit", cb),
    killGroup,
  };
}

/** #377 (gate② round 3): consecutive INCONCLUSIVE PR associations a single lane may defer on
 *  before the engine settles it by the ordinary no-PR rules. The deferral exists so a
 *  TRANSIENT forge write failure (a 502 on `gh pr create`) isn't mistaken for "this lane has
 *  no PR" on the one probe the conductor settles from — but not every such failure is
 *  transient (`No commits between main and <branch>` fails identically, forever), and an
 *  unbounded defer would hold that lane's slot for the life of the engine. Three consecutive
 *  ticks is the compromise: long enough to ride out a blip, short enough that a permanent
 *  failure reaches a human quickly.
 *
 *  Counted IN MEMORY, per supervisor instance (one per `sapwood run`), deliberately not
 *  persisted: an engine restart hands the lane a fresh budget, which is the safe direction —
 *  more retries against a preserved branch, never fewer. */
/** #377 (gate② round 5): `<lane>.<running|done|failed|handoff>.json` — the engine-written lane
 *  sentinels, the trusted record of which lanes exist. */
const SENTINEL_FILE = /^(.+)\.(?:running|done|failed|handoff)\.json$/;

export const MAX_INCONCLUSIVE_PR_PROBES = 3;

export interface WorkerDeps {
  cfg: SapwoodConfig;
  log?: (message: string) => void;
  /** Directory for sentinels/jsonl/heartbeat. Default <cwd>/data/sessions/state. */
  stateDir?: string;
  /** Parent directory holding each lane's git worktree, keyed by lane name
   *  (`<worktreeRoot>/<name>`). This is the SAME convention the `claude` CLI's `--worktree
   *  <name>` flag resolves against (confirmed against this repo's own `.claude/worktrees/*`
   *  on disk): the engine spawns `claude` with `cwd` inherited from the engine process, so
   *  the CLI resolves `--worktree <name>` relative to that same cwd. Default
   *  <cwd>/.claude/worktrees, mirroring stateDir's cwd-anchored default. */
  worktreeRoot?: string;
  /** claude binary; default discoverClaudeBin(process.env). */
  claudeBin?: string;
  /** #377: probe()'s hasPr/prNumber — resolves THIS LANE's own PR. Replaces the pre-#377
   *  issue-number-keyed pair (`hasOpenPr`/`findOpenPr`, both deleted) that matched a PR body's
   *  PROSE mention of the issue and, in the live F15 case, adopted an unrelated PR. The engine
   *  wires this to forge.ts's `associateLanePr` (branch identity + the engine-authored PR-owner
   *  marker); omitted -> no lane is ever associated with a PR (hasPr false, prNumber undefined),
   *  which is the fail-closed direction: conductor.ts escalates such a lane to a human rather
   *  than driving a guessed merge target. */
  lanePr?: (lane: { name: string; issue: number; branch: string | null; sessionOver: boolean }) => Promise<LanePrOutcome>;
  /** Worker prompt for an issue. Default: a minimal imperative skeleton. */
  renderPrompt?: (issue: Issue) => string;
  /** Path to the compiled guard hook (node <path>). Default: the dist sibling of this module. */
  guardHookPath?: string;
  heartbeatMs?: number; // default 30_000
  now: () => Date;
  /** #395: injected timer so a test can deterministically win the spawn-confirmation watchdog
   *  race (util/spawn-confirm.ts's awaitSpawnConfirmation) without depending on real OS
   *  process-spawn timing. Default: a real, cancelable `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** #244 (Codex sol-high PR #260 review, P2): the narrow State surface WorkerSupervisor needs
   *  to record a durable `proxy-mint-failed` event when a `dispatch()` caller's `proxy.mint`
   *  throws, and (#395 gate② round 2/3) `heartbeatTick`'s own progress heartbeat (util/
   *  heartbeat.ts's createHeartbeatGate — `maxEventId` is the gate's "don't speak over other
   *  progress" check) — kept as a `Pick` (not the whole State class), same convention as every
   *  other narrow-state-dependency field in this codebase (e.g. peripheral.ts's
   *  RetriedSession.state). Optional and additive: omitted -> both degrade to zero behavior
   *  change (mint-failure observability falls back to the existing stderr log line; the
   *  heartbeat simply never fires) — never a hard requirement for ordinary dispatch.
   *
   *  #617 (seam 3, capability DR #616): widened with `recordContextManifest` — the SAME narrow-
   *  Pick contract, additive. Omitted -> a lane's context manifest is assembled (best-effort) but
   *  never persisted; recordLaneContextManifest's own doc covers the zero-behavior-change case. */
  state?: Pick<State, "appendEvent" | "maxEventId" | "recordContextManifest">;
  /** #617 (seam 3): bounded poll of a lane's still-growing jsonl for its own init line, before
   *  capturing the CLAUDE.md-family half of its context manifest — same rationale and same
   *  defaults (100ms/30s) as peripheral.ts's RoleRunnerDeps fields of the same name; see
   *  capturePreSpawnManifestForLane's own doc. */
  preSpawnCaptureTimeoutMs?: number;
  preSpawnCapturePollMs?: number;
}

/** #244: an optional, per-session revocable forge MCP proxy handle for a WORKER LEG (the fix-loop
 *  worker's evidence channel for PR review data — mirrors peripheral.ts's RoleSessionOpts.proxy
 *  mechanism, extended here to WorkerSupervisor). Omitted -> today's dispatch/resume behavior,
 *  completely unchanged: an ordinary code-producing lane inherits its forge credentials via
 *  `process.env` exactly as before #244 (worker.test.ts's own regression pins that workers
 *  LEGITIMATELY need GH_TOKEN, unlike peripheral role sessions) — attaching a proxy alone never
 *  strips that. `credentialFree` is a SEPARATE, independent opt for the one caller shape that
 *  genuinely wants it (a fix-loop leg that reaches `gh`/git's CREDENTIALED path via the proxy
 *  ONLY — no ambient GH_TOKEN, no gh-config fallback, no git credential helper — and pushes, if
 *  at all, through whatever residual channel remains after that; see workerCredentialFreeEnv's
 *  doc for the honest scope: this is NOT a claim that the proxy is the leg's only reach to
 *  GitHub in an absolute sense, since arbitrary code under Bash(node/npm) can still read an
 *  ambient credential store directly off disk — docs/security.md's residuals note). Same
 *  worker-class posture retro.ts's session already uses for its own git-credential reach.
 *
 *  SEALED MCP SURFACE (#617, seam 1 of capability DR #616 — CLOSED HISTORY, not current risk):
 *  the paragraph above and workerCredentialFreeEnv's own doc describe the CREDENTIAL reach only —
 *  they were silent on the leg's MCP CONFIG, and until #617 that silence hid a real gap: a
 *  credentialFree leg's `--mcp-config` (the proxy's own server, set whenever a proxy is attached)
 *  was ADDITIVE, not exclusive, so every ambient host MCP server from settings sources ALSO
 *  loaded and — per #616's live probe — stayed callable regardless of `--allowedTools`, including
 *  write/execution-class tools, none reaching the guard hook. That was WORSE than the documented
 *  `steal.mjs` disk-read residual this opt was built to bound: a live network channel, not a
 *  local-disk read. dispatch()/resume() now pass `strictMcpConfig: true` whenever
 *  `credentialFree` is set (see either call site's own doc), making `--mcp-config` EXCLUSIVE —
 *  the CLI loads ONLY the proxy's server. The disk-read residual below (arbitrary code under
 *  `Bash(node/npm)` reading an ambient credential store) is UNCHANGED by this seal — it is a
 *  distinct channel (local files, not MCP) that `--strict-mcp-config` cannot and does not touch.
 *
 *  FAIL-CLOSED POLICY (Codex sol-high PR #260 review, P2): a proxy WITHOUT `credentialFree` is
 *  non-fatal on mint failure (the lane still dispatches, unattached — an optional read-side
 *  capability's setup failure must never block an otherwise-normal run). `credentialFree: true`
 *  is different — a leg dispatched that way has NEITHER the gh/git credentialed-tool path NOR (if mint
 *  fails) a working evidence channel, so it must not run silently degraded: mint failure REFUSES
 *  the dispatch outright (see `dispatch()`'s own doc). Either branch records a durable
 *  `proxy-mint-failed` event (via `WorkerDeps.state`, when supplied) before deciding which way
 *  to go. */
export interface WorkerProxyOpts {
  mint: (session: { role: string; session: string }) => Promise<ForgeProxyHandle>;
  /** When true, the `gh`/git CREDENTIALED-TOOL reach is severed (Codex sol-high PR #260 review,
   *  P1: env-var stripping alone is insufficient — `gh` falls back to `$HOME/.config/gh`'s
   *  stored credentials regardless of `GH_TOKEN`'s absence, and git can still reach a
   *  credential helper or SSH agent). See `workerCredentialFreeEnv`'s doc for the exact env
   *  shape this composes and its HONEST scope (round-2 delta review, P1: this does NOT achieve
   *  full isolation — a leg that runs arbitrary code under `Bash(node *)`/`Bash(npm *)` still
   *  has the operator's real `$HOME` and can read an ambient credential store directly off
   *  disk, bypassing env entirely; a live PoC read `~/.config/gh/hosts.yml` this way). See
   *  `dispatch()`'s own doc for the accompanying `--allowedTools` narrowing (drops
   *  `Bash(gh *)`, keeps git for worktree-local ops) AND (#617) the `strictMcpConfig` MCP seal —
   *  this flag now closes BOTH the credentialed-tool reach (this doc) and the MCP-config surface
   *  (this interface's own header doc), not just the former. Omitted/false -> unchanged
   *  inheritance, today's behavior. */
  credentialFree?: boolean;
}

/** #244 (Codex sol-high PR #260 review, P1): severs the `gh`/git CREDENTIALED-TOOL reach — env-VAR
 *  stripping (peripheral.ts's peripheralSessionEnv denylist: GH_ prefixed vars, GITHUB_TOKEN,
 *  GITHUB_ENTERPRISE_TOKEN, GIT_ASKPASS, GIT_CONFIG_ prefixed vars, case-normalized — duplicated
 *  here rather than imported, to avoid a worker.ts <-> peripheral.ts circular import) is NECESSARY
 *  but NOT SUFFICIENT on its own: `gh` falls back to on-disk stored credentials
 *  (`$HOME/.config/gh/hosts.yml`) when no env token is present, and git can still reach a
 *  credential helper, a cached SSH agent, or an interactive prompt. This function additionally:
 *  - points `GH_CONFIG_DIR` at `ghConfigDir` — a FRESH, EMPTY, per-lane scratch directory (the
 *    caller creates it; `gh` reads its stored host/token config from there, never from the real
 *    `$HOME/.config/gh`, so `gh`'s OWN commands can no longer see an operator's logged-in session);
 *  - sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` — git's own global/
 *    system config (where a `credential.helper` entry typically lives) is never read;
 *  - sets `GIT_TERMINAL_PROMPT=0` — git fails closed rather than blocking on an interactive
 *    credential prompt if it somehow still reaches an auth wall;
 *  - drops `SSH_AUTH_SOCK` — an inherited SSH agent socket is a live credential channel git can
 *    use for an `ssh://` remote, independent of any `GIT_CONFIG_*`/`GH_*` variable.
 *
 *  HONEST SCOPE — NOT full isolation (round-2 delta review, P1, honest-scope closure; PM ruling
 *  2026-07-18, same "document the residual, don't chase it with more machinery" stance as #256's
 *  Sentinel isolation boundary section): this closes `gh`'s and git's OWN credential-lookup
 *  paths — it does NOT, and structurally CANNOT, confine what ARBITRARY CODE run under this
 *  lane's `Bash(node *)`/`Bash(npm *)` grant can read off disk. A fix leg genuinely needs those
 *  grants to run tests, and it still executes with the operator's REAL `$HOME` — a live PoC
 *  (`node steal.mjs`) proved a script under that grant can read `~/.config/gh/hosts.yml`
 *  directly and reach GitHub with the credential it finds there, entirely bypassing every env
 *  var this function touches. Two things this repo deliberately does NOT attempt here: (1) HOME
 *  isolation (redirecting `$HOME` would break the `claude` CLI's own config/auth, which this
 *  lane also needs to run at all) and (2) stripping `Bash(node *)`/`Bash(npm *)` (a fix leg's
 *  whole job requires running the test suite). The upgrade path for a genuinely closed boundary
 *  is OS-level sandboxing (a container/chroot/Landlock-style filesystem confinement) or running
 *  fix legs under a dedicated, narrowly-scoped CI identity whose credential store contains
 *  nothing worth stealing — neither is implemented by this function. One narrowing worth naming:
 *  `hosts.yml` is `gh`'s PLAINTEXT-token storage path; on macOS, `gh auth login` by default
 *  stores the token in the OS keychain instead, which this mechanism (and the PoC) does not
 *  expose — the concrete risk this note describes is sharpest wherever `gh` ends up with a
 *  plaintext-on-disk token (Linux, CI images, or an explicit `--insecure-storage` login), not a
 *  universal property of every `gh` installation.
 *
 *  SCOPE BOUNDARY (#617): this function is env-only — it never touched, and still never touches,
 *  the leg's MCP config. The separate ambient-MCP gap #617 closed (see WorkerProxyOpts' own doc's
 *  "SEALED MCP SURFACE" note) is closed by dispatch()/resume() passing `strictMcpConfig: true`,
 *  not by anything here — keep that seam there, not folded into this function's env-only job. */
export function workerCredentialFreeEnv(ghConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "GITHUB_TOKEN" ||
      normalized === "GITHUB_ENTERPRISE_TOKEN" ||
      normalized.startsWith("GH_") ||
      normalized === "GIT_ASKPASS" ||
      normalized.startsWith("GIT_CONFIG_") ||
      normalized === "SSH_AUTH_SOCK"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

interface Lane {
  child: ChildProcess;
  issue: number;
  sessionId: string;
  jsonlFd: number;
  jsonlPath: string;
  hb: NodeJS.Timeout | undefined; // set once the spawn is confirmed still-running
  handoffRequested: boolean;
  reclaiming: boolean;
  startedMs: number; // wall-clock start, for the timeoutSec ceiling
  timedOut: boolean;
  estimatedCostUsd: number; // #33: live token-estimation total for THIS RUN (see pricing.ts)
  /** #33 (gate② P1): the estimated USD already in the jsonl at the moment this run started —
   *  0 on a fresh dispatch, and the pre-handoff stream's estimated total on a resume() (which
   *  APPENDS to the preserved jsonl). checkSoftBudget compares (whole-file total − this
   *  baseline) against worker.budgetUsdSoft: the soft budget bounds spend PER RUN, not per
   *  issue lifetime — without the baseline, a lane that handed off AT the budget would re-cross
   *  it on the first heartbeat tick after resume and hand off again instantly, forever (an
   *  unresumable handoff loop). This estimator baseline is needed because the jsonl appends;
   *  terminal total_cost_usd itself is already reported per leg (#172). */
  estimateBaselineUsd: number;
  /** Byte boundary where this leg begins in the append-only jsonl. Result/model parsing must
   *  never reuse a prior leg's terminal result when the current resumed leg has none. */
  jsonlLegOffset: number;
  /** #244: this lane's forge MCP proxy handle, when dispatch() was called with a `proxy` opt —
   *  undefined for the (default, unchanged) unattached case. Revoked/torn down in onExit, the
   *  ONE place a lane's process truly terminates (mirrors peripheral.ts's RoleRunner.run()
   *  teardown-in-every-outcome stance, adapted to WorkerSupervisor's long-lived-lane shape). */
  proxyHandle?: ForgeProxyHandle;
  /** #244 (Codex sol-high PR #260 review round 2, P2): the fresh, empty, per-lane scratch
   *  directory `workerCredentialFreeEnv` pointed `GH_CONFIG_DIR` at — undefined unless
   *  `opts.proxy.credentialFree` was set (dispatch() only creates it in that case). Removed
   *  (best-effort) in onExit and in the spawn-failure cleanup path, alongside the lane's own
   *  jsonl/sentinels — never left behind as directory litter under stateDir. */
  ghConfigDir?: string;
  /** #617 (seam 3): the rendered prompt this leg was dispatched/resumed with — carried so
   *  recordLaneContextManifest can hash the ACTUAL prompt text (assembleContextManifest's
   *  promptTemplateVersion field), same as peripheral.ts's manifest wiring does via opts.prompt,
   *  rather than fabricating a version string or leaving the field null for every worker leg. */
  prompt: string;
  /** #617 (seam 3): the in-flight FILESYSTEM-derived half of this lane's context manifest,
   *  kicked off fire-and-forget by capturePreSpawnManifestForLane right after spawn. A PROMISE,
   *  not a settled value — onExit() (the one place a lane truly terminates) chains onto this
   *  rather than reading a value that may not have landed yet: a fast-exiting lane's 'exit' event
   *  can fire before the init-line poll's first tick even completes, and reading a synchronous
   *  field at that instant would silently drop the manifest for exactly the sessions whose
   *  ambient-context drift matters most to catch (a crash-fast worker leg). Undefined only when
   *  the lane never reached the confirmed-alive gate at all (mirrors `lane.hb`'s own "only set up
   *  once alive" contract) — see recordLaneContextManifest's own doc for the zero-behavior-change
   *  case this degrades to. */
  manifestPreSpawnPromise?: Promise<PreSpawnManifestCapture | undefined>;
}

/** #69: recursive `.git`-excluding mtime/ctime scan — "is anything under this worktree newer
 *  than `sinceMs`?". Never invokes git (see retainOrDeleteWorktree's doc for why `git status
 *  --porcelain` was REJECTED: it can invoke a worker-set clean filter, the #65 RCE class).
 *  Directory timestamps are checked too (a deleted file is also an uncommitted change, visible
 *  only as its parent dir's bumped timestamp), `lstatSync` never follows symlinks (a planted
 *  broken/absolute link is judged by the link itself), and BOTH mtime and ctime are compared
 *  (ctime can't be backdated by unprivileged code — fable P2-b). The baseline comparison is
 *  INCLUSIVE (`>=`, Codex PR #72 round-2 P2): on a coarse-resolution filesystem a worker can
 *  write WIP in the SAME timestamp tick as the baseline, landing an entry exactly equal to
 *  sinceMs — a strict `>` would read that as clean and DELETE it (a WIP-loss false-negative the
 *  degrade-to-human policy forbids). `>=` widens the fail-safe-dirty window by one tick, the
 *  correct direction (the policy accepts false-positive-dirty, never false-negative-clean).
 *  Fails safe (dirty) on any unreadable/unstatable path or an unknown baseline — every caller
 *  only ever deletes on an explicit `false`.
 *
 *  #428: module-level (was a WorkerSupervisor private method) so peripheral.ts's retro
 *  worktree-retention check reuses THIS scan rather than growing a second implementation of the
 *  same heuristic. Only the BASELINE differs between the two callers — a lane's immutable
 *  `dispatched_at` here, the worktree's own git-index mtime there. */
export function worktreeMaybeDirty(worktreePath: string, sinceMs: number): boolean {
  if (!Number.isFinite(sinceMs)) return true; // unknown baseline -> can't prove clean
  const touchedSince = (p: string): boolean => {
    const s = lstatSync(p);
    return s.mtimeMs >= sinceMs || s.ctimeMs >= sinceMs;
  };
  const stack: string[] = [worktreePath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      if (touchedSince(dir)) return true; // entry added/removed in this dir
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // unreadable -> fail-safe: treat as possibly dirty
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p); // its own timestamps are checked when popped
        continue;
      }
      try {
        if (touchedSince(p)) return true;
      } catch {
        return true; // unstatable -> fail-safe dirty
      }
    }
  }
  return false;
}

export class WorkerSupervisor implements Supervisor {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;
  // #33: the soft-budget estimator's model rate table, loaded ONCE at construction (from
  // worker.pricingFile or the shipped engine/pricing.yaml — see pricing.ts), never per tick.
  // A missing/malformed configured file throws HERE, at startup, before any dispatch.
  private readonly pricing: PricingTable;
  private readonly lanes = new Map<string, Lane>();
  // #395 (gate② round 3): one liveness-gated heartbeat per live lane, keyed by lane name —
  // persisted across setInterval ticks (util/heartbeat.ts's createHeartbeatGate needs its own
  // "id seen at the last check" cursor to remember). Created lazily in heartbeatTick, removed in
  // onExit (the one place a lane truly terminates) — a spawn-failure lane never gets an entry at
  // all, since `lane.hb`/heartbeatTick are only ever set up after a confirmed spawn.
  private readonly heartbeatGates = new Map<string, HeartbeatGate>();
  // Detached lanes (persisted running.json, no in-memory handle — engine restarted while the
  // worker kept running) already asked to hand off. Keeps requestHandoff idempotent-per-tick
  // for lanes we can only reach by persisted pid (Codex PR #41 P1). Also consulted by
  // probe()'s detached-confirm-death finalize (#63) — see finalizeDetachedHandoffIfConfirmedDead.
  private readonly detachedHandoffRequested = new Set<string>();
  // #63: detached lanes this supervisor has reclaim()'d (DEAD or ceiling-escalation teardown —
  // going FAILED, not resumable). Guards finalizeDetachedHandoffIfConfirmedDead: a lane torn
  // down via reclaim() must never ALSO be finalized as a resumable .handoff just because it
  // also happens to match "handoff was requested, pid now confirmed dead" — reclaim() already
  // decided its fate.
  private readonly detachedReclaiming = new Set<string>();
  // #377 (gate② round 3): consecutive inconclusive PR associations per lane — the deferral
  // budget MAX_INCONCLUSIVE_PR_PROBES bounds. Cleared by any conclusive outcome and by
  // reclaim(), so it can never outlive the lane it belongs to.
  private readonly inconclusivePrProbes = new Map<string, number>();
  // #617 (seam 3, capability DR #616): same bound peripheral.ts's RoleRunner uses for its own
  // init-line poll (100ms/30s default) — see capturePreSpawnManifestForLane's own doc.
  private readonly preSpawnCaptureTimeoutMs: number;
  private readonly preSpawnCapturePollMs: number;

  constructor(private readonly deps: WorkerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "state");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    // Default to the compiled hook sibling (dist/guard-hook.js when running compiled). The
    // "build-dist" step (#26) is the existing `npm run build`; dispatch fails closed below if
    // the file is absent in hard mode rather than running an unguarded worker.
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("../guard/guard-hook.js", import.meta.url));
    this.pricing = loadPricingTable(deps.cfg);
    this.preSpawnCaptureTimeoutMs = deps.preSpawnCaptureTimeoutMs ?? 30_000;
    this.preSpawnCapturePollMs = deps.preSpawnCapturePollMs ?? 100;
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string, ext: string): string {
    return join(this.dir, `${name}.${ext}`);
  }
  private now(): Date {
    return this.deps.now();
  }
  private log(message: string): void {
    (this.deps.log ?? console.error)(message);
  }

  /** #244 (Codex sol-high PR #260 review, P2): durable mint-failure observability — a
   *  `proxy-mint-failed` state event (lane/role/sanitized reason), so a repeated or systemic mint
   *  failure is queryable after the fact, not just a transient stderr line. Contained: a
   *  state-write failure here is logged and otherwise swallowed, never allowed to interfere with
   *  the caller's own fail-open/fail-closed decision (same "record, don't gate" stance every
   *  other best-effort appendEvent call in this codebase takes). No-op when WorkerDeps.state
   *  wasn't supplied (optional, additive — see that field's own doc). `reason` is ALREADY
   *  sanitized by the caller (sanitizeUpstreamError) before it reaches here. */
  private recordProxyMintFailed(lane: string, reason: string): void {
    if (!this.deps.state) return;
    try {
      this.deps.state.appendEvent("proxy-mint-failed", { lane, role: "worker", reason });
    } catch (e) {
      this.log(
        `[sapwood:forge-proxy] lane ${lane}: failed to record proxy-mint-failed event (non-fatal): ${sanitizeUpstreamError(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }

  /** #304: best-effort monitor-only recording at the lane-end jsonl read already used for
   *  terminal accounting. Scanner failures and event-write failures share one allow-direction
   *  catch: the terminal sentinel has already landed, and observability can never alter it. */
  private recordEgressSuspects(worker: string, issue: number, legJsonl: string): void {
    if (!this.deps.state) return;
    try {
      const scan = scanEgressSuspects(legJsonl, this.deps.cfg.worker.egressSuspectCommands);
      for (const suspect of scan.hits) {
        this.deps.state.appendEvent("egress-suspect", { worker, issue, ...suspect });
      }
      if (scan.truncated) {
        this.log(
          `[sapwood:worker] lane ${worker}: egress tripwire evidence capped at ${MAX_EGRESS_SUSPECTS_PER_LEG} suspects for this leg`,
        );
      }
    } catch (e) {
      this.log(`[sapwood:worker] lane ${worker}: egress tripwire failed (non-fatal): ${String(e)}`);
    }
  }

  /** #244 (Codex sol-high PR #260 review round 2, P2): best-effort removal of a lane's
   *  credentialFree GH_CONFIG_DIR scratch directory — undefined `dir` (the common, non-
   *  credentialFree case) is a no-op. Called from BOTH cleanup paths a lane can exit through
   *  (onExit and the spawn-failure branch) so the directory is never left behind as litter
   *  under stateDir regardless of how the lane's run ended. Logged, never thrown — a cleanup
   *  failure must not mask the lane's own real outcome. */
  private removeGhConfigDir(dir: string | undefined, laneName: string): void {
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      this.log(
        `[sapwood:worker] lane ${laneName}: failed to remove GH_CONFIG_DIR scratch directory (non-fatal): ${sanitizeUpstreamError(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }

  /** #245 round-2 fix (B1): best-effort removal of a STALE prior-leg `.done`/`.failed` terminal
   *  sentinel — the reconciliation-side counterpart to resume()'s own post-spawn-confirmation
   *  removal (see that method's doc). Called by conductor.ts's `reconcileDrivingFixIntents` when
   *  it adopts a `driving` row with a confirmed fix-entry spawn intent, covering the crash
   *  window between resume()'s confirmation write and its own sentinel removal (a restart-safe
   *  belt-and-suspenders — removeIfExists is already idempotent on an already-gone file). Never
   *  throws; a no-op when neither sentinel exists. */
  clearStaleFixEntrySentinel(name: string): void {
    this.removeIfExists(this.path(name, "done.json"));
    this.removeIfExists(this.path(name, "failed.json"));
  }

  async dispatch(issue: Issue, name?: string, opts?: { proxy?: WorkerProxyOpts }): Promise<{ name: string; sessionId: string }> {
    const laneName = name ?? `lane-${issue.number}-${randomUUID().slice(0, 8)}`;
    // Refuse name reuse — a stale sentinel under this name means a concurrent/old lane; a
    // second worker would clobber its jsonl/sentinels (0day Codex #4).
    for (const ext of SENTINEL_EXTS) {
      if (existsSync(this.path(laneName, ext))) {
        throw new Error(`worker name in use (${laneName}.${ext} exists) — reassign a fresh name`);
      }
    }
    // FAIL-CLOSED: never dispatch an unguarded worker in hard mode. If the compiled guard hook
    // is missing (engine not built), refuse rather than run claude with no live PreToolUse
    // guard — a missing hook file would otherwise be a silent fail-OPEN (#26).
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `dispatching; refusing to run an unguarded worker in hard mode`,
      );
    }
    const sessionId = randomUUID();
    const prompt = (this.deps.renderPrompt ?? defaultPrompt)(issue);
    const jsonlPath = this.path(laneName, "jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    // Guard wiring is passed as INLINE --settings JSON (not a file): a settings *file* under
    // stateDir would be worker-writable via Bash to its absolute path, and Claude reloads hook
    // edits live — a worker could set disableAllHooks:true on its own settings mid-session and
    // disable the guard (Codex #26 R4 P1). An argv JSON string has no file to mutate. Scoped to
    // THIS claude -p only (not a plugin-global hook that would hit the human).
    const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
    // #244: mint the read-only forge MCP proxy BEFORE building argv — its tool names widen
    // --allowedTools and its --mcp-config is an inline argv value, both needed before claudeArgs
    // runs.
    //
    // FAIL-CLOSED POLICY (Codex sol-high PR #260 review, P2): a proxy WITHOUT credentialFree is
    // non-fatal on mint failure — same posture as peripheral.ts's RoleRunner: an optional
    // capability's setup failure must never block an otherwise-normal dispatch. `credentialFree:
    // true` is different: that leg's `gh`/git credentialed-tool reach is the proxy (its env has
    // no ambient token, no gh config, no git credential path — see workerCredentialFreeEnv,
    // whose doc also states the honest scope: this is NOT full isolation, since arbitrary code
    // under Bash(node/npm) still runs with the real $HOME), so a failed mint there leaves it
    // with NEITHER that credentialed path NOR a working evidence channel — it must not run
    // silently degraded. Both branches record a durable `proxy-mint-failed` event first
    // (when WorkerDeps.state is supplied; contained — a state-write failure never blocks the
    // decision it's merely recording).
    let proxyHandle: ForgeProxyHandle | undefined;
    if (opts?.proxy) {
      try {
        proxyHandle = await opts.proxy.mint({ role: "worker", session: laneName });
      } catch (e) {
        const reason = sanitizeUpstreamError(e instanceof Error ? e.message : String(e));
        this.recordProxyMintFailed(laneName, reason);
        if (opts.proxy.credentialFree) {
          try {
            closeSync(jsonlFd);
          } catch {
            /* noop */
          }
          this.removeIfExists(jsonlPath);
          throw new Error(
            `dispatch refused for lane ${laneName}: credentialFree was requested but the forge proxy mint failed — ` +
              `a leg with neither the gh/git credentialed-tool path nor a working evidence channel must not run: ${reason}`,
          );
        }
        this.log(`[sapwood:forge-proxy] lane ${laneName}: mint failed (non-fatal, proxy unattached): ${reason}`);
      }
    }
    // #244 (Codex sol-high PR #260 review, P1): a fresh, empty, per-lane GH_CONFIG_DIR — created
    // regardless of whether credentialFree ends up true (cheap, and keeps the directory's
    // lifecycle tied to the lane's own stateDir rather than conditioned on opts). Only actually
    // pointed at by the spawn env when credentialFree is set (workerCredentialFreeEnv below).
    const ghConfigDir = this.path(laneName, "gh-config-empty");
    if (opts?.proxy?.credentialFree) mkdirSync(ghConfigDir, { recursive: true });
    // NB: NO --add-dir for the engine `data/` tree — mounting it would let the worker write its
    // own .done/.failed or mutate state, defeating wrapper-signaled completion (Codex R3 P1).
    const args = claudeArgs({
      prompt,
      model: this.deps.cfg.worker.model,
      effort: this.deps.cfg.worker.effort,
      fallbackModel: this.deps.cfg.worker.fallbackModel,
      worktree: laneName,
      name: laneName,
      sessionId,
      settings: settingsJson,
      // #244: widen --allowedTools with the proxy's own (role-scoped) tool names, same pattern
      // as peripheral.ts's RoleRunner — only when a proxy actually minted; unattached dispatch
      // (today's default) passes neither flag, byte-identical to pre-#244 behavior. A
      // credentialFree leg's BASE list drops `Bash(gh *)` (Codex sol-high PR #260 review, P1) —
      // its env can no longer authenticate `gh` at all, so the grant itself narrows to match.
      ...(proxyHandle
        ? {
            allowedTools: [opts?.proxy?.credentialFree ? WORKER_ALLOWED_TOOLS_NO_GH : WORKER_ALLOWED_TOOLS, ...proxyHandle.toolNames].join(
              ",",
            ),
          }
        : {}),
      ...(proxyHandle ? { mcpConfig: proxyHandle.mcpConfigJson } : {}),
      // #617 (seam 1, capability DR #616): credentialFree ⇒ SEALED MCP surface, not merely a
      // narrowed --allowedTools grant. Before this, a credentialFree leg's --mcp-config (the
      // proxy's own server, set unconditionally above whenever proxyHandle exists) was ADDITIVE —
      // every ambient host MCP server from settings sources still loaded and, per #616's live
      // probe, remained CALLABLE regardless of --allowedTools (write/execution-class tools included,
      // none reaching the guard hook) — worse than the documented steal.mjs residual this leg's
      // env-stripping was meant to close. --strict-mcp-config (worker.ts's own probeLlmPing
      // already uses it; also #285's review-session seal) makes --mcp-config EXCLUSIVE: the CLI
      // loads ONLY the proxy's server, ignoring every other config source. credentialFree implies
      // proxyHandle is defined here (a credentialFree mint failure REFUSES the dispatch above,
      // before this call) — never a caller widening its OWN --mcp-config unsealed, since this
      // field is fixed to the engine-composed proxy config regardless. Non-credentialFree paths
      // (including an attached, non-credentialFree proxy) are byte-identical to before this seam:
      // `--setting-sources` stays untouched here too (#616 §5: action-side vs. content-side, same
      // ambient-CLAUDE.md posture as every other worker leg).
      ...(opts?.proxy?.credentialFree ? { strictMcpConfig: true } : {}),
    });
    // detached: child is its own process-group leader -> reclaim can SIGKILL the whole tree.
    // SAPWOOD_GUARD_MODE in the spawn env reaches the hook subprocess (inherited from claude)
    // but is NOT worker-writable, so a worker can't flip its own guard hard->soft (#26).
    // SAPWOOD_WORKTREE_ROOT (#235 PR-A): the ABSOLUTE path of THIS lane's worktree, so the
    // guard hook can confine Read/Grep/Glob to it (see guard.ts's checkReadContainment).
    // resolve()'d because this.worktreeRoot may be a relative deps override — the guard
    // needs an absolute root to compare against Claude Code's absolute tool_input paths.
    // #244: baseEnv is credential-stripped (workerCredentialFreeEnv, #260 review: env vars +
    // GH_CONFIG_DIR + GIT_CONFIG_GLOBAL/SYSTEM + GIT_TERMINAL_PROMPT + no SSH_AUTH_SOCK) ONLY
    // when opts.proxy.credentialFree is explicitly set — every other caller (today's entire
    // production dispatch path) keeps inheriting process.env verbatim, unchanged from pre-#244
    // behavior (worker.test.ts's own regression: "unlike peripherals, workers legitimately [need
    // GH_TOKEN]").
    const baseEnv = opts?.proxy?.credentialFree ? workerCredentialFreeEnv(ghConfigDir) : process.env;
    const child = spawn(this.bin, args, {
      detached: true,
      stdio: ["ignore", jsonlFd, jsonlFd],
      env: { ...baseEnv, SAPWOOD_GUARD_MODE: guardMode, SAPWOOD_WORKTREE_ROOT: resolve(this.worktreeRoot, laneName) },
    });
    // Register the lane + `exit` handler BEFORE any await. Node does not replay `exit` to
    // listeners attached after it fires, so a fast exit (instant completion / the CLI
    // rejecting args) must already have its handler or its terminal sentinel is lost and the
    // conductor mis-reads the lane as DEAD (Codex PR #32 R2 P2).
    const lane: Lane = {
      child,
      issue: issue.number,
      sessionId,
      jsonlFd,
      jsonlPath,
      hb: undefined,
      handoffRequested: false,
      reclaiming: false,
      startedMs: this.now().getTime(),
      timedOut: false,
      estimatedCostUsd: 0,
      estimateBaselineUsd: 0,
      jsonlLegOffset: 0,
      prompt,
      ...(proxyHandle ? { proxyHandle } : {}),
      ...(opts?.proxy?.credentialFree ? { ghConfigDir } : {}),
    };
    this.lanes.set(laneName, lane);
    child.on("exit", (code) => this.onExit(laneName, code));

    // spawn() reports a bad CLAUDE_BIN / missing `claude` via an async `error` event, not a
    // throw — AWAIT the spawn outcome before reporting success. On failure clean up + reject
    // so the conductor's claim-rollback runs and no bogus running marker is left (Codex R1 P2).
    // #395: bounded — Node gives this confirmation no timeout of its own, and the live incident
    // was exactly this class of await never resolving (a host sleep lost a spawn/exit
    // notification). A timeout folds into `spawnErr` and reuses the SAME cleanup/throw below a
    // genuine spawn `error` already takes — no new failure path.
    const spawnConfirm = await awaitSpawnConfirmation(
      (onSpawn, onError) => {
        child.once("spawn", onSpawn);
        child.once("error", onError);
      },
      this.deps.cfg.liveness.spawnConfirmTimeoutMs,
      this.deps.sleep,
    );
    let spawnErr: unknown = spawnConfirm.err;
    if (spawnConfirm.timedOut) {
      spawnErr = new Error(
        `spawn confirmation timed out after ${this.deps.cfg.liveness.spawnConfirmTimeoutMs}ms ` +
          "(host sleep or a lost spawn notification) — killing the possibly-still-alive child",
      );
      // #395 (gate② P3): AWAIT the kill (SIGTERM, a short grace window, then SIGKILL — the same
      // killTree() ordering resume()'s own timeout branch and peripheral.ts's RoleRunner both
      // already use) before the cleanup below rmSync's this lane's worktree — a fire-and-forget
      // SIGKILL followed immediately by rmSync could race a still-alive process's own in-flight
      // writes to that same directory.
      await this.killTree(child);
    }
    if (spawnErr) {
      this.lanes.delete(laneName);
      try {
        closeSync(jsonlFd);
      } catch {
        /* noop */
      }
      this.removeIfExists(jsonlPath);
      // #244: tear down the proxy even though spawn itself failed — the mint above already
      // started a live listener holding a bearer token; a thrown spawn must never leak it.
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch (e) {
          this.log(
            `[sapwood:forge-proxy] lane ${laneName}: teardown failed after spawn error (non-fatal): ${sanitizeUpstreamError(e instanceof Error ? e.message : String(e))}`,
          );
        }
      }
      // #244 (Codex sol-high PR #260 review round 2, P2): the per-lane GH_CONFIG_DIR scratch
      // directory is lane-scoped litter otherwise — clean it up on this path too, not just onExit.
      this.removeGhConfigDir(lane.ghConfigDir, laneName);
      // #395: on a genuinely-lost spawn notification (spawnConfirm.timedOut), the child may have
      // already started provisioning its OWN worktree (the `claude` CLI's `--worktree laneName`
      // startup step, which runs entirely inside the spawned process — this engine never creates
      // it). This is a FRESH lane's first-ever worktree, never prior WIP (unlike resume(), which
      // reuses an existing one and must never delete it here) — safe to discard. No running.json/
      // State row was ever written for this lane, so nothing else would ever sweep it. A no-op
      // when nothing was created yet (the ordinary bad-binary spawn-error case, which never gets
      // this far).
      try {
        rmSync(join(this.worktreeRoot, laneName), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw new Error(`worker spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    // Post-spawn error (rare) must not crash the host — route to a failed exit.
    child.on("error", () => this.onExit(laneName, 1));
    // Only set up the running marker + heartbeat if the child is still alive — a very fast
    // exit during the await is already handled by onExit (lane removed); don't resurrect it.
    if (this.lanes.has(laneName) && child.exitCode === null && child.signalCode === null) {
      const startedIso = new Date(lane.startedMs).toISOString();
      this.writeJsonAtomic(this.path(laneName, "running.json"), {
        name: laneName,
        issue: issue.number,
        session_id: sessionId,
        wrapper_pid: child.pid,
        started_at: startedIso,
        estimate_baseline_usd: 0,
        jsonl_leg_offset: 0,
        // #69 (fable P1): the IMMUTABLE first-dispatch time, the dirty-worktree retention
        // baseline. Distinct from started_at, which resume() resets to resume-time for the
        // wall-clock timeout — baselining retention on that would judge pre-handoff WIP (older
        // than the new start) CLEAN and delete it. dispatched_at never moves once set.
        dispatched_at: startedIso,
      });
      this.touchHeartbeat(laneName);
      lane.hb = setInterval(() => this.heartbeatTick(laneName), this.hbMs);
      // #617 (seam 3): fire-and-forget — never awaited, never delays this method's own return.
      // See capturePreSpawnManifestForLane's own doc for why this can't simply await the same
      // init-line poll peripheral.ts's RoleRunner does inline: dispatch() has never blocked on
      // session completion (or even session init), and doing so here would be a far bigger
      // behavior change than a diagnostic manifest justifies. Assigned onto `lane` (a PROMISE,
      // not awaited) so onExit can chain onto it later regardless of how fast this lane exits —
      // see Lane.manifestPreSpawnPromise's own doc for why a synchronous field would race.
      lane.manifestPreSpawnPromise = this.capturePreSpawnManifestForLane(laneName, jsonlPath, resolve(this.worktreeRoot, laneName));
    }
    return { name: laneName, sessionId };
  }

  resumeIntentState(name: string, issue: number): ResumeIntentState {
    const running = this.readJson(this.path(name, "running.json"));
    if (
      running?.resume_pending_db !== true ||
      running.name !== name ||
      running.issue !== issue ||
      typeof running.session_id !== "string" ||
      !running.session_id
    )
      return "none";
    if (running.spawn_confirmed === true) return "confirmed";
    return running.spawn_confirmed === false ? "unconfirmed" : "none";
  }

  /**
   * #46: resume a lane the wrapper handed off (`.handoff` sentinel) via `claude --resume`,
   * reusing the ORIGINAL session id (no --fork-session) so claude continues the same
   * conversation — the "M4 --resume" PLAN.md/#41 flagged. Fail-closed: absent a narrowly
   * recognized interrupted-resume `.running` sentinel, throws if `name` has no `.handoff`
   * sentinel or it carries no session_id. The jsonl is APPENDED, not truncated: the pre-handoff stream stays as an audit
   * trail, and parseCostUsd/parseModelUsage take the LAST "result" line. Live verification for
   * #172 established that resumed total_cost_usd is PER-LEG, so the conductor records it
   * directly; tick()'s RESUME phase is this method's production caller.
   */
  /** #245: resume()'s own forge MCP proxy attachment — mirrors dispatch()'s #244 mint-before-
   *  argv / --allowedTools widening / --mcp-config injection / teardown-on-every-exit-path
   *  treatment (see WorkerProxyOpts' doc for the shared fail-closed rationale). This is the
   *  fix-loop worker leg's evidence channel: a resumed leg (the SAME worker row/worktree/branch/
   *  session — never a new dispatch, #245's squash-branch-reuse hazard) pulls its own PR review
   *  findings via the PR-facing proxy tools rather than having them injected into the prompt (no
   *  prompt-injection transport, #245 AC). `opts.prompt`, when supplied, REPLACES the ordinary
   *  issue-rendered prompt with the caller's own (the fix leg's fix instruction) — every other
   *  caller (today's entire #172 handoff-resume path) omits both new opts and keeps deriving the
   *  prompt from `renderPrompt(issue)` exactly as before, byte-identical to pre-#245 behavior.
   *
   *  FAIL-CLOSED POLICY, identical to dispatch()'s: a proxy WITHOUT `credentialFree` is
   *  non-fatal on mint failure — the leg still resumes, unattached. `credentialFree: true` is
   *  different: a resumed leg dispatched that way has neither the gh/git credentialed-tool path
   *  nor (if mint fails) a working evidence channel, so a failed mint REFUSES the resume outright
   *  — a fix leg must never run silently unable to see the findings it exists to address. The
   *  pre-existing `.handoff` sentinel and the lane's prior jsonl are left INTACT on this path
   *  (unlike dispatch()'s fresh-jsonl cleanup): this is a RESUME, not a first dispatch — the
   *  jsonl already holds real prior-leg history, and a refused resume must leave the lane exactly
   *  as resumable as it was before this call, not destroy its record.
   *
   *  #245 round-2 fix (A1): `opts.sessionId` is FIX-LEG ENTRY MODE — starting a fix leg from a
   *  `driving` lane, which has NO `.handoff` sentinel at all (its prior leg's terminal signal was
   *  `.done`/`.failed`, already consumed by RECLAIM's own rescue-to-`driving` transition). The
   *  ordinary #172 handoff path (reading session_id off `.handoff.json`) cannot apply here — the
   *  caller (conductor.ts's `startFixLeg`) supplies the session id straight from the durable DB
   *  row instead. Requires `opts.prompt` too (a caller bug otherwise — a fix leg always carries
   *  its own fix instruction) and requires a `.done`/`.failed` terminal sentinel to exist (the
   *  same "prove a real prior leg actually terminated" invariant the ordinary path enforces via
   *  `.handoff`'s existence) — fail-closed, never silently starts a fix leg with no prior-leg
   *  evidence at all. */
  async resume(
    issue: Issue,
    name: string,
    opts?: { proxy?: WorkerProxyOpts; prompt?: string; sessionId?: string },
  ): Promise<{ name: string; sessionId: string }> {
    const handoffPath = this.path(name, "handoff.json");
    const runningPath = this.path(name, "running.json");
    const running = this.readJson(runningPath);
    const runningSessionId = typeof running?.session_id === "string" ? running.session_id : null;
    const matchingResumeIntent =
      running?.resume_pending_db === true && running.name === name && running.issue === issue.number && runningSessionId;
    // #172 resume crash matrix (bounded to this marker protocol; broader adoption is #169):
    //   before intent write                         -> .handoff intact, safe retry
    //   after intent, before/while spawn confirmation -> unconfirmed after restart, human
    //   confirmed spawn, before .handoff removal    -> adopt and finish removal
    //   after .handoff removal, before DB persist   -> adopt
    //   confirmed spawn error                       -> intent removed, .handoff intact, safe retry
    // `spawn_confirmed` is the boundary: only resume()'s confirmed marker proves a child was
    // started. A dispatch-authored running marker must never masquerade as resume evidence. This
    // check is entry-mode-agnostic — it's about THIS resume() call's own durable spawn-intent
    // marker, not about which sentinel authorized the call in the first place.
    if (matchingResumeIntent && running.spawn_confirmed === true) {
      this.removeIfExists(handoffPath);
      return { name, sessionId: runningSessionId };
    }
    if (matchingResumeIntent && running.spawn_confirmed === false) {
      if (!this.lanes.has(name)) throw new UnresumableLaneError(name, issue.number);
      throw new Error(`resume: ${name} already has an in-memory unconfirmed spawn`);
    }
    // #245 round-2 (A1): fix-leg entry (opts.sessionId set) vs. the ordinary #172 handoff-sentinel
    // path — mutually exclusive, resolved once here into a common (sessionId, dispatchedAt) pair
    // the rest of this method uses unchanged either way.
    let sessionId: string;
    let dispatchedAt: string | null;
    if (opts?.sessionId != null) {
      if (!opts.prompt) {
        throw new Error(`resume: ${name} — opts.sessionId (fix-leg entry) requires opts.prompt too`);
      }
      if (!existsSync(this.path(name, "done.json")) && !existsSync(this.path(name, "failed.json"))) {
        throw new Error(`resume: ${name} has no done/failed terminal sentinel — nothing to fix`);
      }
      sessionId = opts.sessionId;
      dispatchedAt = this.dispatchedAtIso(name);
    } else {
      if (!existsSync(handoffPath)) {
        throw new Error(`resume: ${name} has no .handoff sentinel — nothing to resume`);
      }
      const handoff = this.readJson(handoffPath);
      const handoffSessionId = typeof handoff?.session_id === "string" ? handoff.session_id : null;
      if (!handoffSessionId) {
        throw new Error(`resume: ${name}'s handoff sentinel carries no session_id`);
      }
      sessionId = handoffSessionId;
      // #69 (fable P1): carry the IMMUTABLE first-dispatch time across the handoff -> resume
      // boundary. The retention baseline must stay the original dispatch time so pre-handoff WIP
      // (older than this resumed run's start) is still judged possibly-dirty. Absent on a legacy
      // sentinel -> null below -> the baseline resolves to NaN -> fail-safe dirty (retain).
      dispatchedAt = typeof handoff?.dispatched_at === "string" ? handoff.dispatched_at : null;
    }
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `resuming; refusing to resume an unguarded worker in hard mode`,
      );
    }
    const prompt = opts?.prompt ?? (this.deps.renderPrompt ?? defaultPrompt)(issue);
    const jsonlPath = this.path(name, "jsonl");
    // #33 (gate② P1): snapshot the pre-handoff stream's estimated total ONCE, before the
    // resumed run appends anything, so checkSoftBudget can compare only THIS RUN's new spend
    // against worker.budgetUsdSoft. Without this, a lane that handed off AT the budget would
    // re-cross it on the first heartbeat tick after resume — an unresumable handoff loop.
    // This is estimator-only: terminal total_cost_usd itself is reported per leg (#172).
    const priorJsonl = this.readJsonl(jsonlPath);
    const estimateBaselineUsd = parseAssistantUsageDeltas(priorJsonl).reduce((sum, d) => sum + estimateUsd(d, this.pricing), 0);
    const jsonlLegOffset = Buffer.byteLength(priorJsonl);
    const jsonlFd = openSync(jsonlPath, "a"); // append: preserve the pre-handoff stream
    const ghConfigDir = this.path(name, "gh-config-empty");
    // #245 round-2 (A4): mint / mkdir(GH_CONFIG_DIR) / claudeArgs / the durable intent-write below
    // are ALL "post-mint, pre-lane-registration" — a failure ANYWHERE in this block (not just the
    // intent-write) must tear down an already-minted proxy and remove an already-created
    // GH_CONFIG_DIR scratch directory. One try/catch replaces three separate ad-hoc cleanups
    // (the mint-failure branch's own throw, a possible mkdirSync failure, and the intent-write's
    // own failure) with a single guard covering all of them uniformly.
    let proxyHandle: ForgeProxyHandle | undefined;
    let args: string[];
    let startedMs: number;
    let runningMarker: Record<string, unknown>;
    try {
      // #245: mint BEFORE argv — same ordering as dispatch() (WorkerProxyOpts' doc): the handle's
      // tool names / --mcp-config are needed before claudeArgs runs.
      if (opts?.proxy) {
        try {
          proxyHandle = await opts.proxy.mint({ role: "worker", session: name });
        } catch (e) {
          const reason = sanitizeUpstreamError(e instanceof Error ? e.message : String(e));
          this.recordProxyMintFailed(name, reason);
          if (opts.proxy.credentialFree) {
            // NB (unlike dispatch()'s fresh-jsonl cleanup): the jsonl/terminal sentinel here
            // PRE-EXIST this resume attempt (real prior-leg history) — never removed by the
            // catch below. A refused resume leaves the lane exactly as resumable as it was
            // before this call.
            throw new Error(
              `resume refused for lane ${name}: credentialFree was requested but the forge proxy mint failed — ` +
                `a fix leg with neither the gh/git credentialed-tool path nor a working evidence channel must not run: ${reason}`,
            );
          }
          this.log(`[sapwood:forge-proxy] lane ${name}: mint failed (non-fatal, proxy unattached): ${reason}`);
        }
      }
      // #245: same fresh/empty per-lane GH_CONFIG_DIR scratch directory dispatch() creates —
      // created regardless of whether credentialFree ends up true (cheap; lifecycle tied to this
      // lane's own stateDir). Only actually pointed at by the spawn env when credentialFree is set.
      if (opts?.proxy?.credentialFree) mkdirSync(ghConfigDir, { recursive: true });
      const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
      args = claudeArgs({
        prompt,
        model: this.deps.cfg.worker.model,
        effort: this.deps.cfg.worker.effort,
        fallbackModel: this.deps.cfg.worker.fallbackModel,
        worktree: name,
        name,
        sessionId,
        resumeSessionId: sessionId,
        settings: settingsJson,
        // #245: widen --allowedTools with the proxy's own tool names — same pattern as dispatch().
        // Unattached resume (today's entire #172 handoff path) passes neither flag, byte-identical
        // to pre-#245 behavior.
        ...(proxyHandle
          ? {
              allowedTools: [
                opts?.proxy?.credentialFree ? WORKER_ALLOWED_TOOLS_NO_GH : WORKER_ALLOWED_TOOLS,
                ...proxyHandle.toolNames,
              ].join(","),
            }
          : {}),
        ...(proxyHandle ? { mcpConfig: proxyHandle.mcpConfigJson } : {}),
        // #617 (seam 1, capability DR #616): same seal as dispatch() — see that call site's own
        // doc for the full rationale (additive vs. exclusive --mcp-config, the #616 live-probe
        // evidence, the credentialFree-implies-proxyHandle invariant here too since a
        // credentialFree mint failure REFUSES the resume above, before this call).
        ...(opts?.proxy?.credentialFree ? { strictMcpConfig: true } : {}),
      });
      startedMs = this.now().getTime();
      runningMarker = {
        name,
        issue: issue.number,
        session_id: sessionId,
        started_at: new Date(startedMs).toISOString(),
        estimate_baseline_usd: estimateBaselineUsd,
        jsonl_leg_offset: jsonlLegOffset,
        resume_pending_db: true,
        spawn_confirmed: false,
        // Preserve the original first-dispatch baseline (not this resume's start).
        ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
      };
      // Intent precedes spawn: after this durable point, a restart never guesses whether it is
      // safe to create another process in the same worktree/session.
      this.writeJsonAtomic(runningPath, runningMarker);
    } catch (e) {
      try {
        closeSync(jsonlFd);
      } catch {
        /* noop */
      }
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch (te) {
          this.log(
            `[sapwood:forge-proxy] lane ${name}: teardown failed after resume pre-spawn error (non-fatal): ${sanitizeUpstreamError(te instanceof Error ? te.message : String(te))}`,
          );
        }
      }
      this.removeGhConfigDir(opts?.proxy?.credentialFree ? ghConfigDir : undefined, name);
      throw e;
    }
    let child: ChildProcess;
    // #245: baseEnv is credential-stripped (workerCredentialFreeEnv) ONLY when
    // opts.proxy.credentialFree is explicitly set — every other resume() caller keeps inheriting
    // process.env verbatim, unchanged from pre-#245 behavior.
    const baseEnv = opts?.proxy?.credentialFree ? workerCredentialFreeEnv(ghConfigDir) : process.env;
    try {
      // SAPWOOD_WORKTREE_ROOT (#235 PR-A): same lane/worktree as the original dispatch — a
      // resumed leg must keep Read/Grep/Glob confined too, not just the fresh-dispatch path.
      child = spawn(this.bin, args, {
        detached: true,
        stdio: ["ignore", jsonlFd, jsonlFd],
        env: { ...baseEnv, SAPWOOD_GUARD_MODE: guardMode, SAPWOOD_WORKTREE_ROOT: resolve(this.worktreeRoot, name) },
      });
    } catch (e) {
      closeSync(jsonlFd);
      this.removeIfExists(runningPath);
      // #245: tear down the proxy even though spawn itself failed — mirrors dispatch()'s own
      // spawn-failure branch (a thrown spawn must never leak a live listener/token).
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch (te) {
          this.log(
            `[sapwood:forge-proxy] lane ${name}: teardown failed after resume-spawn error (non-fatal): ${sanitizeUpstreamError(te instanceof Error ? te.message : String(te))}`,
          );
        }
      }
      this.removeGhConfigDir(opts?.proxy?.credentialFree ? ghConfigDir : undefined, name);
      throw new Error(`worker resume-spawn failed (${this.bin}): ${String(e)}`);
    }
    const lane: Lane = {
      child,
      issue: issue.number,
      sessionId,
      jsonlFd,
      jsonlPath,
      hb: undefined,
      handoffRequested: false,
      reclaiming: false,
      startedMs,
      timedOut: false,
      estimatedCostUsd: 0,
      estimateBaselineUsd,
      jsonlLegOffset,
      prompt,
      ...(proxyHandle ? { proxyHandle } : {}),
      ...(opts?.proxy?.credentialFree ? { ghConfigDir } : {}),
    };
    this.lanes.set(name, lane);
    child.on("exit", (code) => this.onExit(name, code));

    // #395: bounded — same rationale as dispatch()'s own spawn-confirmation await (Node gives
    // this confirmation no timeout of its own, and the live incident was exactly this class of
    // await never resolving). The on-success write (spawn_confirmed/wrapper_pid) is preserved
    // exactly as before: a write failure there is still routed through onError (killTree first,
    // then reported), never silently dropped.
    const spawnConfirm = await awaitSpawnConfirmation(
      (onSpawn, onError, isSettled) => {
        child.once("spawn", () => {
          // #395 (gate② P2-2): a merely-DELAYED (not lost) real 'spawn' racing the timeout must
          // not perform its side effect once the outer race has already settled on "timed out"
          // — the failure path below may already have killed this child, removed `runningPath`,
          // and thrown; writing a fresh spawn_confirmed:true/wrapper_pid marker here would
          // resurrect exactly the marker the adoption/RESUME_UNDECIDABLE machinery trusts, now
          // pointing at a dead pid. dispatch() and the peripheral site have no such side effect
          // in their own `onSpawn` — this guard is resume()-specific.
          if (isSettled()) return;
          try {
            this.writeJsonAtomic(runningPath, { ...runningMarker, spawn_confirmed: true, wrapper_pid: child.pid });
            onSpawn();
          } catch (e) {
            lane.reclaiming = true;
            void this.killTree(child).finally(() => onError(e));
          }
        });
        child.once("error", onError);
      },
      this.deps.cfg.liveness.spawnConfirmTimeoutMs,
      this.deps.sleep,
    );
    let spawnErr: unknown = spawnConfirm.err;
    if (spawnConfirm.timedOut) {
      spawnErr = new Error(
        `spawn confirmation timed out after ${this.deps.cfg.liveness.spawnConfirmTimeoutMs}ms ` +
          "(host sleep or a lost spawn notification) — killing the possibly-still-alive child",
      );
      // Best-effort: the child may actually be alive despite the lost notification.
      lane.reclaiming = true;
      await this.killTree(child);
    }
    if (spawnErr) {
      this.lanes.delete(name);
      try {
        closeSync(jsonlFd);
      } catch {
        /* noop */
      }
      this.removeIfExists(runningPath);
      // #245: same "never leak a minted proxy" stance as the synchronous spawn-failure branch
      // above — this is the OTHER spawn-failure path (an async 'error' event raced against
      // 'spawn'), and onExit is never reached for it (the lane is deleted from `this.lanes`
      // before any 'exit' event, if one even fires).
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch (te) {
          this.log(
            `[sapwood:forge-proxy] lane ${name}: teardown failed after resume-spawn error (non-fatal): ${sanitizeUpstreamError(te instanceof Error ? te.message : String(te))}`,
          );
        }
      }
      this.removeGhConfigDir(opts?.proxy?.credentialFree ? ghConfigDir : undefined, name);
      throw new Error(`worker resume-spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    child.on("error", () => this.onExit(name, 1));
    // `.handoff` may disappear only after the confirmed marker is durable. Adoption completes
    // this same removal if the engine crashes between these two writes.
    this.removeIfExists(handoffPath);
    // #245 round-2 fix (B1): fix-leg entry consumes the STALE prior-leg terminal sentinel the
    // SAME way — only now that THIS leg's spawn is confirmed durable, never before a failed
    // spawn attempt (which must leave it in place so the next retry's entry check — "a
    // done/failed sentinel must exist" — still passes). Without this, probe() would keep
    // reading the PRIOR leg's done/failed sentinel as if it were THIS live leg's own terminal
    // signal, letting FIXING RECLAIM settle a still-running fix child to `driving`/`failed` out
    // from under it. `reconcileDrivingFixIntents` (conductor.ts) repeats this same removal for
    // the crash window between this line and its own upsert — see that function's doc.
    if (opts?.sessionId != null) {
      this.removeIfExists(this.path(name, "done.json"));
      this.removeIfExists(this.path(name, "failed.json"));
    }
    if (this.lanes.has(name) && child.exitCode === null && child.signalCode === null) {
      this.touchHeartbeat(name);
      lane.hb = setInterval(() => this.heartbeatTick(name), this.hbMs);
      // #617 (seam 3): same fire-and-forget capture dispatch() kicks off, same promise-on-`lane`
      // handoff to onExit (see Lane.manifestPreSpawnPromise's own doc). A resumed lane's manifest
      // OVERWRITES the prior leg's under the same (lane-name-keyed) recordContextManifest row —
      // recordLaneContextManifest's own doc names this as the deliberate "most-recent-leg" scope,
      // not a full per-leg history.
      lane.manifestPreSpawnPromise = this.capturePreSpawnManifestForLane(name, jsonlPath, resolve(this.worktreeRoot, name));
    }
    return { name, sessionId };
  }

  /** Operator/drain-initiated graceful handoff: SIGTERM (not SIGKILL) so the worker wraps up
   *  the current step; onExit then writes the resumable .handoff sentinel. This is the live
   *  handoff path for M2 (the drain half of the kill-switch, PLAN.md) — AND (#33) the path
   *  checkSoftBudget() calls automatically when the live token-ESTIMATE crosses
   *  worker.budgetUsdSoft, since stream-json carries no in-progress REAL total_cost_usd
   *  (only the terminal result message has that). Both callers share this one method, so both
   *  get the same idempotent-per-lane guard below. */
  requestHandoff(name: string): boolean {
    const lane = this.lanes.get(name);
    if (lane) {
      if (lane.reclaiming || lane.handoffRequested) return false;
      lane.handoffRequested = true;
      this.killGroup(lane.child, "SIGTERM");
      return true;
    }
    // Cross-process / post-restart: a persisted `running` lane with no in-memory handle (the
    // engine restarted while the worker kept running). Without this fallback the #14 ceiling
    // drain would silently no-op on such lanes — no SIGTERM for the whole drain window, the
    // worker keeps spending, then gets hard-killed instead of the intended graceful handoff
    // (Codex PR #41 P1). Signal the persisted process group with SIGTERM only (graceful —
    // never the KILL escalation reclaim() adds). There's no attached onExit handler for this
    // path (no live ChildProcess), so the .handoff sentinel can't be triggered by a
    // process-exit callback the way the in-process branch above gets it for free — #63
    // instead confirms death (and writes .handoff) from INSIDE probe(), the next time it's
    // called for this lane; see finalizeDetachedHandoffIfConfirmedDead.
    if (this.detachedHandoffRequested.has(name) || this.detachedReclaiming.has(name)) return false;
    const runningPath = this.path(name, "running.json");
    const running = this.readJson(runningPath);
    const pid = this.persistedPid(name);
    if (pid == null || this.wrapperAlive(name) !== 1) return false;
    this.detachedHandoffRequested.add(name);
    if (running?.handoff_requested === true) {
      // #169: re-signal once per restarted engine to close the write-before-signal crash
      // window (the flag was persisted, but SIGTERM may never have been sent). Return false
      // because the flag dedups only the lane-adopted event. Accepted blind spot: a crash after
      // SIGTERM but before appendEvent permanently loses that honesty event; fixing that tiny
      // window needs new conductor-side event-log dedup machinery.
      this.signalGroup(pid, "SIGTERM");
      return false;
    }
    // #63: persist the request onto running.json itself (not just this process's in-memory
    // set) so a SECOND engine restart — before probe() ever confirms the pid is dead — doesn't
    // forget the request. The in-memory set alone only survives one restart (it's how THIS
    // instance learned to send the SIGTERM below); a fresh instance after another restart has
    // an empty set but can still read this field back off disk.
    //
    // Ordering matters (Codex second-opinion review, PR #67 P2): this write happens BEFORE the
    // SIGTERM, not after. If the engine died in the gap between "signal sent" and "flag
    // persisted", the durable record would never land — the exact restart this field exists to
    // survive could be the one that kills the write. Persisting first closes that gap: by the
    // time the signal (and whatever it triggers) is in flight, the durable record already
    // exists, best-effort though it is.
    //
    // Still best-effort, NEVER throws: requestHandoff is documented on the Supervisor interface
    // as never throwing, and it's called unguarded from the conductor's CEILING drain loop — a
    // write failure here (ENOSPC/EACCES/EROFS/...) must not abort a kill-switch/ceiling drain
    // mid-tick, and must not block the SIGTERM that follows regardless of whether the persist
    // succeeded. The in-memory set above already covers this process's lifetime regardless; the
    // persisted field is purely an enhancement for surviving a second restart.
    try {
      if (running) this.writeJsonAtomic(runningPath, { ...running, handoff_requested: true });
    } catch (e) {
      this.log(`[sapwood:worker] lane ${name}: failed to persist handoff_requested (non-fatal — SIGTERM still sent): ${String(e)}`);
    }
    this.signalGroup(pid, "SIGTERM");
    return true;
  }

  /** Outer liveness heartbeat (mtime), independent of the model self-reporting, plus the
   *  wall-clock timeout ceiling and (#33) the live soft-budget check. */
  private heartbeatTick(name: string): void {
    const lane = this.lanes.get(name);
    if (!lane || lane.reclaiming) return;
    // Wall-clock timeout: a hung/overlong claude must not hold a lane forever (without this,
    // a fresh heartbeat + live pid make classifyLane return KEEP indefinitely — Codex R2 P1;
    // 0day wrapped claude in run_timeout). Past timeoutSec: stop refreshing AND kill the tree
    // -> onExit writes .failed -> the conductor reclaims the lane.
    const elapsedSec = (this.now().getTime() - lane.startedMs) / 1000;
    if (!lane.timedOut && elapsedSec > this.deps.cfg.worker.timeoutSec) {
      lane.timedOut = true;
      if (lane.hb) clearInterval(lane.hb);
      void this.killTree(lane.child);
      return;
    }
    // #395 (gate② round 3, P1): this heartbeat must PROVE liveness, not just that its own timer
    // fired — same rationale as peripheral.ts's RoleRunner heartbeat (see its own comment for
    // the full reasoning): an unconditional append kept masking the liveness watchdog until
    // worker.timeoutSec for a post-spawn wedge where the child itself had already died with its
    // exit notification lost. `isAlive` probes `lane.child.pid` directly (`process.kill(pid,
    // 0)`) — deliberately not a progress-content check, so a legitimately quiet-but-working leg
    // keeps heart-beating. createHeartbeatGate also folds in the P2-2 spam fix (skip when
    // something else already advanced state.maxEventId() this cadence). Optional
    // (WorkerDeps.state, already used for proxy-mint-failed) — omitted means zero behavior
    // change, same as before.
    if (this.deps.state) {
      let gate = this.heartbeatGates.get(name);
      if (!gate) {
        gate = createHeartbeatGate(this.deps.state, () => {
          const pid = lane.child.pid;
          if (pid == null) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        this.heartbeatGates.set(name, gate);
      }
      gate.tick("worker-heartbeat", { worker: name, issue: lane.issue, elapsedSec: Math.round(elapsedSec) });
    }
    this.touchHeartbeat(name);
    this.checkSoftBudget(name, lane);
  }

  /** #155: the LIVE per-probe telemetry trio — persisted (by conductor.ts, via
   *  State.setLiveTelemetry) while a lane is still `running`, cleared at reclaim. Computed
   *  fresh from the lane's jsonl-so-far on every call — the same re-parse-every-tick trade-off
   *  checkSoftBudget's own comment documents (a per-worker jsonl is small; correctness-by-
   *  re-derivation beats byte-offset bookkeeping), and no new computation path: this is the
   *  SAME #33 pricing pipeline checkSoftBudget already used, just packaged for persistence too.
   *
   *  `estCostUsd` — the priced-cost snapshot — reuses the EXACT #33 baseline-subtraction
   *  checkSoftBudget uses (never a second baseline mechanism, CTO decision on #155): the
   *  whole-jsonl priced total minus `lane.estimateBaselineUsd`, so a RESUMED lane's persisted
   *  snapshot covers only the current leg, consistent with the soft-budget accounting it shares
   *  this computation with. It settles into the real number spend_ledger holds once the lane
   *  terminates (recordSpend); this method never itself feeds accounting.
   *
   *  `contextTokens` / `tokenComposition` are read straight off the full jsonl-so-far — no
   *  baseline subtraction, because resume() APPENDS (never truncates), so they naturally cover
   *  the whole session, and neither has a comparable "per-run budget" concept to baseline
   *  against. `contextTokens` is deliberately NON-monotonic (the newest assistant message's
   *  input + cache-read + cache-creation tokens only — a drop marks an auto-compact, itself
   *  display-worthy, never smoothed into a running max). `tokenComposition` is the cumulative
   *  4-class split across every streamed assistant message so far. */
  private liveTelemetry(lane: Lane): { estCostUsd: number; contextTokens: number; tokenComposition: CategorizedTokenUsage } {
    const deltas = parseAssistantUsageDeltas(this.readJsonl(lane.jsonlPath));
    const wholeFileUsd = deltas.reduce((sum, d) => sum + estimateUsd(d, this.pricing), 0);
    const estCostUsd = Math.max(0, wholeFileUsd - lane.estimateBaselineUsd);
    const last = deltas[deltas.length - 1];
    const contextTokens = last ? last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens : 0;
    const tokenComposition = deltas.reduce<CategorizedTokenUsage>(
      (acc, d) => ({
        inputTokens: acc.inputTokens + d.inputTokens,
        outputTokens: acc.outputTokens + d.outputTokens,
        cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );
    return { estCostUsd, contextTokens, tokenComposition };
  }

  /** #33: soft per-worker budget auto-enforcement via LIVE token estimation. stream-json never
   *  carries an in-progress `total_cost_usd` (only the terminal `result` line has it), so this
   *  re-derives a running USD estimate from every streamed `assistant` message's token usage
   *  (parseAssistantUsageDeltas), priced by the small rate table in pricing.ts — cache reads are
   *  priced at the cache-READ rate there, not the input rate, specifically so a cache-heavy run
   *  does not look artificially expensive and hand off prematurely (the failure mode the issue
   *  flags). Crossing `worker.budgetUsdSoft` triggers the SAME graceful requestHandoff() path
   *  the operator/drain uses: SIGTERM -> `.handoff` sentinel, resumable. NEVER a hard kill,
   *  NEVER a fabricated result line (CLAUDE.md non-negotiable).
   *
   *  Re-parsing the whole jsonl-so-far every tick (rather than tracking a byte offset) is
   *  deliberate: a per-worker jsonl is small relative to a heartbeat interval's cost, and it
   *  keeps this correct-by-construction (no partial-line/byte-offset bookkeeping to get wrong)
   *  at the price of doing a bit of redundant re-parsing — the same trade-off terminalCostUsd's
   *  jsonl fallback already makes. Guarded by `handoffRequested` so a lane already draining
   *  neither re-parses nor re-fires (requestHandoff() is idempotent regardless, but skipping the
   *  parse here is pure waste avoidance once the outcome is already decided). */
  private checkSoftBudget(name: string, lane: Lane): void {
    if (lane.handoffRequested) return;
    // #155: shares its computation with liveTelemetry() (the per-probe persistence path) so the
    // soft-budget figure and the persisted priced-cost snapshot can never drift apart — see
    // liveTelemetry's comment for the PER-RUN (baseline-subtracted) rationale.
    lane.estimatedCostUsd = this.liveTelemetry(lane).estCostUsd;
    if (lane.estimatedCostUsd >= this.deps.cfg.worker.budgetUsdSoft) {
      this.log(
        `[sapwood:worker] lane ${name}: estimated spend $${lane.estimatedCostUsd.toFixed(4)} this run ` +
          `crossed the soft budget $${this.deps.cfg.worker.budgetUsdSoft} — requesting graceful handoff`,
      );
      this.requestHandoff(name);
    }
  }

  private onExit(name: string, code: number | null): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    clearInterval(lane.hb);
    // #244: revoke + tear down the proxy in EVERY outcome this lane's process can exit through
    // (done/failed/timeout/reclaimed) — mirrors peripheral.ts's RoleRunner teardown stance,
    // adapted to WorkerSupervisor's long-lived-lane shape (this is the ONE place a lane's real
    // process actually terminates). Fire-and-forget: onExit is a synchronous event handler, and
    // a slow/failed teardown must never delay or fail the lane's own terminal-sentinel write.
    if (lane.proxyHandle) {
      lane.proxyHandle
        .stop()
        .catch((e) =>
          this.log(
            `[sapwood:forge-proxy] lane ${name}: teardown failed (non-fatal): ${sanitizeUpstreamError(e instanceof Error ? e.message : String(e))}`,
          ),
        );
    }
    // #244 (Codex sol-high PR #260 review round 2, P2): same cleanup as the spawn-failure path —
    // a no-op unless this lane actually got a credentialFree GH_CONFIG_DIR.
    this.removeGhConfigDir(lane.ghConfigDir, name);
    try {
      closeSync(lane.jsonlFd);
    } catch {
      /* already closed */
    }
    // reclaim() owns the lane's terminal state — don't also write a sentinel.
    if (!lane.reclaiming) {
      // #60/#69: the real `claude` CLI has no SIGTERM trap — a handoff-requested process dies
      // by signal (code null) or a non-zero exit, NEVER code 0. So "code === 0 after SIGTERM"
      // is unreachable in practice, and .handoff could never be earned by exit-code-gated logic
      // (Codex R3 P2's original concern was false-positive resumability; empirically the
      // failure mode is the opposite — a real, already-resumable lane getting tagged .failed).
      // #69 drain contract: the supervisor never touches the worktree at all — no commit, no
      // push, nothing. It's left exactly as the worker last left it. Resumability comes
      // entirely from `claude --resume <session_id>` reusing that worktree in place (see
      // resume() above); a handoff-requested lane is tagged .handoff regardless of how it
      // died or what state its worktree is in. timedOut is always .failed — a wall-clock
      // timeout is a distinct, non-drain-requested hard kill.
      const tag = lane.timedOut ? "failed" : lane.handoffRequested ? "handoff" : code === 0 ? "done" : "failed";
      this.writeTerminalSentinel(
        name,
        lane.issue,
        lane.sessionId,
        lane.jsonlPath,
        tag,
        code,
        lane.estimateBaselineUsd,
        lane.jsonlLegOffset,
      );
    }
    // #617 (seam 3): the SAME "one place a lane truly terminates" property this method's own doc
    // already leans on for proxy teardown/GH_CONFIG_DIR cleanup above — schedule the context
    // manifest recording here too, regardless of `lane.reclaiming` (the process really did exit
    // either way; only the SENTINEL write above is reclaim()'s to own, not manifest bookkeeping).
    // Captures `jsonlPath`/`prompt` in closure BEFORE the lane is deleted below — the chained
    // `.then()` runs whenever the in-flight pre-spawn capture settles, which may be AFTER this
    // synchronous method returns (see scheduleContextManifestRecording's own doc for why this
    // can't simply read a value off `lane` here).
    this.scheduleContextManifestRecording(name, lane.jsonlPath, lane.prompt, lane.manifestPreSpawnPromise);
    this.lanes.delete(name);
    // #395 (gate② round 3): drop this lane's heartbeat gate along with the lane itself — onExit
    // is the one place a lane truly terminates (this method's own doc), so this is the one
    // place its cursor ever needs clearing; never left to grow unboundedly over a long-running
    // engine process's lifetime.
    this.heartbeatGates.delete(name);
  }

  /** #617 (seam 3, capability DR #616): the FILESYSTEM-derived half of a worker/producer leg's
   *  context manifest, captured fire-and-forget right after a confirmed spawn (dispatch()/
   *  resume() both assign the returned promise onto `lane.manifestPreSpawnPromise`, never
   *  awaited inline — a worker lane's caller has never awaited session completion, or even
   *  session init, and blocking either method here would be a far bigger behavior change than a
   *  diagnostic manifest justifies). Same anchor peripheral.ts's RoleRunner already uses for its
   *  9 peripheral call sites (the session's OWN init line, polled from its still-growing jsonl
   *  via worker.ts's own waitForInitLine) and for the SAME reason (#236: a worktree-directory-
   *  existence poll races checkout; a write-capable session — every worker leg is one, unlike
   *  most peripheral roles — could otherwise have its CLAUDE.md-family sources captured AFTER
   *  its own edits landed, recording "what it left behind" instead of "what it saw").
   *
   *  Returns `undefined` (never throws) on any failure — the caller (scheduleContextManifestRecording)
   *  treats that as "nothing to record", the same as a lane that never reached the confirmed-alive
   *  gate at all. */
  private async capturePreSpawnManifestForLane(
    name: string,
    jsonlPath: string,
    worktreePath: string,
  ): Promise<PreSpawnManifestCapture | undefined> {
    try {
      const initObserved = await waitForInitLine(jsonlPath, this.preSpawnCaptureTimeoutMs, this.preSpawnCapturePollMs);
      const captureBasis: PreSpawnManifestCapture["captureBasis"] = initObserved ? "init-observed" : "timeout-fallback";
      const worktreeAppeared = existsSync(worktreePath);
      const head = worktreeAppeared ? resolveWorktreeHead(join(worktreePath, ".git")) : null;
      return capturePreSpawnManifestData(worktreePath, worktreeAppeared, captureBasis, head, this.guardHookPath, this.now().toISOString());
    } catch (e) {
      this.log(`[sapwood:context-manifest] lane ${name}: pre-spawn capture failed (non-fatal): ${String(e)}`);
      return undefined;
    }
  }

  /** #617 (seam 3): chains onto a lane's in-flight pre-spawn capture (started at dispatch()/
   *  resume() time) and records the resulting ContextManifest once it settles — called from
   *  onExit(), the ONE place a lane truly terminates, but deliberately NOT synchronous with it:
   *  a fast-exiting lane's 'exit' event can fire before capturePreSpawnManifestForLane's
   *  init-line poll has even completed its first tick, so reading a value off `lane` (already
   *  deleted from `this.lanes` by the time the poll would resolve) synchronously inside onExit
   *  would silently drop the manifest for exactly the sessions whose ambient-context drift
   *  matters most to catch (a crash-fast worker leg). Fire-and-forget from onExit's own
   *  perspective — onExit stays synchronous; this method's own promise chain resolves whenever
   *  it resolves, independent of the lane's continued presence in `this.lanes`. `jsonlPath`/
   *  `prompt` are passed explicitly (captured by the caller BEFORE lane deletion) rather than
   *  re-read off a `Lane` object this method never assumes still exists. */
  private scheduleContextManifestRecording(
    name: string,
    jsonlPath: string,
    prompt: string,
    preSpawnPromise: Promise<PreSpawnManifestCapture | undefined> | undefined,
  ): void {
    if (!preSpawnPromise) return; // lane never reached the confirmed-alive gate — capture never started
    preSpawnPromise
      .then((pre) => this.recordLaneContextManifest(name, jsonlPath, prompt, pre))
      .catch((e) => this.log(`[sapwood:context-manifest] lane ${name}: pre-spawn capture promise rejected (non-fatal): ${String(e)}`));
  }

  /** #617 (seam 3): record a ContextManifest fingerprint for this producer leg — the SAME
   *  assembleContextManifest shape peripheral.ts's RoleRunner already uses for its 9 peripheral
   *  call sites, extended here rather than reimplemented (this repo's "one scanner, not a second
   *  one" doctrine, #410's scanEgressSuspects precedent). Best-effort: a manifest is diagnostic,
   *  never load-bearing, so any failure here (a state-write failure) is logged and swallowed.
   *  Skipped entirely when `WorkerDeps.state` (or its `recordContextManifest`) was never
   *  supplied — the SAME optional-dependency contract `WorkerDeps.state`'s own doc already
   *  establishes — or when `pre` is undefined (the pre-spawn capture never completed or itself
   *  failed; see capturePreSpawnManifestForLane's own doc).
   *
   *  KEY (ForgeProxyIdentity precedent, state.ts's own doc): `roundId: 0, phase: "worker"` — a
   *  worker lane has no round concept WorkerSupervisor itself is threaded with, same sentinel
   *  reasoning ForgeProxyIdentity's tick-driver mint already uses (`roundId: 0, phase: "tick"`).
   *  `session` is the lane name; `attempt` is always `1` — the lane name already disambiguates a
   *  fresh dispatch from a later resume of the SAME lane, and `recordContextManifest`'s own
   *  UNIQUE-upsert contract (schema v13->v14) means a resume's manifest simply OVERWRITES the
   *  prior leg's under the identical key, so this row always reflects the MOST RECENT leg's
   *  fingerprint — a deliberate scope narrowing (one row per lane, not a full per-leg history),
   *  not an oversight. `dirtyBasis` is always `"unknown-write-capable-session"` (or
   *  `"worktree-missing"`) — never `"structural-no-write-tools"` — because every worker leg's
   *  `--allowedTools` grant (WORKER_ALLOWED_TOOLS or its NO_GH variant) always carries `Write`/
   *  `Edit`/`Bash(...)`, unlike most peripheral roles: the "no write-capable tool" case this
   *  engine's dirty-derivation enum also carries structurally cannot apply to a worker lane. */
  private recordLaneContextManifest(name: string, jsonlPath: string, prompt: string, pre: PreSpawnManifestCapture | undefined): void {
    if (!this.deps.state?.recordContextManifest) return;
    if (!pre) return;
    try {
      const jsonl = this.readJsonl(jsonlPath);
      const init = parseSessionInit(jsonl);
      const worktreePath = join(this.worktreeRoot, name);
      const { toolUsage, readPaths } = parseToolUsage(jsonl, worktreePath);
      const capturedPostExit = this.now().toISOString();
      const manifest = assembleContextManifest({
        sources: pre.sources,
        probedPaths: pre.probedPaths,
        knownUnprobed: KNOWN_UNPROBED_NOTE,
        capturedPreSpawn: pre.capturedAt,
        capturedPostExit,
        captureBasis: pre.captureBasis,
        model: init.model ?? this.deps.cfg.worker.model,
        modelSource: init.model ? "session-init" : "requested-fallback",
        cliBin: this.bin,
        cliVersion: init.cliVersion,
        toolInventoryTools: init.tools,
        promptTemplateSource: prompt,
        // #616 probe nuance: MCP tools arrive DEFERRED — a session's init `tools` array reports
        // ZERO mcp__-prefixed entries even with 10 ambient servers actually loaded (schemas load
        // async, after init). Reading `init.mcpServers` (the init report's SEPARATE `mcp_servers`
        // field, name+status per server) is the actual "loaded/available surface" the manifest
        // needs — NOT a naive `init.tools.filter(t => t.startsWith("mcp__"))`, which would always
        // read empty for a worker leg and silently misrecord "no MCP tools". Same field
        // peripheral.ts's assembleManifest already reads for the identical reason.
        mcpTools: init.mcpServers.map((s) => `${s.name}:${s.status}`),
        worktree: !pre.worktreeAppeared
          ? { path: worktreePath, head: null, headResolution: "unresolved", dirty: true, dirtyBasis: "worktree-missing" }
          : {
              path: worktreePath,
              head: pre.head,
              headResolution: pre.head ? "resolved" : "unresolved",
              dirty: true,
              dirtyBasis: "unknown-write-capable-session",
            },
        settingsJson: JSON.stringify(guardSettings(this.guardHookPath)),
        hookContent: pre.hookContent,
        toolUsage,
        readPaths,
        recordedAt: capturedPostExit,
      });
      const key: ContextManifestKey = { roundId: 0, phase: "worker", role: "worker", session: name, attempt: 1 };
      this.deps.state.recordContextManifest(key, JSON.stringify(manifest), capturedPostExit);
    } catch (e) {
      this.log(`[sapwood:context-manifest] lane ${name}: failed to assemble/record (non-fatal): ${String(e)}`);
    }
  }

  /** The ~10 lines every terminal-transition path (onExit here, and #63's detached-lane
   *  finalize below) needs: parse the jsonl for cost/model usage, write the tagged sentinel,
   *  clear the running marker. Extracted so the detached path — which has no live `Lane` (no
   *  ChildProcess, no lane.jsonlPath/issue/sessionId to read off an object) — can reuse the
   *  exact same write shape onExit's real exit callback uses, just fed its issue/sessionId
   *  from the persisted running.json instead. */
  private writeTerminalSentinel(
    name: string,
    issue: number,
    sessionId: string,
    jsonlPath: string,
    tag: "done" | "failed" | "handoff",
    exitCode: number | null,
    // The estimator total already present before this leg began. Persisted in running.json so
    // the detached finalize path can recover the same per-leg boundary after an engine restart.
    estimateBaselineUsd?: number,
    jsonlLegOffset?: number,
  ): void {
    const jsonl = this.readJsonl(jsonlPath);
    const running = this.readJson(this.path(name, "running.json"));
    const persistedBaseline =
      typeof running?.estimate_baseline_usd === "number" && Number.isFinite(running.estimate_baseline_usd)
        ? running.estimate_baseline_usd
        : 0;
    const baseline = estimateBaselineUsd ?? persistedBaseline;
    const persistedOffset =
      typeof running?.jsonl_leg_offset === "number" && Number.isSafeInteger(running.jsonl_leg_offset) && running.jsonl_leg_offset >= 0
        ? running.jsonl_leg_offset
        : 0;
    const legOffset = jsonlLegOffset ?? persistedOffset;
    const legJsonl = this.readJsonlFromByte(jsonlPath, legOffset);
    const estimatedLegCost = Math.max(
      0,
      parseAssistantUsageDeltas(jsonl).reduce((sum, d) => sum + estimateUsd(d, this.pricing), 0) - baseline,
    );
    const reportedCost = parseCostUsd(legJsonl);
    const cost = reportedCost > 0 ? reportedCost : estimatedLegCost;
    const modelUsage = parseModelUsage(legJsonl);
    // #33: reconcile the leg estimate against the REAL per-leg total_cost_usd and log the gap
    // — this is how the pricing.ts rate table's known drift (see its module doc) is made
    // visible instead of silent. A SIGTERM'd handoff commonly has no result line; in that shape
    // the same baseline-adjusted estimator becomes the recorded leg cost rather than silently
    // ledgering $0, and this explicit line records that provenance without a new schema field.
    if (reportedCost > 0) {
      const divergence = estimatedLegCost - reportedCost;
      this.log(
        `[sapwood:worker] lane ${name}: cost estimate $${estimatedLegCost.toFixed(4)} vs real ` +
          `total_cost_usd $${reportedCost.toFixed(4)} (estimate ${divergence >= 0 ? "+" : ""}${divergence.toFixed(4)})`,
      );
    } else {
      this.log(
        `[sapwood:worker] lane ${name}: total_cost_usd unavailable; recording estimated leg spend ` +
          `$${estimatedLegCost.toFixed(4)} (source=assistant-usage-estimate)`,
      );
    }
    // #69 (fable P1): carry the immutable first-dispatch baseline out of running.json (still
    // present here — removed only at the tail below) into the terminal sentinel, so resume()
    // and the terminal-lane dirty check (inspectWorktree) can recover it after running.json
    // is gone. Omitted when absent (legacy) -> the baseline resolves to NaN -> fail-safe dirty.
    const dispatchedAt = typeof running?.dispatched_at === "string" ? running.dispatched_at : null;
    const base = {
      name,
      issue,
      session_id: sessionId,
      total_cost_usd: cost,
      model_usage: modelUsage,
      ended_at: this.now().toISOString(),
      ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
    };
    this.writeJsonAtomic(this.path(name, `${tag}.json`), { ...base, exit_code: exitCode });
    this.recordEgressSuspects(name, issue, legJsonl);
    // A resumed child may terminate before the conductor persists DB=running. Keep its durable
    // adoption marker through that window; probe removes it after the terminal outcome is read
    // on the next ordinary running-lane reclaim tick.
    if (running?.resume_pending_db !== true) this.removeIfExists(this.path(name, "running.json"));
  }

  /** #63: the detached-lane counterpart to onExit's in-process finalize. A detached lane
   *  (persisted running.json, no in-memory Lane — the engine restarted while the worker kept
   *  running) has no live ChildProcess to attach an `exit` handler to, so requestHandoff's
   *  detached branch can only SIGTERM the persisted pid — nothing ever wrote .handoff for it,
   *  even once the worker actually died. This is the fix: check for
   *  CONFIRMED death (wrapperAlive() === 0 — a stale heartbeat is NOT a death signal for a
   *  detached lane; its heartbeat only ever advanced via the dead engine's own setInterval)
   *  every time probe() is called, and finalize right here if so.
   *
   *  Placement matters: this runs from INSIDE probe(), ahead of the sentinel reads below and
   *  ahead of the conductor's classifyLane call that follows probe() — never a separate poll
   *  loop. The conductor probes every running lane every tick before classifying it, so a
   *  poller racing that classification could lose: it might see wrapperAlive===0 with no
   *  sentinel yet and get DEAD-reclaimed (killByPid, no .handoff written) before a separate
   *  poller fires. Running the check inside probe() wins that race by construction — the write
   *  always lands before this same call's classification-feeding flags are read.
   *
   *  A request is "known" via EITHER the in-memory detachedHandoffRequested set (this
   *  process's own request) OR running.json's persisted `handoff_requested` field (a request
   *  survives a SECOND engine restart, which wipes the in-memory set but not the file) — either
   *  is sufficient. Skipped entirely for a lane this supervisor has already reclaim()'d
   *  (detachedReclaiming) — that lane is going FAILED, not resumable; see reclaim(). Never
   *  throws: writeTerminalSentinel is already best-effort/non-throwing (same guarantee onExit
   *  relies on). */
  private finalizeDetachedHandoffIfConfirmedDead(name: string): void {
    if (this.detachedReclaiming.has(name)) return;
    if (
      existsSync(this.path(name, "done.json")) ||
      existsSync(this.path(name, "failed.json")) ||
      existsSync(this.path(name, "handoff.json"))
    ) {
      return; // already terminal — nothing to finalize
    }
    const running = this.readJson(this.path(name, "running.json"));
    if (!running) return; // no persisted lane at all — nothing to finalize
    const requested = this.detachedHandoffRequested.has(name) || running.handoff_requested === true;
    if (!requested) return;
    // wrapperAlive: 1 alive (still draining — wait) | -1 unknown/unreadable pid (per the
    // advisory: just stop checking, never treat as dead, never throw) | 0 confirmed dead.
    if (this.wrapperAlive(name) !== 0) return;
    // #69: no git call here — the worktree is left exactly as the worker left it. This finalize
    // exists purely to write the .handoff sentinel for a detached lane (no in-process onExit
    // ever runs for it); it no longer has any WIP-preservation responsibility.
    const issue = typeof running.issue === "number" ? running.issue : -1;
    const sessionId = typeof running.session_id === "string" ? running.session_id : "";
    // Unconditionally "handoff" — no timedOut/code branching (there's no exit code at all
    // here, no live process to report one for). SIGTERM commonly omits the result line;
    // writeTerminalSentinel then records its persisted-baseline-adjusted usage estimate.
    this.writeTerminalSentinel(name, issue, sessionId, this.path(name, "jsonl"), "handoff", null);
    this.detachedHandoffRequested.delete(name);
  }

  async probe(name: string): Promise<LaneProbe> {
    // #63: run BEFORE the sentinel existsSync reads below, so a freshly-confirmed-dead
    // detached lane's just-written .handoff.json is observed by THIS SAME probe() call —
    // no separate poll loop, no extra tick lag. See the method comment for why this placement
    // (inside probe, ahead of classification) is what wins the race against the conductor's
    // own DEAD reclassification.
    this.finalizeDetachedHandoffIfConfirmedDead(name);
    const done = existsSync(this.path(name, "done.json"));
    const failed = existsSync(this.path(name, "failed.json"));
    const handoff = existsSync(this.path(name, "handoff.json"));
    const hbAge = this.heartbeatAge(name);
    const wrapperAlive = this.wrapperAlive(name);
    // #169: reuse the immutable first-dispatch baseline already persisted for timeout/dirty-
    // worktree policy. NaN is intentional fail-safe input: an unbounded detached lane is never
    // adoptable merely because its heartbeat is stale and its pid currently answers kill -0.
    const dispatchedAgeSec = (this.now().getTime() - this.dispatchedBaselineMs(name)) / 1000;
    const issue = this.laneIssue(name);
    let hasPr = false;
    let prNumber: number | undefined;
    let prTitle: string | undefined;
    let prAssociationInconclusive = false;
    if (issue != null && this.deps.lanePr) {
      // #377: the lane's PR is resolved from what THIS lane structurally produced — its own
      // worktree's branch, plus the engine-authored owner marker — never from a PR body's prose.
      // `sessionOver` gates EVERY engine-authored write on that path — opening a PR (which would
      // race the worker's own `gh pr create`) and stamping one (an unconditional read-modify-write
      // that would clobber a concurrent description edit; gate② round 5). Reads are never gated.
      //
      // "Nothing is left to race" has TWO structural signals, and both must count (gate② P1 on
      // PR #423): a terminal SENTINEL, or a CONFIRMED-DEAD wrapper (wrapperAlive === 0 — the same
      // kill(pid, 0) signal finalizeDetachedHandoffIfConfirmedDead already treats as death, never
      // -1/unknown). A detached lane that pushed its branch and then died writes no sentinel at
      // all; without the second signal its pushed work would reach the conductor's DEAD reclaim
      // as "no PR" and be requeued or escalated — the exact pushed-but-unPRed case this whole
      // issue exists to fix, just arrived at by a crash instead of a clean exit.
      const sessionOver = done || failed || handoff || wrapperAlive === 0;
      const outcome = await this.deps.lanePr({ name, issue, branch: this.laneBranch(name), sessionOver });
      hasPr = outcome.pr != null;
      if (outcome.pr != null) {
        prNumber = outcome.pr;
        // #595: rides the SAME association read outcome — no extra forge call.
        prTitle = outcome.title;
      }
      // Budget only counts once settlement is actually possible (gate② round 5): while the lane
      // is still running the conductor classifies it KEEP no matter what this says, so spending
      // retries here could leave none for the one probe that does settle it. No write can even
      // fail before then, so this is belt-and-braces over that guarantee, not the only guard.
      prAssociationInconclusive = sessionOver && this.trackInconclusiveAssociation(name, outcome);
    }
    const costUsd = this.terminalCostUsd({ done, failed, handoff }, name);
    const modelUsage = this.terminalModelUsage({ done, failed, handoff }, name);
    // #155: LIVE telemetry only for a lane THIS supervisor still holds in-memory (this.lanes —
    // i.e. actually running; onExit deletes the entry the instant the process exits, terminal
    // or not). A DETACHED lane (persisted running.json, no in-memory handle — the engine
    // restarted while the worker kept running) has no known estimateBaselineUsd to reuse, so
    // it's left undefined here rather than inventing a second baseline (assuming a fresh-dispatch
    // baseline of 0 would misprice a resumed detached lane's current leg).
    const lane = this.lanes.get(name);
    const liveTelemetry = lane ? this.liveTelemetry(lane) : undefined;
    // #287 (E4b, AC#1): the earliest observable actual model — read from the SAME in-memory
    // jsonl liveTelemetry above already re-scans, so this is no new I/O, only a new parse of
    // data already in hand. parseSessionInit's `model` is null until the init line lands (early
    // in a session, but not instant) — conductor.ts's tick() only persists a non-null value.
    const actualModel = lane ? parseSessionInit(this.readJsonl(lane.jsonlPath)).model : undefined;
    // #168: only for a FAILED lane — a DONE/handoff lane's classification is irrelevant
    // (env-failure disposition only applies to the FAILED reclaim path, conductor.ts), and
    // computing it unconditionally would re-read the jsonl on every probe of every lane for no
    // reason.
    const failureText = failed ? this.terminalFailureText(name) : undefined;
    // #374: same "only for a FAILED lane" gating as failureText above — this is only ever
    // consumed at the FAILED reclaim path's env-classification site.
    const rateLimitResetAtMs = failed ? this.terminalRateLimitResetAtMs(name) : undefined;
    // #394 (F22/gate② round 3): same "only for a FAILED lane" gating — the PRIMARY, text-free
    // classification signal (env-failure.ts's classifyEnvFailure), computed from the SAME jsonl
    // read as rateLimitResetAtMs above (no new I/O). true if EITHER structured signal fired — a
    // rejected rate_limit_event OR an errored result with api_error_status:429 (see
    // terminalEnvSignalStructured's own doc for why both are needed).
    const envSignalStructured = failed ? this.terminalEnvSignalStructured(name) : false;
    // #247: for a DONE lane — conductor.ts's fix-leg harvest is one reader; an ordinary
    // worker's DONE result text is otherwise unconsumed there.
    // #601: ALSO for a FAILED lane — a worker that posts a plain refusal comment and then exits
    // non-zero (docs/security.md: "comment is the worker's refuse/hand-back channel") leaves its
    // stated reason in the exact same final `result` line a DONE lane would; the no-PR FAILED
    // escalation site needs it just as much as the no-PR DONE one does. Still gated (never
    // unconditional) — same "compute lazily, only where a consumer could ever use it" stance
    // failureText/rateLimitResetAtMs/envSignalStructured above already take.
    const resultText = done || failed ? this.terminalResultText(name) : undefined;
    // #490: the lane worktree's local head — only for a DONE lane (the fix-response receipt
    // event is the one consumer, and only a DONE `fixing` lane ever produces one). File reads
    // only, no subprocess.
    const worktreeHead = done ? this.laneWorktreeHead(name) : undefined;
    const running = this.readJson(this.path(name, "running.json"));
    if ((done || failed || handoff) && running?.resume_pending_db === true) {
      this.removeIfExists(this.path(name, "running.json"));
    }
    return {
      done,
      failed,
      handoff,
      hbAge,
      wrapperAlive,
      dispatchedAgeSec,
      hasPr,
      costUsd,
      modelUsage,
      ...(prNumber != null ? { prNumber } : {}),
      ...(prTitle != null ? { prTitle } : {}),
      ...(liveTelemetry ? { liveTelemetry } : {}),
      ...(failureText !== undefined ? { failureText } : {}),
      ...(resultText !== undefined ? { resultText } : {}),
      ...(worktreeHead != null ? { worktreeHead } : {}),
      ...(actualModel != null ? { actualModel } : {}),
      ...(rateLimitResetAtMs != null ? { rateLimitResetAtMs } : {}),
      ...(envSignalStructured ? { envSignalStructured } : {}),
      ...(prAssociationInconclusive ? { prAssociationInconclusive } : {}),
    };
  }

  /** #377 (gate② round 3): decides whether THIS probe reports the lane's PR association as
   *  still-unknown (so the conductor defers settling it) or gives up and lets the ordinary
   *  no-PR rules settle it. A conclusive outcome — including a conclusive "no PR" — clears the
   *  lane's budget, so a later, unrelated blip gets its own full allowance. See
   *  MAX_INCONCLUSIVE_PR_PROBES for why the budget exists and why it is in-memory only. */
  private trackInconclusiveAssociation(name: string, outcome: LanePrOutcome): boolean {
    if (!outcome.inconclusive) {
      this.inconclusivePrProbes.delete(name);
      return false;
    }
    const attempts = (this.inconclusivePrProbes.get(name) ?? 0) + 1;
    this.inconclusivePrProbes.set(name, attempts);
    if (attempts <= MAX_INCONCLUSIVE_PR_PROBES) return true;
    this.log(
      `[sapwood:worker] lane ${name}: PR association still unknown after ${MAX_INCONCLUSIVE_PR_PROBES} retries — ` +
        `settling the lane by the ordinary no-PR rules (its pushed branch, if any, is preserved)`,
    );
    return false;
  }

  /** The terminal sentinel (whichever is present) carries the parsed stream-json
   *  total_cost_usd (onExit writes it into all three: done/failed/handoff). Feeds the
   *  conductor's #14 engine-ceiling ledger (state.recordSpend).
   *
   *  No sentinel (or a sentinel without a cost) does NOT mean no cost: a lane orphaned by an
   *  engine restart has no attached onExit handler, so it never gets a sentinel — but claude
   *  still wrote its terminal result line to <name>.jsonl. Returning 0 there would let a
   *  restart mid-run omit real spend from spend_ledger and quietly under-count the daily
   *  hard cap (Codex PR #41 R3 P1). Fall back to parsing the jsonl: for a still-running
   *  lane it parses to 0 anyway (total_cost_usd only appears in the terminal result
   *  message), so the fallback is safe unconditionally. */
  private terminalCostUsd(flags: { done: boolean; failed: boolean; handoff: boolean }, name: string): number {
    const ext = flags.done ? "done.json" : flags.failed ? "failed.json" : flags.handoff ? "handoff.json" : null;
    if (ext) {
      const r = this.readJson(this.path(name, ext));
      if (typeof r?.total_cost_usd === "number") return r.total_cost_usd;
    }
    return parseCostUsd(this.currentLegJsonl(name));
  }

  /** #47: same terminal-sentinel-first, jsonl-fallback shape as terminalCostUsd (see its
   *  comment for why the fallback is needed — an engine-restart orphan never gets a sentinel). */
  private terminalModelUsage(flags: { done: boolean; failed: boolean; handoff: boolean }, name: string): ModelUsageEntry[] {
    const ext = flags.done ? "done.json" : flags.failed ? "failed.json" : flags.handoff ? "handoff.json" : null;
    if (ext) {
      const r = this.readJson(this.path(name, ext));
      if (Array.isArray(r?.model_usage)) return r.model_usage as ModelUsageEntry[];
    }
    return parseModelUsage(this.currentLegJsonl(name));
  }

  /** #168: a FAILED lane's own captured ERROR output, for conductor.ts's env-failure
   *  classification — no new capture mechanism, just a new READ of the jsonl this class already
   *  writes (spawn's `stdio: ["ignore", jsonlFd, jsonlFd]` merges stdout+stderr onto the same
   *  fd, and probe() already reads this exact file for terminalCostUsd/terminalModelUsage).
   *  Extraction is STRUCTURED (PR #180 review P1-3 — see extractFailureText: stderr lines +
   *  errored result/error records only, never assistant message content), then tail-capped: an
   *  environment failure is almost always the LAST thing the process emits before dying, and
   *  there's no reason to carry more through LaneProbe than the classifier can use. Reads the
   *  FULL cumulative jsonl (not a per-leg slice) — see terminalEnvSignalStructured's own doc
   *  below for the shared, deliberate staleness this has in common with that reader on a
   *  multi-leg lane, and why it's a documented parity, not narrowed. */
  private terminalFailureText(name: string): string {
    const text = extractFailureText(this.readJsonl(this.path(name, "jsonl")));
    return text.length > FAILURE_TEXT_TAIL_CHARS ? text.slice(-FAILURE_TEXT_TAIL_CHARS) : text;
  }

  /** #374: same shape as terminalFailureText — a new READ of the jsonl this class already
   *  writes, feeding conductor.ts's env-park entry with a reset-time SCHEDULING hint when the
   *  CLI's own structured rate-limit telemetry names one. */
  private terminalRateLimitResetAtMs(name: string): number | null {
    return extractRateLimitResetAt(this.readJsonl(this.path(name, "jsonl")), this.now().getTime());
  }

  /** #394 (F22) / gate② round 3 (Codex sol-high BLOCK finding, P2): same shape as
   *  terminalRateLimitResetAtMs — a new READ of the SAME jsonl, feeding conductor.ts's env-park
   *  classification with the primary, text-free signal(s). TWO structured signals are OR'd
   *  together here — a rejected `rate_limit_event` (hasRejectedRateLimitEvent) and an errored
   *  `result` record carrying `api_error_status:429` (hasQuotaErrorStatus) — because #374's own
   *  captured transcript shows the CLI does not always emit both together for the same quota
   *  failure; relying on only one leaves a real gap (see env-failure.ts's own module doc for the
   *  full accounting of what these two signals do and do not cover).
   *
   *  #394 gate② review — DOCUMENTED, DELIBERATE staleness (ruled against narrowing): this reads
   *  the FULL cumulative jsonl (`this.path(name, "jsonl")`), same as terminalFailureText just
   *  above — NOT `currentLegJsonl`'s per-leg slice. On a multi-leg (resumed) lane, either
   *  structured signal from an EARLIER, already-recovered leg can still be seen here and
   *  reclassify a LATER, unrelated failure as `llm`. The reviewer proposed slicing to the
   *  current leg only; rejected because terminalFailureText (this class's OTHER classification
   *  reader, right above) already scans the same full file — narrowing only the structured
   *  signal would make the text path and the telemetry path disagree about what "this failure"
   *  scopes to, which is a worse thing for the next reader to reason about than the bounded
   *  staleness itself. Both readers share this scope on purpose: PARITY, not an oversight. The
   *  failure mode this staleness can cause — a stale-but-real signal wrongly parks the engine as
   *  `llm` for an unrelated later failure — self-heals through the EXISTING probe/canary path
   *  (env-failure.ts's probeDue-family functions / escalationChannel): the next probe or canary
   *  lane simply succeeds, since the provider was never actually still rejecting. */
  private terminalEnvSignalStructured(name: string): boolean {
    const jsonl = this.readJsonl(this.path(name, "jsonl"));
    return hasRejectedRateLimitEvent(jsonl) || hasQuotaErrorStatus(jsonl);
  }

  /** #247/#601: a DONE-or-FAILED lane's own final-message text — parseResultText over this
   *  lane's CURRENT LEG jsonl slice (currentLegJsonl, the same per-leg offset
   *  terminalCostUsd/terminalModelUsage's jsonl-fallback already reads), never the whole
   *  cumulative transcript across every resumed leg. A resumed fix leg's OWN final message is
   *  what carries its structured threadResponses block; an earlier leg's now-superseded result
   *  line must never leak through here. A FAILED lane that never emitted a final `result` line
   *  (crashed mid-run) simply gets "" — same as an ordinary DONE lane with no structured output.
   *  No tail cap (unlike terminalFailureText): parseResultText already extracts only the LAST
   *  `result` field value, an inherently bounded slice, not a raw transcript to cap. */
  private terminalResultText(name: string): string {
    return parseResultText(this.currentLegJsonl(name));
  }

  /** #69: tears the lane's process down, THEN decides its worktree's fate — see
   *  retainOrDeleteWorktree for the dirty/clean policy. The caller (conductor.ts) uses the
   *  returned ReclaimResult to escalate a retained worktree to a human (issue comment + label);
   *  worker.ts itself never talks to the forge. */
  async reclaim(name: string): Promise<ReclaimResult> {
    this.inconclusivePrProbes.delete(name); // #377: the lane is going away — its retry budget with it
    const lane = this.lanes.get(name);
    if (lane) {
      lane.reclaiming = true;
      clearInterval(lane.hb);
      await this.killTree(lane.child);
      return this.retainOrDeleteWorktree(name);
    }
    // Cross-process / post-restart: no in-memory handle — kill by the persisted pid. Mark
    // this lane as reclaiming FIRST, before the kill — #63's detached-confirm-death check in
    // probe() must never finalize a lane reclaim() has already decided is going FAILED (a
    // DEAD reclassification or a ceiling-escalation kill), even if it also happens to match
    // "handoff was requested, pid now confirmed dead". reclaim() always wins that race.
    this.detachedReclaiming.add(name);
    this.detachedHandoffRequested.delete(name);
    const pid = this.persistedPid(name);
    if (pid != null) await this.killByPid(pid);
    return this.retainOrDeleteWorktree(name);
  }

  /** #69 (fable P3-b): report a lane's worktree dirtiness WITHOUT any teardown — no kill, no
   *  delete. A `.done`/`.failed` sentinel lane with an open PR is rescued straight to `driving`
   *  (its process already exited; reclaim() is never called, so no dirtiness check would run).
   *  The conductor calls this to apply the same dirty ⇒ needs-human policy the DEAD path uses:
   *  a crashed worker that left uncommitted WIP alongside its PR is escalated to a human rather
   *  than auto-driven toward merge. `worktreeRetained: true` == "possibly dirty"; nothing is
   *  ever deleted here (the terminal path keeps the worktree regardless). */
  inspectWorktree(name: string): ReclaimResult {
    const worktreePath = join(this.worktreeRoot, name);
    if (!existsSync(worktreePath)) return { worktreePath: null, worktreeRetained: false };
    return { worktreePath, worktreeRetained: worktreeMaybeDirty(worktreePath, this.dispatchedBaselineMs(name)) };
  }

  /** #69: dirty-worktree retention (replaces #60/#62's supervisor-side git commit+push, and the
   *  #65 RCE class it carried). Automation must never DELETE a worktree that might still hold
   *  uncommitted work — but it must also never RUN GIT in a worktree the worker fully
   *  controlled (that's this whole PR's invariant). `git status --porcelain` was considered and
   *  REJECTED: empirically confirmed (git 2.50.1) to invoke a worker-set `filter.<name>.clean`
   *  when the working-tree file's mtime races the index's own mtime (the classic "racy git"
   *  content recompute) — even with `-c core.fsmonitor=false` — and a worker can force that race
   *  deliberately (`touch -r .git/index <file>` after editing it) with the ordinary Bash access
   *  it already has to its own worktree. That's the exact #65 clean-filter RCE, just reachable
   *  via reclaim() instead of the deleted #62 commit+push path. So dirtiness here is a pure
   *  FILESYSTEM heuristic (worktreeMaybeDirty): any entry under the worktree (except `.git/`)
   *  whose mtime OR ctime is after the lane's FIRST-dispatch time (dispatchedBaselineMs) is
   *  "possibly dirty". False positives (a worker that edited-then-committed a file, whose
   *  timestamps still moved) just cost an extra needs-human retention — the accepted #69 policy
   *  trade-off. False negatives would silently lose real WIP; checking ctime as well as mtime
   *  (fable P2-b) closes the mtime-backdating gap, since unprivileged code cannot backdate
   *  ctime (any write/utimes/chmod bumps it) — never a supervisor-side execution risk. */
  private retainOrDeleteWorktree(name: string): ReclaimResult {
    const worktreePath = join(this.worktreeRoot, name);
    if (!existsSync(worktreePath)) return { worktreePath: null, worktreeRetained: false };
    if (worktreeMaybeDirty(worktreePath, this.dispatchedBaselineMs(name))) {
      return { worktreePath, worktreeRetained: true }; // left on disk — caller escalates
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Best-effort: an unremovable clean worktree is a minor disk-hygiene issue, not a data
      // loss risk (nothing to lose — it was clean) — don't let it fail the whole reclaim.
    }
    // NOTE (#69 debt, fable P3): the parent repo's `.git/worktrees/<name>` registration (and
    // the lane branch) is left dangling — pre-#69 the engine never deleted worktrees. Harmless
    // for correctness; shows up as a prunable entry in `git worktree list`. A `git worktree
    // prune` (which runs in the TRUSTED main repo, not a worker tree) is a future operator/
    // housekeeping step, deliberately not run here to keep this path git-free.
    return { worktreePath, worktreeRetained: false };
  }

  /** The IMMUTABLE first-dispatch time (`dispatched_at`) that the dirty-worktree retention
   *  check baselines on — set once at dispatch, preserved by resume() (never reset to
   *  resume-time like `started_at`, which drives the wall-clock timeout). Read from whichever
   *  of running.json / the terminal sentinels currently carries it (running.json for a live or
   *  DEAD lane; the sentinel for a terminal lane whose running.json was already removed).
   *  Missing/unparseable everywhere -> NaN, which worktreeMaybeDirty treats as fail-safe dirty
   *  (covers legacy sentinels predating this field). */
  private dispatchedBaselineMs(name: string): number {
    const iso = this.dispatchedAtIso(name);
    if (iso) {
      const t = Date.parse(iso);
      if (!Number.isNaN(t)) return t;
    }
    return NaN;
  }

  /** #245 round-2 (A1): the raw ISO `dispatched_at` string, read from whichever sentinel
   *  currently carries it — factored out of dispatchedBaselineMs (which parses it to ms) so
   *  resume()'s fix-leg entry path (no `.handoff` sentinel — see resume()'s own doc) can recover
   *  the SAME immutable first-dispatch baseline from the `.done`/`.failed` sentinel a `driving`
   *  lane's prior leg actually left behind, without duplicating the file-scan order. */
  private dispatchedAtIso(name: string): string | null {
    for (const ext of ["running.json", "handoff.json", "done.json", "failed.json"]) {
      const r = this.readJson(this.path(name, ext));
      const iso = typeof r?.dispatched_at === "string" ? r.dispatched_at : null;
      if (iso) return iso;
    }
    return null;
  }

  /** Clear timers/fds so a host process can exit cleanly (tests). Does not kill children. */
  dispose(): void {
    for (const lane of this.lanes.values()) {
      clearInterval(lane.hb);
      try {
        closeSync(lane.jsonlFd);
      } catch {
        /* noop */
      }
    }
    this.lanes.clear();
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async killTree(child: ChildProcess): Promise<void> {
    this.killGroup(child, "SIGTERM");
    await sleep(200); // brief grace, then hard-kill the whole group
    this.killGroup(child, "SIGKILL");
  }
  private async killByPid(pid: number): Promise<void> {
    this.signalGroup(pid, "SIGTERM");
    await sleep(200);
    this.signalGroup(pid, "SIGKILL");
  }
  private killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
    if (child.pid != null) this.signalGroup(child.pid, sig);
  }
  private signalGroup(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig); // negative pid -> the whole process group (detached leader)
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  }

  private touchHeartbeat(name: string): void {
    const p = this.path(name, "heartbeat");
    if (!existsSync(p)) writeFileSync(p, "");
    // #403 (F25): stamp with the INJECTED clock, never `new Date()`. heartbeatAge() below reads
    // this file's mtime and subtracts it from `this.now()` — both sides of that subtraction must
    // come from the same clock, or a fixture that seeds `now` computes a nonsense age against a
    // real filesystem timestamp. (The create branch above used to leave a real mtime behind for
    // exactly that mismatch.)
    const t = this.now();
    utimesSync(p, t, t);
  }
  private heartbeatAge(name: string): number {
    const p = this.path(name, "heartbeat");
    if (!existsSync(p)) return -1;
    return Math.floor((this.now().getTime() - statSync(p).mtimeMs) / 1000);
  }
  private wrapperAlive(name: string): -1 | 0 | 1 {
    const pid = this.persistedPid(name);
    if (pid == null) return -1; // unknown (no running marker)
    try {
      process.kill(pid, 0);
      return 1;
    } catch {
      return 0;
    }
  }
  private persistedPid(name: string): number | null {
    const r = this.readJson(this.path(name, "running.json"));
    return typeof r?.wrapper_pid === "number" ? r.wrapper_pid : null;
  }
  /** #377: the branch a lane's worktree is currently on — the structural "which code did THIS
   *  lane produce" signal that lane->PR association is keyed on (see WorkerDeps.lanePr).
   *
   *  Read straight off git's own on-disk refs, never by shelling git: `<worktree>/.git` is a file
   *  containing `gitdir: <path>` (a linked worktree, which is what the `claude` CLI's
   *  `--worktree` flag creates), and that directory's `HEAD` holds `ref: refs/heads/<branch>`.
   *  Plain file reads keep this path git-free for the same #65/#69 reason retainOrDeleteWorktree
   *  is: the engine must never invoke git inside a directory a worker fully controlled (a
   *  worker-set clean filter turns any git invocation into engine-side code execution). Reading
   *  two files it wrote is data, not execution.
   *
   *  null — meaning "unknowable, fall back to a marker scan" — for a missing/deleted worktree, a
   *  detached HEAD, or anything unparseable. Never throws. */
  private laneBranch(name: string): string | null {
    const branch = this.laneHeadBranch(name);
    if (branch == null) return null;
    // #377 (gate② round 5): HEAD is WORKER-MUTABLE. The producer's own grant permits branch
    // changes (`Bash(git *)`), so a lane can `git checkout` its way onto a branch it never
    // produced — and a bare HEAD read would then let associateLanePr stamp and adopt THAT
    // branch's sole unmarked PR, handing the driver an unrelated merge target. That is the same
    // wrong-PR class this whole issue exists to close, re-entered through the branch instead of
    // through prose.
    //
    // Validated against the trusted lane state the engine keeps for itself: the sentinels under
    // `stateDir`, which live outside every worktree and which no worker can write (workers are
    // never granted `data/` via --add-dir). A branch that ANY other known lane is also sitting
    // on is contested and unusable as an association key — for BOTH lanes, deliberately: the
    // engine cannot tell the thief from the victim, so it refuses rather than picking.
    //
    // RESIDUAL, stated rather than papered over: this closes lane-vs-lane capture, not a worker
    // checking out some unrelated branch no lane owns (a human's feature branch, say) and having
    // its sole unmarked PR adopted. Bounding that needs a trusted record of what the lane itself
    // PUSHED — the engine has no seam for that today, since the worker runs its own `git push`.
    // What still holds in that case: the PR must be the branch's ONLY open one and carry no
    // marker, the adoption writes a marker naming this lane (so it is auditable, not silent),
    // and gate② still demands a fresh non-author review before anything merges.
    const rival = this.otherLaneOnBranch(name, branch);
    if (rival) {
      this.log(`[sapwood:worker] lane ${name}: branch ${branch} is also checked out by lane ${rival} — refusing it as an association key`);
      return null;
    }
    return branch;
  }

  /** Every OTHER lane this stateDir knows about that currently sits on `branch`, if any. Lanes
   *  are enumerated from the engine-written sentinels (never from the worktrees themselves — a
   *  worker could create a directory, but not a sentinel). */
  private otherLaneOnBranch(name: string, branch: string): string | null {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return null; // unreadable state dir -> no evidence of a rival; the marker still gates adoption
    }
    const lanes = new Set<string>();
    for (const entry of entries) {
      const lane = entry.match(SENTINEL_FILE)?.[1]; // String.match, per the #69 grep-invariant

      if (lane && lane !== name) lanes.add(lane);
    }
    for (const lane of lanes) {
      if (this.laneHeadBranch(lane) === branch) return lane;
    }
    return null;
  }

  /** The raw `HEAD` read, with no cross-lane validation — see laneBranch for that. */
  private laneHeadBranch(name: string): string | null {
    const dotGit = join(this.worktreeRoot, name, ".git");
    try {
      let gitDir = dotGit;
      if (!lstatSync(dotGit).isDirectory()) {
        // `String.match`, deliberately not the RegExp-side equivalent: worker.test.ts's #69
        // grep-invariant bans that method's bare name anywhere in this module.
        const link = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
        if (!link) return null;
        gitDir = resolve(dirname(dotGit), link[1]!.trim());
      }
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").match(/^ref:\s*refs\/heads\/(.+)$/m);
      return head ? head[1]!.trim() : null;
    } catch {
      return null;
    }
  }

  /** #490: see resolveWorktreeHead — the lane worktree's LOCAL commit sha, or null. */
  private laneWorktreeHead(name: string): string | null {
    return resolveWorktreeHead(join(this.worktreeRoot, name, ".git"));
  }

  private laneIssue(name: string): number | null {
    for (const ext of ["running.json", "done.json", "failed.json", "handoff.json"]) {
      const r = this.readJson(this.path(name, ext));
      if (typeof r?.issue === "number") return r.issue;
    }
    return null;
  }

  private readJsonl(p: string): string {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }
  private readJsonlFromByte(p: string, offset: number): string {
    try {
      const raw = readFileSync(p);
      return raw.subarray(Math.min(offset, raw.length)).toString("utf8");
    } catch {
      return "";
    }
  }
  private currentLegJsonl(name: string): string {
    const running = this.readJson(this.path(name, "running.json"));
    const offset =
      typeof running?.jsonl_leg_offset === "number" && Number.isSafeInteger(running.jsonl_leg_offset) && running.jsonl_leg_offset >= 0
        ? running.jsonl_leg_offset
        : 0;
    return this.readJsonlFromByte(this.path(name, "jsonl"), offset);
  }
  private readJson(p: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  private writeJsonAtomic(p: string, obj: unknown): void {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj) + "\n");
    renameSync(tmp, p);
  }
  private removeIfExists(p: string): void {
    try {
      rmSync(p, { force: true });
    } catch {
      /* noop */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POSIX single-quote escaping: wrap in '...' and replace each ' with '\'' so no shell
 *  expansion ($, backticks, $()) occurs in the interpolated path. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultPrompt(issue: Issue): string {
  // Imperative — headless has no human to confirm; the worker starts immediately. This is the
  // internal last-resort skeleton used ONLY when a caller constructs WorkerSupervisor with no
  // renderPrompt at all (e.g. a test, or a future embedder). The real `sapwood run` entry point
  // (cli.ts) always wires deps.renderPrompt via buildRenderPrompt(cfg) below, which loads the
  // full TDD/two-gate method from the shipped prompts/worker.md (or an operator override) — #74.
  return [
    `You are an autonomous worker. Implement GitHub issue #${issue.number}: ${issue.title}.`,
    `Work on a feature branch, follow the repo's tests-first method, and open a pull request when done.`,
    `Do not merge. Commit and push your work; the conductor handles review and merge.`,
  ].join("\n");
}

// ── #74: file-based worker prompt (config.ts's worker.promptFile + the shipped default) ──

/** Supported `{{var}}` substitutions — deliberately tiny (no template engine, no new
 *  dependency): just the per-issue fields a worker prompt needs to address a specific issue
 *  (config-level vars like {{labels.verifyNa}} live in CONFIG_VARS, merged by buildRenderPrompt). */
const PROMPT_VARS: Record<string, (issue: Issue) => string> = {
  "issue.number": (issue) => String(issue.number),
  "issue.title": (issue) => issue.title,
  "issue.body": (issue) => issue.body ?? "",
  // Labels drive the prompt's own branching (e.g. the verify:n/a doc-gate path) — the worker
  // can't check a label the template never shows it.
  "issue.labels": (issue) => issue.labels.join(", "),
};

/** Simple `{{var}}` substitution (#74) — no template engine. FAILS CLOSED on any `{{...}}`
 *  placeholder outside PROMPT_VARS: a typo'd/unsupported var must not silently pass through as
 *  literal `{{...}}` text in the dispatched prompt (the whole point of a configurable prompt is
 *  knowing exactly what gets sent to the worker). Every well-formed `{{...}}` token is checked —
 *  the name pattern is deliberately broad and the lookup is own-key only, so neither a typo like
 *  `{{issue-title}}` nor a prototype name like `{{constructor}}` can slip through. Malformed
 *  (unclosed) `{{` is left untouched. */
export function renderPromptTemplate(template: string, issue: Issue): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (!Object.hasOwn(PROMPT_VARS, name)) {
      throw new Error(`worker prompt template: unknown variable {{${name}}} — supported: ${Object.keys(PROMPT_VARS).join(", ")}`);
    }
    return PROMPT_VARS[name]!(issue);
  });
}

/** Resolves the shipped default prompt — `engine/prompts/worker.md` inside the engine
 *  package, NOT relative to the target repo the engine is orchestrating. */
export function defaultPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src/<domain> (tsx) and engine/dist/<domain> (built) are both two levels below engine/ —
  // the prompt lives INSIDE the engine package so `npm pack --workspace engine`
  // ships it (a repo-root prompts/ would be absent from packaged installs).
  return join(here, "..", "..", "prompts", "worker.md");
}

/** Load the worker prompt TEMPLATE, raw and un-substituted, exactly ONCE. Either the operator's
 *  `worker.promptFile` (loadConfig has already resolved a relative path against the CONFIG
 *  FILE's directory, so by here it is effectively absolute) or, when unset, the shipped default
 *  at `engine/prompts/worker.md` (see defaultPromptPath — resolved inside the engine package,
 *  never the orchestrated repo).
 *
 *  FAIL-FAST (#74): an explicitly configured `promptFile` that's missing or unreadable throws
 *  here, NAMING THE PATH — never a silent fallback to the shipped default. Meant to be called
 *  once at startup (buildRenderPrompt), before any dispatch. */
export function loadWorkerPromptTemplate(cfg: SapwoodConfig): string {
  const configured = cfg.worker.promptFile;
  if (configured === undefined) return readFileSync(defaultPromptPath(), "utf8");
  if (!existsSync(configured)) {
    throw new Error(`worker.promptFile not found: ${configured} — refusing to dispatch`);
  }
  try {
    return readFileSync(configured, "utf8");
  } catch (e) {
    throw new Error(`worker.promptFile unreadable: ${configured} (${String(e)}) — refusing to dispatch`);
  }
}

/** Config-level `{{var}}`s — they don't vary per issue. The shipped prompt references the
 *  verify-label by var, not literal, so a repo that customizes `labels.verifyNa` gets a prompt
 *  that names ITS label. */
const CONFIG_VARS: Record<string, (cfg: SapwoodConfig) => string> = {
  "labels.verifyNa": (cfg) => cfg.labels.verifyNa,
  // #167: the repo-level review doctrine (technical invariants + adjudication doctrine) —
  // loaded fresh per render (doctrine.ts's loadDoctrine, config-file-relative-resolved
  // `cfg.doctrine.file`, capped/deterministically-truncated at `cfg.doctrine.maxChars`). Missing
  // file is NOT an error, unlike `worker.promptFile` above — it degrades to doctrine.ts's
  // explicit NO_DOCTRINE placeholder (see that module's doc comment), never a silent empty
  // substitution and never a startup throw.
  doctrine: (cfg) => loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars),
};

/** Builds the `WorkerDeps.renderPrompt` closure (#74): loads the template ONCE, eagerly —
 *  fail-fast on a missing/unreadable/EMPTY `worker.promptFile` AND on any unknown `{{var}}`
 *  happens here, at call time, not lazily on first dispatch — a bad template discovered at
 *  render time would fire AFTER the dispatch loop already claimed the issue (Ready → In
 *  Progress), forcing a rollback on every tick. The real `sapwood run` entry point (cli.ts)
 *  calls this immediately after loadConfig(), before constructing the WorkerSupervisor, so a
 *  bad promptFile aborts startup with no dispatch ever happening.
 *
 *  Rendering is a SINGLE pass over the original template with one combined var map — a
 *  substituted value is literal output, never re-scanned for `{{...}}`, so a config value like
 *  `{{issue.body}}` cannot smuggle in a second expansion. */
export function buildRenderPrompt(cfg: SapwoodConfig): (issue: Issue) => string {
  const template = loadWorkerPromptTemplate(cfg);
  if (template.trim() === "") {
    throw new Error(
      `worker prompt template is empty${cfg.worker.promptFile !== undefined ? `: ${cfg.worker.promptFile}` : ""} — refusing to dispatch an undirected worker`,
    );
  }
  const vars: Record<string, (issue: Issue) => string> = { ...PROMPT_VARS };
  for (const [name, fromCfg] of Object.entries(CONFIG_VARS)) vars[name] = () => fromCfg(cfg);
  for (const [, raw] of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = raw!.trim();
    if (!Object.hasOwn(vars, name)) {
      throw new Error(`worker prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`);
    }
  }
  return (issue: Issue) => template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => vars[raw.trim()]!(issue));
}

// ── #245: file-based FIX-LEG prompt (config.ts's worker.fixPromptFile + the shipped default) ──
// Same #74 shape as the worker prompt above, but a DELIBERATELY NARROWER var set (#245 round-2
// fix A7): issue.number, pr.number, labels.verifyNa ONLY — never issue.title/body/labels. A fix
// leg's evidence channel is the PR-facing proxy tools, not issue prose; the caller
// (conductor.ts's startFixLeg/FixLegDeps) therefore never needs to construct a full `Issue`
// object just to render this prompt — a bare issue NUMBER is enough.

/** Resolves the shipped default fix-leg prompt — `engine/prompts/fix.md` inside the engine
 *  package (mirrors defaultPromptPath's resolution: relative to the engine package, never the
 *  orchestrated repo). */
export function defaultFixPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "fix.md");
}

/** Load the fix-leg prompt TEMPLATE, raw and un-substituted, exactly ONCE. Either the operator's
 *  `worker.fixPromptFile` (loadConfig has already resolved a relative path against the CONFIG
 *  FILE's directory) or, when unset, the shipped default at `engine/prompts/fix.md`.
 *
 *  FAIL-FAST (#74 pattern): an explicitly configured `fixPromptFile` that's missing or
 *  unreadable throws here, naming the path — never a silent fallback to the shipped default. */
export function loadFixPromptTemplate(cfg: SapwoodConfig): string {
  const configured = cfg.worker.fixPromptFile;
  if (configured === undefined) return readFileSync(defaultFixPromptPath(), "utf8");
  if (!existsSync(configured)) {
    throw new Error(`worker.fixPromptFile not found: ${configured} — refusing to start a fix leg`);
  }
  try {
    return readFileSync(configured, "utf8");
  } catch (e) {
    throw new Error(`worker.fixPromptFile unreadable: ${configured} (${String(e)}) — refusing to start a fix leg`);
  }
}

/** Builds the fix-leg prompt renderer (#245): loads the template ONCE, eagerly — fail-fast on a
 *  missing/unreadable/EMPTY `worker.fixPromptFile` AND on any unknown `{{var}}` happens here, at
 *  build time, not lazily on the first fix leg. Meant to be called once at startup (mirrors
 *  buildRenderPrompt) and threaded into conductor.ts's startFixLeg as `renderFixPrompt`.
 *
 *  #245 round-2 fix A7: takes the bare issue NUMBER, not a full `Issue` — see the module-level
 *  comment above for why the supported var set makes a fabricated `Issue` unnecessary. */
export function buildRenderFixPrompt(cfg: SapwoodConfig): (issueNumber: number, pr: number) => string {
  const template = loadFixPromptTemplate(cfg);
  if (template.trim() === "") {
    throw new Error(
      `fix-leg prompt template is empty${cfg.worker.fixPromptFile !== undefined ? `: ${cfg.worker.fixPromptFile}` : ""} — refusing to start an undirected fix leg`,
    );
  }
  const vars: Record<string, (issueNumber: number, pr: number) => string> = {
    "issue.number": (issueNumber) => String(issueNumber),
    "labels.verifyNa": () => cfg.labels.verifyNa,
    "pr.number": (_issueNumber, pr) => String(pr),
  };
  for (const [, raw] of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = raw!.trim();
    if (!Object.hasOwn(vars, name)) {
      throw new Error(`fix-leg prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`);
    }
  }
  return (issueNumber: number, pr: number) =>
    template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => vars[raw.trim()]!(issueNumber, pr));
}

/** #490: resolve a worktree's CURRENT commit sha from its `.git` entry — pure file reads (the
 *  same gitdir-resolution pattern as WorkerSupervisor.laneHeadBranch, no subprocess): a detached
 *  HEAD is the sha itself; a symbolic HEAD resolves through the loose ref file (worktree gitdir
 *  first, then the commondir), then the commondir's packed-refs. This is the LOCAL head a fix
 *  leg left behind — evidence of what it produced, not proof of a push. `null` on any
 *  unreadable/unresolvable shape — honest "unobserved", never a guess. Exported for direct unit
 *  coverage; production reaches it only through the supervisor's probe(). */
export function resolveWorktreeHead(dotGit: string): string | null {
  try {
    let gitDir = dotGit;
    if (!lstatSync(dotGit).isDirectory()) {
      const link = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (!link) return null;
      gitDir = resolve(dirname(dotGit), link[1]!.trim());
    }
    const headRaw = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(headRaw)) return headRaw.toLowerCase(); // detached
    const ref = headRaw.match(/^ref:\s*(refs\/\S+)/m)?.[1];
    if (!ref) return null;
    // A linked worktree's refs live in the COMMON gitdir; a primary checkout has no commondir.
    let common = gitDir;
    try {
      common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // No commondir file — gitDir IS the common dir.
    }
    // #509 review P2 (same rule context-manifest.ts already pins): only refs/bisect/,
    // refs/rewritten/, and refs/worktree/ are WORKTREE-LOCAL; every other ref — including
    // refs/heads/* — is shared and must resolve from the COMMON store only. Probing the
    // worktree gitdir first would let a stale (or worker-created) worktrees/<lane>/refs/heads
    // shadow win over the real branch head.
    const worktreeLocal = /^refs\/(bisect|rewritten|worktree)\//.test(ref);
    try {
      const loose = readFileSync(join(worktreeLocal ? gitDir : common, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(loose)) return loose.toLowerCase();
    } catch {
      // Not a loose ref — fall through to packed-refs.
    }
    if (worktreeLocal) return null; // worktree-local namespaces are never packed in the common store
    const packed = readFileSync(join(common, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/i);
      if (m && m[2] === ref) return m[1]!.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}
