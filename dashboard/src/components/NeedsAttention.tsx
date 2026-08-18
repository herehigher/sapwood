import { attentionCategory, copyFor, type EntityToken, isReviewDissentCategory, type SentencePart } from "../copy.ts";
import type { DomainEvent } from "../domain-event.ts";
import { attentionSummary, type EntityTitles } from "../entities.ts";
import { formatRelativeWithAbsoluteTitle } from "../format-time.ts";
import { ATTENTION_KIND_TO_NODE, type StageNode } from "../inspector.ts";
import { SentencePartView } from "./ActivityFeed.tsx";
import { resolveEntityTitle } from "./EntityRef.tsx";
import { HintTooltip } from "./HintTooltip.tsx";
import { IssueGlyph, PrGlyph } from "./icons.tsx";

/** #925 gate① engine-agent finding [3] (sentence-prefix-dropped): the entity token drives the
 *  row's dedicated entity-ref cell ("PR #212 — title"), but the FULL original sentence still
 *  renders in the reason cell — never sliced. An earlier version dropped every `SentencePart`
 *  before the token, assuming it was always a redundant "PR "/"Issue " prefix; `copy.ts`'s own
 *  shapes disprove that (`gated-flag-unprovable`: `["Lane ", worker, "'s reentry flag couldn't be
 *  found on either carrier · asks: check issue ", issueTok(...), "'s labels by hand"]` — the token
 *  sits mid-sentence, and slicing everything up to and including it discarded the reason's own
 *  subject and verb). `copy.ts` carries ~30 independently-authored sentence shapes with no
 *  structural guarantee the token is a leading prefix; there is no reliable, non-text-guessing way
 *  to know which leading words are safe to drop for a given kind (the "authoritative signals over
 *  inferred ones" rule — text-shape sniffing is exactly the free-text-pattern guessing it warns
 *  against). Showing the entity number twice (once in its own cell, once inline in the sentence's
 *  own prose) is the accepted, honest trade-off — never losing the reason's own meaning. */
function findEntityToken(parts: SentencePart[]): EntityToken | undefined {
  return parts.find((part): part is EntityToken => typeof part === "object" && (part.kind === "issue" || part.kind === "pr"));
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
  // `--attention-tone-rust`/`--attention-tone-review` (tokens.css), not `--rust`/`--sap-text`
  // directly — gate① engine-agent finding [0]: those are both `light-dark()`, which happy-dom's
  // `getComputedStyle` never evaluates for a colour-typed property, making an AC1 STYLE assertion
  // permanently unprovable against them. The two literal-hex aliases are pinned to --rust/
  // --sap-text's own per-theme values by tokens.test.ts, so they can never silently drift.
  const tone = category && isReviewDissentCategory(category) ? "var(--attention-tone-review)" : "var(--attention-tone-rust)";
  const token = findEntityToken(parts);
  const entityTitle = token ? resolveEntityTitle(token, titles) : undefined;
  // #925 AC4 gate① engine-agent finding [0] (ac4-entity-composition): ONE string, "PR #9202 —
  // <title>" (or "#9202 — <title>" for an issue token) — never a "PR " literal composed outside
  // the styled element the way `EntityRef` alone would leave it. `EntityRef` itself stays
  // untouched (it also renders at the feed/lane-card inline scale elsewhere, #892) — this row's
  // own entity cell builds its own single label instead of reusing that component's narrower
  // glyph+number-only contract.
  const entityLabel = token ? `${token.kind === "pr" ? "PR " : ""}#${token.number}${entityTitle ? ` — ${entityTitle}` : ""}` : undefined;
  // gate① engine-agent finding [1] (ac4-age-box): `.muted` (app.css) and `.attention-age-emphasis`
  // (panels.css) carry EQUAL selector specificity, and `.muted` loads LATER in the production
  // cascade (tokens.css -> panels.css -> hero.css -> app.css) — a `.muted`-carrying emphasis box
  // would have its own colour override silently lose the cascade to `.muted`'s `--bark-text`. The
  // emphasis box drops `.muted` entirely instead: it is no longer secondary/de-emphasised text —
  // that is the whole point of the emphasis treatment.
  const ageClassName = emphasize ? "data attention-ts attention-age attention-age-emphasis" : "muted data attention-ts attention-age";
  const rowModifier = emphasize ? " attention-row-emphasis" : "";
  return (
    // #925 gate① engine-agent finding [3] (inspect-control-breaks-grid): `.attention-row` is a
    // 5-track CSS grid — exactly 5 direct children, ALWAYS, regardless of which optional content
    // a given row carries. The category chip and the inspect button are both conditional, so each
    // lives inside a stable wrapper cell (`.attention-category`, `.attention-reason`) rather than
    // being a direct grid child itself — otherwise a row that skips the chip (an unrecognized
    // kind) or adds the inspect button (App's own onInspect wiring, real production rows like
    // plan-review-escalated) shifts every column after it, or auto-places the age box into a
    // second implicit grid row.
    <li className={"attention-row" + rowModifier + " recipe-list-entry"}>
      {/* `backgroundColor` (the longhand), not `background` — a happy-dom quirk (this file's own
       *  #925 AC1 test comment) only echoes the raw inline value back for the longhand. */}
      <span className="attention-severity" aria-hidden="true" style={{ backgroundColor: tone }} />
      <span className="attention-category">
        {category && (
          <span className="attention-chip" style={{ borderColor: tone, color: tone }}>
            {category}
          </span>
        )}
      </span>
      {/* #925 AC4 gate① engine-agent finding [0]/[1]: the glyph renders FIRST (≥24px, to the
       *  label's left — `.attention-entity svg`, panels.css), then ONE `--font-data` ≥14px element
       *  carrying the complete "PR #9202 — <title>" string on a single baseline — never a glyph
       *  wrapped mid-string or a title split into its own separately-sized span. `overflow: hidden`
       *  + `text-overflow: ellipsis` live on `.attention-entity` itself (panels.css): the title
       *  consumes whatever free space the grid's `1fr` entity track has and truncates exactly where
       *  the reason column's own track begins — never earlier, never by JS string-slicing. */}
      <span className="attention-entity">
        {token &&
          (repoUrl ? (
            <>
              {token.kind === "issue" ? <IssueGlyph /> : <PrGlyph />}
              <a
                className="attention-entity-ref data"
                href={`${repoUrl}/${token.kind === "issue" ? "issues" : "pull"}/${token.number}`}
                target="_blank"
                rel="noreferrer"
              >
                {entityLabel}
              </a>
            </>
          ) : (
            <>
              {token.kind === "issue" ? <IssueGlyph /> : <PrGlyph />}
              <span className="attention-entity-ref data">{entityLabel}</span>
            </>
          ))}
      </span>
      <span className="attention-reason">
        <span className="attention-sentence">
          {parts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sentence parts are a fixed-order render list, not reorderable data
            <span key={i}>
              <SentencePartView part={part} titles={titles} repoUrl={repoUrl} />
            </span>
          ))}
        </span>
        {/* AC7: a SIBLING of the sentence, never nested inside its own GitHub anchor — each
         *  independently focusable with its own accessible name. */}
        {node && onInspect && (
          <button type="button" className="attention-inspect" aria-label={`inspect ${node}`} onClick={() => onInspect(node)}>
            inspect
          </button>
        )}
      </span>
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
