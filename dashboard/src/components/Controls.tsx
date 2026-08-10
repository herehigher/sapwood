import { useEffect, useReducer, useState } from "react";
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
 * click (this repo's test harness has no jsdom/testing-library).
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
 * `useEffect` below so it is directly testable without a DOM: `renderToStaticMarkup` (this
 * repo's only test harness) never runs effects at all, so a test asserting "zero calls before
 * confirm, one call after" has to exercise this exact function across a real `controlsReducer`
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

export interface ControlsProps {
  /** `dashboard.controls` (§8) — when false, no buttons render and no handler is ever wired
   *  (the component returns before the button markup, not merely hiding it with CSS). */
  enabled: boolean;
  /** Injection seam for tests; defaults to the real `POST /api/control`. */
  onControl?: (verb: ControlVerb) => Promise<unknown>;
  /** Test-only seam (same posture as `App`'s own `now` prop): lets a render-only test put the
   *  component directly into a given phase — e.g. `confirming`, to assert the rendered dialog
   *  carries the matching `CONTROL_COPY` text — without needing a simulated click. Production
   *  callers never pass this; it defaults to the real starting phase. */
  initialState?: ControlsState;
}

/**
 * frontend-design.md §3 Operations: start/pause/resume/stop, each behind a confirm naming the
 * consequence in §7 plain language. Renders exactly the four verbs the server allows — no
 * emergency-stop button (out of scope for #361: the server exposes no client-readable allowlist
 * signal for it to gate on).
 */
export function Controls({ enabled, onControl, initialState }: ControlsProps) {
  const [state, dispatch] = useReducer(controlsReducer, initialState ?? { phase: "idle" });
  // #739 gate② round 2 finding [1]: a failed request must return the UI to an ACTIONABLE state
  // (buttons re-enabled) while surfacing that it failed — never the raw error/status text (same
  // no-leaked-fetch-error posture App.tsx's own `disconnected` header already holds to).
  const [failed, setFailed] = useState(false);

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

  if (!enabled) return null;

  return (
    <fieldset className="controls" aria-label="operations">
      {CONTROL_VERBS.map((verb) => (
        <button
          key={verb}
          type="button"
          disabled={state.phase === "sending"}
          onClick={() => {
            setFailed(false);
            dispatch({ type: "request", verb });
          }}
        >
          {CONTROL_COPY[verb].label}
        </button>
      ))}
      {failed && <p className="muted controls-error">Couldn't reach the engine — try again.</p>}
      {state.phase === "confirming" && (
        <div className="controls-confirm" role="alertdialog" aria-label={`confirm ${state.verb}`}>
          <p>{CONTROL_COPY[state.verb].confirm}</p>
          <button type="button" onClick={() => dispatch({ type: "confirm" })}>
            Confirm
          </button>
          <button type="button" onClick={() => dispatch({ type: "cancel" })}>
            Cancel
          </button>
        </div>
      )}
    </fieldset>
  );
}
