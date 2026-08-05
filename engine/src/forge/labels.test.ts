import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMissingLabels,
  firstMatchingLabel,
  holdLabelDefault,
  LABEL_SEMANTICS,
  type LabelRegistryKey,
  type LabelSemantics,
  labelsInclude,
  labelsIncludeAnySubstring,
  matchBlockedByLabel,
  matchPriorityLabel,
  normalizeLabel,
  type ResolvedLabelsForSkill,
  renderLabelsSkillBody,
  resolveLabelSkillRows,
  SAPWOOD_LABEL_PREFIX,
  TAXONOMY_SPECS,
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

// ── #640: typed per-label semantics registry ─────────────────────────────────────────────────

function resolvedLabelsForSkill(prefix: string): ResolvedLabelsForSkill {
  const defaults = workflowLabelDefaults(prefix);
  return {
    labels: { ...defaults, prefix },
    escalation: { holdLabels: [holdLabelDefault(prefix)], humanLabels: [defaults.needsHuman, defaults.blocked] },
  };
}

test("registry: every LABEL_SEMANTICS entry carries a non-empty writer, remover, and gates", () => {
  for (const [key, entry] of Object.entries(LABEL_SEMANTICS)) {
    assert.ok(entry.writer.trim().length > 0, `"${key}" is missing a writer`);
    assert.ok(entry.remover.trim().length > 0, `"${key}" is missing a remover`);
    assert.ok(entry.gates.trim().length > 0, `"${key}" is missing a gates description`);
  }
});

// #640 AC1: "removing any label's registry entry is a type error, not a runtime gap (pinned by a
// type-level test fixture)". Checked by `npm run typecheck` (tsconfig.typecheck.json, #403 — NO
// exclusions, so a `@ts-expect-error` directive inside a `.test.ts` file is REAL, CI-visible
// enforcement, same shape as event-kinds.test.ts's own `defineKinds` fixture). Omitting a single
// key from a `Record<LabelRegistryKey, LabelSemantics>` must not compile.
const { hold: _omittedHold, ...labelSemanticsMissingHold } = LABEL_SEMANTICS;
// @ts-expect-error — omitting "hold" from the registry must not satisfy Record<LabelRegistryKey, LabelSemantics>.
const _typeLevelExhaustivenessFixture: Record<LabelRegistryKey, LabelSemantics> = labelSemanticsMissingHold;

test("#640 cross-check: every label produced by workflowLabelDefaults/TAXONOMY_SPECS/hold defaults appears in the rendered skill exactly once", () => {
  const prefix = "sapwood:";
  const cfg = resolvedLabelsForSkill(prefix);
  const body = renderLabelsSkillBody(cfg);
  const expectedNames = [
    ...Object.values(workflowLabelDefaults(prefix)),
    ...taxonomyLabels(prefix).map((s) => s.name),
    holdLabelDefault(prefix),
  ];
  assert.equal(new Set(expectedNames).size, expectedNames.length, "fixture sanity: no duplicate expected names");
  for (const name of expectedNames) {
    const marker = `\`${name}\``;
    const occurrences = body.split(marker).length - 1;
    assert.equal(occurrences, 1, `"${name}" must appear exactly once in the rendered skill, got ${occurrences}`);
  }
});

test("#640 cross-check: resolveLabelSkillRows covers exactly the workflow + taxonomy + hold label set, no more, no fewer", () => {
  const rows = resolveLabelSkillRows(resolvedLabelsForSkill("sapwood:"));
  assert.equal(rows.length, Object.keys(workflowLabelDefaults("sapwood:")).length + TAXONOMY_SPECS.length + 1);
  const keys = new Set(rows.map((r) => r.key));
  for (const key of Object.keys(workflowLabelDefaults("sapwood:"))) assert.ok(keys.has(key as LabelRegistryKey), key);
  for (const spec of TAXONOMY_SPECS) assert.ok(keys.has(spec.name), spec.name);
  assert.ok(keys.has("hold"));
});

