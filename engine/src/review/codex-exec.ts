// review/codex-exec.ts (#443, design adjudication 2026-08-01) — `CodexExecReviewSessionExecutor`:
// gate②'s CROSS-VENDOR session runner. A locally invoked `codex exec` process reviews the same
// materialized tree the Claude runner would, and returns the SAME `ReviewSessionEvidence` shape —
// outcome, raw final text, (provider, model) telemetry, spend evidence, transcript ids. It parses
// nothing about review CONTENT: agent-output.ts remains the one validation path for every runner
// (review-session.ts's module doc), so a prose-only or malformed codex output is an INVALID
// ATTEMPT, never an approval and never a block.
//
// Why this module and not a branch inside peripheral.ts's RoleRunner: the design adjudication
// rejected concentrating two incompatible security models in the repo's heaviest security-bearing
// method. peripheral.ts's guard/settings/tool-grant machinery is Claude-shaped and stays
// single-vendor; every containment decision for a codex session lives HERE, in one readable argv
// builder, where a reviewer can see the whole profile at once.
//
// CONTAINMENT PROFILE (R2, honest recording) — verified against the installed CLI's own
// `codex exec --help` (codex-cli 0.145.0) at implementation time; only flags that exist are pinned:
//   --sandbox read-only     the strongest sandbox the CLI offers for a session that must not write
//   --ignore-user-config    `$CODEX_HOME/config.toml` is not loaded (config-source isolation)
//   --ignore-rules          no user/project execpolicy `.rules` file is loaded
//   --skip-git-repo-check   a materialized tree has no `.git` at all (materializer.ts) — without
//                           this the CLI refuses to start, which would read as a spawn failure
//   -C <treeDir>            the agent's working root IS the materialized tree, nothing above it
//   -c mcp_servers={}       a HIGHEST-PRECEDENCE override, so no MCP server loads from ANY config
//                           source (including a producer-authored project-level `.codex/config.toml`
//                           inside the reviewed tree, which `--ignore-user-config` alone would not
//                           cover)
//   -c tools.web_search=false   no model-invoked web egress
//   -o <file>               the final message is captured to a FILE, never scraped out of the
//                           terminal stream (this repo's Codex ops notes: truncated/interleaved
//                           stdout has cost real review rounds before)
//   --json                  machine-readable session telemetry on stdout (thread id, token usage)
// plus a credential-stripped, credential-redirected env (`codexSessionEnv`) and a prompt
// delivered on STDIN FROM A FILE — never through argv or any shell (this module spawns with an
// argv vector, never a shell string, so producer-influenced text has no interpolation surface at
// all), with stdin at EOF the instant the prompt ends so the CLI can never block waiting for more.
//
// THE GAPS THIS CANNOT CLOSE (recorded, not silently accepted — design R2). Measured against
// codex-cli 0.145.0, whose read-only Seatbelt policy contains `(allow file-read*)` and whose own
// recorded permission profile reads `{special: root, access: read}`:
//   1. `--sandbox read-only` blocks WRITES, not EXECUTION — a shell-capable agent under it can
//      still RUN producer-controlled code from the materialized tree;
//   2. and it does not confine the READ SCOPE at all. `-C <treeDir>` sets the working directory;
//      it is not a containment root. A prompt-injected review session can therefore read
//      HOST-WIDE files — including the operator's own credentials (`~/.codex/auth.json`,
//      `~/.config/gh/hosts.yml`, SSH private keys) — and return them through provider-visible
//      output. This is materially worse than facet 1 and is the reason the gap event names it
//      SEPARATELY (`CONTAINMENT_GAP_HOST_WIDE_FILE_READS`), so an operator can grep the
//      credential-read exposure specifically.
// `codexSessionEnv` below strips and redirects the ambient credential HANDLES an injected session
// would otherwise inherit, which raises the cost of facet 2 but does NOT close it: those files stay
// readable on disk. What would close it is filesystem confinement, and the owner ruling (R2)
// deliberately does not ship one — no new outer OS/container fence (trusted-repos posture + the
// marginal-complexity principle). Both facets are recorded at every spawn via
// `ENGINE_REVIEW_CONTAINMENT_GAP`; docs/security.md states the exposure in full for an operator
// deciding whether to enable this runner.
//
// BUDGET (R1): `codex exec` has no `--max-budget-usd` equivalent, so `reviewer.agent.costCapUsd`
// degrades to ADVISORY for this runner — announced with a pre-run warning event, never silently.
// After the run, token telemetry becomes a pinned-price USD ESTIMATE flagged `estimated`; missing
// telemetry becomes a cost-unknown ALERT event and `{ kind: "unknown" }` spend, which the caller
// treats as fail-closed (never as `$0`). The wall-clock timeout below stays HARD — it is a timeout,
// not a cost cap.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Process supervision is REUSED, not reimplemented: `awaitKillGrace`/`sessionTreeIsGone`
// (peripheral.ts) and `createExitLossDetector` (util/heartbeat.ts) are the engine's existing,
// vendor-neutral primitives for "kill the whole tree, then stop waiting honestly". peripheral.ts
// itself is not modified by this feature — these are plain exported functions with no Claude-shaped
// state behind them.
import { awaitKillGrace, sessionTreeIsGone } from "../roles/peripheral.js";
import { createExitLossDetector } from "../util/heartbeat.js";
import type { ReviewSessionEvidence, ReviewSessionExecutor, ReviewSessionIdentity, ReviewSessionRequest } from "./review-session.js";

