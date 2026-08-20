# 11 — Writing for audiences

sapwood's own text ships to three different readers, and a reference that's
harmless for one is a functional hazard for another. This section codifies
the writing rules the 2026-08-20 release-prep cleanup applied across the repo
(#1043–#1045 and siblings), so new text follows them from the start instead
of needing another pass.

## The three audiences

| Audience | Surfaces |
| --- | --- |
| Human users | README, user-facing docs (`docs/getting-started.md`, `docs/configuration.md`, `docs/supervision.md`, `docs/troubleshooting.md`, …), config comments, CLI/log output, GitHub comments the engine posts, label descriptions |
| User-side agent sessions | `engine/prompts/*.md`, `commands/*.md`, generated skills (e.g. the event-glossary `SKILL.md`) — text injected into or surfaced inside a Claude session running on a **target repo** |
| Contributors | dev docs (this guide), code comments, `CHANGELOG.md`, `docs/PLAN.md`, `docs/security.md` |

Audiences 1 and 2 both run on someone else's repository — sapwood is a
plugin they installed, not the codebase they're looking at. Audience 3 is
the sapwood repo itself.

## The `#NNN` hazard

A bare `#874`-style reference means one specific thing here: an issue or PR
on *this* repo. Written into a surface that reaches audience 1 or 2, it means
something else — GitHub resolves `#NNN` against whatever repo the reader is
looking at, so the same text becomes THAT repo's own issue/PR number. Worse
for posted comments: GitHub also creates a timeline back-reference on the
misresolved issue, planting a visible, wrong cross-link on a stranger's repo.
This is a correctness bug in generated text, not a style preference.

## The edit rule

Meaning-preserving only — no rule's substance changes, only its citation:

- Delete parenthetical provenance (`(#874)`, `design #279 §5`, `retro round
  #365`) that the surrounding sentence already stands without.
- Where the reference carries real substance, restate it as one
  self-contained clause instead of deleting the rule it supported (e.g.
  `docs/security.md's #652 doctrine` → `issue body edits are
  maintainer-only`).
- Output-format placeholders (an example structured-output block showing
  `"issue": 42`) and inline-code illustrations of a marker's shape aren't
  references at all — leave them alone.

## Exemptions

Contributor-only surfaces keep issue/PR numbers, because their reader is
always looking at *this* repo:

- Code comments (untouched by this cleanup on owner ruling).
- `CHANGELOG.md` (conventional — Keep a Changelog format, this repo's own
  history).
- Dev docs, including this guide.
- `docs/security.md`'s inline decision records (owner rulings and DRs, e.g.
  its `Decision #11` / `DR #1009` citations) — the audit trail *is* the
  content there.

## Enforcement

A negative-lint regression test reads every shipped `engine/prompts/**/*.md`
and `commands/*.md` file, strips fenced/inline code spans and structured-
output example blocks, and asserts no `#\d{2,4}` remains outside them:
[`engine/src/roles/prompts.test.ts`](../../engine/src/roles/prompts.test.ts).
Extending the same lint to the generated event-glossary `SKILL.md` and to
engine-posted GitHub comment templates is tracked separately (#1046, #1048)
rather than folded into one sweep.

This only covers audiences 1/2's agent-facing and generated surfaces — it's
a regression floor, not a substitute for applying the edit rule when writing
new text anywhere in the partition above.

---

This chapter is about *citations*, not code-comment style (see
[`engine/prompts/worker.md`](../../engine/prompts/worker.md), "Working
language & comments") or the docs/GitHub source-of-truth partition (see root
[`CLAUDE.md`](../../CLAUDE.md), "Documentation principle") — both already
covered elsewhere.
