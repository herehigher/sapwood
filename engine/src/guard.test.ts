import assert from "node:assert/strict";
import { test } from "node:test";
import { guardDecision } from "./guard.js";
import { hookResponse, responseFromText } from "./guard-hook.js";

const CWD = "/repo";
const bash = (command: string, cwd = CWD) => guardDecision("Bash", { command }, cwd);

// ── BLOCK matrix (category C gh-overreach + opaque), ported from 0day test_guard.py,
// trading-domain (funds/keys) cases omitted; reason must name the keyword. ──────────
const BLOCK: [string, string, string][] = [
  // opaque shell/interpreter/process-sub wrappers (fail-closed, inner not parsed)
  ["bash -c \"echo hi\"", CWD, "opaque"],
  ["bash -lc \"ls -la\"", CWD, "opaque"],
  ["bash -e -c \"ls\"", CWD, "opaque"],
  ["sh -lc \"ls\"", CWD, "opaque"],
  ["bash -O extglob -c 'ls'", CWD, "opaque"],
  ["bash -o pipefail -c 'ls'", CWD, "opaque"],
  ["diff <(ls) <(ls -a)", CWD, "opaque"],
  ["gh pr view <(gh pr merge 143)", CWD, "opaque"],
  ["python -c \"print(1)\"", CWD, "opaque"],
  ["eval \"ls -la\"", CWD, "opaque"],
  ["node -e \"console.log(1)\"", CWD, "opaque"],
  ["env FOO=1 bash -c 'ls'", CWD, "opaque"],
  ["/bin/bash -c 'ls'", CWD, "opaque"],
  ["/usr/bin/python -c \"print(1)\"", CWD, "opaque"],
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
  ["cat foo > engine/src/guard.ts", CWD, "write-path"],
  ["echo x >> .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x >engine/src/guard-hook.ts", CWD, "write-path"],
  ["sed -i s/a/b/ .github/workflows/ci.yml", CWD, "write-path"],
  ["tee .claude/settings.json", CWD, "write-path"],
  ["cp /tmp/evil engine/src/reviewer.ts", CWD, "write-path"],
  ["dd if=/dev/zero of=.claude/settings.local.json", CWD, "write-path"],
  ["echo x > /repo/.github/workflows/deploy.yaml", CWD, "write-path"],
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
  "gh pr review 149 --approve", // GitHub forbids self-approval; matches 0day
  "gh api -X DELETE repos/o/r/git/refs/heads/feat-x",
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
];

for (const command of ALLOW) {
  test(`ALLOW: ${command}`, () => {
    const d = bash(command);
    assert.equal(d.allow, true, `should allow: ${command} (reason=${d.reason})`);
  });
}

test("non-Bash, non-Write tool is always allowed", () => {
  assert.equal(guardDecision("Read", { file_path: "/repo/anything" }, CWD).allow, true);
});

// ── Write-path protection (issue #9) ─────────────────────────────────────────
const WRITE_BLOCK: [string, string][] = [
  ["/repo/.claude/settings.json", "write-path"],
  [".claude/settings.json", "write-path"],
  [".claude/settings.local.json", "write-path"],
  [".github/workflows/ci.yml", "write-path"],
  ["/repo/.github/workflows/nested/deploy.yaml", "write-path"],
  ["engine/src/guard.ts", "write-path"],
  ["engine/src/guard-hook.ts", "write-path"],
  ["engine/src/reviewer.ts", "write-path"],
  ["../../repo/.claude/settings.json", "write-path"], // path traversal still resolves in
];
for (const [file_path, kw] of WRITE_BLOCK) {
  test(`WRITE BLOCK: ${file_path}`, () => {
    const d = guardDecision("Write", { file_path }, CWD);
    assert.equal(d.allow, false, `should block write: ${file_path}`);
    assert.ok(d.reason.toLowerCase().includes(kw));
  });
}

for (const file_path of ["src/app.ts", "README.md", "/repo/engine/src/forge.ts", ".github/ISSUE_TEMPLATE.md"]) {
  test(`WRITE ALLOW: ${file_path}`, () => {
    assert.equal(guardDecision("Edit", { file_path }, CWD).allow, true);
  });
}

// ── hook adapter: fail-closed ────────────────────────────────────────────────
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

test("hook: a write to a boundary file is denied through the hook", () => {
  const out = responseFromText(JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".github/workflows/ci.yml" }, cwd: CWD }));
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
});
