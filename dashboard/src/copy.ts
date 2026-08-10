/**
 * The plain-language copy layer (frontend-design.md §7). One module, keyed by event kind:
 * every `events` row the server serves turns into a feed sentence through here, never through
 * ad-hoc string-building in a component. `COPY` is a `Record<EventKind, CopyEntry>` — TypeScript
 * itself refuses to compile this file if a kind is added to `EventKind` without a matching entry,
 * which is the "adding an event kind without a copy entry is a type error" contract (§7).
 *
 * `emergency-stop` is deliberately absent: frontend-design.md defines it only as an engine
 * control-signal sentinel (§3 Operations, #293), never as a feed event kind — there is no §7
 * table row for it to occupy.
 */

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

/** `ceiling-breach-entered`/`ceiling-breach-cleared` branch on `payload.reason` (#431 round 3:
 *  one event per reason, each ceiling its own lifecycle) — see conductor.ts's `CeilingReason`. */
function ceilingReasonWord(reason: unknown): "wall-clock" | "daily-budget" | null {
  return reason === "wall-clock" || reason === "daily-budget" ? reason : null;
}

export type EventKind =
  | "dispatched"
  | "dispatch-failed"
  | "reclaim-done"
  | "reclaim-failed"
  | "reclaim-dead"
  | "handoff"
  | "merged"
  | "drive-needs-human"
  | "drive-no-pr"
  | "drive-queued"
  | "drive-stopped"
  | "pool-selected"
  | "drive-fixup"
  | "fix-leg-started"
  | "fix-leg-resumed"
  | "fix-rounds-capped"
  | "fix-leg-verdict-rerun"
  | "ceiling-escalated"
  | "ceiling-breach-entered"
  | "rapid-restart-detected"
  | "ceiling-breach-cleared"
  | "rollback-recovered"
  | "rollback-retry-failed"
  | "rollback-escalated"
  | "engine-review-verdict"
  | "engine-review-budget-advisory"
  | "engine-review-cost-unknown"
  | "engine-review-containment-gap"
  | "engine-review-orphaned-group"
  | "engine-review-session-inspection"
  | "reviewer-fallback-switch"
  | "reviewer-fallback-revert"
  | "pr-held"
  | "pr-released"
  | "lane-state-labeled"
  | "lane-state-cleared"
  | "resume-held"
  | "worktree-retained"
  | "worktree-released"
  | "env-failure"
  | "env-failure-preserved"
  | "park-escalated"
  | "park-probe"
  | "park-resumed"
  | "park-canary"
  | "park-canary-failed"
  | "park-canary-inconclusive"
  | "tick-error"
  | "standby-wait"
  | "standby-exit"
  | "round-stop"
  | "align-summary"
  | "triage-degraded"
  | "no-plan-after-draft"
  | "plan-review-escalated"
  | "verify-na-proposed"
  | "gated-reentry"
  | "lane-revived"
  | "gated-reentry-capped"
  | "gated-reentry-capped-label-failed"
  | "escalation-resolved"
  | "needs-human-swept"
  | "retro-pr-opened"
  | "retro-pr-degraded"
  | "run-started"
  | "instance-lock-taken-over"
  | "round-phase"
  | "idle-churn-detected";

const RESOLUTION_SENTENCE: Record<string, (p: Payload) => SentencePart[]> = {
  merged: (p) => ["Issue ", issueTok(p.issue), " no longer needs you — PR ", prTok(p.pr, p.issue), " was merged"],
  "issue-closed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — it was closed"],
  "pr-closed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — PR ", prTok(p.pr, p.issue), " was closed without merging"],
  "label-removed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — the flag was cleared"],
  "board-fixed": (p) => ["Issue ", issueTok(p.issue), " no longer needs you — the board was set to Done"],
};

