#!/usr/bin/env -S npx tsx
// check-claude-cli-flags.ts (#799 human-owned CI remainder — docs/patches/799-ci-claude-cli-
// version-floor.patch adds the workflow step that invokes this): the CI-side half of
// docs/PLAN.md:129 ("state a minimum Claude Code CLI version and test against it in CI"). Asserts
// the INSTALLED `claude` binary's `--help` output offers EVERY long flag the engine's OWN `claude`
// invocations can ever emit — `worker.ts`'s `ENGINE_CLAUDE_LONG_FLAGS`, itself DERIVED by calling
// `claudeArgs` (fresh + resume shapes) and the ping's own argv builder with every optional field
// populated, not a hand-maintained list (#799 gate② P1 #4: an earlier 5-flag hand list omitted 19
// real flags, including probeLlmPing's own `--model`/`--output-format`). Zero spend: `--help`
// only — no `-p`, no `--model`, no auth, no network call to Anthropic. Not itself the startup WARN
// (that is claude-version-startup-check.ts, invoked once per engine start); this is a BUILD-TIME
// regression guard — a future engine change that adds a flag the pinned floor's CLI does not
// support fails CI here, instead of failing silently for every operator on the floor version.
//
// Invoked by the patch's own CI job AFTER `npm i -g @anthropic-ai/claude-code@<MIN_CLAUDE_CLI_
// VERSION>` — so CLAUDE_BIN is left unset on purpose (this MUST check the globally-installed
// pinned version, not some other resolved binary) unless a caller explicitly wants to point it at
// a different install for local reproduction.
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
      `resume worker argv, the LLM-ping probe) depend on: ${missing.join(", ")}. Either the floor moved without ` +
      "MIN_CLAUDE_CLI_VERSION's own comment/docs being updated, or the engine started depending on a flag the " +
      "declared floor predates — both need a human decision, not a silent CI pass.",
  );
  process.exit(1);
}

console.log(
  `check-claude-cli-flags: OK — ${claudeBin} --help offers all ${ENGINE_CLAUDE_LONG_FLAGS.length} engine-emitted ` +
    `flags (floor ${MIN_CLAUDE_CLI_VERSION}).`,
);
