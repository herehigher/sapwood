#!/bin/sh
# Shared entry point for the sapwood plugin's slash commands (commands/sapwood-*.md).
# Two branches, in order:
#   1. A local build exists ($CLAUDE_PLUGIN_ROOT/engine/dist/cli.js) — a contributor/dogfood
#      checkout or a Channel A clone with `npm --workspace engine run build` already run. Use it
#      directly: no network, no version drift from whatever's on disk.
#   2. No local build — the plugin was installed from the marketplace (#1031), which only ever
#      runs `npm ci --ignore-scripts` at the plugin root, so `engine/dist` never gets built.
#      Fall back to the published npm package pinned to this exact plugin's own version, so the
#      commands invoked never silently drift from what `/plugin install` fetched.
# cwd is deliberately left untouched in both branches: the target repo's sapwood.config.yaml and
# data/ must resolve from wherever the operator ran the slash command, not from this script's
# location.
set -eu

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"
DIST_CLI="$PLUGIN_ROOT/engine/dist/cli.js"

if [ -f "$DIST_CLI" ]; then
  exec node "$DIST_CLI" "$@"
fi

VERSION=$(node -p "require(process.argv[1]).version" "$PLUGIN_ROOT/.claude-plugin/plugin.json")
exec npx --yes "sapwood@$VERSION" "$@"
