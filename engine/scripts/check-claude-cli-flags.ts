#!/usr/bin/env -S npx tsx
// check-claude-cli-flags.ts (#799): MANUAL floor check — run by a human when moving
// MIN_CLAUDE_CLI_VERSION or when the engine starts emitting a new `claude` flag. Not wired into
// CI: the former `claude-cli-floor` job downloaded the full ~140MB CLI package on every run for
// a check whose inputs (the floor pin and the engine's flag surface) change a few times a year.
// Asserts the INSTALLED `claude` binary's `--help` output offers EVERY long flag the engine's
// OWN `claude` invocations can ever emit — `worker.ts`'s `ENGINE_CLAUDE_LONG_FLAGS`, itself
// DERIVED by calling `claudeArgs` (fresh + resume shapes), the LLM-ping probe's own argv
// builder, AND the version-floor probe's own argv builder (`probeClaudeVersion`'s
// `["--version"]`) — every shape the engine ever spawns `claude` in, not a hand-maintained list
// (#799 gate② P1 #4 round 1: an earlier 5-flag hand list omitted 19 real flags, including
// probeLlmPing's own `--model`/`--output-format`; round 2: the derivation itself still omitted
// the version-probe's OWN `--version` flag until this fix). Zero spend: `--help` only — no `-p`,
// no `--model`, no auth, no network call to Anthropic. Not itself the startup WARN (that is
// claude-version-startup-check.ts, invoked once per engine start).
//
// To reproduce the floor check: `npm i -g @anthropic-ai/claude-code@<MIN_CLAUDE_CLI_VERSION>`
// then `npx tsx engine/scripts/check-claude-cli-flags.ts`. CLAUDE_BIN points it at a different
// install; unset, it checks the globally-installed `claude`.
import { execFileSync } from "node:child_process";
import { ENGINE_CLAUDE_LONG_FLAGS, MIN_CLAUDE_CLI_VERSION } from "../src/roles/worker.js";

const claudeBin = process.env.CLAUDE_BIN?.trim() || "claude";

let help: string;
try {
  help = execFileSync(claudeBin, ["--help"], { encoding: "utf8", timeout: 30_000 });
} catch (e) {
  console.error(`check-claude-cli-flags: \`${claudeBin} --help\` failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const missing = ENGINE_CLAUDE_LONG_FLAGS.filter((flag) => !help.includes(flag));
if (missing.length > 0) {
  console.error(
    `check-claude-cli-flags: the installed CLI (pinned to the floor, ${MIN_CLAUDE_CLI_VERSION}) does not advertise ` +
      `${missing.length} of the ${ENGINE_CLAUDE_LONG_FLAGS.length} flag(s) the engine's own claude invocations (fresh + ` +
      `resume worker argv, the LLM-ping probe, the version-floor probe) depend on: ${missing.join(", ")}. Either the floor moved without ` +
      "MIN_CLAUDE_CLI_VERSION's own comment/docs being updated, or the engine started depending on a flag the " +
      "declared floor predates — both need a human decision, not a silent CI pass.",
  );
  process.exit(1);
}

console.log(
  `check-claude-cli-flags: OK — ${claudeBin} --help offers all ${ENGINE_CLAUDE_LONG_FLAGS.length} engine-emitted ` +
    `flags (floor ${MIN_CLAUDE_CLI_VERSION}).`,
);
