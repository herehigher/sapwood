// Fail-closed PreToolUse safety guard — engine-side enforcement of producer ≠ reviewer ≠
// merger for the BUILT-IN Bash/file-tool family (exactly the tools worker.ts's guardSettings
// matcher names; #619 reword). Ambient host MCP tools never reach this hook at all — that
// residual, and branch protection as its mandatory backstop, are docs/security.md's
// "Host-delegated capability management" section (DR #616). Pure function: zero IO,
// deterministic; its sole dependency is util/doc-links.ts, a constants-only leaf with zero
// imports of its own (reviewer-adjudicated: a deterministic no-import constants leaf does not
// reintroduce the IO/nondeterminism this module's purity guards against).
//
// Implements the *generic safety mechanism* — command tokenizing, fragment splitting,
// exec-prefix stripping, opaque-construct fail-closed detection, and the gh-overreach category
// (the worker, a PR *producer*, must never merge/approve/release) — plus a Write-path
// protection for the guard's own boundary files. Application-specific categories are
// intentionally not included — this module stays generic and application-agnostic.
//
// Decision order for a Bash command:
//   1. split into fragments by shell chain operators; $()/`` substitutions recurse.
//   2. per fragment: strip env-assignments + exec wrappers (env/uv/npx/...).
//   3. opaque constructs (eval / shell -c / interpreter -e / process substitution) =>
//      BLOCK fail-closed (a worker could hide anything inside them).
//   4. gh-overreach semantic check.
//   5. (#679) raw git-transport `git push` reaching the default branch — same producer≠merger
//      boundary as step 4, active only when defaultBranch is set (see docs/security.md).
// For Write/Edit tools: deny writes to the guard's boundary files.
// For Read/Grep/Glob/NotebookRead (#235 PR-A): confine the resolved target path to the session's
// worktree, when the engine told us what that worktree is (worktreeRoot param — see below).
import { DOC_LINKS } from "../util/doc-links.js";

export interface Decision {
  readonly allow: boolean;
  readonly reason: string; // BLOCK names the category + hit; ALLOW is "".
}

const ALLOW: Decision = Object.freeze({ allow: true, reason: "" });
const block = (reason: string): Decision => Object.freeze({ allow: false, reason });

export interface GuardInput {
  // Claude Code tool_input shape (only the fields the guard reads).
  command?: string; // Bash
  file_path?: string; // Write / Edit / MultiEdit / Read
  path?: string; // Grep / Glob search root (optional — Claude Code defaults it to cwd when absent)
  notebook_path?: string; // NotebookRead / NotebookEdit (#620)
}

// ── shlex-equivalent tokenizer ───────────────────────────────────────────────
// Mirrors Python shlex.split(posix=True) closely enough for the guard: whitespace
// splits; '...' is literal; "..." lets \ escape only " and \; bare \ escapes the next
// char. Unbalanced quotes throw (caller falls back to whitespace split, matching guard.py).
class TokenizeError extends Error {}

function shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false; // produced a (possibly empty) token at this position
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      i++;
    } else if (c === "'") {
      has = true;
      i++;
      const end = s.indexOf("'", i);
      if (end === -1) throw new TokenizeError("unbalanced single quote");
      cur += s.slice(i, end);
      i = end + 1;
    } else if (c === '"') {
      has = true;
      i++;
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n && (s[i + 1] === '"' || s[i + 1] === "\\")) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      if (i >= n) throw new TokenizeError("unbalanced double quote");
      i++; // closing "
    } else if (c === "\\") {
      has = true;
      if (i + 1 < n) {
        cur += s[i + 1];
        i += 2;
      } else {
        // trailing backslash: shlex raises; mirror by throwing
        throw new TokenizeError("trailing backslash");
      }
    } else {
      has = true;
      cur += c;
      i++;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

/** shlex split; on parse failure, degrade to whitespace split (matches guard.py). */
export function safeSplit(fragment: string): string[] {
  try {
    return shlexSplit(fragment);
  } catch {
    return fragment.split(/\s+/).filter((t) => t.length > 0);
  }
}

// ── path basename (POSIX-ish, no node:path dep to keep guard zero-dep & deterministic) ──
function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}
function hasPathSep(t: string): boolean {
  return t.includes("/") || t.includes("\\");
}

// ── command substitution extraction ($() recurses; backticks too) ────────────
function extractCommandSubstitutions(text: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "(") {
      const parenStart = i + 1;
      let depth = 0;
      let j = parenStart;
      while (j < text.length) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) {
            const inner = text.slice(parenStart + 1, j);
            results.push(inner);
            results.push(...extractCommandSubstitutions(inner));
            break;
          }
        }
        j++;
      }
    }
    i++;
  }
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    const inner = m[1]!;
    results.push(inner);
    results.push(...extractCommandSubstitutions(inner));
  }
  return results;
}

// chain operators. `|`/`&` only split as real control operators, never as part of a
// redirection: `>|` (noclobber override), `&>`/`&>>` (& before >), `>&` (& after >). The
// lookbehinds keep those redirections intact so their target isn't lost.
const CHAIN_RE = /&&|\|\||;|(?<!>)\||(?<!>)&(?!>)|\n/;

function splitFragments(command: string): string[] {
  const subs = extractCommandSubstitutions(command);
  const main = command.split(CHAIN_RE);
  return [...main, ...subs].map((f) => f.trim()).filter((f) => f.length > 0);
}

// ── exec-prefix stripping ────────────────────────────────────────────────────
const SHELL_CMDS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETER_EVAL_FLAGS: Record<string, Set<string>> = {
  python: new Set(["-c"]),
  perl: new Set(["-e"]),
  ruby: new Set(["-e"]),
  php: new Set(["-r"]),
  node: new Set(["-e", "--eval"]),
};

/** Resolve an interpreter's eval flags, tolerating versioned binaries (python3.11, node20). */
function interpreterEvalFlags(name: string): Set<string> | undefined {
  const m = /^(python|node|perl|ruby|php)[0-9.]*$/.exec(name);
  return m ? INTERPRETER_EVAL_FLAGS[m[1]!] : undefined;
}
// uv run value-consuming flags (skip flag + value). NOTE: --all-extras is a *boolean* and
// must NOT be here, else the command after it is mistaken for its value. The allowlist is
// best-effort; the gh/write scans are position-independent so an unknown flag can't bypass.
const UV_FLAGS_WITH_VALUE = new Set(["--directory", "--project", "--python", "--extra", "--package", "-p"]);

