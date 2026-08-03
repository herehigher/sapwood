/** Shared GitHub-label names and comparison helpers. GitHub preserves label case but treats
 * names as case-insensitively unique, so every engine read follows the same rule. */

import type { GhRunner } from "./gh.js";

export const SAPWOOD_LABEL_PREFIX = "sapwood:";

export function workflowLabelDefaults(prefix: string) {
  const normalizedPrefix = normalizeLabel(prefix);
  return {
    inProgress: `${normalizedPrefix}in-progress`,
    needsHuman: `${normalizedPrefix}needs-human`,
    blocked: `${normalizedPrefix}blocked`,
    reserve: `${normalizedPrefix}reserve`,
    verifyNa: `${normalizedPrefix}verify:n/a`,
    planApproved: `${normalizedPrefix}plan:approved`,
    originAgent: `${normalizedPrefix}origin:agent`,
    // #310: a human applies split to request one decomposition generation; the engine applies
    // decomposed to retire the parent as a tracking container. Both are prefix-aware workflow
    // facts, but only decomposed has an engine write path.
    split: `${normalizedPrefix}split`,
    decomposed: `${normalizedPrefix}decomposed`,
    // #212: round-pool membership — applied by the aligning phase's pool-selection pass,
    // consumed by the executing phase's dispatch-scoping wrapper (round.ts's PoolScopedForge).
    roundPool: `${normalizedPrefix}round:pool`,
    // #397 bucket 2: the gate verdict "a human must MERGE this PR" — as opposed to needsHuman's
    // "the machine stopped and a human owes the next decision". Engine-written, on the PR,
    // exactly once, never removed or re-evaluated by any automated act. Deliberately NOT a
    // member of `escalation.humanLabels` (see config.ts's collision guard and #397's P1
    // decision): a lane settling on this verdict terminates without `gated_escalation_labeled`,
    // so it is structurally invisible to gated reclaim rather than fenced out by a label check.
    humanMergeOnly: `${normalizedPrefix}human-merge-only`,
    // #399: the PR-side lane-state mirror — "a worker lane is actively on this PR right now".
    // ONE label for BOTH active lane states (`driving` and `fixing`), deliberately: the question
    // a human scanning the PR list cannot answer today is "is anything still working on this, or
    // is this lane dead?", and that is one bit. Which of the two active states a lane is in is an
    // engine-internal distinction (it decides which supervision loop owns the lane, not whether a
    // human should step in), and splitting it would cost a remove+add on every drive<->fix
    // transition to carry a fact nobody reads from the PR list. Engine-written AND engine-removed
    // on the PR — the second (and only other) auto-removal path in the engine besides
    // `roundPool`, which is why it gets `removeRoundPoolLabel`'s fail-closed guard shape
    // (lane-state-label.ts's `removeLaneStateLabel`) and the same config collision rejection.
    laneState: `${normalizedPrefix}lane:active`,
    // #397 class 6: NOT an escalation at all — a routing fence for an issue that has no
    // verification plan yet (decompose's coarse remainder children, align's planless PO
    // creations). It used to borrow `needsHuman`, which put items a human never owed a decision
    // on into the human queue. Excluded from every queue `needsHuman` is excluded from
    // (isPoolEligible / needsPlanReview / needsPlanTriage / the standby probe), so behavior is
    // byte-for-byte what it was — only the name is now honest.
    planless: `${normalizedPrefix}planless`,
  };
}

/** #248: default for `escalation.holdLabels` (the WAIT-tier human hold, three-tier escalation
 * model) — resolved under the SAME prefix convention `workflowLabelDefaults` uses above, but
 * deliberately kept SEPARATE from it (not a `Labels`/`cfg.labels` field): there is no
 * `labels.hold` override key, because the engine never writes this label (write-side asymmetry
 * is the audit trail distinguishing it from `needsHuman`) — only `escalation.holdLabels` (a
 * list, like `escalation.humanLabels`) is user-configurable, and this is just its default. */
