---
description: Show sapwood engine status — active lanes, gated PRs, spend, kill switch (no live session needed)
argument-hint: "[db-path]"
allowed-tools: Bash(sh:*)
---

Run the sapwood engine CLI's `status` command against the current repo's state DB and
report its output back to the user verbatim, unedited:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" status $ARGUMENTS
```

(The wrapper uses a local `engine/dist/cli.js` when one exists — a contributor checkout or a Channel A clone that's been built. A marketplace install has no local engine build; the wrapper falls back to `npx sapwood@<plugin version>`. cwd stays the target
repo, so the default state DB path resolves where the user runs it.)

This reads the engine's state DB directly — `sapwood status`'s own default path, or the path
given as an argument — it works even when no engine session is currently running, and never
starts one.
