import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(engineRoot);
const stagedRoot = join(engineRoot, "dashboard-dist");

function removeStagedDashboard(): void {
  rmSync(stagedRoot, { recursive: true, force: true });
}

if (process.argv.includes("--clean")) {
  removeStagedDashboard();
} else {
  execFileSync("npm", ["run", "build", "--workspace", "dashboard"], { cwd: repoRoot, stdio: "inherit" });
  removeStagedDashboard();
  cpSync(join(repoRoot, "dashboard", "dist"), join(stagedRoot, "dist"), { recursive: true });
  cpSync(join(repoRoot, "dashboard", "dist-server"), join(stagedRoot, "dist-server"), { recursive: true });

  for (const required of ["dist/index.html", "dist/build-meta.json", "dist-server/start.js"]) {
    if (!existsSync(join(stagedRoot, required))) {
      removeStagedDashboard();
      throw new Error(`dashboard staging failed: missing ${required}`);
    }
  }
}
