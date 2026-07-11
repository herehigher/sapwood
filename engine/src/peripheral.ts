// peripheral.ts — the peripheral role runner (#87): runs ONE headless Claude Code session
// scoped to issues-only writes (comment/label/edit issues — never code, never PR review,
// never approve, never merge). Reuses worker.ts's spawn machinery directly (spawnClaudeSession,
// claudeArgs, guardSettings, discoverClaudeBin, parseCostUsd/parseModelUsage) — this module
// never imports `node:child_process` itself (see the #69 grep-invariant test in
// worker.test.ts): worker.ts stays the engine's ONE module that touches the CLI/subprocess
// layer; this module adds a second, NARROWER session shape entirely on top of what it exports.
//
// Unlike WorkerSupervisor's dispatch-now/probe-later two-phase model (built for long-running,
// resumable, PR-producing lanes), a role session's whole point is to run to completion as ONE
// bounded `await` — round.ts's PeripheralStub.run() contract is exactly that shape. So
// RoleRunner.run() spawns, waits out the process, and returns — no probe(), no resume(), no
// dirty-worktree retention (a role session never writes code — allowedTools scoping AND the
// unchanged guard hook both block it — so its worktree is always safe to delete afterward).
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "./config.js";
import type { ModelUsageEntry, State } from "./state.js";
import {
  claudeArgs, guardSettings, discoverClaudeBin, parseCostUsd, parseModelUsage,
  spawnClaudeSession, type SpawnedSession,
} from "./worker.js";

/** Issues-only write scope (#87 task A): comment/label/edit ISSUES via `gh issue ...` — no
 *  file Read/Write/Edit, no git, no `gh pr`/`gh api` (no PR visibility, no review/approve/
 *  merge capability). Everything the session needs to know about the issue is already
 *  substituted into its prompt (issue.number/title/body/labels), so it needs no READ tool at
 *  all, only the two write actions its role requires.
 *
 *  WHAT ENFORCES WHAT (Codex PR #99 P1 — no aspirational claims):
 *  - These tool patterns are NOISE REDUCTION only, same caveat as worker.ts's lists. Claude
 *    Code's permission docs confirm Bash glob patterns DO support mid-pattern wildcards
 *    ("Wildcards can appear at any position in the command", e.g. `Bash(git * main)`), so the
 *    flag-level denies below (`*--body-file*`, `*--add-label*`, ...) genuinely match — but the
 *    same docs warn flag-constraining Bash patterns are FRAGILE and recommend PreToolUse hooks
 *    for reliable enforcement. Treat every deny below as best-effort.
 *  - The REAL boundaries are (1) the same fail-closed PreToolUse guard hook every session gets
 *    via guardSettings, unchanged, and (2) for the plan-drafter's label discipline
 *    specifically, plan-review.ts's fail-closed LABEL POST-CHECK: labels are snapshotted
 *    before each drafter session and re-fetched after — a drafter that added
 *    plan:approved/verify:n/a or removed needs-human/blocked is escalated to needs-human (an
 *    unconditional dispatch blocker that contains a poisoned plan:approved) regardless of
 *    whether any pattern below caught the command.
 *
 *  `--body-file` is denied for BOTH commands (and both roles): it reads body text from a
 *  FILE, which would pierce the no-repo-read boundary (the session has no Read tool for the
 *  same reason).
 *
 *  #102 (gate② on #101): `gh` accepts `-F` as a short alias for `--body-file` (confirmed via
 *  `gh issue comment/edit --help` — no `=`-form, no other spelling), and the original
 *  `*--body-file*` denies only matched the long flag. `-F` has NO authoritative backstop (unlike
 *  `--label`, see PO_DISALLOWED_TOOLS below) — the pattern layer below is the ONLY layer for this
 *  one, so its shape matters: a bare `*-F*` would also match a body/title CONTAINING the
 *  substring "-F" (over-broad, but still fails safe by over-denying) or, worse, flags like a
 *  hypothetical `--foo-Fbar` (under-broad if such a flag existed). The `subcommand* -F*` shape
 *  below requires "-F" be preceded by a space — i.e. its own argv token — which both long-flag
 *  substrings (`--body-file`, always two leading dashes) and non-flag text glued onto another
 *  word never produce. The first `*` binds DIRECTLY to the subcommand (`comment*`, not
 *  `comment *`): cobra/pflag accepts flags BEFORE positional args (`gh issue comment -F f 12`),
 *  and a literal space after the subcommand would consume the only space preceding a
 *  flag-first `-F`, silently un-denying that argv order (gate② finding on this very fix).
 *  Residual gap, same best-effort class as everything else here: `gh`'s pflag-style shorthand
 *  parser lets a boolean short flag CLUSTER with `-F` in one token (e.g. `-eF file` ==
 *  `-e -F file`), which would not contain a space directly before `-F`. Not covered — the
 *  guard hook remains the authoritative backstop for the residual case. */
