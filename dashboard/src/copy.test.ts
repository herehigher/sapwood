import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// Test-only import (same pattern as config-captions.test.ts's CONFIG_ALLOWLIST cross-check): the
// engine's own tagged registry is the AUTHORITATIVE attention-membership signal, not frontend-
// design.md §3's prose list, which has already drifted once (finding [2] below).
import { ESCALATION_SOURCE_KINDS } from "../../engine/src/loop/escalation-reconcile.ts";
import { COPY, copyFor, EVENT_KINDS, type EventKind, engineStateCaption, hasAttention, type SentencePart } from "./copy.ts";

const render = (kind: EventKind, payload: Record<string, unknown> = {}) =>
  COPY[kind]
    .sentence(payload)
    .map((part) => (typeof part === "string" ? part : part.kind === "link" ? part.label : `#${part.number}`))
    .join("");

// frontend-design.md §7's TABLE, copied verbatim as the count/order oracle — "the map is the
// count" (issue #145): this list is what the count is COUNTED FROM, so it must be an independent
// transcription, not derived from `copy.ts` itself, or a silent drift in `copy.ts` could never be
// caught by this test.
const DOC_TABLE_KINDS = [
  "dispatched",
  "dispatch-failed",
  "reclaim-done",
  "reclaim-failed",
  "reclaim-dead",
  "handoff",
  "merged",
  "drive-needs-human",
  "drive-no-pr",
  "drive-queued",
  "drive-stopped",
  "pool-selected",
  "drive-fixup",
  "fix-leg-started",
  "fix-leg-resumed",
  "fix-rounds-capped",
  "fix-leg-verdict-rerun",
  "ceiling-escalated",
  "ceiling-breach-entered",
  "rapid-restart-detected",
  "ceiling-breach-cleared",
  "rollback-recovered",
  "rollback-retry-failed",
  "rollback-escalated",
  "engine-review-verdict",
  "engine-review-budget-advisory",
  "engine-review-cost-unknown",
  "engine-review-containment-gap",
  "engine-review-orphaned-group",
  "engine-review-session-inspection",
  "reviewer-fallback-switch",
  "reviewer-fallback-revert",
  "pr-held",
  "pr-released",
  "lane-state-labeled",
  "lane-state-cleared",
  "resume-held",
  "worktree-retained",
  "worktree-released",
  "env-failure",
  "env-failure-preserved",
  "park-escalated",
  "park-probe",
  "park-resumed",
  "park-canary",
  "park-canary-failed",
  "park-canary-inconclusive",
  "tick-error",
  "standby-wait",
  "standby-exit",
  "round-stop",
  "align-summary",
  "triage-degraded",
  "no-plan-after-draft",
  "plan-review-escalated",
  "verify-na-proposed",
  "gated-reentry",
  "lane-revived",
  "gated-reentry-capped",
  "gated-reentry-capped-label-failed",
  "escalation-resolved",
  "needs-human-swept",
  "retro-pr-opened",
  "retro-pr-degraded",
  "run-started",
  "instance-lock-taken-over",
  "round-phase",
  "idle-churn-detected",
  "ci-inert-escalated",
  "ci-pending-observed",
  "ci-pending-escalated",
  "ci-pending-cleared",
].sort();

test("copy.ts has exactly one entry per §7 table kind — no more, no fewer", () => {
  assert.deepEqual([...EVENT_KINDS].sort(), DOC_TABLE_KINDS);
});

