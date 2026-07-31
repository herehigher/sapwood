// dissent.ts (#237): the PO dissent channel — a PO/triage session may raise a structured
// objection ALONGSIDE its normal deliverable (`concerns: [{issue, reason}]`), never instead of
// it (see align.ts's AlignMetadataSchema/TriageMetadataSchema, which embed ConcernSchema below —
// objection ≠ refusal, the role still delivers its best-effort plan/decomposition faithful to
// the stated why/what). This module owns everything downstream of a VALIDATED concern: the
// deterministic idempotent marker (#216's marker paradigm — issue number + a content hash), the
// marker-verified-before-post comment, and the durable bookkeeping (`concern-posted` /
// `concern-adjudicated`) that `sapwood status` and the round artifact read.
//
// Zero label/status/dispatch effects, BY CONSTRUCTION (#237 AC3): the only IForge calls this
// file ever makes are getIssueBody, getIssueComments, getIssueMeta, and addIssueComment — there
// is no addLabel/removeLabel/setBoardStatus call site anywhere below, and no schema field an
// engine write path could map to one (ConcernSchema below carries `issue`+`reason` only).
//
// Marker hash (#237 AC5 — "body-edit changes the hash"): covers BOTH the concern's own wording
// and the concerned issue's body AT POST TIME, not the wording alone. A human editing the
// issue's why/what after a concern was posted therefore changes the hash the NEXT time this same
// worded concern is raised, so the marker check below (postConcernIfNew) finds no match and
// reposts it — "the question naturally reopens" (issue #237's own wording). Without the body in
// the hash, an edited issue would silently suppress a still-applicable objection forever.
//
// #237 finding 4 (2026-07-18 adjudication, gate② on PR #262): baselining the CURRENT body at
// POST time (not the body the session originally read, and no engine-side plumbing of that
// original body into this module) is deliberate, not an oversight — it is the correct baseline
// for the re-arm behavior above: a FUTURE edit must change the hash relative to whatever is live
// right now, and triage's own body write only ever ADDS a verification-plan section under the
// #232 stale-hash guard (updateIssueBodyIfUnchanged in align.ts) — the why/what content the
// concern actually targets is unchanged by that write. The one residual, BOUNDED, self-correcting
// blind spot this accepts: a human edit landing in the narrow window between the session reading
// the body and this module posting (mid-phase, same round) is baselined into the marker as if it
// were the session's own view — a false negative for "did THIS session see the edit", never a
// false positive, and the very next legitimate edit still re-arms normally. No injected-body-hash
// plumbing was added to close this narrower window (PM ruling, marginal-complexity: an accepted
// bounded blind spot beats new machinery for a same-round race).
//
// Delivery idempotency is the LIVE marker check itself (getIssueComments, read fresh on every
// call) — NOT the durable `concern-posted` event. A crash strictly between addIssueComment
// landing and that event's append still finds the marker on a later pass and skips reposting;
// the durable event exists purely for bookkeeping (round-summary "objections raised" —
// round-artifact.ts — and status's unadjudicated count — cli.ts). #237 finding 3 (same
// adjudication): when the live marker is already present, postConcernIfNew now RECONCILES a
// missing receipt right there (the #216 marker-reconcile paradigm — align.ts's proposal-marker
// reconcile, `align.ts`'s `reconciled` branch) instead of bare-returning, so a lost event is
// healed on the very next pass rather than silently understating status/round-summary forever.
//
// Adjudication (#237 item 5) is the issue's OWN GitHub lifecycle, never a dedicated ack
// protocol. `scanForAdjudication` checks every still-open concern against live GitHub state and
// appends `concern-adjudicated` the moment ANY of the following is observed:
//   - the issue closed -> outcome "closed". #237 round-2 adjudication (2026-07-19, finding 3):
//     this is ALSO neutral, not human-attributable — the conductor merges `Closes #N` PRs
//     autonomously (round.ts), so an issue closing can be an ENGINE-caused merge just as easily
//     as a human closing it by hand. No provenance tracking distinguishes them, deliberately
//     (same stance as "body-changed" below).
//   - a comment landed AFTER the concern comment that does NOT itself carry a `<!-- sapwood:`
//     marker (this engine's own universal comment-marker convention, centrally stamped on EVERY
//     comment this engine posts at the forge write boundary — see forge.ts's
//     ENGINE_COMMENT_MARKER) -> outcome "external-reply". #237 finding 2 (2026-07-18
//     adjudication): renamed from "human-reply" — a reply from ANY non-sapwood-stamped actor
//     (another bot, e.g. Codex's own review comments, not only a human) satisfies this check; it
//     is a content check, not an identity check, and makes no claim about WHO replied beyond
//     "not this engine." This is the ONLY outcome that carries any actor claim at all (and even
//     that claim is "not this engine," never "a human specifically").
//   - its body no longer hashes to the concern's own recorded hash -> outcome "body-changed".
//     #237 finding 1 (2026-07-18 adjudication): renamed from "issue-edited" — this outcome makes
//     NO claim about who changed the body. This engine's OWN writes (a later triage pass drafting
//     a plan into the same issue, a plan-reviewer/drafter revision, ...) trigger it exactly like
//     a human edit would; there is no provenance tracking here to tell them apart, deliberately
//     (PM ruling, marginal-complexity: a bounded blind spot with this honesty note, not new
//     machinery). The self-heal for "body-changed" is RE-RAISE, not re-read: this event only
//     ever resolves the OLD (now-stale) marker; if the PO still holds the concern, a LATER
//     round's session raises the SAME worded concern again, which hashes against the (now
//     current) body, produces a NEW marker, and reposts with a fresh mention — never silently
//     re-adopting the old marker's already-closed state.
//   - "adopted" (an issue pulled from Ready without closing) is NOT detected here: #237 finding 5
//     (2026-07-18 adjudication) — IForge has no cheap read of board-status/lane membership this
//     module could use without adding new forge surface, and the PM ruling was not to build one
//     for this. Pulling a concerned issue from Ready without ever closing it is therefore
//     observed only INDIRECTLY here (typically as "body-changed", if the pull came with an edit,
//     or not at all if it didn't) — never as its own "adopted" outcome. Documented as a narrowed
//     lifecycle claim, not a gap to silently paper over.
// #237 round-2 adjudication (2026-07-19, finding 3): consequently, a future precision-metric
// consumer of `concern-adjudicated` can honestly attribute ONLY "external-reply" as any kind of
// actor-driven signal (and even then, "not this engine" is the only claim, never "a human"
// specifically) — "closed" and "body-changed" are both neutral/unattributed, since this engine's
// own write paths (conductor merges, PO triage drafts) can produce either one. This module never
// runs an ack protocol and never gates on a reply's CONTENT — only its presence/absence and
// authorship-by-marker.
//
// #237 finding 5 (2026-07-18 adjudication): the scan must run EVERY round regardless of
// `roles.po.enabled` and regardless of align.ts's own internal early-returns (e.g. a corrupt
// proposal journal) — it is NOT part of `postConcerns` below. round-defaults.ts's aligning
// wrapper calls `scanForAdjudication` directly, unconditionally, decoupled from whether
// `alignStub.run` (which owns `postConcerns`, since only IT knows this round's freshly validated
// concerns) ran at all this round.
//
// #237 round-2 adjudication (2026-07-19, finding 1): `postConcerns` alone is NOT a durable-enough
// delivery guarantee. align.ts's per-round triage loop only re-collects a decision's concerns
// into THIS round's post queue while that decision is still non-terminal in ITS OWN round's
// journal (triageProgress/proposalProgress, both round-scoped) — a decision that reached its
// TERMINAL receipt (`triage-effects-committed`, or a proposal's terminal event) on an EARLIER
// attempt is short-circuited (`continue`) on any later same-round rerun, before concern
// collection ever runs again. If the crash landed strictly between that terminal receipt and
// `postConcerns` actually delivering the concern (never dispatched a second po-triage/po-align
// session — that would be wasteful and is not what happens), the concern is invisible to EVERY
// future attempt at that round's own per-issue loop — a permanent loss no manual "try again"
// within the round can reach, since the terminal check is exactly what makes triage/align
// idempotent in the first place. `reconcileDurableConcerns` is the durable backstop for this:
// unlike `postConcerns` (session-scoped, in-memory `triageConcernsCollected`/`alignValidated`),
// it reads the concerns EMBEDDED IN the write-ahead decision events themselves
// (`triage-decision-accepted`/`proposal-set-persisted` — #232/#216's own persist-first events,
// which this module's finding-6 fix already made concerns ride along with) across the WHOLE
// ledger, not just this round's journal, and re-runs `postConcernIfNew` for any embedded concern
// with no matching `concern-posted` receipt yet — idempotent by construction (posts fresh if the
// comment never landed either, or reconciles the receipt if it did). Called unconditionally,
// every round, from round-defaults.ts's aligning wrapper (the same home `scanForAdjudication`
// already uses) — never gated on session memory, so a same-round crash-rerun OR a much later
// round both recover it identically.
//
// #237 round-2 adjudication (2026-07-19, finding 2): `reconcileDurableConcerns` always posts
// (or reconciles) using the DECISION EVENT'S OWN `round_id` — never the round the sweep happens
// to run in — since that decision event is the one durable source of truth for "which round this
// concern actually belongs to." This matters for round-artifact.ts's per-round "Objections
// raised" section: a `concern-posted` event landing in round N+2's event-ID window but carrying
// `round_id: N` in its payload is NOT something round N+2 delivered — round-artifact.ts's
// assembleRoundArtifact checks the payload's `round_id` against the round being assembled and
// routes a mismatch into a separate "reconciled from an earlier round" list, never the main
// per-round list (see that module's own doc comment).
//
// Explicitly OUT of scope (issue #237 item 7): no auto-escalation of any kind. The durable
// `concern-posted`/`concern-adjudicated` events carry `issue`, `round_id`, and `hash` — enough
// for a future analyst to JOIN against this codebase's EXISTING per-issue durable events (e.g.
// `plan-review-escalated`, `merged`, `drive-needs-human`) and compute a precision metric
// (objected -> later rejected/reworked/closed-invalid) without this module building that
// computation itself — no new machinery beyond what the issue names.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import type { State } from "../state/state.js";
import { escalateToNeedsHuman } from "./escalation-writer.js";

