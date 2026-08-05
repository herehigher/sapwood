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

export const TAXONOMY_SPECS = [
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

// ── #640: typed per-label semantics registry ─────────────────────────────────────────────────
//
// Label semantics — who writes a label, who removes it, what it gates, and what it is NOT (the
// #397 needs-human/human-merge-only/planless split, plus blocked/hold) — used to live only as TS
// doc comments above, unreadable from any role session; each prompt sees only its own slice. Live
// incidents this caused: a worker self-applied human-merge-only (#539); an architect blocked a
// Ready issue via label with no engine event (batch 6); repeated supervisor label-timeline
// misreads. `sapwood-labels` (skills-plugin.ts) renders this registry into a pull-model skill
// every role session can read on demand — see that module for the render/publish mechanics.
//
// This is a PROMOTION of the doc comments above, not a second carrier: `docs/configuration.md`'s
// label table keeps the operator-facing prose (defaults, config keys); this registry is the
// role-session-facing, compile-checked twin, transcribed once at #640 review time — after this
// PR, THIS registry is the source of truth for label semantics, and the doc comments above should
// be read as historical color, not re-derived from independently.

/** One label's semantics: WHO writes it, WHO removes it, WHAT it gates, and (when there is real
 *  confusion risk with a sibling label) what it is NOT. */
export interface LabelSemantics {
  readonly writer: string;
  readonly remover: string;
  readonly gates: string;
  readonly distinguishFrom?: string;
}

/** Every `workflowLabelDefaults` key, in that function's own declaration order — hand-written
 *  (not `Object.keys`) for the same reason `escalation-buckets.ts`'s `ESCALATION_BUCKET_ORDER` is:
 *  a Record's key order is an implementation detail this file does not want the rendered skill's
 *  reading order to depend on. */
export type WorkflowLabelKey = keyof ReturnType<typeof workflowLabelDefaults>;
const WORKFLOW_LABEL_KEYS: readonly WorkflowLabelKey[] = [
  "inProgress",
  "needsHuman",
  "blocked",
  "reserve",
  "verifyNa",
  "planApproved",
  "originAgent",
  "split",
  "decomposed",
  "roundPool",
  "humanMergeOnly",
  "laneState",
  "planless",
];

/** The fixed taxonomy label names (unprefixed), as a literal union off `TAXONOMY_SPECS`'s own
 *  `as const` shape — never re-declared by hand, so a taxonomy addition/rename there is a single
 *  edit, not two. */
export type TaxonomyLabelKey = (typeof TAXONOMY_SPECS)[number]["name"];

/** Every label key the registry below must cover: the 13 resolved workflow labels, the 8 fixed
 *  taxonomy labels, and the one WAIT-tier hold concept (`escalation.holdLabels` — a list, so more
 *  than one resolved name can share this one semantics entry; see `resolveLabelSkillRows`). */
export type LabelRegistryKey = WorkflowLabelKey | TaxonomyLabelKey | "hold";

/** #640 AC1: compile-time exhaustiveness — the #425 event-kind-registry pattern (`defineKinds`'s
 *  `satisfies EventKindTable`) applied to labels. Removing (or misspelling) any key below fails
 *  `satisfies Record<LabelRegistryKey, LabelSemantics>` at compile time, not at runtime — pinned
 *  by the `@ts-expect-error` fixture in labels.test.ts. */
export const LABEL_SEMANTICS = {
  inProgress: {
    writer: "Engine — claimed the moment a lane dispatches the issue (forge.ts's claim path).",
    remover:
      "Engine only, at startup — reconcile.ts's orphan healer (`healOrphanedIssues`), for an issue whose owning lane died " +
      "without releasing the claim. It moves the issue to Ready BEFORE removing the label, and tolerates a failed removal " +
      "(logged, retried next startup) — so the issue is dispatchable again even if the stale label lingers on it.",
    gates:
      "Marks an issue in flight; excluded from dispatch ONLY UNTIL the orphan healer moves the issue back to Ready (see " +
      "Remover, above), which happens BEFORE the label removal. After that move, dispatch does not re-check for this label " +
      "at all — so a lingering, not-yet-removed `in-progress` label can coexist with a dispatchable issue.",
  },
  needsHuman: {
    writer:
      "Engine, at any of many escalation write sites (conductor.ts, escalation-writer.ts, decompose.ts, fix-response.ts, " +
      "architect.ts's contradiction pass), or a human directly.",
    remover:
      "A human, by removing the label — the #147 gated-reentry handshake that reclaims and re-drives the lane. Also the " +
      "engine itself, via escalation-sweep.ts's `sweepResolvedHolds`: it removes ONLY a `needs-human` the ledger PROVES the " +
      "engine itself applied (an `always`-proof or proven-`payload` source, per escalation-reconcile.ts's `ESCALATION_SOURCES`), " +
      "once the escalation is ledger-resolved AND an authorizing witness (merge or issue close, never a mere PR close) confirms " +
      "it — latched by a `needs-human-swept` receipt. A label applied by a human with NO matching engine escalation in the " +
      "ledger is untouched, permanently — proof is about the ORIGINAL escalation's provenance, not the physical label's " +
      "authorship. The module's own accepted blind spot (escalation-sweep.ts:47) is the one exception: a human who RE-applies " +
      "the label by hand in the narrow window between the engine's resolution and the sweep running loses it anyway — that " +
      "reapplied, now ledger-co-owned physical label IS swept.",
    gates:
      "Bucket 1 escalation (#397): holds dispatch. Whether it also vetoes the merge gate when present on a PR depends on " +
      "`escalation.humanLabels` membership — see the rendered Merge veto line below for THIS repo's resolved answer.",
    distinguishFrom:
      "Means 'the machine STOPPED; a human owes the NEXT decision' — unlike `humanMergeOnly` ('a human must MERGE this PR', " +
      "never removed, not a member of `escalation.humanLabels`), `blocked` (an external wait, not necessarily a decision, but " +
      "gates identically), `hold` (a human PROACTIVELY pausing review — nothing is stuck), and `planless` (not an escalation at all).",
  },
  blocked: {
    writer: "Engine (the architect's severe-contradiction pass, `roles/architect.ts`) or a human.",
    remover: "A human only — the same #147 gated-reentry handshake as `needsHuman`.",
    gates:
      "Bucket 1 escalation, same tier as `needsHuman`: holds dispatch. Whether it also vetoes the merge gate on a PR (the " +
      "PR-side human-veto channel, #399) depends on `escalation.humanLabels` membership — see the rendered Merge veto line " +
      "below for THIS repo's resolved answer.",
    distinguishFrom: "An external wait rather than 'the machine stopped', but every gate treats it identically to `needsHuman`.",
  },
  reserve: {
    writer: "Human only.",
    remover: "Human only.",
    gates: "Parks an issue out of the main dispatch lane.",
    distinguishFrom:
      "Never engine-applied — unlike `needsHuman`/`blocked`, whether it holds a PR merge depends on `escalation.humanLabels` " +
      "membership — see the rendered Merge veto line below for THIS repo's resolved answer.",
  },
  verifyNa: {
    writer:
      "The verification-plan-reviewer peripheral (gate⓪), always paired with `needsHuman`, finalized by a human removing " +
      "`needsHuman` (the doc-gate adjudication) — or a human applying it directly.",
    remover: "Human only.",
    gates:
      "Marks an issue inherently unverifiable by tests; substitutes for a verification plan + `planApproved` in the " +
      "dispatchability gate (`getReadyIssues`), routing through the doc-gate path instead.",
    distinguishFrom: "`verifyNa` + `planApproved` together is a forbidden mixed state (#94) — the dispatch gate refuses to dispatch it.",
  },
  planApproved: {
    writer:
      "The verification-plan-reviewer peripheral (gate⓪), after quality-reviewing the plan — or, when " +
      "`roles.verificationPlanReviewer.enabled` is false (round-defaults.ts's plan_review-disabled fallback warning), a " +
      "human/external process, since nothing in the engine applies it in that configuration. Never self-applied by a worker.",
    remover:
      "Never removed by the engine. Not 'approved forever' (#214): a pool member carrying it from a PRIOR round is " +
      "RE-CONFIRMED (a lightweight freshness pass), never re-applied, at every round-pool entry.",
    gates:
      "Required — together with a genuine verification-plan section and a non-malformed acceptance-criteria checklist — " +
      "for `getReadyIssues` to dispatch a non-`verifyNa` issue (gate⓪ / PLAN Decision #8's dispatch key).",
  },
  originAgent: {
    writer: "The PO/align orchestrator, applied to agent-created issues at creation time.",
    remover: "Never removed.",
    gates: "Provenance stamp only — read by nothing that gates dispatch, merge, or any queue.",
  },
  split: {
    writer: "Human only — a firing signal requesting one PO decomposition pass.",
    remover: "Never removed by the engine (the engine reads it but never applies or removes it).",
    gates:
      "On an `origin:agent` child, permits decomposition. Label-application time does NOT define attempt freshness: freshness " +
      "is derived from the issue title/body signature, so an edited body re-arms a new attempt without a fresh label.",
  },
  decomposed: {
    writer: "Engine only (decompose.ts, once a parent's children are created).",
    remover: "Never removed, and the parent is never auto-closed.",
    gates: "Retires the parent to Todo as a tracking container, excluded from every engine ingestion/dispatch path.",
  },
  roundPool: {
    writer: "Engine only — the aligning phase's pool-selection pass, up to the round's pool-candidate cap.",
    remover:
      "Engine only, always via the single fail-closed `removeRoundPoolLabel` helper (`round.ts`) — at round close (every open " +
      "issue still carrying it), during the pool-selection reconcile pass (a stray label outside this round's selection), " +
      "when decompose.ts's `applyParentFence` fences a parent being decomposed out of the pool, or when architect.ts's batch " +
      "review returns a `drop` verdict for a pool member. Round close itself skips exactly two categories rather than " +
      "removing unconditionally (round.ts:~1970): an issue already `poolRemovalEscalated` (handed to a human — an unrelated " +
      "wake must never re-attempt and re-fail a removal the engine already gave up on) and an issue at or over " +
      "`cfg.round.maxPoolRemovalAttempts` failed removals (escalated again, in case a prior escalation's event append was " +
      "lost, instead of retried).",
    gates: "Round-pool membership: gate⓪ is scoped to this label, and the executing phase dispatches gate⓪-passed pool members only.",
    distinguishFrom: "Config load rejects `labels.roundPool` aliasing any other protected label.",
  },
  humanMergeOnly: {
    writer: "Engine only, on the PR, exactly once — the instruction-path trust chain (#292).",
    remover: "Never removed or re-decided by any automated act.",
    gates: "Bucket 2 escalation (#397): the merge decision for this PR belongs to a human, unconditionally.",
    distinguishFrom:
      "Unlike `needsHuman`, the PR is not 'stuck' — its merge decision simply isn't the loop's to take. Deliberately NOT a " +
      "member of `escalation.humanLabels`, so a lane settling here is structurally invisible to #147 gated reclaim: it can " +
      "never be re-escalated to `needsHuman` or gate-reclaimed.",
  },
  laneState: {
    writer: "Engine only, applied to a lane's PR while that lane is `driving` or `fixing`.",
    remover:
      "Engine only, via the single fail-closed `removeLaneStateLabel` helper (`lane-state-label.ts`'s `syncLaneStateLabels`) " +
      "— removal is ATTEMPTED the tick the lane leaves the ACTIVE set (`driving`/`fixing`), which includes a nonterminal " +
      "`handoff` (a graceful pause awaiting a resume decision, deliberately excluded from ACTIVE — see the module's own " +
      "comment) as well as a genuinely terminal state (merged, escalated, dead); a paused-but-not-dead lane therefore loses " +
      "the label too. Not necessarily removed THAT tick: a forge failure or hitting the per-tick removal budget " +
      "(`MAX_REMOVALS_PER_TICK`, lane-state-label.ts:149) leaves the label in place, logged, and retried next tick.",
    gates: "Nothing — a pure PR-list visibility signal, invisible to `deriveGate`, dispatch, and every queue.",
    distinguishFrom:
      "One label deliberately covers BOTH active lane states (`driving` and `fixing`) — which of the two is an " +
      "engine-internal distinction, not something a human scanning the PR list needs a second bit for.",
  },
  planless: {
    writer: "Engine only — the PO's decomposition remainder path and its no-plan issue-creation path.",
    remover: "A human, once a verification plan exists.",
    gates: "Excluded from `isPoolEligible`/`needsPlanReview`/`needsPlanTriage`/the standby probe, exactly as `needsHuman` is.",
    distinguishFrom:
      "NOT an escalation at all (#397 class 6) — nobody owes a decision; it is a routing fence, off every queue until a " +
      "plan exists. Not a member of `escalation.humanLabels`.",
  },
  hold: {
    writer: "Human only — applied by a human actively reviewing a PR to pause automation on it.",
    remover: "Human only, by removing it, to resume automation.",
    gates:
      "The WAIT tier (#248, three-tier escalation model): suppresses MERGE, FIXABLE, and the ordinary drive switch in " +
      "`deriveGate` while present. No effect on issues — it is a PR-only signal.",
    distinguishFrom:
      "`hold` ≠ `needsHuman`: a hold is a human PROACTIVELY pausing an in-progress review (nothing is stuck), while " +
      "`needsHuman` means automation itself stopped and is waiting on a decision. There is no `labels.hold` config key — " +
      "unlike every label above, it is configured as a LIST, `escalation.holdLabels`, because the engine never writes it.",
  },
  "type:feature": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates: "Classification only (feature work, one issue = one PR) — read by nothing that gates dispatch or merge.",
  },
  "type:bug": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates: "Classification only (a defect) — read by nothing that gates dispatch or merge.",
  },
  "type:infra": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates: "Classification only (infra / CI / tooling) — read by nothing that gates dispatch or merge.",
  },
  "type:docs": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates: "Classification only (documentation) — read by nothing that gates dispatch or merge.",
  },
  "prio:0": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates:
      "Orders the Ready-lane candidate set (round-pool selection dispatches prio:0 first). `prio:0`/`prio:1`/`prio:2` are " +
      "META-classified ranks (`isCodingRank` returns false for rank<=2 — conductor.ts's `issuePriority`/`isCodingRank`, " +
      "~line 301), so a `prio:0` candidate's dispatch THIS TICK can be DEFERRED, not just re-ordered: the dispatch loop's " +
      "`metaLaneAllowed` check (conductor.ts:~5014-5019) reserves `codingFloor(cfg.lanes.max)` lanes for coding-ranked " +
      '(`prio:3`+/unlabeled) work whenever any is still waiting, skipping a meta candidate with `reason: "meta-floor"` ' +
      "instead of dispatching it that tick.",
  },
  "prio:1": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates:
      "Orders the Ready-lane candidate set (dispatches ahead of prio:2/prio:3). Same META-classified rank as `prio:0`/" +
      "`prio:2` (`isCodingRank` returns false for rank<=2, conductor.ts's `issuePriority`/`isCodingRank`) — a `prio:1` " +
      "candidate's dispatch THIS TICK can likewise be DEFERRED by the meta-floor (`metaLaneAllowed`, " +
      "conductor.ts:~5014-5019): coding-ranked work still waiting reserves `codingFloor(cfg.lanes.max)` lanes, skipping " +
      'this candidate with `reason: "meta-floor"` instead of dispatching it that tick.',
  },
  "prio:2": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates:
      "Orders the Ready-lane candidate set (dispatches ahead of `prio:3` AND ahead of unlabeled issues — conductor.ts's " +
      "`issuePriority` ranks an unlabeled issue 3, the same as `prio:3`, NOT 2; `prio:2` is not 'the default'). Same " +
      "META-classified rank as `prio:0`/`prio:1` (`isCodingRank` returns false for rank<=2) — a `prio:2` candidate's " +
      "dispatch THIS TICK can likewise be DEFERRED by the meta-floor (`metaLaneAllowed`, conductor.ts:~5014-5019) " +
      "whenever coding-ranked work is still waiting.",
  },
  "prio:3": {
    writer: "Human triage only.",
    remover: "Human only.",
    gates:
      "Orders the Ready-lane candidate set (tied with unlabeled issues — conductor.ts's `issuePriority` defaults an " +
      "unlabeled issue to this same rank, 3 — and ranked AHEAD of any HIGHER-numbered `prio:N` the parser accepts, e.g. " +
      "`prio:4`, per conductor.test.ts's own rank-4 fixture; NOT last among every priority the system can express). " +
      "`prio:3` is CODING-classified (`isCodingRank` returns true for rank>=3) — it is never itself deferred by the " +
      "meta-floor; it is the rank the floor RESERVES lanes for: `metaLaneAllowed` (conductor.ts:~5014-5019) counts a " +
      "still-waiting `prio:3`/unlabeled candidate as `codingWaiting` and skips a lower-ranked meta candidate " +
      '(`prio:0`-`prio:2`) instead, with `reason: "meta-floor"`.',
  },
} satisfies Record<LabelRegistryKey, LabelSemantics>;

