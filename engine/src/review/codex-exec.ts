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
//   -c project_doc_max_bytes=0   disables codex-cli's project-instruction discovery — the reviewed
//                                tree's root `AGENTS.md`/`AGENTS.override.md`, which
//                                `--ignore-user-config`/`--ignore-rules` don't cover (those seal
//                                config.toml and exec-policy `.rules`, not project docs); keeps
//                                session instructions to the engine prompt and doctrine only
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
//
// SESSION INSPECTION CENSUS (#512, design adjudication 2026-08-01, "one honest-recording event"):
// the shipped engine-reviewer prompt used to name a Claude-only tool surface, which suppressed this
// runner's only tool — a shell — down to zero tree reads (the #443 shadow run that opened #512).
// The prompt fix cannot be verified by a fixture (it is a live-model-behavior claim), and the
// containment profile cannot ENFORCE "did it look" without becoming a ritual-authority gate the
// adjudication explicitly rejected (options C/D). So this module does what R1/R2 already do for
// budget and containment: it cannot enforce, so it RECORDS, honestly, from its own `--json` stream
// — the same regime, applied to a third fact the runner can observe about itself but not control.
// `ENGINE_REVIEW_SESSION_INSPECTION` carries the observed tool/command item count and is emitted
// AFTER every session completes, success or not. It is EVIDENCE ONLY: nothing in this codebase
// reads it to decide a verdict, a retry, or a budget — see its own doc comment below for why, and
// never wire a reader for it without re-opening that adjudication first.
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
import type { EventKind } from "../state/event-kinds/index.js";
import { createExitLossDetector } from "../util/heartbeat.js";
import type { ReviewSessionEvidence, ReviewSessionExecutor, ReviewSessionIdentity, ReviewSessionRequest } from "./review-session.js";

/** #443 (R1): announced BEFORE the session starts — `reviewer.agent.costCapUsd` is advisory for
 *  this runner, because the CLI has no hard-cap mechanism to hand it to. Copy entry lives in
 *  docs/reference/frontend-design.md §7 (every engine PR that adds a kind extends that map). */
export const ENGINE_REVIEW_BUDGET_ADVISORY = "engine-review-budget-advisory";

/** #443 (R1): the session ended with NO usable token/cost telemetry — its spend is UNKNOWN, which
 *  is never read as `$0` anywhere (the caller refuses to budget a retry from it). */
export const ENGINE_REVIEW_COST_UNKNOWN = "engine-review-cost-unknown";

/** #443 (R2): the named containment blind spots, recorded at every codex-exec spawn. */
export const ENGINE_REVIEW_CONTAINMENT_GAP = "engine-review-containment-gap";

/** #443 (PR #510 round-2 review, P1-a): the timed-out session's process group was STILL observable
 *  after the SIGKILL escalation. The review settles as `timeout` regardless — a surviving group is
 *  a host-level fact for a human to chase (something may still be running and spending), never a
 *  reason to leave a gate② lane awaiting an exit that may never come. */
export const ENGINE_REVIEW_ORPHANED_GROUP = "engine-review-orphaned-group";

