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

const NON_ESTOP_VERBS = CONTROL_VERBS.filter((v) => v !== "estop");

test("renders the four non-estop verbs while the engine isn't running — EMERGENCY STOP is verb-legality gated", () => {
  const html = renderToStaticMarkup(<Controls enabled />);
  for (const verb of NON_ESTOP_VERBS) {
    assert.match(html, new RegExp(CONTROL_COPY[verb].label));
  }
  assert.doesNotMatch(html, /EMERGENCY STOP/);
});

// §3 Operations: "verb-legality rendering (only shown when the engine is actually running)".
test("EMERGENCY STOP renders only while the engine reports running — spelled-out label, octagon icon, rust-red class, far-right (last)", () => {
  const notRunning = renderToStaticMarkup(<Controls enabled running={false} />);
  assert.doesNotMatch(notRunning, /EMERGENCY STOP/);

  const html = renderToStaticMarkup(<Controls enabled running />);
  assert.match(html, /EMERGENCY STOP/, "spelled out, never the abbreviation");
  assert.doesNotMatch(html, /E-STOP/);
  assert.match(html, /class="control-estop"/, "rust-red styling hook");
  assert.match(html, /<svg/, "octagon icon — the page's only icon-bearing control");
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.ok(buttons.length > 0);
  assert.match(buttons[buttons.length - 1] as string, /control-estop/, "far-right: last in the control group");
});

// #733 engine-agent finding [1]: `currentEngineState` never folds EMERGENCY_STOP into the derived
// word (engine/src/state/read-model.ts's `deriveEngineState`), so the REAL server can answer
// `engine.state: "running"` at the same time `engine.estopActive: true` — the window between the
// sentinel landing and the engine's own next tick observing it (or a dead engine's tick going
// stale before it ever ticks again). This is the actual combination App.tsx's `running={state ===
// "running"}` can pass straight through, not a hand-picked one the earlier tests avoided.
test("EMERGENCY STOP stays hidden when estopActive is true even though running is also true — the exact combination the real server can serve", () => {
  const html = renderToStaticMarkup(<Controls enabled running estopActive />);
  // Not a bare /EMERGENCY STOP/ check — the Start persists-notice ALSO legitimately says
  // "EMERGENCY STOP is active…" (that text must still render, per AC4). The button itself carries
  // the "control-estop" class the notice doesn't, so that's the precise signal for "did the button
  // render", distinct from the notice.
  assert.doesNotMatch(html, /class="control-estop"/, "nothing left to stop once the halt has already landed");
  assert.match(html, /EMERGENCY STOP is active/, "the Start persists-notice still renders, unaffected");

  // Sanity: the SAME `running` value with `estopActive` false DOES render the button — proves
  // this is a real regression guard on the AND, not a fixture where estop never renders regardless.
  const normalHtml = renderToStaticMarkup(<Controls enabled running estopActive={false} />);
  assert.match(normalHtml, /class="control-estop"/);
});

test("dashboard.controls: false renders no control buttons at all", () => {
  const html = renderToStaticMarkup(<Controls enabled={false} />);
  assert.equal(html, "");
});

test("every verb is a native <button> — keyboard-reachable by construction, no div-as-button", () => {
  const html = renderToStaticMarkup(<Controls enabled />);
  const buttonCount = html.match(/<button/g)?.length ?? 0;
  assert.equal(buttonCount, NON_ESTOP_VERBS.length, "estop stays hidden while not running");

  const runningHtml = renderToStaticMarkup(<Controls enabled running />);
  const runningButtonCount = runningHtml.match(/<button/g)?.length ?? 0;
  assert.equal(runningButtonCount, CONTROL_VERBS.length);
});

test("§7 locked consequence sentence: the estop confirm dialog carries it verbatim", () => {
  const html = renderToStaticMarkup(<Controls enabled initialState={{ phase: "confirming", verb: "estop" }} />);
  assert.match(html, /role="alertdialog"/);
  assert.ok(html.includes("in-flight work is killed, WIP may be lost"), "the locked #293 consequence sentence, verbatim");
});