/** One row of the rendered `sapwood-labels` skill: a RESOLVED label name paired with its registry
 *  entry. `key` is the registry lookup key (a `hold` row's key is always `"hold"` even though its
 *  resolved `name` varies per `escalation.holdLabels` entry — see `resolveLabelSkillRows`). */
export interface LabelSkillRow {
  readonly key: LabelRegistryKey;
  readonly name: string;
  readonly semantics: LabelSemantics;
}

/** The shape `resolveLabelSkillRows`/`renderLabelsSkillBody` need off a resolved config — exactly
 *  `SapwoodConfig`'s `labels`/`escalation.holdLabels`/`escalation.humanLabels` fields, kept as a
 *  narrow structural type here so labels.ts does not import `SapwoodConfig` (config.ts already
 *  imports labels.ts). `humanLabels` (#658 review round 1, P1) is what lets the renderer show a
 *  label's ACTUAL, resolved merge-veto membership instead of asserting it statically — `blocked`
 *  is a member by DEFAULT only (`resolveLabelDefaults` in config.ts), and an explicit
 *  `escalation.humanLabels` array can omit it, or add an arbitrary other label, so the true answer
 *  can only ever come from the resolved list, never from the registry's static prose. */
export interface ResolvedLabelsForSkill {
  readonly labels: Record<WorkflowLabelKey, string> & { readonly prefix: string };
  readonly escalation: { readonly holdLabels: readonly string[]; readonly humanLabels: readonly string[] };
}

