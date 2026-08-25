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

// ── BLOCK matrix (category C gh-overreach + opaque), ported from guard.py's test suite,
// application-specific cases omitted; reason must name the keyword. ──────────
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
  // #779: EMERGENCY_STOP is the strictest of the three sentinels (#724) and was missing from
  // this rule's first pass — same Bash-vector coverage as KILL_SWITCH/PAUSE above.
  ["touch data/EMERGENCY_STOP", CWD, "write-path"],
  ["rm data/EMERGENCY_STOP", CWD, "write-path"],
  ["rm -f ../../data/EMERGENCY_STOP", CWD, "write-path"],
  ["echo x > data/EMERGENCY_STOP", CWD, "write-path"],
  ["node kill.js ../../data/EMERGENCY_STOP", CWD, "write-path"],
  ["node kill.js --target=data/EMERGENCY_STOP", CWD, "write-path"],
  ["touch data/emergency_stop", CWD, "write-path"],
  ["rm ../../data/Emergency_Stop", CWD, "write-path"],
];

for (const [command, cwd, kw] of BLOCK) {
  test(`BLOCK: ${command}`, () => {
    const d = bash(command, cwd);
    assert.equal(d.allow, false, `should block: ${command}`);
    assert.ok(d.reason.toLowerCase().includes(kw), `reason must name ${kw}: ${d.reason}`);
  });
}

// gate② P2-5 on #809: checkControlSentinelArg's reason string used to be a hardcoded
// "data/KILL_SWITCH / data/PAUSE" that went stale the moment #779 extended CONTROL_SENTINEL_RE
// to EMERGENCY_STOP — asserting only the "write-path" keyword (the BLOCK loop above) would not
// have caught that staleness. Pin the actual reason TEXT for a literal-arg EMERGENCY_STOP hit.
test("BLOCK reason text: node kill.js ../../data/EMERGENCY_STOP names all three sentinel tiers, not a stale two-name string", () => {
  const d = bash("node kill.js ../../data/EMERGENCY_STOP");
  assert.equal(d.allow, false);
  assert.ok(d.reason.includes("EMERGENCY_STOP"), `reason must name EMERGENCY_STOP: ${d.reason}`);
  assert.ok(d.reason.includes("KILL_SWITCH"), `reason must still name KILL_SWITCH: ${d.reason}`);
  assert.ok(d.reason.includes("PAUSE"), `reason must still name PAUSE: ${d.reason}`);
  assert.ok(d.reason.includes("control sentinel"), `reason must name the category: ${d.reason}`);
});

