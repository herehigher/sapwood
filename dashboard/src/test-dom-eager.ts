import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

/**
 * #892: `registerRealDom()` (`test-dom.ts`) defers registration to `test.before()`, which runs
 * AFTER every static import in the file has already resolved — fine for most code, but some
 * libraries (`@radix-ui/react-use-layout-effect`, which every Radix primitive used here depends
 * on transitively) decide ONCE, at their own MODULE EVALUATION time, whether `document` exists,
 * and permanently cache the answer (`globalThis?.document ? React.useLayoutEffect : () => {}`).
 * If that decision runs before happy-dom is registered, the effect becomes a permanent no-op —
 * `@radix-ui/react-presence`'s open/close state machine depends on it to ever transition past
 * "unmounted", so a Tooltip/Popover's content silently never mounts, with no thrown error.
 *
 * The only fix is registering BEFORE those modules are ever imported. For ESM, that means this
 * module's side effect (registering immediately, not deferred) must be the FIRST import in the
 * test file — before any import that transitively pulls in a Radix component:
 *
 *   import { unregisterRealDomEager } from "../test-dom-eager.ts"; // FIRST — see this file's doc
 *   import { EntityRef } from "./EntityRef.tsx";
 *   ...
 *   test.after(() => unregisterRealDomEager());
 */
GlobalRegistrator.register();
// WHY: @radix-ui/react-use-layout-effect evaluates `globalThis?.document ? React.useLayoutEffect : () => {}` and tsx's classic JSX tests need the same global.
(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function unregisterRealDomEager(): Promise<void> {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  return GlobalRegistrator.unregister();
}
