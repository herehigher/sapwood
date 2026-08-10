import type { Round } from "../api/types.ts";
import { formatUsd } from "../format.ts";
import { formatAbsoluteTime, formatRelativeTime } from "../format-time.ts";
import type { PlaySpeed } from "../replay/player.ts";
import { PLAY_SPEEDS } from "../replay/player.ts";

/** #741 (split 2/4 of #146), frontend-design.md §3 A / §6: the round navigator's list plus, once
 *  a closed round is selected, the play/pause/speed/scrub transport that drives replay through
 *  it. Only `done` rounds are selectable — the open round is the LIVE slot (§10: "the open round
 *  is not scrubbable in v0.2"), never a replay target itself. */
export interface TransportProps {
  rounds: Round[];
  /** `null` = live mode, nothing selected for replay. */
  selectedRoundId: number | null;
  onSelectRound: (roundId: number | null) => void;
  /** The selected round's own replay position — omitted entirely while `selectedRoundId` is
   *  `null` (nothing to transport). */
  cursorId?: number;
  playing?: boolean;
  speed?: PlaySpeed;
  onPlay?: () => void;
  onPause?: () => void;
  onSpeed?: (speed: PlaySpeed) => void;
  /** Scrub bar drag target — an events.id within the selected round's window. */
  onScrub?: (eventId: number) => void;
  /** #766 gate② finding [3]: the selected round's log is still fetching — no controls to show
   *  yet, but the caption says so honestly rather than rendering nothing. */
  loading?: boolean;
  /** #766 gate② finding [3]: the load rejected — shown instead of the transport controls, with
   *  a retry affordance, rather than leaving the panel permanently blank with no explanation. */
  loadError?: unknown;
  onRetry?: () => void;
  /** #766 gate② finding [2]: the `/api/rounds` fetch itself failed — same documented
   *  `disconnected` empty state `LaneBoard`/`ActivityFeed` already render, so a rounds-fetch
   *  failure never gets mistaken for the honest "no rounds yet" empty history. */
  disconnected?: boolean;
  now?: Date;
}

/** #766 gate② finding [3] (round-tally-uses-nonexistent-field): the authoritative v1
 *  `RoundArtifactSchema` (`engine/src/loop/round-artifact.ts`) names the merged-PR counter
 *  `prsMerged`, not `merged` — a real `/api/rounds` artifact has no `merged` field at all, so the
 *  old read always fell through to "no summary yet" for every genuine artifact. */
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

function RoundRow({
  round,
  selected,
  onSelectRound,
  now,
}: {
  round: Round;
  selected: boolean;
  onSelectRound: (roundId: number | null) => void;
  now: Date;
}) {
  const replayable = round.status === "done";
  const tallyLess = round.schemaVersion === null && round.artifact === null;
  const title = formatAbsoluteTime(round.startedAt);
  return (
    <li className={selected ? "round-row round-row-selected" : "round-row"} data-round-id={round.roundId}>
      <button
        type="button"
        disabled={!replayable}
        aria-pressed={selected}
        onClick={() => onSelectRound(replayable ? round.roundId : null)}
        title={title}
      >
        {round.status === "in_progress" ? `round ${round.roundId} · live` : `▶ round ${round.roundId}`}
      </button>
      <span className="muted round-row-when" title={title}>
        {formatRelativeTime(round.startedAt, now)}
      </span>
      <span className={tallyLess ? "muted round-row-tally round-row-tally-less" : "muted round-row-tally"}>{roundTally(round)}</span>
    </li>
  );
}

const SPEED_LABEL: Record<PlaySpeed, string> = { 1: "×1", 4: "×4", 16: "×16" };

export function Transport({
  rounds,
  selectedRoundId,
  onSelectRound,
  cursorId = 0,
  playing = false,
  speed = 1,
  onPlay,
  onPause,
  onSpeed,
  onScrub,
  loading = false,
  loadError,
  onRetry,
  disconnected = false,
  now,
}: TransportProps) {
  const clock = now ?? new Date();
  const selected = rounds.find((r) => r.roundId === selectedRoundId) ?? null;

  if (disconnected) {
    return (
      <section className="panel transport" aria-label="replay">
        <h2>rounds</h2>
        <p className="muted" style={{ color: "var(--rust)" }}>
          disconnected — restart sapwood to reconnect
        </p>
      </section>
    );
  }

  return (
    <section className="panel transport" aria-label="replay">
      <h2>rounds</h2>
      {rounds.length === 0 ? (
        <p className="muted">no rounds yet</p>
      ) : (
        <ul className="round-list">
          {rounds.map((round) => (
            <RoundRow
              key={round.roundId}
              round={round}
              selected={round.roundId === selectedRoundId}
              onSelectRound={onSelectRound}
              now={clock}
            />
          ))}
        </ul>
      )}

      {selected && loading && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <button type="button" onClick={() => onSelectRound(null)}>
            back to live
          </button>
          <p className="muted transport-loading">loading round…</p>
        </fieldset>
      )}

      {selected && !loading && loadError !== undefined && loadError !== null && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <button type="button" onClick={() => onSelectRound(null)}>
            back to live
          </button>
          <p className="muted transport-load-error">could not load this round</p>
          <button type="button" onClick={onRetry}>
            retry
          </button>
        </fieldset>
      )}

      {selected && !loading && (loadError === undefined || loadError === null) && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <button type="button" onClick={() => onSelectRound(null)}>
            back to live
          </button>
          <button type="button" aria-label={playing ? "pause" : "play"} onClick={playing ? onPause : onPlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <fieldset className="transport-speeds" aria-label="playback speed">
            {PLAY_SPEEDS.map((s) => (
              <button key={s} type="button" aria-pressed={s === speed} onClick={() => onSpeed?.(s)}>
                {SPEED_LABEL[s]}
              </button>
            ))}
          </fieldset>
          <input
            type="range"
            aria-label="scrub"
            className="transport-scrub"
            min={selected.startEventId}
            max={selected.startEventId + selected.eventCount}
            value={cursorId}
            onChange={(e) => onScrub?.(Number(e.target.value))}
          />
          <span className="data muted transport-position">
            event {Math.max(0, cursorId - selected.startEventId)}/{selected.eventCount}
          </span>
        </fieldset>
      )}
    </section>
  );
}
