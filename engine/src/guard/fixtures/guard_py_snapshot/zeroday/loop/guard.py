"""资金路径 PreToolUse 安全守卫（issue #149）。

纯函数，零 IO、零网络、零文件访问、无全局可变状态。
仅守卫 Bash 工具；其它工具一律放行。

判断顺序：
1. 非 Bash → 放行
2. 将命令按 shell 链接符拆片段；$() / 反引号 命令替换仍递归判定
3. 每个片段：
   a. 剥离前导环境赋值（NAME=value）及执行前缀（env/uv run/uvx/npx/poetry run）
   b. 不透明执行构造（fail-closed）：eval / shell -c / 解释器 -c -e / 进程替换 → BLOCK opaque
   c. 语义检查（类别 A/B/C）
4. 均无命中 → 放行
"""

from __future__ import annotations

import os
import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Decision:
    """裁决结果。frozen=True 防止消费方误改。"""

    allow: bool
    reason: str  # BLOCK 时须点名命中类别与片段；ALLOW 时可空


# ── 辅助：shlex 安全分词 ────────────────────────────────────────────────────────


def _safe_split(fragment: str) -> list[str]:
    """shlex 分词；解析失败降级为空格分割。"""
    try:
        return shlex.split(fragment)
    except ValueError:
        return fragment.split()


# ── 辅助：路径规范化 ────────────────────────────────────────────────────────────


def _normalize_path(token: str, cwd: str) -> str:
    """将 token 规范化为绝对路径（展开 ~，相对路径基于 cwd）。"""
    expanded = os.path.expanduser(token)
    if os.path.isabs(expanded):
        return os.path.normpath(expanded)
    return os.path.normpath(os.path.join(cwd, expanded))


# ── 辅助：命令替换提取（$() 与反引号，不含进程替换）──────────────────────────


def _extract_command_substitutions(text: str) -> list[str]:
    """递归提取 $(...) 与反引号 `...` 中的内嵌命令（不提取进程替换 <()/>(）。

    进程替换在片段层面直接 BLOCK opaque，无需提取内部。
    """
    results: list[str] = []

    # $(...) —— 支持嵌套括号
    i = 0
    while i < len(text):
        is_cmd_sub = text[i] == "$" and i + 1 < len(text) and text[i + 1] == "("
        if is_cmd_sub:
            paren_start = i + 1  # 指向 '('
            depth = 0
            j = paren_start
            while j < len(text):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        inner = text[paren_start + 1 : j]
                        results.append(inner)
                        results.extend(_extract_command_substitutions(inner))
                        break
                j += 1
        i += 1

    # 反引号 `...`（不支持嵌套，与 shell 行为一致）
    backtick_re = re.compile(r"`([^`]*)`")
    for m in backtick_re.finditer(text):
        inner = m.group(1)
        results.append(inner)
        results.extend(_extract_command_substitutions(inner))

    return results


# ── 辅助：片段拆分 ─────────────────────────────────────────────────────────────

# shell 链接符（不含命令替换括号，单独处理）
_CHAIN_RE = re.compile(r"&&|\|\||;|\||&|\n")


def _split_fragments(command: str) -> list[str]:
    """将命令按 shell 链接符和换行拆分，并附加 $() 命令替换内容（不含进程替换）。"""
    substitutions = _extract_command_substitutions(command)
    main_parts = _CHAIN_RE.split(command)
    all_fragments = main_parts + substitutions
    return [f.strip() for f in all_fragments if f.strip()]


# ── 执行前缀剥离 ────────────────────────────────────────────────────────────────

# shell 首词集合
_SHELL_CMDS = {"bash", "sh", "zsh", "dash", "ksh"}

# 解释器首词集合（python/node/perl/ruby/php）
_INTERPRETER_CMDS = {"python", "python3", "node", "perl", "ruby", "php"}

# 解释器代码求值标志（首词 → 触发 opaque 的 flag 集合）
_INTERPRETER_EVAL_FLAGS: dict[str, set[str]] = {
    "python": {"-c"},
    "python3": {"-c"},
    "perl": {"-e"},
    "ruby": {"-e"},
    "php": {"-r"},
    "node": {"-e", "--eval"},
}


