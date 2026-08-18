import type { Round } from "../api/types.ts";
import type { PlaySpeed } from "../replay/player.ts";
import { PLAY_SPEEDS } from "../replay/player.ts";

/**
 * #741 (split 2/4 of #146), restructured by #889 (§3 A implementation): the play/pause/speed/scrub
 * transport that drives replay once a closed round is selected. The round navigator/list itself
 * moved wholesale to `RoundNavigator.tsx` (the header's `◂ [round N] ▸` pill owns opening it now) —
 * this component renders NOTHING at all in live mode (`selectedRoundId === null`), so it no longer
 * contributes an always-present, ~9,000px "every round ever" block above the fold (#889's own why).
 * Only `done` rounds are selectable — the open round is the LIVE slot (§10: "the open round is not
 * scrubbable in v0.2"), never a replay target itself.
 *
 * #923 (D14/D15/D17): moved again — from a separate `.panel` sibling of `.app-header` to the
 * header card's OWN second row, under a hairline (App.tsx, panels.css's `.transport`). The
 * "back to live" affordance moved with it, but not INTO this row: App.tsx's header row now owns
 * one styled BACK TO LIVE button covering every state below (loading/error/normal alike), so this
 * component no longer takes an `onSelectRound` prop or renders its own copy of that control.
 */
export interface TransportProps {
  rounds: Round[];
  /** `null` = live mode, nothing selected for replay — renders nothing. */
  selectedRoundId: number | null;
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
  /** #766 gate② finding [2]: the `/api/rounds` fetch itself failed. The header's own navigator
   *  already carries this state (`RoundNavigator`/`Header` render the disconnected notice), so
   *  this panel simply renders nothing rather than a second, redundant disconnected message. */
  disconnected?: boolean;
  now?: Date;
}

const SPEED_LABEL: Record<PlaySpeed, string> = { 1: "×1", 4: "×4", 16: "×16" };

/** #923 (D17): "speed as one bordered '× N' box (cycling ...), no three-chip row" — replaces the
 *  previous three separately-bordered ×1/×4/×16 buttons. Pure/exported so the wrap-around step is
 *  directly testable without mounting the component. */
export function nextSpeed(speed: PlaySpeed): PlaySpeed {
  const i = PLAY_SPEEDS.indexOf(speed);
  return PLAY_SPEEDS[(i + 1) % PLAY_SPEEDS.length] as PlaySpeed;
}

export function Transport({
  rounds,
  selectedRoundId,
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
}: TransportProps) {
  // §889 AC1: hero/lanes/feed/cost must sit above the fold with nothing extra pushed below it in
  // live mode — the header's own navigator/badge already carries the disconnected state, so this
  // panel contributes zero height rather than a second, redundant notice.
  if (disconnected || selectedRoundId === null) return null;
  const selected = rounds.find((r) => r.roundId === selectedRoundId) ?? null;
  if (!selected) return null;

  return (
    // #923 AC3 (D17): no longer its own `.panel` — rendered inside `.app-header` now (App.tsx),
    // as the header card's own second row under a hairline (panels.css's `.transport`). The
    // header row's own BACK TO LIVE button (App.tsx, AC2) is this row's only escape hatch now —
    // every state below used to carry its own duplicate "back to live" text; a single header-level
    // control covers loading/error/normal alike, so none of the three repeats it here.
    <section className="transport" aria-label="replay transport">
      {loading && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <p className="muted transport-loading">loading round…</p>
        </fieldset>
      )}

      {!loading && loadError !== undefined && loadError !== null && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <p className="muted transport-load-error">could not load this round</p>
          <button type="button" onClick={onRetry}>
            retry
          </button>
        </fieldset>
      )}

      {!loading && (loadError === undefined || loadError === null) && (
        <fieldset className="transport-controls" aria-label="transport controls">
          <button type="button" className="transport-play" aria-label={playing ? "pause" : "play"} onClick={playing ? onPause : onPlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            className="transport-speed"
            aria-label={`playback speed: ${SPEED_LABEL[speed]}`}
            onClick={() => onSpeed?.(nextSpeed(speed))}
          >
            {SPEED_LABEL[speed]}
          </button>
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
