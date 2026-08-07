import type { LoopEvent } from "../api/types.ts";
import { copyFor, type EntityToken, hasAttention } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelative } from "../format.ts";
import { EntityRef } from "./EntityRef.tsx";
import { StateGlyph } from "./icons.tsx";

export interface ActivityFeedProps {
  events: LoopEvent[];
  titles: EntityTitles;
  repoUrl?: string | undefined;
  disconnected?: boolean;
  now?: Date;
}

/** Gate-resolution / failure glyph (§5 quality floor: color is never the sole carrier) for the
 *  feed entries that ARE gate resolutions or failure-class escalations. `null` for every other
 *  (routine/informational) kind — the glyph is reserved for outcomes, not decoration. */
function gateGlyph(kind: string, payload: Record<string, unknown>): boolean | null {
  if (kind === "engine-review-verdict") return payload.outcome === "approved";
  if (kind === "merged") return true;
  if (hasAttention(kind, payload)) return false;
  return null;
}

function FeedEntry({ event, titles, repoUrl, now }: { event: LoopEvent; titles: EntityTitles; repoUrl?: string | undefined; now: Date }) {
  const entry = copyFor(event.kind);
  const parts = entry ? entry.sentence(event.payload) : [`Unrecognized event: ${event.kind}`];
  const attention = hasAttention(event.kind, event.payload);
  const glyph = gateGlyph(event.kind, event.payload);
  const dotColor = attention ? "var(--rust)" : glyph === true ? "var(--moss)" : "var(--sap)";
  return (
    <li className={attention ? "feed-entry feed-entry-attention" : "feed-entry"}>
      <span className="feed-dot" style={{ background: dotColor }} aria-hidden="true" />
      {glyph !== null && <StateGlyph ok={glyph} className={glyph ? "glyph-ok" : "glyph-fail"} />}
      <span className="feed-sentence">
        {parts.map((part, i) =>
          typeof part === "string" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: sentence parts are a fixed-order render list, not reorderable data
            <span key={i}>{part}</span>
          ) : (
            <EntityRef key={`${part.kind}-${part.number}`} token={part as EntityToken} titles={titles} repoUrl={repoUrl} />
          ),
        )}
      </span>
      <span className="muted data feed-ts">{formatRelative(event.ts, now)}</span>
      <details className="feed-details">
        <summary className="muted">details</summary>
        <pre className="data">{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </li>
  );
}

export function ActivityFeed({ events, titles, repoUrl, disconnected, now }: ActivityFeedProps) {
  const clock = now ?? new Date();
  if (disconnected) {
    return (
      <section className="panel activity-feed" aria-label="activity">
        <h2>activity</h2>
        <p className="muted" style={{ color: "var(--rust)" }}>
          disconnected — restart sapwood to reconnect
        </p>
      </section>
    );
  }
  if (events.length === 0) {
    return (
      <section className="panel activity-feed" aria-label="activity">
        <h2>activity</h2>
        <p className="muted">Waiting for the first dispatch — point sapwood at a Ready issue</p>
      </section>
    );
  }
  // Needs-human-class events pin to the top until a newer escalation supersedes them (§3's
  // pre-strip feed convention, still this component's own contract until #361 lands): partition
  // by attention, sort each subset newest-first, and render the attention subset first — a newer
  // NON-escalation event never displaces an older, still-open escalation.
  //
  // "Superseded": a NEWER `escalation-resolved` for the SAME issue unpins it (§3's own
  // clearing-semantics prose — "since #295, when escalation-resolved reports the human resolved
  // it outside the loop entirely"). This is the one clearing signal narrow enough to apply safely
  // here without re-deriving the engine's full `attentionProof`/per-kind clearing rules (worktree
  // custody, park episodes, …) — that fuller reconciliation is #361's job, which imports the
  // engine's own function rather than re-encoding it a second time. An attention event with no
  // `issue` in its payload (e.g. `ceiling-escalated`, `park-escalated`) is never issue-scoped, so
  // it is never a candidate `escalation-resolved` clears — it stays pinned.
  const resolvedIssues = new Map<number, number>(); // issue -> newest escalation-resolved id
  for (const e of events) {
    if (e.kind !== "escalation-resolved") continue;
    const issue = e.payload.issue;
    if (typeof issue !== "number") continue;
    resolvedIssues.set(issue, Math.max(e.id, resolvedIssues.get(issue) ?? -Infinity));
  }
  const isSuperseded = (e: LoopEvent): boolean => {
    const issue = e.payload.issue;
    if (typeof issue !== "number") return false;
    const resolvedAt = resolvedIssues.get(issue);
    return resolvedAt !== undefined && resolvedAt > e.id;
  };
  const attention = events.filter((e) => hasAttention(e.kind, e.payload) && !isSuperseded(e)).sort((a, b) => b.id - a.id);
  const rest = events.filter((e) => !hasAttention(e.kind, e.payload) || isSuperseded(e)).sort((a, b) => b.id - a.id);
  return (
    <section className="panel activity-feed" aria-label="activity">
      <h2>activity</h2>
      <ul aria-live="polite" className="feed-list">
        {[...attention, ...rest].map((event) => (
          <FeedEntry key={event.id} event={event} titles={titles} repoUrl={repoUrl} now={clock} />
        ))}
      </ul>
    </section>
  );
}
