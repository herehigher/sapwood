// Differential / fuzz test of guard.ts against 0day's guard.py (issue #8). The tokenizer
// divergence (TS shlex-equivalent vs Python shlex) is the real bypass surface, so we run
// thousands of generated commands through BOTH and assert the safety invariant:
//
//   on the SHARED decision surface — opaque constructs and Category C (gh overreach) —
//   sapwood must be AT LEAST as strict as guard.py. i.e. if guard.py BLOCKs with an
//   [opaque] or [类别C] reason, guard.ts must also BLOCK.
//
// We do NOT assert the reverse: sapwood is intentionally stricter (Bash write-path,
// `gh pr review --approve`, rm/git rm of boundary files) and omits guard.py's
// trading-domain categories A (funds) / B (private keys), so those are filtered out.
//
// Skips cleanly when python3 or the sibling 0day checkout is unavailable (e.g. CI without
// 0day), so this never blocks the suite — it hardens locally and wherever both are present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { guardDecision } from "./guard.js";

const CWD = "/repo";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZERODAY_SRC = resolve(repoRoot, "..", "0day", "backend", "src");
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
  "", "", "env FOO=1 ", "env -u BAR ", "uv run ", "uv run --with rich ", "uv run --all-extras ",
  "command ", "nohup ", "/usr/bin/", "stdbuf -oL ", "poetry run ", "npx ", "( ", "{ ",
];
const CORE = [
  "gh pr merge 1", "gh pr merge 1 --squash", "gh pr ready 2", "gh release create v1",
  "gh -R o/r pr merge 3", "gh api -X PUT repos/o/r/pulls/1/merge", "gh api repos/o/r/releases -f t=v",
  "gh api graphql -f query='mutation { mergePullRequest }'", "gh api --hostname H graphql -f query='mutation{x}'",
  "gh pr view 1 --json state", "gh api repos/o/r/pulls/1", "gh pr list", "gh api graphql -f query='query{viewer{login}}'",
  "bash -c 'ls'", "bash -lc 'echo hi'", "sh -c 'ls'", "python -c 'print(1)'", "node -e 'x'", "eval 'ls'",
  "diff <(ls) <(ls -a)", "ls -la", "git status", "echo hello", "cat README.md", "grep foo bar.txt", "pytest -q",
];
const SUFFIXES = ["", "", "", " > out.txt", " >> log", " 2>&1", " | cat", " && ls", " ; echo done"];

function genCommand(rng: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rng() * a.length)]!;
  let cmd = pick(PREFIXES) + pick(CORE) + pick(SUFFIXES);
  if (rng() < 0.25) cmd = cmd + " " + pick(["&&", ";", "|"]) + " " + pick(CORE);
  return cmd;
}

test("differential: sapwood is at least as strict as guard.py on opaque + Category C", (t) => {
  const bin = pythonAvailable();
  if (!bin || !existsSync(GUARD_PY)) {
    t.skip(`differential test needs python + 0day guard.py (looked at ${GUARD_PY})`);
    return;
  }

  const rng = makeRng(0xC0FFEE);
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
  assert.deepEqual(divergences, [], `sapwood weaker than guard.py on ${divergences.length} input(s):\n${divergences.slice(0, 10).join("\n")}`);
});

test("differential: 0day's shared-surface BLOCK cases all block in guard.ts", (t) => {
  const bin = pythonAvailable();
  if (!bin || !existsSync(GUARD_PY)) {
    t.skip("needs python + 0day guard.py");
    return;
  }
  // The exact opaque + Category C commands from 0day's authoritative bypass matrix.
  const cases = [
    'bash -c "python transfer.py"', "gh pr merge 143 --squash", "gh pr ready 143", "gh release create v1 -t x",
    "gh api -X PUT repos/o/r/pulls/143/merge", "gh -R o/r pr merge 143 --squash", "gh --repo o/r pr ready 5",
    "gh api repos/o/r/releases --raw-field tag_name=v1", "gh api --method=PUT repos/o/r/pulls/143/merge",
    "gh api -XPUT repos/o/r/pulls/143/merge", "bash -lc 'x'", "bash -o pipefail -c 'ls'", "diff <(ls) <(ls -a)",
    "python -c 'print(1)'", "eval 'ls -la'", "node -e 'x'", "/bin/bash -c 'ls'", "command bash -c 'ls'",
    "gh api graphql -f query='mutation { mergePullRequest }'", "/usr/bin/gh pr merge 143", "command -p bash -c 'ls'",
  ];
  const py = runGuardPy(bin, cases);
  for (let i = 0; i < cases.length; i++) {
    if (!isSharedBlock(py[i]!)) continue;
    assert.equal(guardDecision("Bash", { command: cases[i]! }, CWD).allow, false, `guard.ts must block: ${cases[i]}`);
  }
});
