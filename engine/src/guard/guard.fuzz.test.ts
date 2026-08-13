// Differential / fuzz test of guard.ts against guard.py (issue #8). The tokenizer
// divergence (TS shlex-equivalent vs Python shlex) is the real bypass surface, so we replay
// thousands of generated commands and assert the safety invariant:
//
//   on the SHARED decision surface — opaque constructs and Category C (gh overreach) —
//   sapwood must be AT LEAST as strict as guard.py. i.e. if guard.py BLOCKs with an
//   [opaque] or [类别C] reason, guard.ts must also BLOCK.
//
// We do NOT assert the reverse: sapwood is intentionally stricter (Bash write-path,
// `gh pr review --approve`, rm/git rm of boundary files) and omits guard.py's
// application-specific categories A/B, so those are filtered out.
//
// #840: guard.py used to be vendored in-repo (fixtures/guard_py_snapshot/) and run LIVE, every
// test run, as the oracle — a frozen reference implementation over a FIXED deterministic corpus
// produces constant verdicts, so that bought nothing but a standing CI Python dependency. Its
// verdicts were captured ONCE (scripts/regen-guard-shared-block-fixture.ts) into the static table
// below (fixtures/guard-shared-block-verdicts.ts); this file now asserts guard.ts against that
// table with NO interpreter involved. The corpus generator (fixtures/fuzz-corpus.ts) is unchanged
// and still runs live — only the oracle side became static.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateFuzzCorpus, HAND_PICKED_SHARED_BLOCK_CASES } from "./fixtures/fuzz-corpus.js";
import { GUARD_PY_SHARED_BLOCK_VERDICTS } from "./fixtures/guard-shared-block-verdicts.js";
import { guardDecision } from "./guard.js";

const CWD = "/repo";

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

// #840 (obsoletes #427's in-repo-fixture test, which asserted the now-deleted vendored guard.py
// snapshot shipped): assert the STATIC fixture this suite depends on is actually present and
// non-trivial, so an accidentally emptied/deleted table fails loudly here instead of the
// differential test below silently passing on zero comparisons.
test("#840: static guard.py shared-block verdict table is present and non-trivial", () => {
  const size = Object.keys(GUARD_PY_SHARED_BLOCK_VERDICTS).length;
  assert.ok(size > 100, `expected a substantial captured fixture, got ${size} entries`);
});

// #842 gate② required fix: the live oracle judged whatever the corpus produced, so a
// fuzz-corpus.ts edit could never silently shrink coverage. The static table breaks that
// unless something binds corpus<->table going forward: a future seed/PREFIXES/CORE/SUFFIXES
// edit that shifts generated commands off the table's keys makes GUARD_PY_SHARED_BLOCK_VERDICTS[command]
// miss silently (the loop below just `continue`s), decaying real coverage toward zero while every
// test stays green. This tripwire is exact BY CONSTRUCTION — the table was captured from exactly
// this union (fixtures/guard-shared-block-verdicts.ts's header) — so it passes today; it exists to
// fail loudly the day the corpus and the fixture drift apart.
test("#840 tripwire: every captured shared-block key is still produced by the current corpus", () => {
  const liveCommands = new Set([...generateFuzzCorpus(), ...HAND_PICKED_SHARED_BLOCK_CASES]);
  const staleKeys = Object.keys(GUARD_PY_SHARED_BLOCK_VERDICTS).filter((command) => !liveCommands.has(command));
  assert.deepEqual(
    staleKeys,
    [],
    `${staleKeys.length} captured fixture key(s) are no longer produced by fixtures/fuzz-corpus.ts — ` +
      `corpus drifted from the captured fixture; regenerate via engine/scripts/regen-guard-shared-block-fixture.ts:\n` +
      staleKeys.slice(0, 10).join("\n"),
  );
});

test("differential: sapwood is at least as strict as guard.py on opaque + Category C (static fixture)", () => {
  // Regenerate the exact same deterministic corpus the fixture was captured from (see
  // fixtures/fuzz-corpus.ts + scripts/regen-guard-shared-block-fixture.ts). No python3/python
  // involved: guard.py's verdicts are the static GUARD_PY_SHARED_BLOCK_VERDICTS table.
  const commands = generateFuzzCorpus();

  const divergences: string[] = [];
  for (const command of commands) {
    const reason = GUARD_PY_SHARED_BLOCK_VERDICTS[command];
    if (reason === undefined) continue; // guard.py did not shared-block this command
    const ts = guardDecision("Bash", { command }, CWD);
    if (ts.allow) divergences.push(`guard.py BLOCKED but guard.ts ALLOWED: ${JSON.stringify(command)} (py: ${reason})`);
  }
  assert.deepEqual(
    divergences,
    [],
    `sapwood weaker than guard.py on ${divergences.length} input(s):\n${divergences.slice(0, 10).join("\n")}`,
  );
});

test("differential: hand-picked shared-surface BLOCK cases all block in guard.ts", () => {
  // The exact opaque + Category C commands from guard.py's authoritative bypass
  // matrix (folded into the static fixture alongside the generated corpus — see fuzz-corpus.ts).
  for (const command of HAND_PICKED_SHARED_BLOCK_CASES) {
    assert.ok(command in GUARD_PY_SHARED_BLOCK_VERDICTS, `expected a captured shared-block verdict for hand-picked case: ${command}`);
    assert.equal(guardDecision("Bash", { command }, CWD).allow, false, `guard.ts must block: ${command}`);
  }
});
