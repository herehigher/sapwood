import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// Test-only import (same pattern as config-captions.test.ts's CONFIG_ALLOWLIST cross-check): the
// engine's own tagged registry is the AUTHORITATIVE attention-membership signal, not frontend-
// design.md §3's prose list, which has already drifted once (finding [2] below).
import { ESCALATION_SOURCE_KINDS } from "../../engine/src/loop/escalation-reconcile.ts";
// Test-only import (same pattern as ESCALATION_SOURCE_KINDS above): the engine's own registry —
// not a re-transcribed count — is the oracle for the #893 cross-package exhaustiveness test.
import { EVENT_KIND_NAMES as ENGINE_EVENT_KIND_NAMES, kindGlossary } from "../../engine/src/state/event-kinds/index.ts";
import {
  ATTENTION_CATEGORY,
  attentionCategory,
  COPY,
  copyFor,
  EVENT_KINDS,
  type EventKind,
  engineStateCaption,
  hasAttention,
  isDissentSignal,
  isKnownKind,
  type SentencePart,
  TELEMETRY_KINDS,
} from "./copy.ts";

// `copyFor`, not `COPY[kind]` directly — #893: `COPY` is now `Partial<Record<EventKind,
// CopyEntry>>` (only the narrative half of the full engine-derived union), so a direct index would
// be `CopyEntry | undefined` at the type level even for a kind this test knows is narrative.
const render = (kind: EventKind, payload: Record<string, unknown> = {}) =>
  (copyFor(kind)?.sentence(payload) ?? [])
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
  // #893: newly-mapped attention-class kinds — the engine registers each `actionability:
  // "intervene"` (or an unconditional `escalation-source:*`), and each had no copy entry at all
  // before this PR (the "126/194 kinds unmapped" gap's attention-bearing half).
  "emergency-stop",
  "consecutive-stalls-detected",
  "empty-spin-park",
  "base-ci-red-escalated",
  "estop-lane-swept",
  "estop-lane-sweep-incapable",
  "resume-capped",
  "resume-undecidable",
  "orphan-pr-escalated",
  "gated-flag-unprovable",
  "drive-human-merge-only",
  "fix-leg-dispatch-unconfigured",
  "fix-leg-undecidable",
  "fix-thread-write-escalated",
  "ac-snapshot-drift",
  "review-silence-escalated",
  "review-disputed",
  "review-non-convergent",
  "comment-cursor-stale",
  "round-pool-removal-capped",
  "concern-post-escalated",
  "operator-fence-violated",
  "architect-repeat-drop-escalated",
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

test("#893: emergency-stop now carries a real copy entry — a registered engine kind (actionability: intervene, run.ts) that used to be deliberately absent and would otherwise hit the raw fallback", () => {
  assert.notEqual(copyFor("emergency-stop"), undefined);
  assert.equal(hasAttention("emergency-stop", {}), true);
});

test("copyFor returns undefined for any kind absent from the map, never a fallback entry", () => {
  assert.equal(copyFor("some-future-kind-nobody-registered-yet"), undefined);
});

// ── branching sentences ──────────────────────────────────────────────────────────────────────

test("reclaim-done branches on payload.next", () => {
  assert.equal(render("reclaim-done", { worker: "w1", next: "DRIVING" }), "Lane w1 opened a PR — now in review");
  assert.equal(
    render("reclaim-done", { worker: "w1", next: "REQUEUE" }),
    "Lane w1 ended without a PR — reason not recorded · asks: review the lane's outcome and decide whether to retry",
  );
  assert.equal(
    render("reclaim-done", { worker: "w1", next: "REQUEUE", reason: "worker stated it couldn't reproduce the failure" }),
    "Lane w1 ended without a PR — worker stated it couldn't reproduce the failure · asks: review the lane's outcome and decide whether to retry",
  );
});

// ── #890 (§3 E): the est→real calibration clause on lane settlement ────────────────────────────

test("reclaim-done appends the est→real calibration clause when both figures are present, on either branch", () => {
  assert.equal(
    render("reclaim-done", { worker: "w1", next: "DRIVING", estCostUsd: 6.21, costUsd: 5.8 }),
    "Lane w1 opened a PR — now in review · est $6.21 → real $5.80",
  );
  assert.equal(
    render("reclaim-done", { worker: "w1", next: "REQUEUE", estCostUsd: 6.21, costUsd: 5.8 }),
    "Lane w1 ended without a PR — reason not recorded · asks: review the lane's outcome and decide whether to retry · est $6.21 → real $5.80",
  );
});