test("the §7 table's kind count is derived from the map, never hard-coded", () => {
  // docs/frontend-design.md §7 itself bans a hard-coded count ("an earlier hard-coded '33' had
  // already drifted"); this asserts the doc and the map agree on today's count without either
  // side pinning a magic number in prose. Scoped to the §7 section specifically (not just any
  // backtick-first table row in the doc — §5's token table has the same two-column shape).
  const doc = readFileSync(new URL("../../docs/frontend-design.md", import.meta.url), "utf8");
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## 7. Copy"));
  const end = lines.findIndex((l, i) => i > start && /^## \d/.test(l));
  assert.ok(start >= 0 && end > start, "could not locate §7's section bounds");
  const section = lines.slice(start, end);
  const rows = section.filter((l) => /^\| `[a-z0-9-]+` \|/.test(l));
  assert.equal(rows.length, EVENT_KINDS.length);
});

test("emergency-stop has no copy.ts entry (#293 — a control signal, not a feed event kind)", () => {
  assert.equal(copyFor("emergency-stop"), undefined);
});

test("copyFor returns undefined for any kind absent from the map, never a fallback entry", () => {
  assert.equal(copyFor("some-future-kind-nobody-registered-yet"), undefined);
});

// ── branching sentences ──────────────────────────────────────────────────────────────────────

test("reclaim-done branches on payload.next", () => {
  assert.equal(render("reclaim-done", { worker: "w1", next: "DRIVING" }), "Lane w1 opened a PR — now in review");
  assert.equal(render("reclaim-done", { worker: "w1", next: "REQUEUE" }), "Lane w1 ended without a PR — flagged for a human");
});

test("park-probe branches on payload.success and payload.source", () => {
  assert.equal(render("park-probe", { source: "forge", success: true }), "Forge check passed");
  assert.equal(render("park-probe", { source: "llm", success: true }), "Model check passed");
  assert.equal(render("park-probe", { source: "forge", success: false }), "Environment check failed — still waiting");
  assert.equal(render("park-probe", { source: "llm", success: false }), "Environment check failed — still waiting");
});

test("ceiling-breach-entered branches on payload.reason", () => {
  assert.match(render("ceiling-breach-entered", { reason: "wall-clock", maxWallClockSec: 3600 }), /3600s attention alarm/);
  assert.match(render("ceiling-breach-entered", { reason: "daily-budget", dailyBudgetUsd: 100 }), /Today's \$100 budget is spent/);
});

test("ceiling-breach-cleared branches on payload.reason", () => {
  assert.equal(render("ceiling-breach-cleared", { reason: "wall-clock" }), "The wall-clock alarm cleared");
  assert.equal(render("ceiling-breach-cleared", { reason: "daily-budget" }), "The daily budget rolled over");
});

test("escalation-resolved branches on payload.via across all five documented values", () => {
  assert.match(render("escalation-resolved", { issue: 7, pr: 12, via: "merged" }), /no longer needs you — PR #12 was merged/);
  assert.match(render("escalation-resolved", { issue: 7, via: "issue-closed" }), /no longer needs you — it was closed/);
  assert.match(
    render("escalation-resolved", { issue: 7, pr: 12, via: "pr-closed" }),
    /no longer needs you — PR #12 was closed without merging/,
  );
  assert.match(render("escalation-resolved", { issue: 7, via: "label-removed" }), /the flag was cleared/);
  assert.match(render("escalation-resolved", { issue: 7, via: "board-fixed" }), /the board was set to Done/);
});

test("needs-human-swept names the issue as an entity token and states the escalation-resolved clause", () => {
  assert.match(
    render("needs-human-swept", { issue: 7, label: "sapwood:needs-human" }),
    /Issue #7 no longer carries `sapwood:needs-human` — the engine removed the flag it had applied itself, now that its escalation is resolved/,
  );
});

test("resume-held names the issue as an entity token, not a raw string", () => {
  assert.match(
    render("resume-held", { worker: "w1", issue: 7, label: "sapwood:blocked" }),
    /Lane w1's handoff can't resume — issue #7 still carries `sapwood:blocked`/,
  );
});

/** The part immediately before the first PR entity token must end in the literal word "PR " —
 *  §7's rows all read "... PR #{pr} ..."; the token itself only ever renders the glyph + number. */
function textBeforeFirstPrToken(parts: SentencePart[]): string | undefined {
  const i = parts.findIndex((p) => typeof p !== "string" && p.kind === "pr");
  const before = i > 0 ? parts[i - 1] : undefined;
  return typeof before === "string" ? before : undefined;
}

test("every PR-bearing sentence spells out the literal word PR before the entity token (§7 exact text)", () => {
  const prBearing: [EventKind, Record<string, unknown>][] = [
    ["merged", { pr: 1, issue: 1 }],
    ["pr-held", { pr: 1, issue: 1 }],
    ["pr-released", { pr: 1, issue: 1 }],
    ["lane-state-labeled", { worker: "w1", pr: 1, issue: 1 }],
    ["retro-pr-opened", { pr: 1 }],
  ];
  for (const [kind, payload] of prBearing) {
    const before = textBeforeFirstPrToken(COPY[kind].sentence(payload));
    assert.match(before ?? "", /PR $/, `${kind} should spell "PR " immediately before its entity token`);
  }
  assert.match(
    textBeforeFirstPrToken(COPY["engine-review-verdict"].sentence({ outcome: "approved", pr: 1, issue: 1, findingCount: 0 })) ?? "",
    /Review approved PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(COPY["engine-review-verdict"].sentence({ outcome: "rejected", pr: 1, issue: 1, findingCount: 1 })) ?? "",
    /Review sent PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(COPY["escalation-resolved"].sentence({ issue: 1, pr: 1, via: "merged" })) ?? "",
    /no longer needs you — PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(COPY["escalation-resolved"].sentence({ issue: 1, pr: 1, via: "pr-closed" })) ?? "",
    /no longer needs you — PR $/,
  );
});

test("#715 gate② round 3 [0]: engine-review-containment-gap renders one line per payload.gaps entry and a security-guide link", () => {
  const parts = COPY["engine-review-containment-gap"].sentence({
    gaps: ["model-invoked-shell-execution", "host-wide-filesystem-reads"],
  });
  const lines = parts.filter((p): p is string => typeof p === "string" && p.startsWith("\n- "));
  assert.equal(lines.length, 2, "expected one line per gap entry");
  assert.match(lines[0]!, /shell commands directly/);
  assert.match(lines[1]!, /read files anywhere/);
  const link = parts.find((p) => typeof p !== "string" && p.kind === "link");
  assert.ok(link, "expected a link token in the sentence");
  assert.equal((link as { kind: "link"; path: string }).path, "docs/security.md");
});

test("engine-review-containment-gap falls back to the raw code for an unrecognized gap, never a silent drop", () => {
  const parts = COPY["engine-review-containment-gap"].sentence({ gaps: ["some-future-gap-code"] });
  const lines = parts.filter((p): p is string => typeof p === "string" && p.startsWith("\n- "));
  assert.deepEqual(lines, ["\n- some-future-gap-code"]);
});

test("engine-review-containment-gap tolerates a missing/malformed payload.gaps without throwing", () => {
  assert.doesNotThrow(() => COPY["engine-review-containment-gap"].sentence({}));
  const parts = COPY["engine-review-containment-gap"].sentence({});
  assert.equal(parts.filter((p) => typeof p === "string" && p.startsWith("\n- ")).length, 0);
});

test("drive-fixup names the reason word for each of the three prescriptions", () => {
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:findings" }), /review findings/);
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:merge-conflict" }), /merge conflict/);
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:CI_RED:build" }), /checks failed/);
});

// ── attention membership (§3) ────────────────────────────────────────────────────────────────

test("pr-held and pr-released carry no attention marker", () => {
  assert.equal(COPY["pr-held"].attention, undefined);
  assert.equal(COPY["pr-released"].attention, undefined);
  assert.equal(hasAttention("pr-held", { pr: 1, issue: 1 }), false);
  assert.equal(hasAttention("pr-released", { pr: 1, issue: 1 }), false);
});

test("verify-na-proposed always carries attention", () => {
  assert.equal(COPY["verify-na-proposed"].attention, true);
  assert.equal(hasAttention("verify-na-proposed", { issue: 1 }), true);
});

test("gate② opus round 1 P3 (#797): ci-inert-escalated names the check count, pluralizes correctly, and always carries attention", () => {
  assert.equal(render("ci-inert-escalated", { pr: 1, checks: [] }), "PR #1 needs a human — CI concluded without ever going green");
  assert.equal(
    render("ci-inert-escalated", { pr: 1, checks: [{ name: "a", conclusion: "SKIPPED" }] }),
    "PR #1 needs a human — CI concluded without ever going green (1 check)",
  );
  assert.equal(
    render("ci-inert-escalated", {
      pr: 1,
      checks: [
        { name: "a", conclusion: "SKIPPED" },
        { name: "b", conclusion: "NEUTRAL" },
      ],
    }),
    "PR #1 needs a human — CI concluded without ever going green (2 checks)",
  );
  assert.equal(COPY["ci-inert-escalated"].attention, true);
  assert.equal(hasAttention("ci-inert-escalated", { pr: 1 }), true);
});

test("escalation-resolved never carries attention — it clears an item, never opens one", () => {
  assert.equal(COPY["escalation-resolved"].attention, undefined);
  for (const via of ["merged", "issue-closed", "pr-closed", "label-removed", "board-fixed"]) {
    assert.equal(hasAttention("escalation-resolved", { issue: 1, via }), false);
  }
});

test("reclaim-done/reclaim-failed are attention items only on their non-DRIVING branch", () => {
  assert.equal(hasAttention("reclaim-done", { next: "DRIVING" }), false);
  assert.equal(hasAttention("reclaim-done", { next: "ESCALATE_NOPR" }), true);
  assert.equal(hasAttention("reclaim-failed", { next: "DRIVING" }), false);
  assert.equal(hasAttention("reclaim-failed", { next: "ESCALATE" }), true);
  // Fail direction for a malformed payload missing `next` entirely: attention (§3 doctrine — a
  // visible row is recoverable, a silently-dropped one is not).
  assert.equal(hasAttention("reclaim-done", {}), true);
});

test("every kind named in §3's flagged-attention list carries the marker", () => {
  const alwaysAttention: EventKind[] = [
    "drive-needs-human",
    "rollback-escalated",
    "plan-review-escalated",
    "verify-na-proposed",
    "gated-reentry-capped",
    "gated-reentry-capped-label-failed",
    "worktree-retained",
    "park-escalated",
    "env-failure-preserved",
    "ceiling-escalated",
    // #715 gate② [2]: not named in §3's own (dated) prose list, but each is
    // `escalation-source:always` in the engine's own authoritative registry
    // (engine/src/state/event-kinds/drive.ts) — see the drift test below, which checks the
    // full registry rather than re-transcribing it a second time here.
    "drive-no-pr",
    "fix-rounds-capped",
    "fix-leg-verdict-rerun",
  ];
  for (const kind of alwaysAttention) {
    assert.equal(COPY[kind].attention, true, `${kind} should carry attention: true`);
  }
});

test("#715 gate② [2]: attention drift guard — every §7-table kind the engine tags as an unconditional escalation source carries `attention` in COPY", () => {
  // The two reclaim kinds are PAYLOAD-predicated (#404) — their membership depends on `next`,
  // not unconditional presence, and copy.ts already covers them with `reclaimNeedsAttention`
  // (tested above); this guard only asserts the UNCONDITIONAL sources.
  const predicated = new Set(["reclaim-done", "reclaim-failed"]);
  // Set<string>, not Set<engine's EventKind>: dashboard's own EventKind union is NOT provably a
  // subset of the engine's (e.g. `no-plan-after-draft` has a §7 table row and a COPY entry but,
  // as of this writing, no matching engine-registered kind at all — a separate, pre-existing
  // doc/engine drift this test does not try to adjudicate). Comparing as plain strings is the
  // correct membership check regardless of which side's nominal type is wider.
  const unconditionalSources: Set<string> = new Set(ESCALATION_SOURCE_KINDS.filter((k) => !predicated.has(k)));
  for (const kind of EVENT_KINDS) {
    if (!unconditionalSources.has(kind)) continue;
    assert.equal(
      COPY[kind].attention,
      true,
      `${kind} is escalation-source:* in the engine's registry but carries no attention marker in COPY`,
    );
  }
});

test("resume-held carries no attention marker — it is a consequence, not a new item (§3)", () => {
  assert.equal(COPY["resume-held"].attention, undefined);
});

// ── #715 gate② round 4 [1]: table-driven sentence oracle — exact §7 text, every row, every branch ─
//
// The tests above already exercise attention metadata and a handful of sentences via `assert
// .match` on a fragment. This table is the thing the finding asked for: an INDEPENDENT
// transcription of §7's "Feed sentence" column (same "count is derived from the map, never
// hard-coded" discipline `DOC_TABLE_KINDS` above already applies to the row COUNT — this applies
// it to each row's TEXT), asserted with `assert.equal` against the full rendered sentence, not a
// substring. Every current §7 row appears at least once; a row with a documented payload branch
// (`reclaim-done`, `ceiling-breach-entered`/`cleared`, `escalation-resolved`'s five `via` values,
// `engine-review-verdict`, `park-probe`, `drive-fixup`, `pool-selected`, `fix-leg-started`) appears
// once per branch.

const SENTENCE_ORACLE: [kind: EventKind, payload: Record<string, unknown>, expected: string][] = [
  ["dispatched", { issue: 1 }, "Started work on issue #1"],
  ["dispatch-failed", { issue: 1 }, "Couldn't start issue #1 — it's back in the backlog"],
  ["reclaim-done", { worker: "w1", next: "DRIVING" }, "Lane w1 opened a PR — now in review"],
  ["reclaim-done", { worker: "w1", next: "ESCALATE_NOPR" }, "Lane w1 ended without a PR — flagged for a human"],
  ["reclaim-failed", { worker: "w1" }, "Lane w1 hit a problem and stopped"],
  ["reclaim-dead", { worker: "w1" }, "Lane w1 went silent — cleaned up; its issue goes back to the backlog"],
  ["handoff", { worker: "w1" }, "Lane w1 reached its budget and saved its progress for a successor"],
  ["merged", { pr: 10, issue: 1 }, "Merged PR #10 — checks green and review approved"],
  ["drive-needs-human", { pr: 10, issue: 1 }, "PR #10 needs a human decision"],
  ["drive-no-pr", { worker: "w1" }, "Lane w1 ended without opening a PR"],
  ["drive-queued", { pr: 10, issue: 1 }, "PR #10 is ready — waiting its turn to merge"],
  ["drive-stopped", { pr: 10, issue: 1 }, "PR #10 is open and left for you — auto-merge is off"],
  ["pool-selected", { issues: [1, 2, 3] }, "Selected 3 issue(s) for this round"],
  ["pool-selected", {}, "Selected 0 issue(s) for this round"],
  ["drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:findings" }, "PR #1 sent back to fix — review findings"],
  ["drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:merge-conflict" }, "PR #1 sent back to fix — merge conflict"],
  ["drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:CI_RED:build" }, "PR #1 sent back to fix — checks failed"],
  ["fix-leg-started", { worker: "w1", fixRounds: 2, cap: 5 }, "Lane w1 is fixing its PR — round 2 of 5"],
  ["fix-leg-started", { worker: "w1", fixRounds: 1 }, "Lane w1 is fixing its PR — round 1"],
  ["fix-leg-resumed", { worker: "w1" }, "Lane w1 resumed fixing after a handoff"],
  ["fix-rounds-capped", { pr: 1, issue: 1 }, "PR #1 used up its fix attempts — needs a human"],
  ["fix-leg-verdict-rerun", { pr: 1, issue: 1 }, "PR #1's review findings aren't fixable by the producer — needs a human"],
  ["ceiling-escalated", {}, "Safety ceiling reached — winding down all work"],
  [
    "ceiling-breach-entered",
    { reason: "wall-clock", maxWallClockSec: 3600 },
    "This run hit its 3600s attention alarm — no new work until a restart",
  ],
  ["ceiling-breach-entered", { reason: "daily-budget", dailyBudgetUsd: 100 }, "Today's $100 budget is spent — no new work until tomorrow"],
  ["ceiling-breach-entered", {}, "A safety ceiling was reached — no new work until it clears"],
  [
    "rapid-restart-detected",
    { births: 3, windowSec: 60 },
    "Engine started 3 times in 60s — crash loop suspected, dispatch parked for a human",
  ],
  ["ceiling-breach-cleared", { reason: "wall-clock" }, "The wall-clock alarm cleared"],
  ["ceiling-breach-cleared", { reason: "daily-budget" }, "The daily budget rolled over"],
  ["ceiling-breach-cleared", {}, "A safety ceiling cleared"],
  ["rollback-recovered", { issue: 1 }, "Returned issue #1 to the backlog safely"],
  ["rollback-retry-failed", { issue: 1 }, "Still trying to return issue #1 to the backlog"],
  ["rollback-escalated", { issue: 1 }, "Couldn't return issue #1 automatically — flagged for a human"],
  ["engine-review-verdict", { outcome: "approved", pr: 1, issue: 1, findingCount: 0 }, "Review approved PR #1 — 0 finding(s) noted"],
  ["engine-review-verdict", { outcome: "rejected", pr: 1, issue: 1, findingCount: 2 }, "Review sent PR #1 back — 2 finding(s) to fix"],
  ["engine-review-verdict", { outcome: "approved", pr: 1, issue: 1 }, "Review approved PR #1 — counts unavailable noted"],
  [
    "engine-review-budget-advisory",
    { capUsd: 5 },
    "This review’s $5 budget is a guide, not a limit — the tool running it can’t enforce one",
  ],
  ["engine-review-cost-unknown", {}, "This review finished without reporting what it cost — its spend is unknown, not zero"],
  [
    "engine-review-containment-gap",
    {},
    "Recorded limits, not an incident: this review ran in a sandbox that blocks writes but still lets the reviewed code run, and does not limit which files it can read\nWhat this means",
  ],
  [
    "engine-review-orphaned-group",
    {},
    "A review that ran out of time was stopped, but something it started is still running on this machine",
  ],
  ["engine-review-session-inspection", { toolItemCount: 5 }, "This review session made 5 tool/command call(s) while looking things over"],
  ["reviewer-fallback-switch", {}, "The usual reviewer isn't answering — switched to the backup"],
  ["reviewer-fallback-revert", {}, "The usual reviewer is back — switched back"],
  ["pr-held", { pr: 1, issue: 1 }, "A person put PR #1 on hold — nothing moves until they lift it"],
  ["pr-released", { pr: 1, issue: 1 }, "Hold released — PR #1 resumes"],
  ["lane-state-labeled", { worker: "w1", pr: 1, issue: 1 }, "Lane w1 is now shown as working on PR #1"],
  ["lane-state-cleared", { worker: "w1", pr: 1, issue: 1 }, "PR #1 no longer shows lane w1 as working on it"],
  [
    "resume-held",
    { worker: "w1", issue: 7, label: "sapwood:blocked" },
    "Lane w1's handoff can't resume — issue #7 still carries `sapwood:blocked`",
  ],
  ["worktree-retained", { worker: "w1" }, "Kept lane w1's working folder for inspection"],
  ["worktree-released", { worker: "w1" }, "Lane w1's retained folder was cleaned up"],
  ["env-failure", { worker: "w1" }, "Lane w1 hit an environment problem — not the work itself"],
  [
    "env-failure-preserved",
    { worker: "w1" },
    "Kept lane w1's work safe after an environment problem — its PR needs a human to continue it",
  ],
  ["park-escalated", {}, "The environment keeps failing — paused dispatch and flagged a human"],
  ["park-probe", { source: "forge", success: true }, "Forge check passed"],
  ["park-probe", { source: "llm", success: true }, "Model check passed"],
  ["park-probe", { source: "forge", success: false }, "Environment check failed — still waiting"],
  ["park-resumed", {}, "Environment recovered — resuming work"],
  ["park-canary", {}, "Sent one test lane to check the environment"],
  ["park-canary-failed", {}, "The test lane failed — still waiting on the environment"],
  ["park-canary-inconclusive", {}, "The test lane didn't settle it — still waiting on the environment"],
  ["tick-error", {}, "The engine hit an error this cycle — it will retry"],
  ["standby-wait", { waitSec: 30 }, "Nothing to work on — checking again in 30 s"],
  ["standby-exit", { attempts: 4 }, "Work appeared — resuming after 4 quiet check(s)"],
  ["round-stop", { detail: "lane cap" }, "This round reached its limit (lane cap) — no new work this round"],
  ["align-summary", { created: 3, triaged: 2 }, "Planning pass: 3 issue(s) created, 2 plan(s) drafted"],
  ["triage-degraded", {}, "A planning session had trouble — some issues keep their old plans"],
  ["no-plan-after-draft", { issue: 1 }, "Issue #1 still has no usable plan after a drafting attempt"],
  ["plan-review-escalated", { issue: 1 }, "Issue #1's plan needs a human — automated review couldn't approve it"],
  ["verify-na-proposed", { issue: 1 }, "Issue #1 proposed as not separately verifiable — a person decides"],
  ["gated-reentry", { issue: 1 }, "Issue #1's PR was unblocked by a human — back through review"],
  ["lane-revived", { issue: 1 }, "Issue #1's PR picked back up after an environment failure — back under review"],
  ["gated-reentry-capped", { issue: 1 }, "Issue #1 was unblocked too many times without landing — flagged for a human"],
  ["gated-reentry-capped-label-failed", { issue: 1 }, "Couldn't re-flag issue #1 — please check it manually"],
  ["escalation-resolved", { issue: 7, pr: 12, via: "merged" }, "Issue #7 no longer needs you — PR #12 was merged"],
  ["escalation-resolved", { issue: 7, via: "issue-closed" }, "Issue #7 no longer needs you — it was closed"],
  ["escalation-resolved", { issue: 7, pr: 12, via: "pr-closed" }, "Issue #7 no longer needs you — PR #12 was closed without merging"],
  ["escalation-resolved", { issue: 7, via: "label-removed" }, "Issue #7 no longer needs you — the flag was cleared"],
  ["escalation-resolved", { issue: 7, via: "board-fixed" }, "Issue #7 no longer needs you — the board was set to Done"],
  [
    "needs-human-swept",
    { issue: 7, label: "sapwood:needs-human" },
    "Issue #7 no longer carries `sapwood:needs-human` — the engine removed the flag it had applied itself, now that its escalation is resolved",
  ],
  ["retro-pr-opened", { pr: 5 }, "The loop proposed an improvement to itself — PR #5 awaits review"],
  ["retro-pr-degraded", {}, "A self-improvement proposal didn't come together this round"],
  ["run-started", {}, "Engine started a new run"],
  ["instance-lock-taken-over", { previousPid: 1234 }, "Took over the engine lock left by a crashed run (pid 1234)"],
  ["round-phase", { round_id: 5, phase: "executing" }, "Round 5 moved into executing"],
  ["idle-churn-detected", { rounds: 3 }, "The loop ran 3 rounds in a row that changed nothing at all — parked for a human"],
  [
    "ci-inert-escalated",
    { pr: 12, issue: 7, checks: [{ name: "lint", conclusion: "SKIPPED" }] },
    "PR #12 needs a human — CI concluded without ever going green (1 check)",
  ],
  ["ci-pending-observed", { pr: 12, issue: 7 }, "PR #12 is waiting on CI"],
  ["ci-pending-escalated", { pr: 12, issue: 7 }, "PR #12 needs a human — CI stayed pending too long to progress on its own"],
  ["ci-pending-cleared", { pr: 12, issue: 7 }, "PR #12's CI resolved"],
];

