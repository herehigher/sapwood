// retro.ts — implements PeripheralStub for the `retro` phase (#91, #77 decision 6): the
// self-evolution role. Analyzes the round (bounced plans, review rejections, budget overruns —
// and whatever else the round's own digest surfaces) and proposes improvements to
// prompts/config/docs EXCLUSIVELY as a PR through the normal gate② path — never a direct write.
// See prompts/retro.md for the CTO + user 2026-07-10 review-findings-philosophy amendment this
// role's prompt must carry (recurring findings are a design signal, not a fix queue; review
// findings are evidence to judge, not orders to follow).
//
// #111 PR-A (read-side hardening): retro no longer browses GitHub live. Its prompt is seeded
// with an ENGINE-BUILT, round-scoped digest (retro-digest.ts's buildRetroDigest — PR diffs +
// review signals for every PR the round touched, comments/labels for every escalated issue,
// commit history since round start), assembled deterministically BEFORE the session runs and
// substituted in as `{{round.digest}}` (run() below). The `gh pr view/list/diff` and
// `gh issue view/list` Bash grants that used to let the session fetch this itself are gone
// (RETRO_ALLOWED_TOOLS, below).
//
// #111 PR-B (write-side hardening): retro's ONE direct forge write, `gh pr create`, moves
// engine-side too — its allowedTools now carry NO `gh` entry at all (#111's acceptance
// criterion). The session's job ends at commit+push: it writes its intended PR (branch/title/
// body — or an explicit "none" for a quiet round) to a FIXED scratch path in its worktree
// (RETRO_SCRATCH_FILE; the engine chooses the path, never the session), and post-session the
// engine parses that file fail-closed (parseRetroScratch), VERIFIES the claimed branch really
// exists on the forge via an engine-side read (IForge.branchExists — a session claim is never
// trusted as evidence of a push), and only then calls forge.openPR() itself. Partial failures
// degrade visibly and durably (`retro-pr-degraded` event + stderr, the pushed branch preserved
// as evidence per the degrade-to-human policy), never a silent no-op and never a wedged round.
//
// UNLIKE plan-review.ts/harvest.ts's issues-only RoleRunner sessions, retro's job genuinely
// needs git (branch/commit/push) — a strictly wider write scope than peripheral.ts's
// ROLE_ALLOWED_TOOLS can express. RoleRunner still does the spawning (#87's
// spawn/sentinel/timeout/cost-parse machinery, unchanged); this module only supplies its own
// allowedTools/disallowedTools override (peripheral.ts's #91 addition) instead of the base
// issues-only pair.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { renderFactsTemplate } from "../loop/harvest.js";
import type { PeripheralStub } from "../loop/round.js";
import { type RoleRunner, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate } from "../roles/plan-review.js";
import type { RoundRow, State } from "../state/state.js";
import { buildRetroDigest } from "./retro-digest.js";

/** #91: retro's write scope — the FIRST role in this codebase whose job requires more than
 *  issues-only writes. Grants exactly what "propose via PR, never directly" needs: LOCAL git
 *  history/diff/status (its own worktree, never GitHub), file edits inside its own ephemeral
 *  worktree, and git branch/commit/push — nothing that mutates an issue (that is harvest's/
 *  plan-reviewer's/plan-drafter's scope, never retro's) and nothing that merges, reviews, or
 *  approves anything.
 *
 *  #111 PR-A: the live `gh pr view/list/diff` + `gh issue view/list` GitHub-browsing grants
 *  are GONE — that read surface is now the engine-built digest (module doc above), never a
 *  live session Bash call. `git diff/status/log` stay: local repo introspection inside the
 *  session's own worktree (checking its own uncommitted edits before it commits), not GitHub
 *  browsing — #111's scope item 1 names the `gh` browsing surface specifically, not local git
 *  plumbing a role that edits-and-commits routinely needs.
 *
 *  #111 PR-B: `Bash(gh pr create*)` is GONE too — the last `gh` entry. PR creation now
 *  originates in engine TypeScript from the session's validated scratch file, after an
 *  engine-verified push (module doc above). Retro's session surface is now: Read/Write/Edit
 *  inside its own worktree + local git — zero forge access of any kind.
 *
 *  Same best-effort-pattern-layer caveat as every other allow/deny list in this codebase (see
 *  peripheral.ts's enforcement doc on ROLE_ALLOWED_TOOLS): the REAL boundary is the unchanged
 *  fail-closed guard hook every session gets, never weakened here. This pair only narrows what
 *  the CLI permission layer allows without an interactive prompt. */
