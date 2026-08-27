// The release-gated Windows workflow packs the published surface first: using the installed .cmd shim here, rather than
// an engine source path, catches packaging and npm-global-install regressions in the same shape
// an end user gets.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { availableDashboardPort, runDashboardCanary } from "./dashboard-canary.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CMD = process.env.ComSpec ?? "cmd.exe";

// npm on Windows is a .cmd shim, and Node refuses to spawn .cmd files without a shell, so npm
// goes through cmd.exe the same way the installed sapwood.cmd does below. Every cmd.exe call
// passes its command line verbatim: the quoting is already cmd.exe-shaped, and Node's own
// Windows argument escaping would wrap the whole line into one unrecognised token.
function cmdExe(commandLine: string, options: SpawnSyncOptions): string {
  const result = spawnSync(CMD, ["/d", "/s", "/c", `"${commandLine}"`], {
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandLine} exited with ${result.status ?? `signal ${result.signal}`}`);
  return String(result.stdout ?? "");
}

function npm(args: string[], options: SpawnSyncOptions): string {
  return cmdExe(`npm ${args.map((arg) => `"${arg}"`).join(" ")}`, options);
}

interface PackManifest {
  filename?: string;
}

function packedTarball(packOutput: string, packDir: string): string {
  const manifestOffset = packOutput.lastIndexOf("\n[");
  if (manifestOffset === -1) throw new Error("npm pack --json did not emit a manifest array");
  const manifest = JSON.parse(packOutput.slice(manifestOffset + 1)) as PackManifest[];
  const filename = manifest[0]?.filename;
  if (filename === undefined) throw new Error("npm pack --json did not report a tarball filename");
  return join(packDir, filename);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sapwood-windows-pack-smoke-"));
  const packDir = join(root, "pack");
  const prefix = join(root, "prefix");
  const canaryDir = join(root, "canary");
  try {
    mkdirSync(packDir, { recursive: true });
    mkdirSync(canaryDir, { recursive: true });
    const packOutput = npm(["pack", "--json", "--workspace", "engine", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 180_000,
    });
    const tarball = packedTarball(packOutput, packDir);
    if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);
    npm(["install", "--global", "--prefix", prefix, tarball, "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      timeout: 120_000,
    });

    const bin = join(prefix, "sapwood.cmd");
    if (!existsSync(bin)) throw new Error(`npm global install did not create ${bin}`);
    cmdExe(`"${bin}" --version`, { cwd: canaryDir, stdio: "inherit", timeout: 15_000 });

    const port = await availableDashboardPort();
    const result = await runDashboardCanary({
      command: CMD,
      args: ["/d", "/s", "/c", `""${bin}" dashboard --port ${port}"`],
      cwd: canaryDir,
      timeoutMs: 30_000,
      windowsVerbatimArguments: true,
    });
    process.stdout.write(`windows dashboard pack smoke: OK ${result.origin}\n`);
  } finally {
    // Windows releases a reaped process's file handles a beat after its exit event.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
