import type { IForge, Issue } from "../forge/forge.js";
import { applyRoleBodyRewrite } from "../review/comment-cursor.js";

export function proposalMarker(id: string): string {
  return `<!-- sapwood:proposal:${id} -->`;
}

export function hasProposalMarkerTrailer(body: string | undefined, marker: string): boolean {
  return body?.endsWith(`\n\n${marker}`) === true;
}

/** Mechanical duplicate guard only: case, compatibility forms, punctuation, and whitespace
 * do not make two otherwise-identical titles distinct. */
export function normalizeProposalTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** One engine-validated issue proposal. The caller owns persistence and governance; this helper
 * owns the deliberately shared #216 create/reconcile loop so align and #310 decomposition
 * cannot drift into subtly different marker-dedupe semantics. */
export interface IssueCreationProposal {
  id: string;
  title: string;
  body: string;
}

export interface IssueCreationResult {
  proposal: IssueCreationProposal;
  issue: number;
  reconciled: boolean;
}

export interface IssueCreationBatchDeps {
  forge: Pick<IForge, "createIssue">;
  proposals: readonly IssueCreationProposal[];
  knownOpenIssues: Issue[];
  /** #528: the bounded recently-CLOSED dedup surface (forge.listRecentlyClosedIssues). Joins
   *  `knownOpenIssues` for both mechanical checks below, so a proposal that duplicates a shipped,
   *  closed fact reconciles or skips instead of being filed again. Optional and never mutated:
   *  omitted (or empty) is exactly the pre-#528 open-only behavior, and a created issue is pushed
   *  onto `knownOpenIssues` alone — a fresh creation is open by construction. */
  recentlyClosedIssues?: readonly Issue[];
  terminalIds: Set<string>;
  createdIssues: ReadonlyMap<string, number>;
  markerFor(id: string): string;
  normalizeTitle(title: string): string;
  collisionPolicy?: "skip" | "reject";
  applyGovernance(result: IssueCreationResult): Promise<void>;
  onCreated(result: IssueCreationResult): void;
  /** `collisionClosed` (#528): true iff the collision came from `recentlyClosedIssues` — so a
   *  skip receipt can say WHICH surface matched. Always false on the pre-#528 open path. */
  onSkipped(proposal: IssueCreationProposal, collision: Issue, collisionClosed: boolean): void;
}

export class ProposalTitleCollisionError extends Error {
  constructor(
    readonly proposal: IssueCreationProposal,
    readonly collision: Issue,
  ) {
    super(`proposal "${proposal.title}" collides with existing issue #${collision.number}`);
  }
}

/**
 * #216/#310 shared per-issue create loop.
 *
 * A terminal receipt skips work. A lost receipt reconciles by the body marker. A normalized
 * title collision is skipped — #528: against the recently-CLOSED surface as well as the open one,
 * since a shipped fact is a duplicate whether or not its issue is still open. Otherwise creation
 * happens once, the marker becomes part of the
 * created body, governance completes, and only then may the caller write its terminal receipt.
 * Mutates knownOpenIssues so later siblings see earlier creations in the same batch.
 */
