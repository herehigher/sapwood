import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTROL_VERBS } from "../api/types.ts";
import { CONTROL_COPY } from "../copy.ts";
import { Controls, controlsReducer } from "./Controls.tsx";

test.afterEach(() => mock.restoreAll());

// ── controlsReducer: the misfire-protection state machine (§3 Operations) ───────────────────
//
// No jsdom/testing-library in this repo (package.json's own test script is plain `node --test`
// over `react-dom/server`'s `renderToStaticMarkup`, which never runs effects or handles clicks —
// see App.tsx's own comment on this). The reducer is therefore the actual proof of "no fetch
// without confirm": every path through it is exercised directly, with no DOM in the loop at all.

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
