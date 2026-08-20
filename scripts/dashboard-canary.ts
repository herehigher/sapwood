import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DashboardCanaryOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Captures the loopback origin from readiness output; defaults to the CLI's human-facing line. */
  readinessPattern?: RegExp;
  /** Defaults to null for an installed package; a contributor build names its checkout's HEAD. */
  expectedRepoHeadSha?: string | null;
}

export interface DashboardCanaryResult {
  origin: string;
  output: string;
}

export function availableDashboardPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a dashboard canary port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

/** Start a dashboard command, wait on its reported readiness line rather than elapsed time, probe
 * both the SPA and API, then reap the exact child process. */
export async function runDashboardCanary(opts: DashboardCanaryOptions): Promise<DashboardCanaryResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const readinessPattern = opts.readinessPattern ?? /serving at (http:\/\/127\.0\.0\.1:\d+)/;
  const expectedRepoHeadSha = opts.expectedRepoHeadSha ?? null;
  const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  try {
    const origin = await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`dashboard canary timed out waiting for readiness:\n${output}`)), timeoutMs);
      const check = () => {
        const match = readinessPattern.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolvePromise(match[1]);
        }
      };
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`dashboard canary exited before readiness (code ${code}):\n${output}`));
      });
      check();
    });

    const [page, state] = await Promise.all([
      fetch(`${origin}/`, { signal: AbortSignal.timeout(timeoutMs) }),
      fetch(`${origin}/api/loop/state`, { signal: AbortSignal.timeout(timeoutMs) }),
    ]);
    if (!page.ok) throw new Error(`dashboard canary GET / returned ${page.status}`);
    if (!state.ok) throw new Error(`dashboard canary GET /api/loop/state returned ${state.status}`);
    const body = (await state.json()) as { build?: { repoHeadSha?: unknown } };
    if (body.build?.repoHeadSha !== expectedRepoHeadSha)
      throw new Error(`dashboard canary found an unrelated build identity: ${String(body.build?.repoHeadSha)}`);
    return { origin, output };
  } finally {
    await waitForExit(child, timeoutMs);
  }
}

async function main(argv: string[]): Promise<void> {
  const version = argv[2];
  if (version === undefined) throw new Error("usage: dashboard-canary <published-version>");
  const cwd = mkdtempSync(join(tmpdir(), "sapwood-npx-canary-cwd-"));
  const cache = mkdtempSync(join(tmpdir(), "sapwood-npx-canary-"));
  try {
    const port = await availableDashboardPort();
    const result = await runDashboardCanary({
      command: "npx",
      args: ["--yes", `sapwood@${version}`, "dashboard", "--port", String(port)],
      cwd,
      env: { ...process.env, npm_config_cache: cache },
    });
    process.stdout.write(`dashboard canary: OK ${result.origin}\n`);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main(process.argv);
}