/** #658 review round 2 (A): the three escalation rows whose static `gates`/`distinguishFrom` prose
 *  above deliberately defers its `escalation.humanLabels` membership claim to the renderer — see
 *  each entry's own text. Membership is config-dependent (only `needsHuman` is
 *  validation-guaranteed a member; `blocked` is a member by default only; `reserve` is never a
 *  member by default but nothing stops an operator adding it), so asserting it here as fixed prose
 *  would go stale the moment a repo's `escalation.humanLabels` diverges from the shipped default —
 *  exactly the registry-as-source-of-truth failure this file exists to prevent.
 *
 *  Repurposed at round 2 (was `HUMAN_LABELS_VETO_ROWS`, gating a single "Merge veto" line): these
 *  three rows get BOTH the Merge veto and Dispatch hold facts rendered UNCONDITIONALLY — member or
 *  non-member — because they are the rows an operator actually reasons about escalation through.
 *  Every OTHER row (the remaining 18: the other 10 workflow labels, 8 taxonomy labels, hold) gets
 *  a fact line only when that row's resolved name actually matches the corresponding predicate —
 *  see `renderLabelsSkillBody` below. */
const ALWAYS_RENDER_ESCALATION_ROWS: ReadonlySet<LabelRegistryKey> = new Set(["needsHuman", "blocked", "reserve"]);

