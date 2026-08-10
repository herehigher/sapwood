import { useEffect, useReducer } from "react";
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

export interface ControlsProps {
  /** `dashboard.controls` (§8) — when false, no buttons render and no handler is ever wired
   *  (the component returns before the button markup, not merely hiding it with CSS). */
  enabled: boolean;
  /** Injection seam for tests; defaults to the real `POST /api/control`. */
  onControl?: (verb: ControlVerb) => Promise<unknown>;
}

/**
 * frontend-design.md §3 Operations: start/pause/resume/stop, each behind a confirm naming the
 * consequence in §7 plain language. Renders exactly the four verbs the server allows — no
 * emergency-stop button (out of scope for #361: the server exposes no client-readable allowlist
 * signal for it to gate on).
 */
export function Controls({ enabled, onControl }: ControlsProps) {
  const [state, dispatch] = useReducer(controlsReducer, { phase: "idle" });

  useEffect(() => {
    if (state.phase !== "sending") return;
    let cancelled = false;
    const run = onControl ? onControl(state.verb) : postControl(state.verb);
    run.finally(() => {
      if (!cancelled) dispatch({ type: "settled" });
    });
    return () => {
      cancelled = true;
    };
  }, [state, onControl]);

  if (!enabled) return null;

  return (
    <fieldset className="controls" aria-label="operations">
      {CONTROL_VERBS.map((verb) => (
        <button key={verb} type="button" disabled={state.phase === "sending"} onClick={() => dispatch({ type: "request", verb })}>
          {CONTROL_COPY[verb].label}
        </button>
      ))}
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