export const ConcernSchema = z.object({ issue: z.number().int().positive(), reason: z.string().min(1) }).strict();
export type Concern = z.infer<typeof ConcernSchema>;

/** Fail-closed, all-or-nothing (same doctrine as align.ts's duplicate-title/out-of-set checks
 *  elsewhere in this codebase): a concern naming an issue outside `inView`, or the same issue
 *  named twice in one batch, invalidates the WHOLE concerns array — never a partial/best-guess
 *  apply of the rest. `inView` is the session's OWN injected view (align.ts computes it per
 *  session — the rendered backlog-digest subset for align mode, the target issue ONLY for triage
 *  mode, #237 finding 7), never the full open backlog: a concern about an issue the session was
 *  never actually shown is invalid output regardless of whether that issue happens to exist. */
export function validateConcerns(concerns: readonly Concern[], inView: ReadonlySet<number>): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<number>();
  for (const c of concerns) {
    if (!inView.has(c.issue)) {
      return { ok: false, reason: `concern targets issue #${c.issue}, outside this session's injected view` };
    }
    if (seen.has(c.issue)) {
      return { ok: false, reason: `duplicate concern for issue #${c.issue} — one concern per issue per session` };
    }
    seen.add(c.issue);
  }
  return { ok: true };
}

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** #237 AC5: hashes BOTH the concern's own wording and the concerned issue's body AT POST TIME —
 *  see the module doc's "Marker hash" note (and finding 4's follow-up) for why that baseline is
 *  deliberate. */
