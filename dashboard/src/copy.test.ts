import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// Test-only import (same pattern as config-captions.test.ts's CONFIG_ALLOWLIST cross-check): the
// engine's own tagged registry is the AUTHORITATIVE attention-membership signal, not frontend-
// design.md §3's prose list, which has already drifted once (finding [2] below).
import { ESCALATION_SOURCE_KINDS } from "../../engine/src/loop/escalation-reconcile.ts";
import { COPY, copyFor, EVENT_KINDS, type EventKind, hasAttention, type SentencePart } from "./copy.ts";

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
