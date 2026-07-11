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
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "./config.js";
import type { ModelUsageEntry, State } from "./state.js";
import {
  claudeArgs, guardSettings, discoverClaudeBin, parseCostUsd, parseModelUsage, parseResultText,
  spawnClaudeSession, type SpawnedSession,
} from "./worker.js";

/** #110 PR5: issues-only role sessions (plan-reviewer, plan-drafter, PO/align+triage, harvest,
 *  architect) carry NO Bash grant at all — ROLE_ALLOWED_TOOLS is empty. Each session is pure
 *  computation: its prompt never instructs a `gh` command, its final message ends in a
 *  structured block (structured-output.ts), and the engine (plan-review.ts/align.ts/harvest.ts/
 *  architect.ts) performs every GitHub write itself via IForge from schema-validated output. The
 *  real boundary is simply the absence of any Bash grant — no shell exists for a role session to
 *  reach `gh` through at all, so the #102/#108 quoting/short-flag bypass classes are moot for
 *  these roles.
 *
 *  ROLE_DISALLOWED_TOOLS below is KEPT, byte-identical, as a regression trip-wire: a future PR
 *  that re-widens ROLE_ALLOWED_TOOLS with a `Bash(...)` entry lands back inside these denies
 *  rather than silently reopening a bypass class #102/#108 already closed at the pattern layer.
 *  It does no live enforcement today (see peripheral.ts's #99 note that Bash glob patterns were
 *  always best-effort, backstopped by the unchanged fail-closed guard hook). */
export const ROLE_ALLOWED_TOOLS = "";
export const ROLE_DISALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit,Bash(git *),Bash(gh pr *),Bash(gh api *),Bash(gh issue view*)," +
  "Bash(gh issue list*),Bash(gh issue close*),Bash(gh issue reopen*),Bash(gh issue transfer*)," +
  "Bash(gh issue delete*)," +
  "Bash(gh issue comment *--body-file*),Bash(gh issue edit *--body-file*)," +
  "Bash(gh issue comment* -F*),Bash(gh issue edit* -F*)";

/** The plan-DRAFTER's stricter deny list (#77 Amendment 2's plan-author ≠ plan-approver chain):
 *  everything above PLUS label mutation, kept as the same regression trip-wire ROLE_DISALLOWED_
 *  TOOLS is (see its doc above) — the drafter has no Bash grant to mutate a label with in the
 *  first place; label discipline is now structural (plan-review.ts never calls forge.addLabel
 *  on the drafter's behalf, see that module's doc). */
export const PLAN_DRAFTER_DISALLOWED_TOOLS =
  ROLE_DISALLOWED_TOOLS + ",Bash(gh issue edit *--add-label*),Bash(gh issue edit *--remove-label*)";

/** #110 PR5: the PO/alignment role also carries no Bash grant — `gh issue create` is performed
 *  by the engine from align.ts's validated structured output, never by the session itself.
 *  PO_ALLOWED_TOOLS is kept as its own export (rather than folded away) so align.ts's callsite
 *  still documents which role-specific allow/deny pair it wires, unchanged in shape from before
 *  #110 even though its value is now identical to the base ROLE_ALLOWED_TOOLS. */
export const PO_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS;