// ── #731: sapwood pause/stop/estop CLI verbs — same control-sentinel boundary as the section
// above, reached through the CLI verb instead of a literal path argument. Scope is deliberately
// minimal: only the three stop-control verbs; park/run/status/events stay OUT of scope (see the
// ALLOW cases below, which prove exactly that).
const STOP_CONTROL_BLOCK: string[] = [
  // direct verb, all three tiers, activate form
  "sapwood pause",
  "sapwood stop",
  "sapwood estop --confirm",
  // clear form — #731 PR discussion's own example: lifting an already-fired EMERGENCY_STOP
  // is JUST as invisible to the literal-path sentinel check as activating it
  "sapwood pause clear",
  "sapwood stop clear",
  "sapwood estop clear",
  // extra flags/positionals after the verb, in either order relative to each other — nothing
  // after the verb token changes the match
  "sapwood estop --confirm --config sapwood.config.yaml",
  "sapwood estop --config sapwood.config.yaml --confirm",
  "sapwood stop --config sapwood.config.yaml",
  // node-from-source indirection (dist and src forms — the exact invocation shape
  // commands/sapwood-status.md and docs/guide/getting-started.md Channel A instructions use)
  "node engine/dist/cli.js pause",
  "node engine/dist/cli.js estop --confirm",
  "node --import tsx engine/src/cli.ts stop",
  "node --import tsx engine/src/cli.ts estop clear",
  // path-prefixed direct execution (no `node` prefix) — judgeFragment's own tokens[0]
  // basename-normalization (hasPathSep) already turns this into a bare "cli.js" before this
  // check runs, same as it does for any other path-prefixed command word in this file.
  "./cli.js pause",
  "./engine/dist/cli.js stop",
  // npx/wrapper indirection — bare package name
  "npx sapwood pause",
  "npx -y sapwood estop --confirm",
  // gate② P1 (sol, #731): npx's own documented "run a specific/latest version" syntax — a
  // DISCOVERABLE shape (npm's own docs teach it), not an adversarial one. Confirms
  // isSapwoodCliEntrypoint's `sapwood@` prefix recognition actually fires.
  "npx sapwood@latest stop",
  "npx sapwood@1.2.3 pause",
  "npx sapwood@latest estop --confirm",
];
for (const command of STOP_CONTROL_BLOCK) {
  test(`BLOCK (#731 stop-control verb): ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, false, `should block: ${command}`);
    assert.ok(d.reason.toLowerCase().includes("stop-control"), `reason must name the category: ${d.reason}`);
    assert.ok(d.reason.includes("control-sentinel"), `reason must tie to the sentinel boundary: ${d.reason}`);
  });
}

// Reverse cases: the fence must not over-block. Other sapwood subcommands (an ordinary worker
// has legitimate reason to run these), a substring near-miss on the entrypoint name, and a
// near-miss verb (a different subcommand that merely shares a prefix with a stop-control verb)
// all stay allowed.
const STOP_CONTROL_ALLOW: string[] = [
  "sapwood status",
  "sapwood events",
  "sapwood run",
  "sapwood run --once",
  "sapwood park clear",
  "sapwood validate",
  "sapwood --help",
  // a stop-control-looking token that is NOT the verb immediately after the entrypoint (a
  // milestone name, here) must not false-trip the fence — only the token right after the
  // entrypoint is ever inspected.
  "sapwood run --milestone stop",
  // near-miss command word: NOT the sapwood entrypoint (basename differs)
  "mysapwood stop",
  "node engine/dist/other-cli.js pause",
  // near-miss verb: NOT one of the three exact verbs (Set.has is an exact match, no prefix)
  "sapwood stopwatch",
  "sapwood paused",
  // sapwood entrypoint with a benign verb, through the same node-from-source/npx indirection
  // the BLOCK cases above use — proves the entrypoint detection itself doesn't over-trigger
  "node engine/dist/cli.js status",
  "npx sapwood events",
];
for (const command of STOP_CONTROL_ALLOW) {
  test(`ALLOW (#731 stop-control reverse test): ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

// gate② P1 (sol, #731): a KNOWN, ACCEPTED residual, pinned so a future reader sees this ALLOW
// was a deliberate boundary — not an oversight nobody caught. An npx local-package/`file:` spec
// (or an equivalent scoped-package/aliased invocation) hides the `sapwood` command word entirely
// behind a directory path the fence has no way to distinguish from an arbitrary unrelated
// package: this is the SAME residual class checkControlSentinelArg's own doc already accepts for
// "a script that hardcodes the sentinel path inside its own source" — an accident fence, never a
// hostile jail (docs/security.md's own framing, "Sentinel isolation boundary"). If this
// assertion ever starts failing, that's a signal the fence's scope changed underneath this test —
// update docs/security.md's residual note in the same change, don't just delete this test.
test("ALLOW (#731 KNOWN RESIDUAL, accepted — see docs/security.md 'Sentinel isolation boundary'): npx --offline file:<path>/engine hides the command word behind a local-package spec", () => {
  const d = bash("npx --offline file:../engine stop");
  assert.equal(d.allow, true, `documented residual, not a bug: ${d.reason}`);
});

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
  // #779 reverse test: EMERGENCY_STOP near-miss ($-anchored) must still pass.
  "touch data/EMERGENCY_STOPPED",
  "touch data/EMERGENCY_STOP.md",
  // #781 reverse test: sapwood.config.example near-misses must still pass.
  "touch sapwood.config.example2.yaml",
  "touch sapwood.config.example-notes.md",
];

for (const command of ALLOW) {
  test(`ALLOW: ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

// ── category D: raw git-transport push to the default branch (#679) ─────────
// Active ONLY when defaultBranch is supplied (mirrors SAPWOOD_DEFAULT_BRANCH being set at
// spawn) — bashDefaultBranch below threads it through; the plain `bash()` helper above never
// does, so every "git push origin feat/*"-style case already in the BLOCK/ALLOW matrices
// above stays a rule-inactive ALLOW, unchanged by this addition.
const bashDefaultBranch = (command: string, defaultBranch = "main", cwd = CWD) =>
  guardDecision("Bash", { command }, cwd, undefined, defaultBranch);

// Every reason this category returns names both its category tag and the default branch it
// couldn't prove safety against — a single shared assertion covers every BLOCK row below,
// including the gate② round-1 additions (unresolved var / alias injection / wildcard), which
// deliberately phrase their reason to carry the SAME two keywords as the literal-match rows.
const assertGitPushBlock = (command: string, defaultBranch = "main") => {
  const d = bashDefaultBranch(command, defaultBranch);
  assert.equal(d.allow, false, `should block: ${command}`);
  assert.ok(d.reason.toLowerCase().includes("default branch"), `reason must name the default branch: ${d.reason}`);
  assert.ok(d.reason.toLowerCase().includes("git-push"), `reason must name the git-push category: ${d.reason}`);
};

// Literal-destination forms (AC1's enumerated matrix).
const GIT_PUSH_BLOCK: string[] = [
  "git push origin main",
  "git push origin HEAD:main",
  "git push origin feature:main",
  "git push origin :main",
  "git push --delete origin main",
  "git push --mirror origin",
  "git push --all origin",
  "git push -f origin main",
  // exec-prefix-wrapped form: stripExecPrefix must strip the `env X=1` wrapper first.
  "env X=1 git push origin main",
];
for (const command of GIT_PUSH_BLOCK) {
  test(`BLOCK (git-push default-branch, #679): ${command}`, () => assertGitPushBlock(command));
}

// #679 gate② round 1 (sol P2 e): matrix-completeness rows the issue's own `What` section
// enumerates but round 1's shipped matrix was missing — `refs/heads/main`, the `--force`/
// `--force-with-lease` LONG forms (round 1 only pinned `-f`), and a `git -C dir push ...`
// row pinning gitSkipGlobalFlags' own defense (manually probed working in round 1, never
// pinned by CI).
const GIT_PUSH_BLOCK_MATRIX_COMPLETENESS: string[] = [
  "git push origin refs/heads/main",
  "git push --force origin HEAD:main",
  "git push --force-with-lease origin main",
  "git -C dir push origin HEAD:main",
];
for (const command of GIT_PUSH_BLOCK_MATRIX_COMPLETENESS) {
  test(`BLOCK (git-push default-branch, #679 gate② e): ${command}`, () => assertGitPushBlock(command));
}

// #679 gate② round 1 (sol P1 a/c): "cannot prove this is safe" rows — an unresolved shell
// variable/command-substitution (the guard only ever sees the LITERAL argv text; the worker's
// OWN shell expands these before git ever runs — `$SAPWOOD_DEFAULT_BRANCH` expands to the exact
// value this guard call's own `defaultBranch` argument carries) or a `*` wildcard destination
// (matches without ever spelling out the branch name) both defeat exact-match comparison, so
// BOTH are blocked outright rather than string-compared.
const GIT_PUSH_BLOCK_UNPROVABLE: string[] = [
  "git push origin HEAD:$SAPWOOD_DEFAULT_BRANCH",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — the exact unexpanded-shell-variable bypass #679's guard must block
  "git push origin HEAD:${SAPWOOD_DEFAULT_BRANCH}",
  "git push origin HEAD:$(cat)",
  "git push origin HEAD:`cat`",
  "git push origin 'refs/heads/*:refs/heads/*'",
  "git push origin main:refs/heads/*",
];
for (const command of GIT_PUSH_BLOCK_UNPROVABLE) {
  test(`BLOCK (git-push default-branch, #679 gate② a/c — unprovable refspec): ${command}`, () => assertGitPushBlock(command));
}

// #679 gate② round 1 (sol P1 b): `-c`/`--config` alias injection makes ANY later subcommand
// token untrustworthy (`p` becomes a real `push` once `alias.p=push` is defined for this one
// invocation) — opaque, same doctrine as eval/`sh -c`: blocked regardless of what the apparent
// subcommand is. Covers the space-separated, `--config` long, and glued `-cKEY=VALUE` forms.
const GIT_PUSH_BLOCK_ALIAS_INJECTION: string[] = [
  "git -c alias.p=push p origin HEAD:main",
  "git --config alias.p=push p origin HEAD:main",
  "git -calias.p=push p origin HEAD:main",
];
for (const command of GIT_PUSH_BLOCK_ALIAS_INJECTION) {
  test(`BLOCK (git-push default-branch, #679 gate② b — alias injection): ${command}`, () => assertGitPushBlock(command));
}

// #679 gate② round 2 (sol P1): `--repo`/`--repo=` supplies the repository WITHOUT a positional
// remote — the parser must not ALSO skip the next positional as if it were an unwritten remote,
// or the real refspec destination is silently discarded from the scan (confirmed executable
// against a real bare remote by sol-high: both spellings reached `refs/heads/main`).
const GIT_PUSH_BLOCK_REPO_FLAG: string[] = ["git push --repo origin main", "git push --repo=origin main"];
for (const command of GIT_PUSH_BLOCK_REPO_FLAG) {
  test(`BLOCK (git-push default-branch, #679 gate② round 2 — --repo flag): ${command}`, () => assertGitPushBlock(command));
}

const GIT_PUSH_ALLOW: string[] = ["git push", "git push origin lane-123-abc", "git push --force-with-lease origin lane-123-abc"];
for (const command of GIT_PUSH_ALLOW) {
  test(`ALLOW (git-push default-branch, #679): ${command}`, () => {
    const d = bashDefaultBranch(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

// #679 gate② round 1 (sol P2 d): a value-taking push OPTION whose value happens to equal the
// default branch name, or a REMOTE literally named "main", must not be treated as a refspec
// destination — both are legitimate lane-only pushes the issue's own ALLOW contract covers.
// #679 gate② round 2: the `--repo` form of the same class — a lane-only push via `--repo`
// must not be over-blocked just because the fix above now scans every positional in that mode.
const GIT_PUSH_ALLOW_NOT_A_REFSPEC: string[] = [
  "git push -o main origin lane-123-abc", // -o's VALUE, not a destination
  "git push --push-option=main origin lane-123-abc", // same, glued form
  "git push main lane-123-abc", // "main" is the REMOTE here, not a destination
  "git push --repo origin lane-123-abc", // --repo's VALUE is the repo; the refspec is lane-only
  "git push --repo=origin lane-123-abc", // same, glued form
];
for (const command of GIT_PUSH_ALLOW_NOT_A_REFSPEC) {
  test(`ALLOW (git-push default-branch, #679 gate② d — not a refspec): ${command}`, () => {
    const d = bashDefaultBranch(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

// Every BLOCK case above (including the gate② round-1/round-2 additions) stays allowed when
// SAPWOOD_DEFAULT_BRANCH is unset — the rule is inactive outside an engine-dispatched session
// (same "unset == not engine-dispatched" stance checkReadContainment already takes for
// worktreeRoot).
for (const command of [
  ...GIT_PUSH_BLOCK,
  ...GIT_PUSH_BLOCK_MATRIX_COMPLETENESS,
  ...GIT_PUSH_BLOCK_UNPROVABLE,
  ...GIT_PUSH_BLOCK_ALIAS_INJECTION,
  ...GIT_PUSH_BLOCK_REPO_FLAG,
]) {
  test(`ALLOW (git-push default-branch UNSET, #679): ${command}`, () => {
    const d = bash(command); // bash() never threads a defaultBranch — rule inactive
    assert.equal(d.allow, true, `should allow with SAPWOOD_DEFAULT_BRANCH unset: ${command} (reason=${d.reason})`);
  });
}

// #679 gate② round 2 (sol P1, PM ruling — ACCEPTED RESIDUAL, not fixed): the malicious intent
// here lives in git STATE the argv scan cannot see — a PRE-PERSISTED `git config alias.*` (or
// `GIT_CONFIG_*` environment aliases) resolved by a LATER, argv-innocent invocation. Extending
// the alias-injection check to recognize `p` as `push` here would require modeling git's own
// config resolution, not scanning one more token spelling — the same class of boundary
// checkControlSentinelArg's "hardcoded path in a script" residual already accepts. GitHub branch
// protection (DR #616) is the backstop of record for this class; see docs/security.md's #679
// section, "argv-visible forms only" paragraph. Pinned here, deliberately, as a KNOWN ALLOW —
// not a silent gap: a future reader (or a future gate②) should see this was a decided boundary,
// not an oversight.
test("KNOWN RESIDUAL (#679 gate② round 2, PM-ruled accepted — see docs/security.md): a PRE-PERSISTED git-config alias is not detected by an argv scan — the guard sees only 'git p ...', never the earlier 'git config alias.p push' that made 'p' mean 'push'", () => {
  const d = bashDefaultBranch("git config alias.p push && git p origin HEAD:main");
  assert.equal(d.allow, true, "documented residual — accepted by PM ruling, not a regression");
});

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

// ── NotebookEdit write-path protection (#620 — the matcher omitted NotebookEdit entirely, so
//    notebook writes bypassed the hook; write-family semantics, path field is notebook_path). ──
test("NotebookEdit BLOCK: notebook under a protected path (guard's own source)", () => {
  const d = guardDecision("NotebookEdit", { notebook_path: "engine/src/guard/guard.ts" }, CWD);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("write-path"));
});

test("NotebookEdit BLOCK: notebook under .github/workflows", () => {
  const d = guardDecision("NotebookEdit", { notebook_path: ".github/workflows/ci.ipynb" }, CWD);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("write-path"));
});

test("NotebookEdit ALLOW: an ordinary notebook (reverse test — the widening must not over-block)", () => {
  assert.equal(guardDecision("NotebookEdit", { notebook_path: "analysis.ipynb" }, CWD).allow, true);
});

test("NotebookEdit reads notebook_path, not file_path — the field pick is load-bearing (#620)", () => {
  // Claude Code's NotebookEdit schema carries notebook_path; file_path on a NotebookEdit input is
  // not a real tool shape. Pin that the guard consults the real field, so a future refactor can't
  // silently fall back to file_path and read every NotebookEdit as path-less.
  const d = guardDecision("NotebookEdit", { notebook_path: "data/KILL_SWITCH", file_path: "src/ok.ts" }, CWD);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("write-path"));
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
  // #620 (Codex review P3): pin NotebookEdit's GUARDED_TOOLS membership at the hook layer too —
  // without this line, dropping it from GUARDED_TOOLS would let malformed NotebookEdit input fall
  // through as {} and ALLOW while the whole suite stays green.
  assert.equal(hookResponse({ tool_name: "NotebookEdit", tool_input: "oops" })?.hookSpecificOutput.permissionDecision, "deny");
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
  // gate② P1 on #809: this rule was found missing case-insensitive matching — macOS/APFS is
  // case-insensitive by default, so an uppercase/mixed-case name still hits the real file.
  ["SAPWOOD.CONFIG.YAML", "write-path"],
  ["sub/../Sapwood.Config.Yaml", "write-path"],
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
  // #779: EMERGENCY_STOP — same direct-write, traversal, and case-variant coverage as
  // KILL_SWITCH/PAUSE above (the strictest of the three sentinel tiers, #724).
  ["data/EMERGENCY_STOP", "write-path"],
  ["/repo/data/EMERGENCY_STOP", "write-path"],
  ["../../data/EMERGENCY_STOP", "write-path"],
  ["data/emergency_stop", "write-path"],
  ["/repo/data/Emergency_Stop", "write-path"],
  // #781: the init-starter template — same rule shape as sapwood.config.* above, but a
  // separate match target (the root config and the shipped example are different files).
  ["sapwood.config.example.yaml", "write-path"],
  ["sapwood.config.example.yml", "write-path"],
  ["sapwood.config.example.json", "write-path"],
  ["/repo/sapwood.config.example.yaml", "write-path"],
  ["../../sapwood.config.example.yaml", "write-path"],
  // gate② P1 on #809: same case-insensitivity gap as the root config rule above — the exact
  // reproduction the reviewer posted (Write SAPWOOD.CONFIG.EXAMPLE.YAML => allow=true pre-fix).
  ["SAPWOOD.CONFIG.EXAMPLE.YAML", "write-path"],
  ["sub/../Sapwood.Config.Example.Yaml", "write-path"],
];
for (const [file_path, kw] of WRITE_BLOCK) {
  test(`WRITE BLOCK: ${file_path}`, () => {
    const d = guardDecision("Write", { file_path }, CWD);
    assert.equal(d.allow, false, `should block write: ${file_path}`);
    assert.ok(d.reason.toLowerCase().includes(kw));
  });
}

for (const file_path of [
  "src/app.ts",
  "README.md",
  "/repo/engine/src/forge.ts",
  ".github/ISSUE_TEMPLATE.md",
  "data/README.md",
  // #779 reverse: near-miss sentinel name stays allowed ($-anchor).
  "data/EMERGENCY_STOPPED",
  // #781 reverse: near-miss template name stays allowed ($-anchor).
  "sapwood.config.example2.yaml",
]) {
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

// #781: the init-starter template gets the same Bash-redirect coverage as the root config above.
test("init-starter template write via Bash redirect is also blocked (worker can't echo > sapwood.config.example.yaml)", () => {
  const d = guardDecision("Bash", { command: "echo 'merge: {mode: auto}' > sapwood.config.example.yaml" }, CWD);
  assert.equal(d.allow, false);
  assert.ok(d.reason.toLowerCase().includes("write-path"));
});

// gate② P1 on #809: case-insensitive Bash vectors for BOTH the root config rule and its
// sibling example-template rule — the reviewer's exact reproduction list (redirect/mv-dest/
// cp-dest), all of which returned allow=true before the `i` flag was added to either regex.
const CONFIG_CASE_VARIANT_BLOCK: string[] = [
  "echo x > SAPWOOD.CONFIG.EXAMPLE.YAML",
  "mv /tmp/x Sapwood.Config.Example.Yaml",
  "cp /tmp/x sapwood.config.example.YAML",
  "echo x > SAPWOOD.CONFIG.YAML",
  "mv /tmp/x Sapwood.Config.Yaml",
  "cp /tmp/x sapwood.config.YAML",
];
for (const command of CONFIG_CASE_VARIANT_BLOCK) {
  test(`BLOCK (case-insensitive config, #809 gate② P1): ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, false, `should block: ${command}`);
    assert.ok(d.reason.toLowerCase().includes("write-path"));
  });
}

// Reverse: a case-variant NEAR-MISS (not the protected name) must still pass — the $-anchor
// holds under the new `i` flag too, not just under the original case-sensitive match.
test("ALLOW (case-insensitive near-miss): touch SAPWOOD.CONFIG.EXAMPLE2.YAML", () => {
  assert.equal(bash("touch SAPWOOD.CONFIG.EXAMPLE2.YAML").allow, true);
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
      child.on("close", (code) => resolve({ stdout, code })); // #578: 'close' (stdio drained), not 'exit'
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