test("#640 prefix-remap: a nondefault labels.prefix renders the skill with RESOLVED names throughout, no default-name leakage", () => {
  const prefix = "acme:";
  const cfg = resolvedLabelsForSkill(prefix);
  const body = renderLabelsSkillBody(cfg);
  assert.ok(body.includes("`acme:needs-human`"));
  assert.ok(body.includes("`acme:type:feature`"));
  assert.ok(body.includes("`acme:hold`"));
  assert.ok(!body.includes("sapwood:"), "no default sapwood: prefix may leak into a remapped render");
});

test("#640 prefix-remap: the bare (empty) prefix resolves to unprefixed names", () => {
  const cfg = resolvedLabelsForSkill("");
  const body = renderLabelsSkillBody(cfg);
  assert.ok(body.includes("`needs-human`"));
  assert.ok(body.includes("`type:feature`"));
  assert.ok(!body.includes("sapwood:"));
});

test("#640 renderLabelsSkillBody: a hold row is emitted once per escalation.holdLabels entry", () => {
  const cfg: ResolvedLabelsForSkill = {
    labels: { ...workflowLabelDefaults("sapwood:"), prefix: "sapwood:" },
    escalation: { holdLabels: ["sapwood:hold", "sapwood:hold-secondary"], humanLabels: ["sapwood:needs-human", "sapwood:blocked"] },
  };
  const body = renderLabelsSkillBody(cfg);
  assert.ok(body.includes("`sapwood:hold`"));
  assert.ok(body.includes("`sapwood:hold-secondary`"));
});

// ── #658 review round 1, P1: merge-veto claims rendered from resolved escalation.humanLabels ──

/** The body text of one `## \`name\`` section, up to (not including) the next `## ` heading —
 *  lets a test assert on ONE row's rendered lines without the marker false-positiving on a
 *  different row that happens to share substring text. */
function labelSection(body: string, name: string): string {
  const marker = `## \`${name}\`\n`;
  const start = body.indexOf(marker);
  assert.ok(start >= 0, `section for "${name}" not found`);
  const rest = body.slice(start + marker.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("#658 P1: the default config renders today's semantics — needsHuman/blocked are the merge-veto members, reserve is not", () => {
  const cfg = resolvedLabelsForSkill("sapwood:");
  const body = renderLabelsSkillBody(cfg);
  assert.match(labelSection(body, "sapwood:needs-human"), /\*\*Merge veto:\*\* member of `escalation\.humanLabels`/);
  assert.match(labelSection(body, "sapwood:blocked"), /\*\*Merge veto:\*\* member of `escalation\.humanLabels`/);
  assert.match(labelSection(body, "sapwood:reserve"), /\*\*Merge veto:\*\* NOT a member of `escalation\.humanLabels`/);
});

test("#658 P1: blocked absent from a repo's explicit escalation.humanLabels renders the NON-member line", () => {
  const cfg: ResolvedLabelsForSkill = {
    labels: { ...workflowLabelDefaults("sapwood:"), prefix: "sapwood:" },
    escalation: { holdLabels: [holdLabelDefault("sapwood:")], humanLabels: ["sapwood:needs-human"] },
  };
  const body = renderLabelsSkillBody(cfg);
  assert.match(labelSection(body, "sapwood:needs-human"), /\*\*Merge veto:\*\* member of `escalation\.humanLabels`/);
  assert.match(labelSection(body, "sapwood:blocked"), /\*\*Merge veto:\*\* NOT a member of `escalation\.humanLabels`/);
});

test("#658 P1: reserve added to a repo's explicit escalation.humanLabels renders the MEMBER line", () => {
  const cfg: ResolvedLabelsForSkill = {
    labels: { ...workflowLabelDefaults("sapwood:"), prefix: "sapwood:" },
    escalation: {
      holdLabels: [holdLabelDefault("sapwood:")],
      humanLabels: ["sapwood:needs-human", "sapwood:blocked", "sapwood:reserve"],
    },
  };
  const body = renderLabelsSkillBody(cfg);
  assert.match(labelSection(body, "sapwood:reserve"), /\*\*Merge veto:\*\* member of `escalation\.humanLabels`/);
});
