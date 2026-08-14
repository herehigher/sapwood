import { useState } from "react";
import type { EngineState, Round } from "../api/types.ts";
import { formatUsd } from "../format.ts";
import { formatAbsoluteTime, formatRelativeTime } from "../format-time.ts";

/** #889 (§3 A implementation): the header's `◂ [round N] ▸` navigator + LIVE/CLOSED badge, plus
 *  the click-to-open round list it now owns wholesale — `Transport.tsx` used to render an
 *  unstyled `<ul>` of every round inline, above the fold, on every render; that markup moves here
 *  so the list only ever exists behind an explicit click, never by default. */
export interface RoundNavigatorProps {
  rounds: Round[];
  /** `null` = live mode, nothing selected for replay. */
  selectedRoundId: number | null;
  onSelectRound: (roundId: number | null) => void;
  /** The currently OPEN round's id in live mode — `null` in demo/replay-only routes (no live
   *  engine to have an open round at all) and whenever `/api/rounds` hasn't caught up to it yet. */
  liveRoundId: number | null;
  /** Drives the LIVE slot's fallback caption when no round is open at all (§3 A: "live ·
   *  waiting"/"live · stopped"). */
  engineState?: EngineState | undefined;
  now?: Date | undefined;
  /** Test-only seam (same posture as `Controls.tsx`'s `initialState`/`App`'s `initialConfigOpen`):
   *  `renderToStaticMarkup` never runs a click, so this is how a render-only test puts the list
   *  in its opened state to assert its content. Production callers never pass this. */
  initiallyOpen?: boolean;
}

/** §3 A: only `done` rounds are ever a replay target — the open round is the LIVE slot itself. */
function isReplayable(round: Round): boolean {
  return round.status === "done";
}

/** Steps to the next-OLDER closed round (◂). At LIVE (`null`), lands on the newest closed round.
 *  Already at the oldest closed round: stays put (nothing further left to step to). Pure/exported
 *  so the stepping rule is directly testable without mounting the component. */
export function stepRoundLeft(rounds: readonly Round[], selectedRoundId: number | null): number | null {
  const closedDesc = rounds
    .filter(isReplayable)
    .map((r) => r.roundId)
    .sort((a, b) => b - a);
  if (selectedRoundId === null) return closedDesc[0] ?? null;
  const older = closedDesc.find((id) => id < selectedRoundId);
  return older ?? selectedRoundId;
}

/** Steps to the next-NEWER closed round (▸), or back to LIVE (`null`) once no newer closed round
 *  remains. Already at LIVE: stays at LIVE (nothing further right to step to). */
export function stepRoundRight(rounds: readonly Round[], selectedRoundId: number | null): number | null {
  if (selectedRoundId === null) return null;
  const closedAsc = rounds
    .filter(isReplayable)
    .map((r) => r.roundId)
    .sort((a, b) => a - b);
  const newer = closedAsc.find((id) => id > selectedRoundId);
  return newer ?? null;
}

/** §3 A's LIVE slot, when no round is currently open at all: "live · waiting"/"live · stopped" are
 *  the two examples the design doc names explicitly; any other engine word degrades to the same
 *  "live · {word}" shape rather than inventing unnamed copy. */
function liveSlotCaption(engineState: EngineState | undefined): string {
  if (engineState === "standby") return "live · waiting";
  if (engineState === undefined) return "live";
  return `live · ${engineState}`;
}

export interface RoundNavLabel {
  text: string;
  /** Tints the pill per §3 A's "persistent tinted 'ROUND N · CLOSED' badge" — the pill itself
   *  carries the badge, rather than a second element duplicating the same fact. */
  closed: boolean;
}

/** The pill's own text + closed-tint state, decided purely from the three real cases §3 A names:
 *  replaying a closed round, LIVE with an open round, or LIVE with nothing open (fresh DB / a
 *  standby gap between rounds). Exported and pure so the navigator's round-N binding is directly
 *  testable without mounting the component. */
export function roundNavLabel(
  rounds: readonly Round[],
  selectedRoundId: number | null,
  liveRoundId: number | null,
  engineState: EngineState | undefined,
): RoundNavLabel {
  if (selectedRoundId !== null) return { text: `round ${selectedRoundId} · closed`, closed: true };
  if (liveRoundId !== null) return { text: `round ${liveRoundId} · live`, closed: false };
  if (rounds.length === 0) return { text: "no rounds yet", closed: false };
  return { text: liveSlotCaption(engineState), closed: false };
}

