import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Disposable human/LLM run narrative. `State.appendEvent` owns transitions required for
 * correctness, audit, replay, and dashboards; lane/role jsonl owns raw subprocess output.
 * Never mirror event payloads into this log.
 */
export interface EngineLogger {
  log(message: string): void;
}

export interface FileEngineLoggerOptions {
  path: string;
  teeToStderr: boolean;
  maxBytes: number;
  now?: () => Date;
  stderr?: (line: string) => void;
}

export class FileEngineLogger implements EngineLogger {
  private fd: number;
  private bytes: number;
  private fileEnabled = true;
  private failureReported = false;
  private readonly now: () => Date;
  private readonly stderr: (line: string) => void;

  constructor(private readonly options: FileEngineLoggerOptions) {
    this.now = options.now ?? (() => new Date());
    this.stderr = options.stderr ?? ((line) => process.stderr.write(line));
    try {
      mkdirSync(dirname(options.path), { recursive: true });
      this.fd = openSync(options.path, "a");
      this.bytes = fstatSync(this.fd).size;
    } catch (error) {
      throw new Error(`sapwood run: failed to open log file ${options.path}: ${String(error)}`);
    }
  }

  log(message: string): void {
    const timestamp = this.timestamp();
    for (const embeddedLine of message.split(/\r?\n/)) {
      const line = `[${timestamp}] ${embeddedLine}\n`;
      if (this.options.teeToStderr) this.writeStderr(line);
      if (this.fileEnabled) this.append(line);
    }
  }

  private timestamp(): string {
    try {
      return this.now().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  private writeStderr(line: string): void {
    try {
      this.stderr(line);
    } catch {
      /* log() is a non-throwing observability boundary */
    }
  }

  private append(line: string): void {
    try {
      const size = Buffer.byteLength(line);
      if (this.bytes + size > this.options.maxBytes) this.rotate();
      writeSync(this.fd, line);
      this.bytes += size;
    } catch (error) {
      this.fileEnabled = false;
      try {
        closeSync(this.fd);
      } catch {
        /* already unavailable */
      }
      if (!this.failureReported) {
        this.failureReported = true;
        this.writeStderr(`[${this.timestamp()}] [sapwood:logger] file logging disabled after write failure: ${String(error)}\n`);
      }
    }
  }

  private rotate(): void {
    closeSync(this.fd);
    rmSync(`${this.options.path}.1`, { force: true });
    renameSync(this.options.path, `${this.options.path}.1`);
    this.fd = openSync(this.options.path, "a");
    this.bytes = 0;
  }
}
