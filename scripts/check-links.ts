// sapwood dead-link checker — `npm run check-links` → `node scripts/check-links.ts --internal-only`.
// Node built-ins only (node:fs/path/child_process + fetch), no dependency. Plain Node 24
// type-stripped TypeScript, same pattern as release.ts: erasable syntax only, local imports
// carry an explicit `.ts` extension.
//
// Optionally check a different checkout (e.g. a worktree or an older commit's tree) by
// passing its path: `node scripts/check-links.ts /path/to/other/checkout`.
//
// `--internal-only` skips the external-link section entirely (no network, no `gh` call) and
// checks only relative links/anchors. This is the mode wired into CI, where a
// `gh`-authenticated, networked check would be flaky and would gate merges on outside URLs
// sapwood does not control.
//
// Scope: README.md + docs/ entry pages (see SEED_PAGES below) — and everything those pages
// link to, followed transitively over relative Markdown links. A seed that does not exist is
// reported as a MISSING SEED problem rather than silently dropped, so a doc move that forgets
// to update this list fails loudly instead of shrinking the checked scope unnoticed.
//
// What it checks:
//   - Every relative Markdown link (`[text](path)` or `[text](path#anchor)`) resolves to a
//     file that exists.
//   - Every `#anchor` (same-file or cross-file) resolves to a real heading in the target
//     file, using GitHub's own heading-slug algorithm (see engine/src/util/markdown-slug.ts).
//   - Every `https://github.com/herehigher/sapwood/issues/N` or `/pull/N` link is checked
//     with `gh api` rather than a raw HTTP request: this repo is currently **private**, so an
//     unauthenticated HTTP probe 404s on every such URL regardless of whether the issue/PR
//     actually exists. Other `github.com/herehigher/sapwood/...` links (workflow badges, the
//     private-vulnerability-reporting URL, etc.) can't be probed the same way and are
//     reported as `UNVERIFIED-PRIVATE` rather than silently passed.
//   - Every other `http(s)` external link gets a best-effort HEAD (falling back to GET on
//     403/405) request.
//
// Exit code: non-zero iff at least one internal link/anchor problem was found. External-link
// results are informational (network- and private-repo-dependent) and never affect the exit
// code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headingSlugs } from "../engine/src/util/markdown-slug.ts";

const REPO = "herehigher/sapwood";

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function headingsOf(path: string): Set<string> {
  try {
    return headingSlugs(readFileSync(path, "utf8"));
  } catch {
    return new Set();
  }
}

function stripAngleBrackets(s: string): string {
  return s.replace(/^[<>]+/, "").replace(/[<>]+$/, "");
}

const SEED_PAGES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/PLAN.md",
  "docs/guide/getting-started.md",
  "docs/guide/configuration.md",
  "docs/security.md",
  "docs/reference/role-paradigm.md",
  "docs/guide/troubleshooting.md",
  "docs/guide/supervision.md",
  "docs/dev-guide/README.md",
];

// Seeds on README + top-level docs entry pages, then follows relative .md links
// transitively. Traversal order doesn't matter — the result is a set, sorted by the caller.
// `missingSeeds` (seeds absent from disk) is returned separately rather than just skipped, so
// the caller can surface it as a problem instead of quietly shrinking the checked scope.
function collectScope(root: string): { scope: Set<string>; missingSeeds: string[] } {
  const scope = new Set<string>();
  const missingSeeds = SEED_PAGES.filter((f) => !existsSync(join(root, f)));
  const queue = SEED_PAGES.filter((f) => !missingSeeds.includes(f));
  while (queue.length > 0) {
    const rel = queue.pop();
    if (rel === undefined || scope.has(rel)) continue;
    scope.add(rel);
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf8");
    for (const match of content.matchAll(LINK_RE)) {
      let target = (match[2] ?? "").split(" ")[0] ?? "";
      target = stripAngleBrackets(target);
      if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:") || target.startsWith("#")) continue;
      const pathPart = target.split("#")[0] ?? "";
      if (!pathPart) continue;
      const newpath = normalize(join(dirname(rel), pathPart));
      if (newpath.endsWith(".md") && existsSync(join(root, newpath)) && !scope.has(newpath)) queue.push(newpath);
    }
  }
  return { scope, missingSeeds };
}

type Problem = [rel: string, target: string, kind: string, detail: string];

function checkFile(root: string, rel: string, results: Problem[], externalLinks: Map<string, string[]>): void {
  const full = join(root, rel);
  const content = readFileSync(full, "utf8");
  for (const match of content.matchAll(LINK_RE)) {
    const rawTarget = match[2] ?? "";
    const target = stripAngleBrackets(rawTarget.split(" ")[0] ?? "");
    if (!target) continue;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      const srcs = externalLinks.get(target) ?? [];
      srcs.push(rel);
      externalLinks.set(target, srcs);
      continue;
    }
    if (target.startsWith("mailto:")) continue;
    if (target.startsWith("#")) {
      const anchor = target.slice(1);
      if (anchor && !headingsOf(full).has(anchor)) {
        results.push([rel, rawTarget, "BROKEN ANCHOR (same-file)", `no heading slug "${anchor}" in ${rel}`]);
      }
      continue;
    }
    const hashIdx = target.indexOf("#");
    const pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? "" : target.slice(hashIdx + 1);
    const newpath = normalize(join(dirname(rel), pathPart));
    const newfull = join(root, newpath);
    if (!existsSync(newfull)) {
      results.push([rel, rawTarget, "BROKEN LINK", `target does not exist: ${newpath}`]);
      continue;
    }
    if (anchor && newpath.endsWith(".md") && !headingsOf(newfull).has(anchor)) {
      results.push([rel, rawTarget, "BROKEN ANCHOR", `no heading slug "${anchor}" in ${newpath}`]);
    }
  }
}

