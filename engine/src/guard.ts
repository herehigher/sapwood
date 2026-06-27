// Fail-closed PreToolUse safety guard — the structural enforcement of
// producer ≠ reviewer ≠ merger. Pure function: zero IO, zero deps, deterministic.
//
// Ported from 0day's guard.py (backend/src/zeroday/loop/guard.py). We port the *generic
// safety mechanism* — command tokenizing, fragment splitting, exec-prefix stripping,
// opaque-construct fail-closed detection, and the gh-overreach category (the worker, a
// PR *producer*, must never merge/approve/release) — plus a Write-path protection for the
// guard's own boundary files. 0day's trading-domain categories (on-chain funds, private
// keys) are intentionally NOT ported (CLAUDE.md: "port the logic, not the trading domain").
//
// Decision order for a Bash command:
//   1. split into fragments by shell chain operators; $()/`` substitutions recurse.
//   2. per fragment: strip env-assignments + exec wrappers (env/uv/npx/...).
//   3. opaque constructs (eval / shell -c / interpreter -e / process substitution) =>
//      BLOCK fail-closed (a worker could hide anything inside them).
//   4. gh-overreach semantic check.
// For Write/Edit tools: deny writes to the guard's boundary files.

export interface Decision {
  readonly allow: boolean;
  readonly reason: string; // BLOCK names the category + hit; ALLOW is "".
}

const ALLOW: Decision = Object.freeze({ allow: true, reason: "" });
const block = (reason: string): Decision => Object.freeze({ allow: false, reason });

export interface GuardInput {
  // Claude Code tool_input shape (only the fields the guard reads).
  command?: string; // Bash
  file_path?: string; // Write / Edit / MultiEdit
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
const UV_FLAGS_WITH_VALUE = new Set([
  "--directory", "--project", "--python", "--extra", "--package", "-p",
]);

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
  let tokens = stripLeadingAssignments(tokensIn);
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
const ALLOWED_DELETE_PATH_RE = /\/git\/refs/i;
const FIELD_FLAGS = new Set(["-f", "--field", "-F", "--raw-field"]);
// gh api flags that consume the NEXT token as their value — must be skipped so the value
// isn't mistaken for the endpoint (e.g. `gh api --hostname HOST graphql ...`).
const GH_API_VALUE_FLAGS = new Set([
  "--hostname", "-H", "--header", "--input", "--cache", "--jq", "-q", "--template", "-t",
]);

function ghSkipGlobalFlags(tokens: string[]): string[] {
  const withValue = new Set(["-R", "--repo"]);
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (!tok.startsWith("-")) break;
    if (tok.includes("=")) { i += 1; continue; }
    if (withValue.has(tok)) { i += 2; continue; }
    i += 1;
  }
  return tokens.slice(i);
}

