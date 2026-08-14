import assert from "node:assert/strict";
import test from "node:test";
// Test-only import (same pattern as copy.test.ts's ESCALATION_SOURCE_KINDS cross-check): the
// engine's own tagged registry is the AUTHORITATIVE issue-scoped-clear signal, not an issue's own
// prose, which can name a kind the engine never actually tags this way.
import { CLEAR_KINDS } from "../../engine/src/loop/escalation-reconcile.ts";
import type { EventKind } from "./copy.ts";
import type { DomainEvent, KnownDomainEvent, UnknownDomainEvent } from "./domain-event.ts";
import { foldEntityTitles, foldOpenAttention, ISSUE_CLEAR_KINDS } from "./entities.ts";

// `kind: EventKind`, not a bare `string` — #715 gate② round 4 [0] / round 5 [0]: `entities.ts`
// consumes `DomainEvent`, so its fixtures are `KnownDomainEvent`s directly (the shape
// `domain-event.ts`'s `toDomainEvent` produces for any real, mapped wire kind), same rationale as
// ActivityFeed.test.tsx's `ev`.
const event = (id: number, kind: EventKind, payload: Record<string, unknown>): KnownDomainEvent => ({
  known: true,
  id,
  ts: new Date(2026, 0, 1, 0, 0, id).toISOString(),
  kind,
  payload,
});

test("dispatched folds the issue title", () => {
  const titles = foldEntityTitles([event(1, "dispatched", { issue: 86, issueTitle: "Fix the thing" })]);
  assert.equal(titles[86]?.issueTitle, "Fix the thing");
  assert.equal(titles[86]?.prTitle, undefined);
});

test("reclaim-done's PR-produced branch folds the PR title onto its issue", () => {
  const titles = foldEntityTitles([event(1, "reclaim-done", { issue: 86, next: "DRIVING", prTitle: "Add the widget" })]);
  assert.equal(titles[86]?.prTitle, "Add the widget");
});

test("merged folds the PR title onto its issue", () => {
  const titles = foldEntityTitles([event(1, "merged", { issue: 86, pr: 97, prTitle: "Add the widget" })]);
  assert.equal(titles[86]?.prTitle, "Add the widget");
});

test("keeps the FIRST title-bearing event, not a later one", () => {
  const titles = foldEntityTitles([
    event(1, "dispatched", { issue: 86, issueTitle: "Original title" }),
    event(2, "dispatch-failed", { issue: 86 }),
    event(3, "dispatched", { issue: 86, issueTitle: "Re-dispatched with a different title" }),
  ]);
  assert.equal(titles[86]?.issueTitle, "Original title");
});

test("folds in chronological order regardless of input array order", () => {
  const titles = foldEntityTitles([
    event(3, "merged", { issue: 86, pr: 97, prTitle: "later title" }),
    event(1, "reclaim-done", { issue: 86, next: "DRIVING", prTitle: "first title" }),
  ]);
  assert.equal(titles[86]?.prTitle, "first title");
});

test("an entity with no title-bearing event has no title", () => {
  const titles = foldEntityTitles([event(1, "plan-review-escalated", { issue: 86 })]);
  assert.equal(titles[86]?.issueTitle, undefined);
  assert.equal(titles[86]?.prTitle, undefined);
});

test("events with no issue number are skipped without throwing", () => {
  const titles = foldEntityTitles([event(1, "run-started", { config: {}, configHash: "x" })]);
  assert.deepEqual(titles, {});
});

// ── #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null`, never an object ──

test("foldEntityTitles: a null-payload row (corrupt legacy JSON) is skipped without throwing", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.doesNotThrow(() => foldEntityTitles([corrupt]));
  assert.deepEqual(foldEntityTitles([corrupt]), {});
});

test("foldEntityTitles: a null-payload row does not block a LATER real title from folding", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  const titles = foldEntityTitles([corrupt, event(2, "dispatched", { issue: 86, issueTitle: "Fix the thing" })]);
  assert.equal(titles[86]?.issueTitle, "Fix the thing");
});

// ── #715 gate② [0]: seeded, durable accumulation across calls ───────────────────────────────────