export const RETRO_ALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit," +
  "Bash(git branch*),Bash(git checkout*),Bash(git add*),Bash(git commit*),Bash(git push*)," +
  "Bash(git diff*),Bash(git status*),Bash(git log*)";

/** Direct-write / self-merge / issue-mutation paths retro must never reach — "proposals appear
 *  as branches/PRs only" (#91 acceptance criterion), asserted directly against these strings in
 *  retro.test.ts. `git push`ing straight to the default branch is denied by NAME (main/master)
 *  since a role session has no reliable way to ask "what is this repo's default branch" from a
 *  fixed string pattern. RESIDUAL, stated honestly (fable review PR #103 P3): an unusual
 *  default-branch name slips this pattern AND the guard hook — the guard's git category
 *  protects boundary FILES, not push targets — so the only backstop today is GitHub-side
 *  branch protection, if the repo has it configured (nothing, otherwise). The structural fix
 *  (derive the repo's real default branch and deny it dynamically) is tracked in #102's
 *  tool-scope hardening, not here.
 *
 *  #111 PR-B: with the allow-list now carrying zero `gh` entries, every `gh` deny below
 *  (including `gh pr create *--body-file*`, #101) is a REGRESSION TRIP-WIRE rather than a live
 *  constraint — same stance as peripheral.ts's ROLE_DISALLOWED_TOOLS after #110 PR5: a future
 *  PR that re-widens the allow-list with a gh entry lands back inside these denies rather than
 *  silently reopening a closed bypass class. Kept byte-identical, deliberately. */
export const RETRO_DISALLOWED_TOOLS =
  "Bash(git push*main*),Bash(git push*master*)," +
  "Bash(gh pr merge*),Bash(gh pr review*),Bash(gh pr ready*)," +
  "Bash(gh pr edit*),Bash(gh issue edit*),Bash(gh issue comment*),Bash(gh api*)," +
  "Bash(gh pr create *--body-file*)";

// ── #111 PR-B: the PR-proposal scratch file — retro's session→engine return channel ─────────

/** The FIXED path (relative to the session's worktree root) retro writes its PR proposal to —
 *  chosen by the engine (threaded to RoleRunner via RoleSessionOpts.scratchFile), never by the
 *  session, so the engine always knows exactly where it looks and a session cannot redirect it.
 *
 *  FORMAT (parseRetroScratch below): either the single word `none` (an explicit quiet round —
 *  the prompt REQUIRES the file to always be written, so a MISSING file is distinguishable
 *  from "nothing to propose" and fails closed), or:
 *
 *      branch: <the pushed branch name>
 *      title: <the PR title>
 *      <the full PR body, raw markdown, from line 3 to EOF>
 *
 *  WHY a labeled-header file and not JSON or the structured-output sentinel block: the PR body
 *  is long markdown that routinely contains fenced code blocks and — for a role whose job is
 *  proposing changes to THIS codebase's prompts/docs — plausibly the sentinel strings
 *  themselves (structured-output.ts's containment rules would fail such a body closed by
 *  design). A raw file body needs no escaping at all (the same reason structured-output.ts
 *  carries bodies OUTSIDE its JSON segment), and a file written mid-session right after the
 *  push survives the truncated-stream/context-cutoff endings that lose a final message. The
 *  two labeled header lines fail closed on anything malformed. */
export const RETRO_SCRATCH_FILE = ".sapwood-retro-pr";

export type RetroScratch =
  | { kind: "none" }
  | { kind: "proposal"; branch: string; title: string; body: string }
  | { kind: "invalid"; reason: string };

/** Branch-name sanity for a SESSION-authored string the engine will hand to forge reads/writes:
 *  ordinary ref characters only, no leading dash (argv safety), no `..` (ref/path traversal),
 *  and never the default branch by name (main/master — the same by-name deny the session's own
 *  `git push` pattern carries; a proposal PR from the default branch is meaningless anyway). */
function invalidBranchReason(branch: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return `branch name has unexpected characters: ${JSON.stringify(branch)}`;
  if (branch.includes("..")) return `branch name contains "..": ${JSON.stringify(branch)}`;
  if (branch === "main" || branch === "master") return `refusing a proposal from the default branch (${branch})`;
  return null;
}

/** Parse + validate retro's scratch file, FAIL-CLOSED: anything that isn't exactly `none` or a
 *  well-formed proposal (both header lines present and labeled, sane branch name, non-empty
 *  title and body) is `invalid` with a named reason — fed to runSessionWithRetry's isValid
 *  hook (retry once, then retro's degrade path), never a best-guess partial parse. `undefined`
 *  (RoleRunner found no file) is invalid too: the prompt requires the file ALWAYS be written,
 *  so absence means the session broke its output contract, not a quiet round. */