function checkGhApi(tokens: string[], fragment: string): string | null {
  let method: string | null = null;
  let hasField = false;
  let hasInput = false; // gh defaults to POST when --input is given (cli/cli api.go)
  let pathToken: string | null = null;
  let i = 2;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if ((tok === "-X" || tok === "--method") && i + 1 < tokens.length) { method = tokens[i + 1]!.toUpperCase(); i += 2; continue; }
    if (tok.startsWith("--method=") || tok.startsWith("-X=")) { method = tok.split("=", 2)[1]!.toUpperCase(); i += 1; continue; }
    if (tok.startsWith("-X") && tok.length > 2 && tok[2] !== "=") { method = tok.slice(2).toUpperCase(); i += 1; continue; }
    if (tok === "--input" || tok.startsWith("--input=")) { hasInput = true; i += tok === "--input" ? 2 : 1; continue; }
    if (FIELD_FLAGS.has(tok)) {
      hasField = true;
      i += 1;
      if (i < tokens.length && !tokens[i]!.startsWith("-")) i += 1;
      continue;
    }
    for (const ff of FIELD_FLAGS) {
      if (tok.startsWith(ff + "=") || (ff.length === 2 && tok.startsWith(ff) && tok.length > ff.length)) { hasField = true; break; }
    }
    // value-taking flag (e.g. --hostname HOST): skip flag + value so HOST isn't the endpoint
    if (GH_API_VALUE_FLAGS.has(tok)) { i += 2; continue; }
    if (!tok.startsWith("-") && pathToken === null) pathToken = tok;
    i++;
  }
  if (method === null && (hasField || hasInput)) method = "POST";

  if (pathToken && pathToken.toLowerCase().replace(/^\/+|\/+$/g, "") === "graphql") {
    const fieldValues: string[] = [];
    let j = 2;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (FIELD_FLAGS.has(t)) {
        if (j + 1 < tokens.length) { fieldValues.push(tokens[j + 1]!); j += 2; } else j += 1;
        continue;
      }
      for (const ff of FIELD_FLAGS) {
        if (t.startsWith(ff + "=")) { fieldValues.push(t.split("=", 2)[1]!); break; }
        if (ff.length === 2 && t.startsWith(ff) && t.length > ff.length) { fieldValues.push(t.slice(ff.length)); break; }
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
  if (method === "DELETE" && pathToken && ALLOWED_DELETE_PATH_RE.test(pathToken)) return null;
  if (pathToken && SENSITIVE_PATH_RE.test(pathToken)) {
    return pathToken.toLowerCase().includes("/releases") ? `BLOCK [gh] api mutates releases: ${pathToken}` : `BLOCK [gh] api mutates PR merge: ${pathToken}`;
  }
  for (const m of fragment.matchAll(new RegExp(SENSITIVE_PATH_RE, "gi"))) {
    return m[0]!.toLowerCase().includes("/releases") ? "BLOCK [gh] api mutates releases" : "BLOCK [gh] api mutates PR merge";
  }
  return null;
}

function checkCategoryC(tokens: string[], fragment: string): string | null {
  if (tokens.length < 2 || basename(tokens[0]!).toLowerCase() !== "gh") return null;
  const remaining = ghSkipGlobalFlags(tokens);
  if (remaining.length === 0) return null;
  const sub1 = remaining[0]!.toLowerCase();
  if (sub1 === "pr" && remaining.length >= 2) {
    const sub2 = remaining[1]!.toLowerCase();
    if (sub2 === "merge") return "BLOCK [gh] pr merge — producer must not merge";
    if (sub2 === "ready") return "BLOCK [gh] pr ready — producer must not promote its own PR";
    // producer ≠ reviewer: a worker must not approve / request-changes (gate② is a fresh
    // non-author review). A plain `gh pr review --comment` is fine.
    if (sub2 === "review" && remaining.some((t) => t === "--approve" || t === "-a" || t === "--request-changes")) {
      return "BLOCK [gh] pr review --approve/--request-changes — producer must not review (producer≠reviewer)";
    }
  }
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
function judgeFragment(fragment: string, cwd: string, depth = 0): string | null {
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
    if (inner !== null) return judgeFragment(inner, cwd, depth + 1);
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

  // gh overreach, scanned at any position on both the stripped and the original tokens.
  return scanGhOverreach(stripped) ?? scanGhOverreach(tokens);
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

const PROTECTED_SUFFIXES = ["/engine/src/guard.ts", "/engine/src/guard-hook.ts", "/engine/src/reviewer.ts"];

/** If `abs` (a normalized absolute path) is a boundary file, return a short label; else null. */
function protectedPathLabel(abs: string): string | null {
  if (/\/\.claude\/settings(\.local)?\.json$/.test(abs)) return ".claude/settings.json (hook wiring)";
  if (/\/\.github\/workflows(\/|$)/.test(abs)) return ".github/workflows/** (CI integrity)";
  if (PROTECTED_SUFFIXES.some((s) => abs.endsWith(s))) return "guard/reviewer source";
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
const WRITE_CMDS = new Set(["tee", "dd", "sed", "perl", "cp", "install", "mv", "rm", "git"]);

/** Evaluate one write/destructive command's path args; return a block reason or null. */
function writeCmdTarget(cmd: string, args: string[], cwd: string): string | null {
  const hitFor = (t: string): string | null => protectedPathLabel(normalizePath(t, cwd));
  const nonFlag = args.filter((a) => !a.startsWith("-"));
  const blockAny = (verb: string): string | null => {
    for (const a of nonFlag) { const h = hitFor(a); if (h) return `BLOCK [write-path] ${verb} ${h} is human-merge-only`; }
    return null;
  };

  if (cmd === "dd") {
    for (const a of args) if (a.startsWith("of=")) { const h = hitFor(a.slice(3)); if (h) return `BLOCK [write-path] dd writes ${h} is human-merge-only`; }
    return null;
  }
  if (cmd === "sed" || cmd === "perl") {
    const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place"));
    return inPlace ? blockAny(`${cmd} -i edits`) : null;
  }
  // rm deletes, and mv moving a boundary file away deletes it from its location — so for
  // both, ANY protected path arg (source or dest) is blocked.
  if (cmd === "rm") return blockAny("rm deletes");
  if (cmd === "mv") return blockAny("mv writes/moves");
  // git rm / git mv stage destructive changes to the boundary.
  if (cmd === "git") {
    const sub = nonFlag[0]?.toLowerCase();
    if (sub === "rm" || sub === "mv") {
      for (const a of nonFlag.slice(1)) { const h = hitFor(a); if (h) return `BLOCK [write-path] git ${sub} ${h} is human-merge-only`; }
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
    if (dest) { const h = hitFor(dest); if (h) return `BLOCK [write-path] ${cmd} writes ${h} is human-merge-only`; }
    return null;
  }
  // tee: every non-flag arg is a write target
  return blockAny("tee writes");
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
      if (target) { const h = hitFor(target); if (h) return `BLOCK [write-path] shell redirect to ${h} is human-merge-only`; }
    } else if (tok.includes(">")) {
      const m = REDIR_GLUED_RE.exec(tok);
      if (m && m[1]) { const h = hitFor(m[1]); if (h) return `BLOCK [write-path] shell redirect to ${h} is human-merge-only`; }
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

// ── public API ───────────────────────────────────────────────────────────────
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * The PreToolUse safety decision. Pure & deterministic. Bash commands are guarded for
 * opaque constructs + gh overreach; Write/Edit are guarded for boundary files; every
 * other tool is allowed.
 */
export function guardDecision(tool: string, input: GuardInput, cwd: string): Decision {
  if (WRITE_TOOLS.has(tool)) {
    const fp = input.file_path ?? "";
    if (fp) {
      const r = checkWritePath(fp, cwd);
      if (r) return block(r);
    }
    return ALLOW;
  }
  if (tool !== "Bash") return ALLOW;
  const command = input.command ?? "";
  for (const frag of splitFragments(command)) {
    const reason = judgeFragment(frag, cwd);
    if (reason) return block(reason);
  }
  return ALLOW;
}