// ── round list: newest-first, standby rounds collapsed, capped with an honest disclosure ───────

/** #766 gate② finding [3]'s field-name contract, unchanged from `Transport.tsx`'s original
 *  `roundTally` — kept alongside it (not re-exported) since the two now live in separate render
 *  trees with no shared parent that would make importing across them cheaper than restating this
 *  one small read. */
function roundTally(round: Round): string {
  if (round.artifact === null || typeof round.artifact !== "object") return "no summary yet";
  const a = round.artifact as Record<string, unknown>;
  const prsMerged = typeof a.prsMerged === "number" ? a.prsMerged : undefined;
  const spendUsd = typeof a.spendUsd === "number" ? a.spendUsd : undefined;
  if (prsMerged === undefined && spendUsd === undefined) return "no summary yet";
  const parts: string[] = [];
  if (prsMerged !== undefined) parts.push(`${prsMerged} merged`);
  if (spendUsd !== undefined) parts.push(formatUsd(spendUsd));
  return parts.join(" · ");
}

/** A round that closed with nothing to show for it — the "~380 of them '0 merged · $0.00'
 *  standby rounds" the issue names. Distinct from tally-less (no artifact at all): this is a real,
 *  recorded round that genuinely did nothing, the shape the round list groups away by default. */
export function isStandbyRound(round: Round): boolean {
  if (round.artifact === null || typeof round.artifact !== "object") return false;
  const a = round.artifact as Record<string, unknown>;
  const prsMerged = typeof a.prsMerged === "number" ? a.prsMerged : undefined;
  const spendUsd = typeof a.spendUsd === "number" ? a.spendUsd : undefined;
  return prsMerged === 0 && (spendUsd === undefined || spendUsd === 0);
}

export type RoundListEntry = { kind: "round"; round: Round } | { kind: "standby-group"; rounds: Round[] };

/** Newest-first, with any run of consecutive standby rounds folded into one `standby-group` entry
 *  — a real round of activity between two standby stretches keeps those stretches as separate
 *  groups rather than merging across it. Pure/exported for direct testing. */
export function buildRoundListEntries(rounds: readonly Round[]): RoundListEntry[] {
  const sorted = [...rounds].sort((a, b) => b.roundId - a.roundId);
  const entries: RoundListEntry[] = [];
  let group: Round[] = [];
  const flushGroup = () => {
    if (group.length === 1) {
      const [round] = group;
      if (round) entries.push({ kind: "round", round });
    } else if (group.length > 1) {
      entries.push({ kind: "standby-group", rounds: group });
    }
    group = [];
  };
  for (const round of sorted) {
    if (isStandbyRound(round)) {
      group.push(round);
    } else {
      flushGroup();
      entries.push({ kind: "round", round });
    }
  }
  flushGroup();
  return entries;
}

/** Same discipline as the feed's "showing latest 200 of N" (`ActivityFeed.tsx`'s `FEED_RENDER_CAP`)
 *  — the round list is a dropdown, not a scannable page, so its own cap is smaller. */
export const ROUND_LIST_RENDER_CAP = 50;

function RoundListRow({
  round,
  selected,
  onSelect,
  now,
}: {
  round: Round;
  selected: boolean;
  onSelect: (roundId: number) => void;
  now: Date;
}) {
  const replayable = isReplayable(round);
  const tallyLess = round.schemaVersion === null && round.artifact === null;
  const title = formatAbsoluteTime(round.startedAt);
  return (
    <li className={selected ? "round-row round-row-selected" : "round-row"} data-round-id={round.roundId}>
      <button
        type="button"
        disabled={!replayable}
        aria-pressed={selected}
        onClick={() => replayable && onSelect(round.roundId)}
        title={title}
      >
        {round.status === "in_progress" ? `round ${round.roundId} · live` : `▶ round ${round.roundId}`}
      </button>
      <span className="muted round-row-when" title={title}>
        {formatRelativeTime(round.startedAt, now)}
      </span>
      {/* §889: the missing separator between the relative-time span and the tally span — two
       *  adjacent `<span>`s with no text node between them glued as "21d ago1 merged". */}
      <span className="muted round-row-sep" aria-hidden="true">
        ·
      </span>
      <span className={tallyLess ? "muted round-row-tally round-row-tally-less" : "muted round-row-tally"}>{roundTally(round)}</span>
    </li>
  );
}

