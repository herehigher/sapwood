import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { guardDecision } from "./guard.js";
import { applyGuardMode, hookResponse, resolveGuardMode, responseFromText } from "./guard-hook.js";

test("resolveGuardMode: only the exact 'soft' selects observe-mode; everything else -> hard (fail-safe)", () => {
  assert.equal(resolveGuardMode({ SAPWOOD_GUARD_MODE: "soft" }), "soft");
  assert.equal(resolveGuardMode({ SAPWOOD_GUARD_MODE: "hard" }), "hard");
  assert.equal(resolveGuardMode({}), "hard"); // unset -> hard
  assert.equal(resolveGuardMode({ SAPWOOD_GUARD_MODE: "Soft" }), "hard"); // typo/case -> hard
  assert.equal(resolveGuardMode({ SAPWOOD_GUARD_MODE: "" }), "hard");
});

test("applyGuardMode: hard enforces (deny passes through); soft allows but logs the would-block", () => {
  const denyOut = responseFromText(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" }, cwd: "/r" }));
  assert.ok(denyOut, "precondition: a gh-merge is a deny");
  // hard: the deny is enforced, nothing logged
  assert.deepEqual(applyGuardMode(denyOut, "hard"), { output: denyOut, logged: null });
  // soft: allowed (output null) but the would-block is surfaced via logged
  assert.deepEqual(applyGuardMode(denyOut, "soft"), { output: null, logged: denyOut });
  // an allow decision is untouched in both modes
  assert.deepEqual(applyGuardMode(null, "soft"), { output: null, logged: null });
  assert.deepEqual(applyGuardMode(null, "hard"), { output: null, logged: null });
});

const CWD = "/repo";
const bash = (command: string, cwd = CWD) => guardDecision("Bash", { command }, cwd);

// ── BLOCK matrix (category C gh-overreach + opaque), ported from 0day test_guard.py,
// trading-domain (funds/keys) cases omitted; reason must name the keyword. ──────────
const BLOCK: [string, string, string][] = [
  // opaque shell/interpreter/process-sub wrappers (fail-closed, inner not parsed)
  ['bash -c "echo hi"', CWD, "opaque"],
  ['bash -lc "ls -la"', CWD, "opaque"],
  ['bash -e -c "ls"', CWD, "opaque"],
  ['sh -lc "ls"', CWD, "opaque"],
  ["bash -O extglob -c 'ls'", CWD, "opaque"],
  ["bash -o pipefail -c 'ls'", CWD, "opaque"],
  ["diff <(ls) <(ls -a)", CWD, "opaque"],
  ["gh pr view <(gh pr merge 143)", CWD, "opaque"],
  ['python -c "print(1)"', CWD, "opaque"],
  ['eval "ls -la"', CWD, "opaque"],
  ['node -e "console.log(1)"', CWD, "opaque"],
  ["env FOO=1 bash -c 'ls'", CWD, "opaque"],
  ["/bin/bash -c 'ls'", CWD, "opaque"],
  ['/usr/bin/python -c "print(1)"', CWD, "opaque"],
  ["command bash -c 'ls'", CWD, "opaque"],
  ["command -p bash -c 'ls'", CWD, "opaque"],
  ["command /bin/bash -c 'ls'", CWD, "opaque"],
  // category C: gh overreach (producer must not merge/promote/release)
  ["gh pr merge 143 --squash", CWD, "merge"],
  ["gh pr ready 143", CWD, "ready"],
  ["gh release create v1 -t x", CWD, "release"],
  ["gh api -X PUT repos/o/r/pulls/143/merge", CWD, "merge"],
  ["gh api --method POST repos/o/r/releases -f tag_name=v1", CWD, "release"],
  ["gh -R o/r pr merge 143 --squash", CWD, "merge"],
  ["gh --repo o/r pr ready 5", CWD, "ready"],
  ["gh pr -R o/r merge 5", CWD, "merge"],
  ["gh pr --repo o/r ready 5", CWD, "ready"],
  ["gh pr -R o/r review 5 --approve", CWD, "review"],
  ["gh api repos/o/r/releases --raw-field tag_name=v1", CWD, "release"],
  ["gh api repos/o/r/pulls/1/merge --raw-field x=y", CWD, "merge"],
  ["gh api --method=PUT repos/o/r/pulls/143/merge", CWD, "merge"],
  ["gh api -XPUT repos/o/r/pulls/143/merge", CWD, "merge"],
  ["gh api graphql -f query='mutation { mergePullRequest }'", CWD, "graphql"],
  ["gh api graphql --raw-field query='mutation { mergePullRequest }'", CWD, "graphql"],
  ["gh api graphql -f query=@op.graphql", CWD, "graphql"],
  ["GH_TOKEN=x gh pr merge 143 --squash", CWD, "merge"],
  ["FOO=1 BAR=2 gh release create v1", CWD, "release"],
  ["/usr/bin/gh pr merge 143", CWD, "merge"],
  ["/usr/local/bin/gh release create v1", CWD, "release"],
  ["gh api --hostname HOST repos/o/r/pulls/1/merge -X POST", CWD, "merge"],
  // env -S split-string recurses into the inner command (here: a gh overreach)
  ["env -S 'gh pr merge 143'", CWD, "merge"],
  // round-1 P1 bypasses (Codex): wrapper recursion + env value-flags
  ["env -u FOO gh pr merge 143", CWD, "merge"],
  ["env FOO=1 uv run gh pr merge 143", CWD, "merge"],
  ["env -C /tmp gh release create v1", CWD, "release"],
  ["uv run npx gh pr merge 1", CWD, "merge"],
  // round-1 P1: gh api value-flags before endpoint + graphql --input opaque
  ["gh api --hostname HOST graphql -f query='mutation { x }'", CWD, "graphql"],
  ["gh api -H 'A: B' graphql -f query='mutation { x }'", CWD, "graphql"],
  ["gh api graphql --input op.json", CWD, "graphql"],
  // round-1 P1: protected-path writes via Bash (redirect / sed -i / tee / cp / dd)
  ["cat foo > engine/src/guard/guard.ts", CWD, "write-path"],
  ["echo x >> .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x >engine/src/guard/guard-hook.ts", CWD, "write-path"],
  ["sed -i s/a/b/ .github/workflows/ci.yml", CWD, "write-path"],
  ["tee .claude/settings.json", CWD, "write-path"],
  ["cp /tmp/evil engine/src/roles/reviewer.ts", CWD, "write-path"],
  ["dd if=/dev/zero of=.claude/settings.local.json", CWD, "write-path"],
  ["echo x > /repo/.github/workflows/deploy.yaml", CWD, "write-path"],
  // round-2 P1 bypasses (Codex): env -S appended argv, wrapped path-prefixed gh,
  // shell grouping, &> redirections
  ["env -S gh pr merge 1", CWD, "merge"],
  ["env /usr/bin/gh pr merge 1", CWD, "merge"],
  ["uv run /usr/bin/gh pr merge 1", CWD, "merge"],
  ["(gh pr merge 1)", CWD, "merge"],
  ["{ gh pr merge 1; }", CWD, "merge"],
  ["( gh release create v1 )", CWD, "release"],
  ["echo x &> .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x &>> engine/src/guard/guard.ts", CWD, "write-path"],
  ["echo x &>engine/src/guard/guard-hook.ts", CWD, "write-path"],
  // round-3 P1 bypasses (Codex): open-ended uv value-flags, gh api --input POST, >& redirect
  ["uv run --with rich gh pr merge 1", CWD, "merge"],
  ["uv run --group dev gh release create v1", CWD, "release"],
  ["uv run --env-file .env gh pr ready 5", CWD, "ready"],
  ["gh api repos/o/r/releases --input body.json", CWD, "release"],
  ["gh api repos/o/r/pulls/1/merge --input x.json", CWD, "merge"],
  ["echo x >& .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x >&engine/src/guard/guard.ts", CWD, "write-path"],
  // round-4 P1 bypasses (Codex): >| split, workflows dir as dest, env -u before -S,
  // write command behind a uv boolean/value flag
  ["echo x >| .github/workflows/ci.yml", CWD, "write-path"],
  ["cp ci.yml .github/workflows", CWD, "write-path"],
  ["cp -t .github/workflows ci.yml", CWD, "write-path"],
  ["env -u FOO -S 'gh pr merge 1'", CWD, "merge"],
  ["uv run --all-extras tee .github/workflows/ci.yml", CWD, "write-path"],
  ["uv run --with rich tee engine/src/guard/guard.ts", CWD, "write-path"],
  // round-5 P1 bypasses (Codex): versioned interpreter, rm/git rm, pr review approve
  ["python3.11 -c 'import os; os.system(\"x\")'", CWD, "opaque"],
  ["node20 -e 'x'", CWD, "opaque"],
  ["rm engine/src/guard/guard.ts", CWD, "write-path"],
  ["rm -rf .github/workflows", CWD, "write-path"],
  ["git rm .github/workflows/ci.yml", CWD, "write-path"],
  ["mv engine/src/guard/guard.ts /tmp/x", CWD, "write-path"],
  ["gh pr review 149 --approve", CWD, "review"],
  ["gh pr review 149 -a", CWD, "review"],
  // round-6 P1 bypasses (Codex): gh api -p/--preview value flag, pr review -r, git restore/checkout
  ["gh api -p corsair graphql -f query='mutation { x }'", CWD, "graphql"],
  ["gh api --preview corsair graphql --input body.json", CWD, "graphql"],
  ["gh pr review 149 -r -b nope", CWD, "review"],
  ["git restore --source HEAD^ -- engine/src/guard/guard.ts", CWD, "write-path"],
  ["git checkout HEAD^ -- .github/workflows/ci.yml", CWD, "write-path"],
  // #352: producer cannot mutate the live issue/board dispatch gates.
  ["gh issue edit 352 --add-label hold", CWD, "dispatch state"],
  ["gh issue edit --remove-label=ready 352", CWD, "dispatch state"],
  ["gh issue edit 352 --milestone M11", CWD, "dispatch state"],
  ["gh issue edit 352 -m M11", CWD, "dispatch state"],
  ["gh issue edit 352 -m=M11", CWD, "dispatch state"],
  ["gh issue edit 352 -mM11", CWD, "dispatch state"],
  ["gh issue edit 352 --remove-milestone", CWD, "dispatch state"],
  ["gh issue edit 352 --add-project=Board", CWD, "dispatch state"],
  ["gh issue edit 352 --remove-project Board", CWD, "dispatch state"],
  ["gh issue edit 352 --add-sub-issue 5", CWD, "dispatch state"],
  ["gh issue edit 352 --remove-sub-issue=5", CWD, "dispatch state"],
  ["gh issue edit 352 --remove-parent", CWD, "dispatch state"],
  ["gh issue edit 352 --parent=3", CWD, "dispatch state"],
  ["gh issue edit 352 --add-label one --remove-label two --milestone=M12", CWD, "dispatch state"],
  ["gh -R o/r issue edit 352 --add-label=hold", CWD, "dispatch state"],
  ["gh --repo=o/r issue edit --title safe 352 --milestone M11", CWD, "dispatch state"],
  ["gh issue -R o/r edit 352 --add-label ready", CWD, "dispatch state"],
  ["gh issue --repo o/r edit 352 -m M11", CWD, "dispatch state"],
  ["uv run --with rich gh issue --repo o/r edit 352 --remove-parent", CWD, "dispatch state"],
  ["uv run --with rich gh issue edit 352 --add-sub-issue 5", CWD, "dispatch state"],
  ["gh label delete hold", CWD, "repository labels"],
  ["gh label list", CWD, "repository labels"],
  ["gh project item-edit --id item", CWD, "project-board"],
  ["uv run --with rich gh label delete hold", CWD, "repository labels"],
  ["command gh project list", CWD, "project-board"],
  ["gh api -X POST repos/o/r/issues/352/labels -f labels=ready", CWD, "labels/milestone/state"],
  ["gh api -X DELETE repos/o/r/issues/352/labels/ready", CWD, "labels/milestone/state"],
  ["gh api -X DELETE 'repos/o/r/issues/352/labels/ready?x=/git/refs'", CWD, "labels/milestone/state"],
  ["gh api repos/o/r/labels -f name=ready", CWD, "labels/milestone/state"],
  ["gh api --method=PATCH repos/o/r/labels/ready -f color=fff", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/issues/352 -f milestone=11", CWD, "labels/milestone/state"],
  ["gh api -XPUT /repos/o/r/issues/352 -f state=closed", CWD, "labels/milestone/state"],
  ["uv run --with rich gh api -X POST repos/o/r/issues/352/labels -f labels=hold", CWD, "labels/milestone/state"],
  ["gh api -X POST repos/o/r/issues/352/sub_issues -F sub_issue_id=123", CWD, "labels/milestone/state"],
  ["gh api -X PUT repos/o/r/issues/352/sub_issues -F sub_issue_id=123", CWD, "labels/milestone/state"],
  ["gh api -X DELETE repos/o/r/issues/352/sub_issue", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/issues/352/sub_issues/priority -F sub_issue_id=123", CWD, "labels/milestone/state"],
  ["gh api -X POST https://api.github.com/repos/o/r/issues/352/sub_issues -F sub_issue_id=123", CWD, "labels/milestone/state"],
  ["gh api -X DELETE 'repos/o/r/issues/352/sub_issue?sub_issue_id=123'", CWD, "labels/milestone/state"],
  ["uv run --with rich gh api -X PATCH repos/o/r/issues/352/sub_issues/priority -F sub_issue_id=123", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/milestones/17 -f title=hijacked", CWD, "labels/milestone/state"],
  ["gh api --method=post repos/o/r/milestones -f title=M12", CWD, "labels/milestone/state"],
  ["gh api -X delete https://api.github.com/repos/o/r/milestones/17", CWD, "labels/milestone/state"],
  ["gh api -X pUt 'repos/o/r/milestones/17?state=closed' -f title=M12", CWD, "labels/milestone/state"],
  ["gh api -X POST repos/o/r/issues/5/sub%5Fissues -F sub_issue_id=6", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/%6Dilestones/17 -f title=x", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/issues/%35 -f milestone=1", CWD, "labels/milestone/state"],
  ["uv run --with rich gh api -X POST repos/o/r/issues/5/sub%5Fissues -F sub_issue_id=6", CWD, "labels/milestone/state"],
  ["gh api -X PATCH https://api.github.com/repos/o/r/%6Dilestones/17?state=open -f title=x", CWD, "labels/milestone/state"],
  ["gh api -X PATCH safe/path -f probe=/repos/o/r/%6Dilestones/17", CWD, "labels/milestone/state"],
  ["gh api -X PUT repos/o/r/pulls/1/%6Derge", CWD, "merge"],
  ["gh api -X POST repos/o/r/%72eleases -f tag_name=v1", CWD, "release"],
  ["gh api -X PATCH repos/o/r/issues/%zz", CWD, "opaque"],
  ["gh api -X PATCH repos/o/r/issues/%5", CWD, "opaque"],
  // #353: producer must not alter the issue lifecycle — close/reopen/transfer/delete are
  // the same mutations #352 blocks at REST/graphql, reached via the high-level CLI verb.
  ["gh issue close 352", CWD, "issue lifecycle"],
  ["gh issue reopen 352", CWD, "issue lifecycle"],
  ["gh issue transfer 352 o/r", CWD, "issue lifecycle"],
  ["gh issue delete 352 --yes", CWD, "issue lifecycle"],
  ["gh issue -R o/r close 5", CWD, "issue lifecycle"],
  ["gh -R o/r issue reopen 5", CWD, "issue lifecycle"],
  ["gh issue --repo o/r transfer 5 o/r2", CWD, "issue lifecycle"],
  ["uv run --with rich gh issue delete 5", CWD, "issue lifecycle"],
  // #353: confirm the REST/graphql equivalents were already blocked by #352 — close/reopen
  // are the same `issues/<n>` state PATCH ISSUE_GOVERNANCE_PATH_RE already matches; transfer
  // and delete have no REST endpoint on GitHub, only graphql mutations already caught upstream.
  ["gh api -X PATCH repos/o/r/issues/352 -f state=closed", CWD, "labels/milestone/state"],
  ["gh api -X PATCH repos/o/r/issues/352 -f state=open", CWD, "labels/milestone/state"],
  ['gh api graphql -f query=\'mutation { transferIssue(input: {issueId: "1", newOwner: "o2"}) { issue { id } } }\'', CWD, "graphql"],
  ["gh api graphql -f query='mutation { deleteIssue(input: {issueId: \"1\"}) { clientMutationId } }'", CWD, "graphql"],
  // #81: defense-in-depth for the KILL_SWITCH / PAUSE control sentinels (fable gate② follow-up
  // to #80) — direct Bash vectors (touch/rm/redirect) plus relative-path traversal.
  ["touch data/KILL_SWITCH", CWD, "write-path"],
  ["touch data/PAUSE", CWD, "write-path"],
  ["touch ../../data/PAUSE", CWD, "write-path"],
  ["rm data/KILL_SWITCH", CWD, "write-path"],
  ["rm -f data/PAUSE", CWD, "write-path"],
  ["rm ../../data/KILL_SWITCH", CWD, "write-path"],
  ["echo x > data/PAUSE", CWD, "write-path"],
  ["echo x >> data/KILL_SWITCH", CWD, "write-path"],
  ["cat foo > ../../data/KILL_SWITCH", CWD, "write-path"],
  ["mv data/PAUSE /tmp/x", CWD, "write-path"],
  ["git rm data/KILL_SWITCH", CWD, "write-path"],
  // node <script.js> indirection where the sentinel target is a literal CLI arg (detectable
  // by path matching, even though the script's own write is opaque to the guard).
  ["node kill.js ../../data/KILL_SWITCH", CWD, "write-path"],
  ["node scripts/unpause.js data/PAUSE", CWD, "write-path"],
  // #84 gate② P2-1: macOS/APFS is case-insensitive — `touch data/pause` creates a file that
  // existsSync(pausePath()) finds, so lowercase/mixed-case variants must block too.
  ["touch data/pause", CWD, "write-path"],
  ["rm data/kill_switch", CWD, "write-path"],
  ["touch ../../data/Pause", CWD, "write-path"],
  ["echo x > data/Kill_Switch", CWD, "write-path"],
  // #84 gate② P2-2: sentinel path glued to a flag (`--target=...`) must not slip past the
  // literal-arg matcher's `-`-prefix skip.
  ["node kill.js --target=../../data/PAUSE", CWD, "write-path"],
  ["node unpause.js --file=data/kill_switch", CWD, "write-path"],
];

for (const [command, cwd, kw] of BLOCK) {
  test(`BLOCK: ${command}`, () => {
    const d = bash(command, cwd);
    assert.equal(d.allow, false, `should block: ${command}`);
    assert.ok(d.reason.toLowerCase().includes(kw), `reason must name ${kw}: ${d.reason}`);
  });
}

// ── ALLOW matrix (benign / read-only) ────────────────────────────────────────
const ALLOW: string[] = [
  "git push origin feat/m1-guard",
  "uv run pytest -q",
  "cat README.md",
  "gh pr view 149 --json state",
  "gh api repos/o/r/pulls/149",
  "gh pr review 149 --comment -b ok", // commenting is fine; only approve/request-changes blocked
  "gh api -X DELETE repos/o/r/git/refs/heads/feat-x",
  "gh api -X DELETE repos/o/r/git/%72efs/heads/feat-x",
  "gh -R o/r pr view 5 --json state",
  "gh -R o/r pr list",
  "gh api --method=GET repos/o/r/pulls/1",
  "gh api graphql -f query='query { viewer { login } }'",
  "uv run --directory x pytest -q",
  "echo $(git rev-parse HEAD)",
  "GH_TOKEN=x gh pr view 5 --json state",
  "/bin/ls -la",
  "command ls",
  "/usr/bin/gh pr view 5 --json state",
  "gh api graphql -f query='query { repository { name } }'",
  "env -S 'ls -la'",
  "gh api --hostname HOST repos/o/r/pulls/1",
  // guardrails for the round-1 fixes: benign writes / reads must still pass
  "cat foo > /tmp/out.txt",
  "echo hi > output.log",
  "sed -i s/a/b/ src/app.ts",
  "cp engine/src/forge.ts /tmp/backup.ts",
  "uv run npx tsc -p .",
  "gh api -H 'A: B' repos/o/r/pulls/1",
  // round-2 guardrails: benign grouping / &> to a non-boundary path must still pass
  "(ls -la)",
  "{ git status; }",
  "echo x &> /tmp/out.log",
  "env -S 'ls -la'",
  // round-3 guardrails: benign uv-with, >& to non-boundary, read-only gh after wrapper
  "uv run --with rich pytest -q",
  "ls foo 2>&1",
  "echo x >& /tmp/out.log",
  "uv run --with rich gh pr view 5 --json state",
  // round-4 guardrails: benign >|, cp to a non-boundary dir, uv boolean + benign cmd
  "echo x >| /tmp/out.log",
  "cp ci.yml /tmp/backup/",
  "uv run --all-extras pytest -q",
  "cp engine/src/forge.ts /tmp/",
  // round-5 guardrails: benign rm/git/mv on non-boundary, cp reading a protected source
  "rm /tmp/scratch.txt",
  "git commit -m wip",
  "mv src/a.ts src/b.ts",
  "cp engine/src/guard/guard.ts /tmp/readonly-copy.ts",
  // round-6 guardrails: benign git checkout/restore + gh api preview read
  "git checkout -b feature",
  "git checkout main",
  "git restore src/app.ts",
  "gh api -p corsair repos/o/r/pulls/1",
  // #352: producer communication and non-governance issue edits remain legitimate.
  "gh issue edit 352 --title 'clearer title' --body 'updated body'",
  "gh issue edit 352 -t 'safe title'",
  "gh issue edit 352 -b 'updated body'",
  "gh issue edit 352 -F body.md",
  "gh issue edit 352 --add-assignee octocat",
  "gh issue edit 352 --remove-assignee octocat",
  "gh issue edit 352 --add-blocked-by 7",
  "gh issue edit 352 --remove-blocked-by 7",
  "gh issue edit 352 --add-blocking 8",
  "gh issue edit 352 --remove-blocking 8",
  // #353: comment/view/list/status/create stay allowed — comment is the worker's refusal channel.
  "gh issue comment 352 --body progress",
  "gh issue view 352",
  "gh issue list",
  "gh issue status",
  "gh issue create --title x --body y",
  "gh pr comment 149 --body progress",
  "gh api -X POST repos/o/r/issues/352/comments -f body=progress",
  "gh api -X POST repos/o/r/issues/%35/%63omments -f body=progress",
  "gh api -X PATCH repos/o/r/issues/%2535 -f body=updated",
  'gh api repos/o/r/issues -f "title=90% done"',
  'gh api -X POST repos/o/r/issues/5/comments -f "body=progress 90% complete"',
  'gh api graphql -f "query=query { viewer { login } }" -f "q=90% done"',
  'gh api repos/o/r/issues -f "title=progress%"',
  'gh api -X POST repos/o/r/issues/5/comments -f "body=progress % complete"',
  'gh api repos/o/r/issues -f "title=progress%zzdone"',
  "gh api repos/o/r/issues/352",
  "gh api -X PATCH repos/o/r/issues/abc -f body=updated",
  // #81 guardrails: benign touch/paths that merely resemble the sentinels must still pass
  "touch /tmp/scratch.txt",
  "touch data/README.md",
  "node scripts/build.js",
  "cat data/README.md",
  // #84 gate② guardrails: /i near-misses ($-anchored, so suffix-extended names pass) and
  // benign flag-glued paths must still pass
  "touch data/paused",
  "touch data/pause-notes.md",
  "node build.js --out=dist/app.js",
];

for (const command of ALLOW) {
  test(`ALLOW: ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

test("a tool the guard doesn't inspect (e.g. WebFetch) is always allowed", () => {
  assert.equal(guardDecision("WebFetch", {}, CWD).allow, true);
});

test("Read/Grep/Glob with no worktreeRoot: containment inactive, allowed regardless of path (unset == not an engine-dispatched session)", () => {
  assert.equal(guardDecision("Read", { file_path: "/repo/anything" }, CWD).allow, true);
  assert.equal(guardDecision("Read", { file_path: "/etc/hosts" }, CWD).allow, true);
  assert.equal(guardDecision("Grep", {}, CWD).allow, true);
  assert.equal(guardDecision("Glob", {}, CWD).allow, true);
});

// ── Read/Grep/Glob worktree containment (#235 PR-A) ──────────────────────────
const WORKTREE_ROOT = "/repo/.claude/worktrees/lane-1";

test("Read ALLOW: a path inside the worktree root", () => {
  const d = guardDecision("Read", { file_path: `${WORKTREE_ROOT}/src/app.ts` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("Read ALLOW: the worktree root itself", () => {
  const d = guardDecision("Read", { file_path: WORKTREE_ROOT }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("Read BLOCK: an absolute host path outside the worktree root (Phase-0's /etc/hosts case)", () => {
  const d = guardDecision("Read", { file_path: "/etc/hosts" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("Read BLOCK: a ../-traversal path that resolves outside the worktree root", () => {
  const d = guardDecision("Read", { file_path: "../../../etc/hosts" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("Read BLOCK: a sibling worktree directory whose name merely starts with the same prefix is NOT treated as inside (no root+'/' boundary bypass)", () => {
  const d = guardDecision("Read", { file_path: `${WORKTREE_ROOT}-evil/secret.txt` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("Read DENY (fail-closed): missing file_path with worktreeRoot set", () => {
  const d = guardDecision("Read", {}, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("fail-closed"));
});

test("Grep ALLOW: path inside the worktree root", () => {
  const d = guardDecision("Grep", { path: `${WORKTREE_ROOT}/src` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("Grep ALLOW: no path given defaults to cwd, which is inside the worktree root", () => {
  const d = guardDecision("Grep", {}, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("Grep BLOCK: absolute path outside the worktree root", () => {
  const d = guardDecision("Grep", { path: "/etc" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("Glob ALLOW: path inside the worktree root", () => {
  const d = guardDecision("Glob", { path: `${WORKTREE_ROOT}/src` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("Glob BLOCK: ../-traversal path escaping the worktree root", () => {
  const d = guardDecision("Glob", { path: "../../secrets" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

// ── NotebookRead worktree containment (#235 PR-A, added in PM review — same read-family
//    gap as Read/Grep/Glob: NotebookRead reads an arbitrary `.ipynb` path via notebook_path,
//    was left out of the first pass, and is fixed the same way here. ────────────────────────
test("NotebookRead ALLOW: an in-worktree .ipynb", () => {
  const d = guardDecision("NotebookRead", { notebook_path: `${WORKTREE_ROOT}/analysis.ipynb` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("NotebookRead BLOCK: an absolute host path outside the worktree root", () => {
  const d = guardDecision("NotebookRead", { notebook_path: "/Users/host/secret.ipynb" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("NotebookRead BLOCK: a ../-traversal path escaping the worktree root", () => {
  const d = guardDecision("NotebookRead", { notebook_path: "../../secret.ipynb" }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("read-containment"));
});

test("NotebookRead DENY (fail-closed): missing notebook_path with worktreeRoot set", () => {
  const d = guardDecision("NotebookRead", {}, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("fail-closed"));
});

test("NotebookRead: no worktreeRoot -> containment inactive, allowed regardless of path", () => {
  assert.equal(guardDecision("NotebookRead", { notebook_path: "/etc/hosts" }, CWD).allow, true);
});

test("Read containment is independent of Write/Edit boundary-file protection: an in-worktree read of the guard's OWN source is allowed", () => {
  const d = guardDecision("Read", { file_path: `${WORKTREE_ROOT}/engine/src/guard/guard.ts` }, WORKTREE_ROOT, WORKTREE_ROOT);
  assert.equal(d.allow, true, d.reason);
});

test("hook: Read/Grep/Glob/NotebookRead with malformed/non-object tool_input fails closed (GUARDED_TOOLS widened by #235 PR-A)", () => {
  assert.equal(hookResponse({ tool_name: "Read", tool_input: "oops" })?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hookResponse({ tool_name: "Grep" })?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hookResponse({ tool_name: "Glob", tool_input: null })?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hookResponse({ tool_name: "NotebookRead" })?.hookSpecificOutput.permissionDecision, "deny");
});

test("hook: SAPWOOD_WORKTREE_ROOT threaded through responseFromText denies an outside Read and allows an inside one", () => {
  const outside = responseFromText(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: WORKTREE_ROOT }),
    WORKTREE_ROOT,
  );
  assert.equal(outside?.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(outside?.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("read-containment"));

  const inside = responseFromText(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: `${WORKTREE_ROOT}/README.md` }, cwd: WORKTREE_ROOT }),
    WORKTREE_ROOT,
  );
  assert.equal(inside, null, "in-worktree read is allowed (null = no intervention)");
});

test("hook: SAPWOOD_WORKTREE_ROOT omitted (no third arg) leaves Read containment inactive — matches a non-engine-spawned session", () => {
  const out = responseFromText(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: WORKTREE_ROOT }));
  assert.equal(out, null, "no worktreeRoot -> containment inactive -> allowed");
});

// ── Write-path protection (issue #9) ─────────────────────────────────────────
const WRITE_BLOCK: [string, string][] = [
  ["/repo/.claude/settings.json", "write-path"],
  [".claude/settings.json", "write-path"],
  [".claude/settings.local.json", "write-path"],
  [".github/workflows/ci.yml", "write-path"],
  ["/repo/.github/workflows/nested/deploy.yaml", "write-path"],
  ["engine/src/guard/guard.ts", "write-path"],
  ["engine/src/guard/guard-hook.ts", "write-path"],
  ["engine/src/roles/reviewer.ts", "write-path"],
  ["../../repo/.claude/settings.json", "write-path"], // path traversal still resolves in
  ["sapwood.config.yaml", "write-path"], // engine/guard config -> a worker can't set guard.mode:soft (#26 R2)
  ["/repo/sapwood.config.yml", "write-path"],
  ["sapwood.config.json", "write-path"],
  ["/repo/engine/dist/guard/guard-hook.js", "write-path"], // compiled hook artifact -> can't overwrite the live hook (#26 R3)
  ["engine/dist/guard/guard.js", "write-path"],
  ["engine/src/roles/merge-driver.ts", "write-path"], // merge path source (gates + TOCTOU pin) (#13 follow-up)
  ["/repo/engine/dist/roles/merge-driver.js", "write-path"], // running merge-path artifact
  ["engine/dist/roles/reviewer.js", "write-path"], // running gate② artifact
  // #81: control sentinels (data/KILL_SWITCH, data/PAUSE) — direct file-tool writes, plus
  // relative-path traversal reaching the same absolute target.
  ["data/KILL_SWITCH", "write-path"],
  ["data/PAUSE", "write-path"],
  ["/repo/data/KILL_SWITCH", "write-path"],
  ["/repo/data/PAUSE", "write-path"],
  ["../../data/PAUSE", "write-path"],
  ["../../data/KILL_SWITCH", "write-path"],
  // #84 gate② P2-1: case-insensitive FS (macOS/APFS) — lowercase names hit the same file.
  ["data/pause", "write-path"],
  ["data/kill_switch", "write-path"],
  ["/repo/data/Pause", "write-path"],
];
for (const [file_path, kw] of WRITE_BLOCK) {
  test(`WRITE BLOCK: ${file_path}`, () => {
    const d = guardDecision("Write", { file_path }, CWD);
    assert.equal(d.allow, false, `should block write: ${file_path}`);
    assert.ok(d.reason.toLowerCase().includes(kw));
  });
}

for (const file_path of ["src/app.ts", "README.md", "/repo/engine/src/forge.ts", ".github/ISSUE_TEMPLATE.md", "data/README.md"]) {
  test(`WRITE ALLOW: ${file_path}`, () => {
    assert.equal(guardDecision("Edit", { file_path }, CWD).allow, true);
  });
}

// ── hook adapter: fail-closed ────────────────────────────────────────────────
test("config write via Bash redirect is also blocked (worker can't echo > sapwood.config.yaml)", () => {
  const d = guardDecision("Bash", { command: "echo 'guard: {mode: soft}' > sapwood.config.yaml" }, CWD);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("write-path"));
});

test("hook: a blocking command yields a deny output naming the reason", () => {
  const out = responseFromText(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 5" }, cwd: CWD }));
  assert.ok(out);
  assert.equal(out!.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(out!.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("merge"));
});

test("hook: a benign command yields null (allow, no intervention)", () => {
  assert.equal(responseFromText(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: CWD })), null);
});

test("hook: invalid JSON fails closed (deny)", () => {
  const out = responseFromText("}{ not json");
  assert.ok(out);
  assert.equal(out!.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(/fail-closed/.test(out!.hookSpecificOutput.permissionDecisionReason));
});

test("hook: non-object payload fails closed (deny)", () => {
  assert.equal(hookResponse(42)?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hookResponse(null)?.hookSpecificOutput.permissionDecision, "deny");
});

test("hook: a guarded tool with missing/non-object tool_input fails closed", () => {
  assert.equal(hookResponse({ tool_name: "Bash" })?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hookResponse({ tool_name: "Write", tool_input: "oops" })?.hookSpecificOutput.permissionDecision, "deny");
  // #235 PR-A: Read joined GUARDED_TOOLS (it's now containment-checked), so a genuinely
  // non-guarded tool (WebFetch — the guard never inspects it) is the ALLOWED example now.
  assert.equal(hookResponse({ tool_name: "WebFetch" }), null);
});

test("hook: a write to a boundary file is denied through the hook", () => {
  const out = responseFromText(JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".github/workflows/ci.yml" }, cwd: CWD }));
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
});

// ── hook adapter: direct-invocation check survives symlink invocation (no fail-open) ────────
// Regression test for the symlink bypass: a naive `import.meta.url === file://${argv[1]}`
// direct-invocation check is FALSE when the hook is launched through a symlink (import.meta.url
// resolves the real file; argv[1] stays the symlink path). That would make `main()` never run,
// so the hook process exits with no decision at all — a silent fail-open of the safety guard.
// Spawn the real guard-hook.ts through a symlink (as tsx would run it) and prove it still
// enforces: a forbidden Bash command fed on stdin must still come back denied, not pass through.
test("guard-hook: invoked via a symlink still enforces (realpath direct-invocation check, no fail-open)", async () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const engineRoot = join(srcDir, "..", "..");
  const real = join(srcDir, "guard-hook.ts");
  const linkDir = mkdtempSync(join(tmpdir(), "sapwood-guard-hook-symlink-"));
  const link = join(linkDir, "guard-hook-via-symlink.ts");
  try {
    symlinkSync(real, link);
    const forbidden = JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 5" }, cwd: "/repo" });
    const result = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", link], { cwd: engineRoot, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ stdout, code }));
      child.stdin.write(forbidden);
      child.stdin.end();
      void stderr;
    });
    assert.equal(result.code, 0, "hook process itself exits 0 (decision travels via stdout JSON, not exit code)");
    assert.ok(
      result.stdout.trim().length > 0,
      "hook must still emit a decision when invoked via a symlink — empty output means the guard silently no-op'd (fail-open)",
    );
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("merge"));
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});