export function concernHash(reason: string, issueBody: string): string {
  return sha16(JSON.stringify({ reason, body: issueBody }));
}

export function concernMarker(issue: number, hash: string): string {
  return `<!-- sapwood:concern:${issue}:${hash} -->`;
}

/** Every comment this engine ever posts ends in a `<!-- sapwood:...-->` marker of some kind —
 *  align.ts's proposal/triage/round markers, harvest.ts's round marker, this file's own concern
 *  marker, AND (#237 finding 2) a generic `<!-- sapwood:engine -->` stamp forge.ts's
 *  GithubForge.addIssueComment appends to EVERY comment at the write boundary regardless of
 *  whether the call site embeds its own specific marker — so a comment WITHOUT any `<!-- sapwood:`
 *  substring is, by construction, never one of this engine's own. The adjudication scan below
 *  uses this to recognize a non-engine reply (`external-reply`) with no identity/login concept. */
export function isSapwoodComment(body: string): boolean {
  return body.includes("<!-- sapwood:");
}

export interface PostConcernsDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  roundId: number;
  /** Freshly validated concerns from THIS round's align/triage session(s) — already bounds-
   *  checked against each session's own injected view (align.ts's validateConcerns call sites),
   *  and (#237 finding 6, triage) already dropped for any concern whose accompanying triage
   *  decision was itself discarded (stale-hash refusal / decision-lost degradation) — see
   *  align.ts's triage loop, `triageConcernsCollected`. May be empty. */
  concerns: readonly Concern[];
  log?: (message: string) => void;
}