export function parseRetroScratch(text: string | undefined): RetroScratch {
  if (text === undefined) return { kind: "invalid", reason: `scratch file ${RETRO_SCRATCH_FILE} missing — the session never wrote it` };
  if (text.trim() === "none") return { kind: "none" };
  if (text.trim() === "") return { kind: "invalid", reason: "scratch file is empty" };
  const lines = text.split("\n");
  const bm = (lines[0] ?? "").match(/^branch:[ \t]*(\S.*)$/);
  if (!bm) return { kind: "invalid", reason: `first line must be "branch: <name>" (or the whole file exactly "none")` };
  const tm = (lines[1] ?? "").match(/^title:[ \t]*(\S.*)$/);
  if (!tm) return { kind: "invalid", reason: `second line must be "title: <text>"` };
  const branch = bm[1]!.trim();
  const title = tm[1]!.trim();
  const body = lines.slice(2).join("\n").trim();
  const badBranch = invalidBranchReason(branch);
  if (badBranch) return { kind: "invalid", reason: badBranch };
  if (body === "") return { kind: "invalid", reason: "PR body is empty (everything from line 3 on)" };
  return { kind: "proposal", branch, title, body };
}

export interface RetroDeps {
  /** #111 PR-A: the digest's read surface — every PR-diff/review/issue-comment/label fetch
   *  the engine makes on retro's behalf now goes through here, never through a live session
   *  Bash call (see retro-digest.ts's buildRetroDigest, the module doc above). */
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests fake the underlying session directly (same "fake the collaborator, not
   *  the CLI" split as plan-review.ts's/harvest.ts's own tests). */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

export function retroMarker(roundId: number): string {
  return `<!-- sapwood:round:${roundId}:retro -->`;
}

export function defaultRetroPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "retro.md");
}

/** The round facts retro's prompt is seeded with — "bounced plans, review rejections, budget
 *  overruns" per #91's scope, sourced from durable `state` (events since round.started_at),
 *  same convention as harvest.ts's gatherRoundFacts. This is a STARTING POINT, never the whole
 *  analysis — the prompt (prompts/retro.md) points the session at the round's DIGEST (below,
 *  `{{round.digest}}` — retro-digest.ts's engine-built PR-diff/review/issue-comment text) for
 *  the actual detail behind these counts; the numbers alone can't tell it WHY something
 *  recurred or whether it matters. */
export interface RetroFacts {
  roundId: number;
  /** Soft-budget graceful handoffs this round — the "budget overruns" signal. */
  handoffs: number;
  /** DRIVE-phase gate② rejections (`drive-needs-human`) PLUS gate⓪ plan-review escalations
   *  (`plan-review-escalated`) this round — the "review rejections" signal, now covering both
   *  gates (#104: plan-review.ts's `escalate()` appends the latter alongside its forge label/
   *  comment, closing the gap this doc used to name — only gate② was visible here before). The
   *  retro prompt points at the round digest for PR/issue detail rather than relying solely on
   *  this count — the numbers are a starting point, not the whole analysis (see the interface
   *  doc above). */
  needsHumanEscalations: number;
  /** Hard-ceiling escalations (daily budget / wall-clock breach) this round — a second, more
   *  severe "budget overrun" signal, distinct from a single lane's soft-budget handoff. */
  ceilingEscalations: number;
}

/** The event kinds retro's own "raw material" comes from (prompts/retro.md: bounced plans,
 *  review rejections, budget overruns) — backs BOTH gatherRetroFacts's counts (below) and
 *  retro-digest.ts's per-issue digest detail (buildRetroDigest's `issueEventKinds` param, run()
 *  below) — one list, not two independently-maintained ones. */
const RETRO_EVENT_KINDS = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];

export function gatherRetroFacts(state: State, round: RoundRow): RetroFacts {
  const events = state.eventsSince(round.started_at, RETRO_EVENT_KINDS);
  const count = (kind: string): number => events.filter((e) => e.kind === kind).length;
  return {
    roundId: round.round_id,
    handoffs: count("handoff"),
    needsHumanEscalations: count("drive-needs-human") + count("plan-review-escalated"),
    ceilingEscalations: count("ceiling-escalated"),
  };
}

function factVars(facts: RetroFacts): Record<string, string> {
  return {
    "round.id": String(facts.roundId),
    "round.handoffs": String(facts.handoffs),
    "round.needsHumanEscalations": String(facts.needsHumanEscalations),
    "round.ceilingEscalations": String(facts.ceilingEscalations),
  };
}