test("reclaim-done renders no calibration clause when estCostUsd is absent — a lane never probed while running", () => {
  assert.equal(render("reclaim-done", { worker: "w1", next: "DRIVING", costUsd: 5.8 }), "Lane w1 opened a PR — now in review");
});

test("reclaim-done renders no calibration clause when costUsd is absent (a pre-#890 payload) — never half a figure", () => {
  assert.equal(render("reclaim-done", { worker: "w1", next: "DRIVING", estCostUsd: 6.21 }), "Lane w1 opened a PR — now in review");
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
    const before = textBeforeFirstPrToken(copyFor(kind)!.sentence(payload));
    assert.match(before ?? "", /PR $/, `${kind} should spell "PR " immediately before its entity token`);
  }
  assert.match(
    textBeforeFirstPrToken(copyFor("engine-review-verdict")!.sentence({ outcome: "approved", pr: 1, issue: 1, findingCount: 0 })) ?? "",
    /Review approved PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(copyFor("engine-review-verdict")!.sentence({ outcome: "rejected", pr: 1, issue: 1, findingCount: 1 })) ?? "",
    /Review sent PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(copyFor("escalation-resolved")!.sentence({ issue: 1, pr: 1, via: "merged" })) ?? "",
    /no longer needs you — PR $/,
  );
  assert.match(
    textBeforeFirstPrToken(copyFor("escalation-resolved")!.sentence({ issue: 1, pr: 1, via: "pr-closed" })) ?? "",
    /no longer needs you — PR $/,
  );
});

