# Changelog

All notable changes to sapwood are documented here. Format:
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/). Versioning:
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) — see
[docs/dev-guide/10-releasing.md](docs/dev-guide/10-releasing.md) for the pre-1.0 ladder.

## [Unreleased]

### Added
- Plugin skeleton, YAML/JSON config schema, `IForge` GitHub adapter, WAL-mode
  SQLite state layer (M0); `sapwood init` onboarding — auth preflight, org
  detection, idempotent board/label/milestone provisioning (M0.5).
- Conductor tick loop + headless worker: one Ready issue per isolated worktree
  lane, guard wired live into every session (M2).
- Review gate + merge driver: CI-green plus a fresh non-author review gates an
  autonomous merge; `produce-PR-and-stop` selectable; cost ceiling, kill switch,
  TOCTOU-pinned merge (M3).
- `run`/`status`/`validate`/`dashboard` CLI, plugin slash commands, first-run
  trust ramp, kill-switch/pause sentinels, goal-based stop conditions (M4).
- Round orchestrator: peripheral roles (goal alignment, architecture review,
  gate⓪ verification-plan review, harvest, retrospective) wrapped around the
  tick loop; idle-round standby, gated-PR re-entry, round summaries, dispatch
  quotas, role toggles (M5).
- Review-doctrine injection and environment-failure park — env-vs-task failure
  classification with bounded-backoff auto-resume (M6).
- Round-pool selection, architect batch review, per-round budget/backlog
  accounting hardening (M7).
- Metered, audited read-only MCP proxy for judgment roles; write-ahead
  hardening on the engine's own forge writes (M8).
- Fix loop: workers resolve their own review findings under a three-tier
  hold/needs-human/blocked escalation, so humans adjudicate but never resolve
  reviews themselves (M9).
- `engine-agent`: an engine-composed, static, different-Claude-model gate②
  reviewer, promoted to the default review mode (M10, Decision #10).
- Egress tripwire (monitor-only), the L0–L3 autonomy ladder, native PO-issue
  decomposition (M11).
- v0.2 dashboard — event schema, `GET /api/loop/state`/`/events`, React
  lane-board and event-feed UI — built end-to-end through sapwood's own loop as
  the flagship dogfood run.
- Dogfood hardening surfaced by that run: worker capability containment
  (credential-free producer legs, `gh` alias/extension denial), engine
  robustness (cursor/snapshot drift recovery, merge-gate TOCTOU, resume/fix-leg
  interaction), and host-delegated capability management with configurable
  execution profiles (`host.permissionMode`, `bashSandbox`).

### Security
- Fail-closed `guard.ts` PreToolUse hook, zero-dependency, with a reproduced
  bypass suite and differential/fuzz tests — green before any autonomous run (M1).
- Human-merge-only enforcement for the guard, reviewer, merge driver, security
  config, `.claude/settings*.json`, and `.github/workflows/**`.
- Branch-protection detection (warn-only) as the documented backstop for the
  inherited-host-tool-surface trust model (Decision #11).
