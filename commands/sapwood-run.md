---
description: Run the sapwood engine loop — daemon, one tick, or a dry-run cost preview
argument-hint: "[--once|--until-idle|--dry-run]"
allowed-tools: Bash(node:*)
---

Run the sapwood engine CLI's `run` command from the current repo (the repo whose
`sapwood.config.yaml` and `data/` this session is working in) and report its output
back to the user verbatim, unedited:

```bash
node "$CLAUDE_PLUGIN_ROOT/node_modules/.bin/tsx" "$CLAUDE_PLUGIN_ROOT/engine/src/cli.ts" run $ARGUMENTS
```

(The plugin's own `tsx` entry is given by absolute path — a bare `node --import tsx`
would make Node resolve `tsx` from the target repo's cwd, which fails unless that repo
happens to install tsx itself. cwd stays the target repo, so config/DB paths resolve
where the user runs it.)

Notes for the user, only if they ask or the output needs context:
- No flags = daemon mode (ticks forever until SIGINT/SIGTERM).
- `--once` = a single tick, then exit (exit 1 if that tick failed) — also the cheap
  "supervised, watch one issue" mode: leave exactly one issue `Ready` on the board and
  run `--once` to dispatch just it and stop.
- `--dry-run` = resolve config, list the ready issues that would be dispatched this
  round plus a cost estimate, and exit — no worker spawned, no state written. Use this
  before a first run.
