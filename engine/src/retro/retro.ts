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
import type { IForge, PRStatus } from "../forge/forge.js";
import { renderFactsTemplate } from "../loop/harvest.js";
import type { PeripheralStub } from "../loop/round.js";
import { envFailureHook, type RoleRunner, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate } from "../roles/plan-review.js";
// #964: import ONLY — reviewer.ts is human-merge-only, never edited from here.
import { changesRequestedOnHead } from "../roles/reviewer.js";
import { kindsTagged } from "../state/event-kinds/index.js";
import type { RoundRow, State } from "../state/state.js";
import { buildRetroDigest, gatherRetroPRLifecycle, PR_TOUCHED_EVENT_KINDS } from "./retro-digest.js";

/** #91: retro's write scope — the FIRST role in this codebase whose job requires more than
 *  issues-only writes. Grants exactly what "propose via PR, never directly" needs: LOCAL git
 *  history/diff/status (its own worktree, never GitHub), file edits inside its own ephemeral
 *  worktree, and git branch/commit/push — nothing that mutates an issue (that is harvest's/
 *  verification-plan-reviewer's/verification-plan-drafter's scope, never retro's) and nothing that merges, reviews, or
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
 *  the CLI permission layer allows without an interactive prompt.
 *
 *  Capability DR #616 caveat: retro's session runs the ordinary, UNSEALED `RoleRunner` path —
 *  the same one every worker-class (producer) leg uses, never gate②'s `reviewCwd`-only
 *  `--strict-mcp-config` seal — so it inherits the operator's host MCP surface exactly like a
 *  worker leg does. The `peripheral.ts:244`-class caveat applies: an attached forge proxy is
 *  retro's only ENGINE-GRANTED forge reach, but an inherited ambient MCP server is a separate,
 *  unsealed channel this allow/deny list (and the guard hook's Bash/file-tool matcher) does not
 *  cover — see docs/security.md's worker-egress blind-spot section.
 *
 *  #235 PR-B: `Grep`/`Glob` added alongside the `Read` this role already carried — the same
 *  "explicit ALLOW for ALL peripheral roles" ruling peripheral.ts's ROLE_ALLOWED_TOOLS doc
 *  covers applies here too (retro's job is code-aware BY DESIGN, prompts/retro.md unchanged —
 *  it already searches/inspects its own worktree before proposing edits; it was simply missing
 *  two of the three read tools every other role now carries). Confined to this session's own
 *  ephemeral worktree by #235 PR-A's guard-hook containment, same as every other role. */
export const RETRO_ALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit,Grep,Glob," +
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
 *  silently reopening a closed bypass class. Kept byte-identical, deliberately.
 *
 *  #235 PR-B: `NotebookEdit` added as the same cross-source veto every issues-only role's deny
 *  list now carries (`--disallowedTools` overrides ANY source, including a target repo's own
 *  checked-out `.claude/settings.json`) — retro never needed notebook editing, so closing that
 *  channel explicitly costs nothing and matches the rest of the matrix.
 *
 *  #534 (PM ruling + fable architectural review, 2026-08-02): `Agent,Task` appended — this
 *  constant is NOT derived from peripheral.ts's ROLE_DISALLOWED_TOOLS (every other divergent-
 *  looking role deny — PLAN_DRAFTER/CONFIRM/PO/HARVEST — is `= ROLE_DISALLOWED_TOOLS`; retro is
 *  the one exception), so adding the spawn deny THERE alone would have left retro free to spawn
 *  subagents while documentation claimed the boundary was universal. That gap matters more here
 *  than anywhere else in the matrix: retro is the ONE peripheral role holding a REAL `Write`/
 *  `Edit`/`MultiEdit` + `Bash(git commit/push …)` grant (RETRO_ALLOWED_TOOLS above), so an
 *  unblocked retro fan-out would be a fan-out of WRITE-CAPABLE children, not read-only ones. */
export const RETRO_DISALLOWED_TOOLS =
  "NotebookEdit,Bash(git push*main*),Bash(git push*master*)," +
  "Bash(gh pr merge*),Bash(gh pr review*),Bash(gh pr ready*)," +
  "Bash(gh pr edit*),Bash(gh issue edit*),Bash(gh issue comment*),Bash(gh api*)," +
  "Bash(gh pr create *--body-file*),Agent,Task";

