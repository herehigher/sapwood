import { type KeyboardEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { postControl } from "../api/client.ts";
import { CONTROL_VERBS, type ControlVerb } from "../api/types.ts";
import { CONTROL_COPY } from "../copy.ts";

export type ControlsState = { phase: "idle" } | { phase: "confirming"; verb: ControlVerb } | { phase: "sending"; verb: ControlVerb };

export type ControlsAction = { type: "request"; verb: ControlVerb } | { type: "confirm" } | { type: "cancel" } | { type: "settled" };

/**
 * §3 Operations' misfire protection, as a pure state machine: a verb click only ever reaches
 * `confirming`; only an explicit `confirm` action (never a bare click) advances to `sending`,
 * which is the ONE phase the component's effect below is allowed to fire `POST /api/control`
 * from. This function is the actual proof of "no control POST fires without its confirm step" —
 * see Controls.test.tsx's header comment for why the proof lives here rather than in a simulated
 * click (this test deliberately stays DOM-free; see the real-DOM test at the end of
 * Controls.test.tsx).
 */
export function controlsReducer(state: ControlsState, action: ControlsAction): ControlsState {
  switch (action.type) {
    case "request":
      return { phase: "confirming", verb: action.verb };
    case "confirm":
      return state.phase === "confirming" ? { phase: "sending", verb: state.verb } : state;
    case "cancel":
      return { phase: "idle" };
    case "settled":
      return { phase: "idle" };
    default:
      return state;
  }
}

/** The outcome of one `runControlEffect` call: `fired: false` when the phase wasn't `sending`
 *  (nothing to do); `fired: true, ok: true` on a successful request; `fired: true, ok: false,
 *  error` when the request rejected — #739 gate② round 2 finding [1]
 *  (control-rejection-wedges-ui): the caller MUST still treat this as settled (dispatch back to
 *  `idle`) rather than leaving the reducer stuck in `sending` forever, which is exactly what a
 *  bare `.then()` with no rejection handling did before this. */
export type ControlEffectResult = { fired: false } | { fired: true; ok: true } | { fired: true; ok: false; error: unknown };

/**
 * The ONE place the component's effect is allowed to call the network — factored out of the
 * `useEffect` below so it is directly testable without a DOM: this extraction deliberately stays
 * DOM-free (`renderToStaticMarkup` never runs effects at all; see the real-DOM test at the end of
 * Controls.test.tsx), so a test asserting "zero calls before confirm, one call after" has to
 * exercise this exact function across a real `controlsReducer`
 * transition rather than a simulated click (#739 gate② round 1 finding [1]:
 * ac6-confirm-flow-untested). NEVER rejects itself — a failed `onControl` is caught and reported
 * in the resolved result, never left to propagate as an unhandled rejection or to skip the
 * `dispatch({ type: "settled" })` a caller chains on `fired` (#739 gate② round 2 finding [1]:
 * before this, a rejecting `postControl` — any non-2xx response or network failure — left the
 * reducer wedged in `sending` permanently, all four buttons disabled, until a page reload).
 */
export async function runControlEffect(
  state: ControlsState,
  onControl: (verb: ControlVerb) => Promise<unknown>,
): Promise<ControlEffectResult> {
  if (state.phase !== "sending") return { fired: false };
  try {
    await onControl(state.verb);
    return { fired: true, ok: true };
  } catch (error) {
    return { fired: true, ok: false, error };
  }
}

/** §3 Operations' misfire protection for EMERGENCY STOP specifically: a hold, not a bare click —
 *  releasing before the hold completes cancels with NO dispatch at all ("armed is never 'release
 *  to fire'", same doctrine Stop's own short hold follows). Only a completed hold fires the normal
 *  `request` action, landing on the SAME confirm dialog every other verb uses below — hold-to-arm
 *  plus confirm is two distinct steps, not a replacement for the confirm step. */
const ESTOP_HOLD_MS = 600;

function useHoldToArm(onArmed: () => void): { start: () => void; cancel: () => void } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const start = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      onArmed();
    }, ESTOP_HOLD_MS);
  }, [cancel, onArmed]);
  useEffect(() => cancel, [cancel]);
  return { start, cancel };
}

