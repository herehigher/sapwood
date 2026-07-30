import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, Issue } from "../forge/forge.js";
import { extractAcceptanceCriteria, extractVerificationPlan, extractVerificationSection } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { RoleRunner, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry } from "../roles/peripheral.js";
import { loadRolePromptTemplate, renderRolePrompt } from "../roles/plan-review.js";
import type { State } from "../state/state.js";
import { type DecomposeOutputMetadata, DecomposeOutputMetadataSchema, parseStructuredBlock } from "../state/structured-output.js";
import { type Concern, ConcernSchema, postConcerns } from "./dissent.js";
import {
  createIssueProposals,
  hasProposalMarkerTrailer,
  type IssueCreationProposal,
  type IssueCreationResult,
  normalizeProposalTitle,
  ProposalTitleCollisionError,
  proposalMarker,
} from "./issue-creation.js";
import { removeRoundPoolLabel } from "./round.js";

const ISSUE_BODY_START = "<<<ISSUE>>>";
const ISSUE_BODY_END = "<<<END_ISSUE>>>";
const RESERVED_PROPOSAL_MARKER_NAMESPACE = "<!-- sapwood:proposal:";

export function defaultPoDecomposePromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "po-decompose.md");
}

/** Human split is a fresh signature even on origin:agent; without it agent-created issues are
 * never autonomous candidates. decomposed is the one-way machine fence. */
export function isDecomposeCandidate(issue: Issue, cfg: SapwoodConfig): boolean {
  return (
    labelsInclude(issue.labels, cfg.labels.split) &&
    !labelsInclude(issue.labels, cfg.labels.decomposed) &&
    !labelsInclude(issue.labels, cfg.labels.needsHuman) &&
    !labelsInclude(issue.labels, cfg.labels.blocked)
  );
}

export function decomposeProposalId(roundId: number, parent: number, index: number, title: string): string {
  const hash = createHash("sha256").update(title).digest("hex").slice(0, 16);
  return `decompose-${parent}-${roundId}-${index}-${hash}`;
}

function decomposeScope(parent: number): string {
  return `decompose:#${parent}`;
}