// ── #111 PR-B: the PR-proposal scratch file — retro's session→engine return channel ─────────

/** The FIXED path (relative to the session's worktree root) retro writes its PR proposal to —
 *  chosen by the engine (threaded to RoleRunner via RoleSessionOpts.scratchFile), never by the
 *  session, so the engine always knows exactly where it looks and a session cannot redirect it.
 *
 *  FORMAT (parseRetroScratch below): the single word `none` (an explicit quiet round — the
 *  prompt REQUIRES the file to always be written, so a MISSING file is distinguishable from
 *  "nothing to propose" and fails closed); a NEW proposal —
 *
 *      branch: <the pushed branch name>
 *      title: <the PR title>
 *      <the full PR body, raw markdown, from line 3 to EOF>
 *
 *  — or (#964) an UPDATE to a PR retro already opened —
 *
 *      update: <the PR number>
 *      branch: <the pushed branch name — must match that PR's RECORDED branch>
 *      <the full PR body to overwrite it with, from line 3 to EOF — leave empty to keep the
 *       existing body>
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
  // #964: the third outcome — repair a PR retro already opened (this round or a prior one)
  // rather than proposing a duplicate. `body: null` means "keep the existing PR body" (the
  // scratch's body lines were empty) — distinct from `body: ""`, which parseRetroScratch never
  // produces (an all-whitespace body collapses to null via the same `.trim()` the proposal
  // outcome uses for its OWN required-non-empty check, just without the requirement here).
  | { kind: "update"; pr: number; branch: string; body: string | null }
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

/** Parse + validate retro's scratch file, FAIL-CLOSED: anything that isn't exactly `none`, a
 *  well-formed proposal (both header lines present and labeled, sane branch name, non-empty
 *  title and body), or a well-formed `update:` (#964 — see RetroScratch's own doc) is `invalid`
 *  with a named reason — fed to runSessionWithRetry's isValid hook (retry once, then retro's
 *  degrade path), never a best-guess partial parse. `undefined` (RoleRunner found no file) is
 *  invalid too: the prompt requires the file ALWAYS be written, so absence means the session
 *  broke its output contract, not a quiet round.
 *
 *  #964: `update:` is checked BEFORE the proposal branch, since it is a DISTINCT first line
 *  (`update:` vs `branch:`) — the two forms cannot collide, so trying `update:` first costs
 *  nothing for a proposal/none file, which never matches it. */
export function parseRetroScratch(text: string | undefined): RetroScratch {
  if (text === undefined) return { kind: "invalid", reason: `scratch file ${RETRO_SCRATCH_FILE} missing — the session never wrote it` };
  if (text.trim() === "none") return { kind: "none" };
  if (text.trim() === "") return { kind: "invalid", reason: "scratch file is empty" };
  const lines = text.split("\n");
  const um = (lines[0] ?? "").match(/^update:[ \t]*(\S.*)$/);
  if (um) {
    const prText = um[1]!.trim();
    if (!/^[1-9]\d*$/.test(prText))
      return { kind: "invalid", reason: `"update:" line must give a positive PR number, got ${JSON.stringify(prText)}` };
    const ubm = (lines[1] ?? "").match(/^branch:[ \t]*(\S.*)$/);
    if (!ubm) return { kind: "invalid", reason: `second line must be "branch: <name>" for an "update:" outcome` };
    const ubranch = ubm[1]!.trim();
    const ubadBranch = invalidBranchReason(ubranch);
    if (ubadBranch) return { kind: "invalid", reason: ubadBranch };
    const ubody = lines.slice(2).join("\n").trim();
    return { kind: "update", pr: Number(prText), branch: ubranch, body: ubody === "" ? null : ubody };
  }
  const bm = (lines[0] ?? "").match(/^branch:[ \t]*(\S.*)$/);
  if (!bm) return { kind: "invalid", reason: `first line must be "branch: <name>" or "update: <pr>" (or the whole file exactly "none")` };
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
  now: () => Date;
  log?: (message: string) => void;
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
 *  below) — one list, not two independently-maintained ones.
 *
 *  #425: DERIVED from the central registry's `retro` tag rather than re-spelled here — the
 *  kinds themselves are declared once in `state/event-kinds/`, and event-kinds.test.ts asserts
 *  this list and those tags stay in agreement in both directions. Exported for that test. */
export const RETRO_EVENT_KINDS = kindsTagged("retro");