test("foldEntityTitles(events, seed) folds onto a prior result instead of starting over", () => {
  const first = foldEntityTitles([event(1, "dispatched", { issue: 86, issueTitle: "Fix the thing" })]);
  // A second call with a DIFFERENT (later) page of events, seeded with the first result, must
  // still know issue 86's title even though event 1 itself is nowhere in this second call's input
  // — exactly the shape `useEventHistory` needs once event 1 ages out of the bounded window.
  const second = foldEntityTitles([event(50, "dispatch-failed", { issue: 90 })], first);
  assert.equal(second[86]?.issueTitle, "Fix the thing");
  assert.equal(second[90]?.issueTitle, undefined);
});

test("foldEntityTitles never mutates its seed", () => {
  const seed = foldEntityTitles([event(1, "dispatched", { issue: 86, issueTitle: "Original" })]);
  const frozenCopy = JSON.parse(JSON.stringify(seed));
  foldEntityTitles([event(2, "dispatched", { issue: 86, issueTitle: "Should never apply — issue 86 already has a title" })], seed);
  assert.deepEqual(seed, frozenCopy);
});

test("foldEntityTitles(seed) still keeps the first title, even across two separate calls", () => {
  const first = foldEntityTitles([event(1, "dispatched", { issue: 86, issueTitle: "Original title" })]);
  const second = foldEntityTitles([event(2, "dispatched", { issue: 86, issueTitle: "A later re-dispatch title" })], first);
  assert.equal(second[86]?.issueTitle, "Original title");
});

// ── foldOpenAttention ────────────────────────────────────────────────────────────────────────

test("foldOpenAttention opens an entry for an attention-class event", () => {
  const open = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.id, 1);
});

test("foldOpenAttention ignores routine (non-attention) events", () => {
  const open = foldOpenAttention([event(1, "dispatched", { issue: 5 })]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention closes an entry when a matching (source, issue) escalation-resolved arrives", () => {
  const open = foldOpenAttention([
    event(1, "drive-needs-human", { issue: 5, pr: 50 }),
    event(2, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }),
  ]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention keeps a DIFFERENT open source on the same issue when only one source resolves", () => {
  const open = foldOpenAttention([
    event(1, "drive-needs-human", { issue: 5, pr: 50 }),
    event(2, "rollback-escalated", { issue: 5 }),
    event(3, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 }),
  ]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.kind, "rollback-escalated");
});

test("foldOpenAttention keys entity-less attention items (no issue) by kind alone, and never clears them here", () => {
  const open = foldOpenAttention([
    event(1, "ceiling-escalated", {}),
    event(2, "escalation-resolved", { issue: 9, source: "ceiling-escalated", via: "merged" }),
  ]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.kind, "ceiling-escalated");
});