def _skip_wrapper_flags(tokens: list[str]) -> list[str]:
    """跳过包装器（如 uv run / poetry run）自身的标志，返回真实命令起始的 tokens。

    规则：
    - 以 `-` 开头的 token 视为包装器标志
    - `--flag value`（flag 以 `-` 开头，value 不以 `-` 开头）：连同 value 一并跳过
    - `--flag=value`（含 `=`）：只跳过该 token
    - 遇到不以 `-` 开头的 token 即认为是真实命令，停止跳过
    注意：`-m`/`--module` 不是 uv 自身 flag，遇到后停止（保留给解释器使用）。
    """
    # uv run 自身的带值标志（跳过 flag + value）
    _UV_FLAGS_WITH_VALUE = {
        "--directory",
        "--project",
        "--python",
        "--extra",
        "--all-extras",
        "--package",
        "-p",
    }
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-"):
            break  # 找到真实命令
        # -m / --module 是解释器标志，不是 uv 的，停止
        if tok in ("-m", "--module"):
            break
        if "=" in tok:
            # --flag=value 形式，只跳过自身
            i += 1
        elif (
            tok in _UV_FLAGS_WITH_VALUE
            and i + 1 < len(tokens)
            and not tokens[i + 1].startswith("-")
        ):
            # 带独立取值的 uv 标志：跳过标志及值
            i += 2
        else:
            # 纯标志（无取值）
            i += 1
    return tokens[i:]


def _strip_leading_assignments(tokens: list[str]) -> list[str]:
    """剥离前导环境赋值（NAME=value 形式），返回剩余 tokens。"""
    i = 0
    while i < len(tokens):
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i]):
            i += 1
        else:
            break
    return tokens[i:]


def _strip_exec_prefix(tokens: list[str]) -> list[str]:
    """剥离执行前缀，返回真实命令的 tokens。

    支持形式：
    - NAME=val ... <cmd>（前导环境赋值）
    - env [NAME=VAL ...] <cmd>
    - uv run [flags...] <cmd>
    - uvx <cmd>
    - npx <cmd>
    - poetry run [flags...] <cmd>
    - command/exec/nohup/builtin/time <cmd>（shell 命令前缀词，递归剥离）
    - stdbuf [-oL ...] <cmd>
    """
    if not tokens:
        return tokens

    # 先剥离前导赋值
    tokens = _strip_leading_assignments(tokens)
    if not tokens:
        return tokens

    first = tokens[0].lower()

    # uv run ... / poetry run ...
    if first in ("uv", "poetry") and len(tokens) >= 2 and tokens[1].lower() == "run":
        after_run = tokens[2:]
        return _skip_wrapper_flags(after_run)

    # uvx <cmd> / npx <cmd>
    if first in ("uvx", "npx"):
        return tokens[1:]

    # env [KEY=VAL ...] <cmd>
    if first == "env":
        i = 1
        # 跳过 env 自身的选项标志（如 -i）
        while i < len(tokens) and tokens[i].startswith("-"):
            i += 1
        # 跳过 KEY=VAL 赋值
        while i < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i]):
            i += 1
        return tokens[i:]

    # shell 命令前缀词（command/exec/nohup/builtin/time）：剥掉后跳过前缀词自身选项再递归
    # 例：command -p bash -c 'ls' → 跳过 -p → [bash, -c, ls]
    if first in ("command", "exec", "nohup", "builtin", "time"):
        rest = tokens[1:]
        # 跳过前缀词自身的选项标志（以 - 开头的 token，如 command -p / command -v）
        while rest and rest[0].startswith("-"):
            rest = rest[1:]
        if rest:
            return _strip_exec_prefix(rest)
        return rest

    # stdbuf 带 -oL 等选项，跳过所有以 - 开头的 token 再递归
    if first == "stdbuf":
        i = 1
        while i < len(tokens) and tokens[i].startswith("-"):
            i += 1
        rest = tokens[i:]
        if rest:
            return _strip_exec_prefix(rest)
        return rest

    return tokens


# ── 不透明执行构造检测 ──────────────────────────────────────────────────────────