/** #443 (R1): announced BEFORE the session starts — `reviewer.agent.costCapUsd` is advisory for
 *  this runner, because the CLI has no hard-cap mechanism to hand it to. Copy entry lives in
 *  docs/frontend-design.md §7 (every engine PR that adds a kind extends that map). */
export const ENGINE_REVIEW_BUDGET_ADVISORY = "engine-review-budget-advisory";

/** #443 (R1): the session ended with NO usable token/cost telemetry — its spend is UNKNOWN, which
 *  is never read as `$0` anywhere (the caller refuses to budget a retry from it). */
export const ENGINE_REVIEW_COST_UNKNOWN = "engine-review-cost-unknown";

/** #443 (R2): the named containment blind spots, recorded at every codex-exec spawn. */
export const ENGINE_REVIEW_CONTAINMENT_GAP = "engine-review-containment-gap";

/** Facet 1: a read-only sandbox blocks writes, not execution — model-invoked shell commands can
 *  still RUN producer-controlled code from the reviewed tree. */
export const CONTAINMENT_GAP_MODEL_INVOKED_EXECUTION = "model-invoked-shell-execution";

/** Facet 2 (the credential-read exposure, gate② review of PR #510): the same sandbox does not
 *  confine the READ SCOPE — `-C` is a working directory, not a containment root — so a
 *  prompt-injected session can read host-wide files, operator credentials included, and return them
 *  through provider-visible output. Named separately from facet 1 precisely so this exposure is
 *  greppable on its own rather than buried inside a single "execution" label. */
export const CONTAINMENT_GAP_HOST_WIDE_FILE_READS = "host-wide-filesystem-reads";

/** Every gap this runner's profile cannot enforce, recorded together in one event payload — stable
 *  identifiers so an operator can grep/aggregate them, rather than free prose that drifts per call
 *  site. Adding a facet here is what makes it show up in the durable record. */
export const CODEX_CONTAINMENT_GAPS: readonly string[] = [CONTAINMENT_GAP_MODEL_INVOKED_EXECUTION, CONTAINMENT_GAP_HOST_WIDE_FILE_READS];

/** #443 (R1): the pinned per-million-token prices the `estimated` spend figure is computed from.
 *  User-tunable through `reviewer.agent.codexPricing` (docs/configuration.md) — never hardcoded at
 *  a call site — because list prices differ per model and per plan. Cached input and reasoning
 *  tokens are deliberately NOT priced separately: owner ruling R1 accepts bounded estimate error in
 *  exchange for a mechanism simple enough to read in one sitting. */