test("foldOpenAttention(events, seed) is durable across calls — #715 gate② [0]'s core regression", () => {
  // An escalation opened in an EARLIER call (page 1) must still be open after a LATER call (page
  // 2) that never mentions it again — this is exactly what lets an open item survive past the
  // bounded display window's eviction.
  const afterPage1 = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  const afterPage2 = foldOpenAttention([event(2, "dispatched", { issue: 9 })], afterPage1);
  assert.equal(Object.keys(afterPage2).length, 1);
  assert.equal(Object.values(afterPage2)[0]?.kind, "drive-needs-human");

  // A THIRD call, arriving much later, resolves it — even though the original escalation event
  // itself was never part of this call's own input.
  const afterPage3 = foldOpenAttention(
    [event(3, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged", pr: 50 })],
    afterPage2,
  );
  assert.deepEqual(afterPage3, {});
});

test("foldOpenAttention overwrites an open entry with a NEWER occurrence of the same key", () => {
  const first = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  const second = foldOpenAttention([event(2, "drive-needs-human", { issue: 5, pr: 51 })], first);
  assert.equal(Object.keys(second).length, 1);
  assert.equal(Object.values(second)[0]?.id, 2);
});

test("foldOpenAttention never mutates its seed", () => {
  const seed = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  const frozenCopy = JSON.parse(JSON.stringify(seed));
  foldOpenAttention([event(2, "escalation-resolved", { issue: 5, source: "drive-needs-human", via: "merged" })], seed);
  assert.deepEqual(seed, frozenCopy);
});

// ── #715 gate② round 3 [1]: the rest of §3's documented clearing transitions ────────────────────

test("foldOpenAttention: a later `dispatched` for the same issue clears an open ceiling-escalated", () => {
  const open = foldOpenAttention([event(1, "ceiling-escalated", { worker: "w1", issue: 5 }), event(2, "dispatched", { issue: 5 })]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention: a later `merged` for the same issue clears an open env-failure-preserved", () => {
  const open = foldOpenAttention([event(1, "env-failure-preserved", { worker: "w1", issue: 5 }), event(2, "merged", { issue: 5, pr: 50 })]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention: `gated-reentry` and `lane-revived` also clear open issue-scoped attention", () => {
  const gatedReentry = foldOpenAttention([event(1, "gated-reentry-capped", { issue: 5 }), event(2, "gated-reentry", { issue: 5 })]);
  assert.deepEqual(gatedReentry, {});

  const laneRevived = foldOpenAttention([
    event(1, "env-failure-preserved", { worker: "w1", issue: 5 }),
    event(2, "lane-revived", { issue: 5 }),
  ]);
  assert.deepEqual(laneRevived, {});
});

// #739 gate② round 1 finding [0] (ac4-missing-clear-kinds) asked for `pr-released` and
// `plan-approved` to join ISSUE_CLEAR_KINDS, quoting the issue's own AC text. This drift guard is
// the disputed reply's actual evidence: the engine's own `escalation-clear` tag — the tag
// `CLEAR_KINDS` is derived from (escalation-reconcile.ts), and the SAME authoritative-registry
// pattern `copy.test.ts` already uses for `ESCALATION_SOURCE_KINDS` — carries neither kind
// (`drive.ts`'s `pr-released` and `governance.ts`'s `plan-approved` are both `tags: []`, routine
// bookkeeping, not `escalation-clear`). Widening ISSUE_CLEAR_KINDS to match the issue's prose
// instead of the engine's own tagged ground truth would make the dashboard's strip clear ITSELF
// on events the engine never designed as resolution signals — the opposite of a fix. If the
// engine ever DOES tag either kind `escalation-clear`, this test goes red and says so.
test("#739: ISSUE_CLEAR_KINDS matches the engine's own escalation-clear tag exactly — neither `pr-released` nor `plan-approved` belongs, despite the issue text naming them", () => {
  assert.deepEqual([...ISSUE_CLEAR_KINDS].sort(), [...CLEAR_KINDS].sort());
  assert.ok(!ISSUE_CLEAR_KINDS.has("pr-released"), "pr-released carries tags: [] in drive.ts — routine, not escalation-clear");
  assert.ok(!ISSUE_CLEAR_KINDS.has("plan-approved"), "plan-approved carries tags: [] in governance.ts — routine, not escalation-clear");
});

test("foldOpenAttention: an issue-clear event never touches a DIFFERENT issue's open attention", () => {
  const open = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 }), event(2, "dispatched", { issue: 9 })]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.payload?.issue, 5);
});

test("foldOpenAttention: the same-operation exemption — a merge never clears the rollback-escalated it itself produced", () => {
  const open = foldOpenAttention([
    event(1, "merged", { issue: 5, pr: 50 }),
    event(2, "rollback-escalated", { issue: 5, reason: "merged-board-done" }),
  ]);
  // The `rollback-escalated` is appended AFTER `merged` in this exact scenario (conductor.ts's
  // merge path posts the rollback escalation before its OWN merged event in real ordering, but
  // the exemption must hold regardless of arrival order — a later, UNRELATED merged for the same
  // issue must still not accidentally launder this specific reason away).
  const laterMerge = foldOpenAttention([event(3, "merged", { issue: 5, pr: 51 })], open);
  assert.equal(Object.keys(laterMerge).length, 1, "the same-reason rollback-escalated must survive a later merged for its issue");
});