/** #432 round 5 (P1-2, gate② confirm round 2): the event kind `postConcernIfNew` appends on each
 *  of its three UNPOSTED failure branches (body read / comments read / comment write) — the
 *  DETERMINISTIC-failure terminal `pendingDurableConcerns` (below) needs so a permanently
 *  unpostable concern (issue deleted/transferred/inaccessible — Codex's exact scenario) cannot
 *  pin the probe true forever. Keyed by the SAME (round_id, issue, reason) stable triple
 *  `reconcileDurableConcerns`' own receipt lookup uses — no new columns, event-log counting only
 *  (the same discipline conductor.ts's `priorFixLegForVerdict`/`fix_rounds` use, adapted to a
 *  pure ledger fold since this codebase's user-tunables rule keeps the CAP itself in config, not
 *  a schema column). */
const POST_FAILED_KIND = "concern-post-failed";

/** #432 round 5 (round 6 changed its PROOF semantics — see escalation-reconcile.ts's
 *  ESCALATION_SOURCES entry): the terminal escalation event. `pendingDurableConcerns` treats this
 *  identically to `concern-posted` (both mean "no longer pending"), regardless of whether the
 *  label write it carries actually landed — see `escalateUnpostableConcern`'s own doc for why the
 *  event is now UNCONDITIONAL rather than gated on the label write. */
const POST_ESCALATED_KIND = "concern-post-escalated";

/** #432 round 5: how many times THIS concern (keyed by its stable (round_id, issue, reason)
 *  triple) has failed to post — the count `reconcileDurableConcerns` compares against
 *  `cfg.roles.po.maxConcernPostAttempts` BEFORE attempting another post (see that function's own
 *  doc for why the check now runs first). Pure ledger fold, same shape as `pendingDurableConcerns`
 *  itself; a malformed event is skipped, never thrown. Concerns need no episode-boundary reset
 *  (unlike round.ts's `poolRemovalFailureCount`): the (round_id, issue, reason) key ALREADY scopes
 *  every count to one specific concern instance, and a delivered concern never re-enters
 *  `pendingDurableConcerns` to be counted again — there is no cross-episode collision to guard
 *  against here, only within-episode accumulation. */
function concernPostFailureCount(state: Pick<State, "eventsAfterId">, roundId: number, issue: number, reason: string): number {
  return state.eventsAfterId(0, [POST_FAILED_KIND]).filter((e) => {
    const p = e.payload as { round_id?: unknown; issue?: unknown; reason?: unknown } | null;
    return p?.round_id === roundId && p?.issue === issue && p?.reason === reason;
  }).length;
}

/** #432 round 6 (P1-1/P1-2, gate② third confirm): the DEGRADE-TO-HUMAN terminal for a concern
 *  that has failed to post `cfg.roles.po.maxConcernPostAttempts` times — now a thin wrapper over
 *  the SHARED writer (escalation-writer.ts's `escalateToNeedsHuman`), which fixed the two defects
 *  this file's own round-5 hand-rolled version had: (1) a deterministic label-write failure no
 *  longer suppresses the terminal event — the event is UNCONDITIONAL, carrying `labeled: 0|1`,
 *  so a permanently-unpostable concern whose issue ALSO can't be labelled still unpins the probe;
 *  (2) `reconcileDurableConcerns` now checks the cap BEFORE attempting another post (not after),
 *  so a crash between this function's label write and its event append can never be "rescued" by
 *  a LATER ordinary post succeeding and removing the concern from consideration before the
 *  interrupted escalation gets a chance to complete — see that function's own doc. */