function skipWrapperFlags(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (!tok.startsWith("-")) break;
    if (tok === "-m" || tok === "--module") break; // interpreter flag, not the wrapper's
    if (tok.includes("=")) i += 1;
    else if (UV_FLAGS_WITH_VALUE.has(tok) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) i += 2;
    else i += 1;
  }
  return tokens.slice(i);
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

// env flags that consume a following argument (so the arg isn't mistaken for the command).
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir"]);

function stripExecPrefix(tokensIn: string[], depth = 0): string[] {
  if (depth > 8) return tokensIn; // recursion bound (nested wrappers)
  const tokens = stripLeadingAssignments(tokensIn);
  if (tokens.length === 0) return tokens;
  const first = tokens[0]!.toLowerCase();

  // All wrapper branches recurse on the remainder, so a stacked wrapper
  // (env FOO=1 uv run gh ...) strips all the way down to the real command.
  if ((first === "uv" || first === "poetry") && tokens.length >= 2 && tokens[1]!.toLowerCase() === "run") {
    return stripExecPrefix(skipWrapperFlags(tokens.slice(2)), depth + 1);
  }
  if (first === "uvx" || first === "npx") return stripExecPrefix(tokens.slice(1), depth + 1);
  if (first === "env") {
    let i = 1;
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      // -u NAME / -C DIR consume the next token (unless given as --flag=value)
      if (ENV_VALUE_FLAGS.has(tokens[i]!) && i + 1 < tokens.length) i += 2;
      else i += 1;
    }
    while (i < tokens.length && ASSIGN_RE.test(tokens[i]!)) i++;
    return stripExecPrefix(tokens.slice(i), depth + 1);
  }
  if (["command", "exec", "nohup", "builtin", "time"].includes(first)) {
    let rest = tokens.slice(1);
    while (rest.length && rest[0]!.startsWith("-")) rest = rest.slice(1);
    return rest.length ? stripExecPrefix(rest, depth + 1) : rest;
  }
  if (first === "stdbuf") {
    let i = 1;
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    const rest = tokens.slice(i);
    return rest.length ? stripExecPrefix(rest, depth + 1) : rest;
  }
  return tokens;
}

// ── opaque construct detection (fail-closed) ─────────────────────────────────
const SHELL_VALUE_OPTS = new Set(["-O", "+O", "-o", "+o", "--rcfile", "--init-file"]);

function shellHasDashC(tokens: string[]): boolean {
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "--") break;
    if (SHELL_VALUE_OPTS.has(tok)) {
      i += 2;
      continue;
    }
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.slice(1).includes("c")) return true;
    if (!tok.startsWith("-")) break;
    i++;
  }
  return false;
}