export async function createIssueProposals(deps: IssueCreationBatchDeps): Promise<IssueCreationResult[]> {
  const results: IssueCreationResult[] = [];
  const claimedIssues = new Set<number>();
  for (const issue of deps.createdIssues.values()) {
    if (claimedIssues.has(issue)) {
      throw new Error(`duplicate created-issue receipt for issue #${issue}`);
    }
    claimedIssues.add(issue);
  }
  for (const proposal of deps.proposals) {
    if (deps.terminalIds.has(proposal.id)) {
      const issue = deps.createdIssues.get(proposal.id);
      if (issue !== undefined) results.push({ proposal, issue, reconciled: true });
      continue;
    }

    const marker = deps.markerFor(proposal.id);
    const normalizedTitle = deps.normalizeTitle(proposal.title);
    // #528: open first, then the bounded closed set — so an open match always wins and the open
    // path's behavior (which issue is named, in what order) is unchanged. Rebuilt per proposal
    // because knownOpenIssues grows as earlier siblings in this same batch get created.
    const dedupSurface = [...deps.knownOpenIssues, ...(deps.recentlyClosedIssues ?? [])];
    const markerMatches = dedupSurface.filter(
      (issue) => hasProposalMarkerTrailer(issue.body, marker) && deps.normalizeTitle(issue.title) === normalizedTitle,
    );
    if (markerMatches.length > 1) {
      throw new Error(`multiple issues carry the terminal marker for proposal ${proposal.id}`);
    }
    const markerMatch = markerMatches[0];
    if (markerMatch) {
      if (claimedIssues.has(markerMatch.number)) {
        throw new Error(`issue #${markerMatch.number} cannot satisfy more than one proposal receipt`);
      }
      claimedIssues.add(markerMatch.number);
      const result = { proposal, issue: markerMatch.number, reconciled: true };
      await deps.applyGovernance(result);
      deps.onCreated(result);
      deps.terminalIds.add(proposal.id);
      results.push(result);
      continue;
    }

    const collision = dedupSurface.find((issue) => deps.normalizeTitle(issue.title) === normalizedTitle);
    if (collision) {
      if (deps.collisionPolicy === "reject") throw new ProposalTitleCollisionError(proposal, collision);
      deps.onSkipped(proposal, collision, !deps.knownOpenIssues.includes(collision));
      deps.terminalIds.add(proposal.id);
      continue;
    }

    // #703 v2 (ruling item 1b): a role-proposed body for a BRAND-NEW issue has no standing to
    // CREATE an adjudication-cursor marker either — a not-yet-existing issue has no current
    // marker by construction, so `applyRoleBodyRewrite("", proposal.body)` always resolves to
    // "strip whatever the role wrote, keep none" (see that function's own doc). Stripping happens
    // BEFORE the terminal proposal marker is appended below, so `hasProposalMarkerTrailer`'s
    // `endsWith` check (this file's own doc, line 7) is never at risk — the proposal marker is
    // always the unconditional literal suffix of `markedBody`, regardless of what got stripped
    // out of `proposal.body` first.
    // #827 / gate② round 1 fix (P2): an empty `currentBody` carries no operator-owned fence by
    // construction — `operatorFenceScanResult("")` is never malformed and `extractOperatorOwnedFences("")`
    // is always `[]`, so NEITHER refusal arm (`malformed-operator-fence`, `operator-fence-violation`)
    // can ever fire here; the throw below stays genuinely unreachable. What DOES apply here: a
    // role-proposed brand-new body has no standing to introduce its OWN operator-owned fence tags
    // either — `applyRoleBodyRewrite` strips any such tags from `proposal.body` (content kept, tag
    // lines dropped; see `stripUnpreservedOperatorFenceTags`'s own doc), never accepts them as
    // authoritative just because this is the issue's first-ever body.
    const rewrite = applyRoleBodyRewrite("", proposal.body);
    if (!rewrite.ok) throw new Error(`unreachable: applyRoleBodyRewrite("", ...) refused — ${rewrite.detail}`);
    const markedBody = `${rewrite.body}\n\n${marker}`;
    const issue = await deps.forge.createIssue(proposal.title, markedBody);
    if (claimedIssues.has(issue)) {
      throw new Error(`issue #${issue} cannot satisfy more than one proposal receipt`);
    }
    claimedIssues.add(issue);
    deps.knownOpenIssues.push({ number: issue, title: proposal.title, labels: [], body: markedBody });
    const result = { proposal, issue, reconciled: false };
    await deps.applyGovernance(result);
    deps.onCreated(result);
    deps.terminalIds.add(proposal.id);
    results.push(result);
  }
  return results;
}