export function holdLabelDefault(prefix: string): string {
  return `${normalizeLabel(prefix)}hold`;
}

const TAXONOMY_SPECS = [
  { name: "type:feature", color: "1d76db", description: "Feature work (1 issue = 1 PR)" },
  { name: "type:bug", color: "d73a4a", description: "Defect" },
  { name: "type:infra", color: "6e7781", description: "Infra / CI / tooling" },
  { name: "type:docs", color: "0075ca", description: "Documentation" },
  { name: "prio:0", color: "b60205", description: "Priority 0 — governance/blocking (highest)" },
  { name: "prio:1", color: "d93f0b", description: "Priority 1 — high" },
  { name: "prio:2", color: "fbca04", description: "Priority 2 — medium" },
  { name: "prio:3", color: "0e8a16", description: "Priority 3 — feature (default)" },
] as const;

export function taxonomyLabels(prefix: string) {
  const normalizedPrefix = normalizeLabel(prefix);
  return TAXONOMY_SPECS.map((spec) => ({ ...spec, name: `${normalizedPrefix}${spec.name}` }));
}

export interface LabelSpec {
  name: string;
  color: string; // 6-hex, no '#'
  description: string;
}

/** Create every spec'd label the repo doesn't already have, and return the created names.
 *  Idempotent and detect-before-create (no `--force`), so any color/description a user
 *  customized survives a re-run.
 *
 *  #379: ONE provisioning primitive with TWO callers — `sapwood init`'s onboarding pass
 *  (init.ts's ensureLabels) and the engine's own startup reconcile (cli.ts's
 *  reconcileWorkflowLabels, via GithubForge.ensureRepoLabels). They share `requiredLabels(cfg)`
 *  as the list AND this function as the write path, so a label added to the taxonomy later
 *  cannot drift out of either one — the live failure this closes is a repo initialized before
 *  round:pool/split/decomposed/hold existed, where every pool-label write failed forever because
 *  nothing ever created them. */
export async function createMissingLabels(run: GhRunner, repo: string, specs: readonly LabelSpec[]): Promise<string[]> {
  const existing = JSON.parse(await run(["label", "list", "--repo", repo, "--limit", "200", "--json", "name"])) as { name: string }[];
  const have = existing.map((e) => e.name);
  const created: string[] = [];
  for (const spec of specs) {
    if (labelsInclude(have, spec.name)) continue;
    const name = normalizeLabel(spec.name);
    try {
      await run(["label", "create", name, "--repo", repo, "--color", spec.color, "--description", spec.description]);
      created.push(name);
    } catch (error) {
      // Listing caps at 200; create is the authoritative existence check and also closes the
      // list→create race. Any OTHER failure (403, network) propagates — the caller decides
      // whether that is fatal (`sapwood init`) or best-effort (engine startup).
      const text = (error as { stderr?: string }).stderr ?? String(error);
      if (/already exists/i.test(text)) continue;
      throw error;
    }
  }
  return created;
}

/** #397 item 6: report which EXISTING labels carry a description that differs from the shipped
 *  spec — and change nothing. `createMissingLabels` above deliberately never rewrites an existing
 *  label (that default protects a user's customization and stays), which is exactly why drift
 *  goes unnoticed: our own repo carried pre-#248 description text for months. This makes the
 *  drift visible at `sapwood init` time without taking the write decision away from the human.
 *  Comparison is on the description only (color drift is cosmetic and often deliberate), against
 *  the same case-insensitive name identity every other label read uses. A label the repo doesn't
 *  have yet is not drift — `createMissingLabels` will create it with the right text. */
