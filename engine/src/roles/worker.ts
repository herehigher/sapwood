// worker.ts — the ONE module that touches the Claude CLI. Every `claude -p` flag, the
// stream-json cost parsing, CLAUDE_BIN discovery, the worktree, the sentinels, and the
// process-tree kill live here (PLAN.md: "Claude CLI coupling isolated in worker.ts").
//
// It implements the conductor's `Supervisor` seam (dispatch/probe/reclaim). Completion is
// signalled by SENTINEL FILES the wrapper writes — never the model's self-report:
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
// tool call reaches this hook at all; see docs/security/egress.md#worker-network-egress-bash-channel-containment-available-as-a-hardening-profile
// for the residual and branch protection as the mandatory backstop.
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine } from "../config/doctrine.js";
import { defaultRuntimeRoot, ensureRuntimeRoot, runtimePaths } from "../config/paths.js";
import { estimateUsd, loadPricingTable, type PricingTable } from "../config/pricing.js";
import type { Issue, LanePrOutcome } from "../forge/forge.js";
import type { LaneProbe, ReclaimResult, ResumeIntentState, Supervisor, WorktreeSettleOutcome } from "../loop/conductor.js";
import type { ForgeProxyHandle } from "../proxy/mcp-server.js";
import type { CategorizedTokenUsage, ContextManifestKey, ModelUsageEntry, State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { createHeartbeatGate, type HeartbeatGate } from "../util/heartbeat.js";
import { sanitizeUpstreamError } from "../util/sanitize.js";
import { awaitSpawnConfirmation } from "../util/spawn-confirm.js";
import {
  assembleContextManifest,
  capturePreSpawnManifestData,
  KNOWN_UNPROBED_NOTE,
  type PreSpawnManifestCapture,
  resolveWorktreeIndexBaselineMs,
} from "./context-manifest.js";
import { type SkillsSessionKind, shouldInjectSkillsPlugin } from "./skills-plugin.js";

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

/** #724 gate② round 4, P3-5: the ONE grace window between a SIGTERM and the escalation SIGKILL
 *  — `killTree`/`killByPid` (this file, the process-tree/detached-pid kill sequence) and
 *  round.ts's own E-STOP durable-pid sweep (which drives the SAME sequence one signal at a time
 *  via `signalDurablePid`, never calling `killTree`/`killByPid` directly — see that sweep's own
 *  doc for why) both consume this SAME constant, exported here since this file owns the kill
 *  sequence. Previously duplicated as a bare `200` literal in both places — a real drift risk
 *  (the two grace windows silently diverging under a future edit to just one of them). */
export const KILL_SIGNAL_GRACE_MS = 200;

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
 *  font download). The decision recorded in docs/security/egress.md is TAG, never exclude: a loopback
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
 *  duplicated here.)
 *
 *  #1010: `permissionMode` is the CLI's own report of the EFFECTIVE host permission mode this
 *  session actually started under — verified present in the init line (`permissionMode:"auto"`)
 *  against Claude Code CLI 2.1.235. The engine always REQUESTS `auto` (claudeArgs' `--permission-
 *  mode auto` below), but Claude Code silently falls back to a different mode when auto is
 *  unavailable (org settings turn it off / model unsupported) — this field is the only way to
 *  observe that divergence; `null` means the init line carried no such field (an older CLI, or a
 *  parse miss), never a claim that the mode was unset. */
export interface SessionInitInfo {
  model: string | null;
  cliVersion: string | null;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  memoryPathAuto: string | null;
  permissionMode: string | null;
}

export function parseSessionInit(jsonl: string): SessionInitInfo {
  const empty: SessionInitInfo = {
    model: null,
    cliVersion: null,
    tools: [],
    mcpServers: [],
    memoryPathAuto: null,
    permissionMode: null,
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
      permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : null,
    };
  }
  return empty; // no init line found — honest empty, never a thrown error
}

/** #1010/#1011: the shared predicate both WorkerSupervisor's lane-end and peripheral.ts's
 *  role-session-end read points evaluate before emitting `permission-mode-mismatch`. `effective`
 *  is a session's own `SessionInitInfo.permissionMode`; `requested` is the CONFIGURED
 *  `cfg.host.permissionMode` both production call sites pass explicitly (the `=
 *  REQUESTED_PERMISSION_MODE` default below only fires for a caller that omits it, e.g. a
 *  fixture built before #1011). `null` — the init line carried no such field, or was never
 *  observed at all (a parser miss, a crashed-before-init session) — is NEVER a mismatch:
 *  fail-safe, allow direction, so an unparseable/absent field can never manufacture a false
 *  positive that then makes its way into the events ledger. */
export function permissionModeMismatched(effective: string | null, requested: string = REQUESTED_PERMISSION_MODE): boolean {
  return effective !== null && effective !== requested;
}

const SANDBOX_VIOLATIONS_TAG = "<sandbox_violations>";

/** Extracts the text a `tool_result` block's own `content` carries — a bare string, or (the
 *  richer shape) an array of content parts, each contributing its own `text` field when present.
 *  Never throws; an unrecognized shape contributes no text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string" ? (c as Record<string, unknown>).text : "",
    )
    .join("\n");
}

/** #1010: counts `<sandbox_violations>` blocks the CLI appends to a DENIED command's own
 *  `tool_result` — verified 2026-08-19 that the `system/init` line carries no separate sandbox
 *  field, so this tag is the only stream-json evidence a Bash-sandbox profile was engaged for a
 *  given command. ONE STRING MATCH over the already-parsed jsonl (no new scanner module,
 *  deliberately no richer parse of the block's own contents): counts the literal opening tag,
 *  scoped to `type:"user"` messages' own `tool_result` content blocks only — never a match
 *  against `assistant`/`system` text, so a session merely DISCUSSING sandbox violations (in code,
 *  in commentary) can never inflate this count. Same tolerant parsing as every other scanner in
 *  this file: a malformed/partial line is skipped, never thrown; no matches -> 0, never a guess.
 *  Positive attestation that the sandbox was actually engaged (vs. simply absent from a leg with
 *  no denied commands at all) is explicitly out of scope — left to DR #1009 (P5), per this
 *  issue's own Why section — this is a COUNT of observed evidence, not a presence claim. */
export function countSandboxViolations(jsonl: string): number {
  let count = 0;
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "user") continue;
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const text = toolResultText(b.content);
      for (
        let i = text.indexOf(SANDBOX_VIOLATIONS_TAG);
        i !== -1;
        i = text.indexOf(SANDBOX_VIOLATIONS_TAG, i + SANDBOX_VIOLATIONS_TAG.length)
      ) {
        count++;
      }
    }
  }
  return count;
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

/** #935: one streamed usage delta, carrying the extra tier split estimateUsd needs beyond plain
 *  ModelUsageEntry. `cacheCreationTokens` stays the exact TOTAL (input/cache dedup is still
 *  exact-equality-checkable against a terminal `result.usage`); `cacheCreation1hTokens` names the
 *  subset of that total billed at the pricier 1-hour TTL (the remainder is the 5-minute tier). */
export interface LiveUsageEntry extends ModelUsageEntry {
  cacheCreation1hTokens: number;
}

/** #935: the portion of a streamed usage block's `cache_creation_input_tokens` billed at the
 *  1-hour ephemeral TTL, read from Claude Code's own `usage.cache_creation.ephemeral_1h_input_tokens`
 *  breakdown. Missing/malformed -> 0 (the whole cache-creation total falls to the cheaper 5-minute
 *  tier), same tolerance stance as toCategorized. */
function cacheCreation1hTokens(u: unknown): number {
  const r = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  const cc = r.cache_creation;
  if (!cc || typeof cc !== "object") return 0;
  const v = (cc as Record<string, unknown>).ephemeral_1h_input_tokens;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** #935: chars/4 output-token estimate source — sums the character length of every streamed
 *  `text` block's `text` and every `tool_use` block's serialized `input`, across ONE assistant
 *  line's `content` array. `thinking` blocks contribute 0 (Claude Code's stream carries them
 *  empty, per design — the estimate is not meant to reconstruct thinking length). Malformed/
 *  missing content -> 0, never a throw. */
function contentChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
    else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length;
  }
  return chars;
}

/** #33/#935: the LIVE in-flight cost-estimation signal — distinct from parseModelUsage/
 *  parseCostUsd, which only ever read the terminal `result` line (absent until the whole run
 *  finishes). Claude Code's stream-json carries a `message.usage` block on every streamed
 *  `assistant` event, and that block IS per-message — but a single API message spans MULTIPLE
 *  `assistant` lines (one per content block: text, thinking, each `tool_use`), all carrying the
 *  same `message.id`. Summing every line's raw usage therefore re-prices the same message once
 *  per block (#935: measured +55-65% skew). De-duplicate by `message.id` for input/cache-write/
 *  cache-read — one entry per id, keeping the LAST line seen for that id (those fields don't
 *  change between a message's blocks, so last-wins is only a tie-break). A line whose `message`
 *  carries no `id` keeps the old per-line behavior (tolerance rule unchanged — some CLI versions/
 *  malformed lines may omit it).
 *
 *  `usage.output_tokens` is NOT treated the same way: verified against real captured transcripts
 *  (dogfood lane #920's own logs — replayable via `engine/scripts/estimator-replay.ts` against a
 *  directory of real stream-json transcripts; the repo itself carries no such transcripts, only
 *  synthetic unit fixtures), it's a START-OF-GENERATION snapshot, not the message's true output
 *  count — de-duplicating it (by any rule) still misses the real total by roughly 40-50x on those
 *  captures. Instead, `outputTokens` is estimated as
 *  `ceil(chars/4)` over the message's streamed `text` and serialized `tool_use.input` content,
 *  ACCUMULATED across every line belonging to that message id (each line is a different content
 *  block, so its chars add rather than overwrite). This is a deliberately UNDER-biased estimate,
 *  never over: `thinking` content is invisible in the stream (empty text) and contributes nothing,
 *  so a thinking-heavy message's real output is undercounted, not overcounted — the same
 *  conservative direction #935's own doc history already argues for (over-estimating only costs
 *  an earlier graceful handoff; under-estimating is the dangerous direction, mitigated here by
 *  layering on top of `worker.timeoutSec` + the engine's hard ceiling, never relying on this
 *  estimate alone).
 *
 *  Same tolerance guarantee as parseModelUsage throughout: a malformed/partial line (the stream
 *  may be mid-write, or the worker's Bash tool literally echoed the string "assistant" as text)
 *  is skipped, never thrown, and a line missing/misshaping `message`/`usage`/`content` yields
 *  zeros for that piece rather than aborting the scan. */
export function parseAssistantUsageDeltas(jsonl: string): LiveUsageEntry[] {
  const out: LiveUsageEntry[] = [];
  const charsAccum: number[] = [];
  const indexByMessageId = new Map<string, number>();
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
    const usage = toCategorized(m.usage);
    const entry: LiveUsageEntry = {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: 0, // patched below, once every line's chars for this id are accumulated
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheCreation1hTokens: cacheCreation1hTokens(m.usage),
      cacheReadTokens: usage.cacheReadTokens,
    };
    const chars = contentChars(m.content);
    const messageId = typeof m.id === "string" && m.id.length > 0 ? m.id : undefined;
    const existingIndex = messageId === undefined ? undefined : indexByMessageId.get(messageId);
    if (existingIndex !== undefined) {
      out[existingIndex] = entry; // same message, another content block — last usage wins in place
      charsAccum[existingIndex] = charsAccum[existingIndex]! + chars; // ...but chars ACCUMULATE
    } else {
      if (messageId !== undefined) indexByMessageId.set(messageId, out.length);
      out.push(entry);
      charsAccum.push(chars);
    }
  }
  for (let i = 0; i < out.length; i++) out[i]!.outputTokens = Math.ceil(charsAccum[i]! / 4);
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

/** #799 (PLAN.md's Architecture chapter — "state a minimum Claude Code CLI version", never previously built): the
 *  minimum Claude Code CLI version this engine's worker/probe argv
 *  is verified against — the ONLY version this repo has evidence for. probeLlmPing's own doc
 *  below states it: "verified working against claude CLI 2.1.209" for `--no-session-persistence`,
 *  `--strict-mcp-config`, `--tools`, `--max-budget-usd`, `--system-prompt`. An older CLI missing
 *  one of those flags fails every probe/worker leg with `error: unknown option ...`, which #168's
 *  deterministic signature classifier reads as an ENVIRONMENT failure (the loop parks the LLM
 *  source and backs off) rather than naming the real, fixable cause. Do not invent a newer
 *  unverified number here — that fails the drift test below by construction (it can only compare
 *  this constant against the docs, never re-derive "what the CLI actually verifies").
 *
 *  Drift-tested against docs/guide/getting-started.md's Requirements bullet and docs/guide/configuration.md's
 *  `worker` section (claude-version-startup-check.test.ts's AC1/AC2 test) — changing this value
 *  without updating both docs to the SAME exact string fails that test. Consumed by
 *  claude-version-startup-check.ts's once-per-engine-start WARN-only startup detector — never a
 *  gate, see that module's own doc — and by the manual floor-check script
 *  (`engine/scripts/check-claude-cli-flags.ts`) via `ENGINE_CLAUDE_LONG_FLAGS` below. */
export const MIN_CLAUDE_CLI_VERSION = "2.1.209";

/** #168: the ping probe's outcome. `detail` is set on FAILURE only — the first stderr (or
 *  stdout) error line, a timeout note, or a spawn error — so the recorded probe event lets an
 *  operator distinguish "provider still down" (a 429/overloaded error) from a local
 *  misconfiguration ("Error: Exceeded USD budget (0.01)" = envFailure.probeMaxBudgetUsd set
 *  too low; see docs/guide/configuration.md). */
export interface LlmPingResult {
  ok: boolean;
  detail?: string;
}

/** The ping's fixed prompt pair — deliberately strict so the response is a single word
 *  (minimum output tokens) and deliberately engine-internal, not config. The custom
 *  --system-prompt REPLACES the CLI's default (much larger) system prompt. */
const LLM_PING_SYSTEM_PROMPT = "You are a heartbeat responder. Only output the requested word.";
const LLM_PING_PROMPT = "Respond with the single word 'pong' and nothing else.";

/** #799 gate② P1 #4 fix: probeLlmPing's argv, extracted to a pure builder so the CI floor-check
 *  (`ENGINE_CLAUDE_LONG_FLAGS`, defined after `claudeArgs` below) can derive its required-flag
 *  set by actually CALLING this function rather than hand-copying flag names into a second list
 *  that can silently fall behind (sol-high gate② finding: a 5-flag hand list omitted even this
 *  same function's own `--model`/`--output-format`, and 19 more flags `claudeArgs` can emit).
 *  probeLlmPing itself calls this — one source, not two.
 *
 *  #1011: `permissionMode` follows the same optional-with-`REQUESTED_PERMISSION_MODE`-fallback
 *  shape `ClaudeArgsOpts.permissionMode` uses — this is a `claude` session the engine spawns
 *  same as any worker/peripheral session, so it requests the CONFIGURED `host.permissionMode`
 *  too, never a hardcoded mode. Omitted -> the schema's own default ("auto"), so a caller/fixture
 *  built before this parameter existed keeps its byte-identical argv. */
function llmPingArgv(probeModel: string, probeMaxBudgetUsd: number, permissionMode?: string): string[] {
  return [
    "-p",
    "--model",
    probeModel,
    "--permission-mode",
    permissionMode ?? REQUESTED_PERMISSION_MODE,
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
  ];
}

/** #168 (PR #180 review, P1-1 amendment — final form): the LLM-source probe for conductor.ts's
 *  park machinery (TickDeps.probeLlmReachable) — a REAL minimal inference ping, verified
 *  working against claude CLI 2.1.209 in exactly this form (returns "pong", exit 0):
 *
 *      claude -p --model <probeModel> --permission-mode <configured host.permissionMode> \
 *        --no-session-persistence --system-prompt "<LLM_PING_SYSTEM_PROMPT>" --strict-mcp-config \
 *        --tools "" --max-budget-usd <probeMaxBudgetUsd> --output-format text "<LLM_PING_PROMPT>"
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
 *  upgrade (see docs/guide/configuration.md).
 *
 *  Never throws — any spawn error, non-zero exit, non-"pong" output, or a hang past
 *  `timeoutSec` (hard kill) resolves `{ ok: false, detail }`.
 *
 *  #1011: `permissionMode` — same optional-with-fallback shape as `llmPingArgv`'s own param
 *  (see that function's doc) — threads the configured `host.permissionMode` through to argv;
 *  cli.ts's two production driver call sites (tick + rounds) both pass it. */
export function probeLlmPing(
  claudeBin: string,
  probeModel: string,
  probeMaxBudgetUsd: number,
  timeoutSec: number,
  permissionMode?: string,
): Promise<LlmPingResult> {
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
      child = spawn(claudeBin, llmPingArgv(probeModel, probeMaxBudgetUsd, permissionMode), { stdio: ["ignore", "pipe", "pipe"] });
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

/** #1011: cli.ts's TWO production driver call sites (tick + rounds) each need a
 *  `TickDeps.probeLlmReachable`-shaped closure over the SAME five config values — a
 *  per-call-site argument list is exactly the kind of duplication a later edit (e.g. this
 *  helper's own permissionMode fix) can update at one site and silently miss the other. One
 *  shared builder makes both call sites identical one-liners instead. `claudeBin` stays a
 *  caller-supplied param (not read from `process.env` here) so this function stays pure and
 *  testable without env mutation — cli.ts resolves it once via `discoverClaudeBin` and passes
 *  it in. */
export function mkProbeLlmReachable(cfg: SapwoodConfig, claudeBin: string): () => Promise<LlmPingResult> {
  return () =>
    probeLlmPing(
      claudeBin,
      cfg.envFailure.probeModel,
      cfg.envFailure.probeMaxBudgetUsd,
      cfg.envFailure.probeTimeoutSec,
      cfg.host.permissionMode,
    );
}

// ── #799: the version probe — claude-version-startup-check.ts's own detector logic lives in
// loop/, but the ACTUAL spawn lives HERE, next to probeLlmPing, on purpose: this file's own
// `#69 grep-invariant` test (below, "the ONLY child_process importers are worker.ts...") is a
// repo-wide structural check that no OTHER engine module shells out — the "Claude CLI coupling
// isolated in worker.ts" property PLAN.md's Architecture chapter itself names as a v1 requirement. Adding a second
// spawn call in loop/claude-version-startup-check.ts would either violate that invariant or force
// widening its allowlist; keeping the spawn here and exporting only the RESULT type/function
// keeps the isolation property intact while still letting the startup module own the arm/log/
// event logic. detectClaudeVersionStartupTier (loop/claude-version-startup-check.ts) is the only
// production caller.

/** The version probe's raw outcome — same two-shape contract as `LlmPingResult` above
 *  (`{ok:true,...}` / `{ok:false,detail}`), so failure surfacing reads the same way as its
 *  sibling. */
export type ClaudeVersionProbeResult = { ok: true; stdout: string } | { ok: false; detail: string };

/** Bounded probe timeout. `--version` is a local, no-network CLI invocation — unlike
 *  probeLlmPing's real inference round-trip, which is why THAT probe needs a user-configurable
 *  `probeTimeoutSec` — so a short, fixed bound is appropriate here and deliberately NOT a new
 *  config key (user-tunable values belong in config only when there is a real tuning need; a
 *  healthy `--version` call returns in milliseconds, and an unhealthy one should hard-kill fast
 *  rather than hold up startup). */
export const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** #799 gate② P1 #4 (round 2, sol-high): the version probe's own argv — extracted the same way
 *  `llmPingArgv` was, so `ENGINE_CLAUDE_LONG_FLAGS` below can derive its required-flag set by
 *  actually CALLING this too, not just the worker/ping argv builders. Round 1's fix covered
 *  fresh + resume `claudeArgs` shapes and `llmPingArgv`, but omitted THIS probe entirely — sol-
 *  high's round-2 reproduction: `probeClaudeVersion` really spawns `claudeBin ["--version"]`
 *  (below), so a real engine install's complete fresh+resume+ping+version-probe argv union is
 *  24 flags, not the 23 the round-1 derivation covered. `probeClaudeVersion` calls this. */
function versionProbeArgv(): string[] {
  return ["--version"];
}

/** Spawns `<claudeBin> --version` and resolves the raw result — never throws: a spawn error, a
 *  hang past `CLAUDE_VERSION_PROBE_TIMEOUT_MS` (hard SIGKILL), and a non-zero exit all resolve
 *  `{ ok: false, detail }` instead of rejecting, exactly like probeLlmPing's own never-throws
 *  contract. */
export function probeClaudeVersion(claudeBin: string): Promise<ClaudeVersionProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ClaudeVersionProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(claudeBin, versionProbeArgv(), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, detail: `version probe spawn failed: ${e instanceof Error ? e.message : String(e)}` });
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
      finish({ ok: false, detail: `version probe timed out after ${CLAUDE_VERSION_PROBE_TIMEOUT_MS}ms (hard-killed)` });
    }, CLAUDE_VERSION_PROBE_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, detail: `version probe spawn error: ${e.message}` });
    });
    // 'close', not 'exit' — same #578 rationale as above: stdio buffers are only guaranteed
    // complete once every stream has closed, not the moment the child terminates.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const firstLine = (stderr || stdout).trim().split("\n")[0]?.trim();
        finish({ ok: false, detail: `version probe exited ${code}${firstLine ? `: ${firstLine}` : ""}` });
        return;
      }
      finish({ ok: true, stdout });
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
  /** #1011: the `--permission-mode` value — every caller now passes the CONFIGURED
   *  `host.permissionMode` (worker.ts's dispatch()/resume(), peripheral.ts's RoleRunner.run(),
   *  both alike). Omitted -> `REQUESTED_PERMISSION_MODE` ("auto", the schema's own default and
   *  every sapwood release's behavior before this key existed) — so a caller/fixture built before
   *  this field existed keeps its byte-identical argv. */
  permissionMode?: string;
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
   *  in scope — but this repo's OWN docs/security/review-session-mode.md documents that a worker leg's `Bash(node
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
   *  `--setting-sources`; see `docs/security/review-session-mode.md`'s "Benchmark isolation recipe" section, which
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
  /** #639: `--plugin-dir <path>` — an engine-rendered, immutable, content-hash-named plugin
   *  directory (skills-plugin.ts's renderSkillsPlugin) carrying the v1 reference skills
   *  (human-merge-only-paths, ac-evidence-tiers), loaded session-scoped and namespaced (verified
   *  against a live `claude` CLI during #639's design probe — distinct from `--add-dir`, which
   *  does NOT load skills). Omitted -> no `--plugin-dir` flag, unchanged behavior for every
   *  caller (today: every caller, since `roles.skills.enabled` defaults false) — the AC's
   *  disabled-path byte-identical-argv regression. Callers decide whether to supply this per
   *  skills-plugin.ts's `shouldInjectSkillsPlugin` policy table — never set for a review-mode
   *  session (peripheral.ts's RoleRunner.run() enforces the exclusion structurally, mirroring
   *  its own `worktree` omission for reviewMode). */
  pluginDir?: string;
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

/** #708: five worker legs (2026-08-05/06 dogfood, events 9573/9578) backgrounded their OWN
 *  verification run via the Bash tool's `run_in_background` parameter, then blocked polling it
 *  until heartbeat-stale reclaim — 2 of 3 lanes lost in one wave, on a suite that (post-#692/
 *  #693/#695) is already self-bounded and needs no polling. A headless single-issue leg has no
 *  legitimate use for backgrounding, so this closes it at the TOOL-SURFACE layer rather than the
 *  prompt layer alone (design-first per the issue: audit before fix).
 *
 *  LIVE-VERIFIED for the BUILT-IN Bash tool's own schema (claude 2.1.223, `claude -p --model
 *  haiku --setting-sources ""`, mimicking this module's own claudeArgs flag shape —
 *  WORKER_ALLOWED_TOOLS/WORKER_DISALLOWED_TOOLS, `--permission-mode auto`): setting
 *  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the spawned process's env removes
 *  `run_in_background` from that schema — an explicit attempt fails `InputValidationError: ...
 *  An unexpected parameter \`run_in_background\` was provided` instead of backgrounding, and the
 *  tool-description text that advertises the parameter is suppressed too, so the model is never
 *  even offered it. This is STRICTLY WIDER than a `--disallowedTools
 *  Bash(run_in_background:true*)` permission rule (also live-verified to work, see #708 PR body
 *  for the transcript) — that rule only intercepts an EXPLICIT `run_in_background: true` tool
 *  call; it cannot reach the CLI's own timeout-triggered auto-backgrounding of an ordinary
 *  FOREGROUND command (a separate code path gated only by this same env var, never by the
 *  permission engine), which every worker-issued long verification command is otherwise eligible
 *  for. Not a CLI flag — `claude --help` (2.1.223) has no background-disabling flag; this env var
 *  is the one working knob.
 *
 *  The `--setting-sources ""` probe deliberately sealed off user/project/local settings so the
 *  measurement isolates the BUILT-IN tool, not this repo's actual dispatch shape: production
 *  `dispatch()`/`resume()` (below) do NOT pass `settingSources` at all, so a real worker session
 *  loads user/project/local settings as it always has — unchanged by this fix, and changing that
 *  is a separate surface question, out of #708's scope. Two accepted residuals follow from that,
 *  named here rather than assumed closed: (1) a command STRING containing shell-level
 *  backgrounding (`... &`, `nohup ... &disown`) is untouched — the CLI never sees it as a
 *  `run_in_background` request, so no schema/permission layer can catch it; (2) a
 *  settings-sourced tool, hook, or plugin the operator's own environment contributes could offer
 *  an async/backgrounding path this constant never reaches, since it only closes the BUILT-IN
 *  Bash tool's own parameter. Both residuals are the same class and carried the same way:
 *  `prompts/worker.md`'s one negative-form sentence (belt-and-suspenders, not the primary
 *  mechanism) plus ordinary operator supervision — neither is a machinery fix.
 *
 *  Scoped to WORKER LEGS ONLY: the engine only ever SETS this env var for WorkerSupervisor's own
 *  `dispatch()`/`resume()` spawns (below) — never for a peripheral/review session
 *  (`spawnClaudeSession`) or a park-probe. Like any spawn env var, it is inherited by descendants
 *  of the worker process, including the guard hook subprocess — but that inheritance is
 *  semantically inert: the guard hook never reads `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, so its
 *  presence there changes nothing. */
export const WORKER_DISABLE_BACKGROUND_TASKS_ENV: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };

/** #679 (CI-repair, PR #835): dispatch()/resume() must OMIT SAPWOOD_DEFAULT_BRANCH from a spawn's
 *  env entirely when `defaultBranch` didn't resolve THIS call — never merely skip ADDING it.
 *  `baseEnv` at both call sites is (or derives from) `process.env` verbatim, so an ambient
 *  SAPWOOD_DEFAULT_BRANCH already exported in the supervisor's OWN process environment — ordinary
 *  on a persistent self-hosted CI runner (unlike an ephemeral hosted one, it carries env across
 *  jobs) and in any worker-dispatched session — would otherwise leak straight through to the
 *  child even on a call this supervisor itself couldn't resolve a branch for, which is exactly
 *  the false "SET" the #679 reverse tests exist to catch (live: PR #835's CI, self-hosted
 *  mac-mini-docker-runner, red on exactly this). A spread that only conditionally ADDS the key
 *  can never remove one the base already carried; explicit deletion is the only thing that
 *  actually guarantees absence regardless of what's ambient. */
function omitStaleDefaultBranch(env: NodeJS.ProcessEnv, defaultBranch: string | undefined): NodeJS.ProcessEnv {
  if (defaultBranch) env.SAPWOOD_DEFAULT_BRANCH = defaultBranch;
  else delete env.SAPWOOD_DEFAULT_BRANCH;
  return env;
}

/** #1010/#1011: the DEFAULT `--permission-mode` value — `host.permissionMode`'s own schema
 *  default (config.ts), kept here too as the literal `claudeArgs`/`permissionModeMismatched` fall
 *  back to when a caller omits `ClaudeArgsOpts.permissionMode` (a fixture built before #1011, or
 *  a probe/ping argv that never threads config through at all). Every PRODUCTION caller
 *  (worker.ts's dispatch()/resume(), peripheral.ts's RoleRunner.run()) now passes the CONFIGURED
 *  `host.permissionMode` explicitly instead of relying on this fallback — see either call site's
 *  own doc. Named so the lane-end mismatch check below compares against a symbol instead of a
 *  second hardcoded literal. */
export const REQUESTED_PERMISSION_MODE = "auto";

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
    o.permissionMode ?? REQUESTED_PERMISSION_MODE,
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
    ...(o.pluginDir ? ["--plugin-dir", o.pluginDir] : []),
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--verbose",
  ];
}

/** #799 gate② P1 #4 fix: EVERY optional `ClaudeArgsOpts` field is deliberately filled in below —
 *  typed `Required<ClaudeArgsOpts>`, not `ClaudeArgsOpts`, so a FUTURE new optional field fails
 *  to COMPILE here until this fixture supplies a value for it. Same completeness discipline as
 *  `unstubbed-forge.test-support.ts`'s `MISSING_FROM_LIST` gives `IForge`: without it, a new
 *  field could add a new long flag that silently never reaches `ENGINE_CLAUDE_LONG_FLAGS` below
 *  (the same class of gap a hand-maintained flag list already failed on once — sol-high gate②
 *  review of #799). `resumeSessionId` is set here (the "resume" shape); the "fresh" shape below
 *  derives from this SAME object with that one field omitted, rather than a second
 *  independently-typed fixture that could itself drift. */
const MAXIMAL_CLAUDE_ARGS_OPTS: Required<ClaudeArgsOpts> = {
  prompt: "prompt",
  model: "model",
  effort: "high",
  fallbackModel: "sonnet",
  worktree: "lane",
  name: "lane",
  sessionId: "session",
  permissionMode: "auto",
  addDir: "/tmp/add-dir",
  settings: "{}",
  resumeSessionId: "prior-session",
  allowedTools: "Read",
  disallowedTools: "Bash",
  mcpConfig: "{}",
  strictMcpConfig: true,
  settingSources: "",
  maxBudgetUsd: 1,
  pluginDir: "/tmp/plugin",
};

/** A long flag: `--xxx`, never a bare value or a short flag (`-p`) — the shape `claude --help`'s
 *  own output lists flags in. */
function isLongFlag(token: string): boolean {
  return /^--[a-zA-Z][a-zA-Z-]*$/.test(token);
}

/** #799 gate② P1 #4 fix (round 1 + round 2, sol-high): the COMPLETE set of long flags the
 *  engine's OWN `claude` invocations can ever emit — derived by actually CALLING `claudeArgs`
 *  (both the fresh-dispatch shape, `--session-id`, and the resume shape, `--resume`),
 *  `llmPingArgv`, AND `versionProbeArgv` with every optional field populated, rather than a
 *  hand-maintained list a future flag could silently miss. Round 1 covered only the worker argv
 *  + the LLM-ping probe (23 flags); round 2 closes the gap sol-high's reproduction found — the
 *  version-floor startup check ALSO spawns `claude` (`probeClaudeVersion`, `["--version"]`), and
 *  that argv had never been folded in, so a real installed CLI's true fresh+resume+ping+version
 *  union (24 flags) exceeded what this set asserted (23). This is what the manual floor-check
 *  script (`engine/scripts/check-claude-cli-flags.ts`) asserts `claude --help` advertises — its
 *  own promise to check EVERY long flag the engine emits across EVERY shape it spawns `claude`
 *  in, not a curated subset. */
export const ENGINE_CLAUDE_LONG_FLAGS: readonly string[] = (() => {
  const { resumeSessionId: _resumeSessionId, ...freshOpts } = MAXIMAL_CLAUDE_ARGS_OPTS;
  const freshArgv = claudeArgs(freshOpts);
  const resumeArgv = claudeArgs(MAXIMAL_CLAUDE_ARGS_OPTS);
  const pingArgv = llmPingArgv("probe-model", 0.05);
  const versionArgv = versionProbeArgv();
  const all = [...freshArgv, ...resumeArgv, ...pingArgv, ...versionArgv].filter(isLongFlag);
  return [...new Set(all)].sort();
})();

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
  /** Directory for sentinels/jsonl/heartbeat. Default <cwd>/.sapwood/sessions/state. */
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
  /** #679: resolves the repository's DEFAULT BRANCH name — the same fact forge.ts's
   *  `getDefaultBranchChecks` already keys on (its `BranchChecksPage.branch` field), so a
   *  base-branch name in sapwood config never becomes a second source of truth for a fact the
   *  forge already owns (same stance DEFAULT_BRANCH_CHECKS_QUERY's own doc takes). Set into the
   *  spawn env as SAPWOOD_DEFAULT_BRANCH (dispatch/resume/fix legs — a fix leg IS a resume()
   *  call, conductor.ts's startFixLeg), the trusted-env fact the #679 guard patch's raw-git-
   *  transport-push deny rule keys its activation on. Omitted -> SAPWOOD_DEFAULT_BRANCH is never
   *  set (the fail-safe direction: the rule stays inactive rather than block on a guessed name),
   *  same "optional, additive, degrades to zero behavior change" contract lanePr above carries. */
  getDefaultBranch?: () => Promise<string>;
  /** Worker prompt for an issue. Default: a minimal imperative skeleton. */
  renderPrompt?: (issue: Issue) => string;
  /** Path to the compiled guard hook (node <path>). Default: the dist sibling of this module. */
  guardHookPath?: string;
  /** #606: injected SSH-auth preflight for `cfg.worker.deployKeyPath` — a test double so
   *  L1-activation tests never shell out to a real `ssh`. Default: probeDeployKeySsh. Probed at
   *  most once per WorkerSupervisor life (see resolveDeployKeyEnv), so this is called at most
   *  once even across many dispatch()/resume() calls. */
  probeDeployKeySsh?: (deployKeyPath: string) => Promise<LlmPingResult>;
  heartbeatMs?: number; // default 30_000
  now: () => Date;
  /** #395: injected timer so a test can deterministically win the spawn-confirmation watchdog
   *  race (util/spawn-confirm.ts's awaitSpawnConfirmation) without depending on real OS
   *  process-spawn timing. Default: a real, cancelable `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** #244 (Codex sol-high PR #260 review, P2): the narrow State surface WorkerSupervisor needs
   *  to record a durable `proxy-mint-failed` event when a `dispatch()` caller's `proxy.mint`
   *  throws, and (#395 gate② round 2/3) `heartbeatTick`'s own progress heartbeat (util/
   *  heartbeat.ts's createHeartbeatGate — `maxEventIdForWorker` is the gate's "don't speak over
   *  other progress FOR THIS LANE" check; #688 scoped this from the prior global `maxEventId`,
   *  which starved every lane but one under concurrent dispatch — see heartbeat.ts's own header
   *  doc) — kept as a `Pick` (not the whole State class), same convention as every other
   *  narrow-state-dependency field in this codebase (e.g. peripheral.ts's RetriedSession.state).
   *  Optional and additive: omitted -> both degrade to zero behavior change (mint-failure
   *  observability falls back to the existing stderr log line; the heartbeat simply never fires)
   *  — never a hard requirement for ordinary dispatch.
   *
   *  #617 (seam 3, capability DR #616): widened with `recordContextManifest` — the SAME narrow-
   *  Pick contract, additive. Omitted -> a lane's context manifest is assembled (best-effort) but
   *  never persisted; recordLaneContextManifest's own doc covers the zero-behavior-change case. */
  state?: Pick<State, "appendEvent" | "maxEventIdForWorker" | "recordContextManifest">;
  /** #617 (seam 3): bounded poll of a lane's still-growing jsonl for its own init line, before
   *  capturing the CLAUDE.md-family half of its context manifest — same rationale and same
   *  defaults (100ms/30s) as peripheral.ts's RoleRunnerDeps fields of the same name; see
   *  capturePreSpawnManifestForLane's own doc. */
  preSpawnCaptureTimeoutMs?: number;
  preSpawnCapturePollMs?: number;
  /** #639: the engine-rendered skills plugin directory (skills-plugin.ts's
   *  resolveSkillsPluginDir — undefined when `roles.skills.enabled` is false, the default),
   *  attached to EVERY worker leg this supervisor spawns: fresh dispatch() AND resume()
   *  (handoff-resume and fix-entry both) — see ClaudeArgsOpts.pluginDir's own doc for the
   *  `shouldInjectSkillsPlugin` policy this implements (every worker-leg kind is YES; only a
   *  review-mode peripheral session, which WorkerSupervisor never runs, is excluded). Omitted ->
   *  no `--plugin-dir` flag, unchanged argv for every existing caller. */
  skillsPluginDir?: string;
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
 *  ambient credential store directly off disk — docs/security/role-sessions.md's residuals note). Same
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
 *  is OS-level sandboxing — container/chroot/Landlock-style filesystem confinement, available as
 *  the operator-configured Bash-sandbox recipe in docs/security/execution-profiles.md's "Execution profiles" section
 *  — or running fix legs under a dedicated, narrowly-scoped CI identity whose credential store
 *  contains nothing worth stealing; the CI-identity path remains unimplemented. This function
 *  alone (`workerCredentialFreeEnv`) provides no filesystem confinement — an operator who has
 *  configured that recipe gets OS-blocked Bash reads of the `denyRead`-listed paths (probed
 *  live: the exact `steal.mjs` read above returns `EPERM`); without that operator configuration
 *  there is no such guarantee, and even with it active the recipe is still not a home-directory
 *  jail (unlisted paths and additive `allowRead` entries remain residuals). One narrowing worth
 *  naming:
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
/** Shared by workerCredentialFreeEnv and workerDeployKeyEnv (#606): every `gh`/git
 *  CREDENTIAL-lookup env var, stripped from `process.env` case-insensitively — the exact
 *  denylist workerCredentialFreeEnv's own doc describes (peripheral.ts's peripheralSessionEnv
 *  denylist). Extracted so the two env-builders can't silently drift apart on what "no ambient
 *  credential" means. */
function stripGhGitCredentialEnv(): NodeJS.ProcessEnv {
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
  return env;
}

export function workerCredentialFreeEnv(ghConfigDir: string): NodeJS.ProcessEnv {
  const env = stripGhGitCredentialEnv();
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** #606 gate② round 1: the deploy-key TRANSPORT overlay ALONE — `GIT_SSH_COMMAND` pins git to
 *  the deploy key (`IdentitiesOnly=yes` refuses every other identity an inherited SSH agent
 *  might offer; `StrictHostKeyChecking=accept-new` keeps a fresh host free of an interactive
 *  prompt without disabling host-key checking altogether), plus `GIT_CONFIG_COUNT`/
 *  `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (git's own env-based config injection — no file
 *  touched, so this rewrite is scoped to THIS spawn's env alone, never the engine's shared repo
 *  checkout) rewriting the origin's HTTPS URL to the SSH form the deploy key authenticates
 *  against. Two `insteadOf` entries cover the origin URL with and without a trailing `.git`
 *  (ponytail: covers the two conventional clone-URL forms this codebase's own gh-provisioned
 *  clones and a manual `git clone` respectively produce; an origin configured to a third,
 *  unconventional HTTPS spelling is a known gap — `git remote get-url origin` per dispatch would
 *  close it but costs a spawn on every leg for a case `sapwood init`'s own repo/owner config
 *  already pins in the overwhelmingly common case).
 *
 *  Extracted out of workerDeployKeyEnv (below) so a `credentialFree` fix leg (P1-4: fix legs
 *  MUST get L1 too, per the issue AC's "every worker leg: dispatch/resume/fix") can COMPOSE this
 *  SAME overlay onto workerCredentialFreeEnv's stricter base, rather than inheriting
 *  workerDeployKeyEnv's own base (which would fight workerCredentialFreeEnv's GH_CONFIG_DIR/
 *  GIT_CONFIG_GLOBAL/SYSTEM choices instead of composing with them — the two base envs strip
 *  the SAME credential family, but a fix leg's base must be workerCredentialFreeEnv's, the
 *  stricter of the two, per that finding). `deployKeyPath` is shell-quoted (P2-9,
 *  shellSingleQuote) — GIT_SSH_COMMAND is shell-PARSED by git, so an unquoted path containing a
 *  space or shell metacharacter would break or mutate the command. */
export function deployKeyTransportOverlay(deployKeyPath: string, owner: string, repo: string): NodeJS.ProcessEnv {
  const sshBase = `git@github.com:${owner}/${repo}.git`;
  const httpsWithGit = `https://github.com/${owner}/${repo}.git`;
  const httpsNoGit = `https://github.com/${owner}/${repo}`;
  return {
    GIT_SSH_COMMAND: `ssh -i ${shellSingleQuote(deployKeyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${sshBase}.insteadOf`,
    GIT_CONFIG_VALUE_0: httpsWithGit,
    GIT_CONFIG_KEY_1: `url.${sshBase}.insteadOf`,
    GIT_CONFIG_VALUE_1: httpsNoGit,
  };
}

/** #606 (#351 final ruling; P1-3 gate② round 1 fix): the L1 scoped-worker-identity env for an
 *  ORDINARY (non-`credentialFree`) leg — a worker leg's write capability reduces to git TRANSPORT
 *  ONLY, via a per-repo SSH deploy key `sapwood init` provisioned. No forge API credential exists
 *  in this env at all — a stolen key's capability equals the granted capability (git push to
 *  this one repo), never an escalation to API writes.
 *
 *  P1-3 (gate② round 1): env-var stripping alone left `HOME` reachable with no `GH_CONFIG_DIR`
 *  repoint and no `GIT_CONFIG_GLOBAL`/`SYSTEM=/dev/null` — `gh` (via a self-constructed path) and
 *  git credential helpers could still resolve `~/.config/gh/hosts.yml`/keychain even with every
 *  GH_-, GITHUB_-, GIT_CONFIG_-prefixed env var stripped. This now composes the SAME full severing
 *  workerCredentialFreeEnv demonstrates (GH_CONFIG_DIR repointed at a fresh, empty, per-lane
 *  directory the caller creates; GIT_CONFIG_GLOBAL/SYSTEM=/dev/null; GIT_TERMINAL_PROMPT=0) with
 *  deployKeyTransportOverlay's git-transport identity — "transport-only" now means what the docs
 *  claim. NOTE: GIT_CONFIG_GLOBAL=/dev/null nulls git's FILE-based global config, while
 *  GIT_CONFIG_COUNT/KEY_n/VALUE_n injects config via env vars — a DIFFERENT mechanism entirely,
 *  so the two are not in tension: the env-injected url.insteadOf rewrite still applies even
 *  though the (irrelevant, now-nulled) global config file is never read. */
export function workerDeployKeyEnv(deployKeyPath: string, ghConfigDir: string, owner: string, repo: string): NodeJS.ProcessEnv {
  return {
    ...workerCredentialFreeEnv(ghConfigDir),
    ...deployKeyTransportOverlay(deployKeyPath, owner, repo),
  };
}

/** #606: `sapwood init`'s ed25519 keypair generation for the L1 deploy key — `spawn` only (this
 *  module's own #69 invariant, enforced by worker.test.ts's grep-invariant test: no other child-
 *  process launcher API is permitted anywhere in worker.ts, and worker.ts is one of only four
 *  modules in the whole engine allowed to import `node:child_process` at all), so this lives here
 *  rather than pulling `node:child_process` into `loop/init.ts` (init.ts imports it as its
 *  `sshKeygen` dep's default). `-N ""` -> no passphrase (the engine must read the key
 *  unattended); `-C` names the key for a human browsing the repo's deploy-key list. Rejects on a
 *  non-zero exit or spawn error — a one-shot init-time operation, never on a worker leg's own
 *  spawn path, so unlike probeLlmPing/probeDeployKeySsh it has no need for their never-throw
 *  contract. */
export function spawnSshKeygen(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-C", "sapwood-worker"], { stdio: "ignore" });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ssh-keygen exited ${code}`));
    });
  });
}

