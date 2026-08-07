import assert from "node:assert/strict";
import test from "node:test";
import type { LoopEvent } from "./api/types.ts";
import { foldEntityTitles } from "./entities.ts";

const event = (id: number, kind: string, payload: Record<string, unknown>): LoopEvent => ({
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
