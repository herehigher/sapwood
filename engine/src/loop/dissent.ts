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
// and the concerned issue's CURRENT body, not the wording alone. A human editing the issue's
// why/what after a concern was posted therefore changes the hash the NEXT time this same worded
// concern is raised, so the marker check below (postConcernIfNew) finds no match and reposts it
// — "the question naturally reopens" (issue #237's own wording). Without the body in the hash, an
// edited issue would silently suppress a still-applicable objection forever.
//
// Delivery idempotency is the LIVE marker check itself (getIssueComments, read fresh on every
// call) — NOT the durable `concern-posted` event. A crash strictly between addIssueComment
// landing and that event's append still finds the marker on a later pass and skips reposting;
// the durable event exists purely for bookkeeping (round-summary "objections raised" —
// round-artifact.ts — and status's unadjudicated count — cli.ts), so losing it costs visibility,
// never correctness.
//
// Adjudication (#237 item 5) is the issue's OWN GitHub lifecycle, never a dedicated ack
// protocol: this module's only additional machinery is a per-round scan (processConcerns, called
// unconditionally from align.ts's createAligningStub, gated by the SAME phase marker every other
// aligning-phase write already is) that checks every still-open concern against live GitHub
// state and appends `concern-adjudicated` the moment ANY of the following is observed:
//   - the issue closed (adopted/dropped) -> outcome "closed"
//   - its body no longer hashes to the concern's own recorded hash (a human edited why/what,
//     see the hash note above) -> outcome "issue-edited"
//   - a comment landed AFTER the concern comment that does NOT itself carry a `<!-- sapwood:`
//     marker (this engine's own universal comment-marker convention — every comment it ever
//     posts, this file's included, ends in one) -> outcome "human-reply"
// This is a CONTENT check, not an identity check — no new "engine login" config concept is
// introduced to tell a human comment from the engine's own; the existing marker convention
// already distinguishes them for free.
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
 *  session — the rendered backlog-digest subset, plus the triage target issue itself for
 *  triage-mode sessions), never the full open backlog: a concern about an issue the session was
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

/** #237 AC5: hashes BOTH the concern's own wording and the concerned issue's CURRENT body — see
 *  the module doc's "Marker hash" note for why the body must be included. */
export function concernHash(reason: string, issueBody: string): string {
  return sha16(JSON.stringify({ reason, body: issueBody }));
}

export function concernMarker(issue: number, hash: string): string {
  return `<!-- sapwood:concern:${issue}:${hash} -->`;
}

/** Every comment this engine ever posts ends in a `<!-- sapwood:...-->` marker of some kind
 *  (align.ts's proposal/triage/round markers, harvest.ts's round marker, this file's own concern
 *  marker) — so a comment WITHOUT one is, by construction, never one of this engine's own. The
 *  adjudication scan below uses this to recognize a human reply with no new identity concept. */
export function isSapwoodComment(body: string): boolean {
  return body.includes("<!-- sapwood:");
}

export interface ProcessConcernsDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  roundId: number;
  /** Freshly validated concerns from THIS round's align/triage session(s) — already bounds-
   *  checked against each session's own injected view (align.ts's validateConcerns call sites).
   *  May be empty; the adjudication scan below still runs unconditionally. */
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
    return; // already delivered this exact (issue, hash) in a prior round/attempt — no repost
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
    // visibility until a later concern-posted append for the SAME (issue, hash) succeeds (e.g.
    // a future round's re-validation of the same still-unedited concern).
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

/** Re-check every still-open concern against live GitHub state, once per round (module doc). Each
 *  outstanding concern costs at most 3 read-only forge calls (getIssueMeta, and — only when still
 *  open — getIssueBody + getIssueComments); a per-issue read failure degrades to "left
 *  unadjudicated this pass" (logged, never thrown) — a later round's scan retries it fresh. */
async function scanForAdjudication(forge: IForge, state: State, log: (message: string) => void): Promise<void> {
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
          outcome = "issue-edited";
        } else {
          const comments = await forge.getIssueComments(c.issue);
          const marker = concernMarker(c.issue, c.hash);
          const markerIndex = comments.findIndex((cm) => cm.body.includes(marker));
          if (markerIndex >= 0 && comments.slice(markerIndex + 1).some((cm) => !isSapwoodComment(cm.body))) {
            outcome = "human-reply";
          }
        }
      }
    } catch (e) {
      log(`[sapwood:dissent] adjudication scan: failed to check #${c.issue} — left unadjudicated this pass: ${String(e)}`);
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

/** Entry point: post THIS round's freshly validated concerns (idempotent, module doc), then
 *  re-check every still-open concern (any round) against live GitHub state. Called
 *  unconditionally once per round from align.ts's createAligningStub, gated by the SAME phase
 *  marker every other aligning-phase write already is. */
export async function processConcerns(deps: ProcessConcernsDeps): Promise<void> {
  const log = deps.log ?? console.error;
  for (const concern of deps.concerns) {
    await postConcernIfNew(deps.forge, deps.state, deps.cfg, deps.roundId, concern, log);
  }
  await scanForAdjudication(deps.forge, deps.state, log);
}