/** #606: the L1 preflight — proves the deploy key at `deployKeyPath` actually authenticates
 *  against GitHub over SSH, the same signal `sapwood init`'s own preflight checks at provisioning
 *  time. GitHub's SSH endpoint never grants shell access even to a valid key: a successful auth
 *  is `ssh -T git@github.com` exiting 1 with stderr containing "successfully authenticated" — NOT
 *  exit 0 (that shape, per GitHub's documented behavior, means the connection never reached
 *  authentication at all). Authoritative-signal doctrine: this checks that exact documented
 *  success text, not a bare "did ssh exit nonzero" — a network error or an unrelated ssh failure
 *  also exits nonzero and must not be misread as a working key. Never throws: a spawn error, a
 *  timeout (hard-killed), or any output not matching the success shape all resolve `{ok:false}`
 *  with a detail string — the caller's job (WARN + fall back to L0), never this function's.
 *  `sshBin` (default `"ssh"`, resolved off PATH) mirrors probeLlmPing's own `claudeBin` param —
 *  an explicit override so tests can point this at a stub script instead of a real network call. */
export function probeDeployKeySsh(deployKeyPath: string, timeoutSec = 15, sshBin = "ssh"): Promise<LlmPingResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: LlmPingResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(
        sshBin,
        [
          "-T",
          "-i",
          deployKeyPath,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "BatchMode=yes",
          "git@github.com",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      finish({ ok: false, detail: `ssh spawn failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, detail: `ssh auth probe timed out after ${timeoutSec}s (hard-killed)` });
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, detail: `ssh spawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 1 && stderr.toLowerCase().includes("successfully authenticated")) {
        finish({ ok: true });
        return;
      }
      const firstLine = stderr.trim().split("\n")[0]?.trim() ?? "";
      finish({ ok: false, detail: firstLine || `ssh exited ${code} with no recognizable auth response` });
    });
  });
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