export const COPY: Record<EventKind, CopyEntry> = {
  dispatched: {
    sentence: (p) => ["Started work on issue ", issueTok(p.issue)],
  },
  "dispatch-failed": {
    sentence: (p) => ["Couldn't start issue ", issueTok(p.issue), " — it's back in the backlog"],
  },
  "reclaim-done": {
    sentence: (p) =>
      p.next === "DRIVING"
        ? [`Lane ${p.worker} opened a PR — now in review`]
        : [`Lane ${p.worker} ended without a PR — flagged for a human`],
    attention: reclaimNeedsAttention,
  },
  "reclaim-failed": {
    sentence: (p) => [`Lane ${p.worker} hit a problem and stopped`],
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
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), " needs a human decision"],
    attention: true,
  },
  "drive-no-pr": {
    sentence: (p) => [`Lane ${p.worker} ended without opening a PR`],
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
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), " used up its fix attempts — needs a human"],
    // #715 gate② [2]: `escalation-source:always` in the engine's own registry (drive.ts) —
    // "needs a human" in the sentence itself, and the reconciler treats it as unconditional.
    attention: true,
  },
  "fix-leg-verdict-rerun": {
    sentence: (p) => ["PR ", prTok(p.pr, p.issue), "'s review findings aren't fixable by the producer — needs a human"],
    // #715 gate② [2]: same `escalation-source:always` tier as `fix-rounds-capped` above.
    attention: true,
  },
  "ceiling-escalated": {
    sentence: () => ["Safety ceiling reached — winding down all work"],
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
    sentence: (p) => [`Engine started ${p.births} times in ${p.windowSec}s — crash loop suspected, dispatch parked for a human`],
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
    sentence: (p) => ["Couldn't return issue ", issueTok(p.issue), " automatically — flagged for a human"],
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
    sentence: (p) => [`Kept lane ${p.worker}'s working folder for inspection`],
    attention: true,
  },
  "worktree-released": {
    sentence: (p) => [`Lane ${p.worker}'s retained folder was cleaned up`],
  },
  "env-failure": {
    sentence: (p) => [`Lane ${p.worker} hit an environment problem — not the work itself`],
  },
  "env-failure-preserved": {
    sentence: (p) => [`Kept lane ${p.worker}'s work safe after an environment problem — its PR needs a human to continue it`],
    attention: true,
  },
  "park-escalated": {
    sentence: () => ["The environment keeps failing — paused dispatch and flagged a human"],
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
  "no-plan-after-draft": {
    sentence: (p) => ["Issue ", issueTok(p.issue), " still has no usable plan after a drafting attempt"],
  },
  "plan-review-escalated": {
    sentence: (p) => ["Issue ", issueTok(p.issue), "'s plan needs a human — automated review couldn't approve it"],
    attention: true,
  },
  "verify-na-proposed": {
    sentence: (p) => ["Issue ", issueTok(p.issue), " proposed as not separately verifiable — a person decides"],
    attention: true,
  },
  "gated-reentry": {
    sentence: (p) => ["Issue ", issueTok(p.issue), "'s PR was unblocked by a human — back through review"],
  },
  "lane-revived": {
    sentence: (p) => ["Issue ", issueTok(p.issue), "'s PR picked back up after an environment failure — back under review"],
  },
  "gated-reentry-capped": {
    sentence: (p) => ["Issue ", issueTok(p.issue), " was unblocked too many times without landing — flagged for a human"],
    attention: true,
  },
  "gated-reentry-capped-label-failed": {
    sentence: (p) => ["Couldn't re-flag issue ", issueTok(p.issue), " — please check it manually"],
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
    sentence: (p) => [`The loop ran ${p.rounds} rounds in a row that changed nothing at all — parked for a human`],
  },
};

/** The exhaustive kind list, derived from `COPY` itself rather than re-spelled — the same
 *  one-source-of-truth shape `event-kinds/index.ts` uses on the engine side. */
export const EVENT_KINDS: EventKind[] = Object.keys(COPY) as EventKind[];

/** #715 gate② round 5 [0]: the ONE source of truth for "is this wire kind one the client actually
 *  knows how to render" — a real type guard (`kind is EventKind`), not just a runtime boolean,
 *  so a caller can narrow a `string`-typed wire value to the closed `EventKind` union at the spot
 *  it needs to. `domain-event.ts`'s `toDomainEvent` is the ONE place in the app that calls this —
 *  every other kind check downstream trusts the classification it already made, rather than
 *  re-deriving it. */
export function isKnownKind(kind: string): kind is EventKind {
  return Object.hasOwn(COPY, kind);
}

export function copyFor(kind: string): CopyEntry | undefined {
  return isKnownKind(kind) ? COPY[kind] : undefined;
}

export function hasAttention(kind: string, payload: Payload | null): boolean {
  const entry = copyFor(kind);
  if (!entry?.attention) return false;
  if (entry.attention === true) return true;
  return entry.attention(payload ?? {});
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
  stopped: "stopped",
};

/** `standbyNextCheckSec` (the #723 API payload field) only ever applies to `standby` itself —
 *  every other state ignores it, so a stray non-null value elsewhere (should never happen,
 *  server-side) can't leak into an unrelated caption. */
export function engineStateCaption(state: string, standbyNextCheckSec: number | null): string {
  const base = ENGINE_STATE_CAPTION[state] ?? state;
  return state === "standby" && standbyNextCheckSec !== null ? `${base} — checking again in ${standbyNextCheckSec}s` : base;
}