function checkOpaque(tokens: string[], fragment: string): string | null {
  if (/[<>]\(/.test(fragment)) return "BLOCK [opaque] process substitution <(...) / >(...)";
  if (tokens.length === 0) return null;
  const firstRaw = tokens[0]!;
  const first = basename(firstRaw).toLowerCase();
  if (SHELL_CMDS.has(first) && shellHasDashC(tokens)) return `BLOCK [opaque] ${firstRaw} -c shell wrapper`;
  if (first === "eval") return "BLOCK [opaque] eval";
  const evalFlags = interpreterEvalFlags(first);
  if (evalFlags) {
    for (const tok of tokens.slice(1)) {
      if (evalFlags.has(tok)) return `BLOCK [opaque] ${firstRaw} ${tok} code eval`;
      if (tok.startsWith("-") && !tok.startsWith("--") && tok.length >= 2 && evalFlags.has(tok.slice(0, 2))) {
        return `BLOCK [opaque] ${firstRaw} ${tok} code eval`;
      }
    }
  }
  return null;
}

// ── category C: gh overreach (producer ≠ merger) ─────────────────────────────
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_PATH_RE = /\/pulls\/[^/]+\/merge|\/releases/i;
const ISSUE_GOVERNANCE_PATH_RE =
  /(?:^|\/)repos\/[^/]+\/[^/]+\/(?:issues\/[^/]+\/(?:labels|sub_issues?)(?:[/?#]|$)|labels(?:[/?#]|$)|issues\/\d+\/?(?:[?#].*)?$|milestones(?:\/\d+)?(?:[/?#]|$))/i;
const ALLOWED_DELETE_PATH_RE = /\/git\/refs/i;
const FIELD_FLAGS = new Set(["-f", "--field", "-F", "--raw-field"]);
const ISSUE_EDIT_GOVERNANCE_FLAGS = new Set([
  "--add-label",
  "--remove-label",
  "--milestone",
  "-m",
  "--remove-milestone",
  "--add-project",
  "--remove-project",
  "--add-sub-issue",
  "--remove-sub-issue",
  "--remove-parent",
  "--parent",
]);
// #353: the issue lifecycle is engine/human-owned (dispatch consumes the OPEN-issue queue).
// `Closes #N` auto-close on merge is GitHub-native, not a gh call, so the worker never
// legitimately needs these verbs. `comment`/`view`/`list`/`status`/`create` stay ungoverned.
const ISSUE_LIFECYCLE_VERBS = new Set(["close", "reopen", "transfer", "delete"]);
// gh api flags that consume the NEXT token as their value — must be skipped so the value
// isn't mistaken for the endpoint (e.g. `gh api --hostname HOST graphql ...`).
const GH_API_VALUE_FLAGS = new Set([
  "--hostname",
  "-H",
  "--header",
  "--input",
  "--cache",
  "--jq",
  "-q",
  "--template",
  "-t",
  "-p",
  "--preview",
]);

function ghSkipGlobalFlags(tokens: string[], startIndex = 1): string[] {
  const withValue = new Set(["-R", "--repo"]);
  let i = startIndex;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (!tok.startsWith("-")) break;
    if (tok.includes("=")) {
      i += 1;
      continue;
    }
    if (withValue.has(tok)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return tokens.slice(i);
}

function decodePercentPairsLenient(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}/g, (pair) => String.fromCharCode(Number.parseInt(pair.slice(1), 16)));
}

function checkGhApi(tokens: string[], fragment: string): string | null {
  let method: string | null = null;
  let hasField = false;
  let hasInput = false; // gh defaults to POST when --input is given (cli/cli api.go)
  let pathToken: string | null = null;
  let i = 2;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if ((tok === "-X" || tok === "--method") && i + 1 < tokens.length) {
      method = tokens[i + 1]!.toUpperCase();
      i += 2;
      continue;
    }
    if (tok.startsWith("--method=") || tok.startsWith("-X=")) {
      method = tok.split("=", 2)[1]!.toUpperCase();
      i += 1;
      continue;
    }
    if (tok.startsWith("-X") && tok.length > 2 && tok[2] !== "=") {
      method = tok.slice(2).toUpperCase();
      i += 1;
      continue;
    }
    if (tok === "--input" || tok.startsWith("--input=")) {
      hasInput = true;
      i += tok === "--input" ? 2 : 1;
      continue;
    }
    if (FIELD_FLAGS.has(tok)) {
      hasField = true;
      i += 1;
      if (i < tokens.length && !tokens[i]!.startsWith("-")) i += 1;
      continue;
    }
    for (const ff of FIELD_FLAGS) {
      if (tok.startsWith(ff + "=") || (ff.length === 2 && tok.startsWith(ff) && tok.length > ff.length)) {
        hasField = true;
        break;
      }
    }
    // value-taking flag (e.g. --hostname HOST): skip flag + value so HOST isn't the endpoint
    if (GH_API_VALUE_FLAGS.has(tok)) {
      i += 2;
      continue;
    }
    if (!tok.startsWith("-") && pathToken === null) pathToken = tok;
    i++;
  }
  if (method === null && (hasField || hasInput)) method = "POST";

  let canonicalPathToken = pathToken;
  try {
    // GitHub decodes REST paths once. Match that behavior exactly: never loop over
    // a decoded result (so `%2525` remains `%25`, rather than becoming `%`).
    canonicalPathToken = pathToken === null ? null : decodeURIComponent(pathToken);
  } catch {
    return "BLOCK [gh] api REST endpoint has malformed percent-encoding — path is opaque (fail-closed)";
  }
  // The fragment is a secondary scan over mixed paths and field values. Decode valid
  // percent pairs once, but preserve stray/partial `%` literally so benign values such
  // as `90% done` cannot make an otherwise-parseable endpoint opaque.
  const canonicalFragment = decodePercentPairsLenient(fragment);

  if (canonicalPathToken && canonicalPathToken.toLowerCase().replace(/^\/+|\/+$/g, "") === "graphql") {
    const fieldValues: string[] = [];
    let j = 2;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (FIELD_FLAGS.has(t)) {
        if (j + 1 < tokens.length) {
          fieldValues.push(tokens[j + 1]!);
          j += 2;
        } else j += 1;
        continue;
      }
      for (const ff of FIELD_FLAGS) {
        if (t.startsWith(ff + "=")) {
          fieldValues.push(t.split("=", 2)[1]!);
          break;
        }
        if (ff.length === 2 && t.startsWith(ff) && t.length > ff.length) {
          fieldValues.push(t.slice(ff.length));
          break;
        }
      }
      j++;
    }
    // --input <file> supplies the whole request body from a file we can't read → fail-closed.
    if (tokens.some((t) => t === "--input" || t.startsWith("--input="))) {
      return "BLOCK [gh] graphql --input file is opaque — cannot verify non-mutation (fail-closed)";
    }
    const isFileRef = (v: string): boolean => (v.includes("=") ? v.split("=", 2)[1]! : v).startsWith("@");
    if (fieldValues.some(isFileRef)) return "BLOCK [gh] graphql @file reference is opaque — cannot verify non-mutation (fail-closed)";
    const hasMutation = fieldValues.some((v) => v.toLowerCase().includes("mutation")) || /\bmutation\b/i.test(fragment);
    return hasMutation ? "BLOCK [gh] graphql mutation" : null;
  }

  if (!method || !MUTATING_METHODS.has(method)) return null;
  if (canonicalPathToken && ISSUE_GOVERNANCE_PATH_RE.test(canonicalPathToken)) {
    return `BLOCK [gh] api mutates issue labels/milestone/state: ${canonicalPathToken}`;
  }
  for (const _ of canonicalFragment.matchAll(new RegExp(ISSUE_GOVERNANCE_PATH_RE, "gi"))) {
    return "BLOCK [gh] api mutates issue labels/milestone/state";
  }
  if (method === "DELETE" && canonicalPathToken && ALLOWED_DELETE_PATH_RE.test(canonicalPathToken)) return null;
  if (canonicalPathToken && SENSITIVE_PATH_RE.test(canonicalPathToken)) {
    return canonicalPathToken.toLowerCase().includes("/releases")
      ? `BLOCK [gh] api mutates releases: ${canonicalPathToken}`
      : `BLOCK [gh] api mutates PR merge: ${canonicalPathToken}`;
  }
  for (const m of canonicalFragment.matchAll(new RegExp(SENSITIVE_PATH_RE, "gi"))) {
    return m[0]!.toLowerCase().includes("/releases") ? "BLOCK [gh] api mutates releases" : "BLOCK [gh] api mutates PR merge";
  }
  return null;
}

function checkCategoryC(tokens: string[], fragment: string): string | null {
  if (tokens.length < 2 || basename(tokens[0]!).toLowerCase() !== "gh") return null;
  const remaining = ghSkipGlobalFlags(tokens);
  if (remaining.length === 0) return null;
  const sub1 = remaining[0]!.toLowerCase();
  const subcommand = ghSkipGlobalFlags(remaining);
  if (sub1 === "pr" && subcommand.length >= 1) {
    const sub2 = subcommand[0]!.toLowerCase();
    if (sub2 === "merge") return "BLOCK [gh] pr merge — producer must not merge";
    if (sub2 === "ready") return "BLOCK [gh] pr ready — producer must not promote its own PR";
    // producer ≠ reviewer: a worker must not approve / request-changes (gate② is a fresh
    // non-author review). A plain `gh pr review --comment` is fine.
    if (sub2 === "review" && subcommand.some((t) => t === "--approve" || t === "-a" || t === "--request-changes" || t === "-r")) {
      return "BLOCK [gh] pr review --approve/--request-changes — producer must not review (producer≠reviewer)";
    }
  }
  if (sub1 === "issue" && subcommand[0]?.toLowerCase() === "edit") {
    if (
      subcommand
        .slice(1)
        .some((t) =>
          [...ISSUE_EDIT_GOVERNANCE_FLAGS].some(
            (flag) => t === flag || t.startsWith(`${flag}=`) || (flag.length === 2 && t.startsWith(flag) && t.length > flag.length),
          ),
        )
    ) {
      return "BLOCK [gh] issue edit label/milestone/board/relation mutation — producer must not change dispatch state";
    }
  }
  // #353: `gh issue close|reopen|transfer|delete` are the same lifecycle mutations #352
  // blocks at the REST/graphql layer, reached through the high-level CLI verb instead.
  if (sub1 === "issue" && ISSUE_LIFECYCLE_VERBS.has(subcommand[0]?.toLowerCase() ?? "")) {
    const verb = subcommand[0]!.toLowerCase();
    return `BLOCK [gh] issue ${verb} — producer must not alter the issue lifecycle (engine/human-owned)`;
  }
  if (sub1 === "label") return "BLOCK [gh] label — producer must not mutate repository labels";
  if (sub1 === "project") return "BLOCK [gh] project — producer must not mutate project-board state";
  if (sub1 === "release") return "BLOCK [gh] release — producer must not publish releases";
  if (sub1 === "api") return checkGhApi([tokens[0]!, ...remaining], fragment);
  return null;
}

/**
 * Find a `gh <overreach>` sequence at ANY position, not just token[0]. Wrappers have
 * open-ended value flags we can't fully enumerate (`uv run --with rich gh pr merge`
 * leaves "rich" as the apparent command), so rather than perfectly parse every wrapper,
 * we scan for `gh` anywhere and apply Category C from there. checkCategoryC still allows
 * read-only gh, so this only blocks genuine overreach. (Quoted data stays a single token,
 * so it can't masquerade as `gh <sub>`.)
 */
function scanGhOverreach(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    if (basename(tokens[i]!).toLowerCase() === "gh") {
      const slice = tokens.slice(i);
      const r = checkCategoryC(slice, slice.join(" "));
      if (r) return r;
    }
  }
  return null;
}

