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
import { postConcerns } from "./dissent.js";
import { createIssueProposals, type IssueCreationProposal, normalizeProposalTitle, proposalMarker } from "./issue-creation.js";
import { removeRoundPoolLabel } from "./round.js";

const ISSUE_BODY_START = "<<<ISSUE>>>";
const ISSUE_BODY_END = "<<<END_ISSUE>>>";

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
    title: z.string().min(1),
    body: z.string().min(1),
    kind: z.enum(["ready", "remainder"]),
    blockedBy: z.array(z.number().int().nonnegative()),
  })
  .strict();

const DecomposeSetSchema = z
  .object({
    round_id: z.number().int().positive(),
    scope: z.string().min(1),
    parent: z.number().int().positive(),
    proposals: z.array(PersistedChildSchema).min(1),
    coverage: z.unknown(),
  })
  .strict();

interface DecomposeJournal {
  roundId: number;
  parent: number;
  proposals: z.infer<typeof PersistedChildSchema>[];
  coverage: unknown;
  terminalIds: Set<string>;
  created: Map<string, number>;
}

function latestJournal(state: State, parent: number): DecomposeJournal | null {
  const scope = decomposeScope(parent);
  const events = state.eventsAfterId(0, ["proposal-set-persisted", "proposal-created", "proposal-skipped"]);
  let journal: DecomposeJournal | null = null;
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (payload.scope !== scope) continue;
    if (event.kind === "proposal-set-persisted") {
      const parsed = DecomposeSetSchema.safeParse(payload);
      if (!parsed.success) throw new Error(`malformed decomposition proposal set for parent #${parent}`);
      journal = {
        roundId: parsed.data.round_id,
        parent,
        proposals: parsed.data.proposals,
        coverage: parsed.data.coverage,
        terminalIds: new Set(),
        created: new Map(),
      };
      continue;
    }
    if (!journal) continue;
    const proposalId = typeof payload.proposalId === "string" ? payload.proposalId : null;
    if (!proposalId) continue;
    journal.terminalIds.add(proposalId);
    if (event.kind === "proposal-created" && typeof payload.issue === "number") journal.created.set(proposalId, payload.issue);
  }
  return journal;
}

function coverageComment(parent: number, journal: DecomposeJournal): string {
  const byIndex = new Map(journal.proposals.map((p) => [p.index, p]));
  const coverage = journal.coverage as { mappings?: Array<{ parentIntent: string; children: number[] }>; remainders?: number[] };
  const lines = (coverage.mappings ?? []).map(
    (mapping) =>
      `- ${mapping.parentIntent} → ${mapping.children
        .map((i) => {
          const child = byIndex.get(i);
          const number = child ? journal.created.get(child.proposalId) : undefined;
          return number === undefined ? `child ${i + 1}` : `#${number}`;
        })
        .join(", ")}`,
  );
  const remainders = (coverage.remainders ?? []).map((i) => {
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

async function reconcileJournal(deps: DecomposeDeps, parent: Issue, journal: DecomposeJournal, openIssues: Issue[]): Promise<void> {
  const commented = new Set(
    deps.state
      .eventsAfterId(0, ["proposal-comment-posted"])
      .filter((event) => (event.payload as Record<string, unknown>).scope === decomposeScope(parent.number))
      .map((event) => (event.payload as Record<string, unknown>).proposalId)
      .filter((id): id is string => typeof id === "string"),
  );
  const results = await createIssueProposals({
    forge: deps.forge,
    proposals: journal.proposals.map((p): IssueCreationProposal => ({ id: p.proposalId, title: p.title, body: p.body })),
    knownOpenIssues: [...openIssues],
    terminalIds: journal.terminalIds,
    createdIssues: journal.created,
    markerFor: proposalMarker,
    normalizeTitle: normalizeProposalTitle,
    applyGovernance: async ({ proposal, issue }) => {
      const child = journal.proposals.find((p) => p.proposalId === proposal.id)!;
      await deps.forge.addLabel(issue, deps.cfg.labels.originAgent);
      if (child.kind === "remainder") await deps.forge.addLabel(issue, deps.cfg.labels.needsHuman);
      if (!commented.has(proposal.id)) {
        await deps.forge.addIssueComment(
          issue,
          child.kind === "remainder"
            ? `Created as a coarse remainder of #${parent.number}; ${deps.cfg.labels.needsHuman} keeps it on the planless backlog path.`
            : `Created as a Ready-able child of #${parent.number}; a human still moves it to Ready.`,
        );
        try {
          deps.state.appendEvent("proposal-comment-posted", {
            round_id: journal.roundId,
            scope: decomposeScope(parent.number),
            proposalId: proposal.id,
          });
        } catch {
          // Match align's accepted rare-duplicate tradeoff if this best-effort receipt alone
          // fails after the comment has already landed.
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
    onSkipped: (proposal, collision) => {
      deps.state.appendEvent("proposal-skipped", {
        round_id: journal.roundId,
        scope: decomposeScope(parent.number),
        parent: parent.number,
        proposalId: proposal.id,
        title: proposal.title,
        reason: "normalized-title-collision",
        existingIssue: collision.number,
      });
    },
  });
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
  now?: () => Date;
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
    (issue) => labelsInclude(issue.labels, deps.cfg.labels.decomposed) && latestJournal(deps.state, issue.number) !== null,
  );

  for (const parent of [...recoveries, ...candidates]) {
    const existing = latestJournal(deps.state, parent.number);
    if (labelsInclude(parent.labels, deps.cfg.labels.decomposed)) {
      if (existing && !(await journalIsFullyReconciled(deps, parent, existing))) {
        await reconcileJournal(deps, parent, existing, openIssues);
      }
      continue;
    }
    if (existing) {
      // Persist-first recovery: the validated set exists, but the process stopped before the
      // fence completed. Retry only the deterministic fence, never the paid PO judgment.
      if (await applyParentFence(deps, parent)) {
        await reconcileJournal(deps, { ...parent, labels: [...parent.labels, deps.cfg.labels.decomposed] }, existing, openIssues);
      }
      continue;
    }
    const firingMarker = decomposeFiringMarker(parent);
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
      now: deps.now ?? (() => new Date()),
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
      await postConcerns({
        forge: deps.forge,
        state: deps.state,
        cfg: deps.cfg,
        roundId,
        concerns: [
          {
            issue: parent.number,
            reason:
              `PO decomposition concern (advisory only): ${validated.metadata.reason}\n\n` +
              `Unresolved context: ${validated.metadata.unresolvedContext.reason}\n\n${firingMarker}`,
          },
        ],
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
    try {
      deps.state.appendEvent("proposal-set-persisted", {
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
      },
      openIssues,
    );
  }
}
