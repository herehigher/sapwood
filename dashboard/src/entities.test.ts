import assert from "node:assert/strict";
import test from "node:test";
import type { LoopEvent } from "./api/types.ts";
import type { EventKind } from "./copy.ts";
import { foldEntityTitles, foldOpenAttention } from "./entities.ts";

// `kind: EventKind`, not a bare `string` — #715 gate② round 4 [0], same rationale as
// ActivityFeed.test.tsx's `ev`.
const event = (id: number, kind: EventKind, payload: Record<string, unknown>): LoopEvent => ({
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
  const corrupt: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.doesNotThrow(() => foldEntityTitles([corrupt]));
  assert.deepEqual(foldEntityTitles([corrupt]), {});
});

test("foldEntityTitles: a null-payload row does not block a LATER real title from folding", () => {
  const corrupt: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
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
  const corrupt: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "drive-needs-human", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corrupt]));
  const open = foldOpenAttention([corrupt]);
  assert.equal(Object.keys(open).length, 1);
  assert.equal(Object.values(open)[0]?.kind, "drive-needs-human");
});

test("foldOpenAttention: a null-payload row for a routine (non-attention) kind is skipped without throwing", () => {
  const corrupt: LoopEvent = { id: 1, ts: "2026-08-06T00:00:00Z", kind: "dispatched", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corrupt]));
  assert.deepEqual(foldOpenAttention([corrupt]), {});
});

test("foldOpenAttention: a null-payload `escalation-resolved`/`worktree-released` row does not throw while sweeping open entries", () => {
  const open = foldOpenAttention([event(1, "drive-needs-human", { issue: 5, pr: 50 })]);
  const corruptResolve: LoopEvent = { id: 2, ts: "2026-08-06T00:00:01Z", kind: "escalation-resolved", payload: null };
  const corruptRelease: LoopEvent = { id: 3, ts: "2026-08-06T00:00:02Z", kind: "worktree-released", payload: null };
  assert.doesNotThrow(() => foldOpenAttention([corruptResolve, corruptRelease], open));
  // Neither corrupt row names anything to clear, so the original open entry survives.
  assert.equal(Object.keys(foldOpenAttention([corruptResolve, corruptRelease], open)).length, 1);
});
