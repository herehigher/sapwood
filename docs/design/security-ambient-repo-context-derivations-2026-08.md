# Design — ambient repo context: derivations and rejected alternatives

> **Process record.** Internal design/research artifact from sapwood's own development history — not end-user documentation.

**Shipped state vs. this document.** Read [`../security/ambient-repo-context.md`](../security/ambient-repo-context.md) and the current code (`engine/src/roles/context-manifest.ts`, `engine/src/roles/peripheral.ts`, `engine/src/roles/worker.ts`) for what is true now. This file preserves the alternatives-considered and live-measurement narrative that #1094's per-file compression moved out of that page, verbatim, because it is historical derivation rather than a current security claim.

## An earlier claim about peripheral context, corrected

An earlier internal note claimed peripheral role sessions got "no repo context beyond what's substituted into the prompt" — that was never accurate once sessions ran in a real worktree, and the claim is now corrected at its source (`config.ts`'s `RoleSession` schema comment).

## Pre-spawn capture anchor: an earlier directory-existence race

An EARLIER version of this fix anchored to a bounded wait for the worktree DIRECTORY to exist instead of the init line; a focused-suite run caught that race live (directory existence does not imply checkout-complete — `CLAUDE.md` was recorded absent once, flaky), which is why the anchor is the session's own content signal, not a filesystem race.

## gitCommit: a rejected hash-only design

An earlier design gave git-trackable sources a hash-only "recoverable from git history" shape; that was deleted after review because it isn't trustworthy for a write-capable session (`retro`): the file could be modified, added, removed, or untracked before `retro`'s own commit, so `path + commit` would not reliably reproduce the captured content via `git show`.

## mcpTools: a live-probe nuance

One nuance a live probe surfaced: a session's stream-json init line reports ZERO `mcp__`-prefixed tool names even when ambient MCP servers are actually loaded (tool schemas arrive deferred, after init) — the manifest's `mcpTools` field reads the init report's SEPARATE `mcp_servers` field (name + connection status per server), which is NOT subject to that deferral, rather than naively deriving MCP presence from the tool name list.

## Worktree HEAD ref resolution: an earlier, inverted model

An earlier version of this fix inverted the model — treating only `refs/heads/tags/remotes` as shared — which got common cases right by coincidence but would have mis-resolved any other shared namespace, e.g. `refs/notes/*`, from a stale worktree-local shadow.