/** Builds the `retro` phase's PeripheralStub. Idempotence (#77 decision 4): a non-null incoming
 *  marker means a prior attempt this round already ran this phase — returned UNCHANGED, no
 *  session re-dispatched. Unlike harvest's "no needs-human issues, no session" shortcut, retro
 *  otherwise dispatches once per round when reached: recurring-pattern detection (prompts/
 *  retro.md rule 1) needs the session's OWN judgment over history the orchestrator doesn't
 *  pre-filter — there is no cheap structural test for "nothing worth proposing" the way
 *  harvest's empty needs-human list is. #104: the ONE cadence knob is
 *  `roles.retro.everyNRounds` (default 1 = every round, unchanged from #91) — a round whose id
 *  isn't a multiple of N skips the session entirely (still sets the marker; the phase always
 *  closes, never wedges the round).
 *
 *  KNOWN GAP: peripheral.ts's RoleRunner always deletes a session's ephemeral worktree
 *  afterward (documented there as safe because an issues-only role session never has real
 *  WIP) — retro is the first role that breaks that assumption: a session that times out or
 *  crashes after editing but before committing+pushing loses that attempt's draft silently,
 *  with no #69-style dirty-worktree retention/escalation. Accepted for this scoped PR (no
 *  safety issue — retro proposes nothing destructive, and the next round's retro simply tries
 *  again); worth revisiting if this proves costly in practice. */
export function createRetroStub(deps: RetroDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker };
      const cadence = deps.cfg.roles.retro.everyNRounds;
      if (roundId % cadence !== 0) return { marker: retroMarker(roundId) }; // thinned round — no session, phase still closes
      const round = deps.state.getRound(roundId);
      if (!round) return { marker: retroMarker(roundId) }; // defensive; round.ts always supplies a real row
      const facts = gatherRetroFacts(deps.state, round);
      // #111 PR-A: the engine-built read digest — PR diffs + review signals for every PR the
      // round touched, comments/labels for every escalated issue, commit history since round
      // start (retro-digest.ts's IForge.getCommitsSince — a `gh api` read, never a local `git
      // log` subprocess; see that module's doc for the #69 grep-invariant this respects).
      // Assembled BEFORE the session runs, bounded by roles.retro.digestMaxChars (a hard cap,
      // deterministic truncation — retro-digest.ts's capDigest), and substituted into the
      // prompt below as `{{round.digest}}` — the session's ONLY read surface into this round's
      // history now (RETRO_ALLOWED_TOOLS above carries no `gh` read grant anymore).
      const digest = await buildRetroDigest(
        { forge: deps.forge, state: deps.state },
        round,
        deps.cfg.roles.retro.digestMaxChars,
        RETRO_EVENT_KINDS,
      );
      const template = loadRolePromptTemplate(deps.cfg.roles.retro.promptFile, defaultRetroPromptPath());
      const rendered = renderFactsTemplate(template, { ...factVars(facts), "round.digest": digest });
      const role = deps.cfg.roles.retro;
      // Same outcome-check-and-retry as harvest.ts (gate② P2 on the sibling #100/#101 PRs:
      // RoleRunner.run never throws on the session's own outcome, so an unchecked failed/
      // timeout session would silently count as "retro done"). #104: ported to peripheral.ts's
      // shared runSessionWithRetry (outcome-check -> retry-once -> visible-degradation, ONE
      // implementation for architect/align/harvest/retro) — a second failure degrades visibly
      // (durable event + stderr) but still closes the phase — a retro session proposes
      // improvements only, so a lost pass costs one round's proposals and nothing else; the
      // next round's retro sees the same history and can pick it back up. #111 PR-B: `isValid`
      // extends "failure" to a "done" session whose scratch file is missing/malformed (the
      // prompt requires the file ALWAYS be written — `none` for a quiet round), the same
      // invalid-attempt semantics every #110 structured-output role uses.
      const result = await runSessionWithRetry({
        runner: deps.runner,
        state: deps.state,
        session: {
          roleId: "retro",
          prompt: rendered,
          model: role.model,
          effort: role.effort,
          fallbackModel: role.fallbackModel,
          allowedTools: RETRO_ALLOWED_TOOLS,
          disallowedTools: RETRO_DISALLOWED_TOOLS,
          scratchFile: RETRO_SCRATCH_FILE,
        },
        issue: 0, // round-level spend, no single associated issue — same 0 sentinel as harvest.ts
        now: deps.now ?? (() => new Date()),
        degradeEvent: "retro-degraded",
        degradePayload: (result) => ({
          round_id: roundId,
          outcome: result.outcome,
          session: result.name,
          attempts: 2,
        }),
        degradeMessage: (result) =>
          `sapwood: ${retroDegradeReason(result)} for round ${roundId} — ` +
          `closing the retro phase WITHOUT a proposal pass (degraded, see the retro-degraded ` +
          `event); the run is not blocked`,
        isValid: (result) => parseRetroScratch(result.scratchText).kind !== "invalid",
      });
      // #111 PR-B: the engine-side write half. Only a validated PROPOSAL reaches the forge —
      // `none` (a quiet round) and a degraded session (runSessionWithRetry already recorded it)
      // both end here with the phase closed and nothing written.
      if (result.outcome === "done") {
        const scratch = parseRetroScratch(result.scratchText);
        if (scratch.kind === "proposal") await openProposalPR(deps, roundId, scratch);
      }
      return { marker: retroMarker(roundId) };
    },
  };
}