/** The two native button-activation keys — a `<button>`'s default behavior fires a synthetic
 *  `click` from these (Enter on keydown, Space on keyup), which this component must intercept
 *  rather than let through: the estop button has no `onClick` at all, precisely so a bare
 *  activation can never bypass the hold. */
const ESTOP_ARM_KEYS = new Set(["Enter", " "]);

/** #733 engine-agent finding [0] (estop-keyboard-inoperable): the pointer-only hold handlers left
 *  keyboard/switch-device users with a focusable button that does nothing on Enter/Space — no
 *  click handler exists to fall back on, by design (see ESTOP_ARM_KEYS above), so activation was a
 *  dead end. This mirrors the pointer hold exactly: keydown arms the SAME `useHoldToArm` timer,
 *  keyup before it fires cancels with zero effect, so holding Enter/Space for `ESTOP_HOLD_MS` is
 *  the keyboard-equivalent gesture to a pointer hold — same two-step (hold, then confirm), same
 *  "armed is never release-to-fire" guarantee. `e.repeat` (OS key-repeat while held) is ignored so
 *  each repeat doesn't restart the timer and starve it of ever completing. `preventDefault` stops
 *  the native click the browser would otherwise synthesize (Enter) or the page scroll Space would
 *  otherwise trigger. */
function estopKeyHandlers(hold: { start: () => void; cancel: () => void }) {
  return {
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!ESTOP_ARM_KEYS.has(e.key) || e.repeat) return;
      e.preventDefault();
      hold.start();
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!ESTOP_ARM_KEYS.has(e.key)) return;
      e.preventDefault();
      hold.cancel();
    },
  };
}

/** The octagon-outline "stop sign" glyph — §3 Operations' page-unique icon-bearing control;
 *  Pause/Stop stay text-only (the asymmetry IS the tier hierarchy). */
function OctagonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polygon points="7.5,2 16.5,2 22,7.5 22,16.5 16.5,22 7.5,22 2,16.5 2,7.5" />
    </svg>
  );
}

export interface ControlsProps {
  /** `dashboard.controls` (§8) — when false, no buttons render and no handler is ever wired
   *  (the component returns before the button markup, not merely hiding it with CSS). */
  enabled: boolean;
  /** `engine.state === "running"` (§8) — EMERGENCY STOP is verb-legality gated: §3 Operations
   *  renders it only while the engine is actually running. Defaults false so every pre-#733 call
   *  site (none of which know about the tier) keeps rendering the original four verbs unchanged.
   *  #733 engine-agent finding [1]: `currentEngineState` never folds EMERGENCY_STOP into the
   *  derived word, so the server CAN legitimately answer `state: "running"` together with
   *  `estopActive: true` (the window between the sentinel landing and the engine's own next tick
   *  observing it, or a dead engine's tick going stale). This component therefore never trusts
   *  `running` alone for the estop button — see `estopActive` below, ANDed together internally. */
  running?: boolean;
  /** The raw EMERGENCY_STOP sentinel (§733's `engine.estopActive`) — while active, `start` must
   *  not render/report a "resumed" outcome, since the verb clears neither PAUSE nor this
   *  sentinel; the only release lever is the CLI-only `sapwood estop clear` (#731). */
  estopActive?: boolean;
  /** Injection seam for tests; defaults to the real `POST /api/control`. */
  onControl?: (verb: ControlVerb) => Promise<unknown>;
  /** Test-only seam (same posture as `App`'s own `now` prop): lets a render-only test put the
   *  component directly into a given phase — e.g. `confirming`, to assert the rendered dialog
   *  carries the matching `CONTROL_COPY` text — without needing a simulated click. Production
   *  callers never pass this; it defaults to the real starting phase. */
  initialState?: ControlsState;
}

/**
 * frontend-design.md §3 Operations: start/pause/resume/stop/estop, each behind a confirm naming
 * the consequence in §7 plain language. EMERGENCY STOP additionally requires a hold-to-arm before
 * that confirm ever opens (`useHoldToArm` above), carries the octagon icon, and only renders while
 * `running` is true AND `estopActive` is false (see `showEstop` below).
 */
