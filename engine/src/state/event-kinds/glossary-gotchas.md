A Codex CLEAN verdict never appears in the pull request Reviews API — it lands as a plain issue
comment on the PR. Polling the Reviews API for it looks exactly like a hung connector; check the
PR's comments, not its reviews, before assuming a review request is stuck.

A pull request in a merge-CONFLICTING state silently suppresses CI: GitHub reports "no checks
reported" for it, which reads like CI never ran rather than like a merge conflict blocking it from
running at all. Check the PR's `mergeable` state before treating an empty check list as a CI gap.

At any label-timeline anomaly (a label present/absent when the ledger says otherwise, an
escalation that looks unresolved, a hold that looks stale), re-read the issue's/PR's labels live
at the moment of the anomaly. Never reason from a label snapshot taken earlier in the round —
GitHub's live label state is the only authority a label-timeline question can be answered against.
