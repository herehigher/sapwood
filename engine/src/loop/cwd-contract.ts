import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const CWD_CONTRACT_MESSAGE = "Run sapwood from the repository root.";

/** Commands whose state belongs to one repository-wide composition root. */
const ROOT_BOUND_COMMANDS = new Set(["dashboard", "estop", "events", "init", "park", "pause", "run", "status", "stop"]);

/** A value-bearing --config is the only path option that selects config-relative runtime files. */
function explicitConfigPath(argv: string[]): string | undefined {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--config") continue;
    const candidate = argv[i + 1];
    if (candidate === undefined || candidate.startsWith("-")) return undefined;
    configPath = candidate;
    i++;
  }
  return configPath;
}

/**
 * Refuse a state command outside a repository's canonical main-worktree root. Git's common
 * directory identifies that root even when the cwd contains a tracked config in a linked lane.
 * Non-git directories deliberately retain their exact-cwd behaviour.
 */
export function cwdContractError(argv: string[], cwd = process.cwd()): string | undefined {
  const command = argv[2];
  if (command === undefined || !ROOT_BOUND_COMMANDS.has(command) || argv.slice(3).includes("--help") || argv.slice(3).includes("-h")) {
    return undefined;
  }

  const gitEnv: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C" };
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith("GIT_")) delete gitEnv[key];
  }
  const gitOpts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  };
  const bare = spawnSync("git", ["-C", cwd, "rev-parse", "--is-bare-repository"], gitOpts);
  if (bare.status !== 0) {
    if (bare.status === 128 && /not a git repository/.test(bare.stderr)) return undefined;
    const reason = bare.error !== undefined || bare.status === null ? "git unavailable" : "git failed";
    return `sapwood ${command}: could not determine the repository root (${reason}). ${CWD_CONTRACT_MESSAGE}\n`;
  }
  if (bare.stdout.trim() === "true") {
    return `sapwood ${command}: could not determine the repository root (bare repository has no worktree). ${CWD_CONTRACT_MESSAGE}\n`;
  }
  if (bare.stdout.trim() !== "false") {
    return `sapwood ${command}: could not determine the repository root (git returned malformed output). ${CWD_CONTRACT_MESSAGE}\n`;
  }

  const git = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
    gitOpts,
  );
  if (git.status !== 0) {
    const reason = git.error !== undefined || git.status === null ? "git unavailable" : "git failed";
    return `sapwood ${command}: could not determine the repository root (${reason}). ${CWD_CONTRACT_MESSAGE}\n`;
  }
  const [gitDir, commonDir, worktreeRoot] = git.stdout.trim().split("\n");
  if (gitDir === undefined || commonDir === undefined || worktreeRoot === undefined) {
    return `sapwood ${command}: could not determine the repository root (git returned malformed output). ${CWD_CONTRACT_MESSAGE}\n`;
  }
  let mainRoot = realpathSync(worktreeRoot);
  if (gitDir !== commonDir) {
    const worktrees = spawnSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], gitOpts);
    const firstLine = worktrees.stdout.split("\n").find((line) => line.startsWith("worktree "));
    if (worktrees.status !== 0 || firstLine === undefined) {
      const reason = worktrees.error !== undefined || worktrees.status === null ? "git unavailable" : "git worktree query failed";
      return `sapwood ${command}: could not determine the repository root (${reason}). ${CWD_CONTRACT_MESSAGE}\n`;
    }
    mainRoot = realpathSync(firstLine.slice("worktree ".length));
  }
  const cwdRealpath = realpathSync(cwd);
  const configPath = explicitConfigPath(argv);
  const resolvedConfigPath = configPath === undefined ? undefined : resolve(cwd, configPath);
  const configLocation =
    resolvedConfigPath !== undefined && existsSync(resolvedConfigPath) ? realpathSync(resolvedConfigPath) : resolvedConfigPath;
  const configRelative = configLocation === undefined ? undefined : relative(mainRoot, configLocation);
  const configOutsideRoot =
    configRelative === ".." || configRelative?.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) === true;
  if (gitDir !== commonDir || cwdRealpath !== mainRoot || configOutsideRoot) {
    return `sapwood ${command}: ${CWD_CONTRACT_MESSAGE} ${mainRoot}\n`;
  }
  return undefined;
}