test("table-driven §7 sentence oracle: every row (and every documented payload branch) renders its exact documented text", () => {
  for (const [kind, payload, expected] of SENTENCE_ORACLE) {
    assert.equal(render(kind, payload), expected, `${kind} with payload ${JSON.stringify(payload)}`);
  }
});

test("the sentence oracle covers every current §7-table kind at least once", () => {
  const covered = new Set(SENTENCE_ORACLE.map(([kind]) => kind));
  assert.deepEqual([...covered].sort(), [...EVENT_KINDS].sort());
});

// ── #723: the header's engine-state caption (§7 convention, applied to the §3 A engine word) ──

test("engineStateCaption: standby renders calm, never as an error, with the next-check countdown folded in", () => {
  assert.equal(engineStateCaption("standby", 42), "idle — nothing to work on right now — checking again in 42s");
});

test("engineStateCaption: every other state ignores standbyNextCheckSec even if the server somehow sent one", () => {
  assert.equal(engineStateCaption("running", null), "actively working");
  assert.equal(engineStateCaption("stalled", 42), "not responding");
  assert.equal(engineStateCaption("paused", null), "paused by operator");
  assert.equal(engineStateCaption("winding-down", null), "finishing in-flight work, no new dispatch");
  assert.equal(engineStateCaption("stopping", null), "shutting down");
  assert.equal(engineStateCaption("stopped", null), "not running");
});

test("engineStateCaption: stopped never repeats the engine-word span's own text (#729 — was the doubled 'stopped — stopped')", () => {
  assert.notEqual(engineStateCaption("stopped", null), "stopped");
});

test("engineStateCaption: standby with no countdown known yet renders the base caption alone, never a stray dash", () => {
  assert.equal(engineStateCaption("standby", null), "idle — nothing to work on right now");
});

test("engineStateCaption: an unrecognized state falls back to itself, the same honest-unknown laneStateCaption uses", () => {
  assert.equal(engineStateCaption("some-future-state", null), "some-future-state");
});
