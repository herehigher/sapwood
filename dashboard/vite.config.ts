import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** §8: the data server binds 127.0.0.1:4517 and serves dashboard/dist in production. */
const API_SERVER = "http://127.0.0.1:4517";

export default defineConfig({
  plugins: [react()],
  // Statics are served from the plugin package under whatever path the server mounts,
  // so emit relative asset URLs rather than assuming the site root.
  base: "./",
  build: { outDir: "dist", assetsInlineLimit: 0 },
  server: { proxy: { "/api": API_SERVER } },
});
