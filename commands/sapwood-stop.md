---
description: Trip (or lift) the sapwood kill switch — freezes new dispatch/merges and drains running workers gracefully
argument-hint: "[--lift]"
allowed-tools: Bash(mkdir:*), Bash(touch:*), Bash(rm:*), Bash(echo:*)
---

sapwood's kill switch is a plain file sentinel next to the engine's state DB
(`data/KILL_SWITCH` by default) — see `engine/src/state.ts`'s `killSwitchPath`. Setting
it freezes all new dispatch and merges; running workers are asked to hand off
gracefully within `cfg.cost.drainWindowSec`, then the conductor escalates to a hard
kill. This is the documented, human-flippable safety control — no config edit needed.

If the argument is `--lift`, resume the engine by removing the sentinel:

```bash
rm -f data/KILL_SWITCH && echo "kill switch lifted (data/KILL_SWITCH removed) — dispatch and merges can resume next tick."
```

Otherwise (no argument, or any other argument), trip it:

```bash
mkdir -p data && touch data/KILL_SWITCH && echo "kill switch SET (data/KILL_SWITCH) — new dispatch/merges frozen; running workers drain within cfg.cost.drainWindowSec, then a hard stop. Run /sapwood-stop --lift to resume."
```

Report the resulting message back to the user verbatim.