test("foldOpenAttention: a merge WITHOUT the merged-board-done reason clears normally (the exemption is narrow)", () => {
  const open = foldOpenAttention([
    event(1, "rollback-escalated", { issue: 5, reason: "some-other-reason" }),
    event(2, "merged", { issue: 5, pr: 50 }),
  ]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention: `park-resumed` clears the open park-escalated entry", () => {
  const open = foldOpenAttention([event(1, "park-escalated", { source: "llm" }), event(2, "park-resumed", {})]);
  assert.deepEqual(open, {});
});

// ── PR #900 gate② finding [0] (stale-breaker-attention): a real episode for one of the
// probe-less breakers appends BOTH its own `*-detected` event and a `park-escalated{source}`
// companion (rapid-restart.ts's `escalateLocally`, same tick) — these must collapse to ONE open
// attention row, not two, and the matching `park-resumed{source}` receipt must close it. ────────

test("foldOpenAttention: a rapid-restart episode's `*-detected` + `park-escalated` companion collapse to ONE open row, not two", () => {
  const open = foldOpenAttention([
    event(1, "rapid-restart-detected", { births: 3, windowSec: 60, maxBirths: 3 }),
    event(2, "park-escalated", { source: "rapid-restart", channel: "local", triggerIssue: null }),
  ]);
  assert.equal(Object.keys(open).length, 1, "one park episode must never open two strip rows");
  assert.equal(Object.values(open)[0]?.kind, "rapid-restart-detected");
});

test("foldOpenAttention: `park-resumed{source: rapid-restart}` closes the rapid-restart-detected row", () => {
  const open = foldOpenAttention([
    event(1, "rapid-restart-detected", { births: 3, windowSec: 60, maxBirths: 3 }),
    event(2, "park-escalated", { source: "rapid-restart", channel: "local", triggerIssue: null }),
    event(3, "park-resumed", { source: "rapid-restart", via: "restart-window-clear" }),
  ]);
  assert.deepEqual(open, {}, "the resolution receipt must close the row the detection event opened");
});

test("foldOpenAttention: a consecutive-stalls episode collapses to one row and clears on its own park-resumed source", () => {
  const opened = foldOpenAttention([
    event(1, "consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-08-01T00:00:00Z" }),
    event(2, "park-escalated", { source: "consecutive-stalls", channel: "local", triggerIssue: null }),
  ]);
  assert.equal(Object.keys(opened).length, 1);
  const closed = foldOpenAttention([event(3, "park-resumed", { source: "consecutive-stalls", via: "operator-clear" })], opened);
  assert.deepEqual(closed, {});
});

test("foldOpenAttention: an idle-churn episode collapses to one row and clears on its own park-resumed source", () => {
  const opened = foldOpenAttention([
    event(1, "idle-churn-detected", { rounds: 3 }),
    event(2, "park-escalated", { source: "idle-churn", channel: "local", triggerIssue: null }),
  ]);
  assert.equal(Object.keys(opened).length, 1);
  const closed = foldOpenAttention([event(3, "park-resumed", { source: "idle-churn" })], opened);
  assert.deepEqual(closed, {});
});

test("foldOpenAttention: an empty-spin episode's `empty-spin-park` + its `park-escalated{source: llm}` companion collapse to ONE row, cleared by park-resumed{source: llm}", () => {
  const opened = foldOpenAttention([
    event(1, "empty-spin-park", { consecutiveDegradedRounds: 3, threshold: 3, roundId: 7 }),
    event(2, "park-escalated", { source: "llm", channel: "local", triggerIssue: null }),
  ]);
  assert.equal(Object.keys(opened).length, 1, "empty-spin-park and its shared-llm-source park-escalated must not double up");
  assert.equal(Object.values(opened)[0]?.kind, "empty-spin-park");
  const closed = foldOpenAttention([event(3, "park-resumed", { source: "llm", via: "role-session" })], opened);
  assert.deepEqual(closed, {});
});

test("foldOpenAttention: an ORDINARY llm env-failure park-escalated (no empty-spin open) still opens its own row and clears normally — the dedup is narrow, not a blanket llm suppression", () => {
  const open = foldOpenAttention([
    event(1, "park-escalated", { source: "llm", channel: "local", triggerIssue: null }),
    event(2, "park-resumed", { source: "llm" }),
  ]);
  assert.deepEqual(open, {});
  // And without the resume, it stays open on its own — proving it really did open (not silently
  // suppressed because "llm" also happens to be empty-spin's shared source).
  const stillOpen = foldOpenAttention([event(1, "park-escalated", { source: "llm", channel: "local", triggerIssue: null })]);
  assert.equal(Object.keys(stillOpen).length, 1);
});

test("foldOpenAttention: rapid-restart's park-escalated companion never clears an UNRELATED still-open consecutive-stalls episode", () => {
  const open = foldOpenAttention([
    event(1, "consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-08-01T00:00:00Z" }),
    event(2, "park-escalated", { source: "consecutive-stalls", channel: "local", triggerIssue: null }),
    event(3, "rapid-restart-detected", { births: 3, windowSec: 60, maxBirths: 3 }),
    event(4, "park-escalated", { source: "rapid-restart", channel: "local", triggerIssue: null }),
    event(5, "park-resumed", { source: "rapid-restart", via: "restart-window-clear" }),
  ]);
  assert.equal(Object.keys(open).length, 1, "the still-open consecutive-stalls episode must survive an unrelated source's resume");
  assert.equal(Object.values(open)[0]?.kind, "consecutive-stalls-detected");
});

