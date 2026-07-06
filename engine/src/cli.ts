#!/usr/bin/env node
// `sapwood` CLI. M0.5 ships `init`; status/stop and the full command surface land in M4.
import { createRequire } from "node:module";
import { loadConfig } from "./config.js";
import { init, InitError } from "./init.js";

const require = createRequire(import.meta.url);
// ponytail: runtime require avoids JSON-import assertion syntax differences across Node versions
const { version } = require("../package.json") as { version: string };

const USAGE = `\
usage: sapwood <command> [options]

Commands:
  init          Scaffold .sapwood config and verify GitHub auth

Flags:
  --version, -v  Print version and exit
  --help, -h     Print this help and exit
`;

export function runCli(argv: string[]): { stdout: string; stderr: string; code: number } {
  const arg = argv[2];
  if (arg === "--version" || arg === "-v") {
    return { stdout: version + "\n", stderr: "", code: 0 };
  }
  if (arg === "--help" || arg === "-h" || arg === undefined) {
    return { stdout: USAGE, stderr: "", code: 0 };
  }
  if (arg !== "init") {
    return { stdout: "", stderr: USAGE, code: 2 };
  }
  // "init" falls through to async path — signal caller to proceed
  return { stdout: "", stderr: "", code: -1 };
}

async function main(argv: string[]): Promise<number> {
  const { stdout, stderr, code } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== -1) return code;

  try {
    const { actions } = await init(loadConfig());
    for (const a of actions) console.log("•", a);
    console.log("init complete.");
    return 0;
  } catch (e) {
    // Expected, actionable failures (auth/scope) print clean; bugs still throw.
    if (e instanceof InitError) {
      console.error("init failed:", e.message);
      return 1;
    }
    throw e;
  }
}

// Run only when invoked directly (not when imported by tests) — importing this module for
// `runCli` must not execute main()/process.exit and cut off a test subprocess (Codex PR #36).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