// ── category D: raw git-transport push to the default branch (#679) ─────────
// Blocks `git push` whose destination reaches `defaultBranch`, at the git-transport layer
// (Category C above only covers the `gh` layer). Active only when `defaultBranch` is non-empty
// (SAPWOOD_DEFAULT_BRANCH, engine-set at spawn, never worker-writable). Not a replacement for
// GitHub branch protection — that's the backstop of record (DR #616), see docs/security.md.
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "-c", "--exec-path"]);

/** Skip `git`'s own global flags (e.g. `git -C dir push ...`) so the subcommand check below
 *  can't be defeated by a leading global flag pushing "push" out of position. Mirrors
 *  ghSkipGlobalFlags' shape for the same reason: a wrapper-tolerant, position-independent scan
 *  needs the SAME tolerance for the command it wraps. */
function gitSkipGlobalFlags(tokens: string[]): string[] {
  let i = 1; // tokens[0] is "git"
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (!tok.startsWith("-")) break;
    if (tok.includes("=")) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(tok)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return tokens.slice(i);
}

const ALIAS_CONFIG_KEY_RE = /^alias\./i;

function gitConfigValueDefinesAlias(value: string): boolean {
  const key = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
  return ALIAS_CONFIG_KEY_RE.test(key);
}

/** A `-c`/`--config alias.*=` redefines what a later bare subcommand token means, so once one is
 *  present the effective subcommand can never be trusted from argv alone — opaque, unconditional
 *  block, same doctrine as `eval`/`sh -c`. */
function gitHasAliasInjection(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if ((tok === "-c" || tok === "--config") && i + 1 < tokens.length) {
      if (gitConfigValueDefinesAlias(tokens[i + 1]!)) return true;
    } else if (tok.startsWith("-c") && tok.length > 2 && tok[2] !== "=") {
      if (gitConfigValueDefinesAlias(tok.slice(2))) return true;
    } else if (tok.startsWith("--config=")) {
      if (gitConfigValueDefinesAlias(tok.slice("--config=".length))) return true;
    }
  }
  return false;
}

