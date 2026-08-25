#!/bin/sh
# Shared entry point for the sapwood plugin's slash commands (commands/sapwood-*.md).
# Two branches, in order:
#   1. A local build exists ($CLAUDE_PLUGIN_ROOT/engine/dist/cli.js) — a contributor/dogfood
#      checkout or a Channel A clone with `npm --workspace engine run build` already run. Use it
#      directly: no network, no version drift from whatever's on disk.
#   2. No local build — the plugin was installed from the marketplace. Fall back to the published
#      npm package pinned to this exact plugin's own version, so the commands invoked never
#      silently drift from what `/plugin install` fetched.
# cwd is deliberately left untouched in both branches: the target repo's sapwood.config.yaml and
# .sapwood/ must resolve from wherever the operator ran the slash command, not from this script's
# location.
set -eu

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"
DIST_CLI="$PLUGIN_ROOT/engine/dist/cli.js"

if [ -f "$DIST_CLI" ]; then
  exec node "$DIST_CLI" "$@"
fi

VERSION=$(node -p "require(process.argv[1]).version" "$PLUGIN_ROOT/.claude-plugin/plugin.json")

# "0.0.0" is the pre-first-release placeholder every manifest carries between releases (see
# scripts/release.ts): no version has ever been tagged, so no npm package exists to fetch by that
# name. Falling through to npx here would either 404 or (worse) silently resolve some unrelated
# `sapwood@0.0.0` on the registry — refuse instead of guessing.
if [ "$VERSION" = "0.0.0" ]; then
  echo "sapwood plugin at an unreleased checkout (version 0.0.0): build it with \`npm --workspace engine run build\` or install a released version from the marketplace" >&2
  exit 1
fi

exec npx --yes "sapwood@$VERSION" "$@"
