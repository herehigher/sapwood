# Network egress — design derivations

> **Process record.** Internal design/research artifact from sapwood's own development
> history — not end-user documentation. Read `docs/security/egress.md` (current docs/code) for
> shipped state; this file preserves the rejected alternatives and measurements that produced it.
>
> Each block below is an exact substring of the pre-compression `docs/security/egress.md`, with
> one exception: a relative link target is retargeted where the block's new home
> (`docs/design/`) is not the same directory as its old one (`docs/security/`) — noted inline.
> No wording was added or paraphrased.

## Worker Bash egress: why engine-enforced sandbox injection was evaluated and deferred

**Amended by [DR #1009](https://github.com/herehigher/sapwood/issues/1009), re-adjudicating
[#304](https://github.com/herehigher/sapwood/issues/304) (c), further amended 2026-08-20
(owner ruling, deferral record [#1038](https://github.com/herehigher/sapwood/issues/1038)):**
#304 rejected egress isolation on the premise that no proxy/isolation layer existed and building
one would be heavy. That premise is gone — Claude Code's built-in Bash sandbox (see [Execution
profiles](../security/execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox)
below) IS a layer that could close it, shipped by the host, requiring no engine-side build.
Engine-enforced injection of that sandbox was evaluated (DR #1009, probed P1–P8) and **deferred
pre-release** — no engine-injected sandbox config key ships, and the engine injects no sandbox
settings into any session.

*(link retargeted: `execution-profiles.md` → `../security/execution-profiles.md`, since this
file lives in `docs/design/`, not `docs/security/`)*

## Loopback tagging: the motivating observation

A dogfood run flagged `curl http://127.0.0.1:5173/...` dev-server smoke checks with exactly the
prominence of real public egress the same run caught, which trains an operator to skim the
signal.

## Peripheral WebSearch/WebFetch: alternatives rejected

This design
rejected a domain allowlist (self-defeating — the point is discovering
things nobody knew to look for, and an allowlisted domain accepting an arbitrary path/query is
itself an egress channel) and MCP delivery (the guard hook has no `mcp__` handling at all, so a
built-in-tool grant stays visible to the engine's own enforcement layer and journal in a way an
engine-hosted MCP tool would not) — the same guard-blind-spot fact the host-delegated capability
management doctrine (above) later documented at doctrine level for producer legs generally; this
choice of `WebSearch`/`WebFetch` over MCP for this specific grant remains sound for the same
reason, it just no longer needs restating as though the guard's `mcp__` blindness were unique to
this decision.

*("(above)" is unchanged from the original page — there it referred to the host-delegated
capability management section earlier in the same then-single-page doc; see `docs/security.md`'s
"Host-delegated capability management" for that section today.)*

## codex-exec blind spot 2: the measurement behind "host-wide reads"

Measured on codex-cli 0.145.0: its read-only Seatbelt policy
contains `(allow file-read*)`, and the session's own recorded permission profile reads
`{special: root, access: read}`. `-C <treeDir>` sets the working directory; it is not a
containment root.

## codex-exec blind spot 3: why a denylist-plus-sweep, not an allowlist

(An allowlist was
considered and rejected: one that silently omits something the CLI needs breaks every review, and
the only way to find the omission is a paid live run — a denylist plus sweep, with an explicit
keep-set for provider transport, has the bounded failure mode.)

## Peripheral settings pinning: rejected in favor of startup detection

Sealing every peripheral session with `--strict-mcp-config`/`--setting-sources ""` (the same
triple gate②'s materialized-tree review sessions use) is not viable here: `--setting-sources ""`
also stops loading the target repo's own
`CLAUDE.md` — colliding with the locked ruling below ([Ambient repo context: record, don't
seal](../security/ambient-repo-context.md#ambient-repo-context-record-dont-seal)): a peripheral session absorbing the repo's
own `CLAUDE.md` is a deliberately OPEN channel, never sealed, and pinning would seal it
as a side effect for every non-review session.

*(link retargeted: `ambient-repo-context.md` → `../security/ambient-repo-context.md`, same reason
as above; "the locked ruling below" is unchanged from the original page, where it followed in the
same then-single-page doc — see [Ambient repo context: record, don't
seal](../security/ambient-repo-context.md#ambient-repo-context-record-dont-seal).)*

(The current-fact conclusion this reasoning led to — "the design uses lightweight startup
detection, not containment" — is a current statement, not a derivation, and stays in
`docs/security/egress.md` itself, not here.)
