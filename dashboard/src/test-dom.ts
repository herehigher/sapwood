import test from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Opt-in real DOM for one test FILE (register in `test.before`, unregister in `test.after`) —
 * never global. Node's test runner isolates each `*.test.ts(x)` file in its own process, so this
 * only affects the file that calls it; other files (notably `server.test.ts`, which makes real
 * `fetch` calls against a live HTTP server) keep the platform's native `fetch`/timers untouched.
 * Registering happy-dom process-wide via `--import` was tried first and rejected: happy-dom's
 * `fetch` enforces same-origin/CORS against `window.location`, which broke every real-network
 * test in `server.test.ts`, and its timers hung an unrelated SSR test — see retro round #355.
 *
 * Until this existed, this repo's only render path was `react-dom/server`'s
 * `renderToStaticMarkup`, which never runs effects or dispatches events — every test proving
 * click/effect wiring had to reconstruct it via extracted pure functions or hand-rolled React
 * element tree-walking instead (see Controls.tsx/Controls.test.tsx's own long-standing comments).
 * That ceiling was gate②'s single most repeated finding class this project has recorded
 * (docs/dev-guide/07-dashboard.md); this closes it for files that opt in.
 */
export function registerRealDom(): void {
  test.before(() => {
    GlobalRegistrator.register();
    // Tells React's `act()` (used to flush clicks/effects deterministically) that this really is
    // a test environment — without it React only prints a warning, it still works, but the noise
    // would drown out real signal in CI output.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  test.after(
    async () => {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      await GlobalRegistrator.unregister();
    },
    { timeout: 10_000 },
  );
}