function RoundListStandbyGroup({ rounds }: { rounds: Round[] }) {
  // `buildRoundListEntries` only ever builds a `standby-group` with 2+ rounds — both ends exist.
  const newest = rounds[0] as Round;
  const oldest = rounds[rounds.length - 1] as Round;
  return (
    <li className="round-row round-row-collapsed">
      <details>
        <summary className="muted">
          {rounds.length} standby rounds (round {oldest.roundId}–{newest.roundId}, 0 merged · $0.00 each)
        </summary>
        <ul className="round-list round-list-nested">
          {rounds.map((round) => (
            <li key={round.roundId} className="round-row" data-round-id={round.roundId}>
              <span className="muted">▶ round {round.roundId}</span>
              <span className="muted round-row-tally">{roundTally(round)}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function RoundNavigator({
  rounds,
  selectedRoundId,
  onSelectRound,
  liveRoundId,
  engineState,
  now,
  initiallyOpen = false,
}: RoundNavigatorProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const clock = now ?? new Date();

  const label = roundNavLabel(rounds, selectedRoundId, liveRoundId, engineState);
  const leftTarget = stepRoundLeft(rounds, selectedRoundId);
  const rightTarget = stepRoundRight(rounds, selectedRoundId);
  const canStepLeft = leftTarget !== selectedRoundId;
  const canStepRight = selectedRoundId !== null;

  const entries = buildRoundListEntries(rounds);
  const capped = entries.slice(0, ROUND_LIST_RENDER_CAP);
  const capNote =
    entries.length > ROUND_LIST_RENDER_CAP ? `showing latest ${capped.length} of ${entries.length} — ${rounds.length} rounds total` : null;

  const selectFromList = (roundId: number) => {
    onSelectRound(roundId);
    setOpen(false);
  };

  return (
    <div className="round-nav">
      {/* engine-agent audit run fe112e01-e488-4d80-864a-9a490750cfb1 finding [0]
       *  (dropdown-clipped-by-navigator): the joined-stepper look needs `overflow: hidden` to
       *  keep a slot's own hover background inside the group's rounded corners, but that same
       *  `overflow: hidden` clips ANY absolutely positioned descendant — including the dropdown
       *  below, which used to be a sibling of these buttons under the SAME clipped element.
       *  Scoping `overflow: hidden` to this inner wrapper (which contains only the three
       *  buttons, nothing that ever needs to escape it) lets `.round-nav-list-wrap` sit as this
       *  wrapper's own SIBLING instead — a sibling is never subject to an ancestor's overflow
       *  clip, so the dropdown escapes cleanly while the stepper still gets its rounded corners. */}
      <div className="round-nav-stepper">
        <button
          type="button"
          className="round-nav-arrow"
          aria-label="previous round"
          title={leftTarget !== null && leftTarget !== selectedRoundId ? `replay round ${leftTarget}` : undefined}
          disabled={!canStepLeft}
          onClick={() => onSelectRound(leftTarget)}
        >
          ◂
        </button>
        <button
          type="button"
          className={label.closed ? "round-nav-pill round-nav-pill-closed" : "round-nav-pill"}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((o) => !o)}
        >
          {label.text}
        </button>
        <button
          type="button"
          className="round-nav-arrow"
          aria-label="next round"
          title={canStepRight ? "back to live" : undefined}
          disabled={!canStepRight}
          onClick={() => onSelectRound(rightTarget)}
        >
          ▸
        </button>
      </div>
      {open && (
        <div className="round-nav-list-wrap">
          {rounds.length === 0 ? (
            <p className="muted">no rounds yet</p>
          ) : (
            <>
              {capNote && <p className="muted round-list-cap-note">{capNote}</p>}
              <ul className="round-list">
                {capped.map((entry) =>
                  entry.kind === "round" ? (
                    <RoundListRow
                      key={`r-${entry.round.roundId}`}
                      round={entry.round}
                      selected={entry.round.roundId === selectedRoundId}
                      onSelect={selectFromList}
                      now={clock}
                    />
                  ) : (
                    <RoundListStandbyGroup key={`g-${entry.rounds.map((r) => r.roundId).join("-")}`} rounds={entry.rounds} />
                  ),
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
