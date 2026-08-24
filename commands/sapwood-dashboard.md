---
description: Start the sapwood dashboard and open it in a browser when available
argument-hint: "[--port PORT] [--config PATH]"
allowed-tools: Bash(sh:*)
---

Run the sapwood engine CLI's `dashboard` command from the current repository and report its
output back to the user verbatim, unedited:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" dashboard $ARGUMENTS
```

The wrapper uses a local `engine/dist/cli.js` when one exists — a contributor checkout or a
Channel A clone that has been built. A marketplace install has no local engine build, so the
wrapper falls back to `npx sapwood@<plugin version>`. cwd stays the target repository, so the
default database path resolves where the user runs the slash command.

If no browser can be opened, the dashboard server keeps running and prints its URL for the user
to open manually. Stop it with Ctrl+C.
