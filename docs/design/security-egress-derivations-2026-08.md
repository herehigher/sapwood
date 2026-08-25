# Network egress — design derivations

> **Process record.** Internal design/research artifact from sapwood's own development
> history — not end-user documentation. Read `docs/security/egress.md` (current docs/code) for
> shipped state; this file preserves the rejected alternatives and measurements that produced it.

## Worker Bash egress: why engine-enforced sandbox injection was evaluated and deferred

Amended by DR #1009, re-adjudicating #304 (c), further amended 2026-08-20 (owner ruling,
deferral record #1038):

#304 rejected egress isolation on the premise that no proxy/isolation layer existed and building
one would be heavy. That premise is gone — Claude Code's built-in Bash sandbox (see
`docs/security/execution-profiles.md`) IS a layer that could close it, shipped by the host,
requiring no engine-side build. Engine-enforced injection of that sandbox was evaluated (DR
#1009, probed P1–P8) and **deferred pre-release** — no engine-injected sandbox config key ships,
and the engine injects no sandbox settings into any session. The probed floor survives as an
**operator recipe**: an operator who wants Claude Code's built-in Bash sandbox enabled for
engine-spawned sessions configures it in their OWN Claude settings (project/user/managed) — the
engine neither requires nor prevents this.

## Loopback tagging: the motivating observation

A dogfood run flagged `curl http://127.0.0.1:5173/...` dev-server smoke checks with exactly the
prominence of real public egress the same run caught, which trains an operator to skim the
signal. That observation is what produced the tag-not-exclude rule now stated in
`docs/security/egress.md`'s "Loopback targets" section.

## Peripheral WebSearch/WebFetch: alternatives rejected

This is a bounded widening, not a relaxation of the Bash-egress posture: unlike the worker's Bash
egress, this channel is exactly two named, read-only tools, carries no credential into any
project system, and every call is journalled. This design rejected a domain allowlist
(self-defeating — the point is discovering things nobody knew to look for, and an allowlisted
domain accepting an arbitrary path/query is itself an egress channel) and MCP delivery (the
guard hook has no `mcp__` handling at all, so a built-in-tool grant stays visible to the engine's
own enforcement layer and journal in a way an engine-hosted MCP tool would not) — the same
guard-blind-spot fact the host-delegated capability management doctrine later documented at
doctrine level for producer legs generally; this choice of `WebSearch`/`WebFetch` over MCP for
this specific grant remains sound for the same reason.

## codex-exec blind spot 2: the measurement behind "host-wide reads"

Measured on codex-cli 0.145.0: its read-only Seatbelt policy contains `(allow file-read*)`, and
the session's own recorded permission profile reads `{special: root, access: read}`. `-C
<treeDir>` sets the working directory; it is not a containment root. This measurement is what
`docs/security/egress.md`'s "Recorded blind spot 2" statement rests on.

## codex-exec blind spot 3: why a denylist-plus-sweep, not an allowlist

An allowlist for `codexSessionEnv` was considered and rejected: one that silently omits
something the CLI needs breaks every review, and the only way to find the omission is a paid
live run. A denylist plus a generic sweep, with an explicit keep-set for provider transport, has
the bounded failure mode instead — an unknown-shaped secret can survive, but the failure is
disclosed rather than "every review is broken."

## Peripheral settings pinning: rejected in favor of startup detection

Sealing every peripheral session with `--strict-mcp-config`/`--setting-sources ""` (the same
triple gate②'s materialized-tree review sessions use) is not viable here: `--setting-sources ""`
also stops loading the target repo's own `CLAUDE.md` — colliding with the locked ruling
(`docs/security/ambient-repo-context.md`'s "Ambient repo context: record, don't seal"): a
peripheral session absorbing the repo's own `CLAUDE.md` is a deliberately open channel, never
sealed, and pinning would seal it as a side effect for every non-review session. Instead the
design uses lightweight startup detection (`cli.ts::checkWebAccessSettingsDenial`), not
containment — see the #410 decision record's own reserved fallback: "if pinning turns out to
have side effects, the fallback is startup detection and reporting."
