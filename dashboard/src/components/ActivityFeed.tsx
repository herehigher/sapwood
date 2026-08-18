import { useState } from "react";
import type { Round } from "../api/types.ts";
import { copyFor, type EntityToken, hasAttention, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelative } from "../format.ts";
import { formatAbsoluteTime } from "../format-time.ts";
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
 *  DOM rows mounted — this caps what actually renders. Newest-first, applied WITHIN the round in
 *  view (#934 — a round's own event count is normally far below this). Matches `EVENTS_PAGE`
 *  (queries.ts) — one fetched page is a "sane window" per the issue, no virtualization library
 *  needed at this size. */
export const FEED_RENDER_CAP = 200;

export interface ActivityFeedProps {
  /** The round-in-view's own events. `DomainEvent`, not the raw wire `LoopEvent` (#715 gate②
   *  round 5 [0]) — the parse boundary that classifies a wire kind against copy.ts's closed
   *  `EventKind` union has already run (`queries.ts`'s `accumulateEventsPage`) by the time events
   *  reach this component. #934: sourced from the same durable per-round fetch §3 E's round
   *  panel/cost strip already use — LIVE the round's own `/api/rounds`-scoped events, REPLAY/
   *  `?demo` that round's events up to the replay cursor (§11's as-of-cursor rule) — never a
   *  client-side filter of the bounded live tail, which would silently truncate a round longer
   *  than that window. */
  events: DomainEvent[];
  /** The round the header's navigator is currently showing (#889 is the pager; this component
   *  renders no pager of its own) — LIVE the open round, or the last closed one while the engine
   *  is idle/standby; REPLAY/`?demo` the selected round. `null` only when no round exists yet at
   *  all (fresh DB) — the feed then renders the idle caption instead of a divider. Drives the
   *  "ROUND N · started · n events" divider; `round.eventCount` (not `events.length`) is the
   *  divider's count — the round's own full total, unaffected by the telemetry toggle or the
   *  render cap below. */
  round: Round | null;
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
  const dotColor = attention ? "var(--rust)" : glyph === true ? "var(--moss)" : "var(--sap-fill)";
  // #924 AC3: only the --sap-fill dot needs the light-theme 1px --sap-text boundary — --rust/
  // --moss are both light-dark() (they already darken per theme, clearing 3:1 against the ground
  // unaided), unlike the flat --sap-fill.
  const dotBorder = dotColor === "var(--sap-fill)" ? "1px solid var(--sap-fill-outline)" : "none";
  return (
    // #892 AC5: `.recipe-list-entry` (panels.css) is the freshly-appended-row recipe — a feed
    // entry is exactly that (a newest-first row that mounts on every fresh event).
    <li className={attention ? "feed-entry feed-entry-attention recipe-list-entry" : "feed-entry recipe-list-entry"}>
      <span className="feed-dot" style={{ background: dotColor, border: dotBorder }} aria-hidden="true" />
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

export function ActivityFeed({ events, round, titles, repoUrl, disconnected, now }: ActivityFeedProps) {
  const clock = now ?? new Date();
  // #893: telemetry (heartbeat/bookkeeping) rows are collapsed from the default view — the feed
  // shows narrative, telemetry is opt-in.
  const [showTelemetry, setShowTelemetry] = useState(false);
  if (disconnected) {
    return (
      <section className="panel activity-feed" aria-label="activity">
        <div className="panel-head">
          <h2>activity</h2>
        </div>
        <p className="muted" style={{ color: "var(--rust)" }}>
          disconnected — restart sapwood to reconnect
        </p>
      </section>
    );
  }
  // #934: no round in view at all (fresh DB, nothing has ever run) is the only honest "nothing to
  // show" case now — once a round exists, an empty `events` (its own fetch still loading, or a
  // round that has genuinely produced nothing yet) still renders the panel + divider below rather
  // than this caption, so a resolving per-round fetch never flashes the idle message.
  if (events.length === 0 && round === null) {
    return (
      <section className="panel activity-feed" aria-label="activity">
        <div className="panel-head">
          <h2>activity</h2>
        </div>
        <p className="muted">Waiting for the first dispatch — point sapwood at a Ready issue</p>
      </section>
    );
  }
  // #893: honest disclosure count — computed from the full round-in-view set regardless of the
  // toggle's current state, so the "N telemetry event(s)" wording never goes stale mid-toggle.
  const telemetryCount = events.filter((e) => e.known && isTelemetryKind(e.kind)).length;
  const rest = (showTelemetry ? events : events.filter((e) => !(e.known && isTelemetryKind(e.kind)))).sort((a, b) => b.id - a.id);
  // #934: FEED_RENDER_CAP is now a plain within-round safety cap — no pinned exception to carve
  // out (the strip is the sole "open items" surface — #934's own "Why").
  const rendered = rest.slice(0, FEED_RENDER_CAP);
  // PR #900 gate② finding [0] (telemetry-visible-count): `telemetryCount` is the FULL round-in-view
  // count, computed before FEED_RENDER_CAP truncates `rest` into `rendered` — with the toggle on,
  // the disclosure must say how many telemetry rows actually rendered, never the pre-cap total, or
  // "showing 201" can describe a view that only rendered 200. With the toggle off this distinction
  // is moot — `telemetryCount` IS the render-independent "how many are hidden" fact, since none
  // render either way — so only the shown-state message reads off `renderedTelemetryCount`.
  const renderedTelemetryCount = showTelemetry ? rendered.filter((e) => e.known && isTelemetryKind(e.kind)).length : 0;
  const restTruncated = rendered.length < rest.length;
  const capNote: string | null = restTruncated ? `showing latest ${rendered.length} of ${rest.length}` : null;
  return (
    <section className="panel activity-feed" aria-label="activity">
      <div className="panel-head">
        <h2>activity</h2>
      </div>
      {round && (
        <p className="muted data feed-round-divider">
          ROUND {round.roundId} · {formatAbsoluteTime(round.startedAt)} · {round.eventCount} events
        </p>
      )}
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