export interface CodexPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** The shipped default when `reviewer.agent.codexPricing` is omitted — OpenAI's published
 *  gpt-5-class list price per million tokens at implementation time (2026-08-01). A LIST price, not
 *  a measurement: a plan-based or discounted account pays something else, which is precisely why
 *  every figure derived from it is flagged `estimated` and why the key is user-tunable. */
export const DEFAULT_CODEX_PRICING: CodexPricing = { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 };

/** Token counts as reported by the session's own `turn.completed` telemetry. */
export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CodexExecStreamTelemetry {
  /** The session's own thread id (`thread.started`), the key the rollout transcript is named by. */
  threadId: string | null;
  /** Summed across every `turn.completed` in the stream (an exec run is normally one turn; summing
   *  means a multi-turn run reports its whole cost rather than its last turn's). */
  usage: CodexTokenUsage | null;
}

/** CODEX_BIN env override, else `codex` on PATH — deliberately the same shape as worker.ts's
 *  `discoverClaudeBin(CLAUDE_BIN)`, so both runners are discovered the same way. */
export function discoverCodexBin(env: Record<string, string | undefined>): string {
  const b = env.CODEX_BIN?.trim();
  return b ? b : "codex";
}

/** Where this machine's codex state (auth + session transcripts) lives. NOT overridden to an
 *  ephemeral directory: `--ignore-user-config`'s own help text states that auth still resolves
 *  through `CODEX_HOME`, so pointing it at an empty temp dir would make every review fail to
 *  authenticate. Config-source isolation is achieved by the flag instead; this path is used
 *  READ-ONLY, to locate the session's own transcript for identity telemetry. */
export function codexHomeDir(env: Record<string, string | undefined>): string {
  const h = env.CODEX_HOME?.trim();
  return h ? h : join(homedir(), ".codex");
}

/** A codex session environment without forge credentials, agent sockets, or git credential-injection
 *  vectors — the DENYLIST peripheral.ts's `peripheralSessionEnv` applies to every Claude role
 *  session, restated here (the design adjudication keeps peripheral.ts untouched by this feature)
 *  and WIDENED by the gate② review of PR #510:
 *   - `SSH_AUTH_SOCK`/`SSH_AGENT_PID` are stripped: a live agent socket is a USABLE credential
 *     without any key file to read, so leaving it inherited would hand a prompt-injected session
 *     working SSH auth for free;
 *   - `GH_CONFIG_DIR` is REDIRECTED (by the caller, via `ghConfigDir`) at an empty ephemeral
 *     directory under the session's own state dir, rather than left pointing at the operator's real
 *     `~/.config/gh` — so an inherited `gh` config with `hosts.yml` tokens is not the default
 *     lookup path;
 *   - `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pinned to `/dev/null` and `GIT_TERMINAL_PROMPT=0`,
 *     neutralizing credential helpers/askpass prompts declared in the operator's git config.
 *
 *  HONEST LIMIT — these strip and redirect the ambient HANDLES; they do not stop a READ of the
 *  underlying files. `--sandbox read-only` does not confine the read scope (see this module's own
 *  gap list), so `~/.config/gh/hosts.yml`, `~/.codex/auth.json` and `~/.ssh/*` remain readable on
 *  disk by a session that goes looking. This is necessary-but-insufficient hardening, recorded as
 *  such here, in `CONTAINMENT_GAP_HOST_WIDE_FILE_READS`, and in docs/security.md.
 *
 *  Provider transport credentials (`CODEX_HOME`, `OPENAI_API_KEY`, ...) are deliberately NOT
 *  stripped: a review that cannot reach its own provider is not contained, it is broken. */