/** #512 (design adjudication 2026-08-01, "one honest-recording event" — same cannot-enforce ⇒
 *  record-honestly regime as R1/R2 above): how many tool/command items this session's OWN `--json`
 *  stream reported it ran (`parseCodexExecStream`'s `toolItemCount`), emitted once per session,
 *  after it completes. This closes a REGRESSION channel a prompt-only fix leaves open — a future
 *  model/CLI/prompt change silently returning to zero-inspection reviews would otherwise be
 *  invisible until someone re-ran a bespoke harness (the #443 shadow run that found this in the
 *  first place).
 *
 *  EVIDENCE ONLY, NEVER A GATE — this is the whole point of it existing at all:
 *   - the adjudication explicitly REJECTED making "did it look" an engine-enforced check (options
 *     C/D in #512): the signal is trivially satisfiable by an irrelevant `pwd`/`rg` with no bearing
 *     on the criterion under review, so treating it as a gate would grant ritual authority over
 *     something only a human reading the transcript can actually judge;
 *   - nothing in `EngineAgentReviewer.evaluate()`, `agent-output.ts`'s validation, or the retry/
 *     budget logic reads this event or `toolItemCount` — a verdict is derived exclusively from the
 *     session's structured `perAC`/`findings` output, exactly as before this event existed;
 *   - unlike `ENGINE_REVIEW_CONTAINMENT_GAP` (which is LOAD-BEARING and uses `requireEvent` — a
 *     failed write there refuses the spawn), this event is emitted with the SAME best-effort
 *     `event()` helper every other post-run record in this module uses: a broken/absent event
 *     channel, or a failure to append, can never turn an observability record into a reason to fail
 *     or retry a session that otherwise ran fine. */
export const ENGINE_REVIEW_SESSION_INSPECTION = "engine-review-session-inspection";

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
 *  User-tunable through `reviewer.agent.codexPricing` (docs/guide/configuration.md) — never hardcoded at
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
  /** #512: count of `item.completed` items whose `item.type` is tool-ish (`CODEX_TOOL_ITEM_TYPES`)
   *  — i.e. the session actually DID something, as opposed to only producing prose. Always a
   *  number, never `null`: zero is a perfectly honest count (a session that never called a tool),
   *  distinct from `usage`/`threadId`'s `null` (telemetry never seen at all). See
   *  `ENGINE_REVIEW_SESSION_INSPECTION`'s doc for why this is recorded and never gated on.
   *
   *  HONEST BOUND (#512, PM gate② review, P2-1, valid finding — fix adopted as a documented bound,
   *  NOT a streaming parser; see the adjudication at `MAX_CAPTURE_BYTES`'s own doc for why a
   *  streaming NDJSON parser was rejected for an evidence-only counter). This count is computed
   *  over the RETAINED capture window only (`appendCapped`/`MAX_CAPTURE_BYTES`, 8 MiB, tail-kept,
   *  head-dropped). A session whose total stdout exceeds that bound may UNDERCOUNT — an
   *  `item.completed` early in a pathologically verbose session can be dropped along with the rest
   *  of the head before this parser ever sees it. The error is STRICTLY ONE-DIRECTIONAL: truncation
   *  can only ever drop items, never fabricate one, so this count can read low or zero when the
   *  session actually inspected the tree, but can never read positive when it did not. A low or
   *  zero `toolItemCount` is therefore a prompt to read the session's own transcript
   *  (`transcriptPath`) before concluding "no inspection happened" — never proof of it on its own. */
  toolItemCount: number;
}

/** #512 (PM gate② review, P2): `item.completed`'s `item.type` values this parser counts as
 *  TREE-INSPECTION activity — the signal `ENGINE_REVIEW_SESSION_INSPECTION` records, and the name
 *  this set and the event both commit to. `command_execution` is a shell call — the ONE
 *  tree-inspection capability this runner's containment profile actually grants (`--sandbox
 *  read-only` permits reads; see this module's own top-of-file doc). `file_change`/`mcp_tool_call`
 *  are included for forward compatibility with future CLI item shapes that would still count as
 *  "did something to/via the tree"; this runner's own argv (`-c mcp_servers={}`) means the latter
 *  should never actually appear. `web_search` is DELIBERATELY EXCLUDED even though this runner's
 *  argv also disables it (`-c tools.web_search=false`, so it should never fire either): a web
 *  search is not tree inspection, and counting it would inflate the exact signal this event exists
 *  to report honestly if that argv flag were ever dropped. `agent_message` (prose) and `reasoning`
 *  (the model's own chain-of-thought item, also prose) are deliberately NOT counted — an
 *  `agent_message` is exactly the "answered from the diff alone" pattern #512 exists to detect,
 *  not evidence of inspection. */