async function escalateUnpostableConcern(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  roundId: number,
  concern: Concern,
): Promise<void> {
  await escalateToNeedsHuman(forge, state, cfg, concern.issue, POST_ESCALATED_KIND, { round_id: roundId, reason: concern.reason });
}

/** Post one concern's idempotent comment, exactly once per (issue, concern-hash) ACROSS ROUNDS
 *  (#237 AC2). The marker check (getIssueComments, read fresh every call) IS the idempotency
 *  boundary — not the durable `concern-posted` event (module doc). The ONLY IForge calls made
 *  here (besides #432 round 5's escalation path above, a SEPARATE terminal-only addLabel) are
 *  getIssueBody, getIssueComments, and addIssueComment (#237 AC3, structural — no label/status/
 *  dispatch write exists in this function itself). A read/write failure degrades to "skip this
 *  concern this pass" — logged, never thrown; if the session raises the same concern again next
 *  round, it retries naturally. #432 round 5: each of the three UNPOSTED failure branches below
 *  also appends `concern-post-failed` (best-effort, contained) — the count
 *  `escalateUnpostableConcern`'s caller compares against the configured cap. */
async function postConcernIfNew(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  roundId: number,
  concern: Concern,
  log: (message: string) => void,
): Promise<void> {
  const recordFailedAttempt = (): void => {
    try {
      state.appendEvent(POST_FAILED_KIND, { round_id: roundId, issue: concern.issue, reason: concern.reason });
    } catch {
      // Best-effort — a lost append merely under-counts this pass toward the cap; the NEXT
      // failed attempt (if any) tries again, and a genuinely stuck concern will still eventually
      // accumulate enough recorded failures to escalate.
    }
  };
  let body: string;
  try {
    body = await forge.getIssueBody(concern.issue);
  } catch (e) {
    log(
      `[sapwood:dissent] round ${roundId}: failed to read #${concern.issue}'s body while posting a concern — ` +
        `skipped this pass: ${String(e)}`,
    );
    recordFailedAttempt();
    return;
  }
  const hash = concernHash(concern.reason, body);
  const marker = concernMarker(concern.issue, hash);
  let comments: { body: string }[];
  try {
    comments = await forge.getIssueComments(concern.issue);
  } catch (e) {
    log(
      `[sapwood:dissent] round ${roundId}: failed to read #${concern.issue}'s comments while posting a concern — ` +
        `skipped this pass: ${String(e)}`,
    );
    recordFailedAttempt();
    return;
  }
  if (comments.some((c) => c.body.includes(marker))) {
    // #237 finding 3: the live marker already exists — a prior attempt (this round or an
    // earlier one) already delivered this exact concern. Reconcile a missing durable receipt
    // HERE (the #216 marker-reconcile paradigm, align.ts's `reconciled` branch) rather than
    // bare-returning, so a crash strictly between the comment landing and the event append
    // never permanently understates status/round-summary bookkeeping.
    let alreadyRecorded: boolean;
    try {
      alreadyRecorded = state.eventsAfterId(0, ["concern-posted"]).some((e) => {
        const p = e.payload as { issue?: unknown; hash?: unknown } | null;
        return p?.issue === concern.issue && p?.hash === hash;
      });
    } catch (e) {
      log(
        `[sapwood:dissent] round ${roundId}: failed to read the concern-posted ledger while reconciling ` +
          `#${concern.issue} — skipped this pass: ${String(e)}`,
      );
      return; // fail closed: an unreadable ledger must not risk a duplicate reconcile append
    }
    if (!alreadyRecorded) {
      try {
        state.appendEvent("concern-posted", {
          round_id: roundId,
          issue: concern.issue,
          reason: concern.reason,
          hash,
          reconciled: true,
        });
      } catch {
        // Best-effort — a later pass reconciles again from the same live marker check.
      }
    }
    return;
  }
  const mentions = cfg.notify.mentions.map((m) => (m.startsWith("@") ? m : `@${m}`));
  const mentionLine = mentions.length > 0 ? `${mentions.join(" ")} ` : "";
  const commentBody =
    `${mentionLine}**PO dissent** (round ${roundId}) — this issue's premise may be wrong:\n\n${concern.reason}\n\n` +
    `_Adjudication is this issue's normal lifecycle: edit the why/what to revise, close or pull it from Ready to ` +
    `adopt the objection, reply to note-and-proceed, or leave it — silence is a valid answer too._\n\n${marker}`;
  try {
    await forge.addIssueComment(concern.issue, commentBody);
  } catch (e) {
    log(
      `[sapwood:dissent] round ${roundId}: failed to post the concern comment for #${concern.issue} — ` + `skipped this pass: ${String(e)}`,
    );
    recordFailedAttempt();
    return;
  }
  try {
    state.appendEvent("concern-posted", { round_id: roundId, issue: concern.issue, reason: concern.reason, hash });
  } catch {
    // Best-effort receipt only (module doc): delivery idempotency is the live marker check
    // above, not this event — a lost append merely costs this concern its round-summary/status
    // visibility until a later pass's marker check reconciles it (see the branch above).
  }
}

