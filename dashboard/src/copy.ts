/**
 * The plain-language copy layer (frontend-design.md §7). One module, keyed by event kind:
 * every `events` row the server serves turns into a feed sentence through here, never through
 * ad-hoc string-building in a component.
 *
 * #893: `EventKind` is a TYPE-ONLY import from the engine's own event-kind registry
 * (`engine/src/state/event-kinds/index.ts`, #425) — erased at build, so the browser bundle
 * carries zero engine runtime code, but every registered engine kind is now a real member of
 * this file's own `EventKind` union. `COPY` carries the NARRATIVE kinds (full plain-language
 * sentences, §7's table); `TELEMETRY_KINDS` carries the rest (heartbeat/bookkeeping traffic) —
 * every kind in the union must land in exactly one of the two, which is what makes "an engine
 * kind with no copy entry" a build/test failure instead of a silent gap (the cross-package
 * exhaustiveness test in copy.test.ts; see also engine/src/state/event-kinds/index.ts's own
 * doc on the other side of this same import).
 */

import type { EventKind as EngineEventKind } from "../../engine/src/state/event-kinds/index.ts";

export type EventKind = EngineEventKind;

export type Payload = Record<string, unknown>;

/** An issue or PR number embedded in a sentence, carrying enough to render its type glyph and
 *  look up its hover title (frontend-design.md §3 C). A PR token's `issue` is the number the
 *  SAME event's payload carries alongside `pr` — every emitter that mentions a PR number also
 *  mentions its issue, except the retro self-improvement PR, which has none (`issue` stays
 *  `undefined`, and so does its tooltip — there is nothing to fold a title from). */
export type EntityToken = { kind: "issue"; number: number } | { kind: "pr"; number: number; issue?: number };

/** A link to a repo-relative doc path (frontend-design.md §7's `engine-review-containment-gap`
 *  row: "the place that explains what it means for a reader is the security guide, which this
 *  sentence should link"). `path` is repo-relative, not a full URL — `copy.ts` has no access to
 *  `repoUrl` (a pure function of `payload` only, same as every other entry), so the renderer
 *  (which already receives `repoUrl` for entity links) resolves it, exactly like `EntityRef`
 *  degrades to plain text when `repoUrl` is unknown instead of guessing a URL. */
export type LinkToken = { kind: "link"; path: string; label: string };

export type SentencePart = string | EntityToken | LinkToken;

const issueTok = (n: unknown): EntityToken => ({ kind: "issue", number: n as number });
const prTok = (n: unknown, issue?: unknown): EntityToken => ({
  kind: "pr",
  number: n as number,
  ...(issue !== undefined ? { issue: issue as number } : {}),
});
const linkTok = (path: string, label: string): LinkToken => ({ kind: "link", path, label });

/** `engine-review-containment-gap`'s `payload.gaps` codes (codex-exec.ts's own constants,
 *  e.g. `model-invoked-shell-execution`) — narrow, named patterns per the terminology rule
 *  (§7: "no jargon"), falling back to the raw code itself for an unrecognized one (honest,
 *  same as `fixReasonWord`'s own fallback) rather than a silent drop. */
const CONTAINMENT_GAP_LABELS: Record<string, string> = {
  "model-invoked-shell-execution": "the model can run shell commands directly",
  "host-wide-filesystem-reads": "it can read files anywhere on this machine, not just the reviewed code",
};

export interface CopyEntry {
  /** Renders the feed sentence as a token list — plain strings interleave with issue/PR
   *  references so the feed can substitute a glyph + tooltip for each entity number without
   *  parsing rendered text back apart. */
  sentence: (payload: Payload) => SentencePart[];
  /** Per §3/§7: a kind whose event leaves work waiting on a person carries this marker — `true`
   *  for every payload, or a predicate for kinds where only some payloads qualify. Absent
   *  entirely for a kind that never leaves work waiting on a person. */
  attention?: true | ((payload: Payload) => boolean);
  /** #893: present (`"telemetry"`) only on the generic entries `telemetryEntry` constructs for
   *  `TELEMETRY_KINDS` members — absent on every hand-authored narrative entry. The feed's
   *  default view reads this to collapse/exclude telemetry rows (opt-in to show); never set by
   *  hand on a `COPY` entry. */
  tier?: "telemetry";
}

/** #404's shared attention condition for both reclaim kinds, restated on the dashboard side of
 *  the same rule the engine's `escalation-reconcile.ts` enforces for its own label reconciler:
 *  a lane whose `next` is the automatic continuation (`"DRIVING"`) is not waiting on anybody;
 *  any other disposition is. Fail direction for a payload missing `next` entirely: attention —
 *  a visible row is recoverable, a silently-dropped one is not. */
const reclaimNeedsAttention = (payload: Payload): boolean => payload.next !== "DRIVING";

/** `drive-fixup`'s reason word, derived from the raw merge-driver reason string (`merge-driver
 *  .ts`'s `gate:FIXABLE:*` values) — narrow, named patterns rather than a wildcard, since the
 *  three prescriptions are the only ones that exist today and an unrecognized reason should read
 *  as itself, not silently as one of the three. */
function fixReasonWord(reason: unknown): string {
  const r = typeof reason === "string" ? reason : "";
  if (r.includes("CI_RED")) return "checks failed";
  if (r.includes("merge-conflict")) return "merge conflict";
  if (r.includes("findings")) return "review findings";
  return r || "a review finding";
}

/** #881 payload audit: `drive-needs-human`'s `reason` field (`conductor.ts`'s `escalateNeedsHuman`
 *  call sites) is a terse machine gate code (`gate:HUMAN:pr-state-closed`, `fix-loop-unwired:*`),
 *  not prose — narrow named patterns per the same doctrine `fixReasonWord` above already applies,
 *  falling back to the raw code (honest-unknown) rather than inventing a meaning for an
 *  unrecognized one. Empty/missing reason renders as an explicit "not recorded", never a blank —
 *  this IS the #881 payload-gap disclosure for the cases where no code was ever attached. */
function driveNeedsHumanReasonWord(reason: unknown): string {
  const r = typeof reason === "string" ? reason : "";
  if (r.includes("pr-state-closed")) return "the PR was closed outside the loop";
  if (r.includes("fix-loop-unwired")) return "the fix loop isn't wired for this path yet";
  return r || "reason not recorded";
}

