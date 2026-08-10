# `guard.py` snapshot — provenance

Frozen, point-in-time copy of the private predecessor project's PreToolUse safety guard, vendored so
`guard.fuzz.test.ts`'s differential tests run everywhere (CI, a worker's ephemeral
worktree) instead of only on a machine that happens to have a sibling checkout
checkout (#427). **This is a reference implementation, not a live sync** — nothing
updates it automatically, and nothing should.

| | |
|---|---|
| Source repo | Private predecessor repository |
| Source path | Predecessor safety hook (+ the two `__init__.py` files that make it importable) |
| Last commit touching `guard.py` | Private predecessor commit (2026-06-22) |
| Snapshot taken at predecessor-project HEAD | 2026-06-26 |
| `guard.py` md5 | `b0f694e975d9bca60a5581744e361575` (841 lines) |

Copied verbatim — no edits. If it is ever edited, it stops being a differential
reference and the parity assertion becomes circular.

## What the test does with it

`PYTHONPATH` is pointed at this directory, so `from zeroday.loop.guard import
guard_decision` resolves here. The test asserts one direction only: where guard.py
BLOCKs on the *shared* surface (opaque constructs, Category C / gh overreach),
`guard.ts` must also block. sapwood is deliberately stricter elsewhere and omits
the predecessor project's application-specific categories A/B — see the header of `guard.fuzz.test.ts`.

## Refreshing it

Only a human, deliberately: re-copy the three files from a fresh predecessor checkout,
update the commit/md5 rows above, and re-run `npm --workspace engine test`. To
*compare* against a newer guard.py without re-vendoring:

```sh
SAPWOOD_ZERODAY_SRC=/path/to/predecessor/backend/src npm --workspace engine test
```
