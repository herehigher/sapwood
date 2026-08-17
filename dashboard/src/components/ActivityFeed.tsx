import { useState } from "react";
import { copyFor, type EntityToken, hasAttention, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelative } from "../format.ts";
import { EntityRef } from "./EntityRef.tsx";
import { StateGlyph } from "./icons.tsx";

/** #893: a heartbeat/bookkeeping engine kind (`TELEMETRY_KINDS` in copy.ts) — collapsed from the
 *  feed's default view. `event.known` must already be true (an unknown wire kind is neither
 *  narrative nor telemetry; it renders the honest raw fallback, unaffected by this filter). */
function isTelemetryKind(kind: string): boolean {
  return copyFor(kind)?.tier === "telemetry";
}

/** #722: the feed panel gets its own scroll container (`.feed-scroll`, panels.css) rather than
 *  driving the whole page's height, but a scroll container alone still leaves thousands of `<li>`
 *  DOM rows mounted — this caps what actually renders. Newest-first, pinned entries exempt (their
 *  own contract, unchanged). Matches `EVENTS_PAGE` (queries.ts) — one fetched page is a "sane
 *  window" per the issue, no virtualization library needed at this size. */
export const FEED_RENDER_CAP = 200;

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
 *  degrades to plain text, same posture as `EntityRef` — never a guessed URL. Exported so the
 *  needs-attention strip (#361) renders the SAME §7 sentences this feed does, rather than a
 *  second sentence-rendering path. */
export function SentencePartView({ part, titles, repoUrl }: { part: SentencePart; titles: EntityTitles; repoUrl?: string | undefined }) {
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
  const parts: SentencePart[] = event.known ? copyFor(event.kind)!.sentence(payload) : [`Unrecognized event: ${event.kind}`];
  const attention = event.known && hasAttention(event.kind, payload);
  const glyph = event.known ? gateGlyph(event.kind, payload) : null;
  const dotColor = attention ? "var(--rust)" : glyph === true ? "var(--moss)" : "var(--sap)";
  return (
    // #892 AC5: `.recipe-list-entry` (panels.css) is the freshly-appended-row recipe — a feed
    // entry is exactly that (a newest-first row that mounts on every fresh event).
    <li className={attention ? "feed-entry feed-entry-attention recipe-list-entry" : "feed-entry recipe-list-entry"}>
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
  // #893: telemetry (heartbeat/bookkeeping) rows are collapsed from the default view — the feed
  // shows narrative, telemetry is opt-in. A pinned attention row is never telemetry-tier (every
  // COPY entry carrying `attention` is narrative), so this has no interaction with the pin
  // contract below.
  const [showTelemetry, setShowTelemetry] = useState(false);
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
  // pre-strip feed convention). #361 landed the dedicated needs-attention strip alongside this —
  // that surface is now the primary place to see what's open; this feed keeps its own pin too,
  // since the pinned item is still a real feed entry and the feed reads fine on its own.
  // `pinnedAttention` is the caller's DURABLE fold (`foldOpenAttention`, over the whole history,
  // never bounded by `events`' display window — #715 gate② [0]): an escalation that ages out of
  // the recent window must still stay pinned until its own resolution clears it, which a fold
  // computed only from the bounded `events` array could never guarantee. Dedupe by id against the
  // bounded window — a pinned item that is ALSO still within the recent window must render once,
  // in its pinned position, not twice.
  const pinnedIds = new Set(pinnedAttention.map((e) => e.id));
  const pinned = [...pinnedAttention].sort((a, b) => b.id - a.id);
  const nonPinned = events.filter((e) => !pinnedIds.has(e.id));
  // #893: honest disclosure count — computed from the FULL non-pinned set regardless of the
  // toggle's current state, so the "N telemetry event(s)" wording never goes stale mid-toggle.
  const telemetryCount = nonPinned.filter((e) => e.known && isTelemetryKind(e.kind)).length;
  const rest = (showTelemetry ? nonPinned : nonPinned.filter((e) => !(e.known && isTelemetryKind(e.kind)))).sort((a, b) => b.id - a.id);
  const total = pinned.length + rest.length;
  // Pinned entries are exempt from the cap (their own durable contract, #715 gate② [0]) — an open
  // escalation must never be silently dropped by the display cap. That means `pinned.length` alone
  // can exceed `FEED_RENDER_CAP` (#722 gate② [0] pinned-bypasses-cap) — the cap is intentionally
  // blown to keep every pin visible, and the disclosure below says so rather than staying silent.
  const visibleRest = rest.slice(0, Math.max(0, FEED_RENDER_CAP - pinned.length));
  const rendered = [...pinned, ...visibleRest];
  // PR #900 gate② finding [0] (telemetry-visible-count): `telemetryCount` is the FULL non-pinned
  // count, computed before FEED_RENDER_CAP truncates `rest` into `visibleRest` — with the toggle
  // on, the disclosure must say how many telemetry rows actually rendered (`rendered`), never the
  // pre-cap total, or "showing 201" can describe a view that only rendered 200 (or, with 200+
  // pinned rows alone exceeding the cap, zero). With the toggle off this distinction is moot —
  // `telemetryCount` IS the render-independent "how many are hidden" fact, since none render
  // either way — so only the shown-state message reads off `renderedTelemetryCount`.
  const renderedTelemetryCount = showTelemetry ? rendered.filter((e) => e.known && isTelemetryKind(e.kind)).length : 0;
  const pinnedExceedsCap = pinned.length > FEED_RENDER_CAP;
  const restTruncated = rendered.length < total;
  // A pinned row need not be among the newest — mixing it into a capped render breaks the "latest
  // N" framing, so the note names the pinned exception instead of implying pure recency ordering.
  let capNote: string | null = null;
  if (pinnedExceedsCap) {
    capNote = `showing all ${rendered.length} — ${pinned.length} pinned exceed the ${FEED_RENDER_CAP}-row display cap`;
  } else if (restTruncated) {
    capNote =
      pinned.length > 0
        ? `showing ${rendered.length} of ${total} — ${pinned.length} pinned always included, latest ${visibleRest.length} of ${rest.length} routine`
        : `showing latest ${rendered.length} of ${total}`;
  }
  return (
    <section className="panel activity-feed" aria-label="activity">
      <h2>activity</h2>
      {capNote && <p className="muted feed-cap-note">{capNote}</p>}
      {telemetryCount > 0 && (
        <p className="muted feed-telemetry-note">
          {showTelemetry
            ? renderedTelemetryCount === telemetryCount
              ? `showing ${telemetryCount} telemetry event(s) (heartbeats, bookkeeping)`
              : `showing ${renderedTelemetryCount} of ${telemetryCount} telemetry event(s) (heartbeats, bookkeeping) — the rest are excluded by the ${FEED_RENDER_CAP}-row display cap`
            : `${telemetryCount} telemetry event(s) hidden (heartbeats, bookkeeping)`}{" "}
          <button type="button" className="feed-telemetry-toggle" onClick={() => setShowTelemetry((v) => !v)}>
            {showTelemetry ? "hide" : "show"}
          </button>
        </p>
      )}
      <div className="feed-scroll">
        <ul aria-live="polite" className="feed-list">
          {rendered.map((event) => (
            <FeedEntry key={event.id} event={event} titles={titles} repoUrl={repoUrl} now={clock} />
          ))}
        </ul>
      </div>
    </section>
  );
}