/** #881: a fixed-string fallback for the handful of attention kinds whose engine payload carries
 *  no reason field at all today (`drive-no-pr`, `verify-na-proposed`, `worktree-retained` —
 *  see the payload audit in the #881 PR body) — an explicit, honest "not recorded" rather than a
 *  silently bare sentence, so the AC1 table-driven test can assert the gap is NAMED, not absent. */
const REASON_NOT_RECORDED = "reason not recorded";

/** `ceiling-breach-entered`/`ceiling-breach-cleared` branch on `payload.reason` (#431 round 3:
 *  one event per reason, each ceiling its own lifecycle) — see conductor.ts's `CeilingReason`. */
function ceilingReasonWord(reason: unknown): "wall-clock" | "daily-budget" | null {
  return reason === "wall-clock" || reason === "daily-budget" ? reason : null;
}

/** #890 (§3 E): the est→real calibration clause appended to `reclaim-done`'s sentence —
 *  `conductor.ts`'s `reclaimTerminalLane` attaches `estCostUsd` (the lane's own last-known
 *  live estimate, present only when the lane was still probed at least once while running)
 *  and `costUsd`'s OWN provenance flag, `costEstimated`. The clause labels `costUsd` "real",
 *  so it renders ONLY when that label is actually true — `costEstimated === false` (a
 *  provider-reported figure, known-real). Absent or `true` (unknown or itself an estimate)
 *  renders no clause at all — never a fabricated "real", and never an "est → est". */
function calibrationClause(payload: Payload): string {
  const est = payload.estCostUsd;
  const real = payload.costUsd;
  if (typeof est !== "number" || typeof real !== "number" || payload.costEstimated !== false) return "";
  return ` · est $${est.toFixed(2)} → real $${real.toFixed(2)}`;
}

const RESOLUTION_SENTENCE: Record<string, (p: Payload) => SentencePart[]> = {
  merged: (p) => ["Issue ", issueTok(p.issue), " no longer needs you — PR ", prTok(p.pr, p.issue), " was merged"],
  "issue-closed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — it was closed"],
  "pr-closed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — PR ", prTok(p.pr, p.issue), " was closed without merging"],
  "label-removed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — the flag was cleared"],
  "board-fixed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — the board was set to Done"],
};

/** The NARRATIVE half of the closed union — full plain-language sentences, §7's table. Every
 *  member below has a matching row in frontend-design.md §7; a kind absent from both this map
 *  and `TELEMETRY_KINDS` fails copy.test.ts's cross-package exhaustiveness test, never silently
 *  falls through to the raw wire fallback. */
