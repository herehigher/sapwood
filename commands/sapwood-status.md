---
description: Show sapwood engine status — active lanes, gated PRs, spend, kill switch (no live session needed)
argument-hint: "[db-path]"
allowed-tools: Bash(node:*)
---

Run the sapwood engine CLI's `status` command against the current repo's state DB and
report its output back to the user verbatim, unedited:

```bash
node "$CLAUDE_PLUGIN_ROOT/node_modules/.bin/tsx" "$CLAUDE_PLUGIN_ROOT/engine/src/cli.ts" status $ARGUMENTS
```

(The plugin's own `tsx` entry is given by absolute path — a bare `node --import tsx`
would make Node resolve `tsx` from the target repo's cwd, which fails unless that repo
happens to install tsx itself. cwd stays the target repo, so `data/sapwood.sqlite`
resolves where the user runs it.)

This reads `data/sapwood.sqlite` directly (or the path given as an argument) — it works
even when no engine session is currently running, and never starts one.