def _check_opaque(tokens: list[str], fragment: str) -> str | None:
    """检查片段是否含不透明执行构造（fail-closed）。

    命中返回含 "opaque" 的 reason；否则返回 None。

    检测项（按序）：
    1. 进程替换 <( 或 >( 出现在原始 fragment 中
    2. shell 首词且选项含 -c（任意选项组合如 -lc/-ec/-o x -c）
    3. eval 首词
    4. 解释器首词且带代码求值标志（python -c / node -e / perl -e 等）

    注意：首词匹配均用 basename，覆盖 /bin/bash、/usr/bin/python 等绝对路径调用形式。
    """
    # 1. 进程替换（在原始 fragment 中直接检测）
    if re.search(r"[<>]\(", fragment):
        return "BLOCK [opaque] 进程替换 <(...) / >(...) 不透明执行构造"

    if not tokens:
        return None

    # 用 basename 规范化首词，覆盖 /bin/bash、/usr/bin/python 等路径前缀调用
    first_raw = tokens[0]
    first = os.path.basename(first_raw).lower()

    # 2. shell 包装器 + -c 选项
    if first in _SHELL_CMDS and _shell_has_dash_c(tokens):
        return f"BLOCK [opaque] {first_raw} -c 不透明 shell 包装器"

    # 3. eval
    if first == "eval":
        return "BLOCK [opaque] eval 不透明执行构造"

    # 4. 解释器 + 代码求值标志
    eval_flags = _INTERPRETER_EVAL_FLAGS.get(first)
    if eval_flags:
        for tok in tokens[1:]:
            # 长标志：--eval
            if tok in eval_flags:
                return f"BLOCK [opaque] {first_raw} {tok} 不透明代码求值"
            # 短标志紧贴：-etok（perl/ruby -ecode）— 取前两字符匹配
            if tok.startswith("-") and not tok.startswith("--") and len(tok) >= 2:
                short = tok[:2]
                if short in eval_flags:
                    return f"BLOCK [opaque] {first_raw} {tok} 不透明代码求值"

    return None


def _shell_has_dash_c(tokens: list[str]) -> bool:
    """判断 shell 命令的 tokens 中是否含 -c 选项（含任意选项组合及取值选项跳过）。

    规则：
    - -c、-lc、-ec、-lec、-xc 等短选项簇含 'c' → True
    - -O val / -o val / +O val / +o val / --rcfile val / --init-file val：
      这些带独立取值参数的选项，跳过取值后继续扫描
    - -- 结束选项解析后停止
    - 遇到非选项 token（不以 - 开头）→ 停止
    """
    _SHELL_VALUE_OPTS = {"-O", "+O", "-o", "+o", "--rcfile", "--init-file"}
    i = 1  # tokens[0] 是 shell 首词
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            break
        if tok in _SHELL_VALUE_OPTS:
            i += 2  # 跳过标志及其值
            continue
        if tok.startswith("-") and not tok.startswith("--") and "c" in tok[1:]:
            return True
        if not tok.startswith("-"):
            break
        i += 1
    return False


# ── 类别 A：资金 / 链上写 ───────────────────────────────────────────────────────

# 以太坊地址模式
_ETH_ADDR_RE = re.compile(r"\b0x[0-9a-fA-F]{40}\b")

# web3 CLI token
_WEB3_CLI_TOKENS = {"cast", "web3", "ethers"}

# 仅对这些"纯数据"命令豁免 withdraw/transfer 动词检查
_DATA_ONLY_CMDS = {"git", "gh", "echo", "printf"}

# 广播/签名关键词（fragment 级别，不区分大小写）
_BROADCAST_PATTERNS = [
    re.compile(r"\bcast\s+send\b", re.IGNORECASE),
    re.compile(r"\b--broadcast\b", re.IGNORECASE),
    re.compile(r"\beth_sendRawTransaction\b", re.IGNORECASE),
    re.compile(r"\bsendRawTransaction\b", re.IGNORECASE),
]


def _verb_in_quoted_regions_only(fragment: str, verb: str) -> bool:
    """检查 verb 是否仅出现在引号内（双引号或单引号）。

    用于豁免：`git commit -m "add withdraw button"` 中 withdraw 在引号内，不视为执行。
    """
    # 收集所有引号区间
    quoted_ranges: list[tuple[int, int]] = []
    in_quote: str | None = None
    start = 0
    for i, ch in enumerate(fragment):
        if in_quote is None:
            if ch in ('"', "'"):
                in_quote = ch
                start = i
        else:
            if ch == in_quote:
                quoted_ranges.append((start, i))
                in_quote = None

    verb_lower = verb.lower()
    frag_lower = fragment.lower()
    pos = 0
    while True:
        idx = frag_lower.find(verb_lower, pos)
        if idx == -1:
            break
        # 检查此次出现是否在引号区间内
        in_quotes = any(s <= idx <= e for s, e in quoted_ranges)
        if not in_quotes:
            return False  # 存在不在引号内的出现
        pos = idx + len(verb_lower)
    return True  # 所有出现均在引号内（或根本不出现）


