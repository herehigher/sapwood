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
//   - the issue closed -> outcome "closed". Attributable to a human act (closing/merging is not
//     an engine write path this module or align.ts's PO ever takes).
//   - a comment landed AFTER the concern comment that does NOT itself carry a `<!-- sapwood:`
//     marker (this engine's own universal comment-marker convention, centrally stamped on EVERY
//     comment this engine posts at the forge write boundary — see forge.ts's
//     ENGINE_COMMENT_MARKER) -> outcome "external-reply". #237 finding 2 (2026-07-18
//     adjudication): renamed from "human-reply" — a reply from ANY non-sapwood-stamped actor
//     (another bot, e.g. Codex's own review comments, not only a human) satisfies this check; it
//     is a content check, not an identity check, and makes no claim about WHO replied beyond
//     "not this engine."
//   - its body no longer hashes to the concern's own recorded hash -> outcome "body-changed".
//     #237 finding 1 (2026-07-18 adjudication): renamed from "issue-edited" — this outcome makes
//     NO claim about who changed the body. This engine's OWN writes (a later triage pass drafting
//     a plan into the same issue, a plan-reviewer/drafter revision, ...) trigger it exactly like
//     a human edit would; there is no provenance tracking here to tell them apart, deliberately
//     (PM ruling, marginal-complexity: a bounded blind spot with this honesty note, not new
//     machinery). Consequently "body-changed" is EXCLUDED from any human-activity/precision-
//     metric semantics a future consumer might build on `concern-adjudicated` — only "closed" and
//     "external-reply" are human/external-attributable. The self-heal for "body-changed" is
//     RE-RAISE, not re-read: this event only ever resolves the OLD (now-stale) marker; if the PO
//     still holds the concern, a LATER round's session raises the SAME worded concern again,
//     which hashes against the (now current) body, produces a NEW marker, and reposts with a
//     fresh mention — never silently re-adopting the old marker's already-closed state.
//   - "adopted" (an issue pulled from Ready without closing) is NOT detected here: #237 finding 5
//     (2026-07-18 adjudication) — IForge has no cheap read of board-status/lane membership this
//     module could use without adding new forge surface, and the PM ruling was not to build one
//     for this. Pulling a concerned issue from Ready without ever closing it is therefore
//     observed only INDIRECTLY here (typically as "body-changed", if the pull came with an edit,
//     or not at all if it didn't) — never as its own "adopted" outcome. Documented as a narrowed
//     lifecycle claim, not a gap to silently paper over.
// This module never runs an ack protocol and never gates on a reply's CONTENT — only its
// presence/absence and authorship-by-marker.
//
// #237 finding 5 (2026-07-18 adjudication): the scan must run EVERY round regardless of
// `roles.po.enabled` and regardless of align.ts's own internal early-returns (e.g. a corrupt
// proposal journal) — it is NOT part of `postConcerns` below. round-defaults.ts's aligning
// wrapper calls `scanForAdjudication` directly, unconditionally, decoupled from whether
// `alignStub.run` (which owns `postConcerns`, since only IT knows this round's freshly validated
// concerns) ran at all this round.
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

/** Post one concern's idempotent comment, exactly once per (issue, concern-hash) ACROSS ROUNDS
 *  (#237 AC2). The marker check (getIssueComments, read fresh every call) IS the idempotency
 *  boundary — not the durable `concern-posted` event (module doc). The ONLY IForge calls made
 *  here are getIssueBody, getIssueComments, and addIssueComment (#237 AC3, structural — no
 *  label/status/dispatch write exists in this function at all). A read/write failure degrades to
 *  "skip this concern this pass" — logged, never thrown; if the session raises the same concern
 *  again next round, it retries naturally. */
async function postConcernIfNew(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  roundId: number,
  concern: Concern,
  log: (message: string) => void,
): Promise<void> {
  let body: string;
  try {
    body = await forge.getIssueBody(concern.issue);
  } catch (e) {
    log(
      `[sapwood:dissent] round ${roundId}: failed to read #${concern.issue}'s body while posting a concern — ` +
        `skipped this pass: ${String(e)}`,
    );
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
