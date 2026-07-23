/** Shared GitHub-label names and comparison helpers. GitHub preserves label case but treats
 * names as case-insensitively unique, so every engine read follows the same rule. */

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
