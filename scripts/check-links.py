#!/usr/bin/env python3
"""sapwood pre-publish dead-link checker (#340).

Invocation (from the repository root):

    python3 scripts/check-links.py

Optionally check a different checkout (e.g. a worktree or an older commit's
tree) by passing its path:

    python3 scripts/check-links.py /path/to/other/checkout

Pass `--internal-only` to skip the external-link section entirely (no
network, no `gh` call) and check only relative links/anchors. This is the
mode wired into CI, where a `gh`-authenticated, networked check would be
flaky and would gate merges on outside URLs sapwood does not control:

    python3 scripts/check-links.py --internal-only

Stdlib only -- no new dependency, nothing to `npm install`.

Scope: README.md + docs/ entry pages -- every top-level `docs/*.md`, plus
`docs/dev-guide/README.md` -- and everything those pages link to, followed
transitively over relative Markdown links. This is the set #340's
acceptance criteria call "README + docs entry pages."

What it checks:
  - Every relative Markdown link (`[text](path)` or `[text](path#anchor)`)
    resolves to a file that exists.
  - Every `#anchor` (same-file or cross-file) resolves to a real heading in
    the target file, using GitHub's own heading-slug algorithm: lowercase,
    strip Markdown emphasis/code markers, drop every character that is not
    a Unicode letter/mark/decimal-digit/hyphen/space (this deliberately
    excludes Python's `\\w`, which over-keeps symbol categories like circled
    digits that GitHub's slugger does not), map each remaining literal
    space to its own hyphen (an em dash sitting between two spaces produces
    a double hyphen, because the dash itself is dropped but both spaces
    survive -- GitHub does not collapse runs), and de-duplicate repeated
    slugs the way GitHub does: the second `## Foo` on a page gets `#foo-1`,
    the third `#foo-2`, and so on.
  - Every `https://github.com/herehigher/sapwood/issues/N` or `/pull/N`
    link is checked with `gh api` rather than a raw HTTP request: this repo
    is currently **private**, so an unauthenticated HTTP probe 404s on
    every such URL regardless of whether the issue/PR actually exists.
    Other `github.com/herehigher/sapwood/...` links (workflow badges, the
    private-vulnerability-reporting URL, etc.) can't be probed the same way
    and are reported as `UNVERIFIED-PRIVATE` rather than silently passed.
  - Every other `http(s)` external link gets a best-effort HEAD (falling
    back to GET on 403/405) request.

Exit code: non-zero iff at least one internal link/anchor problem was
found. External-link results are informational (network- and
private-repo-dependent) and never affect the exit code.
"""
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request

REPO = "herehigher/sapwood"

LINK_RE = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')


def slugify(text):
    """Reproduce GitHub's heading-slug algorithm (github-slugger behavior)."""
    text = re.sub(r'[`*_]', '', text)  # strip inline code/emphasis markers
    text = text.lower()
    kept = []
    for ch in text:
        if ch == ' ' or ch == '-':
            kept.append(ch)
        else:
            cat = unicodedata.category(ch)
            # Keep letters (L*), combining marks (M*), and decimal digits
            # (Nd) only -- NOT Python's \w, which also keeps Unicode
            # category No/Nl (e.g. circled digits like the gate marks used
            # in this repo's own headings) that GitHub's slugger strips.
            if cat[0] == 'L' or cat[0] == 'M' or cat == 'Nd':
                kept.append(ch)
    text = ''.join(kept).strip()
    # Map each literal space to its own hyphen -- do NOT collapse runs, so
    # "table — reading" (em dash between two spaces, dash itself dropped
    # above) yields "table--reading", matching GitHub exactly.
    return text.replace(' ', '-')


def headings_of(path):
    """Return {slug: True} for every heading in a Markdown file, with
    GitHub-style duplicate-slug suffixing (-1, -2, ...)."""
    slugs = {}
    try:
        with open(path, encoding='utf-8') as f:
            content = f.read()
    except (FileNotFoundError, UnicodeDecodeError):
        return slugs
    for line in content.splitlines():
        m = re.match(r'^(#{1,6})\s+(.*)$', line)
        if not m:
            continue
        base = slugify(m.group(2))
        slug = base
        i = 1
        while slug in slugs:
            slug = f"{base}-{i}"
            i += 1
        slugs[slug] = True
    return slugs


def collect_scope(root):
    """Seed on README + top-level docs entry pages, then follow relative
    .md links transitively."""
    seeds = [
        "README.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "docs/PLAN.md",
        "docs/getting-started.md",
        "docs/configuration.md",
        "docs/security.md",
        "docs/role-paradigm.md",
        "docs/troubleshooting.md",
        "docs/supervision.md",
        "docs/dev-guide/README.md",
    ]
    scope = set()
    queue = [f for f in seeds if os.path.exists(os.path.join(root, f))]
    while queue:
        rel = queue.pop()
        if rel in scope:
            continue
        scope.add(rel)
        full = os.path.join(root, rel)
        if not os.path.exists(full):
            continue
        with open(full, encoding='utf-8') as f:
            content = f.read()
        for _, target in LINK_RE.findall(content):
            target = target.split(' ')[0].strip('<>')
            if target.startswith(('http://', 'https://', 'mailto:', '#')):
                continue
            path_part = target.split('#')[0]
            if not path_part:
                continue
            newpath = os.path.normpath(os.path.join(os.path.dirname(rel), path_part))
            if newpath.endswith('.md') and os.path.exists(os.path.join(root, newpath)) and newpath not in scope:
                queue.append(newpath)
    return scope


