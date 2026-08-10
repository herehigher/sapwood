// Differential / fuzz test of guard.ts against the predecessor project's guard.py (issue #8). The tokenizer
// divergence (TS shlex-equivalent vs Python shlex) is the real bypass surface, so we run
// thousands of generated commands through BOTH and assert the safety invariant:
//
//   on the SHARED decision surface — opaque constructs and Category C (gh overreach) —
//   sapwood must be AT LEAST as strict as guard.py. i.e. if guard.py BLOCKs with an
//   [opaque] or [类别C] reason, guard.ts must also BLOCK.
//
// We do NOT assert the reverse: sapwood is intentionally stricter (Bash write-path,
// `gh pr review --approve`, rm/git rm of boundary files) and omits guard.py's
// application-specific categories A/B, so those are filtered out.
//
// guard.py is vendored as a frozen fixture (fixtures/guard_py_snapshot/), so the only remaining
// skip condition is a missing python3/python interpreter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { guardDecision } from "./guard.js";

const CWD = "/repo";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Vendored, frozen snapshot of the predecessor project's guard.py (provenance: fixtures/guard_py_snapshot/SOURCE.md).
// It ships in-repo so the differential tests run in CI and in a worker's ephemeral worktree,
// neither of which has a sibling predecessor checkout (#427). SAPWOOD_ZERODAY_SRC overrides it for
// ad-hoc local comparison against a newer guard.py, e.g.
// SAPWOOD_ZERODAY_SRC=/path/to/predecessor/backend/src npm --workspace engine test.
const VENDORED_SRC = resolve(repoRoot, "engine", "src", "guard", "fixtures", "guard_py_snapshot");
const ZERODAY_SRC = process.env.SAPWOOD_ZERODAY_SRC ? resolve(process.env.SAPWOOD_ZERODAY_SRC) : VENDORED_SRC;
const GUARD_PY = join(ZERODAY_SRC, "zeroday", "loop", "guard.py");