const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(["command_execution", "file_change", "mcp_tool_call"]);

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

/** #443 (PR #510 round-2 review, P1-b): the env keys that SURVIVE the credential sweep below no
 *  matter what pattern they happen to match. Every entry is here because the codex CLI cannot run
 *  without it — this list is the reason the sweep can be aggressive without being untestable:
 *   - `OPENAI_API_KEY`/`OPENAI_*` — the provider transport itself. Note it MATCHES the generic
 *     `*_API_KEY` sweep, which is exactly why an explicit keep-set exists rather than a cleverer
 *     regex: the one credential this session legitimately needs looks identical to the ones it must
 *     never see.
 *   - `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` — the CLI's other two env-auth modes (`codex doctor`
 *     reports auth-from-environment for each), same sweep-collision story.
 *   - `CODEX_HOME`/`CODEX_BIN` — where the CLI's own auth and binary live (`--ignore-user-config`'s
 *     help text: auth still resolves through `CODEX_HOME`).
 *   - `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `PWD`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`,
 *     `TZ`, `NODE_OPTIONS` — the ordinary runtime environment any process needs to start.
 *  Kept as an exact-match set plus one prefix (`OPENAI_`), never a substring test. */
const CODEX_ENV_KEEP: ReadonlySet<string> = new Set([
  "CODEX_HOME",
  "CODEX_BIN",
  // Round-3 review, P1-b: the CLI's OWN env-auth modes. Verified empirically against the installed
  // codex-cli 0.145.0 — `codex doctor --json` reports "auth is provided by environment" for EACH of
  // these with no auth file present, so on a machine that authenticates this way, sweeping them
  // makes every review fail to authenticate: the broken-runner failure mode this keep-set exists to
  // prevent. Both MATCH the generic sweep below (`_API_KEY`, `_TOKEN`), which is precisely why they
  // need explicit entries — the same rationale as `OPENAI_API_KEY`. Exact names, deliberately NOT a
  // `CODEX_` prefix: a future `CODEX_SOMETHING_TOKEN` that is not provider transport should still
  // be swept.
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "NODE_OPTIONS",
]);

/** Well-known credential FAMILIES, by exact name or prefix. Not exhaustive and not claimed to be —
 *  see `codexSessionEnv`'s honest-limit note and docs/security.md. */
const CODEX_ENV_STRIP_EXACT: ReadonlySet<string> = new Set([
  // forge
  "GITHUB_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // git credential/prompt vectors
  "GIT_ASKPASS",
  // ssh: a live agent socket is a usable credential with no key file to read
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  // cloud + orchestration
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  // package registries
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "CARGO_REGISTRY_TOKEN",
]);

const CODEX_ENV_STRIP_PREFIX: readonly string[] = [
  "GH_",
  "GIT_CONFIG_",
  "AWS_", // incl. AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_PROFILE
  "GCLOUD_",
  "CLOUDSDK_",
  "AZURE_",
  "DOCKER_",
  "PIP_",
  "TWINE_",
];

/** The generic sweep: any variable whose NAME advertises a secret. Deliberately a suffix match on
 *  the whole key, so `MY_SERVICE_TOKEN` goes and `TOKENIZER_MODE` stays. `CODEX_ENV_KEEP` wins over
 *  this. */
const CODEX_ENV_STRIP_SUFFIX: readonly string[] = ["_TOKEN", "_SECRET", "_API_KEY", "_APIKEY", "_PASSWORD", "_PASSWD", "_CREDENTIALS"];

/** Exported for its own test: does this env var name get dropped from a codex review session? */
export function isStrippedEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  // The keep-set wins over EVERY rule below — including the suffix sweep, which would otherwise
  // take the provider's own API key with it and break every review.
  if (CODEX_ENV_KEEP.has(k) || k.startsWith("OPENAI_")) return false;
  if (CODEX_ENV_STRIP_EXACT.has(k)) return true;
  if (CODEX_ENV_STRIP_PREFIX.some((p) => k.startsWith(p))) return true;
  return CODEX_ENV_STRIP_SUFFIX.some((s) => k.endsWith(s));
}