export const ROLE_ALLOWED_TOOLS = "Bash(gh issue comment*),Bash(gh issue edit*)";
export const ROLE_DISALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit,Bash(git *),Bash(gh pr *),Bash(gh api *),Bash(gh issue view*)," +
  "Bash(gh issue list*),Bash(gh issue close*),Bash(gh issue reopen*),Bash(gh issue transfer*)," +
  "Bash(gh issue delete*)," +
  "Bash(gh issue comment *--body-file*),Bash(gh issue edit *--body-file*)," +
  "Bash(gh issue comment* -F*),Bash(gh issue edit* -F*)";

/** The plan-DRAFTER's stricter deny list (#77 Amendment 2's plan-author ≠ plan-approver chain):
 *  everything above PLUS label mutation — a drafter edits plan TEXT only, and must never
 *  self-apply `plan:approved`/`verify:n/a` or lift `needs-human`/`blocked`. Best-effort
 *  pattern layer only; the authoritative enforcement is plan-review.ts's label post-check
 *  (see ROLE_ALLOWED_TOOLS doc above). The plan-REVIEWER keeps label capability — applying
 *  `plan:approved`/`needs-human` is its legitimate job. */
export const PLAN_DRAFTER_DISALLOWED_TOOLS =
  ROLE_DISALLOWED_TOOLS + ",Bash(gh issue edit *--add-label*),Bash(gh issue edit *--remove-label*)";

/** #89: the PO/alignment role's ADDITIVE allow-list — everything the base role scope allows
 *  PLUS issue creation (`gh issue create`), the one write action goal decomposition needs that
 *  no earlier role required. Board-status/project mutations stay OUT OF REACH regardless: `gh
 *  api *` (the only channel GithubForge.setBoardStatus uses) remains in ROLE_DISALLOWED_TOOLS
 *  unchanged, so the PO structurally cannot set Status=Ready itself (locked decision 5 — only a
 *  human confirms Ready). Best-effort pattern layer only, same caveat as ROLE_ALLOWED_TOOLS
 *  above; the authoritative enforcement for what a PO-created issue carries is align.ts's
 *  post-session check (origin:agent stamp + plan-presence escalation). */
export const PO_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS + ",Bash(gh issue create*)";

/** The PO's matching deny list (security review, PR #101): `gh issue create` opens flag holes
 *  the base ROLE_DISALLOWED_TOOLS never had to close (its create-less scope made them moot):
 *  - `--body-file` reads ANY file into a (possibly public) issue body — the same file-read
 *    exfiltration channel the base list already denies on comment/edit, closed for create too;
 *  - `--label` could self-apply `plan:approved`/`verify:n/a` at creation (a gate⓪ bypass) —
 *    labels on PO-created issues are the ORCHESTRATOR's job (align.ts stamps origin:agent and
 *    post-checks for poisoned dispatch-path labels, the authoritative layer);
 *  - `--project` could place the new issue onto a board lane directly (a board write, locked
 *    decision 5's territory).
 *  Best-effort pattern layer, same caveat as everything above; the authoritative enforcement
 *  for the --label hole is align.ts's created-issue label post-check.
 *
 *  #102 (gate② on #101): each of the three flags above also has a short alias on `gh issue
 *  create` — confirmed via `gh issue create --help`: `-F` (body-file), `-l` (label), `-p`
 *  (project) — which the long-flag-only denies above never matched. Same `subcommand* -X*`
 *  space-boundary shape as ROLE_DISALLOWED_TOOLS's `-F` denies above (see that doc for the
 *  greediness/flag-first-order/residual-clustering rationale — it applies identically here).
 *  `-l`/`-p` both keep an authoritative backstop (align.ts's post-checks) unlike `-F`, so this
 *  is hardening for those two either way. */