def _check_category_a(fragment: str, tokens: list[str]) -> str | None:
    """类别 A 检查。命中返回 reason 字符串；否则返回 None。"""
    # 1. --mainnet 作为独立 token
    for tok in tokens:
        if tok == "--mainnet":
            return "BLOCK [类别A] --mainnet 链上主网标志"

    # 2. approve + 链上信号（优先于 broadcast 检查，确保 reason 含 approve 关键词）
    has_approve = any("approve" in tok.lower() for tok in tokens)
    if has_approve:
        has_onchain = bool(_ETH_ADDR_RE.search(fragment))
        if not has_onchain:
            has_onchain = any(tok.lower() in _WEB3_CLI_TOKENS for tok in tokens)
        if has_onchain:
            return "BLOCK [类别A] approve + 链上信号 (ETH地址/web3 CLI)"

    # 3. broadcast/sign
    for pat in _BROADCAST_PATTERNS:
        m = pat.search(fragment)
        if m:
            return f"BLOCK [类别A] broadcast/sign 操作: {m.group()}"

    # 4. withdraw / transfer 动词检查
    first_cmd = tokens[0].lower() if tokens else ""
    is_data_only = first_cmd in _DATA_ONLY_CMDS

    for verb in ("withdraw", "transfer"):
        verb_lower = verb.lower()
        frag_lower = fragment.lower()
        if verb_lower not in frag_lower:
            continue

        if is_data_only and _verb_in_quoted_regions_only(fragment, verb):
            # git/gh/echo/printf —— 动词只在引号内出现 → 纯数据，不 BLOCK
            continue

        # 任意命令形式下，扫描 tokens 中的 -m / --module 后跟模块路径；
        # 覆盖 python -m、uv run <任意flag> -m、uv run --wrapper -m 等所有变体
        for mi, tok in enumerate(tokens):
            if tok in ("-m", "--module") and mi + 1 < len(tokens):
                module_path = tokens[mi + 1].lower()
                # 按 . / _ / - 拆分模块路径各段，查 withdraw/transfer 动词
                for segment in re.split(r"[._\-]", module_path):
                    if segment == verb_lower:
                        return f"BLOCK [类别A] {verb} 命中 -m 模块路径: {tokens[mi + 1]!r}"

        # 检查 token 层面：动词是否作为命令名/脚本名/非引号参数出现
        for tok in tokens:
            tok_lower = tok.lower()
            if tok_lower == verb_lower:
                return f"BLOCK [类别A] {verb} 命中 token: {tok!r}"
            base_orig = os.path.basename(tok)
            name_no_ext_orig = os.path.splitext(base_orig)[0]
            if _verb_is_word_in_name(name_no_ext_orig, verb_lower):
                return f"BLOCK [类别A] {verb} 命中脚本名: {tok!r}"
            if "/" not in tok and "\\" not in tok:
                name_no_ext_lower = os.path.splitext(tok_lower)[0]
                if _verb_is_word_in_name(name_no_ext_lower, verb_lower):
                    return f"BLOCK [类别A] {verb} 命中 token: {tok!r}"

    return None


def _verb_is_word_in_name(name: str, verb: str) -> bool:
    """检查 verb 是否作为完整单词分量出现在 name 中。

    支持的分隔符：下划线（_）、连字符（-）、驼峰大小写交界。
    verb 为小写；name 保留原始大小写（用于驼峰拆分）。
    """
    verb_lower = verb.lower()
    # 按驼峰拆分：在小写→大写转换处插入 _，再统一小写
    camel_split = re.sub(r"([a-z])([A-Z])", r"\1_\2", name).lower()
    snake = camel_split.replace("-", "_")
    parts = [p for p in snake.split("_") if p]
    return verb_lower in parts


# ── 类别 B：私钥 / 助记词文件 ──────────────────────────────────────────────────