/** #640 AC2/AC3: resolve every registry key to its ACTUAL, prefix-resolved label name — from
 *  `cfg.labels`/`cfg.escalation.holdLabels` only, never from `workflowLabelDefaults`/
 *  `taxonomyLabels`/`holdLabelDefault`'s own defaults, so a `labels.prefix` remap (or any other
 *  per-label override) renders correctly. Taxonomy names are the one exception with no per-label
 *  override key: they follow `cfg.labels.prefix` the same way `taxonomyLabels` does. A `hold` row
 *  is emitted once per `escalation.holdLabels` entry (usually one, but the list can carry more). */
export function resolveLabelSkillRows(cfg: ResolvedLabelsForSkill): LabelSkillRow[] {
  const rows: LabelSkillRow[] = WORKFLOW_LABEL_KEYS.map((key) => ({
    key,
    name: cfg.labels[key],
    semantics: LABEL_SEMANTICS[key],
  }));
  const prefix = normalizeLabel(cfg.labels.prefix);
  for (const spec of TAXONOMY_SPECS) {
    rows.push({ key: spec.name, name: `${prefix}${spec.name}`, semantics: LABEL_SEMANTICS[spec.name] });
  }
  for (const holdName of cfg.escalation.holdLabels) {
    rows.push({ key: "hold", name: holdName, semantics: LABEL_SEMANTICS.hold });
  }
  return rows;
}