export async function describeLabelDrift(run: GhRunner, repo: string, specs: readonly LabelSpec[]): Promise<string[]> {
  const existing = JSON.parse(await run(["label", "list", "--repo", repo, "--limit", "200", "--json", "name,description"])) as {
    name: string;
    description?: string | null;
  }[];
  const byName = new Map(existing.map((e) => [normalizeLabel(e.name), e.description ?? ""]));
  const drifted: string[] = [];
  for (const spec of specs) {
    const have = byName.get(normalizeLabel(spec.name));
    if (have === undefined || have === spec.description) continue;
    drifted.push(`${normalizeLabel(spec.name)}: repo has "${have}" — shipped spec is "${spec.description}"`);
  }
  return drifted;
}

const PRIORITY_LABEL = /^prio:([0-4])(?:-|$)/;
const BLOCKED_BY_LABEL = /^blocked-by:#?([0-9]+)$/;

export function normalizeLabel(name: string): string {
  return name.trim().toLowerCase();
}

export function labelsInclude(labels: readonly string[], want: string): boolean {
  const normalizedWant = normalizeLabel(want);
  return labels.some((label) => normalizeLabel(label) === normalizedWant);
}

/** Preserve the PR gate's historical substring semantics while normalizing both sides.
 * ONLY for `escalation.humanLabels` (needs-human/blocked) — the historical, intentionally loose
 * matching those risk/triage labels have always used. Do NOT reuse this for a NEW label list
 * (like `escalation.holdLabels` below) without a deliberate decision to accept its footguns: a
 * one-word `wants` entry (e.g. `"sapwood"`) matches every label sharing that substring, and an
 * EMPTY `wants` entry matches every label unconditionally (`"".includes("")` is always true). */
export function labelsIncludeAnySubstring(labels: readonly string[], wants: readonly string[]): boolean {
  const normalizedWants = wants.map(normalizeLabel);
  return labels.some((label) => {
    const normalizedLabel = normalizeLabel(label);
    return normalizedWants.some((want) => normalizedLabel.includes(want));
  });
}

/** #248 (G3, review round 1): EXACT case-insensitive identity match against a LIST of wanted
 * label names — the counterpart to `labelsInclude` (single exact match) the way
 * `labelsIncludeAnySubstring` is the counterpart to a single substring match. Hold labels are
 * configured label NAMES, not risk/triage substrings — `escalation.holdLabels` (and any future
 * exact-match label list) must use this, never `labelsIncludeAnySubstring`, or a single-word
 * entry (or an accidentally-empty one) would silently hold far more than configured. */
export function labelsIncludeAny(labels: readonly string[], wants: readonly string[]): boolean {
  return wants.some((want) => labelsInclude(labels, want));
}

/** #294: `labelsIncludeAny`'s witness — the FIRST matching label instead of a bare boolean,
 * returned in its ON-PR casing so an event payload can name the label a human actually applied.
 * Matching is identical (same normalized EXACT identity, same G3 hardening), so
 * `firstMatchingLabel(...) != null` is interchangeable with `labelsIncludeAny(...)` — which is
 * what lets merge-driver.ts's hold check swap one for the other with no gate-behavior change. */
export function firstMatchingLabel(labels: readonly string[], wants: readonly string[]): string | null {
  const normalizedWants = wants.map(normalizeLabel);
  return labels.find((label) => normalizedWants.includes(normalizeLabel(label))) ?? null;
}

/** Match only the priority namespace selected by the configured prefix. */
export function matchPriorityLabel(name: string, prefix: string): number | null {
  const normalized = normalizeLabel(name);
  const root = `${normalizeLabel(prefix)}prio:`;
  if (!normalized.startsWith(root)) return null;
  const match = PRIORITY_LABEL.exec(`prio:${normalized.slice(root.length)}`);
  return match ? Number(match[1]) : null;
}

/** Match only the blocker namespace selected by the configured prefix. */
export function matchBlockedByLabel(name: string, prefix: string): number | null {
  const normalized = normalizeLabel(name);
  const root = `${normalizeLabel(prefix)}blocked-by:`;
  if (!normalized.startsWith(root)) return null;
  const match = BLOCKED_BY_LABEL.exec(`blocked-by:${normalized.slice(root.length)}`);
  return match ? Number(match[1]) : null;
}
