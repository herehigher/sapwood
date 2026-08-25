---
description: Run the sapwood engine loop — daemon, one tick, or a dry-run cost preview
argument-hint: "[--once|--until-idle|--dry-run]"
allowed-tools: Bash(sh:*)
---

Run the sapwood engine CLI's `run` command from the current repo (the repo whose
`sapwood.config.yaml` and runtime state this session is working in) and report its output
back to the user verbatim, unedited:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" run $ARGUMENTS
```

(The wrapper uses a local `engine/dist/cli.js` when one exists — a contributor checkout or a Channel A clone that's been built. A marketplace install has no local engine build; the wrapper falls back to `npx sapwood@<plugin version>`. cwd stays the target
repo, so config/DB paths resolve where the user runs it.)

Notes for the user, only if they ask or the output needs context:
- No flags = the round orchestrator (default `engine.driver: rounds`): peripheral roles
  (aligning/architecting/plan_review/harvesting/retro) wrapped around the dispatch-and-
  drain tick engine, one round at a time, until a signal or a `stop.*` condition winds
  the run down (the in-flight round always finishes, including harvest, before exit).
- `--once` / `--until-idle` are tick-driver-only (`engine.driver: tick` in config):
  `--once` runs exactly one tick then exits (exit 1 if that tick
  failed); `--until-idle` keeps ticking until nothing dispatches, then exits. Under the
  default rounds driver, passing either is a startup ERROR (exit 1, before any dispatch)
  — never silently ignored, since rounds has no single-tick concept.
- Use `--stop-after-issues N` / `--stop-after-prs N` / `--stop-on-milestone NAME` to
  bound a rounds run instead (stop dispatching new lanes, let in-flight lanes finish,
  exit cleanly). These are the rounds-run equivalent of "run for a while, then stop."
- `--dry-run` = resolve config, list the ready issues that would be dispatched this
  round plus a cost estimate, and exit — no worker spawned, no state written. Use this
  before a first run. Driver-agnostic; never combine with --once/--until-idle/--stop-*.