_PRIVKEY_BASENAME_PATTERNS = [
    re.compile(r"private_key", re.IGNORECASE),
    re.compile(r"privatekey", re.IGNORECASE),
    re.compile(r"privkey", re.IGNORECASE),
    re.compile(r"mnemonic", re.IGNORECASE),
    re.compile(r"keystore", re.IGNORECASE),
    re.compile(r"\.key$", re.IGNORECASE),
    re.compile(r"^wallet.*\.json$", re.IGNORECASE),
    re.compile(r"seed.*phrase", re.IGNORECASE),
]

_ENV_WHITELIST = {".env"}


def _matches_privkey_pattern(path: str) -> str | None:
    """检查路径是否匹配私钥模式。命中返回匹配到的关键词；否则 None。"""
    basename = os.path.basename(path)
    if basename.lower() in _ENV_WHITELIST:
        return None

    parts = [p for p in path.replace("\\", "/").split("/") if p]
    for part in reversed(parts):
        for pat in _PRIVKEY_BASENAME_PATTERNS:
            if pat.search(part):
                return part
    return None


def _check_category_b(tokens: list[str], cwd: str) -> str | None:
    """类别 B 检查。命中返回 reason 字符串；否则返回 None。"""
    for tok in tokens:
        # --flag=value 形式：提取 value 部分作为路径检查
        if tok.startswith("-") and "=" in tok:
            value = tok.split("=", 1)[1]
            if value:
                abs_path = _normalize_path(value, cwd)
                hit = _matches_privkey_pattern(abs_path)
                if hit is None:
                    hit = _matches_privkey_pattern(value)
                if hit:
                    return f"BLOCK [类别B] 私钥/助记词文件路径命中: {hit}"
            continue
        # 纯标志（无 =）直接跳过
        if tok.startswith("-"):
            continue
        abs_path = _normalize_path(tok, cwd)
        hit = _matches_privkey_pattern(abs_path)
        if hit is None:
            hit = _matches_privkey_pattern(tok)
        if hit:
            return f"BLOCK [类别B] 私钥/助记词文件路径命中: {hit}"
    return None


# ── 类别 C：gh 越权状态变更 ────────────────────────────────────────────────────


def _gh_skip_global_flags(tokens: list[str]) -> tuple[list[str], int]:
    """跳过 gh 的全局标志，返回去掉全局标志后的 tokens 和起始偏移量。"""
    _FLAGS_WITH_VALUE = {"-R", "--repo"}
    i = 1  # tokens[0] 是 "gh"
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-"):
            break
        if "=" in tok:
            i += 1
            continue
        if tok in _FLAGS_WITH_VALUE:
            i += 2
            continue
        i += 1
    return tokens[i:], i


def _check_category_c(tokens: list[str], fragment: str) -> str | None:
    """类别 C 检查。命中返回 reason 字符串；否则返回 None。"""
    if not tokens:
        return None

    if tokens[0].lower() != "gh":
        return None

    if len(tokens) < 2:
        return None

    # 跳过 gh 全局标志（-R/--repo 等），定位真正的子命令
    remaining, _ = _gh_skip_global_flags(tokens)
    if not remaining:
        return None

    sub1 = remaining[0].lower()

    # gh pr merge / gh pr ready
    if sub1 == "pr" and len(remaining) >= 2:
        sub2 = remaining[1].lower()
        if sub2 == "merge":
            return "BLOCK [类别C] gh pr merge 越权状态变更"
        if sub2 == "ready":
            return "BLOCK [类别C] gh pr ready 越权状态变更"

    # gh release
    if sub1 == "release":
        return "BLOCK [类别C] gh release 越权操作"

    # gh api
    if sub1 == "api":
        api_tokens = [tokens[0], *list(remaining)]
        return _check_gh_api(api_tokens, fragment)

    return None


# mutating HTTP methods
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# 路径中的变更敏感端点
_SENSITIVE_PATH_RE = re.compile(
    r"/pulls/[^/]+/merge|/releases",
    re.IGNORECASE,
)

# 允许的 DELETE 豁免路径（git refs / 分支清理）
_ALLOWED_DELETE_PATH_RE = re.compile(
    r"/git/refs",
    re.IGNORECASE,
)


