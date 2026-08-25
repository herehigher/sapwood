# AGENTS.md

Tool-neutral entry point for automated agents working in this repository.

**Repository contract.** Before changing or reviewing this repository, read
[`CLAUDE.md`](CLAUDE.md), even if your tool does not load it automatically. It states the
repository-wide non-negotiables and routes each subject to its authoritative source. It is
linked here rather than duplicated, following the repository's one-home-per-fact rule.

**Review tasks.** When reviewing a pull request, also use that PR's review-request comment:
it states what the change is intended to do and how to verify it. The standing review
guidelines below and that per-PR context both apply.

## Review guidelines

Pull requests here converge over several rounds: a PR is normally re-reviewed after each
push, and findings are adjudicated in-thread before the next round. The rules below keep
repeated reviews additive instead of circular.

**Do not re-flag a finding that has already been disposed of.** Before raising something,
check whether it is already settled:

- the review thread carrying it is resolved **and** has a reply stating a disposition —
  accepted, fixed, deferred, or rejected with a reason; or
- the linked issue records the disposition. Its acceptance criteria may carry an
  "AC readjudication" note that deliberately changes, relaxes, or drops a criterion; that
  note is the current contract, not the original wording.

A settled finding is settled. If you believe an adjudication was wrong, say so **in the
existing thread** and explain why — do not re-raise it as a fresh finding.

**Review the current head, and say which commit you reviewed.** Before filing anything,
confirm the head you fetched is still the PR's head; if it has moved, re-read the new head
first — findings against a superseded commit are usually already fixed. State the reviewed
commit SHA in your review summary, so a stale round is visible rather than mistaken for a
fresh one.

**Engage the existing thread instead of opening a duplicate.** If a finding continues an
open thread — same code, same concern, or a partial fix of it — reply there. Open a new
thread only for a genuinely new concern.

**Late rounds should converge.** Once earlier findings are fixed or adjudicated, new
findings should be limited to what the latest push actually introduced. Style preferences
and speculative refactors are out of scope. If you have no blocking finding, say so
plainly — an empty round is a valid and useful result.

---

Standing guidance for this project's *own* built-in reviewer lives in
[`docs/REVIEW-DOCTRINE.md`](docs/REVIEW-DOCTRINE.md). That file addresses a different
reviewer and is not directed at you.