/** The PO's matching deny list, kept byte-identical as the same regression trip-wire class as
 *  ROLE_DISALLOWED_TOOLS above (`--body-file`/`--label`/`--project` and their `-F`/`-l`/`-p`
 *  short-flag aliases on `gh issue create`, #101/#102) — the real boundary is PO_ALLOWED_TOOLS
 *  carrying no Bash grant at all, not this pattern layer. */
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
  /** #89/#91/#110: per-role ALLOW-list override — the symmetric widening counterpart to
   *  disallowedTools below, for a role whose job legitimately needs MORE than the base
   *  issues-only ROLE_ALLOWED_TOOLS (now empty, #110 PR5). retro.ts's RETRO_ALLOWED_TOOLS (git +
   *  `gh pr create`, #77 decision 6 — proposals land EXCLUSIVELY as PRs) is the ONLY remaining
   *  widening pair: PO_ALLOWED_TOOLS used to widen for `gh issue create` (#89) but #110 retired
   *  that need — the engine performs issue creation itself from align.ts's validated structured
   *  output now. Omitted -> the base ROLE_ALLOWED_TOOLS, unchanged for every role that doesn't
   *  need it. Widening the allow-list is always paired with a role-specific disallowedTools
   *  override too (see retro.ts) — never shipped wide-open. */
  allowedTools?: string;
  /** Per-role deny-list override (e.g. PLAN_DRAFTER_DISALLOWED_TOOLS). Omitted -> the base
   *  ROLE_DISALLOWED_TOOLS. Deny rules take precedence over allows in Claude Code, so this
   *  only ever narrows the base allow scope, never widens it. */
  disallowedTools?: string;
  /** #111 PR-B: an ENGINE-CHOSEN relative path inside the session's ephemeral worktree, read
   *  by the runner RIGHT BEFORE the worktree's unconditional deletion and returned as
   *  RoleSessionResult.scratchText. This is the return channel for a role whose deliverable is
   *  too session-lifecycle-coupled for the final-message structured block (retro writes its PR
   *  proposal to this file mid-session, after its git push — a file survives a truncated
   *  stream/context cutoff that would lose the final message, and a raw file has no
   *  embedded-sentinel collision surface for a body that documents this very codebase). The
   *  path is fixed BY THE CALLER (retro.ts's RETRO_SCRATCH_FILE), never by the session — the
   *  engine decides where it looks; the session can only decide what the file says.
   *
   *  CONTAINMENT (Codex round 1, PR #119): "inside the worktree" is enforced by run() itself,
   *  not assumed — a path that resolves outside the session's worktree root (`../`-escaping,
   *  absolute) is refused with a stderr line and reads as absent (scratchText undefined),
   *  never a file read outside the root. */
  scratchFile?: string;
}

export interface RoleSessionResult {
  outcome: "done" | "failed" | "timeout";
  costUsd: number;
  modelUsage: ModelUsageEntry[];
  exitCode: number | null;
  /** The session/lane name this run used — callers key spend-ledger rows off it. */
  name: string;
  /** #110 PR1: the session's final-message text, extracted via worker.ts's parseResultText —
   *  the READ side a role-session caller needs to actually consume structured output (PR0 added
   *  the extraction primitive but wired no caller to it). Always present (possibly "") on a
   *  REAL RoleRunner.run() result; optional here only so the many existing test fakes across
   *  align.test.ts/architect.test.ts/harvest.test.ts/retro.test.ts/round-defaults.test.ts (roles
   *  that don't consume structured output yet, per #110's PR sequence) keep compiling without
   *  updating every literal they construct. A caller that DOES need it reads `?? ""`, the same
   *  empty-string-not-undefined convention parseResultText itself already guarantees. */
  resultText?: string;
  /** #111 PR-B: the raw content of RoleSessionOpts.scratchFile, read from the session's
   *  worktree immediately BEFORE its unconditional deletion. undefined when no scratchFile was
   *  requested OR the file was absent/unreadable — the caller's validator decides what a
   *  missing file means (retro.ts treats it as an invalid attempt: fail closed, retry once,
   *  then the degrade path — never a silently skipped deliverable). */
  scratchText?: string;
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
    // #110 PR1: the structured-output READ side — same jsonl scan parseCostUsd/parseModelUsage
    // already do, so this costs nothing extra to compute even for roles that don't consume it.
    const resultText = parseResultText(jsonl);
    const outcome: "done" | "failed" | "timeout" = timedOut ? "timeout" : exitCode === 0 ? "done" : "failed";
    const sentinelTag = outcome === "timeout" ? "failed" : outcome;
    this.writeJsonAtomic(this.path(name, `${sentinelTag}.json`), {
      name, role_id: opts.roleId, session_id: sessionId, exit_code: exitCode,
      total_cost_usd: costUsd, model_usage: modelUsage, ended_at: this.now().toISOString(),
      timed_out: timedOut,
    });
    this.removeIfExists(this.path(name, "running.json"));