test("#715 gate② round 3 [0]: engine-review-containment-gap renders one line per payload.gaps entry and a security-guide link", () => {
  const parts = copyFor("engine-review-containment-gap")!.sentence({
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
  const parts = copyFor("engine-review-containment-gap")!.sentence({ gaps: ["some-future-gap-code"] });
  const lines = parts.filter((p): p is string => typeof p === "string" && p.startsWith("\n- "));
  assert.deepEqual(lines, ["\n- some-future-gap-code"]);
});

test("engine-review-containment-gap tolerates a missing/malformed payload.gaps without throwing", () => {
  assert.doesNotThrow(() => copyFor("engine-review-containment-gap")!.sentence({}));
  const parts = copyFor("engine-review-containment-gap")!.sentence({});
  assert.equal(parts.filter((p) => typeof p === "string" && p.startsWith("\n- ")).length, 0);
});

test("drive-fixup names the reason word for each of the three prescriptions", () => {
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:findings" }), /review findings/);
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:merge-conflict" }), /merge conflict/);
  assert.match(render("drive-fixup", { pr: 1, issue: 1, reason: "gate:FIXABLE:CI_RED:build" }), /checks failed/);
});

// ── attention membership (§3) ────────────────────────────────────────────────────────────────

test("pr-held and pr-released carry no attention marker", () => {
  assert.equal(copyFor("pr-held")!.attention, undefined);
  assert.equal(copyFor("pr-released")!.attention, undefined);
  assert.equal(hasAttention("pr-held", { pr: 1, issue: 1 }), false);
  assert.equal(hasAttention("pr-released", { pr: 1, issue: 1 }), false);
});

test("verify-na-proposed always carries attention", () => {
  assert.equal(copyFor("verify-na-proposed")!.attention, true);
  assert.equal(hasAttention("verify-na-proposed", { issue: 1 }), true);
});

test("gate② opus round 1 P3 (#797): ci-inert-escalated names the check count, pluralizes correctly, and always carries attention", () => {
  assert.equal(
    render("ci-inert-escalated", { pr: 1, checks: [] }),
    "PR #1 needs a human — CI concluded without ever going green · asks: fix the check, then clear the label to retry",
  );
  // A malformed-shape (non-string) checks array still falls back to the honest count, never a throw.
  assert.equal(
    render("ci-inert-escalated", { pr: 1, checks: [{ name: "a", conclusion: "SKIPPED" }] }),
    "PR #1 needs a human — CI concluded without ever going green (1 check) · asks: fix the check, then clear the label to retry",
  );
  assert.equal(
    render("ci-inert-escalated", {
      pr: 1,
      checks: [
        { name: "a", conclusion: "SKIPPED" },
        { name: "b", conclusion: "NEUTRAL" },
      ],
    }),
    "PR #1 needs a human — CI concluded without ever going green (2 checks) · asks: fix the check, then clear the label to retry",
  );
  assert.equal(copyFor("ci-inert-escalated")!.attention, true);
  assert.equal(hasAttention("ci-inert-escalated", { pr: 1 }), true);
});

test("#881: ci-inert-escalated names the actual check strings when the real string[] payload shape is carried", () => {
  assert.equal(
    render("ci-inert-escalated", { pr: 1, checks: ["lint (SKIPPED)", "build (NEUTRAL)"] }),
    "PR #1 needs a human — CI concluded without ever going green (lint (SKIPPED), build (NEUTRAL)) · asks: fix the check, then clear the label to retry",
  );
});

test("escalation-resolved never carries attention — it clears an item, never opens one", () => {
  assert.equal(copyFor("escalation-resolved")!.attention, undefined);
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
    assert.equal(copyFor(kind)!.attention, true, `${kind} should carry attention: true`);
  }
});

test("#715 gate② [2]: attention drift guard — every §7-table kind the engine tags as an unconditional escalation source carries `attention` in COPY", () => {
  // The two reclaim kinds are PAYLOAD-predicated (#404) — their membership depends on `next`,
  // not unconditional presence, and copy.ts already covers them with `reclaimNeedsAttention`
  // (tested above); this guard only asserts the UNCONDITIONAL sources.
  const predicated = new Set(["reclaim-done", "reclaim-failed"]);
  // #893: dashboard's `EventKind` is now type-derived from the engine's own registry, so this is
  // a genuine subset check rather than a defensive plain-string comparison against a possibly
  // wider/narrower nominal type (the pre-#893 `no-plan-after-draft` drift this comment used to
  // note is gone — that dead, non-engine-registered COPY entry was removed in the same change).
  const unconditionalSources: Set<string> = new Set(ESCALATION_SOURCE_KINDS.filter((k) => !predicated.has(k)));
  for (const kind of EVENT_KINDS) {
    if (!unconditionalSources.has(kind)) continue;
    assert.equal(
      copyFor(kind)!.attention,
      true,
      `${kind} is escalation-source:* in the engine's registry but carries no attention marker in COPY`,
    );
  }
});

test("resume-held carries no attention marker — it is a consequence, not a new item (§3)", () => {
  assert.equal(copyFor("resume-held")!.attention, undefined);
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
  [
    "reclaim-done",
    { worker: "w1", next: "ESCALATE_NOPR" },
    "Lane w1 ended without a PR — reason not recorded · asks: review the lane's outcome and decide whether to retry",
  ],
  [
    "reclaim-failed",
    { worker: "w1" },
    "Lane w1 hit a problem and stopped — reason not recorded · asks: investigate and decide whether to retry",
  ],
  ["reclaim-dead", { worker: "w1" }, "Lane w1 went silent — cleaned up; its issue goes back to the backlog"],
  ["handoff", { worker: "w1" }, "Lane w1 reached its budget and saved its progress for a successor"],
  ["merged", { pr: 10, issue: 1 }, "Merged PR #10 — checks green and review approved"],
  ["drive-needs-human", { pr: 10, issue: 1 }, "PR #10 needs a human decision — reason not recorded · asks: decide the PR's next step"],
  [
    "drive-needs-human",
    { pr: 10, issue: 1, reason: "engine-agent: gate:HUMAN:pr-state-closed" },
    "PR #10 needs a human decision — the PR was closed outside the loop · asks: decide the PR's next step",
  ],
  [
    "drive-no-pr",
    { worker: "w1" },
    "Lane w1 ended without opening a PR — reason not recorded · asks: check the lane's log and decide next steps",
  ],
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
  ["fix-rounds-capped", { pr: 1, issue: 1 }, "PR #1 used up its fix attempts · asks: adjudicate — re-ready or close manually"],
  [
    "fix-rounds-capped",
    { pr: 1, issue: 1, fixRounds: 3, cap: 3 },
    "PR #1 used up its fix attempts (3/3) · asks: adjudicate — re-ready or close manually",
  ],
  ["fix-leg-verdict-rerun", { pr: 1, issue: 1 }, "PR #1's review findings aren't fixable by the producer · asks: adjudicate"],
  ["ceiling-escalated", {}, "Safety ceiling reached — winding down all work · asks: resume when it clears, or raise the ceiling"],
  [
    "ceiling-escalated",
    { reasons: ["daily-budget"] },
    "Safety ceiling reached (daily-budget) — winding down all work · asks: resume when it clears, or raise the ceiling",
  ],
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
    "Engine started 3 times in 60s — crash loop suspected, dispatch parked for a human · asks: clear the park once resolved",
  ],
  ["ceiling-breach-cleared", { reason: "wall-clock" }, "The wall-clock alarm cleared"],
  ["ceiling-breach-cleared", { reason: "daily-budget" }, "The daily budget rolled over"],
  ["ceiling-breach-cleared", {}, "A safety ceiling cleared"],
  ["rollback-recovered", { issue: 1 }, "Returned issue #1 to the backlog safely"],
  ["rollback-retry-failed", { issue: 1 }, "Still trying to return issue #1 to the backlog"],
  ["rollback-escalated", { issue: 1 }, "Couldn't return issue #1 automatically · asks: return it to the backlog by hand"],
  [
    "rollback-escalated",
    { issue: 1, reason: "3 retries exhausted" },
    "Couldn't return issue #1 automatically — 3 retries exhausted · asks: return it to the backlog by hand",
  ],
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
  [
    "worktree-retained",
    { worker: "w1" },
    "Kept lane w1's working folder for inspection — reason not recorded · asks: inspect and clear when done",
  ],
  [
    "worktree-retained",
    { worker: "w1", worktreePath: "/tmp/w1" },
    "Kept lane w1's working folder for inspection at `/tmp/w1` — reason not recorded · asks: inspect and clear when done",
  ],
  ["worktree-released", { worker: "w1" }, "Lane w1's retained folder was cleaned up"],
  ["env-failure", { worker: "w1" }, "Lane w1 hit an environment problem — not the work itself"],
  [
    "env-failure-preserved",
    { worker: "w1" },
    "Kept lane w1's work safe after an environment problem — its PR needs a human to continue it · asks: inspect the environment and continue the PR",
  ],
  [
    "env-failure-preserved",
    { worker: "w1", source: "llm-timeout" },
    "Kept lane w1's work safe after an environment problem (llm-timeout) — its PR needs a human to continue it · asks: inspect the environment and continue the PR",
  ],
  ["park-escalated", {}, "The environment keeps failing — paused dispatch · asks: clear the park once resolved"],
  [
    "park-escalated",
    { source: "consecutive-stalls" },
    "The environment keeps failing (consecutive-stalls) — paused dispatch · asks: clear the park once resolved",
  ],
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
  [
    "plan-review-escalated",
    { issue: 1 },
    "Issue #1's plan needs a human — automated review couldn't approve it · asks: revise the plan or adjudicate",
  ],
  [
    "plan-review-escalated",
    { issue: 1, reason: "reviewer determined this issue is not dispatchable by any redraft" },
    "Issue #1's plan needs a human — reviewer determined this issue is not dispatchable by any redraft · asks: revise the plan or adjudicate",
  ],
  [
    "verify-na-proposed",
    { issue: 1 },
    "Issue #1 proposed as not separately verifiable — reason not recorded · asks: approve or reject the proposal",
  ],
  ["gated-reentry", { issue: 1 }, "Issue #1's PR was unblocked by a human — back through review"],
  ["lane-revived", { issue: 1 }, "Issue #1's PR picked back up after an environment failure — back under review"],
  [
    "gated-reentry-capped",
    { issue: 1 },
    "Issue #1 was unblocked too many times without landing · asks: merge by hand — automatic reentry exhausted",
  ],
  [
    "gated-reentry-capped",
    { issue: 1, attempts: 3 },
    "Issue #1 was unblocked 3 times without landing · asks: merge by hand — automatic reentry exhausted",
  ],
  [
    "gated-reentry-capped-label-failed",
    { issue: 1 },
    "Couldn't re-flag issue #1 · asks: check it manually (retries automatically — not urgent)",
  ],
  [
    "gated-reentry-capped-label-failed",
    { issue: 1, error: "label API 500" },
    "Couldn't re-flag issue #1 — label API 500 · asks: check it manually (retries automatically — not urgent)",
  ],
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
  [
    "idle-churn-detected",
    { rounds: 3 },
    "The loop ran 3 rounds in a row that changed nothing at all — parked for a human · asks: clear the park once resolved",
  ],
  [
    "ci-inert-escalated",
    { pr: 12, issue: 7, checks: [{ name: "lint", conclusion: "SKIPPED" }] },
    "PR #12 needs a human — CI concluded without ever going green (1 check) · asks: fix the check, then clear the label to retry",
  ],
  ["ci-pending-observed", { pr: 12, issue: 7 }, "PR #12 is waiting on CI"],
  [
    "ci-pending-escalated",
    { pr: 12, issue: 7 },
    "PR #12 needs a human — CI stayed pending too long to progress on its own · asks: re-run or fix the stuck check, then clear the label",
  ],
  [
    "ci-pending-escalated",
    { pr: 12, issue: 7, checks: ["build"], blockedChecks: ["build"] },
    "PR #12 needs a human — CI stayed pending too long to progress on its own — blocked: build · asks: re-run or fix the stuck check, then clear the label",
  ],
  ["ci-pending-cleared", { pr: 12, issue: 7 }, "PR #12's CI resolved"],

  // #893: the newly-mapped attention-class kinds.
  [
    "emergency-stop",
    {},
    "EMERGENCY STOP triggered — every running lane was killed immediately, no drain window · asks: inspect in-flight work for lost progress before resuming",
  ],
  [
    "consecutive-stalls-detected",
    { streak: 3, maxConsecutiveStalls: 3 },
    "The engine stalled 3/3 times in a row — dispatch parked for a human · asks: clear the park once resolved",
  ],
  ["empty-spin-park", {}, "The peripheral roles kept failing to produce work — paused dispatch · asks: clear the park once resolved"],
  [
    "base-ci-red-escalated",
    { sha: "abc123", branch: "main", failing: ["lint", "build"] },
    "The default branch's CI is red (lint, build) — no PR can merge until it's fixed · asks: fix the default branch's CI",
  ],
  [
    "base-ci-red-escalated",
    { sha: "abc123", branch: "main" },
    "The default branch's CI is red — no PR can merge until it's fixed · asks: fix the default branch's CI",
  ],
  [
    "estop-lane-swept",
    { worker: "w1", issue: 1, confirmedDead: true },
    "Lane w1's driving work was killed by EMERGENCY STOP · asks: check for an orphan process and confirm the PR's state",
  ],
  [
    "estop-lane-swept",
    { worker: "w1", issue: 1, confirmedDead: false },
    "Lane w1's driving work was killed by EMERGENCY STOP — the process couldn't be confirmed dead · asks: check for an orphan process and confirm the PR's state",
  ],
  [
    "estop-lane-sweep-incapable",
    { worker: "w1", issue: 1 },
    "Lane w1's EMERGENCY STOP sweep couldn't verify or signal its process — left unsettled · asks: check the lane by hand",
  ],
  [
    "resume-capped",
    { worker: "w1", issue: 1, attempts: 3 },
    "Lane w1 exhausted its resume attempts (3) after a handoff · asks: resume or reassign the lane by hand",
  ],
  [
    "resume-capped",
    { worker: "w1", issue: 1 },
    "Lane w1 exhausted its resume attempts after a handoff · asks: resume or reassign the lane by hand",
  ],
  [
    "resume-undecidable",
    { worker: "w1", issue: 1 },
    "Lane w1's resume outcome couldn't be determined from the ledger · asks: check the lane by hand and decide whether to resume",
  ],
  [
    "orphan-pr-escalated",
    { pr: 10, issue: 1, worker: "w1", via: "open-engine-pr" },
    "PR #10 is open but lane w1 is dead (open-engine-pr) · asks: check the PR and decide whether to retry the issue",
  ],
  [
    "gated-flag-unprovable",
    { worker: "w1", issue: 1 },
    "Lane w1's reentry flag couldn't be found on either carrier · asks: check issue #1's labels by hand",
  ],
  [
    "drive-human-merge-only",
    { pr: 10, issue: 1 },
    "PR #10 is ready but requires a human to merge it — a one-way, never re-decided policy · asks: review and merge by hand",
  ],
  [
    "fix-leg-dispatch-unconfigured",
    { pr: 10, issue: 1 },
    "PR #10 needs a fix leg but the fix loop isn't configured for this run · asks: enable the fix loop or fix the PR by hand",
  ],
  [
    "fix-leg-undecidable",
    { pr: 10, issue: 1 },
    "PR #10's fix leg outcome couldn't be determined from the ledger · asks: check the lane and decide the PR's next step",
  ],
  [
    "fix-thread-write-escalated",
    { pr: 10, issue: 1 },
    "PR #10 has a review-thread reply/resolve that couldn't be posted after retrying · asks: check the review thread by hand",
  ],
  [
    "ac-snapshot-drift",
    { pr: 10, issue: 1 },
    "PR #10's issue body changed after its acceptance criteria were captured · asks: confirm the PR still matches the issue, or re-snapshot",
  ],
  [
    "review-silence-escalated",
    { pr: 10, issue: 1, silenceSec: 600 },
    "PR #10's review request went unanswered for 10m · asks: check the reviewer and prompt or reassign the review",
  ],
  [
    "review-silence-escalated",
    { pr: 10, issue: 1 },
    "PR #10's review request went unanswered · asks: check the reviewer and prompt or reassign the review",
  ],
  [
    "review-disputed",
    { pr: 10, issue: 1, worker: "w1" },
    "PR #10 — successive reviews disagreed past the dispute limit · asks: adjudicate which review is right",
  ],
  [
    "review-non-convergent",
    { pr: 10, issue: 1, worker: "w1" },
    "PR #10 — fix-and-review rounds failed to converge · asks: adjudicate — re-ready or close manually",
  ],
  [
    "comment-cursor-stale",
    { issue: 1 },
    "Issue #1's comment thread moved since the engine last read it, so it refused to spend/dispatch/drive · asks: review the comment thread — this clears once the engine re-reads it",
  ],
  [
    "round-pool-removal-capped",
    { issue: 1 },
    "Issue #1's round-pool label couldn't be removed after retrying · asks: remove the label by hand",
  ],
  [
    "concern-post-escalated",
    { issue: 1 },
    "Issue #1's PO concern couldn't be posted after retrying · asks: check the issue and post the concern by hand",
  ],
  [
    "operator-fence-violated",
    { issue: 1 },
    "Issue #1's body edit was refused — it touched an operator-owned section · asks: review the proposed edit and the operator fence by hand",
  ],
  [
    "architect-repeat-drop-escalated",
    { issue: 1 },
    "Issue #1 was dropped repeatedly for the same reason with no edit in between · asks: revise the issue or adjudicate the repeated drop",
  ],
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

// ── #881: payload audit — every attention kind carries a reason clause + ask, or names the gap ─
//
// The issue's own AC1: "Every attention: true COPY entry either carries a reason clause + ask in
// its sentence, or the payload gap blocking it is named explicitly (not silently absent)." This
// is an INDEPENDENT enumeration of every kind that ever carries `attention` (not derived from
// `ATTENTION_CATEGORY` or `COPY` itself, same "the map is the count" discipline `DOC_TABLE_KINDS`
// above applies) — each rendered with a representative payload and asserted to contain both an
// explicit "asks:" clause and a reason segment, where an unrecorded reason renders as the literal
// "reason not recorded" (the named-gap disclosure for the kinds the payload audit found lack a
// reason field upstream: `drive-no-pr`, `verify-na-proposed`, `worktree-retained`, and the
// optional-reason branches of `reclaim-done`/`reclaim-failed`).
const ATTENTION_KINDS_SAMPLE: [kind: EventKind, payload: Record<string, unknown>][] = [
  ["drive-needs-human", { pr: 1, issue: 1 }],
  ["drive-no-pr", { worker: "w1" }],
  ["reclaim-done", { worker: "w1", next: "ESCALATE_NOPR" }],
  ["reclaim-failed", { worker: "w1" }],
  ["fix-rounds-capped", { pr: 1, issue: 1 }],
  ["fix-leg-verdict-rerun", { pr: 1, issue: 1 }],
  ["ceiling-escalated", {}],
  ["rollback-escalated", { issue: 1 }],
  ["worktree-retained", { worker: "w1" }],
  ["env-failure-preserved", { worker: "w1" }],
  ["park-escalated", {}],
  ["plan-review-escalated", { issue: 1 }],
  ["verify-na-proposed", { issue: 1 }],
  ["gated-reentry-capped", { issue: 1 }],
  ["gated-reentry-capped-label-failed", { issue: 1 }],
  ["ci-inert-escalated", { pr: 1, issue: 1 }],
  ["ci-pending-escalated", { pr: 1, issue: 1 }],
  // #893 additions.
  ["emergency-stop", {}],
  // Pre-existing COPY entries, promoted to attention:true by #893's owner adjudication (the
  // §7 doc row's own note on why) rather than newly mapped.
  ["rapid-restart-detected", { births: 3, windowSec: 60 }],
  ["idle-churn-detected", { rounds: 3 }],
  ["consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3 }],
  ["empty-spin-park", {}],
  ["base-ci-red-escalated", { sha: "abc", branch: "main", failing: ["lint"] }],
  ["estop-lane-swept", { worker: "w1", issue: 1, confirmedDead: true }],
  ["estop-lane-sweep-incapable", { worker: "w1", issue: 1 }],
  ["resume-capped", { worker: "w1", issue: 1, attempts: 3 }],
  ["resume-undecidable", { worker: "w1", issue: 1 }],
  ["orphan-pr-escalated", { pr: 1, issue: 1, worker: "w1", via: "open-engine-pr" }],
  ["gated-flag-unprovable", { worker: "w1", issue: 1 }],
  ["drive-human-merge-only", { pr: 1, issue: 1 }],
  ["fix-leg-dispatch-unconfigured", { pr: 1, issue: 1 }],
  ["fix-leg-undecidable", { pr: 1, issue: 1 }],
  ["fix-thread-write-escalated", { pr: 1, issue: 1 }],
  ["ac-snapshot-drift", { pr: 1, issue: 1 }],
  ["review-silence-escalated", { pr: 1, issue: 1, silenceSec: 600 }],
  ["review-disputed", { pr: 1, issue: 1, worker: "w1" }],
  ["review-non-convergent", { pr: 1, issue: 1, worker: "w1" }],
  ["comment-cursor-stale", { issue: 1 }],
  ["round-pool-removal-capped", { issue: 1 }],
  ["concern-post-escalated", { issue: 1 }],
  ["operator-fence-violated", { issue: 1 }],
  ["architect-repeat-drop-escalated", { issue: 1 }],
];

test("AC1: every attention kind's sentence carries an explicit asks: clause", () => {
  for (const [kind, payload] of ATTENTION_KINDS_SAMPLE) {
    assert.equal(copyFor(kind)!.attention !== undefined, true, `${kind} is expected to be an attention kind`);
    assert.match(render(kind, payload), /asks: /, `${kind} should render an explicit "asks:" clause`);
  }
});

test("AC1: every attention kind's sentence either states a reason or names the payload gap ('reason not recorded')", () => {
  for (const [kind, payload] of ATTENTION_KINDS_SAMPLE) {
    const rendered = render(kind, payload);
    const hasReasonNotRecorded = rendered.includes("reason not recorded");
    // The sentence is more than JUST the kind's bare fact + the asks: clause — i.e. it isn't a
    // string that would be identical with no reason clause segment at all. Every entry above
    // either includes the literal "reason not recorded" disclosure or a non-empty reason drawn
    // from the sample payload/hardcoded reason text (asserted per-kind by SENTENCE_ORACLE).
    assert.ok(
      hasReasonNotRecorded || rendered.length > `PR #1 needs a human — asks: `.length,
      `${kind} should carry a reason clause or the explicit "reason not recorded" gap disclosure`,
    );
  }
});

test("AC1: ATTENTION_KINDS_SAMPLE is an independent, exhaustive transcription of every attention kind", () => {
  const covered = new Set(ATTENTION_KINDS_SAMPLE.map(([kind]) => kind));
  const attentionKinds = new Set(EVENT_KINDS.filter((k) => copyFor(k)!.attention !== undefined));
  assert.deepEqual(covered, attentionKinds);
});

// ── PR #900 gate② finding [1] (attention-strip-wiring-proof, second half): the tests above
// derive their "exhaustive attention set" from `ATTENTION_KINDS_SAMPLE`/`COPY` — a purely
// dashboard-internal cross-check that would stay green even if the mapping itself simply forgot a
// kind the ENGINE marks urgent. This drift-guards against the engine's own authoritative registry
// field (`actionability`, event-kinds/types.ts) instead — the same "authoritative signal over
// dashboard prose" doctrine the `ESCALATION_SOURCE_KINDS` drift guard above already applies, one
// level up: `actionability: "intervene"` is the broader, editorial-judgment-free "a human owes
// the next decision" signal (types.ts's own doc), a strict superset of `escalation-source:*`. ──

test('#900 finding [1]: every engine-registered `actionability: "intervene"` kind carries `attention` in COPY — a registry-anchored floor, not just an internal COPY cross-check', () => {
  for (const kind of ENGINE_EVENT_KIND_NAMES) {
    if (kindGlossary(kind).actionability !== "intervene") continue;
    assert.notEqual(
      copyFor(kind)?.attention,
      undefined,
      `${kind} is actionability:"intervene" in the engine's own registry but carries no attention marker in COPY`,
    );
  }
});

// ── #881: category-chip taxonomy completeness ───────────────────────────────────────────────

test("every attention-marked kind has exactly one category chip, and no non-attention kind has one", () => {
  for (const kind of EVENT_KINDS) {
    if (copyFor(kind)!.attention !== undefined) {
      assert.ok(ATTENTION_CATEGORY[kind], `${kind} carries attention but has no ATTENTION_CATEGORY entry`);
    } else {
      assert.equal(ATTENTION_CATEGORY[kind], undefined, `${kind} carries no attention marker but has a category chip`);
    }
  }
});

test("attentionCategory returns undefined for an unrecognized kind, never a fabricated label", () => {
  assert.equal(attentionCategory("some-future-kind-nobody-registered-yet"), undefined);
});

// ── #891: the strip summary line's "dissent" signal ───────────────────────────────────────────

test("isDissentSignal names exactly the kinds ATTENTION_CATEGORY classifies DISSENT — never a second, independently guessed list", () => {
  assert.equal(isDissentSignal("review-disputed"), true);
  assert.equal(isDissentSignal("review-non-convergent"), true);
  // #891 gate① engine-agent finding [2] (ac3-dissent-counts-wrong-events): this kind is
  // classified FIX CAP by this SAME map, not DISSENT — a prior version of `isDissentSignal`
  // wrongly counted it, so a strip row carrying a real DISSENT chip reported 0 dissent while an
  // unrelated FIX CAP row inflated the count.
  assert.equal(isDissentSignal("fix-leg-verdict-rerun"), false);
  assert.equal(isDissentSignal("drive-needs-human"), false);
  assert.equal(isDissentSignal("fix-rounds-capped"), false);
  assert.equal(isDissentSignal("some-future-kind-nobody-registered-yet"), false);
});

test("#893: REVIEW SILENCE and DISSENT chips exist for their named kinds, per the mockup's own taxonomy", () => {
  assert.equal(attentionCategory("review-silence-escalated"), "REVIEW SILENCE");
  assert.equal(attentionCategory("review-disputed"), "DISSENT");
  assert.equal(attentionCategory("review-non-convergent"), "DISSENT");
});

// ── #893: cross-package exhaustiveness — every REAL engine-registered kind is classified ───────
//
// AC1's own text: "a registered kind with neither copy entry nor telemetry classification is a
// build/test failure (red-first proof required)." `ENGINE_EVENT_KIND_NAMES` is the engine's own
// registry (test-only import, same precedent as `ESCALATION_SOURCE_KINDS` above) — the oracle,
// not a re-transcription of `EventKind` itself, so a kind added to the engine and forgotten here
// reddens this test rather than silently compiling. Mutation-kill: remove any one member from
// `COPY`/`TELEMETRY_KINDS` in copy.ts and its now-unclassified kind fails the loop below.

test("#893: every engine-registered kind is classified as EITHER a COPY entry OR a TELEMETRY_KINDS member — never neither, never both", () => {
  for (const kind of ENGINE_EVENT_KIND_NAMES) {
    const narrative = Object.hasOwn(COPY, kind);
    const telemetry = TELEMETRY_KINDS.has(kind);
    assert.ok(narrative || telemetry, `${kind} is registered by the engine but classified as neither narrative nor telemetry`);
    assert.ok(!(narrative && telemetry), `${kind} is classified as BOTH narrative and telemetry — pick one`);
  }
});

test("#893: COPY and TELEMETRY_KINDS contain no kind absent from the engine's own registry", () => {
  const engineKinds = new Set<string>(ENGINE_EVENT_KIND_NAMES);
  for (const kind of EVENT_KINDS) {
    assert.ok(engineKinds.has(kind), `COPY has a narrative entry for "${kind}", which the engine does not register`);
  }
  for (const kind of TELEMETRY_KINDS) {
    assert.ok(engineKinds.has(kind), `TELEMETRY_KINDS lists "${kind}", which the engine does not register`);
  }
});

test("#893: heartbeat kinds classify as telemetry, render an honest generic line, and never the raw fallback", () => {
  for (const kind of ["worker-heartbeat", "role-session-heartbeat", "park-wait-heartbeat", "standby-heartbeat"] as const) {
    assert.ok(TELEMETRY_KINDS.has(kind), `${kind} should be telemetry-tier`);
    assert.ok(isKnownKind(kind), `${kind} should be a known kind (never the raw "Unrecognized event" fallback)`);
    const entry = copyFor(kind);
    assert.equal(entry?.tier, "telemetry");
    assert.equal(entry?.sentence({}).join(""), `Telemetry: ${kind}`);
    assert.equal(hasAttention(kind, {}), false, `${kind} is telemetry, never attention`);
  }
});

test("#893: a telemetry kind is never also a COPY (narrative) key", () => {
  for (const kind of TELEMETRY_KINDS) {
    assert.ok(!Object.hasOwn(COPY, kind), `${kind} is in TELEMETRY_KINDS but also has a COPY entry`);
  }
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