/** A codex session environment without inherited credentials — the DENYLIST peripheral.ts's
 *  `peripheralSessionEnv` applies to every Claude role session, restated here (the design
 *  adjudication keeps peripheral.ts untouched by this feature) and WIDENED TWICE by the gate②
 *  review of PR #510:
 *   - forge tokens, `SSH_AUTH_SOCK`/`SSH_AGENT_PID` (a live agent socket is a USABLE credential
 *     with no key file to read), and — round 2, P1-b — the well-known credential FAMILIES an
 *     operator's shell routinely carries: AWS/GCP/Azure, `KUBECONFIG`, npm/pip/twine/cargo registry
 *     tokens, Docker, plus a generic `*_TOKEN`/`*_SECRET`/`*_API_KEY`/`*_PASSWORD`/`*_CREDENTIALS`
 *     sweep (`isStrippedEnvKey`). Without that widening, a prompt-injected session could dump the
 *     lot with a single `env` — by far the cheapest exfiltration path available to it;
 *   - `GH_CONFIG_DIR` is REDIRECTED (by the caller, via `ghConfigDir`) at an empty ephemeral
 *     directory under the session's own state dir, rather than left pointing at the operator's real
 *     `~/.config/gh` — so an inherited `gh` config with `hosts.yml` tokens is not the default
 *     lookup path;
 *   - `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pinned to `/dev/null` and `GIT_TERMINAL_PROMPT=0`,
 *     neutralizing credential helpers/askpass prompts declared in the operator's git config.
 *
 *  Why a denylist-plus-sweep and NOT an allowlist: an allowlist that silently omits something the
 *  CLI needs breaks every review, and the only way to discover the omission is a paid live run. The
 *  denylist's failure mode — an unknown-shaped secret survives — is bounded and disclosed; the
 *  allowlist's is a runner that never works. `CODEX_ENV_KEEP` is the explicit counterweight.
 *
 *  HONEST LIMITS, both disclosed in docs/security.md:
 *   1. The strip covers known families and common name shapes; it CANNOT be exhaustive. The
 *      remaining environment is INHERITED, so an operator running the engine from a shell that
 *      carries secrets should assume a steered review session can read them.
 *   2. These strip and redirect the ambient HANDLES; they do not stop a READ of the underlying
 *      files. `--sandbox read-only` does not confine the read scope (see this module's own gap
 *      list), so `~/.config/gh/hosts.yml`, `~/.codex/auth.json` and `~/.ssh/*` remain readable on
 *      disk by a session that goes looking — `CONTAINMENT_GAP_HOST_WIDE_FILE_READS`.
 *
 *  Provider transport credentials (`CODEX_HOME`, `OPENAI_API_KEY`, ...) are deliberately NOT
 *  stripped: a review that cannot reach its own provider is not contained, it is broken. */
export function codexSessionEnv(env: NodeJS.ProcessEnv, ghConfigDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isStrippedEnvKey(key)) continue;
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

/** Parse `codex exec --json`'s stdout event stream (one JSON object per line) for the telemetry
 *  this executor needs — thread id, summed token usage, and (#512) the observed tool/command item
 *  count. Tolerant by construction: a non-JSON line (the CLI prints a human-readable "Reading
 *  prompt from stdin..." banner before the stream starts), an unknown event type, or a truncated
 *  tail is skipped, never fatal. `threadId`/`usage` come back `null` when never seen — what makes
 *  the honest-recording paths fire, rather than a fabricated value; `toolItemCount` is always a
 *  number (zero is itself an honest, recordable count — see `ENGINE_REVIEW_SESSION_INSPECTION`).
 *  This function only ever sees what `stdout` retains — see `CodexExecStreamTelemetry.toolItemCount`'s
 *  doc for the resulting one-directional undercount bound on very large streams (#512, P2-1). */