function decomposeFiringMarker(issue: Issue): string {
  const whyWhatSignature = createHash("sha256")
    .update(`${issue.title}\0${issue.body ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `<!-- sapwood:decompose-firing:${issue.number}:${whyWhatSignature} -->`;
}

function decomposeConcernReason(reason: string, unresolvedContextReason: string, firingMarker: string): string {
  return `PO decomposition concern (advisory only): ${reason}\n\nUnresolved context: ${unresolvedContextReason}\n\n${firingMarker}`;
}

function splitBodies(raw: string, count: number): string[] | null {
  const bodies: string[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const start = raw.indexOf(ISSUE_BODY_START, cursor);
    if (start < 0 || raw.slice(cursor, start).trim() !== "") return null;
    const contentStart = start + ISSUE_BODY_START.length;
    const end = raw.indexOf(ISSUE_BODY_END, contentStart);
    if (end < 0) return null;
    const body = raw.slice(contentStart, end).replace(/^\n/, "").replace(/\n$/, "");
    if (body.trim() === "" || body.includes(ISSUE_BODY_START) || body.includes(ISSUE_BODY_END)) return null;
    bodies.push(body);
    cursor = end + ISSUE_BODY_END.length;
  }
  return raw.slice(cursor).trim() === "" ? bodies : null;
}

export type DecomposeValidation =
  | {
      ok: true;
      outcome: "decomposed";
      metadata: Extract<DecomposeOutputMetadata, { outcome: "decomposed" }>;
      children: Array<{ title: string; body: string; kind: "ready" | "remainder"; blockedBy: number[] }>;
    }
  | { ok: true; outcome: "unresolved"; metadata: Extract<DecomposeOutputMetadata, { outcome: "unresolved" }> }
  | { ok: false; reason: string };

export function validateDecomposeOutput(text: string, maxChildren: number): DecomposeValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found" };
  let json: unknown;
  try {
    json = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = DecomposeOutputMetadataSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") };
  if (parsed.data.outcome === "unresolved") {
    if (block.body !== undefined) return { ok: false, reason: "unresolved output must not carry a BODY block" };
    return { ok: true, outcome: "unresolved", metadata: parsed.data };
  }

  const metadata = parsed.data;
  if (metadata.children.length > maxChildren) {
    return { ok: false, reason: `children exceeds configured maxChildren (${metadata.children.length} > ${maxChildren})` };
  }
  if (block.body === undefined) return { ok: false, reason: "decomposed output requires child bodies" };
  const bodies = splitBodies(block.body, metadata.children.length);
  if (!bodies) return { ok: false, reason: "child BODY segments do not match metadata children" };
  const titles = new Set<string>();
  const all = new Set(metadata.children.map((_, i) => i));
  const referenced = new Set<number>();
  for (const mapping of metadata.coverage.mappings) for (const child of mapping.children) referenced.add(child);
  const remainderSet = new Set(metadata.coverage.remainders);
  for (const index of [...referenced, ...remainderSet]) {
    if (!all.has(index)) return { ok: false, reason: `coverage references out-of-range child index ${index}` };
  }

  const children: Array<{ title: string; body: string; kind: "ready" | "remainder"; blockedBy: number[] }> = [];
  for (let i = 0; i < metadata.children.length; i++) {
    const child = metadata.children[i]!;
    const body = bodies[i]!;
    if (child.title.includes(RESERVED_PROPOSAL_MARKER_NAMESPACE) || body.includes(RESERVED_PROPOSAL_MARKER_NAMESPACE)) {
      return { ok: false, reason: `child ${i} uses the reserved sapwood proposal-marker namespace` };
    }
    const normalized = normalizeProposalTitle(child.title);
    if (titles.has(normalized)) return { ok: false, reason: `duplicate child title at index ${i}` };
    titles.add(normalized);
    if (!referenced.has(i) && !remainderSet.has(i)) {
      return { ok: false, reason: `coverage omits child index ${i}` };
    }
    for (const blocker of child.blockedBy) {
      if (!all.has(blocker) || blocker === i) return { ok: false, reason: `invalid blockedBy index ${blocker} on child ${i}` };
    }
    if (child.kind === "ready") {
      if (remainderSet.has(i)) return { ok: false, reason: `ready child ${i} is listed as a remainder` };
      if (extractVerificationPlan(body) == null || extractVerificationSection(body) == null || extractAcceptanceCriteria(body) == null) {
        return { ok: false, reason: `ready child ${i} lacks checkbox acceptance criteria or a verification plan` };
      }
    } else {
      if (!remainderSet.has(i)) return { ok: false, reason: `remainder child ${i} is missing from coverage.remainders` };
      if (extractVerificationPlan(body) != null) {
        return { ok: false, reason: `remainder child ${i} must remain honestly planless` };
      }
      const unresolved = child.unresolvedContext!;
      children.push({
        title: child.title,
        kind: child.kind,
        blockedBy: child.blockedBy,
        body: `${body}\n\n## Unresolved decomposition\n\n${unresolved.reason}\n\n` + `Information needed: ${child.informationNeeded!}`,
      });
      continue;
    }
    children.push({ title: child.title, body, kind: child.kind, blockedBy: child.blockedBy });
  }
  return { ok: true, outcome: "decomposed", metadata, children };
}

const PersistedChildSchema = z
  .object({
    proposalId: z.string().min(1),
    index: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(256),
    body: z.string().min(1),
    kind: z.enum(["ready", "remainder"]),
    blockedBy: z.array(z.number().int().nonnegative()),
  })
  .strict();

const PersistedCoverageSchema = z
  .object({
    mappings: z
      .array(
        z
          .object({
            parentIntent: z.string().trim().min(1),
            children: z.array(z.number().int().nonnegative()).min(1),
          })
          .strict(),
      )
      .min(1),
    remainders: z.array(z.number().int().nonnegative()),
  })
  .strict();

const DecomposedSetSchema = z
  .object({
    // Optional only for recovery of a valid journal written by the immediately preceding
    // #310 producer commit; all new writes include the explicit discriminator below.
    outcome: z.literal("decomposed").optional(),
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    proposals: z.array(PersistedChildSchema).min(1),
    coverage: PersistedCoverageSchema,
  })
  .strict();

const UnresolvedSetSchema = z
  .object({
    outcome: z.literal("unresolved"),
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    firingMarker: z.string().min(1),
    reason: z.string().trim().min(1),
    unresolvedContextReason: z.string().trim().min(1),
    proposals: z.tuple([]),
    concerns: z.array(ConcernSchema).length(1),
  })
  .strict();

const DecomposeSetSchema = z.union([DecomposedSetSchema, UnresolvedSetSchema]);
const DecomposeCreatedSchema = z
  .object({
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    proposalId: z.string().min(1),
    issue: z.number().int().positive(),
    reconciled: z.boolean().optional(),
  })
  .strict();