/** #834 (gate② round 1, F4): re-verifies a FRESHLY-RENAMED tombstone directory against the SAME
 *  purity baseline settleWorktreeDirectory's first (pre-rename) pass already confirmed clean,
 *  WITHOUT the rename operation itself producing a false "dirty" verdict. `rename()` bumps the
 *  renamed directory's OWN ctime (observed OS behavior, not POSIX-mandated but real on every
 *  filesystem this engine ships against) — `worktreeMaybeDirty`'s inclusive ctime check would
 *  therefore ALWAYS read a just-renamed tombstone as dirty, even when nothing under it actually
 *  changed. The fix is LOCAL and NARROW, never a change to `worktreeMaybeDirty` itself (other
 *  callers — peripheral.ts's retention check, this file's own dispatch-baselined checks — must
 *  keep the full mtime-or-ctime rule unweakened): the tombstone's OWN top-level entry is checked
 *  by MTIME ONLY (a top-level add/remove still bumps mtime, so that half of the race-detection
 *  invariant survives intact); every entry BELOW the top level is untouched by the rename (moving
 *  a directory changes only the moved inode's own parent-pointer, never its children's metadata),
 *  so those are checked with the FULL, UNMODIFIED `worktreeMaybeDirty` — a directory's real
 *  purity coverage is unchanged one level down and beyond.
 *
 *  Exported (not module-private) SOLELY for direct unit coverage of this exact discrimination —
 *  the top-level-ctime-exclusion behavior is otherwise only reachable through a REAL rename
 *  (settleWorktreeDirectory's own tests), which cannot deterministically construct the "old
 *  mtime, fresh ctime" shape without either real elapsed time or exactly the fixed-past-date
 *  trick worker.test.ts's own dedicated test for this function uses. Production code only ever
 *  reaches it through settleWorktreeDirectory, immediately after its own rename.
 *
 *  THREAT MODEL (gate② round 2, G4 — the PO's own adjudication; wording corrected round 3, W3):
 *  this function, like the worktreeMaybeDirty family it composes with, assumes a
 *  TIMESTAMP-HONEST writer — it fences ACCIDENTS (a lane that happened to still be writing),
 *  never ADVERSARIES. A writer that deliberately unlinks a TOP-LEVEL entry and then forges the
 *  tombstone root's OWN mtime backward via `utimes` (to make the removal look like it never
 *  happened) evades THIS function specifically — but NOT the family equally: `worktreeMaybeDirty`
 *  itself, run against the SAME shape, still catches it, because it checks the top-level
 *  directory's CTIME too, and ctime cannot be backdated (the very entry-removal that forged the
 *  mtime necessarily bumps it fresh). `tombstoneMaybeDirty` alone misses it, precisely BECAUSE it
 *  deliberately excludes the tombstone root's ctime (the top-level-ctime-exclusion this whole
 *  function exists for, per its own doc above) — worker.test.ts's own top-level-exclusion test
 *  demonstrates the exact mechanism this blind spot rides on. So this is an ACCEPTED, NARROW
 *  blind spot specific to this one function's tombstone-root check, opened by the very
 *  rename-ctime exclusion that makes it work at all — not a claim that every mtime/ctime check in
 *  this file is equally exposed. It is still out of scope, under the SAME accident-fence-not-
 *  adversary-jail threat model the rest of this file's mtime/ctime discipline has always had:
 *  this machinery has never claimed to jail an adversary with write access to the tree it's
 *  judging, and closing this one function's narrow gap would not change that posture. */
