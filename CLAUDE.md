# CLAUDE.md — sapwood

sapwood is the autonomous coding loop with governance built in — a Claude Code plugin that turns a GitHub backlog into reviewed PRs (issues in → reviewed PRs out).

## Verification

Run the acceptance set from the repository root: `npm run build && npm run typecheck && npm run test && npm run lint`.

## Non-negotiables

- Keep producer ≠ reviewer ≠ merger: the worker that writes code never approves or merges it; enforce this with the fail-closed PreToolUse guard hook (`engine/src/guard/`), not a prompt.
- Treat every path listed in `docs/security.md` "Human-merge-only paths" as human-merge-only; that list is authoritative — do not paraphrase or narrow its scope.
- Never run autonomous work unless the guard test suite passes.
- Never push directly to `main` — branch + PR.
- Follow Decision 8 in `docs/PLAN.md` "Constraints (locked decisions)" for dispatch readiness and verification-plan rules.
- Keep framework code generic: `engine/`, skills, and shipped prompts encode only generic dev-loop mechanics; put deployment-specific behavior in a target repo's own config/prompts, never in the framework core.
- Never commit development-state artifacts (probe logs, launch scripts, run data, or `.patch` files) to this repo.

## Documentation principle (source-of-truth partition)

Use GitHub (issues / project board / PRs) for the development process only: what is in flight and the audit trail.
Put durable knowledge — what is true now — in project docs.
Give every fact exactly one home.
Do not close a development round until its durable-knowledge changes land in docs; a round with no such changes closes with zero doc edits, which is a pass.
Send doc changes through the same review gate as code.

## Consult when relevant

- Product decisions, architecture, milestones: `docs/PLAN.md` — relevant section only; do not read it wholesale.
- Security model, budgets, cost ceilings, protected paths: `docs/security.md` — relevant section only.
- Code-comment discipline (why, not what): `engine/prompts/worker.md` "Working language & comments" — apply it to interactive work in this repo too.
- Where text renders (target repo vs this repo) and issue-ref rules: `docs/dev-guide/11-writing-for-audiences.md`.
- Board number, labels, queue mechanics: `sapwood.config.yaml` is authoritative.
- Build/test/lint commands, including running a focused test subset: `docs/dev-guide/04-commands.md`.
- Codebase orientation — layout, modules, vocabulary, and task-based reading paths: start at `docs/dev-guide/README.md`; follow its links, and do not read the guide wholesale.
- Failed-run debugging and `.sapwood/` output: `docs/dev-guide/03-running.md`, "Debugging a failed run".
- What reviewers hold a PR to: `engine/prompts/doctrine-core.md` (generic) + `docs/REVIEW-DOCTRINE.md` (this repo) — apply to interactive review work too.
