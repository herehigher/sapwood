import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// Bounded narrative is part of the partition rule: payload-scale data belongs in the
// structured ledger or lane/role jsonl, never in the disposable run log.
const MAX_MESSAGE_BYTES = 8 * 1024;

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
  now: () => Date;
  stderr?: (line: string) => void;
  write?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
}

export class FileEngineLogger implements EngineLogger {
  private fd: number;
  private bytes: number;
  private fileEnabled = true;
  private failureReported = false;
  private readonly now: () => Date;
  private readonly stderr: (line: string) => void;
  private readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;

  constructor(private readonly options: FileEngineLoggerOptions) {
    this.now = options.now;
    this.stderr = options.stderr ?? ((line) => process.stderr.write(line));
    this.write = options.write ?? ((fd, buffer, offset, length) => writeSync(fd, buffer, offset, length));
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
    const boundedMessage = this.boundMessage(message);
    const embeddedLines = boundedMessage.split(/\r?\n/);
    if (/\r?\n$/.test(boundedMessage) && embeddedLines.at(-1) === "") embeddedLines.pop();
    for (const embeddedLine of embeddedLines) {
      const line = `[${timestamp}] ${embeddedLine}\n`;
      if (this.options.teeToStderr) this.writeStderr(line);
      if (this.fileEnabled) this.append(line);
    }
  }

  private boundMessage(message: string): string {
    const source = Buffer.from(message);
    if (source.length <= MAX_MESSAGE_BYTES) return message;

    let marker = ` … [truncated ${source.length} bytes]`;
    while (true) {
      const prefix = this.utf8Prefix(source, MAX_MESSAGE_BYTES - Buffer.byteLength(marker));
      const dropped = source.length - Buffer.byteLength(prefix);
      const nextMarker = ` … [truncated ${dropped} bytes]`;
      if (nextMarker === marker) return prefix + marker;
      marker = nextMarker;
    }
  }

  private utf8Prefix(source: Buffer, maxBytes: number): string {
    let end = Math.max(0, maxBytes);
    while (end > 0) {
      const bytes = source.subarray(0, end);
      const text = bytes.toString("utf8");
      if (Buffer.from(text).equals(bytes)) return text;
      end--;
    }
    return "";
  }

  private timestamp(): string {
    try {
      return this.now().toISOString();
    } catch {
      // #403 (F25) per-site decision: DELIBERATE wall-clock read, kept. This is the last-resort
      // arm of an observability boundary that must not throw (see log()'s own non-throwing
      // contract) — reached only when the INJECTED clock itself throws, i.e. when there is no
      // other clock left to read. A seeded fixture never lands here; if one did, the seam is
      // broken and a real timestamp beats a lost log line.
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
      const buffer = Buffer.from(line);
      const size = buffer.length;
      if (this.bytes + size > this.options.maxBytes) this.rotate();
      let offset = 0;
      while (offset < size) {
        const written = this.write(this.fd, buffer, offset, size - offset);
        if (written === 0) throw new Error("log file write made no progress");
        offset += written;
      }
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