export const COPY: Partial<Record<EventKind, CopyEntry>> = {
  dispatched: {
    sentence: (p) => ["Started work on issue ", issueTok(p.issue)],
  },
  "dispatch-failed": {
    sentence: (p) => ["Couldn't start issue ", issueTok(p.issue), " — it's back in the backlog"],
  },
  "reclaim-done": {
    // #881: the non-DRIVING branch is an attention row — payload carries an OPTIONAL `reason`
    // (the worker's own stated exit reason, `doneReason` in conductor.ts) when the worker gave
    // one; absent otherwise, rendered as an explicit not-recorded rather than silently dropped.
    // #890: `calibrationClause` appends the est→real calibration reading on either branch — a
    // lane's settlement, not its PR outcome, is what decides whether it applies.
    sentence: (p) => {
      const calibration = calibrationClause(p);
      return p.next === "DRIVING"
        ? [`Lane ${p.worker} opened a PR — now in review${calibration}`]
        : [
            `Lane ${p.worker} ended without a PR — ${typeof p.reason === "string" && p.reason ? p.reason : REASON_NOT_RECORDED} · asks: review the lane's outcome and decide whether to retry${calibration}`,
          ];
    },
    attention: reclaimNeedsAttention,
  },
  "reclaim-failed": {
    // #881: `reason` (`failedReason`) is only attached at one of the two conductor.ts emit sites
    // — optional, same not-recorded fallback as `reclaim-done` above.
    sentence: (p) => [
      `Lane ${p.worker} hit a problem and stopped — ${typeof p.reason === "string" && p.reason ? p.reason : REASON_NOT_RECORDED} · asks: investigate and decide whether to retry`,
    ],
    attention: reclaimNeedsAttention,
  },
  "reclaim-dead": {
    sentence: (p) => [`Lane ${p.worker} went silent — cleaned up; its issue goes back to the backlog`],
  },
  handoff: {
    sentence: (p) => [`Lane ${p.worker} reached its budget and saved its progress for a successor`],
  },
  merged: {
    sentence: (p) => ["Merged PR ", prTok(p.pr, p.issue), " — checks green and review approved"],
  },
  "drive-needs-human": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      ` needs a human decision — ${driveNeedsHumanReasonWord(p.reason)} · asks: decide the PR's next step`,
    ],
    attention: true,
  },
  "drive-no-pr": {
    // #881 payload audit: `conductor.ts`'s emit site for this kind (the driving-lane-with-no-PR
    // invariant break) carries only `worker`/`issue` — no reason field exists upstream to read,
    // a genuine payload gap (not a copy-layer oversight); named explicitly rather than a silently
    // bare sentence. The ask does not depend on knowing why, so it is not blocked by the gap.
    sentence: (p) => [
      `Lane ${p.worker} ended without opening a PR — ${REASON_NOT_RECORDED} · asks: check the lane's log and decide next steps`,
    ],
    // #715 gate② [2]: the engine's own registry tags this `escalation-source:always`
    // (engine/src/state/event-kinds/drive.ts) — a driving lane with no PR is always a person's
    // decision, unconditionally, same tier as `drive-needs-human`.
    attention: true,
  },
  "drive-queued": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), " is ready — waiting its turn to merge"],
  },
  "drive-stopped": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), " is open and left for you — auto-merge is off"],
  },
  "pool-selected": {
    sentence: (p) => [`Selected ${Array.isArray(p.issues) ? p.issues.length : 0} issue(s) for this round`],
  },
  "drive-fixup": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), ` sent back to fix — ${fixReasonWord(p.reason)}`],
  },
  "fix-leg-started": {
    sentence: (p) => [`Lane ${p.worker} is fixing its PR — round ${p.fixRounds}${typeof p.cap === "number" ? ` of ${p.cap}` : ""}`],
  },
  "fix-leg-resumed": {
    sentence: (p) => [`Lane ${p.worker} resumed fixing after a handoff`],
  },
  "fix-rounds-capped": {
    // #881: payload carries `fixRounds`/`cap` (both numbers) — surfaced as the reason clause
    // when present, omitted (not fabricated) when absent.
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      ` used up its fix attempts${typeof p.fixRounds === "number" ? ` (${p.fixRounds}${typeof p.cap === "number" ? `/${p.cap}` : ""})` : ""} · asks: adjudicate — re-ready or close manually`,
    ],
    // #715 gate② [2]: `escalation-source:always` in the engine's own registry (drive.ts) —
    // "needs a human" in the sentence itself, and the reconciler treats it as unconditional.
    attention: true,
  },
  "fix-leg-verdict-rerun": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), "'s review findings aren't fixable by the producer · asks: adjudicate"],
    // #715 gate② [2]: same `escalation-source:always` tier as `fix-rounds-capped` above.
    attention: true,
  },
  "ceiling-escalated": {
    // #881: payload carries `reasons: string[]` (the tripped-ceiling codes) that the sentence
    // previously ignored entirely — surfaced now, defensively filtered the same way
    // `engine-review-containment-gap`'s `gaps` array already is below.
    sentence: (p) => {
      const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r): r is string => typeof r === "string") : [];
      const detail = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
      return [`Safety ceiling reached${detail} — winding down all work · asks: resume when it clears, or raise the ceiling`];
    },
    attention: true,
  },
  "ceiling-breach-entered": {
    sentence: (p) => {
      const reason = ceilingReasonWord(p.reason);
      if (reason === "wall-clock") {
        return [`This run hit its ${p.maxWallClockSec}s attention alarm — no new work until a restart`];
      }
      if (reason === "daily-budget") {
        return [`Today's $${p.dailyBudgetUsd} budget is spent — no new work until tomorrow`];
      }
      return ["A safety ceiling was reached — no new work until it clears"];
    },
  },
  "rapid-restart-detected": {
    // #893: engine actionability `intervene` (run.ts) — the crash-loop breaker's probe-less park
    // episode only clears via a later clean start or a human running `sapwood park clear`.
    sentence: (p) => [
      `Engine started ${p.births} times in ${p.windowSec}s — crash loop suspected, dispatch parked for a human · asks: clear the park once resolved`,
    ],
    attention: true,
  },
  "ceiling-breach-cleared": {
    sentence: (p) => {
      const reason = ceilingReasonWord(p.reason);
      if (reason === "wall-clock") return ["The wall-clock alarm cleared"];
      if (reason === "daily-budget") return ["The daily budget rolled over"];
      return ["A safety ceiling cleared"];
    },
  },
  "rollback-recovered": {
    sentence: (p) => ["Returned issue ", issueTok(p.issue), " to the backlog safely"],
  },
  "rollback-retry-failed": {
    sentence: (p) => ["Still trying to return issue ", issueTok(p.issue), " to the backlog"],
  },
  "rollback-escalated": {
    // #881: payload carries `reason` (the rollback trigger) and `error` (the last retry failure)
    // — `reason` is the more legible of the two for a feed sentence, surfaced when present.
    sentence: (p) => [
      "Couldn't return issue ",
      issueTok(p.issue),
      ` automatically${typeof p.reason === "string" && p.reason ? ` — ${p.reason}` : ""} · asks: return it to the backlog by hand`,
    ],
    attention: true,
  },
  "engine-review-verdict": {
    sentence: (p) => {
      const findingCount = typeof p.findingCount === "number" ? `${p.findingCount} finding(s)` : "counts unavailable";
      return p.outcome === "approved"
        ? ["Review approved PR ", prTok(p.pr, p.issue), ` — ${findingCount} noted`]
        : ["Review sent PR ", prTok(p.pr, p.issue), ` back — ${findingCount} to fix`];
    },
  },
  "engine-review-budget-advisory": {
    sentence: (p) => [`This review’s $${p.capUsd} budget is a guide, not a limit — the tool running it can’t enforce one`],
  },
  "engine-review-cost-unknown": {
    sentence: () => ["This review finished without reporting what it cost — its spend is unknown, not zero"],
  },
  "engine-review-containment-gap": {
    // #715 gate② [0]: the §7 row names `payload.gaps` explicitly ("one line per entry in
    // payload.gaps") and asks the sentence to link to the security guide — both were previously
    // ignored (one fixed generic string, no payload read, no link). `\n`-prefixed parts render as
    // separate lines via `.feed-sentence`'s `white-space: pre-line` (panels.css).
    sentence: (p) => {
      const gaps = Array.isArray(p.gaps) ? p.gaps.filter((g): g is string => typeof g === "string") : [];
      return [
        "Recorded limits, not an incident: this review ran in a sandbox that blocks writes but still lets the reviewed code run, and does not limit which files it can read",
        ...gaps.map((gap) => `\n- ${CONTAINMENT_GAP_LABELS[gap] ?? gap}`),
        "\n",
        linkTok("docs/security.md", "What this means"),
      ];
    },
  },
  "engine-review-orphaned-group": {
    sentence: () => ["A review that ran out of time was stopped, but something it started is still running on this machine"],
  },
  "engine-review-session-inspection": {
    sentence: (p) => [`This review session made ${p.toolItemCount} tool/command call(s) while looking things over`],
  },
  "reviewer-fallback-switch": {
    sentence: () => ["The usual reviewer isn't answering — switched to the backup"],
  },
  "reviewer-fallback-revert": {
    sentence: () => ["The usual reviewer is back — switched back"],
  },
  "pr-held": {
    sentence: (p) => ["A person put PR ", prTok(p.pr, p.issue), " on hold — nothing moves until they lift it"],
  },
  "pr-released": {
    sentence: (p) => ["Hold released — PR ", prTok(p.pr, p.issue), " resumes"],
  },
  "lane-state-labeled": {
    sentence: (p) => [`Lane ${p.worker} is now shown as working on PR `, prTok(p.pr, p.issue)],
  },
  "lane-state-cleared": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), ` no longer shows lane ${p.worker} as working on it`],
  },
  "resume-held": {
    sentence: (p) => [`Lane ${p.worker}'s handoff can't resume — issue `, issueTok(p.issue), ` still carries \`${p.label}\``],
  },
  "worktree-retained": {
    // #881 payload audit: `conductor.ts`'s `reportRetainedWorktree` emits only `worker`/`issue`/
    // `worktreePath` — no field states WHY the worktree was retained, a genuine payload gap named
    // here rather than silently absent. `worktreePath` (when present) doubles as the ask target.
    sentence: (p) => [
      `Kept lane ${p.worker}'s working folder for inspection${typeof p.worktreePath === "string" && p.worktreePath ? ` at \`${p.worktreePath}\`` : ""} — ${REASON_NOT_RECORDED} · asks: inspect and clear when done`,
    ],
    attention: true,
  },
  "worktree-released": {
    sentence: (p) => [`Lane ${p.worker}'s retained folder was cleaned up`],
  },
  "env-failure": {
    sentence: (p) => [`Lane ${p.worker} hit an environment problem — not the work itself`],
  },
  "env-failure-preserved": {
    // #881: payload carries `source` (the classified env-failure signature, `envSource` in
    // conductor.ts) — surfaced as the reason, previously ignored.
    sentence: (p) => [
      `Kept lane ${p.worker}'s work safe after an environment problem${typeof p.source === "string" && p.source ? ` (${p.source})` : ""} — its PR needs a human to continue it · asks: inspect the environment and continue the PR`,
    ],
    attention: true,
  },
  "park-escalated": {
    // #881: payload carries `source` (the park-cause id: consecutive-stalls/rapid-restart/
    // idle-churn/etc, per each of park.ts's/stall-breaker.ts's/rapid-restart.ts's/idle-churn.ts's
    // emit sites) — surfaced as the reason, previously ignored (the sentence took no payload at
    // all).
    sentence: (p) => [
      `The environment keeps failing${typeof p.source === "string" && p.source ? ` (${p.source})` : ""} — paused dispatch · asks: clear the park once resolved`,
    ],
    attention: true,
  },
  "park-probe": {
    sentence: (p) => {
      if (p.success) return [p.source === "forge" ? "Forge check passed" : "Model check passed"];
      return ["Environment check failed — still waiting"];
    },
  },
  "park-resumed": {
    sentence: () => ["Environment recovered — resuming work"],
  },
  "park-canary": {
    sentence: () => ["Sent one test lane to check the environment"],
  },
  "park-canary-failed": {
    sentence: () => ["The test lane failed — still waiting on the environment"],
  },
  "park-canary-inconclusive": {
    sentence: () => ["The test lane didn't settle it — still waiting on the environment"],
  },
  "tick-error": {
    sentence: () => ["The engine hit an error this cycle — it will retry"],
  },
  "standby-wait": {
    sentence: (p) => [`Nothing to work on — checking again in ${p.waitSec} s`],
  },
  "standby-exit": {
    sentence: (p) => [`Work appeared — resuming after ${p.attempts} quiet check(s)`],
  },
  "round-stop": {
    sentence: (p) => [`This round reached its limit (${p.detail}) — no new work this round`],
  },
  "align-summary": {
    sentence: (p) => [`Planning pass: ${p.created} issue(s) created, ${p.triaged} plan(s) drafted`],
  },
  "triage-degraded": {
    sentence: () => ["A planning session had trouble — some issues keep their old plans"],
  },
  "plan-review-escalated": {
    // #881: payload carries a real `reason` (prose, `plan-review.ts`'s own degrade/escalate call
    // sites — e.g. "reviewer determined this issue is not dispatchable by any redraft") that the
    // sentence previously ignored in favor of a fixed generic string. Falls back to the old
    // generic text only when `reason` is genuinely absent.
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      `'s plan needs a human — ${typeof p.reason === "string" && p.reason ? p.reason : "automated review couldn't approve it"} · asks: revise the plan or adjudicate`,
    ],
    attention: true,
  },
  "verify-na-proposed": {
    // #881 payload audit: `plan-review.ts`'s emit site carries only `round_id`/`issue` — the
    // proposal's rationale lives in the forge comment body, never in the event payload, a genuine
    // gap named explicitly rather than fabricated.
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      ` proposed as not separately verifiable — ${REASON_NOT_RECORDED} · asks: approve or reject the proposal`,
    ],
    attention: true,
  },
  "gated-reentry": {
    sentence: (p) => ["Issue ", issueTok(p.issue), "'s PR was unblocked by a human — back through review"],
  },
  "lane-revived": {
    sentence: (p) => ["Issue ", issueTok(p.issue), "'s PR picked back up after an environment failure — back under review"],
  },
  "gated-reentry-capped": {
    // #881: payload carries `attempts` — surfaced as the reason, previously ignored.
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      `${typeof p.attempts === "number" ? ` was unblocked ${p.attempts} times` : " was unblocked too many times"} without landing · asks: merge by hand — automatic reentry exhausted`,
    ],
    attention: true,
  },
  "gated-reentry-capped-label-failed": {
    // #881: payload carries `error` (the label-write failure) — surfaced as the reason. This kind
    // is `escalation-source:never` (self-retries next tick, per the engine's own registry) — the
    // ask names that explicitly rather than reading like an urgent unresolved intervention.
    sentence: (p) => [
      "Couldn't re-flag issue ",
      issueTok(p.issue),
      `${typeof p.error === "string" && p.error ? ` — ${p.error}` : ""} · asks: check it manually (retries automatically — not urgent)`,
    ],
    attention: true,
  },
  "escalation-resolved": {
    sentence: (p) => {
      const via = typeof p.via === "string" ? RESOLUTION_SENTENCE[p.via] : undefined;
      return via ? via(p) : ["Issue ", issueTok(p.issue), " no longer needs you"];
    },
  },
  "needs-human-swept": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      ` no longer carries \`${p.label}\` — the engine removed the flag it had applied itself, now that its escalation is resolved`,
    ],
  },
  "retro-pr-opened": {
    sentence: (p) => ["The loop proposed an improvement to itself — PR ", prTok(p.pr), " awaits review"],
  },
  "retro-pr-degraded": {
    sentence: () => ["A self-improvement proposal didn't come together this round"],
  },
  "run-started": {
    sentence: () => ["Engine started a new run"],
  },
  "instance-lock-taken-over": {
    sentence: (p) => [`Took over the engine lock left by a crashed run (pid ${p.previousPid})`],
  },
  "round-phase": {
    sentence: (p) => [`Round ${p.round_id} moved into ${p.phase}`],
  },
  "idle-churn-detected": {
    // #893: engine actionability `intervene` (run.ts) — same probe-less-park-episode family as
    // `rapid-restart-detected`/`consecutive-stalls-detected`/`empty-spin-park`, clears only via a
    // human running `sapwood park clear`.
    sentence: (p) => [
      `The loop ran ${p.rounds} rounds in a row that changed nothing at all — parked for a human · asks: clear the park once resolved`,
    ],
    attention: true,
  },
  // gate② opus round 1 P3 (#797): not yet emitted anywhere — the live-posting wiring is #783's
  // human-owned remainder, merge-driver.ts/conductor.ts being guard-protected — but the kind is
  // registered now, so it must be representable here today.
  "ci-inert-escalated": {
    // #881: `checks` is `string[]` on the real payload (`"name (CONCLUSION)"`, conductor.ts's own
    // comment on this field) — named when the items are actually strings, falling back to the
    // bare count for any other shape (never fabricated).
    sentence: (p) => {
      const raw = Array.isArray(p.checks) ? p.checks : [];
      const names = raw.filter((c): c is string => typeof c === "string");
      const n = raw.length;
      const detail = names.length > 0 ? ` (${names.join(", ")})` : n > 0 ? ` (${n} check${n === 1 ? "" : "s"})` : "";
      return [
        "PR ",
        prTok(p.pr, p.issue),
        ` needs a human — CI concluded without ever going green${detail} · asks: fix the check, then clear the label to retry`,
      ];
    },
    attention: true,
  },
  // #729 fidelity ledger — payload shape mirrors every other drive-arm CI kind (`pr`/`issue`).
  "ci-pending-observed": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), " is waiting on CI"],
  },
  "ci-pending-escalated": {
    // #881: payload carries `checks`/`blockedChecks` (both `string[]`) that the sentence
    // previously ignored — `blockedChecks` (a check that concluded WITHOUT passing) is the more
    // actionable of the two when present, since it names what's actually wedging gate①.
    sentence: (p) => {
      const blocked = Array.isArray(p.blockedChecks) ? p.blockedChecks.filter((c): c is string => typeof c === "string") : [];
      const checks = Array.isArray(p.checks) ? p.checks.filter((c): c is string => typeof c === "string") : [];
      const detail = blocked.length > 0 ? ` — blocked: ${blocked.join(", ")}` : checks.length > 0 ? ` (${checks.join(", ")})` : "";
      return [
        "PR ",
        prTok(p.pr, p.issue),
        ` needs a human — CI stayed pending too long to progress on its own${detail} · asks: re-run or fix the stuck check, then clear the label`,
      ];
    },
    attention: true,
  },
  "ci-pending-cleared": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), "'s CI resolved"],
  },

  // ── #893: attention-class kinds the engine registers `actionability: "intervene"` (or an
  // unconditional `escalation-source:*`) that had no copy entry at all before this PR — the
  // "126/194 kinds unmapped" gap's attention-bearing half. Each carries an explicit reason clause
  // (from the emit site's real payload where confirmed by reading the engine source; the #881
  // REASON_NOT_RECORDED convention otherwise — never a fabricated field) and an explicit `asks:`.

  "emergency-stop": {
    // #893: previously deliberately absent (see git history) as "a control-signal sentinel, never
    // a feed event kind" — but run.ts registers it with `actionability: "intervene"` and it IS a
    // durable, appendable event (#293), so an unmapped occurrence would have hit the raw fallback.
    sentence: () => [
      "EMERGENCY STOP triggered — every running lane was killed immediately, no drain window · asks: inspect in-flight work for lost progress before resuming",
    ],
    attention: true,
  },
  "consecutive-stalls-detected": {
    // Payload confirmed at stall-breaker.ts's emit site: {streak, maxConsecutiveStalls, enteredAt}.
    sentence: (p) => [
      `The engine stalled ${p.streak}${typeof p.maxConsecutiveStalls === "number" ? `/${p.maxConsecutiveStalls}` : ""} times in a row — dispatch parked for a human · asks: clear the park once resolved`,
    ],
    attention: true,
  },
  "empty-spin-park": {
    sentence: () => ["The peripheral roles kept failing to produce work — paused dispatch · asks: clear the park once resolved"],
    attention: true,
  },
  "base-ci-red-escalated": {
    // Payload confirmed at base-ci.ts's emit site: {sha, failing: string[], branch, at}.
    sentence: (p) => {
      const failing = Array.isArray(p.failing) ? p.failing.filter((f): f is string => typeof f === "string") : [];
      const detail = failing.length > 0 ? ` (${failing.join(", ")})` : "";
      return [`The default branch's CI is red${detail} — no PR can merge until it's fixed · asks: fix the default branch's CI`];
    },
    attention: true,
  },
  "estop-lane-swept": {
    // Payload confirmed at state.ts's emit site: {worker, issue, confirmedDead, ...}.
    sentence: (p) => [
      `Lane ${p.worker}'s driving work was killed by EMERGENCY STOP${p.confirmedDead === false ? " — the process couldn't be confirmed dead" : ""} · asks: check for an orphan process and confirm the PR's state`,
    ],
    attention: true,
  },
  "estop-lane-sweep-incapable": {
    // Payload confirmed at round.ts's emit site: {worker, issue}.
    sentence: (p) => [
      `Lane ${p.worker}'s EMERGENCY STOP sweep couldn't verify or signal its process — left unsettled · asks: check the lane by hand`,
    ],
    attention: true,
  },
  "resume-capped": {
    // Payload confirmed at conductor.ts's emit site: {worker, issue, attempts, pr?}.
    sentence: (p) => [
      `Lane ${p.worker} exhausted its resume attempts${typeof p.attempts === "number" ? ` (${p.attempts})` : ""} after a handoff · asks: resume or reassign the lane by hand`,
    ],
    attention: true,
  },
  "resume-undecidable": {
    sentence: (p) => [
      `Lane ${p.worker}'s resume outcome couldn't be determined from the ledger · asks: check the lane by hand and decide whether to resume`,
    ],
    attention: true,
  },
  "orphan-pr-escalated": {
    // Payload confirmed at reconcile.ts's emit site (escalateToNeedsHuman): {pr, worker, via, issue}.
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      ` is open but lane ${p.worker} is dead${typeof p.via === "string" && p.via ? ` (${p.via})` : ""} · asks: check the PR and decide whether to retry the issue`,
    ],
    attention: true,
  },
  "gated-flag-unprovable": {
    sentence: (p) => [
      "Lane ",
      `${p.worker}`,
      "'s reentry flag couldn't be found on either carrier · asks: check issue ",
      issueTok(p.issue),
      "'s labels by hand",
    ],
    attention: true,
  },
  "drive-human-merge-only": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      " is ready but requires a human to merge it — a one-way, never re-decided policy · asks: review and merge by hand",
    ],
    attention: true,
  },
  "fix-leg-dispatch-unconfigured": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      " needs a fix leg but the fix loop isn't configured for this run · asks: enable the fix loop or fix the PR by hand",
    ],
    attention: true,
  },
  "fix-leg-undecidable": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      "'s fix leg outcome couldn't be determined from the ledger · asks: check the lane and decide the PR's next step",
    ],
    attention: true,
  },
  "fix-thread-write-escalated": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      " has a review-thread reply/resolve that couldn't be posted after retrying · asks: check the review thread by hand",
    ],
    attention: true,
  },
  "ac-snapshot-drift": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      "'s issue body changed after its acceptance criteria were captured · asks: confirm the PR still matches the issue, or re-snapshot",
    ],
    attention: true,
  },
  "review-silence-escalated": {
    // Payload confirmed at conductor.ts's emit site: {worker, issue, pr, head, silenceSec}.
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      `'s review request went unanswered${typeof p.silenceSec === "number" ? ` for ${Math.round(p.silenceSec / 60)}m` : ""} · asks: check the reviewer and prompt or reassign the review`,
    ],
    attention: true,
  },
  "review-disputed": {
    // Payload confirmed at conductor.ts's emit site: {worker, issue, pr, carrier, headOid, fixRounds, threads|findings, source}.
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      " — successive reviews disagreed past the dispute limit · asks: adjudicate which review is right",
    ],
    attention: true,
  },
  "review-non-convergent": {
    sentence: (p) => [
      "PR ",
      prTok(p.pr, p.issue),
      " — fix-and-review rounds failed to converge · asks: adjudicate — re-ready or close manually",
    ],
    attention: true,
  },
  "comment-cursor-stale": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      "'s comment thread moved since the engine last read it, so it refused to spend/dispatch/drive · asks: review the comment thread — this clears once the engine re-reads it",
    ],
    attention: true,
  },
  "round-pool-removal-capped": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      "'s round-pool label couldn't be removed after retrying · asks: remove the label by hand",
    ],
    attention: true,
  },
  "concern-post-escalated": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      "'s PO concern couldn't be posted after retrying · asks: check the issue and post the concern by hand",
    ],
    attention: true,
  },
  "operator-fence-violated": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      "'s body edit was refused — it touched an operator-owned section · asks: review the proposed edit and the operator fence by hand",
    ],
    attention: true,
  },
  "architect-repeat-drop-escalated": {
    sentence: (p) => [
      "Issue ",
      issueTok(p.issue),
      " was dropped repeatedly for the same reason with no edit in between · asks: revise the issue or adjudicate the repeated drop",
    ],
    attention: true,
  },
};

