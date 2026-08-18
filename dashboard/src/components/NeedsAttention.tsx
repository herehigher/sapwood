import { attentionCategory, copyFor, type EntityToken, isReviewDissentCategory, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import { attentionSummary, type EntityTitles } from "../entities.ts";
import { formatRelativeWithAbsoluteTitle } from "../format-time.ts";
import { ATTENTION_KIND_TO_NODE, type StageNode } from "../inspector.ts";
import { SentencePartView } from "./ActivityFeed.tsx";
import { EntityRef, resolveEntityTitle } from "./EntityRef.tsx";
import { HintTooltip } from "./HintTooltip.tsx";

/** #925: the entity token most attention sentences carry near their start (`prTok`/`issueTok` in
 *  copy.ts) — pulled into the row's own dedicated entity-ref cell so the reason cell renders just
 *  the reason, not "PR #212 needs a human decision" duplicated across two cells. Everything
 *  before the token (kind-prefix words like "PR "/"Merged PR ") is dropped; the entity cell
 *  derives its own "PR "/"" prefix from the token's `kind` instead of that dropped text. A
 *  sentence with no entity token (e.g. a run-level BREAKER row) keeps its whole sentence as the
 *  reason, exactly as it rendered before this issue. */
function splitSentence(parts: SentencePart[]): { token: EntityToken | undefined; reason: SentencePart[] } {
  const idx = parts.findIndex((part): part is EntityToken => typeof part === "object" && (part.kind === "issue" || part.kind === "pr"));
  if (idx === -1) return { token: undefined, reason: parts };
  return { token: parts[idx] as EntityToken, reason: parts.slice(idx + 1) };
}

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
  emphasize,
}: {
  event: DomainEvent;
  titles: EntityTitles;
  repoUrl?: string | undefined;
  now: Date;
  onInspect?: ((node: StageNode) => void) | undefined;
  /** #925 AC2: this row carries the fold's greatest age (ties broken by render order) — the ONE
   *  row whose age box renders at the mockup's oversized, bold-numeral emphasis. */
  emphasize: boolean;
}) {
  const payload = event.payload ?? {};
  const parts: SentencePart[] = event.known ? copyFor(event.kind)!.sentence(payload) : [`Unrecognized event: ${event.kind}`];
  const { text, title } = formatRelativeWithAbsoluteTitle(event.ts, "local", now);
  const node = event.known ? ATTENTION_KIND_TO_NODE[event.kind] : undefined;
  // #881: the mockup's category-chip taxonomy — absent for an unrecognized kind (no fallback
  // fabricated) rather than rendering an empty/misleading chip.
  const category = event.known ? attentionCategory(event.kind) : undefined;
  // #925 (#729 owner walk, D21/D22): rust for the general escalation class, --sap-text for the
  // review/dissent class (copy.ts's isReviewDissentCategory) — the severity bar below reads this
  // SAME value as the chip's own border colour, so the two can never drift apart per row.
  const tone = category && isReviewDissentCategory(category) ? "var(--sap-text)" : "var(--rust)";
  const { token, reason } = splitSentence(parts);
  const entityTitle = token ? resolveEntityTitle(token, titles) : undefined;
  const ageClassName = emphasize ? "muted data attention-ts attention-age attention-age-emphasis" : "muted data attention-ts attention-age";
  return (
    <li className="attention-row recipe-list-entry">
      {/* `backgroundColor` (the longhand), not `background` — a happy-dom quirk (this file's own
       *  #925 AC1 test comment) only echoes the raw inline value back for the longhand. */}
      <span className="attention-severity" aria-hidden="true" style={{ backgroundColor: tone }} />
      {category && (
        <span className="attention-chip" style={{ borderColor: tone, color: tone }}>
          {category}
        </span>
      )}
      <span className="attention-entity">
        {token && (
          <>
            {token.kind === "pr" ? "PR " : ""}
            <EntityRef token={token} titles={titles} repoUrl={repoUrl} />
            {entityTitle && <span className="attention-entity-title"> — {entityTitle}</span>}
          </>
        )}
      </span>
      <span className="attention-sentence">
        {reason.map((part, i) => (
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
      <HintTooltip content={title}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this <span> is a Radix Tooltip
         *  trigger, not a bare non-interactive label — `title` is always a real absolute-time
         *  string here (never optional), so this trigger is always focusable, unlike EntityRef's
         *  conditional case — Tab must reach it (#892 AC1). */}
        <span className={ageClassName} tabIndex={0}>
          {text}
        </span>
      </HintTooltip>
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
        <div className="panel-head">
          <h2>needs attention</h2>
        </div>
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
  // #925 AC2: the row with the greatest age (ties -> first in THIS render order) gets the
  // emphasis box — computed once here, from the same `sorted`/`clock` every row renders from,
  // never a second, independently-sorted pass per row.
  const ages = sorted.map((event) => clock.getTime() - new Date(event.ts).getTime());
  const maxAge = Math.max(...ages);
  const emphasisIndex = ages.indexOf(maxAge);
  return (
    <section className="panel needs-attention" aria-label="needs attention">
      <div className="attention-header panel-head">
        <h2>needs attention</h2>
        <span className="muted data attention-summary panel-head-stat">
          {summary.waiting} waiting · oldest {summary.oldestDays}d · {summary.dissent} dissent
        </span>
      </div>
      <ul aria-live="polite" className="attention-list">
        {sorted.map((event, i) => (
          <AttentionRow
            key={event.id}
            event={event}
            titles={titles}
            repoUrl={repoUrl}
            now={clock}
            onInspect={onInspect}
            emphasize={i === emphasisIndex}
          />
        ))}
      </ul>
    </section>
  );
}
