---
description: Show sapwood engine status — active lanes, gated PRs, spend, kill switch (no live session needed)
argument-hint: "[db-path]"
allowed-tools: Bash(node:*)
---

Run the sapwood engine CLI's `status` command against the current repo's state DB and
report its output back to the user verbatim, unedited:

```bash
node --import tsx "$CLAUDE_PLUGIN_ROOT/engine/src/cli.ts" status $ARGUMENTS
```

This reads `data/sapwood.sqlite` directly (or the path given as an argument) — it works
even when no engine session is currently running, and never starts one.