/** The narrative kind list, derived from `COPY` itself rather than re-spelled — the same
 *  one-source-of-truth shape `event-kinds/index.ts` uses on the engine side. Scoped to narrative
 *  (§7-table) kinds only — `TELEMETRY_KINDS` below is the other half of the full union. */
export const EVENT_KINDS: EventKind[] = Object.keys(COPY) as EventKind[];

/** #893: heartbeat/bookkeeping engine kinds — real, registered, regularly-emitted traffic that
 *  has no narrative worth telling on its own. Each still renders an honest, generic line via
 *  `telemetryEntry` (never the raw "Unrecognized event" fallback) and is collapsed/excluded from
 *  the live feed's default view (opt-in to show — ActivityFeed.tsx's `showTelemetry` toggle).
 *  Completeness (every engine kind is EITHER here or in `COPY`, never both, never neither) is
 *  pinned by copy.test.ts's cross-package exhaustiveness test — a registered engine kind added
 *  to neither list fails that test (red-first, mutation-killable: remove any one member here and
 *  that same test reddens for the now-unclassified kind). */
const TELEMETRY_KIND_NAMES: readonly EventKind[] = [
  // run.ts
  "run-ended",
  "deploy-key-tier-detected",
  "claude-cli-version-checked",
  "engine-stalled",
  "engine-restart-after-stall",
  "park-wait-heartbeat",
  "standby-heartbeat",
  "reconcile-completed",
  "role-debris-swept",
  "worktree-janitor-rollup",
  "base-ci-red-observed",
  "base-ci-red-cleared",
  "directive-applied",
  "forge-page-ceiling",
  "web-access-denied-by-operator-settings",
  "user-settings-drift-detected",
  "fix-loop-unattached",
  "labels-reconciled",
  "board-normalized",
  "board-gap-detected",
  "proxy-mint-failed",
  "egress-suspect",
  // lane.ts
  "reclaim-dead-comment-failed",
  "estop-lane-sweep-started",
  "resumed",
  "resume-failed",
  "resume-capped-label-failed",
  "resume-undecidable-label-failed",
  "lane-adopted",
  "lane-pr-unknown",
  "lane-revival-terminal",
  "human-merge-only-closed",
  "merged-lane-worktree-settled",
  "merged-lane-worktree-retained",
  "merged-lane-worktree-settle-failed",
  "orphan-detected",
  "orphan-healed",
  "orphan-heal-failed",
  "orphan-sweep-checked",
  "gated-flag-healed",
  "gated-lane-retired",
  "worker-heartbeat",
  "role-session-heartbeat",
  "role-env-failure",
  "role-session-exit-lost",
  "role-session-spawn-timeout",
  "role-worktree-retained",
  "lane-spawned",
  // drive.ts
  "drive-thread-writes-pending",
  "gated-reentry-merged",
  "gated-reentry-issue-closed",
  "gated-reentry-candidate-staged",
  "fix-leg-adopted",
  "fix-leg-adopted-drained",
  "fix-leg-dispatch-blocked",
  "fix-leg-dispatch-failed",
  "fix-leg-resume-failed",
  "fix-leg-resume-no-pr",
  "fix-leg-resume-unconfigured",
  "fix-leg-undecidable-label-failed",
  "fix-rounds-cap-label-failed",
  "fix-rounds-cap-comment-failed",
  "fix-response-invalid",
  "fix-response-queued",
  "fix-thread-reply-posted",
  "fix-thread-resolved",
  "fix-thread-write-escalation-label-failed",
  "fix-thread-write-retry-failed",
  "blocked-by-cleared",
  "drain-driving-escalation-label-failed",
  "drain-driving-escalation-comment-failed",
  // review.ts
  "review-disputed-label-failed",
  "review-disputed-comment-failed",
  "review-non-convergent-label-failed",
  "review-non-convergent-comment-failed",
  // governance.ts
  "align-skipped",
  "backlog-read-failed",
  "goal-file-unreadable",
  "pool-labels-failed",
  "pool-reconcile-incomplete",
  "pool-selection-decision-lost",
  "pool-degraded",
  "triage-body-committed",
  "triage-comment-posted",
  "triage-decision-accepted",
  "triage-decision-lost",
  "triage-effects-committed",
  "triage-stale-hash-skipped",
  "proposal-created",
  "proposal-comment-posted",
  "proposal-set-persisted",
  "proposal-skipped",
  "proposal-journal-corrupt",
  "concern-posted",
  "concern-adjudicated",
  "concern-post-failed",
  "plan-approved",
  "architect-review-degraded",
  "architect-degraded",
  "architect-verdict-applied",
  "architect-verdict-lost",
  "po-degraded",
  "harvest-degraded",
  "retro-degraded",
];