export const PO_DISALLOWED_TOOLS =
  ROLE_DISALLOWED_TOOLS +
  ",Bash(gh issue create *--body-file*),Bash(gh issue create *--label*),Bash(gh issue create *--project*)," +
  "Bash(gh issue create* -F*),Bash(gh issue create* -l*),Bash(gh issue create* -p*)";

export interface RoleSessionOpts {
  /** A short, log-friendly role identity ("plan-reviewer", "plan-drafter", ...) — becomes
   *  part of the session's lane/sentinel name, never interpreted. */
  roleId: string;
  prompt: string;
  model: string;
  effort: string;
  /** #89/#91: per-role ALLOW-list override (e.g. PO_ALLOWED_TOOLS, retro.ts's
   *  RETRO_ALLOWED_TOOLS) — the symmetric widening counterpart to disallowedTools below, for a
   *  role whose job legitimately needs MORE than the base issues-only ROLE_ALLOWED_TOOLS: the
   *  PO's `gh issue create` (#89 goal decomposition) and retro's git + `gh pr create` (#77
   *  decision 6 — proposals land EXCLUSIVELY as PRs). Omitted -> the base ROLE_ALLOWED_TOOLS,
   *  unchanged for every role that doesn't need it. Widening the allow-list is always paired
   *  with a role-specific disallowedTools override too (see align.ts/retro.ts) — never shipped
   *  wide-open. */
  allowedTools?: string;
  /** Per-role deny-list override (e.g. PLAN_DRAFTER_DISALLOWED_TOOLS). Omitted -> the base
   *  ROLE_DISALLOWED_TOOLS. Deny rules take precedence over allows in Claude Code, so this
   *  only ever narrows the base allow scope, never widens it. */
  disallowedTools?: string;
}

export interface RoleSessionResult {
  outcome: "done" | "failed" | "timeout";
  costUsd: number;
  modelUsage: ModelUsageEntry[];
  exitCode: number | null;
  /** The session/lane name this run used — callers key spend-ledger rows off it. */
  name: string;
}

export interface RoleRunnerDeps {
  cfg: SapwoodConfig;
  /** Directory for sentinels/jsonl. Default <cwd>/data/sessions/roles (distinct from
   *  worker.ts's data/sessions/state — role sessions and worker lanes never share a
   *  namespace, so a name collision between the two is structurally impossible). */
  stateDir?: string;
  /** Parent directory holding each session's ephemeral git worktree — same convention as
   *  worker.ts's worktreeRoot. Default <cwd>/.claude/worktrees. */
  worktreeRoot?: string;
  claudeBin?: string;
  /** Path to the compiled guard hook. Default: the dist sibling of this module. */
  guardHookPath?: string;
  heartbeatMs?: number;
  now?: () => Date;
}

const SENTINEL_EXTS = ["running.json", "done.json", "failed.json", "jsonl"];

export class RoleRunner {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;