export function codexSessionEnv(env: NodeJS.ProcessEnv, ghConfigDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "GITHUB_TOKEN" ||
      normalized === "GITHUB_ENTERPRISE_TOKEN" ||
      normalized.startsWith("GH_") ||
      normalized === "GIT_ASKPASS" ||
      normalized.startsWith("GIT_CONFIG_") ||
      normalized === "SSH_AUTH_SOCK" ||
      normalized === "SSH_AGENT_PID"
    ) {
      continue;
    }
    out[key] = value;
  }
  // Set AFTER the strip loop, so these are the redirected values and never an inherited one that
  // happened to survive (`GH_CONFIG_DIR` matches the `GH_` prefix above and is removed first).
  out.GH_CONFIG_DIR = ghConfigDir;
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_SYSTEM = "/dev/null";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/** Effort values this module will put on a codex command line, closed-set — `reviewer.agent.effort`
 *  is already a zod enum, so this is defense in depth against a hand-constructed executor. */
const CODEX_EFFORTS: readonly string[] = ["low", "medium", "high"];

/** A conservative model-name shape. The model string comes from config and is placed in an ARGV
 *  VECTOR (no shell anywhere in this module), so this is not an escaping fix — it is an
 *  argv-injection guard: a value starting with `-` would be read by the CLI as another FLAG, which
 *  is how a mistyped config could silently widen the profile pinned above. */
const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Parse `codex exec --json`'s stdout event stream (one JSON object per line) for the two pieces of
 *  telemetry this executor needs. Tolerant by construction: a non-JSON line (the CLI prints a
 *  human-readable "Reading prompt from stdin..." banner before the stream starts), an unknown event
 *  type, or a truncated tail is skipped, never fatal. Anything it cannot find comes back `null` —
 *  which is what makes the honest-recording paths fire, rather than a fabricated value. */
export function parseCodexExecStream(stdout: string): CodexExecStreamTelemetry {
  let threadId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "thread.started" && typeof rec.thread_id === "string" && rec.thread_id.length > 0) {
      threadId = rec.thread_id;
    }
    if (rec.type === "turn.completed" && typeof rec.usage === "object" && rec.usage !== null) {
      const usage = rec.usage as Record<string, unknown>;
      const input = usage.input_tokens;
      const output = usage.output_tokens;
      if (typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output)) {
        inputTokens += input;
        outputTokens += output;
        sawUsage = true;
      }
    }
  }
  return { threadId, usage: sawUsage ? { inputTokens, outputTokens } : null };
}

/** Extract the session's ACTUAL (provider, model) identity from its own rollout transcript:
 *  `session_meta.payload.model_provider` and the LAST `turn_context.payload.model` (a session can
 *  in principle re-context mid-run; the last one is the one that produced the final message).
 *  Returns `null` unless BOTH halves are present and non-empty — a half-known identity is an
 *  UNIDENTIFIABLE one, and D5's fail-closed rule (unidentifiable ⇒ `unavailable`) depends on this
 *  function never inventing the missing half from configuration. */
export function parseCodexRolloutIdentity(rolloutText: string): ReviewSessionIdentity | null {
  let provider: string | null = null;
  let model: string | null = null;
  for (const line of rolloutText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const payload = rec.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const p = payload as Record<string, unknown>;
    if (rec.type === "session_meta" && typeof p.model_provider === "string" && p.model_provider.length > 0) {
      provider = p.model_provider;
    }
    if (rec.type === "turn_context" && typeof p.model === "string" && p.model.length > 0) {
      model = p.model;
    }
  }
  return provider !== null && model !== null ? { provider, model } : null;
}

/** Locate a session's rollout transcript under `<codexHome>/sessions` by thread id. The CLI names
 *  it `rollout-<local-timestamp>-<threadId>.jsonl` inside a `YYYY/MM/DD` tree; matching on the
 *  suffix rather than reconstructing the date avoids a timezone-dependent guess (the directory is
 *  local-dated, the payload timestamps are UTC). Returns `null` for anything unreadable or absent —
 *  the caller's identity then comes back empty, which is D5's fail-closed input, not an error. */