export const TELEMETRY_KINDS: ReadonlySet<EventKind> = new Set(TELEMETRY_KIND_NAMES);

/** The generic, honest entry every `TELEMETRY_KINDS` member renders — the kind name itself, never
 *  a fabricated narrative. `copyFor` constructs one on demand rather than pre-populating `COPY`
 *  with 100+ near-identical entries, keeping §7's table (and its row-count test) scoped to the
 *  hand-authored narrative kinds only. */
function telemetryEntry(kind: EventKind): CopyEntry {
  return { sentence: () => [`Telemetry: ${kind}`], tier: "telemetry" };
}

/** #715 gate② round 5 [0], extended #893: the ONE source of truth for "is this wire kind one the
 *  client actually knows how to render" — a real type guard (`kind is EventKind`), not just a
 *  runtime boolean, so a caller can narrow a `string`-typed wire value to the closed `EventKind`
 *  union at the spot it needs to. `domain-event.ts`'s `toDomainEvent` is the ONE place in the app
 *  that calls this — every other kind check downstream trusts the classification it already made,
 *  rather than re-deriving it. A telemetry-tier kind is "known" too (#893: it must never render
 *  the raw "Unrecognized event" fallback) — `copyFor`/`hasAttention`/`attentionCategory` all read
 *  through this same gate. */