const DecomposeSkippedSchema = z
  .object({
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    proposalId: z.string().min(1),
    title: z.string().min(1),
    reason: z.string().min(1),
    existingIssue: z.number().int().positive(),
  })
  .strict();
const DecomposeCommentSchema = z
  .object({
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    proposalId: z.string().min(1),
  })
  .strict();

interface DecomposeJournal {
  roundId: number;
  parent: number;
  proposals: z.infer<typeof PersistedChildSchema>[];
  coverage: z.infer<typeof PersistedCoverageSchema>;
  terminalIds: Set<string>;
  created: Map<string, number>;
  pendingCreated: Map<string, number>;
  commentedIds: Set<string>;
  collisionEscalated: boolean;
}

interface DecomposeProgress {
  journal: DecomposeJournal | null;
  unresolved: Map<string, { roundId: number; concerns: Concern[] }>;
}

function decomposeProgress(state: State, parent: number): DecomposeProgress {
  const scope = decomposeScope(parent);
  const events = state.eventsAfterId(0, ["proposal-set-persisted", "proposal-created", "proposal-skipped", "proposal-comment-posted"]);
  let journal: DecomposeJournal | null = null;
  const unresolved = new Map<string, { roundId: number; concerns: Concern[] }>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (payload.scope !== scope && payload.parent !== parent) continue;
    if (event.kind === "proposal-set-persisted") {
      const parsed = DecomposeSetSchema.safeParse(payload);
      if (!parsed.success) throw new Error(`malformed decomposition proposal set for parent #${parent}`);
      if (parsed.data.parent !== parent || parsed.data.scope !== scope) {
        throw new Error(`decomposition proposal set scope/parent mismatch for parent #${parent}`);
      }
      if (parsed.data.outcome === "unresolved") {
        const concern = parsed.data.concerns[0]!;
        if (concern.issue !== parent) throw new Error(`unresolved decomposition concern targets the wrong parent #${concern.issue}`);
        if (!new RegExp(`^<!-- sapwood:decompose-firing:${parent}:[0-9a-f]{16} -->$`).test(parsed.data.firingMarker)) {
          throw new Error(`invalid unresolved decomposition firing marker for parent #${parent}`);
        }
        if (concern.reason !== decomposeConcernReason(parsed.data.reason, parsed.data.unresolvedContextReason, parsed.data.firingMarker)) {
          throw new Error(`unresolved decomposition concern evidence does not match its persisted decision for parent #${parent}`);
        }
        if (unresolved.has(parsed.data.firingMarker)) {
          throw new Error(`multiple unresolved decomposition decisions for one firing of parent #${parent}`);
        }
        unresolved.set(parsed.data.firingMarker, { roundId: parsed.data.round_id, concerns: parsed.data.concerns });
        continue;
      }
      if (journal !== null) throw new Error(`multiple decomposition proposal sets for parent #${parent}`);
      journal = {
        roundId: parsed.data.round_id,
        parent,
        proposals: parsed.data.proposals,
        coverage: parsed.data.coverage,
        terminalIds: new Set(),
        created: new Map(),
        pendingCreated: new Map(),
        commentedIds: new Set(),
        collisionEscalated: false,
      };
      continue;
    }
    if (!journal) throw new Error(`decomposition terminal event exists without a proposal set for parent #${parent}`);
    if (event.kind === "proposal-comment-posted") {
      const parsed = DecomposeCommentSchema.safeParse(payload);
      if (!parsed.success) throw new Error(`malformed decomposition proposal-comment-posted record for parent #${parent}`);
      if (parsed.data.parent !== parent || parsed.data.scope !== scope || parsed.data.round_id !== journal.roundId) {
        throw new Error(`decomposition proposal-comment-posted scope/parent/round mismatch for parent #${parent}`);
      }
      if (journal.commentedIds.has(parsed.data.proposalId)) {
        throw new Error(`multiple proposal-comment-posted events for decomposition proposal ${parsed.data.proposalId}`);
      }
      journal.commentedIds.add(parsed.data.proposalId);
      continue;
    }
    const parsed =
      event.kind === "proposal-created" ? DecomposeCreatedSchema.safeParse(payload) : DecomposeSkippedSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`malformed decomposition ${event.kind} record for parent #${parent}`);
    if (parsed.data.parent !== parent || parsed.data.scope !== scope || parsed.data.round_id !== journal.roundId) {
      throw new Error(`decomposition ${event.kind} scope/parent/round mismatch for parent #${parent}`);
    }
    if (journal.terminalIds.has(parsed.data.proposalId)) {
      throw new Error(`multiple terminal events for decomposition proposal ${parsed.data.proposalId}`);
    }
    if (event.kind === "proposal-created") {
      const created = parsed.data as z.infer<typeof DecomposeCreatedSchema>;
      if (journal.pendingCreated.has(created.proposalId)) {
        throw new Error(`multiple terminal events for decomposition proposal ${created.proposalId}`);
      }
      if ([...journal.pendingCreated.values()].includes(created.issue)) {
        throw new Error(`duplicate decomposition issue receipt for issue #${created.issue}`);
      }
      journal.pendingCreated.set(created.proposalId, created.issue);
    } else {
      const skipped = parsed.data as z.infer<typeof DecomposeSkippedSchema>;
      if (
        skipped.reason !== "normalized-title-collision-needs-human" &&
        skipped.reason !== "proposal-created-receipt-live-mismatch-needs-human"
      ) {
        throw new Error(`unsupported skipped decomposition proposal ${skipped.proposalId}`);
      }
      if (
        journal.terminalIds.has(skipped.proposalId) ||
        (journal.pendingCreated.has(skipped.proposalId) && skipped.reason !== "proposal-created-receipt-live-mismatch-needs-human")
      ) {
        throw new Error(`multiple terminal events for decomposition proposal ${skipped.proposalId}`);
      }
      journal.pendingCreated.delete(skipped.proposalId);
      journal.terminalIds.add(skipped.proposalId);
      journal.collisionEscalated = true;
    }
  }
  if (journal) {
    const ids = new Set<string>();
    const all = new Set(journal.proposals.map((_, index) => index));
    const covered = new Set<number>();
    const remainders = new Set(journal.coverage.remainders);
    journal.proposals.forEach((proposal, index) => {
      if (
        proposal.index !== index ||
        proposal.proposalId !== decomposeProposalId(journal!.roundId, parent, index, proposal.title) ||
        ids.has(proposal.proposalId)
      ) {
        throw new Error(`invalid persisted decomposition proposal identity for parent #${parent} at index ${index}`);
      }
      ids.add(proposal.proposalId);
      for (const blocker of proposal.blockedBy) {
        if (!all.has(blocker) || blocker === index) {
          throw new Error(`invalid persisted blockedBy index ${blocker} for parent #${parent} child ${index}`);
        }
      }
      if (proposal.kind === "ready" && remainders.has(index)) {
        throw new Error(`persisted ready child ${index} is listed as a remainder for parent #${parent}`);
      }
      if (proposal.kind === "remainder" && !remainders.has(index)) {
        throw new Error(`persisted remainder child ${index} is missing from coverage for parent #${parent}`);
      }
    });
    for (const mapping of journal.coverage.mappings) {
      for (const child of mapping.children) {
        if (!all.has(child)) throw new Error(`persisted coverage references out-of-range child ${child} for parent #${parent}`);
        covered.add(child);
      }
    }
    for (const remainder of journal.coverage.remainders) {
      if (!all.has(remainder)) throw new Error(`persisted coverage references out-of-range remainder ${remainder} for parent #${parent}`);
      covered.add(remainder);
    }
    for (const index of all) {
      if (!covered.has(index)) throw new Error(`persisted coverage omits child ${index} for parent #${parent}`);
    }
    for (const terminal of journal.terminalIds) {
      if (!ids.has(terminal)) throw new Error(`unknown terminal decomposition proposal ${terminal} for parent #${parent}`);
    }
    for (const pending of journal.pendingCreated.keys()) {
      if (!ids.has(pending)) throw new Error(`unknown terminal decomposition proposal ${pending} for parent #${parent}`);
    }
    for (const commented of journal.commentedIds) {
      if (!ids.has(commented)) throw new Error(`unknown commented decomposition proposal ${commented} for parent #${parent}`);
    }
  }
  return { journal, unresolved };
}

