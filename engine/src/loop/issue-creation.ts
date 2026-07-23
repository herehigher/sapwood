import type { IForge, Issue } from "../forge/forge.js";

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
  terminalIds: Set<string>;
  createdIssues: ReadonlyMap<string, number>;
  markerFor(id: string): string;
  normalizeTitle(title: string): string;
  collisionPolicy?: "skip" | "reject";
  applyGovernance(result: IssueCreationResult): Promise<void>;
  onCreated(result: IssueCreationResult): void;
  onSkipped(proposal: IssueCreationProposal, collision: Issue): void;
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
 * title collision is skipped. Otherwise creation happens once, the marker becomes part of the
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
    const markerMatches = deps.knownOpenIssues.filter(
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

    const collision = deps.knownOpenIssues.find((issue) => deps.normalizeTitle(issue.title) === normalizedTitle);
    if (collision) {
      if (deps.collisionPolicy === "reject") throw new ProposalTitleCollisionError(proposal, collision);
      deps.onSkipped(proposal, collision);
      deps.terminalIds.add(proposal.id);
      continue;
    }

    const markedBody = `${proposal.body}\n\n${marker}`;
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
