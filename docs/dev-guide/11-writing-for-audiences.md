# 11 — Writing for audiences

sapwood's own text ships to different readers on different repos, and a
reference that's harmless in one place is a functional hazard in another.
This section codifies the writing rules the 2026-08-20 release-prep cleanup
applied across the repo (#1043–#1045 and siblings), so new text follows them
from the start instead of needing another pass.

## Where the text renders, not just who reads it

The line that matters is **which repo the text renders on**, not human vs.
agent:

- **Renders on the TARGET repo** — `engine/prompts/*.md`, `commands/*.md`,
  generated skills (e.g. the event-glossary `SKILL.md`), GitHub comments the
  engine posts, label descriptions. Some of these are read by an agent
  session (prompts, commands, skills) and some by a human (posted comments,
  labels) — but all of them render on whatever repo installed sapwood, not
  on sapwood's own. That's what creates the hazard below, for human-read and
  agent-read surfaces alike.
- **Renders in sapwood's OWN repo** — README, user-facing docs
  (`docs/getting-started.md`, `docs/configuration.md`, `docs/security.md`,
  `docs/supervision.md`, `docs/troubleshooting.md`, …), config comments,
  CLI/log output, dev docs (this guide), code comments, `CHANGELOG.md`,
  `docs/PLAN.md`. A reference here can't misresolve — it's still this
  repo's own tracker. The reason to still keep the user-facing subset clean
  is the separate durable-knowledge/process partition (root `CLAUDE.md`,
  "Documentation principle"): those docs state *what is true now*, not
  *which issue introduced it*, and a stray dev-process number is
  reader-comprehension noise even where it resolves correctly. Dev docs,
  code comments, and `CHANGELOG.md` keep references on purpose — see
  Exemptions.

## The `#NNN` hazard

A bare `#874`-style reference means one specific thing on THIS repo: an
issue or PR here. Written into text that renders on a TARGET repo, it means
something else — GitHub resolves `#NNN` against whatever repo the reader is
looking at, so the same text becomes THAT repo's own issue/PR number. Worse
for posted comments: GitHub also creates a timeline back-reference on the
misresolved issue, planting a visible, wrong cross-link on a stranger's
repo. This is a correctness bug in generated text, not a style preference,
and it covers every hardcoded sapwood-dev numeric reference — `#1`
misresolves exactly the same way `#874` does (see Enforcement for where the
regression test's regex is narrower than the policy it guards).

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
- **Not covered by this rule:** an interpolated reference that is SUPPOSED
  to resolve on the target repo — `worker.md`'s `#{{issue.number}}` /
  `` Closes #{{issue.number}} `` template variables, or a runtime-built
  `` `#${issue}` `` string in an engine-posted comment. These stand in for
  the target repo's OWN issue number, not a hardcoded sapwood-dev one;
  stripping them breaks real close/link behavior instead of fixing a
  hazard.

## Exemptions

Some surfaces keep bare sapwood-dev issue/PR numbers on purpose:

- Code comments (untouched by this cleanup on owner ruling) and dev docs,
  including this guide — both render in this repo, for contributors, so a
  reference is neither a misresolution risk nor reader-comprehension noise;
  it's exactly the context a contributor needs.
- `CHANGELOG.md` (conventional — Keep a Changelog format, this repo's own
  history).
- `docs/security.md`'s inline decision records (owner rulings and DRs, e.g.
  its `Decision #11` / `DR #1009` citations) — a narrow exemption, not
  blanket cover for the file. `docs/security.md` is operator/reviewer-facing
  like the rest of the user docs
  ([dev-guide README](README.md), [02 — Repository layout](02-repo-layout.md)),
  and the ordinary edit rule applies to it everywhere else; only its
  decision-record citations stay (owner ruling, 2026-08-20), because the
  audit trail of *how* a security decision was reached is itself the
  durable content there.

## Enforcement

A negative-lint regression test reads every shipped `engine/prompts/**/*.md`
and `commands/*.md` file, strips the `<<<SAPWOOD_RESULT>>>`/`<<<BODY>>>`
structured-output sentinel blocks, triple-backtick fenced code blocks, and
single-line single-backtick inline code spans — tilde fences, multi-backtick
spans, and multiline single-backtick spans are left as ordinary prose — then
asserts no `#\d{2,4}` remains outside them:
[`engine/src/roles/prompts.test.ts`](../../engine/src/roles/prompts.test.ts).
That regex is a practical regression floor, not the policy boundary itself;
widening or narrowing it is a test-maintenance question, not a rule change.
Extending the same lint to the generated event-glossary `SKILL.md` and to
engine-posted GitHub comment templates is tracked separately (#1046, #1048)
rather than folded into one sweep — so today's floor covers the
prompts/commands slice of the target-repo surface, nothing past it.

This is a regression floor, not a substitute for applying the edit rule when
writing new text anywhere in the partition above.

---

This chapter is about *citations*, not code-comment style (see
[`engine/prompts/worker.md`](../../engine/prompts/worker.md), "Working
language & comments") or the docs/GitHub source-of-truth partition (see root
[`CLAUDE.md`](../../CLAUDE.md), "Documentation principle") — both already
covered elsewhere.
