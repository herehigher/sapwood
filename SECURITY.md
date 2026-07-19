# Security policy

sapwood's security model — the fail-closed guard, producer ≠ reviewer ≠ merger,
human-merge-only paths, cost ceilings, and the kill switch — is documented in
[docs/security.md](docs/security.md).

## Reporting a vulnerability

If you find a way to defeat the guard hook, escape a worker's worktree
containment, bypass the merge gate, leak forge credentials into a session, or
otherwise weaken the governance layer, **please do not open a public issue.**

Report it privately via GitHub's
[private vulnerability reporting](https://github.com/herehigher/sapwood/security/advisories/new)
for this repository. Include the sapwood version/commit, a minimal reproduction, and
which control you believe is affected.

You should receive an acknowledgement within a few days. Please allow time for
a fix to merge (through the human-merge-only path) before public disclosure.

## Scope notes

- sapwood currently targets **trusted repositories** (your own / your team's);
  behavior on adversarial public repos is explicitly out of the current threat
  model — see the trust assumptions in [docs/security.md](docs/security.md).
- Reports about a *model* misbehaving inside the sandbox the guard already
  contains (e.g. a worker attempting a blocked write and failing) are ordinary
  issues, not vulnerabilities.
