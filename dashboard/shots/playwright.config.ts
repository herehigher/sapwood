import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * `npm run shots` (frontend-design.md §2, owner adjudication 2026-08-14, #876 D) — visual
 * evidence for a human reviewer / gate②, never a pixel-diff gate. Kept out of `npm test` and
 * `.github/workflows/ci.yml` by living in its own testDir with its own config, so the root `-ws
 * test` glob and the dashboard workspace's own `node --test` script never pick it up.
 *
 * `webServer` builds the self-contained story: `npm run shots` runs `npm run build` first (writes
 * the `?demo` fixture + `dist/`), then Playwright starts `vite preview` against that build and
 * tears it down after — no server to start by hand, no port left open on failure.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: /shots\.spec\.ts$/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: fileURLToPath(new URL("../shots-output/test-results", import.meta.url)),
  use: {
    baseURL: "http://127.0.0.1:4518",
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4518",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