export function tombstoneMaybeDirty(tombstonePath: string, sinceMs: number): boolean {
  if (!Number.isFinite(sinceMs)) return true;
  let topStat: ReturnType<typeof lstatSync>;
  let entries: Dirent[];
  try {
    topStat = lstatSync(tombstonePath);
    if (topStat.mtimeMs >= sinceMs) return true; // a top-level add/remove -> genuinely dirty
    entries = readdirSync(tombstonePath, { withFileTypes: true });
  } catch {
    return true; // unreadable -> fail-safe dirty, same stance as worktreeMaybeDirty
  }
  for (const e of entries) {
    if (e.name === ".git") continue;
    const p = join(tombstonePath, e.name);
    if (e.isDirectory()) {
      if (worktreeMaybeDirty(p, sinceMs)) return true; // full mtime-or-ctime scan, unmodified
      continue;
    }
    try {
      const s = lstatSync(p);
      if (s.mtimeMs >= sinceMs || s.ctimeMs >= sinceMs) return true;
    } catch {
      return true; // unstatable -> fail-safe dirty
    }
  }
  return false;
}

/** #834 (gate② round 1, F1/F4): the verdict settleWorktreeDirectory reaches. `"settled"` is the
 *  ONLY verdict under which the directory is PROVABLY gone from disk — the sole state a caller
 *  may act on by pruning the (now-orphaned) git-worktree registration. `"retained"` covers both
 *  a genuinely dirty tree AND a rename that failed outright (the directory is untouched, still
 *  at its original path, either way) — a caller cannot tell the two apart from this verdict
 *  alone and must not need to: neither one is ever safe to delete or prune. `"failed"` is the
 *  narrow TOCTOU/partial-removal residue: something was ALREADY moved (or a re-verified-dirty
 *  tombstone's rename-back itself failed) and the directory may no longer be at its original
 *  path — a caller must never claim "settled" (nothing proven deleted) NOR silently reuse the
 *  "retained" label (that would misreport a WIP-preserving skip as this operation's own
 *  in-progress mutation); `reason` carries a short diagnostic for the event/log a caller
 *  attaches. */
export type WorktreeDirectorySettleVerdict = "settled" | "retained" | "failed";

export interface WorktreeDirectorySettleOutcome {
  verdict: WorktreeDirectorySettleVerdict;
  /** Present only for `"failed"`. */
  reason?: string;
  /** #834 (gate② round 2, G2; wording corrected round 3, W1): present on EVERY `"failed"`
   *  verdict this function can reach (all three happen strictly AFTER the first rename already
   *  succeeded: a re-verified-dirty tombstone whose rename-back itself failed, a post-rename
   *  `rm` that threw, or one that reported success while the tombstone was still present). This
   *  is where any SURVIVING residue would be found — NOT a claim that everything survives: a
   *  recursive removal can delete several entries before failing on a later one, so a `"failed"`
   *  verdict from the two post-rm branches may find only PARTIAL residue at this path (the
   *  rename-back-failure branch is the one exception where nothing was ever deleted, since `rm`
   *  is never reached on that path — see settleWorktreeDirectory's own per-branch comments).
   *  Absent on `"retained"` (data is always still at the ORIGINAL path there — either genuinely
   *  dirty and never touched, or the very first rename failed outright) and on `"settled"`
   *  (deletion is PROVEN complete). Callers must surface this path, never the stale original
   *  one, when reporting a `"failed"` verdict — see settleMergedLane's own doc. */
  tombstonePath?: string;
}

/** #834 (gate② round 1, F1 + F4): the ONE clean-worktree-deletion primitive shared by worker.ts's
 *  own settleMergedWorktree (Phase 1) and worktree-janitor.ts's present-directory sweep (Phase
 *  2) — a single implementation, two callers, per the owner's explicit instruction. Callers own
 *  their own existence/root-containment checks and the purity baseline; this function assumes
 *  `worktreePath` exists, is already proven inside `worktreeRoot`, and `baselineMs` is the
 *  correct baseline for the caller's own policy (Phase 1: the worktree's own git-index mtime;
 *  Phase 2: the same, resolved per-candidate).
 *
 *  TOCTOU discipline (F4): a plain "check dirty, then rmSync" has a race window between the
 *  purity read and the deletion — a writer can land a file in that window and lose it silently.
 *  This closes the window with a RENAME-THEN-VERIFY tombstone step: `renameSync` the directory
 *  to a fresh tombstone path INSIDE `worktreeRoot` FIRST (an atomic, single-syscall operation —
 *  once it succeeds, no writer can find the original path to land a new file in), THEN
 *  re-verify the TOMBSTONE (not the original path, which no longer exists) against the SAME
 *  baseline via tombstoneMaybeDirty (see its own doc for why a plain worktreeMaybeDirty call
 *  would false-positive here), and only THEN rmSync the tombstone. A re-verified-dirty tombstone
 *  is renamed BACK to its original path when possible (nothing about the lane's on-disk state
 *  changes from a failed attempt) — if even the rename-back fails, the tombstone is left in
 *  place (never at the original path) and reported as `"failed"`, never silently lost. (Round 3,
 *  W1: "left in place" here is exact — no `rm` has run yet on this branch, so nothing has been
 *  deleted. The OTHER two `"failed"` branches, below, run AFTER `rm` — deletion there may be only
 *  PARTIALLY complete, never assume full preservation from the verdict alone.)
 *
 *  F1 (deletion-safety): `"settled"` is returned ONLY after `existsSync(tombstonePath)` confirms
 *  the tombstone is actually gone post-`rmSync` — an rmSync that throws, or one that reports
 *  success while something still occupies the path (a mount-point oddity, a permissions quirk),
 *  is `"failed"`, never a lied-about `"settled"`. This is the exact fix for gate①'s finding: the
 *  old code swallowed rmSync's error and unconditionally claimed clean, which let the CONDUCTOR
 *  run `git worktree unlock/remove` against a still-present, worker-controlled directory — the
 *  #65 clean-check RCE class this whole file's discipline exists to close.
 *
 *  Honest crash-window disclosure: a process kill between the rename and a would-be rename-back
 *  leaves a tombstone directory (under `<name>-settle-tombstone-*`) whose data is fully
 *  preserved on disk, with the git-worktree registration for the ORIGINAL path now dangling
 *  (its directory moved out from under it). That dangling registration is exactly the shape
 *  #825's own missing-directory janitor pass already reaps (dead-pid/no-directory -> "reap") —
 *  no new recovery machinery is needed; the existing food source just gained one more producer.
 *
 *  RESIDUAL RACE WINDOW (gate② round 2, G3 — the PO's own adjudication, recorded here so the
 *  next reader doesn't have to re-derive it): the rename-then-verify-then-delete sequence above
 *  closes the ORIGINAL check-then-delete race (a writer landing a file between the purity read
 *  and the deletion, invisibly, over the whole scan+delete duration) down to a MUCH smaller one
 *  — but does not close it to zero. A writer that already holds an open file descriptor into the
 *  worktree (or one that independently discovers the tombstone's generated path and writes into
 *  it) can still land a write strictly AFTER tombstoneMaybeDirty's re-verify and strictly BEFORE
 *  (or DURING) `fsOps.rm`'s own recursive walk — no check-then-delete sequence, however tight,
 *  can close a window against a writer already inside the door. This is accepted, deliberately,
 *  not fenced: (1) it is definitionally unclosable in userspace — the ONLY closing move
 *  (deleting under a lock a live writer respects) doesn't exist for a plain directory tree; (2)
 *  it is out of proportion for the classes this function actually gates — Phase 1 only ever
 *  calls this AFTER the lane's own process has exited at MERGED close-out (no live writer to
 *  race), and Phase 2 only ever calls this for a dead-pid or 24h-git-quiescent registration (no
 *  plausible fd-holder either). The rename is still worth doing — a real, if not total,
 *  reduction: it shrinks the exposed window from "the whole scan-plus-delete duration, at a
 *  path anyone can still find" down to the re-verify-plus-recursive-removal interval, at a
 *  path nothing else has any reason to know about. (Round 3, W2: no numeric bound is claimed —
 *  that interval scales with the tree's size and the filesystem's speed, and the paragraph
 *  above already admits a writer can land a change DURING `fsOps.rm`'s own walk; "microseconds"
 *  was false on a large tree or a slow filesystem.) */
/** #834 (gate② round 1, F1): the two raw fs primitives settleWorktreeDirectory needs, as an
 *  injectable seam — real defaults (`renameSync`/`rmSync`) for production, a fake for tests that
 *  need to exercise the "removal didn't actually complete" path DETERMINISTICALLY (a real
 *  permission-based failure is OS/filesystem/uid dependent — e.g. root ignores mode bits on many
 *  systems — so a seam is the reliable way to pin the F1 regression, not a race against the
 *  platform). */
export interface WorktreeDirectoryFsOps {
  rename(oldPath: string, newPath: string): void;
  rm(path: string): void;
}

const defaultWorktreeDirectoryFsOps: WorktreeDirectoryFsOps = {
  rename: renameSync,
  rm: (path) => rmSync(path, { recursive: true, force: true }),
};

export function settleWorktreeDirectory(
  worktreePath: string,
  worktreeRoot: string,
  baselineMs: number,
  fsOps: WorktreeDirectoryFsOps = defaultWorktreeDirectoryFsOps,
): WorktreeDirectorySettleOutcome {
  if (worktreeMaybeDirty(worktreePath, baselineMs)) return { verdict: "retained" };
  const tombstonePath = join(worktreeRoot, `.settle-tombstone-${randomUUID()}`);
  try {
    fsOps.rename(worktreePath, tombstonePath);
  } catch {
    return { verdict: "retained" }; // untouched at its original path — the safe default
  }
  let stillDirty: boolean;
  try {
    stillDirty = tombstoneMaybeDirty(tombstonePath, baselineMs);
  } catch {
    stillDirty = true; // fail-safe: never proceed to delete on an unreadable re-verify
  }
  if (stillDirty) {
    // A writer raced in between the first purity read and the rename. Put it back where it was
    // — a failed attempt must change nothing about the lane's on-disk state.
    try {
      fsOps.rename(tombstonePath, worktreePath);
      return { verdict: "retained" };
    } catch (error) {
      // The data is intact, just no longer at the original path. Never delete data that
      // re-verified dirty — leave the tombstone in place and say so honestly. #834 (gate② round
      // 2, G2): carry the TOMBSTONE path — the original path no longer holds this data, and a
      // caller reporting the stale original path would misdirect anyone trying to salvage it.
      return { verdict: "failed", reason: `re-verified dirty; rename-back failed: ${String(error)}`, tombstonePath };
    }
  }
  try {
    fsOps.rm(tombstonePath);
  } catch (error) {
    // F1 (gate② round 1): a swallowed rmSync error used to fall through to an unconditional
    // "clean, settled" claim — the caller would then run `git worktree unlock/remove` against a
    // directory that (per this catch) may still be fully present, the exact #65 clean-check RCE
    // class this file's whole discipline exists to close. Report the truth instead: never
    // "settled" unless deletion is PROVEN, below. (G2: tombstonePath carried — see above.)
    return { verdict: "failed", reason: `tombstone removal failed: ${String(error)}`, tombstonePath };
  }
  if (existsSync(tombstonePath)) {
    // F1: a `rm` that reports success without actually removing everything (a mount-point
    // oddity, a fake in a test) must not be trusted at face value either — verify the tombstone
    // is PROVABLY gone before ever claiming "settled". (G2: tombstonePath carried — see above.)
    return { verdict: "failed", reason: "tombstone still present after removal", tombstonePath };
  }
  return { verdict: "settled" };
}

/** #834 (gate② round 1, F3): the same out-of-root discipline worktree-janitor.ts's own
 *  `classifyRegistration`/`isUnderRoot` already applies to every registration it touches —
 *  duplicated here (a genuinely tiny, three-line pure function) rather than imported, since
 *  worktree-janitor.ts already imports FROM this file (`worktreeMaybeDirty`) and importing back
 *  the other way would create a circular module dependency for zero real benefit. Never equal to
 *  `root` itself (the root directory is never a single lane's worktree). */