// An unresolved shell variable/command-substitution ($FOO/${FOO}/$(...)/backtick) can expand to
// the default branch at runtime after the guard only sees the literal token; a `*` wildcard
// destination can match it without ever naming it — neither can be proven safe, so both block.
const UNPROVABLE_REFSPEC_RE = /[$`*]/;

// Value-taking push options, split out so their separate-token VALUE (e.g. `-o main`'s "main")
// is never scanned as a candidate refspec destination.
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

/** Split git-push's OWN args (everything after "push") into flags and POSITIONAL args, properly
 *  skipping a value-taking flag's separate value so it never masquerades as a remote/refspec.
 *  `--` ends option parsing (everything after is positional), matching git's own convention.
 *  `repoFromFlag` is true when `--repo`/`--repo=` supplied the repository directly — there is
 *  then no positional remote to skip, so every positional is a candidate refspec. */
function parsePushArgs(args: string[]): { flags: string[]; positional: string[]; repoFromFlag: boolean } {
  const flags: string[] = [];
  const positional: string[] = [];
  let repoFromFlag = false;
  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (tok.startsWith("-")) {
      flags.push(tok);
      if (tok === "--repo" || tok.startsWith("--repo=")) repoFromFlag = true;
      if (!tok.includes("=") && PUSH_VALUE_FLAGS.has(tok) && i + 1 < args.length) {
        i += 2; // skip the flag's separate value entirely — never a candidate refspec
        continue;
      }
      i += 1;
      continue;
    }
    positional.push(tok);
    i += 1;
  }
  return { flags, positional, repoFromFlag };
}

/**
 * `tokens` starts at (and includes) `git`. Returns a BLOCK reason when this invocation is a
 * `git push` whose effect can reach `defaultBranch`, else null. `--force`/`-f`/
 * `--force-with-lease` are deliberately NOT special-cased: they don't change WHICH ref is
 * targeted, only how the push is applied, so the same refspec-destination check already
 * subsumes them — a forced push at the default branch is still a push at the default branch.
 */
function checkGitPushDefaultBranch(tokens: string[], defaultBranch: string): string | null {
  if (!defaultBranch) return null;
  if (tokens.length < 2 || basename(tokens[0]!).toLowerCase() !== "git") return null;

  // Checked before anything else — an alias injection means the "push" token itself is untrustworthy.
  if (gitHasAliasInjection(tokens)) {
    return `BLOCK [git-push] git -c/--config alias injection makes the effective subcommand opaque — cannot verify this does not reach the default branch (${defaultBranch}); human-merge-only, see ${DOC_LINKS.security}`;
  }

  const afterGlobal = gitSkipGlobalFlags(tokens);
  if (afterGlobal.length === 0 || afterGlobal[0]!.toLowerCase() !== "push") return null;

  const { flags, positional, repoFromFlag } = parsePushArgs(afterGlobal.slice(1));

  // --mirror / --all push every ref (or every branch) the remote has room for — either can
  // carry the default branch regardless of what other args are present.
  if (flags.includes("--mirror")) {
    return `BLOCK [git-push] --mirror can reach the default branch (${defaultBranch}) — raw git-transport push is human-merge-only, see ${DOC_LINKS.security}`;
  }
  if (flags.includes("--all")) {
    return `BLOCK [git-push] --all can reach the default branch (${defaultBranch}) — raw git-transport push is human-merge-only, see ${DOC_LINKS.security}`;
  }

  // positional[0] is the remote/repository (per git's own `push [<repo> [<refspec>…]]` syntax) —
  // NEVER itself compared against defaultBranch (a remote literally named "main" is legitimate) —
  // unless repoFromFlag, in which case every positional is a candidate refspec.
  const refspecs = repoFromFlag ? positional : positional.slice(1);
  for (const raw of refspecs) {
    if (UNPROVABLE_REFSPEC_RE.test(raw)) {
      return `BLOCK [git-push] refspec argument "${raw}" cannot be proven safe against the default branch (${defaultBranch}) — contains an unresolved variable, command substitution, or wildcard; human-merge-only, see ${DOC_LINKS.security}`;
    }
    // A bare name ("main"), a "<src>:<dst>" pair (dst after the FIRST colon — also covers the
    // ":main" delete-refspec form, where src is empty), and an optional leading "+" (the
    // refspec force-push marker) or "refs/heads/" prefix are all normalized to the same
    // destination-name comparison.
    const unforced = raw.startsWith("+") ? raw.slice(1) : raw;
    const dst = unforced.includes(":") ? unforced.slice(unforced.indexOf(":") + 1) : unforced;
    if (!dst) continue;
    const normalized = dst.startsWith("refs/heads/") ? dst.slice("refs/heads/".length) : dst;
    if (normalized === defaultBranch) {
      return `BLOCK [git-push] raw git-transport push reaches the default branch (${defaultBranch}) — producer must not merge via raw git transport (human-merge-only, see ${DOC_LINKS.security})`;
    }
  }
  return null;
}

/** Find a `git push ...` sequence reaching the default branch at ANY position (same
 *  wrapper-tolerance rationale as scanGhOverreach). No-op when `defaultBranch` is empty. */
function scanGitPushDefaultBranch(tokens: string[], defaultBranch: string): string | null {
  if (!defaultBranch) return null;
  for (let i = 0; i < tokens.length; i++) {
    if (basename(tokens[i]!).toLowerCase() === "git") {
      const r = checkGitPushDefaultBranch(tokens.slice(i), defaultBranch);
      if (r) return r;
    }
  }
  return null;
}

// ── env -S split-string extraction ───────────────────────────────────────────
// GNU env -S splits the string into argv, then APPENDS any trailing COMMAND [ARG] tokens.
// So `env -S gh pr merge 1` runs `gh pr merge 1` — we must judge the split string plus
// everything after it, not just the -S argument.
function envSplitInner(tokens: string[]): string | null {
  if (tokens.length === 0 || tokens[0]!.toLowerCase() !== "env") return null;
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    let value: string | null = null;
    let nextI = i;
    if (tok === "--split-string" || tok === "-S") {
      if (i + 1 >= tokens.length) return null;
      value = tokens[i + 1]!;
      nextI = i + 2;
    } else if (tok.startsWith("--split-string=")) {
      value = tok.slice("--split-string=".length);
      nextI = i + 1;
    } else if (tok.startsWith("-S") && tok.length > 2 && !tok.startsWith("-S=")) {
      value = tok.slice(2);
      nextI = i + 1;
    } else if (tok.startsWith("-S=") && tok.length > 3) {
      value = tok.slice(3);
      nextI = i + 1;
    } else if (ENV_VALUE_FLAGS.has(tok) && i + 1 < tokens.length) {
      // -u NAME / -C DIR consume their argument before we reach -S
      i += 2;
      continue;
    } else if (tok.startsWith("-")) {
      i++;
      continue;
    } else {
      break;
    }
    return [value, ...tokens.slice(nextI)].join(" ");
  }
  return null;
}

// ── single-fragment judgement ────────────────────────────────────────────────
function judgeFragment(fragment: string, cwd: string, depth = 0, defaultBranch = ""): string | null {
  if (depth > 8) return null;
  let tokens = safeSplit(fragment);
  if (tokens.length === 0) return null;

  // strip shell grouping/subshell punctuation that hides the command:
  //   (gh pr merge 1)  →  ["(gh", ...] ;  { gh pr merge 1; } → ["{", "gh", ...]
  while (tokens.length && (tokens[0] === "(" || tokens[0] === "{" || tokens[0] === "((")) tokens = tokens.slice(1);
  if (tokens.length) {
    const head = tokens[0]!.replace(/^[({]+/, "");
    tokens = head ? [head, ...tokens.slice(1)] : tokens.slice(1);
  }
  if (tokens.length === 0) return null;

  if (hasPathSep(tokens[0]!)) tokens = [basename(tokens[0]!), ...tokens.slice(1)];

  if (tokens[0]!.toLowerCase() === "env") {
    const inner = envSplitInner(tokens);
    if (inner !== null) return judgeFragment(inner, cwd, depth + 1, defaultBranch);
  }

  let stripped = stripExecPrefix(tokens);
  // a wrapper can reintroduce a path-prefixed command (uv run /usr/bin/gh ...) — normalize.
  if (stripped.length && hasPathSep(stripped[0]!)) stripped = [basename(stripped[0]!), ...stripped.slice(1)];
  const opaque = checkOpaque(stripped, fragment);
  if (opaque) return opaque;

  // shell writes to boundary files (redirect / tee / sed -i / dd / cp-mv-install) —
  // scanned on the original tokens (any position) so a wrapper can't hide the write.
  const w = checkBashWritePath(tokens, cwd);
  if (w) return w;

  // #731: sapwood pause/stop/estop CLI verbs — same control-sentinel boundary as the check
  // below; see docs/security.md.
  const sv = checkStopControlVerb(tokens);
  if (sv) return sv;

  // #81: control sentinel referenced as a literal arg to any command (e.g. a node script
  // invoked with the sentinel path), scanned on the original tokens same as the write check.
  const cs = checkControlSentinelArg(tokens, cwd);
  if (cs) return cs;

  // gh overreach, scanned at any position on both the stripped and the original tokens.
  const gh = scanGhOverreach(stripped) ?? scanGhOverreach(tokens);
  if (gh) return gh;

  // #679: raw git-transport push to the default branch, same any-position/wrapper-tolerant
  // scan as the gh check above. No-op when defaultBranch is empty (rule inactive).
  return scanGitPushDefaultBranch(stripped, defaultBranch) ?? scanGitPushDefaultBranch(tokens, defaultBranch);
}

// ── Write-path protection (issue #9) ─────────────────────────────────────────
// A worker must not weaken its own boundary: hook wiring, CI, the guard/reviewer source.
function normalizePath(p: string, cwd: string): string {
  const expanded = p.startsWith("~/") ? p.slice(1) : p; // ~ handling is best-effort (no HOME dep)
  const joined = expanded.startsWith("/") ? expanded : `${cwd.replace(/\/+$/, "")}/${expanded}`;
  // collapse . and .. segments
  const out: string[] = [];
  for (const seg of joined.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

// merge-driver.ts is the merge path itself (gate①/② + the --match-head-commit TOCTOU pin):
// a worker rewriting it could gut the gate the same way it could gut reviewer.ts (#13).
const PROTECTED_SUFFIXES = [
  "/engine/src/guard/guard.ts",
  "/engine/src/guard/guard-hook.ts",
  "/engine/src/roles/reviewer.ts",
  "/engine/src/roles/merge-driver.ts",
];

// ── .sapwood/** runtime-root write-deny (#1079, replaces the three-name CONTROL_SENTINEL_RE) ──
// #81/#779 (fable gate② follow-up to #80, #724): a worker forging PAUSE starves competing
// dispatch, deleting KILL_SWITCH defeats the hard-stop escape hatch, and deleting
// EMERGENCY_STOP defeats the operator's immediate-stop control — the three control sentinels
// used to be the ONLY named boundary here, leaving every other runtime-owned path (sqlite,
// sessions, the review clone, generated/role-skills/**, #656) unprotected by construction,
// since nothing named them either. `.sapwood/` is the fixed engine runtime root; a worker has
// zero legitimate reason to write ANYWHERE under it, so one segment-equality rule replaces the
// enumeration — root equality (`rm -rf .sapwood`) now also closes the old "directory deleted
// without ever naming a sentinel" residual, since the root itself matches, not just a file
// inside it.
//
// SAPWOOD_ROOT_SEGMENT is spelled locally, not imported from #1077's `runtimePaths()` module:
// guard-hook.ts is a standalone binary spawned as a Claude CLI PreToolUse hook and must stay
// free of engine-config imports.
const SAPWOOD_ROOT_SEGMENT = ".sapwood";

/** True when `abs` (a normalized absolute path) contains `.sapwood` as an EXACT path segment —
 *  the root itself or any descendant. Segment equality, not substring: a sibling name
 *  (`.sapwood-notes/`, `docs/.sapwoodx`) or the string appearing inside a filename
 *  (`notes/about.sapwood.md`) does not match. Case-insensitive, the same stance the sentinel
 *  regex already took (macOS/APFS is case-insensitive by default; over-blocking a path nobody
 *  legitimately uses is the fail-closed direction — owner ruling 2026-08-25). No filesystem
 *  canonicalisation (no realpath/lstat) — lexical only, same as every other rule in this file;
 *  symlink aliasing stays a documented residual (docs/security.md), not one this closes. */
function isUnderSapwoodRoot(abs: string): boolean {
  return abs.split("/").some((seg) => seg.toLowerCase() === SAPWOOD_ROOT_SEGMENT);
}

/** If `abs` (a normalized absolute path) is a boundary file, return a short label; else null. */
function protectedPathLabel(abs: string): string | null {
  if (isUnderSapwoodRoot(abs)) return ".sapwood/** (sapwood runtime root)";
  if (/\/\.claude\/settings(\.local)?\.json$/.test(abs)) return ".claude/settings.json (hook wiring)";
  if (/\/\.github\/workflows(\/|$)/.test(abs)) return ".github/workflows/** (CI integrity)";
  // The engine config carries guard.mode + reviewer/security settings — a worker editing it to
  // guard.mode:soft would make future workers observe-only. Human-merge-only (Codex #26 R2).
  // Matched case-insensitively (gate② P1 on #809, same bypass class #84 already closed for the
  // sentinels above): macOS/APFS is case-insensitive by default, so `touch SAPWOOD.CONFIG.YAML`
  // still lands on the real file — this rule was found missing the `i` flag the sentinel rule
  // already carries, and is fixed here alongside the sibling template rule below rather than
  // left adjacent-and-inconsistent.
  if (/\/sapwood\.config\.(ya?ml|json)$/i.test(abs)) return "sapwood.config.* (engine/guard config)";
  // The init-starter template (`sapwood init`'s sampleConfig()/ensureConfig(), #386/#577) carries
  // the same safe-by-default pin (merge.mode: produce-pr-and-stop) the root config's guard.mode/
  // reviewer.* fields carry above — a worker weakening it here degrades every future `sapwood
  // init`'s default, not just this repo's live config. #776 already routes edits to it through
  // instruction-path escalation; this closes the matching HARD guard boundary the root config
  // gets (#781, found at gate② on PR #776: guard allow=true for this file). Sibling rule, not a
  // widened root regex, so the two labels/rationales stay distinct in reasons and tests. Matched
  // case-insensitively for the same reason as the root rule immediately above (gate② P1 on #809).
  if (/\/sapwood\.config\.example\.(ya?ml|json)$/i.test(abs)) return "sapwood.config.example.* (init-starter template)";
  // The COMPILED guard artifacts are what each PreToolUse invocation actually executes — a
  // worker overwriting dist/guard-hook.js (or the guard.js it loads) with a no-op would disable
  // hard-mode enforcement for the next tool call. Protect the artifact, not just src (Codex #26 R3).
  // ... and the same for the review/merge path: the conductor executes reviewer.js /
  // merge-driver.js from dist, so protecting only their src would leave the running gate
  // overwritable (same vector as the guard artifact above).
  if (/\/engine\/dist\/(guard\/guard(-hook)?|roles\/(reviewer|merge-driver))\.js$/.test(abs))
    return "engine/dist gate artifact (compiled guard/reviewer/merge-driver)";
  if (PROTECTED_SUFFIXES.some((s) => abs.endsWith(s))) return "guard/reviewer/merge-driver source";
  return null;
}

