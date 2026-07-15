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
  };
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

/** Preserve the PR gate's historical substring semantics while normalizing both sides. */
export function labelsIncludeAnySubstring(labels: readonly string[], wants: readonly string[]): boolean {
  const normalizedWants = wants.map(normalizeLabel);
  return labels.some((label) => {
    const normalizedLabel = normalizeLabel(label);
    return normalizedWants.some((want) => normalizedLabel.includes(want));
  });
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