function coverageComment(parent: number, journal: DecomposeJournal): string {
  const byIndex = new Map(journal.proposals.map((p) => [p.index, p]));
  const lines = journal.coverage.mappings.map(
    (mapping) =>
      `- ${mapping.parentIntent} → ${mapping.children
        .map((i) => {
          const child = byIndex.get(i);
          const number = child ? journal.created.get(child.proposalId) : undefined;
          return number === undefined ? `child ${i + 1}` : `#${number}`;
        })
        .join(", ")}`,
  );
  const remainders = journal.coverage.remainders.map((i) => {
    const child = byIndex.get(i);
    const number = child ? journal.created.get(child.proposalId) : undefined;
    return number === undefined ? `child ${i + 1}` : `#${number}`;
  });
  return (
    `PO decomposition coverage for #${parent}:\n\n${lines.join("\n")}\n\n` +
    `Remainders: ${remainders.length > 0 ? remainders.join(", ") : "none"}\n\n` +
    `<!-- sapwood:decompose-coverage:${parent}:${journal.roundId} -->`
  );
}

function proposalGovernanceMarker(proposalId: string): string {
  return `<!-- sapwood:decompose-governance:${proposalId} -->`;
}

async function escalateFencedCollision(
  deps: DecomposeDeps,
  parent: Issue,
  journal: DecomposeJournal,
  error: ProposalTitleCollisionError,
): Promise<void> {
  const marker = `<!-- sapwood:decompose-collision:${parent.number}:${journal.roundId}:${error.proposal.id} -->`;
  if (!labelsInclude(parent.labels, deps.cfg.labels.needsHuman)) {
    await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
  }
  const comments = await deps.forge.getIssueComments(parent.number);
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await deps.forge.addIssueComment(
      parent.number,
      `PO decomposition stopped after the parent fence because proposed child "${error.proposal.title}" ` +
        `collides with existing open issue #${error.collision.number}. No colliding proposal was silently skipped; ` +
        `human reconciliation is required.\n\n${marker}`,
    );
  }
  deps.state.appendEvent("proposal-skipped", {
    round_id: journal.roundId,
    scope: decomposeScope(parent.number),
    parent: parent.number,
    proposalId: error.proposal.id,
    title: error.proposal.title,
    reason: "normalized-title-collision-needs-human",
    existingIssue: error.collision.number,
  });
  journal.terminalIds.add(error.proposal.id);
  journal.collisionEscalated = true;
}