function isUnderWorktreeRoot(candidatePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidatePath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
  // #668 (round 5 pivot; keying fixed round 6 P1b): tracks reap operations onExit() kicks off,
  // fire-and-forget from its OWN synchronous perspective, for a leader that just exited while its
  // process GROUP was still alive (a descendant outliving it) — see onExit's own doc for why
  // reaping happens THERE now, immediately, instead of in a durable registry checked later at
  // engine exit (the design rounds 2-4 tried and retired). An entry exists only while its reap is
  // still running, deleted the instant reapDescendantsOnLeaderExit's own promise settles.
  // reapAll() (the engine-exit path) awaits every entry still present here before it can itself
  // return — an in-flight reap started moments before shutdown must still be allowed to finish,
  // never abandoned just because the engine is on its way out (AC4: no orphan group on exit).
  //
  // Keyed by `${laneName}#${pid}`, NEVER bare lane name (round 6 P1b, Codex): a lane name can be
  // RESPAWNED under the same name (resume()'s entire fix-leg/handoff-resume design — its
  // precondition is literally "a terminal sentinel already exists for this name") while an
  // EARLIER leg's own leader-exit reap for that SAME name is still running. A bare-name key would
  // let the fresh spawn's `.set(name, ...)` silently REPLACE (and thereby abandon, from
  // reapAll()'s perspective) the still-in-flight prior promise — the exact same class of bug this
  // round's own predecessor (the pgidRegistry) was retired for creating. The pid disambiguates:
  // each real spawn gets a genuinely fresh OS pid, so two legs sharing a name can never share a
  // key. `dispatch()`/`resume()` both await any matching (same-name-prefixed) in-flight entry
  // before spawning a replacement — see `awaitInFlightLeaderExitReapsFor`'s own doc.
  private readonly inFlightLeaderExitReaps = new Map<string, Promise<ReapOutcome>>();
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
  // #606: memoized SSH-auth preflight for cfg.worker.deployKeyPath — probed at most once per
  // supervisor life (mirrors detectManagedPermissionMode/detectRapidRestart's "once per engine
  // start" stance for a degrade WARN). undefined = not yet probed; a settled Promise thereafter,
  // so every dispatch()/resume() after the first awaits the SAME probe rather than re-shelling
  // to `ssh` per lane. The WARN-on-failure log fires exactly once, inside the Promise's own
  // `.then` (see resolveDeployKeyEnv), never re-logged on a later dispatch that just re-awaits it.
  private deployKeyProbe?: Promise<LlmPingResult>;
  // #679: memoized SAPWOOD_DEFAULT_BRANCH resolution — same "probe once per supervisor life"
  // stance as deployKeyProbe above (see resolveDefaultBranch's own doc for the rationale).
  private defaultBranchProbe?: Promise<string>;

  constructor(private readonly deps: WorkerDeps) {
    if (deps.stateDir !== undefined) {
      this.dir = deps.stateDir;
    } else {
      // This runner lives inside the lock-owning engine process (never the entry point that
      // arbitrates the instance lock itself), so stamping here is safe: ensureRuntimeRoot is
      // idempotent, and a default-root writer must never leave an unstamped root behind.
      const root = defaultRuntimeRoot();
      ensureRuntimeRoot(root);
      this.dir = runtimePaths(root).sessionsStateDir;
    }
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

  /** #606 gate② round 1 (P1-4): resolves whether the L1 scoped-worker-identity deploy key is
   *  usable for THIS dispatch/resume/fix leg — called UNCONDITIONALLY now (both by an ordinary
   *  leg building its own workerDeployKeyEnv, and by a `credentialFree` leg deciding whether to
   *  compose deployKeyTransportOverlay onto its stricter base), since a fix leg needs to know
   *  this too. Returns `undefined` (⇒ caller falls back to whatever its OWN base env already is)
   *  when `cfg.worker.deployKeyPath` is unset, or when the memoized SSH-auth preflight against it
   *  has failed — never throws, never blocks a dispatch. The preflight itself runs at most once
   *  per supervisor life (`this.deployKeyProbe`); a failure logs the guidance-carrying WARN
   *  exactly once, inside the memoized promise's own `.then`, so replaying this method on a
   *  later dispatch re-awaits the SAME settled promise without re-logging or re-shelling to
   *  `ssh`. */
  private async resolveDeployKeyPath(): Promise<string | undefined> {
    const path = this.deps.cfg.worker.deployKeyPath;
    if (!path) return undefined;
    if (this.deployKeyProbe === undefined) {
      this.deployKeyProbe = (this.deps.probeDeployKeySsh ?? probeDeployKeySsh)(path).then((r) => {
        if (!r.ok) {
          this.log(
            `[sapwood:deploy-key] L1 preflight failed for ${path}${r.detail ? `: ${r.detail}` : ""} — ` +
              `re-run "sapwood init" to re-provision the deploy key (see <${DOC_LINKS.security}>'s worker ` +
              `credential tiers). Dispatch continues at L0 (full credentialed env) until then; nothing wedges.`,
          );
        }
        return r;
      });
    }
    const result = await this.deployKeyProbe;
    return result.ok ? path : undefined;
  }

  /** #679: resolves the repository's default branch name for the SAPWOOD_DEFAULT_BRANCH spawn
   *  env — the same fact WorkerDeps.getDefaultBranch's own doc points at (forge.ts's
   *  `getDefaultBranchChecks`, via a bound closure so worker.ts never depends on the forge
   *  interface directly, the same convention `lanePr` already uses). Memoized once per
   *  supervisor life (mirrors resolveDeployKeyPath's `deployKeyProbe`): the default branch
   *  essentially never changes mid-run, and a dispatch/resume/fix-leg spawn should never block
   *  on a fresh GraphQL round-trip when a prior one on this same instance already answered.
   *  Returns "" (never throws) when `deps.getDefaultBranch` is unset OR its call rejects — a
   *  read failure degrades to "SAPWOOD_DEFAULT_BRANCH omitted, rule inactive", never a blocked
   *  dispatch over a best-effort defense-in-depth fact (#679's guard patch treats unset the same
   *  as "not an engine-dispatched session"). */
  private async resolveDefaultBranch(): Promise<string> {
    if (!this.deps.getDefaultBranch) return "";
    if (this.defaultBranchProbe === undefined) {
      const getDefaultBranch = this.deps.getDefaultBranch;
      this.defaultBranchProbe = getDefaultBranch().catch((e) => {
        this.log(
          `[sapwood:worker] failed to resolve the repository's default branch (non-fatal, SAPWOOD_DEFAULT_BRANCH omitted): ${e instanceof Error ? e.message : String(e)}`,
        );
        return "";
      });
    }
    return this.defaultBranchProbe;
  }

  /** #671: public wrapper around resolveDeployKeyPath()'s memoized SSH preflight, for cli.ts's
   *  startup deploy-key tier check (deploy-key-startup-check.ts). Triggering the preflight here
   *  SEEDS `this.deployKeyProbe`, so the first real dispatch()/resume() later on this SAME
   *  instance just re-awaits the settled promise instead of re-shelling to `ssh` — startup +
   *  first dispatch cost at most one SSH probe total. Returns `undefined` when
   *  `cfg.worker.deployKeyPath` is unset (nothing to probe); otherwise the settled
   *  {ok, detail} the memoized preflight resolved to, so the caller can report the failure
   *  detail itself rather than re-deriving it. Never throws — same stance as
   *  resolveDeployKeyPath, which this delegates to entirely. */
  async checkDeployKeyPreflight(): Promise<LlmPingResult | undefined> {
    if (!this.deps.cfg.worker.deployKeyPath) return undefined;
    await this.resolveDeployKeyPath();
    return this.deployKeyProbe;
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

  /** #1010: the SAME lane-end jsonl read recordEgressSuspects above uses, checking one more thing
   *  — whether THIS leg's own init line reported an effective host permission mode different from
   *  what the engine requested. `legJsonl` (not the whole-session jsonl) so a resumed lane's event
   *  reflects the CURRENT leg's own init line, never a stale one from an earlier leg still sitting
   *  in the same append-only file. Fail-safe, allow direction: never gates the lane's own outcome
   *  (the terminal sentinel has already landed by the time this runs), and `permissionModeMismatched`
   *  itself treats a `null` (unparseable/absent field) as no-mismatch rather than manufacturing a
   *  false positive. Best-effort, same allow-direction catch as its sibling above.
   *
   *  #1011: "what the engine requested" is now `cfg.host.permissionMode` — the SAME configured
   *  value dispatch()/resume() pass to `claudeArgs`' `permissionMode` opt, never the bare
   *  REQUESTED_PERMISSION_MODE fallback constant (which only fires for a caller that omits the
   *  opt entirely). A `dontAsk`/`bypassPermissions` deployment must compare against ITS OWN
   *  configured mode, or every leg would misreport a false mismatch. */
  private recordPermissionModeMismatch(worker: string, issue: number, sessionId: string, legJsonl: string): void {
    if (!this.deps.state) return;
    try {
      const effective = parseSessionInit(legJsonl).permissionMode;
      const requested = this.deps.cfg.host.permissionMode;
      if (permissionModeMismatched(effective, requested)) {
        this.deps.state.appendEvent("permission-mode-mismatch", {
          worker,
          issue,
          session_id: sessionId,
          requested,
          effective,
        });
      }
    } catch (e) {
      this.log(`[sapwood:worker] lane ${worker}: permission-mode-mismatch check failed (non-fatal): ${String(e)}`);
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

  /** #705: `pid`/`worktreePath` are the live-process identity `status`'s runtime anchors read
   *  back off the `lane-spawned` event conductor.ts appends from this return value — `pid` is
   *  `child.pid` at the moment this method returns (never null on a genuinely successful spawn;
   *  typed nullable only for defensive symmetry with resume()'s adoption branch), `worktreePath`
   *  is the SAME `resolve(this.worktreeRoot, laneName)` expression the spawn env
   *  (`SAPWOOD_WORKTREE_ROOT`) and the pre-spawn manifest capture below already use — one
   *  convention, not a second derivation that could drift from it. */
  async dispatch(
    issue: Issue,
    name?: string,
    opts?: { proxy?: WorkerProxyOpts },
  ): Promise<{ name: string; sessionId: string; pid: number | null; worktreePath: string }> {
    const laneName = name ?? `lane-${issue.number}-${randomUUID().slice(0, 8)}`;
    // #668 (round 6 P1b): wait out any leader-exit reap still in flight for this SAME name before
    // doing anything else — see awaitInFlightLeaderExitReapsFor's own doc. A no-op (resolves
    // immediately) for the overwhelmingly common case (a freshly-generated, never-before-seen
    // name); only matters for an explicitly caller-supplied `name` colliding with one.
    await this.awaitInFlightLeaderExitReapsFor(laneName);
    // Refuse name reuse — a stale sentinel under this name means a concurrent/old lane; a
    // second worker would clobber its jsonl/sentinels.
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
    // #606 gate② round 1 (P1-4): resolved BEFORE argv/mkdir (same ordering rule as the proxy mint
    // above: --allowedTools needs to know NOW whether this leg's `gh` grant should narrow), and
    // UNCONDITIONALLY — a credentialFree fix leg needs to know this too, to COMPOSE the deploy
    // key's transport overlay onto its own stricter base env (see baseEnv below). No longer
    // "mutually exclusive" with credentialFree — the two postures COMPOSE.
    const deployKeyPath = await this.resolveDeployKeyPath();
    // #679: resolved unconditionally too — every dispatch gets SAPWOOD_DEFAULT_BRANCH in its
    // spawn env when deps.getDefaultBranch is wired (see resolveDefaultBranch's own doc).
    const defaultBranch = await this.resolveDefaultBranch();
    // #244 (Codex sol-high PR #260 review, P1) + #606 gate② round 1 (P1-3): a fresh, empty,
    // per-lane GH_CONFIG_DIR — created whenever EITHER credentialFree OR an L1 deploy key is in
    // play (cheap, and keeps the directory's lifecycle tied to the lane's own stateDir rather
    // than conditioned on opts). Only actually pointed at by the spawn env in either of those
    // cases (workerCredentialFreeEnv/workerDeployKeyEnv below).
    const ghConfigDir = this.path(laneName, "gh-config-empty");
    if (opts?.proxy?.credentialFree || deployKeyPath) mkdirSync(ghConfigDir, { recursive: true });
    // Non-credentialFree L1: build the full workerDeployKeyEnv here (used as baseEnv below).
    // credentialFree legs compose deployKeyTransportOverlay onto workerCredentialFreeEnv instead
    // (see baseEnv) — deployKeyEnv here stays undefined for them, on purpose.
    const deployKeyEnv =
      !opts?.proxy?.credentialFree && deployKeyPath
        ? workerDeployKeyEnv(deployKeyPath, ghConfigDir, this.deps.cfg.board.owner, this.deps.cfg.board.repo)
        : undefined;
    // NB: NO --add-dir for the engine `.sapwood/` tree — mounting it would let the worker write its
    // own .done/.failed or mutate state, defeating wrapper-signaled completion (Codex R3 P1).
    const args = claudeArgs({
      prompt,
      model: this.deps.cfg.worker.model,
      effort: this.deps.cfg.worker.effort,
      fallbackModel: this.deps.cfg.worker.fallbackModel,
      worktree: laneName,
      name: laneName,
      sessionId,
      // #1011: the configured mode, never the bare REQUESTED_PERMISSION_MODE fallback — see
      // ClaudeArgsOpts.permissionMode's own doc.
      permissionMode: this.deps.cfg.host.permissionMode,
      settings: settingsJson,
      // #244: widen --allowedTools with the proxy's own (role-scoped) tool names, same pattern
      // as peripheral.ts's RoleRunner — only when a proxy actually minted; unattached dispatch
      // (today's default) passes neither flag, byte-identical to pre-#244 behavior. A
      // credentialFree leg's BASE list drops `Bash(gh *)` (Codex sol-high PR #260 review, P1) —
      // its env can no longer authenticate `gh` at all, so the grant itself narrows to match.
      // #606: an L1 leg (deployKeyEnv resolved, no proxy involved) gets the SAME NO_GH narrowing
      // — its env carries no forge API credential at all, so the `gh` grant is equally unusable.
      ...(proxyHandle || deployKeyEnv
        ? {
            allowedTools: [
              opts?.proxy?.credentialFree || deployKeyEnv ? WORKER_ALLOWED_TOOLS_NO_GH : WORKER_ALLOWED_TOOLS,
              ...(proxyHandle?.toolNames ?? []),
            ].join(","),
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
      // #639: fresh dispatch is `shouldInjectSkillsPlugin("worker-dispatch")` — always YES per
      // the policy table (see ClaudeArgsOpts.pluginDir's doc); the actual value is undefined
      // whenever `roles.skills.enabled` is false, so this is a no-op flag for every deployment
      // until that config is flipped on.
      ...(shouldInjectSkillsPlugin("worker-dispatch") && this.deps.skillsPluginDir ? { pluginDir: this.deps.skillsPluginDir } : {}),
    });
    // detached: child is its own process-group leader -> reclaim can SIGKILL the whole tree.
    // SAPWOOD_GUARD_MODE in the spawn env reaches the hook subprocess (inherited from claude)
    // but is NOT worker-writable, so a worker can't flip its own guard hard->soft (#26).
    // SAPWOOD_WORKTREE_ROOT (#235 PR-A): the ABSOLUTE path of THIS lane's worktree, so the
    // guard hook can confine Read/Grep/Glob to it (see guard.ts's checkReadContainment).
    // resolve()'d because this.worktreeRoot may be a relative deps override — the guard
    // needs an absolute root to compare against Claude Code's absolute tool_input paths.
    // #244: baseEnv is credential-stripped (workerCredentialFreeEnv, #260 review: env vars +
    // GH_CONFIG_DIR + GIT_CONFIG_GLOBAL/SYSTEM + GIT_TERMINAL_PROMPT + no SSH_AUTH_SOCK) when
    // opts.proxy.credentialFree is set — every other caller (today's entire production dispatch
    // path) keeps inheriting process.env verbatim, unchanged from pre-#244 behavior (worker.
    // test.ts's own regression: "unlike peripherals, workers legitimately [need GH_TOKEN]"),
    // UNLESS #606's L1 env resolved above — deployKeyEnv already carries no forge API credential
    // either, just a scoped git-transport identity instead of a bare-stripped one.
    //
    // #606 gate② round 1 (P1-4): a credentialFree leg with a preflight-green deploy key COMPOSES
    // deployKeyTransportOverlay onto workerCredentialFreeEnv's stricter base — so a fix leg (which
    // ALWAYS dispatches with credentialFree:true, conductor.ts's startFixLeg) can push its fix via
    // the deploy key while keeping every bit of credential-free isolation (GH_CONFIG_DIR/
    // GIT_CONFIG_GLOBAL/SYSTEM/GIT_TERMINAL_PROMPT stay workerCredentialFreeEnv's, not
    // workerDeployKeyEnv's own — GH_CONFIG_DIR in particular stays the empty per-lane dir, never
    // re-pointed by the overlay, which only ever adds GIT_SSH_COMMAND/GIT_CONFIG_*). When
    // credentialFree is set but no deploy key resolved, this is byte-identical to before (today's
    // credentialFree behavior, untouched).
    const baseEnv = opts?.proxy?.credentialFree
      ? {
          ...workerCredentialFreeEnv(ghConfigDir),
          ...(deployKeyPath ? deployKeyTransportOverlay(deployKeyPath, this.deps.cfg.board.owner, this.deps.cfg.board.repo) : {}),
        }
      : (deployKeyEnv ?? process.env);
    const child = spawn(this.bin, args, {
      detached: true,
      stdio: ["ignore", jsonlFd, jsonlFd],
      // #708: WORKER_DISABLE_BACKGROUND_TASKS_ENV placed AFTER baseEnv, same reason
      // SAPWOOD_GUARD_MODE/SAPWOOD_WORKTREE_ROOT are — so it wins even if an inherited
      // process.env somehow already carried CLAUDE_CODE_DISABLE_BACKGROUND_TASKS unset/cleared.
      // #679: SAPWOOD_DEFAULT_BRANCH is set/omitted by omitStaleDefaultBranch AFTER the spread —
      // see that function's own doc for why an unresolved `defaultBranch` must actively DELETE
      // the key rather than merely skip adding it (baseEnv can already carry a stale ambient one).
      env: omitStaleDefaultBranch(
        {
          ...baseEnv,
          ...WORKER_DISABLE_BACKGROUND_TASKS_ENV,
          SAPWOOD_GUARD_MODE: guardMode,
          SAPWOOD_WORKTREE_ROOT: resolve(this.worktreeRoot, laneName),
        },
        defaultBranch,
      ),
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
      // #606 gate② round 1 (P1-3): the GH_CONFIG_DIR scratch dir now exists whenever EITHER
      // credentialFree OR an L1 deploy key is in play — cleanup (removeGhConfigDir via
      // lane.ghConfigDir) must track the same condition, or an ordinary L1-only leg's directory
      // is never removed on exit.
      ...(opts?.proxy?.credentialFree || deployKeyPath ? { ghConfigDir } : {}),
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
    return { name: laneName, sessionId, pid: child.pid ?? null, worktreePath: resolve(this.worktreeRoot, laneName) };
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

  /** #724 gate② round 3, P1-1: the `Supervisor` interface's process-only liveness primitive —
   *  see its own doc for why round.ts's E-STOP sweep needs this instead of `probe()`. Built
   *  entirely from the SAME two private primitives every other cross-process path in this file
   *  already uses (`persistedPid`/`pidGroupAlive` — `wrapperAlive` above is the same pair, just
   *  returning a tri-state instead of a plain boolean). No forge call, no `this.lanes` read. */
  durablePidAlive(name: string): boolean {
    return this.pidGroupAlive(this.persistedPid(name));
  }

  /** #724 gate② round 3, P1-1: the `Supervisor` interface's process-only signal primitive — the
   *  SAME `signalGroup` call `killByPid`/`killTree` already make, exposed standalone (no grace
   *  wait, no escalation sequencing) so round.ts's E-STOP sweep can drive its OWN TERM-then-KILL
   *  sequence one signal at a time, without `reclaim()`'s worktree/PR bookkeeping. A no-op when
   *  there's no persisted pid — `signalGroup` itself never throws either. */
  signalDurablePid(name: string, signal: NodeJS.Signals): void {
    const pid = this.persistedPid(name);
    if (pid != null) this.signalGroup(pid, signal);
  }

  /**
   * #46: resume a lane the wrapper handed off (`.handoff` sentinel) via `claude --resume`,
   * reusing the ORIGINAL session id (no --fork-session) so claude continues the same
   * conversation — see docs/PLAN.md's Architecture chapter ("Sentinel-based completion" /
   * the `.handoff` resumable state). Fail-closed: absent a narrowly
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
  /** #705: same `pid`/`worktreePath` contract as dispatch() (see that method's own doc) — TWO
   *  return points carry it here. The cross-restart adoption branch (line below,
   *  `matchingResumeIntent && spawn_confirmed`) has no live `child` handle to read a pid off; its
   *  pid comes from the persisted `running.json` `wrapper_pid` the CONFIRMED spawn already wrote
   *  (the same field `pidGroupAlive`/`wrapperPidFor` trust elsewhere in this file) — never
   *  re-derived, never guessed. The ordinary fresh-spawn branch (this method's final return)
   *  mirrors dispatch() exactly: `child.pid` at return time. */
  async resume(
    issue: Issue,
    name: string,
    opts?: { proxy?: WorkerProxyOpts; prompt?: string; sessionId?: string },
  ): Promise<{ name: string; sessionId: string; pid: number | null; worktreePath: string }> {
    // #668 (round 6 P1b): resume() is the REALISTIC path for this race — its whole design
    // reuses an existing name (fix-leg entry and handoff-resume both require a terminal sentinel
    // ALREADY on disk for it), which is exactly the shape onExit()'s leader-exit reap leaves
    // behind (sentinel written, reap for a live descendant possibly still running). Wait it out
    // before touching anything else — see awaitInFlightLeaderExitReapsFor's own doc.
    await this.awaitInFlightLeaderExitReapsFor(name);
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
      return {
        name,
        sessionId: runningSessionId,
        pid: typeof running.wrapper_pid === "number" ? running.wrapper_pid : null,
        worktreePath: resolve(this.worktreeRoot, name),
      };
    }
    if (matchingResumeIntent && running.spawn_confirmed === false) {
      if (!this.lanes.has(name)) throw new UnresumableLaneError(name, issue.number);
      throw new Error(`resume: ${name} already has an in-memory unconfirmed spawn`);
    }
    // #245 round-2 (A1): fix-leg entry (opts.sessionId set) vs. the ordinary #172 handoff-sentinel
    // path — mutually exclusive, resolved once here into a common (sessionId, dispatchedAt) pair
    // the rest of this method uses unchanged either way.
    // #639: same branch also picks the injection-policy-table session kind (both resolve to YES
    // — see shouldInjectSkillsPlugin's own doc — kept distinct only so a policy-table test can
    // pin fix-entry and ordinary handoff-resume as two named cases, not one).
    const skillsSessionKind: SkillsSessionKind = opts?.sessionId != null ? "worker-fix-entry" : "worker-resume";
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
    // #606 gate② round 1: resolved outside the try block's scope so baseEnv (below, after the
    // try) and the catch's own cleanup can read them.
    let deployKeyPath: string | undefined;
    let deployKeyEnv: NodeJS.ProcessEnv | undefined;
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
      // #606 gate② round 1 (P1-4): resolved BEFORE the GH_CONFIG_DIR mkdir below — same
      // unconditional resolution + composition rule as dispatch(), see that call site's own
      // comment. A fix leg (resume()'s ONLY production credentialFree caller, conductor.ts's
      // startFixLeg) needs this to compose the deploy key onto its stricter base env.
      deployKeyPath = await this.resolveDeployKeyPath();
      // #245: same fresh/empty per-lane GH_CONFIG_DIR scratch directory dispatch() creates —
      // created whenever EITHER credentialFree OR an L1 deploy key is in play (cheap; lifecycle
      // tied to this lane's own stateDir). Only actually pointed at by the spawn env in either
      // of those cases.
      if (opts?.proxy?.credentialFree || deployKeyPath) mkdirSync(ghConfigDir, { recursive: true });
      // Non-credentialFree L1: build the full workerDeployKeyEnv here (used as baseEnv below).
      // credentialFree legs compose deployKeyTransportOverlay onto workerCredentialFreeEnv
      // instead (see baseEnv) — deployKeyEnv here stays undefined for them, on purpose.
      deployKeyEnv =
        !opts?.proxy?.credentialFree && deployKeyPath
          ? workerDeployKeyEnv(deployKeyPath, ghConfigDir, this.deps.cfg.board.owner, this.deps.cfg.board.repo)
          : undefined;
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
        // #1011: same as dispatch() — see that call site's own doc.
        permissionMode: this.deps.cfg.host.permissionMode,
        settings: settingsJson,
        // #245: widen --allowedTools with the proxy's own tool names — same pattern as dispatch().
        // Unattached resume (today's entire #172 handoff path) passes neither flag, byte-identical
        // to pre-#245 behavior. #606: an L1 leg (deployKeyEnv resolved) gets the same NO_GH
        // narrowing as credentialFree — see dispatch()'s own comment.
        ...(proxyHandle || deployKeyEnv
          ? {
              allowedTools: [
                opts?.proxy?.credentialFree || deployKeyEnv ? WORKER_ALLOWED_TOOLS_NO_GH : WORKER_ALLOWED_TOOLS,
                ...(proxyHandle?.toolNames ?? []),
              ].join(","),
            }
          : {}),
        ...(proxyHandle ? { mcpConfig: proxyHandle.mcpConfigJson } : {}),
        // #617 (seam 1, capability DR #616): same seal as dispatch() — see that call site's own
        // doc for the full rationale (additive vs. exclusive --mcp-config, the #616 live-probe
        // evidence, the credentialFree-implies-proxyHandle invariant here too since a
        // credentialFree mint failure REFUSES the resume above, before this call).
        ...(opts?.proxy?.credentialFree ? { strictMcpConfig: true } : {}),
        // #639: see dispatch()'s own comment — resolves to a no-op flag whenever
        // `roles.skills.enabled` is false (this.deps.skillsPluginDir undefined).
        ...(shouldInjectSkillsPlugin(skillsSessionKind) && this.deps.skillsPluginDir ? { pluginDir: this.deps.skillsPluginDir } : {}),
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
      this.removeGhConfigDir(opts?.proxy?.credentialFree || deployKeyPath ? ghConfigDir : undefined, name);
      throw e;
    }
    let child: ChildProcess;
    // #245: baseEnv is credential-stripped (workerCredentialFreeEnv) when opts.proxy.credentialFree
    // is set — every other resume() caller keeps inheriting process.env verbatim, unchanged from
    // pre-#245 behavior. #606 gate② round 1 (P1-4): unless the L1 env resolved above, in which case
    // a credentialFree leg COMPOSES deployKeyTransportOverlay onto workerCredentialFreeEnv's base —
    // see dispatch()'s own comment for the full rationale (the fix-leg case this closes).
    const baseEnv = opts?.proxy?.credentialFree
      ? {
          ...workerCredentialFreeEnv(ghConfigDir),
          ...(deployKeyPath ? deployKeyTransportOverlay(deployKeyPath, this.deps.cfg.board.owner, this.deps.cfg.board.repo) : {}),
        }
      : (deployKeyEnv ?? process.env);
    // #679: same unconditional resolution as dispatch() — a resumed leg (including a fix leg,
    // resume()'s own fix-entry mode) gets SAPWOOD_DEFAULT_BRANCH too, not just fresh dispatch.
    const defaultBranch = await this.resolveDefaultBranch();
    try {
      // SAPWOOD_WORKTREE_ROOT (#235 PR-A): same lane/worktree as the original dispatch — a
      // resumed leg must keep Read/Grep/Glob confined too, not just the fresh-dispatch path.
      child = spawn(this.bin, args, {
        detached: true,
        stdio: ["ignore", jsonlFd, jsonlFd],
        // #708: same env-precedence rationale as dispatch()'s own spawn() call above — a
        // resumed leg must keep the background-task closure too, not just the fresh-dispatch path.
        // #679: same omitStaleDefaultBranch call as dispatch() — see that function's own doc.
        env: omitStaleDefaultBranch(
          {
            ...baseEnv,
            ...WORKER_DISABLE_BACKGROUND_TASKS_ENV,
            SAPWOOD_GUARD_MODE: guardMode,
            SAPWOOD_WORKTREE_ROOT: resolve(this.worktreeRoot, name),
          },
          defaultBranch,
        ),
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
      this.removeGhConfigDir(opts?.proxy?.credentialFree || deployKeyPath ? ghConfigDir : undefined, name);
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
      // #606 gate② round 1 (P1-3): same "GH_CONFIG_DIR exists whenever credentialFree OR an L1
      // deploy key is in play" condition as dispatch() — cleanup must track the same condition.
      ...(opts?.proxy?.credentialFree || deployKeyPath ? { ghConfigDir } : {}),
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
      this.removeGhConfigDir(opts?.proxy?.credentialFree || deployKeyPath ? ghConfigDir : undefined, name);
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
    return { name, sessionId, pid: child.pid ?? null, worktreePath: resolve(this.worktreeRoot, name) };
  }

  /** Operator/drain-initiated graceful handoff: SIGTERM (not SIGKILL) so the worker wraps up
   *  the current step; onExit then writes the resumable .handoff sentinel. This is the live
   *  handoff path the drain half of the kill switch uses (docs/security.md's "Human controls
   *  (three tiers)" section) — AND (#33) the path
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
    // a fresh heartbeat + live pid make classifyLane return KEEP indefinitely — Codex R2 P1).
    // Past timeoutSec: stop refreshing AND kill the tree
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
    // something else already advanced THIS LANE's own progress this cadence — #688:
    // maxEventIdForWorker(name), scoped per lane, not the prior global maxEventId() that starved
    // every lane but one under concurrent dispatch). Optional (WorkerDeps.state, already used for
    // proxy-mint-failed) — omitted means zero behavior change, same as before.
    if (this.deps.state) {
      let gate = this.heartbeatGates.get(name);
      if (!gate) {
        const state = this.deps.state;
        gate = createHeartbeatGate(
          state,
          () => {
            const pid = lane.child.pid;
            if (pid == null) return false;
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          () => state.maxEventIdForWorker(name),
        );
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
    this.scheduleContextManifestRecording(name, lane.jsonlPath, lane.prompt, lane.manifestPreSpawnPromise, lane.jsonlLegOffset);
    this.lanes.delete(name);
    // #395 (gate② round 3): drop this lane's heartbeat gate along with the lane itself — onExit
    // is the one place a lane truly terminates (this method's own doc), so this is the one
    // place its cursor ever needs clearing; never left to grow unboundedly over a long-running
    // engine process's lifetime.
    this.heartbeatGates.delete(name);
    // #668 (round 5 pivot — reap at the moment the pgid is FRESH, not when it's stale): the
    // DIRECT child exiting is not proof its process GROUP is empty — a detached descendant
    // sharing the same pgid can outlive its own leader (the confirmed stranded-fix-leg incident
    // class this whole issue exists to close). Earlier rounds (r2[0]/r3) answered this with a
    // durable pgidRegistry that outlived `this.lanes`, re-verified by an ownership fingerprint at
    // reap time — round 5 (Codex, marginal-complexity ruling): that design kept sprouting new
    // edges (comm-fallback false-negatives/positives, an awaited-fingerprint spawn race, pruning
    // that only fired inside reapAll) because it deferred reaping to engine exit, by which time
    // the pgid could be ANYTHING. The fix is to stop deferring: reap the group RIGHT HERE, while
    // the pid is still definitively ours (its leader exited THIS INSTANT, inside this very
    // handler) — no registry, no fingerprint, no re-verification machinery at all.
    //
    // Fire-and-forget FROM onExit's OWN synchronous perspective (this method returns immediately
    // either way), but the resulting promise is tracked in `inFlightLeaderExitReaps` so
    // reapAll()'s own engine-exit path can await it — see that field's and reapAll()'s own docs
    // for why an in-flight reap must never be abandoned just because the engine is shutting down.
    //
    // RESIDUALS, FINAL FORM (round 8, Codex REQUEST_CHANGES on 43ebdf3 — supervisor ruling: stop
    // narrowing, delete the exposure instead where narrowing can't close it; see
    // signalOnceAndReport's own doc for the full reasoning behind deleting the escalation loop
    // this path used to have). Stated with NO numeric window claims — rounds 6-7 tried bounding
    // the gap in milliseconds and kept finding a smaller residual gap underneath, because
    // `setTimeout` is a LOWER bound on a poll interval, never an upper one; a host/event-loop
    // stall can put an ARBITRARY amount of real time between any two observations, so no duration
    // number here would ever be honest:
    //
    // (a) An INHERENT TOCTOU instant between the `pidGroupAlive` check below and the single
    //     SIGTERM `reapDescendantsOnLeaderExit` sends — the same unavoidable check-then-signal
    //     gap every process manager on POSIX has; nothing closes it, and no amount of re-checking
    //     would either. A stray SIGTERM landing on a since-recycled, unrelated process is the
    //     accepted, survivable cost (a process not expecting SIGTERM is generally unaffected by
    //     or ignores it) — this is why the signal sent here is SIGTERM, never anything stronger.
    // (b) A descendant GROUP that ignores that SIGTERM is REPORTED — logged, and surfaced through
    //     reapAll()'s existing orphan-surfacing path (cli.ts's reapAndSurfaceOrphans) whenever
    //     this reap is still in flight at engine-exit time — but never force-killed. It survives,
    //     visibly, until an operator acts on it. This repo's own degrade-to-human policy, applied
    //     deliberately: the alternative (escalating to SIGKILL) risks a wrongly-killed stranger,
    //     which is worse than a leaked descendant process.
    // (c) An ENGINE CRASH between "leader exits, reap starts" and "reap completes" can still
    //     leave a descendant alive with no durable record for the next engine start to recover
    //     from — unchanged from round 5's own fuller statement of this residual (see the PR
    //     description's "Engine crash..." bullet); round 8 doesn't change this one at all.
    const pid = lane.child.pid;
    if (pid != null && this.pidGroupAlive(pid)) {
      const alreadySignaled = lane.handoffRequested; // an earlier drain may have already SIGTERM'd the whole group
      // #668 (round 6 P1b): `${name}#${pid}` — see inFlightLeaderExitReaps' own doc for why a
      // bare lane name would let a same-name respawn's fresh entry silently replace (and abandon)
      // this one.
      const key = `${name}#${pid}`;
      const reapPromise = this.reapDescendantsOnLeaderExit(name, pid, alreadySignaled);
      this.inFlightLeaderExitReaps.set(key, reapPromise);
      void reapPromise.finally(() => {
        if (this.inFlightLeaderExitReaps.get(key) === reapPromise) this.inFlightLeaderExitReaps.delete(key);
      });
    }
  }

  /** #668 (round 5 pivot; escalation REMOVED round 8 — see signalOnceAndReport's own doc for the
   *  full reasoning): reaps a group whose LEADER just exited (inside onExit(), this instant) but
   *  which is still alive — a descendant outliving its leader, the actual stranded-child incident
   *  class #668 exists to close. Uses `signalOnceAndReport` — SIGTERM once, one bounded liveness
   *  observation, REPORT if still alive, never SIGKILL — against a single synthetic child bound to
   *  the raw pid (no `ChildProcess`/`Lane` object exists for a descendant, only
   *  `signalGroup`/`pidGroupAlive`, which is all `ReapableChild` ever needed). `alreadySignaled`
   *  mirrors reapAll()'s own r1[1] invariant: if an earlier drain already sent the group a SIGTERM
   *  (killGroup signals the WHOLE group, so a descendant may already have received it), this reap
   *  must not send a second one. Never throws (signalOnceAndReport's own contract). */
  private async reapDescendantsOnLeaderExit(name: string, pid: number, alreadySignaled: boolean): Promise<ReapOutcome> {
    return signalOnceAndReport(
      {
        name,
        alreadySignaled,
        isAlive: () => this.pidGroupAlive(pid),
        signal: (sig: NodeJS.Signals) => this.signalGroup(pid, sig),
      },
      {
        ...(this.deps.sleep !== undefined ? { sleep: this.deps.sleep } : {}),
        log: (m) => this.log(m),
      },
    );
  }

  /** #668 (round 6 P1b): dispatch()/resume() both call this FIRST, before doing any other work,
   *  when about to spawn under `name` — waits for every leader-exit reap still in flight FOR THAT
   *  SAME NAME (see inFlightLeaderExitReaps' own doc for why the key is `${name}#${pid}`, not the
   *  bare name, and why this wait matters beyond just avoiding an abandoned promise). Two real
   *  reasons this matters: (1) worktree overlap — a respawn under the same name (resume()'s entire
   *  design: its precondition IS "a terminal sentinel already exists for this name") reuses the
   *  SAME worktree directory; a stale descendant from the prior leg could still be touching files
   *  there the instant the new leg starts writing to it. (2) keeping exactly one reap in flight
   *  per name at a time, so a second overlapping reap for the same name (a further respawn while
   *  THIS one is still draining) can never happen either.
   *
   *  Bounded automatically, never a new hang risk: each awaited promise is `reapChildren`'s own
   *  SIGTERM -> grace -> SIGKILL -> verify sequence, which already has a hard bound (the grace
   *  window plus the fixed SIGKILL-verify timeout) baked into `reapChildren` itself — this method
   *  adds no additional timeout because it doesn't need one. Deliberately does NOT delay sentinel
   *  publication — the prior leg's `.done`/`.failed`/`.handoff` sentinel is written synchronously
   *  inside onExit() well before this reap even starts, so a caller polling for that sentinel
   *  (e.g. the conductor) is never held up by this wait; only the NEXT spawn under the same name
   *  is. */
  private async awaitInFlightLeaderExitReapsFor(name: string): Promise<void> {
    const prefix = `${name}#`;
    const matching = [...this.inFlightLeaderExitReaps.entries()].filter(([key]) => key.startsWith(prefix)).map(([, p]) => p);
    if (matching.length > 0) await Promise.all(matching);
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
   *  re-read off a `Lane` object this method never assumes still exists. `jsonlLegOffset`
   *  (#1010) is the SAME per-leg start offset onExit() already threads into
   *  writeTerminalSentinel's own readJsonlFromByte slice — needed here too so the init-derived
   *  manifest fields land leg-scoped; see recordLaneContextManifest's own doc for why. */
  private scheduleContextManifestRecording(
    name: string,
    jsonlPath: string,
    prompt: string,
    preSpawnPromise: Promise<PreSpawnManifestCapture | undefined> | undefined,
    jsonlLegOffset: number,
  ): void {
    if (!preSpawnPromise) return; // lane never reached the confirmed-alive gate — capture never started
    preSpawnPromise
      .then((pre) => this.recordLaneContextManifest(name, jsonlPath, prompt, pre, jsonlLegOffset))
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
   *  engine's dirty-derivation enum also carries structurally cannot apply to a worker lane.
   *
   *  #1010: the row's documented "most-recent-leg" scope above is a promise about every
   *  field it carries, not just the overwrite-on-upsert mechanics — so the INIT-DERIVED fields
   *  (`model`/`cliVersion`/`mcpTools`/`permissionMode`) and `sandboxViolationCount` below are all
   *  parsed from `legJsonl` (this leg's OWN slice, `jsonlLegOffset` onward — the identical offset
   *  writeTerminalSentinel's own `readJsonlFromByte` call already uses), never the cumulative
   *  whole-session `jsonl`. `parseSessionInit` returns only the FIRST init line in whatever
   *  string it's given; reading it off the full append-only lane jsonl would silently return the
   *  ORIGINAL leg's init on every resume, even though this row is documented (and, since #1010,
   *  actually keyed) as the most-recent leg's fingerprint. `toolUsage`/`readPaths` are a
   *  deliberate exception — left reading the full `jsonl` as before (out of this fix's scope; the
   *  "what did this session use, cumulative across every leg" framing was never leg-scoped to
   *  begin with, so leaving it alone here is not a regression). */
  private recordLaneContextManifest(
    name: string,
    jsonlPath: string,
    prompt: string,
    pre: PreSpawnManifestCapture | undefined,
    jsonlLegOffset: number,
  ): void {
    if (!this.deps.state?.recordContextManifest) return;
    if (!pre) return;
    try {
      const jsonl = this.readJsonl(jsonlPath);
      const legJsonl = this.readJsonlFromByte(jsonlPath, jsonlLegOffset);
      const init = parseSessionInit(legJsonl);
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
        // #1010: the session's own init-reported effective permission mode, recorded alongside
        // the other init self-report fields above — same "prefer the session's own report" stance
        // as model/mcpTools, and `null` when the init line carried no such field.
        permissionMode: init.permissionMode,
        // #1010: `legJsonl`, not the whole-session `jsonl` — a denied command's
        // <sandbox_violations> block belongs to the LEG that hit it, so a resumed lane's count
        // must never carry a prior leg's violations forward.
        sandboxViolationCount: countSandboxViolations(legJsonl),
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
    // #645 P2-1: which of the two branches fed `cost` — a REAL provider-reported total, or the
    // pinned-price estimator's substitute — is the same provenance the log line right below
    // already computes and then discards. Persisted here (never derived a second time) so
    // conductor.ts's terminal settlement can thread it into `spend_ledger.estimated` instead of
    // leaving every worker/fix-leg row's `estimated` permanently NULL (docs/guide/supervision.md's
    // est-vs-real bias query needs this to be real, not aspirational prose).
    const costEstimated = reportedCost <= 0;
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
      // #645 P2-1: the same estimator-vs-provider provenance the log line above already computed
      // — carried onto the sentinel so probe()/terminalCostEstimated can recover it without
      // re-reading/re-parsing the jsonl a third time.
      total_cost_estimated: costEstimated,
      model_usage: modelUsage,
      ended_at: this.now().toISOString(),
      ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
    };
    this.writeJsonAtomic(this.path(name, `${tag}.json`), { ...base, exit_code: exitCode });
    this.recordEgressSuspects(name, issue, legJsonl);
    this.recordPermissionModeMismatch(name, issue, sessionId, legJsonl);
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
    let engineOpenedPr = false;
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
        engineOpenedPr = outcome.engineOpened === true;
      }
      // Budget only counts once settlement is actually possible (gate② round 5): while the lane
      // is still running the conductor classifies it KEEP no matter what this says, so spending
      // retries here could leave none for the one probe that does settle it. No write can even
      // fail before then, so this is belt-and-braces over that guarantee, not the only guard.
      prAssociationInconclusive = sessionOver && this.trackInconclusiveAssociation(name, outcome);
    }
    const costUsd = this.terminalCostUsd({ done, failed, handoff }, name);
    const modelUsage = this.terminalModelUsage({ done, failed, handoff }, name);
    const costEstimated = this.terminalCostEstimated({ done, failed, handoff }, name);
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
      ...(costEstimated != null ? { costEstimated } : {}),
      ...(prNumber != null ? { prNumber } : {}),
      ...(prTitle != null ? { prTitle } : {}),
      ...(engineOpenedPr ? { engineOpenedPr } : {}),
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

  /** #645 P2-1: same terminal-sentinel-only shape as terminalCostUsd, reading the provenance
   *  `writeTerminalSentinel` now persists alongside `total_cost_usd` (its own `costEstimated`
   *  doc explains the estimator-vs-provider distinction). `null`, not `false`, when there is no
   *  sentinel field to read — a pre-#645 sentinel, or the jsonl-fallback path (an engine-restart
   *  orphan with no sentinel at all, terminalCostUsd's own doc) never computed an estimate to
   *  report one way or the other, and this must never fabricate "known to be real" for a cost it
   *  never actually classified. */
  private terminalCostEstimated(flags: { done: boolean; failed: boolean; handoff: boolean }, name: string): boolean | null {
    const ext = flags.done ? "done.json" : flags.failed ? "failed.json" : flags.handoff ? "handoff.json" : null;
    if (ext) {
      const r = this.readJson(this.path(name, ext));
      if (typeof r?.total_cost_estimated === "boolean") return r.total_cost_estimated;
    }
    return null;
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

  /** #834 Phase 1 (the merged-lane close-out "faucet" fix): purity-checks and, when clean,
   *  DELETES a MERGED lane's worktree DIRECTORY — the counterpart to retainOrDeleteWorktree for
   *  the one path that function never covers. reclaim() (and therefore retainOrDeleteWorktree)
   *  only ever runs from the DEAD/teardown paths; a lane whose PR simply merged while the row
   *  was still `driving` is never reclaim()'d at all, so every merged lane's worktree,
   *  registration, and branch were left behind forever (#834's own root-cause finding) — this is
   *  the ordinary-success counterpart role sessions already have via peripheral.ts's
   *  maybeRetainWorktree.
   *
   *  BASELINE (#834 owner ruling, supersedes the either/or framing #834 was filed under): the
   *  worktree's OWN git-index mtime (resolveWorktreeIndexBaselineMs — the SAME glue
   *  peripheral.ts's maybeRetainWorktree uses), NEVER dispatchedBaselineMs. A lane that
   *  SUCCEEDED necessarily committed files after its own dispatch time, so baselining this check
   *  on dispatched_at would read every productive lane as "dirty" and turn this into a ~100%
   *  false-positive retention stream on the happy path. Git rewrites the index on every
   *  checkout/add/commit, so a lane whose last write was a reviewed-and-merged commit reads
   *  clean against it. Unreadable/missing index -> NaN -> worktreeMaybeDirty's own fail-safe-
   *  dirty branch (never assumes clean without proof).
   *
   *  #834 (gate② round 1, F3): `name` is caller-supplied — before it ever becomes a filesystem
   *  path this checks the resolved path is STRICTLY inside `this.worktreeRoot` (the same
   *  discipline worktree-janitor.ts's classifyRegistration already applies to every
   *  registration path it touches). A `..`-carrying or absolute-path-injecting name is treated
   *  as "nothing to settle" — never scanned, never deleted — rather than trusting `join()` to
   *  keep it contained (it does not).
   *
   *  DELETES THE DIRECTORY via the shared TOCTOU-safe rename-tombstone primitive
   *  (settleWorktreeDirectory, module-level — see its own doc for the F1/F4 fixes: an honest
   *  "settled" only after the tombstone is PROVEN gone, never a swallowed rmSync error, and a
   *  purity re-verification after the rename closes the race window between the first purity
   *  read and the actual deletion). Never runs git — this class's #69 grep-invariant forbids it
   *  (see this file's header doc). The caller (conductor.ts's settleMergedLane) owns pruning the
   *  now-directory-less `git worktree` REGISTRATION, ONLY on a `"settled"` verdict, through
   *  worktree-janitor.ts's trusted main-repo `-C` git (pruneSettledWorktreeRegistration) — one of
   *  the handful of modules this codebase permits to shell out at all (worktree-janitor.ts's own
   *  header doc names the full, closed list). A MERGED lane's retained/failed worktree is never
   *  an escalation trigger per #834's ruling — event-only, decided entirely by the caller, since
   *  this class has no forge access either way. */
  settleMergedWorktree(name: string): WorktreeSettleOutcome {
    const worktreePath = join(this.worktreeRoot, name);
    if (!isUnderWorktreeRoot(worktreePath, this.worktreeRoot)) return { worktreePath: null, verdict: "absent" };
    if (!existsSync(worktreePath)) return { worktreePath: null, verdict: "absent" };
    const indexMs = resolveWorktreeIndexBaselineMs(worktreePath);
    const outcome = settleWorktreeDirectory(worktreePath, this.worktreeRoot, indexMs);
    // #834 (gate② round 2, G2; wording corrected round 3, W1): tombstonePath threads through
    // unmodified — present exactly when outcome.verdict is "failed"; deletion did not complete
    // and any SURVIVING residue (possibly only partial — see WorktreeDirectorySettleOutcome's
    // own doc) is at that path rather than `worktreePath`.
    return {
      worktreePath,
      verdict: outcome.verdict,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.tombstonePath !== undefined ? { tombstonePath: outcome.tombstonePath } : {}),
    };
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

  /** Clear timers/fds so a host process can exit cleanly (tests). Does not kill children —
   *  callers that also need every child dead (production shutdown) call reapAll(). */
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

  /** #668: production shutdown reap — every child this supervisor still tracks in `this.lanes`
   *  at the moment cli.ts's run path is about to return/throw. Neither cli.ts run path had a
   *  supervisor cleanup `finally` before this (Codex final review, 2026-08-05); dispose() above
   *  deliberately never kills children, so a lane still `running`/`fixing` when the engine
   *  exits was left alive — the confirmed stranded-fix-leg incident this issue exists to close.
   *
   *  Composes with, never replaces, the existing drain paths (conductor.ts's ceiling/kill-switch
   *  drain, checkSoftBudget's handoff): a lane already `handoffRequested` (an earlier drain
   *  already sent its SIGTERM) is marked `alreadySignaled` below, so reapChildren skips ITS OWN
   *  initial SIGTERM for that lane — exactly ONE SIGTERM ever reaches a live lane across the
   *  whole reap, never a second one stacked on top of an in-progress TERM handler (gate②
   *  finding, 2026-08-05: the previous version called requestHandoff() — itself a SIGTERM — AND
   *  then unconditionally let reapChildren's own initial SIGTERM fire too, double-signaling
   *  every freshly-reaped lane). A lane that was NEVER asked to hand off (the common case — the
   *  engine simply reached its stop condition or threw while legs were still live) gets that one
   *  SIGTERM from reapChildren itself; either way, reapChildren then applies the shared grace-
   *  then-group-SIGKILL escalation, verifying death before resolving — see reapChildren's own doc
   *  for why this needs a death PROOF, not just an assumption. Never throws (mirrors dispose()'s
   *  own best-effort stance): a lane that somehow survives SIGKILL is logged and reported in the
   *  returned outcome — see cli.ts's callers for how an unconfirmed death there is surfaced as a
   *  failed run rather than silently discarded.
   *
   *  #668 (gate② round 2, r2[1]): `lane.handoffRequested` is flipped to `true` INSIDE the
   *  `signal` closure below — i.e. only the instant THIS reap actually sends a real signal to a
   *  lane it found still alive — never speculatively for every lane up front. The earlier version
   *  set the flag unconditionally before reapChildren even ran, so a lane whose child had already
   *  exited on its own (isAlive() false — reapChildren never calls `signal` for it at all, per
   *  AC5) still got tagged as if it had been asked to hand off; that lane's already-pending
   *  onExit() then read `handoffRequested === true` and wrote a FABRICATED `.handoff` sentinel in
   *  place of the real `.done`/`.failed` its actual exit code earned. Deferring the write into
   *  `signal` makes the bookkeeping and the real SIGTERM/SIGKILL delivery the SAME event — a lane
   *  reapChildren never signals can never end up mistagged.
   *
   *  #668 (round 5 pivot): this method ONLY handles lanes `this.lanes` still tracks — i.e. whose
   *  leader process has NOT yet exited. That's deliberate, not an oversight: a still-tracked
   *  leader's pid/pgid categorically cannot have been recycled (Node hasn't called waitpid for it
   *  yet — that's WHY it's still in `this.lanes`), so signaling it needs no ownership check at
   *  all, and `reapChildren`'s full SIGTERM->grace->SIGKILL escalation is SAFE for it (see
   *  `reapChildren`'s own "SCOPE" doc paragraph — this is the ONE production caller that
   *  guarantee applies to). A lane whose leader ALREADY exited, leaving a live descendant behind,
   *  is a completely different problem — its pid HAS been waitpid'd, so escalating to SIGKILL is
   *  UNSAFE for it (see `signalOnceAndReport`'s own doc for the full asymmetry this design turns
   *  on) — handled THERE, at the moment the pgid is fresh, instead of here at engine-exit time
   *  (rounds 2-4 tried a durable registry re-checked here; retired per the repo's
   *  marginal-complexity ruling). This method's OWN remaining duty toward that class is simply
   *  not to abandon one already in flight: it awaits every entry in `inFlightLeaderExitReaps` (a
   *  reap onExit() kicked off, possibly mere milliseconds before this call started) before it can
   *  itself return, so AC4 ("no orphan group on exit") holds even for that race — by
   *  construction, not by re-verification machinery. */
  async reapAll(opts: { graceMs?: number } = {}): Promise<ReapOutcome[]> {
    const lanes = [...this.lanes.entries()];
    const laneChildren: ReapableChild[] = lanes.map(([name, lane]) => {
      const alreadySignaled = lane.handoffRequested;
      return {
        name,
        alreadySignaled,
        isAlive: () => this.pidGroupAlive(lane.child.pid),
        signal: (sig: NodeJS.Signals) => {
          lane.handoffRequested = true; // r2[1]: only true once a signal is ACTUALLY sent
          this.killGroup(lane.child, sig);
        },
      };
    });
    const liveOutcomes =
      laneChildren.length === 0
        ? []
        : await reapChildren(laneChildren, {
            ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
            ...(this.deps.sleep !== undefined ? { sleep: this.deps.sleep } : {}),
            log: (m) => this.log(m),
          });
    // #668 (round 5 pivot): a reap onExit() already kicked off for a leader that exited moments
    // ago (possibly WHILE this very call was starting) must still be allowed to finish — never
    // abandoned just because the engine is shutting down. Snapshot the values BEFORE awaiting:
    // `inFlightLeaderExitReaps` mutates itself as each promise settles (see onExit's own doc), so
    // iterating the live map across an await would be iterating a moving target.
    const inFlight = [...this.inFlightLeaderExitReaps.values()];
    const leaderExitOutcomes = inFlight.length === 0 ? [] : await Promise.all(inFlight);
    return [...liveOutcomes, ...leaderExitOutcomes];
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async killTree(child: ChildProcess): Promise<void> {
    this.killGroup(child, "SIGTERM");
    await sleep(KILL_SIGNAL_GRACE_MS); // brief grace, then hard-kill the whole group
    this.killGroup(child, "SIGKILL");
  }
  private async killByPid(pid: number): Promise<void> {
    this.signalGroup(pid, "SIGTERM");
    await sleep(KILL_SIGNAL_GRACE_MS);
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
  /** #668: is the WHOLE process group (negative pid) still alive? Used by reapAll's own death
   *  verification, and by onExit() to decide whether a just-exited leader left a live descendant
   *  behind worth reaping right there (see onExit's own doc) — `killGroup`/`signalGroup` above
   *  already fall back to a direct-pid signal when the group send fails, but verification checks
   *  the group specifically, since a detached worker child is its own pgid leader and an orphaned
   *  group is exactly what this issue's acceptance criteria (AC4) forbid. */
  private pidGroupAlive(pid: number | null | undefined): boolean {
    if (pid == null) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
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
    // never granted `.sapwood/` via --add-dir). A branch that ANY other known lane is also sitting
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

/** #668: the minimal surface reapChildren needs to SIGTERM/SIGKILL and verify death — never
 *  `ChildProcess`, so a unit test can exercise the full grace/escalation/verify state machine
 *  against a FAKE child (per this repo's test doctrine: no real subprocess, no real timer,
 *  deterministic) instead of a spawned process. WorkerSupervisor.reapAll() adapts its real lanes
 *  to this shape via pidGroupAlive/killGroup. */
export interface ReapableChild {
  /** Lane name, for logging/outcome-reporting only — never used to look anything up. */
  name: string;
  /** True when this child already received its graceful SIGTERM from an earlier, independent
   *  caller (e.g. a ceiling/kill-switch drain already in progress) — reapChildren then skips
   *  ITS OWN initial SIGTERM for this child and goes straight to waiting out the grace window
   *  (then escalating like any other child), so a lane never receives two SIGTERMs across one
   *  reap. Omitted/false -> reapChildren sends the one and only SIGTERM itself, today's
   *  behavior for a lane no one has signaled yet. */
  alreadySignaled?: boolean;
  /** True while the process group is presumed alive. Never throws. */
  isAlive: () => boolean;
  /** Send `sig` to the whole process group. Never throws. */
  signal: (sig: NodeJS.Signals) => void;
}

export interface ReapOutcome {
  name: string;
  /** The child had already exited before reapChildren sent anything. */
  alreadyDead: boolean;
  /** SIGTERM alone did not end it within the grace period — SIGKILL was sent. */
  escalated: boolean;
  /** Death was observed before this call returned. False is the orphan-process-group case
   *  AC4 forbids in every production path; reapAll logs this rather than retrying forever, so
   *  an engine exit is never blocked indefinitely by one wedged (e.g. D-state) process. */
  confirmedDead: boolean;
}

const REAP_GRACE_MS = 3_000; // #668: SIGTERM->SIGKILL grace period at production shutdown
const REAP_VERIFY_POLL_MS = 25;
const REAP_VERIFY_TIMEOUT_MS = 500; // generous vs. a real SIGKILL's near-instant OS-level death

/** Poll `candidates` (whatever signal was already sent) until every one's `isAlive()` reports
 *  dead, or `boundMs` elapses — whichever comes first. Never a flat block: the poll interval is
 *  `REAP_VERIFY_POLL_MS`, so a candidate that dies early ends the wait for it immediately rather
 *  than holding the whole batch hostage to the full bound. The filter is MONOTONIC — once a
 *  candidate's `isAlive()` observes it dead, it is removed from `pending` and never reappears
 *  there, no matter how many further poll ticks run (`pending = pending.filter(...)` only ever
 *  narrows across iterations; nothing re-adds a prior entry) — so a child, once seen dead, is
 *  never signaled again by anything downstream of that observation. Shared by `reapChildren`
 *  (`this.lanes`' own full SIGTERM->grace->SIGKILL escalation) and `signalOnceAndReport` (the
 *  leader-exit descendant path, SIGTERM + one bounded observation, no escalation) — ONE poll
 *  implementation, not two. */
async function pollUntilDeadOrTimeout(
  candidates: ReapableChild[],
  boundMs: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<ReapableChild[]> {
  let pending = candidates.filter((c) => c.isAlive());
  let waited = 0;
  while (pending.length > 0 && waited < boundMs) {
    await sleepFn(REAP_VERIFY_POLL_MS);
    waited += REAP_VERIFY_POLL_MS;
    pending = pending.filter((c) => c.isAlive());
  }
  return pending; // whatever is still alive once the bound is hit
}

/** #668: SIGTERM every still-alive child, then POLL (never a flat block) for up to `graceMs`
 *  (default REAP_GRACE_MS) so a cooperative leg's own exit ends the wait the moment it happens —
 *  production shutdown is never held hostage to the full grace period just because one lane
 *  happened to be live. Any survivor past that bound is escalated to SIGKILL, then polled again
 *  (bounded by REAP_VERIFY_TIMEOUT_MS) until death is confirmed or that bound is hit — the
 *  "verify group death before the engine exits" half of the acceptance criteria, not just an
 *  assumed kill. `sleep` defaults to a real, cancelable `setTimeout` (module-level `sleep`);
 *  tests inject an immediately-resolving one so the whole state machine runs with zero real
 *  wall-clock time (this repo's no-timing-dependent-assertions doctrine — a seam, not a bigger
 *  margin). A child already dead when this is called is never signaled at all (AC5: reap must
 *  not manufacture work against a leg that already exited on its own, e.g. via a completed
 *  graceful handoff), and a child flagged `alreadySignaled` skips this SIGTERM specifically —
 *  it already got its one SIGTERM from whoever set that flag — so no live child is ever
 *  SIGTERM'd twice by one reap (gate② finding, 2026-08-05). The extra `isAlive()` check
 *  immediately before the SIGKILL send below (round 6 P1a) is the same monotonic-filter habit
 *  from `pollUntilDeadOrTimeout`, applied once more at the one transition that matters most (an
 *  unrecoverable signal) — a survivor that died in that last synchronous gap is never signaled,
 *  and correctly not counted as `escalated` below (its own contract: "SIGKILL was sent").
 *
 *  SCOPE (round 8, Codex REQUEST_CHANGES on 43ebdf3 — supervisor ruling: stop narrowing, delete
 *  the exposure where it can't be closed): escalating to SIGKILL is sound here ONLY because this
 *  function's one production caller (`reapAll()`, over `this.lanes`) guarantees every pid it hands
 *  in has NOT yet been `waitpid`'d — the OS categorically cannot have recycled it (see `reapAll()`'s
 *  own doc). That guarantee does NOT generalize. A raw pid whose owning process HAS already been
 *  reaped (the leader-exited-descendant shape `onExit()` handles) is a strictly weaker liveness
 *  signal: no amount of re-checking closes a check-then-signal gap that a host/event-loop stall
 *  can stretch arbitrarily wide (`setTimeout` is a LOWER bound on the poll interval, never an
 *  upper one), and unlike a courtesy SIGTERM, a wrongly-delivered SIGKILL is unrecoverable. This
 *  function's own escalation loop must therefore NEVER be reused for that shape —
 *  `signalOnceAndReport` (below) is the separate, deliberately non-escalating primitive that
 *  shape uses instead. */
export async function reapChildren(
  children: ReapableChild[],
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<ReapOutcome[]> {
  const sleepFn = opts.sleep ?? sleep;
  const graceMs = opts.graceMs ?? REAP_GRACE_MS;
  const log = opts.log ?? (() => {});

  const outcomes: ReapOutcome[] = [];
  const live: ReapableChild[] = [];
  for (const c of children) {
    if (c.isAlive()) live.push(c);
    else outcomes.push({ name: c.name, alreadyDead: true, escalated: false, confirmedDead: true });
  }
  if (live.length === 0) return outcomes;

  for (const c of live) {
    if (!c.alreadySignaled) c.signal("SIGTERM");
  }
  const survivors = await pollUntilDeadOrTimeout(live, graceMs, sleepFn);
  const stillAliveAtEscalation = survivors.filter((c) => c.isAlive());
  for (const c of stillAliveAtEscalation) c.signal("SIGKILL");
  await pollUntilDeadOrTimeout(stillAliveAtEscalation, REAP_VERIFY_TIMEOUT_MS, sleepFn);

  const survivorNames = new Set(stillAliveAtEscalation.map((c) => c.name));
  for (const c of live) {
    const confirmedDead = !c.isAlive();
    if (!confirmedDead) {
      log(`[sapwood:reap] ${c.name}: still alive after grace period + SIGKILL — possible orphan process group`);
    }
    outcomes.push({ name: c.name, alreadyDead: false, escalated: survivorNames.has(c.name), confirmedDead });
  }
  return outcomes;
}

/** #668 (round 8, Codex REQUEST_CHANGES on 43ebdf3): the leader-exited-descendant reap path
 *  (`reapDescendantsOnLeaderExit`) operates on a pid whose owning process has ALREADY been
 *  `waitpid`'d by the time this runs (that's what let `onExit()`'s own `'exit'` handler fire at
 *  all) — the OS is free to recycle that exact pid/pgid number at any point afterward.
 *  `reapChildren`'s SIGTERM->grace->SIGKILL escalation is UNSAFE for this shape: rounds 6-7 tried
 *  narrowing the check-then-signal gap before the SIGKILL send, and kept finding a smaller
 *  residual gap underneath — because `setTimeout` is a LOWER bound on the poll interval, not an
 *  upper one (host suspension / event-loop stall can put an ARBITRARY amount of real wall-clock
 *  time between any two observations, no matter how tight the nominal interval), the gap can
 *  never be closed by re-checking more often. TOCTOU is unavoidable here on POSIX; the fix is to
 *  stop taking the UNRECOVERABLE action, not to keep narrowing the window in front of it.
 *
 *  So: exactly ONE signal (SIGTERM, skipped if `alreadySignaled` — an earlier drain already sent
 *  the whole group one), exactly ONE bounded liveness observation afterward (the existing grace
 *  wait, reused via the SAME `pollUntilDeadOrTimeout` `reapChildren` itself uses — a cooperative
 *  descendant that dies from the TERM still ends the wait immediately), and NO escalation past
 *  that: a survivor is REPORTED (logged here, and returned with `confirmedDead: false`, which
 *  flows into `reapAll()`'s own aggregate outcome array whenever this reap is still tracked in
 *  `inFlightLeaderExitReaps` at the moment `reapAll()` runs — the SAME orphan-surfacing path
 *  `cli.ts`'s `reapAndSurfaceOrphans` already forces a failed exit code from) — never force-killed.
 *  This is a deliberate degrade-to-human (this repo's own doctrine): a stubborn descendant
 *  survives, visibly, until an operator acts on it, never silently and never at the cost of
 *  risking a wrongly-killed stranger. A single courtesy SIGTERM landing on a recycled stranger is
 *  the accepted, survivable residual (a process not expecting SIGTERM typically just ignores or
 *  is unaffected by it); SIGKILL is not survivable, which is exactly why it's gone from this
 *  path. */
export async function signalOnceAndReport(
  child: ReapableChild,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<ReapOutcome> {
  const sleepFn = opts.sleep ?? sleep;
  const graceMs = opts.graceMs ?? REAP_GRACE_MS;
  const log = opts.log ?? (() => {});

  if (!child.isAlive()) return { name: child.name, alreadyDead: true, escalated: false, confirmedDead: true };
  if (!child.alreadySignaled) child.signal("SIGTERM");
  const survivors = await pollUntilDeadOrTimeout([child], graceMs, sleepFn);
  const confirmedDead = survivors.length === 0;
  if (!confirmedDead) {
    log(
      `[sapwood:reap] ${child.name}: descendant(s) survived a post-leader-exit SIGTERM — reported, never force-killed (round 8: no SIGKILL escalation on this path) — needs an operator to look`,
    );
  }
  return { name: child.name, alreadyDead: false, escalated: false, confirmedDead };
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
  // #701: the configured default working language for code comments and for documentation the
  // worker edits — opaque BCP-47-ish tag, `en` by default. See config.ts's `language` section
  // doc comment.
  "lang.codeComments": (cfg) => cfg.language.codeComments,
  "lang.docs": (cfg) => cfg.language.docs,
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
    // #701: same working-language default as buildRenderPrompt's CONFIG_VARS above — a fix leg
    // still writes code comments.
    "lang.codeComments": () => cfg.language.codeComments,
    // The A7 narrowing above excludes issue.title/body/labels because those are UNTRUSTED issue
    // prose; doctrine is the same trusted, engine-loaded config file already injected into
    // worker.md's CONFIG_VARS — A7's rationale never applied to it, it was just never threaded
    // through. Without it, a fix leg sees only the previous review's specific finding text, not
    // the doctrine explaining the failure CLASS behind it (retro #424).
    doctrine: () => loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars),
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
