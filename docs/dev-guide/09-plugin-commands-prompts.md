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

- `sapwood-run.md`, `sapwood-status.md`, and `sapwood-dashboard.md` resolve the engine through a shared wrapper,
  `bin/sapwood-plugin.sh <verb> $ARGUMENTS`: it runs a local `engine/dist/cli.js` when
  one exists (a contributor/dogfood checkout or a built Channel A clone), and otherwise
  falls back to `npx sapwood@<version>` pinned to the plugin's own version — a
  marketplace install has no local engine build. The working directory stays the *target* repo in
  both branches, so `sapwood.config.yaml` and `data/` resolve where the operator runs
  the command. Their `allowed-tools` is `Bash(sh:*)`, not a narrower pin on the wrapper's
  own path: permission-rule matching is a literal-text prefix match against the command
  string as written (`$CLAUDE_PLUGIN_ROOT` unexpanded), and the docs give no example of a
  shell-variable reference inside a specifier, so a pinned pattern risks silently denying
  the command instead of narrowing it. `Bash(sh:*)` is the same breadth class the prior
  `Bash(node:*)` already had — it authorizes the interpreter, not an arbitrary command —
  and the wrapper script itself is the actual boundary on what runs.
- `sapwood-run.md` → `run` (rounds driver by default; `--once`/`--until-idle`
  are tick-driver-only). `sapwood-status.md` → `status` (reads SQLite without
  an engine). `sapwood-dashboard.md` → `dashboard` (serves the packaged dashboard and prints
  its URL when browser opening is unavailable). `sapwood-stop.md` manages the `data/EMERGENCY_STOP` /
  `data/KILL_SWITCH` / `data/PAUSE` control files directly; there is no CLI `stop`
  subcommand.

Changing a command's behavior usually means changing `engine/src/cli.ts` and
the command file together, and re-checking `.claude-plugin/CLAUDE.md`'s
description of it.

## Prompt assets (`engine/prompts/`)

The shipped role prompts are the behavior surface for every autonomous session:
`worker.md`, `fix.md`, `architect.md`, `verification-plan-drafter.md`, `verification-plan-reviewer.md`,
`verification-plan-reviewer-confirm.md`, `po.md`, `po-pool.md`, `harvest.md`, `retro.md`,
plus `goal-template.md` / `doctrine-template.md` (provisioned into a target
repo by `sapwood init`) and `issue-templates/`.

- Prompts live **inside the engine package** so packaged installs ship them; a
  repo-root `prompts/` would be absent from installed plugins
  (`engine/src/roles/worker.ts`, `defaultPromptPath`).
- Operators may override a role's prompt via its prompt-file config key —
  `promptFile` on most roles, plus the sibling keys `worker.fixPromptFile`,
  `roles.verificationPlanReviewer.confirmPromptFile`, and `roles.po.poolPromptFile`; a
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
[Getting started](../guide/getting-started.md) for the install flow), then run
`/sapwood-status` (no engine needed) and `/sapwood-run --dry-run` (no state
written) against it. `$CLAUDE_PLUGIN_ROOT` resolution and `bin/sapwood-plugin.sh`'s
local-dist-vs-`npx` branch above are exactly what this smoke-checks.