export function isKnownKind(kind: string): kind is EventKind {
  return Object.hasOwn(COPY, kind) || TELEMETRY_KINDS.has(kind as EventKind);
}

export function copyFor(kind: string): CopyEntry | undefined {
  if (Object.hasOwn(COPY, kind)) return COPY[kind as EventKind];
  if (TELEMETRY_KINDS.has(kind as EventKind)) return telemetryEntry(kind as EventKind);
  return undefined;
}

export function hasAttention(kind: string, payload: Payload | null): boolean {
  const entry = copyFor(kind);
  if (!entry?.attention) return false;
  if (entry.attention === true) return true;
  return entry.attention(payload ?? {});
}

/** #881: the category-chip taxonomy `NeedsAttention.tsx` renders per row, mirroring
 *  `needs-attention-dark.png`'s FIX CAP/REVIEW SILENCE/CEILING/DISSENT chip pattern. Every kind
 *  that ever carries `attention` (§3) has exactly one category below; completeness is pinned by
 *  `copy.test.ts`'s taxonomy-completeness test rather than left to drift silently. Grouped by
 *  what kind of intervention the row is actually asking for, not by which engine module emitted
 *  it:
 *  - DECISION — an ambiguous outcome only a human can resolve (no automatic next step exists)
 *  - LANE END — a lane stopped without a clean, driving hand-off
 *  - FIX CAP — the automatic fix loop exhausted its budget or its own review-decidability
 *  - CEILING — a safety/cost ceiling tripped
 *  - ROLLBACK — an automatic backlog return failed
 *  - INSPECT — a worktree was kept on disk for a person to look at
 *  - ENV — the execution environment itself is unhealthy
 *  - REVIEW — a plan/verification/acceptance-criteria review couldn't reach an automatic verdict
 *  - LABEL — a bookkeeping write failed (self-retries; lowest urgency of the group)
 *  - CI — a PR's checks (or the default branch's) never resolved cleanly
 *  - E-STOP — an EMERGENCY STOP left a lane/process in a state only a person can settle
 *  - BREAKER — a run-level breaker tripped into a probe-less park episode (#893: same family as
 *    ENV, but no PR/issue/lane is implicated — the whole run paused)
 *  - RESUME — a handed-off lane's resume attempt was exhausted or undecidable (#893)
 *  - FLAG — a gated-reentry escalation flag itself is missing or unprovable (#893)
 *  - THREAD — a review-thread reply/resolve write exhausted its retries (#893)
 *  - STALE — a cached snapshot/cursor (acceptance criteria, comment cursor) no longer matches
 *    live state, and the engine refused to act on stale information (#893)
 *  - CONCERN — the PO's structured-dissent concern couldn't be posted (#893)
 *  - FENCE — an operator-owned issue-body region was (or would have been) violated (#893)
 *  - DROP — the same issue was dropped repeatedly for the same unaddressed reason (#893)
 *  - REVIEW SILENCE — a gate② review request went unanswered past the silence bound (#893, per
 *    the mockup's own chip name)
 *  - DISSENT — successive reviews disagreed, or fix/review rounds failed to converge (#893, per
 *    the mockup's own chip name) */