export function findCodexRollout(codexHome: string, threadId: string): string | null {
  const sessionsDir = join(codexHome, "sessions");
  const suffix = `-${threadId}.jsonl`;
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      return join((entry.parentPath as string | undefined) ?? sessionsDir, entry.name);
    }
  } catch {
    return null;
  }
  return null;
}

/** Pinned-price token estimate, in USD. Deliberately arithmetic only — see `CodexPricing`'s doc for
 *  what it knowingly ignores. */
export function estimateCodexCostUsd(usage: CodexTokenUsage, pricing: CodexPricing): number {
  return (usage.inputTokens * pricing.inputUsdPerMTok + usage.outputTokens * pricing.outputUsdPerMTok) / 1_000_000;
}

/** Build the exact argv this executor spawns. Exported so the containment profile is asserted as a
 *  VALUE in tests rather than inferred from a captured spawn — the flags ARE the profile. */
export function buildCodexExecArgs(opts: { treeDir: string; model: string; effort: string; lastMessagePath: string }): string[] {
  if (!CODEX_MODEL_RE.test(opts.model)) {
    throw new Error(`codex review session: refusing model name ${JSON.stringify(opts.model)} — it is not a plain model identifier`);
  }
  if (!CODEX_EFFORTS.includes(opts.effort)) {
    throw new Error(`codex review session: refusing effort ${JSON.stringify(opts.effort)} — expected one of ${CODEX_EFFORTS.join(", ")}`);
  }
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "-C",
    opts.treeDir,
    "-m",
    opts.model,
    "-c",
    `model_reasoning_effort="${opts.effort}"`,
    "-c",
    "mcp_servers={}",
    "-c",
    "tools.web_search=false",
    "-o",
    opts.lastMessagePath,
  ];
}

/** Everything the executor needs from its composition root. Every I/O seam is injectable so the
 *  whole class is testable against a fake spawn and a fixture CODEX_HOME — no real session, no real
 *  timers (docs/REVIEW-DOCTRINE.md: no timing-dependent assertions). */
export interface CodexExecExecutorDeps {
  /** Directory for this runner's own artifacts (prompt, captured stream, final message). */
  stateDir: string;
  /** HARD wall-clock ceiling for one session, seconds — `cfg.worker.timeoutSec`, the same bound
   *  every other session in this engine gets. Unchanged by R1: a timeout is not a cost cap. */
  timeoutSec: number;
  pricing: CodexPricing;
  /** Defaults to `discoverCodexBin(process.env)`. */
  codexBin?: string;
  /** Defaults to `process.env` — the env this module strips credentials FROM. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** The engine's durable event channel (state.appendEvent), for R1/R2's honest-recording events.
   *  Optional and best-effort: observability must never become a gate on the review. */
  appendEvent?: (kind: string, payload: unknown) => void;
  /** Injected `spawn` (tests pass a fake child). */
  spawnFn?: typeof spawn;
  /** Injected unique-suffix source for session artifact names. */
  newSessionId?: () => string;
  /** Injected timer seam: schedule `fire` after `ms` and return a canceller. A test drives the
   *  timeout path by firing it on its own terms instead of waiting on a real clock. */
  startTimer?: (ms: number, fire: () => void) => () => void;
  /** SIGTERM -> SIGKILL grace, ms (peripheral.ts's own default is 200). */
  killGraceMs?: number;
  /** How often the GROUP-liveness probe runs while waiting for the child's exit notification —
   *  the input to `createExitLossDetector` (util/heartbeat.ts), reused rather than reimplemented.
   *  Default 30s, the same cadence peripheral.ts's own heartbeat uses for the identical purpose. */
  livenessPollMs?: number;
  /** Injected raw signal primitive (default `process.kill`). Injected — rather than injecting a
   *  ready-made "kill the group" function — so a test can assert the NEGATIVE pid at the syscall
   *  boundary (proving group signalling) without a fake pid ever reaching the real OS. */
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Injected GROUP-liveness probe (default: peripheral.ts's exported `sessionTreeIsGone`, negated
   *  — the same primitive `RoleRunner.killTree` uses). Injectable for the same reason
   *  `RoleRunnerDeps.isPidAlive` is: a test scripts the reading instead of depending on the OS's
   *  child-reaping timing, which makes a genuine lost notification unreproducible on demand. */
  isTreeAlive?: (pid: number) => boolean;
}

