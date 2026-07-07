import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { guardDecision } from "./guard.js";
import { hookResponse, responseFromText, resolveGuardMode, applyGuardMode } from "./guard-hook.js";

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
  // round-2 P1 bypasses (Codex): env -S appended argv, wrapped path-prefixed gh,
  // shell grouping, &> redirections
  ["env -S gh pr merge 1", CWD, "merge"],
  ["env /usr/bin/gh pr merge 1", CWD, "merge"],
  ["uv run /usr/bin/gh pr merge 1", CWD, "merge"],
  ["(gh pr merge 1)", CWD, "merge"],
  ["{ gh pr merge 1; }", CWD, "merge"],
  ["( gh release create v1 )", CWD, "release"],
  ["echo x &> .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x &>> engine/src/guard.ts", CWD, "write-path"],
  ["echo x &>engine/src/guard-hook.ts", CWD, "write-path"],
  // round-3 P1 bypasses (Codex): open-ended uv value-flags, gh api --input POST, >& redirect
  ["uv run --with rich gh pr merge 1", CWD, "merge"],
  ["uv run --group dev gh release create v1", CWD, "release"],
  ["uv run --env-file .env gh pr ready 5", CWD, "ready"],
  ["gh api repos/o/r/releases --input body.json", CWD, "release"],
  ["gh api repos/o/r/pulls/1/merge --input x.json", CWD, "merge"],
  ["echo x >& .github/workflows/ci.yml", CWD, "write-path"],
  ["echo x >&engine/src/guard.ts", CWD, "write-path"],
  // round-4 P1 bypasses (Codex): >| split, workflows dir as dest, env -u before -S,
  // write command behind a uv boolean/value flag
  ["echo x >| .github/workflows/ci.yml", CWD, "write-path"],
  ["cp ci.yml .github/workflows", CWD, "write-path"],
  ["cp -t .github/workflows ci.yml", CWD, "write-path"],
  ["env -u FOO -S 'gh pr merge 1'", CWD, "merge"],
  ["uv run --all-extras tee .github/workflows/ci.yml", CWD, "write-path"],
  ["uv run --with rich tee engine/src/guard.ts", CWD, "write-path"],
  // round-5 P1 bypasses (Codex): versioned interpreter, rm/git rm, pr review approve
  ["python3.11 -c 'import os; os.system(\"x\")'", CWD, "opaque"],
  ["node20 -e 'x'", CWD, "opaque"],
  ["rm engine/src/guard.ts", CWD, "write-path"],
  ["rm -rf .github/workflows", CWD, "write-path"],
  ["git rm .github/workflows/ci.yml", CWD, "write-path"],
  ["mv engine/src/guard.ts /tmp/x", CWD, "write-path"],
  ["gh pr review 149 --approve", CWD, "review"],
  ["gh pr review 149 -a", CWD, "review"],
  // round-6 P1 bypasses (Codex): gh api -p/--preview value flag, pr review -r, git restore/checkout
  ["gh api -p corsair graphql -f query='mutation { x }'", CWD, "graphql"],
  ["gh api --preview corsair graphql --input body.json", CWD, "graphql"],
  ["gh pr review 149 -r -b nope", CWD, "review"],
  ["git restore --source HEAD^ -- engine/src/guard.ts", CWD, "write-path"],
  ["git checkout HEAD^ -- .github/workflows/ci.yml", CWD, "write-path"],
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
  "cp engine/src/guard.ts /tmp/readonly-copy.ts",
  // round-6 guardrails: benign git checkout/restore + gh api preview read
  "git checkout -b feature",
  "git checkout main",
  "git restore src/app.ts",
  "gh api -p corsair repos/o/r/pulls/1",
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
  ["sapwood.config.yaml", "write-path"], // engine/guard config -> a worker can't set guard.mode:soft (#26 R2)
  ["/repo/sapwood.config.yml", "write-path"],
  ["sapwood.config.json", "write-path"],
  ["/repo/engine/dist/guard-hook.js", "write-path"], // compiled hook artifact -> can't overwrite the live hook (#26 R3)
  ["engine/dist/guard.js", "write-path"],
  ["engine/src/merge-driver.ts", "write-path"], // merge path source (gates + TOCTOU pin) (#13 follow-up)
  ["/repo/engine/dist/merge-driver.js", "write-path"], // running merge-path artifact
  ["engine/dist/reviewer.js", "write-path"], // running gate② artifact
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
  // a non-guarded tool without input is still fine (allowed)
  assert.equal(hookResponse({ tool_name: "Read" }), null);
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
  const engineRoot = join(srcDir, "..");
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
    assert.ok(result.stdout.trim().length > 0, "hook must still emit a decision when invoked via a symlink — empty output means the guard silently no-op'd (fail-open)");
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("merge"));
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});
