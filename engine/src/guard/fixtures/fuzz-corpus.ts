// Deterministic command corpus for guard.fuzz.test.ts's differential test (#840).
//
// This module is the SINGLE SOURCE for the corpus: both the test (which asserts guard.ts
// against the static shared-block fixture in ./guard-shared-block-verdicts.ts) and
// scripts/regen-guard-shared-block-fixture.ts (which produced that fixture from a one-time
// guard.py run) import `generateFuzzCorpus`/`HAND_PICKED_SHARED_BLOCK_CASES` from here, so the
// corpus a human re-derives the fixture from is byte-identical to the corpus the test replays.
//
// Fixed-seed LCG (`makeRng(0xc0ffee)`) × 1500 commands, combining 15 prefixes × 74 cores × 9
// suffixes with a 25% command-chaining wrapper — the non-redundant payload guard.test.ts's hand
// matrix does not replicate (see guard.fuzz.test.ts's header). Pure TS, deterministic: calling
// `generateFuzzCorpus()` twice yields the same 1500-element array every time, on any machine.

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export const PREFIXES = [
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

export const CORE = [
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

export const SUFFIXES = ["", "", "", " > out.txt", " >> log", " 2>&1", " | cat", " && ls", " ; echo done"];

export function genCommand(rng: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rng() * a.length)]!;
  let cmd = pick(PREFIXES) + pick(CORE) + pick(SUFFIXES);
  if (rng() < 0.25) cmd = cmd + " " + pick(["&&", ";", "|"]) + " " + pick(CORE);
  return cmd;
}

/** The exact 1500-command deterministic corpus (seed 0xc0ffee) — byte-identical every call. */
export function generateFuzzCorpus(): string[] {
  const rng = makeRng(0xc0ffee);
  return Array.from({ length: 1500 }, () => genCommand(rng));
}

/**
 * Hand-picked opaque / Category C cases from the predecessor project's authoritative bypass
 * matrix (originally test 5 in guard.fuzz.test.ts, pre-#840). Not RNG-generated; curated to
 * exercise specific wrapper/casing/method-override shapes. Folded into the same static
 * shared-block fixture as the generated corpus.
 */
export const HAND_PICKED_SHARED_BLOCK_CASES = [
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
