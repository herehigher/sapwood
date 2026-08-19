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

(The wrapper uses a local `engine/dist/cli.js` when one exists — a contributor/dogfood
checkout or a Channel A clone that's been built — and otherwise falls back to
`npx sapwood@<version>` pinned to this plugin's own version, since a marketplace install
only runs `npm ci --ignore-scripts` and never builds `engine/dist`. cwd stays the target
repo, so `data/sapwood.sqlite` resolves where the user runs it.)

This reads `data/sapwood.sqlite` directly (or the path given as an argument) — it works
even when no engine session is currently running, and never starts one.