    // #111 PR-B: read the caller-requested scratch file BEFORE the worktree deletion below —
    // the deliverable would otherwise be destroyed with the worktree. Absent/unreadable reads
    // as undefined (never a throw): the caller's own validator owns deciding what that means.
    //
    // PATH CONTAINMENT (Codex review round 1, PR #119): the API's contract is "a path INSIDE
    // the session's worktree" — enforced here, in the API itself, not left to callers. A bare
    // join() would let a `../..`-shaped or absolute scratchFile normalize OUTSIDE the worktree
    // and read arbitrary engine files into scratchText. Today's only caller passes a fixed
    // constant (retro.ts's RETRO_SCRATCH_FILE), but the invariant must hold regardless of who
    // calls tomorrow: resolve both sides and require the target to sit strictly UNDER the
    // worktree root. A violating path reads as absent (scratchText undefined — the caller's
    // fail-closed validator path) plus one stderr line naming it — never a read outside root.
    let scratchText: string | undefined;
    if (opts.scratchFile !== undefined) {
      const root = resolve(this.worktreeRoot, name);
      const target = resolve(root, opts.scratchFile);
      if (!target.startsWith(root + sep)) {
        console.error(
          `[sapwood:role] session ${name}: scratchFile ${JSON.stringify(opts.scratchFile)} resolves ` +
            `outside the session worktree (${target}) — refusing to read it; scratchText stays undefined`,
        );
      } else {
        try { scratchText = readFileSync(target, "utf8"); } catch { /* absent */ }
      }
    }

    // Always delete the worktree — see the module doc: a role session never writes code
    // (allowedTools scoping + the unchanged guard hook both block it), so unlike worker.ts's
    // dirty-vs-clean retention there is no WIP that could ever need preserving here. Retro's
    // one worktree deliverable (the scratch file) was already captured above; its actual code
    // proposal lives on its PUSHED BRANCH, never in the worktree.
    try { rmSync(join(this.worktreeRoot, name), { recursive: true, force: true }); } catch { /* best-effort */ }

    return {
      outcome, costUsd, modelUsage, exitCode, name, resultText,
      ...(scratchText !== undefined ? { scratchText } : {}),
    };
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
  /** #110 PR0: OPTIONAL extra pass/fail check beyond `outcome` itself. A "done" outcome that
   *  fails this predicate is treated as a NON-"done" outcome for retry/degrade purposes — e.g.
   *  a session that exited cleanly but whose structured final-message output failed schema
   *  validation (parseResultText's write-side consumers, landing in later #110 PRs). FAIL
   *  CLOSED on a throw (Codex review round 1, P2): a validator that THROWS (e.g. a future
   *  caller's bare zod.parse) counts as invalid — retry once, then the degrade path — never a
   *  propagated exception, which would wedge the round in violation of #110's "malformed output
   *  twice -> degrade path, never a wedged round". Omitted -> today's behavior is
   *  byte-identical: only `outcome` decides done vs. not-done. */
  isValid?: (result: RoleSessionResult) => boolean;
}

/** Run one role session; on a non-"done" outcome (or, when `isValid` is supplied, a "done"
 *  outcome that also fails `isValid` — #110 PR0), retry exactly once; on a SECOND such outcome,
 *  durably record the degradation (contained — a state-write failure here never throws, same
 *  fail-toward-more-work stance as every other appendEvent call site in this codebase) and log
 *  it to stderr. Always returns the LAST attempt's result (the caller decides what "still not
 *  done" means for its own phase: proceed without a note, skip a summary/proposal, etc. — this
 *  helper only owns the retry-and-degrade mechanics, never the phase's own business logic). */
export async function runSessionWithRetry(opts: RetriedSession): Promise<RoleSessionResult> {
  const iso = (): string => opts.now().toISOString();
  const attempt = async (): Promise<RoleSessionResult> => {
    const result = await opts.runner.run(opts.session);
    opts.state.recordSpend(result.name, opts.issue, result.costUsd, iso(), result.modelUsage);
    return result;
  };
  // isValid omitted -> isDone reduces to the original `outcome === "done"` check exactly.
  // A THROWING validator counts as invalid (fail closed, see the RetriedSession doc above) —
  // the throw must feed the retry/degrade machinery, never escape it.
  const isDone = (result: RoleSessionResult): boolean => {
    if (result.outcome !== "done") return false;
    if (!opts.isValid) return true;
    try {
      return opts.isValid(result);
    } catch {
      return false;
    }
  };
  let result = await attempt();
  if (!isDone(result)) {
    result = await attempt();
    if (!isDone(result)) {
      try {
        opts.state.appendEvent(opts.degradeEvent, opts.degradePayload(result));
      } catch { /* state write failed — the console line below still lands */ }
      console.error(opts.degradeMessage(result));
    }
  }
  return result;
}