function checkWritePath(filePath: string, cwd: string): string | null {
  const hit = protectedPathLabel(normalizePath(filePath, cwd));
  return hit ? `BLOCK [write-path] ${hit} is human-merge-only` : null;
}

// Shell write vectors that bypass the Write/Edit tool: redirections and write commands.
// A pure redirection operator token (target is the next token): >, >>, >|, 2>, 1>>,
// &>, &>>, >& (bash redirect-both forms). `&` may lead (&>) or trail (>&) the >.
const REDIR_OP_RE = /^&?[0-9]*>>?&?\|?$/;
// A redirection glued to its target: >file, 2>>file, &>file, >&file (target captured).
const REDIR_GLUED_RE = /^&?[0-9]*>>?&?\|?(.+)$/;
// Commands that create/modify/delete a file at a path argument (write or destructive).
// `touch` is here for #81: it's the most direct way to forge the PAUSE/KILL_SWITCH sentinels.
const WRITE_CMDS = new Set(["tee", "dd", "sed", "perl", "cp", "install", "mv", "rm", "git", "touch"]);

/** Evaluate one write/destructive command's path args; return a block reason or null. */
function writeCmdTarget(cmd: string, args: string[], cwd: string): string | null {
  const hitFor = (t: string): string | null => protectedPathLabel(normalizePath(t, cwd));
  const nonFlag = args.filter((a) => !a.startsWith("-"));
  const blockAny = (verb: string): string | null => {
    for (const a of nonFlag) {
      const h = hitFor(a);
      if (h) return `BLOCK [write-path] ${verb} ${h} is human-merge-only`;
    }
    return null;
  };

  if (cmd === "dd") {
    for (const a of args)
      if (a.startsWith("of=")) {
        const h = hitFor(a.slice(3));
        if (h) return `BLOCK [write-path] dd writes ${h} is human-merge-only`;
      }
    return null;
  }
  if (cmd === "sed" || cmd === "perl") {
    const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place"));
    return inPlace ? blockAny(`${cmd} -i edits`) : null;
  }
  // touch creates (#81: the most direct way to forge a sentinel file).
  if (cmd === "touch") return blockAny("touch creates");
  // rm deletes, and mv moving a boundary file away deletes it from its location — so for
  // both, ANY protected path arg (source or dest) is blocked.
  if (cmd === "rm") return blockAny("rm deletes");
  if (cmd === "mv") return blockAny("mv writes/moves");
  // git subcommands that delete/rewrite a working-tree path: rm, mv, restore, checkout
  // (e.g. `git checkout HEAD^ -- .github/workflows/ci.yml`, `git restore -- guard.ts`).
  if (cmd === "git") {
    const sub = nonFlag[0]?.toLowerCase();
    if (sub === "rm" || sub === "mv" || sub === "restore" || sub === "checkout") {
      for (const a of nonFlag.slice(1)) {
        const h = hitFor(a);
        if (h) return `BLOCK [write-path] git ${sub} ${h} is human-merge-only`;
      }
    }
    return null;
  }
  if (cmd === "cp" || cmd === "install") {
    // cp/install only WRITE the destination (reading a protected source is harmless).
    let dest: string | undefined;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if ((a === "-t" || a === "--target-directory") && k + 1 < args.length) dest = args[k + 1];
      else if (a.startsWith("--target-directory=")) dest = a.slice("--target-directory=".length);
      else if (a.startsWith("-t") && a.length > 2) dest = a.slice(2);
    }
    if (dest === undefined) dest = nonFlag[nonFlag.length - 1];
    if (dest) {
      const h = hitFor(dest);
      if (h) return `BLOCK [write-path] ${cmd} writes ${h} is human-merge-only`;
    }
    return null;
  }
  // tee: every non-flag arg is a write target
  return blockAny("tee writes");
}

