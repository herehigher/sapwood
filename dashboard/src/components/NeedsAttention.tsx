import { COPY, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import type { EntityTitles } from "../entities.ts";
import { formatRelativeWithAbsoluteTitle } from "../format-time.ts";
import { SentencePartView } from "./ActivityFeed.tsx";

export interface NeedsAttentionProps {
  /** The caller's durable `foldOpenAttention` result (`useEventHistory().openAttention`) —
   *  membership and clearing both live in `copy.ts`/`entities.ts`; this component renders
   *  whatever is currently open, never re-deriving that set (#361 AC: "membership lives in
   *  copy.ts, never a second list"). */
  items: DomainEvent[];
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now?: Date;
}

function AttentionRow({
  event,
  titles,
  repoUrl,
  now,
}: {
  event: DomainEvent;
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now: Date;
}) {
  const payload = event.payload ?? {};
  const parts: SentencePart[] = event.known ? COPY[event.kind].sentence(payload) : [`Unrecognized event: ${event.kind}`];
  const { text, title } = formatRelativeWithAbsoluteTitle(event.ts, "local", now);
  return (
    <li className="attention-row">
      <span className="attention-sentence">
        {parts.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sentence parts are a fixed-order render list, not reorderable data
          <span key={i}>
            <SentencePartView part={part} titles={titles} repoUrl={repoUrl} />
          </span>
        ))}
      </span>
      <span className="muted data attention-ts" title={title}>
        {text}
      </span>
    </li>
  );
}

/**
 * frontend-design.md §3's "needs attention strip" — a conditional band rendered only when
 * something waits on a person; zero height otherwise, so the calm default stays calm. Rows are
 * driven entirely by the caller's `openAttention` fold (copy.ts's `attention` markers +
 * entities.ts's clearing rules) — this component owns no membership or clearing logic of its
 * own (#361 AC).
 */
export function NeedsAttention({ items, titles, repoUrl, now }: NeedsAttentionProps) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => b.id - a.id);
  const clock = now ?? new Date();
  return (
    <section className="panel needs-attention" aria-label="needs attention">
      <h2>needs attention</h2>
      <ul aria-live="polite" className="attention-list">
        {sorted.map((event) => (
          <AttentionRow key={event.id} event={event} titles={titles} repoUrl={repoUrl} now={clock} />
        ))}
      </ul>
    </section>
  );
}