const DEFAULT_KILL_GRACE_MS = 200;

/** GROUP-liveness probe cadence while awaiting the child's exit — 30s, the same value peripheral.ts
 *  uses for the identical lost-notification detection. Two consecutive dead readings are required
 *  (createExitLossDetector), so worst-case detection latency is ~30-60s: negligible against the
 *  session's own wall-clock ceiling, and far better than an unbounded await. */
const DEFAULT_LIVENESS_POLL_MS = 30_000;

/** Bound on captured stdout/stderr, bytes. A runaway CLI must not be able to grow the engine's heap
 *  without limit; the tail is what carries `turn.completed`, so the HEAD is what gets dropped. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
}

export class CodexExecReviewSessionExecutor implements ReviewSessionExecutor {
  readonly runner = "codex-exec" as const;

  constructor(private readonly deps: CodexExecExecutorDeps) {}

  async execute(req: ReviewSessionRequest): Promise<ReviewSessionEvidence> {
    const env = this.deps.env ?? process.env;
    const log = this.deps.log ?? console.error;
    // A materialized directory that vanished between materialize() and here is a SETUP failure —
    // thrown, so review-session.ts maps it to `unavailable` exactly like the Claude runner's
    // equivalent refusal (design #279 §6), never a session spawned against a bad path.
    if (!existsSync(req.treeDir)) {
      throw new Error(`codex review session materialized cwd ${JSON.stringify(req.treeDir)} does not exist`);
    }
    const sessionId = `${req.roleId}-${(this.deps.newSessionId ?? defaultSessionSuffix)()}`;
    mkdirSync(this.deps.stateDir, { recursive: true });
    const promptPath = join(this.deps.stateDir, `${sessionId}.prompt.txt`);
    const lastMessagePath = join(this.deps.stateDir, `${sessionId}.last-message.txt`);
    const transcriptPath = join(this.deps.stateDir, `${sessionId}.jsonl`);
    // The prompt travels on STDIN, from a file — never argv, never a shell string.
    writeFileSync(promptPath, req.prompt, "utf8");
    const args = buildCodexExecArgs({
      treeDir: req.treeDir,
      model: req.model,
      effort: req.effort,
      lastMessagePath,
    });

    // R2: the blind spots are announced at spawn, every time — the adjudicated alternative to
    // pretending a read-only sandbox equals the Claude runner's Read/Grep/Glob-only profile. BOTH
    // facets ride in one payload (see CODEX_CONTAINMENT_GAPS) so the credential-read exposure is
    // greppable in its own right.
    this.event(ENGINE_REVIEW_CONTAINMENT_GAP, {
      runner: this.runner,
      session: sessionId,
      gaps: [...CODEX_CONTAINMENT_GAPS],
    });
    // R1: the cap is announced as ADVISORY before any spend happens, so the warning exists even if
    // the session then crashes with no telemetry at all.
    if (req.budgetUsd !== undefined) {
      this.event(ENGINE_REVIEW_BUDGET_ADVISORY, { runner: this.runner, session: sessionId, capUsd: req.budgetUsd });
    }

    const spawnFn = this.deps.spawnFn ?? spawn;
    const startTimer = this.deps.startTimer ?? defaultStartTimer;
    const stdinFd = openSync(promptPath, "r");
    // An EMPTY, per-session `gh` config home — see codexSessionEnv's doc for what this redirects
    // and, just as importantly, what it does not close.
    const ghConfigDir = join(this.deps.stateDir, `${sessionId}.gh-config`);
    mkdirSync(ghConfigDir, { recursive: true });
    let child: ChildProcess;
    try {
      child = spawnFn(this.deps.codexBin ?? discoverCodexBin(env), args, {
        cwd: req.treeDir,
        env: codexSessionEnv(env, ghConfigDir),
        stdio: [stdinFd, "pipe", "pipe"],
        // DETACHED: the child leads its OWN process group, so the timeout path can signal the whole
        // TREE (`process.kill(-pid, ...)`) instead of only the leader. Without this, a descendant
        // forked by reviewed code — which a read-only sandbox permits (see the gap list above) —
        // survives the "hard" wall-clock kill and keeps running and spending. Exactly the property
        // worker.ts's `spawnClaudeSession` already pins for every Claude session.
        detached: true,
      });
    } finally {
      // The child holds its own duplicate of the descriptor (uv dups it during spawn); this one is
      // the parent's and is done. Note WHY stdin is a FILE descriptor and not a pipe: a regular
      // file reaches EOF at end-of-file by construction, so the CLI can never sit waiting for more
      // input the way it does on an inherited terminal/open pipe (this repo's Codex ops notes: a
      // never-closed stdin is the classic `codex exec` hang, worked around elsewhere with
      // `</dev/null`). There is no pipe to forget to close here.
      try {
        closeSync(stdinFd);
      } catch {
        /* already closed by the spawn failure path — nothing to reclaim */
      }
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout = appendCapped(stdout, d.toString());
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr = appendCapped(stderr, d.toString());
    });

    const killFn = this.deps.killFn ?? ((pid: number, signal: NodeJS.Signals | 0) => void process.kill(pid, signal));
    const isTreeAlive = this.deps.isTreeAlive ?? ((pid: number) => !sessionTreeIsGone(pid));
    const pid = child.pid;
    /** Signal the whole detached GROUP (negative pid), falling back to the leader alone if group
     *  signalling fails — the same tolerance worker.ts's `killGroup` applies. */
    const killGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        killFn(-pid, sig);
      } catch {
        try {
          killFn(pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    const treeIsGone = (): boolean => (pid === undefined ? true : !isTreeAlive(pid));

    let timedOut = false;
    let lostExit = false;
    // Settlement is captured so BOTH the real exit notification and the lost-notification detector
    // below can end the await. Without the second path, a lost `close` wedges this gate② lane
    // forever (the review never returns, the WAL row never settles) — the failure worker.ts and
    // peripheral.ts already model with the exact primitives reused here.
    let settle: ((code: number | null) => void) | null = null;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
      child.on("error", (err) => {
        log(`[sapwood:codex-review] session ${sessionId} spawn/runtime error: ${String(err)}`);
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });

    // #395's lost-exit detector (util/heartbeat.ts), driven off the GROUP-liveness probe: two
    // consecutive dead readings with no live reading between them ⇒ the notification is lost, and
    // the await settles synthetically instead of hanging. Reused, not reimplemented — including its
    // reasoning about why one dead reading is not enough.
    const exitLoss = createExitLossDetector(() => !treeIsGone());
    const pollTimer: { cancel: (() => void) | null } = { cancel: null };
    const schedulePoll = (): void => {
      pollTimer.cancel = startTimer(this.deps.livenessPollMs ?? DEFAULT_LIVENESS_POLL_MS, () => {
        if (!exitLoss.tick()) {
          schedulePoll();
          return;
        }
        lostExit = true;
        log(`[sapwood:codex-review] session ${sessionId}: child-exit notification lost (group gone) — settling synthetically`);
        settle?.(null);
      });
    };
    schedulePoll();

    // The wall-clock ceiling: latch `timedOut` FIRST (so the outcome stays "timeout" no matter how
    // the await eventually settles), then terminate the GROUP with peripheral.ts's own kill
    // sequence — subscribe to the grace BEFORE signalling, and use GROUP liveness (never the
    // leader's `exit` event) as the verdict on whether the SIGKILL escalation is still warranted.
    const cancelTimeout = startTimer(this.deps.timeoutSec * 1000, () => {
      timedOut = true;
      void (async () => {
        const grace = awaitKillGrace(
          { onExit: (cb) => child.once("exit", cb) },
          this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
          treeIsGone,
          (ms, signal) =>
            new Promise<void>((resolve) => {
              const cancel = startTimer(ms, resolve);
              signal.addEventListener(
                "abort",
                () => {
                  cancel();
                  resolve();
                },
                { once: true },
              );
            }),
        );
        killGroup("SIGTERM");
        if ((await grace) === "gone") return;
        killGroup("SIGKILL");
      })();
    });

    const exitCode = await exited;
    cancelTimeout();
    pollTimer.cancel?.();

    try {
      writeFileSync(transcriptPath, stderr.length > 0 ? `${stdout}\n${stderr}` : stdout, "utf8");
    } catch (err) {
      log(`[sapwood:codex-review] session ${sessionId} transcript write failed (non-fatal): ${String(err)}`);
    }

    const telemetry = parseCodexExecStream(stdout);
    const identity = this.resolveIdentity(env, telemetry.threadId);
    const spend: ReviewSessionEvidence["spend"] =
      telemetry.usage === null ? { kind: "unknown" } : { kind: "estimated", usd: estimateCodexCostUsd(telemetry.usage, this.deps.pricing) };
    if (spend.kind === "unknown") {
      // R1: NEVER read as `$0`. The alert exists so an operator can see that this attempt's spend
      // is genuinely unmeasured, rather than inferring a zero from a silent record.
      this.event(ENGINE_REVIEW_COST_UNKNOWN, {
        runner: this.runner,
        session: sessionId,
        reason: telemetry.threadId === null ? "no session telemetry on stdout" : "no turn.completed token usage in the session stream",
      });
    }

    return {
      // `timedOut` is checked FIRST (peripheral.ts's own ordering): a timeout stays a timeout
      // however the await eventually settled. `lostExit` next: a session whose exit notification
      // never arrived produced no trustworthy exit code, so it reads as `failed` — the fail-closed
      // direction (an invalid attempt, never a verdict), never `done` on an unobserved exit.
      outcome: timedOut ? "timeout" : lostExit ? "failed" : exitCode === 0 ? "done" : "failed",
      resultText: readIfPresent(lastMessagePath),
      identity: identity === null ? [] : [identity],
      spend,
      sessionId: telemetry.threadId ?? sessionId,
      transcriptPath,
    };
  }

  /** The session's OWN recorded identity, or `null` when it cannot be established — see
   *  `parseCodexRolloutIdentity`'s doc for why a half-known identity counts as none. */
  private resolveIdentity(env: NodeJS.ProcessEnv, threadId: string | null): ReviewSessionIdentity | null {
    if (threadId === null) return null;
    const rollout = findCodexRollout(codexHomeDir(env), threadId);
    if (rollout === null) return null;
    const text = readIfPresent(rollout);
    return text.length === 0 ? null : parseCodexRolloutIdentity(text);
  }

  /** Best-effort event append: a broken/absent event channel can never turn observability into a
   *  gate on the review (the same stance production.ts takes for the verdict event). */
  private event(kind: string, payload: unknown): void {
    try {
      this.deps.appendEvent?.(kind, payload);
    } catch (err) {
      try {
        (this.deps.log ?? console.error)(`[sapwood:codex-review] event ${kind} append failed (non-fatal): ${String(err)}`);
      } catch {
        /* a broken logger cannot become a gate either */
      }
    }
  }
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function defaultSessionSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Default timer seam — `unref`'d so a pending timeout can never by itself keep the engine's event
 *  loop alive, and cancelable so a completed session leaves nothing pending behind. */
function defaultStartTimer(ms: number, fire: () => void): () => void {
  const t = setTimeout(fire, ms);
  t.unref?.();
  return () => clearTimeout(t);
}