const ISSUE_PR_RE = new RegExp(`^https://github\\.com/${REPO}/(issues|pull)/(\\d+)`);

function isExecError(e: unknown): e is { stderr?: string } {
  return typeof e === "object" && e !== null && "stderr" in e;
}

async function probeHttp(url: string): Promise<string> {
  const headers = { "User-Agent": "sapwood-check-links/1.0" };
  try {
    const resp = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(8000) });
    if (resp.status !== 403 && resp.status !== 405) return resp.status < 400 ? "OK" : `HTTP ${resp.status}`;
    // GitHub and some other hosts reject HEAD on certain routes — retry with GET, same as
    // the Python original, rather than reporting a false failure.
    try {
      const resp2 = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
      return resp2.status < 400 ? "OK" : `HTTP ${resp2.status}`;
    } catch (e2) {
      return `ERROR ${e2 instanceof Error ? e2.message : String(e2)}`;
    }
  } catch (e) {
    return `ERROR ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkExternal(externalLinks: Map<string, string[]>): Promise<{ ok: number; fail: number; unverified: number }> {
  let ok = 0;
  let fail = 0;
  let unverified = 0;
  for (const url of [...externalLinks.keys()].sort()) {
    const srcs = [...new Set(externalLinks.get(url) ?? [])].sort().join(", ");
    const m = ISSUE_PR_RE.exec(url);
    if (m) {
      const kind = m[1] === "issues" ? "issues" : "pulls";
      try {
        // `gh api` rather than a raw HTTP request — see the module comment on why an
        // unauthenticated probe can't distinguish "private repo" from "does not exist".
        const state = execFileSync("gh", ["api", `repos/${REPO}/${kind}/${m[2]}`, "--jq", ".state"], { encoding: "utf8" }).trim();
        ok++;
        console.log(`  [OK (gh api: ${state})] ${url}  (linked from: ${srcs})`);
      } catch (e) {
        fail++;
        const detail = isExecError(e) && e.stderr ? e.stderr.trim() : e instanceof Error ? e.message : String(e);
        console.log(`  [ERROR (gh api: ${detail})] ${url}  (linked from: ${srcs})`);
      }
      continue;
    }
    if (url.startsWith(`https://github.com/${REPO}/`)) {
      unverified++;
      console.log(`  [UNVERIFIED-PRIVATE] ${url}  (linked from: ${srcs})`);
      continue;
    }
    const status = await probeHttp(url);
    if (status === "OK") ok++;
    else if (status.startsWith("ERROR")) unverified++;
    else fail++;
    console.log(`  [${status}] ${url}  (linked from: ${srcs})`);
  }
  return { ok, fail, unverified };
}

function repoRootFromThisFile(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const internalOnly = args.includes("--internal-only");
  const positional = args.filter((a) => a !== "--internal-only");
  const root = positional.length > 0 && positional[0] ? resolve(positional[0]) : repoRootFromThisFile();

  const { scope: scopeSet, missingSeeds } = collectScope(root);
  const scope = [...scopeSet].sort();
  console.log(`Scope (${scope.length} files, root=${root}):`);
  for (const f of scope) console.log(`  - ${f}`);
  console.log();

  const results: Problem[] = [];
  for (const f of missingSeeds) results.push([f, "(seed)", "MISSING SEED", `seed file does not exist: ${f}`]);

  const externalLinks = new Map<string, string[]>();
  for (const rel of scope) checkFile(root, rel, results, externalLinks);

  console.log(`=== Internal link/anchor check: ${results.length} problem(s) ===`);
  for (const [rel, target, kind, detail] of results) console.log(`  [${kind}] ${rel} -> ${target}  (${detail})`);
  if (results.length === 0) console.log("  (none)");

  if (internalOnly) return results.length > 0 ? 1 : 0;

  console.log();
  console.log(`=== External links found (${externalLinks.size} unique) ===`);
  console.log(`(repo is private -> unauthenticated HTTP to github.com/${REPO}/*`);
  console.log(" URLs 404s regardless of validity; issue/PR links are checked via `gh api` instead)");
  const { ok, fail, unverified } = await checkExternal(externalLinks);
  console.log();
  console.log(`External summary: ${ok} ok, ${fail} non-2xx/3xx/gh-api-error, ${unverified} unverified/unreachable`);

  return results.length > 0 ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv).then((code) => process.exit(code));
}