async function verifyCreatedReceipts(deps: DecomposeDeps, parent: Issue, journal: DecomposeJournal): Promise<void> {
  for (const [proposalId, issue] of journal.pendingCreated) {
    const proposal = journal.proposals.find((candidate) => candidate.proposalId === proposalId)!;
    const [meta, body] = await Promise.all([deps.forge.getIssueMeta(issue), deps.forge.getIssueBody(issue)]);
    const marker = proposalMarker(proposalId);
    const titleMatches = normalizeProposalTitle(meta.title) === normalizeProposalTitle(proposal.title);
    const trailerMatches = hasProposalMarkerTrailer(body, marker);
    if (!titleMatches || !trailerMatches) {
      const evidenceMarker = `<!-- sapwood:decompose-collision:${parent.number}:${journal.roundId}:${proposalId} -->`;
      if (!labelsInclude(parent.labels, deps.cfg.labels.needsHuman)) {
        await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
      }
      const comments = await deps.forge.getIssueComments(parent.number);
      if (!comments.some((comment) => comment.body.includes(evidenceMarker))) {
        await deps.forge.addIssueComment(
          parent.number,
          `PO decomposition stopped after the parent fence because durable proposal-created receipt for ` +
            `"${proposal.title}" points at live issue #${issue}, which does not match the proposal. ` +
            `Expected normalized title "${normalizeProposalTitle(proposal.title)}" and exact terminal trailer ` +
            `"${marker}"; observed normalized title "${normalizeProposalTitle(meta.title)}", ` +
            `title match=${titleMatches}, trailer match=${trailerMatches}. No recovery writes were made to the ` +
            `unverified issue; human reconciliation is required.\n\n${evidenceMarker}`,
        );
      }
      deps.state.appendEvent("proposal-skipped", {
        round_id: journal.roundId,
        scope: decomposeScope(parent.number),
        parent: parent.number,
        proposalId,
        title: proposal.title,
        reason: "proposal-created-receipt-live-mismatch-needs-human",
        existingIssue: issue,
      });
      journal.pendingCreated.delete(proposalId);
      journal.terminalIds.add(proposalId);
      journal.collisionEscalated = true;
      return;
    }
    journal.pendingCreated.delete(proposalId);
    journal.terminalIds.add(proposalId);
    journal.created.set(proposalId, issue);
  }
}