export function Controls({ enabled, running = false, estopActive = false, onControl, initialState }: ControlsProps) {
  const [state, dispatch] = useReducer(controlsReducer, initialState ?? { phase: "idle" });
  // #739 gate② round 2 finding [1]: a failed request must return the UI to an ACTIONABLE state
  // (buttons re-enabled) while surfacing that it failed — never the raw error/status text (same
  // no-leaked-fetch-error posture App.tsx's own `disconnected` header already holds to).
  const [failed, setFailed] = useState(false);
  // #892 (#876 C-2 ruling): the confirm step is a native `<dialog>` via `.showModal()` — this is
  // the ONLY thing this migration changes about §3 Operations' misfire protection; the reducer's
  // idle→confirming→sending state machine (and every effect above/below it) is untouched.
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state.phase` isn't read in the body, but it's the trigger for re-running showModal() each time the dialog element gets freshly mounted (phase flips to "confirming" unmounts then remounts it).
  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [state.phase]);

  useEffect(() => {
    let cancelled = false;
    runControlEffect(state, onControl ?? postControl).then((result) => {
      if (cancelled || !result.fired) return;
      if (!result.ok) setFailed(true);
      dispatch({ type: "settled" });
    });
    return () => {
      cancelled = true;
    };
  }, [state, onControl]);

  const estopHold = useHoldToArm(() => {
    setFailed(false);
    dispatch({ type: "request", verb: "estop" });
  });

  if (!enabled) return null;

  // #733 engine-agent finding [1]: `running` alone is not a reliable "may still fire" signal — the
  // server can report `state: "running"` while `estopActive` is already true (the derived state
  // word doesn't fold EMERGENCY_STOP in). There is nothing left to stop once the halt has already
  // landed, so the button must not offer to fire it again.
  const showEstop = running && !estopActive;

  return (
    <fieldset className="controls" aria-label="operations">
      {CONTROL_VERBS.filter((verb) => verb !== "estop" || showEstop).map((verb) =>
        verb === "estop" ? (
          <button
            key={verb}
            type="button"
            className="control-estop"
            disabled={state.phase === "sending"}
            onPointerDown={estopHold.start}
            onPointerUp={estopHold.cancel}
            onPointerLeave={estopHold.cancel}
            onPointerCancel={estopHold.cancel}
            onBlur={estopHold.cancel}
            {...estopKeyHandlers(estopHold)}
          >
            <OctagonIcon />
            {CONTROL_COPY.estop.label}
          </button>
        ) : (
          <button
            key={verb}
            type="button"
            disabled={state.phase === "sending" || (verb === "start" && estopActive)}
            onClick={() => {
              setFailed(false);
              dispatch({ type: "request", verb });
            }}
          >
            {CONTROL_COPY[verb].label}
          </button>
        ),
      )}
      {/* #733 AC4: Start must never imply the halt is lifted while EMERGENCY_STOP persists — name
          the one real release lever instead of staying silent about it. */}
      {estopActive && (
        <p className="muted controls-estop-notice">
          EMERGENCY STOP is active — the halt persists. Release it with <code>sapwood estop clear</code>.
        </p>
      )}
      {failed && <p className="muted controls-error">Couldn't reach the engine — try again.</p>}
      {state.phase === "confirming" && (
        <dialog
          ref={confirmDialogRef}
          className="controls-confirm recipe-drawer"
          role="alertdialog"
          aria-label={`confirm ${state.verb}`}
          // Native Escape→cancel→close (#876 C-2, #892 AC3): the dialog's own `close` event is the
          // ONE thing that can desync the reducer from what's on screen (Escape closes the native
          // element without going through either button), so it dispatches the same `cancel` action
          // the Cancel button does — never a second, parallel "closed" state.
          onClose={() => dispatch({ type: "cancel" })}
        >
          <p>{CONTROL_COPY[state.verb].confirm}</p>
          <button type="button" className="recipe-press" onClick={() => dispatch({ type: "confirm" })}>
            Confirm
          </button>
          <button type="button" className="recipe-press" onClick={() => dispatch({ type: "cancel" })}>
            Cancel
          </button>
        </dialog>
      )}
    </fieldset>
  );
}
