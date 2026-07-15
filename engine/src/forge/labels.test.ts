import assert from "node:assert/strict";
import { test } from "node:test";
import {
  labelsInclude,
  labelsIncludeAnySubstring,
  matchBlockedByLabel,
  matchPriorityLabel,
  normalizeLabel,
  SAPWOOD_LABEL_PREFIX,
  taxonomyLabels,
  workflowLabelDefaults,
} from "./labels.js";

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

test("workflow and taxonomy defaults derive from the normalized configured prefix", () => {
  assert.equal(workflowLabelDefaults("TEAM:").needsHuman, "team:needs-human");
  assert.equal(taxonomyLabels("TEAM:")[0]?.name, "team:type:feature");
  assert.equal(workflowLabelDefaults("").needsHuman, "needs-human");
  assert.equal(taxonomyLabels("")[0]?.name, "type:feature");
});

test("priority and blocked-by matchers accept only the configured prefix", () => {
  assert.equal(matchPriorityLabel("PRIO:2-high", SAPWOOD_LABEL_PREFIX), null);
  assert.equal(matchPriorityLabel("Sapwood:Prio:3", SAPWOOD_LABEL_PREFIX), 3);
  assert.equal(matchPriorityLabel("PRIO:2-high", ""), 2);
  assert.equal(matchPriorityLabel("sapwood:prio:00", SAPWOOD_LABEL_PREFIX), null);
  assert.equal(matchBlockedByLabel("BLOCKED-BY:#5", SAPWOOD_LABEL_PREFIX), null);
  assert.equal(matchBlockedByLabel("Sapwood:Blocked-By:17", SAPWOOD_LABEL_PREFIX), 17);
  assert.equal(matchBlockedByLabel("BLOCKED-BY:#5", ""), 5);
  assert.equal(matchBlockedByLabel("sapwood:blocked-by:nope", SAPWOOD_LABEL_PREFIX), null);
});