/**
 * #1079 (was #81's CONTROL_SENTINEL_RE-specific check): a `.sapwood/**` path appearing as a
 * literal argument to ANY command — not just the recognized WRITE_CMDS verbs. A worker has no
 * legitimate reason to reference the runtime root at all, so mere appearance is enough. This
 * closes the `node some-script.js ../../.sapwood/PAUSE`-style indirection where the script's own
 * write is opaque to the guard but the path argument on the Bash command line is not. (A script
 * that hardcodes the path internally, with no CLI argument, remains an open residual — see
 * docs/security.md's isolation-boundary note.) One caveat this scan inherits from being
 * cwd-relative: a session whose OWN cwd already sits under `.sapwood/` (e.g. a materialized
 * review tree) would see every bare relative token match here, command word included — this
 * function's scope is the worker's own worktree-relative Bash usage, not a session dispatched
 * with its cwd already inside the protected root.
 */
function checkControlSentinelArg(tokens: string[], cwd: string): string | null {
  for (const t of tokens) {
    if (!t) continue;
    // A flag can glue the path to its value (`--target=../../.sapwood/PAUSE`) — judge the
    // substring after the first `=` for `-`-prefixed tokens (#84 gate② P2-2, carried forward).
    const candidate = t.startsWith("-") ? (t.includes("=") ? t.slice(t.indexOf("=") + 1) : null) : t;
    if (!candidate) continue;
    const abs = normalizePath(candidate, cwd);
    if (isUnderSapwoodRoot(abs)) {
      return `BLOCK [write-path] ${protectedPathLabel(abs)} referenced as a command argument`;
    }
  }
  return null;
}

// ── #731: sapwood pause/stop/estop CLI verbs — same control-sentinel boundary as the check
// above; they resolve the sentinel path INTERNALLY, so checkControlSentinelArg never sees it —
// the reason this function exists. Scope: the three stop-control verbs only, by design (park/
// run/status/events stay out of scope) — see docs/security.md.
const STOP_CONTROL_VERBS = new Set(["pause", "stop", "estop"]);

/** Matches the sapwood CLI entrypoint by basename: the `sapwood` binary, `cli.js`/`cli.ts`
 *  (source or dist). Also matches an `npx`-style `sapwood@<version>` package spec. */
function isSapwoodCliEntrypoint(tok: string): boolean {
  const base = basename(tok).toLowerCase();
  return base === "sapwood" || base === "cli.js" || base === "cli.ts" || base.startsWith("sapwood@");
}

/** BLOCKs when a sapwood-CLI-entrypoint token is immediately followed by one of the three
 *  stop-control verbs — mirrors cli.ts's own argv[2] contract; a flag between would over-match. */
function checkStopControlVerb(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!isSapwoodCliEntrypoint(tokens[i]!)) continue;
    const verb = tokens[i + 1]!;
    if (STOP_CONTROL_VERBS.has(verb)) {
      return (
        `BLOCK [stop-control] sapwood ${verb} is a control-sentinel CLI verb (same boundary as ` +
        `.sapwood/**) — human-merge-only, see ${DOC_LINKS.security}`
      );
    }
  }
  return null;
}

/**
 * Detect a Bash command writing to a boundary file. Redirections and write commands are
 * scanned at ANY position (not just token[0]) so a wrapper (`uv run --with rich tee X`)
 * can't hide the write. Quoted data stays a single token, so it can't masquerade.
 */
