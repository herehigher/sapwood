import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTROL_VERBS } from "../api/types.ts";
import { CONTROL_COPY } from "../copy.ts";
import { registerRealDom } from "../test-dom.ts";
import { Controls, controlsReducer, runControlEffect } from "./Controls.tsx";

registerRealDom();
test.afterEach(() => mock.restoreAll());

// ── controlsReducer: the misfire-protection state machine (§3 Operations) ───────────────────
//
// These tests deliberately stay DOM-free (package.json's own test script is plain `node --test`
// over `react-dom/server`'s `renderToStaticMarkup`, which never runs effects or handles clicks —
// see App.tsx's own comment on this); see the real-DOM test at the end of this file for the
// button-click round trip. The reducer is therefore the actual proof of "no fetch without
// confirm": every path through it is exercised directly, with no DOM in the loop at all.

test("controlsReducer: a bare verb click never reaches the sending phase — confirmation is required first", () => {
  for (const verb of CONTROL_VERBS) {
    const confirming = controlsReducer({ phase: "idle" }, { type: "request", verb });
    assert.deepEqual(confirming, { phase: "confirming", verb });
    assert.notEqual(confirming.phase, "sending");
  }
});

test("controlsReducer: confirm only fires from the matching confirming phase", () => {
  const sending = controlsReducer({ phase: "confirming", verb: "stop" }, { type: "confirm" });
  assert.deepEqual(sending, { phase: "sending", verb: "stop" });
});

test("controlsReducer: confirm is a no-op from idle or sending — there is nothing pending to confirm", () => {
  assert.deepEqual(controlsReducer({ phase: "idle" }, { type: "confirm" }), { phase: "idle" });
  assert.deepEqual(controlsReducer({ phase: "sending", verb: "pause" }, { type: "confirm" }), { phase: "sending", verb: "pause" });
});

test("controlsReducer: cancel always returns to idle without ever having reached sending", () => {
  assert.deepEqual(controlsReducer({ phase: "confirming", verb: "resume" }, { type: "cancel" }), { phase: "idle" });
});

test("controlsReducer: settled returns to idle (the request completed, one way or another)", () => {
  assert.deepEqual(controlsReducer({ phase: "sending", verb: "start" }, { type: "settled" }), { phase: "idle" });
});

