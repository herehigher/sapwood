import assert from "node:assert/strict";
import { test } from "node:test";
import { labelsInclude, labelsIncludeAnySubstring, matchBlockedByLabel, matchPriorityLabel, normalizeLabel } from "./labels.js";

test("normalizeLabel trims and lowercases GitHub label names", () => {
  assert.equal(normalizeLabel("  Needs-Human "), "needs-human");
});

test("labelsInclude uses normalized exact membership", () => {
  assert.equal(labelsInclude(["Needs-Human", " type:Bug "], "needs-human"), true);
  assert.equal(labelsInclude(["needs-human-now"], "needs-human"), false);
});

test("labelsIncludeAnySubstring preserves normalized human-label substring semantics", () => {
  assert.equal(labelsIncludeAnySubstring(["SAPWOOD:NEEDS-HUMAN:URGENT"], ["sapwood:needs-human"]), true);
  assert.equal(labelsIncludeAnySubstring(["type:feature"], ["needs-human", "blocked"]), false);
});

test("priority and blocked-by matchers accept legacy and sapwood-prefixed case variants", () => {
  assert.equal(matchPriorityLabel("PRIO:2-high"), 2);
  assert.equal(matchPriorityLabel("Sapwood:Prio:3"), 3);
  assert.equal(matchPriorityLabel("sapwood:prio:00"), null);
  assert.equal(matchBlockedByLabel("BLOCKED-BY:#5"), 5);
  assert.equal(matchBlockedByLabel("Sapwood:Blocked-By:17"), 17);
  assert.equal(matchBlockedByLabel("sapwood:blocked-by:nope"), null);
});