/** #658 round 4 (P2, correction-reintroduced defect — again): the REAL composed dispatch-exclusion
 *  set a label's rendered `Dispatch hold` line must reflect — never `escalation.humanLabels`
 *  membership alone (round 3's bug: it rendered `reserve`/`needsHuman`/`blocked` as "NOT a
 *  member" whenever a repo's `escalation.humanLabels` happened to omit them, when in fact all
 *  three hold dispatch in EVERY config). Round 3 fixed those three but missed a FOURTH label both
 *  sites also exclude unconditionally: `decomposed`. Traced completely — every label EITHER
 *  function unconditionally excludes or filters, cite these sites if it ever needs re-tracing,
 *  do not re-derive from prose:
 *   - forge.ts's `isDispatchable` (~line 2522, called from `getReadyIssues`/`selectReadyIssues`):
 *     `isDecomposed(labels, l)` (line 2523) excludes `decomposed` UNCONDITIONALLY, first, before
 *     any other check; `labelsInclude(labels, l.needsHuman) || labelsInclude(labels, l.blocked)`
 *     (line 2524) excludes `needsHuman`/`blocked` UNCONDITIONALLY too, before
 *     `escalation.humanLabels` is ever consulted. (`verifyNa`+`planApproved` together is also
 *     excluded, but conditionally — only when BOTH are present on the same issue — so it is not
 *     part of this per-label unconditional set.)
 *   - conductor.ts's `orderForDispatch` (~lines 1629–1631): its first filter,
 *     `!labelsInclude(i.labels, cfg.labels.decomposed)` (line 1629), excludes `decomposed`
 *     UNCONDITIONALLY, independently confirming the forge.ts exclusion above. Its second filter
 *     builds `reserveish = [cfg.labels.reserve, ...cfg.escalation.humanLabels]` (line 1627) and
 *     filters through `hasReserveLabel` (line 1630) — so `reserve` is ALSO excluded
 *     UNCONDITIONALLY (the literal array entry), independent of `escalation.humanLabels`
 *     membership. Its third filter, `labelsBlockers(...).length === 0` (line 1631), excludes
 *     issues carrying a `blocked-by:N` token — a dynamic per-issue pattern (`matchBlockedByLabel`),
 *     not a named registry label, so it has no row in this registry and is out of scope here.
 *   - that same `orderForDispatch` array's `...cfg.escalation.humanLabels` spread: every OTHER
 *     label holds dispatch only if it is an EXACT member of that resolved list
 *     (`hasReserveLabel`'s `labelsInclude` — exact identity, not substring).
 *  Every other registry label (`inProgress`, `verifyNa`, `planApproved`, `originAgent`, `split`,
 *  `roundPool`, `humanMergeOnly`, `laneState`, `planless`, every taxonomy label, `hold`) appears
 *  in NEITHER function's unconditional checks — traced against the actual code, not guessed —
 *  so each holds dispatch only via `escalation.humanLabels` membership, exactly like the
 *  fallthrough branch below.
 *  `why: "unconditional"` takes precedence over `"humanLabels"` even when a row's resolved name
 *  is ALSO explicitly listed in `escalation.humanLabels` — the unconditional exclude fires
 *  regardless, so it is the true reason either way. */