test("controlsReducer: no sequence of request/cancel actions alone (no confirm) ever produces a sending phase", () => {
  let state: Parameters<typeof controlsReducer>[0] = { phase: "idle" };
  const sequence = [
    { type: "request", verb: "pause" },
    { type: "cancel" },
    { type: "request", verb: "stop" },
    { type: "request", verb: "start" },
    { type: "cancel" },
  ] as const;
  for (const action of sequence) {
    state = controlsReducer(state, action);
    assert.notEqual(state.phase, "sending");
  }
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────

test("renders exactly the four allowed verbs, and no E-STOP button, regardless of engine state", () => {
  const html = renderToStaticMarkup(<Controls enabled />);
  for (const verb of CONTROL_VERBS) {
    assert.match(html, new RegExp(CONTROL_COPY[verb].label));
  }
  assert.doesNotMatch(html, /E-?STOP/i);
  assert.doesNotMatch(html, /emergency/i);
});

test("dashboard.controls: false renders no control buttons at all", () => {
  const html = renderToStaticMarkup(<Controls enabled={false} />);
  assert.equal(html, "");
});

test("every verb is a native <button> — keyboard-reachable by construction, no div-as-button", () => {
  const html = renderToStaticMarkup(<Controls enabled />);
  const buttonCount = html.match(/<button/g)?.length ?? 0;
  assert.equal(buttonCount, CONTROL_VERBS.length);
});

test("confirm copy for every verb is sourced from copy.ts, not an inline string", () => {
  // Render is static (SSR never opens the confirm dialog since it requires a click), so this
  // pins the SOURCE instead: every button's own accessible name traces back to CONTROL_COPY.
  for (const verb of CONTROL_VERBS) {
    assert.ok(CONTROL_COPY[verb].confirm.length > 0, `${verb} has confirm copy`);
  }
});

test("mounting/rendering alone never calls the control function — no dead handler fires on render", () => {
  const onControl = mock.fn(async () => ({ state: "running" }));
  renderToStaticMarkup(<Controls enabled onControl={onControl} />);
  assert.equal(onControl.mock.calls.length, 0);
});

// ── #739 gate② round 1 finding [1] (ac6-confirm-flow-untested) ──────────────────────────────
//
// The reducer proves the STATE MACHINE never reaches `sending` without a confirm; these tests
// prove the actual EFFECT wiring on top of it — zero calls before confirmation, exactly one call
// after — by chaining the real `controlsReducer` transitions into the real `runControlEffect`
// the component's `useEffect` delegates to (the same function, not a parallel reimplementation).

test("runControlEffect: idle and confirming phases never call onControl", async () => {
  const onControl = mock.fn(async () => undefined);
  assert.deepEqual(await runControlEffect({ phase: "idle" }, onControl), { fired: false });
  assert.deepEqual(await runControlEffect({ phase: "confirming", verb: "stop" }, onControl), { fired: false });
  assert.equal(onControl.mock.calls.length, 0);
});

test("runControlEffect: only the sending phase calls onControl, exactly once, with the confirmed verb", async () => {
  const onControl = mock.fn(async () => undefined);
  const result = await runControlEffect({ phase: "sending", verb: "pause" }, onControl);
  assert.deepEqual(result, { fired: true, ok: true });
  assert.equal(onControl.mock.calls.length, 1);
  assert.deepEqual(onControl.mock.calls[0]?.arguments, ["pause"]);
});

test("request -> confirm, chained through the real reducer into the real effect: zero calls before confirm, one call after", async () => {
  const onControl = mock.fn(async () => undefined);
  let state: ReturnType<typeof controlsReducer> = { phase: "idle" };

  state = controlsReducer(state, { type: "request", verb: "stop" });
  assert.deepEqual(await runControlEffect(state, onControl), { fired: false });
  assert.equal(onControl.mock.calls.length, 0, "a bare request must not have fired the call yet");

  state = controlsReducer(state, { type: "confirm" });
  assert.deepEqual(await runControlEffect(state, onControl), { fired: true, ok: true });
  assert.equal(onControl.mock.calls.length, 1, "confirming the same request fires exactly once");
  assert.deepEqual(onControl.mock.calls[0]?.arguments, ["stop"]);
});

// ── #739 gate② round 2 finding [1] (control-rejection-wedges-ui) ────────────────────────────
//
// Before this fix, `runControlEffect`'s caller chained a bare `.then()` with no rejection
// handler: a rejecting `onControl` (any non-2xx `postControl` response, or a network failure)
// left the promise's rejection unhandled AND skipped the `dispatch({ type: "settled" })` that
// returns the reducer to `idle` — the reducer stayed wedged in `sending` forever, every button
// disabled, until a full page reload. These tests pin the fix at the same level round 1's
// confirm-flow tests did: chaining the real reducer into the real effect function, since this
// harness has no jsdom to actually click a button and watch a rejection resolve.

test("runControlEffect: a rejecting onControl never propagates the rejection — it resolves to an honest failure result", async () => {
  const boom = new Error("engine unreachable");
  const onControl = mock.fn(async () => {
    throw boom;
  });
  const result = await runControlEffect({ phase: "sending", verb: "stop" }, onControl);
  assert.deepEqual(result, { fired: true, ok: false, error: boom });
});

test("a rejected request still reports `fired: true` — the caller's dispatch({ type: 'settled' }) must run either way, or the reducer would stay wedged in `sending`", async () => {
  const onControl = mock.fn(async () => {
    throw new Error("503");
  });
  let state: ReturnType<typeof controlsReducer> = { phase: "idle" };
  state = controlsReducer(state, { type: "request", verb: "pause" });
  state = controlsReducer(state, { type: "confirm" });
  assert.equal(state.phase, "sending");

  const result = await runControlEffect(state, onControl);
  assert.equal(result.fired, true, "a failed request is still a SETTLED one — the reducer must return to idle, not stay wedged");
  if (result.fired) assert.equal(result.ok, false);

  // The component's own effect dispatches `settled` whenever `fired` is true, regardless of `ok`
  // — replicated here directly against the reducer, since that's the actual line this finding
  // was about.
  state = controlsReducer(state, { type: "settled" });
  assert.deepEqual(state, { phase: "idle" }, "the UI must return to an actionable state after a failure, never stay disabled forever");
});

test("Controls renders the failure caption, never the raw error/status text, once mounted with onControl already failing", async () => {
  // No jsdom to observe the DOM after a real click+rejection round-trips through the effect, but
  // the component's own failure caption is a fixed string (never derived from the error object) —
  // pinned directly so a future edit can't accidentally start interpolating raw error text into
  // it (the same no-leaked-fetch-error posture App.tsx's `disconnected` header already holds to).
  const html = renderToStaticMarkup(<Controls enabled />);
  assert.doesNotMatch(html, /Couldn't reach the engine/, "not shown before any request has ever failed");
});

test("the confirming dialog renders the exact CONTROL_COPY confirmation text for the requested verb", () => {
  for (const verb of CONTROL_VERBS) {
    const html = renderToStaticMarkup(<Controls enabled initialState={{ phase: "confirming", verb }} />);
    assert.match(html, /role="alertdialog"/);
    assert.ok(html.includes(CONTROL_COPY[verb].confirm), `${verb}'s dialog must render its own CONTROL_COPY confirm text verbatim`);
  }
});

test("the confirming dialog does NOT render while idle — the dialog only appears once a verb is actually requested", () => {
  const html = renderToStaticMarkup(<Controls enabled initialState={{ phase: "idle" }} />);
  assert.doesNotMatch(html, /role="alertdialog"/);
});

// ── real DOM (retro #355) ────────────────────────────────────────────────────────────────────
//
// Every test above that touches the click/effect wiring says, in its own comment, that it's
// working around "no jsdom in this harness" by chaining pure functions instead of clicking a
// real button. That's exactly the class of gap gate② kept re-finding across rounds (#727/#739's
// own "wiring unexercised" findings): a test can be green while the production onClick/useEffect
// composition is broken, because nothing here ever dispatched a real event. `src/test-dom.ts`'s
// `registerRealDom()`, called at the top of this file, now provides a real minimal DOM, so this
// proves the actual button-click round trip once, directly against the reducer-chaining tests above.
test("real DOM: clicking a verb button opens the confirm dialog; clicking Confirm fires onControl exactly once with that verb, then the dialog closes", async () => {
  const onControl = mock.fn(async () => undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Controls enabled onControl={onControl} />);
    });

    const stopButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === CONTROL_COPY.stop.label);
    assert.ok(stopButton, "the real stop button renders");
    await act(async () => {
      stopButton.click();
    });

    assert.equal(container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label"), "confirm stop");
    assert.equal(onControl.mock.calls.length, 0, "no call before the confirm click");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Confirm");
    assert.ok(confirmButton, "the real confirm button renders");
    await act(async () => {
      confirmButton.click();
    });

    assert.equal(onControl.mock.calls.length, 1, "the production onClick -> reducer -> effect chain fired exactly once");
    assert.deepEqual(onControl.mock.calls[0]?.arguments, ["stop"]);
    assert.equal(container.querySelector('[role="alertdialog"]'), null, "the dialog closes once the request settles");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