def _check_gh_api(tokens: list[str], fragment: str) -> str | None:
    """检查 `gh api ...` 是否为变更敏感操作。"""
    method: str | None = None
    has_field_flag = False
    path_token: str | None = None

    _FIELD_FLAGS = {"-f", "--field", "-F", "--raw-field"}

    i = 2  # 从 gh api 之后开始
    while i < len(tokens):
        tok = tokens[i]

        # 方法标志归一化（空格分隔、等号连写、短标志紧贴）
        if tok in ("-X", "--method") and i + 1 < len(tokens):
            method = tokens[i + 1].upper()
            i += 2
            continue
        if tok.startswith("--method=") or tok.startswith("-X="):
            val = tok.split("=", 1)[1]
            method = val.upper()
            i += 1
            continue
        if tok.startswith("-X") and len(tok) > 2 and tok[2] != "=":
            method = tok[2:].upper()
            i += 1
            continue

        # 字段标志归一化
        if tok in _FIELD_FLAGS:
            has_field_flag = True
            i += 1
            if i < len(tokens) and not tokens[i].startswith("-"):
                i += 1
            continue
        for ff in _FIELD_FLAGS:
            if tok.startswith(ff + "=") or (
                len(ff) == 2 and tok.startswith(ff) and len(tok) > len(ff)
            ):
                has_field_flag = True
                break

        # 路径 token
        if not tok.startswith("-") and path_token is None:
            path_token = tok
        i += 1

    if method is None and has_field_flag:
        method = "POST"

    # gh api graphql：检查 GraphQL mutation
    if path_token and path_token.lower().strip("/") == "graphql":
        field_values: list[str] = []
        j = 2
        while j < len(tokens):
            t = tokens[j]
            if t in _FIELD_FLAGS:
                if j + 1 < len(tokens):
                    field_values.append(tokens[j + 1])
                    j += 2
                else:
                    j += 1
                continue
            for ff in _FIELD_FLAGS:
                if t.startswith(ff + "="):
                    field_values.append(t.split("=", 1)[1])
                    break
                if len(ff) == 2 and t.startswith(ff) and len(t) > len(ff):
                    field_values.append(t[len(ff) :])
                    break
            j += 1

        # 文件引用（@file）形式：内容不可见，无法验证非 mutation → fail-closed BLOCK
        # field_values 元素形如 "key=value" 或 "value"（直接赋值），提取等号后半段判断
        def _is_file_ref(v: str) -> bool:
            val = v.split("=", 1)[1] if "=" in v else v
            return val.startswith("@")

        if any(_is_file_ref(v) for v in field_values):
            return (
                "BLOCK [类别C] gh api graphql @文件引用不可见，不可验证非 mutation（fail-closed）"
            )

        has_mutation = any("mutation" in v.lower() for v in field_values)
        if not has_mutation:
            has_mutation = bool(re.search(r"\bmutation\b", fragment, re.IGNORECASE))

        if has_mutation:
            return "BLOCK [类别C] gh api graphql mutation 变更操作"

        return None

    # 无变更方法 → 放行
    if method not in _MUTATING_METHODS:
        return None

    # DELETE on /git/refs → 豁免
    if method == "DELETE" and path_token and _ALLOWED_DELETE_PATH_RE.search(path_token):
        return None

    # 检查敏感路径
    if path_token and _SENSITIVE_PATH_RE.search(path_token):
        if "/releases" in path_token.lower():
            return f"BLOCK [类别C] gh api 变更 releases 路径: {path_token}"
        return f"BLOCK [类别C] gh api 变更 PR merge 路径: {path_token}"

    for m in _SENSITIVE_PATH_RE.finditer(fragment):
        hit = m.group()
        if "/releases" in hit.lower():
            return "BLOCK [类别C] gh api 变更 releases 路径"
        return "BLOCK [类别C] gh api 变更 PR merge 路径"

    return None


# ── 单片段裁决 ─────────────────────────────────────────────────────────────────