function computeDispatchHold(
  row: LabelSkillRow,
  cfg: ResolvedLabelsForSkill,
): { readonly holdsDispatch: boolean; readonly why: "unconditional" | "humanLabels" | null } {
  if (row.key === "needsHuman" || row.key === "blocked" || row.key === "reserve" || row.key === "decomposed") {
    return { holdsDispatch: true, why: "unconditional" };
  }
  if (labelsInclude(cfg.escalation.humanLabels, row.name)) {
    return { holdsDispatch: true, why: "humanLabels" };
  }
  return { holdsDispatch: false, why: null };
}

/** The `sapwood-labels` skill body (everything after SKILL.md's frontmatter) — rendered fresh at
 *  engine startup by skills-plugin.ts's `buildLabelsSkillFile`, from the SAME resolved cfg every
 *  other engine read uses. Deterministic given `cfg` (no wall-clock, no `Date.now()`), so a
 *  content-hash-named plugin dir stays valid content-addressing for this skill too. */
export function renderLabelsSkillBody(cfg: ResolvedLabelsForSkill): string {
  const lines: string[] = [
    "# sapwood labels",
    "",
    "GENERATED — rendered at engine startup from `engine/src/forge/labels.ts`'s `LABEL_SEMANTICS` " +
      "registry against THIS repo's resolved config (never hand-edited, never a `labels.prefix` " +
      "template). Every name below is the ACTUAL label this repo uses.",
    "",
    // #658 review round 2 (A): designed-role vs rendered-facts precedence. The Writer/Remover/
    // Gates/Distinguish-from prose above each `##` heading describes a label's DESIGNED role,
    // hand-written and static. The Merge veto / Dispatch hold lines below are RENDERED, not
    // asserted: computed straight from THIS repo's resolved `escalation.humanLabels` list with
    // the SAME predicate functions the engine's own gates call (never a re-derived
    // approximation), so drift between this skill and the gates it describes is impossible by
    // construction. Where the two would ever disagree, the rendered facts are authoritative.
    "The prose under each label below (Writer/Remover/Gates/Distinguish from) describes that " +
      "label's DESIGNED role. The **Merge veto** / **Dispatch hold** lines are RENDERED FACTS, " +
      "computed from the same predicates the engine's own gates call — never a re-derived " +
      "approximation — and they take PRECEDENCE over the prose above whenever the two would ever " +
      "disagree. **Merge veto** is `escalation.humanLabels` membership alone. **Dispatch hold** " +
      "is the WIDER composed exclusion set gate⓪ and dispatch actually apply: `needsHuman` / " +
      "`blocked` / `reserve` / `decomposed` hold dispatch UNCONDITIONALLY, in every config, " +
      "regardless of `escalation.humanLabels` membership; every other row holds dispatch only if " +
      "it is an EXACT member of the resolved `escalation.humanLabels` list.",
    "",
    "`escalation.humanLabels` matching is NOT uniform: the merge gate matches by SUBSTRING " +
      "(`labelsIncludeAnySubstring`, merge-driver.ts's `deriveGate`) — a short entry like " +
      "`sapwood` matches every label name that CONTAINS it, not just an exact one — while the " +
      "`escalation.humanLabels`-derived portion of dispatch hold matches the same list by EXACT " +
      "identity (`labelsInclude`, conductor.ts's `orderForDispatch` / `hasReserveLabel`). The two " +
      "lines below reflect that difference; they can disagree for the same row. `needsHuman` / " +
      "`blocked` / `reserve` / `decomposed` hold dispatch unconditionally either way — see each " +
      "row's own Dispatch hold line.",
    "",
  ];
  for (const row of resolveLabelSkillRows(cfg)) {
    lines.push(`## \`${row.name}\``);
    lines.push("");
    lines.push(`- **Writer:** ${row.semantics.writer}`);
    lines.push(`- **Remover:** ${row.semantics.remover}`);
    lines.push(`- **Gates:** ${row.semantics.gates}`);
    if (row.semantics.distinguishFrom) lines.push(`- **Distinguish from:** ${row.semantics.distinguishFrom}`);
    // #658 review round 2 (A): rendered, not asserted, for EVERY row — the ONLY correct source
    // for a config-dependent fact is the actual resolved `escalation.humanLabels` list, read
    // through the SAME predicate the corresponding gate itself calls (never a re-derived
    // approximation). The three escalation rows always get both lines (member or non-member, so
    // an operator never has to infer absence); every other row gets a line only when its
    // resolved name actually matches that predicate — most of the other 18 rows never will, and
    // a line asserting "NOT a member" on all of them would bury the ones that do.
    const alwaysRender = ALWAYS_RENDER_ESCALATION_ROWS.has(row.key);
    // Merge gate: merge-driver.ts's `deriveGate` calls `labelsIncludeAnySubstring(input.labels,
    // input.humanLabels)` (merge-driver.ts:111) — substring match.
    const mergeVetoMember = labelsIncludeAnySubstring([row.name], cfg.escalation.humanLabels);
    if (alwaysRender || mergeVetoMember) {
      lines.push(
        `- **Merge veto:** ${
          mergeVetoMember
            ? "member of `escalation.humanLabels` in THIS repo (vetoes PR merge while present)."
            : "NOT a member of `escalation.humanLabels` in THIS repo (does not veto PR merge)."
        }`,
      );
    }
    // Dispatch hold: computed from the REAL composed dispatch-exclusion set — see
    // `computeDispatchHold`'s doc comment for the three sites it mirrors. Never
    // `escalation.humanLabels` membership alone (#658 round 3 P1).
    const dispatchHold = computeDispatchHold(row, cfg);
    if (alwaysRender || dispatchHold.holdsDispatch) {
      lines.push(
        `- **Dispatch hold:** ${
          dispatchHold.why === "unconditional"
            ? "holds dispatch (unconditional — excluded regardless of `escalation.humanLabels` " +
              "membership; see forge.ts's `isDispatchable` / conductor.ts's `orderForDispatch`)."
            : dispatchHold.holdsDispatch
              ? "member of `escalation.humanLabels` in THIS repo (holds an issue carrying it out of dispatch)."
              : "NOT a member of `escalation.humanLabels` in THIS repo (does not hold dispatch)."
        }`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