export const ATTENTION_CATEGORY: Partial<Record<EventKind, string>> = {
  "drive-needs-human": "DECISION",
  "drive-no-pr": "DECISION",
  "reclaim-done": "LANE END",
  "reclaim-failed": "LANE END",
  "fix-rounds-capped": "FIX CAP",
  "fix-leg-verdict-rerun": "FIX CAP",
  "gated-reentry-capped": "FIX CAP",
  "ceiling-escalated": "CEILING",
  "rollback-escalated": "ROLLBACK",
  "worktree-retained": "INSPECT",
  "env-failure-preserved": "ENV",
  "park-escalated": "ENV",
  "plan-review-escalated": "REVIEW",
  "verify-na-proposed": "REVIEW",
  "gated-reentry-capped-label-failed": "LABEL",
  "ci-inert-escalated": "CI",
  "ci-pending-escalated": "CI",
  // #893 additions.
  "emergency-stop": "E-STOP",
  "estop-lane-swept": "E-STOP",
  "estop-lane-sweep-incapable": "E-STOP",
  "rapid-restart-detected": "BREAKER",
  "consecutive-stalls-detected": "BREAKER",
  "idle-churn-detected": "BREAKER",
  "empty-spin-park": "BREAKER",
  "base-ci-red-escalated": "CI",
  "resume-capped": "RESUME",
  "resume-undecidable": "RESUME",
  "orphan-pr-escalated": "DECISION",
  "gated-flag-unprovable": "FLAG",
  "drive-human-merge-only": "DECISION",
  "fix-leg-dispatch-unconfigured": "FIX CAP",
  "fix-leg-undecidable": "FIX CAP",
  "fix-thread-write-escalated": "THREAD",
  "ac-snapshot-drift": "STALE",
  "comment-cursor-stale": "STALE",
  "review-silence-escalated": "REVIEW SILENCE",
  "review-disputed": "DISSENT",
  "review-non-convergent": "DISSENT",
  "round-pool-removal-capped": "LABEL",
  "concern-post-escalated": "CONCERN",
  "operator-fence-violated": "FENCE",
  "architect-repeat-drop-escalated": "DROP",
};