async function reconcileJournal(deps: DecomposeDeps, parent: Issue, journal: DecomposeJournal, openIssues: Issue[]): Promise<void> {
  if (journal.collisionEscalated) return;
  let results: IssueCreationResult[];
  try {
    results = await createIssueProposals({
      forge: deps.forge,
      proposals: journal.proposals.map((p): IssueCreationProposal => ({ id: p.proposalId, title: p.title, body: p.body })),
      knownOpenIssues: [...openIssues],
      terminalIds: journal.terminalIds,
      createdIssues: journal.created,
      markerFor: proposalMarker,
      normalizeTitle: normalizeProposalTitle,
      collisionPolicy: "reject",
      applyGovernance: async ({ proposal, issue }) => {
        const child = journal.proposals.find((p) => p.proposalId === proposal.id)!;
        await deps.forge.addLabel(issue, deps.cfg.labels.originAgent);
        // #397 class 6: a coarse remainder was never an ESCALATION — nobody owes a decision on a
        // child that was just created. It is a routing fence keeping it off every queue until a
        // plan exists, so it carries `planless`, not the human-escalation label it used to borrow.
        if (child.kind === "remainder") await deps.forge.addLabel(issue, deps.cfg.labels.planless);
        const marker = proposalGovernanceMarker(proposal.id);
        const comments = await deps.forge.getIssueComments(issue);
        if (!comments.some((comment) => comment.body.includes(marker))) {
          await deps.forge.addIssueComment(
            issue,
            (child.kind === "remainder"
              ? `Created as a coarse remainder of #${parent.number}; ${deps.cfg.labels.planless} keeps it on the planless backlog path.`
              : `Created as a Ready-able child of #${parent.number}; a human still moves it to Ready.`) + `\n\n${marker}`,
          );
        }
        if (!journal.commentedIds.has(proposal.id)) {
          try {
            deps.state.appendEvent("proposal-comment-posted", {
              round_id: journal.roundId,
              scope: decomposeScope(parent.number),
              parent: parent.number,
              proposalId: proposal.id,
            });
            journal.commentedIds.add(proposal.id);
          } catch {
            // Bookkeeping only. The live marker is the idempotency source and reconciles later.
          }
        }
      },
      onCreated: ({ proposal, issue, reconciled }) => {
        deps.state.appendEvent("proposal-created", {
          round_id: journal.roundId,
          scope: decomposeScope(parent.number),
          parent: parent.number,
          proposalId: proposal.id,
          issue,
          ...(reconciled ? { reconciled: true } : {}),
        });
        journal.created.set(proposal.id, issue);
      },
      onSkipped: () => {
        throw new Error("decompose collisionPolicy=reject unexpectedly skipped a proposal");
      },
    });
  } catch (error) {
    if (error instanceof ProposalTitleCollisionError) {
      await escalateFencedCollision(deps, parent, journal, error);
      return;
    }
    throw error;
  }
  for (const result of results) journal.created.set(result.proposal.id, result.issue);

  // Dependency labels and native relations are independently idempotent reconciliation writes.
  for (const child of journal.proposals) {
    const childNumber = journal.created.get(child.proposalId);
    if (childNumber === undefined) continue;
    for (const blockerIndex of child.blockedBy) {
      const blocker = journal.proposals[blockerIndex];
      const blockerNumber = blocker ? journal.created.get(blocker.proposalId) : undefined;
      if (blockerNumber !== undefined) {
        await deps.forge.addLabel(childNumber, `${deps.cfg.labels.prefix}blocked-by:#${blockerNumber}`);
      }
    }
  }

  const nativeChildren = await deps.forge.getSubIssues(parent.number);
  const attached = new Set(nativeChildren.map((child) => child.number));
  for (const childNumber of journal.created.values()) {
    if (attached.has(childNumber)) continue;
    try {
      await deps.forge.addSubIssue(parent.number, childNumber);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.state.appendEvent("tick-error", {
        round_id: journal.roundId,
        phase: "aligning",
        error: `decompose attach failed for #${parent.number} -> #${childNumber}: ${reason}`,
      });
      (deps.log ?? console.error)(`[sapwood:po] ${reason}; parent fence remains and the relation will reconcile next round`);
    }
  }

  const marker = `<!-- sapwood:decompose-coverage:${parent.number}:${journal.roundId} -->`;
  const comments = await deps.forge.getIssueComments(parent.number);
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await deps.forge.addIssueComment(parent.number, coverageComment(parent.number, journal));
  }
}

