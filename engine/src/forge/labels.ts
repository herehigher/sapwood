/** Shared GitHub-label names and comparison helpers. GitHub preserves label case but treats
 * names as case-insensitively unique, so every engine read follows the same rule. */

export const SAPWOOD_LABEL_PREFIX = "sapwood:";

export const DEFAULT_WORKFLOW_LABELS = {
  inProgress: `${SAPWOOD_LABEL_PREFIX}in-progress`,
  needsHuman: `${SAPWOOD_LABEL_PREFIX}needs-human`,
  blocked: `${SAPWOOD_LABEL_PREFIX}blocked`,
  reserve: `${SAPWOOD_LABEL_PREFIX}reserve`,
  verifyNa: `${SAPWOOD_LABEL_PREFIX}verify:n/a`,
  planApproved: `${SAPWOOD_LABEL_PREFIX}plan:approved`,
  originAgent: `${SAPWOOD_LABEL_PREFIX}origin:agent`,
} as const;

/** Pre-#199 names retained for explicit legacy configs and 0day parity behavior. */
export const LEGACY_WORKFLOW_LABELS = {
  needsHuman: "needs-human",
  blocked: "blocked",
} as const;

export const SAPWOOD_TAXONOMY_LABELS = [
  { name: `${SAPWOOD_LABEL_PREFIX}type:feature`, color: "1d76db", description: "Feature work (1 issue = 1 PR)" },
  { name: `${SAPWOOD_LABEL_PREFIX}type:bug`, color: "d73a4a", description: "Defect" },
  { name: `${SAPWOOD_LABEL_PREFIX}type:infra`, color: "6e7781", description: "Infra / CI / tooling" },
  { name: `${SAPWOOD_LABEL_PREFIX}type:docs`, color: "0075ca", description: "Documentation" },
  {
    name: `${SAPWOOD_LABEL_PREFIX}prio:0`,
    color: "b60205",
    description: "Priority 0 — governance/blocking (highest)",
  },
  { name: `${SAPWOOD_LABEL_PREFIX}prio:1`, color: "d93f0b", description: "Priority 1 — high" },
  { name: `${SAPWOOD_LABEL_PREFIX}prio:2`, color: "fbca04", description: "Priority 2 — medium" },
  { name: `${SAPWOOD_LABEL_PREFIX}prio:3`, color: "0e8a16", description: "Priority 3 — feature (default)" },
] as const;

const PRIORITY_LABEL = /^prio:([0-4])(?:-|$)/;
const BLOCKED_BY_LABEL = /^blocked-by:#?([0-9]+)$/;

export function normalizeLabel(name: string): string {
  return name.trim().toLowerCase();
}

export function labelsInclude(labels: readonly string[], want: string): boolean {
  const normalizedWant = normalizeLabel(want);
  return labels.some((label) => normalizeLabel(label) === normalizedWant);
}

/** Preserve the PR gate's historical substring semantics while normalizing both sides. */
export function labelsIncludeAnySubstring(labels: readonly string[], wants: readonly string[]): boolean {
  const normalizedWants = wants.map(normalizeLabel);
  return labels.some((label) => {
    const normalizedLabel = normalizeLabel(label);
    return normalizedWants.some((want) => normalizedLabel.includes(want));
  });
}

/** Bare and sapwood-prefixed priority labels are both supported for existing repositories. */
export function matchPriorityLabel(name: string): number | null {
  const normalized = normalizeLabel(name);
  const unprefixed = normalized.startsWith(SAPWOOD_LABEL_PREFIX) ? normalized.slice(SAPWOOD_LABEL_PREFIX.length) : normalized;
  const match = PRIORITY_LABEL.exec(unprefixed);
  return match ? Number(match[1]) : null;
}

/** Bare and sapwood-prefixed blocker labels are both supported for existing repositories. */
export function matchBlockedByLabel(name: string): number | null {
  const normalized = normalizeLabel(name);
  const unprefixed = normalized.startsWith(SAPWOOD_LABEL_PREFIX) ? normalized.slice(SAPWOOD_LABEL_PREFIX.length) : normalized;
  const match = BLOCKED_BY_LABEL.exec(unprefixed);
  return match ? Number(match[1]) : null;
}