function pythonAvailable(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const PY_DRIVER = `
import sys, json
from zeroday.loop.guard import guard_decision
data = json.load(sys.stdin)
out = [{"allow": (d := guard_decision("Bash", x["command"], x.get("cwd", "/repo"), {})).allow, "reason": d.reason} for x in data]
sys.stdout.write(json.dumps(out))
`;

interface PyDecision {
  allow: boolean;
  reason: string;
}

function runGuardPy(bin: string, commands: string[]): PyDecision[] {
  const input = JSON.stringify(commands.map((command) => ({ command, cwd: CWD })));
  const out = execFileSync(bin, ["-c", PY_DRIVER], {
    input,
    env: { ...process.env, PYTHONPATH: ZERODAY_SRC },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(out) as PyDecision[];
}

// A guard.py BLOCK reason on the surface sapwood also implements.
function isSharedBlock(d: PyDecision): boolean {
  return !d.allow && (/opaque/i.test(d.reason) || d.reason.includes("类别C"));
}

// ── deterministic command generator (seeded; exercises the tokenizer + categories) ──
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PREFIXES = [
  "",
  "",
  "env FOO=1 ",
  "env -u BAR ",
  "uv run ",
  "uv run --with rich ",
  "uv run --all-extras ",
  "command ",
  "nohup ",
  "/usr/bin/",
  "stdbuf -oL ",
  "poetry run ",
  "npx ",
  "( ",
  "{ ",
];
const CORE = [
  "gh pr merge 1",
  "gh pr merge 1 --squash",
  "gh pr ready 2",
  "gh pr -R o/r merge 5",
  "gh pr --repo o/r ready 5",
  "gh pr -R o/r review 5 --approve",
  "gh release create v1",
  "gh -R o/r pr merge 3",
  "gh api -X PUT repos/o/r/pulls/1/merge",
  "gh api repos/o/r/releases -f t=v",
  "gh api graphql -f query='mutation { mergePullRequest }'",
  "gh api --hostname H graphql -f query='mutation{x}'",
  "gh issue edit 1 --add-label hold",
  "gh issue edit 1 --remove-label=ready --milestone M11",
  "gh -R o/r issue edit 1 --milestone=M11",
  "gh issue edit 1 -m M11",
  "gh issue edit 1 -m=M11",
  "gh issue edit 1 -mM11",
  "gh issue edit 1 --remove-milestone",
  "gh issue edit 1 --add-project=Board",
  "gh issue edit 1 --remove-project Board",
  "gh issue edit 1 --add-sub-issue 5",
  "gh issue edit 1 --remove-sub-issue=5",
  "gh issue edit 1 --remove-parent",
  "gh issue edit 1 --parent=3",
  "gh issue -R o/r edit 1 --add-label hold",
  "gh issue --repo o/r edit 1 -m M11",
  "gh label delete hold",
  "gh project item-edit --id item",
  "gh api -X POST repos/o/r/issues/1/labels -f labels=hold",
  "gh api -X DELETE repos/o/r/labels/hold",
  "gh api -X PATCH repos/o/r/issues/1 -f milestone=11",
  "gh api -X POST repos/o/r/issues/1/sub_issues -F sub_issue_id=2",
  "gh api -X DELETE repos/o/r/issues/1/sub_issue",
  "gh api -X PATCH repos/o/r/issues/1/sub_issues/priority -F sub_issue_id=2",
  "gh api -X PATCH repos/o/r/milestones/17 -f title=M12",
  "gh api -X POST repos/o/r/milestones -f title=M12",
  "gh api -X POST repos/o/r/issues/1/sub%5Fissues -F sub_issue_id=2",
  "gh api -X PATCH repos/o/r/%6Dilestones/17 -f title=M12",
  "gh api -X PATCH repos/o/r/issues/%31 -f milestone=11",
  "gh api -X PATCH repos/o/r/issues/%zz",
  "gh api -X POST repos/o/r/issues/%31/%63omments -f body=progress",
  "gh api -X PUT repos/o/r/pulls/1/%6Derge",
  "gh api -X POST repos/o/r/%72eleases -f tag_name=v1",
  "gh api -X DELETE repos/o/r/git/%72efs/heads/feat-x",
  "uv run --with rich gh label delete hold",
  "gh pr view 1 --json state",
  "gh api repos/o/r/pulls/1",
  "gh pr list",
  "gh issue edit 1 --title safe --body updated",
  "gh issue edit 1 -t 'safe title'",
  "gh issue edit 1 -b updated",
  "gh issue edit 1 -F body.md",
  "gh issue edit 1 --add-assignee octocat",
  "gh issue edit 1 --remove-assignee octocat",
  "gh issue edit 1 --add-blocked-by 7",
  "gh issue comment 1 --body progress",
  "gh pr comment 1 --body progress",
  "gh api -X POST repos/o/r/issues/1/comments -f body=progress",
  "gh api graphql -f query='query{viewer{login}}'",
  "bash -c 'ls'",
  "bash -lc 'echo hi'",
  "sh -c 'ls'",
  "python -c 'print(1)'",
  "node -e 'x'",
  "eval 'ls'",
  "diff <(ls) <(ls -a)",
  "ls -la",
  "git status",
  "echo hello",
  "cat README.md",
  "grep foo bar.txt",
  "pytest -q",
];
const SUFFIXES = ["", "", "", " > out.txt", " >> log", " 2>&1", " | cat", " && ls", " ; echo done"];

function genCommand(rng: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rng() * a.length)]!;
  let cmd = pick(PREFIXES) + pick(CORE) + pick(SUFFIXES);
  if (rng() < 0.25) cmd = cmd + " " + pick(["&&", ";", "|"]) + " " + pick(CORE);
  return cmd;
}

test("#352 corpus: governance mutations block even when wrapper-embedded; comments pass", () => {
  const blocked = [
    "gh issue edit 1 --add-label hold",
    "gh -R o/r issue edit 1 --remove-label=ready --milestone M11",
    "gh issue edit 1 -m M11",
    "gh issue edit 1 -m=M11",
    "gh issue edit 1 -mM11",
    "gh issue edit 1 --remove-milestone",
    "gh issue edit 1 --add-project=Board",
    "gh issue edit 1 --remove-project Board",
    "gh issue edit 1 --add-sub-issue 5",
    "gh issue edit 1 --remove-sub-issue=5",
    "gh issue edit 1 --remove-parent",
    "gh issue edit 1 --parent=3",
    "gh pr -R o/r merge 5",
    "gh pr --repo o/r ready 5",
    "gh pr -R o/r review 5 --approve",
    "gh issue -R o/r edit 1 --add-label hold",
    "gh issue --repo o/r edit 1 -m M11",
    "uv run --with rich gh issue --repo o/r edit 1 --remove-parent",
    "uv run --with rich gh issue edit 1 --add-sub-issue 5",
    "uv run --with rich gh label delete hold",
    "poetry run gh project item-edit --id item",
    "npx gh api -X POST repos/o/r/issues/1/labels -f labels=hold",
    "stdbuf -oL gh api -X DELETE repos/o/r/labels/hold",
    "env FOO=1 gh api -X PATCH repos/o/r/issues/1 -f milestone=11",
    "gh api -X POST repos/o/r/issues/1/sub_issues -F sub_issue_id=2",
    "gh api -X PUT repos/o/r/issues/1/sub_issues -F sub_issue_id=2",
    "gh api -X DELETE repos/o/r/issues/1/sub_issue",
    "gh api -X PATCH repos/o/r/issues/1/sub_issues/priority -F sub_issue_id=2",
    "gh api -X POST https://api.github.com/repos/o/r/issues/1/sub_issues -F sub_issue_id=2",
    "gh api -X DELETE 'repos/o/r/issues/1/sub_issue?sub_issue_id=2'",
    "uv run --with rich gh api -X PATCH repos/o/r/issues/1/sub_issues/priority -F sub_issue_id=2",
    "gh api -X PATCH repos/o/r/milestones/17 -f title=M12",
    "gh api --method=post repos/o/r/milestones -f title=M12",
    "gh api -X delete https://api.github.com/repos/o/r/milestones/17",
    "gh api -X pUt 'repos/o/r/milestones/17?state=closed' -f title=M12",
    "gh api -X POST repos/o/r/issues/1/sub%5Fissues -F sub_issue_id=2",
    "gh api -X PATCH repos/o/r/%6Dilestones/17 -f title=M12",
    "gh api -X PATCH repos/o/r/issues/%31 -f milestone=11",
    "uv run --with rich gh api -X POST repos/o/r/issues/1/sub%5Fissues -F sub_issue_id=2",
    "gh api -X PATCH https://api.github.com/repos/o/r/%6Dilestones/17?state=open -f title=M12",
    "gh api -X PATCH safe/path -f probe=/repos/o/r/%6Dilestones/17",
    "gh api -X PUT repos/o/r/pulls/1/%6Derge",
    "gh api -X POST repos/o/r/%72eleases -f tag_name=v1",
    "gh api -X PATCH repos/o/r/issues/%zz",
    "gh api -X PATCH repos/o/r/issues/%5",
  ];
  for (const command of blocked) {
    assert.equal(guardDecision("Bash", { command }, CWD).allow, false, `must block: ${command}`);
  }

  const allowed = [
    "gh issue edit 1 --title safe --body updated",
    "gh issue edit 1 -t 'safe title'",
    "gh issue edit 1 -b updated",
    "gh issue edit 1 -F body.md",
    "gh issue edit 1 --add-assignee octocat",
    "gh issue edit 1 --remove-assignee octocat",
    "gh issue edit 1 --add-blocked-by 7",
    "gh issue comment 1 --body progress",
    "gh pr comment 1 --body progress",
    "gh api -X POST repos/o/r/issues/1/comments -f body=progress",
    "gh api -X POST repos/o/r/issues/%31/%63omments -f body=progress",
    "gh api -X DELETE repos/o/r/git/%72efs/heads/feat-x",
    'gh api repos/o/r/issues -f "title=90% done"',
    'gh api -X POST repos/o/r/issues/1/comments -f "body=progress 90% complete"',
    'gh api graphql -f "query=query { viewer { login } }" -f "q=90% done"',
    'gh api repos/o/r/issues -f "title=progress%"',
    'gh api -X POST repos/o/r/issues/1/comments -f "body=progress % complete"',
    'gh api repos/o/r/issues -f "title=progress%zzdone"',
  ];
  for (const command of allowed) {
    assert.equal(guardDecision("Bash", { command }, CWD).allow, true, `must allow: ${command}`);
  }
});

test("#353 corpus: issue lifecycle verbs (close/reopen/transfer/delete) block even when wrapper-embedded; comment/view/list/create pass", () => {
  const blocked = [
    "gh issue close 1",
    "gh issue reopen 1",
    "gh issue transfer 1 o/r2",
    "gh issue delete 1 --yes",
    "gh issue -R o/r close 1",
    "gh -R o/r issue reopen 1",
    "gh issue --repo o/r transfer 1 o/r2",
    "uv run --with rich gh issue delete 1",
    "env FOO=1 gh issue close 1",
    // REST/graphql equivalents — already blocked by #352's mutation checks.
    "gh api -X PATCH repos/o/r/issues/1 -f state=closed",
    "gh api -X PATCH repos/o/r/issues/1 -f state=open",
    'gh api graphql -f query=\'mutation { transferIssue(input: {issueId: "1", newOwner: "o2"}) { issue { id } } }\'',
    "gh api graphql -f query='mutation { deleteIssue(input: {issueId: \"1\"}) { clientMutationId } }'",
  ];
  for (const command of blocked) {
    assert.equal(guardDecision("Bash", { command }, CWD).allow, false, `must block: ${command}`);
  }

  const allowed = [
    "gh issue comment 1 --body progress",
    "gh issue view 1",
    "gh issue list",
    "gh issue status",
    "gh issue create --title x --body y",
  ];
  for (const command of allowed) {
    assert.equal(guardDecision("Bash", { command }, CWD).allow, true, `must allow: ${command}`);
  }
});

// #427: the two differential tests below used to skip whenever a sibling predecessor checkout was
// absent — i.e. in CI and in every dogfood worker's worktree, so the safety-parity guarantee
// docs/PLAN.md documents for M1 never actually ran there. Guard the fixture itself so a moved
// or dropped snapshot fails loudly instead of silently reverting them to a permanent skip.
test("#427: the guard.py reference implementation ships in-repo (no sibling checkout needed)", () => {
  // The vendored fixture must be complete regardless; only the DEFAULT-resolution claim is
  // conditional, since an ad-hoc SAPWOOD_ZERODAY_SRC run deliberately points elsewhere.
  if (!process.env.SAPWOOD_ZERODAY_SRC) {
    assert.equal(ZERODAY_SRC, VENDORED_SRC, "GUARD_PY resolves to the vendored fixture by default");
  }
  assert.ok(existsSync(GUARD_PY), `guard.py reference implementation missing: ${GUARD_PY}`);
  assert.ok(existsSync(join(VENDORED_SRC, "SOURCE.md")), "fixture records its source commit");
  // The package shape PY_DRIVER's `from zeroday.loop.guard import guard_decision` needs.
  for (const p of [
    ["zeroday", "__init__.py"],
    ["zeroday", "loop", "__init__.py"],
  ]) {
    assert.ok(existsSync(join(VENDORED_SRC, ...p)), `importable package missing: ${p.join("/")}`);
  }
});

test("differential: sapwood is at least as strict as guard.py on opaque + Category C", (t) => {
  const bin = pythonAvailable();
  if (!bin) {
    t.skip("differential test needs a python3/python interpreter");
    return;
  }

  const rng = makeRng(0xc0ffee);
  const commands = Array.from({ length: 1500 }, () => genCommand(rng));
  const pyDecisions = runGuardPy(bin, commands);
  assert.equal(pyDecisions.length, commands.length, "guard.py returned a decision per command");

  const divergences: string[] = [];
  for (let i = 0; i < commands.length; i++) {
    const py = pyDecisions[i]!;
    if (!isSharedBlock(py)) continue; // only the shared surface guard.py blocks
    const ts = guardDecision("Bash", { command: commands[i]! }, CWD);
    if (ts.allow) divergences.push(`guard.py BLOCKED but guard.ts ALLOWED: ${JSON.stringify(commands[i])} (py: ${py.reason})`);
  }
  assert.deepEqual(
    divergences,
    [],
    `sapwood weaker than guard.py on ${divergences.length} input(s):\n${divergences.slice(0, 10).join("\n")}`,
  );
});

test("differential: predecessor-project shared-surface BLOCK cases all block in guard.ts", (t) => {
  const bin = pythonAvailable();
  if (!bin) {
    t.skip("needs a python3/python interpreter");
    return;
  }
  // The exact opaque + Category C commands from the predecessor project's authoritative bypass matrix.
  const cases = [
    'bash -c "python transfer.py"',
    "gh pr merge 143 --squash",
    "gh pr ready 143",
    "gh release create v1 -t x",
    "gh api -X PUT repos/o/r/pulls/143/merge",
    "gh -R o/r pr merge 143 --squash",
    "gh --repo o/r pr ready 5",
    "gh api repos/o/r/releases --raw-field tag_name=v1",
    "gh api --method=PUT repos/o/r/pulls/143/merge",
    "gh api -XPUT repos/o/r/pulls/143/merge",
    "bash -lc 'x'",
    "bash -o pipefail -c 'ls'",
    "diff <(ls) <(ls -a)",
    "python -c 'print(1)'",
    "eval 'ls -la'",
    "node -e 'x'",
    "/bin/bash -c 'ls'",
    "command bash -c 'ls'",
    "gh api graphql -f query='mutation { mergePullRequest }'",
    "/usr/bin/gh pr merge 143",
    "command -p bash -c 'ls'",
  ];
  const py = runGuardPy(bin, cases);
  for (let i = 0; i < cases.length; i++) {
    // These are hand-picked opaque / Category C cases — assert guard.py actually
    // shared-blocks each one (so a drift in its reason format / our filter fails loudly
    // instead of silently skipping the comparison), THEN assert guard.ts blocks too.
    assert.ok(isSharedBlock(py[i]!), `guard.py should shared-block (opaque/类别C): ${cases[i]} (got: ${JSON.stringify(py[i])})`);
    assert.equal(guardDecision("Bash", { command: cases[i]! }, CWD).allow, false, `guard.ts must block: ${cases[i]}`);
  }
});