async function journalIsFullyReconciled(deps: DecomposeDeps, parent: Issue, journal: DecomposeJournal): Promise<boolean> {
  if (journal.collisionEscalated) return true;
  if (journal.created.size !== journal.proposals.length) return false;
  const childNumbers = new Set(journal.created.values());
  const nativeChildren = await deps.forge.getSubIssues(parent.number);
  if (![...childNumbers].every((number) => nativeChildren.some((child) => child.number === number))) return false;
  const marker = `<!-- sapwood:decompose-coverage:${parent.number}:${journal.roundId} -->`;
  const comments = await deps.forge.getIssueComments(parent.number);
  return comments.some((comment) => comment.body.includes(marker));
}

export interface DecomposeDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  runner: Pick<RoleRunner, "run">;
  now: () => Date;
  log?: (message: string) => void;
}

function failureReason(result: RoleSessionResult, maxChildren: number): string {
  if (result.outcome !== "done") return `session ${result.outcome}`;
  const validated = validateDecomposeOutput(result.resultText ?? "", maxChildren);
  return validated.ok ? "unknown" : validated.reason;
}

async function applyParentFence(deps: DecomposeDeps, parent: Issue): Promise<boolean> {
  try {
    await deps.forge.setBoardStatus(parent.number, "backlog");
    if (labelsInclude(parent.labels, deps.cfg.labels.roundPool)) {
      await removeRoundPoolLabel(deps.forge, deps.cfg, parent.number, deps.cfg.labels.roundPool);
    }
    await deps.forge.addLabel(parent.number, deps.cfg.labels.decomposed);
    return true;
  } catch (error) {
    (deps.log ?? console.error)(`[sapwood:po] failed to fence #${parent.number}; creating zero children: ${String(error)}`);
    return false;
  }
}

/** Runs before ordinary align/triage so fenced parents are absent from the subsequent digest.
 * No new event kinds: scoped payloads reuse proposal-set-persisted, proposal-created,
 * proposal-skipped, proposal-comment-posted, and tick-error. */