  constructor(private readonly deps: RoleRunnerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "roles");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("./guard-hook.js", import.meta.url));
    mkdirSync(this.dir, { recursive: true });
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
  private path(name: string, ext: string): string {
    return join(this.dir, `${name}.${ext}`);
  }

  /** Run ONE role session to completion. Never throws on the session's own outcome (done/
   *  failed/timeout are all normal returns) — only throws on a setup failure (name collision,
   *  missing guard hook in hard mode, spawn failure) that must abort the caller's whole
   *  attempt, mirroring worker.ts's dispatch() fail-fast contract for the same conditions. */
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    const name = `role-${opts.roleId}-${randomUUID().slice(0, 8)}`;
    for (const ext of SENTINEL_EXTS) {
      if (existsSync(this.path(name, ext))) {
        throw new Error(`role session name in use (${name}.${ext} exists) — reassign a fresh name`);
      }
    }
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `running a role session; refusing to run an unguarded session in hard mode`,
      );
    }
    const sessionId = randomUUID();
    const jsonlPath = this.path(name, "jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    // Same inline-JSON (never a file) guard wiring as worker.ts's dispatch(), for the same
    // reason: a settings FILE would be an on-disk target the session could try to mutate.
    const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
    const args = claudeArgs({
      prompt: opts.prompt, model: opts.model, effort: opts.effort,
      worktree: name, name, sessionId, settings: settingsJson,
      allowedTools: opts.allowedTools ?? ROLE_ALLOWED_TOOLS,
      disallowedTools: opts.disallowedTools ?? ROLE_DISALLOWED_TOOLS,
      // NB: no addDir — same as worker.ts's dispatch(): a role session must never see engine
      // state (sentinels, the sqlite db) via --add-dir.
    });
    const startedMs = this.now().getTime();
    const session = spawnClaudeSession(this.bin, args, {
      jsonlFd, env: { ...process.env, SAPWOOD_GUARD_MODE: guardMode },
    });

    // Register the exit listener BEFORE any await — same rationale as worker.ts's dispatch():
    // Node does not replay `exit` to late listeners, so a very fast exit must already be caught.
    let timedOut = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      session.onExit((code) => resolve(code));
    });

    let spawnErr: unknown;
    await new Promise<void>((resolve) => {
      session.onSpawn(() => resolve());
      session.onError((e) => { spawnErr = e; resolve(); });
    });
    if (spawnErr) {
      try { closeSync(jsonlFd); } catch { /* noop */ }
      this.removeIfExists(jsonlPath);
      throw new Error(`role session spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    session.onError(() => { /* post-spawn error: exitPromise's `exit` still resolves this */ });

    this.writeJsonAtomic(this.path(name, "running.json"), {
      name, role_id: opts.roleId, session_id: sessionId,
      wrapper_pid: session.pid, started_at: new Date(startedMs).toISOString(),
    });

    // Wall-clock timeout ceiling (worker.ts's heartbeatTick semantics, minus the live
    // soft-budget estimator — a role session's cost is bounded by its own scope, not tracked
    // mid-run): past worker.timeoutSec, kill the tree; the exit handler above still resolves
    // exitPromise (with whatever code the kill produces), so run() always returns normally.
    const hb = setInterval(() => {
      const elapsedSec = (this.now().getTime() - startedMs) / 1000;
      if (!timedOut && elapsedSec > this.deps.cfg.worker.timeoutSec) {
        timedOut = true;
        clearInterval(hb);
        void this.killTree(session);
      }
    }, this.hbMs);

    const exitCode = await exitPromise;
    clearInterval(hb);
    try { closeSync(jsonlFd); } catch { /* already closed */ }

    const jsonl = this.readJsonl(jsonlPath);
    const costUsd = parseCostUsd(jsonl);
    const modelUsage = parseModelUsage(jsonl);
    const outcome: "done" | "failed" | "timeout" = timedOut ? "timeout" : exitCode === 0 ? "done" : "failed";
    const sentinelTag = outcome === "timeout" ? "failed" : outcome;
    this.writeJsonAtomic(this.path(name, `${sentinelTag}.json`), {
      name, role_id: opts.roleId, session_id: sessionId, exit_code: exitCode,
      total_cost_usd: costUsd, model_usage: modelUsage, ended_at: this.now().toISOString(),
      timed_out: timedOut,
    });
    this.removeIfExists(this.path(name, "running.json"));

    // Always delete the worktree — see the module doc: a role session never writes code
    // (allowedTools scoping + the unchanged guard hook both block it), so unlike worker.ts's
    // dirty-vs-clean retention there is no WIP that could ever need preserving here.
    try { rmSync(join(this.worktreeRoot, name), { recursive: true, force: true }); } catch { /* best-effort */ }

    return { outcome, costUsd, modelUsage, exitCode, name };
  }

  private async killTree(session: SpawnedSession): Promise<void> {
    session.killGroup("SIGTERM");
    await sleep(200);
    session.killGroup("SIGKILL");
  }

  private readJsonl(p: string): string {
    try { return readFileSync(p, "utf8"); } catch { return ""; }
  }
  private writeJsonAtomic(p: string, obj: unknown): void {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj) + "\n");
    renameSync(tmp, p);
  }
  private removeIfExists(p: string): void {
    try { rmSync(p, { force: true }); } catch { /* noop */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── #104: shared session-retry helper ───────────────────────────────────────────────────────
//
// architect.ts/align.ts/harvest.ts/retro.ts each hand-rolled the exact same shape (a same-class
// recurrence flagged at gate② on #100/#101/#103): dispatch a role session, record its spend,
// and if its outcome isn't "done" — RoleRunner.run never throws on the session's OWN outcome
// (see the module doc above), so a failed/timeout result is a normal return that MUST be
// checked, not assumed — retry exactly once; a second non-"done" outcome degrades VISIBLY (a
// durable state event plus a stderr line) rather than either silently no-op'ing or wedging the
// round forever. Extracted here as the ONE implementation every caller now ports to.
//
// Deliberately NOT extracted: plan-review.ts's reviewer-session retry. Its shape diverges in a
// way that matters — a second failure there ESCALATES needs-human (a dispatch-gating verdict,
// via forge label/comment, not a state event) rather than degrading-and-proceeding, and only
// the reviewer (never the drafter) is retried at all. Forcing that into this same helper would
// either lose the escalation behavior or bloat the helper with a branch only one caller uses.

/** One session dispatch, with spend recorded against `issue` (0 = round-level, no single issue —
 *  the same documented sentinel every caller already used). */
export interface RetriedSession {
  runner: Pick<RoleRunner, "run">;
  state: Pick<State, "recordSpend" | "appendEvent">;
  session: RoleSessionOpts;
  /** spend_ledger's `issue` column: a real issue number, or 0 for round-level spend with no
   *  single associated issue (harvest/architect/retro's own documented sentinel). */
  issue: number;
  now: () => Date;
  /** The event kind appended on a SECOND non-"done" outcome (e.g. "architect-degraded"). */
  degradeEvent: string;
  /** Built from the final (second) attempt's result — callers keep full control over their own
   *  event payload shape (some include `attempts: 2`, some fold in an `issue` key only when
   *  non-zero — see harvest.ts/retro.ts vs. align.ts), so behavior stays byte-identical to what
   *  each site hand-rolled before this extraction. */
  degradePayload: (result: RoleSessionResult) => Record<string, unknown>;
  /** Same rationale: the stderr line's wording is role-specific ("advisory phase, round not
   *  wedged" vs. "pre-Ready, low stakes", ...), so the caller supplies it verbatim. */
  degradeMessage: (result: RoleSessionResult) => string;
}

/** Run one role session; on a non-"done" outcome, retry exactly once; on a SECOND non-"done"
 *  outcome, durably record the degradation (contained — a state-write failure here never throws,
 *  same fail-toward-more-work stance as every other appendEvent call site in this codebase) and
 *  log it to stderr. Always returns the LAST attempt's result (the caller decides what "still
 *  not done" means for its own phase: proceed without a note, skip a summary/proposal, etc. —
 *  this helper only owns the retry-and-degrade mechanics, never the phase's own business logic). */
export async function runSessionWithRetry(opts: RetriedSession): Promise<RoleSessionResult> {
  const iso = (): string => opts.now().toISOString();
  const attempt = async (): Promise<RoleSessionResult> => {
    const result = await opts.runner.run(opts.session);
    opts.state.recordSpend(result.name, opts.issue, result.costUsd, iso(), result.modelUsage);
    return result;
  };
  let result = await attempt();
  if (result.outcome !== "done") {
    result = await attempt();
    if (result.outcome !== "done") {
      try {
        opts.state.appendEvent(opts.degradeEvent, opts.degradePayload(result));
      } catch { /* state write failed — the console line below still lands */ }
      console.error(opts.degradeMessage(result));
    }
  }
  return result;
}
