#!/usr/bin/env node
// `sapwood` CLI. M0.5 shipped `init`; `run` (the M4 loop driver, #46) lands here; status/stop
// and the rest of the command surface are follow-ups.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { init, InitError } from "./init.js";
import { State } from "./state.js";
import { GithubForge } from "./forge.js";
import { WorkerSupervisor } from "./worker.js";
import { makeReviewer } from "./reviewer.js";
import { MergeDriver } from "./merge-driver.js";
import { runDriver, type StopMode } from "./driver.js";

const require = createRequire(import.meta.url);
// ponytail: runtime require avoids JSON-import assertion syntax differences across Node versions
const { version } = require("../package.json") as { version: string };

const USAGE = `\
usage: sapwood <command> [options]

Commands:
  init          Scaffold .sapwood config and verify GitHub auth
  run           Run the engine loop (tick on a fixed cadence)
    --once         Run exactly one tick, then exit
    --until-idle   Keep ticking until no lanes are in flight, then exit

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
  if (arg !== "init" && arg !== "run") {
    return { stdout: "", stderr: USAGE, code: 2 };
  }
  // "init"/"run" fall through to the async path — signal caller to proceed
  return { stdout: "", stderr: "", code: -1 };
}

/** --once / --until-idle are mutually exclusive; anything else -> the daemon default. Kept as
 *  a pure parse, separate from the engine wiring below, so the flag logic is unit-testable. */
export function parseRunStopMode(argv: string[]): StopMode {
  if (argv.includes("--once")) return "once";
  if (argv.includes("--until-idle")) return "until-idle";
  return "forever";
}

async function runEngine(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const state = new State();
  const forge = new GithubForge(cfg);
  const reviewer = makeReviewer(cfg);
  const mergeGate = new MergeDriver({ forge, reviewer, cfg });
  const supervisor = new WorkerSupervisor({
    cfg,
    // #46: a first-pass live findOpenPr wiring (GithubForge.findOpenPrForIssue) — see its
    // doc comment for the heuristic and its known limits; hardening it is part of the live
    // merge-gate run (#46 scope 3), not this PR.
    hasOpenPr: async (issue) => (await forge.findOpenPrForIssue(issue)) != null,
    findOpenPr: (issue) => forge.findOpenPrForIssue(issue),
  });
  const stopMode = parseRunStopMode(argv);
  console.log(`sapwood run: tickIntervalSec=${cfg.engine.tickIntervalSec} stopMode=${stopMode}`);
  // NOTE: roundSpendUsd (the per-round hard budget gate, cfg.cost.roundBudgetUsd) is left at
  // its TickDeps default (0, i.e. never over-budget) — computing a live "this round's spend"
  // figure needs a round-tracking concept (nextRoundId exists as a pure helper but nothing
  // wires it to a live round yet) that predates this PR and isn't part of #46's scope. The
  // engine-wide daily/wall-clock/kill-switch ceiling (cfg.cost.dailyBudgetUsd /
  // maxWallClockSec / KILL_SWITCH) is fully live regardless — that's the actual hard safety
  // boundary; roundBudgetUsd is a softer per-round throttle.
  const result = await runDriver({ forge, state, supervisor, cfg, mergeGate, tickIntervalSec: cfg.engine.tickIntervalSec, stopMode });
  console.log(`sapwood run: stopped after ${result.ticks} tick(s) (${result.stoppedBy})`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { stdout, stderr, code } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== -1) return code;

  if (argv[2] === "run") {
    return runEngine(argv);
  }

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
// Compare REALPATHS: when installed, `sapwood` is invoked via a bin symlink
// (node_modules/.bin/sapwood), so argv[1] is the symlink while import.meta.url is the real
// dist/cli.js — a raw string compare would be false and the CLI would never run (Codex PR #36).
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