export async function runDecompositionPass(deps: DecomposeDeps, roundId: number, openIssues: Issue[]): Promise<void> {
  const template = loadRolePromptTemplate(deps.cfg.roles.po.decomposePromptFile, defaultPoDecomposePromptPath());
  const candidates = openIssues.filter((issue) => isDecomposeCandidate(issue, deps.cfg));
  const recoveries = openIssues.filter(
    (issue) => labelsInclude(issue.labels, deps.cfg.labels.decomposed) && decomposeProgress(deps.state, issue.number).journal !== null,
  );

  for (const parent of [...recoveries, ...candidates]) {
    const progress = decomposeProgress(deps.state, parent.number);
    const existing = progress.journal;
    if (existing) {
      await verifyCreatedReceipts(deps, parent, existing);
      if (existing.collisionEscalated) continue;
    }
    if (labelsInclude(parent.labels, deps.cfg.labels.decomposed)) {
      if (existing && !(await journalIsFullyReconciled(deps, parent, existing))) {
        await reconcileJournal(deps, parent, existing, await deps.forge.listOpenIssues());
      }
      continue;
    }
    if (existing) {
      // Persist-first recovery: the validated set exists, but the process stopped before the
      // fence completed. Retry only the deterministic fence, never the paid PO judgment.
      if (await applyParentFence(deps, parent)) {
        await reconcileJournal(
          deps,
          { ...parent, labels: [...parent.labels, deps.cfg.labels.decomposed] },
          existing,
          await deps.forge.listOpenIssues(),
        );
      }
      continue;
    }
    const firingMarker = decomposeFiringMarker(parent);
    const unresolvedReplay = progress.unresolved.get(firingMarker);
    if (unresolvedReplay) {
      await postConcerns({
        forge: deps.forge,
        state: deps.state,
        cfg: deps.cfg,
        roundId: unresolvedReplay.roundId,
        concerns: unresolvedReplay.concerns,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
      continue;
    }
    const existingComments = await deps.forge.getIssueComments(parent.number);
    if (existingComments.some((comment) => comment.body.includes(firingMarker))) continue;

    const prompt = renderRolePrompt(template, parent, deps.cfg, {
      "decompose.maxChildren": String(deps.cfg.roles.po.maxChildren),
      "decompose.acceptanceCriteriaHint": String(deps.cfg.roles.po.acceptanceCriteriaHint),
    });
    const result = await runSessionWithRetry({
      runner: deps.runner,
      state: deps.state,
      session: {
        roleId: "po-decompose",
        prompt,
        model: deps.cfg.roles.po.model,
        effort: deps.cfg.roles.po.effort,
        fallbackModel: deps.cfg.roles.po.fallbackModel,
        allowedTools: PO_ALLOWED_TOOLS,
        disallowedTools: PO_DISALLOWED_TOOLS,
      },
      issue: parent.number,
      now: deps.now,
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      contextManifest: {
        roundId,
        phase: "aligning",
        record: (key, json, at) => deps.state.recordContextManifest(key, json, at),
      },
      degradeEvent: "po-degraded",
      degradePayload: (attempt) => ({
        round_id: roundId,
        issue: parent.number,
        session: attempt.name,
        outcome: attempt.outcome,
        reason: failureReason(attempt, deps.cfg.roles.po.maxChildren),
      }),
      degradeMessage: (attempt) =>
        `[sapwood:po] decomposition failed for #${parent.number}: ${failureReason(attempt, deps.cfg.roles.po.maxChildren)}`,
      isValid: (attempt) => validateDecomposeOutput(attempt.resultText ?? "", deps.cfg.roles.po.maxChildren).ok,
    });
    const validated =
      result.outcome === "done"
        ? validateDecomposeOutput(result.resultText ?? "", deps.cfg.roles.po.maxChildren)
        : ({ ok: false, reason: failureReason(result, deps.cfg.roles.po.maxChildren) } as const);
    if (!validated.ok) {
      await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
      await deps.forge.addIssueComment(parent.number, `PO decomposition failed: ${validated.reason}`);
      continue;
    }
    if (validated.outcome === "unresolved") {
      const concerns: Concern[] = [
        {
          issue: parent.number,
          reason: decomposeConcernReason(validated.metadata.reason, validated.metadata.unresolvedContext.reason, firingMarker),
        },
      ];
      try {
        deps.state.appendEvent("proposal-set-persisted", {
          outcome: "unresolved",
          round_id: roundId,
          scope: decomposeScope(parent.number),
          parent: parent.number,
          firingMarker,
          reason: validated.metadata.reason,
          unresolvedContextReason: validated.metadata.unresolvedContext.reason,
          proposals: [],
          concerns,
        });
      } catch (error) {
        await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
        await deps.forge.addIssueComment(
          parent.number,
          `PO decomposition unresolved decision failed to persist; its concern was not delivered. Evidence: ${String(error)}`,
        );
        continue;
      }
      await postConcerns({
        forge: deps.forge,
        state: deps.state,
        cfg: deps.cfg,
        roundId,
        concerns,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
      continue;
    }

    const proposals = validated.children.map((child, index) => ({
      proposalId: decomposeProposalId(roundId, parent.number, index, child.title),
      index,
      title: child.title,
      body: child.body,
      kind: child.kind,
      blockedBy: child.blockedBy,
    }));
    const liveOpenIssues = await deps.forge.listOpenIssues();
    const preflightCollision = proposals
      .map((proposal) => ({
        proposal,
        collision: liveOpenIssues.find((issue) => normalizeProposalTitle(issue.title) === normalizeProposalTitle(proposal.title)),
      }))
      .find((entry) => entry.collision !== undefined);
    if (preflightCollision?.collision) {
      await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
      await deps.forge.addIssueComment(
        parent.number,
        `PO decomposition created zero children and did not fence the parent because proposed child ` +
          `"${preflightCollision.proposal.title}" collides with existing open issue #${preflightCollision.collision.number}.`,
      );
      continue;
    }
    try {
      deps.state.appendEvent("proposal-set-persisted", {
        outcome: "decomposed",
        round_id: roundId,
        scope: decomposeScope(parent.number),
        parent: parent.number,
        proposals,
        coverage: validated.metadata.coverage,
      });
    } catch (error) {
      await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);
      await deps.forge.addIssueComment(
        parent.number,
        `PO decomposition proposal evidence failed to persist; no fence or children were created. Evidence: ${String(error)}`,
      );
      continue;
    }
    // Fence-before-create: once the validated set is durable, retire the parent to Todo, strip
    // only the engine-owned pool label, then add the one-way decomposed fence. Any failure leaves
    // the durable set for deterministic retry and creates zero children.
    if (!(await applyParentFence(deps, parent))) continue;
    await reconcileJournal(
      deps,
      { ...parent, labels: [...parent.labels, deps.cfg.labels.decomposed] },
      {
        roundId,
        parent: parent.number,
        proposals,
        coverage: validated.metadata.coverage,
        terminalIds: new Set(),
        created: new Map(),
        pendingCreated: new Map(),
        commentedIds: new Set(),
        collisionEscalated: false,
      },
      await deps.forge.listOpenIssues(),
    );
  }
}