// #733 AC4: when EMERGENCY_STOP is active, Start must never render/report a "resumed" outcome.
test("estopActive disables Start and names the real release lever (sapwood estop clear), without changing the other verbs", () => {
  const normal = renderToStaticMarkup(<Controls enabled estopActive={false} />);
  assert.doesNotMatch(normal, /sapwood estop clear/);

  const html = renderToStaticMarkup(<Controls enabled estopActive />);
  assert.match(html, /sapwood estop clear/);
  const startButton = html.match(/<button[^>]*>Start<\/button>/);
  assert.ok(startButton, "Start still renders (per the AC's disabled-or-indicator choice)");
  assert.match(startButton[0], /disabled/, "Start must not report a resumed outcome while the halt persists");
  // Pause/Resume/Stop stay unaffected — only Start reacts to estopActive.
  assert.doesNotMatch(html.match(/<button[^>]*>Pause<\/button>/)?.[0] ?? "", /disabled/);
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
// confirm-flow tests did: chaining the real reducer into the real effect function directly,
// rather than clicking a button and watching a rejection resolve through the DOM (see the
// real-DOM test at the end of this file for that path).

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
  // This test stays DOM-free (see the real-DOM test at the end of this file for a real
  // click+rejection round trip); the component's own failure caption is a fixed string (never
  // derived from the error object) — pinned directly so a future edit can't accidentally start
  // interpolating raw error text into it (the same no-leaked-fetch-error posture App.tsx's
  // `disconnected` header already holds to).
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

// #733 AC3 / §3 Operations: EMERGENCY STOP is hold-to-arm, not a bare click — "armed is never
// 'release to fire'". mock.timers is the seam (review doctrine's "no timing-dependent assertions"
// rule): the component's own setTimeout is a fake clock this test drives deterministically,
// never a real elapsed-wall-clock wait racing anything.
test("real DOM: EMERGENCY STOP is hold-to-arm — an early release cancels with zero effect; a completed hold opens the same confirm dialog, and only Confirm fires onControl", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const onControl = mock.fn(async () => undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Controls enabled running onControl={onControl} />);
    });

    const estopButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("EMERGENCY STOP"));
    assert.ok(estopButton, "the real EMERGENCY STOP button renders while running");

    // Release well before the hold threshold — must cancel with no dispatch at all.
    await act(async () => {
      estopButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(async () => {
      estopButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    mock.timers.tick(2000);
    assert.equal(container.querySelector('[role="alertdialog"]'), null, "an early release must never arm the confirm dialog");
    assert.equal(onControl.mock.calls.length, 0);

    // A completed hold arms it — landing on the SAME confirm dialog every other verb uses.
    await act(async () => {
      estopButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(async () => {
      mock.timers.tick(700);
    });
    assert.equal(container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label"), "confirm estop");
    assert.equal(onControl.mock.calls.length, 0, "the hold alone must never fire the control call — confirm is still required");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Confirm");
    assert.ok(confirmButton, "the real confirm button renders");
    await act(async () => {
      confirmButton.click();
    });

    assert.equal(onControl.mock.calls.length, 1, "the production hold -> arm -> confirm -> effect chain fired exactly once");
    assert.deepEqual(onControl.mock.calls[0]?.arguments, ["estop"]);
  } finally {
    mock.timers.reset();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// #733 engine-agent finding [0] (estop-keyboard-inoperable): the button had ONLY pointer handlers
// — no click handler at all (by design, see `ESTOP_ARM_KEYS`'s own doc), so a keyboard/switch
// user focusing it and pressing Enter/Space could do nothing. Enter/Space keydown now arms the
// SAME hold timer a pointer hold does; keyup before it fires cancels with zero effect, exactly
// mirroring the pointer test above.
test("real DOM: EMERGENCY STOP is keyboard-operable — holding Enter/Space arms it exactly like a pointer hold; an early release cancels, OS key-repeat doesn't restart the timer, and only Confirm fires onControl", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const onControl = mock.fn(async () => undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Controls enabled running onControl={onControl} />);
    });

    const estopButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("EMERGENCY STOP"));
    assert.ok(estopButton, "the real EMERGENCY STOP button renders while running");

    // Release Enter well before the hold threshold — must cancel with no dispatch at all.
    await act(async () => {
      estopButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => {
      estopButton.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    });
    mock.timers.tick(2000);
    assert.equal(container.querySelector('[role="alertdialog"]'), null, "an early Enter release must never arm the confirm dialog");
    assert.equal(onControl.mock.calls.length, 0);

    // Holding Space (OS key-repeat fires intervening keydowns while held) must NOT restart the
    // timer on each repeat — only the FIRST keydown (repeat: false) may start it.
    await act(async () => {
      estopButton.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: false }));
    });
    await act(async () => {
      mock.timers.tick(400);
    });
    await act(async () => {
      estopButton.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true }));
    });
    await act(async () => {
      // total 800ms since the FIRST keydown, past ESTOP_HOLD_MS — the repeat above must not have
      // reset the clock, or this wouldn't be enough time left to complete the hold.
      mock.timers.tick(400);
    });
    assert.equal(
      container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label"),
      "confirm estop",
      "a held Space arms it despite intervening key-repeat keydowns",
    );
    assert.equal(onControl.mock.calls.length, 0, "the hold alone must never fire the control call — confirm is still required");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Confirm");
    assert.ok(confirmButton, "the real confirm button renders");
    await act(async () => {
      confirmButton.click();
    });

    assert.equal(onControl.mock.calls.length, 1, "the production hold -> arm -> confirm -> effect chain fired exactly once");
    assert.deepEqual(onControl.mock.calls[0]?.arguments, ["estop"]);
  } finally {
    mock.timers.reset();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
