---
description: Emergency-stop, trip/lift the kill switch, or pause/resume dispatch — three human-control tiers
argument-hint: "[--emergency | --clear-emergency | --lift | --pause | --resume]"
allowed-tools: Bash(sh:*)
---

sapwood has three tiers of human control, each a first-class `sapwood` CLI verb backed by a
plain file sentinel next to the engine's state DB (`engine/src/state/state.ts`) — no config
edit needed for any of them:

- **emergency stop** (`sapwood estop`, `estopPath`) — the strictest tier. It is checked
  before the kill switch every tick and wins when both sentinels are present. In the normal path,
  it hard-kills every running/fixing lane's process group on that same tick: there is no drain
  window, in-flight WIP is lost, and killed lanes escalate to `needs-human` with their evidence
  preserved. The kill itself is forge-free — a synchronous durable-PID signal that runs before any
  forge call, so a hung or rejecting forge call can never delay or prevent it. Everything
  AFTER the kill — terminal-state classification/probing, drain escalation, and the
  `needs-human` labels/comments — may still touch the forge, and is best-effort; none of it gates
  process termination anymore. Use it only for credential exposure, destructive calls, or a cost
  blowout faster than the drain window.
- **kill switch** (`sapwood stop`, `killSwitchPath`) — the drain-first tier. Freezes ALL new
  dispatch and merges; running workers are asked to hand off gracefully within
  `cfg.cost.drainWindowSec`, then the conductor escalates to a hard kill. Use this to stop
  the engine unless the emergency-stop conditions above apply.
- **pause** (`sapwood pause`, `pausePath`) — the gentle tier. Freezes new lane dispatch
  ONLY: no new work is claimed or launched. Everything already in flight keeps going exactly
  as normal — running workers finish their work, and PRs already open keep moving through the
  review/merge gate. No drain, no freeze, nothing killed. Use this to stop taking on new
  issues while letting the current round finish cleanly (e.g. before a maintenance window, or
  to hold the queue while triaging).

The precedence order is emergency stop, then kill switch, then pause: if both are active,
emergency stop wins; either strict tier already subsumes pause's dispatch restriction.

This command shells the same CLI verbs any outside-Claude-Code caller uses — scripting, an
agent supervisor, or a human at a terminal (`sapwood pause --help` / `sapwood stop --help` /
`sapwood estop --help` document the full semantics). Every sentinel path (which file gets
touched, wherever the engine's runtime root actually is) is resolved by the CLI itself; this
file only ever picks WHICH verb to run, never touches a file directly.

Note for `sapwood run --until-idle`: a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run EXITS ("finish the round, then
stop") — except a `driving` lane blocked only on a fresh fix leg by PAUSE stays
`driving` (not idle), so `--until-idle` keeps running until PAUSE lifts and that fix
leg dispatches. Clearing the pause afterwards resumes nothing by itself — start a new
`sapwood run`. Under `forever` mode the engine keeps ticking and `--resume` takes
effect on the next tick as described below.

If the argument is `--emergency`, activate the emergency-stop tier (requires `--confirm`,
non-interactively — no TTY prompt, agent-friendly):

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" estop --confirm
```

If the argument is `--clear-emergency`, clear the emergency-stop tier (does NOT require
`--confirm` — lifting an already-fired estop is not itself a destructive act):

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" estop clear
```

If the argument is `--lift`, clear the kill-switch tier:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" stop clear
```

If the argument is `--pause`, activate the pause tier:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" pause
```

If the argument is `--resume`, clear the pause tier:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" pause clear
```

Otherwise (no argument, or any other argument), activate the drain-first kill-switch tier:

```bash
sh "$CLAUDE_PLUGIN_ROOT/bin/sapwood-plugin.sh" stop
```

Report the CLI's own output back to the user verbatim, unedited — same convention as
`/sapwood-run`/`/sapwood-status`/`/sapwood-dashboard`.
