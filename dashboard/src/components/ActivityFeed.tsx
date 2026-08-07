import type { LoopEvent } from "../api/types.ts";
import { copyFor, type EntityToken, hasAttention, type SentencePart } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelative } from "../format.ts";
import { EntityRef } from "./EntityRef.tsx";
import { StateGlyph } from "./icons.tsx";

export interface ActivityFeedProps {
  /** The bounded recent window — routine display, newest-first, capped for memory. */
  events: LoopEvent[];
  /** Durable, NEVER bounded by the display window (§715 gate② [0]) — `useEventHistory`'s
   *  `foldOpenAttention` accumulator, folded incrementally over the WHOLE history so an
   *  escalation that ages out of `events` stays pinned until its own resolution clears it. */
  pinnedAttention: LoopEvent[];
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

/** Renders one `SentencePart` — string, entity token, or doc link (#715 gate② [0]:
 *  `engine-review-containment-gap`'s link to the security guide). A link with no known `repoUrl`
 *  degrades to plain text, same posture as `EntityRef` — never a guessed URL. */
function SentencePartView({ part, titles, repoUrl }: { part: SentencePart; titles: EntityTitles; repoUrl?: string | undefined }) {
  if (typeof part === "string") return <>{part}</>;
  if (part.kind === "link") {
    if (!repoUrl) return <span>{part.label}</span>;
    return (
      <a href={`${repoUrl}/blob/main/${part.path}`} target="_blank" rel="noreferrer">
        {part.label}
      </a>
    );
  }
  return <EntityRef token={part as EntityToken} titles={titles} repoUrl={repoUrl} />;
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
        {parts.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sentence parts are a fixed-order render list, not reorderable data
          <span key={i}>
            <SentencePartView part={part} titles={titles} repoUrl={repoUrl} />
          </span>
        ))}
      </span>
      <span className="muted data feed-ts">{formatRelative(event.ts, now)}</span>
      <details className="feed-details">
        <summary className="muted">details</summary>
        <pre className="data">{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </li>
  );
}

export function ActivityFeed({ events, pinnedAttention, titles, repoUrl, disconnected, now }: ActivityFeedProps) {
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
  if (events.length === 0 && pinnedAttention.length === 0) {
    return (
      <section className="panel activity-feed" aria-label="activity">
        <h2>activity</h2>
        <p className="muted">Waiting for the first dispatch — point sapwood at a Ready issue</p>
      </section>
    );
  }
  // Needs-human-class events pin to the top until their own resolution clears them (§3's
  // pre-strip feed convention, still this component's own contract until #361 lands).
  // `pinnedAttention` is the caller's DURABLE fold (`foldOpenAttention`, over the whole history,
  // never bounded by `events`' display window — #715 gate② [0]): an escalation that ages out of
  // the recent window must still stay pinned until its own resolution clears it, which a fold
  // computed only from the bounded `events` array could never guarantee. Dedupe by id against the
  // bounded window — a pinned item that is ALSO still within the recent window must render once,
  // in its pinned position, not twice.
  const pinnedIds = new Set(pinnedAttention.map((e) => e.id));
  const pinned = [...pinnedAttention].sort((a, b) => b.id - a.id);
  const rest = events.filter((e) => !pinnedIds.has(e.id)).sort((a, b) => b.id - a.id);
  return (
    <section className="panel activity-feed" aria-label="activity">
      <h2>activity</h2>
      <ul aria-live="polite" className="feed-list">
        {[...pinned, ...rest].map((event) => (
          <FeedEntry key={event.id} event={event} titles={titles} repoUrl={repoUrl} now={clock} />
        ))}
      </ul>
    </section>
  );
}