export function gatherRetroFacts(state: State, round: RoundRow): RetroFacts {
  // #403 (F25), PR #430 gate② P2: the round window is the id cursor `startRound` stamps, NOT
  // `started_at`. `eventsSince` compares against `events.ts`, which `appendEvent` writes from the
  // MACHINE clock, while `started_at` comes from the round's INJECTED clock — so any divergence
  // between the two (a fixture that seeds a round date, a host clock that steps backward
  // mid-round) silently drops this round's own events and retro reports a round in which nothing
  // happened. The id cursor is the mechanism #123 already added for exactly this, for exactly
  // this reason (see state.ts's v9->v10 migration comment: "the round's ledger WINDOW is
  // id-cursor-bounded, not timestamp-bounded"); the round-artifact read was converted then and
  // these three retro/digest readers were the ones left behind. `?? 0` covers a legacy
  // pre-migration row, same as every other start_event_id read.
  const events = state.eventsAfterId(round.start_event_id ?? 0, RETRO_EVENT_KINDS);
  const count = (kind: string): number => events.filter((e) => e.kind === kind).length;
  return {
    roundId: round.round_id,
    handoffs: count("handoff"),
    needsHumanEscalations: count("drive-needs-human") + count("plan-review-escalated"),
    ceilingEscalations: count("ceiling-escalated"),
  };
}

/** #961: every kind marking a worker lane genuinely starting/continuing work this process (a
 *  FRESH `supervisor.dispatch`/`resume()` call — conductor.ts's own `spawnFactFrom` call sites)
 *  — never a crash-adoption kind (`lane-adopted`, `fix-leg-adopted`) that only reconciles a
 *  session an earlier, now-dead process already resumed. Backs `isQuietRound`'s third signal.
 *
 *  #425: DERIVED from the central registry's `lane-session-start` tag; event-kinds.test.ts
 *  asserts this list and those tags agree. Exported for that test. */
export const LANE_SESSION_START_EVENT_KINDS = kindsTagged("lane-session-start");

/** #961: a QUIET round has no new material for retro to judge — zero events tagged `retro`
 *  (`gatherRetroFacts`'s raw material), zero tagged `pr-touched` (retro-digest.ts's
 *  `PR_TOUCHED_EVENT_KINDS`), and zero tagged `lane-session-start` (above), all within this
 *  round's id-cursor window (same `round.start_event_id` boundary `gatherRetroFacts`/
 *  `gatherTouchedPRs` use). NOT `parseRetroScratch`'s `none` outcome (a session that ran and
 *  judged nothing to propose) — this skips the session entirely, before it judges anything. A
 *  hand-merge to `main` from outside the loop trips none of these three — deliberately still
 *  quiet, since retro reflects on the loop's own work.
 *
 *  #964's FOURTH signal, checked only when the three above are ALL silent (it is the only one
 *  needing a live forge read, so it is never paid for on an otherwise-busy round): an own PR
 *  retro previously opened, now sitting in an ACTIONABLE state (red/inert CI, conflicting,
 *  changes-requested), is round material even with zero fresh dispatch this round — a red retro
 *  PR does not stop being retro's job to notice just because nothing else happened. A
 *  green-and-waiting own PR is NOT material — the quiet skip would otherwise be defeated for as
 *  long as a human hasn't merged it. Fail-closed on the forge read itself: any
 *  read failure (network, auth, a genuinely gone PR) reads as `true` (actionable) here — a wrong
 *  "actionable" costs one session's worth of digest-building; a wrong "quiet" costs a missed
 *  repair, and #964 explicitly takes the cheaper failure direction. Exported so tests assert on
 *  it directly. */
export async function isQuietRound(forge: IForge, state: State, round: RoundRow): Promise<boolean> {
  const since = round.start_event_id ?? 0;
  if (state.eventsAfterId(since, RETRO_EVENT_KINDS).length > 0) return false;
  if (state.eventsAfterId(since, PR_TOUCHED_EVENT_KINDS).length > 0) return false;
  if (state.eventsAfterId(since, LANE_SESSION_START_EVENT_KINDS).length > 0) return false;
  return !(await hasActionableOwnPR(forge, state));
}