/** Names the degrade cause on the stderr line — a session-level failure (crashed/timed out) is
 *  distinguished from a session that exited clean but whose scratch file never validated, same
 *  split harvestDegradeReason (harvest.ts) / reviewerDegradeReason (plan-review.ts) make. */
function retroDegradeReason(result: { outcome: string; scratchText?: string }): string {
  if (result.outcome !== "done") return `retro session failed twice (${result.outcome})`;
  const s = parseRetroScratch(result.scratchText);
  return s.kind === "invalid" ? `retro session produced an invalid PR scratch file twice (${s.reason})` : "retro session ok"; // unreachable on the degrade path; keeps the reason total
}

/** #111 PR-B: verify-then-open, entirely engine-side. Every failure mode degrades VISIBLY and
 *  DURABLY (`retro-pr-degraded` event + stderr) but never throws — the retro phase must close
 *  and the round must never wedge over a proposal PR (same advisory-role stance as the session
 *  degrade path above). Partial-failure semantics, in order:
 *
 *  1. Push verification (forge.branchExists — an ENGINE-side forge read; the scratch file's
 *     claim is never trusted as evidence): branch absent -> NO openPR call at all, degrade
 *     naming the claimed branch. Fail direction: an indeterminate check (network/auth error
 *     reads as `false`, see IForge.branchExists) also declines to open — never a PR against an
 *     unverified head.
 *  2. openPR itself throws AFTER a verified push -> degrade; the PUSHED BRANCH is the preserved
 *     evidence (degrade-to-human policy: a human — or the next round's retro, which sees the
 *     same history — can open the PR from it by hand; nothing is lost silently).
 *  3. Success -> a durable `retro-pr-opened` event (round_id/pr/branch), the audit-trail
 *     counterpart of conductor.ts's DRIVE-phase events; contained like every other appendEvent
 *     call site (the PR already exists on the forge — the externalized artifact — so a state
 *     hiccup here must not fail the phase).
 *
 *  Crash-rerun note (#77 decision 4): the phase marker persists only after run() returns, so a
 *  crash between openPR and marker persistence re-runs the whole phase; the rerun's own openPR
 *  for the same head branch fails at the forge ("a PR already exists") and lands in case 2's
 *  visible degrade — a noisy duplicate-attempt signal, never a duplicate PR. */
async function openProposalPR(deps: RetroDeps, roundId: number, p: { branch: string; title: string; body: string }): Promise<void> {
  const degrade = (reason: string): void => {
    try {
      deps.state.appendEvent("retro-pr-degraded", { round_id: roundId, branch: p.branch, title: p.title, reason });
    } catch {
      /* state write failed — the stderr line below still lands */
    }
    console.error(`sapwood: retro round ${roundId}: ${reason} — no PR opened; the retro phase still closes`);
  };
  let pushed: boolean;
  try {
    pushed = await deps.forge.branchExists(p.branch);
  } catch (e) {
    degrade(`push verification errored (${String(e)})`); // defensive; GithubForge itself never throws here
    return;
  }
  if (!pushed) {
    degrade(
      `scratch file proposes branch "${p.branch}" but no such branch exists on the forge — ` +
        `the session's push claim could not be verified engine-side`,
    );
    return;
  }
  try {
    const pr = await deps.forge.openPR(p.branch, p.title, p.body);
    try {
      deps.state.appendEvent("retro-pr-opened", { round_id: roundId, pr, branch: p.branch });
    } catch {
      /* the PR itself is the externalized artifact — a state hiccup never fails the phase */
    }
  } catch (e) {
    degrade(
      `openPR failed for verified-pushed branch "${p.branch}" (${String(e)}) — the pushed branch ` +
        `is preserved evidence; open the PR manually or let a later round's retro re-propose`,
    );
  }
}
