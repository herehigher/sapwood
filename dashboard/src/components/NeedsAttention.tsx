import { attentionCategory, COPY, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import { attentionSummary, type EntityTitles } from "../entities.ts";
import { formatRelativeWithAbsoluteTitle } from "../format-time.ts";
import { ATTENTION_KIND_TO_NODE, type StageNode } from "../inspector.ts";
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
  /** §6 phase inspector (#861) — AC7: only the three `ATTENTION_KIND_TO_NODE` kinds render an
   *  "inspect" control at all; absent entirely leaves every row exactly as it renders today. */
  onInspect?: ((node: StageNode) => void) | undefined;
  /**
   * #891 AC2: `hero/state.ts`'s `HeroState.roundEscalated` — this round's raw, never-decremented
   * escalation-event count. Used ONLY to tell "nothing has escalated" apart from "everything
   * that escalated is already resolved" when `items` is empty: the first is the calm default
   * (renders nothing), the second renders the reconciliation sentence instead of going silently
   * empty right after real activity. `0`/absent behaves exactly like before #891.
   */
  roundEscalated?: number;
}

function AttentionRow({
  event,
  titles,
  repoUrl,
  now,
  onInspect,
}: {
  event: DomainEvent;
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now: Date;
  onInspect?: ((node: StageNode) => void) | undefined;
}) {
  const payload = event.payload ?? {};
  const parts: SentencePart[] = event.known ? COPY[event.kind].sentence(payload) : [`Unrecognized event: ${event.kind}`];
  const { text, title } = formatRelativeWithAbsoluteTitle(event.ts, "local", now);
  const node = event.known ? ATTENTION_KIND_TO_NODE[event.kind] : undefined;
  // #881: the mockup's category-chip taxonomy — absent for an unrecognized kind (no fallback
  // fabricated) rather than rendering an empty/misleading chip.
  const category = event.known ? attentionCategory(event.kind) : undefined;
  return (
    <li className="attention-row">
      {category && <span className="attention-chip">{category}</span>}
      <span className="attention-sentence">
        {parts.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sentence parts are a fixed-order render list, not reorderable data
          <span key={i}>
            <SentencePartView part={part} titles={titles} repoUrl={repoUrl} />
          </span>
        ))}
      </span>
      {/* AC7: a SIBLING control, never nested inside the sentence's own GitHub anchor — each
       *  independently focusable with its own accessible name. */}
      {node && onInspect && (
        <button type="button" className="attention-inspect" aria-label={`inspect ${node}`} onClick={() => onInspect(node)}>
          inspect
        </button>
      )}
      <span className="muted data attention-ts attention-age" title={title}>
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
export function NeedsAttention({ items, titles, repoUrl, now, onInspect, roundEscalated = 0 }: NeedsAttentionProps) {
  const clock = now ?? new Date();

  if (items.length === 0) {
    // #891 AC2: the fold is empty, but this round DID escalate something — an unexplained empty
    // strip right after real activity reads as a bug, not as "all clear". Named honestly as a
    // reconciliation between the two numbers, not a row of its own (there is nothing left open
    // to list).
    if (roundEscalated === 0) return null;
    return (
      <section className="panel needs-attention" aria-label="needs attention">
        <h2>needs attention</h2>
        <p className="muted attention-reconciled">
          {roundEscalated} escalation{roundEscalated === 1 ? "" : "s"} this round, all since resolved
        </p>
      </section>
    );
  }

  const sorted = [...items].sort((a, b) => b.id - a.id);
  // #891 AC3: the mockup's header summary line, computed from these SAME `items` — never a
  // second count derived some other way.
  const summary = attentionSummary(items, clock);
  return (
    <section className="panel needs-attention" aria-label="needs attention">
      <div className="attention-header">
        <h2>needs attention</h2>
        <span className="muted data attention-summary">
          {summary.waiting} waiting · oldest {summary.oldestDays}d · {summary.dissent} dissent
        </span>
      </div>
      <ul aria-live="polite" className="attention-list">
        {sorted.map((event) => (
          <AttentionRow key={event.id} event={event} titles={titles} repoUrl={repoUrl} now={clock} onInspect={onInspect} />
        ))}
      </ul>
    </section>
  );
}
