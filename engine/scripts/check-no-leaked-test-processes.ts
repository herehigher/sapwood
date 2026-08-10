#!/usr/bin/env -S npx tsx
// check-no-leaked-test-processes.ts (#786) — AC3: an automated, CI-executed sweep of the REAL OS
// process table for the two process families batch-12's close-out sweep found surviving local
// `npm test` runs for days: worker.test.ts's leaderExitStub descendants (each embeds its own
// mkdtemp "sapwood-reap-*" tmp dir in its own command line) and dashboard.test.ts's real
// dashboard/dist-server/start.js child. AC1/AC2's own fixes (worker.test.ts's/dashboard.test.ts's
// own `after()` hooks) already best-effort-clean these in-process; this script is the independent,
// process-table-level verification the issue asks for, run AFTER `node --test` has fully exited
// (chained via `&&` in package.json's own "test" script, never as a `test()` inside the same
// "src/**/*.test.ts" glob — node --test may run test FILES concurrently, so nothing registered
// inside that glob can prove it ran strictly last).
//
// Pattern note: a bare substring match on "dist-server/start.js" would also hit an unrelated
// process whose OWN argv happens to quote that text (verified live in this repo's own dogfood
// loop: a dispatched worker session's `claude -p <issue body>` argv contains this issue's own
// prose, which quotes both patterns verbatim as examples) — excluded by requiring the matched
// process's own argv[0] not be `claude`, since a leaked test process is always spawned via `node`/
// a stub script's shebang, never as a `claude` agent invocation.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const LEAK_PATTERNS = [/\/sapwood-reap-[^/\s]+\//, /dist-server\/start\.js\b/];

function findSurvivors(): string[] {
  // argv array, no shell involved — same discipline as dashboard-launcher.ts's own subprocess calls.
  const output = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
  return output
    .split("\n")
    .slice(1) // header row
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const sp = line.indexOf(" ");
      const cmdline = sp === -1 ? "" : line.slice(sp + 1);
      const argv0 = cmdline.split(/\s+/, 1)[0] ?? "";
      if (basename(argv0) === "claude") return false;
      return LEAK_PATTERNS.some((re) => re.test(cmdline));
    });
}

const survivors = findSurvivors();
if (survivors.length > 0) {
  console.error(`check-no-leaked-test-processes: ${survivors.length} leaked test process(es) survived npm test:\n${survivors.join("\n")}`);
  process.exit(1);
}
console.log("check-no-leaked-test-processes: clean — no sapwood-reap-*/dist-server/start.js survivors");