/** #964: the live-forge half of `isQuietRound`'s fourth signal — split out so it is independently
 *  testable against a scripted forge without seeding a full round. Never throws: a per-PR forge
 *  read failure reads as actionable (see `isQuietRound`'s own fail-closed-direction doc) rather
 *  than propagating and wedging the round on a read this advisory. */
async function hasActionableOwnPR(forge: IForge, state: State): Promise<boolean> {
  for (const rec of gatherRetroPRLifecycle(state)) {
    let status: PRStatus;
    try {
      status = await forge.getPRStatus(rec.pr);
    } catch {
      return true; // fail-closed: an unreadable status is actionable, never silently quiet
    }
    if (status.state === "MERGED" || status.state === "CLOSED") continue;
    if (status.ciRed || status.ciInert || status.mergeable === "CONFLICTING") return true;
    try {
      const review = await forge.getPRReviewData(rec.pr);
      // #964: `changesRequestedOnHead`, not "the last review event" — see retro-digest.ts's
      // `classifyOutstandingPR` doc for the standing-state/head-pinning bug this closes; reused
      // (import only, reviewer.ts is human-merge-only) so this signal and the digest's own can
      // never independently drift.
      if (changesRequestedOnHead(review.reviews, status.headOid, review.author)) return true;
    } catch {
      return true; // fail-closed, same direction as the status read above
    }
  }
  return false;
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
 *  session re-dispatched. Skip checks run in order — marker, then cadence, then quiet. #104:
 *  the cadence knob is `roles.retro.everyNRounds` (default 1 = every round, unchanged from #91)
 *  — a round whose id isn't a multiple of N skips the session entirely (still sets the marker;
 *  the phase always closes, never wedges the round).
 *
 *  #961: a round that IS on-cadence but structurally QUIET (`isQuietRound`, above) skips too,
 *  same shape, plus one durable `retro-quiet-skipped` event so the skip is visible.
 *
 *  #428 (closes the gap this doc used to name): peripheral.ts's RoleRunner no longer deletes
 *  retro's worktree unconditionally. A session that times out or crashes after editing but
 *  before committing+pushing now has its worktree RETAINED on disk, with a durable
 *  `role-worktree-retained` event naming the path and this round's id — see
 *  RoleRunner.maybeRetainWorktree for the exact gate (write-capable grant + non-"done" outcome +
 *  a pure-filesystem, git-index-baselined dirty check) and its stated failure directions. The
 *  happy path is unchanged: a session that pushes and exits 0 still has its worktree deleted.
 *  Still deliberately NOT a #69-style needs-human escalation — retro has no issue/PR to attach
 *  one to and a lost draft is low-stakes (the next round simply tries again); the point is only
 *  that the loss is now recorded rather than silent. */
export function createRetroStub(deps: RetroDeps): PeripheralStub {
  return {
    async run({ roundId, marker }) {
      if (marker != null) return { marker };
      const cadence = deps.cfg.roles.retro.everyNRounds;
      if (roundId % cadence !== 0) return { marker: retroMarker(roundId) }; // thinned round — no session, phase still closes
      const round = deps.state.getRound(roundId);
      if (!round) return { marker: retroMarker(roundId) }; // defensive; round.ts always supplies a real row
      if (await isQuietRound(deps.forge, deps.state, round)) {
        deps.state.appendEvent("retro-quiet-skipped", { round_id: roundId });
        return { marker: retroMarker(roundId) }; // quiet round — no session, phase still closes
      }
      const facts = gatherRetroFacts(deps.state, round);
      // #111 PR-A: the engine-built read digest — PR diffs + review signals for every PR the
      // round touched, comments/labels for every escalated issue, commit history since round
      // start (retro-digest.ts's IForge.getCommitsSince — a `gh api` read, never a local `git
      // log` subprocess; see that module's doc for the #69 grep-invariant this respects).
      // Assembled BEFORE the session runs, bounded by roles.retro.digestMaxChars (a hard cap,
      // deterministic truncation — retro-digest.ts's capDigest), and substituted into the
      // prompt below as `{{round.digest}}` — the session's ONLY read surface into this round's
      // history now (RETRO_ALLOWED_TOOLS above carries no `gh` read grant anymore).
      // #453 (design #402 R5): the digest also carries the cross-round finding-class TENDENCY
      // table (roles.retro.tendencyRounds wide). The engine only tabulates it — whether a
      // recurring class is evidence about the design is retro's own judgment, reaching the
      // backlog only through the PR path below (ruling D5).
      const digest = await buildRetroDigest(
        { forge: deps.forge, state: deps.state },
        round,
        deps.cfg.roles.retro.digestMaxChars,
        RETRO_EVENT_KINDS,
        deps.cfg.roles.retro.tendencyRounds,
      );
      const template = loadRolePromptTemplate(deps.cfg.roles.retro.promptFile, defaultRetroPromptPath());
      // #701: the configured default working language for the proposal prose this role composes
      // (an issues/PRs surface) — see config.ts's `language` section doc comment.
      const rendered = renderFactsTemplate(template, {
        ...factVars(facts),
        "round.digest": digest,
        "lang.issuesAndPrs": deps.cfg.language.issuesAndPrs,
      });
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
          // #428: diagnostic only — lets the runner's `role-worktree-retained` event name the
          // round whose retro draft was kept when a session died before pushing.
          roundId,
        },
        issue: 0, // round-level spend, no single associated issue — same 0 sentinel as harvest.ts
        now: deps.now,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        // #236: record this phase's ambient-context manifest for EVERY attempt. `retro` is the
        // one role session that holds write-capable tools (Write + local git), so its recorded
        // worktree.dirty is honestly conservative ("unknown-write-capable-session"), never
        // assumed clean — see WorktreeGitState.dirtyBasis's doc.
        contextManifest: { roundId, phase: "retro", record: (key, json, at) => deps.state.recordContextManifest(key, json, at) },
        degradeEvent: "retro-degraded",
        degradePayload: (result) => ({
          round_id: roundId,
          outcome: result.outcome,
          session: result.name,
          attempts: 2,
        }),
        degradeMessage: (result) =>
          `[sapwood:retro] round ${roundId}: ${retroDegradeReason(result)} — ` +
          `closing the retro phase WITHOUT a proposal pass (degraded, see the retro-degraded ` +
          `event); the run is not blocked`,
        isValid: (result) => parseRetroScratch(result.scratchText).kind !== "invalid",
        // #374: quota/429 (or a forge signature from retro's own git push — this is the one role
        // session that holds write/git tools) parks instead of degrading — see peripheral.ts's
        // envFailureHook doc.
        envFailure: envFailureHook(deps.cfg, deps.state),
      });
      // #111 PR-B / #964: the engine-side write half. Only a validated PROPOSAL or UPDATE reaches
      // the forge — `none` (a quiet round) and a degraded session (runSessionWithRetry already
      // recorded it) both end here with the phase closed and nothing written.
      if (result.outcome === "done") {
        const scratch = parseRetroScratch(result.scratchText);
        if (scratch.kind === "proposal") await openProposalPR(deps, roundId, scratch);
        else if (scratch.kind === "update") await updateProposalPR(deps, roundId, scratch);
      }
      // #394 (F23): a session genuinely ran above — the off-cadence and no-round-row early
      // returns are the only skip paths (see PeripheralStub.ranSession's own doc).
      return { marker: retroMarker(roundId), ranSession: true };
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
    (deps.log ?? console.error)(`[sapwood:retro] round ${roundId}: ${reason} — no PR opened; the retro phase still closes`);
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
    // #964: record the head the NEW PR opened at — best-effort, off a SEPARATE read from openPR
    // itself (openPR's own return is just the PR number). A failure here never fails the phase
    // (the PR is already the externalized artifact) — it only means `updateProposalPR`'s later
    // head-moved check falls back to the legacy (no recorded `head`) comparison for this PR.
    let head: string | undefined;
    try {
      head = (await deps.forge.getPRStatus(pr)).headOid;
    } catch {
      /* best-effort — see comment above */
    }
    try {
      deps.state.appendEvent("retro-pr-opened", { round_id: roundId, pr, branch: p.branch, ...(head !== undefined ? { head } : {}) });
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

/** #964 What ②: the "update" scratch outcome — retro repairs an ALREADY-open PR it opened
 *  earlier (this round or a prior one) rather than proposing a duplicate. Verify-then-append,
 *  entirely engine-side, same never-throw shape as `openProposalPR`:
 *
 *  1. The PR must be one retro genuinely opened before — a `retro-pr-opened`/`retro-pr-updated`
 *     event naming it, ANYWHERE in history (`gatherRetroPRLifecycle` is NOT round-scoped, same
 *     reason its own doc gives: a retro PR outlives the round that opened it). A session cannot
 *     invent a PR number and have the engine touch it.
 *  2. The scratch's branch must equal the RECORDED branch for that PR — a session cannot redirect
 *     an update at a different branch than the one the PR actually opened from.
 *  3. `forge.branchExists` — the push claim is never trusted as evidence, same as openProposalPR.
 *  4. The branch's head must have MOVED since the last recorded event, read off the PR's own
 *     current status (the PR's source branch IS the pushed branch, so its `headOid` already
 *     reflects any new push — no separate branch-head read needed): compared against the
 *     recorded `head` when one exists (#964 records this going forward, see `openProposalPR`); a
 *     LEGACY record with no `head` (a pre-#964 `retro-pr-opened`) accepts once `branchExists` and
 *     the PR's current head differs from its base — the issue's own stated fallback, rather than
 *     refusing every pre-#964 PR an update forever.
 *
 *  Any mismatch degrades (`retro-pr-degraded`, `title` OMITTED — an update proposes no new title;
 *  round-artifact.ts's reader coalesces the absence to `""`) — NEVER a close/withdraw, per #964's
 *  explicit scope (a human closes). Success appends `retro-pr-updated`, then — only when the
 *  scratch carried a non-empty body — best-effort overwrites the PR's body (`forge.
 *  updateIssueBody`; PRs are issues under the hood, same endpoint retro-digest.ts's `getIssueBody`
 *  already leans on for a PR number). A `body: null` scratch (empty body lines — "keep the
 *  existing body") skips that call entirely; a body-write failure logs but does NOT degrade —
 *  the push itself already landed and is the substantive repair, a stale body text is a lesser,
 *  separately-visible gap. */
async function updateProposalPR(deps: RetroDeps, roundId: number, u: { pr: number; branch: string; body: string | null }): Promise<void> {
  const degrade = (reason: string): void => {
    try {
      deps.state.appendEvent("retro-pr-degraded", { round_id: roundId, pr: u.pr, branch: u.branch, reason });
    } catch {
      /* state write failed — the stderr line below still lands */
    }
    (deps.log ?? console.error)(`[sapwood:retro] round ${roundId}: ${reason} — PR #${u.pr} not updated; the retro phase still closes`);
  };
  const prior = gatherRetroPRLifecycle(deps.state).find((r) => r.pr === u.pr);
  if (!prior) {
    degrade(`scratch proposes "update: ${u.pr}" but retro never opened that PR — refusing to touch a PR it does not own`);
    return;
  }
  if (prior.branch !== u.branch) {
    degrade(`scratch's branch "${u.branch}" does not match PR #${u.pr}'s recorded branch "${prior.branch}"`);
    return;
  }
  let pushed: boolean;
  try {
    pushed = await deps.forge.branchExists(u.branch);
  } catch (e) {
    degrade(`push verification errored (${String(e)})`); // defensive; GithubForge itself never throws here
    return;
  }
  if (!pushed) {
    degrade(`scratch proposes updating branch "${u.branch}" but no such branch exists on the forge`);
    return;
  }
  let status: PRStatus;
  try {
    status = await deps.forge.getPRStatus(u.pr);
  } catch (e) {
    degrade(`could not read PR #${u.pr}'s status to verify the head moved (${String(e)})`);
    return;
  }
  const moved = prior.head !== undefined ? status.headOid !== prior.head : status.headOid !== status.baseOid;
  if (!moved) {
    degrade(
      prior.head !== undefined
        ? `PR #${u.pr}'s head (${status.headOid}) has not moved since the last recorded push (${prior.head}) — nothing to update`
        : `PR #${u.pr} has no recorded head to compare against (a pre-#964 PR) and its current head matches its base — nothing to update`,
    );
    return;
  }
  try {
    deps.state.appendEvent("retro-pr-updated", { round_id: roundId, pr: u.pr, branch: u.branch, head: status.headOid });
  } catch {
    /* the push itself is the externalized artifact — a state hiccup never fails the phase */
  }
  if (u.body !== null) {
    try {
      await deps.forge.updateIssueBody(u.pr, u.body);
    } catch (e) {
      (deps.log ?? console.error)(
        `[sapwood:retro] round ${roundId}: PR #${u.pr}'s push was recorded, but its body update failed (${String(e)}) — the body text is stale, not the repair itself`,
      );
    }
  }
}