export function parseCodexExecStream(stdout: string): CodexExecStreamTelemetry {
  let threadId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let toolItemCount = 0;
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
    if (rec.type === "item.completed" && typeof rec.item === "object" && rec.item !== null) {
      const item = rec.item as Record<string, unknown>;
      if (typeof item.type === "string" && CODEX_TOOL_ITEM_TYPES.has(item.type)) {
        toolItemCount++;
      }
    }
  }
  return { threadId, usage: sawUsage ? { inputTokens, outputTokens } : null, toolItemCount };
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
    "project_doc_max_bytes=0",
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
  appendEvent?: (kind: EventKind, payload: unknown) => void;
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
 *  without limit; the tail is what carries `turn.completed`, so the HEAD is what gets dropped. #512
 *  (PM gate② review, P2-1): this is also the retention window `parseCodexExecStream`'s
 *  `toolItemCount` is computed over — an `item.completed` for an early `command_execution` in a
 *  session whose total stdout exceeds this bound is dropped along with the rest of the head, before
 *  the parser ever sees it. Observed real streams are on the order of ~1.6 KB, three to four orders
 *  of magnitude below this bound, so this is a documented edge case, not a fix: see
 *  `CodexExecStreamTelemetry.toolItemCount`'s doc for why it stays that way. */
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

    // R2: the blind spots are announced BEFORE the spawn, every time — the adjudicated alternative
    // to pretending a read-only sandbox equals the Claude runner's Read/Grep/Glob-only profile. BOTH
    // facets ride in one payload (see CODEX_CONTAINMENT_GAPS) so the credential-read exposure is
    // greppable in its own right.
    //
    // LOAD-BEARING, unlike every other event this module writes (PR #510 round-2 review, P2-a). The
    // record IS the mitigation for a gap the owner ruling deliberately leaves unfenced, and
    // docs/security.md states the facets are emitted at EVERY spawn — a best-effort append would let
    // that claim silently become false and run an unrecorded session against operator-readable
    // credentials. So a failure here THROWS before anything is spawned: review-session.ts maps the
    // throw to `unavailable` and the lane degrades honestly (no session, no spend, a visible
    // reason). This gates the SPAWN, never the review's outcome — observability still cannot decide
    // a verdict, and the post-run events below stay best-effort exactly as they were. */
    this.requireEvent(ENGINE_REVIEW_CONTAINMENT_GAP, {
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
    /** Signal the whole detached GROUP (negative pid) — and ONLY the group.
     *
     *  There is deliberately NO positive-pid fallback (PR #510 round-2 review, P2-b). `detached:
     *  true` makes the group canonical: if the group signal fails, either it is already gone
     *  (`ESRCH` — nothing to do) or it is not ours (`EPERM` — a leader-pid retry would not be ours
     *  either). A blind `killFn(pid, sig)` after an ESRCH is worse than useless: once the group has
     *  exited, the kernel is free to reassign that pid, so the retry can deliver SIGKILL to an
     *  UNRELATED live process. `ESRCH` is therefore swallowed as "already gone"; anything else is
     *  logged (an unexpected signalling failure is a fact worth recording, never a crash — the
     *  timeout path settles regardless, see below). */
    const killGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        killFn(-pid, sig);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return; // group already gone
        log(`[sapwood:codex-review] session ${sessionId}: ${sig} to process group ${pid} failed: ${String(err)}`);
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
    //
    // AND THEN SETTLE, UNCONDITIONALLY (PR #510 round-2 review, P1-a). The previous version returned
    // here and left `await exited` waiting for a `close` that may never come: if the child emits no
    // exit notification AND the group stays observable after SIGKILL (uninterruptible sleep, a
    // signal that didn't take, a descendant still holding the group id), every liveness reading says
    // ALIVE, the two-dead-readings detector never trips, and the lane wedges forever — the exact
    // failure this fix exists to remove, one branch over. A timed-out session's outcome is ALREADY
    // `timeout` regardless of any exit code, so waiting buys nothing. A group that survives SIGKILL
    // is a SEPARATE fact: it is reported (below) rather than blocked on.
    const cancelTimeout = startTimer(this.deps.timeoutSec * 1000, () => {
      timedOut = true;
      void (async () => {
        // Round-3 review, P1-a (last edge): the ENTIRE body is wrapped, and settlement lives in an
        // unconditional `finally`. Anything in here can throw — `awaitKillGrace`, the injected
        // liveness probe, `killGroup`'s own logging — and a throw would otherwise skip the settle
        // below, wedging the lane exactly as before AND escaping as an unhandled rejection that can
        // take the engine down (this coroutine is `void`ed: nobody is awaiting it to catch for us).
        // The `timedOut` latch is already set, so the outcome reads `timeout` however we get here.
        try {
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
          if ((await grace) !== "gone") {
            killGroup("SIGKILL");
            // One last kernel answer AFTER the escalation. A still-observable group here is an
            // orphaned-tree report for a human — a durable event plus a log line — not a reason to
            // keep this lane waiting.
            if (!treeIsGone()) {
              log(
                `[sapwood:codex-review] session ${sessionId}: process group ${pid} still observable after SIGKILL — ` +
                  "settling the review as timeout and leaving the surviving group reported, not awaited",
              );
              this.event(ENGINE_REVIEW_ORPHANED_GROUP, { runner: this.runner, session: sessionId, pid: pid ?? null });
            }
          }
        } catch (err) {
          // Swallowed deliberately: the termination path is best-effort, and its failure must
          // neither escape as an unhandled rejection nor block the settle in the `finally`.
          try {
            log(`[sapwood:codex-review] session ${sessionId}: timeout termination path failed (non-fatal): ${String(err)}`);
          } catch {
            /* a broken logger cannot become a gate either */
          }
        } finally {
          // The one line that must run on EVERY path through this coroutine. `settle` is a
          // promise `resolve` (it cannot throw), and the optional call covers the impossible
          // "timer fired before the executor ran" ordering rather than assuming it.
          settle?.(null);
        }
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
    // #512: the honest-recording census — emitted after EVERY session, regardless of outcome
    // (done/failed/timeout), because "how many tool calls did it make" is itself the fact worth
    // keeping even for a session that didn't finish cleanly. Best-effort like every other post-run
    // event here (see ENGINE_REVIEW_SESSION_INSPECTION's own doc for why this one is never a gate).
    this.event(ENGINE_REVIEW_SESSION_INSPECTION, { runner: this.runner, session: sessionId, toolItemCount: telemetry.toolItemCount });
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

  /** The ONE event this module refuses to lose (P2-a) — see its call site for why the containment
   *  record is treated differently from every other write here. Throws BEFORE the spawn, so
   *  `runReviewSession` maps it to `unavailable`: no session runs unrecorded. An absent
   *  `appendEvent` dep is also a refusal, not a pass: a composition that wired this runner without
   *  a durable event channel cannot honor the disclosure the docs make on its behalf. */
  private requireEvent(kind: EventKind, payload: unknown): void {
    if (!this.deps.appendEvent) {
      throw new Error(
        `codex review session: no durable event channel wired, so the ${kind} record cannot be written — ` +
          "refusing to spawn an unrecorded codex review session",
      );
    }
    try {
      this.deps.appendEvent(kind, payload);
    } catch (err) {
      throw new Error(
        `codex review session: failed to record ${kind} (${String(err)}) — refusing to spawn an unrecorded codex review session`,
      );
    }
  }

  /** Best-effort event append: a broken/absent event channel can never turn observability into a
   *  gate on the review (the same stance production.ts takes for the verdict event). Used for every
   *  POST-run record — by then the session has already run, and losing an after-the-fact note must
   *  not change what the gate concludes. */
  private event(kind: EventKind, payload: unknown): void {
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
