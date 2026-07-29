import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMissingLabels,
  firstMatchingLabel,
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

test("firstMatchingLabel (#294): returns the matched label in its ON-PR casing, exact-match only — never a substring hit", () => {
  // The payload names the label a HUMAN applied, so the on-PR casing is what's reported back.
  assert.equal(firstMatchingLabel(["type:Bug", "Sapwood:Hold"], ["sapwood:hold"]), "Sapwood:Hold");
  assert.equal(firstMatchingLabel([], ["sapwood:hold"]), null);
  assert.equal(firstMatchingLabel(["type:feature"], ["sapwood:hold"]), null);
  // Same G3 hazards labelsIncludeAny is hardened against: a one-word or empty configured entry
  // must not match a label that merely CONTAINS it.
  assert.equal(firstMatchingLabel(["sapwood:hold"], ["sapwood"]), null);
  assert.equal(firstMatchingLabel(["sapwood:hold"], [""]), null);
  // Boolean-equivalent to labelsIncludeAny by construction — the one property the #248 gate
  // relies on when driveOne swaps one for the other.
  for (const labels of [[], ["sapwood:hold"], ["Sapwood:Hold"], ["type:feature"], ["sapwood:holding"]]) {
    assert.equal(firstMatchingLabel(labels, ["sapwood:hold"]) != null, labelsInclude(labels, "sapwood:hold"), labels.join(","));
  }
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

// ── #379 F1: label provisioning shared by `sapwood init` and the engine's startup reconcile ──

test("#379 createMissingLabels: creates only what the repo lacks (case-insensitive), returns the created names", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    return args[1] === "list" ? JSON.stringify([{ name: "Sapwood:In-Progress" }]) : "";
  };
  const created = await createMissingLabels(run, "o/r", [
    { name: "sapwood:in-progress", color: "0e8a16", description: "already there, differently cased" },
    { name: "sapwood:round:pool", color: "5319e7", description: "in this round's pool" },
  ]);
  assert.deepEqual(created, ["sapwood:round:pool"]);
  assert.deepEqual(calls, [
    ["label", "list", "--repo", "o/r", "--limit", "200", "--json", "name"],
    ["label", "create", "sapwood:round:pool", "--repo", "o/r", "--color", "5319e7", "--description", "in this round's pool"],
  ]);
});

test("#379 createMissingLabels: a lost list→create race ('already exists') is a no-op, not a failure", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[1] === "list") return "[]";
    throw Object.assign(new Error("gh failed"), { stderr: "HTTP 422: Validation Failed (label already exists)" });
  };
  assert.deepEqual(await createMissingLabels(run, "o/r", [{ name: "sapwood:split", color: "fbca04", description: "d" }]), []);
});

test("#379 createMissingLabels: a real create failure (no permission) propagates to the caller", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[1] === "list") return "[]";
    throw Object.assign(new Error("gh failed"), { stderr: "HTTP 403: Resource not accessible by integration" });
  };
  await assert.rejects(() => createMissingLabels(run, "o/r", [{ name: "sapwood:split", color: "fbca04", description: "d" }]), /gh failed/);
});
