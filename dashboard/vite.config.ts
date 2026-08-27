import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** §8: the data server binds 127.0.0.1:4517 and serves dashboard/dist in production. */
const API_SERVER = "http://127.0.0.1:4517";

// #894: build identity — the exact git SHA of the tree this build ran against, plus when it ran.
// Computed once here (not per-request) and embedded into the client bundle via `define` below,
// so a stale-served bundle has an on-screen tell instead of being discoverable only by hashing
// dist files. `git rev-parse HEAD` names the commit regardless of working-tree dirtiness — the
// same "best-effort build stamp" convention every build-info tool uses.
const BUILD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname })
  .toString()
  .trim();
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    // #894: `server.ts`'s freshness comparison needs the SAME identity outside the JS bundle
    // (it compares dist-vs-repo-HEAD server-side, never by parsing its own served JS) — this
    // writes it as a small sidecar file once the build's other output is already on disk.
    {
      name: "sapwood-build-meta",
      writeBundle(_options, bundle) {
        writeFileSync(join("dist", "build-meta.json"), JSON.stringify({ sha: BUILD_SHA, time: BUILD_TIME }));
        const modules = Object.values(bundle)
          .filter((output): output is Extract<typeof output, { type: "chunk" }> => output.type === "chunk")
          .flatMap((chunk) => Object.keys(chunk.modules))
          .filter((id) => id.replaceAll("\\", "/").includes("/node_modules/"))
          .sort();
        writeFileSync(join("dist", "third-party-modules.json"), JSON.stringify([...new Set(modules)], null, 2));
      },
    },
  ],
  // Statics are served from the plugin package under whatever path the server mounts,
  // so emit relative asset URLs rather than assuming the site root.
  base: "./",
  build: { outDir: "dist", assetsInlineLimit: 0 },
  server: { proxy: { "/api": API_SERVER } },
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
});