// ── PR #900 gate② finding [0]: emergency-stop has no probe/resume lifecycle of its own (#293 —
// an immediate hard stop, never a park episode) — the next successful `run-started` is the
// natural "someone dealt with it and the engine is back" signal, so that's what clears it. ──────

test("foldOpenAttention: emergency-stop opens a global attention row", () => {
  const open = foldOpenAttention([event(1, "emergency-stop", {})]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.kind, "emergency-stop");
});

test("foldOpenAttention: a later `run-started` clears an open emergency-stop row", () => {
  const open = foldOpenAttention([event(1, "emergency-stop", {}), event(2, "run-started", {})]);
  assert.deepEqual(open, {});
});

test("foldOpenAttention: `worktree-released` clears the worktree-retained entry sharing its worktreePath, keyed by path not issue", () => {
  const open = foldOpenAttention([
    event(1, "worktree-retained", { worker: "w1", issue: 5, worktreePath: "/data/worktrees/w1-issue5" }),
    // A DIFFERENT dispatch for the SAME issue number reusing the lane slot must NOT clear the
    // still-retained folder — §3's own reason keying by worktreePath exists to prevent this.
    event(2, "dispatched", { issue: 5 }),
  ]);
  assert.equal(Object.keys(open).length, 1, "an unrelated dispatch on the same issue must not clear a retained worktree");

  const released = foldOpenAttention(
    [event(3, "worktree-released", { worker: "w1", issue: 5, worktreePath: "/data/worktrees/w1-issue5" })],
    open,
  );
  assert.deepEqual(released, {});
});

// ── #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null`, never an object ──

test("foldOpenAttention: a null-payload row (corrupt legacy JSON) never throws — an unconditional-attention kind still opens, keyed by kind alone (no issue to key by)", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "drive-needs-human", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corrupt]));
  const open = foldOpenAttention([corrupt]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.kind, "drive-needs-human");
});

test("foldOpenAttention: a null-payload row for a routine (non-attention) kind is skipped without throwing", () => {
  const corrupt: KnownDomainEvent = { known: true, id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corrupt]));
  assert.deepEqual(foldOpenAttention([corrupt]), {});
});

test("foldOpenAttention: a null-payload `escalation-resolved`/`worktree-released` row does not throw while sweeping open entries", () => {
  const open = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  const corruptResolve: KnownDomainEvent = { known: true, id: 2, ts: "2026-08-06T00:00:01Z", kind: "escalation-resolved", payload: null };
  const corruptRelease: KnownDomainEvent = { known: true, id: 3, ts: "2026-08-06T00:00:02Z", kind: "worktree-released", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corruptResolve, corruptRelease], open));
  // Neither corrupt row names anything to clear, so the original open entry survives.
  assert.equal(Object.keys(foldOpenAttention([corruptResolve, corruptRelease], open)).length, 1);
});

// ── #715 gate② round 5 [0]: an UnknownDomainEvent (a wire kind newer than this client's copy map)
//    flows through the same folds harmlessly — never attention, never clears anything, never throws.

test("foldEntityTitles: an unknown-kind event with an `issue` payload field still folds normally (title-folding never checked kind)", () => {
  const unknown: UnknownDomainEvent = {
    known: false,
    id: 1,
    ts: "2026-08-06T00:00:00Z",
    kind: "a-kind-from-a-newer-engine",
    payload: { issue: 86, issueTitle: "Fix the thing" },
  };
  const titles = foldEntityTitles([unknown]);
  assert.equal(titles[86]?.issueTitle, "Fix the thing");
});

test("foldOpenAttention: an unknown-kind event never opens an attention entry (hasAttention is false for any unmapped kind)", () => {
  const unknown: DomainEvent = {
    known: false,
    id: 1,
    ts: "2026-08-06T00:00:00Z",
    kind: "a-kind-from-a-newer-engine",
    payload: { issue: 5 },
  };
  assert.doesNotThrow(() => foldOpenAttention([unknown]));
  assert.deepEqual(foldOpenAttention([unknown]), {});
});
