import { COPY, type EntityToken, hasAttention, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelative } from "../format.ts";
import { EntityRef } from "./EntityRef.tsx";
import { StateGlyph } from "./icons.tsx";

export interface ActivityFeedProps {
  /** The bounded recent window — routine display, newest-first, capped for memory. `DomainEvent`,
   *  not the raw wire `LoopEvent` (#715 gate② round 5 [0]) — the parse boundary that classifies a
   *  wire kind against copy.ts's closed `EventKind` union has already run (`queries.ts`'s
   *  `accumulateEventsPage`) by the time events reach this component. */
  events: DomainEvent[];
  /** Durable, NEVER bounded by the display window (§715 gate② [0]) — `useEventHistory`'s
   *  `foldOpenAttention` accumulator, folded incrementally over the WHOLE history so an
   *  escalation that ages out of `events` stays pinned until its own resolution clears it. */
  pinnedAttention: DomainEvent[];
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

function FeedEntry({ event, titles, repoUrl, now }: { event: DomainEvent; titles: EntityTitles; repoUrl?: string | undefined; now: Date }) {
  // #715 gate② round 4 [4]: a corrupt legacy row's payload is served as `null`, never an object
  // (state.ts's eventsPage) — normalize once so every dereference below (the sentence, the
  // attention predicate, the gate glyph) sees an honest empty object instead of crashing.
  const payload = event.payload ?? {};
  // #715 gate② round 5 [0]: the unknown-wire-kind case is an explicit, typed branch — not a
  // `copyFor` lookup returning `undefined` for any old reason. `event.known` was decided once, at
  // the parse boundary (`domain-event.ts`'s `toDomainEvent`); a KNOWN event indexes `COPY`
  // directly (`event.kind` is genuinely `EventKind` here, so the lookup can never miss), and an
  // UNKNOWN one — a real possibility per §8 (a newer engine may emit a kind this build hasn't
  // shipped a copy entry for yet) — renders the same honest fallback sentence it always has,
  // never crashing and never hiding the row.
  const parts: SentencePart[] = event.known ? COPY[event.kind].sentence(payload) : [`Unrecognized event: ${event.kind}`];
  const attention = event.known && hasAttention(event.kind, payload);
  const glyph = event.known ? gateGlyph(event.kind, payload) : null;
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