def _extract_env_split_string(tokens: list[str]) -> str | None:
    """从 env 命令的 tokens 中提取 -S/--split-string 的字符串参数。

    支持形式：
    - env -S 'cmd string'      → tokens[2] = 'cmd string'
    - env -S'cmd string'       → tokens[1] = '-Scmd string'（紧贴）
    - env --split-string=cmd   → tokens[1] = '--split-string=cmd'
    - env --split-string cmd   → tokens[2] = 'cmd'
    返回字符串参数或 None。
    """
    if not tokens or tokens[0].lower() != "env":
        return None
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        # --split-string=value 或 --split-string value
        if tok == "--split-string":
            if i + 1 < len(tokens):
                return tokens[i + 1]
            return None
        if tok.startswith("--split-string="):
            return tok[len("--split-string=") :]
        # -S value（独立参数）
        if tok == "-S":
            if i + 1 < len(tokens):
                return tokens[i + 1]
            return None
        # -Svalue（紧贴，无空格）
        if tok.startswith("-S") and len(tok) > 2 and not tok.startswith("-S="):
            return tok[2:]
        # -S=value（带等号紧贴）
        if tok.startswith("-S=") and len(tok) > 3:
            return tok[3:]
        # 其他 env 选项：单字母标志继续扫描，遇到非标志/KEY=VAL 停止
        if tok.startswith("-"):
            i += 1
            continue
        # 非标志、非赋值：已到命令区，不含 -S
        break
    return None


def _judge_fragment(fragment: str, cwd: str, depth: int = 0) -> str | None:
    """裁决单个 shell 片段。命中 → reason 字符串；放行 → None。深度上限防止无限递归。"""
    if depth > 8:
        return None

    tokens = _safe_split(fragment)
    if not tokens:
        return None

    # 步骤 0：首词 basename 归一化（/usr/bin/gh → gh，/bin/bash → bash）
    # 仅替换首词，参数保留原样；类别 B 私钥路径检测走 tokens[1:]，不受影响
    if tokens and os.sep in tokens[0]:
        tokens = [os.path.basename(tokens[0]), *tokens[1:]]

    # 步骤 0b：env -S/--split-string 拆分串递归判定
    # coreutils env 的 -S 把字符串拆成命令执行，必须递归内层以防绕过
    if tokens and tokens[0].lower() == "env":
        inner = _extract_env_split_string(tokens)
        if inner is not None:
            return _judge_fragment(inner, cwd, depth + 1)

    # 步骤 1：剥离执行前缀（env/uv run/uvx/npx/poetry run/前导赋值）
    stripped = _strip_exec_prefix(tokens)

    # 步骤 2：不透明执行构造 fail-closed（在语义检查之前）
    # 对原始 tokens 检测进程替换（fragment 层面），对剥离后 tokens 检测 shell/eval/解释器
    r = _check_opaque(stripped, fragment)
    if r:
        return r

    # 步骤 3：若有执行前缀剥离，对剥离后片段做语义检查
    if stripped and stripped != tokens:
        stripped_fragment = " ".join(stripped)
        r = _check_category_a(stripped_fragment, stripped)
        if r:
            return r
        r = _check_category_b(stripped, cwd)
        if r:
            return r
        r = _check_category_c(stripped, stripped_fragment)
        if r:
            return r

    # 步骤 4：对原始 tokens 做语义检查
    r = _check_category_a(fragment, tokens)
    if r:
        return r
    r = _check_category_b(tokens, cwd)
    if r:
        return r
    r = _check_category_c(tokens, fragment)
    if r:
        return r

    return None


# ── 公开接口 ───────────────────────────────────────────────────────────────────


def guard_decision(tool: str, command: str, cwd: str, env: Mapping[str, str]) -> Decision:
    """资金路径 PreToolUse 安全守卫。

    仅裁决 tool == "Bash"；其它工具一律放行。
    纯函数：零 IO、零网络、无副作用、确定性。

    Parameters
    ----------
    tool:    工具名称（仅 "Bash" 进入裁决流程）
    command: 待执行的 shell 命令字符串
    cwd:     当前工作目录（用于规范化相对路径）
    env:     当前环境变量（本期保留参数，未用于裁决）

    Returns
    -------
    Decision(allow=True, reason="")  — 放行
    Decision(allow=False, reason=…) — 拦截，reason 点名命中类别与片段
    """
    # 非 Bash 工具一律放行
    if tool != "Bash":
        return Decision(allow=True, reason="")

    # 拆分片段（$() 命令替换仍递归；进程替换在片段层面 BLOCK）
    fragments = _split_fragments(command)

    # 逐片段裁决
    for frag in fragments:
        reason = _judge_fragment(frag, cwd)
        if reason:
            return Decision(allow=False, reason=reason)

    return Decision(allow=True, reason="")