/** Every currently OPEN (posted, not yet adjudicated) concern, keyed `${issue}:${hash}` — shared
 *  by the adjudication scan below and `sapwood status` (cli.ts), so the two can never disagree on
 *  what "unadjudicated" means. Pure fold over the durable ledger; a malformed event (missing
 *  issue/hash) is simply skipped, never thrown — same low-stakes-bookkeeping stance this
 *  codebase's other best-effort journals take. */
export function unadjudicatedConcerns(
  events: readonly { kind: string; payload: unknown }[],
): Map<string, { issue: number; reason: string; hash: string }> {
  const posted = new Map<string, { issue: number; reason: string; hash: string }>();
  const adjudicated = new Set<string>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    const issue = p && typeof p.issue === "number" ? p.issue : undefined;
    const hash = p && typeof p.hash === "string" ? p.hash : undefined;
    if (issue === undefined || hash === undefined) continue;
    const key = `${issue}:${hash}`;
    if (e.kind === "concern-posted") {
      posted.set(key, { issue, reason: typeof p?.reason === "string" ? p.reason : "", hash });
    } else if (e.kind === "concern-adjudicated") {
      adjudicated.add(key);
    }
  }
  for (const key of adjudicated) posted.delete(key);
  return posted;
}

/** Re-check every still-open concern against live GitHub state (module doc: closed /
 *  external-reply / body-changed). Each outstanding concern costs at most 3 read-only forge calls
 *  (getIssueMeta, and — only when still open — getIssueBody + getIssueComments); a per-issue read
 *  failure degrades to "left unadjudicated this pass" (logged, never thrown) — a later scan
 *  retries it fresh. #237 finding 5: called UNCONDITIONALLY, once per round, from
 *  round-defaults.ts's aligning wrapper — independent of `roles.po.enabled` and independent of
 *  whether align.ts's own `postConcerns` ran this round at all. */
export async function scanForAdjudication(forge: IForge, state: State, log?: (message: string) => void): Promise<void> {
  const warn = log ?? console.error;
  const events = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
  const open = unadjudicatedConcerns(events);
  for (const c of open.values()) {
    let outcome: string | null = null;
    try {
      const meta = await forge.getIssueMeta(c.issue);
      if (meta.state === "CLOSED") {
        outcome = "closed";
      } else {
        const currentBody = await forge.getIssueBody(c.issue);
        if (concernHash(c.reason, currentBody) !== c.hash) {
          // #237 finding 1: "body-changed", not "issue-edited" — see module doc for why this
          // makes no human-attribution claim (this engine's own writes trigger it too).
          outcome = "body-changed";
        } else {
          const comments = await forge.getIssueComments(c.issue);
          const marker = concernMarker(c.issue, c.hash);
          const markerIndex = comments.findIndex((cm) => cm.body.includes(marker));
          if (markerIndex >= 0 && comments.slice(markerIndex + 1).some((cm) => !isSapwoodComment(cm.body))) {
            // #237 finding 2: "external-reply", not "human-reply" — any non-sapwood-stamped
            // reply (including another bot) satisfies this, module doc.
            outcome = "external-reply";
          }
        }
      }
    } catch (e) {
      warn(`[sapwood:dissent] adjudication scan: failed to check #${c.issue} — left unadjudicated this pass: ${String(e)}`);
      continue;
    }
    if (outcome !== null) {
      try {
        state.appendEvent("concern-adjudicated", { issue: c.issue, hash: c.hash, outcome });
      } catch {
        // Best-effort — a later round's scan re-derives the same outcome and retries the append.
      }
    }
  }
}