export function attentionCategory(kind: string): string | undefined {
  return isKnownKind(kind) ? ATTENTION_CATEGORY[kind as EventKind] : undefined;
}

/** #891 gate① engine-agent finding [2] (ac3-dissent-counts-wrong-events): the strip's summary
 *  line ("N waiting · oldest Xd · M dissent") counts the SAME kinds this file's own
 *  `ATTENTION_CATEGORY` already classifies "DISSENT" (`review-disputed`, `review-non-convergent`
 *  — #893's real reviewer-disagreement/non-convergence kinds), never a second, independently
 *  guessed proxy. A prior version of this function counted `fix-leg-verdict-rerun` instead — a
 *  kind this SAME `ATTENTION_CATEGORY` map classifies "FIX CAP", not "DISSENT" — so a strip row
 *  actually carrying a real DISSENT chip reported 0 dissent while an unrelated FIX CAP row
 *  inflated the count. Deriving from `attentionCategory` is what keeps the two views permanently
 *  in sync — a future DISSENT-classified kind is picked up automatically, never needing a
 *  second, hand-maintained list here. */
export function isDissentSignal(kind: string): boolean {
  return attentionCategory(kind) === "DISSENT";
}

/** "The same module captions lane states" (§7) — a lane's `state` word, in plain language.
 *  Only `running`/`driving`/`fixing` are ever actually served (state.ts's `activeWorkers()`
 *  reads `WHERE state IN ('running','driving','fixing')`); `handoff` is captioned anyway since
 *  §7 names it explicitly. An unrecognized state (future engine addition) falls back to itself,
 *  never to a blank — an honest unknown beats a silent one. */
export const LANE_STATE_CAPTION: Record<string, string> = {
  running: "writing",
  driving: "PR under review",
  fixing: "fixing",
  handoff: "handed off",
};

export function laneStateCaption(state: string): string {
  return LANE_STATE_CAPTION[state] ?? state;
}

/** #922 owner ruling (2026-08-17): the CI gate's small-print caption — a constant, not a config
 *  read, since the CI provider isn't configurable in v0.2 (unlike REVIEW's model·effort caption,
 *  which genuinely varies per deployment). */
export const CI_CAPTION = "github";

/** §3 Operations / §7: the misfire-protection confirm copy for each control verb, verbatim from
 *  the design doc's own table + confirm-wording examples — sourced from here, never an inline
 *  string in the Controls component, so a reviewer checking §7 compliance has one place to look. */
export const CONTROL_COPY: Record<"start" | "pause" | "resume" | "stop" | "estop", { label: string; confirm: string }> = {
  start: { label: "Start", confirm: "Start — clears any pause or stop signal so the next tick runs." },
  pause: { label: "Pause", confirm: "Pause — lanes finish their current work, nothing new dispatches." },
  resume: { label: "Resume", confirm: "Resume — removes the pause; the next tick continues the run." },
  stop: {
    label: "Stop",
    confirm: "Stop — lanes get the drain window to finish or hand off; any lane still running after that is stopped hard.",
  },
  // §3 Operations, 2026-07-21 label rule: spelled out, never "E-STOP" — misreads as "E-SHOP" at
  // small type, and the full form matches the engine signal name (EMERGENCY_STOP) exactly. The
  // confirm sentence is the locked verbatim consequence wording from the same amendment.
  estop: { label: "EMERGENCY STOP", confirm: "EMERGENCY STOP — in-flight work is killed, WIP may be lost." },
};

/** #723: the same §7 caption convention applied to the header's ENGINE state word (frontend-
 *  design.md §3 A: "engine state as one word + dot"). The word itself stays the raw §8
 *  `EngineState` value (unchanged rendering); this is the plain-language phrase next to it — the
 *  AC12 fix's whole point is that `standby` must read as calm, not as an error, and a bare word
 *  with no caption leaves that to the reader's guess. An unrecognized state (a future engine
 *  addition) falls back to itself, the same honest-unknown `laneStateCaption` uses above. */
export const ENGINE_STATE_CAPTION: Record<string, string> = {
  running: "actively working",
  standby: "idle — nothing to work on right now",
  stalled: "not responding",
  paused: "paused by operator",
  "winding-down": "finishing in-flight work, no new dispatch",
  stopping: "shutting down",
  // #729 fidelity ledger: was the literal string "stopped", so the header rendered the doubled
  // "stopped — stopped" (engine-word span + this caption span back to back).
  stopped: "not running",
};

/** `standbyNextCheckSec` (the #723 API payload field) only ever applies to `standby` itself —
 *  every other state ignores it, so a stray non-null value elsewhere (should never happen,
 *  server-side) can't leak into an unrelated caption. */
export function engineStateCaption(state: string, standbyNextCheckSec: number | null): string {
  const base = ENGINE_STATE_CAPTION[state] ?? state;
  return state === "standby" && standbyNextCheckSec !== null ? `${base} — checking again in ${standbyNextCheckSec}s` : base;
}
