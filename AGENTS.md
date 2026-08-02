# AGENTS.md

Repo-level guidance for automated agents working in this repository.

This file is the **durable** contract: it holds standing rules that apply to every pull
request. Anything specific to one PR — what that change is supposed to do and how to prove
it — is stated in the review-request comment on the PR itself. Both channels apply, and
neither restates the other.

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