/** Post THIS round's freshly validated concerns (idempotent, module doc) — the ONLY half of the
 *  dissent channel align.ts's `createAligningStub` calls; the adjudication scan is a SEPARATE,
 *  unconditional round-level call (`scanForAdjudication`, wired from round-defaults.ts) — #237
 *  finding 5 deliberately decouples the two so the scan runs even when this function doesn't
 *  (roles.po.enabled: false, or align's own internal early-return on a corrupt proposal journal). */
export async function postConcerns(deps: PostConcernsDeps): Promise<void> {
  const log = deps.log ?? console.error;
  for (const concern of deps.concerns) {
    await postConcernIfNew(deps.forge, deps.state, deps.cfg, deps.roundId, concern, log);
  }
}

const DecisionConcernsEventSchema = z
  .object({ round_id: z.number().int().positive(), concerns: z.array(ConcernSchema).optional() })
  .passthrough();
const ConcernReceiptEventSchema = z
  .object({ round_id: z.number().int().positive(), issue: z.number().int().positive(), reason: z.string() })
  .passthrough();

const DECISION_KINDS = ["triage-decision-accepted", "proposal-set-persisted"] as const;
const RECEIPT_KIND = "concern-posted";

/** #237 round-2 adjudication (finding 1): the DURABLE backstop `postConcerns` alone cannot be —
 *  see the module doc's own "finding 1" note for the exact crash window this closes. Reads every
 *  `triage-decision-accepted`/`proposal-set-persisted`/`concern-posted` event on the WHOLE ledger
 *  (never scoped to a single round — that scoping is exactly what makes the in-memory path
 *  fragile) in ONE kind-filtered query (#237 round-3 adjudication — collapsed from two separate
 *  `eventsAfterId` calls, since both read from the SAME table and this codebase's `IN (...)`
 *  clause already lets one query cover multiple kinds at once), splits them apart by `e.kind`,
 *  extracts each decision's embedded `concerns` array, and re-runs `postConcernIfNew` — using THAT
 *  DECISION's OWN `round_id` (#237 finding 2, never the round this sweep happens to run in) — for
 *  every concern that has no matching `concern-posted` receipt yet, keyed by (round_id, issue,
 *  reason): the ONE stable triple both event shapes carry (the hash itself is NOT stable ahead of
 *  time — it depends on the issue's body at whatever moment posting/reconciling actually happens).
 *
 *  Idempotent and safe to call every round, forever: `postConcernIfNew` itself is idempotent (a
 *  live marker match reconciles or no-ops; module doc), and this function's OWN receipt lookup
 *  additionally skips any concern that already has a matching event, so a concern that posted
 *  cleanly the very first time costs this sweep nothing beyond the receipt lookup itself ever
 *  again. #237 round-3 adjudication: a plain index on `events(kind)` (state.ts's schema v17->v18
 *  migration) is what keeps this — and every OTHER kind-filtered `eventsSince`/`eventsAfterId`
 *  call in this codebase — proportional to the number of MATCHING events, not the whole ledger;
 *  a full-ledger-by-kind scan (not an incremental cursor) is still the same "record, not gate"
 *  tradeoff this codebase already accepts elsewhere (e.g. align.ts's own proposalProgress/
 *  triageProgress), now backed by an index rather than a sequential scan — concern volume is
 *  expected to be low (structured objections are rare, not a bulk mechanism) either way, so no
 *  cursor/bookkeeping machinery was added on top of the index (PM ruling). */
/** #432 round 4 (PM adjudication, gate② review 3): the pure-local HALF of
 *  `reconcileDurableConcerns` below, factored out so `round.ts`'s `probeHasWork` can ask "is
 *  there unposted durable-concern work" as a cheap local SQLite read — no forge call, same
 *  economics as `state.pendingRollbacks()`. Dissent intentionally writes NO labels (module doc,
 *  #237 AC3), so this durable-event fact is invisible to every label-driven exemption the probe's
 *  milestone catch-all could ever carry; a decision whose comment-post transiently failed would
 *  otherwise sit unswept until unrelated backlog work happened to wake the loop again.
 *
 *  #432 round 5 (P1-2, the TERMINAL this signal was missing): `POST_ESCALATED_KIND` is folded
 *  into the SAME receipt set `RECEIPT_KIND` (`concern-posted`) uses — both mean "no longer
 *  pending" to this function, one because delivery succeeded, one because
 *  `escalateUnpostableConcern` gave up and handed it to a human after
 *  `cfg.roles.po.maxConcernPostAttempts` recorded failures. A concern that escalates therefore
 *  drops out of BOTH this probe signal and `reconcileDurableConcerns`' own retry loop below in
 *  the same fold, with no separate "already escalated" guard needed. */
