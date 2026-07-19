# 09 — Plugin surface, commands & prompts

sapwood ships as a Claude Code plugin. This section covers the plugin
packaging, the slash-command layer, and the prompt assets — the highest-traffic
contributor surfaces that are not TypeScript.

## Plugin packaging (`.claude-plugin/`)

`.claude-plugin/plugin.json` is the plugin manifest (name `sapwood`, MIT,
keywords). `.claude-plugin/CLAUDE.md` orients the model driving a session *in a
target repository* — the repo whose backlog sapwood works — not a sapwood
contributor; keep its content operator-facing (commands, config, the one rule)
and its behavioral claims in sync with `engine/src/cli.ts`.

## Slash commands (`commands/`)

Each `commands/*.md` file defines one slash command as frontmatter
(description, argument hint, allowed tools) plus instructions that invoke the
engine CLI:

- Commands resolve the engine through `$CLAUDE_PLUGIN_ROOT` and run it with the
  **plugin's own `tsx` binary by absolute path** — a bare `node --import tsx`
  would resolve `tsx` from the target repo, which cannot be assumed to install
  it. The working directory stays the *target* repo, so `sapwood.config.yaml`
  and `data/` resolve where the operator runs the command.
- `sapwood-run.md` → `run` (rounds driver by default; `--once`/`--until-idle`
  are tick-driver-only). `sapwood-status.md` → `status` (reads SQLite without
  an engine). `sapwood-stop.md` manages the `data/KILL_SWITCH` / `data/PAUSE`
  control files directly; there is no CLI `stop` subcommand.

Changing a command's behavior usually means changing `engine/src/cli.ts` and
the command file together, and re-checking `.claude-plugin/CLAUDE.md`'s
description of it.

## Prompt assets (`engine/prompts/`)

The shipped role prompts are the behavior surface for every autonomous session:
`worker.md`, `fix.md`, `architect.md`, `plan-drafter.md`, `plan-reviewer.md`,
`plan-reviewer-confirm.md`, `po.md`, `po-pool.md`, `harvest.md`, `retro.md`,
plus `goal-template.md` / `doctrine-template.md` (provisioned into a target
repo by `sapwood init`) and `issue-templates/`.

- Prompts live **inside the engine package** so packaged installs ship them; a
  repo-root `prompts/` would be absent from installed plugins
  (`engine/src/roles/worker.ts`, `defaultPromptPath`).
- Operators may override a role's prompt via its `promptFile` config key; a
  relative path resolves against the config file's own directory, and a
  set-but-unreadable override fails rather than silently falling back
  (`engine/src/config/config.ts`).
- **A prompt edit is a behavior change.** Prompt/contract expectations are
  exercised by `engine/src/roles/prompts.test.ts` and the role modules' own
  tests; run them, and treat changes to the worker/fix prompts with the same
  care as gate-adjacent code — they steer what producer sessions do.

## Exercising the plugin form factor

Engine tests never cover the plugin packaging itself. To verify it end-to-end,
install the local checkout as a plugin in a scratch target repository (see
[Getting started](../getting-started.md) for the install flow), then run
`/sapwood-status` (no engine needed) and `/sapwood-run --dry-run` (no state
written) against it. `$CLAUDE_PLUGIN_ROOT` resolution and the `tsx` path trick
above are exactly what this smoke-checks.