def check_file(root, rel, results, external_links):
    full = os.path.join(root, rel)
    with open(full, encoding='utf-8') as f:
        content = f.read()
    for _, target in LINK_RE.findall(content):
        raw_target = target
        target = target.split(' ')[0].strip('<>')
        if not target:
            continue
        if target.startswith(('http://', 'https://')):
            external_links.setdefault(target, []).append(rel)
            continue
        if target.startswith('mailto:'):
            continue
        if target.startswith('#'):
            anchor = target[1:]
            if anchor and anchor not in headings_of(full):
                results.append((rel, raw_target, 'BROKEN ANCHOR (same-file)', f'no heading slug "{anchor}" in {rel}'))
            continue
        path_part, _, anchor = target.partition('#')
        newpath = os.path.normpath(os.path.join(os.path.dirname(rel), path_part))
        newfull = os.path.join(root, newpath)
        if not os.path.exists(newfull):
            results.append((rel, raw_target, 'BROKEN LINK', f'target does not exist: {newpath}'))
            continue
        if anchor and newpath.endswith('.md') and anchor not in headings_of(newfull):
            results.append((rel, raw_target, 'BROKEN ANCHOR', f'no heading slug "{anchor}" in {newpath}'))


def check_external(external_links):
    ok, fail, unverified = 0, 0, 0
    for url in sorted(external_links):
        srcs = ', '.join(sorted(set(external_links[url])))
        m = re.match(rf'https://github\.com/{re.escape(REPO)}/(issues|pull)/(\d+)', url)
        if m:
            kind = 'issues' if m.group(1) == 'issues' else 'pulls'
            r = subprocess.run(
                ['gh', 'api', f'repos/{REPO}/{kind}/{m.group(2)}', '--jq', '.state'],
                capture_output=True, text=True)
            if r.returncode == 0:
                ok += 1
                print(f"  [OK (gh api: {r.stdout.strip()})] {url}  (linked from: {srcs})")
            else:
                fail += 1
                print(f"  [ERROR (gh api: {r.stderr.strip()})] {url}  (linked from: {srcs})")
            continue
        if url.startswith(f'https://github.com/{REPO}/'):
            # Repo-relative link that isn't an issue/PR (workflow badge,
            # advisories-new form, etc.) -- while the repo is private, an
            # unauthenticated probe 404s regardless of validity, so this is
            # reported rather than silently assumed OK.
            unverified += 1
            print(f"  [UNVERIFIED-PRIVATE] {url}  (linked from: {srcs})")
            continue
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'sapwood-check-links/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                status = 'OK' if resp.status < 400 else f'HTTP {resp.status}'
        except urllib.error.HTTPError as e:
            if e.code in (403, 405):
                try:
                    req2 = urllib.request.Request(url, method='GET', headers={'User-Agent': 'sapwood-check-links/1.0'})
                    with urllib.request.urlopen(req2, timeout=8) as resp2:
                        status = 'OK' if resp2.status < 400 else f'HTTP {resp2.status}'
                except Exception as e2:
                    status = f'ERROR {e2}'
            else:
                status = f'HTTP {e.code}'
        except Exception as e:
            status = f'ERROR {e}'
        if status == 'OK':
            ok += 1
        elif status.startswith('ERROR'):
            unverified += 1
        else:
            fail += 1
        print(f"  [{status}] {url}  (linked from: {srcs})")
    return ok, fail, unverified


def main():
    args = sys.argv[1:]
    internal_only = '--internal-only' in args
    positional = [a for a in args if a != '--internal-only']
    root = os.path.abspath(positional[0]) if positional else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    scope = sorted(collect_scope(root))
    print(f"Scope ({len(scope)} files, root={root}):")
    for f in scope:
        print(f"  - {f}")
    print()

    results = []
    external_links = {}
    for rel in scope:
        check_file(root, rel, results, external_links)

    print(f"=== Internal link/anchor check: {len(results)} problem(s) ===")
    for rel, target, kind, detail in results:
        print(f"  [{kind}] {rel} -> {target}  ({detail})")
    if not results:
        print("  (none)")

    if internal_only:
        return 1 if results else 0

    print()
    print(f"=== External links found ({len(external_links)} unique) ===")
    print(f"(repo is private -> unauthenticated HTTP to github.com/{REPO}/*")
    print(" URLs 404s regardless of validity; issue/PR links are checked via `gh api` instead)")
    ok, fail, unverified = check_external(external_links)
    print()
    print(f"External summary: {ok} ok, {fail} non-2xx/3xx/gh-api-error, {unverified} unverified/unreachable")

    return 1 if results else 0


if __name__ == '__main__':
    sys.exit(main())