export function pendingDurableConcerns(state: State): Array<{ roundId: number; concern: Concern }> {
  const events = state.eventsAfterId(0, [...DECISION_KINDS, RECEIPT_KIND, POST_ESCALATED_KIND]);
  const receiptKeys = new Set<string>();
  const decisionEvents: typeof events = [];
  for (const e of events) {
    if (e.kind === RECEIPT_KIND || e.kind === POST_ESCALATED_KIND) {
      const parsed = ConcernReceiptEventSchema.safeParse(e.payload);
      if (!parsed.success) continue; // malformed receipt — never thrown, just excluded from the "already delivered" set
      receiptKeys.add(`${parsed.data.round_id}:${parsed.data.issue}:${parsed.data.reason}`);
    } else {
      decisionEvents.push(e);
    }
  }
  const pending: Array<{ roundId: number; concern: Concern }> = [];
  for (const e of decisionEvents) {
    const parsed = DecisionConcernsEventSchema.safeParse(e.payload);
    if (!parsed.success) continue; // malformed/pre-#237 decision record — nothing to sweep from it
    for (const concern of parsed.data.concerns ?? []) {
      const key = `${parsed.data.round_id}:${concern.issue}:${concern.reason}`;
      if (!receiptKeys.has(key)) pending.push({ roundId: parsed.data.round_id, concern });
    }
  }
  return pending;
}

/** #432 round 6 (P1-2, gate② third confirm — the crash-window fix): the cap check now runs
 *  BEFORE attempting a post, not after. Round 5 attempted the post first and only re-examined
 *  "still pending" concerns afterward — which meant a concern whose escalation was INTERRUPTED
 *  by a crash (label applied, terminal event lost) could be silently rescued the next time this
 *  function ran: if that later pass's ORDINARY post attempt happened to succeed (the failure that
 *  triggered the cap was transient after all), the concern left `pendingDurableConcerns`
 *  entirely — delivered, not escalated — and the leftover, unproven `needs-human` label was never
 *  looked at again. Checking the cap FIRST closes that window: a concern already at (or past) the
 *  cap from a PRIOR pass is escalated again (idempotent — `escalateToNeedsHuman`'s label write is
 *  a GitHub-side no-op if already applied, and its event append completes whatever the crashed
 *  pass left unfinished) and is never handed to `postConcernIfNew` at all this pass — the ordinary
 *  retry never gets a chance to "rescue" a concern out from under an incomplete escalation.
 *  `pendingDurableConcerns` itself is `reconcileDurableConcerns`'s ONLY idempotence guard for
 *  re-escalation: once `escalateUnpostableConcern` succeeds in landing `concern-post-escalated`,
 *  that concern drops out of the pending set (the SAME fold `pendingDurableConcerns` already
 *  treats it as a terminal receipt for) and this loop never sees it again — no separate
 *  "already escalated" check needed here, unlike round.ts's pool-removal path (see
 *  `poolRemovalEscalated`'s own doc for why THAT signal needs one of its own). Costs exactly the
 *  same ONE `pendingDurableConcerns` query the #237 round-3 "one query" test pins for the common
 *  nothing-pending case (per-concern `concernPostFailureCount` reads only run for concerns that
 *  actually exist to check). */
export async function reconcileDurableConcerns(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  log?: (message: string) => void,
): Promise<void> {
  const warn = log ?? console.error;
  for (const { roundId, concern } of pendingDurableConcerns(state)) {
    const failures = concernPostFailureCount(state, roundId, concern.issue, concern.reason);
    if (failures >= cfg.roles.po.maxConcernPostAttempts) {
      await escalateUnpostableConcern(forge, state, cfg, roundId, concern);
      continue; // capped — a human owns it now; no further post attempts
    }
    await postConcernIfNew(forge, state, cfg, roundId, concern, warn);
  }
}