function checkBashWritePath(tokens: string[], cwd: string): string | null {
  const hitFor = (t: string): string | null => protectedPathLabel(normalizePath(t, cwd));

  // 1. redirections: `cmd > path`, `cmd >>path`, `cmd &> path`, `cmd >| path` ...
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (REDIR_OP_RE.test(tok)) {
      const target = tokens[i + 1];
      if (target) {
        const h = hitFor(target);
        if (h) return `BLOCK [write-path] shell redirect to ${h} is human-merge-only`;
      }
    } else if (tok.includes(">")) {
      const m = REDIR_GLUED_RE.exec(tok);
      // biome-ignore lint/complexity/useOptionalChain: explicit regex match guard preserves the narrowed capture.
      if (m && m[1]) {
        const h = hitFor(m[1]);
        if (h) return `BLOCK [write-path] shell redirect to ${h} is human-merge-only`;
      }
    }
  }

  // 2. write commands at any position
  for (let i = 0; i < tokens.length; i++) {
    const cmd = basename(tokens[i]!).toLowerCase();
    if (!WRITE_CMDS.has(cmd)) continue;
    const r = writeCmdTarget(cmd, tokens.slice(i + 1), cwd);
    if (r) return r;
  }
  return null;
}

// ── Read-path containment (#235 PR-A) ────────────────────────────────────────
// Phase-0 finding (issue #235): a real `claude -p --worktree` peripheral session's Read
// tool is NOT confined to its worktree — GUARDED_TOOLS in guard-hook.ts never included
// Read, so the guard never even saw the call, and `/etc/hosts` / `../`-traversal reads to
// arbitrary host files both succeeded (permission_denials: []). Real FS isolation would
// need `--bare`, which disables hooks entirely — ruled out for production dispatch
// (docs/security.md "Benchmark isolation recipe"). So containment has to be this guard's
// job, the same way Write/Edit boundary-file protection already is.
//
// Read/Grep/Glob/NotebookRead all resolve to a single filesystem target: Read's `file_path`
// and NotebookRead's `notebook_path` (both required — a call with no path can't be verified,
// so it fails closed below); Grep/Glob's `path` (optional, Claude Code itself defaults an
// absent one to cwd — see each tool's documented input shape). NotebookRead joined this set
// (PM review of PR-A) for the same reason Read/Grep/Glob did: it is a built-in read-family
// tool that reads an arbitrary file path (a `.ipynb`), and #235's own thesis is a complete
// boundary, not one that relies on allowlist-absence — omitting it would leave an
// inconsistent "why is this tool special" hole. Resolve the target against `cwd` with the
// SAME normalizePath helper the write-path check uses, then require it to sit at-or-under
// the worktree root — mirroring the exact containment check peripheral.ts's scratchFile
// logic already uses (`target === root || target.startsWith(root + sep)`), just expressed
// over normalizePath's forward-slash-normalized absolute paths instead of node:path's
// `resolve`/`sep`.
const READ_CONTAINED_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/**
 * worktreeRoot is undefined when the engine didn't tell us where the worktree is — which
 * only happens for a session the engine did not spawn (e.g. a human running `claude`
 * directly against this repo). The engine ALWAYS sets SAPWOOD_WORKTREE_ROOT for every
 * dispatched session (worker.ts's dispatch()/resume(), peripheral.ts's RoleRunner.run()),
 * the same unconditional way it always sets SAPWOOD_GUARD_MODE. So "unset" is read as "not
 * an engine-dispatched session," never as "an engine session that lost its containment" —
 * deliberately mirroring how the guard already treats a human-run, non-engine `claude`
 * process (SAPWOOD_GUARD_MODE unset still resolves safely to "hard" in guard-hook.ts, but
 * there is no lane/worktree convention to confine such a session to in the first place).
 * Containment INACTIVE here means Read/Grep/Glob/NotebookRead fall through to ALLOW, same as they were
 * before this change — a deliberate, additive-only widening of what's checked, not a
 * default-deny flip for non-engine usage.
 */
function checkReadContainment(tool: string, input: GuardInput, cwd: string, worktreeRoot: string | undefined): Decision | null {
  if (!READ_CONTAINED_TOOLS.has(tool)) return null;
  if (!worktreeRoot) return null; // containment inactive: no engine-supplied worktree root

  const rawTarget = tool === "Read" ? input.file_path : tool === "NotebookRead" ? input.notebook_path : (input.path ?? cwd);
  if (!rawTarget) {
    // Read's file_path / NotebookRead's notebook_path are required; a missing one means the
    // guard can't verify containment at all — fail closed rather than silently allow (same
    // stance as guard-hook.ts's GUARDED_TOOLS malformed-tool_input branch, just enforced here
    // for the field-level case a valid-but-incomplete tool_input object doesn't trip at the
    // hook layer).
    return block(`BLOCK [fail-closed] ${tool} with missing path — cannot verify worktree containment`);
  }

  const root = normalizePath(worktreeRoot, cwd);
  const target = normalizePath(rawTarget, cwd);
  if (target === root || target.startsWith(`${root}/`)) return null; // inside -> fall through to ALLOW
  return block(`BLOCK [read-containment] ${tool} path escapes the session worktree: ${rawTarget}`);
}

// ── public API ───────────────────────────────────────────────────────────────
// #620: NotebookEdit is write-family — its path field is `notebook_path`, not `file_path`
// (see guardDecision's fp pick below); the matcher (worker.ts guardSettings) and
// guard-hook.ts's GUARDED_TOOLS carry it too, or this entry would never be consulted.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The PreToolUse safety decision. Pure & deterministic — worktreeRoot/defaultBranch are plain
 * string arguments (never read from env inside this function; guard-hook.ts's IO layer reads
 * SAPWOOD_WORKTREE_ROOT/SAPWOOD_DEFAULT_BRANCH and threads them in). Bash commands are guarded
 * for opaque constructs + gh overreach + (#679, when defaultBranch is given) raw git-transport
 * pushes reaching it; Write/Edit/MultiEdit/NotebookEdit are guarded for boundary files; Read/
 * Grep/Glob/NotebookRead are guarded for worktree containment (#235 PR-A) when a worktreeRoot
 * is known; every other tool is allowed.
 */
export function guardDecision(tool: string, input: GuardInput, cwd: string, worktreeRoot?: string, defaultBranch?: string): Decision {
  if (WRITE_TOOLS.has(tool)) {
    const fp = (tool === "NotebookEdit" ? input.notebook_path : input.file_path) ?? "";
    if (fp) {
      const r = checkWritePath(fp, cwd);
      if (r) return block(r);
    }
    return ALLOW;
  }
  const readBlock = checkReadContainment(tool, input, cwd, worktreeRoot);
  if (readBlock) return readBlock;
  if (tool !== "Bash") return ALLOW;
  const command = input.command ?? "";
  for (const frag of splitFragments(command)) {
    const reason = judgeFragment(frag, cwd, 0, defaultBranch ?? "");
    if (reason) return block(reason);
  }
  return ALLOW;
}
