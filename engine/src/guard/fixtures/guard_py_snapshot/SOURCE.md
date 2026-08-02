# `guard.py` snapshot — provenance

Frozen, point-in-time copy of 0day's PreToolUse safety guard, vendored so
`guard.fuzz.test.ts`'s differential tests run everywhere (CI, a worker's ephemeral
worktree) instead of only on a machine that happens to have a sibling `../0day`
checkout (#427). **This is a reference implementation, not a live sync** — nothing
updates it automatically, and nothing should.

| | |
|---|---|
| Source repo | `herehigher/0day` (private; same owner as sapwood) |
| Source path | `backend/src/zeroday/loop/guard.py` (+ the two `__init__.py` files that make it importable) |
| Last commit touching `guard.py` | `7e3dbd6d85790ea41547a2d55a30fbe80f2ce5d2` (2026-06-22), *"feat(loop): #149 资金路径 PreToolUse guard 安全核 + 钩子适配层 (#150)"* |
| Snapshot taken at 0day HEAD | `19b692b0de0ceb6fa139a467397d9884ad99a033` (2026-06-26) |
| `guard.py` md5 | `b0f694e975d9bca60a5581744e361575` (841 lines) |

Copied verbatim — no edits. If it is ever edited, it stops being a differential
reference and the parity assertion becomes circular.

## What the test does with it

`PYTHONPATH` is pointed at this directory, so `from zeroday.loop.guard import
guard_decision` resolves here. The test asserts one direction only: where guard.py
BLOCKs on the *shared* surface (opaque constructs, Category C / gh overreach),
`guard.ts` must also block. sapwood is deliberately stricter elsewhere and omits
0day's trading-domain categories A/B — see the header of `guard.fuzz.test.ts`.

## Refreshing it

Only a human, deliberately: re-copy the three files from a fresh 0day checkout,
update the commit/md5 rows above, and re-run `npm --workspace engine test`. To
*compare* against a newer guard.py without re-vendoring:

```sh
SAPWOOD_ZERODAY_SRC=../../0day/backend/src npm --workspace engine test
```
